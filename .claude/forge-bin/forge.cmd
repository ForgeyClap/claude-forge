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
if "%~1"=="" goto help
if /I "%~1"=="dashboard"   ( "%NODE_CMD%" "%DASH%\server.cjs" & goto end )
if /I "%~1"=="start"       ( "%NODE_CMD%" "%DASH%\server.cjs" & goto end )
if /I "%~1"=="status"      ( "%NODE_CMD%" "%DASH%\server.cjs" --status & goto end )
if /I "%~1"=="runs"        ( "%NODE_CMD%" "%DASH%\server.cjs" --runs & goto end )
if /I "%~1"=="open-report" ( "%NODE_CMD%" "%DASH%\server.cjs" --open-report & goto end )
if /I "%~1"=="health"      ( "%NODE_CMD%" "%DASH%\server.cjs" --health & goto end )
if /I "%~1"=="assign-only" ( "%NODE_CMD%" "%DASH%\server.cjs" --assign-only & goto end )
if /I "%~1"=="log-event"   goto logevent
goto help
:logevent
shift
"%NODE_CMD%" "%DASH%\log-event.cjs" %1 %2 %3 %4 %5
goto end
:help
echo Forge commands: dashboard ^| start ^| status ^| runs ^| open-report ^| health ^| assign-only ^| log-event
:end
endlocal
