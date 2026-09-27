#!/usr/bin/env bash
# Regression test (F2, 2026-09-27 independent v2.8.1 review): before this fix,
# forge_check_standing_rules_migration (install.sh) treated a FORGE_STANDING_RULES.json that EXISTS but
# cannot be read or parsed (corrupt, locked, or an unreadable path) exactly the same as "no file yet, or
# nothing to migrate" -- migrateOwnerStandingRules()'s own read/parse failure returns the identical
# { length: 0, pending: false } for both cases (see that function's own doc comment in forge-sync.cjs,
# which this fix never edits). That meant the installer reported "safe to replace" and let a corrupt
# rules file be silently backed up and overwritten instead of kept. Extracts the real functions from
# install.sh (never a re-typed copy) so this exercises the actual shipped code.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd -P)

FUNCS_TMP=$(mktemp)
PROJ_DIR=$(mktemp -d)
trap 'rm -f -- "$FUNCS_TMP"; rm -rf -- "$PROJ_DIR"' EXIT

sed -n '
/^FORGE_STANDING_RULES_REL=/p
/^FORGE_STANDING_MIGRATE_JS=/,/^}.$/p
/^forge_log()/,/^}/p
/^forge_have_cmd()/,/^}/p
/^forge_check_standing_rules_migration()/,/^}/p
' "$REPO_ROOT/install.sh" > "$FUNCS_TMP"
source "$FUNCS_TMP"

mkdir -p "$PROJ_DIR/.claude/config/orchestration"
target="$PROJ_DIR/.claude/config/orchestration/FORGE_STANDING_RULES.json"
printf '{ this is not valid json -- corrupt on purpose' > "$target"
before_hash=$(sha256sum -- "$target" | cut -d' ' -f1)

fail=0

# --- real run: the corrupt file must be KEPT, with F2's own distinct message ---
forge_check_standing_rules_migration "$PROJ_DIR" "$REPO_ROOT/.claude" "0"

if [ -z "$FORGE_STANDING_MIGRATION_SKIP" ]; then
  echo "FAIL: FORGE_STANDING_MIGRATION_SKIP is empty -- a corrupt-but-present FORGE_STANDING_RULES.json was treated as safe to replace"
  fail=1
else
  echo "ok   FORGE_STANDING_MIGRATION_SKIP is set (the corrupt file will be kept)"
fi

case "$FORGE_STANDING_MIGRATION_REASON" in
  *"could not be read or parsed"*)
    echo "ok   FORGE_STANDING_MIGRATION_REASON names the real cause (could not be read or parsed)" ;;
  *)
    echo "FAIL: FORGE_STANDING_MIGRATION_REASON does not name the real cause: [$FORGE_STANDING_MIGRATION_REASON]"
    fail=1 ;;
esac

after_hash=$(sha256sum -- "$target" | cut -d' ' -f1)
if [ "$before_hash" != "$after_hash" ]; then
  echo "FAIL: the corrupt FORGE_STANDING_RULES.json was modified by the migration check itself"
  fail=1
else
  echo "ok   the corrupt file's bytes are untouched by the check itself"
fi

# --- F4: a dry run must report the SAME outcome as the real run above ---
FORGE_STANDING_MIGRATION_SKIP=""
FORGE_STANDING_MIGRATION_REASON=""
forge_check_standing_rules_migration "$PROJ_DIR" "$REPO_ROOT/.claude" "1"

if [ -z "$FORGE_STANDING_MIGRATION_SKIP" ]; then
  echo "FAIL: a dry run did not predict that the corrupt file would be kept"
  fail=1
else
  echo "ok   a dry run predicts the same 'kept' outcome as the real run"
fi

case "$FORGE_STANDING_MIGRATION_REASON" in
  *"could not be read or parsed"*)
    echo "ok   a dry run reports the same distinct reason as the real run" ;;
  *)
    echo "FAIL: a dry run's reason does not match the real run's: [$FORGE_STANDING_MIGRATION_REASON]"
    fail=1 ;;
esac

after_dryrun_hash=$(sha256sum -- "$target" | cut -d' ' -f1)
if [ "$before_hash" != "$after_dryrun_hash" ]; then
  echo "FAIL: a dry run modified the corrupt FORGE_STANDING_RULES.json"
  fail=1
else
  echo "ok   a dry run wrote nothing"
fi

exit "$fail"
