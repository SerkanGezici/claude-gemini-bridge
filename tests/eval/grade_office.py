#!/usr/bin/env python3
"""OFFICE-1 puanlayıcıları: dosya DÜZENLEME görevlerinin çıktısını yapı + biçim
düzeyinde denetler (yalnız değer değil). Çıktı JSON: {"checks": [[ad, bool]], "notes": [...]}.

Kullanım: python3 grade_office.py <mod> <sandbox_dizini>   (cwd = tests/eval; -I yok:
python-docx/Pillow kullanıcı dizininde. Sandbox yolu sys.path'e girmez.)
  xlsx_fiyat  — fiyat/Kasim_2026_Liste.xlsx → "Bayi fiyat listesi"
  docx_teklif — teklif/teklif.docx → teklif_ABC.docx
  pdf_sartname — belgeler/sartname.pdf + ek.pdf → sartname_son.pdf
  img_urun    — urun_foto/urun.jpg + logo.png → urun_web.jpg
"""
import ast
import json
import math
import operator
import os
import re
import sys
import zipfile
from decimal import ROUND_HALF_UP, Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I betik dizinini eklemez; fixture tanımı buradan okunur


def norm(s) -> str:
    s = str(s or "").replace("İ", "i").replace("I", "ı").lower().replace("ı", "i")
    return re.sub(r"[^0-9a-zçğöşü]", "", s)


def xround(x, n=0):
    return float(Decimal(str(x)).quantize(Decimal(1).scaleb(-int(n)), rounding=ROUND_HALF_UP))


def _away(x, n, up):
    f = 10 ** int(n)
    return (math.ceil(abs(x) * f) if up else math.floor(abs(x) * f)) / f * (1 if x >= 0 else -1)


FUN = {
    "ROUND": xround,
    "ROUNDUP": lambda x, n=0: _away(x, n, True),
    "ROUNDDOWN": lambda x, n=0: _away(x, n, False),
    "TRUNC": lambda x, n=0: _away(x, n, False),
    "MROUND": lambda x, m: xround(x / m) * m,
    "INT": math.floor,
    "FLOOR": lambda x, s=1: math.floor(x / s) * s,
    "CEILING": lambda x, s=1: math.ceil(x / s) * s,
    "ABS": abs, "MAX": max, "MIN": min,
    "IF": lambda c, a, b=0: a if c else b,
}


_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv, ast.Pow: operator.pow}
_CMP = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge}


def _safe(node):
    """Yalnız sayı, dört işlem, karşılaştırma ve FUN'daki Excel fonksiyonları — formül
    metni modelin yazdığı dosyadan gelir, eval() ile çalıştırılmaz."""
    if isinstance(node, ast.Expression):
        return _safe(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
        return _BIN[type(node.op)](_safe(node.left), _safe(node.right))
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        v = _safe(node.operand)
        return -v if isinstance(node.op, ast.USub) else v
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in _CMP:
        return _CMP[type(node.ops[0])](_safe(node.left), _safe(node.comparators[0]))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FUN and not node.keywords:
        return FUN[node.func.id](*[_safe(a) for a in node.args])
    raise ValueError(f"izinsiz ifade: {ast.dump(node)[:60]}")


def value(ws, ref, depth=0):
    v = ws[ref].value
    if isinstance(v, str) and v.startswith("="):
        if depth > 5:
            raise ValueError("derin formül")
        e = v[1:].replace(";", ",").replace("^", "**").replace("<>", "!=")
        e = re.sub(r"\$?([A-Z]{1,3})\$?(\d+)", lambda m: repr(float(value(ws, m.group(1) + m.group(2), depth + 1) or 0)), e)
        e = re.sub(r"(?<![<>=!])=(?!=)", "==", e)
        return _safe(ast.parse(e, mode="eval"))
    return v


def is_money(fmt: str) -> bool:
    return "$" in (fmt or "")


def find_output(d: str, src: str, wanted: str, exts=(".xlsx",)):
    cands = []
    for root, _, files in os.walk(d):
        for f in files:
            p = os.path.join(root, f)
            if f.lower().endswith(exts) and not f.startswith("~$") and os.path.abspath(p) != os.path.abspath(src):
                cands.append(p)
    named = [p for p in cands if wanted in norm(os.path.basename(p))]
    pool = named or cands
    return (max(pool, key=os.path.getmtime) if pool else None), bool(named)


def env_notes(path: str) -> list:
    try:
        core = zipfile.ZipFile(path).read("docProps/core.xml").decode("utf8", "replace")
    except Exception as e:  # noqa: BLE001
        return [f"✗ zip okunamadı: {e}"]
    if "+00:00Z" in core:
        return ["ORTAM: core.xml tarihi '+00:00Z' (openpyxl 3.1.2 hatası) — Excel onarım sorar"]
    return []


def grade_xlsx_fiyat(d: str):
    import openpyxl
    from gen_fixtures2 import FIYAT_RENKLI, FIYAT_SAYFALAR  # pyright: ignore[reportMissingImports]

    src = os.path.join(d, "fiyat", "Kasim_2026_Liste.xlsx")
    out, named = find_output(d, src, "bayifiyatlistesi")
    checks, notes = [], []
    checks.append(['"Bayi fiyat listesi" adıyla kaydedildi', named])
    try:
        checks.append(["orijinal dosya korundu", openpyxl.load_workbook(src)["Masaüstü"]["B1"].value == "Dağıtıcı"])
    except Exception:  # noqa: BLE001
        checks.append(["orijinal dosya korundu", False])
    if not out:
        if os.path.exists(src) and not checks[1][1]:
            out = src  # yerinde değiştirdiyse içeriği yine puanla
        else:
            return checks + [["çıktı dosyası var", False]], notes
    notes += env_notes(out)
    wb = openpyxl.load_workbook(out)

    c = {k: [0, 0] for k in ("dagitici", "baslik", "urunA", "fiyat", "tesk", "para", "kalin", "renk", "genislik")}

    def tick(k, ok, why=None):
        c[k][1] += 1
        c[k][0] += 1 if ok else 0
        if not ok and why and len(notes) < 12:
            notes.append(why)

    for name, _fmt, _ara, _w, rows in FIYAT_SAYFALAR:
        if name not in wb.sheetnames:
            for k in c:
                tick(k, False)
            notes.append(f"sayfa yok: {name}")
            continue
        ws = wb[name]
        flat = [ws.cell(r, cc).value for r in range(1, ws.max_row + 1) for cc in range(1, ws.max_column + 1)]
        dist = {row[1] for row in rows if row[0] not in (None, "#H", "#T") and row[1] is not None}
        tick("dagitici", not any("dagitici" in norm(v) for v in flat if isinstance(v, str))
             and not any(v in dist for v in flat if isinstance(v, (int, float))), f"{name}: dağıtıcı kalıntısı")
        for r, row in enumerate(rows, start=1):
            a, b, cc, dd, e = (ws.cell(r, k).value for k in range(1, 6))
            if row[0] is None:
                tick("urunA", all(v in (None, "") for v in (a, b, cc, dd)), f"{name}!{r}: boş satır dolmuş")
            elif row[0] == "#H":
                ok = norm(a) == norm(row[1]) and "toptan" in norm(b) and "bayi" in norm(cc) and norm(dd) == "tesk" and e in (None, "")
                tick("baslik", ok, f"{name}!{r} başlık: {[a, b, cc, dd, e]}")
                tick("kalin", bool(ws.cell(r, 4).font.b), f"{name}!D{r} TESK başlığı kalın değil")
            elif row[0] == "#T":
                tick("urunA", a == row[1] and all(v in (None, "") for v in (b, cc, dd)), f"{name}!{r} ara başlık bozuldu")
                tick("kalin", bool(ws.cell(r, 1).font.b), f"{name}!A{r} ara başlık kalınlığı gitti")
            else:
                urun, _dist, bayi, ara = row
                tick("urunA", a == urun, f"{name}!A{r}: {a!r}")
                if bayi is None:
                    tick("fiyat", all(v in (None, "") for v in (b, cc, dd, e)), f"{name}!{r}: fiyatsız ürüne değer yazılmış")
                    continue
                tick("fiyat", b == ara and cc == bayi and e in (None, ""), f"{name}!{r}: B/C={b},{cc} (beklenen {ara},{bayi})")
                raw = bayi * 1.39
                exp = xround((raw + 1) / 10) * 10 - 1
                # Serkan kararı (2026-11-26): 4 haneli sonuçta da son hane 9 (1200,96 → 1199)
                alts = [exp]
                try:
                    got = value(ws, f"D{r}")
                except Exception as ex:  # noqa: BLE001
                    got = f"formül değerlendirilemedi: {ex}"
                ok = isinstance(got, (int, float)) and any(abs(got - a) < 0.01 for a in alts)
                tick("tesk", ok, f"{name}!D{r}: {got!r} (beklenen {' / '.join(f'{a:g}' for a in alts)})")
                for col in "BCD":
                    tick("para", is_money(ws[f"{col}{r}"].number_format), f"{name}!{col}{r} para birimi biçimi yok ({ws[f'{col}{r}'].number_format})")
        if name == FIYAT_RENKLI[0]:
            rgb = str(ws.cell(FIYAT_RENKLI[1], 1).fill.fgColor.rgb or "")
            tick("renk", rgb.upper().endswith("FFFF00"), f"{name}!A{FIYAT_RENKLI[1]} sarı dolgu gitti ({rgb})")
        wa = ws.column_dimensions["A"].width or 0
        tick("genislik", wa >= 60 and all((ws.column_dimensions[k].width or 10) <= 25 for k in "BCD"),
             f"{name}: genişlikler A={wa} B..D={[ws.column_dimensions[k].width for k in 'BCD']}")

    names = {
        "dagitici": "dağıtıcı sütunları ve değerleri kalktı",
        "baslik": "her blok başlığı: AraToptan | Tavsiye Bayi | T.E.S.K",
        "urunA": "ürün adları, ara başlıklar ve satır düzeni yerinde",
        "fiyat": "AraToptan/Bayi değerleri doğru sütunda; fiyatsız ürün boş",
        "tesk": "TESK = bayi×1,39 → en yakın …9",
        "para": "fiyat hücrelerinde para birimi biçimi (TESK dahil)",
        "kalin": "başlık/ara başlık kalınlığı korundu (TESK başlığı dahil)",
        "renk": "renkli satırın dolgusu korundu",
        "genislik": "sütun genişlikleri içeriği izliyor (A geniş, fiyatlar dar)",
    }
    for k, (ok, total) in c.items():
        checks.append([f"{names[k]} ({ok}/{total})", total > 0 and ok == total])
    return checks, notes


def parse_tr(s) -> float | None:
    s = re.sub(r"[^\d,.]", "", str(s or ""))
    if not s:
        return None
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+", s):
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def grade_docx_teklif(d: str):
    from docx import Document
    from gen_fixtures2 import TEKLIF_KALEMLER  # pyright: ignore[reportMissingImports]

    src = os.path.join(d, "teklif", "teklif.docx")
    out, named = find_output(d, src, "teklifabc", (".docx",))
    checks, notes = [['"teklif_ABC" adıyla kaydedildi', named]], []
    sdoc = Document(src)
    checks.append(["orijinal dosya korundu", any("XYZ Bil" in p.text for p in sdoc.paragraphs)])
    if not out:
        return checks + [["çıktı dosyası var", False]], notes
    doc = Document(out)
    paras = doc.paragraphs
    texts = [p.text for p in paras] + [c.text for t in doc.tables for r in t.rows for c in r.cells]
    sec = doc.sections[0]
    texts += [p.text for p in sec.header.paragraphs] + [p.text for p in sec.footer.paragraphs]
    sayin = next((p for p in paras if p.text.strip().startswith("Sayın")), None)
    tarih = next((p for p in paras if p.text.strip().startswith("Tarih")), None)
    checks.append(["müşteri adı her yerde ABC Bilişim A.Ş. (XYZ kalmadı)",
                   not any("XYZ" in t for t in texts) and bool(sayin) and "ABC Bilişim A.Ş." in sayin.text])
    name_runs = [r for r in (sayin.runs if sayin else []) if r.text.strip() and not r.text.strip().startswith("Sayın")]
    checks.append(["müşteri adı kalın kaldı", bool(name_runs) and all(r.bold for r in name_runs)])
    date_runs = [r for r in (tarih.runs if tarih else []) if "2026" in r.text]
    checks.append(["tarih 26.11.2026 ve kalın", bool(tarih) and "26.11.2026" in tarih.text and "01.11.2026" not in tarih.text
                   and bool(date_runs) and all(r.bold for r in date_runs)])
    t = doc.tables[0] if doc.tables else None
    ok_vals, ok_fmt = True, True
    if t is None or len(t.rows) != len(TEKLIF_KALEMLER) + 2:
        ok_vals = ok_fmt = False
        notes.append(f"tablo satır sayısı değişti: {len(t.rows) if t else 0}")
    else:
        toplam = 0.0
        for i, (ad, adet, fiyat) in enumerate(TEKLIF_KALEMLER, start=1):
            cells = [c.text.strip() for c in t.rows[i].cells]
            bf, tt = round(fiyat * 1.1, 2), round(fiyat * 1.1, 2) * adet
            toplam += tt
            if cells[0] != ad or cells[1] != str(adet) or parse_tr(cells[2]) != bf or parse_tr(cells[3]) != tt:
                ok_vals = False
                notes.append(f"satır {i}: {cells} (beklenen birim {bf:g}, tutar {tt:g})")
            if not all(re.fullmatch(r"\d{1,3}(\.\d{3})*,\d{2}", x) for x in cells[2:4]):
                ok_fmt = False
        last = [c.text.strip() for c in t.rows[-1].cells]
        if parse_tr(last[3]) != round(toplam, 2):
            ok_vals = False
            notes.append(f"toplam: {last[3]!r} (beklenen {toplam:g})")
        if not re.fullmatch(r"\d{1,3}(\.\d{3})*,\d{2}", last[3]):
            ok_fmt = False
    checks.append(["birim fiyat +%10, tutarlar ve toplam doğru", ok_vals])
    checks.append(["sayılar eski biçimde (27.500,00)", ok_fmt])
    st = sdoc.tables[0]
    checks.append(["tablo stili ve başlık satırı aynı", t is not None and t.style.name == st.style.name
                   and [c.text for c in t.rows[0].cells] == [c.text for c in st.rows[0].cells]])
    sty = {p.text.strip(): p.style.name for p in paras}
    checks.append(["başlık ve madde stilleri korundu", sty.get("FİYAT TEKLİFİ") == "Heading 1" and sty.get("Koşullar") == "Heading 2"
                   and sum(1 for p in paras if p.style.name == "List Bullet") == 2])
    ssec = sdoc.sections[0]
    checks.append(["üst/alt bilgi aynı", [p.text for p in sec.header.paragraphs] == [p.text for p in ssec.header.paragraphs]
                   and [p.text for p in sec.footer.paragraphs] == [p.text for p in ssec.footer.paragraphs]])
    sayg = next((p for p in paras if "Saygılarımızla" in p.text), None)
    checks.append(["paragraf sayısı aynı, italik kapanış korundu", len(paras) == len(sdoc.paragraphs)
                   and bool(sayg) and all(r.italic for r in sayg.runs if r.text.strip())])
    return checks, notes


def _pdf_pages(path: str) -> int:
    import subprocess
    out = subprocess.run(["pdfinfo", path], capture_output=True, text=True, timeout=30).stdout
    m = re.search(r"Pages:\s+(\d+)", out)
    return int(m.group(1)) if m else 0


def _pdf_text(path: str, page: int, crop=None) -> str:
    import subprocess
    args = ["pdftotext", "-f", str(page), "-l", str(page)]
    if crop:
        args += ["-x", "0", "-y", str(crop[0]), "-W", "700", "-H", str(crop[1])]
    return subprocess.run(args + [path, "-"], capture_output=True, text=True, timeout=30).stdout


def grade_pdf_sartname(d: str):
    import subprocess
    src = os.path.join(d, "belgeler", "sartname.pdf")
    out, named = find_output(d, src, "sartnameson", (".pdf",))
    checks, notes = [['"sartname_son.pdf" adıyla kaydedildi', named]], []
    checks.append(["orijinal dosya korundu", _pdf_pages(src) == 6])
    if not out:
        return checks + [["çıktı dosyası var", False]], notes
    n = _pdf_pages(out)
    want = ["PDFMARK-1", "PDFMARK-2", "PDFMARK-4", "PDFMARK-6", "EKMARK-1", "EKMARK-2"]
    pages = [_pdf_text(out, i) for i in range(1, n + 1)]
    got = [next((m for m in want if m in t), "?") for t in pages]
    checks.append([f"sayfa sayısı 6 (bulunan {n})", n == 6])
    checks.append(["sayfa sırası: 1,2,4,6 + EK-1, EK-2", got == want])
    if got != want:
        notes.append(f"sıra: {got}")
    checks.append(["her sayfada damga var", n > 0 and all(re.search(r"TESLA\s*TEKNOLOJ", t.upper()) for t in pages)])
    checks.append(["Türkçe karakterler doğru (TEKNOLOJİ - GİZLİ)", n > 0 and all("TEKNOLOJİ" in t and "GİZLİ" in t for t in pages)])
    checks.append(["damga sayfanın altında", n > 0 and all("TESLA" in _pdf_text(out, i, (670, 200)).upper() for i in range(1, n + 1))])
    checks.append(["metin seçilebilir kaldı (görüntüye çevrilmedi)",
                   n > 0 and all(("Yüklenici" in t) or ("Garanti" in t) for t in pages)])
    info = subprocess.run(["pdfinfo", out], capture_output=True, text=True, timeout=30).stdout
    checks.append(["sayfa boyutu A4 kaldı", "595" in info and "841" in info])
    return checks, notes


def grade_img_urun(d: str):
    from PIL import Image
    from gen_fixtures2 import URUN_FOTO_TARIH  # pyright: ignore[reportMissingImports]

    src = os.path.join(d, "urun_foto", "urun.jpg")
    out, named = find_output(d, src, "urunweb", (".jpg", ".jpeg"))
    checks, notes = [['"urun_web.jpg" adıyla kaydedildi', named]], []
    with Image.open(src) as so:
        checks.append(["orijinal dosya korundu", so.size == (4000, 3000)])
    if not out:
        return checks + [["çıktı dosyası var", False]], notes
    im = Image.open(out)
    checks.append(["JPEG biçiminde", im.format == "JPEG"])
    checks.append([f"boyut 1200×900 (bulunan {im.size[0]}×{im.size[1]})", abs(im.size[0] - 1200) <= 1 and abs(im.size[1] - 900) <= 1])
    ex = im.getexif()
    dto = ex.get_ifd(0x8769).get(0x9003) if ex else None
    checks.append(["EXIF çekim tarihi korundu", URUN_FOTO_TARIH in (dto, ex.get(0x0132) if ex else None)])
    rgb = im.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    red = [(x, y) for y in range(0, h, 2) for x in range(0, w, 2) if px[x, y][0] > 180 and px[x, y][1] < 90 and px[x, y][2] < 90]
    if red:
        xs, ys = [p[0] for p in red], [p[1] for p in red]
        bx0, by0, bx1, by1 = min(xs), min(ys), max(xs), max(ys)
        bw, bh = bx1 - bx0 + 1, by1 - by0 + 1
        notes.append(f"logo kutusu: ({bx0},{by0})-({bx1},{by1})")
    checks.append(["logo sağ alt köşede", bool(red) and bx0 > w / 2 and by0 > h / 2 and bx1 > w * 0.8 and by1 > h * 0.8])
    checks.append(["logo oranı bozulmadı, makul boyutta", bool(red) and abs((bw / bh) / (400 / 150) - 1) < 0.25 and 0.05 * w <= bw <= 0.45 * w])
    c = px[w // 2, h // 2]
    checks.append(["fotoğraf içeriği bozulmadı (kırpma/esneme yok)", sum(c) / 3 > 150])
    return checks, notes


MODES = {"xlsx_fiyat": grade_xlsx_fiyat, "docx_teklif": grade_docx_teklif,
         "pdf_sartname": grade_pdf_sartname, "img_urun": grade_img_urun}

if __name__ == "__main__":
    mode, d = sys.argv[1], sys.argv[2]
    try:
        ch, nt = MODES[mode](d)
    except Exception as ex:  # noqa: BLE001
        ch, nt = [["puanlayıcı çalıştı", False]], [f"{type(ex).__name__}: {ex}"]
    print(json.dumps({"checks": ch, "notes": nt}, ensure_ascii=False))
