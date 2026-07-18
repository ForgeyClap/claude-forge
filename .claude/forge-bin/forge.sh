#!/usr/bin/env bash
# Forge dispatcher (Bash/Git Bash) — Node detection + project-local. Usage: bash forge.sh <command> [args]
DIR="$(cd "$(dirname "$0")" && pwd)"; DASH="$DIR/../forge-dashboard"
NODE_CMD="node"
if ! command -v node >/dev/null 2>&1; then
  if [ -x "/c/Program Files/nodejs/node.exe" ]; then NODE_CMD="/c/Program Files/nodejs/node.exe";
  elif [ -x "/mnt/c/Program Files/nodejs/node.exe" ]; then NODE_CMD="/mnt/c/Program Files/nodejs/node.exe";
  else echo "Node.js LTS is required for Forge Control Center. Install Node.js LTS, close and reopen your terminal, then run node -v."; exit 1; fi
fi
cmd="${1:-help}"; shift 2>/dev/null || true
case "$cmd" in
  dashboard|start) "$NODE_CMD" "$DASH/server.cjs" ;;
  status)          "$NODE_CMD" "$DASH/server.cjs" --status ;;
  runs)            "$NODE_CMD" "$DASH/server.cjs" --runs ;;
  open-report)     "$NODE_CMD" "$DASH/server.cjs" --open-report ;;
  health)          "$NODE_CMD" "$DASH/server.cjs" --health ;;
  assign-only)     "$NODE_CMD" "$DASH/server.cjs" --assign-only ;;
  log-event)       "$NODE_CMD" "$DASH/log-event.cjs" "$@" ;;
  *) echo "Forge commands: dashboard | start | status | runs | open-report | health | assign-only | log-event" ;;
esac
