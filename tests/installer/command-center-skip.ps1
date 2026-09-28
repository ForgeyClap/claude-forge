#Requires -Version 5.1
# Unit test (WP-P3): Test-ForgeCommandCenterSkip (install.ps1) must skip exactly the runtime/build
# paths the Command Center installer documents -- node_modules, .data, .claude-flow, coverage
# (anywhere in the tree), discord/.env (the exact file; .env.example must NOT match),
# discord/transcripts/, discord/state/, dashboard/test-results|playwright-report|reports/, any
# *.log, and any *.env file besides *.env.example -- while never skipping a real payload file,
# including a near-miss name like discord/state-machine.js or discord/transcripts-viewer.js (must
# not match the discord/state or discord/transcripts PREFIX rules). Extracts the real function via
# the PowerShell parser (AST), never a re-typed copy, so this exercises the actual shipped code.
#
# Exit 0 = every check passed. Exit 1 = a check failed. Exit 2 = usage/extraction error.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path -LiteralPath (Join-Path $here '..\..')
$installPs1 = Join-Path $repoRoot 'install.ps1'

if (-not (Test-Path -LiteralPath $installPs1 -PathType Leaf)) {
  Write-Error "usage error: install.ps1 not found at $installPs1"
  exit 2
}

$parseErrors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installPs1, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) {
  Write-Error "usage error: install.ps1 does not parse ($($parseErrors.Count) error(s))"
  exit 2
}
$funcAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-ForgeCommandCenterSkip' }, $true)
if (-not $funcAst) {
  Write-Error "FAIL: Test-ForgeCommandCenterSkip is missing from install.ps1"
  exit 1
}

$tmpFn = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-test-ccskip-" + [guid]::NewGuid().ToString('N') + '.ps1')
try {
  [System.IO.File]::WriteAllText($tmpFn, $funcAst.Extent.Text, (New-Object System.Text.UTF8Encoding($false)))
  . $tmpFn
} finally {
  Remove-Item -LiteralPath $tmpFn -Force -ErrorAction SilentlyContinue
}

$fail = 0

function Assert-CCSkip {
  param([string]$Rel, [string]$Expect)
  $got = if (Test-ForgeCommandCenterSkip -RelPath $Rel) { 'skip' } else { 'keep' }
  if ($got -eq $Expect) {
    Write-Host "ok   [$Rel] -> $got"
  } else {
    Write-Host "FAIL [$Rel] -> got $got, expected $Expect"
    $script:fail = 1
  }
}

# --- must be SKIPPED ---
Assert-CCSkip 'gateway/node_modules/pkg/index.js' 'skip'
Assert-CCSkip 'node_modules/pkg/index.js' 'skip'
Assert-CCSkip '.data/conversations/a.jsonl' 'skip'
Assert-CCSkip 'discord/.claude-flow/state.db' 'skip'
Assert-CCSkip '.claude-flow/x' 'skip'
Assert-CCSkip 'dashboard/coverage/lcov-report/index.html' 'skip'
Assert-CCSkip 'coverage/x' 'skip'
Assert-CCSkip 'discord/.env' 'skip'
Assert-CCSkip 'discord/transcripts/call1.txt' 'skip'
Assert-CCSkip 'discord/transcripts' 'skip'
Assert-CCSkip 'discord/state/queue.json' 'skip'
Assert-CCSkip 'discord/state' 'skip'
Assert-CCSkip 'dashboard/test-results/foo.xml' 'skip'
Assert-CCSkip 'dashboard/playwright-report/report.html' 'skip'
Assert-CCSkip 'dashboard/reports/mutation.html' 'skip'
Assert-CCSkip 'gateway/foo.log' 'skip'
Assert-CCSkip 'discord/discord-bot.log' 'skip'
Assert-CCSkip 'discord/.env.local' 'skip'
Assert-CCSkip 'dashboard/.env.forge-setup' 'skip'
Assert-CCSkip 'dashboard/.env.tmp-abc123' 'skip'
Assert-CCSkip 'gateway/.env.staging.local' 'skip'

# --- must be KEPT (including near-miss names that share a prefix with a skip rule) ---
Assert-CCSkip 'gateway/bin.mjs' 'keep'
Assert-CCSkip 'gateway/src/server.mjs' 'keep'
Assert-CCSkip 'gateway/package.json' 'keep'
Assert-CCSkip 'discord/.env.example' 'keep'
Assert-CCSkip 'discord/src/main.js' 'keep'
Assert-CCSkip 'discord/package.json' 'keep'
Assert-CCSkip 'dashboard/dist/index.html' 'keep'
Assert-CCSkip 'dashboard/dist/assets/app.js' 'keep'
Assert-CCSkip 'dashboard/src/App.tsx' 'keep'
Assert-CCSkip 'dashboard/package.json' 'keep'
Assert-CCSkip 'dashboard/.env.example' 'keep'
Assert-CCSkip 'dashboard/README.md' 'keep'
Assert-CCSkip 'discord/README.md' 'keep'
Assert-CCSkip 'discord/state-machine.js' 'keep'
Assert-CCSkip 'discord/transcripts-viewer.js' 'keep'

exit $fail
