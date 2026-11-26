// LIMIT-REG-1: öğrenen limit registry. Ölçüm kanıtları
// (PLANS/archive/MODEL-MATRIX-PROBE-2026-07-03.md):
//   • Kota "borçlandırma" ile çalışır: pencere boşken limit-üstü TEK istek geçer
//     (271K tok > 250K TPM PASS), sonraki 429 alır → wouldExceedTpm aynı semantik.
//   • 429 gövdesi quotaValue="250000" + retryDelay="42s" verir → parse + öğrenme.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resetLimitRegistry,
  setLimitStatePath,
  getModelLimits,
  recordUsage,
  windowTokens,
  wouldExceedTpm,
  rpdRemaining,
  recordQuotaError,
  blockModel,
  isBlocked,
  getRegistrySnapshot,
  flushLimitState,
  parseQuotaError,
} from '../../src/limit-registry.js';

const PRIMARY = 'models/gemini-3.1-flash-live-preview';
const LITE = 'gemini-3.1-flash-lite';

const tmp = mkdtempSync(join(tmpdir(), 'limits-test-'));
const STATE = join(tmp, 'limits.json');

beforeEach(() => {
  resetLimitRegistry();
  setLimitStatePath(STATE, /* wipe */ true);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('seed limitler', () => {
  it('models/ önekinden bağımsız seed TPM döner (AI Studio tablosu)', () => {
    expect(getModelLimits(PRIMARY).tpm).toBe(65_000);
    expect(getModelLimits('gemini-2.5-flash-native-audio-preview-12-2025').tpm).toBe(1_000_000);
    expect(getModelLimits(LITE)).toMatchObject({ rpm: 15, tpm: 250_000, rpd: 500 });
  });
  it('bilinmeyen model boş limit döner (sınırsız varsayılır)', () => {
    expect(getModelLimits('gemini-bilinmeyen').tpm).toBeUndefined();
  });
});

describe('kayan pencere + borçlandırma semantiği', () => {
  it('pencere boşken limit-üstü tek istek GEÇER (ölçülen API davranışı)', () => {
    const now = 1_000_000;
    expect(wouldExceedTpm(PRIMARY, now)).toBe(false); // pencere boş
    recordUsage(PRIMARY, 70_000, now); // 65K limitin üstü ama girmişti
    expect(wouldExceedTpm(PRIMARY, now + 1000)).toBe(true); // artık borçta
  });

  it('60sn sonra pencere boşalır', () => {
    const now = 1_000_000;
    recordUsage(PRIMARY, 70_000, now);
    expect(wouldExceedTpm(PRIMARY, now + 59_000)).toBe(true);
    expect(wouldExceedTpm(PRIMARY, now + 61_000)).toBe(false);
    expect(windowTokens(PRIMARY, now + 61_000)).toBe(0);
  });

  it('TPM tanımsız modelde asla exceed olmaz', () => {
    recordUsage('gemini-bilinmeyen', 10_000_000, 1000);
    expect(wouldExceedTpm('gemini-bilinmeyen', 2000)).toBe(false);
  });
});

describe('RPD sayacı', () => {
  it('istek başına düşer ve gün devrilince sıfırlanır', () => {
    const day1 = Date.UTC(2026, 6, 3, 12, 0, 0);
    const day2 = Date.UTC(2026, 6, 4, 0, 5, 0);
    expect(rpdRemaining(LITE, day1)).toBe(500);
    recordUsage(LITE, 100, day1);
    recordUsage(LITE, 100, day1);
    expect(rpdRemaining(LITE, day1)).toBe(498);
    expect(rpdRemaining(LITE, day2)).toBe(500); // UTC gün devri
  });
  it('RPD tanımsız modelde Infinity döner', () => {
    expect(rpdRemaining(PRIMARY, Date.now())).toBe(Infinity);
  });
});

describe('429/1011 öğrenme', () => {
  const ERR_429 =
    'HTTP 429 ... "quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_input_token_count",' +
    '"quotaId":"GenerateContentInputTokensPerModelPerMinute-FreeTier","quotaValue":"250000" ...' +
    ' RetryInfo {"retryDelay":"42s"}';

  it('retryDelay parse edilir ve model o süre bloklanır', () => {
    const now = 5_000_000;
    const info = recordQuotaError(LITE, ERR_429, now);
    expect(info.retryDelayMs).toBe(42_000);
    expect(isBlocked(LITE, now + 41_000)).toBe(true);
    expect(isBlocked(LITE, now + 43_000)).toBe(false);
  });

  it('quotaValue token/dakika kotası olarak öğrenilir (seed ezilir)', () => {
    recordQuotaError(LITE, ERR_429.replace('"250000"', '"199999"'), 1000);
    expect(getModelLimits(LITE).tpm).toBe(199_999);
  });

  it('retryDelay yoksa verilen fallback cooldown kullanılır', () => {
    const now = 5_000_000;
    const info = recordQuotaError(PRIMARY, '1011 quota exceeded', now, 60_000);
    expect(info.retryDelayMs).toBeUndefined();
    expect(isBlocked(PRIMARY, now + 59_000)).toBe(true);
    expect(isBlocked(PRIMARY, now + 61_000)).toBe(false);
  });

  it('kesirli retryDelay ("2.5s") milisaniyeye çevrilir', () => {
    const info = recordQuotaError(LITE, 'retryDelay":"2.5s"', 1000);
    expect(info.retryDelayMs).toBe(2_500);
  });

  it('absürt retryDelay 1 saat tavanına clamp edilir (self-DoS hardening)', () => {
    const info = recordQuotaError(LITE, 'retryDelay":"999999s"', 1000);
    expect(info.retryDelayMs).toBe(3_600_000);
  });

  it('PerDay quotaId RPD olarak öğrenilir', () => {
    recordQuotaError(
      'gemini-omni-flash-preview',
      '"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"0"',
      1000,
    );
    expect(getModelLimits('gemini-omni-flash-preview').rpd).toBe(0);
  });
});

describe('blok yönetimi', () => {
  it('blockModel/isBlocked süre bazlı çalışır', () => {
    blockModel(PRIMARY, 10_000);
    expect(isBlocked(PRIMARY, 9_999)).toBe(true);
    expect(isBlocked(PRIMARY, 10_001)).toBe(false);
  });
});

describe('persist + restart', () => {
  it('öğrenilen limitler ve RPD sayaçları restart sonrası korunur; pencere korunmaz', () => {
    const now = Date.UTC(2026, 6, 3, 12, 0, 0);
    recordUsage(LITE, 50_000, now);
    recordQuotaError(LITE, '"quotaId":"GenerateContentInputTokensPerModelPerMinute-FreeTier","quotaValue":"123456"', now);

    // restart simülasyonu: bellek sıfırlanır, aynı state dosyası yüklenir
    resetLimitRegistry();
    setLimitStatePath(STATE, /* wipe */ false);

    expect(getModelLimits(LITE).tpm).toBe(123_456); // learned korundu
    expect(rpdRemaining(LITE, now)).toBe(499); // RPD korundu
    expect(windowTokens(LITE, now)).toBe(0); // pencere persist edilmez

    const raw = JSON.parse(readFileSync(STATE, 'utf-8'));
    expect(raw.learned).toBeDefined();
  });
});

describe('merge-on-write + debounce (review P2-1/P2-2)', () => {
  it('flushLimitState, debounce beklemeden RPD sayacını diske yazar', () => {
    const now = Date.UTC(2026, 6, 3, 12, 0, 0);
    recordUsage(LITE, 100, now); // deferred — henüz diskte olmayabilir
    flushLimitState();
    const raw = JSON.parse(readFileSync(STATE, 'utf-8'));
    expect(raw.rpd['gemini-3.1-flash-lite'].count).toBe(1);
  });

  it('paralel instance simülasyonu: diskteki yabancı learned/rpd EZİLMEZ, birleştirilir', () => {
    const now = Date.UTC(2026, 6, 3, 12, 0, 0);
    // "Diğer process" diske kendi öğrendiklerini yazmış olsun
    writeFileSync(STATE, JSON.stringify({
      learned: { 'baska-model': { tpm: 42 } },
      rpd: { 'gemini-3.1-flash-lite': { day: '2026-07-03', count: 7 } },
    }));
    // Bu process 1 istek işleyip flush ediyor
    recordUsage(LITE, 100, now);
    flushLimitState();
    const raw = JSON.parse(readFileSync(STATE, 'utf-8'));
    expect(raw.learned['baska-model']).toEqual({ tpm: 42 }); // yabancı learned korundu
    expect(raw.rpd['gemini-3.1-flash-lite'].count).toBe(7); // max(7, 1) — ezilmedi
  });
});

describe('snapshot (/status için)', () => {
  it('kullanımı olan modelleri raporlar', () => {
    const now = 1_000_000;
    recordUsage(PRIMARY, 30_000, now);
    blockModel(PRIMARY, now + 5000);
    const snap = getRegistrySnapshot(now);
    const entry = snap['gemini-3.1-flash-live-preview'];
    expect(entry).toBeDefined();
    expect(entry.windowTokens).toBe(30_000);
    expect(entry.blockedForMs).toBe(5000);
  });
});

describe('RESTQUOTA-1 güncel 429 gövdesi', () => {
  // Gerçek AI Studio 429 metninden kısaltıldı (2026-11-26): quotaValue alanı yok,
  // limit metinde; quotaId ve RetryInfo details içinde.
  const real = 'ApiError: {"error":{"code":429,"message":"You exceeded your current quota. \\n* Quota exceeded for metric: ' +
    'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-3.1-flash-lite, ' +
    'description: Generate content input tokens per minute limit exceeded on Free Tier.\\nPlease retry in 41.2s.",' +
    '"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{' +
    '"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_input_token_count",' +
    '"quotaId":"GenerateContentInputTokensPerModelPerMinute-FreeTier"}]},' +
    '{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"41s"}]}}';

  it('quotaId, metindeki limit ve retryDelay okunur', () => {
    const info = parseQuotaError(real);
    expect(info.quotaId).toBe('GenerateContentInputTokensPerModelPerMinute-FreeTier');
    expect(info.quotaValue).toBe(250000);
    expect(info.retryDelayMs).toBe(41_000);
  });
});
