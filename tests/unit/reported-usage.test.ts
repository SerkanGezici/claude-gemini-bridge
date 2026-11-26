import { describe, it, expect } from 'vitest';
import { reportedInputTokens, estimateMessageTokens, CLAUDE_AUTO_COMPACT_TRIGGER_TOKENS } from '../../src/context-manager.js';

const msgs = (chars: number) => [{ role: 'user' as const, content: 'x'.repeat(chars) }];

describe('LONGCTX-1 reportedInputTokens', () => {
  it('mesaj tahmini compactAt\'a ulaşınca Claude Code tetik eşiği (80K) bildirilir', () => {
    const m = msgs(120_000);
    const est = estimateMessageTokens(m);
    expect(reportedInputTokens(m, est)).toBe(CLAUDE_AUTO_COMPACT_TRIGGER_TOKENS);
  });

  it('ölçek doğrusal: yarısında 40K', () => {
    const m = msgs(60_000);
    const est = estimateMessageTokens(m);
    expect(reportedInputTokens(m, est * 2)).toBe(CLAUDE_AUTO_COMPACT_TRIGGER_TOKENS / 2);
  });

  it('0 (kapalı) ya da tetikten büyük compactAt → ham tahmin', () => {
    const m = msgs(10_000);
    expect(reportedInputTokens(m, 0)).toBe(estimateMessageTokens(m));
    expect(reportedInputTokens(m, 90_000)).toBe(estimateMessageTokens(m));
  });
});
