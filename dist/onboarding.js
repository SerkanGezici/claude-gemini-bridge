// First-run onboarding: ensure a working Gemini API key before the bridge
// starts. If the key is missing OR invalid/expired/disabled, prompt the user to
// paste one, validate it against the API, and persist it to the per-user config
// file (~/.config/claude-gemini-bridge/.env). This turns a cryptic startup
// failure into a guided recovery and catches dead/revoked keys up front.
//
// Interactive ONLY in a real terminal (TTY). In CI / headless / piped flows
// (--bridge-only behind a pipe, `claude -p`) it is a no-op, so existing
// automated behavior is unchanged (getConfig still throws on a missing key).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createInterface } from 'readline';
import dotenv from 'dotenv';
import { USER_ENV_PATH } from './paths.js';
import { resetConfig } from './config.js';
import { fetchAvailableModels } from './model-discovery.js';
// Validate with models.list: it only proves the KEY is valid/active and does
// not depend on any model. A model-based ping broke when Google closed
// gemini-2.5-flash to new projects (404 "no longer available to new users")
// and rejected every valid new key. Which models the key can actually use is
// checked separately by model discovery at startup.
const MAX_ATTEMPTS = 3;
const KEY_URL = 'https://aistudio.google.com/apikey';
const REASON_MSG = {
    valid: 'valid',
    invalid: 'This API key is invalid or disabled (it may have been deleted / deactivated).',
    quota: 'This API key is valid but its quota is exhausted.',
    network: 'Network error during validation (internet / connectivity issue).',
    unknown: 'Could not validate the API key.',
};
/** Pure: SDK/HTTP hatasını sınıfa indir (test edilebilir). */
export function classifyKeyError(err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const status = err?.status
        ?? err?.code;
    if (msg.includes('api key not valid') || msg.includes('api_key_invalid') ||
        msg.includes('invalid api key') || msg.includes('api key expired') ||
        msg.includes('permission_denied') || msg.includes('permission denied') ||
        msg.includes('unauthenticated') || msg.includes('unauthorized') ||
        msg.includes('forbidden') || msg.includes('invalid argument') ||
        msg.includes('api keyless') || msg.includes('bad request') ||
        status === 400 || status === 401 || status === 403 || /\b40[013]\b/.test(msg))
        return 'invalid';
    if (msg.includes('quota') || msg.includes('resource_exhausted') ||
        msg.includes('rate limit') || msg.includes('429') || status === 429)
        return 'quota';
    if (msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('etimedout') ||
        msg.includes('network') || msg.includes('fetch failed') || msg.includes('timed out') ||
        msg.includes('timeout') || msg.includes('aborted'))
        return 'network';
    return 'unknown';
}
/** Validate a key with models.list (no model dependency). Never throws. */
export async function validateApiKey(key, fetchImpl = fetch) {
    try {
        await fetchAvailableModels(key, fetchImpl);
        return { ok: true, reason: 'valid' };
    }
    catch (err) {
        return { ok: false, reason: classifyKeyError(err), detail: err instanceof Error ? err.message : String(err) };
    }
}
/** Pure: insert/replace a `NAME=value` line, preserving other lines. */
export function upsertEnvVar(content, name, value) {
    const line = `${name}=${value}`;
    const re = new RegExp(`^${name}=.*$`, 'm');
    if (re.test(content))
        return content.replace(re, line);
    const trimmed = content.replace(/\s*$/, '');
    return trimmed ? `${trimmed}\n${line}\n` : `${line}\n`;
}
/** Persist the validated key to USER_ENV_PATH (mode 600), keeping other vars. */
export function saveApiKey(key) {
    mkdirSync(dirname(USER_ENV_PATH), { recursive: true });
    const existing = existsSync(USER_ENV_PATH) ? readFileSync(USER_ENV_PATH, 'utf8') : '';
    writeFileSync(USER_ENV_PATH, upsertEnvVar(existing, 'GEMINI_API_KEY', key), { mode: 0o600 });
    return USER_ENV_PATH;
}
/**
 * The shell's GEMINI_API_KEY wins over the saved per-user key (dotenv never
 * overrides). A stale key exported in ~/.bashrc therefore failed validation on
 * every start and re-prompted, even though the user had already saved a good
 * key. If the shell key is invalid, try the saved key before prompting.
 * Returns the saved key when it differs and validates, else null.
 */
export async function trySavedKeyFallback(current, savedEnvContent, validate = validateApiKey) {
    const saved = dotenv.parse(savedEnvContent)['GEMINI_API_KEY']?.trim();
    if (!saved || saved === current)
        return null;
    const res = await validate(saved);
    return res.ok || res.reason === 'quota' ? saved : null;
}
function ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}
/**
 * Ensure a working API key before startup. Prompts + validates + saves when
 * interactive; no-op in non-TTY / SKIP_KEY_CHECK=1 environments.
 */
export async function ensureApiKey() {
    if (process.env['SKIP_KEY_CHECK'] === '1')
        return;
    if (!process.stdin.isTTY)
        return; // automation / headless → leave as-is
    const current = process.env['GEMINI_API_KEY']?.trim();
    if (current) {
        process.stdout.write('🔑 Validating Gemini API key... ');
        const res = await validateApiKey(current);
        if (res.ok) {
            console.log('✓ valid.');
            return;
        }
        if (res.reason === 'quota') {
            console.log('⚠️  quota exhausted (key is valid) — continuing.');
            return;
        }
        if (res.reason === 'network') {
            console.log('⚠️  network error — could not validate, continuing anyway.');
            return;
        }
        const savedContent = existsSync(USER_ENV_PATH) ? readFileSync(USER_ENV_PATH, 'utf8') : '';
        const saved = await trySavedKeyFallback(current, savedContent);
        if (saved) {
            process.env['GEMINI_API_KEY'] = saved;
            resetConfig();
            console.log(`✓ using saved key (shell GEMINI_API_KEY is invalid — remove it from ~/.bashrc or run: unset GEMINI_API_KEY).`);
            return;
        }
        console.log(`✗\n   ${REASON_MSG[res.reason]}${res.detail ? `\n   ↳ ${res.detail.slice(0, 160)}` : ''}`);
    }
    else {
        console.log('🔑 No Gemini API key found.');
    }
    console.log(`   Get a key: ${KEY_URL}\n`);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const entered = (await ask('Paste your Gemini API key: ')).trim();
        if (!entered) {
            console.log('   (empty input)\n');
            continue;
        }
        process.stdout.write('   validating... ');
        const res = await validateApiKey(entered);
        if (res.ok || res.reason === 'quota') {
            const saved = saveApiKey(entered);
            process.env['GEMINI_API_KEY'] = entered;
            resetConfig();
            console.log(res.ok ? '✓ valid.' : '⚠️  quota exhausted (key is valid).');
            console.log(`   Saved → ${saved}\n`);
            return;
        }
        console.log(`✗ ${REASON_MSG[res.reason]} (attempt ${attempt}/${MAX_ATTEMPTS})${res.detail ? `\n   ↳ ${res.detail.slice(0, 160)}` : ''}\n`);
    }
    console.error(`\nNo valid API key provided (${MAX_ATTEMPTS} attempts). Get a key: ${KEY_URL}`);
    process.exit(1);
}
