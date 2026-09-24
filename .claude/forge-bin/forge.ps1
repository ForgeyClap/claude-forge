# Forge dispatcher (PowerShell) — Node detection + project-local. Usage: .\forge.ps1 <command> [args]
# Note: if PowerShell blocks scripts, use the .cmd wrappers, or:
#   powershell -ExecutionPolicy Bypass -File .\.claude\forge-bin\forge.ps1 <command>
$node = $null
$c = Get-Command node -ErrorAction SilentlyContinue
if ($c) { $node = $c.Source }
elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { $node = 'C:\Program Files\nodejs\node.exe' }
else {
  Write-Host 'Node.js LTS is required for Forge Control Center. Install Node.js LTS, close and reopen your terminal, then run node -v.'
  exit 1
}
$dash = "$PSScriptRoot\..\forge-dashboard"
$ccGateway = "$PSScriptRoot\..\..\command-center\gateway\bin.mjs"
$ccDistIndex = "$PSScriptRoot\..\..\command-center\dashboard\dist\index.html"
$cmd = if ($args.Count -ge 1) { $args[0] } else { 'help' }

# WP7d: if THIS project has a Command Center (command-center/gateway/bin.mjs), it is now the real
# dashboard — start it (port 4100) instead of the old Control Center. If it exists but
# dashboard/dist hasn't been built yet, say so honestly rather than failing silently. If
# command-center/ doesn't exist at all (most projects today, no command-center yet), fall back to
# the original per-project Control Center exactly as before. This fallback is MANDATORY: this
# wrapper syncs to every other Forge project via the template, most of which have no
# command-center. The old Control Center stays reachable regardless via 'legacy-dashboard'.
function Start-DashboardOrFallback {
  if (Test-Path $ccGateway) {
    if (Test-Path $ccDistIndex) {
      & $node $ccGateway
    } else {
      Write-Host 'Command Center found but not built yet. Run: cd command-center/dashboard && npm install && npm run build'
    }
  } else {
    # AUDIT G7 (2026-08-06): auto-fallback naar de retired server.cjs verwijderd (forge-canon.json)
    Write-Host 'Forge Command Center niet aanwezig in dit project. De oude per-project Control Center (server.cjs) is RETIRED en start NOOIT automatisch (forge-canon.json). Vraag de owner expliciet om een legacy dashboard, of gebruik het centrale Command Center op 127.0.0.1:4100.'
  }
}
# Pre-existing bug found+fixed while wiring `learn` (2026-07-18): when exactly ONE trailing arg exists,
# `$args[1..($args.Count-1)]` is a 1-element array, but PowerShell's `if`-as-expression enumerates a
# single-element array output and COLLAPSES it to a bare scalar STRING on assignment. `@rest` splat on a
# bare string then explodes it character-by-character (PowerShell treats a string as IEnumerable<char>),
# so `forge.ps1 learn --json` silently forwarded ['-','-','j','s','o','n'] to node instead of ['--json'] —
# reproduced directly (`node -e "console.log(process.argv.slice(2))" @rest`) before fixing. Only surfaced
# now because forge-harvest.cjs's parseArgs is the first subcommand strict enough to reject the garbage
# tokens instead of silently ignoring them; `log-event`/`resume` shared the exact same latent bug. Fix:
# the unary comma operator `,(...)` wraps the slice in an explicit array literal BEFORE it leaves the
# `if` block, so a single-element result is never collapsed to a scalar (2+ elements were never affected).
$rest = if ($args.Count -gt 1) { , $args[1..($args.Count - 1)] } else { @() }
switch ($cmd) {
  'dashboard'   { Start-DashboardOrFallback }
  'start'       { Start-DashboardOrFallback }
  'legacy-dashboard' { & $node "$dash\server.cjs" }
  'status'      { & $node "$dash\server.cjs" --status }
  'runs'        { & $node "$dash\server.cjs" --runs }
  'open-report' { & $node "$dash\server.cjs" --open-report }
  'health'      { & $node "$dash\server.cjs" --health }
  'assign-only' { & $node "$dash\server.cjs" --assign-only }
  'log-event'   {
    # Windows PowerShell 5.1 strips the quotes off a JSON argument when it calls a native executable, so
    # `.\forge.ps1 log-event <run> <type> '{"note":"x"}'` reached log-event.cjs as {note:x} and failed with
    # "Invalid extra JSON" (external audit II-G, 2026-09-23). The payload now travels in an environment
    # variable, which no shell re-tokenises; and the real exit code is returned instead of a silent 0.
    if ($rest.Count -ge 3) {
      $env:FORGE_EVENT_JSON = [string]$rest[2]
      & $node "$dash\log-event.cjs" $rest[0] $rest[1] --env FORGE_EVENT_JSON
    } else {
      & $node "$dash\log-event.cjs" @rest
    }
    exit $LASTEXITCODE
  }
  # reconciles the run's manifest.json from logged events and reports which work packages remain
  # unfinished (forge-swarm-resume.cjs). Usage: .\forge.ps1 resume --run <run_id> [--json]
  'resume'      { & $node "$PSScriptRoot\forge-swarm-resume.cjs" @rest }
  # read-only cross-project learning harvest into the reserved global lesson namespace (forge-harvest.cjs).
  # Usage: .\forge.ps1 learn --scan <dir> [--global-store <file>] [--dry-run] [--json]
  'learn'       { & $node "$PSScriptRoot\forge-harvest.cjs" @rest }
  # the ONE settings tool: list/get/set/unset/reset/explain/diff/parse (forge-config.cjs, --help on each).
  # Usage: .\forge.ps1 config list|get|set|unset|reset|explain|diff|parse [args]
  'config'      { & $node "$PSScriptRoot\forge-config.cjs" @rest }
  # resumable, checkpointed YouTube research sweep - captions/metadata only, never media (forge-sweep.cjs).
  # Usage: .\forge.ps1 sweep enumerate|filter|transcripts|extract|aggregate|status [args]
  'sweep'       { & $node "$PSScriptRoot\forge-sweep.cjs" @rest }
  # Prompt Master dispatch-prompt linter, advisory only (forge-promptcheck.cjs); the ask subcommand scores
  # the raw owner request before Forge plans anything. Usage: .\forge.ps1 promptcheck <promptFile|-> [args]
  'promptcheck' { & $node "$PSScriptRoot\forge-promptcheck.cjs" @rest }
  default       { Write-Host 'Forge commands: dashboard | start | legacy-dashboard | status | runs | open-report | health | assign-only | log-event | resume | learn | config | sweep | promptcheck' }
}
