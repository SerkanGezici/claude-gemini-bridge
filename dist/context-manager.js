import { logger } from './logger.js';
import { getConfig } from './config.js';
// ── Configuration ───────────────────────────────────────────
const TOKEN_LIMIT = 250_000; // Kırpmayı tetikle
const TARGET_AFTER_TRIM = 200_000; // Kırpma sonrası hedef
// TOKEST-1: ÖLÇÜLEN oran (MODEL-MATRIX-1 canlı probe 2026-07-03) — eski 3.5
// varsayımı gerçek kullanımı ~%20-25 EKSİK tahmin ediyordu (router 50K eşiği
// geç tetikleniyor + TPM penceresi kotayı geç fark ediyordu). CAP-1 flatten
// bütçeleri CHAR-bazlı (transformer.ts) — bu sabitten ETKİLENMEZ.
// Daha da hassası gerekirse: bedava `countTokens` ön-ölçümü (istek başına
// +1 ağ turu — şimdilik gereksiz görüldü).
const CHARS_PER_TOKEN = 2.86;
// ── Token Estimation ────────────────────────────────────────
/**
 * Metin için yaklaşık token sayısı hesapla.
 * Karakter sayısı / 2.86 (ölçülen) — gerçek tokenizer kullanmadan hızlı tahmin.
 */
export function estimateTokens(text) {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}
/**
 * Anthropic content block'unun yaklaşık token sayısı.
 */
function estimateBlockTokens(block) {
    switch (block.type) {
        case 'text':
            return estimateTokens(block.text);
        case 'image':
            return 258; // Gemini'de sabit ~258 token/image
        case 'tool_use':
            return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input));
        case 'tool_result': {
            if (typeof block.content === 'string')
                return estimateTokens(block.content);
            if (Array.isArray(block.content)) {
                return block.content.reduce((sum, b) => sum + estimateBlockTokens(b), 0);
            }
            return 10; // Minimal
        }
        default:
            return 10;
    }
}
/**
 * Mesaj dizisinin toplam tahmini token sayısı.
 */
export function estimateMessageTokens(messages) {
    let total = 0;
    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            total += estimateTokens(msg.content);
        }
        else {
            for (const block of msg.content) {
                total += estimateBlockTokens(block);
            }
        }
        total += 4; // Role + overhead
    }
    return total;
}
/**
 * Yanıtın yaklaşık çıktı (output) token sayısı — Claude Code'un usage göstergesi
 * için. Heuristic: metin char/4 + tool çağrısı başına ~20 token. server.ts'te 7
 * yerde tekrar eden `Math.ceil(chars/4) + nTools*20` ifadesinin tek kaynağı (TD-007/TD-013).
 */
export function estimateOutputTokens(chars, nTools) {
    return Math.ceil(chars / 4) + nTools * 20;
}
// ── Sliding Window Trimmer ──────────────────────────────────
/**
 * Mesaj dizisini token limitine göre kırpar.
 * Strateji: En eski mesajlardan başla (Sliding Window).
 * Son mesajı (aktif user mesajı) ve ondan önceki assistant mesajını korumaya çalışır.
 */
export function trimMessages(messages, systemTokens = 0) {
    const currentTokens = estimateMessageTokens(messages) + systemTokens;
    if (currentTokens <= TOKEN_LIMIT) {
        return { trimmed: messages, removed: 0 };
    }
    logger.warn(`Approaching context limit: ${currentTokens} tokens (limit: ${TOKEN_LIMIT})`);
    let tokensToRemove = currentTokens - TARGET_AFTER_TRIM;
    let removed = 0;
    const result = [...messages];
    // En eski mesajları sil (son 2 mesajı koru)
    while (tokensToRemove > 0 && result.length > 2) {
        const removedMsg = result.shift();
        const removedTokens = estimateMessageTokens([removedMsg]);
        tokensToRemove -= removedTokens;
        removed += removedTokens;
    }
    if (removed > 0) {
        const afterTokens = estimateMessageTokens(result) + systemTokens;
        logger.info(`Context kırpıldı: ${currentTokens} → ${afterTokens} tokens (${removed} token kaldırıldı)`);
    }
    return { trimmed: result, removed };
}
// ── LONGCTX-1: Claude Code'a bildirilen kullanım ─────────────
// Claude Code özetlemeyi (auto-compact) API'nin bildirdiği input_tokens'a göre
// yapar; köprü oturumunda pencere 100K'ya sabitlenir (claude-args.ts, CLI'ın
// izin verdiği en düşük değer) → tetik ~80K. Köprünün uzun bağlam şeridi
// (longcontext: zayıf REST modeli, denetçi ve web_search yok) ise ~50K tahminde
// başlar. Bildirilen değer ölçeklenir ki özetleme, mesaj tahmini
// compactAtTokens'a ulaşınca tetiklensin. Sistem ve araç tanımları bilerek
// katılmaz: özetleme onları küçültemez, katılırsa her turda özetleme döner.
export const CLAUDE_AUTO_COMPACT_TRIGGER_TOKENS = 80_000;
export function reportedInputTokens(messages, compactAt = getConfig().compactAtTokens) {
    const est = estimateMessageTokens(messages);
    if (compactAt <= 0 || compactAt >= CLAUDE_AUTO_COMPACT_TRIGGER_TOKENS)
        return est;
    return Math.round(est * (CLAUDE_AUTO_COMPACT_TRIGGER_TOKENS / compactAt));
}
