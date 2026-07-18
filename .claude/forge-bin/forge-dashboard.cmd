@echo off
REM Forge - start this project's dashboard (CMD). Delegates to forge.cmd (Node detection). Project-local only.
call "%~dp0forge.cmd" dashboard
