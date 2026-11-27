import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { OFFICE_HOOK_PY, OFFICE_TOOLS_PY, PROJECT_ROOT, docenvPython } from './paths.js';
import { getConfig } from './config.js';
import { docenvReady } from './docenv.js';
// LIVE-22: Claude Code'a geçirilecek arg listesi.
// Eski kod '--allow-dangerously-skip-permissions' enjekte ediyordu — bu bayrak
// bypass'ı yalnız OPSİYON olarak açar, AKTİF ETMEZ (CLI help: "as an option,
// without it being enabled by default"). Sonuç: npm start oturumları kullanıcının
// default permission moduna düşüyordu; auto mode'da her Bash çağrısı opus
// sınıflandırıcısına gidiyor, sınıflandırıcı isteği köprü üzerinden Gemini'ye
// düşünce verdict formatı stokastik bozuluyor → Bash günlük kullanımda bloke
// (2026-06-12 canlı E2E kanıtı). index.ts'in belgelenmiş niyeti "her zaman
// bypass" (claude-super davranışı) — gerçek bypass bayrağı bu.
const BRIDGE_FLAGS = new Set([
    '--bridge-only',
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--setup-docs',
]);
// SEC-GUARD-BRIDGE (2026-07-14): Köprü, index.ts:137'de ANTHROPIC_API_KEY'i
// bridgeToken'a (köprünün kendi paylaşılan gizli anahtarı — GERÇEK Anthropic key
// DEĞİL) set eder. Bir plugin/hook KENDİ out-of-band Anthropic çağrısını yaparsa
// (ANTHROPIC_API_KEY okuyup api.anthropic.com'a gider) bu sahte anahtarla auth'a
// takılır. security-guidance tam bunu yapıyor: her UserPromptSubmit/Stop'ta
// review_api ile AI güvenlik-review çağrısı → Windows'ta ~16s timeout/retry (401)
// → her turn 16s gecikme (debug 85db2350). claude-super'da (gerçek Claude Max
// auth) sorun YOK — o yüzden plugin'i GLOBAL kapatmak yanlış (claude-super'ı da
// gereksiz etkiler). Çözüm: YALNIZ köprü oturumlarında `--settings` ile kapat;
// claude-super'da açık kalır. Aynı liste, köprü bağlamında kendi Anthropic
// çağrısını yapan başka plugin'ler için genişletilebilir.
const BRIDGE_DISABLED_PLUGINS = ['security-guidance@claude-plugins-official'];
// 'claude-in-chrome' adı Claude Code'da ayrılmış: o adla verilen sunucu sessizce
// yok sayılıyor (canlı: ToolSearch 0 araç). Başka adla bağlanınca çalışıyor.
export const CHROME_MCP_NAME = 'chrome';
export const CHROME_MCP_CONFIG = JSON.stringify({
    mcpServers: {
        [CHROME_MCP_NAME]: {
            command: 'claude',
            args: ['--claude-in-chrome-mcp'],
            // Claude Code bypass kipinde kendi Chrome sunucusuna bu değişkeni verir
            // (ikilide: bypass → CLAUDE_CHROME_PERMISSION_MODE=skip_all_permission_checks).
            // Köprü her zaman bypass'ta; değişken yoksa eklenti her sitede "Allow" sorar
            // ve tıklayan olmadığı için araç zaman aşımına düşer (canlı 2026-11-26).
            env: { CLAUDE_CHROME_PERMISSION_MODE: 'skip_all_permission_checks' },
        },
    },
});
// CU-1 (ADR-0003): Gemini computer use ile masaüstü görevi — paketle gelen stdio
// MCP sunucusu. Yalnız Windows/WSL (eylemler pwsh.exe ile). Kapatma: BRIDGE_COMPUTER_USE=off.
export const COMPUTER_MCP_NAME = 'computer';
export function computerMcpServer() {
    return { command: process.execPath, args: [join(PROJECT_ROOT, 'dist', 'computer-use-mcp.js')] };
}
export function computerUseAvailable() {
    if (!getConfig().computerUse)
        return false;
    return process.platform === 'win32' || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
}
// ADR-0004: belge inspect/compare araçları — docenv Python'u ile. Kapatma: BRIDGE_OFFICE_MCP=off;
// docenv kurulu değilse (claude-gemini --setup-docs) bağlanmaz.
export const OFFICE_MCP_NAME = 'office';
export function officeMcpServer() {
    return { command: process.execPath, args: [join(PROJECT_ROOT, 'dist', 'office-mcp.js')] };
}
export function officeToolsAvailable() {
    return getConfig().officeMcp && docenvReady();
}
// ADR-0004 uygulama notu: O1'de Gemini araçları bazen hiç çağırmadı (kendi betiği yalnız ilk
// 10 satırı okudu, 7/11); araçları kullandığı koşu 11/11. Analiz ve karşılaştırma bu yüzden
// modelin isteğine bırakılmaz: istekte belge yolu varsa rapor bağlama eklenir (UserPromptSubmit),
// tur sonunda yazılan belge orijinalle karşılaştırılır, SORUN varsa tur kapanmaz (Stop, en fazla 2).
export function officeHooks(python = docenvPython(), script = OFFICE_HOOK_PY) {
    const cmd = (mode) => [{ hooks: [{ type: 'command', command: `"${python}" -I "${script}" ${mode}`, timeout: 60 }] }];
    return { UserPromptSubmit: cmd('prompt'), Stop: cmd('stop') };
}
/** Köprünün Claude Code'a verdiği MCP sunucuları (boşsa null). */
export function bridgeMcpConfig() {
    const servers = {};
    if (getConfig().chromeMcp)
        Object.assign(servers, JSON.parse(CHROME_MCP_CONFIG).mcpServers);
    if (computerUseAvailable())
        servers[COMPUTER_MCP_NAME] = computerMcpServer();
    if (officeToolsAvailable())
        servers[OFFICE_MCP_NAME] = officeMcpServer();
    return Object.keys(servers).length ? JSON.stringify({ mcpServers: servers }) : null;
}
export const COMPUTER_GUIDE_PROMPT = 'Görsel, çok adımlı masaüstü işi (windows-mcp ile konum bulmanın zor olduğu GUI) için ' +
    '`mcp__computer__computer_task` aracına tek, somut bir hedef ver; sonucu dönen özet ve ekran görüntüsüyle doğrula.';
export const BRIDGE_AUTO_COMPACT_WINDOW = 100_000;
// Claude Code'un modelSettings anahtarları (kullanıcı ayarında görülenler + aileler).
const BRIDGE_MODEL_KEYS = [
    'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2',
];
/** Bilinen anahtarlar + kullanıcının ~/.claude/settings.json modelSettings anahtarları
 *  (yeni model eklenince de ezilsin). Okunamazsa yalnız bilinenler. */
export function bridgeModelKeys(settingsPath = join(homedir(), '.claude', 'settings.json')) {
    const keys = new Set(BRIDGE_MODEL_KEYS);
    try {
        const ms = JSON.parse(readFileSync(settingsPath, 'utf8')).modelSettings;
        for (const k of Object.keys(ms ?? {}))
            keys.add(k);
    }
    catch { /* ayar yok/bozuk — bilinenlerle devam */ }
    return [...keys];
}
// RECOVER-1: Görev için gereken bir komut satırı aracı kurulu değilse, tek bir
// "command not found" Claude'u durdurup kullanıcıyı "devam et" demeye zorlamasın.
// claude-gemini hangi proje dizininde açılırsa açılsın (PATHS-1) bu kural gelsin
// diye buildClaudeArgs'a — Claude Code'a arg enjekte eden TEK merkez — eklenir.
// Bypass-permissions zaten aktif (yukarıdaki unshift) → apt-get/pip/npm onaysız
// çalışır, kural fiilen uygulanabilir. Metin kısa: Gemini'nin systemInstruction
// bütçesine (24k cap) girer; LIVE-9 "soru açlığı"na karşı yağ yok.
// 2026-06-16 olayı: pandoc kurulu değildi → komut 670ms'de "command not found"
// ile patladı → tur kapandı, Serkan "devam et" demek zorunda kaldı (debug log
// 78d7a916: 14:14:11 Bash error → 14:14:12 Stop hook; çözüm Turn 2'de apt-get).
// OCR-1 (2026-06-17): RECOVER-1 araçları kurdu (pandoc/poppler-utils) AMA taranmış
// (görüntü) PDF'te pdftotext boş döndü; model `ocrmypdf` "command not found" alınca
// TEK denemede pes edip OCR yapmadan "tercüme eşleşiyor (PDF Tahmini)" diye UYDURDU
// (debug log 9b9577a4, canlı). Resmi belge doğrulamada tehlikeli. İki kural eklendi:
// (a) PDF/görsel boşsa OCR fallback (ocrmypdf/tesseract kur+kullan / pdftoppm+görsel),
// (b) gerçekten okuyamıyorsan UYDURMA — dürüstçe söyle.
export const TOOL_RECOVERY_PROMPT = 'Bir görevi tamamlamak için gereken komut satırı aracı kurulu değilse ' +
    '(komut "command not found" / "not installed" ile başarısız olursa — pandoc, ' +
    'ffmpeg, jq, unzip, imagemagick, ocrmypdf, tesseract vb.), DURMA ve kullanıcıdan ' +
    'onay/"devam et" bekleme. Aracı aynı turda kur, sonra asıl göreve kesintisiz ' +
    'devam et. ' +
    // RECOVER-1 güvenlik daraltması: pip/npm keyfi kütüphane kanalı (typosquat/
    // supply-chain) sistem paket yöneticisinden riskli — niyet "eksik CLI aracı".
    'Tercihen sistem paket yöneticisini kullan (apt-get/brew); pip/npm ile yalnız ' +
    'iyi bilinen, doğrulanmış paket adlarını kur. ' +
    // OCR-1: taranmış PDF/görsel → OCR fallback + anti-halüsinasyon.
    'Bir PDF veya görselden metin çıkaramazsan (pdftotext boş döndü = taranmış/' +
    'görüntü belge), pes etme: OCR kullan — ocrmypdf ya da tesseract (gerekirse kur; ' +
    'dil paketiyle, ör. Ukraynaca için ukr), ya da pdftoppm ile sayfayı görüntüye ' +
    'çevirip GÖRSEL olarak oku. Bir belgeyi gerçekten okuyamıyor veya ' +
    'karşılaştıramıyorsan SONUCU UYDURMA, "tahmini" diye sunma, "eşleşiyor/doğru" ' +
    'deme — neyi neden okuyamadığını açıkça söyle. ' +
    // XLSX-HANG-1 (2026-11-25, ORCH-0 W2): model .xlsx'i `pandoc` ile okumaya
    // çalıştı → pandoc formatı çıkaramayıp dosyayı markdown sanarak SONSUZA
    // kadar takıldı; Claude Code 120sn sonra arka plana aldı, `claude -p` o
    // arka plan işi yüzünden cevaptan sonra da kapanmadı (7dk). Ortamda pandas
    // NumPy 1.x/2.x uyumsuzluğuyla çöküyordu → model alternatif arıyordu.
    // PY-AS-BASH-1 (2026-11-26, sınav O3): model Python kodunu Bash komutu olarak gönderdi
    // ("import os …"); Bash'te `import` ImageMagick ekran yakalama komutudur, tıklama bekleyip
    // asılı kaldı → 120 sn sonra arka plana alındı, `claude -p` 420 sn'de öldürüldü.
    'Python kodunu Bash komutu olarak gönderme (Bash\'te `import` ImageMagick ekran yakalama komutudur ve ' +
    'asılı kalır); Python\'u dosyaya yazıp ya da `python3 -c` ile çalıştır. ' +
    'Excel (.xlsx/.xls) dosyalarını python3 + openpyxl ile oku (pandas gerekmez; tüm sayfalar: ' +
    'wb.sheetnames). pandoc Excel okumaz. Takılabilecek komutları (format dönüştürme, ağ, ' +
    'kurulum) `timeout 60 <komut>` ile çalıştır; bir yöntem başarısız olursa aynısını ' +
    'tekrarlama, farklı bir yola geç. ' +
    // EVAL-2 R1/R5: model kullanıcının yazdığı yolu değil alışkanlık yolunu
    // (PLANS/…) denedi, bulamayınca "bilinmiyor" dedi; başka görevde komutu
    // çalıştırmak yerine kullanıcıya "şu komutu çalıştır" diye bıraktı.
    // ACT-TEXT-1: sınav W8'de (1/4) model dosya oluşturma + git komutlarını araç
    // çağırmadan cevap METNİ olarak yazdı; hiçbir dosya oluşmadı.
    'Dosya oluşturma/değiştirme ya da komut çalıştırma isteğinde komutları ve dosya ' +
    'içeriğini cevap metni olarak yazma; Write/Edit/Bash araçlarıyla gerçekten uygula. ' +
    'Kullanıcının yazdığı dosya yolunu birebir kullan; bulunamazsa Glob/ls ile ara, ' +
    'tek başarısız denemede "bilinmiyor" deme. Kendin çalıştırabileceğin bir komutu ' +
    'kullanıcıya "şunu çalıştır" diye bırakma — çalıştır ve sonucu ver. ' +
    'Yalnızca kurulum gerçekten başarısız olursa, ağ erişimi yoksa ya da işlem geri ' +
    'alınamaz/tehlikeliyse dur ve kullanıcıya GERÇEK sebebiyle bildir.';
// SKILL-GUARD-1 (2026-06-17): Köprü arkasındaki Gemini, bir DOSYA analizi isteğini
// (.docx/.pdf/görsel "incele/analiz et") `/analyze` (codebase) skill'ine yanlış
// eşleyip 4 background team agent fırlattı → mailbox deadlock → 17.5 saat zombi
// (oturum b3791a1f). Sebep: using-superpowers'ın "%1 → MUTLAKA skill çağır" baskısı
// + Gemini'nin zayıf skill disiplini. Bu negatif kural CAYDIRICI (A katmanı);
// analyze.md guard'ı (B katmanı) skill yine de çağrılırsa durdurur — defense-in-depth.
//
// GAP-SKILL-2 (2026-06-19): Köprü arkasındaki Gemini, selamlaşma/sohbet/basit
// soru dahil neredeyse her mesajda `Skill(using-superpowers)` yüklüyor (canlı
// kanıt: "merhaba"/"nasılsın" → using-superpowers). Sebep aynı: superpowers'ın
// "%1 → MUTLAKA skill çağır" baskısı + zayıf disiplin. Zararsız ama her seferinde
// ~2k token + 1 tur israfı; üstelik using-superpowers SessionStart hook'uyla zaten
// enjekte ediliyor → tekrar yükleme sıfır yeni bilgi. Caydırıcı (stokastik).
export const SKILL_GUARD_PROMPT = 'Bir DOSYA (.pdf/.docx/.xlsx/görsel) okuma, özetleme, çeviri veya analiz isteği ' +
    'bir CODEBASE/proje analizi DEĞİLDİR. Böyle bir istekte `/analyze`, `/fullscan`, ' +
    '`/archscan`, `/devscan` gibi kod-tabanı skill\'lerini ÇAĞIRMA ve arka planda ' +
    'analiz ajanı/takımı (team / background agent) BAŞLATMA. Bunun yerine dosyayı ' +
    'doğrudan oku/dönüştür (Read, pandoc, pdftotext, OCR) ve içeriğini özetle. ' +
    'Kod-tabanı analiz skill\'lerini yalnız kullanıcı AÇIKÇA bir projeyi/depoyu/' +
    'mimariyi analiz etmeni isterse kullan. ' +
    '`using-superpowers` skill\'i oturum başında ZATEN otomatik enjekte edildi — ' +
    'onu `Skill` tool\'uyla TEKRAR YÜKLEME (sıfır yeni bilgi, boşa token). ' +
    'Selamlaşma, sohbet veya basit bir soruda (ör. "merhaba", "nasılsın", "2+2") ' +
    'HİÇBİR skill yükleme; doğrudan cevap ver. Skill yalnız gerçekten o yeteneği ' +
    'gerektiren açık bir görevde yüklenir. ' +
    // SKILL-EXPLICIT-1 (2026-11-26 skill taraması): "chrome-browser skill'ini yükle" denince
    // Gemini skill'i atlayıp doğrudan mcp__chrome araçlarını kullandı; yukarıdaki caydırıcı
    // kurallar açık isteği kapsamıyordu.
    'Kullanıcı bir skill\'i ADIYLA istediğinde ("X skill\'ini kullan/yükle", `/X`, `ad:alt-ad`) ' +
    'yukarıdaki kısıtlar geçmez: işe başlamadan ÖNCE `Skill` aracıyla o skill\'i yükle ve ' +
    'talimatlarına göre ilerle — aynı işi yapan araçlar doğrudan erişilebilir olsa bile ' +
    '(ör. tarayıcı skill\'i istendiyse önce skill, sonra mcp__chrome araçları). ' +
    // SKILL-NAME-1 (2026-11-27): Gemini `firecrawl-cli:scrape` gibi alt-ad uydurdu ya da skill'i
    // ToolSearch'te arayıp "skill bulunamadı" dedi.
    'Skill aracının `skill` alanına kullanıcının yazdığı adı BİREBİR ver (alt-ad ya da ön ek uydurma); ' +
    'skill\'ler ToolSearch\'te görünmez, orada arama. ' +
    // ACT-CLAIM-1 (2026-11-26 skill taraması, deep-research): Gemini `ToolSearch select:WebSearch`
    // çağırdı (WebSearch zaten yüklü olduğu için sonuç boş), aramayı hiç yapmadan "web araması
    // gerçekleştirildi" diye sonuç uydurdu.
    'ToolSearch bir aracı yalnız YÜKLER, çalıştırmaz: yükledikten sonra aracın kendisini çağır. ' +
    'WebSearch, WebFetch, Bash, Read, Write, Edit, Skill zaten yüklüdür; onlar için ToolSearch kullanma. ' +
    'Bir işi (arama, dosya yazma, komut, betik) yaptığını YALNIZ o işi yapan aracı bu turda gerçekten ' +
    'çağırıp sonucunu gördüysen söyle; sonuç bilgisi yalnız araç çıktısından gelir. Skill bir betik ya da ' +
    'komut çalıştırmanı söylüyorsa (ör. `python3 scripts/…`), onu Bash ile çalıştır. ' +
    // ANSWER-SHAPE-1: canlı E2E'de 8 cevabın 3'ü tek bilgilik soruya CLAUDE.md'nin
    // uzun-iş rapor başlıklarını ekledi; 1 cevap yalnız ürün kodunu söyledi.
    'Araç sonucundan sonra kullanıcının sorduğu her şeyi sonuçtaki somut değerlerle ' +
    '(sayı, ad, yer) tam cümleyle cevapla; yalnız kimlik/kod tekrarlayıp bırakma. ' +
    // ATTR-LEAK-1: Claude Code'un commit atıf talimatı düz cevaba sızdı (Q1 3 koşunun 1'i:
    // "…Beşiktaş ile. Co-Authored-By: Claude …").
    'Co-Authored-By / Claude-Session atıf satırlarını yalnız git commit mesajına ve PR açıklamasına yaz; ' +
    'normal cevaplara asla ekleme. ' +
    'Rapor başlıkları (ör. "Senden beklenen / Değişenler / Bulunanlar") yalnız uzun, ' +
    'çok adımlı işlerin sonunda kullanılır; tek bilgilik soruda kullanma.';
// DESKTOP-1: canlı testte Gemini windows-mcp'de Snapshot almadan Type çağırdı
// ("Either loc or label must be provided") ve Ctrl+S/Ctrl+W'yi hedef pencereyi
// doğrulamadan gönderdi. Serkan masaüstü işini onayladı (2026-11-26).
export const DESKTOP_GUIDE_PROMPT = 'Masaüstü işinde (windows-mcp): önce Snapshot al; Click/Type çağrılarına Snapshot\'taki ' +
    'loc (koordinat) ya da label değerini ver. Kısayol tuşu (Ctrl+S, Ctrl+W, Alt+F4) göndermeden ' +
    'önce odaktaki pencerenin hedef pencere olduğunu Snapshot ile doğrula; iş bitince sonucu ' +
    'yine Snapshot ya da dosya içeriğiyle kontrol et. Kullanıcının başka pencerelerine dokunma.';
// BROWSER-1: Gemini ToolSearch'te ilk bulduğu tarayıcı aracını (chrome-devtools)
// seçiyordu; o ayrı, oturumsuz tarayıcı açar ve kullanıcı kuralı onu yasaklar.
export const BROWSER_GUIDE_PROMPT = 'Web sayfası açma, okuma, form doldurma, tıklama gibi tarayıcı işlerinde kullanıcının ' +
    'kendi Chrome\'una bağlı `mcp__chrome__*` araçlarını kullan (gerekirse ToolSearch ' +
    'sorgusu: "+chrome tabs"); önce tabs_context_mcp, sonra tabs_create_mcp ile yeni sekme. ' +
    // BROWSER-TAB-1 (2026-11-26 skill taraması): Gemini example.com'u kullanıcının açık
    // "Yeni Sekme"sinde açıp o sekmeyi kapattı, kendi açtığı sekmeyi açık bıraktı.
    'Yalnız tabs_create_mcp\'nin DÖNDÜRDÜĞÜ tabId ile çalış (navigate, okuma, kapatma); kullanıcının ' +
    'önceden açık sekmelerinde gezinme ve onları ASLA kapatma — boş "Yeni Sekme" bile kullanıcınındır. ' +
    'chrome-devtools ve Playwright ayrı, oturumsuz tarayıcı açar; kullanıcı açıkça istemedikçe kullanma.';
// OFFICE-1 (2026-11-26): Serkan'ın fiyat listesi isteğinde Gemini dosyaya hiç
// bakmadan dönüştürme betiği yazdı: yalnız 1. satırı başlık saydı (sayfa içinde
// tekrar eden blok başlıklarını atladı), satırları silip değerlerden yeniden kurdu
// (USD biçimi, kalınlık, renk, genişlik gitti), "korundu" dedi; şikâyet gelince
// biçimi tamamen atan "temiz" dosya üretti. Aynı görevde Claude yerinde düzenleyip
// biçimi korudu (sınav O1). Kural: önce analiz, yerinde düzenleme, karşılaştırmalı doğrulama.
export const OFFICE_EDIT_PROMPT = 'Var olan bir dosyayı (Excel, Word, PowerPoint, PDF, fotoğraf) DEĞİŞTİRME isteğinde şu sırayı izle. ' +
    '(1) ÖNCE ANALİZ: hiçbir şeyi değiştirmeden dosyanın tamamını betikle incele ve bulduğunu kısaca yaz. ' +
    'Excel\'de her sayfanın her dolu satırını dök: sayfa içinde tekrar eden blok başlık satırları, ara başlıklar, ' +
    'değeri boş satırlar, sayı biçimleri (para birimi, ör. [$$-409]#,##0), kalın/renkli hücreler, sütun genişlikleri, ' +
    'birleştirilmiş hücreler, formüller. Yalnız 1. satırı başlık sayma. Word\'de stiller, tablolar, üst/alt bilgi; ' +
    'PDF\'te sayfa sayısı, metin mi taranmış mı, form alanları; fotoğrafta boyut, biçim, EXIF. ' +
    '(2) YORUM: belirsiz ifadeyi (ör. "sütunları sırala", "… olarak kaydet") nasıl anladığını tek cümleyle yaz ve ' +
    'makul yorumla devam et. ' +
    '(3) YERİNDE DÜZENLE: dosyayı değerlerden yeniden kurma. Satırları silip baştan yazmak, pandas ile yazmak ya da ' +
    '"temiz yeni dosya" üretmek para birimini, rengi, kalınlığı, genişlikleri ve stilleri yok eder. Excel\'de openpyxl ile ' +
    'yalnız gereken hücrelere dokun: değeri taşıdığın hücrenin stilini de taşı (cell._style ya da number_format, font, ' +
    'fill, border, alignment), yeni hücreye komşu hücrenin stilini kopyala, column_dimensions genişliklerini içerikle ' +
    'birlikte kaydır. Word\'de mevcut paragraf ve run stillerini koru; PDF\'i görüntüye çevirip yeniden üretme; ' +
    'fotoğrafta EXIF\'i ve kaliteyi koru. Orijinalin üzerine yazma; kullanıcının verdiği adla (yoksa "_duzenlendi" ' +
    'ekiyle) aynı klasöre kaydet. ' +
    '(4) DOĞRULA: kaydettikten sonra orijinal ile yeni dosyayı betikle karşılaştır: dokunulmaması gereken her ' +
    'hücrenin/paragrafın değeri ve biçimi aynı mı, istenen değişiklik her yerde (her sayfada, her blokta) yapıldı mı, ' +
    'hesaplanan değerler kurala uyuyor mu. Fark bulursan düzelt ve yeniden karşılaştır. Raporda bu karşılaştırmanın ' +
    'sonucunu yaz; kontrol etmediğin bir şeyi "korundu" deme. Kullanıcı dosyanın hatalı açıldığını söylerse biçimi ' +
    'atıp "temiz" dosya üretme; sebebi bul.';
// ADR-0004: OFFICE_EDIT_PROMPT'un belirleyici araçlarla uygulanması. O1'de yalnız talimatla
// köprü %82'de kaldı (blok başlığı atlama, para birimi biçimi kaybı); compare bu farkları
// SORUN satırı olarak modele ve denetçiye gösterir.
export function officeToolsPrompt(python = docenvPython(), script = OFFICE_TOOLS_PY) {
    return 'Belge araçları kurulu. Var olan bir Excel/Word/PowerPoint/PDF/görsel dosyasını değiştirirken: ' +
        '(a) değiştirmeden önce `mcp__office__office_inspect` ile dosyanın yapı raporunu al (araç yüklü değilse ToolSearch: ' +
        '"select:mcp__office__office_inspect,mcp__office__office_compare"); DİKKAT satırlarını planına kat. ' +
        `(b) belge betiklerini \`${python}\` ile çalıştır (openpyxl 3.1.5, python-docx, python-pptx, pypdf, PyMuPDF, Pillow kurulu); ` +
        'sistem python3\'ünü ya da pip install kullanma. ' +
        '(c) kaydettikten sonra `mcp__office__office_compare` ile orijinali ve yeni dosyayı karşılaştır; SORUN satırı kalmayana kadar ' +
        'düzelt ve yeniden karşılaştır; kullanıcıya karşılaştırmanın SONUÇ satırını bildir. ' +
        `Araçlara ulaşamazsan aynısı komutla: \`${python} -I ${script} inspect <dosya>\` ve \`… compare <orijinal> <yeni>\`.`;
}
/**
 * Bridge'e özel flag'ları ayıkla, gerçek bypass'ı başa, davranış talimatlarını
 * sona ekle: iki `--append-system-prompt` — (1) eksik-araç+OCR kurtarma
 * (TOOL_RECOVERY_PROMPT), (2) skill-guard (SKILL_GUARD_PROMPT).
 *
 * Kullanıcının kendi `--system-prompt` / `--append-system-prompt` argümanları
 * BRIDGE_FLAGS'te olmadığından FİLTRELENMEZ — korunur; bizim append'lerimiz
 * onların YANINA eklenir (Claude Code çoklu append'i birikimli uygular).
 */
export function buildClaudeArgs(args) {
    const claudeArgs = args.filter((a) => !BRIDGE_FLAGS.has(a));
    claudeArgs.unshift('--dangerously-skip-permissions');
    // APPEND-MERGE-1 (2026-06-18): Claude Code, aynı `--append-system-prompt`
    // flag'i birden çok kez verilince YALNIZCA SONUNCUSUNU uygular (önceki değer
    // ezilir — klasik "son değer kazanır" CLI davranışı). 2026-06-17'de SKILL_GUARD
    // ikinci append olarak eklenince, TOOL_RECOVERY (ilk append) SESSİZCE düştü:
    // RECOVER-1 + OCR-1 kuralları Gemini'ye HİÇ ulaşmadı (2026-06-18 dump kanıtı:
    // req `system` bloğunda yalnız SKILL_GUARD vardı; canlı TEST 16'da model
    // ImageMagick eksikken kurmadan "sen kur" deyip durdu). Bu yüzden TÜM köprü
    // kurallarını TEK append'te birleştiriyoruz — kullanıcının kendi
    // --append-system-prompt argümanları (varsa) yine korunur, bizimki onların
    // yanına ek bir blok olarak eklenir.
    // SEC-GUARD-BRIDGE: köprü bağlamında bozuk çalışan plugin'leri YALNIZ bu
    // oturum için kapat. `--settings` CLI-flag katmanı user-scope enabledPlugins'i
    // override eder (2026-07-14 canlı test: debug log "enabled=false; will NOT
    // register"). JSON string spawn arg olarak geçer (shell yok → quoting sorunu
    // yok). Kullanıcının kendi --settings'i varsa FİLTRELENMEZ (BRIDGE_FLAGS'te
    // değil) → korunur; --settings katmanları ek katman olarak birleşir.
    // LONGCTX-1: kullanıcının ayarındaki model bazlı autoCompactWindow (ör. 625K)
    // gerçek Claude'un 1M bağlamı içindir; köprüde Claude Code bu yüzden çok geç
    // özetliyor ve uzun oturumlar zayıf longcontext şeridine düşüyordu. Model
    // bazlı değer genel değeri ezdiği için her model anahtarı ayrıca yazılır.
    // 100000 = CLI'ın kabul ettiği en düşük pencere; gerçek tetik noktası
    // köprünün bildirdiği kullanımla ayarlanır (context-manager.reportedInputTokens).
    const settingsOverride = JSON.stringify({
        enabledPlugins: Object.fromEntries(BRIDGE_DISABLED_PLUGINS.map((p) => [p, false])),
        autoCompactWindow: BRIDGE_AUTO_COMPACT_WINDOW,
        // ATTR-LEAK-1: Claude Code'un "commit'e Co-Authored-By: Claude … ekle" talimatı Gemini
        // cevaplarına sızıyordu (skill taraması: google-workspace cevabının sonu). Köprüde yazar
        // Gemini olduğu için bu atıf zaten yanlış; boş atıf talimatı sistem isteminden kaldırır.
        attribution: { commit: '', pr: '' },
        modelSettings: Object.fromEntries(bridgeModelKeys().map((m) => [m, { autoCompactWindow: BRIDGE_AUTO_COMPACT_WINDOW }])),
        ...(officeToolsAvailable() ? { hooks: officeHooks() } : {}),
    });
    claudeArgs.push('--settings', settingsOverride);
    const rules = [TOOL_RECOVERY_PROMPT, SKILL_GUARD_PROMPT, DESKTOP_GUIDE_PROMPT, OFFICE_EDIT_PROMPT];
    // BROWSER-1: Claude Code claude-in-chrome'u yalnız Anthropic hesabıyla otomatik
    // bağlar; köprüde bu adım kapalı. Aynı sunucu kendi ikilisinde bağımsız stdio MCP
    // olarak var (`claude --claude-in-chrome-mcp`) ve köprüde çalışıyor (canlı test
    // 2026-11-26). Kapatma: BRIDGE_CHROME_MCP=off.
    const mcp = bridgeMcpConfig();
    if (mcp)
        claudeArgs.push('--mcp-config', mcp);
    if (getConfig().chromeMcp)
        rules.push(BROWSER_GUIDE_PROMPT);
    if (computerUseAvailable())
        rules.push(COMPUTER_GUIDE_PROMPT);
    if (officeToolsAvailable())
        rules.push(officeToolsPrompt());
    claudeArgs.push('--append-system-prompt', rules.join('\n\n'));
    return claudeArgs;
}
