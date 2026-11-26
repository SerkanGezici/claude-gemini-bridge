// PAPERCUT-1 (Uber "log-papercut"): Gemini'nin takıldığı anların kısa kaydı —
// ne denedi / ne oldu. `logs/papercuts.jsonl`, satır başına bir JSON. Kalite işleri
// (talimat, araç eşleme, sınav görevi) buradan beslenir. Yerel dosya; içerik kırpılır.
// Kapatma: PAPERCUTS=off (config). Kayıt hatası isteği asla etkilemez.
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { LOGS_DIR } from './paths.js';
import { getConfig } from './config.js';
import type { AnthropicMessage } from './types.js';

export const PAPERCUTS_FILE = join(LOGS_DIR, 'papercuts.jsonl');
const SNIP = 300;

export type PapercutKind = 'tool_error' | 'bridge_500' | 'bridge_error' | 'empty_turn' | 'tool_timeout';

function snip(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > SNIP ? `${s.slice(0, SNIP)}…` : s;
}

export function recordPapercut(kind: PapercutKind, detail: Record<string, unknown>, file = PAPERCUTS_FILE): void {
  // Anahtar yalnız varsayılan dosyayı yönetir (config: PAPERCUTS=off, testlerde kapalı);
  // açık dosya verilen çağrı (birim test) her zaman yazar.
  if (file === PAPERCUTS_FILE) {
    try { if (!getConfig().papercuts) return; } catch { return; }
  }
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const row: Record<string, unknown> = { ts: new Date().toISOString(), kind };
    for (const [k, v] of Object.entries(detail)) row[k] = typeof v === 'number' || typeof v === 'boolean' ? v : snip(v);
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch { /* kayıt başarısızlığı isteği etkilemez */ }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join(' ');
  return '';
}

/**
 * Son kullanıcı mesajındaki hatalı araç sonuçları (is_error). Claude Code her
 * istekte tüm geçmişi yollar; yalnız SON mesaj yenidir → çift kayıt olmaz.
 */
export function toolErrorsInLastMessage(messages: AnthropicMessage[]): Array<{ tool: string; input: unknown; error: string }> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return [];
  const uses = new Map<string, { name: string; input: unknown }>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === 'tool_use') uses.set(b.id, { name: b.name, input: b.input });
  }
  const out: Array<{ tool: string; input: unknown; error: string }> = [];
  for (const b of last.content) {
    if (b.type !== 'tool_result' || !b.is_error) continue;
    const u = uses.get(b.tool_use_id);
    out.push({ tool: u?.name ?? 'unknown', input: u?.input ?? null, error: textOf(b.content) });
  }
  return out;
}

export function recordToolErrors(messages: AnthropicMessage[], file = PAPERCUTS_FILE): number {
  const errs = toolErrorsInLastMessage(messages);
  for (const e of errs) recordPapercut('tool_error', { tool: e.tool, input: e.input, error: e.error }, file);
  return errs.length;
}
