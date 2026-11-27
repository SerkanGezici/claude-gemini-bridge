// REVIEW-REPLAY-1: oturumu kapanmış araç devamı (full replay) yolunda da son cevap denetlenir.
// Skill taramasında sales:* skill'leri hiç arama yapmadan "web araması yapıldı" dedi; denetçi
// yalnız açık oturum yolunda çalıştığı için yakalanmadı.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../../src/gemini-client.js', () => ({
  streamFromGemini: vi.fn(),
  sendToolResponse: vi.fn(),
  hasToolSession: vi.fn(() => false),
  retireToolSessionIfToolsChanged: vi.fn(() => false),
  isGemini3: vi.fn(() => true),
  resolveActiveModel: vi.fn(() => 'models/gemini-3.1-flash-live-preview'),
  markModelDegraded: vi.fn(),
}));

import { streamFromGemini, sendToolResponse, hasToolSession } from '../../src/gemini-client.js';
import { resetConfig } from '../../src/config.js';
import { startBridge } from '../../src/server.js';

const TOKEN = 'replay-review-token';
const ENV_KEYS = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'RETRY_ATTEMPTS', 'RETRY_BASE_DELAY', 'PORT', 'BRIDGE_TOKEN', 'REVIEW'];
const saved: Record<string, string | undefined> = {};
let base = '';
let close: (() => Promise<void>) | null = null;

type Cb = { onText: (t: string) => void; onToolCall: (c: unknown[]) => void; onTurnComplete: () => void };

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'models/gemini-3.1-flash-live-preview',
    RETRY_ATTEMPTS: '2', RETRY_BASE_DELAY: '1', PORT: '0', BRIDGE_TOKEN: TOKEN,
  });
  delete process.env['REVIEW'];
  resetConfig();
  const b = await startBridge();
  base = `http://127.0.0.1:${b.port}`;
  close = b.close;
});
afterAll(async () => {
  await close?.();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetConfig();
});
beforeEach(() => {
  (streamFromGemini as Mock).mockReset();
  (sendToolResponse as Mock).mockReset();
  (hasToolSession as Mock).mockReturnValue(false);
});

const body = {
  model: 'claude-sonnet-4-6', stream: true, max_tokens: 1000,
  tools: [{ name: 'WebSearch', description: 'search', input_schema: { type: 'object', properties: { query: { type: 'string' } } } }],
  messages: [
    { role: 'user', content: 'Skill aracıyla `sales:forecast` skill\'ini yükle ve uygula' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Skill', input: { skill: 'sales:forecast' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'Launching skill: sales:forecast' }] },
  ],
};

async function post(): Promise<string> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN }, body: JSON.stringify(body),
  });
  return res.text();
}

describe('REVIEW-REPLAY-1', () => {
  it('desteksiz "web araması yapıldı" taslağı akmaz; düzeltme turunun cevabı akar', async () => {
    (streamFromGemini as Mock)
      .mockImplementationOnce(async (_r: unknown, cb: Cb) => { cb.onText('Web araması yapıldı; arama sonuçlarına göre pazar %42 büyüdü.'); cb.onTurnComplete(); })
      .mockImplementationOnce(async (_r: unknown, cb: Cb) => { cb.onText('Arama yapmadım; bağlı veri yok, varsayımla tahmin: Q1 200k.'); cb.onTurnComplete(); });
    const sse = await post();
    expect(streamFromGemini).toHaveBeenCalledTimes(2);
    const second = (streamFromGemini as Mock).mock.calls[1]![0] as { turns: Array<{ parts: Array<{ text?: string }> }> };
    expect(JSON.stringify(second.turns)).toContain('EYLEM');
    expect(sse).toContain('Arama yapmad');
    expect(sse).not.toContain('%42');
  });

  it('model tool call yaparsa tampon akar, denetim turu açılmaz', async () => {
    (streamFromGemini as Mock).mockImplementationOnce(async (_r: unknown, cb: Cb) => {
      cb.onText('Arıyorum.');
      cb.onToolCall([{ id: 'g1', name: 'WebSearch', args: { query: 'pazar' } }]);
      cb.onTurnComplete();
    });
    const sse = await post();
    expect(streamFromGemini).toHaveBeenCalledTimes(1);
    expect(sse).toContain('WebSearch');
  });
});

// FILLER-FINAL-1: açık oturum yolunda araç sonucundan sonra yalnız "Let me check" ile biten tur.
describe('FILLER-FINAL-1', () => {
  it('dolgu taslak kullanıcıya gitmez; aynı oturuma düzeltme turu gider', async () => {
    (hasToolSession as Mock).mockReturnValue(true);
    let feedback = '';
    (sendToolResponse as Mock).mockImplementationOnce(async (_r: unknown, cb: Cb, opts?: { onHeld?: (h: unknown) => void }) => {
      cb.onText('Let me check');
      opts?.onHeld?.({
        release: () => {},
        followUp: async (fb: string, c: Cb) => { feedback = fb; c.onText('Poster hazır: poster.png (800x1000).'); },
      });
      cb.onTurnComplete();
    });
    const sse = await post();
    expect(feedback).toMatch(/EYLEM: .*dolgu/);
    expect(sse).toContain('Poster hazır');
    expect(sse).not.toContain('Let me check');
  });
});

// FAKE-TOOL-2: açık oturum yolunda metin olarak yazılmış "[tool_use: …]" gerçek tool_use olur.
describe('FAKE-TOOL-2', () => {
  it('bilinen araç notasyonu tool_use olarak akar, düz metin olarak değil', async () => {
    (hasToolSession as Mock).mockReturnValue(true);
    (sendToolResponse as Mock).mockImplementationOnce(async (_r: unknown, cb: Cb, opts?: { onHeld?: (h: unknown) => void }) => {
      cb.onText('[tool_use: WebSearch args={"query":"müşteri şikayetleri"}]');
      opts?.onHeld?.({ release: () => {}, followUp: async () => {} });
      cb.onTurnComplete();
    });
    const sse = await post();
    expect(sse).toContain('"type":"tool_use"');
    expect(sse).toContain('müşteri şikayetleri');
    expect(sse).not.toContain('[tool_use:');
  });
});

describe('FAKE-TOOL-2 replay düzeltme turu', () => {
  it('düzeltme turunun "[tool_use: …]" metni gerçek tool_use olur', async () => {
    (streamFromGemini as Mock)
      .mockImplementationOnce(async (_r: unknown, cb: Cb) => { cb.onText('Web araması yapıldı; arama sonuçlarına göre pazar büyüdü.'); cb.onTurnComplete(); })
      .mockImplementationOnce(async (_r: unknown, cb: Cb) => { cb.onText('[tool_use: WebSearch args={"query":"pazar 2026"}]'); cb.onTurnComplete(); });
    const sse = await post();
    expect(sse).toContain('"type":"tool_use"');
    expect(sse).toContain('pazar 2026');
    expect(sse).not.toContain('[tool_use:');
  });
});
