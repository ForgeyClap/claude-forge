// T3.4 tests — buildMission() against THIS project's own REAL run (the one this very work
// package was dispatched under), proving the A2 assumption test with real evidence rather than a
// synthetic fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMission } from '../src/missions.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { needsRunEvents } from './.real-data-guard.mjs';

const RUN_ID = 'forge-2026-07-26-command-center';
// Every assertion below reads this run's REAL events.jsonl (that is the whole point of this file —
// the fixture IS reality). Absent -> skip out loud instead of failing a clone that never had it.
const NEEDS_EVENTS = needsRunEvents(RUN_ID);

test('buildMission derives real wps/tasks/decisions/verdicts from this run\'s own events', { skip: NEEDS_EVENTS }, () => {
  const mission = buildMission(PROJECT_ROOT, RUN_ID);
  assert.equal(mission.ok, true);
  assert.equal(mission.run_id, RUN_ID);
  assert.ok(mission.wps.length >= 1);
  assert.ok(mission.wps.some((w) => w.id === 'WP0-WP13'));
  assert.ok(mission.decisions.length >= 3);
  assert.ok(mission.verdicts.length >= 2);
});

test('a real dispatch with TWO subagent_completed events (T1.7 slice) merges into one task with both notes', { skip: NEEDS_EVENTS }, () => {
  const mission = buildMission(PROJECT_ROOT, RUN_ID);
  const task = mission.tasks.find((t) => t.dispatch_id === 'a0f0dbae827429bc2');
  assert.ok(task, 'the T1.7 slice dispatch must be present');
  assert.equal(task.status, 'completed');
  assert.ok(task.notes.length >= 2, 'both real subagent_completed notes for this dispatch_id were merged, not overwritten');
  assert.equal(task.wp_guess, 'WP1');
});

test('A2 honesty: the literal orphan completion (a real dispatch_id explained in free text) surfaces as an orphan, not a fabricated task', { skip: NEEDS_EVENTS }, () => {
  const mission = buildMission(PROJECT_ROOT, RUN_ID);
  const orphan = mission.orphan_completions.find((o) => o.role === 'cc-t0.8-verify (verify-boss re-executor)' && /no cc-t0\.8-verify subagent_started/.test(String(o.dispatch_id)));
  assert.ok(orphan, 'the real WP0 exit-gate completion with a literal explanatory dispatch_id string must be reported as an honest gap');
});

test('the WP3 task (this very work package, now genuinely completed) reflects its real final state', { skip: NEEDS_EVENTS }, () => {
  // This assertion evolves with reality on purpose: earlier in this same work package the task
  // was legitimately still 'running' (no completed_at yet) — by the time this suite runs after
  // the real subagent_completed event was logged for this dispatch, 'completed' is the honest
  // state, not a stale fixture value. Testing against a live run means the fixture IS reality.
  const mission = buildMission(PROJECT_ROOT, RUN_ID);
  const task = mission.tasks.find((t) => t.role === 'cc-wp3-gateway');
  assert.ok(task);
  assert.equal(task.status, 'completed');
  assert.ok(typeof task.completed_at === 'string' && task.completed_at.length > 0);
  assert.ok(task.notes.length >= 1);
  assert.equal(task.wp_guess, 'WP3');
});

test('collapsed-id ambiguity is honestly flagged at lower confidence (role "cc-t17-slice" -> WP1, not WP17)', { skip: NEEDS_EVENTS }, () => {
  const mission = buildMission(PROJECT_ROOT, RUN_ID);
  const task = mission.tasks.find((t) => t.role === 'cc-t17-slice');
  assert.ok(task);
  assert.equal(task.wp_guess, 'WP1');
  assert.equal(task.wp_guess_confidence, 'inferred-collapsed-dotless-ambiguous');
});

test('an invalid run id is rejected honestly, not silently returning empty data', () => {
  const mission = buildMission(PROJECT_ROOT, '../../etc/passwd');
  assert.equal(mission.ok, false);
});
