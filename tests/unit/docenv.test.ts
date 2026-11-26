// ADR-0004: docenv hazır tespiti (işaret dosyası = gereksinim listesi).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DOCENV_REQUIREMENTS, docenvReady, systemPythonCandidates } from '../../src/docenv.js';
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
  it('Linux/WSL: python3', () => {
    expect(systemPythonCandidates('linux', '/home/x')).toEqual([['python3', []]]);
  });
  it('Windows: önce py -3, sonra kurulu Python3xx (en yeni önce), en son PATH python', () => {
    const home = mkdtempSync(join(tmpdir(), 'winhome-'));
    for (const v of ['Python311', 'Python313']) {
      const d = join(home, 'AppData', 'Local', 'Programs', 'Python', v);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'python.exe'), '');
    }
    const c = systemPythonCandidates('win32', home).map(([cmd]) => cmd);
    expect(c[0]).toBe('py');
    expect(c[1]).toContain('Python313');
    expect(c[2]).toContain('Python311');
    expect(c[c.length - 1]).toBe('python');
  });
});
