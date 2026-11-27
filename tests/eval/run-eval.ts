// ORCH-0 sınav koşucusu — aynı görevleri gerçek `claude -p` ile iki hedefte
// koşturur ve puan + süre tablosu üretir. MOCK YOK.
//   --target claude  : referans (Anthropic, köprüsüz)
//   --target bridge  : bu köprü (Gemini); --model ile ana Live model seçilir
// Kullanım:
//   npx tsx tests/eval/run-eval.ts --target bridge [--model models/gemini-3.8-live] [--only W1,W9] [--label x] [--repeat 3]
// Bridge hedefi GEMINI_API_KEY'i ortamdan alır. Her görev geçici bir sandbox
// kopyasında çalışır; repo dosyalarına dokunulmaz.
import { spawn, execFileSync } from 'child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TASKS, type EvalTask, type Grade } from './tasks.js';
import { buildClaudeArgs } from '../../src/claude-args.js';
import { REPO, startBridge as startBridgeAt, stopBridge, bridgeEnv } from './bridge-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8031;
const TASK_TIMEOUT_MS = 420_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const target = arg('target') ?? 'bridge';
if (target !== 'bridge' && target !== 'claude') throw new Error('--target bridge|claude');
const model = arg('model') ?? 'models/gemini-3.1-flash-live-preview';
const only = arg('only')?.split(',').map((s) => s.trim());
const label = arg('label') ?? (target === 'bridge' ? model.replace('models/', '') : 'claude');
// EVAL-VAR-1: tek koşu karşılaştırma için yetmez (aynı kodda W9 30→76sn) → her görev N kez.
const repeat = Math.max(1, Number(arg('repeat') ?? 1));

function makeSandbox(fixtures: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orch0-'));
  cpSync(join(REPO, 'tests', 'workspace'), dir, { recursive: true });
  cpSync(fixtures, dir, { recursive: true });
  return dir;
}

interface ClaudeResult { text: string; numTurns?: number; isError: boolean; raw: string }

function runClaude(prompt: string, cwd: string, mcp = false): Promise<ClaudeResult> {
  const env: NodeJS.ProcessEnv = target === 'bridge' ? bridgeEnv(PORT) : { ...process.env };
  if (target !== 'bridge') delete env['ANTHROPIC_BASE_URL'];
  return new Promise((resolve) => {
    // Köprü hedefi gerçek `claude-gemini` ile AYNI argümanları alır
    // (buildClaudeArgs: davranış katmanı OCR-1/RECOVER-1/SKILL-GUARD + plugin
    // kapatma). Aksi hâlde ölçülen şey gerçek kullanım değildir.
    const base = ['-p', prompt, '--output-format', 'json'];
    if (mcp) {
      const cfg = join(cwd, '.eval-mcp.json');
      writeFileSync(cfg, JSON.stringify({ mcpServers: { stok: { command: 'python3', args: [join(HERE, 'stok_mcp.py'), join(cwd, '.mcp-calls.log')] } } }));
      base.push('--mcp-config', cfg);
    }
    const args = target === 'bridge' ? buildClaudeArgs(base) : [...base, '--dangerously-skip-permissions'];
    const p = spawn('claude', args, {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => { out += d; });
    p.stderr.on('data', (d: Buffer) => { err += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, TASK_TIMEOUT_MS);
    p.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out) as { result?: string; num_turns?: number; is_error?: boolean };
        resolve({ text: j.result ?? '', numTurns: j.num_turns, isError: !!j.is_error || code !== 0, raw: '' });
      } catch {
        resolve({ text: '', isError: true, raw: `exit=${code} ${err.slice(0, 300)} ${out.slice(0, 300)}` });
      }
    });
  });
}

interface Row { rep: number; id: string; level: number; title: string; soft: boolean; score: number; seconds: number; turns?: number; notes: string[]; answer: string }

async function main(): Promise<void> {
  const fixtures = mkdtempSync(join(tmpdir(), 'orch0-fx-'));
  execFileSync('python3', [join(HERE, 'gen_fixtures.py'), fixtures], { encoding: 'utf8' });
  execFileSync('python3', [join(HERE, 'gen_fixtures2.py'), fixtures], { encoding: 'utf8' }); // EVAL-2
  const tasks: EvalTask[] = only ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
  if (target === 'bridge') await startBridgeAt(PORT, model);

  const rows: Row[] = [];
  try {
    for (let rep = 1; rep <= repeat; rep++) for (const t of tasks) {
      const dir = makeSandbox(fixtures);
      const start = Date.now();
      const r = await runClaude(t.prompt, dir, !!t.mcp);
      const seconds = (Date.now() - start) / 1000;
      let g: Grade;
      try { g = t.grade({ text: r.text, dir, numTurns: r.numTurns }); } catch (e) { g = { score: 0, notes: [`puanlayıcı hatası: ${(e as Error).message}`] }; }
      if (r.isError) g.notes.unshift(`⚠ claude hata: ${r.raw || r.text.slice(0, 200)}`);
      rows.push({ rep, id: t.id, level: t.level, title: t.title, soft: !!t.soft, score: g.score, seconds, turns: r.numTurns, notes: g.notes, answer: r.text });
      console.log(`${repeat > 1 ? `[${rep}/${repeat}] ` : ''}${t.id.padEnd(4)} ${(g.score * 100).toFixed(0).padStart(3)}%  ${seconds.toFixed(1).padStart(6)}s  ${t.title}${g.notes.length ? `  — ${g.notes.join('; ')}` : ''}`);
      if (process.env['EVAL_KEEP']) console.log(`     sandbox korundu: ${dir}`);
      else rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    stopBridge();
    rmSync(fixtures, { recursive: true, force: true });
  }

  const hard = rows.filter((r) => !r.soft);
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const summary = {
    target, label, model: target === 'bridge' ? model : undefined,
    date: new Date().toISOString(),
    score: avg(hard.map((r) => r.score)),
    byLevel: [0, 1, 2].map((l) => ({
      level: l,
      score: avg(rows.filter((r) => r.level === l && !r.soft).map((r) => r.score)),
      medianSeconds: median(rows.filter((r) => r.level === l).map((r) => r.seconds)),
    })),
    repeat,
    /** EVAL-VAR-1: görev bazında N koşunun puan ortalaması, süre medyanı/aralığı ve tur medyanı. */
    byTask: [...new Set(rows.map((r) => r.id))].map((id) => {
      const rs = rows.filter((r) => r.id === id);
      const secs = rs.map((r) => r.seconds);
      const turns = rs.map((r) => r.turns).filter((x): x is number => typeof x === 'number');
      return {
        id, runs: rs.length, score: avg(rs.map((r) => r.score)),
        medianSeconds: median(secs), minSeconds: Math.min(...secs), maxSeconds: Math.max(...secs),
        medianTurns: turns.length ? median(turns) : undefined,
      };
    }),
    rows,
  };
  const outDir = join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${label}-${summary.date.slice(0, 16).replace(/[:T]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\nTOPLAM (soft hariç): ${(summary.score * 100).toFixed(1)}%`);
  for (const b of summary.byLevel) console.log(`  seviye ${b.level}: puan ${(b.score * 100).toFixed(0)}% · medyan süre ${b.medianSeconds.toFixed(1)}s`);
  if (repeat > 1) {
    for (const b of summary.byTask) {
      console.log(`  ${b.id.padEnd(4)} puan ${(b.score * 100).toFixed(0).padStart(3)}% · süre medyan ${b.medianSeconds.toFixed(1)}s [${b.minSeconds.toFixed(1)}-${b.maxSeconds.toFixed(1)}] · tur medyan ${b.medianTurns ?? '-'}`);
    }
  }
  console.log(`Sonuç: ${file}`);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

main().catch((e) => { stopBridge(); console.error(e); process.exit(1); });
