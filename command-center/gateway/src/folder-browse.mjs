// GET /api/discord/browse-folder (WP-S1, owner request 2026-09-27) — a read-only folder PICKER
// for the beginner-facing "choose a Discord projects folder" flow. Deliberately NOT the same
// containment model as files.mjs's listDirectory(): that endpoint only ever lists INSIDE an
// already-trusted project path (one of paths.mjs's SYNC_SCAN_ROOTS); this one exists precisely so
// a beginner can browse ANYWHERE on their own machine to CHOOSE a brand-new root — there is no
// project path to contain it to yet, and a real OS folder-picker dialog has the same freedom.
//
// What keeps this safe to expose over HTTP on this loopback, single-user gateway (same trust
// frame security.mjs's own EXEC_TOKEN comment already documents: no other LOCAL program run by
// the same user is kept out by this gateway either):
//   - NEVER returns file CONTENT, and never returns non-directory entries at all — only real
//     subfolder NAMES (a picker has no use for files, and this halves what could ever leak).
//   - Defaults to the user's own `<home>/Documents` when no `dir` is given — never a system root.
//   - Hidden (dot-prefixed) entries and well-known OS "junk" folders (`$RECYCLE.BIN`, `System
//     Volume Information`) are skipped by NAME before they are ever returned — a beginner can
//     never see or navigate into them through this picker.
//   - Codex run B F-01 (2026-09-28): the requested directory, and every ancestor/entry that turns
//     out to be a symlink/junction, is resolved hop-by-hop via paths.mjs's safeRealpathSync() —
//     NEVER a single fs.realpathSync.native() call — so a network path (`\\host\share\...`) or a
//     Windows device path (`\\?\...`, `\\.\...`), whether typed directly in `?dir=` OR reached by
//     following a link, is refused BEFORE any filesystem call would otherwise touch it (a bare
//     stat/readdir of a UNC path can make Windows send the user's NTLM credentials to that host).
//     Control characters (CR/LF/NUL/...) in the typed path are rejected the same way.
//   - The requested directory must actually exist and be a real directory.
//   - Codex run B F-04 (2026-09-28): the directory scan itself has a hard budget (SCAN_BUDGET),
//     independent of the MAX_ENTRIES result cap — a huge-fanout folder can never make this GET
//     route do unbounded work; `truncated:true` says so honestly instead of silently under- or
//     over-scanning.
//   - Bounded to MAX_ENTRIES results — a folder with a huge fanout can never produce an unbounded
//     response; `truncated:true` says so honestly rather than silently dropping entries.
//   - This is a GET, read-only route — no exec token required, same "GET stays read-only, no
//     token" rule every other GET on this gateway already follows (e.g. GET /api/discord/status).
//
// What this deliberately does NOT restrict: navigating ABOVE Documents (e.g. up to the user's own
// home, or further) — a real OS folder picker allows exactly this, and this endpoint only ever
// reveals folder NAMES, never contents. The separate write route, `setProjectsDirSetting()`
// (discord-service.mjs), is what refuses to SAVE a drive root, the user's whole home folder, or a
// Windows system folder as the final choice — browsing there (so a beginner can see why a folder
// is not a good pick, if they try) is harmless; saving it is what is refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isNetworkOrDevicePath, hasControlChars, safeRealpathSync } from './paths.mjs';

export const DEFAULT_BROWSE_ROOT = path.join(os.homedir(), 'Documents');
const MAX_ENTRIES = 500;
// Codex run B F-04: bounds the RAW SCAN (how many directory entries this call will ever inspect),
// independent of MAX_ENTRIES (how many of the found SUBFOLDERS are ever returned). A folder with a
// huge number of FILES or hidden/junk entries but few real subfolders used to make readdirSync()
// read every single one of them into memory before the 500-result cap ever had a chance to apply.
const SCAN_BUDGET = 5000;

// Test-only override seam (same `_set*ForTests` convention this codebase uses throughout, e.g.
// discord-service.mjs's `_setHomeDirForTests`) — lets a test prove the scan genuinely stops at the
// budget using a handful of fixture entries instead of manufacturing thousands of real files.
let scanBudgetOverride = null;
export function _setScanBudgetForTests(n) {
  scanBudgetOverride = n;
}
export function _resetScanBudgetForTests() {
  scanBudgetOverride = null;
}
function activeScanBudget() {
  return typeof scanBudgetOverride === 'number' ? scanBudgetOverride : SCAN_BUDGET;
}

function looksJunkOnWindows(name) {
  return /^\$recycle\.bin$/i.test(name) || /^system volume information$/i.test(name);
}

/** Whether `name` should be hidden from the picker entirely — dot-prefixed (Unix-hidden
 *  convention, also how Windows dotfolders like `.git` read) or a well-known Windows junk name. */
function isHiddenOrJunk(name) {
  if (name.startsWith('.')) return true;
  if (process.platform === 'win32' && looksJunkOnWindows(name)) return true;
  return false;
}

/** True when `entryPath` (a dirent already known to be a symlink/junction) safely resolves to a
 *  real, local, non-network directory. Codex run B F-01: never stats/follows a listed entry whose
 *  OWN link target (or one of ITS ancestors) turns out to be a network or device path — a broken
 *  link, an unsafe target, or any other problem is treated as "not a directory" (`false`), exactly
 *  the same "just don't show it" outcome a broken link already had before this fix, so an
 *  attacker-planted entry is silently skipped rather than surfaced as a visible error. */
function isSafeDirectoryEntry(entryPath) {
  const safe = safeRealpathSync(entryPath);
  if (!safe.ok) return false;
  try {
    return fs.statSync(safe.real).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scans `realDir` for real subfolder NAMES with a hard budget on how many raw directory entries
 * are ever inspected (SCAN_BUDGET) as well as on how many are ever returned (MAX_ENTRIES) — Codex
 * run B F-04. Returns `{ names, truncated }`. Only a failure to OPEN `realDir` itself throws — an
 * individual entry's own problem (a broken link, a permission blip) is skipped, never fatal.
 */
function collectSubfolderNames(realDir) {
  const dir = fs.opendirSync(realDir);
  const names = [];
  let truncated = false;
  let scanned = 0;
  const budget = activeScanBudget();
  try {
    let dirent = dir.readSync();
    while (dirent !== null) {
      scanned += 1;
      if (scanned > budget) {
        truncated = true;
        break;
      }
      if (!isHiddenOrJunk(dirent.name)) {
        let isDir = dirent.isDirectory();
        if (!isDir && dirent.isSymbolicLink()) {
          isDir = isSafeDirectoryEntry(path.join(realDir, dirent.name));
        }
        if (isDir) {
          if (names.length >= MAX_ENTRIES) {
            truncated = true;
            break;
          }
          names.push(dirent.name);
        }
      }
      dirent = dir.readSync();
    }
  } finally {
    dir.closeSync();
  }
  return { names, truncated };
}

/**
 * Lists the real subfolder NAMES of `rawDir` (defaults to `DEFAULT_BROWSE_ROOT` when absent/
 * blank). Returns `{ ok:true, path, parent, folders, truncated }` or `{ ok:false, error }` — never
 * throws.
 */
export function browseFolder(rawDir) {
  const requested = typeof rawDir === 'string' && rawDir.trim().length > 0 ? rawDir.trim() : DEFAULT_BROWSE_ROOT;
  if (hasControlChars(requested)) {
    return { ok: false, error: 'that folder path contains characters that are not allowed' };
  }
  if (!path.isAbsolute(requested)) {
    return { ok: false, error: 'folder path must be absolute' };
  }
  const resolved = path.resolve(requested);
  if (isNetworkOrDevicePath(resolved)) {
    return { ok: false, error: 'network and device paths are not allowed' };
  }

  // Codex run B F-01: hop-by-hop resolution (never a single fs.realpathSync.native() call) so a
  // symlink/junction anywhere in `resolved`'s own ancestry that targets a network share or a
  // device path is refused BEFORE any filesystem call ever follows it.
  const safe = safeRealpathSync(resolved);
  if (!safe.ok) {
    if (safe.code === 'EUNSAFE_LINK' || safe.code === 'EUNSAFE_CHARS') {
      return { ok: false, error: 'that folder is not allowed: ' + safe.error };
    }
    return { ok: false, error: 'folder not found: ' + safe.error };
  }
  const real = safe.real;

  let stat;
  try {
    stat = fs.statSync(real);
  } catch (err) {
    return { ok: false, error: 'folder not found: ' + (err && err.message ? err.message : String(err)) };
  }
  if (!stat.isDirectory()) return { ok: false, error: 'that path is not a folder' };

  let listing;
  try {
    listing = collectSubfolderNames(real);
  } catch (err) {
    return { ok: false, error: 'could not read that folder: ' + (err && err.message ? err.message : String(err)) };
  }
  const names = listing.names;
  names.sort((a, b) => a.localeCompare(b));

  const parent = path.dirname(real);
  return {
    ok: true,
    path: real,
    parent: parent !== real ? parent : null,
    folders: names,
    truncated: listing.truncated,
  };
}
