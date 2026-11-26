import type {
  AnthropicRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  GeminiTurn,
  GeminiPart,
} from './types.js';
import { toolResultText } from './tool-mapper.js';
 
// ── Payload Bütçeleri ────────────────────────────────────────
// Eski sabit kırpmalar (5k system, son 5 turn, 2k tool result) Claude Code'u
// işlevsiz bırakıyordu: system prompt'un %80'i ve 5 mesaj öncesi atılıyordu.
// Yeni yaklaşım: byte bütçesi — mümkün olan en fazla bağlamı koru.
// LIMIT-PROBE-1 (2026-06-18, tests/probe-payload-size.ts CANLI ölçüm): Eski
// "90KB'de 1007" varsayımı YANLIŞTI. Gerçek 1007 (invalid argument) BOYUT eşiği
// ~250-390KB (2.5 native-audio 244KB'yi sorunsuz işledi, 391KB'de 1007). Asıl
// darboğaz BOYUT/1007 değil, gemini-3.1-flash-live'ın iki zayıflığı:
//   (a) TPM 65K → ~146KB'de (veya kümülatif birkaç istekte) 1011 → fallback,
//   (b) ~50KB+ TEK metinde içeriğin SONUNU kaçırma (dikkat sınırı; 2.5'te yok).
// Bu yüzden cap'ler 1007 için DEĞİL, 3.1'in TPM+dikkat zayıflığı için tutulur —
// ve TURNS_BYTE_BUDGET (48k) tesadüfen 3.1'in ~50KB sonu-kaçırma sınırına denk
// gelir (iyi ayar). 2.5 fallback'te kapasite çok daha yüksek (TPM 1M, 244KB+).
export const SYSTEM_PROMPT_MAX_CHARS = 24_000; // setup frame'de gider (turns'ten ayrı)
export const TURNS_BYTE_BUDGET = 48_000; // client_content JSON bütçesi
export const TOOL_RESULT_MAX_CHARS = 4_000;
// CAP-1 (2026-06-18): REPLAY'de (toGeminiTurns) tool_result'lar KÜMÜLATİF — N adet
// geçmiş sonuç tek payload'da gider, bu yüzden 4k düşük tutulur (3.1 TPM 65K'yı
// hızlı tüketmesin diye; 1007 değil — LIMIT-PROBE-1).
// Ama CANLI tool-response (server.ts buildGeminiToolResponses) persistent session'a
// TEK sonuç gönderir (history yeniden gitmez) → 4k gereksiz agresifti: model büyük
// bir dosyayı okuyunca sadece ilk ~55 satırı görüp gerçek veriyi bulmak için 4 ayrı
// offset'li Read denemesi + ~2dk harcıyordu (canlı TEST 21 kanıtı, kod/buyuk_log.txt
// 12.7KB, SECRET_KOD offset 9074 kesiliyordu). Tek sonuç hem 1007 boyut eşiğinin
// (~250KB) hem 3.1'in ~50KB dikkat sınırının altında kaldığından canlı kanal için
// ayrı, yüksek bir tavan (32k) kullanılır — TEST 25: 32k+ sonuç 1007 vermedi.
export const LIVE_TOOL_RESULT_MAX_CHARS = 32_000;
export const TOOL_ARGS_MAX_CHARS = 1_000; // tool_use input JSON üst sınırı (replay)
// Part başına text üst sınırı. 2026-06-11 canlı kanıt: superpowers hook'u tek
// mesajda 36KB gönderiyor; atomik turn-drop bütçeyi yutup kullanıcının sorusunu
// düşürüyordu (Gemini görevsiz kalıp "Let me check" diyordu). Part kırpılır,
// turn ASLA komple düşmesin diye bütçe döngüsü backstop olarak kalır.
export const TURN_TEXT_MAX_CHARS = 12_000;

/**
 * Anthropic request'ten system prompt'u çıkarır.
 */
export function extractSystemPrompt(request: AnthropicRequest): string | undefined {
  if (!request.system) return undefined;
  if (typeof request.system === 'string') return truncateSystem(request.system);
  const raw = request.system
    .filter((b): b is AnthropicTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return truncateSystem(raw);
}

function truncateSystem(raw: string): string {
  return raw.length > SYSTEM_PROMPT_MAX_CHARS
    ? raw.slice(0, SYSTEM_PROMPT_MAX_CHARS) + '...'
    : raw;
}

/**
 * Nihai systemInstruction'ı kurar: bridge talimatı + request.system +
 * messages[] içindeki role:"system" metadata mesajları (Claude Code 2.1.x
 * hook çıktısı / MCP talimatları / skill kataloğunu böyle gönderiyor —
 * 2026-06-11 canlı dump kanıtı). Bunlar konuşma turn'ü DEĞİL: turns'e
 * sokulunca son turn katalog duvarına dönüşüp Gemini'yi susturuyordu.
 * Birebir aynı system mesajları tekilleştirilir (katalog 2x geliyor).
 */
export function buildSystemPrompt(
  request: AnthropicRequest,
  bridgeInstruction: string,
): string {
  const pieces: string[] = [bridgeInstruction];

  const requestSystem = extractSystemPrompt(request);
  if (requestSystem) pieces.push(requestSystem);

  const seen = new Set<string>();
  for (const msg of request.messages) {
    if (msg.role !== 'system') continue;
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((b): b is AnthropicTextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    pieces.push(text);
  }

  return truncateSystem(pieces.join('\n\n'));
}
 
/**
 * Anthropic messages dizisini Gemini turns dizisine dönüştürür.
 * HAFIZA: Sondan başa byte bütçesi — sabit "son 5 mesaj" yerine bütçeye
 * sığan en uzun geçmiş korunur.
 */
export function toGeminiTurns(messages: AnthropicMessage[]): GeminiTurn[] {
  const turns: GeminiTurn[] = [];
  const toolIdToName = new Map<string, string>();
 
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolIdToName.set(block.id, block.name);
      }
    }
  }
 
  for (const msg of messages) {
    // role:"system" metadata mesajları turn değil — buildSystemPrompt
    // bunları systemInstruction'a taşır (yukarıdaki açıklamaya bak).
    if (msg.role === 'system') continue;
    // Claude Code, boş yanıtları "No response requested." olarak kaydeder.
    // Bu KENDİ hata artefaktımız: replay'de model "soru → sessizlik" kalıbını
    // taklit edip yine susuyor (2026-06-11 m17 kanıtı). Süz.
    if (msg.role === 'assistant' && isEmptyResponseArtifact(msg.content)) continue;
    const parts = contentToParts(msg.content, toolIdToName);
    if (parts.length === 0) continue;
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const prev = turns[turns.length - 1];
    // Ardışık aynı-rol turn'leri birleştir: Claude Code "Continue from where
    // you left off." + soruyu ayrı user mesajları gönderiyor; gemini-3.x katı
    // role-alternation bekliyor (2026-06-11: 3.1-flash-live replay'de 1007).
    if (prev && prev.role === role) {
      prev.parts.push(...parts);
    } else {
      turns.push({ role, parts });
    }
  }
 
  // Sondan başa byte bütçesi: en yeni turn her zaman dahil, geriye doğru
  // bütçe doldukça ekle. (Eski sabit slice(-5) bağlam kaybının ana sebebiydi.)
  const selected: GeminiTurn[] = [];
  let budget = TURNS_BYTE_BUDGET;
  for (let i = turns.length - 1; i >= 0; i--) {
    const size = JSON.stringify(turns[i]).length;
    if (selected.length > 0 && size > budget) break;
    selected.unshift(turns[i]);
    budget -= size;
  }
  return selected;
}
 
/**
 * Gemini 3.x Live replay düzleştirmesi. KANIT (2026-06-11, D2/D3 probe):
 * gemini-3.1-flash-live clientContent'te 'model' rolü turn'leri 1007
 * "invalid argument" ile reddediyor — 3 minicik text turn bile. Çok turlu
 * history tek user-turn transkripte çevrilir; bağlam korunur (D3: model
 * transkriptteki bilgiyi doğru hatırladı). inlineData partları ek part
 * olarak taşınır. 2.5 modellerinde KULLANILMAZ (server isGemini3 ile seçer).
 */
export const FLATTEN_HEADER = '[Önceki konuşmanın dökümü]';
export const FLATTEN_FOOTER = '[Dökümün sonu]';
// LIVE-20: model bu işaretçileri ve "[tool_use: ...]" notasyonunu taklit edip
// cevabına yazabiliyor (2026-06-11 canlı transcript kanıtı) — açık uyarı koy.
const FLATTEN_IMITATION_WARNING =
  '(Bu döküm SALT BAĞLAMDIR. Format taklit edilmez: araç kullanman gerekiyorsa ' +
  'GERÇEK fonksiyon çağrısı yap; "[tool_use: ...]" benzeri metni ASLA yazma.)';

/** Model çıktısına sızan flatten işaretçilerini temizler (LIVE-20). */
export function scrubFlattenMarkers(text: string): string {
  return text.split(FLATTEN_HEADER).join('').split(FLATTEN_FOOTER).join('');
}

export function flattenTurnsToSingleUser(turns: GeminiTurn[]): GeminiTurn[] {
  if (turns.length <= 1) return turns;

  const lines: string[] = [FLATTEN_HEADER, FLATTEN_IMITATION_WARNING];
  const extraParts: GeminiPart[] = [];

  for (const turn of turns.slice(0, -1)) {
    const label = turn.role === 'model' ? 'Asistan' : 'Kullanıcı';
    for (const part of turn.parts) {
      if ('text' in part && part.text) lines.push(`${label}: ${part.text}`);
      else if ('inlineData' in part) extraParts.push(part);
    }
  }
  lines.push(FLATTEN_FOOTER, '');

  const last = turns[turns.length - 1];
  for (const part of last.parts) {
    if ('text' in part && part.text) lines.push(part.text);
    else if ('inlineData' in part) extraParts.push(part);
  }

  return [{ role: 'user', parts: [{ text: lines.join('\n') }, ...extraParts] }];
}

function isEmptyResponseArtifact(content: string | AnthropicContentBlock[]): boolean {
  const text =
    typeof content === 'string'
      ? content
      : content.length === 1 && content[0].type === 'text'
        ? content[0].text
        : '';
  return text.trim() === 'No response requested.';
}

function truncateTurnText(text: string): string {
  return text.length > TURN_TEXT_MAX_CHARS
    ? text.slice(0, TURN_TEXT_MAX_CHARS) + '\n... (truncated)'
    : text;
}

function contentToParts(
  content: string | AnthropicContentBlock[],
  toolIdToName: Map<string, string>,
): GeminiPart[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ text: truncateTurnText(content) }] : [];
  }

  const parts: GeminiPart[] = [];

  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ text: truncateTurnText(block.text) });
        break;
 
      case 'image':
        parts.push({
          inlineData: { mimeType: block.source.media_type, data: block.source.data },
        });
        break;
 
      // 1007 KANITI (2026-06-11, tests/probe-1007.ts): Live API clientContent.turns
      // içinde functionCall VEYA functionResponse partı kabul ETMİYOR — bağlantıyı
      // "1007 Request contains an invalid argument" ile kapatıyor. Replay'de tool
      // geçmişi SALT-TEXT temsile çevrilir (liveapideneme gemini_proxy.py:1703
      // pattern'i + manifesto §5.2). Canlı tool akışı sendToolResponse ile gider —
      // o kanal functionResponse'un TEK geçerli yeri.
      case 'tool_use': {
        const argsJson = JSON.stringify(block.input ?? {});
        const argsText = argsJson.length > TOOL_ARGS_MAX_CHARS
          ? argsJson.slice(0, TOOL_ARGS_MAX_CHARS) + '... (truncated)'
          : argsJson;
        parts.push({ text: `[tool_use: ${block.name} args=${argsText}]` });
        break;
      }

      case 'tool_result': {
        const rawContent =
          toolResultText(block.content);
 
        // 1007 koruması: tool result üst sınırı (bütçe sabitinden).
        const resultText = rawContent.length > TOOL_RESULT_MAX_CHARS
          ? rawContent.slice(0, TOOL_RESULT_MAX_CHARS) + '\n... (truncated)'
          : rawContent;
 
        const toolName = toolIdToName.get(block.tool_use_id) || 'unknown_tool';
        const label = block.is_error ? 'tool_error' : 'tool_result';
        parts.push({ text: `[${label}: ${toolName}]\n${resultText}` });
        break;
      }
    }
  }
 
  return parts;
}
 