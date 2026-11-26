// TRANSCRIPT-1: Live native-audio modelleri cevabı sesli üretir; köprü metni
// outputTranscription'dan alır. Canlı ölçümde (2026-11-25) bazı turlarda ses
// 6-8sn sürdüğü hâlde döküm ilk parçada (~17 karakter) kesildi (normal ~10-12
// kr/sn). Böyle bir turda tamponlanan ses REST bir modele yazıya döktürülür ve
// eksik kalan kısım eklenir. Her hata fail-open: mevcut döküm aynen kalır.
import { getAI } from './gemini-client.js';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LOGS_DIR } from './paths.js';

/** Live çıkış sesi: 24kHz, 16-bit, mono PCM. */
export const OUTPUT_SAMPLE_RATE = 24_000;
export const BYTES_PER_SEC = OUTPUT_SAMPLE_RATE * 2;
const MIN_AUDIO_SEC = 2;
const MIN_CHARS_PER_SEC = 5;
const TRANSCRIBE_TIMEOUT_MS = 10_000;

export function isTranscriptTruncated(audioBytes: number, transcriptChars: number): boolean {
  const sec = audioBytes / BYTES_PER_SEC;
  return sec >= MIN_AUDIO_SEC && transcriptChars / sec < MIN_CHARS_PER_SEC;
}

export function pcmToWav(pcm: Buffer, sampleRate = OUTPUT_SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const norm = (c: string): string => c.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]/gu, '');

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/**
 * Zaten akıtılmış döküm `emitted` iken tam metin `full`'un eklenmesi gereken
 * kalanı. Harf/rakam bazında `full`'un başı `emitted` ile karşılaştırılır;
 * yazıya dökme küçük farklar üretebildiği için (canlı: "TSL-8842" → "TCL 8842",
 * "Depodaki" → "Depoda ki") %30'a kadar düzenleme farkı aynı önek sayılır.
 * Önek tutmazsa tam metin yeni paragraf olarak döner.
 */
export function remainderAfter(emitted: string, full: string): string {
  const e = norm(emitted);
  if (!e) return full.trim();
  // full'daki her karakter sonrası için normalize önek; e uzunluğuna en yakın
  // ±%30 aralığında en iyi eşleşen kesim noktası seçilir.
  let best = { dist: Infinity, cut: -1 };
  let acc = '';
  const lo = Math.floor(e.length * 0.7);
  const hi = Math.ceil(e.length * 1.3);
  for (let i = 0; i < full.length; i++) {
    acc += norm(full[i]!);
    if (acc.length > hi) break;
    if (acc.length < lo || !norm(full[i]!)) continue;
    const d = editDistance(acc, e);
    if (d < best.dist) best = { dist: d, cut: i + 1 };
  }
  if (best.cut < 0 || best.dist > Math.floor(e.length * 0.3)) return `\n\n${full.trim()}`;
  return full.slice(best.cut).trimEnd();
}

export type TranscribeFn = (model: string, wav: Buffer, hint?: string) => Promise<string>;

const restTranscribe: TranscribeFn = async (model, wav, hint) => {
  const res = await getAI().models.generateContent({
    model,
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
      { text: 'Transcribe this speech verbatim in its original language. Output only the transcript text, nothing else.' +
        (hint ? ` The speech starts with: "${hint}" — keep that exact spelling for it and for the same names/codes later.` : '') },
    ] }],
  });
  return (res.text ?? '').trim();
};

/** Sesi metne döker; tüm modeller başarısızsa null (fail-open). */
export async function transcribeAudio(pcm: Buffer, hint = '', transcribe: TranscribeFn = restTranscribe): Promise<string | null> {
  const wav = pcmToWav(pcm);
  for (const model of getConfig().transcriptRepairModels) {
    const t0 = Date.now();
    try {
      const text = await Promise.race([
        transcribe(model, wav, hint || undefined),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), TRANSCRIBE_TIMEOUT_MS)),
      ]);
      if (text) {
        logger.info(`Döküm onarıldı (${model}, ${Date.now() - t0}ms, ${text.length}kr)`);
        return text;
      }
    } catch (err) {
      logger.warn(`Döküm onarımı başarısız (${model}): ${(err as Error).message.slice(0, 160)}`);
    }
  }
  return null;
}

/** DEBUG teşhisi: kesik turun sesini logs/audio/ altına WAV olarak yazar. */
export function dumpTurnAudio(pcm: Buffer, emitted: string): void {
  try {
    const dir = join(LOGS_DIR, 'audio');
    mkdirSync(dir, { recursive: true });
    const base = join(dir, `turn-${Date.now()}`);
    writeFileSync(`${base}.wav`, pcmToWav(pcm));
    writeFileSync(`${base}.txt`, emitted);
  } catch { /* teşhis yazımı işi engellemesin */ }
}
