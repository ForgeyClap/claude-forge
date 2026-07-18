# Forge dispatcher (PowerShell) — Node detection + project-local. Usage: .\forge.ps1 <command> [args]
# Note: if PowerShell blocks scripts, use the .cmd wrappers, or:
#   powershell -ExecutionPolicy Bypass -File .\.claude\forge-bin\forge.ps1 <command>
$node = $null
$c = Get-Command node -ErrorAction SilentlyContinue
if ($c) { $node = $c.Source }
elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { $node = 'C:\Program Files\nodejs\node.exe' }
else {
  Write-Host 'Node.js LTS is required for Forge Control Center. Install Node.js LTS, close and reopen your terminal, then run node -v.'
  exit 1
}
$dash = "$PSScriptRoot\..\forge-dashboard"
$cmd = if ($args.Count -ge 1) { $args[0] } else { 'help' }
$rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }
switch ($cmd) {
  'dashboard'   { & $node "$dash\server.cjs" }
  'start'       { & $node "$dash\server.cjs" }
  'status'      { & $node "$dash\server.cjs" --status }
  'runs'        { & $node "$dash\server.cjs" --runs }
  'open-report' { & $node "$dash\server.cjs" --open-report }
  'health'      { & $node "$dash\server.cjs" --health }
  'assign-only' { & $node "$dash\server.cjs" --assign-only }
  'log-event'   { & $node "$dash\log-event.cjs" @rest }
  default       { Write-Host 'Forge commands: dashboard | start | status | runs | open-report | health | assign-only | log-event' }
}
