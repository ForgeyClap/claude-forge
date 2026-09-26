# Forge — project status (PowerShell). Delegates to forge.ps1 (Node detection). Project-local only.
& "$PSScriptRoot\forge.ps1" status
# WP-S4: `& forge.ps1 ...` sets $LASTEXITCODE in THIS scope but does not, on its own, make THIS process's own
# exit code match it under `powershell -File` — explicit propagation needed here too (see forge.ps1's own note).
exit $LASTEXITCODE
