@echo off
REM Forge - append a real event (CMD). Delegates to forge.cmd (Node detection). Project-local only.
REM Usage: forge-log-event.cmd RUN_ID EVENT_TYPE payload.json
REM Audit 2026-09-24 (security review LOW #5): forwards exactly three tokens (%1 %2 %3), never %*.
REM call re-expands any percent-variable-looking text found inside a forwarded %* blob, and %*
REM does not keep the caller pinned to a fixed three-argument shape the way %1 %2 %3 does - both
REM matter here because forge.cmd's log-event route now requires its 4th token to be a .json path.
call "%~dp0forge.cmd" log-event %1 %2 %3
