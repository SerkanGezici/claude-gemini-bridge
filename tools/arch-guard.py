#!/usr/bin/env python3
"""ARCH-0 mimari kapı (yalnız stdlib).

docs/arch-rules.json'daki her kural için eşleşen dosyaları tarar. Bir dosya kuralı
ihlal ediyorsa ve ne `allow` ne de docs/arch-baseline.json'da değilse → çıkış 1.
Baseline'da olup artık ihlal etmeyen dosyalar raporlanır (baseline'dan silinmeli).

Kullanım: python3 tools/arch-guard.py [--write-baseline]
  --write-baseline yalnız İLK kurulum içindir; sonrası Serkan onayı + ADR ister.
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES = os.path.join(ROOT, "docs", "arch-rules.json")
BASELINE = os.path.join(ROOT, "docs", "arch-baseline.json")


def violations() -> dict:
    with open(RULES, encoding="utf-8") as f:
        rules = json.load(f)["rules"]
    out = {}
    for r in rules:
        rx = re.compile(r["pattern"])
        hits = []
        for p in sorted(glob.glob(os.path.join(ROOT, r["files"]), recursive=True)):
            rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
            if rel in r["allow"]:
                continue
            with open(p, encoding="utf-8", errors="replace") as f:
                if rx.search(f.read()):
                    hits.append(rel)
        out[r["id"]] = hits
    return out


def main() -> int:
    found = violations()
    if "--write-baseline" in sys.argv:
        with open(BASELINE, "w", encoding="utf-8", newline="\n") as f:
            json.dump(found, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"baseline yazıldı: {sum(len(v) for v in found.values())} ihlal")
        return 0
    base = {}
    if os.path.exists(BASELINE):
        with open(BASELINE, encoding="utf-8") as f:
            base = json.load(f)
    bad, fixed = [], []
    for rid, hits in found.items():
        allowed = set(base.get(rid, []))
        bad += [f"{rid}: {h}" for h in hits if h not in allowed]
        fixed += [f"{rid}: {b}" for b in sorted(allowed) if b not in hits]
    for x in fixed:
        print(f"ℹ düzelmiş, baseline'dan sil: {x}")
    if bad:
        for x in bad:
            print(f"✗ yeni mimari ihlal: {x}")
        print("Kuralı gevşetme; ihlali düzelt (yerleşik yol: docs/ARCHITECTURE.md).")
        return 1
    print(f"arch-guard temiz ({sum(len(v) for v in found.values())} baseline ihlali, yeni yok)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
