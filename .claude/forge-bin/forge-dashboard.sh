#!/usr/bin/env bash
# Forge — start this project's dashboard (Bash/Git Bash). Delegates to forge.sh (Node detection). Project-local only.
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/forge.sh" dashboard
