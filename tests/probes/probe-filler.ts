// "Let me check" filler bisect probe'u — tool sonrası model neden görevi bitirmiyor?
// 4 vaka: system prompt (yok|büyük) × tool sayısı (1|25). Bridge üzerinden gerçek API.
// Kullanım: bridge 8002'de açıkken `npx tsx tests/probe-filler.ts`
const BASE = 'http://127.0.0.1:8002';
const HEADERS = { 'Content-Type': 'application/json', 'x-api-key': 'live-test-token' };

const LIST_TOOL = {
  name: 'list_files',
  description: 'Çalışma klasöründeki dosyaları listeler',
  input_schema: { type: 'object', properties: {}, required: [] },
};

// Claude Code'unkine benzer 24 dolgu tool (toplam 25)
const FILLER_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'NotebookEdit', 'Skill', 'Agent', 'LSP', 'Monitor',
  'CronCreate', 'CronList', 'SendMessage', 'TeamCreate', 'PushNotification', 'ExitPlanMode',
  'EnterPlanMode', 'ToolSearch'].map((name) => ({
  name,
  description: `${name} aracı — geliştirme ortamı işlemi yapar`,
  input_schema: { type: 'object', properties: { arg: { type: 'string' } }, required: [] },
}));

// Claude Code system prompt'una benzer agentic + uzun system (~20KB)
const BIG_SYSTEM =
  'You are Claude Code, an interactive CLI agent. Use the available tools to complete tasks. ' +
  'Answer concisely. When you need information, call a tool. After tool results, continue the task. ' +
  'Kurallar ve ortam bilgisi:\n' + 'Detaylı kural satırı: araçları doğru kullan, kısa yanıt ver.\n'.repeat(380);

interface Resp {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason: string;
}

async function post(body: Record<string, unknown>): Promise<Resp> {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<Resp>;
}

async function runCase(name: string, system: string | undefined, tools: unknown[]): Promise<void> {
  const userMsg = {
    role: 'user',
    content: 'Klasördeki dosyaları list_files ile listele ve bana kaç dosya olduğunu tek cümleyle söyle.',
  };
  const base: Record<string, unknown> = {
    model: 'claude-fable-5', stream: false, max_tokens: 1024, tools,
    ...(system ? { system } : {}),
  };
  try {
    const r1 = await post({ ...base, messages: [userMsg] });
    const toolUse = r1.content.find((c) => c.type === 'tool_use');
    if (!toolUse) {
      console.log(`[${name}] → TOOL ÇAĞRILMADI; text="${r1.content.find((c) => c.type === 'text')?.text?.slice(0, 80)}"`);
      return;
    }
    const r2 = await post({
      ...base,
      messages: [
        userMsg,
        { role: 'assistant', content: r1.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result', tool_use_id: toolUse.id,
            content: 'README.md\nalisveris.txt\nnotlar.csv',
          }],
        },
      ],
    });
    const text = (r2.content.find((c) => c.type === 'text')?.text ?? '').trim();
    const nextTool = r2.content.find((c) => c.type === 'tool_use');
    console.log(`[${name}] → tool=${toolUse.name} | devam: stop=${r2.stop_reason}${nextTool ? ` nextTool=${nextTool.name}` : ''} text="${text.slice(0, 100)}"`);
  } catch (err) {
    console.log(`[${name}] → HATA: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await runCase('F1 system=YOK  tools=1 ', undefined, [LIST_TOOL]);
await runCase('F2 system=20KB tools=1 ', BIG_SYSTEM, [LIST_TOOL]);
await runCase('F3 system=YOK  tools=25', undefined, [LIST_TOOL, ...FILLER_TOOLS]);
await runCase('F4 system=20KB tools=25', BIG_SYSTEM, [LIST_TOOL, ...FILLER_TOOLS]);
