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

# Recursively merge-copy every file under $SourceDir into $DestDir.
function Copy-ForgeTree {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$DestDir,
    [Parameter(Mandatory = $true)][bool]$IsDryRun
  )

  if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    Write-ForgeError "source directory missing: $SourceDir"
    return $false
  }

  $files = Get-ChildItem -LiteralPath $SourceDir -Recurse -File -Force
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($SourceDir.Length).TrimStart('\', '/')
    $dest = Join-Path -Path $DestDir -ChildPath $rel
    Copy-ForgeFile -SourceFile $file.FullName -DestFile $dest -IsDryRun $IsDryRun
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

function Main {
  $projectDir = if ($ProjectDir) { $ProjectDir } else { (Get-Location).Path }
  $assumeYes  = [bool]$Yes -or ($env:FORGE_YES -eq '1')
  $isDryRun   = [bool]$DryRun
  $globalOnly = [bool]$GlobalOnly
  $projectOnly = [bool]$ProjectOnly
  $forgeRef   = if ($env:FORGE_REF) { $env:FORGE_REF } else { 'main' }

  if ($globalOnly -and $projectOnly) {
    Write-ForgeError '-GlobalOnly and -ProjectOnly are mutually exclusive'
    exit 1
  }

  # $PSScriptRoot is empty when the script runs via irm|iex (no script file on disk).
  $scriptDir = $PSScriptRoot
  if ([string]::IsNullOrEmpty($scriptDir)) {
    $scriptDir = (Get-Location).Path
  }

  $tempDir = $null
  $sourceDir = ''

  try {
    # -----------------------------------------------------------------------
    # 1. dual-source detection
    # -----------------------------------------------------------------------
    $inPlaceGlobal = Join-Path $scriptDir 'global-install\.claude'
    $inPlaceProject = Join-Path $scriptDir '.claude'

    if ((Test-Path -LiteralPath $inPlaceGlobal -PathType Container) -and
        (Test-Path -LiteralPath $inPlaceProject -PathType Container)) {
      $sourceDir = $scriptDir
      Write-ForgeLog "Running in place from: $sourceDir"
    } else {
      Write-ForgeLog "Repo payload not found next to this script -- downloading $RepoOwner/$RepoName@$forgeRef ..."

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

    $versionPath = Join-Path $scriptDir 'VERSION'
    if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf) -and $sourceDir) {
      $versionPath = Join-Path $sourceDir 'VERSION'
    }
    $forgeVersion = if (Test-Path -LiteralPath $versionPath -PathType Leaf) {
      (Get-Content -LiteralPath $versionPath -Raw -ErrorAction SilentlyContinue).Trim()
    } else {
      'unknown'
    }
    Write-ForgeLog "claude-forge version: $forgeVersion"

    # -------------------------------------------------------------------------
    # 2. plan
    # -------------------------------------------------------------------------
    $doGlobal = -not $projectOnly
    $doProject = -not $globalOnly

    Write-ForgeLog ''
    Write-ForgeLog 'This will write files to:'
    if ($doGlobal) { Write-ForgeLog "  - $HOME\.claude          (global core: forge-core skill, /forge, /setup-forge)" }
    if ($doProject) { Write-ForgeLog "  - $projectDir\.claude   (per-project payload: skills, agents, dashboard, config)" }
    Write-ForgeLog ''
    Write-ForgeLog 'Existing files that differ will be backed up as <file>.forge-bak-<timestamp> before being overwritten.'
    Write-ForgeLog 'Identical files are left untouched. This installer never deletes your existing .claude tree.'
    Write-ForgeLog ''

    if ($isDryRun) {
      Write-ForgeLog '(dry-run mode -- no files will actually be written)'
    }

    if (-not $assumeYes -and -not $isDryRun) {
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
      $globalOk = Copy-ForgeTree -SourceDir (Join-Path $sourceDir 'global-install\.claude') -DestDir (Join-Path $HOME '.claude') -IsDryRun $isDryRun
    }

    if ($doProject) {
      Write-ForgeLog ''
      Write-ForgeLog "Installing project payload -> $projectDir\.claude"
      if (-not (Test-Path -LiteralPath $projectDir -PathType Container)) {
        New-Item -ItemType Directory -Path $projectDir -Force | Out-Null
      }
      $projectOk = Copy-ForgeTree -SourceDir (Join-Path $sourceDir '.claude') -DestDir (Join-Path $projectDir '.claude') -IsDryRun $isDryRun
      # Seed the two project-root files Forge documents but the payload copy never delivered.
      # Added 2026-08-13 after a real fresh-install measurement: without them three suites
      # (forge-configdrift, forge-tool-index, forge-toolhook) fail on a brand-new project and the
      # first forge-doctor a new user runs reports FAILURES. Merge-safe and idempotent.
      Add-ForgeProjectRootSeed -ProjectDir $projectDir -SourceDir $sourceDir -IsDryRun $isDryRun
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
