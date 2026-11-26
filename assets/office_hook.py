#!/usr/bin/env python3
"""office_hook — belge analizini ve karşılaştırmasını modelin isteğine bırakmaz (ADR-0004).

Köprü bu betiği Claude Code hook'u olarak bağlar (docenv Python'u ile):
  prompt  (UserPromptSubmit): istekte geçen var olan belge yollarını bulur, her biri için
          office_inspect raporunu modelin bağlamına ekler, orijinalin kopyasını saklar.
  stop    (Stop): bu istekten sonra yazılmış/değişmiş aynı türdeki belgeleri saklanan
          orijinalle karşılaştırır; SORUN varsa turu kapatmaz (en fazla MAX_BLOCKS kez).
Girdi: hook JSON'u stdin'den. Hata durumunda sessizce geçer (fail-open).
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I betik dizinini eklemez
import office_tools as ot  # noqa: E402  # pyright: ignore[reportMissingImports]

EXTS = ("xlsx", "xlsm", "docx", "pptx", "pdf", "jpg", "jpeg", "png", "webp", "tif", "tiff")
MAX_FILES = 3
MAX_CONTEXT = 15_000
MAX_BLOCKS = 2


def state_dir(session: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", session or "nosession")[:80]
    return os.path.join(tempfile.gettempdir(), "claude-gemini-office", safe)


def find_paths(prompt: str, cwd: str) -> list:
    ext = "|".join(EXTS)
    cands = re.findall(rf'"([^"\n]+\.(?:{ext}))"', prompt, re.I)
    cands += re.findall(rf"'([^'\n]+\.(?:{ext}))'", prompt, re.I)
    cands += re.findall(rf"(?:(?<=\s)|^)([^\s\"']+\.(?:{ext}))\b", prompt, re.I | re.M)
    out = []
    for c in cands:
        p = ot.host_path(c.strip())
        if not os.path.isabs(p):
            p = os.path.join(cwd, p)
        p = os.path.normpath(p)
        if os.path.isfile(p) and p not in out:
            out.append(p)
    return out[:MAX_FILES]


def on_prompt(data: dict) -> None:
    cwd = data.get("cwd") or os.getcwd()
    sd = state_dir(data.get("session_id", ""))
    shutil.rmtree(sd, ignore_errors=True)  # önceki isteğin durumu ilgisiz turları etkilemesin
    paths = find_paths(data.get("prompt") or "", cwd)
    if not paths:
        return
    os.makedirs(sd, mode=0o700, exist_ok=True)  # kullanıcı belgelerinin kopyaları
    originals, parts = [], []
    for i, p in enumerate(paths):
        snap = os.path.join(sd, f"{i}_{os.path.basename(p)}")
        shutil.copy2(p, snap)
        originals.append({"path": p, "snapshot": snap, "kind": ot.kind_of(p)})
        try:
            rep = ot.INSPECT[ot.kind_of(p)](p) if ot.kind_of(p) in ot.INSPECT else ""
        except Exception as e:  # noqa: BLE001
            rep = f"(analiz edilemedi: {e})"
        parts.append(rep)
    with open(os.path.join(sd, "state.json"), "w", encoding="utf8") as f:
        json.dump({"t0": time.time(), "cwd": cwd, "originals": originals, "blocks": 0}, f)
    ctx = "\n\n".join(parts)
    if len(ctx) > MAX_CONTEXT:
        ctx = ctx[:MAX_CONTEXT] + "\n…[kırpıldı — tamamı için mcp__office__office_inspect]"
    head = ("[Köprü — belge analizi, otomatik] İstekte geçen dosya(lar)ın yapı raporu aşağıda. Değişiklik yapacaksan "
            "bu rapora göre plan yap (DİKKAT satırları kısıttır), yerinde düzenle, orijinalin üzerine yazma. "
            "Tur bitince köprü sonucu orijinalle otomatik karşılaştırır; SORUN çıkarsa düzeltmen istenir.\n\n")
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": head + ctx}},
                     ensure_ascii=False))


def changed_files(dirs: list, t0: float, kinds: set) -> list:
    """Yalnız orijinallerin klasöründe (alt klasör yok) istekten sonra yazılmış aynı türde belgeler."""
    found = []
    for d in dirs:
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for fn in names:
            p = os.path.join(d, fn)
            if fn.startswith("~$") or ot.kind_of(p) not in kinds or not os.path.isfile(p):
                continue
            try:
                if os.path.getmtime(p) > t0 and p not in found:
                    found.append(p)
            except OSError:
                pass
    return found[:10]


def on_stop(data: dict) -> None:
    sd = state_dir(data.get("session_id", ""))
    sp = os.path.join(sd, "state.json")
    if not os.path.isfile(sp):
        return
    with open(sp, encoding="utf8") as f:
        st = json.load(f)
    if st.get("blocks", 0) >= MAX_BLOCKS:
        return
    origs = st["originals"]
    kinds = {o["kind"] for o in origs}
    dirs = sorted({os.path.dirname(o["path"]) for o in origs})
    outputs = changed_files(dirs, st["t0"], kinds)
    if not outputs:
        return
    problems, summaries = [], []
    for out in outputs:
        best = None
        for o in origs:
            if o["kind"] != ot.kind_of(out) or o["kind"] not in ot.COMPARE:
                continue
            try:
                rep = ot.COMPARE[o["kind"]](o["snapshot"], out)
            except Exception as e:  # noqa: BLE001
                rep = f"SONUÇ: karşılaştırılamadı ({e})"
            sorun = [ln for ln in rep.splitlines() if ln.startswith("SORUN")]
            if best is None or len(sorun) < len(best[1]):
                best = (o, sorun)
        if best:
            summaries.append(f"{os.path.basename(out)} ↔ {os.path.basename(best[0]['path'])}: {len(best[1])} sorun")
            problems += [f"[{os.path.basename(out)}] {s}" for s in best[1]]
    if not problems:
        return
    st["blocks"] = st.get("blocks", 0) + 1
    with open(sp, "w", encoding="utf8") as f:
        json.dump(st, f)
    reason = ("[Köprü — otomatik belge karşılaştırması] Kaydedilen dosya orijinaliyle karşılaştırıldı: "
              + "; ".join(summaries) + ".\n" + "\n".join(problems[:30])
              + "\nBunlar istenmiş olamayacak kayıplar (biçim, kalınlık, dolgu, eksik blok, bozuk dosya). Yerinde düzelt "
                "(orijinal dosyaya dokunma), aynı adla yeniden kaydet ve mcp__office__office_compare ile doğrula.")
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))


def main() -> int:
    ot.force_utf8()
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))  # Windows boruları BOM ekleyebilir
        if mode == "prompt":
            on_prompt(data)
        elif mode == "stop":
            on_stop(data)
    except Exception as e:  # noqa: BLE001 — hook asla oturumu düşürmez
        print(f"office_hook: {type(e).__name__}: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
