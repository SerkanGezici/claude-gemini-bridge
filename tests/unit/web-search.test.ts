// LIVE-SEARCH-1: web_search sentetik tool'unun REST grounding fulfillment'ı.
// Live API aynı session'da googleSearch + functionDeclarations'ı kabul etmediği
// için arama out-of-band bir REST generateContent isteğiyle yapılır. Bu test
// @google/genai SDK'sını mock'layarak handleWebSearch'in payload şekillerini
// doğrular (gerçek API'ye GİTMEZ). ASLA throw etmemeli — hata da {error} döner.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { mockGenerateContent, mockConnect } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockConnect: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
    live: { connect: mockConnect },
  })),
  Modality: { AUDIO: 'AUDIO', TEXT: 'TEXT' },
  ThinkingLevel: { LOW: 'LOW' },
}));

import { handleWebSearch, resetAI, hedgedLiveSearch, buildSearchInstruction } from '../../src/gemini-client.js';
import { resetConfig } from '../../src/config.js';

const savedEnv: Record<string, string | undefined> = {};
const KEYS = ['GEMINI_API_KEY', 'GEMINI_SEARCH_MODEL', 'GEMINI_SEARCH_LIVE_MODEL'];

// SEARCH-LIVE-1 fallback'inin sahte Live session'ı + yakalanan callbacks
interface FakeLiveSession {
  sendClientContent: ReturnType<typeof vi.fn>;
  sendToolResponse: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
let fakeLive: FakeLiveSession;
let liveCbs: { onmessage: (m: unknown) => void; onerror: (e: Error) => void; onclose: (e: { code: number; reason?: string }) => void } | null;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  for (const k of KEYS) savedEnv[k] = process.env[k];
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['GEMINI_SEARCH_MODEL'] = 'gemini-2.5-flash';
  delete process.env['GEMINI_SEARCH_LIVE_MODEL']; // default: 2.5-audio fallback açık
  resetConfig();
  resetAI();
  mockGenerateContent.mockReset();
  fakeLive = { sendClientContent: vi.fn(), sendToolResponse: vi.fn(), close: vi.fn() };
  liveCbs = null;
  mockConnect.mockReset();
  mockConnect.mockImplementation(async (opts: { callbacks: typeof liveCbs }) => {
    liveCbs = opts.callbacks;
    return fakeLive;
  });
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
  resetAI();
});

describe('handleWebSearch (LIVE-SEARCH-1)', () => {
  it('query yoksa {error} döner, REST çağrısı YAPILMAZ', async () => {
    const r = await handleWebSearch({});
    expect(r['error']).toMatch(/without a query/);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('grounded sonucu {result, sources} olarak döndürür (uri\'siz/web\'siz chunk atılır)', async () => {
    mockGenerateContent.mockResolvedValue({
      text: 'Son haberler: A ve B.',
      candidates: [{
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://a.com', title: 'A' } },
            { web: { uri: 'https://b.com', title: 'B' } },
            { web: {} },              // uri yok → atılmalı
            { retrievedContext: {} },  // web yok → atılmalı
          ],
        },
      }],
    });
    const r = await handleWebSearch({ query: 'AI haberleri' });
    expect(r['result']).toBe('Son haberler: A ve B.');
    expect(r['sources']).toEqual([
      { title: 'A', uri: 'https://a.com' },
      { title: 'B', uri: 'https://b.com' },
    ]);
    // Doğru REST modeli + googleSearch grounding tool'u ile çağrıldı mı?
    expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-2.5-flash',
      contents: 'AI haberleri',
      config: { tools: [{ googleSearch: {} }] },
    }));
  });

  it('REST KALICI hatası (kota/transient DEĞİL) → {error}, Live fallback DENENMEZ', async () => {
    mockGenerateContent.mockRejectedValue(new Error('400 request contains an invalid argument'));
    const r = await handleWebSearch({ query: 'x' });
    expect(r['error']).toMatch(/web_search failed.*invalid argument/);
    expect(r['result']).toBeUndefined();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('boş sonuç (text + source yok) → {error}', async () => {
    mockGenerateContent.mockResolvedValue({ text: '', candidates: [] });
    const r = await handleWebSearch({ query: 'x' });
    expect(r['error']).toMatch(/no results/);
  });

  it('GEMINI_SEARCH_MODEL env\'i REST çağrısına yansır', async () => {
    process.env['GEMINI_SEARCH_MODEL'] = 'gemini-flash-latest';
    resetConfig();
    resetAI();
    mockGenerateContent.mockResolvedValue({ text: 'ok', candidates: [] });
    await handleWebSearch({ query: 'q' });
    expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-flash-latest',
    }));
  });

  // ── SEARCH-LIVE-1: REST kotası dolunca 2.5-audio Live-grounded fallback ──
  // Canlı ölçüm kanıtı: REST free tier 20 arama/gün (2026-07-06); Live 2.5-audio
  // grounding havuzu AYRI ve fiilen sınırsız (2026-07-07, 21 arama duvarsız).

  it('SEARCH-LIVE-1: REST kota hatası → Live fallback {result, sources} döndürür (googleSearch-ONLY session)', async () => {
    mockGenerateContent.mockRejectedValue(new Error('429 RESOURCE_EXHAUSTED quota exceeded'));
    const promise = handleWebSearch({ query: 'dolar kuru' });
    await flush(); // REST reject + live connect tamamlansın
    expect(mockConnect).toHaveBeenCalledTimes(1);
    // googleSearch-ONLY: functionDeclarations YOK (Google kısıtı — birlikte kabul edilmez)
    const connectArgs = mockConnect.mock.calls[0]![0] as { model: string; config: Record<string, unknown> };
    expect(connectArgs.model).toBe('models/gemini-2.5-flash-native-audio-preview-12-2025');
    expect(connectArgs.config['tools']).toEqual([{ googleSearch: {} }]);
    // Live akışını sür: setup → query gönderildi mi → transcription + grounding → turnComplete
    liveCbs!.onmessage({ setupComplete: true });
    expect(fakeLive.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: 'user', parts: [{ text: 'dolar kuru' }] }],
      turnComplete: true,
    });
    liveCbs!.onmessage({ serverContent: { outputTranscription: { text: 'Dolar 46,84 TL.' } } });
    liveCbs!.onmessage({ serverContent: { groundingMetadata: { groundingChunks: [
      { web: { uri: 'https://kur.com', title: 'Kur' } },
      { web: {} }, // uri'siz → atılmalı
    ] } } });
    liveCbs!.onmessage({ serverContent: { turnComplete: true } });
    const r = await promise;
    expect(r['result']).toBe('Dolar 46,84 TL.');
    expect(r['sources']).toEqual([{ title: 'Kur', uri: 'https://kur.com' }]);
    expect(fakeLive.close).toHaveBeenCalled(); // tek-turluk session kapatıldı
  });

  it('SEARCH-LIVE-1: GEMINI_SEARCH_LIVE_MODEL=none → fallback KAPALI, kota hatası {error} döner', async () => {
    process.env['GEMINI_SEARCH_LIVE_MODEL'] = 'none';
    resetConfig();
    resetAI();
    mockGenerateContent.mockRejectedValue(new Error('429 quota exceeded'));
    const r = await handleWebSearch({ query: 'x' });
    expect(r['error']).toMatch(/web_search failed.*quota/);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('SEARCH-LIVE-1: Live fallback da başarısız → {error}, THROW YOK (çift hata mesajda)', async () => {
    mockGenerateContent.mockRejectedValue(new Error('quota exceeded'));
    const promise = handleWebSearch({ query: 'x' });
    await flush();
    liveCbs!.onclose({ code: 1011, reason: 'quota' }); // Live da kota kapattı
    await flush(); // SEARCH-LAT-1: erken hata → ikinci deneme hemen başlar
    expect(mockConnect).toHaveBeenCalledTimes(2);
    liveCbs!.onclose({ code: 1011, reason: 'quota' }); // ikinci deneme de kapandı
    const r = await promise;
    expect(r['error']).toMatch(/quota exceeded/);
    expect(r['error']).toMatch(/live fallback/i);
    expect(r['result']).toBeUndefined();
  });

  it('SEARCH-LIVE-1: transient REST hatası (503) da fallback tetikler', async () => {
    mockGenerateContent.mockRejectedValue(new Error('503 UNAVAILABLE high demand'));
    const promise = handleWebSearch({ query: 'x' });
    await flush();
    liveCbs!.onmessage({ setupComplete: true });
    liveCbs!.onmessage({ serverContent: { outputTranscription: { text: 'cevap' } } });
    liveCbs!.onmessage({ serverContent: { turnComplete: true } });
    const r = await promise;
    expect(r['result']).toBe('cevap');
  });

  it('SEARCH-404-1: REST modeli bu key\'de yok (404) → Live fallback, sonraki arama REST\'i HİÇ denemez', async () => {
    mockGenerateContent.mockRejectedValue(new Error(
      '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users.","status":"NOT_FOUND"}}',
    ));
    const drive = async (p: Promise<Record<string, unknown>>, text: string): Promise<Record<string, unknown>> => {
      await flush();
      liveCbs!.onmessage({ setupComplete: true });
      liveCbs!.onmessage({ serverContent: { outputTranscription: { text } } });
      liveCbs!.onmessage({ serverContent: { turnComplete: true } });
      return p;
    };
    const r1 = await drive(handleWebSearch({ query: 'galatasaray maçı' }), 'Beşiktaş ile.');
    expect(r1['result']).toBe('Beşiktaş ile.');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const r2 = await drive(handleWebSearch({ query: 'dolar' }), 'kur');
    expect(r2['result']).toBe('kur');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1); // ikinci aramada REST atlandı
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('REST yarışı kazanınca timeout timer\'ı temizlenir — dangling timer sızmaz (TD-009)', async () => {
    // Fix öncesi: Promise.race kazanan generateContent olunca setTimeout clearTimeout
    // EDİLMİYORDU → 20s boyunca event-loop'ta asılı timer → temiz kapanış gecikmesi.
    vi.useFakeTimers();
    try {
      mockGenerateContent.mockResolvedValue({ text: 'ok', candidates: [] });
      await handleWebSearch({ query: 'q' });
      // Başarı yolundan döndükten sonra hiçbir bekleyen timer kalmamalı (clearTimeout çalıştı).
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── SEARCH-LAT-1: hedge + kısa/tarihli arama talimatı ──
describe('SEARCH-LAT-1', () => {
  type R = { result: string; sources: Array<{ title: string; uri: string }> };
  it('ilk deneme hedge süresinde bitmezse ikinci başlar; ilk biten kazanır, kaybeden iptal edilir', async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(r: R) => void> = [];
    const search = (_q: string, _m: string, signal?: AbortSignal): Promise<R> => {
      signals.push(signal!);
      return new Promise<R>((res) => resolvers.push(res));
    };
    const p = hedgedLiveSearch('q', 'm', 10, search as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(resolvers.length).toBe(2); // hedge başladı
    resolvers[1]!({ result: 'ikinci', sources: [] });
    expect((await p).result).toBe('ikinci');
    expect(signals[0]!.aborted).toBe(true); // kaybeden kapatıldı
  });

  it('hızlı biten aramada hedge hiç başlamaz', async () => {
    let calls = 0;
    const search = async (): Promise<R> => { calls += 1; return { result: 'tek', sources: [] }; };
    expect((await hedgedLiveSearch('q', 'm', 50, search as never)).result).toBe('tek');
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(1);
  });

  it('ikisi de başarısız → ilk hata', async () => {
    let n = 0;
    const search = async (): Promise<R> => { n += 1; throw new Error(`hata${n}`); };
    await expect(hedgedLiveSearch('q', 'm', 10, search as never)).rejects.toThrow('hata1');
    expect(n).toBe(2);
  });

  it('arama talimatı bugünün tarihini ve tek cümle sınırını içerir', () => {
    const s = buildSearchInstruction('2026-11-25');
    expect(s).toContain('2026-11-25');
    expect(s).toMatch(/ONE short sentence/);
  });
});

