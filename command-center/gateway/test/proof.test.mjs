// T3.8 tests — buildProof() against the real forge-2026-07-25-full-audit run, which the work
// package identifies as having exactly 2 registered artifacts in .claude/forge-artifacts/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProof } from '../src/proof.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { needsRunEvents, needsRunArtifacts, needsDoctorReceipt, needsArtifactsIndex, needsAll } from './.real-data-guard.mjs';

const RUN_ID = 'forge-2026-07-25-full-audit';

// buildProof() stitches together three independent real sources; each assertion below is guarded on
// exactly the source it reads, so a partially-populated environment skips only what it truly lacks.
const NEEDS_ARTIFACT_FILES = needsRunArtifacts(RUN_ID);
const NEEDS_EVENTS = needsRunEvents(RUN_ID);
const NEEDS_DOCTOR = needsDoctorReceipt(RUN_ID);
const NEEDS_INDEX = needsArtifactsIndex();

test('buildProof finds the real run-artifacts-dir files, the doctor receipt, and the final report', { skip: needsAll(NEEDS_ARTIFACT_FILES, NEEDS_DOCTOR) }, () => {
  const result = buildProof(PROJECT_ROOT, RUN_ID);
  assert.equal(result.ok, true);
  assert.equal(result.report_present, true);
  assert.equal(result.doctor_present, true);
  const runDirArtifacts = result.artifacts.filter((a) => a.source === 'run-artifacts-dir');
  assert.ok(runDirArtifacts.length >= 4, 'the 4 real wp0/wp6 markdown artifacts under this run\'s artifacts/ dir');
});

test('exactly the 2 real forge-artifacts index entries that actually reference this run are matched (not the unrelated 2026-07-10 one)', { skip: NEEDS_INDEX }, () => {
  const result = buildProof(PROJECT_ROOT, RUN_ID);
  const storeArtifacts = result.artifacts.filter((a) => a.source === 'forge-artifacts-index');
  assert.equal(storeArtifacts.length, 2);
  const ids = storeArtifacts.map((a) => a.id).sort();
  assert.deepEqual(ids, ['final-report-full-audit', 'wp0-audit-reports']);
  assert.ok(!ids.includes('art-mc-report'), 'the unrelated 2026-07-10 artifact must NOT match — it never references this run');
});

test('verdicts combine the real doctor summary and this run\'s real check_passed events', { skip: needsAll(NEEDS_DOCTOR, NEEDS_EVENTS) }, () => {
  const result = buildProof(PROJECT_ROOT, RUN_ID);
  const doctorVerdict = result.verdicts.find((v) => v.source === 'doctor');
  assert.ok(doctorVerdict);
  assert.equal(doctorVerdict.ok, true);
  assert.ok(doctorVerdict.suites > 0 && doctorVerdict.passed > 0);
  const eventVerdicts = result.verdicts.filter((v) => v.source === 'event' && v.event_type === 'check_passed');
  assert.equal(eventVerdicts.length, 3);
});

test('an invalid run id is rejected honestly', () => {
  const result = buildProof(PROJECT_ROOT, '..\\..\\evil');
  assert.equal(result.ok, false);
});

// cc-fix-adapter T6b — real byte sizes for run-artifacts-dir files (stat-able real files).
test('run-artifacts-dir files carry a real, positive size_bytes — never null for a file that exists', { skip: NEEDS_ARTIFACT_FILES }, () => {
  const result = buildProof(PROJECT_ROOT, RUN_ID);
  const runDirArtifacts = result.artifacts.filter((a) => a.source === 'run-artifacts-dir');
  assert.ok(runDirArtifacts.length > 0);
  for (const a of runDirArtifacts) {
    assert.equal(typeof a.size_bytes, 'number');
    assert.ok(a.size_bytes > 0, `${a.name} should have a real positive size`);
  }
});

// cc-fix-adapter gate-output fix — the real `output` field on a check_passed/check_failed event
// now survives the trip through buildProof(), instead of being silently dropped.
test('event-sourced verdicts keep whatever real output/evidence field the event itself carried', { skip: NEEDS_EVENTS }, () => {
  const result = buildProof(PROJECT_ROOT, RUN_ID);
  const eventVerdicts = result.verdicts.filter((v) => v.source === 'event');
  assert.ok(eventVerdicts.length > 0);
  // Never fabricated: a verdict with neither field on the raw event must report both as null,
  // not an invented placeholder string.
  for (const v of eventVerdicts) {
    assert.ok('output' in v, 'output key must always be present, even when null');
    assert.ok(v.output === null || typeof v.output === 'string');
  }
});
