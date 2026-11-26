import { describe, it, expect } from 'vitest';
import {
  sanitizeSchema,
  prioritizeTools,
  toGeminiFunctionDeclarations,
  toAnthropicToolUse,
  toGeminiToolId,
  detectToolResults,
  findToolName,
  parseTextToolCall,
  filterBlockedTools,
  MAX_TOOLS,
  CORE_TOOLS,
  BLOCKED_TOOLS,
  WEB_SEARCH_TOOL,
} from '../../src/tool-mapper.js';
import type { AnthropicTool, AnthropicMessage } from '../../src/types.js';

const tool = (name: string): AnthropicTool => ({
  name,
  description: `${name} aracı`,
  input_schema: { type: 'object', properties: {} },
});

describe('sanitizeSchema', () => {
  it('type değerlerini UPPERCASE yapar', () => {
    expect(sanitizeSchema({ type: 'string' })).toEqual({ type: 'STRING' });
    expect(sanitizeSchema({ type: 'object' }).type).toBe('OBJECT');
  });

  it('whitelist dışı alanları siler (description, default, $schema)', () => {
    const result = sanitizeSchema({
      type: 'string',
      description: 'silinmeli',
      default: 'silinmeli',
      $schema: 'silinmeli',
      minLength: 1,
    });
    expect(result).toEqual({ type: 'STRING', minLength: 1 });
  });

  it('anyOf [{type:X},{type:null}] → {type:X, nullable:true}', () => {
    const result = sanitizeSchema({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(result).toEqual({ type: 'STRING', nullable: true });
  });

  it('tek elemanlı anyOf düzleştirilir', () => {
    expect(sanitizeSchema({ anyOf: [{ type: 'number' }] })).toEqual({ type: 'NUMBER' });
  });

  it('çoklu anyOf korunur ve type sibling EKLENMEZ (Gemini kuralı)', () => {
    const result = sanitizeSchema({
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    });
    expect(result.anyOf).toHaveLength(3);
    expect(result.type).toBeUndefined();
  });

  it('properties ve items recursive işlenir', () => {
    const result = sanitizeSchema({
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'integer' } },
      },
      required: ['list'],
    });
    expect(result.properties!.list!.items!.type).toBe('INTEGER');
    expect(result.required).toEqual(['list']);
  });

  it('derinlik 5 üstünü STRING ile keser', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 10; i++) deep = { type: 'object', properties: { inner: deep } };
    // Hata fırlatmadan sonlanmalı
    expect(() => sanitizeSchema(deep)).not.toThrow();
  });

  it('geçersiz/boş şema STRING fallback döner', () => {
    expect(sanitizeSchema(null)).toEqual({ type: 'STRING' });
    expect(sanitizeSchema(undefined)).toEqual({ type: 'STRING' });
  });

  it('array tipi items olmadan gelirse Gemini zorunlu kıldığı için STRING items ekler', () => {
    const result = sanitizeSchema({ type: 'array' });
    expect(result).toEqual({ type: 'ARRAY', items: { type: 'STRING' } });
  });

  it('prefixItems (tuple) içeren array için items türetilir', () => {
    const tupleSchema = {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'string', enum: ['a', 'b'] }, {}],
    };
    const result = sanitizeSchema(tupleSchema);
    expect(result.type).toBe('ARRAY');
    expect(result.items).toBeDefined();
    expect(result.items!.anyOf).toHaveLength(2);
    expect(result.items!.anyOf![0]!.type).toBe('STRING');
    expect(result.items!.anyOf![1]!.type).toBe('STRING');
    expect(result.items!.anyOf![1]!.enum).toEqual(['a', 'b']);
  });
});

describe('TOOLSEL-1 araç seçimi', () => {
  it('limit gerçek oturumun 118 aracını taşır', () => {
    expect(MAX_TOOLS).toBeGreaterThanOrEqual(118);
  });

  it('ToolSearch core\'da — yüklenmemiş MCP araçlarına kapı', () => {
    expect(CORE_TOOLS).toContain('ToolSearch');
    const many = Array.from({ length: MAX_TOOLS + 10 }, (_, i) => tool(`Custom${i}`));
    const names = toGeminiFunctionDeclarations([...many, tool('ToolSearch')]).map((d) => d.name);
    expect(names).toContain('ToolSearch');
  });

  it('köprüde çalışmayan hesap/bulut/alt-ajan araçları Gemini\'ye gitmez', () => {
    const dead = ['Artifact', 'CronCreate', 'ScheduleWakeup', 'PushNotification', 'Workflow', 'SendMessage', 'DesignSync', 'RemoteTrigger'];
    const names = toGeminiFunctionDeclarations([...dead, 'Read', 'Monitor', 'mcp__x__y'].map(tool)).map((d) => d.name);
    for (const d of dead) expect(names).not.toContain(d);
    expect(names).toEqual(expect.arrayContaining(['Read', 'Monitor', 'mcp__x__y']));
  });

  it('maxTools seçeneği sınırı düşürür, core korunur', () => {
    const many = Array.from({ length: 40 }, (_, i) => tool(`Custom${i}`));
    const names = toGeminiFunctionDeclarations([...many, tool('Read')], { maxTools: 10 }).map((d) => d.name);
    expect(names).toHaveLength(10);
    expect(names).toContain('Read');
    expect(names).toContain('web_search');
  });
});

describe('prioritizeTools', () => {
  it(`${MAX_TOOLS} ve altı listeyi aynen döner`, () => {
    const tools = ['A', 'B'].map(tool);
    expect(prioritizeTools(tools)).toEqual(tools);
  });

  it('limit üstünde core tool öncelikli seçilir', () => {
    const customs = Array.from({ length: MAX_TOOLS + 5 }, (_, i) => tool(`Custom${i}`));
    const all = [...customs, tool('Bash'), tool('Read'), tool('Grep')];
    const selected = prioritizeTools(all);
    expect(selected).toHaveLength(MAX_TOOLS);
    const names = selected.map((t) => t.name);
    expect(names).toContain('Bash');
    expect(names).toContain('Read');
    expect(names).toContain('Grep');
    // Core sıralaması: Read, CORE_TOOLS listesinde Bash'ten önce gelir
    expect(names.indexOf('Read')).toBeLessThan(names.indexOf('Bash'));
    expect(CORE_TOOLS.indexOf('Read')).toBeLessThan(CORE_TOOLS.indexOf('Bash'));
  });
});

describe('filterBlockedTools (TOOL-GUARD-1)', () => {
  it('Agent ve plan-mode tool\'larını listeden çıkarır', () => {
    const all = ['Read', 'Bash', 'Agent', 'EnterPlanMode', 'ExitPlanMode', 'Task', 'Edit'].map(tool);
    const names = filterBlockedTools(all).map((t) => t.name);
    expect(names).toEqual(['Read', 'Bash', 'Edit']);
    expect(names).not.toContain('Agent');
    expect(names).not.toContain('EnterPlanMode');
    expect(names).not.toContain('ExitPlanMode');
    expect(names).not.toContain('Task');
  });

  it('engellenmeyen tool\'lar (TaskCreate/Skill/Read) korunur', () => {
    const all = ['Read', 'TaskCreate', 'TaskList', 'Skill', 'NotebookEdit'].map(tool);
    const names = filterBlockedTools(all).map((t) => t.name);
    expect(names).toEqual(['Read', 'TaskCreate', 'TaskList', 'Skill', 'NotebookEdit']);
  });

  it('GAP-WEBSEARCH-1: WebSearch çıkarılır ama WebFetch korunur', () => {
    const names = filterBlockedTools(['WebFetch', 'WebSearch', 'Read'].map(tool)).map((t) => t.name);
    expect(names).toContain('WebFetch');   // URL ile çalışır
    expect(names).not.toContain('WebSearch'); // server-side, çalışmıyor
  });

  it('BLOCKED_TOOLS ile CORE_TOOLS kesişmez (deny-list öncelik listesinden ayrık)', () => {
    for (const name of BLOCKED_TOOLS) {
      expect(CORE_TOOLS).not.toContain(name);
    }
  });
});

describe('toGeminiFunctionDeclarations', () => {
  it('description 200 karakterde kesilir', () => {
    const decls = toGeminiFunctionDeclarations([
      { name: 'X', description: 'd'.repeat(500), input_schema: { type: 'object' } },
    ]);
    // Not: LIVE-SEARCH-1 sonrası listeye sentetik web_search prepend edilir →
    // 'X' tool'unu indeksle değil isimle bul.
    const x = decls.find((d) => d.name === 'X');
    expect(x!.description.length).toBe(200);
  });

  it('engellenen tool\'lar Gemini\'ye GÖNDERİLMEZ (yapısal guard)', () => {
    const decls = toGeminiFunctionDeclarations(
      ['Read', 'Agent', 'EnterPlanMode', 'Bash'].map(tool),
    );
    const names = decls.map((d) => d.name);
    expect(names).toContain('Read');
    expect(names).toContain('Bash');
    expect(names).not.toContain('Agent');
    expect(names).not.toContain('EnterPlanMode');
  });
});

describe('sentetik web_search tool (LIVE-SEARCH-1)', () => {
  it('Claude Code listesinde web_search YOKKEN bile Gemini\'ye eklenir', () => {
    const names = toGeminiFunctionDeclarations(['Read', 'Bash'].map(tool)).map((d) => d.name);
    expect(names).toContain('web_search');
  });

  it('web_search declaration\'ı query param + ≤200 kr description taşır', () => {
    const decls = toGeminiFunctionDeclarations([]);
    const ws = decls.find((d) => d.name === 'web_search');
    expect(ws).toBeDefined();
    expect(ws!.description.length).toBeLessThanOrEqual(200);
    expect(ws!.parameters?.properties).toHaveProperty('query');
  });

  it('web_search CORE_TOOLS\'ta — 25+ tool prune\'unda DÜŞMEZ', () => {
    const many = Array.from({ length: MAX_TOOLS + 35 }, (_, i) => tool(`Custom${i}`));
    const names = toGeminiFunctionDeclarations(many).map((d) => d.name);
    expect(names.length).toBe(MAX_TOOLS);
    expect(names).toContain('web_search');
  });

  it('web_search zaten varsa ÇİFTLENMEZ', () => {
    const decls = toGeminiFunctionDeclarations([WEB_SEARCH_TOOL, tool('Read')]);
    const count = decls.filter((d) => d.name === 'web_search').length;
    expect(count).toBe(1);
  });

  it('web_search BLOCKED değil; ama Anthropic WebSearch BLOCKED kalır', () => {
    expect(BLOCKED_TOOLS.has('web_search')).toBe(false);
    expect(BLOCKED_TOOLS.has('WebSearch')).toBe(true);
    expect(CORE_TOOLS).toContain('web_search');
  });
});

describe('tool id dönüşümleri', () => {
  it('toAnthropicToolUse toolu_ prefix ekler, toGeminiToolId soyar (roundtrip)', () => {
    const at = toAnthropicToolUse({ id: 'fc_123', name: 'Read', args: { a: 1 } });
    expect(at.id).toBe('toolu_fc_123');
    expect(toGeminiToolId(at.id)).toBe('fc_123');
  });

  it('toGeminiToolId prefix yoksa aynen döner', () => {
    expect(toGeminiToolId('raw_id')).toBe('raw_id');
  });
});

describe('detectToolResults & findToolName', () => {
  const messages: AnthropicMessage[] = [
    { role: 'user', content: 'dosyayı oku' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'içerik' }],
    },
  ];

  it('son user mesajındaki tool_result bloklarını bulur', () => {
    const { hasToolResults, toolResults } = detectToolResults(messages);
    expect(hasToolResults).toBe(true);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool_use_id).toBe('toolu_9');
  });

  it('tool_result yoksa false döner', () => {
    expect(detectToolResults([{ role: 'user', content: 'merhaba' }]).hasToolResults).toBe(false);
  });

  // 2026-06-11 canlı kanıt (req dump m7): Claude Code 2.1.x tool result'tan
  // SONRA ek system mesajı ekleyebiliyor (MCP instructions vb.) — sadece son
  // mesaja bakan tespit sonucu kaçırıp full replay'e düşürüyordu.
  it('tool_result + ardından system mesajı → yine tespit edilir', () => {
    const msgs: AnthropicMessage[] = [
      ...messages,
      { role: 'system' as 'user', content: '# MCP Server Instructions\n...' },
    ];
    const { hasToolResults, toolResults } = detectToolResults(msgs);
    expect(hasToolResults).toBe(true);
    expect(toolResults[0].tool_use_id).toBe('toolu_9');
  });

  it('tool_result + ardından düz user mesajı → yine tespit edilir', () => {
    const msgs: AnthropicMessage[] = [
      ...messages,
      { role: 'user', content: 'hatırlatma: kısa yaz' },
    ];
    expect(detectToolResults(msgs).hasToolResults).toBe(true);
  });

  it('son assistant CEVAPTAN sonraki yeni soruda eski tool_result tespit EDİLMEZ', () => {
    const msgs: AnthropicMessage[] = [
      ...messages,
      { role: 'assistant', content: 'içerik şu: ...' }, // tool exchange kapandı
      { role: 'user', content: 'peki başka bir soru' },
    ];
    expect(detectToolResults(msgs).hasToolResults).toBe(false);
  });

  it('findToolName tool_use_id üzerinden adı bulur, bulamazsa unknown_tool', () => {
    expect(findToolName(messages, 'toolu_9')).toBe('Read');
    expect(findToolName(messages, 'toolu_yok')).toBe('unknown_tool');
  });
});

// LIVE-20 (2026-06-11 canlı transcript kanıtı): 3.1, flatten/replay
// notasyonunu taklit edip "[tool_use:Read args={...}]" metnini GERÇEK
// fonksiyon çağrısı yerine yazıya döküyor. Bridge bu metni yakalayıp
// gerçek tool_use'a çevirir.
describe('parseTextToolCall', () => {
  it('transcript kanıtındaki formatı çözer (iki nokta sonrası boşluksuz)', () => {
    const r = parseTextToolCall(
      'Dosyanın devamını okuyorum.\n[tool_use:Read args={"file_path":"PLANS/ACTIVE_PLAN.md","offset":37}]',
    );
    expect(r).not.toBeNull();
    expect(r!.name).toBe('Read');
    expect(r!.input).toEqual({ file_path: 'PLANS/ACTIVE_PLAN.md', offset: 37 });
    expect(r!.before).toBe('Dosyanın devamını okuyorum.\n');
  });

  it('boşluklu format + iç tırnak ve süslü parantezli args', () => {
    const r = parseTextToolCall(
      '[tool_use: Bash args={"command":"grep -A 5 \\"ERR-1\\" plan.md","description":"ara {x}"}]',
    );
    expect(r).not.toBeNull();
    expect(r!.name).toBe('Bash');
    expect((r!.input as { command: string }).command).toContain('ERR-1');
  });

  it('bozuk JSON → null (düz metin olarak akar)', () => {
    expect(parseTextToolCall('[tool_use: Read args={bozuk}]')).toBeNull();
  });

  it('kapanış ] yoksa null', () => {
    expect(parseTextToolCall('[tool_use: Read args={"a":1}')).toBeNull();
  });

  it('marker yoksa null', () => {
    expect(parseTextToolCall('normal cevap metni')).toBeNull();
  });
});

describe('SEARCH-LAT-1 web_search açıklaması', () => {
  it('bugünün tarihini (İstanbul) taşır ve 200 karakteri aşmaz', async () => {
    const { webSearchToolForToday, todayIstanbul } = await import('../../src/tool-mapper.js');
    const now = new Date('2026-11-25T22:30:00Z'); // İstanbul'da 26 Kasım 01:30
    expect(todayIstanbul(now)).toBe('2026-11-26');
    const t = webSearchToolForToday(now);
    expect(t.description).toContain('2026-11-26');
    expect(t.description!.length).toBeLessThanOrEqual(200);
  });
});


describe('TOOLREF-1 toolResultText', () => {
  it('ToolSearch tool_reference bloğunu modele anlamlı metne çevirir', async () => {
    const { toolResultText } = await import('../../src/tool-mapper.js');
    expect(toolResultText([{ type: 'tool_reference', tool_name: 'mcp__stok__q' }])).toContain('Tool loaded: mcp__stok__q');
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(toolResultText('düz')).toBe('düz');
    expect(toolResultText(undefined)).toBe('(empty)');
  });
});

describe('sanitizeSchema — dizi type (BROWSER-1, claude-in-chrome form_input)', () => {
  it('çoklu tip anyOf olur; null nullable olur; tek tip düzleşir; istek düşmez', () => {
    const s = sanitizeSchema({
      type: 'object',
      properties: {
        value: { type: ['string', 'boolean', 'number'], description: 'x' },
        maybe: { type: ['string', 'null'] },
        only: { type: ['null'] },
      },
    });
    expect(s.properties!.value).toEqual({ anyOf: [{ type: 'STRING' }, { type: 'BOOLEAN' }, { type: 'NUMBER' }] });
    expect(s.properties!.maybe).toEqual({ type: 'STRING', nullable: true });
    expect(s.properties!.only).toEqual({ type: 'STRING', nullable: true });
    expect(sanitizeSchema({ type: 7 })).toEqual({ type: 'STRING' }); // bozuk şema istisna atmaz
  });
});
