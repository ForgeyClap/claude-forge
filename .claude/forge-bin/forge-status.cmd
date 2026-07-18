@echo off
REM Forge - project status (CMD). Delegates to forge.cmd (Node detection). Project-local only.
call "%~dp0forge.cmd" status
