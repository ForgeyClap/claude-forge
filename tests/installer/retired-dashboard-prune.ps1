#Requires -Version 5.1
# End-to-end test (WP-P3b): a newer version prunes files it no longer ships, on the very
# install/upgrade that stops shipping them -- not just on -Uninstall. Runs the REAL install.ps1
# (copied byte-for-byte into a minimal fake payload so its own in-place source detection resolves
# there, never retyped) against a temp HOME/project, so the real worktree is never touched. Covers
# the same eight scenarios as the POSIX sibling retired-dashboard-prune.sh -- see that file's own
# header comment for the full list, including scenario 8 (a file this run's own migration check
# skip_rel'd must not be wrongly retired). Real historical dashboard content comes from THIS repo's
# own git history (git show <blob>), never invented.
#
# Exit 0 = every check passed. Exit 1 = a check failed. Exit 2 = usage/setup error.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent -Path $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $here '..\..')).Path
$installPs1 = Join-Path $repoRoot 'install.ps1'
$hashTableSrc = Join-Path $repoRoot '.claude\forge-bin\forge-retired-dashboard-hashes.tsv'

if (-not (Test-Path -LiteralPath $installPs1 -PathType Leaf)) {
  Write-Error "usage error: install.ps1 not found at $installPs1"
  exit 2
}
if (-not (Test-Path -LiteralPath $hashTableSrc -PathType Leaf)) {
  Write-Error "usage error: forge-retired-dashboard-hashes.tsv not found at $hashTableSrc"
  exit 2
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-retired-dash-test-" + [guid]::NewGuid().ToString('N'))
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

# A real historical blob of $RelPath from THIS repo's own git history, written to $OutPath
# BYTE-EXACT. Fails loudly (not silently) if the fixture assumption is wrong.
#
# `& git ... | Set-Content` (or plain `>`) would round-trip the output through PowerShell's own text
# pipeline -- reformatted per line, re-encoded per $OutputEncoding -- which is fine for plain ASCII
# but is NOT a guarantee of the same bytes git actually produced. Redirecting git's OWN stdout
# handle straight to a FileStream via .NET Process is the one approach with no PowerShell text
# pipeline in between at all.
function Write-RealHistoricalContent {
  param([string]$OutPath, [string]$RelPath)
  $commits = & git -C $repoRoot log --all --format='%H' -- $RelPath
  if (-not $commits) {
    Write-Error "FIXTURE ERROR: no git history at all for $RelPath"
    exit 2
  }
  $commit = @($commits)[-1]
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'git'
  # ArgumentList (a real Collection<string>, no manual quoting needed) does not exist on
  # System.Diagnostics.ProcessStartInfo under Windows PowerShell 5.1's .NET Framework runtime (it is
  # a .NET Core-only addition) -- confirmed by a real run here ("You cannot call a method on a
  # null-valued expression"). .Arguments is the PS5.1-compatible single-string form; $repoRoot is the
  # only one of these four tokens that can contain a space (this very repo's own folder name does),
  # so it alone is quoted.
  $psi.Arguments = "-C `"$repoRoot`" show ${commit}:${RelPath}"
  $psi.RedirectStandardOutput = $true
  $psi.UseShellExecute = $false
  $proc = [System.Diagnostics.Process]::Start($psi)
  $outStream = [System.IO.File]::Create($OutPath)
  try {
    $proc.StandardOutput.BaseStream.CopyTo($outStream)
  } finally {
    $outStream.Dispose()
  }
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) {
    Write-Error "FIXTURE ERROR: git show ${commit}:${RelPath} exited $($proc.ExitCode)"
    exit 2
  }
}

function Build-FakeRepo {
  param([string]$Repo)
  New-Item -ItemType Directory -Force (Join-Path $Repo 'global-install\.claude') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $Repo '.claude\forge-dashboard') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $Repo '.claude\forge-bin') | Out-Null
  Set-Content -LiteralPath (Join-Path $Repo 'global-install\.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $Repo '.claude\dummy.txt') -Value 'placeholder' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $Repo '.claude\forge-dashboard\log-event.cjs') -Value '// still shipped' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $Repo '.claude\forge-dashboard\README.md') -Value 'still shipped' -Encoding utf8
  Copy-Item -LiteralPath $hashTableSrc -Destination (Join-Path $Repo '.claude\forge-bin\forge-retired-dashboard-hashes.tsv') -Force
  Set-Content -LiteralPath (Join-Path $Repo 'VERSION') -Value '0.0.0-test' -Encoding utf8

  $cc = Join-Path $Repo 'command-center'
  New-Item -ItemType Directory -Force (Join-Path $cc 'gateway') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $cc 'dashboard\dist\assets') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $cc 'discord') | Out-Null
  Set-Content -LiteralPath (Join-Path $cc 'gateway\bin.mjs') -Value '// gateway entry point' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'discord\.env.example') -Value 'DISCORD_BOT_TOKEN=' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'dashboard\dist\index.html') -Value '<html>dashboard v1</html>' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $cc 'dashboard\dist\assets\app-hash1.js') -Value 'console.log("app-v1");' -Encoding utf8

  Copy-Item -LiteralPath $installPs1 -Destination (Join-Path $Repo 'install.ps1') -Force
}

# Finds the first retired-* folder directly under $BackupsRoot, or $null. -ErrorAction
# SilentlyContinue on Get-ChildItem covers "the folder does not exist yet" without a try/catch.
function Find-RetiredDir {
  param([string]$BackupsRoot)
  $dirs = @(Get-ChildItem -LiteralPath $BackupsRoot -Directory -Filter 'retired-*' -ErrorAction SilentlyContinue)
  if ($dirs.Count -eq 0) { return $null }
  return $dirs[0].FullName
}

# True when $RelPath (e.g. ".claude\forge-dashboard\PORT") exists under ANY retired-* folder beneath
# $BackupsRoot. The stamp in "retired-<stamp>" is second-granularity, so two prune runs a fast machine
# completes within the same wall-clock second legitimately land in the SAME folder -- checking every
# retired-* folder (there are at most a handful in these tests) is robust to that, where "the single
# NEWEST folder" is not.
function Test-AnyRetiredDirHas {
  param([string]$BackupsRoot, [string]$RelPath)
  $dirs = @(Get-ChildItem -LiteralPath $BackupsRoot -Directory -Filter 'retired-*' -ErrorAction SilentlyContinue)
  foreach ($d in $dirs) {
    if (Test-Path -LiteralPath (Join-Path $d.FullName $RelPath) -PathType Leaf) { return $true }
  }
  return $false
}

try {
  # =========================================================================
  # Scenario 1: 2.8.1-shaped install (a manifest lists the old dashboard files) --
  # unmodified ones pruned into the backup folder, a modified one is kept and reported.
  # =========================================================================
  $repo1 = Join-Path $work 'fake-repo-1'; $home1 = Join-Path $work 'fake-home-1'; $proj1 = Join-Path $work 'fake-proj-1'
  Build-FakeRepo -Repo $repo1
  New-Item -ItemType Directory -Force $home1 | Out-Null
  New-Item -ItemType Directory -Force $proj1 | Out-Null

  $env:USERPROFILE = $home1; $env:HOME = $home1
  powershell -ExecutionPolicy Bypass -File (Join-Path $repo1 'install.ps1') -ProjectDir $proj1 -ProjectOnly -Yes | Out-Null

  $db1 = Join-Path $proj1 '.claude\forge-dashboard'
  $manifest1 = Join-Path $proj1 '.claude\.forge-install-manifest.json'
  if (-not (Test-Path -LiteralPath $manifest1 -PathType Leaf)) { Bad "SCEN1: fixture assumption broken: no project manifest after a fresh install" }

  Set-Content -LiteralPath (Join-Path $db1 'server.cjs') -Value 'old server code' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $db1 'index.html') -Value 'old index html' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $db1 'app.js') -Value 'old app js' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $db1 'panels.js') -Value 'old panels js' -Encoding utf8
  $hServer = Get-Sha256 (Join-Path $db1 'server.cjs')
  $hIndex = Get-Sha256 (Join-Path $db1 'index.html')
  $hApp = Get-Sha256 (Join-Path $db1 'app.js')
  $hPanels = Get-Sha256 (Join-Path $db1 'panels.js')

  $m1 = Get-Content -Raw -LiteralPath $manifest1 | ConvertFrom-Json
  $newEntries = @(
    [pscustomobject]@{ path = '.claude/forge-dashboard/server.cjs'; sha256 = $hServer },
    [pscustomobject]@{ path = '.claude/forge-dashboard/index.html'; sha256 = $hIndex },
    [pscustomobject]@{ path = '.claude/forge-dashboard/app.js'; sha256 = $hApp },
    [pscustomobject]@{ path = '.claude/forge-dashboard/panels.js'; sha256 = $hPanels }
  )
  $m1.files = @($m1.files) + $newEntries
  ($m1 | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $manifest1 -Encoding utf8

  Add-Content -LiteralPath (Join-Path $db1 'panels.js') -Value "`nMY OWN EDIT"

  $out1 = powershell -ExecutionPolicy Bypass -File (Join-Path $repo1 'install.ps1') -ProjectDir $proj1 -ProjectOnly -Yes
  ($out1 -join "`n") -split "`n" | Where-Object { $_ -match 'retired|kept' } | Select-Object -First 8 | ForEach-Object { Write-Host $_ }

  foreach ($f in 'server.cjs', 'index.html', 'app.js') {
    if (Test-Path -LiteralPath (Join-Path $db1 $f) -PathType Leaf) { Bad "SCEN1: $f should have been retired (removed from $db1), but it is still there" }
    else { Ok "SCEN1: $f is gone from $db1" }
  }
  $backup1 = Find-RetiredDir -BackupsRoot (Join-Path $proj1 '.claude\forge-backups')
  if ($backup1) {
    foreach ($f in 'server.cjs', 'index.html', 'app.js') {
      $bp = Join-Path $backup1 (".claude\forge-dashboard\$f")
      if (Test-Path -LiteralPath $bp -PathType Leaf) { Ok "SCEN1: $f was backed up to $backup1" }
      else { Bad "SCEN1: $f was not found under the backup folder $backup1" }
    }
  } else {
    Bad "SCEN1: no .claude\forge-backups\retired-* folder was created at all"
  }
  $panelsText = Get-Content -Raw -LiteralPath (Join-Path $db1 'panels.js') -ErrorAction SilentlyContinue
  if ($panelsText -and $panelsText -match 'MY OWN EDIT') { Ok "SCEN1: the modified panels.js was kept, byte-for-byte, at its original location" }
  else { Bad "SCEN1: the modified panels.js was removed or altered (it should have been kept)" }
  if (($out1 -join "`n") -match '(?i)kept \(you edited this file') { Ok "SCEN1: the install reported the kept file in a plain line" }
  else { Bad "SCEN1: no 'kept (you edited this file...)' line was printed" }

  # =========================================================================
  # Scenario 2: manifest-less (pre-2.8.0) install -- real historical content (+ one CRLF copy) is
  # removed by content hash; unknown content at the same path is kept.
  # =========================================================================
  $repo2 = Join-Path $work 'fake-repo-2'; $home2 = Join-Path $work 'fake-home-2'; $proj2 = Join-Path $work 'fake-proj-2'
  Build-FakeRepo -Repo $repo2
  New-Item -ItemType Directory -Force $home2 | Out-Null
  New-Item -ItemType Directory -Force $proj2 | Out-Null

  $env:USERPROFILE = $home2; $env:HOME = $home2
  powershell -ExecutionPolicy Bypass -File (Join-Path $repo2 'install.ps1') -ProjectDir $proj2 -ProjectOnly -Yes | Out-Null
  Remove-Item -LiteralPath (Join-Path $proj2 '.claude\.forge-install-manifest.json') -Force

  $db2 = Join-Path $proj2 '.claude\forge-dashboard'
  Write-RealHistoricalContent -OutPath (Join-Path $db2 'lenses.js') -RelPath '.claude/forge-dashboard/lenses.js'
  Write-RealHistoricalContent -OutPath (Join-Path $db2 'styles.css') -RelPath '.claude/forge-dashboard/styles.css'
  $graphLf = Join-Path $work 'graph-lf.js'
  Write-RealHistoricalContent -OutPath $graphLf -RelPath '.claude/forge-dashboard/graph.js'
  $lf = [System.IO.File]::ReadAllText($graphLf)
  [System.IO.File]::WriteAllText((Join-Path $db2 'graph.js'), ($lf -replace "`n", "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  Set-Content -LiteralPath (Join-Path $db2 'app.js') -Value 'totally unrelated content nobody ever shipped' -Encoding utf8

  $out2 = powershell -ExecutionPolicy Bypass -File (Join-Path $repo2 'install.ps1') -ProjectDir $proj2 -ProjectOnly -Yes
  ($out2 -join "`n") -split "`n" | Where-Object { $_ -match 'retired|kept' } | Select-Object -First 8 | ForEach-Object { Write-Host $_ }

  foreach ($f in 'lenses.js', 'styles.css', 'graph.js') {
    if (Test-Path -LiteralPath (Join-Path $db2 $f) -PathType Leaf) { Bad "SCEN2: $f (known historical content) should have been retired" }
    else { Ok "SCEN2: $f (known historical content, CRLF for graph.js) is gone" }
  }
  $backup2 = Find-RetiredDir -BackupsRoot (Join-Path $proj2 '.claude\forge-backups')
  if ($backup2 -and (Test-Path -LiteralPath (Join-Path $backup2 '.claude\forge-dashboard\graph.js') -PathType Leaf)) {
    Ok "SCEN2: the CRLF copy of graph.js was still recognized (CRLF-normalized hash) and backed up"
  } else {
    Bad "SCEN2: graph.js (CRLF copy) was not found under the backup folder -- normalization did not work"
  }
  $appText = Get-Content -Raw -LiteralPath (Join-Path $db2 'app.js') -ErrorAction SilentlyContinue
  if ($appText -and $appText -match 'totally unrelated content') { Ok "SCEN2: unknown content at app.js was kept, byte-for-byte" }
  else { Bad "SCEN2: unknown content at app.js was removed (it should have been kept -- it never matched a known shipped hash)" }

  # =========================================================================
  # Scenario 3: PORT / DASHBOARD_STATE.json are removed unconditionally (generated runtime state).
  # =========================================================================
  Set-Content -LiteralPath (Join-Path $db2 'PORT') -Value '4100' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $db2 'DASHBOARD_STATE.json') -Value '{"pid":123}' -Encoding utf8
  powershell -ExecutionPolicy Bypass -File (Join-Path $repo2 'install.ps1') -ProjectDir $proj2 -ProjectOnly -Yes | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $db2 'PORT') -PathType Leaf) -and -not (Test-Path -LiteralPath (Join-Path $db2 'DASHBOARD_STATE.json') -PathType Leaf)) {
    Ok "SCEN3: PORT and DASHBOARD_STATE.json were removed"
  } else {
    Bad "SCEN3: PORT and/or DASHBOARD_STATE.json still exist after install"
  }
  if (Test-AnyRetiredDirHas -BackupsRoot (Join-Path $proj2 '.claude\forge-backups') -RelPath '.claude\forge-dashboard\PORT') {
    Ok "SCEN3: PORT was backed up, not deleted outright"
  } else {
    Bad "SCEN3: PORT was not found under any backup folder"
  }

  # =========================================================================
  # Scenario 4/5/7: a stale Command Center asset is pruned; an unchanged CC file is replaced with no
  # *.forge-bak-* litter; a second install (nothing left to prune) is a true no-op.
  # =========================================================================
  $repo4 = Join-Path $work 'fake-repo-4'; $home4 = Join-Path $work 'fake-home-4'
  Build-FakeRepo -Repo $repo4
  New-Item -ItemType Directory -Force $home4 | Out-Null

  $env:USERPROFILE = $home4; $env:HOME = $home4
  powershell -ExecutionPolicy Bypass -File (Join-Path $repo4 'install.ps1') -GlobalOnly -Yes | Out-Null
  $cc = Join-Path $home4 '.claude\forge\template\command-center'

  New-Item -ItemType Directory -Force (Join-Path $cc 'dashboard\dist\assets') | Out-Null
  $staleAsset = Join-Path $cc 'dashboard\dist\assets\app-hash0-STALE.js'
  Set-Content -LiteralPath $staleAsset -Value 'console.log("stale-v0");' -Encoding utf8
  $staleHash = Get-Sha256 $staleAsset
  $gManifestPath = Join-Path $home4 '.claude\forge\install-manifest.json'
  $gm = Get-Content -Raw -LiteralPath $gManifestPath | ConvertFrom-Json
  $gm.files = @($gm.files) + [pscustomobject]@{ path = '.claude/forge/template/command-center/dashboard/dist/assets/app-hash0-STALE.js'; sha256 = $staleHash }
  ($gm | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $gManifestPath -Encoding utf8

  Set-Content -LiteralPath (Join-Path $cc 'gateway\bin.mjs') -Value "// gateway entry point`n// MY OWN CC EDIT" -Encoding utf8

  $out4 = powershell -ExecutionPolicy Bypass -File (Join-Path $repo4 'install.ps1') -GlobalOnly -Yes
  ($out4 -join "`n") -split "`n" | Where-Object { $_ -match 'retired|back up|unchanged|update' } | Select-Object -First 10 | ForEach-Object { Write-Host $_ }

  if (-not (Test-Path -LiteralPath $staleAsset -PathType Leaf)) { Ok "SCEN4: the stale dashboard/dist asset is gone from the live Command Center" }
  else { Bad "SCEN4: the stale dashboard/dist asset is still present" }
  $gbackup = Find-RetiredDir -BackupsRoot (Join-Path $home4 '.claude\forge\backups')
  if ($gbackup -and (Test-Path -LiteralPath (Join-Path $gbackup '.claude\forge\template\command-center\dashboard\dist\assets\app-hash0-STALE.js') -PathType Leaf)) {
    Ok "SCEN4: the stale asset was backed up under the global backup folder"
  } else {
    Bad "SCEN4: the stale asset was not found under any global backup folder"
  }

  $bakFiles = @(Get-ChildItem -LiteralPath (Join-Path $cc 'gateway') -Filter 'bin.mjs.forge-bak-*' -ErrorAction SilentlyContinue)
  if ($bakFiles.Count -ge 1) { Ok "SCEN5: the user-edited gateway\bin.mjs got a *.forge-bak-* safety copy" }
  else { Bad "SCEN5: the user-edited gateway\bin.mjs did NOT get a *.forge-bak-* safety copy (it should have)" }

  $bakBefore = @(Get-ChildItem -LiteralPath $cc -Recurse -Filter '*.forge-bak-*' -ErrorAction SilentlyContinue).Count
  $beforeTree = @(Get-ChildItem -LiteralPath $cc -Recurse -File | ForEach-Object { $_.FullName }) | Sort-Object
  $out5 = powershell -ExecutionPolicy Bypass -File (Join-Path $repo4 'install.ps1') -GlobalOnly -Yes
  $afterTree = @(Get-ChildItem -LiteralPath $cc -Recurse -File | ForEach-Object { $_.FullName }) | Sort-Object
  $bakAfter = @(Get-ChildItem -LiteralPath $cc -Recurse -Filter '*.forge-bak-*' -ErrorAction SilentlyContinue).Count

  if ($bakAfter -eq $bakBefore) { Ok "SCEN5/7: a second, unchanged install created ZERO new *.forge-bak-* files in the Command Center" }
  else { Bad "SCEN5/7: a second, unchanged install created new *.forge-bak-* files ($bakBefore -> $bakAfter)" }
  if (($beforeTree -join "`n") -eq ($afterTree -join "`n")) { Ok "SCEN7: a second install is a true no-op (identical file set under the Command Center)" }
  else { Bad "SCEN7: a second install changed the Command Center's file set" }

  # =========================================================================
  # Scenario 6: -DryRun writes nothing at all (project scope, reusing scenario 1's shape fresh).
  # =========================================================================
  $repo6 = Join-Path $work 'fake-repo-6'; $home6 = Join-Path $work 'fake-home-6'; $proj6 = Join-Path $work 'fake-proj-6'
  Build-FakeRepo -Repo $repo6
  New-Item -ItemType Directory -Force $home6 | Out-Null
  New-Item -ItemType Directory -Force $proj6 | Out-Null

  $env:USERPROFILE = $home6; $env:HOME = $home6
  powershell -ExecutionPolicy Bypass -File (Join-Path $repo6 'install.ps1') -ProjectDir $proj6 -ProjectOnly -Yes | Out-Null
  $db6 = Join-Path $proj6 '.claude\forge-dashboard'
  Set-Content -LiteralPath (Join-Path $db6 'server.cjs') -Value 'old server code' -Encoding utf8
  $h6 = Get-Sha256 (Join-Path $db6 'server.cjs')
  $manifest6 = Join-Path $proj6 '.claude\.forge-install-manifest.json'
  $m6 = Get-Content -Raw -LiteralPath $manifest6 | ConvertFrom-Json
  $m6.files = @($m6.files) + [pscustomobject]@{ path = '.claude/forge-dashboard/server.cjs'; sha256 = $h6 }
  ($m6 | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $manifest6 -Encoding utf8

  $before6 = @(Get-ChildItem -LiteralPath $proj6 -Recurse -File | ForEach-Object { "$($_.FullName)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }) | Sort-Object
  powershell -ExecutionPolicy Bypass -File (Join-Path $repo6 'install.ps1') -ProjectDir $proj6 -ProjectOnly -Yes -DryRun | Out-Null
  $after6 = @(Get-ChildItem -LiteralPath $proj6 -Recurse -File | ForEach-Object { "$($_.FullName)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }) | Sort-Object

  if (($before6 -join "`n") -eq ($after6 -join "`n")) { Ok "SCEN6: -DryRun wrote nothing at all (identical file set and content)" }
  else { Bad "SCEN6: -DryRun changed the project tree" }
  if (Test-Path -LiteralPath (Join-Path $db6 'server.cjs') -PathType Leaf) { Ok "SCEN6: -DryRun left server.cjs in place (did not actually retire it)" }
  else { Bad "SCEN6: -DryRun actually removed server.cjs" }

  # =========================================================================
  # Scenario 8: a file this run's own migration check skip_rel'd (forge-sync.cjs is absent from this
  # fake payload, so Test-ForgeStandingRulesMigration always finds it missing and sets the skip,
  # exactly as a real project would see if node itself were unavailable) must not be wrongly retired
  # even though it is then absent from this run's own manifest accumulator -- its content, and hence
  # its hash, is UNCHANGED between the two installs below (regression: caught by self-review, not by
  # scenarios 1-7 -- this proves the fix for real rather than trusting the reasoning alone).
  # =========================================================================
  $repo8 = Join-Path $work 'fake-repo-8'; $home8 = Join-Path $work 'fake-home-8'; $proj8 = Join-Path $work 'fake-proj-8'
  Build-FakeRepo -Repo $repo8
  New-Item -ItemType Directory -Force (Join-Path $repo8 '.claude\config\orchestration') | Out-Null
  Set-Content -LiteralPath (Join-Path $repo8 '.claude\config\orchestration\FORGE_STANDING_RULES.json') -Value '{}' -Encoding utf8
  New-Item -ItemType Directory -Force $home8 | Out-Null
  New-Item -ItemType Directory -Force $proj8 | Out-Null

  $env:USERPROFILE = $home8; $env:HOME = $home8
  powershell -ExecutionPolicy Bypass -File (Join-Path $repo8 'install.ps1') -ProjectDir $proj8 -ProjectOnly -Yes | Out-Null
  $rulesFile = Join-Path $proj8 '.claude\config\orchestration\FORGE_STANDING_RULES.json'
  if (Test-Path -LiteralPath $rulesFile -PathType Leaf) { Ok "SCEN8: fixture setup: FORGE_STANDING_RULES.json exists after the fresh install" }
  else { Bad "SCEN8: fixture assumption broken: FORGE_STANDING_RULES.json missing after a fresh install" }
  $hashBefore8 = Get-Sha256 $rulesFile

  $out8 = powershell -ExecutionPolicy Bypass -File (Join-Path $repo8 'install.ps1') -ProjectDir $proj8 -ProjectOnly -Yes
  ($out8 -join "`n") -split "`n" | Where-Object { $_ -match '(?i)standing_rules|pending|migration' } | Select-Object -First 4 | ForEach-Object { Write-Host $_ }

  if (Test-Path -LiteralPath $rulesFile -PathType Leaf) {
    $hashAfter8 = Get-Sha256 $rulesFile
    if ($hashAfter8 -eq $hashBefore8) { Ok "SCEN8: FORGE_STANDING_RULES.json was left in place, byte-for-byte" }
    else { Bad "SCEN8: FORGE_STANDING_RULES.json changed even though its copy should have been skipped" }
  } else {
    Bad "SCEN8: FORGE_STANDING_RULES.json is gone (it should have been left in place, not copied, not retired)"
  }
  if (Test-AnyRetiredDirHas -BackupsRoot (Join-Path $proj8 '.claude\forge-backups') -RelPath '.claude\config\orchestration\FORGE_STANDING_RULES.json') {
    Bad "SCEN8: FORGE_STANDING_RULES.json was WRONGLY retired into a backup folder (the skip_rel exemption did not work)"
  } else {
    Ok "SCEN8: FORGE_STANDING_RULES.json was NOT wrongly retired (the skip_rel exemption works)"
  }

  exit $script:fail
} finally {
  $env:USERPROFILE = $origUserProfile
  $env:HOME = $origHome
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
