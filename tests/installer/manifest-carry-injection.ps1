#Requires -Version 5.1
# Codex release gate RG-02 (2026-09-29), the Windows twin of manifest-carry-injection.sh. install.ps1 carries the old
# manifest entry of a kept project CLAUDE.md into the new manifest, so a re-install does not retire it. The old
# manifest is attacker-influenced input the moment a project is cloned or shared: a hash that is not a real sha256
# must never be carried. A genuine entry must still be carried, so a re-install keeps CLAUDE.md (the PR #4
# regression). Runs the REAL install.ps1 of this repo against a temp HOME and temp projects; the real worktree and
# home are never touched.
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
  # 1. a forged old manifest entry for CLAUDE.md whose hash is not a sha256: it tries to add an entry of its own
  $home1 = Join-Path $work 'home1'
  $proj1 = Join-Path $work 'proj1'
  New-Item -ItemType Directory -Force $home1 | Out-Null
  New-Project $proj1
  [System.IO.File]::WriteAllText((Join-Path $proj1 'notes.txt'), "user notes`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $proj1 'CLAUDE.md'), "# my own rules`n", $utf8)
  $evil = 'bad" }, { "path": "notes.txt", "sha256": "' + (Get-Sha256 (Join-Path $proj1 'notes.txt'))
  $forged = [ordered]@{ forge_version = '2.8.1'; scope = 'project'; files = @([ordered]@{ path = 'CLAUDE.md'; sha256 = $evil }) }
  $m1 = Join-Path $proj1 '.claude\.forge-install-manifest.json'
  [System.IO.File]::WriteAllText($m1, ($forged | ConvertTo-Json -Depth 5), $utf8)
  $claudeBefore = Get-Sha256 (Join-Path $proj1 'CLAUDE.md')

  $rc1 = Invoke-Install $home1 $proj1
  if ($rc1 -eq 0) { Ok 'install.ps1 finished on a forged manifest' } else { Bad "install.ps1 exited $rc1 on a forged manifest" }
  $j1 = Read-Manifest $m1
  if ($null -ne $j1) { Ok 'the new manifest is valid JSON' } else { Bad 'the new manifest is not valid JSON' }
  if ($null -ne $j1 -and @(Get-Entries $j1 'notes.txt').Count -eq 0) { Ok 'no injected entry reached the new manifest' } else { Bad 'a notes.txt entry reached the new manifest' }
  if ($null -ne $j1 -and @(Get-Entries $j1 'CLAUDE.md').Count -eq 0) { Ok 'the forged CLAUDE.md entry was not carried' } else { Bad 'a CLAUDE.md entry with a forged hash was carried' }
  if (Test-Path -LiteralPath (Join-Path $proj1 'notes.txt') -PathType Leaf) { Ok 'notes.txt is untouched' } else { Bad 'notes.txt was moved or deleted' }
  if ((Get-Sha256 (Join-Path $proj1 'CLAUDE.md')) -eq $claudeBefore) { Ok "the user's own CLAUDE.md is unchanged and in place" } else { Bad "the user's own CLAUDE.md was changed or moved" }

  # 2. a genuine entry IS carried: install twice into a fresh project, CLAUDE.md stays on disk and in the manifest
  $home2 = Join-Path $work 'home2'
  $proj2 = Join-Path $work 'proj2'
  New-Item -ItemType Directory -Force $home2 | Out-Null
  New-Project $proj2
  $rcA = Invoke-Install $home2 $proj2
  $rcB = Invoke-Install $home2 $proj2
  if ($rcA -eq 0 -and $rcB -eq 0) { Ok 'both installs finished' } else { Bad "the two installs exited $rcA and $rcB" }
  if (Test-Path -LiteralPath (Join-Path $proj2 'CLAUDE.md') -PathType Leaf) { Ok 'a re-install keeps the Forge-written CLAUDE.md' } else { Bad 'a re-install moved the Forge-written CLAUDE.md away' }
  $j2 = Read-Manifest (Join-Path $proj2 '.claude\.forge-install-manifest.json')
  $e2 = @()
  if ($null -ne $j2) { $e2 = @(Get-Entries $j2 'CLAUDE.md') }
  if ($e2.Count -eq 1 -and ([string]$e2[0].sha256) -match '^[0-9a-fA-F]{64}$') {
    Ok 'the carried CLAUDE.md entry is in the manifest with a real sha256'
  } else {
    Bad "the manifest holds $($e2.Count) CLAUDE.md entries, or its hash is not a sha256"
  }
} finally {
  Pop-Location
  $env:USERPROFILE = $origUserProfile
  $env:HOME = $origHome
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
exit $script:fail
