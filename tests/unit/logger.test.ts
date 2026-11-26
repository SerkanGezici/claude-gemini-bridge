// LOG-1 regresyon testi — bridge-only modda dosya loglama.
// Eski davranış: setLogFile yalnız full modda çağrılıyordu → bridge-only
// koşuları (smoke, canlı E2E) logs/bridge.log'a kanıt bırakmıyordu.
// Yeni davranış: setLogFile her modda çağrılır; mirrorToConsole=true ile
// bridge-only'de dosya + konsol birlikte yazılır.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setLogFile, logger } from '../../src/logger.js';

function tempLogPath(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'log1-'));
  return { dir, file: join(dir, 'bridge.log') };
}

// WriteStream flush'ı asenkron — kısa polling ile dosyanın dolmasını bekle
async function waitForContent(file: string, needle: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = readFileSync(file, 'utf8');
      if (text.includes(needle)) return text;
    } catch { /* henüz oluşmadı */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Log dosyasında "${needle}" bulunamadı (${timeoutMs}ms)`);
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('LOG-1: setLogFile modları', () => {
  it('mirrorToConsole=true (bridge-only) → dosyaya VE konsola yazar', async () => {
    const { dir, file } = tempLogPath();
    cleanups.push(dir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    setLogFile(file, true);
    logger.info('LOG-1 bridge-only kanıt satırı');

    const text = await waitForContent(file, 'LOG-1 bridge-only kanıt satırı');
    expect(text).toContain('[INFO]');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('LOG-1 bridge-only kanıt satırı'));
  });

  it('mirrorToConsole=false (full mod) → SADECE dosyaya yazar (TUI korunur)', async () => {
    const { dir, file } = tempLogPath();
    cleanups.push(dir);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    setLogFile(file, false);
    logger.info('LOG-1 full-mod kanıt satırı');

    await waitForContent(file, 'LOG-1 full-mod kanıt satırı');
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
