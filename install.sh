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
forge_write_version_marker() {
  vm_project="$1"
  vm_file="$vm_project/.claude/FORGE_VERSION.json"
  if [ "$DRY_RUN" = "1" ]; then
    forge_log "  would write: $vm_file (forge_version $FORGE_VERSION)"
    return 0
  fi
  vm_now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "unknown")
  vm_template="$HOME/.claude/forge/template/.claude"
  printf '{\n  "forge_version": "%s",\n  "synced_at": "%s",\n  "template": "%s",\n  "installed_by": "install.sh",\n  "_doc": "forge_version is the release this installer wrote; `forge-sync status` prints it as installed= and detects drift by file hash against the canonical template."\n}\n' \
    "$FORGE_VERSION" "$vm_now" "$vm_template" > "$vm_file" || {
    forge_err "could not write $vm_file (forge-sync status will report installed=none)"
    return 0
  }
  forge_log "  wrote: $vm_file (forge_version $FORGE_VERSION)"
}

forge_usage() {
  cat <<'USAGE'
claude-forge installer

Usage:
  ./install.sh [options]

Options:
  --project <dir>   Target project directory (default: current directory)
  --yes, -y         Non-interactive: assume "yes" to the confirmation prompt (CI)
  --dry-run         Show what would be written, change nothing
  --global-only     Only install the global core into $HOME/.claude
  --project-only    Only install the per-project payload into <project>/.claude
  -h, --help        Show this help

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

# Merge handling for <project>/.claude/settings.json (security #4, review #10; MERGED instead of
# "kept, merge by hand" since wp22 / owner directive 2026-09-24 "alles standaard aan" — Forge does the
# merge itself). A user's own settings.json carries their own permissions/hooks and must never be silently
# backed-up-and-REPLACED like an ordinary payload file — but leaving it completely untouched next to a
# settings.forge-recommended.json (the pre-wp22 behaviour) meant the owner's new default hooks (the gate
# hook, the deny rules) never reached an existing project either. Real merge, via the dedicated
# forge-settings-merge.cjs tool (foreign hooks/rules/keys kept byte-for-byte, backed up first): only when
# `node` is on PATH. Without `node`, this falls back to the OLD recommended-file behaviour and says why —
# never silently drops the merge.
forge_copy_settings_file() {
  local src_file="$1"
  local dst_file="$2"
  local dst_dir rec_file merge_tool merge_out

  dst_dir=$(dirname -- "$dst_file")
  rec_file="$dst_dir/settings.forge-recommended.json"
  merge_tool="$SOURCE_DIR/.claude/forge-bin/forge-settings-merge.cjs"

  if [ "$DRY_RUN" = "1" ]; then
    if [ -f "$dst_file" ]; then
      if cmp -s -- "$src_file" "$dst_file" 2>/dev/null; then
        forge_log "  [dry-run] unchanged: $dst_file"
      elif forge_have_cmd node && [ -f "$merge_tool" ]; then
        # guarded via `if` (not a bare assignment / not piped) — see the real-run branch below for why
        # `set -e`/`set -o pipefail` make that unsafe with a tool that can legitimately exit non-zero.
        if merge_out=$(node "$merge_tool" apply --target "$dst_file" --source "$src_file" --dry-run 2>&1); then :; fi
        forge_log "  [dry-run] $merge_out"
      else
        forge_log "  [dry-run] node not found — would keep your settings.json unmerged; would write: $rec_file"
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
    if forge_have_cmd node && [ -f "$merge_tool" ]; then
      # `if var=$(cmd)` (not a bare `var=$(cmd)`) is deliberate: under this script's `set -e`, a bare
      # assignment whose command substitution exits non-zero would abort the WHOLE installer the moment the
      # merge tool refuses (exit 1) — using it as an `if` condition is the one form `set -e` does not apply to.
      if merge_out=$(node "$merge_tool" apply --target "$dst_file" --source "$src_file" 2>&1); then
        forge_log "  $merge_out"
        return 0
      fi
      forge_err "settings.json merge refused ($merge_out) — falling back to settings.forge-recommended.json"
    else
      forge_log "  node not found on PATH — cannot merge settings.json automatically; writing $rec_file instead"
    fi
    if ! cp -- "$src_file" "$rec_file"; then
      forge_err "failed to write: $rec_file"
      return 1
    fi
    forge_log "  kept your settings.json; Forge's hooks are in $rec_file — merge what you want"
    return 0
  fi

  if ! cp -- "$src_file" "$dst_file"; then
    forge_err "failed to copy: $src_file -> $dst_file"
    return 1
  fi
  forge_log "  wrote: $dst_file"
  return 0
}

# Recursively merge-copy every file under $1 (source dir) into $2 (dest dir).
# $3 = "1" routes <dir>/settings.json through forge_copy_settings_file instead of the generic
# backup-then-overwrite path (used for the project payload only — see forge_copy_settings_file).
# Returns 1 if ANY file failed to copy, 0 only if every file genuinely succeeded.
forge_copy_tree() {
  local src_dir="$1"
  local dst_dir="$2"
  local protect_settings="${3:-0}"
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
    fi
  done < <(find "$src_dir" -type f -print0)

  return "$status"
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
  cleanup() {
    if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
      rm -rf -- "$TMP_DIR"
    fi
  }
  trap cleanup EXIT INT TERM

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
  [ "$DO_GLOBAL" = "1" ] && forge_log "  - $HOME/.claude                  (global core: forge-core skill, /forge, /setup-forge)"
  [ "$DO_GLOBAL" = "1" ] && forge_log "  - $HOME/.claude/forge/template   (canonical template: used by forge-sync and the auto-installer)"
  [ "$DO_PROJECT" = "1" ] && forge_log "  - $PROJECT_DIR/.claude           (per-project payload: skills, agents, dashboard, config)"
  [ "$DO_PROJECT" = "1" ] && forge_log "  - $PROJECT_DIR/CLAUDE.md         (only if missing) and $PROJECT_DIR/.gitignore (Forge lines appended)"
  forge_log ""
  forge_log "Existing files that differ are backed up as <file>.forge-bak-<timestamp> and replaced — except .claude/settings.json, which is always kept: the payload version is written next to it as settings.forge-recommended.json instead."
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

  if [ "$DO_GLOBAL" = "1" ]; then
    forge_log ""
    forge_log "Installing global core -> $HOME/.claude"
    if forge_copy_tree "$SOURCE_DIR/global-install/.claude" "$HOME/.claude"; then
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
    if forge_copy_tree "$SOURCE_DIR/.claude" "$TEMPLATE_DIR/.claude"; then
      if [ "$DRY_RUN" != "1" ]; then
        [ -f "$SOURCE_DIR/templates/project-CLAUDE.md" ] && cp -- "$SOURCE_DIR/templates/project-CLAUDE.md" "$TEMPLATE_DIR/CLAUDE.md"
        [ -f "$SOURCE_DIR/templates/gitignore.snippet" ] && cp -- "$SOURCE_DIR/templates/gitignore.snippet" "$TEMPLATE_DIR/gitignore.snippet"
        [ -f "$SOURCE_DIR/.env.example" ] && cp -- "$SOURCE_DIR/.env.example" "$TEMPLATE_DIR/env.example"
      fi
    else
      forge_err "canonical template copy had failures (project installs still work; forge-sync update checks will not)"
      GLOBAL_OK="0"
    fi
  fi

  if [ "$DO_PROJECT" = "1" ]; then
    forge_log ""
    forge_log "Installing project payload -> $PROJECT_DIR/.claude"
    mkdir -p -- "$PROJECT_DIR"
    if forge_copy_tree "$SOURCE_DIR/.claude" "$PROJECT_DIR/.claude" "1"; then
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
    forge_err "project install failed — see errors above"
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
