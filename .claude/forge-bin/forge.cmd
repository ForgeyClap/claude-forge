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
echo Node.js LTS is required to run Forge. Install Node.js LTS, close and reopen your terminal, then run node -v.
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
if "%~1"=="" goto help
if /I "%~1"=="dashboard"   goto dashboard_or_start
if /I "%~1"=="start"       goto dashboard_or_start
if /I "%~1"=="legacy-dashboard" goto legacydash
if /I "%~1"=="status"      ( "%NODE_CMD%" "%BIN%forge-runinfo.cjs" status & goto end )
if /I "%~1"=="runs"        ( "%NODE_CMD%" "%BIN%forge-runinfo.cjs" runs & goto end )
if /I "%~1"=="open-report" ( "%NODE_CMD%" "%BIN%forge-runinfo.cjs" open-report & goto end )
if /I "%~1"=="health"      ( "%NODE_CMD%" "%BIN%forge-runinfo.cjs" status & goto end )
if /I "%~1"=="log-event"   goto logevent
if /I "%~1"=="resume"      goto resume
if /I "%~1"=="learn"       goto learn
if /I "%~1"=="config"      goto config
if /I "%~1"=="sweep"       goto sweep
if /I "%~1"=="promptcheck" goto promptcheck
goto help
:dashboard_or_start
REM WP-P2 (v2.9.0, "forge dashboard works after a fresh install, with no manual steps"): ALL the decision
REM logic (already-running reuse, project-local vs. central lookup, on-demand build, supervisor-vs-bin.mjs
REM entry) now lives in forge-cc-launch.cjs - exactly like every other non-trivial subcommand here already
REM delegates to its own tool (forge-runinfo.cjs, forge-config.cjs, ...). This wrapper just hands off; see
REM that file's own header comment for the full behaviour and exit-code contract.
"%NODE_CMD%" "%BIN%forge-cc-launch.cjs"
goto end
:legacydash
REM v2.9.0 (WP-N1): the old per-project Control Center (server.cjs + its static UI) was REMOVED from
REM .claude/forge-dashboard/ - there is nothing left to start here. log-event.cjs is the only file that
REM remains in that folder, and it is not a dashboard.
echo De oude per-project Forge Control Center is verwijderd in v2.9.0. Gebruik "forge dashboard" voor het Forge Command Center (http://127.0.0.1:4100).
goto end
:logevent
REM Usage: forge.cmd log-event RUN_ID EVENT_TYPE payload.json - the .cmd wrapper accepts ONLY a .json path.
REM Audit 2026-09-24 (security review LOW #5): inline JSON is refused here on purpose. A backslash-escaped
REM quote, or JSON pasted from Windows PowerShell 5.1 (which does not escape embedded quotes), can flip
REM cmd's quote state so an ampersand inside a value runs the rest of the line as a command, and call
REM re-expands percent-variables found inside the payload too. A file cmd never parses is the only form
REM it cannot mangle, so a 4th argument is required and must end in .json; anything else is a usage error.
REM For an inline JSON string instead of a file, use forge.ps1 or forge.sh - see forge-bin README.md.
if "%~4"=="" goto logevent_noarg
if /I "%~x4"==".json" goto logevent_file
echo Usage: forge.cmd log-event RUN_ID EVENT_TYPE payload.json - only a .json file is accepted here; for inline JSON use forge.ps1 or forge.sh.
exit /b 2
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
:config
REM the ONE settings tool: list/get/set/unset/reset/explain/diff/parse (forge-config.cjs, --help on each).
REM Usage: forge.cmd config list, get, set, unset, reset, explain, diff or parse [args]
shift
"%NODE_CMD%" "%BIN%forge-config.cjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
goto end
:sweep
REM resumable, checkpointed YouTube research sweep - captions/metadata only, never media (forge-sweep.cjs).
REM Usage: forge.cmd sweep enumerate, filter, transcripts, extract, aggregate or status [args]
shift
"%NODE_CMD%" "%BIN%forge-sweep.cjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
goto end
:promptcheck
REM Prompt Master dispatch-prompt linter, advisory only (forge-promptcheck.cjs); the ask subcommand scores
REM the raw owner request before Forge plans anything. Usage: forge.cmd promptcheck promptFile (or a dash for stdin) [args]
shift
"%NODE_CMD%" "%BIN%forge-promptcheck.cjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
goto end
:help
echo Forge commands: dashboard ^| start ^| legacy-dashboard ^| status ^| runs ^| open-report ^| health ^| log-event ^| resume ^| learn ^| config ^| sweep ^| promptcheck
:end
REM Propagate the tool's real exit code. The batch used to fall off the end and return 0 to the caller
REM even when node had failed (external audit II-G): a scheduled task or CI saw success on a failure.
exit /b %ERRORLEVEL%
endlocal
