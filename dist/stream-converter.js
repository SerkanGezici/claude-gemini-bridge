let messageCounter = 0;
export function generateMessageId() {
    return `msg_bridge_${++messageCounter}_${Date.now()}`;
}
export function resetMessageCounter() {
    messageCounter = 0;
}
// ── SSE Event Creators ──────────────────────────────────────
export function createMessageStartEvent(messageId, model, inputTokens = 0) {
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
export function createContentBlockStart(index) {
    return {
        event: 'content_block_start',
        data: {
            type: 'content_block_start',
            index,
            content_block: { type: 'text', text: '' },
        },
    };
}
export function createTextDelta(index, text) {
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
export function createToolUseBlockStart(index, id, name) {
    return {
        event: 'content_block_start',
        data: {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id, name, input: {} },
        },
    };
}
export function createToolUseInputDelta(index, partialJson) {
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
export function createContentBlockStop(index) {
    return {
        event: 'content_block_stop',
        data: {
            type: 'content_block_stop',
            index,
        },
    };
}
export function createMessageDelta(stopReason, outputTokens) {
    return {
        event: 'message_delta',
        data: {
            type: 'message_delta',
            delta: { stop_reason: stopReason },
            usage: { output_tokens: outputTokens },
        },
    };
}
export function createMessageStop() {
    return {
        event: 'message_stop',
        data: { type: 'message_stop' },
    };
}
export function createErrorEvent(message) {
    return {
        event: 'error',
        data: {
            type: 'error',
            error: { type: 'server_error', message },
        },
    };
}
// ── SSE Formatter ───────────────────────────────────────────
export function formatSSE(event) {
    return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
