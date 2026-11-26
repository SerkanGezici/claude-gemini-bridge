#!/usr/bin/env node
 
// ClaudeCLILive CLI Launcher
// Runs the COMPILED entry point (dist/index.js) with plain node — no tsx at
// runtime. `npm run build` (also triggered by `prepare`/`prepublishOnly`) emits
// dist/ via tsconfig.build.json. For source/dev runs use `npm start` (tsx).

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const entry = join(root, 'dist', 'index.js');

if (!existsSync(entry)) {
  console.error(`[claude-gemini] Build output not found: ${entry}`);
  console.error('[claude-gemini] Run "npm run build" first (or reinstall the package).');
  process.exit(1);
}

// PATHS-1: Kullanıcının çağırdığı dizini YAKALA. Node'un tsx + entry'yi
// çözebilmesi için child cwd'si root olmalı (tsx, bridge'in node_modules'ında),
// AMA Claude Code kullanıcının projesinde açılmalı. Bu yüzden orijinal cwd'yi
// env ile index.ts'e taşıyoruz; o, Claude Code'u bu dizinde spawn ediyor.
const userCwd = process.cwd();

try {
  execFileSync(
    process.execPath, // node binary
    [
      entry,
      ...process.argv.slice(2),
    ],
    {
      stdio: 'inherit',
      cwd: root, // node_modules çözümü için (Claude Code'un cwd'si index.ts'te ayrı)
      env: { ...process.env, CLAUDE_GEMINI_USER_CWD: userCwd },
    },
  );
} catch (err) {
  // execFileSync throws on non-zero exit — child already printed errors
  process.exit(err.status ?? 1);
}
 