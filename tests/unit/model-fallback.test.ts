// LIVE-19: TPM kota fallback sistemi (Serkan'ın key limitleri, 2026-06-11):
//   3.1-flash-live TPM=65K (≈ dakikada ~3 ağır Claude Code isteği) → 1011
//   2.5-native-audio TPM=1M → kota sığınağı
// Tasarım: birincil model 1011/quota alınca cooldown süresince fallback'e
// geçilir, süre dolunca otomatik birincile dönülür.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resetConfig } from '../../src/config.js';
import {
  resolveActiveModel,
  markQuotaExceeded,
  markModelDegraded,
  resetQuotaState,
} from '../../src/gemini-client.js';
import { isQuotaError } from '../../src/error-utils.js';
import { isUselessTurn } from '../../src/server.js';

const savedEnv: Record<string, string | undefined> = {};
const KEYS = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL', 'QUOTA_COOLDOWN_MS'];

beforeAll(() => {
  for (const k of KEYS) savedEnv[k] = process.env[k];
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['GEMINI_MODEL'] = 'models/gemini-3.1-flash-live-preview';
  process.env['GEMINI_FALLBACK_MODEL'] = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
  process.env['QUOTA_COOLDOWN_MS'] = '60000';
});

afterAll(() => {
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetConfig();
  resetQuotaState();
});

beforeEach(() => {
  resetConfig();
  resetQuotaState();
});

describe('isQuotaError', () => {
  it('1011 quota mesajını tanır', () => {
    expect(isQuotaError('Gemini closed: 1011 You exceeded your current quota, please check your plan')).toBe(true);
  });
  it('RESOURCE_EXHAUSTED tanır', () => {
    expect(isQuotaError('Error: RESOURCE_EXHAUSTED')).toBe(true);
  });
  it('1007 invalid argument quota DEĞİL', () => {
    expect(isQuotaError('Gemini closed: 1007 Request contains an invalid argument.')).toBe(false);
  });
  it('sıradan hata quota DEĞİL', () => {
    expect(isQuotaError('Gemini timeout')).toBe(false);
  });
});

describe('resolveActiveModel + markQuotaExceeded', () => {
  it('normalde birincil modeli döner', () => {
    expect(resolveActiveModel()).toBe('models/gemini-3.1-flash-live-preview');
  });

  it('kota işaretlenince cooldown boyunca fallback döner', () => {
    const t0 = 1_000_000;
    markQuotaExceeded(t0);
    expect(resolveActiveModel(t0 + 1)).toBe('models/gemini-2.5-flash-native-audio-preview-12-2025');
    expect(resolveActiveModel(t0 + 59_999)).toBe('models/gemini-2.5-flash-native-audio-preview-12-2025');
  });

  it('cooldown dolunca birincile otomatik döner', () => {
    const t0 = 1_000_000;
    markQuotaExceeded(t0);
    expect(resolveActiveModel(t0 + 60_001)).toBe('models/gemini-3.1-flash-live-preview');
  });

  it('GEMINI_FALLBACK_MODEL=none → fallback devre dışı, hep birincil', () => {
    process.env['GEMINI_FALLBACK_MODEL'] = 'none';
    resetConfig();
    const t0 = 2_000_000;
    markQuotaExceeded(t0);
    expect(resolveActiveModel(t0 + 1)).toBe('models/gemini-3.1-flash-live-preview');
    process.env['GEMINI_FALLBACK_MODEL'] = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
  });

  it('fallback birincil ile aynıysa geçiş anlamsız → birincil döner', () => {
    process.env['GEMINI_FALLBACK_MODEL'] = 'models/gemini-3.1-flash-live-preview';
    resetConfig();
    const t0 = 3_000_000;
    markQuotaExceeded(t0);
    expect(resolveActiveModel(t0 + 1)).toBe('models/gemini-3.1-flash-live-preview');
    process.env['GEMINI_FALLBACK_MODEL'] = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
  });
});

// LIVE-23: empty/filler turn de kota gibi "model bozuldu" sinyali → fallback.
// Kanıt 2026-06-13: 3.1 "2+2" → 3 attempt boş, AYNI ANDA 2.5 → "4".
describe('markModelDegraded (LIVE-23 empty-turn fallback)', () => {
  it('empty turn sebebiyle işaretlenince fallback döner (kota ile aynı yol)', () => {
    const t0 = 5_000_000;
    markModelDegraded('empty turn', t0);
    expect(resolveActiveModel(t0 + 1)).toBe('models/gemini-2.5-flash-native-audio-preview-12-2025');
    expect(resolveActiveModel(t0 + 60_001)).toBe('models/gemini-3.1-flash-live-preview'); // otomatik recovery
  });
});

describe('isUselessTurn (LIVE-15/23)', () => {
  it('boş metin → işe yaramaz', () => {
    expect(isUselessTurn('', false)).toBe(true);
    expect(isUselessTurn('   \n  ', false)).toBe(true);
  });
  it('sadece filler ("Let me check") → işe yaramaz', () => {
    expect(isUselessTurn('Let me check', false)).toBe(true);
    expect(isUselessTurn('Let me check.', false)).toBe(true);
    expect(isUselessTurn('Bir bakayım', false)).toBe(true);
    expect(isUselessTurn('Checking...', false)).toBe(true);
  });
  it('gerçek cevap → işe yarar (filler ile başlasa bile devam ederse)', () => {
    expect(isUselessTurn('Let me check the file: 3 kalem var.', false)).toBe(false);
    expect(isUselessTurn('Alışveriş listesinde 3 kalem var.', false)).toBe(false);
    expect(isUselessTurn('4', false)).toBe(false);
  });
  it('tool call varsa asla işe yaramaz sayılmaz (boş metin normal)', () => {
    expect(isUselessTurn('', true)).toBe(false);
    expect(isUselessTurn('Let me check', true)).toBe(false);
  });
});
