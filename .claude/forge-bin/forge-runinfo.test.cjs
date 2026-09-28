#!/usr/bin/env node
'use strict';
/**
 * forge-runinfo.test.cjs — hermetic tests for forge-runinfo.cjs (the v2.9.0 replacement for the retired
 * server.cjs's `--status`/`--runs`/`--open-report` CLI modes).
 *
 * classifyRunDir/orderRunRows are pure and tested directly against os.mkdtemp fixtures (mirrors
 * forge-runlist.test.cjs's proven fixture shapes — the regression history for the demo-run-sorts-first
 * and operational-dir-counted-as-a-run defects must keep passing here too). listRunIds()/latestRunId()
 * read a module-level RUNS_DIR resolved from THIS tool's own install (detectProjectRoot()'s isolation
 * guard refuses an env root that does not contain this very file), so those two are exercised once
 * against the real project, same as forge-runlist.test.cjs did for server.cjs. readRun()'s id
 * validation/containment guard, checkCommandCenterHealth() and commandCenterStartHint() are new surface
 * this tool adds and are covered below with dedicated fixtures. Never touches the real project's own
 * runs/files except read-only.
 *
 * Run: node forge-runinfo.test.cjs   (exit 0 = all pass)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
process.env.FORGE_RUNINFO_TEST_HOOKS = '1'; // STOP-PRUNE-1: __beforePin/__afterPinVerified are gated behind this env var in production code (mirrors forge-sync.test.cjs's own FORGE_SYNC_TEST_HOOKS)

const TOOL = path.join(__dirname, 'forge-runinfo.cjs');
const S = require(TOOL);

let pass = 0, fail = 0, skipped = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };
/** skip(name, reason) — a test that could not be run HERE, stated out loud with why (e.g. this OS
 *  user account lacks the privilege to create a file symlink). Counted into the trailing tally so a
 *  reader of the summary line alone can see something was not checked, rather than it silently
 *  vanishing. Same convention as forge-doctor.test.cjs's own skip(). */
const skip = (name, reason) => { skipped++; console.log('  SKIP ' + name + ' — ' + reason); };
// Linux CI 2026-09-29: the exclusive-lock pin (pinCandidateDirWindows) is a Windows mechanism; on POSIX pruneSynthetic
// uses posixChainIsPrivate instead (its own tests below), so the pin tests run on Windows only.
const tWin = process.platform === 'win32' ? t : (name) => skip(name, 'Windows-only: the exclusive-lock pin is a Windows mechanism (POSIX uses posixChainIsPrivate, tested below)');
// A junction (Windows) is removed with rmdir; a symlink elsewhere with unlink — the link itself, never its target.
function removeLink(p) { if (process.platform !== 'win32' && fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); else fs.rmdirSync(p); }
function tAsync(name, fn) {
  return fn().then(() => { pass++; console.log('  ok  ' + name); }, (e) => { fail++; console.error('  FAIL ' + name + ' — ' + e.message); });
}

function mkRun(runsDir, name, opts) {
  const dir = path.join(runsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.runJson !== undefined) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(opts.runJson), 'utf8');
  if (opts.events !== undefined) fs.writeFileSync(path.join(dir, 'events.jsonl'), opts.events, 'utf8');
  if (opts.mtimeMs) { const d = new Date(opts.mtimeMs); for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), d, d); fs.utimesSync(dir, d, d); }
  return dir;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-'));
const RUNS = path.join(TMP, '.claude', 'forge-runs');
fs.mkdirSync(RUNS, { recursive: true });

const T0 = Date.now() - 3 * 86400000;
mkRun(RUNS, 'forge-2026-09-27-real-newest', { runJson: { run_id: 'forge-2026-09-27-real-newest', status: 'completed' }, events: '{"event_type":"run_started"}\n', mtimeMs: Date.now() });
mkRun(RUNS, 'forge-2026-09-01-real-older', { runJson: { run_id: 'forge-2026-09-01-real-older' }, events: '{"event_type":"run_started"}\n', mtimeMs: T0 });
mkRun(RUNS, 'zzz-demo-preview', { runJson: { _demo: true, synthetic: true, request: 'DEMO LAYOUT PREVIEW' }, events: '{"event_type":"agent_started"}\n', mtimeMs: Date.now() });
fs.mkdirSync(path.join(RUNS, '_toollog'), { recursive: true });
fs.writeFileSync(path.join(RUNS, '_toollog', 'session-abc.jsonl'), '{"tool":"Read"}\n', 'utf8');
fs.mkdirSync(path.join(RUNS, '.hotspot-locks'), { recursive: true });

console.log('forge-runinfo tests (classifyRunDir/orderRunRows/readRun + Command Center health/hint)');

// ---------------------------------------------------------------------------------------------------------
// classifyRunDir / orderRunRows — pure, fixture-driven (same regression shapes as forge-runlist.test.cjs)
// ---------------------------------------------------------------------------------------------------------
t('classifyRunDir: a directory with run.json and/or events.jsonl IS a run', () => {
  assert.strictEqual(S.classifyRunDir(path.join(RUNS, 'forge-2026-09-27-real-newest'), 'x').isRun, true);
});
t('classifyRunDir: an operational directory without run shape is NOT a run', () => {
  assert.strictEqual(S.classifyRunDir(path.join(RUNS, '_toollog'), '_toollog').isRun, false);
  assert.strictEqual(S.classifyRunDir(path.join(RUNS, '.hotspot-locks'), '.hotspot-locks').isRun, false);
});
t('classifyRunDir: a run that declares itself _demo/synthetic is flagged as such', () => {
  const c = S.classifyRunDir(path.join(RUNS, 'zzz-demo-preview'), 'zzz-demo-preview');
  assert.strictEqual(c.isRun, true);
  assert.strictEqual(c.synthetic, true);
});
t('classifyRunDir: PRESENT-but-unparseable run.json is flagged malformed (absent is NOT malformed)', () => {
  const brokenDir = mkRun(RUNS, 'broken-json', { events: '{"event_type":"run_started"}\n' });
  fs.writeFileSync(path.join(brokenDir, 'run.json'), '{ "_demo": true', 'utf8');
  const c = S.classifyRunDir(brokenDir, 'broken-json');
  assert.strictEqual(c.isRun, true);
  assert.strictEqual(c.malformed, true, 'a truncated run.json must not read as trustworthy metadata');
  const noMeta = S.classifyRunDir(path.join(RUNS, 'forge-2026-09-01-real-older'), 'x');
  assert.strictEqual(!!noMeta.malformed, false, 'a run WITHOUT run.json is ordinary, not malformed');
});
t('orderRunRows: newest REAL run first — a synthetic demo never wins "latest"', () => {
  const rows = [
    { name: 'zzz-demo-preview', synthetic: true, recency: 9999 },
    { name: 'forge-real-older', synthetic: false, recency: 100 },
    { name: 'forge-real-newest', synthetic: false, recency: 500 },
  ];
  assert.deepStrictEqual(S.orderRunRows(rows).map((r) => r.name), ['forge-real-newest', 'forge-real-older', 'zzz-demo-preview']);
});
t('orderRunRows: ordering is by real recency, not by directory name', () => {
  const rows = [
    { name: 'aaa-newest', synthetic: false, recency: 900 },
    { name: 'zzz-oldest', synthetic: false, recency: 100 },
  ];
  assert.deepStrictEqual(S.orderRunRows(rows).map((r) => r.name), ['aaa-newest', 'zzz-oldest']);
});
t('recency prefers the newest EVENT over a directory mtime bumped by an unrelated child write', () => {
  const old = mkRun(RUNS, 'recency-old', { events: '{"event_type":"run_started"}\n', mtimeMs: Date.now() - 5 * 86400000 });
  const before = S.classifyRunDir(old, 'recency-old').recency;
  fs.writeFileSync(path.join(old, 'final-report.md'), '# late report\n', 'utf8');
  const after = S.classifyRunDir(old, 'recency-old').recency;
  assert.strictEqual(after, before, 'an unrelated child write must not make an old run look newest');
});

// ---------------------------------------------------------------------------------------------------------
// WP-CC0 (2026-09-27, Command Center audit) — SYNTHETIC_RUN_ID_PATTERNS / classifyRunDir's synthetic
// fallback / inspectSyntheticCandidate / pruneSynthetic. Junk-run folders forge-bench.cjs/forge-doctor.cjs
// used to leave behind (bench-canon-<pid>, bench-fake-<pid>, doctor-selfcheck-<pid>) and a historical
// forge-docs.test.cjs offender (literal nonexistent-run-id) never carried a run.json, so the OLD
// run.json-only synthetic check could not see them and a debris folder could still win "latest run"
// purely by mtime — this section locks down the fix.
// ---------------------------------------------------------------------------------------------------------
t('isReservedSyntheticRunId: matches every documented reserved debris name, with or without a pid suffix', () => {
  for (const n of ['bench-canon-1234', 'bench-canon', 'bench-fake-9', 'bench-fake', 'doctor-selfcheck-42', 'doctor-selfcheck', 'nonexistent-run-id']) {
    assert.strictEqual(S.isReservedSyntheticRunId(n), true, n + ' should match a reserved pattern');
  }
});
t('isReservedSyntheticRunId: a real forge-<date>-<slug> run id never matches', () => {
  assert.strictEqual(S.isReservedSyntheticRunId('forge-2026-09-27-real-newest'), false);
  assert.strictEqual(S.isReservedSyntheticRunId('forge-2026-07-10-boss-smoke'), false);
});
t('isReservedSyntheticRunId: a merely-similar name does NOT match (anchored, not a substring scan)', () => {
  assert.strictEqual(S.isReservedSyntheticRunId('my-bench-canon-fork'), false, 'prefix must be anchored at the start');
  assert.strictEqual(S.isReservedSyntheticRunId('bench-canon-abc'), false, 'the suffix after the dash must be digits only');
  assert.strictEqual(S.isReservedSyntheticRunId('nonexistent-run-id-2'), false, 'nonexistent-run-id is an exact literal, not a prefix');
});
t('classifyRunDir: a reserved-name debris folder with NO run.json (the real historical shape) is still flagged synthetic', () => {
  mkRun(RUNS, 'doctor-selfcheck-4242', { events: '{"event_type":"agent_progress","agent":"orchestrator"}\n', mtimeMs: Date.now() });
  const c = S.classifyRunDir(path.join(RUNS, 'doctor-selfcheck-4242'), 'doctor-selfcheck-4242');
  assert.strictEqual(c.isRun, true, 'it still has events.jsonl, so it is listable');
  assert.strictEqual(c.synthetic, true, 'a reserved debris name must be synthetic even with no run.json to declare it');
});
t('classifyRunDir: same fix for bench-canon-<pid>', () => {
  mkRun(RUNS, 'bench-canon-99', { events: '{"event_type":"agent_progress"}\n', mtimeMs: Date.now() });
  assert.strictEqual(S.classifyRunDir(path.join(RUNS, 'bench-canon-99'), 'bench-canon-99').synthetic, true);
});
t('classifyRunDir: the reserved-name rule is name-anchored, not content-sniffing — an ordinarily-named run with the SAME lone agent_progress event stays non-synthetic', () => {
  mkRun(RUNS, 'my-real-mission-run', { events: '{"event_type":"agent_progress","agent":"orchestrator"}\n', mtimeMs: Date.now() });
  const c = S.classifyRunDir(path.join(RUNS, 'my-real-mission-run'), 'my-real-mission-run');
  assert.strictEqual(c.synthetic, false, 'only the reserved NAME triggers this fallback, never the event content alone');
});

// --- inspectSyntheticCandidate() — the read-only, non-recursive, allowlisted-files judgement ---
const PS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-prune-'));
const PS_RUNS = path.join(PS_TMP, '.claude', 'forge-runs');
fs.mkdirSync(PS_RUNS, { recursive: true });
t('inspectSyntheticCandidate: a non-reserved name is never eligible, whatever it contains', () => {
  const dir = mkRun(PS_RUNS, 'forge-2026-09-27-genuine-mission', { events: '{"event_type":"agent_progress"}\n' });
  const v = S.inspectSyntheticCandidate(dir, 'forge-2026-09-27-genuine-mission', PS_RUNS);
  assert.strictEqual(v.eligible, false);
  assert.ok(/does not match/.test(v.reason), v.reason);
});
// PRUNE-2 (Codex adversarial-review round 2, MEDIUM): eligibility now also requires the events.jsonl
// CONTENT to look like one of the documented self-test signatures — these two fixtures use the real
// doctor-self-check / bench shapes (see SYNTHETIC_DEBRIS_EVENT_SIGNATURES's own doc comment), not a
// generic placeholder event, so they still prove "genuine old debris is removed".
t('inspectSyntheticCandidate: a reserved name containing ONLY events.jsonl (real doctor-self-check content) is eligible', () => {
  const dir = mkRun(PS_RUNS, 'doctor-selfcheck-1', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' });
  const v = S.inspectSyntheticCandidate(dir, 'doctor-selfcheck-1', PS_RUNS);
  assert.strictEqual(v.eligible, true, v.reason);
  assert.deepStrictEqual(v.files.sort(), ['events.jsonl']);
  assert.ok(v.identity && v.identity.dir && v.identity.files['events.jsonl'], 'expected an identity snapshot for the re-check-before-delete step');
});
t('inspectSyntheticCandidate: a reserved name with events.jsonl + events.jsonl.lock (a crashed-mid-write shape, real bench content) is still eligible', () => {
  const dir = mkRun(PS_RUNS, 'bench-canon-2', { events: '{"event_type":"agent_progress","agent":"Build Boss","note":"b"}\n' });
  fs.writeFileSync(path.join(dir, 'events.jsonl.lock'), '', 'utf8');
  const v = S.inspectSyntheticCandidate(dir, 'bench-canon-2', PS_RUNS);
  assert.strictEqual(v.eligible, true, v.reason);
  assert.deepStrictEqual(v.files.sort(), ['events.jsonl', 'events.jsonl.lock']);
});
t('inspectSyntheticCandidate: the nonexistent-run-id doc_generated signature is also recognised', () => {
  const dir = mkRun(PS_RUNS, 'nonexistent-run-id', { events: '{"event_type":"doc_generated","format":"docx","out":"C:\\\\x\\\\out.docx","bytes":1234}\n' });
  const v = S.inspectSyntheticCandidate(dir, 'nonexistent-run-id', PS_RUNS);
  assert.strictEqual(v.eligible, true, v.reason);
});
// PRUNE-2: a genuine mission can legally be named a reserved pattern (log-event.cjs's own run-id regex
// accepts any [A-Za-z0-9_-] id and is deliberately NOT taught to refuse these names) — its REAL,
// multi-event content must never be mistaken for self-test debris just because of the folder's name.
t('inspectSyntheticCandidate: a real-looking multi-event mission under a reserved name is KEPT, not eligible', () => {
  // SYNTHETIC_RUN_ID_PATTERNS is anchored ("exact literal or a fixed prefix + trailing DIGITS only" —
  // see its own doc comment), so a genuine mission ID like "bench-canon-777" still matches the reserved
  // NAME pattern — the point of this test is that its CONTENT alone must save it from eligibility.
  const dir = mkRun(PS_RUNS, 'bench-canon-777', {
    events: '{"event_type":"run_started"}\n{"event_type":"agent_started","agent":"Build Boss","role":"hero"}\n{"event_type":"agent_completed","agent":"Build Boss"}\n',
  });
  const v = S.inspectSyntheticCandidate(dir, 'bench-canon-777', PS_RUNS);
  assert.strictEqual(v.eligible, false, 'a real multi-event mission must never be pruned just because its name matches a reserved pattern');
  assert.ok(/does not look like self-test debris/.test(v.reason), v.reason);
});
t('inspectSyntheticCandidate: an events.jsonl with more than the self-test line cap is refused, even if every line individually matches', () => {
  const lines = [];
  for (let i = 0; i < S.MAX_SYNTHETIC_DEBRIS_EVENT_LINES + 1; i++) lines.push('{"event_type":"agent_progress","agent":"Build Boss","note":"b"}');
  const dir = mkRun(PS_RUNS, 'bench-fake-888', { events: lines.join('\n') + '\n' });
  const v = S.inspectSyntheticCandidate(dir, 'bench-fake-888', PS_RUNS);
  assert.strictEqual(v.eligible, false);
  assert.ok(/does not look like self-test debris/.test(v.reason), v.reason);
});
{
  const hlDir = mkRun(PS_RUNS, 'doctor-selfcheck-999', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' });
  const outsideLink = path.join(PS_TMP, 'hardlink-target-' + process.pid + '.jsonl');
  try {
    fs.linkSync(path.join(hlDir, 'events.jsonl'), outsideLink); // a 2nd real hard link to the SAME data
    t('inspectSyntheticCandidate: a hardlinked events.jsonl is refused outright (PRUNE-2)', () => {
      const v = S.inspectSyntheticCandidate(hlDir, 'doctor-selfcheck-999', PS_RUNS);
      assert.strictEqual(v.eligible, false, 'a hardlinked file must never be a deletion candidate');
      assert.ok(/hard links/.test(v.reason), v.reason);
    });
  } catch (e) {
    skip('inspectSyntheticCandidate: a hardlinked events.jsonl is refused outright (PRUNE-2)', 'could not create a hard link on this filesystem (' + (e && e.message) + ')');
  } finally { try { fs.unlinkSync(outsideLink); } catch { /* best-effort cleanup */ } }
}
t('inspectSyntheticCandidate: a reserved name that ALSO carries a run.json (or any other unexpected file) is refused, never deleted', () => {
  const dir = mkRun(PS_RUNS, 'bench-fake-3', { runJson: { run_id: 'bench-fake-3' }, events: '{"event_type":"check_passed"}\n' });
  const v = S.inspectSyntheticCandidate(dir, 'bench-fake-3', PS_RUNS);
  assert.strictEqual(v.eligible, false, 'a real extra file must hold the candidate back, never be silently ignored');
  assert.ok(/unexpected file/.test(v.reason), v.reason);
});
t('inspectSyntheticCandidate: a reserved name containing a SUBDIRECTORY is refused outright (non-recursive: never walked into)', () => {
  const dir = mkRun(PS_RUNS, 'doctor-selfcheck-5', { events: '{"event_type":"agent_progress"}\n' });
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  const v = S.inspectSyntheticCandidate(dir, 'doctor-selfcheck-5', PS_RUNS);
  assert.strictEqual(v.eligible, false);
  assert.ok(/non-file entry/.test(v.reason), v.reason);
});
t('inspectSyntheticCandidate: a symlinked/junction reserved-name entry is refused, mirroring readRun()\'s own guard', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-prune-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'events.jsonl'), '{"event_type":"agent_progress"}\n', 'utf8');
    const junctionDir = path.join(PS_RUNS, 'doctor-selfcheck-6');
    fs.symlinkSync(outside, junctionDir, 'junction');
    const v = S.inspectSyntheticCandidate(junctionDir, 'doctor-selfcheck-6', PS_RUNS);
    assert.strictEqual(v.eligible, false);
    assert.ok(/symlink/.test(v.reason), v.reason);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

// --- pruneSynthetic() — dry-run-by-default orchestration, dependency-injected runsDir (never the real project) ---
t('pruneSynthetic: dry run (default) lists eligible/ineligible candidates but deletes NOTHING', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-prune-dry-'));
  const runsDir = path.join(tmp, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  mkRun(runsDir, 'doctor-selfcheck-10', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' }); // eligible
  mkRun(runsDir, 'bench-canon-11', { runJson: { run_id: 'bench-canon-11' }, events: '{"event_type":"agent_progress","agent":"Build Boss","note":"b"}\n' }); // reserved name but NOT eligible (extra file)
  mkRun(runsDir, 'forge-2026-09-27-real-work', { runJson: { run_id: 'forge-2026-09-27-real-work' }, events: '{"event_type":"check_passed"}\n' }); // not a candidate at all
  try {
    const rep = S.pruneSynthetic({ runsDir, apply: false });
    assert.strictEqual(rep.apply, false);
    assert.strictEqual(rep.candidates.length, 2, 'only the 2 reserved-name dirs are candidates; the real run is never even listed');
    const byName = Object.fromEntries(rep.candidates.map((c) => [c.name, c]));
    assert.strictEqual(byName['doctor-selfcheck-10'].eligible, true);
    assert.strictEqual(byName['bench-canon-11'].eligible, false);
    assert.strictEqual(rep.removed.length, 0, 'dry run must never remove anything');
    assert.ok(fs.existsSync(path.join(runsDir, 'doctor-selfcheck-10')), 'dry run must leave the eligible folder on disk untouched');
    assert.ok(fs.existsSync(path.join(runsDir, 'bench-canon-11')));
    assert.ok(fs.existsSync(path.join(runsDir, 'forge-2026-09-27-real-work')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
t('pruneSynthetic --apply: removes ONLY the verified-eligible reserved folder(s); an ineligible reserved-name dir and every real run are left byte-for-byte alone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-prune-apply-'));
  const runsDir = path.join(tmp, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  mkRun(runsDir, 'doctor-selfcheck-20', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' }); // eligible -> must be removed
  mkRun(runsDir, 'bench-fake-21', { runJson: { run_id: 'bench-fake-21' }, events: '{"event_type":"check_passed"}\n' }); // reserved name, NOT eligible -> must survive
  const realDir = mkRun(runsDir, 'forge-2026-09-27-real-work', { runJson: { run_id: 'forge-2026-09-27-real-work' }, events: '{"event_type":"check_passed"}\n' });
  const realBefore = fs.readFileSync(path.join(realDir, 'events.jsonl'), 'utf8');
  try {
    const rep = S.pruneSynthetic({ runsDir, apply: true });
    assert.deepStrictEqual(rep.removed, ['doctor-selfcheck-20']);
    assert.strictEqual(rep.errors.length, 0, JSON.stringify(rep.errors));
    assert.strictEqual(fs.existsSync(path.join(runsDir, 'doctor-selfcheck-20')), false, 'the eligible debris folder must actually be gone');
    assert.ok(fs.existsSync(path.join(runsDir, 'bench-fake-21')), 'an ineligible reserved-name dir must never be deleted');
    assert.ok(fs.existsSync(path.join(runsDir, 'bench-fake-21', 'run.json')), 'its files must survive untouched too');
    assert.strictEqual(fs.readFileSync(path.join(realDir, 'events.jsonl'), 'utf8'), realBefore, 'a real run must be byte-for-byte untouched');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
t('pruneSynthetic: a missing forge-runs directory returns an empty report, never throws', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-prune-missing-'));
  try {
    const rep = S.pruneSynthetic({ runsDir: path.join(tmp, '.claude', 'forge-runs'), apply: true });
    assert.deepStrictEqual(rep.candidates, []);
    assert.deepStrictEqual(rep.removed, []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
t('pruneSynthetic: never touches the real project\'s forge-runs/ unless explicitly asked (no runsDir override -> defaults to the module RUNS_DIR, but this test only asserts the default is RUNS_DIR itself, never invokes apply against it)', () => {
  const rep = S.pruneSynthetic({ apply: false });
  assert.strictEqual(rep.runsDir, S.RUNS_DIR);
});

// ---------------------------------------------------------------------------------------------------------
// RUN-1 fix, round 2 (Codex adversarial-review, HIGH, WP-9B-SRC): round 1 only lstat-checked the RUN
// FOLDER/FILE themselves; round 1's realContainmentOk(RUNS_DIR, dir) trusts RUNS_DIR's OWN realpath at
// face value, so replacing `.claude/forge-runs` ITSELF with a junction to an external directory makes
// every path built from RUNS_DIR resolve "through" that SAME junction — realContainmentOk sees perfect
// containment relative to the already-redirected base. pathChainIsReal()/forgeRunsRootIsReal() walk every
// component from the trusted project root down instead.
// ---------------------------------------------------------------------------------------------------------
const RG2_OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run2-outside-'));
fs.mkdirSync(path.join(RG2_OUTSIDE, 'evil-run'), { recursive: true });
fs.writeFileSync(path.join(RG2_OUTSIDE, 'evil-run', 'run.json'), JSON.stringify({ run_id: 'evil-run' }), 'utf8');
const RG2_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run2-root-'));
const RG2_CLAUDE = path.join(RG2_ROOT, '.claude');
fs.mkdirSync(RG2_CLAUDE, { recursive: true });
const RG2_RUNSDIR = path.join(RG2_CLAUDE, 'forge-runs');
fs.symlinkSync(RG2_OUTSIDE, RG2_RUNSDIR, 'junction'); // `.claude/forge-runs` ITSELF is the junction

t('pathChainIsReal: an ordinary, fully-real nested path is real', () => {
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run2-ok-'));
  fs.mkdirSync(path.join(ok, '.claude', 'forge-runs'), { recursive: true });
  assert.strictEqual(S.pathChainIsReal(ok, path.join(ok, '.claude', 'forge-runs')), true);
});
t('pathChainIsReal: a target whose OWN ancestor (not the target itself) is a junction is NOT real', () => {
  // "evil-run" itself is an ordinary directory — only its ANCESTOR (forge-runs/) is the junction; a
  // leaf-only symlink check (isSymlinkEntry on "evil-run" alone) would never catch this.
  assert.strictEqual(S.pathChainIsReal(RG2_ROOT, path.join(RG2_RUNSDIR, 'evil-run')), false);
});
t('pathChainIsReal: a path lexically outside root is never real, regardless of symlinks', () => {
  assert.strictEqual(S.pathChainIsReal(RG2_ROOT, RG2_OUTSIDE), false);
});
t('forgeRunsRootIsReal: false when .claude/forge-runs itself has been replaced with a junction', () => {
  assert.strictEqual(S.forgeRunsRootIsReal(RG2_ROOT), false);
});
t('forgeRunsRootIsReal: true for an ordinary project with a real (non-junction) forge-runs/', () => {
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run2-ok2-'));
  fs.mkdirSync(path.join(ok, '.claude', 'forge-runs'), { recursive: true });
  assert.strictEqual(S.forgeRunsRootIsReal(ok), true);
});
t('forgeRunsRootIsReal: true (nothing to protect yet) when .claude/forge-runs does not exist at all', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run2-fresh-'));
  assert.strictEqual(S.forgeRunsRootIsReal(fresh), true);
});
t('runsRootRefusalReason: null when real, a plain symlink/junction sentence when the root itself is compromised', () => {
  assert.strictEqual(S.runsRootRefusalReason(RG2_ROOT) !== null, true);
  assert.ok(/symlink\/junction/.test(S.runsRootRefusalReason(RG2_ROOT)), S.runsRootRefusalReason(RG2_ROOT));
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run2-ok3-'));
  assert.strictEqual(S.runsRootRefusalReason(ok), null);
});

// ---------------------------------------------------------------------------------------------------------
// pathChainIsReal round 3 (Lead review, 2026-09-28): the round-2 version ALSO required
// realpath(root) === path.resolve(root) — i.e. that root's OWN ancestry contains no link anywhere — which
// is STRICTER than the finding asked for and breaks a legitimate, owner-chosen setup (a projects folder
// that is itself a symlink/junction to another drive, a redirected Documents folder, macOS's
// /tmp -> /private/tmp). The fix trusts realpath(root) AS GIVEN and only rejects a link BELOW root.
// ---------------------------------------------------------------------------------------------------------
{
  const realRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run3-realroot-'));
  fs.mkdirSync(path.join(realRootDir, '.claude', 'forge-runs'), { recursive: true });
  const rootJunctionParent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run3-rootjunctionparent-'));
  const rootJunction = path.join(rootJunctionParent, 'root-via-junction');
  fs.symlinkSync(realRootDir, rootJunction, 'junction'); // the PROJECT ROOT ITSELF is reached through a junction
  t('pathChainIsReal: a project root reached THROUGH a junction, with real (non-junction) .claude/forge-runs beneath it, is ACCEPTED', () => {
    assert.strictEqual(S.pathChainIsReal(rootJunction, path.join(rootJunction, '.claude')), true);
    assert.strictEqual(S.pathChainIsReal(rootJunction, path.join(rootJunction, '.claude', 'forge-runs')), true);
  });
  t('pathChainIsReal: the root path itself (rel === "") is always accepted -- root\'s own realpath is the trusted anchor, whatever it is', () => {
    assert.strictEqual(S.pathChainIsReal(rootJunction, rootJunction), true);
  });
  t('forgeRunsRootIsReal: true for a project root reached through a junction, with real .claude/forge-runs beneath it', () => {
    assert.strictEqual(S.forgeRunsRootIsReal(rootJunction), true);
  });
}
{
  const realRootDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run3-realroot2-'));
  fs.mkdirSync(path.join(realRootDir2, '.claude'), { recursive: true });
  const attackOutside3 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run3-attackoutside-'));
  fs.symlinkSync(attackOutside3, path.join(realRootDir2, '.claude', 'forge-runs'), 'junction'); // forge-runs BELOW root is the junction
  const rootJunctionParent2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run3-rootjunctionparent2-'));
  const rootJunction2 = path.join(rootJunctionParent2, 'root-via-junction');
  fs.symlinkSync(realRootDir2, rootJunction2, 'junction'); // the root ITSELF is ALSO reached through a junction
  t('pathChainIsReal: a project root reached through a junction, but with .claude/forge-runs BELOW it ALSO junctioned, is still refused', () => {
    assert.strictEqual(S.pathChainIsReal(rootJunction2, path.join(rootJunction2, '.claude', 'forge-runs')), false);
  });
  t('forgeRunsRootIsReal: false for a project root reached through a junction whose forge-runs BELOW it is junctioned', () => {
    assert.strictEqual(S.forgeRunsRootIsReal(rootJunction2), false);
  });
  // Same shape, but WITHOUT the root-via-junction complication -- an ordinary root with a junctioned
  // forge-runs below it must still be refused exactly as round 2 already proved (no regression).
  t('pathChainIsReal: an ORDINARY (non-junctioned) root with .claude/forge-runs BELOW it junctioned is still refused', () => {
    assert.strictEqual(S.pathChainIsReal(realRootDir2, path.join(realRootDir2, '.claude', 'forge-runs')), false);
  });
}

// END-TO-END reproduction of the EXACT reported attack via a REAL spawned CLI process: "make
// .claude/forge-runs a junction to another directory containing a run folder and final-report.md, then
// run node forge-runinfo.cjs open-report". A disposable fixture project root is built with
// `.claude/forge-bin` as a junction BACK to this tool's own real install (so detectProjectRoot()'s
// realpath-match guard accepts FORGE_PROJECT_ROOT) and `.claude/forge-runs` as a SEPARATE junction to an
// external directory holding a fake run + secret report — proving the fix end-to-end without ever
// touching this worktree's own real forge-runs/.
{
  const attackOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run2-attack-outside-'));
  const evilRunDir = path.join(attackOutside, 'evil-run');
  fs.mkdirSync(evilRunDir, { recursive: true });
  fs.writeFileSync(path.join(evilRunDir, 'run.json'), JSON.stringify({ run_id: 'evil-run', status: 'completed' }), 'utf8');
  fs.writeFileSync(path.join(evilRunDir, 'final-report.md'), 'SECRET CONTENT OUTSIDE forge-runs THAT MUST NEVER BE PRINTED', 'utf8');
  const fixRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run2-fixroot-'));
  const fixClaude = path.join(fixRoot, '.claude');
  fs.mkdirSync(fixClaude, { recursive: true });
  const fixForgeBin = path.join(fixClaude, 'forge-bin');
  const fixForgeRuns = path.join(fixClaude, 'forge-runs');
  let planted = false;
  try {
    fs.symlinkSync(path.resolve(__dirname), fixForgeBin, 'junction');
    fs.symlinkSync(attackOutside, fixForgeRuns, 'junction'); // .claude/forge-runs ITSELF is the junction
    planted = true;
  } catch (e) { /* handled by the skip() below */ }
  if (planted) {
    const { spawnSync: spawnSyncLocal } = require('child_process');
    const fixEnv = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: fixRoot });
    t('RUN-1 round 2, end-to-end: `open-report` with .claude/forge-runs ITSELF replaced by a junction never prints the outside report', () => {
      const r = spawnSyncLocal(process.execPath, [TOOL, 'open-report'], { encoding: 'utf8', timeout: 10000, env: fixEnv });
      assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
      assert.ok(!r.stdout.includes('SECRET CONTENT OUTSIDE forge-runs'), 'the outside report must never be printed: ' + r.stdout);
    });
    t('RUN-1 round 2, end-to-end: `runs` with .claude/forge-runs ITSELF replaced by a junction never lists the outside run', () => {
      const r = spawnSyncLocal(process.execPath, [TOOL, 'runs'], { encoding: 'utf8', timeout: 10000, env: fixEnv });
      assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
      assert.ok(!r.stdout.includes('evil-run'), 'the outside run id must never be listed: ' + r.stdout);
    });
    t('RUN-1 round 2, end-to-end: `status` with .claude/forge-runs ITSELF replaced by a junction reports a refusal, not "(none)" silently', () => {
      const r = spawnSyncLocal(process.execPath, [TOOL, 'status'], { encoding: 'utf8', timeout: 10000, env: fixEnv });
      assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
      assert.ok(/symlink\/junction/.test(r.stdout), 'expected an honest refusal line, got: ' + r.stdout);
    });
  } else {
    skip('RUN-1 round 2, end-to-end junction-at-root CLI tests', 'could not create a junction fixture on this filesystem/account');
  }
  try { fs.rmdirSync(fixForgeBin); } catch { /* best-effort: entry may not exist if planting failed */ }
  try { fs.rmdirSync(fixForgeRuns); } catch { /* best-effort */ }
  fs.rmSync(fixRoot, { recursive: true, force: true });
  fs.rmSync(attackOutside, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------------------
// PRUNE-1 fix (Codex adversarial-review, HIGH, WP-9B-SRC): pruneSynthetic() must refuse ENTIRELY (dry run
// and apply alike) when the runs root itself is a symlink/junction, and must re-verify each candidate's
// identity right before deleting it (never trusting a judgement made moments earlier).
// ---------------------------------------------------------------------------------------------------------
t('pruneSynthetic: refuses ENTIRELY (never lists, never deletes) when .claude/forge-runs itself is a junction', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-prune-root-outside-'));
  const debrisDir = path.join(outside, 'doctor-selfcheck-1');
  fs.mkdirSync(debrisDir, { recursive: true });
  fs.writeFileSync(path.join(debrisDir, 'events.jsonl'), '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n', 'utf8');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-prune-root-'));
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const runsDir = path.join(claudeDir, 'forge-runs');
  try {
    fs.symlinkSync(outside, runsDir, 'junction');
    const rep = S.pruneSynthetic({ runsDir, apply: true });
    assert.strictEqual(rep.refused, true, 'expected pruneSynthetic to refuse outright');
    assert.ok(/symlink\/junction/.test(rep.reason), rep.reason);
    assert.deepStrictEqual(rep.candidates, [], 'a refused run must never even list candidates');
    assert.deepStrictEqual(rep.removed, []);
    assert.ok(fs.existsSync(path.join(debrisDir, 'events.jsonl')), 'the external debris-looking folder must be completely untouched');
  } finally {
    try { fs.rmdirSync(runsDir); } catch { /* best-effort */ }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
t('pruneSynthetic --apply: PRUNE-1 fix — re-verifies identity right before unlink and refuses (never deletes) when it has changed since inspection', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-prune-race-'));
  const runsDir = path.join(tmp, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const dir = mkRun(runsDir, 'doctor-selfcheck-30', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' });
  const realLstatSync = fs.lstatSync;
  let calls = 0;
  // Simulate a local process swapping the FILE for a different one after inspectSyntheticCandidate()
  // already captured its identity: the FIRST lstat of events.jsonl (inside inspectSyntheticCandidate,
  // building the `identity` snapshot) sees the real stat; the SECOND lstat of the SAME path
  // (pruneSynthetic's own re-check right before unlink) is answered with a forged ino, simulating "this
  // is no longer the same file" without needing real concurrency.
  fs.lstatSync = function (p) {
    const st = realLstatSync.call(fs, p);
    if (typeof p === 'string' && p.endsWith('events.jsonl') && !p.endsWith('.lock')) {
      calls++;
      if (calls > 1) return { dev: st.dev, ino: st.ino + 999999, nlink: st.nlink, isSymbolicLink: () => false };
    }
    return st;
  };
  try {
    const rep = S.pruneSynthetic({ runsDir, apply: true });
    assert.strictEqual(rep.removed.length, 0, 'must not have removed anything once identity looked swapped');
    assert.strictEqual(rep.errors.length, 1, JSON.stringify(rep.errors));
    assert.ok(/identity changed/.test(rep.errors[0].error), rep.errors[0].error);
    assert.ok(fs.existsSync(path.join(dir, 'events.jsonl')), 'the file must still exist — the delete must never have happened');
  } finally {
    fs.lstatSync = realLstatSync;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------------------------------------
// STOP-PRUNE-1 fix (Codex stop-time adversarial review, HIGH, WP-9B-SRC round 3): the round-1/round-2
// identity re-check closes "already different at revalidation time" but not a swap that happens AFTER
// that revalidation and BEFORE the actual unlinkSync calls. Fixed with an exclusively-opened ("share mode
// 0") pin file created INSIDE the candidate directory, which the OS itself refuses to let anyone rename
// out from under (measured on this machine: renaming the pinned directory, its parent, or its
// grandparent is refused while the pin stays open) — see pinCandidateDirWindows/verifyPinnedCandidate's
// own doc comments in forge-runinfo.cjs for the full model.
// ---------------------------------------------------------------------------------------------------------
tWin('pinCandidateDirWindows: creates a real, exclusively-held file inside the directory; fstat/lstat agree', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-pin-basic-'));
  try {
    const pin = S.pinCandidateDirWindows(tmp);
    try {
      assert.strictEqual(pin.ok, true, JSON.stringify(pin.error && pin.error.message));
      assert.ok(fs.existsSync(pin.pinPath));
      assert.ok(path.basename(pin.pinPath).startsWith('.forge-prune-pin-'));
      const fstat = fs.fstatSync(pin.fd);
      const lstat = fs.lstatSync(pin.pinPath);
      assert.strictEqual(fstat.dev, lstat.dev);
      assert.strictEqual(fstat.ino, lstat.ino);
    } finally { try { fs.closeSync(pin.fd); } catch { /* best-effort */ } try { fs.unlinkSync(pin.pinPath); } catch { /* best-effort */ } }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
tWin('pinCandidateDirWindows: the OS itself refuses to rename the pinned directory (or its parent/grandparent) while the pin is held — the actual, measured guarantee this fix relies on', () => {
  const grandparent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-pin-rename-'));
  const parent = path.join(grandparent, 'parent');
  const candidate = path.join(parent, 'candidate');
  fs.mkdirSync(candidate, { recursive: true });
  const pin = S.pinCandidateDirWindows(candidate);
  try {
    assert.strictEqual(pin.ok, true);
    let threwOnCandidate = false, threwOnParent = false, threwOnGrandparent = false;
    try { fs.renameSync(candidate, candidate + '-renamed'); } catch { threwOnCandidate = true; }
    try { fs.renameSync(parent, parent + '-renamed'); } catch { threwOnParent = true; }
    try { fs.renameSync(grandparent, grandparent + '-renamed'); } catch { threwOnGrandparent = true; }
    assert.strictEqual(threwOnCandidate, true, 'expected renaming the pinned directory itself to be refused while the pin is open');
    assert.strictEqual(threwOnParent, true, 'expected renaming the pinned directory\'s PARENT to be refused while the pin is open');
    assert.strictEqual(threwOnGrandparent, true, 'expected renaming the pinned directory\'s GRANDPARENT to be refused while the pin is open');
    assert.ok(fs.existsSync(candidate), 'the candidate must still be exactly where it was');
  } finally {
    try { fs.closeSync(pin.fd); } catch { /* best-effort */ }
    try { fs.unlinkSync(pin.pinPath); } catch { /* best-effort */ }
    fs.rmSync(grandparent, { recursive: true, force: true });
  }
});
tWin('pinCandidateDirWindows: once the pin is CLOSED, the rename that was refused a moment ago succeeds — proving the refusal really came from the held pin, not something else', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-pin-release-'));
  const candidate = path.join(tmp, 'candidate');
  fs.mkdirSync(candidate, { recursive: true });
  const pin = S.pinCandidateDirWindows(candidate);
  try {
    assert.strictEqual(pin.ok, true);
    let threwWhilePinned = false;
    try { fs.renameSync(candidate, candidate + '-renamed'); } catch { threwWhilePinned = true; }
    assert.strictEqual(threwWhilePinned, true);
  } finally { try { fs.closeSync(pin.fd); } catch { /* best-effort */ } try { fs.unlinkSync(pin.pinPath); } catch { /* best-effort */ } }
  fs.renameSync(candidate, candidate + '-renamed-after-release'); // must NOT throw now
  assert.ok(fs.existsSync(candidate + '-renamed-after-release'));
  fs.rmSync(tmp, { recursive: true, force: true });
});
tWin('verifyPinnedCandidate: passes when nothing has changed since inspection', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-verifypin-ok-'));
  const runsDir = path.join(tmp, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const dir = mkRun(runsDir, 'doctor-selfcheck-50', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' });
  const verdict = S.inspectSyntheticCandidate(dir, 'doctor-selfcheck-50', runsDir);
  const pin = S.pinCandidateDirWindows(dir);
  try {
    assert.strictEqual(pin.ok, true);
    const v = S.verifyPinnedCandidate(pin, tmp, dir, verdict);
    assert.strictEqual(v.ok, true, v.reason);
  } finally { try { fs.closeSync(pin.fd); } catch { /* best-effort */ } try { fs.unlinkSync(pin.pinPath); } catch { /* best-effort */ } fs.rmSync(tmp, { recursive: true, force: true }); }
});
tWin('verifyPinnedCandidate: refuses when a debris file was replaced (different inode) after inspection but before pinning', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-verifypin-fileswap-'));
  const runsDir = path.join(tmp, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const dir = mkRun(runsDir, 'doctor-selfcheck-51', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' });
  const verdict = S.inspectSyntheticCandidate(dir, 'doctor-selfcheck-51', runsDir);
  fs.unlinkSync(path.join(dir, 'events.jsonl'));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n', 'utf8'); // same CONTENT, different inode
  const pin = S.pinCandidateDirWindows(dir);
  try {
    assert.strictEqual(pin.ok, true);
    const v = S.verifyPinnedCandidate(pin, tmp, dir, verdict);
    assert.strictEqual(v.ok, false);
    assert.ok(/identity changed/.test(v.reason), v.reason);
  } finally { try { fs.closeSync(pin.fd); } catch { /* best-effort */ } try { fs.unlinkSync(pin.pinPath); } catch { /* best-effort */ } fs.rmSync(tmp, { recursive: true, force: true }); }
});

tWin('pruneSynthetic --apply: STOP-PRUNE-1 — a rename+junction-plant attack attempted AFTER pin verification (right before the unlinks) is refused by the OS; the debris is removed for real, the outside victim survives untouched, and no pin file remains', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-stopprune1-attack-'));
  const runsDir = path.join(tmp, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const dir = mkRun(runsDir, 'doctor-selfcheck-60', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' });

  const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-stopprune1-victim-'));
  const victimContent = 'VICTIM CONTENT THAT MUST NEVER BE READ OR TOUCHED';
  fs.writeFileSync(path.join(victimDir, 'events.jsonl'), victimContent, 'utf8');

  let hookCalled = false, renameThrew = false, renameError = null, junctionPlanted = false;
  const opts = {
    runsDir, apply: true,
    __afterPinVerified: (candidateDir) => {
      hookCalled = true;
      const elsewhere = candidateDir + '-renamed-away';
      try {
        fs.renameSync(candidateDir, elsewhere);
        // Only reachable if the pin FAILED to protect us -- complete the attack so the assertions below
        // correctly observe a genuine compromise rather than silently passing on a broken test.
        fs.symlinkSync(victimDir, candidateDir, 'junction');
        junctionPlanted = true;
      } catch (e) { renameThrew = true; renameError = e; }
    },
  };
  const rep = S.pruneSynthetic(opts);
  assert.strictEqual(hookCalled, true, 'the test seam must actually have been called');
  assert.strictEqual(renameThrew, true, 'expected the OS to refuse renaming the candidate directory while the pin is held: ' + (renameError && renameError.message));
  assert.strictEqual(junctionPlanted, false, 'the junction must never have been planted -- the rename it depends on was refused');
  assert.ok(rep.removed.includes('doctor-selfcheck-60'), 'the real debris must still be removed once the attack was refused: ' + JSON.stringify(rep));
  assert.strictEqual(fs.existsSync(dir), false, 'the real candidate directory must be gone (removed for real)');
  assert.strictEqual(fs.readFileSync(path.join(victimDir, 'events.jsonl'), 'utf8'), victimContent, 'the outside victim must survive completely untouched');
  assert.deepStrictEqual(fs.readdirSync(victimDir), ['events.jsonl'], 'no pin file (or anything else) was ever planted in the victim folder');
  assert.strictEqual(fs.existsSync(runsDir) && fs.readdirSync(runsDir).some((n) => n.startsWith('.forge-prune-pin-')), false, 'no pin file left behind anywhere under forge-runs/');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(victimDir, { recursive: true, force: true });
});

tWin('pruneSynthetic --apply: STOP-PRUNE-1 — a swap completed BEFORE pinning (the candidate is already a junction by pin time) fails pin verification, refuses the candidate, and deletes nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-stopprune1-beforepin-'));
  const runsDir = path.join(tmp, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const dir = mkRun(runsDir, 'doctor-selfcheck-61', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' });
  const renamedRealDir = dir + '-renamed-away';

  const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-stopprune1-beforepin-victim-'));
  const victimContent = 'VICTIM CONTENT THAT MUST NEVER BE READ OR TOUCHED';
  fs.writeFileSync(path.join(victimDir, 'events.jsonl'), victimContent, 'utf8');

  let hookCalled = false;
  const opts = {
    runsDir, apply: true,
    // Fires BEFORE the pin is even created -- nothing protects the candidate yet, so this swap succeeds.
    __beforePin: (candidateDir) => {
      hookCalled = true;
      fs.renameSync(candidateDir, renamedRealDir);
      fs.symlinkSync(victimDir, candidateDir, 'junction');
    },
  };
  const rep = S.pruneSynthetic(opts);
  assert.strictEqual(hookCalled, true, 'the test seam must actually have been called');
  assert.strictEqual(rep.removed.length, 0, 'nothing must be reported as removed');
  assert.strictEqual(rep.errors.length, 1, JSON.stringify(rep.errors));
  assert.ok(/no longer resolves|symlink|junction|identity/i.test(rep.errors[0].error), rep.errors[0].error);
  assert.strictEqual(fs.readFileSync(path.join(victimDir, 'events.jsonl'), 'utf8'), victimContent, 'the outside victim must survive untouched');
  assert.ok(fs.existsSync(path.join(renamedRealDir, 'events.jsonl')), 'the REAL renamed-away debris must survive untouched too — nothing was ever deleted');

  try { fs.unlinkSync(path.join(dir, 'events.jsonl')); } catch { /* may have landed in the victim dir instead -- checked separately below */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(victimDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------
// STOP-PRUNE-1, non-Windows fallback (posixChainIsPrivate) — injectable seams (lstatSync/realpathSync/
// getUid) exercise this branch's LOGIC deterministically even on this Windows development machine, since
// there is no real POSIX permission model to test against here.
// ---------------------------------------------------------------------------------------------------------
function fakeStat({ uid, mode }) { return { uid, mode, isDirectory: () => true }; }
// posixChainIsPrivate() walks from path.parse(path.resolve(targetPath)).root down -- on a real POSIX
// deployment that root is '/', but path.resolve()/path.parse() on THIS (Windows) development machine
// resolve a bare-separator path to the CURRENT DRIVE's root (e.g. 'C:\\'), never a literal '\\'. Computing
// ROOT the exact same way the code under test does (rather than assuming path.sep) is what makes these
// fixture path strings actually match what walk() will look up.
const ROOT = path.parse(path.resolve(path.sep)).root;
t('posixChainIsPrivate: a group-writable directory ON THE WAY refuses, even when the target itself is private', () => {
  const OWNER = 1000;
  const stats = new Map([
    [ROOT, fakeStat({ uid: 0, mode: 0o755 })],
    [path.join(ROOT, 'home'), fakeStat({ uid: 0, mode: 0o755 })],
    [path.join(ROOT, 'home', 'shared'), fakeStat({ uid: OWNER, mode: 0o775 })], // group-writable, no sticky bit
    [path.join(ROOT, 'home', 'shared', 'forge-runs'), fakeStat({ uid: OWNER, mode: 0o700 })],
  ]);
  const seams = {
    lstatSync: (p) => { if (!stats.has(p)) throw new Error('ENOENT (test): ' + p); return stats.get(p); },
    realpathSync: (p) => p,
    getUid: () => OWNER,
  };
  const v = S.posixChainIsPrivate(path.join(ROOT, 'home', 'shared', 'forge-runs'), seams);
  assert.strictEqual(v.ok, false);
  assert.ok(/writable by another user/.test(v.reason), v.reason);
});
t('posixChainIsPrivate: a fully private chain (owned by the current user, not group/other-writable) proceeds', () => {
  const OWNER = 1000;
  const stats = new Map([
    [ROOT, fakeStat({ uid: 0, mode: 0o755 })],
    [path.join(ROOT, 'home'), fakeStat({ uid: 0, mode: 0o755 })],
    [path.join(ROOT, 'home', 'me'), fakeStat({ uid: OWNER, mode: 0o700 })],
    [path.join(ROOT, 'home', 'me', 'forge-runs'), fakeStat({ uid: OWNER, mode: 0o700 })],
  ]);
  const seams = {
    lstatSync: (p) => { if (!stats.has(p)) throw new Error('ENOENT (test): ' + p); return stats.get(p); },
    realpathSync: (p) => p,
    getUid: () => OWNER,
  };
  const v = S.posixChainIsPrivate(path.join(ROOT, 'home', 'me', 'forge-runs'), seams);
  assert.strictEqual(v.ok, true, v.reason);
});
t('posixChainIsPrivate: a sticky, world-writable ancestor (the /tmp shape) is fine as long as the NEXT entry down is privately owned', () => {
  const OWNER = 1000;
  const stats = new Map([
    [ROOT, fakeStat({ uid: 0, mode: 0o755 })],
    [path.join(ROOT, 'tmp'), fakeStat({ uid: 0, mode: 0o1777 })], // sticky + world-writable, exactly /tmp
    [path.join(ROOT, 'tmp', 'my-forge-project'), fakeStat({ uid: OWNER, mode: 0o700 })],
    [path.join(ROOT, 'tmp', 'my-forge-project', 'forge-runs'), fakeStat({ uid: OWNER, mode: 0o700 })],
  ]);
  const seams = {
    lstatSync: (p) => { if (!stats.has(p)) throw new Error('ENOENT (test): ' + p); return stats.get(p); },
    realpathSync: (p) => p,
    getUid: () => OWNER,
  };
  const v = S.posixChainIsPrivate(path.join(ROOT, 'tmp', 'my-forge-project', 'forge-runs'), seams);
  assert.strictEqual(v.ok, true, v.reason);
});
t('posixChainIsPrivate: cannot determine the current uid at all -> refuses honestly rather than guessing', () => {
  const v = S.posixChainIsPrivate(path.join(ROOT, 'anything'), { getUid: () => null });
  assert.strictEqual(v.ok, false);
  assert.ok(/cannot determine the current uid/.test(v.reason), v.reason);
});

// --- the SAME three POSIX shapes, end to end through pruneSynthetic() itself (opts.platform + opts.posixSeams) ---
t('pruneSynthetic --apply (opts.platform override): a group-writable ancestor refuses the candidate and deletes nothing, even on this Windows machine', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-posix-groupwritable-'));
  const runsDir = path.join(tmp, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const dir = mkRun(runsDir, 'doctor-selfcheck-70', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' });
  const OWNER = 1000;
  const groupWritableStat = fakeStat({ uid: OWNER, mode: 0o775 }); // group-writable, no sticky bit
  try {
    const rep = S.pruneSynthetic({
      runsDir, apply: true, platform: 'linux',
      posixSeams: { lstatSync: () => groupWritableStat, realpathSync: (p) => p, getUid: () => OWNER },
    });
    assert.strictEqual(rep.removed.length, 0);
    assert.strictEqual(rep.errors.length, 1, JSON.stringify(rep.errors));
    assert.ok(/race-free delete guarantee/.test(rep.errors[0].error), rep.errors[0].error);
    assert.ok(fs.existsSync(path.join(dir, 'events.jsonl')), 'the debris must survive untouched');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
t('pruneSynthetic --apply (opts.platform override): a fully private chain proceeds and really removes the debris, even on this Windows machine', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-posix-private-'));
  const runsDir = path.join(tmp, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const dir = mkRun(runsDir, 'doctor-selfcheck-71', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' });
  const OWNER = 1000;
  const privateStat = fakeStat({ uid: OWNER, mode: 0o700 });
  try {
    const rep = S.pruneSynthetic({
      runsDir, apply: true, platform: 'linux',
      posixSeams: { lstatSync: () => privateStat, realpathSync: (p) => p, getUid: () => OWNER },
    });
    assert.deepStrictEqual(rep.removed, ['doctor-selfcheck-71'], JSON.stringify(rep));
    assert.strictEqual(fs.existsSync(dir), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
t('pruneSynthetic --apply (opts.platform override): a sticky world-writable ancestor with our own entry beneath it proceeds and really removes the debris', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-posix-sticky-'));
  const runsDir = path.join(tmp, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const dir = mkRun(runsDir, 'doctor-selfcheck-72', { events: '{"event_type":"agent_progress","agent":"orchestrator","note":"doctor self-check"}\n' });
  const OWNER = 1000;
  const stickyWorldWritable = fakeStat({ uid: 0, mode: 0o1777 });
  const privateOwned = fakeStat({ uid: OWNER, mode: 0o700 });
  try {
    const rep = S.pruneSynthetic({
      runsDir, apply: true, platform: 'linux',
      posixSeams: {
        // Everything from `tmp` (our own project root) DOWN reads as privately owned; everything ABOVE
        // tmp (its real ancestors on this actual filesystem, e.g. the OS temp directory and the drive
        // root) reads as the sticky, world-writable /tmp shape -- proving the sticky-ancestor-then-
        // private-entry pattern is accepted.
        lstatSync: (p) => ((p === tmp || p.startsWith(tmp + path.sep)) ? privateOwned : stickyWorldWritable),
        realpathSync: (p) => p,
        getUid: () => OWNER,
      },
    });
    assert.deepStrictEqual(rep.removed, ['doctor-selfcheck-72'], JSON.stringify(rep));
    assert.strictEqual(fs.existsSync(dir), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

t('pathChainIsReal: a FILESYSTEM ROOT as the anchor still accepts a real file below it (the root already ends with a separator)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-fsroot-'));
  try {
    const f = path.join(tmp, 'x.txt');
    fs.writeFileSync(f, 'x');
    const fsRoot = path.parse(tmp).root;
    // Only meaningful when the temp chain itself is real (macOS /tmp is a symlink, for example).
    if (fs.realpathSync(tmp) === path.resolve(tmp)) {
      assert.strictEqual(S.pathChainIsReal(fsRoot, f), true, 'a real file under the filesystem root must pass from root ' + fsRoot);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

t('statIdentity/identityMatches: the SAME file lstat-ed twice matches; a replaced file (new inode) does not', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-identity-'));
  const p = path.join(tmp, 'a.txt');
  try {
    fs.writeFileSync(p, 'x');
    const s1 = S.statIdentity(fs.lstatSync(p));
    const s2 = S.statIdentity(fs.lstatSync(p));
    assert.strictEqual(S.identityMatches(s1, s2), true);
    // Linux CI 2026-09-29: unlink-then-recreate may get the SAME inode back on Linux; writing the replacement first
    // and renaming it over the original guarantees a different file (both existed at once).
    fs.writeFileSync(p + '.new', 'replaced');
    fs.renameSync(p + '.new', p);
    const s3 = S.statIdentity(fs.lstatSync(p));
    assert.strictEqual(S.identityMatches(s1, s3), false, 'expected a different inode after unlink+recreate (if this ever fails, the OS reused the exact same file id — not a defect in identityMatches itself)');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// listRunIds()/latestRunId() — live-project assertions (this tool refuses a fixture root — same isolation
// guard the retired server.cjs had; see detectProjectRoot()).
// ---------------------------------------------------------------------------------------------------------
t('live project: the newest run reported to /forge status is NOT a synthetic demo', () => {
  const ids = S.listRunIds();
  if (ids.length === 0) {
    const runsDir = path.join(__dirname, '..', 'forge-runs');
    let runShaped = [];
    try {
      runShaped = fs.readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '_toollog')
        .filter((e) => fs.existsSync(path.join(runsDir, e.name, 'events.jsonl')));
    } catch { /* no forge-runs dir: genuinely fresh */ }
    assert.strictEqual(runShaped.length, 0,
      'listRunIds() returned [] but ' + runShaped.length + ' run-shaped dir(s) exist on disk — the selector regressed, this is not a fresh install');
    return;
  }
  const first = S.classifyRunDir(path.join(__dirname, '..', 'forge-runs', ids[0]), ids[0]);
  assert.strictEqual(first.synthetic, false, 'ids[0] is a synthetic run: ' + ids[0]);
  assert.ok(!ids.includes('_toollog') && !ids.includes('.hotspot-locks'), 'operational dirs still listed as runs');
});
t('live project: latestRunId() and the listing agree — one selector, never a second opinion', () => {
  const id = S.latestRunId();
  if (id === null) { assert.ok(true, 'no eligible real run — honest null rather than presenting a demo'); return; }
  const c = S.classifyRunDir(path.join(__dirname, '..', 'forge-runs', id), id);
  assert.strictEqual(c.synthetic, false, 'latestRunId returned a synthetic run: ' + id);
  assert.strictEqual(!!c.malformed, false, 'latestRunId returned a run with unreadable metadata: ' + id);
  assert.strictEqual(id, S.listRunIds()[0], 'latestRunId disagrees with the listing it is supposed to share');
});

// ---------------------------------------------------------------------------------------------------------
// readRun() — run-id allowlist + path containment (item 1's "reused, not reinvented" requirement)
// ---------------------------------------------------------------------------------------------------------
t('readRun: a traversal id is rejected before touching the filesystem', () => {
  assert.strictEqual(S.readRun('../evil'), null);
  assert.strictEqual(S.readRun('..\\evil'), null);
});
t('readRun: a path-separator id is rejected', () => {
  assert.strictEqual(S.readRun('a/b'), null);
  assert.strictEqual(S.readRun('a\\b'), null);
});
t('readRun: a nonexistent (but well-formed) id returns null, not a throw', () => {
  assert.strictEqual(S.readRun('this-run-id-does-not-exist-xyz'), null);
});
t('live project: readRun() on the real latest run returns a shape with run/events/report/malformed', () => {
  const id = S.latestRunId();
  if (id === null) { assert.ok(true, 'no eligible real run to read'); return; }
  const r = S.readRun(id);
  assert.ok(r && typeof r === 'object', 'readRun returned nothing for a run listRunIds() itself reported');
  assert.ok(Array.isArray(r.events), 'events must be an array');
  assert.strictEqual(typeof r.malformed, 'number');
  assert.strictEqual(r.run.run_id, id);
});

// ---------------------------------------------------------------------------------------------------------
// RUN-1 fix (Codex adversarial-review finding, HIGH, WP-Q2 2026-09-27): the OLD containment check in
// readRun() was lexical (path.resolve on the id text) while safeRead()/fs.statSync FOLLOW a symlink or
// Windows junction — a run directory (or one of its own run.json/events.jsonl/final-report.md files)
// that is ITSELF a symlink/junction pointing outside forge-runs/ passed the old check and was then read
// and printed verbatim (e.g. by `open-report`). isSymlinkEntry/realContainmentOk/safeReadContained are
// pure and exported specifically so this is covered hermetically, with a REAL junction fixture — no
// mocking of fs internals. Windows junctions need no elevated privilege (fs.symlinkSync(..., 'junction')
// works for a normal user); a FILE symlink does on this OS and is skipped, out loud, when denied.
// ---------------------------------------------------------------------------------------------------------
const RG1_OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run1-outside-'));
fs.writeFileSync(path.join(RG1_OUTSIDE, 'secret.txt'), 'CONTENT THAT MUST NEVER BE READ THROUGH forge-runs/');
const RG1_RUNS = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run1-runs-'));
const RG1_JUNCTION = path.join(RG1_RUNS, 'evil-run');
fs.symlinkSync(RG1_OUTSIDE, RG1_JUNCTION, 'junction');
const RG1_REAL_DIR = path.join(RG1_RUNS, 'real-run');
fs.mkdirSync(RG1_REAL_DIR, { recursive: true });
fs.writeFileSync(path.join(RG1_REAL_DIR, 'run.json'), JSON.stringify({ run_id: 'real-run' }), 'utf8');

t('isSymlinkEntry: a real junction is reported as a symlink entry', () => {
  assert.strictEqual(S.isSymlinkEntry(RG1_JUNCTION), true);
});
t('isSymlinkEntry: an ordinary real directory is not a symlink entry', () => {
  assert.strictEqual(S.isSymlinkEntry(RG1_REAL_DIR), false);
});
t('isSymlinkEntry: a nonexistent path is false, never a throw', () => {
  assert.strictEqual(S.isSymlinkEntry(path.join(RG1_RUNS, 'does-not-exist')), false);
});
t('realContainmentOk: a junction pointing OUTSIDE the base dir fails containment (real-path aware, not lexical)', () => {
  // The lexical text of RG1_JUNCTION ("<runs>/evil-run") looks contained under RG1_RUNS -- only a
  // REAL, symlink-resolving check can tell it actually points at RG1_OUTSIDE.
  assert.strictEqual(S.realContainmentOk(RG1_RUNS, RG1_JUNCTION), false);
});
t('realContainmentOk: an ordinary real subdirectory passes containment', () => {
  assert.strictEqual(S.realContainmentOk(RG1_RUNS, RG1_REAL_DIR), true);
});
t('realContainmentOk: a genuinely unrelated real directory fails containment', () => {
  assert.strictEqual(S.realContainmentOk(RG1_RUNS, RG1_OUTSIDE), false);
});
t('safeReadContained: refuses a symlinked/junction path outright and never returns its content', () => {
  const r = S.safeReadContained(path.join(RG1_JUNCTION, 'secret.txt'), RG1_RUNS);
  // the path itself (RG1_JUNCTION/secret.txt) is not a symlink, but its real location escapes RG1_RUNS
  // once the junction ancestor is resolved -- realContainmentOk catches this even when the immediate
  // entry is an ordinary file.
  assert.strictEqual(r.escaped, true);
  assert.strictEqual(r.text, null);
  assert.ok(/refusing to read/.test(r.reason), 'expected a plain refusal reason, got: ' + r.reason);
});
t('safeReadContained: an ordinary contained file is read normally', () => {
  const r = S.safeReadContained(path.join(RG1_REAL_DIR, 'run.json'), RG1_RUNS);
  assert.strictEqual(r.escaped, false);
  assert.ok(/real-run/.test(r.text));
});
t('safeReadContained: a genuinely absent file is null/not-escaped (the common, honest case)', () => {
  const r = S.safeReadContained(path.join(RG1_REAL_DIR, 'final-report.md'), RG1_RUNS);
  assert.strictEqual(r.escaped, false);
  assert.strictEqual(r.text, null);
});
t('classifyRunDir: a symlinked/junction "run directory" is never treated as a run at all', () => {
  // Even though RG1_JUNCTION's target (RG1_OUTSIDE) has no run.json/events.jsonl, plant one there too --
  // proves the rejection is the symlink check itself, not merely "the target happens to lack run shape".
  fs.writeFileSync(path.join(RG1_OUTSIDE, 'run.json'), JSON.stringify({ run_id: 'evil-run' }), 'utf8');
  const c = S.classifyRunDir(RG1_JUNCTION, 'evil-run');
  assert.strictEqual(c.isRun, false, 'a junction must never classify as a real run, even if its target looks run-shaped');
});

let rg1FileLinkPath = null;
try {
  rg1FileLinkPath = path.join(RG1_RUNS, 'linked-report.md');
  fs.symlinkSync(path.join(RG1_OUTSIDE, 'secret.txt'), rg1FileLinkPath, 'file');
  t('safeReadContained: a real FILE symlink is refused the same way a junction is', () => {
    const r = S.safeReadContained(rg1FileLinkPath, RG1_RUNS);
    assert.strictEqual(r.escaped, true);
    assert.strictEqual(r.text, null);
  });
} catch (e) {
  skip('safeReadContained: a real FILE symlink is refused the same way a junction is',
    'this OS user account cannot create a file symlink (' + e.message + ') — the junction-based directory case above already covers the same isSymlinkEntry/realContainmentOk mechanism');
  rg1FileLinkPath = null;
}

// readRun() itself closes over this tool's OWN live RUNS_DIR (S.RUNS_DIR) and — same isolation guard
// as every other readRun/listRunIds/latestRunId test in this file — refuses redirection to a fixture.
// To test readRun()'s real, wired-in behavior (not just the pure helpers above) a junction is planted
// TEMPORARILY inside the real, live forge-runs/ directory, exercised, and removed in `finally` via
// fs.rmdirSync (non-recursive — proven above in this WP's own scratch verification to remove only the
// reparse point itself, never anything under the real target it pointed at).
const RG1_LIVE_ID = 'wpq2-run1-symlink-test-' + process.pid + '-' + Date.now();
const RG1_LIVE_JUNCTION = path.join(S.RUNS_DIR, RG1_LIVE_ID);
let rg1LivePlanted = false;
try {
  fs.mkdirSync(S.RUNS_DIR, { recursive: true });
  fs.symlinkSync(RG1_OUTSIDE, RG1_LIVE_JUNCTION, 'junction');
  rg1LivePlanted = true;
} catch (e) { /* handled by the skip() below */ }
if (rg1LivePlanted) {
  t('readRun(): a symlinked/junction run directory planted in the REAL forge-runs/ is refused, not read', () => {
    const r = S.readRun(RG1_LIVE_ID);
    assert.ok(r && r.escaped === true, 'expected an escaped result, got: ' + JSON.stringify(r));
    assert.ok(/symlink\/junction/.test(r.reason), 'expected a symlink/junction reason, got: ' + r.reason);
    assert.deepStrictEqual(r.events, []);
    assert.strictEqual(r.report, null);
  });
  t('readRun(): an escaped run never appears as eligible for "latest" via listRunIds/latestRunId', () => {
    // The planted junction's dirent is not a directory by Windows' own reparse-point semantics, so it
    // is already excluded by listRunIds()'s dirent filter -- this asserts that observed fact rather
    // than assuming it, so a future platform/Node change that broke it would be caught here too.
    assert.ok(!S.listRunIds().includes(RG1_LIVE_ID), 'a symlinked run directory must never be listed as a real run');
  });
  removeLink(RG1_LIVE_JUNCTION);
} else {
  skip('readRun(): a symlinked/junction run directory planted in the REAL forge-runs/ is refused, not read',
    'could not plant a junction under the real ' + S.RUNS_DIR + ' (permission or filesystem restriction) — the hermetic classifyRunDir/safeReadContained tests above already cover the same mechanism');
}

// ---------------------------------------------------------------------------------------------------------
// commandCenterStartHint(root) — honest per-project branching
// ---------------------------------------------------------------------------------------------------------
t('commandCenterStartHint: no local command-center/ -> points at the `forge dashboard` wrapper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-hint-none-'));
  const hint = S.commandCenterStartHint(root);
  assert.ok(/forge dashboard/.test(hint), 'expected the wrapper command, got: ' + hint);
  assert.ok(!/gateway\/bin\.mjs/.test(hint), 'must not claim a local gateway that does not exist: ' + hint);
});
t('commandCenterStartHint: a local command-center/gateway/bin.mjs -> gives the exact direct command', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-hint-local-'));
  fs.mkdirSync(path.join(root, 'command-center', 'gateway'), { recursive: true });
  fs.writeFileSync(path.join(root, 'command-center', 'gateway', 'bin.mjs'), '// stub\n');
  const hint = S.commandCenterStartHint(root);
  assert.ok(/node command-center\/gateway\/bin\.mjs/.test(hint), 'expected the direct command, got: ' + hint);
});

// ---------------------------------------------------------------------------------------------------------
// checkCommandCenterHealth(url, timeoutMs) — real ephemeral local server (reachable) + a real unused
// port (unreachable) — both deterministic on 127.0.0.1, no dependency on anything actually running.
// ---------------------------------------------------------------------------------------------------------
async function run() {
  await tAsync('checkCommandCenterHealth: a real /api/health responder is reported ok:true with its body parsed', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dashboard: 'Forge Command Center (test stub)' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const health = await S.checkCommandCenterHealth('http://127.0.0.1:' + port, S.HEALTH_TIMEOUT_MS);
      assert.strictEqual(health.ok, true, JSON.stringify(health));
      assert.strictEqual(health.status, 200);
      assert.strictEqual(health.body && health.body.dashboard, 'Forge Command Center (test stub)');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  await tAsync('checkCommandCenterHealth: nothing listening -> ok:false with a real error, quickly (no hang)', async () => {
    // Bind a server, read its port, then close it immediately -- that exact port is very likely free
    // again and guaranteed to have nothing listening, without hardcoding a port number that could clash.
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const freePort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const started = Date.now();
    const health = await S.checkCommandCenterHealth('http://127.0.0.1:' + freePort, 1500);
    const elapsedMs = Date.now() - started;
    assert.strictEqual(health.ok, false);
    assert.ok(typeof health.error === 'string' && health.error.length > 0, 'expected a real error string');
    assert.ok(elapsedMs < 1500, 'must fail fast on a refused connection, not wait out the full timeout (' + elapsedMs + 'ms)');
  });

  await tAsync('checkCommandCenterHealth: a non-responding socket honestly times out (never hangs the CLI)', async () => {
    // A server that accepts the connection but never writes a response exercises the timeout path
    // specifically (distinct from ECONNREFUSED above).
    const stall = http.createServer(() => { /* deliberately never respond */ });
    await new Promise((resolve) => stall.listen(0, '127.0.0.1', resolve));
    const port = stall.address().port;
    try {
      const health = await S.checkCommandCenterHealth('http://127.0.0.1:' + port, 300);
      assert.strictEqual(health.ok, false);
      assert.ok(/timeout/.test(health.error), 'expected a timeout error, got: ' + health.error);
    } finally { await new Promise((resolve) => stall.close(resolve)); }
  });

  // -------------------------------------------------------------------------------------------------------
  // LAUNCH-1 fix (Codex adversarial-review finding, LOW, WP-Q2 2026-09-27): checkCommandCenterHealth()
  // above reports ok:true for ANY successful HTTP response — that alone is exactly the bug ("forge
  // status" used to print "(running)" for a 404 or any unrelated server on the port). cmdStatus() now
  // additionally requires looksLikeCommandCenterHealth(health.body); these tests exercise that
  // combination end-to-end against real ephemeral servers, mirroring forge-cc-launch.test.cjs's own
  // isAlreadyRunning coverage for the exact same shape check.
  // -------------------------------------------------------------------------------------------------------
  const REAL_HEALTH_BODY = {
    ok: true, runtime: { state: 'OK' }, gateway: { version: '0.1.0', uptime_s: 5, project_root: 'C:\\fake' },
  };
  t('looksLikeCommandCenterHealth: the real gateway health shape matches', () => {
    assert.strictEqual(S.looksLikeCommandCenterHealth(REAL_HEALTH_BODY), true);
  });
  t('looksLikeCommandCenterHealth: null/non-object/array bodies never match', () => {
    assert.strictEqual(S.looksLikeCommandCenterHealth(null), false);
    assert.strictEqual(S.looksLikeCommandCenterHealth([1, 2]), false);
    assert.strictEqual(S.looksLikeCommandCenterHealth('x'), false);
  });
  t('looksLikeCommandCenterHealth: a plausible but different JSON body does not match', () => {
    assert.strictEqual(S.looksLikeCommandCenterHealth({ ok: true, status: 'healthy', service: 'other-app' }), false);
  });
  await tAsync('LAUNCH-1 integration: a real /api/health with the true Command Center shape -> health.ok AND looksLikeCommandCenterHealth both true ("running")', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(REAL_HEALTH_BODY));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const health = await S.checkCommandCenterHealth('http://127.0.0.1:' + port, S.HEALTH_TIMEOUT_MS);
      assert.strictEqual(health.ok, true, JSON.stringify(health));
      assert.strictEqual(S.looksLikeCommandCenterHealth(health.body), true, 'expected the real shape to match');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
  // LAUNCH-1's exact reported bug, reproduced against forge-runinfo's own health check: a plain 404
  // used to make `forge status` print "(running)" for whatever answered — health.ok is still true (it
  // DID answer), but looksLikeCommandCenterHealth must now be false, which is what cmdStatus() uses to
  // print "(port conflict ...)" instead of "(running)".
  await tAsync('LAUNCH-1 integration: a real 404 answers (health.ok=true) but does NOT look like the Command Center -> cmdStatus reports a conflict, not "running"', async () => {
    const server = http.createServer((req, res) => { res.writeHead(404); res.end('not found'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const health = await S.checkCommandCenterHealth('http://127.0.0.1:' + port, S.HEALTH_TIMEOUT_MS);
      assert.strictEqual(health.ok, true, 'the HTTP request itself did complete: ' + JSON.stringify(health));
      assert.strictEqual(S.looksLikeCommandCenterHealth(health.body), false, 'a 404 must never look like the real gateway');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
  await tAsync('LAUNCH-1 integration: a real non-Command-Center JSON body answers -> health.ok=true but looksLikeCommandCenterHealth=false', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'healthy', service: 'totally-unrelated-app' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const health = await S.checkCommandCenterHealth('http://127.0.0.1:' + port, S.HEALTH_TIMEOUT_MS);
      assert.strictEqual(health.ok, true);
      assert.strictEqual(S.looksLikeCommandCenterHealth(health.body), false);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });

  // -------------------------------------------------------------------------------------------------------
  // CLI smoke test — spawn the real process for real (status/runs/open-report), against the real project
  // (this tool refuses FORGE_PROJECT_ROOT redirection to a fixture, same as the retired server.cjs did).
  // -------------------------------------------------------------------------------------------------------
  const { spawnSync } = require('child_process');
  await tAsync('CLI: `status` runs for real, exits 0, and prints the Command Center line', async () => {
    const r = spawnSync(process.execPath, [TOOL, 'status'], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
    assert.ok(/Command Center/.test(r.stdout), 'expected a Command Center line, got: ' + r.stdout);
    assert.ok(/memory files/.test(r.stdout), 'expected a memory files checklist, got: ' + r.stdout);
  });
  await tAsync('CLI: `runs` runs for real and exits 0', async () => {
    const r = spawnSync(process.execPath, [TOOL, 'runs'], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  });
  await tAsync('CLI: `open-report` runs for real and exits 0', async () => {
    const r = spawnSync(process.execPath, [TOOL, 'open-report'], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  });
  await tAsync('CLI: no subcommand prints help and exits 0 (never an error for a bare invocation)', async () => {
    const r = spawnSync(process.execPath, [TOOL], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
    assert.ok(/usage/i.test(r.stdout), 'expected usage text, got: ' + r.stdout);
  });
  // WP-CC0: the CLI smoke test intentionally covers ONLY the dry run (read-only) against the real
  // project — never `--apply` here. pruneSynthetic()'s own destructive behavior is already proven
  // above against disposable os.mkdtemp fixtures via the runsDir override; running --apply through the
  // real CLI would act on this actual project's real forge-runs/, which a test must never do.
  await tAsync('CLI: `prune-synthetic` (dry run) runs for real against the real project and exits 0, deleting nothing', async () => {
    const before = fs.existsSync(S.RUNS_DIR) ? fs.readdirSync(S.RUNS_DIR).sort() : null;
    const r = spawnSync(process.execPath, [TOOL, 'prune-synthetic'], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
    assert.ok(/No synthetic-tool debris found|DRY RUN/.test(r.stdout), 'expected dry-run wording, got: ' + r.stdout);
    assert.ok(!/\bREMOVED\b/.test(r.stdout), 'a dry run must never print REMOVED');
    const after = fs.existsSync(S.RUNS_DIR) ? fs.readdirSync(S.RUNS_DIR).sort() : null;
    assert.deepStrictEqual(after, before, 'a dry run must leave the real forge-runs/ directory listing unchanged');
  });
  await tAsync('CLI: `prune-synthetic --apply` against the real project still deletes nothing when there is no reserved-name debris present', async () => {
    const before = fs.existsSync(S.RUNS_DIR) ? fs.readdirSync(S.RUNS_DIR).sort() : null;
    const hasRealDebris = (before || []).some((n) => S.isReservedSyntheticRunId(n));
    if (hasRealDebris) { skip('CLI: `prune-synthetic --apply` real-project no-op check', 'this project currently has real reserved-name debris on disk — skipping to avoid ever deleting it from a test run'); return; }
    const r = spawnSync(process.execPath, [TOOL, 'prune-synthetic', '--apply'], { encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
    const after = fs.existsSync(S.RUNS_DIR) ? fs.readdirSync(S.RUNS_DIR).sort() : null;
    assert.deepStrictEqual(after, before, 'with no reserved-name candidates present, --apply must be a true no-op on the real project');
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  process.exitCode = fail ? 1 : 0;
}

run();

// RUN-1, Codex verification (2026-09-28): a swap of `forge-runs` for a junction AFTER readRun's own root
// check but BEFORE safeReadContained runs made the outside file look contained (containment was computed
// against the already-redirected base). The post-open chain check from the project root catches it; a hard
// link planted inside the project is refused too.
{
  const RV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run1v-root-'));
  const RV_RUNS = path.join(RV_ROOT, '.claude', 'forge-runs');
  fs.mkdirSync(path.join(RV_RUNS, 'r1'), { recursive: true });
  fs.writeFileSync(path.join(RV_RUNS, 'r1', 'final-report.md'), 'THE REAL IN-PROJECT REPORT');
  const RV_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runinfo-run1v-out-'));
  fs.mkdirSync(path.join(RV_OUT, 'r1'), { recursive: true });
  fs.writeFileSync(path.join(RV_OUT, 'r1', 'final-report.md'), 'SECRET FROM OUTSIDE THE PROJECT');
  t('safeReadContained (RUN-1 verification): forge-runs swapped for a junction before the read is refused, the outside content never returned', () => {
    fs.renameSync(RV_RUNS, RV_RUNS + '-moved-away');
    fs.symlinkSync(RV_OUT, RV_RUNS, 'junction');
    try {
      const r = S.safeReadContained(path.join(RV_RUNS, 'r1', 'final-report.md'), RV_RUNS);
      assert.strictEqual(r.text, null, 'the outside file must never be read');
      assert.strictEqual(r.escaped, true);
      assert.ok(/refusing to read/.test(r.reason), r.reason);
    } finally {
      removeLink(RV_RUNS);
      fs.renameSync(RV_RUNS + '-moved-away', RV_RUNS);
    }
  });
  t('safeReadContained (RUN-1 verification): the same layout, not swapped, still reads normally', () => {
    const r = S.safeReadContained(path.join(RV_RUNS, 'r1', 'final-report.md'), RV_RUNS);
    assert.strictEqual(r.escaped, false);
    assert.strictEqual(r.text, 'THE REAL IN-PROJECT REPORT');
  });
  t('safeReadContained (RUN-1 verification): a hard link inside the project to an outside file is refused', () => {
    fs.mkdirSync(path.join(RV_RUNS, 'r2'), { recursive: true });
    const linked = path.join(RV_RUNS, 'r2', 'final-report.md');
    try { fs.linkSync(path.join(RV_OUT, 'r1', 'final-report.md'), linked); } catch (e) { console.log('  (skipped: hard links not allowed here: ' + e.code + ')'); return; }
    const r = S.safeReadContained(linked, RV_RUNS);
    assert.strictEqual(r.text, null);
    assert.strictEqual(r.escaped, true);
    assert.ok(/hard link/.test(r.reason), r.reason);
  });
}
