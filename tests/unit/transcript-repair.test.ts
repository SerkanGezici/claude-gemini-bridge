import { describe, it, expect, beforeEach } from 'vitest';
import { isTranscriptTruncated, pcmToWav, remainderAfter, transcribeAudio, BYTES_PER_SEC } from '../../src/transcript-repair.js';
import { resetConfig } from '../../src/config.js';

beforeEach(() => {
  process.env['GEMINI_API_KEY'] = 'test-key';
  delete process.env['TRANSCRIPT_REPAIR_MODELS'];
  resetConfig();
});

describe('TRANSCRIPT-1 kesik döküm tespiti', () => {
  it('canlı vaka: 8,3sn seste 17 karakter kesik; normal oran kesik değil', () => {
    expect(isTranscriptTruncated(8.3 * BYTES_PER_SEC, 17)).toBe(true);
    expect(isTranscriptTruncated(7.2 * BYTES_PER_SEC, 70)).toBe(false);
  });
  it('kısa seste (<2sn) karar verilmez', () => {
    expect(isTranscriptTruncated(1.5 * BYTES_PER_SEC, 2)).toBe(false);
  });
});

describe('remainderAfter', () => {
  it('akıtılmış önekten sonrasını döner (noktalama/harf büyüklüğü farkı önemsiz)', () => {
    expect(remainderAfter('Depodaki TSL-8842', 'Depodaki TSL 8842 ürününden 4173 adet var.')).toBe(' ürününden 4173 adet var.');
    expect(remainderAfter('İstanbul', 'istanbul deposunda 5 adet.')).toBe(' deposunda 5 adet.');
  });
  it('canlı vaka: yazıya dökme farkları (TCL/Depoda ki) aynı önek sayılır', () => {
    expect(remainderAfter('Depodaki TSL-8842', 'Depoda ki TCL 8842 ürün koduna ait 4.173 adet var.')).toBe(' ürün koduna ait 4.173 adet var.');
  });

  it('önek uyuşmazsa tam metin yeni paragraf olarak', () => {
    expect(remainderAfter('Merhaba', 'TSL-8842 stokta 4173 adet.')).toBe('\n\nTSL-8842 stokta 4173 adet.');
  });
  it('hiç döküm yoksa tam metin', () => {
    expect(remainderAfter('', ' 4173 adet. ')).toBe('4173 adet.');
  });
});

describe('pcmToWav', () => {
  it('44 baytlık RIFF/WAVE başlığı, 24kHz mono 16-bit', () => {
    const wav = pcmToWav(Buffer.alloc(480));
    expect(wav.length).toBe(524);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(40)).toBe(480);
  });
});

describe('transcribeAudio zinciri (fail-open)', () => {
  it('ilk model hata verirse sonrakine geçer', async () => {
    const seen: string[] = [];
    const out = await transcribeAudio(Buffer.alloc(100), '', async (m) => { seen.push(m); if (seen.length === 1) throw new Error('503'); return 'tam metin'; });
    expect(out).toBe('tam metin');
    expect(seen).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
  });
  it('hepsi başarısızsa null; off ise hiç denemez', async () => {
    expect(await transcribeAudio(Buffer.alloc(10), '', async () => { throw new Error('x'); })).toBeNull();
    process.env['TRANSCRIPT_REPAIR_MODELS'] = 'off'; resetConfig();
    let called = false;
    expect(await transcribeAudio(Buffer.alloc(10), '', async () => { called = true; return 'x'; })).toBeNull();
    expect(called).toBe(false);
  });
});
