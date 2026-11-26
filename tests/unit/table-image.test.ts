import { describe, it, expect } from 'vitest';
import { isTabular, shouldRenderAsImage, paginate, tableToImages, MAX_PAGES, TABLE_IMAGE_MIN_CHARS } from '../../src/table-image.js';

const csv = (n: number, w = 1): string =>
  ['Kod,Ürün,Adet,Fiyat,Raf', ...Array.from({ length: n }, (_, i) => `TSL-${1000 + i},Ürün ${i}${'x'.repeat(w)},${i},${(i * 1.5).toFixed(2)},A-${i % 40}`)].join('\n');

describe('ADR-0002 tablo tespiti', () => {
  it('ayraçlı satırlar tablo; düz yazı ve kod değil', () => {
    expect(isTabular(csv(50))).toBe(true);
    expect(isTabular(Array.from({ length: 50 }, (_, i) => `a\t${i}\tb`).join('\n'))).toBe(true);
    expect(isTabular(Array.from({ length: 50 }, (_, i) => `Bu bir cümle ${i}, ama tablo değil ve ${i % 3 ? 'virgül' : ''} sayısı değişir, değişir, değişir.`.slice(0, 20 + (i % 7) * 9)).join('\n'))).toBe(false);
    expect(isTabular('function f() {\n  return 1;\n}\n'.repeat(20))).toBe(false);
  });
  it('küçük tablo görsele çevrilmez', () => {
    const small = csv(30);
    expect(small.length).toBeLessThan(TABLE_IMAGE_MIN_CHARS);
    expect(shouldRenderAsImage(small)).toBe(false);
    expect(shouldRenderAsImage(csv(400))).toBe(true);
  });
});

describe('paginate', () => {
  it('her sayfada başlık tekrar eder, ≤170 satır', () => {
    const { pages, truncatedRows } = paginate(csv(500));
    expect(pages.length).toBe(3);
    for (const p of pages) { expect(p[0]).toBe('Kod,Ürün,Adet,Fiyat,Raf'); expect(p.length).toBeLessThanOrEqual(171); }
    expect(truncatedRows).toBe(0);
  });
  it('sayfa sınırını aşan satırlar sayılır', () => {
    const { pages, truncatedRows } = paginate(csv(170 * MAX_PAGES + 100));
    expect(pages.length).toBe(MAX_PAGES);
    expect(truncatedRows).toBe(100);
  });
});

describe('tableToImages', () => {
  it('JPEG sayfa + baş metni ve not üretir', async () => {
    const r = await tableToImages(csv(400));
    expect(r).not.toBeNull();
    expect(r!.images.length).toBe(3);
    const jpg = Buffer.from(r!.images[0]!.inlineData.data, 'base64');
    expect(jpg[0]).toBe(0xff); expect(jpg[1]).toBe(0xd8);
    expect(r!.text).toContain('3 sayfa görsel');
    expect(r!.text).toContain('TSL-1000');
  }, 60_000);
  it('tablo değilse null', async () => {
    expect(await tableToImages('kısa metin')).toBeNull();
  });
});
