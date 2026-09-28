// WP-CC1 (item 7) — buildMission() must read the MODERN event vocabulary
// (.claude/forge-dashboard/log-event.cjs's KNOWN_EVENT_TYPES, in real use since late September
// 2026: `summary`, `wp_id`, `verdict`/`decision_summary`, `check`) rather than only the older
// `note`/guessed-from-role shape missions-liveness.test.mjs and missions.test.mjs already cover.
// Every assertion here uses a synthetic, isolated temp project root (never the real fleet) so it
// actually RUNS on a fresh clone/worktree instead of skipping for missing real-fleet data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildMission } from '../src/missions.mjs';
import { makeTempProjectRoot, writeEventsFile } from '../test-support/helpers.mjs';

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const MIN = 60 * 1000;

function withRun(events, fn, options = { nowMs: NOW }) {
  const root = makeTempProjectRoot();
  try {
    writeEventsFile(root, 'run-under-test', events);
    return fn(buildMission(root, 'run-under-test', options));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('agent_work_package_created: modern wp_id + summary are both captured alongside the display wp code', () => {
  withRun(
    [{ event_type: 'agent_work_package_created', agent: 'Build Boss', wp: 'RS-1', wp_id: 'rs-1', summary: 'Research spike on X', timestamp: iso(NOW) }],
    (m) => {
      assert.equal(m.wps.length, 1);
      assert.equal(m.wps[0].id, 'RS-1', 'the human display code (`wp`) stays the `id` field, unchanged');
      assert.equal(m.wps[0].wp_id, 'rs-1', 'the new canonical lowercase wp_id is captured separately');
      assert.equal(m.wps[0].note, 'Research spike on X', '`summary` is read even with no `note` field present');
    },
  );
});

test('subagent_started: an explicit wp_id is read verbatim, never overridden by the role-guess heuristic', () => {
  withRun(
    [{ event_type: 'subagent_started', agent: 'Build Boss', role: 'cc-wp9-thing', dispatch_id: 'd1', wp_id: 'wp9-real', timestamp: iso(NOW) }],
    (m) => {
      assert.equal(m.tasks.length, 1);
      assert.equal(m.tasks[0].wp_id, 'wp9-real', 'the real, explicit wp_id always wins over any guess');
      assert.equal(m.tasks[0].wp_guess, 'WP9', 'the legacy guess is still computed alongside it, never dropped');
    },
  );
});

test('subagent_completed (dispatch_id match): verdict + summary are captured, wp_id backfills when the start had none', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', dispatch_id: 'd1', timestamp: iso(NOW - 5 * MIN) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', dispatch_id: 'd1', verdict: 'PASS', summary: 'All green, 46/46', wp_id: 'wp9-real', timestamp: iso(NOW) },
    ],
    (m) => {
      const t = m.tasks[0];
      assert.equal(t.status, 'completed');
      assert.equal(t.verdict, 'PASS', 'the modern `verdict` field is captured on the task');
      assert.deepEqual(t.notes, ['All green, 46/46'], '`summary` lands in notes even with no `note` field present');
      assert.equal(t.wp_id, 'wp9-real', 'a completion-side wp_id backfills a start that had none');
    },
  );
});

test('subagent_completed (agent+role fallback match): verdict + wp_id also reach the task via the weaker path', () => {
  withRun(
    [
      { event_type: 'subagent_started', agent: 'Build Boss', role: 'builder', timestamp: iso(NOW - 5 * MIN) },
      { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', verdict: 'PASS', summary: 'fallback path', wp_id: 'wp9-real', timestamp: iso(NOW) },
    ],
    (m) => {
      const t = m.tasks[0];
      assert.equal(t.status, 'completed');
      assert.equal(t.match_method, 'agent-role-fallback');
      assert.equal(t.verdict, 'PASS', 'the fallback-matched completion still carries its real verdict onto the task');
      assert.equal(t.wp_id, 'wp9-real', 'and its real wp_id too — the fallback path must carry the same fields as the primary one');
    },
  );
});

test('orphan completion (no usable dispatch_id, no open start to fall back onto): verdict + wp_id still surface on the orphan shape', () => {
  withRun(
    [{ event_type: 'subagent_completed', agent: 'Build Boss', role: 'unmatched-role', verdict: 'FAIL', summary: 'no matching start exists', wp_id: 'wp9-real', timestamp: iso(NOW) }],
    (m) => {
      assert.equal(m.tasks.length, 0);
      assert.equal(m.orphan_completions.length, 1);
      const o = m.orphan_completions[0];
      assert.equal(o.verdict, 'FAIL');
      assert.equal(o.wp_id, 'wp9-real');
      assert.equal(o.note, 'no matching start exists', '`summary` is used for the orphan\'s own `note` too');
    },
  );
});

test('decision_logged: modern decision_summary is captured as both `note` and its own explicit field', () => {
  withRun(
    [{ event_type: 'decision_logged', agent: 'Lead Boss', role: 'orchestrator', decision_summary: 'Chose plan A over plan B', evidence: 'benchmark showed 2x', timestamp: iso(NOW) }],
    (m) => {
      assert.equal(m.decisions.length, 1);
      assert.equal(m.decisions[0].note, 'Chose plan A over plan B', 'decision_summary feeds the normalized `note` field');
      assert.equal(m.decisions[0].decision_summary, 'Chose plan A over plan B', 'and is also exposed verbatim for a consumer that wants the raw source');
      assert.equal(m.decisions[0].evidence, 'benchmark showed 2x');
    },
  );
});

test('decision_logged: the older `decision`/`note` fields still work when decision_summary is absent', () => {
  withRun(
    [{ event_type: 'decision_logged', agent: 'Lead Boss', role: 'orchestrator', decision: 'older-shape decision text', timestamp: iso(NOW) }],
    (m) => {
      assert.equal(m.decisions[0].note, 'older-shape decision text');
      assert.equal(m.decisions[0].decision_summary, 'older-shape decision text');
    },
  );
});

test('check_passed / check_failed: modern `check` name + `summary` are captured even with no `command` at all', () => {
  withRun(
    [
      { event_type: 'check_passed', agent: 'Test Boss', role: 'qa', check: 'gateway-tests', summary: '46 suites passed', timestamp: iso(NOW) },
      { event_type: 'check_failed', agent: 'Test Boss', role: 'qa', check: 'lint', summary: '2 warnings', timestamp: iso(NOW) },
    ],
    (m) => {
      assert.equal(m.verdicts.length, 2);
      assert.equal(m.verdicts[0].check, 'gateway-tests');
      assert.equal(m.verdicts[0].summary, '46 suites passed');
      assert.equal(m.verdicts[0].command, null, 'a real check with no `command` field reports an honest null, never a fabricated value');
      assert.equal(m.verdicts[1].check, 'lint');
      assert.equal(m.verdicts[1].event_type, 'check_failed');
    },
  );
});

test('check_passed: the older `command`/`exit_code`/`output` shape still works unchanged when `check`/`summary` are absent', () => {
  withRun(
    [{ event_type: 'check_passed', agent: 'Test Boss', role: 'qa', command: 'npm test', exit_code: 0, output: 'ok', timestamp: iso(NOW) }],
    (m) => {
      assert.equal(m.verdicts[0].check, null);
      assert.equal(m.verdicts[0].summary, null);
      assert.equal(m.verdicts[0].command, 'npm test');
      assert.equal(m.verdicts[0].exit_code, 0);
    },
  );
});
