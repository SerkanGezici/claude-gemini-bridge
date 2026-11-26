// PATHS-1: Bridge kök dizinini ÇALIŞMA DİZİNİNDEN BAĞIMSIZ çöz.
// `claude-gemini` artık herhangi bir proje dizininde çalıştırılabilir (Claude
// Code o dizinde açılır); ama .env + log/dump DAİMA bridge kökünden yönetilmeli.
// import.meta.url dosyanın fiziksel konumunu verir (cwd'ye bakmaz) → src/'nin
// bir üstü = proje kökü. Eskiden process.cwd() kullanılıyordu; başka dizinden
// başlatınca .env bulunamıyor + log kullanıcının projesine sızıyordu (2026-06-16).
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_PATH = join(PROJECT_ROOT, '.env');
// Global-install (`npm i -g`) key location: with a global install PROJECT_ROOT
// lives inside node_modules and gets wiped on update, so there is no sane place
// to drop a .env. Also honor a stable per-user config file. Real environment
// variables still take precedence over both (see config.ts loading order).
export const USER_ENV_PATH = join(homedir(), '.config', 'claude-gemini-bridge', '.env');
export const LOGS_DIR = join(PROJECT_ROOT, 'logs');
export const REQUESTS_DIR = join(LOGS_DIR, 'requests');
// ADR-0004: belge araç ortamı — köprünün yönettiği venv (kullanıcı başına; paket
// güncellemesi silmez). `claude-gemini --setup-docs` kurar.
export const DOCENV_DIR = join(homedir(), '.local', 'share', 'claude-gemini-bridge', 'docenv');
export function docenvPython(dir = DOCENV_DIR) {
    return process.platform === 'win32' ? join(dir, 'Scripts', 'python.exe') : join(dir, 'bin', 'python');
}
export const OFFICE_TOOLS_PY = join(PROJECT_ROOT, 'assets', 'office_tools.py');
export const OFFICE_HOOK_PY = join(PROJECT_ROOT, 'assets', 'office_hook.py');
