// CU-1 (ADR-0003): `computer` MCP sunucusu (stdio, satır başına bir JSON-RPC mesajı).
// Tek araç: computer_task — Gemini computer use ile Windows masaüstünde görev.
// Bağımlılıksız (MCP SDK yok): initialize / tools/list / tools/call / ping yeterli.
// stdout YALNIZ protokol içindir — köprü logger'ı console'a yazdığı için console
// stderr'e yönlendirilir ve modüller ondan SONRA yüklenir.
import { createInterface } from 'readline';

for (const k of ['log', 'info', 'warn', 'debug'] as const) console[k] = (...a: unknown[]) => console.error(...a);

const TOOL = {
  name: 'computer_task',
  description:
    'Do a task on the user\'s real Windows desktop with mouse and keyboard, guided by screenshots ' +
    '(Gemini computer use). Give one concrete goal, e.g. "In the open Notepad window type X and press Ctrl+S". ' +
    'Prefer windows-mcp or a CLI when they can do the job; use this for visual, multi-step GUI work. ' +
    'Returns a summary, the actions taken and a final screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What to accomplish on screen, specific and self-contained.' },
      max_steps: { type: 'number', description: 'Action limit (default 12, max 25).' },
    },
    required: ['goal'],
  },
};

type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown> };

function send(m: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
}

async function handle(m: Msg): Promise<void> {
  if (m.id === undefined) return; // bildirim (notifications/initialized vb.)
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: {
        protocolVersion: (m.params?.['protocolVersion'] as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'computer', version: '1.0.0' },
      } });
    case 'ping':
      return send({ id: m.id, result: {} });
    case 'tools/list':
      return send({ id: m.id, result: { tools: [TOOL] } });
    case 'tools/call': {
      const args = (m.params?.['arguments'] ?? {}) as { goal?: string; max_steps?: number };
      if (m.params?.['name'] !== TOOL.name || !args.goal?.trim()) {
        return send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: 'computer_task needs a goal' }] } });
      }
      try {
        const { runComputerTask } = await import('./computer-use.js');
        const r = await runComputerTask(args.goal, args.max_steps);
        const text = `${r.ok ? 'BİTTİ' : 'BİTMEDİ'}: ${r.summary}\n\nEylemler (${r.steps.length}):\n${r.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') || '-'}`;
        const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
        if (r.screenshot) content.push({ type: 'image', data: r.screenshot, mimeType: 'image/jpeg' });
        return send({ id: m.id, result: { isError: !r.ok, content } });
      } catch (e) {
        return send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: `computer_task hata: ${(e as Error).message}` }] } });
      }
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let m: Msg;
  try { m = JSON.parse(line) as Msg; } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  void handle(m);
});
