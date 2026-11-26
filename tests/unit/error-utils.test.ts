import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sanitizeErrorForClient, mapErrorToAnthropicStatus, withRetry, isTransientError, jitteredDelay } from '../../src/error-utils.js';
import { resetConfig } from '../../src/config.js';

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ['GEMINI_API_KEY', 'RETRY_ATTEMPTS', 'RETRY_BASE_DELAY', 'GEMINI_MODEL']) {
    savedEnv[k] = process.env[k];
  }
  process.env['GEMINI_API_KEY'] = process.env['GEMINI_API_KEY'] || 'test-key';
  process.env['GEMINI_MODEL'] = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
  process.env['RETRY_ATTEMPTS'] = '3';
  process.env['RETRY_BASE_DELAY'] = '1'; // test hızı
  resetConfig();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
});

describe('sanitizeErrorForClient', () => {
  it('URL query içindeki API key redact edilir', () => {
    const out = sanitizeErrorForClient('connect failed: wss://x.com/ws?key=AIzaSyABC123');
    expect(out).not.toContain('AIzaSy');
    expect(out).toContain('REDACTED');
  });

  it('çıplak AIza key redact edilir', () => {
    const out = sanitizeErrorForClient(`token AIza${'B'.repeat(35)} geçersiz`);
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain('AIzaB');
  });
});

describe('mapErrorToAnthropicStatus', () => {
  const cases: Array<[string, number, string]> = [
    ['invalid api key', 401, 'authentication_error'],
    ['rate limit exceeded', 429, 'rate_limit_error'],
    ['quota exceeded', 429, 'rate_limit_error'],
    ['payload too large', 413, 'request_too_large'],
    ['Gemini timeout', 408, 'timeout_error'],
    ['websocket connection refused', 502, 'api_connection_error'],
    ['bilinmeyen garip hata', 500, 'api_error'],
    // TD-021: alt-dizgi yanlış pozitifleri
    ['Tool shows no news', 500, 'api_error'],              // "ws" kelime değil
    ['invalid token in tool output', 500, 'api_error'],    // tek başına "token" 413 değil
    ['missing context for request', 500, 'api_error'],     // tek başına "context" 413 değil
    ['code 4011 unexpected', 500, 'api_error'],            // 401 sınırı
    ['request timed out after 120000ms', 408, 'timeout_error'],
    ['Gemini closed: 1011 You exceeded', 429, 'rate_limit_error'],
    ['ws closed: 1006', 502, 'api_connection_error'],
    ['input exceeds maximum context length', 413, 'request_too_large'],
  ];
  for (const [msg, status, type] of cases) {
    it(`"${msg}" → ${status} ${type}`, () => {
      expect(mapErrorToAnthropicStatus(new Error(msg))).toEqual({ status, type });
    });
  }
});

describe('withRetry', () => {
  it('geçici hata sonrası başarıyı döner', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error('Gemini empty turn');
      return 'tamam';
    });
    expect(result).toBe('tamam');
    expect(attempts).toBe(3);
  });

  it('fn\'e attempt index\'ini geçirir (0,1,2) — empty-turn nudge bunu kullanır', async () => {
    const seen: number[] = [];
    await withRetry(async (attempt) => {
      seen.push(attempt);
      if (seen.length < 3) throw new Error('Gemini empty turn');
      return 'ok';
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it('noRetry bayraklı hata ANINDA fırlatılır', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw Object.assign(new Error('partial data sent'), { noRetry: true });
      }),
    ).rejects.toThrow('partial data sent');
    expect(attempts).toBe(1);
  });

  it('auth hatası retry edilmez', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('401 authentication failed');
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it('tüm denemeler tükendiğinde son hata fırlatılır', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('geçici ağ hatası');
      }),
    ).rejects.toThrow('geçici ağ hatası');
    expect(attempts).toBe(3);
  });
});

// ── RETRY-1: transient sınıflandırıcı + jitter + transientOnly modu ──

describe('isTransientError (RETRY-1)', () => {
  const transient = [
    '502 Bad Gateway',
    '503 Service Unavailable',
    '500 internal error',
    '504 gateway timeout',
    'connect ECONNREFUSED 142.250.1.1:443',
    'read ECONNRESET',
    'getaddrinfo EAI_AGAIN generativelanguage.googleapis.com', // WSL DNS canlı kanıtı (2026-06-11)
    'connect ETIMEDOUT 216.58.1.1:443',
    'socket hang up',
    'Gemini closed: 1006 abnormal closure',
    'network error',
    'UNAVAILABLE: the service is currently unavailable',
  ];
  for (const msg of transient) {
    it(`"${msg}" → transient (retry edilebilir)`, () => {
      expect(isTransientError(msg)).toBe(true);
    });
  }

  const nonTransient = [
    'quota exceeded', // LIVE-19'un işi — reconnect'te retry çift-bekleme olur
    'Gemini closed: 1011 RESOURCE_EXHAUSTED',
    '401 authentication failed',
    'api key not valid',
    'Gemini closed: 1007 request contains an invalid argument',
    'Gemini closed: 1008 model not found',
    'Gemini timeout',
  ];
  for (const msg of nonTransient) {
    it(`"${msg}" → transient DEĞİL`, () => {
      expect(isTransientError(msg)).toBe(false);
    });
  }
});

describe('jitteredDelay (RETRY-1)', () => {
  it('değerler [ms/2, ms] aralığında kalır (equal jitter)', () => {
    for (let i = 0; i < 200; i++) {
      const d = jitteredDelay(1000);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });

  it('rastgeledir — 200 örnek tek değere çakılmaz', () => {
    const values = new Set(Array.from({ length: 200 }, () => jitteredDelay(1000)));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('withRetry transientOnly (RETRY-1 — reconnect yolu)', () => {
  it('transient hata retry edilir, başarı döner', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 2) throw new Error('read ECONNRESET');
      return 'ok';
    }, { transientOnly: true });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('kota hatası ANINDA fırlatılır — LIVE-19 cooldown ile çift-bekleme olmaz', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('Gemini closed: 1011 quota exceeded');
      }, { transientOnly: true }),
    ).rejects.toThrow('1011');
    expect(attempts).toBe(1);
  });

  it('varsayılan mod DEĞİŞMEZ: kota hatası retry edilmeye devam eder (LIVE-19 fallback sonraki attempt)', async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error('quota exceeded');
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(3);
  });
});
