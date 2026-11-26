// ADR-0004: belge araç ortamı (docenv). Modeller betikleri `python3 -I` ile çalıştırır;
// bu mod kullanıcı dizinindeki kütüphaneleri gizler ve sistemde openpyxl 3.1.2 (Excel'in
// "onarım" sorduğu tarih hatası) ya da hiç python-docx/pypdf olmayabilir. Köprü sabit
// sürümlü bir venv yönetir; `office` MCP ve belge betikleri onu kullanır.
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { DOCENV_DIR, docenvPython } from './paths.js';
export const DOCENV_REQUIREMENTS = [
    'openpyxl==3.1.5',
    'python-docx==1.2.0',
    'python-pptx==1.0.2',
    'pypdf==7.1.1',
    'pymupdf==2.2',
    'pillow==13.0.0',
];
const IMPORT_CHECK = 'import openpyxl, docx, pptx, pypdf, pymupdf, PIL';
function markerPath(dir) {
    return join(dir, '.bridge-docenv');
}
/** Kurulu ve sürümleri güncel mi (işaret dosyası gereksinim listesiyle birebir). */
export function docenvReady(dir = DOCENV_DIR) {
    const marker = markerPath(dir);
    return existsSync(docenvPython(dir)) && existsSync(marker)
        && readFileSync(marker, 'utf8').trim() === DOCENV_REQUIREMENTS.join(' ');
}
/**
 * venv'i kuracak gerçek Python. Windows'ta `python` çoğu zaman Microsoft Store yönlendiricisi
 * ya da npm `.cmd` sarmalayıcısıdır (2026-11-26: `python` → system32, npm, WindowsApps);
 * `py -3` ise kurulu EN YENİ sürümü seçer ve sabit paketlerin tekerleği olmayan bir sürüme
 * düşebilir (CI Windows: "No matching distribution found for onnxruntime"). Bu yüzden önce
 * desteklenen sürümler adıyla (`py -3.13` …), sonra kurulu Python3xx (en yeni), sonra genel adlar.
 */
export const SUPPORTED_PYTHON = [[3, 13], [3, 12], [3, 11], [3, 14]];
export function systemPythonCandidates(platform = process.platform, home = homedir()) {
    if (platform !== 'win32')
        return [...SUPPORTED_PYTHON.map(([a, b]) => [`python${a}.${b}`, []]), ['python3', []]];
    const base = join(home, 'AppData', 'Local', 'Programs', 'Python');
    let installed = [];
    try {
        installed = readdirSync(base).filter((d) => /^Python3\d+$/i.test(d))
            .sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)))
            .map((d) => join(base, d, 'python.exe')).filter((p) => existsSync(p));
    }
    catch { /* kurulu değil */ }
    return [...SUPPORTED_PYTHON.map(([a, b]) => ['py', [`-${a}.${b}`]]),
        ...installed.map((p) => [p, []]), ['py', ['-3']], ['python', []]];
}
/** "3.12" gibi sürüm desteklenen aralıkta mı (sabit paketlerin tekerleği var mı). */
export function pythonSupported(version) {
    const [a, b] = version.trim().split('.').map(Number);
    return SUPPORTED_PYTHON.some(([x, y]) => x === a && y === b);
}
function findSystemPython() {
    for (const [cmd, pre] of systemPythonCandidates()) {
        const r = spawnSync(cmd, [...pre, '-c', 'import sys, venv; print(sys.executable); print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
        const [exe = '', ver = ''] = (r.stdout || '').trim().split(/\r?\n/);
        if (r.status === 0 && exe && !/WindowsApps/i.test(exe) && pythonSupported(ver))
            return [cmd, pre, ver];
    }
    return null;
}
/** venv'i oluşturur/günceller; başarılıysa true. Çıktı kullanıcının terminaline akar. */
export function setupDocenv(log = console.log, dir = DOCENV_DIR) {
    const py = docenvPython(dir);
    mkdirSync(dirname(dir), { recursive: true });
    if (!existsSync(py)) {
        log(`📄 Creating document tools environment: ${dir}`);
        const sys = findSystemPython();
        if (!sys) {
            log('✗ No supported Python found (3.11–3.14 with venv). Windows: install 3.13 from python.org; Ubuntu/Debian: sudo apt install python3-venv.');
            return false;
        }
        log(`📄 Using Python ${sys[2]} (${[sys[0], ...sys[1]].join(' ')})`);
        const r = spawnSync(sys[0], [...sys[1], '-m', 'venv', dir], { stdio: 'inherit' });
        if (r.status !== 0 || !existsSync(py)) {
            log('✗ Could not create the venv (Ubuntu/Debian: sudo apt install python3-venv).');
            return false;
        }
    }
    log(`📄 Installing: ${DOCENV_REQUIREMENTS.join(', ')}`);
    const pip = spawnSync(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', ...DOCENV_REQUIREMENTS], { stdio: 'inherit' });
    if (pip.status !== 0) {
        log('✗ pip install failed (network?). Run claude-gemini --setup-docs again.');
        return false;
    }
    const check = spawnSync(py, ['-I', '-c', IMPORT_CHECK], { encoding: 'utf8' });
    if (check.status !== 0) {
        log(`✗ Import check failed: ${(check.stderr || '').trim().split('\n').pop() ?? ''}`);
        return false;
    }
    writeFileSync(markerPath(dir), DOCENV_REQUIREMENTS.join(' '));
    log(`✓ Document tools ready (${py}).`);
    return true;
}
