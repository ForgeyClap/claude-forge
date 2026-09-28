#Requires -Version 5.1
# WP-9B-INST regression test (Codex adversarial review, INSTALL-3 MEDIUM): a directory (or other
# non-file item) already sitting at a payload FILE's destination path must be refused cleanly, never
# silently Copy-Item'd INTO (which would nest the payload file inside it while still reporting
# success). Runs the REAL install.ps1 (copied byte-for-byte into a minimal fake payload, never
# retyped) against a temp HOME/project, so the real worktree is never touched. Covers the same four
# scenarios as the POSIX sibling copy-directory-destination.sh -- see that file's own header comment
# for the full list.
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

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-copy-dir-dest-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

$origUserProfile = $env:USERPROFILE
$origHome = $env:HOME

$script:fail = 0
function Ok  { param([string]$Msg) Write-Host "ok   $Msg" }
function Bad { param([string]$Msg) Write-Host "FAIL $Msg"; $script:fail = 1 }

try {
  $repo = Join-Path $work 'fake-repo'
  New-Item -ItemType Directory -Force (Join-Path $repo 'global-install\.claude') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $repo '.claude') | Out-Null
  Set-Content -LiteralPath (Join-Path $repo 'global-install\.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $repo '.claude\dummy.txt') -Value 'this is the real shipped file' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $repo '.claude\other-file.txt') -Value 'this is a second, unrelated shipped file' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $repo 'VERSION') -Value '0.0.0-test' -Encoding utf8
  Copy-Item -LiteralPath $installPs1 -Destination (Join-Path $repo 'install.ps1') -Force

  $fakeHome = Join-Path $work 'fake-home'
  $proj = Join-Path $work 'fake-proj'
  New-Item -ItemType Directory -Force $fakeHome | Out-Null
  New-Item -ItemType Directory -Force $proj | Out-Null

  # The attack/accident this fix closes: a DIRECTORY already sitting where a shipped FILE belongs.
  $dummyDir = Join-Path $proj '.claude\dummy.txt'
  New-Item -ItemType Directory -Force $dummyDir | Out-Null
  $marker = Join-Path $dummyDir 'nested-marker.txt'
  Set-Content -LiteralPath $marker -Value 'i should never be here' -Encoding utf8

  $env:USERPROFILE = $fakeHome; $env:HOME = $fakeHome
  $out = powershell -ExecutionPolicy Bypass -File (Join-Path $repo 'install.ps1') -ProjectDir $proj -ProjectOnly -Yes
  $status = $LASTEXITCODE
  $outText = ($out -join "`n")
  ($out -split "`n") | Where-Object { $_ -match '(?i)cannot write|directory|failed' } | Select-Object -First 10 | ForEach-Object { Write-Host $_ }

  # ---------------------------------------------------------------------------
  # 1 + 2: the directory is refused, never nested into, and left completely untouched.
  # ---------------------------------------------------------------------------
  if (Test-Path -LiteralPath $dummyDir -PathType Container) {
    Ok "SCEN1: the pre-existing directory at dummy.txt still exists (not deleted or replaced)"
  } else {
    Bad "SCEN1: the pre-existing directory at dummy.txt is gone -- it should never have been touched"
  }
  $entries = @(Get-ChildItem -LiteralPath $dummyDir -Force -ErrorAction SilentlyContinue)
  if ($entries.Count -eq 1 -and (Test-Path -LiteralPath $marker -PathType Leaf)) {
    Ok "SCEN1: nothing new was nested inside the directory (still exactly the one marker file)"
  } else {
    Bad "SCEN1: something changed inside the directory (found $($entries.Count) entr(y/ies)) -- the installer wrote into it"
  }
  if ($outText -match '(?i)cannot write') {
    Ok "SCEN1: a plain error names the write refusal"
  } else {
    Bad "SCEN1: no plain error was printed about the refused write"
  }

  # ---------------------------------------------------------------------------
  # 3: the overall install reports failure because of the one refused file.
  # ---------------------------------------------------------------------------
  if ($status -ne 0) {
    Ok "SCEN3: the install reports failure (non-zero exit) because of the directory-shaped destination"
  } else {
    Bad "SCEN3: the install reported success (exit 0) even though one payload file could not be written"
  }

  # ---------------------------------------------------------------------------
  # 4: every OTHER, unrelated payload file still installs correctly.
  # ---------------------------------------------------------------------------
  $otherFile = Join-Path $proj '.claude\other-file.txt'
  if ((Test-Path -LiteralPath $otherFile -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $otherFile) -match 'second, unrelated shipped file')) {
    Ok "SCEN4: an unrelated shipped file still installed correctly despite the one refusal"
  } else {
    Bad "SCEN4: an unrelated shipped file did NOT install -- the one refusal wrongly affected other files"
  }

  exit $script:fail
} finally {
  $env:USERPROFILE = $origUserProfile
  $env:HOME = $origHome
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
