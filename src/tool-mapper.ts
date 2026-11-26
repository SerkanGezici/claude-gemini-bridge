import type {
  GeminiSchema,
  AnthropicTool,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicContentBlock,
  AnthropicMessage,
  GeminiFunctionDeclaration,
} from './types.js';
 
// ── Config ──────────────────────────────────────────────────
 
/**
 * TOOLSEL-1: Gemini'ye gönderilen en fazla araç. Eski 25 sınırının gerekçesi
 * ("Live ~30-40 aracın üstünde susuyor") 80 gerçek oturumluk probe'da çürüdü:
 * 3.8-live 25/50/80/118 araçta 40/40, 3.1-flash-live 39/40 doğru araç seçti.
 * Bedeli kurulum yükü (118 araç ≈ 54KB ≈ 15K token) — TPM baskısı gerekirse
 * MAX_TOOLS env'i ile düşürülür. Core tool'lar öncelikli, TAM şema ile gider.
 */
export const MAX_TOOLS = 128;
 
/**
 * Core tool isimleri — Claude Code'un en kritik araçları.
 * Bu tool'lar her zaman öncelikli olarak seçilir.
 * Sıralama = öncelik (ilk sıradaki en yüksek).
 */
export const CORE_TOOLS: readonly string[] = [
  // Dosya işlemleri (en sık kullanılan)
  'Read', 'Write', 'Edit', 'MultiEdit',
  // Arama
  'Glob', 'Grep',
  // Sistem
  'Bash',
  // Web (yalnız WebFetch — WebSearch server-side çalışmıyor, BLOCKED_TOOLS'ta)
  'WebFetch',
  // LIVE-SEARCH-1: köprü-fulfilled sentetik web arama tool'u — CORE'da olmazsa
  // MAX_TOOLS=25 prune'unda düşebilir; gerçek-zamanlı arama için kritik.
  'web_search',
  // Task/Todo yönetimi (Claude Code'un KENDİ görev listesi — subagent/team DEĞİL)
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop',
  // Kullanıcı etkileşimi
  'Skill', 'AskUserQuestion',
  // Ertelenmiş (deferred) araç/MCP şemalarını yükler — yoksa yüklenmemiş MCP
  // aracı hiç çağrılamaz (TOOLSEL-1)
  'ToolSearch',
  // Notebook
  'NotebookEdit',
  // Diğer
  'LSP', 'LS', 'TodoWrite',
];

// ── Tool Deny-List (TOOL-GUARD-1) ───────────────────────────
// Köprü senaryosunda Gemini'ye HİÇ gösterilmeyen tool'lar. Gemini bir tool'un
// VARLIĞINI bilmezse onu çağıramaz — bu, prompt caydırmasından (stokastik) farklı
// olarak YAPISAL bir engeldir. 2026-06-18 canlı kanıt (tmux E2E):
//   • GAP-PLAN-1 (TEST 8): "kodu düzelt+kanıtla" görevinde Gemini `EnterPlanMode`
//     çağırdı → plan mode'a girince Claude Code bypass'ı bırakıp "accept edits"e
//     düştü → plan-exit + edit + bash için arka arkaya 3 onay (kullanıcının
//     "yarıda askıda kalıyor, devam et demek zorundayım" şikayetinin kök sebebi).
//   • GAP-SKILL-1 (TEST 12): "kod/ klasörünü analiz et" → Gemini `Agent` ile 3
//     team agent (architect + code-explorer + code-reviewer) fırlattı; basit
//     2-dosyalık iş için orkestrasyon + onay + token israfı + deadlock riski.
//     (SKILL_GUARD_PROMPT bunu engelleyemedi — istek meşru codebase analizine
//     benzediği için prompt caydırması tutmadı.)
// `Agent`'ı kesmek hem doğrudan hem skill-üzerinden (`/analyze`) team fırlatmayı
// durdurur: skill "team başlat" dese bile çağıracak tool yoktur → Gemini analizi
// Read/Grep/Bash ile KENDİSİ yapar (TEST 2-7 davranışı). `EnterPlanMode`'u kesmek
// bypass'ı korur → onaysız otonom akış. Köprünün amacı (Gemini'yi basit/orta
// görevler için Claude Code arkasında kullanmak) için plan-mode/team gereksizdir.
export const BLOCKED_TOOLS: ReadonlySet<string> = new Set<string>([
  'Agent',          // subagent/team dispatch — deadlock + onay + token israfı
  'Task',           // subagent dispatch'in eski adı (savunma)
  'EnterPlanMode',  // bypass'ı deler, ardışık onay yaratır
  'ExitPlanMode',   // plan mode olmadan anlamsız
  // GAP-WEBSEARCH-1 (2026-06-18 canlı kanıt): WebSearch Anthropic SERVER-SIDE
  // tool'u; bridge istekleri Gemini'ye yönlendirdiği için arama hiç gerçekleşmiyor
  // ("Did 0 searches in 3s") → model 0 sonuç dönünce SESSİZCE kendi (eski) bilgisinden
  // "aradım" havasıyla cevaplıyor = güncel-bilgi görevinde halüsinasyon riski.
  // Çalışmayan + yanıltıcı tool'u modele sunmak zararlı; WebFetch (URL ile) çalışır.
  'WebSearch',
  // TOOLSEL-1: köprüde işe yaramayan / zararlı araçlar. Hesap ve bulut
  // özellikleri (Artifact*, Cron*, RemoteTrigger, ScheduleWakeup,
  // PushNotification, SendUserFile, DesignSync) base-URL override ile çalışmaz;
  // Workflow/ListAgents/SendMessage/Team* alt ajan başlatır ya da onlara
  // konuşur — Agent'la aynı gerekçe. Gerçek oturumda 25 yerin 14'ünü yiyorlardı.
  'Workflow', 'ListAgents', 'SendMessage', 'TeamCreate', 'TeamDelete',
  'Artifact', 'ArtifactComments', 'ArtifactData', 'DesignSync',
  'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'ScheduleWakeup',
  'PushNotification', 'SendUserFile', 'SendToProject', 'SendToProjectContext',
]);

/** Köprüde Gemini'ye gösterilmeyecek tool'ları (BLOCKED_TOOLS) listeden çıkarır. */
export function filterBlockedTools(tools: AnthropicTool[]): AnthropicTool[] {
  return tools.filter((t) => !BLOCKED_TOOLS.has(t.name));
}

// ── Sentetik web_search Tool (LIVE-SEARCH-1) ─────────────────
// Köprü, Claude Code'un tool listesinde OLMAYAN bir `web_search` fonksiyonunu
// Gemini'ye sunar. Gemini çağırınca köprü onu Claude Code'a YÖNLENDİRMEZ; kendi
// içinde Gemini REST generateContent + googleSearch grounding ile karşılar
// (gemini-client.handleWebSearch). Böylece Live session'ın functionDeclarations'ı
// bozulmadan gerçek-zamanlı arama yapılır (Google'ın "aynı session'da googleSearch
// + functionDeclarations olmaz" kısıtı aşılır). `WebSearch` (Anthropic server-side)
// BLOCKED'da kalır — bu farklı isimli, köprü-fulfilled bir tool. Description ≤200 kr
// (toGeminiFunctionDeclarations zaten kırpar) ve pozitif/imperatif tutuldu.
export const WEB_SEARCH_TOOL: AnthropicTool = {
  name: 'web_search',
  description:
    'Search the live web for current or real-time information (news, recent events, latest data). ' +
    'Returns grounded results with sources. Use instead of memory for time-sensitive queries.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
    },
    required: ['query'],
  },
};
 
/** Bugünün tarihi (Europe/Istanbul, YYYY-MM-DD) — model tarihi bilmeyince yanlış
 *  yılla arayıp tekrar tekrar arıyordu (canlı: "Galatasaray fikstür 2024 2025"). */
export function todayIstanbul(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(now);
}

/** SEARCH-LAT-1: açıklamaya tarih + "tek kesin sorgu yeterli" (≤200 kr). */
export function webSearchToolForToday(now = new Date()): AnthropicTool {
  return {
    ...WEB_SEARCH_TOOL,
    description:
      `Search the live web for current info (today is ${todayIstanbul(now)}). Returns a short factual summary ` +
      'with sources; one precise query is usually enough. Include the year when relevant.',
  };
}

// ── Gemini Schema Whitelist ─────────────────────────────────
// Gemini'nin kabul ettiği JSON Schema alanları. Diğerleri silinir.
 
const GEMINI_ALLOWED_KEYS = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'format',
  'nullable', 'minimum', 'maximum', 'minItems', 'maxItems', 'anyOf',
  'pattern', 'minLength', 'maxLength', 'propertyOrdering',
]);
 
// ── Schema Sanitization ─────────────────────────────────────
 
function uppercaseType(type: unknown): string {
  if (typeof type !== 'string') return 'STRING'; // bozuk MCP şeması tüm isteği düşürmesin
  const map: Record<string, string> = {
    object: 'OBJECT', string: 'STRING', number: 'NUMBER',
    integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY',
  };
  return map[type.toLowerCase()] || type.toUpperCase() || 'STRING';
}
 
/**
 * Anthropic JSON Schema → Gemini uyumlu şema.
 * - Whitelist: Sadece Gemini'nin desteklediği alanlar korunur
 * - anyOf + type sibling fix: anyOf varsa type kaldırılır
 * - anyOf [{type:X},{type:null}] → {type:X, nullable:true}
 * - Tek elemanlı anyOf düzleştirilir
 * - Property-level description, default, example, title kaldırılır (payload küçültme)
 * - type UPPERCASE yapılır
 */
/** Anthropic tarafındaki ham JSON Schema — MCP sunucularından her şey gelebilir, alanlar doğrulanarak okunur. */
type JsonSchema = Record<string, unknown>;

const isObj = (v: unknown): v is JsonSchema => !!v && typeof v === 'object' && !Array.isArray(v);
const SCALAR_KEYS = ['enum', 'format', 'nullable', 'minimum', 'maximum',
  'minItems', 'maxItems', 'pattern', 'minLength', 'maxLength', 'propertyOrdering'] as const;

export function sanitizeSchema(schema: unknown, depth = 0): GeminiSchema {
  if (!isObj(schema)) {
    return { type: 'STRING' };
  }
  // Derinlik limiti — aşırı nested şemaları kes
  if (depth > 5) {
    return { type: 'STRING' };
  }

  // anyOf işleme — type sibling kontrolünden ÖNCE
  if (Array.isArray(schema['anyOf'])) {
    const items = (schema['anyOf'] as unknown[]).filter(isObj);

    // anyOf [{type:X}, {type:"null"}] → {type:X, nullable:true}
    if (items.length === 2) {
      const nullIdx = items.findIndex((s) => s['type'] === 'null');
      if (nullIdx !== -1) {
        const sanitized = sanitizeSchema(items[nullIdx === 0 ? 1 : 0], depth + 1);
        sanitized.nullable = true;
        return sanitized;
      }
    }

    // Tek elemanlı anyOf → düzleştir
    if (items.length === 1) {
      return sanitizeSchema(items[0], depth + 1);
    }

    // Çoklu anyOf — anyOf varken type OLMAMALI (Gemini kuralı)
    return { anyOf: items.map((s) => sanitizeSchema(s, depth + 1)) };
  }

  // Dizi tip (JSON Schema: "type": ["string","number"] / ["string","null"]).
  // Eskiden uppercaseType'a dizi gidiyor ve tüm istek 500 ile düşüyordu
  // ("type?.toLowerCase is not a function" — claude-in-chrome form_input).
  if (Array.isArray(schema['type'])) {
    const raw = schema['type'] as unknown[];
    const types = raw.filter((t): t is string => typeof t === 'string' && t !== 'null');
    const one = (t: string): GeminiSchema => sanitizeSchema({ ...schema, type: t }, depth);
    const out: GeminiSchema = types.length === 0 ? { type: 'STRING' } : types.length === 1 ? one(types[0]!) : { anyOf: types.map(one) };
    if (raw.includes('null')) out.nullable = true;
    return out;
  }

  const result: GeminiSchema = { type: schema['type'] ? uppercaseType(schema['type']) : 'STRING' };

  // properties (recursive)
  if (isObj(schema['properties'])) {
    result.properties = {};
    for (const [key, val] of Object.entries(schema['properties'])) {
      result.properties[key] = sanitizeSchema(val, depth + 1);
    }
  }

  // required
  const required = schema['required'];
  if (Array.isArray(required) && required.length > 0) {
    result.required = required.filter((r): r is string => typeof r === 'string');
  }

  // items (array) — Gemini ARRAY tipi MUTLAKA bir items şeması gerektirir
  if (schema['items']) {
    result.items = sanitizeSchema(schema['items'], depth + 1);
  } else if (result.type === 'ARRAY') {
    const prefix = Array.isArray(schema['prefixItems']) ? (schema['prefixItems'] as unknown[]) : [];
    // JSON Schema 2020-12 tuple desteği: prefixItems varsa geçerli elemanları kullan
    const validPrefix = prefix.filter((p): p is JsonSchema => isObj(p) && !!p['type']);
    if (validPrefix.length === 1) {
      result.items = sanitizeSchema(validPrefix[0], depth + 1);
    } else if (validPrefix.length > 1) {
      result.items = { anyOf: validPrefix.map((p) => sanitizeSchema(p, depth + 1)) };
    } else {
      result.items = { type: 'STRING' };
    }
  }

  // Diğer izinli alanlar (scalar) — kaynak şemadan olduğu gibi
  const out = result as Record<string, unknown>;
  for (const key of SCALAR_KEYS) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }

  return result;
}
 
// ── Tool Prioritization ─────────────────────────────────────
 
/**
 * Tool listesini önceliklendirerek MAX_TOOLS'a sığdırır.
 * 1. CORE_TOOLS listesindeki tool'lar öncelikli
 * 2. Kalan slotlar diğer tool'larla doldurulur
 */
export function prioritizeTools(tools: AnthropicTool[], max: number = MAX_TOOLS): AnthropicTool[] {
  if (tools.length <= max) return tools;
 
  const coreSet = new Set(CORE_TOOLS);
  const core: AnthropicTool[] = [];
  const rest: AnthropicTool[] = [];
 
  for (const tool of tools) {
    if (coreSet.has(tool.name)) {
      core.push(tool);
    } else {
      rest.push(tool);
    }
  }
 
  // Core tool'ları CORE_TOOLS sırasına göre sırala
  core.sort((a, b) => {
    const ai = CORE_TOOLS.indexOf(a.name);
    const bi = CORE_TOOLS.indexOf(b.name);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
 
  const remaining = max - core.length;
  return [...core, ...rest.slice(0, Math.max(0, remaining))];
}
 
// ── Anthropic Tool → Gemini FunctionDeclaration ─────────────
 
export function toGeminiFunctionDeclarations(
  tools: AnthropicTool[],
  opts: { includeWebSearch?: boolean; maxTools?: number } = {},
): GeminiFunctionDeclaration[] {
  // LIVE-SEARCH-1: sentetik web_search'i ekle (Claude Code listesinde yok).
  // Zaten varsa (ileride eklenirse) çiftleme. REST şeridi (ROUTE-1b) bunu
  // KAPATIR: web_search intercept'i Live session mekanizmasına bağlı; REST'te
  // sunulursa çağrı Claude Code'a düşer (orada yok) → sessiz kırılma.
  const includeSearch = opts.includeWebSearch !== false;
  const withSearch = !includeSearch || tools.some((t) => t.name === WEB_SEARCH_TOOL.name)
    ? tools
    : [webSearchToolForToday(), ...tools];
  // TOOL-GUARD-1: önce deny-list (Agent/plan-mode), sonra MAX_TOOLS önceliklendirme.
  const selected = prioritizeTools(filterBlockedTools(withSearch), opts.maxTools ?? MAX_TOOLS);
 
  return selected.map((tool) => ({
    name: tool.name,
    description: (tool.description || '').slice(0, 200),
    parameters: sanitizeSchema(tool.input_schema),
  }));
}
 
// ── Helpers ─────────────────────────────────────────────────
 
export function toAnthropicToolUse(fc: any): AnthropicToolUseBlock {
  return { type: 'tool_use', id: `toolu_${fc.id}`, name: fc.name, input: fc.args };
}

/** Anthropic tool_use_id → Gemini functionCall id (toolu_ prefix'ini soy) */
export function toGeminiToolId(anthropicId: string): string {
  return anthropicId.startsWith('toolu_') ? anthropicId.slice(6) : anthropicId;
}
 
export function detectToolResults(
  messages: { role: string; content: string | AnthropicContentBlock[] }[],
): {
  hasToolResults: boolean;
  toolResults: AnthropicToolResultBlock[];
  previousAssistantBlocks: AnthropicContentBlock[];
} {
  const none = { hasToolResults: false, toolResults: [], previousAssistantBlocks: [] };
  if (messages.length < 2) return none;

  // Son assistant mesajını bul — ondan SONRAKİ mesajlardaki tool_result'lar
  // henüz cevaplanmamış demektir. Sadece son mesaja bakmak yetmez: Claude Code
  // 2.1.x tool result'tan sonra ek system mesajları ekleyebiliyor (2026-06-11
  // canlı kanıt: MCP instructions mesajı tool_result'ı gölgeleyip açık
  // persistent session dururken full replay'e düşürüyordu → empty turn).
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return none;

  const toolResults: AnthropicToolResultBlock[] = [];
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const content = messages[i].content;
    if (Array.isArray(content)) {
      toolResults.push(
        ...content.filter((b): b is AnthropicToolResultBlock => b.type === 'tool_result'),
      );
    }
  }
  if (toolResults.length === 0) return none;

  const prevAssistant = messages[lastAssistantIdx];
  const previousAssistantBlocks = Array.isArray(prevAssistant.content)
    ? prevAssistant.content
    : [];
  return { hasToolResults: true, toolResults, previousAssistantBlocks };
}
 
// ── Sahte Tool-Call Metni Çözücü (LIVE-20) ──────────────────
// 2026-06-11 canlı transcript kanıtı: 3.1, replay/flatten notasyonunu taklit
// edip "[tool_use:Read args={...}]" metnini GERÇEK fonksiyon çağrısı yerine
// yazıya döküyor. Bridge bu metni yakalayıp gerçek tool_use'a çevirir —
// kullanıcının "devam et" demesine gerek kalmaz.

export interface ParsedTextToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Marker'dan önceki serbest metin (kullanıcıya text olarak akar). */
  before: string;
}

export function parseTextToolCall(text: string): ParsedTextToolCall | null {
  const m = /\[tool_use:\s*([A-Za-z_][\w-]*)\s+args=/.exec(text);
  if (!m) return null;
  const jsonStart = m.index + m[0].length;
  if (text[jsonStart] !== '{') return null;

  // Dengeli süslü parantez taraması — args JSON'u iç içe obje ve string
  // içindeki {}/" karakterleri içerebilir, regex yetmez.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  if (!text.slice(end + 1).trimStart().startsWith(']')) return null;

  try {
    const input = JSON.parse(text.slice(jsonStart, end + 1)) as Record<string, unknown>;
    return { name: m[1], input, before: text.slice(0, m.index) };
  } catch {
    return null;
  }
}

// ── Tool Name Lookup ────────────────────────────────────────
// Tool result'tan tool_use_id'ye bakarak assistant mesajlarindan tool ismini bulur.
 
export function findToolName(
  messages: AnthropicMessage[],
  toolUseId: string,
): string {
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id === toolUseId) {
          return block.name;
        }
      }
    }
  }
  return 'unknown_tool';
}
 
// ── Tool result metni (TOOLREF-1) ────────────────────────────
// ToolSearch sonucu `tool_reference` bloğudur (metin yok). Yalnız text blokları
// alınınca model sonucu boş görüp aracı tekrar tekrar yüklemeye çalışıyordu
// (canlı: REST şeridinde 6 ardışık ToolSearch). Blok, modele anlamlı metne çevrilir.
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '(empty)';
  const out: string[] = [];
  for (const b of content as Array<{ type?: string; text?: string; tool_name?: string }>) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text);
    else if (b?.type === 'tool_reference' && b.tool_name) {
      out.push(`Tool loaded: ${b.tool_name} — it is now available; call it directly.`);
    }
  }
  return out.join('\n');
}
