// ADR-0004 review (2a6b6eb) regresyonları: hook ilgisiz turu engellememeli, istenen
// değişiklik (satır/paragraf ekleme, başlık yeniden adlandırma) SORUN sayılmamalı,
// gerçek biçim kaybı ise SORUN kalmalı. Gerçek Python + openpyxl/python-docx ister;
// yoksa (CI) atlanır.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OFFICE_HOOK_PY, OFFICE_TOOLS_PY } from '../../src/paths.js';

const PY = 'python3';
const hasLibs = spawnSync(PY, ['-I', '-c', 'import openpyxl, docx'], { encoding: 'utf8' }).status === 0;
if (!hasLibs) console.warn('ATLANDI — office hook testleri: python3 -I ile openpyxl/python-docx yok');

function py(code: string, cwd: string): void {
  execFileSync(PY, ['-I', '-c', code], { cwd, encoding: 'utf8' });
}
function hook(mode: string, data: Record<string, unknown>): string {
  return execFileSync(PY, ['-I', OFFICE_HOOK_PY, mode], { input: JSON.stringify(data), encoding: 'utf8' }).trim();
}
function compare(a: string, b: string): string {
  return execFileSync(PY, ['-I', OFFICE_TOOLS_PY, 'compare', a, b], { encoding: 'utf8' });
}
const XLSX = `
import openpyxl
from openpyxl.styles import Font
wb = openpyxl.Workbook(); ws = wb.active
for c, v in zip("ABC", ("Ürün", "Tutar", "Adet")): ws[c + "1"] = v; ws[c + "1"].font = Font(bold=True)
ws.append(["Kalem 1", 100, 2]); ws.append(["Kalem 2", 250, 1])
for r in (2, 3): ws[f"B{r}"].number_format = "[$$-409]#,##0"
wb.save("rapor.xlsx")`;

// Her test birkaç Python süreci başlatır (openpyxl yükleme); /mnt/c'de yük altında 5 sn yetmez.
describe.skipIf(!hasLibs)('office_hook / compare — review regresyonları', { timeout: 30_000 }, () => {
  it('P0-1: yolsuz yeni istek önceki durumu siler; ilgisiz yeni Excel turu engellemez', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ohook-'));
    py(XLSX, dir);
    const session = `t-${Date.now()}`;
    expect(hook('prompt', { session_id: session, cwd: dir, prompt: 'rapor.xlsx kaç satır?' })).toContain('additionalContext');
    hook('prompt', { session_id: session, cwd: dir, prompt: 'boş bir fatura dosyası oluştur' });
    py('import openpyxl; wb = openpyxl.Workbook(); wb.active.append(["Kalem", "Fiyat"]); wb.save("fatura.xlsx")', dir);
    expect(hook('stop', { session_id: session, cwd: dir })).toBe('');
  });

  it('P0-2: istenen satır ekleme ve başlık yeniden adlandırma SORUN değil, UYARI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocmp-'));
    py(XLSX, dir);
    py(`import openpyxl; wb = openpyxl.load_workbook("rapor.xlsx"); ws = wb.active
ws["B1"] = "Miktar"; ws.append(["Kalem 3", 300, 4]); ws["B4"].number_format = "[$$-409]#,##0"; wb.save("yeni.xlsx")`, dir);
    const out = compare(join(dir, 'rapor.xlsx'), join(dir, 'yeni.xlsx'));
    expect(out).toMatch(/SONUÇ: 0 sorun, \d+ uyarı/);
    expect(out).toContain('UYARI');
  });

  it('gerçek biçim kaybı hâlâ SORUN (hook turu kapatmaz)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oloss-'));
    py(XLSX, dir);
    const session = `l-${Date.now()}`;
    hook('prompt', { session_id: session, cwd: dir, prompt: 'rapor.xlsx dosyasına toplam satırı ekle, rapor2.xlsx kaydet' });
    py(`import openpyxl; wb = openpyxl.load_workbook("rapor.xlsx"); ws = wb.active
for r in (2, 3): ws[f"B{r}"].number_format = "General"
wb.save("rapor2.xlsx")`, dir);
    const r = hook('stop', { session_id: session, cwd: dir });
    expect(JSON.parse(r)).toMatchObject({ decision: 'block' });
    expect(r).toContain('BİÇİM KAYBI');
  });

  it('Word: paragraf eklemek sahte stil SORUN\'u üretmez', () => {
    const dir = mkdtempSync(join(tmpdir(), 'odocx-'));
    py(`from docx import Document
d = Document(); d.add_heading("Başlık", 1); d.add_paragraph("Bir"); d.add_paragraph("İki"); d.save("a.docx")
d = Document("a.docx"); d.paragraphs[1].insert_paragraph_before("Yeni"); d.save("b.docx")`, dir);
    const out = compare(join(dir, 'a.docx'), join(dir, 'b.docx'));
    expect(out).toMatch(/SONUÇ: 0 sorun/);
  });

  it('kopyalar yalnız kullanıcıya açık dizinde (0700)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'operm-'));
    py(XLSX, dir);
    const session = `p-${Date.now()}`;
    hook('prompt', { session_id: session, cwd: dir, prompt: 'rapor.xlsx incele' });
    const mode = execFileSync(PY, ['-I', '-c', `import os,tempfile;print(oct(os.stat(os.path.join(tempfile.gettempdir(),"claude-gemini-office","${session}")).st_mode & 0o777))`], { encoding: 'utf8' }).trim();
    expect(mode).toBe('0o700');
    writeFileSync(join(dir, '.keep'), '');
  });
});
