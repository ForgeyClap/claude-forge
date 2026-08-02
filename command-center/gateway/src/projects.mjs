// Project registry: spawns the existing, already-reviewed `forge-sync.cjs list <root>` CLI with
// a FIXED argument list (SYNC_SCAN_ROOT, computed in paths.mjs — never from request input),
// parses its plain-text output, and enriches each entry with whether it has a live dashboard.
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
import { FORGE_SYNC_CJS, SYNC_SCAN_ROOT } from './paths.mjs';

const execFileAsync = promisify(execFile);
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

async function computeProjectsAsync() {
  try {
    const { stdout } = await execFileAsync(process.execPath, [FORGE_SYNC_CJS, 'list', SYNC_SCAN_ROOT], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    const projectPaths = parseListOutput(stdout);
    return { ok: true, projects: projectPaths.map(buildProjectEntry) };
  } catch (err) {
    return { ok: false, error: 'forge-sync list failed: ' + (err && err.message ? err.message : String(err)), projects: [] };
  }
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
