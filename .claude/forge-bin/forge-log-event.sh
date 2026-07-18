#!/usr/bin/env bash
# Forge — append a real event (Bash/Git Bash). Delegates to forge.sh (Node detection). Project-local only.
# Usage: bash forge-log-event.sh <run_id> <event_type> '<json>'
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/forge.sh" log-event "$@"
