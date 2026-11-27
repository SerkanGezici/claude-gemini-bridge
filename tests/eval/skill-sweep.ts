// SKILL-SWEEP-1: kullanıcının etkin skill/komutlarını köprü (Gemini) üzerinde tek tek
// gerçek `claude -p` ile koşturur ve her biri için kanıt kaydı üretir. MOCK YOK.
//   npx tsx tests/eval/skill-sweep.ts [--only a,b] [--from name] [--out file.jsonl] [--list]
// Kalemler oturumun init olayından (skills + slash_commands) okunur; sonuç JSONL'e satır
// satır yazılır ve aynı dosyayla yeniden başlatınca bitenler atlanır (gece boyu koşu).
// Güvenlik: her kalem geçici sandbox kopyasında çalışır; dışarı yazan araçlar
// (e-posta gönderme/taslak, push, yayın, kullanıcı ayarları) --disallowedTools ile kapalı.
import { spawn, execFileSync } from 'child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { buildClaudeArgs } from '../../src/claude-args.js';
import { REPO, startBridge, stopBridge, bridgeEnv } from './bridge-harness.js';

const PORT = 8032;
const MODEL = process.env['SWEEP_MODEL'] ?? 'models/gemini-3.1-flash-live-preview';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Kullanıcının kendi komutları (~/.claude/commands) ve modelin çağırmadığı skill'ler: slash ile.
const BUILTIN_NON_SKILL = new Set(['__remote-workflow', 'advisor', 'agents', 'auto-mode-setup', 'autocompact', 'clear', 'color', 'compact',
  'config', 'context', 'design-consent', 'design-revoke', 'effort', 'extra-usage', 'fast', 'focus', 'goal', 'heapdump', 'import', 'init',
  'insights', 'list-agents', 'mcp', 'model', 'output-style', 'recap', 'reload-plugins', 'reload-skills', 'rename', 'skill-doctor',
  'team-onboarding', 'ultrareview', 'usage', 'usage-credits', 'workflow-launch-exec']);
const SLASH_ONLY_SKILLS = new Set(['anthropic-skills:sartname-inceleme']);
/** Uzun/çok ajanlı süreçler: daha uzun süre. */
// SWEEP_TIMEOUT_MIN: yeniden koşuda Gemini Live duraklamalarına pay (varsayılan 9 dk).
const NORMAL_MS = Number(process.env['SWEEP_TIMEOUT_MIN'] ?? 9) * 60_000;
const HEAVY = new Set(['mutabakat', 'warroom', 'team', 'use-all-talents', 'fullscan', 'serkan', 'ideaforge', 'deep-research',
  'anthropic-skills:deep-research', 'sartname-inceleme', 'anthropic-skills:sartname-inceleme', 'qa', 'superpowers:subagent-driven-development',
  'superpowers:dispatching-parallel-agents', 'serkandizayn-variants', 'archscan', 'securityscan', 'security-audit', 'anthropic-skills:security-audit']);
/** Köprüde bilerek olmayan hesap özellikleri (ürün tanımı: "hesap özelliği sağlayıcısı değildir"). */
const ACCOUNT_ONLY = new Set(['schedule']);

const HOME = homedir();
const DISALLOWED = [
  'mcp__plugin_outlook-local_outlook__send_mail', 'mcp__plugin_outlook-local_outlook__create_draft',
  'mcp__plugin_outlook-local_outlook__delete_mail', 'mcp__plugin_outlook-local_outlook__move_mail',
  'mcp__plugin_outlook-local_outlook__create_event', 'mcp__plugin_outlook-local_outlook__send_meeting_invite',
  'CronCreate', 'CronDelete', 'ScheduleWakeup', 'PushNotification', 'RemoteTrigger',
  'Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(gh pr merge:*)', 'Bash(gh release:*)', 'Bash(gh repo:*)', 'Bash(gh api:*)',
  'Bash(npm publish:*)', 'Bash(git -C /mnt/c/Users/serkan/source/repos:*)',
  `Edit(${HOME}/.claude/**)`, `Write(${HOME}/.claude/**)`, `Edit(/mnt/c/Users/serkan/source/repos/**)`, `Write(/mnt/c/Users/serkan/source/repos/**)`,
  'Edit(/mnt/c/Users/serkan/Desktop/**)', 'Write(/mnt/c/Users/serkan/Desktop/**)',
];
/** Gerçek Chrome / masaüstü yalnız bunlara açık (diğerlerinde kullanıcının tarayıcısına dokunulmaz). */
const NEEDS_DESKTOP = new Set(['anthropic-skills:chrome-browser', 'anthropic-skills:computer-use', 'anthropic-skills:built-in-browser']);
const DESKTOP_TOOLS = ['mcp__chrome', 'mcp__computer', 'mcp__windows-mcp', 'mcp__chrome-devtools', 'mcp__plugin_playwright_playwright'];

const SAFETY = 'Kurallar: dış sisteme yazma; e-posta/mesaj gönderme, taslak oluşturma, yayınlama, commit dışında git (push) yok; '
  + "~/.claude altındaki ayarları değiştirme. Bir soru sorman gerekirse makul varsayım yapıp devam et ve varsayımı yaz. "
  + 'Skill alt ajan ya da çok adımlı uzun süreç istiyorsa en az ilk adımını gerçekten çalıştır, sonra yaptığını ve sıradaki adımı en fazla 8 satırda raporla.';

function taskFor(name: string): string {
  const n = name.replace(/^[^:]+:/, '');
  if (name.startsWith('sales:')) return "hayali 'Örnek Yazılım A.Ş.' (Türkiye, kurumsal yazılım, 50 çalışan) hesabı/adayı için. CRM, takvim ya da e-posta bağlı değilse bunu bir cümleyle söyle ve eldeki bilgiyle (gerekirse kısa web aramasıyla) devam et";
  if (name.startsWith('data:') || name === 'dataviz') return 'belgeler/satislar.csv verisiyle (çıktı dosyası gerekiyorsa bu klasöre yaz)';
  if (name.startsWith('design:') || name === 'design' || name === 'serkandizayn-variants' || name === 'serkandizayn') return 'ui/login.html sayfası üzerinden';
  if (name.startsWith('outlook-local:')) return 'yalnız okuma: Gelen kutusundaki son 3 e-postanın konusunu ve göndereni listele (taslak/gönderme yok)';
  const M: Record<string, string> = {
    docx: 'belgeler/notlar.txt içeriğinden kısa bir Word raporu (rapor.docx) oluştur',
    pdf: 'belgeler/sozlesme.pdf metnini çıkar ve 3 maddede özetle',
    xlsx: 'belgeler/butce_2026.xlsx dosyasına toplam satırı ekleyip butce_toplam.xlsx olarak kaydet',
    pptx: 'belgeler/notlar.txt içeriğinden 3 slaytlık sunum.pptx oluştur',
    'canvas-design': 'tek sayfalık küçük bir poster (poster.png) üret',
    'algorithmic-art': 'küçük bir üretken sanat çalışması (art.html) yaz',
    'theme-factory': 'ui/login.html için bir tema seç ve uygula',
    'slack-gif-creator': 'küçük bir animasyonlu emoji GIF (wave.gif) üret',
    'brand-guidelines': 'ui/login.html sayfasına marka yönergelerini uygula',
    'web-artifacts-builder': 'küçük bir sayaç bileşeni (artifact/) oluştur',
    'deep-research': "tek kısa soruyla (maliyet: yalnız 1 görev): '2026'da Türkiye dizüstü bilgisayar pazarında öne çıkan 3 marka hangileri?'",
    'firecrawl-cli': 'https://example.com sayfasını markdown olarak çek',
    typefully: 'yalnız okuma: yapılandırma ve hesap durumunu göster (config:show / social-sets:list); taslak oluşturma ve yayınlama YOK',
    'modern-web-guidance': 'ui/ altına erişilebilir bir modal dialog örneği (ui/modal.html) yaz',
    'claude-api': 'Anthropic Python SDK ile tek mesaj gönderen kısa bir örnek (ornek_api.py) yaz, çalıştırma',
    'security-audit': 'rehber modunda kod/sepet.js dosyasını incele',
    'mcp-builder': 'tek araçlı basit bir MCP sunucu iskeleti (mcp_sunucu/) yaz, çalıştırma',
    'skill-creator': "skills-test/merhaba/SKILL.md olarak küçük bir 'merhaba' skill taslağı oluştur",
    'writing-skills': "skills-test/merhaba/SKILL.md olarak küçük bir 'merhaba' skill taslağı yaz",
    'run-skill-generator': 'bu klasör için çalıştırma skill taslağını skills-test/ altına yaz',
    'update-config': 'yalnız okuma: mevcut ayarları incele ve bu proje için ne önerdiğini söyle; hiçbir ayar dosyasını değiştirme',
    'fewer-permission-prompts': 'yalnız okuma: önerilecek izin listesini çıkar, dosyaya yazma',
    'plugin-authoring': 'küçük bir durum çubuğu mod tasarımını mods-test/ altına yaz, kurma',
    loop: 'zamanlayıcı kurmadan, bu klasörde tek bir durum kontrolü iterasyonu göster',
    'computer-use': 'ekranın görüntüsünü al ve ne gördüğünü bir cümleyle söyle; tıklama/yazma yok',
    'chrome-browser': 'Chrome\'da yeni sekmede https://example.com aç, sayfa başlığını oku, sonra sekmeyi kapat',
    'built-in-browser': 'https://example.com sayfasının başlığını oku',
    'workflow-authoring': 'tek ajanlı küçük bir workflow betiği (wf_test.js) yaz, çalıştırma',
    'import-memory': 'bu projede içe aktarılacak bellek olup olmadığını kontrol et ve durumu raporla',
    morning: 'bugün için sabah özeti hazırla (bağlı kaynak yoksa söyle)',
    'google-workspace': 'Google Drive/Docs bağlı mı kontrol et ve durumu raporla',
    docs: 'notlar.txt içeriğinden kısa bir toplantı notu belgesi taslağı hazırla',
    'doc-coauthoring': 'notlar.txt içeriğinden kısa bir öneri belgesi (oneri.md) taslağını birlikte yazma sürecini başlat',
    'internal-comms': 'notlar.txt içeriğinden ekibe kısa bir durum güncellemesi yaz',
    'sartname-inceleme': 'belgeler/sozlesme.pdf dosyasını şartname gibi ele alarak yalnız M1 modülünü uygula',
    graphify: 'kod/ klasörünün bilgi grafını çıkar',
    'systematic-debugging': 'kod/istatistik.py içindeki olası bir hatayı',
    'test-driven-development': 'kod/sepet.js dosyasına indirim fonksiyonunu TDD ile ekle',
    'writing-plans': 'kod/sepet.js için kupon özelliğinin uygulama planını PLAN.md olarak yaz',
    'executing-plans': 'PLAN.md yoksa kısa bir plan yazıp ilk adımını uygula (kod/sepet.js)',
    brainstorming: 'kod/sepet.js için yeni bir özellik fikri üzerinde',
    'using-git-worktrees': 'bu git deposunda yeni bir worktree aç ve listele',
    'finishing-a-development-branch': 'bu depodaki ozellik dalını bitirme seçeneklerini değerlendir (push yok)',
    'requesting-code-review': 'son commit için',
    'receiving-code-review': "şu inceleme yorumu için: 'sepet.js toplam() negatif adetleri kontrol etmiyor'",
    'verification-before-completion': 'kod/sepet.js değişikliğinin tamamlandığını doğrulayarak',
    'diagnosing-superpowers': 'bu oturum için kısa bir teşhis',
  };
  return M[n] ?? 'bu klasördeki içerikle (kod/, belgeler/, ui/) skill\'in amacına uygun küçük ama gerçek bir iş yap';
}

interface Item { name: string; mode: 'skill' | 'slash' | 'na' }

function inventory(init: { skills: string[]; slash_commands: string[] }): Item[] {
  const skills = new Set(init.skills);
  const items: Item[] = [...skills].sort().map((name) => ({ name, mode: ACCOUNT_ONLY.has(name) ? 'na' : SLASH_ONLY_SKILLS.has(name) ? 'slash' : 'skill' }));
  for (const c of [...new Set(init.slash_commands)].sort()) {
    if (!skills.has(c) && !BUILTIN_NON_SKILL.has(c) && !c.startsWith('mcp__')) items.push({ name: c, mode: 'slash' });
  }
  for (const a of ACCOUNT_ONLY) if (!items.some((i) => i.name === a)) items.push({ name: a, mode: 'na' });
  return items;
}

function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'));
  cpSync(join(REPO, 'tests', 'workspace'), dir, { recursive: true });
  mkdirSync(join(dir, 'ui'), { recursive: true });
  writeFileSync(join(dir, 'ui', 'login.html'), `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Giriş</title>
<style>body{font-family:Arial;background:#fff}form{width:300px;margin:80px auto}input{display:block;width:100%;margin:6px 0}button{background:#999;color:#ccc}</style></head>
<body><form><h3>Giriş yap</h3><input placeholder="E-posta"><input type="password" placeholder="Şifre"><button>Tamam</button><a href="#">şifremi unuttum</a></form></body></html>\n`);
  const git = (...a: string[]): void => { execFileSync('git', a, { cwd: dir, stdio: 'ignore' }); };
  git('init', '-q', '-b', 'main'); git('add', '-A');
  git('-c', 'user.name=Sweep', '-c', 'user.email=sweep@example.com', 'commit', '-q', '-m', 'ilk sürüm');
  git('checkout', '-q', '-b', 'ozellik');
  writeFileSync(join(dir, 'kod', 'sepet.js'), readFileSync(join(dir, 'kod', 'sepet.js'), 'utf8') + '\n// TODO: kupon desteği\nfunction kuponUygula(t, k) { return k === "YUZDE10" ? t * 0.9 : t; }\n');
  git('add', '-A'); git('-c', 'user.name=Sweep', '-c', 'user.email=sweep@example.com', 'commit', '-q', '-m', 'kupon taslağı');
  // /security-review gibi komutlar `origin/HEAD...` ister: yerel çıplak bir origin.
  const origin = `${dir}.origin.git`;
  execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'ignore' });
  git('remote', 'add', 'origin', origin); git('push', '-q', 'origin', 'main');
  git('remote', 'set-head', 'origin', 'main');
  return dir;
}

interface Run { events: Array<Record<string, unknown>>; code: number | null; timedOut: boolean; stderr: string }

function runClaude(prompt: string, cwd: string, timeoutMs: number, desktop: boolean): Promise<Run> {
  const disallow = desktop ? DISALLOWED : [...DISALLOWED, ...DESKTOP_TOOLS];
  const base = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--disallowedTools', ...disallow];
  const args = buildClaudeArgs(base);
  return new Promise((resolve) => {
    const p = spawn('claude', args, { cwd, env: bridgeEnv(PORT), stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; let stderr = ''; let timedOut = false;
    const events: Array<Record<string, unknown>> = [];
    p.stdout.on('data', (d: Buffer) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { events.push(JSON.parse(line) as Record<string, unknown>); } catch { /* yarım satır */ }
      }
    });
    p.stderr.on('data', (d: Buffer) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); resolve({ events, code, timedOut, stderr: stderr.slice(-500) }); });
  });
}

type Block = { type?: string; name?: string; input?: Record<string, unknown>; is_error?: boolean; content?: unknown; text?: string; id?: string; tool_use_id?: string };
function blocks(e: Record<string, unknown>): Block[] {
  const m = e['message'] as { content?: unknown } | undefined;
  return Array.isArray(m?.content) ? (m!.content as Block[]) : [];
}
function text(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'object' && x && 'text' in x ? String((x as { text: unknown }).text) : '')).join(' ');
  return '';
}

const FATAL = /API Error|bridge error|Gemini (?:error|hatası)|quota|RESOURCE_EXHAUSTED|1011|overloaded|Unknown (?:skill|command)|Bilinmeyen komut/i;

/** Bilgi/rehber skill'leri: araç çalıştırmadan doğru cevap verebilir (araçsız cevap normal). */
const KNOWLEDGE = /^(superpowers:(using-superpowers|receiving-code-review|brainstorming)|update-config|fewer-permission-prompts|claude-approvals|modern-web-guidance|security-audit|anthropic-skills:security-audit|workflow-authoring|anthropic-skills:import-memory|anthropic-skills:google-workspace|sales:handle-objection|design:ux-copy)$/;
/** Model-invocation kapalı skill'in Skill aracı reddi (yalnız kullanıcı /ad ile başlatır). */
const USER_ONLY_REFUSAL = /disable-model-invocation|cannot be (?:used|invoked)|only (?:be )?(?:invoked|run) by the user|user-invocable|reserved/i;

function grade(item: Item, r: Run, prompt: string): Record<string, unknown> {
  const tools: string[] = []; const errors: string[] = []; const said: string[] = [];
  let skillOk = false; let skillLoadError = ''; let workAfterSkill = 0; let skillIdx = -1;
  const ids = new Map<string, string>(); const skillIds = new Set<string>();
  const short = item.name.replace(/^[^:]+:/, '');
  for (const e of r.events) {
    for (const b of blocks(e)) {
      if (e['type'] === 'assistant' && b.type === 'text' && b.text?.trim()) said.push(b.text.trim());
      if (e['type'] === 'assistant' && b.type === 'tool_use') {
        tools.push(b.name ?? '?'); if (b.id) ids.set(b.id, b.name ?? '?');
        if (b.name === 'Skill') {
          const s = String(b.input?.['skill'] ?? b.input?.['command'] ?? '').replace(/^\//, '');
          if ((s === item.name || s === short || s.endsWith(`:${short}`)) && b.id) skillIds.add(b.id);
        } else if (skillIdx >= 0 && b.name !== 'ToolSearch') workAfterSkill++;
      }
      if (e['type'] === 'user' && b.type === 'tool_result' && b.tool_use_id && skillIds.has(b.tool_use_id)) {
        if (b.is_error) skillLoadError = text(b.content).slice(0, 200);
        else if (skillIdx < 0) { skillOk = true; skillIdx = tools.length; }
      }
      if (e['type'] === 'user' && b.type === 'tool_result' && b.is_error) {
        errors.push(`${ids.get(b.tool_use_id ?? '') ?? '?'}: ${text(b.content).slice(0, 160)}`);
      }
    }
  }
  const res = r.events.find((e) => e['type'] === 'result') as { result?: string; is_error?: boolean; num_turns?: number; subtype?: string } | undefined;
  const answer = res?.result ?? '';
  const fatal = r.timedOut ? 'zaman aşımı' : !res ? `sonuç yok (exit ${r.code}) ${r.stderr}` : res.is_error ? `is_error ${res.subtype ?? ''}` : FATAL.test(answer) ? 'cevapta hata dizgisi' : '';
  // Slash açılmadı: Claude Code komutu tanımadıysa isteği aynen geri verir, hiç araç yok.
  const slashNotExpanded = item.mode === 'slash' && tools.length === 0 && answer.trim().startsWith(prompt.slice(0, 40));
  const work = item.mode === 'skill' ? workAfterSkill : tools.filter((t) => t !== 'ToolSearch').length;
  let status: string;
  if (item.mode === 'skill' && !skillOk) status = USER_ONLY_REFUSAL.test(skillLoadError) ? 'SLASH-GEREK' : skillLoadError ? 'FAIL-YUKLEME' : 'FAIL-CAGRILMADI';
  else if (slashNotExpanded) status = 'FAIL-SLASH-ACILMADI';
  else if (fatal) status = r.timedOut && work > 3 ? 'KISMI-ZAMAN' : 'FAIL-CALISMA';
  else if (answer.trim().length < 60) status = said.join(' ').length >= 200 ? 'PASS-SONKISA' : 'FAIL-BOS';
  else if (work === 0 && !KNOWLEDGE.test(item.name)) status = 'SUPHE-ARACSIZ';
  else status = 'PASS';
  const attrLeak = /Co-Authored-By:/i.test(answer);
  return { status, skillOk, skillLoadError, fatal, work, attrLeak, turns: res?.num_turns, tools: tools.slice(0, 40), toolErrors: errors.slice(0, 6),
    answer: answer.slice(0, 1500), said: said.map((t) => t.slice(0, 300)).slice(-6) };
}

async function captureInit(): Promise<{ skills: string[]; slash_commands: string[] }> {
  const dir = makeSandbox();
  return new Promise((resolve, reject) => {
    const p = spawn('claude', buildClaudeArgs(['-p', 'merhaba', '--output-format', 'stream-json', '--verbose', '--max-turns', '1']), { cwd: dir, env: bridgeEnv(PORT) });
    let buf = '';
    p.stdout.on('data', (d: Buffer) => {
      buf += d;
      for (const l of buf.split('\n')) {
        try { const j = JSON.parse(l) as { subtype?: string; skills: string[]; slash_commands: string[] }; if (j.subtype === 'init') { p.kill(); rmSync(dir, { recursive: true, force: true }); resolve(j); return; } } catch { /* */ }
      }
    });
    setTimeout(() => { p.kill(); reject(new Error('init alınamadı')); }, 120_000);
  });
}

async function main(): Promise<void> {
  const out = arg('out') ?? join(REPO, 'tests', 'eval', 'results', `skills-${new Date().toISOString().slice(0, 10)}.jsonl`);
  mkdirSync(join(out, '..'), { recursive: true });
  const rawDir = out.replace(/\.jsonl$/, '') + '-raw';
  mkdirSync(rawDir, { recursive: true });
  await startBridge(PORT, MODEL);
  try {
    let items = inventory(await captureInit());
    if (process.argv.includes('--list')) { for (const i of items) console.log(`${i.mode}\t${i.name}`); return; }
    const only = arg('only')?.split(',').map((s) => s.trim());
    if (only) items = items.filter((i) => only.includes(i.name));
    const from = arg('from');
    if (from) items = items.slice(Math.max(0, items.findIndex((i) => i.name === from)));
    const done = new Set(existsSync(out) && !only ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { name: string }).name) : []);
    for (const item of items) {
      if (done.has(item.name)) continue;
      const started = new Date().toISOString();
      if (item.mode === 'na') {
        appendFileSync(out, JSON.stringify({ name: item.name, mode: item.mode, status: 'NA-HESAP', started, note: 'claude.ai hesap özelliği; köprüde (API anahtarı modu) Claude Code yüklemez' }) + '\n');
        continue;
      }
      const dir = makeSandbox();
      const task = taskFor(item.name);
      const prompt = item.mode === 'slash'
        ? `/${item.name} ${task}. ${SAFETY}`
        : `Skill aracıyla \`${item.name}\` skill'ini yükle ve uygula: ${task}. ${SAFETY}`;
      const heavy = HEAVY.has(item.name);
      const t0 = Date.now();
      const r = await runClaude(prompt, dir, heavy ? 25 * 60_000 : NORMAL_MS, NEEDS_DESKTOP.has(item.name));
      let g = grade(item, r, prompt);
      let mode: string = item.mode;
      writeFileSync(join(rawDir, `${item.name.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`), r.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      if (g['status'] === 'SLASH-GEREK') {
        // Yalnız kullanıcının başlatabildiği skill: Serkan'ın gerçek kullanımı gibi /ad ile tekrar.
        const slashPrompt = `/${item.name} ${task}. ${SAFETY}`;
        const r2 = await runClaude(slashPrompt, dir, heavy ? 25 * 60_000 : NORMAL_MS, NEEDS_DESKTOP.has(item.name));
        g = { ...grade({ name: item.name, mode: 'slash' }, r2, slashPrompt), note: 'model çağıramaz (yalnız kullanıcı); /ad ile sınandı' };
        mode = 'slash(oto)';
        writeFileSync(join(rawDir, `${item.name.replace(/[^A-Za-z0-9_-]/g, '_')}.slash.jsonl`), r2.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
      const row = { name: item.name, mode, started, seconds: Math.round((Date.now() - t0) / 1000), prompt, ...g };
      appendFileSync(out, JSON.stringify(row) + '\n');
      console.log(`${String(g['status']).padEnd(16)} ${String(row.seconds).padStart(4)}s  ${item.name}${g['fatal'] ? `  — ${String(g['fatal'])}` : ''}`);
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    stopBridge();
  }
  console.log(`Sonuç: ${out}`);
}

main().catch((e) => { stopBridge(); console.error(e); process.exit(1); });
