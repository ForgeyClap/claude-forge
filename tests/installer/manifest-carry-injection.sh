#!/usr/bin/env bash
# Codex release gate RG-02 (2026-09-29): the carry-forward of a kept CLAUDE.md reads the OLD manifest, which is
# attacker-influenced input the moment a project is cloned or shared. A forged old entry whose "hash" tries to break
# out of its JSON string must neither inject an entry into the new manifest nor corrupt it. And a genuine old entry
# must still be carried, so a re-install keeps the project CLAUDE.md (the PR #4 regression).
# RG-02-A (the verification round): the old-manifest parser must drop any entry whose path holds a tab, newline or
# control character or whose hash is not a real sha256, so no forged field can split into extra rows that the
# Command Center carry copies into the new GLOBAL manifest. RG-02-C: "untouched" means the same content.
# Verify Boss VB-02/VB-03: that carry also skips a row whose path is not a safe relative path, and part 4 proves the
# carry really ran (a genuine entry is still listed).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
sha() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
has_entry() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit((j.files||[]).some((f)=>f.path===process.argv[2])?0:1)' "$1" "$2"; }
same_content() { [ -f "$1" ] && [ "$(sha "$1")" = "$2" ]; }

# 1. a forged old manifest entry for CLAUDE.md whose hash smuggles in a second entry
H1="$WORK/home1"; P1="$WORK/proj1"
mkdir -p "$H1" "$P1/.claude"
( cd "$P1" && git init -q && echo "# p" > README.md && echo "user notes" > notes.txt && echo "# my own rules" > CLAUDE.md )
NH=$(sha "$P1/notes.txt"); CH=$(sha "$P1/CLAUDE.md")
node -e '
  const evil = "bad\" }, { \"path\": \"notes.txt\", \"sha256\": \"" + process.argv[2];
  require("fs").writeFileSync(process.argv[1], JSON.stringify({ forge_version: "2.8.1", scope: "project", files: [{ path: "CLAUDE.md", sha256: evil }] }, null, 2));
' "$P1/.claude/.forge-install-manifest.json" "$NH"
HOME="$H1" bash "$REPO/install.sh" --project "$P1" --project-only --yes >"$WORK/out1.txt" 2>&1 || bad "install.sh exited non-zero on a forged manifest"
M1="$P1/.claude/.forge-install-manifest.json"
if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$M1" 2>/dev/null; then ok "the new manifest is valid JSON"; else bad "the new manifest is not valid JSON"; fi
if has_entry "$M1" notes.txt; then bad "a forged hash injected a notes.txt entry into the new manifest"; else ok "no injected entry reached the new manifest"; fi
if has_entry "$M1" CLAUDE.md; then bad "a CLAUDE.md entry with a forged hash was carried"; else ok "the forged CLAUDE.md entry was not carried"; fi
same_content "$P1/notes.txt" "$NH" && ok "notes.txt is untouched (same content)" || bad "notes.txt was changed, moved or deleted"
same_content "$P1/CLAUDE.md" "$CH" && ok "the user's own CLAUDE.md is untouched (same content)" || bad "the user's own CLAUDE.md was changed or moved"
# the "N file(s) recorded" line counts the entries actually written, so the skipped forged one is not counted
N1=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((j.files||[]).length))' "$M1" 2>/dev/null || echo "?")
if grep -qF ".forge-install-manifest.json ($N1 file(s) recorded for uninstall)" "$WORK/out1.txt"; then ok "the reported count matches the manifest ($N1 entries)"; else bad "the reported count does not match the manifest's $N1 entries"; fi

# 2. a genuine entry IS carried: install twice into a fresh project, CLAUDE.md stays on disk and in the manifest
H2="$WORK/home2"; P2="$WORK/proj2"
mkdir -p "$H2" "$P2"
( cd "$P2" && git init -q && echo "# p" > README.md )
HOME="$H2" bash "$REPO/install.sh" --project "$P2" --project-only --yes >/dev/null 2>&1 || bad "first install.sh exited non-zero"
C2=""; [ -f "$P2/CLAUDE.md" ] && C2=$(sha "$P2/CLAUDE.md")
HOME="$H2" bash "$REPO/install.sh" --project "$P2" --project-only --yes >/dev/null 2>&1 || bad "second install.sh exited non-zero"
[ -n "$C2" ] && same_content "$P2/CLAUDE.md" "$C2" && ok "a re-install keeps the Forge-written CLAUDE.md (same content)" || bad "a re-install moved or changed the Forge-written CLAUDE.md"
if has_entry "$P2/.claude/.forge-install-manifest.json" CLAUDE.md; then ok "the carried CLAUDE.md entry is still in the manifest"; else bad "the CLAUDE.md entry was dropped from the manifest"; fi

# 3. RG-02-A, the parser and the writer themselves (the real functions, extracted from install.sh)
FUNCS="$WORK/funcs.sh"
sed -n '/^forge_log()/,/^}/p; /^forge_have_cmd()/,/^}/p; /^forge_manifest_to_tsv()/,/^}/p; /^forge_write_manifest_file()/,/^}/p' "$REPO/install.sh" > "$FUNCS"
h=$(node -e 'process.stdout.write("a".repeat(64))'); HU=$(node -e 'process.stdout.write("B".repeat(64))')
node -e '
  const h = "a".repeat(64), cc = ".claude/forge/template/command-center/";
  const files = [
    { path: cc + "gateway/bin.mjs", sha256: h + "\n" + cc + "notes.txt\t" + h },
    { path: "tab\tin/path.txt", sha256: h },
    { path: "newline\nin/path.txt", sha256: h },
    { path: "ctrl\u0001.txt", sha256: h },
    { path: "short-hash.txt", sha256: "abc" },
    { path: "trailing-lf.txt", sha256: h + "\n" },
    { path: "good/file.txt", sha256: h },
    { path: "upper/file.txt", sha256: "B".repeat(64) },
  ];
  require("fs").writeFileSync(process.argv[1], JSON.stringify({ forge_version: "2.8.1", scope: "global", files }, null, 2));
' "$WORK/forged-global.json"
(
  # shellcheck source=/dev/null
  source "$FUNCS"
  forge_manifest_to_tsv "$WORK/forged-global.json" "$WORK/old.tsv"
)
printf 'good/file.txt\t%s\nupper/file.txt\t%s\n' "$h" "$HU" > "$WORK/expected.tsv"
if sort "$WORK/old.tsv" | cmp -s - "$WORK/expected.tsv"; then ok "3: the parser keeps only the two well-formed entries"; else bad "3: the parser kept a malformed entry: $(tr '\t\r' '|~' < "$WORK/old.tsv" | tr '\n' ' ')"; fi
if grep -q '^\.claude/forge/template/command-center/notes\.txt' "$WORK/old.tsv"; then bad "3: a smuggled Command Center row survived the parser"; else ok "3: no smuggled Command Center row survives the parser"; fi
mkdir -p "$WORK/mt"
{ printf 'ok/one.txt\t%s\n' "$h"; printf 'ctrl\001path.txt\t%s\n' "$h"; printf 'bad/hash.txt\tnot-a-hash\n'; } > "$WORK/mt/global.tsv"
out3=$(MANIFEST_TMP="$WORK/mt"; source "$FUNCS"; forge_write_manifest_file global "$WORK/written.json" 0.0.0-test)
if node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.files.length===1&&j.files[0].path==="ok/one.txt"?0:1)' "$WORK/written.json" 2>/dev/null; then
  ok "3: the writer writes valid JSON with only the well-formed entry"
else
  bad "3: the writer wrote invalid JSON or a malformed entry"
fi
case "$out3" in *"(1 file(s) recorded for uninstall)"*) ok "3: the writer reports the one entry it wrote" ;; *) bad "3: the writer's count is wrong: $out3" ;; esac

# 4. RG-02-A end to end: a forged GLOBAL manifest whose hash smuggles in a Command Center row cannot reach the new
#    manifest through the Command Center carry. That carry runs when a link under the Command Center makes the
#    installer refuse to install it, so this uses a minimal payload with the real install.sh (as in
#    command-center-symlink.sh) and plants a link.
FAKE="$WORK/fake-repo"; H4="$WORK/home4"; P4="$WORK/proj4"
mkdir -p "$FAKE/global-install/.claude" "$FAKE/.claude" "$FAKE/command-center/gateway" "$FAKE/command-center/discord" "$FAKE/command-center/dashboard/dist" "$H4" "$P4"
printf 'placeholder\n' > "$FAKE/global-install/.claude/dummy.txt"
printf 'placeholder\n' > "$FAKE/.claude/dummy.txt"
printf '0.0.0-test\n' > "$FAKE/VERSION"
printf '// gateway entry point\n' > "$FAKE/command-center/gateway/bin.mjs"
printf 'DISCORD_BOT_TOKEN=\n' > "$FAKE/command-center/discord/.env.example"
printf '<html>dashboard</html>\n' > "$FAKE/command-center/dashboard/dist/index.html"
cp -- "$REPO/install.sh" "$FAKE/install.sh"
( cd "$P4" && git init -q )
HOME="$H4" bash "$FAKE/install.sh" --project "$P4" --yes >/dev/null 2>&1 || bad "4: the first install of the minimal payload failed"
CC="$H4/.claude/forge/template/command-center"
GM="$H4/.claude/forge/install-manifest.json"
if [ -f "$GM" ] && [ -f "$CC/gateway/bin.mjs" ]; then
  printf 'my own notes\n' > "$CC/notes.txt"
  NOTES_H=$(sha "$CC/notes.txt")
  node -e '
    const fs = require("fs"); const [m, notesHash] = process.argv.slice(1);
    const cc = ".claude/forge/template/command-center/";
    const j = JSON.parse(fs.readFileSync(m, "utf8"));
    j.files.push({ path: cc + "zz.txt", sha256: "a".repeat(64) + "\n" + cc + "notes.txt\t" + notesHash });
    j.files.push({ path: cc + "../../../../victim.txt", sha256: "b".repeat(64) });
    fs.writeFileSync(m, JSON.stringify(j, null, 2));
  ' "$GM" "$NOTES_H"
  OUTSIDE="$WORK/outside"; mkdir -p "$OUTSIDE"
  rm -rf -- "$CC/gateway"
  linked=0
  if command -v cygpath >/dev/null 2>&1; then
    cmd //c mklink //J "$(cygpath -w "$CC/gateway")" "$(cygpath -w "$OUTSIDE")" >/dev/null 2>&1 && linked=1
  else
    ln -s "$OUTSIDE" "$CC/gateway" 2>/dev/null && linked=1
  fi
  if [ "$linked" = "1" ] && [ -L "$CC/gateway" ]; then
    set +e
    out4=$(HOME="$H4" bash "$FAKE/install.sh" --project "$P4" --yes 2>&1)
    set -e
    case "$out4" in *"symlink or junction"*) ok "4: the Command Center install was refused" ;; *) bad "4: the refusal branch did not run (fixture problem)" ;; esac
    if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$GM" 2>/dev/null; then ok "4: the new global manifest is valid JSON"; else bad "4: the new global manifest is not valid JSON"; fi
    # Verify Boss VB-03: prove the carry really ran -- a genuine Command Center entry is still listed and in place
    if has_entry "$GM" ".claude/forge/template/command-center/dashboard/dist/index.html" && [ -f "$CC/dashboard/dist/index.html" ]; then ok "4: a genuine Command Center entry was carried (the carry ran)"; else bad "4: the genuine Command Center entry was not carried, so the carry did not run"; fi
    if has_entry "$GM" ".claude/forge/template/command-center/notes.txt"; then bad "4: a smuggled Command Center row reached the new global manifest"; else ok "4: no smuggled Command Center row reached the new global manifest"; fi
    # Verify Boss VB-02: a well-formed row whose path is not a safe relative path is not carried either
    if has_entry "$GM" ".claude/forge/template/command-center/../../../../victim.txt"; then bad "4: a path with .. was carried into the new global manifest"; else ok "4: a path with .. was not carried"; fi
    same_content "$CC/notes.txt" "$NOTES_H" && ok "4: the user's notes.txt is untouched (same content)" || bad "4: notes.txt was changed or moved"
  else
    echo "SKIP 4: no link could be created under the Command Center here, and the carry branch needs one"
  fi
else
  bad "4: fixture assumption broken: no global manifest or Command Center after the first install"
fi

exit "$fail"
