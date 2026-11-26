import { GoogleGenAI, Modality, ThinkingLevel } from '@google/genai';
import { getConfig } from './config.js';
import { isQuotaError, isTransientError, withRetry } from './error-utils.js';
import { todayIstanbul } from './tool-mapper.js';
import { blockModel, isBlocked, clearBlocks, recordQuotaError, recordUsage } from './limit-registry.js';
import { logger } from './logger.js';
import { recordPapercut } from './papercuts.js';
import { isTranscriptTruncated, transcribeAudio, remainderAfter, BYTES_PER_SEC, dumpTurnAudio } from './transcript-repair.js';
let _ai = null;
export function getAI() {
    if (!_ai) {
        const config = getConfig();
        _ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    }
    return _ai;
}
export function resetAI() {
    _ai = null;
    _restSearchUnavailable = null;
}
// SEARCH-404-1: REST arama modeli bu key'de kalıcı olarak yoksa (yeni
// projelerde gemini-2.5-flash → 404 "no longer available to new users") her
// aramada önce boşuna REST denenmesin; süreç boyunca doğrudan Live'a gidilir.
let _restSearchUnavailable = null;
/** Model bu key için kalıcı olarak erişilemez mi (404 / NOT_FOUND)? */
export function isModelUnavailableError(message) {
    const m = message.toLowerCase();
    return m.includes('no longer available') || m.includes('not_found') ||
        /"code"\s*:\s*404/.test(m) || /\b404\b/.test(m) || m.includes('is not found for api version');
}
/** MIGR-38: 3.8-live (extended-thinking DEĞİL) — thinking_level 1007 verir, araçlar
 *  varsayılan async'tir (BLOCKING ile geri alınır). Ref: gemini-native-audio-system §14. */
export function isGemini38Live(model) {
    const m = model.toLowerCase();
    return m.includes('gemini-3.8-live') && !m.includes('extended-thinking');
}
/** liveapideneme runtime_config.is_gemini_3 ile aynı tespit */
export function isGemini3(model) {
    return model.toLowerCase().includes('gemini-3');
}
// ── Kota Fallback (LIVE-19 + LIMIT-REG-1) ────────────────────
// Serkan key limitleri (AI Studio tablosu, 2026-07-03): 3.1-flash-live TPM=65K,
// 2.5-native-audio TPM=1M. Birincil model 1011/quota alınca cooldown boyunca
// fallback'e geçilir; süre dolunca otomatik birincile dönülür. Reaktif tasarım.
// LIMIT-REG-1: blok state'i artık limit-registry'de (model başına); cooldown
// süresi hatanın retryDelay'inden öğrenilir (canlı kanıt: "42s"), yoksa
// QUOTA_COOLDOWN_MS. Dışa açık API (markModelDegraded/resolveActiveModel/
// resetQuotaState) geriye uyumlu korunur.
export function resetQuotaState() {
    clearBlocks();
}
/**
 * Bir modeli geçici "bozuk" işaretle → cooldown boyunca fallback'e geçilir.
 * İki tetikleyici (LIVE-19 + LIVE-23): (1) 1011/TPM kota hatası; (2) model
 * ısrarla boş/işe yaramaz turn dönüyor (3.1 preview empty-turn fırtınası,
 * 2026-06-13 kanıtı). Kota gibi empty-turn de o modelin o an o yükü
 * taşıyamadığının sinyali — aynı recovery. Model verilmezse birincil bloklanır.
 */
export function markModelDegraded(reason, now = Date.now(), model) {
    const config = getConfig();
    const target = model ?? config.geminiModel;
    blockModel(target, now + config.quotaCooldownMs);
    logger.warn(`Model bozuldu: ${target} (${reason}) — ${Math.round(config.quotaCooldownMs / 1000)}sn ` +
        `boyunca fallback tercih edilir: ${config.geminiFallbackModel}`);
}
/** Geriye uyumlu kısayol: kota (1011) tetikleyicisi. */
export function markQuotaExceeded(now = Date.now()) {
    markModelDegraded('TPM kotası 1011', now);
}
/** İsteği servis edecek modeli döner: birincil cooldown'ındaysa fallback. */
export function resolveActiveModel(now = Date.now()) {
    const config = getConfig();
    if (config.geminiFallbackModel === 'none' ||
        config.geminiFallbackModel === config.geminiModel) {
        return config.geminiModel;
    }
    if (isBlocked(config.geminiModel, now))
        return config.geminiFallbackModel;
    return config.geminiModel;
}
const RESPONSE_TIMEOUT = 120_000;
// ADR-0001: denetim için açık tutulan oturumun ömrü. Denetçi bütçesinden
// (reviewer.ts REVIEW_BUDGET_MS = 120sn) uzun olmalı, yoksa düzeltme turu
// kapanmış oturuma gider.
const HOLD_TIMEOUT = 180_000;
// Eski turun gecikmeli turnComplete'ini beklerken üst sınır.
const OLD_TURN_WAIT_MS = 5_000;
const TOOL_TIMEOUT = 180_000; // tool execution + Claude Code roundtrip
// functionCall id → session handle (paralel istekler birbirine karışmaz)
const _toolSessions = new Map();
/** Tool result'taki id'lerden birine sahip açık session'ı bul */
export function findToolSession(geminiIds) {
    for (const id of geminiIds) {
        const handle = _toolSessions.get(id);
        if (handle)
            return handle;
    }
    return null;
}
export function hasToolSession(geminiIds) {
    return findToolSession(geminiIds) !== null;
}
/**
 * TOOLSEL-1: araç devamı açık oturuma gidecekken o oturumun kurulumda
 * bildirdiği araçlar bu istekteki araçları kapsıyor mu? Kapsamıyorsa (ör.
 * ToolSearch yeni bir MCP aracı yükledi) oturum kapatılır ve false döner →
 * çağıran tam replay ile yeni araç listesiyle yeni oturum kurar.
 */
export function retireToolSessionIfToolsChanged(geminiIds, toolNames) {
    const handle = findToolSession(geminiIds);
    if (!handle)
        return false;
    const declared = new Set((handle.connectParams.tools ?? []).map((t) => t.name));
    const missing = toolNames.filter((n) => !declared.has(n));
    if (missing.length === 0)
        return false;
    logger.info(`Araç seti değişti (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` +${missing.length - 5}` : ''}) — oturum yeni listeyle yeniden kurulacak`);
    closeSession(handle);
    return true;
}
/** Test/teardown yardımcısı — tüm açık session'ları kapat */
export function closeAllSessions() {
    const handles = new Set(_toolSessions.values());
    for (const handle of handles) {
        clearTimeout(handle.timeoutId);
        try {
            handle.session.close();
        }
        catch { /* sessiz */ }
    }
    _toolSessions.clear();
}
function unregisterSession(handle) {
    for (const id of handle.toolIds)
        _toolSessions.delete(id);
    handle.toolIds.clear();
}
function closeSession(handle) {
    handle.closed = true;
    clearTimeout(handle.timeoutId);
    unregisterSession(handle);
    try {
        handle.session.close();
    }
    catch { /* sessiz */ }
}
// ── Connect Config ────────────────────────────────────────────
// Kaynak: ~/.claude/references/gemini-native-audio-system.md (manifesto v1.0)
// + liveapideneme/gemini_proxy.py (production'da kanıtlı).
export function buildConnectConfig(params, model) {
    const config = {
        // Native audio modeli sadece AUDIO modality destekler; text yanıt
        // outputAudioTranscription üzerinden alınır (manifesto §3.2-3.3).
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        // Audio göndermesek bile aktif — server tarafı tutarlılık (manifesto §3.4).
        inputAudioTranscription: {},
        // İlk bağlantıda boş {} = "resumption update'leri yolla" (manifesto §3.8).
        sessionResumption: {},
    };
    if (isGemini3(model)) {
        // Q111 (liveapideneme): Gemini 3.x'te realtimeInputConfig eklemek text
        // kickoff'u "speech end" gibi yorumlatıp EMPTY_TURN yaratıyor — ATLA.
        // 3.x'te thinking native: en düşük seviyeye sabitle.
        // MIGR-38: 3.8-live thinking_level'i REDDEDER (1007, oturum hiç açılmaz;
        // sınav 2026-11-26) — thinking orada interleaved ve kapatılamaz.
        if (isGemini38Live(model)) {
            // 3.8-live VAD ayarını kabul edip uygular (ölçüldü, §14.2); metin I/O'da kapalı.
            config['realtimeInputConfig'] = { automaticActivityDetection: { disabled: true } };
        }
        else {
            config['thinkingConfig'] = { thinkingLevel: ThinkingLevel.LOW };
        }
    }
    else {
        // Manifesto §3.5: text input + AUDIO modality'de VAD KAPALI olmak zorunda,
        // yoksa server boş turnComplete döner (ghosting).
        config['realtimeInputConfig'] = {
            automaticActivityDetection: { disabled: true },
        };
        // Reasoning dump'ın kökten çözümü: thinking'i kapat (liveapideneme
        // thinking_budget=0 pattern'i). server.ts'teki regex filtre sadece savunma.
        config['thinkingConfig'] = { thinkingBudget: 0 };
    }
    if (params.systemPrompt) {
        config['systemInstruction'] = { parts: [{ text: params.systemPrompt }] };
    }
    if (params.tools?.length) {
        // MIGR-38: 3.8-live'da araçlar varsayılan async — model sonucu beklemeden
        // "Let me check" deyip turu bitiriyordu (sınav: boş tur/filler). Köprü
        // Claude Code'un araç döngüsünü taklit ettiği için senkron (BLOCKING) şart.
        const decls = isGemini38Live(model)
            ? params.tools.map((d) => ({ ...d, behavior: 'BLOCKING' }))
            : params.tools;
        config['tools'] = [{ functionDeclarations: decls }];
    }
    return config;
}
// ── Bağlantı Kurulumu ─────────────────────────────────────────
// Hem ilk bağlantı hem proaktif reconnect (LIVE-7) bu helper'dan geçer.
// connectionGen guard'ı: reconnect sonrası ESKİ bağlantının onclose/onerror
// event'leri handle'ı bozamaz.
async function connectLive(handle, params, resumeHandle) {
    const config = getConfig();
    const ai = getAI();
    handle.connectionGen += 1;
    const gen = handle.connectionGen;
    const resumed = Boolean(resumeHandle);
    // LIVE-19: istek hangi modelle hazırlandıysa onunla bağlan (kota fallback)
    const model = params.model ?? config.geminiModel;
    const connectConfig = buildConnectConfig(params, model);
    if (resumeHandle) {
        // Manifesto §3.8: reconnect'te server'dan alınan handle ile bağlan —
        // konuşma context'i server tarafında geri yüklenir.
        connectConfig['sessionResumption'] = { handle: resumeHandle };
    }
    // RETRY-1 settle-guard: SDK connect()'i bazı transport hatalarında HİÇ
    // settle olmadan onerror/onclose tetikleyebilir (canlı kanıt: 2026-07-06
    // smoke T1 — "Gemini error:" sonrası istek 60sn asılı kaldı, withRetry hiç
    // devreye giremedi). Bu sarmalayıcı üç şeyi garanti eder: (1) pre-settle
    // onerror/onclose → REJECT (hata caller'da retry edilebilir hale gelir),
    // (2) connect başarısı → resolve, (3) reject'ten SONRA gelen session
    // kapatılır (sahipsiz WS sızıntısı yok).
    return new Promise((resolve, rejectConnect) => {
        let settled = false;
        const connecting = ai.live.connect({
            model,
            config: connectConfig,
            callbacks: {
                onopen: () => logger.debug(`Gemini connected (gen ${gen})`),
                onmessage: (msg) => handleServerMessage(msg, handle, params, resumed),
                onerror: (e) => {
                    if (gen !== handle.connectionGen)
                        return; // eski bağlantı — yoksay
                    if (!settled) {
                        settled = true;
                        rejectConnect(new Error(`Gemini error: ${e.message}`));
                        return;
                    }
                    closeSession(handle);
                    finishRequest(handle, new Error(`Gemini error: ${e.message}`));
                },
                onclose: (e) => {
                    if (gen !== handle.connectionGen)
                        return; // eski bağlantı — yoksay
                    // LIVE-19 + LIMIT-REG-1: kota kapanışı → HATAYI VEREN modeli blokla;
                    // süre hatanın retryDelay'inden (canlı kanıt: "42s"), yoksa cooldown.
                    // quotaValue/quotaId varsa kalıcı limit olarak öğrenilir.
                    // (pre/post-settle fark etmez — limit öğrenimi her durumda işlesin.)
                    const closeMsg = `${e.code} ${e.reason || ''}`;
                    if (isQuotaError(closeMsg)) {
                        const info = recordQuotaError(model, closeMsg, Date.now(), getConfig().quotaCooldownMs);
                        logger.warn(`Kota kapanışı: ${model} — ${Math.round((info.retryDelayMs ?? getConfig().quotaCooldownMs) / 1000)}sn bloklandı` +
                            (info.quotaValue !== undefined ? ` (öğrenilen limit: ${info.quotaId}=${info.quotaValue})` : ''));
                    }
                    if (!settled) {
                        settled = true;
                        rejectConnect(new Error(`Gemini closed: ${e.code} ${e.reason || ''}`.trim()));
                        return;
                    }
                    // Beklenen kapanışlarda requestDone zaten true — sessiz geç
                    unregisterSession(handle);
                    if (!handle.requestDone) {
                        clearTimeout(handle.timeoutId);
                        finishRequest(handle, new Error(`Gemini closed: ${e.code} ${e.reason || ''}`.trim()));
                    }
                },
            },
        });
        connecting.then((session) => {
            if (settled) {
                try {
                    session.close();
                }
                catch { /* sessiz */ }
                return;
            }
            settled = true;
            resolve(session);
        }, (err) => {
            if (!settled) {
                settled = true;
                rejectConnect(err instanceof Error ? err : new Error(String(err)));
            }
        });
    });
}
// ── Proaktif Reconnect (LIVE-7) ───────────────────────────────
// goAway geldiğinde (10dk session limiti yaklaşıyor) tool yanıtı bekleyen
// session'ı resumption handle ile yeni bağlantıya taşır. Başarısız olursa
// session kapanır → sonraki tool result full-replay fallback'ine düşer.
async function reconnectSession(handle) {
    const resume = handle.resumptionHandle;
    if (!resume)
        return;
    const oldSession = handle.session;
    try {
        // RETRY-1: transient WS/5xx hıçkırığı session'ı öldürmesin — jittered
        // backoff'la sınırlı retry. Bu yol server.ts withRetry kapsamında DEĞİL
        // (connectLive'ın initial-connect yolu oradan korunur; buraya genel retry
        // eklemek çift-retry olurdu). Kota hatası transient sayılmaz → tek
        // denemede pes edilir (LIVE-19 cooldown zaten modeli blokluyor).
        handle.session = await withRetry(() => connectLive(handle, handle.connectParams, resume), { transientOnly: true });
        try {
            oldSession.close();
        }
        catch { /* sessiz */ }
        logger.info('Gemini session resumed — proaktif reconnect tamam');
    }
    catch (err) {
        logger.error('Proactive reconnect failed — closing session', err instanceof Error ? err.message : String(err));
        closeSession(handle);
    }
}
// ── Ana Stream Fonksiyonu ─────────────────────────────────────
export async function streamFromGemini(params, callbacks) {
    let handle;
    const responsePromise = new Promise((resolve, reject) => {
        handle = {
            session: null, // connect() sonrası atanır
            callbacks,
            requestDone: false,
            responseResolved: false,
            awaitingTools: false,
            timeoutId: setTimeout(() => {
                logger.error('Gemini response timeout');
                closeSession(handle);
                finishRequest(handle, new Error('Gemini timeout'));
            }, RESPONSE_TIMEOUT),
            resolve,
            reject,
            toolIds: new Set(),
            connectionGen: 0,
            connectParams: params,
        };
    });
    // Erken-rejection guard: connect sürerken ws onerror tetiklenirse promise,
    // caller henüz subscribe olmadan reject olur → unhandledRejection → process
    // ÇÖKER (2026-06-11 canlı kanıt: WSL DNS EAI_AGAIN bridge'i exit 1 yaptı).
    // No-op catch branch'i bunu önler; caller'a giden rejection etkilenmez.
    responsePromise.catch(() => { });
    try {
        handle.session = await connectLive(handle, params);
    }
    catch (err) {
        clearTimeout(handle.timeoutId);
        finishRequest(handle, err);
    }
    return responsePromise;
}
/** TD-013: Live toolCall → web_search intercept ya da Claude Code'a yönlendirme. */
function onToolCallMessage(handle, functionCalls) {
    const calls = functionCalls
        .filter((fc) => {
        if (!fc.name) {
            logger.warn('Gemini returned an unnamed function call, skipping', { id: fc.id });
            return false;
        }
        return true;
    })
        .map((fc, idx) => ({
        name: fc.name,
        id: fc.id || `fc_${Date.now()}_${idx}`,
        args: fc.args || {},
    }));
    if (calls.length === 0)
        return;
    // LIVE-SEARCH-1: web_search çağrılarını köprü kendisi yerine getirir (REST
    // grounding) — Claude Code'a YÖNLENDİRİLMEZ. v1: yalnız SOLO web_search
    // batch'i intercept edilir. Karışık batch (web_search + normal tool) Live
    // native-audio modelinde nadirdir; v1'de normal akışa bırakılır (v2:
    // buffer-merge). Karışık durumda web_search Claude Code'a düşer (orada yok)
    // ama bu durum pratikte görülmediği için bilinçli kabul edilen sınırdır.
    const webSearchCalls = calls.filter((c) => c.name === 'web_search');
    if (webSearchCalls.length === calls.length) {
        // HTTP/SSE AÇIK kalır (finishRequest YOK) → model devamı mevcut isteğe
        // akıtır; Claude Code web_search'i HİÇ görmez (onToolCall YOK).
        handle.awaitingTools = true;
        clearTimeout(handle.timeoutId);
        handle.timeoutId = setTimeout(() => {
            logger.error('web_search timeout — closing session');
            closeSession(handle);
            finishRequest(handle, new Error('web_search timeout'));
        }, RESPONSE_TIMEOUT);
        void fulfillWebSearch(webSearchCalls, handle);
        return;
    }
    if (webSearchCalls.length > 0) {
        logger.warn(`web_search karışık batch'te (${calls.length - webSearchCalls.length} normal tool ile) — ` +
            'v1: intercept edilmedi, normal akışa bırakıldı');
    }
    clearTimeout(handle.timeoutId);
    handle.timeoutId = setTimeout(() => {
        logger.error('Tool response timeout — closing session');
        recordPapercut('tool_timeout', { tools: calls.map((c) => c.name).join(',') });
        closeSession(handle);
    }, TOOL_TIMEOUT);
    handle.awaitingTools = true;
    handle.turnAudioBytes = 0;
    handle.turnTranscriptChars = 0;
    handle.turnAudio = [];
    handle.turnTranscript = '';
    for (const c of calls) {
        handle.toolIds.add(c.id);
        _toolSessions.set(c.id, handle);
    }
    handle.callbacks.onToolCall(calls);
    // HTTP isteğini kapat, WebSocket AÇIK kalır
    finishRequest(handle);
    return;
}
/** TD-013: generationComplete/turnComplete — tur sonu ölçümü, kesik döküm onarımı, tamamlama. */
function onResponseReady(handle, readyHadTurnComplete) {
    handle.responseResolved = true;
    // TRANSCRIPT-1: 24kHz 16-bit mono PCM → 48000 B/sn. Konuşma ~10-12 kr/sn;
    // belirgin düşük oran dökümün eksik geldiğini gösterir.
    const audioBytes = handle.turnAudioBytes ?? 0;
    const chars = handle.turnTranscriptChars ?? 0;
    const audio = handle.turnAudio ?? [];
    const emitted = handle.turnTranscript ?? '';
    if (audioBytes > 0) {
        const sec = audioBytes / BYTES_PER_SEC;
        logger.debug(`Tur sonu: ses=${sec.toFixed(1)}sn döküm=${chars}kr (${(chars / sec).toFixed(1)} kr/sn)`);
    }
    handle.turnAudioBytes = 0;
    handle.turnTranscriptChars = 0;
    handle.turnAudio = [];
    handle.turnTranscript = '';
    if (isTranscriptTruncated(audioBytes, chars) && getConfig().transcriptRepairModels.length > 0) {
        logger.warn(`Döküm kesik görünüyor (ses=${(audioBytes / BYTES_PER_SEC).toFixed(1)}sn, döküm=${chars}kr) — ses yeniden yazıya dökülüyor`);
        handle.repairing = true;
        handle.repairSawTurnComplete = false;
        const pcm = Buffer.concat(audio.map((b) => Buffer.from(b, 'base64')));
        if (getConfig().debug)
            dumpTurnAudio(pcm, emitted);
        void transcribeAudio(pcm, emitted).then((full) => {
            handle.repairing = false;
            if (handle.closed || handle.requestDone)
                return;
            if (full) {
                const rest = remainderAfter(emitted, full);
                if (rest.trim())
                    handle.callbacks.onText(rest);
            }
            completeTurn(handle, readyHadTurnComplete || !!handle.repairSawTurnComplete);
        });
        return;
    }
    completeTurn(handle, readyHadTurnComplete);
}
function handleServerMessage(msg, handle, params, resumed) {
    if (getConfig().debug) {
        const sc = msg.serverContent;
        logger.debug('Gemini msg', {
            keys: Object.keys(msg),
            transcription: sc?.outputTranscription?.text?.slice(0, 60),
            genComplete: sc?.generationComplete,
            turnComplete: sc?.turnComplete,
            modelTurnParts: sc?.modelTurn?.parts?.map((p) => Object.keys(p).join(',')),
        });
    }
    if (handle.repairing && msg.serverContent?.turnComplete)
        handle.repairSawTurnComplete = true;
    // ADR-0001: tutulan oturumda eski turun gecikmeli turnComplete'i — yut.
    if (handle.oldTurnPending && handle.requestDone && msg.serverContent?.turnComplete) {
        handle.oldTurnPending = false;
        handle.oldTurnWaiter?.();
        return;
    }
    // ADR-0001: düzeltme turunda yeni içerik gelmeden düşen turnComplete bayattır.
    if (handle.swallowStaleTurnComplete) {
        if (msg.serverContent?.outputTranscription?.text || msg.toolCall) {
            handle.swallowStaleTurnComplete = false;
        }
        else if (msg.serverContent?.turnComplete || msg.serverContent?.generationComplete) {
            handle.swallowStaleTurnComplete = false;
            logger.debug('Bayat turnComplete yutuldu (düzeltme turu)');
            return;
        }
    }
    // Setup tamam → text turn'leri gönder. Manifesto akışı: setup →
    // setupComplete → client_content. (Eski silent-audio + 100ms hack'i
    // VAD disabled sayesinde gereksiz — kaldırıldı.)
    // Resumed bağlantıda turns GÖNDERİLMEZ — context server'da geri yüklendi.
    if (msg.setupComplete) {
        if (resumed) {
            logger.info('Gemini session ready (resumed) — turns not re-sent');
            return;
        }
        logger.debug('Gemini session ready');
        try {
            handle.session.sendClientContent({
                turns: params.turns,
                turnComplete: true,
            });
        }
        catch (err) {
            closeSession(handle);
            finishRequest(handle, err);
        }
        return;
    }
    // Resumption handle'ı sakla (10dk session limiti / reconnect için)
    if (msg.sessionResumptionUpdate?.newHandle) {
        handle.resumptionHandle = msg.sessionResumptionUpdate.newHandle;
        return;
    }
    // Server kapanış uyarısı (10dk limit) → tool yanıtı bekleyen idle session'ı
    // resumption handle ile yeni bağlantıya taşı (LIVE-7). Aktif üretim sırasında
    // taşıma yapılmaz — turn genelde timeLeft içinde biter, kesmek riskli.
    if (msg.goAway) {
        const left = msg.goAway.timeLeft ?? '?';
        if (handle.awaitingTools && handle.resumptionHandle) {
            logger.warn(`Gemini goAway (timeLeft=${left}) — starting proactive reconnect`);
            void reconnectSession(handle);
        }
        else {
            logger.warn(`Gemini goAway (timeLeft=${left}) — aktif turn bitene kadar bekleniyor`);
        }
        return;
    }
    // Tool call → session'ı AÇIK tut, id'leri registry'ye yaz
    // TD-013: araç çağrısı ayrı fonksiyonda (her dalı return eder — davranış aynı).
    if (msg.toolCall?.functionCalls) {
        onToolCallMessage(handle, msg.toolCall.functionCalls);
        return;
    }
    if (msg.serverContent?.outputTranscription?.text) {
        handle.turnTranscriptChars = (handle.turnTranscriptChars ?? 0) + msg.serverContent.outputTranscription.text.length;
        handle.turnTranscript = (handle.turnTranscript ?? '') + msg.serverContent.outputTranscription.text;
        handle.callbacks.onText(msg.serverContent.outputTranscription.text);
    }
    for (const p of msg.serverContent?.modelTurn?.parts ?? []) {
        const data = p.inlineData?.data;
        if (data) {
            handle.turnAudioBytes = (handle.turnAudioBytes ?? 0) + Math.floor((data.length * 3) / 4);
            (handle.turnAudio ??= []).push(data);
        }
    }
    // Manifesto §6.2: generationComplete ve turnComplete İKİ AYRI mesaj olarak
    // gelir (1-2sn arayla). İlk gelen sinyalde yanıt hazırdır — generationComplete
    // ile resolve etmek her turn'de 1.5-2sn kazandırır. İkinci sinyal no-op.
    // (Gemini 3.x bazen turnComplete hiç atmaz — liveapideneme kanıtı.)
    const responseReady = msg.serverContent?.generationComplete || msg.serverContent?.turnComplete;
    if (responseReady && !handle.responseResolved && !handle.awaitingTools) {
        onResponseReady(handle, !!msg.serverContent?.turnComplete);
    }
}
/** Yanıt hazır: Claude Code'a turu bitir; denetim için tut ya da oturumu kapat. */
function completeTurn(handle, turnCompleteSeen) {
    handle.callbacks.onTurnComplete();
    if (handle.onHeld && (handle.reviewRounds ?? 0) < 1) {
        // ADR-0001: oturumu açık tut; denetçi düzeltme isterse aynı oturuma döner.
        const onHeld = handle.onHeld;
        handle.onHeld = undefined;
        handle.oldTurnPending = !turnCompleteSeen;
        finishRequest(handle);
        clearTimeout(handle.timeoutId);
        handle.timeoutId = setTimeout(() => {
            logger.warn('Denetim için tutulan oturum süresi doldu — kapatılıyor');
            closeSession(handle);
        }, HOLD_TIMEOUT);
        onHeld(makeHeldSession(handle));
        return;
    }
    closeSession(handle);
    finishRequest(handle);
}
function makeHeldSession(handle) {
    return {
        release: () => closeSession(handle),
        followUp: async (text, callbacks) => {
            handle.reviewRounds = (handle.reviewRounds ?? 0) + 1;
            if (handle.closed)
                throw new Error('held session already closed');
            // generationComplete ile çözülen turun turnComplete'i gecikmeli gelir;
            // yeni tur o gelmeden gönderilirse eski turnComplete yeni turu yarıda
            // keser. Gemini 3.x turnComplete'i bazen HİÇ göndermez (canlı: W2 taslağı
            // yalnız dosya adıydı, düzeltme atlandığı için bozuk cevap gitti). Bu
            // yüzden beklenir; gelmezse yine gönderilir ve yeni içerik gelmeden
            // düşen ilk turnComplete bayat sayılıp yutulur.
            if (handle.oldTurnPending) {
                const arrived = await new Promise((resolve) => {
                    const t = setTimeout(() => resolve(false), OLD_TURN_WAIT_MS);
                    handle.oldTurnWaiter = () => { clearTimeout(t); resolve(true); };
                });
                handle.oldTurnWaiter = undefined;
                handle.oldTurnPending = false;
                handle.swallowStaleTurnComplete = !arrived;
            }
            if (handle.closed)
                throw new Error('held session already closed');
            return new Promise((resolve, reject) => {
                handle.callbacks = callbacks;
                handle.requestDone = false;
                handle.responseResolved = false;
                handle.awaitingTools = false;
                handle.resolve = resolve;
                handle.reject = reject;
                clearTimeout(handle.timeoutId);
                handle.timeoutId = setTimeout(() => {
                    logger.error('Gemini response timeout (review follow-up)');
                    closeSession(handle);
                    finishRequest(handle, new Error('Gemini timeout'));
                }, RESPONSE_TIMEOUT);
                recordUsage(handle.connectParams.model ?? getConfig().geminiModel, Math.ceil(text.length / 3.5));
                try {
                    handle.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
                }
                catch (err) {
                    closeSession(handle);
                    finishRequest(handle, err);
                }
            });
        },
    };
}
/** Aktif HTTP isteğinin promise'ini sonuçlandır (session'a dokunmaz) */
function finishRequest(handle, err) {
    if (handle.requestDone)
        return;
    handle.requestDone = true;
    if (!handle.awaitingTools)
        clearTimeout(handle.timeoutId);
    if (err) {
        handle.callbacks.onError(err);
        handle.reject(err);
    }
    else {
        handle.resolve();
    }
}
// ── Tool Response — Persistent Session'a Gönder ───────────────
// Tool call sonrası AYNI WebSocket session'ına toolResponse gönderir.
// Yeni session açılmaz → tam history yeniden gönderilmez → 1007 olmaz.
export async function sendToolResponse(toolResponses, callbacks, opts) {
    const handle = findToolSession(toolResponses.map((tr) => tr.id));
    if (!handle) {
        throw new Error('No active Gemini session for tool response');
    }
    // Yeni HTTP isteğinin callback'lerini ve promise'ini handle'a bağla
    return new Promise((resolve, reject) => {
        handle.callbacks = callbacks;
        handle.requestDone = false;
        handle.responseResolved = false;
        handle.awaitingTools = false;
        handle.resolve = resolve;
        handle.reject = reject;
        handle.onHeld = opts?.onHeld;
        // Cevaplanan tool id'lerini registry'den düş (yeni toolCall gelirse
        // yenileri kaydedilir)
        for (const tr of toolResponses) {
            handle.toolIds.delete(tr.id);
            _toolSessions.delete(tr.id);
        }
        clearTimeout(handle.timeoutId);
        handle.timeoutId = setTimeout(() => {
            logger.error('Gemini response timeout (tool continuation)');
            closeSession(handle);
            finishRequest(handle, new Error('Gemini timeout'));
        }, RESPONSE_TIMEOUT);
        logger.info(`Sending ${toolResponses.length} tool responses to persistent session`);
        // LIMIT-REG-1: tool-result devamı da gerçek token harcar (≤32KB/sonuç) —
        // session'ın modeline işle (char/3.5 kaba tahmin, registry toleranslı).
        recordUsage(handle.connectParams.model ?? getConfig().geminiModel, Math.ceil(JSON.stringify(toolResponses).length / 3.5));
        try {
            handle.session.sendToolResponse({
                functionResponses: toolResponses.map((tr) => ({
                    id: tr.id,
                    name: tr.name,
                    response: tr.response,
                    ...(tr.parts ? { parts: tr.parts } : {}),
                })),
            });
            // Anti-filler nudge — SADECE 2.5 native-audio için: o model tool
            // sonucuna sıkça "Let me check" deyip turn'ü bitiriyor (2026-06-11
            // canlı kanıt, system talimatı engellemedi); bu minik turn üretimi
            // asıl cevaba tetikler. Gemini 3.x'te GÖNDERME: 3.1'de toolResponse
            // sonrası clientContent, başlamış üretimi İPTAL edip boş turnComplete
            // bıraktı (13:57 canlı kanıt) — 3.x'te filler sorunu da zaten yok.
            if (!isGemini3(handle.connectParams.model ?? getConfig().geminiModel)) {
                handle.session.sendClientContent({
                    turns: [{
                            role: 'user',
                            parts: [{
                                    text: 'Use the tool result above and continue the task NOW: ' +
                                        'either produce the final substantive answer or call the next needed tool. No filler.',
                                }],
                        }],
                    turnComplete: true,
                });
            }
        }
        catch (err) {
            closeSession(handle);
            finishRequest(handle, err);
        }
    });
}
// ── web_search Fulfillment (LIVE-SEARCH-1) ────────────────────
// SOLO web_search batch geldiğinde her çağrıyı handleWebSearch ile karşıla
// (REST grounding), sonuçları AYNI Live session'a tool response olarak gönder.
// HTTP isteği AÇIK kaldığı için model devamı mevcut SSE'ye akıtır → Claude Code
// normal bir metin yanıtı görür. exported değil — yalnız intercept path kullanır.
async function fulfillWebSearch(calls, handle) {
    const functionResponses = [];
    for (const c of calls) {
        const response = await handleWebSearch(c.args);
        functionResponses.push({ id: c.id, name: c.name, response });
    }
    // Arama bitti → model devam edebilsin: awaitingTools düş, response timeout'a geç.
    handle.awaitingTools = false;
    handle.responseResolved = false;
    clearTimeout(handle.timeoutId);
    handle.timeoutId = setTimeout(() => {
        logger.error('Gemini response timeout (web_search continuation)');
        closeSession(handle);
        finishRequest(handle, new Error('Gemini timeout'));
    }, RESPONSE_TIMEOUT);
    try {
        handle.session.sendToolResponse({ functionResponses });
    }
    catch (err) {
        closeSession(handle);
        finishRequest(handle, err);
    }
}
// ── web_search → Gemini REST Grounding (LIVE-SEARCH-1) ────────
// Live API aynı session'da googleSearch + functionDeclarations'ı KABUL ETMEZ
// (Google kısıtı), bu yüzden arama out-of-band bir REST generateContent isteğiyle
// yapılır (düz model, config.geminiSearchModel). ASLA throw ETMEZ: hata da {error}
// payload'ı olarak modele döner (R5) — model zarif şekilde toparlar. Kota benzeri
// hatada markModelDegraded ÇAĞRILMAZ (ana Live modelini etkilememeli).
const WEB_SEARCH_TIMEOUT = 20_000;
// SEARCH-LIVE-1: Live-grounded arama ölçülen 4-15sn sürüyor — pay bırak.
const LIVE_SEARCH_TIMEOUT = 30_000;
// SEARCH-LAT-1: bu sürede bitmeyen aramaya paralel ikinci deneme (hedge).
const LIVE_SEARCH_HEDGE_MS = 12_000;
/**
 * SEARCH-LAT-1: 2.5-native-audio cevabı KONUŞARAK üretir; metin (transkripsiyon)
 * konuşma hızında gelir → süre ≈ cevap uzunluğu. Canlı ölçüm (2026-11-25):
 * serbest cevap 100-190 kr / 9,8-16sn; tarih + tek cümle 49-101 kr / 5,7-11sn.
 * Tarih olmadan model eski yılı arayıp çelişen sonuç veriyordu.
 */
export function buildSearchInstruction(today) {
    return ('You are a web search tool answering another AI, not a person. ' +
        `Today is ${today} (Europe/Istanbul). Search the web, then reply in ONE short sentence ` +
        '(max 25 words) with only the key facts: names, dates, numbers. No greetings, no caveats, no filler.');
}
// ── SEARCH-LIVE-1: tek-turluk googleSearch-only Live araması ─────
// REST grounding'in free-tier havuzu 20 arama/gün (canlı ölçüm 2026-07-06);
// 2.5-audio Live'ın grounding havuzu AYRI ve fiilen sınırsız (canlı ölçüm
// 2026-07-07: aynı gün 21 arama duvarsız, RPM duvarı yok, tek sınır TPM=1M).
// Session googleSearch-ONLY kurulur — functionDeclarations'la birlikte kabul
// edilmez (Google kısıtı, LIVE-SEARCH-1'in varlık sebebi). Ana persistent
// session'a DOKUNMAZ; hata/timeout'ta reject eder (caller {error}'a çevirir).
function liveGroundedSearch(query, model, signal) {
    const ai = getAI();
    return new Promise((resolve, reject) => {
        let text = '';
        const sources = [];
        let session = null;
        let done = false;
        const finish = (err) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            try {
                session?.close();
            }
            catch { /* sessiz */ }
            if (err)
                reject(err);
            else
                resolve({ result: text.trim(), sources });
        };
        const timer = setTimeout(() => finish(new Error(`live web_search timed out after ${LIVE_SEARCH_TIMEOUT}ms`)), LIVE_SEARCH_TIMEOUT);
        signal?.addEventListener('abort', () => finish(new Error('live web_search aborted (hedge lost)')), { once: true });
        // Aile-uyumlu Live setup'ı (AUDIO + transkripsiyon + VAD/thinking) tek
        // merkezden; tools googleSearch-ONLY ile değiştirilir.
        const config = buildConnectConfig({ turns: [], systemPrompt: buildSearchInstruction(todayIstanbul()) }, model);
        config['tools'] = [{ googleSearch: {} }];
        ai.live.connect({
            model,
            config,
            callbacks: {
                onopen: () => logger.debug('live web_search connected'),
                onmessage: (msg) => {
                    if (msg.setupComplete) {
                        try {
                            session.sendClientContent({
                                turns: [{ role: 'user', parts: [{ text: query }] }],
                                turnComplete: true,
                            });
                        }
                        catch (e) {
                            finish(e);
                        }
                        return;
                    }
                    const sc = msg.serverContent;
                    if (!sc)
                        return;
                    const tr = sc['outputTranscription']?.text;
                    if (tr)
                        text += tr;
                    // groundingMetadata serverContent altında veya modelTurn içinde gelebilir
                    const gm = (sc['groundingMetadata']
                        ?? sc['modelTurn']?.['groundingMetadata']);
                    for (const ch of gm?.groundingChunks ?? []) {
                        if (ch.web?.uri)
                            sources.push({ title: ch.web.title ?? '', uri: ch.web.uri });
                    }
                    if (sc['turnComplete'])
                        finish();
                },
                onerror: (e) => finish(new Error(`live search error: ${e.message}`)),
                onclose: (e) => finish(new Error(`live search closed: ${e.code} ${e.reason ?? ''}`.trim())),
            },
        }).then((s) => { session = s; }, (e) => finish(e instanceof Error ? e : new Error(String(e))));
    });
}
/**
 * SEARCH-LAT-1: ilk deneme LIVE_SEARCH_HEDGE_MS içinde bitmezse paralel ikinci
 * deneme başlar; ilk başarılı kazanır, kaybeden kapatılır. İkisi de başarısızsa
 * ilk denemenin hatası döner. Live arama havuzu istek/gün sınırsız.
 */
export async function hedgedLiveSearch(query, model, hedgeMs = LIVE_SEARCH_HEDGE_MS, search = liveGroundedSearch) {
    const controllers = [];
    const attempt = () => {
        const c = new AbortController();
        controllers.push(c);
        return search(query, model, c.signal);
    };
    return new Promise((resolve, reject) => {
        let settled = false;
        let failures = 0;
        let firstErr = null;
        let started = 0;
        let hedgeTimer;
        const done = (fn) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(hedgeTimer);
            for (const c of controllers)
                c.abort();
            fn();
        };
        const run = () => {
            started += 1;
            attempt().then((r) => done(() => resolve(r)), (e) => {
                failures += 1;
                firstErr ??= e;
                // Hedge henüz başlamadıysa hemen başlat (erken hata = boşa bekleme yok).
                if (started === 1) {
                    clearTimeout(hedgeTimer);
                    run();
                    return;
                }
                if (failures >= started)
                    done(() => reject(firstErr));
            });
        };
        run();
        hedgeTimer = setTimeout(() => {
            if (settled || started > 1)
                return;
            logger.info(`web_search (live) ${hedgeMs}ms'de bitmedi — paralel ikinci deneme`);
            run();
        }, hedgeMs);
    });
}
export async function handleWebSearch(args) {
    const query = String(args['query'] ?? '').trim();
    if (!query)
        return { error: 'web_search called without a query' };
    const config = getConfig();
    const ai = getAI();
    // Timer handle'ı tut: generateContent yarışı kazanırsa setTimeout aksi halde
    // WEB_SEARCH_TIMEOUT boyunca event-loop'ta asılı kalıp temiz kapanışı geciktirir (TD-009).
    let timeoutId;
    try {
        if (_restSearchUnavailable)
            throw new Error(_restSearchUnavailable);
        const resp = await Promise.race([
            ai.models.generateContent({
                model: config.geminiSearchModel,
                contents: query,
                config: { tools: [{ googleSearch: {} }] },
            }),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`web_search timed out after ${WEB_SEARCH_TIMEOUT}ms`)), WEB_SEARCH_TIMEOUT);
            }),
        ]);
        const text = resp.text ?? '';
        const chunks = resp.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        const sources = chunks
            .map((ch) => ch.web)
            .filter((w) => !!w && !!w.uri)
            .map((w) => ({ title: w.title ?? '', uri: w.uri ?? '' }));
        if (!text && sources.length === 0) {
            return { error: 'web_search returned no results' };
        }
        logger.info(`web_search: "${query.slice(0, 60)}" → ${sources.length} source(s)`);
        return { result: text, sources };
    }
    catch (err) {
        const msg = err.message;
        // SEARCH-LIVE-1: REST kotası (20/gün) veya transient hata → 2.5-audio
        // Live-grounded fallback (havuzu ayrı, fiilen sınırsız; bedel +5-10sn).
        // REST timeout'u BİLEREK fallback tetiklemez (20sn beklendi — toplam
        // gecikmeyi katlamamak için). Kalıcı hatalar (400 vb.) da tetiklemez.
        // SEARCH-404-1: model bu key'de yoksa (yeni projeler) de Live'a düş ve
        // bunu hatırla — sonraki aramalar REST'i hiç denemez.
        const liveModel = config.geminiSearchLiveModel;
        const unavailable = isModelUnavailableError(msg);
        if (unavailable && !_restSearchUnavailable) {
            _restSearchUnavailable = `REST search model ${config.geminiSearchModel} unavailable for this key: ${msg.slice(0, 120)}`;
            logger.warn(`web_search: ${config.geminiSearchModel} bu key'de erişilemez (404) — bu oturumda aramalar doğrudan Live'a gidecek`);
        }
        if (liveModel !== 'none' && (isQuotaError(msg) || isTransientError(msg) || unavailable)) {
            if (!_restSearchUnavailable || !msg.startsWith('REST search model')) {
                logger.info(`web_search REST failed (${msg.slice(0, 80)}) → Live fallback: ${liveModel}`);
            }
            try {
                const live = await hedgedLiveSearch(query, liveModel);
                if (!live.result && live.sources.length === 0) {
                    return { error: 'web_search returned no results (live fallback)' };
                }
                logger.info(`web_search (live): "${query.slice(0, 60)}" → ${live.sources.length} source(s)`);
                return { result: live.result, sources: live.sources };
            }
            catch (liveErr) {
                const liveMsg = liveErr.message;
                logger.warn(`web_search live fallback failed: ${liveMsg}`);
                return { error: `web_search failed: ${msg}; live fallback: ${liveMsg}` };
            }
        }
        logger.warn(`web_search failed: ${msg}`);
        return { error: `web_search failed: ${msg}` };
    }
    finally {
        if (timeoutId)
            clearTimeout(timeoutId);
    }
}
