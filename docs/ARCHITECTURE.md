# claude-gemini-bridge — Mimari

> Kademeli geri takma (ARCH-0): bu doküman şimdilik yalnız model şeritleri ve
> denetim hattını kapsar. Diğer bölümler ilgili değişiklik geldikçe yazılır.

## Ürün

Claude Code CLI'ı Anthropic yerine Google Gemini (Live API) üzerinde çalıştıran
yerel köprü. Claude Code `ANTHROPIC_BASE_URL` ile köprüye bağlanır; köprü
Anthropic Messages API isteklerini Gemini'ye çevirir. Kimlik doğrulama, hesap
özellikleri (remote-control, schedule) köprünün kapsamı dışıdır.

## Model şeritleri (yerleşik yol)

| Şerit | Varsayılan model | Taşıma | Ne zaman |
|---|---|---|---|
| quality | `GEMINI_MODEL` (Live) | Live WS | gerçek turlar |
| fallback | `GEMINI_FALLBACK_MODEL` (2.5 native audio, 1M TPM) | Live WS | kota (1011) / boş tur |
| background | `LANE_BACKGROUND_MODEL` | Live WS | Claude Code'un "haiku" istekleri |
| longcontext | `LANE_LONGCONTEXT_MODEL` (3.1-flash-lite) | REST | Live'a sığmayan istekler |
| search | `GEMINI_SEARCH_MODEL` → `GEMINI_SEARCH_LIVE_MODEL` | REST → Live | sentetik `web_search` |
| **review** | `REVIEW_MODELS` (`claude:sonnet` → 3.8-live-extended-thinking → 3.8-live) | `claude -p` (kullanıcının Claude girişi) / Live WS | araç kullanılmış turun son cevabı — Live araç devamı ve REST/longcontext (ADR-0001) |

Yeni bir model görevi eklemek = bu tabloya satır + `config.ts` alanı +
kapatma anahtarı. Görev zorunluysa (köprü onsuz çalışamıyorsa)
`model-discovery.ts` gereksinimi de eklenir; isteğe bağlı görevler (denetçi)
açılışı engellemez, çalışma anında fail-open düşer. Her dış model çağrısı
fail-open olmalı (köprü cevabı asla denetçi/arama yüzünden düşmez).

## Denetim hattı (ADR-0001)

`server.ts handleToolResponseStreaming` → son metin tamponlanır →
`reviewer.ts runReview` → YOK yoksa taslak akar; varsa
`gemini-client.ts HeldSession.followUp` ile aynı Live oturumuna tek düzeltme turu.

## Köprünün Claude Code'a verdiği MCP sunucuları

`claude-args.ts bridgeMcpConfig` → tek `--mcp-config`:
- `chrome` — `claude --claude-in-chrome-mcp` (kullanıcının Chrome'u; `BRIDGE_CHROME_MCP=off`)
- `computer` — `dist/computer-use-mcp.js`, Gemini computer use (ADR-0003; `BRIDGE_COMPUTER_USE=off`)
- `office` — `dist/office-mcp.js` → `assets/office_tools.py` (docenv Python): `office_inspect` / `office_compare` (ADR-0004; `BRIDGE_OFFICE_MCP=off`; docenv kurulu değilse bağlanmaz)

Yeni sunucu = bu listeye satır + kapatma anahtarı + köprü talimatında kısa kullanım kuralı.

## Belge araç ortamı (ADR-0004)

Köprünün yönettiği tek kalıcı yerel kurulum: `~/.local/share/claude-gemini-bridge/docenv`
(`src/docenv.ts`, gereksinimler `DOCENV_REQUIREMENTS`, işaret dosyası `.bridge-docenv`).
Kurulum yalnız `claude-gemini --setup-docs` ile; açılış kurmaz, yalnız uyarır. Yeni belge
kütüphanesi = `DOCENV_REQUIREMENTS`'a sabit sürümle satır (işaret değişir → kullanıcıdan yeniden kurulum).

## Kararlar

- `docs/adr/0001-denetci.md` — Denetçi
- `docs/adr/0002-tablo-gorsel.md` — Büyük tablo araç sonuçları Live'a görsel sayfa (`TABLE_AS_IMAGE`)
- `docs/adr/0003-computer-use.md` — Masaüstü görevleri için Gemini computer use (`computer` MCP)
- `docs/adr/0004-belge-arac-ortami.md` — Belge düzenleme: docenv (sabit sürümlü venv, `--setup-docs`) + `office` MCP
