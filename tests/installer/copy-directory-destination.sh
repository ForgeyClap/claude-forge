#!/usr/bin/env bash
# WP-9B-INST regression test (Codex adversarial review, INSTALL-3 MEDIUM): a directory (or other
# non-file item) already sitting at a payload FILE's destination path must be refused cleanly, never
# silently `cp`-ed INTO (which would nest the payload file inside it while still reporting success).
# Runs the REAL install.sh (copied byte-for-byte into a minimal fake payload, never retyped) against a
# temp HOME/project, so the real worktree is never touched. This proves Copy-ForgeFile's own fix (the
# GENERAL per-file copy path every payload file goes through) -- forge_copy_settings_file already had
# an equivalent guard for settings.json specifically (wp-f2, 2026-09-24); this is the same protection
# for every OTHER shipped file. Covers:
#   1. a directory at a shipped file's destination is refused with a plain error, never nested into;
#   2. the pre-existing directory itself is left completely untouched (not deleted, not replaced);
#   3. the overall install reports failure (non-zero exit) because of the one refused file;
#   4. every OTHER, unrelated payload file still installs correctly despite the one refusal.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd -P)

WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT

fail=0
ok()  { printf 'ok   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

REPO="$WORK/fake-repo"
mkdir -p "$REPO/global-install/.claude" "$REPO/.claude"
printf 'placeholder\n' > "$REPO/global-install/.claude/dummy.txt"
printf 'this is the real shipped file\n' > "$REPO/.claude/dummy.txt"
printf 'this is a second, unrelated shipped file\n' > "$REPO/.claude/other-file.txt"
printf '0.0.0-test\n' > "$REPO/VERSION"
cp -- "$REPO_ROOT/install.sh" "$REPO/install.sh"
chmod +x "$REPO/install.sh"

FAKE_HOME="$WORK/fake-home"
PROJ="$WORK/fake-proj"
mkdir -p "$FAKE_HOME" "$PROJ"

# The attack/accident this fix closes: a DIRECTORY already sitting where a shipped FILE belongs
# (an older release, a botched manual edit, or something deliberately planted).
mkdir -p "$PROJ/.claude/dummy.txt"
printf 'i should never be here\n' > "$PROJ/.claude/dummy.txt/nested-marker.txt"

set +e
out=$(HOME="$FAKE_HOME" bash "$REPO/install.sh" --project "$PROJ" --project-only --yes 2>&1)
status=$?
set -e
echo "$out" | grep -i "cannot write\|directory\|failed" | head -10

# ---------------------------------------------------------------------------
# 1 + 2: the directory is refused, never nested into, and left completely untouched.
# ---------------------------------------------------------------------------
if [ -d "$PROJ/.claude/dummy.txt" ]; then
  ok "SCEN1: the pre-existing directory at dummy.txt still exists (not deleted or replaced)"
else
  bad "SCEN1: the pre-existing directory at dummy.txt is gone -- it should never have been touched"
fi
entries=$(find "$PROJ/.claude/dummy.txt" -mindepth 1 | wc -l | tr -d ' ')
if [ "$entries" -eq 1 ] && [ -f "$PROJ/.claude/dummy.txt/nested-marker.txt" ]; then
  ok "SCEN1: nothing new was nested inside the directory (still exactly the one marker file)"
else
  bad "SCEN1: something changed inside the directory (found $entries entr(y/ies)) -- the installer wrote into it"
fi
if echo "$out" | grep -qi "cannot write"; then
  ok "SCEN1: a plain error names the write refusal"
else
  bad "SCEN1: no plain error was printed about the refused write"
fi

# ---------------------------------------------------------------------------
# 3: the overall install reports failure because of the one refused file.
# ---------------------------------------------------------------------------
if [ "$status" -ne 0 ]; then
  ok "SCEN3: the install reports failure (non-zero exit) because of the directory-shaped destination"
else
  bad "SCEN3: the install reported success (exit 0) even though one payload file could not be written"
fi

# ---------------------------------------------------------------------------
# 4: every OTHER, unrelated payload file still installs correctly.
# ---------------------------------------------------------------------------
if [ -f "$PROJ/.claude/other-file.txt" ] && grep -qF 'second, unrelated shipped file' "$PROJ/.claude/other-file.txt"; then
  ok "SCEN4: an unrelated shipped file still installed correctly despite the one refusal"
else
  bad "SCEN4: an unrelated shipped file did NOT install -- the one refusal wrongly affected other files"
fi

exit "$fail"
