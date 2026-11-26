// Eski "native-audio-dialog" model adları hâlâ Live connect kabul ediyor mu?
// Kullanım: npx tsx tests/probe-dialog-model.ts
import 'dotenv/config';
import { GoogleGenAI, Modality } from '@google/genai';
import type { LiveServerMessage } from '@google/genai';

const apiKey = process.env['GEMINI_API_KEY']?.trim();
if (!apiKey) { console.error('GEMINI_API_KEY yok'); process.exit(1); }
const ai = new GoogleGenAI({ apiKey });

const CANDIDATES = [
  'models/gemini-2.5-flash-preview-native-audio-dialog',
  'models/gemini-2.5-flash-native-audio-dialog',
  'models/gemini-2.5-flash-exp-native-audio-thinking-dialog',
];

function tryConnect(model: string): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session?.close(); } catch { /* sessiz */ }
      resolve(msg);
    };
    const timer = setTimeout(() => done('TIMEOUT (20s)'), 20_000);
    let session: { close(): void } | null = null;
    ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        thinkingConfig: { thinkingBudget: 0 },
      },
      callbacks: {
        onopen: () => {},
        onmessage: (msg: LiveServerMessage) => { if (msg.setupComplete) done('BAĞLANDI (setupComplete)'); },
        onerror: (e: { message?: string }) => done(`ERROR: ${e.message?.slice(0, 100)}`),
        onclose: (e: { code?: number; reason?: string }) => done(`CLOSED: ${e.code} ${(e.reason || '').slice(0, 100)}`),
      },
    }).then((s) => { session = s as typeof session; }).catch((err) => done(`CONNECT_FAIL: ${String(err).slice(0, 100)}`));
  });
}

for (const m of CANDIDATES) {
  console.log(`[${m}] → ${await tryConnect(m)}`);
}
process.exit(0);
