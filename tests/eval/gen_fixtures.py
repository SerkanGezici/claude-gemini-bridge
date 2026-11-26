#!/usr/bin/env python3
"""ORCH-0 sınav seti için deterministik fixture üretici (yalnız stdlib).

Üretir (hedef dizine):
  erp/erp.db         — ERP benzeri SQLite (stok + satis; iptal ve iade satırları tuzak)
  ihale/sartname.txt — tuzaklı ihale şartnamesi (kritik maddeler metnin derinlerinde)

Kullanım: python3 gen_fixtures.py <hedef_dizin>
Canlı ERP'ye HİÇ dokunmaz; veri tamamen sentetiktir.
"""
import os
import random
import sqlite3
import sys

STOKLAR = [
    ("NB-001", "Dizüstü Bilgisayar 15.6 i5", "Bilgisayar", 28500),
    ("NB-002", "Dizüstü Bilgisayar 14 i7", "Bilgisayar", 41200),
    ("PC-010", "Masaüstü Bilgisayar i5 Kasa", "Bilgisayar", 23900),
    ("MN-024", "Monitör 24 inç IPS", "Çevre Birimi", 4650),
    ("MN-027", "Monitör 27 inç QHD", "Çevre Birimi", 8900),
    ("SSD-1T", "SSD 1 TB NVMe", "Depolama", 2750),
    ("SSD-2T", "SSD 2 TB NVMe", "Depolama", 4900),
    ("RAM-16", "RAM 16 GB DDR5", "Bellek", 1850),
    ("RAM-32", "RAM 32 GB DDR5", "Bellek", 3600),
    ("YZ-LZR", "Lazer Yazıcı Mono", "Yazıcı", 6300),
    ("KB-MS", "Klavye Mouse Set", "Çevre Birimi", 690),
    ("UPS-1K", "UPS 1000 VA", "Güç", 5400),
]
MUSTERILER = ["Ankara Belediyesi", "Ege Lojistik", "Marmara Hastanesi", "Delta Servis", "Kuzey İnşaat", "Bireysel"]


def gen_erp(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.remove(path)
    rnd = random.Random(42)
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE stok (
          stok_kodu TEXT PRIMARY KEY,
          stok_adi  TEXT NOT NULL,
          kategori  TEXT NOT NULL,
          liste_fiyati REAL NOT NULL
        );
        CREATE TABLE satis (
          id INTEGER PRIMARY KEY,
          tarih TEXT NOT NULL,          -- YYYY-MM-DD
          stok_kodu TEXT NOT NULL REFERENCES stok(stok_kodu),
          musteri TEXT NOT NULL,
          miktar INTEGER NOT NULL,      -- iade satırlarında NEGATİF
          birim_fiyat REAL NOT NULL,
          durum TEXT NOT NULL           -- 'ONAYLI' | 'IPTAL'
        );
        """
    )
    db.executemany("INSERT INTO stok VALUES (?,?,?,?)", STOKLAR)
    sid = 0
    for ay in (8, 9, 10, 11):
        for gun in range(1, 29):
            for _ in range(rnd.randint(1, 4)):
                kod, _ad, _kat, fiyat = rnd.choice(STOKLAR)
                miktar = rnd.randint(1, 6)
                bf = round(fiyat * rnd.uniform(0.92, 1.05), 2)
                durum = "IPTAL" if rnd.random() < 0.08 else "ONAYLI"
                sid += 1
                db.execute(
                    "INSERT INTO satis VALUES (?,?,?,?,?,?,?)",
                    (sid, f"2026-{ay:02d}-{gun:02d}", kod, rnd.choice(MUSTERILER), miktar, bf, durum),
                )
    # Tuzaklar (Ekim 2026): büyük IPTAL satışı + iade. İptal hariç tutulmazsa
    # sıralama değişir; iade düşülmezse ciro şişer.
    tuzaklar = [
        ("2026-10-15", "MN-027", "Ankara Belediyesi", 60, 8900.0, "IPTAL"),
        ("2026-10-20", "NB-002", "Ege Lojistik", -4, 41200.0, "ONAYLI"),
    ]
    for t in tuzaklar:
        sid += 1
        db.execute("INSERT INTO satis VALUES (?,?,?,?,?,?,?)", (sid, *t))
    db.commit()
    db.close()


SARTNAME = """T.C. ÖRNEK İL ÖZEL İDARESİ
BİLGİ İŞLEM DONANIM ALIMI — TEKNİK VE İDARİ ŞARTNAME
İhale Kayıt No: 2026/884211

1. İŞİN KONUSU
1.1. İdarenin birimlerinde kullanılmak üzere 120 adet masaüstü bilgisayar, 40 adet dizüstü
bilgisayar, 60 adet 24 inç monitör ve 15 adet mono lazer yazıcı alımı işidir.
1.2. Teklifler kısmi teklife kapalıdır; tüm kalemler için teklif verilmesi zorunludur.

2. TEKLİF VE TEMİNAT
2.1. Geçici teminat, teklif edilen bedelin %3'ünden az olamaz.
2.2. İhale üzerinde kalan istekliden sözleşme bedelinin %6'sı oranında kesin teminat alınır.
2.3. Tekliflerin geçerlilik süresi ihale tarihinden itibaren 90 takvim günüdür.
2.4. Benzer iş olarak kabul edilecek işler: bilgisayar ve çevre birimleri satışı. İş deneyim
belgesinin tutarı teklif bedelinin %25'inden az olmamalıdır.

3. TEKNİK ÖZELLİKLER (ÖZET)
3.1. Masaüstü bilgisayarlar en az 6 çekirdekli işlemci, 16 GB DDR5 bellek ve 512 GB NVMe SSD
içermelidir.
3.2. Dizüstü bilgisayarlar en az 14 inç ekran, 16 GB bellek ve 512 GB SSD içermelidir.
3.3. Tüm cihazlar için üretici yetkili servis belgesi teklif ekinde sunulacaktır.
3.4. Monitörler en az 24 inç IPS panel olacak, yükseklik ayarlı ayağa sahip olacaktır.

4. TESLİMAT
4.1. Teslim süresi sözleşmenin imzalanmasından itibaren 30 takvim günüdür.
4.2. Kurulum, montaj ve mevcut ağa bağlantı yüklenici tarafından yapılacaktır.
4.3. Malzemeler, İdarenin İstanbul, Ankara ve İzmir illerindeki toplam 42 ayrı hizmet
noktasına, her noktadaki ilgili birime ayrı ayrı, yüklenici tarafından teslim edilecek ve
kurulacaktır; nakliye, sigorta ve kurulum giderleri teklif fiyatına dahildir.

5. GARANTİ VE SERVİS
5.1. Tüm cihazlar en az 3 yıl (36 ay) yerinde garantili olacaktır.
5.2. Arıza bildirimine en geç 4 saat içinde yerinde müdahale edilecek, arıza 2 iş günü içinde
giderilemezse aynı veya üstün özellikte yedek cihaz bırakılacaktır.

6. CEZAİ HÜKÜMLER
6.1. Teslimatta gecikilen her takvim günü için sözleşme bedelinin binde 3'ü oranında gecikme
cezası uygulanır. Gecikme 20 günü aşarsa İdare sözleşmeyi feshedebilir ve kesin teminat gelir
kaydedilir.
6.2. Garanti süresince müdahale süresinin aşıldığı her olay için sözleşme bedelinin binde 1'i
oranında ceza uygulanır.

7. YERLİ MALI
7.1. Yerli malı teklif eden istekliler lehine %15 oranında fiyat avantajı uygulanacaktır.
7.2. Yerli malı belgesi teklif ekinde sunulmalıdır.

8. DİĞER HUSUSLAR
8.1. Sözleşme bedeli Türk Lirası olarak sabittir; döviz kurundaki değişimler nedeniyle
yükleniciye fiyat farkı verilmeyecektir.
8.2. Ödeme, kabul işlemlerinin tamamlanmasını müteakip 60 gün içinde yapılır.
8.3. Anlaşmazlıklarda Ankara Mahkemeleri ve İcra Daireleri yetkilidir.
"""


def gen_sartname(path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(SARTNAME)


# W12 (ADR-0002): 1500 satırlık depo CSV'si (~60K kr) — Live'ın 32K metin
# kesmesinin ötesinde kalan satırlar sorulur. Sorulan satırlar sabit.
W12_ROWS = {
    120: ("TSL-4417", 233, "C-12"),
    690: ("TSL-5082", 71, "H-3"),
    980: ("TSL-6630", 418, "K-27"),
    1250: ("TSL-7194", 902, "B-36"),
    1395: ("TSL-8851", 15, "E-8"),
    1480: ("TSL-9963", 644, "A-40"),
}


def gen_depo_stok(path: str) -> None:
    import random as _r
    rnd = _r.Random(1500)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    names = ["SSD 1TB NVMe", "DDR5 32GB", "RTX 5070", "Anakart B850", "Kasa ATX", "PSU 850W",
             "Monitor 27", "Klavye Mek", "Mouse Kbl", "Switch 24p", "UPS 1500VA", "NAS 4-bay"]
    used = {v[0] for v in W12_ROWS.values()}
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("Kod,Urun,Adet,BirimFiyat,Raf\n")
        for i in range(1500):
            if i in W12_ROWS:
                kod, adet, raf = W12_ROWS[i]
            else:
                while True:
                    kod = f"TSL-{rnd.randint(1000, 9999)}"
                    if kod not in used:
                        break
                adet, raf = rnd.randint(1, 950), f"{rnd.choice('ABCDEFGHK')}-{rnd.randint(1, 40)}"
            used.add(kod)
            f.write(f"{kod},{rnd.choice(names)},{adet},{rnd.uniform(150, 48000):.2f},{raf}\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Kullanım: gen_fixtures.py <hedef_dizin>", file=sys.stderr)
        sys.exit(2)
    root = sys.argv[1]
    gen_erp(os.path.join(root, "erp", "erp.db"))
    gen_sartname(os.path.join(root, "ihale", "sartname.txt"))
    gen_depo_stok(os.path.join(root, "depo", "depo_stok.csv"))
    print(f"OK {root}")
