#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ClaudeCLILive — canlı yetenek testi (tmux E2E) için zengin fixture üretici.

Üretilenler: TXT, CSV, JSON, Word(.docx), Excel(.xlsx, formüllü+2 sheet),
PDF(metin katmanlı), PDF(taranmış/görüntü = OCR şart), JPG(metinli = OCR),
kasıtlı bug'lı kod (Python + JS).

Kullanım:  python3 _generate_fixtures.py
Bağımlılıklar: python-docx, openpyxl, reportlab, Pillow (hepsi mevcut ortamda var).
"""
import json
import csv
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from docx import Document
from openpyxl import Workbook
from openpyxl.styles import Font as XLFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import cm

ROOT = Path(__file__).resolve().parent
BELGE = ROOT / "belgeler"
KOD = ROOT / "kod"
for d in (BELGE, KOD):
    d.mkdir(parents=True, exist_ok=True)

FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def font(size, bold=False):
    p = FONT_PATHS[1] if bold else FONT_PATHS[0]
    try:
        return ImageFont.truetype(p, size)
    except Exception:
        return ImageFont.load_default()


def gen_text_files():
    (BELGE / "notlar.txt").write_text(
        "TOPLANTI NOTLARI — 18 Haziran 2026\n"
        "================================\n\n"
        "Katılımcılar: Deniz, Ayşe, Mehmet, Zeynep\n\n"
        "Gündem:\n"
        "1. Q3 bütçe revizyonu (öncelik: yüksek)\n"
        "2. Yeni işe alım — 2 backend, 1 tasarımcı\n"
        "3. Müşteri şikayetleri azaldı (geçen aya göre %32)\n\n"
        "Kararlar:\n"
        "- Bütçe onayı 25 Haziran'a ertelendi.\n"
        "- İşe alım ilanları bu hafta yayınlanacak.\n"
        "- Gizli kod: PELIKAN-77\n",
        encoding="utf-8")

    with open(BELGE / "satislar.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Ay", "Bolge", "Urun", "Adet", "BirimFiyat", "Ciro"])
        for r in [
            ["Ocak", "Marmara", "Laptop", 12, 18500, 222000],
            ["Ocak", "Ege", "Telefon", 45, 9200, 414000],
            ["Subat", "Marmara", "Laptop", 9, 18500, 166500],
            ["Subat", "Ic Anadolu", "Tablet", 30, 6400, 192000],
            ["Mart", "Ege", "Telefon", 60, 9200, 552000],
            ["Mart", "Marmara", "Tablet", 22, 6400, 140800],
        ]:
            w.writerow(r)

    (BELGE / "config.json").write_text(json.dumps({
        "appName": "DemoPanel", "version": "1.4.0", "debug": False,
        "maxConnections": 100,
        "features": {"darkMode": True, "betaSearch": False, "export": ["pdf", "xlsx"]},
        "owner": {"name": "Deniz Aksoy", "email": "owner@example.com"},
    }, ensure_ascii=False, indent=2), encoding="utf-8")


def gen_docx():
    doc = Document()
    doc.add_heading("Proje Teklifi: Akıllı Stok Yönetimi", level=0)
    doc.add_paragraph("Hazırlayan: Deniz Aksoy · Tarih: 18.06.2026")
    doc.add_heading("1. Özet", level=1)
    doc.add_paragraph(
        "Bu teklif, deponun gerçek zamanlı stok takibi için bir yazılım çözümü önermektedir. "
        "Mevcut sistemde stok sayımı elle yapılmakta ve aylık ortalama 14 saat kaybedilmektedir.")
    doc.add_heading("2. Bütçe Tablosu", level=1)
    t = doc.add_table(rows=1, cols=3)
    t.style = "Light Grid Accent 1"
    hdr = t.rows[0].cells
    hdr[0].text, hdr[1].text, hdr[2].text = "Kalem", "Maliyet (TL)", "Süre (gün)"
    for kalem, mal, sure in [("Analiz", "40.000", "10"), ("Geliştirme", "180.000", "45"),
                             ("Test", "35.000", "15"), ("Eğitim", "20.000", "5")]:
        c = t.add_row().cells
        c[0].text, c[1].text, c[2].text = kalem, mal, sure
    doc.add_heading("3. Sonuç", level=1)
    doc.add_paragraph("Toplam bütçe 275.000 TL, tahmini süre 75 gündür. Onayınızı bekliyoruz.")
    doc.save(str(BELGE / "proje_teklifi.docx"))


def gen_xlsx():
    wb = Workbook()
    ws = wb.active
    ws.title = "Butce"
    ws.append(["Departman", "Ocak", "Subat", "Mart", "Toplam"])
    for c in ws[1]:
        c.font = XLFont(bold=True)
    data = [
        ["Yazilim", 120000, 125000, 130000],
        ["Pazarlama", 80000, 95000, 70000],
        ["Operasyon", 60000, 62000, 64000],
        ["IK", 30000, 30000, 35000],
    ]
    for i, row in enumerate(data, start=2):
        ws.append(row)
        ws[f"E{i}"] = f"=SUM(B{i}:D{i})"
    ws.append(["GENEL TOPLAM", "=SUM(B2:B5)", "=SUM(C2:C5)", "=SUM(D2:D5)", "=SUM(E2:E5)"])
    ws2 = wb.create_sheet("Calisanlar")
    ws2.append(["Ad", "Departman", "Maas", "BaslangicYili"])
    for r in [["Ayşe Yılmaz", "Yazilim", 85000, 2021], ["Mehmet Kaya", "Pazarlama", 72000, 2019],
              ["Zeynep Demir", "Operasyon", 68000, 2022], ["Can Öztürk", "Yazilim", 91000, 2018]]:
        ws2.append(r)
    wb.save(str(BELGE / "butce_2026.xlsx"))


def gen_text_pdf():
    c = canvas.Canvas(str(BELGE / "sozlesme.pdf"), pagesize=A4)
    width, height = A4
    c.setFont("Helvetica-Bold", 16)
    c.drawString(2 * cm, height - 2 * cm, "HIZMET SOZLESMESI")
    c.setFont("Helvetica", 11)
    lines = [
        "Madde 1 - Taraflar: Ornek Yazilim A.S. (Saglayici) ve Demo Medya Ltd. (Musteri).",
        "Madde 2 - Konu: Yazilim bakim ve destek hizmetleri.",
        "Madde 3 - Sure: Sozlesme 12 ay gecerlidir, 01.07.2026 tarihinde baslar.",
        "Madde 4 - Bedel: Aylik 15.000 TL + KDV. Odeme her ayin 5'inde yapilir.",
        "Madde 5 - Gizlilik: Taraflar ticari sirlari ucuncu kisilerle paylasmaz.",
        "Madde 6 - Fesih: 30 gun onceden yazili bildirim ile feshedilebilir.",
        "Referans No: SOZ-2026-0042",
    ]
    y = height - 3.2 * cm
    for ln in lines:
        c.drawString(2 * cm, y, ln)
        y -= 0.9 * cm
    c.showPage()
    c.save()


def gen_ocr_jpg():
    img = Image.new("RGB", (900, 560), "white")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 899, 90], fill=(30, 90, 160))
    d.text((30, 28), "T.C. ORNEK BELEDIYESI - SU FATURASI", font=font(28, bold=True), fill="white")
    for i, ln in enumerate([
        "Abone No   : 4471-2208", "Ad Soyad   : DENIZ AKSOY", "Donem      : Mayis 2026",
        "Tuketim    : 14 m3", "Tutar      : 287,50 TL", "Son Odeme  : 30.06.2026",
    ]):
        d.text((30, 130 + i * 45), ln, font=font(24), fill="black")
    d.text((30, 430), "Onay Kodu: ZUMRUT-2026", font=font(22, bold=True), fill=(160, 30, 30))
    img.save(str(BELGE / "su_faturasi.jpg"), quality=92)


def gen_vision_png():
    """GAP-VISION-1 regresyon fixture'ı: METİNSİZ saf şekil görseli.
    OCR boş döner → modelin doğru tarif etmesi YALNIZ native vision ile mümkün.
    Beklenen tarif: kırmızı daire (sol üst) + mavi dikdörtgen (sağ) + yeşil ters üçgen (alt)."""
    img = Image.new("RGB", (400, 300), "white")
    d = ImageDraw.Draw(img)
    d.ellipse([40, 40, 160, 160], fill=(220, 30, 30))          # kırmızı daire (sol üst)
    d.rectangle([220, 70, 360, 210], fill=(30, 60, 200))        # mavi dikdörtgen (sağ)
    d.polygon([(120, 230), (280, 230), (200, 295)], fill=(30, 160, 60))  # yeşil ters üçgen (alt)
    img.save(str(BELGE / "gorsel_test.png"))


def gen_scanned_pdf():
    scan = Image.new("RGB", (1000, 700), "white")
    ds = ImageDraw.Draw(scan)
    ds.text((50, 40), "DEKONT — PARA TRANSFERI", font=font(34, bold=True), fill="black")
    ds.line([(50, 95), (950, 95)], fill="black", width=2)
    for i, (k, v) in enumerate([
        ("Gonderen", "DEMO MEDYA LTD"), ("Alici", "ORNEK YAZILIM A.S."),
        ("IBAN", "TR12 0006 4000 0011 2233 4455 66"), ("Tutar", "45.000,00 TL"),
        ("Aciklama", "Temmuz bakim bedeli"), ("Islem No", "DKT-9988776655"),
        ("Tarih", "18.06.2026 14:32"),
    ]):
        ds.text((50, 140 + i * 70), f"{k}:", font=font(26, bold=True), fill="black")
        ds.text((360, 140 + i * 70), v, font=font(26), fill=(20, 20, 20))
    # Görüntüyü doğrudan PDF kaydet → text katmanı OLMAZ (gerçek tarama gibi → OCR şart)
    scan.save(str(BELGE / "dekont_tarama.pdf"), "PDF", resolution=150.0)


def gen_code():
    (KOD / "istatistik.py").write_text(
        '#!/usr/bin/env python3\n'
        '"""Basit istatistik araclari (icinde KASITLI hatalar var)."""\n\n\n'
        'def ortalama(sayilar):\n'
        '    toplam = 0\n'
        '    for s in sayilar:\n'
        '        toplam += s\n'
        '    # BUG: her zaman 3\'e boluyor, gercek eleman sayisina degil\n'
        '    return toplam / 3\n\n\n'
        'def en_buyuk(sayilar):\n'
        '    enb = 0  # BUG: negatif sayilarda yanlis (0 ile basliyor)\n'
        '    for s in sayilar:\n'
        '        if s > enb:\n'
        '            enb = s\n'
        '    return enb\n\n\n'
        'def bol(a, b):\n'
        '    return a / b  # BUG: b=0 kontrolu yok\n\n\n'
        'if __name__ == "__main__":\n'
        '    veri = [10, 20, 30, 40]\n'
        '    print("Ortalama:", ortalama(veri))   # dogru: 25.0\n'
        '    print("En buyuk:", en_buyuk(veri))   # dogru: 40\n',
        encoding="utf-8")

    (KOD / "sepet.js").write_text(
        '// Alisveris sepeti — refactor edilebilir (var, ==, manuel dongu)\n'
        'function toplamHesapla(urunler) {\n'
        '  var toplam = 0;\n'
        '  for (var i = 0; i < urunler.length; i++) {\n'
        '    toplam = toplam + urunler[i].fiyat * urunler[i].adet;\n'
        '  }\n'
        '  return toplam;\n'
        '}\n\n'
        'function indirimUygula(toplam, kupon) {\n'
        '  if (kupon == "INDIRIM10") {\n'
        '    return toplam - toplam * 0.10;\n'
        '  }\n'
        '  if (kupon == "INDIRIM20") {\n'
        '    return toplam - toplam * 0.20;\n'
        '  }\n'
        '  return toplam;\n'
        '}\n\n'
        'var sepet = [\n'
        '  { ad: "Kalem", fiyat: 15, adet: 3 },\n'
        '  { ad: "Defter", fiyat: 40, adet: 2 },\n'
        '];\n'
        'console.log("Toplam:", toplamHesapla(sepet));\n',
        encoding="utf-8")

    (KOD / "README.md").write_text(
        "# Mini Araçlar\n\n"
        "Test amaçlı küçük kod parçaları.\n\n"
        "- `istatistik.py` — ortalama/en büyük/bölme (içinde KASITLI hatalar var)\n"
        "- `sepet.js` — alışveriş sepeti hesaplama (refactor adayı)\n",
        encoding="utf-8")


def main():
    gen_text_files()
    gen_docx()
    gen_xlsx()
    gen_text_pdf()
    gen_ocr_jpg()
    gen_vision_png()
    gen_scanned_pdf()
    gen_code()
    print("OK — fixtures üretildi:")
    for p in sorted(ROOT.rglob("*")):
        if p.is_file() and p.name != Path(__file__).name:
            print(f"  {p.relative_to(ROOT)}  ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
