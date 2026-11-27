// LIVE-22 regresyon testi — npm start gerçek bypass ile başlatır.
// RECOVER-1 — eksik-araç oto-kurtarma davranışı --append-system-prompt ile enjekte edilir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../src/config.js';

// ARCH-0: anahtarlar config'ten okunur — her testte temiz config. Modül düzeyindeki MERGED_APPEND
// de config okur; anahtarsız CI'da (kayıtlı ~/.config anahtarı yok) beforeEach'ten önce gerekir.
process.env['GEMINI_API_KEY'] ??= 'test-key';
beforeEach(() => { process.env['GEMINI_API_KEY'] ??= 'test-key'; resetConfig(); });
afterEach(() => { delete process.env['BRIDGE_CHROME_MCP']; delete process.env['BRIDGE_COMPUTER_USE']; resetConfig(); });
import { buildClaudeArgs, TOOL_RECOVERY_PROMPT, SKILL_GUARD_PROMPT, BROWSER_GUIDE_PROMPT, DESKTOP_GUIDE_PROMPT, COMPUTER_GUIDE_PROMPT, OFFICE_EDIT_PROMPT, computerUseAvailable, officeToolsAvailable, officeToolsPrompt, officeHooks, bridgeMcpConfig } from '../../src/claude-args.js';

describe('buildClaudeArgs (LIVE-22)', () => {
  it('gerçek bypass bayrağı başa eklenir (--allow-... DEĞİL)', () => {
    const out = buildClaudeArgs([]);
    expect(out[0]).toBe('--dangerously-skip-permissions');
    expect(out).not.toContain('--allow-dangerously-skip-permissions');
  });

  it('bridge-özel flag\'lar ayıklanır, kullanıcı arg\'ları korunur', () => {
    const out = buildClaudeArgs(['--bridge-only', '--continue', '--allow-dangerously-skip-permissions', '-p', 'soru']);
    // bypass başta + kullanıcı argları ortada (recovery enjeksiyonu sona eklenir)
    expect(out.slice(0, 4)).toEqual(['--dangerously-skip-permissions', '--continue', '-p', 'soru']);
  });

  it('kullanıcı zaten bypass geçtiyse çift eklenmez', () => {
    const out = buildClaudeArgs(['--dangerously-skip-permissions']);
    expect(out.filter((a) => a === '--dangerously-skip-permissions')).toHaveLength(1);
  });
});

// APPEND-MERGE-1 (2026-06-18): Claude Code aynı --append-system-prompt flag'i
// birden çok kez verilince yalnız SONUNCUYU uygular. Bu yüzden köprünün TÜM
// kuralları (RECOVER-1/OCR-1 + SKILL-GUARD-1) TEK birleşik append'te gider.
const MERGED_APPEND = [TOOL_RECOVERY_PROMPT, SKILL_GUARD_PROMPT, DESKTOP_GUIDE_PROMPT, OFFICE_EDIT_PROMPT, BROWSER_GUIDE_PROMPT,
  ...(computerUseAvailable() ? [COMPUTER_GUIDE_PROMPT] : []),
  ...(officeToolsAvailable() ? [officeToolsPrompt()] : [])].join('\n\n');

describe('buildClaudeArgs — köprü kuralları TEK birleşik append (APPEND-MERGE-1)', () => {
  it('bizim eklediğimiz tek --append-system-prompt vardır (çoklu append son-kazanır tuzağı)', () => {
    const out = buildClaudeArgs([]);
    expect(out.filter((a) => a === '--append-system-prompt')).toHaveLength(1);
  });

  it('birleşik append HEM recovery HEM skill-guard kurallarını içerir (ikisi de düşmez)', () => {
    const out = buildClaudeArgs([]);
    const i = out.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThan(-1);
    const val = out[i + 1];
    expect(val).toContain(TOOL_RECOVERY_PROMPT); // RECOVER-1/OCR-1
    expect(val).toContain(SKILL_GUARD_PROMPT);   // SKILL-GUARD-1
    expect(val).toBe(MERGED_APPEND);
  });

  it('bypass hâlâ ilk arg; append flag + birleşik değer EN SONDA', () => {
    const out = buildClaudeArgs(['--continue']);
    expect(out[0]).toBe('--dangerously-skip-permissions');
    expect(out[out.length - 2]).toBe('--append-system-prompt');
    expect(out[out.length - 1]).toBe(MERGED_APPEND);
  });

  it('append değeri flag\'inden hemen sonra gelir; kullanıcı argları ÖNCE kalır', () => {
    const out = buildClaudeArgs(['-p', 'merhaba']);
    const i = out.indexOf('--append-system-prompt');
    expect(out[i + 1]).toBe(MERGED_APPEND);
    expect(out.indexOf('merhaba')).toBeLessThan(i);
  });
});

describe('buildClaudeArgs — RECOVER-1 / OCR-1 metin içeriği', () => {
  it('recovery metni boş değil ve davranış anahtarlarını içerir', () => {
    expect(TOOL_RECOVERY_PROMPT.length).toBeGreaterThan(50);
    expect(TOOL_RECOVERY_PROMPT).toMatch(/command not found|not installed/);
    expect(TOOL_RECOVERY_PROMPT.toLowerCase()).toContain('kur');
    expect(TOOL_RECOVERY_PROMPT.toLowerCase()).toContain('devam');
  });

  // OCR-1: taranmış PDF/görsel → OCR fallback + sonucu uydurma yasağı.
  it('OCR-1: OCR fallback (ocrmypdf/tesseract) + anti-halüsinasyon kuralı içerir', () => {
    expect(TOOL_RECOVERY_PROMPT).toMatch(/ocrmypdf|tesseract|OCR/);
    expect(TOOL_RECOVERY_PROMPT).toMatch(/pdftotext|taranmış|pdftoppm/);
    expect(TOOL_RECOVERY_PROMPT.toLowerCase()).toMatch(/uydurma|tahmini/);
  });
});

describe('buildClaudeArgs — kullanıcı system-prompt argları korunur', () => {
  // Kullanıcı kendi --append-system-prompt'unu geçerse korunur; bizim birleşik
  // append onun YANINA (sonra) eklenir → kullanıcı(1) + bizim(1) = 2 append.
  it('kullanıcının kendi --append-system-prompt\'u korunur, bizim birleşik append SONRA gelir', () => {
    const out = buildClaudeArgs(['--append-system-prompt', 'kullanıcı talimatı']);
    expect(out).toContain('kullanıcı talimatı');
    expect(out).toContain(MERGED_APPEND);
    expect(out.filter((a) => a === '--append-system-prompt')).toHaveLength(2);
    expect(out.indexOf(MERGED_APPEND)).toBeGreaterThan(out.indexOf('kullanıcı talimatı'));
    expect(out[out.length - 1]).toBe(MERGED_APPEND);
  });

  it('kullanıcının --system-prompt (replace) argümanı filtrelenmez, kurallar yine eklenir', () => {
    const out = buildClaudeArgs(['--system-prompt', 'tam değişim']);
    expect(out).toContain('--system-prompt');
    expect(out).toContain('tam değişim');
    expect(out.some((a) => a.includes(TOOL_RECOVERY_PROMPT) && a.includes(SKILL_GUARD_PROMPT))).toBe(true);
  });
});

describe('buildClaudeArgs — SKILL-GUARD-1 metin içeriği', () => {
  it('skill-guard metni /analyze çağırma + team başlatma yasağını içerir', () => {
    expect(SKILL_GUARD_PROMPT).toMatch(/\/analyze|\/fullscan|\/archscan/);
    expect(SKILL_GUARD_PROMPT.toLowerCase()).toMatch(/team|background|ajan|takım/);
    expect(SKILL_GUARD_PROMPT.toLowerCase()).toMatch(/codebase|proje/);
    expect(SKILL_GUARD_PROMPT).toMatch(/\.docx|\.pdf|dosya/i);
  });
  it('ATTR-LEAK-1: settings override commit/PR atfını boşaltır (yanlış Claude atfı ve cevaba sızma)', () => {
    const out = buildClaudeArgs([]);
    const s = JSON.parse(out[out.indexOf('--settings') + 1]!) as { attribution?: { commit: string; pr: string } };
    expect(s.attribution).toEqual({ commit: '', pr: '' });
  });
  it('ACT-CLAIM-1: ToolSearch yalnız yükler; yapılmamış işi yapılmış gibi söyleme', () => {
    expect(SKILL_GUARD_PROMPT).toMatch(/ToolSearch bir aracı yalnız YÜKLER/);
    expect(SKILL_GUARD_PROMPT).toMatch(/gerçekten\s+'?\s*'?çağırıp/);
  });
  it('BROWSER-TAB-1: yalnız kendi açtığı sekmeyle çalışır, kullanıcının sekmesini kapatmaz', () => {
    expect(BROWSER_GUIDE_PROMPT).toMatch(/DÖNDÜRDÜĞÜ tabId/);
    expect(BROWSER_GUIDE_PROMPT).toMatch(/ASLA kapatma/);
  });
  it('SKILL-EXPLICIT-1: adıyla istenen skill, araçlar doğrudan erişilebilir olsa da önce yüklenir', () => {
    expect(SKILL_GUARD_PROMPT).toMatch(/ADIYLA/);
    expect(SKILL_GUARD_PROMPT).toMatch(/ÖNCE `Skill` aracıyla/);
  });
  it('SKILL-NAME-1: skill adı birebir verilir, ToolSearch\'te aranmaz', () => {
    expect(SKILL_GUARD_PROMPT).toMatch(/adı BİREBİR ver/);
    expect(SKILL_GUARD_PROMPT).toMatch(/ToolSearch\\'te görünmez|ToolSearch'te görünmez/);
  });
});

describe('buildClaudeArgs — GAP-SKILL-2 metin içeriği', () => {
  it('using-superpowers tekrar yükleme + selamlaşmada skill yükleme yasağını içerir', () => {
    expect(SKILL_GUARD_PROMPT).toMatch(/using-superpowers/);
    expect(SKILL_GUARD_PROMPT.toLowerCase()).toMatch(/tekrar yükleme|enjekte/);
    expect(SKILL_GUARD_PROMPT.toLowerCase()).toMatch(/merhaba|selamlaşma|sohbet/);
  });

  it('GAP-SKILL-2 kuralı birleşik append içinde Gemini\'ye ulaşır', () => {
    const out = buildClaudeArgs([]);
    const append = out[out.indexOf('--append-system-prompt') + 1];
    expect(append).toMatch(/using-superpowers/);
  });
});

describe('LONGCTX-1 autoCompactWindow override', () => {
  it('--settings genel ve model bazlı autoCompactWindow=100000 taşır', async () => {
    const { BRIDGE_AUTO_COMPACT_WINDOW } = await import('../../src/claude-args.js');
    const out = buildClaudeArgs([]);
    const i = out.indexOf('--settings');
    expect(i).toBeGreaterThan(-1);
    const s = JSON.parse(out[i + 1]!);
    expect(s.autoCompactWindow).toBe(BRIDGE_AUTO_COMPACT_WINDOW);
    expect(s.modelSettings['claude-opus-5-5'].autoCompactWindow).toBe(100_000);
    expect(s.enabledPlugins['security-guidance@claude-plugins-official']).toBe(false);
  });

  it('kullanıcı ayarındaki yeni model anahtarları da ezilir', async () => {
    const { bridgeModelKeys } = await import('../../src/claude-args.js');
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const f = join(mkdtempSync(join(tmpdir(), 'ca-')), 'settings.json');
    writeFileSync(f, JSON.stringify({ modelSettings: { 'claude-opus-9': { autoCompactWindow: 900000 } } }));
    expect(bridgeModelKeys(f)).toContain('claude-opus-9');
    expect(bridgeModelKeys(join(tmpdir(), 'yok-xyz.json'))).toContain('claude-sonnet-5-5');
  });
});

describe('BROWSER-1 / CU-1 köprü MCP sunucuları', () => {
  const servers = (out: string[]): Record<string, any> => {
    const i = out.indexOf('--mcp-config');
    return i < 0 ? {} : JSON.parse(out[i + 1]!).mcpServers;
  };

  it('chrome sunucusu: ayrılmış ad değil, bypass izin kipiyle; append yine en sonda', () => {
    const out = buildClaudeArgs(['-p', 'soru']);
    const sv = servers(out);
    expect(sv['claude-in-chrome']).toBeUndefined(); // ayrılmış ad — yok sayılıyor
    expect(sv['chrome'].args).toEqual(['--claude-in-chrome-mcp']);
    // Claude Code'un bypass kipindeki davranışıyla aynı: site başına onay sorulmaz.
    expect(sv['chrome'].env.CLAUDE_CHROME_PERMISSION_MODE).toBe('skip_all_permission_checks');
    expect(out[out.length - 2]).toBe('--append-system-prompt');
  });

  it('BRIDGE_CHROME_MCP=off chrome\'u ve tarayıcı talimatını kapatır', () => {
    process.env['BRIDGE_CHROME_MCP'] = 'off'; resetConfig();
    try {
      const out = buildClaudeArgs([]);
      expect(servers(out)['chrome']).toBeUndefined();
      expect(out[out.length - 1]).not.toContain(BROWSER_GUIDE_PROMPT);
    } finally { delete process.env['BRIDGE_CHROME_MCP']; }
  });

  it('computer sunucusu dist/computer-use-mcp.js\'i node ile başlatır; BRIDGE_COMPUTER_USE=off kapatır', () => {
    if (computerUseAvailable()) {
      const sv = servers(buildClaudeArgs([]));
      expect(sv['computer'].command).toBe(process.execPath);
      expect(sv['computer'].args[0]).toMatch(/dist[\\/]computer-use-mcp\.js$/);
    }
    process.env['BRIDGE_COMPUTER_USE'] = 'off'; resetConfig();
    try {
      const out = buildClaudeArgs([]);
      expect(servers(out)['computer']).toBeUndefined();
      expect(out[out.length - 1]).not.toContain(COMPUTER_GUIDE_PROMPT);
    } finally { delete process.env['BRIDGE_COMPUTER_USE']; }
  });

  it('hepsi kapalıysa (chrome, computer, office) --mcp-config hiç eklenmez', () => {
    process.env['BRIDGE_CHROME_MCP'] = 'off'; process.env['BRIDGE_COMPUTER_USE'] = 'off'; process.env['BRIDGE_OFFICE_MCP'] = 'off'; resetConfig();
    try { expect(buildClaudeArgs([])).not.toContain('--mcp-config'); }
    finally { delete process.env['BRIDGE_CHROME_MCP']; delete process.env['BRIDGE_COMPUTER_USE']; delete process.env['BRIDGE_OFFICE_MCP']; resetConfig(); }
  });
});

describe('OFFICE-1 dosya düzenleme protokolü', () => {
  it('birleşik append protokolü taşır: önce analiz, yerinde düzenleme, karşılaştırmalı doğrulama', () => {
    const out = buildClaudeArgs([]);
    const appended = out[out.length - 1]!;
    expect(appended).toContain(OFFICE_EDIT_PROMPT);
    for (const key of ['ÖNCE ANALİZ', 'blok başlık', 'YERİNDE DÜZENLE', 'yeniden kurma', 'DOĞRULA', 'karşılaştır', 'Orijinalin üzerine yazma']) {
      expect(OFFICE_EDIT_PROMPT).toContain(key);
    }
  });
});

describe('ADR-0004 office araçları', () => {
  it('talimat docenv Python yolunu, iki aracı ve komut yedeğini taşır', () => {
    const t = officeToolsPrompt('/x/docenv/bin/python', '/p/assets/office_tools.py');
    for (const k of ['mcp__office__office_inspect', 'mcp__office__office_compare', '/x/docenv/bin/python', 'SORUN', 'inspect <dosya>', 'pip install']) {
      expect(t).toContain(k);
    }
  });
  it('office sunucusu yalnız docenv hazırsa bağlanır', () => {
    const cfg = JSON.parse(bridgeMcpConfig() ?? '{"mcpServers":{}}') as { mcpServers: Record<string, unknown> };
    expect('office' in cfg.mcpServers).toBe(officeToolsAvailable());
  });
  it("hook'lar: istekte analiz (UserPromptSubmit), tur sonunda karşılaştırma (Stop), docenv Python'u ile", () => {
    const h = officeHooks('/x/py', '/p/office_hook.py') as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(h['UserPromptSubmit']![0]!.hooks[0]!.command).toBe('"/x/py" -I "/p/office_hook.py" prompt');
    expect(h['Stop']![0]!.hooks[0]!.command).toBe('"/x/py" -I "/p/office_hook.py" stop');
  });
  it("--settings hook'ları yalnız docenv hazırsa taşır", () => {
    const out = buildClaudeArgs([]);
    const settings = JSON.parse(out[out.indexOf('--settings') + 1]!) as { hooks?: unknown };
    expect('hooks' in settings).toBe(officeToolsAvailable());
  });
  it('BRIDGE_OFFICE_MCP=off sunucuyu ve talimatı kapatır', async () => {
    const { resetConfig } = await import('../../src/config.js');
    process.env['BRIDGE_OFFICE_MCP'] = 'off';
    resetConfig();
    try {
      expect(officeToolsAvailable()).toBe(false);
      const out = buildClaudeArgs([]);
      expect(out[out.length - 1]).not.toContain('mcp__office__office_inspect');
      expect(JSON.parse(out[out.indexOf('--settings') + 1]!)).not.toHaveProperty('hooks');
    } finally {
      delete process.env['BRIDGE_OFFICE_MCP'];
      resetConfig();
    }
  });
});

describe('PY-AS-BASH-1', () => {
  it('Python kodunu Bash komutu olarak göndermeme kuralı köprüye ulaşır', () => {
    const out = buildClaudeArgs([]);
    expect(out[out.length - 1]).toContain('ImageMagick ekran yakalama');
  });
});
