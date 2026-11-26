// ROUTE-1: istek-tipi routing. Sınıflandırma sinyali HEURİSTİK DEĞİL:
// Claude Code background işlerini KENDİSİ "haiku" model adıyla gönderir —
// bu onun kalite beyanıdır. (SPEC-ROUTE, MODEL-MATRIX-PROBE-2026-07-03)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { resetConfig } from '../../src/config.js';
import { decideRoute, resolveLaneModel } from '../../src/router.js';
import { resetLimitRegistry, blockModel, recordUsage } from '../../src/limit-registry.js';
import { resetQuotaState } from '../../src/gemini-client.js';

const PRIMARY = 'models/gemini-3.1-flash-live-preview';
const BACKGROUND = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

const savedEnv: Record<string, string | undefined> = {};
const KEYS = [
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL', 'ROUTING',
  'LANE_BACKGROUND_MODEL', 'LANE_LONGCONTEXT_MODEL', 'LANE_LONGCONTEXT_ENABLED',
  'LONGCONTEXT_THRESHOLD_TOKENS', 'LONGCONTEXT_RPD_BUDGET',
  'OVERFLOW_LIGHT_MAX_TOKENS', 'LANE_EMERGENCY_MODEL', 'QUOTA_COOLDOWN_MS',
];

beforeAll(() => {
  for (const k of KEYS) savedEnv[k] = process.env[k];
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['GEMINI_MODEL'] = PRIMARY;
  process.env['GEMINI_FALLBACK_MODEL'] = BACKGROUND;
});

afterAll(() => {
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetConfig();
  resetLimitRegistry();
});

beforeEach(() => {
  for (const k of KEYS) {
    if (k === 'GEMINI_API_KEY' || k === 'GEMINI_MODEL' || k === 'GEMINI_FALLBACK_MODEL') continue;
    delete process.env[k];
  }
  resetConfig();
  resetLimitRegistry();
  resetQuotaState();
});

describe('decideRoute — Faz 2 (background)', () => {
  it('haiku istekleri background şeridine gider (Live, 2.5 native-audio)', () => {
    const r = decideRoute('claude-haiku-4-5-20251001', 3000);
    expect(r.lane).toBe('background');
    expect(r.model).toBe(BACKGROUND);
    expect(r.transport).toBe('live');
  });

  it('sonnet/opus istekleri quality şeridinde kalır', () => {
    expect(decideRoute('claude-sonnet-5', 3000).lane).toBe('quality');
    expect(decideRoute('claude-opus-4-8', 3000).lane).toBe('quality');
  });

  it('ROUTING=off → her şey quality (kill-switch, eski davranış)', () => {
    process.env['ROUTING'] = 'off';
    resetConfig();
    expect(decideRoute('claude-haiku-4-5-20251001', 3000).lane).toBe('quality');
    expect(decideRoute('claude-sonnet-5', 200_000).lane).toBe('quality');
  });
});

describe('decideRoute — Faz 3 (longcontext)', () => {
  it('eşik üstü istek longcontext REST şeridine gider', () => {
    const r = decideRoute('claude-sonnet-5', 60_000);
    expect(r.lane).toBe('longcontext');
    expect(r.model).toBe('gemini-3.1-flash-lite');
    expect(r.transport).toBe('rest');
  });

  it('eşik altı istek quality kalır', () => {
    expect(decideRoute('claude-sonnet-5', 49_000).lane).toBe('quality');
  });

  it('LANE_LONGCONTEXT_ENABLED=false → eşik üstü bile quality', () => {
    process.env['LANE_LONGCONTEXT_ENABLED'] = 'false';
    resetConfig();
    expect(decideRoute('claude-sonnet-5', 200_000).lane).toBe('quality');
  });

  it('RPD bütçesi dolunca longcontext kapanır → quality', () => {
    process.env['LONGCONTEXT_RPD_BUDGET'] = '2';
    resetConfig();
    const now = Date.UTC(2026, 6, 3, 12, 0, 0);
    recordUsage('gemini-3.1-flash-lite', 100, now);
    recordUsage('gemini-3.1-flash-lite', 100, now);
    expect(decideRoute('claude-sonnet-5', 60_000, now).lane).toBe('quality');
  });

  it('background isteği eşik üstü olsa bile background kalır (öncelik sırası)', () => {
    expect(decideRoute('claude-haiku-4-5-20251001', 60_000).lane).toBe('background');
  });
});

describe('decideRoute — Faz 4 (taşma + acil şerit)', () => {
  it('quality penceresi doluyken HAFİF tur background\'a taşar', () => {
    const now = 1_000_000;
    recordUsage(PRIMARY, 70_000, now); // 65K TPM borçta
    const r = decideRoute('claude-sonnet-5', 5_000, now + 1000);
    expect(r.lane).toBe('background');
    expect(r.reason).toContain('taşma');
  });

  it('quality penceresi doluyken AĞIR tur quality\'de KALIR (borçlandırma semantiği)', () => {
    const now = 1_000_000;
    recordUsage(PRIMARY, 70_000, now);
    const r = decideRoute('claude-sonnet-5', 30_000, now + 1000);
    expect(r.lane).toBe('quality');
  });

  it('background modeli blokeliyken + acil şerit tanımlıyken haiku isteği emergency\'ye gider', () => {
    process.env['LANE_EMERGENCY_MODEL'] = 'gemma-4-31b-it';
    resetConfig();
    const now = 1_000_000;
    blockModel(BACKGROUND, now + 60_000);
    const r = decideRoute('claude-haiku-4-5-20251001', 3000, now);
    expect(r.lane).toBe('emergency');
    expect(r.model).toBe('gemma-4-31b-it');
    expect(r.transport).toBe('rest');
  });

  it('acil şerit TANIMSIZKEN background blokeli haiku isteği quality yoluna düşer', () => {
    const now = 1_000_000;
    blockModel(BACKGROUND, now + 60_000);
    const r = decideRoute('claude-haiku-4-5-20251001', 3000, now);
    expect(r.lane).toBe('quality');
  });
});

describe('resolveLaneModel — attempt başına model çözümü', () => {
  it('quality: birincil sağlıklıysa birincil, blokeliyse fallback (LIVE-19 korunur)', () => {
    const now = 1_000_000;
    expect(resolveLaneModel('quality', now)).toBe(PRIMARY);
    blockModel(PRIMARY, now + 60_000);
    expect(resolveLaneModel('quality', now)).toBe(BACKGROUND);
  });

  it('background: model sağlıklıysa background modeli', () => {
    expect(resolveLaneModel('background', 1_000_000)).toBe(BACKGROUND);
  });

  it('background: model blokeliyse quality çözümüne düşer', () => {
    const now = 1_000_000;
    blockModel(BACKGROUND, now + 60_000);
    expect(resolveLaneModel('background', now)).toBe(PRIMARY);
  });
});
