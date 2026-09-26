# Forge — print latest final report (PowerShell). Delegates to forge.ps1 (Node detection). Project-local only.
& "$PSScriptRoot\forge.ps1" open-report
# WP-S4: propagate the real exit code — see forge.ps1's own note on `powershell -File` and $LASTEXITCODE.
exit $LASTEXITCODE
