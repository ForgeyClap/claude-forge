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

# v2.8.1 (WP-P3, R3 independent review): relative path of the SYSTEM-synced owner-rules file — kept as
# one constant so Test-ForgeStandingRulesMigration/Copy-ForgeTree never drift out of step with each
# other. Mirrors STANDING_RULES_REL in .claude\forge-bin\forge-sync.cjs.
$ForgeStandingRulesRel = 'config/orchestration/FORGE_STANDING_RULES.json'

# The node one-liner Test-ForgeStandingRulesMigration runs against the NEW payload's own
# forge-sync.cjs — every path is passed as argv, never interpolated into this text, so a path
# containing quotes/spaces/backslashes can never break out of the script. Read via
# process.argv.slice(-4) rather than a fixed index: this text runs from a real temp .js FILE here
# (`node -e` is unsafe on PowerShell -- see Test-ForgeStandingRulesMigration's own comment), where argv
# is [node, file, a, b, c, d], but install.sh runs this identical text via `node -e THIS_TEXT a b c d`,
# where argv is [node, a, b, c, d] (no slot reserved for the eval text itself) -- a fixed
# argv[1]/argv[2]/... would silently read the wrong thing on one of the two installers (found by a real
# local run, WP-P3: "sync.migrateOwnerStandingRules is not a function"). slice(-4) reads the same four
# trailing args regardless of which shape argv has: [0] the payload's forge-sync.cjs, [1] the project
# dir, [2] the forward-slash form of $ForgeStandingRulesRel (kept as an argument, not a second
# hardcoded copy of the literal, so this text and the constant it mirrors can never drift apart), [3]
# "1" in a dry run, "0" in a real run.
# Exit 0 = safe to replace FORGE_STANDING_RULES.json this run (no owner rule was present, or it was
# moved to FORGE_STANDING_RULES.user.json already); exit 2 = NOT safe (an owner rule could not be
# confirmed migrated); exit 3 (F2 fix, 2026-09-27 independent v2.8.1 review) = the file EXISTS but
# could not itself be read or parsed (corrupt, locked, or an unreadable path) --
# Test-ForgeStandingRulesMigration treats ANY non-zero exit the same way for the copy itself (skip),
# but reports 3 with its own distinct, honest message instead of the generic "pending migration" one.
$ForgeStandingMigrateJs = @'
try {
  var args = process.argv.slice(-4);
  var sync = require(args[0]);
  var projectDir = args[1];
  var standingRulesRel = args[2];
  var dryRun = args[3] === "1";
  var ids = sync.migrateOwnerStandingRules(projectDir, { dryRun: dryRun });
  if (ids.pending) { process.exit(2); }
  if (ids.length > 0) {
    process.stdout.write((dryRun ? "[dry-run] would move " : "moved ") + ids.length + " owner rule(s) from a pre-v2.8.0 install into config/orchestration/FORGE_STANDING_RULES.user.json\n");
    process.exit(0);
  }
  // F2 fix (2026-09-27, independent v2.8.1 review): migrateOwnerStandingRules() cannot tell "no file
  // yet" apart from "the file exists but could not be read or parsed" -- both return the identical
  // { length: 0, pending: false } (see that function's own doc comment in forge-sync.cjs, which this
  // fix never edits -- the payload is off limits here, see this file's own header note on this
  // block). The caller already confirmed the file EXISTS before this script ever runs, so reaching
  // this point with an empty, non-pending result is ambiguous: either it parses fine and genuinely
  // holds nothing to migrate, or it is corrupt/locked/unreadable and the function silently gave up.
  // Re-attempting the identical read+parse here (never a write, safe in a dry run too) resolves that
  // ambiguity without touching forge-sync.cjs: a failure here exits 3, a distinct code the installer
  // treats as "keep the file, and say why" instead of silently letting it be backed up and replaced.
  var fs = require("fs");
  var path = require("path");
  var targetPath = path.join(projectDir, ".claude", standingRulesRel);
  try {
    JSON.parse(fs.readFileSync(targetPath, "utf8"));
  } catch (e) {
    process.stderr.write("forge-sync: " + targetPath + " could not be read or parsed (" + e.message + ")\n");
    process.exit(3);
  }
  process.exit(0);
} catch (e) {
  process.stderr.write("forge-sync: could not check for a pre-v2.8.0 owner rule (" + e.message + ")\n");
  process.exit(2);
}
'@

# v2.9.0 (WP-P3, coordinator follow-up): the Command Center gateway only auto-discovers projects
# under <home>\Documents, <home>\Desktop and its own parent folder (command-center\gateway\src\
# paths.mjs SYNC_SCAN_ROOTS) -- a project living anywhere else (a custom drive/folder) never shows
# up in the dashboard. Every project install/uninstall records (or removes) this project's absolute
# path in $HOME\.claude\forge\projects.json, a small { schema, projects: [...] } file the gateway
# reads (WP-P1, a separate work package -- this installer only writes the file). Real JSON
# read-modify-write via `node` (same discipline as $ForgeStandingMigrateJs above: never a hand-rolled
# regex edit of a user-owned file); when node is unavailable this warns once and continues -- it
# NEVER fails the install over this file. Written atomically (temp file + rename) and merged like
# settings.json: never added to the install manifest, so a global --uninstall/-Uninstall never
# deletes the whole file -- only a project uninstall removes that ONE project's own entry.
# process.argv.slice(-4) mirrors $ForgeStandingMigrateJs's own argv trick -- see that constant's
# header comment for why a fixed index would silently read the wrong thing on one of the two
# installers.
$ForgeProjectsRegistryJs = @'
try {
  var args = process.argv.slice(-4);
  var projectsPath = args[0];
  var projectPath = args[1];
  var dryRun = args[2] === "1";
  var action = args[3];
  var fs = require("fs");
  var path = require("path");
  var isWin = process.platform === "win32";
  var norm = function (p) {
    p = String(p);
    if (isWin) { p = p.replace(/\\/g, "/").toLowerCase(); }
    if (p.length > 1) { p = p.replace(/\/+$/, ""); }
    return p;
  };

  // WP-9B-INST (Codex adversarial review, INSTALL-4 LOW): two installs racing on the SAME
  // projects.json (e.g. two terminals installing/uninstalling different projects at once) can each
  // read the file before the other's rename lands, so the second writer's own temp-file+rename
  // silently discards the first writer's change -- a lost-update race, even though each individual
  // write is itself atomic. fs.mkdirSync is atomic (EEXIST when the directory already exists, exactly
  // like a Unix `mkdir` used as a lockfile) and serializes the whole read-modify-rename section below
  // across concurrent installer processes.
  var lockPath = projectsPath + ".lock";
  fs.mkdirSync(path.dirname(projectsPath), { recursive: true });
  var haveLock = false;
  var STALE_MS = 2 * 60 * 1000;   // a lock older than ~2 minutes is treated as abandoned (a crashed
                                   // installer, or a machine that lost power mid-write) and removed
  var RETRY_MS = 50;
  var MAX_WAIT_MS = 5000;         // "a short wait, up to a few seconds" per the fix's own wording
  var deadline = Date.now() + MAX_WAIT_MS;
  while (!haveLock) {
    try {
      fs.mkdirSync(lockPath);
      haveLock = true;
    } catch (eLock) {
      if (eLock.code !== "EEXIST") { throw eLock; }
      var isStale = false;
      try {
        isStale = (Date.now() - fs.statSync(lockPath).mtime.getTime()) > STALE_MS;
      } catch (eStat) {
        // the lock vanished between our mkdir attempt and this stat (the other installer finished and
        // cleaned up) -- just retry the mkdir immediately, no need to treat this as a stale lock.
      }
      if (isStale) {
        try { fs.rmdirSync(lockPath); } catch (eRm) { /* another process may already have removed it, or we lack permission */ }
        if (Date.now() >= deadline) {
          process.stderr.write("forge: " + lockPath + " looks stale but could not be removed -- proceeding without a lock (a concurrent update to the projects registry could be lost)\n");
          break;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        process.stderr.write("forge: " + lockPath + " is still held by another install after " + MAX_WAIT_MS + "ms -- proceeding without it (a concurrent update to the projects registry could be lost)\n");
        break;
      }
      // Node has no synchronous sleep primitive without extra dependencies -- a short busy-wait is the
      // simplest thing that works identically on every Node version this installer supports.
      var until = Date.now() + RETRY_MS;
      while (Date.now() < until) { /* busy-wait */ }
    }
  }

  var exitCode = (function run() {
    try {
      var data = { schema: 1, projects: [] };
      if (fs.existsSync(projectsPath)) {
        var raw = fs.readFileSync(projectsPath, "utf8");
        var parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (eParse) {
          process.stderr.write("forge: " + projectsPath + " could not be read or parsed (" + eParse.message + ") -- left untouched\n");
          return 3;
        }
        if (!parsed || !Array.isArray(parsed.projects)) {
          process.stderr.write("forge: " + projectsPath + " does not have the expected { projects: [...] } shape -- left untouched\n");
          return 3;
        }
        data = parsed;
      }
      if (typeof data.schema !== "number") { data.schema = 1; }

      var idx = -1;
      for (var i = 0; i < data.projects.length; i++) {
        if (norm(data.projects[i]) === norm(projectPath)) { idx = i; break; }
      }

      if (action === "remove") {
        if (idx === -1) {
          process.stdout.write((dryRun ? "[dry-run] " : "") + "no entry for this project in " + projectsPath + " -- nothing to remove\n");
          return 0;
        }
        if (dryRun) {
          process.stdout.write("[dry-run] would remove the entry for this project from " + projectsPath + "\n");
          return 0;
        }
        data.projects.splice(idx, 1);
      } else {
        if (idx !== -1) {
          process.stdout.write((dryRun ? "[dry-run] " : "") + "this project is already recorded in " + projectsPath + "\n");
          return 0;
        }
        if (dryRun) {
          process.stdout.write("[dry-run] would add this project to " + projectsPath + " so the Command Center dashboard can find it\n");
          return 0;
        }
        data.projects.push(projectPath);
      }

      var dir = path.dirname(projectsPath);
      fs.mkdirSync(dir, { recursive: true });
      var tmp = projectsPath + ".tmp-" + process.pid + "-" + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, projectsPath);
      process.stdout.write((action === "remove" ? "removed this project from " : "added this project to ") + projectsPath + "\n");
      return 0;
    } finally {
      if (haveLock) {
        try { fs.rmdirSync(lockPath); } catch (eRelease) { /* best effort -- a missing lock dir at cleanup time is not an error */ }
      }
    }
  })();

  process.exit(exitCode);
} catch (e) {
  process.stderr.write("forge: could not update the projects registry (" + e.message + ")\n");
  process.exit(2);
}
'@

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

# F2b fix (2026-09-27, independent v2.8.1 review): -ProjectDir "C:\My Proj\" binds a perfectly clean
# PowerShell string (trailing backslash intact, no stray quote -- confirmed on this machine: the
# script's OWN parameter binding is not affected) to $ProjectDir, but the MOMENT this installer hands
# that same string to a NATIVE command (node.exe -- see Test-ForgeStandingRulesMigration) as an
# argument, PowerShell's own native-argv marshalling breaks it: Windows' CommandLineToArgvW convention
# reads a trailing backslash right before the closing quote PowerShell adds around a spaced argument
# as an ESCAPED quote, not a literal backslash, so node's own argv actually receives the corrupted
# `C:\My Proj"` -- confirmed with `& node -e "console.log(process.argv[1])" 'C:\My Proj\'` on this
# machine (node received "C:\My Proj\"" byte-for-byte, no closing quote). `"` can never be part of a
# real Windows path, so trimming a trailing one is always safe; a trailing backslash/slash is trimmed
# too, UNLESS the path would collapse to a bare drive letter ("C:" means "current directory on drive
# C" -- a DIFFERENT location than "C:\", the drive root -- so that one case is left untouched). Called
# once, right where $projectDir is resolved, so every downstream use (every node call, every Join-Path)
# already gets the clean value -- never re-trimmed ad hoc at each call site.
function ConvertTo-ForgeCleanProjectPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $p = $Path.TrimEnd('"')
  if ($p -match '^[A-Za-z]:[\\/]$') { return $p }
  return $p.TrimEnd('\', '/')
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
    if ((Test-Path -LiteralPath $DestFile) -and -not (Test-Path -LiteralPath $DestFile -PathType Leaf)) {
      Write-ForgeLog "  [dry-run] SKIP (a directory already exists at this file's destination): $DestFile"
      return $true
    }
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
    return $true
  }

  # WP-9B-INST (Codex adversarial review, INSTALL-3 MEDIUM): $DestFile existing as anything OTHER than
  # a regular file (almost always a directory left behind by an older release, or planted deliberately)
  # must never be silently treated as "does not exist yet" -- Test-Path -PathType Leaf returns $false
  # for BOTH cases, but Copy-Item -Force against an existing DIRECTORY copies the source INSIDE it
  # (DestFile\SourceFileName), not AS DestFile -- reporting "wrote: $DestFile" while the real bytes
  # landed one level deeper. Treated as an explicit failure, never a silent success.
  if ((Test-Path -LiteralPath $DestFile) -and -not (Test-Path -LiteralPath $DestFile -PathType Leaf)) {
    Write-ForgeError "cannot write $DestFile -- a directory (or other non-file item) already exists at that exact path"
    return $false
  }

  if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
  }

  $srcHash = (Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash
  if (Test-Path -LiteralPath $DestFile -PathType Leaf) {
    $dstHash = (Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash
    if ($srcHash -eq $dstHash) {
      # identical, no-op
      return $true
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bakFile = "$DestFile.forge-bak-$stamp"
    Move-Item -LiteralPath $DestFile -Destination $bakFile -Force
    Write-ForgeLog "  backed up: $DestFile -> $bakFile"
  }

  Copy-Item -LiteralPath $SourceFile -Destination $DestFile -Force
  # WP-9B-INST (INSTALL-3): verify the copy actually produced a regular file matching the source's
  # hash, before ever reporting success -- catches a destination that silently became a
  # directory-nested copy, or any other post-copy mismatch, instead of trusting Copy-Item's own lack
  # of a thrown exception alone.
  if (-not (Test-Path -LiteralPath $DestFile -PathType Leaf)) {
    Write-ForgeError "copy to $DestFile did not produce a regular file (a directory may exist at that path) -- treating this as a failure"
    return $false
  }
  $verifyHash = (Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash
  if ($verifyHash -ine $srcHash) {
    Write-ForgeError "copy to $DestFile did not match the source's hash after copying -- treating this as a failure"
    return $false
  }
  Write-ForgeLog "  wrote: $DestFile"
  return $true
}

# Copy-ForgeManifestAwareFile -- v2.9.0 (WP-P3b, point 3): the SAME create/no-op/overwrite shape as
# Copy-ForgeFile, except the overwrite branch's backup decision is manifest-aware instead of "always
# back up when the new payload differs". $OldHash is what THIS exact path hashed to at the end of the
# PREVIOUS install (from the old global manifest); when the file on disk still matches that, this
# installer itself is the only thing that ever touched it, and the new version can simply replace it.
# Only a hash mismatch (edited since install, or no recorded hash at all -- an unknown provenance this
# function is not in a position to guess at) still takes the normal timestamped backup. This is scoped
# to the Command Center ONLY: nobody hand-edits shipped gateway/dashboard/discord code the way they
# routinely edit project-side skills/agents, so routine upgrades no longer litter it with a
# *.forge-bak-<stamp> copy of its own previous shipped code on every single release.
function Copy-ForgeManifestAwareFile {
  param(
    [Parameter(Mandatory = $true)][string]$SourceFile,
    [Parameter(Mandatory = $true)][string]$DestFile,
    [Parameter(Mandatory = $true)][bool]$IsDryRun,
    [string]$OldHash = $null
  )
  $destDir = Split-Path -Parent -Path $DestFile

  # WP-9B-INST (Codex adversarial review, INSTALL-3 MEDIUM): see Copy-ForgeFile's identical comment --
  # a DIRECTORY (or other non-file item) at $DestFile must never fall into the "does not exist yet,
  # create it" branch below, where Copy-Item -Force would copy the source INSIDE it instead of AS it.
  if ((Test-Path -LiteralPath $DestFile) -and -not (Test-Path -LiteralPath $DestFile -PathType Leaf)) {
    if ($IsDryRun) {
      Write-ForgeLog "  [dry-run] SKIP (a directory already exists at this file's destination): $DestFile"
      return $true
    }
    Write-ForgeError "cannot write $DestFile -- a directory (or other non-file item) already exists at that exact path"
    return $false
  }

  if (-not (Test-Path -LiteralPath $DestFile -PathType Leaf)) {
    if ($IsDryRun) {
      Write-ForgeLog "  [dry-run] would create: $DestFile"
      return $true
    }
    if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
      New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    $newSrcHash = (Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash
    Copy-Item -LiteralPath $SourceFile -Destination $DestFile -Force
    if (-not (Test-Path -LiteralPath $DestFile -PathType Leaf)) {
      Write-ForgeError "copy to $DestFile did not produce a regular file (a directory may exist at that path) -- treating this as a failure"
      return $false
    }
    if ((Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash -ine $newSrcHash) {
      Write-ForgeError "copy to $DestFile did not match the source's hash after copying -- treating this as a failure"
      return $false
    }
    Write-ForgeLog "  wrote: $DestFile"
    return $true
  }

  $srcHash = (Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash
  $dstHash = (Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash
  if ($srcHash -ieq $dstHash) {
    if ($IsDryRun) { Write-ForgeLog "  [dry-run] unchanged: $DestFile" }
    return $true
  }

  $userModified = (-not $OldHash) -or ($dstHash -ine $OldHash)
  if ($IsDryRun) {
    if ($userModified) {
      Write-ForgeLog "  [dry-run] would back up + overwrite: $DestFile"
    } else {
      Write-ForgeLog "  [dry-run] would update (unchanged since install, no backup needed): $DestFile"
    }
    return $true
  }

  if ($userModified) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bakFile = "$DestFile.forge-bak-$stamp"
    Move-Item -LiteralPath $DestFile -Destination $bakFile -Force
    Write-ForgeLog "  backed up: $DestFile -> $bakFile"
  }
  Copy-Item -LiteralPath $SourceFile -Destination $DestFile -Force
  # WP-9B-INST (INSTALL-3): verify the copy actually produced a regular file matching the source's
  # hash, before ever reporting success.
  if (-not (Test-Path -LiteralPath $DestFile -PathType Leaf)) {
    Write-ForgeError "copy to $DestFile did not produce a regular file (a directory may exist at that path) -- treating this as a failure"
    return $false
  }
  if ((Get-FileHash -LiteralPath $DestFile -Algorithm SHA256).Hash -ine $srcHash) {
    Write-ForgeError "copy to $DestFile did not match the source's hash after copying -- treating this as a failure"
    return $false
  }
  Write-ForgeLog "  wrote: $DestFile"
  return $true
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

# Test-ForgePathHasReparseAncestor -- WP-9B-INST (Codex adversarial review, INSTALL-1/INSTALL-2): true
# the moment any EXISTING component of $Rel (each '\'/'/' -separated segment, including the final
# leaf), walked from $RootDir down, is itself a symlink/junction/reparse point
# (Test-ForgeReparsePoint). Copy-Item/Move-Item both follow a reparse point exactly like a real
# directory or file, so a link planted anywhere in that chain lets a write or move meant for $RootDir
# land somewhere else entirely. A component that does not exist yet is not a reparse point (nothing to
# follow yet). -IncludeRoot also checks $RootDir itself -- used by the Command Center destination-tree
# check (Copy-ForgeCommandCenterTree), where "the template root down" includes the root; the
# manifest-retirement path-safety check (Test-ForgeManifestPathIsContained) deliberately leaves
# $RootDir itself unchecked, since $RootDir there is the caller's own project/home directory, not
# something a manifest entry could ever redirect.
function Test-ForgePathHasReparseAncestor {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$Rel,
    [switch]$IncludeRoot
  )
  if ($IncludeRoot -and (Test-ForgeReparsePoint -Path $RootDir)) { return $true }
  $current = $RootDir
  foreach ($part in ($Rel -split '[\\/]')) {
    if ([string]::IsNullOrEmpty($part)) { continue }
    $current = Join-Path $current $part
    if (Test-ForgeReparsePoint -Path $current) { return $true }
  }
  return $false
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

# Test-ForgeStandingRulesMigration -- MUST run before Copy-ForgeTree ever compares/replaces the
# project's FORGE_STANDING_RULES.json (3.4 fix, WP-P3: the installer previously backed up and
# replaced this file on every upgrade with no migration at all -- see migrateOwnerStandingRules()'s
# own doc comment in forge-sync.cjs for the full v2.7.x-owner-rule-loss contract this closes). Sets
# $script:ForgeStandingMigrationSkip to $ForgeStandingRulesRel when the file must be left untouched
# THIS run (no confirmed-safe migration -- including "node is not available to check"), or $null when
# it is safe to proceed with the normal copy. $script:ForgeStandingMigrationReason (F5 fix,
# 2026-09-27 independent v2.8.1 review) is set alongside it to the REAL reason (node missing,
# forge-sync.cjs's own specific warning text -- unreadable/malformed user file, a symlink/containment
# refusal, a write failure -- or, new here, the template file itself being unreadable) instead of the
# caller assuming one fixed cause. A brand-new project (no such file yet) is always safe and never
# even shells out. -IsDryRun is passed straight through to migrateOwnerStandingRules() so a dry run
# reports the SAME outcome a real run would reach (F4 fix) without writing anything.
function Test-ForgeStandingRulesMigration {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectDir,
    [Parameter(Mandatory = $true)][string]$SourceClaudeDir,
    [bool]$IsDryRun = $false
  )
  $script:ForgeStandingMigrationSkip = $null
  $script:ForgeStandingMigrationReason = $null
  $target = Join-Path $ProjectDir (".claude\" + ($ForgeStandingRulesRel -replace '/', '\'))
  $syncTool = Join-Path $SourceClaudeDir 'forge-bin\forge-sync.cjs'

  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { return }

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd -or -not (Test-Path -LiteralPath $syncTool -PathType Leaf)) {
    $script:ForgeStandingMigrationReason = "node was not found on PATH (or forge-sync.cjs is missing), so this run could not check $ForgeStandingRulesRel for a pre-v2.8.0 owner rule at all"
    Write-ForgeLog "  $($script:ForgeStandingMigrationReason) -- leaving your existing file in place this run"
    $script:ForgeStandingMigrationSkip = $ForgeStandingRulesRel
    return
  }

  # WP-P3 (found by a real local run): `node -e $ForgeStandingMigrateJs` is UNSAFE on PowerShell 5.1 --
  # native-argument marshalling can silently strip the embedded double quotes from a JS string literal
  # that contains a space (e.g. "moved 2 owner rule(s)..." arrives at node as the bare, unquoted tokens
  # moved 2 owner, a syntax error) -- confirmed with `node -e 'console.log("hello world");'` reproducing
  # the exact same corruption. Writing the script to a real temp .js file and invoking THAT sidesteps the
  # whole native-argv quoting problem entirely; every real path still goes in purely as argv
  # (process.argv[1]/[2]/...), never interpolated into the file's text.
  $tmpJs = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-standing-migrate-" + [guid]::NewGuid().ToString('N') + '.js')
  $dryRunFlag = if ($IsDryRun) { '1' } else { '0' }
  try {
    [System.IO.File]::WriteAllText($tmpJs, $ForgeStandingMigrateJs, (New-Object System.Text.UTF8Encoding($false)))
    # $ErrorActionPreference is 'Stop' script-wide; a native tool's stderr line captured via 2>&1 can be
    # wrapped as a terminating ErrorRecord under that setting, so it is relaxed for this one call only —
    # same pattern Copy-ForgeSettingsFile's own merge-tool calls already use.
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = & node $tmpJs $syncTool $ProjectDir $ForgeStandingRulesRel $dryRunFlag 2>&1 }
    finally { $ErrorActionPreference = $prevEap }
  } finally {
    Remove-Item -LiteralPath $tmpJs -Force -ErrorAction SilentlyContinue
  }
  $code = $LASTEXITCODE
  # "$out" (not a manual join) matches the pre-existing behavior this replaces: a single captured
  # line stays a plain string, several lines are joined with PowerShell's default $OFS exactly as
  # `if ($out) { Write-ForgeLog "  $out" }` already did before this fix -- only now also kept in a
  # named variable so the same text can be reused below as the migration-skip reason.
  $outText = "$out"
  if ($outText) { Write-ForgeLog "  $outText" }

  if ($code -eq 3) {
    # F2 fix: the file EXISTS (checked above) but could not itself be read or parsed -- kept, never
    # silently treated as "nothing to migrate, safe to overwrite" the way a read/parse failure used to
    # be. Plain NL+EN words, both facts (could not be read; left untouched) in both languages, reused
    # verbatim for the immediate warning AND the final NOTE so the two never say something different.
    $script:ForgeStandingMigrationReason = "$ForgeStandingRulesRel kon niet worden gelezen of verwerkt (corrupt, vergrendeld, of een onleesbaar pad) -- het bestand blijft exact ongewijzigd / could not be read or parsed (corrupt, locked, or an unreadable path) -- left exactly as-is"
    Write-ForgeLog "  $($script:ForgeStandingMigrationReason)"
    $script:ForgeStandingMigrationSkip = $ForgeStandingRulesRel
  } elseif ($code -ne 0) {
    $script:ForgeStandingMigrationReason = if ($outText) { $outText } else { 'an owner rule from a pre-v2.8.0 install could not be confirmed migrated' }
    Write-ForgeLog "  owner rule migration for $ForgeStandingRulesRel is pending -- leaving your existing file in place this run"
    $script:ForgeStandingMigrationSkip = $ForgeStandingRulesRel
  }
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
    [string]$ManifestRoot = $null,
    # v2.8.1 (WP-P3): a single relative path (e.g. $ForgeStandingRulesRel, forward-slash form) to leave
    # COMPLETELY untouched this call -- set by Test-ForgeStandingRulesMigration above when an owner rule
    # from a pre-v2.8.0 install could not be confirmed safely migrated. Never backed up, never manifested.
    [string]$SkipRel = $null
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
    if ($SkipRel -and ($rel -replace '\\', '/') -eq $SkipRel) {
      # F4 fix (2026-09-27 independent v2.8.1 review): $SkipRel is now computed identically in a dry
      # run (Test-ForgeStandingRulesMigration already ran, read-only, before this loop -- see its own
      # header comment), so by the time we get here the real outcome is already known; this used to
      # unconditionally say "would check ... before touching it" even though the check had not (and,
      # before this fix, structurally could not) run yet, and even though a REAL run's kept-file
      # message below already says what actually happens. Mirrors that wording instead of guessing.
      if ($IsDryRun) {
        Write-ForgeLog "  [dry-run] would keep: $dest (owner rule migration pending -- see message above)"
      } else {
        Write-ForgeLog "  kept: $dest (owner rule migration pending -- see warning above)"
      }
    } elseif ($ProtectSettings -and $rel -eq 'settings.json') {
      $fileOk = Copy-ForgeSettingsFile -SourceFile $file.FullName -DestFile $dest -IsDryRun $IsDryRun -MergeToolPath $MergeToolPath
      if (-not $fileOk) { $allOk = $false }
      # never manifested: settings.json is merged, not owned — an uninstall must never delete it
    } else {
      # WP-9B-INST (INSTALL-3): Copy-ForgeFile's return value is now meaningful (it can fail -- e.g. a
      # directory sitting at $dest) and must be captured, exactly like the Copy-ForgeSettingsFile branch
      # above already does, or this call's own $allOk would stay $true no matter what Copy-ForgeFile
      # reports.
      $fileOk = Copy-ForgeFile -SourceFile $file.FullName -DestFile $dest -IsDryRun $IsDryRun
      if (-not $fileOk) { $allOk = $false }
      if (-not $IsDryRun -and $ManifestScope -and $fileOk) {
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

# Get-ForgeManifestRel -- $AbsPath relative to $RootDir, forward-slash, the SAME convention every
# manifest entry (old or new) uses. $null when $AbsPath is not actually under $RootDir. Factored out
# of Add-ForgeManifestEntry (WP-P3b) so the retirement-pruning code below can compute the identical
# relative form for an EXISTING destination file (e.g. inside Copy-ForgeManifestAwareFile) without
# duplicating this substring arithmetic a second time.
function Get-ForgeManifestRel {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$AbsPath
  )
  $rootFull = Resolve-ForgeFullPath $RootDir
  $absFull = Resolve-ForgeFullPath $AbsPath
  if ($absFull.Length -le $rootFull.Length) { return $null }
  return ($absFull.Substring($rootFull.Length).TrimStart('\', '/')) -replace '\\', '/'
}

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
  $rel = Get-ForgeManifestRel -RootDir $RootDir -AbsPath $AbsPath
  if (-not $rel) { return }
  $hash = (Get-FileHash -LiteralPath $AbsPath -Algorithm SHA256).Hash
  [void] $script:ForgeManifest[$Scope].Add([ordered]@{ path = $rel; sha256 = $hash })
}

# Test-ForgeSafeManifestRelPath -- WP-9B-INST (Codex adversarial review, INSTALL-1): true when $Rel is
# a normalized, forward-slash RELATIVE path with no drive letter, UNC, or \\?\ prefix, no leading
# slash/backslash, and no '.'/'..'/empty path components, using only characters this installer's own
# payload ever produces (verified against every path this repo actually ships under global-install\,
# .claude\ and command-center\). An install manifest is attacker-influenced input the moment its
# project is cloned or shared -- a forged ".forge-install-manifest.json" entry like
# "../../victim.txt" (with a sha256 that happens to match a REAL file outside the project) must never
# be trusted just because it parses; that hash is exactly as forgeable as the path. Lexical validation
# only -- filesystem containment/symlink checks happen separately, at the point a concrete $RootDir is
# actually about to be written to (see Test-ForgeManifestPathIsContained).
function Test-ForgeSafeManifestRelPath {
  param([string]$Rel)
  if ([string]::IsNullOrWhiteSpace($Rel)) { return $false }
  if ($Rel.IndexOf('\') -ge 0) { return $false }
  if ($Rel.StartsWith('/')) { return $false }
  if ($Rel -match '^[A-Za-z]:') { return $false }
  $parts = $Rel -split '/'
  foreach ($part in $parts) {
    if ($part.Length -eq 0) { return $false }
    if ($part -eq '.' -or $part -eq '..') { return $false }
    if ($part -notmatch '^[A-Za-z0-9._ -]+$') { return $false }
  }
  return $true
}

# Test-ForgeManifestPathIsContained -- WP-9B-INST (Codex adversarial review, INSTALL-1): filesystem-level
# defense-in-depth for a manifest-recorded relative path that already passed
# Test-ForgeSafeManifestRelPath. Even a lexically clean relative path (no "..") can still resolve
# outside $RootDir if an ANCESTOR directory component is a symlink/junction planted after the fact --
# Join-Path does not care, and Move-Item follows a reparse point exactly like a real directory. Refuses
# the moment any EXISTING component is a reparse point (Test-ForgePathHasReparseAncestor); once both
# checks hold, $RootDir\$Rel cannot resolve outside $RootDir (the lexical check rules out any '..'/
# absolute escape in the string itself, and this rules out a symlink redirecting any component of it).
function Test-ForgeManifestPathIsContained {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$Rel
  )
  if (-not (Test-ForgeSafeManifestRelPath -Rel $Rel)) { return $false }
  if (Test-ForgePathHasReparseAncestor -RootDir $RootDir -Rel $Rel) { return $false }
  return $true
}

# Get-ForgeOldManifestEntries — v2.9.0 (WP-P3b): reads a PREVIOUS install's manifest (the file this
# same run is about to overwrite via Write-ForgeManifestFile) into a plain path->sha256 hashtable, so
# the retirement-pruning step below can tell which of a prior install's files this run's payload no
# longer ships. Returns $null when the manifest does not exist (a pre-2.8.0 install, or a genuinely
# first-ever install -- either way, nothing to diff against) or cannot be read/parsed (corrupt or
# locked -- treated the same as "no prior manifest" rather than guessing at partial content: pruning
# is skipped for this scope this run, never a reason to fail the install).
function Get-ForgeOldManifestEntries {
  param([Parameter(Mandatory = $true)][string]$ManifestPath)
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $ManifestPath -Raw -ErrorAction Stop
    $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Write-ForgeLog "  could not read or parse $ManifestPath -- treating this scope as having no prior manifest to prune against this run"
    return $null
  }
  $map = @{}
  if ($parsed -and $parsed.files) {
    foreach ($f in @($parsed.files)) {
      if (-not ($f.path -and $f.sha256)) { continue }
      $p = [string]$f.path
      # WP-9B-INST (Codex adversarial review, INSTALL-1 HIGH): reject a manifest entry whose path is
      # not a normal, safe relative path BEFORE it is ever hashed or moved. Skipped with a plain
      # warning; this never aborts the install, it only means this ONE entry is not considered for
      # retirement-pruning this run.
      if (-not (Test-ForgeSafeManifestRelPath -Rel $p)) {
        Write-ForgeLog "  ignoring unsafe path in $ManifestPath -- '$p' is not a normal relative path"
        continue
      }
      $map[$p] = [string]$f.sha256
    }
  }
  return $map
}

# Get-ForgeNormalizedSha256 -- sha256 of $Path's bytes after normalizing CRLF -> LF (a lone CR or LF
# is left untouched). Used ONLY by the pre-2.8.0 (no-manifest) legacy dashboard fallback below, so a
# Windows checkout/extraction that turned a shipped LF file into CRLF still matches the historical
# hash recorded from the original (LF) git blob. Bytes are round-tripped through the Latin-1/ISO-8859-1
# codepage, which maps every byte value 0-255 to exactly one character and back losslessly -- unlike
# UTF-8, it can never throw or silently substitute on content that is not valid UTF-8, so this is safe
# for arbitrary file bytes, not just clean ASCII text.
function Get-ForgeNormalizedSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $latin1 = [System.Text.Encoding]::GetEncoding('ISO-8859-1')
  $normalized = $latin1.GetBytes(($latin1.GetString($bytes) -replace "`r`n", "`n"))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha.ComputeHash($normalized)
  } finally {
    $sha.Dispose()
  }
  return (($hashBytes | ForEach-Object { $_.ToString('x2') }) -join '')
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
  $removed = 0; $kept = 0; $missing = 0; $rejected = 0
  $touchedDirs = New-Object 'System.Collections.Generic.List[string]'
  foreach ($e in $Entries) {
    $rel = [string]$e.path
    # WP-9B-INST (Codex adversarial review, INSTALL-1 HIGH -- same untrusted-manifest-path class,
    # reachable here via -Uninstall on a forged/shared project's own manifest): never trust a manifest
    # path enough to hash-then-delete it without the same safety check the retirement-pruning path
    # (Remove-ForgeRetiredManifestFiles) already applies. Rejected with a plain line, never an error
    # that aborts the uninstall.
    if (-not (Test-ForgeManifestPathIsContained -RootDir $RootDir -Rel $rel)) {
      Write-ForgeLog "  skipped (unsafe path in the install manifest, refusing to trust it): $rel"
      $rejected++
      continue
    }
    $relWin = ($rel -replace '/', '\')
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
  return [ordered]@{ removed = $removed; kept = $kept; missing = $missing; rejected = $rejected }
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

# ---------------------------------------------------------------------------
# Retirement pruning (v2.9.0, WP-P3b) -- files a NEWER version stops shipping, removed on the very
# INSTALL/upgrade that stops shipping them, not just on -Uninstall. Before this, install.ps1 only ever
# ADDED files: a version that removed a file from the payload left the old copy on disk forever,
# because the fresh manifest this run writes simply never mentions a path it did not just copy -- the
# OLD manifest (still on disk at this point, not yet overwritten by Write-ForgeManifestFile) is the
# only place that "used to ship, not anymore" information still exists.
#
# Three independent pieces, matched to the three states a real install can be in:
#   1. Remove-ForgeRetiredManifestFiles   -- a 2.8.0+ install: diff the OLD manifest against what THIS
#      run just (re)recorded for the same scope; a path only on the OLD side is retired.
#   2. Remove-ForgeRetiredLegacyDashboardFiles -- a pre-2.8.0 install (no manifest at all): the ONE
#      concrete case this release needs to migrate is .claude\forge-dashboard\{7 files} -- matched by
#      a small embedded table of every historical shipped content hash (never by trusting the path
#      alone), so a same-named file the installer itself never shipped is left alone.
#   3. Remove-ForgeLegacyDashboardStateFiles -- PORT/DASHBOARD_STATE.json are runtime state the OLD
#      dashboard SERVER wrote (never something Copy-ForgeTree copied), so they never appear in ANY
#      manifest and need this one unconditional, always-run step instead.
# All three MOVE (never delete) into a dated backup folder, preserving the relative path, exactly like
# the rest of this installer's "never destroy, always back up" discipline for anything that might be
# the user's own data.
# ---------------------------------------------------------------------------

# Move-ForgeFileToBackup -- moves $AbsPath (known to exist) to $BackupDir\<the same path relative to
# $RootDir>, creating the backup's parent directory first. Shared by all three retirement-pruning
# functions below so "how a retired file is archived" is defined exactly once.
function Move-ForgeFileToBackup {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$AbsPath,
    [Parameter(Mandatory = $true)][string]$BackupDir
  )
  $rel = Get-ForgeManifestRel -RootDir $RootDir -AbsPath $AbsPath
  if (-not $rel) { $rel = Split-Path -Leaf $AbsPath }
  $backupAbs = Join-Path $BackupDir ($rel -replace '/', '\')
  $backupParent = Split-Path -Parent $backupAbs
  if (-not (Test-Path -LiteralPath $backupParent -PathType Container)) {
    New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
  }
  Move-Item -LiteralPath $AbsPath -Destination $backupAbs -Force
  return $backupAbs
}

# Remove-ForgeRetiredManifestFiles -- point 1 (2.8.0+ installs). $OldEntries (path -> sha256, from
# Get-ForgeOldManifestEntries, or $null) is diffed against $NewRelSet (every path THIS run's copy step
# just recorded for the same scope, see $script:ForgeManifest). A path present only on the OLD side is
# no longer shipped; it is moved to $BackupDir ONLY when its CURRENT hash still matches what was
# recorded (unmodified since Forge itself wrote it) -- a file you edited yourself differs and is kept,
# reported in one plain line, exactly like Remove-ForgeManifestFiles already reports a kept file on
# -Uninstall.
function Remove-ForgeRetiredManifestFiles {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [hashtable]$OldEntries,
    [Parameter(Mandatory = $true)]$NewRelSet,
    [Parameter(Mandatory = $true)][string]$BackupDir,
    [bool]$IsDryRun = $false
  )
  $result = [ordered]@{ retired = 0; kept = 0; missing = 0; rejected = 0 }
  if (-not $OldEntries -or $OldEntries.Count -eq 0) { return $result }
  $touchedDirs = New-Object 'System.Collections.Generic.List[string]'
  foreach ($rel in @($OldEntries.Keys | Sort-Object)) {
    if ($NewRelSet.Contains($rel)) { continue }
    # WP-9B-INST (Codex adversarial review, INSTALL-1 HIGH): re-validated here, right before this old
    # manifest path is ever joined to $RootDir, hashed, or moved -- Get-ForgeOldManifestEntries already
    # dropped anything with an unsafe SHAPE, but only a live filesystem check (from $RootDir, one
    # ancestor at a time) can catch a legitimately-shaped relative path that a symlink/junction planted
    # somewhere under $RootDir would otherwise redirect outside it.
    if (-not (Test-ForgeManifestPathIsContained -RootDir $RootDir -Rel $rel)) {
      Write-ForgeLog "  skipped (this old manifest path does not safely resolve inside $RootDir): $rel"
      $result.rejected++
      continue
    }
    $abs = Join-Path $RootDir ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { $result.missing++; continue }
    $curHash = (Get-FileHash -LiteralPath $abs -Algorithm SHA256).Hash
    if ($curHash -ieq $OldEntries[$rel]) {
      if ($IsDryRun) {
        $backupAbs = Join-Path $BackupDir ($rel -replace '/', '\')
        Write-ForgeLog "  [dry-run] would retire (no longer shipped by this version): $abs -> $backupAbs"
      } else {
        $backupAbs = Move-ForgeFileToBackup -RootDir $RootDir -AbsPath $abs -BackupDir $BackupDir
        Write-ForgeLog "  retired (no longer shipped by this version): $abs -> $backupAbs"
        [void] $touchedDirs.Add((Split-Path -Parent $abs))
      }
      $result.retired++
    } else {
      Write-ForgeLog "  kept (you edited this file, no longer shipped by this version): $abs"
      $result.kept++
    }
  }
  if (-not $IsDryRun) {
    foreach ($d in @($touchedDirs | Select-Object -Unique)) {
      Remove-ForgeEmptyDirs -StartDir $d -StopAt $RootDir
    }
  }
  return $result
}

# Get-ForgeRetiredDashboardHashTable -- parses the shipped forge-retired-dashboard-hashes.tsv
# (path<TAB>sha256 per line, '#'-prefixed comments skipped) into path -> string[] of known hashes.
# Recomputed straight from this repo's git history by
# tests\installer\assert-retired-dashboard-hashes.js, so the two can never silently drift apart.
function Get-ForgeRetiredDashboardHashTable {
  param([Parameter(Mandatory = $true)][string]$HashTablePath)
  $map = @{}
  if (-not (Test-Path -LiteralPath $HashTablePath -PathType Leaf)) { return $map }
  foreach ($line in (Get-Content -LiteralPath $HashTablePath -ErrorAction SilentlyContinue)) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    $parts = $line -split "`t"
    if ($parts.Count -lt 2) { continue }
    $p = $parts[0].Trim()
    $h = $parts[1].Trim().ToLowerInvariant()
    if (-not $p -or -not $h) { continue }
    if (-not $map.ContainsKey($p)) { $map[$p] = New-Object 'System.Collections.Generic.List[string]' }
    [void] $map[$p].Add($h)
  }
  return $map
}

# Remove-ForgeRetiredLegacyDashboardFiles -- point 2 (pre-2.8.0, no-manifest installs). Removes EXACTLY
# the paths listed in $HashTablePath (the 7 retired dashboard files, never anything else) when the
# file's CRLF-normalized sha256 matches one of that path's known historical shipped hashes. Content
# that matches none of them is left in place -- it might be your own file at that same path, and this
# function's job is migrating known Forge history, not guessing at unknown content.
function Remove-ForgeRetiredLegacyDashboardFiles {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$HashTablePath,
    [Parameter(Mandatory = $true)][string]$BackupDir,
    [bool]$IsDryRun = $false
  )
  $result = [ordered]@{ retired = 0; kept = 0 }
  $known = Get-ForgeRetiredDashboardHashTable -HashTablePath $HashTablePath
  $touchedDirs = New-Object 'System.Collections.Generic.List[string]'
  foreach ($rel in @($known.Keys | Sort-Object)) {
    $abs = Join-Path $RootDir ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { continue }
    $curHash = Get-ForgeNormalizedSha256 -Path $abs
    if ($known[$rel] -contains $curHash) {
      if ($IsDryRun) {
        $backupAbs = Join-Path $BackupDir ($rel -replace '/', '\')
        Write-ForgeLog "  [dry-run] would retire (pre-2.8.0 install, known shipped content): $abs -> $backupAbs"
      } else {
        $backupAbs = Move-ForgeFileToBackup -RootDir $RootDir -AbsPath $abs -BackupDir $BackupDir
        Write-ForgeLog "  retired (pre-2.8.0 install, known shipped content): $abs -> $backupAbs"
        [void] $touchedDirs.Add((Split-Path -Parent $abs))
      }
      $result.retired++
    } else {
      Write-ForgeLog "  kept (content does not match a known shipped version -- may be your own file): $abs"
      $result.kept++
    }
  }
  if (-not $IsDryRun) {
    foreach ($d in @($touchedDirs | Select-Object -Unique)) {
      Remove-ForgeEmptyDirs -StartDir $d -StopAt $RootDir
    }
  }
  return $result
}

# Remove-ForgeLegacyDashboardStateFiles -- point 2's other half: PORT and DASHBOARD_STATE.json are
# runtime state the retired dashboard SERVER wrote while running, never a file Copy-ForgeTree itself
# copied -- so they never have a manifest entry (old or new) to diff against, and always need
# checking, independent of whether a manifest exists for this project at all. Unconditional (no hash
# check): both are pure generated state (see templates\gitignore.snippet, which already ignores them
# for exactly that reason), never something worth asking "did the user edit this" about.
function Remove-ForgeLegacyDashboardStateFiles {
  param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$BackupDir,
    [bool]$IsDryRun = $false
  )
  $retired = 0
  foreach ($rel in @('.claude/forge-dashboard/PORT', '.claude/forge-dashboard/DASHBOARD_STATE.json')) {
    $abs = Join-Path $RootDir ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { continue }
    if ($IsDryRun) {
      $backupAbs = Join-Path $BackupDir ($rel -replace '/', '\')
      Write-ForgeLog "  [dry-run] would retire (generated runtime state, not user data): $abs -> $backupAbs"
    } else {
      $backupAbs = Move-ForgeFileToBackup -RootDir $RootDir -AbsPath $abs -BackupDir $BackupDir
      Write-ForgeLog "  retired (generated runtime state, not user data): $abs -> $backupAbs"
      Remove-ForgeEmptyDirs -StartDir (Split-Path -Parent $abs) -StopAt $RootDir
    }
    $retired++
  }
  return $retired
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
# DENY-RULES-STAY (security review, WP-S12 in parallel): NEVER pass --remove-deny. `unmerge`
# cannot tell a user's own pre-existing permissions.deny rule (e.g. a Read(./.env) they had
# before installing Forge) from Forge's identical template rule, so removing deny rules on
# uninstall could silently drop a user's own secret protection. Forge's deny rules (.env, keys)
# are harmless to leave behind, so they are kept by default -- only its hooks are unmerged.
# --project-root is passed so the tool's own containment checks apply here exactly as they do
# for `apply` in Copy-ForgeSettingsFile above.
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
  $targetDir = Split-Path -Parent $TargetSettings
  $mergeTool = Join-Path (Split-Path -Parent $targetDir) '.claude\forge-bin\forge-settings-merge.cjs'
  if (-not (Test-Path -LiteralPath $mergeTool -PathType Leaf)) {
    Write-ForgeLog "  kept:  $TargetSettings unmerged -- forge-settings-merge.cjs is not on disk here; left untouched"
    return
  }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Write-ForgeLog "  kept:  $TargetSettings unmerged -- node is not on PATH; left untouched"
    return
  }
  $cliArgs = @('unmerge', '--target', $TargetSettings, '--source', $SourceSettings, '--project-root', $targetDir)
  if ($IsDryRun) { $cliArgs += '--dry-run' }
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & node $mergeTool @cliArgs 2>&1 }
  finally { $ErrorActionPreference = $prevEap }
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    Write-ForgeLog "  $out"
    Write-ForgeLog "  Forge's hooks were removed from settings.json; its read-protection rules for secrets (.env, keys) were left in place on purpose -- they are harmless and protect you"
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

# Update-ForgeProjectsRegistry -- see $ForgeProjectsRegistryJs's own header comment for the full
# contract. -ProjectDirFull must already be a fully-resolved absolute path (Resolve-ForgeFullPath) --
# this function never resolves it itself, so a not-yet-existing project directory (GetFullPath works
# without the target existing) is recorded correctly too. A missing `node` is never a hard failure:
# one plain log line, then Main/Invoke-ForgeUninstall continue exactly as if this call had not been
# made.
function Update-ForgeProjectsRegistry {
  param(
    [Parameter(Mandatory = $true)][string] $ProjectDirFull,
    [Parameter(Mandatory = $true)][string] $ForgeHome,
    [bool] $IsDryRun = $false,
    [ValidateSet('add', 'remove')][string] $Action = 'add'
  )
  $registryPath = Join-Path $ForgeHome '.claude\forge\projects.json'
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Write-ForgeLog "  node was not found on PATH -- could not update $registryPath (the Command Center dashboard may not auto-discover this project); this does not affect the rest of the install"
    return
  }
  $tmpJs = Join-Path ([System.IO.Path]::GetTempPath()) ("forge-projects-registry-" + [guid]::NewGuid().ToString('N') + '.js')
  $dryRunFlag = if ($IsDryRun) { '1' } else { '0' }
  try {
    [System.IO.File]::WriteAllText($tmpJs, $ForgeProjectsRegistryJs, (New-Object System.Text.UTF8Encoding($false)))
    # $ErrorActionPreference is 'Stop' script-wide; relaxed for this one call so a non-zero exit
    # (3 = malformed existing file, 2 = other error) is read back via $LASTEXITCODE instead of
    # aborting the whole installer -- same pattern Test-ForgeStandingRulesMigration already uses.
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = & node $tmpJs $registryPath $ProjectDirFull $dryRunFlag $Action 2>&1 }
    finally { $ErrorActionPreference = $prevEap }
  } finally {
    Remove-Item -LiteralPath $tmpJs -Force -ErrorAction SilentlyContinue
  }
  $outText = "$out"
  if ($outText) { Write-ForgeLog "  $outText" }
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3) {
    Write-ForgeError "could not update $registryPath -- this does not affect the rest of the install"
  }
}

# Test-ForgeCommandCenterSkip -- true when $RelPath (forward-slash, relative to command-center\)
# must NEVER be shipped into a fresh install or clobbered on a re-install: node_modules/build
# output, coverage/test artefacts, and per-user runtime data/secrets. Everything else (including
# dashboard/dist, the prebuilt SPA) is copied normally. Mirrors forge_cc_should_skip in install.sh --
# keep both in sync.
#
# Beyond the exact list WP-P3 named (node_modules, .data, .claude-flow, discord/.env, discord/
# transcripts/, *.log, dashboard/test-results|playwright-report|reports/, coverage/), this also
# skips two things flagged in the WP-P3 report rather than silently added:
#   - discord/state/  -- the documented STATE_DIR default (command-center\discord\.gitignore treats
#     it identically to transcripts/); the gateway always overrides STATE_DIR to its own
#     .data\discord\state\ when it spawns the bot, so this only matters for a standalone dev run.
#   - any *.env file besides *.env.example -- generalizes the named "discord/.env" rule to the exact
#     secret-file convention command-center\dashboard\.gitignore already documents for its own .env.
function Test-ForgeCommandCenterSkip {
  param([Parameter(Mandatory = $true)][string] $RelPath)
  foreach ($seg in ($RelPath -split '/')) {
    if ($seg -eq 'node_modules' -or $seg -eq '.data' -or $seg -eq '.claude-flow' -or $seg -eq 'coverage') {
      return $true
    }
  }
  if ($RelPath -eq 'discord/.env') { return $true }
  if ($RelPath -match '^discord/transcripts(/|$)') { return $true }
  if ($RelPath -match '^discord/state(/|$)') { return $true }
  if ($RelPath -match '^dashboard/test-results(/|$)') { return $true }
  if ($RelPath -match '^dashboard/playwright-report(/|$)') { return $true }
  if ($RelPath -match '^dashboard/reports(/|$)') { return $true }
  if ($RelPath -like '*.log') { return $true }
  $base = ($RelPath -split '/')[-1]
  if ($base -eq '.env.example') { return $false }
  if ($base -eq '.env' -or $base -eq '.env.local' -or $base -eq '.env.forge-setup') { return $true }
  if ($base -like '.env.*.local' -or $base -like '.env.tmp-*') { return $true }
  return $false
}

# Copy-ForgeCommandCenterTree -- like Copy-ForgeTree, but walks $SourceDir (command-center\)
# skipping every Test-ForgeCommandCenterSkip match instead of copying everything; the Command
# Center ships no settings.json of its own, so this never needs -ProtectSettings. Every copied file
# is manifested exactly like the canonical template's own files (global scope, root $ManifestRoot),
# so an uninstall removes it automatically through the SAME manifest-driven path
# Remove-ForgeManifestFiles already runs -- a skipped (runtime/build) path is never even considered,
# so it can never be deleted OR overwritten by a later install/uninstall.
function Copy-ForgeCommandCenterTree {
  param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$DestDir,
    [Parameter(Mandatory = $true)][bool]$IsDryRun,
    [string]$ManifestRoot = $null,
    # v2.9.0 (WP-P3b, point 3): path(rel to $ManifestRoot) -> sha256 from the PREVIOUS install's global
    # manifest (Get-ForgeOldManifestEntries), or $null when there is none. When supplied, an existing
    # destination file that still matches its previously-recorded hash is replaced without a
    # *.forge-bak-<stamp> copy -- see Copy-ForgeManifestAwareFile's own header comment.
    [hashtable]$OldHashByRel = $null
  )
  if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
    Write-ForgeError "source directory missing: $SourceDir"
    return $false
  }
  $files = Get-ChildItem -LiteralPath $SourceDir -Recurse -File -Force

  # WP-9B-INST (Codex adversarial review, INSTALL-2 HIGH): a symlink/junction planted anywhere under
  # the live Command Center destination tree (e.g. $DestDir\gateway pointing outside the template)
  # would otherwise be followed transparently by Copy-Item/Move-Item -- both treat a reparse point
  # exactly like a real directory. Validate the FULL destination tree's ancestry, for every file this
  # run would touch, BEFORE copying anything; the moment one is unsafe, the whole Command Center
  # install for this run is skipped (never partially copied), with a clear message telling the owner to
  # remove the link themselves. This never aborts the rest of the installer -- exactly like a missing
  # command-center\ source directory above is not fatal either.
  foreach ($file in $files) {
    $rel = ($file.FullName.Substring($SourceDir.Length).TrimStart('\', '/')) -replace '\\', '/'
    if (Test-ForgeCommandCenterSkip -RelPath $rel) { continue }
    if (Test-ForgePathHasReparseAncestor -RootDir $DestDir -Rel $rel -IncludeRoot) {
      # WP-9B-INST follow-up (found by self-review, not by tracing the finding alone -- confirmed by a
      # real local run of the new command-center-symlink test below): refusing here BEFORE this run
      # records anything for the Command Center means $script:ForgeManifest['global'] ends this run
      # with NO Command Center paths at all -- the retirement-pruning step that runs right after this
      # call (Remove-ForgeRetiredManifestFiles, back in Main) would then see every path the OLD global
      # manifest already listed under this Command Center as "no longer shipped this run" and MOVE each
      # one to backup, even though every real file is still sitting there untouched. Carrying every OLD
      # entry under this Command Center's own manifest prefix forward into THIS run's manifest (with
      # its unchanged hash -- the file itself was never touched) tells that step "still shipped, leave
      # it alone" instead, without pretending a copy that did not happen actually happened.
      if ($ManifestRoot -and $OldHashByRel -and $OldHashByRel.Count -gt 0) {
        $ccPrefix = Get-ForgeManifestRel -RootDir $ManifestRoot -AbsPath $DestDir
        if ($ccPrefix) {
          $ccPrefixSlash = $ccPrefix.TrimEnd('/') + '/'
          foreach ($oldRel in @($OldHashByRel.Keys)) {
            if ($oldRel.StartsWith($ccPrefixSlash, [System.StringComparison]::OrdinalIgnoreCase)) {
              [void] $script:ForgeManifest['global'].Add([ordered]@{ path = $oldRel; sha256 = $OldHashByRel[$oldRel] })
            }
          }
        }
      }
      Write-ForgeError "refusing to install the Command Center: a symlink or junction was found on the way to '$rel' under $DestDir -- remove that link, then re-run the installer"
      return $false
    }
  }

  $skipped = 0
  $allOk = $true
  foreach ($file in $files) {
    $rel = ($file.FullName.Substring($SourceDir.Length).TrimStart('\', '/')) -replace '\\', '/'
    if (Test-ForgeCommandCenterSkip -RelPath $rel) { $skipped++; continue }
    $dest = Join-Path -Path $DestDir -ChildPath ($rel -replace '/', '\')
    if ($OldHashByRel -and $ManifestRoot) {
      $manifestRel = Get-ForgeManifestRel -RootDir $ManifestRoot -AbsPath $dest
      $oldHash = if ($manifestRel -and $OldHashByRel.ContainsKey($manifestRel)) { $OldHashByRel[$manifestRel] } else { $null }
      $fileOk = Copy-ForgeManifestAwareFile -SourceFile $file.FullName -DestFile $dest -IsDryRun $IsDryRun -OldHash $oldHash
    } else {
      $fileOk = Copy-ForgeFile -SourceFile $file.FullName -DestFile $dest -IsDryRun $IsDryRun
    }
    # WP-9B-INST (INSTALL-3): captured and folded into this call's own return value, exactly like
    # Copy-ForgeTree already does for its own per-file copy calls.
    if (-not $fileOk) { $allOk = $false }
    if (-not $IsDryRun -and $ManifestRoot -and $fileOk) {
      Add-ForgeManifestEntry -Scope 'global' -RootDir $ManifestRoot -AbsPath $dest
    }
  }
  Write-ForgeLog "  (Command Center: skipped $skipped runtime/build file(s) -- node_modules, .data, logs, and similar)"
  return $allOk
}

function Main {
  # F2b fix: trimmed once here (see ConvertTo-ForgeCleanProjectPath's own comment) so every later use
  # of $projectDir -- including every node argument -- already has the clean value. (A raw variable is
  # resolved first and passed by name -- `ConvertTo-ForgeCleanProjectPath (if (...) {...} else {...})`
  # parses but does not work: PowerShell's command-argument parsing tries to run `if` itself as an
  # external command there and silently passes an empty string, found by a real local run.)
  $rawProjectDir = if ($ProjectDir) { $ProjectDir } else { (Get-Location).Path }
  $projectDir = ConvertTo-ForgeCleanProjectPath $rawProjectDir
  # v2.9.0 (WP-P3 addition): a fully-resolved absolute form of $projectDir, for the ONE thing that
  # genuinely needs it -- the projects registry (Update-ForgeProjectsRegistry) records a real,
  # absolute path the Command Center dashboard can use directly as a filesystem root. GetFullPath
  # resolves relative segments against the current directory WITHOUT requiring the target to exist
  # yet, so this stays correct even on a brand-new -ProjectDir the copy step has not created yet.
  $projectDirFull = Resolve-ForgeFullPath $projectDir
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

  # v2.9.0 (WP-P3b): snapshot the PREVIOUS install's manifest(s) now, before Write-ForgeManifestFile
  # overwrites either file further down -- see Get-ForgeOldManifestEntries's own header comment. Read
  # unconditionally (even for a -GlobalOnly/-ProjectOnly run touching only one scope, and even under
  # -DryRun) -- it is a pure read, and the retirement-pruning calls below already gate on $doGlobal/
  # $doProject themselves. One shared timestamp for both scopes' backup folders, so a single run never
  # produces two differently-stamped "retired-*" folders.
  $oldGlobalEntries = Get-ForgeOldManifestEntries -ManifestPath (Join-Path $forgeHome '.claude\forge\install-manifest.json')
  $oldProjectEntries = Get-ForgeOldManifestEntries -ManifestPath (Join-Path $projectDir '.claude\.forge-install-manifest.json')
  $pruneStamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')

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
    # v2.9.0 (WP-P3): the Command Center (local dashboard + gateway) is installed ONCE, centrally,
    # next to the canonical template -- never per-project -- so every project shares the same
    # dashboard at http://127.0.0.1:4100.
    if ($doGlobal) { Write-ForgeLog "  - $forgeHome\.claude\forge\template\command-center   [OUTSIDE this project -- global] (Command Center: the local dashboard + gateway at http://127.0.0.1:4100)" }
    if ($doProject) { Write-ForgeLog "  - $projectDir\.claude           (per-project payload: skills, agents, dashboard, config)" }
    if ($doProject) { Write-ForgeLog "  - $projectDir\CLAUDE.md         (only if missing) and $projectDir\.gitignore (Forge lines appended)" }
    if ($doProject) { Write-ForgeLog "  - $forgeHome\.claude\forge\projects.json   [OUTSIDE this project -- global] (records this project's path so the Command Center dashboard can find it)" }
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
    # v2.8.1 (WP-P3): set by Test-ForgeStandingRulesMigration below (same `$script:` reason as above).
    $script:ForgeStandingMigrationSkip = $null

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

      # v2.9.0 (WP-P3): the Command Center (command-center\gateway + command-center\discord +
      # command-center\dashboard) is installed ONCE, centrally, next to the canonical template --
      # never per-project (see Test-ForgeCommandCenterSkip/Copy-ForgeCommandCenterTree's own header
      # comments for exactly what is skipped and why). A source checkout without a
      # command-center\ directory at all (an old release, or a stripped-down archive) is not an
      # error -- this installer's own job is copying whatever the payload actually ships.
      $ccSourceDir = Join-Path $sourceDir 'command-center'
      if (Test-Path -LiteralPath $ccSourceDir -PathType Container) {
        $ccDestDir = Join-Path $templateDir 'command-center'
        Write-ForgeLog ''
        Write-ForgeLog "Installing Command Center -> $ccDestDir (local dashboard + gateway, http://127.0.0.1:4100)"
        # Requirement 1 (WP-P3): dashboard\dist is the PREBUILT dashboard the gateway serves as
        # static files. When this download does not ship it (an older archive, or a stripped release
        # before the dashboard build step is wired in), this says so ONCE, plainly -- it never tells
        # a beginner to run a build command themselves; everything else in the Command Center still
        # installs normally.
        if (-not (Test-Path -LiteralPath (Join-Path $ccSourceDir 'dashboard\dist') -PathType Container)) {
          Write-ForgeLog '  NOTE: command-center\dashboard\dist is missing from this download -- the dashboard''s built files were not included. Everything else in the Command Center was still installed; the dashboard page itself will not load until a build that includes dashboard\dist is installed.'
        }
        $ccOk = Copy-ForgeCommandCenterTree -SourceDir $ccSourceDir -DestDir $ccDestDir -IsDryRun $isDryRun -ManifestRoot $forgeHome -OldHashByRel $oldGlobalEntries
        if (-not $ccOk) {
          Write-ForgeError 'Command Center copy had failures (project installs still work; the dashboard may not start correctly)'
          $globalOk = $false
        }
      }

      # v2.9.0 (WP-P3b): retirement pruning for the 'global' scope -- runs AFTER every global copy
      # above, so $script:ForgeManifest['global'] already holds every path this run really shipped
      # (core + template + Command Center, all one scope, all rooted at $forgeHome), and BEFORE
      # Write-ForgeManifestFile overwrites the manifest this read $oldGlobalEntries from.
      $globalBackupDir = Join-Path $forgeHome ".claude\forge\backups\retired-$pruneStamp"
      if ($oldGlobalEntries) {
        $newGlobalRelSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($e in $script:ForgeManifest['global']) { [void] $newGlobalRelSet.Add([string]$e.path) }
        $null = Remove-ForgeRetiredManifestFiles -RootDir $forgeHome -OldEntries $oldGlobalEntries -NewRelSet $newGlobalRelSet -BackupDir $globalBackupDir -IsDryRun $isDryRun
      } elseif ($templateDir) {
        # Pre-2.8.0 global install (no manifest at all yet): the one concrete migration this release
        # needs is the canonical template's own copy of the retired dashboard files. Backed up under
        # the SAME relative path a 2.8.0+ manifest would have recorded it at (".claude\forge\template\...")
        # so a legacy and a manifest-driven retirement land in a consistent shape under
        # $globalBackupDir, even though this fallback never reads/writes a manifest itself.
        $legacyHashTable = Join-Path $sourceDir '.claude\forge-bin\forge-retired-dashboard-hashes.tsv'
        $templateBackupDir = Join-Path $globalBackupDir '.claude\forge\template'
        $null = Remove-ForgeRetiredLegacyDashboardFiles -RootDir $templateDir -HashTablePath $legacyHashTable -BackupDir $templateBackupDir -IsDryRun $isDryRun
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
      # 3.4 fix (WP-P3): move any v2.7-era owner standing rule into the project's own user file BEFORE
      # FORGE_STANDING_RULES.json is ever compared/replaced below -- the same preflight forge-sync.cjs
      # itself runs before its own writes.
      # F4 fix (2026-09-27 independent v2.8.1 review): this used to skip the real check entirely under
      # -DryRun (setting $script:ForgeStandingMigrationSkip = $null unconditionally and printing a
      # generic "would check" line that could never actually reflect the outcome), so a dry run always
      # reported "would back up + overwrite" even for a rules file a real run would keep. The check
      # itself is a true read-only operation all the way through in dry-run mode (see its own header
      # comment and migrateOwnerStandingRules()'s dryRun option in forge-sync.cjs) -- it is now always
      # run, with -IsDryRun passed straight through, so -DryRun previews the exact same outcome a real
      # run would reach and never writes anything either way.
      Test-ForgeStandingRulesMigration -ProjectDir $projectDir -SourceClaudeDir (Join-Path $sourceDir '.claude') -IsDryRun $isDryRun
      $projectOk = Copy-ForgeTree -SourceDir (Join-Path $sourceDir '.claude') -DestDir (Join-Path $projectDir '.claude') -IsDryRun $isDryRun -ProtectSettings $true -MergeToolPath (Join-Path $sourceDir '.claude\forge-bin\forge-settings-merge.cjs') -ManifestScope 'project' -ManifestRoot $projectDir -SkipRel $script:ForgeStandingMigrationSkip
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
      # v2.9.0 (WP-P3, coordinator follow-up): record this project so the Command Center dashboard
      # can find it even outside its default scan roots (Documents/Desktop/its own parent folder).
      # See $ForgeProjectsRegistryJs's own header comment for the file contract and why a missing
      # `node` only warns, never fails the install.
      Update-ForgeProjectsRegistry -ProjectDirFull $projectDirFull -ForgeHome $forgeHome -IsDryRun $isDryRun -Action 'add'

      # v2.9.0 (WP-P3b): retirement pruning for the 'project' scope -- same shape as the 'global'
      # block above, rooted at $projectDir. Runs AFTER the project copy, so $script:ForgeManifest
      # ['project'] already holds every path this run really shipped, and BEFORE Write-ForgeManifestFile
      # overwrites the manifest this read $oldProjectEntries from.
      $projectBackupDir = Join-Path $projectDir ".claude\forge-backups\retired-$pruneStamp"
      if ($oldProjectEntries) {
        $newProjectRelSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($e in $script:ForgeManifest['project']) { [void] $newProjectRelSet.Add([string]$e.path) }
        # BUG (found by self-review, not by the test suite): $script:ForgeStandingMigrationSkip (e.g.
        # FORGE_STANDING_RULES.json with a pending owner-rule migration) is deliberately left
        # completely untouched by Copy-ForgeTree this run -- neither copied NOR manifested. Without
        # this line it would still be a KEY in $oldProjectEntries but absent from $newProjectRelSet,
        # making it look exactly like "the new version no longer ships this file" and moving it to
        # backup -- the opposite of "leave my existing file in place this run". PATH-PREFIX TRAP
        # (found immediately after, by re-deriving this same value independently rather than trusting
        # the first pass): $script:ForgeStandingMigrationSkip is relative to .claude\ itself (that is
        # what Copy-ForgeTree's own per-file loop compares it against), but every manifest path
        # (old and new alike) is relative to the PROJECT ROOT -- ".claude/" has to be prepended here
        # or this exemption silently never matches anything at all.
        if ($script:ForgeStandingMigrationSkip) { [void] $newProjectRelSet.Add('.claude/' + $script:ForgeStandingMigrationSkip) }
        $null = Remove-ForgeRetiredManifestFiles -RootDir $projectDir -OldEntries $oldProjectEntries -NewRelSet $newProjectRelSet -BackupDir $projectBackupDir -IsDryRun $isDryRun
      } else {
        # Pre-2.8.0 project install (no manifest at all yet): migrate the retired dashboard files by
        # their known historical content hash instead.
        $legacyHashTable = Join-Path $sourceDir '.claude\forge-bin\forge-retired-dashboard-hashes.tsv'
        $null = Remove-ForgeRetiredLegacyDashboardFiles -RootDir $projectDir -HashTablePath $legacyHashTable -BackupDir $projectBackupDir -IsDryRun $isDryRun
      }
      # Unconditional either way (point 2's other half): PORT/DASHBOARD_STATE.json are runtime state
      # the OLD dashboard SERVER wrote, never something any manifest (old or new) ever recorded.
      $null = Remove-ForgeLegacyDashboardStateFiles -RootDir $projectDir -BackupDir $projectBackupDir -IsDryRun $isDryRun
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

    # F5 fix (2026-09-27 independent v2.8.1 review): this used to always say "fix the JSON in ...
    # user.json", even when $script:ForgeStandingMigrationSkip was set for a completely different
    # reason (node missing, a symlink/containment refusal, a write failure, or, after F2, the template
    # file itself being unreadable). $script:ForgeStandingMigrationReason is set by
    # Test-ForgeStandingRulesMigration to the real cause every time it sets Skip; this note now names
    # that cause instead of guessing one.
    if ($script:ForgeStandingMigrationSkip) {
      Write-ForgeLog ''
      $reason = if ($script:ForgeStandingMigrationReason) { $script:ForgeStandingMigrationReason } else { 'an owner rule from a pre-v2.8.0 install is pending migration' }
      Write-ForgeLog "NOTE: $projectDir\.claude\$($ForgeStandingRulesRel -replace '/', '\') was left as-is this run -- $reason. Re-run install once that is fixed so it can be applied safely."
    }

    Write-ForgeLog ''
    Write-ForgeLog "claude-forge $forgeVersion installed successfully."
    Write-ForgeLog ''
    Write-ForgeLog 'Next steps:'
    Write-ForgeLog "  cd `"$projectDir`"; claude"
    Write-ForgeLog '  /setup-forge'
    Write-ForgeLog '  /forge <task>'
    Write-ForgeLog ''
    # Requirement 5 (WP-P3): one plain line telling a beginner how to open the dashboard this
    # install just set up. Only printed when this run actually installed/ensured the Command Center
    # ($doGlobal) -- a -ProjectOnly run against a machine that never ran a full install would
    # otherwise point at a dashboard that is not there yet.
    if ($doGlobal) {
      Write-ForgeLog "Dashboard: open http://127.0.0.1:4100 (run `"forge dashboard`" in a project, or double-click start-forge-dashboard.bat in a project's .claude\forge-dashboard folder)"
      Write-ForgeLog ''
    }
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
  # F2b fix: same trim as Main -- see ConvertTo-ForgeCleanProjectPath's and Main's own comments.
  $rawProjectDir = if ($ProjectDir) { $ProjectDir } else { (Get-Location).Path }
  $projectDir = ConvertTo-ForgeCleanProjectPath $rawProjectDir
  # v2.9.0 (WP-P3 addition): see Main's own identical comment -- the projects registry needs a
  # genuinely absolute path, resolved the same way on both the install and uninstall side.
  $projectDirFull = Resolve-ForgeFullPath $projectDir
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
  if ($doProject) { Write-ForgeLog "This will remove Forge's own files from: $projectDir\.claude (only files the installer itself wrote, verified by hash) and this project's own entry from $forgeHome\.claude\forge\projects.json" }
  if ($doGlobal) { Write-ForgeLog "This will remove Forge's global core from: $forgeHome\.claude (forge-core skill, /forge, /setup-forge, the canonical template, the Command Center)" }
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

      # v2.9.0 (WP-P3, coordinator follow-up): remove ONLY this project's own entry from the shared
      # projects registry -- never the whole file (it is merged/user data, like settings.json; a
      # -GlobalOnly uninstall never reaches this branch at all, so it can never touch another
      # project's entry).
      Update-ForgeProjectsRegistry -ProjectDirFull $projectDirFull -ForgeHome $forgeHome -IsDryRun $isDryRun -Action 'remove'

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
