#!/usr/bin/env bash
# claude-forge installer (POSIX bash)
#
# Installs the Forge V2 multi-agent system for Claude Code:
#   - global-install/.claude/*  -> $HOME/.claude       (forge-core skill, /forge, /setup-forge)
#   - .claude/*                 -> <project>/.claude    (skills, agents, dashboard, config)
#
# Safe to re-run: file-by-file, merge-safe copy. Never `cp -r` / `rm -rf` the
# .claude tree. Existing files that differ are backed up with a timestamp
# suffix before being overwritten. Identical files are a no-op.
#
# Usage:
#   ./install.sh [--project <dir>] [--yes|-y] [--dry-run] [--global-only] [--project-only]
#   ./install.sh --uninstall [--project <dir>] [--yes|-y] [--dry-run] [--global-only] [--project-only]
#
# Env:
#   FORGE_YES=1        same as --yes
#   FORGE_REF=<branch> git ref to download when not running from a clone (default: main)
#
# Everything below is wrapped in main() and invoked ONLY on the last line of
# this file, so a curl|bash pipe that is truncated mid-download can never
# execute a half-written script.

set -euo pipefail

REPO_OWNER="ForgeyClap"
REPO_NAME="claude-forge"

# v2.8.1 (WP-P3, R3 independent review): relative path of the SYSTEM-synced owner-rules file — kept
# as one constant so forge_check_standing_rules_migration/forge_copy_tree never drift out of step
# with each other. Mirrors STANDING_RULES_REL in .claude/forge-bin/forge-sync.cjs.
FORGE_STANDING_RULES_REL="config/orchestration/FORGE_STANDING_RULES.json"

# The node one-liner forge_check_standing_rules_migration runs against the NEW payload's own
# forge-sync.cjs — every path is passed as argv, never interpolated into this text, so a path
# containing quotes/spaces/backslashes can never break out of the script. Read via
# process.argv.slice(-4) rather than a fixed index: under `node -e THIS_TEXT a b c d`, argv is
# [node, a, b, c, d] (no slot reserved for the eval text itself), but install.ps1 runs this identical
# text from a real temp .js FILE instead (`node -e` is unsafe on PowerShell — see that installer's own
# comment), where argv is [node, file, a, b, c, d] — a fixed argv[1]/argv[2]/... would silently read
# the wrong thing on one of the two installers (found by a real local run, WP-P3:
# "sync.migrateOwnerStandingRules is not a function"). slice(-4) reads the same four trailing args
# regardless of which shape argv has: [0] the payload's forge-sync.cjs, [1] the project dir, [2] the
# forward-slash form of FORGE_STANDING_RULES_REL (kept as an argument, not a second hardcoded copy of
# the literal, so this text and the bash/PowerShell constant it mirrors can never drift apart), [3]
# "1" in a dry run, "0" in a real run.
# Exit 0 = safe to replace FORGE_STANDING_RULES.json this run (no owner rule was present, or it was
# moved to FORGE_STANDING_RULES.user.json already); exit 2 = NOT safe (an owner rule could not be
# confirmed migrated); exit 3 (F2 fix, 2026-09-27 independent v2.8.1 review) = the file EXISTS but
# could not itself be read or parsed (corrupt, locked, or an unreadable path) — forge_check_standing_
# rules_migration treats ANY non-zero exit the same way for the copy itself (skip), but reports 3
# with its own distinct, honest message instead of the generic "pending migration" one.
FORGE_STANDING_MIGRATE_JS='try {
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
  // { length: 0, pending: false } (see that function'"'"'s own doc comment in forge-sync.cjs, which this
  // fix never edits -- the payload is off limits here, see install.sh'"'"'s own header note on this
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
}'

# v2.9.0 (WP-P3, coordinator follow-up): the Command Center gateway only auto-discovers projects
# under <home>/Documents, <home>/Desktop and its own parent folder (command-center/gateway/src/
# paths.mjs SYNC_SCAN_ROOTS) — a project living anywhere else (a custom drive/folder) never shows up
# in the dashboard. Every project install/uninstall records (or removes) this project's absolute
# path in $HOME/.claude/forge/projects.json, a small { schema, projects: [...] } file the gateway
# reads (WP-P1, a separate work package — this installer only writes the file). Real JSON
# read-modify-write via `node` (same discipline as FORGE_STANDING_MIGRATE_JS above: never a
# hand-rolled regex edit of a user-owned file); when node is unavailable this warns once and
# continues — it NEVER fails the install over this file. Written atomically (temp file + rename) and
# merged like settings.json: never added to the install manifest, so a global --uninstall never
# deletes the whole file — only a project uninstall removes that ONE project's own entry.
# process.argv.slice(-4) mirrors FORGE_STANDING_MIGRATE_JS's own argv trick — see that constant's
# header comment for why a fixed index would silently read the wrong thing on one of the two
# installers.
FORGE_PROJECTS_REGISTRY_JS='try {
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
  // read the file before the rename from the other one lands, so the second writer'"'"'s own
  // temp-file+rename silently discards the change from the first writer -- a lost-update race, even
  // though each individual write is itself atomic. fs.mkdirSync is atomic (EEXIST when the directory
  // already exists, exactly like a Unix `mkdir` used as a lockfile) and serializes the whole
  // read-modify-rename section below across concurrent installer processes.
  var lockPath = projectsPath + ".lock";
  fs.mkdirSync(path.dirname(projectsPath), { recursive: true });
  var haveLock = false;
  var STALE_MS = 2 * 60 * 1000;   // a lock older than ~2 minutes is treated as abandoned (a crashed
                                   // installer, or a machine that lost power mid-write) and removed
  var RETRY_MS = 50;
  var MAX_WAIT_MS = 5000;         // a short wait, up to a few seconds (as this fix explicitly asks for)
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
}'

# ---------------------------------------------------------------------------
# small helpers (defined before main, called from inside main)
# ---------------------------------------------------------------------------

forge_log() {
  printf '%s\n' "$*"
}

forge_err() {
  printf 'ERROR: %s\n' "$*" >&2
}

forge_have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# Resolves $1 to an absolute, symlink-resolved path when the directory exists; otherwise returns the
# raw value with a trailing slash stripped. Used only for the HOME-target guard below — never fails.
forge_resolve_dir() {
  if [ -d "$1" ]; then
    (cd -- "$1" >/dev/null 2>&1 && pwd -P)
  else
    printf '%s\n' "${1%/}"
  fi
}

# forge_abs_path <path> — v2.9.0 (WP-P3 addition): a best-effort ABSOLUTE form of $1, for the ONE
# thing that genuinely needs it — the projects registry (forge_update_projects_registry) records a
# real, absolute path the Command Center dashboard can use directly as a filesystem root.
# forge_resolve_dir above is not enough by itself: it only resolves via `cd`, so a relative
# --project value that does not exist YET (a --dry-run preview, or before this run's own `mkdir -p`
# has created it) falls through to its own "just strip a trailing slash" branch and stays relative.
# This prefers the same symlink-resolved form when the directory already exists, and otherwise
# prefixes the current working directory onto a relative path (an already-absolute path, POSIX or
# Windows-drive-letter-shaped for Git-Bash/MSYS, is returned unchanged either way). Never fails.
forge_abs_path() {
  local p="$1"
  if [ -d "$p" ]; then
    (cd -- "$p" >/dev/null 2>&1 && pwd -P)
    return 0
  fi
  case "$p" in
    /*) printf '%s\n' "${p%/}" ;;
    [A-Za-z]:[/\\]*) p="${p%/}"; printf '%s\n' "${p%\\}" ;;
    *) printf '%s\n' "$(pwd)/$p" ;;
  esac
}

# forge_sha256 <file> — prints the lowercase sha256 of a file using whatever hashing tool is on
# PATH (sha256sum on Linux/Git-Bash/MSYS, shasum -a 256 on macOS/BSD). Prints nothing (empty) if
# neither is available; callers treat an empty hash as "cannot verify -- never delete".
#
# BACKSLASH-ESCAPE-MODE (found by a real local run on Windows Git-Bash, 2026-09-26): GNU coreutils
# sha256sum switches to its "escaped" output line the moment the filename argument contains a
# backslash -- which EVERY Windows-native path does (C:\Users\...). In that mode the line is
# `\<hash>  *<escaped-name>` (note the LEADING backslash before the hash itself), so the naive
# `awk '{print $1}'` captured "\<hash>" instead of "<hash>" for every single file on this platform,
# silently poisoning every recorded/compared hash and producing an install manifest that is not
# even valid JSON (caught only by trying to JSON.parse the actual file this run produced). Forward
# slashes are accepted interchangeably by the filesystem itself on Windows/MSYS, so normalizing the
# path before hashing avoids escape mode entirely rather than trying to strip the prefix afterwards.
#
# v2.9.0 (WP speed pass — install.sh is slow under Git Bash on Windows, CHANGELOG 2.8.1): this used
# to be `printf '%s' "$1" | tr '\\' '/'` (a subshell + one forked process) plus `sha256sum ... | awk
# '{print $1}'` (two more forked processes) -- FOUR real fork+execs per call, and this runs once per
# copied file (roughly 1000+ times on a full install: global core + canonical template + project
# payload). Every fork/exec costs ~50-150ms on Git Bash/MSYS, so this one function was a large share
# of the multi-minute runtime. Only the actual hashing tool (sha256sum/shasum) still forks below --
# the path normalization and field-extraction are now pure parameter expansion, no process started.
# `${1//\\//}` was verified byte-identical to `printf '%s' "$1" | tr '\\' '/'` on real Git-Bash/MSYS
# bash across plain Windows paths, paths with spaces, doubled/trailing backslashes, and the empty
# string (built and diffed via bash's own $'\\' quoting, not a retyped literal, to rule out any
# transcription drift in the test itself).
forge_sha256() {
  local p out
  p="${1//\\//}"
  if forge_have_cmd sha256sum; then
    out=$(sha256sum -- "$p" 2>/dev/null)
  elif forge_have_cmd shasum; then
    out=$(shasum -a 256 -- "$p" 2>/dev/null)
  else
    printf ''
    return 0
  fi
  # First whitespace-delimited field -- same result as `awk '{print $1}'`, including its behavior in
  # the (now unreachable in practice, since $p has no backslashes left) BACKSLASH-ESCAPE-MODE case
  # documented above: a leading "\" in $out would stay part of this field too, exactly as before.
  printf '%s\n' "${out%% *}"
}

# forge_sha256_normalized <file> — sha256 of $1's bytes after normalizing CRLF -> LF (a lone CR or LF
# is left untouched). v2.9.0 (WP-P3b): used ONLY by the pre-2.8.0 (no-manifest) legacy dashboard
# fallback below, so a Windows checkout/extraction that turned a shipped LF file into CRLF still
# matches the historical hash recorded from the original (LF) git blob. Hashes the SED OUTPUT over a
# pipe (stdin), never the named file itself, so BACKSLASH-ESCAPE-MODE (forge_sha256's own header
# comment above) never applies here -- sha256sum/shasum print "<hash>  -" for stdin either way, no
# filename field to escape.
forge_sha256_normalized() {
  local p="$1" out
  if forge_have_cmd sha256sum; then
    out=$(sed 's/\r$//' -- "$p" | sha256sum 2>/dev/null)
  elif forge_have_cmd shasum; then
    out=$(sed 's/\r$//' -- "$p" | shasum -a 256 2>/dev/null)
  else
    printf ''
    return 0
  fi
  printf '%s\n' "${out%% *}"
}

# ---------------------------------------------------------------------------
# Install manifest (v2.8.0) — WHAT the uninstaller is allowed to remove.
#
# The uninstaller must remove EXACTLY what the installer wrote, never more. Rather than hand
# --uninstall a hardcoded file list (which drifts the moment either one changes), the installer
# records every file it actually copies — path + sha256 at write time — into two small manifests,
# accumulated as tab-separated "path<TAB>sha256" lines in $MANIFEST_TMP/<scope>.tsv and written out
# as JSON at the end of a real install (see forge_write_manifest_file). --uninstall then deletes a
# listed file ONLY when its CURRENT hash still matches: a file you edited yourself differs and is
# left in place, reported as kept. settings.json is never manifested here — it is MERGED, not
# owned, and must never be deleted by an uninstall.
# ---------------------------------------------------------------------------

# forge_manifest_add <scope> <root_dir> <abs_path> — records one written file, relative to
# root_dir (forward-slash, so the manifest reads identically on POSIX and Windows). A no-op if the
# file does not exist, is not actually under root_dir, or no sha256 tool is available.
forge_manifest_add() {
  local scope="$1" root="$2" abspath="$3" rel hash
  [ -n "${MANIFEST_TMP:-}" ] || return 0
  # WP-P3 hardening (found by a real local run under extreme, unrelated system load): this used to
  # check only that $MANIFEST_TMP is a non-empty STRING, not that the directory it names still
  # exists. forge_copy_tree runs as the condition of an `if`, which disables `set -e` for its own
  # entire call -- so once something external removed this scratch dir mid-run (observed once on a
  # heavily loaded dev machine; never caused by this script itself, which only ever creates/removes
  # its OWN uniquely-named mktemp -d directory), every remaining call silently failed the same
  # append-redirect, one "No such file or directory" per file, for the rest of the run, instead of
  # degrading once and quietly skipping the manifest for the rest of this pass (the actual file
  # sync is completely unaffected either way -- this only feeds the --uninstall manifest).
  [ -d "$MANIFEST_TMP" ] || return 0
  [ -f "$abspath" ] || return 0
  rel="${abspath#"$root"/}"
  [ "$rel" != "$abspath" ] || return 0
  hash=$(forge_sha256 "$abspath")
  [ -n "$hash" ] || return 0
  printf '%s\t%s\n' "$rel" "$hash" >> "$MANIFEST_TMP/$scope.tsv"
}

# forge_manifest_carry <scope> <root> <abspath> <old_tsv> — a create-only-when-absent file (the project CLAUDE.md)
# that an EARLIER Forge install wrote and this run only KEPT: its old manifest line (the path and the hash from when
# Forge wrote it) is carried into this run's manifest. Without it the retired-file pruning read the file as "no longer
# shipped" and moved it to backup on every re-install (found by the Linux CI of PR #4); an uninstall still spares it
# when you edited it. A file Forge never wrote (absent from the old manifest) stays untracked, exactly as before.
forge_manifest_carry() {
  local scope="$1" root="$2" abspath="$3" old_tsv="$4" rel line
  [ -n "${MANIFEST_TMP:-}" ] && [ -d "$MANIFEST_TMP" ] && [ -n "$old_tsv" ] && [ -s "$old_tsv" ] || return 0
  rel="${abspath#"$root"/}"
  [ "$rel" != "$abspath" ] || return 0
  # Codex release gate RG-02: the old manifest is attacker-influenced input (a cloned or shared project). Only its
  # hash FIELD is taken, only when it is a real sha256 (exactly 64 hex characters), and the line is rebuilt here, so a
  # forged value can never break out of its JSON string later or add an entry of its own.
  line=$(awk -F '\t' -v r="$rel" '$1 == r { print $2; exit }' "$old_tsv")
  case "$line" in ''|*[!0-9a-fA-F]*) return 0 ;; esac
  [ "${#line}" -eq 64 ] || return 0
  printf '%s\t%s\n' "$rel" "$line" >> "$MANIFEST_TMP/$scope.tsv"
}

# forge_write_manifest_file <scope> <dest_file> <version> — writes the accumulated manifest for
# one scope to disk. A no-op when nothing was recorded for that scope this run (e.g. a
# --project-only install never touches the global manifest, and must not clear one from an
# earlier --global-only install).
forge_write_manifest_file() {
  local scope="$1" dest="$2" version="$3" tsv dest_dir count now
  tsv="$MANIFEST_TMP/$scope.tsv"
  [ -s "$tsv" ] || return 0
  dest_dir=$(dirname -- "$dest")
  mkdir -p -- "$dest_dir"
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)
  {
    printf '{\n  "forge_version": "%s",\n  "written_at": "%s",\n  "scope": "%s",\n' "$version" "$now" "$scope"
    printf '  "_doc": "Every file this installer wrote for this scope, with its sha256 at write time. --uninstall deletes a listed file only when its CURRENT hash still matches -- a file you edited yourself is left in place and reported as kept.",\n'
    printf '  "files": [\n'
    local first=1 rel hash esc_rel
    count=0
    while IFS=$'\t' read -r rel hash; do
      [ -n "$rel" ] || continue
      # Codex release gate RG-02: only a real sha256 (64 hex characters) is ever written, so no hash from anywhere
      # can break out of its JSON string, and no path with a control character (RG-02-A), which JSON cannot hold
      # raw. Checked before the separator, so a skipped entry leaves no stray comma.
      case "$hash" in ''|*[!0-9a-fA-F]*) continue ;; esac
      [ "${#hash}" -eq 64 ] || continue
      case "$rel" in *[[:cntrl:]]*) continue ;; esac
      if [ "$first" = "1" ]; then first=0; else printf ',\n'; fi
      # v2.9.0 (WP speed pass — install.sh is slow under Git Bash on Windows, CHANGELOG 2.8.1): was
      # `printf '%s' "$rel" | sed 's/\\/\\\\/g; s/"/\\"/g'` -- a subshell + a forked `sed`, once per
      # manifest ENTRY (every file this run copied: ~540 for a project-only install, ~1000+ for a
      # full install), timed live as several extra minutes on top of the per-file copy/hash cost this
      # release already fixed above. $rel is always forward-slash-only by construction (see this
      # function's own header comment), so in practice only the quote-escaping ever fires -- but the
      # backslash pass is kept for defensive parity with the original. Verified byte-identical to the
      # sed script across plain paths, embedded double quotes, real backslash characters, a mix of
      # both, and the empty string.
      esc_rel="${rel//\\/\\\\}"
      esc_rel="${esc_rel//\"/\\\"}"
      printf '    { "path": "%s", "sha256": "%s" }' "$esc_rel" "$hash"
      count=$((count + 1))
    done < <(sort -- "$tsv")
    printf '\n  ]\n}\n'
  } > "$dest"
  # Counts the entries actually written (a skipped RG-02 entry is not one), not the accumulator's lines.
  forge_log "  wrote: $dest ($count file(s) recorded for uninstall)"
}

# Seed the project-root files Forge needs but the .claude payload does not carry:
#   CLAUDE.md   — created ONLY when absent (your own file is never touched)
#   .gitignore  — missing Forge lines appended; existing lines left alone
# Both operations are idempotent: running the installer twice changes nothing the second time.
forge_seed_project_root() {
  seed_project="$1"

  if [ -f "$seed_project/CLAUDE.md" ]; then
    forge_log "  kept:  $seed_project/CLAUDE.md (already exists — not touched)"
    forge_manifest_carry "project" "$seed_project" "$seed_project/CLAUDE.md" "${OLD_PROJECT_TSV:-}"
  elif [ -f "$SOURCE_DIR/templates/project-CLAUDE.md" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      forge_log "  would write: $seed_project/CLAUDE.md"
    else
      cp -- "$SOURCE_DIR/templates/project-CLAUDE.md" "$seed_project/CLAUDE.md"
      forge_log "  wrote: $seed_project/CLAUDE.md (project brain — edit it, it is yours)"
      # Manifested ONLY on this branch (freshly written by Forge) — never when the file already
      # existed, so an uninstall can never delete a CLAUDE.md that predates Forge.
      forge_manifest_add "project" "$seed_project" "$seed_project/CLAUDE.md"
    fi
  fi

  seed_snippet="$SOURCE_DIR/templates/gitignore.snippet"
  [ -f "$seed_snippet" ] || return 0
  seed_gi="$seed_project/.gitignore"
  seed_added=0
  # Append only the lines that are genuinely absent. Comments and blank lines are copied
  # along with the first missing rule so the block stays readable.
  while IFS= read -r seed_line || [ -n "$seed_line" ]; do
    case "$seed_line" in
      ''|'#'*) continue ;;
    esac
    if [ -f "$seed_gi" ] && grep -qxF -- "$seed_line" "$seed_gi" 2>/dev/null; then
      continue
    fi
    if [ "$DRY_RUN" = "1" ]; then
      seed_added=$((seed_added + 1))
      continue
    fi
    if [ "$seed_added" = "0" ]; then
      { [ -f "$seed_gi" ] && [ -s "$seed_gi" ] && printf '\n'; } >> "$seed_gi" 2>/dev/null || true
      printf '%s\n' "# --- Forge (added by the claude-forge installer) ---" >> "$seed_gi"
    fi
    printf '%s\n' "$seed_line" >> "$seed_gi"
    seed_added=$((seed_added + 1))
  done < "$seed_snippet"

  if [ "$seed_added" -gt 0 ]; then
    if [ "$DRY_RUN" = "1" ]; then
      forge_log "  would add: $seed_added line(s) to $seed_gi"
    else
      forge_log "  wrote: $seed_gi (+$seed_added Forge line(s); your existing rules kept)"
    fi
  else
    forge_log "  kept:  $seed_gi (all Forge lines already present)"
  fi
}

# Writes .claude/FORGE_VERSION.json — per-install state (gitignored by the snippet above), read by
# `forge-sync status` to report the installed release next to the canonical template's hash.
#
# INSTALLER-NONIDEMPOTENCE (wp-f2, 2026-09-24 Codex re-check): this used to overwrite the marker with a
# fresh timestamp on EVERY real run, even when the installed release/template had not changed at all —
# contradicting this installer's own "safe to re-run... identical files are a no-op" claim. Now preserves
# the marker (and its original synced_at) when forge_version AND template already match what would be
# written; unreadable/malformed markers fall through and are rewritten, same as before this fix.
forge_write_version_marker() {
  vm_project="$1"
  vm_file="$vm_project/.claude/FORGE_VERSION.json"
  vm_template="$HOME/.claude/forge/template/.claude"
  if [ "$DRY_RUN" = "1" ]; then
    forge_log "  would write: $vm_file (forge_version $FORGE_VERSION) — only if version/template changed since the last install"
    return 0
  fi
  if [ -f "$vm_file" ]; then
    vm_prev_version=""
    vm_prev_template=""
    if vm_prev_version=$(grep -o '"forge_version"[[:space:]]*:[[:space:]]*"[^"]*"' "$vm_file" 2>/dev/null | sed -n 's/.*"\([^"]*\)"$/\1/p'); then :; fi
    if vm_prev_template=$(grep -o '"template"[[:space:]]*:[[:space:]]*"[^"]*"' "$vm_file" 2>/dev/null | sed -n 's/.*"\([^"]*\)"$/\1/p'); then :; fi
    if [ "$vm_prev_version" = "$FORGE_VERSION" ] && [ "$vm_prev_template" = "$vm_template" ]; then
      forge_log "  kept:  $vm_file (forge_version $FORGE_VERSION unchanged — marker left as-is)"
      # Still manifested: this file is always Forge-owned installer metadata (never hand-authored
      # by a user before Forge exists), regardless of which branch wrote/kept it this run.
      forge_manifest_add "project" "$vm_project" "$vm_file"
      return 0
    fi
  fi
  vm_now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "unknown")
  printf '{\n  "forge_version": "%s",\n  "synced_at": "%s",\n  "template": "%s",\n  "installed_by": "install.sh",\n  "_doc": "forge_version is the release this installer wrote; `forge-sync status` prints it as installed= and detects drift by file hash against the canonical template."\n}\n' \
    "$FORGE_VERSION" "$vm_now" "$vm_template" > "$vm_file" || {
    forge_err "could not write $vm_file (forge-sync status will report installed=none)"
    return 0
  }
  forge_log "  wrote: $vm_file (forge_version $FORGE_VERSION)"
  forge_manifest_add "project" "$vm_project" "$vm_file"
}

forge_usage() {
  cat <<'USAGE'
claude-forge installer

Usage:
  ./install.sh [options]
  ./install.sh --uninstall [options]

Options:
  --project <dir>   Target project directory (default: current directory)
  --yes, -y         Non-interactive: assume "yes" to the confirmation prompt (CI)
  --dry-run         Show what would be written/removed, change nothing
  --global-only     Only touch the global core in $HOME/.claude
  --project-only    Only touch the per-project payload in <project>/.claude
  --uninstall       Remove exactly what a claude-forge installer wrote (see below), not install
  -h, --help        Show this help

Uninstall:
  --uninstall deletes a file only when its CURRENT hash still matches what the installer itself
  recorded (a small install manifest); a file you edited yourself is left in place and reported as
  kept. Pre-2.8.0 installs have no manifest: uninstall then falls back to a byte-identical
  comparison against this installer's own shipped payload. Your own data (CLAUDE.md if it
  predates Forge, .env, FORGE_MEMORY*, forge-runs, agent-memory) is always left in place. Safe to
  run twice: a second uninstall is a no-op.

Env vars:
  FORGE_YES=1        same as --yes
  FORGE_REF=<ref>    git ref/branch to download when not run from a clone (default: main)
USAGE
}

# Copy $1 (source file) to $2 (dest file) in a merge-safe way.
# - If dest does not exist: create parent dir, copy.
# - If dest exists and is identical (cmp -s): no-op.
# - If dest exists and differs: move dest to dest.forge-bak-<timestamp>, then copy.
# Prints one line describing what happened, unless DRY_RUN=1 (then prints "would ...").
forge_copy_file() {
  local src_file="$1"
  local dst_file="$2"
  local dst_dir stamp bak_file

  # v2.9.0 (WP speed pass — install.sh is slow under Git Bash on Windows, CHANGELOG 2.8.1): was
  # `dirname -- "$dst_file"`, a forked process on every single file. Every dst_file this installer
  # ever builds is "<absolute-dir>/<relative-file-path>" (forge_copy_tree always calls this as
  # `forge_copy_file "$file" "$dst_dir/$rel"`, where $dst_dir is itself absolute and $rel is a find(1)
  # relative FILE path, never empty/trailing-slash) -- so it always contains at least one non-trailing
  # '/', and stripping the shortest trailing "/*" match (the last path segment) is exactly what
  # `dirname` returns for every path shape this code passes. Verified against real `dirname` for
  # nested paths, single-segment directories, and paths containing spaces.
  dst_dir="${dst_file%/*}"

  if [ "$DRY_RUN" = "1" ]; then
    if [ -e "$dst_file" ] && [ ! -f "$dst_file" ]; then
      forge_log "  [dry-run] SKIP (a directory already exists at this file's destination): $dst_file"
      return 0
    fi
    if [ -f "$dst_file" ]; then
      if cmp -s -- "$src_file" "$dst_file" 2>/dev/null; then
        forge_log "  [dry-run] unchanged: $dst_file"
      else
        forge_log "  [dry-run] would back up + overwrite: $dst_file"
      fi
    else
      forge_log "  [dry-run] would create: $dst_file"
    fi
    return 0
  fi

  # WP-9B-INST (Codex adversarial review, INSTALL-3 MEDIUM): dst_file existing as anything OTHER than a
  # regular file (almost always a directory left behind by an older release, or planted deliberately)
  # must never be silently treated as "does not exist yet" -- `[ -f ]` is false for BOTH cases, but `cp`
  # against an existing DIRECTORY copies the source INSIDE it (dst_file/src_file's own name), not AS
  # dst_file -- reporting "wrote: $dst_file" while the real bytes landed one level deeper. Treated as an
  # explicit failure, never a silent success (mirrors forge_copy_settings_file's own UNSAFE-FIRST-COPY
  # fix for the same shape, above).
  if [ -e "$dst_file" ] && [ ! -f "$dst_file" ]; then
    forge_err "cannot write $dst_file — a directory (or other non-file item) already exists at that exact path"
    return 1
  fi

  # v2.9.0 (WP speed pass): `mkdir -p` used to run unconditionally, once per FILE, even though most
  # files in this tree share a handful of directories -- after the first file in a directory creates
  # it, every later file in that SAME directory forked `mkdir -p` again just to no-op against an
  # already-existing directory. Skipping the call once `[ -d ]` is already true changes nothing
  # observable (mkdir -p on an existing directory was always a silent success) and collapses this
  # from "once per file" to "once per directory that did not already exist yet".
  if [ ! -d "$dst_dir" ]; then
    if ! mkdir -p -- "$dst_dir"; then
      forge_err "failed to create directory: $dst_dir"
      return 1
    fi
  fi

  if [ -f "$dst_file" ]; then
    if cmp -s -- "$src_file" "$dst_file" 2>/dev/null; then
      # identical, no-op
      return 0
    fi
    stamp=$(date +%Y%m%d-%H%M%S)
    bak_file="${dst_file}.forge-bak-${stamp}"
    if ! mv -- "$dst_file" "$bak_file"; then
      forge_err "failed to back up existing file: $dst_file -> $bak_file"
      return 1
    fi
    forge_log "  backed up: $dst_file -> $bak_file"
  fi

  if ! cp -- "$src_file" "$dst_file"; then
    forge_err "failed to copy: $src_file -> $dst_file"
    return 1
  fi
  # WP-9B-INST (INSTALL-3): verify the copy actually produced a regular file matching the source,
  # before reporting success -- catches a destination that silently became a directory-nested copy, or
  # any other post-copy mismatch, instead of trusting cp's own zero exit status alone.
  if [ ! -f "$dst_file" ] || ! cmp -s -- "$src_file" "$dst_file" 2>/dev/null; then
    forge_err "copy to $dst_file did not produce a matching regular file — treating this as a failure"
    return 1
  fi
  forge_log "  wrote: $dst_file"
  return 0
}

# forge_path_has_reparse_ancestor <root_dir> <rel> [include_root] — WP-9B-INST (Codex adversarial
# review, INSTALL-1/INSTALL-2): true (exit 0) the moment any EXISTING component of rel (each
# '/'-separated segment, including the final leaf), walked from root_dir down, is itself a symlink or
# Windows junction ([ -L ] — Git-Bash/MSYS's lstat reports BOTH NTFS symlinks and directory junctions
# this way, exactly like forge_guarded_write_new below already relies on). cp/mv both follow a reparse
# point exactly like a real directory or file, so a link planted anywhere in that chain lets a write or
# move meant for root_dir land somewhere else entirely. A component that does not exist yet is not a
# symlink (nothing to follow yet). include_root=1 (optional) also checks root_dir itself — used by the
# Command Center destination-tree check (forge_copy_command_center_tree); the manifest-retirement
# path-safety check (forge_manifest_path_is_contained) deliberately leaves root_dir itself unchecked,
# since root_dir there is the caller's own project/home directory, not something a manifest entry
# could ever redirect. Pure parameter expansion, no subprocess — consistent with this file's existing
# "WP speed pass" discipline (see forge_sha256's own header comment).
forge_path_has_reparse_ancestor() {
  local root_dir="$1" rel="$2" include_root="${3:-0}" current remaining seg
  if [ "$include_root" = "1" ] && [ -L "$root_dir" ]; then return 0; fi
  current="$root_dir"
  remaining="$rel"
  while [ -n "$remaining" ]; do
    seg="${remaining%%/*}"
    case "$remaining" in
      */*) remaining="${remaining#*/}" ;;
      *) remaining="" ;;
    esac
    [ -n "$seg" ] || continue
    current="$current/$seg"
    [ -L "$current" ] && return 0
  done
  return 1
}

# forge_is_safe_manifest_rel_path <rel> — WP-9B-INST (Codex adversarial review, INSTALL-1 HIGH): true
# (exit 0) when $1 is a normalized, forward-slash RELATIVE path with no drive letter, UNC, or leading
# slash/backslash, and no '.'/'..'/empty path components, using only characters this installer's own
# payload ever produces. See install.ps1's Test-ForgeSafeManifestRelPath for the full rationale (kept
# in sync here) — an install manifest is attacker-influenced input the moment its project is cloned or
# shared; a forged ".forge-install-manifest.json" entry like "../../victim.txt" must never be trusted
# just because it parses and its own recorded hash happens to match a real file elsewhere.
forge_is_safe_manifest_rel_path() {
  local rel="$1" remaining seg
  [ -n "$rel" ] || return 1
  case "$rel" in
    *'\'*) return 1 ;;
    /*) return 1 ;;
    [A-Za-z]:*) return 1 ;;
  esac
  remaining="$rel"
  while [ -n "$remaining" ]; do
    seg="${remaining%%/*}"
    case "$remaining" in
      */*) remaining="${remaining#*/}" ;;
      *) remaining="" ;;
    esac
    case "$seg" in
      '') return 1 ;;
      .|..) return 1 ;;
    esac
    case "$seg" in
      *[!A-Za-z0-9._\ -]*) return 1 ;;
    esac
  done
  return 0
}

# forge_manifest_path_is_contained <root_dir> <rel> — WP-9B-INST (Codex adversarial review, INSTALL-1
# HIGH): filesystem-level defense-in-depth for a manifest-recorded relative path that already passed
# forge_is_safe_manifest_rel_path. Even a lexically clean relative path (no "..") can still resolve
# outside root_dir if an ANCESTOR directory component is a symlink/junction planted after the fact —
# cp/mv both follow a reparse point exactly like a real directory. Refuses the moment any EXISTING
# component is a symlink/junction (forge_path_has_reparse_ancestor); once both checks hold,
# root_dir/rel cannot resolve outside root_dir (the lexical check rules out any ".."/absolute escape
# in the string itself, and this rules out a symlink redirecting any component of it) — no separate
# real-path-resolve step is needed (unlike install.ps1, which additionally re-verifies via .NET's own
# independent GetFullPath normalizer at near-zero cost; a bash equivalent would need a real subprocess,
# `cd` + `pwd -P` or `realpath`, for a check these two already make redundant).
forge_manifest_path_is_contained() {
  local root_dir="$1" rel="$2"
  forge_is_safe_manifest_rel_path "$rel" || return 1
  forge_path_has_reparse_ancestor "$root_dir" "$rel" && return 1
  return 0
}

# forge_guarded_write_new — creates a NEW dst_file (no existing file yet) from src_file WITHOUT following a
# symlink/junction planted at dst_dir, and WITHOUT clobbering a path that appears at dst_file between the
# caller's check and this write. This is the bash-only (no `node`) equivalent of forge-settings-merge.cjs's
# own guarded create path (UNREADABLE-MEANS-ABSENT + PROJECT-DIRECTORY-ESCAPE) — used ONLY when `node`/the
# merge tool are unavailable (wp-g2, 2026-09-24 Codex re-check out-p7.md V07). `( set -C; ... > "$dst_file" )`
# (noclobber, in a subshell so it never changes the caller's shell options) makes the redirection FAIL rather
# than truncate/follow an existing path at that exact name — including an existing symlink.
forge_guarded_write_new() {
  local dst_dir="$1" dst_file="$2" src_file="$3"
  if [ -L "$dst_dir" ]; then
    forge_err "refusing: $dst_dir is a symlink/junction, not a real directory"
    return 1
  fi
  if ( set -C; cat -- "$src_file" > "$dst_file" ) 2>/dev/null; then
    return 0
  fi
  forge_err "could not create $dst_file (it already exists, or $dst_dir cannot be written to) — refusing to overwrite or follow a link"
  return 1
}

# forge_guarded_write_recommended — AUXILIARY-FILE-CLOBBER for the bash-only (no `node`) fallback: a
# uniquely timestamp+random-suffixed settings.forge-recommended-<stamp>-<rand>.json, exclusively created
# (`set -C` noclobber — never overwrites/follows a prior recovery file or a planted symlink at that exact
# name), mirroring forge-settings-merge-guards.cjs's own writeExclusiveUnique (V07). Never targets a FIXED
# `settings.forge-recommended.json` path — a pre-existing file or symlink already sitting at that fixed name
# is simply never touched, by construction.
forge_guarded_write_recommended() {
  local dst_dir="$1" src_file="$2" stamp rand rec_file attempt=0
  if [ -L "$dst_dir" ]; then
    forge_err "refusing: $dst_dir is a symlink/junction — could not write a recommended-hooks file"
    return 1
  fi
  stamp=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo now)
  while [ "$attempt" -lt 8 ]; do
    rand=$((RANDOM % 1000000))
    rec_file="$dst_dir/settings.forge-recommended-$stamp-$rand.json"
    if ( set -C; cat -- "$src_file" > "$rec_file" ) 2>/dev/null; then
      forge_log "  Forge's recommended hooks are in $rec_file — merge what you want"
      return 0
    fi
    attempt=$((attempt + 1))
  done
  forge_err "could not create a unique recommended-hooks file in $dst_dir after $attempt attempts"
  return 1
}

# Merge handling for <project>/.claude/settings.json (security #4, review #10; MERGED instead of
# "kept, merge by hand" since wp22 / owner directive 2026-09-24 "alles standaard aan" — Forge does the
# merge itself). A user's own settings.json carries their own permissions/hooks and must never be silently
# backed-up-and-REPLACED like an ordinary payload file — but leaving it completely untouched next to a
# settings.forge-recommended.json (the pre-wp22 behaviour) meant the owner's new default hooks (the gate
# hook, the deny rules) never reached an existing project either. Real merge, via the dedicated
# forge-settings-merge.cjs tool (foreign hooks/rules/keys kept byte-for-byte, backed up first): only when
# `node` is on PATH. Without `node`, this falls back to a guarded recommended-file (or raw-create) fallback
# and says why — never silently drops the merge.
#
# V07 (wp-g2, 2026-09-24 Codex re-check out-p7.md): EVERY settings destination now goes through a guarded
# path — the merge tool's own guarded create (with --project-root so PROJECT-DIRECTORY-ESCAPE applies even
# to a brand-new settings.json), or the bash-only guarded helpers above when `node` is unavailable — never an
# unrestricted `cp` to a fixed path. Every non-merge outcome (refused merge, node unavailable, a guarded
# write itself failing) now returns 1 so the gate hook's absence propagates to a NONZERO overall exit code
# instead of a false "installed successfully" (this function used to `return 0` after every fallback).
forge_copy_settings_file() {
  local src_file="$1"
  local dst_file="$2"
  local dst_dir merge_tool merge_out

  dst_dir=$(dirname -- "$dst_file")
  merge_tool="$SOURCE_DIR/.claude/forge-bin/forge-settings-merge.cjs"

  # UNSAFE-FIRST-COPY (wp-f2, 2026-09-24 Codex re-check): a destination that EXISTS but is not a regular file
  # (a directory named settings.json, most concretely) fell through every branch below straight to the final
  # `cp -- "$src_file" "$dst_file"` — and `cp` INTO an existing directory nests the payload's settings.json
  # inside it (`.claude/settings.json/settings.json`) rather than replacing anything, silently reporting
  # "wrote" while never actually installing a usable settings.json. Refuse cleanly instead, before any write.
  if [ -e "$dst_file" ] && [ ! -f "$dst_file" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      forge_log "  [dry-run] REFUSING: $dst_file exists but is not a regular file (e.g. a directory) — settings.json would be left untouched"
    else
      forge_err "$dst_file exists but is not a regular file (e.g. a directory) — refusing to touch it; settings.json was left untouched; the PreToolUse gate hook was NOT installed"
      FORGE_SETTINGS_GATE_FAILED=1
    fi
    return 1
  fi

  if [ "$DRY_RUN" = "1" ]; then
    if forge_have_cmd node && [ -f "$merge_tool" ]; then
      # guarded via `if` (not a bare assignment / not piped) — see the real-run branch below for why
      # `set -e`/`set -o pipefail` make that unsafe with a tool that can legitimately exit non-zero.
      if merge_out=$(node "$merge_tool" apply --target "$dst_file" --source "$src_file" --project-root "$dst_dir" --dry-run 2>&1); then :; fi
      forge_log "  [dry-run] $merge_out"
    elif [ -f "$dst_file" ]; then
      if cmp -s -- "$src_file" "$dst_file" 2>/dev/null; then
        forge_log "  [dry-run] unchanged: $dst_file"
      else
        forge_log "  [dry-run] node not found — would keep your settings.json unmerged; would write a recommended-hooks file (guarded, uniquely named)"
      fi
    else
      forge_log "  [dry-run] node not found — would create: $dst_file (guarded — refuses a symlinked .claude)"
    fi
    return 0
  fi

  if ! mkdir -p -- "$dst_dir"; then
    forge_err "failed to create directory: $dst_dir"
    return 1
  fi

  if [ -f "$dst_file" ]; then
    if cmp -s -- "$src_file" "$dst_file" 2>/dev/null; then
      # identical, no-op
      return 0
    fi
    if forge_have_cmd node && [ -f "$merge_tool" ]; then
      # `if var=$(cmd)` (not a bare `var=$(cmd)`) is deliberate: under this script's `set -e`, a bare
      # assignment whose command substitution exits non-zero would abort the WHOLE installer the moment the
      # merge tool refuses (exit 1) — using it as an `if` condition is the one form `set -e` does not apply to.
      if merge_out=$(node "$merge_tool" apply --target "$dst_file" --source "$src_file" --project-root "$dst_dir" 2>&1); then
        forge_log "  $merge_out"
        return 0
      fi
      # The merge tool's OWN refusal already wrote a guarded, uniquely-named settings.forge-recommended-
      # <stamp>-<rand>.json next to the target (or explains in $merge_out why it could not) — never re-copy
      # over that with a second, unguarded `cp` (V07: that was the actual junction/link bypass).
      forge_err "settings.json merge refused ($merge_out) — the PreToolUse gate hook was NOT installed into $dst_file"
      FORGE_SETTINGS_GATE_FAILED=1
      return 1
    fi
    forge_log "  node not found on PATH — cannot merge settings.json automatically; writing a recommended-hooks file instead"
    if forge_guarded_write_recommended "$dst_dir" "$src_file"; then
      forge_err "kept your settings.json unmerged (node not found on PATH) — the PreToolUse gate hook was NOT installed into $dst_file"
    else
      forge_err "kept your settings.json unmerged (node not found on PATH) and could not write a recommended-hooks file either — the PreToolUse gate hook was NOT installed into $dst_file"
    fi
    FORGE_SETTINGS_GATE_FAILED=1
    return 1
  fi

  # dst_file does not exist yet — route through the SAME guarded create path forge-settings-merge.cjs uses
  # for an existing target (never a raw `cp`): --project-root makes a symlinked/junctioned .claude refuse
  # exactly like the merge helper does (PROJECT-DIRECTORY-ESCAPE), even on a brand-new settings.json.
  if forge_have_cmd node && [ -f "$merge_tool" ]; then
    if merge_out=$(node "$merge_tool" apply --target "$dst_file" --source "$src_file" --project-root "$dst_dir" 2>&1); then
      forge_log "  $merge_out"
      return 0
    fi
    forge_err "could not create settings.json ($merge_out) — the PreToolUse gate hook was NOT installed into $dst_file"
    FORGE_SETTINGS_GATE_FAILED=1
    return 1
  fi

  # node unavailable and nothing to merge with yet — guarded bash-only raw create (still refuses a
  # symlinked/junctioned .claude and never follows/overwrites a path that already exists at dst_file).
  if forge_guarded_write_new "$dst_dir" "$dst_file" "$src_file"; then
    forge_log "  wrote: $dst_file"
    return 0
  fi
  forge_err "the PreToolUse gate hook was NOT installed into $dst_file"
  FORGE_SETTINGS_GATE_FAILED=1
  return 1
}

# forge_check_standing_rules_migration <project_dir> <source_claude_dir> [is_dry_run] — MUST run
# before forge_copy_tree ever compares/replaces the project's FORGE_STANDING_RULES.json (3.4 fix,
# WP-P3: the installer previously backed up and replaced this file on every upgrade with no
# migration at all — see migrateOwnerStandingRules()'s own doc comment in forge-sync.cjs for the
# full v2.7.x-owner-rule-loss contract this closes). Sets FORGE_STANDING_MIGRATION_SKIP to
# $FORGE_STANDING_RULES_REL when the file must be left untouched THIS run (no confirmed-safe
# migration — including "node is not available to check"), or "" when it is safe to proceed with
# the normal copy. FORGE_STANDING_MIGRATION_REASON (F5 fix, 2026-09-27 independent v2.8.1 review) is
# set alongside it to the REAL reason (node missing, forge-sync.cjs's own specific warning text —
# unreadable/malformed user file, a symlink/containment refusal, a write failure — or, new here, the
# template file itself being unreadable) instead of the caller assuming one fixed cause. A brand-new
# project (no such file yet) is always safe and never even shells out. is_dry_run ("1"/"0", default
# "0") is passed straight through to migrateOwnerStandingRules() so a dry run reports the SAME
# outcome a real run would reach (F4 fix) without writing anything — dry-run-ness never changes which
# guard trips, only whether the final write at the very end of that function actually happens.
forge_check_standing_rules_migration() {
  local project_dir="$1" source_claude_dir="$2" is_dry_run="${3:-0}"
  local target="$project_dir/.claude/$FORGE_STANDING_RULES_REL"
  local sync_tool="$source_claude_dir/forge-bin/forge-sync.cjs"
  FORGE_STANDING_MIGRATION_SKIP=""
  FORGE_STANDING_MIGRATION_REASON=""

  [ -f "$target" ] || return 0

  if ! forge_have_cmd node || [ ! -f "$sync_tool" ]; then
    FORGE_STANDING_MIGRATION_REASON="node was not found on PATH (or forge-sync.cjs is missing), so this run could not check $FORGE_STANDING_RULES_REL for a pre-v2.8.0 owner rule at all"
    forge_log "  $FORGE_STANDING_MIGRATION_REASON — leaving your existing file in place this run"
    FORGE_STANDING_MIGRATION_SKIP="$FORGE_STANDING_RULES_REL"
    return 0
  fi

  local out code
  if out=$(node -e "$FORGE_STANDING_MIGRATE_JS" "$sync_tool" "$project_dir" "$FORGE_STANDING_RULES_REL" "$is_dry_run" 2>&1); then
    code=0
  else
    code=$?
  fi
  [ -n "$out" ] && forge_log "  $out"

  if [ "$code" -eq 3 ]; then
    # F2 fix: the file EXISTS (checked above) but could not itself be read or parsed — kept, never
    # silently treated as "nothing to migrate, safe to overwrite" the way a read/parse failure used to
    # be. Plain NL+EN words, both facts (could not be read; left untouched) in both languages, reused
    # verbatim for the immediate warning AND the final NOTE so the two never say something different.
    FORGE_STANDING_MIGRATION_REASON="$FORGE_STANDING_RULES_REL kon niet worden gelezen of verwerkt (corrupt, vergrendeld, of een onleesbaar pad) — het bestand blijft exact ongewijzigd / could not be read or parsed (corrupt, locked, or an unreadable path) — left exactly as-is"
    forge_log "  $FORGE_STANDING_MIGRATION_REASON"
    FORGE_STANDING_MIGRATION_SKIP="$FORGE_STANDING_RULES_REL"
  elif [ "$code" -ne 0 ]; then
    FORGE_STANDING_MIGRATION_REASON="${out:-an owner rule from a pre-v2.8.0 install could not be confirmed migrated}"
    forge_log "  owner rule migration for $FORGE_STANDING_RULES_REL is pending — leaving your existing file in place this run"
    FORGE_STANDING_MIGRATION_SKIP="$FORGE_STANDING_RULES_REL"
  fi
}

# forge_update_projects_registry <project_dir_abs> <is_dry_run> <action: add|remove> — see
# FORGE_PROJECTS_REGISTRY_JS's own header comment for the full contract. project_dir_abs must
# already be a resolved absolute path (forge_abs_path) — this never resolves it itself. A missing
# `node` is never a hard failure: one plain log line, then the caller continues exactly as if this
# had not been called.
forge_update_projects_registry() {
  local project_abs="$1" is_dry_run="${2:-0}" action="${3:-add}"
  local registry_path="$HOME/.claude/forge/projects.json"
  local out code
  if ! forge_have_cmd node; then
    forge_log "  node was not found on PATH — could not update $registry_path (the Command Center dashboard may not auto-discover this project); this does not affect the rest of the install"
    return 0
  fi
  if out=$(node -e "$FORGE_PROJECTS_REGISTRY_JS" "$registry_path" "$project_abs" "$is_dry_run" "$action" 2>&1); then
    code=0
  else
    code=$?
  fi
  [ -n "$out" ] && forge_log "  $out"
  if [ "$code" -ne 0 ] && [ "$code" -ne 3 ]; then
    forge_err "could not update $registry_path — this does not affect the rest of the install"
  fi
}

# forge_cc_should_skip <rel_path> — true (exit 0) when $1 (forward-slash, relative to
# command-center/) must NEVER be shipped into a fresh install or clobbered on a re-install: build
# output, dependencies, coverage/test artefacts, and per-user runtime data/secrets. Everything else
# in the source tree (including dashboard/dist/, the prebuilt SPA) is copied normally. Mirrors
# Test-ForgeCommandCenterSkip in install.ps1 — keep both in sync.
#
# Beyond the exact list WP-P3 named (node_modules, .data, .claude-flow, discord/.env, discord/
# transcripts/, *.log, dashboard/test-results|playwright-report|reports/, coverage/), this also
# skips two things flagged in the WP-P3 report rather than silently added:
#   - discord/state/  — the documented STATE_DIR default (command-center/discord/.gitignore treats
#     it identically to transcripts/); the gateway always overrides STATE_DIR to its own
#     .data/discord/state/ when it spawns the bot, so this only matters for a standalone dev run.
#   - any *.env file besides *.env.example — generalizes the named "discord/.env" rule to the exact
#     secret-file convention command-center/dashboard/.gitignore already documents for its own .env.
forge_cc_should_skip() {
  local rel="$1" base
  case "$rel" in
    node_modules/*|*/node_modules/*) return 0 ;;
    .data/*|*/.data/*) return 0 ;;
    .claude-flow/*|*/.claude-flow/*) return 0 ;;
    coverage/*|*/coverage/*) return 0 ;;
    discord/.env) return 0 ;;
    discord/transcripts|discord/transcripts/*) return 0 ;;
    discord/state|discord/state/*) return 0 ;;
    dashboard/test-results|dashboard/test-results/*) return 0 ;;
    dashboard/playwright-report|dashboard/playwright-report/*) return 0 ;;
    dashboard/reports|dashboard/reports/*) return 0 ;;
    *.log) return 0 ;;
  esac
  base="${rel##*/}"
  case "$base" in
    .env.example) return 1 ;;
    .env|.env.local|.env.forge-setup) return 0 ;;
    .env.*.local) return 0 ;;
    .env.tmp-*) return 0 ;;
  esac
  return 1
}

# forge_copy_command_center_tree <src_dir> <dst_dir> <manifest_root> [old_global_tsv] — like
# forge_copy_tree, but skips every forge_cc_should_skip match instead of copying everything; the
# Command Center ships no settings.json of its own, so this never routes through
# forge_copy_settings_file. Every copied file is manifested exactly like the canonical template's own
# files (scope "global", root manifest_root), so --uninstall removes it automatically through the SAME
# manifest-driven path forge_remove_manifest_files already runs — a skipped (runtime/build) path is
# never even considered, so it can never be deleted OR overwritten by a later install/uninstall.
# Returns 1 if any non-skipped file failed to copy.
#
# old_global_tsv (optional, v2.9.0 WP-P3b point 3) — the PREVIOUS install's global manifest as a
# "path<TAB>sha256" file (forge_manifest_to_tsv's output). When given, an existing destination file
# that still matches its previously-recorded hash is replaced WITHOUT a *.forge-bak-<stamp> copy: only
# a file that differs from BOTH the new payload AND its own last-recorded hash (edited since install,
# or of unknown provenance) still gets forge_copy_file's normal timestamped safety-net backup. Nobody
# hand-edits shipped gateway/dashboard/discord code the way they routinely edit project-side
# skills/agents, so without this a routine Command Center upgrade littered it with a backup of its
# own previous shipped code on every single release.
forge_copy_command_center_tree() {
  local src_dir="$1" dst_dir="$2" manifest_root="$3" old_tsv="${4:-}"
  local file rel status=0 skipped=0 dst_file manifest_rel old_hash cur_dst_hash user_modified cc_prefix cc_rel cc_hash

  if [ ! -d "$src_dir" ]; then
    forge_err "source directory missing: $src_dir"
    return 1
  fi

  # WP-9B-INST (Codex adversarial review, INSTALL-2 HIGH): a symlink/junction planted anywhere under
  # the live Command Center destination tree (e.g. dst_dir/gateway pointing outside the template) would
  # otherwise be followed transparently by cp/mv -- both treat a reparse point exactly like a real
  # directory. Validate the FULL destination tree's ancestry, for every file this run would touch,
  # BEFORE copying anything; the moment one is unsafe, the whole Command Center install for this run is
  # skipped (never partially copied), with a clear message telling the owner to remove the link
  # themselves. This never aborts the rest of the installer -- exactly like a missing command-center/
  # source directory above is not fatal either.
  while IFS= read -r -d '' file; do
    rel="${file#"$src_dir"/}"
    forge_cc_should_skip "$rel" && continue
    if forge_path_has_reparse_ancestor "$dst_dir" "$rel" 1; then
      # WP-9B-INST follow-up (found by self-review, not by tracing the finding alone -- confirmed by a
      # real local run of the new command-center-symlink test): refusing here BEFORE this run records
      # anything for the Command Center means $MANIFEST_TMP/global.tsv ends this run with NO Command
      # Center paths at all -- forge_prune_retired_manifest_files (which runs right after this call, back
      # in main()) would then see every path the OLD global manifest already listed under this Command
      # Center as "no longer shipped this run" and MOVE each one to backup, even though every real file is
      # still sitting there untouched. Carrying every OLD entry under this Command Center's own manifest
      # prefix forward into THIS run's own accumulator (unchanged hash -- the file itself was never
      # touched) tells that step "still shipped, leave it alone" instead, without pretending a copy that
      # did not happen actually happened.
      if [ -n "$manifest_root" ] && [ -s "$old_tsv" ] && [ -n "${MANIFEST_TMP:-}" ] && [ -d "$MANIFEST_TMP" ]; then
        cc_prefix="${dst_dir#"$manifest_root"/}"
        if [ "$cc_prefix" != "$dst_dir" ] && [ -n "$cc_prefix" ]; then
          # Verify Boss VB-02: a row is carried only when its path is a safe relative path, the same check the
          # pruning and the uninstall apply (and install.ps1 applies when it reads the old manifest), so no odd
          # path is copied into the new manifest. forge_manifest_to_tsv already guarantees a real sha256 and a
          # path without control characters.
          while IFS=$'\t' read -r cc_rel cc_hash; do
            forge_is_safe_manifest_rel_path "$cc_rel" || continue
            printf '%s\t%s\n' "$cc_rel" "$cc_hash" >> "$MANIFEST_TMP/global.tsv"
          done < <(awk -F'\t' -v prefix="$cc_prefix/" 'index($1, prefix) == 1' "$old_tsv")
        fi
      fi
      forge_err "refusing to install the Command Center: a symlink or junction was found on the way to '$rel' under $dst_dir — remove that link, then re-run the installer"
      return 1
    fi
  done < <(find "$src_dir" -type f -print0)

  while IFS= read -r -d '' file; do
    rel="${file#"$src_dir"/}"
    if forge_cc_should_skip "$rel"; then
      skipped=$((skipped + 1))
      continue
    fi
    dst_file="$dst_dir/$rel"
    if [ -n "$old_tsv" ] && [ -f "$dst_file" ] && ! cmp -s -- "$file" "$dst_file" 2>/dev/null; then
      manifest_rel="${dst_file#"$manifest_root"/}"
      old_hash=$(forge_manifest_lookup_hash "$old_tsv" "$manifest_rel")
      cur_dst_hash=$(forge_sha256 "$dst_file")
      if [ -n "$old_hash" ] && [ "$old_hash" = "$cur_dst_hash" ]; then user_modified=0; else user_modified=1; fi
      if [ "$DRY_RUN" = "1" ]; then
        if [ "$user_modified" = "1" ]; then
          forge_log "  [dry-run] would back up + overwrite: $dst_file"
        else
          forge_log "  [dry-run] would update (unchanged since install, no backup needed): $dst_file"
        fi
        continue
      fi
      if [ "$user_modified" = "0" ]; then
        # Removing it first lets forge_copy_file's own "create new" path run below -- same end
        # state as a normal overwrite, zero *.forge-bak litter for a file the user never touched.
        rm -f -- "$dst_file"
      fi
    fi
    if ! forge_copy_file "$file" "$dst_file"; then
      status=1
    elif [ "$DRY_RUN" != "1" ]; then
      forge_manifest_add "global" "$manifest_root" "$dst_file"
    fi
  done < <(find "$src_dir" -type f -print0)

  forge_log "  (Command Center: skipped $skipped runtime/build file(s) — node_modules, .data, logs, and similar)"
  return "$status"
}

# Recursively merge-copy every file under $1 (source dir) into $2 (dest dir).
# $3 = "1" routes <dir>/settings.json through forge_copy_settings_file instead of the generic
# backup-then-overwrite path (used for the project payload only — see forge_copy_settings_file).
# $4/$5 (optional) = manifest scope/root — v2.8.0, see forge_manifest_add's header comment. Never
# recorded for settings.json: that file is merged, not owned, and must never be deleted by --uninstall.
# $6 (optional) = a single relative path (e.g. $FORGE_STANDING_RULES_REL) to leave COMPLETELY
# untouched this call — set by forge_check_standing_rules_migration above when an owner rule from a
# pre-v2.8.0 install could not be confirmed safely migrated. Never backed up, never manifested.
# Returns 1 if ANY file failed to copy, 0 only if every file genuinely succeeded.
forge_copy_tree() {
  local src_dir="$1"
  local dst_dir="$2"
  local protect_settings="${3:-0}"
  local manifest_scope="${4:-}"
  local manifest_root="${5:-}"
  local skip_rel="${6:-}"
  local file rel status=0

  if [ ! -d "$src_dir" ]; then
    forge_err "source directory missing: $src_dir"
    return 1
  fi

  # find + while-read handles filenames with spaces safely via -print0/-d ''.
  # IMPORTANT: fed via process substitution (< <(...)), NOT a pipe
  # (find ... | while ...). A pipe forks the while loop into a SUBSHELL in
  # bash, so a failure flag set inside the loop body would be silently lost
  # the instant that subshell exits -- the caller would never see it. Process
  # substitution keeps the loop in the current shell, so `status` set below
  # actually survives to the `return "$status"` at the end of this function.
  while IFS= read -r -d '' file; do
    rel="${file#"$src_dir"/}"
    if [ -n "$skip_rel" ] && [ "$rel" = "$skip_rel" ]; then
      # F4 fix (2026-09-27 independent v2.8.1 review): $skip_rel is now computed identically in a dry
      # run (forge_check_standing_rules_migration already ran, read-only, before this loop -- see its
      # own header comment), so by the time we get here the real outcome is already known; this used
      # to unconditionally say "would check ... before touching it" even though the check had not
      # (and, before this fix, structurally could not) run yet, and even though a REAL run's kept-file
      # message below already says what actually happens. Mirrors that wording instead of guessing.
      if [ "$DRY_RUN" = "1" ]; then
        forge_log "  [dry-run] would keep: $dst_dir/$rel (owner rule migration pending — see message above)"
      else
        forge_log "  kept: $dst_dir/$rel (owner rule migration pending — see warning above)"
      fi
    elif [ "$protect_settings" = "1" ] && [ "$rel" = "settings.json" ]; then
      if ! forge_copy_settings_file "$file" "$dst_dir/$rel"; then
        status=1
      fi
    elif ! forge_copy_file "$file" "$dst_dir/$rel"; then
      status=1
    elif [ "$DRY_RUN" != "1" ] && [ -n "$manifest_scope" ]; then
      forge_manifest_add "$manifest_scope" "$manifest_root" "$dst_dir/$rel"
    fi
  done < <(find "$src_dir" -type f -print0)

  return "$status"
}

# ---------------------------------------------------------------------------
# Uninstall (v2.8.0) — removes exactly what an install wrote, verified by hash.
# ---------------------------------------------------------------------------

# forge_resolve_source_for_uninstall <pipe_mode> <script_dir> <forge_ref> <is_dry_run> — mirrors
# main()'s own in-place-or-download detection (kept separate rather than refactored into a shared
# helper, to avoid touching the already-reviewed install path) so --uninstall's pre-2.8.0
# (no-manifest) fallback can hash-compare against the identical shipped payload. Prints the
# resolved source dir (empty if none could be found/downloaded). Sets global UNINSTALL_TMP_DIR
# when a download temp dir was created, for the caller to clean up.
forge_resolve_source_for_uninstall() {
  local pipe_mode="$1" script_dir="$2" forge_ref="$3" is_dry_run="$4"
  local src="" archive_url archive_path
  if [ "$pipe_mode" != "1" ] && [ -d "$script_dir/global-install/.claude" ] && [ -d "$script_dir/.claude" ]; then
    printf '%s\n' "$script_dir"
    return 0
  fi
  if [ "$is_dry_run" = "1" ]; then
    printf ''
    return 0
  fi
  UNINSTALL_TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'forge-uninstall')
  archive_url="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${forge_ref}.tar.gz"
  archive_path="$UNINSTALL_TMP_DIR/claude-forge.tar.gz"
  if forge_have_cmd curl; then
    curl -fsSL "$archive_url" -o "$archive_path" 2>/dev/null || { printf ''; return 0; }
  elif forge_have_cmd wget; then
    wget -q -O "$archive_path" "$archive_url" 2>/dev/null || { printf ''; return 0; }
  else
    printf ''
    return 0
  fi
  forge_have_cmd tar || { printf ''; return 0; }
  tar -xzf "$archive_path" -C "$UNINSTALL_TMP_DIR" 2>/dev/null || { printf ''; return 0; }
  src=$(find "$UNINSTALL_TMP_DIR" -maxdepth 1 -type d -name "${REPO_NAME}-*" 2>/dev/null | head -n 1)
  if [ -z "$src" ] || [ ! -d "$src/global-install/.claude" ]; then
    printf ''
    return 0
  fi
  printf '%s\n' "$src"
}

# forge_remove_empty_dirs <dir> <stop_at> — walks upward from <dir> toward (but never removing)
# <stop_at>, removing one directory at a time. `rmdir` itself refuses a non-empty directory — that
# refusal IS the safety net here; this can never escalate to a recursive delete.
forge_remove_empty_dirs() {
  local dir="$1" stop_at="$2" stop_full cur_full
  stop_full=$(forge_resolve_dir "$stop_at")
  while [ -d "$dir" ]; do
    cur_full=$(forge_resolve_dir "$dir")
    [ "$cur_full" != "$stop_full" ] || break
    rmdir -- "$dir" 2>/dev/null || break
    dir=$(dirname -- "$dir")
  done
}

# forge_remove_manifest_files <root_dir> <manifest_json_path> <is_dry_run> — the manifest-driven
# removal path (2.8.0+ installs). Deletes a listed file only when its current sha256 still matches
# what the installer recorded; a file you edited yourself differs and is kept. Sets the globals
# FORGE_LAST_REMOVED/FORGE_LAST_KEPT/FORGE_LAST_MISSING for the caller to read back -- NOT printed
# as a return value on stdout, because this function's own forge_log progress lines (which a real
# user needs to see) ALSO go to stdout; a caller capturing this function via `$(...)` would get
# those log lines and the count line mixed into one string with no reliable way to tell them apart.
# forge_manifest_to_tsv <manifest_json_path> <out_tsv_path> — v2.9.0 (WP-P3b): parses
# manifest_json_path's "files" array (if it exists and parses) into "path<TAB>sha256" lines written
# to out_tsv_path (left EMPTY -- never left missing -- when the manifest does not exist, is
# unreadable/malformed, or node is unavailable; every caller already treats an empty tsv the same way
# it treats "no prior manifest"). Factored out of forge_remove_manifest_files so
# forge_prune_retired_manifest_files/forge_manifest_lookup_hash below can read the SAME old-manifest
# snapshot without a second, differently-written copy of this parse.
forge_manifest_to_tsv() {
  local manifest_json="$1" out_tsv="$2"
  : > "$out_tsv"
  [ -f "$manifest_json" ] || return 0
  forge_have_cmd node || return 0
  # WP-9B-INST (Codex adversarial review, INSTALL-1 HIGH): this parse deliberately does NOT validate
  # f.path here -- it has no root_dir to validate a path AGAINST (this function only ever sees
  # manifest_json/out_tsv), and this function's own stderr is already discarded below, by design, for
  # a malformed manifest generally (a warning written here could never actually reach the user). Every
  # real consumer of out_tsv (forge_prune_retired_manifest_files, and forge_remove_manifest_files via
  # its own call to this same function) re-validates each path with forge_manifest_path_is_contained --
  # a real root_dir AND a real forge_log/forge_err are both available there, where an unsafe path can
  # actually be rejected with a warning the user sees, not silently dropped. The two carries into the NEW
  # manifest act on no file: the CLAUDE.md carry rebuilds its line from its own path, and the Command
  # Center carry keeps only rows that pass forge_is_safe_manifest_rel_path (Verify Boss VB-02).
  # Codex release gate RG-02-A: out_tsv is tab-separated and line-based, so an entry is written only when its
  # path holds no tab, newline or other control character and its hash is a real sha256 (exactly 64 hex).
  # Otherwise one forged field could split into extra rows -- rows the Command Center carry and the
  # CLAUDE.md carry would copy into the NEW manifest. A skipped entry is simply not trusted: nothing is
  # pruned, removed or carried on its account.
  node -e '
    const fs = require("fs");
    let j;
    try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
    const files = Array.isArray(j.files) ? j.files : [];
    const CONTROL = /[\u0000-\u001f\u007f]/;
    const SHA256 = /^[0-9a-fA-F]{64}$/;
    for (const f of files) {
      if (!f || typeof f.path !== "string" || typeof f.sha256 !== "string") continue;
      if (f.path === "" || CONTROL.test(f.path) || !SHA256.test(f.sha256)) continue;
      process.stdout.write(f.path + "\t" + f.sha256 + "\n");
    }
  ' "$manifest_json" > "$out_tsv" 2>/dev/null || : > "$out_tsv"
  return 0
}

# forge_manifest_lookup_hash <tsv_file> <rel> — the sha256 recorded for the exact path <rel> in
# tsv_file (a "path<TAB>sha256" file, e.g. one forge_manifest_to_tsv just wrote), or empty when
# tsv_file is empty/missing or has no line for that path. A plain linear grep -F is intentional here
# (matches this installer's existing per-file granularity for hashing/copying -- see forge_sha256 and
# forge_copy_file, both already called once per file) rather than an associative-array cache: stock
# macOS /bin/bash (3.2) has no associative arrays, and this installer stays compatible with it (see
# forge_remove_gitignore_lines's own header comment).
forge_manifest_lookup_hash() {
  local tsv_file="$1" rel="$2" line
  [ -n "$tsv_file" ] && [ -f "$tsv_file" ] || { printf ''; return 0; }
  line=$(grep -F -- "$(printf '%s\t' "$rel")" "$tsv_file" 2>/dev/null | head -1)
  [ -n "$line" ] || { printf ''; return 0; }
  printf '%s\n' "${line#*$'\t'}"
}

forge_remove_manifest_files() {
  local root_dir="$1" manifest_json="$2" is_dry_run="$3"
  local removed=0 kept=0 missing=0 rejected=0 rel hash abs cur_hash dir
  local dirs_file tsv_file
  dirs_file=$(mktemp 2>/dev/null || mktemp -t forge-dirs)
  : > "$dirs_file"
  if forge_have_cmd node; then
    tsv_file=$(mktemp 2>/dev/null || mktemp -t forge-manifest-tsv)
    forge_manifest_to_tsv "$manifest_json" "$tsv_file"
    while IFS=$'\t' read -r rel hash; do
      [ -n "$rel" ] || continue
      # WP-9B-INST (Codex adversarial review, INSTALL-1 HIGH -- same untrusted-manifest-path class,
      # reachable here via --uninstall on a forged/shared project's own manifest): never trust a
      # manifest path enough to hash-then-delete it without the same safety check the
      # retirement-pruning path (forge_prune_retired_manifest_files) already applies. Rejected with a
      # plain line, never an error that aborts the uninstall.
      if ! forge_manifest_path_is_contained "$root_dir" "$rel"; then
        forge_log "  skipped (unsafe path in the install manifest, refusing to trust it): $rel"
        rejected=$((rejected + 1))
        continue
      fi
      abs="$root_dir/$rel"
      if [ ! -f "$abs" ]; then missing=$((missing + 1)); continue; fi
      cur_hash=$(forge_sha256 "$abs")
      if [ -n "$cur_hash" ] && [ "$cur_hash" = "$hash" ]; then
        if [ "$is_dry_run" = "1" ]; then
          forge_log "  [dry-run] would remove: $abs"
        else
          rm -f -- "$abs"
          forge_log "  removed: $abs"
          dirname -- "$abs" >> "$dirs_file"
        fi
        removed=$((removed + 1))
      else
        forge_log "  kept (you edited this file): $abs"
        kept=$((kept + 1))
      fi
    done < "$tsv_file"
    rm -f -- "$tsv_file" 2>/dev/null
  else
    forge_err "node is not on PATH — cannot read the install manifest safely; nothing was removed"
  fi
  if [ "$is_dry_run" != "1" ]; then
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      forge_remove_empty_dirs "$dir" "$root_dir"
    done < <(sort -u -- "$dirs_file")
  fi
  rm -f -- "$dirs_file" 2>/dev/null
  FORGE_LAST_REMOVED="$removed"
  FORGE_LAST_KEPT="$kept"
  FORGE_LAST_MISSING="$missing"
  FORGE_LAST_REJECTED="$rejected"
}

# forge_remove_payload_fallback <payload_dir> <dest_root> <is_dry_run> [skip_rel] — pre-2.8.0
# (no-manifest) fallback: removes a file under dest_root only when it is byte-identical
# (sha256-equal) to the corresponding file under payload_dir (this installer's own shipped
# payload). Never removes a file that differs (your own edit, or a different release) or one this
# build's payload does not even ship. skip_rel (optional) is a single relative path to always skip
# (used for settings.json — never deleted here, only unmerged). Sets FORGE_LAST_REMOVED/
# FORGE_LAST_KEPT for the caller to read back -- see forge_remove_manifest_files's header comment
# for why this is a global, not a stdout return value.
forge_remove_payload_fallback() {
  local payload_dir="$1" dest_root="$2" is_dry_run="$3" skip_rel="${4:-}"
  local removed=0 kept=0 file rel dest src_hash dst_hash dirs_file
  if [ ! -d "$payload_dir" ]; then
    FORGE_LAST_REMOVED=0
    FORGE_LAST_KEPT=0
    return 0
  fi
  dirs_file=$(mktemp 2>/dev/null || mktemp -t forge-dirs)
  : > "$dirs_file"
  while IFS= read -r -d '' file; do
    rel="${file#"$payload_dir"/}"
    if [ -n "$skip_rel" ] && [ "$rel" = "$skip_rel" ]; then continue; fi
    dest="$dest_root/$rel"
    [ -f "$dest" ] || continue
    src_hash=$(forge_sha256 "$file")
    dst_hash=$(forge_sha256 "$dest")
    if [ -n "$src_hash" ] && [ "$src_hash" = "$dst_hash" ]; then
      if [ "$is_dry_run" = "1" ]; then
        forge_log "  [dry-run] would remove (byte-identical to the shipped payload): $dest"
      else
        rm -f -- "$dest"
        forge_log "  removed: $dest"
        dirname -- "$dest" >> "$dirs_file"
      fi
      removed=$((removed + 1))
    else
      forge_log "  kept (you edited this file, or it is from a different release): $dest"
      kept=$((kept + 1))
    fi
  done < <(find "$payload_dir" -type f -print0)
  if [ "$is_dry_run" != "1" ]; then
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      forge_remove_empty_dirs "$dir" "$dest_root"
    done < <(sort -u -- "$dirs_file")
  fi
  rm -f -- "$dirs_file" 2>/dev/null
  FORGE_LAST_REMOVED="$removed"
  FORGE_LAST_KEPT="$kept"
}

# ---------------------------------------------------------------------------
# Retirement pruning (v2.9.0, WP-P3b) -- files a NEWER version stops shipping, removed on the very
# INSTALL/upgrade that stops shipping them, not just on --uninstall. See install.ps1's identical
# header comment (same three-part split) for the full design rationale; kept in sync there.
#   1. forge_prune_retired_manifest_files       -- a 2.8.0+ install (has a manifest to diff).
#   2. forge_remove_retired_legacy_dashboard_files -- a pre-2.8.0 install (no manifest at all):
#      migrates ONLY .claude/forge-dashboard/{7 files}, matched by known historical content hash.
#   3. forge_remove_legacy_dashboard_state_files -- PORT/DASHBOARD_STATE.json, unconditional either way.
# All three MOVE (never delete) into a dated backup folder, preserving the relative path.
# ---------------------------------------------------------------------------

# forge_move_to_backup <root_dir> <abs_path> <backup_dir> — moves abs_path (known to exist) to
# backup_dir/<abs_path's path relative to root_dir>, creating the backup's parent directory first.
# Prints the backup's absolute path. Shared by all three retirement-pruning functions below.
forge_move_to_backup() {
  local root_dir="$1" abs_path="$2" backup_dir="$3" rel backup_abs backup_parent
  rel="${abs_path#"$root_dir"/}"
  if [ "$rel" = "$abs_path" ]; then rel="${abs_path##*/}"; fi
  backup_abs="$backup_dir/$rel"
  backup_parent="${backup_abs%/*}"
  mkdir -p -- "$backup_parent"
  mv -- "$abs_path" "$backup_abs"
  printf '%s\n' "$backup_abs"
}

# forge_prune_retired_manifest_files <root_dir> <old_tsv> <new_tsv> <backup_dir> <is_dry_run>
# [skip_rel] — point 1 (2.8.0+ installs). old_tsv (forge_manifest_to_tsv's output for the OLD
# manifest) is diffed against new_tsv (this SAME run's own accumulator, $MANIFEST_TMP/<scope>.tsv —
# already exactly "every path this run really shipped for this scope" by construction); a path
# present only in old_tsv is no longer shipped. Moved to backup_dir ONLY when its CURRENT hash still
# matches what was recorded (unmodified since Forge itself wrote it) -- a file you edited yourself
# differs and is kept, reported in one plain line. skip_rel (optional, e.g.
# $FORGE_STANDING_MIGRATION_SKIP) is a single relative path to treat as "still wanted" even though it
# is absent from new_tsv -- forge_copy_tree's OWN skip_rel leaves that exact file completely
# untouched (neither copied nor manifested) when an owner-rule migration is pending, and without this
# exemption it would look identical to "the new version no longer ships this file" and get moved to
# backup, the opposite of what "leave my existing file in place this run" promises (found by
# self-review, not by the test suite -- there was no fixture exercising a pending migration alongside
# a manifest that already lists that same path from a previous, successful install).
# Sets FORGE_LAST_RETIRED/FORGE_LAST_RETIRED_KEPT/FORGE_LAST_RETIRED_MISSING (see
# forge_remove_manifest_files's own header comment for why these are globals, not a stdout value).
forge_prune_retired_manifest_files() {
  local root_dir="$1" old_tsv="$2" new_tsv="$3" backup_dir="$4" is_dry_run="$5" skip_rel="${6:-}"
  local retired=0 kept=0 missing=0 rejected=0 rel hash abs cur_hash backup_abs dirs_file
  FORGE_LAST_RETIRED=0; FORGE_LAST_RETIRED_KEPT=0; FORGE_LAST_RETIRED_MISSING=0; FORGE_LAST_RETIRED_REJECTED=0
  [ -s "$old_tsv" ] || return 0
  dirs_file=$(mktemp 2>/dev/null || mktemp -t forge-dirs)
  : > "$dirs_file"
  while IFS=$'\t' read -r rel hash; do
    [ -n "$rel" ] || continue
    if [ -n "$skip_rel" ] && [ "$rel" = "$skip_rel" ]; then continue; fi
    if [ -s "$new_tsv" ] && grep -qF -- "$(printf '%s\t' "$rel")" "$new_tsv"; then continue; fi
    # WP-9B-INST (Codex adversarial review, INSTALL-1 HIGH): validated here, right before this old
    # manifest path is ever joined to root_dir, hashed, or moved. forge_manifest_to_tsv passes every
    # path through unchecked (see its header), so this one call does both checks: the SHAPE (a normal
    # relative path, no "..") and a live filesystem walk from root_dir, one ancestor at a time, which
    # catches a legitimately-shaped path that a symlink/junction planted under root_dir would redirect.
    if ! forge_manifest_path_is_contained "$root_dir" "$rel"; then
      forge_log "  skipped (this old manifest path does not safely resolve inside $root_dir): $rel"
      rejected=$((rejected + 1))
      continue
    fi
    abs="$root_dir/$rel"
    if [ ! -f "$abs" ]; then missing=$((missing + 1)); continue; fi
    cur_hash=$(forge_sha256 "$abs")
    if [ -n "$cur_hash" ] && [ "$cur_hash" = "$hash" ]; then
      if [ "$is_dry_run" = "1" ]; then
        forge_log "  [dry-run] would retire (no longer shipped by this version): $abs -> $backup_dir/$rel"
      else
        backup_abs=$(forge_move_to_backup "$root_dir" "$abs" "$backup_dir")
        forge_log "  retired (no longer shipped by this version): $abs -> $backup_abs"
        dirname -- "$abs" >> "$dirs_file"
      fi
      retired=$((retired + 1))
    else
      forge_log "  kept (you edited this file, no longer shipped by this version): $abs"
      kept=$((kept + 1))
    fi
  done < "$old_tsv"
  if [ "$is_dry_run" != "1" ]; then
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      forge_remove_empty_dirs "$dir" "$root_dir"
    done < <(sort -u -- "$dirs_file")
  fi
  rm -f -- "$dirs_file" 2>/dev/null
  FORGE_LAST_RETIRED="$retired"
  FORGE_LAST_RETIRED_KEPT="$kept"
  FORGE_LAST_RETIRED_MISSING="$missing"
  FORGE_LAST_RETIRED_REJECTED="$rejected"
}

# forge_remove_retired_legacy_dashboard_files <root_dir> <hash_table_tsv> <backup_dir> <is_dry_run> —
# point 2 (pre-2.8.0, no-manifest installs). hash_table_tsv is the shipped
# .claude/forge-bin/forge-retired-dashboard-hashes.tsv (path<TAB>sha256, '#'-comments skipped, several
# lines sharing one path -- one per historical version). Removes EXACTLY the paths it lists (the 7
# retired dashboard files, never anything else) when the file's CRLF-normalized sha256 matches one of
# that path's known historical shipped hashes; content that matches none of them is left in place.
# Recomputed straight from this repo's git history by
# tests/installer/assert-retired-dashboard-hashes.js, so the two can never silently drift apart.
forge_remove_retired_legacy_dashboard_files() {
  local root_dir="$1" hash_table="$2" backup_dir="$3" is_dry_run="$4"
  local rel abs cur_hash trel thash matched=0 backup_abs dirs_file retired=0 kept=0
  [ -f "$hash_table" ] || return 0
  dirs_file=$(mktemp 2>/dev/null || mktemp -t forge-dirs)
  : > "$dirs_file"
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    abs="$root_dir/$rel"
    [ -f "$abs" ] || continue
    cur_hash=$(forge_sha256_normalized "$abs")
    [ -n "$cur_hash" ] || continue
    matched=0
    while IFS=$'\t' read -r trel thash; do
      thash=${thash%$'\r'}  # a CRLF copy of the table (e.g. files copied around on Windows) must still match
      case "$trel" in \#*|'') continue ;; esac
      [ "$trel" = "$rel" ] || continue
      if [ "$thash" = "$cur_hash" ]; then matched=1; break; fi
    done < "$hash_table"
    if [ "$matched" = "1" ]; then
      if [ "$is_dry_run" = "1" ]; then
        forge_log "  [dry-run] would retire (pre-2.8.0 install, known shipped content): $abs -> $backup_dir/$rel"
      else
        backup_abs=$(forge_move_to_backup "$root_dir" "$abs" "$backup_dir")
        forge_log "  retired (pre-2.8.0 install, known shipped content): $abs -> $backup_abs"
        dirname -- "$abs" >> "$dirs_file"
      fi
      retired=$((retired + 1))
    else
      forge_log "  kept (content does not match a known shipped version -- may be your own file): $abs"
      kept=$((kept + 1))
    fi
  done < <(awk -F'\t' -- '/^#/ {next} !seen[$1]++ && $1 { print $1 }' "$hash_table")
  if [ "$is_dry_run" != "1" ]; then
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      forge_remove_empty_dirs "$dir" "$root_dir"
    done < <(sort -u -- "$dirs_file")
  fi
  rm -f -- "$dirs_file" 2>/dev/null
  FORGE_LAST_RETIRED="$retired"
  FORGE_LAST_RETIRED_KEPT="$kept"
}

# forge_remove_legacy_dashboard_state_files <root_dir> <backup_dir> <is_dry_run> — point 2's other
# half: PORT and DASHBOARD_STATE.json are runtime state the retired dashboard SERVER wrote while
# running, never a file forge_copy_tree itself copied -- so they never have a manifest entry (old or
# new) to diff against, and always need checking, independent of whether a manifest exists for this
# project at all. Unconditional (no hash check): both are pure generated state (see
# templates/gitignore.snippet, which already ignores them for exactly that reason).
forge_remove_legacy_dashboard_state_files() {
  local root_dir="$1" backup_dir="$2" is_dry_run="$3"
  local rel abs backup_abs
  for rel in '.claude/forge-dashboard/PORT' '.claude/forge-dashboard/DASHBOARD_STATE.json'; do
    abs="$root_dir/$rel"
    [ -f "$abs" ] || continue
    if [ "$is_dry_run" = "1" ]; then
      forge_log "  [dry-run] would retire (generated runtime state, not user data): $abs -> $backup_dir/$rel"
    else
      backup_abs=$(forge_move_to_backup "$root_dir" "$abs" "$backup_dir")
      forge_log "  retired (generated runtime state, not user data): $abs -> $backup_abs"
      forge_remove_empty_dirs "$(dirname -- "$abs")" "$root_dir"
    fi
  done
  return 0
}

# forge_remove_gitignore_lines <gitignore> <snippet> <is_dry_run> — removes ONLY the exact lines
# templates/gitignore.snippet added (plus the installer's own header comment), never a line the
# project already had for its own reasons. Collapses a run of blank lines left behind by the
# removal down to at most one, and trims trailing blank lines, without touching any other content.
# Pure-bash (indexed arrays only, no associative arrays) so this stays bash-3.2-compatible for a
# stock macOS /bin/bash.
forge_remove_gitignore_lines() {
  local gi="$1" snippet="$2" is_dry_run="$3"
  if [ ! -f "$gi" ]; then
    forge_log "  kept:  $gi (does not exist — nothing to remove)"
    return 0
  fi
  if [ ! -f "$snippet" ]; then
    forge_log "  skipped: gitignore.snippet is not available — cannot identify which lines Forge added, so $gi was left untouched"
    return 0
  fi
  local header='# --- Forge (added by the claude-forge installer) ---'
  local forge_lines_file line
  forge_lines_file=$(mktemp 2>/dev/null || mktemp -t forge-gi-lines)
  : > "$forge_lines_file"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    printf '%s\n' "$line" >> "$forge_lines_file"
  done < "$snippet"

  local -a kept_lines=()
  local removed_count=0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "$header" ] || grep -qxF -- "$line" "$forge_lines_file" 2>/dev/null; then
      removed_count=$((removed_count + 1))
      continue
    fi
    kept_lines+=("$line")
  done < "$gi"
  rm -f -- "$forge_lines_file" 2>/dev/null

  if [ "$removed_count" -eq 0 ]; then
    forge_log "  kept:  $gi (no Forge lines found — already clean)"
    return 0
  fi
  if [ "$is_dry_run" = "1" ]; then
    forge_log "  [dry-run] would remove $removed_count Forge line(s) from $gi"
    return 0
  fi

  local -a collapsed=()
  local prev_blank=0 is_blank trimmed
  if [ "${#kept_lines[@]}" -gt 0 ]; then
    for line in "${kept_lines[@]}"; do
      trimmed="${line//[[:space:]]/}"
      if [ -z "$trimmed" ]; then is_blank=1; else is_blank=0; fi
      if [ "$is_blank" = "1" ] && [ "$prev_blank" = "1" ]; then continue; fi
      collapsed+=("$line")
      prev_blank="$is_blank"
    done
  fi
  while [ "${#collapsed[@]}" -gt 0 ]; do
    trimmed="${collapsed[${#collapsed[@]}-1]//[[:space:]]/}"
    if [ -z "$trimmed" ]; then
      unset 'collapsed[${#collapsed[@]}-1]'
    else
      break
    fi
  done

  : > "$gi"
  if [ "${#collapsed[@]}" -gt 0 ]; then
    for line in "${collapsed[@]}"; do printf '%s\n' "$line" >> "$gi"; done
  fi
  forge_log "  wrote: $gi (-$removed_count Forge line(s) removed; your own lines kept)"
}

# forge_settings_unmerge <target> <source> <is_dry_run> — settings.json is MERGED on install, so
# it must never be deleted on uninstall; this calls forge-settings-merge.cjs's own `unmerge`
# subcommand (mirrors `apply`: 0 done/no-op, 1 refused-safe, 2 usage) to lift back out exactly the
# entries `apply` added. If the local copy of the tool does not know `unmerge` yet, or node/the
# tool are unavailable, this leaves settings.json completely untouched and says so in one plain
# line — it never falls back to editing the file itself.
#
# DENY-RULES-STAY (security review, WP-S12 in parallel): NEVER pass --remove-deny. `unmerge`
# cannot tell a user's own pre-existing permissions.deny rule (e.g. a Read(./.env) they had
# before installing Forge) from Forge's identical template rule, so removing deny rules on
# uninstall could silently drop a user's own secret protection. Forge's deny rules (.env, keys)
# are harmless to leave behind, so they are kept by default -- only its hooks are unmerged.
# --project-root is passed so the tool's own containment checks apply here exactly as they do
# for `apply` in forge_copy_settings_file above.
forge_settings_unmerge() {
  local target="$1" source="$2" is_dry_run="$3" merge_tool out code target_dir
  if [ ! -f "$target" ]; then
    forge_log "  kept:  $target (does not exist — nothing to unmerge)"
    return 0
  fi
  target_dir=$(dirname -- "$target")
  merge_tool="$(dirname -- "$target_dir")/.claude/forge-bin/forge-settings-merge.cjs"
  if [ ! -f "$merge_tool" ]; then
    forge_log "  kept:  $target unmerged — forge-settings-merge.cjs is not on disk here; left untouched"
    return 0
  fi
  if ! forge_have_cmd node; then
    forge_log "  kept:  $target unmerged — node is not on PATH; left untouched"
    return 0
  fi
  local -a cli_args=(unmerge --target "$target" --source "$source" --project-root "$target_dir")
  [ "$is_dry_run" = "1" ] && cli_args+=(--dry-run)
  if out=$(node "$merge_tool" "${cli_args[@]}" 2>&1); then code=0; else code=$?; fi
  if [ "$code" -eq 0 ]; then
    forge_log "  $out"
    forge_log "  Forge's hooks were removed from settings.json; its read-protection rules for secrets (.env, keys) were left in place on purpose — they are harmless and protect you"
  elif [ "$code" -eq 1 ]; then
    forge_log "  kept:  $target — unmerge refused ($out); left untouched"
  else
    forge_log "  kept:  $target unmerged — this copy of forge-settings-merge.cjs does not support 'unmerge' yet; left untouched"
  fi
}

# forge_clean_stale_pid <pid_file> <is_dry_run> — audit Part II / N8: removes the usage guard's
# own pid file ONLY when it points at a process that is no longer running (checked with `kill -0`,
# a pure liveness probe by exact pid — it sends no signal that terminates anything).
forge_clean_stale_pid() {
  local pid_file="$1" is_dry_run="$2" pid dead=1
  [ -f "$pid_file" ] || return 0
  if forge_have_cmd node; then
    pid=$(node -e '
      try {
        const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        if (j && j.pid) process.stdout.write(String(j.pid));
      } catch {}
    ' "$pid_file" 2>/dev/null || true)
  fi
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    dead=0
  fi
  if [ "$dead" = "1" ]; then
    if [ "$is_dry_run" = "1" ]; then
      forge_log "  [dry-run] would remove stale pid file: $pid_file"
    else
      rm -f -- "$pid_file"
      forge_log "  removed: $pid_file (pointed at a dead process)"
    fi
  else
    forge_log "  kept:  $pid_file (a usage-guard watcher is still running — stop it first: node .claude/forge-bin/usage-guard.cjs stop)"
  fi
}

# forge_uninstall_run — the --uninstall orchestrator. Reads PROJECT_DIR/ASSUME_YES/DRY_RUN/
# DO_GLOBAL/DO_PROJECT/FORGE_REF from main()'s already-parsed globals (same flags install uses).
forge_uninstall_run() {
  forge_log 'claude-forge uninstaller'
  forge_log ''
  [ "$DO_PROJECT" = "1" ] && forge_log "This will remove Forge's own files from: $PROJECT_DIR/.claude (only files the installer itself wrote, verified by hash) and this project's own entry from $HOME/.claude/forge/projects.json"
  [ "$DO_GLOBAL" = "1" ] && forge_log "This will remove Forge's global core from: $HOME/.claude (forge-core skill, /forge, /setup-forge, the canonical template, the Command Center)"
  forge_log "A file you edited yourself, and your own data (memory, run logs, CLAUDE.md, .env), are left in place."
  forge_log ''
  [ "$DRY_RUN" = "1" ] && forge_log "(dry-run mode — nothing will actually be removed)"

  if [ "$ASSUME_YES" != "1" ] && [ "$DRY_RUN" != "1" ]; then
    if [ -t 0 ]; then
      printf 'Proceed with uninstall? [y/N] '
      read -r reply
      case "$reply" in
        y|Y|yes|YES) : ;;
        *) forge_log "Aborted."; exit 0 ;;
      esac
    elif [ -r /dev/tty ]; then
      printf 'Proceed with uninstall? [y/N] '
      if read -r reply < /dev/tty; then
        case "$reply" in
          y|Y|yes|YES) : ;;
          *) forge_log "Aborted."; exit 0 ;;
        esac
      else
        forge_err "could not read a confirmation from /dev/tty — aborting to avoid unattended removal (use --yes or FORGE_YES=1)"
        exit 1
      fi
    else
      forge_err "non-interactive shell and no --yes/-y or FORGE_YES=1 given — aborting to avoid unattended removal"
      exit 1
    fi
  fi

  local pipe_mode script_dir src_dir
  pipe_mode="0"
  if [ -z "${BASH_SOURCE[0]:-}" ]; then
    pipe_mode="1"
    script_dir=""
  else
    script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)
  fi

  UNINSTALL_TMP_DIR=""
  trap '[ -n "${UNINSTALL_TMP_DIR:-}" ] && [ -d "$UNINSTALL_TMP_DIR" ] && rm -rf -- "$UNINSTALL_TMP_DIR"' EXIT INT TERM
  src_dir=$(forge_resolve_source_for_uninstall "$pipe_mode" "$script_dir" "$FORGE_REF" "$DRY_RUN")

  if [ "$DO_PROJECT" = "1" ]; then
    forge_log ''
    forge_log "Project: $PROJECT_DIR/.claude"
    manifest_path="$PROJECT_DIR/.claude/.forge-install-manifest.json"
    if [ -f "$manifest_path" ]; then
      forge_remove_manifest_files "$PROJECT_DIR" "$manifest_path" "$DRY_RUN"
      forge_log "  manifest: removed $FORGE_LAST_REMOVED, kept $FORGE_LAST_KEPT (edited by you), $FORGE_LAST_MISSING already gone"
      [ "$DRY_RUN" = "1" ] || rm -f -- "$manifest_path"
    elif [ -n "$src_dir" ] && [ -d "$src_dir/.claude" ]; then
      forge_log '  no install manifest found (a pre-2.8.0 install) — falling back to a byte-identical comparison against the shipped payload'
      forge_remove_payload_fallback "$src_dir/.claude" "$PROJECT_DIR/.claude" "$DRY_RUN" "settings.json"
      forge_log "  fallback: removed $FORGE_LAST_REMOVED, kept $FORGE_LAST_KEPT"
    else
      forge_log '  no install manifest found, and no payload available to compare against — nothing removed from .claude (run the uninstaller from a claude-forge checkout, or with network access, to use the fallback)'
    fi

    settings_target="$PROJECT_DIR/.claude/settings.json"
    settings_source=""
    if [ -n "$src_dir" ] && [ -f "$src_dir/.claude/settings.json" ]; then
      settings_source="$src_dir/.claude/settings.json"
    fi
    if [ -n "$settings_source" ]; then
      forge_settings_unmerge "$settings_target" "$settings_source" "$DRY_RUN"
    else
      forge_log "  kept:  $settings_target unmerged — no payload settings.json available to unmerge against"
    fi

    if [ -n "$src_dir" ]; then
      forge_remove_gitignore_lines "$PROJECT_DIR/.gitignore" "$src_dir/templates/gitignore.snippet" "$DRY_RUN"
    else
      forge_log "  skipped: .gitignore — no payload gitignore.snippet available to identify Forge's own lines"
    fi

    # v2.9.0 (WP-P3, coordinator follow-up): remove ONLY this project's own entry from the shared
    # projects registry — never the whole file (it is merged/user data, like settings.json; a
    # --global-only uninstall never reaches this branch at all, so it can never touch another
    # project's entry).
    forge_update_projects_registry "$(forge_abs_path "$PROJECT_DIR")" "$DRY_RUN" "remove"

    forge_log ''
    forge_log "  left in place (your own data): CLAUDE.md (if it predates Forge or you edited it), .env, FORGE_MEMORY*.md, .claude/forge-runs/, .claude/agent-memory/, and .claude/settings.json (unmerged above, never deleted)"
  fi

  if [ "$DO_GLOBAL" = "1" ]; then
    forge_log ''
    forge_log "Global: $HOME/.claude"
    g_manifest_path="$HOME/.claude/forge/install-manifest.json"
    if [ -f "$g_manifest_path" ]; then
      forge_remove_manifest_files "$HOME" "$g_manifest_path" "$DRY_RUN"
      forge_log "  manifest: removed $FORGE_LAST_REMOVED, kept $FORGE_LAST_KEPT (edited by you), $FORGE_LAST_MISSING already gone"
      [ "$DRY_RUN" = "1" ] || rm -f -- "$g_manifest_path"
    elif [ -n "$src_dir" ]; then
      forge_log '  no install manifest found (a pre-2.8.0 install) — falling back to a byte-identical comparison against the shipped payload'
      forge_remove_payload_fallback "$src_dir/global-install/.claude" "$HOME/.claude" "$DRY_RUN" ""
      rem1="$FORGE_LAST_REMOVED"; kep1="$FORGE_LAST_KEPT"
      forge_remove_payload_fallback "$src_dir/.claude" "$HOME/.claude/forge/template/.claude" "$DRY_RUN" "settings.json"
      rem2="$FORGE_LAST_REMOVED"; kep2="$FORGE_LAST_KEPT"
      forge_log "  fallback: removed $((rem1 + rem2)), kept $((kep1 + kep2))"
    else
      forge_log '  no install manifest found, and no payload available to compare against — nothing removed from the global core'
    fi

    forge_clean_stale_pid "$HOME/.claude/forge-usage-guard.pid" "$DRY_RUN"

    forge_log ''
    forge_log "  left in place (your own data / other tools' state): FORGE_USAGE_GUARD_STATE.json, FORGE_USAGE_PRESSURE.json, .credentials.json, forge-usage-guard-account-map.json, and anything else under ~/.claude this installer did not write"
  fi

  forge_log ''
  if [ "$DRY_RUN" = "1" ]; then
    forge_log 'Dry run complete. Nothing was removed.'
  else
    forge_log 'claude-forge uninstall complete.'
  fi
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
  PROJECT_DIR="$(pwd)"
  ASSUME_YES="${FORGE_YES:-0}"
  DRY_RUN="0"
  GLOBAL_ONLY="0"
  PROJECT_ONLY="0"
  UNINSTALL="0"
  FORGE_REF="${FORGE_REF:-main}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project)
        [ "$#" -ge 2 ] || { forge_err "--project requires a value"; exit 1; }
        PROJECT_DIR="$2"
        shift 2
        ;;
      --yes|-y)
        ASSUME_YES="1"
        shift
        ;;
      --dry-run)
        DRY_RUN="1"
        shift
        ;;
      --global-only)
        GLOBAL_ONLY="1"
        shift
        ;;
      --project-only)
        PROJECT_ONLY="1"
        shift
        ;;
      --uninstall)
        UNINSTALL="1"
        shift
        ;;
      -h|--help)
        forge_usage
        exit 0
        ;;
      *)
        forge_err "unknown option: $1"
        forge_usage
        exit 1
        ;;
    esac
  done

  if [ "$GLOBAL_ONLY" = "1" ] && [ "$PROJECT_ONLY" = "1" ]; then
    forge_err "--global-only and --project-only are mutually exclusive"
    exit 1
  fi

  export DRY_RUN

  DO_GLOBAL="1"
  DO_PROJECT="1"
  [ "$GLOBAL_ONLY" = "1" ] && DO_PROJECT="0"
  [ "$PROJECT_ONLY" = "1" ] && DO_GLOBAL="0"

  if [ "$UNINSTALL" = "1" ]; then
    forge_uninstall_run
    return 0
  fi

  # -------------------------------------------------------------------------
  # 0. refuse a HOME target (review HIGH #3): a one-liner run from $HOME (e.g.
  #    the Windows %USERPROFILE% prompt) must never treat $HOME itself as the
  #    "project" — that would write the PROJECT payload into ~/.claude and
  #    replace the user's global settings.json. Checked before any download or
  #    write, including in --dry-run, and for --project pointing at $HOME too.
  # -------------------------------------------------------------------------
  if [ "$DO_PROJECT" = "1" ]; then
    HOME_RESOLVED=$(forge_resolve_dir "$HOME")
    PROJECT_RESOLVED=$(forge_resolve_dir "$PROJECT_DIR")
    if [ -n "$HOME_RESOLVED" ] && [ "$PROJECT_RESOLVED" = "$HOME_RESOLVED" ]; then
      forge_err "the target project directory is your home directory ($HOME) — refusing to install the project payload into \$HOME/.claude (that would replace your global settings.json). cd into your project folder, or pass --project <dir>."
      exit 1
    fi

    # Same refusal when <project>/.claude would resolve to the same directory as the global
    # ~/.claude (e.g. a symlinked project dir) even though the project dir itself is not $HOME.
    if [ -d "$PROJECT_DIR/.claude" ] && [ -d "$HOME/.claude" ]; then
      PROJECT_CLAUDE_RESOLVED=$(forge_resolve_dir "$PROJECT_DIR/.claude")
      HOME_CLAUDE_RESOLVED=$(forge_resolve_dir "$HOME/.claude")
      if [ -n "$PROJECT_CLAUDE_RESOLVED" ] && [ "$PROJECT_CLAUDE_RESOLVED" = "$HOME_CLAUDE_RESOLVED" ]; then
        forge_err "<project>/.claude resolves to your global ~/.claude — refusing to overwrite your global settings. Pass --project <dir> pointing at an actual project folder."
        exit 1
      fi
    fi
  fi

  # $BASH_SOURCE is empty when the script runs via curl|bash (no script file on disk). Pipe mode is
  # detected explicitly and NEVER falls back to trusting the current directory (security #10, review
  # #8): a cwd that happens to contain global-install/.claude + .claude would otherwise be installed
  # instead of the official archive, and VERSION/SHA256SUMS would be read from that cwd too.
  PIPE_MODE="0"
  if [ -z "${BASH_SOURCE[0]:-}" ]; then
    PIPE_MODE="1"
    SCRIPT_DIR=""
  else
    SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)
  fi

  TMP_DIR=""
  MANIFEST_TMP=""
  cleanup() {
    if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
      rm -rf -- "$TMP_DIR"
    fi
    if [ -n "$MANIFEST_TMP" ] && [ -d "$MANIFEST_TMP" ]; then
      rm -rf -- "$MANIFEST_TMP"
    fi
  }
  trap cleanup EXIT INT TERM

  # v2.8.0 install manifest scratch space (see forge_manifest_add's header comment above). A plain
  # temp dir the installer owns end to end — created and removed by this same process, never a
  # target the user chose, so its removal above is safe (not a project/user path).
  MANIFEST_TMP=$(mktemp -d 2>/dev/null || mktemp -d -t 'forge-manifest')
  : > "$MANIFEST_TMP/global.tsv"
  : > "$MANIFEST_TMP/project.tsv"

  # v2.9.0 (WP-P3b): snapshot the PREVIOUS install's manifest(s) now, into the SAME scratch dir (so
  # the EXIT/INT/TERM cleanup trap above already removes them too), before forge_write_manifest_file
  # overwrites either JSON file further down -- see forge_manifest_to_tsv's own header comment. Read
  # unconditionally (even for a --global-only/--project-only run touching only one scope, and even
  # under --dry-run) -- it is a pure read; the retirement-pruning calls below already gate on
  # DO_GLOBAL/DO_PROJECT themselves. One shared timestamp for both scopes' backup folders, so a single
  # run never produces two differently-stamped "retired-*" folders.
  OLD_GLOBAL_TSV="$MANIFEST_TMP/global-old.tsv"
  OLD_PROJECT_TSV="$MANIFEST_TMP/project-old.tsv"
  forge_manifest_to_tsv "$HOME/.claude/forge/install-manifest.json" "$OLD_GLOBAL_TSV"
  forge_manifest_to_tsv "$PROJECT_DIR/.claude/.forge-install-manifest.json" "$OLD_PROJECT_TSV"
  PRUNE_STAMP=$(date -u +%Y%m%d-%H%M%S 2>/dev/null || echo unknown)

  # -------------------------------------------------------------------------
  # 1. dual-source detection
  # -------------------------------------------------------------------------
  SOURCE_DIR=""
  if [ "$PIPE_MODE" != "1" ] && [ -d "$SCRIPT_DIR/global-install/.claude" ] && [ -d "$SCRIPT_DIR/.claude" ]; then
    SOURCE_DIR="$SCRIPT_DIR"
    forge_log "Running in place from: $SOURCE_DIR"
  else
    if [ "$PIPE_MODE" = "1" ]; then
      forge_log "Running from a pipe (no script file on disk) — installing from the downloaded archive."
    else
      forge_log "Repo payload not found next to this script — downloading ${REPO_OWNER}/${REPO_NAME}@${FORGE_REF} ..."
    fi

    if [ "$DRY_RUN" = "1" ]; then
      forge_log "  [dry-run] would download https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${FORGE_REF}.tar.gz"
      SOURCE_DIR=""
    else
      TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'forge-install')
      archive_url="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${FORGE_REF}.tar.gz"
      archive_path="$TMP_DIR/claude-forge.tar.gz"

      if forge_have_cmd curl; then
        curl -fsSL "$archive_url" -o "$archive_path"
      elif forge_have_cmd wget; then
        wget -q -O "$archive_path" "$archive_url"
      else
        forge_err "neither curl nor wget is available — cannot download claude-forge"
        exit 1
      fi

      # NOTE: SHA256SUMS is only present on tagged release archives. When it is absent (e.g. a plain
      # git clone) the download is simply not hash-verified — that is stated, never silently skipped.
      # Skipped entirely in pipe mode: there is no script-adjacent SCRIPT_DIR to trust for this lookup.
      if [ "$PIPE_MODE" != "1" ] && [ -f "$SCRIPT_DIR/SHA256SUMS" ] && forge_have_cmd sha256sum; then
        expected=$(grep "claude-forge.tar.gz" "$SCRIPT_DIR/SHA256SUMS" 2>/dev/null | awk '{print $1}' || true)
        if [ -n "$expected" ]; then
          actual=$(sha256sum "$archive_path" | awk '{print $1}')
          if [ "$expected" != "$actual" ]; then
            forge_err "checksum mismatch for downloaded archive (expected $expected, got $actual)"
            exit 1
          fi
          forge_log "  checksum verified"
        fi
      fi

      forge_have_cmd tar || { forge_err "tar is required to extract the downloaded archive"; exit 1; }
      tar -xzf "$archive_path" -C "$TMP_DIR"

      SOURCE_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d -name "${REPO_NAME}-*" | head -n 1)
      if [ -z "$SOURCE_DIR" ] || [ ! -d "$SOURCE_DIR/global-install/.claude" ]; then
        forge_err "downloaded archive did not contain the expected claude-forge payload"
        exit 1
      fi
      forge_log "Downloaded to: $SOURCE_DIR"
    fi
  fi

  # SOURCE_DIR is checked FIRST: when a download happened (pipe mode or a missing in-place payload),
  # VERSION must come from what was actually downloaded, never from cwd/SCRIPT_DIR (review #8/#10).
  # The SCRIPT_DIR fallback below only ever fires in dry-run (no download occurred) and never in pipe
  # mode, where SCRIPT_DIR is intentionally empty.
  if [ -n "$SOURCE_DIR" ] && [ -f "$SOURCE_DIR/VERSION" ]; then
    FORGE_VERSION=$(cat "$SOURCE_DIR/VERSION" 2>/dev/null || echo "unknown")
  elif [ "$PIPE_MODE" != "1" ] && [ -f "$SCRIPT_DIR/VERSION" ]; then
    FORGE_VERSION=$(cat "$SCRIPT_DIR/VERSION" 2>/dev/null || echo "unknown")
  else
    FORGE_VERSION="unknown"
  fi
  forge_log "claude-forge version: $FORGE_VERSION"

  # -------------------------------------------------------------------------
  # 2. plan (DO_GLOBAL / DO_PROJECT were computed early, ahead of the HOME guard above)
  # -------------------------------------------------------------------------
  forge_log ""
  forge_log "This will write files to:"
  # OUTSIDE-WRITES-BY-DEFAULT (wp-f2, 2026-09-24 Codex re-check): both of these are real writes OUTSIDE this
  # project (global, shared by every project on this machine) and on by default — named as such rather than
  # left implicit.
  [ "$DO_GLOBAL" = "1" ] && forge_log "  - $HOME/.claude                  [OUTSIDE this project -- global, shared by every project] (global core: forge-core skill, /forge, /setup-forge)"
  [ "$DO_GLOBAL" = "1" ] && forge_log "  - $HOME/.claude/forge/template   [OUTSIDE this project -- global] (canonical template: used by forge-sync and the auto-installer)"
  # v2.9.0 (WP-P3): the Command Center (local dashboard + gateway) is installed ONCE, centrally,
  # next to the canonical template -- never per-project -- so every project shares the same
  # dashboard at http://127.0.0.1:4100.
  [ "$DO_GLOBAL" = "1" ] && forge_log "  - $HOME/.claude/forge/template/command-center   [OUTSIDE this project -- global] (Command Center: the local dashboard + gateway at http://127.0.0.1:4100)"
  [ "$DO_PROJECT" = "1" ] && forge_log "  - $PROJECT_DIR/.claude           (per-project payload: skills, agents, dashboard, config)"
  [ "$DO_PROJECT" = "1" ] && forge_log "  - $PROJECT_DIR/CLAUDE.md         (only if missing) and $PROJECT_DIR/.gitignore (Forge lines appended)"
  [ "$DO_PROJECT" = "1" ] && forge_log "  - $HOME/.claude/forge/projects.json   [OUTSIDE this project -- global] (records this project's path so the Command Center dashboard can find it)"
  forge_log ""
  forge_log "Existing files that differ are backed up as <file>.forge-bak-<timestamp> and replaced — except .claude/settings.json, which is MERGED (your own hooks/rules kept, a backup taken first); when a merge is not possible, a settings.forge-recommended-<timestamp>.json is written next to it instead and settings.json itself is left untouched."
  forge_log "Identical files are left untouched. This installer never deletes your existing .claude tree."
  forge_log ""

  if [ "$DRY_RUN" = "1" ]; then
    forge_log "(dry-run mode — no files will actually be written)"
  fi

  if [ "$ASSUME_YES" != "1" ] && [ "$DRY_RUN" != "1" ]; then
    if [ -t 0 ]; then
      printf 'Proceed? [y/N] '
      read -r reply
      case "$reply" in
        y|Y|yes|YES) : ;;
        *) forge_log "Aborted."; exit 0 ;;
      esac
    elif [ -r /dev/tty ]; then
      # stdin is a pipe (curl|bash) but a real terminal is still attached at /dev/tty — read the
      # confirmation from there instead of failing a perfectly interactive pipe install (review HIGH #2).
      printf 'Proceed? [y/N] '
      if read -r reply < /dev/tty; then
        case "$reply" in
          y|Y|yes|YES) : ;;
          *) forge_log "Aborted."; exit 0 ;;
        esac
      else
        forge_err "could not read a confirmation from /dev/tty — aborting to avoid unattended writes (use --yes or FORGE_YES=1)"
        exit 1
      fi
    else
      forge_err "non-interactive shell and no --yes/-y or FORGE_YES=1 given — aborting to avoid unattended writes"
      exit 1
    fi
  fi

  if [ -z "$SOURCE_DIR" ]; then
    # dry-run download path never produced a SOURCE_DIR — nothing left to do
    forge_log ""
    forge_log "Dry run complete. No files were written."
    return 0
  fi

  # -------------------------------------------------------------------------
  # 3. merge-safe copy
  # -------------------------------------------------------------------------
  GLOBAL_OK="1"
  PROJECT_OK="1"
  # Set by forge_copy_settings_file (V07, wp-g2 2026-09-24 Codex re-check out-p7.md) whenever the
  # PreToolUse gate hook did NOT end up merged into <project>/.claude/settings.json for any reason
  # (refused merge, a directory/unreadable/malformed target, node unavailable, a guarded write itself
  # failing) — checked below so the final summary names the gate specifically, never just a generic
  # "install failed".
  FORGE_SETTINGS_GATE_FAILED="0"

  if [ "$DO_GLOBAL" = "1" ]; then
    forge_log ""
    forge_log "Installing global core -> $HOME/.claude"
    if forge_copy_tree "$SOURCE_DIR/global-install/.claude" "$HOME/.claude" "0" "global" "$HOME"; then
      GLOBAL_OK="1"
    else
      GLOBAL_OK="0"
    fi
    # The CANONICAL TEMPLATE (external audit II-A, 2026-09-23). The forge-core skill sends every
    # "install Forge V2 into this project", every bare-folder auto-install and the whole "stay current"
    # rule to ~/.claude/forge/template/ — and this installer never created it, so all three pointed at
    # nothing, and `forge-sync status` compared each project with itself ("up to date" forever). The
    # template is simply the project payload plus the two root seeds, kept where the skill looks for it.
    TEMPLATE_DIR="$HOME/.claude/forge/template"
    forge_log ""
    forge_log "Installing canonical template -> $TEMPLATE_DIR (used by forge-sync and the auto-installer)"
    if forge_copy_tree "$SOURCE_DIR/.claude" "$TEMPLATE_DIR/.claude" "0" "global" "$HOME"; then
      if [ "$DRY_RUN" != "1" ]; then
        if [ -f "$SOURCE_DIR/templates/project-CLAUDE.md" ]; then
          cp -- "$SOURCE_DIR/templates/project-CLAUDE.md" "$TEMPLATE_DIR/CLAUDE.md"
          forge_manifest_add "global" "$HOME" "$TEMPLATE_DIR/CLAUDE.md"
        fi
        if [ -f "$SOURCE_DIR/templates/gitignore.snippet" ]; then
          cp -- "$SOURCE_DIR/templates/gitignore.snippet" "$TEMPLATE_DIR/gitignore.snippet"
          forge_manifest_add "global" "$HOME" "$TEMPLATE_DIR/gitignore.snippet"
        fi
        if [ -f "$SOURCE_DIR/.env.example" ]; then
          cp -- "$SOURCE_DIR/.env.example" "$TEMPLATE_DIR/env.example"
          forge_manifest_add "global" "$HOME" "$TEMPLATE_DIR/env.example"
        fi
      fi
    else
      forge_err "canonical template copy had failures (project installs still work; forge-sync update checks will not)"
      GLOBAL_OK="0"
    fi

    # v2.9.0 (WP-P3): the Command Center (command-center/gateway + command-center/discord +
    # command-center/dashboard) is installed ONCE, centrally, next to the canonical template --
    # never per-project (see forge_cc_should_skip/forge_copy_command_center_tree's own header
    # comments for exactly what is skipped and why). A source checkout without a command-center/
    # directory at all (an old release, or a stripped-down archive) is not an error -- this
    # installer's own job is copying whatever the payload actually ships.
    CC_SOURCE_DIR="$SOURCE_DIR/command-center"
    if [ -d "$CC_SOURCE_DIR" ]; then
      CC_DEST_DIR="$TEMPLATE_DIR/command-center"
      forge_log ""
      forge_log "Installing Command Center -> $CC_DEST_DIR (local dashboard + gateway, http://127.0.0.1:4100)"
      # Requirement 1 (WP-P3): dashboard/dist is the PREBUILT dashboard the gateway serves as static
      # files. When this download does not ship it (an older archive, or a stripped release before
      # the dashboard build step is wired in), this says so ONCE, plainly -- it never tells a
      # beginner to run a build command themselves; everything else in the Command Center still
      # installs normally.
      if [ ! -d "$CC_SOURCE_DIR/dashboard/dist" ]; then
        forge_log "  NOTE: command-center/dashboard/dist is missing from this download — the dashboard's built files were not included. Everything else in the Command Center was still installed; the dashboard page itself will not load until a build that includes dashboard/dist is installed."
      fi
      if ! forge_copy_command_center_tree "$CC_SOURCE_DIR" "$CC_DEST_DIR" "$HOME" "$OLD_GLOBAL_TSV"; then
        forge_err "Command Center copy had failures (project installs still work; the dashboard may not start correctly)"
        GLOBAL_OK="0"
      fi
    fi

    # v2.9.0 (WP-P3b): retirement pruning for the "global" scope -- runs AFTER every global copy
    # above, so $MANIFEST_TMP/global.tsv already holds every path this run really shipped (core +
    # template + Command Center, all one scope, all rooted at $HOME), and BEFORE forge_write_manifest_file
    # overwrites the manifest OLD_GLOBAL_TSV was read from.
    GLOBAL_BACKUP_DIR="$HOME/.claude/forge/backups/retired-$PRUNE_STAMP"
    if [ -s "$OLD_GLOBAL_TSV" ]; then
      forge_prune_retired_manifest_files "$HOME" "$OLD_GLOBAL_TSV" "$MANIFEST_TMP/global.tsv" "$GLOBAL_BACKUP_DIR" "$DRY_RUN"
    elif [ -n "${TEMPLATE_DIR:-}" ]; then
      # Pre-2.8.0 global install (no manifest at all yet): the one concrete migration this release
      # needs is the canonical template's own copy of the retired dashboard files. Backed up under the
      # SAME relative path a 2.8.0+ manifest would have recorded it at (".claude/forge/template/...")
      # so a legacy and a manifest-driven retirement land in a consistent shape under
      # GLOBAL_BACKUP_DIR, even though this fallback never reads/writes a manifest itself.
      LEGACY_HASH_TABLE="$SOURCE_DIR/.claude/forge-bin/forge-retired-dashboard-hashes.tsv"
      forge_remove_retired_legacy_dashboard_files "$TEMPLATE_DIR" "$LEGACY_HASH_TABLE" "$GLOBAL_BACKUP_DIR/.claude/forge/template" "$DRY_RUN"
    fi
  fi

  if [ "$DO_PROJECT" = "1" ]; then
    forge_log ""
    forge_log "Installing project payload -> $PROJECT_DIR/.claude"
    # COR-DRYRUN (wp-f2, 2026-09-24 Codex re-check): this ran UNCONDITIONALLY, even under --dry-run,
    # contradicting "--dry-run shows every write without making one" -- a preview into a not-yet-existing
    # target directory silently created it. Guarded like every other write in this installer now.
    if [ "$DRY_RUN" = "1" ]; then
      [ -d "$PROJECT_DIR" ] || forge_log "  [dry-run] would create directory: $PROJECT_DIR"
    else
      mkdir -p -- "$PROJECT_DIR"
    fi
    # 3.4 fix (WP-P3): move any v2.7-era owner standing rule into the project's own user file BEFORE
    # FORGE_STANDING_RULES.json is ever compared/replaced below — the same preflight forge-sync.cjs
    # itself runs before its own writes.
    # F4 fix (2026-09-27 independent v2.8.1 review): this used to skip the real check entirely under
    # --dry-run (setting FORGE_STANDING_MIGRATION_SKIP="" unconditionally and printing a generic
    # "would check" line that could never actually reflect the outcome), so a dry run always reported
    # "would back up + overwrite" even for a rules file a real run would keep. The check itself is a
    # true read-only operation all the way through in dry-run mode (see its own header comment and
    # migrateOwnerStandingRules()'s dryRun option in forge-sync.cjs) — it is now always run, with
    # is_dry_run passed straight through, so --dry-run previews the exact same outcome a real run
    # would reach and never writes anything either way.
    forge_check_standing_rules_migration "$PROJECT_DIR" "$SOURCE_DIR/.claude" "$DRY_RUN"
    if forge_copy_tree "$SOURCE_DIR/.claude" "$PROJECT_DIR/.claude" "1" "project" "$PROJECT_DIR" "$FORGE_STANDING_MIGRATION_SKIP"; then
      PROJECT_OK="1"
    else
      PROJECT_OK="0"
    fi
    # Seed the two project-root files Forge documents but the payload copy never delivered.
    # Added 2026-08-13 after a real fresh-install measurement: without these, three suites
    # (forge-configdrift, forge-tool-index, forge-toolhook) fail on a brand-new project and
    # the very first `forge-doctor` a new user runs reports FAILURES.
    # Both are merge-safe: an existing CLAUDE.md is never touched, and .gitignore only ever
    # gets lines it does not already have.
    forge_seed_project_root "$PROJECT_DIR"
    # Record WHICH release this project got. `forge-sync status` reads forge_version from this file;
    # without it a fresh install reports "installed=none" (2.4.0: the payload no longer ships a stale
    # copy of this per-install file — the installer writes the real value).
    forge_write_version_marker "$PROJECT_DIR"
    # v2.9.0 (WP-P3, coordinator follow-up): record this project so the Command Center dashboard can
    # find it even outside its default scan roots (Documents/Desktop/its own parent folder). See
    # FORGE_PROJECTS_REGISTRY_JS's own header comment for the file contract and why a missing `node`
    # only warns, never fails the install. forge_abs_path (not forge_resolve_dir) because $PROJECT_DIR
    # was just created by this same block's own `mkdir -p` a few lines above, and must resolve to an
    # absolute path even in a --dry-run preview where it was never actually created.
    forge_update_projects_registry "$(forge_abs_path "$PROJECT_DIR")" "$DRY_RUN" "add"

    # v2.9.0 (WP-P3b): retirement pruning for the "project" scope -- same shape as the "global" block
    # above, rooted at $PROJECT_DIR. Runs AFTER the project copy, so $MANIFEST_TMP/project.tsv already
    # holds every path this run really shipped, and BEFORE forge_write_manifest_file overwrites the
    # manifest OLD_PROJECT_TSV was read from.
    PROJECT_BACKUP_DIR="$PROJECT_DIR/.claude/forge-backups/retired-$PRUNE_STAMP"
    if [ -s "$OLD_PROJECT_TSV" ]; then
      # PATH-PREFIX TRAP (found by re-deriving this value independently right after writing the first
      # pass, not by the test suite alone): FORGE_STANDING_MIGRATION_SKIP is relative to .claude/
      # itself (what forge_copy_tree's own per-file loop compares it against), but every manifest path
      # (old and new alike) is relative to the PROJECT ROOT -- ".claude/" must be prepended here or
      # forge_prune_retired_manifest_files's skip_rel exemption silently never matches anything.
      PRUNE_SKIP_REL=""
      [ -n "$FORGE_STANDING_MIGRATION_SKIP" ] && PRUNE_SKIP_REL=".claude/$FORGE_STANDING_MIGRATION_SKIP"
      forge_prune_retired_manifest_files "$PROJECT_DIR" "$OLD_PROJECT_TSV" "$MANIFEST_TMP/project.tsv" "$PROJECT_BACKUP_DIR" "$DRY_RUN" "$PRUNE_SKIP_REL"
    else
      # Pre-2.8.0 project install (no manifest at all yet): migrate the retired dashboard files by
      # their known historical content hash instead.
      LEGACY_HASH_TABLE="$SOURCE_DIR/.claude/forge-bin/forge-retired-dashboard-hashes.tsv"
      forge_remove_retired_legacy_dashboard_files "$PROJECT_DIR" "$LEGACY_HASH_TABLE" "$PROJECT_BACKUP_DIR" "$DRY_RUN"
    fi
    # Unconditional either way (point 2's other half): PORT/DASHBOARD_STATE.json are runtime state the
    # OLD dashboard SERVER wrote, never something any manifest (old or new) ever recorded.
    forge_remove_legacy_dashboard_state_files "$PROJECT_DIR" "$PROJECT_BACKUP_DIR" "$DRY_RUN"
  fi

  # v2.8.0: persist the manifest(s) an uninstall will read back — see forge_manifest_add's header
  # comment. Only for the scope(s) this run actually touched, and never on a dry-run (which never
  # wrote anything real to hash in the first place).
  if [ "$DRY_RUN" != "1" ]; then
    [ "$DO_GLOBAL" = "1" ] && forge_write_manifest_file "global" "$HOME/.claude/forge/install-manifest.json" "$FORGE_VERSION"
    [ "$DO_PROJECT" = "1" ] && forge_write_manifest_file "project" "$PROJECT_DIR/.claude/.forge-install-manifest.json" "$FORGE_VERSION"
  fi

  # -------------------------------------------------------------------------
  # 4. success epilogue — gated on real status, never unconditional
  # -------------------------------------------------------------------------
  if [ "$DRY_RUN" = "1" ]; then
    forge_log ""
    forge_log "Dry run complete. No files were written."
    return 0
  fi

  if [ "$DO_GLOBAL" = "1" ] && [ "$GLOBAL_OK" != "1" ]; then
    forge_err "global core install failed — see errors above"
    exit 1
  fi
  if [ "$DO_PROJECT" = "1" ] && [ "$PROJECT_OK" != "1" ]; then
    if [ "$FORGE_SETTINGS_GATE_FAILED" = "1" ]; then
      forge_err "project install failed: the PreToolUse gate hook was NOT installed into $PROJECT_DIR/.claude/settings.json — see errors above"
    else
      forge_err "project install failed — see errors above"
    fi
    exit 1
  fi

  # F5 fix (2026-09-27 independent v2.8.1 review): this used to always say "fix the JSON in ...
  # user.json", even when FORGE_STANDING_MIGRATION_SKIP was set for a completely different reason
  # (node missing, a symlink/containment refusal, a write failure, or, after F2, the template file
  # itself being unreadable). FORGE_STANDING_MIGRATION_REASON is set by forge_check_standing_rules_
  # migration to the real cause every time it sets SKIP; this note now names that cause instead of
  # guessing one.
  if [ -n "${FORGE_STANDING_MIGRATION_SKIP:-}" ]; then
    forge_log ""
    forge_log "NOTE: $PROJECT_DIR/.claude/$FORGE_STANDING_RULES_REL was left as-is this run — ${FORGE_STANDING_MIGRATION_REASON:-an owner rule from a pre-v2.8.0 install is pending migration}. Re-run install once that is fixed so it can be applied safely."
  fi

  forge_log ""
  forge_log "claude-forge $FORGE_VERSION installed successfully."
  forge_log ""
  forge_log "Next steps:"
  forge_log "  cd \"$PROJECT_DIR\" && claude"
  forge_log "  /setup-forge"
  forge_log "  /forge <task>"
  forge_log ""
  # Requirement 5 (WP-P3): one plain line telling a beginner how to open the dashboard this install
  # just set up. Only printed when this run actually installed/ensured the Command Center
  # (DO_GLOBAL) -- a --project-only run against a machine that never ran a full install would
  # otherwise point at a dashboard that is not there yet.
  if [ "$DO_GLOBAL" = "1" ]; then
    forge_log "Dashboard: open http://127.0.0.1:4100 (type \`/forge dashboard\` inside Claude Code in a project, or double-click start-forge-dashboard.bat in a project's .claude/forge-dashboard folder)"
    forge_log ""
  fi
  forge_log "Docs: https://github.com/${REPO_OWNER}/${REPO_NAME}#readme"
}

main "$@"
