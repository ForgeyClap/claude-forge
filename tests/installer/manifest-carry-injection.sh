#!/usr/bin/env bash
# Codex release gate RG-02 (2026-09-29): the carry-forward of a kept CLAUDE.md reads the OLD manifest, which is
# attacker-influenced input the moment a project is cloned or shared. A forged old entry whose "hash" tries to break
# out of its JSON string must neither inject an entry into the new manifest nor corrupt it. And a genuine old entry
# must still be carried, so a re-install keeps the project CLAUDE.md (the PR #4 regression).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
sha() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
has_entry() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit((j.files||[]).some((f)=>f.path===process.argv[2])?0:1)' "$1" "$2"; }

# 1. a forged old manifest entry for CLAUDE.md whose hash smuggles in a second entry
H1="$WORK/home1"; P1="$WORK/proj1"
mkdir -p "$H1" "$P1/.claude"
( cd "$P1" && git init -q && echo "# p" > README.md && echo "user notes" > notes.txt && echo "# my own rules" > CLAUDE.md )
NH=$(sha "$P1/notes.txt")
node -e '
  const evil = "bad\" }, { \"path\": \"notes.txt\", \"sha256\": \"" + process.argv[2];
  require("fs").writeFileSync(process.argv[1], JSON.stringify({ forge_version: "2.8.1", scope: "project", files: [{ path: "CLAUDE.md", sha256: evil }] }, null, 2));
' "$P1/.claude/.forge-install-manifest.json" "$NH"
HOME="$H1" bash "$REPO/install.sh" --project "$P1" --project-only --yes >"$WORK/out1.txt" 2>&1 || bad "install.sh exited non-zero on a forged manifest"
M1="$P1/.claude/.forge-install-manifest.json"
if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$M1" 2>/dev/null; then ok "the new manifest is valid JSON"; else bad "the new manifest is not valid JSON"; fi
if has_entry "$M1" notes.txt; then bad "a forged hash injected a notes.txt entry into the new manifest"; else ok "no injected entry reached the new manifest"; fi
if has_entry "$M1" CLAUDE.md; then bad "a CLAUDE.md entry with a forged hash was carried"; else ok "the forged CLAUDE.md entry was not carried"; fi
[ -f "$P1/notes.txt" ] && ok "notes.txt is untouched" || bad "notes.txt was moved or deleted"
[ -f "$P1/CLAUDE.md" ] && ok "the user's own CLAUDE.md is still in place" || bad "the user's own CLAUDE.md was moved"
# the "N file(s) recorded" line counts the entries actually written, so the skipped forged one is not counted
N1=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((j.files||[]).length))' "$M1" 2>/dev/null || echo "?")
if grep -qF ".forge-install-manifest.json ($N1 file(s) recorded for uninstall)" "$WORK/out1.txt"; then ok "the reported count matches the manifest ($N1 entries)"; else bad "the reported count does not match the manifest's $N1 entries"; fi

# 2. a genuine entry IS carried: install twice into a fresh project, CLAUDE.md stays on disk and in the manifest
H2="$WORK/home2"; P2="$WORK/proj2"
mkdir -p "$H2" "$P2"
( cd "$P2" && git init -q && echo "# p" > README.md )
HOME="$H2" bash "$REPO/install.sh" --project "$P2" --project-only --yes >/dev/null 2>&1 || bad "first install.sh exited non-zero"
HOME="$H2" bash "$REPO/install.sh" --project "$P2" --project-only --yes >/dev/null 2>&1 || bad "second install.sh exited non-zero"
[ -f "$P2/CLAUDE.md" ] && ok "a re-install keeps the Forge-written CLAUDE.md" || bad "a re-install moved the Forge-written CLAUDE.md away"
if has_entry "$P2/.claude/.forge-install-manifest.json" CLAUDE.md; then ok "the carried CLAUDE.md entry is still in the manifest"; else bad "the CLAUDE.md entry was dropped from the manifest"; fi

exit "$fail"
