// CAP-1 (2026-06-18): Canlı tool-response (persistent session'a TEK sonuç) ile
// REPLAY (kümülatif history) farklı cap kullanır. Canlı kanal büyük dosya
// okumalarını tek seferde geçirebilsin diye yüksek tavana (LIVE_TOOL_RESULT_MAX_CHARS)
// sahiptir; replay 1007 koruması için 4k'da kalır.
//
// Canlı kanıt (TEST 21): kod/buyuk_log.txt 12.7KB, SECRET_KOD offset 9074.
// 4k cap'le model ilk Read'de sadece ilk ~55 satırı görüp, gerçek veriyi bulmak
// için 4 ayrı offset'li Read + ~2dk harcıyordu. Yüksek canlı cap bunu tek Read'e indirir.
import { describe, it, expect } from 'vitest';
import { buildGeminiToolResponses } from '../../src/server.js';
import { TOOL_RESULT_MAX_CHARS, LIVE_TOOL_RESULT_MAX_CHARS } from '../../src/transformer.js';
import type { AnthropicRequest, AnthropicToolResultBlock } from '../../src/types.js';

// findToolName'in adı çözebilmesi için eşleşen bir tool_use barındıran gövde.
const bodyWith = (toolUseId: string): AnthropicRequest => ({
  model: 'claude-x',
  max_tokens: 100,
  messages: [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: 'x.txt' } }],
    },
  ],
});

const resultOf = (out: ReturnType<typeof buildGeminiToolResponses>): string =>
  (out[0].response as { result?: string; error?: string }).result ??
  (out[0].response as { result?: string; error?: string }).error ??
  '';

describe('buildGeminiToolResponses cap (CAP-1)', () => {
  it('canlı tavan replay tavanından YÜKSEK (büyük dosyalar tek sonuçta geçer)', () => {
    expect(LIVE_TOOL_RESULT_MAX_CHARS).toBeGreaterThan(TOOL_RESULT_MAX_CHARS);
  });

  it('12.7KB sonuç (replay 4k aşar) canlı kanalda KESİLMEZ — sentinel korunur', () => {
    // buyuk_log.txt senaryosunu yeniden kur: sentinel ~offset 9074
    const filler = 'A'.repeat(9000);
    const content = `${filler}SECRET_KOD=PELIKAN-9931-ZUMRUT${'B'.repeat(3000)}`;
    expect(content.length).toBeGreaterThan(TOOL_RESULT_MAX_CHARS); // eski cap kesterdi
    expect(content.length).toBeLessThan(LIVE_TOOL_RESULT_MAX_CHARS); // yeni cap geçirir

    const out = buildGeminiToolResponses(bodyWith('toolu_a'), [
      { type: 'tool_result', tool_use_id: 'toolu_a', content },
    ]);
    const text = resultOf(out);
    expect(text).toContain('SECRET_KOD=PELIKAN-9931-ZUMRUT'); // offset 9000 hâlâ görünür gitleaks:allow (sahte test değeri)
    expect(text).not.toContain('truncated');
  });

  it('canlı tavanı AŞAN sonuç yine kesilir (+ truncated) — 1007 backstop', () => {
    const content = 'z'.repeat(LIVE_TOOL_RESULT_MAX_CHARS * 2);
    const out = buildGeminiToolResponses(bodyWith('toolu_b'), [
      { type: 'tool_result', tool_use_id: 'toolu_b', content },
    ]);
    const text = resultOf(out);
    expect(text.length).toBeLessThanOrEqual(LIVE_TOOL_RESULT_MAX_CHARS + 30);
    expect(text).toContain('truncated');
  });

  it('is_error sonucu error alanına gider ve aynı cap uygulanır', () => {
    const content = 'e'.repeat(LIVE_TOOL_RESULT_MAX_CHARS * 2);
    const out = buildGeminiToolResponses(bodyWith('toolu_c'), [
      { type: 'tool_result', tool_use_id: 'toolu_c', content, is_error: true },
    ]);
    const resp = out[0].response as { result?: string; error?: string };
    expect(resp.error).toBeDefined();
    expect(resp.result).toBeUndefined();
    expect(resp.error).toContain('truncated');
  });

  it('content array (text blokları) join edilip cap uygulanır; ad çözülür', () => {
    const out = buildGeminiToolResponses(bodyWith('toolu_d'), [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_d',
        content: [
          { type: 'text', text: 'satir1' },
          { type: 'text', text: 'satir2' },
        ],
      },
    ]);
    expect(resultOf(out)).toBe('satir1\nsatir2');
    expect(out[0].name).toBe('Read');
  });
});

describe('buildGeminiToolResponses — görsel/vision (GAP-VISION-1)', () => {
  const imgBlock = (data: string) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/png', data },
  });

  it('tool_result içindeki image bloğu functionResponse.parts[].inlineData olur', () => {
    const out = buildGeminiToolResponses(bodyWith('toolu_img'), [
      { type: 'tool_result', tool_use_id: 'toolu_img', content: [imgBlock('BASE64DATA')] },
    ]);
    expect(out[0].parts).toBeDefined();
    expect(out[0].parts).toHaveLength(1);
    expect(out[0].parts![0].inlineData).toEqual({ mimeType: 'image/png', data: 'BASE64DATA' });
    // text yokken anlamlı bir placeholder konur (boş result göndermeyelim)
    expect(resultOf(out)).toContain('görsel');
  });

  it('text + image karışık: text result\'a, image parts\'a gider', () => {
    const out = buildGeminiToolResponses(bodyWith('toolu_mix'), [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_mix',
        content: [{ type: 'text', text: 'açıklama' }, imgBlock('IMGDATA')],
      },
    ]);
    expect(resultOf(out)).toBe('açıklama');
    expect(out[0].parts![0].inlineData.data).toBe('IMGDATA');
  });

  it('salt-text tool_result\'ta parts ÜRETİLMEZ (gereksiz alan eklenmez)', () => {
    const out = buildGeminiToolResponses(bodyWith('toolu_txt'), [
      { type: 'tool_result', tool_use_id: 'toolu_txt', content: 'sadece metin' },
    ]);
    expect(out[0].parts).toBeUndefined();
  });

  it('birden çok image → hepsi parts\'a sırayla eklenir', () => {
    const out = buildGeminiToolResponses(bodyWith('toolu_multi'), [
      { type: 'tool_result', tool_use_id: 'toolu_multi', content: [imgBlock('A'), imgBlock('B')] },
    ]);
    expect(out[0].parts).toHaveLength(2);
    expect(out[0].parts!.map((p) => p.inlineData.data)).toEqual(['A', 'B']);
  });
});

describe('ADR-0002 buildGeminiToolResponsesWithTables', () => {
  const bigCsv = ['Kod,Adet,Raf', ...Array.from({ length: 2000 }, (_, i) => `TSL-${i},${i},K-${i % 40}`)].join('\n');

  it('büyük tablo: metin baş + not olur, sayfalar parts\'a eklenir; 32K kesmesi yok', async () => {
    const { buildGeminiToolResponsesWithTables } = await import('../../src/server.js');
    const { resetConfig } = await import('../../src/config.js');
    process.env['GEMINI_API_KEY'] ??= 'test-key';
    delete process.env['TABLE_AS_IMAGE']; resetConfig();
    const out = await buildGeminiToolResponsesWithTables(bodyWith('toolu_t'), [
      { type: 'tool_result', tool_use_id: 'toolu_t', content: bigCsv },
    ]);
    expect(resultOf(out)).toContain('sayfa görsel olarak ekte');
    expect(resultOf(out).length).toBeLessThan(3_000);
    expect(out[0].parts!.length).toBeGreaterThan(1);
    expect(out[0].parts![0]!.inlineData.mimeType).toBe('image/jpeg');
  }, 120_000);

  it('TABLE_AS_IMAGE=off ya da hata sonucu: metin yolu aynen', async () => {
    const { buildGeminiToolResponsesWithTables } = await import('../../src/server.js');
    const { resetConfig } = await import('../../src/config.js');
    process.env['TABLE_AS_IMAGE'] = 'off'; resetConfig();
    const off = await buildGeminiToolResponsesWithTables(bodyWith('toolu_o'), [
      { type: 'tool_result', tool_use_id: 'toolu_o', content: bigCsv },
    ]);
    expect(off[0].parts).toBeUndefined();
    delete process.env['TABLE_AS_IMAGE']; resetConfig();
    const err = await buildGeminiToolResponsesWithTables(bodyWith('toolu_e'), [
      { type: 'tool_result', tool_use_id: 'toolu_e', content: bigCsv, is_error: true } as AnthropicToolResultBlock,
    ]);
    expect(err[0].parts).toBeUndefined();
  });
});
