#Requires -Version 5.1
# Codex release gate RG-02 (2026-09-29), the Windows twin of manifest-carry-injection.sh. install.ps1 carries the old
# manifest entry of a kept project CLAUDE.md into the new manifest, so a re-install does not retire it. The old
# manifest is attacker-influenced input the moment a project is cloned or shared: a hash that is not a real sha256
# must never be carried. A genuine entry must still be carried, so a re-install keeps CLAUDE.md (the PR #4
# regression). RG-02-B (the verification round): '^...$' also accepts a trailing newline, so the forged value here is
# 64 hex characters plus a newline, and Get-ForgeOldManifestEntries itself must drop every malformed entry, which is
# what the Command Center carry reads. RG-02-C: "untouched" means the same content. Runs the REAL install.ps1 of this
# repo against a temp HOME and temp projects; the real worktree and home are never touched.
#
# Exit 0 = every check passed. Exit 1 = a check failed. Exit 2 = usage/setup error.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $here '..\..')).Path
$installPs1 = Join-Path $repoRoot 'install.ps1'
if (-not (Test-Path -LiteralPath $installPs1 -PathType Leaf)) {
  Write-Error "usage error: install.ps1 not found at $installPs1"
  exit 2
}

# A short root: the full project payload is copied below it.
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('forge-carry-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$origUserProfile = $env:USERPROFILE
$origHome = $env:HOME
$utf8 = New-Object System.Text.UTF8Encoding $false

$script:fail = 0
function Ok  { param([string]$Msg) Write-Host "ok   $Msg" }
function Bad { param([string]$Msg) Write-Host "FAIL $Msg"; $script:fail = 1 }

function Read-Manifest {
  param([string]$Path)
  try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}
function Get-Entries {
  param($Manifest, [string]$RelPath)
  return @($Manifest.files | Where-Object { $_.path -eq $RelPath })
}
function Get-Sha256 {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function New-Project {
  param([string]$Dir)
  New-Item -ItemType Directory -Force (Join-Path $Dir '.claude') | Out-Null
  & git -C $Dir init -q
  [System.IO.File]::WriteAllText((Join-Path $Dir 'README.md'), "# p`n", $utf8)
}
function Invoke-Install {
  param([string]$HomeDir, [string]$Proj)
  $env:USERPROFILE = $HomeDir
  $env:HOME = $HomeDir
  & powershell -NoProfile -ExecutionPolicy Bypass -File $installPs1 -ProjectDir $Proj -ProjectOnly -Yes | Out-Null
  return $LASTEXITCODE
}

# Run from inside the temp root, so nothing PowerShell itself writes can land in the repo.
Push-Location -LiteralPath $work
try {
  # 1. a forged old manifest entry for CLAUDE.md whose hash is 64 hex characters plus a newline (not a sha256)
  $home1 = Join-Path $work 'home1'
  $proj1 = Join-Path $work 'proj1'
  New-Item -ItemType Directory -Force $home1 | Out-Null
  New-Project $proj1
  [System.IO.File]::WriteAllText((Join-Path $proj1 'notes.txt'), "user notes`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $proj1 'CLAUDE.md'), "# my own rules`n", $utf8)
  $notesBefore = Get-Sha256 (Join-Path $proj1 'notes.txt')
  $claudeBefore = Get-Sha256 (Join-Path $proj1 'CLAUDE.md')
  $forged = [ordered]@{ forge_version = '2.8.1'; scope = 'project'; files = @([ordered]@{ path = 'CLAUDE.md'; sha256 = ($claudeBefore + "`n") }) }
  $m1 = Join-Path $proj1 '.claude\.forge-install-manifest.json'
  [System.IO.File]::WriteAllText($m1, ($forged | ConvertTo-Json -Depth 5), $utf8)

  $rc1 = Invoke-Install $home1 $proj1
  if ($rc1 -eq 0) { Ok 'install.ps1 finished on a forged manifest' } else { Bad "install.ps1 exited $rc1 on a forged manifest" }
  $j1 = Read-Manifest $m1
  if ($null -ne $j1) { Ok 'the new manifest is valid JSON' } else { Bad 'the new manifest is not valid JSON' }
  if ($null -ne $j1 -and @(Get-Entries $j1 'notes.txt').Count -eq 0) { Ok 'no injected entry reached the new manifest' } else { Bad 'a notes.txt entry reached the new manifest' }
  if ($null -ne $j1 -and @(Get-Entries $j1 'CLAUDE.md').Count -eq 0) { Ok 'the forged CLAUDE.md entry (64 hex plus a newline) was not carried' } else { Bad 'a CLAUDE.md entry with a forged hash was carried' }
  if ((Get-Sha256 (Join-Path $proj1 'notes.txt')) -eq $notesBefore) { Ok 'notes.txt is untouched (same content)' } else { Bad 'notes.txt was changed, moved or deleted' }
  if ((Get-Sha256 (Join-Path $proj1 'CLAUDE.md')) -eq $claudeBefore) { Ok "the user's own CLAUDE.md is untouched (same content)" } else { Bad "the user's own CLAUDE.md was changed or moved" }

  # 2. a genuine entry IS carried: install twice into a fresh project, CLAUDE.md stays on disk and in the manifest
  $home2 = Join-Path $work 'home2'
  $proj2 = Join-Path $work 'proj2'
  New-Item -ItemType Directory -Force $home2 | Out-Null
  New-Project $proj2
  $rcA = Invoke-Install $home2 $proj2
  $claude2 = Get-Sha256 (Join-Path $proj2 'CLAUDE.md')
  $rcB = Invoke-Install $home2 $proj2
  if ($rcA -eq 0 -and $rcB -eq 0) { Ok 'both installs finished' } else { Bad "the two installs exited $rcA and $rcB" }
  if ($claude2 -and (Get-Sha256 (Join-Path $proj2 'CLAUDE.md')) -eq $claude2) { Ok 'a re-install keeps the Forge-written CLAUDE.md (same content)' } else { Bad 'a re-install moved or changed the Forge-written CLAUDE.md' }
  $j2 = Read-Manifest (Join-Path $proj2 '.claude\.forge-install-manifest.json')
  $e2 = @()
  if ($null -ne $j2) { $e2 = @(Get-Entries $j2 'CLAUDE.md') }
  if ($e2.Count -eq 1 -and ([string]$e2[0].sha256) -match '\A[0-9a-fA-F]{64}\z') {
    Ok 'the carried CLAUDE.md entry is in the manifest with a real sha256'
  } else {
    Bad "the manifest holds $($e2.Count) CLAUDE.md entries, or its hash is not a sha256"
  }

  # 3. RG-02-B, the parser itself: the REAL Get-ForgeOldManifestEntries (taken from install.ps1's own syntax tree,
  #    never retyped) keeps only well-formed entries. The Command Center carry and the CLAUDE.md carry read its map.
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($installPs1, [ref]$tokens, [ref]$parseErrors)
  foreach ($fnName in @('Write-ForgeLog', 'Test-ForgeSafeManifestRelPath', 'Get-ForgeOldManifestEntries')) {
    $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $fnName }, $true)
    if (-not $fn) { Write-Host "setup error: $fnName not found in install.ps1"; exit 2 }
    . ([ScriptBlock]::Create($fn.Extent.Text))
  }
  $h = 'a' * 64
  $entries = @(
    [ordered]@{ path = 'trailing-lf.txt'; sha256 = ($h + "`n") },
    [ordered]@{ path = 'injection.txt'; sha256 = ('bad" }, { "path": "notes.txt", "sha256": "' + $h) },
    [ordered]@{ path = "trailing-lf-path.txt`n"; sha256 = $h },
    [ordered]@{ path = "newline`nin/path.txt"; sha256 = $h },
    [ordered]@{ path = ('ctrl' + [char]1 + '.txt'); sha256 = $h },
    [ordered]@{ path = "tab`tin/path.txt"; sha256 = $h },
    [ordered]@{ path = 'short-hash.txt'; sha256 = 'abc' },
    [ordered]@{ path = 'good/file.txt'; sha256 = $h },
    [ordered]@{ path = 'upper/file.txt'; sha256 = ('B' * 64) }
  )
  $forgedPath = Join-Path $work 'forged-old-manifest.json'
  [System.IO.File]::WriteAllText($forgedPath, ([ordered]@{ forge_version = '2.8.1'; scope = 'project'; files = $entries } | ConvertTo-Json -Depth 5), $utf8)
  $map = Get-ForgeOldManifestEntries -ManifestPath $forgedPath 6>$null
  $keys = @()
  if ($map) { $keys = @($map.Keys | Sort-Object) }
  if ($keys.Count -eq 2 -and $keys[0] -eq 'good/file.txt' -and $keys[1] -eq 'upper/file.txt') {
    Ok '3: the parser keeps only the two well-formed entries'
  } else {
    Bad ("3: the parser kept: " + (($keys | ForEach-Object { $_ -replace "`n", '\n' -replace "`t", '\t' }) -join ', '))
  }
} finally {
  Pop-Location
  $env:USERPROFILE = $origUserProfile
  $env:HOME = $origHome
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
exit $script:fail
