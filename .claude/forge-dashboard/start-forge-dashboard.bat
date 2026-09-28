@echo off
REM Forge dashboard launcher (Windows). v2.9.0: the old per-project Control Center that used to live
REM in this folder was removed - this now starts the Forge Command Center (the one dashboard shared by
REM every Forge project, default http://127.0.0.1:4100) via the forge-bin wrapper, which finds/builds
REM it and prints the real URL to use.
setlocal
cd /d "%~dp0"
call "%~dp0..\forge-bin\forge-dashboard.cmd"
if errorlevel 1 (
  echo.
  echo Could not start the Forge Command Center. Is Node.js installed? Try: node --version
  pause
)
endlocal
