// ROUTE-1: 3 şerit + öğrenen kota devresi (SPEC-ROUTE). Ölçülmüş zemin
// (PLANS/archive/MODEL-MATRIX-PROBE-2026-07-03.md + AI Studio kota tablosu):
//   quality     3.1-flash-live  (Live)  TPM 65K  — yalnız gerçek turlara
//   background  2.5-native-audio (Live) TPM 1M   — haiku/özet/compaction işleri
//   longcontext 3.1-flash-lite  (REST)  1M ctx   — Live'a sığmayan istekler (RPD bütçeli)
//   emergency   (opsiyonel REST, örn. gemma)      — her şey blokeyken background
// Sınıflandırma sinyalleri GÜVENİLİRLİK sırasıyla; heuristik uydurulmaz:
// body.model "haiku" = Claude Code'un KENDİ kalite beyanı.
import { getConfig } from './config.js';
import { resolveActiveModel } from './gemini-client.js';
import { isBlocked, wouldExceedTpm, rpdRemaining, getModelLimits } from './limit-registry.js';
import { logger } from './logger.js';

export type Lane = 'quality' | 'background' | 'longcontext' | 'emergency';

export interface RouteDecision {
  lane: Lane;
  /** Karar anındaki model (bilgi amaçlı — Live şeritlerde attempt başına
   *  resolveLaneModel yeniden çözer; REST şeritlerde bu model kullanılır). */
  model: string;
  transport: 'live' | 'rest';
  reason: string;
}

function quality(now: number, reason: string): RouteDecision {
  return { lane: 'quality', model: resolveActiveModel(now), transport: 'live', reason };
}

/**
 * İsteği şeride ata. NOT: persistent-session tool devamları buraya HİÇ gelmez
 * (server.ts onları routing'den ÖNCE session'ına yönlendirir — süreklilik > şerit).
 */
export function decideRoute(
  requestModel: string,
  estTokens: number,
  now = Date.now(),
): RouteDecision {
  const cfg = getConfig();

  if (!cfg.routingEnabled) return quality(now, 'ROUTING=off');

  // 1) background: Claude Code'un kendi "bu iş ucuz olabilir" beyanı.
  if (requestModel.toLowerCase().includes('haiku')) {
    if (!isBlocked(cfg.laneBackgroundModel, now)) {
      return {
        lane: 'background',
        model: cfg.laneBackgroundModel,
        transport: 'live',
        reason: 'body.model=haiku',
      };
    }
    // Background modeli blokeli → acil şerit (tanımlıysa) ya da quality yolu.
    // Emergency YALNIZ background istekleri için (talimat-takibi zayıf modele
    // asla etkileşimli tur verilmez — SPEC-ROUTE risk notu).
    if (cfg.laneEmergencyModel) {
      return {
        lane: 'emergency',
        model: cfg.laneEmergencyModel,
        transport: 'rest',
        reason: 'background blokeli → acil şerit',
      };
    }
    return quality(now, 'background blokeli, acil şerit kapalı');
  }

  // 2) longcontext: ölçülen giriş Live pencerelerini aşıyorsa REST'e.
  if (
    cfg.laneLongContextEnabled &&
    estTokens > cfg.longContextThresholdTokens &&
    longContextBudgetAvailable(now)
  ) {
    return {
      lane: 'longcontext',
      model: cfg.laneLongContextModel,
      transport: 'rest',
      reason: `est=${estTokens} > eşik=${cfg.longContextThresholdTokens}`,
    };
  }

  // 3) Taşma (Faz 4): quality TPM penceresi borçtayken HAFİF turlar background'a
  // taşar (1011'i kaynağında önler); AĞIR turlar quality'de KALIR — ölçülen
  // borçlandırma semantiği: pencere boşalınca ilk büyük istek geçer, 1011
  // gelirse mevcut reaktif fallback (LIVE-19) zaten yakalar.
  if (
    wouldExceedTpm(cfg.geminiModel, now) &&
    !isBlocked(cfg.geminiModel, now) &&
    estTokens <= cfg.overflowLightMaxTokens &&
    !isBlocked(cfg.laneBackgroundModel, now)
  ) {
    return {
      lane: 'background',
      model: cfg.laneBackgroundModel,
      transport: 'live',
      reason: `taşma: quality penceresi dolu, hafif tur (est=${estTokens})`,
    };
  }

  return quality(now, 'default');
}

/** longcontext şeridinin günlük bütçesi (RPD 500'ün güvenlik paylı kısmı). */
function longContextBudgetAvailable(now: number): boolean {
  const cfg = getConfig();
  const limits = getModelLimits(cfg.laneLongContextModel);
  const remaining = rpdRemaining(cfg.laneLongContextModel, now);
  if (remaining === Infinity) return true;
  const budget = Math.min(cfg.longContextRpdBudget, limits.rpd ?? Infinity);
  const used = (limits.rpd ?? budget) - remaining;
  const ok = used < budget;
  if (!ok) logger.warn(`longcontext RPD bütçesi doldu (${used}/${budget}) — şerit bugünlük kapalı`);
  return ok;
}

/**
 * Live şeritlerde attempt başına model çözümü (LIVE-19 per-attempt deseni korunur):
 *   quality    → birincil, blokeliyse fallback (mevcut resolveActiveModel)
 *   background → lane modeli, blokeliyse quality çözümüne düşer
 */
export function resolveLaneModel(lane: Lane, now = Date.now()): string {
  const cfg = getConfig();
  if (lane === 'background' && !isBlocked(cfg.laneBackgroundModel, now)) {
    return cfg.laneBackgroundModel;
  }
  return resolveActiveModel(now);
}
