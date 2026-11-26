// DISCOVER-1: açılışta models.list doğrulaması — config'teki modeller bu key'de
// gerçekten var mı + gereken metodu destekliyor mu? Kanıt zemini:
// PLANS/archive/MODEL-MATRIX-PROBE-2026-07-03.md (54 model, canlı probe).
import { describe, it, expect } from 'vitest';
import {
  normalizeModelName,
  validateConfiguredModels,
  fetchAvailableModels,
  type DiscoveredModel,
  type ModelRequirement,
} from '../../src/model-discovery.js';

const AVAILABLE: DiscoveredModel[] = [
  { name: 'models/gemini-3.1-flash-live-preview', methods: ['bidiGenerateContent'], inputTokenLimit: 131072, outputTokenLimit: 65536 },
  { name: 'models/gemini-2.5-flash-native-audio-preview-12-2025', methods: ['countTokens', 'bidiGenerateContent'], inputTokenLimit: 131072, outputTokenLimit: 8192 },
  { name: 'models/gemini-2.5-flash', methods: ['generateContent', 'countTokens'], inputTokenLimit: 1048576, outputTokenLimit: 65536 },
  { name: 'models/gemini-3.1-flash-lite', methods: ['generateContent', 'countTokens'], inputTokenLimit: 1048576, outputTokenLimit: 65536 },
];

describe('normalizeModelName', () => {
  it('models/ önekini atar', () => {
    expect(normalizeModelName('models/gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
  it('öneksiz adı aynen bırakır', () => {
    expect(normalizeModelName('gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
});

describe('validateConfiguredModels', () => {
  it('geçerli konfigürasyonda problem dönmez', () => {
    const reqs: ModelRequirement[] = [
      { envName: 'GEMINI_MODEL', model: 'models/gemini-3.1-flash-live-preview', method: 'bidiGenerateContent' },
      { envName: 'GEMINI_SEARCH_MODEL', model: 'gemini-2.5-flash', method: 'generateContent' },
    ];
    const r = validateConfiguredModels(AVAILABLE, reqs);
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('models/ öneki farkına takılmaz (iki yönde de)', () => {
    const reqs: ModelRequirement[] = [
      { envName: 'GEMINI_SEARCH_MODEL', model: 'models/gemini-2.5-flash', method: 'generateContent' },
      { envName: 'LANE_LONGCONTEXT_MODEL', model: 'gemini-3.1-flash-lite', method: 'generateContent' },
    ];
    expect(validateConfiguredModels(AVAILABLE, reqs).ok).toBe(true);
  });

  it('key\'de olmayan model problem üretir ve aynı metodu destekleyen adaylar önerilir', () => {
    const reqs: ModelRequirement[] = [
      { envName: 'GEMINI_MODEL', model: 'models/gemini-9.9-hayal', method: 'bidiGenerateContent' },
    ];
    const r = validateConfiguredModels(AVAILABLE, reqs);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain('GEMINI_MODEL');
    expect(r.problems[0]).toContain('gemini-9.9-hayal');
    // Öneriler: bidi destekleyen modeller listelenmeli
    expect(r.problems[0]).toContain('gemini-3.1-flash-live-preview');
  });

  it('var olan ama yanlış metodlu model problem üretir (Live model REST işine koşulamaz)', () => {
    const reqs: ModelRequirement[] = [
      { envName: 'GEMINI_SEARCH_MODEL', model: 'gemini-3.1-flash-live-preview', method: 'generateContent' },
    ];
    const r = validateConfiguredModels(AVAILABLE, reqs);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('generateContent');
  });

  it("boş ve 'none' değerli gereksinimler atlanır", () => {
    const reqs: ModelRequirement[] = [
      { envName: 'GEMINI_FALLBACK_MODEL', model: 'none', method: 'bidiGenerateContent' },
      { envName: 'LANE_EMERGENCY_MODEL', model: '', method: 'generateContent' },
    ];
    expect(validateConfiguredModels(AVAILABLE, reqs).ok).toBe(true);
  });
});

describe('buildModelRequirements — ROUTING kill-switch (review P1-1)', () => {
  const CFG = {
    geminiModel: 'models/gemini-3.1-flash-live-preview',
    geminiFallbackModel: 'none',
    geminiSearchModel: 'gemini-2.5-flash',
    laneBackgroundModel: 'models/olmayan-lane-modeli',
    laneLongContextModel: 'olmayan-rest-modeli',
    laneLongContextEnabled: true,
    laneEmergencyModel: '',
  };

  it('ROUTING=off → lane modelleri doğrulanMAZ (bridge açılışı bloklanmaz)', async () => {
    const { buildModelRequirements } = await import('../../src/model-discovery.js');
    const reqs = buildModelRequirements({ ...CFG, routingEnabled: false });
    expect(reqs.map((r) => r.envName)).toEqual([
      'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL', 'GEMINI_SEARCH_MODEL',
    ]);
  });

  it('ROUTING=on → lane modelleri de doğrulanır', async () => {
    const { buildModelRequirements } = await import('../../src/model-discovery.js');
    const reqs = buildModelRequirements({ ...CFG, routingEnabled: true });
    expect(reqs.map((r) => r.envName)).toContain('LANE_BACKGROUND_MODEL');
    expect(reqs.map((r) => r.envName)).toContain('LANE_LONGCONTEXT_MODEL');
  });
});

describe('fetchAvailableModels', () => {
  it('models.list yanıtını DiscoveredModel listesine çevirir', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/x', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 10, outputTokenLimit: 5 },
          { name: 'models/y' }, // metod alanı eksik olabilir
        ],
      }),
    })) as unknown as typeof fetch;
    const models = await fetchAvailableModels('test-key', fakeFetch);
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ name: 'models/x', methods: ['generateContent'], inputTokenLimit: 10, outputTokenLimit: 5 });
    expect(models[1].methods).toEqual([]);
  });

  it('HTTP hatasında throw eder (caller fail-open karar verir)', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'forbidden' } }),
    })) as unknown as typeof fetch;
    await expect(fetchAvailableModels('bad-key', fakeFetch)).rejects.toThrow(/403/);
  });
});
