// SEARCH-QUOTA-1 canlı probe — web_search grounding kota semantiği ölçümü.
// Soru: googleSearch grounding'li REST generateContent (gemini-2.5-flash)
// modelin KENDİ free-tier limitine mi (AI Studio: 5 RPM / 20 RPD) yoksa
// grounding'in AYRI havuzuna mı (1500 RPD) tabi?
// Yöntem: 25 ardışık GERÇEK arama. 429 gelirse gövdedeki quotaId/retryDelay
// ayrıştırılır: PerMinute → bekle-devam (RPM ölçülür), PerDay → dur (RPD kanıtı).
// 22+ arama aynı gün geçerse RPD-20 grounding'e UYGULANMIYOR demektir.
// Kullanım: npx tsx tests/probe-search-quota.ts
// Sonuç arşivi: PLANS/archive/SEARCH-QUOTA-PROBE-2026-07-06.md

import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const MODEL = process.env['GEMINI_SEARCH_MODEL']?.trim() || 'gemini-2.5-flash';
const TARGET = 25;

const apiKey = process.env['GEMINI_API_KEY'];
if (!apiKey) {
  console.error('GEMINI_API_KEY yok — probe koşulamaz');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey });

// Kısa, birbirinden farklı sorgular (cache/tekrar etkisini kırmak için numaralı)
const TOPICS = [
  'İstanbul hava durumu', 'dolar kuru', 'euro kuru', 'altın gram fiyatı',
  'Türkiye gündem haberleri', 'teknoloji haberleri', 'yapay zeka son gelişmeler',
  'Galatasaray son maç sonucu', 'Fenerbahçe son maç', 'bitcoin fiyatı',
  'Ankara hava durumu', 'İzmir hava durumu', 'brent petrol fiyatı',
  'ABD borsa endeksleri', 'Avrupa haberleri', 'sağlık haberleri',
  'otomobil haberleri', 'enerji piyasası haberleri', 'turizm haberleri',
  'eğitim haberleri', 'uzay haberleri', 'iklim haberleri',
  'ekonomi son dakika', 'spor son dakika', 'bilim haberleri',
];

interface CallResult {
  n: number;
  ok: boolean;
  ms: number;
  sources?: number;
  error?: string;
}

function parseQuotaInfo(msg: string): { quotaId?: string; quotaValue?: string; retryDelaySec?: number } {
  const quotaId = msg.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1];
  const quotaValue = msg.match(/"quotaValue"\s*:\s*"?(\d+)"?/)?.[1];
  const retry = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)?.[1];
  return { quotaId, quotaValue, retryDelaySec: retry ? Math.ceil(parseFloat(retry)) : undefined };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function searchOnce(n: number): Promise<CallResult> {
  const t0 = Date.now();
  try {
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: `${TOPICS[(n - 1) % TOPICS.length]} nedir/nedir bugün? (probe #${n}, tek cümle yeter)`,
      config: { tools: [{ googleSearch: {} }] },
    });
    const chunks = resp.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    return { n, ok: true, ms: Date.now() - t0, sources: chunks.length };
  } catch (err) {
    return { n, ok: false, ms: Date.now() - t0, error: (err as Error).message ?? String(err) };
  }
}

async function main(): Promise<void> {
  console.log(`🔬 SEARCH-QUOTA-1 probe — model=${MODEL}, hedef=${TARGET} ardışık grounding araması`);
  console.log(`Başlangıç: ${new Date().toISOString()}\n`);

  const results: CallResult[] = [];
  let okCount = 0;
  let rpm429 = 0;

  for (let n = 1; n <= TARGET; n++) {
    let attempt = 0;
    for (;;) {
      attempt++;
      const r = await searchOnce(n);
      if (r.ok) {
        okCount++;
        results.push(r);
        console.log(`✅ #${n} OK (${(r.ms / 1000).toFixed(1)}s, ${r.sources} kaynak) — toplam ${okCount}`);
        break;
      }
      const info = parseQuotaInfo(r.error ?? '');
      const is429 = /429|RESOURCE_EXHAUSTED|quota/i.test(r.error ?? '');
      console.log(`❌ #${n} FAIL (deneme ${attempt}): ${r.error?.slice(0, 220)}`);
      if (info.quotaId) console.log(`   → quotaId=${info.quotaId} quotaValue=${info.quotaValue} retryDelay=${info.retryDelaySec}s`);

      if (is429 && info.quotaId?.includes('PerDay')) {
        console.log(`\n🏁 SONUÇ: GÜNLÜK limit ${okCount} başarılı aramada doldu — quotaId=${info.quotaId}, quotaValue=${info.quotaValue}`);
        results.push(r);
        report(results, okCount, rpm429, 'RPD limiti kanıtlandı');
        return;
      }
      if (is429 && info.retryDelaySec !== undefined) {
        rpm429++;
        const w = (info.retryDelaySec + 2) * 1000;
        console.log(`   ⏳ RPM penceresi — ${Math.round(w / 1000)}sn bekleniyor (${info.quotaId ?? 'quotaId yok'})`);
        await wait(w);
        continue; // aynı n yeniden
      }
      if (attempt < 3) {
        await wait(3000); // transient — kısa bekle, yeniden dene
        continue;
      }
      results.push(r);
      console.log('   ⛔ 3 denemede geçmedi — sonraki sorguya geçiliyor');
      break;
    }
  }

  const verdict = okCount >= 22
    ? `${okCount}/${TARGET} arama AYNI GÜN geçti → "20 RPD" grounding'e UYGULANMIYOR (ayrı/geniş havuz)`
    : `yalnız ${okCount} geçti — çıktıyı incele`;
  report(results, okCount, rpm429, verdict);
}

function report(results: CallResult[], okCount: number, rpm429: number, verdict: string): void {
  const avg = results.filter((r) => r.ok).reduce((s, r) => s + r.ms, 0) / Math.max(okCount, 1);
  console.log('\n📊 ÖZET');
  console.log(`   Başarılı arama : ${okCount}`);
  console.log(`   RPM-429 sayısı : ${rpm429}`);
  console.log(`   Ortalama süre  : ${(avg / 1000).toFixed(1)}s`);
  console.log(`   KARAR          : ${verdict}`);
  console.log(`   Bitiş: ${new Date().toISOString()}`);
}

main().catch((e) => { console.error('probe hatası:', e); process.exit(1); });
