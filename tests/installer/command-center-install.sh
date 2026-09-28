#!/usr/bin/env bash
# End-to-end test (WP-P3): the Command Center is installed centrally, once, at
# $HOME/.claude/forge/template/command-center/ by a --global-only (and therefore also a default,
# full) install. Runs the REAL install.sh (copied byte-for-byte into a minimal fake payload so its
# own in-place source detection resolves there, never retyped) against a temp HOME, so the real
# worktree is never touched. Covers:
#   1. a fresh install copies the shipped Command Center files and lists them in the global
#      install manifest, while never copying node_modules/.data/.claude-flow/coverage/logs/secrets;
#   2. runtime data already sitting at the DESTINATION (a real discord/.env, a real .data/x)
#      survives a re-install untouched;
#   3. --uninstall removes an unmodified shipped file but keeps one the user edited, and never
#      touches runtime data either;
#   4. --dry-run writes nothing at all;
#   5. a payload without dashboard/dist still installs everything else and warns once, plainly,
#      without ever telling the user to run a build command.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd -P)

WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT

fail=0
ok()   { printf 'ok   %s\n' "$*"; }
bad()  { printf 'FAIL %s\n' "$*"; fail=1; }

# ---------------------------------------------------------------------------
# Build a minimal fake payload: just enough for install.sh's own in-place
# detection (global-install/.claude + .claude) plus a command-center/ fixture
# tree with one representative file per skip rule and per shipped file.
# ---------------------------------------------------------------------------
build_fake_repo() {
  local repo="$1" with_dist="$2"
  mkdir -p "$repo/global-install/.claude" "$repo/.claude"
  printf 'placeholder\n' > "$repo/global-install/.claude/dummy.txt"
  printf 'placeholder\n' > "$repo/.claude/dummy.txt"
  printf '0.0.0-test\n' > "$repo/VERSION"

  mkdir -p "$repo/command-center/gateway/src" \
           "$repo/command-center/gateway/node_modules/pkg" \
           "$repo/command-center/discord/src" \
           "$repo/command-center/discord/node_modules/dep" \
           "$repo/command-center/discord/transcripts" \
           "$repo/command-center/dashboard/node_modules/x" \
           "$repo/command-center/dashboard/test-results" \
           "$repo/command-center/dashboard/playwright-report" \
           "$repo/command-center/dashboard/reports" \
           "$repo/command-center/dashboard/coverage" \
           "$repo/command-center/.data/conversations" \
           "$repo/command-center/.claude-flow"

  printf '// gateway entry point\n' > "$repo/command-center/gateway/bin.mjs"
  printf '{ "name": "forge-command-center-gateway" }\n' > "$repo/command-center/gateway/package.json"
  printf 'module.exports = {};\n' > "$repo/command-center/gateway/node_modules/pkg/index.js"
  printf 'stray dev log line\n' > "$repo/command-center/gateway/some.log"

  printf 'DISCORD_BOT_TOKEN=\n' > "$repo/command-center/discord/.env.example"
  printf '// discord bot entry\n' > "$repo/command-center/discord/src/main.js"
  printf '{ "name": "forge-command-center-discord" }\n' > "$repo/command-center/discord/package.json"
  printf 'DISCORD_BOT_TOKEN=super-secret-fixture-value\n' > "$repo/command-center/discord/.env"
  printf 'a fake call transcript\n' > "$repo/command-center/discord/transcripts/call1.txt"
  printf 'module.exports = {};\n' > "$repo/command-center/discord/node_modules/dep/index.js"

  printf '{ "name": "forge-command-center-dashboard" }\n' > "$repo/command-center/dashboard/package.json"
  printf 'module.exports = {};\n' > "$repo/command-center/dashboard/node_modules/x/y.js"
  printf '<results/>\n' > "$repo/command-center/dashboard/test-results/foo.xml"
  printf '<html>report</html>\n' > "$repo/command-center/dashboard/playwright-report/report.html"
  printf '<html>mutation</html>\n' > "$repo/command-center/dashboard/reports/mutation.html"
  printf '<html>coverage</html>\n' > "$repo/command-center/dashboard/coverage/index.html"
  if [ "$with_dist" = "1" ]; then
    mkdir -p "$repo/command-center/dashboard/dist/assets"
    printf '<html>dashboard</html>\n' > "$repo/command-center/dashboard/dist/index.html"
    printf 'console.log("app");\n' > "$repo/command-center/dashboard/dist/assets/app.js"
  fi

  printf '{"conv":1}\n' > "$repo/command-center/.data/conversations/a.jsonl"
  printf 'binary-ish state\n' > "$repo/command-center/.claude-flow/state.db"

  cp -- "$REPO_ROOT/install.sh" "$repo/install.sh"
  chmod +x "$repo/install.sh"
}

# ===========================================================================
# Scenario 1-4: fresh install, runtime-data survival, uninstall, dry-run
# ===========================================================================
REPO1="$WORK/fake-repo-1"
HOME1="$WORK/fake-home-1"
build_fake_repo "$REPO1" "1"
mkdir -p "$HOME1"

out=$(HOME="$HOME1" bash "$REPO1/install.sh" --global-only --yes 2>&1)
echo "$out" | tail -5

CC_DEST="$HOME1/.claude/forge/template/command-center"

# --- 1. shipped files present ---
for f in gateway/bin.mjs gateway/package.json discord/.env.example discord/src/main.js \
         discord/package.json dashboard/package.json dashboard/dist/index.html dashboard/dist/assets/app.js; do
  if [ -f "$CC_DEST/$f" ]; then ok "shipped: $f"; else bad "missing after fresh install: $CC_DEST/$f"; fi
done

# --- 1. excluded files absent ---
for f in gateway/node_modules/pkg/index.js gateway/some.log discord/.env discord/transcripts/call1.txt \
         discord/node_modules/dep/index.js dashboard/node_modules/x/y.js dashboard/test-results/foo.xml \
         dashboard/playwright-report/report.html dashboard/reports/mutation.html dashboard/coverage/index.html \
         .data/conversations/a.jsonl .claude-flow/state.db; do
  if [ ! -e "$CC_DEST/$f" ]; then ok "excluded: $f"; else bad "should NOT exist after install: $CC_DEST/$f"; fi
done

# --- 1. global manifest lists shipped files, never excluded ones ---
gmanifest="$HOME1/.claude/forge/install-manifest.json"
if [ -f "$gmanifest" ]; then
  if grep -q 'command-center/gateway/bin.mjs' "$gmanifest"; then ok "manifest lists gateway/bin.mjs"; else bad "manifest does not list gateway/bin.mjs"; fi
  if grep -q 'command-center/discord/.env"' "$gmanifest"; then bad "manifest lists the excluded discord/.env"; else ok "manifest does not list discord/.env"; fi
  if grep -q 'node_modules' "$gmanifest"; then bad "manifest lists a node_modules path"; else ok "manifest does not list any node_modules path"; fi
else
  bad "global install manifest was not written: $gmanifest"
fi

# --- 2. runtime data at the destination survives a re-install ---
mkdir -p "$CC_DEST/.data" "$CC_DEST/discord"
printf 'DISCORD_BOT_TOKEN=real-user-secret\n' > "$CC_DEST/discord/.env"
printf '{"real":"conversation"}\n' > "$CC_DEST/.data/x"
before_env_hash=$(sha256sum -- "$CC_DEST/discord/.env" | cut -d' ' -f1)
before_data_hash=$(sha256sum -- "$CC_DEST/.data/x" | cut -d' ' -f1)

HOME="$HOME1" bash "$REPO1/install.sh" --global-only --yes >/dev/null

after_env_hash=$(sha256sum -- "$CC_DEST/discord/.env" | cut -d' ' -f1)
after_data_hash=$(sha256sum -- "$CC_DEST/.data/x" | cut -d' ' -f1)
if [ "$before_env_hash" = "$after_env_hash" ]; then ok "discord/.env survived a re-install untouched"; else bad "discord/.env was modified by a re-install"; fi
if [ "$before_data_hash" = "$after_data_hash" ]; then ok ".data/x survived a re-install untouched"; else bad ".data/x was modified by a re-install"; fi

# --- 3. --uninstall removes an unmodified file, keeps an edited one, never touches runtime data ---
printf '// discord bot entry -- MY OWN LOCAL EDIT\n' >> "$CC_DEST/discord/src/main.js"
edited_hash_before=$(sha256sum -- "$CC_DEST/discord/src/main.js" | cut -d' ' -f1)

HOME="$HOME1" bash "$REPO1/install.sh" --uninstall --global-only --yes >/dev/null

if [ ! -f "$CC_DEST/gateway/bin.mjs" ]; then ok "unmodified gateway/bin.mjs was removed by --uninstall"; else bad "unmodified gateway/bin.mjs survived --uninstall"; fi
if [ -f "$CC_DEST/discord/src/main.js" ]; then
  edited_hash_after=$(sha256sum -- "$CC_DEST/discord/src/main.js" | cut -d' ' -f1)
  if [ "$edited_hash_before" = "$edited_hash_after" ]; then ok "edited discord/src/main.js was kept, byte-for-byte"; else bad "edited discord/src/main.js changed during --uninstall"; fi
else
  bad "edited discord/src/main.js was deleted by --uninstall (it should have been kept)"
fi
if [ -f "$CC_DEST/discord/.env" ]; then ok "discord/.env survived --uninstall"; else bad "discord/.env was deleted by --uninstall"; fi
if [ -f "$CC_DEST/.data/x" ]; then ok ".data/x survived --uninstall"; else bad ".data/x was deleted by --uninstall"; fi

# ===========================================================================
# Scenario 4: --dry-run writes nothing at all
# ===========================================================================
REPO2="$WORK/fake-repo-2"
HOME2="$WORK/fake-home-2"
build_fake_repo "$REPO2" "1"
mkdir -p "$HOME2"

HOME="$HOME2" bash "$REPO2/install.sh" --global-only --yes --dry-run >/dev/null

if [ ! -e "$HOME2/.claude" ]; then
  ok "--dry-run wrote nothing under \$HOME (.claude was never created)"
else
  bad "--dry-run created $HOME2/.claude -- it must write nothing"
fi

# ===========================================================================
# Scenario 5: dashboard/dist missing from the payload -- warn once, still succeed
# ===========================================================================
REPO3="$WORK/fake-repo-3"
HOME3="$WORK/fake-home-3"
build_fake_repo "$REPO3" "0"
mkdir -p "$HOME3"

set +e
out3=$(HOME="$HOME3" bash "$REPO3/install.sh" --global-only --yes 2>&1)
status3=$?
set -e
echo "$out3" | grep -i "dashboard" | head -3

if [ "$status3" -eq 0 ]; then ok "install still succeeds when dashboard/dist is missing"; else bad "install failed (exit $status3) when dashboard/dist was simply missing"; fi
if echo "$out3" | grep -qi "dashboard.*dist.*missing"; then ok "printed one honest NOTE that dashboard/dist is missing"; else bad "did not print the missing-dashboard/dist NOTE"; fi
if echo "$out3" | grep -qiE "run (npm|node) (run |install)|npm run build|npm install"; then
  bad "the missing-dist message tells the user to run a build/install command (it must not)"
else
  ok "the missing-dist message never tells the user to run a build command"
fi
if [ -f "$HOME3/.claude/forge/template/command-center/gateway/bin.mjs" ]; then
  ok "everything else in the Command Center still installed when dashboard/dist was missing"
else
  bad "gateway/bin.mjs did not install even though only dashboard/dist was missing"
fi

exit "$fail"
