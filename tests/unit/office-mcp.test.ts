// ADR-0004: office MCP çekirdeği — araç listesi, argüman doğrulama, betik çağrısı.
import { describe, it, expect } from 'vitest';
import { handle, OFFICE_TOOLS, runOfficeTool, toolArgs } from '../../src/office.js';
import { OFFICE_TOOLS_PY } from '../../src/paths.js';

async function call(m: Record<string, unknown>): Promise<Record<string, unknown>> {
  let got: Record<string, unknown> = {};
  await handle(m as Parameters<typeof handle>[0], (r) => { got = r; });
  return got;
}

describe('office MCP', () => {
  it('tools/list iki aracı verir', async () => {
    const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((r['result'] as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(['office_inspect', 'office_compare']);
    expect(OFFICE_TOOLS[0]!.inputSchema.required).toEqual(['path']);
  });
  it('toolArgs: eksik argüman reddedilir, tam argüman betik komutuna çevrilir', () => {
    expect(toolArgs('office_inspect', {})).toBeNull();
    expect(toolArgs('office_compare', { original: 'a.xlsx' })).toBeNull();
    expect(toolArgs('office_inspect', { path: ' C:\\x.xlsx ' })).toEqual(['inspect', 'C:\\x.xlsx']);
    expect(toolArgs('office_compare', { original: 'a', edited: 'b' })).toEqual(['compare', 'a', 'b']);
    expect(toolArgs('bilinmeyen', { path: 'a' })).toBeNull();
  });
  it('tools/call eksik argümanda isError döner, betik çağrılmaz', async () => {
    const r = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'office_inspect', arguments: {} } });
    expect((r['result'] as { isError: boolean }).isError).toBe(true);
  });
  it('docenv yoksa kurulum yolunu söyler', async () => {
    const r = await runOfficeTool(['inspect', 'x.xlsx'], '/yok/python');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('--setup-docs');
  });
  it('betik gerçek Python ile çalışır: olmayan dosya → okunur hata', async () => {
    const r = await runOfficeTool(['inspect', '/yok/dosya.xlsx'], 'python3', OFFICE_TOOLS_PY);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('dosya yok');
  });
});
