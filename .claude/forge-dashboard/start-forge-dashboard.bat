@echo off
REM Forge Control Center - project-local dashboard launcher (Windows)
REM Each project gets its own stable port (3737-3999, from the project path).
setlocal
cd /d "%~dp0"
echo Starting Forge Control Center for this project...
echo The actual URL (http://localhost:PORT) is printed below and stored in .claude\forge-dashboard\PORT
node "%~dp0server.cjs"
if errorlevel 1 (
  echo.
  echo Could not start the dashboard. Is Node.js installed? Try: node --version
  pause
)
endlocal
