@echo off
REM Forge dispatcher (CMD) - Node detection + project-local. Usage: forge.cmd COMMAND [args]
setlocal
REM Node detection: PATH first, then the Program Files fallback, then a clear message.
REM (Both REM lines above used to contain angle brackets and arrows, which cmd parses as redirection
REM even inside a comment: every invocation printed The system cannot find the file specified and
REM '---' is not recognized before doing its work. Audit 2026-09-23.)
set "NODE_CMD=node"
node -v >nul 2>nul
if not errorlevel 1 goto run
if exist "C:\Program Files\nodejs\node.exe" goto fallback
echo Node.js LTS is required for Forge Control Center. Install Node.js LTS, close and reopen your terminal, then run node -v.
exit /b 1
:fallback
set "NODE_CMD=C:\Program Files\nodejs\node.exe"
:run
REM BIN is captured HERE, before any shift. In cmd, shift also shifts argument zero, so after a shift the
REM script-directory variable points at the CALLER's working directory instead of this folder. The resume
REM and learn branches resolved their tool against the wrong directory for that reason (audit 2026-09-23).
REM NOTE for editors: cmd parses redirection and separator characters even inside REM lines, so comments
REM in this file must not contain angle brackets, ampersands, pipes or quote characters.
set "BIN=%~dp0"
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
REM real dashboard - start it (port 4100) instead of the old Control Center. If it exists but
REM dashboard/dist hasn't been built yet, say so honestly rather than failing silently. If
REM command-center/ doesn't exist at all (most projects today, no command-center yet), fall back
REM to the original per-project Control Center exactly as before. Deze fallback is VERVALLEN (audit G7):
REM this wrapper syncs to every other Forge project via the template, most of which have no
REM command-center. Old Control Center stays reachable regardless via legacy-dashboard.
if exist "%CC_GW%" (
  if exist "%CC_DIST_INDEX%" (
    "%NODE_CMD%" "%CC_GW%"
  ) else (
    echo Command Center found but not built yet. Run: cd command-center\dashboard ^&^& npm install ^&^& npm run build
  )
) else (
  REM AUDIT G7 (2026-08-06): de auto-fallback naar de RETIRED server.cjs is verwijderd - de
  REM canon (config/orchestration/forge-canon.json) verbiedt elke automatische start; alleen een
  REM expliciete owner-vraag (legacy-dashboard) mag hem nog starten.
  echo Forge Command Center niet aanwezig in dit project. De oude per-project Control Center (server.cjs) is RETIRED en start NOOIT automatisch (forge-canon.json). Vraag de owner expliciet om een legacy dashboard, of gebruik het centrale Command Center op 127.0.0.1:4100.
)
goto end
:logevent
REM Usage: forge.cmd log-event RUN_ID EVENT_TYPE payload.json     (recommended: any .json path)
REM        forge.cmd log-event RUN_ID EVENT_TYPE JSON_TOKEN       (inline, cmd doubled-quote escape only)
REM Why a file: the previous form forwarded the JSON as argv tokens, which cmd re-tokenises. Equals
REM signs, semicolons and commas inside the payload became spaces, and an ampersand inside a value
REM executed the rest of the line as a command (both reproduced by the external audit of 2026-09-23
REM against the shipped wrapper). Putting the payload in an environment variable does NOT help:
REM cmd toggles its quote state on every embedded quote, so an ampersand inside a JSON value can still
REM land in an unquoted stretch. The only payload cmd can never mangle is a file it never parses, so a
REM 4th argument whose extension is .json is passed to node with the file option and read there.
REM Inline JSON still works for simple payloads without ampersands, using the doubled-quote escape.
REM The extension check below never expands the payload itself into a command line.
REM goto-labels, not parenthesised blocks: cmd expands the 4th argument at parse time of a whole block,
REM so a JSON token with doubled quotes inside a block breaks the parser (syntax of the command is
REM incorrect). On a plain line it is forwarded as one token, exactly as the original wrapper did.
if "%~4"=="" goto logevent_noarg
if /I "%~x4"==".json" goto logevent_file
"%NODE_CMD%" "%DASH%\log-event.cjs" %2 %3 %4
goto end
:logevent_file
"%NODE_CMD%" "%DASH%\log-event.cjs" %2 %3 --file %4
goto end
:logevent_noarg
"%NODE_CMD%" "%DASH%\log-event.cjs" %2 %3
goto end
:resume
REM reconciles the run's manifest.json from logged events and reports which work packages remain
REM unfinished (forge-swarm-resume.cjs). Usage: forge.cmd resume --run RUN_ID [--json]
REM Uses BIN, captured before any shift (see the run label above).
shift
"%NODE_CMD%" "%BIN%forge-swarm-resume.cjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
goto end
:learn
REM read-only cross-project learning harvest into the reserved global lesson namespace (forge-harvest.cjs).
REM Usage: forge.cmd learn --scan DIR [--global-store FILE] [--dry-run] [--json]
shift
"%NODE_CMD%" "%BIN%forge-harvest.cjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
goto end
:help
echo Forge commands: dashboard ^| start ^| legacy-dashboard ^| status ^| runs ^| open-report ^| health ^| assign-only ^| log-event ^| resume ^| learn
:end
REM Propagate the tool's real exit code. The batch used to fall off the end and return 0 to the caller
REM even when node had failed (external audit II-G): a scheduled task or CI saw success on a failure.
exit /b %ERRORLEVEL%
endlocal
