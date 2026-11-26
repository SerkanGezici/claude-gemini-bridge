# ADR-0002 — Büyük tablo araç sonuçlarını Live'a görsel sayfa olarak ver

- Durum: Kabul edildi (2026-11-25, Serkan: seçenek A "pureimage + font")
- Bağlam: IMG-TOK-1 (PLANS/ACTIVE_PLAN.md), Serkan önerisi "gerekirse JPG verebiliriz"

## Bağlam

Live'a giden canlı araç sonucu 32K karakterde kesilir (CAP-1) ve her token dakikalık
kotaya (3.1-flash-live ≈ 150-230K TPM, ölçüldü) sayılır. ERP SQL çıktısı, Excel/CSV
dökümü gibi büyük tablolar hem kesiliyor hem kotayı hızla tüketiyor.

Ölçüm (3.1-flash-live, usageMetadata + doğruluk, 2026-11-25):

| İçerik | Metin token | Görsel token | Doğruluk (görsel) |
|---|---|---|---|
| 200 satır tablo, tek görsel 18pt | 6.705 | 1.089 | 24/24 |
| 200 satır, 14pt / 11pt | 6.705 | 1.088 | 23/24 |
| 500 satır, tek görsel 18pt | 16.293 | 1.085 | 17/24 ✗ |
| 500 satır, 3 sayfa × ~170 satır 18pt | 16.293 | 3.270 | 24/24 (2/2 koşu) |

Görsel maliyeti çözünürlükten bağımsız ~1.090 token/görsel; güvenli kapasite ~170-200
satır (~6-7K karakter) / sayfa, 18pt. Görseller TPM'e SAYILIYOR (A/B: muaf değil).

## Karar (önerilen)

Live yolunda (araç devamı + replay) bir araç sonucu **tablo biçimindeyse** (satırların
çoğu aynı ayraç sayısına sahip: `,` `\t` `|`) ve **≥ 8K karakter** ise:
- ilk ~30 satır metin olarak kalır (başlık + örnek, birebir kopyalanabilir),
- tamamı ~170 satırlık sayfalar hâlinde PNG olarak `functionResponse.parts[].inlineData`
  ile gider (GAP-VISION-1 yolu), metinde "tam tablo N sayfa görsel olarak ekte" notu.
Kod/Read çıktısı, düz yazı ve küçük sonuçlar etkilenmez (Edit birebir metin ister).
Kapatma anahtarı `TABLE_AS_IMAGE=off`; hata olursa metin yolu (fail-open).

## Render seçenekleri

| Seçenek | Artı | Eksi |
|---|---|---|
| A. `pureimage` (saf JS, MIT; pngjs/jpeg-js/opentype.js) + repoya DejaVu Sans Mono (serbest lisans) | Native derleme yok, her kurulumda çalışır | 4 yeni bağımlılık (+~1MB), font dosyası repoda |
| B. `python3` + Pillow alt süreci | Yeni npm bağımlılığı yok | Kullanıcı makinesinde Python+Pillow şart; yoksa özellik sessizce kapalı |
| C. Yapma | Sıfır risk | Büyük tablolar kesilmeye ve kotayı tüketmeye devam eder |

## Uygulama (2026-11-25)

`src/table-image.ts` + `server.buildGeminiToolResponsesWithTables` (Live araç devamı;
replay yolu kapsam dışı). JPEG q85 (q60'ta doğruluk 20/24'e düştü; q85 23-24/24),
sayfa ~720KB, en fazla 12 sayfa (~2.000 satır), render ~0,6-0,8 sn/sayfa (saf JS).
Sınav W12 (1.500 satırlık CSV, 32K ötesi satırlar): görselli %100/35sn (model dosyayı
Read ile okudu → 10 sayfa), görselsiz %100/27-30sn (model Python betiği yazdı), Claude %100/14sn.

## Sonuçlar

- Artı: büyük tabloda ~%80 daha az token, 32K kesmesi olmadan tam veri.
- Eksi: görselden okuma hatası riski (14pt'de 23/24); kod/kimlik birebir kopyası gereken
  yerde kullanılmaz. Sınava büyük-tablo görevi eklenir (W12) ve görselli/görselsiz karşılaştırılır.
