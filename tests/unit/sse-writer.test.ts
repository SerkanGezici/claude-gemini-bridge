// TD-007: SSEWriter, handleStreaming + handleToolResponseStreaming arasında
// BİREBİR tekrar eden SSE event yazımını tek yerde topluyor. Bu test, çıkarılan
// helper'ın event sırası / blockIndex / token heuristic'ini eski inline koddaki
// davranışla AYNI tuttuğunu (davranış-koruma) kilitler.
import { describe, it, expect } from 'vitest';
import { SSEWriter } from '../../src/sse-writer.js';

function mockRaw() {
  const chunks: string[] = [];
  const raw = {
    writeHead: () => {},
    write: (s: string) => { chunks.push(s); return true; },
    end: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { chunks, raw };
}

interface ParsedEvent { event: string; data: Record<string, unknown> }
function parsed(chunks: string[]): ParsedEvent[] {
  return chunks
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map((blk) => ({
      event: blk.match(/^event: (.+)$/m)![1],
      data: JSON.parse(blk.match(/^data: (.+)$/m)![1]),
    }));
}
function names(chunks: string[]): string[] {
  return parsed(chunks).map((p) => p.event);
}

describe('SSEWriter', () => {
  it('emitText: ilk chunk block açar, sonraki sadece delta; boş chunk yok sayılır', () => {
    const { chunks, raw } = mockRaw();
    const w = new SSEWriter(raw);
    w.emitText('ab');
    w.emitText('cd');
    w.emitText(''); // no-op
    expect(names(chunks)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
    ]);
    expect(w.totalChars).toBe(4);
    expect(w.dataWritten).toBe(true);
  });

  it('emitToolCalls: açık text bloğunu kapatır, tool bloklarını yazar, tool_use ile biter', () => {
    const { chunks, raw } = mockRaw();
    const w = new SSEWriter(raw);
    w.emitText('hi'); // totalChars=2
    w.emitToolCalls([{ id: 't1', name: 'Read', input: { file: 'a' } }]);
    expect(names(chunks)).toEqual([
      'content_block_start', // text
      'content_block_delta', // text delta
      'content_block_stop',  // text kapandı
      'content_block_start', // tool
      'content_block_delta', // tool input
      'content_block_stop',  // tool kapandı
      'message_delta',
      'message_stop',
    ]);
    expect(w.hasToolCalls).toBe(true);
    const md = parsed(chunks).find((p) => p.event === 'message_delta')!.data;
    expect((md['delta'] as Record<string, unknown>)['stop_reason']).toBe('tool_use');
    // token: ceil(2/4)=1 + 1*20 = 21
    expect((md['usage'] as Record<string, unknown>)['output_tokens']).toBe(21);
  });

  it('endTurn: açık text bloğunu kapatır + end_turn (token=ceil(chars/4))', () => {
    const { chunks, raw } = mockRaw();
    const w = new SSEWriter(raw);
    w.emitText('hello'); // 5 char
    w.endTurn();
    expect(names(chunks)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const md = parsed(chunks).find((p) => p.event === 'message_delta')!.data;
    expect((md['delta'] as Record<string, unknown>)['stop_reason']).toBe('end_turn');
    expect((md['usage'] as Record<string, unknown>)['output_tokens']).toBe(2); // ceil(5/4)
  });

  it('resetTurnState: tur sayaçlarını sıfırlar ama dataWritten\'ı korur', () => {
    const { raw } = mockRaw();
    const w = new SSEWriter(raw);
    w.emitText('abcd');
    expect(w.totalChars).toBe(4);
    w.resetTurnState();
    expect(w.totalChars).toBe(0);
    expect(w.hasToolCalls).toBe(false);
    expect(w.dataWritten).toBe(true); // partial veri kalıcı
  });

  it('closeEmpty: içerik yokken end_turn 0 token', () => {
    const { chunks, raw } = mockRaw();
    const w = new SSEWriter(raw);
    w.closeEmpty();
    expect(names(chunks)).toEqual(['message_delta', 'message_stop']);
    const md = parsed(chunks).find((p) => p.event === 'message_delta')!.data;
    expect((md['delta'] as Record<string, unknown>)['stop_reason']).toBe('end_turn');
    expect((md['usage'] as Record<string, unknown>)['output_tokens']).toBe(0);
  });
});
