// ADR-0001: Claude denetçi (`claude -p`) — süreç taklit edilir, gerçek CLI çalışmaz.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mockSpawn }));

import { claudeCritic, defaultCritic, disposeClaudeCritic } from '../../src/reviewer.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter; stderr: EventEmitter;
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}
function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = Object.assign(new EventEmitter(), { end: vi.fn(), write: vi.fn() });
  c.kill = vi.fn();
  return c;
}

beforeEach(() => { disposeClaudeCritic(); mockSpawn.mockReset(); });

const resultLine = (text: string, isError = false): Buffer =>
  Buffer.from(JSON.stringify({ type: 'result', result: text, is_error: isError }) + '\n');

describe('claudeCritic', () => {
  it('köprü env\'ini temizler, araçsız/eklentisiz çağırır, prompt stdin\'den gider', async () => {
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:8002';
    process.env['ANTHROPIC_API_KEY'] = 'bridge-token';
    const child = fakeChild();
    mockSpawn.mockImplementation(() => (mockSpawn.mock.calls.length === 1 ? child : fakeChild()));
    const p = claudeCritic('sonnet', 'PROMPT');
    child.stdout.emit('data', Buffer.from('{"type":"system"}\n'));
    child.stdout.emit('data', resultLine('MADDE: x | YOK'));
    expect(await p).toBe('MADDE: x | YOK');
    const [cmd, args, opts] = mockSpawn.mock.calls[0]!;
    expect(cmd).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'sonnet', '--tools', '', '--setting-sources', '', '--no-session-persistence', '--input-format', 'stream-json']));
    expect(opts.env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(opts.env['ANTHROPIC_API_KEY']).toBeUndefined();
    const sent = JSON.parse(String(child.stdin.write.mock.calls[0]![0]));
    expect(sent).toEqual({ type: 'user', message: { role: 'user', content: 'PROMPT' } });
    // denetim bitince sıradaki için yedek süreç açıldı
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    delete process.env['ANTHROPIC_BASE_URL'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('süreç sonuç vermeden çıkarsa → reject (zincir sonraki denetçiye geçer)', async () => {
    const child = fakeChild();
    mockSpawn.mockImplementation(() => (mockSpawn.mock.calls.length === 1 ? child : fakeChild()));
    const p = claudeCritic('sonnet', 'x');
    child.stderr.emit('data', Buffer.from('Not logged in'));
    child.emit('exit', 1);
    await expect(p).rejects.toThrow(/exit=1.*Not logged in/);
  });

  it('is_error sonucu → reject', async () => {
    const child = fakeChild();
    mockSpawn.mockImplementation(() => (mockSpawn.mock.calls.length === 1 ? child : fakeChild()));
    const p = claudeCritic('sonnet', 'x');
    child.stdout.emit('data', resultLine('usage limit', true));
    await expect(p).rejects.toThrow(/usage limit/);
  });

  it('önceden açılmış yedek süreç kullanılır (yeni spawn yok)', async () => {
    const { prewarmClaudeCritic } = await import('../../src/reviewer.js');
    const warm = fakeChild();
    mockSpawn.mockImplementation(() => (mockSpawn.mock.calls.length === 1 ? warm : fakeChild()));
    prewarmClaudeCritic('sonnet');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const p = claudeCritic('sonnet', 'x');
    expect(warm.stdin.write).toHaveBeenCalled(); // ılık süreç tüketildi
    warm.stdout.emit('data', resultLine('TAMAM'));
    expect(await p).toBe('TAMAM');
  });

  it('defaultCritic "claude:" önekini CLI\'ye yönlendirir', async () => {
    const child = fakeChild();
    mockSpawn.mockImplementation(() => (mockSpawn.mock.calls.length === 1 ? child : fakeChild()));
    const p = defaultCritic('claude:sonnet', 'x');
    child.stdout.emit('data', resultLine('TAMAM'));
    await p;
    expect(mockSpawn.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--model', 'sonnet']));
  });
});
