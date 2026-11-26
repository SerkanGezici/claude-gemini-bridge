"""EVAL-2 test MCP sunucusu (stdio, stdlib): stok_sorgula aracı sabit sahte veri döndürür,
her çağrıyı argv[1] dosyasına yazar (puanlayıcı aracın gerçekten çağrıldığını oradan görür)."""
import sys, json
TOOLS=[{"name":"stok_sorgula","description":"Şirket depo stok sistemi: ürün kodu verilince depodaki adet ve raf yerini döndürür.",
 "inputSchema":{"type":"object","properties":{"urun_kodu":{"type":"string"}},"required":["urun_kodu"]}}]
def send(o): sys.stdout.write(json.dumps(o)+"\n"); sys.stdout.flush()
for line in sys.stdin:
    try: m=json.loads(line)
    except Exception: continue
    mid=m.get("id"); meth=m.get("method")
    if meth=="initialize":
        send({"jsonrpc":"2.0","id":mid,"result":{"protocolVersion":m["params"].get("protocolVersion","2024-11-05"),"capabilities":{"tools":{}},"serverInfo":{"name":"stok","version":"1"}}})
    elif meth=="tools/list": send({"jsonrpc":"2.0","id":mid,"result":{"tools":TOOLS}})
    elif meth=="tools/call":
        code=m["params"]["arguments"].get("urun_kodu","")
        open(sys.argv[1],"a").write(code+"\n")
        send({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":f"{code}: 4173 adet, raf K-19"}]}})
    elif mid is not None: send({"jsonrpc":"2.0","id":mid,"result":{}})
