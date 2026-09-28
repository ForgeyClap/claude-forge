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
import {
  FORGE_SYNC_CJS, SYNC_SCAN_ROOTS, FORGE_TEMPLATE_DIR, isSameResolvedPath,
  realpathOrNull, safeRealpathSync, isNetworkOrDevicePath, hasControlChars,
} from './paths.mjs';
import { anyContainmentOk } from './security.mjs';
import { readInstalledProjectPaths } from './installed-projects.mjs';
// Codex run B F-12: every OTHER per-project route (runs.mjs, proof.mjs's callers, approvals.mjs,
// files.mjs, recovery.mjs, server.mjs's resolveProjectByName) reads this SAME admitted set for its
// own containment check — updated here after every registry recompute, so a project the installer
// registered outside the scan roots is usable everywhere, not just listed by this file's own
// GET /api/projects. See admitted-roots.mjs's own header for why this lives in its own module.
import { setAdmittedRegistryRoots } from './admitted-roots.mjs';
// WP-CC1 (item 4): the ONE new fallback signal when FORGE_CC_DEFAULT_PROJECT is unset (the
// supervisor path — every real production launch — never sets it, per this WP's own brief) —
// reuses runs.mjs's own ranking/cache rather than re-deriving "what counts as real work" a second
// time. `mostRecentWorkSignalMs` mirrors runs.mjs's SAME qualification rule (>=1 real work event,
// not self-declared/reserved-name synthetic) so this can never pick a doctor-selfcheck/demo run's
// project over a genuinely quiet one.
import { mostRecentWorkSignalMs } from './runs.mjs';

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
// Codex run B F-12: the REAL (symlink/junction-resolved) form of WHATEVER activeScanRoots()
// currently is (a test override, or the real, live-mutable SYNC_SCAN_ROOTS from paths.mjs).
// Recomputed fresh on every call — cheap, at most a handful of roots — rather than cached once, so
// this never goes stale relative to either kind of override (see admitted-roots.mjs's own
// getContainmentRoots(), which applies the identical reasoning for the same underlying array).
function activeScanRootsReal() {
  return activeScanRoots().map((r) => realpathOrNull(r)).filter((r) => typeof r === 'string' && r.length > 0);
}

// WP-P1: same override-seam convention, for the two new "never a project" / "which one is
// wrapper-default" inputs this WP adds. `templateDirOverride` lets a test relocate "the one path
// that can never be a project" to an isolated temp dir instead of the real, machine-owned
// ~/.claude/forge/template. `defaultProjectPathOverride`, when set (including to an explicit
// empty string), takes priority over the real `FORGE_CC_DEFAULT_PROJECT` env var — needed because
// a test cannot always safely mutate `process.env` (parallel `node --test` files share one
// process) the way several OTHER existing test files in this suite already do for simpler,
// single-file env vars.
let templateDirOverride = null;
let defaultProjectPathOverride = null;
export function _setTemplateDirForTests(dir) { templateDirOverride = dir; }
export function _resetTemplateDirForTests() { templateDirOverride = null; }
export function _setDefaultProjectPathForTests(p) { defaultProjectPathOverride = p; }
export function _resetDefaultProjectPathForTests() { defaultProjectPathOverride = null; }
function activeTemplateDir() { return templateDirOverride || FORGE_TEMPLATE_DIR; }
function activeDefaultProjectPathRaw() {
  return defaultProjectPathOverride !== null ? defaultProjectPathOverride : (process.env.FORGE_CC_DEFAULT_PROJECT || '');
}
// D2 fix (cc-fix-gateway-perf, forge-2026-07-29-cc-finish): a newly-registered project used to take
// up to ~45s to become visible (30s TTL + one client poll interval, per the E2E realiteitstest's
// Fase A/B measurement: 14.1s clean, up to ~45s worst-case). The 30s TTL was chosen on the ASSUMPTION
// that the underlying scan is expensive — measured live before changing anything (5 real
// `forge-sync.cjs list` spawns against this fleet's real ~15-19 project registry):
// 58.1 / 56.6 / 56.3 / 57.8 / 57.8 ms, avg 57.3ms. The scan is genuinely cheap, and it already runs
// via async execFile (never blocking the event loop) with in-flight-request collapsing (only ONE
// spawn no matter how many requests arrive while a refresh is running) — so a much shorter TTL costs
// almost nothing extra. Lowered to 5s, matching the TTL this codebase already uses elsewhere for the
// same "fresh enough, still bounded" tradeoff (health.mjs's now-retired Control Center probe cache
// used the same 5s figure — see WP-N2, Forge 2.9.0, for its removal). This
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

// WP-N2 (Forge 2.9.0): `dashboard_port` (read from each project's own legacy
// `.claude/forge-dashboard/PORT` file) used to identify which port that project's now-removed
// per-project Control Center was listening on. Confirmed no consumer ever read this field — not
// the dashboard UI (`dashboard/src`, `ProjectRow`/`parseProjectRows` only read `has_dashboard`
// and `dir_mtime_ms`), not a gateway test, not a TS type. Dropped rather than kept as an
// always-null field, since the underlying concept (a per-project dashboard server with its own
// port) no longer exists to describe. `has_dashboard` itself is unchanged and still means what
// it always meant: this project's `.claude/forge-dashboard/` directory exists (it holds
// `log-event.cjs`, the run-event writer — see paths.mjs/projects-create.mjs).
// WP-CC1 (item 12): flags a discovered "project" that is really a backup snapshot or a machine-
// generated test/E2E fixture, never a real one the owner works in — evidenced live on this fleet:
// `Documents/forge-backups/` holds WHOLE project copies (`forge-backups/forge-system-public`, even
// a nested `forge-backups/forge-system-public/global-install/.claude`) that forge-sync's own
// `.claude`-marker scan genuinely discovers as separate "projects"; `Forge-e2e-<ISO-timestamp>` is
// the installer test-suite's own machine-generated fixture naming convention. Deliberately NARROW:
// matched by a real path SEGMENT (`forge-backups`, case-insensitive) or a real, machine-generated
// name PREFIX (`Forge-e2e-`) — never a bare substring like "test", which would misclassify a
// genuinely real project that merely has "test" in its own chosen name (verified live: this
// fleet's own `Documents/test` is SkyDrop, a real game project, not a fixture — see this WP's own
// forge-report for the full investigation). `'primary'` is the honest default for everything else.
const BACKUP_PATH_SEGMENT_RE = /[\\/]forge-backups[\\/]|[\\/]forge-backups$/i;
const TEST_FIXTURE_NAME_RE = /^Forge-e2e-/;
function classifyProjectKind(projectPath, name) {
  if (BACKUP_PATH_SEGMENT_RE.test(projectPath)) return 'backup';
  if (TEST_FIXTURE_NAME_RE.test(name)) return 'test';
  return 'primary';
}

function buildProjectEntry(projectPath) {
  const name = path.basename(projectPath);
  const dashboardDir = path.join(projectPath, '.claude', 'forge-dashboard');
  const has_dashboard = fs.existsSync(dashboardDir);
  return {
    name,
    path: projectPath,
    has_dashboard,
    dir_mtime_ms: readDirMtimeMs(projectPath),
    kind: classifyProjectKind(projectPath, name),
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

// WP-P1: `~/.claude/forge/template` (the central install's own host folder — see paths.mjs's own
// FORGE_TEMPLATE_DIR comment) is a Forge install artifact, never a real project. Applied to EVERY
// discovery source below (scan-root results AND the installer's own recorded list) so it can never
// reach `GET /api/projects` regardless of which source happened to find it — on a normal source/
// dev checkout this is a guaranteed no-op (that path is never scanned/listed there at all).
function isForgeTemplateHost(candidatePath) {
  return isSameResolvedPath(candidatePath, activeTemplateDir());
}

// WP-P1: the wrapper that launched this gateway (e.g. `forge dashboard`, run from a specific
// project) may pass FORGE_CC_DEFAULT_PROJECT=<absolute project path> — the project the dashboard
// should select by default. Only ever honoured when it resolves to one of the projects THIS
// discovery pass actually found real (never trusted blindly, and never a path the caller cannot
// already see in `projects` itself) — returns that project's own `name` (matching the `id` shape
// the dashboard already derives from `row.name`), or `null` when unset/unmatched.
// WP-CC1 (item 4): only ever consulted when the env var itself is unset/unmatched — the explicit
// override above always wins first. Picks the discovered project whose OWN most recent real work
// event (runs.mjs's mostRecentWorkSignalMs — same qualification as current_run there) is newest;
// `null`, honestly, when NOT ONE discovered project has any qualifying run yet (a fresh install, or
// every project quiet) — this deliberately does NOT fall back to e.g. directory mtime, so a
// project with literally zero real work never gets picked over reporting an honest "no default yet".
function resolveDefaultProjectByRecentWork(projects) {
  let best = null;
  let bestMs = -Infinity;
  for (const p of projects) {
    const ms = mostRecentWorkSignalMs(p.path);
    if (ms !== null && ms > bestMs) { bestMs = ms; best = p; }
  }
  return best ? best.name : null;
}

function resolveDefaultProjectId(projects) {
  const raw = activeDefaultProjectPathRaw();
  if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim();
    const match = projects.find((p) => isSameResolvedPath(p.path, trimmed));
    if (match) return match.name;
    // An explicitly-set but UNMATCHED override never silently falls back to the recent-work
    // heuristic below — the caller asked for a SPECIFIC project; if that one cannot be found, the
    // honest answer is "no default", not "something else, unrelated, picked automatically".
    return null;
  }
  return resolveDefaultProjectByRecentWork(projects);
}

// C1 fix (WP-C1): scans every SYNC_SCAN_ROOTS entry in parallel (one spawn per root — cheap, see
// this file's own header for the real measured cost of a single spawn) and merges the discovered
// project paths, deduplicated by resolved absolute path. A root whose OWN spawn fails (e.g. a
// permissions error) is skipped rather than failing the whole discovery — as long as at least one
// root's scan succeeded, this returns that honest partial union (never silently empty when only
// SOME roots are unreachable).
//
// WP-P1 addition: the installer's own recorded project list (installed-projects.mjs) is merged in
// as a SECOND, independent source — added regardless of whether any scan root's spawn succeeded,
// so a broken/missing forge-sync.cjs never hides a project the installer itself already knows
// about, and vice versa. Only when EVERY scan root's spawn failed AND the installer list
// contributed nothing real does this report ok:false, with every root's own error folded into one
// message (the installer-list source has nothing equivalent to a "spawn failed" state — an absent/
// malformed file already degrades to "found nothing there", per installed-projects.mjs's own
// contract, so it never has its own failure branch here).
//
// Codex run B F-12 (2026-09-28): the two sources are admitted under DIFFERENT rules, both keyed on
// the REAL (symlink/junction-resolved) path, never the lexical one:
//   - a SCAN-discovered candidate (forge-sync.cjs's own directory walk) is admitted only when its
//     REAL path is inside a REAL scan root — a junction that lexically sits inside a scan root but
//     resolves somewhere else entirely is rejected, never silently trusted (the "in-root link
//     pointing outside the allowed roots" case this finding names).
//   - a REGISTRY-sourced path (installed-projects.mjs's own F-01/F-12 fix already returns it as a
//     real, network/device/control-char-checked path) is admitted UNCONDITIONALLY — no scan-root
//     requirement, since a project the installer registered outside the scan roots is the NORMAL
//     case for a beginner's fresh install — and its own real path is additionally recorded as an
//     ADMITTED CONTAINMENT ROOT (admitted-roots.mjs) so every OTHER per-project route (runs.mjs,
//     proof.mjs's callers, server.mjs's resolveProjectByName, etc.) accepts it too, never just this
//     file's own GET /api/projects listing.
async function computeProjectsAsync() {
  const results = await Promise.all(activeScanRoots().map(scanOneRoot));
  const succeeded = results.filter((r) => r.ok);

  const scanRootsReal = activeScanRootsReal();
  const seenRealPaths = new Set();
  const projectPaths = []; // REAL paths, deduplicated across both sources
  const registryRealRoots = []; // the subset admitted via the registry — becomes an admitted containment root

  function addScanCandidate(p) {
    if (isForgeTemplateHost(p)) return; // WP-P1: never the template install itself
    // safeRealpathSync checks every link's own target before following it (Codex run B F-01), so a
    // project folder behind a junction to a network share is dropped without that share ever being
    // touched; a broken/circular link is never admitted either.
    const safe = safeRealpathSync(path.resolve(p));
    if (!safe.ok) return;
    const real = safe.real;
    if (isNetworkOrDevicePath(real) || hasControlChars(real)) return; // defense in depth on the RESOLVED target
    if (!anyContainmentOk(scanRootsReal, real)) return; // F-12: an escaping link is rejected, not trusted
    if (seenRealPaths.has(real)) return;
    seenRealPaths.add(real);
    projectPaths.push(real);
  }
  function addRegistryCandidate(real) {
    // `real` is ALREADY the validated, canonical path — installed-projects.mjs's own reader applies
    // the same F-01 (network/device/control-char) checks before ever returning an entry.
    if (isForgeTemplateHost(real)) return;
    registryRealRoots.push(real);
    if (seenRealPaths.has(real)) return; // already admitted via scan — still counts as a root above, never listed twice
    seenRealPaths.add(real);
    projectPaths.push(real);
  }
  for (const r of succeeded) {
    for (const p of r.paths) addScanCandidate(p);
  }
  for (const p of readInstalledProjectPaths()) addRegistryCandidate(p);
  // Codex run B F-12: every OTHER per-project route's own containment check must see this SAME
  // admitted set, updated on every recompute — a project later de-registered by the installer
  // stops being an admitted root on the very next recompute too, never forever.
  setAdmittedRegistryRoots(registryRealRoots);

  if (succeeded.length === 0 && projectPaths.length === 0) {
    // Finding #4 (WP-C2, 2026-09-26 laptop re-audit): the detail string below names every scan
    // root's real absolute path (which starts with the OS home directory / username) plus the raw
    // child-process error text. That is genuine local system detail — it must never reach a client
    // response (this `error` value is what GET /api/projects returns verbatim, and what every
    // route's `registryError` passthrough in server.mjs sends back too). Kept in this process's
    // own log only; the client gets one generic, non-identifying message.
    const detail = results.map((r) => r.root + ': ' + r.error).join(' | ');
    console.error('[projects] forge-sync list failed for every scan root: ' + detail);
    return {
      ok: false,
      error: 'forge-sync list failed for every scan root (see the gateway process log for details)',
      projects: [],
      default_project_id: null,
    };
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
  return { ok: true, projects: projectsWithAmbiguity, default_project_id: resolveDefaultProjectId(projectsWithAmbiguity) };
}

function buildDataObject(result, capturedAtMs) {
  return {
    ok: result.ok,
    error: result.error,
    projects: result.projects,
    default_project_id: result.default_project_id ?? null,
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
