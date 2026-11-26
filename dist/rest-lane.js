// ROUTE-1b: longcontext/emergency şeritlerinin STATELESS REST yürütücüsü.
// Live'ın aksine REST generateContent, contents içinde GERÇEK functionCall/
// functionResponse partlarını kabul eder (Live 1007 kısıtı yok — probe-1007
// yalnız Live'a özgüydü) → flatten/48KB bütçe gerekmez, 1M context kullanılır
// (canlı kanıt: 271K token tek istek PASS — MODEL-MATRIX-PROBE-2026-07-03).
// Tasarım sınırı (SPEC-ROUTE): herhangi bir REST hatasında istek KAYBOLMAZ —
// RestLaneUnavailable fırlatılır, server Live yoluna zarif döner.
import { getConfig } from './config.js';
import { getAI } from './gemini-client.js';
import { isQuotaError, sanitizeErrorForClient } from './error-utils.js';
import { recordQuotaError, recordUsage } from './limit-registry.js';
import { toGeminiFunctionDeclarations, toolResultText } from './tool-mapper.js';
import { logger } from './logger.js';
// REST bütçeleri: Live cap'lerinden bilinçli GENİŞ (1M context'in var oluş
// sebebi bu şerit). Savunma amaçlı üst sınırlar — 250K TPM'lik tek pencereye
// server-level trimMessages (250K tok) zaten global tavan koyar.
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const REST_TEXT_MAX_CHARS = 700_000;
export const REST_TOOL_RESULT_MAX_CHARS = 64_000;
const REST_TIMEOUT_MS = 120_000; // üst sınır — Live RESPONSE_TIMEOUT ile hizalı
/** REST-SIG-1: istek boyuna göre zaman aşımı. Canlı: 31K'lık istekte 3.1-flash-lite
 *  120sn asılı kaldı, yedek model ancak sonra denendi. 15sn + 1sn/2K token, en fazla 120sn. */
export function restTimeoutMs(estTokens) {
    return Math.min(REST_TIMEOUT_MS, 15_000 + Math.round(Math.max(0, estTokens) / 2));
}
/** REST şeridi kullanılamıyor — caller Live yoluna dönmeli. */
export class RestLaneUnavailable extends Error {
}
/**
 * ORTADAN kırpma: baş + son korunur. Kuyruktan kırpmak kullanıcının SORUSUNU
 * atar (canlı kanıt 2026-07-03: 226KB longcontext isteğinde sondaki soru
 * kırpıldı, model soruyu hiç görmeden filler analiz etti); baştan kırpmak da
 * bağlam çapasını atar. Soru genelde sonda, referans içerik başta — ikisi de kalır.
 */
export function cap(text, max) {
    if (text.length <= max)
        return text;
    const head = Math.floor(max * 0.6);
    const tail = max - head;
    return (text.slice(0, head) +
        '\n... [orta kısım kırpıldı / middle truncated] ...\n' +
        text.slice(text.length - tail));
}
/**
 * Anthropic messages → REST contents. Live yolundan farkları:
 * tool geçmişi metin temsile değil GERÇEK functionCall/functionResponse
 * partlarına gider; kırpma bütçeleri geniş; flatten yok.
 */
export function toRestContents(messages) {
    const toolIdToName = new Map();
    for (const msg of messages) {
        if (!Array.isArray(msg.content))
            continue;
        for (const block of msg.content) {
            if (block.type === 'tool_use')
                toolIdToName.set(block.id, block.name);
        }
    }
    const turns = [];
    for (const msg of messages) {
        if (msg.role === 'system')
            continue; // systemInstruction'a gider (transformer ile aynı kural)
        if (msg.role === 'assistant' && isEmptyArtifact(msg.content))
            continue;
        const parts = [];
        if (typeof msg.content === 'string') {
            if (msg.content.length > 0)
                parts.push({ text: cap(msg.content, REST_TEXT_MAX_CHARS) });
        }
        else {
            for (const block of msg.content) {
                switch (block.type) {
                    case 'text':
                        if (block.text.length > 0)
                            parts.push({ text: cap(block.text, REST_TEXT_MAX_CHARS) });
                        break;
                    case 'image':
                        parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
                        break;
                    case 'tool_use':
                        // REST-SIG-1: Gemini 3 REST modelleri (3.1/3.5-flash-lite, 3.8-flash)
                        // geçmişteki her functionCall'da thoughtSignature ister; yoksa 400
                        // "Function call is missing a thought_signature". Geçmiş Claude
                        // Code'dan geldiği için gerçek imza yok → belgelenmiş atlama değeri.
                        parts.push({
                            functionCall: { name: block.name, args: block.input ?? {} },
                            thoughtSignature: SKIP_THOUGHT_SIGNATURE,
                        });
                        break;
                    case 'tool_result': {
                        const raw = toolResultText(block.content);
                        const name = toolIdToName.get(block.tool_use_id) ?? 'unknown_tool';
                        const capped = cap(raw, REST_TOOL_RESULT_MAX_CHARS);
                        parts.push({
                            functionResponse: {
                                name,
                                response: block.is_error ? { error: capped } : { result: capped },
                            },
                        });
                        // GAP-VISION-1 REST ayağı: tool_result içindeki görseller de taşınır
                        // (medya token maliyeti ihmal edilebilir — 213KB PNG = ~1K tok).
                        if (Array.isArray(block.content)) {
                            for (const b of block.content) {
                                if (b.type === 'image' && b.source?.data) {
                                    parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
                                }
                            }
                        }
                        break;
                    }
                }
            }
        }
        if (parts.length === 0)
            continue;
        const role = msg.role === 'assistant' ? 'model' : 'user';
        const prev = turns[turns.length - 1];
        if (prev && prev.role === role)
            prev.parts.push(...parts);
        else
            turns.push({ role, parts });
    }
    return turns;
}
function isEmptyArtifact(content) {
    const text = typeof content === 'string'
        ? content
        : Array.isArray(content) && content.length === 1 && content[0].type === 'text'
            ? content[0].text
            : '';
    return typeof text === 'string' && text.trim() === 'No response requested.';
}
let _restIdCounter = 0;
export async function runRestTurn(params, generateFn) {
    const { model, systemPrompt, messages, body, estTokens } = params;
    const contents = toRestContents(messages);
    if (contents.length === 0)
        throw new RestLaneUnavailable('REST lane: boş contents');
    // PARAM-1 (REST ayağı): Anthropic parametreleri Gemini generationConfig'e —
    // Live yolunda sessizce yok sayılan alanlar burada gerçekten uygulanır.
    const decls = body.tools?.length
        ? toGeminiFunctionDeclarations(body.tools, { includeWebSearch: false, maxTools: getConfig().maxTools })
        : undefined;
    const request = {
        model,
        contents,
        config: {
            ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
            ...(decls?.length ? { tools: [{ functionDeclarations: decls }] } : {}),
            maxOutputTokens: Math.min(body.max_tokens || 65_536, 65_536),
            ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
            ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
            ...(body.top_k !== undefined ? { topK: body.top_k } : {}),
            ...(body.stop_sequences?.length ? { stopSequences: body.stop_sequences } : {}),
        },
    };
    recordUsage(model, estTokens); // TPM penceresi + RPD sayacı (bütçe kapısı bunu okur)
    const generate = generateFn ?? ((req) => getAI().models.generateContent(req));
    let timeoutId;
    let resp;
    try {
        resp = await Promise.race([
            generate(request),
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`REST lane timed out after ${restTimeoutMs(estTokens)}ms`)), restTimeoutMs(estTokens));
            }),
        ]);
    }
    catch (err) {
        // Log'a da sanitize edilmiş mesaj yaz (defense-in-depth: SDK bir gün
        // URL-with-key'li hata yüzeye çıkarırsa bridge.log'a düz key düşmesin).
        const msg = sanitizeErrorForClient(err instanceof Error ? err.message : String(err));
        if (isQuotaError(msg) || msg.includes('429')) {
            const info = recordQuotaError(model, msg, Date.now(), getConfig().quotaCooldownMs);
            // RESTQUOTA-1: hangi kota (dakika/gün, istek/token) ve limit — eskiden yalnız "kota hatası".
            const what = info.quotaId ? ` [${info.quotaId}${info.quotaValue !== undefined ? ` limit=${info.quotaValue}` : ''}]` : ` [kota türü okunamadı: ${msg.slice(0, 160)}]`;
            logger.warn(`REST lane kota hatası: ${model}${what} — ${Math.round((info.retryDelayMs ?? getConfig().quotaCooldownMs) / 1000)}sn bloklandı${info.retryDelayMs === undefined ? ' (retryDelay yok, varsayılan)' : ''}`);
        }
        else {
            logger.warn(`REST lane hatası: ${msg}`);
        }
        throw new RestLaneUnavailable(msg);
    }
    finally {
        if (timeoutId)
            clearTimeout(timeoutId);
    }
    const parts = resp.candidates?.[0]?.content?.parts ?? [];
    const result = { text: '', toolCalls: [] };
    for (const part of parts) {
        if (part['thought'] === true)
            continue; // düşünce partları kullanıcıya akmaz
        if (typeof part['text'] === 'string')
            result.text += part['text'];
        const fc = part['functionCall'];
        if (fc?.name) {
            _restIdCounter += 1;
            result.toolCalls.push({
                id: `toolu_rest_${Date.now()}_${_restIdCounter}`,
                name: fc.name,
                input: fc.args ?? {},
            });
        }
    }
    if (!result.text && result.toolCalls.length === 0) {
        // REST'te de boş yanıt teorik olarak mümkün — Live yoluna dönmek en güvenlisi.
        throw new RestLaneUnavailable('REST lane: boş yanıt');
    }
    return result;
}
