#Requires -Version 5.1
<#
.SYNOPSIS
  claude-forge installer (PowerShell)

.DESCRIPTION
  Installs the Forge V2 multi-agent system for Claude Code:
    - global-install\.claude\*  -> $HOME\.claude       (forge-core skill, /forge, /setup-forge)
    - .claude\*                 -> <project>\.claude    (skills, agents, dashboard, config)

  Safe to re-run: file-by-file, merge-safe copy. Never wipes or replaces the
  whole .claude tree. Existing files that differ are backed up with a
  timestamp suffix before being overwritten. Identical files are a no-op.

.PARAMETER ProjectDir
  Target project directory. Defaults to the current directory.

.PARAMETER Yes
  Non-interactive: assume "yes" to the confirmation prompt (CI). Same as
  setting $env:FORGE_YES = '1'.

.PARAMETER DryRun
  Show what would be written, change nothing.

.PARAMETER GlobalOnly
  Only install the global core into $HOME\.claude.

.PARAMETER ProjectOnly
  Only install the per-project payload into <ProjectDir>\.claude.

.EXAMPLE
  .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/ForgeyClap/claude-forge/main/install.ps1 | iex"
  # The -ExecutionPolicy Bypass wrapper is required for irm|iex on a Restricted policy.
#>
[CmdletBinding()]
param(
  [string]$ProjectDir,
  [Alias('y')]
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$GlobalOnly,
  [switch]$ProjectOnly
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

# TLS 1.2 is required for GitHub downloads on older Windows/.NET defaults.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  Write-Warning "Could not force TLS 1.2 explicitly; continuing with system default."
}

$RepoOwner = 'ForgeyClap'
$RepoName  = 'claude-forge'

function Write-ForgeLog {
  param([string]$Message)
  Write-Host $Message
}

function Write-ForgeError {
  param([string]$Message)
  Write-Host "ERROR: $Message" -ForegroundColor Red
}

# Normalizes an absolute path without requiring the directory to exist yet (GetFullPath resolves
# relative to the current directory and normalizes '..'/'.' segments and trailing slashes). Used only
# by the HOME-target guard below.
function Resolve-ForgeFullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

# Copy $SourceFile to $DestFile in a merge-safe way.
# - If dest does not exist: create parent dir, copy.
# - If dest exists and is identical (hash match): no-op.
# - If dest exists and differs: rename dest to dest.forge-bak-<timestamp>, then copy.
function Copy-ForgeFile {
  param(
    [Parameter(Mandatory = $true)][string]$SourceFile,
    [Parameter(Mandatory = $true)][string]$DestFile,
    [Parameter(Mandatory = $true)][bool]$IsDryRun
  )

  $destDir = Split-Path -Parent -Path $DestFile

  if ($IsDryRun) {
    if (Test-Path -LiteralPath $DestFile -PathType Leaf) {
      $srcHash = (Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash
      $dstHash = (Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash
      if ($srcHash -eq $dstHash) {
        Write-ForgeLog "  [dry-run] unchanged: $DestFile"
      } else {
        Write-ForgeLog "  [dry-run] would back up + overwrite: $DestFile"
      }
    } else {
      Write-ForgeLog "  [dry-run] would create: $DestFile"
    }
    return
  }

  if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }

  if (Test-Path -LiteralPath $DestFile -PathType Leaf) {
    $srcHash = (Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash
    if ($srcHash -eq $dstHash) {
      # identical, no-op
      return
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bakFile = "$DestFile.forge-bak-$stamp"
    Move-Item -LiteralPath $DestFile -Destination $bakFile -Force
    Write-ForgeLog "  backed up: $DestFile -> $bakFile"
  }

  Copy-Item -LiteralPath $SourceFile -Destination $DestFile -Force
  Write-ForgeLog "  wrote: $DestFile"
}

# Merge handling for <project>\.claude\settings.json (security #4, review #10; MERGED instead of
# "kept, merge by hand" since wp22 / owner directive 2026-09-24 "alles standaard aan" -- Forge does the
# merge itself). A user's own settings.json carries their own permissions/hooks and must never be silently
# backed-up-and-REPLACED like an ordinary payload file -- but leaving it completely untouched next to a
# settings.forge-recommended.json (the pre-wp22 behaviour) meant the owner's new default hooks (the gate
# hook, the deny rules) never reached an existing project either. Real merge, via the dedicated
# forge-settings-merge.cjs tool (foreign hooks/rules/keys kept byte-for-byte, backed up first): only when
# `node` is on PATH. Without `node`, this falls back to the OLD recommended-file behaviour and says why --
# never silently drops the merge.
function Copy-ForgeSettingsFile {
  param(
    [Parameter(Mandatory = $true)][string]$SourceFile,
    [Parameter(Mandatory = $true)][string]$DestFile,
    [Parameter(Mandatory = $true)][bool]$IsDryRun,
    # MergeToolPath is passed explicitly rather than read from an ambient $sourceDir/$SourceDir variable:
    # PowerShell variable names are CASE-INSENSITIVE, and this function is invoked from inside
    # Copy-ForgeTree, which has its OWN `[string]$SourceDir` parameter (already the .claude subdir, not
    # the top-level source root). Reading an unqualified `$sourceDir` here silently resolved to THAT
    # parameter instead of the script-level variable of the same name, producing a doubled
    # `...\.claude\.claude\forge-bin\...` path and a false "node not found" fallback (caught by a real
    # end-to-end run during wp22, not by inspection alone).
    [string]$MergeToolPath = $null
  )

  $destDir = Split-Path -Parent -Path $DestFile
  $recommendedFile = Join-Path $destDir 'settings.forge-recommended.json'
  $mergeTool = $MergeToolPath
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $haveMergeTool = $nodeCmd -and $mergeTool -and (Test-Path -LiteralPath $mergeTool -PathType Leaf)

  if ($IsDryRun) {
    if (Test-Path -LiteralPath $DestFile -PathType Leaf) {
      $srcHash = (Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash
      $dstHash = (Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash
      if ($srcHash -eq $dstHash) {
        Write-ForgeLog "  [dry-run] unchanged: $DestFile"
      } elseif ($haveMergeTool) {
        # $ErrorActionPreference is 'Stop' script-wide; a native tool's stderr line captured via 2>&1 can be
        # wrapped as a terminating ErrorRecord under that setting, so it is relaxed for this one call only.
        $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        try { $mergeOut = & node $mergeTool apply --target $DestFile --source $SourceFile --dry-run 2>&1 }
        finally { $ErrorActionPreference = $prevEap }
        Write-ForgeLog "  [dry-run] $mergeOut"
      } else {
        Write-ForgeLog "  [dry-run] node not found -- would keep your settings.json unmerged; would write: $recommendedFile"
      }
    } else {
      Write-ForgeLog "  [dry-run] would create: $DestFile"
    }
    return
  }

  if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }

  if (Test-Path -LiteralPath $DestFile -PathType Leaf) {
    $srcHash = (Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash
    if ($srcHash -eq $dstHash) {
      # identical, no-op
      return
    }
    if ($haveMergeTool) {
      $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      try { $mergeOut = & node $mergeTool apply --target $DestFile --source $SourceFile 2>&1 }
      finally { $ErrorActionPreference = $prevEap }
      if ($LASTEXITCODE -eq 0) {
        Write-ForgeLog "  $mergeOut"
        return
      }
      Write-ForgeLog "  settings.json merge refused ($mergeOut) -- falling back to settings.forge-recommended.json"
    } else {
      Write-ForgeLog "  node not found on PATH -- cannot merge settings.json automatically; writing $recommendedFile instead"
    }
    Copy-Item -LiteralPath $SourceFile -Destination $recommendedFile -Force
    Write-ForgeLog "  kept your settings.json; Forge's hooks are in $recommendedFile -- merge what you want"
    return
  }

  Copy-Item -LiteralPath $SourceFile -Destination $DestFile -Force
  Write-ForgeLog "  wrote: $DestFile"
}

# Recursively merge-copy every file under $SourceDir into $DestDir.
# -ProtectSettings routes <dir>\settings.json through Copy-ForgeSettingsFile instead of the generic
# backup-then-overwrite path (used for the project payload only — see Copy-ForgeSettingsFile).
function Copy-ForgeTree {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$DestDir,
    [Parameter(Mandatory = $true)][bool]$IsDryRun,
    [bool]$ProtectSettings = $false,
    # Passed straight through to Copy-ForgeSettingsFile — see that function's own param comment for why this
    # must be an explicit parameter rather than an ambient `$sourceDir`/`$SourceDir` variable lookup.
    [string]$MergeToolPath = $null
  )

  if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    Write-ForgeError "source directory missing: $SourceDir"
    return $false
  }

  $files = Get-ChildItem -LiteralPath $SourceDir -Recurse -File -Force
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($SourceDir.Length).TrimStart('\', '/')
    $dest = Join-Path -Path $DestDir -ChildPath $rel
    if ($ProtectSettings -and $rel -eq 'settings.json') {
      Copy-ForgeSettingsFile -SourceFile $file.FullName -DestFile $dest -IsDryRun $IsDryRun -MergeToolPath $MergeToolPath
    } else {
      Copy-ForgeFile -SourceFile $file.FullName -DestFile $dest -IsDryRun $IsDryRun
    }
  }

  return $true
}

# Seed the project-root files Forge needs but the .claude payload does not carry:
#   CLAUDE.md   -- created ONLY when absent (an existing file is never touched)
#   .gitignore  -- missing Forge lines appended; existing lines left alone
# Idempotent: a second run reports "kept" and changes nothing.
function Add-ForgeProjectRootSeed {
  param(
    [Parameter(Mandatory = $true)][string] $ProjectDir,
    [Parameter(Mandatory = $true)][string] $SourceDir,
    [bool] $IsDryRun = $false
  )

  $claudeMd = Join-Path $ProjectDir 'CLAUDE.md'
  $claudeTemplate = Join-Path $SourceDir 'templates\project-CLAUDE.md'
  if (Test-Path -LiteralPath $claudeMd -PathType Leaf) {
    Write-ForgeLog "  kept:  $claudeMd (already exists -- not touched)"
  } elseif (Test-Path -LiteralPath $claudeTemplate -PathType Leaf) {
    if ($IsDryRun) {
      Write-ForgeLog "  would write: $claudeMd"
    } else {
      Copy-Item -LiteralPath $claudeTemplate -Destination $claudeMd -Force
      Write-ForgeLog "  wrote: $claudeMd (project brain -- edit it, it is yours)"
    }
  }

  $snippet = Join-Path $SourceDir 'templates\gitignore.snippet'
  if (-not (Test-Path -LiteralPath $snippet -PathType Leaf)) { return }
  $gitignore = Join-Path $ProjectDir '.gitignore'

  $existing = @()
  if (Test-Path -LiteralPath $gitignore -PathType Leaf) {
    $existing = @(Get-Content -LiteralPath $gitignore -ErrorAction SilentlyContinue)
  }
  $existingSet = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($line in $existing) { [void] $existingSet.Add($line.Trim()) }

  $toAdd = New-Object 'System.Collections.Generic.List[string]'
  foreach ($line in (Get-Content -LiteralPath $snippet)) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    if ($existingSet.Contains($trimmed)) { continue }
    $toAdd.Add($trimmed)
    [void] $existingSet.Add($trimmed)
  }

  if ($toAdd.Count -eq 0) {
    Write-ForgeLog "  kept:  $gitignore (all Forge lines already present)"
    return
  }
  if ($IsDryRun) {
    Write-ForgeLog "  would add: $($toAdd.Count) line(s) to $gitignore"
    return
  }

  $block = New-Object 'System.Collections.Generic.List[string]'
  if ($existing.Count -gt 0) { $block.Add('') }
  $block.Add('# --- Forge (added by the claude-forge installer) ---')
  foreach ($line in $toAdd) { $block.Add($line) }
  Add-Content -LiteralPath $gitignore -Value $block -Encoding utf8
  Write-ForgeLog "  wrote: $gitignore (+$($toAdd.Count) Forge line(s); your existing rules kept)"
}

# Writes .claude\FORGE_VERSION.json -- per-install state (gitignored by the snippet), read by
# `forge-sync status` to report the installed release next to the canonical template's hash.
function Write-ForgeVersionMarker {
  param(
    [Parameter(Mandatory = $true)][string] $ProjectDir,
    [Parameter(Mandatory = $true)][string] $Version,
    [bool] $IsDryRun = $false
  )
  $markerPath = Join-Path $ProjectDir '.claude\FORGE_VERSION.json'
  if ($IsDryRun) {
    Write-ForgeLog "  would write: $markerPath (forge_version $Version)"
    return
  }
  $homeDir = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
  $marker = [ordered]@{
    forge_version = $Version
    synced_at     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    template      = (Join-Path $homeDir '.claude\forge\template\.claude')
    installed_by  = 'install.ps1'
    _doc          = 'forge_version is the release this installer wrote; forge-sync status prints it as installed= and detects drift by file hash against the canonical template.'
  }
  try {
    $json = ($marker | ConvertTo-Json -Depth 3)
    [System.IO.File]::WriteAllText($markerPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-ForgeLog "  wrote: $markerPath (forge_version $Version)"
  } catch {
    Write-ForgeError "could not write $markerPath (forge-sync status will report installed=none): $($_.Exception.Message)"
  }
}

function Main {
  $projectDir = if ($ProjectDir) { $ProjectDir } else { (Get-Location).Path }
  # ONE home for every global path: the USERPROFILE/HOME environment (what Node's os.homedir() uses, so the
  # installer and the tools agree). PowerShell's automatic $HOME may follow HOMEDRIVE/HOMEPATH instead of an
  # overridden USERPROFILE, which is exactly the situation in a CI job that redirects the home.
  $forgeHome = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { $HOME }
  $assumeYes  = [bool]$Yes -or ($env:FORGE_YES -eq '1')
  $isDryRun   = [bool]$DryRun
  $globalOnly = [bool]$GlobalOnly
  $projectOnly = [bool]$ProjectOnly
  $forgeRef   = if ($env:FORGE_REF) { $env:FORGE_REF } else { 'main' }

  if ($globalOnly -and $projectOnly) {
    Write-ForgeError '-GlobalOnly and -ProjectOnly are mutually exclusive'
    exit 1
  }

  $doGlobal = -not $projectOnly
  $doProject = -not $globalOnly

  # ---------------------------------------------------------------------------
  # 0. refuse a HOME target (review HIGH #3): a one-liner run from %USERPROFILE%
  #    (e.g. the Windows install prompt) must never treat $HOME itself as the
  #    "project" -- that would write the PROJECT payload into ~\.claude and
  #    REPLACE the user's global settings.json. Checked before any download or
  #    write, including in -DryRun, and for -ProjectDir pointing at $HOME too.
  # ---------------------------------------------------------------------------
  if ($doProject) {
    # The home to compare against is the one the REST of this installer (and Node's os.homedir()) uses: the
    # USERPROFILE/HOME environment. PowerShell's automatic $HOME comes from HOMEDRIVE/HOMEPATH and does not
    # follow an overridden USERPROFILE — measured on the GitHub windows runner, where the guard compared against
    # the runner's real profile and therefore let -ProjectDir <empty home> through.
    $guardHome = $forgeHome
    $resolvedProject = Resolve-ForgeFullPath $projectDir
    $resolvedHome = Resolve-ForgeFullPath $guardHome
    if ($resolvedProject -ieq $resolvedHome) {
      Write-ForgeError "the target project directory is your home directory ($guardHome) -- refusing to install the project payload into `$HOME\.claude (that would replace your global settings.json). cd into your project folder, or pass -ProjectDir <dir>."
      exit 1
    }

    # Same refusal when <project>\.claude would resolve to the same directory as the global ~\.claude
    # (e.g. a symlinked project dir) even though the project dir itself is not $HOME.
    $projectClaude = Join-Path $projectDir '.claude'
    $homeClaude = Join-Path $guardHome '.claude'
    if ((Test-Path -LiteralPath $projectClaude -PathType Container) -and
        (Test-Path -LiteralPath $homeClaude -PathType Container)) {
      $resolvedProjectClaude = Resolve-ForgeFullPath (Resolve-Path -LiteralPath $projectClaude).Path
      $resolvedHomeClaude = Resolve-ForgeFullPath (Resolve-Path -LiteralPath $homeClaude).Path
      if ($resolvedProjectClaude -ieq $resolvedHomeClaude) {
        Write-ForgeError 'the target project''s .claude directory is the same as your global ~\.claude -- refusing to overwrite your global settings. Pass -ProjectDir <dir> pointing at an actual project folder.'
        exit 1
      }
    }
  }

  # $PSScriptRoot is empty when the script runs via irm|iex (no script file on disk). Pipe mode is
  # detected explicitly and NEVER falls back to trusting the current directory (security #10, review
  # #8): a cwd that happens to contain global-install\.claude + .claude would otherwise be installed
  # instead of the official archive, and VERSION/SHA256SUMS would be read from that cwd too.
  $pipeMode = [string]::IsNullOrEmpty($PSScriptRoot)
  $scriptDir = if ($pipeMode) { '' } else { $PSScriptRoot }

  $tempDir = $null
  $sourceDir = ''

  try {
    # -----------------------------------------------------------------------
    # 1. dual-source detection
    # -----------------------------------------------------------------------
    if ($pipeMode) {
      Write-ForgeLog 'Running from a pipe (no script file on disk) -- installing from the downloaded archive.'
    } else {
      $inPlaceGlobal = Join-Path $scriptDir 'global-install\.claude'
      $inPlaceProject = Join-Path $scriptDir '.claude'

      if ((Test-Path -LiteralPath $inPlaceGlobal -PathType Container) -and
          (Test-Path -LiteralPath $inPlaceProject -PathType Container)) {
        $sourceDir = $scriptDir
        Write-ForgeLog "Running in place from: $sourceDir"
      }
    }

    if (-not $sourceDir) {
      if (-not $pipeMode) {
        Write-ForgeLog "Repo payload not found next to this script -- downloading $RepoOwner/$RepoName@$forgeRef ..."
      }

      if ($isDryRun) {
        Write-ForgeLog "  [dry-run] would download https://github.com/$RepoOwner/$RepoName/archive/refs/heads/$forgeRef.zip"
        $sourceDir = ''
      } else {
        $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-install-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

        $archiveUrl = "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/$forgeRef.zip"
        $archivePath = Join-Path $tempDir 'claude-forge.zip'

        try {
          Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing
        } catch {
          Write-ForgeError "failed to download claude-forge archive: $($_.Exception.Message)"
          exit 1
        }

        # NOTE: skipped entirely in pipe mode -- there is no script-adjacent $scriptDir to trust for
        # this lookup (Join-Path errors on an empty path, and a pipe install has no adjacent checkout).
        if (-not $pipeMode) {
          $sumsPath = Join-Path $scriptDir 'SHA256SUMS'
          if (Test-Path -LiteralPath $sumsPath -PathType Leaf) {
            $sumsContent = Get-Content -LiteralPath $sumsPath -ErrorAction SilentlyContinue
            $expectedLine = $sumsContent | Where-Object { $_ -match 'claude-forge\.zip' } | Select-Object -First 1
            if ($expectedLine) {
              $expected = ($expectedLine -split '\s+')[0]
              $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
              if ($expected.ToLower() -ne $actual.ToLower()) {
                Write-ForgeError "checksum mismatch for downloaded archive (expected $expected, got $actual)"
                exit 1
              }
              Write-ForgeLog "  checksum verified"
            }
          }
        }

        Expand-Archive -LiteralPath $archivePath -DestinationPath $tempDir -Force

        $extracted = Get-ChildItem -LiteralPath $tempDir -Directory | Where-Object { $_.Name -like "$RepoName-*" } | Select-Object -First 1
        if (-not $extracted -or -not (Test-Path -LiteralPath (Join-Path $extracted.FullName 'global-install\.claude') -PathType Container)) {
          Write-ForgeError 'downloaded archive did not contain the expected claude-forge payload'
          exit 1
        }
        $sourceDir = $extracted.FullName
        Write-ForgeLog "Downloaded to: $sourceDir"
      }
    }

    # $sourceDir is checked FIRST: when a download happened (pipe mode or a missing in-place payload),
    # VERSION must come from what was actually downloaded, never from cwd/$scriptDir (review #8/#10).
    # The $scriptDir fallback below only ever fires in -DryRun (no download occurred) and never in pipe
    # mode, where $scriptDir is intentionally empty.
    $versionPath = if ($sourceDir -and (Test-Path -LiteralPath (Join-Path $sourceDir 'VERSION') -PathType Leaf)) {
      Join-Path $sourceDir 'VERSION'
    } elseif ((-not $pipeMode) -and (Test-Path -LiteralPath (Join-Path $scriptDir 'VERSION') -PathType Leaf)) {
      Join-Path $scriptDir 'VERSION'
    } else {
      ''
    }
    $forgeVersion = if ($versionPath -and (Test-Path -LiteralPath $versionPath -PathType Leaf)) {
      (Get-Content -LiteralPath $versionPath -Raw -ErrorAction SilentlyContinue).Trim()
    } else {
      'unknown'
    }
    Write-ForgeLog "claude-forge version: $forgeVersion"

    # -------------------------------------------------------------------------
    # 2. plan ($doGlobal / $doProject were computed early, ahead of the HOME guard above)
    # -------------------------------------------------------------------------
    Write-ForgeLog ''
    Write-ForgeLog 'This will write files to:'
    if ($doGlobal) { Write-ForgeLog "  - $HOME\.claude                  (global core: forge-core skill, /forge, /setup-forge)" }
    if ($doGlobal) { Write-ForgeLog "  - $HOME\.claude\forge\template   (canonical template: used by forge-sync and the auto-installer)" }
    if ($doProject) { Write-ForgeLog "  - $projectDir\.claude           (per-project payload: skills, agents, dashboard, config)" }
    if ($doProject) { Write-ForgeLog "  - $projectDir\CLAUDE.md         (only if missing) and $projectDir\.gitignore (Forge lines appended)" }
    Write-ForgeLog ''
    Write-ForgeLog 'Existing files that differ are backed up as <file>.forge-bak-<timestamp> and replaced -- except .claude\settings.json, which is always kept: the payload version is written next to it as settings.forge-recommended.json instead.'
    Write-ForgeLog 'Identical files are left untouched. This installer never deletes your existing .claude tree.'
    Write-ForgeLog ''

    if ($isDryRun) {
      Write-ForgeLog '(dry-run mode -- no files will actually be written)'
    }

    if (-not $assumeYes -and -not $isDryRun) {
      # [Environment]::UserInteractive stays TRUE under `irm ... | iex`: iex evaluates the fetched
      # script text inside the CURRENT PowerShell host process -- unlike `curl | bash`, no child
      # process's stdin is replaced by the pipe, so Read-Host still reads from the real console
      # (review HIGH #2). FORGE_YES=1 / -Yes remain the non-interactive opt-out (see the param block).
      if ([Environment]::UserInteractive) {
        $reply = Read-Host 'Proceed? [y/N]'
        if ($reply -notmatch '^(y|Y|yes|YES)$') {
          Write-ForgeLog 'Aborted.'
          exit 0
        }
      } else {
        Write-ForgeError 'non-interactive session and no -Yes/-y or FORGE_YES=1 given -- aborting to avoid unattended writes'
        exit 1
      }
    }

    if (-not $sourceDir) {
      Write-ForgeLog ''
      Write-ForgeLog 'Dry run complete. No files were written.'
      return
    }

    # -------------------------------------------------------------------------
    # 3. merge-safe copy
    # -------------------------------------------------------------------------
    $globalOk = $true
    $projectOk = $true

    if ($doGlobal) {
      Write-ForgeLog ''
      Write-ForgeLog "Installing global core -> $HOME\.claude"
      $globalOk = Copy-ForgeTree -SourceDir (Join-Path $sourceDir 'global-install\.claude') -DestDir (Join-Path $forgeHome '.claude') -IsDryRun $isDryRun
      # The CANONICAL TEMPLATE (external audit II-A, 2026-09-23). The forge-core skill sends every
      # "install Forge V2 into this project", the bare-folder auto-install and the "stay current" rule to
      # ~\.claude\forge\template\ -- and this installer never created it, so all three pointed at nothing
      # and `forge-sync status` compared each project with itself ("up to date" forever). The template is
      # the project payload plus the two root seeds, kept where the skill looks for it.
      $templateDir = Join-Path $forgeHome '.claude\forge\template'
      Write-ForgeLog ''
      Write-ForgeLog "Installing canonical template -> $templateDir (used by forge-sync and the auto-installer)"
      $templateOk = Copy-ForgeTree -SourceDir (Join-Path $sourceDir '.claude') -DestDir (Join-Path $templateDir '.claude') -IsDryRun $isDryRun
      if ($templateOk -and -not $isDryRun) {
        $seedMd = Join-Path $sourceDir 'templates\project-CLAUDE.md'
        $seedGi = Join-Path $sourceDir 'templates\gitignore.snippet'
        $seedEnv = Join-Path $sourceDir '.env.example'
        if (Test-Path -LiteralPath $seedMd) { Copy-Item -LiteralPath $seedMd -Destination (Join-Path $templateDir 'CLAUDE.md') -Force }
        if (Test-Path -LiteralPath $seedGi) { Copy-Item -LiteralPath $seedGi -Destination (Join-Path $templateDir 'gitignore.snippet') -Force }
        if (Test-Path -LiteralPath $seedEnv) { Copy-Item -LiteralPath $seedEnv -Destination (Join-Path $templateDir 'env.example') -Force }
      } elseif (-not $templateOk) {
        Write-ForgeError 'canonical template copy had failures (project installs still work; forge-sync update checks will not)'
        $globalOk = $false
      }
    }

    if ($doProject) {
      Write-ForgeLog ''
      Write-ForgeLog "Installing project payload -> $projectDir\.claude"
      if (-not (Test-Path -LiteralPath $projectDir -PathType Container)) {
        New-Item -ItemType Directory -Path $projectDir -Force | Out-Null
      }
      $projectOk = Copy-ForgeTree -SourceDir (Join-Path $sourceDir '.claude') -DestDir (Join-Path $projectDir '.claude') -IsDryRun $isDryRun -ProtectSettings $true -MergeToolPath (Join-Path $sourceDir '.claude\forge-bin\forge-settings-merge.cjs')
      # Seed the two project-root files Forge documents but the payload copy never delivered.
      # Added 2026-08-13 after a real fresh-install measurement: without them three suites
      # (forge-configdrift, forge-tool-index, forge-toolhook) fail on a brand-new project and the
      # first forge-doctor a new user runs reports FAILURES. Merge-safe and idempotent.
      Add-ForgeProjectRootSeed -ProjectDir $projectDir -SourceDir $sourceDir -IsDryRun $isDryRun
      # Record WHICH release this project got: forge-sync status reads forge_version from this file
      # (2.4.0: the payload no longer ships a stale copy of this per-install file).
      Write-ForgeVersionMarker -ProjectDir $projectDir -Version $forgeVersion -IsDryRun $isDryRun
    }

    # -------------------------------------------------------------------------
    # 4. success epilogue -- gated on real status, never unconditional
    # -------------------------------------------------------------------------
    if ($isDryRun) {
      Write-ForgeLog ''
      Write-ForgeLog 'Dry run complete. No files were written.'
      return
    }

    if ($doGlobal -and -not $globalOk) {
      Write-ForgeError 'global core install failed -- see errors above'
      exit 1
    }
    if ($doProject -and -not $projectOk) {
      Write-ForgeError 'project install failed -- see errors above'
      exit 1
    }

    Write-ForgeLog ''
    Write-ForgeLog "claude-forge $forgeVersion installed successfully."
    Write-ForgeLog ''
    Write-ForgeLog 'Next steps:'
    Write-ForgeLog "  cd `"$projectDir`"; claude"
    Write-ForgeLog '  /setup-forge'
    Write-ForgeLog '  /forge <task>'
    Write-ForgeLog ''
    Write-ForgeLog "Docs: https://github.com/$RepoOwner/$RepoName#readme"
  } finally {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir -PathType Container)) {
      Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Main
