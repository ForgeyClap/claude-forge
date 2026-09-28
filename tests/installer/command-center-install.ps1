#Requires -Version 5.1
# End-to-end test (WP-P3): the Command Center is installed centrally, once, at
# $HOME\.claude\forge\template\command-center\ by a -GlobalOnly (and therefore also a default,
# full) install. Runs the REAL install.ps1 (copied byte-for-byte into a minimal fake payload so its
# own in-place source detection resolves there, never retyped) against a temp HOME, so the real
# worktree is never touched. Covers the same five scenarios as the POSIX sibling
# command-center-install.sh -- see that file's own header comment for the full list.
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

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-cc-install-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

# Restored in the outer `finally` below -- this test overrides USERPROFILE/HOME for every child
# `install.ps1` invocation (so a real ~\.claude is never touched), and must not leak that override
# into the rest of this shell session.
$origUserProfile = $env:USERPROFILE
$origHome = $env:HOME

$script:fail = 0
function Ok  { param([string]$Msg) Write-Host "ok   $Msg" }
function Bad { param([string]$Msg) Write-Host "FAIL $Msg"; $script:fail = 1 }

function Build-FakeRepo {
  param([string]$Repo, [bool]$WithDist)
  New-Item -ItemType Directory -Force (Join-Path $Repo 'global-install\.claude') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $Repo '.claude') | Out-Null
  Set-Content -LiteralPath (Join-Path $Repo 'global-install\.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $Repo '.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $Repo 'VERSION') -Value '0.0.0-test' -Encoding utf8

  $cc = Join-Path $Repo 'command-center'
  foreach ($d in @(
      'gateway\src', 'gateway\node_modules\pkg',
      'discord\src', 'discord\node_modules\dep', 'discord\transcripts',
      'dashboard\node_modules\x', 'dashboard\test-results', 'dashboard\playwright-report',
      'dashboard\reports', 'dashboard\coverage',
      '.data\conversations', '.claude-flow'
    )) {
    New-Item -ItemType Directory -Force (Join-Path $cc $d) | Out-Null
  }

  Set-Content -LiteralPath (Join-Path $cc 'gateway\bin.mjs') -Value '// gateway entry point' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'gateway\package.json') -Value '{ "name": "forge-command-center-gateway" }' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'gateway\node_modules\pkg\index.js') -Value 'module.exports = {};' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'gateway\some.log') -Value 'stray dev log line' -Encoding utf8

  Set-Content -LiteralPath (Join-Path $cc 'discord\.env.example') -Value 'DISCORD_BOT_TOKEN=' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'discord\src\main.js') -Value '// discord bot entry' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'discord\package.json') -Value '{ "name": "forge-command-center-discord" }' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'discord\.env') -Value 'DISCORD_BOT_TOKEN=super-secret-fixture-value' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'discord\transcripts\call1.txt') -Value 'a fake call transcript' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'discord\node_modules\dep\index.js') -Value 'module.exports = {};' -Encoding utf8

  Set-Content -LiteralPath (Join-Path $cc 'dashboard\package.json') -Value '{ "name": "forge-command-center-dashboard" }' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'dashboard\node_modules\x\y.js') -Value 'module.exports = {};' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'dashboard\test-results\foo.xml') -Value '<results/>' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'dashboard\playwright-report\report.html') -Value '<html>report</html>' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'dashboard\reports\mutation.html') -Value '<html>mutation</html>' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'dashboard\coverage\index.html') -Value '<html>coverage</html>' -Encoding utf8
  if ($WithDist) {
    New-Item -ItemType Directory -Force (Join-Path $cc 'dashboard\dist\assets') | Out-Null
    Set-Content -LiteralPath (Join-Path $cc 'dashboard\dist\index.html') -Value '<html>dashboard</html>' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $cc 'dashboard\dist\assets\app.js') -Value 'console.log("app");' -Encoding utf8
  }

  Set-Content -LiteralPath (Join-Path $cc '.data\conversations\a.jsonl') -Value '{"conv":1}' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc '.claude-flow\state.db') -Value 'binary-ish state' -Encoding utf8

  Copy-Item -LiteralPath $installPs1 -Destination (Join-Path $Repo 'install.ps1') -Force
}

function Invoke-FakeInstall {
  param([string]$Repo, [string]$FakeHome, [string[]]$ExtraArgs = @())
  $env:USERPROFILE = $FakeHome
  $env:HOME = $FakeHome
  & powershell -ExecutionPolicy Bypass -File (Join-Path $Repo 'install.ps1') -GlobalOnly -Yes @ExtraArgs
}

try {
  # =========================================================================
  # Scenario 1-4: fresh install, runtime-data survival, uninstall, dry-run
  # =========================================================================
  $repo1 = Join-Path $work 'fake-repo-1'
  $home1 = Join-Path $work 'fake-home-1'
  Build-FakeRepo -Repo $repo1 -WithDist $true
  New-Item -ItemType Directory -Force $home1 | Out-Null

  $out = Invoke-FakeInstall -Repo $repo1 -FakeHome $home1
  ($out | Select-Object -Last 5) | ForEach-Object { Write-Host $_ }

  $ccDest = Join-Path $home1 '.claude\forge\template\command-center'

  foreach ($f in @('gateway\bin.mjs', 'gateway\package.json', 'discord\.env.example', 'discord\src\main.js',
      'discord\package.json', 'dashboard\package.json', 'dashboard\dist\index.html', 'dashboard\dist\assets\app.js')) {
    $p = Join-Path $ccDest $f
    if (Test-Path -LiteralPath $p -PathType Leaf) { Ok "shipped: $f" } else { Bad "missing after fresh install: $p" }
  }

  foreach ($f in @('gateway\node_modules\pkg\index.js', 'gateway\some.log', 'discord\.env', 'discord\transcripts\call1.txt',
      'discord\node_modules\dep\index.js', 'dashboard\node_modules\x\y.js', 'dashboard\test-results\foo.xml',
      'dashboard\playwright-report\report.html', 'dashboard\reports\mutation.html', 'dashboard\coverage\index.html',
      '.data\conversations\a.jsonl', '.claude-flow\state.db')) {
    $p = Join-Path $ccDest $f
    if (-not (Test-Path -LiteralPath $p)) { Ok "excluded: $f" } else { Bad "should NOT exist after install: $p" }
  }

  $gManifestPath = Join-Path $home1 '.claude\forge\install-manifest.json'
  if (Test-Path -LiteralPath $gManifestPath -PathType Leaf) {
    $gManifestText = Get-Content -Raw -LiteralPath $gManifestPath
    if ($gManifestText -match [regex]::Escape('command-center/gateway/bin.mjs')) { Ok 'manifest lists gateway/bin.mjs' } else { Bad 'manifest does not list gateway/bin.mjs' }
    if ($gManifestText -match [regex]::Escape('command-center/discord/.env"')) { Bad 'manifest lists the excluded discord/.env' } else { Ok 'manifest does not list discord/.env' }
    if ($gManifestText -match 'node_modules') { Bad 'manifest lists a node_modules path' } else { Ok 'manifest does not list any node_modules path' }
  } else {
    Bad "global install manifest was not written: $gManifestPath"
  }

  # --- runtime data at the destination survives a re-install ---
  New-Item -ItemType Directory -Force (Join-Path $ccDest '.data') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $ccDest 'discord') | Out-Null
  $realEnv = Join-Path $ccDest 'discord\.env'
  $realData = Join-Path $ccDest '.data\x'
  Set-Content -LiteralPath $realEnv -Value 'DISCORD_BOT_TOKEN=real-user-secret' -Encoding utf8
  Set-Content -LiteralPath $realData -Value '{"real":"conversation"}' -Encoding utf8
  $beforeEnvHash = (Get-FileHash -LiteralPath $realEnv -Algorithm SHA256).Hash
  $beforeDataHash = (Get-FileHash -LiteralPath $realData -Algorithm SHA256).Hash

  Invoke-FakeInstall -Repo $repo1 -FakeHome $home1 | Out-Null

  $afterEnvHash = (Get-FileHash -LiteralPath $realEnv -Algorithm SHA256).Hash
  $afterDataHash = (Get-FileHash -LiteralPath $realData -Algorithm SHA256).Hash
  if ($beforeEnvHash -eq $afterEnvHash) { Ok 'discord\.env survived a re-install untouched' } else { Bad 'discord\.env was modified by a re-install' }
  if ($beforeDataHash -eq $afterDataHash) { Ok '.data\x survived a re-install untouched' } else { Bad '.data\x was modified by a re-install' }

  # --- -Uninstall removes an unmodified file, keeps an edited one, never touches runtime data ---
  $mainJs = Join-Path $ccDest 'discord\src\main.js'
  Add-Content -LiteralPath $mainJs -Value "`n// discord bot entry -- MY OWN LOCAL EDIT"
  $editedBefore = (Get-FileHash -LiteralPath $mainJs -Algorithm SHA256).Hash

  $env:USERPROFILE = $home1; $env:HOME = $home1
  & powershell -ExecutionPolicy Bypass -File (Join-Path $repo1 'install.ps1') -Uninstall -GlobalOnly -Yes | Out-Null

  $binMjs = Join-Path $ccDest 'gateway\bin.mjs'
  if (-not (Test-Path -LiteralPath $binMjs -PathType Leaf)) { Ok 'unmodified gateway\bin.mjs was removed by -Uninstall' } else { Bad 'unmodified gateway\bin.mjs survived -Uninstall' }
  if (Test-Path -LiteralPath $mainJs -PathType Leaf) {
    $editedAfter = (Get-FileHash -LiteralPath $mainJs -Algorithm SHA256).Hash
    if ($editedBefore -eq $editedAfter) { Ok 'edited discord\src\main.js was kept, byte-for-byte' } else { Bad 'edited discord\src\main.js changed during -Uninstall' }
  } else {
    Bad 'edited discord\src\main.js was deleted by -Uninstall (it should have been kept)'
  }
  if (Test-Path -LiteralPath $realEnv -PathType Leaf) { Ok 'discord\.env survived -Uninstall' } else { Bad 'discord\.env was deleted by -Uninstall' }
  if (Test-Path -LiteralPath $realData -PathType Leaf) { Ok '.data\x survived -Uninstall' } else { Bad '.data\x was deleted by -Uninstall' }

  # =========================================================================
  # Scenario 4: -DryRun writes nothing at all
  # =========================================================================
  $repo2 = Join-Path $work 'fake-repo-2'
  $home2 = Join-Path $work 'fake-home-2'
  Build-FakeRepo -Repo $repo2 -WithDist $true
  New-Item -ItemType Directory -Force $home2 | Out-Null

  Invoke-FakeInstall -Repo $repo2 -FakeHome $home2 -ExtraArgs @('-DryRun') | Out-Null

  if (-not (Test-Path -LiteralPath (Join-Path $home2 '.claude'))) {
    Ok '-DryRun wrote nothing under $HOME (.claude was never created)'
  } else {
    Bad "-DryRun created $(Join-Path $home2 '.claude') -- it must write nothing"
  }

  # =========================================================================
  # Scenario 5: dashboard\dist missing from the payload -- warn once, still succeed
  # =========================================================================
  $repo3 = Join-Path $work 'fake-repo-3'
  $home3 = Join-Path $work 'fake-home-3'
  Build-FakeRepo -Repo $repo3 -WithDist $false
  New-Item -ItemType Directory -Force $home3 | Out-Null

  $out3 = Invoke-FakeInstall -Repo $repo3 -FakeHome $home3
  $status3 = $LASTEXITCODE
  $out3Text = ($out3 -join "`n")
  ($out3 | Select-String -Pattern 'dashboard' | Select-Object -First 3) | ForEach-Object { Write-Host $_ }

  if ($status3 -eq 0) { Ok 'install still succeeds when dashboard\dist is missing' } else { Bad "install failed (exit $status3) when dashboard\dist was simply missing" }
  if ($out3Text -match '(?i)dashboard.*dist.*missing') { Ok 'printed one honest NOTE that dashboard\dist is missing' } else { Bad 'did not print the missing-dashboard\dist NOTE' }
  if ($out3Text -match '(?i)run (npm|node) (run |install)|npm run build|npm install') {
    Bad 'the missing-dist message tells the user to run a build/install command (it must not)'
  } else {
    Ok 'the missing-dist message never tells the user to run a build command'
  }
  if (Test-Path -LiteralPath (Join-Path $home3 '.claude\forge\template\command-center\gateway\bin.mjs') -PathType Leaf) {
    Ok 'everything else in the Command Center still installed when dashboard\dist was missing'
  } else {
    Bad 'gateway\bin.mjs did not install even though only dashboard\dist was missing'
  }
} finally {
  $env:USERPROFILE = $origUserProfile
  $env:HOME = $origHome
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

exit $script:fail
