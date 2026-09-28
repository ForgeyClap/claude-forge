// WP-CC1 (item 5) unit tests for listRunLogDispatches() — the run-log (headless /forge/CLI) source
// merged into GET /api/agent-dispatches, separate from the conversation-based rows already covered
// by agent-dispatches.test.mjs. Isolated fixture nested under COMMAND_CENTER_DATA_DIR (a real
// descendant of PROJECT_ROOT/SYNC_SCAN_ROOTS — runs.mjs's own anyContainmentOk() check would
// reject a plain os.tmpdir() fixture; see runs.test.mjs's own header for the same reasoning).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listRunLogDispatches } from '../src/agent-dispatches.mjs';
import { _resetToolLogCacheForTests } from '../src/toollog.mjs';
import { writeEventsFile } from '../test-support/helpers.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-runlog-dispatches');
const tempRoots = [];
function freshRoot() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  return root;
}
function writeRegistry(root, agents) {
  const dir = path.join(root, '.claude', 'config', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-registry.json'), JSON.stringify({ agents }), 'utf8');
}
function writeToolLog(root, rows) {
  const dir = path.join(root, '.claude', 'forge-runs', '_toollog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session-a.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

beforeEach(() => {
  _resetToolLogCacheForTests();
});

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

test('an open dispatch in a genuinely live run reports running:true with the real slug/display name', () => {
  const root = freshRoot();
  writeRegistry(root, { 'build-boss': { name: 'Build Boss' } });
  const nowIso = new Date().toISOString();
  writeEventsFile(root, 'forge-live-run', [
    { event_type: 'run_started', timestamp: nowIso },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd1', wp_id: 'wp-1', role: 'builder', task: 'do the thing', timestamp: nowIso },
  ]);

  const rows = listRunLogDispatches(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'run-log');
  assert.equal(rows[0].agent, 'Build Boss');
  assert.equal(rows[0].agent_slug, 'build-boss');
  assert.equal(rows[0].wp_id, 'wp-1');
  assert.equal(rows[0].task, 'do the thing');
  assert.equal(rows[0].completed_at, null);
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].stalled, false);
});

test('WP-CC1 (Lead review): a dispatch with its OWN recent tool-log activity reads running:true even though the run\'s last mission event is stale — "an agent that is really working is never shown as stalled"', () => {
  const root = freshRoot();
  const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago — the run's own last mission event is stale
  writeEventsFile(root, 'forge-quiet-mission-busy-agent', [
    { event_type: 'run_started', timestamp: oldIso },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-busy', timestamp: oldIso },
  ]);
  writeToolLog(root, [{ ts: new Date(Date.now() - 30 * 1000).toISOString(), agent_id: 'd-busy', tool: 'Bash' }]);

  const rows = listRunLogDispatches(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].running, true, 'the dispatch\'s own real, recent tool activity must count even with no recent mission event');
  assert.equal(rows[0].stalled, false);
});

test('WP-CC1 (Lead review): tool-log activity for a DIFFERENT dispatch never makes this one read running:true', () => {
  const root = freshRoot();
  const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeEventsFile(root, 'forge-two-dispatches', [
    { event_type: 'run_started', timestamp: oldIso },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-quiet', timestamp: oldIso },
  ]);
  writeToolLog(root, [{ ts: new Date(Date.now() - 30 * 1000).toISOString(), agent_id: 'd-somebody-else', tool: 'Bash' }]);

  const rows = listRunLogDispatches(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].running, false);
  assert.equal(rows[0].stalled, true);
});

test('an open dispatch whose run has gone silent past the heartbeat window is honestly stalled, never running', () => {
  const root = freshRoot();
  const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago — well past any real heartbeat window
  writeEventsFile(root, 'forge-stale-run', [
    { event_type: 'run_started', timestamp: oldIso },
    { event_type: 'subagent_started', agent: 'Search Boss', dispatch_id: 'd2', timestamp: oldIso },
  ]);

  const rows = listRunLogDispatches(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].running, false);
  assert.equal(rows[0].stalled, true);
});

test('a completed dispatch reports its real verdict and completed_at, never running', () => {
  const root = freshRoot();
  const nowIso = new Date().toISOString();
  writeEventsFile(root, 'forge-live-run-2', [
    { event_type: 'run_started', timestamp: nowIso },
    { event_type: 'subagent_started', agent: 'Test Boss', dispatch_id: 'd3', timestamp: nowIso },
    { event_type: 'subagent_completed', agent: 'Test Boss', dispatch_id: 'd3', verdict: 'PASS', timestamp: nowIso },
  ]);

  const rows = listRunLogDispatches(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, 'PASS');
  assert.equal(rows[0].completed_at, nowIso);
  assert.equal(rows[0].running, false);
  assert.equal(rows[0].stalled, false);
});

test('F-05 dedup: a resumed dispatch logging a second start under the SAME dispatch_id never overwrites the completion', () => {
  const root = freshRoot();
  const nowIso = new Date().toISOString();
  writeEventsFile(root, 'forge-live-run-3', [
    { event_type: 'run_started', timestamp: nowIso },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd4', task: 'first task', timestamp: nowIso },
    { event_type: 'subagent_completed', agent: 'Build Boss', dispatch_id: 'd4', verdict: 'PASS', timestamp: nowIso },
    // A resume/replay logs a SECOND start under the exact same dispatch_id.
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd4', task: 'first task', timestamp: nowIso },
  ]);

  const rows = listRunLogDispatches(root);
  assert.equal(rows.length, 1, 'one entry, never a phantom duplicate row');
  assert.equal(rows[0].completed_at, nowIso, 'the completion must survive the resumed start');
  assert.equal(rows[0].verdict, 'PASS');
  assert.equal(rows[0].running, false);
  assert.equal(rows[0].resumed_start_count, 1);
});

test('a run that is not current and not status:live is never scanned for run-log dispatches', () => {
  const root = freshRoot();
  const oldIso = '2020-01-01T00:00:00.000Z';
  writeEventsFile(root, 'forge-ancient-run', [
    { event_type: 'run_started', timestamp: oldIso },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd5', timestamp: oldIso },
    { event_type: 'subagent_completed', agent: 'Build Boss', dispatch_id: 'd5', timestamp: oldIso },
    { event_type: 'run_completed', timestamp: oldIso },
  ]);
  const nowIso = new Date().toISOString();
  writeEventsFile(root, 'forge-current-run', [
    { event_type: 'run_started', timestamp: nowIso },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd6', timestamp: nowIso },
  ]);

  const rows = listRunLogDispatches(root);
  // Only the genuinely current run's dispatch is scanned — the finalized/old ancient run is not.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dispatch_id, 'd6');
});

test('an unknown project path or a project with no runs returns an honest empty array', () => {
  assert.deepEqual(listRunLogDispatches(''), []);
  assert.deepEqual(listRunLogDispatches(null), []);
  const root = freshRoot();
  assert.deepEqual(listRunLogDispatches(root), []);
});

// ── WP-CC1 (Lead review round 2) — reviewer pairing ───────────────────────────────────────────
// Real shape, verified live (forge-2026-09-26-dashboard-discord-usage lines 129-130): a
// subagent_started with role:'reviewer' closes at its own LATER review_completed (no dispatch_id
// at all), never at subagent_completed.

test('the reviewer start + review_completed pair is closed, with its real verdict', () => {
  const root = freshRoot();
  writeRegistry(root, { 'review-boss': { name: 'Review Boss' } });
  const startIso = '2026-09-27T09:14:48.529Z';
  const doneIso = '2026-09-27T09:23:45.136Z';
  writeEventsFile(root, 'forge-review-pair', [
    { event_type: 'run_started', timestamp: startIso },
    { event_type: 'review_started', agent: 'Review Boss', review_id: 'rv-1', timestamp: startIso },
    { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'a944c14acc68d0110', role: 'reviewer', task: 'independent read-only review of the run', timestamp: startIso },
    { event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-1', verdict: 'changes_required', timestamp: doneIso },
  ]);

  const rows = listRunLogDispatches(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dispatch_id, 'a944c14acc68d0110');
  assert.equal(rows[0].completed_at, doneIso, 'the reviewer dispatch must close, with the review_completed\'s own real timestamp');
  assert.equal(rows[0].verdict, 'changes_required', 'the real verdict from review_completed must be captured');
  assert.equal(rows[0].running, false);
  assert.equal(rows[0].stalled, false, 'a genuinely closed dispatch is neither running nor stalled');
});

test('a review_completed from a DIFFERENT agent does not close a reviewer dispatch that isn\'t theirs', () => {
  const root = freshRoot();
  writeRegistry(root, { 'review-boss': { name: 'Review Boss' }, 'security-boss': { name: 'Security Boss' } });
  const startIso = '2026-09-27T09:14:48.529Z';
  writeEventsFile(root, 'forge-review-mismatch', [
    { event_type: 'run_started', timestamp: startIso },
    { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'd-rb', role: 'reviewer', timestamp: startIso },
    // A different agent's own, unrelated review completion — must never close Review Boss's dispatch.
    { event_type: 'review_completed', agent: 'Security Boss', review_id: 'rv-other', verdict: 'accepted', timestamp: '2026-09-27T09:20:00.000Z' },
  ]);

  const rows = listRunLogDispatches(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dispatch_id, 'd-rb');
  assert.equal(rows[0].completed_at, null, 'still open — the review belonged to a different agent entirely');
});

test('a worker dispatch is NEVER closed by a review_completed, even from the very same agent', () => {
  const root = freshRoot();
  writeRegistry(root, { 'build-boss': { name: 'Build Boss' } });
  const startIso = '2026-09-27T09:00:00.000Z';
  writeEventsFile(root, 'forge-worker-not-closed-by-review', [
    { event_type: 'run_started', timestamp: startIso },
    // Build Boss doing an ordinary WORKER dispatch (not a reviewer one).
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-worker', role: 'worker', wp_id: 'wp-1', timestamp: startIso },
    // A review_completed from the SAME agent string — must still never close the worker dispatch.
    { event_type: 'review_completed', agent: 'Build Boss', review_id: 'rv-bogus', verdict: 'accepted', timestamp: '2026-09-27T09:05:00.000Z' },
  ]);

  const rows = listRunLogDispatches(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dispatch_id, 'd-worker');
  assert.equal(rows[0].role, 'worker');
  assert.equal(rows[0].completed_at, null, 'a review must never close a worker dispatch, even from the same agent');
});

test('FIFO: two reviewer dispatches from the same agent close oldest-first, each with its own verdict', () => {
  const root = freshRoot();
  writeRegistry(root, { 'review-boss': { name: 'Review Boss' } });
  writeEventsFile(root, 'forge-review-fifo', [
    { event_type: 'run_started', timestamp: '2026-09-27T09:00:00.000Z' },
    { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'd-first', role: 'reviewer', timestamp: '2026-09-27T09:00:00.000Z' },
    { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'd-second', role: 'reviewer', timestamp: '2026-09-27T09:05:00.000Z' },
    { event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-a', verdict: 'accepted', timestamp: '2026-09-27T09:10:00.000Z' },
    { event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-b', verdict: 'changes_required', timestamp: '2026-09-27T09:20:00.000Z' },
  ]);

  const rows = listRunLogDispatches(root);
  assert.equal(rows.length, 2);
  const first = rows.find((r) => r.dispatch_id === 'd-first');
  const second = rows.find((r) => r.dispatch_id === 'd-second');
  assert.equal(first.verdict, 'accepted', 'the FIRST review_completed closes the OLDEST open reviewer dispatch');
  assert.equal(second.verdict, 'changes_required');
});

// ── WP-CC1 (Lead review round 2) — heartbeat fallback priority ───────────────────────────────

test('with attributed tool-log rows present, an open dispatch without its OWN activity is stalled even when the run had a work event 1 min ago', () => {
  const root = freshRoot();
  const nowIso = new Date().toISOString();
  const oneMinAgoIso = new Date(Date.now() - 60 * 1000).toISOString();
  writeEventsFile(root, 'forge-attribution-works', [
    { event_type: 'run_started', timestamp: oneMinAgoIso },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-quiet-agent', timestamp: oneMinAgoIso },
    // A real recent WORK EVENT on the run — 1 minute ago — from a DIFFERENT, unrelated dispatch.
    { event_type: 'check_passed', agent: 'UI Boss', check: 'lint', timestamp: oneMinAgoIso },
  ]);
  // Attribution IS confirmed working on this project (a real attributed row exists) — but NOT for
  // d-quiet-agent specifically.
  writeToolLog(root, [{ ts: nowIso, agent_id: 'some-other-dispatch-entirely', tool: 'Bash' }]);

  const rows = listRunLogDispatches(root);
  const row = rows.find((r) => r.dispatch_id === 'd-quiet-agent');
  assert.ok(row, 'the dispatch must still be listed');
  assert.equal(row.running, false, 'attribution works, so the run-wide work event must NOT rescue a dispatch with none of its own');
  assert.equal(row.stalled, true);
});

test('with no attributed rows at all, the run-event fallback still applies', () => {
  const root = freshRoot();
  const nowIso = new Date().toISOString();
  writeEventsFile(root, 'forge-no-attribution', [
    { event_type: 'run_started', timestamp: nowIso },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-fallback', timestamp: nowIso },
  ]);
  // Attribution is NOT confirmed working (every row has agent_id:null — an older Claude Code, or
  // tool logging off) — the coarser run-level fallback must still be honoured.
  writeToolLog(root, [{ ts: nowIso, agent_id: null, tool: 'Read' }]);

  const rows = listRunLogDispatches(root);
  const row = rows.find((r) => r.dispatch_id === 'd-fallback');
  assert.ok(row);
  assert.equal(row.running, true, 'with attribution unavailable, the run\'s own recent work event is still an honest best-effort signal');
});
