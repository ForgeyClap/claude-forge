// cc-fix-artifacts-empty: buildProofAll() tests, against this project's OWN real
// `.claude/forge-runs/` + `.claude/forge-artifacts/` data (same real-fixture convention as
// proof.test.mjs). Repro for the live bug this WP fixes: the NEWEST run
// (`forge-2026-07-29-cc-finish`, this very run) has an empty `artifacts/` directory, while an
// OLDER run (`forge-2026-07-25-full-audit`) carries 4 real run-artifacts-dir files plus 2 matching
// forge-artifacts-index entries — a single-run-only read (buildProof on the newest run) reports
// 0/0 even though real evidence exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildProofAll } from '../src/proof.mjs';
import { listRuns } from '../src/runs.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { needsRunArtifacts, needsAnyRunArtifacts, needsArtifactsIndex, needsAll } from './.real-data-guard.mjs';

const OLDER_RUN_ID = 'forge-2026-07-25-full-audit';
// The newest run changes with every real mission — derive it, a hardcoded id goes stale in weeks.
const NEWEST_RUN_ID = (() => { const r = listRuns(PROJECT_ROOT); return r.ok && r.runs.length ? r.runs[0].run_id : null; })();
// The default 10-run window is a PRODUCT bound; these tests target the aggregation/labelling logic,
// so they widen the window to cover every run on disk — otherwise the fixture run ages out of the
// window as new runs land and a real green turns into a false red (happened 2026-08-06 at 45 runs).
const ALL_RUNS = existsSync(join(PROJECT_ROOT, '.claude', 'forge-runs')) ? readdirSync(join(PROJECT_ROOT, '.claude', 'forge-runs')).length : 0;
const WIDE = Math.max(ALL_RUNS, 50);

// Two independent real sources feed buildProofAll(): the per-run `artifacts/` directories and the
// project-wide artifact store index. Each assertion is guarded on the one(s) it actually reads.
const NEEDS_OLDER_RUN_ARTIFACTS = needsRunArtifacts(OLDER_RUN_ID);
const NEEDS_ANY_RUN_ARTIFACTS = needsAnyRunArtifacts();
const NEEDS_INDEX = needsArtifactsIndex();

test('aggregation: an OLDER run\'s real artifacts are included, not just the newest run\'s', { skip: needsAll(NEEDS_OLDER_RUN_ARTIFACTS, NEEDS_INDEX) }, () => {
  const result = buildProofAll(PROJECT_ROOT, WIDE);
  assert.equal(result.ok, true);
  assert.equal(result.run_id, 'all');
  const fromOlderRun = result.artifacts.filter((a) => a.run_id === OLDER_RUN_ID);
  // the real 4 run-artifacts-dir files + the 2 real forge-artifacts-index entries that reference
  // this run (see proof.test.mjs for the same real count on the single-run path)
  assert.ok(fromOlderRun.length >= 6, `expected >=6 artifacts labelled with the older run, got ${fromOlderRun.length}`);
});

test('labels: every run-artifacts-dir artifact carries the real run id it was found under', { skip: NEEDS_ANY_RUN_ARTIFACTS }, () => {
  const result = buildProofAll(PROJECT_ROOT, WIDE);
  const runDirArtifacts = result.artifacts.filter((a) => a.source === 'run-artifacts-dir');
  assert.ok(runDirArtifacts.length > 0);
  for (const a of runDirArtifacts) {
    assert.equal(typeof a.run_id, 'string');
    assert.ok(a.run_id.length > 0);
  }
});

test('labels: a forge-artifacts-index entry that references a real run is labelled with that run id, never a fabricated one', { skip: needsAll(NEEDS_INDEX, NEEDS_OLDER_RUN_ARTIFACTS) }, () => {
  const result = buildProofAll(PROJECT_ROOT, WIDE);
  const indexArtifacts = result.artifacts.filter((a) => a.source === 'forge-artifacts-index');
  const wp0 = indexArtifacts.find((a) => a.id === 'wp0-audit-reports');
  assert.ok(wp0, 'the real wp0-audit-reports index entry must be present');
  assert.equal(wp0.run_id, OLDER_RUN_ID);
});

test('labels: an index entry with no run reference anywhere in its own stored body is honestly null, never guessed', { skip: NEEDS_INDEX }, () => {
  const result = buildProofAll(PROJECT_ROOT);
  const indexArtifacts = result.artifacts.filter((a) => a.source === 'forge-artifacts-index');
  const orphan = indexArtifacts.find((a) => a.id === 'art-mc-report');
  assert.ok(orphan, 'the real, run-less art-mc-report index entry must still be present — never silently dropped');
  assert.equal(orphan.run_id, null);
});

test('bound: a maxRuns window that excludes the older run yields none of its run-artifacts-dir files', { skip: NEEDS_INDEX }, () => {
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

test('the newest run alone would have reported empty — this is the real regression this WP fixes', { skip: NEEDS_ANY_RUN_ARTIFACTS }, () => {
  const result = buildProofAll(PROJECT_ROOT, WIDE);
  const fromNewestRun = result.artifacts.filter((a) => a.run_id === NEWEST_RUN_ID);
  // Honest either way: assert the CLAIM this test exists to prove — the aggregate carries real
  // artifacts from a run OTHER than the newest one, which is exactly what a newest-run-only read
  // (the pre-fix behavior) could never surface.
  const fromOtherRuns = result.artifacts.filter((a) => a.run_id !== null && a.run_id !== NEWEST_RUN_ID);
  assert.ok(fromOtherRuns.length > 0, 'at least one real artifact must come from a run other than the newest');
  assert.equal(fromNewestRun.length, 0, 'the newest run genuinely has no artifacts/ dir yet — confirms the repro premise');
});
