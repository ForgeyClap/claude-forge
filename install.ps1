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

.PARAMETER Uninstall
  Remove exactly what a claude-forge installer wrote, and nothing else. Every write this
  installer makes is recorded in an install manifest (path + sha256) -- project-side at
  <ProjectDir>\.claude\.forge-install-manifest.json, global-side at
  $HOME\.claude\forge\install-manifest.json. Uninstall deletes a listed file ONLY when its
  current hash still matches the manifest; a file you edited yourself is left in place and
  reported as kept. Pre-2.8.0 installs have no manifest: uninstall then falls back to a
  byte-identical comparison against this installer's own shipped payload. Your own data
  (CLAUDE.md if it predates Forge, .env, FORGE_MEMORY*, forge-runs, agent-memory) is always
  left in place. Honors -ProjectDir, -Yes, -DryRun, -GlobalOnly/-ProjectOnly the same way
  install does. Safe to run twice: a second uninstall is a no-op.

.EXAMPLE
  .\install.ps1

.EXAMPLE
  .\install.ps1 -Uninstall

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
  [switch]$ProjectOnly,
  [switch]$Uninstall
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

# Test-ForgeReparsePoint -- true when $Path itself (no ancestor walk, not the target it points at) is a
# symlink or a Windows reparse point (a directory junction -- `mklink /J` -- reports ReparsePoint too, the
# same class Node's fs.lstatSync(...).isSymbolicLink() catches on Windows). Used by the guarded settings
# writers below (V07, wp-g2 2026-09-24 Codex re-check out-p7.md) so a junction/link planted at .claude\ is
# refused instead of silently followed.
function Test-ForgeReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  } catch {
    return $false
  }
}

# New-ForgeGuardedFile -- creates a NEW $DestFile (no existing file yet) from $SourceFile without following
# a symlink/junction at $DestDir, and without clobbering/following a path that already exists at $DestFile.
# [System.IO.FileMode]::CreateNew is the .NET equivalent of POSIX O_EXCL/`wx` -- it throws if ANY filesystem
# entry (including a symlink) already exists at that exact path, and never follows one to write elsewhere.
# This is the PowerShell-only (no `node`) equivalent of forge-settings-merge.cjs's own guarded create path.
function New-ForgeGuardedFile {
  param(
    [Parameter(Mandatory = $true)][string]$DestDir,
    [Parameter(Mandatory = $true)][string]$DestFile,
    [Parameter(Mandatory = $true)][string]$SourceFile
  )
  if (Test-ForgeReparsePoint -Path $DestDir) {
    Write-ForgeError "refusing: $DestDir is a symlink/junction, not a real directory"
    return $false
  }
  $stream = $null
  try {
    $stream = [System.IO.File]::Open($DestFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    $bytes = [System.IO.File]::ReadAllBytes($SourceFile)
    $stream.Write($bytes, 0, $bytes.Length)
    return $true
  } catch {
    Write-ForgeError "could not create $DestFile (it already exists, or $DestDir cannot be written to) -- refusing to overwrite or follow a link: $($_.Exception.Message)"
    return $false
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

# Write-ForgeGuardedRecommended -- AUXILIARY-FILE-CLOBBER for the PowerShell-only (no `node`) fallback: a
# uniquely timestamp+random-suffixed settings.forge-recommended-<stamp>-<rand>.json, exclusively created
# (CreateNew -- never overwrites/follows a prior recovery file or a planted symlink at that exact name),
# mirroring forge-settings-merge-guards.cjs's own writeExclusiveUnique (V07). Never targets a FIXED
# settings.forge-recommended.json path -- a pre-existing file or link already sitting at that fixed name is
# simply never touched, by construction. Returns the written path, or $null on failure/refusal.
function Write-ForgeGuardedRecommended {
  param(
    [Parameter(Mandatory = $true)][string]$DestDir,
    [Parameter(Mandatory = $true)][string]$SourceFile
  )
  if (Test-ForgeReparsePoint -Path $DestDir) {
    Write-ForgeError "refusing: $DestDir is a symlink/junction -- could not write a recommended-hooks file"
    return $null
  }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  for ($attempt = 0; $attempt -lt 8; $attempt++) {
    $rand = Get-Random -Maximum 1000000
    $recFile = Join-Path $DestDir "settings.forge-recommended-$stamp-$rand.json"
    $stream = $null
    try {
      $stream = [System.IO.File]::Open($recFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
      $bytes = [System.IO.File]::ReadAllBytes($SourceFile)
      $stream.Write($bytes, 0, $bytes.Length)
      return $recFile
    } catch {
      continue
    } finally {
      if ($stream) { $stream.Dispose() }
    }
  }
  Write-ForgeError "could not create a unique recommended-hooks file in $DestDir after 8 attempts"
  return $null
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
#
# V07 (wp-g2, 2026-09-24 Codex re-check out-p7.md): EVERY settings destination now goes through a guarded
# path -- the merge tool's own guarded create (with -ProjectRoot / --project-root so PROJECT-DIRECTORY-ESCAPE
# applies even to a brand-new settings.json), or the PowerShell-only guarded helpers above when `node` is
# unavailable -- never an unrestricted `Copy-Item -Force` to a fixed path. This function now returns an
# explicit [bool] on every path (never a bare `return`) and $script:ForgeSettingsGateFailed is set whenever
# the gate hook does NOT end up installed, so Copy-ForgeTree/Main can propagate that into a real,
# non-success exit code instead of a false "installed successfully" (this used to always report success).
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
  $mergeTool = $MergeToolPath
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $haveMergeTool = $nodeCmd -and $mergeTool -and (Test-Path -LiteralPath $mergeTool -PathType Leaf)

  # UNSAFE-FIRST-COPY (wp-f2, 2026-09-24 Codex re-check): a destination that EXISTS but is not a regular file
  # (a directory named settings.json, most concretely) bypassed every branch below and reached
  # `Copy-Item -Destination $DestFile -Force`, which copies INTO an existing directory instead of replacing
  # it -- nesting the payload's settings.json inside it while reporting success. Refuse cleanly instead.
  if ((Test-Path -LiteralPath $DestFile) -and -not (Test-Path -LiteralPath $DestFile -PathType Leaf)) {
    if ($IsDryRun) {
      Write-ForgeLog "  [dry-run] REFUSING: $DestFile exists but is not a regular file (e.g. a directory) -- settings.json would be left untouched"
    } else {
      Write-ForgeError "$DestFile exists but is not a regular file (e.g. a directory) -- refusing to touch it; settings.json was left untouched; the PreToolUse gate hook was NOT installed"
      $script:ForgeSettingsGateFailed = $true
    }
    return $false
  }

  if ($IsDryRun) {
    if ($haveMergeTool) {
      # $ErrorActionPreference is 'Stop' script-wide; a native tool's stderr line captured via 2>&1 can be
      # wrapped as a terminating ErrorRecord under that setting, so it is relaxed for this one call only.
      $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      try { $mergeOut = & node $mergeTool apply --target $DestFile --source $SourceFile --project-root $destDir --dry-run 2>&1 }
      finally { $ErrorActionPreference = $prevEap }
      Write-ForgeLog "  [dry-run] $mergeOut"
    } elseif (Test-Path -LiteralPath $DestFile -PathType Leaf) {
      $srcHash = (Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash
      $dstHash = (Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash
      if ($srcHash -eq $dstHash) {
        Write-ForgeLog "  [dry-run] unchanged: $DestFile"
      } else {
        Write-ForgeLog "  [dry-run] node not found -- would keep your settings.json unmerged; would write a recommended-hooks file (guarded, uniquely named)"
      }
    } else {
      Write-ForgeLog "  [dry-run] node not found -- would create: $DestFile (guarded -- refuses a symlinked/junctioned .claude)"
    }
    return $true
  }

  if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }

  if (Test-Path -LiteralPath $DestFile -PathType Leaf) {
    $srcHash = (Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash
    if ($srcHash -eq $dstHash) {
      return $true # identical, no-op
    }
    if ($haveMergeTool) {
      $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      try { $mergeOut = & node $mergeTool apply --target $DestFile --source $SourceFile --project-root $destDir 2>&1 }
      finally { $ErrorActionPreference = $prevEap }
      if ($LASTEXITCODE -eq 0) {
        Write-ForgeLog "  $mergeOut"
        return $true
      }
      # The merge tool's OWN refusal already wrote a guarded, uniquely-named settings.forge-recommended-
      # <stamp>-<rand>.json next to the target (or explains in $mergeOut why it could not) -- never re-copy
      # over that with a second, unguarded Copy-Item -Force (V07: that was the actual junction/link bypass).
      Write-ForgeError "settings.json merge refused ($mergeOut) -- the PreToolUse gate hook was NOT installed into $DestFile"
      $script:ForgeSettingsGateFailed = $true
      return $false
    }
    Write-ForgeLog "  node not found on PATH -- cannot merge settings.json automatically; writing a recommended-hooks file instead"
    $rec = Write-ForgeGuardedRecommended -DestDir $destDir -SourceFile $SourceFile
    if ($rec) {
      Write-ForgeError "kept your settings.json unmerged (node not found on PATH) -- the PreToolUse gate hook was NOT installed into $DestFile; Forge's recommended hooks are in $rec"
    } else {
      Write-ForgeError "kept your settings.json unmerged (node not found on PATH) and could not write a recommended-hooks file either -- the PreToolUse gate hook was NOT installed into $DestFile"
    }
    $script:ForgeSettingsGateFailed = $true
    return $false
  }

  # $DestFile does not exist yet -- route through the SAME guarded create path forge-settings-merge.cjs uses
  # for an existing target (never a raw Copy-Item): -ProjectRoot makes a symlinked/junctioned .claude refuse
  # exactly like the merge helper does (PROJECT-DIRECTORY-ESCAPE), even for a brand-new settings.json.
  if ($haveMergeTool) {
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $mergeOut = & node $mergeTool apply --target $DestFile --source $SourceFile --project-root $destDir 2>&1 }
    finally { $ErrorActionPreference = $prevEap }
    if ($LASTEXITCODE -eq 0) {
      Write-ForgeLog "  $mergeOut"
      return $true
    }
    Write-ForgeError "could not create settings.json ($mergeOut) -- the PreToolUse gate hook was NOT installed into $DestFile"
    $script:ForgeSettingsGateFailed = $true
    return $false
  }

  # node unavailable and nothing to merge with yet -- guarded PowerShell-only raw create (still refuses a
  # symlinked/junctioned .claude and never follows/overwrites a path that already exists at $DestFile).
  if (New-ForgeGuardedFile -DestDir $destDir -DestFile $DestFile -SourceFile $SourceFile) {
    Write-ForgeLog "  wrote: $DestFile"
    return $true
  }
  Write-ForgeError "the PreToolUse gate hook was NOT installed into $DestFile"
  $script:ForgeSettingsGateFailed = $true
  return $false
}

# Recursively merge-copy every file under $SourceDir into $DestDir.
# -ProtectSettings routes <dir>\settings.json through Copy-ForgeSettingsFile instead of the generic
# backup-then-overwrite path (used for the project payload only — see Copy-ForgeSettingsFile).
#
# V07 (wp-g2, 2026-09-24 Codex re-check out-p7.md): this used to `return $true` UNCONDITIONALLY regardless
# of what Copy-ForgeSettingsFile reported for settings.json -- a directory-shaped (or any other) settings
# refusal never propagated past this point, so $projectOk in Main stayed $true and the installer reported
# "installed successfully" even though the gate hook was never installed. Every per-file result is now
# captured and AND-ed into the tree's own overall result.
function Copy-ForgeTree {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$DestDir,
    [Parameter(Mandatory = $true)][bool]$IsDryRun,
    [bool]$ProtectSettings = $false,
    # Passed straight through to Copy-ForgeSettingsFile — see that function's own param comment for why this
    # must be an explicit parameter rather than an ambient `$sourceDir`/`$SourceDir` variable lookup.
    [string]$MergeToolPath = $null,
    # v2.8.0 uninstaller support: when set, every file this call actually copies (never settings.json —
    # that file is MERGED, never owned/deleted by an uninstall) is recorded into $script:ForgeManifest
    # under this scope ('global' or 'project'), relative to $ManifestRoot, with its sha256 at write time.
    [string]$ManifestScope = $null,
    [string]$ManifestRoot = $null
  )

  if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    Write-ForgeError "source directory missing: $SourceDir"
    return $false
  }

  $allOk = $true
  $files = Get-ChildItem -LiteralPath $SourceDir -Recurse -File -Force
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($SourceDir.Length).TrimStart('\', '/')
    $dest = Join-Path -Path $DestDir -ChildPath $rel
    if ($ProtectSettings -and $rel -eq 'settings.json') {
      $fileOk = Copy-ForgeSettingsFile -SourceFile $file.FullName -DestFile $dest -IsDryRun $IsDryRun -MergeToolPath $MergeToolPath
      if (-not $fileOk) { $allOk = $false }
      # never manifested: settings.json is merged, not owned — an uninstall must never delete it
    } else {
      Copy-ForgeFile -SourceFile $file.FullName -DestFile $dest -IsDryRun $IsDryRun
      if (-not $IsDryRun -and $ManifestScope) {
        Add-ForgeManifestEntry -Scope $ManifestScope -RootDir $ManifestRoot -AbsPath $dest
      }
    }
  }

  return $allOk
}

# ---------------------------------------------------------------------------
# Install manifest (v2.8.0) — WHAT the uninstaller is allowed to remove.
#
# The uninstaller must remove EXACTLY what the installer wrote, never more. Rather than hand
# -Uninstall a hardcoded file list (which drifts from the real payload the moment either one
# changes), the installer records every file it actually copies — path + sha256 at write time —
# into two small JSON manifests: project-side and global-side (see Write-ForgeManifestFile).
# -Uninstall then deletes a listed file ONLY when its CURRENT hash still matches what was
# recorded: a file you edited yourself differs and is left in place, reported as kept. This is
# the same "never blindly trust a path, verify the content" discipline
# Copy-ForgeSettingsFile/forge-settings-merge.cjs already use for settings.json.
# ---------------------------------------------------------------------------

# Add-ForgeManifestEntry — records one written file (by its sha256 at THIS moment) into
# $script:ForgeManifest[$Scope], relative to $RootDir (forward-slash, so the same manifest reads
# identically on POSIX and Windows). A no-op if the file does not exist (e.g. a dry-run path, or
# a write that was itself skipped/refused).
function Add-ForgeManifestEntry {
  param(
    [Parameter(Mandatory = $true)][string]$Scope,
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$AbsPath
  )
  if (-not (Test-Path -LiteralPath $AbsPath -PathType Leaf)) { return }
  $rootFull = Resolve-ForgeFullPath $RootDir
  $absFull = Resolve-ForgeFullPath $AbsPath
  if ($absFull.Length -le $rootFull.Length) { return }
  $rel = ($absFull.Substring($rootFull.Length).TrimStart('\', '/')) -replace '\\', '/'
  $hash = (Get-FileHash -LiteralPath $AbsPath -Algorithm SHA256).Hash
  [void] $script:ForgeManifest[$Scope].Add([ordered]@{ path = $rel; sha256 = $hash })
}

# Write-ForgeManifestFile — writes the accumulated manifest for one scope to disk. A no-op when
# nothing was recorded for that scope this run (e.g. a -ProjectOnly install never touches the
# global manifest, and must not overwrite/clear one from an earlier -GlobalOnly install).
function Write-ForgeManifestFile {
  param(
    [Parameter(Mandatory = $true)][string]$Scope,
    [Parameter(Mandatory = $true)][string]$DestFile,
    [Parameter(Mandatory = $true)][string]$Version
  )
  $entries = $script:ForgeManifest[$Scope]
  if (-not $entries -or $entries.Count -eq 0) { return }
  $destDir = Split-Path -Parent -Path $DestFile
  if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }
  $sorted = @($entries | Sort-Object path)
  $manifest = [ordered]@{
    forge_version = $Version
    written_at    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    scope         = $Scope
    _doc          = 'Every file this installer wrote for this scope, with its sha256 at write time. -Uninstall / --uninstall deletes a listed file only when its CURRENT hash still matches -- a file you edited yourself is left in place and reported as kept.'
    files         = $sorted
  }
  $json = ($manifest | ConvertTo-Json -Depth 5)
  [System.IO.File]::WriteAllText($DestFile, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-ForgeLog "  wrote: $DestFile ($($sorted.Count) file(s) recorded for uninstall)"
}

# Resolve-ForgeSource — the SAME in-place-or-download detection Main uses for install, factored
# out so -Uninstall's pre-2.8.0 (no-manifest) fallback can hash-compare against the identical
# shipped payload without duplicating the download/checksum logic. Returns @{ SourceDir; TempDir }
# ($TempDir is $null unless a download actually happened; the caller is responsible for cleaning
# it up in a finally block, exactly like Main does for its own download).
function Resolve-ForgeSource {
  param(
    [Parameter(Mandatory = $true)][bool]$PipeMode,
    [Parameter(Mandatory = $true)][string]$ScriptDir,
    [Parameter(Mandatory = $true)][string]$ForgeRef,
    [Parameter(Mandatory = $true)][bool]$IsDryRun
  )
  if (-not $PipeMode) {
    $inPlaceGlobal = Join-Path $ScriptDir 'global-install\.claude'
    $inPlaceProject = Join-Path $ScriptDir '.claude'
    if ((Test-Path -LiteralPath $inPlaceGlobal -PathType Container) -and
        (Test-Path -LiteralPath $inPlaceProject -PathType Container)) {
      return @{ SourceDir = $ScriptDir; TempDir = $null }
    }
  }
  if ($IsDryRun) { return @{ SourceDir = ''; TempDir = $null } }
  $tempDirLocal = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-uninstall-" + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Path $tempDirLocal -Force | Out-Null
    $archiveUrl = "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/$ForgeRef.zip"
    $archivePath = Join-Path $tempDirLocal 'claude-forge.zip'
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing
    Expand-Archive -LiteralPath $archivePath -DestinationPath $tempDirLocal -Force
    $extracted = Get-ChildItem -LiteralPath $tempDirLocal -Directory | Where-Object { $_.Name -like "$RepoName-*" } | Select-Object -First 1
    if ($extracted -and (Test-Path -LiteralPath (Join-Path $extracted.FullName 'global-install\.claude') -PathType Container)) {
      return @{ SourceDir = $extracted.FullName; TempDir = $tempDirLocal }
    }
  } catch {
    Write-ForgeError "could not fetch the claude-forge payload to compare against ($($_.Exception.Message))"
  }
  return @{ SourceDir = ''; TempDir = $tempDirLocal }
}

# Remove-ForgeEmptyDirs — walks upward from $StartDir toward (but never removing) $StopAt,
# removing one directory at a time ONLY when it is already completely empty. Never recursive:
# each Remove-Item call targets exactly one directory that Get-ChildItem just proved has zero
# entries, so this can never delete anything with content in it.
function Remove-ForgeEmptyDirs {
  param(
    [Parameter(Mandatory = $true)][string]$StartDir,
    [Parameter(Mandatory = $true)][string]$StopAt
  )
  $stopFull = Resolve-ForgeFullPath $StopAt
  $dir = $StartDir
  while ($true) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { break }
    if ((Resolve-ForgeFullPath $dir) -ieq $stopFull) { break }
    # @(...) forces an array even when exactly one child is found -- a bare (unwrapped) single
    # FileInfo/DirectoryInfo result has no .Count property under Set-StrictMode -Version 3.0
    # (measured: "The property 'Count' cannot be found on this object").
    $children = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
    if ($children.Count -gt 0) { break }
    Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
    $dir = Split-Path -Parent $dir
    if (-not $dir) { break }
  }
}

# Remove-ForgeManifestFiles — the manifest-driven removal path (2.8.0+ installs). Deletes a
# listed file only when its current sha256 still matches what the installer recorded; a file you
# edited yourself differs and is kept. Removes only the now-empty directories left behind.
function Remove-ForgeManifestFiles {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)]$Entries,
    [bool]$IsDryRun = $false
  )
  $removed = 0; $kept = 0; $missing = 0
  $touchedDirs = New-Object 'System.Collections.Generic.List[string]'
  foreach ($e in $Entries) {
    $relWin = ($e.path -replace '/', '\')
    $abs = Join-Path $RootDir $relWin
    if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { $missing++; continue }
    $curHash = (Get-FileHash -LiteralPath $abs -Algorithm SHA256).Hash
    if ($curHash -ieq $e.sha256) {
      if ($IsDryRun) {
        Write-ForgeLog "  [dry-run] would remove: $abs"
      } else {
        Remove-Item -LiteralPath $abs -Force
        Write-ForgeLog "  removed: $abs"
        [void] $touchedDirs.Add((Split-Path -Parent $abs))
      }
      $removed++
    } else {
      Write-ForgeLog "  kept (you edited this file): $abs"
      $kept++
    }
  }
  if (-not $IsDryRun) {
    foreach ($d in @($touchedDirs | Select-Object -Unique)) {
      Remove-ForgeEmptyDirs -StartDir $d -StopAt $RootDir
    }
  }
  return [ordered]@{ removed = $removed; kept = $kept; missing = $missing }
}

# Remove-ForgePayloadFallback — the pre-2.8.0 (no-manifest) fallback: removes a file under
# $DestRootDir only when it is byte-identical (sha256-equal) to the corresponding file under
# $PayloadSourceDir (this installer's own shipped payload). Never removes a file that differs
# (your own edit, or a different release) or one this build's payload does not even ship.
function Remove-ForgePayloadFallback {
  param(
    [Parameter(Mandatory = $true)][string]$PayloadSourceDir,
    [Parameter(Mandatory = $true)][string]$DestRootDir,
    [bool]$IsDryRun = $false,
    [string[]]$SkipRel = @()
  )
  if (-not (Test-Path -LiteralPath $PayloadSourceDir -PathType Container)) {
    return [ordered]@{ removed = 0; kept = 0 }
  }
  $removed = 0; $kept = 0
  $touchedDirs = New-Object 'System.Collections.Generic.List[string]'
  $files = Get-ChildItem -LiteralPath $PayloadSourceDir -Recurse -File -Force
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($PayloadSourceDir.Length).TrimStart('\', '/')
    $relSlash = $rel -replace '\\', '/'
    if ($SkipRel -contains $relSlash) { continue }
    $dest = Join-Path $DestRootDir $rel
    if (-not (Test-Path -LiteralPath $dest -PathType Leaf)) { continue }
    $srcHash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
    if ($srcHash -eq $dstHash) {
      if ($IsDryRun) {
        Write-ForgeLog "  [dry-run] would remove (byte-identical to the shipped payload): $dest"
      } else {
        Remove-Item -LiteralPath $dest -Force
        Write-ForgeLog "  removed: $dest"
        [void] $touchedDirs.Add((Split-Path -Parent $dest))
      }
      $removed++
    } else {
      Write-ForgeLog "  kept (you edited this file, or it is from a different release): $dest"
      $kept++
    }
  }
  if (-not $IsDryRun) {
    foreach ($d in @($touchedDirs | Select-Object -Unique)) {
      Remove-ForgeEmptyDirs -StartDir $d -StopAt $DestRootDir
    }
  }
  return [ordered]@{ removed = $removed; kept = $kept }
}

# Remove-ForgeGitignoreLines — removes ONLY the exact lines templates\gitignore.snippet added
# (plus the installer's own header comment), never a line the project already had for its own
# reasons. Collapses a run of blank lines left behind by the removal down to at most one, and
# trims trailing blank lines, without touching any other content.
function Remove-ForgeGitignoreLines {
  param(
    [Parameter(Mandatory = $true)][string]$GitignorePath,
    [Parameter(Mandatory = $true)][string]$SnippetPath,
    [bool]$IsDryRun = $false
  )
  if (-not (Test-Path -LiteralPath $GitignorePath -PathType Leaf)) {
    Write-ForgeLog "  kept:  $GitignorePath (does not exist -- nothing to remove)"
    return
  }
  if (-not (Test-Path -LiteralPath $SnippetPath -PathType Leaf)) {
    Write-ForgeLog "  skipped: gitignore.snippet is not available -- cannot identify which lines Forge added, so $GitignorePath was left untouched"
    return
  }
  $forgeLines = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($line in (Get-Content -LiteralPath $SnippetPath)) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    [void] $forgeLines.Add($t)
  }
  $header = '# --- Forge (added by the claude-forge installer) ---'
  $existing = @(Get-Content -LiteralPath $GitignorePath -ErrorAction SilentlyContinue)
  $kept = New-Object 'System.Collections.Generic.List[string]'
  $removedCount = 0
  foreach ($line in $existing) {
    $t = $line.Trim()
    if ($t -eq $header -or $forgeLines.Contains($t)) { $removedCount++; continue }
    [void] $kept.Add($line)
  }
  if ($removedCount -eq 0) {
    Write-ForgeLog "  kept:  $GitignorePath (no Forge lines found -- already clean)"
    return
  }
  $collapsed = New-Object 'System.Collections.Generic.List[string]'
  $prevBlank = $false
  foreach ($line in $kept) {
    $isBlank = ($line.Trim() -eq '')
    if ($isBlank -and $prevBlank) { continue }
    [void] $collapsed.Add($line)
    $prevBlank = $isBlank
  }
  while ($collapsed.Count -gt 0 -and $collapsed[$collapsed.Count - 1].Trim() -eq '') {
    $collapsed.RemoveAt($collapsed.Count - 1)
  }
  if ($IsDryRun) {
    Write-ForgeLog "  [dry-run] would remove $removedCount Forge line(s) from $GitignorePath"
    return
  }
  $text = if ($collapsed.Count -gt 0) { ($collapsed -join "`n") + "`n" } else { '' }
  [System.IO.File]::WriteAllText($GitignorePath, $text, (New-Object System.Text.UTF8Encoding($false)))
  Write-ForgeLog "  wrote: $GitignorePath (-$removedCount Forge line(s) removed; your own lines kept)"
}

# Invoke-ForgeSettingsUnmerge — settings.json is MERGED on install, so it must never be deleted
# on uninstall; this calls forge-settings-merge.cjs's own `unmerge` subcommand (mirrors `apply`:
# 0 done/no-op, 1 refused-safe, 2 usage) to lift back out exactly the entries `apply` added. If
# the local copy of the tool does not know `unmerge` yet, or node/the tool are unavailable, this
# leaves settings.json completely untouched and says so in one plain line -- it never falls back
# to editing the file itself.
function Invoke-ForgeSettingsUnmerge {
  param(
    [Parameter(Mandatory = $true)][string]$TargetSettings,
    [Parameter(Mandatory = $true)][string]$SourceSettings,
    [bool]$IsDryRun = $false
  )
  if (-not (Test-Path -LiteralPath $TargetSettings -PathType Leaf)) {
    Write-ForgeLog "  kept:  $TargetSettings (does not exist -- nothing to unmerge)"
    return
  }
  $mergeTool = Join-Path (Split-Path -Parent (Split-Path -Parent $TargetSettings)) '.claude\forge-bin\forge-settings-merge.cjs'
  if (-not (Test-Path -LiteralPath $mergeTool -PathType Leaf)) {
    Write-ForgeLog "  kept:  $TargetSettings unmerged -- forge-settings-merge.cjs is not on disk here; left untouched"
    return
  }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Write-ForgeLog "  kept:  $TargetSettings unmerged -- node is not on PATH; left untouched"
    return
  }
  $cliArgs = @('unmerge', '--target', $TargetSettings, '--source', $SourceSettings)
  if ($IsDryRun) { $cliArgs += '--dry-run' }
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & node $mergeTool @cliArgs 2>&1 }
  finally { $ErrorActionPreference = $prevEap }
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    Write-ForgeLog "  $out"
  } elseif ($code -eq 1) {
    Write-ForgeLog "  kept:  $TargetSettings -- unmerge refused ($out); left untouched"
  } else {
    Write-ForgeLog "  kept:  $TargetSettings unmerged -- this copy of forge-settings-merge.cjs does not support 'unmerge' yet; left untouched"
  }
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
      # Manifested ONLY on this branch (freshly written by Forge) — never on the "kept" branch
      # above, so an uninstall can never delete a CLAUDE.md that predates Forge.
      Add-ForgeManifestEntry -Scope 'project' -RootDir $ProjectDir -AbsPath $claudeMd
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
#
# HOME-RESOLUTION-DRIFT (wp-f2, 2026-09-24 Codex re-check): this function used to recompute its OWN home
# directory independently -- `$env:HOME` before `$env:USERPROFILE`, with NO third fallback -- while Main's
# guard/copy logic resolves `$forgeHome` as USERPROFILE -> HOME -> the automatic `$HOME` variable. Two
# consequences, both real: (1) with USERPROFILE and HOME set to DIFFERENT values, the marker recorded a
# `template` path under a DIFFERENT home than the one payload files were actually copied under. (2) with
# BOTH environment variables unset, this function's own fallback chain ended at `$env:USERPROFILE` (empty),
# so `Join-Path $homeDir ...` received an empty base and could fail AFTER the payload write already
# succeeded. Fixed by resolving the home ONCE in Main and passing it in explicitly -- the same discipline
# `Copy-ForgeSettingsFile`'s own `$MergeToolPath` parameter comment already documents for this exact class of
# PowerShell case-insensitive-ambient-variable bug.
function Write-ForgeVersionMarker {
  param(
    [Parameter(Mandatory = $true)][string] $ProjectDir,
    [Parameter(Mandatory = $true)][string] $Version,
    [Parameter(Mandatory = $true)][string] $ForgeHome,
    [bool] $IsDryRun = $false
  )
  $markerPath = Join-Path $ProjectDir '.claude\FORGE_VERSION.json'
  $templatePath = Join-Path $ForgeHome '.claude\forge\template\.claude'
  if ($IsDryRun) {
    Write-ForgeLog "  would write: $markerPath (forge_version $Version) -- only if version/template changed since the last install"
    return
  }
  # INSTALLER-NONIDEMPOTENCE (wp-f2): a second install of the SAME release used to rewrite this file (a fresh
  # timestamp, every time) even though nothing about the installed content or template actually changed --
  # contradicting this installer's own "safe to re-run... identical files are a no-op" claim. Preserve the
  # marker (and its original synced_at) when the recorded version AND template path both already match.
  if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
    try {
      $prev = Get-Content -LiteralPath $markerPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      if ($prev.forge_version -eq $Version -and $prev.template -eq $templatePath) {
        Write-ForgeLog "  kept:  $markerPath (forge_version $Version unchanged -- marker left as-is)"
        # Still manifested: this file is always Forge-owned installer metadata (never hand-authored
        # by a user before Forge exists), regardless of which branch wrote/kept it this run.
        Add-ForgeManifestEntry -Scope 'project' -RootDir $ProjectDir -AbsPath $markerPath
        return
      }
    } catch {
      # unreadable/malformed existing marker -- fall through and rewrite it, same as before this fix
    }
  }
  $marker = [ordered]@{
    forge_version = $Version
    synced_at     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    template      = $templatePath
    installed_by  = 'install.ps1'
    _doc          = 'forge_version is the release this installer wrote; forge-sync status prints it as installed= and detects drift by file hash against the canonical template.'
  }
  try {
    $json = ($marker | ConvertTo-Json -Depth 3)
    [System.IO.File]::WriteAllText($markerPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-ForgeLog "  wrote: $markerPath (forge_version $Version)"
    Add-ForgeManifestEntry -Scope 'project' -RootDir $ProjectDir -AbsPath $markerPath
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

  # v2.8.0 install manifest accumulator (see Add-ForgeManifestEntry/Write-ForgeManifestFile above) --
  # reset here so a fresh run never carries entries over from a previous call in the same process.
  $script:ForgeManifest = @{
    global  = New-Object 'System.Collections.Generic.List[object]'
    project = New-Object 'System.Collections.Generic.List[object]'
  }

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
    # HOME-RESOLUTION-DRIFT (wp-f2): this preview used PowerShell's AUTOMATIC $HOME variable, while the real
    # copy below (and the version marker) resolve $forgeHome as USERPROFILE -> HOME -> automatic $HOME -- so a
    # session with an overridden USERPROFILE could see one path here and have files land under another.
    # OUTSIDE-WRITES-BY-DEFAULT: both are real writes OUTSIDE this project (global, shared by every project),
    # named as such rather than left implicit.
    if ($doGlobal) { Write-ForgeLog "  - $forgeHome\.claude                  [OUTSIDE this project -- global, shared by every project] (global core: forge-core skill, /forge, /setup-forge)" }
    if ($doGlobal) { Write-ForgeLog "  - $forgeHome\.claude\forge\template   [OUTSIDE this project -- global] (canonical template: used by forge-sync and the auto-installer)" }
    if ($doProject) { Write-ForgeLog "  - $projectDir\.claude           (per-project payload: skills, agents, dashboard, config)" }
    if ($doProject) { Write-ForgeLog "  - $projectDir\CLAUDE.md         (only if missing) and $projectDir\.gitignore (Forge lines appended)" }
    Write-ForgeLog ''
    Write-ForgeLog 'Existing files that differ are backed up as <file>.forge-bak-<timestamp> and replaced -- except .claude\settings.json, which is MERGED (your own hooks/rules kept, a backup taken first); when a merge is not possible, a settings.forge-recommended-<timestamp>.json is written next to it instead and settings.json itself is left untouched.'
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
    # Set by Copy-ForgeSettingsFile (V07, wp-g2 2026-09-24 Codex re-check out-p7.md) whenever the PreToolUse
    # gate hook did NOT end up merged into <project>\.claude\settings.json for any reason (refused merge, a
    # directory/unreadable/malformed target, node unavailable, a guarded write itself failing) -- checked
    # below so the final summary names the gate specifically, never just a generic "install failed". `$script:`
    # scope is required: Copy-ForgeSettingsFile runs several call frames below this one.
    $script:ForgeSettingsGateFailed = $false

    if ($doGlobal) {
      Write-ForgeLog ''
      Write-ForgeLog "Installing global core -> $HOME\.claude"
      $globalOk = Copy-ForgeTree -SourceDir (Join-Path $sourceDir 'global-install\.claude') -DestDir (Join-Path $forgeHome '.claude') -IsDryRun $isDryRun -ManifestScope 'global' -ManifestRoot $forgeHome
      # The CANONICAL TEMPLATE (external audit II-A, 2026-09-23). The forge-core skill sends every
      # "install Forge V2 into this project", the bare-folder auto-install and the "stay current" rule to
      # ~\.claude\forge\template\ -- and this installer never created it, so all three pointed at nothing
      # and `forge-sync status` compared each project with itself ("up to date" forever). The template is
      # the project payload plus the two root seeds, kept where the skill looks for it.
      $templateDir = Join-Path $forgeHome '.claude\forge\template'
      Write-ForgeLog ''
      Write-ForgeLog "Installing canonical template -> $templateDir (used by forge-sync and the auto-installer)"
      $templateOk = Copy-ForgeTree -SourceDir (Join-Path $sourceDir '.claude') -DestDir (Join-Path $templateDir '.claude') -IsDryRun $isDryRun -ManifestScope 'global' -ManifestRoot $forgeHome
      if ($templateOk -and -not $isDryRun) {
        $seedMd = Join-Path $sourceDir 'templates\project-CLAUDE.md'
        $seedGi = Join-Path $sourceDir 'templates\gitignore.snippet'
        $seedEnv = Join-Path $sourceDir '.env.example'
        if (Test-Path -LiteralPath $seedMd) {
          $tSeedMd = Join-Path $templateDir 'CLAUDE.md'
          Copy-Item -LiteralPath $seedMd -Destination $tSeedMd -Force
          Add-ForgeManifestEntry -Scope 'global' -RootDir $forgeHome -AbsPath $tSeedMd
        }
        if (Test-Path -LiteralPath $seedGi) {
          $tSeedGi = Join-Path $templateDir 'gitignore.snippet'
          Copy-Item -LiteralPath $seedGi -Destination $tSeedGi -Force
          Add-ForgeManifestEntry -Scope 'global' -RootDir $forgeHome -AbsPath $tSeedGi
        }
        if (Test-Path -LiteralPath $seedEnv) {
          $tSeedEnv = Join-Path $templateDir 'env.example'
          Copy-Item -LiteralPath $seedEnv -Destination $tSeedEnv -Force
          Add-ForgeManifestEntry -Scope 'global' -RootDir $forgeHome -AbsPath $tSeedEnv
        }
      } elseif (-not $templateOk) {
        Write-ForgeError 'canonical template copy had failures (project installs still work; forge-sync update checks will not)'
        $globalOk = $false
      }
    }

    if ($doProject) {
      Write-ForgeLog ''
      Write-ForgeLog "Installing project payload -> $projectDir\.claude"
      # COR-DRYRUN (wp-f2, 2026-09-24 Codex re-check): this directory creation ran UNCONDITIONALLY, even
      # under -DryRun, contradicting "Show what would be written, change nothing" -- a preview into a
      # not-yet-existing target directory silently created it. Guarded like every other write in this
      # installer now: real writes only, a plain "[dry-run] would create" line otherwise.
      if (-not (Test-Path -LiteralPath $projectDir -PathType Container)) {
        if ($isDryRun) {
          Write-ForgeLog "  [dry-run] would create directory: $projectDir"
        } else {
          New-Item -ItemType Directory -Path $projectDir -Force | Out-Null
        }
      }
      $projectOk = Copy-ForgeTree -SourceDir (Join-Path $sourceDir '.claude') -DestDir (Join-Path $projectDir '.claude') -IsDryRun $isDryRun -ProtectSettings $true -MergeToolPath (Join-Path $sourceDir '.claude\forge-bin\forge-settings-merge.cjs') -ManifestScope 'project' -ManifestRoot $projectDir
      # Seed the two project-root files Forge documents but the payload copy never delivered.
      # Added 2026-08-13 after a real fresh-install measurement: without them three suites
      # (forge-configdrift, forge-tool-index, forge-toolhook) fail on a brand-new project and the
      # first forge-doctor a new user runs reports FAILURES. Merge-safe and idempotent.
      Add-ForgeProjectRootSeed -ProjectDir $projectDir -SourceDir $sourceDir -IsDryRun $isDryRun
      # Record WHICH release this project got: forge-sync status reads forge_version from this file
      # (2.4.0: the payload no longer ships a stale copy of this per-install file). $forgeHome is the SAME
      # already-resolved home Main uses everywhere else (HOME-RESOLUTION-DRIFT fix) -- passed explicitly,
      # never recomputed inside the function.
      Write-ForgeVersionMarker -ProjectDir $projectDir -Version $forgeVersion -ForgeHome $forgeHome -IsDryRun $isDryRun
    }

    # v2.8.0: persist the manifest(s) an uninstall will read back — see Add-ForgeManifestEntry's
    # header comment. Only for the scope(s) this run actually touched, and never on a dry-run (which
    # never wrote anything real to hash in the first place).
    if (-not $isDryRun) {
      if ($doGlobal) {
        Write-ForgeManifestFile -Scope 'global' -DestFile (Join-Path $forgeHome '.claude\forge\install-manifest.json') -Version $forgeVersion
      }
      if ($doProject) {
        Write-ForgeManifestFile -Scope 'project' -DestFile (Join-Path $projectDir '.claude\.forge-install-manifest.json') -Version $forgeVersion
      }
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
      if ($script:ForgeSettingsGateFailed) {
        Write-ForgeError "project install failed: the PreToolUse gate hook was NOT installed into $projectDir\.claude\settings.json -- see errors above"
      } else {
        Write-ForgeError 'project install failed -- see errors above'
      }
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

# ---------------------------------------------------------------------------
# Uninstall (v2.8.0) -- removes exactly what an install wrote, verified by hash; see the
# .PARAMETER Uninstall doc comment at the top of this file for the full contract.
# ---------------------------------------------------------------------------
function Invoke-ForgeUninstall {
  $projectDir = if ($ProjectDir) { $ProjectDir } else { (Get-Location).Path }
  $forgeHome = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { $HOME }
  $assumeYes = [bool]$Yes -or ($env:FORGE_YES -eq '1')
  $isDryRun = [bool]$DryRun
  $globalOnly = [bool]$GlobalOnly
  $projectOnly = [bool]$ProjectOnly
  $forgeRef = if ($env:FORGE_REF) { $env:FORGE_REF } else { 'main' }

  if ($globalOnly -and $projectOnly) {
    Write-ForgeError '-GlobalOnly and -ProjectOnly are mutually exclusive'
    exit 1
  }
  $doGlobal = -not $projectOnly
  $doProject = -not $globalOnly

  Write-ForgeLog 'claude-forge uninstaller'
  Write-ForgeLog ''
  if ($doProject) { Write-ForgeLog "This will remove Forge's own files from: $projectDir\.claude (only files the installer itself wrote, verified by hash)" }
  if ($doGlobal) { Write-ForgeLog "This will remove Forge's global core from: $forgeHome\.claude (forge-core skill, /forge, /setup-forge, the canonical template)" }
  Write-ForgeLog 'A file you edited yourself, and your own data (memory, run logs, CLAUDE.md, .env), are left in place.'
  Write-ForgeLog ''
  if ($isDryRun) { Write-ForgeLog '(dry-run mode -- nothing will actually be removed)' }

  if (-not $assumeYes -and -not $isDryRun) {
    if ([Environment]::UserInteractive) {
      $reply = Read-Host 'Proceed with uninstall? [y/N]'
      if ($reply -notmatch '^(y|Y|yes|YES)$') {
        Write-ForgeLog 'Aborted.'
        exit 0
      }
    } else {
      Write-ForgeError 'non-interactive session and no -Yes/-y or FORGE_YES=1 given -- aborting to avoid unattended removal'
      exit 1
    }
  }

  $pipeMode = [string]::IsNullOrEmpty($PSScriptRoot)
  $scriptDir = if ($pipeMode) { '' } else { $PSScriptRoot }
  $srcInfo = Resolve-ForgeSource -PipeMode $pipeMode -ScriptDir $scriptDir -ForgeRef $forgeRef -IsDryRun $isDryRun
  $sourceDir = $srcInfo.SourceDir
  $tempDir = $srcInfo.TempDir

  try {
    if ($doProject) {
      Write-ForgeLog ''
      Write-ForgeLog "Project: $projectDir\.claude"
      $manifestPath = Join-Path $projectDir '.claude\.forge-install-manifest.json'
      if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $r = Remove-ForgeManifestFiles -RootDir $projectDir -Entries @($manifest.files) -IsDryRun $isDryRun
        Write-ForgeLog "  manifest: removed $($r.removed), kept $($r.kept) (edited by you), $($r.missing) already gone"
        if (-not $isDryRun) { Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue }
      } elseif ($sourceDir -and (Test-Path -LiteralPath (Join-Path $sourceDir '.claude') -PathType Container)) {
        Write-ForgeLog '  no install manifest found (a pre-2.8.0 install) -- falling back to a byte-identical comparison against the shipped payload'
        $r = Remove-ForgePayloadFallback -PayloadSourceDir (Join-Path $sourceDir '.claude') -DestRootDir (Join-Path $projectDir '.claude') -IsDryRun $isDryRun -SkipRel @('settings.json')
        Write-ForgeLog "  fallback: removed $($r.removed), kept $($r.kept)"
      } else {
        Write-ForgeLog '  no install manifest found, and no payload available to compare against -- nothing removed from .claude (run the uninstaller from a claude-forge checkout, or with network access, to use the fallback)'
      }

      # settings.json is MERGED, never deleted -- unmerge only.
      $settingsTarget = Join-Path $projectDir '.claude\settings.json'
      $settingsSource = if ($sourceDir) { Join-Path $sourceDir '.claude\settings.json' } else { '' }
      if ($settingsSource -and (Test-Path -LiteralPath $settingsSource -PathType Leaf)) {
        Invoke-ForgeSettingsUnmerge -TargetSettings $settingsTarget -SourceSettings $settingsSource -IsDryRun $isDryRun
      } else {
        Write-ForgeLog "  kept:  $settingsTarget unmerged -- no payload settings.json available to unmerge against"
      }

      # .gitignore: remove ONLY the exact lines the installer's snippet added.
      if ($sourceDir) {
        $giSnippet = Join-Path $sourceDir 'templates\gitignore.snippet'
        Remove-ForgeGitignoreLines -GitignorePath (Join-Path $projectDir '.gitignore') -SnippetPath $giSnippet -IsDryRun $isDryRun
      } else {
        Write-ForgeLog '  skipped: .gitignore -- no payload gitignore.snippet available to identify Forge''s own lines'
      }

      Write-ForgeLog ''
      Write-ForgeLog '  left in place (your own data): CLAUDE.md (if it predates Forge or you edited it), .env, FORGE_MEMORY*.md, .claude/forge-runs/, .claude/agent-memory/, and .claude/settings.json (unmerged above, never deleted)'
    }

    if ($doGlobal) {
      Write-ForgeLog ''
      Write-ForgeLog "Global: $forgeHome\.claude"
      $gManifestPath = Join-Path $forgeHome '.claude\forge\install-manifest.json'
      if (Test-Path -LiteralPath $gManifestPath -PathType Leaf) {
        $gManifest = Get-Content -LiteralPath $gManifestPath -Raw | ConvertFrom-Json
        $r = Remove-ForgeManifestFiles -RootDir $forgeHome -Entries @($gManifest.files) -IsDryRun $isDryRun
        Write-ForgeLog "  manifest: removed $($r.removed), kept $($r.kept) (edited by you), $($r.missing) already gone"
        if (-not $isDryRun) { Remove-Item -LiteralPath $gManifestPath -Force -ErrorAction SilentlyContinue }
      } elseif ($sourceDir) {
        Write-ForgeLog '  no install manifest found (a pre-2.8.0 install) -- falling back to a byte-identical comparison against the shipped payload'
        $r1 = Remove-ForgePayloadFallback -PayloadSourceDir (Join-Path $sourceDir 'global-install\.claude') -DestRootDir (Join-Path $forgeHome '.claude') -IsDryRun $isDryRun
        $r2 = Remove-ForgePayloadFallback -PayloadSourceDir (Join-Path $sourceDir '.claude') -DestRootDir (Join-Path $forgeHome '.claude\forge\template\.claude') -IsDryRun $isDryRun -SkipRel @('settings.json')
        Write-ForgeLog "  fallback: removed $($r1.removed + $r2.removed), kept $($r1.kept + $r2.kept)"
      } else {
        Write-ForgeLog '  no install manifest found, and no payload available to compare against -- nothing removed from the global core'
      }

      # Stale usage-guard pid file (audit Part II, N8): remove ONLY when it points at a dead process.
      $pidFile = Join-Path $forgeHome '.claude\forge-usage-guard.pid'
      if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
        $dead = $true
        try {
          $rec = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
          if ($rec.pid -and (Get-Process -Id $rec.pid -ErrorAction SilentlyContinue)) { $dead = $false }
        } catch {
          $dead = $true # unreadable/malformed -- treat as stale, same as the tool's own stale-slot takeover does
        }
        if ($dead) {
          if ($isDryRun) { Write-ForgeLog "  [dry-run] would remove stale pid file: $pidFile" }
          else { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue; Write-ForgeLog "  removed: $pidFile (pointed at a dead process)" }
        } else {
          Write-ForgeLog "  kept:  $pidFile (a usage-guard watcher is still running -- stop it first: node .claude\forge-bin\usage-guard.cjs stop)"
        }
      }

      Write-ForgeLog ''
      Write-ForgeLog '  left in place (your own data / other tools'' state): FORGE_USAGE_GUARD_STATE.json, FORGE_USAGE_PRESSURE.json, .credentials.json, forge-usage-guard-account-map.json, and anything else under ~\.claude this installer did not write'
    }

    Write-ForgeLog ''
    if ($isDryRun) { Write-ForgeLog 'Dry run complete. Nothing was removed.' }
    else { Write-ForgeLog 'claude-forge uninstall complete.' }
  } finally {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir -PathType Container)) {
      Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($Uninstall) { Invoke-ForgeUninstall } else { Main }
