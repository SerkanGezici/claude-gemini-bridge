import type { ServerResponse } from 'http';
import { estimateOutputTokens } from './context-manager.js';
import {
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
} from './stream-converter.js';

// ── SSE Yazıcı (TD-007) ──────────────────────────────────────
// handleStreaming + handleToolResponseStreaming, Anthropic SSE event'lerini
// üreten BİREBİR aynı blokları (header/message_start, text-delta emit, tool_use
// blokları, end_turn kapanışı) tekrar ediyordu. SSEWriter bu yazım mantığını tek
// yerde toplar — çağıran handler'ların KONTROL AKIŞI (retry/empty-turn/LIVE-20
// fake-tool buffer/dataWritten guard) değişmeden kalır. Davranış bit-for-bit
// korunur: event sırası, blockIndex artışı ve token heuristic'i eski kodla aynıdır.

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export class SSEWriter {
  private raw: ServerResponse;
  private blockIndex = 0;
  private _textBlockStarted = false;
  private _totalChars = 0;
  private _hasToolCalls = false;
  private _dataWritten = false;

  constructor(raw: ServerResponse) {
    this.raw = raw;
  }

  /** Partial SSE verisi gönderildi mi? handleStreaming retry guard'ı için. */
  get dataWritten(): boolean {
    return this._dataWritten;
  }

  /** Bu turda tool_use bloğu üretildi mi? */
  get hasToolCalls(): boolean {
    return this._hasToolCalls;
  }

  /** Akıtılan toplam metin karakteri (output token tahmini için). */
  get totalChars(): number {
    return this._totalChars;
  }

  /** SSE yanıt başlıklarını yazar (status 200 + event-stream). */
  writeHead(): void {
    this.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  /** message_start event'i — input token tahmini Claude Code context göstergesi için. */
  messageStart(messageId: string, model: string, inputTokens: number): void {
    this.raw.write(formatSSE(createMessageStartEvent(messageId, model, inputTokens)));
  }

  /**
   * Tur-içi sayaçları sıfırlar (retry öncesi). dataWritten KASITLI sıfırlanmaz:
   * partial veri gönderildiyse handleStreaming zaten retry yapmaz (guard throw eder).
   */
  resetTurnState(): void {
    this.blockIndex = 0;
    this._textBlockStarted = false;
    this._totalChars = 0;
    this._hasToolCalls = false;
  }

  /** Metin chunk'ını text content_block'a yazar (boş chunk yok sayılır). */
  emitText(chunk: string): void {
    if (chunk.length === 0) return;
    this._dataWritten = true;
    if (!this._textBlockStarted) {
      this.raw.write(formatSSE(createContentBlockStart(this.blockIndex)));
      this._textBlockStarted = true;
    }
    this.raw.write(formatSSE(createTextDelta(this.blockIndex, chunk)));
    this._totalChars += chunk.length;
  }

  /** Açık text content_block'u kapatır (varsa) ve blok indexini ilerletir. */
  private closeTextBlock(): void {
    if (this._textBlockStarted) {
      this.raw.write(formatSSE(createContentBlockStop(this.blockIndex)));
      this.blockIndex++;
      this._textBlockStarted = false;
    }
  }

  /** Tool çağrılarını ayrı content_block'lar olarak yazar + tool_use ile turu kapatır. */
  emitToolCalls(tools: ToolUseBlock[]): void {
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
  endTurn(): void {
    this.closeTextBlock();
    this.raw.write(formatSSE(createMessageDelta('end_turn', estimateOutputTokens(this._totalChars, 0))));
    this.raw.write(formatSSE(createMessageStop()));
  }

  /** Empty-turn: hiç içerik yokken zarif kapanış (end_turn 0 token). */
  closeEmpty(): void {
    this.raw.write(formatSSE(createMessageDelta('end_turn', 0)));
    this.raw.write(formatSSE(createMessageStop()));
  }

  /** ERR-1: nihai hatada tek error event yazar (kapanmış response'ta sessizce yutar). */
  writeError(message: string, onClosed: () => void): void {
    try {
      this.raw.write(formatSSE(createErrorEvent(message)));
    } catch {
      onClosed();
    }
  }

  /** SSE akışını sonlandırır (idempotent — birden fazla çağrı zararsız). */
  end(): void {
    this.raw.end();
  }
}
