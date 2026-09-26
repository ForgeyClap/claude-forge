// Project registry: spawns the existing, already-reviewed `forge-sync.cjs list <root>` CLI once
// per FIXED root in SYNC_SCAN_ROOTS (computed in paths.mjs — never from request input), parses
// each call's plain-text output, merges the discovered project paths (deduplicated by resolved
// path — the same real project directory is never listed twice, even when two scan roots overlap
// or a project sits exactly at a root boundary), and enriches each entry with whether it has a
// live dashboard.
//
// C1 fix (WP-C1): this used to spawn exactly one call against SYNC_SCAN_ROOT (the parent of
// wherever this repo happens to be cloned) — see paths.mjs's own SYNC_SCAN_ROOTS comment for why
// that missed a real project living somewhere else on a fresh machine (e.g. the Desktop).
//
// A2 fix (WP-C2, 2026-09-26 laptop re-audit): dedup by PATH does not mean unique by NAME — with
// several real scan roots now in play, two different real projects can share a folder name (a
// Desktop `my-site` and a Documents `my-site`). Every entry below carries an `ambiguous` flag for
// exactly that case (see computeProjectsAsync()), which server.mjs's resolveProjectByName() uses
// to refuse a silent first-match pick.
//
// R2 fix (WP3 T3.1-T3.10, architecture-review risk): the previous version used execFileSync,
// blocking the gateway's single thread on every cache-miss/expiry. Now async (execFile,
// promisified) with stale-while-revalidate: a cache hit within TTL still returns synchronously
// from memory (provenance 'DERIVED', unchanged from before — this is the path the existing
// gateway.test.mjs regression test asserts on). Once the cache has EXPIRED, a request is never
// blocked on a fresh spawn: the last known-good value is returned immediately (never stale data
// silently presented as fresh — provenance says so), while a single background refresh runs
// in-flight. A second request that arrives while that refresh is still running reuses the SAME
// in-flight promise instead of dispatching a second concurrent spawn.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FORGE_SYNC_CJS, SYNC_SCAN_ROOTS } from './paths.mjs';

const execFileAsync = promisify(execFile);

// Test-only override seams (same `_set*ForTests` convention this file's siblings already use —
// e.g. projects-create.mjs's `_setProjectsRootForTests`/`_setInstallRunnerForTests`). Production
// code never calls either; a real gateway process always uses the real FORGE_SYNC_CJS tool and the
// real SYNC_SCAN_ROOTS from paths.mjs. Added for WP-C1's C1 fix so the multi-root merge/dedup logic
// in computeProjectsAsync() below can be exercised against isolated temp fixtures + a real (but
// test-local) forge-sync.cjs-shaped stub, independent of wherever this gateway's own checkout
// happens to be nested on disk.
let forgeSyncCjsOverride = null;
let scanRootsOverride = null;
export function _setForgeSyncCjsForTests(cjsPath) { forgeSyncCjsOverride = cjsPath; }
export function _resetForgeSyncCjsForTests() { forgeSyncCjsOverride = null; }
export function _setScanRootsForTests(roots) { scanRootsOverride = roots; }
export function _resetScanRootsForTests() { scanRootsOverride = null; }
function activeForgeSyncCjs() { return forgeSyncCjsOverride || FORGE_SYNC_CJS; }
function activeScanRoots() { return scanRootsOverride || SYNC_SCAN_ROOTS; }
// D2 fix (cc-fix-gateway-perf, forge-2026-07-29-cc-finish): a newly-registered project used to take
// up to ~45s to become visible (30s TTL + one client poll interval, per the E2E realiteitstest's
// Fase A/B measurement: 14.1s clean, up to ~45s worst-case). The 30s TTL was chosen on the ASSUMPTION
// that the underlying scan is expensive — measured live before changing anything (5 real
// `forge-sync.cjs list` spawns against this fleet's real ~15-19 project registry):
// 58.1 / 56.6 / 56.3 / 57.8 / 57.8 ms, avg 57.3ms. The scan is genuinely cheap, and it already runs
// via async execFile (never blocking the event loop) with in-flight-request collapsing (only ONE
// spawn no matter how many requests arrive while a refresh is running) — so a much shorter TTL costs
// almost nothing extra. Lowered to 5s, matching the TTL this codebase already uses elsewhere for the
// same "fresh enough, still bounded" tradeoff (health.mjs's CONTROL_CENTER_PROBE_TTL_MS). This
// removes 25s from the theoretical worst case; the REMAINING worst-case contributor is the
// dashboard's own client-side poll interval (dashboard/ — out of this WP's write scope, handed off
// in the forge-report; if that poll interval stays materially above ~5s, the true worst case can
// still exceed 10s and needs a UI progress indicator, not a further TTL cut here).
export const CACHE_TTL_MS = 5_000;
let cache = null; // { data, expiresAt }
let refreshInFlight = null; // Promise<void> | null — the single in-flight background refresh

function parseListOutput(stdout) {
  // Real shape (verified live): first line "<N> Forge project(s) under <root>:", then one
  // indented absolute path per line. Anything that doesn't look like an indented path is
  // ignored rather than throwing — an honest partial result beats a hard crash on drift.
  const lines = String(stdout).split(/\r?\n/);
  const projectPaths = [];
  for (const line of lines) {
    if (/^\s{2}\S/.test(line)) projectPaths.push(line.trim());
  }
  return projectPaths;
}

function readDashboardPort(projectPath) {
  const portFile = path.join(projectPath, '.claude', 'forge-dashboard', 'PORT');
  try {
    const raw = fs.readFileSync(portFile, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// cc-fix-chat-identity: an honest recency fallback for the dashboard's "recent projects" list — a
// just-created project with zero runs has no other real activity signal. One cheap fs.stat on the
// already-resolved project path (no extra directory scan); null (never 0/fabricated) when the
// stat genuinely fails, e.g. a registry entry whose directory vanished between scan and stat.
function readDirMtimeMs(projectPath) {
  try {
    return fs.statSync(projectPath).mtimeMs;
  } catch {
    return null;
  }
}

function buildProjectEntry(projectPath) {
  const name = path.basename(projectPath);
  const dashboardDir = path.join(projectPath, '.claude', 'forge-dashboard');
  const has_dashboard = fs.existsSync(dashboardDir);
  return {
    name,
    path: projectPath,
    has_dashboard,
    dashboard_port: has_dashboard ? readDashboardPort(projectPath) : null,
    dir_mtime_ms: readDirMtimeMs(projectPath),
  };
}

// One real `forge-sync.cjs list <root>` spawn — never throws, always resolves to a tagged
// success/failure so the caller can merge several roots without one bad root aborting the rest.
async function scanOneRoot(root) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [activeForgeSyncCjs(), 'list', root], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    return { ok: true, root, paths: parseListOutput(stdout) };
  } catch (err) {
    return { ok: false, root, error: err && err.message ? err.message : String(err) };
  }
}

// C1 fix (WP-C1): scans every SYNC_SCAN_ROOTS entry in parallel (one spawn per root — cheap, see
// this file's own header for the real measured cost of a single spawn) and merges the discovered
// project paths, deduplicated by resolved absolute path. A root whose OWN spawn fails (e.g. a
// permissions error) is skipped rather than failing the whole discovery — as long as at least one
// root's scan succeeded, this returns that honest partial union (never silently empty when only
// SOME roots are unreachable). Only when EVERY root's spawn fails does this report ok:false, with
// every root's own error folded into one message.
async function computeProjectsAsync() {
  const results = await Promise.all(activeScanRoots().map(scanOneRoot));
  const succeeded = results.filter((r) => r.ok);
  if (succeeded.length === 0) {
    // Finding #4 (WP-C2, 2026-09-26 laptop re-audit): the detail string below names every scan
    // root's real absolute path (which starts with the OS home directory / username) plus the raw
    // child-process error text. That is genuine local system detail — it must never reach a client
    // response (this `error` value is what GET /api/projects returns verbatim, and what every
    // route's `registryError` passthrough in server.mjs sends back too). Kept in this process's
    // own log only; the client gets one generic, non-identifying message.
    const detail = results.map((r) => r.root + ': ' + r.error).join(' | ');
    console.error('[projects] forge-sync list failed for every scan root: ' + detail);
    return { ok: false, error: 'forge-sync list failed for every scan root (see the gateway process log for details)', projects: [] };
  }

  const seenResolvedPaths = new Set();
  const projectPaths = [];
  for (const r of succeeded) {
    for (const p of r.paths) {
      const resolved = path.resolve(p);
      if (seenResolvedPaths.has(resolved)) continue;
      seenResolvedPaths.add(resolved);
      projectPaths.push(p);
    }
  }
  const projects = projectPaths.map(buildProjectEntry);
  // A2 fix (WP-C2, 2026-09-26 laptop re-audit): dedup above is by resolved PATH, not by name — two
  // real, different projects (e.g. a Desktop `my-site` and a Documents `my-site`, now that multi-
  // root discovery scans both) can legitimately share a folder NAME. Every name-based lookup in
  // this gateway (server.mjs's resolveProjectByName) must be able to tell the two apart rather than
  // silently picking one, so each entry is marked here, once, with whether its name collides with
  // another real discovered project — this is exactly what the dashboard needs to show a path
  // instead of just a name for those, and exactly what resolveProjectByName checks before ever
  // returning a single entry for an ambiguous name.
  const nameCounts = new Map();
  for (const p of projects) nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1);
  const projectsWithAmbiguity = projects.map((p) => ({ ...p, ambiguous: nameCounts.get(p.name) > 1 }));
  return { ok: true, projects: projectsWithAmbiguity };
}

function buildDataObject(result, capturedAtMs) {
  return {
    ok: result.ok,
    error: result.error,
    projects: result.projects,
    captured_at: new Date(capturedAtMs).toISOString(),
    age_ms: 0,
    _capturedAtMs: capturedAtMs,
  };
}

// Returns { ok, projects, captured_at, age_ms, provenance } — always this shape, never throws.
// provenance: 'DERIVED' (fresh cache hit, or the one-time cold-start compute) · 'STALE' (cache
// expired; this call just triggered a background refresh, serving the last known-good value) ·
// 'CACHED' (cache expired; a refresh triggered by an earlier call is still in flight, so this
// call reused it rather than dispatching a second concurrent spawn).
export async function listProjects(now = Date.now()) {
  if (cache && cache.expiresAt > now) {
    return { ...cache.data, age_ms: now - cache.data._capturedAtMs, provenance: 'DERIVED' };
  }
  if (!cache) {
    // Cold start: no fallback value exists yet, so this one call must genuinely await the spawn.
    const result = await computeProjectsAsync();
    const data = buildDataObject(result, now);
    cache = { data, expiresAt: now + CACHE_TTL_MS };
    return { ...data, provenance: 'DERIVED' };
  }
  const staleData = { ...cache.data, age_ms: now - cache.data._capturedAtMs };
  if (!refreshInFlight) {
    refreshInFlight = computeProjectsAsync()
      .then((result) => {
        const freshCapturedAtMs = Date.now();
        cache = { data: buildDataObject(result, freshCapturedAtMs), expiresAt: freshCapturedAtMs + CACHE_TTL_MS };
      })
      .catch(() => { /* keep serving the last known-good cache; a failed background refresh must never crash a request */ })
      .finally(() => { refreshInFlight = null; });
    return { ...staleData, provenance: 'STALE' };
  }
  return { ...staleData, provenance: 'CACHED' };
}

// Test-only hooks: clear/manipulate the module-level cache so tests don't leak state across runs
// and can deterministically exercise the stale-while-revalidate branches without real 30s waits.
export function _resetProjectsCacheForTests() { cache = null; refreshInFlight = null; }
export function _expireProjectsCacheForTests() { if (cache) cache.expiresAt = Date.now() - 1; }
export function _awaitProjectsRefreshForTests() { return refreshInFlight || Promise.resolve(); }
