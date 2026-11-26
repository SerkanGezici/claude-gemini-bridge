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
 
export interface BridgeConfig {
  port: number;
  /** PORT env açıkça verildi mi? PORT-1: verilmediyse dolu portta otomatik
   *  bir sonrakine kayılır (paralel claude-gemini); verildiyse sadık kalınır. */
  portExplicit: boolean;
  host: string;
  geminiApiKey: string;
  geminiModel: string;
  /** LIVE-SEARCH-1: sentetik `web_search` tool'unun REST grounding alt-isteğinde
   *  kullanılan düz (non-Live) model. validateModel() BYPASS — o guard yalnız
   *  Live API'ye özeldir; REST'te "-latest" alias'ı geçerlidir. */
  geminiSearchModel: string;
  /** SEARCH-LIVE-1: REST grounding kotası (free tier 20/gün — canlı ölçüm
   *  2026-07-06) veya transient hatada kullanılan Live-grounded fallback modeli.
   *  2.5-audio ailesinin havuzu AYRI ve fiilen sınırsız (canlı ölçüm 2026-07-07:
   *  aynı gün 21 arama duvarsız; tek sınır TPM=1M). 3.1-live grounding
   *  DESTEKLEMİYOR (anında 1011) — 2.5-audio ailesinden seç. 'none' = kapalı. */
  geminiSearchLiveModel: string;
  /** Kota (1011/TPM) fallback modeli; 'none' = devre dışı. LIVE-19.
   *  Kanıt (Serkan key limitleri): 3.1-flash-live TPM=65K (dakikada ~3 ağır
   *  istek), 2.5-native-audio TPM=1M — 1011'de 2.5'e sığınılır. */
  geminiFallbackModel: string;
  /** Kota sonrası fallback'te kalma süresi (TPM penceresi ~1dk). */
  quotaCooldownMs: number;
  debug: boolean;
  retryAttempts: number;
  retryBaseDelay: number;
  bridgeToken: string;
  /** TD-008: BRIDGE_TOKEN verilmedi, rastgele üretildi (bridge-only'de kullanıcıya gösterilir). */
  bridgeTokenGenerated: boolean;
  // ── ROUTE-1: 3 şerit + öğrenen kota devresi (SPEC-ROUTE) ──
  /** Kill-switch: ROUTING=off → tüm istekler eski (tek şerit) davranışta. */
  routingEnabled: boolean;
  /** background şeridi (body.model "haiku" istekleri): TPM 1M'lik 2.5-Live.
   *  Tool'suz özet/compaction işleri 2.5'in güvenli bölgesi (LIVE-15/16a dışı). */
  laneBackgroundModel: string;
  /** longcontext şeridi: Live pencerelerine sığmayan istekler için 1M-context REST. */
  laneLongContextModel: string;
  laneLongContextEnabled: boolean;
  /** Ölçülen giriş bu eşiği aşarsa longcontext'e yönlendirilir (Live ~50KB
   *  dikkat sınırı + 65K TPM — LIMIT-PROBE-1/MODEL-MATRIX-1). */
  longContextThresholdTokens: number;
  /** flash-lite RPD 500 — güvenlik payıyla günlük bütçe (dolunca şerit kapanır). */
  longContextRpdBudget: number;
  /** Taşma: quality penceresi doluyken bu boyuta kadar istekler background'a
   *  taşabilir; ağır tur ASLA taşmaz (2.5 empty-turn zaafı). */
  overflowLightMaxTokens: number;
  /** Acil şerit (default KAPALI): her şey blokeyken background istekleri için
   *  REST modeli (örn. gemma-4-31b-it — TPM sınırsız, talimat-takibi zayıf). */
  laneEmergencyModel: string;
  /** ADR-0001 Denetçi: araç kullanılmış turun son cevabını denetle. REVIEW=off kapatır. */
  reviewEnabled: boolean;
  /** Sırayla denenen denetçiler (ilki başarısızsa sonraki). "claude:<model>" =
   *  kullanıcının Claude Code girişiyle `claude -p`; diğerleri Gemini Live. */
  reviewModels: string[];
  /** TOOLSEL-1: Gemini'ye gönderilen en fazla araç (kurulum yükü/TPM ayarı). */
  maxTools: number;
  /** LONGCTX-1: Claude Code özetlemesinin tetikleneceği mesaj tahmini (token).
   *  Uzun bağlam şeridi eşiğinin (longContextThresholdTokens) altında olmalı. 0 = kapalı. */
  compactAtTokens: number;
  /** TRANSCRIPT-1: Live dökümü kesilen turun sesini metne döken REST modelleri
   *  (sırayla). TRANSCRIPT_REPAIR_MODELS=off kapatır. */
  transcriptRepairModels: string[];
  /** REST-SIG-1: longcontext modeli meşgulse (503/429) sırayla denenen REST modelleri. */
  laneLongContextFallbackModels: string[];
  /** ADR-0002: büyük tablo araç sonuçları Live'a görsel sayfa olarak. TABLE_AS_IMAGE=off kapatır. */
  tableAsImage: boolean;
  /** CU-1 (ADR-0003): `computer_task` MCP aracının computer use modeli. */
  computerUseModel: string;
  /** PAPERCUT-1: takılma kaydı (logs/papercuts.jsonl). PAPERCUTS=off kapatır; birim testlerde kapalı. */
  papercuts: boolean;
  /** BROWSER-1: köprü claude-in-chrome MCP'sini bağlar (BRIDGE_CHROME_MCP=off kapatır). */
  chromeMcp: boolean;
  /** CU-1: köprü computer MCP'sini bağlar (BRIDGE_COMPUTER_USE=off kapatır; yalnız Windows/WSL). */
  computerUse: boolean;
  /** ADR-0004: köprü `office` MCP'sini (belge inspect/compare) bağlar; docenv kurulu olmalı. BRIDGE_OFFICE_MCP=off kapatır. */
  officeMcp: boolean;
  /** SKIP_MODEL_CHECK=1: açılıştaki models.list doğrulamasını atla. */
  skipModelCheck: boolean;
}
 
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Provide it as an environment variable (e.g. \`export ${name}=...\`), ` +
      `or create a .env file by copying .env.example — either in the project root (source install) ` +
      `or at ~/.config/claude-gemini-bridge/.env (recommended for a global \`npm i -g\` install).`,
    );
  }
  return value;
}
 
function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
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

export function loadConfig(): BridgeConfig {
  const host = process.env['HOST'] || '127.0.0.1';
  if (!ALLOWED_HOSTS.includes(host)) {
    throw new Error(
      `HOST must be one of ${ALLOWED_HOSTS.join(', ')}. Public addresses like 0.0.0.0 are a security risk and are rejected.`,
    );
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
 
let _config: BridgeConfig | null = null;
 
export function getConfig(): BridgeConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
 
export function resetConfig(): void {
  _config = null;
}
 