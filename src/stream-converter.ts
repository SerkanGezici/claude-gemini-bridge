import type { SSEEvent } from './types.js';
 
let messageCounter = 0;
 
export function generateMessageId(): string {
  return `msg_bridge_${++messageCounter}_${Date.now()}`;
}
 
export function resetMessageCounter(): void {
  messageCounter = 0;
}
 
// ── SSE Event Creators ──────────────────────────────────────
 
export function createMessageStartEvent(
  messageId: string,
  model: string,
  inputTokens = 0,
): SSEEvent {
  return {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    },
  };
}
 
export function createContentBlockStart(index: number): SSEEvent {
  return {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    },
  };
}
 
export function createTextDelta(index: number, text: string): SSEEvent {
  return {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    },
  };
}
 
// ── Tool Use SSE Events ─────────────────────────────────────
 
export function createToolUseBlockStart(
  index: number,
  id: string,
  name: string,
): SSEEvent {
  return {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
  };
}
 
export function createToolUseInputDelta(index: number, partialJson: string): SSEEvent {
  return {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: partialJson },
    },
  };
}
 
// ── Block Events ────────────────────────────────────────────
 
export function createContentBlockStop(index: number): SSEEvent {
  return {
    event: 'content_block_stop',
    data: {
      type: 'content_block_stop',
      index,
    },
  };
}
 
export function createMessageDelta(stopReason: string, outputTokens: number): SSEEvent {
  return {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: stopReason },
      usage: { output_tokens: outputTokens },
    },
  };
}
 
export function createMessageStop(): SSEEvent {
  return {
    event: 'message_stop',
    data: { type: 'message_stop' },
  };
}
 
export function createErrorEvent(message: string): SSEEvent {
  return {
    event: 'error',
    data: {
      type: 'error',
      error: { type: 'server_error', message },
    },
  };
}
 
// ── SSE Formatter ───────────────────────────────────────────
 
export function formatSSE(event: SSEEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
 