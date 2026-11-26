// ADR-0004: `office` MCP sunucusu (stdio, satır başına bir JSON-RPC mesajı).
// stdout YALNIZ protokol içindir — console stderr'e yönlendirilir, çekirdek ondan sonra yüklenir.
import { createInterface } from 'readline';
for (const k of ['log', 'info', 'warn', 'debug'])
    console[k] = (...a) => console.error(...a);
const { handle, send } = await import('./office.js');
createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim())
        return;
    let m;
    try {
        m = JSON.parse(line.replace(/^\uFEFF/, ''));
    }
    catch {
        return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    void handle(m);
});
