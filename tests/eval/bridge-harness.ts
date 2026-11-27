// Eval koşucularının ortak köprü yönetimi (run-eval, skill-sweep): köprüyü kaynak
// koddan `--bridge-only` başlatır, sağlık bekler, kapatır; claude sürecine köprü ortamı verir.
import { spawn, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EVAL_TOKEN = 'eval-token';

let bridge: ChildProcess | null = null;

export function bridgeBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function startBridge(port: number, model: string): Promise<void> {
  // Anahtar ortamda yoksa köprü kendi kayıtlı anahtarını (~/.config/claude-gemini-bridge/.env) kullanır.
  bridge = spawn('npx', ['tsx', 'src/index.ts', '--bridge-only'], {
    cwd: REPO,
    detached: true,
    env: { ...process.env, PORT: String(port), BRIDGE_TOKEN: EVAL_TOKEN, DEBUG: process.env['EVAL_DEBUG'] ?? 'false', GEMINI_MODEL: model },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Pipe'ı boşalt (dolarsa köprü yazarken bloklanır); log dosyası zaten var.
  bridge.stdout?.on('data', () => {});
  bridge.stderr?.on('data', (d: Buffer) => process.stderr.write(`[bridge] ${d}`));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${bridgeBase(port)}/health`)).ok) return; } catch { /* açılıyor */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('bridge health timeout');
}

export function stopBridge(): void {
  if (bridge?.pid) {
    try { process.kill(-bridge.pid, 'SIGTERM'); } catch { /* zaten kapalı */ }
  }
  bridge = null;
}

/** claude sürecini köprüye yönlendiren ortam. */
export function bridgeEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_BASE_URL: bridgeBase(port), ANTHROPIC_API_KEY: EVAL_TOKEN };
  delete env['ANTHROPIC_AUTH_TOKEN'];
  return env;
}
