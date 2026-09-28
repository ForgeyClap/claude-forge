#!/usr/bin/env bash
# End-to-end test (WP-P3, coordinator follow-up): every project install/uninstall records (or
# removes) this project's absolute path in $HOME/.claude/forge/projects.json, so the Command
# Center dashboard can find a project outside its default scan roots. Runs the REAL install.sh
# (copied byte-for-byte into a minimal fake payload, never retyped) against a temp HOME and temp
# project dirs, so the real worktree/home is never touched. Covers:
#   1. a fresh --project-only install adds this project's entry;
#   2. a re-install of the SAME project adds no duplicate;
#   3. installing a SECOND project adds a second entry, keeping the first;
#   4. --dry-run writes nothing;
#   5. a project --uninstall removes only that project's own entry, keeping every other project's.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd -P)

WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT

fail=0
ok()  { printf 'ok   %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; fail=1; }

# node_abs_path <path> — resolves $1 the SAME way install.sh's own node call ends up seeing it: on
# Git-Bash/MSYS, bash's own `pwd -P` output ("/c/Users/...") is NOT the string that ends up written
# to disk -- MSYS auto-translates a POSIX-shaped path argument into its Windows form
# ("C:/Users/...") the moment it crosses into a native (non-MSYS) executable like node.exe (found by
# a real local run: this test's own bash-side comparison did not match the file's real content
# until it went through this same round trip). Passing the already bash-resolved path through node
# once mirrors that exact translation, so this test's expectations match what the installer
# actually wrote, on every platform (a no-op round trip on Linux/macOS, where no translation happens).
node_abs_path() {
  node -e 'console.log(process.argv[1])' "$(cd -- "$1" && pwd -P)"
}

# A minimal fake payload is enough: --project-only never reaches the settings-merge/standing-rules/
# root-seed machinery on a BRAND NEW project (no settings.json in this fixture's .claude/ at all, so
# forge_copy_settings_file is never even invoked; no pre-existing FORGE_STANDING_RULES.json at the
# destination; no templates/ directory, so the root-seed step is a graceful no-op) -- see
# command-center-install.sh's sibling comment for the same reasoning applied to --global-only.
REPO="$WORK/fake-repo"
mkdir -p "$REPO/global-install/.claude" "$REPO/.claude"
printf 'placeholder\n' > "$REPO/global-install/.claude/dummy.txt"
printf 'placeholder\n' > "$REPO/.claude/dummy.txt"
printf '0.0.0-test\n' > "$REPO/VERSION"
cp -- "$REPO_ROOT/install.sh" "$REPO/install.sh"
chmod +x "$REPO/install.sh"

FAKE_HOME="$WORK/fake-home"
mkdir -p "$FAKE_HOME"
REGISTRY="$FAKE_HOME/.claude/forge/projects.json"

PROJ1="$WORK/projects/site-one"
PROJ2="$WORK/projects/site-two"
mkdir -p "$PROJ1" "$PROJ2"

# ---------------------------------------------------------------------------
# 1. fresh install adds the entry
# ---------------------------------------------------------------------------
HOME="$FAKE_HOME" bash "$REPO/install.sh" --project-only --project "$PROJ1" --yes >/dev/null

if [ -f "$REGISTRY" ]; then ok "projects.json was created"; else bad "projects.json was not created: $REGISTRY"; fi
proj1_abs=$(node_abs_path "$PROJ1")
if grep -qF "$proj1_abs" "$REGISTRY" 2>/dev/null; then
  ok "the fresh install recorded this project's absolute path"
else
  bad "projects.json does not contain $proj1_abs after a fresh install"
  cat "$REGISTRY" 2>/dev/null || true
fi
count_after_first=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).projects.length)' "$REGISTRY" 2>/dev/null || echo "ERR")
if [ "$count_after_first" = "1" ]; then ok "exactly one entry after the first install"; else bad "expected exactly 1 entry after the first install, got: $count_after_first"; fi

# ---------------------------------------------------------------------------
# 2. a re-install of the SAME project adds no duplicate
# ---------------------------------------------------------------------------
HOME="$FAKE_HOME" bash "$REPO/install.sh" --project-only --project "$PROJ1" --yes >/dev/null
count_after_reinstall=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).projects.length)' "$REGISTRY")
if [ "$count_after_reinstall" = "1" ]; then
  ok "re-installing the same project added no duplicate (still 1 entry)"
else
  bad "re-installing the same project changed the entry count: $count_after_reinstall"
  cat "$REGISTRY"
fi

# ---------------------------------------------------------------------------
# 3. installing a SECOND project adds a second entry, keeps the first
# ---------------------------------------------------------------------------
HOME="$FAKE_HOME" bash "$REPO/install.sh" --project-only --project "$PROJ2" --yes >/dev/null
proj2_abs=$(node_abs_path "$PROJ2")
count_after_second=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).projects.length)' "$REGISTRY")
if [ "$count_after_second" = "2" ]; then ok "a second project brings the total to 2 entries"; else bad "expected 2 entries after a second project, got: $count_after_second"; fi
if grep -qF "$proj1_abs" "$REGISTRY" && grep -qF "$proj2_abs" "$REGISTRY"; then
  ok "both projects are recorded"
else
  bad "one of the two projects is missing from projects.json"
  cat "$REGISTRY"
fi

# ---------------------------------------------------------------------------
# 4. --dry-run writes nothing
# ---------------------------------------------------------------------------
PROJ3="$WORK/projects/site-three"
mkdir -p "$PROJ3"
before_hash=$(sha256sum -- "$REGISTRY" | cut -d' ' -f1)
HOME="$FAKE_HOME" bash "$REPO/install.sh" --project-only --project "$PROJ3" --yes --dry-run >/dev/null
after_hash=$(sha256sum -- "$REGISTRY" | cut -d' ' -f1)
if [ "$before_hash" = "$after_hash" ]; then
  ok "--dry-run left projects.json byte-for-byte unchanged"
else
  bad "--dry-run modified projects.json"
fi
if grep -qF "$(node_abs_path "$PROJ3")" "$REGISTRY" 2>/dev/null; then
  bad "--dry-run actually added the dry-run project to projects.json"
else
  ok "--dry-run did not add its project to projects.json"
fi

# ---------------------------------------------------------------------------
# 5. a project --uninstall removes only that project's own entry
# ---------------------------------------------------------------------------
HOME="$FAKE_HOME" bash "$REPO/install.sh" --uninstall --project-only --project "$PROJ1" --yes >/dev/null
count_after_uninstall=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).projects.length)' "$REGISTRY")
if [ "$count_after_uninstall" = "1" ]; then ok "uninstalling project 1 leaves exactly 1 entry"; else bad "expected 1 entry after uninstalling project 1, got: $count_after_uninstall"; fi
if grep -qF "$proj1_abs" "$REGISTRY" 2>/dev/null; then
  bad "project 1's entry survived its own --uninstall"
else
  ok "project 1's entry was removed by its own --uninstall"
fi
if grep -qF "$proj2_abs" "$REGISTRY" 2>/dev/null; then
  ok "project 2's entry was kept (a different project's uninstall must not touch it)"
else
  bad "project 2's entry was removed by project 1's --uninstall (should never happen)"
fi

exit "$fail"
