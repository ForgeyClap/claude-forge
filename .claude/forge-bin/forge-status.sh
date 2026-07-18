#!/usr/bin/env bash
# Forge — project status (Bash/Git Bash). Delegates to forge.sh (Node detection). Project-local only.
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/forge.sh" status
