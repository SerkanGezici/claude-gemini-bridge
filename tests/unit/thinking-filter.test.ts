import { describe, it, expect } from 'vitest';
import { filterThinkingText, stripThoughtBlock } from '../../src/server.js';

// LIVE-21: 3.1'in <thought>...</thought> sızıntısı — non-streaming tam metinde temizlenir
describe('stripThoughtBlock (LIVE-21)', () => {
  it('baştaki kapalı <thought> bloğu temizlenir, verdict kalır', () => {
    const input = '<thought\nThinking Process:\n1. **Analyze the Request:** uzun monolog...\n</thought>\n<allow> Safe test command.';
    expect(stripThoughtBlock(input)).toBe('<allow> Safe test command.');
  });

  it('<thought attr="x"> varyantı da temizlenir (case-insensitive)', () => {
    const input = '  <THOUGHT signature="abc">iç monolog</thought>  Gerçek cevap.';
    expect(stripThoughtBlock(input)).toBe('Gerçek cevap.');
  });

  it('kapanmamış <thought> tag\'inde metin OLDUĞU GİBİ kalır (veri kaybı riski yok)', () => {
    const input = '<thought\nyarım kalan monolog ve cevap karışık';
    expect(stripThoughtBlock(input)).toBe(input);
  });

  it('thought içermeyen metin aynen geçer', () => {
    const input = 'Normal cevap — <allow> bile içerse dokunulmaz.';
    expect(stripThoughtBlock(input)).toBe(input);
  });

  it('metnin ORTASINDAKİ thought bloğuna dokunulmaz (sadece baştaki sızıntı hedef)', () => {
    const input = 'Cevap başı <thought>x</thought> devamı';
    expect(stripThoughtBlock(input)).toBe(input);
  });
});

describe('filterThinkingText', () => {
  it('bilinen thinking fiilli bold başlık + monolog ilk chunktan temizlenir', () => {
    const input = '**Analyzing the Request**\nI am processing the query now.\n\nMerhaba, yanıt burada.';
    expect(filterThinkingText(input, true)).toBe('Merhaba, yanıt burada.');
  });

  it('genel bold başlıklar (örn. **Summary**) DOKUNULMAZ — false positive önleme', () => {
    const input = '**Summary**\nÖnemli noktalar aşağıda.\n\nDetaylar...';
    expect(filterThinkingText(input, true)).toBe(input);
  });

  it('ilk chunk değilse hiç dokunulmaz', () => {
    const input = '**Calculating**\nthinking...\n\nasıl metin';
    expect(filterThinkingText(input, false)).toBe(input);
  });

  it('thinking içermeyen normal metin aynen geçer', () => {
    expect(filterThinkingText('Normal bir yanıt.', true)).toBe('Normal bir yanıt.');
  });

  it('tamamı thinking olan chunk boş string döner (caller atlar)', () => {
    const input = '**Processing**\nworking on it...\n\n';
    expect(filterThinkingText(input, true)).toBe('');
  });
});
