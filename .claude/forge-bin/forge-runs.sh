#!/usr/bin/env bash
# Forge — list recent runs (Bash/Git Bash). Delegates to forge.sh (Node detection). Project-local only.
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/forge.sh" runs
