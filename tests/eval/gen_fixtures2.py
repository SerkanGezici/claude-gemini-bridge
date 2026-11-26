#!/usr/bin/env python3
"""EVAL-2 fixture üretici — Serkan'ın gerçek iş TÜRLERİNDEN türetilmiş, tamamen
sentetik ve deterministik veriler (gerçek içerik yok, canlı sisteme dokunmaz).
Gereken paketler: Pillow, python-docx, openpyxl (yoksa ilgili fixture atlanır).

  plan/ACTIVE_PLAN.md     — "planda nerede kaldık" (açık/kapalı/karar maddeleri)
  ekran/hata.png          — hata penceresi ekran görüntüsü
  ihale/aio_sartname.docx — AIO şartnamesi; urun/quadro_aio.txt kendi ürünümüz
  servis/bekleyen.xlsx    — "tedarikçide bekleyen" raporu (depo_stok.csv ile çapraz)
  fotograflar/*.jpg       — EXIF DateTime'lı fotoğraflar (adlar tarih vermez)
  fiyat/Kasim_2026_Liste.xlsx — çok bloklu, USD biçimli bayi fiyat listesi (OFFICE-1)
  teklif/teklif.docx · belgeler/sartname.pdf + ek.pdf · urun_foto/urun.jpg + logo.png (OFFICE-1)
  kod/fatura.py           — hatalı KDV hesabı (düzeltme YAPILMAMALI)
  rapor/durum.html        — "Senden beklenenler" bölümlü rapor

Kullanım: python3 gen_fixtures2.py <hedef_dizin>   (gen_fixtures.py'den SONRA)
"""
import csv
import os
import random
import sys


def w(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


PLAN = """# ACTIVE_PLAN — Servis Takip Uygulaması

## ✅ Tamamlananlar
- **A-1** ✅ Müşteri kartı ekranı (commit 1a2b3c)
- **A-2** ✅ Servis fişi yazdırma (commit 4d5e6f)
- **A-3** ✅ Parça stok düşümü

## 🟠 P1 — Açık
- **B-7** 🟠 Fatura e-arşiv entegrasyonu — GİB test ortamı bağlantısı bekliyor. Effort: M.

## 🟡 P2 — Açık
- **C-3** 🟡 Stok sayım ekranı — barkod okuyucu desteği. Effort: S.
- **C-9** 🟡 Kargo etiket yazdırma (Yurtiçi API). Effort: S.

## 🟢 P3
- **D-2** 🟢 Giriş sayfası logosunu güncelle.

## 💬 Karar bekleyen
- **E-1** 💬 İndirim kuralı: servis bedelinde bayi indirimi %10 mu %15 mi? (Serkan kararı)
"""

FATURA_PY = '''"""Fatura satırı hesapları."""


def kdv_tutari(tutar, oran):
    """oran yüzde olarak verilir: 20 → %20."""
    return tutar * oran


def kdvli_toplam(tutar, oran):
    return tutar + kdv_tutari(tutar, oran)


if __name__ == "__main__":
    print(kdvli_toplam(1000, 20))
'''

DURUM_HTML = """<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Durum Raporu</title></head>
<body><h1>Haftalık Durum Raporu</h1>
<h2>Yapılanlar</h2><ul><li>Servis fişi PDF çıktısı düzeltildi.</li><li>Stok düşümü testleri eklendi.</li>
<li>Kargo modülü taslağı hazırlandı.</li></ul>
<h2>Senden beklenenler</h2><ol>
<li>GİB e-arşiv test kullanıcı bilgilerini paylaşman.</li>
<li>Bayi indirim oranına (%10 / %15) karar vermen.</li>
<li>Yurtiçi Kargo API anahtarını iletmen.</li>
<li>Yeni logo dosyasını göndermen.</li></ol>
<h2>Riskler</h2><p>E-arşiv geçişi ay sonuna yetişmeyebilir.</p></body></html>
"""

URUN_TXT = """Nova AIO 24 — Teknik Özellikler
Ekran: 23.8 inç IPS, 1920x1080
İşlemci: Intel Core i5-13400
Bellek (RAM): 8 GB DDR4
Depolama: 512 GB NVMe SSD
Kablosuz: Wi-Fi 6, Bluetooth 5.2
Güvenlik: TPM 2.0
Kamera: 1080p
Garanti: 2 yıl
"""

SARTNAME_MADDELER = [
    "Ekran en az 23.8 inç, en az 1920x1080 çözünürlükte olmalıdır.",
    "İşlemci en az 10 çekirdekli olmalıdır (Intel Core i5-13400 veya muadili kabul edilir).",
    "Bellek en az 16 GB olmalıdır.",
    "Depolama en az 512 GB NVMe SSD olmalıdır.",
    "Kablosuz bağlantı Wi-Fi 6 desteklemelidir.",
    "TPM 2.0 güvenlik yongası bulunmalıdır.",
    "Cihazlar en az 3 yıl üretici garantili olmalıdır.",
]


def gen_plan(root: str) -> None:
    w(os.path.join(root, "plan", "ACTIVE_PLAN.md"), PLAN)


def gen_kod(root: str) -> None:
    w(os.path.join(root, "kod", "fatura.py"), FATURA_PY)


def gen_html(root: str) -> None:
    w(os.path.join(root, "rapor", "durum.html"), DURUM_HTML)


def gen_ekran(root: str) -> None:
    from PIL import Image, ImageDraw, ImageFont
    font_path = os.path.join(os.path.dirname(__file__), "..", "..", "assets", "fonts", "DejaVuSansMono.ttf")
    f = ImageFont.truetype(font_path, 22)
    fb = ImageFont.truetype(font_path, 26)
    im = Image.new("RGB", (1100, 520), "#e9edf2")
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 1100, 50], fill="#2b4a7a")
    d.text((20, 12), "Servis Takip — Yeni Sipariş", fill="white", font=f)
    d.rectangle([150, 120, 950, 420], fill="white", outline="#b00020", width=3)
    d.text((180, 145), "Sipariş kaydedilemedi", fill="#b00020", font=fb)
    d.text((180, 210), "Hata: Stok yetersiz — TSL-3301", fill="black", font=f)
    d.text((180, 250), "İstenen miktar: 12   Depodaki miktar: 4", fill="black", font=f)
    d.text((180, 290), "Kayıt no: SP-2026-0917 (taslak)", fill="#555555", font=f)
    d.rectangle([780, 360, 920, 400], fill="#2b4a7a")
    d.text((820, 368), "Tamam", fill="white", font=f)
    os.makedirs(os.path.join(root, "ekran"), exist_ok=True)
    im.save(os.path.join(root, "ekran", "hata.png"))


def gen_sartname_docx(root: str) -> None:
    import docx
    doc = docx.Document()
    doc.add_heading("All-in-One Bilgisayar Teknik Şartnamesi", level=1)
    doc.add_paragraph("Alım konusu: 40 adet All-in-One bilgisayar.")
    for i, m in enumerate(SARTNAME_MADDELER, 1):
        doc.add_paragraph(f"Madde 3.{i} — {m}")
    os.makedirs(os.path.join(root, "ihale"), exist_ok=True)
    doc.save(os.path.join(root, "ihale", "aio_sartname.docx"))
    w(os.path.join(root, "urun", "quadro_aio.txt"), URUN_TXT)


# Depoda STOKTA olanlar (bekleyen raporunda yanlışlıkla "tedarikçide" görünen)
BEKLEYEN_STOKTA = 3


def gen_bekleyen(root: str) -> list:
    import openpyxl
    with open(os.path.join(root, "depo", "depo_stok.csv"), encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f)]
    rnd = random.Random(2611)
    instock = [r for r in rows if int(r["Adet"]) > 0]
    picked = rnd.sample(instock, BEKLEYEN_STOKTA)
    absent = ["TSL-0103", "TSL-0207", "TSL-0311", "TSL-0419", "TSL-0523"]  # depo_stok.csv'de yok (kodlar 1000+)
    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "Bekleyen"
    ws.append(["Ürün Kodu", "Ürün Adı", "Tedarikçi", "Sipariş Tarihi", "Miktar"])
    items = [(r["Kod"], r["Urun"]) for r in picked] + [(k, "Yedek parça") for k in absent]
    rnd.shuffle(items)
    for kod, ad in items:
        ws.append([kod, ad, rnd.choice(["Arena", "Index", "Penta"]), "2026-11-1" + str(rnd.randint(0, 9)), rnd.randint(1, 20)])
    os.makedirs(os.path.join(root, "servis"), exist_ok=True)
    wb.save(os.path.join(root, "servis", "bekleyen.xlsx"))
    return [(r["Kod"], int(r["Adet"])) for r in picked]


# OFFICE-1: bayi fiyat listesi düzenleme (biçim korunmalı). Gerçek listenin YAPISI
# (sayfa içinde tekrar eden kalın blok başlıkları, ara başlık, fiyatsız ürün, USD
# biçimi, renkli satır, geniş ürün sütunu, "Aratoptan" yazım farkı); fiyatlar sentetik.
# Satır: (ürün, dağıtıcı, bayi, aratoptan) · ("#H", grup) blok başlığı · ("#T", metin) ara başlık
FIYAT_SAYFALAR = [
    ("Masaüstü", "[$$-409]#,##0", "AraToptan", 82.0, [
        ("#H", "M.PClar"),
        ("QUADRO SOLID SGA61TR i3 8gb 256GB SSD Freedos", 163, 180, 166),
        ("QUADRO SOLID DHA-34825 i5 8gb 256GB SSD Freedos", 181, 199, 185),
        ("QUADRO SOLID DHA-41825 i3 8gb 256GB SSD Freedos", 293, 323, 305),
        ("#T", "M.PClar 7. Nesil"),
        ("QUADRO SOLID DHA-74825 i5 8gb 256gb SSD Freedos", 375, 413, 390),
        ("QUADRO SOLID DHA-74162 i5 16gb 256gb SSD Freedos", 491, 541, 510),
        (None,),
        ("#H", "M.PClar 14. Nesil"),
        ("QUADRO SOLID RHA-144165 i5 16gb 512GB SSD Freedos", 650, 715, 676),
        ("QUADRO SOLID 12484 i5 8gb 480gb SSD GT730 Freedos", None, None, None),
    ]),
    ("Notebook", "[$$-409]#,##0.0", "Aratoptan", 105.0, [
        ("#H", "Diamond Duo Serisi Çift Ekran Notebooklar"),
        ("QUADRO 16+14 Dokunmatik DS1630 i7 16gb 512gb SSD", 785, 864, 816),
        ("QUADRO 16+14 Dokunmatik DS3212N i7 32gb 1tb SSD", 570, 627, 592),
        (None,),
        ("#H", "12. Nesil 15.6 Notebooklar"),
        ("QUADRO XU16125 15.6 i5 8gb 256gb SSD Freedos", 432, 476, 450),
        ("QUADRO XU16127 15.6 i7 16gb 512gb SSD Freedos", None, None, None),
    ]),
]
FIYAT_RENKLI = ("Notebook", 3)  # sarı dolgulu ürün satırı (sayfa, satır)


def gen_fiyat_listesi(root: str) -> None:
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    wb = openpyxl.Workbook()
    first = wb.active
    assert first is not None
    wb.remove(first)
    for name, fmt, ara_baslik, a_width, rows in FIYAT_SAYFALAR:
        ws = wb.create_sheet(name)
        for col, width in zip("ABCD", (a_width, 13.3, 11.7, 10.6)):
            ws.column_dimensions[col].width = width
        for r, row in enumerate(rows, start=1):
            if row[0] is None:
                continue
            if row[0] == "#H":
                for c, v in enumerate((row[1], "Dağıtıcı", "Tavsiye Bayi", ara_baslik), start=1):
                    ws.cell(r, c, v).font = Font(bold=True)
            elif row[0] == "#T":
                ws.cell(r, 1, row[1]).font = Font(bold=True)
            else:
                ws.cell(r, 1, row[0])
                for c, v in enumerate(row[1:], start=2):
                    if v is not None:
                        ws.cell(r, c, v).number_format = fmt
        if name == FIYAT_RENKLI[0]:
            for c in range(1, 5):
                ws.cell(FIYAT_RENKLI[1], c).fill = PatternFill("solid", fgColor="FFFFFF00")
    os.makedirs(os.path.join(root, "fiyat"), exist_ok=True)
    wb.save(os.path.join(root, "fiyat", "Kasim_2026_Liste.xlsx"))


# OFFICE-1 O2: Word teklif mektubu (müşteri adı Word'deki gibi iki run'a bölünmüş).
TEKLIF_KALEMLER = [("Nova AIO 23.8 i5 16GB 512GB SSD", 10, 25000), ("Nova Notebook 15.6 i7 16GB 1TB", 5, 38000),
                   ("Kablosuz Klavye Mouse Seti", 15, 900)]


def tl(n: float) -> str:
    return f"{n:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def gen_teklif_docx(root: str) -> None:
    from docx import Document
    doc = Document()
    sec = doc.sections[0]
    sec.header.paragraphs[0].text = "TESLA TEKNOLOJİ - Teklif Belgesi"
    sec.footer.paragraphs[0].text = "Bu teklif 30 gün geçerlidir."
    doc.add_heading("FİYAT TEKLİFİ", level=1)
    p = doc.add_paragraph()
    p.add_run("Tarih: ")
    p.add_run("01.11.2026").bold = True
    p = doc.add_paragraph()
    p.add_run("Sayın ")
    p.add_run("XYZ Bil").bold = True
    p.add_run("gisayar Ltd. Şti.").bold = True
    doc.add_paragraph("Talep ettiğiniz ürünler için fiyat teklifimiz aşağıdadır.")
    t = doc.add_table(rows=1, cols=4)
    t.style = "Light Grid Accent 1"
    for c, h in zip(t.rows[0].cells, ("Ürün", "Adet", "Birim Fiyat (TL)", "Tutar (TL)")):
        c.text = h
    for ad, adet, fiyat in TEKLIF_KALEMLER:
        for c, v in zip(t.add_row().cells, (ad, str(adet), tl(fiyat), tl(adet * fiyat))):
            c.text = v
    son = t.add_row().cells
    son[0].text, son[3].text = "TOPLAM", tl(sum(a * f for _, a, f in TEKLIF_KALEMLER))
    doc.add_heading("Koşullar", level=2)
    doc.add_paragraph("Teslim süresi siparişten itibaren 15 iş günüdür.", style="List Bullet")
    doc.add_paragraph("Fiyatlara KDV dahil değildir.", style="List Bullet")
    doc.add_paragraph().add_run("Saygılarımızla,").italic = True
    os.makedirs(os.path.join(root, "teklif"), exist_ok=True)
    doc.save(os.path.join(root, "teklif", "teklif.docx"))


# OFFICE-1 O3: PDF sayfa işlemleri + damga (metin PDF, Türkçe karakterli).
def gen_sartname_pdf(root: str) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    pdfmetrics.registerFont(TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
    os.makedirs(os.path.join(root, "belgeler"), exist_ok=True)

    def make(path, pages):
        c = canvas.Canvas(path, pagesize=A4)
        for title, mark in pages:
            c.setFont("DejaVu", 16)
            c.drawString(72, 770, title)
            c.setFont("DejaVu", 11)
            c.drawString(72, 740, f"Sayfa işaretçisi: {mark}")
            c.drawString(72, 720, "Yüklenici, teknik şartnamedeki tüm gereksinimleri eksiksiz karşılayacaktır.")
            c.showPage()
        c.save()
    make(os.path.join(root, "belgeler", "sartname.pdf"), [(f"BÖLÜM {i}: Teknik Şartname", f"PDFMARK-{i}") for i in range(1, 7)])
    make(os.path.join(root, "belgeler", "ek.pdf"), [(f"EK-{i}: Garanti Taahhütnamesi", f"EKMARK-{i}") for i in (1, 2)])


# OFFICE-1 O4: ürün fotoğrafı (EXIF çekim tarihli) + logo.
URUN_FOTO_TARIH = "2026:10:21 14:32:05"


def gen_urun_foto(root: str) -> None:
    from PIL import Image, ImageDraw
    d = os.path.join(root, "urun_foto")
    os.makedirs(d, exist_ok=True)
    im = Image.new("RGB", (4000, 3000), (40, 60, 90))
    dr = ImageDraw.Draw(im)
    for i in range(0, 4000, 200):
        dr.rectangle([i, 0, i + 100, 3000], fill=(40 + i // 40, 70, 110))
    dr.ellipse([1200, 700, 2800, 2300], fill=(200, 200, 210))
    ex = Image.Exif()
    ex[0x010F] = "Sentetik"  # Make
    ex[0x0132] = URUN_FOTO_TARIH  # DateTime
    ex.get_ifd(0x8769)[0x9003] = URUN_FOTO_TARIH  # DateTimeOriginal
    im.save(os.path.join(d, "urun.jpg"), quality=92, exif=ex)
    logo = Image.new("RGBA", (400, 150), (0, 0, 0, 0))
    ImageDraw.Draw(logo).rectangle([0, 0, 399, 149], fill=(230, 20, 20, 255))
    logo.save(os.path.join(d, "logo.png"))


FOTO_GUNLER = [("2026:08:14", 4), ("2026:08:15", 3), ("2026:08:17", 2)]


def gen_fotolar(root: str) -> None:
    from PIL import Image
    rnd = random.Random(817)
    shots = []
    for day, n in FOTO_GUNLER:
        for k in range(n):
            shots.append(f"{day} {9 + 2 * k:02d}:{rnd.randint(0, 59):02d}:00")
    rnd.shuffle(shots)
    os.makedirs(os.path.join(root, "fotograflar"), exist_ok=True)
    for i, dt in enumerate(shots):
        im = Image.new("RGB", (320, 240), (rnd.randint(0, 255), rnd.randint(0, 255), rnd.randint(0, 255)))
        ex = Image.Exif()
        ex[0x0132] = dt  # DateTime
        ex[0x0110] = "Sentetik Kamera"  # Model
        im.save(os.path.join(root, "fotograflar", f"IMG_{4100 + i * 7}.jpg"), exif=ex)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Kullanım: gen_fixtures2.py <hedef_dizin>", file=sys.stderr)
        sys.exit(2)
    root = sys.argv[1]
    gen_plan(root)
    gen_kod(root)
    gen_html(root)
    for fn in (gen_ekran, gen_sartname_docx, gen_bekleyen, gen_fotolar, gen_fiyat_listesi,
               gen_teklif_docx, gen_sartname_pdf, gen_urun_foto):
        try:
            out = fn(root)
            if fn is gen_bekleyen:
                print("BEKLEYEN_STOKTA", out)
        except ImportError as e:  # paket yoksa o görev puanlanamaz, sınav sürer
            print(f"ATLANDI {fn.__name__}: {e}", file=sys.stderr)
    print(f"OK2 {root}")
