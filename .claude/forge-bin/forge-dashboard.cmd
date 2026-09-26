@echo off
REM Forge - start this project's dashboard (CMD). Delegates to forge.cmd (Node detection). Project-local only.
call "%~dp0forge.cmd" dashboard
REM WP-S4: propagate the real exit code - see forge-status.cmd's own note on "call" and a bare script end.
exit /b %ERRORLEVEL%
