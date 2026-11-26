# ADR-0003 — Masaüstü görevleri için Gemini computer use (`computer` MCP sunucusu)

- Durum: Kabul edildi (2026-11-26, Serkan: "Masaüstü tıklama yazma ve Computer_use'un köprüye bağlanmasını onaylıyorum")
- Bağlam: DESKTOP-1, CU-1 (PLANS/ACTIVE_PLAN.md)

## Bağlam

Anthropic computer use Windows'ta yalnız Claude Desktop'a gömülü; Claude Code CLI'daki
sunucu yalnız macOS. Köprüde masaüstü için windows-mcp var ama görsel, çok adımlı GUI
işinde konum bulmak zor. Gemini'de computer use aracı (`tools: [{computerUse}]`)
`gemini-3.5-flash-lite`'ta ücretsiz katmanda açık (2.5-computer-use modelinin kotası 0;
3.1-flash-lite "not enabled"). Sentetik form ekranında 5/5 eylem doğru hedefe düştü.

## Karar

Paketle gelen bağımlılıksız stdio MCP sunucusu `computer` (`dist/computer-use-mcp.js`),
tek araç `computer_task(goal, max_steps)`. `buildClaudeArgs` onu Chrome sunucusuyla aynı
`--mcp-config` içinde verir (yalnız Windows/WSL; kapatma `BRIDGE_COMPUTER_USE=off`).
Döngü (`src/computer-use.ts`): birincil monitör görüntüsü (pwsh, JPEG) →
`COMPUTER_USE_MODEL` (varsayılan `gemini-3.5-flash-lite`) → eylem (pwsh: SetCursorPos/
mouse_event/SendKeys) → yeni görüntü; model metinle bitirince özet + son görüntü döner.

Neden köprü içi sentetik araç (web_search gibi) değil: eylemler kullanıcının gerçek
masaüstünde; MCP aracı olunca Claude Code transkriptinde görünür, kullanıcı hook'ları
ve izinleri uygulanır.

Güvenlik/sınırlar: en fazla 25 adım (varsayılan 12), 150 sn bütçe (köprünün 180 sn araç
zaman aşımından önce kısmi sonuçla döner), modelin `safety_decision: require_confirmation`
kararında eylem yapmadan durur, tarayıcı gezinme eylemleri desteklenmez (hata olarak
modele döner), sistem talimatı ilgisiz pencerelere dokunmayı ve parola/ödeme girmeyi yasaklar.

## Sonuçlar

- Artı: Windows'ta görsel masaüstü işi köprüde mümkün; ek bağımlılık yok.
- Eksi: ekran görüntüleri Gemini'ye (ücretsiz katman: içerik ürün geliştirmede
  kullanılabilir) gider — Serkan onayladı. Her pwsh çağrısı ~1,3 sn (soğuk başlangıç);
  tipik görev 1-2 dk. Yalnız birincil monitör.
- Ölçüm (2026-11-26): doğrudan 58 sn / 6 eylem PASS; köprü uçtan uca 132 sn PASS
  (Not Defteri'nde metni değiştir + kaydet, diskten doğrulandı).
