// Empty-turn bisect probe'u — m9 dump'ının varyantlarını bridge'e gönderir,
// hangi bileşenin Gemini'yi susturduğunu izole eder.
// Kullanım: bridge 8002'de açıkken `npx tsx tests/probe-empty.ts <dump.json>`
import { readFileSync } from 'fs';
import type { AnthropicRequest, AnthropicMessage } from '../../src/types.js';

const BASE = 'http://127.0.0.1:8002';
const HEADERS = { 'Content-Type': 'application/json', 'x-api-key': 'live-test-token' };

const original = JSON.parse(readFileSync(process.argv[2], 'utf8')) as AnthropicRequest;

function clone(): AnthropicRequest {
  return JSON.parse(JSON.stringify(original)) as AnthropicRequest;
}

const isContinueMsg = (m: AnthropicMessage): boolean =>
  typeof m.content === 'string'
    ? m.content === 'Continue from where you left off.'
    : Array.isArray(m.content) &&
      m.content.some((b) => b.type === 'text' && b.text === 'Continue from where you left off.');

const variants: Array<{ name: string; build: () => AnthropicRequest }> = [
  { name: 'E0 orijinal (m9 birebir)', build: clone },
  {
    name: 'E1 role:system mesajları YOK',
    build: () => {
      const b = clone();
      b.messages = b.messages.filter((m) => m.role !== 'system');
      return b;
    },
  },
  {
    name: 'E2 "Continue from..." turn YOK',
    build: () => {
      const b = clone();
      b.messages = b.messages
        .map((m) => {
          if (typeof m.content === 'string') return isContinueMsg(m) ? null : m;
          if (!Array.isArray(m.content)) return m;
          const filtered = m.content.filter(
            (blk) => !(blk.type === 'text' && blk.text === 'Continue from where you left off.'),
          );
          return filtered.length === 0 ? null : { ...m, content: filtered };
        })
        .filter((m): m is AnthropicMessage => m !== null);
      return b;
    },
  },
  {
    name: 'E3 system-reminder partı YOK',
    build: () => {
      const b = clone();
      b.messages = b.messages.map((m) => {
        if (!Array.isArray(m.content)) return m;
        const filtered = m.content.filter(
          (blk) => !(blk.type === 'text' && blk.text.startsWith('<system-reminder>')),
        );
        return filtered.length === 0 ? m : { ...m, content: filtered };
      });
      return b;
    },
  },
  {
    name: 'E4 request.system YOK (CC system promptu)',
    build: () => {
      const b = clone();
      delete (b as unknown as Record<string, unknown>)["system"];
      return b;
    },
  },
  {
    name: 'E5 E1+E4 (tüm system kaynakları YOK)',
    build: () => {
      const b = clone();
      b.messages = b.messages.filter((m) => m.role !== 'system');
      delete (b as unknown as Record<string, unknown>)["system"];
      return b;
    },
  },
];

interface Resp {
  content: Array<{ type: string; text?: string; name?: string }>;
  stop_reason: string;
}

for (const v of variants) {
  const body = v.build();
  body.stream = false;
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      console.log(`[${v.name}] → HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      continue;
    }
    const data = (await res.json()) as Resp;
    const text = (data.content.find((c) => c.type === 'text')?.text ?? '').trim();
    const tool = data.content.find((c) => c.type === 'tool_use');
    console.log(`[${v.name}] → ${text ? `TEXT: "${text.slice(0, 80)}"` : tool ? `TOOL: ${tool.name}` : 'BOŞ ❌'}`);
  } catch (err) {
    console.log(`[${v.name}] → HATA: ${err instanceof Error ? err.message : String(err)}`);
  }
}
