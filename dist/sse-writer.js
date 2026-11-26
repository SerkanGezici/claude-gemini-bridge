import { estimateOutputTokens } from './context-manager.js';
import { createMessageStartEvent, createContentBlockStart, createTextDelta, createContentBlockStop, createMessageDelta, createMessageStop, createToolUseBlockStart, createToolUseInputDelta, createErrorEvent, formatSSE, } from './stream-converter.js';
export class SSEWriter {
    raw;
    blockIndex = 0;
    _textBlockStarted = false;
    _totalChars = 0;
    _hasToolCalls = false;
    _dataWritten = false;
    constructor(raw) {
        this.raw = raw;
    }
    /** Partial SSE verisi gönderildi mi? handleStreaming retry guard'ı için. */
    get dataWritten() {
        return this._dataWritten;
    }
    /** Bu turda tool_use bloğu üretildi mi? */
    get hasToolCalls() {
        return this._hasToolCalls;
    }
    /** Akıtılan toplam metin karakteri (output token tahmini için). */
    get totalChars() {
        return this._totalChars;
    }
    /** SSE yanıt başlıklarını yazar (status 200 + event-stream). */
    writeHead() {
        this.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
    }
    /** message_start event'i — input token tahmini Claude Code context göstergesi için. */
    messageStart(messageId, model, inputTokens) {
        this.raw.write(formatSSE(createMessageStartEvent(messageId, model, inputTokens)));
    }
    /**
     * Tur-içi sayaçları sıfırlar (retry öncesi). dataWritten KASITLI sıfırlanmaz:
     * partial veri gönderildiyse handleStreaming zaten retry yapmaz (guard throw eder).
     */
    resetTurnState() {
        this.blockIndex = 0;
        this._textBlockStarted = false;
        this._totalChars = 0;
        this._hasToolCalls = false;
    }
    /** Metin chunk'ını text content_block'a yazar (boş chunk yok sayılır). */
    emitText(chunk) {
        if (chunk.length === 0)
            return;
        this._dataWritten = true;
        if (!this._textBlockStarted) {
            this.raw.write(formatSSE(createContentBlockStart(this.blockIndex)));
            this._textBlockStarted = true;
        }
        this.raw.write(formatSSE(createTextDelta(this.blockIndex, chunk)));
        this._totalChars += chunk.length;
    }
    /** Açık text content_block'u kapatır (varsa) ve blok indexini ilerletir. */
    closeTextBlock() {
        if (this._textBlockStarted) {
            this.raw.write(formatSSE(createContentBlockStop(this.blockIndex)));
            this.blockIndex++;
            this._textBlockStarted = false;
        }
    }
    /** Tool çağrılarını ayrı content_block'lar olarak yazar + tool_use ile turu kapatır. */
    emitToolCalls(tools) {
        this._dataWritten = true;
        this._hasToolCalls = true;
        this.closeTextBlock();
        for (const t of tools) {
            this.raw.write(formatSSE(createToolUseBlockStart(this.blockIndex, t.id, t.name)));
            this.raw.write(formatSSE(createToolUseInputDelta(this.blockIndex, JSON.stringify(t.input))));
            this.raw.write(formatSSE(createContentBlockStop(this.blockIndex)));
            this.blockIndex++;
        }
        this.raw.write(formatSSE(createMessageDelta('tool_use', estimateOutputTokens(this._totalChars, tools.length))));
        this.raw.write(formatSSE(createMessageStop()));
    }
    /** Metin turunu end_turn ile kapatır (açık text bloğu kapatılır). */
    endTurn() {
        this.closeTextBlock();
        this.raw.write(formatSSE(createMessageDelta('end_turn', estimateOutputTokens(this._totalChars, 0))));
        this.raw.write(formatSSE(createMessageStop()));
    }
    /** Empty-turn: hiç içerik yokken zarif kapanış (end_turn 0 token). */
    closeEmpty() {
        this.raw.write(formatSSE(createMessageDelta('end_turn', 0)));
        this.raw.write(formatSSE(createMessageStop()));
    }
    /** ERR-1: nihai hatada tek error event yazar (kapanmış response'ta sessizce yutar). */
    writeError(message, onClosed) {
        try {
            this.raw.write(formatSSE(createErrorEvent(message)));
        }
        catch {
            onClosed();
        }
    }
    /** SSE akışını sonlandırır (idempotent — birden fazla çağrı zararsız). */
    end() {
        this.raw.end();
    }
}
