#!/usr/bin/env bash
# Unit test (WP-P3): forge_cc_should_skip (install.sh) must skip exactly the runtime/build paths
# the Command Center installer documents -- node_modules, .data, .claude-flow, coverage (anywhere
# in the tree), discord/.env (the exact file; .env.example must NOT match), discord/transcripts/,
# discord/state/, dashboard/test-results|playwright-report|reports/, any *.log, and any *.env file
# besides *.env.example -- while never skipping a real payload file, including a near-miss name
# like discord/state-machine.js or discord/transcripts-viewer.js (must not match the discord/state
# or discord/transcripts PREFIX rules). Extracts the real function from install.sh (never a
# re-typed copy) so this exercises the actual shipped code.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd -P)

FUNCS_TMP=$(mktemp)
trap 'rm -f -- "$FUNCS_TMP"' EXIT
sed -n '/^forge_cc_should_skip() {/,/^}/p' "$REPO_ROOT/install.sh" > "$FUNCS_TMP"
if [ ! -s "$FUNCS_TMP" ]; then
  echo "FAIL: forge_cc_should_skip is missing from install.sh"
  exit 1
fi
source "$FUNCS_TMP"

fail=0

forge_check() {
  local rel="$1" expect="$2" got
  if forge_cc_should_skip "$rel"; then got="skip"; else got="keep"; fi
  if [ "$got" = "$expect" ]; then
    echo "ok   [$rel] -> $got"
  else
    echo "FAIL [$rel] -> got $got, expected $expect"
    fail=1
  fi
}

# --- must be SKIPPED ---
forge_check "gateway/node_modules/pkg/index.js" skip
forge_check "node_modules/pkg/index.js" skip
forge_check ".data/conversations/a.jsonl" skip
forge_check "discord/.claude-flow/state.db" skip
forge_check ".claude-flow/x" skip
forge_check "dashboard/coverage/lcov-report/index.html" skip
forge_check "coverage/x" skip
forge_check "discord/.env" skip
forge_check "discord/transcripts/call1.txt" skip
forge_check "discord/transcripts" skip
forge_check "discord/state/queue.json" skip
forge_check "discord/state" skip
forge_check "dashboard/test-results/foo.xml" skip
forge_check "dashboard/playwright-report/report.html" skip
forge_check "dashboard/reports/mutation.html" skip
forge_check "gateway/foo.log" skip
forge_check "discord/discord-bot.log" skip
forge_check "discord/.env.local" skip
forge_check "dashboard/.env.forge-setup" skip
forge_check "dashboard/.env.tmp-abc123" skip
forge_check "gateway/.env.staging.local" skip

# --- must be KEPT (including near-miss names that share a prefix with a skip rule) ---
forge_check "gateway/bin.mjs" keep
forge_check "gateway/src/server.mjs" keep
forge_check "gateway/package.json" keep
forge_check "discord/.env.example" keep
forge_check "discord/src/main.js" keep
forge_check "discord/package.json" keep
forge_check "dashboard/dist/index.html" keep
forge_check "dashboard/dist/assets/app.js" keep
forge_check "dashboard/src/App.tsx" keep
forge_check "dashboard/package.json" keep
forge_check "dashboard/.env.example" keep
forge_check "dashboard/README.md" keep
forge_check "discord/README.md" keep
forge_check "discord/state-machine.js" keep
forge_check "discord/transcripts-viewer.js" keep

exit "$fail"
