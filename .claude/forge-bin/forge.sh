#!/usr/bin/env bash
# Forge dispatcher (Bash/Git Bash) — Node detection + project-local. Usage: bash forge.sh <command> [args]
DIR="$(cd "$(dirname "$0")" && pwd)"; DASH="$DIR/../forge-dashboard"
NODE_CMD="node"
if ! command -v node >/dev/null 2>&1; then
  if [ -x "/c/Program Files/nodejs/node.exe" ]; then NODE_CMD="/c/Program Files/nodejs/node.exe";
  elif [ -x "/mnt/c/Program Files/nodejs/node.exe" ]; then NODE_CMD="/mnt/c/Program Files/nodejs/node.exe";
  else echo "Node.js LTS is required to run Forge. Install Node.js LTS, close and reopen your terminal, then run node -v."; exit 1; fi
fi
# WP-P2 (v2.9.0, "forge dashboard works after a fresh install, with no manual steps"): ALL the decision
# logic (already-running reuse, project-local vs. central lookup, on-demand build, supervisor-vs-bin.mjs
# entry) now lives in forge-cc-launch.cjs — exactly like every other non-trivial subcommand below already
# delegates to its own tool (forge-runinfo.cjs, forge-config.cjs, ...). This wrapper just hands off; see
# that file's own header comment for the full behaviour and exit-code contract.
start_dashboard_or_fallback() {
  "$NODE_CMD" "$DIR/forge-cc-launch.cjs"
}
# v2.9.0 (WP-N1): the old per-project Control Center (server.cjs + its static UI) was REMOVED from
# .claude/forge-dashboard/ - there is nothing left to start here. log-event.cjs is the only file that
# remains in that folder, and it is not a dashboard.
show_legacy_dashboard_removed() {
  echo 'De oude per-project Forge Control Center is verwijderd in v2.9.0. Gebruik "forge dashboard" voor het Forge Command Center (http://127.0.0.1:4100).'
}
cmd="${1:-help}"; shift 2>/dev/null || true
case "$cmd" in
  dashboard|start) start_dashboard_or_fallback ;;
  legacy-dashboard) show_legacy_dashboard_removed ;;
  status)          "$NODE_CMD" "$DIR/forge-runinfo.cjs" status ;;
  runs)            "$NODE_CMD" "$DIR/forge-runinfo.cjs" runs ;;
  open-report)     "$NODE_CMD" "$DIR/forge-runinfo.cjs" open-report ;;
  health)          "$NODE_CMD" "$DIR/forge-runinfo.cjs" status ;;
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
  *) echo "Forge commands: dashboard | start | legacy-dashboard | status | runs | open-report | health | log-event | resume | learn | config | sweep | promptcheck" ;;
esac
