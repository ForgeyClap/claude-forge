# Forge — list recent runs (PowerShell). Delegates to forge.ps1 (Node detection). Project-local only.
& "$PSScriptRoot\forge.ps1" runs
# WP-S4: propagate the real exit code — see forge.ps1's own note on `powershell -File` and $LASTEXITCODE.
exit $LASTEXITCODE
