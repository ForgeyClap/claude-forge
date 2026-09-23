// Liveness/matching tests for buildMission() — the "a dead run renders as RUNNING forever" fix.
//
// WHY THIS FILE EXISTS. `subagent_started` carries a `dispatch_id` (the parent Lead knows the
// Agent-tool `tool_use` id); `subagent_completed` is self-logged by the subagent, which CANNOT
// know that id. log-event.cjs encodes exactly that asymmetry (DISPATCH_PROOF_EVENTS contains only
// start/creation events), so a completion legitimately arrives WITHOUT a dispatch_id. Measured
// over all 34 runs in this project's real .claude/forge-runs: 134 of 218 completions (61%) carry
// no dispatch_id at all. buildMission() matched on dispatch_id ONLY, so those completions became
// orphans and their starts stayed 'running' forever — nine real runs, dead for 6-21 days, still
// rendering as RUNNING on the Command Center.
//
// THE RISK THIS FILE GUARDS. Showing a genuinely running task as finished is a WORSE bug than the
// one being fixed. Every fallback below is therefore evidence-first and one-way conservative: it
// may leave a task open, it may label it unknown, it may never mark it 'completed' without a real
// completion event assigned to it. Tests (c), (k) and (d)'s assertion that the status is NOT
// 'completed' are the ones that encode that guarantee.
//
// Every test uses an isolated temp project root (helpers.mjs::makeTempProjectRoot) — never the
// real .claude/forge-runs — except the clearly-labelled real-fleet section at the bottom, which
// only READS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildMission, STALE_TASK_MS } from '../src/missions.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { makeTempProjectRoot, writeEventsFile } from '../test-support/helpers.mjs';
import { needsAnyRunEvents, needsAnyRunEventsOf, needsRunEvents } from './.real-data-guard.mjs';

const HOUR = 60 * 60 * 1000;

/** Runs `fn` against a throwaway project root holding exactly `events`, then deletes it. */
function withRun(events, fn, options = {}) {
  const root = makeTempProjectRoot();
  try {
    writeEventsFile(root, 'run-under-test', events);
    return fn(buildMission(root, 'run-under-test', options));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
/** A "this run is alive right now" clock: recent enough that no staleness rule may fire. */
const freshOpts = { nowMs: NOW };

/* ── (a) historical form: completions carry NO dispatch_id ─────────────────────────────────── */

test('(a) a completion with NO dispatch_id closes its start via the (agent, role) fallback', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'a80a6267e04cf0643', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', note: 'wizard shipped', timestamp: iso(NOW - 2 * HOUR) },
    ],
    (m) => {
      assert.equal(m.tasks.length, 1);
      assert.equal(m.tasks[0].status, 'completed', 'the real completion must close the real start');
      assert.equal(m.tasks[0].completed_at, iso(NOW - 2 * HOUR));
      assert.deepEqual(m.tasks[0].notes, ['wizard shipped']);
      assert.equal(m.orphan_completions.length, 0, 'a consumed completion is no longer an orphan');
      assert.equal(m.tasks[0].match_method, 'agent-role-fallback', 'the weaker link must be labelled as such');
    },
    freshOpts,
  );
});

test('(a2) 2 starts / 4 completions on ONE key closes NOTHING — the count is right, the identity is not', () => {
  // Real shape, measured in forge-2026-07-13-scout-adopt: Build Boss|builder has 2 starts but 4
  // completions. The earlier design closed exactly 2 of them, which made the COUNT right; Z1 proved
  // the IDENTITY was then a coin flip. Two open starts share this key, so no completion here has an
  // owner the data can name, and none of them may close anything. All four stay honest orphans.
  const ev = (t, extra) => ({ event_type: t, agent: 'Build Boss', role: 'builder', ...extra });
  withRun(
    [
      ev('subagent_started', { dispatch_id: 'd1', timestamp: iso(NOW - 5 * HOUR) }),
      ev('subagent_started', { dispatch_id: 'd2', timestamp: iso(NOW - 4 * HOUR) }),
      ev('subagent_completed', { timestamp: iso(NOW - 3 * HOUR), note: 'one' }),
      ev('subagent_completed', { timestamp: iso(NOW - 3 * HOUR + 60000), note: 'two' }),
      ev('subagent_completed', { timestamp: iso(NOW - 2 * HOUR), note: 'three' }),
      ev('subagent_completed', { timestamp: iso(NOW - 1 * HOUR), note: 'four' }),
    ],
    (m) => {
      assert.equal(m.tasks.length, 2);
      assert.equal(m.tasks.filter((t) => t.status === 'completed').length, 0, 'no completion here has a nameable owner');
      assert.equal(m.orphan_completions.length, 4, 'all four completions stay honest orphans');
      assert.deepEqual(m.tasks[0].notes, []);
      assert.deepEqual(m.tasks[1].notes, []);
      assert.equal(m.tasks.every((t) => t.pairing_ambiguous === true), true, 'both starts carry the ambiguity');
    },
    freshOpts,
  );
});

test('(a3) a completion timestamped BEFORE its own start still matches (real full-audit shape)', () => {
  // forge-2026-07-25-full-audit: Build Boss|wp5-evidence logged its completion at 00:10:14 and its
  // start at 00:11:49 — 95 seconds EARLIER than the start. A clock/ordering artifact is not
  // evidence that the task is still running, so it must not block the match; it is flagged instead.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'wp5-evidence', dispatch_id: 'a5357bfe4133ae970', timestamp: iso(NOW - 2 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'wp5-evidence', timestamp: iso(NOW - 2 * HOUR - 95000) },
    ],
    (m) => {
      assert.equal(m.tasks[0].status, 'completed');
      assert.equal(m.tasks[0].completion_before_start, true);
    },
    freshOpts,
  );
});

test('(a4) a start with NO dispatch_id is closable too (real forge-2026-07-30-discord shape)', () => {
  // The NEWEST real multi-agent run is the worst-formed one: 0/1 starts and 0/4 completions carry a
  // dispatch_id. A Symbol key can never be looked up, so only the fallback can ever close this.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Test Boss', role: 'WP-D3 mobile-flow', runtime: 'native', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Test Boss', role: 'WP-D3 mobile-flow', timestamp: iso(NOW - 2 * HOUR) },
    ],
    (m) => {
      assert.equal(m.tasks.length, 1);
      assert.equal(m.tasks[0].status, 'completed');
    },
    freshOpts,
  );
});

test('(a5) a subagent_failed with no dispatch_id closes its start as failed, not as completed', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Test Boss', role: 'qa', dispatch_id: 'd9', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'subagent_failed', agent: 'Test Boss', role: 'qa', note: 'suite red', timestamp: iso(NOW - 2 * HOUR) },
    ],
    (m) => assert.equal(m.tasks[0].status, 'failed'),
    freshOpts,
  );
});

/* ── (b) live form: dispatch_id on both sides — behaviour must be IDENTICAL to before ──────── */

test('(b) dispatch_id on BOTH sides stays the primary key and is labelled as the strong match', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'aaa111', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', dispatch_id: 'aaa111', note: 'done', timestamp: iso(NOW - 2 * HOUR) },
    ],
    (m) => {
      assert.equal(m.tasks[0].status, 'completed');
      assert.equal(m.tasks[0].match_method, 'dispatch_id');
      assert.equal(m.tasks[0].pairing_ambiguous, false);
      assert.equal(m.orphan_completions.length, 0);
    },
    freshOpts,
  );
});

test('(b2) dispatch_id routing is UNCHANGED when it disagrees with (agent, role)', () => {
  // Two dispatches whose completions arrive crossed relative to start order. The exact key must
  // decide — the fallback may never re-route a completion that already carries a usable id.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'first', timestamp: iso(NOW - 5 * HOUR) },
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'second', timestamp: iso(NOW - 4 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', dispatch_id: 'second', note: 'second finished first', timestamp: iso(NOW - 3 * HOUR) },
    ],
    (m) => {
      const first = m.tasks.find((t) => t.dispatch_id === 'first');
      const second = m.tasks.find((t) => t.dispatch_id === 'second');
      assert.equal(second.status, 'completed');
      assert.deepEqual(second.notes, ['second finished first']);
      assert.equal(first.status, 'running', 'the exact key must not spill over to the other task');
    },
    freshOpts,
  );
});

test('(b3) two completions sharing ONE dispatch_id still merge into one task with both notes', () => {
  // Pre-existing, separately asserted behaviour (missions.test.mjs, the real T1.7 slice). The
  // at-most-one-completion budget introduced for the fallback must not leak into this path.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'slice', dispatch_id: 'shared', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'slice', dispatch_id: 'shared', note: 'part one', timestamp: iso(NOW - 2 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'slice', dispatch_id: 'shared', note: 'part two', timestamp: iso(NOW - 1 * HOUR) },
    ],
    (m) => {
      assert.equal(m.tasks.length, 1);
      assert.deepEqual(m.tasks[0].notes, ['part one', 'part two']);
      assert.equal(m.orphan_completions.length, 0);
    },
    freshOpts,
  );
});

test('(b4) a completion whose dispatch_id is a free-text explanation stays an honest orphan', () => {
  // Real, in forge-2026-07-26-command-center: a dispatch_id of "none — no cc-t0.8-verify
  // subagent_started event exists ... (not fabricated)". It is PRESENT, so by rule the fallback
  // never sees it — the weaker link is only ever unlocked by a genuinely ABSENT dispatch_id.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Test Boss', role: 'cc-t0.8-verify', dispatch_id: 'real-id', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Test Boss', role: 'cc-t0.8-verify', dispatch_id: 'none — no cc-t0.8-verify subagent_started event exists (not fabricated)', timestamp: iso(NOW - 2 * HOUR) },
    ],
    (m) => {
      assert.equal(m.tasks[0].status, 'running', 'unchanged: an unusable id is not an absent id');
      assert.equal(m.orphan_completions.length, 1);
    },
    freshOpts,
  );
});

/* ── (c) a genuinely running task must stay running ────────────────────────────────────────── */

test('(c) LIVE SAFETY: a fresh start with no completion and no run end stays running', () => {
  withRun(
    [
      { event_type: 'run_started', agent: 'orchestrator', timestamp: iso(NOW - 90000) },
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'live-1', timestamp: iso(NOW - 60000) },
    ],
    (m) => {
      assert.equal(m.tasks.length, 1);
      assert.equal(m.tasks[0].status, 'running');
    },
    freshOpts,
  );
});

test('(c2) LIVE SAFETY: an agent still emitting events keeps its task running past the stale window', () => {
  // The dispatch itself is older than STALE_TASK_MS, but the SAME agent logged progress seconds
  // ago. Liveness is judged per-agent, so real long-running work is never closed by the clock.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'long-1', timestamp: iso(NOW - STALE_TASK_MS - 5 * HOUR) },
      { event_type: 'agent_progress', agent: 'Build Boss', note: 'still compiling', timestamp: iso(NOW - 30000) },
    ],
    (m) => assert.equal(m.tasks[0].status, 'running', 'a live agent must never be closed by age'),
    freshOpts,
  );
});

test('(c3) LIVE SAFETY: unparseable/missing timestamps never trigger a close', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'no-ts' },
      { event_type: 'subagent_started', agent: 'UI Boss', role: 'ui', dispatch_id: 'bad-ts', timestamp: 'not-a-date' },
    ],
    (m) => {
      assert.equal(m.tasks.every((t) => t.status === 'running'), true);
    },
    freshOpts,
  );
});

/* ── (d) a terminal run signal closes what cannot still be running ─────────────────────────── */

test('(d) run_completed closes a leftover task as ended_unknown — never as completed', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'left-1', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'run_completed', agent: 'orchestrator', timestamp: iso(NOW - 1 * HOUR) },
    ],
    (m) => {
      assert.equal(m.tasks[0].status, 'ended_unknown');
      assert.notEqual(m.tasks[0].status, 'completed');
      assert.equal(m.tasks[0].completed_at, null, 'no completion event exists, so no completion time may be invented');
      assert.equal(m.tasks[0].ended_reason, 'run-terminal-event');
    },
    freshOpts,
  );
});

test('(d2) a task that started AFTER the run end signal is left running, not retro-closed', () => {
  withRun(
    [
      { event_type: 'run_completed', agent: 'orchestrator', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'after-1', timestamp: iso(NOW - 60000) },
    ],
    (m) => assert.equal(m.tasks[0].status, 'running'),
    freshOpts,
  );
});

/* ── staleness: a label, never a completion ───────────────────────────────────────────────── */

test('(e) a task whose agent has been silent past the stale window is stalled, not running', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'review-boss', role: 'reviewer', dispatch_id: 'old-1', timestamp: iso(NOW - STALE_TASK_MS - HOUR) },
    ],
    (m) => {
      assert.equal(m.tasks[0].status, 'stalled');
      assert.notEqual(m.tasks[0].status, 'completed');
      assert.equal(m.tasks[0].completed_at, null);
      assert.equal(m.tasks[0].stale_since, iso(NOW - STALE_TASK_MS - HOUR));
    },
    freshOpts,
  );
});

test('(e2) just inside the stale window is still running (the boundary is not fudged)', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'review-boss', role: 'reviewer', dispatch_id: 'edge-1', timestamp: iso(NOW - STALE_TASK_MS + 60000) },
    ],
    (m) => assert.equal(m.tasks[0].status, 'running'),
    freshOpts,
  );
});

test('(e3) run-level recency cannot rescue a stale task, and cannot condemn a live one', () => {
  // Measured contamination: the 2026-08-01 reconciliation batch appended `decision_logged` events
  // (agent "orchestrator") to 13 long-dead runs, making the RUN look fresh. Liveness is judged per
  // AGENT precisely so that a bookkeeping write by an unrelated agent changes nothing.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'review-boss', role: 'reviewer', dispatch_id: 'old-2', timestamp: iso(NOW - STALE_TASK_MS - HOUR) },
      { event_type: 'decision_logged', agent: 'orchestrator', note: 'reconciled', timestamp: iso(NOW - 60000) },
    ],
    (m) => assert.equal(m.tasks[0].status, 'stalled'),
    freshOpts,
  );
});

test('(f) agent-only matching is REJECTED: same agent, different roles never cross-match', () => {
  // Measured: matching on agent alone scored 22/79 with 57 misattributions ("Build Boss" is
  // dispatched up to 15x per run under different roles). That is the candidate that WOULD falsely
  // finish a live task, so it must stay rejected.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'wp1-salvage', dispatch_id: 'r1', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'wp5-evidence', timestamp: iso(NOW - 2 * HOUR) },
    ],
    (m) => {
      assert.equal(m.tasks[0].status, 'running', 'a different role is a different task');
      assert.equal(m.orphan_completions.length, 1);
    },
    freshOpts,
  );
});

test('(f2) a missing role on either side blocks the fallback (real demo-preview shape)', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'review-boss', dispatch_id: 'demo-preview', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'subagent_completed', agent: 'review-boss', timestamp: iso(NOW - 2 * HOUR) },
    ],
    (m) => {
      assert.equal(m.tasks[0].status, 'running', 'no role means no key weak enough to be safe');
      assert.equal(m.orphan_completions.length, 1);
    },
    freshOpts,
  );
});

test('(g) starts sharing a NON-UNIQUE dispatch_id are all preserved, not silently overwritten', () => {
  // Second, independent data-loss bug, confirmed in forge-demo-10agents-layout-preview: ten
  // subagent_started events all carry the literal dispatch_id "demo-preview". Keying tasks only by
  // the lookup Map destroyed nine of them. Exact-key lookup is unchanged; the per-start list is
  // what is reported, so every logged dispatch survives.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'build-boss', role: 'builder', dispatch_id: 'demo-preview', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'subagent_started', agent: 'ui-boss', role: 'ui', dispatch_id: 'demo-preview', timestamp: iso(NOW - 3 * HOUR + 1000) },
      { event_type: 'subagent_started', agent: 'test-boss', role: 'qa', dispatch_id: 'demo-preview', timestamp: iso(NOW - 3 * HOUR + 2000) },
    ],
    (m) => {
      assert.equal(m.tasks.length, 3, 'three real dispatches must render as three tasks');
      assert.deepEqual(m.tasks.map((t) => t.agent), ['build-boss', 'ui-boss', 'test-boss']);
    },
    freshOpts,
  );
});

/* ── (Z1) PAIR INVERSION — the one-way-safety guarantee, the FAIL criterion itself ─────────── */
//
// Z1 (independent witness, HIGH): with two simultaneously-open starts sharing one (agent, role),
// the earlier design still consumed a completion and picked "the earliest still-open start". The
// COUNT of finished work stayed right, but WHICH task was finished became a coin flip — so the
// task that is genuinely still running could be stamped 'completed' while the one that genuinely
// finished stayed 'running'. That is precisely the failure this whole fix exists to prevent, and
// no honest-count argument buys it back: under-reporting finished work is acceptable, showing live
// work as finished is not.
//
// The rule these tests pin: at the moment a completion is considered, if MORE THAN ONE open start
// shares its (agent, role), NOTHING may be paired. Both starts stay open (later passes may still
// label them 'ended_unknown'/'stalled' — honest, non-completed statuses), the completion stays an
// honest orphan, and the ambiguity is recorded on every candidate.

test('(Z1) NO INVERSION: two open starts sharing one key — a completion closes NEITHER of them', () => {
  // The live shape. `d-live` was dispatched 10h ago and is genuinely still working; `d-short` was
  // dispatched 2h ago and genuinely finished 1h ago. The completion carries no dispatch_id, so
  // nothing in the file says which of the two it belongs to. Picking "earliest still-open" hands it
  // to `d-live` — the one that is still running — and leaves `d-short` running. Refusing to pair is
  // the only choice that cannot invert.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Test Boss', role: 'qa', dispatch_id: 'd-live', task: 'GENUINELY STILL RUNNING', timestamp: iso(NOW - 10 * HOUR) },
      { event_type: 'subagent_started', agent: 'Test Boss', role: 'qa', dispatch_id: 'd-short', task: 'GENUINELY FINISHED', timestamp: iso(NOW - 2 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Test Boss', role: 'qa', note: 'suite green', timestamp: iso(NOW - 1 * HOUR) },
      { event_type: 'agent_progress', agent: 'Test Boss', note: 'still running the suite', timestamp: iso(NOW - 30000) },
    ],
    (m) => {
      const live = m.tasks.find((t) => t.dispatch_id === 'd-live');
      const short = m.tasks.find((t) => t.dispatch_id === 'd-short');
      assert.equal(live.status, 'running', 'the genuinely-live dispatch must NEVER be stamped completed');
      assert.notEqual(live.status, 'completed');
      assert.equal(live.completed_at, null, 'no completion time may be invented for a live task');
      assert.deepEqual(live.notes, [], "another task's completion note may not be attached");
      assert.notEqual(short.status, 'completed', 'and the pairing may not simply be swapped either — it is unknowable');
      assert.equal(m.tasks.filter((t) => t.status === 'completed').length, 0);
    },
    freshOpts,
  );
});

test('(Z1b) NO INVERSION on the real evolver-research shape (Test Boss|qa, 3 starts / 2 completions)', () => {
  // Measured, forge-2026-07-12-evolver-research: Test Boss|qa starts at 13:59:58, 17:09:03 and
  // 22:32:16; completions at 17:10:24 and 22:34:48, neither carrying a dispatch_id. The earlier
  // design assigned the 17:10:24 completion to the 13:59:58 start — although a start 81 SECONDS
  // earlier was open — and the 22:34:48 completion to the 17:09:03 start, leaving the 22:32:16
  // start (2m32s before that completion) open. Both assignments contradict the only ordering
  // evidence in the file. Under the new rule three open starts share the key, so neither
  // completion is allowed to name an owner.
  const s = (dispatch_id, ts) => ({ event_type: 'subagent_started', agent: 'Test Boss', role: 'qa', dispatch_id, timestamp: ts });
  const c = (ts) => ({ event_type: 'subagent_completed', agent: 'Test Boss', role: 'qa', timestamp: ts });
  withRun(
    [
      s('a2b4dc00540b2f2ea', '2026-07-12T13:59:58.333Z'),
      s('aac611b475c6a442c', '2026-07-12T17:09:03.595Z'),
      c('2026-07-12T17:10:24.411Z'),
      s('a29cb824887fe182e', '2026-07-12T22:32:16.777Z'),
      c('2026-07-12T22:34:48.125Z'),
    ],
    (m) => {
      assert.equal(m.tasks.length, 3);
      assert.equal(m.tasks.filter((t) => t.status === 'completed').length, 0, 'no owner is nameable, so none is named');
      assert.equal(m.tasks.every((t) => t.pairing_ambiguous === true), true);
      assert.equal(m.orphan_completions.length, 2);
    },
    // Evaluated at a clock close to the run itself, so pass 3/4 cannot mask the pass-2 result.
    { nowMs: Date.parse('2026-07-12T23:00:00.000Z') },
  );
});

test('(Z1c) a refused pairing is RECORDED on every candidate, never silently dropped', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'x1', timestamp: iso(NOW - 5 * HOUR) },
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'x2', timestamp: iso(NOW - 4 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', timestamp: iso(NOW - 1 * HOUR) },
    ],
    (m) => {
      for (const t of m.tasks) {
        assert.equal(t.pairing_ambiguous, true, 'both candidates must carry the flag, not just one');
        assert.equal(typeof t.pairing_ambiguity_reason, 'string');
        assert.match(t.pairing_ambiguity_reason, /2 open starts/);
        assert.equal(t.declined_completions, 1, 'the count of refused completions is kept');
        assert.equal(t.match_method, null, 'a refusal is not a match method');
      }
      assert.equal(m.liveness.fallback_matches, 0);
      assert.equal(m.liveness.fallback_declined_ambiguous, 1, 'the payload reports the refusal');
      assert.equal(m.liveness.ambiguous_tasks, 2);
    },
    freshOpts,
  );
});

test('(Z1d) the refused completion stays an honest orphan, labelled with WHY it was not matched', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'y1', timestamp: iso(NOW - 5 * HOUR) },
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'y2', timestamp: iso(NOW - 4 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', note: 'built it', timestamp: iso(NOW - 1 * HOUR) },
    ],
    (m) => {
      assert.equal(m.orphan_completions.length, 1);
      assert.equal(m.orphan_completions[0].pairing_ambiguous, true);
      assert.match(m.orphan_completions[0].unmatched_reason, /ambiguous/i);
    },
    freshOpts,
  );
});

test('(Z1e) NO OVER-CORRECTION: exactly ONE open start still pairs normally', () => {
  // The refusal must be scoped to genuine ambiguity. A second start under a DIFFERENT role, and a
  // same-key start that is already closed by its exact dispatch_id, both leave exactly one open
  // candidate — which must still be matched, otherwise the fix would throw away sound evidence.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'z1', timestamp: iso(NOW - 5 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', dispatch_id: 'z1', note: 'exact', timestamp: iso(NOW - 4.5 * HOUR) },
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'z2', timestamp: iso(NOW - 4 * HOUR) },
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'reviewer', dispatch_id: 'z3', timestamp: iso(NOW - 4 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', note: 'fallback', timestamp: iso(NOW - 1 * HOUR) },
    ],
    (m) => {
      const z2 = m.tasks.find((t) => t.dispatch_id === 'z2');
      assert.equal(z2.status, 'completed', 'one open candidate is unambiguous — it must still match');
      assert.equal(z2.match_method, 'agent-role-fallback');
      assert.equal(z2.pairing_ambiguous, false);
      assert.deepEqual(z2.notes, ['fallback']);
      assert.equal(m.tasks.find((t) => t.dispatch_id === 'z3').status, 'running');
      assert.equal(m.liveness.fallback_declined_ambiguous, 0);
    },
    freshOpts,
  );
});

test('(Z1f) an ambiguity-blocked task is still closed HONESTLY by a terminal run event', () => {
  // Refusing to pair must not resurrect the original "dead run renders as RUNNING forever" bug.
  // Passes 3 and 4 still apply — but only ever with non-completed statuses and no completion time.
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'w1', timestamp: iso(NOW - 5 * HOUR) },
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'w2', timestamp: iso(NOW - 4 * HOUR) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', timestamp: iso(NOW - 3 * HOUR) },
      { event_type: 'run_completed', agent: 'orchestrator', timestamp: iso(NOW - 2 * HOUR) },
    ],
    (m) => {
      assert.equal(m.tasks.every((t) => t.status === 'ended_unknown'), true);
      assert.equal(m.tasks.every((t) => t.completed_at === null), true);
      assert.equal(m.tasks.every((t) => t.pairing_ambiguous === true), true, 'the ambiguity survives the relabel');
    },
    freshOpts,
  );
});

test('(Z1g) EXHAUSTIVE: over every start/completion shape up to 3+3 on one key, no task is ever completed while another open start shares it', () => {
  // Brute-force the whole small state space rather than trusting hand-picked cases: for every
  // combination of N starts (1..3) and M completions (0..3) on a single (agent, role), assert the
  // invariant directly — a task may only reach 'completed' if it was the ONLY open candidate.
  for (let n = 1; n <= 3; n++) {
    for (let mCount = 0; mCount <= 3; mCount++) {
      const events = [];
      for (let i = 0; i < n; i++) {
        events.push({ event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'd' + i, timestamp: iso(NOW - (10 - i) * HOUR) });
      }
      for (let j = 0; j < mCount; j++) {
        events.push({ event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', timestamp: iso(NOW - (5 - j) * HOUR) });
      }
      withRun(
        events,
        (m) => {
          const completed = m.tasks.filter((t) => t.status === 'completed');
          const label = 'n=' + n + ' m=' + mCount;
          if (n > 1) {
            assert.equal(completed.length, 0, label + ': more than one open start shares the key — nothing may be completed');
          } else {
            assert.equal(completed.length, mCount > 0 ? 1 : 0, label + ': a single unambiguous start still matches once');
          }
          assert.equal(m.tasks.length, n, label + ': every logged dispatch survives');
        },
        freshOpts,
      );
    }
  }
});

test('(Z1h) FUZZ: over 400 random event streams, a fallback close only ever happens on a SOLE open start', () => {
  // Randomized cross-check of the one-way guarantee, recomputed from the payload itself rather than
  // from the implementation's own bookkeeping. Pass 1 settles every exact dispatch_id match before
  // pass 2 runs, so the set of starts still open when pass 2 begins is exactly the tasks whose
  // `match_method` is not 'dispatch_id'. The invariant: for any (agent, role) whose open set has TWO
  // OR MORE members, not one of them may carry 'agent-role-fallback' — that conjunction IS the pair
  // inversion. Also asserted: 'completed' is never reached without a named match method.
  // mulberry32 — a real 32-bit PRNG. The first draft of this test used a textbook LCG written with
  // plain `*`, whose product exceeds 2^53 and silently loses precision in JS; it degenerated badly
  // enough that the ambiguous branch was never generated and the test passed against a deliberately
  // reintroduced "pick the earliest start" mutant. The `exercised` counter at the bottom is the
  // permanent guard against that class of vacuous pass.
  let rng = 0x9e3779b9;
  const rand = (n) => {
    rng = (rng + 0x6d2b79f5) | 0;
    let t = rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * n) | 0;
  };
  const AGENTS = ['Build Boss', 'Test Boss', 'Review Boss'];
  const ROLES = ['builder', 'qa', null];
  let exercised = 0; // iterations that actually produced a >=2-open-start key

  for (let iteration = 0; iteration < 400; iteration++) {
    const events = [];
    const issued = [];
    const nEvents = 2 + rand(10);
    for (let i = 0; i < nEvents; i++) {
      const agent = AGENTS[rand(AGENTS.length)];
      const role = ROLES[rand(ROLES.length)];
      const ts = iso(NOW - (12 - rand(12)) * HOUR - rand(3600) * 1000);
      if (issued.length === 0 || rand(2) === 0) {
        const withId = rand(4) !== 0; // sometimes a start carries no dispatch_id at all
        const id = withId ? 'd' + i : null;
        if (id) issued.push({ id, agent, role });
        events.push({ event_type: 'subagent_started', agent, role, ...(id ? { dispatch_id: id } : {}), timestamp: ts });
      } else {
        // A completion: sometimes exact (reusing a real issued id), usually with no id at all.
        const exact = rand(3) === 0 ? issued[rand(issued.length)] : null;
        const src = exact || { agent, role };
        events.push({
          event_type: rand(6) === 0 ? 'subagent_failed' : 'subagent_completed',
          agent: src.agent, role: src.role,
          ...(exact ? { dispatch_id: exact.id } : {}),
          timestamp: ts,
        });
      }
    }

    withRun(
      events,
      (m) => {
        const label = 'iteration ' + iteration;
        const openByKey = new Map();
        for (const t of m.tasks) {
          if (t.status === 'completed' || t.status === 'failed') {
            assert.notEqual(t.match_method, null, label + ': a closed task must name HOW it was closed');
          }
          if (t.match_method === 'dispatch_id') continue; // settled in pass 1, not a pass-2 candidate
          const k = fallbackKeyOf(t.agent, t.role);
          if (k === null) continue; // never eligible for the fallback at all
          if (!openByKey.has(k)) openByKey.set(k, []);
          openByKey.get(k).push(t);
        }
        for (const [k, open] of openByKey) {
          if (open.length < 2) continue;
          exercised += 1;
          for (const t of open) {
            assert.notEqual(
              t.match_method, 'agent-role-fallback',
              label + ': key "' + k + '" had ' + open.length + ' open starts and one was still fallback-closed',
            );
            assert.notEqual(t.status, 'completed', label + ': key "' + k + '" produced a completed task from an ambiguous set');
          }
        }
      },
      freshOpts,
    );
  }

  // ANTI-VACUITY: the invariant above is only meaningful if the generator actually produced the
  // ambiguous shape. Without this the test passes trivially on a broken implementation.
  assert.ok(exercised >= 100, 'the fuzz must actually reach the ambiguous branch (reached ' + exercised + ')');
});

/** Mirrors `missions.mjs::fallbackKey` — recomputed here so the test does not trust the module. */
function fallbackKeyOf(agent, role) {
  const a = typeof agent === 'string' ? agent.trim() : '';
  const r = typeof role === 'string' ? role.trim() : '';
  if (a === '' || r === '') return null;
  return a + ' ' + r;
}

/* ── real fleet (READ-ONLY) — the four runs named in the bug report ────────────────────────── */

const NAMED_STUCK_RUNS = [
  'forge-2026-07-13-promptmaster-intake',
  'forge-2026-07-13-evals-binomial-gate',
  'forge-2026-07-13-scout-adopt',
  'forge-demo-10agents-layout-preview',
];

test('REAL FLEET: none of the four reported dead runs still reports a running task', { skip: needsAnyRunEventsOf(NAMED_STUCK_RUNS) }, () => {
  for (const runId of NAMED_STUCK_RUNS) {
    if (!fs.existsSync(path.join(PROJECT_ROOT, '.claude', 'forge-runs', runId, 'events.jsonl'))) continue;
    const m = buildMission(PROJECT_ROOT, runId);
    assert.equal(m.ok, true, runId);
    const running = m.tasks.filter((t) => t.status === 'running');
    assert.equal(running.length, 0, runId + ' still reports running tasks: ' + JSON.stringify(running.map((t) => t.role)));
  }
});

test('REAL FLEET: promptmaster-intake closes only what it can name — the ambiguous pair is NOT completed', { skip: needsRunEvents('forge-2026-07-13-promptmaster-intake') }, () => {
  // The honest price of Z1, on real data. This run has 3 starts: Build Boss|builder twice (a
  // simultaneous pair, so no completion here can name its owner) and Test Boss|qa once (a single
  // candidate, still matched). Before Z1 all three read 'completed'; two of them were a coin flip.
  // (the former silent `if (!exists) return` here is gone — absence is now an explicit skip above,
  // so this test can no longer report green without having read anything)
  const runId = 'forge-2026-07-13-promptmaster-intake';
  const m = buildMission(PROJECT_ROOT, runId);
  assert.equal(m.tasks.length, 3);
  const matched = m.tasks.filter((t) => t.match_method === 'agent-role-fallback');
  assert.equal(matched.length, 1, 'exactly the one unambiguous start is still matched');
  assert.equal(matched[0].status, 'completed');
  assert.equal(typeof matched[0].completed_at === 'string' && matched[0].completed_at.length > 0, true);
  const blocked = m.tasks.filter((t) => t.pairing_ambiguous === true);
  assert.equal(blocked.length, 2, 'the simultaneous Build Boss|builder pair is refused, not guessed');
  assert.equal(blocked.every((t) => t.status !== 'completed'), true);
  assert.equal(blocked.every((t) => t.completed_at === null), true);
});

test('REAL FLEET INVARIANT: across EVERY run, no task closed by the fallback shared its key with another open start', { skip: needsAnyRunEvents() }, () => {
  // The differential invariant, swept over the whole real fleet rather than a named subset: a task
  // may carry `match_method: 'agent-role-fallback'` ONLY if it was the sole open candidate for that
  // key. Equivalently — nothing is ever both fallback-matched and pairing-ambiguous, which is the
  // exact conjunction that produced the inversion.
  // Absence of the fleet is an explicit skip (above), never a silent early return — the
  // `scanned > 0` assertion at the bottom stays a real gate on an environment that DOES have runs.
  const runsDir = path.join(PROJECT_ROOT, '.claude', 'forge-runs');
  let scanned = 0;
  for (const runId of fs.readdirSync(runsDir)) {
    if (!fs.existsSync(path.join(runsDir, runId, 'events.jsonl'))) continue;
    const m = buildMission(PROJECT_ROOT, runId);
    if (!m.ok) continue;
    scanned += 1;
    for (const t of m.tasks) {
      assert.equal(
        t.match_method === 'agent-role-fallback' && t.pairing_ambiguous === true,
        false,
        runId + ': ' + t.agent + '|' + t.role + ' was closed by an ambiguous fallback',
      );
      if (t.pairing_ambiguous === true) {
        assert.notEqual(t.status, 'completed', runId + ': an ambiguous task must never read completed');
        assert.equal(t.completed_at, null, runId + ': an ambiguous task must never carry a completion time');
      }
    }
  }
  assert.ok(scanned > 0, 'the real fleet must actually have been read');
});
