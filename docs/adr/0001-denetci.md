# ADR-0001 — Denetçi: araç kullanılan turlarda son cevabı ikinci bir modelle denetle

- Durum: Kabul edildi (2026-11-25, Serkan: "devam et bitir, senle %100 aynı olması hedefimiz")
- Bağlam: ORCH-1 (PLANS/ACTIVE_PLAN.md), ORCH-0 sınav seti

## Bağlam

Köprü tek bir Live modeliyle (3.1-flash-live) çalışıyor. ORCH-0 temel ölçümünde
Claude'a göre en büyük kayıp **eksik kapsam**: ihale şartnamesi analizinde model
dosyayı okudu ama %6 kesin teminat, binde 3 gecikme cezası ve 3 yıl garanti
maddelerini atladı (W10 %57). Claude aynı işte bunları buluyor çünkü cevabı
vermeden önce kendi işini kontrol ediyor.

Çevrimdışı deney (aynı taslak + şartname):
- `gemini-3.1-flash-lite` / `3.5-flash-lite` (REST): eksik taslağa "tamam" dedi; 503 aldı.
- `gemini-3.8-live`, serbest "eksik var mı": "TAMAM" (kaçırdı).
- "Her önemli maddeyi say, VAR/YOK işaretle" yönergesiyle `3.8-live` ve
  `3.8-live-extended-thinking` (thinkingLevel HIGH) kaçan maddelerin hepsini buldu;
  tam cevapta extended-thinking hiç YOK üretmedi (yanlış alarm yok).

## Karar

Persistent session'da **araç sonucundan sonra gelen son metin cevabı** (tool call
içermeyen) kullanıcıya akıtılmadan tamponlanır ve bir **denetçi** Live modeline
gönderilir: kullanıcının isteği + bu turda toplanan kanıt (tool çağrıları ve
sonuçları) + taslak. Denetçi "MADDE … | YOK", "İSTEK … | YOK", "ÇELİŞKİ: …"
satırları döndürür.

- YOK/ÇELİŞKİ yoksa taslak aynen gönderilir.
- Varsa Live oturumu kapatılmaz; aynı oturuma tek bir gizli kullanıcı turu
  ("denetim notu: şunları eksiksiz ekleyerek nihai cevabı yeniden yaz")
  gönderilir ve modelin yeni çıktısı (metin ya da yeni tool call) normal akışla
  Claude Code'a gider. **En fazla 1 düzeltme turu.**
- Denetçi sırası (2026-11-25 güncellemesi, Serkan kararı "Claude denetlesin"):
  **`claude:sonnet`** → `gemini-3.8-live-extended-thinking` (HIGH) →
  `gemini-3.8-live`. Claude denetçi, kullanıcının kendi Claude Code girişiyle
  (OAuth abonelik) araçsız/eklentisiz tek bir `claude -p` çağrısıdır; Claude
  çağrılamazsa (giriş yok, kota) Gemini Live denetçilere düşülür.
  Gerekçe: aynı Excel taslağında ("maaş bilgisi dosyada yok", yalnız ilk sayfa
  okunmuş) Gemini denetçi "temiz" dedi; Sonnet 5,2 sn'de "diğer sayfalara bak"
  diye doğru ARAŞTIRMA maddesi üretti.
- **Fail-open:** denetçi hata/zaman aşımı/boş çıktı verirse taslak aynen gider.
- **Çelişkide kanıttan düzeltme (AUDIO-NUM-1, 2026-11-26, Serkan onayı):** Live ses
  modeli bazı turlarda değeri yanlış söylüyor (4173 → 4117; aynı ses üç yazıya dökme
  modelinde de 4117). Denetçi bir ÇELİŞKİ (taslak ↔ kanıt) bulursa Gemini düzeltme
  turu yerine düzeltilmiş cevabı Claude kanıttan yazar (~2sn; canlı 3/3 doğru).
  Yalnız eksik madde varsa Gemini turu sürer; Claude çağrılamazsa Gemini turuna düşülür.
- **REST/longcontext şeridi (REVIEW-REST-1):** açık oturum olmadığından düzeltme,
  taslak + denetim notu geçmişe eklenip aynı REST modeliyle bir kez daha üretilerek
  yapılır. Claude Code'un özetleme (compact) istekleri denetlenmez.
- **Denetçi çıktısı:** önce istekte sorulan her madde için "SORU: … | VAR/YOK"
  satırı, sonra sorun satırları. Açık madde listesi, "sessizce kontrol et"
  talimatının rastgele kaçırmasını kapattı (12/12 ölçüm, REVIEW-REL-1).
- Sohbet ve hızlı bilgi turları (araç sonucu yok) denetlenmez → gecikme yok.
- Kapatma anahtarı: `REVIEW=off`. Model listesi: `REVIEW_MODELS`.

## Sonuçlar

- Artı: kapsam eksiklerini yakalar; ana model değişmeden kalite artar; ek maliyet
  yalnız iş turlarında.
- Eksi: denetlenen turda son cevap akış hâlinde değil tek parça gelir
  (+5-20 sn). Düzeltme turu modelin cevabı yeniden yazmasını gerektirir.
- Eksi: her iş turu 1 Claude çağrısı (abonelik kotası). İstek + araç kanıtı
  (dosya içerikleri, en fazla 120K karakter) Anthropic'e gider — normal Claude
  Code kullanımıyla aynı veri sınıfı. Köprü artık "Anthropic'siz" değildir;
  tamamen Gemini isteyen `REVIEW_MODELS` listesinden `claude:sonnet`'i çıkarır.
- Risk: yanlış alarm gereksiz düzeltme turu doğurur; denetçi talimatı "isteğin
  ötesinde iş isteme" der, etkisi ORCH-0 setiyle ölçülür.
- Kapsam dışı (sonraki ADR'ler): Şef (seviye sınıflaması), Planlayıcı,
  Kütüphaneci, non-streaming ve tam-replay Live yolları.
