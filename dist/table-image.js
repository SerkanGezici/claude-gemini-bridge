// ADR-0002: büyük tablo araç sonuçları Live'a görsel sayfa olarak gider.
// Ölçüm (3.1-flash-live): görsel ~1.090 token/sayfa (çözünürlükten bağımsız);
// 18pt'de sayfa başına ~170 satır güvenli (24/24), daha yoğun sayfa doğruluğu düşürür.
import { PassThrough } from 'stream';
import { join } from 'path';
import * as PImage from 'pureimage';
import { PROJECT_ROOT } from './paths.js';
import { logger } from './logger.js';
export const TABLE_IMAGE_MIN_CHARS = 8_000;
const MIN_ROWS = 20;
const ROWS_PER_PAGE = 170;
const CHARS_PER_PAGE = 6_500;
const MAX_LINE_CHARS = 110;
export const MAX_PAGES = 12; // sayfa ~720KB JPEG (q85; q60'ta doğruluk 20/24'e düştü) → mesaj ≤ ~11MB
const HEAD_LINES = 30;
const FONT_PX = 18;
const LINE_PX = 24;
const FONT_FAMILY = 'BridgeMono';
const DELIMITERS = [',', '\t', '|', ';'];
/** Satırların ≥%80'i aynı (≥1) ayraç sayısına sahipse tablo sayılır. */
export function isTabular(text) {
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length < MIN_ROWS)
        return false;
    for (const d of DELIMITERS) {
        const counts = new Map();
        for (const l of lines) {
            const c = l.split(d).length - 1;
            if (c > 0)
                counts.set(c, (counts.get(c) ?? 0) + 1);
        }
        const top = Math.max(0, ...counts.values());
        if (top / lines.length >= 0.8)
            return true;
    }
    return false;
}
export function shouldRenderAsImage(text) {
    return text.length >= TABLE_IMAGE_MIN_CHARS && isTabular(text);
}
/** Satırları sayfalara böler: başlık her sayfada tekrar eder; uzun satır kırpılır. */
export function paginate(text) {
    const lines = text.split('\n').filter((l) => l.trim()).map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS - 1)}…` : l));
    const [header, ...rows] = lines;
    const pages = [];
    let cur = [];
    let chars = 0;
    for (const r of rows) {
        if (cur.length >= ROWS_PER_PAGE || chars + r.length > CHARS_PER_PAGE) {
            pages.push([header, ...cur]);
            cur = [];
            chars = 0;
            if (pages.length >= MAX_PAGES)
                break;
        }
        cur.push(r);
        chars += r.length;
    }
    if (cur.length && pages.length < MAX_PAGES)
        pages.push([header, ...cur]);
    const shown = pages.reduce((n, p) => n + p.length - 1, 0);
    return { pages, truncatedRows: rows.length - shown };
}
let fontReady = null;
function loadFont() {
    fontReady ??= PImage.registerFont(join(PROJECT_ROOT, 'assets', 'fonts', 'DejaVuSansMono.ttf'), FONT_FAMILY).load();
    return fontReady;
}
/** Bir sayfayı kareye yakın sütunlara dizip JPEG (base64) üretir — RGBA PNG ~940KB, JPEG çok daha küçük. */
export async function renderPage(lines) {
    await loadFont();
    const widest = Math.max(...lines.map((l) => l.length));
    const colW = Math.ceil(widest * FONT_PX * 0.61) + 30;
    const cols = Math.max(1, Math.round(Math.sqrt((lines.length * LINE_PX) / colW)));
    const perCol = Math.ceil(lines.length / cols);
    const img = PImage.make(cols * colW + 20, perCol * LINE_PX + 24);
    const ctx = img.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.fillStyle = '#000000';
    ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
    lines.forEach((l, k) => {
        const col = Math.floor(k / perCol);
        const row = k % perCol;
        ctx.fillText(l, 12 + col * colW, 12 + (row + 1) * LINE_PX - 6);
    });
    const out = new PassThrough();
    const chunks = [];
    out.on('data', (c) => chunks.push(c));
    await PImage.encodeJPEGToStream(img, out, 85);
    return Buffer.concat(chunks).toString('base64');
}
/**
 * Tablo metnini "baş + not" metni ve sayfa görsellerine çevirir. Tablo değilse
 * ya da render hata verirse null (çağıran metin yoluna döner — fail-open).
 */
export async function tableToImages(text) {
    if (!shouldRenderAsImage(text))
        return null;
    try {
        const t0 = Date.now();
        const { pages, truncatedRows } = paginate(text);
        const images = [];
        for (const p of pages)
            images.push({ inlineData: { mimeType: 'image/jpeg', data: await renderPage(p) } });
        const head = text.split('\n').slice(0, HEAD_LINES).join('\n');
        const total = text.split('\n').filter((l) => l.trim()).length;
        const note = `[Tablo ${total} satır. İlk ${HEAD_LINES} satır aşağıda metin; TAMAMI ${pages.length} sayfa görsel olarak ekte ` +
            `(her sayfada başlık satırı tekrar eder). Değerleri görsellerden oku.` +
            (truncatedRows > 0 ? ` Son ${truncatedRows} satır sayfa sınırı nedeniyle eklenmedi.` : '') + ']';
        logger.info(`Tablo görsele çevrildi: ${total} satır → ${pages.length} sayfa (${Date.now() - t0}ms)`);
        return { text: `${note}\n${head}`, images };
    }
    catch (err) {
        logger.warn(`Tablo görsele çevrilemedi — metin gidiyor: ${err.message}`);
        return null;
    }
}
