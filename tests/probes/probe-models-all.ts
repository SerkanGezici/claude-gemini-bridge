// audio/dialog/live içeren TÜM modelleri destekledikleri metodlarla listeler.
// Kullanım: npx tsx tests/probe-models-all.ts
import 'dotenv/config';

const key = process.env['GEMINI_API_KEY']?.trim();
if (!key) { console.error('GEMINI_API_KEY yok'); process.exit(1); }

interface Model { name: string; supportedGenerationMethods?: string[] }

let pageToken = '';
const found: string[] = [];
do {
  // Key URL'de DEĞİL header'da — query string log/proxy geçmişine sızabilir.
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
  const res = await fetch(url, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
  const data = (await res.json()) as { models?: Model[]; nextPageToken?: string };
  for (const m of data.models ?? []) {
    const n = m.name.toLowerCase();
    if (n.includes('dialog') || n.includes('audio') || n.includes('live')) {
      found.push(`${m.name}  →  [${(m.supportedGenerationMethods ?? []).join(', ')}]`);
    }
  }
  pageToken = data.nextPageToken ?? '';
} while (pageToken);

console.log(found.join('\n') || 'eşleşme yok');
