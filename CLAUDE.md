# claude-gemini-bridge — proje kuralları

Ürün: Claude Code CLI'ı Anthropic yerine Google Gemini (Live API) üzerinde çalıştıran yerel köprü.
Değildir: hesap özelliği sağlayıcısı (remote-control, schedule), genel amaçlı Gemini istemcisi.

## Mimari
- Kararlar ve yerleşik yollar: `docs/ARCHITECTURE.md`, `docs/adr/`. Yeni kalıcı durum, dış servis,
  config anahtarı ya da MCP sunucusu eklemeden önce oradaki yolu kullan; yoksa ADR taslağı yaz ve sor.
- Mimari kapı: `npm run arch` (`tools/arch-guard.py`, kurallar `docs/arch-rules.json`, baseline
  `docs/arch-baseline.json`). "Bitti"nin parçasıdır; baseline yalnız azalır, kuralı/baseline'ı gevşetmek
  Serkan kararı + ADR ister.
- Ortam değişkeni yalnız `src/config.ts`'te okunur; `@google/genai` yalnız `gemini-client.ts`/`reviewer.ts`.

## Doğrulama
- `npm run typecheck` · `npx vitest run --maxWorkers=4` (/mnt/c'de daha fazla işçi hook zaman aşımı verir)
  · `npm run build` (dist/ commit'lidir; CI drift kontrolü yapar) · `npm run arch`.
- Davranış değişikliği canlı da doğrulanır: `npm run eval -- --target bridge [--only ...] [--repeat N]`.
  Kabuktaki GEMINI_API_KEY geçersiz olabilir: `env -u GEMINI_API_KEY -u GKEY` ile köprünün kayıtlı anahtarı.
- İş takibi: `PLANS/ACTIVE_PLAN.md` (tek master plan).
