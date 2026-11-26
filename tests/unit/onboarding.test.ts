// İlk-çalıştırma onboarding'i: API key doğrulama + sınıflama + .env upsert.
// models.list fetch'i mock'lanır (gerçek API'ye GİTMEZ).
import { describe, it, expect, vi } from 'vitest';

import { classifyKeyError, upsertEnvVar, validateApiKey, trySavedKeyFallback } from '../../src/onboarding.js';

// models.list cevabını taklit eden sahte fetch (gerçek API'ye GİTMEZ).
function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('classifyKeyError', () => {
  it('geçersiz/pasif key → invalid', () => {
    expect(classifyKeyError(new Error('API key not valid. Please pass a valid API key.'))).toBe('invalid');
    expect(classifyKeyError({ status: 403, message: 'PERMISSION_DENIED' })).toBe('invalid');
    expect(classifyKeyError({ status: 400, message: 'API_KEY_INVALID' })).toBe('invalid');
  });

  it('kota dolu → quota', () => {
    expect(classifyKeyError(new Error('429 RESOURCE_EXHAUSTED: quota exceeded'))).toBe('quota');
    expect(classifyKeyError({ status: 429, message: 'rate limit' })).toBe('quota');
  });

  it('ağ hatası → network', () => {
    expect(classifyKeyError(new Error('fetch failed'))).toBe('network');
    expect(classifyKeyError(new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com'))).toBe('network');
    expect(classifyKeyError(new Error('validation timed out'))).toBe('network');
  });

  it('tanınmayan → unknown', () => {
    expect(classifyKeyError(new Error('something unexpected'))).toBe('unknown');
  });
});

describe('upsertEnvVar', () => {
  it('boş içeriğe satır ekler', () => {
    expect(upsertEnvVar('', 'GEMINI_API_KEY', 'abc')).toBe('GEMINI_API_KEY=abc\n');
  });

  it('mevcut anahtarı değiştirir, diğer satırları korur', () => {
    const before = 'PORT=8002\nGEMINI_API_KEY=old\nDEBUG=false\n';
    const after = upsertEnvVar(before, 'GEMINI_API_KEY', 'new');
    expect(after).toContain('GEMINI_API_KEY=new');
    expect(after).not.toContain('old');
    expect(after).toContain('PORT=8002');
    expect(after).toContain('DEBUG=false');
  });

  it('anahtar yoksa diğerlerini koruyup ekler', () => {
    const after = upsertEnvVar('PORT=8002\n', 'GEMINI_API_KEY', 'abc');
    expect(after).toContain('PORT=8002');
    expect(after).toContain('GEMINI_API_KEY=abc');
  });
});

describe('validateApiKey (models.list — gerçek API yok)', () => {
  it('başarılı listeleme → ok/valid', async () => {
    expect(await validateApiKey('k', fakeFetch(200, { models: [] }))).toEqual({ ok: true, reason: 'valid' });
  });

  it('geçersiz key (400 API key not valid) → ok:false/invalid', async () => {
    const r = await validateApiKey('k', fakeFetch(400, {
      error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' },
    }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid');
    expect(r.detail).toMatch(/API key not valid/);
  });

  it('kota hatası (429) → quota (akışta key geçerli sayılır)', async () => {
    expect((await validateApiKey('k', fakeFetch(429, { error: { status: 'RESOURCE_EXHAUSTED' } }))).reason).toBe('quota');
  });

  it('ağ hatası → network', async () => {
    const f = vi.fn().mockRejectedValue(new Error('fetch failed')) as unknown as typeof fetch;
    expect((await validateApiKey('k', f)).reason).toBe('network');
  });

  it('timeout (AbortSignal) → network', async () => {
    const f = vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout')) as unknown as typeof fetch;
    expect((await validateApiKey('k', f)).reason).toBe('network');
  });

  it('REGRESYON: bir modelin yeni kullanıcılara kapanması key doğrulamasını BOZMAZ', async () => {
    // Eski doğrulama gemini-2.5-flash'a generateContent atıyordu; Google bu modeli
    // yeni projelere kapatınca (404) her geçerli yeni key reddediliyordu.
    // models.list hiçbir modele bağlı değil → geçerli key = valid.
    const f = fakeFetch(200, { models: [{ name: 'models/gemini-3.8-live', supportedGenerationMethods: ['bidiGenerateContent'] }] });
    expect(await validateApiKey('AQ.new-format-key', f)).toEqual({ ok: true, reason: 'valid' });
  });

  it('ASLA throw etmez', async () => {
    const f = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    await expect(validateApiKey('k', f)).resolves.toBeDefined();
  });
});

describe('trySavedKeyFallback (kabuktaki key geçersiz, kayıtlı key geçerli)', () => {
  const ok = async () => ({ ok: true, reason: 'valid' as const });
  const bad = async () => ({ ok: false, reason: 'invalid' as const });

  it('kayıtlı key farklı ve geçerliyse onu döndürür', async () => {
    const r = await trySavedKeyFallback('SHELL-BAD', 'X=1\nGEMINI_API_KEY=SAVED-GOOD\n', ok);
    expect(r).toBe('SAVED-GOOD');
  });
  it('kayıtlı key de geçersizse null', async () => {
    expect(await trySavedKeyFallback('SHELL-BAD', 'GEMINI_API_KEY=SAVED-BAD', bad)).toBeNull();
  });
  it('kayıtlı key kabuktakiyle aynıysa yeniden denemez', async () => {
    const v = vi.fn(ok);
    expect(await trySavedKeyFallback('SAME', 'GEMINI_API_KEY=SAME', v)).toBeNull();
    expect(v).not.toHaveBeenCalled();
  });
  it('kayıtlı dosya yok/boşsa null', async () => {
    expect(await trySavedKeyFallback('SHELL-BAD', '', ok)).toBeNull();
  });
  it('tırnaklı ve CRLF değeri temizler', async () => {
    expect(await trySavedKeyFallback('SHELL-BAD', 'GEMINI_API_KEY="SAVED-GOOD"\r\n', ok)).toBe('SAVED-GOOD');
  });
});
