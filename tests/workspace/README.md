# tests/workspace — Canlı Yetenek Test Ortamı

`claude-gemini` köprüsünün **gerçek dosya işleme yeteneklerini** uçtan uca test etmek için
zengin bir fixture seti. 2026-06-18'de TOOL-GUARD-1'i ortaya çıkaran tmux E2E kampanyasında
kullanıldı (bkz. `PLANS/ACTIVE_PLAN.md`).

## Nasıl kullanılır

```bash
cd tests/workspace
claude-gemini          # köprü oturumunu BU dizinde aç (PATHS-1)
# sonra dosyalar üzerinde okuma/analiz/düzenleme görevleri ver
```

Fixture'ları yeniden üretmek / güncellemek için:

```bash
python3 _generate_fixtures.py
```

## İçerik ve ground-truth (test cevaplarını doğrulamak için gizli değerler)

| Dosya | Tip | Ground-truth |
|---|---|---|
| `belgeler/notlar.txt` | metin | gizli kod **PELIKAN-77**, %32 azalma, bütçe 25 Haziran'a ertelendi |
| `belgeler/satislar.csv` | CSV | en yüksek ciro **Mart-Ege-Telefon 552.000**, toplam **1.687.300** |
| `belgeler/config.json` | JSON | version 1.4.0, betaSearch false (düzenleme hedefi) |
| `belgeler/proje_teklifi.docx` | Word | toplam **275.000 TL**, 75 gün, en pahalı Geliştirme 180.000 |
| `belgeler/butce_2026.xlsx` | Excel (formüllü, 2 sheet) | genel toplam **901.000**, en yüksek dep. Yazılım **375.000**, en yüksek maaş Can Öztürk **91.000** |
| `belgeler/sozlesme.pdf` | metin-PDF | Ref **SOZ-2026-0042**, aylık 15.000 TL, 12 ay |
| `belgeler/dekont_tarama.pdf` | **taranmış PDF → OCR şart** | İşlem **DKT-9988776655**, 45.000,00 TL, IBAN TR12 0006 4000 0011 2233 4455 66 |
| `belgeler/su_faturasi.jpg` | **JPG → OCR** | Abone **4471-2208**, 14 m³, 287,50 TL, onay **ZUMRUT-2026** |
| `kod/istatistik.py` | Python | 3 kasıtlı bug: ortalama `/3`, en_buyuk `0`-init (negatifte hatalı), bol sıfır-kontrolsüz |
| `kod/sepet.js` | JS | refactor adayı (var→const, ==→===, döngü→reduce); doğru toplam **125** |

> Not: testler sırasında `config.json` (→1.5.0) ve `kod/` dosyaları değişmiş olabilir;
> orijinal hâle döndürmek için `python3 _generate_fixtures.py` çalıştır.
