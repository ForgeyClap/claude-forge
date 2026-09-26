@echo off
REM Forge - project status (CMD). Delegates to forge.cmd (Node detection). Project-local only.
call "%~dp0forge.cmd" status
REM WP-S4 (v2.8.0 laptop-audit Part V-F): "call" sets %ERRORLEVEL% correctly here, but a batch file that
REM falls off the end without an explicit exit still returns 0 to whatever ran it - verified: without this
REM line the caller's own exit code was 0 even when forge.cmd's own real exit code was nonzero.
exit /b %ERRORLEVEL%
