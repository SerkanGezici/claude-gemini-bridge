// CU-1 (ADR-0003): computer use yardımcıları ve görev döngüsü. Gerçek ekran,
// pwsh ve Gemini çağrılmaz — bağımlılıklar sahte.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  denormalize, escapeSendKeys, toSendKeys, mapCall, actionScript, pruneScreens, runComputerTask,
  type DesktopAction, type TaskDeps,
} from '../../src/computer-use.js';
import { resetConfig } from '../../src/config.js';

beforeEach(() => { process.env['GEMINI_API_KEY'] = 'test-key'; resetConfig(); });

describe('yardımcılar', () => {
  it('denormalize: 0-999 → piksel, sınırda kalır', () => {
    expect(denormalize(500, 1920)).toBe(960);
    expect(denormalize(999, 1200)).toBe(1199);
    expect(denormalize(2000, 100)).toBe(99);
  });

  it('escapeSendKeys: özel karakterler kaçar, satır sonu ENTER olur', () => {
    expect(escapeSendKeys('a+b (c) %50 ~{x}')).toBe('a{+}b {(}c{)} {%}50 {~}{{}x{}}');
    expect(escapeSendKeys('Kopru\ntesti')).toBe('Kopru{ENTER}testi');
  });

  it('toSendKeys: kombinasyonlar', () => {
    expect(toSendKeys('Control+S')).toBe('^s');
    expect(toSendKeys(['alt', 'F4'])).toBe('%{F4}');
    expect(toSendKeys('ctrl+shift+t')).toBe('^+t');
    expect(toSendKeys('Enter')).toBe('{ENTER}');
    expect(() => toSendKeys('meta+r')).toThrow();
  });

  it('mapCall: 2.5 ve 3.5 adları, desteklenmeyen tarayıcı eylemi hata', () => {
    expect(mapCall('click', { x: 356, y: 263 }, 1280, 800)).toEqual({ kind: 'click', x: 456, y: 210 });
    expect(mapCall('type_text_at', { x: 500, y: 500, text: 'hi', press_enter: true }, 1000, 1000))
      .toEqual({ kind: 'type', text: 'hi', x: 500, y: 500, enter: true, clear: false });
    expect(mapCall('type', { text: 'x' }, 10, 10)).toEqual({ kind: 'type', text: 'x', enter: false, clear: false });
    expect(mapCall('key_combination', { keys: 'Control+W' }, 1, 1)).toEqual({ kind: 'keys', sendKeys: '^w' });
    expect(mapCall('hotkey', { keys: ['ctrl', 'a'] }, 1, 1)).toEqual({ kind: 'keys', sendKeys: '^a' });
    expect(mapCall('scroll_document', { direction: 'up' }, 1, 1)).toEqual({ kind: 'scroll', delta: 3 });
    expect('error' in mapCall('navigate', { url: 'x' }, 1, 1)).toBe(true);
  });

  it('actionScript: tek tırnak kaçar, çift tık iki kez', () => {
    expect(actionScript({ kind: 'type', text: "it's" })).toContain("'it''s'");
    expect(actionScript({ kind: 'click', x: 1, y: 2, double: true })).toBe("Clk 1 2 'left' 2");
  });

  it('pruneScreens: yalnız son 3 yanıt görüntüsü kalır', () => {
    const img = (): Record<string, unknown> => ({ functionResponse: { name: 'c', response: {}, parts: [{ inlineData: {} }] } });
    const contents = Array.from({ length: 5 }, () => ({ role: 'user', parts: [img()] }));
    pruneScreens(contents);
    const kept = contents.map((c) => ((c.parts[0]!['functionResponse'] as { parts: unknown[] }).parts.length));
    expect(kept).toEqual([0, 0, 1, 1, 1]);
  });
});

describe('runComputerTask', () => {
  const screen = { jpegBase64: 'SU1H', width: 1000, height: 1000 };
  function deps(replies: Array<Array<Record<string, unknown>>>): TaskDeps & { acts: DesktopAction[]; reqs: number } {
    const d = {
      acts: [] as DesktopAction[], reqs: 0,
      capture: async () => screen,
      act: async (a: DesktopAction) => { d.acts.push(a); },
      generate: async () => ({ candidates: [{ content: { parts: replies[d.reqs++] ?? [{ text: 'bitti' }] } }] }),
    };
    return d;
  }

  it('eylemleri uygular, model metinle bitirince özet döner', async () => {
    const d = deps([
      [{ functionCall: { name: 'click', args: { x: 100, y: 200 }, id: '1' } }],
      [{ functionCall: { name: 'type', args: { text: 'Test 42' }, id: '2' } }],
      [{ text: 'Yazıldı.' }],
    ]);
    const r = await runComputerTask('yaz', 10, d);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('Yazıldı.');
    expect(d.acts).toEqual([{ kind: 'click', x: 100, y: 200 }, { kind: 'type', text: 'Test 42', enter: false, clear: false }]);
    expect(r.steps).toHaveLength(2);
  });

  it('safety_decision require_confirmation → eylem yapmadan durur', async () => {
    const d = deps([[{ functionCall: { name: 'click', args: { x: 1, y: 1, safety_decision: { decision: 'require_confirmation', explanation: 'satın alma' } } } }]]);
    const r = await runComputerTask('öde', 5, d);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('satın alma');
    expect(d.acts).toHaveLength(0);
  });

  it('desteklenmeyen eylem modele hata olarak döner, döngü sürer; adım sınırı', async () => {
    const loop = Array.from({ length: 30 }, () => [{ functionCall: { name: 'navigate', args: { url: 'x' } } }]);
    const d = deps(loop);
    const r = await runComputerTask('git', 3, d);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Adım sınırı');
    expect(d.reqs).toBe(3);
    expect(d.acts).toHaveLength(0);
  });

  it('süre bütçesi dolunca kısmi sonuçla döner (köprü araç zaman aşımından önce)', async () => {
    const d = deps(Array.from({ length: 5 }, () => [{ functionCall: { name: 'click', args: { x: 1, y: 1 } } }]));
    const r = await runComputerTask('uzun', 5, d, -1);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Süre bütçesi');
    expect(d.reqs).toBe(0);
  });

  it('görev bitince (hata olsa da) close çağrılır — kalıcı pwsh süreci kalmaz', async () => {
    let closed = 0;
    const d = { ...deps([[{ text: 'tamam' }]]), close: () => { closed++; } };
    await runComputerTask('x', 3, d);
    const bad = { ...deps([]), generate: async () => { throw new Error('kota'); }, close: () => { closed++; } };
    await expect(runComputerTask('x', 3, bad)).rejects.toThrow('kota');
    expect(closed).toBe(2);
  });
});
