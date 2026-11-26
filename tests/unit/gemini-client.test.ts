// TD-004: gemini-client.ts (636 LOC, en riskli testsiz dosya) unit kapsamı.
// streamFromGemini / sendToolResponse / buildConnectConfig / isGemini3 / session
// registry'si bugüne dek yalnız canlı smoke ile dolaylı doğrulanıyordu (err1 +
// p3 testlerinde MOCK'lanıyor, gerçek davranışı test edilmiyordu). Bu suite
// @google/genai SDK'sını mock'layıp WS bağlantısını taklit eder (gerçek API'ye
// GİTMEZ): connect callback'leri yakalanır, server mesajları elle tetiklenir.
//
// NOT: kota fallback (resolveActiveModel/markModelDegraded) → model-fallback.test.ts,
// web_search REST grounding (handleWebSearch) → web-search.test.ts'te zaten kapsanır;
// burada TEKRAR edilmez (DUP yok). Bu dosya: connect-config üretimi + Live akış
// durum makinesi (setupComplete→toolCall→turnComplete) + tool-response kanalı.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';

const { mockConnect, mockGenerateContent } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockGenerateContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
    live: { connect: mockConnect },
  })),
  Modality: { AUDIO: 'AUDIO', TEXT: 'TEXT' },
  ThinkingLevel: { LOW: 'LOW' },
}));

import {
  isGemini3,
  buildConnectConfig,
  streamFromGemini,
  sendToolResponse,
  findToolSession,
  hasToolSession,
  retireToolSessionIfToolsChanged,
  closeAllSessions,
  resolveActiveModel,
  resetQuotaState,
  resetAI,
  type GeminiStreamCallbacks,
  type StreamParams,
} from '../../src/gemini-client.js';
import { resetConfig } from '../../src/config.js';

const G3 = 'models/gemini-3.1-flash-live-preview';
const G25 = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

const savedEnv: Record<string, string | undefined> = {};
const KEYS = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL', 'QUOTA_COOLDOWN_MS', 'RETRY_BASE_DELAY'];

// ── Fake Live Session + connect yakalama ──────────────────────
interface FakeSession {
  sendClientContent: ReturnType<typeof vi.fn>;
  sendToolResponse: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
let fakeSession: FakeSession;
// connect'e geçilen callbacks (onopen/onmessage/onerror/onclose) — server
// mesajlarını elle tetiklemek için yakalanır.
let captured: { onmessage: (m: unknown) => void; onerror: (e: Error) => void; onclose: (e: { code: number; reason?: string }) => void } | null;

function makeFakeSession(): FakeSession {
  return { sendClientContent: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() };
}

function noopCallbacks(): GeminiStreamCallbacks {
  return { onText: vi.fn(), onToolCall: vi.fn(), onTurnComplete: vi.fn(), onError: vi.fn() };
}

/** microtask + makrotask kuyruğunu boşalt (connect await'i tamamlansın) */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  for (const k of KEYS) savedEnv[k] = process.env[k];
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['GEMINI_MODEL'] = G3;
  process.env['GEMINI_FALLBACK_MODEL'] = G25;
  process.env['QUOTA_COOLDOWN_MS'] = '60000';
  process.env['RETRY_BASE_DELAY'] = '1'; // RETRY-1 reconnect testleri beklemesin
  resetConfig();
  resetAI();
  resetQuotaState(); // onclose-quota testi state'i sonraki testlere sızdırmasın
  closeAllSessions();
  fakeSession = makeFakeSession();
  captured = null;
  mockConnect.mockReset();
  mockConnect.mockImplementation(async (opts: { callbacks: typeof captured }) => {
    captured = opts.callbacks;
    return fakeSession;
  });
  mockGenerateContent.mockReset(); // web_search REST mock'u testler arası sızmasın
});

afterEach(() => {
  closeAllSessions(); // açık session'ların RESPONSE_TIMEOUT timer'larını temizle
});

afterAll(() => {
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetConfig();
  resetAI();
});

// ── isGemini3 (saf tespit) ────────────────────────────────────
describe('isGemini3', () => {
  it('gemini-3.x modellerini tanır', () => {
    expect(isGemini3(G3)).toBe(true);
    expect(isGemini3('models/gemini-3-pro-live')).toBe(true);
  });
  it('case-insensitive', () => {
    expect(isGemini3('GEMINI-3-FLASH')).toBe(true);
  });
  it('2.5 / boş / alakasız → false', () => {
    expect(isGemini3(G25)).toBe(false);
    expect(isGemini3('')).toBe(false);
    expect(isGemini3('models/gemini-2.0-flash')).toBe(false);
  });
});

// ── buildConnectConfig (manifesto-uyumlu setup üretimi) ───────
describe('buildConnectConfig', () => {
  const base: StreamParams = { turns: [] };

  it('tüm modeller için ortak Live setup (AUDIO modality + transkripsiyon + resumption)', () => {
    const cfg = buildConnectConfig(base, G3);
    expect(cfg['responseModalities']).toEqual(['AUDIO']);
    expect(cfg['outputAudioTranscription']).toEqual({});
    expect(cfg['inputAudioTranscription']).toEqual({});
    expect(cfg['sessionResumption']).toEqual({});
  });

  it('3.x → thinkingLevel:LOW + realtimeInputConfig YOK (Q111: VAD eklemek empty-turn yapar)', () => {
    const cfg = buildConnectConfig(base, G3);
    expect(cfg['thinkingConfig']).toEqual({ thinkingLevel: 'LOW' });
    expect(cfg['realtimeInputConfig']).toBeUndefined();
  });

  it('2.5 → thinkingBudget:0 + VAD disabled (manifesto §3.5)', () => {
    const cfg = buildConnectConfig(base, G25);
    expect(cfg['thinkingConfig']).toEqual({ thinkingBudget: 0 });
    expect(cfg['realtimeInputConfig']).toEqual({ automaticActivityDetection: { disabled: true } });
  });

  it('systemPrompt verilince systemInstruction.parts[].text olur', () => {
    const cfg = buildConnectConfig({ turns: [], systemPrompt: 'Sen bir köprüsün' }, G3);
    expect(cfg['systemInstruction']).toEqual({ parts: [{ text: 'Sen bir köprüsün' }] });
  });

  it('systemPrompt yoksa systemInstruction eklenmez', () => {
    expect(buildConnectConfig(base, G3)['systemInstruction']).toBeUndefined();
  });

  it('tools verilince functionDeclarations sarmalanır; boş/yoksa eklenmez', () => {
    const tools = [{ name: 'Bash', description: 'run', parameters: { type: 'object' } }];
    const withTools = buildConnectConfig({ turns: [], tools }, G3);
    expect(withTools['tools']).toEqual([{ functionDeclarations: tools }]);
    expect(buildConnectConfig({ turns: [], tools: [] }, G3)['tools']).toBeUndefined();
    expect(buildConnectConfig(base, G3)['tools']).toBeUndefined();
  });
});

// ── Session registry (paralel istek izolasyonu) ──────────────
describe('tool session registry', () => {
  it('boş registry → findToolSession null, hasToolSession false', () => {
    expect(findToolSession(['yok'])).toBeNull();
    expect(hasToolSession(['yok'])).toBe(false);
  });

  it('closeAllSessions registry\'yi temizler', async () => {
    const cbs = noopCallbacks();
    void streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'hi' }] }], model: G3 }, cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ toolCall: { functionCalls: [{ name: 'Bash', id: 'fc_reg', args: {} }] } });
    expect(hasToolSession(['fc_reg'])).toBe(true);
    closeAllSessions();
    expect(hasToolSession(['fc_reg'])).toBe(false);
  });

  // TOOLSEL-1: ToolSearch yeni araç yüklediyse eski oturum o aracı bilmez
  async function openSessionWithTools(names: string[], id: string): Promise<void> {
    const tools = names.map((name) => ({ name, description: '', parameters: { type: 'OBJECT' } }));
    void streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'hi' }] }], model: G3, tools } as StreamParams, noopCallbacks());
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ toolCall: { functionCalls: [{ name: 'ToolSearch', id, args: {} }] } });
  }

  it('araç seti aynıysa oturum korunur', async () => {
    await openSessionWithTools(['Read', 'ToolSearch'], 'fc_same');
    expect(retireToolSessionIfToolsChanged(['fc_same'], ['ToolSearch', 'Read'])).toBe(false);
    expect(hasToolSession(['fc_same'])).toBe(true);
  });

  it('yeni araç geldiyse oturum kapanır → replay yolu', async () => {
    await openSessionWithTools(['Read', 'ToolSearch'], 'fc_new');
    expect(retireToolSessionIfToolsChanged(['fc_new'], ['Read', 'ToolSearch', 'mcp__erp__query'])).toBe(true);
    expect(hasToolSession(['fc_new'])).toBe(false);
    expect(fakeSession.close).toHaveBeenCalled();
  });

  it('araç azaldıysa oturum korunur (eski oturum üst küme)', async () => {
    await openSessionWithTools(['Read', 'Bash', 'ToolSearch'], 'fc_less');
    expect(retireToolSessionIfToolsChanged(['fc_less'], ['Read'])).toBe(false);
  });
});

describe('TRANSCRIPT-1 döküm onarımı', () => {
  it('ses uzun, döküm kesikse ses REST\'e yazdırılır ve kalan kısım tur bitmeden akıtılır', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'Depodaki TSL-8842 ürününden 4173 adet var, raf K-19.' });
    const order: string[] = [];
    const cbs: GeminiStreamCallbacks = {
      onText: (t) => order.push(`text:${t}`), onToolCall: vi.fn(), onError: vi.fn(),
      onTurnComplete: () => order.push('done'),
    };
    const p = streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'stok?' }] }], model: G3 }, cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    const audio = Buffer.alloc(48_000 * 4).toString('base64'); // 4sn ses
    captured!.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: audio } }] }, outputTranscription: { text: 'Depodaki TSL-8842' } } });
    captured!.onmessage({ serverContent: { generationComplete: true } });
    await p;
    expect(order).toEqual(['text:Depodaki TSL-8842', 'text: ürününden 4173 adet var, raf K-19.', 'done']);
    const req = mockGenerateContent.mock.calls[0]![0];
    expect(req.contents[0].parts[0].inlineData.mimeType).toBe('audio/wav');
  });

  it('normal oranlı dökümde onarım yapılmaz', async () => {
    const cbs = noopCallbacks();
    const p = streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'x' }] }], model: G3 }, cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    const audio = Buffer.alloc(48_000 * 3).toString('base64');
    captured!.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: audio } }] }, outputTranscription: { text: 'Bu cevap üç saniyelik normal bir konuşma.' } } });
    captured!.onmessage({ serverContent: { generationComplete: true } });
    await p;
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(cbs.onTurnComplete).toHaveBeenCalled();
  });
});

// ── streamFromGemini (Live akış durum makinesi) ──────────────
describe('streamFromGemini akışı', () => {
  it('setupComplete → turns persistent session\'a gönderilir (turnComplete:true)', async () => {
    const turns = [{ role: 'user' as const, parts: [{ text: 'merhaba' }] }];
    void streamFromGemini({ turns, model: G3 }, noopCallbacks());
    await flush();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    captured!.onmessage({ setupComplete: true });
    expect(fakeSession.sendClientContent).toHaveBeenCalledWith({ turns, turnComplete: true });
  });

  it('toolCall → onToolCall çağrılır, id registry\'ye yazılır, HTTP isteği biter', async () => {
    const cbs = noopCallbacks();
    const promise = streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'listele' }] }], model: G3 }, cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({
      toolCall: { functionCalls: [{ name: 'Bash', id: 'fc_1', args: { command: 'ls' } }] },
    });
    await promise; // finishRequest → resolve
    expect(cbs.onToolCall).toHaveBeenCalledWith([{ name: 'Bash', id: 'fc_1', args: { command: 'ls' } }]);
    expect(hasToolSession(['fc_1'])).toBe(true);
  });

  it('isimsiz functionCall atlanır → onToolCall ÇAĞRILMAZ, akış normal devam eder', async () => {
    const cbs = noopCallbacks();
    const promise = streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'x' }] }], model: G3 }, cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ toolCall: { functionCalls: [{ id: 'noname', args: {} }] } });
    expect(cbs.onToolCall).not.toHaveBeenCalled();
    // isimsiz FC atlandı → model normal cevaba devam eder → temiz kapanış (timer leak yok)
    captured!.onmessage({ serverContent: { generationComplete: true } });
    await expect(promise).resolves.toBeUndefined();
  });

  it('outputTranscription → onText\'e akar', async () => {
    const cbs = noopCallbacks();
    void streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'x' }] }], model: G3 }, cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ serverContent: { outputTranscription: { text: 'parça1' } } });
    expect(cbs.onText).toHaveBeenCalledWith('parça1');
  });

  it('generationComplete → onTurnComplete + promise resolve (ilk sinyal kazanır)', async () => {
    const cbs = noopCallbacks();
    const promise = streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'x' }] }], model: G3 }, cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ serverContent: { outputTranscription: { text: '4' } } });
    captured!.onmessage({ serverContent: { generationComplete: true } });
    await expect(promise).resolves.toBeUndefined();
    expect(cbs.onTurnComplete).toHaveBeenCalledTimes(1);
    expect(fakeSession.close).toHaveBeenCalled();
  });

  it('connect başarısız → onError + promise reject (unhandledRejection ÇÖKÜŞÜ yok)', async () => {
    mockConnect.mockReset();
    mockConnect.mockRejectedValue(new Error('connect failed'));
    const cbs = noopCallbacks();
    await expect(
      streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'x' }] }], model: G3 }, cbs),
    ).rejects.toThrow('connect failed');
    expect(cbs.onError).toHaveBeenCalled();
  });
});

// ── sendToolResponse (persistent session'a tool sonucu) ──────
describe('sendToolResponse', () => {
  // toolCall'a kadar akıtıp açık bir session bırakır
  async function openSessionWithTool(model: string, toolId = 'fc_t'): Promise<void> {
    void streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'iş' }] }], model }, noopCallbacks());
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ toolCall: { functionCalls: [{ name: 'Read', id: toolId, args: {} }] } });
  }

  it('açık session yoksa reject eder', async () => {
    await expect(
      sendToolResponse([{ id: 'yok', name: 'Read', response: { ok: true } }], noopCallbacks()),
    ).rejects.toThrow('No active Gemini session');
  });

  it('aktif session\'a functionResponses gönderir, id registry\'den düşer', async () => {
    await openSessionWithTool(G3, 'fc_t');
    void sendToolResponse([{ id: 'fc_t', name: 'Read', response: { content: 'dosya' } }], noopCallbacks());
    await flush();
    expect(fakeSession.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: 'fc_t', name: 'Read', response: { content: 'dosya' } }],
    });
    expect(hasToolSession(['fc_t'])).toBe(false); // cevaplanan id düştü
  });

  it('2.5 modelinde anti-filler nudge GÖNDERİLİR', async () => {
    await openSessionWithTool(G25, 'fc_25');
    fakeSession.sendClientContent.mockClear(); // setupComplete turn gönderimini say dışı bırak
    void sendToolResponse([{ id: 'fc_25', name: 'Read', response: { content: 'x' } }], noopCallbacks());
    await flush();
    expect(fakeSession.sendToolResponse).toHaveBeenCalledTimes(1);
    // mockClear sonrası TEK sendClientContent = nudge (false-positive imkansız)
    expect(fakeSession.sendClientContent).toHaveBeenCalledTimes(1);
    const nudge = fakeSession.sendClientContent.mock.calls[0]?.[0];
    expect(nudge?.turnComplete).toBe(true);
    expect(nudge?.turns?.[0]?.parts?.[0]?.text).toMatch(/continue the task/i);
  });

  it('3.x modelinde nudge GÖNDERİLMEZ (başlamış üretimi iptal ederdi)', async () => {
    await openSessionWithTool(G3, 'fc_3');
    fakeSession.sendClientContent.mockClear(); // setupComplete'in turns gönderimini say dışı bırak
    void sendToolResponse([{ id: 'fc_3', name: 'Read', response: { content: 'x' } }], noopCallbacks());
    await flush();
    expect(fakeSession.sendToolResponse).toHaveBeenCalledTimes(1);
    expect(fakeSession.sendClientContent).not.toHaveBeenCalled(); // 3.x'te nudge yok
  });

  it('GAP-VISION-1: image parts functionResponses\'a iletilir', async () => {
    await openSessionWithTool(G3, 'fc_img');
    const parts = [{ inlineData: { mimeType: 'image/png', data: 'BASE64==' } }];
    void sendToolResponse([{ id: 'fc_img', name: 'Read', response: { content: '[image]' }, parts }], noopCallbacks());
    await flush();
    expect(fakeSession.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: 'fc_img', name: 'Read', response: { content: '[image]' }, parts }],
    });
  });
});

// ── Recovery + invariant path'leri (TD-004 review bulguları) ──
// reviewer + tester agent'larının işaret ettiği yüksek-riskli, üretimde aktif
// ama test dışı kalan yollar: WS kapanış/hata recovery, kota fallback'in asıl
// tetikleyicisi (onclose), awaitingTools guard'ı ve LIVE-SEARCH-1 intercept'i.
describe('streamFromGemini — recovery & invariant', () => {
  function startG3(cbs: GeminiStreamCallbacks): Promise<void> {
    return streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'x' }] }], model: G3 }, cbs);
  }

  it('onclose kota kodu (1011) → markQuotaExceeded → cooldown\'da fallback model aktif', async () => {
    const cbs = noopCallbacks();
    const promise = startG3(cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onclose({ code: 1011, reason: 'You exceeded your current quota' });
    await expect(promise).rejects.toThrow(/Gemini closed: 1011/);
    expect(cbs.onError).toHaveBeenCalled();
    // kota işaretlendi → resolveActiveModel cooldown boyunca fallback döner
    expect(resolveActiveModel(Date.now() + 1000)).toBe(G25);
  });

  it('onclose beklenmedik kapanış (1006) → promise reject + onError (sonsuz bekleme önlenir)', async () => {
    const cbs = noopCallbacks();
    const promise = startG3(cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onclose({ code: 1006, reason: '' });
    await expect(promise).rejects.toThrow(/Gemini closed: 1006/);
    expect(cbs.onError).toHaveBeenCalledTimes(1);
    expect(resolveActiveModel(Date.now() + 1000)).toBe(G3); // 1006 kota DEĞİL → fallback yok
  });

  it('onerror WS hatası → promise reject + onError', async () => {
    const cbs = noopCallbacks();
    const promise = startG3(cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onerror(new Error('ws boom'));
    await expect(promise).rejects.toThrow(/Gemini error: ws boom/);
    expect(cbs.onError).toHaveBeenCalled();
  });

  it('awaitingTools sırasında turnComplete sinyali onTurnComplete tetiklemez (tool guard)', async () => {
    const cbs = noopCallbacks();
    const promise = startG3(cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ toolCall: { functionCalls: [{ name: 'Bash', id: 'fc_guard', args: {} }] } });
    await promise; // toolCall HTTP isteğini bitirir, WS açık kalır
    captured!.onmessage({ serverContent: { turnComplete: true } });
    expect(cbs.onTurnComplete).not.toHaveBeenCalled(); // tool bekleniyor → ara sinyal yok sayıldı
  });

  it('çoklu functionCall batch → her id aynı handle\'a kaydolur', async () => {
    const cbs = noopCallbacks();
    const promise = startG3(cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ toolCall: { functionCalls: [
      { name: 'Bash', id: 'a', args: {} },
      { name: 'Read', id: 'b', args: {} },
    ] } });
    await promise;
    expect(cbs.onToolCall).toHaveBeenCalledWith([
      { name: 'Bash', id: 'a', args: {} },
      { name: 'Read', id: 'b', args: {} },
    ]);
    expect(hasToolSession(['a'])).toBe(true);
    expect(hasToolSession(['b'])).toBe(true);
    expect(findToolSession(['b'])).toBe(findToolSession(['a'])); // tek session, iki id
  });

  it('id\'siz functionCall → fc_<ts>_<idx> fallback id üretilir ve registry\'ye yazılır', async () => {
    const cbs = noopCallbacks();
    const promise = startG3(cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ toolCall: { functionCalls: [{ name: 'Bash', args: { command: 'ls' } }] } });
    await promise;
    const calls = vi.mocked(cbs.onToolCall).mock.calls[0]![0];
    expect(calls[0]!.id).toMatch(/^fc_\d+_0$/);
    expect(hasToolSession([calls[0]!.id])).toBe(true);
  });

  it('sessionResumptionUpdate.newHandle → handle.resumptionHandle saklanır (LIVE-7 prereq)', async () => {
    const cbs = noopCallbacks();
    const promise = startG3(cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ sessionResumptionUpdate: { newHandle: 'resume-h123' } });
    captured!.onmessage({ toolCall: { functionCalls: [{ name: 'Bash', id: 'fc_res', args: {} }] } });
    await promise;
    expect(findToolSession(['fc_res'])?.resumptionHandle).toBe('resume-h123');
  });

  it('SOLO web_search batch → onToolCall ÇAĞRILMAZ, grounded sonuç session\'a döner (LIVE-SEARCH-1)', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'web sonucu', candidates: [] });
    const cbs = noopCallbacks();
    const promise = startG3(cbs);
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({
      toolCall: { functionCalls: [{ name: 'web_search', id: 'ws_1', args: { query: 'AI haberleri' } }] },
    });
    await flush(); // fulfillWebSearch → handleWebSearch (REST) async
    expect(cbs.onToolCall).not.toHaveBeenCalled();          // Claude Code web_search'i görmez
    expect(fakeSession.sendToolResponse).toHaveBeenCalledTimes(1); // grounded sonuç Gemini'ye döndü
    const sent = fakeSession.sendToolResponse.mock.calls[0]![0] as {
      functionResponses: Array<{ id: string; response: Record<string, unknown> }>;
    };
    expect(sent.functionResponses[0]!.id).toBe('ws_1');
    expect(sent.functionResponses[0]!.response).toHaveProperty('result', 'web sonucu');
    // model devamı → temiz kapanış (timer leak yok)
    captured!.onmessage({ serverContent: { generationComplete: true } });
    await expect(promise).resolves.toBeUndefined();
  });
});

// ── RETRY-1: reconnectSession transient retry (LIVE-7 yolu) ──
// goAway → proaktif reconnect BUGÜNE DEK tek denemeydi: tek WS hıçkırığı
// session'ı öldürüp pahalı full-replay fallback'ine düşürüyordu. Bu yol
// server.ts withRetry kapsamında DEĞİL (çift-retry yok) → kendi sınırlı
// jittered retry'ı olmalı. Kota hatasında retry YOK (LIVE-19 çift-bekleme).
describe('reconnectSession transient retry (RETRY-1)', () => {
  /** Stream'i toolCall + resumption handle + awaitingTools durumuna sür */
  async function driveToGoAwayReady(): Promise<void> {
    const promise = streamFromGemini(
      { turns: [{ role: 'user', parts: [{ text: 'listele' }] }], model: G3 },
      noopCallbacks(),
    );
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ sessionResumptionUpdate: { newHandle: 'resume-r1' } });
    captured!.onmessage({ toolCall: { functionCalls: [{ name: 'Bash', id: 'fc_r1', args: {} }] } });
    await promise; // HTTP isteği toolCall ile biter; session awaitingTools bekler
  }

  it('transient connect hatası → retry ile session yeni bağlantıda YAŞAR', async () => {
    await driveToGoAwayReady();
    const newSession = makeFakeSession();
    mockConnect
      .mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockImplementationOnce(async (opts: { callbacks: typeof captured }) => {
        captured = opts.callbacks;
        return newSession;
      });
    captured!.onmessage({ goAway: { timeLeft: '5s' } });
    await new Promise((r) => setTimeout(r, 100)); // jittered backoff (base 1ms) + microtask
    expect(mockConnect).toHaveBeenCalledTimes(3); // ilk bağlantı + fail + başarılı retry
    expect(hasToolSession(['fc_r1'])).toBe(true); // session registry'de yaşıyor
  });

  it('kota hatası → retry YOK, session kapanır (LIVE-19 cooldown ile çift-bekleme olmaz)', async () => {
    await driveToGoAwayReady();
    mockConnect.mockRejectedValue(new Error('Gemini closed: 1011 quota exceeded'));
    captured!.onmessage({ goAway: { timeLeft: '5s' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(mockConnect).toHaveBeenCalledTimes(2); // ilk bağlantı + TEK reconnect denemesi
    expect(hasToolSession(['fc_r1'])).toBe(false); // closeSession → full-replay fallback'e düşer
  });

  it('kalıcı transient hata → denemeler tükenince session kapanır (sonsuz döngü yok)', async () => {
    await driveToGoAwayReady();
    mockConnect.mockRejectedValue(new Error('read ECONNRESET'));
    captured!.onmessage({ goAway: { timeLeft: '5s' } });
    await new Promise((r) => setTimeout(r, 200));
    expect(mockConnect).toHaveBeenCalledTimes(1 + 3); // ilk + RETRY_ATTEMPTS (3) deneme
    expect(hasToolSession(['fc_r1'])).toBe(false);
  });
});

// ── RETRY-1: connectLive settle-guard (canlı smoke T1 hang imzası) ──
// SDK connect() bazı transport hatalarında HİÇ settle olmadan onerror
// tetikleyebiliyor (canlı kanıt 2026-07-06 smoke T1: 53ms'de "Gemini error:"
// sonra 60sn sessizlik). connectLive settle olmazsa rejection caller'a
// (withRetry) ulaşmaz → retry HİÇ çalışmaz, istek asılı kalır.
describe('connectLive settle-guard (RETRY-1)', () => {
  it('connect settle olmadan onerror → istek reject olur, ASILI KALMAZ', async () => {
    mockConnect.mockImplementation((opts: { callbacks: typeof captured }) => {
      captured = opts.callbacks;
      return new Promise(() => {}); // SDK connect'i asla settle olmaz (T1 imzası)
    });
    const promise = streamFromGemini(
      { turns: [{ role: 'user', parts: [{ text: 'selam' }] }], model: G3 },
      noopCallbacks(),
    );
    promise.catch(() => { /* assert Promise.race'te — unhandled rejection olmasın */ });
    await flush();
    captured!.onerror(new Error(''));
    const outcome = await Promise.race([
      promise.then(() => 'resolved', () => 'rejected'),
      new Promise((r) => setTimeout(() => r('hung'), 300)),
    ]);
    expect(outcome).toBe('rejected');
  });

  it('reject sonrası GEÇ settle olan connect → session kapatılır (WS sızıntısı yok)', async () => {
    let resolveConnect: ((s: FakeSession) => void) | null = null;
    mockConnect.mockImplementation((opts: { callbacks: typeof captured }) => {
      captured = opts.callbacks;
      return new Promise((res) => { resolveConnect = res; });
    });
    const promise = streamFromGemini(
      { turns: [{ role: 'user', parts: [{ text: 'selam' }] }], model: G3 },
      noopCallbacks(),
    );
    promise.catch(() => { /* beklenen rejection */ });
    await flush();
    captured!.onerror(new Error('boom'));
    await flush();
    const lateSession = makeFakeSession();
    resolveConnect!(lateSession); // SDK sonradan bağlanabildi
    await flush();
    expect(lateSession.close).toHaveBeenCalled(); // sahipsiz WS kapatıldı
  });
});

// ── ADR-0001 Denetçi: son cevapta oturumu tut + düzeltme turu ──
describe('held session (Denetçi)', () => {
  async function openWithTool(toolId: string): Promise<void> {
    void streamFromGemini({ turns: [{ role: 'user', parts: [{ text: 'iş' }] }], model: G3 }, noopCallbacks());
    await flush();
    captured!.onmessage({ setupComplete: true });
    captured!.onmessage({ toolCall: { functionCalls: [{ name: 'Read', id: toolId, args: {} }] } });
  }

  it('onHeld verilince son cevapta oturum KAPANMAZ; followUp eski turnComplete\'i bekleyip aynı oturuma tur gönderir', async () => {
    await openWithTool('fc_h1');
    let held: import('../../src/gemini-client.js').HeldSession | null = null;
    const first = sendToolResponse([{ id: 'fc_h1', name: 'Read', response: { content: 'x' } }], noopCallbacks(), {
      onHeld: (h) => { held = h; },
    });
    await flush();
    captured!.onmessage({ serverContent: { outputTranscription: { text: 'taslak' } } });
    captured!.onmessage({ serverContent: { generationComplete: true } });
    await first;
    expect(held).not.toBeNull();
    expect(fakeSession.close).not.toHaveBeenCalled();

    fakeSession.sendClientContent.mockClear();
    const cb = noopCallbacks();
    const fu = held!.followUp('düzelt', cb);
    await flush();
    // eski turun gecikmeli turnComplete'i gelmeden yeni tur gönderilmez
    expect(fakeSession.sendClientContent).not.toHaveBeenCalled();
    captured!.onmessage({ serverContent: { turnComplete: true } }); // eski tur — yutulur
    await flush();
    expect(fakeSession.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: 'user', parts: [{ text: 'düzelt' }] }], turnComplete: true,
    });
    captured!.onmessage({ serverContent: { outputTranscription: { text: 'tam cevap' } } });
    captured!.onmessage({ serverContent: { turnComplete: true } });
    await fu;
    expect(cb.onText).toHaveBeenCalledWith('tam cevap');
    expect(fakeSession.close).toHaveBeenCalled(); // düzeltme turu bitince kapanır
  });

  it('release() oturumu kapatır', async () => {
    await openWithTool('fc_h2');
    let held: import('../../src/gemini-client.js').HeldSession | null = null;
    const p = sendToolResponse([{ id: 'fc_h2', name: 'Read', response: {} }], noopCallbacks(), { onHeld: (h) => { held = h; } });
    await flush();
    captured!.onmessage({ serverContent: { turnComplete: true } });
    await p;
    held!.release();
    expect(fakeSession.close).toHaveBeenCalled();
  });

  it('kapanmış oturuma followUp göndermez, hemen reject eder', async () => {
    await openWithTool('fc_h5');
    let held: import('../../src/gemini-client.js').HeldSession | null = null;
    const p = sendToolResponse([{ id: 'fc_h5', name: 'Read', response: {} }], noopCallbacks(), { onHeld: (h) => { held = h; } });
    await flush();
    captured!.onmessage({ serverContent: { turnComplete: true } });
    await p;
    held!.release();
    fakeSession.sendClientContent.mockClear();
    await expect(held!.followUp('düzelt', noopCallbacks())).rejects.toThrow(/closed/);
    expect(fakeSession.sendClientContent).not.toHaveBeenCalled();
  });

  it('eski turun turnComplete\'i hiç gelmezse düzeltme yine gönderilir; içerikten önceki bayat turnComplete yutulur', async () => {
    await openWithTool('fc_h6');
    let held: import('../../src/gemini-client.js').HeldSession | null = null;
    const p = sendToolResponse([{ id: 'fc_h6', name: 'Read', response: {} }], noopCallbacks(), { onHeld: (h) => { held = h; } });
    await flush();
    captured!.onmessage({ serverContent: { generationComplete: true } }); // turnComplete gelmeyecek
    await p;
    vi.useFakeTimers();
    const cb = noopCallbacks();
    let fu: Promise<void>;
    try {
      fakeSession.sendClientContent.mockClear();
      fu = held!.followUp('düzelt', cb);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(fakeSession.sendClientContent).toHaveBeenCalledTimes(1); // atlanmadı
    } finally {
      vi.useRealTimers();
    }
    captured!.onmessage({ serverContent: { turnComplete: true } }); // bayat — yutulmalı
    captured!.onmessage({ serverContent: { outputTranscription: { text: 'tam cevap' } } });
    captured!.onmessage({ serverContent: { turnComplete: true } });
    await fu!;
    expect(cb.onText).toHaveBeenCalledWith('tam cevap');
  });

  it('oturum başına en fazla 1 düzeltme: düzeltmeden sonraki son cevap tekrar tutulmaz', async () => {
    await openWithTool('fc_h3');
    let held: import('../../src/gemini-client.js').HeldSession | null = null;
    const p1 = sendToolResponse([{ id: 'fc_h3', name: 'Read', response: {} }], noopCallbacks(), { onHeld: (h) => { held = h; } });
    await flush();
    captured!.onmessage({ serverContent: { turnComplete: true } });
    await p1;
    // düzeltme turunda model yeni bir araç çağırıyor
    const fu = held!.followUp('düzelt', noopCallbacks());
    await flush();
    captured!.onmessage({ toolCall: { functionCalls: [{ name: 'Read', id: 'fc_h4', args: {} }] } });
    await fu;
    const onHeld2 = vi.fn();
    const p2 = sendToolResponse([{ id: 'fc_h4', name: 'Read', response: {} }], noopCallbacks(), { onHeld: onHeld2 });
    await flush();
    captured!.onmessage({ serverContent: { turnComplete: true } });
    await p2;
    expect(onHeld2).not.toHaveBeenCalled();
    expect(fakeSession.close).toHaveBeenCalled();
  });
});

describe('MIGR-38 3.8-live bağlantı ayarı', () => {
  const tools = [{ name: 'Read', description: 'r', parameters: { type: 'OBJECT' } }] as never;
  it('3.8-live: thinkingLevel yok (1007), VAD kapalı, araçlar BLOCKING', () => {
    const c = buildConnectConfig({ turns: [], tools } as never, 'models/gemini-3.8-live');
    expect(c['thinkingConfig']).toBeUndefined();
    expect(c['realtimeInputConfig']).toEqual({ automaticActivityDetection: { disabled: true } });
    const decl = (c['tools'] as Array<{ functionDeclarations: Array<{ behavior?: string }> }>)[0]!.functionDeclarations[0]!;
    expect(decl.behavior).toBe('BLOCKING');
  });
  it('3.1 ve extended-thinking değişmez: thinkingLevel var, behavior yok', () => {
    for (const m of ['models/gemini-3.1-flash-live-preview', 'models/gemini-3.8-live-extended-thinking']) {
      const c = buildConnectConfig({ turns: [], tools } as never, m);
      expect(c['thinkingConfig']).toBeDefined();
      const decl = (c['tools'] as Array<{ functionDeclarations: Array<{ behavior?: string }> }>)[0]!.functionDeclarations[0]!;
      expect(decl.behavior).toBeUndefined();
    }
  });
});
