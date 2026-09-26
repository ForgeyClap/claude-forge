#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-manifest.cjs (WAVE D / D1, 2026-07-18). EVERY fixture lives under a fresh
 * os.tmpdir() directory (see freshDir()) passed as opts.root / --run-dir-equivalent — this file NEVER
 * touches this repo's real .claude/forge-runs/. Exit 0 = all pass.
 *
 * Section map:
 *   1) arm() validation + happy path (write, shape, atomic file present)
 *   2) arm() rejects: missing run_id, empty wps, duplicate wp_id, missing wp_id/agent/narrowed_prompt
 *   3) load() throws on: no manifest ever armed, malformed JSON, non-array content, malformed record
 *   4) reconcile() — 2 of 4 WPs logged wp_completed => exactly those 2 "done", other 2 stay "armed"
 *      (never fabricated) — the CORE honesty invariant this whole piece exists to prove
 *   5) reconcile() — a WP with NO event at all stays "armed"/unfinished
 *   6) reconcile() — a WP with a wp_failed event => "failed", and IS resumable
 *   7) reconcile() — out-of-nothing: empty/missing events.jsonl => ALL WPs stay unfinished
 *   8) reconcile() — a disproven check_passed event (_forge_verify.proof_verified:false) does NOT flip
 *      status to done (content-oracle honesty guard)
 *   9) reconcile() — last-event-wins: a wp_failed followed later by a wp_completed for the SAME wp_id
 *      flips status to "done" (a real retry within one run)
 *   10) reconcile() persists the projected manifest back to disk (status() reflects it without re-scan)
 *   11) real spawned CLI tests: arm/reconcile/status subcommands, exit codes 0/2/3, --json output
 *   12) MUTATION-VERIFY projectManifest()/reconcile() — see bottom of file for the live mutation proof
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mf = require('./forge-manifest.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeEvents(root, runId, events) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf8');
}
function manifestFile(root, runId) { return path.join(root, '.claude', 'forge-runs', runId, 'manifest.json'); }

const CLI = path.join(__dirname, 'forge-manifest.cjs');
function runCLI(argv, env) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: env || process.env }); }

const fourWps = () => ([
  { wp_id: 'wp1', agent: 'Build Boss', narrowed_prompt: 'build the login form' },
  { wp_id: 'wp2', agent: 'Build Boss', narrowed_prompt: 'build the signup form' },
  { wp_id: 'wp3', agent: 'Test Boss', narrowed_prompt: 'write login tests' },
  { wp_id: 'wp4', agent: 'UI Boss', narrowed_prompt: 'style the auth pages' },
]);

console.log('1) arm() happy path — writes manifest.json, shape correct');
{
  const root = freshDir('mf-arm');
  const r = mf.arm({ run_id: 'run-a', wps: fourWps() }, { root });
  t('arm returns ok:true', r.ok === true);
  t('arm returns the manifest path', r.path === manifestFile(root, 'run-a'));
  t('arm writes exactly 4 WP records', r.manifest.length === 4);
  t('every WP starts status "armed"', r.manifest.every((w) => w.status === 'armed'));
  t('every WP starts last_proof null', r.manifest.every((w) => w.last_proof === null));
  t('every WP carries its narrowed_prompt', r.manifest[0].narrowed_prompt === 'build the login form');
  t('deps defaults to an empty array when absent', Array.isArray(r.manifest[0].deps) && r.manifest[0].deps.length === 0);
  t('manifest.json really exists on disk', fs.existsSync(manifestFile(root, 'run-a')));
  const onDisk = JSON.parse(fs.readFileSync(manifestFile(root, 'run-a'), 'utf8'));
  t('the on-disk file is a plain JSON array of WP records', Array.isArray(onDisk) && onDisk.length === 4 && onDisk[0].wp_id === 'wp1');
}

console.log('2) arm() rejects bad input — nothing written on failure');
{
  const root = freshDir('mf-arm-bad');
  const r1 = mf.arm({ wps: fourWps() }, { root }); // missing run_id
  t('missing run_id -> ok:false invalid_run_id', r1.ok === false && r1.reason === 'invalid_run_id');
  const r2 = mf.arm({ run_id: 'run-b', wps: [] }, { root }); // empty wps
  t('empty wps -> ok:false wps_must_be_non_empty_array', r2.ok === false && r2.reason === 'wps_must_be_non_empty_array');
  const r3 = mf.arm({ run_id: 'run-b', wps: [{ wp_id: 'x', agent: 'Build Boss', narrowed_prompt: 'a' }, { wp_id: 'x', agent: 'Build Boss', narrowed_prompt: 'b' }] }, { root });
  t('duplicate wp_id -> ok:false validation_error', r3.ok === false && r3.reason === 'validation_error' && /duplicate wp_id/.test(r3.errors.join(';')));
  const r4 = mf.arm({ run_id: 'run-b', wps: [{ agent: 'Build Boss', narrowed_prompt: 'a' }] }, { root }); // missing wp_id
  t('missing wp_id -> ok:false validation_error', r4.ok === false && /wp_id must be/.test(r4.errors.join(';')));
  const r5 = mf.arm({ run_id: 'run-b', wps: [{ wp_id: 'x', narrowed_prompt: 'a' }] }, { root }); // missing agent
  t('missing agent -> ok:false validation_error', r5.ok === false && /agent must be/.test(r5.errors.join(';')));
  const r6 = mf.arm({ run_id: 'run-b', wps: [{ wp_id: 'x', agent: 'Build Boss' }] }, { root }); // missing narrowed_prompt
  t('missing narrowed_prompt -> ok:false validation_error', r6.ok === false && /narrowed_prompt must be/.test(r6.errors.join(';')));
  t('nothing was written to disk after any failed arm() call', !fs.existsSync(manifestFile(root, 'run-b')));
  const r7 = mf.arm({ run_id: 'bad run id!', wps: fourWps() }, { root }); // invalid run_id shape
  t('run_id with disallowed characters -> ok:false invalid_run_id', r7.ok === false && r7.reason === 'invalid_run_id');
}

console.log('3) load() throws honestly — never a half-trusted guess');
{
  const root = freshDir('mf-load');
  t('load() throws when no manifest was ever armed for this run', (() => { try { mf.load('never-armed', { root }); return false; } catch (e) { return /no manifest found/.test(e.message); } })());
  const dir = path.join(root, '.claude', 'forge-runs', 'malformed-run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not valid json', 'utf8');
  t('load() throws on invalid JSON manifest', (() => { try { mf.load('malformed-run', { root }); return false; } catch (e) { return /not valid JSON/.test(e.message); } })());
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ wp_id: 'not-an-array' }), 'utf8');
  t('load() throws when manifest.json is not a JSON array', (() => { try { mf.load('malformed-run', { root }); return false; } catch (e) { return /must be a JSON array/.test(e.message); } })());
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify([{ agent: 'x' }]), 'utf8'); // record missing wp_id
  t('load() throws on a malformed WP record (missing wp_id)', (() => { try { mf.load('malformed-run', { root }); return false; } catch (e) { return /malformed WP record/.test(e.message); } })());
  t('reconcile() propagates the same load() throw for a malformed manifest', (() => { try { mf.reconcile({ run_id: 'malformed-run' }, { root }); return false; } catch (e) { return /malformed WP record/.test(e.message); } })());
}

console.log('4) reconcile() CORE HONESTY: exactly the logged-done WPs become done, others stay armed');
{
  const root = freshDir('mf-core');
  mf.arm({ run_id: 'run-core', wps: fourWps() }, { root });
  writeEvents(root, 'run-core', [
    { event_type: 'agent_started', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-18T10:00:00Z' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-18T10:05:00Z' },
    { event_type: 'check_passed', agent: 'Test Boss', wp_id: 'wp2', command: 'npm test', exit_code: 0, timestamp: '2026-07-18T10:06:00Z' },
    { event_type: 'agent_note', agent: 'UI Boss', wp_id: 'wp4', note: 'still working', timestamp: '2026-07-18T10:07:00Z' },
  ]);
  const r = mf.reconcile({ run_id: 'run-core' }, { root });
  const byId = Object.fromEntries(r.manifest.map((w) => [w.wp_id, w]));
  t('wp1 (wp_completed) -> done', byId.wp1.status === 'done');
  t('wp2 (check_passed with wp_id) -> done', byId.wp2.status === 'done');
  t('wp3 (no event at all) stays armed — never fabricated', byId.wp3.status === 'armed');
  t('wp4 (only an unrelated agent_note event) stays armed — never fabricated', byId.wp4.status === 'armed');
  t('exactly 2 of 4 are done', r.done.length === 2 && r.done.map((w) => w.wp_id).sort().join(',') === 'wp1,wp2');
  t('exactly 2 of 4 are unfinished', r.unfinished.length === 2 && r.unfinished.map((w) => w.wp_id).sort().join(',') === 'wp3,wp4');
  t('resumable is true (unfinished work remains)', r.resumable === true);
  t('wp1 last_proof records the winning event', byId.wp1.last_proof && byId.wp1.last_proof.event_type === 'wp_completed');
}

console.log('5) reconcile() — a WP with NO event at all always stays unfinished, isolated case');
{
  const root = freshDir('mf-noevent');
  mf.arm({ run_id: 'run-noevent', wps: [{ wp_id: 'solo', agent: 'Build Boss', narrowed_prompt: 'do the thing' }] }, { root });
  writeEvents(root, 'run-noevent', [{ event_type: 'agent_note', agent: 'Build Boss', note: 'thinking', timestamp: '2026-07-18T10:00:00Z' }]);
  const r = mf.reconcile({ run_id: 'run-noevent' }, { root });
  t('a WP with zero matching events stays armed', r.manifest[0].status === 'armed');
  t('resumable is true', r.resumable === true);
}

console.log('6) reconcile() — wp_failed => failed, and is resumable (not silently dropped)');
{
  const root = freshDir('mf-failed');
  mf.arm({ run_id: 'run-failed', wps: [{ wp_id: 'wpF', agent: 'Build Boss', narrowed_prompt: 'risky change' }] }, { root });
  writeEvents(root, 'run-failed', [{ event_type: 'wp_failed', agent: 'Build Boss', wp_id: 'wpF', timestamp: '2026-07-18T10:00:00Z' }]);
  const r = mf.reconcile({ run_id: 'run-failed' }, { root });
  t('a WP with a logged wp_failed event -> status failed', r.manifest[0].status === 'failed');
  t('a failed WP is counted in "failed"', r.failed.length === 1 && r.failed[0].wp_id === 'wpF');
  t('a failed WP is ALSO counted in "unfinished" (resumable)', r.unfinished.length === 1 && r.unfinished[0].wp_id === 'wpF');
  t('resumable is true', r.resumable === true);
}

console.log('7) reconcile() — out-of-nothing: empty AND missing events.jsonl => all WPs stay unfinished');
{
  const root = freshDir('mf-empty');
  mf.arm({ run_id: 'run-empty', wps: fourWps() }, { root });
  // no events.jsonl written at all — a fresh armed run
  const r1 = mf.reconcile({ run_id: 'run-empty' }, { root });
  t('missing events.jsonl -> every WP stays armed (never an error, never fabricated done)', r1.manifest.every((w) => w.status === 'armed'));
  t('missing events.jsonl -> resumable true, unfinished === total', r1.unfinished.length === 4);
  // now write a genuinely empty events.jsonl (0 bytes)
  writeEvents(root, 'run-empty', []);
  const r2 = mf.reconcile({ run_id: 'run-empty' }, { root });
  t('empty events.jsonl -> every WP stays armed', r2.manifest.every((w) => w.status === 'armed'));
}

console.log('8) reconcile() honesty guard — a DISPROVEN check_passed event never flips status to done');
{
  const root = freshDir('mf-disproven');
  mf.arm({ run_id: 'run-disproven', wps: [{ wp_id: 'wpD', agent: 'Test Boss', narrowed_prompt: 'run the suite' }] }, { root });
  writeEvents(root, 'run-disproven', [
    { event_type: 'check_passed', agent: 'Test Boss', wp_id: 'wpD', command: 'npm test', exit_code: 1, timestamp: '2026-07-18T10:00:00Z', _forge_verify: { proof_verified: false, proof_reason: 'exit_code 1 != 0' } },
  ]);
  const r = mf.reconcile({ run_id: 'run-disproven' }, { root });
  t('a disproven check_passed event does NOT count as done', r.manifest[0].status === 'armed');
  t('the disproven event leaves last_proof untouched (null)', r.manifest[0].last_proof === null);
}

console.log('9) reconcile() — last-event-wins: a real retry (failed then later completed) ends up done');
{
  const root = freshDir('mf-retry');
  mf.arm({ run_id: 'run-retry', wps: [{ wp_id: 'wpR', agent: 'Build Boss', narrowed_prompt: 'flaky task' }] }, { root });
  writeEvents(root, 'run-retry', [
    { event_type: 'wp_failed', agent: 'Build Boss', wp_id: 'wpR', timestamp: '2026-07-18T10:00:00Z' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wpR', timestamp: '2026-07-18T10:10:00Z' },
  ]);
  const r = mf.reconcile({ run_id: 'run-retry' }, { root });
  t('a later wp_completed overrides an earlier wp_failed for the same wp_id', r.manifest[0].status === 'done');
  // reverse order sanity: completed then a LATER failure must end up failed
  const root2 = freshDir('mf-retry2');
  mf.arm({ run_id: 'run-retry2', wps: [{ wp_id: 'wpR2', agent: 'Build Boss', narrowed_prompt: 'flaky task 2' }] }, { root: root2 });
  writeEvents(root2, 'run-retry2', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wpR2', timestamp: '2026-07-18T10:00:00Z' },
    { event_type: 'wp_failed', agent: 'Build Boss', wp_id: 'wpR2', timestamp: '2026-07-18T10:10:00Z' },
  ]);
  const r2 = mf.reconcile({ run_id: 'run-retry2' }, { root: root2 });
  t('a later wp_failed overrides an earlier wp_completed for the same wp_id', r2.manifest[0].status === 'failed');
}

console.log('10) reconcile() persists — status() (read-only, no event re-scan) reflects the last reconcile');
{
  const root = freshDir('mf-persist');
  mf.arm({ run_id: 'run-persist', wps: [{ wp_id: 'wpP', agent: 'Build Boss', narrowed_prompt: 'x' }] }, { root });
  writeEvents(root, 'run-persist', [{ event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wpP', timestamp: '2026-07-18T10:00:00Z' }]);
  mf.reconcile({ run_id: 'run-persist' }, { root });
  const s = mf.status('run-persist', { root });
  t('status() (no reconcile call) already reflects the persisted "done"', s.manifest[0].status === 'done');
  t('status() never touches events.jsonl (removing it must not throw or change the read)', (() => {
    fs.unlinkSync(path.join(root, '.claude', 'forge-runs', 'run-persist', 'events.jsonl'));
    const s2 = mf.status('run-persist', { root });
    return s2.manifest[0].status === 'done';
  })());
}

console.log('11) real spawned CLI: arm / reconcile / status subcommands, exit codes, --json');
{
  const root = freshDir('mf-cli');
  const wpsFile = path.join(root, 'wps.json');
  fs.writeFileSync(wpsFile, JSON.stringify(fourWps()), 'utf8');
  const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root });

  const armRes = runCLI(['arm', '--run', 'run-cli', '--wps', wpsFile], env);
  t('CLI arm exits 0', armRes.status === 0);
  t('CLI arm prints a confirmation with the WP count', /4 work package/.test(armRes.stdout));
  t('CLI arm really wrote manifest.json under FORGE_PROJECT_ROOT', fs.existsSync(manifestFile(root, 'run-cli')));

  const armMissing = runCLI(['arm', '--run', 'run-cli2'], env); // no --wps
  t('CLI arm without --wps exits 2 (usage error)', armMissing.status === 2);

  writeEvents(root, 'run-cli', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-18T10:00:00Z' },
  ]);
  const reconcileRes = runCLI(['reconcile', '--run', 'run-cli', '--json'], env);
  t('CLI reconcile exits 3 (resumable — 3 of 4 still unfinished)', reconcileRes.status === 3);
  const rj = JSON.parse(reconcileRes.stdout);
  t('CLI reconcile --json reports done.length === 1', rj.done.length === 1);
  t('CLI reconcile --json reports unfinished.length === 3', rj.unfinished.length === 3);

  const statusRes = runCLI(['status', '--run', 'run-cli', '--json'], env);
  t('CLI status exits 3 (same resumable state, read-only)', statusRes.status === 3);
  const sj = JSON.parse(statusRes.stdout);
  t('CLI status --json matches the persisted reconcile result', sj.done.length === 1 && sj.unfinished.length === 3);

  const statusMissing = runCLI(['status', '--run', 'never-armed-run'], env);
  t('CLI status on a never-armed run exits 2', statusMissing.status === 2);
  t('CLI status on a never-armed run prints the honest error', /no manifest found/.test(statusMissing.stderr));

  const noArgs = runCLI([], env);
  t('CLI with no subcommand exits 2 and prints usage', noArgs.status === 2 && /Usage:/.test(noArgs.stderr));

  // fully-resolved run: reconcile all 4 -> exit 0
  writeEvents(root, 'run-cli', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-18T10:00:00Z' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp2', timestamp: '2026-07-18T10:01:00Z' },
    { event_type: 'wp_completed', agent: 'Test Boss', wp_id: 'wp3', timestamp: '2026-07-18T10:02:00Z' },
    { event_type: 'wp_completed', agent: 'UI Boss', wp_id: 'wp4', timestamp: '2026-07-18T10:03:00Z' },
  ]);
  const allDoneRes = runCLI(['reconcile', '--run', 'run-cli'], env);
  t('CLI reconcile exits 0 once every WP is done (COMPLETE)', allDoneRes.status === 0);
  t('CLI reconcile prints COMPLETE', /COMPLETE/.test(allDoneRes.stdout));
}

// ---------------------------------------------------------------------------------------------------
console.log('12) arm --log-event: the manifest and its manifest_armed proof are ONE act (2026-08-01)');
// MEASURED RED BEFORE THIS: 0 of 32 real run directories held a manifest.json (21 held a run.json). arm()
// was complete and tested but had no caller, and arming + logging the proof were two separate manual steps
// (commands/forge.md literally said "log `manifest_armed`" as a second instruction), so the manifest and
// its proof could disagree in either direction. These tests use a STUB writer via opts.logEventPath so the
// real .claude/forge-runs/ is never touched — but the stub is REALLY spawned and its argv is really read
// back, so the wiring itself (not a mock of it) is what is proven.
{
  const root = freshDir('mf-logevent');
  // stub writer: records the exact JSON argv it was handed, then exits 0 (or the code in FAKE_EXIT)
  const stub = path.join(root, 'stub-log-event.cjs');
  const capture = path.join(root, 'captured.json');
  fs.writeFileSync(stub, [
    "const fs=require('fs');",
    "fs.appendFileSync(" + JSON.stringify(capture) + ", process.argv[2] + '\\n');",
    "if (process.env.FAKE_EXIT) { console.error('stub refused'); process.exit(Number(process.env.FAKE_EXIT)); }",
  ].join('\n'), 'utf8');
  const readCaptured = () => fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  const armed = mf.arm({ run_id: 'run-log', wps: fourWps() }, { root, logEvent: true, logEventPath: stub });
  t('arm({logEvent:true}) still succeeds and still writes the manifest', armed.ok && fs.existsSync(manifestFile(root, 'run-log')));
  t('arm({logEvent:true}) reports the logging outcome in result.logged', !!armed.logged && armed.logged.ok === true);

  const captured = readCaptured();
  t('the real event writer was actually spawned exactly once', captured.length === 1);
  t('the logged event is event_type manifest_armed for this exact run', captured[0].event_type === 'manifest_armed' && captured[0].run_id === 'run-log');
  t('the logged note names the armed work packages (real content, not a bare stamp)',
    /4 work package/.test(captured[0].note) && /wp1/.test(captured[0].note) && /wp4/.test(captured[0].note));
  // 2026-09-24: an agent-less proof made forge-runcontract's independent-verification rule fail closed
  // ("werk gelogd ZONDER agent") on every run armed with --log-event. The arm is the Lead's act.
  t('the logged proof is attributed to the orchestrator (agent/role/runtime), never anonymous',
    captured[0].agent === 'orchestrator' && captured[0].role === 'lead' && captured[0].runtime === 'internal');

  // ANTI-DEFAULT-ON: arming must NOT log unless asked. log-event.cjs always writes into the REAL project's
  // .claude/forge-runs/, so a default-on flag would make every hermetic test scribble into the live project.
  const quiet = mf.arm({ run_id: 'run-quiet', wps: fourWps() }, { root, logEventPath: stub });
  t('arm() WITHOUT logEvent does not spawn the writer at all', quiet.ok && quiet.logged === undefined && readCaptured().length === 1);

  // ANTI-SILENT-FAILURE: a writer that refuses must be REPORTED, never swallowed — and must never undo the
  // manifest, which has already committed to disk by then.
  const failStub = path.join(root, 'fail-log-event.cjs');
  fs.writeFileSync(failStub, "console.error('STRICT REFUSED'); process.exit(2);", 'utf8');
  const failed = mf.arm({ run_id: 'run-logfail', wps: fourWps() }, { root, logEvent: true, logEventPath: failStub });
  t('a refusing writer does NOT fail arm() (the manifest write already committed)', failed.ok === true && fs.existsSync(manifestFile(root, 'run-logfail')));
  t('a refusing writer is reported honestly in logged.ok:false with the real exit code + stderr',
    failed.logged.ok === false && failed.logged.status === 2 && /STRICT REFUSED/.test(failed.logged.reason));

  const missingStub = mf.arm({ run_id: 'run-lognostub', wps: fourWps() }, { root, logEvent: true, logEventPath: path.join(root, 'does-not-exist.cjs') });
  t('a missing writer is reported, not thrown', missingStub.ok === true && missingStub.logged.ok === false);

  t('the default writer really is this project\'s single log-event.cjs (never a second event writer)',
    /forge-dashboard[\\/]log-event\.cjs$/.test(mf.LOG_EVENT_PATH) && fs.existsSync(mf.LOG_EVENT_PATH));

  // CLI layer: --log-event is a real flag, and its absence is the default.
  const wpsFile = path.join(root, 'wps.json');
  fs.writeFileSync(wpsFile, JSON.stringify(fourWps()), 'utf8');
  const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root });
  const cliQuiet = runCLI(['arm', '--run', 'run-cliquiet', '--wps', wpsFile, '--json'], env);
  t('CLI arm without --log-event exits 0 and reports no logged field', cliQuiet.status === 0 && JSON.parse(cliQuiet.stdout).logged === undefined);
  t('CLI usage text advertises the --log-event flag', /--log-event/.test(runCLI([], env).stderr));
}

console.log('13) N2 fix (2026-09-26, fresh-laptop re-audit) — subagent_completed/subagent_failed with a wp_id '
  + 'now qualify as a real completion/failure, matching forge.md\'s ACTUAL documented dispatch step (:103: '
  + '"subagent_completed"/"agent_failed"), not just the wp_completed/wp_failed vocabulary forge.md never told '
  + 'the Lead to log at all. RED-before proof: DONE_EVENT_TYPES/FAILED_EVENT_TYPES are asserted directly so a '
  + 'future accidental revert is caught even if the higher-level reconcile() proof below is ever weakened.');
{
  t('DONE_EVENT_TYPES now includes subagent_completed (alongside the unchanged wp_completed/check_passed)',
    mf.DONE_EVENT_TYPES.has('subagent_completed') && mf.DONE_EVENT_TYPES.has('wp_completed') && mf.DONE_EVENT_TYPES.has('check_passed'));
  t('FAILED_EVENT_TYPES now includes subagent_failed (alongside the unchanged wp_failed/check_failed)',
    mf.FAILED_EVENT_TYPES.has('subagent_failed') && mf.FAILED_EVENT_TYPES.has('wp_failed') && mf.FAILED_EVENT_TYPES.has('check_failed'));

  const root = freshDir('mf-n2');
  mf.arm({ run_id: 'run-n2', wps: fourWps() }, { root });
  writeEvents(root, 'run-n2', [
    // forge.md's ACTUAL documented sequence for a work package: dispatch, real work, then completion —
    // never wp_completed/wp_failed at all (see forge.md:89,96,103).
    { event_type: 'subagent_started', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-09-26T10:00:00Z' },
    { event_type: 'subagent_completed', agent: 'Build Boss', wp_id: 'wp1', role: 'builder', status: 'completed', timestamp: '2026-09-26T10:05:00Z' },
    { event_type: 'subagent_started', agent: 'Test Boss', wp_id: 'wp2', timestamp: '2026-09-26T10:01:00Z' },
    { event_type: 'subagent_failed', agent: 'Test Boss', wp_id: 'wp2', reason: 'flaky fixture, needs a fresh dispatch', timestamp: '2026-09-26T10:06:00Z' },
  ]);
  const r = mf.reconcile({ run_id: 'run-n2' }, { root });
  const byId = Object.fromEntries(r.manifest.map((w) => [w.wp_id, w]));
  t('N2: a wp_id-carrying subagent_completed flips its WP to done (forge.md\'s real documented event)', byId.wp1.status === 'done');
  t('N2: a wp_id-carrying subagent_failed flips its WP to failed', byId.wp2.status === 'failed');
  t('N2: wp3/wp4 (no matching event) still stay armed — never fabricated', byId.wp3.status === 'armed' && byId.wp4.status === 'armed');
  t('N2: last_proof on wp1 records the real subagent_completed event, not a synthesized one', byId.wp1.last_proof && byId.wp1.last_proof.event_type === 'subagent_completed');

  // honesty guard must still apply to the NEW event types too — a disproven subagent_completed is not proof
  const rootD = freshDir('mf-n2-disproven');
  mf.arm({ run_id: 'run-n2d', wps: [{ wp_id: 'wpX', agent: 'Build Boss', narrowed_prompt: 'x' }] }, { root: rootD });
  writeEvents(rootD, 'run-n2d', [
    { event_type: 'subagent_completed', agent: 'Build Boss', wp_id: 'wpX', timestamp: '2026-09-26T10:00:00Z', _forge_verify: { proof_verified: false, proof_reason: 'claim not corroborated' } },
  ]);
  const rd = mf.reconcile({ run_id: 'run-n2d' }, { root: rootD });
  t('N2: a DISPROVEN subagent_completed does NOT flip status to done (content-oracle guard extends to the new type)', rd.manifest[0].status === 'armed');

  // a subagent_completed WITHOUT a wp_id must not flip anything (unchanged "no qualifying event" rule)
  const rootU = freshDir('mf-n2-unlinked');
  mf.arm({ run_id: 'run-n2u', wps: [{ wp_id: 'wpY', agent: 'Build Boss', narrowed_prompt: 'y' }] }, { root: rootU });
  writeEvents(rootU, 'run-n2u', [{ event_type: 'subagent_completed', agent: 'Build Boss', timestamp: '2026-09-26T10:00:00Z' }]);
  const ru = mf.reconcile({ run_id: 'run-n2u' }, { root: rootU });
  t('N2: a subagent_completed with NO wp_id at all flips no work package (matching is still purely on wp_id)', ru.manifest[0].status === 'armed');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
