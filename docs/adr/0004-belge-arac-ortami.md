# ADR-0004 — Belge düzenleme için sabit araç ortamı (docenv) ve `office` MCP sunucusu

- Durum: Kabul edildi (2026-11-26, Serkan: "ADR-0004'ün tamamı")
- Bağlam: OFFICE-1 (PLANS/ACTIVE_PLAN.md), sınav görevleri O1-O4

## Bağlam

Serkan'ın şartı: PDF, Word, Excel ve fotoğraf düzenleme köprüde güvenilir çalışmalı.
Fiyat listesi isteğinde (O1) köprü biçimi silip blok başlıklarını atladı; aynı görevde
Claude biçimi korudu. Kök sebepler iki katmanlı:

1. **Davranış:** Gemini dosyayı incelemeden dönüştürme betiği yazıyor, değerlerden
   yeniden kuruyor, sonucu karşılaştırmadan "korundu" diyor. Davranış katmanına
   `OFFICE_EDIT_PROMPT` eklendi (yerleşik yol; ölçüm O1'de).
2. **Ortam:** modeller betikleri `python3 -I` ile çalıştırıyor (Claude Code'un "indirilen
   dosyayı -I ile oku" kuralı genelleniyor). `-I` kullanıcı dizinindeki kütüphaneleri gizler:

   | Kütüphane | `python3 -I` (sistem) | `~/.local` |
   |---|---|---|
   | openpyxl | 3.1.2 — `writer/excel.py:292` tarihi `+00:00Z` yazar, Excel "onarım" sorar | 3.1.5 |
   | python-docx, python-pptx | yok | var |
   | pypdf / PyMuPDF | yok | yalnız pypdfium2 |

   Güncelleme (2026-11-26 14:06-14:08): köprü O2-O4 sınavının ilk koşusunda RECOVER-1 kuralıyla
   `python3-docx`, `python3-pypdf`, `fonts-dejavu` paketlerini `sudo apt` ile kurdu; Word/PDF
   bu makinede artık `-I` ile de çalışıyor (O2/O3 köprüde 2/2 %100). openpyxl hatası apt ile
   düzelmez (Ubuntu paketi 3.1.2). Yeni/başka makinede aynı kurulum dolambacı tekrar eder.

   Sonuç (ilk durum): Excel çıktısı her seferinde onarım uyarısı verir (Claude da aynı hatayı
   üretti), Word/PDF düzenlemesi `pip install` → "externally-managed-environment" →
   `sudo apt` dolambacına düşer. Talimat bunu çözemez.

Ek olarak denetçi (ADR-0001) yalnız kanıtla iddiayı karşılaştırır; biçim kaybını
gösteren bir karşılaştırma çıktısı kanıtta yoksa "biçim korundu" yalanını yakalayamaz.

## Karar

1. **docenv:** köprünün yönettiği venv `~/.local/share/claude-gemini-bridge/docenv`
   (sabit sürümler: openpyxl 3.1.5, python-docx, python-pptx, pypdf, pymupdf, pillow).
   `claude-gemini --setup-docs` kurar; açılışta yoksa tek satır uyarı basar (açılışı
   engellemez). `-I` ile de çalışır (venv site-packages kullanıcı dizini değildir).
   Ölçüm: kurulum 30 sn, ~350 MB.
2. **`office` MCP sunucusu** (ARCHITECTURE "MCP sunucuları" yerleşik yolu; kapatma
   `BRIDGE_OFFICE_MCP=off`), docenv ile çalışan iki belirleyici araç:
   - `office_inspect(path)` → yapı raporu (Excel: her sayfa/satır sınıfı, blok başlıkları,
     sayı biçimleri, kalın/renk, genişlik, birleşik hücre, formül; Word: stiller, tablolar,
     üst/alt bilgi; PDF: sayfa sayısı, metin/taranmış, boyut; görsel: boyut, EXIF).
   - `office_compare(original, edited)` → hücre/paragraf/sayfa düzeyinde değer + biçim farkı.
   Araç çıktıları transkripte girer → denetçi biçim kaybını kanıttan görür.
3. **Talimat:** belge betiklerini `docenv/bin/python` ile çalıştır; düzenlemeden önce
   `office_inspect`, kaydettikten sonra `office_compare`; raporda karşılaştırma sonucu.

## Alternatifler

- Sistem geneline `sudo pip install --break-system-packages …` — hızlı ama sistem
  Python'unu değiştirir, başka makineye taşınmaz, sürümler sabitlenmez.
- Yalnız talimat — ortam hatalarını çözmez; Gemini'nin talimat disiplini zayıf (xlsx
  skill'i aynı kuralı söylüyordu, yüklemedi).
- Excel COM / LibreOffice ile düzenleme — en yüksek biçim sadakati, ama Windows'a bağlı
  ya da ağır; betik üretimi Gemini için daha hataya açık. İleride yalnız Excel için ek
  motor olarak değerlendirilebilir.

## Ölçüm (2026-11-26, OFFICE_EDIT_PROMPT ile)

| Görev | Köprü önce | Köprü protokollü | Claude |
|---|---|---|---|
| O1 Excel fiyat listesi | %27 (2/2) | %82 (82/91/73) | %100 |
| O2 Word teklif | — | %100 (2/2) | %100 |
| O3 PDF sayfa + damga | — | %100 (2/2) | %100 |
| O4 Fotoğraf + logo | — | %100 (2/2) | %100 |

O1'de kalan hatalar belirleyici analiz/karşılaştırma eksikliği: sonraki blok başlıklarını
atlama, taşınan hücrede para birimi biçimini kaybetme, başlıkları yeniden adlandırma, dolgu kaybı.

## Uygulama notu — analiz ve karşılaştırma zorunlu (2026-11-26)

docenv + `office` MCP ile O1 hâlâ %79'du (64/100/73). Kayıtlar: araçları kullanan koşu 11/11;
kullanmayan koşu kendi betiğiyle yalnız ilk 10 satırı okudu (7/11) — `office_compare` o çıktıdaki
12 sorunun hepsini yakalıyordu. Sorun araç değil, Gemini'nin aracı seçmemesi. Bu yüzden köprü,
`--settings` katmanında docenv hazırken iki Claude Code hook'u verir (`assets/office_hook.py`):

- `UserPromptSubmit`: istekte geçen var olan belge yollarını bulur, `office_inspect` raporunu
  modelin bağlamına ekler (≤15k karakter), orijinalin kopyasını geçici dizine saklar.
- `Stop`: istekten sonra yazılmış aynı türde belge varsa saklanan orijinalle karşılaştırır;
  SORUN satırı varsa `decision: block` ile turu kapatmaz (istek başına en fazla 2 kez,
  sonra bırakır). Hata yolunda fail-open.

Kullanıcının kendi hook'ları ayrı ayar katmanında kalır; köprü yalnız bu iki komutu ekler.
`BRIDGE_OFFICE_MCP=off` sunucuyu, talimatı ve hook'ları birlikte kapatır.

## Sonuç ölçümü (2026-11-26, hook'lar + review düzeltmeleri)

| Görev | Yalnız talimat | + docenv/MCP | + zorunlu hook'lar | Son (temiz) | Claude |
|---|---|---|---|---|---|
| O1 Excel | %82 | %79 | %88 → %94 | **%97** (100/91/100) | %100 |
| O2 Word / O3 PDF / O4 foto | %100 | %100 | %100 | %100 (9/9) | %100 |

O1'de kalan tek kayıp yuvarlama aritmetiği (574,07 → 569; 4 haneli sonucu kural dışı bırakma);
biçim/yapı kontrolleri son 6 koşunun hepsinde geçti. Kabul ölçütü karşılandı.

## Kabul ölçütü

Sınav O1-O4 her biri köprüde 3 koşuda ortalama ≥ %95, Excel çıktısı onarım uyarısı yok.
