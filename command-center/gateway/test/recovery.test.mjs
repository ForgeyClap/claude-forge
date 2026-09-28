// WP-CC1 (item 9) unit tests for buildCheckpoints()'s manifest reconciliation — the existing WP8
// HTTP coverage (routes-wp8.test.mjs) only exercises the real fleet's own manifests (which, at
// last check, are all still "armed" or absent), so it never exercised the done/failed projection at
// all. This file is hermetic: its own fixture, nested under COMMAND_CENTER_DATA_DIR (a real
// descendant of PROJECT_ROOT/SYNC_SCAN_ROOTS — see runs.test.mjs's own header for why an
// os.tmpdir() fixture would fail buildCheckpoints()'s anyContainmentOk() check).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildCheckpoints } from '../src/recovery.mjs';
import { writeEventsFile } from '../test-support/helpers.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-recovery');
const tempRoots = [];
function freshRoot() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  return root;
}
function writeManifest(root, runId, wps) {
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(wps), 'utf8');
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

test('a WP proven done by a real wp_completed event is reported done, never the raw armed status', () => {
  const root = freshRoot();
  writeManifest(root, 'forge-run-a', [
    { wp_id: 'wp-1', agent: 'Build Boss', status: 'armed', narrowed_prompt: 'do the thing', last_proof: null },
  ]);
  writeEventsFile(root, 'forge-run-a', [
    { event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' },
    { event_type: 'wp_completed', wp_id: 'wp-1', agent: 'Build Boss', timestamp: '2026-09-27T00:05:00.000Z' },
  ]);

  const result = buildCheckpoints(root);
  assert.equal(result.ok, true);
  const run = result.runs_with_manifest.find((r) => r.run_id === 'forge-run-a');
  assert.ok(run);
  assert.equal(run.manifest_reconciled, true);
  assert.equal(run.manifest[0].status, 'done');
  assert.equal(run.manifest[0].last_proof.event_type, 'wp_completed');
  assert.equal(run.manifest_raw_status_counts.armed, 1, 'the RAW status counts must still say armed');
});

test('a WP proven failed by a real check_failed event is reported failed', () => {
  const root = freshRoot();
  writeManifest(root, 'forge-run-b', [
    { wp_id: 'wp-2', agent: 'Test Boss', status: 'armed', narrowed_prompt: 'test it', last_proof: null },
  ]);
  writeEventsFile(root, 'forge-run-b', [
    { event_type: 'check_failed', wp_id: 'wp-2', agent: 'Test Boss', timestamp: '2026-09-27T00:05:00.000Z' },
  ]);

  const result = buildCheckpoints(root);
  const run = result.runs_with_manifest.find((r) => r.run_id === 'forge-run-b');
  assert.equal(run.manifest[0].status, 'failed');
});

test('a later retry event flips a failed WP back to done within the same run', () => {
  const root = freshRoot();
  writeManifest(root, 'forge-run-c', [
    { wp_id: 'wp-3', agent: 'Build Boss', status: 'armed', narrowed_prompt: 'retry me', last_proof: null },
  ]);
  writeEventsFile(root, 'forge-run-c', [
    { event_type: 'check_failed', wp_id: 'wp-3', agent: 'Build Boss', timestamp: '2026-09-27T00:05:00.000Z' },
    { event_type: 'wp_completed', wp_id: 'wp-3', agent: 'Build Boss', timestamp: '2026-09-27T00:10:00.000Z' },
  ]);

  const result = buildCheckpoints(root);
  const run = result.runs_with_manifest.find((r) => r.run_id === 'forge-run-c');
  assert.equal(run.manifest[0].status, 'done');
});

test('a disproven claim (_forge_verify.proof_verified:false) never flips status', () => {
  const root = freshRoot();
  writeManifest(root, 'forge-run-d', [
    { wp_id: 'wp-4', agent: 'Build Boss', status: 'armed', narrowed_prompt: 'x', last_proof: null },
  ]);
  writeEventsFile(root, 'forge-run-d', [
    {
      event_type: 'wp_completed', wp_id: 'wp-4', agent: 'Build Boss',
      timestamp: '2026-09-27T00:05:00.000Z', _forge_verify: { proof_verified: false },
    },
  ]);

  const result = buildCheckpoints(root);
  const run = result.runs_with_manifest.find((r) => r.run_id === 'forge-run-d');
  assert.equal(run.manifest[0].status, 'armed', 'a disproven claim must never be treated as evidence');
});

test('a WP with no qualifying event at all stays exactly at its own recorded status (never fabricated done)', () => {
  const root = freshRoot();
  writeManifest(root, 'forge-run-e', [
    { wp_id: 'wp-5', agent: 'Build Boss', status: 'armed', narrowed_prompt: 'x', last_proof: null },
  ]);
  writeEventsFile(root, 'forge-run-e', [
    { event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' },
  ]);

  const result = buildCheckpoints(root);
  const run = result.runs_with_manifest.find((r) => r.run_id === 'forge-run-e');
  assert.equal(run.manifest[0].status, 'armed');
});

test('a run with a manifest but no events.jsonl yet reconciles against an empty event list (no crash)', () => {
  const root = freshRoot();
  writeManifest(root, 'forge-run-f', [
    { wp_id: 'wp-6', agent: 'Build Boss', status: 'armed', narrowed_prompt: 'x', last_proof: null },
  ]);

  const result = buildCheckpoints(root);
  assert.equal(result.ok, true);
  const run = result.runs_with_manifest.find((r) => r.run_id === 'forge-run-f');
  assert.equal(run.manifest[0].status, 'armed');
});
