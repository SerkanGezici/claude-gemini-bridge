// CU-1 (ADR-0003): Gemini computer use ile Windows masaüstünde görev yürütme.
// Döngü: ekran görüntüsü (pwsh) → COMPUTER_USE_MODEL (computerUse aracı) →
// eylem (pwsh: fare/klavye) → yeni görüntü … model metinle bitirene kadar.
// Claude Code bunu `computer` MCP sunucusunun `computer_task` aracı olarak görür
// (computer-use-mcp.ts) — eylemler köprüde gizli değil, transkriptte ve hook'larda.
import { execFile, spawn } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { getConfig } from './config.js';
import { getAI } from './gemini-client.js';
export const DEFAULT_MAX_STEPS = 12;
export const MAX_STEPS_CAP = 25;
const KEEP_SCREENSHOTS = 3; // eski görüntüler istekten çıkarılır (token)
const PWSH_TIMEOUT_MS = 20_000;
/** Köprünün araç yanıtı zaman aşımı (TOOL_TIMEOUT 180sn) dolmadan kısmi sonuçla dön. */
export const TASK_BUDGET_MS = 150_000;
// ── Saf yardımcılar (test edilir) ─────────────────────────────
/** Model 0-999 ölçeğinde koordinat verir → ekran pikseli. */
export function denormalize(v, size) {
    return Math.max(0, Math.min(size - 1, Math.round((Number(v) / 1000) * size)));
}
/** SendKeys özel karakterlerini kaçırır: + ^ % ~ ( ) { } [ ] */
export function escapeSendKeys(text) {
    return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '{ENTER}');
}
const KEY_NAMES = {
    enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}',
    backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', home: '{HOME}', end: '{END}',
    pageup: '{PGUP}', pagedown: '{PGDN}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    arrowup: '{UP}', arrowdown: '{DOWN}', arrowleft: '{LEFT}', arrowright: '{RIGHT}', space: ' ', insert: '{INSERT}',
};
const MODIFIERS = { control: '^', ctrl: '^', alt: '%', shift: '+' };
/** "Control+S" / ["ctrl","shift","t"] / "Alt+F4" → SendKeys dizgisi ("^s", "%{F4}"). */
export function toSendKeys(keys) {
    const parts = (Array.isArray(keys) ? keys : String(keys).split('+')).map((k) => k.trim().toLowerCase()).filter(Boolean);
    let mods = '';
    let main = '';
    for (const p of parts) {
        if (MODIFIERS[p])
            mods += MODIFIERS[p];
        else if (KEY_NAMES[p])
            main += KEY_NAMES[p];
        else if (/^f([1-9]|1[0-6])$/.test(p))
            main += `{${p.toUpperCase()}}`;
        else if (p === 'meta' || p === 'win' || p === 'command')
            throw new Error('Windows key combinations are not supported');
        else
            main += escapeSendKeys(p);
    }
    return mods + main;
}
/** Model fonksiyon çağrısı → masaüstü eylemi (piksel). Desteklenmeyen → hata metni. */
export function mapCall(name, a, w, h) {
    const X = (k = 'x') => denormalize(Number(a[k]), w);
    const Y = (k = 'y') => denormalize(Number(a[k]), h);
    const has = (k) => typeof a[k] === 'number';
    switch (name) {
        case 'click':
        case 'click_at':
        case 'left_click':
            return { kind: 'click', x: X(), y: Y() };
        case 'double_click':
        case 'double_click_at':
            return { kind: 'click', x: X(), y: Y(), double: true };
        case 'right_click':
        case 'right_click_at':
            return { kind: 'click', x: X(), y: Y(), button: 'right' };
        case 'hover':
        case 'hover_at':
        case 'move':
        case 'mouse_move':
            return { kind: 'move', x: X(), y: Y() };
        case 'type':
        case 'type_text':
        case 'type_text_at':
            return {
                kind: 'type', text: String(a['text'] ?? ''),
                ...(has('x') && has('y') ? { x: X(), y: Y() } : {}),
                enter: a['press_enter'] === true, clear: a['clear_before_typing'] === true,
            };
        case 'key_combination':
        case 'press_key':
        case 'key':
        case 'keypress':
        case 'hotkey':
            try {
                return { kind: 'keys', sendKeys: toSendKeys((a['keys'] ?? a['key'])) };
            }
            catch (e) {
                return { error: e.message };
            }
        case 'scroll':
        case 'scroll_at':
        case 'scroll_document': {
            const dir = String(a['direction'] ?? 'down').toLowerCase();
            const mag = Number(a['magnitude'] ?? 3);
            if (dir === 'left' || dir === 'right')
                return { error: 'horizontal scroll is not supported' };
            const notches = Math.max(1, Math.min(15, Math.round(mag > 50 ? mag / 100 : mag)));
            return { kind: 'scroll', ...(has('x') && has('y') ? { x: X(), y: Y() } : {}), delta: dir === 'up' ? notches : -notches };
        }
        case 'drag_and_drop':
            return { kind: 'drag', x: X(), y: Y(), x2: denormalize(Number(a['destination_x']), w), y2: denormalize(Number(a['destination_y']), h) };
        case 'wait':
        case 'wait_5_seconds':
            return { kind: 'wait', ms: 5000 };
        default:
            return { error: `${name} is not available on a Windows desktop (no browser navigation); use clicks and keys` };
    }
}
// ── pwsh yürütücü ─────────────────────────────────────────────
const WIN32 = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class CU {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
}
"@
[void][CU]::SetProcessDPIAware()
function Clk($x,$y,$b,$n){ [void][CU]::SetCursorPos($x,$y); Start-Sleep -Milliseconds 60
  $d=2;$u=4; if($b -eq 'right'){$d=8;$u=16}
  for($i=0;$i -lt $n;$i++){ [CU]::mouse_event($d,0,0,0,[UIntPtr]::Zero); [CU]::mouse_event($u,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80 } }
`;
function psQuote(s) {
    return `'${s.replace(/'/g, "''")}'`;
}
export function actionScript(a) {
    switch (a.kind) {
        case 'click': return `Clk ${a.x} ${a.y} '${a.button ?? 'left'}' ${a.double ? 2 : 1}`;
        case 'move': return `[void][CU]::SetCursorPos(${a.x},${a.y})`;
        case 'type': {
            const pre = a.x !== undefined && a.y !== undefined ? `Clk ${a.x} ${a.y} 'left' 1; Start-Sleep -Milliseconds 150; ` : '';
            const clear = a.clear ? `[System.Windows.Forms.SendKeys]::SendWait('^a{DELETE}'); ` : '';
            const enter = a.enter ? `; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')` : '';
            return `${pre}${clear}[System.Windows.Forms.SendKeys]::SendWait(${psQuote(escapeSendKeys(a.text))})${enter}`;
        }
        case 'keys': return `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(a.sendKeys)})`;
        case 'scroll': return `${a.x !== undefined ? `[void][CU]::SetCursorPos(${a.x},${a.y}); ` : ''}[CU]::mouse_event(0x800,0,0,${a.delta * 120},[UIntPtr]::Zero)`;
        case 'drag': return `[void][CU]::SetCursorPos(${a.x},${a.y}); [CU]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 150; [void][CU]::SetCursorPos(${a.x2},${a.y2}); Start-Sleep -Milliseconds 150; [CU]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`;
        case 'wait': return `Start-Sleep -Milliseconds ${a.ms}`;
    }
}
/** Tek seferlik pwsh (yedek yol). */
function runPwshOnce(script) {
    return new Promise((resolve, reject) => {
        execFile('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { timeout: PWSH_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message} ${stderr}`.trim())) : resolve(stdout)))
            .stdin?.end(`${WIN32}\n${script}\n`);
    });
}
const DONE = '__CU_DONE__';
/** Komut başına base64 satır okuyup çalıştıran döngü; her komuttan sonra DONE yazar. */
export const PWSH_LOOP = `${WIN32}
while(($l=[Console]::In.ReadLine()) -ne $null){
  try { $c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l)); Invoke-Expression $c | Out-String -Stream | ForEach-Object { [Console]::Out.WriteLine($_) } }
  catch { [Console]::Out.WriteLine("__CU_ERR__ " + $_.Exception.Message) }
  [Console]::Out.WriteLine("${DONE}"); [Console]::Out.Flush()
}`;
/**
 * CU-PERF-1: görev boyunca açık kalan tek pwsh süreci. Her pwsh.exe açılışı ~1,3sn
 * (soğuk başlangıç + Add-Type); kalıcı süreçte eylem ~50-100ms. Hata/zaman aşımında
 * süreç kapatılır, çağıran tek seferlik yola düşer.
 */
export class PwshSession {
    proc = null;
    buf = '';
    queue = Promise.resolve();
    start() {
        const p = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', PWSH_LOOP]);
        p.stdout.setEncoding('utf8');
        p.stdout.on('data', (d) => { this.buf += d; });
        p.on('exit', () => { if (this.proc === p)
            this.proc = null; });
        return p;
    }
    run(script) {
        const job = this.queue.then(() => this.exec(script));
        this.queue = job.catch(() => undefined);
        return job;
    }
    exec(script) {
        this.proc ??= this.start();
        const p = this.proc;
        this.buf = '';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); this.close(); reject(new Error('pwsh oturumu zaman aşımı')); }, PWSH_TIMEOUT_MS);
            const onData = () => {
                const i = this.buf.indexOf(DONE);
                if (i < 0)
                    return;
                const out = this.buf.slice(0, i);
                cleanup();
                const err = out.match(/__CU_ERR__ (.*)/);
                if (err)
                    reject(new Error(err[1].trim()));
                else
                    resolve(out);
            };
            const onExit = () => { cleanup(); reject(new Error('pwsh oturumu kapandı')); };
            const cleanup = () => { clearTimeout(timer); p.stdout.off('data', onData); p.off('exit', onExit); };
            p.stdout.on('data', onData);
            p.once('exit', onExit);
            p.stdin.write(`${Buffer.from(script, 'utf8').toString('base64')}\n`);
        });
    }
    close() {
        const p = this.proc;
        this.proc = null;
        if (p) {
            try {
                p.stdin.end();
                p.kill();
            }
            catch { /* zaten kapalı */ }
        }
    }
}
/** Oturum varsa onu, hata verirse tek seferlik pwsh'i kullanır. */
function runnerFor(session) {
    if (!session)
        return runPwshOnce;
    return async (script) => {
        try {
            return await session.run(script);
        }
        catch (e) {
            session.close();
            if (/zaman aşımı/.test(e.message))
                throw e;
            return runPwshOnce(script);
        }
    };
}
/** Birincil monitörün görüntüsü (JPEG). Windows Temp'e yazılır, WSL'den okunur, silinir. */
export async function captureScreen(session) {
    const out = await runnerFor(session)(`
$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size)
$p=Join-Path $env:TEMP ("cu-"+[guid]::NewGuid().ToString("N")+".jpg")
$bmp.Save($p,[System.Drawing.Imaging.ImageFormat]::Jpeg); $g.Dispose(); $bmp.Dispose()
Write-Output "$($b.Width) $($b.Height) $p"`);
    const [w, h, ...rest] = out.trim().split(/\s+/);
    const winPath = rest.join(' ');
    const wslPath = winPath.replace(/^([A-Za-z]):\\/, (_m, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
    const data = readFileSync(wslPath).toString('base64');
    try {
        unlinkSync(wslPath);
    }
    catch { /* geçici dosya — silinemezse Temp temizler */ }
    return { jpegBase64: data, width: Number(w), height: Number(h) };
}
export async function performAction(a, session) {
    await runnerFor(session)(actionScript(a));
}
// ── Görev döngüsü ─────────────────────────────────────────────
const SYSTEM = 'You control a Windows desktop (not a web browser) through screenshots. Browser navigation ' +
    'functions are unavailable; use clicks, typing and key combinations. Do only what the goal asks; never touch ' +
    'unrelated windows, never close or save other documents, never enter passwords or payment details. When the ' +
    'goal is done (or impossible), stop calling functions and answer with a one-paragraph summary of what happened.';
function defaultDeps() {
    const session = new PwshSession();
    return {
        capture: () => captureScreen(session),
        act: (a) => performAction(a, session),
        close: () => session.close(),
        generate: (req) => getAI().models.generateContent(req),
    };
}
/** Eski ekran görüntülerini istekten çıkarır (yalnız son KEEP_SCREENSHOTS yanıt görüntüsü kalır). */
export function pruneScreens(contents) {
    let seen = 0;
    for (let i = contents.length - 1; i >= 0; i--) {
        for (const p of contents[i].parts) {
            const fr = p['functionResponse'];
            if (fr?.parts?.length && ++seen > KEEP_SCREENSHOTS)
                fr.parts = [];
        }
    }
}
export async function runComputerTask(goal, maxSteps = DEFAULT_MAX_STEPS, deps = defaultDeps(), budgetMs = TASK_BUDGET_MS) {
    try {
        return await runLoop(goal, maxSteps, deps, budgetMs);
    }
    finally {
        deps.close?.();
    }
}
async function runLoop(goal, maxSteps, deps, budgetMs) {
    const deadline = Date.now() + budgetMs;
    const model = getConfig().computerUseModel;
    const steps = [];
    let screen = await deps.capture();
    const contents = [
        { role: 'user', parts: [{ text: goal }, { inlineData: { mimeType: 'image/jpeg', data: screen.jpegBase64 } }] },
    ];
    const limit = Math.max(1, Math.min(MAX_STEPS_CAP, maxSteps));
    for (let step = 0; step < limit; step++) {
        if (Date.now() > deadline) {
            return { ok: false, summary: `Süre bütçesi (${Math.round(budgetMs / 1000)}sn) doldu; görev bitmemiş olabilir — ekran görüntüsünden kontrol et, gerekirse kalan kısmı yeni bir hedefle iste.`, steps, screenshot: screen.jpegBase64 };
        }
        const r = await deps.generate({
            model, contents,
            config: { systemInstruction: SYSTEM, tools: [{ computerUse: { environment: 'ENVIRONMENT_BROWSER' } }] },
        });
        const parts = r.candidates?.[0]?.content?.parts ?? [];
        contents.push({ role: 'model', parts });
        const calls = parts.map((p) => p['functionCall']).filter((c) => !!c?.name);
        const text = parts.map((p) => (typeof p['text'] === 'string' && p['thought'] !== true ? p['text'] : '')).join('').trim();
        if (calls.length === 0)
            return { ok: true, summary: text || '(model bitirdi, özet yok)', steps, screenshot: screen.jpegBase64 };
        const responses = [];
        for (const c of calls) {
            const args = c.args ?? {};
            const safety = args['safety_decision'];
            if (safety?.decision === 'require_confirmation') {
                return { ok: false, summary: `Kullanıcı onayı gerekiyor, durdum: ${safety.explanation ?? c.name}`, steps, screenshot: screen.jpegBase64 };
            }
            const action = mapCall(c.name, args, screen.width, screen.height);
            let result;
            if ('error' in action) {
                result = { error: action.error };
                steps.push(`${c.name}: desteklenmiyor`);
            }
            else {
                try {
                    await deps.act(action);
                    result = { status: 'done' };
                }
                catch (e) {
                    result = { error: e.message.slice(0, 200) };
                }
                steps.push(`${c.name} ${JSON.stringify(action)}${result['error'] ? ` HATA: ${String(result['error'])}` : ''}`);
            }
            responses.push({ functionResponse: { name: c.name, ...(c.id ? { id: c.id } : {}), response: { url: 'desktop', ...result } } });
        }
        await new Promise((res) => setTimeout(res, 400)); // arayüz otursun
        screen = await deps.capture();
        // Görüntü yalnız son yanıta eklenir (her çağrıya değil).
        responses[responses.length - 1]['functionResponse'].parts = [
            { inlineData: { mimeType: 'image/jpeg', data: screen.jpegBase64 } },
        ];
        contents.push({ role: 'user', parts: responses });
        pruneScreens(contents);
    }
    return { ok: false, summary: `Adım sınırına (${limit}) ulaşıldı; görev bitmemiş olabilir.`, steps, screenshot: screen.jpegBase64 };
}
