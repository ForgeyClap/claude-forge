#Requires -Version 5.1
# End-to-end test (WP-P3, coordinator follow-up): every project install/uninstall records (or
# removes) this project's absolute path in $HOME\.claude\forge\projects.json, so the Command
# Center dashboard can find a project outside its default scan roots. Runs the REAL install.ps1
# (copied byte-for-byte into a minimal fake payload, never retyped) against a temp HOME and temp
# project dirs, so the real worktree/home is never touched. Covers the same five scenarios as the
# POSIX sibling projects-registry.sh -- see that file's own header comment for the full list.
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

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-projects-registry-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

$origUserProfile = $env:USERPROFILE
$origHome = $env:HOME

$script:fail = 0
function Ok  { param([string]$Msg) Write-Host "ok   $Msg" }
function Bad { param([string]$Msg) Write-Host "FAIL $Msg"; $script:fail = 1 }

# Pure PowerShell (ConvertFrom-Json), never `node -e` -- a `node -e` string containing a
# double-quoted literal is UNSAFE on Windows PowerShell (native-argument marshalling can silently
# strip the embedded quotes, e.g. `node -e 'console.log("hello world");'` reproducing the exact
# corruption -- the SAME documented risk install.ps1's own Test-ForgeStandingRulesMigration comment
# already names for this exact pattern; found again here by a real local run of this test).
function Get-RegistryProjectCount {
  param([string]$RegistryPath)
  (Get-Content -Raw -LiteralPath $RegistryPath | ConvertFrom-Json).projects.Count
}

# Same reasoning as Get-RegistryProjectCount above -- parses the real JSON instead of regex-matching
# the raw (JSON-escaped) file text, so a Windows path's backslashes never cause a false mismatch
# between the in-memory string and its `\\`-escaped on-disk form.
function Test-RegistryHasProject {
  param([string]$RegistryPath, [string]$ProjectPath)
  $projects = @((Get-Content -Raw -LiteralPath $RegistryPath | ConvertFrom-Json).projects)
  return $projects -contains $ProjectPath
}

try {
  # A minimal fake payload is enough -- see projects-registry.sh's own sibling comment for why
  # --project-only never reaches the settings-merge/standing-rules/root-seed machinery on a brand
  # new project with no settings.json shipped in this fixture at all.
  $repo = Join-Path $work 'fake-repo'
  New-Item -ItemType Directory -Force (Join-Path $repo 'global-install\.claude') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $repo '.claude') | Out-Null
  Set-Content -LiteralPath (Join-Path $repo 'global-install\.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $repo '.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $repo 'VERSION') -Value '0.0.0-test' -Encoding utf8
  Copy-Item -LiteralPath $installPs1 -Destination (Join-Path $repo 'install.ps1') -Force

  $fakeHome = Join-Path $work 'fake-home'
  New-Item -ItemType Directory -Force $fakeHome | Out-Null
  $registry = Join-Path $fakeHome '.claude\forge\projects.json'

  $proj1 = Join-Path $work 'projects\site-one'
  $proj2 = Join-Path $work 'projects\site-two'
  New-Item -ItemType Directory -Force $proj1 | Out-Null
  New-Item -ItemType Directory -Force $proj2 | Out-Null

  $env:USERPROFILE = $fakeHome
  $env:HOME = $fakeHome
  $installScript = Join-Path $repo 'install.ps1'

  # --- 1. fresh install adds the entry ---
  & powershell -ExecutionPolicy Bypass -File $installScript -ProjectOnly -ProjectDir $proj1 -Yes | Out-Null

  if (Test-Path -LiteralPath $registry -PathType Leaf) { Ok 'projects.json was created' } else { Bad "projects.json was not created: $registry" }
  if (Test-RegistryHasProject -RegistryPath $registry -ProjectPath $proj1) {
    Ok "the fresh install recorded this project's absolute path"
  } else {
    Bad "projects.json does not contain $proj1 after a fresh install"
    Write-Host (Get-Content -Raw -LiteralPath $registry)
  }
  $countAfterFirst = Get-RegistryProjectCount -RegistryPath $registry
  if ($countAfterFirst -eq '1') { Ok 'exactly one entry after the first install' } else { Bad "expected exactly 1 entry after the first install, got: $countAfterFirst" }

  # --- 2. a re-install of the SAME project adds no duplicate ---
  & powershell -ExecutionPolicy Bypass -File $installScript -ProjectOnly -ProjectDir $proj1 -Yes | Out-Null
  $countAfterReinstall = Get-RegistryProjectCount -RegistryPath $registry
  if ($countAfterReinstall -eq '1') {
    Ok 're-installing the same project added no duplicate (still 1 entry)'
  } else {
    Bad "re-installing the same project changed the entry count: $countAfterReinstall"
    Write-Host (Get-Content -Raw -LiteralPath $registry)
  }

  # --- 3. installing a SECOND project adds a second entry, keeps the first ---
  & powershell -ExecutionPolicy Bypass -File $installScript -ProjectOnly -ProjectDir $proj2 -Yes | Out-Null
  $countAfterSecond = Get-RegistryProjectCount -RegistryPath $registry
  if ($countAfterSecond -eq '2') { Ok 'a second project brings the total to 2 entries' } else { Bad "expected 2 entries after a second project, got: $countAfterSecond" }
  if ((Test-RegistryHasProject -RegistryPath $registry -ProjectPath $proj1) -and (Test-RegistryHasProject -RegistryPath $registry -ProjectPath $proj2)) {
    Ok 'both projects are recorded'
  } else {
    Bad 'one of the two projects is missing from projects.json'
    Write-Host (Get-Content -Raw -LiteralPath $registry)
  }

  # --- 4. -DryRun writes nothing ---
  $proj3 = Join-Path $work 'projects\site-three'
  New-Item -ItemType Directory -Force $proj3 | Out-Null
  $beforeHash = (Get-FileHash -LiteralPath $registry -Algorithm SHA256).Hash
  & powershell -ExecutionPolicy Bypass -File $installScript -ProjectOnly -ProjectDir $proj3 -Yes -DryRun | Out-Null
  $afterHash = (Get-FileHash -LiteralPath $registry -Algorithm SHA256).Hash
  if ($beforeHash -eq $afterHash) { Ok '-DryRun left projects.json byte-for-byte unchanged' } else { Bad '-DryRun modified projects.json' }
  if (Test-RegistryHasProject -RegistryPath $registry -ProjectPath $proj3) {
    Bad '-DryRun actually added the dry-run project to projects.json'
  } else {
    Ok '-DryRun did not add its project to projects.json'
  }

  # --- 5. a project -Uninstall removes only that project's own entry ---
  & powershell -ExecutionPolicy Bypass -File $installScript -Uninstall -ProjectOnly -ProjectDir $proj1 -Yes | Out-Null
  $countAfterUninstall = Get-RegistryProjectCount -RegistryPath $registry
  if ($countAfterUninstall -eq '1') { Ok 'uninstalling project 1 leaves exactly 1 entry' } else { Bad "expected 1 entry after uninstalling project 1, got: $countAfterUninstall" }
  if (Test-RegistryHasProject -RegistryPath $registry -ProjectPath $proj1) {
    Bad "project 1's entry survived its own -Uninstall"
  } else {
    Ok "project 1's entry was removed by its own -Uninstall"
  }
  if (Test-RegistryHasProject -RegistryPath $registry -ProjectPath $proj2) {
    Ok "project 2's entry was kept (a different project's uninstall must not touch it)"
  } else {
    Bad "project 2's entry was removed by project 1's -Uninstall (should never happen)"
  }
} finally {
  $env:USERPROFILE = $origUserProfile
  $env:HOME = $origHome
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

exit $script:fail
