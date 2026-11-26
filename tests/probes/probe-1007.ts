// 1007 kök sebep probe'u — clientContent.turns içindeki part tiplerini izole eder.
// Hipotez H1: functionCall/functionResponse partları replay'de 1007 tetikliyor.
// Kullanım: npx tsx tests/probe-1007.ts
import 'dotenv/config';
import { GoogleGenAI, Modality, ThinkingLevel } from '@google/genai';
import type { LiveServerMessage } from '@google/genai';

const apiKey = process.env['GEMINI_API_KEY']?.trim();
const model = process.env['GEMINI_MODEL']?.trim() || 'gemini-2.5-flash-native-audio-preview-12-2025';
if (!apiKey) {
  console.error('GEMINI_API_KEY yok');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });
const isGemini3 = model.toLowerCase().includes('gemini-3');

function buildConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {
    responseModalities: [Modality.AUDIO],
    outputAudioTranscription: {},
    inputAudioTranscription: {},
    sessionResumption: {},
    systemInstruction: { parts: [{ text: 'Kısa cevap ver.' }] },
    tools: [{
      functionDeclarations: [{
        name: 'Skill',
        description: 'Execute a skill',
        parameters: {
          type: 'object',
          properties: { skill: { type: 'string' } },
          required: ['skill'],
        },
      }],
    }],
  };
  if (isGemini3) {
    config['thinkingConfig'] = { thinkingLevel: ThinkingLevel.LOW };
  } else {
    config['realtimeInputConfig'] = { automaticActivityDetection: { disabled: true } };
    config['thinkingConfig'] = { thinkingBudget: 0 };
  }
  return config;
}

type Turn = { role: string; parts: Record<string, unknown>[] };

// Bridge'in 2. turda replay ettiği history'nin birebir minyatürü
const fcPart = { functionCall: { name: 'Skill', args: { skill: 'superpowers:using-superpowers' } } };
const frPart = { functionResponse: { name: 'Skill', response: { result: 'skill yüklendi (özet)' } } };

const CASES: Array<{ name: string; turns: Turn[] }> = [
  {
    name: 'A: salt-text history (kontrol)',
    turns: [
      { role: 'user', parts: [{ text: 'merhaba' }] },
      { role: 'model', parts: [{ text: 'Let me check' }] },
      { role: 'user', parts: [{ text: 'nasılsın' }] },
    ],
  },
  {
    name: 'B: functionCall + functionResponse partlı (bridge davranışı)',
    turns: [
      { role: 'user', parts: [{ text: 'merhaba' }] },
      { role: 'model', parts: [fcPart] },
      { role: 'user', parts: [frPart] },
      { role: 'model', parts: [{ text: 'Let me check' }] },
      { role: 'user', parts: [{ text: 'nasılsın' }] },
    ],
  },
  {
    name: 'C: sadece functionCall partı',
    turns: [
      { role: 'user', parts: [{ text: 'merhaba' }] },
      { role: 'model', parts: [fcPart] },
      { role: 'user', parts: [{ text: 'nasılsın' }] },
    ],
  },
  {
    name: 'D: sadece functionResponse partı',
    turns: [
      { role: 'user', parts: [{ text: 'merhaba' }] },
      { role: 'model', parts: [{ text: 'bakıyorum' }] },
      { role: 'user', parts: [frPart, { text: 'nasılsın' }] },
    ],
  },
];

function runCase(name: string, turns: Turn[]): Promise<string> {
  return new Promise((resolve) => {
    let transcript = '';
    let settled = false;
    const done = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session?.close(); } catch { /* sessiz */ }
      resolve(msg);
    };
    const timer = setTimeout(() => done('TIMEOUT (45s)'), 45_000);

    let session: { close(): void; sendClientContent(p: unknown): void } | null = null;
    ai.live.connect({
      model,
      config: buildConfig(),
      callbacks: {
        onopen: () => {},
        onmessage: (msg: LiveServerMessage) => {
          if (msg.setupComplete) {
            session?.sendClientContent({ turns, turnComplete: true });
            return;
          }
          if (msg.toolCall) { done(`TOOL_CALL: ${JSON.stringify(msg.toolCall.functionCalls?.map((f) => f.name))}`); return; }
          if (msg.serverContent?.outputTranscription?.text) transcript += msg.serverContent.outputTranscription.text;
          if (msg.serverContent?.generationComplete || msg.serverContent?.turnComplete) {
            done(`OK: "${transcript.slice(0, 80)}"`);
          }
        },
        onerror: (e: { message?: string }) => done(`ERROR: ${e.message}`),
        onclose: (e: { code?: number; reason?: string }) => done(`CLOSED: ${e.code} ${e.reason || ''}`),
      },
    }).then((s) => { session = s as typeof session; }).catch((err) => done(`CONNECT_FAIL: ${err.message}`));
  });
}

for (const c of CASES) {
  const result = await runCase(c.name, c.turns);
  console.log(`[${c.name}] → ${result}`);
}
process.exit(0);
