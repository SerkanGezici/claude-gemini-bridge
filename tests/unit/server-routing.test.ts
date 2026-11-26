// TD-005: server.ts auth hook (:144-167) + routing/validation kapsamı.
// Bugüne dek auth (401), /health muafiyeti, Bearer prefix ve istek-gövdesi
// validasyonu yalnız canlı E2E ile dolaylı doğrulanıyordu — err1/p3 testleri
// DAİMA doğru token + geçerli gövde gönderiyor (auth/validation FAIL yolları
// hiç görülmüyor). Bu suite gemini-client'ı mock'layıp (auth/validation 401/400
// gemini'ye ulaşmadan döner) startBridge + fetch ile bu yolları test eder.
//
// DUP YOK: stream-default (stream:true/false→SSE/JSON) → p3-stream-default.test,
// SSE error disiplini → err1-sse-error.test. Burada YALNIZ auth + validation +
// routing yüzeyi.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../../src/gemini-client.js', () => ({
  streamFromGemini: vi.fn(async (_req: unknown, cb: { onText: (t: string) => void; onTurnComplete: () => void }) => {
    cb.onText('OK');
    cb.onTurnComplete();
  }),
  sendToolResponse: vi.fn(),
  hasToolSession: vi.fn(() => false),
  retireToolSessionIfToolsChanged: vi.fn(() => false),
  isGemini3: vi.fn(() => true),
  resolveActiveModel: vi.fn(() => 'models/gemini-3.1-flash-live-preview'),
  markModelDegraded: vi.fn(),
}));

import { streamFromGemini } from '../../src/gemini-client.js';
import { resetConfig } from '../../src/config.js';
import { startBridge } from '../../src/server.js';

const TOKEN = 'routing-test-token';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'RETRY_ATTEMPTS', 'RETRY_BASE_DELAY', 'PORT', 'DEBUG', 'BRIDGE_TOKEN'];

let base = '';
let closeBridge: (() => Promise<void>) | null = null;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['GEMINI_MODEL'] = 'models/gemini-3.1-flash-live-preview';
  process.env['RETRY_ATTEMPTS'] = '2';
  process.env['RETRY_BASE_DELAY'] = '1';
  process.env['PORT'] = '0'; // işletim sistemi boş port atar (sabit port EADDRINUSE flake'i)
  process.env['BRIDGE_TOKEN'] = TOKEN;
  delete process.env['DEBUG'];
  resetConfig();
  const bridge = await startBridge();
  base = `http://127.0.0.1:${bridge.port}`;
  closeBridge = bridge.close;
});

afterAll(async () => {
  await closeBridge?.();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetConfig();
});

beforeEach(() => {
  (streamFromGemini as Mock).mockClear();
});

function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init);
}
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ── Auth hook (:144-167) ──────────────────────────────────────
describe('auth hook', () => {
  it('/health auth gerektirmez (token YOK → 200)', async () => {
    const res = await req('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; bridge: string };
    expect(body).toEqual({ status: 'ok', bridge: 'claude-gemini' });
  });

  it('Claude Code erişim yoklaması HEAD/GET /api/hello anahtarsız 200 (Auth failed uyarısı yok)', async () => {
    const head = await fetch(`${base}/api/hello`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    const get = await fetch(`${base}/api/hello`);
    expect(get.status).toBe(200);
    const post = await fetch(`${base}/api/hello`, { method: 'POST' });
    expect(post.status).toBe(401); // yalnız yoklama metotları açık
  });

  it('korunan endpoint token YOK → 401 authentication_error', async () => {
    const res = await req('/v1/models');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('authentication_error');
  });

  it('yanlış token → 401', async () => {
    const res = await req('/v1/models', { headers: { 'x-api-key': 'wrong-token' } });
    expect(res.status).toBe(401);
  });

  it('doğru x-api-key → 200', async () => {
    const res = await req('/v1/models', { headers: { 'x-api-key': TOKEN } });
    expect(res.status).toBe(200);
  });

  it('doğru Authorization: Bearer <token> → 200', async () => {
    const res = await req('/v1/models', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it('Bearer prefix case-insensitive ("bearer ...") → 200', async () => {
    const res = await req('/v1/models', { headers: { authorization: `bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it('boş x-api-key → 401 (boş token bypass yok)', async () => {
    const res = await req('/v1/models', { headers: { 'x-api-key': '' } });
    expect(res.status).toBe(401);
  });

  it('"Bearer " (prefix var ama token boş) → 401', async () => {
    const res = await req('/v1/models', { headers: { authorization: 'Bearer ' } });
    expect(res.status).toBe(401);
  });

  it('/v1/messages token YOK → 401, gemini ASLA çağrılmaz', async () => {
    const res = await req('/v1/messages', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }),
    });
    expect(res.status).toBe(401);
    expect(streamFromGemini as Mock).not.toHaveBeenCalled(); // auth, handler'dan önce keser
  });
});

// ── İstek gövdesi validasyonu (auth geçilmiş) ────────────────
describe('request validation', () => {
  function authedPost(path: string, body: unknown): Promise<Response> {
    return req(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
      body: JSON.stringify(body),
    });
  }

  it('/v1/messages model YOK → 400 invalid_request_error', async () => {
    const res = await authedPost('/v1/messages', { messages: [{ role: 'user', content: 'x' }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(streamFromGemini as Mock).not.toHaveBeenCalled();
  });

  it('/v1/messages boş messages[] → 400', async () => {
    const res = await authedPost('/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });
    expect(res.status).toBe(400);
  });

  it('/v1/messages messages eksik → 400', async () => {
    const res = await authedPost('/v1/messages', { model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(400);
  });

  it('/v1/messages yalnız system-role mesaj → turns boş → 400 (ikinci validation yolu, server.ts:262)', async () => {
    // toGeminiTurns system-role'leri atlar (transformer.ts:119) → turns boş kalır;
    // ilk validation (messages.length>0) geçer, ikinci 400 yolu tetiklenir.
    const res = await authedPost('/v1/messages', {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: 'hook metadata' }],
    });
    expect(res.status).toBe(400);
    expect(streamFromGemini as Mock).not.toHaveBeenCalled();
  });

  it('count_tokens messages[] yoksa → 400', async () => {
    const res = await authedPost('/v1/messages/count_tokens', { model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(400);
  });

  it('count_tokens geçerli istek → input_tokens > 0', async () => {
    const res = await authedPost('/v1/messages/count_tokens', {
      messages: [{ role: 'user', content: 'merhaba dünya' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number };
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it('count_tokens system metni input_tokens\'a eklenir', async () => {
    const msgs = [{ role: 'user', content: 'merhaba' }];
    const noSys = (await (await authedPost('/v1/messages/count_tokens', { messages: msgs })).json()) as { input_tokens: number };
    const withSys = (await (await authedPost('/v1/messages/count_tokens', {
      system: 'You are a very detailed security monitor that explains everything thoroughly.',
      messages: msgs,
    })).json()) as { input_tokens: number };
    expect(withSys.input_tokens).toBeGreaterThan(noSys.input_tokens);
  });
});

// ── Routing ───────────────────────────────────────────────────
describe('routing', () => {
  it('GET /v1/models → güncel 4 Claude modeli döner (Claude Code model sorgusu)', async () => {
    const res = await req('/v1/models', { headers: { 'x-api-key': TOKEN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string; object: string }> };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-2',
    ]);
    expect(body.data.every((m) => m.object === 'model')).toBe(true);
  });
});

describe('ERRLOG-1 beklenmeyen istisna', () => {
  it('işleyicide fırlayan hata Anthropic hata biçiminde döner ve bridge.log\'a yazılır', async () => {
    const { logger } = await import('../../src/logger.js');
    const spy = vi.spyOn(logger, 'error');
    // Araç listesinde null → araç dönüştürücüsü stream başlamadan istisna atar.
    const res = await req('/v1/messages', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'x-api-key': TOKEN },
      body: JSON.stringify({
        model: 'claude-opus-5-5', max_tokens: 10,
        messages: [{ role: 'user', content: 'merhaba' }],
        tools: [null],
      }),
    });
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(body.type).toBe('error');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('İstek işlenemedi: POST /v1/messages'))).toBe(true);
    spy.mockRestore();
  });
});
