// Dump edilen gerçek isteği transformer'dan geçirip Gemini'ye gidecek
// turn yapısını gösterir. Kullanım: npx tsx tests/probe-turns.ts <dump.json>
import { readFileSync } from 'fs';
import { buildSystemPrompt, toGeminiTurns } from '../../src/transformer.js';
import type { AnthropicRequest } from '../../src/types.js';

const file = process.argv[2];
const body = JSON.parse(readFileSync(file, 'utf8')) as AnthropicRequest;

const sys = buildSystemPrompt(body, 'BRIDGE');
console.log('system len:', sys.length);

const turns = toGeminiTurns(body.messages);
console.log('turn sayısı:', turns.length, '| toplam byte:',
  turns.reduce((s, t) => s + JSON.stringify(t).length, 0));
for (const t of turns) {
  const sizes = t.parts.map((p) => ('text' in p ? (p as { text: string }).text.length : '?'));
  const first = ((t.parts[0] as { text?: string }).text ?? '').slice(0, 70);
  console.log(' ', t.role.padEnd(5), 'parts:', sizes.join(','), '|', JSON.stringify(first));
}
