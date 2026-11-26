// PATHS-1: bridge kök yolları çalışma dizininden bağımsız çözülür.
// claude-gemini başka proje dizininden çalıştırılınca da .env + log/dump
// DAİMA bridge kökünden gelir (2026-06-16 fix).
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PROJECT_ROOT, ENV_PATH, USER_ENV_PATH, LOGS_DIR, REQUESTS_DIR } from '../../src/paths.js';

describe('paths (PATHS-1)', () => {
  it('PROJECT_ROOT gerçek bridge kökünü gösterir (package.json + src/ içerir)', () => {
    expect(existsSync(join(PROJECT_ROOT, 'package.json'))).toBe(true);
    expect(existsSync(join(PROJECT_ROOT, 'src', 'paths.ts'))).toBe(true);
  });

  it('ENV_PATH kök altındaki .env', () => {
    expect(ENV_PATH).toBe(join(PROJECT_ROOT, '.env'));
  });

  it('USER_ENV_PATH global kurulum için ~/.config altında (npm i -g key konumu)', () => {
    expect(USER_ENV_PATH).toBe(join(homedir(), '.config', 'claude-gemini-bridge', '.env'));
  });

  it('log + dump yolları kök altında (cwd değil)', () => {
    expect(LOGS_DIR).toBe(join(PROJECT_ROOT, 'logs'));
    expect(REQUESTS_DIR).toBe(join(PROJECT_ROOT, 'logs', 'requests'));
  });
});
