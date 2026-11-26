// PAPERCUT-1: takılma kayıtları — yalnız son mesajın hatalı araç sonuçları, kırpma, kapatma.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordPapercut, recordToolErrors, toolErrorsInLastMessage } from '../../src/papercuts.js';
import type { AnthropicMessage } from '../../src/types.js';

const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'pc-')), 'p.jsonl');
afterEach(() => { delete process.env['PAPERCUTS']; });

const msgs: AnthropicMessage[] = [
  { role: 'user', content: 'dosyayı yaz' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__windows-mcp__Type', input: { text: 'x' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'Either loc or label must be provided' }] }] },
] as never;

describe('PAPERCUT-1', () => {
  it('son mesajdaki hatalı araç sonucunu araç adı + girdiyle kaydeder', () => {
    const f = tmp();
    expect(recordToolErrors(msgs, f)).toBe(1);
    const row = JSON.parse(readFileSync(f, 'utf8').trim());
    expect(row.kind).toBe('tool_error');
    expect(row.tool).toBe('mcp__windows-mcp__Type');
    expect(row.error).toContain('loc or label');
    expect(row.input).toContain('"text":"x"');
  });

  it('eski mesajlardaki hatalar tekrar sayılmaz; hatasız sonuç kaydedilmez', () => {
    const later = [...msgs,
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }] as never;
    expect(toolErrorsInLastMessage(later)).toEqual([]);
  });

  it('uzun içerik kırpılır; PAPERCUTS=off config anahtarını kapatır', async () => {
    const f = tmp();
    recordPapercut('bridge_error', { error: 'x'.repeat(1000) }, f);
    expect(JSON.parse(readFileSync(f, 'utf8')).error.length).toBeLessThan(320);
    const { getConfig, resetConfig } = await import('../../src/config.js');
    process.env['GEMINI_API_KEY'] ??= 'test-key';
    process.env['PAPERCUTS'] = 'off';
    resetConfig();
    expect(getConfig().papercuts).toBe(false);
    resetConfig();
  });
});
