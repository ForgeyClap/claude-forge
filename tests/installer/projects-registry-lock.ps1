#Requires -Version 5.1
# WP-9B-INST regression test (Codex adversarial review, INSTALL-4 LOW): two installs racing on the
# SAME $HOME\.claude\forge\projects.json must not lose either update, and a lock left behind by a
# crashed/killed installer must not wedge every future install forever. Runs the REAL install.ps1
# (copied byte-for-byte into a minimal fake payload, never retyped) against a temp HOME, so the real
# worktree is never touched. Covers the same two scenarios as the POSIX sibling
# projects-registry-lock.sh -- see that file's own header comment for the full list.
#
# Exit 0 = every check passed. Exit 1 = a check failed. Exit 2 = usage/setup error.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path -LiteralPath (Join-Path $here '..\..')
$installPs1 = Join-Path $repoRoot 'install.ps1'

if (-not (Test-Path -LiteralPath $installPs1 -PathType Leaf)) {
  Write-Error "usage error: install.ps1 not found at $installPs1"
  exit 2
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host "SKIP: node not found on PATH -- the projects registry feature itself requires node; nothing to test"
  exit 0
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-projects-registry-lock-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

$origUserProfile = $env:USERPROFILE
$origHome = $env:HOME

$script:fail = 0
function Ok  { param([string]$Msg) Write-Host "ok   $Msg" }
function Bad { param([string]$Msg) Write-Host "FAIL $Msg"; $script:fail = 1 }

function Get-RegistryProjectCount {
  param([string]$RegistryPath)
  (Get-Content -Raw -LiteralPath $RegistryPath | ConvertFrom-Json).projects.Count
}

function Test-RegistryHasProject {
  param([string]$RegistryPath, [string]$ProjectPath)
  $projects = @((Get-Content -Raw -LiteralPath $RegistryPath | ConvertFrom-Json).projects)
  return $projects -contains $ProjectPath
}

function Build-FakeRepo {
  param([string]$Repo)
  New-Item -ItemType Directory -Force (Join-Path $Repo 'global-install\.claude') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $Repo '.claude') | Out-Null
  Set-Content -LiteralPath (Join-Path $Repo 'global-install\.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $Repo '.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $Repo 'VERSION') -Value '0.0.0-test' -Encoding utf8
  Copy-Item -LiteralPath $installPs1 -Destination (Join-Path $Repo 'install.ps1') -Force
}

try {
  # =========================================================================
  # Scenario 1: a stale lock (LastWriteTime far in the past) is reclaimed promptly, the install still
  # succeeds.
  # =========================================================================
  $repo1 = Join-Path $work 'fake-repo-1'; $home1 = Join-Path $work 'fake-home-1'; $proj1 = Join-Path $work 'fake-proj-1'
  Build-FakeRepo -Repo $repo1
  New-Item -ItemType Directory -Force $home1 | Out-Null
  New-Item -ItemType Directory -Force $proj1 | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $home1 '.claude\forge') | Out-Null
  $registry1 = Join-Path $home1 '.claude\forge\projects.json'
  $lock1 = "$registry1.lock"
  New-Item -ItemType Directory -Force $lock1 | Out-Null
  # 5 minutes in the past -- comfortably older than the ~2-minute staleness threshold.
  (Get-Item -LiteralPath $lock1).LastWriteTime = (Get-Date).AddMinutes(-5)

  $env:USERPROFILE = $home1; $env:HOME = $home1
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & powershell -ExecutionPolicy Bypass -File (Join-Path $repo1 'install.ps1') -ProjectDir $proj1 -ProjectOnly -Yes | Out-Null
  $status1 = $LASTEXITCODE
  $sw.Stop()

  if ($status1 -eq 0) {
    Ok "SCEN1: the install still succeeds despite a stale lock left behind"
  } else {
    Bad "SCEN1: the install FAILED (exit $status1) because of a stale lock"
  }
  if (-not (Test-Path -LiteralPath $lock1)) {
    Ok "SCEN1: the stale lock directory was cleaned up"
  } else {
    Bad "SCEN1: the stale lock directory is still present after the install"
  }
  if (Test-RegistryHasProject -RegistryPath $registry1 -ProjectPath $proj1) {
    Ok "SCEN1: the project was still recorded despite the stale lock"
  } else {
    Bad "SCEN1: the project was NOT recorded -- the stale lock blocked the update"
  }
  # A generous ceiling: the stale-lock path should reclaim near-instantly, nowhere close to the full
  # 5-second "another install is still active" timeout this same code uses for a LIVE lock.
  if ($sw.Elapsed.TotalSeconds -lt 4) {
    Ok "SCEN1: the stale lock was reclaimed promptly ($([math]::Round($sw.Elapsed.TotalSeconds, 1))s), not after waiting out the live-lock timeout"
  } else {
    Bad "SCEN1: reclaiming the stale lock took suspiciously long ($([math]::Round($sw.Elapsed.TotalSeconds, 1))s) -- it may have waited out the live-lock timeout instead of detecting staleness"
  }

  # =========================================================================
  # Scenario 2: two installer PROCESSES racing on the SAME projects.json, deliberately forced to
  # contend for the SAME lock at the SAME instant, both keep their own entry.
  # =========================================================================
  $repo2 = Join-Path $work 'fake-repo-2'; $home2 = Join-Path $work 'fake-home-2'
  Build-FakeRepo -Repo $repo2
  $projA = Join-Path $work 'projects\race-a'
  $projB = Join-Path $work 'projects\race-b'
  New-Item -ItemType Directory -Force $home2 | Out-Null
  New-Item -ItemType Directory -Force $projA | Out-Null
  New-Item -ItemType Directory -Force $projB | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $home2 '.claude\forge') | Out-Null
  $registry2 = Join-Path $home2 '.claude\forge\projects.json'
  $lock2 = "$registry2.lock"

  # This TEST process holds the lock FIRST, so both installer processes launched below are guaranteed
  # to start their own read-modify-write while the registry is already locked, forcing real contention
  # instead of hoping two independent processes happen to overlap by luck.
  New-Item -ItemType Directory -Force $lock2 | Out-Null

  $env:USERPROFILE = $home2; $env:HOME = $home2
  $logA = Join-Path $work 'out-a.log'
  $logB = Join-Path $work 'out-b.log'
  $errA = Join-Path $work 'out-a.err.log'
  $errB = Join-Path $work 'out-b.err.log'
  $installScript2 = Join-Path $repo2 'install.ps1'
  $procA = Start-Process -FilePath 'powershell' -ArgumentList @('-ExecutionPolicy', 'Bypass', '-File', $installScript2, '-ProjectDir', $projA, '-ProjectOnly', '-Yes') -RedirectStandardOutput $logA -RedirectStandardError $errA -PassThru -WindowStyle Hidden
  $procB = Start-Process -FilePath 'powershell' -ArgumentList @('-ExecutionPolicy', 'Bypass', '-File', $installScript2, '-ProjectDir', $projB, '-ProjectOnly', '-Yes') -RedirectStandardOutput $logB -RedirectStandardError $errB -PassThru -WindowStyle Hidden
  # Touching .Handle right after Start-Process -PassThru is a well-known, documented workaround: without
  # it, .ExitCode can come back empty/unreliable later even after WaitForExit() genuinely completes.
  [void]$procA.Handle
  [void]$procB.Handle

  # Give both children time to actually reach fs.mkdirSync(lockPath) and start their own retry-wait
  # loop before this test releases the lock -- generous relative to the 50ms retry interval the fix uses.
  Start-Sleep -Seconds 1
  Remove-Item -LiteralPath $lock2 -Recurse -Force -ErrorAction SilentlyContinue

  $procA.WaitForExit()
  $procB.WaitForExit()
  $statusA = $procA.ExitCode
  $statusB = $procB.ExitCode

  if ($statusA -eq 0 -and $statusB -eq 0) {
    Ok "SCEN2: both racing installs exited successfully"
  } else {
    Bad "SCEN2: at least one racing install failed (a=$statusA, b=$statusB)"
    Write-Host (Get-Content -Raw -LiteralPath $logA -ErrorAction SilentlyContinue)
    Write-Host (Get-Content -Raw -LiteralPath $logB -ErrorAction SilentlyContinue)
  }

  $count2 = Get-RegistryProjectCount -RegistryPath $registry2
  if ($count2 -eq 2) {
    Ok "SCEN2: the registry has exactly 2 entries -- neither concurrent update was lost"
  } else {
    Bad "SCEN2: expected exactly 2 entries after two concurrent installs, got: $count2"
    Write-Host (Get-Content -Raw -LiteralPath $registry2 -ErrorAction SilentlyContinue)
  }
  if ((Test-RegistryHasProject -RegistryPath $registry2 -ProjectPath $projA) -and (Test-RegistryHasProject -RegistryPath $registry2 -ProjectPath $projB)) {
    Ok "SCEN2: both projects' own entries are present"
  } else {
    Bad "SCEN2: at least one project's entry is missing from the registry"
    Write-Host (Get-Content -Raw -LiteralPath $registry2 -ErrorAction SilentlyContinue)
  }
  if (-not (Test-Path -LiteralPath $lock2)) {
    Ok "SCEN2: no lock directory was left behind after both installs finished"
  } else {
    Bad "SCEN2: a lock directory was left behind after both installs finished"
  }

  exit $script:fail
} finally {
  $env:USERPROFILE = $origUserProfile
  $env:HOME = $origHome
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
