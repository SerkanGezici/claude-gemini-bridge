// LIMIT-REG-1: öğrenen limit registry. Gemini API kota limitlerini (RPM/TPM/RPD)
// HİÇBİR endpoint'ten sorgulatmaz — tek programatik kaynak 429/1011 hata gövdesi
// (quotaId + quotaValue + retryDelay; canlı kanıt: quotaValue="250000",
// retryDelay="42s"). Registry üç kaynaktan beslenir:
//   1. SEED — Serkan'ın AI Studio tablosu (2026-07-03),
//   2. ÖĞRENME — her kota hatasından parse edilen gerçek değerler (seed'i ezer),
//   3. KAYAN PENCERE — bizim gönderdiğimiz tokenlerin 60sn'lik yerel sayımı.
// Borçlandırma semantiği ölçülen API davranışının aynasıdır: pencere boşken
// limit-üstü TEK istek geçer (271K>250K PASS kanıtı), doluyken bloklanır.
// Kanıt/tablo: PLANS/archive/MODEL-MATRIX-PROBE-2026-07-03.md
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { logger } from './logger.js';

export interface ModelLimits {
  rpm?: number;
  tpm?: number;
  rpd?: number;
}

// ── SEED — AI Studio kota tablosu (proje bazlı, key değil) ───
const SEED_LIMITS: Record<string, ModelLimits> = {
  // Live API
  'gemini-3.1-flash-live-preview': { tpm: 65_000 },
  'gemini-2.5-flash-native-audio-preview-12-2025': { tpm: 1_000_000 },
  'gemini-2.5-flash-native-audio-preview-09-2025': { tpm: 1_000_000 },
  'gemini-2.5-flash-native-audio-latest': { tpm: 1_000_000 },
  'gemini-3.5-live-translate-preview': { tpm: 20_000 },
  // REST text
  'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
  'gemini-3.1-flash-lite-preview': { rpm: 15, tpm: 250_000, rpd: 500 },
  'gemini-2.5-flash-lite': { rpm: 10, tpm: 250_000, rpd: 20 },
  'gemini-2.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3-flash-preview': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemma-4-31b-it': { rpm: 15, rpd: 1_500 },
  'gemma-4-26b-a4b-it': { rpm: 15, rpd: 1_500 },
};

const WINDOW_MS = 60_000;

function norm(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

// ── State ────────────────────────────────────────────────────
interface WindowEntry { t: number; tokens: number; }
interface PersistedState {
  learned: Record<string, ModelLimits & { quotaId?: string }>;
  rpd: Record<string, { day: string; count: number }>;
}

const DEFAULT_STATE_PATH = join(homedir(), '.config', 'claude-gemini-bridge', 'limits.json');

let _statePath = DEFAULT_STATE_PATH;
let _statePathOverridden = false;
let _persisted: PersistedState | null = null;
const _windows = new Map<string, WindowEntry[]>();
const _blockedUntil = new Map<string, number>();

/** Test/araç yardımcısı: state dosyası yolunu değiştir (wipe=true → temiz başla). */
export function setLimitStatePath(path: string, wipe = false): void {
  _statePath = path;
  _statePathOverridden = true;
  _persisted = null;
  if (wipe) {
    _persisted = { learned: {}, rpd: {} };
    try {
      mkdirSync(dirname(_statePath), { recursive: true });
      writeFileSync(_statePath, JSON.stringify(_persisted, null, 2));
    } catch { /* test yardımcıı — sessiz geç */ }
  }
}

export function resetLimitRegistry(): void {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  _windows.clear();
  _blockedUntil.clear();
  _persisted = null;
  _statePath = DEFAULT_STATE_PATH;
  _statePathOverridden = false;
}

function ensureLoaded(): PersistedState {
  if (_persisted) return _persisted;
  try {
    const raw = JSON.parse(readFileSync(_statePath, 'utf-8')) as PersistedState;
    _persisted = {
      learned: raw.learned ?? {},
      rpd: raw.rpd ?? {},
    };
  } catch {
    _persisted = { learned: {}, rpd: {} };
  }
  return _persisted;
}

// ── Persist: merge-on-write + debounce (review P2-1/P2-2) ────
// P2-1: paralel bridge instance'ları (PORT-1) aynı limits.json'u paylaşır —
// blind overwrite diğerinin öğrendiklerini ezerdi. Yazmadan önce disk yeniden
// okunur ve birleştirilir: learned'da bellek kazanır (en taze 429 kanıtı),
// RPD'de aynı gün için max alınır (iki process'in toplamını bilemeyiz —
// max, ezmekten iyidir; bilinçli yaklaşıklık, spec'e not düşüldü).
// P2-2: recordUsage HER turn'de çağrılır — hot path'te senkron writeFileSync
// /mnt/c IO'sunda pahalı → usage yazımı 3sn debounce'lu; kota-öğrenme
// (recordQuotaError) nadir ve değerli olduğundan ANINDA flush edilir.

const PERSIST_DEBOUNCE_MS = 3_000;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function mergeFromDisk(mem: PersistedState): PersistedState {
  let disk: PersistedState | null = null;
  try {
    disk = JSON.parse(readFileSync(_statePath, 'utf-8')) as PersistedState;
  } catch {
    return mem; // dosya yok/bozuk → bellek kazanır
  }
  const merged: PersistedState = {
    learned: { ...(disk.learned ?? {}), ...mem.learned },
    rpd: { ...(disk.rpd ?? {}) },
  };
  for (const [key, ours] of Object.entries(mem.rpd)) {
    const theirs = merged.rpd[key];
    if (!theirs || theirs.day !== ours.day) {
      merged.rpd[key] = !theirs || ours.day >= theirs.day ? ours : theirs;
    } else {
      merged.rpd[key] = { day: ours.day, count: Math.max(theirs.count, ours.count) };
    }
  }
  return merged;
}

function writeStateNow(): void {
  // vitest altında (explicit path verilmedikçe) kullanıcının gerçek
  // ~/.config dosyasını KİRLETME — testler setLimitStatePath ile çalışır.
  if (process.env['VITEST'] && !_statePathOverridden) return;
  try {
    const merged = mergeFromDisk(ensureLoaded());
    _persisted = merged;
    mkdirSync(dirname(_statePath), { recursive: true });
    writeFileSync(_statePath, JSON.stringify(merged, null, 2));
  } catch (err) {
    // Persist hatası isteği ASLA engellemez (TD-018 dersi: sessiz değil, logla)
    logger.warn(`limits.json yazılamadı: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Bekleyen debounce'u iptal edip state'i ANINDA yaz. */
export function flushLimitState(): void {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  writeStateNow();
}

/** Hot-path persist: 3sn debounce (timer unref'li — kapanışı geciktirmez). */
function persistDeferred(): void {
  if (process.env['VITEST'] && !_statePathOverridden) return;
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    writeStateNow();
  }, PERSIST_DEBOUNCE_MS);
  _persistTimer.unref?.();
}

// ── Limit sorgulama ──────────────────────────────────────────

export function getModelLimits(model: string): ModelLimits {
  const key = norm(model);
  const seed = SEED_LIMITS[key] ?? {};
  const learned = ensureLoaded().learned[key] ?? {};
  return { ...seed, ...learned };
}

// ── Kayan pencere + RPD ──────────────────────────────────────

function pruneWindow(key: string, now: number): WindowEntry[] {
  const win = _windows.get(key) ?? [];
  const pruned = win.filter((e) => now - e.t < WINDOW_MS);
  _windows.set(key, pruned);
  return pruned;
}

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // UTC yyyy-mm-dd
}

/** Bir isteğin token maliyetini pencereye ve RPD sayacına işle. */
export function recordUsage(model: string, tokens: number, now = Date.now()): void {
  const key = norm(model);
  pruneWindow(key, now).push({ t: now, tokens });

  const state = ensureLoaded();
  const day = dayKey(now);
  const entry = state.rpd[key];
  if (entry && entry.day === day) entry.count += 1;
  else state.rpd[key] = { day, count: 1 };
  persistDeferred();
}

export function windowTokens(model: string, now = Date.now()): number {
  return pruneWindow(norm(model), now).reduce((sum, e) => sum + e.tokens, 0);
}

/**
 * TPM penceresi dolu mu? Borçlandırma semantiği (ölçülen API davranışı):
 * pencere limitin ALTINDAYKEN yeni istek — boyutu ne olursa olsun — geçer;
 * pencere limit üstündeyse (borçta) bloklanır.
 */
export function wouldExceedTpm(model: string, now = Date.now()): boolean {
  const { tpm } = getModelLimits(model);
  if (!tpm) return false;
  return windowTokens(model, now) >= tpm;
}

/** Kalan günlük istek hakkı (RPD tanımsızsa Infinity). */
export function rpdRemaining(model: string, now = Date.now()): number {
  const { rpd } = getModelLimits(model);
  if (rpd === undefined) return Infinity;
  const entry = ensureLoaded().rpd[norm(model)];
  const used = entry && entry.day === dayKey(now) ? entry.count : 0;
  return Math.max(0, rpd - used);
}

// ── 429/1011 öğrenme ─────────────────────────────────────────

export interface QuotaErrorInfo {
  retryDelayMs?: number;
  quotaValue?: number;
  quotaId?: string;
}

// Hardening: upstream hata metnindeki absürt retryDelay (bozuk/oynanmış yanıt)
// modeli süresiz bloklayıp self-DoS yaratmasın — tavan 1 saat.
const MAX_RETRY_DELAY_MS = 3_600_000;

/** Kota hata metninden retryDelay / quotaValue / quotaId çıkarır (bulamazsa boş). */
export function parseQuotaError(message: string): QuotaErrorInfo {
  const info: QuotaErrorInfo = {};
  const delay = /retryDelay["'\s:]*"?(\d+(?:\.\d+)?)s/i.exec(message);
  if (delay) info.retryDelayMs = Math.min(Math.round(parseFloat(delay[1]) * 1000), MAX_RETRY_DELAY_MS);
  const value = /quotaValue["'\s:]*"?(\d+)/i.exec(message);
  if (value) info.quotaValue = parseInt(value[1], 10);
  // RESTQUOTA-1: güncel 429 gövdesinde quotaValue yok; limit metinde
  // "Quota exceeded for metric: …, limit: N" olarak geçiyor (ilk ihlal).
  else {
    const lim = /Quota exceeded for metric:[^,]*,\s*limit:\s*(\d+)/i.exec(message);
    if (lim) info.quotaValue = parseInt(lim[1], 10);
  }
  const id = /quotaId["'\s:]*"?([A-Za-z0-9_-]+)/i.exec(message);
  if (id) info.quotaId = id[1];
  return info;
}

/**
 * Kota hatasını işle: retryDelay kadar (yoksa fallbackCooldownMs) blokla,
 * quotaValue'yu quotaId türüne göre kalıcı limit olarak ÖĞREN.
 */
export function recordQuotaError(
  model: string,
  message: string,
  now = Date.now(),
  fallbackCooldownMs = 60_000,
): QuotaErrorInfo {
  const key = norm(model);
  const info = parseQuotaError(message);

  _blockedUntil.set(key, now + (info.retryDelayMs ?? fallbackCooldownMs));

  if (info.quotaValue !== undefined && info.quotaId) {
    const state = ensureLoaded();
    const learned = state.learned[key] ?? {};
    if (/Token.*PerMinute|PerMinute.*Token/i.test(info.quotaId)) learned.tpm = info.quotaValue;
    else if (/Request.*PerDay|PerDay.*Request/i.test(info.quotaId)) learned.rpd = info.quotaValue;
    else if (/Request.*PerMinute|PerMinute.*Request/i.test(info.quotaId)) learned.rpm = info.quotaValue;
    learned.quotaId = info.quotaId;
    state.learned[key] = learned;
    flushLimitState(); // öğrenme nadir + değerli → anında diske
    logger.info(`Limit öğrenildi: ${key} ${info.quotaId}=${info.quotaValue}`);
  }

  return info;
}

// ── Blok yönetimi ────────────────────────────────────────────

export function blockModel(model: string, untilMs: number): void {
  _blockedUntil.set(norm(model), untilMs);
}

export function isBlocked(model: string, now = Date.now()): boolean {
  const until = _blockedUntil.get(norm(model));
  return until !== undefined && now < until;
}

export function clearBlocks(): void {
  _blockedUntil.clear();
}

// ── Snapshot (/status) ───────────────────────────────────────

export interface RegistryEntrySnapshot {
  limits: ModelLimits;
  windowTokens: number;
  rpdRemaining: number | 'unlimited';
  blockedForMs: number;
}

export function getRegistrySnapshot(now = Date.now()): Record<string, RegistryEntrySnapshot> {
  const keys = new Set<string>([
    ..._windows.keys(),
    ..._blockedUntil.keys(),
    ...Object.keys(ensureLoaded().rpd),
  ]);
  const snap: Record<string, RegistryEntrySnapshot> = {};
  for (const key of keys) {
    const remaining = rpdRemaining(key, now);
    snap[key] = {
      limits: getModelLimits(key),
      windowTokens: windowTokens(key, now),
      rpdRemaining: remaining === Infinity ? 'unlimited' : remaining,
      blockedForMs: Math.max(0, (_blockedUntil.get(key) ?? 0) - now),
    };
  }
  return snap;
}
