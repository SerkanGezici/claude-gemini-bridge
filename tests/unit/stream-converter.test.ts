import { describe, it, expect } from 'vitest';
import {
  generateMessageId,
  createMessageStartEvent,
  createContentBlockStart,
  createTextDelta,
  createContentBlockStop,
  createMessageDelta,
  createMessageStop,
  createToolUseBlockStart,
  createToolUseInputDelta,
  createErrorEvent,
  formatSSE,
} from '../../src/stream-converter.js';

describe('formatSSE', () => {
  it('Anthropic SSE wire formatını üretir', () => {
    const out = formatSSE({ event: 'ping', data: { type: 'ping' } });
    expect(out).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });
});

describe('event creators', () => {
  it('message_start input_tokens tahminini taşır', () => {
    const ev = createMessageStartEvent('msg_1', 'claude-x', 1234);
    expect(ev.event).toBe('message_start');
    const msg = ev.data['message'] as { usage: { input_tokens: number }; role: string };
    expect(msg.usage.input_tokens).toBe(1234);
    expect(msg.role).toBe('assistant');
  });

  it('message_start inputTokens verilmezse 0', () => {
    const ev = createMessageStartEvent('msg_1', 'claude-x');
    const msg = ev.data['message'] as { usage: { input_tokens: number } };
    expect(msg.usage.input_tokens).toBe(0);
  });

  it('text delta doğru index ve text taşır', () => {
    const ev = createTextDelta(2, 'parça');
    expect(ev.data).toEqual({
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'parça' },
    });
  });

  it('tool_use block start id+name taşır, input_json_delta partial_json taşır', () => {
    const start = createToolUseBlockStart(1, 'toolu_5', 'Read');
    expect((start.data['content_block'] as { id: string }).id).toBe('toolu_5');
    const delta = createToolUseInputDelta(1, '{"a":1}');
    expect((delta.data['delta'] as { partial_json: string }).partial_json).toBe('{"a":1}');
  });

  it('message_delta stop_reason + output_tokens taşır', () => {
    const ev = createMessageDelta('end_turn', 42);
    expect((ev.data['delta'] as { stop_reason: string }).stop_reason).toBe('end_turn');
    expect((ev.data['usage'] as { output_tokens: number }).output_tokens).toBe(42);
  });

  it('blok stop / message stop / error şekilleri doğru', () => {
    expect(createContentBlockStop(3).data['index']).toBe(3);
    expect(createMessageStop().data['type']).toBe('message_stop');
    const err = createErrorEvent('patladı');
    expect((err.data['error'] as { message: string }).message).toBe('patladı');
  });

  it('generateMessageId benzersiz id üretir', () => {
    expect(generateMessageId()).not.toBe(generateMessageId());
  });

  it('content_block_start text bloğu boş text ile başlar', () => {
    const ev = createContentBlockStart(0);
    expect(ev.data['content_block']).toEqual({ type: 'text', text: '' });
  });
});
