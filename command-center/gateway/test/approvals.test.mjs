// WP-CC1 (item 8) unit tests for buildApprovals() against an isolated temp project — the existing
// coverage in routes-wp8.test.mjs is HTTP-level and depends on this real project's own fleet data
// (a specific run id, real hard-gates.json), so it cannot exercise the NEW integration_gate_passed
// counting logic deterministically. This file is hermetic: its own fixture, never the real fleet.
//
// buildApprovals() defense-in-depth checks anyContainmentOk(SYNC_SCAN_ROOTS, projectPath) directly
// against paths.mjs's real, live SYNC_SCAN_ROOTS — an os.tmpdir() fixture would genuinely fail that
// check (same reasoning as runs.test.mjs's own header comment), so this fixture is nested under
// COMMAND_CENTER_DATA_DIR instead, a real descendant of PROJECT_ROOT (itself one of the roots).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildApprovals } from '../src/approvals.mjs';
import { writeEventsFile } from '../test-support/helpers.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-approvals');
const tempRoots = [];
function freshRoot() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

test('integration_gate_passed events are counted and listed with their real fields, separate from `evaluations`', () => {
  const root = freshRoot();
  const eventsPath = writeEventsFile(root, 'forge-run-a', [
    { event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z', agent: 'orchestrator' },
    {
      event_type: 'integration_gate_passed', agent: 'orchestrator',
      summary: 'v2.9.0 gate evidence ALL GREEN on the clean source commit abc123',
      evidence: '.claude/forge-runs/forge-run-a/gate-evidence.json',
      timestamp: '2026-09-27T07:55:14.196Z',
    },
    {
      event_type: 'integration_gate_passed', agent: 'orchestrator',
      summary: 'second gate pass, same run',
      evidence: '.claude/forge-runs/forge-run-a/gate-evidence.json',
      timestamp: '2026-09-27T08:10:00.000Z',
    },
  ]);
  void eventsPath;

  const result = buildApprovals(root, 'forge-run-a');
  assert.equal(result.ok, true);
  assert.equal(result.integration_gate_passed_provenance, 'LIVE');
  assert.equal(result.integration_gate_passed_count, 2);
  assert.equal(result.integration_gate_passed_events.length, 2);
  assert.equal(result.integration_gate_passed_events[0].agent, 'orchestrator');
  assert.match(result.integration_gate_passed_events[0].summary, /ALL GREEN/);
  assert.equal(result.integration_gate_passed_events[0].evidence, '.claude/forge-runs/forge-run-a/gate-evidence.json');
  // Existing `evaluations` (gate_evaluated/quality_gate_*) must stay untouched — this is a
  // separate signal, never folded into a row full of nulls.
  assert.deepEqual(result.evaluations, []);
});

test('no ?run= given -> integration_gate_passed is honestly NOT REQUESTED, never a fabricated 0', () => {
  const root = freshRoot();
  const result = buildApprovals(root, null);
  assert.equal(result.ok, true);
  assert.equal(result.integration_gate_passed_provenance, 'NOT REQUESTED');
  assert.deepEqual(result.integration_gate_passed_events, []);
  assert.equal(result.integration_gate_passed_count, 0);
});

test('a run with zero integration_gate_passed events reports a real, honest zero (LIVE, not NOT CONFIGURED)', () => {
  const root = freshRoot();
  writeEventsFile(root, 'forge-run-b', [
    { event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z', agent: 'orchestrator' },
  ]);
  const result = buildApprovals(root, 'forge-run-b');
  assert.equal(result.integration_gate_passed_provenance, 'LIVE');
  assert.equal(result.integration_gate_passed_count, 0);
});
