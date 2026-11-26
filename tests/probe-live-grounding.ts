// SEARCH-QUOTA-1 ek probe (2026-07-07) — googleSearch grounding LIVE AUDIO modellerinde.
// Sorular:
//   1. googleSearch-ONLY Live session (functionDeclarations YOK) çalışıyor mu?
//      (Bilinen Google kısıtı yalnız googleSearch+functionDeclarations BİRLİKTE reddi.)
//   2. Çalışıyorsa REST grounding'in RPM=5 duvarını paylaşıyor mu? (7 hızlı ardışık
//      arama: Live'da RPM/RPD Unlimited [LIMIT-PROBE-1] — 6.-7. arama 1011 vermezse
//      dakika havuzu AYRI demektir → "günde 20" REST duvarını aşan aday yol.)
// Kullanım: npx tsx tests/probe-live-grounding.ts
// Sonuç arşivi: PLANS/archive/SEARCH-QUOTA-PROBE-2026-07-06.md (ek bölüm)

import { GoogleGenAI, Modality, ThinkingLevel } from '@google/genai';
import type { LiveServerMessage, Session } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env['GEMINI_API_KEY'];
if (!apiKey) { console.error('GEMINI_API_KEY yok'); process.exit(1); }
const ai = new GoogleGenAI({ apiKey });

const G3 = 'models/gemini-3.1-flash-live-preview';
const G25 = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
const SEARCH_TIMEOUT = 45_000;

interface LiveSearchResult {
  ok: boolean;
  ms: number;
  text: string;
  sources: number;
  sawGroundingMeta: boolean;
  error?: string;
}

// Köprünün buildConnectConfig'iyle aynı iskelet (AUDIO + transkripsiyon + VAD/thinking
// ailesine göre) — ama tools = googleSearch ONLY (probe'un konusu bu).
function connectConfig(model: string): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    responseModalities: [Modality.AUDIO],
    outputAudioTranscription: {},
    inputAudioTranscription: {},
    sessionResumption: {},
    tools: [{ googleSearch: {} }],
  };
  if (/gemini-3/i.test(model)) {
    cfg['thinkingConfig'] = { thinkingLevel: ThinkingLevel.LOW };
  } else {
    cfg['thinkingConfig'] = { thinkingBudget: 0 };
    cfg['realtimeInputConfig'] = { automaticActivityDetection: { disabled: true } };
  }
  return cfg;
}

function liveSearch(model: string, query: string): Promise<LiveSearchResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let text = '';
    let sources = 0;
    let sawGroundingMeta = false;
    let session: Session | null = null;
    let done = false;

    const finish = (ok: boolean, error?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { session?.close(); } catch { /* sessiz */ }
      resolve({ ok, ms: Date.now() - t0, text: text.trim(), sources, sawGroundingMeta, error });
    };
    const timer = setTimeout(() => finish(false, `timeout ${SEARCH_TIMEOUT}ms`), SEARCH_TIMEOUT);

    ai.live.connect({
      model,
      config: connectConfig(model),
      callbacks: {
        onopen: () => { /* setupComplete bekleniyor */ },
        onmessage: (msg: LiveServerMessage) => {
          if (msg.setupComplete) {
            try {
              session!.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: query }] }],
                turnComplete: true,
              });
            } catch (e) { finish(false, `send: ${(e as Error).message}`); }
            return;
          }
          const sc = msg.serverContent as Record<string, unknown> | undefined;
          if (sc) {
            const tr = (sc['outputTranscription'] as { text?: string } | undefined)?.text;
            if (tr) text += tr;
            // groundingMetadata Live'da serverContent altında gelebilir — keşif amaçlı her yeri say
            const gm = (sc['groundingMetadata'] ?? (sc['modelTurn'] as Record<string, unknown> | undefined)?.['groundingMetadata']) as
              { groundingChunks?: unknown[] } | undefined;
            if (gm) {
              sawGroundingMeta = true;
              sources = Math.max(sources, gm.groundingChunks?.length ?? 0);
            }
            if (sc['turnComplete']) finish(true);
          }
        },
        onerror: (e) => finish(false, `onerror: ${e.message}`),
        onclose: (e) => finish(false, `onclose: ${e.code} ${e.reason ?? ''}`),
      },
    }).then(
      (s) => { session = s; },
      (e) => finish(false, `connect: ${(e as Error).message}`),
    );
  });
}

// ── 2026-07-07 KOŞU SONUCU (kanıt: PLANS/archive/SEARCH-QUOTA-PROBE-2026-07-06.md ek bölüm) ──
// · 3.1-flash-live: grounding'siz ✅ / grounding'li ANINDA 1011 → 3.1-live free
//   tier'da googleSearch DESTEKLENMİYOR (model kotası değil, grounding'e özgü red).
// · 2.5-native-audio: grounding ✅ (groundingMetadata + kaynaklar, 4-15sn) ·
//   7/7 hızlı seri (RPM=5 YOK) · aynı gün 21 arama (RPD=20 YOK) · 21 arama
//   sonrası REST 2.5-flash grounded hâlâ OK → HAVUZLAR AYRI. Tek sınır TPM=1M.

async function main(): Promise<void> {
  console.log(`🔬 LIVE grounding probe — ${new Date().toISOString()}\n`);

  // ── Bölüm 1: çalışıyor mu? (her modelde 1 grounded arama) ──
  for (const model of [G3, G25]) {
    const r = await liveSearch(model, 'Bugün dolar/TL kuru yaklaşık kaç? Web\'de ara, tek cümleyle söyle.');
    console.log(`${r.ok ? '✅' : '❌'} ${model}`);
    console.log(`   ${(r.ms / 1000).toFixed(1)}s · groundingMeta=${r.sawGroundingMeta} · sources=${r.sources}`);
    if (r.text) console.log(`   → "${r.text.slice(0, 140)}"`);
    if (r.error) console.log(`   hata: ${r.error.slice(0, 200)}`);
    console.log();
  }

  // ── Bölüm 2: RPM=5 duvarı paylaşımı (2.5-audio — grounding'in çalıştığı model) ──
  console.log('— RPM paylaşım testi: 2.5-audio ile 7 hızlı ardışık arama (REST RPM=5 ise 6.-7. patlar) —');
  const topics = ['euro kuru', 'altın fiyatı', 'bitcoin fiyatı', 'İstanbul hava', 'Ankara hava', 'brent petrol', 'borsa endeksi'];
  let okCount = 0;
  for (let i = 0; i < 7; i++) {
    const r = await liveSearch(G25, `${topics[i]} bugün ne durumda? Web'de ara, tek kısa cümle.`);
    if (r.ok) okCount++;
    console.log(`${r.ok ? '✅' : '❌'} #${i + 1} (${(r.ms / 1000).toFixed(1)}s, meta=${r.sawGroundingMeta}, src=${r.sources})${r.error ? ` — ${r.error.slice(0, 160)}` : ''}`);
  }
  console.log(`\n📊 Hızlı seri: ${okCount}/7 — ${okCount >= 6 ? 'RPM=5 duvarı GÖRÜLMEDİ (dakika havuzu REST\'ten AYRI)' : 'duvar/hata var — çıktıyı incele'}`);
  console.log('Günlük havuz ayrımı için: aynı gün toplam Live aramayı 21+ yap, sonra 1 REST');
  console.log('grounded istek at — REST OK ise havuzlar ayrı (2026-07-07 koşusunda kanıtlandı).');
  console.log(`Bitiş: ${new Date().toISOString()}`);
}

main().catch((e) => { console.error('probe hatası:', e); process.exit(1); });
