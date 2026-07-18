# Forge — append a real event (PowerShell). Delegates to forge.ps1 (Node detection). Project-local only.
# Usage: .\forge-log-event.ps1 <run_id> <event_type> '<json>'
& "$PSScriptRoot\forge.ps1" log-event @args
