import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { ENV_PATH, USER_ENV_PATH } from './paths.js';
// PORT-1: PORT'un KOMUT SATIRINDAN mı yoksa .env'den mi geldiğini ayır.
// dotenv'den ÖNCE bakılır: burada varsa kullanıcı `PORT=X claude-gemini` demiş
// = sabit port iste. .env'deki PORT sadece başlangıç değeri (paralel instance
// dolu portta bir sonrakine kayabilmeli) — onu "explicit" sayma.
const PORT_FROM_CLI = !!process.env['PORT']?.trim();
// .env loading order. dotenv does NOT override variables already present in
// process.env, so the FIRST source to define a var wins — and real environment
// variables (e.g. `export GEMINI_API_KEY=...`) always win because they are set
// before this module runs. PATHS-1: paths are resolved from the bridge root,
// not the cwd, so config loads even when launched from another project dir.
//   1. real environment variables
//   2. ~/.config/claude-gemini-bridge/.env   (recommended for `npm i -g`)
//   3. <package root>/.env                   (source-install default)
dotenv.config({ path: USER_ENV_PATH });
dotenv.config({ path: ENV_PATH });
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is not set. Provide it as an environment variable (e.g. \`export ${name}=...\`), ` +
            `or create a .env file by copying .env.example — either in the project root (source install) ` +
            `or at ~/.config/claude-gemini-bridge/.env (recommended for a global \`npm i -g\` install).`);
    }
    return value;
}
function envInt(name, fallback) {
    const value = process.env[name];
    if (!value)
        return fallback;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        throw new Error(`${name} must be a valid integer, got: ${value}`);
    }
    return parsed;
}
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1'];
// DOC-LATEST-1 (2026-07-06): eski validateModel guard'ı ("-latest = 404")
// KALDIRILDI — canlı probe (MODEL-MATRIX-1, 2026-07-03) 2.5-native-audio-latest
// alias'ının Live'da ÇALIŞTIĞINI kanıtladı; not eskimişti. Gerçek doğrulama
// artık DISCOVER-1: açılışta models.list ile TÜM lane modelleri kontrol edilir,
// geçersiz ad fail-fast + aday önerisiyle yakalanır (src/model-discovery.ts).
export function loadConfig() {
    const host = process.env['HOST'] || '127.0.0.1';
    if (!ALLOWED_HOSTS.includes(host)) {
        throw new Error(`HOST must be one of ${ALLOWED_HOSTS.join(', ')}. Public addresses like 0.0.0.0 are a security risk and are rejected.`);
    }
    return {
        port: envInt('PORT', 8002),
        portExplicit: PORT_FROM_CLI,
        host,
        geminiApiKey: requireEnv('GEMINI_API_KEY'),
        geminiModel: process.env['GEMINI_MODEL'] || 'models/gemini-2.5-flash-native-audio-preview-12-2025',
        // LIVE-SEARCH-1: REST grounding modeli. Düz string, default 2.5-flash.
        geminiSearchModel: process.env['GEMINI_SEARCH_MODEL']?.trim() || 'gemini-2.5-flash',
        // SEARCH-LIVE-1: kota/transient'te Live-grounded fallback ('none' = kapalı).
        geminiSearchLiveModel: process.env['GEMINI_SEARCH_LIVE_MODEL']?.trim()
            || 'models/gemini-2.5-flash-native-audio-preview-12-2025',
        geminiFallbackModel: process.env['GEMINI_FALLBACK_MODEL']?.trim()
            || 'models/gemini-2.5-flash-native-audio-preview-12-2025',
        quotaCooldownMs: envInt('QUOTA_COOLDOWN_MS', 60_000),
        debug: process.env['DEBUG'] === 'true',
        retryAttempts: envInt('RETRY_ATTEMPTS', 3),
        retryBaseDelay: envInt('RETRY_BASE_DELAY', 2000),
        bridgeToken: process.env['BRIDGE_TOKEN']?.trim() || randomUUID(),
        bridgeTokenGenerated: !process.env['BRIDGE_TOKEN']?.trim(),
        // ── ROUTE-1 (SPEC-ROUTE; kota kanıtı: MODEL-MATRIX-PROBE-2026-07-03) ──
        routingEnabled: process.env['ROUTING']?.trim().toLowerCase() !== 'off',
        laneBackgroundModel: process.env['LANE_BACKGROUND_MODEL']?.trim()
            || 'models/gemini-2.5-flash-native-audio-preview-12-2025',
        laneLongContextModel: process.env['LANE_LONGCONTEXT_MODEL']?.trim() || 'gemini-3.1-flash-lite',
        laneLongContextEnabled: process.env['LANE_LONGCONTEXT_ENABLED']?.trim().toLowerCase() !== 'false',
        longContextThresholdTokens: envInt('LONGCONTEXT_THRESHOLD_TOKENS', 50_000),
        longContextRpdBudget: envInt('LONGCONTEXT_RPD_BUDGET', 450),
        overflowLightMaxTokens: envInt('OVERFLOW_LIGHT_MAX_TOKENS', 12_000),
        laneEmergencyModel: process.env['LANE_EMERGENCY_MODEL']?.trim() || '',
        reviewEnabled: process.env['REVIEW']?.trim().toLowerCase() !== 'off',
        reviewModels: (process.env['REVIEW_MODELS']?.trim()
            || 'claude:sonnet,models/gemini-3.8-live-extended-thinking,models/gemini-3.8-live')
            .split(',').map((m) => m.trim()).filter(Boolean),
        maxTools: envInt('MAX_TOOLS', 128),
        compactAtTokens: envInt('BRIDGE_COMPACT_AT_TOKENS', 45_000),
        transcriptRepairModels: process.env['TRANSCRIPT_REPAIR_MODELS']?.trim().toLowerCase() === 'off'
            ? []
            : (process.env['TRANSCRIPT_REPAIR_MODELS']?.trim() || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite')
                .split(',').map((m) => m.trim()).filter(Boolean),
        laneLongContextFallbackModels: (process.env['LANE_LONGCONTEXT_FALLBACK_MODELS']?.trim() ?? 'gemini-3.5-flash-lite')
            .split(',').map((m) => m.trim()).filter(Boolean),
        tableAsImage: process.env['TABLE_AS_IMAGE']?.trim().toLowerCase() !== 'off',
        computerUseModel: process.env['COMPUTER_USE_MODEL']?.trim() || 'gemini-3.5-flash-lite',
        papercuts: process.env['PAPERCUTS']?.trim().toLowerCase() !== 'off' && !process.env['VITEST'],
        chromeMcp: process.env['BRIDGE_CHROME_MCP']?.trim() !== 'off',
        computerUse: process.env['BRIDGE_COMPUTER_USE']?.trim() !== 'off',
        officeMcp: process.env['BRIDGE_OFFICE_MCP']?.trim() !== 'off',
        skipModelCheck: process.env['SKIP_MODEL_CHECK']?.trim() === '1',
    };
}
let _config = null;
export function getConfig() {
    if (!_config) {
        _config = loadConfig();
    }
    return _config;
}
export function resetConfig() {
    _config = null;
}
