// WP-P1 (Forge v2.9.0, "the Command Center works after a fresh install") — reads the Forge
// installer's own record of every project it has installed/registered on this machine:
// ~/.claude/forge/projects.json (FORGE_INSTALLED_PROJECTS_FILE in paths.mjs), written by the
// installer, NEVER by this gateway. Contract: `{ "schema": 1, "projects": ["<absolute path>",
// ...] }`.
//
// This is an ADDITIONAL, independent project-discovery source — see projects.mjs's
// computeProjectsAsync() for how it is merged with forge-sync.cjs's own root-scanning
// (paths.mjs's SYNC_SCAN_ROOTS): deduplicated by resolved path, same as every other source, and
// filtered against FORGE_TEMPLATE_DIR there too (never this module's job — it only reads and
// validates the raw list).
//
// Deliberately lenient. Never throws. Never blocks the other discovery source on a bad file:
//   - file absent (every dev/source checkout, and any machine whose installer predates this WP or
//     has simply never recorded a project yet) -> silently [], no log. This is the ORDINARY,
//     expected case and must never be noisy.
//   - file present but not valid JSON, or without an array `projects` field -> [], and exactly ONE
//     console.error for the life of this process (never once per 5s cache refresh — see
//     `loggedMalformedOnce`).
//   - an individual list entry that is not a non-empty string, not an absolute path, or does not
//     resolve to a real, existing Forge project (`.claude/forge-dashboard/` present) is silently
//     skipped — one bad entry never discards the rest of an otherwise-real list.
import fs from 'node:fs';
import path from 'node:path';
import { FORGE_INSTALLED_PROJECTS_FILE, isNetworkOrDevicePath, hasControlChars, safeRealpathSync } from './paths.mjs';

// Test-only override seam — same `_set*ForTests` convention this codebase already uses throughout
// (projects.mjs's `_setForgeSyncCjsForTests`, discord-service.mjs's `_setDiscordPathsForTests`).
// Production code never calls this; a real gateway process always reads the real, machine-owned
// FORGE_INSTALLED_PROJECTS_FILE.
let fileOverride = null;
export function _setInstalledProjectsFileForTests(filePath) {
  fileOverride = filePath;
}
export function _resetInstalledProjectsFileForTests() {
  fileOverride = null;
}
function activeFile() {
  return fileOverride || FORGE_INSTALLED_PROJECTS_FILE;
}

// Process-lifetime "have we already told the log about a malformed file" flag — deliberately NOT
// reset on every read (unlike the file-path override above): computeProjectsAsync() re-reads this
// file on every cache refresh (every CACHE_TTL_MS), and a persistently malformed file must log
// ONCE, not forever. A test that wants to assert on the log line resets this via the function
// below rather than relying on process start order.
let loggedMalformedOnce = false;
export function _resetInstalledProjectsLogForTests() {
  loggedMalformedOnce = false;
}

function logMalformedOnce(message) {
  if (loggedMalformedOnce) return;
  loggedMalformedOnce = true;
  console.error('[installed-projects] ' + message);
}

function looksLikeRealForgeProject(candidateResolvedPath) {
  try {
    return fs.existsSync(path.join(candidateResolvedPath, '.claude', 'forge-dashboard'));
  } catch {
    return false;
  }
}

// Codex run B F-01 (2026-09-28): a registry entry is trusted, machine-owned INSTALLER output, but
// it is still on-disk data this process never wrote itself — the same F-01 rule applied to any
// other externally-sourced path (folder-browse.mjs's own `?dir=`, discord-service.mjs's projects
// dir): reject a network/device path (`\\host\share\...`, `\\?\...`, `\\.\...`) or a value
// containing control characters BEFORE any filesystem call at all. On Windows even a bare
// `fs.existsSync()` of a UNC path can make the OS contact that host and send the user's NTLM
// challenge response — never allowed to happen for an entry this module has not yet validated.
function isSafeRegistryPathText(p) {
  return typeof p === 'string' && p.length > 0 && !hasControlChars(p) && !isNetworkOrDevicePath(p);
}

/**
 * Every existing, real Forge project path this machine's installer has recorded — always an
 * array, never throws. See this file's header for the exact robustness contract.
 */
export function readInstalledProjectPaths() {
  const filePath = activeFile();
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return []; // absent file: the ordinary case for most machines/checkouts — never logged
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logMalformedOnce(filePath + ' is not valid JSON: ' + (err && err.message ? err.message : String(err)) + ' — ignoring it.');
    return [];
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.projects)) {
    logMalformedOnce(filePath + ' does not have the expected { "schema": 1, "projects": [...] } shape — ignoring it.');
    return [];
  }

  const out = [];
  for (const entry of parsed.projects) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed === '' || !path.isAbsolute(trimmed)) continue;
    // Codex run B F-01: reject a network/device path or control characters in the TYPED text —
    // before any filesystem call at all.
    if (!isSafeRegistryPathText(trimmed)) continue;
    const resolved = path.resolve(trimmed);
    // Codex run B F-01 + F-12: the REAL path, resolved one component at a time by safeRealpathSync
    // (paths.mjs): every link on the way, not only this entry itself, has its own raw target text
    // checked for a network/device path before it is followed (the OS realpath would follow the
    // whole chain in one call). projects.mjs admits THIS real path as an allowed containment root,
    // so a registry entry is tracked by where it actually lives on disk. A broken/circular or
    // unsafe link is never admitted.
    const safe = safeRealpathSync(resolved);
    if (!safe.ok) continue;
    const real = safe.real;
    // Q2-style: the RESOLVED target, not just the typed text, must also be checked — a local-
    // looking entry can still be a link whose real target is a network/device path.
    if (!isSafeRegistryPathText(real)) continue;
    if (!looksLikeRealForgeProject(real)) continue; // vanished, never installed, or not a real project dir
    out.push(real);
  }
  return out;
}
