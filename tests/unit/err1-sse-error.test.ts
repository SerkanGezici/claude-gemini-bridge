// ERR-1 regresyon testi — SSE error event disiplini.
// Kural: attempt-içi (retry edilecek) hatalar client'a YAZILMAZ, sadece loglanır.
// error event yalnız NİHAİ başarısızlıkta ve TAM BİR KEZ yazılır.
// Kanıt: 2026-06-11 canlı oturum — retry attempt'lerinde yazılan error event'ler
// stream'i kirletti, Claude Code isteği "malformed (HTTP 200)" saydı.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';

vi.mock('../../src/gemini-client.js', () => ({
  streamFromGemini: vi.fn(),
  sendToolResponse: vi.fn(),
  hasToolSession: vi.fn(() => true),
  retireToolSessionIfToolsChanged: vi.fn(() => false),
  isGemini3: vi.fn(() => true),
  resolveActiveModel: vi.fn(() => 'models/gemini-3.1-flash-live-preview'),
}));

import { streamFromGemini, sendToolResponse } from '../../src/gemini-client.js';
import { resetConfig } from '../../src/config.js';
import { startBridge } from '../../src/server.js';

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'RETRY_ATTEMPTS', 'RETRY_BASE_DELAY', 'PORT', 'DEBUG', 'BRIDGE_TOKEN'];

let base = '';
let closeBridge: (() => Promise<void>) | null = null;

// finishRequest (gemini-client.ts) davranışının taklidi: hata yolunda
// ÖNCE callbacks.onError çağrılır, SONRA promise reject edilir.
function failLikeFinishRequest(cb: { onError: (e: Error) => void }, msg: string): never {
  const err = new Error(msg);
  cb.onError(err);
  throw err;
}

function countErrorEvents(sse: string): number {
  return (sse.match(/event: error/g) ?? []).length;
}

async function postMessages(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'err1-test-token' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['GEMINI_MODEL'] = 'models/gemini-3.1-flash-live-preview';
  process.env['RETRY_ATTEMPTS'] = '3';
  process.env['RETRY_BASE_DELAY'] = '1'; // test hızı
  process.env['PORT'] = '0'; // işletim sistemi boş port atar (sabit port EADDRINUSE flake'i)
  process.env['BRIDGE_TOKEN'] = 'err1-test-token';
  delete process.env['DEBUG']; // request dump'ları test sırasında kapalı
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
  (sendToolResponse as Mock).mockReset();
});

describe('ERR-1: attempt-içi hata SSE stream\'ini kirletmez', () => {
  it('retry sonrası başarı → stream\'de HİÇ error event yok, yanıt akar', async () => {
    let call = 0;
    (streamFromGemini as Mock).mockImplementation(async (_req: unknown, cb: { onError: (e: Error) => void; onText: (t: string) => void; onTurnComplete: () => void }) => {
      call++;
      if (call === 1) failLikeFinishRequest(cb, 'WebSocket closed: 1011 quota');
      cb.onText('Retry sonrası yanıt');
      cb.onTurnComplete();
    });

    const { status, text } = await postMessages({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'merhaba' }],
    });

    expect(status).toBe(200);
    expect(call).toBe(2); // 1 başarısız attempt + 1 başarılı
    expect(countErrorEvents(text)).toBe(0); // attempt hatası SIZMADI
    expect(text).toContain('Retry sonrası yanıt');
    expect(text).toContain('message_stop');
  });

  it('tüm attempt\'ler başarısız → TAM BİR error event (her attempt için değil)', async () => {
    (streamFromGemini as Mock).mockImplementation(async (_req: unknown, cb: { onError: (e: Error) => void }) => {
      failLikeFinishRequest(cb, 'WebSocket closed: 1011 quota');
    });

    const { text } = await postMessages({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'merhaba' }],
    });

    expect((streamFromGemini as Mock).mock.calls.length).toBe(3); // RETRY_ATTEMPTS
    expect(countErrorEvents(text)).toBe(1); // 3 attempt → yine de TEK error event
  });

  it('tool-response streaming hatası → TEK error event (onError+catch çift yazma regresyonu)', async () => {
    (sendToolResponse as Mock).mockImplementation(async (_responses: unknown, cb: { onError: (e: Error) => void }) => {
      failLikeFinishRequest(cb, 'Gemini session error');
    });

    const { text } = await postMessages({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      stream: true,
      tools: [{ name: 'Bash', description: 'komut çalıştır', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: 'dosyaları listele' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_err1_01', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_err1_01', content: 'a.txt' }] },
      ],
    });

    expect((sendToolResponse as Mock).mock.calls.length).toBe(1);
    expect(countErrorEvents(text)).toBe(1); // eskiden 2 yazılıyordu (onError + catch)
  });
});

describe('LIVE-24: streaming filler bastırma', () => {
  type CB = { onText: (t: string) => void; onToolCall: (c: unknown[]) => void; onTurnComplete: () => void; onError: (e: Error) => void };
  const req = { model: 'claude-sonnet-4-6', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'dosyaya bak' }] };

  it('yalnız filler ("Let me check") turu SSE\'ye yazılmaz, retry edilir; ikinci deneme akar', async () => {
    let call = 0;
    (streamFromGemini as Mock).mockImplementation(async (_r: unknown, cb: CB) => {
      call++;
      if (call === 1) { cb.onText('Let me '); cb.onText('check.'); cb.onTurnComplete(); return; }
      cb.onText('Dosyada 3 satır var.');
      cb.onTurnComplete();
    });
    const { text } = await postMessages(req);
    expect(call).toBe(2);
    expect(text).not.toContain('Let me');
    expect(text).toContain('Dosyada 3 satır var.');
  });

  it('uzun metin tutulmadan akar; kısa gerçek cevap ve araç öncesi kısa metin kaybolmaz', async () => {
    (streamFromGemini as Mock).mockImplementation(async (_r: unknown, cb: CB) => {
      cb.onText('Let me check the file first, then answer: '); cb.onText('42.'); cb.onTurnComplete();
    });
    expect((await postMessages(req)).text).toContain('Let me check the file first');

    let call = 0;
    (streamFromGemini as Mock).mockImplementation(async (_r: unknown, cb: CB) => { call++; cb.onText('Evet.'); cb.onTurnComplete(); });
    const short = await postMessages(req);
    expect(call).toBe(1);
    expect(short.text).toContain('Evet.');

    (streamFromGemini as Mock).mockImplementation(async (_r: unknown, cb: CB) => {
      cb.onText('Bakıyorum');
      cb.onToolCall([{ id: 'fc1', name: 'Read', args: { file_path: '/x' } }]);
      cb.onTurnComplete();
    });
    const tool = await postMessages(req);
    expect(tool.text).toContain('Bakıyorum');
    expect(tool.text.indexOf('Bakıyorum')).toBeLessThan(tool.text.indexOf('"name":"Read"'));
  });
});

describe('TD-017: araç yanıtı akışında flatten işaretçisi temizlenir', () => {
  it('sızan "[Önceki konuşmanın dökümü]" metne çıkmaz', async () => {
    process.env['REVIEW'] = 'off'; resetConfig();
    try {
      (sendToolResponse as Mock).mockImplementation(async (_r: unknown, cb: { onText: (t: string) => void; onTurnComplete: () => void }) => {
        cb.onText('[Önceki konuşmanın dökümü] Dosyada a.txt var.');
        cb.onTurnComplete();
      });
      const { text } = await postMessages({
        model: 'claude-sonnet-4-6', max_tokens: 100, stream: true,
        tools: [{ name: 'Bash', description: 'komut', input_schema: { type: 'object', properties: {} } }],
        messages: [
          { role: 'user', content: 'dosyaları listele' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_td17', name: 'Bash', input: { command: 'ls' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_td17', content: 'a.txt' }] },
        ],
      });
      expect(text).toContain('Dosyada a.txt var.');
      expect(text).not.toContain('Önceki konuşmanın dökümü');
    } finally { delete process.env['REVIEW']; resetConfig(); }
  });
});
