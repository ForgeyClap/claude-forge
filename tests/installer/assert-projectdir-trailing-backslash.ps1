#Requires -Version 5.1
# Regression test (F2b, 2026-09-27 independent v2.8.1 review): -ProjectDir "C:\My Proj\" (a real,
# space-containing path with a trailing backslash -- normal after tab-completion or an Explorer
# address-bar copy/paste) bound a clean PowerShell string to $ProjectDir, but install.ps1 then handed
# that same string to a NATIVE command (node.exe) as an argument. Windows' own CommandLineToArgvW
# convention reads a trailing backslash right before the closing quote PowerShell adds around a spaced
# argument as an ESCAPED quote, not a literal backslash -- node's argv actually received the corrupted
# `C:\My Proj"` instead. ConvertTo-ForgeCleanProjectPath (install.ps1) fixes this by trimming a
# trailing backslash/quote from $projectDir once, right where it is resolved. This test extracts the
# REAL function from install.ps1 (via the PowerShell parser, never a re-typed copy) and proves both the
# trimming logic AND the real node-argv round trip.
#
# Exit 0 = every check passed. Exit 1 = a check failed (see stderr). Exit 2 = usage/extraction error.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path -LiteralPath (Join-Path $here '..\..')
$installPs1 = Join-Path $repoRoot 'install.ps1'

if (-not (Test-Path -LiteralPath $installPs1 -PathType Leaf)) {
  Write-Error "usage error: install.ps1 not found at $installPs1"
  exit 2
}

# Extract ONLY the ConvertTo-ForgeCleanProjectPath function via the real PowerShell parser (AST), so
# this test dot-sources the exact shipped function text -- never a re-typed copy, and never runs the
# rest of install.ps1 (which would otherwise perform a real install as soon as it was sourced).
$parseErrors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installPs1, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) {
  Write-Error "usage error: install.ps1 does not parse ($($parseErrors.Count) error(s))"
  exit 2
}
$funcAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-ForgeCleanProjectPath' }, $true)
if (-not $funcAst) {
  Write-Error "FAIL: ConvertTo-ForgeCleanProjectPath is missing from install.ps1 -- the F2b fix was reverted"
  exit 1
}

$tmpFn = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-test-cleanpath-" + [guid]::NewGuid().ToString('N') + '.ps1')
try {
  [System.IO.File]::WriteAllText($tmpFn, $funcAst.Extent.Text, (New-Object System.Text.UTF8Encoding($false)))
  . $tmpFn
} finally {
  Remove-Item -LiteralPath $tmpFn -Force -ErrorAction SilentlyContinue
}

$fail = 0

function Assert-Eq {
  param([string]$Label, [string]$Actual, [string]$Expected)
  if ($Actual -ceq $Expected) {
    Write-Host "ok   $Label -> [$Actual]"
  } else {
    Write-Host "FAIL: $Label -> got [$Actual], expected [$Expected]"
    $script:fail = 1
  }
}

# --- pure trimming logic ---
Assert-Eq 'trailing backslash + space' (ConvertTo-ForgeCleanProjectPath 'C:\My Proj\') 'C:\My Proj'
Assert-Eq 'trailing forward slash'     (ConvertTo-ForgeCleanProjectPath 'C:/My Proj/') 'C:/My Proj'
Assert-Eq 'defensive trailing quote'   (ConvertTo-ForgeCleanProjectPath 'C:\My Proj\"') 'C:\My Proj'
Assert-Eq 'bare drive root preserved'  (ConvertTo-ForgeCleanProjectPath 'C:\') 'C:\'
Assert-Eq 'no trailing separator'      (ConvertTo-ForgeCleanProjectPath 'C:\My Proj') 'C:\My Proj'

# --- the real external boundary: node's own argv, not just our own string logic ---
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host "SKIP: node not found on PATH -- cannot verify the real node-argv round trip"
} else {
  $raw = 'C:\Some Real Dir With Spaces\'
  $rawOut = & node -e 'console.log(process.argv[1])' $raw
  $clean = ConvertTo-ForgeCleanProjectPath $raw
  $cleanOut = & node -e 'console.log(process.argv[1])' $clean

  # This documents the bug this fix protects against: the UNCLEANED path really does reach node
  # corrupted on this platform. If a future PowerShell/node change ever stops corrupting it, this
  # assertion (not the fix) would need revisiting -- it is not itself part of the fix's pass/fail
  # contract, so it only warns.
  if ($rawOut -eq $raw) {
    Write-Host "NOTE: the raw (uncleaned) path did not get corrupted on this run of node -- the underlying platform quirk may differ here"
  } else {
    Write-Host "ok   confirmed the underlying bug: the raw path reaches node corrupted ([$raw] -> [$rawOut])"
  }

  Assert-Eq 'node receives the CLEANED project path correctly' $cleanOut 'C:\Some Real Dir With Spaces'
}

exit $fail
