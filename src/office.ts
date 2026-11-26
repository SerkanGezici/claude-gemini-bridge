// ADR-0004: `office` MCP sunucusunun çekirdeği (araç tanımları + JSON-RPC işleyici).
// İki belirleyici araç: office_inspect (yapı raporu) ve office_compare (orijinal ↔ yeni
// değer + biçim farkı). İş `assets/office_tools.py`'de, docenv Python'u ile koşar.
// Bağımlılıksız (MCP SDK yok). Giriş noktası: office-mcp.ts (stdio döngüsü).
import { spawn } from 'child_process';
import { OFFICE_TOOLS_PY, docenvPython } from './paths.js';

const TOOL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 60_000;

export const OFFICE_TOOLS = [
  {
    name: 'office_inspect',
    description:
      'Deterministic structure report of an existing Excel (.xlsx), Word (.docx), PowerPoint (.pptx), PDF or image file, ' +
      'BEFORE editing it: every sheet row classified (repeated block header rows, section titles, rows without values), ' +
      'number formats such as currency, bold/fill, column widths, merged cells, formulas; Word styles/runs/tables/header-footer; ' +
      'PDF pages, text layer, fonts; image size and EXIF. Lines starting with DİKKAT are constraints your edit must respect.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path (absolute, relative to the working directory, or C:\\...).' } },
      required: ['path'],
    },
  },
  {
    name: 'office_compare',
    description:
      'Compare the original file with your edited copy AFTER saving: values moved/removed, number format, bold, fill and ' +
      'style losses, block headers the change missed, page/text-layer/EXIF losses, Excel files that will open with a repair ' +
      'prompt. The SONUÇ line counts problems; fix every SORUN line and compare again before reporting.',
    inputSchema: {
      type: 'object',
      properties: {
        original: { type: 'string', description: 'Original (unchanged) file path.' },
        edited: { type: 'string', description: 'Edited output file path.' },
      },
      required: ['original', 'edited'],
    },
  },
];

export function toolArgs(name: string, a: Record<string, unknown>): string[] | null {
  const s = (k: string): string | null => (typeof a[k] === 'string' && (a[k] as string).trim() ? (a[k] as string).trim() : null);
  if (name === 'office_inspect') {
    const p = s('path');
    return p ? ['inspect', p] : null;
  }
  if (name === 'office_compare') {
    const o = s('original');
    const e = s('edited');
    return o && e ? ['compare', o, e] : null;
  }
  return null;
}

export function runOfficeTool(args: string[], python = docenvPython(), script = OFFICE_TOOLS_PY): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const p = spawn(python, ['-I', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => p.kill('SIGKILL'), TOOL_TIMEOUT_MS);
    // Parçalar sonda tek seferde UTF-8 çözülür (çok baytlı Türkçe karakter parça sınırında bölünmesin).
    p.stdout.on('data', (d: Buffer) => { out.push(d); });
    p.stderr.on('data', (d: Buffer) => { err.push(d); });
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `office araçları çalışmadı (${e.message}). Kurulum: claude-gemini --setup-docs` });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const o = Buffer.concat(out).toString('utf8').trim();
      const e = Buffer.concat(err).toString('utf8').trim();
      let text = o || e.split('\n').slice(-5).join('\n') || `çıkış kodu ${code}`;
      if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n…[${text.length - MAX_OUTPUT} karakter kırpıldı]`;
      resolve({ ok: code === 0, text });
    });
  });
}

export type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown> };

export function send(m: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
}

export async function handle(m: Msg, out: (m: Record<string, unknown>) => void = send): Promise<void> {
  if (m.id === undefined) return;
  switch (m.method) {
    case 'initialize':
      return out({ id: m.id, result: {
        protocolVersion: (m.params?.['protocolVersion'] as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'office', version: '1.0.0' },
      } });
    case 'ping':
      return out({ id: m.id, result: {} });
    case 'tools/list':
      return out({ id: m.id, result: { tools: OFFICE_TOOLS } });
    case 'tools/call': {
      const name = String(m.params?.['name'] ?? '');
      const args = toolArgs(name, (m.params?.['arguments'] ?? {}) as Record<string, unknown>);
      if (!args) {
        return out({ id: m.id, result: { isError: true, content: [{ type: 'text', text: `${name}: eksik ya da bilinmeyen argüman` }] } });
      }
      const r = await runOfficeTool(args);
      return out({ id: m.id, result: { isError: !r.ok, content: [{ type: 'text', text: r.text }] } });
    }
    default:
      return out({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}
