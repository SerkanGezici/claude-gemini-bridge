import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateMessageTokens,
  estimateOutputTokens,
  trimMessages,
} from '../../src/context-manager.js';
import type { AnthropicMessage } from '../../src/types.js';

describe('estimateTokens', () => {
  it('TOKEST-1: ÖLÇÜLEN 2.86 char/tok oranıyla yukarı yuvarlar (MODEL-MATRIX-1 canlı ölçüm; eski 3.5 ~%20-25 eksik tahmindi)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('x'.repeat(286))).toBe(100); // 286/2.86
    expect(estimateTokens('abcdefg')).toBe(3); // ceil(7/2.86)
    expect(estimateTokens('a')).toBe(1);
  });
});

describe('estimateMessageTokens', () => {
  it('string content + rol overhead sayar', () => {
    const tokens = estimateMessageTokens([{ role: 'user', content: 'abcdefg' }]);
    expect(tokens).toBe(3 + 4); // text (ceil(7/2.86)) + overhead
  });

  it('image bloğu sabit 258 token sayılır', () => {
    const tokens = estimateMessageTokens([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
        ],
      },
    ]);
    expect(tokens).toBe(258 + 4);
  });

  it('tool_use input + name dahil edilir', () => {
    const tokens = estimateMessageTokens([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'i', name: 'Read', input: { file: 'a' } }],
      },
    ]);
    expect(tokens).toBeGreaterThan(4);
  });
});

describe('estimateOutputTokens', () => {
  it('char/4 (yukarı yuvarlar) + tool*20', () => {
    expect(estimateOutputTokens(0, 0)).toBe(0);
    expect(estimateOutputTokens(10, 0)).toBe(3); // ceil(10/4)
    expect(estimateOutputTokens(0, 2)).toBe(40); // 2 tool
    expect(estimateOutputTokens(8, 1)).toBe(22); // 2 + 20
  });
});

describe('trimMessages', () => {
  it('limit altında dokunmaz', () => {
    const messages: AnthropicMessage[] = [
      { role: 'user', content: 'kısa' },
      { role: 'assistant', content: 'yanıt' },
    ];
    const { trimmed, removed } = trimMessages(messages);
    expect(trimmed).toEqual(messages);
    expect(removed).toBe(0);
  });

  it('limit üstünde en eskiden kırpar, son 2 mesajı korur', () => {
    // 250k token limitini aşmak için ~1M karakter
    const big = 'x'.repeat(200_000);
    const messages: AnthropicMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `${i}:${big}`,
    }));
    const { trimmed, removed } = trimMessages(messages);
    expect(removed).toBeGreaterThan(0);
    expect(trimmed.length).toBeGreaterThanOrEqual(2);
    expect(trimmed.length).toBeLessThan(messages.length);
    // En yeni mesaj korunmalı
    const last = trimmed[trimmed.length - 1];
    expect((last.content as string).startsWith('5:')).toBe(true);
  });
});
