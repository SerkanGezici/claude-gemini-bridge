// ADR-0001 Denetçi: araç kullanılmış bir turun son cevabını, kullanıcıya
// akmadan önce ikinci bir Live modeline denetletir. Denetçi her önemli kanıt
// maddesini sayar ve VAR/YOK işaretler; YOK/ÇELİŞKİ satırları düzeltme
// turuna geri bildirim olur. Her hata yolunda fail-open: null döner, taslak
// aynen gider.
import { spawn, type ChildProcess } from 'child_process';
import { tmpdir } from 'os';
import { Modality, ThinkingLevel, type LiveServerMessage, type Session } from '@google/genai';
import { getAI } from './gemini-client.js';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import type { AnthropicContentBlock, AnthropicMessage } from './types.js';

const REVIEW_TIMEOUT_MS = 45_000;
// claude -p: CLI açılışı (~3-5sn) + Sonnet; büyük kanıtta 30sn'yi bulabilir.
const CLAUDE_REVIEW_TIMEOUT_MS = 75_000;
// Tüm model zinciri için toplam bütçe; gemini-client HOLD_TIMEOUT (180sn) bundan uzun.
const REVIEW_BUDGET_MS = 120_000;
const MIN_ATTEMPT_MS = 15_000;
const EVIDENCE_MAX_CHARS = 120_000;
const RESULT_MAX_CHARS = 30_000;
const DRAFT_MIN_CHARS = 1;

export interface ReviewInput {
  request: string;
  evidence: string;
}

function isReminder(text: string): boolean {
  return text.trimStart().startsWith('<system-reminder>');
}

function blockText(content: string | AnthropicContentBlock[] | undefined): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  return content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** Kullanıcının asıl isteği: sondan geriye, system-reminder olmayan metin içeren ilk user mesajı. */
function findRequest(messages: AnthropicMessage[]): { index: number; text: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    // Araç sonucu taşıyan mesajdaki metin bloklarını harness ekler ("Tool
    // loaded.", hatırlatmalar) — kullanıcının isteği değildir.
    if (typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result')) continue;
    const texts = typeof m.content === 'string'
      ? [m.content]
      : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    const real = texts.filter((t) => t.trim() && !isReminder(t));
    if (real.length > 0) return { index: i, text: real.join('\n') };
  }
  return null;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[${text.length - max} karakter kırpıldı]`;
}

/** İstek + bu görevde toplanan kanıt (tool çağrıları ve sonuçları). Kanıt yoksa null. */
export function extractReviewInput(messages: AnthropicMessage[]): ReviewInput | null {
  const req = findRequest(messages);
  if (!req) return null;
  const parts: string[] = [];
  for (const m of messages.slice(req.index + 1)) {
    if (typeof m.content === 'string' || m.role === 'system') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        parts.push(`[TOOL CALL ${b.name}] ${cut(JSON.stringify(b.input), 1_000)}`);
      } else if (b.type === 'tool_result') {
        parts.push(`[TOOL RESULT${b.is_error ? ' (error)' : ''}]\n${cut(blockText(b.content), RESULT_MAX_CHARS)}`);
      }
    }
  }
  if (parts.length === 0) return null;
  if (bridgeSearched(messages)) parts.push('[BRIDGE NOTE] The bridge itself ran web_search in this conversation (results are not listed here); do not flag web-search claims as unsupported.');
  let evidence = parts.join('\n\n');
  // Toplam sınır: en yeni kanıt korunur (son okunan dosyalar genelde cevabın temeli).
  if (evidence.length > EVIDENCE_MAX_CHARS) evidence = `…[eski kanıt kırpıldı]\n${evidence.slice(-EVIDENCE_MAX_CHARS)}`;
  return { request: req.text, evidence };
}

// ACT-CLAIM-1 (2026-11-26 skill taraması): Gemini `deep-research` skill'inde hiç araç
// çağırmadan "web araması gerçekleştirildi, arama sonuçlarına göre …" diye cevap uydurdu;
// talimat tek başına yetmedi. Deterministik kontrol: taslak bir eylemi iddia ediyor ama bu
// görevde o eylemi yapabilecek hiçbir araç çağrılmadıysa sorun üretilir (LLM gerekmez).
const SEARCH_CLAIM = /web\s*aramas[ıi]|internette\s+(?:ara|yapt)|arama\s+sonu[çc]|aramalar[ıi]?nda\b|yapt[ıi]ğ[ıi]m\s+aramada|araştırma(?:sı)?\s+(?:yapıldı|yaptım|gerçekleştir)|searched\s+(?:the\s+web|online)|search\s+results|web\s+search/i;
const FILE_CLAIM = /[\w\-./]+\.(?:md|docx|xlsx|pptx|pdf|png|jpe?g|gif|html?|py|js|ts|json|csv|txt|svg)[`'"]?\s*(?:dosyas[ıi]\s*)?(?:olarak\s*)?(?:oluşturuldu|oluşturdum|kaydedildi|kaydettim|yazıldı|yazdım|üretildi|ürettim|hazırlandı|created|saved|written)/i;
const NEGATED = /yapamad|yapılamad|yapmad|gerekmed|could not|couldn't|did not|didn't|unable/i;
const SEARCH_TOOLS = /^(?:WebSearch|WebFetch|web_search$|Task|Agent|mcp__chrome__|mcp__chrome-devtools__|mcp__plugin_playwright_)/;
const WRITE_TOOLS = /^(?:Write|Edit|MultiEdit|NotebookEdit|Bash|Task|Agent|mcp__office__)/;
const NET_IN_BASH = /\b(?:curl|wget|firecrawl|httpx|requests\.get|research\.py)\b/;

// SEARCH-LEDGER-1 (2026-11-27): köprü solo/karışık web_search'ü kendisi karşılar; o arama Claude
// Code'un mesaj geçmişinde HİÇ görünmez. Deterministik kontrol yalnız geçmişe bakınca gerçek
// aramayı "uydurma" sayıyordu (log: "web_search (live) … → N source(s)"). Bellek içi kayıt:
// konuşmanın ilk kullanıcı mesajı → son arama zamanı (aynı ilk istekli iki konuşma çakışırsa
// kontrol gevşer, sıkılaşmaz).
const SEARCH_LEDGER_TTL_MS = 60 * 60_000;
const searchLedger = new Map<string, number>();

function conversationKey(messages: AnthropicMessage[]): string | null {
  const first = messages.find((m) => m.role === 'user');
  return first ? JSON.stringify(first.content).slice(0, 4_000) : null;
}

export function markSearched(messages: AnthropicMessage[]): void {
  const key = conversationKey(messages);
  if (!key) return;
  const now = Date.now();
  for (const [k, t] of searchLedger) if (now - t > SEARCH_LEDGER_TTL_MS) searchLedger.delete(k);
  searchLedger.set(key, now);
}

function bridgeSearched(messages: AnthropicMessage[]): boolean {
  const key = conversationKey(messages);
  const t = key ? searchLedger.get(key) : undefined;
  return t !== undefined && Date.now() - t <= SEARCH_LEDGER_TTL_MS;
}

function claimed(draft: string, re: RegExp): boolean {
  return draft.split(/(?<=[.!?\n])\s+/).some((sentence) => re.test(sentence) && !NEGATED.test(sentence));
}

/** Taslaktaki, konuşmada hiçbir aracın desteklemediği eylem iddiaları ("EYLEM: …" sorunları). */
export function unbackedActionClaims(messages: AnthropicMessage[], draft: string): string[] {
  // Bütün konuşma: önceki bir turda yapılmış aramanın sonucuna atıf meşrudur (yanlış alarm olmasın).
  const used: Array<{ name: string; input: string }> = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'tool_use') used.push({ name: b.name, input: JSON.stringify(b.input ?? {}) });
  }
  const issues: string[] = [];
  const searched = bridgeSearched(messages) || used.some((u) => SEARCH_TOOLS.test(u.name) || (u.name === 'Bash' && NET_IN_BASH.test(u.input)));
  if (claimed(draft, SEARCH_CLAIM) && !searched) {
    issues.push('EYLEM: Taslak web araması/araştırma yapıldığını ve sonuçlarını söylüyor, ama bu görevde WebSearch, WebFetch ya da tarayıcı aracı hiç çağrılmadı — önce aracı gerçekten çağır, sonucu onun çıktısından yaz');
  }
  if (claimed(draft, FILE_CLAIM) && !used.some((u) => WRITE_TOOLS.test(u.name))) {
    issues.push('EYLEM: Taslak bir dosyanın oluşturulduğunu/kaydedildiğini söylüyor, ama bu görevde dosya yazan hiçbir araç (Write, Edit, Bash) çağrılmadı — dosyayı gerçekten oluştur ya da oluşturmadığını açıkça söyle');
  }
  const skill = unloadedRequestedSkill(messages, used);
  if (skill) {
    issues.push(`EYLEM: Kullanıcı \`${skill}\` skill'ini adıyla istedi ama Skill aracı bu adla hiç çağrılmadı (skill'ler ToolSearch'te görünmez; uydurma alt-ad "Unknown skill" verir) — Skill aracını skill: "${skill}" ile BİREBİR çağır, yüklenen talimata göre işi yap`);
  }
  return issues;
}

// SKILL-NAME-1 (2026-11-27 skill taraması): Gemini istenen skill yerine `firecrawl-cli:scrape`,
// `superpowers:explore` gibi uydurma adlar çağırdı ya da skill'i ToolSearch'te arayıp "skill
// bulunamadı" dedi. İstekte adı geçen skill ile Skill aracı hiç çağrılmadıysa sorun üretilir.
// Aynı adla çağrılıp hata dönmesi (gerçekten yok / yalnız kullanıcı çağırabilir) meşrudur.
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?$/i;

function requestedSkills(request: string): string[] {
  if (!/\bskill/i.test(request)) return [];
  const names = new Set<string>();
  for (const m of request.matchAll(/`([^`\s]+)`\s*(?:skill|adl[ıi]\s+skill)/gi)) names.add(m[1]!);
  for (const m of request.matchAll(/(?:^|[\s(])([a-z0-9][\w-]*:[\w-]+|[a-z0-9][\w-]*-[\w-]+)\s+skill/gi)) names.add(m[1]!);
  return [...names].filter((n) => SKILL_NAME.test(n));
}

function unloadedRequestedSkill(messages: AnthropicMessage[], used: Array<{ name: string; input: string }>): string | null {
  const req = findRequest(messages);
  if (!req) return null;
  const called = used.filter((u) => u.name === 'Skill').map((u) => {
    try { return String((JSON.parse(u.input) as { skill?: unknown }).skill ?? '').replace(/^\//, ''); } catch { return ''; }
  });
  // Ad alanı yalnız bir tarafta yazılmışsa (`deep-research` ↔ `anthropic-skills:deep-research`) kısa ad karşılaştırılır.
  const same = (a: string, b: string): boolean => {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    if (x === y) return true;
    return x.includes(':') !== y.includes(':') && x.split(':').pop() === y.split(':').pop();
  };
  return requestedSkills(req.text).find((n) => !called.some((c) => same(c, n))) ?? null;
}

export const REVIEW_SYSTEM_PROMPT =
  'You are a strict senior reviewer. An AI assistant wrote a DRAFT answer to the user\'s request using the ' +
  'EVIDENCE it gathered with tools. Find substantive gaps before the user sees it.\n' +
  'First, silently decide what the request actually asks. If it asks specific questions, only the facts needed ' +
  'to answer those questions are material. If it asks for a broad review/analysis (e.g. risks of a contract or ' +
  'tender), every item an expert would weigh is material (every deadline, penalty, guarantee/collateral rate, ' +
  'warranty, SLA, payment term, price-adjustment rule, mandatory document, scope constraint). For code/data tasks, ' +
  'every stated requirement and every number asked for is material.\n' +
  'Then silently check each material item against the draft. Report a problem ONLY if a careful expert answering ' +
  'exactly this request would consider the answer wrong or incomplete without the fix. Never report facts the user ' +
  'did not ask about, style, formatting or optional extras, and never ask for work beyond the request.\n' +
  'Output in the user\'s language, plain text, no JSON, no markdown. FIRST, one line per question or ' +
  'requirement the user explicitly asked (at most 8, merge small ones), saying whether the draft answers it with ' +
  'the concrete value from the evidence (repeating an id/code back is not an answer):\n' +
  '"SORU: <asked item> | VAR" or "SORU: <asked item> | YOK"\n' +
  'THEN only problem lines:\n' +
  '"MADDE: <missing or wrong material item with its location> | YOK"\n' +
  '"İSTEK: <unfulfilled part of the request> | YOK"\n' +
  '"ÇELİŞKİ: <statement in the draft that contradicts the evidence>"\n' +
  '"ARAŞTIRMA: <what exactly to check next> | YOK" — when the draft says requested information does not exist, ' +
  'cannot be found or cannot be done, but the evidence does not show an exhaustive check (e.g. only one ' +
  'sheet/page/file/section was read, a command failed and no alternative was tried).\n' +
  'If every SORU is VAR and there is no problem line, end with: TAMAM';

export function buildReviewPrompt(input: ReviewInput, draft: string): string {
  return `# USER REQUEST\n${input.request}\n\n# EVIDENCE\n${input.evidence}\n\n# DRAFT ANSWER\n${draft}`;
}

/** Denetçi çıktısından sorun satırlarını çıkar (YOK ve gerçek ÇELİŞKİ). */
export function parseReview(text: string): string[] {
  const issues: string[] = [];
  // Transkripsiyon satır sonlarını kaybedebilir: etiketlerden önce böl.
  const lines = text.replace(/\s*(SORU:|MADDE:|İSTEK:|ÇELİŞKİ:|ARAŞTIRMA:)/g, '\n$1').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/\|\s*YOK\b/i.test(line)) {
      issues.push(line.replace(/\s*\|\s*YOK\b.*$/i, '').trim());
    } else if (/^ÇELİŞKİ:/i.test(line)) {
      const body = line.replace(/^ÇELİŞKİ:\s*/i, '').trim();
      if (body && !/^(yok|none|hayır)\.?$/i.test(body)) issues.push(line);
    }
  }
  return issues;
}

export function buildFeedback(issues: string[]): string {
  return (
    '[REVIEW NOTE — internal quality check, not written by the user] Your draft answer missed or got wrong ' +
    'these items from the evidence/request:\n' +
    issues.map((i) => `- ${i}`).join('\n') +
    '\nNever say you searched the web, read a page or created a file unless that tool call really happened in this task.' +
    '\nFor ARAŞTIRMA and EYLEM items, make the tool calls needed before answering (EYLEM: the action you described ' +
    'was never performed — actually call the tool now). Then write the COMPLETE final ' +
    'answer for the user again, in the same language: keep everything that was correct and make sure EVERY item ' +
    'listed above appears in it, unless the evidence contradicts that item. Do not mention this review.'
  );
}

export type CriticFn = (model: string, prompt: string) => Promise<string>;

/** Tek-turluk, araçsız Live denetçi oturumu; transkripsiyonu döndürür. */
export const liveCritic: CriticFn = (model, prompt) => {
  const ai = getAI();
  return new Promise((resolve, reject) => {
    let text = '';
    let session: Session | null = null;
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { session?.close(); } catch { /* sessiz */ }
      if (err) reject(err);
      else resolve(text.trim());
    };
    const timer = setTimeout(() => finish(new Error(`review timed out after ${REVIEW_TIMEOUT_MS}ms`)), REVIEW_TIMEOUT_MS);
    const config: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: REVIEW_SYSTEM_PROMPT }] },
    };
    // 3.8-live-extended-thinking thinkingLevel ister (yoksa 1007); 3.8-live
    // thinkingLevel kabul etmez (1007) — yalnız extended modele gönderilir.
    if (model.includes('extended-thinking')) config['thinkingConfig'] = { thinkingLevel: ThinkingLevel.HIGH };
    ai.live.connect({
      model,
      config,
      callbacks: {
        onmessage: (msg: LiveServerMessage) => {
          if (msg.setupComplete) {
            try {
              session!.sendClientContent({ turns: [{ role: 'user', parts: [{ text: prompt }] }], turnComplete: true });
            } catch (e) { finish(e as Error); }
            return;
          }
          const tr = msg.serverContent?.outputTranscription?.text;
          if (tr) text += tr;
          if (msg.serverContent?.turnComplete) finish();
        },
        onerror: (e) => finish(new Error(`review error: ${e.message}`)),
        onclose: (e) => finish(new Error(`review closed: ${e.code} ${e.reason ?? ''}`.trim())),
      },
    }).then((s) => { session = s; }, (e) => finish(e instanceof Error ? e : new Error(String(e))));
  });
};

/**
 * Claude denetçi: kullanıcının kendi Claude Code girişiyle (OAuth abonelik)
 * araçsız, hook/eklenti/MCP'siz, oturum kaydetmeyen `claude -p`. Köprünün
 * ANTHROPIC_* env'i temizlenir, yoksa çağrı köprüye (Gemini'ye) geri döner.
 *
 * REVIEW-LAT-1: süreç stream-json girişiyle ÖNCEDEN açılır ve mesaj bekler
 * (açılış ~2,3sn kazandırır: soğuk 4,5sn → ılık 2,2sn, canlı ölçüm). Her
 * denetim yedek süreci tüketir ve yerine yenisi açılır; mesaj gelene kadar
 * API çağrısı yapılmaz. Yedek en fazla SPARE_MAX_AGE_MS yaşar.
 */
const SPARE_MAX_AGE_MS = 10 * 60_000;

interface Spare { model: string; child: ChildProcess; bornAt: number; dead: boolean }
let _spare: Spare | null = null;

function spawnClaudeCritic(model: string, systemPrompt: string = REVIEW_SYSTEM_PROMPT): Spare {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['ANTHROPIC_BASE_URL'];
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  const args = [
    '-p', '--model', model, '--system-prompt', systemPrompt, '--tools', '',
    '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--setting-sources', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  ];
  const child = spawn('claude', args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
  const spare: Spare = { model, child, bornAt: Date.now(), dead: false };
  child.on('exit', () => { spare.dead = true; });
  child.on('error', () => { spare.dead = true; });
  child.stdin?.on('error', () => { /* süreç erken öldüyse exit/error raporlar */ });
  return spare;
}

function takeSpare(model: string): Spare {
  const s = _spare;
  _spare = null;
  if (s && !s.dead && s.model === model && Date.now() - s.bornAt < SPARE_MAX_AGE_MS) return s;
  if (s && !s.dead) s.child.kill('SIGKILL');
  return spawnClaudeCritic(model);
}

/** Yedek denetçi sürecini hazırla (açılışta ve her denetimden sonra). */
export function prewarmClaudeCritic(model: string): void {
  if (_spare && !_spare.dead && _spare.model === model) return;
  if (_spare && !_spare.dead) _spare.child.kill('SIGKILL');
  try { _spare = spawnClaudeCritic(model); } catch { _spare = null; }
}

/** Kapanışta yedek süreci öldür (test/teardown ve process exit). */
export function disposeClaudeCritic(): void {
  if (_spare && !_spare.dead) _spare.child.kill('SIGKILL');
  _spare = null;
}
process.once('exit', disposeClaudeCritic);

export const claudeCritic: CriticFn = (model, prompt) => runClaude(model, prompt, takeSpare(model), true);

/** Hazır (ya da yeni açılmış) bir claude sürecine tek mesaj gönderip sonucu döndürür. */
function runClaude(model: string, prompt: string, spare: Spare, rewarm: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
  const child = spare.child;
  let buf = '';
  let err = '';
  let done = false;
  const finish = (e: Error | null, text?: string): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (!spare.dead) child.kill('SIGKILL');
    if (rewarm) prewarmClaudeCritic(model); // sıradaki denetim ılık başlasın
    if (e) reject(e);
    else resolve(text!);
  };
  const timer = setTimeout(
    () => finish(new Error(`claude review timed out after ${CLAUDE_REVIEW_TIMEOUT_MS}ms`)),
    CLAUDE_REVIEW_TIMEOUT_MS,
  );
  child.stdout?.on('data', (d: Buffer) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: { type?: string; result?: string; is_error?: boolean };
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'result') {
        const text = String(ev.result ?? '').trim();
        if (ev.is_error || !text) finish(new Error(`claude review error: ${text.slice(0, 200) || 'empty'}`));
        else finish(null, text);
      }
    }
  });
  child.stderr?.on('data', (d: Buffer) => { err += d; });
  child.on('exit', (code) => finish(new Error(`claude review exit=${code} ${err.slice(0, 200)}`)));
  child.on('error', (e) => finish(e));
  if (spare.dead) { finish(new Error(`claude review process died ${err.slice(0, 200)}`)); return; }
  child.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
  child.stdin?.end();
  });
}

// ── AUDIO-NUM-1: kanıttan düzeltme ───────────────────────────
// Live ses modeli bazı turlarda değeri YANLIŞ SÖYLÜYOR (4173 → 4117; aynı ses
// üç farklı yazıya dökme modelinde de 4117). Denetçi çelişkiyi yakalasa da
// Live düzeltme turu yine sesli olduğu için hatayı tekrarlayabiliyor. Taslak
// kanıtla ÇELİŞİYORSA düzeltilmiş cevabı Claude kanıttan yazar (Serkan onayı).

export const REWRITE_SYSTEM_PROMPT =
  'You correct an AI assistant\'s DRAFT answer before the user sees it. Use ONLY the EVIDENCE (tool calls and ' +
  'results) and the user\'s REQUEST. Fix every listed PROBLEM; keep everything in the draft that is correct, its ' +
  'language, tone and structure. Copy values (numbers, codes, names) exactly as they appear in the evidence. ' +
  'Do not add facts that are not in the evidence, do not mention the review or the evidence. ' +
  'Output ONLY the final answer text for the user.';

export type RewriteFn = (model: string, prompt: string) => Promise<string>;

const claudeRewriter: RewriteFn = (model, prompt) =>
  runClaude(model, prompt, spawnClaudeCritic(model, REWRITE_SYSTEM_PROMPT), false);

/** Sorunlardan biri kanıtla çelişki mi (yanlış değer) — eksik maddeden farklı. */
export function hasContradiction(issues: string[]): boolean {
  return issues.some((i) => /^ÇELİŞKİ:/i.test(i.trim()));
}

/**
 * Sorunların HEPSİ kanıtla çelişkiyse düzeltilmiş cevabı Claude yazar. Claude denetçi
 * zincirde yoksa, yapılmamış iş de varsa ya da çağrı başarısızsa null (çağıran Gemini
 * düzeltme turuna döner — o tur araç çağırıp eksik işi yapabilir).
 */
export async function rewriteFromEvidence(
  messages: AnthropicMessage[],
  draft: string,
  issues: string[],
  rewrite: RewriteFn = claudeRewriter,
): Promise<string | null> {
  // EVAL-2 R1/R5 (2026-11-26): çelişkinin yanında YAPILMAMIŞ iş (SORU/İSTEK/
  // ARAŞTIRMA/MADDE YOK) varsa kanıt eksiktir — Claude kanıttan yazınca yine
  // "bilinmiyor" çıkıyordu (dosya hiç okunmamıştı). O durumda araç çağırabilen
  // Gemini düzeltme turu gerekir → null.
  if (!hasContradiction(issues) || !issues.every((i) => /^ÇELİŞKİ:/i.test(i.trim()))) return null;
  const claude = getConfig().reviewModels.find((m) => m.startsWith('claude:'));
  const input = extractReviewInput(messages);
  if (!claude || !input) return null;
  const prompt = `${buildReviewPrompt(input, draft)}\n\n# PROBLEMS\n${issues.map((i) => `- ${i}`).join('\n')}`;
  const t0 = Date.now();
  try {
    const text = (await Promise.race([
      rewrite(claude.slice('claude:'.length), prompt),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), CLAUDE_REVIEW_TIMEOUT_MS)),
    ])).trim();
    if (!text) return null;
    logger.info(`Kanıttan düzeltme (Claude, ${Date.now() - t0}ms): ${issues.length} sorun`);
    return text;
  } catch (err) {
    logger.warn(`Kanıttan düzeltme başarısız — Gemini düzeltme turu: ${(err as Error).message.slice(0, 160)}`);
    return null;
  }
}

/**
 * GUARD-REV-1 (2026-11-27 skill taraması, sales:forecast): denetçinin düzeltme turundan dönen
 * metin yeniden "web araması sonuçlarına göre…" diye arama uydurdu; düzeltme turu tek olduğu için
 * kontrol edilmeden gitti. Son metin deterministik kontrolden geçer: desteksiz iddia varsa Claude
 * kanıttan yeniden yazar; o da yoksa iddia cümleleri metinden çıkarılır.
 */
export async function guardRevision(
  messages: AnthropicMessage[],
  revised: string,
  rewrite: RewriteFn = claudeRewriter,
): Promise<string> {
  const used = messages.filter((m) => m.role === 'assistant' && typeof m.content !== 'string')
    .flatMap((m) => (m.content as AnthropicContentBlock[]).filter((b) => b.type === 'tool_use'));
  const searched = bridgeSearched(messages) || used.some((b) => b.type === 'tool_use' && (SEARCH_TOOLS.test(b.name) || (b.name === 'Bash' && NET_IN_BASH.test(JSON.stringify(b.input ?? {})))));
  const wrote = used.some((b) => b.type === 'tool_use' && WRITE_TOOLS.test(b.name));
  const bad = (sentence: string): boolean => !NEGATED.test(sentence)
    && ((!searched && SEARCH_CLAIM.test(sentence)) || (!wrote && FILE_CLAIM.test(sentence)));
  const sentences = revised.split(/(?<=[.!?\n])\s+/);
  if (!sentences.some(bad)) return revised;
  const issues = ['ÇELİŞKİ: Metin bu görevde hiç yapılmamış bir eylemi (web araması/dosya oluşturma) yapılmış gibi anlatıyor; o iddiayı ve ona dayandırılan bilgileri kaldır, yapılmadığını açıkça söyle'];
  const fixed = await rewriteFromEvidence(messages, revised, issues, rewrite);
  if (fixed && !fixed.split(/(?<=[.!?\n])\s+/).some(bad)) return fixed;
  logger.warn('Düzeltme sonrası desteksiz eylem iddiası — ilgili cümleler çıkarıldı');
  return sentences.filter((x) => !bad(x)).join(' ').trim()
    || `${revised}\n\n(Not: bu görevde web araması ya da dosya işlemi gerçekten yapılmadı; yukarıdaki bilgiler doğrulanmamıştır.)`;
}

/** Model adı "claude:<model>" ise Claude CLI, değilse Gemini Live denetçi. */
export const defaultCritic: CriticFn = (model, prompt) =>
  model.startsWith('claude:') ? claudeCritic(model.slice('claude:'.length), prompt) : liveCritic(model, prompt);

/**
 * Taslağı denetle. Dönüş: sorun listesi ([] = temiz) ya da null (denetim
 * yapılamadı/atlandı → taslak aynen gider).
 */
export async function runReview(
  messages: AnthropicMessage[],
  draft: string,
  critic: CriticFn = defaultCritic,
): Promise<string[] | null> {
  const cfg = getConfig();
  if (!cfg.reviewEnabled || draft.trim().length < DRAFT_MIN_CHARS) return null;
  const unbacked = unbackedActionClaims(messages, draft);
  if (unbacked.length) {
    logger.info(`Denetçi (deterministik): ${unbacked.length} desteksiz eylem iddiası`);
    return unbacked;
  }
  const input = extractReviewInput(messages);
  if (!input) return null;
  const prompt = buildReviewPrompt(input, draft);
  const deadline = Date.now() + REVIEW_BUDGET_MS;
  for (const model of cfg.reviewModels) {
    if (deadline - Date.now() < MIN_ATTEMPT_MS) break;
    const start = Date.now();
    try {
      const out = await critic(model, prompt);
      if (!out) throw new Error('empty review');
      const issues = parseReview(out);
      logger.info(`Denetçi (${model}, ${Date.now() - start}ms): ${issues.length ? `${issues.length} sorun` : 'temiz'}`);
      if (issues.length) logger.debug(`Denetçi sorunları: ${issues.join(' ; ').slice(0, 600)}`);
      return issues;
    } catch (err) {
      logger.warn(`Denetçi ${model} başarısız (${(err as Error).message.slice(0, 120)}) — sonraki deneniyor`);
    }
  }
  logger.warn('Denetçi: hiçbir model cevap vermedi — taslak denetimsiz gidiyor (fail-open)');
  return null;
}

// ── REVIEW-REST-1: durumsuz (REST) şerit için denetim ─────────
// REST'te açık oturum yoktur; düzeltme, taslak + denetim notu geçmişe eklenip
// aynı modelle bir kez daha üretilerek yapılır. Fail-open: her hatada taslak.

const COMPACTION_MARKER = /Respond with TEXT ONLY|create a detailed summary of the conversation/i;

/** Claude Code'un özetleme (compact) isteği mi — onun cevabı kullanıcıya gitmez, denetlenmez. */
export function isCompactionRequest(messages: AnthropicMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return false;
  const texts = typeof last.content === 'string'
    ? [last.content]
    : last.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
  return texts.some((t) => COMPACTION_MARKER.test(t));
}

export interface StatelessResult {
  text: string;
  toolCalls: unknown[];
}

export async function reviewStateless<T extends StatelessResult>(
  messages: AnthropicMessage[],
  result: T,
  regenerate: (extra: AnthropicMessage[]) => Promise<T>,
  critic: CriticFn = defaultCritic,
): Promise<T> {
  if (result.toolCalls.length > 0 || !result.text.trim() || isCompactionRequest(messages)) return result;
  try {
    const issues = await runReview(messages, result.text, critic);
    if (!issues || issues.length === 0) return result;
    const fixed = await rewriteFromEvidence(messages, result.text, issues);
    if (fixed) return { ...result, text: fixed };
    logger.info(`Denetçi düzeltme turu (REST): ${issues.length} sorun`);
    const revised = await regenerate([
      { role: 'assistant', content: result.text },
      { role: 'user', content: buildFeedback(issues) },
    ]);
    if (revised.toolCalls.length > 0) return revised;
    return revised.text.trim() ? { ...revised, text: await guardRevision(messages, revised.text) } : result;
  } catch (err) {
    logger.warn(`REST denetimi atlandı (taslak gönderiliyor): ${(err as Error).message}`);
    return result;
  }
}
