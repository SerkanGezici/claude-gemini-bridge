// ADR-0001 Denetçi: kanıt çıkarımı, denetçi çıktısının ayrıştırılması ve
// fail-open model zinciri. Live denetçi enjekte edilen sahte fonksiyonla
// taklit edilir (gerçek API'ye GİTMEZ).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { extractReviewInput, parseReview, runReview, buildFeedback, reviewStateless, isCompactionRequest, rewriteFromEvidence, guardRevision, unbackedActionClaims, markSearched } from '../../src/reviewer.js';
import { resetConfig } from '../../src/config.js';
import type { AnthropicMessage } from '../../src/types.js';

const KEYS = ['GEMINI_API_KEY', 'REVIEW', 'REVIEW_MODELS'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env['GEMINI_API_KEY'] = 'test-key';
  delete process.env['REVIEW'];
  process.env['REVIEW_MODELS'] = 'models/a,models/b';
  resetConfig();
});
afterAll(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetConfig();
});

const conv: AnthropicMessage[] = [
  { role: 'user', content: [
    { type: 'text', text: '<system-reminder>\nCLAUDE.md içeriği</system-reminder>' },
    { type: 'text', text: 'şartnameyi incele ve riskleri çıkar' },
  ] },
  { role: 'system', content: 'hook çıktısı' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'sartname.txt' } }] },
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: '6.1 binde 3 gecikme cezası' },
    { type: 'text', text: '<system-reminder>dosya değişti</system-reminder>' },
  ] },
];

describe('extractReviewInput', () => {
  it('asıl isteği system-reminder\'ları atlayarak bulur, kanıta tool çağrısı + sonucu koyar', () => {
    const r = extractReviewInput(conv)!;
    expect(r.request).toBe('şartnameyi incele ve riskleri çıkar');
    expect(r.evidence).toContain('[TOOL CALL Read]');
    expect(r.evidence).toContain('binde 3 gecikme cezası');
    expect(r.evidence).not.toContain('hook çıktısı');
  });

  it('araç sonucu mesajındaki harness metni ("Tool loaded.") istek sayılmaz', () => {
    const r = extractReviewInput([
      { role: 'user', content: 'TSL-8842 stok adedi ve rafı ne?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:mcp__stok__q' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'loaded' }] },
        { type: 'text', text: 'Tool loaded.' },
      ] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'mcp__stok__q', input: { urun_kodu: 'TSL-8842' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '4173 adet, raf K-19' }] }] },
    ] as never)!;
    expect(r.request).toBe('TSL-8842 stok adedi ve rafı ne?');
    expect(r.evidence).toContain('4173 adet, raf K-19');
  });

  it('araç kullanılmamış konuşmada null (denetim yok)', () => {
    expect(extractReviewInput([{ role: 'user', content: 'merhaba' }])).toBeNull();
  });
});

describe('parseReview', () => {
  it('SORU satırları: VAR yok sayılır, YOK sorun olur (tek satıra yapışık olsa da)', () => {
    const out = 'SORU: stok adedi | YOK SORU: ürün kodu | VAR MADDE: raf K-19 eksik | YOK';
    expect(parseReview(out)).toEqual(['SORU: stok adedi', 'MADDE: raf K-19 eksik']);
    expect(parseReview('SORU: stok adedi | VAR\nSORU: raf | VAR\nTAMAM')).toEqual([]);
  });

  it('YOK satırlarını ve gerçek ÇELİŞKİ\'yi alır; VAR ve "ÇELİŞKİ: Yok" atlanır', () => {
    const out = 'MADDE: 2.2 kesin teminat %6 | YOK\nMADDE: 4.3 42 nokta | VAR\nİSTEK: karar | YOK\nÇELİŞKİ: Yok\nÇELİŞKİ: taslak 60 gün diyor, kanıt 30 gün';
    expect(parseReview(out)).toEqual([
      'MADDE: 2.2 kesin teminat %6',
      'İSTEK: karar',
      'ÇELİŞKİ: taslak 60 gün diyor, kanıt 30 gün',
    ]);
  });

  it('satır sonları kaybolmuş transkripsiyonu etiketlerden böler', () => {
    expect(parseReview('MADDE: 5.1 garanti | YOK MADDE: 4.1 teslim | VAR')).toEqual(['MADDE: 5.1 garanti']);
  });

  it('ARAŞTIRMA satırı sorun sayılır (eksik arama)', () => {
    expect(parseReview('MADDE: toplam | VAR ARAŞTIRMA: diğer sayfalara bak | YOK')).toEqual(['ARAŞTIRMA: diğer sayfalara bak']);
  });

  it('temiz denetim → []', () => {
    expect(parseReview('MADDE: x | VAR\nÇELİŞKİ: yok')).toEqual([]);
  });
});

describe('runReview', () => {
  it('ilk model başarısızsa sıradakini dener', async () => {
    const calls: string[] = [];
    const issues = await runReview(conv, 'taslak', async (model) => {
      calls.push(model);
      if (model === 'models/a') throw new Error('1011 quota');
      return 'MADDE: 6.1 binde 3 | YOK';
    });
    expect(calls).toEqual(['models/a', 'models/b']);
    expect(issues).toEqual(['MADDE: 6.1 binde 3']);
  });

  it('tüm modeller başarısız → null (fail-open)', async () => {
    expect(await runReview(conv, 'taslak', async () => { throw new Error('x'); })).toBeNull();
  });

  it('boş denetçi çıktısı hata sayılır → null', async () => {
    expect(await runReview(conv, 'taslak', async () => '')).toBeNull();
  });

  it('REVIEW=off → null, denetçi hiç çağrılmaz', async () => {
    process.env['REVIEW'] = 'off';
    resetConfig();
    let called = false;
    expect(await runReview(conv, 'taslak', async () => { called = true; return ''; })).toBeNull();
    expect(called).toBe(false);
  });

  it('araç kanıtı yoksa denetçi çağrılmaz', async () => {
    let called = false;
    expect(await runReview([{ role: 'user', content: 'merhaba' }], 'selam', async () => { called = true; return ''; })).toBeNull();
    expect(called).toBe(false);
  });
});

// ACT-CLAIM-1: deep-research taramasındaki gerçek konuşmanın şekli (Skill + ToolSearch, arama yok).
const skillConv: AnthropicMessage[] = [
  { role: 'user', content: 'Skill aracıyla deep-research skill\'ini yükle ve uygula: 2026 Türkiye dizüstü pazarı' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'anthropic-skills:deep-research' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Launching skill' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 's2', name: 'ToolSearch', input: { query: 'select:WebSearch' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's2', content: '' }] },
];
const FAKE = "Skill'in ilk adımı olarak web araması gerçekleştirildi. Arama sonuçlarına göre HP, Lenovo ve Dell öne çıkıyor.";

describe('ACT-CLAIM-1 unbackedActionClaims', () => {
  it('arama aracı hiç çağrılmadan "web araması yapıldı" → EYLEM sorunu', () => {
    const issues = unbackedActionClaims(skillConv, FAKE);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^EYLEM:.*WebSearch/);
  });
  it('WebSearch gerçekten çağrıldıysa sorun yok', () => {
    const withSearch: AnthropicMessage[] = [...skillConv,
      { role: 'assistant', content: [{ type: 'tool_use', id: 's3', name: 'WebSearch', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's3', content: 'sonuç' }] }];
    expect(unbackedActionClaims(withSearch, FAKE)).toEqual([]);
  });
  it('önceki turda yapılmış aramaya atıf yanlış alarm değildir', () => {
    const earlier: AnthropicMessage[] = [
      { role: 'user', content: 'pazarı araştır' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'WebSearch', input: { query: 'pazar' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'HP Lenovo' }] },
      { role: 'assistant', content: 'HP ve Lenovo önde.' },
      ...skillConv];
    expect(unbackedActionClaims(earlier, FAKE)).toEqual([]);
  });
  it('SEARCH-LEDGER-1: aramayı köprü kendisi yaptıysa (geçmişte görünmez) iddia desteklidir', () => {
    const conv2: AnthropicMessage[] = [{ role: 'user', content: 'ledger testi: pazarı araştır' }, ...skillConv.slice(1)];
    expect(unbackedActionClaims(conv2, FAKE)).toHaveLength(1);
    markSearched(conv2);
    expect(unbackedActionClaims(conv2, FAKE)).toEqual([]);
    expect(extractReviewInput(conv2)?.evidence).toMatch(/BRIDGE NOTE/);
  });
  it('çekimli biçimler de iddiadır ("Arama sonucunda", "yaptığım aramada")', () => {
    expect(unbackedActionClaims(skillConv, "Arama sonucunda Lenovo, HP ve Dell öne çıkıyor.")[0]).toMatch(/^EYLEM:/);
    expect(unbackedActionClaims(skillConv, 'Yaptığım aramada firma bulunamadı.')[0]).toMatch(/^EYLEM:/);
  });
  it('olumsuz cümle ("arama yapamadım") iddia değildir', () => {
    expect(unbackedActionClaims(skillConv, 'Web araması yapamadım çünkü araç yok; bilgiyi doğrulayamıyorum.')).toEqual([]);
  });
  it('dosya yazan araç olmadan "rapor.docx oluşturuldu" → EYLEM sorunu; Write varsa yok', () => {
    expect(unbackedActionClaims(skillConv, 'rapor.docx dosyası oluşturuldu ve kaydedildi.')[0]).toMatch(/^EYLEM:.*dosya/);
    const withWrite: AnthropicMessage[] = [...skillConv,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: 'rapor.docx' } }] }];
    expect(unbackedActionClaims(withWrite, 'rapor.docx dosyası oluşturuldu.')).toEqual([]);
  });
  it('runReview desteksiz iddiada denetçi modelini çağırmadan EYLEM döndürür', async () => {
    let called = false;
    const issues = await runReview(skillConv, FAKE, async () => { called = true; return 'TAMAM'; });
    expect(called).toBe(false);
    expect(issues?.[0]).toMatch(/^EYLEM:/);
  });
  it('EYLEM, Claude yeniden yazımına değil araç çağırabilen Gemini turuna gider', async () => {
    expect(await rewriteFromEvidence(skillConv, FAKE, ['EYLEM: x'], async () => 'yazıldı')).toBeNull();
    expect(buildFeedback(['EYLEM: x'])).toMatch(/EYLEM.*actually call the tool/);
  });
});

// SKILL-NAME-1: taramadaki gerçek şekiller (uydurma alt-ad, ToolSearch'te skill arama).
describe('SKILL-NAME-1 istenen skill hiç yüklenmedi', () => {
  const ask = (skill: string, calls: Array<[string, string, boolean]>): AnthropicMessage[] => [
    { role: 'user', content: `Skill aracıyla \`${skill}\` skill'ini yükle ve uygula: örnek iş` },
    ...calls.flatMap(([id, name, err]): AnthropicMessage[] => [
      { role: 'assistant', content: [{ type: 'tool_use', id, name: name.startsWith('TS:') ? 'ToolSearch' : 'Skill', input: name.startsWith('TS:') ? { query: name.slice(3) } : { skill: name } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: err ? `Unknown skill: ${name}` : 'Launching skill', is_error: err }] },
    ]),
  ];
  const DRAFT = 'Skill bulunamadı; işi elle yaptım.';
  it('uydurma alt-ad (firecrawl-cli:scrape) → EYLEM, doğru adı söyler', () => {
    const issues = unbackedActionClaims(ask('firecrawl-cli', [['a', 'firecrawl-cli:scrape', true]]), DRAFT);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^EYLEM:.*skill: "firecrawl-cli"/);
  });
  it('Skill yerine ToolSearch ile arama → EYLEM', () => {
    expect(unbackedActionClaims(ask('sales:team-pipeline', [['a', 'TS:select:sales:team-pipeline', false]]), DRAFT)[0]).toMatch(/sales:team-pipeline/);
  });
  it('istenen adla çağrıldıysa (hata dönse bile) sorun yok', () => {
    expect(unbackedActionClaims(ask('graphify', [['a', 'graphify', true]]), DRAFT)).toEqual([]);
    expect(unbackedActionClaims(ask('sales:forecast', [['a', 'sales:forecast', false]]), 'Tahmin hazır.')).toEqual([]);
  });
  it('ad alanı tek tarafta yazılmışsa eşleşir; skill geçmeyen istekte kontrol yok', () => {
    expect(unbackedActionClaims(ask('deep-research', [['a', 'anthropic-skills:deep-research', false]]), 'Hazır.')).toEqual([]);
    expect(unbackedActionClaims([{ role: 'user', content: 'kod-review dosyasını oku' }], 'Okudum.')).toEqual([]);
  });
});

describe('GUARD-REV-1 guardRevision', () => {
  it('desteksiz iddia yoksa metin aynen döner (yeniden yazım çağrılmaz)', async () => {
    let called = false;
    expect(await guardRevision(skillConv, 'Tahmin: Q1 200k (varsayım).', async () => { called = true; return 'x'; })).toBe('Tahmin: Q1 200k (varsayım).');
    expect(called).toBe(false);
  });
  it('düzeltmede arama uydurulduysa Claude yeniden yazar', async () => {
    process.env['REVIEW_MODELS'] = 'claude:sonnet,models/a'; resetConfig();
    expect(await guardRevision(skillConv, FAKE, async () => 'Arama yapmadım; varsayımla: HP önde olabilir.')).toBe('Arama yapmadım; varsayımla: HP önde olabilir.');
  });
  it('yeniden yazım da uydurursa iddia cümleleri çıkarılır', async () => {
    const out = await guardRevision(skillConv, `${FAKE} Tahmin varsayımdır.`, async () => FAKE);
    expect(out).not.toMatch(/web araması/i);
    expect(out).toContain('Tahmin varsayımdır.');
  });
});

describe('buildFeedback', () => {
  it('sorunları listeler ve kullanıcıdan gelmediğini belirtir', () => {
    const f = buildFeedback(['MADDE: 2.2 %6']);
    expect(f).toContain('- MADDE: 2.2 %6');
    expect(f).toMatch(/not written by the user/);
  });
});

describe('REVIEW-REST-1 reviewStateless', () => {
  const draft = { text: 'Gecikme cezası yok.', toolCalls: [] as unknown[] };
  const issuesCritic = async (): Promise<string> => 'MADDE: binde 3 gecikme cezası | YOK';
  const okCritic = async (): Promise<string> => 'TAMAM';

  it('sorun varsa taslak + denetim notuyla yeniden üretir', async () => {
    let extra: AnthropicMessage[] = [];
    const out = await reviewStateless(conv, draft, async (e) => { extra = e; return { text: 'Binde 3 gecikme cezası var.', toolCalls: [] }; }, issuesCritic);
    expect(out.text).toBe('Binde 3 gecikme cezası var.');
    expect(extra[0]).toEqual({ role: 'assistant', content: 'Gecikme cezası yok.' });
    expect(String(extra[1]!.content)).toContain('binde 3 gecikme cezası');
  });

  it('temizse yeniden üretmez', async () => {
    let called = false;
    const out = await reviewStateless(conv, draft, async () => { called = true; return draft; }, okCritic);
    expect(out).toBe(draft);
    expect(called).toBe(false);
  });

  it('araç çağrılı cevap ve özetleme isteği denetlenmez', async () => {
    const withTools = { text: 'okuyorum', toolCalls: [{ id: 'x' }] };
    expect(await reviewStateless(conv, withTools, async () => { throw new Error('çağrılmamalı'); }, issuesCritic)).toBe(withTools);
    const compact: AnthropicMessage[] = [...conv, { role: 'user', content: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.' }];
    expect(isCompactionRequest(compact)).toBe(true);
    expect(await reviewStateless(compact, draft, async () => { throw new Error('çağrılmamalı'); }, issuesCritic)).toBe(draft);
  });

  it('fail-open: yeniden üretim hata verirse ya da boş dönerse taslak gider', async () => {
    expect(await reviewStateless(conv, draft, async () => { throw new Error('429'); }, issuesCritic)).toBe(draft);
    expect(await reviewStateless(conv, draft, async () => ({ text: ' ', toolCalls: [] }), issuesCritic)).toBe(draft);
  });
});

describe('AUDIO-NUM-1 rewriteFromEvidence', () => {
  const withClaude = (): void => { process.env['REVIEW_MODELS'] = 'claude:sonnet,models/a'; resetConfig(); };

  it('çelişki varsa Claude kanıttan yazar; istem kanıt + taslak + sorunları içerir', async () => {
    withClaude();
    let seen = { model: '', prompt: '' };
    const out = await rewriteFromEvidence(conv, 'Gecikme cezası binde 5.', ['ÇELİŞKİ: taslak binde 5 diyor, kanıt binde 3'],
      async (model, prompt) => { seen = { model, prompt }; return 'Gecikme cezası binde 3.'; });
    expect(out).toBe('Gecikme cezası binde 3.');
    expect(seen.model).toBe('sonnet');
    expect(seen.prompt).toContain('binde 3 gecikme cezası');
    expect(seen.prompt).toContain('# PROBLEMS');
  });

  it('yalnız eksik madde (çelişki yok) → null, Gemini turu kalır', async () => {
    withClaude();
    expect(await rewriteFromEvidence(conv, 'x', ['MADDE: eksik'], async () => 'y')).toBeNull();
  });

  it('çelişki + yapılmamış iş (dosya okunmamış) → null: araçlı Gemini turu eksik işi yapar', async () => {
    withClaude();
    let called = false;
    const out = await rewriteFromEvidence(conv, 'Plan okunamadı, bilinmiyor.',
      ['ÇELİŞKİ: taslak dosya yok diyor', 'ARAŞTIRMA: plan/ACTIVE_PLAN.md hiç okunmadı', 'SORU: açık işler | YOK'],
      async () => { called = true; return 'z'; });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it('zincirde Claude yoksa ya da çağrı hata verirse null (fail-open)', async () => {
    expect(await rewriteFromEvidence(conv, 'x', ['ÇELİŞKİ: z'], async () => 'y')).toBeNull(); // REVIEW_MODELS=models/a,models/b
    withClaude();
    expect(await rewriteFromEvidence(conv, 'x', ['ÇELİŞKİ: z'], async () => { throw new Error('kota'); })).toBeNull();
    expect(await rewriteFromEvidence(conv, 'x', ['ÇELİŞKİ: z'], async () => '  ')).toBeNull();
  });
});
