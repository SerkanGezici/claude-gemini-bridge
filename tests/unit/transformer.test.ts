import { describe, it, expect } from 'vitest';
import {
  extractSystemPrompt,
  buildSystemPrompt,
  toGeminiTurns,
  flattenTurnsToSingleUser,
  scrubFlattenMarkers,
  SYSTEM_PROMPT_MAX_CHARS,
  TURNS_BYTE_BUDGET,
  TOOL_RESULT_MAX_CHARS,
  TURN_TEXT_MAX_CHARS,
} from '../../src/transformer.js';
import type { AnthropicMessage, AnthropicRequest } from '../../src/types.js';

const req = (overrides: Partial<AnthropicRequest>): AnthropicRequest => ({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [],
  ...overrides,
});

describe('extractSystemPrompt', () => {
  it('string system promptu aynen döner', () => {
    expect(extractSystemPrompt(req({ system: 'Sen bir asistansın.' }))).toBe('Sen bir asistansın.');
  });

  it('system yoksa undefined döner', () => {
    expect(extractSystemPrompt(req({}))).toBeUndefined();
  });

  it('blok dizisini newline ile birleştirir', () => {
    const result = extractSystemPrompt(
      req({ system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }),
    );
    expect(result).toBe('A\nB');
  });

  it(`${SYSTEM_PROMPT_MAX_CHARS} karakter üstünü kırpar (string ve blok formu)`, () => {
    const big = 'x'.repeat(SYSTEM_PROMPT_MAX_CHARS + 5_000);
    for (const system of [big, [{ type: 'text' as const, text: big }]]) {
      const result = extractSystemPrompt(req({ system }))!;
      expect(result.length).toBe(SYSTEM_PROMPT_MAX_CHARS + 3); // + '...'
      expect(result.endsWith('...')).toBe(true);
    }
  });
});

// 2026-06-11 D2 probe kanıtı: gemini-3.1-flash-live clientContent'te 'model'
// rolü turn'leri 1007 ile reddediyor (3 minicik text turn bile). 3.x'te
// replay tek user-turn transkripte düzleştirilir (D3 probe: bağlam korunuyor).
describe('flattenTurnsToSingleUser', () => {
  it('çok turlu history tek user turn\'e düzleşir, etiketler ve son mesaj korunur', () => {
    const flat = flattenTurnsToSingleUser([
      { role: 'user', parts: [{ text: 'merhaba' }] },
      { role: 'model', parts: [{ text: 'Merhaba! Nasıl yardımcı olabilirim?' }] },
      { role: 'user', parts: [{ text: 'uygulamayı incele' }] },
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0].role).toBe('user');
    const text = (flat[0].parts[0] as { text: string }).text;
    expect(text).toContain('Kullanıcı: merhaba');
    expect(text).toContain('Asistan: Merhaba!');
    expect(text).toContain('uygulamayı incele');
  });

  it('tek turn aynen döner (düzleştirme gereksiz)', () => {
    const turns = [{ role: 'user' as const, parts: [{ text: 'soru' }] }];
    expect(flattenTurnsToSingleUser(turns)).toBe(turns);
  });

  it('başlık taklit uyarısı içerir (LIVE-20: model formatı kopyalıyordu)', () => {
    const flat = flattenTurnsToSingleUser([
      { role: 'user', parts: [{ text: 'a' }] },
      { role: 'user', parts: [{ text: 'b' }] },
    ]);
    const text = (flat[0].parts[0] as { text: string }).text;
    expect(text).toContain('taklit');
  });

  it('inlineData partları (görseller) ek part olarak korunur', () => {
    const flat = flattenTurnsToSingleUser([
      { role: 'user', parts: [{ text: 'şu görsele bak' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
      { role: 'model', parts: [{ text: 'bakıyorum' }] },
      { role: 'user', parts: [{ text: 'ne görüyorsun?' }] },
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0].parts.some((p) => 'inlineData' in p)).toBe(true);
  });
});

// LIVE-20: model flatten işaretçilerini cevaba sızdırabiliyor (canlı
// transcript kanıtı: "[Dökümün sonu]" kullanıcıya görünen yanıtta çıktı).
describe('scrubFlattenMarkers', () => {
  it('sızan işaretçileri temizler', () => {
    expect(scrubFlattenMarkers('cevap [Dökümün sonu]\nson')).toBe('cevap \nson');
    expect(scrubFlattenMarkers('[Önceki konuşmanın dökümü]x')).toBe('x');
  });

  it('normal metni değiştirmez', () => {
    const t = 'Ayşe\'nin puanı 92\'dir. [tool_result: Read] gibi geçmiş atıfları kalır.';
    expect(scrubFlattenMarkers(t)).toBe(t);
  });
});

// 2026-06-11 canlı dump kanıtı: Claude Code messages[] içine role:"system"
// metadata mesajları koyuyor (36KB hook, 28KB skill kataloğu ×2). Bunlar
// konuşma turn'ü DEĞİL — turns'e user olarak girince son turn katalog duvarı
// oluyordu → Gemini empty turn. Doğru eşleme: systemInstruction'a ekle.
describe('buildSystemPrompt', () => {
  it('bridge talimatı + request.system + system-role mesajlarını birleştirir', () => {
    const result = buildSystemPrompt(
      req({
        system: 'Sen bir asistansın.',
        messages: [
          { role: 'user', content: 'soru' },
          { role: 'system', content: 'MCP talimatları: xyz' },
        ],
      }),
      'BRIDGE-TALIMAT',
    );
    expect(result.startsWith('BRIDGE-TALIMAT')).toBe(true);
    expect(result).toContain('Sen bir asistansın.');
    expect(result).toContain('MCP talimatları: xyz');
  });

  it('birebir aynı system mesajını tekilleştirir (katalog 2x gönderiliyor)', () => {
    const catalog = 'skill kataloğu: '.padEnd(500, 'k');
    const result = buildSystemPrompt(
      req({
        messages: [
          { role: 'system', content: catalog },
          { role: 'user', content: 'soru' },
          { role: 'system', content: catalog },
        ],
      }),
      'B',
    );
    expect(result.indexOf(catalog.slice(0, 60))).toBe(result.lastIndexOf(catalog.slice(0, 60)));
  });

  it(`toplam ${SYSTEM_PROMPT_MAX_CHARS} karakteri aşmaz`, () => {
    const result = buildSystemPrompt(
      req({
        system: 'x'.repeat(20_000),
        messages: [
          { role: 'system', content: 'y'.repeat(40_000) },
          { role: 'user', content: 'soru' },
        ],
      }),
      'B',
    );
    expect(result.length).toBeLessThanOrEqual(SYSTEM_PROMPT_MAX_CHARS + 10);
  });
});

describe('toGeminiTurns', () => {
  it('system-role mesajları turn OLMAZ (systemInstruction\'a gider)', () => {
    const turns = toGeminiTurns([
      { role: 'user', content: 'soru' },
      { role: 'system', content: '28KB skill kataloğu ...' },
    ]);
    expect(turns).toHaveLength(1);
    expect((turns[0].parts[0] as { text: string }).text).toBe('soru');
  });

  it('ardışık aynı-rol turn\'ler birleştirilir (Gemini 3.x katı alternation)', () => {
    // 2026-06-11: Claude Code "Continue from where you left off." + soruyu AYRI
    // user mesajları olarak gönderiyor; gemini-3.1-flash-live ardışık user
    // turn'lerde 1007 verdi. 2.5 için de zararsız — her zaman birleştir.
    const turns = toGeminiTurns([
      { role: 'user', content: 'Continue from where you left off.' },
      { role: 'user', content: 'Peki ortalama kaç?' },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('user');
    expect(turns[0].parts).toHaveLength(2);
  });

  it('"No response requested." artefakt turn\'leri replay\'den süzülür', () => {
    // Boş yanıt → Claude Code "No response requested." kaydeder → replay'de
    // model kalıbı taklit edip yine susar (2026-06-11 m17 kanıtı). Artefaktı süz.
    const turns = toGeminiTurns([
      { role: 'user', content: 'soru 1' },
      { role: 'assistant', content: 'No response requested.' },
      { role: 'user', content: 'soru 2' },
    ]);
    // Artefakt süzülünce iki user mesajı ardışık kalır → tek turn'e birleşir
    expect(turns).toHaveLength(1);
    expect(turns[0].parts).toHaveLength(2);
    expect(turns.every((t) =>
      !JSON.stringify(t.parts).includes('No response requested'))).toBe(true);
  });

  it('canlı m14 regresyonu: son turn katalog değil, kullanıcı sorusu olur', () => {
    const turns = toGeminiTurns([
      { role: 'user', content: 'ilk soru' },
      { role: 'system', content: 'hook duvarı '.repeat(3_000) },
      { role: 'assistant', content: 'cevap 1' },
      { role: 'user', content: 'Peki notlar.csv?' },
      { role: 'system', content: 'skill kataloğu '.repeat(2_000) },
    ]);
    const last = turns[turns.length - 1];
    expect(last.role).toBe('user');
    expect((last.parts[0] as { text: string }).text).toBe('Peki notlar.csv?');
  });

  it('rolleri eşler: assistant→model, user→user', () => {
    const turns = toGeminiTurns([
      { role: 'user', content: 'soru' },
      { role: 'assistant', content: 'cevap' },
    ]);
    expect(turns).toEqual([
      { role: 'user', parts: [{ text: 'soru' }] },
      { role: 'model', parts: [{ text: 'cevap' }] },
    ]);
  });

  it('boş content mesajını atlar', () => {
    expect(toGeminiTurns([{ role: 'user', content: '' }])).toEqual([]);
  });

  // 2026-06-11 kanıtı (tests/probe-1007.ts): Live API, clientContent.turns
  // içinde functionCall VEYA functionResponse partı görünce 1007 ile kapanıyor.
  // Replay SALT-TEXT olmak zorunda (liveapideneme gemini_proxy.py:1703 pattern'i).
  it('tool_use → text temsili (functionCall partı replay\'de 1007 yapar)', () => {
    const turns = toGeminiTurns([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file: 'a.ts' } }],
      },
    ]);
    expect(turns[0].parts[0]).toEqual({
      text: '[tool_use: Read args={"file":"a.ts"}]',
    });
  });

  it('tool_result → text temsili, tool adını tool_use eşlemesinden bulur', () => {
    const turns = toGeminiTurns([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Grep', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'bulundu' }],
      },
    ]);
    expect(turns[1].parts[0]).toEqual({
      text: '[tool_result: Grep]\nbulundu',
    });
  });

  it('is_error tool_result → tool_error text temsili', () => {
    const turns = toGeminiTurns([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'patladı', is_error: true }],
      },
    ]);
    expect(turns[0].parts[0]).toEqual({
      text: '[tool_error: unknown_tool]\npatladı',
    });
  });

  it(`tool result ${TOOL_RESULT_MAX_CHARS} karakterde kırpılır`, () => {
    const turns = toGeminiTurns([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(TOOL_RESULT_MAX_CHARS * 2) },
        ],
      },
    ]);
    const part = turns[0].parts[0] as unknown as { text: string };
    expect(part.text.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 60);
    expect(part.text).toContain('truncated');
  });

  it('uzun tool_use input JSON\'u kırpılır', () => {
    const turns = toGeminiTurns([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Write', input: { content: 'z'.repeat(5_000) } },
        ],
      },
    ]);
    const part = turns[0].parts[0] as unknown as { text: string };
    expect(part.text.length).toBeLessThanOrEqual(1_200);
    expect(part.text).toContain('[tool_use: Write');
  });

  it('1007 regresyon korkuluğu: hiçbir part functionCall/functionResponse içermez', () => {
    const turns = toGeminiTurns([
      { role: 'user', content: 'merhaba' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'bakıyorum' },
          { type: 'tool_use', id: 'a', name: 'Skill', input: { skill: 'x' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'yüklendi' }] },
      { role: 'user', content: 'nasılsın' },
    ]);
    for (const turn of turns) {
      for (const part of turn.parts) {
        expect(Object.keys(part)).not.toContain('functionCall');
        expect(Object.keys(part)).not.toContain('functionResponse');
      }
    }
  });

  it('byte bütçesi: son mesaj HER ZAMAN dahil, eskiler bütçeye sığdıkça', () => {
    // Her biri ~10KB'lik 10 mesaj (rol dönüşümlü — ardışık birleşmesin)
    // → 48KB bütçeye ~4-5 tanesi sığar
    const big = 'm'.repeat(10_000);
    const messages: AnthropicMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: `${i}:${big}` });
    }
    const turns = toGeminiTurns(messages);
    expect(turns.length).toBeGreaterThan(1); // eski sabit-5'ten farklı: bütçe bazlı
    expect(turns.length).toBeLessThan(10);
    // En yeni mesaj korunmuş olmalı
    const lastText = (turns[turns.length - 1].parts[0] as { text: string }).text;
    expect(lastText.startsWith('9:')).toBe(true);
    // Toplam boyut bütçeyi aşmamalı (tek dev mesaj istisnası hariç)
    const total = turns.reduce((s, t) => s + JSON.stringify(t).length, 0);
    expect(total).toBeLessThanOrEqual(TURNS_BYTE_BUDGET + 11_000);
  });

  it('bütçeden büyük TEK mesaj bile olsa en az son mesaj gönderilir', () => {
    const turns = toGeminiTurns([
      { role: 'user', content: 'z'.repeat(TURNS_BYTE_BUDGET * 2) },
    ]);
    expect(turns.length).toBe(1);
  });

  // 2026-06-11 canlı kanıt (logs/requests dump): superpowers hook'u 36KB'lik
  // mesaj gönderiyor; atomik turn-drop bütçeyi yutup KULLANICININ SORUSUNU
  // düşürüyordu → Gemini görevsiz kalıp "Let me check" diyordu. Fix: part
  // başına text üst sınırı — turn düşmez, kırpılır.
  it(`tek text partı ${TURN_TEXT_MAX_CHARS} karakterde kırpılır`, () => {
    const turns = toGeminiTurns([
      { role: 'user', content: 'h'.repeat(TURN_TEXT_MAX_CHARS * 3) },
    ]);
    const part = turns[0].parts[0] as { text: string };
    expect(part.text.length).toBeLessThanOrEqual(TURN_TEXT_MAX_CHARS + 30);
    expect(part.text).toContain('truncated');
  });

  it('canlı regresyon: dev hook mesajı kullanıcı sorusunu DÜŞÜRMEZ', () => {
    // Gerçek akışın minyatürü: msg0 = [15KB reminder + kısa soru], msg1 = 36KB hook
    const turns = toGeminiTurns([
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>' + 'r'.repeat(15_000) + '</system-reminder>' },
          { type: 'text', text: 'Dosyaları listele ve kaç kalem alışveriş var söyle.' },
        ],
      },
      { role: 'user', content: 'EXTREMELY_IMPORTANT skill protokolü '.repeat(1_000) }, // ~36KB
    ]);
    // İki ardışık user mesajı tek turn'e birleşir; HİÇBİR İÇERİK düşmez
    expect(turns.length).toBe(1);
    expect(turns[0].parts.length).toBe(3);
    // Soru metni AYNEN ulaşmalı
    const allText = turns.flatMap((t) => t.parts).map((p) => (p as { text?: string }).text ?? '').join('\n');
    expect(allText).toContain('kaç kalem alışveriş');
  });

  it('image bloğu inlineData olur', () => {
    const turns = toGeminiTurns([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ]);
    expect(turns[0].parts[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'AAAA' },
    });
  });
});
