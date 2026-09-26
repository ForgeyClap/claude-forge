# Forge — append a real event (PowerShell). Delegates to forge.ps1 (Node detection). Project-local only.
# Usage: .\forge-log-event.ps1 <run_id> <event_type> '<json>'
& "$PSScriptRoot\forge.ps1" log-event @args
# WP-S4: propagate the real exit code — see forge.ps1's own note on `powershell -File` and $LASTEXITCODE.
exit $LASTEXITCODE
