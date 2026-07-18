@echo off
REM Forge - print latest final report (CMD). Delegates to forge.cmd (Node detection). Project-local only.
call "%~dp0forge.cmd" open-report
