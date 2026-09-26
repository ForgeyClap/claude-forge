#!/usr/bin/env bash
# Forge dispatcher (Bash/Git Bash) — Node detection + project-local. Usage: bash forge.sh <command> [args]
DIR="$(cd "$(dirname "$0")" && pwd)"; DASH="$DIR/../forge-dashboard"
CC_GW="$DIR/../../command-center/gateway/bin.mjs"
CC_DIST_INDEX="$DIR/../../command-center/dashboard/dist/index.html"
NODE_CMD="node"
if ! command -v node >/dev/null 2>&1; then
  if [ -x "/c/Program Files/nodejs/node.exe" ]; then NODE_CMD="/c/Program Files/nodejs/node.exe";
  elif [ -x "/mnt/c/Program Files/nodejs/node.exe" ]; then NODE_CMD="/mnt/c/Program Files/nodejs/node.exe";
  else echo "Node.js LTS is required for Forge Control Center. Install Node.js LTS, close and reopen your terminal, then run node -v."; exit 1; fi
fi
# WP7d: if THIS project has a Command Center (command-center/gateway/bin.mjs), it is now the real
# dashboard — start it (port 4100) instead of the old Control Center. If it exists but
# dashboard/dist hasn't been built yet, say so honestly rather than failing silently. If
# command-center/ doesn't exist at all (most projects today, no command-center yet), fall back to
# the original per-project Control Center exactly as before. This fallback is MANDATORY: this
# wrapper syncs to every other Forge project via the template, most of which have no
# command-center. The old Control Center stays reachable regardless via "legacy-dashboard".
start_dashboard_or_fallback() {
  if [ -f "$CC_GW" ]; then
    if [ -f "$CC_DIST_INDEX" ]; then
      "$NODE_CMD" "$CC_GW"
    else
      echo "Command Center found but not built yet. Run: cd command-center/dashboard && npm install && npm run build"
    fi
  else
    # AUDIT G7 (2026-08-06): auto-fallback naar de retired server.cjs verwijderd (forge-canon.json)
    echo "Forge Command Center niet aanwezig in dit project. De oude per-project Control Center (server.cjs) is RETIRED en start NOOIT automatisch (forge-canon.json). Vraag de owner expliciet om een legacy dashboard, of gebruik het centrale Command Center op 127.0.0.1:4100."
  fi
}
cmd="${1:-help}"; shift 2>/dev/null || true
case "$cmd" in
  dashboard|start) start_dashboard_or_fallback ;;
  legacy-dashboard) "$NODE_CMD" "$DASH/server.cjs" ;;
  status)          "$NODE_CMD" "$DASH/server.cjs" --status ;;
  runs)            "$NODE_CMD" "$DASH/server.cjs" --runs ;;
  open-report)     "$NODE_CMD" "$DASH/server.cjs" --open-report ;;
  health)          "$NODE_CMD" "$DASH/server.cjs" --health ;;
  assign-only)     "$NODE_CMD" "$DASH/server.cjs" --assign-only ;;
  log-event)       "$NODE_CMD" "$DASH/log-event.cjs" "$@" ;;
  # reconciles the run's manifest.json from logged events and reports which work packages remain
  # unfinished (forge-swarm-resume.cjs). Usage: bash forge.sh resume --run <run_id> [--json]
  resume)          "$NODE_CMD" "$DIR/forge-swarm-resume.cjs" "$@" ;;
  # read-only cross-project learning harvest into the reserved global lesson namespace (forge-harvest.cjs).
  # Usage: bash forge.sh learn --scan <dir> [--global-store <file>] [--dry-run] [--json]
  learn)           "$NODE_CMD" "$DIR/forge-harvest.cjs" "$@" ;;
  # the ONE settings tool: list/get/set/unset/reset/explain/diff/parse (forge-config.cjs, --help on each).
  # Usage: bash forge.sh config list|get|set|unset|reset|explain|diff|parse [args]
  config)          "$NODE_CMD" "$DIR/forge-config.cjs" "$@" ;;
  # resumable, checkpointed YouTube research sweep - captions/metadata only, never media (forge-sweep.cjs).
  # Usage: bash forge.sh sweep enumerate|filter|transcripts|extract|aggregate|status [args]
  sweep)           "$NODE_CMD" "$DIR/forge-sweep.cjs" "$@" ;;
  # Prompt Master dispatch-prompt linter, advisory only (forge-promptcheck.cjs); the ask subcommand scores
  # the raw owner request before Forge plans anything. Usage: bash forge.sh promptcheck <promptFile|-> [args]
  promptcheck)     "$NODE_CMD" "$DIR/forge-promptcheck.cjs" "$@" ;;
  *) echo "Forge commands: dashboard | start | legacy-dashboard | status | runs | open-report | health | assign-only | log-event | resume | learn | config | sweep | promptcheck" ;;
esac
