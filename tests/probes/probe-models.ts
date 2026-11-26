// API key'in erişebildiği Live API (bidiGenerateContent) modellerini listeler.
// Kullanım: npx tsx tests/probe-models.ts
import 'dotenv/config';

const key = process.env['GEMINI_API_KEY']?.trim();
if (!key) { console.error('GEMINI_API_KEY yok'); process.exit(1); }

interface Model {
  name: string;
  supportedGenerationMethods?: string[];
}

let pageToken = '';
const liveModels: string[] = [];
do {
  // Key URL'de DEĞİL header'da — query string log/proxy geçmişine sızabilir.
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
  const res = await fetch(url, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`); process.exit(1); }
  const data = (await res.json()) as { models?: Model[]; nextPageToken?: string };
  for (const m of data.models ?? []) {
    if (m.supportedGenerationMethods?.includes('bidiGenerateContent')) {
      liveModels.push(m.name);
    }
  }
  pageToken = data.nextPageToken ?? '';
} while (pageToken);

console.log('Live API (bidiGenerateContent) destekli modeller:');
for (const m of liveModels) console.log(' ', m);
