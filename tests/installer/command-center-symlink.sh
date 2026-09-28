#!/usr/bin/env bash
# WP-9B-INST regression test (Codex adversarial review, INSTALL-2 HIGH): a symlink/junction planted at
# a Command Center destination path (e.g. .../command-center/gateway pointing outside the template)
# must never be followed -- the whole Command Center install for that run is skipped, with a clear
# message telling the owner to remove the link, and nothing lands inside the link's target. Runs the
# REAL install.sh (copied byte-for-byte into a minimal fake payload, never retyped) against a temp
# HOME/project, so the real worktree is never touched. Covers:
#   1. a fresh install (no link yet) succeeds normally and ships the Command Center;
#   2. after the real gateway/ directory is replaced with a junction pointing OUTSIDE the template
#      (the attack the finding describes), a second install refuses the WHOLE Command Center copy --
#      nothing is written inside the link's target, a clear "symlink or junction" message is printed,
#      and the run's own exit code reflects that this one step had a problem;
#   3. the canonical template and the project payload -- both copied in SEPARATE steps before/after the
#      Command Center step -- still install correctly despite the refusal ("the rest of the installer"
#      is never aborted, only the Command Center step itself is skipped);
#   4. the EXISTING, legitimate Command Center files from install #1 (still real files, e.g.
#      discord/.env.example) are left byte-for-byte untouched by the refused second install.
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

build_fake_repo() {
  local repo="$1"
  mkdir -p "$repo/global-install/.claude" "$repo/.claude"
  printf 'placeholder\n' > "$repo/global-install/.claude/dummy.txt"
  printf 'placeholder\n' > "$repo/.claude/dummy.txt"
  printf '0.0.0-test\n' > "$repo/VERSION"

  mkdir -p "$repo/command-center/gateway" "$repo/command-center/discord" "$repo/command-center/dashboard/dist"
  printf '// gateway entry point\n' > "$repo/command-center/gateway/bin.mjs"
  printf 'DISCORD_BOT_TOKEN=\n' > "$repo/command-center/discord/.env.example"
  printf '<html>dashboard</html>\n' > "$repo/command-center/dashboard/dist/index.html"

  cp -- "$REPO_ROOT/install.sh" "$repo/install.sh"
  chmod +x "$repo/install.sh"
}

if ! command -v cygpath >/dev/null 2>&1; then
  echo "SKIP: cygpath not available in this environment -- cannot create a junction to prove the symlink-ancestor refusal"
  exit 0
fi

REPO="$WORK/fake-repo"; HOME1="$WORK/fake-home"; PROJ="$WORK/fake-proj"
build_fake_repo "$REPO"
mkdir -p "$HOME1" "$PROJ"

# ---------------------------------------------------------------------------
# 1. a fresh (default, global+project) install succeeds normally.
# ---------------------------------------------------------------------------
out1=$(HOME="$HOME1" bash "$REPO/install.sh" --project "$PROJ" --yes 2>&1)
status1=$?
if [ "$status1" -eq 0 ]; then
  ok "SCEN1: a fresh install (no link yet) succeeds"
else
  bad "SCEN1: a fresh install failed (exit $status1) -- fixture is broken"
  echo "$out1"
fi

ccDest="$HOME1/.claude/forge/template/command-center"
[ -f "$ccDest/gateway/bin.mjs" ] || bad "SCEN1: fixture assumption broken: gateway/bin.mjs missing after a fresh install"
envExampleHashBefore=$(sha "$ccDest/discord/.env.example")
# The minimal fixture's canonical template only ever ships .claude/dummy.txt (see build_fake_repo) --
# this is the one real file that proves the SEPARATE canonical-template copy step (before the Command
# Center step) still ran, without depending on a full real payload this test does not need.
[ -f "$HOME1/.claude/forge/template/.claude/dummy.txt" ] || bad "SCEN1: fixture assumption broken: the canonical template's dummy.txt is missing after a fresh install"

# ---------------------------------------------------------------------------
# 2/3/4: replace the real gateway/ directory with a junction pointing OUTSIDE the template (the
# attack), then re-install. The whole Command Center copy must be refused; the rest of the install
# (canonical template, project payload) must still succeed; existing CC files must survive untouched.
# ---------------------------------------------------------------------------
outsideTarget="$WORK/outside-cc-target"
mkdir -p "$outsideTarget"
printf 'nothing should ever be written next to me\n' > "$outsideTarget/sentinel.txt"
sentinelHashBefore=$(sha "$outsideTarget/sentinel.txt")

rm -rf -- "$ccDest/gateway"
link_win=$(cygpath -w "$ccDest/gateway")
target_win=$(cygpath -w "$outsideTarget")
if ! cmd //c mklink //J "$link_win" "$target_win" >/dev/null 2>&1; then
  echo "SKIP: could not create a junction in this environment -- scenario 2-4 (symlink-ancestor refusal) not exercised"
  exit "$fail"
fi

set +e
out2=$(HOME="$HOME1" bash "$REPO/install.sh" --project "$PROJ" --yes 2>&1)
status2=$?
set -e
echo "$out2" | grep -i "symlink\|junction\|command center" | head -10

if [ "$status2" -ne 0 ]; then
  ok "SCEN2: the second install's own exit code reflects the Command Center refusal (non-zero)"
else
  bad "SCEN2: the second install reported success (exit 0) even though the Command Center copy should have been refused"
fi
if echo "$out2" | grep -qi "symlink or junction"; then
  ok "SCEN2: a clear message names a symlink or junction as the reason the Command Center was refused"
else
  bad "SCEN2: no clear symlink/junction message was printed"
fi
if echo "$out2" | grep -qi "remove that link"; then
  ok "SCEN2: the message tells the owner to remove the link"
else
  bad "SCEN2: the message does not tell the owner to remove the link"
fi

sentinelHashAfter=$(sha "$outsideTarget/sentinel.txt")
sentinelCountAfter=$(find "$outsideTarget" -type f | wc -l | tr -d ' ')
if [ "$sentinelHashBefore" = "$sentinelHashAfter" ] && [ "$sentinelCountAfter" -eq 1 ]; then
  ok "SCEN2: nothing was written inside the link's target directory (still exactly the one sentinel file, unchanged)"
else
  bad "SCEN2: the link's target directory was modified -- the installer followed the junction"
fi

if [ -f "$HOME1/.claude/forge/template/.claude/dummy.txt" ]; then
  ok "SCEN3: the canonical template (copied in a separate step before the Command Center) still installed correctly"
else
  bad "SCEN3: the canonical template did not install -- the refusal wrongly affected an unrelated step"
fi
if [ -f "$PROJ/.claude/dummy.txt" ]; then
  ok "SCEN3: the project payload still installed correctly despite the Command Center refusal"
else
  bad "SCEN3: the project payload did not install -- the refusal wrongly affected an unrelated step"
fi

envExampleHashAfter=$(sha "$ccDest/discord/.env.example")
if [ "$envExampleHashBefore" = "$envExampleHashAfter" ]; then
  ok "SCEN4: an existing, legitimate Command Center file (discord/.env.example) from install #1 survived byte-for-byte"
else
  bad "SCEN4: an existing, legitimate Command Center file was modified by the refused second install"
fi

exit "$fail"
