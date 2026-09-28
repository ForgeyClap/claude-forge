#!/usr/bin/env bash
# WP-9B-INST regression test (Codex adversarial review, INSTALL-4 LOW): two installs racing on the
# SAME $HOME/.claude/forge/projects.json must not lose either update (a classic read-modify-write race
# even though each individual write is itself atomic), and a lock left behind by a crashed/killed
# installer must not wedge every future install forever. Runs the REAL install.sh (copied byte-for-byte
# into a minimal fake payload, never retyped) against a temp HOME, so the real worktree is never
# touched. Covers:
#   1. a stale lock (mtime far in the past -- simulating a crashed installer) is reclaimed promptly by
#      a normal, single install, which still completes and records its project;
#   2. two installer processes racing on the SAME projects.json, deliberately forced to contend for the
#      SAME lock at the SAME instant (this test process holds the lock, launches both, then releases
#      it), both keep their own entry -- neither is lost, and the file stays valid JSON.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd -P)

WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT

fail=0
ok()  { printf 'ok   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not found on PATH -- the projects registry feature itself requires node; nothing to test"
  exit 0
fi

# node_abs_path <path> -- resolves $1 the SAME way install.sh's own node call ends up seeing it (see
# tests/installer/projects-registry.sh's own identical helper for the full MSYS-translation rationale).
node_abs_path() {
  node -e 'console.log(process.argv[1])' "$(cd -- "$1" && pwd -P)"
}

registry_project_count() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).projects.length)' "$1" 2>/dev/null || echo "ERR"
}

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
# Scenario 1: a stale lock (mtime far in the past) is reclaimed promptly, the install still succeeds.
# ===========================================================================
REPO1="$WORK/fake-repo-1"; HOME1="$WORK/fake-home-1"; PROJ1="$WORK/fake-proj-1"
build_fake_repo "$REPO1"
mkdir -p "$HOME1" "$PROJ1" "$HOME1/.claude/forge"
registry1="$HOME1/.claude/forge/projects.json"
lock1="$registry1.lock"
mkdir -p "$lock1"
# 5 minutes in the past -- comfortably older than the ~2-minute staleness threshold.
touch -d "@$(($(date +%s) - 300))" "$lock1"

start_ts=$(date +%s)
out1=$(HOME="$HOME1" bash "$REPO1/install.sh" --project "$PROJ1" --project-only --yes 2>&1)
status1=$?
end_ts=$(date +%s)
elapsed=$((end_ts - start_ts))

if [ "$status1" -eq 0 ]; then
  ok "SCEN1: the install still succeeds despite a stale lock left behind"
else
  bad "SCEN1: the install FAILED (exit $status1) because of a stale lock"
  echo "$out1"
fi
if [ ! -d "$lock1" ]; then
  ok "SCEN1: the stale lock directory was cleaned up"
else
  bad "SCEN1: the stale lock directory is still present after the install"
fi
proj1_abs=$(node_abs_path "$PROJ1")
if grep -qF "$proj1_abs" "$registry1" 2>/dev/null; then
  ok "SCEN1: the project was still recorded despite the stale lock"
else
  bad "SCEN1: the project was NOT recorded -- the stale lock blocked the update"
fi
# A generous ceiling: the stale-lock path should reclaim near-instantly, nowhere close to the full
# 5-second "another install is still active" timeout this same code uses for a LIVE lock.
if [ "$elapsed" -lt 4 ]; then
  ok "SCEN1: the stale lock was reclaimed promptly (${elapsed}s), not after waiting out the live-lock timeout"
else
  bad "SCEN1: reclaiming the stale lock took suspiciously long (${elapsed}s) -- it may have waited out the live-lock timeout instead of detecting staleness"
fi

# ===========================================================================
# Scenario 2: two installer processes racing on the SAME projects.json, deliberately forced to
# contend for the SAME lock at the SAME instant, both keep their own entry.
# ===========================================================================
REPO2="$WORK/fake-repo-2"; HOME2="$WORK/fake-home-2"
build_fake_repo "$REPO2"
PROJA="$WORK/projects/race-a"
PROJB="$WORK/projects/race-b"
mkdir -p "$HOME2" "$PROJA" "$PROJB" "$HOME2/.claude/forge"
registry2="$HOME2/.claude/forge/projects.json"
lock2="$registry2.lock"

# This TEST process holds the lock FIRST, so both installer processes launched below are guaranteed to
# start their own read-modify-write while the registry is already locked, forcing real contention
# instead of hoping two independent processes happen to overlap by luck.
mkdir -p "$lock2"

HOME="$HOME2" bash "$REPO2/install.sh" --project "$PROJA" --project-only --yes > "$WORK/out-a.log" 2>&1 &
pid_a=$!
HOME="$HOME2" bash "$REPO2/install.sh" --project "$PROJB" --project-only --yes > "$WORK/out-b.log" 2>&1 &
pid_b=$!

# Give both children time to actually reach fs.mkdirSync(lockPath) and start their own retry-wait loop
# before this test releases the lock -- generous relative to the 50ms retry interval the fix itself uses.
sleep 1
rmdir "$lock2" 2>/dev/null || true

set +e
wait "$pid_a"; status_a=$?
wait "$pid_b"; status_b=$?
set -e

if [ "$status_a" -eq 0 ] && [ "$status_b" -eq 0 ]; then
  ok "SCEN2: both racing installs exited successfully"
else
  bad "SCEN2: at least one racing install failed (a=$status_a, b=$status_b)"
  cat "$WORK/out-a.log"
  cat "$WORK/out-b.log"
fi

proja_abs=$(node_abs_path "$PROJA")
projb_abs=$(node_abs_path "$PROJB")
count2=$(registry_project_count "$registry2")
if [ "$count2" = "2" ]; then
  ok "SCEN2: the registry has exactly 2 entries -- neither concurrent update was lost"
else
  bad "SCEN2: expected exactly 2 entries after two concurrent installs, got: $count2"
  cat "$registry2" 2>/dev/null || true
fi
if grep -qF "$proja_abs" "$registry2" 2>/dev/null && grep -qF "$projb_abs" "$registry2" 2>/dev/null; then
  ok "SCEN2: both projects' own entries are present"
else
  bad "SCEN2: at least one project's entry is missing from the registry"
  cat "$registry2" 2>/dev/null || true
fi
if [ ! -d "$lock2" ]; then
  ok "SCEN2: no lock directory was left behind after both installs finished"
else
  bad "SCEN2: a lock directory was left behind after both installs finished"
fi

exit "$fail"
