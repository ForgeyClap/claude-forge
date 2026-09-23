@echo off
REM Forge dispatcher (CMD) - Node detection + project-local. Usage: forge.cmd <command> [args]
setlocal
REM --- Node detection: PATH -> Program Files fallback -> clear message ---
set "NODE_CMD=node"
node -v >nul 2>nul
if not errorlevel 1 goto run
if exist "C:\Program Files\nodejs\node.exe" goto fallback
echo Node.js LTS is required for Forge Control Center. Install Node.js LTS, close and reopen your terminal, then run node -v.
exit /b 1
:fallback
set "NODE_CMD=C:\Program Files\nodejs\node.exe"
:run
set "DASH=%~dp0..\forge-dashboard"
set "CC_GW=%~dp0..\..\command-center\gateway\bin.mjs"
set "CC_DIST_INDEX=%~dp0..\..\command-center\dashboard\dist\index.html"
if "%~1"=="" goto help
if /I "%~1"=="dashboard"   goto dashboard_or_start
if /I "%~1"=="start"       goto dashboard_or_start
if /I "%~1"=="legacy-dashboard" ( "%NODE_CMD%" "%DASH%\server.cjs" & goto end )
if /I "%~1"=="status"      ( "%NODE_CMD%" "%DASH%\server.cjs" --status & goto end )
if /I "%~1"=="runs"        ( "%NODE_CMD%" "%DASH%\server.cjs" --runs & goto end )
if /I "%~1"=="open-report" ( "%NODE_CMD%" "%DASH%\server.cjs" --open-report & goto end )
if /I "%~1"=="health"      ( "%NODE_CMD%" "%DASH%\server.cjs" --health & goto end )
if /I "%~1"=="assign-only" ( "%NODE_CMD%" "%DASH%\server.cjs" --assign-only & goto end )
if /I "%~1"=="log-event"   goto logevent
if /I "%~1"=="resume"      goto resume
if /I "%~1"=="learn"       goto learn
goto help
:dashboard_or_start
REM WP7d: if THIS project has a Command Center (command-center/gateway/bin.mjs), it is now the
REM real dashboard — start it (port 4100) instead of the old Control Center. If it exists but
REM dashboard/dist hasn't been built yet, say so honestly rather than failing silently. If
REM command-center/ doesn't exist at all (most projects today, no command-center yet), fall back
REM to the original per-project Control Center exactly as before. Deze fallback is VERVALLEN (audit G7):
REM this wrapper syncs to every other Forge project via the template, most of which have no
REM command-center. Old Control Center stays reachable regardless via "legacy-dashboard".
if exist "%CC_GW%" (
  if exist "%CC_DIST_INDEX%" (
    "%NODE_CMD%" "%CC_GW%"
  ) else (
    echo Command Center found but not built yet. Run: cd command-center\dashboard ^&^& npm install ^&^& npm run build
  )
) else (
  REM AUDIT G7 (2026-08-06): de auto-fallback naar de RETIRED server.cjs is verwijderd — de
  REM canon (config/orchestration/forge-canon.json) verbiedt elke automatische start; alleen een
  REM expliciete owner-vraag (legacy-dashboard) mag hem nog starten.
  echo Forge Command Center niet aanwezig in dit project. De oude per-project Control Center (server.cjs) is RETIRED en start NOOIT automatisch (forge-canon.json). Vraag de owner expliciet om een legacy dashboard, of gebruik het centrale Command Center op 127.0.0.1:4100.
)
goto end
:logevent
REM Codex F14: forward %1..%9 (was %1..%5 — silently truncated a 6th+ forwarded arg, e.g. a longer
REM `learn` invocation). %1..%9 are cmd's raw, unshifted-per-arg tokens: each keeps its own original
REM quoting exactly as the caller typed it (verified live: a JSON arg with spaces, an & character, AND
REM embedded quotes survives this exact substitution intact — see the build report for the literal
REM proof run against run id forge-2026-07-26-command-center). Do NOT rewrite this via %*: %* is NOT
REM re-shifted by `shift` (a well-known cmd gotcha) and would keep re-including the subcommand token.
shift
"%NODE_CMD%" "%DASH%\log-event.cjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
goto end
:resume
REM reconciles the run's manifest.json from logged events and reports which work packages remain
REM unfinished (forge-swarm-resume.cjs). Usage: forge.cmd resume --run <run_id> [--json]
REM Codex F14: %1..%9, not %1..%5 — see the :logevent comment above for why.
shift
"%NODE_CMD%" "%~dp0forge-swarm-resume.cjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
goto end
:learn
REM read-only cross-project learning harvest into the reserved global lesson namespace (forge-harvest.cjs).
REM Usage: forge.cmd learn --scan <dir> [--global-store <file>] [--dry-run] [--json]
REM Codex F14: %1..%9, not %1..%5 — `learn`'s own full form (--scan <dir> --global-store <file>
REM --dry-run --json) is 6 tokens after "learn", which the old %1..%5 cap silently dropped the tail of.
shift
"%NODE_CMD%" "%~dp0forge-harvest.cjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
goto end
:help
echo Forge commands: dashboard ^| start ^| legacy-dashboard ^| status ^| runs ^| open-report ^| health ^| assign-only ^| log-event ^| resume ^| learn
:end
endlocal
