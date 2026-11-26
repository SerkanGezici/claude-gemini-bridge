// ADR-0004: docenv hazır tespiti (işaret dosyası = gereksinim listesi).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DOCENV_REQUIREMENTS, docenvReady, pythonSupported, systemPythonCandidates } from '../../src/docenv.js';
import { docenvPython } from '../../src/paths.js';

function fakeEnv(marker?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'docenv-'));
  const py = docenvPython(dir);
  mkdirSync(join(py, '..'), { recursive: true });
  writeFileSync(py, '');
  if (marker !== undefined) writeFileSync(join(dir, '.bridge-docenv'), marker);
  return dir;
}

describe('docenvReady', () => {
  it('hiç kurulmamışsa false', () => {
    expect(docenvReady(mkdtempSync(join(tmpdir(), 'docenv-')))).toBe(false);
  });
  it('python var ama işaret yoksa (yarım kurulum) false', () => {
    expect(docenvReady(fakeEnv())).toBe(false);
  });
  it('işaret güncel gereksinimlerle aynıysa true', () => {
    expect(docenvReady(fakeEnv(DOCENV_REQUIREMENTS.join(' ')))).toBe(true);
  });
  it('sürüm listesi değiştiyse false (yeniden --setup-docs gerekir)', () => {
    expect(docenvReady(fakeEnv('openpyxl==3.1.2'))).toBe(false);
  });
  it('openpyxl 3.1.2 sabitlenmez (Excel onarım hatası)', () => {
    expect(DOCENV_REQUIREMENTS).toContain('openpyxl==3.1.5');
  });
});

describe('systemPythonCandidates', () => {
  it('Linux/macOS: önce desteklenen sürüm adları, en son python3', () => {
    const c = systemPythonCandidates('linux', '/home/x').map(([cmd]) => cmd);
    expect(c[0]).toBe('python3.13');
    expect(c[c.length - 1]).toBe('python3');
  });
  it('Windows: önce py -3.13/-3.12/-3.11, sonra kurulu Python3xx (en yeni önce), py -3, en son PATH python', () => {
    const home = mkdtempSync(join(tmpdir(), 'winhome-'));
    for (const v of ['Python311', 'Python313']) {
      const d = join(home, 'AppData', 'Local', 'Programs', 'Python', v);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'python.exe'), '');
    }
    const c = systemPythonCandidates('win32', home).map(([cmd, pre]) => [cmd, ...pre].join(' '));
    expect(c.slice(0, 3)).toEqual(['py -3.13', 'py -3.12', 'py -3.11']);
    const i313 = c.findIndex((x) => x.includes('Python313'));
    expect(i313).toBeGreaterThan(3);
    expect(c[i313 + 1]).toContain('Python311');
    expect(c.indexOf('py -3')).toBeGreaterThan(i313);
    expect(c[c.length - 1]).toBe('python');
  });
});

describe('pythonSupported', () => {
  it('sabit paketlerin tekerleği olan sürümler kabul, diğerleri ret', () => {
    expect(pythonSupported('3.12')).toBe(true);
    expect(pythonSupported('3.14\r\n')).toBe(true);
    expect(pythonSupported('3.10')).toBe(false);
    expect(pythonSupported('3.15')).toBe(false);
  });
});
