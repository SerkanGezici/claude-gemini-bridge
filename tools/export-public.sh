#!/usr/bin/env bash
# Mirrors HEAD of this development repo into the public repo checkout as ONE new commit
# (the public repo has no development history). Paths marked export-ignore in
# .gitattributes (internal plan, eval results) are left out. Pushing is a separate step.
# Usage: tools/export-public.sh <public-repo-checkout>
set -euo pipefail
PUB="${1:?usage: tools/export-public.sh <public-repo-checkout>}"
SRC="$(git rev-parse --show-toplevel)"
[ -d "$PUB/.git" ] || { echo "not a git checkout: $PUB" >&2; exit 1; }
[ -z "$(git -C "$SRC" status --porcelain)" ] || { echo "commit your changes first (working tree not clean)" >&2; exit 1; }
VERSION="$(node -p "require('$SRC/package.json').version")"

find "$PUB" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$SRC" archive --format=tar HEAD | tar -x -C "$PUB"

# Guard: internal business names must never reach the public repo.
if grep -rIlE 'teslateknoloji|quadroaipilot|Quadro|alicankiraz' "$PUB" --exclude-dir=.git --exclude=export-public.sh; then
  echo "internal names found in the files above — export aborted" >&2; exit 1
fi

git -C "$PUB" add -A
if git -C "$PUB" diff --cached --quiet; then echo "nothing to export"; exit 0; fi
git -C "$PUB" -c user.name="Serkan Gezici" \
  -c user.email="129040971+SerkanGezici@users.noreply.github.com" \
  commit -q -m "v$VERSION (source: $(git -C "$SRC" rev-parse --short HEAD))"
echo "exported v$VERSION → $PUB (push with: git -C \"$PUB\" push)"
