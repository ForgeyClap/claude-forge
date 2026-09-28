// WP-CC1 (item 15) unit tests for readDoctorTallyForRun() — the real fix behind health.mjs's
// doctor_last: the modern doctor source lives inside gate-evidence.json's own doctor gate output
// file, not always a standalone doctor.json (this project's own fleet: the newest standalone
// doctor.json is from 2026-07-25, while the newest REAL doctor run is 2026-09-27, embedded in
// gate-evidence.json — the exact "July sync hash" staleness this WP fixes).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDoctorTallyForRun } from '../src/health.mjs';

const tempRoots = [];
function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-doctor-tally-test-'));
  tempRoots.push(root);
  return root;
}
after(() => { for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true }); });

test('a modern gate-evidence.json doctor gate output file is preferred and parsed correctly', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'forge-modern-run');
  fs.mkdirSync(path.join(runDir, 'gate-output'), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'gate-evidence.json'),
    JSON.stringify({
      gates: [{ name: 'doctor-source-full', exit_code: 0, output_file: '.claude/forge-runs/forge-modern-run/gate-output/doctor-source-full.txt' }],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, '.claude', 'forge-runs', 'forge-modern-run', 'gate-output', 'doctor-source-full.txt'),
    JSON.stringify({ ok: true, checks: { tests: { suites: 133, passed: 9714, failed: 0 } } }),
    'utf8',
  );

  const tally = readDoctorTallyForRun(runDir, root);
  assert.ok(tally);
  assert.equal(tally.source, 'gate-evidence-output-file');
  assert.equal(tally.suites, 133);
  assert.equal(tally.passed, 9714);
  assert.equal(tally.failed, 0);
  assert.equal(tally.ok, true);
});

test('falls back to a standalone doctor.json when no gate-evidence.json doctor gate exists', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'forge-old-run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'doctor.json'), JSON.stringify({ ok: true, checks: { tests: { suites: 5, passed: 100, failed: 0 } } }), 'utf8');

  const tally = readDoctorTallyForRun(runDir, root);
  assert.ok(tally);
  assert.equal(tally.source, 'doctor.json');
  assert.equal(tally.suites, 5);
});

test('neither source present -> honestly null, never a fabricated tally', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'forge-empty-run');
  fs.mkdirSync(runDir, { recursive: true });

  assert.equal(readDoctorTallyForRun(runDir, root), null);
});

test('a gate-evidence.json doctor gate whose output_file is missing on disk falls back to doctor.json', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'forge-partial-run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'gate-evidence.json'),
    JSON.stringify({ gates: [{ name: 'doctor-source-full', output_file: 'gate-output/does-not-exist.txt' }] }),
    'utf8',
  );
  fs.writeFileSync(path.join(runDir, 'doctor.json'), JSON.stringify({ ok: false, checks: { tests: { suites: 1, passed: 0, failed: 1 } } }), 'utf8');

  const tally = readDoctorTallyForRun(runDir, root);
  assert.equal(tally.source, 'doctor.json');
  assert.equal(tally.ok, false);
});
