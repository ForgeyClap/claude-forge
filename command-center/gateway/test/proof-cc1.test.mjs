// WP-CC1 (item 10) tests for buildProof()'s new sources: checks dedup (latest wins), reviews,
// gate_evidence, finalize_receipt, and the run-contract spawn (against a fixture script, never the
// real forge-runcontract.cjs from a unit test). Isolated fixture — never the real fleet.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildProof, buildProofAll, _setRunContractCjsForTests, _resetRunContractCacheForTests } from '../src/proof.mjs';
import { writeEventsFile, appendEventLine } from '../test-support/helpers.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

// Codex review 2026-09-28 (R1): a receipt is checked against the log's real content, so a valid fixture
// carries the real sha256 and byte size of the events.jsonl it describes, exactly as forge-finalize writes it.
function realLogFields(runDir) {
  const buf = fs.readFileSync(path.join(runDir, 'events.jsonl'));
  return { digest: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

const tempRoots = [];
function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proof-cc1-test-'));
  tempRoots.push(root);
  return root;
}
// buildProofAll() (unlike buildProof()) calls listRuns(), which independently re-checks
// anyContainmentOk(SYNC_SCAN_ROOTS, projectPath) against paths.mjs's REAL, live SYNC_SCAN_ROOTS —
// an os.tmpdir() fixture fails that check (same reasoning as runs.test.mjs's own header comment).
const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-proof-cc1-all');
function freshRootUnderDataDir() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  return root;
}
after(() => {
  _resetRunContractCacheForTests();
  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

test('item 11: an indexed artifact doc\'s relative `path` resolves against .claude/, not the bare project root', async () => {
  const root = freshRoot();
  const targetDir = path.join(root, '.claude', 'forge-runs', 'run-i', 'artifacts');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'wp0-report.md'), 'hello world, a real 17-byte-ish file', 'utf8');
  const artifactsStoreDir = path.join(root, '.claude', 'forge-artifacts');
  fs.mkdirSync(artifactsStoreDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsStoreDir, 'index.jsonl'), JSON.stringify({ id: 'idx-1', store: 'artifacts', ts: '2026-09-27T00:00:00.000Z' }) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(artifactsStoreDir, 'idx-1.json'),
    JSON.stringify({ title: 'wp0 report', path: 'forge-runs/run-i/artifacts/wp0-report.md', run_id_ref: 'run-i' }),
    'utf8',
  );
  writeEventsFile(root, 'run-i', [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);

  const result = await buildProof(root, 'run-i');
  const indexed = result.artifacts.find((a) => a.source === 'forge-artifacts-index' && a.id === 'idx-1');
  assert.ok(indexed, 'the index entry must match (its stored doc references this run_id)');
  assert.equal(typeof indexed.size_bytes, 'number');
  assert.ok(indexed.size_bytes > 0, 'the real file must be found via the .claude/-relative path, never null');
});

test('item 11: buildProofAll includes final reports, gate evidence, PRDs/mission-blueprints, research files and the vault, all with real sizes', async () => {
  const root = freshRootUnderDataDir();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-j');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'final-report.md'), '# report\nreal content here', 'utf8');
  fs.writeFileSync(path.join(runDir, 'gate-evidence.json'), '{"gates_total":1}', 'utf8');
  fs.writeFileSync(path.join(runDir, 'mission-blueprint.md'), '# blueprint', 'utf8');
  fs.writeFileSync(path.join(runDir, 'prd-thing.md'), '# prd', 'utf8');
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify({ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }) + '\n', 'utf8');

  const researchDir = path.join(root, '.claude', 'forge-research');
  fs.mkdirSync(path.join(researchDir, '2026-09-27-topic'), { recursive: true });
  fs.writeFileSync(path.join(researchDir, 'README.md'), '# research', 'utf8');
  fs.writeFileSync(path.join(researchDir, '2026-09-27-topic', 'FINDINGS.md'), '# findings', 'utf8');

  const vaultDir = path.join(root, '.claude', 'forge-vault');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'entry-1.json'), '{"note":"vault entry"}', 'utf8');

  const result = buildProofAll(root);
  assert.equal(result.ok, true);
  const byType = (source) => result.artifacts.filter((a) => a.source === source);
  assert.equal(byType('run-top-level-doc').length, 4, 'final-report, gate-evidence, mission-blueprint, prd');
  assert.ok(byType('run-top-level-doc').every((a) => typeof a.size_bytes === 'number' && a.size_bytes > 0));
  assert.equal(byType('forge-research').length, 2, 'README.md + the one-level-deep FINDINGS.md');
  assert.ok(byType('forge-research').some((a) => a.name === '2026-09-27-topic/FINDINGS.md'));
  assert.equal(byType('forge-vault').length, 1);
  assert.equal(byType('forge-vault')[0].size_bytes > 0, true);
});

test('item 11: a reserved-name synthetic run never fills the "last N runs" artifacts window, even when it has real-looking work events', () => {
  const root = freshRootUnderDataDir();
  const realRunDir = path.join(root, '.claude', 'forge-runs', 'run-real');
  fs.mkdirSync(realRunDir, { recursive: true });
  fs.writeFileSync(path.join(realRunDir, 'final-report.md'), '# real report', 'utf8');
  fs.writeFileSync(path.join(realRunDir, 'events.jsonl'), JSON.stringify({ event_type: 'wp_completed', wp_id: 'wp1', timestamp: '2026-09-27T00:00:00.000Z' }) + '\n', 'utf8');

  // bench-fake-1 is a RESERVED synthetic name (runs.mjs's own pattern) — carries a real-looking
  // work event and its own final-report.md, so the ONLY thing that can exclude it is the name
  // itself, never a lack of evidence.
  const fakeRunDir = path.join(root, '.claude', 'forge-runs', 'bench-fake-1');
  fs.mkdirSync(fakeRunDir, { recursive: true });
  fs.writeFileSync(path.join(fakeRunDir, 'final-report.md'), '# fake report', 'utf8');
  fs.writeFileSync(path.join(fakeRunDir, 'events.jsonl'), JSON.stringify({ event_type: 'wp_completed', wp_id: 'wp1', timestamp: '2026-09-27T01:00:00.000Z' }) + '\n', 'utf8');

  const result = buildProofAll(root, 10);
  assert.equal(result.ok, true);
  const runIds = new Set(result.artifacts.filter((a) => a.source === 'run-top-level-doc').map((a) => a.run_id));
  assert.ok(runIds.has('run-real'), 'the real run\'s final-report.md must be included');
  assert.ok(!runIds.has('bench-fake-1'), 'a reserved-name synthetic run must never fill the artifacts window');
});

test('checks are deduped by name — the LATEST result per check wins, a later pass clears an earlier failure', async () => {
  const root = freshRoot();
  writeEventsFile(root, 'run-a', [
    { event_type: 'check_failed', check: 'lint', summary: 'first attempt failed', timestamp: '2026-09-27T00:00:00.000Z' },
    { event_type: 'check_passed', check: 'lint', summary: 'retry passed', timestamp: '2026-09-27T00:05:00.000Z' },
    { event_type: 'check_passed', check: 'unit-tests', summary: 'green', timestamp: '2026-09-27T00:06:00.000Z' },
  ]);
  const result = await buildProof(root, 'run-a');
  assert.equal(result.ok, true);
  const lint = result.verdicts.find((v) => v.check === 'lint');
  assert.ok(lint);
  assert.equal(lint.event_type, 'check_passed', 'the LATEST (passing) result must win, not the first (failing) one');
  assert.equal(lint.summary, 'retry passed');
  assert.equal(result.verdicts.filter((v) => v.check === 'lint').length, 1, 'no duplicate rows for the same check name');
  const unit = result.verdicts.find((v) => v.check === 'unit-tests');
  assert.ok(unit);
});

test('a check with no `check` name at all falls back to `command` as its dedup key, and is never merged with an unrelated unnamed check', async () => {
  const root = freshRoot();
  writeEventsFile(root, 'run-b', [
    { event_type: 'check_passed', command: 'npm test', timestamp: '2026-09-27T00:00:00.000Z' },
  ]);
  const result = await buildProof(root, 'run-b');
  const row = result.verdicts.find((v) => v.command === 'npm test');
  assert.ok(row);
  assert.equal(row.check, null);
});

test('reviews pair review_started/review_completed by review_id with the real subject/verdict/commit_sha', async () => {
  const root = freshRoot();
  writeEventsFile(root, 'run-c', [
    { event_type: 'review_started', agent: 'codex', review_id: 'r1', subject: 'the diff', timestamp: '2026-09-27T00:00:00.000Z' },
    { event_type: 'review_completed', agent: 'codex', review_id: 'r1', verdict: 'changes_required', commit_sha: 'abc123', summary: 'found issues', timestamp: '2026-09-27T00:10:00.000Z' },
  ]);
  const result = await buildProof(root, 'run-c');
  assert.equal(result.reviews_count, 1);
  const r = result.reviews[0];
  assert.equal(r.review_id, 'r1');
  assert.equal(r.agent, 'codex');
  assert.equal(r.subject, 'the diff');
  assert.equal(r.verdict, 'changes_required');
  assert.equal(r.commit_sha, 'abc123');
  assert.equal(r.started_at, '2026-09-27T00:00:00.000Z');
  assert.equal(r.completed_at, '2026-09-27T00:10:00.000Z');
});

test('gate_evidence maps the real gate-evidence.json shape (names, exit codes, duration, commit, stable)', async () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-d');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'gate-evidence.json'), JSON.stringify({
    gates_total: 2, gates_failed: 0, all_green: true,
    code: { commit: 'deadbeef', worktree_clean: false },
    generated_at: '2026-09-27T17:17:22.688Z',
    gates: [{ name: 'doctor-source-full', exit_code: 0, duration_ms: 929054, timed_out: false, code: { stable: false } }],
  }), 'utf8');

  const result = await buildProof(root, 'run-d');
  assert.equal(result.gate_evidence_present, true);
  assert.equal(result.gate_evidence.gates_total, 2);
  assert.equal(result.gate_evidence.all_green, true);
  assert.equal(result.gate_evidence.commit, 'deadbeef');
  assert.equal(result.gate_evidence.worktree_clean, false);
  assert.equal(result.gate_evidence.gates[0].name, 'doctor-source-full');
  assert.equal(result.gate_evidence.gates[0].duration_ms, 929054);
  assert.equal(result.gate_evidence.gates[0].stable, false);
});

test('no gate-evidence.json -> gate_evidence_present:false, never a fabricated object', async () => {
  const root = freshRoot();
  const result = await buildProof(root, 'run-e-does-not-exist-yet');
  assert.equal(result.ok, true);
  assert.equal(result.gate_evidence_present, false);
  assert.equal(result.gate_evidence, null);
});

test('finalize_receipt maps run-finalized.json, and finalized:true only when it is genuinely present', async () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-f');
  fs.mkdirSync(runDir, { recursive: true });
  // Codex run B F-11: a valid receipt now needs the SAME fields forge-finalize.cjs actually writes
  // and validateFinalizeReceipt() actually checks — run_id (matching THIS run), a 64-hex digest, a
  // finite bytes count, alongside the fields already asserted below. The old fixture (no run_id, no
  // bytes, a non-hex digest) would now correctly read as finalized:false; updated here to prove the
  // ORDINARY, genuinely-valid case still works, not to weaken the new validation.
  writeEventsFile(root, 'run-f', [{ event_type: 'run_started', timestamp: '2026-08-09T01:00:00.000Z' }]);
  const log = realLogFields(runDir);
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({
    run_id: 'run-f', digest: log.digest, bytes: log.bytes, contract: 'ok', domain: 'tooling', events: 25, ruleset_sha256: 'abc', finalized_at: '2026-08-09T01:32:50.094Z',
  }), 'utf8');

  const result = await buildProof(root, 'run-f');
  assert.equal(result.finalized, true);
  assert.equal(result.finalize_receipt.digest, log.digest);
  assert.equal(result.finalize_receipt.contract, 'ok');
  assert.equal(result.finalize_invalid_reason, null);
});

test('F-11: a forged/invalid run-finalized.json (missing run_id/bytes, non-hex digest) never counts as finalized', async () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-f-forged');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({
    digest: 'not-a-real-digest', contract: 'ok', domain: 'tooling', events: 25, ruleset_sha256: 'abc', finalized_at: '2026-08-09T01:32:50.094Z',
  }), 'utf8');

  const result = await buildProof(root, 'run-f-forged');
  assert.equal(result.finalized, false);
  assert.equal(result.finalize_receipt, null);
  assert.ok(result.finalize_invalid_reason, 'a genuinely-present but invalid receipt must say WHY, not just silently read as absent');
});

test('F-11: an empty object {} run-finalized.json never counts as finalized (the historical bug this closes)', async () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-f-empty');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), '{}', 'utf8');

  const result = await buildProof(root, 'run-f-empty');
  assert.equal(result.finalized, false);
  assert.equal(result.finalize_receipt, null);
  assert.ok(result.finalize_invalid_reason);
});

// WP-RB-CC (review finding M-1): a stale receipt must never still read as "Finalized". Before this
// fix, buildProof() (like listRuns()) only checked the receipt's SHAPE, never compared its pinned
// `bytes` against the CURRENT events.jsonl — a run finalized once and then re-opened (a follow-up
// logs more events into the SAME run) still showed finalized:true with the old digest in Tests & proof.
test('M-1: a log that GROWS after finalizing reads finalized:false with the honest reason, never a stale "Finalized"', async () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-grew-after-finalize');
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = writeEventsFile(root, 'run-grew-after-finalize', [
    { event_type: 'run_started', timestamp: '2026-09-28T00:00:00.000Z' },
  ]);
  assert.ok(fs.existsSync(eventsPath));
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({
    run_id: 'run-grew-after-finalize', ...realLogFields(runDir), events: 1,
    contract: 'ok', domain: 'tooling', ruleset_sha256: 'abc', finalized_at: '2026-09-28T00:05:00.000Z',
  }), 'utf8');

  const beforeAppend = await buildProof(root, 'run-grew-after-finalize');
  assert.equal(beforeAppend.finalized, true, 'sanity: the receipt is genuinely valid before the log changes');

  // A follow-up logs one more real event into the SAME already-finalized run.
  appendEventLine(eventsPath, { event_type: 'agent_started', agent: 'Build Boss', timestamp: '2026-09-28T00:10:00.000Z' });

  const afterAppend = await buildProof(root, 'run-grew-after-finalize');
  assert.equal(afterAppend.finalized, false, 'a log that grew after finalizing must never still read as Finalized');
  assert.equal(afterAppend.finalize_receipt, null);
  assert.equal(afterAppend.finalize_invalid_reason, 'the log changed after it was finalized');
});

test('run_contract is read-only through a fixture script, and the result is cached', async () => {
  const root = freshRoot();
  writeEventsFile(root, 'run-g', [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  const fixtureScript = path.join(freshRoot(), 'fake-runcontract.cjs');
  fs.writeFileSync(
    fixtureScript,
    "process.stdout.write(JSON.stringify({ ok: false, run_id: process.argv[3], missing: ['independent-verification'], satisfied: [], warnings: [], overridden: [] }));\nprocess.exitCode = 3;\n",
    'utf8',
  );
  _setRunContractCjsForTests(fixtureScript);
  _resetRunContractCacheForTests();

  const result = await buildProof(root, 'run-g');
  assert.ok(result.run_contract);
  assert.equal(result.run_contract.available, true, 'exit code 3 with real JSON on stdout is a normal result, not a failure');
  assert.equal(result.run_contract.result.ok, false);
  assert.deepEqual(result.run_contract.result.missing, ['independent-verification']);

  _setRunContractCjsForTests(null);
  _resetRunContractCacheForTests();
});

test('run_contract when the central script is missing reports available:false honestly, never a crash', async () => {
  const root = freshRoot();
  // WP-CC1 (Lead review, LOW): a REAL, existing run folder — the "unknown run" guard added below
  // must never shadow this test's own actual claim (the central SCRIPT is what's missing here, not
  // the run). A nonexistent run id would now be refused for a different, earlier reason.
  writeEventsFile(root, 'run-h-real-but-script-missing', [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  _setRunContractCjsForTests(path.join(root, 'does-not-exist.cjs'));
  _resetRunContractCacheForTests();

  const result = await buildProof(root, 'run-h-real-but-script-missing');
  assert.equal(result.ok, true);
  assert.equal(result.run_contract.available, false);
  assert.match(result.run_contract.note, /central forge-runcontract\.cjs was not found/);

  _setRunContractCjsForTests(null);
  _resetRunContractCacheForTests();
});

test('WP-CC1 (Lead review, LOW): a run id starting with "-" is refused before any spawn, never reaching the fixture script', async () => {
  const root = freshRoot();
  const fixtureScript = path.join(freshRoot(), 'marker-on-spawn.cjs');
  const markerPath = path.join(root, 'spawn-happened.marker');
  fs.writeFileSync(
    fixtureScript,
    "require('fs').writeFileSync(" + JSON.stringify(markerPath) + ", 'spawned');\nprocess.stdout.write('{\"ok\":true}');\n",
    'utf8',
  );
  _setRunContractCjsForTests(fixtureScript);
  _resetRunContractCacheForTests();

  // safeIdOk() at buildProof()'s own top already rejects most unsafe shapes, but "-x" (or a bare
  // "-") is a syntactically VALID id under that regex (`^[A-Za-z0-9_-]+$` allows a leading hyphen)
  // — this is exactly the shape this guard exists to refuse anyway, in depth.
  const result = await buildProof(root, '-x');
  assert.equal(result.ok, true, 'buildProof() itself still answers normally — only the run_contract sub-field is refused');
  assert.equal(result.run_contract.available, false);
  assert.match(result.run_contract.note, /must not start with "-"/);
  assert.equal(fs.existsSync(markerPath), false, 'the fixture script must never have actually run');

  _setRunContractCjsForTests(null);
  _resetRunContractCacheForTests();
});

test('WP-CC1 (Lead review, LOW): a run folder that does not exist answers "unknown run" before any spawn', async () => {
  const root = freshRoot();
  const fixtureScript = path.join(freshRoot(), 'marker-on-spawn-2.cjs');
  const markerPath = path.join(root, 'spawn-happened-2.marker');
  fs.writeFileSync(
    fixtureScript,
    "require('fs').writeFileSync(" + JSON.stringify(markerPath) + ", 'spawned');\nprocess.stdout.write('{\"ok\":true}');\n",
    'utf8',
  );
  _setRunContractCjsForTests(fixtureScript);
  _resetRunContractCacheForTests();

  // No run directory was ever created for this id — a page GETting /api/proof with an arbitrary or
  // enumerated run id must never cause one forge-runcontract.cjs process per request.
  const result = await buildProof(root, 'run-that-was-never-created');
  assert.equal(result.ok, true);
  assert.equal(result.run_contract.available, false);
  assert.match(result.run_contract.note, /unknown run/);
  assert.equal(fs.existsSync(markerPath), false, 'the fixture script must never have actually run');

  _setRunContractCjsForTests(null);
  _resetRunContractCacheForTests();
});

test('Codex R1: an equal-length edit of the log after finalizing (check_passed -> check_failed) reads changed, never Finalized', async () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-edited-same-length');
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = writeEventsFile(root, 'run-edited-same-length', [{ event_type: 'check_passed', timestamp: '2026-09-28T00:00:00.000Z' }]);
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({ run_id: 'run-edited-same-length', ...realLogFields(runDir), events: 1, contract: 'ok' }), 'utf8');
  assert.equal((await buildProof(root, 'run-edited-same-length')).finalized, true, 'sanity: valid before the edit');
  const original = fs.readFileSync(eventsPath, 'utf8');
  const edited = original.replace('check_passed', 'check_failed');
  assert.equal(edited.length, original.length);
  fs.writeFileSync(eventsPath, edited, 'utf8');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(eventsPath, later, later);
  const result = await buildProof(root, 'run-edited-same-length');
  assert.equal(result.finalized, false);
  assert.equal(result.finalize_invalid_reason, 'the log changed after it was finalized');
});

test('Codex R1: a receipt whose run log is missing never counts as finalized', async () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-log-missing');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run-finalized.json'), JSON.stringify({ run_id: 'run-log-missing', digest: 'a'.repeat(64), bytes: 10, events: 1, contract: 'ok' }), 'utf8');
  const result = await buildProof(root, 'run-log-missing');
  assert.equal(result.finalized, false);
  assert.equal(result.finalize_invalid_reason, 'the run log is missing, so the receipt cannot be checked');
});

test('Codex R3: the gallery says it is cut off when an OLDER real run beyond the window has artifacts', async () => {
  // buildProofAll() goes through listRuns(), which only admits roots under the real scan roots.
  const root = freshRootUnderDataDir();
  for (let i = 0; i < 3; i++) {
    const id = `run-art-${i}`;
    writeEventsFile(root, id, [{ event_type: 'run_started', timestamp: `2026-09-2${i}T00:00:00.000Z` }]);
    fs.writeFileSync(path.join(root, '.claude', 'forge-runs', id, 'final-report.md'), '# report ' + i, 'utf8');
  }
  assert.equal((await buildProofAll(root, 2)).artifacts_truncated, true, 'a third run with a report sits outside a 2-run window');
  assert.equal((await buildProofAll(root, 3)).artifacts_truncated, false, 'every run fits: nothing is cut');
});

test('Codex verification N3: older runs that hold nothing for the gallery never raise the cut-off note', async () => {
  const root = freshRootUnderDataDir();
  for (let i = 0; i < 3; i++) {
    writeEventsFile(root, `run-plain-${i}`, [{ event_type: 'run_started', timestamp: `2026-09-2${i}T00:00:00.000Z` }]);
  }
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', 'run-plain-0', 'notes.txt'), 'not a gallery item', 'utf8');
  assert.equal((await buildProofAll(root, 1)).artifacts_truncated, false, 'two older runs without artifacts hide nothing');
});
