#!/usr/bin/env node
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { startBridge } from './server.js';
import { getConfig } from './config.js';
import { logger, setLogFile } from './logger.js';
import { buildClaudeArgs } from './claude-args.js';
import { ensureApiKey } from './onboarding.js';
import { docenvReady, setupDocenv } from './docenv.js';
import { prewarmClaudeCritic } from './reviewer.js';
import { runModelDiscovery, buildModelRequirements } from './model-discovery.js';
import { LOGS_DIR } from './paths.js';
// ── Global Safety Net ────────────────────────────────────
// Bridge uzun ömürlü bir yerel server: tek bir async kaçak (örn. WS onerror
// erken rejection — 2026-06-11 WSL DNS EAI_AGAIN olayı) tüm process'i
// öldürmemeli. Yüksek sesle logla, ayakta kal.
process.on('unhandledRejection', (reason) => {
    logger.error('UnhandledRejection (bridge staying up)', reason instanceof Error ? reason.message : String(reason));
});
process.on('uncaughtException', (err) => {
    logger.error('UncaughtException (bridge staying up)', err.message);
});
// ── CLI Launcher ─────────────────────────────────────────
const BANNER = `
╔══════════════════════════════════════════╗
║           claude-gemini-bridge           ║
║     Claude Code → Gemini Live API        ║
╚══════════════════════════════════════════╝`;
async function main() {
    const args = process.argv.slice(2);
    // --help flag
    if (args.includes('--help') || args.includes('-h')) {
        console.log(BANNER);
        console.log(`
Usage:
  claude-gemini                 Start the bridge and launch Claude Code
  claude-gemini --bridge-only   Start only the bridge (do not launch Claude Code)
  claude-gemini --dangerously-skip-permissions  Bypass permissions mode (🔓)
  claude-gemini --setup-docs    Install/update the document tools environment (Excel/Word/PDF/image editing)
  claude-gemini --help          Show this help message

Environment variables (see .env.example for the full list):
  GEMINI_API_KEY    (required)  Gemini API key — https://aistudio.google.com/apikey
  GEMINI_MODEL      Live model (recommended: models/gemini-3.1-flash-live-preview)
  GEMINI_FALLBACK_MODEL / QUOTA_COOLDOWN_MS   Quota fallback model + cooldown
  ROUTING           on|off — 3-lane request routing (background/longcontext/emergency)
  LANE_BACKGROUND_MODEL / LANE_LONGCONTEXT_MODEL / LANE_EMERGENCY_MODEL   Lane models
  PORT              Bridge port (default: 8002)
  HOST              Bind address (default: 127.0.0.1 — localhost only; public addresses are rejected)
  DEBUG             Enable debug logging (true/false)
  SKIP_MODEL_CHECK  1 = skip startup models.list validation

Endpoints: /health (no auth) · /status (auth; lanes, limits, discovery)
`);
        process.exit(0);
    }
    // ADR-0004: belge araç ortamını kur/güncelle ve çık.
    if (args.includes('--setup-docs')) {
        console.log(BANNER);
        process.exit(setupDocenv() ? 0 : 1);
    }
    const bridgeOnly = args.includes('--bridge-only');
    console.log(BANNER);
    // First-run onboarding: ensure a working Gemini API key before anything else.
    // Prompts + validates + saves to ~/.config/claude-gemini-bridge/.env when the
    // key is missing or invalid/expired. Interactive in a TTY only — no-op in
    // CI/headless/piped flows and when SKIP_KEY_CHECK=1.
    await ensureApiKey();
    // ADR-0004: anahtar hazır olduktan sonra (getConfig anahtar ister).
    if (getConfig().officeMcp && !docenvReady()) {
        console.log('📄 Document tools are not installed — Excel/Word/PDF editing is less reliable. Run: claude-gemini --setup-docs (~30 s, ~350 MB)');
    }
    // LOG-1: dosya loglama HER modda açılır (eskiden bridge-only dosyasız
    // kalıyordu — smoke/E2E koşuları kanıt bırakmıyordu). Bridge-only'de
    // konsol aynası da açık; full modda salt dosya (TUI çakışması).
    // PATHS-1: log DAİMA bridge kökünde (process.cwd() değil) — başka proje
    // dizininden başlatılınca log kullanıcının projesine sızmaz.
    mkdirSync(LOGS_DIR, { recursive: true });
    const logFile = join(LOGS_DIR, 'bridge.log');
    setLogFile(logFile, bridgeOnly);
    console.log(`Bridge logs: ${logFile}`);
    logger.info('ClaudeCLILive Bridge starting...');
    // DISCOVER-1: config'teki modeller bu key'de gerçekten var mı? Yanlış model
    // ("-latest 404" sınıfı) her isteği patlatacağına İLK SANİYEDE yakalanır.
    // models.list'e ulaşılamazsa (ağ) fail-open: warn + devam.
    const discovery = await runModelDiscovery(getConfig().geminiApiKey, buildModelRequirements(getConfig()), fetch, getConfig().skipModelCheck);
    if (discovery.state === 'invalid') {
        for (const p of discovery.problems)
            logger.error(`Model doğrulama: ${p}`);
        logger.error('Modeli düzeltip tekrar başlatın (.env veya ortam değişkeni). SKIP_MODEL_CHECK=1 ile atlanabilir.');
        process.exit(1);
    }
    if (discovery.state === 'ok') {
        logger.info(`Model doğrulama ✓ (${discovery.modelCount} model erişilebilir)`);
    }
    // ROUTE-1 şerit özeti — kullanıcı hangi trafiğin nereye gittiğini açılışta görsün
    const cfg = getConfig();
    if (cfg.routingEnabled) {
        logger.info(`Routing: quality=${cfg.geminiModel} · background=${cfg.laneBackgroundModel} · ` +
            `longcontext=${cfg.laneLongContextEnabled ? `${cfg.laneLongContextModel} (>${cfg.longContextThresholdTokens} tok, RPD ${cfg.longContextRpdBudget})` : 'off'} · ` +
            `emergency=${cfg.laneEmergencyModel || 'off'}`);
    }
    else {
        logger.info('Routing: OFF (ROUTING=off) — tek şerit, eski davranış');
    }
    // 1. Bridge başlat
    let bridge;
    try {
        bridge = await startBridge();
    }
    catch (err) {
        logger.error('Failed to start bridge', err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
    const bridgeUrl = `http://127.0.0.1:${bridge.port}`;
    logger.info(`Bridge ready at ${bridgeUrl}`);
    // REVIEW-LAT-1: ilk denetim de ılık başlasın — Claude denetçi zincirdeyse yedek süreci aç.
    const claudeReviewer = getConfig().reviewEnabled
        ? getConfig().reviewModels.find((m) => m.startsWith('claude:'))
        : undefined;
    if (claudeReviewer)
        prewarmClaudeCritic(claudeReviewer.slice('claude:'.length));
    // Bridge-only mod
    if (bridgeOnly) {
        logger.info('Bridge-only mode — waiting for connections...');
        logger.info('Press Ctrl+C to stop');
        // TD-008: rastgele anahtar hiç gösterilmiyordu → kullanıcının Claude Code'u 401
        // alıyordu. Yalnız terminale (stderr) yazılır; bridge.log'a GİTMEZ (gizli değer).
        if (cfg.bridgeTokenGenerated) {
            process.stderr.write(`\nClaude Code'u bu köprüye bağlamak için (BRIDGE_TOKEN verilmedi, bu oturuma özel anahtar):\n` +
                `  ANTHROPIC_BASE_URL=http://${cfg.host}:${bridge.port} ANTHROPIC_API_KEY=${cfg.bridgeToken} claude\n` +
                `Sabit anahtar için BRIDGE_TOKEN ortam değişkenini ayarlayın.\n\n`);
        }
        const shutdownBridge = async () => {
            logger.info('Shutting down bridge...');
            await bridge.close();
            process.exit(0);
        };
        process.on('SIGINT', shutdownBridge);
        process.on('SIGTERM', shutdownBridge);
        process.on('SIGHUP', shutdownBridge); // EXIT-1: bridge-only modda da pencere/terminal kapanınca portu bırak
        return; // Fastify event loop'u canlı tutar
    }
    // 2. Claude Code'u bridge'e yönlendir ve başlat
    logger.info('Launching Claude Code...');
    const config = getConfig();
    // Her zaman bypass permissions ile başlat (claude-super davranışı).
    // LIVE-22: '--allow-...' bayrağı bypass'ı aktif ETMİYORDU — detay claude-args.ts.
    const claudeArgs = buildClaudeArgs(args);
    // PATHS-1: Claude Code KULLANICININ çağırdığı dizinde açılır (bridge kökünde
    // değil) → o projenin dosyalarını okur/yazar. userCwd binary'den env ile gelir;
    // doğrudan `npm start` ile çalıştırılırsa process.cwd()'ye düşer.
    const userCwd = process.env['CLAUDE_GEMINI_USER_CWD'] || process.cwd();
    logger.info(`Claude Code working directory: ${userCwd}`);
    const claude = spawn('claude', claudeArgs, {
        stdio: 'inherit',
        cwd: userCwd,
        env: {
            ...process.env,
            ANTHROPIC_BASE_URL: bridgeUrl,
            ANTHROPIC_API_KEY: config.bridgeToken,
            ANTHROPIC_AUTH_TOKEN: config.bridgeToken,
        },
    });
    claude.on('error', (err) => {
        if (err.code === 'ENOENT') {
            logger.error('Claude Code not found. Make sure it is installed:');
            logger.error('  npm install -g @anthropic-ai/claude-code');
            process.exit(1);
        }
        logger.error('Claude Code error', err.message);
        process.exit(1);
    });
    claude.on('exit', (code) => {
        logger.info(`Claude Code exited with code ${code ?? 0}`);
        process.exit(code ?? 0);
    });
    // Ctrl+C ile temiz kapanış
    const cleanup = () => {
        logger.info('Shutting down...');
        claude.kill('SIGTERM');
        bridge.close().catch(() => { });
        // 3 saniye bekle, kapanmazsa zorla
        setTimeout(() => {
            claude.kill('SIGKILL');
            process.exit(0);
        }, 3000);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    // EXIT-1: Terminal/pencere kapanınca da (SIGHUP) köprü TEMİZ kapansın. Yoksa
    // Claude Code (örn. background-agent deadlock'unda) 'exit' event'i üretmeden
    // takılırsa bridge saatlerce zombi kalıp portu tutuyor (2026-06-17 olayı: 17.5
    // saatlik orphan, 166 process). cleanup PID-İZOLE: yalnız BU bridge'in kendi
    // Fastify'ını ve kendi spawn ettiği claude child'ını kapatır — başka claude /
    // claude-gemini oturumlarına veya başka uygulamaların portlarına DOKUNMAZ.
    process.on('SIGHUP', cleanup);
}
main().catch((err) => {
    logger.error('Fatal error', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
