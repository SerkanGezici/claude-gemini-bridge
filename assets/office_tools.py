#!/usr/bin/env python3
"""office_tools — belge düzenlemesi için belirleyici analiz ve karşılaştırma (ADR-0004).

  python office_tools.py inspect <dosya>
  python office_tools.py compare <orijinal> <yeni>

Excel (.xlsx/.xlsm), Word (.docx), PowerPoint (.pptx), PDF ve görseller. Çıktı modelin
okuyacağı düz metindir; "SORUN" satırları düzeltilmesi gereken farklardır. Dosya yazmaz.
docenv (openpyxl, python-docx, python-pptx, pymupdf, Pillow) ile çalışır.
"""
import os
import re
import sys
import zipfile

MAX_ROWS = 400  # bir sayfada tam dökülen satır sınırı; fazlası özetlenir
MAX_TEXT = 60


def host_path(p: str) -> str:
    """C:\\Users\\x → /mnt/c/Users/x (WSL); diğer yollar aynen."""
    m = re.match(r"^([A-Za-z]):[\\/](.*)$", p)
    if m and os.name != "nt":
        rest = m.group(2).replace("\\", "/")
        return f"/mnt/{m.group(1).lower()}/{rest}"
    return p


def kind_of(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm"):
        return "xlsx"
    if ext == ".docx":
        return "docx"
    if ext == ".pptx":
        return "pptx"
    if ext == ".pdf":
        return "pdf"
    if ext in (".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".gif", ".heic"):
        return "image"
    return "?"


def short(v, n=MAX_TEXT) -> str:
    if isinstance(v, str):
        v = v.replace("\n", "⏎")
        return '"' + (v if len(v) <= n else v[:n] + "…") + '"'
    return repr(v)


def sonuc(problems: list, ok_text: str) -> str:
    """SORUN = istenmiş olamayacak kayıp (düzeltilmeli); UYARI = istek olabilir (gerekçe yaz)."""
    n = sum(1 for p in problems if p.startswith("SORUN"))
    w = len(problems) - n
    tail = f", {w} uyarı (istenen değişiklikse sorun değil; raporda belirt)" if w else ""
    return f"SONUÇ: {n} sorun{tail}" + (" — SORUN satırlarını düzeltip yeniden karşılaştır" if n else f" — {ok_text}")


# ── Excel ───────────────────────────────────────────────────────────────────

def fill_of(c):
    f = c.fill
    if f is None or f.fill_type in (None, "none"):
        return None
    col = f.fgColor
    if col is None:
        return None
    if col.type == "rgb" and isinstance(col.rgb, str):
        return None if col.rgb in ("00000000",) else col.rgb
    if col.type == "theme":
        return f"tema{col.theme}"
    if col.type == "indexed":
        return f"idx{col.indexed}"
    return None


def style_of(c) -> dict:
    return {
        "fmt": c.number_format if c.number_format and c.number_format != "General" else None,
        "kalın": bool(c.font and c.font.b),
        "italik": bool(c.font and c.font.i),
        "dolgu": fill_of(c),
    }


def style_txt(st: dict) -> str:
    parts = []
    if st["fmt"]:
        parts.append(f"biçim={st['fmt']}")
    if st["kalın"]:
        parts.append("kalın")
    if st["italik"]:
        parts.append("italik")
    if st["dolgu"]:
        parts.append(f"dolgu={st['dolgu']}")
    return f" [{', '.join(parts)}]" if parts else ""


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_formula(v) -> bool:
    return isinstance(v, str) and v.startswith("=")


def row_cells(ws, r):
    """Dolu, gerçek hücreler (birleştirilmiş alanın gölge hücreleri MergedCell hariç)."""
    from openpyxl.cell.cell import Cell
    if r > ws.max_row:
        return []
    return [c for c in ws[r] if isinstance(c, Cell) and c.value not in (None, "")]


def cell_value(ws, r, c):
    cell = ws._cells.get((r, c))  # ws.cell() eksik hücreyi yaratır ve max_row'u büyütür
    return cell.value if cell is not None else None


def classify(cells) -> str:
    if not cells:
        return "BOŞ"
    texts = [c for c in cells if isinstance(c.value, str) and not is_formula(c.value)]
    nums = [c for c in cells if is_num(c.value) or is_formula(c.value) or hasattr(c.value, "year")]
    if len(texts) >= 2 and not nums:
        return "BAŞLIK"
    if len(texts) == 1 and not nums:
        return "ARA BAŞLIK" if texts[0].font and texts[0].font.b else "YALNIZ METİN (değerleri boş)"
    return "VERİ"


def header_signature(cells) -> tuple:
    # Blok başlıkları ilk sütunda grup adı taşır; deseni ikinci hücreden itibaren karşılaştır.
    return tuple(norm(c.value) for c in cells[1:])


def norm(v) -> str:
    s = str(v or "").replace("İ", "i").replace("I", "ı").lower().replace("ı", "i")
    return re.sub(r"[^0-9a-zçğöşü]", "", s)


def xlsx_file_checks(path: str) -> list:
    out = []
    try:
        z = zipfile.ZipFile(path)
        bad = z.testzip()
        if bad:
            out.append(f"SORUN: zip paketi bozuk ({bad}) — Excel onarım sorar")
        core = z.read("docProps/core.xml").decode("utf8", "replace") if "docProps/core.xml" in z.namelist() else ""
        if "+00:00Z" in core:
            out.append("SORUN: docProps/core.xml tarihi '+00:00Z' (openpyxl 3.1.2 hatası) — Excel açılışta onarım sorar; "
                       "dosyayı openpyxl 3.1.5 ile (docenv Python) yeniden kaydet")
    except zipfile.BadZipFile as e:
        out.append(f"SORUN: geçerli bir xlsx değil ({e})")
    return out


def inspect_xlsx(path: str) -> str:
    import openpyxl
    wb = openpyxl.load_workbook(path)
    L = [f"EXCEL: {os.path.basename(path)} — {len(wb.sheetnames)} sayfa: {', '.join(repr(n) for n in wb.sheetnames)}"]
    L += xlsx_file_checks(path)
    if wb.defined_names:
        L.append(f"Tanımlı adlar: {', '.join(list(wb.defined_names.keys())[:10])}")
    for ws in wb.worksheets:
        L.append("")
        L.append(f"### Sayfa {ws.title!r} — aralık {ws.dimensions}, {ws.max_row} satır × {ws.max_column} sütun")
        widths = {k: round(v.width, 1) for k, v in sorted(ws.column_dimensions.items()) if v.width}
        L.append(f"Sütun genişlikleri: {widths or 'varsayılan'}")
        merged = [str(m) for m in ws.merged_cells.ranges]
        L.append(f"Birleştirilmiş: {merged[:10] or 'yok'} · Koşullu biçim: {len(ws.conditional_formatting)} · "
                 f"Veri doğrulama: {len(ws.data_validations.dataValidation)} · Dondurma: {ws.freeze_panes or 'yok'} · "
                 f"Otomatik filtre: {ws.auto_filter.ref or 'yok'} · Tablolar: {list(ws.tables.keys()) or 'yok'}")
        rows = {r: row_cells(ws, r) for r in range(1, ws.max_row + 1)}
        kinds = {r: classify(c) for r, c in rows.items()}
        headers = [r for r, k in kinds.items() if k == "BAŞLIK"]
        formulas = sum(1 for cs in rows.values() for c in cs if is_formula(c.value))
        if formulas:
            L.append(f"Formül: {formulas} hücre (değiştirme; yeni hesaplar da formül olabilir)")
        if len(headers) > 1:
            sigs = {}
            for r in headers:
                sigs.setdefault(header_signature(rows[r]), []).append(r)
            for sig_rows in sigs.values():
                if len(sig_rows) > 1:
                    pat = " | ".join(short(c.value, 20) for c in rows[sig_rows[0]])
                    L.append(f"DİKKAT: aynı başlık deseni {len(sig_rows)} kez tekrar ediyor (satır {', '.join(map(str, sig_rows))}): {pat} "
                             f"→ sayfa BLOKLARDAN oluşuyor; sütun ekleme/silme/sıralama HER blok başlığına ve bloğun satırlarına uygulanmalı")
        col_fmt = {}
        for r, cs in rows.items():
            if kinds[r] == "VERİ":
                for c in cs:
                    if is_num(c.value) or is_formula(c.value):
                        col_fmt.setdefault(c.column_letter, {}).setdefault(c.number_format, 0)
                        col_fmt[c.column_letter][c.number_format] += 1
        if col_fmt:
            L.append("Sayısal sütun biçimleri: " + "; ".join(
                f"{k}: " + ", ".join(f"{f} ({n})" for f, n in v.items()) for k, v in sorted(col_fmt.items())))
            money = sorted(k for k, v in col_fmt.items() if any(("$" in f or "₺" in f or "TL" in f or "€" in f) for f in v))
            if money:
                L.append(f"DİKKAT: para birimi biçimli sütunlar {money} — taşınan ve yeni eklenen sayı hücreleri aynı biçimi almalı")
        empty_vals = [r for r, k in kinds.items() if k.startswith("YALNIZ METİN")]
        if empty_vals:
            L.append(f"Değeri boş satırlar ({len(empty_vals)}): {empty_vals[:20]} — bunlara hesaplanmış değer yazma")
        L.append("Satırlar:")
        shown = 0
        for r in range(1, ws.max_row + 1):
            k = kinds[r]
            if k == "BOŞ":
                continue
            if shown >= MAX_ROWS and k == "VERİ":
                continue
            shown += 1
            L.append(f"  {r:>4} {k}: " + " | ".join(f"{c.coordinate}={short(c.value)}{style_txt(style_of(c))}" for c in rows[r]))
        hidden = sum(1 for r in range(1, ws.max_row + 1) if kinds[r] == "VERİ") - sum(
            1 for r in range(1, ws.max_row + 1) if kinds[r] == "VERİ" and r <= MAX_ROWS)
        if shown >= MAX_ROWS and hidden > 0:
            L.append(f"  … {hidden} VERİ satırı daha (yalnız başlık/ara başlık satırları gösterildi)")
    return "\n".join(L)


def compare_xlsx(a: str, b: str) -> str:
    import openpyxl
    wa, wb_ = openpyxl.load_workbook(a), openpyxl.load_workbook(b)
    L, problems = [], []
    problems += xlsx_file_checks(b)
    gone = [n for n in wa.sheetnames if n not in wb_.sheetnames]
    new = [n for n in wb_.sheetnames if n not in wa.sheetnames]
    if gone:
        problems.append(f"UYARI: sayfa(lar) kayboldu: {gone}")
    if new:
        L.append(f"Yeni sayfa(lar): {new}")
    for name in [n for n in wa.sheetnames if n in wb_.sheetnames]:
        sa, sb = wa[name], wb_[name]
        L.append("")
        L.append(f"### Sayfa {name!r}: {sa.max_row}×{sa.max_column} → {sb.max_row}×{sb.max_column}")
        rows_a = {r: row_cells(sa, r) for r in range(1, sa.max_row + 1)}
        kinds_a = {r: classify(c) for r, c in rows_a.items()}
        first_hdr = next((r for r, k in kinds_a.items() if k == "BAŞLIK"), None)
        label = {}
        if first_hdr:
            for c in rows_a[first_hdr]:
                label[c.column_letter] = str(c.value)
        a_col = [sa.cell(r, 1).value for r in range(1, sa.max_row + 1)]
        b_col = [cell_value(sb, r, 1) for r in range(1, sa.max_row + 1)]
        if sa.max_row != sb.max_row:
            problems.append(f"UYARI [{name}]: satır sayısı {sa.max_row} → {sb.max_row}")
        moved_rows = [r for r in range(1, sa.max_row + 1) if a_col[r - 1] != b_col[r - 1]]
        if moved_rows:
            ex = ", ".join(f"A{r}: {short(a_col[r - 1], 25)} → {short(b_col[r - 1], 25)}" for r in moved_rows[:4])
            L.append(f"A sütunu {len(moved_rows)} satırda değişti: {ex}")
        lost_vals, fmt_loss, bold_loss, fill_loss, moves, matched = {}, {}, {}, {}, {}, {}
        for r, cs in rows_a.items():
            if not cs:
                continue
            cand = row_cells(sb, r)
            used = matched.setdefault(r, set())
            for c in cs:
                same = sb._cells.get((r, c.column)) if c.column else None  # okuma yan etkisiz (cell() hücre yaratır)
                match = same if same is not None and same.value == c.value and same.coordinate not in used else None
                if match is None:
                    match = next((d for d in cand if d.value == c.value and d.coordinate not in used), None)
                col = c.column_letter
                lab = label.get(col, col)
                if match is None:
                    lost_vals.setdefault(lab, []).append(c.coordinate)
                    continue
                used.add(match.coordinate)
                if match.column_letter != col:
                    moves.setdefault((lab, col, match.column_letter), 0)
                    moves[(lab, col, match.column_letter)] += 1
                s1, s2 = style_of(c), style_of(match)
                if s1["fmt"] != s2["fmt"]:
                    fmt_loss.setdefault((lab, s1["fmt"], s2["fmt"]), []).append(match.coordinate)
                if s1["kalın"] and not s2["kalın"]:
                    bold_loss.setdefault(lab, []).append(match.coordinate)
                if s1["dolgu"] and s1["dolgu"] != s2["dolgu"]:
                    fill_loss.setdefault(lab, []).append(match.coordinate)
        for (lab, c1, c2), n in sorted(moves.items(), key=lambda x: -x[1]):
            L.append(f"Taşınan: {short(lab, 30)} sütunu {c1} → {c2} ({n} hücre)")
        for lab, cells in lost_vals.items():
            L.append(f"Kaybolan değerler: {short(lab, 30)} sütunundan {len(cells)} hücre ({', '.join(cells[:6])}) — silinmesi istendiyse beklenen")
        for (lab, f1, f2), cells in fmt_loss.items():
            problems.append(f"SORUN [{name}] BİÇİM KAYBI: {short(lab, 30)} değerleri {len(cells)} hücrede biçim {f1 or 'General'} → {f2 or 'General'} "
                            f"({', '.join(cells[:6])})")
        for lab, cells in bold_loss.items():
            problems.append(f"SORUN [{name}] KALINLIK KAYBI: {short(lab, 30)} {len(cells)} hücre ({', '.join(cells[:6])})")
        for lab, cells in fill_loss.items():
            problems.append(f"SORUN [{name}] DOLGU KAYBI: {short(lab, 30)} {len(cells)} hücre ({', '.join(cells[:6])})")
        # Blok başlıkları: orijinaldeki her BAŞLIK satırı yenide de aynı sütun sayısında ve aynı etiketlerle mi?
        hdr_rows = [r for r, k in kinds_a.items() if k == "BAŞLIK"]
        if hdr_rows:
            new_hdrs = {r: [norm(c.value) for c in row_cells(sb, r)][1:] for r in hdr_rows if r <= sb.max_row}
            ref = max(new_hdrs.values(), key=len) if new_hdrs else []
            L.append("Blok başlıkları (orijinal → yeni):")
            moved_to = {c1: c2 for (_lab, c1, c2) in moves}
            for r in hdr_rows:
                new_cells = row_cells(sb, r)
                # Kalınlık: orijinal başlık satırı tamamen kalınsa yenisi de (yeni sütun başlığı dahil) kalın olmalı.
                if all(c.font and c.font.b for c in rows_a[r]):
                    thin = [c.coordinate for c in new_cells if not (c.font and c.font.b)]
                    if thin:
                        problems.append(f"SORUN [{name}] BAŞLIK KALINLIĞI: satır {r} başlıkları kalındı, şimdi kalın olmayan: {thin}")
                # Yeniden adlandırma: verisi korunan sütunun başlık metni değişmiş mi?
                by_col = {c.column_letter: c for c in new_cells}
                for c in rows_a[r][1:]:
                    dest = moved_to.get(c.column_letter, c.column_letter)
                    kept = any(k[1] == c.column_letter for k in moves) or (label.get(c.column_letter) not in lost_vals or
                                                                         len(lost_vals.get(label.get(c.column_letter), [])) <= len(hdr_rows))
                    nc = by_col.get(dest)
                    if kept and nc is not None and isinstance(nc.value, str) and norm(nc.value) != norm(c.value) \
                            and not any(norm(x.value) == norm(c.value) for x in new_cells):
                        problems.append(f"UYARI [{name}] BAŞLIK DEĞİŞTİ: satır {r} {short(c.value, 25)} → {short(nc.value, 25)} "
                                        f"(verisi korunan sütunun adı; istenmediyse eski adı koru)")
                va = " | ".join(str(c.value) for c in rows_a[r])
                vb = " | ".join(str(c.value) for c in row_cells(sb, r)) if r <= sb.max_row else "(satır yok)"
                L.append(f"  satır {r}: {va}  →  {vb}")
                if r in new_hdrs and new_hdrs[r] != ref:
                    problems.append(f"SORUN [{name}] BLOK BAŞLIĞI TUTARSIZ: satır {r} = {vb!r}; başka bloklarda {ref} — "
                                    f"değişiklik her bloğa uygulanmamış")
        # Yeni sütunlardaki sayılar komşu sayı sütunlarının biçimini almış mı?
        for r in range(1, sb.max_row + 1):
            if kinds_a.get(r) != "VERİ":
                continue
            # Yalnız YENİ eklenen sayılar (orijinal satırda karşılığı yok): orijinal satır biçimli sayılar
            # taşıyorsa yeni sayı biçimsiz kalmamalı. Orijinalde de biçimsiz olan sütunlar (adet vb.) dokunulmaz.
            orig_fmts = {c.number_format for c in rows_a.get(r, []) if is_num(c.value) and c.number_format != "General"}
            fresh = [c for c in row_cells(sb, r) if (is_num(c.value) or is_formula(c.value)) and c.coordinate not in matched.get(r, set())]
            bare = [c.coordinate for c in fresh if c.number_format == "General"]
            if orig_fmts and bare:
                problems.append(f"SORUN [{name}] BİÇİM EKSİK: satır {r} yeni sayı hücreleri biçimsiz {bare}; satırdaki biçim {sorted(orig_fmts)}")
                break
        # Genişlik: etiketin gittiği sütun eski genişliği almış mı?
        for (lab, c1, c2), n in moves.items():
            w1, w2 = sa.column_dimensions[c1].width, sb.column_dimensions[c2].width
            if w1 and (not w2 or abs(w2 - w1) / w1 > 0.3) and n >= 2:
                problems.append(f"SORUN [{name}] GENİŞLİK: {short(lab, 30)} sütunu {c1}→{c2} taşındı ama genişlik {w1} → {w2}")
    head = [f"KARŞILAŞTIRMA: {os.path.basename(a)} → {os.path.basename(b)}",
            sonuc(problems, "biçim ve yapı korunmuş görünüyor")]
    return "\n".join(head + problems + L)


# ── Word ────────────────────────────────────────────────────────────────────

def para_desc(p) -> str:
    runs = [r for r in p.runs if r.text]
    marks = []
    if runs and all(r.bold for r in runs):
        marks.append("kalın")
    elif any(r.bold for r in runs):
        marks.append("kısmen kalın")
    if runs and all(r.italic for r in runs):
        marks.append("italik")
    if len(runs) > 1:
        marks.append(f"{len(runs)} run")
    return f"[{p.style.name}{', ' + ', '.join(marks) if marks else ''}] {short(p.text, 90)}"


def inspect_docx(path: str) -> str:
    from docx import Document
    d = Document(path)
    L = [f"WORD: {os.path.basename(path)} — {len(d.paragraphs)} paragraf, {len(d.tables)} tablo, {len(d.sections)} bölüm"]
    for i, s in enumerate(d.sections):
        h = " / ".join(p.text for p in s.header.paragraphs if p.text)
        f = " / ".join(p.text for p in s.footer.paragraphs if p.text)
        L.append(f"Bölüm {i + 1}: üst bilgi {short(h) if h else 'yok'} · alt bilgi {short(f) if f else 'yok'}")
    split = [i for i, p in enumerate(d.paragraphs) if len([r for r in p.runs if r.text]) > 1]
    if split:
        L.append(f"DİKKAT: {len(split)} paragrafta metin birden çok run'a bölünmüş ({split[:10]}) — metin değiştirirken "
                 "run sınırını aşan ifadeyi bul, yeni metni ilk run'a yaz, diğerlerini boşalt; run biçimini (kalın/italik) koru")
    L.append("Paragraflar:")
    for i, p in enumerate(d.paragraphs):
        if p.text.strip():
            L.append(f"  {i:>3} {para_desc(p)}")
    for ti, t in enumerate(d.tables):
        L.append(f"Tablo {ti + 1}: stil={t.style.name if t.style else None}, {len(t.rows)}×{len(t.columns)}")
        for ri, row in enumerate(t.rows[:40]):
            L.append(f"  r{ri}: " + " | ".join(short(c.text, 30) for c in row.cells))
    L.append("Not: tablo hücresinde metni değiştirirken cell.text = … biçimi siler; hücrenin paragraf/run'ına yaz.")
    return "\n".join(L)


def compare_docx(a: str, b: str) -> str:
    from docx import Document
    da, db = Document(a), Document(b)
    L, problems = [], []
    pa, pb = da.paragraphs, db.paragraphs
    if len(pa) != len(pb):
        problems.append(f"UYARI: paragraf sayısı {len(pa)} → {len(pb)} (belge yeniden kurulmuş olabilir)")
    aligned = len(pa) == len(pb)  # sayı farklıysa dizin hizası kayar; stil karşılaştırması sahte SORUN üretir
    for i, (x, y) in enumerate(zip(pa, pb)):
        if not aligned:
            continue
        if x.style.name != y.style.name:
            problems.append(f"SORUN STİL: paragraf {i} {x.style.name} → {y.style.name} ({short(y.text, 40)})")
        rx, ry = [r for r in x.runs if r.text], [r for r in y.runs if r.text]
        if rx and ry:
            if any(r.bold for r in rx) and not any(r.bold for r in ry):
                problems.append(f"SORUN KALINLIK: paragraf {i} kalın kısmını kaybetti ({short(y.text, 40)})")
            elif all(r.bold for r in rx) and not all(r.bold for r in ry):
                problems.append(f"SORUN KALINLIK: paragraf {i} artık tamamen kalın değil ({short(y.text, 40)})")
            if any(r.italic for r in rx) and not any(r.italic for r in ry):
                problems.append(f"SORUN İTALİK: paragraf {i} italikliğini kaybetti ({short(y.text, 40)})")
        if x.text != y.text:
            L.append(f"Metin değişti, paragraf {i}: {short(x.text, 50)} → {short(y.text, 50)}")
    for ti, (ta, tb) in enumerate(zip(da.tables, db.tables)):
        sa_, sb_ = (ta.style.name if ta.style else None), (tb.style.name if tb.style else None)
        if sa_ != sb_:
            problems.append(f"SORUN: tablo {ti + 1} stili {sa_} → {sb_}")
        if (len(ta.rows), len(ta.columns)) != (len(tb.rows), len(tb.columns)):
            problems.append(f"UYARI: tablo {ti + 1} boyutu {len(ta.rows)}×{len(ta.columns)} → {len(tb.rows)}×{len(tb.columns)}")
        for ri, (r1, r2) in enumerate(zip(ta.rows, tb.rows)):
            for ci, (c1, c2) in enumerate(zip(r1.cells, r2.cells)):
                if c1.text != c2.text:
                    L.append(f"Tablo {ti + 1} r{ri}c{ci}: {short(c1.text, 30)} → {short(c2.text, 30)}")
    if len(da.tables) != len(db.tables):
        problems.append(f"UYARI: tablo sayısı {len(da.tables)} → {len(db.tables)}")
    for i, (s1, s2) in enumerate(zip(da.sections, db.sections)):
        for part in ("header", "footer"):
            t1 = [p.text for p in getattr(s1, part).paragraphs]
            t2 = [p.text for p in getattr(s2, part).paragraphs]
            if t1 != t2:
                L.append(f"Bölüm {i + 1} {'üst' if part == 'header' else 'alt'} bilgi değişti: {t1} → {t2}")
    head = [f"KARŞILAŞTIRMA: {os.path.basename(a)} → {os.path.basename(b)}",
            sonuc(problems, "stil ve yapı korunmuş görünüyor")]
    return "\n".join(head + problems + L)


# ── PowerPoint ──────────────────────────────────────────────────────────────

def inspect_pptx(path: str) -> str:
    from pptx import Presentation
    pr = Presentation(path)
    L = [f"POWERPOINT: {os.path.basename(path)} — {len(pr.slides)} slayt"]
    for i, s in enumerate(pr.slides, start=1):
        L.append(f"Slayt {i} (düzen: {s.slide_layout.name}):")
        for sh in s.shapes:
            txt = sh.text_frame.text if sh.has_text_frame else ""
            L.append(f"  - {sh.shape_type} {sh.name!r}{': ' + short(txt, 80) if txt else ''}")
    return "\n".join(L)


def compare_pptx(a: str, b: str) -> str:
    from pptx import Presentation
    pa, pb = Presentation(a), Presentation(b)
    problems, L = [], []
    if len(pa.slides) != len(pb.slides):
        L.append(f"Slayt sayısı {len(pa.slides)} → {len(pb.slides)}")
    for i, (x, y) in enumerate(zip(pa.slides, pb.slides), start=1):
        if x.slide_layout.name != y.slide_layout.name:
            problems.append(f"UYARI: slayt {i} düzeni {x.slide_layout.name} → {y.slide_layout.name}")
        nx, ny = [s.name for s in x.shapes], [s.name for s in y.shapes]
        if nx != ny:
            L.append(f"Slayt {i} şekilleri: {nx} → {ny}")
    head = [f"KARŞILAŞTIRMA: {os.path.basename(a)} → {os.path.basename(b)}", sonuc(problems, "sorun yok")]
    return "\n".join(head + problems + L)


# ── PDF ─────────────────────────────────────────────────────────────────────

def _pdf(path):
    import pymupdf  # pyright: ignore[reportMissingImports]
    return pymupdf.open(path)


def inspect_pdf(path: str) -> str:
    doc = _pdf(path)
    L = [f"PDF: {os.path.basename(path)} — {doc.page_count} sayfa, şifreli={doc.is_encrypted}, form alanı="
         f"{sum(1 for p in doc for _ in p.widgets())}"]
    sizes = {}
    scanned = []
    for i, p in enumerate(doc, start=1):
        sizes.setdefault((round(p.rect.width), round(p.rect.height)), []).append(i)
        txt = p.get_text().strip()
        if len(txt) < 20 and p.get_images():
            scanned.append(i)
        first = next((ln for ln in txt.splitlines() if ln.strip()), "")
        L.append(f"  sayfa {i}: {len(txt)} karakter metin, {len(p.get_images())} görsel — {short(first, 70)}")
    L.insert(1, "Sayfa boyutları (pt): " + "; ".join(f"{w}×{h} → sayfa {v[:8]}" for (w, h), v in sizes.items()))
    fonts = sorted({f[3] for p in doc for f in p.get_fonts()})
    L.insert(2, f"Yazı tipleri: {fonts[:12] or 'yok'}")
    if scanned:
        L.insert(3, f"DİKKAT: taranmış (metin katmanı yok) sayfalar: {scanned} — metin için OCR gerekir")
    L.append("Not: sayfayı görüntüye çevirip yeniden üretme (metin seçilemez olur). Türkçe metin eklerken Türkçe glifli yazı "
             "tipi kullan (ör. /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf); PyMuPDF: page.insert_text(..., fontfile=...).")
    return "\n".join(L)


def compare_pdf(a: str, b: str) -> str:
    da, db = _pdf(a), _pdf(b)
    problems, L = [], [f"Sayfa sayısı: {da.page_count} → {db.page_count}"]
    first_a_full = [p.get_text() for p in da]
    first_a = [next((ln for ln in t.splitlines() if ln.strip()), "") for t in first_a_full]
    for i, p in enumerate(db, start=1):
        txt = p.get_text()
        first = next((ln for ln in txt.splitlines() if ln.strip()), "")
        src = first_a.index(first) + 1 if first in first_a else None
        L.append(f"  yeni sayfa {i}: {short(first, 50)}" + (f" (orijinal sayfa {src})" if src else ""))
        if len(txt.strip()) < 20 and p.get_images() and any(len(x.strip()) > 20 for x in first_a_full):
            problems.append(f"SORUN: sayfa {i} metin katmanı yok, yalnız görüntü — sayfa rasterleştirilmiş; metin seçilemez")
        if "\ufffd" in txt:
            problems.append(f"SORUN: sayfa {i} metninde bozuk karakter (�) — eklenen yazının yazı tipi Türkçe glif içermiyor olabilir")
    sa_ = {(round(p.rect.width), round(p.rect.height)) for p in da}
    sb_ = {(round(p.rect.width), round(p.rect.height)) for p in db}
    if not sb_ <= sa_ and sa_:
        L.append(f"Sayfa boyutları {sorted(sa_)} → {sorted(sb_)}")
    L.append(f"Dosya boyutu {os.path.getsize(a) // 1024} KB → {os.path.getsize(b) // 1024} KB (gömülü yazı tipi büyütebilir)")
    head = [f"KARŞILAŞTIRMA: {os.path.basename(a)} → {os.path.basename(b)}", sonuc(problems, "sorun yok")]
    return "\n".join(head + problems + L)


# ── Görsel ──────────────────────────────────────────────────────────────────

EXIF_TAGS = {0x010F: "Make", 0x0110: "Model", 0x0112: "Orientation", 0x0132: "DateTime"}
EXIF_SUB = {0x9003: "DateTimeOriginal", 0x9004: "DateTimeDigitized"}


def image_meta(path: str) -> dict:
    from PIL import Image
    with Image.open(path) as im:
        ex = im.getexif()
        tags = {n: ex.get(k) for k, n in EXIF_TAGS.items() if ex.get(k) is not None}
        sub = ex.get_ifd(0x8769) if ex else {}
        tags.update({n: sub.get(k) for k, n in EXIF_SUB.items() if sub.get(k) is not None})
        return {"format": im.format, "size": im.size, "mode": im.mode, "exif": tags,
                "icc": bool(im.info.get("icc_profile")), "dpi": im.info.get("dpi"), "bytes": os.path.getsize(path)}


def inspect_image(path: str) -> str:
    m = image_meta(path)
    return (f"GÖRSEL: {os.path.basename(path)} — {m['format']} {m['size'][0]}×{m['size'][1]} {m['mode']}, "
            f"{m['bytes'] // 1024} KB, DPI {m['dpi']}, ICC profili {'var' if m['icc'] else 'yok'}\n"
            f"EXIF: {m['exif'] or 'yok'}\n"
            "Not: Pillow ile kaydederken EXIF'i koru (save(..., exif=im.info.get('exif'))), ICC'yi koru "
            "(icc_profile=im.info.get('icc_profile')), JPEG kalitesi ≥ 90; orantılı boyutlandır; orijinalin üzerine yazma.")


def compare_image(a: str, b: str) -> str:
    x, y = image_meta(a), image_meta(b)
    problems, L = [], []
    L.append(f"Boyut {x['size'][0]}×{x['size'][1]} → {y['size'][0]}×{y['size'][1]}, biçim {x['format']} → {y['format']}, "
             f"{x['bytes'] // 1024} KB → {y['bytes'] // 1024} KB")
    ra, rb = x["size"][0] / x["size"][1], y["size"][0] / y["size"][1]
    if abs(ra - rb) / ra > 0.02:
        problems.append(f"UYARI: en-boy oranı değişti ({ra:.3f} → {rb:.3f}) — görüntü esnemiş ya da kırpılmış")
    for k, v in x["exif"].items():
        if k != "Orientation" and y["exif"].get(k) != v:
            problems.append(f"UYARI EXIF: {k} {v!r} → {y['exif'].get(k)!r}")
    if x["icc"] and not y["icc"]:
        problems.append("SORUN: ICC renk profili kayboldu")
    head = [f"KARŞILAŞTIRMA: {os.path.basename(a)} → {os.path.basename(b)}", sonuc(problems, "sorun yok")]
    return "\n".join(head + problems + L)


INSPECT = {"xlsx": inspect_xlsx, "docx": inspect_docx, "pptx": inspect_pptx, "pdf": inspect_pdf, "image": inspect_image}
COMPARE = {"xlsx": compare_xlsx, "docx": compare_docx, "pptx": compare_pptx, "pdf": compare_pdf, "image": compare_image}


def force_utf8() -> None:
    """-I PYTHONUTF8/PYTHONIOENCODING'i yok sayar; Windows'ta borular ANSI kod sayfasında açılır."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def main(argv) -> int:
    force_utf8()
    if len(argv) < 3 or argv[1] not in ("inspect", "compare") or (argv[1] == "compare" and len(argv) < 4):
        print(__doc__)
        return 2
    paths = [host_path(p) for p in argv[2:4 if argv[1] == "compare" else 3]]
    for p in paths:
        if not os.path.exists(p):
            print(f"HATA: dosya yok: {p}")
            return 1
    k = kind_of(paths[0])
    if k == "?":
        print(f"HATA: desteklenmeyen tür: {paths[0]} (xlsx, docx, pptx, pdf, görsel)")
        return 1
    try:
        print(INSPECT[k](paths[0]) if argv[1] == "inspect" else COMPARE[k](paths[0], paths[1]))
    except Exception as e:  # noqa: BLE001 — model için okunur hata
        print(f"HATA: {type(e).__name__}: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
