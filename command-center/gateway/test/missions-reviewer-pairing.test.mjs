// WP-CC1 (Lead review round 2) — buildMission()'s own reviewer-pairing: a role:'reviewer' task
// closes at its own review_completed (no dispatch_id at all), never at subagent_completed. Real
// shape, verified live (forge-2026-09-26-dashboard-discord-usage, lines 129-130):
//   subagent_started {agent:"Review Boss", dispatch_id:"a944c14acc68d0110", role:"reviewer"}
//   review_completed {agent:"Review Boss", review_id:"rv-v290-final", verdict:"changes_required"}
// Every assertion here uses a synthetic, isolated temp project root (never the real fleet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildMission } from '../src/missions.mjs';
import { makeTempProjectRoot, writeEventsFile } from '../test-support/helpers.mjs';

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.parse('2026-09-27T09:00:00.000Z');
const MIN = 60 * 1000;

function withRun(events, fn) {
  const root = makeTempProjectRoot();
  try {
    writeEventsFile(root, 'run-under-test', events);
    return fn(buildMission(root, 'run-under-test', { nowMs: NOW }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the reviewer start + review_completed pair is closed, with its real verdict', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'a944c14acc68d0110', role: 'reviewer', task: 'independent read-only review of the run', timestamp: iso(NOW - 9 * MIN) },
      { event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-1', verdict: 'changes_required', summary: 'found real issues', timestamp: iso(NOW) },
    ],
    (m) => {
      assert.equal(m.tasks.length, 1);
      const t = m.tasks[0];
      assert.equal(t.dispatch_id, 'a944c14acc68d0110');
      assert.equal(t.status, 'completed');
      assert.equal(t.completed_at, iso(NOW));
      assert.equal(t.verdict, 'changes_required');
      assert.equal(t.match_method, 'review_completed');
      assert.deepEqual(t.notes, ['found real issues']);
    },
  );
});

test('a review_completed from a DIFFERENT agent does not close it', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'd-rb', role: 'reviewer', timestamp: iso(NOW - 9 * MIN) },
      { event_type: 'review_completed', agent: 'Security Boss', review_id: 'rv-other', verdict: 'accepted', timestamp: iso(NOW) },
    ],
    (m) => {
      assert.equal(m.tasks.length, 1);
      assert.equal(m.tasks[0].status, 'running', 'still open — the review belonged to a different agent entirely');
    },
  );
});

test('a worker dispatch is never closed by a review, even from the very same agent', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-worker', role: 'worker', wp_id: 'wp-1', timestamp: iso(NOW - 9 * MIN) },
      { event_type: 'review_completed', agent: 'Build Boss', review_id: 'rv-bogus', verdict: 'accepted', timestamp: iso(NOW) },
    ],
    (m) => {
      assert.equal(m.tasks.length, 1);
      assert.equal(m.tasks[0].role, 'worker');
      assert.equal(m.tasks[0].status, 'running', 'a review must never close a worker dispatch, even from the same agent');
    },
  );
});

test('FIFO: two reviewer dispatches from the same agent close oldest-first, each with its own verdict', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'd-first', role: 'reviewer', timestamp: iso(NOW - 20 * MIN) },
      { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'd-second', role: 'reviewer', timestamp: iso(NOW - 15 * MIN) },
      { event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-a', verdict: 'accepted', timestamp: iso(NOW - 10 * MIN) },
      { event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-b', verdict: 'changes_required', timestamp: iso(NOW) },
    ],
    (m) => {
      const first = m.tasks.find((t) => t.dispatch_id === 'd-first');
      const second = m.tasks.find((t) => t.dispatch_id === 'd-second');
      assert.equal(first.verdict, 'accepted', 'the FIRST review_completed closes the OLDEST open reviewer dispatch');
      assert.equal(second.verdict, 'changes_required');
    },
  );
});

test('an orphan review_completed (no open reviewer dispatch at all) never fabricates or crashes', () => {
  withRun(
    [{ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-orphan', verdict: 'accepted', timestamp: iso(NOW) }],
    (m) => {
      assert.equal(m.ok, true);
      assert.equal(m.tasks.length, 0);
    },
  );
});

test('a reviewer dispatch closed by review is never ALSO relabelled by PASS 3/4 (terminal/stale)', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Review Boss', dispatch_id: 'd-rb2', role: 'reviewer', timestamp: iso(NOW - 9 * MIN) },
      { event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-2', verdict: 'accepted', timestamp: iso(NOW - 8 * MIN) },
      { event_type: 'run_completed', timestamp: iso(NOW) },
    ],
    (m) => {
      const t = m.tasks.find((x) => x.dispatch_id === 'd-rb2');
      assert.equal(t.status, 'completed', 'already resolved by the review — PASS 3\'s terminal-event demotion must never touch it');
      assert.equal(t.ended_reason, null);
    },
  );
});
