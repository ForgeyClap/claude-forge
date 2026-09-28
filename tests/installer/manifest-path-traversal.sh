#!/usr/bin/env bash
# WP-9B-INST regression test (Codex adversarial review, INSTALL-1 HIGH): the retirement-pruning path
# and the --uninstall path must never trust a manifest-recorded path enough to hash-then-move/delete a
# file OUTSIDE the project, even when a forged manifest's recorded sha256 happens to match the real
# victim file. Runs the REAL install.sh (copied byte-for-byte into a minimal fake payload so its own
# in-place source detection resolves there, never retyped) against a temp HOME/project, so the real
# worktree is never touched. Covers:
#   1. a lexical ".."-traversal entry in the OLD project manifest is ignored during the automatic
#      retirement-prune step (a normal upgrade install) -- the victim file outside the project survives
#      untouched, a plain warning is printed, and the install still succeeds;
#   2. a lexically-safe entry whose ancestor directory is a symlink/junction pointing outside the
#      project is ALSO ignored -- filesystem containment, not just string shape;
#   3. the SAME forged-path attack against the CURRENT manifest via --uninstall is also refused (a
#      hardening beyond the exact two functions the finding named, since --uninstall reads the same
#      untrusted manifest file format through a sibling code path);
#   4. a genuinely retired, SAFE file in the SAME manifest as scenario 1 is still correctly retired,
#      and a genuinely shipped file is still correctly removed by --uninstall in scenario 3 -- the fix
#      discriminates, it does not blanket-refuse everything once one entry looks unsafe.
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

# A minimal fake payload is enough -- see tests/installer/projects-registry.sh's own sibling comment
# for why --project-only never reaches the settings-merge/standing-rules/root-seed machinery on a
# brand-new project with no settings.json shipped in this fixture at all.
build_fake_repo() {
  local repo="$1"
  mkdir -p "$repo/global-install/.claude" "$repo/.claude"
  printf 'placeholder\n' > "$repo/global-install/.claude/dummy.txt"
  printf 'placeholder\n' > "$repo/.claude/dummy.txt"
  printf '0.0.0-test\n' > "$repo/VERSION"
  cp -- "$REPO_ROOT/install.sh" "$repo/install.sh"
  chmod +x "$repo/install.sh"
}

# ===========================================================================
# Scenario 1 + 4: a ".."-traversal entry in the OLD manifest is ignored during the automatic
# retirement-prune step; a genuinely retired SAFE entry in the SAME manifest is still retired.
# ===========================================================================
REPO1="$WORK/fake-repo-1"; HOME1="$WORK/fake-home-1"; PROJ1="$WORK/fake-proj-1"
build_fake_repo "$REPO1"
mkdir -p "$HOME1" "$PROJ1"

HOME="$HOME1" bash "$REPO1/install.sh" --project "$PROJ1" --project-only --yes >/dev/null

manifest1="$PROJ1/.claude/.forge-install-manifest.json"
[ -f "$manifest1" ] || bad "SCEN1: fixture assumption broken: no project manifest after a fresh install"

# The "victim": a real file OUTSIDE the project, one level above PROJ1 -- ".." (relative to the
# project root, exactly how a real manifest entry's path is written) resolves straight to it.
victim1="$WORK/victim1.txt"
printf 'do not touch me\n' > "$victim1"
victim1_hash=$(sha "$victim1")

# A SAFE, legitimate "retired" entry in the SAME manifest -- proves the fix discriminates per entry,
# it does not blanket-refuse every retirement once one entry looks unsafe.
printf 'old shipped file\n' > "$PROJ1/.claude/legit-retired.txt"
legit_hash=$(sha "$PROJ1/.claude/legit-retired.txt")

node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.files.push(
    { path: "../victim1.txt", sha256: process.argv[2] },
    { path: ".claude/legit-retired.txt", sha256: process.argv[3] }
  );
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$manifest1" "$victim1_hash" "$legit_hash"

set +e
out1=$(HOME="$HOME1" bash "$REPO1/install.sh" --project "$PROJ1" --project-only --yes 2>&1)
status1=$?
set -e
echo "$out1" | grep -i "skipped\|unsafe\|retired" | head -10

if [ -f "$victim1" ] && [ "$(sha "$victim1")" = "$victim1_hash" ]; then
  ok "SCEN1: the victim file outside the project was left completely untouched (not moved, not modified)"
else
  bad "SCEN1: the victim file outside the project was moved or modified -- path traversal succeeded"
fi
if [ "$status1" -eq 0 ]; then
  ok "SCEN1: the install still succeeds despite the forged (\"..\"-traversal) manifest entry"
else
  bad "SCEN1: the install FAILED (exit $status1) because of the forged manifest entry -- it must warn and continue, never abort"
fi
if echo "$out1" | grep -qi "skipped.*victim1.txt\|does not safely resolve.*victim1.txt\|unsafe.*victim1.txt"; then
  ok "SCEN1: a plain warning naming the unsafe manifest path was printed"
else
  bad "SCEN1: no warning was printed about the unsafe (\"..\"-traversal) manifest path"
fi
if [ -f "$PROJ1/.claude/legit-retired.txt" ]; then
  bad "SCEN4: the legitimate retired file (a safe, real entry in the SAME manifest) was NOT retired -- rejection may be too broad"
else
  ok "SCEN4: the legitimate retired file (a safe, real entry in the SAME manifest) WAS correctly retired"
fi

# ===========================================================================
# Scenario 2: a lexically-safe manifest path whose ancestor is a symlink/junction pointing outside the
# project is ALSO refused -- filesystem containment, not just string shape.
# ===========================================================================
REPO2="$WORK/fake-repo-2"; HOME2="$WORK/fake-home-2"; PROJ2="$WORK/fake-proj-2"
build_fake_repo "$REPO2"
mkdir -p "$HOME2" "$PROJ2"
HOME="$HOME2" bash "$REPO2/install.sh" --project "$PROJ2" --project-only --yes >/dev/null

manifest2="$PROJ2/.claude/.forge-install-manifest.json"
outside2="$WORK/outside-target-2"
mkdir -p "$outside2"
printf 'do not touch me either\n' > "$outside2/pwned.txt"
victim2_hash=$(sha "$outside2/pwned.txt")

# A subdirectory name the real fixture never ships anything under, so ONLY the retirement-prune step
# below ever looks at it (a normal copy never writes anything there, keeping this scenario isolated to
# just the retirement-prune defense).
link_win=$(cygpath -w "$PROJ2/.claude/junctioned-dir" 2>/dev/null || printf '%s' "$PROJ2/.claude/junctioned-dir")
target_win=$(cygpath -w "$outside2" 2>/dev/null || printf '%s' "$outside2")
if command -v cygpath >/dev/null 2>&1 && cmd //c mklink //J "$link_win" "$target_win" >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.files.push({ path: ".claude/junctioned-dir/pwned.txt", sha256: process.argv[2] });
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  ' "$manifest2" "$victim2_hash"

  set +e
  out2=$(HOME="$HOME2" bash "$REPO2/install.sh" --project "$PROJ2" --project-only --yes 2>&1)
  status2=$?
  set -e
  echo "$out2" | grep -i "skipped\|unsafe\|symlink\|junction" | head -10

  if [ -f "$outside2/pwned.txt" ] && [ "$(sha "$outside2/pwned.txt")" = "$victim2_hash" ]; then
    ok "SCEN2: the victim file behind the symlinked/junctioned ancestor was left completely untouched"
  else
    bad "SCEN2: the victim file behind the symlinked/junctioned ancestor was moved or modified"
  fi
  if [ "$status2" -eq 0 ]; then
    ok "SCEN2: the install still succeeds despite the symlinked-ancestor manifest entry"
  else
    bad "SCEN2: the install FAILED (exit $status2) because of the symlinked-ancestor manifest entry"
  fi
else
  echo "SKIP: could not create a junction in this environment (no cygpath/mklink) -- scenario 2 (filesystem containment) not exercised; scenario 1's lexical check still ran above"
fi

# ===========================================================================
# Scenario 3: the SAME forged-path attack against the CURRENT manifest via --uninstall is refused too
# (hardening beyond the two functions the finding named, since --uninstall reads the identical
# untrusted manifest file format through forge_remove_manifest_files); a genuinely shipped file in the
# SAME manifest is still correctly removed.
# ===========================================================================
REPO3="$WORK/fake-repo-3"; HOME3="$WORK/fake-home-3"; PROJ3="$WORK/fake-proj-3"
build_fake_repo "$REPO3"
mkdir -p "$HOME3" "$PROJ3"
HOME="$HOME3" bash "$REPO3/install.sh" --project "$PROJ3" --project-only --yes >/dev/null

manifest3="$PROJ3/.claude/.forge-install-manifest.json"
victim3="$WORK/victim3.txt"
printf 'do not delete me\n' > "$victim3"
victim3_hash=$(sha "$victim3")

node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.files.push({ path: "../victim3.txt", sha256: process.argv[2] });
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$manifest3" "$victim3_hash"

set +e
out3=$(HOME="$HOME3" bash "$REPO3/install.sh" --uninstall --project "$PROJ3" --project-only --yes 2>&1)
status3=$?
set -e
echo "$out3" | grep -i "skipped\|unsafe" | head -5

if [ -f "$victim3" ] && [ "$(sha "$victim3")" = "$victim3_hash" ]; then
  ok "SCEN3: --uninstall did not delete the victim file outside the project"
else
  bad "SCEN3: --uninstall deleted or modified the victim file outside the project via a forged manifest entry"
fi
if [ "$status3" -eq 0 ]; then
  ok "SCEN3: --uninstall still completes successfully despite the forged manifest entry"
else
  bad "SCEN3: --uninstall FAILED (exit $status3) because of the forged manifest entry"
fi
if echo "$out3" | grep -qi "unsafe"; then
  ok "SCEN3: --uninstall printed a plain warning about the unsafe manifest path"
else
  bad "SCEN3: --uninstall printed no warning about the unsafe manifest path"
fi
if [ -f "$PROJ3/.claude/dummy.txt" ]; then
  bad "SCEN3: --uninstall did not remove a legitimate shipped file (dummy.txt) -- rejection may be too broad"
else
  ok "SCEN3: --uninstall still correctly removed a legitimate shipped file (dummy.txt) -- rejection is not over-broad"
fi

exit "$fail"
