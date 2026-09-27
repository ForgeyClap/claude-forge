#!/usr/bin/env bash
# Regression test (WP-P3): forge_manifest_add must degrade to a silent no-op, not a repeated
# "No such file or directory" error per file, when $MANIFEST_TMP no longer exists on disk (found
# by a real local run: a long-lived install.sh process can outlive its own mktemp -d scratch dir
# on some environments). Extracts the real functions from install.sh so this exercises the actual
# shipped code, not a re-typed copy.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd -P)
FUNCS_TMP=$(mktemp)
trap 'rm -f -- "$FUNCS_TMP"' EXIT
sed -n '/^forge_have_cmd/,/^}/p; /^forge_sha256/,/^}/p; /^forge_manifest_add/,/^}/p' "$REPO_ROOT/install.sh" > "$FUNCS_TMP"
source "$FUNCS_TMP"

MANIFEST_TMP=$(mktemp -d)
rmdir "$MANIFEST_TMP"   # simulate the scratch dir vanishing mid-run

err=$(forge_manifest_add "project" "$REPO_ROOT" "$REPO_ROOT/install.sh" 2>&1)
code=$?

if [ "$code" -ne 0 ]; then
  echo "FAIL: forge_manifest_add returned $code (expected 0) when MANIFEST_TMP was missing"
  exit 1
fi
if [ -n "$err" ]; then
  echo "FAIL: forge_manifest_add printed stderr noise when MANIFEST_TMP was missing: $err"
  exit 1
fi
echo "ok   forge_manifest_add is a silent no-op when \$MANIFEST_TMP has vanished"
