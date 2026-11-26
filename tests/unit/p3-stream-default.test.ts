// P-3 regresyon testi — stream alanı OLMAYAN istek JSON döner (SSE değil).
// Anthropic spec: stream default'u false. Eski davranış default'u streaming'di;
// auto-mode güvenlik sınıflandırıcısı (claude-opus-4-8, stream'siz) SSE alınca
// CLI "opus unavailable" sayıp Bash'i blokluyordu (2026-06-12 canlı E2E kanıtı:
// Gemini "ALLOW" demişti ama zarf SSE olduğu için verdict CLI'a ulaşamadı).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../../src/gemini-client.js', () => ({
  streamFromGemini: vi.fn(),
  sendToolResponse: vi.fn(),
  hasToolSession: vi.fn(() => false),
  retireToolSessionIfToolsChanged: vi.fn(() => false),
  isGemini3: vi.fn(() => true),
  resolveActiveModel: vi.fn(() => 'models/gemini-3.1-flash-live-preview'),
}));

import { streamFromGemini } from '../../src/gemini-client.js';
import { resetConfig } from '../../src/config.js';
import { startBridge } from '../../src/server.js';

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
  process.env['BRIDGE_TOKEN'] = 'p3-test-token';
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
  (streamFromGemini as Mock).mockReset();
  (streamFromGemini as Mock).mockImplementation(
    async (_req: unknown, cb: { onText: (t: string) => void; onTurnComplete: () => void }) => {
      cb.onText('ALLOW');
      cb.onTurnComplete();
    },
  );
});

async function post(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'p3-test-token' },
    body: JSON.stringify(body),
  });
}

const CLASSIFIER_STYLE_BODY = {
  // Sınıflandırıcı isteğinin birebir şekli: stream alanı YOK, tool yok, kısa.
  model: 'claude-opus-4-8',
  max_tokens: 64,
  system: 'You are a security monitor.',
  messages: [{ role: 'user', content: 'Bash node x.js — verdict?' }],
};

describe('P-3: stream default davranışı (Anthropic spec: false)', () => {
  it('stream alanı YOK → tek JSON message döner (SSE DEĞİL)', async () => {
    const res = await post(CLASSIFIER_STYLE_BODY);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = (await res.json()) as { type: string; content: Array<{ type: string; text?: string }> };
    expect(json.type).toBe('message');
    expect(json.content[0]?.text).toBe('ALLOW'); // verdict zarfı bozulmadan ulaşır
  });

  it('stream:false → JSON döner (mevcut davranış korunur)', async () => {
    const res = await post({ ...CLASSIFIER_STYLE_BODY, stream: false });
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = (await res.json()) as { type: string };
    expect(json.type).toBe('message');
  });

  it('stream:true → SSE döner (ana akış regresyonu yok)', async () => {
    const res = await post({ ...CLASSIFIER_STYLE_BODY, stream: true });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('message_start');
    expect(text).toContain('message_stop');
  });
});
