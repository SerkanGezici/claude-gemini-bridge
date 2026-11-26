// ORCH-0 sınav seti: Serkan'ın gerçek iş tiplerinden türetilmiş görevler.
// Her görev geçici bir sandbox kopyasında (tests/workspace + gen_fixtures.py
// çıktısı) çalışır ve otomatik puanlanır. Puan 0..1; "soft" görevlerde doğruluk
// otomatik kanıtlanamaz (canlı veri), yalnız biçim + süre ölçülür.
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type Level = 0 | 1 | 2; // 0 sohbet · 1 hızlı bilgi · 2 iş

export interface RunOutput {
  text: string;
  dir: string;
  numTurns?: number;
}

export interface Grade {
  score: number; // 0..1
  notes: string[];
}

export interface EvalTask {
  id: string;
  level: Level;
  title: string;
  prompt: string;
  soft?: boolean;
  /** EVAL-2: görev için test MCP sunucusu (tests/eval/stok_mcp.py) bağlanır; çağrılar <dir>/.mcp-calls.log */
  mcp?: boolean;
  grade: (o: RunOutput) => Grade;
}

/** Binlik ayraçları/boşlukları atıp yalnız rakam dizisi bırak: "1.018.098,17" → "101809817". */
export function digits(s: string): string {
  return s.replace(/(\d)[.,\s'’](?=\d)/g, '$1');
}

/** Metin bu tam sayıyı (binlik ayraçlı ya da ayraçsız) içeriyor mu? */
export function hasNumber(text: string, n: number): boolean {
  const t = digits(text);
  // Kuruşlu yazımda ayraç silinince kuruş yapışır ("1.018.098,17" → "101809817")
  return new RegExp(`(^|\\D)${Math.trunc(n)}(\\d{1,2})?(\\D|$)`).test(t);
}

function lower(s: string): string {
  return s.toLocaleLowerCase('tr-TR');
}

/** Puan = karşılanan kontrol oranı; karşılanmayanlar not olarak döner. */
function checks(list: Array<[string, boolean]>): Grade {
  const ok = list.filter(([, v]) => v).length;
  return {
    score: list.length ? ok / list.length : 0,
    notes: list.filter(([, v]) => !v).map(([n]) => `✗ ${n}`),
  };
}

function anyOf(text: string, words: string[]): boolean {
  const l = lower(text);
  return words.some((w) => l.includes(lower(w)));
}

function readIf(p: string): string {
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function py(code: string, cwd: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('python3', ['-I', '-c', code], { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message };
  }
}

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

/** OFFICE-1: dosya düzenleme görevlerini yapı + biçim düzeyinde puanlar (grade_office.py). */
function officeGrade(mode: string, dir: string): Grade {
  try {
    // -I yok: python-docx/Pillow kullanıcı dizininde. cwd sabit (tests/eval); sandbox sys.path'e girmez.
    const out = execFileSync('python3', [join(EVAL_DIR, 'grade_office.py'), mode, dir], { cwd: EVAL_DIR, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const r = JSON.parse(out) as { checks: Array<[string, boolean]>; notes?: string[] };
    const g = checks(r.checks);
    g.notes.push(...(r.notes ?? []));
    return g;
  } catch (e) {
    return { score: 0, notes: [`✗ puanlayıcı hatası: ${(e as Error).message.slice(0, 200)}`] };
  }
}

function node(code: string, cwd: string): { ok: boolean; out: string } {
  try {
    const out = execFileSync('node', ['-e', code], { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message };
  }
}

// ERP beklenen cevabı (iptal hariç, iade düşülmüş, Ekim 2026)
const ERP_SQL = `SELECT s.stok_adi, ROUND(SUM(t.miktar*t.birim_fiyat),2) c FROM satis t JOIN stok s USING(stok_kodu)
WHERE t.durum='ONAYLI' AND t.tarih BETWEEN '2026-10-01' AND '2026-10-31'
GROUP BY s.stok_adi ORDER BY c DESC LIMIT 3`;

export const TASKS: EvalTask[] = [
  // ── Seviye 0: sohbet ────────────────────────────────────────
  {
    id: 'S1', level: 0, title: 'Selamlaşma',
    prompt: 'Merhaba, nasılsın?',
    grade: (o) => checks([
      ['boş olmayan cevap', o.text.trim().length > 0],
      ['kısa (≤400 karakter)', o.text.length <= 400],
      ['araç kullanmadı', (o.numTurns ?? 1) <= 1],
    ]),
  },
  {
    id: 'S2', level: 0, title: 'Basit teknik bilgi',
    prompt: 'SSD ile HDD arasındaki temel fark nedir? En fazla iki cümle.',
    grade: (o) => checks([
      ['doğru kavram (flash/mekanik/hareketli parça)', anyOf(o.text, ['flash', 'nand', 'mekanik', 'hareketli', 'plaka', 'disk kafa', 'manyetik'])],
      ['kısa (≤600 karakter)', o.text.length <= 600],
      ['araç kullanmadı', (o.numTurns ?? 1) <= 1],
    ]),
  },
  // ── Seviye 1: hızlı bilgi (canlı veri → soft) ───────────────
  {
    id: 'Q1', level: 1, title: 'Maç sorgusu (web)', soft: true,
    prompt: "Galatasaray'ın bir sonraki resmi maçı kiminle ve hangi tarihte? Kısa cevap ver.",
    grade: (o) => checks([
      ['rakip/tarih içeriyor', /\d/.test(o.text) && anyOf(o.text, ['ocak', 'şubat', 'mart', 'nisan', 'mayıs', 'haziran', 'temmuz', 'ağustos', 'eylül', 'ekim', 'kasım', 'aralık', '.11.', '.12.', '/11', '/12'])],
      ['kısa (≤500 karakter)', o.text.length <= 500],
    ]),
  },
  {
    id: 'Q2', level: 1, title: 'Döviz kuru (web)', soft: true,
    prompt: 'Bugün 1 ABD doları kaç Türk lirası? Kısa cevap ver.',
    grade: (o) => {
      // Ham metinden oku: digits() "50,67"yi binlik sanıp 5067'ye çevirir.
      const nums = [...o.text.matchAll(/(?<![\d.,])(\d{2})(?:[.,](\d{1,4}))?(?![\d.,]*\d)/g)].map((m) => Number(`${m[1]}.${m[2] ?? '0'}`));
      return checks([
        ['makul kur (30-90 TL arası sayı)', nums.some((n) => n >= 30 && n <= 90)],
        ['kısa (≤500 karakter)', o.text.length <= 500],
      ]);
    },
  },
  // ── Seviye 2: iş ────────────────────────────────────────────
  {
    id: 'W1', level: 2, title: 'CSV analizi',
    prompt: 'belgeler/satislar.csv dosyasını incele. En yüksek ciroyu yapan satır hangi ay, bölge ve ürün? Tüm satışların toplam cirosu kaç?',
    grade: (o) => checks([
      ['en yüksek: Mart', anyOf(o.text, ['mart'])],
      ['en yüksek: Ege', anyOf(o.text, ['ege'])],
      ['en yüksek: Telefon', anyOf(o.text, ['telefon'])],
      ['en yüksek ciro 552.000', hasNumber(o.text, 552000)],
      ['toplam 1.687.300', hasNumber(o.text, 1687300)],
    ]),
  },
  {
    id: 'W2', level: 2, title: 'Excel bütçe',
    prompt: 'belgeler/butce_2026.xlsx dosyasındaki bütçenin genel toplamı nedir? En yüksek bütçeli departman hangisi ve tutarı ne? En yüksek maaşlı çalışan kim?',
    grade: (o) => checks([
      ['genel toplam 901.000', hasNumber(o.text, 901000)],
      ['en yüksek departman Yazılım', anyOf(o.text, ['yazılım', 'yazilim'])],
      ['Yazılım 375.000', hasNumber(o.text, 375000)],
      ['en yüksek maaş Can Öztürk', anyOf(o.text, ['can öztürk'])],
    ]),
  },
  {
    id: 'W3', level: 2, title: 'PDF sözleşme + hesap',
    prompt: 'belgeler/sozlesme.pdf dosyasındaki sözleşmenin referans numarası nedir ve sözleşme süresince ödenecek toplam tutar ne kadardır?',
    grade: (o) => checks([
      ['referans SOZ-2026-0042', o.text.toUpperCase().includes('SOZ-2026-0042')],
      ['toplam 180.000 (15.000 × 12)', hasNumber(o.text, 180000)],
    ]),
  },
  {
    id: 'W4', level: 2, title: 'Taranmış PDF (OCR)',
    prompt: 'belgeler/dekont_tarama.pdf taranmış bir banka dekontu. İşlem numarası ve tutar nedir?',
    grade: (o) => checks([
      ['işlem no DKT-9988776655', o.text.toUpperCase().replace(/\s/g, '').includes('DKT-9988776655')],
      ['tutar 45.000', hasNumber(o.text, 45000)],
    ]),
  },
  {
    id: 'W5', level: 2, title: 'JSON yapılandırma düzenleme',
    prompt: 'belgeler/config.json dosyasında sürümü 1.5.0 yap ve betaSearch özelliğini aç. Başka hiçbir şeyi değiştirme.',
    grade: (o) => {
      let cfg: Record<string, unknown> = {};
      let valid = false;
      try { cfg = JSON.parse(readIf(join(o.dir, 'belgeler/config.json'))); valid = true; } catch { /* geçersiz */ }
      const f = (cfg['features'] ?? {}) as Record<string, unknown>;
      const owner = (cfg['owner'] ?? {}) as Record<string, unknown>;
      return checks([
        ['geçerli JSON', valid],
        ['version 1.5.0', cfg['version'] === '1.5.0'],
        ['betaSearch true', f['betaSearch'] === true],
        ['diğer alanlar korunmuş', cfg['appName'] === 'DemoPanel' && cfg['debug'] === false &&
          cfg['maxConnections'] === 100 && f['darkMode'] === true &&
          JSON.stringify(f['export']) === '["pdf","xlsx"]' && owner['name'] === 'Deniz Aksoy'],
      ]);
    },
  },
  {
    id: 'W6', level: 2, title: 'Python hata düzeltme',
    prompt: 'kod/istatistik.py dosyasındaki hataları düzelt. Sıfıra bölmede ValueError fırlatsın. Düzelttikten sonra dosyayı çalıştırıp doğrula.',
    grade: (o) => {
      const r = py(
        'import sys; sys.path.insert(0, "kod"); import istatistik as m\n' +
        'assert m.ortalama([1, 2]) == 1.5, "ortalama"\n' +
        'assert m.ortalama([10, 20, 30, 40]) == 25, "ortalama4"\n' +
        'assert m.en_buyuk([-5, -2, -9]) == -2, "en_buyuk"\n' +
        'assert m.bol(6, 3) == 2, "bol"\n' +
        'try:\n  m.bol(1, 0); print("NORAISE")\nexcept ValueError: print("OK")\n',
        o.dir,
      );
      return checks([
        ['testler geçti (ortalama/en_buyuk/bol)', r.ok],
        ['sıfıra bölme → ValueError', r.out.includes('OK')],
      ]);
    },
  },
  {
    id: 'W7', level: 2, title: 'JS refactor (davranış korunmalı)',
    prompt: 'kod/sepet.js dosyasını modern JavaScript\'e refactor et: var yerine const/let, == yerine ===, toplam hesabında döngü yerine reduce. Davranış aynı kalmalı.',
    grade: (o) => {
      // Yorumlar hariç: orijinal başlık yorumu "var, ==" kelimelerini içeriyor.
      const src = readIf(join(o.dir, 'kod/sepet.js')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // eval BİLİNÇLİ: puanlanan şey modelin yazdığı kodun davranışı; geçici
      // sandbox kopyasında, ayrı bir node sürecinde çalışır.
      const r = node(
        `const fs=require('fs');let out='';const log=console.log;console.log=(...a)=>{out+=a.join(' ')+'\\n'};` +
        `const code=fs.readFileSync('kod/sepet.js','utf8')+';\\n;globalThis.__r=[toplamHesapla([{fiyat:10,adet:2},{fiyat:5,adet:1}]),indirimUygula(100,"INDIRIM10"),indirimUygula(100,"INDIRIM20"),indirimUygula(100,"X")];';` +
        `eval(code);console.log=log;console.log(JSON.stringify({out,r:globalThis.__r}));`,
        o.dir,
      );
      let res: { out?: string; r?: number[] } = {};
      try { res = JSON.parse(r.out.trim().split('\n').pop() ?? '{}'); } catch { /* */ }
      return checks([
        ['çıktı "Toplam: 125"', (res.out ?? '').includes('Toplam: 125')],
        ['fonksiyon davranışı aynı', JSON.stringify(res.r) === '[25,90,80,100]'],
        ['var kalmadı', src.length > 0 && !/\bvar\s/.test(src)],
        ['== kalmadı', src.length > 0 && !/[^=!]==[^=]/.test(src)],
        ['reduce kullanıldı', src.includes('reduce')],
      ]);
    },
  },
  {
    id: 'W8', level: 2, title: 'Yeni özellik + test (KDV)',
    prompt:
      'kod/kdv.py adında yeni bir modül yaz: kdv_ekle(tutar, oran) KDV dahil tutarı, kdv_ayir(brut, oran) KDV hariç tutarı döndürsün. ' +
      'Oran yalnız 1, 10 veya 20 olabilir, başka oranda ValueError fırlatsın. Sonuçlar Decimal ile 2 haneye ROUND_HALF_UP yuvarlansın. ' +
      'Ayrıca kod/test_kdv.py dosyasına pytest testleri yaz ve çalıştırıp geçtiğini doğrula.',
    grade: (o) => {
      const r = py(
        'import sys; sys.path.insert(0, "kod"); from decimal import Decimal; import kdv\n' +
        'eq=lambda a,b: Decimal(str(a))==Decimal(b)\n' +
        'assert eq(kdv.kdv_ekle(100, 20), "120.00"), "ekle"\n' +
        'assert eq(kdv.kdv_ayir(120, 20), "100.00"), "ayir"\n' +
        'assert eq(kdv.kdv_ayir(110, 10), "100.00"), "ayir10"\n' +
        'assert eq(kdv.kdv_ekle(Decimal("0.05"), 10), "0.06"), "half_up"\n' +
        'try:\n  kdv.kdv_ekle(100, 18); print("NORAISE")\nexcept ValueError: print("OK")\n',
        o.dir,
      );
      let testsPass = false;
      if (existsSync(join(o.dir, 'kod/test_kdv.py'))) {
        try {
          execFileSync('python3', ['-m', 'pytest', '-q', 'kod/test_kdv.py'], { cwd: o.dir, encoding: 'utf8', timeout: 120_000 });
          testsPass = true;
        } catch { /* başarısız */ }
      }
      return checks([
        ['gizli testler geçti', r.ok],
        ['geçersiz oran → ValueError', r.out.includes('OK')],
        ['test_kdv.py var ve geçiyor', testsPass],
      ]);
    },
  },
  {
    id: 'W9', level: 2, title: 'ERP SQL raporu',
    prompt:
      'erp/erp.db bir SQLite ERP veritabanı (stok ve satis tabloları). Ekim 2026 ayında ciroya göre en çok satan 3 ürünü ' +
      'stok adı ve cirosuyla listele. İptal edilen satışlar hariç tutulmalı, iadeler cirodan düşülmeli. ' +
      'Kullandığın SQL sorgusunu erp/sorgu.sql dosyasına kaydet.',
    grade: (o) => {
      const exp = py(
        `import sqlite3,json; db=sqlite3.connect("erp/erp.db"); print(json.dumps(db.execute(${JSON.stringify(ERP_SQL)}).fetchall()))`,
        o.dir,
      );
      const rows: Array<[string, number]> = exp.ok ? JSON.parse(exp.out) : [];
      const sqlFile = join(o.dir, 'erp/sorgu.sql');
      let sqlMatches = false;
      if (existsSync(sqlFile)) {
        const got = py(
          'import sqlite3,json; db=sqlite3.connect("erp/erp.db"); q=open("erp/sorgu.sql",encoding="utf-8").read()\n' +
          'rows=db.execute(q).fetchall(); print(json.dumps(rows[:3]))',
          o.dir,
        );
        if (got.ok) {
          const g = JSON.parse(got.out) as unknown[][];
          sqlMatches = g.length >= 3 && rows.every((r, i) =>
            g[i]!.some((v) => v === r[0]) && g[i]!.some((v) => typeof v === 'number' && Math.abs(v - r[1]) < 1));
        }
      }
      const t = o.text;
      const order = rows.map((r) => lower(t).indexOf(lower(r[0])));
      return checks([
        ['1. ürün doğru', rows[0] ? anyOf(t, [rows[0][0]]) : false],
        ['2. ürün doğru (iptal tuzağı)', rows[1] ? anyOf(t, [rows[1][0]]) : false],
        ['3. ürün doğru (iade tuzağı)', rows[2] ? anyOf(t, [rows[2][0]]) : false],
        ['sıralama doğru', order.every((v) => v >= 0) && order[0]! < order[1]! && order[1]! < order[2]!],
        ['cirolar doğru', rows.length === 3 && rows.every((r) => hasNumber(t, r[1]))],
        ['sorgu.sql çalışıyor ve aynı sonucu veriyor', sqlMatches],
      ]);
    },
  },
  {
    id: 'W10', level: 2, title: 'İhale şartnamesi risk analizi',
    prompt:
      'ihale/sartname.txt bir kamu ihalesi şartnamesi. Bilgisayar donanımı satan ve servis veren bir firma olarak bizim için ' +
      'ticari ve operasyonel riskleri çıkar, en kritik maddeleri madde numarasıyla belirt ve sonunda Gir / Şartlı Gir / Pas kararı ver.',
    grade: (o) => checks([
      ['42 noktaya teslim/kurulum riski', hasNumber(o.text, 42)],
      ['4 saat müdahale', anyOf(o.text, ['4 saat'])],
      ['gecikme cezası binde 3', anyOf(o.text, ['binde 3', 'binde üç', '‰3', '%0,3', '%0.3', 'binde 3\''])],
      ['fiyat farkı verilmemesi (kur riski)', anyOf(o.text, ['fiyat farkı', 'kur riski', 'kur farkı', 'döviz riski'])],
      ['kesin teminat %6', anyOf(o.text, ['%6', '% 6', 'yüzde 6', 'yüzde altı'])],
      ['3 yıl yerinde garanti', anyOf(o.text, ['3 yıl', '36 ay', 'üç yıl'])],
      ['karar verildi', /(^|[^a-zçğıöşü])(pas|gir)([^a-zçğıöşü]|$)/.test(lower(o.text))],
    ]),
  },
  {
    id: 'W11', level: 2, title: 'Çok dosyalı zincir + yazma',
    prompt:
      'belgeler/notlar.txt içindeki gizli kodu ve belgeler/sozlesme.pdf içindeki sözleşme referans numarasını bul. ' +
      'İkisini ozet.md dosyasına, her biri ayrı satırda "Gizli kod: ..." ve "Sözleşme ref: ..." biçiminde yaz.',
    grade: (o) => {
      const md = readIf(join(o.dir, 'ozet.md'));
      return checks([
        ['ozet.md oluşturuldu', md.length > 0],
        ['gizli kod PELIKAN-77', md.toUpperCase().includes('PELIKAN-77')],
        ['ref SOZ-2026-0042', md.toUpperCase().includes('SOZ-2026-0042')],
        ['istenen biçim', /gizli kod:/i.test(md) && /sözleşme ref:/i.test(md)],
      ]);
    },
  },
  {
    id: 'W12', level: 2, title: 'Büyük CSV (1500 satır, 32K ötesi)',
    prompt: 'depo/depo_stok.csv dosyasını oku. Şu ürün kodlarının adet ve raf bilgisini listele: ' +
      'TSL-4417, TSL-5082, TSL-6630, TSL-7194, TSL-8851, TSL-9963.',
    grade: (o) => {
      const want: Array<[string, number, string]> = [
        ['TSL-4417', 233, 'C-12'], ['TSL-5082', 71, 'H-3'], ['TSL-6630', 418, 'K-27'],
        ['TSL-7194', 902, 'B-36'], ['TSL-8851', 15, 'E-8'], ['TSL-9963', 644, 'A-40'],
      ];
      const flat = o.text.replace(/\s+/g, ' ');
      return checks(want.map(([kod, adet, raf]) => {
        const i = flat.indexOf(kod);
        const seg = i >= 0 ? flat.slice(i, i + 90) : '';
        return [`${kod} ${adet} ${raf}`, i >= 0 && hasNumber(seg, adet) && new RegExp(raf.replace('-', '-?'), 'i').test(seg)] as [string, boolean];
      }));
    },
  },
  {
    id: 'M1', level: 2, title: 'MCP aracı (ToolSearch + çağrı)', mcp: true,
    prompt: 'Depodaki TSL-8842 ürün kodunun stok adedi ve rafı ne? stok MCP aracını kullan.',
    grade: (o) => {
      const calls = readIf(join(o.dir, '.mcp-calls.log'));
      return checks([
        ['MCP aracı gerçekten çağrıldı', calls.includes('TSL-8842')],
        ['stok adedi 4173', hasNumber(o.text, 4173)],
        ['raf K-19', /K-?19/i.test(o.text)],
      ]);
    },
  },
  // ── EVAL-2: Serkan'ın gerçek iş TÜRLERİ (sentetik veri, gen_fixtures2.py) ──
  {
    id: 'R1', level: 2, title: 'Plan durumu (dokunma, sadece söyle)',
    prompt: 'plan/ACTIVE_PLAN.md dosyasına göre nerede kaldık? Açık işler hangileri, en öncelikli olan hangisi, ' +
      'benden beklenen bir karar var mı? Hiçbir dosyayı değiştirme, sadece durumu söyle.',
    grade: (o) => {
      const plan = readIf(join(o.dir, 'plan', 'ACTIVE_PLAN.md'));
      return checks([
        // Madde kimliği YA DA başlığı kabul (3.8-live içerik doğru, ID'siz yazdı — 2026-11-26).
        ['B-7 (P1, e-arşiv) en öncelikli', /B-7/.test(o.text) || anyOf(o.text, ['e-arşiv', 'e-arsiv'])],
        ['C-3 ve C-9 açık', (/C-3/.test(o.text) || anyOf(o.text, ['stok sayım'])) && (/C-9/.test(o.text) || anyOf(o.text, ['kargo etiket']))],
        ['E-1 karar bekliyor (indirim)', (/E-1/.test(o.text) || anyOf(o.text, ['karar'])) && anyOf(o.text, ['indirim'])],
        ['plan dosyası değişmedi', plan.includes('**B-7** 🟠 Fatura') && plan.includes('**E-1** 💬')],
      ]);
    },
  },
  {
    id: 'R2', level: 2, title: 'Ekran görüntüsündeki hata (düzeltme yok)',
    prompt: 'ekran/hata.png ekran görüntüsüne bak: sipariş neden kaydedilmemiş, hangi ürün ve kaç adet eksik? ' +
      'Düzeltme yapma, sadece söyle.',
    grade: (o) => checks([
      ['ürün TSL-3301', /TSL-?3301/i.test(o.text)],
      ['sebep stok yetersiz', anyOf(o.text, ['stok yetersiz', 'yetersiz stok', 'stokta yeterli', 'yeterli stok'])],
      ['eksik 8 adet (12 istenen − 4 depoda)', hasNumber(o.text, 8)],
    ]),
  },
  {
    id: 'R3', level: 2, title: 'Şartname (.docx) ↔ ürünümüz uyumu',
    prompt: 'ihale/aio_sartname.docx bir All-in-One bilgisayar şartnamesi; urun/quadro_aio.txt bizim ürünümüzün özellikleri. ' +
      'Ürünümüz şartnamenin hangi maddelerini KARŞILAMIYOR? Madde numarası, şartnamedeki istek ve bizdeki değerle yaz.',
    grade: (o) => {
      const t = o.text.replace(/\s+/g, ' ');
      const ram = t.search(/RAM|[Bb]ellek/);
      const gar = t.search(/[Gg]aranti/);
      return checks([
        ['RAM eksik: 16 GB istenen, bizde 8 GB', ram >= 0 && hasNumber(t, 16) && hasNumber(t, 8)],
        ['garanti eksik: 3 yıl istenen, bizde 2 yıl', gar >= 0 && /3\s*yıl/i.test(t) && /2\s*yıl/i.test(t)],
        ['madde numaraları 3.3 ve 3.7', /3\.3/.test(t) && /3\.7/.test(t)],
      ]);
    },
  },
  {
    id: 'R4', level: 2, title: 'Excel raporu ↔ stok listesi çapraz kontrol',
    prompt: 'servis/bekleyen.xlsx teknik servisin "tedarikçide bekleyen ürünler" raporu. Bu ürünlerden hangileri aslında ' +
      'depoda stokta var (depo/depo_stok.csv dosyasında)? Kodları ve depodaki adetleri listele.',
    grade: (o) => {
      const want: Array<[string, number]> = [['TSL-5787', 873], ['TSL-6090', 395], ['TSL-6320', 751]];
      const flat = o.text.replace(/\s+/g, ' ');
      const wrong = ['TSL-0103', 'TSL-0207', 'TSL-0311', 'TSL-0419', 'TSL-0523'].filter((k) => {
        const i = flat.indexOf(k);
        return i >= 0 && !/yok|bulunm|değil|degil|stokta olmayan/i.test(flat.slice(Math.max(0, i - 60), i + 80));
      });
      return checks([
        ...want.map(([k, n]) => {
          const i = flat.indexOf(k);
          // Kodun kendi rakamları adete yapışmasın ("TSL-5787 873" → 5787873): koddan SONRA ara.
          return [`${k} stokta (${n})`, i >= 0 && hasNumber(flat.slice(i + k.length, i + k.length + 60), n)] as [string, boolean];
        }),
        ['stokta olmayanları stokta saymadı', wrong.length === 0],
      ]);
    },
  },
  {
    id: 'R5', level: 2, title: 'Fotoğraflar: çekim gününe göre (EXIF)',
    prompt: 'fotograflar klasöründeki fotoğrafları çekim tarihine göre grupla: hangi gün kaç fotoğraf çekilmiş? ' +
      'Dosya adları tarih içermiyor.',
    grade: (o) => {
      const flat = o.text.replace(/\s+/g, ' ');
      const day = (d: number, n: number): boolean => {
        const re = new RegExp(`(14|15|17)[./ -]?(08|0?8|Ağustos|Agustos)`, 'gi');
        let m: RegExpExecArray | null;
        while ((m = re.exec(flat))) {
          if (Number(m[1]) === d && hasNumber(flat.slice(m.index, m.index + 50), n)) return true;
        }
        return new RegExp(`2026[-:.]08[-:.]${d}`).test(flat) && hasNumber(flat.slice(flat.search(new RegExp(`2026[-:.]08[-:.]${d}`)), flat.search(new RegExp(`2026[-:.]08[-:.]${d}`)) + 50), n);
      };
      return checks([
        ['14 Ağustos: 4', day(14, 4)],
        ['15 Ağustos: 3', day(15, 3)],
        ['17 Ağustos: 2', day(17, 2)],
      ]);
    },
  },
  {
    id: 'R6', level: 2, title: 'Hatayı bul, düzeltme (kod)',
    prompt: 'kod/fatura.py dosyasındaki hatayı bul ve açıkla, ama dosyada düzeltme yapma.',
    grade: (o) => {
      const src = readIf(join(o.dir, 'kod', 'fatura.py'));
      return checks([
        ['oran yüzde → 100\'e bölünmeli', /100/.test(o.text) && anyOf(o.text, ['yüzde', '/ 100', '/100', 'bölün', 'oran'])],
        ['kdv_tutari satırı işaret edildi', /kdv_tutari|tutar \* oran|tutar\*oran/.test(o.text)],
        ['dosya değişmedi', src.includes('return tutar * oran')],
      ]);
    },
  },
  {
    id: 'R7', level: 2, title: 'HTML rapor: "Senden beklenenler"',
    prompt: 'rapor/durum.html raporunda "Senden beklenenler" bölümünde kaç madde var ve ilk ikisi ne?',
    grade: (o) => checks([
      ['4 madde', hasNumber(o.text, 4) || /dört/i.test(o.text)],
      ['1. madde GİB e-arşiv bilgileri', anyOf(o.text, ['GİB', 'e-arşiv', 'e-arsiv'])],
      ['2. madde bayi indirim kararı', anyOf(o.text, ['indirim'])],
    ]),
  },
  // ── OFFICE-1: dosya DÜZENLEME (biçim korunmalı) ────────────
  {
    // Serkan'ın 2026-11-26 gerçek isteği (köprü biçimi silip başlık bloklarını atlamıştı).
    id: 'O1', level: 2, title: 'Excel fiyat listesi düzenleme (biçim korunmalı)',
    prompt: 'fiyat/Kasim_2026_Liste.xlsx listesinin bütün sayfalarındaki bütün dağıtıcı sütunlarını kaldır, ' +
      'bayi fiyatının üstüne %39 ilave ederek 3 hanelileri yukarı aşağı son hane 9 olacak şekilde T.E.S.K sütunu ekle. ' +
      'varolan 3 sütunu soldan sağa ara toptan bayi tesk olarak sırala. Bayi fiyat listesi olarak kaydet.',
    grade: (o) => officeGrade('xlsx_fiyat', o.dir),
  },
  {
    id: 'O2', level: 2, title: 'Word teklif düzenleme (stil korunmalı)',
    prompt: 'teklif/teklif.docx teklifinde tarihi 26.11.2026 yap, müşteri adını "ABC Bilişim A.Ş." olarak değiştir, ' +
      'tablodaki birim fiyatlara %10 zam yap, tutarları ve toplamı güncelle. teklif_ABC adıyla kaydet.',
    grade: (o) => officeGrade('docx_teklif', o.dir),
  },
  {
    id: 'O3', level: 2, title: 'PDF sayfa işlemleri + damga',
    prompt: 'belgeler/sartname.pdf dosyasından 3. ve 5. sayfaları çıkar, sonuna belgeler/ek.pdf dosyasının sayfalarını ekle ' +
      've her sayfanın altına "TESLA TEKNOLOJİ - GİZLİ" yazısını ekle. sartname_son.pdf olarak kaydet.',
    grade: (o) => officeGrade('pdf_sartname', o.dir),
  },
  {
    id: 'O4', level: 2, title: 'Fotoğraf küçültme + logo (EXIF korunmalı)',
    prompt: 'urun_foto/urun.jpg fotoğrafını 1200 piksel genişliğe orantılı küçült, sağ alt köşesine urun_foto/logo.png ' +
      'logosunu ekle ve urun_web.jpg olarak kaydet. Çekim tarihi bilgisi (EXIF) kalsın.',
    grade: (o) => officeGrade('img_urun', o.dir),
  },
];
