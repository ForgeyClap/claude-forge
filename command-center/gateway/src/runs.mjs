// Per-project run listing. `projectPath` here must ALREADY be a value taken from the trusted
// project registry (listProjects()) — this module still re-checks containment itself
// (defense in depth) rather than trusting that upstream check alone.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk, anyContainmentOk } from './security.mjs';
import { SYNC_SCAN_ROOTS } from './paths.mjs';

// cc-fix-adapter T6c: one pass over events.jsonl now does double duty — the pre-existing line
// count (unchanged external behavior) PLUS a real run duration, derived from the first and last
// event's own `timestamp` field (never a `run_completed` event exists in this fleet today, verified
// live — but if a future run's LAST recorded event genuinely is `run_completed`, that is the more
// specific, honestly-labelled source; otherwise it is the honest first-vs-last-event fallback).
// `duration_ms`/`duration_source` are both `null` (never 0/'') when no two real timestamps exist to
// difference — a run with a single event, or an unparsable/missing timestamp, has no measurable
// duration yet, and 0 would falsely claim "instant".
//
// P1-2 fix (cc-fix-gateway-perf, forge-2026-07-29-cc-finish) — second-order bug closed here: the OLD
// `readFileSync(...).catch => count:0` swallowed EVERY read failure identically, including a genuine
// error (EACCES, or a RangeError when a file exceeds V8's max string length) — such a run silently
// reported `event_count: 0` with no duration, indistinguishable from an honestly-empty run. Now only
// ENOENT (the file genuinely doesn't exist yet — a normal, honest empty state for a brand-new run)
// returns a clean zero; any OTHER failure is surfaced via the new `error` field instead of being
// presented as "nothing happened here".
function scanEventsFile(eventsPath) {
  let raw;
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { count: 0, durationMs: null, durationSource: null, error: null };
    return { count: 0, durationMs: null, durationSource: null, error: 'failed to read events.jsonl: ' + (err && err.message ? err.message : String(err)) };
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let firstTs = null;
  let lastTs = null;
  let lastEventType = null;
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; } // a malformed line still counts toward event_count below
    if (typeof ev.timestamp === 'string') {
      if (firstTs === null) firstTs = ev.timestamp;
      lastTs = ev.timestamp;
      lastEventType = typeof ev.event_type === 'string' ? ev.event_type : null;
    }
  }
  let durationMs = null;
  let durationSource = null;
  if (firstTs !== null && lastTs !== null) {
    const startMs = Date.parse(firstTs);
    const endMs = Date.parse(lastTs);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      durationMs = endMs - startMs;
      durationSource = lastEventType === 'run_completed' ? 'run-completed-event' : 'derived-from-events';
    }
  }
  return { count: lines.length, durationMs, durationSource, error: null };
}

// P1-2 fix: `scanEventsFile()` above does a full readFileSync + line-by-line JSON.parse — cheap for
// ONE file, but `listRuns()` previously called it, uncached, for EVERY run directory on EVERY poll
// (measured live: a real ~9ms cost per call against this fleet's 26 real runs, on the gateway's
// single thread, repeated every 5s per client — see the forge-report for this WP for the exact
// before/after benchmark). Cached here on real file identity `(path, mtimeMs, size)` — an unchanged
// run (the overwhelming majority of runs on any given poll; only actively-running runs mutate their
// events.jsonl) is scanned exactly ONCE, not on every single poll. Mirrors the already-reviewed
// FIFO-bounded-cache pattern in tools.mjs (WP10 F4) rather than inventing a new one; bounded so this
// new cache itself can never become the next unbounded-growth defect.
const SCAN_CACHE = new Map(); // absoluteEventsPath -> { mtimeMs, size, count, durationMs, durationSource, error }
const MAX_SCAN_CACHE_ENTRIES = 500; // generous headroom over this fleet's real ~26-29 runs today

function evictScanCacheIfNeeded(key) {
  if (SCAN_CACHE.has(key)) return;
  while (SCAN_CACHE.size >= MAX_SCAN_CACHE_ENTRIES) {
    const oldestKey = SCAN_CACHE.keys().next().value;
    SCAN_CACHE.delete(oldestKey);
  }
}

function scanEventsFileCached(eventsPath) {
  let stat;
  try {
    stat = fs.statSync(eventsPath);
  } catch {
    SCAN_CACHE.delete(eventsPath); // file genuinely gone — never serve a stale hit for it
    return { count: 0, durationMs: null, durationSource: null, error: null };
  }
  const cached = SCAN_CACHE.get(eventsPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }
  const scanned = scanEventsFile(eventsPath);
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, ...scanned };
  evictScanCacheIfNeeded(eventsPath);
  SCAN_CACHE.set(eventsPath, entry);
  return entry;
}

// Test-only hooks — same style as tools.mjs's _resetToolsCacheForTests()/_toolsCacheSizeForTests().
export function _resetRunsScanCacheForTests() { SCAN_CACHE.clear(); }
export function _runsScanCacheSizeForTests() { return SCAN_CACHE.size; }
export const _RUNS_SCAN_MAX_CACHE_ENTRIES_FOR_TESTS = MAX_SCAN_CACHE_ENTRIES;

// FU1 fix (WP5 self-review follow-up): sort by each entry's REAL mtime, newest first — not by
// run_id string order. The prior `run_id.localeCompare()` sort silently broke for any
// non-date-prefixed run id ('d' > '2' lexically), surfacing e.g. `forge-demo-10agents-layout-
// preview` (370h old) ahead of a run created 3h ago. A missing/unparsable mtime sorts as if it
// were infinitely old (never fabricated as "newest"), and equal/missing mtimes fall back to a
// stable run_id-descending tiebreak so ordering never flaps between two otherwise-identical calls.
function mtimeMsOrMinusInfinity(run) {
  const t = run.mtime ? Date.parse(run.mtime) : NaN;
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

function compareRunsByRecency(a, b) {
  const diff = mtimeMsOrMinusInfinity(b) - mtimeMsOrMinusInfinity(a);
  if (diff !== 0) return diff;
  return b.run_id.localeCompare(a.run_id); // stable tiebreak, never re-orders equal-mtime pairs randomly
}

// Returns { ok, runs, captured_at, age_ms, provenance } or { ok:false, error }.
export function listRuns(projectPath) {
  // Defense in depth: the resolved project path must genuinely sit under the fixed scan root —
  // this catches a caller bug upstream even though the /api/runs route itself only ever passes
  // a path taken from the allowlisted registry, never a raw query value.
  if (!anyContainmentOk(SYNC_SCAN_ROOTS, projectPath)) {
    return { ok: false, error: 'project path outside allowed scan root' };
  }
  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const capturedAt = new Date();
  if (!fs.existsSync(runsDir)) {
    return { ok: true, runs: [], captured_at: capturedAt.toISOString(), age_ms: 0, provenance: 'LIVE' };
  }
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: 'failed to read runs dir: ' + err.message };
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const runPath = path.join(runsDir, runId);
    if (!containmentOk(runsDir, runPath)) continue; // should be impossible, kept as a hard guard
    // FU2 fix (WP5 self-review follow-up): a "run" is any directory that actually carries the
    // shape of a real Forge run (events.jsonl and/or run.json) — NOT every directory under
    // forge-runs/. Without this, an unrelated operational directory (e.g. a real `.hotspot-locks`
    // lock directory this project genuinely has) was silently counted and listed as a "run".
    const hasRunJson = fs.existsSync(path.join(runPath, 'run.json'));
    const hasEventsJsonl = fs.existsSync(path.join(runPath, 'events.jsonl'));
    if (!hasRunJson && !hasEventsJsonl) continue;
    let mtimeIso = null;
    try { mtimeIso = fs.statSync(runPath).mtime.toISOString(); } catch { /* leave null, honest */ }
    const eventsScan = scanEventsFileCached(path.join(runPath, 'events.jsonl'));
    runs.push({
      run_id: runId,
      has_run_json: hasRunJson,
      has_final_report: fs.existsSync(path.join(runPath, 'final-report.md')),
      event_count: eventsScan.count,
      duration_ms: eventsScan.durationMs,
      duration_source: eventsScan.durationSource,
      // P1-2 second-order-bug fix: non-null exactly when events.jsonl exists but genuinely could not
      // be read/parsed as a whole (never set for the honest "file doesn't exist yet" case) — a caller
      // can now tell "0 events, nothing happened yet" apart from "0 events because the read failed".
      event_scan_error: eventsScan.error || null,
      mtime: mtimeIso,
    });
  }
  runs.sort(compareRunsByRecency);
  return { ok: true, runs, captured_at: capturedAt.toISOString(), age_ms: 0, provenance: 'LIVE' };
}
