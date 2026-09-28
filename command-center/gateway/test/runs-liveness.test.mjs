// WP-CC1 (Lead review, HIGH — "run liveness") — listRuns()'s real status derivation, against
// isolated fixtures nested under COMMAND_CENTER_DATA_DIR (a real descendant of
// PROJECT_ROOT/SYNC_SCAN_ROOTS — runs.mjs's own anyContainmentOk() check rejects a plain
// os.tmpdir() fixture; see runs.test.mjs's own header for the same reasoning).
//
// THE BUG THIS FILE GUARDS: before this fix, an open dispatch OR a run.json still saying "running"
// was ENOUGH on its own to call a run 'live' — forever, no matter how long ago anything real last
// happened. Measured live against the real fleet: /api/active-runs reported ~380 "active" runs;
// the honest answer that same moment was ~1. Every test below proves ONE piece of the real,
// evidence-based replacement: (a) a real work event, (b) a `_toollog` row for one of THIS run's own
// open dispatches, or (c) — only for the project's current_run — ANY `_toollog` row at all, each
// judged inside the same 10-minute STALE_TASK_MS window every other liveness view in this codebase
// uses; anything else falls to 'stalled' (last activity within 24h) or 'ended_unknown' (older).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listRuns } from '../src/runs.mjs';
import { _resetToolLogCacheForTests } from '../src/toollog.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-runs-liveness');
const tempRoots = [];

function freshRoot() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  return root;
}

function writeEvents(root, runId, lines) {
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function writeRunJson(root, runId, data) {
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(data), 'utf8');
}

function writeToolLog(root, rows) {
  const dir = path.join(root, '.claude', 'forge-runs', '_toollog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session-a.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function writeRegistry(root, agents) {
  const dir = path.join(root, '.claude', 'config', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-registry.json'), JSON.stringify({ agents }), 'utf8');
}

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.parse('2026-09-28T18:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

beforeEach(() => {
  _resetToolLogCacheForTests();
});

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

test('an OLD run with an open dispatch and no tool-log activity at all -> ended_unknown, never live', () => {
  const root = freshRoot();
  writeEvents(root, 'run-old-open', [
    { event_type: 'run_started', timestamp: iso(NOW - 30 * HOUR) },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-old', timestamp: iso(NOW - 30 * HOUR) },
  ]);
  const result = listRuns(root, NOW);
  assert.equal(result.ok, true);
  const row = result.runs.find((r) => r.run_id === 'run-old-open');
  assert.ok(row);
  assert.equal(row.status, 'ended_unknown');
  assert.equal(row.open_dispatch_count, 1, 'the dispatch really is still open — this is not being hidden, just not called live');
});

test('an open dispatch whose last real activity (work event + tool-log) was 2h ago -> stalled, not live', () => {
  const root = freshRoot();
  writeEvents(root, 'run-stalled', [
    { event_type: 'run_started', timestamp: iso(NOW - 3 * HOUR) },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-stalled', timestamp: iso(NOW - 3 * HOUR) },
  ]);
  writeToolLog(root, [
    { ts: iso(NOW - 2 * HOUR), agent_id: 'd-stalled', tool: 'Bash' },
  ]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-stalled');
  assert.ok(row);
  assert.equal(row.status, 'stalled');
});

test('an open dispatch with a real tool-log row 1 minute ago under its OWN dispatch id -> live', () => {
  const root = freshRoot();
  writeEvents(root, 'run-live-toollog', [
    { event_type: 'run_started', timestamp: iso(NOW - 3 * HOUR) },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-live', timestamp: iso(NOW - 3 * HOUR) },
  ]);
  writeToolLog(root, [
    { ts: iso(NOW - 1 * MIN), agent_id: 'd-live', tool: 'Bash' },
  ]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-live-toollog');
  assert.ok(row);
  assert.equal(row.status, 'live', 'real, recent tool-call activity by the run\'s own open dispatch must count as live even with no recent mission event');
});

test('a tool-log row for a DIFFERENT run\'s dispatch id never makes an unrelated run live', () => {
  const root = freshRoot();
  writeEvents(root, 'run-a', [
    { event_type: 'run_started', timestamp: iso(NOW - 3 * HOUR) },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-a', timestamp: iso(NOW - 3 * HOUR) },
  ]);
  writeEvents(root, 'run-b', [
    { event_type: 'run_started', timestamp: iso(NOW - 3 * HOUR) },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-b', timestamp: iso(NOW - 3 * HOUR) },
  ]);
  // Only run-b's own dispatch id has recent activity.
  writeToolLog(root, [{ ts: iso(NOW - 1 * MIN), agent_id: 'd-b', tool: 'Bash' }]);
  const result = listRuns(root, NOW);
  const runA = result.runs.find((r) => r.run_id === 'run-a');
  const runB = result.runs.find((r) => r.run_id === 'run-b');
  assert.notEqual(runA.status, 'live', 'run-a\'s own dispatch never appears in the tool-log, so it must not borrow run-b\'s activity');
  assert.equal(runB.status, 'live');
});

test('the project\'s current_run reads live from Lead-level tool-log activity (agent_id:null) alone, even with no open dispatch', () => {
  const root = freshRoot();
  // A single run, with only an OLD, already-CLOSED dispatch (work_events > 0, so it qualifies as
  // current_run — item 1's own rule) — no open dispatch left, and no recent mission event either.
  writeEvents(root, 'run-current', [
    { event_type: 'run_started', timestamp: iso(NOW - 2 * HOUR) },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-done', timestamp: iso(NOW - 2 * HOUR) },
    { event_type: 'subagent_completed', agent: 'Build Boss', dispatch_id: 'd-done', verdict: 'PASS', timestamp: iso(NOW - 2 * HOUR + 5 * MIN) },
  ]);
  // Recent Lead-level activity (agent_id: null) — the Lead working directly, no dispatch open yet.
  writeToolLog(root, [{ ts: iso(NOW - 1 * MIN), agent_id: null, tool: 'Read' }]);

  const result = listRuns(root, NOW);
  assert.equal(result.current_run, 'run-current', 'sanity check: this must actually be the project\'s current_run for rule (c) to apply');
  const row = result.runs.find((r) => r.run_id === 'run-current');
  assert.equal(row.open_dispatch_count, 0, 'sanity check: no open dispatch — rule (c) must be what makes this live, not rule (b)');
  assert.equal(row.status, 'live');
});

test('Lead-level tool-log activity does NOT make a NON-current run live', () => {
  const root = freshRoot();
  // run-newer wins current_run (more recent work); run-quiet has a closed dispatch and no activity
  // of its own — Lead-level toollog rows must only rescue the CURRENT run, never every run.
  writeEvents(root, 'run-newer', [
    { event_type: 'run_started', timestamp: iso(NOW - 1 * HOUR) },
    { event_type: 'subagent_completed', agent: 'Build Boss', dispatch_id: 'd1', verdict: 'PASS', timestamp: iso(NOW - 1 * MIN) },
  ]);
  writeEvents(root, 'run-quiet', [
    { event_type: 'run_started', timestamp: iso(NOW - 40 * HOUR) },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-quiet', timestamp: iso(NOW - 40 * HOUR) },
    { event_type: 'subagent_completed', agent: 'Build Boss', dispatch_id: 'd-quiet', verdict: 'PASS', timestamp: iso(NOW - 39 * HOUR) },
  ]);
  writeToolLog(root, [{ ts: iso(NOW - 1 * MIN), agent_id: null, tool: 'Read' }]);

  const result = listRuns(root, NOW);
  assert.equal(result.current_run, 'run-newer');
  const quiet = result.runs.find((r) => r.run_id === 'run-quiet');
  assert.notEqual(quiet.status, 'live', 'the Lead-level toollog row belongs to whatever session is driving run-newer, not run-quiet');
});

test("a run.json 'running' with no work event and no tool-log activity at all -> honestly ended_unknown, never live", () => {
  const root = freshRoot();
  writeRunJson(root, 'run-stale-running', { run_id: 'run-stale-running', status: 'running', started_at: iso(NOW - 50 * HOUR) });
  writeEvents(root, 'run-stale-running', [
    { event_type: 'run_started', timestamp: iso(NOW - 50 * HOUR) },
  ]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-stale-running');
  assert.ok(row);
  assert.notEqual(row.status, 'live');
  assert.equal(row.status, 'ended_unknown', 'zero measurable activity of any kind leaves no honest "within 24h" to point to');
});

test("a run.json 'running' with real recent tool-log activity DOES read live", () => {
  const root = freshRoot();
  writeRunJson(root, 'run-json-running-live', { run_id: 'run-json-running-live', status: 'running', started_at: iso(NOW - 2 * HOUR) });
  writeEvents(root, 'run-json-running-live', [
    { event_type: 'run_started', timestamp: iso(NOW - 2 * HOUR) },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-rj', timestamp: iso(NOW - 2 * HOUR) },
  ]);
  writeToolLog(root, [{ ts: iso(NOW - 30 * 1000), agent_id: 'd-rj', tool: 'Bash' }]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-json-running-live');
  assert.equal(row.status, 'live');
});

test('finalized always wins over any liveness signal, even with an open dispatch and fresh tool-log activity', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-finalized-but-open');
  fs.mkdirSync(runDir, { recursive: true });
  writeEvents(root, 'run-finalized-but-open', [
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-fin', timestamp: iso(NOW - 1 * MIN) },
  ]);
  // Codex run B F-11: a real, VALID receipt shape (matching_run_id + a real digest + a green
  // contract + bytes/events) — a fake `{digest:'abc'}` no longer counts as finalized at all.
  // WP-RB-CC (M-1): `bytes` must be the REAL current size of events.jsonl (written above) — listRuns()
  // now refuses a receipt whose pinned bytes no longer match the live log as STALE, so a hand-picked
  // unrelated number here would (correctly) never validate any more.
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({
    run_id: 'run-finalized-but-open', digest: 'a'.repeat(64),
    bytes: fs.statSync(path.join(runDir, 'events.jsonl')).size, events: 5, contract: 'ok', finalized_at: iso(NOW),
  }), 'utf8');
  writeToolLog(root, [{ ts: iso(NOW - 30 * 1000), agent_id: 'd-fin', tool: 'Bash' }]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-finalized-but-open');
  assert.equal(row.status, 'finalized');
  assert.equal(row.finalize_digest, 'a'.repeat(64));
});

// WP-RB-CC (review finding M-1): the log grows into the SAME already-finalized run — Forge's own
// authority (`check()` in `.claude/forge-bin/forge-finalize.cjs`) calls this STALE the moment the
// live events.jsonl no longer digest/byte-matches the pinned receipt; the dashboard must agree.
test('M-1: a log that grows after finalizing is STALE, never "finalized" forever', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-grew-after-finalize');
  fs.mkdirSync(runDir, { recursive: true });
  writeEvents(root, 'run-grew-after-finalize', [{ event_type: 'run_started', timestamp: iso(NOW - 1 * HOUR) }]);
  const eventsPath = path.join(runDir, 'events.jsonl');
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({
    run_id: 'run-grew-after-finalize', digest: 'd'.repeat(64),
    bytes: fs.statSync(eventsPath).size, events: 1, contract: 'ok', finalized_at: iso(NOW - 1 * HOUR),
  }), 'utf8');

  const before = listRuns(root, NOW).runs.find((r) => r.run_id === 'run-grew-after-finalize');
  assert.equal(before.status, 'finalized', 'sanity: the receipt is genuinely valid before the log changes');
  assert.equal(before.finalized, true);

  // A follow-up logs one more event into the SAME already-finalized run.
  fs.appendFileSync(eventsPath, JSON.stringify({ event_type: 'agent_started', agent: 'Build Boss', timestamp: iso(NOW - 5 * MIN) }) + '\n', 'utf8');

  const after = listRuns(root, NOW).runs.find((r) => r.run_id === 'run-grew-after-finalize');
  assert.notEqual(after.status, 'finalized', 'a log that grew after finalizing must never still read as finalized');
  assert.equal(after.finalized, false);
  assert.equal(after.finalize_digest, null);
  assert.equal(after.finalize_invalid_reason, 'the log changed after it was finalized');
});

// Codex run B F-11: tests for the receipt-validation fix itself, on listRuns()'s own public shape.
test('F-11: a forged {} run-finalized.json never makes a run read finalized', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-forged-empty-object');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), '{}', 'utf8');
  writeEvents(root, 'run-forged-empty-object', [{ event_type: 'run_started', timestamp: iso(NOW - 30 * HOUR) }]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-forged-empty-object');
  assert.ok(row);
  assert.notEqual(row.status, 'finalized');
  assert.equal(row.finalized, false);
  assert.equal(row.finalize_digest, null);
  assert.match(row.finalize_invalid_reason, /receipt_invalid/);
});

test('F-11: a forged [] run-finalized.json never makes a run read finalized (typeof [] === "object" trap)', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-forged-array');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), '[]', 'utf8');
  writeEvents(root, 'run-forged-array', [{ event_type: 'run_started', timestamp: iso(NOW - 30 * HOUR) }]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-forged-array');
  assert.equal(row.finalized, false);
});

test('F-11: a receipt for a DIFFERENT run_id (copy-pasted from another run) is refused', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-wrong-id');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({
    run_id: 'some-other-run', digest: 'b'.repeat(64), bytes: 10, events: 1, contract: 'ok',
  }), 'utf8');
  writeEvents(root, 'run-wrong-id', [{ event_type: 'run_started', timestamp: iso(NOW - 30 * HOUR) }]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-wrong-id');
  assert.equal(row.finalized, false);
  assert.match(row.finalize_invalid_reason, /run_id/);
});

test('F-11: no run-finalized.json at all is the ordinary case — finalized:false with no alarming reason', () => {
  const root = freshRoot();
  writeEvents(root, 'run-never-finalized', [{ event_type: 'run_started', timestamp: iso(NOW - 30 * HOUR) }]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-never-finalized');
  assert.equal(row.finalized, false);
  assert.equal(row.finalize_invalid_reason, null, 'the ordinary "never finalized" case must not be reported as an invalid receipt');
});

test('/api/active-runs-equivalent filter (status==="live") now correctly excludes the old-open-dispatch case', () => {
  const root = freshRoot();
  writeEvents(root, 'run-old-open-2', [
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-old2', timestamp: iso(NOW - 48 * HOUR) },
  ]);
  const result = listRuns(root, NOW);
  const liveRows = result.runs.filter((r) => r.status === 'live');
  assert.equal(liveRows.length, 0, 'an open dispatch alone, with zero real activity in the last 10 minutes, must never be counted live');
});

// ── WP-CC1 (Lead review round 2) — reviewer pairing reaches open_dispatch_count too ───────────

test('a reviewer dispatch closed by review_completed no longer counts toward open_dispatch_count', () => {
  const root = freshRoot();
  writeRegistry(root, { 'review-boss': { name: 'Review Boss' } });
  writeEvents(root, 'run-reviewer-closed', [
    { event_type: 'run_started', timestamp: iso(NOW - 2 * HOUR) },
    { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'a944c14acc68d0110', role: 'reviewer', timestamp: iso(NOW - 2 * HOUR) },
    { event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-1', verdict: 'changes_required', timestamp: iso(NOW - 1 * HOUR) },
  ]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-reviewer-closed');
  assert.ok(row);
  assert.equal(row.open_dispatch_count, 0, 'the reviewer dispatch must be recognized as closed, the same way subagent_completed closes a worker one');
});

test('a review_completed never closes a worker dispatch\'s open_dispatch_count, even from the same agent', () => {
  const root = freshRoot();
  writeRegistry(root, { 'build-boss': { name: 'Build Boss' } });
  writeEvents(root, 'run-worker-not-closed', [
    { event_type: 'run_started', timestamp: iso(NOW - 2 * HOUR) },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-worker', role: 'worker', timestamp: iso(NOW - 2 * HOUR) },
    { event_type: 'review_completed', agent: 'Build Boss', review_id: 'rv-bogus', verdict: 'accepted', timestamp: iso(NOW - 1 * HOUR) },
  ]);
  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-worker-not-closed');
  assert.equal(row.open_dispatch_count, 1, 'a review must never close a worker dispatch');
});

// ── WP-CC1 (Lead review round 2) — heartbeat fallback priority reaches the stalled/ended_unknown boundary ──

test('with attribution confirmed working, an open dispatch\'s own silence is judged on ITS OWN tool-log evidence, not the run\'s unrelated last work event', () => {
  const root = freshRoot();
  // A SEPARATE, newer, more-qualifying run wins current_run — rule (c) ("current_run gets ANY
  // toollog row") must not muddy this test; the run under test here must be judged purely on
  // rule (b)'s own dispatch-scoped evidence.
  writeEvents(root, 'run-newer-current', [
    { event_type: 'run_started', timestamp: iso(NOW - 10 * MIN) },
    { event_type: 'subagent_completed', agent: 'Build Boss', dispatch_id: 'd-elsewhere', verdict: 'PASS', timestamp: iso(NOW - 10 * MIN) },
  ]);
  writeEvents(root, 'run-attributed-boundary', [
    { event_type: 'run_started', timestamp: iso(NOW - 30 * HOUR) },
    { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'd-quiet-reviewer', role: 'reviewer', timestamp: iso(NOW - 30 * HOUR) },
    // A real work event from a COMPLETELY different, unrelated dispatch/agent, 2h ago — well outside
    // the 10-min live window (so it must NOT make the run 'live' on its own) but well inside the 24h
    // stalled/ended_unknown boundary. Attribution works, so this must NOT blend into
    // d-quiet-reviewer's own staleness classification.
    { event_type: 'check_passed', agent: 'UI Boss', check: 'lint', timestamp: iso(NOW - 2 * HOUR) },
  ]);
  // Attribution IS confirmed working (a real attributed row exists, also outside the live window),
  // but never for d-quiet-reviewer specifically.
  writeToolLog(root, [{ ts: iso(NOW - 2 * HOUR), agent_id: 'some-other-dispatch', tool: 'Bash' }]);

  const result = listRuns(root, NOW);
  assert.equal(result.current_run, 'run-newer-current', 'sanity check: run-attributed-boundary must NOT be current_run for this test to prove rule (b) specifically');
  const row = result.runs.find((r) => r.run_id === 'run-attributed-boundary');
  assert.ok(row);
  // d-quiet-reviewer's own last known activity is its 30h-old start — well past the 24h boundary —
  // so this run must read ended_unknown, never rescued into 'stalled' by the unrelated 2h-old event.
  assert.equal(row.status, 'ended_unknown');
});

test('with no attribution at all, the run\'s last work event still sets the stalled/ended_unknown boundary (the honest fallback)', () => {
  const root = freshRoot();
  writeEvents(root, 'run-no-attribution-boundary', [
    { event_type: 'run_started', timestamp: iso(NOW - 30 * HOUR) },
    { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'd-quiet-reviewer-2', role: 'reviewer', timestamp: iso(NOW - 30 * HOUR) },
    // Outside the 10-min live window, inside the 24h stalled boundary.
    { event_type: 'check_passed', agent: 'UI Boss', check: 'lint', timestamp: iso(NOW - 2 * HOUR) },
  ]);
  // No attribution anywhere (every toollog row has agent_id:null) — the coarser run-level fallback
  // (2h ago, within the 24h boundary) is the only honest signal available.
  writeToolLog(root, [{ ts: iso(NOW - 2 * HOUR), agent_id: null, tool: 'Read' }]);

  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-no-attribution-boundary');
  assert.ok(row);
  assert.equal(row.status, 'stalled', 'without attribution, the run\'s own 2h-old last work event is the best honest signal, and 2h is within the 24h boundary');
});

// ── Codex run B F-09 — a fresh run with no work events yet can still read live from a Lead-level
// heartbeat, before its first qualifying event ────────────────────────────────────────────────

test('F-09: a genuinely-started run with ZERO work events reads live from a Lead-level toollog row (agent_id:null)', () => {
  const root = freshRoot();
  writeRunJson(root, 'run-fresh-start', { run_id: 'run-fresh-start', status: 'running', started_at: iso(NOW - 1 * MIN) });
  writeEvents(root, 'run-fresh-start', [
    { event_type: 'run_started', timestamp: iso(NOW - 1 * MIN) },
  ]);
  writeToolLog(root, [{ ts: iso(NOW - 20 * 1000), agent_id: null, tool: 'Read' }]);

  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-fresh-start');
  assert.ok(row);
  assert.equal(row.work_events, 0, 'sanity check: this run genuinely has no qualifying work event yet');
  assert.notEqual(result.current_run, 'run-fresh-start', 'sanity check: it cannot be current_run with zero work events (item 1\'s own rule)');
  assert.equal(row.status, 'live', 'the Lead\'s own real, recent activity on this brand-new run must count, even before its first work event');
});

test('F-09: the NEWEST genuinely-started zero-work run wins the heartbeat, not an older one', () => {
  const root = freshRoot();
  writeRunJson(root, 'run-older-fresh', { run_id: 'run-older-fresh', status: 'running', started_at: iso(NOW - 2 * HOUR) });
  writeEvents(root, 'run-older-fresh', [{ event_type: 'run_started', timestamp: iso(NOW - 2 * HOUR) }]);
  writeRunJson(root, 'run-newer-fresh', { run_id: 'run-newer-fresh', status: 'running', started_at: iso(NOW - 1 * MIN) });
  writeEvents(root, 'run-newer-fresh', [{ event_type: 'run_started', timestamp: iso(NOW - 1 * MIN) }]);
  writeToolLog(root, [{ ts: iso(NOW - 10 * 1000), agent_id: null, tool: 'Read' }]);

  const result = listRuns(root, NOW);
  const older = result.runs.find((r) => r.run_id === 'run-older-fresh');
  const newer = result.runs.find((r) => r.run_id === 'run-newer-fresh');
  assert.equal(newer.status, 'live', 'the newest genuinely-started run gets the heartbeat');
  assert.notEqual(older.status, 'live', 'an older genuinely-started run must not ALSO claim the same Lead-level activity');
});

test('F-09: never revives a FINALIZED zero-work run, even if it is the newest "started" one', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-finalized-zero-work');
  fs.mkdirSync(runDir, { recursive: true });
  writeRunJson(root, 'run-finalized-zero-work', { run_id: 'run-finalized-zero-work', status: 'running', started_at: iso(NOW - 1 * MIN) });
  writeEvents(root, 'run-finalized-zero-work', [{ event_type: 'run_started', timestamp: iso(NOW - 1 * MIN) }]);
  // WP-RB-CC (M-1): `bytes` must be the REAL current size of events.jsonl written above — see the
  // sibling "a log that grows after finalizing" test's own comment for why.
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({
    run_id: 'run-finalized-zero-work', digest: 'c'.repeat(64),
    bytes: fs.statSync(path.join(runDir, 'events.jsonl')).size, events: 1, contract: 'ok',
  }), 'utf8');
  writeToolLog(root, [{ ts: iso(NOW - 10 * 1000), agent_id: null, tool: 'Read' }]);

  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-finalized-zero-work');
  assert.equal(row.status, 'finalized', 'finalized still wins over everything, including a fresh Lead-level heartbeat');
});

test('F-09: never revives an ENDED (non-"running") zero-work run', () => {
  const root = freshRoot();
  writeRunJson(root, 'run-ended-zero-work', { run_id: 'run-ended-zero-work', status: 'ended_unproven', started_at: iso(NOW - 1 * MIN) });
  writeEvents(root, 'run-ended-zero-work', [{ event_type: 'run_started', timestamp: iso(NOW - 1 * MIN) }]);
  writeToolLog(root, [{ ts: iso(NOW - 10 * 1000), agent_id: null, tool: 'Read' }]);

  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-ended-zero-work');
  assert.equal(row.status, 'ended_unproven', 'an explicit non-running run.json status always wins verbatim — never rescued by a Lead heartbeat');
});

test('F-09: a zero-work run with NO run.json at all (rawStatus absent) never gets the fresh-start heartbeat', () => {
  const root = freshRoot();
  // No run.json — "genuinely started" explicitly REQUIRES run.json status:"running".
  writeEvents(root, 'run-no-run-json', [{ event_type: 'run_started', timestamp: iso(NOW - 1 * MIN) }]);
  writeToolLog(root, [{ ts: iso(NOW - 10 * 1000), agent_id: null, tool: 'Read' }]);

  const result = listRuns(root, NOW);
  const row = result.runs.find((r) => r.run_id === 'run-no-run-json');
  assert.ok(row);
  assert.notEqual(row.status, 'live', 'no run.json at all means "genuinely started" cannot be confirmed — no fresh-start heartbeat eligibility');
});

// ── Lead review of the F-09 fix: the Lead's heartbeat never goes to an abandoned or old "fresh" run ──

function currentRunWithWork(root, runId, workAtMs) {
  writeRunJson(root, runId, { run_id: runId, status: 'running', started_at: iso(workAtMs - 10 * MIN) });
  writeEvents(root, runId, [
    { event_type: 'run_started', timestamp: iso(workAtMs - 10 * MIN) },
    { event_type: 'check_passed', agent: 'orchestrator', check: 'x', timestamp: iso(workAtMs) },
  ]);
}

test('F-09 guard: a zero-work run that started BEFORE the current run\'s latest work is an abandoned start, not live', () => {
  const root = freshRoot();
  writeRunJson(root, 'run-abandoned', { run_id: 'run-abandoned', status: 'running', started_at: iso(NOW - 2 * HOUR) });
  writeEvents(root, 'run-abandoned', [{ event_type: 'run_started', timestamp: iso(NOW - 2 * HOUR) }]);
  currentRunWithWork(root, 'run-current', NOW - 5 * MIN);
  writeToolLog(root, [{ ts: iso(NOW - 10 * 1000), agent_id: null, tool: 'Read' }]);

  const result = listRuns(root, NOW);
  assert.equal(result.current_run, 'run-current');
  const abandoned = result.runs.find((r) => r.run_id === 'run-abandoned');
  assert.notEqual(abandoned.status, 'live', 'the Lead works in the current run; an older, never-worked start must not borrow that activity');
});

test('F-09 guard: a zero-work run started AFTER the current run\'s latest work still gets the heartbeat (the case F-09 is about)', () => {
  const root = freshRoot();
  currentRunWithWork(root, 'run-previous', NOW - 3 * HOUR);
  writeRunJson(root, 'run-new', { run_id: 'run-new', status: 'running', started_at: iso(NOW - 2 * MIN) });
  writeEvents(root, 'run-new', [{ event_type: 'run_started', timestamp: iso(NOW - 2 * MIN) }]);
  writeToolLog(root, [{ ts: iso(NOW - 10 * 1000), agent_id: null, tool: 'Read' }]);

  const result = listRuns(root, NOW);
  const fresh = result.runs.find((r) => r.run_id === 'run-new');
  assert.equal(fresh.status, 'live');
});

test('F-09 guard: a zero-work run started more than a day ago is not "fresh", even with no other run', () => {
  const root = freshRoot();
  writeRunJson(root, 'run-day-old', { run_id: 'run-day-old', status: 'running', started_at: iso(NOW - 26 * HOUR) });
  writeEvents(root, 'run-day-old', [{ event_type: 'run_started', timestamp: iso(NOW - 26 * HOUR) }]);
  writeToolLog(root, [{ ts: iso(NOW - 10 * 1000), agent_id: null, tool: 'Read' }]);

  const row = listRuns(root, NOW).runs.find((r) => r.run_id === 'run-day-old');
  assert.notEqual(row.status, 'live');
});

test('Codex verification NEW-1: a fresh run never counts Lead activity from before its own start', () => {
  const root = freshRoot();
  currentRunWithWork(root, 'run-a', NOW - 6 * MIN);
  writeRunJson(root, 'run-b', { run_id: 'run-b', status: 'running', started_at: iso(NOW - 1 * MIN) });
  writeEvents(root, 'run-b', [{ event_type: 'run_started', timestamp: iso(NOW - 1 * MIN) }]);
  // The only Lead activity is from BEFORE run-b started (it belonged to run-a's work).
  writeToolLog(root, [{ ts: iso(NOW - 3 * MIN), agent_id: null, tool: 'Read' }]);
  const before = listRuns(root, NOW).runs.find((r) => r.run_id === 'run-b');
  assert.notEqual(before.status, 'live', 'activity that predates the run is not its heartbeat');

  const root2 = freshRoot();
  currentRunWithWork(root2, 'run-a', NOW - 6 * MIN);
  writeRunJson(root2, 'run-b', { run_id: 'run-b', status: 'running', started_at: iso(NOW - 1 * MIN) });
  writeEvents(root2, 'run-b', [{ event_type: 'run_started', timestamp: iso(NOW - 1 * MIN) }]);
  writeToolLog(root2, [{ ts: iso(NOW - 30 * 1000), agent_id: null, tool: 'Read' }]);
  const after = listRuns(root2, NOW).runs.find((r) => r.run_id === 'run-b');
  assert.equal(after.status, 'live', 'activity after its start still counts');
});
