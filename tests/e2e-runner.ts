// Gerçek Claude Code CLI ile uçtan uca E2E — MOCK YOK.
// Bridge'i --bridge-only başlatır, GERÇEK `claude -p` (headless) ile 3 senaryo:
//   T1: basit yanıt (CLI → bridge → Gemini → CLI)
//   T2: tool zinciri (Read ile dosyadan sentinel çıkarma — tam tool loop)
//   T3: çok tur (--continue ile önceki turun bilgisini hatırlama)
//
// E2E-STDIN-1 (2026-07-06): eski runner interaktif TUI'yi stdin'e yazarak
// sürüyordu; yeni Claude CLI pipe-stdin'i print moda sokup 3sn'de
// "Input must be provided" ile kesiyor. Ayrıca "Plan Mode'a girdi" assert'i
// TOOL-GUARD-1 (EnterPlanMode BLOCKED) ile yapısal olarak imkânsızdı.
// Yeni runner prompt'u ARGÜMAN olarak geçirir (kanıtlı canlı E2E yöntemi).
// Kullanım: npm run test:e2e  (gerçek Gemini API + gerçek claude CLI gerekir)

import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PORT = 8027;
const TOKEN = 'e2e-test-token';
const BASE = `http://127.0.0.1:${PORT}`;
const SENTINEL = 'KIRMIZI-BALON-7321';
// Üretim birincil modeli — .env'e güvenme, explicit geç (CLAUDE.md kuralı:
// dotenv mevcut env'i override edemez, stale .env sessiz yanlış-config yapar).
const MODEL = 'models/gemini-3.1-flash-live-preview';

let bridge: ChildProcess | null = null;
let sandbox = '';
let passed = 0;
let failed = 0;

function log(msg: string): void {
  console.log(msg);
}

// /mnt/c (WSL) IO yavaş: tsx cold start + fastify import ~25-30s sürebilir
async function waitForHealth(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* henüz açılmadı */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Bridge health check timeout');
}

/** Gerçek claude CLI'ı headless (-p) çalıştır — prompt ARGÜMAN olarak geçer. */
function runClaude(prompt: string, extraArgs: string[] = []): string {
  return execFileSync(
    'claude',
    ['-p', prompt, '--dangerously-skip-permissions', ...extraArgs],
    {
      cwd: sandbox,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: BASE,
        ANTHROPIC_API_KEY: TOKEN,
      },
      encoding: 'utf8',
      timeout: 240_000, // tool zinciri + WSL cold start payı
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    passed++;
    log(`✅ ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed++;
    log(`❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  // Pre-flight: port dolu ise STALE bridge var — eski kodla konuşup yanlış
  // teşhise yol açar (smoke'taki 2026-06-11 dersi).
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) {
      log(`❌ Port ${PORT} dolu — stale bridge çalışıyor. Önce temizle:`);
      log('   pkill -f "tsx src/index.ts --bridge-only"');
      process.exit(1);
    }
  } catch { /* port boş — devam */ }

  log('🚀 E2E test başlıyor — bridge --bridge-only başlatılıyor...');

  // detached: process group lideri — teardown'da grup komple ölür (smoke deseni)
  bridge = spawn('npx', ['tsx', 'src/index.ts', '--bridge-only'], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(PORT),
      BRIDGE_TOKEN: TOKEN,
      DEBUG: 'false',
      GEMINI_MODEL: MODEL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout?.on('data', (d: Buffer) => process.stdout.write(`[bridge] ${d}`));
  bridge.stderr?.on('data', (d: Buffer) => process.stderr.write(`[bridge] ${d}`));

  await waitForHealth();
  log('✅ Bridge ayakta');

  // Sandbox workspace: claude -p burada açılır (PATHS-1 — cwd'nin dosyalarını okur)
  sandbox = mkdtempSync(join(tmpdir(), 'cg-e2e-'));
  writeFileSync(join(sandbox, 'notlar.txt'), `Alışveriş: süt, ekmek.\nGizli kod: ${SENTINEL}\nToplantı: salı 14:00.\n`);
  log(`✅ Sandbox: ${sandbox}\n`);

  // ── T1: basit yanıt — CLI → bridge → Gemini → CLI tam yol ──
  await test('T1 basit yanıt (headless claude -p)', () => {
    const out = runClaude('Merhaba! Tek kısa cümleyle selam ver.');
    assert(out.trim().length > 0, 'Boş çıktı (empty turn / bridge sorunu?)');
    log(`   → "${out.trim().slice(0, 80)}"`);
  });

  // ── T2: tool zinciri — Read ile dosyadan sentinel (tam tool loop) ──
  await test('T2 tool zinciri (dosyadan sentinel okuma)', () => {
    const out = runClaude('notlar.txt dosyasını oku ve içindeki gizli kodu aynen yaz.');
    assert(out.includes(SENTINEL), `Sentinel "${SENTINEL}" çıktıda yok: "${out.trim().slice(0, 120)}"`);
    log(`   → sentinel doğru: ${SENTINEL}`);
  });

  // ── T3: çok tur — --continue önceki turun bağlamını taşır ──
  await test('T3 çok tur devamlılık (--continue)', () => {
    const out = runClaude('Az önce bulduğun gizli kod neydi? Sadece kodu yaz.', ['--continue']);
    assert(out.includes(SENTINEL), `Devam turu sentinel'i hatırlamadı: "${out.trim().slice(0, 120)}"`);
    log(`   → devam turu sentinel'i hatırladı`);
  });

  log(`\n📊 Sonuç: ${passed} geçti, ${failed} kaldı`);
  process.exit(failed > 0 ? 1 : 0);
}

function teardown(): void {
  if (bridge?.pid) {
    try { process.kill(-bridge.pid, 'SIGTERM'); } catch { /* zaten ölü */ }
  }
  if (sandbox) {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* sessiz */ }
  }
}

process.on('exit', teardown);
process.on('SIGINT', () => process.exit(130));

main().catch((err) => {
  console.error('❌ E2E runner hatası:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
