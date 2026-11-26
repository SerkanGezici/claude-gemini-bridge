// ROUTE-1b: REST şeridi — stateless generateContent yürütücüsü.
// Live'ın 1007 kısıtı REST'te yok → tool geçmişi GERÇEK functionCall/
// functionResponse partlarıyla gider; PARAM-1 passthrough burada uygulanır.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetConfig } from '../../src/config.js';
import {
  toRestContents,
  runRestTurn,
  RestLaneUnavailable,
  REST_TOOL_RESULT_MAX_CHARS,
  cap,
} from '../../src/rest-lane.js';
import { resetLimitRegistry, setLimitStatePath, isBlocked, rpdRemaining } from '../../src/limit-registry.js';
import type { AnthropicMessage, AnthropicRequest } from '../../src/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'rest-lane-'));

const savedEnv: Record<string, string | undefined> = {};
const KEYS = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'QUOTA_COOLDOWN_MS'];

beforeAll(() => {
  for (const k of KEYS) savedEnv[k] = process.env[k];
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['GEMINI_MODEL'] = 'models/gemini-3.1-flash-live-preview';
});

afterAll(() => {
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetConfig();
  resetLimitRegistry();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  resetConfig();
  resetLimitRegistry();
  setLimitStatePath(join(tmp, 'limits.json'), true);
});

const BODY = (over: Partial<AnthropicRequest> = {}): AnthropicRequest => ({
  model: 'claude-sonnet-5',
  max_tokens: 4096,
  messages: [],
  ...over,
});

describe('toRestContents', () => {
  it('tool geçmişini GERÇEK functionCall/functionResponse partlarına çevirir', () => {
    const messages: AnthropicMessage[] = [
      { role: 'user', content: 'dosyayı oku' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'okuyorum' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'içerik A' }],
      },
    ];
    const turns = toRestContents(messages);
    expect(turns).toHaveLength(3);
    expect(turns[1].role).toBe('model');
    expect(turns[1].parts[1]).toEqual({ functionCall: { name: 'Read', args: { file_path: '/x' } }, thoughtSignature: 'skip_thought_signature_validator' });
    expect(turns[2].parts[0]).toEqual({
      functionResponse: { name: 'Read', response: { result: 'içerik A' } },
    });
  });

  it('is_error tool_result → {error} payload', () => {
    const messages: AnthropicMessage[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'patladı', is_error: true }] },
    ];
    const turns = toRestContents(messages);
    expect(turns[2].parts[0]).toMatchObject({ functionResponse: { response: { error: 'patladı' } } });
  });

  it('system mesajları atlanır, ardışık aynı-rol turnler birleşir, boş artefakt süzülür', () => {
    const messages: AnthropicMessage[] = [
      { role: 'system', content: 'meta' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'No response requested.' },
      { role: 'user', content: 'b' },
    ];
    const turns = toRestContents(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].parts).toHaveLength(2); // a + b birleşti
  });

  it('uzun tool_result REST cap ile kırpılır (Live 4k değil, 64k)', () => {
    const big = 'y'.repeat(REST_TOOL_RESULT_MAX_CHARS + 500);
    const messages: AnthropicMessage[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] },
    ];
    const fr = toRestContents(messages)[2].parts[0] as unknown as { functionResponse: { response: { result: string } } };
    expect(fr.functionResponse.response.result.length).toBeLessThan(big.length);
    expect(fr.functionResponse.response.result).toContain('truncated');
  });

  it('cap ORTADAN kırpar — baş (bağlam çapası) ve son (kullanıcının sorusu) korunur', () => {
    const text = 'BAS-ISARET ' + 'x'.repeat(1000) + ' SON-SORU';
    const capped = cap(text, 200);
    expect(capped).toContain('BAS-ISARET');
    expect(capped).toContain('SON-SORU');
    expect(capped).toContain('kırpıldı');
    expect(capped.length).toBeLessThan(300);
    // limit altı metin aynen döner
    expect(cap('kisa', 200)).toBe('kisa');
  });

  it('tool_result içindeki görseller inlineData olarak taşınır (GAP-VISION-1 REST ayağı)', () => {
    const messages: AnthropicMessage[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: 'görsel geldi' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } },
          ],
        }],
      },
    ];
    const parts = toRestContents(messages)[2].parts;
    expect(parts.some((p) => 'inlineData' in p)).toBe(true);
  });
});

describe('runRestTurn', () => {
  it('text + functionCall partlarını sonuca çevirir; thought partları süzer', async () => {
    const fake = async () => ({
      candidates: [{
        content: {
          parts: [
            { text: 'iç monolog', thought: true },
            { text: 'Merhaba' },
            { functionCall: { name: 'Read', args: { file_path: '/y' } } },
          ],
        },
      }],
    });
    const r = await runRestTurn(
      { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'selam' }], body: BODY(), estTokens: 100 },
      fake,
    );
    expect(r.text).toBe('Merhaba');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].name).toBe('Read');
    expect(r.toolCalls[0].id).toMatch(/^toolu_rest_/);
  });

  it('PARAM-1: temperature/top_p/stop_sequences/max_tokens generationConfig\'e geçer, web_search REST\'te sunulmaz', async () => {
    let captured: Record<string, unknown> | undefined;
    const fake = async (req: Record<string, unknown>) => {
      captured = req;
      return { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
    };
    await runRestTurn(
      {
        model: 'gemini-3.1-flash-lite',
        messages: [{ role: 'user', content: 'selam' }],
        body: BODY({
          temperature: 0.3,
          top_p: 0.9,
          stop_sequences: ['DUR'],
          max_tokens: 1234,
          tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
        }),
        estTokens: 100,
      },
      fake,
    );
    const cfg = captured!['config'] as Record<string, unknown>;
    expect(cfg['temperature']).toBe(0.3);
    expect(cfg['topP']).toBe(0.9);
    expect(cfg['stopSequences']).toEqual(['DUR']);
    expect(cfg['maxOutputTokens']).toBe(1234);
    const tools = cfg['tools'] as Array<{ functionDeclarations: Array<{ name: string }> }>;
    const names = tools[0].functionDeclarations.map((d) => d.name);
    expect(names).toContain('Read');
    expect(names).not.toContain('web_search');
  });

  it('429 hatasında modeli registry\'de bloklar ve RestLaneUnavailable fırlatır (istek kaybolmaz)', async () => {
    const fake = async () => {
      throw new Error('HTTP 429 RESOURCE_EXHAUSTED "quotaValue":"250000" retryDelay":"7s"');
    };
    await expect(
      runRestTurn(
        { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'x' }], body: BODY(), estTokens: 50 },
        fake,
      ),
    ).rejects.toThrow(RestLaneUnavailable);
    expect(isBlocked('gemini-3.1-flash-lite', Date.now() + 6000)).toBe(true);
    expect(isBlocked('gemini-3.1-flash-lite', Date.now() + 8000)).toBe(false);
  });

  it('kullanım RPD sayacına işlenir (bütçe kapısı bunu okur)', async () => {
    const fake = async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    const before = rpdRemaining('gemini-3.1-flash-lite');
    await runRestTurn(
      { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'x' }], body: BODY(), estTokens: 50 },
      fake,
    );
    expect(rpdRemaining('gemini-3.1-flash-lite')).toBe(before - 1);
  });

  it('boş yanıt → RestLaneUnavailable (Live yoluna dönüş güvenli)', async () => {
    const fake = async () => ({ candidates: [{ content: { parts: [] } }] });
    await expect(
      runRestTurn(
        { model: 'gemini-3.1-flash-lite', messages: [{ role: 'user', content: 'x' }], body: BODY(), estTokens: 50 },
        fake,
      ),
    ).rejects.toThrow(/boş yanıt/);
  });
});

describe('REST-SIG-1 restTimeoutMs', () => {
  it('boyuta göre ölçeklenir, 120sn ile sınırlı', async () => {
    const { restTimeoutMs } = await import('../../src/rest-lane.js');
    expect(restTimeoutMs(31_000)).toBe(30_500);
    expect(restTimeoutMs(0)).toBe(15_000);
    expect(restTimeoutMs(1_000_000)).toBe(120_000);
  });
});
