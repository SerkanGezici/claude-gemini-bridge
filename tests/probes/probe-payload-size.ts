// PAYLOAD BOYUT probe'u — clientContent.turns içindeki TEXT boyutunu kademeli
// büyütüp gerçek 1007/limit eşiğini bulur (part-tipi DEĞİL, salt-text → LIVE-8
// tuzağına düşmez). Plandaki "90KB'de 1007" varsayımını kanıta bağlar.
// Kullanım: GEMINI_MODEL=models/gemini-3.1-flash-live-preview npx tsx tests/probe-payload-size.ts
import 'dotenv/config';
import { GoogleGenAI, Modality, ThinkingLevel } from '@google/genai';
import type { LiveServerMessage } from '@google/genai';

const apiKey = process.env['GEMINI_API_KEY']?.trim();
const model = process.env['GEMINI_MODEL']?.trim() || 'gemini-2.5-flash-native-audio-preview-12-2025';
if (!apiKey) {
  console.error('GEMINI_API_KEY yok');
  process.exit(1);
}
console.log(`Model: ${model}`);
const ai = new GoogleGenAI({ apiKey });
const isGemini3 = model.toLowerCase().includes('gemini-3');

function buildConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {
    responseModalities: [Modality.AUDIO],
    outputAudioTranscription: {},
    inputAudioTranscription: {},
    sessionResumption: {},
    systemInstruction: { parts: [{ text: 'Çok kısa cevap ver, tek kelime.' }] },
  };
  if (isGemini3) {
    config['thinkingConfig'] = { thinkingLevel: ThinkingLevel.LOW };
  } else {
    config['realtimeInputConfig'] = { automaticActivityDetection: { disabled: true } };
    config['thinkingConfig'] = { thinkingBudget: 0 };
  }
  return config;
}

// Sentinel'i metnin SONUNA koy: model okuduysa onu söyler → payload tam ulaştı mı anlaşılır.
function buildPayload(sizeChars: number): string {
  const sentinel = ' SONKELIME=ANKA.';
  const filler = 'Bu bir dolgu cümlesidir ve sadece boyut için tekrarlanır. ';
  const need = Math.max(0, sizeChars - sentinel.length);
  const body = filler.repeat(Math.ceil(need / filler.length)).slice(0, need);
  return `Asagidaki metnin EN SONUNDAKI kelimeyi soyle:\n${body}${sentinel}`;
}

const SIZES = [20_000, 50_000, 90_000, 150_000, 250_000, 400_000];

function runSize(sizeChars: number): Promise<string> {
  return new Promise((resolve) => {
    let transcript = '';
    let settled = false;
    const t0 = performance.now();
    const done = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session?.close(); } catch { /* sessiz */ }
      const ms = Math.round(performance.now() - t0);
      resolve(`${msg} (${ms}ms)`);
    };
    const timer = setTimeout(() => done('TIMEOUT(45s)'), 45_000);

    let session: { close(): void; sendClientContent(p: unknown): void } | null = null;
    const text = buildPayload(sizeChars);
    ai.live.connect({
      model,
      config: buildConfig(),
      callbacks: {
        onopen: () => {},
        onmessage: (msg: LiveServerMessage) => {
          if (msg.setupComplete) {
            session?.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
            return;
          }
          if (msg.serverContent?.outputTranscription?.text) transcript += msg.serverContent.outputTranscription.text;
          if (msg.serverContent?.generationComplete || msg.serverContent?.turnComplete) {
            const hit = transcript.toUpperCase().includes('ANKA') ? ' [SENTINEL✓]' : ' [sentinel✗]';
            done(`OK: "${transcript.slice(0, 50).replace(/\n/g, ' ')}"${hit}`);
          }
        },
        onerror: (e: { message?: string }) => done(`ERROR: ${e.message}`),
        onclose: (e: { code?: number; reason?: string }) => done(`CLOSED: code=${e.code} ${(e.reason || '').slice(0, 80)}`),
      },
    }).then((s) => { session = s as typeof session; }).catch((err) => done(`CONNECT_FAIL: ${err.message}`));
  });
}

for (const size of SIZES) {
  const kb = (size / 1024).toFixed(0);
  const result = await runSize(size);
  console.log(`[${String(size).padStart(7)} char ~${kb}KB] → ${result}`);
}
process.exit(0);
