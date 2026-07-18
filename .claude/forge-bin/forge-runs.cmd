@echo off
REM Forge - list recent runs (CMD). Delegates to forge.cmd (Node detection). Project-local only.
call "%~dp0forge.cmd" runs
