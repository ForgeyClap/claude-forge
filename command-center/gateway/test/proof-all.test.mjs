// cc-fix-artifacts-empty: buildProofAll() tests, against this project's OWN real
// `.claude/forge-runs/` + `.claude/forge-artifacts/` data (same real-fixture convention as
// proof.test.mjs). Repro for the live bug this WP fixes: the NEWEST run
// (`forge-2026-07-29-cc-finish`, this very run) has an empty `artifacts/` directory, while an
// OLDER run (`forge-2026-07-25-full-audit`) carries 4 real run-artifacts-dir files plus 2 matching
// forge-artifacts-index entries — a single-run-only read (buildProof on the newest run) reports
// 0/0 even though real evidence exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProofAll } from '../src/proof.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';

const OLDER_RUN_ID = 'forge-2026-07-25-full-audit';
const NEWEST_RUN_ID = 'forge-2026-07-29-cc-finish';

test('aggregation: an OLDER run\'s real artifacts are included, not just the newest run\'s', () => {
  const result = buildProofAll(PROJECT_ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.run_id, 'all');
  const fromOlderRun = result.artifacts.filter((a) => a.run_id === OLDER_RUN_ID);
  // the real 4 run-artifacts-dir files + the 2 real forge-artifacts-index entries that reference
  // this run (see proof.test.mjs for the same real count on the single-run path)
  assert.ok(fromOlderRun.length >= 6, `expected >=6 artifacts labelled with the older run, got ${fromOlderRun.length}`);
});

test('labels: every run-artifacts-dir artifact carries the real run id it was found under', () => {
  const result = buildProofAll(PROJECT_ROOT);
  const runDirArtifacts = result.artifacts.filter((a) => a.source === 'run-artifacts-dir');
  assert.ok(runDirArtifacts.length > 0);
  for (const a of runDirArtifacts) {
    assert.equal(typeof a.run_id, 'string');
    assert.ok(a.run_id.length > 0);
  }
});

test('labels: a forge-artifacts-index entry that references a real run is labelled with that run id, never a fabricated one', () => {
  const result = buildProofAll(PROJECT_ROOT);
  const indexArtifacts = result.artifacts.filter((a) => a.source === 'forge-artifacts-index');
  const wp0 = indexArtifacts.find((a) => a.id === 'wp0-audit-reports');
  assert.ok(wp0, 'the real wp0-audit-reports index entry must be present');
  assert.equal(wp0.run_id, OLDER_RUN_ID);
});

test('labels: an index entry with no run reference anywhere in its own stored body is honestly null, never guessed', () => {
  const result = buildProofAll(PROJECT_ROOT);
  const indexArtifacts = result.artifacts.filter((a) => a.source === 'forge-artifacts-index');
  const orphan = indexArtifacts.find((a) => a.id === 'art-mc-report');
  assert.ok(orphan, 'the real, run-less art-mc-report index entry must still be present — never silently dropped');
  assert.equal(orphan.run_id, null);
});

test('bound: a maxRuns window that excludes the older run yields none of its run-artifacts-dir files', () => {
  // The older run sits well outside a 1-run window (only the newest run is a candidate) — this
  // proves the bound is real, not decorative: no unlimited scan of every run this project has ever
  // produced.
  const result = buildProofAll(PROJECT_ROOT, 1);
  const fromOlderRun = result.artifacts.filter((a) => a.source === 'run-artifacts-dir' && a.run_id === OLDER_RUN_ID);
  assert.equal(fromOlderRun.length, 0);
  // the run-less index entry is still present regardless of the run-window bound (the index read
  // itself is never bounded by maxRuns — see buildProofAll's own header)
  const stillHasOrphanIndexEntry = result.artifacts.some((a) => a.id === 'art-mc-report');
  assert.ok(stillHasOrphanIndexEntry);
});

test('the newest run alone would have reported empty — this is the real regression this WP fixes', () => {
  const result = buildProofAll(PROJECT_ROOT);
  const fromNewestRun = result.artifacts.filter((a) => a.run_id === NEWEST_RUN_ID);
  // Honest either way: assert the CLAIM this test exists to prove — the aggregate carries real
  // artifacts from a run OTHER than the newest one, which is exactly what a newest-run-only read
  // (the pre-fix behavior) could never surface.
  const fromOtherRuns = result.artifacts.filter((a) => a.run_id !== null && a.run_id !== NEWEST_RUN_ID);
  assert.ok(fromOtherRuns.length > 0, 'at least one real artifact must come from a run other than the newest');
  assert.equal(fromNewestRun.length, 0, 'the newest run genuinely has no artifacts/ dir yet — confirms the repro premise');
});
