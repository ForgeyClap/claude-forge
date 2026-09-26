#!/usr/bin/env bash
# Forge — print latest final report (Bash/Git Bash). Delegates to forge.sh (Node detection). Project-local only.
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/forge.sh" open-report
