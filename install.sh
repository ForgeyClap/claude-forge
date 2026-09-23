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

# Recursively merge-copy every file under $1 (source dir) into $2 (dest dir).
# Returns 1 if ANY file failed to copy, 0 only if every file genuinely succeeded.
forge_copy_tree() {
  local src_dir="$1"
  local dst_dir="$2"
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
    if ! forge_copy_file "$file" "$dst_dir/$rel"; then
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

  SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)

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
  if [ -d "$SCRIPT_DIR/global-install/.claude" ] && [ -d "$SCRIPT_DIR/.claude" ]; then
    SOURCE_DIR="$SCRIPT_DIR"
    forge_log "Running in place from: $SOURCE_DIR"
  else
    forge_log "Repo payload not found next to this script — downloading ${REPO_OWNER}/${REPO_NAME}@${FORGE_REF} ..."

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
      if [ -f "$SCRIPT_DIR/SHA256SUMS" ] && forge_have_cmd sha256sum; then
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

  if [ -f "$SCRIPT_DIR/VERSION" ]; then
    FORGE_VERSION=$(cat "$SCRIPT_DIR/VERSION" 2>/dev/null || echo "unknown")
  elif [ -n "$SOURCE_DIR" ] && [ -f "$SOURCE_DIR/VERSION" ]; then
    FORGE_VERSION=$(cat "$SOURCE_DIR/VERSION" 2>/dev/null || echo "unknown")
  else
    FORGE_VERSION="unknown"
  fi
  forge_log "claude-forge version: $FORGE_VERSION"

  # -------------------------------------------------------------------------
  # 2. plan
  # -------------------------------------------------------------------------
  DO_GLOBAL="1"
  DO_PROJECT="1"
  [ "$GLOBAL_ONLY" = "1" ] && DO_PROJECT="0"
  [ "$PROJECT_ONLY" = "1" ] && DO_GLOBAL="0"

  forge_log ""
  forge_log "This will write files to:"
  [ "$DO_GLOBAL" = "1" ] && forge_log "  - $HOME/.claude          (global core: forge-core skill, /forge, /setup-forge)"
  [ "$DO_PROJECT" = "1" ] && forge_log "  - $PROJECT_DIR/.claude   (per-project payload: skills, agents, dashboard, config)"
  forge_log ""
  forge_log "Existing files that differ will be backed up as <file>.forge-bak-<timestamp> before being overwritten."
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
  fi

  if [ "$DO_PROJECT" = "1" ]; then
    forge_log ""
    forge_log "Installing project payload -> $PROJECT_DIR/.claude"
    mkdir -p -- "$PROJECT_DIR"
    if forge_copy_tree "$SOURCE_DIR/.claude" "$PROJECT_DIR/.claude"; then
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
