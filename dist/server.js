import Fastify from 'fastify';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getConfig } from './config.js';
import { createServer as createNetServer } from 'net';
import { logger } from './logger.js';
import { REQUESTS_DIR } from './paths.js';
import { buildSystemPrompt, toGeminiTurns, flattenTurnsToSingleUser, scrubFlattenMarkers, LIVE_TOOL_RESULT_MAX_CHARS, TURNS_BYTE_BUDGET } from './transformer.js';
import { streamFromGemini, sendToolResponse, hasToolSession, retireToolSessionIfToolsChanged, isGemini3, resolveActiveModel, markModelDegraded } from './gemini-client.js';
import { runReview, buildFeedback, reviewStateless, rewriteFromEvidence } from './reviewer.js';
import { toGeminiFunctionDeclarations, toAnthropicToolUse, toGeminiToolId, detectToolResults, parseTextToolCall, findToolName, toolResultText, } from './tool-mapper.js';
import { generateMessageId } from './stream-converter.js';
import { tableToImages } from './table-image.js';
import { SSEWriter } from './sse-writer.js';
import { trimMessages, estimateMessageTokens, estimateTokens, estimateOutputTokens, reportedInputTokens } from './context-manager.js';
import { sanitizeErrorForClient, mapErrorToAnthropicStatus, withRetry } from './error-utils.js';
import { recordPapercut, recordToolErrors } from './papercuts.js';
import { getDiscoveryStatus } from './model-discovery.js';
import { recordUsage, getRegistrySnapshot } from './limit-registry.js';
import { decideRoute, resolveLaneModel } from './router.js';
import { runRestTurn, RestLaneUnavailable } from './rest-lane.js';
// ── Bridge System Instruction ────────────────────────────────
// Gemini Native Audio modeli, audio transcription'ında iç düşünce sürecini
// de metin olarak döndürür ("**Analyzing**\n\nI'm processing...").
// Bu talimat, modelin direkt cevap vermesini sağlar.
// NOT (2026-06-11): Buraya agresif "NEVER reply with filler ..." cümlesi
// eklemek DENENDİ ve GERİ ALINDI — filler'ı düzeltmedi, üstüne T3 smoke'ta
// empty-turn oranını artırdı (yasak yüklü system → model susuyor). Filler
// mücadelesi sendToolResponse sonrası nudge ile yapılıyor (gemini-client).
// LIVE-SEARCH-1: web_search yönlendirme cümlesi POZİTİF/imperatif tutuldu —
// yasaklayıcı dil (ör. "NEVER ...") empty-turn regresyonu yapıyor (yukarıdaki
// 2026-06-11 notu), oysa "şunu yap" tarzı talimat güvenli.
const BRIDGE_SYSTEM_INSTRUCTION = `CRITICAL: Do NOT prefix your response with internal reasoning wrapped in **bold headers** followed by a monologue about what you are going to do (e.g. "**Calculating the Answer**\\nI've processed the query..."). Start directly with the actual response content. When using tools/functions, call them immediately without explaining your reasoning first. For current events, news, or real-time information, call the web_search function instead of answering from memory.`;
// ── Empty-Turn Nudge ─────────────────────────────────────────
// Ağır/karışık bağlamda native-audio model OLASILIKSAL olarak boş turn döner
// (2026-06-11 probe-empty kanıtı: birebir aynı gövde bazen cevap, bazen boş).
// Aynı bağlamı aynen tekrar göndermek aynı sessizliğe düşer — retry'da sona
// açık bir yönerge turn'ü ekleyerek dağılımı cevaba çeviriyoruz.
const EMPTY_TURN_NUDGE_TEXT = 'Yukarıdaki son soruya/göreve ŞİMDİ doğrudan cevap ver. ' +
    '(Answer the last question above directly now.)';
function turnsForAttempt(turns, attempt, model) {
    const withNudge = attempt === 0
        ? turns
        : [...turns, { role: 'user', parts: [{ text: EMPTY_TURN_NUDGE_TEXT }] }];
    // Gemini 3.x: clientContent'te 'model' turn'leri 1007 veriyor (D2 probe) —
    // replay tek user-turn transkripte düzleştirilir. Nudge'dan SONRA uygulanır
    // ki nudge da transkriptin son satırı olarak girsin. Model parametresi
    // attempt başına çözülür (LIVE-19): kota fallback'inde 2.5'e düşülür,
    // 2.5'te flatten gerekmez ama zararsız da olur — koşul yine de net kalsın.
    return isGemini3(model)
        ? flattenTurnsToSingleUser(withNudge)
        : withNudge;
}
// ── Thinking Text Filter ─────────────────────────────────────
// Savunma katmanı: System prompt'a rağmen model hâlâ düşünce metni gönderirse filtrele.
// Dar pattern: Sadece bilinen "thinking" fiil kalıplarıyla başlayan bold başlıkları eşle.
// Genel bold başlıkları (ör. **Summary**, **Error Found**) EŞLEŞTİRME — false positive önleme.
const THINKING_VERBS = [
    'Calculating', 'Processing', 'Analyzing', 'Initiating', 'Answering',
    'Crafting', 'Thinking', 'Handling', 'Preparing', 'Considering',
    'Evaluating', 'Formulating', 'Generating', 'Determining', 'Examining',
    'Defining', 'Enumerating', 'Refining', 'Reviewing', 'Planning',
    'Summarizing', 'Interpreting', 'Composing', 'Resolving', 'Identifying',
    'Assessing', 'Structuring', 'Organizing', 'Outlining', 'Mapping',
    'Deciding', 'Selecting', 'Constructing', 'Translating', 'Adapting',
    'Explaining',
];
const THINKING_PATTERN = new RegExp(`^\\*\\*(?:${THINKING_VERBS.join('|')})[^*]*\\*\\*\\s*\\r?\\n[\\s\\S]*?\\r?\\n{2,}`);
/**
 * Yanıt metninin başındaki "thinking out loud" pattern'ini temizler.
 * Sadece ilk text chunk'a uygulanır — sonraki chunk'lar olduğu gibi geçer.
 * İlk chunk tamamen thinking metni ise boş string döner — caller bunu atlar.
 * Dar pattern: Sadece Gemini'nin bilinen thinking fiillerini eşler (Calculating, Processing, vb.)
 */
export function filterThinkingText(text, isFirstChunk) {
    if (!isFirstChunk)
        return text;
    return text.replace(THINKING_PATTERN, '');
}
/**
 * LIVE-21: Gemini 3.1 bazen yanıtın başına `<thought ...>...</thought>` bloğu
 * sızdırıyor (canlı kanıt: 2026-06-12 14:28 auto-mode classifier yanıtı —
 * verdict kirlenince CLI "could not evaluate" deyip Bash'i blokladı).
 * Chunk bazlı filtre bloğu yakalayamaz (tag chunk'lara bölünür) — bu yüzden
 * non-streaming path'lerde BİRLEŞTİRİLMİŞ tam metne uygulanır.
 * Kapanmamış tag'de metin olduğu gibi bırakılır (yanlış pozitif riskine girme).
 */
export function stripThoughtBlock(text) {
    return text.replace(/^\s*<thought\b[\s\S]*?<\/thought>\s*/i, '');
}
// LIVE-15/23: tool sonucu/devamı sonrası model bazen SADECE içeriksiz bir
// "filler" döndürüp turn'ü bitiriyor ("Let me check", "Bir bakayım" vb.) —
// gerçek cevap yok. Bu, tam empty turn ile aynı kategoride işe yaramaz çıktı.
// Dar pattern: yalnız TAMAMI kısa bir filler olan metin (gerçek cevap "Let me
// check the file: ..." diye DEVAM ederse uzun olur, eşleşmez — false positive yok).
const FILLER_ONLY_PATTERN = /^[\s"'`*]*(let me (check|see|take a look|look)|one moment|checking|hold on|bir (bakay[ıi]m|saniye)|kontrol ediyorum|bakıyorum)[\s.!…]*$/i;
const FILLER_HOLD_CHARS = 24;
/** Metin boş VEYA sadece içeriksiz filler ise işe yaramaz turn'dür (tool yoksa). */
export function isUselessTurn(text, hasToolCalls) {
    if (hasToolCalls)
        return false;
    const t = text.trim();
    if (t.length === 0)
        return true;
    return t.length <= FILLER_HOLD_CHARS && FILLER_ONLY_PATTERN.test(t);
}
// ── Bridge Server ───────────────────────────────────────────
export async function startBridge() {
    const config = getConfig();
    const app = Fastify({
        logger: false,
        bodyLimit: 2 * 1024 * 1024, // 2MB — localhost bridge için yeterli
    });
    // ERRLOG-1: işleyicide beklenmeyen istisna (stream başlamadan) Fastify'ın
    // varsayılan 500'üne düşüyor ve bridge.log'a HİÇ yazılmıyordu; Claude Code
    // 500'ü üstel tekrarla dakikalarca deniyor, kullanıcı yalnız donma görüyordu
    // (canlı 2026-11-26: "type?.toLowerCase is not a function", 9 tekrar, 0 log satırı).
    app.setErrorHandler((error, request, reply) => {
        const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
        const where = error.stack?.split('\n').find((l) => l.includes('/src/') || l.includes('/dist/'))?.trim() ?? '';
        logger.error(`İstek işlenemedi: ${request.method} ${request.url.split('?')[0]} → ${status}: ${error.message} ${where}`);
        if (status >= 500)
            recordPapercut('bridge_500', { url: request.url.split('?')[0], error: error.message, where });
        void reply.status(status).send({
            type: 'error',
            error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', message: sanitizeErrorForClient(error.message) },
        });
    });
    // ── Auth middleware — basit token kontrolü ──
    app.addHook('onRequest', async (request, reply) => {
        // Health endpoint auth gerektirmez
        if (request.url === '/health')
            return;
        // Claude Code her açılışta base URL'e anahtarsız `HEAD /api/hello` erişim
        // yoklaması atar (ua "Bun/…"). Veri döndürmeyen bu yol kimlik istemez.
        if (request.url.split('?')[0] === '/api/hello' && (request.method === 'HEAD' || request.method === 'GET'))
            return;
        // x-api-key array olabilir (aynı header birden fazla gönderilirse) — ilkini al
        const rawApiKey = request.headers['x-api-key'];
        const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;
        // Authorization header — case-insensitive "Bearer " prefix
        const authHeader = request.headers.authorization;
        const bearerToken = typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
            ? authHeader.slice(7)
            : undefined;
        const token = apiKey || bearerToken;
        if (token !== config.bridgeToken) {
            // Teşhis: anahtar DEĞERİ asla loglanmaz, yalnız türü ve hangi başlıktan geldiği.
            const kind = !token ? 'yok' : /^sk-ant-o/i.test(token) ? 'sk-ant-o… (OAuth)' : /^sk-ant-/i.test(token) ? 'sk-ant-… (API)' : `başka (${token.length} kr)`;
            const via = apiKey ? 'x-api-key' : bearerToken ? 'Authorization' : '-';
            logger.warn(`Auth failed: ${request.method} ${request.url.split('?')[0]} from ${request.ip} — anahtar=${kind} via=${via} ` +
                `ua="${String(request.headers['user-agent'] ?? '').slice(0, 80)}"`);
            return reply.status(401).send({
                type: 'error',
                error: { type: 'authentication_error', message: 'Invalid bridge token' },
            });
        }
    });
    // ── Health check ──
    app.get('/health', async () => ({
        status: 'ok',
        bridge: 'claude-gemini',
    }));
    // ── Durum görünürlüğü (STATUS-1 / Faz 0) ──
    // Auth'lu (onRequest hook yalnız /health'i muaf tutar). Kullanıcı fallback'e
    // düşüldüğünü/model eşlemesini log kazmadan görebilsin. Sonraki fazlar
    // (registry/lane durumu) bu yanıtı zenginleştirir.
    app.get('/status', async () => ({
        bridge: 'claude-gemini',
        routing: config.routingEnabled ? 'on' : 'off',
        lanes: {
            quality: { model: config.geminiModel, fallback: config.geminiFallbackModel, transport: 'live' },
            background: { model: config.laneBackgroundModel, transport: 'live' },
            longcontext: {
                model: config.laneLongContextModel,
                transport: 'rest',
                enabled: config.laneLongContextEnabled,
                thresholdTokens: config.longContextThresholdTokens,
                rpdBudget: config.longContextRpdBudget,
            },
            emergency: config.laneEmergencyModel
                ? { model: config.laneEmergencyModel, transport: 'rest' }
                : 'off',
        },
        searchModel: config.geminiSearchModel,
        activeModel: resolveActiveModel(),
        discovery: getDiscoveryStatus(),
        limits: getRegistrySnapshot(),
    }));
    // ── Model listesi (Claude Code bunu sorgular) ──
    // Claude Code'un model sorgusu. Kimlikler güncel Claude modelleri (MODEL-LIST-1, 2026-11-12);
    // hangisi seçilirse seçilsin cevabı Gemini üretir. Yönlendirme body.model'deki "haiku"ya bakar (router.ts).
    app.get('/v1/models', async () => ({
        object: 'list',
        data: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'].map((id) => ({
            id,
            object: 'model',
            display_name: `Gemini Bridge (${config.geminiModel})`,
        })),
    }));
    // ── Token sayımı (Claude Code context yönetimi bunu sorgular) ──
    app.post('/v1/messages/count_tokens', async (request, reply) => {
        const body = request.body;
        if (!body || !Array.isArray(body.messages)) {
            return reply.status(400).send({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'messages[] is required' },
            });
        }
        const systemText = typeof body.system === 'string'
            ? body.system
            : (body.system ?? [])
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('\n');
        return { input_tokens: estimateMessageTokens(body.messages) + estimateTokens(systemText) };
    });
    app.route({ method: ['GET', 'HEAD'], url: '/api/hello', handler: async (_req, reply) => { logger.debug('Erişim yoklaması: /api/hello → 200'); return reply.status(200).send({ ok: true }); } });
    // ── Ana bridge endpoint ──
    app.post('/v1/messages', async (request, reply) => {
        const body = request.body;
        // Request body validation
        if (!body || !body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
            return reply.status(400).send({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'model and messages[] are required' },
            });
        }
        const hasTools = (body.tools?.length ?? 0) > 0;
        const { hasToolResults } = detectToolResults(body.messages);
        logger.info(`Request: model=${body.model} msgs=${body.messages.length} tools=${hasTools ? body.tools.length : 0} toolResults=${hasToolResults} stream=${body.stream ?? 'yok(→json)'}`);
        if (hasToolResults)
            recordToolErrors(body.messages); // PAPERCUT-1
        // DEBUG teşhis dump'ı: gelen istek gövdesi diske yazılır — gerçek Claude
        // Code payload'unu incelemek için (filler/1007 vakalarında ilk kanıt).
        if (getConfig().debug) {
            try {
                const dumpDir = REQUESTS_DIR;
                mkdirSync(dumpDir, { recursive: true });
                writeFileSync(join(dumpDir, `req-${Date.now()}-m${body.messages.length}.json`), JSON.stringify(body, null, 2));
            }
            catch { /* dump başarısızlığı isteği engellemesin */ }
        }
        // Context trimming — token limitini aşıyorsa kırp
        const { trimmed: trimmedMessages, removed } = trimMessages(body.messages);
        if (removed > 0) {
            logger.info(`Context trimmed: ${removed} tokens removed`);
        }
        // bridge talimatı + request.system + role:"system" metadata mesajları
        // (hook/MCP/skill kataloğu) tek systemInstruction'da birleşir — bunlar
        // turn olarak gönderilince Gemini empty turn dönüyordu (2026-06-11).
        const systemPrompt = buildSystemPrompt(body, BRIDGE_SYSTEM_INSTRUCTION);
        // Smart Tooling: Tool'lar tam şema ile gönderiliyor, ayrı catalog'a gerek yok.
        // Tool catalog kaldırıldı — şema bilgisi setup frame'de mevcut.
        const turns = toGeminiTurns(trimmedMessages);
        if (turns.length === 0) {
            return reply.status(400).send({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'No messages provided' },
            });
        }
        // Gemini tool declarations (Anthropic → Gemini format)
        const geminiTools = hasTools
            ? toGeminiFunctionDeclarations(body.tools, { maxTools: getConfig().maxTools })
            : undefined;
        if (geminiTools) {
            logger.debug(`Tool declarations: ${geminiTools.length} tools`);
        }
        // ── Persistent Session: Tool result → AYNI session'a gönder ──
        // Tool call sonrası Claude Code tool result'ı gönderir. tool_use_id ile
        // doğru session bulunur (id bazlı registry) — paralel istekler birbirinin
        // session'ını ASLA kapatmaz (eski global-session bug'ı buydu).
        if (hasToolResults) {
            const { toolResults } = detectToolResults(body.messages);
            const geminiIds = toolResults.map((tr) => toGeminiToolId(tr.tool_use_id));
            // TOOLSEL-1: araç seti değiştiyse eski oturum kapatılır, aşağıdaki replay
            // yolu yeni listeyle oturum kurar.
            if (geminiTools)
                retireToolSessionIfToolsChanged(geminiIds, geminiTools.map((t) => t.name));
            if (hasToolSession(geminiIds)) {
                logger.info(`Tool response routing: ${toolResults.length} results → persistent session`);
                // P-3: Anthropic spec'inde stream default FALSE — alan yoksa JSON dön.
                if (body.stream !== true) {
                    return handleToolResponseNonStreaming(body, toolResults, reply);
                }
                await handleToolResponseStreaming(body, toolResults, reply);
                return;
            }
            // Session ölmüş/timeout olmuş — tam history replay ile devam et
            // (turns içinde functionResponse blokları zaten var).
            logger.warn('Tool results arrived but no open session — full replay fallback');
        }
        // Non-streaming — P-3: stream alanı YOKSA da JSON dönülür (Anthropic
        // spec default'u false). Auto-mode güvenlik sınıflandırıcısı stream'siz
        // istek atar; SSE dönülünce CLI "opus unavailable" sayıp Bash'i blokluyordu.
        // ── ROUTE-1: istek şeride atanır (SPEC-ROUTE). Persistent-session tool
        // devamları buraya GELMEZ (yukarıda session'ına yönlendirildi). ──
        const estTokens = estimateMessageTokens(trimmedMessages) + estimateTokens(systemPrompt ?? '');
        const route = decideRoute(body.model, estTokens);
        if (route.lane !== 'quality') {
            logger.info(`Route: lane=${route.lane} model=${route.model} transport=${route.transport} (${route.reason})`);
        }
        // REST şeritleri (longcontext/emergency): stateless generateContent.
        // REST API hatasında istek kaybolmaz — Live yoluna düşülür. try YALNIZ
        // runRestTurn'ü sarar: yanıt yazımı (sendRestResult) bloğun DIŞINDA —
        // yazım-ortası hata Live fallback'ini ASLA tetiklemez, aksi halde Live
        // handler hijack edilmiş reply'a İKİNCİ yanıt yazardı (review P1-2).
        if (route.transport === 'rest') {
            let restResult = null;
            // REST-SIG-1: şerit modeli meşgulse (503/429) yedek REST modelleri
            // denenir; hepsi düşerse Live'a dönülür.
            const restModels = [route.model, ...getConfig().laneLongContextFallbackModels.filter((m) => m !== route.model)];
            let servedModel = route.model;
            for (const model of route.lane === 'longcontext' ? restModels : [route.model]) {
                try {
                    restResult = await runRestTurn({ model, systemPrompt, messages: trimmedMessages, body, estTokens });
                    servedModel = model;
                    break;
                }
                catch (err) {
                    if (!(err instanceof RestLaneUnavailable))
                        throw err;
                    // P2-3 görünürlüğü: Live'a düşen büyük istek 48KB turn bütçesine
                    // kırpılarak işlenecek — sessiz kalma, oranı logla.
                    logger.warn(`REST lane düştü (${model}: ${err.message.slice(0, 160)})` +
                        (model === restModels[restModels.length - 1] || route.lane !== 'longcontext'
                            ? ` — Live yoluna dönülüyor (est=${estTokens} tok; Live turn bütçesi ~${Math.round(TURNS_BYTE_BUDGET / 1024)}KB — içerik kırpılacak)`
                            : ' — yedek REST modeli deneniyor'));
                }
            }
            if (restResult) {
                // REVIEW-REST-1: araç kullanılmış turun son cevabı burada da denetlenir.
                if (route.lane === 'longcontext') {
                    const first = restResult;
                    restResult = await reviewStateless(body.messages, first, async (extra) => {
                        try {
                            return await runRestTurn({
                                model: servedModel, systemPrompt, messages: [...trimmedMessages, ...extra], body, estTokens,
                            });
                        }
                        catch {
                            return first;
                        }
                    });
                }
                logger.info(`REST lane tamam: lane=${route.lane} model=${servedModel} text=${restResult.text.length}ch tools=${restResult.toolCalls.length}`);
                return sendRestResult(body, restResult, reply);
            }
        }
        if (body.stream !== true) {
            return handleNonStreaming(body, systemPrompt, turns, geminiTools, reply, route.lane);
        }
        // Streaming SSE
        await handleStreaming(body, systemPrompt, turns, geminiTools, reply, route.lane);
    });
    const actualPort = await listenWithFallback(app, config.host, config.port, !config.portExplicit);
    logger.info(`Bridge listening on http://${config.host}:${actualPort}`);
    return {
        port: actualPort,
        close: () => app.close(),
    };
}
// PORT-1: Port doluysa bir sonraki boş portu seç — paralel `claude-gemini`
// oturumları çakışmasın. Fastify fail olan app instance'ını tekrar listen
// edemediği için ÖNCE net.createServer ile boş port yoklanır, SONRA Fastify
// tek seferde o porta bağlanır. PORT env explicit ise (allowFallback=false)
// sadece o port; dolu ise net hata (kullanıcı o porta dışarıdan bağlanacak).
function isPortFree(port, host) {
    return new Promise((resolve) => {
        const tester = createNetServer()
            .once('error', () => resolve(false))
            .once('listening', () => tester.close(() => resolve(true)))
            .listen(port, host);
    });
}
async function listenWithFallback(app, host, startPort, allowFallback) {
    let port = startPort;
    if (allowFallback) {
        const maxTries = 20;
        let found = false;
        for (let i = 0; i < maxTries; i++) {
            const candidate = startPort + i;
            if (await isPortFree(candidate, host)) {
                port = candidate;
                found = true;
                break;
            }
            logger.warn(`Port ${candidate} dolu — ${candidate + 1} deneniyor...`);
        }
        if (!found) {
            throw new Error(`No free port found in range ${startPort}-${startPort + maxTries - 1}`);
        }
    }
    await app.listen({ port, host });
    // PORT=0 → işletim sistemi boş port atar; gerçek portu döndür (testler sabit
    // port çakışmasından kurtulur — EADDRINUSE flake'i, 2026-11-26).
    const addr = app.server.address();
    return typeof addr === 'object' && addr ? addr.port : port;
}
function sendRestResult(body, result, reply) {
    const content = [];
    if (result.text.length > 0)
        content.push({ type: 'text', text: result.text });
    for (const tc of result.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }
    const stopReason = result.toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    if (body.stream !== true) {
        sendAnthropicMessage(reply, body, content, stopReason, result.text.length, result.toolCalls.length);
        return;
    }
    reply.hijack();
    const writer = new SSEWriter(reply.raw);
    writer.writeHead();
    writer.messageStart(generateMessageId(), body.model, reportedInputTokens(body.messages));
    writer.emitText(result.text);
    if (result.toolCalls.length > 0) {
        writer.emitToolCalls(result.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input })));
    }
    else {
        writer.endTurn();
    }
    writer.end();
}
// ── Streaming Handler ───────────────────────────────────────
async function handleStreaming(body, systemPrompt, turns, geminiTools, reply, lane = 'quality') {
    reply.hijack();
    const writer = new SSEWriter(reply.raw);
    writer.writeHead();
    const messageId = generateMessageId();
    let isFirstTextChunk = true;
    // message_start her zaman ilk gider — input token tahmini Claude Code'un
    // context göstergesi/auto-compact'i için gerekli (0 gönderilirse bozulur)
    writer.messageStart(messageId, body.model, reportedInputTokens(body.messages));
    try {
        await withRetry(async (attempt) => {
            // Retry sırasında state reset — ancak partial data gönderilmişse retry YAPMA
            if (writer.dataWritten) {
                throw Object.assign(new Error('Partial data already sent, cannot retry streaming'), {
                    noRetry: true,
                });
            }
            writer.resetTurnState();
            isFirstTextChunk = true;
            // LIVE-20: model "[tool_use: ...]" notasyonunu metin olarak yazabiliyor
            // (flatten taklidi) — marker görülünce SSE'ye yazmadan tampona al; turn
            // sonunda gerçek tool_use'a çevrilir ya da düz metin olarak akıtılır.
            let fakeToolMode = false;
            let fakeToolBuf = '';
            let holding = true;
            let held = '';
            const route = (filtered) => {
                if (fakeToolMode) {
                    fakeToolBuf += filtered;
                    return;
                }
                const markerIdx = filtered.indexOf('[tool_use:');
                if (markerIdx !== -1) {
                    writer.emitText(filtered.slice(0, markerIdx));
                    fakeToolMode = true;
                    fakeToolBuf = filtered.slice(markerIdx);
                    return;
                }
                writer.emitText(filtered);
            };
            // LIVE-19 + ROUTE-1: aktif model attempt + ŞERİT başına çözülür —
            // 1011 sonrası retry otomatik olarak fallback/quality modele gider.
            const activeModel = resolveLaneModel(lane);
            const sentTurns = turnsForAttempt(turns, attempt, activeModel);
            // LIMIT-REG-1: gönderilen gerçek payload'u TPM penceresine işle
            // (attempt başına — her attempt payload'u yeniden gönderir).
            recordUsage(activeModel, estimateTokens(systemPrompt ?? '') + estimateTokens(JSON.stringify(sentTurns)));
            await streamFromGemini({ systemPrompt, turns: sentTurns, tools: geminiTools, model: activeModel }, {
                onText: (text) => {
                    // Thinking out loud filtreleme — ilk chunk'taki düşünce metnini temizle
                    // + sızan flatten işaretçilerini temizle (LIVE-20)
                    const filtered = scrubFlattenMarkers(filterThinkingText(text, isFirstTextChunk));
                    isFirstTextChunk = false;
                    if (filtered.length === 0)
                        return; // boş chunk'ı atla
                    // LIVE-24: ilk FILLER_HOLD_CHARS karakter tutulur — tur yalnız filler
                    // ("Let me check") ise SSE'ye hiç yazılmaz, empty turn gibi retry/fallback.
                    if (holding) {
                        held += filtered;
                        if (held.trim().length > FILLER_HOLD_CHARS) {
                            holding = false;
                            const h = held;
                            held = '';
                            route(h);
                        }
                        return;
                    }
                    route(filtered);
                },
                onToolCall: (toolCalls) => {
                    if (holding) {
                        holding = false;
                        const h = held;
                        held = '';
                        if (h)
                            route(h);
                    }
                    writer.emitToolCalls(toolCalls.map(toAnthropicToolUse));
                },
                // Kapanış event'leri await sonrasında yazılır (empty-turn retry için)
                onTurnComplete: () => { },
                onError: (error) => {
                    logger.error('Stream retry attempt failed', error.message);
                    // ERR-1: Attempt-içi hata client'a yazılmaz, sadece loglanır.
                    // Nihai başarısızlık catch bloğunda ele alınır.
                },
            });
            // LIVE-24: tur bitti, tutulan kısa metin — yalnız filler ise yazılmaz
            // (totalChars 0 kalır → aşağıdaki empty turn yolu retry/fallback yapar).
            if (holding) {
                holding = false;
                if (held && isUselessTurn(held, writer.hasToolCalls)) {
                    logger.warn(`Filler-only streaming turn suppressed: "${held.trim()}"`);
                }
                else if (held) {
                    route(held);
                }
                held = '';
            }
            // LIVE-20: tamponlanan "[tool_use: ...]" metni — gerçek tool_use'a çevir.
            // Ad, Claude Code'un bildirdiği tool listesinde olmalı; değilse veya
            // parse edilemezse düz metin olarak akıtılır.
            if (fakeToolMode) {
                const parsed = parseTextToolCall(fakeToolBuf);
                const known = parsed && (body.tools ?? []).some((t) => t.name === parsed.name);
                if (parsed && known) {
                    logger.info(`Converted fake tool-call text into a real tool_use: ${parsed.name}`);
                    writer.emitText(parsed.before);
                    writer.emitToolCalls([{ id: `toolu_fctext_${Date.now()}`, name: parsed.name, input: parsed.input }]);
                }
                else {
                    writer.emitText(fakeToolBuf);
                }
                fakeToolMode = false;
                fakeToolBuf = '';
            }
            // Empty turn: model hiç içerik üretmeden generationComplete attı.
            // Bilinen geçici Live API davranışı — retry genelde çözer.
            // LIVE-23: primary boş dönüyorsa fallback'e geç (sonraki attempt 2.5'e gider).
            // ROUTE-1a: background şeridinde boş dönen lane modeli bloklanır →
            // resolveLaneModel sonraki attempt'te quality yoluna düşer.
            if (!writer.hasToolCalls && writer.totalChars === 0) {
                const cfg = getConfig();
                if (activeModel === cfg.geminiModel || (lane === 'background' && activeModel === cfg.laneBackgroundModel)) {
                    markModelDegraded('empty turn', Date.now(), activeModel);
                }
                throw Object.assign(new Error('Gemini empty turn'), { emptyTurn: true });
            }
        });
        // Başarılı turn (tool yoksa) — stream'i kapat
        if (!writer.hasToolCalls) {
            writer.endTurn();
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Retry'lara rağmen empty turn — hata yerine boş mesajla zarif kapanış
        // (Claude Code error event'te isteği komple başarısız sayar).
        if (error instanceof Error && error.emptyTurn) {
            logger.warn('Empty turn persisted after retries — closing with an empty message');
            recordPapercut('empty_turn', { model: getConfig().geminiModel });
            writer.closeEmpty();
            writer.end();
            return;
        }
        logger.error('Bridge error', msg);
        recordPapercut('bridge_error', { error: msg });
        writer.writeError(sanitizeErrorForClient(msg), () => logger.debug('Response already closed during error write'));
    }
    finally {
        writer.end();
    }
}
function sendAnthropicMessage(reply, body, content, stopReason, fullTextLength, nTools) {
    reply.send({
        id: generateMessageId(),
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: stopReason,
        usage: {
            input_tokens: reportedInputTokens(body.messages),
            output_tokens: estimateOutputTokens(fullTextLength, nTools),
        },
    });
}
function sendAnthropicError(reply, error, label) {
    const err = error instanceof Error ? error : new Error(String(error));
    const { status, type } = mapErrorToAnthropicStatus(err);
    logger.error(label, err.message);
    reply.status(status).send({
        type: 'error',
        error: { type, message: sanitizeErrorForClient(err.message) },
    });
}
// ── Non-Streaming Handler ───────────────────────────────────
async function handleNonStreaming(body, systemPrompt, turns, geminiTools, reply, lane = 'quality') {
    let textParts = [];
    let toolCallBlocks = [];
    let stopReason = 'end_turn';
    try {
        await withRetry(async (attempt) => {
            // Retry sırasında state reset
            textParts = [];
            toolCallBlocks = [];
            stopReason = 'end_turn';
            let isFirstTextChunk = true;
            // LIVE-19 + ROUTE-1: aktif model attempt + şerit başına çözülür
            const activeModel = resolveLaneModel(lane);
            const sentTurns = turnsForAttempt(turns, attempt, activeModel);
            // LIMIT-REG-1: gönderilen gerçek payload'u TPM penceresine işle
            recordUsage(activeModel, estimateTokens(systemPrompt ?? '') + estimateTokens(JSON.stringify(sentTurns)));
            await streamFromGemini({ systemPrompt, turns: sentTurns, tools: geminiTools, model: activeModel }, {
                onText: (text) => {
                    const filtered = filterThinkingText(text, isFirstTextChunk);
                    isFirstTextChunk = false;
                    if (filtered.length > 0)
                        textParts.push(filtered);
                },
                onToolCall: (toolCalls) => {
                    stopReason = 'tool_use';
                    for (const tc of toolCalls) {
                        const at = toAnthropicToolUse(tc);
                        toolCallBlocks.push(at);
                    }
                },
                onTurnComplete: () => { },
                onError: (error) => {
                    logger.error('Non-streaming stream error', error.message);
                },
            });
            // Empty/filler turn — retry tetikle (geçici Live API davranışı).
            // LIVE-23: primary ısrarla işe yaramaz dönüyorsa fallback'e geç ki
            // SONRAKİ attempt (resolveActiveModel) 2.5'e gitsin — aynı istek kurtulur.
            const rawText = textParts.join('');
            if (isUselessTurn(rawText, toolCallBlocks.length > 0)) {
                const cfg = getConfig();
                if (activeModel === cfg.geminiModel || (lane === 'background' && activeModel === cfg.laneBackgroundModel)) {
                    markModelDegraded(rawText.trim().length === 0 ? 'empty turn' : 'filler-only turn', Date.now(), activeModel);
                }
                throw Object.assign(new Error('Gemini useless turn'), { emptyTurn: true });
            }
        }).catch((err) => {
            // Retry'lara rağmen işe yaramaz turn → boş content ile zarif yanıt (hata değil)
            if (!err.emptyTurn)
                throw err;
            logger.warn('Useless turn persisted after retries — returning empty content');
        });
        const content = [];
        let fullText = scrubFlattenMarkers(stripThoughtBlock(textParts.join('')));
        // LIVE-20: model "[tool_use: ...]" notasyonunu metin olarak yazdıysa
        // gerçek tool_use'a çevir (yalnızca bildirilen tool adlarıyla).
        if (toolCallBlocks.length === 0) {
            const parsed = parseTextToolCall(fullText);
            if (parsed && (body.tools ?? []).some((t) => t.name === parsed.name)) {
                logger.info(`Converted fake tool-call text into a real tool_use: ${parsed.name}`);
                fullText = parsed.before.trimEnd();
                toolCallBlocks.push({
                    type: 'tool_use',
                    id: `toolu_fctext_${Date.now()}`,
                    name: parsed.name,
                    input: parsed.input,
                });
                stopReason = 'tool_use';
            }
        }
        if (fullText.length > 0) {
            content.push({ type: 'text', text: fullText });
        }
        for (const tc of toolCallBlocks) {
            content.push(tc);
        }
        sendAnthropicMessage(reply, body, content, stopReason, fullText.length, toolCallBlocks.length);
    }
    catch (error) {
        sendAnthropicError(reply, error, 'Non-streaming error');
    }
}
export function buildGeminiToolResponses(body, toolResults) {
    return toolResults.map((tr) => {
        // GAP-VISION-1 (2026-06-18): Claude Code bir görseli Read ile okuduğunda
        // tool_result içine image bloğu koyar (media_type+base64). Eskiden yalnız
        // text blokları alınıp image ATILIYORDU → Gemini native vision'ı (zaten
        // destekliyor, transformer.ts:228 doğrudan-mesaj yolu) hiç görmüyordu →
        // model "görseli inceleyemiyorum" diyordu. Artık image blokları
        // functionResponse.parts[].inlineData olarak Gemini'ye geçirilir.
        let rawContent;
        const imageParts = [];
        if (typeof tr.content === 'string') {
            rawContent = tr.content;
        }
        else if (Array.isArray(tr.content)) {
            const texts = [];
            for (const b of tr.content) {
                if (b.type === 'text')
                    texts.push(b.text);
                else if (b.type === 'tool_reference')
                    texts.push(toolResultText([b]));
                else if (b.type === 'image' && b.source?.data) {
                    imageParts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
                }
            }
            rawContent = texts.join('\n');
            if (!rawContent && imageParts.length)
                rawContent = '(görsel ekte — aşağıdaki inlineData)';
        }
        else {
            rawContent = '(empty)';
        }
        const resultText = rawContent.length > LIVE_TOOL_RESULT_MAX_CHARS
            ? rawContent.slice(0, LIVE_TOOL_RESULT_MAX_CHARS) + '\n... (truncated)'
            : rawContent;
        return {
            id: toGeminiToolId(tr.tool_use_id),
            name: findToolName(body.messages, tr.tool_use_id),
            response: tr.is_error
                ? { error: resultText }
                : { result: resultText },
            ...(imageParts.length ? { parts: imageParts } : {}),
        };
    });
}
/**
 * ADR-0002: büyük tablo sonuçlarını (≥8K kr, ayraçlı satırlar) görsel sayfa
 * olarak gönder — 32K metin kesmesi olmadan tam veri, ~%80 daha az token.
 * Hata ya da tablo değilse metin yolu aynen kalır (fail-open).
 */
export async function buildGeminiToolResponsesWithTables(body, toolResults) {
    const out = buildGeminiToolResponses(body, toolResults);
    if (!getConfig().tableAsImage)
        return out;
    await Promise.all(out.map(async (resp, i) => {
        const tr = toolResults[i];
        if (tr.is_error)
            return;
        const conv = await tableToImages(toolResultText(tr.content));
        if (!conv)
            return;
        resp.response = { result: conv.text };
        resp.parts = [...(resp.parts ?? []), ...conv.images];
    }));
    return out;
}
// ── Tool Response Non-Streaming Handler ─────────────────────
// stream:false isteklerinde SSE değil JSON dönmek zorundayız (smoke T2 bug'ı).
async function handleToolResponseNonStreaming(body, toolResults, reply) {
    const textParts = [];
    const toolCallBlocks = [];
    let stopReason = 'end_turn';
    let isFirstTextChunk = true;
    try {
        await sendToolResponse(await buildGeminiToolResponsesWithTables(body, toolResults), {
            onText: (text) => {
                const filtered = filterThinkingText(text, isFirstTextChunk);
                isFirstTextChunk = false;
                if (filtered.length > 0)
                    textParts.push(filtered);
            },
            onToolCall: (toolCalls) => {
                stopReason = 'tool_use';
                for (const tc of toolCalls)
                    toolCallBlocks.push(toAnthropicToolUse(tc));
            },
            onTurnComplete: () => { },
            onError: (error) => {
                logger.error('Tool response non-streaming error', error.message);
            },
        });
        const content = [];
        const fullText = scrubFlattenMarkers(stripThoughtBlock(textParts.join(''))); // TD-017
        if (fullText.length > 0)
            content.push({ type: 'text', text: fullText });
        for (const tc of toolCallBlocks)
            content.push(tc);
        sendAnthropicMessage(reply, body, content, stopReason, fullText.length, toolCallBlocks.length);
    }
    catch (error) {
        sendAnthropicError(reply, error, 'Tool response non-streaming error');
    }
}
// ── Tool Response Streaming Handler ─────────────────────────
async function handleToolResponseStreaming(body, toolResults, reply) {
    reply.hijack();
    const writer = new SSEWriter(reply.raw);
    writer.writeHead();
    const messageId = generateMessageId();
    let isFirstTextChunk = true;
    writer.messageStart(messageId, body.model, reportedInputTokens(body.messages));
    const geminiToolResponses = await buildGeminiToolResponsesWithTables(body, toolResults);
    // ADR-0001 Denetçi: son metin cevabı tamponlanır, akış denetimden sonra yapılır.
    // Model yeni bir tool call yaparsa tampon hemen boşaltılır (denetim yok).
    const review = getConfig().reviewEnabled;
    let draft = '';
    let held = null;
    try {
        await sendToolResponse(geminiToolResponses, {
            onText: (text) => {
                // TD-017: ilk istek yoluyla simetrik — sızan flatten işaretçileri temizlenir.
                const filtered = scrubFlattenMarkers(filterThinkingText(text, isFirstTextChunk));
                isFirstTextChunk = false;
                if (review) {
                    draft += filtered;
                    return;
                }
                writer.emitText(filtered);
            },
            onToolCall: (toolCalls) => {
                if (draft) {
                    writer.emitText(draft);
                    draft = '';
                }
                writer.emitToolCalls(toolCalls.map(toAnthropicToolUse));
            },
            onTurnComplete: () => {
                if (writer.hasToolCalls || review)
                    return;
                writer.endTurn();
            },
            onError: (error) => {
                // ERR-1: finishRequest hem onError'u çağırır hem reject eder — burada da
                // event yazılırsa client çift error event alır. Yazma işi catch'te.
                logger.error('Tool response stream error', error.message);
            },
        }, review ? { onHeld: (h) => { held = h; } } : undefined);
        if (review && !writer.hasToolCalls) {
            await finishWithReview(body, draft, held, writer);
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('Tool response error', msg);
        // ADR-0001: tamponlanmış kısmi metin, eski davranıştaki gibi hatadan önce akar.
        if (draft && !writer.hasToolCalls)
            writer.emitText(draft);
        // Session temizliği gemini-client içinde yapılıyor (closeSession)
        writer.writeError(sanitizeErrorForClient(msg), () => logger.debug('Response already closed'));
    }
    finally {
        writer.end();
    }
}
/**
 * ADR-0001: tamponlanan taslağı denetle. Temizse taslak akar; sorun varsa aynı
 * Live oturumuna tek düzeltme turu gönderilir ve onun çıktısı (metin ya da yeni
 * tool call) akar. Her hata yolunda taslak aynen gider (fail-open).
 */
async function finishWithReview(body, draft, held, writer) {
    let issues = null;
    try {
        issues = held ? await runReview(body.messages, draft) : null;
    }
    catch (err) {
        logger.warn(`Denetçi hatası — taslak denetimsiz gidiyor (${err.message})`);
    }
    if (!held || !issues || issues.length === 0) {
        held?.release();
        writer.emitText(draft);
        writer.endTurn();
        return;
    }
    // AUDIO-NUM-1: taslak kanıtla çelişiyorsa (ses modeli değeri yanlış söyledi)
    // düzeltilmiş cevabı Claude kanıttan yazar; olmazsa Gemini düzeltme turu.
    const fixed = await rewriteFromEvidence(body.messages, draft, issues);
    if (fixed) {
        held.release();
        writer.emitText(fixed);
        writer.endTurn();
        return;
    }
    logger.info(`Denetçi düzeltme turu: ${issues.length} sorun`);
    let revised = '';
    let first = true;
    try {
        await held.followUp(buildFeedback(issues), {
            onText: (text) => {
                revised += filterThinkingText(text, first);
                first = false;
            },
            onToolCall: (toolCalls) => {
                if (revised) {
                    writer.emitText(revised);
                    revised = '';
                }
                writer.emitToolCalls(toolCalls.map(toAnthropicToolUse));
            },
            onTurnComplete: () => { },
            onError: (error) => logger.warn(`Denetçi düzeltme turu hatası: ${error.message}`),
        });
    }
    catch (err) {
        logger.warn(`Denetçi düzeltme turu başarısız — taslak gönderiliyor (${err.message})`);
    }
    if (writer.hasToolCalls)
        return;
    writer.emitText(revised.trim() ? revised : draft);
    writer.endTurn();
}
