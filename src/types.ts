// ============================================================
// Anthropic Messages API Types
// ============================================================
 
export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicContentBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
  metadata?: Record<string, unknown>;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}
 
export interface AnthropicMessage {
  // 'system': Anthropic API'de yok ama Claude Code 2.1.x messages[] içine
  // role:"system" metadata mesajları koyuyor (hook çıktısı, MCP talimatları,
  // skill kataloğu) — 2026-06-11 canlı dump kanıtı.
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicContentBlock[];
}
 
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;
 
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
 
export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}
 
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
 
export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
}
 
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
 
// ============================================================
// SSE Event Types (Anthropic Streaming)
// ============================================================
 
export type SSEEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping'
  | 'error';
 
export interface SSEEvent {
  event: SSEEventType;
  data: Record<string, unknown>;
}
 
// ============================================================
// Gemini Live API Types
// ============================================================
 
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiSchema;
}
 
/** Gemini functionDeclaration şeması (sanitizeSchema çıktısı). anyOf varken type YOKTUR. */
export interface GeminiSchema {
  type?: string;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  description?: string;
  enum?: unknown[];
  anyOf?: GeminiSchema[];
  nullable?: boolean;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  propertyOrdering?: string[];
}
 
export interface GeminiTurn {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
 
export type GeminiPart =
  | { text: string; thought?: boolean }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; id?: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; id?: string; response: Record<string, unknown> } };
 
 