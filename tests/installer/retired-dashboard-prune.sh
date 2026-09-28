#!/usr/bin/env bash
# End-to-end test (WP-P3b): a newer version prunes files it no longer ships, on the very
# install/upgrade that stops shipping them -- not just on --uninstall. Runs the REAL install.sh
# (copied byte-for-byte into a minimal fake payload so its own in-place source detection resolves
# there, never retyped) against a temp HOME/project, so the real worktree is never touched. Real
# historical dashboard content comes from THIS repo's own git history (git show <blob>), never
# invented, so scenario 2 below exercises the actual bytes install.sh has to recognize. Covers:
#   1. a 2.8.1-shaped install (a manifest lists the old dashboard files): the unmodified ones are
#      moved into .claude/forge-backups/retired-<stamp>/, a modified one is kept and reported;
#   2. a manifest-less (pre-2.8.0) install: the known 2.8.1 files (plus one CRLF copy) are removed by
#      content hash; unknown content at the same paths is kept;
#   3. PORT/DASHBOARD_STATE.json (generated runtime state) are removed unconditionally;
#   4. a stale Command Center asset (an old content-hashed dashboard/dist/assets/* bundle) is pruned
#      from the global scope;
#   5. an UNCHANGED shipped Command Center file is replaced with no *.forge-bak-<stamp> litter, while
#      a file the user actually edited still gets one;
#   6. --dry-run writes nothing at all;
#   7. a second install (no more changes to prune) is a true no-op;
#   8. a file this run's own migration check deliberately left untouched (forge_check_standing_rules
#      _migration's skip_rel, e.g. a pending owner-rule migration) is NOT wrongly retired just because
#      it is then absent from this run's own manifest accumulator (regression: caught by self-review,
#      not by scenarios 1-7 -- the fix landed in the SAME diff as the pruning feature itself, so this
#      proves it for real rather than trusting the reasoning alone).
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd -P)

WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT

fail=0
ok()  { printf 'ok   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -- "$1" | cut -d' ' -f1
  else shasum -a 256 -- "$1" | cut -d' ' -f1
  fi
}

# find_retired_dir <backups_root> — the first retired-* folder directly under backups_root (e.g.
# "$PROJ/.claude/forge-backups" or "$HOME/.claude/forge/backups"), or empty. A plain `find` on a
# directory that does not exist yet (nothing was ever retired) exits non-zero; under `set -e` +
# pipefail that would abort this whole script the moment a scenario legitimately retires nothing, so
# existence is checked first instead of just redirecting find's stderr away.
find_retired_dir() {
  local base="$1"
  [ -d "$base" ] || { printf ''; return 0; }
  find "$base" -mindepth 1 -maxdepth 1 -type d -name 'retired-*' 2>/dev/null | head -1
  return 0
}

# any_retired_dir_has <backups_root> <rel_path> — true when rel_path (e.g.
# ".claude/forge-dashboard/PORT") exists under ANY retired-* folder beneath backups_root. The stamp
# in "retired-<stamp>" is second-granularity, so two prune runs a fast machine completes within the
# same wall-clock second legitimately land in the SAME folder -- checking every retired-* folder
# (there are at most a handful in these tests) is robust to that, where "-newer <the previous one>"
# is not (a folder reused in-place is never strictly newer than its own earlier self).
any_retired_dir_has() {
  local base="$1" rel="$2" d
  [ -d "$base" ] || return 1
  for d in "$base"/retired-*; do
    [ -d "$d" ] || continue
    [ -f "$d/$rel" ] && return 0
  done
  return 1
}

# A real historical blob of $2 (a .claude/forge-dashboard/<name> relative path) from THIS repo's own
# git history, written to $1. Fails loudly (not silently) if the fixture assumption is wrong -- a
# test that cannot prove its own setup is not a passing test.
real_historical_content() {
  local out="$1" rel="$2" commit
  commit=$(git -C "$REPO_ROOT" log --all --format='%H' -- "$rel" | tail -1)
  [ -n "$commit" ] || { echo "FIXTURE ERROR: no git history at all for $rel" >&2; exit 2; }
  git -C "$REPO_ROOT" show "$commit:$rel" > "$out"
}

# ---------------------------------------------------------------------------
# Build a minimal fake payload: install.sh's own in-place detection needs global-install/.claude +
# .claude; the project-side .claude/forge-dashboard/ ships only what the REAL current payload ships
# (log-event.cjs + README + the start script -- never the 7 retired files), matching reality so this
# test exercises the actual retirement gap, not an invented one.
# ---------------------------------------------------------------------------
build_fake_repo() {
  local repo="$1"
  mkdir -p "$repo/global-install/.claude" "$repo/.claude/forge-dashboard" "$repo/.claude/forge-bin"
  printf 'placeholder\n' > "$repo/global-install/.claude/dummy.txt"
  printf 'placeholder\n' > "$repo/.claude/dummy.txt"
  printf '// still shipped\n' > "$repo/.claude/forge-dashboard/log-event.cjs"
  printf 'still shipped\n' > "$repo/.claude/forge-dashboard/README.md"
  # The real shipped hash table, byte-for-byte -- never retyped, so a drift in the real file is
  # exactly what this test's scenario 2 would also start failing against.
  cp -- "$REPO_ROOT/.claude/forge-bin/forge-retired-dashboard-hashes.tsv" "$repo/.claude/forge-bin/forge-retired-dashboard-hashes.tsv"
  printf '0.0.0-test\n' > "$repo/VERSION"

  mkdir -p "$repo/command-center/gateway" "$repo/command-center/dashboard/dist/assets" "$repo/command-center/discord"
  printf '// gateway entry point\n' > "$repo/command-center/gateway/bin.mjs"
  printf 'DISCORD_BOT_TOKEN=\n' > "$repo/command-center/discord/.env.example"
  printf '<html>dashboard v1</html>\n' > "$repo/command-center/dashboard/dist/index.html"
  printf 'console.log("app-v1");\n' > "$repo/command-center/dashboard/dist/assets/app-hash1.js"

  cp -- "$REPO_ROOT/install.sh" "$repo/install.sh"
  chmod +x "$repo/install.sh"
}

# ===========================================================================
# Scenario 1: 2.8.1-shaped install (a manifest lists the old dashboard files) --
# unmodified ones pruned into the backup folder, a modified one is kept and reported.
# ===========================================================================
REPO1="$WORK/fake-repo-1"; HOME1="$WORK/fake-home-1"; PROJ1="$WORK/fake-proj-1"
build_fake_repo "$REPO1"
mkdir -p "$HOME1" "$PROJ1"

HOME="$HOME1" bash "$REPO1/install.sh" --project "$PROJ1" --project-only --yes >/dev/null

DB="$PROJ1/.claude/forge-dashboard"
manifest="$PROJ1/.claude/.forge-install-manifest.json"
[ -f "$manifest" ] || { bad "SCEN1: fixture assumption broken: no project manifest after a fresh install"; }

# Fabricate the "2.8.1 shipped these" state: real content at 4 retired paths + a manifest entry per
# path recording each one's CURRENT hash (exactly what a real 2.8.1 install would have recorded).
printf 'old server code\n' > "$DB/server.cjs"
printf 'old index html\n' > "$DB/index.html"
printf 'old app js\n' > "$DB/app.js"
printf 'old panels js\n' > "$DB/panels.js"
h_server=$(sha "$DB/server.cjs"); h_index=$(sha "$DB/index.html"); h_app=$(sha "$DB/app.js"); h_panels=$(sha "$DB/panels.js")
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.files.push(
    { path: ".claude/forge-dashboard/server.cjs", sha256: process.argv[2] },
    { path: ".claude/forge-dashboard/index.html", sha256: process.argv[3] },
    { path: ".claude/forge-dashboard/app.js",     sha256: process.argv[4] },
    { path: ".claude/forge-dashboard/panels.js",  sha256: process.argv[5] },
  );
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$manifest" "$h_server" "$h_index" "$h_app" "$h_panels"

# Modify ONE of them after the (fabricated) install -- its recorded hash no longer matches.
printf 'old panels js\nMY OWN EDIT\n' >> "$DB/panels.js"

out1=$(HOME="$HOME1" bash "$REPO1/install.sh" --project "$PROJ1" --project-only --yes 2>&1)
echo "$out1" | grep -i "retired\|kept" | head -8

for f in server.cjs index.html app.js; do
  if [ -f "$DB/$f" ]; then bad "SCEN1: $f should have been retired (removed from $DB), but it is still there"; else ok "SCEN1: $f is gone from $DB"; fi
done
backup1=$(find_retired_dir "$PROJ1/.claude/forge-backups")
if [ -n "$backup1" ]; then
  for f in server.cjs index.html app.js; do
    if [ -f "$backup1/.claude/forge-dashboard/$f" ]; then ok "SCEN1: $f was backed up to $backup1"; else bad "SCEN1: $f was not found under the backup folder $backup1"; fi
  done
else
  bad "SCEN1: no .claude/forge-backups/retired-* folder was created at all"
fi
if [ -f "$DB/panels.js" ] && grep -qF 'MY OWN EDIT' "$DB/panels.js"; then
  ok "SCEN1: the modified panels.js was kept, byte-for-byte, at its original location"
else
  bad "SCEN1: the modified panels.js was removed or altered (it should have been kept)"
fi
if echo "$out1" | grep -qi "kept (you edited this file"; then
  ok "SCEN1: the install reported the kept file in a plain line"
else
  bad "SCEN1: no 'kept (you edited this file...)' line was printed"
fi

# ===========================================================================
# Scenario 2: manifest-less (pre-2.8.0) install -- real historical content (+ one CRLF copy) is
# removed by content hash; unknown content at the same path is kept.
# ===========================================================================
REPO2="$WORK/fake-repo-2"; HOME2="$WORK/fake-home-2"; PROJ2="$WORK/fake-proj-2"
build_fake_repo "$REPO2"
mkdir -p "$HOME2" "$PROJ2"

# A real install first (so the rest of .claude exists, matching a real pre-2.8.0 project), then
# delete ONLY the manifest to simulate "this project predates manifest tracking".
HOME="$HOME2" bash "$REPO2/install.sh" --project "$PROJ2" --project-only --yes >/dev/null
rm -f -- "$PROJ2/.claude/.forge-install-manifest.json"

DB2="$PROJ2/.claude/forge-dashboard"
real_historical_content "$DB2/lenses.js" ".claude/forge-dashboard/lenses.js"      # real content, LF
real_historical_content "$DB2/styles.css" ".claude/forge-dashboard/styles.css"    # real content, LF
real_historical_content "$WORK/graph-lf.js" ".claude/forge-dashboard/graph.js"
sed 's/$/\r/' "$WORK/graph-lf.js" > "$DB2/graph.js"                              # same content, CRLF
printf 'totally unrelated content nobody ever shipped\n' > "$DB2/app.js"          # unknown -- must be kept

out2=$(HOME="$HOME2" bash "$REPO2/install.sh" --project "$PROJ2" --project-only --yes 2>&1)
echo "$out2" | grep -i "retired\|kept" | head -8

for f in lenses.js styles.css graph.js; do
  if [ -f "$DB2/$f" ]; then bad "SCEN2: $f (known historical content) should have been retired"; else ok "SCEN2: $f (known historical content, CRLF for graph.js) is gone"; fi
done
backup2=$(find_retired_dir "$PROJ2/.claude/forge-backups")
if [ -n "$backup2" ] && [ -f "$backup2/.claude/forge-dashboard/graph.js" ]; then
  ok "SCEN2: the CRLF copy of graph.js was still recognized (CRLF-normalized hash) and backed up"
else
  bad "SCEN2: graph.js (CRLF copy) was not found under the backup folder -- normalization did not work"
fi
if [ -f "$DB2/app.js" ] && grep -qF 'totally unrelated content' "$DB2/app.js"; then
  ok "SCEN2: unknown content at app.js was kept, byte-for-byte"
else
  bad "SCEN2: unknown content at app.js was removed (it should have been kept -- it never matched a known shipped hash)"
fi

# ===========================================================================
# Scenario 3: PORT / DASHBOARD_STATE.json are removed unconditionally (generated runtime state).
# ===========================================================================
printf '4100\n' > "$DB2/PORT"
printf '{"pid":123}\n' > "$DB2/DASHBOARD_STATE.json"
out3=$(HOME="$HOME2" bash "$REPO2/install.sh" --project "$PROJ2" --project-only --yes 2>&1)
if [ ! -f "$DB2/PORT" ] && [ ! -f "$DB2/DASHBOARD_STATE.json" ]; then
  ok "SCEN3: PORT and DASHBOARD_STATE.json were removed"
else
  bad "SCEN3: PORT and/or DASHBOARD_STATE.json still exist after install"
fi
if any_retired_dir_has "$PROJ2/.claude/forge-backups" ".claude/forge-dashboard/PORT"; then
  ok "SCEN3: PORT was backed up, not deleted outright"
else
  bad "SCEN3: PORT was not found under any backup folder"
fi

# ===========================================================================
# Scenario 4/5/7: a stale Command Center asset is pruned; an unchanged CC file is replaced with no
# *.forge-bak-* litter; a second install (nothing left to prune) is a true no-op.
# ===========================================================================
REPO4="$WORK/fake-repo-4"; HOME4="$WORK/fake-home-4"
build_fake_repo "$REPO4"
mkdir -p "$HOME4"

HOME="$HOME4" bash "$REPO4/install.sh" --global-only --yes >/dev/null
CC="$HOME4/.claude/forge/template/command-center"

# A stale asset from a PREVIOUS build, no longer part of the shipped dist -- must look installer-owned
# (recorded in the global manifest with its own real hash) to prove point 1, not point 2/3.
mkdir -p "$CC/dashboard/dist/assets"
printf 'console.log("stale-v0");\n' > "$CC/dashboard/dist/assets/app-hash0-STALE.js"
stale_hash=$(sha "$CC/dashboard/dist/assets/app-hash0-STALE.js")
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.files.push({ path: ".claude/forge/template/command-center/dashboard/dist/assets/app-hash0-STALE.js", sha256: process.argv[2] });
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$HOME4/.claude/forge/install-manifest.json" "$stale_hash"

# Also edit a REAL shipped CC file, to prove the "kept, edited" path still backs up correctly.
printf '// gateway entry point\n// MY OWN CC EDIT\n' > "$CC/gateway/bin.mjs"

out4=$(HOME="$HOME4" bash "$REPO4/install.sh" --global-only --yes 2>&1)
echo "$out4" | grep -i "retired\|back up\|unchanged\|update" | head -10

if [ ! -f "$CC/dashboard/dist/assets/app-hash0-STALE.js" ]; then
  ok "SCEN4: the stale dashboard/dist asset is gone from the live Command Center"
else
  bad "SCEN4: the stale dashboard/dist asset is still present"
fi
gbackup=$(find_retired_dir "$HOME4/.claude/forge/backups")
if [ -n "$gbackup" ] && [ -f "$gbackup/.claude/forge/template/command-center/dashboard/dist/assets/app-hash0-STALE.js" ]; then
  ok "SCEN4: the stale asset was backed up under the global backup folder"
else
  bad "SCEN4: the stale asset was not found under any global backup folder"
fi

if compgen -G "$CC/gateway/bin.mjs.forge-bak-*" > /dev/null; then
  ok "SCEN5: the user-edited gateway/bin.mjs got a *.forge-bak-* safety copy"
else
  bad "SCEN5: the user-edited gateway/bin.mjs did NOT get a *.forge-bak-* safety copy (it should have)"
fi

bak_count_before=$(find "$CC" -name '*.forge-bak-*' 2>/dev/null | wc -l | tr -d ' ')
before_tree=$(find "$CC" -type f | sort)
out5=$(HOME="$HOME4" bash "$REPO4/install.sh" --global-only --yes 2>&1)
after_tree=$(find "$CC" -type f | sort)
bak_count_after=$(find "$CC" -name '*.forge-bak-*' 2>/dev/null | wc -l | tr -d ' ')

if [ "$bak_count_after" = "$bak_count_before" ]; then
  ok "SCEN5/7: a second, unchanged install created ZERO new *.forge-bak-* files in the Command Center"
else
  bad "SCEN5/7: a second, unchanged install created new *.forge-bak-* files ($bak_count_before -> $bak_count_after)"
fi
if [ "$before_tree" = "$after_tree" ]; then
  ok "SCEN7: a second install is a true no-op (identical file set under the Command Center)"
else
  bad "SCEN7: a second install changed the Command Center's file set"
fi
if echo "$out5" | grep -qi "would update\|unchanged"; then :; fi # informational only

# ===========================================================================
# Scenario 6: --dry-run writes nothing at all (project scope, reusing scenario 1's shape fresh).
# ===========================================================================
REPO6="$WORK/fake-repo-6"; HOME6="$WORK/fake-home-6"; PROJ6="$WORK/fake-proj-6"
build_fake_repo "$REPO6"
mkdir -p "$HOME6" "$PROJ6"
HOME="$HOME6" bash "$REPO6/install.sh" --project "$PROJ6" --project-only --yes >/dev/null
DB6="$PROJ6/.claude/forge-dashboard"
printf 'old server code\n' > "$DB6/server.cjs"
h6=$(sha "$DB6/server.cjs")
manifest6="$PROJ6/.claude/.forge-install-manifest.json"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.files.push({ path: ".claude/forge-dashboard/server.cjs", sha256: process.argv[2] });
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$manifest6" "$h6"

before6=$(find "$PROJ6" -type f | sort)
before6_hashes=$(find "$PROJ6" -type f -exec sha256sum {} \; 2>/dev/null | sort)
HOME="$HOME6" bash "$REPO6/install.sh" --project "$PROJ6" --project-only --yes --dry-run >/dev/null
after6=$(find "$PROJ6" -type f | sort)
after6_hashes=$(find "$PROJ6" -type f -exec sha256sum {} \; 2>/dev/null | sort)

if [ "$before6" = "$after6" ] && [ "$before6_hashes" = "$after6_hashes" ]; then
  ok "SCEN6: --dry-run wrote nothing at all (identical file set and content)"
else
  bad "SCEN6: --dry-run changed the project tree"
fi
if [ -f "$DB6/server.cjs" ]; then ok "SCEN6: --dry-run left server.cjs in place (did not actually retire it)"; else bad "SCEN6: --dry-run actually removed server.cjs"; fi

# ===========================================================================
# Scenario 8: a file this run's own migration check skip_rel'd (forge-sync.cjs is absent from this
# fake payload, so forge_check_standing_rules_migration always finds it missing and sets the skip,
# exactly as a real project would see if node itself were unavailable) must not be wrongly retired
# even though it is then absent from this run's own manifest accumulator -- its content, and hence
# its hash, is UNCHANGED between the two installs below.
# ===========================================================================
REPO8="$WORK/fake-repo-8"; HOME8="$WORK/fake-home-8"; PROJ8="$WORK/fake-proj-8"
build_fake_repo "$REPO8"
mkdir -p "$REPO8/.claude/config/orchestration"
printf '{}\n' > "$REPO8/.claude/config/orchestration/FORGE_STANDING_RULES.json"
mkdir -p "$HOME8" "$PROJ8"

HOME="$HOME8" bash "$REPO8/install.sh" --project "$PROJ8" --project-only --yes >/dev/null
rules_file="$PROJ8/.claude/config/orchestration/FORGE_STANDING_RULES.json"
if [ -f "$rules_file" ]; then ok "SCEN8: fixture setup: FORGE_STANDING_RULES.json exists after the fresh install"; else bad "SCEN8: fixture assumption broken: FORGE_STANDING_RULES.json missing after a fresh install"; fi
hash_before=$(sha "$rules_file")

out8=$(HOME="$HOME8" bash "$REPO8/install.sh" --project "$PROJ8" --project-only --yes 2>&1)
echo "$out8" | grep -i "standing_rules\|pending\|migration" | head -4

if [ -f "$rules_file" ]; then
  hash_after=$(sha "$rules_file")
  if [ "$hash_before" = "$hash_after" ]; then ok "SCEN8: FORGE_STANDING_RULES.json was left in place, byte-for-byte"; else bad "SCEN8: FORGE_STANDING_RULES.json changed even though its copy should have been skipped"; fi
else
  bad "SCEN8: FORGE_STANDING_RULES.json is gone (it should have been left in place, not copied, not retired)"
fi
if any_retired_dir_has "$PROJ8/.claude/forge-backups" ".claude/config/orchestration/FORGE_STANDING_RULES.json"; then
  bad "SCEN8: FORGE_STANDING_RULES.json was WRONGLY retired into a backup folder (the skip_rel exemption did not work)"
else
  ok "SCEN8: FORGE_STANDING_RULES.json was NOT wrongly retired (the skip_rel exemption works)"
fi

exit "$fail"
