import { getConfig } from './config.js';
import { logger } from './logger.js';
// ── Error Sanitization ───────────────────────────────────
export function sanitizeErrorForClient(msg) {
    return msg
        .replace(/[?&]key=[^&\s]*/gi, '?key=***REDACTED***')
        .replace(/AIza[A-Za-z0-9_-]{30,}/g, '***REDACTED***');
}
// ── Error Mapping ────────────────────────────────────────
export function mapErrorToAnthropicStatus(error) {
    const msg = error.message.toLowerCase();
    // TD-021: kelime sınırlı desenler — eski includes('ws'/'token'/'context'/'401')
    // "shows", "news", "4011", "context" geçen her mesajı yanlış sınıflıyordu.
    if (/\bapi[ _-]?key\b|authenticat|\b401\b|unauthori[sz]ed/.test(msg)) {
        return { status: 401, type: 'authentication_error' };
    }
    if (/rate[ _-]?limit|\b429\b|quota|resource[_ ]exhausted|\b1011\b/.test(msg)) {
        return { status: 429, type: 'rate_limit_error' };
    }
    if (/too (large|long)|\b413\b|context (length|window)|maximum (context|input)|token (count|limit) exceed/.test(msg)) {
        return { status: 413, type: 'request_too_large' };
    }
    if (/time[ds]? ?out/.test(msg)) {
        return { status: 408, type: 'timeout_error' };
    }
    if (/\bws\b|websocket|connection|\becon(nreset|nrefused)|\b502\b|\b1006\b/.test(msg)) {
        return { status: 502, type: 'api_connection_error' };
    }
    return { status: 500, type: 'api_error' };
}
// ── Quota Error Detection (LIVE-19) ──────────────────────
// 1011 close kodu / "quota" / RESOURCE_EXHAUSTED → TPM kotası aşıldı.
// Bu hatalar retry'lanabilir KALIR: bir sonraki attempt fallback modeli
// kullanır (gemini-client.resolveActiveModel).
export function isQuotaError(message) {
    return /quota|\b1011\b|resource[_ ]?exhausted/i.test(message);
}
// ── Transient Error Detection (RETRY-1) ──────────────────
// 5xx sunucu hataları + WS/ağ transport hataları (ECONNRESET, EAI_AGAIN vb.,
// 1006 abnormal closure) → retry ile genelde çözülür. Kota (1011/quota)
// BİLEREK hariç: LIVE-19 cooldown+fallback'in işi, burada retry çift-bekleme
// olur. 1007/1008 (invalid argument / not found) kalıcı — retry anlamsız.
export function isTransientError(message) {
    return /\b(500|502|503|504|1006)\b|internal error|unavailable|bad gateway|econnreset|econnrefused|eai_again|etimedout|epipe|socket hang up|network/i.test(message);
}
// ── Retry with Jittered Exponential Backoff (RETRY-1) ────
// Equal jitter: [ms/2, ms] — eş-zamanlı isteklerin retry dalgalarını dağıtır.
export function jitteredDelay(ms) {
    return ms / 2 + Math.random() * (ms / 2);
}
// transientOnly: yalnız isTransientError() hataları retry edilir — LIVE-7
// proaktif reconnect yolu için (kota/kalıcı hatada anında pes edilir).
// Varsayılan mod eski davranış: auth/noRetry dışında her hata retry'lanır
// (kota dahil — sonraki attempt LIVE-19 fallback modeline gider).
export async function withRetry(fn, opts) {
    const config = getConfig();
    let delay = config.retryBaseDelay;
    for (let attempt = 0; attempt < config.retryAttempts; attempt++) {
        try {
            return await fn(attempt);
        }
        catch (err) {
            const isLastAttempt = attempt === config.retryAttempts - 1;
            const msg = err instanceof Error ? err.message : String(err);
            // Auth/validation hataları ve noRetry flag'li hatalar retry'lanmaz
            const hasNoRetry = err instanceof Error && 'noRetry' in err && err.noRetry;
            if (hasNoRetry || msg.includes('api key') || msg.includes('authentication') || msg.includes('401')) {
                throw err;
            }
            if (opts?.transientOnly && !isTransientError(msg))
                throw err;
            if (isLastAttempt)
                throw err;
            const wait = Math.round(jitteredDelay(Math.min(delay, 30_000)));
            logger.warn(`Attempt ${attempt + 1} failed, retrying in ${wait}ms...`, msg);
            await new Promise((r) => setTimeout(r, wait));
            delay *= 2;
        }
    }
    throw new Error('Unreachable');
}
