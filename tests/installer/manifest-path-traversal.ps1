#Requires -Version 5.1
# WP-9B-INST regression test (Codex adversarial review, INSTALL-1 HIGH): the retirement-pruning path
# and -Uninstall must never trust a manifest-recorded path enough to hash-then-move/delete a file
# OUTSIDE the project, even when a forged manifest's recorded sha256 happens to match the real victim
# file. Runs the REAL install.ps1 (copied byte-for-byte into a minimal fake payload so its own in-place
# source detection resolves there, never retyped) against a temp HOME/project, so the real worktree is
# never touched. Covers the same four scenarios as the POSIX sibling manifest-path-traversal.sh -- see
# that file's own header comment for the full list.
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

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-manifest-traversal-test-" + [guid]::NewGuid().ToString('N'))
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
  Copy-Item -LiteralPath $installPs1 -Destination (Join-Path $Repo 'install.ps1') -Force
}

function Add-ManifestEntries {
  param([string]$ManifestPath, [hashtable[]]$Entries)
  $m = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
  $newEntries = @($Entries | ForEach-Object { [pscustomobject]@{ path = $_.path; sha256 = $_.sha256 } })
  $m.files = @($m.files) + $newEntries
  ($m | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $ManifestPath -Encoding utf8
}

try {
  # =========================================================================
  # Scenario 1 + 4: a ".."-traversal entry in the OLD manifest is ignored during the automatic
  # retirement-prune step; a genuinely retired SAFE entry in the SAME manifest is still retired.
  # =========================================================================
  $repo1 = Join-Path $work 'fake-repo-1'; $home1 = Join-Path $work 'fake-home-1'; $proj1 = Join-Path $work 'fake-proj-1'
  Build-FakeRepo -Repo $repo1
  New-Item -ItemType Directory -Force $home1 | Out-Null
  New-Item -ItemType Directory -Force $proj1 | Out-Null

  $env:USERPROFILE = $home1; $env:HOME = $home1
  powershell -ExecutionPolicy Bypass -File (Join-Path $repo1 'install.ps1') -ProjectDir $proj1 -ProjectOnly -Yes | Out-Null

  $manifest1 = Join-Path $proj1 '.claude\.forge-install-manifest.json'
  if (-not (Test-Path -LiteralPath $manifest1 -PathType Leaf)) { Bad "SCEN1: fixture assumption broken: no project manifest after a fresh install" }

  # The victim: a real file OUTSIDE the project, one level above $proj1 -- ".." (relative to the
  # project root, exactly how a real manifest entry's path is written) resolves straight to it.
  $victim1 = Join-Path $work 'victim1.txt'
  Set-Content -LiteralPath $victim1 -Value 'do not touch me' -Encoding utf8
  $victim1Hash = Get-Sha256 $victim1

  # A SAFE, legitimate "retired" entry in the SAME manifest -- proves the fix discriminates per entry.
  $legitPath = Join-Path $proj1 '.claude\legit-retired.txt'
  Set-Content -LiteralPath $legitPath -Value 'old shipped file' -Encoding utf8
  $legitHash = Get-Sha256 $legitPath

  Add-ManifestEntries -ManifestPath $manifest1 -Entries @(
    @{ path = '../victim1.txt'; sha256 = $victim1Hash },
    @{ path = '.claude/legit-retired.txt'; sha256 = $legitHash }
  )

  $out1 = powershell -ExecutionPolicy Bypass -File (Join-Path $repo1 'install.ps1') -ProjectDir $proj1 -ProjectOnly -Yes
  $status1 = $LASTEXITCODE
  $out1Text = ($out1 -join "`n")
  ($out1 -split "`n") | Where-Object { $_ -match '(?i)skipped|unsafe|retired' } | Select-Object -First 10 | ForEach-Object { Write-Host $_ }

  if ((Test-Path -LiteralPath $victim1 -PathType Leaf) -and (Get-Sha256 $victim1) -eq $victim1Hash) {
    Ok "SCEN1: the victim file outside the project was left completely untouched (not moved, not modified)"
  } else {
    Bad "SCEN1: the victim file outside the project was moved or modified -- path traversal succeeded"
  }
  if ($status1 -eq 0) {
    Ok "SCEN1: the install still succeeds despite the forged (`"..`"-traversal) manifest entry"
  } else {
    Bad "SCEN1: the install FAILED (exit $status1) because of the forged manifest entry -- it must warn and continue, never abort"
  }
  if ($out1Text -match '(?i)skipped.*victim1\.txt|does not safely resolve.*victim1\.txt|unsafe.*victim1\.txt') {
    Ok "SCEN1: a plain warning naming the unsafe manifest path was printed"
  } else {
    Bad "SCEN1: no warning was printed about the unsafe (`"..`"-traversal) manifest path"
  }
  if (Test-Path -LiteralPath $legitPath -PathType Leaf) {
    Bad "SCEN4: the legitimate retired file (a safe, real entry in the SAME manifest) was NOT retired -- rejection may be too broad"
  } else {
    Ok "SCEN4: the legitimate retired file (a safe, real entry in the SAME manifest) WAS correctly retired"
  }

  # =========================================================================
  # Scenario 2: a lexically-safe manifest path whose ancestor is a symlink/junction pointing outside
  # the project is ALSO refused -- filesystem containment, not just string shape. Junctions need no
  # elevated privilege on Windows (unlike real symlinks), so this always runs, not just best-effort.
  # =========================================================================
  $repo2 = Join-Path $work 'fake-repo-2'; $home2 = Join-Path $work 'fake-home-2'; $proj2 = Join-Path $work 'fake-proj-2'
  Build-FakeRepo -Repo $repo2
  New-Item -ItemType Directory -Force $home2 | Out-Null
  New-Item -ItemType Directory -Force $proj2 | Out-Null
  $env:USERPROFILE = $home2; $env:HOME = $home2
  powershell -ExecutionPolicy Bypass -File (Join-Path $repo2 'install.ps1') -ProjectDir $proj2 -ProjectOnly -Yes | Out-Null

  $manifest2 = Join-Path $proj2 '.claude\.forge-install-manifest.json'
  $outside2 = Join-Path $work 'outside-target-2'
  New-Item -ItemType Directory -Force $outside2 | Out-Null
  $pwned2 = Join-Path $outside2 'pwned.txt'
  Set-Content -LiteralPath $pwned2 -Value 'do not touch me either' -Encoding utf8
  $victim2Hash = Get-Sha256 $pwned2

  # A subdirectory name the real fixture never ships anything under, so ONLY the retirement-prune step
  # below ever looks at it.
  $junctionPath = Join-Path $proj2 '.claude\junctioned-dir'
  New-Item -ItemType Junction -Path $junctionPath -Target $outside2 -ErrorAction Stop | Out-Null

  Add-ManifestEntries -ManifestPath $manifest2 -Entries @(
    @{ path = '.claude/junctioned-dir/pwned.txt'; sha256 = $victim2Hash }
  )

  $out2 = powershell -ExecutionPolicy Bypass -File (Join-Path $repo2 'install.ps1') -ProjectDir $proj2 -ProjectOnly -Yes
  $status2 = $LASTEXITCODE
  ($out2 -split "`n") | Where-Object { $_ -match '(?i)skipped|unsafe|symlink|junction' } | Select-Object -First 10 | ForEach-Object { Write-Host $_ }

  if ((Test-Path -LiteralPath $pwned2 -PathType Leaf) -and (Get-Sha256 $pwned2) -eq $victim2Hash) {
    Ok "SCEN2: the victim file behind the symlinked/junctioned ancestor was left completely untouched"
  } else {
    Bad "SCEN2: the victim file behind the symlinked/junctioned ancestor was moved or modified"
  }
  if ($status2 -eq 0) {
    Ok "SCEN2: the install still succeeds despite the symlinked-ancestor manifest entry"
  } else {
    Bad "SCEN2: the install FAILED (exit $status2) because of the symlinked-ancestor manifest entry"
  }

  # =========================================================================
  # Scenario 3: the SAME forged-path attack against the CURRENT manifest via -Uninstall is refused
  # too (hardening beyond the two functions the finding named, since -Uninstall reads the identical
  # untrusted manifest file format through Remove-ForgeManifestFiles); a genuinely shipped file in the
  # SAME manifest is still correctly removed.
  # =========================================================================
  $repo3 = Join-Path $work 'fake-repo-3'; $home3 = Join-Path $work 'fake-home-3'; $proj3 = Join-Path $work 'fake-proj-3'
  Build-FakeRepo -Repo $repo3
  New-Item -ItemType Directory -Force $home3 | Out-Null
  New-Item -ItemType Directory -Force $proj3 | Out-Null
  $env:USERPROFILE = $home3; $env:HOME = $home3
  powershell -ExecutionPolicy Bypass -File (Join-Path $repo3 'install.ps1') -ProjectDir $proj3 -ProjectOnly -Yes | Out-Null

  $manifest3 = Join-Path $proj3 '.claude\.forge-install-manifest.json'
  $victim3 = Join-Path $work 'victim3.txt'
  Set-Content -LiteralPath $victim3 -Value 'do not delete me' -Encoding utf8
  $victim3Hash = Get-Sha256 $victim3

  Add-ManifestEntries -ManifestPath $manifest3 -Entries @(
    @{ path = '../victim3.txt'; sha256 = $victim3Hash }
  )

  $out3 = powershell -ExecutionPolicy Bypass -File (Join-Path $repo3 'install.ps1') -Uninstall -ProjectDir $proj3 -ProjectOnly -Yes
  $status3 = $LASTEXITCODE
  ($out3 -split "`n") | Where-Object { $_ -match '(?i)skipped|unsafe' } | Select-Object -First 5 | ForEach-Object { Write-Host $_ }

  if ((Test-Path -LiteralPath $victim3 -PathType Leaf) -and (Get-Sha256 $victim3) -eq $victim3Hash) {
    Ok "SCEN3: -Uninstall did not delete the victim file outside the project"
  } else {
    Bad "SCEN3: -Uninstall deleted or modified the victim file outside the project via a forged manifest entry"
  }
  if ($status3 -eq 0) {
    Ok "SCEN3: -Uninstall still completes successfully despite the forged manifest entry"
  } else {
    Bad "SCEN3: -Uninstall FAILED (exit $status3) because of the forged manifest entry"
  }
  $out3Text = ($out3 -join "`n")
  if ($out3Text -match '(?i)unsafe') {
    Ok "SCEN3: -Uninstall printed a plain warning about the unsafe manifest path"
  } else {
    Bad "SCEN3: -Uninstall printed no warning about the unsafe manifest path"
  }
  if (Test-Path -LiteralPath (Join-Path $proj3 '.claude\dummy.txt') -PathType Leaf) {
    Bad "SCEN3: -Uninstall did not remove a legitimate shipped file (dummy.txt) -- rejection may be too broad"
  } else {
    Ok "SCEN3: -Uninstall still correctly removed a legitimate shipped file (dummy.txt) -- rejection is not over-broad"
  }

  exit $script:fail
} finally {
  $env:USERPROFILE = $origUserProfile
  $env:HOME = $origHome
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
