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
forge_sha256() {
  local p
  p=$(printf '%s' "$1" | tr '\\' '/' 2>/dev/null)
  if forge_have_cmd sha256sum; then
    sha256sum -- "$p" 2>/dev/null | awk '{print $1}'
  elif forge_have_cmd shasum; then
    shasum -a 256 -- "$p" 2>/dev/null | awk '{print $1}'
  else
    printf ''
  fi
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
  [ -f "$abspath" ] || return 0
  rel="${abspath#"$root"/}"
  [ "$rel" != "$abspath" ] || return 0
  hash=$(forge_sha256 "$abspath")
  [ -n "$hash" ] || return 0
  printf '%s\t%s\n' "$rel" "$hash" >> "$MANIFEST_TMP/$scope.tsv"
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
    while IFS=$'\t' read -r rel hash; do
      [ -n "$rel" ] || continue
      if [ "$first" = "1" ]; then first=0; else printf ',\n'; fi
      esc_rel=$(printf '%s' "$rel" | sed 's/\\/\\\\/g; s/"/\\"/g')
      printf '    { "path": "%s", "sha256": "%s" }' "$esc_rel" "$hash"
    done < <(sort -- "$tsv")
    printf '\n  ]\n}\n'
  } > "$dest"
  count=$(wc -l < "$tsv" | tr -d '[:space:]')
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

  dst_dir=$(dirname -- "$dst_file")

  if [ "$DRY_RUN" = "1" ]; then
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

  if ! mkdir -p -- "$dst_dir"; then
    forge_err "failed to create directory: $dst_dir"
    return 1
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
  forge_log "  wrote: $dst_file"
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

# Recursively merge-copy every file under $1 (source dir) into $2 (dest dir).
# $3 = "1" routes <dir>/settings.json through forge_copy_settings_file instead of the generic
# backup-then-overwrite path (used for the project payload only — see forge_copy_settings_file).
# $4/$5 (optional) = manifest scope/root — v2.8.0, see forge_manifest_add's header comment. Never
# recorded for settings.json: that file is merged, not owned, and must never be deleted by --uninstall.
# Returns 1 if ANY file failed to copy, 0 only if every file genuinely succeeded.
forge_copy_tree() {
  local src_dir="$1"
  local dst_dir="$2"
  local protect_settings="${3:-0}"
  local manifest_scope="${4:-}"
  local manifest_root="${5:-}"
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
    if [ "$protect_settings" = "1" ] && [ "$rel" = "settings.json" ]; then
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
forge_remove_manifest_files() {
  local root_dir="$1" manifest_json="$2" is_dry_run="$3"
  local removed=0 kept=0 missing=0 rel hash abs cur_hash dir
  local dirs_file
  dirs_file=$(mktemp 2>/dev/null || mktemp -t forge-dirs)
  : > "$dirs_file"
  if forge_have_cmd node; then
    while IFS=$'\t' read -r rel hash; do
      [ -n "$rel" ] || continue
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
    done < <(node -e '
      const fs = require("fs");
      let j;
      try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
      const files = Array.isArray(j.files) ? j.files : [];
      for (const f of files) { if (f && f.path && f.sha256) process.stdout.write(f.path + "\t" + f.sha256 + "\n"); }
    ' "$manifest_json" 2>/dev/null)
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
  [ "$DO_PROJECT" = "1" ] && forge_log "This will remove Forge's own files from: $PROJECT_DIR/.claude (only files the installer itself wrote, verified by hash)"
  [ "$DO_GLOBAL" = "1" ] && forge_log "This will remove Forge's global core from: $HOME/.claude (forge-core skill, /forge, /setup-forge, the canonical template)"
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
  [ "$DO_PROJECT" = "1" ] && forge_log "  - $PROJECT_DIR/.claude           (per-project payload: skills, agents, dashboard, config)"
  [ "$DO_PROJECT" = "1" ] && forge_log "  - $PROJECT_DIR/CLAUDE.md         (only if missing) and $PROJECT_DIR/.gitignore (Forge lines appended)"
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
    if forge_copy_tree "$SOURCE_DIR/.claude" "$PROJECT_DIR/.claude" "1" "project" "$PROJECT_DIR"; then
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

  forge_log ""
  forge_log "claude-forge $FORGE_VERSION installed successfully."
  forge_log ""
  forge_log "Next steps:"
  forge_log "  cd \"$PROJECT_DIR\" && claude"
  forge_log "  /setup-forge"
  forge_log "  /forge <task>"
  forge_log ""
  forge_log "Docs: https://github.com/${REPO_OWNER}/${REPO_NAME}#readme"
}

main "$@"
