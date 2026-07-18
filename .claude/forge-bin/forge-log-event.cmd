@echo off
REM Forge - append a real event (CMD). Delegates to forge.cmd (Node detection). Project-local only.
REM Usage: forge-log-event.cmd <run_id> <event_type> "<json>"
call "%~dp0forge.cmd" log-event %*
