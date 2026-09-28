#Requires -Version 5.1
# WP-9B-INST regression test (Codex adversarial review, INSTALL-2 HIGH): a symlink/junction planted at
# a Command Center destination path (e.g. .../command-center/gateway pointing outside the template)
# must never be followed. Runs the REAL install.ps1 (copied byte-for-byte into a minimal fake payload,
# never retyped) against a temp HOME/project, so the real worktree is never touched. Covers the same
# four scenarios as the POSIX sibling command-center-symlink.sh -- see that file's own header comment
# for the full list. Junctions need no elevated privilege on Windows (unlike real symlinks), so this
# always runs, not just best-effort.
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

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-cc-symlink-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

$origUserProfile = $env:USERPROFILE
$origHome = $env:HOME

$script:fail = 0
function Ok  { param([string]$Msg) Write-Host "ok   $Msg" }
function Bad { param([string]$Msg) Write-Host "FAIL $Msg"; $script:fail = 1 }

function Get-Sha256 {
  param([string]$Path)
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Build-FakeRepo {
  param([string]$Repo)
  New-Item -ItemType Directory -Force (Join-Path $Repo 'global-install\.claude') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $Repo '.claude') | Out-Null
  Set-Content -LiteralPath (Join-Path $Repo 'global-install\.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $Repo '.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $Repo 'VERSION') -Value '0.0.0-test' -Encoding utf8

  $cc = Join-Path $Repo 'command-center'
  New-Item -ItemType Directory -Force (Join-Path $cc 'gateway') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $cc 'discord') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $cc 'dashboard\dist') | Out-Null
  Set-Content -LiteralPath (Join-Path $cc 'gateway\bin.mjs') -Value '// gateway entry point' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'discord\.env.example') -Value 'DISCORD_BOT_TOKEN=' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'dashboard\dist\index.html') -Value '<html>dashboard</html>' -Encoding utf8

  Copy-Item -LiteralPath $installPs1 -Destination (Join-Path $Repo 'install.ps1') -Force
}

try {
  $repo = Join-Path $work 'fake-repo'; $home1 = Join-Path $work 'fake-home'; $proj = Join-Path $work 'fake-proj'
  Build-FakeRepo -Repo $repo
  New-Item -ItemType Directory -Force $home1 | Out-Null
  New-Item -ItemType Directory -Force $proj | Out-Null
  $env:USERPROFILE = $home1; $env:HOME = $home1

  # ---------------------------------------------------------------------------
  # 1. a fresh (default, global+project) install succeeds normally.
  # ---------------------------------------------------------------------------
  $out1 = powershell -ExecutionPolicy Bypass -File (Join-Path $repo 'install.ps1') -ProjectDir $proj -Yes
  $status1 = $LASTEXITCODE
  if ($status1 -eq 0) { Ok "SCEN1: a fresh install (no link yet) succeeds" } else { Bad "SCEN1: a fresh install failed (exit $status1) -- fixture is broken"; Write-Host ($out1 -join "`n") }

  $ccDest = Join-Path $home1 '.claude\forge\template\command-center'
  if (-not (Test-Path -LiteralPath (Join-Path $ccDest 'gateway\bin.mjs') -PathType Leaf)) { Bad "SCEN1: fixture assumption broken: gateway\bin.mjs missing after a fresh install" }
  $envExamplePath = Join-Path $ccDest 'discord\.env.example'
  $envExampleHashBefore = Get-Sha256 $envExamplePath
  # The minimal fixture's canonical template only ever ships .claude\dummy.txt (see Build-FakeRepo) --
  # this is the one real file that proves the SEPARATE canonical-template copy step (before the Command
  # Center step) still ran.
  $templateDummy = Join-Path $home1 '.claude\forge\template\.claude\dummy.txt'
  if (-not (Test-Path -LiteralPath $templateDummy -PathType Leaf)) { Bad "SCEN1: fixture assumption broken: the canonical template's dummy.txt is missing after a fresh install" }

  # ---------------------------------------------------------------------------
  # 2/3/4: replace the real gateway\ directory with a junction pointing OUTSIDE the template (the
  # attack), then re-install. The whole Command Center copy must be refused; the rest of the install
  # (canonical template, project payload) must still succeed; existing CC files must survive untouched.
  # ---------------------------------------------------------------------------
  $outsideTarget = Join-Path $work 'outside-cc-target'
  New-Item -ItemType Directory -Force $outsideTarget | Out-Null
  $sentinel = Join-Path $outsideTarget 'sentinel.txt'
  Set-Content -LiteralPath $sentinel -Value 'nothing should ever be written next to me' -Encoding utf8
  $sentinelHashBefore = Get-Sha256 $sentinel

  $gatewayPath = Join-Path $ccDest 'gateway'
  Remove-Item -LiteralPath $gatewayPath -Recurse -Force
  New-Item -ItemType Junction -Path $gatewayPath -Target $outsideTarget -ErrorAction Stop | Out-Null

  $out2 = powershell -ExecutionPolicy Bypass -File (Join-Path $repo 'install.ps1') -ProjectDir $proj -Yes
  $status2 = $LASTEXITCODE
  $out2Text = ($out2 -join "`n")
  ($out2 -split "`n") | Where-Object { $_ -match '(?i)symlink|junction|command center' } | Select-Object -First 10 | ForEach-Object { Write-Host $_ }

  if ($status2 -ne 0) {
    Ok "SCEN2: the second install's own exit code reflects the Command Center refusal (non-zero)"
  } else {
    Bad "SCEN2: the second install reported success (exit 0) even though the Command Center copy should have been refused"
  }
  if ($out2Text -match '(?i)symlink or junction') {
    Ok "SCEN2: a clear message names a symlink or junction as the reason the Command Center was refused"
  } else {
    Bad "SCEN2: no clear symlink/junction message was printed"
  }
  if ($out2Text -match '(?i)remove that link') {
    Ok "SCEN2: the message tells the owner to remove the link"
  } else {
    Bad "SCEN2: the message does not tell the owner to remove the link"
  }

  $sentinelHashAfter = Get-Sha256 $sentinel
  $sentinelCountAfter = @(Get-ChildItem -LiteralPath $outsideTarget -File).Count
  if ($sentinelHashBefore -eq $sentinelHashAfter -and $sentinelCountAfter -eq 1) {
    Ok "SCEN2: nothing was written inside the link's target directory (still exactly the one sentinel file, unchanged)"
  } else {
    Bad "SCEN2: the link's target directory was modified -- the installer followed the junction"
  }

  if (Test-Path -LiteralPath $templateDummy -PathType Leaf) {
    Ok "SCEN3: the canonical template (copied in a separate step before the Command Center) still installed correctly"
  } else {
    Bad "SCEN3: the canonical template did not install -- the refusal wrongly affected an unrelated step"
  }
  if (Test-Path -LiteralPath (Join-Path $proj '.claude\dummy.txt') -PathType Leaf) {
    Ok "SCEN3: the project payload still installed correctly despite the Command Center refusal"
  } else {
    Bad "SCEN3: the project payload did not install -- the refusal wrongly affected an unrelated step"
  }

  $envExampleHashAfter = Get-Sha256 $envExamplePath
  if ($envExampleHashBefore -eq $envExampleHashAfter) {
    Ok "SCEN4: an existing, legitimate Command Center file (discord\.env.example) from install #1 survived byte-for-byte"
  } else {
    Bad "SCEN4: an existing, legitimate Command Center file was modified by the refused second install"
  }

  exit $script:fail
} finally {
  $env:USERPROFILE = $origUserProfile
  $env:HOME = $origHome
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
