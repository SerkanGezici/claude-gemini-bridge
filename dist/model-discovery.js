// DISCOVER-1: açılışta models.list doğrulaması. Gemini API, key'in görebildiği
// modelleri (ad + desteklenen metodlar + token limitleri) `GET /v1beta/models`
// ile veriyor — RPM/TPM/RPD İSE HİÇBİR endpoint'ten sorgulanamıyor (o iş
// limit-registry'nin, LIMIT-REG-1). Buradaki amaç "-latest 404" sınıfı yanlış
// model konfigürasyonlarını her isteği patlatmadan İLK SANİYEDE yakalamak.
// Kanıt zemini: PLANS/archive/MODEL-MATRIX-PROBE-2026-07-03.md.
import { logger } from './logger.js';
export function normalizeModelName(name) {
    return name.startsWith('models/') ? name.slice('models/'.length) : name;
}
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100';
const FETCH_TIMEOUT_MS = 8_000;
export async function fetchAvailableModels(apiKey, fetchImpl = fetch) {
    const resp = await fetchImpl(MODELS_URL, {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
        // Google'ın hata mesajını da taşı (örn. "API key not valid") — onboarding
        // bunu sınıflar. Mesaj API'den gelir, key içermez; yine de kısaltılır.
        let detail = '';
        try {
            const errBody = (await resp.json());
            detail = [errBody.error?.status, errBody.error?.message].filter(Boolean).join(' ').slice(0, 200);
        }
        catch { /* gövde JSON değil */ }
        throw new Error(`models.list failed: HTTP ${resp.status}${detail ? ` ${detail}` : ''}`);
    }
    const body = (await resp.json());
    return (body.models ?? []).map((m) => ({
        name: m.name,
        methods: m.supportedGenerationMethods ?? [],
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
    }));
}
export function validateConfiguredModels(available, requirements) {
    const byName = new Map(available.map((m) => [normalizeModelName(m.name), m]));
    const problems = [];
    for (const req of requirements) {
        const raw = req.model.trim();
        if (!raw || raw === 'none')
            continue; // kapalı/opsiyonel lane
        const found = byName.get(normalizeModelName(raw));
        if (!found) {
            const candidates = available
                .filter((m) => m.methods.includes(req.method))
                .map((m) => normalizeModelName(m.name))
                .slice(0, 6);
            problems.push(`${req.envName}="${raw}" bu API key'de YOK. ${req.method} destekleyen adaylar: ${candidates.join(', ') || '(hiçbiri)'}`);
            continue;
        }
        if (!found.methods.includes(req.method)) {
            problems.push(`${req.envName}="${raw}" var ama ${req.method} DESTEKLEMİYOR (desteklediği: ${found.methods.join(', ') || 'yok'}).`);
        }
    }
    return { ok: problems.length === 0, problems };
}
/**
 * Config'ten doğrulanacak model gereksinimlerini kurar. Lane modelleri
 * (ROUTE-1) eklendikçe TEK yer burası — index.ts'e dokunulmaz.
 */
export function buildModelRequirements(cfg) {
    const reqs = [
        { envName: 'GEMINI_MODEL', model: cfg.geminiModel, method: 'bidiGenerateContent' },
        { envName: 'GEMINI_FALLBACK_MODEL', model: cfg.geminiFallbackModel, method: 'bidiGenerateContent' },
        { envName: 'GEMINI_SEARCH_MODEL', model: cfg.geminiSearchModel, method: 'generateContent' },
    ];
    // ROUTE-1 şerit modelleri yalnız routing AÇIKKEN doğrulanır — ROUTING=off
    // gerçek kill-switch'tir: hiç kullanılmayacak lane modeli yüzünden bridge'in
    // açılmaması rollback senaryosunu bozar (review bulgusu P1-1).
    if (cfg.routingEnabled) {
        reqs.push({ envName: 'LANE_BACKGROUND_MODEL', model: cfg.laneBackgroundModel, method: 'bidiGenerateContent' }, {
            envName: 'LANE_LONGCONTEXT_MODEL',
            model: cfg.laneLongContextEnabled ? cfg.laneLongContextModel : 'none',
            method: 'generateContent',
        }, { envName: 'LANE_EMERGENCY_MODEL', model: cfg.laneEmergencyModel, method: 'generateContent' });
    }
    return reqs;
}
// ── Orkestrasyon (index.ts açılışı kullanır) ─────────────────
// Fail-fast yalnız DOĞRULAMA hatasında (yanlış model zaten her isteği
// patlatır); listeleme İSTEĞİ patlarsa (ağ/timeout) fail-open: warn + devam.
let _status = { state: 'skipped', problems: [] };
export function getDiscoveryStatus() {
    return _status;
}
/** Test yardımcısı. */
export function resetDiscoveryStatus() {
    _status = { state: 'skipped', problems: [] };
}
export async function runModelDiscovery(apiKey, requirements, fetchImpl = fetch, skip = false) {
    if (skip) {
        _status = { state: 'skipped', problems: [] };
        return _status;
    }
    let available;
    try {
        available = await fetchAvailableModels(apiKey, fetchImpl);
    }
    catch (err) {
        // Sanitize: hata mesajı teoride URL/key parçası taşıyabilir — log'a temiz gitsin.
        const msg = (err instanceof Error ? err.message : String(err))
            .replace(/[?&]key=[^&\s]*/gi, '?key=***')
            .replace(/AIza[A-Za-z0-9_-]{30,}/g, '***')
            .replace(/AQ\.[A-Za-z0-9_-]{20,}/g, '***'); // yeni biçim Gemini key'leri
        logger.warn(`Model discovery atlandı (models.list erişilemedi): ${msg}`);
        _status = { state: 'fetch-failed', problems: [] };
        return _status;
    }
    const result = validateConfiguredModels(available, requirements);
    _status = {
        state: result.ok ? 'ok' : 'invalid',
        problems: result.problems,
        modelCount: available.length,
    };
    return _status;
}
