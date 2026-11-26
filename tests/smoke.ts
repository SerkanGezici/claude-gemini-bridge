// Gerçek API entegrasyon smoke testi — MOCK YOK.
// Bridge'i --bridge-only modda başlatır, gerçek Gemini Live API'ye karşı
// 4 senaryo doğrular:
//   1. Non-streaming basit yanıt
//   2. Tool call → persistent session → tool result → final yanıt
//   3. Büyük payload (20KB system prompt + uzun history) — 1007 regresyonu
//   4. SSE streaming yanıt
// Kullanım: npx tsx tests/smoke.ts

import { spawn, type ChildProcess } from 'child_process';

const PORT = 8019;
const TOKEN = 'smoke-test-token';
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': TOKEN,
};

let bridge: ChildProcess | null = null;
let passed = 0;
let failed = 0;

function log(msg: string): void {
  console.log(msg);
}

// /mnt/c (WSL) IO yavaş: tsx cold start + fastify import ~25-30s sürebilir
async function waitForHealth(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* henüz açılmadı */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Bridge health check timeout');
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

async function postMessages(body: Record<string, unknown>, timeoutMs = 60_000): Promise<Response> {
  return fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    passed++;
    log(`✅ ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed++;
    log(`❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  // Pre-flight: port dolu ise STALE bridge var demektir — eski kodla konuşup
  // yanlış teşhise yol açar (2026-06-11: 5/5 timeout'un sebebi buydu).
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) {
      log(`❌ Port ${PORT} dolu — stale bridge çalışıyor. Önce temizle:`);
      log('   pkill -f "tsx src/index.ts --bridge-only"');
      process.exit(1);
    }
  } catch { /* port boş — devam */ }

  log('🚀 Smoke test başlıyor — bridge --bridge-only başlatılıyor...');

  // detached: process group lideri olsun — teardown'da grubu komple öldürürüz.
  // (SIGTERM sadece npx wrapper'ına gidince torun tsx/node hayatta kalıyor ve
  // bir SONRAKİ smoke koşusunu stale-bridge ile patlatıyordu — 2026-06-11.)
  bridge = spawn('npx', ['tsx', 'src/index.ts', '--bridge-only'], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(PORT),
      BRIDGE_TOKEN: TOKEN,
      DEBUG: 'false',
      // .env'de eski "-latest" alias'ı kalmış olabilir — dotenv mevcut env'i
      // override edemez, bu yüzden doğru model burada sabitlenir.
      GEMINI_MODEL: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bridge.stdout?.on('data', (d: Buffer) => process.stdout.write(`[bridge] ${d}`));
  bridge.stderr?.on('data', (d: Buffer) => process.stderr.write(`[bridge] ${d}`));

  await waitForHealth();
  log('✅ Bridge ayakta\n');

  // ── Test 1: Basit non-streaming yanıt ──
  await test('T1 basit yanıt (non-streaming)', async () => {
    const res = await postMessages({
      model: 'claude-sonnet-4-20250514',
      stream: false,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Merhaba! Tek kısa cümleyle selam ver.' }],
    });
    assert(res.ok, `HTTP ${res.status}`);
    const data = (await res.json()) as AnthropicResponse;
    const text = data.content.find((c) => c.type === 'text')?.text ?? '';
    assert(text.trim().length > 0, 'Boş yanıt döndü (empty turn?)');
    assert(data.usage.input_tokens > 0, 'input_tokens 0 — tahmin çalışmıyor');
    log(`   → "${text.slice(0, 80)}"`);
  });

  // ── Test 2: Tool call → persistent session → tool result ──
  await test('T2 tool call + persistent session devamı', async () => {
    const tools = [
      {
        name: 'get_weather',
        description: 'Bir şehrin güncel hava durumunu döndürür',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ];
    const userMsg = {
      role: 'user',
      content: 'İstanbul hava durumunu get_weather aracıyla öğren ve bana söyle.',
    };
    const res1 = await postMessages({
      model: 'claude-sonnet-4-20250514',
      stream: false,
      max_tokens: 1024,
      tools,
      messages: [userMsg],
    });
    assert(res1.ok, `İlk istek HTTP ${res1.status}`);
    const data1 = (await res1.json()) as AnthropicResponse;
    const toolUse = data1.content.find((c) => c.type === 'tool_use');
    assert(toolUse, `tool_use bloğu yok — stop_reason=${data1.stop_reason}`);
    assert(data1.stop_reason === 'tool_use', `stop_reason ${data1.stop_reason}`);
    log(`   → tool çağrıldı: ${toolUse.name}(${JSON.stringify(toolUse.input)})`);

    // Tool result'ı geri gönder — persistent session'a düşmeli
    const res2 = await postMessages({
      model: 'claude-sonnet-4-20250514',
      stream: false,
      max_tokens: 1024,
      tools,
      messages: [
        userMsg,
        { role: 'assistant', content: data1.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: 'İstanbul: 22°C, parçalı bulutlu, nem %55',
            },
          ],
        },
      ],
    });
    assert(res2.ok, `Tool result isteği HTTP ${res2.status}`);
    const data2 = (await res2.json()) as AnthropicResponse;
    const finalText = data2.content.find((c) => c.type === 'text')?.text ?? '';
    assert(finalText.trim().length > 0, 'Tool result sonrası boş yanıt');
    log(`   → final: "${finalText.slice(0, 80)}"`);
  });

  // ── Test 3: Büyük payload (1007 regresyon testi) ──
  await test('T3 büyük payload (20KB system + uzun history)', async () => {
    const bigSystem =
      'Sen yardımcı bir asistansın. Şu kurallara uy:\n' +
      'Kural: her yanıtı Türkçe ver. '.repeat(650); // ~20KB
    const history: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
      history.push({ role: 'user', content: `Soru ${i}: ${'lorem ipsum dolor '.repeat(60)}` });
      history.push({ role: 'assistant', content: `Yanıt ${i}: ${'tamam anladım '.repeat(40)}` });
    }
    history.push({ role: 'user', content: 'Son soru: 2+2 kaç eder? Sadece sayıyla cevapla.' });

    const res = await postMessages({
      model: 'claude-sonnet-4-20250514',
      stream: false,
      max_tokens: 1024,
      system: bigSystem,
      messages: history,
    });
    assert(res.ok, `HTTP ${res.status} — büyük payload reddedildi (1007 regresyonu?)`);
    const data = (await res.json()) as AnthropicResponse;
    const text = data.content.find((c) => c.type === 'text')?.text ?? '';
    assert(text.trim().length > 0, 'Büyük payload sonrası boş yanıt (1007/empty turn?)');
    log(`   → "${text.slice(0, 60)}"`);
  });

  // ── Test 4: SSE streaming ──
  await test('T4 SSE streaming yanıt', async () => {
    const res = await postMessages({
      model: 'claude-sonnet-4-20250514',
      stream: true,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Bir cümleyle bugün günlerden ne olduğunu bilmediğini söyle.' }],
    });
    assert(res.ok, `HTTP ${res.status}`);
    const raw = await res.text();
    assert(raw.includes('event: message_start'), 'message_start yok');
    assert(raw.includes('content_block_delta'), 'hiç text delta gelmedi (empty turn?)');
    assert(raw.includes('event: message_stop'), 'message_stop yok — stream düzgün kapanmadı');
    const deltas = [...raw.matchAll(/"text_delta","text":"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => JSON.parse(`"${m[1]}"`))
      .join('');
    assert(deltas.trim().length > 0, 'Delta metni boş');
    log(`   → stream: "${deltas.slice(0, 80)}"`);
  });

  // ── Test 5: Tool geçmişli history replay (1007 regresyonu — 2026-06-11 canlı oturum) ──
  // tool_use_id kayıtlı DEĞİL → persistent session yok → full replay yolu zorlanır.
  // Fix öncesi: functionCall/functionResponse partları clientContent'te → 1007.
  await test('T5 tool geçmişli history replay (yeni bağlantı)', async () => {
    const res = await postMessages({
      model: 'claude-sonnet-4-20250514',
      stream: false,
      max_tokens: 1024,
      tools: [
        {
          name: 'Skill',
          description: 'Bir skill çalıştırır',
          input_schema: {
            type: 'object',
            properties: { skill: { type: 'string' } },
            required: ['skill'],
          },
        },
      ],
      messages: [
        { role: 'user', content: 'merhaba' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_replay_1', name: 'Skill', input: { skill: 'using-superpowers' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_replay_1', content: 'skill yüklendi' },
          ],
        },
        { role: 'assistant', content: 'Let me check' },
        { role: 'user', content: 'nasılsın? Tek kısa cümleyle cevapla.' },
      ],
    });
    assert(res.ok, `HTTP ${res.status} — tool geçmişli replay reddedildi (1007 regresyonu?)`);
    const data = (await res.json()) as AnthropicResponse;
    const text = data.content.find((c) => c.type === 'text')?.text ?? '';
    assert(text.trim().length > 0, 'Tool geçmişli replay sonrası boş yanıt (1007?)');
    log(`   → "${text.slice(0, 80)}"`);
  });

  log(`\n📊 Sonuç: ${passed} geçti, ${failed} kaldı`);
  killBridge();
  process.exit(failed > 0 ? 1 : 0);
}

/** Bridge process GRUBUNU öldür — tek SIGTERM npx wrapper'ında kalıyor */
function killBridge(): void {
  if (!bridge?.pid) return;
  try {
    process.kill(-bridge.pid, 'SIGTERM');
  } catch {
    bridge.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  killBridge();
  process.exit(1);
});
