// REST-SIG-1: longcontext şerit modeli meşgulse (503/429) yedek REST modeli
// denenir; hepsi düşerse Live'a dönülür.
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

vi.mock('../../src/rest-lane.js', async (orig) => {
  const real = await orig<typeof import('../../src/rest-lane.js')>();
  return { ...real, runRestTurn: vi.fn() };
});

import { streamFromGemini } from '../../src/gemini-client.js';
import { runRestTurn, RestLaneUnavailable } from '../../src/rest-lane.js';
import { resetConfig } from '../../src/config.js';
import { startBridge } from '../../src/server.js';

const ENV: Record<string, string> = {
  GEMINI_API_KEY: 'test-key', PORT: '8029', BRIDGE_TOKEN: 'rf-token',
  LONGCONTEXT_THRESHOLD_TOKENS: '10', LANE_LONGCONTEXT_MODEL: 'gemini-3.1-flash-lite',
  LANE_LONGCONTEXT_FALLBACK_MODELS: 'gemini-3.5-flash-lite', REVIEW: 'off', RETRY_BASE_DELAY: '1',
};
const saved: Record<string, string | undefined> = {};
let base = '';
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  saved['DEBUG'] = process.env['DEBUG']; delete process.env['DEBUG'];
  resetConfig();
  const b = await startBridge();
  base = `http://127.0.0.1:${b.port}`;
  close = b.close;
}, 30_000);

afterAll(async () => {
  await close?.();
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetConfig();
});

beforeEach(() => { (runRestTurn as Mock).mockReset(); (streamFromGemini as Mock).mockReset(); });

async function ask(): Promise<{ status: number; body: { content?: Array<{ text?: string }> } }> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'rf-token' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'uzun bir soru '.repeat(20) }] }),
  });
  return { status: res.status, body: await res.json() as { content?: Array<{ text?: string }> } };
}

describe('REST-SIG-1 longcontext yedek modeli', () => {
  it('ilk model 503 verirse yedek REST modeli cevaplar, Live çağrılmaz', async () => {
    (runRestTurn as Mock).mockImplementation(async (p: { model: string }) => {
      if (p.model === 'gemini-3.1-flash-lite') throw new RestLaneUnavailable('503 high demand');
      return { text: `cevap:${p.model}`, toolCalls: [] };
    });
    const r = await ask();
    expect(r.status).toBe(200);
    expect(r.body.content?.[0]?.text).toBe('cevap:gemini-3.5-flash-lite');
    expect((runRestTurn as Mock).mock.calls.map((c) => c[0].model)).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
    expect(streamFromGemini).not.toHaveBeenCalled();
  });

  it('tüm REST modelleri düşerse Live yoluna dönülür', async () => {
    (runRestTurn as Mock).mockRejectedValue(new RestLaneUnavailable('429'));
    (streamFromGemini as Mock).mockImplementation(async (_p: unknown, cb: { onText: (t: string) => void; onTurnComplete: () => void }) => {
      cb.onText('live cevap'); cb.onTurnComplete();
    });
    const r = await ask();
    expect(r.status).toBe(200);
    expect((runRestTurn as Mock).mock.calls.length).toBe(2);
    expect(streamFromGemini).toHaveBeenCalled();
  });
});
