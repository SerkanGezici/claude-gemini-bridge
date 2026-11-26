// Kayıtlı bir sonuç dosyasındaki YALNIZ METİN puanlanan görevleri güncel
// puanlayıcıyla yeniden puanlar (puanlayıcı düzeltmesinden sonra; dosya
// yazan görevler sandbox silindiği için yeniden puanlanamaz).
// Kullanım: npx tsx tests/eval/rescore.ts <sonuc.json> <ID,ID,...>
import { readFileSync, writeFileSync } from 'fs';
import { TASKS } from './tasks.js';

const [file, idsArg] = process.argv.slice(2);
if (!file || !idsArg) throw new Error('Kullanım: rescore.ts <sonuc.json> <ID,ID>');
const ids = idsArg.split(',');
const data = JSON.parse(readFileSync(file, 'utf8')) as {
  score: number;
  byLevel: Array<{ level: number; score: number; medianSeconds: number }>;
  rows: Array<{ id: string; level: number; soft: boolean; score: number; turns?: number; notes: string[]; answer: string }>;
  rescored?: string[];
};

for (const row of data.rows) {
  if (!ids.includes(row.id)) continue;
  const task = TASKS.find((t) => t.id === row.id);
  if (!task) continue;
  const g = task.grade({ text: row.answer, dir: '/nonexistent', numTurns: row.turns });
  console.log(`${row.id}: ${(row.score * 100).toFixed(0)}% → ${(g.score * 100).toFixed(0)}%`);
  row.score = g.score;
  row.notes = [...row.notes.filter((n) => n.startsWith('⚠')), ...g.notes];
}
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
data.score = avg(data.rows.filter((r) => !r.soft).map((r) => r.score));
for (const b of data.byLevel) b.score = avg(data.rows.filter((r) => r.level === b.level && !r.soft).map((r) => r.score));
data.rescored = [...new Set([...(data.rescored ?? []), ...ids])];
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
console.log(`TOPLAM (soft hariç): ${(data.score * 100).toFixed(1)}%`);
