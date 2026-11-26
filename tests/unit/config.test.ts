import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { loadConfig, resetConfig } from '../../src/config.js';

const savedEnv: Record<string, string | undefined> = {};
const KEYS = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_SEARCH_MODEL', 'HOST', 'PORT', 'BRIDGE_TOKEN', 'RETRY_ATTEMPTS'];
for (const k of KEYS) savedEnv[k] = process.env[k];

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env['GEMINI_API_KEY'] = 'test-key';
  resetConfig();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
});

describe('loadConfig', () => {
  it('varsayılan model preview-12-2025 (manifesto §3.1, -latest YOK)', () => {
    expect(loadConfig().geminiModel).toBe('models/gemini-2.5-flash-native-audio-preview-12-2025');
  });

  it('"-latest" alias artık REDDEDİLMEZ (DOC-LATEST-1: canlı probe 2026-07-03 — 2.5-native-audio-latest Live\'da ÇALIŞTI; gerçek doğrulama DISCOVER-1 models.list)', () => {
    process.env['GEMINI_MODEL'] = 'models/gemini-2.5-flash-native-audio-latest';
    expect(loadConfig().geminiModel).toBe('models/gemini-2.5-flash-native-audio-latest');
  });

  it('GEMINI_API_KEY yoksa açıklayıcı hata fırlatır', () => {
    delete process.env['GEMINI_API_KEY'];
    expect(() => loadConfig()).toThrow(/GEMINI_API_KEY/);
  });

  it('HOST sadece loopback olabilir — 0.0.0.0 güvenlik riski', () => {
    process.env['HOST'] = '0.0.0.0';
    expect(() => loadConfig()).toThrow(/security risk/);
  });

  it('BRIDGE_TOKEN verilmezse rastgele üretilir, verilirse kullanılır', () => {
    const a = loadConfig().bridgeToken;
    expect(a.length).toBeGreaterThan(10);
    resetConfig();
    process.env['BRIDGE_TOKEN'] = 'sabit-token';
    expect(loadConfig().bridgeToken).toBe('sabit-token');
  });

  it('boş/whitespace BRIDGE_TOKEN rastgele üretilir (boş token auth-bypass regression)', () => {
    // trim() → '' → falsy → randomUUID fallback. Boş token ASLA aktif token olamaz;
    // aksi halde auth hook'ta boş-token-eşleşmesi (server.ts:161) bypass açardı.
    process.env['BRIDGE_TOKEN'] = '   ';
    const token = loadConfig().bridgeToken;
    expect(token.length).toBeGreaterThan(10);
    expect(token.trim()).not.toBe('');
  });

  it('geçersiz integer env açık hata verir', () => {
    process.env['PORT'] = 'abc';
    expect(() => loadConfig()).toThrow(/PORT/);
  });

  it('portExplicit alanı boolean (PORT-1: paralel instance port fallback kararı)', () => {
    // Not: portExplicit module-yükleme zamanında (dotenv öncesi) belirlenir;
    // CLI-PORT vs .env-PORT ayrımı runtime'da yapılır. Test ortamı CLI-PORT'suz
    // → false. CLI'da PORT verme senaryosu canlı E2E ile kanıtlı (PORT-1 arşiv).
    expect(typeof loadConfig().portExplicit).toBe('boolean');
  });

  // LIVE-SEARCH-1: web_search REST grounding modeli
  it('geminiSearchModel varsayılan gemini-2.5-flash', () => {
    expect(loadConfig().geminiSearchModel).toBe('gemini-2.5-flash');
  });

  it('GEMINI_SEARCH_MODEL env override edilir', () => {
    process.env['GEMINI_SEARCH_MODEL'] = 'gemini-2.0-flash';
    expect(loadConfig().geminiSearchModel).toBe('gemini-2.0-flash');
  });

  it('geminiSearchModel "-latest" kabul eder (REST modeli)', () => {
    process.env['GEMINI_SEARCH_MODEL'] = 'gemini-flash-latest';
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().geminiSearchModel).toBe('gemini-flash-latest');
  });
});

describe('TD-008 bridgeTokenGenerated', () => {
  it('BRIDGE_TOKEN yoksa rastgele anahtar + işaret; varsa işaret yok', () => {
    const c = loadConfig();
    expect(c.bridgeTokenGenerated).toBe(true);
    expect(c.bridgeToken).toMatch(/^[0-9a-f-]{36}$/);
    process.env['BRIDGE_TOKEN'] = 'sabit';
    resetConfig();
    const d = loadConfig();
    expect(d.bridgeTokenGenerated).toBe(false);
    expect(d.bridgeToken).toBe('sabit');
  });
});
