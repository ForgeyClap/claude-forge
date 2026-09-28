// Per-project run listing. `projectPath` here must ALREADY be a value taken from the trusted
// project registry (listProjects()) — this module still re-checks containment itself
// (defense in depth) rather than trusting that upstream check alone.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk, anyContainmentOk } from './security.mjs';
// Codex run B F-12: the DYNAMIC admitted-roots boundary (fixed scan roots PLUS whatever the
// registry currently, honestly admits) — replaces the old, fixed-only SYNC_SCAN_ROOTS so a project
// the installer registered outside the scan roots (the normal case for a beginner's fresh install)
// is usable here too, not just listed by GET /api/projects. See admitted-roots.mjs's own header.
import { getContainmentRoots } from './admitted-roots.mjs';
// WP-CC1: the SAME "how long may an agent stay silent before we stop calling this live" window
// missions.mjs's own PASS 4 uses (and agent-dispatches.mjs's new run-log heartbeat — see that
// file), imported rather than re-declared so every view of "is this still running" agrees on one
// number instead of three independently-tuned ones drifting apart.
import { STALE_TASK_MS } from './missions.mjs';
// WP-CC1 (Lead review, HIGH): the real per-tool-call heartbeat — see toollog.mjs's own header for
// why an events.jsonl-only liveness signal (below) misses a Boss that works for a long stretch
// without ever emitting a mission event.
import { readToolLogRows, hasAttributedToolLogActivity } from './toollog.mjs';
// WP-CC1 (Lead review round 2): a role:'reviewer' dispatch closes at its own review_completed (no
// dispatch_id at all), never at subagent_completed — see reviewer-pairing.mjs's own header. Needed
// here too: an open reviewer dispatch that never gets recognized as closed would otherwise inflate
// openDispatchCount/openDispatchIds forever, the same way it inflated agent-dispatches.mjs's own
// `running` flags.
import { createReviewerTracker } from './reviewer-pairing.mjs';
import { buildAgentNameIndex } from './agent-names.mjs';
// Codex run B F-11: the ONE shared receipt validator, also used by proof.mjs — see its own header
// for why "any parseable JSON object" was never enough to mean "genuinely finalized".
import { validateFinalizeReceipt } from './receipt-validator.mjs';
import { eventsLogFingerprint } from './events-digest.mjs';
import { readDirBounded } from './bounded-readdir.mjs';

// WP-CC1 (item 1): mirrors `.claude/forge-bin/forge-snapshot.cjs`'s own WORK_EVENT_TYPES /
// runWorkSignal / syntheticDeclaration / rankByWorkRecency (verified by reading that file,
// lines ~60-150 and ~358-497) — reimplemented here rather than `require()`d from a foreign
// project's own .claude/forge-bin (this gateway never executes a selected project's own scripts;
// see config.mjs's "SETTINGS, NEVER CODE" precedent) and rather than imported across gateway
// modules that have no other reason to depend on each other. Same criterion, own copy: "does this
// run contain anything a resuming session/dashboard would actually learn from?" — DONE ∪ GAP ∪
// IN-PROGRESS ∪ OUTCOME event types, minus the purely-administrative ones a liveness sweep can
// stamp onto a long-dead run (`run_completed`).
const DONE_EVENT_TYPES = new Set([
  'wp_completed', 'check_passed', 'quality_gate_passed', 'subagent_completed', 'agent_completed',
  'fix_completed', 'rework_completed', 'retest_completed', 'merge_completed',
  'lead_review_completed', 'codex_review_completed', 'dashboard_health_verified', 'research_done',
  'final_output_created', 'report_generated', 'prd_generated', 'artifact_stored',
  'run_completed',
]);
const GAP_EVENT_TYPES = new Set([
  'check_failed', 'quality_gate_blocked', 'rework_task_created', 'subagent_failed',
  'audit_finding', 'codex_finding',
]);
const IN_PROGRESS_EVENT_TYPES = new Set([
  'subagent_started', 'agent_started', 'fix_started', 'check_started', 'rework_assigned',
]);
const OUTCOME_EVENT_TYPES = new Set(['doctor_run', 'ticket_created', 'ticket_updated']);
const ADMINISTRATIVE_EVENT_TYPES = new Set(['run_completed']);
const WORK_EVENT_TYPES = new Set(
  [...DONE_EVENT_TYPES, ...GAP_EVENT_TYPES, ...IN_PROGRESS_EVENT_TYPES, ...OUTCOME_EVENT_TYPES]
    .filter((t) => !ADMINISTRATIVE_EVENT_TYPES.has(t)),
);
// A lighter local copy of missions.mjs's own START/COMPLETE/FAIL sets, used ONLY for the cheap
// "how many dispatches in this run are still open" signal below (item 2's "live" status) — not
// for real dispatch-pairing (that stays missions.mjs's job; a wrong pairing here would only ever
// mis-count a liveness signal, never mis-report a specific task's own status).
const DISPATCH_START_TYPES = new Set(['subagent_started', 'agent_started']);
const DISPATCH_END_TYPES = new Set(['subagent_completed', 'agent_completed', 'subagent_failed', 'agent_failed']);

// How far ahead of "now" an event's own `timestamp` may sit before it is refused as implausible
// for DATING purposes (mirrors forge-snapshot.cjs's FUTURE_TOLERANCE_MS) — a clock-skew or typo'd
// future timestamp must never make a run look newer than it honestly is.
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

// cc-fix-adapter T6c: one pass over events.jsonl now does multiple duty — the pre-existing line
// count (unchanged external behavior) PLUS a real run duration, derived from the first and last
// event's own `timestamp` field (never a `run_completed` event exists in this fleet today, verified
// live — but if a future run's LAST recorded event genuinely is `run_completed`, that is the more
// specific, honestly-labelled source; otherwise it is the honest first-vs-last-event fallback),
// PLUS (WP-CC1) the work-recency/liveness signal every row now needs: `workEvents`,
// `lastWorkAtMs`/`lastWorkAt`, `startedAtMs`/`startedAt` (this run's own `run_started`),
// `implausibleWorkEvents`/`implausibleLatestAt`, and `openDispatchCount`.
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
function emptyScan(error) {
  return {
    count: 0, durationMs: null, durationSource: null, error,
    workEvents: 0, lastWorkAtMs: null, lastWorkAt: null, startedAtMs: null, startedAt: null,
    implausibleWorkEvents: 0, implausibleLatestAt: null, openDispatchCount: 0,
    // WP-CC1 (Lead review, HIGH): the actual open dispatch IDs, not just their count — deriveStatus()
    // needs to check each one's own real tool-log activity, not merely know how many are open.
    openDispatchIds: [],
    // Codex run B F-05: never truncated when there is honestly nothing (or a genuine read error) —
    // only a real, oversized file sets this (see readEventsFileTailBounded()).
    truncated: false,
  };
}

// Codex run B F-05 (2026-09-28): the largest real events.jsonl on this fleet today is ~420KB
// (measured live across every run in this project) — 2MB is a generous ceiling that never fires on
// any real file seen so far, while still bounding a pathological/future one so a single GET can
// never make the gateway read and JSON.parse an unbounded number of megabytes off disk.
const MAX_EVENTS_FILE_READ_BYTES = 2 * 1024 * 1024;

// Reads eventsPath whole when it fits the bound (the ordinary case, unchanged behavior); otherwise
// tails the LAST MAX_EVENTS_FILE_READ_BYTES bytes only — the same bounded-read technique
// toollog.mjs already uses for its own per-tool-call log. `truncated:true` tells the caller that
// `count`/`durationMs` (which need the file's true FIRST event) can no longer be honestly computed,
// while workEvents/lastWorkAtMs/openDispatchIds (liveness/status — the fields this instruction
// explicitly calls out as "the last part needed for liveness and status") are still derived from
// whatever real, recent content the tail captured. May throw (ENOENT etc.) — the caller already
// catches that around the whole read, exactly as before.
function readEventsFileTailBounded(eventsPath) {
  const stat = fs.statSync(eventsPath);
  if (stat.size <= MAX_EVENTS_FILE_READ_BYTES) {
    return { text: fs.readFileSync(eventsPath, 'utf8'), truncated: false };
  }
  const readLen = MAX_EVENTS_FILE_READ_BYTES;
  const buf = Buffer.alloc(readLen);
  const fd = fs.openSync(eventsPath, 'r');
  try {
    fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  // The read started mid-file — the very first "line" is very likely a truncated fragment of a
  // real record and is dropped rather than risk parsing (or mis-counting) a partial line.
  const firstNewline = text.indexOf('\n');
  return { text: firstNewline === -1 ? '' : text.slice(firstNewline + 1), truncated: true };
}

function scanEventsFile(eventsPath, nowMs, nameIndex) {
  let raw;
  let truncated = false;
  try {
    const bounded = readEventsFileTailBounded(eventsPath);
    raw = bounded.text;
    truncated = bounded.truncated;
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyScan(null);
    return emptyScan('failed to read events.jsonl: ' + (err && err.message ? err.message : String(err)));
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const horizonMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) + FUTURE_TOLERANCE_MS;
  let firstTs = null;
  let lastTs = null;
  let lastEventType = null;
  let workEvents = 0;
  let lastWorkAtMs = null;
  let lastWorkAt = null;
  let startedAtMs = null;
  let startedAt = null;
  let implausibleWorkEvents = 0;
  let implausibleLatestMs = null;
  let implausibleLatestAt = null;
  const startedDispatchIds = new Set();
  const endedDispatchIds = new Set();
  // WP-CC1 (Lead review round 2): fresh per scan — a reviewer dispatch and its own review_completed
  // both belong to this SAME events.jsonl, never paired across two different runs.
  const reviewerTracker = createReviewerTracker();
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; } // a malformed line still counts toward event_count below
    if (typeof ev.timestamp === 'string') {
      if (firstTs === null) firstTs = ev.timestamp;
      lastTs = ev.timestamp;
      lastEventType = typeof ev.event_type === 'string' ? ev.event_type : null;
    }
    const et = ev.event_type;
    // review_completed carries NO dispatch_id at all (self-reported by the reviewing agent) —
    // closes the oldest still-open role:'reviewer' dispatch for the SAME agent (by slug), never a
    // role:'worker' one even from the same agent. Checked before the dispatch_id branch below,
    // since this event type never carries one.
    if (et === 'review_completed') {
      const closedDispatchId = reviewerTracker.closeReviewer(nameIndex, ev.agent);
      if (closedDispatchId !== null) endedDispatchIds.add(closedDispatchId);
    } else if (typeof ev.dispatch_id === 'string' && ev.dispatch_id) {
      if (DISPATCH_START_TYPES.has(et)) {
        startedDispatchIds.add(ev.dispatch_id);
        if (ev.role === 'reviewer') reviewerTracker.openReviewer(nameIndex, ev.agent, ev.dispatch_id);
      } else if (DISPATCH_END_TYPES.has(et)) {
        endedDispatchIds.add(ev.dispatch_id);
      }
    }
    const rawMs = Date.parse(ev.timestamp);
    const plausible = Number.isFinite(rawMs) && rawMs <= horizonMs;
    if (et === 'run_started' && plausible && startedAtMs === null) { startedAtMs = rawMs; startedAt = String(ev.timestamp); }
    if (!WORK_EVENT_TYPES.has(et)) continue;
    workEvents += 1;
    if (Number.isFinite(rawMs) && !plausible) {
      implausibleWorkEvents += 1;
      if (implausibleLatestMs === null || rawMs > implausibleLatestMs) { implausibleLatestMs = rawMs; implausibleLatestAt = String(ev.timestamp); }
      continue;
    }
    if (plausible && (lastWorkAtMs === null || rawMs > lastWorkAtMs)) { lastWorkAtMs = rawMs; lastWorkAt = String(ev.timestamp); }
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
  let openDispatchCount = 0;
  const openDispatchIds = [];
  for (const id of startedDispatchIds) {
    if (endedDispatchIds.has(id)) continue;
    openDispatchCount += 1;
    openDispatchIds.push(id);
  }
  return {
    // Codex run B F-05: `count`/`durationMs`/`durationSource` need the file's true FIRST event,
    // which a tail-only read never has — reported as an honest `null` (never a wrong exact number)
    // when truncated. workEvents/lastWorkAtMs/openDispatchIds are still derived from the real,
    // recent content the tail DID capture — exactly the liveness/status fields this bound exists to
    // keep working even on an oversized file.
    count: truncated ? null : lines.length,
    durationMs: truncated ? null : durationMs,
    durationSource: truncated ? null : durationSource,
    error: null,
    workEvents, lastWorkAtMs, lastWorkAt, startedAtMs, startedAt,
    implausibleWorkEvents, implausibleLatestAt, openDispatchCount, openDispatchIds,
    truncated,
  };
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
//
// WP-CC1: the cache key stays file-identity only (never `nowMs`) — `nowMs` only affects the
// FUTURE_TOLERANCE_MS plausibility horizon, which moves by whole days, not by the few seconds
// between two polls, so re-using a cached scan across polls is still honest.
const SCAN_CACHE = new Map(); // absoluteEventsPath -> { mtimeMs, size, ...scanEventsFile() fields }
const MAX_SCAN_CACHE_ENTRIES = 500; // generous headroom over this fleet's real ~26-29 runs today

// Codex run B F-05: the most run directories any ONE buildRunRows() call will fully scan (read that
// run's own events.jsonl) for a single project — matches MAX_SCAN_CACHE_ENTRIES above (the same
// "how many runs is this codebase built to comfortably hold" ceiling); the largest real project in
// this fleet has 61 runs today, so this is generous headroom, not a bound that should ever fire on
// a real, honestly-used project.
const MAX_RUNS_SCANNED_PER_PROJECT = 500;
const MAX_RUN_DIR_ENTRIES = 20000;
let maxRunDirEntriesOverride = null;
export function _setMaxRunDirEntriesForTests(n) { maxRunDirEntriesOverride = n; }
export function _resetMaxRunDirEntriesForTests() { maxRunDirEntriesOverride = null; }
// Test-only override — same `_set*ForTests` convention this codebase uses throughout. Production
// code never calls this; asserting the REAL 500-run behavior would mean creating 501+ real temp
// directories per test, which is possible but needlessly slow — a test instead lowers the bound to
// a small number and proves the SAME truncation logic at that scale.
let maxRunsScannedOverride = null;
export function _setMaxRunsScannedPerProjectForTests(n) { maxRunsScannedOverride = n; }
export function _resetMaxRunsScannedPerProjectForTests() { maxRunsScannedOverride = null; }
function activeMaxRunsScannedPerProject() { return maxRunsScannedOverride || MAX_RUNS_SCANNED_PER_PROJECT; }

function evictScanCacheIfNeeded(key) {
  if (SCAN_CACHE.has(key)) return;
  while (SCAN_CACHE.size >= MAX_SCAN_CACHE_ENTRIES) {
    const oldestKey = SCAN_CACHE.keys().next().value;
    SCAN_CACHE.delete(oldestKey);
  }
}

// WP-CC1 (Lead review round 2): `nameIndex` is NOT part of the cache key — it is deterministically
// implied by `eventsPath` (both are always derived from the same `projectPath`), and the agent
// registry it comes from changes far less often than an events.jsonl does. A registry edit with no
// matching events.jsonl change would serve an already-cached reviewer-pairing result until this
// run's OWN events file next changes — an accepted, minor staleness, same class as every other
// input this cache does not key on (e.g. run.json, read fresh every call, outside this cache).
function scanEventsFileCached(eventsPath, nowMs, nameIndex) {
  let stat;
  try {
    stat = fs.statSync(eventsPath);
  } catch {
    SCAN_CACHE.delete(eventsPath); // file genuinely gone — never serve a stale hit for it
    return emptyScan(null);
  }
  const cached = SCAN_CACHE.get(eventsPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }
  const scanned = scanEventsFile(eventsPath, nowMs, nameIndex);
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, ...scanned };
  evictScanCacheIfNeeded(eventsPath);
  SCAN_CACHE.set(eventsPath, entry);
  return entry;
}

// Test-only hooks — same style as tools.mjs's _resetToolsCacheForTests()/_toolsCacheSizeForTests().
export function _resetRunsScanCacheForTests() { SCAN_CACHE.clear(); }
export function _runsScanCacheSizeForTests() { return SCAN_CACHE.size; }
export const _RUNS_SCAN_MAX_CACHE_ENTRIES_FOR_TESTS = MAX_SCAN_CACHE_ENTRIES;

// WP-CC1 (item 1): run.json is small (a few KB) and read at most once per run per call — no cache
// needed the way events.jsonl's (much larger, much hotter) scan needs one. Missing/unparseable is
// the ordinary case for many real runs (12 of this project's own 30 runs have none, per
// forge-snapshot.cjs's own measured comment) and is never an error here.
function readRunMetaSafe(runPath) {
  try { return JSON.parse(fs.readFileSync(path.join(runPath, 'run.json'), 'utf8')); } catch { return null; }
}

// Mirrors forge-snapshot.cjs's syntheticDeclaration(): only `synthetic === true` or `_demo === true`
// counts as a real self-declaration — anything else (absent, falsy, a string, an object) is judged
// on content like any other run, never guessed from a name pattern.
const SYNTHETIC_DECLARATION_FIELDS = ['synthetic', '_demo'];
function syntheticDeclaration(meta) {
  if (!meta || typeof meta !== 'object') return { synthetic: false, field: null };
  for (const f of SYNTHETIC_DECLARATION_FIELDS) {
    if (meta[f] === true) return { synthetic: true, field: f };
  }
  return { synthetic: false, field: null };
}

// Lead course-correction (WP-CC1, mid-task): the source-side fix (WP-CC0, commit a977ae0) reserved
// these exact synthetic run-folder names — forge-doctor.cjs's own self-check dirs
// (`doctor-selfcheck-<pid>`), the bench harness's canon/fake fixtures (`bench-canon[-N]`,
// `bench-fake[-N]`), and a literal `nonexistent-run-id` used by multi-project audits — so the
// gateway's own ranking must treat them as synthetic too, by NAME, even when their run.json (if
// any) never sets `synthetic`/`_demo` itself. Whole-folder-name match, case-sensitive, never a
// substring — a real run merely CONTAINING one of these words (e.g. a genuine
// "bench-canon-comparison-writeup" mission) must not be caught by this.
const RESERVED_SYNTHETIC_RUN_ID_PATTERNS = [
  /^bench-canon(-\d+)?$/,
  /^bench-fake(-\d+)?$/,
  /^doctor-selfcheck(-\d+)?$/,
  /^nonexistent-run-id$/,
];
function isReservedSyntheticRunId(runId) {
  return RESERVED_SYNTHETIC_RUN_ID_PATTERNS.some((re) => re.test(runId));
}

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

// WP-CC1 (Lead review, HIGH — "run liveness"): before this fix, an open dispatch OR a run.json
// still saying "running" was ENOUGH on its own to call a run 'live', forever, regardless of how
// long ago anything real actually happened — a run whose Boss never closed a dispatch (or whose
// run.json was never updated past "running") stayed 'live' permanently. Measured live: this made
// /api/active-runs report ~380 "active" runs across the fleet; the honest answer that same moment
// was ~1. 'live' now REQUIRES real, RECENT activity — one of three kinds, each judged inside
// STALE_TASK_MS (10 min, the same window missions.mjs's own liveness pass and agent-dispatches.mjs's
// dispatch heartbeat use):
//   (a) a real work event in this run's own events.jsonl (`lastWorkAtMs` — unchanged source);
//   (b) a `_toollog` row whose `agent_id` matches one of THIS run's own still-open dispatch ids —
//       this is what lets a Boss that works 30+ minutes on real tool calls, without ever emitting a
//       mission event, still be seen as genuinely working (see toollog.mjs's own header);
//   (c) when this run IS the project's current_run (the newest genuinely-qualifying run — item 1),
//       ANY `_toollog` row at all counts, including a Lead-level row (`agent_id:null`) — the Lead
//       can be actively working on the CURRENT run (reading, planning, running a command directly)
//       before any dispatch is even open yet.
// An open dispatch or a self-reported "running" run.json with NONE of the above is no longer
// silently 'live' forever: 'stalled' when the last real activity (the newest of a work event and
// any relevant tool-log row) is still within 24h — the mission may well resume — and honestly
// 'ended_unknown' when it is older than that (it never closed properly, and waiting longer teaches
// nothing new). finalized / a real run.json END state (anything other than "running") / report-only
// are unchanged.
const STALE_RUN_ENDED_UNKNOWN_MS = 24 * 60 * 60 * 1000;

// Codex run B F-09: `heartbeatEligible` is `isCurrentRun` WIDENED to also cover "the newest
// genuinely-started run that has no qualifying work event yet" (see isFreshlyStartedRunId() below)
// — a brand-new run (run.json status running, a real run_started event, not ended/finalized) has
// ZERO work_events by construction, so it can never win current_run (which requires >=1 real work
// event — item 1's own rule), yet the Lead is very often already doing real, unattributed work on
// it (reading/planning, agent_id:null) before the first dispatch even opens. Without this widening
// that genuinely-fresh Lead-level activity was invisible: the run could read 'ended_unknown' before
// it had any chance to prove itself alive.
// Codex verification NEW-1: `heartbeatFromMs` (the fresh run's own start) is a floor for the
// Lead-level heartbeat: a row from before that run existed belongs to earlier work, never to it.
function newestRelevantToolLogMs(toolLogRows, openDispatchIds, heartbeatEligible, heartbeatFromMs = null) {
  let newestMs = null;
  for (const row of toolLogRows) {
    const ms = Date.parse(row.ts);
    if (!Number.isFinite(ms)) continue;
    const heartbeatRow = heartbeatEligible && (heartbeatFromMs === null || ms >= heartbeatFromMs);
    const dispatchRow = row.agent_id !== null && openDispatchIds.includes(row.agent_id);
    if (!heartbeatRow && !dispatchRow) continue;
    if (newestMs === null || ms > newestMs) newestMs = ms;
  }
  return newestMs;
}

function maxIgnoringNull(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

// WP-CC1 (item 2, Lead-review-revised): status derivation order — finalized, then the run.json end
// state, then live (see the three-part real-activity rule above), then stalled/ended_unknown for an
// open-but-quiet run, then report-only, then honestly unknown. Never invents a status the evidence
// doesn't support.
function deriveStatus({ finalized, rawStatus, openDispatchIds, lastWorkAtMs, nowMs, hasFinalReport, isCurrentRun, isFreshlyStarted, freshStartedAtMs = null, toolLogRows, attributionWorks }) {
  if (finalized) return 'finalized';
  if (rawStatus && rawStatus.toLowerCase() !== 'running') return rawStatus;

  const recentWorkEvent = lastWorkAtMs !== null && (nowMs - lastWorkAtMs) <= STALE_TASK_MS;
  // Codex run B F-09: current_run OR the one newest genuinely-started, not-yet-qualifying run —
  // see newestRelevantToolLogMs()'s own header.
  const newestToolMs = newestRelevantToolLogMs(toolLogRows, openDispatchIds, isCurrentRun || isFreshlyStarted,
    !isCurrentRun && isFreshlyStarted ? freshStartedAtMs : null);
  const recentToolActivity = newestToolMs !== null && (nowMs - newestToolMs) <= STALE_TASK_MS;
  if (recentWorkEvent || recentToolActivity) return 'live';

  const hasOpenSignal = rawStatus.toLowerCase() === 'running' || openDispatchIds.length > 0;
  if (hasOpenSignal) {
    // WP-CC1 (Lead review round 2 — "heartbeat fallback"): once attribution is confirmed working on
    // this project AND this run genuinely has an open dispatch, the run's own blanket lastWorkAtMs
    // (which could be a completely unrelated agent's event, or predate this open dispatch entirely)
    // must not "rescue" that dispatch's own staleness classification — only its OWN attributed
    // tool-log evidence (already computed above as newestToolMs) may. The blanket signal is trusted
    // again only when attribution genuinely is not available at all (the coarser, honest fallback).
    const lastActivityMs = (attributionWorks && openDispatchIds.length > 0)
      ? newestToolMs
      : maxIgnoringNull(lastWorkAtMs, newestToolMs);
    if (lastActivityMs !== null && (nowMs - lastActivityMs) <= STALE_RUN_ENDED_UNKNOWN_MS) return 'stalled';
    return 'ended_unknown';
  }
  if (hasFinalReport) return 'report-only';
  return 'unknown';
}

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

// WP-CC1 (item 1): "rank runs the way forge-snapshot.cjs does" — a QUALIFYING run (>=1 real work
// event, not self-declared synthetic) always sorts ahead of a non-qualifying one (a workless
// doctor-selfcheck/bench-canon leftover, or a run.json-declared demo), and only within each of
// those two tiers does the real recency key (last real work event, else this run's own
// run_started, else honest file mtime — forge-snapshot.cjs's own three-rung ladder) decide order.
// Without the qualification tier, a workless run with a very fresh mtime could still outrank a real
// run whose last real work happened yesterday — exactly the "test leftovers win" bug this fixes.
function recencyKeyMs(run) {
  if (run._lastWorkAtMs !== null) return run._lastWorkAtMs;
  if (run._startedAtMs !== null) return run._startedAtMs;
  return mtimeMsOrMinusInfinity(run);
}

function compareRunsRanked(a, b) {
  const aQualifies = a.work_events > 0 && !a.synthetic;
  const bQualifies = b.work_events > 0 && !b.synthetic;
  if (aQualifies !== bQualifies) return aQualifies ? -1 : 1;
  const diff = recencyKeyMs(b) - recencyKeyMs(a);
  if (diff !== 0) return diff;
  const mtimeDiff = mtimeMsOrMinusInfinity(b) - mtimeMsOrMinusInfinity(a);
  if (mtimeDiff !== 0) return mtimeDiff;
  return b.run_id.localeCompare(a.run_id); // stable tiebreak, never re-orders equal-key pairs randomly
}

// Shared builder — both listRuns() (the public /api/runs shape) and mostRecentWorkSignalMs() (item
// 4's default-project heuristic in projects.mjs) need the exact same per-run computation and the
// exact same ranking, so there is only ever ONE place that decides "what counts as this project's
// most current real work".
function buildRunRows(projectPath, nowMs) {
  if (!anyContainmentOk(getContainmentRoots(), projectPath)) {
    return { ok: false, error: 'project path outside allowed scan root' };
  }
  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  if (!fs.existsSync(runsDir)) {
    return { ok: true, runs: [], currentRun: null, currentRunSignalMs: null, runsTruncated: false };
  }
  // Codex verification (F-05): the raw listing itself is bounded (readDirBounded), not only the
  // number of runs scanned in full below; hitting that budget is reported as runs_truncated.
  let entries;
  let rawListingTruncated = false;
  try {
    const listed = readDirBounded(runsDir, maxRunDirEntriesOverride ?? MAX_RUN_DIR_ENTRIES);
    entries = listed.entries;
    rawListingTruncated = listed.truncated;
  } catch (err) {
    return { ok: false, error: 'failed to read runs dir: ' + err.message };
  }

  // Codex run B F-05: a project can accumulate far more run directories than any one request
  // should ever fully scan (each full scan reads that run's own events.jsonl). Cheap pass first —
  // filesystem METADATA only (readdir + stat), never a content read — ranked by the events.jsonl
  // file's OWN mtime when present (bumped on every real append), falling back to the run
  // directory's own mtime for a run.json-only run. A run DIRECTORY's own mtime was deliberately
  // NOT used as the primary signal: appending to an existing child FILE does not bump its PARENT
  // directory's own mtime on most filesystems, which would silently starve every long-lived,
  // actively-worked run of its own real recency. Only the newest MAX_RUNS_SCANNED_PER_PROJECT
  // candidates go on to the expensive per-run events scan below; `runsTruncated` says so honestly
  // when the real count exceeds that bound — never a silent drop.
  const candidateDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const runPath = path.join(runsDir, runId);
    if (!containmentOk(runsDir, runPath)) continue; // should be impossible, kept as a hard guard
    // FU2 fix (WP5 self-review follow-up): a "run" is any directory that actually carries the
    // shape of a real Forge run (events.jsonl and/or run.json) — NOT every directory under
    // forge-runs/. Without this, an unrelated operational directory (e.g. a real `.hotspot-locks`
    // lock directory this project genuinely has) was silently counted and listed as a "run".
    const eventsPath = path.join(runPath, 'events.jsonl');
    const hasRunJson = fs.existsSync(path.join(runPath, 'run.json'));
    const hasEventsJsonl = fs.existsSync(eventsPath);
    if (!hasRunJson && !hasEventsJsonl) continue;
    let mtimeIso = null;
    try {
      mtimeIso = fs.statSync(runPath).mtime.toISOString();
    } catch { /* leave null, honest */ }
    // Prefer events.jsonl's OWN mtime as the recency signal — genuinely bumped on every real
    // append. The run DIRECTORY's own mtime is only a FALLBACK for a run.json-only run (no
    // events.jsonl yet): once events.jsonl exists, the directory's own (typically frozen-at-
    // creation) mtime is stale noise next to it, never blended in via a max() — a directory
    // created once, long ago, must never make an actively-appended-to run look artificially old
    // OR (the inverse, equally wrong) let a directory touched for an unrelated reason (e.g. a
    // sibling file write) outrank the events file's own, more specific signal.
    let recencyMs = Number.NEGATIVE_INFINITY;
    if (hasEventsJsonl) {
      try { recencyMs = fs.statSync(eventsPath).mtimeMs; } catch { /* leave -Infinity, honest */ }
    } else {
      try { recencyMs = fs.statSync(runPath).mtimeMs; } catch { /* leave -Infinity, honest */ }
    }
    candidateDirs.push({ runId, runPath, hasRunJson, mtimeIso, recencyMs });
  }
  candidateDirs.sort((a, b) => b.recencyMs - a.recencyMs);
  const maxRunsScanned = activeMaxRunsScannedPerProject();
  const runsTruncated = rawListingTruncated || candidateDirs.length > maxRunsScanned;
  const boundedCandidates = candidateDirs.slice(0, maxRunsScanned);

  // WP-CC1 (Lead review round 2): built ONCE per call, reused for every run below (the same small
  // registry file would otherwise be re-read once per run) — see scanEventsFileCached()'s own
  // comment for why this is not part of that cache's key.
  const nameIndex = buildAgentNameIndex(projectPath);
  const runs = [];
  for (const { runId, runPath, hasRunJson, mtimeIso } of boundedCandidates) {
    const eventsScan = scanEventsFileCached(path.join(runPath, 'events.jsonl'), nowMs, nameIndex);
    const runMeta = hasRunJson ? readRunMetaSafe(runPath) : null;
    const declaredSynth = syntheticDeclaration(runMeta);
    // Lead course-correction: a reserved name wins even when run.json stays silent (or is absent
    // entirely — doctor-selfcheck-* dirs famously carry no run.json at all).
    const synth = declaredSynth.synthetic
      ? declaredSynth
      : (isReservedSyntheticRunId(runId) ? { synthetic: true, field: 'reserved-run-id-pattern' } : declaredSynth);
    const hasFinalReport = fs.existsSync(path.join(runPath, 'final-report.md'));
    // Codex run B F-11: ANY parseable JSON object (`{}`, even `[]` — `typeof [] === 'object'` in
    // JS) used to count as "finalized:true" with no real digest at all. validateFinalizeReceipt()
    // (shared with proof.mjs) requires the exact matching run_id, a real 64-hex digest, and a
    // literal green contract before this run is honestly reported finalized.
    const finalizedReceiptRaw = readJsonSafe(path.join(runPath, 'run-finalized.json'));
    // WP-RB-CC (M-1), made strict by the Codex review of 2026-09-28 (R1): the receipt only counts while
    // the live events.jsonl still has its exact byte size AND sha256. Only a run that HAS a receipt is
    // fingerprinted (cached on size and mtime, see events-digest.mjs); a missing or unreadable log never
    // counts as finalized.
    const receiptCheck = validateFinalizeReceipt(finalizedReceiptRaw, runId, finalizedReceiptRaw === null ? null : eventsLogFingerprint(runPath));
    const hasGateEvidence = fs.existsSync(path.join(runPath, 'gate-evidence.json'));
    const finalized = receiptCheck.valid;
    runs.push({
      run_id: runId,
      has_run_json: hasRunJson,
      has_final_report: hasFinalReport,
      event_count: eventsScan.count,
      duration_ms: eventsScan.durationMs,
      duration_source: eventsScan.durationSource,
      // P1-2 second-order-bug fix: non-null exactly when events.jsonl exists but genuinely could not
      // be read/parsed as a whole (never set for the honest "file doesn't exist yet" case) — a caller
      // can now tell "0 events, nothing happened yet" apart from "0 events because the read failed".
      event_scan_error: eventsScan.error || null,
      // Codex run B F-05: true only when events.jsonl exceeded the read bound and was tailed
      // instead of read in full — event_count/duration_ms/duration_source are honestly null in
      // that case (see scanEventsFile()'s own header), and open_dispatch_count could UNDER-count a
      // dispatch that started before the tail window (never over-count — the safer direction).
      event_scan_truncated: eventsScan.truncated,
      mtime: mtimeIso,
      // WP-CC1 (item 1):
      synthetic: synth.synthetic,
      synthetic_field: synth.field,
      work_events: eventsScan.workEvents,
      // WP-CC1 (item 2, Lead-review-revised): `status` itself is computed in the SECOND pass below —
      // deriveStatus() needs to know whether THIS run is the project's current_run (rule (c) of the
      // liveness fix), which is only known once every row's ranking data has been collected and
      // sorted. Left unset here on purpose; every row gets a real status before this function returns.
      title: (runMeta && (runMeta.request || runMeta.task)) || null,
      started_at: (runMeta && typeof runMeta.started_at === 'string' ? runMeta.started_at : null) || eventsScan.startedAt,
      last_work_at: eventsScan.lastWorkAt,
      finalized,
      finalize_digest: finalized ? (receiptCheck.receipt.digest || null) : null,
      // Codex run B F-11 addition: non-null ONLY when a run-finalized.json genuinely exists but
      // failed validation (a malformed/forged receipt) — never set for the ordinary "never
      // finalized yet" case (`reason: 'absent'` stays internal, not surfaced as a false alarm).
      finalize_invalid_reason: (!finalized && receiptCheck.reason !== 'absent') ? receiptCheck.reason : null,
      has_gate_evidence: hasGateEvidence,
      open_dispatch_count: eventsScan.openDispatchCount,
      // Internal-only fields (never exposed by listRuns()'s public shape) — kept alongside the
      // public row so compareRunsRanked()/recencyKeyMs()/deriveStatus() do not need a second pass
      // over the raw events/run.json.
      _lastWorkAtMs: eventsScan.lastWorkAtMs,
      _startedAtMs: eventsScan.startedAtMs,
      _openDispatchIds: eventsScan.openDispatchIds,
      _rawStatus: runMeta && typeof runMeta.status === 'string' ? runMeta.status.trim() : '',
    });
  }
  runs.sort(compareRunsRanked);
  const currentRow = runs.find((r) => r.work_events > 0 && !r.synthetic) || null;
  const currentRun = currentRow ? currentRow.run_id : null;
  const currentRunSignalMs = currentRow ? recencyKeyMs(currentRow) : null;

  // Codex run B F-09: the ONE newest "genuinely started" run with NO qualifying work event yet —
  // "genuinely started" means run.json status running, a real run_started event (_startedAtMs !==
  // null), and not finalized (never revives an ended/finalized run). Deliberately drawn ONLY from
  // work_events===0 candidates: a run with >=1 real work event either already IS currentRun (if
  // it's the ranked-newest qualifying one) or has its own real activity via rule (a) regardless —
  // this rule exists ONLY to cover the gap before a run's first qualifying event.
  let freshlyStartedRunId = null;
  let freshlyStartedAtMs = -Infinity;
  for (const r of runs) {
    if (r.work_events > 0) continue;
    if (r.finalized) continue;
    if (r._rawStatus.toLowerCase() !== 'running') continue;
    if (r._startedAtMs === null) continue;
    if (r._startedAtMs > freshlyStartedAtMs) { freshlyStartedAtMs = r._startedAtMs; freshlyStartedRunId = r.run_id; }
  }
  // Lead review of the F-09 fix: the Lead's heartbeat belongs to the newest thing it works on. A
  // "fresh" run that started BEFORE the current run's latest activity is an abandoned start, not the
  // work in progress (it would otherwise show as running while the Lead works in the current run),
  // and one that started more than a day ago is not fresh at all (the same day the stalled -> ended
  // rule above uses).
  if (freshlyStartedRunId !== null && (
    (currentRunSignalMs !== null && freshlyStartedAtMs <= currentRunSignalMs) ||
    nowMs - freshlyStartedAtMs > STALE_RUN_ENDED_UNKNOWN_MS)) {
    freshlyStartedRunId = null;
  }

  // WP-CC1 (Lead review, HIGH): ONE toollog read for the whole project (itself cached ~5s — see
  // toollog.mjs), reused for every row's status below — never one read per run row.
  const toolLogRows = readToolLogRows(projectPath, nowMs);
  // WP-CC1 (Lead review round 2): a PROJECT-WIDE property, computed once and reused for every row.
  const attributionWorks = hasAttributedToolLogActivity(toolLogRows, nowMs);

  // Second pass: now that current_run is known, every row can get its real, evidence-based status.
  // Strips the internal fields too — listRuns() below is the only public shape, and it must never
  // expose an underscore-prefixed implementation detail.
  const publicRuns = runs.map((r) => {
    const status = deriveStatus({
      finalized: r.finalized,
      rawStatus: r._rawStatus,
      openDispatchIds: r._openDispatchIds,
      lastWorkAtMs: r._lastWorkAtMs,
      nowMs,
      hasFinalReport: r.has_final_report,
      isCurrentRun: r.run_id === currentRun,
      isFreshlyStarted: r.run_id === freshlyStartedRunId,
      freshStartedAtMs: r._startedAtMs,
      toolLogRows,
      attributionWorks,
    });
    const { _lastWorkAtMs, _startedAtMs, _openDispatchIds, _rawStatus, ...rest } = r;
    return { ...rest, status };
  });
  return { ok: true, runs: publicRuns, currentRun, currentRunSignalMs, runsTruncated };
}

// Returns { ok, runs, current_run, runs_truncated, captured_at, age_ms, provenance } or { ok:false, error }.
export function listRuns(projectPath, now = Date.now()) {
  const built = buildRunRows(projectPath, now);
  if (!built.ok) return built;
  const capturedAt = new Date(now);
  return {
    ok: true,
    runs: built.runs,
    // WP-CC1 (item 1): the newest run that genuinely qualifies (>=1 real work event, not
    // self-declared synthetic) — null, honestly, when nothing under this project's forge-runs/
    // qualifies yet (a brand-new project, or one whose only runs are self-tests/demos).
    current_run: built.currentRun,
    // Codex run B F-05: true only when this project has MORE run directories than
    // MAX_RUNS_SCANNED_PER_PROJECT — the oldest ones beyond that bound are honestly omitted from
    // `runs` rather than silently dropped with no signal at all.
    runs_truncated: built.runsTruncated,
    captured_at: capturedAt.toISOString(),
    age_ms: 0,
    provenance: 'LIVE',
  };
}

// WP-CC1 (item 4): the ONE real "most recent work" signal projects.mjs's default-project picker
// needs, reusing this file's own ranking/cache rather than re-deriving it. Returns a ms epoch, or
// `null` when this project has no qualifying run at all (a brand-new project, or one with only
// self-test/demo runs) — projects.mjs falls back to its own dir-mtime heuristic in that case, never
// a fabricated number from here.
export function mostRecentWorkSignalMs(projectPath, now = Date.now()) {
  const built = buildRunRows(projectPath, now);
  if (!built.ok) return null;
  return built.currentRunSignalMs;
}
