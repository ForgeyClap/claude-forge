#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-checkpoint.cjs (WP6, 2026-07-14). EVERY fixture lives under a fresh
 * os.tmpdir() directory (see freshDir()) — this file NEVER touches this repo's real .claude/,
 * never writes to a real run, never writes to a real project. Exit 0 = all pass.
 *
 * Section map (WP6 spec invariant -> test section):
 *   INVARIANT 1 (idempotency — no double work)         -> section 5
 *   INVARIANT 2 (atomic write survives a mid-write crash) -> sections 3, 3b
 *   INVARIANT 3 (a corrupted checkpoint is never trusted) -> sections 4, 15
 *   INVARIANT 4 (resumePlan resumes only unfinished work)  -> sections 7, 8
 *   INVARIANT 5 (a changed input_hash is a real re-run)    -> section 6
 *   supporting proofs (validation, round-trip, Windows-safe rename retry, path-escape safety,
 *   real CLI subcommands, env-var root override, root-resolution precedence, checksum determinism,
 *   "never touches the real project") -> sections 1, 2, 9/9b, 10, 11, 12, 13, 14, G
 *   MUTANT-SURVIVOR PINS (2026-07-14 checkpoint fix round — code was already correct, these pin the
 *   proven-surviving mutants so a future regression is caught):
 *     L319 claim() must return claimed:false (never claimed:true) when the underlying writeCheckpoint
 *       call itself fails, and must leave nothing on disk -> section 16
 *     L192 / L200 normalizeRecord()'s own JSDoc says "Never throws" — pin null/undefined/non-array-files
 *       input against a silent regression into an uncaught TypeError -> section 17
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The crash-injection hook is opt-in and gated behind this env var in production code (mirrors
// forge-sync.cjs's FORGE_SYNC_TEST_HOOKS / __throwAfter convention) — MUST be set before require() so
// the module's module-load-time TEST_HOOKS_ENABLED constant picks it up. Section 3b independently
// proves the gate is OFF by default in a FRESH child process that never sets this var.
process.env.FORGE_CHECKPOINT_TEST_HOOKS = '1';
const cp = require('./forge-checkpoint.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const ALL_FIXTURE_ROOTS = []; // section G proof: every fixture dir this suite ever creates, tracked for real
function freshDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); ALL_FIXTURE_ROOTS.push(d); return d; }

const CLI = path.join(__dirname, 'forge-checkpoint.cjs');
function runCLI(argv, opts) { return spawnSync(process.execPath, [CLI, ...argv], Object.assign({ encoding: 'utf8' }, opts || {})); }
// NOTE: takes the FULL env object the caller wants (not merged with process.env again) — a caller that
// needs to DELETE a var (e.g. the "gate OFF" proof below) builds its own full copy-then-delete env; a
// second Object.assign({}, process.env, env) here would silently re-introduce the deleted key from the
// live process.env base, defeating the deletion. Callers that just want "inherit everything plus one
// override" pass Object.assign({}, process.env, {...}) themselves, same effect either way for additions.
function runNodeScript(scriptSrc, env) {
  return spawnSync(process.execPath, ['-e', scriptSrc], { encoding: 'utf8', env: env || process.env });
}

console.log('1) writeCheckpoint validation — bad records are rejected and nothing is written');
{
  const root = freshDir('cp-validate');
  const r1 = cp.writeCheckpoint({ idempotency_key: 'k' }, { root }); // missing run_id
  t('missing run_id -> ok:false / validation_error', r1.ok === false && r1.reason === 'validation_error');
  const r2 = cp.writeCheckpoint({ run_id: 'run1' }, { root }); // missing idempotency_key
  t('missing idempotency_key -> ok:false', r2.ok === false);
  const r3 = cp.writeCheckpoint({ run_id: 'run1', idempotency_key: 'k1', status: 'bogus-status' }, { root });
  t('invalid status enum -> ok:false', r3.ok === false);
  const r4 = cp.writeCheckpoint({ run_id: 'bad run id!', idempotency_key: 'k1' }, { root });
  t('run_id with illegal characters -> ok:false', r4.ok === false);
  const r5 = cp.writeCheckpoint({ run_id: 'run1', idempotency_key: 'k1', files: [{ path: 'a.txt' }] }, { root }); // missing hash
  t('files[] entry missing "hash" -> ok:false', r5.ok === false);
  const r6 = cp.writeCheckpoint(null, { root });
  t('null record -> ok:false, never throws', r6.ok === false);
  const keysDir = path.join(cp.checkpointsBase(root), 'keys');
  t('nothing was ever written to disk for any invalid record', !fs.existsSync(keysDir) || fs.readdirSync(keysDir).length === 0);
}

console.log('2) writeCheckpoint + readCheckpoint round trip (all fields survive)');
{
  const root = freshDir('cp-roundtrip');
  const w = cp.writeCheckpoint({
    run_id: 'run1', work_package_id: 'wp1', phase_id: 'p1', task_id: 't1', attempt_id: 2,
    idempotency_key: 'task-alpha', input_hash: 'h1', output_hash: 'o1', status: 'done',
    files: [{ path: 'a.txt', hash: 'abc' }], proof_refs: ['evidence.md'],
  }, { root });
  t('write ok', w.ok === true);
  t('write returns a path under .claude/forge-checkpoints/keys/', w.path.includes(path.join('forge-checkpoints', 'keys')));
  const r = cp.readCheckpoint('task-alpha', { root });
  t('read ok', r.ok === true);
  t('read record matches every written field', r.record.run_id === 'run1' && r.record.work_package_id === 'wp1' &&
    r.record.phase_id === 'p1' && r.record.task_id === 't1' && r.record.attempt_id === 2 &&
    r.record.status === 'done' && r.record.input_hash === 'h1' && r.record.output_hash === 'o1');
  t('files[] round-trips exactly', r.record.files.length === 1 && r.record.files[0].path === 'a.txt' && r.record.files[0].hash === 'abc');
  t('proof_refs[] round-trips', Array.isArray(r.record.proof_refs) && r.record.proof_refs[0] === 'evidence.md');
  t('ts is auto-stamped when not given elsewhere (present, ISO-looking)', typeof r.record.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(r.record.ts));
  const w2 = cp.writeCheckpoint({ run_id: 'run1', idempotency_key: 'task-beta' }, { root }); // no attempt_id given
  t('attempt_id defaults to 1 when omitted', w2.ok === true && w2.record.attempt_id === 1);
  t('status defaults to pending when omitted', w2.record.status === 'pending');
  const v = cp.verify('task-alpha', { root });
  t('verify() mirrors readCheckpoint for an intact checkpoint', v.ok === true);
  const missing = cp.readCheckpoint('does-not-exist-anywhere', { root });
  t('reading a never-written key returns ok:false, reason not_found (no exception)', missing.ok === false && missing.reason === 'not_found');
}

console.log('3) INVARIANT 2 — atomic write: a crash between temp-write and rename never corrupts the destination');
{
  const root = freshDir('cp-atomic');
  const w1 = cp.writeCheckpoint({ run_id: 'run2', idempotency_key: 'k2', input_hash: 'h1', status: 'done', output_hash: 'o1' }, { root });
  t('initial write ok', w1.ok === true);
  const file = cp.keyFilePath(root, 'k2');
  const before = fs.readFileSync(file);
  let threw = false, threwMsg = '';
  try {
    cp.writeCheckpoint({ run_id: 'run2', idempotency_key: 'k2', input_hash: 'h2', status: 'done', output_hash: 'o2' }, { root, __throwAfterTempWrite: true });
  } catch (e) { threw = true; threwMsg = e.message; }
  t('the injected crash actually threw', threw === true);
  t('the thrown error names the simulated crash (not a mystery exception)', /simulated crash/.test(threwMsg));
  const after = fs.readFileSync(file);
  t('destination BYTES are byte-for-byte unchanged after the crash (old checkpoint fully intact)', Buffer.compare(before, after) === 0);
  const r = cp.readCheckpoint('k2', { root });
  t('readCheckpoint after the crash still returns the OLD pre-crash record, verified', r.ok === true && r.record.output_hash === 'o1' && r.record.input_hash === 'h1');
  const keysDir = path.join(cp.checkpointsBase(root), 'keys');
  const entries = fs.readdirSync(keysDir);
  t('exactly one committed .json checkpoint exists for k2 (no half-written duplicate)', entries.filter((f) => f.endsWith('.json')).length === 1);
  t('the orphaned temp file from the crash is left on disk (as a real crash would) but named .tmp- (never a committed checkpoint)', entries.some((f) => f.includes('.tmp-')));
  // a fresh readCheckpoint/resumePlan never lists the orphaned temp file as a second checkpoint
  const plan = (() => { cp.writeCheckpoint({ run_id: 'run2', idempotency_key: 'k2', input_hash: 'h1', status: 'done', output_hash: 'o1' }, { root }); return cp.resumePlan('run2', { root }); })();
  t('the orphaned temp file never surfaces as its own task in resumePlan', plan.tasks.filter((tk) => tk.idempotency_key === 'k2').length === 1);
}

console.log('3b) test-hook gate is REAL: __throwAfterTempWrite only fires with FORGE_CHECKPOINT_TEST_HOOKS=1 (proven in FRESH child processes, not import-time state)');
{
  const root1 = freshDir('cp-hookgate-off');
  const envNoGate = Object.assign({}, process.env); delete envNoGate.FORGE_CHECKPOINT_TEST_HOOKS;
  const scriptOk = 'const cp = require(' + JSON.stringify(CLI) + ');' +
    'const r = cp.writeCheckpoint({run_id:"g1", idempotency_key:"kg", input_hash:"h1", status:"done"}, {root:' + JSON.stringify(root1) + ', __throwAfterTempWrite:true});' +
    'console.log(JSON.stringify(r));';
  const withoutGate = runNodeScript(scriptOk, envNoGate);
  t('gate OFF (fresh process, env var unset): write succeeds normally even though __throwAfterTempWrite was passed', withoutGate.status === 0);
  t('gate OFF: the record was really written (ok:true in the child process output)', (() => { try { return JSON.parse(withoutGate.stdout.trim()).ok === true; } catch { return false; } })());

  const root2 = freshDir('cp-hookgate-on');
  const scriptCrash = 'const cp = require(' + JSON.stringify(CLI) + ');' +
    'try { cp.writeCheckpoint({run_id:"g2", idempotency_key:"kg2", input_hash:"h1", status:"done"}, {root:' + JSON.stringify(root2) + ', __throwAfterTempWrite:true}); console.log("NO_THROW"); }' +
    'catch (e) { console.log("THREW:" + e.message); }';
  const withGate = runNodeScript(scriptCrash, Object.assign({}, process.env, { FORGE_CHECKPOINT_TEST_HOOKS: '1' }));
  t('gate ON (fresh process, env var set to 1): the identical call throws (simulated crash)', withGate.status === 0 && /THREW:/.test(withGate.stdout) && /simulated crash/.test(withGate.stdout));
}

console.log('4) INVARIANT 3 — a corrupted checkpoint is NEVER trusted as valid (fail closed)');
{
  const root = freshDir('cp-corrupt');
  cp.writeCheckpoint({ run_id: 'run3', work_package_id: 'wp1', task_id: 't1', idempotency_key: 'k3', input_hash: 'h1', status: 'done', output_hash: 'o1' }, { root });
  const file = cp.keyFilePath(root, 'k3');
  const pre = cp.readCheckpoint('k3', { root });
  t('pre-corruption read is ok', pre.ok === true);
  const buf = fs.readFileSync(file);
  const mid = Math.floor(buf.length / 2);
  buf[mid] = buf[mid] ^ 0xff; // flip one byte in the middle of the file
  fs.writeFileSync(file, buf);
  const post = cp.readCheckpoint('k3', { root });
  t('post-corruption readCheckpoint returns ok:false (never a half-trusted record)', post.ok === false);
  t('post-corruption reason is a real integrity reason', ['invalid_json', 'checksum_mismatch', 'malformed_envelope'].includes(post.reason));
  const v = cp.verify('k3', { root });
  t('verify() also reports ok:false for the corrupted file', v.ok === false);
  const sr = cp.shouldRun('k3', 'h1', { root });
  t('shouldRun FAILS CLOSED on a corrupted checkpoint: must (re)run, never trusts stale done status', sr.should === true);
  const rp = cp.resumePlan('run3', { root });
  t('resumePlan lists the corrupted task as NOT done (present in pending, absent from done)', rp.pending.includes('k3') && !rp.done.includes('k3'));
  const task = rp.tasks.find((x) => x.idempotency_key === 'k3');
  t('resumePlan flags the task explicitly corrupt:true, status "corrupt"', !!task && task.corrupt === true && task.status === 'corrupt');
}

console.log('5) INVARIANT 1 — idempotency: the SAME idempotency_key + input_hash never runs the side effect twice');
{
  const root = freshDir('cp-idem');
  let sideEffectCount = 0;
  function runOnce(runId, key, inputHash) {
    const c = cp.claim(key, inputHash, { root }, { run_id: runId, work_package_id: 'wp1', task_id: 't1' });
    if (!c.claimed) return { ran: false, reason: c.reason };
    sideEffectCount++; // <-- the actual side effect (e.g. "send email", "write output")
    cp.writeCheckpoint({ run_id: runId, work_package_id: 'wp1', task_id: 't1', idempotency_key: key, input_hash: inputHash, status: 'done', output_hash: 'out-' + sideEffectCount }, { root });
    return { ran: true };
  }
  const first = runOnce('run4', 'email-welcome-user123', 'hash-A');
  const second = runOnce('run4', 'email-welcome-user123', 'hash-A');
  const third = runOnce('run4', 'email-welcome-user123', 'hash-A');
  t('the first run actually ran', first.ran === true);
  t('the second run with the SAME key+input was SKIPPED (no double work)', second.ran === false && second.reason === 'already_done_same_input');
  t('a third repeat is still skipped', third.ran === false);
  t('the side-effect counter stayed at EXACTLY 1, not 2 or 3 — this is the core invariant', sideEffectCount === 1);
}

console.log('6) INVARIANT 5 — a DIFFERENT input_hash under the SAME idempotency_key is a real re-run, not a replay');
{
  const root = freshDir('cp-inputchange');
  let count = 0;
  function runOnce(key, inputHash) {
    const c = cp.claim(key, inputHash, { root }, { run_id: 'run5', task_id: 't1' });
    if (!c.claimed) return false;
    count++;
    cp.writeCheckpoint({ run_id: 'run5', task_id: 't1', idempotency_key: key, input_hash: inputHash, status: 'done' }, { root });
    return true;
  }
  t('run with hash-A executes', runOnce('deploy-service-x', 'hash-A') === true);
  t('a repeat with the SAME hash-A is skipped', runOnce('deploy-service-x', 'hash-A') === false);
  t('a DIFFERENT hash-B under the same key IS executed (real re-run, real new work)', runOnce('deploy-service-x', 'hash-B') === true);
  t('a repeat of hash-B is now skipped too', runOnce('deploy-service-x', 'hash-B') === false);
  t('the side-effect counter reflects exactly 2 real executions total (A once, B once)', count === 2);
  const sr = cp.shouldRun('deploy-service-x', 'hash-A', { root });
  t('shouldRun for the now-STALE hash-A says re-run too (current done-state is hash-B, not hash-A)', sr.should === true && sr.reason === 'input_changed_real_rerun');
}

console.log('7) INVARIANT 4 — resumePlan resumes only the unfinished work; done work is never re-listed');
{
  const root = freshDir('cp-resume');
  const runId = 'run6';
  cp.writeCheckpoint({ run_id: runId, work_package_id: 'wp1', task_id: 't1', idempotency_key: 'run6-wp1', input_hash: 'h1', status: 'done', output_hash: 'o1' }, { root });
  cp.writeCheckpoint({ run_id: runId, work_package_id: 'wp2', task_id: 't1', idempotency_key: 'run6-wp2', input_hash: 'h1', status: 'done', output_hash: 'o1' }, { root });
  cp.writeCheckpoint({ run_id: runId, work_package_id: 'wp3', task_id: 't1', idempotency_key: 'run6-wp3', input_hash: 'h1', status: 'failed' }, { root });
  const plan = cp.resumePlan(runId, { root });
  t('resumePlan ok', plan.ok === true);
  t('exactly 2 done work packages, and they are the right ones', plan.done.length === 2 && plan.done.includes('run6-wp1') && plan.done.includes('run6-wp2'));
  t('exactly 1 pending/unfinished work package (the failed one), and it is the right one', plan.pending.length === 1 && plan.pending.includes('run6-wp3'));
  t('resumable is true while unfinished work remains', plan.resumable === true);
  // simulate a real resume: only the failed WP is re-dispatched and finishes
  cp.writeCheckpoint({ run_id: runId, work_package_id: 'wp3', task_id: 't1', idempotency_key: 'run6-wp3', input_hash: 'h1', status: 'done', output_hash: 'o-retry' }, { root });
  const plan2 = cp.resumePlan(runId, { root });
  t('after resuming the last WP, the run is complete (nothing pending, all 3 done)', plan2.pending.length === 0 && plan2.done.length === 3 && plan2.resumable === false);
  const noSuchRun = cp.resumePlan('run6-never-existed', { root });
  t('a run with zero checkpoints ever written is a valid COMPLETE run, not an error', noSuchRun.ok === true && noSuchRun.tasks.length === 0 && noSuchRun.resumable === false);
  const badRunId = cp.resumePlan('not a valid run id!', { root });
  t('an invalid run_id shape is rejected explicitly (never silently treated as empty)', badRunId.ok === false && badRunId.reason === 'invalid_run_id');
}

console.log('8) claim() leaves an honest RUNNING trail if the caller crashes before finishing (crash-during-work variant of invariant 4)');
{
  const root = freshDir('cp-runningtrail');
  const c = cp.claim('run7-wp1', 'h1', { root }, { run_id: 'run7', work_package_id: 'wp1', task_id: 't1' });
  t('claim succeeds (nothing done yet, so it should run)', c.claimed === true);
  // the caller's real work "crashes" right here — writeCheckpoint('done', ...) is never called
  const plan = cp.resumePlan('run7', { root });
  t('resumePlan sees the task as still pending (status running, not done)', plan.pending.includes('run7-wp1') && !plan.done.includes('run7-wp1'));
  const rc = cp.readCheckpoint('run7-wp1', { root });
  t('the checkpoint itself honestly shows status "running", never fakes "done"', rc.ok === true && rc.record.status === 'running');
  const c2 = cp.claim('run7-wp1', 'h1', { root }, { run_id: 'run7', work_package_id: 'wp1', task_id: 't1' });
  t('a second claim on a still-running (never-finished) task is allowed — it must retry, not silently skip', c2.claimed === true);
}

console.log('9) renameWithRetry tolerates a transient EPERM/EBUSY/EACCES and eventually succeeds (Windows-safety)');
{
  const root = freshDir('cp-retry');
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = function (src, dest) {
    calls++;
    if (calls <= 2) { const e = new Error('simulated transient lock'); e.code = 'EBUSY'; throw e; }
    return realRename(src, dest);
  };
  let w;
  try { w = cp.writeCheckpoint({ run_id: 'run8', idempotency_key: 'retrykey', input_hash: 'h1', status: 'done' }, { root }); }
  finally { fs.renameSync = realRename; }
  t('write eventually succeeds after 2 simulated transient EBUSY failures', w.ok === true);
  t('fs.renameSync was actually retried (called 3+ times, not just once)', calls >= 3);
  const r = cp.readCheckpoint('retrykey', { root });
  t('the checkpoint that succeeded after retry reads back correctly', r.ok === true && r.record.status === 'done');
}
console.log('9b) renameWithRetry does NOT swallow a non-transient error (e.g. ENOENT) — rethrows immediately, fails fast');
{
  const root = freshDir('cp-retry-nontransient');
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = function () { calls++; const e = new Error('simulated missing source'); e.code = 'ENOENT'; throw e; };
  let threw = false;
  try { cp.writeCheckpoint({ run_id: 'run8b', idempotency_key: 'retrykey2', input_hash: 'h1', status: 'done' }, { root }); }
  catch (e) { threw = true; }
  finally { fs.renameSync = realRename; }
  t('a non-transient rename error propagates immediately', threw === true);
  t('it was NOT retried 5 times — fails fast on the first non-transient error (called exactly once)', calls === 1);
}

console.log('10) sanitizeKey / keyFilePath — safe filenames for arbitrary/adversarial keys, no path escape, no collisions');
{
  const root = freshDir('cp-keysafety');
  const weirdKeys = ['a/b/../../etc/passwd', '..', '.', '', 'normal-key', 'key:with:colons', 'a'.repeat(300), '../../../secret'];
  const base = cp.checkpointsBase(root);
  const paths = weirdKeys.map((k) => cp.keyFilePath(root, k));
  for (let i = 0; i < paths.length; i++) {
    t('key ' + JSON.stringify(weirdKeys[i]) + ' resolves INSIDE the checkpoints dir', path.resolve(paths[i]).startsWith(path.resolve(base) + path.sep));
  }
  t('every weird/adversarial key maps to a DISTINCT file path (no accidental collisions)', new Set(paths).size === paths.length);
  const w = cp.writeCheckpoint({ run_id: 'run9', idempotency_key: 'a/b/../../etc/passwd', input_hash: 'h1', status: 'done' }, { root });
  t('writing under a path-traversal-looking key succeeds safely (sanitized + contained)', w.ok === true);
  const r = cp.readCheckpoint('a/b/../../etc/passwd', { root });
  t('reading it back with the exact same raw key round-trips the original key string', r.ok === true && r.record.idempotency_key === 'a/b/../../etc/passwd');
  t('no file/dir was actually created outside the checkpoints dir (no real "etc/" escaped into the fixture root)', !fs.existsSync(path.join(root, 'etc')));
}

console.log('11) CLI — write/read/should-run/resume-plan/verify subcommands (real spawned process, not in-process)');
{
  const root = freshDir('cp-cli');
  const rec = JSON.stringify({ run_id: 'run10', work_package_id: 'wp1', task_id: 't1', idempotency_key: 'cli-key-1', input_hash: 'h1', status: 'done', output_hash: 'o1' });
  const w = runCLI(['write', rec, '--root', root, '--json']);
  t('CLI write exits 0', w.status === 0);
  t('CLI write JSON reports ok:true', JSON.parse(w.stdout.trim()).ok === true);

  const r = runCLI(['read', 'cli-key-1', '--root', root, '--json']);
  t('CLI read exits 0 and returns the same record written above', r.status === 0 && JSON.parse(r.stdout.trim()).record.output_hash === 'o1');

  const sr1 = runCLI(['should-run', 'cli-key-1', 'h1', '--root', root]);
  t('CLI should-run for a matching done checkpoint exits 1 (SKIP, shell-boolean convention)', sr1.status === 1 && /SKIP/.test(sr1.stdout));

  const sr2 = runCLI(['should-run', 'cli-key-1', 'h-different', '--root', root]);
  t('CLI should-run for a DIFFERENT input_hash exits 0 (RUN)', sr2.status === 0 && /RUN/.test(sr2.stdout));

  const v = runCLI(['verify', 'cli-key-1', '--root', root]);
  t('CLI verify exits 0 for an intact checkpoint', v.status === 0 && /OK/.test(v.stdout));

  const file = cp.keyFilePath(root, 'cli-key-1');
  const buf = fs.readFileSync(file); buf[10] = buf[10] ^ 0xff; fs.writeFileSync(file, buf);
  const v2 = runCLI(['verify', 'cli-key-1', '--root', root]);
  t('CLI verify exits 1 for a corrupted checkpoint', v2.status === 1 && /NOT OK/.test(v2.stdout));

  const rp = runCLI(['resume-plan', 'run10', '--root', root, '--json']);
  t('CLI resume-plan exits 3 (resumable) since the corrupted task is not done', rp.status === 3);
  t('CLI resume-plan JSON lists the corrupted task under pending, not done', JSON.parse(rp.stdout.trim()).pending.includes('cli-key-1'));

  const badRun = runCLI(['resume-plan', 'nonexistent-run-xyz', '--root', root]);
  t('CLI resume-plan on a run with zero checkpoints exits 0 (complete)', badRun.status === 0);

  const usageErr = runCLI(['bogus-command']);
  t('CLI unknown command exits 2 (usage error)', usageErr.status === 2);

  const missingArg = runCLI(['write']);
  t('CLI write with no record argument exits 2', missingArg.status === 2);

  const badJson = runCLI(['write', '{not valid json', '--root', root]);
  t('CLI write with invalid JSON exits 1', badJson.status === 1);

  const badRunIdCli = runCLI(['resume-plan', 'not a valid run id', '--root', root]);
  t('CLI resume-plan with an invalid run_id shape exits 2', badRunIdCli.status === 2);
}

console.log('12) FORGE_CHECKPOINT_ROOT env override works when --root is omitted (isolates from the real project by default)');
{
  const root = freshDir('cp-envroot');
  const w = runCLI(['write', JSON.stringify({ run_id: 'run11', idempotency_key: 'env-key', input_hash: 'h1', status: 'done' }), '--json'],
    { env: Object.assign({}, process.env, { FORGE_CHECKPOINT_ROOT: root }) });
  t('write via env-var root exits 0', w.status === 0);
  t('the checkpoint actually landed under the env-var root, never the real project', fs.existsSync(path.join(root, '.claude', 'forge-checkpoints', 'keys')));
}

console.log('13) resolveRoot precedence (pure path computation, no disk writes)');
{
  const savedEnv = process.env.FORGE_CHECKPOINT_ROOT;
  delete process.env.FORGE_CHECKPOINT_ROOT;
  t('resolveRoot(null) with no env override returns PROJECT_ROOT_DEFAULT', cp.resolveRoot(null) === cp.PROJECT_ROOT_DEFAULT);
  t('an explicit root always wins over the default', cp.resolveRoot(path.join(os.tmpdir(), 'explicit-dir')) === path.resolve(path.join(os.tmpdir(), 'explicit-dir')));
  process.env.FORGE_CHECKPOINT_ROOT = path.resolve(os.tmpdir());
  t('FORGE_CHECKPOINT_ROOT env var is honored when no explicit root is given', cp.resolveRoot(null) === path.resolve(os.tmpdir()));
  t('an explicit root STILL overrides the env var', cp.resolveRoot(path.join(os.tmpdir(), 'explicit-wins')) === path.resolve(path.join(os.tmpdir(), 'explicit-wins')));
  if (savedEnv === undefined) delete process.env.FORGE_CHECKPOINT_ROOT; else process.env.FORGE_CHECKPOINT_ROOT = savedEnv;
}

console.log('14) canonicalJSON / checksum is stable regardless of key insertion order');
{
  const a = { b: 2, a: 1, nested: { z: 9, y: 8 } };
  const bObj = { a: 1, nested: { y: 8, z: 9 }, b: 2 };
  t('canonicalJSON is identical for differently-ordered but equal objects', cp.canonicalJSON(a) === cp.canonicalJSON(bObj));
  t('sha256OfString over canonicalJSON is therefore identical too', cp.sha256OfString(cp.canonicalJSON(a)) === cp.sha256OfString(cp.canonicalJSON(bObj)));
  const c = { a: 1, nested: { y: 8, z: 99 }, b: 2 };
  t('a genuinely different value produces a DIFFERENT canonicalJSON/checksum (not a collision)', cp.canonicalJSON(a) !== cp.canonicalJSON(c));
}

console.log('15) malformed envelope shapes are all rejected (not just checksum mismatches)');
{
  const root = freshDir('cp-malformed');
  const file1 = cp.keyFilePath(root, 'malformed-1');
  fs.mkdirSync(path.dirname(file1), { recursive: true });
  fs.writeFileSync(file1, JSON.stringify({ record: { run_id: 'x' } })); // no _checksum at all
  t('an envelope with no _checksum field is rejected', cp.readCheckpoint('malformed-1', { root }).reason === 'malformed_envelope');

  const file2 = cp.keyFilePath(root, 'malformed-2');
  fs.writeFileSync(file2, JSON.stringify([1, 2, 3])); // valid JSON, but not an envelope object
  t('a JSON array instead of an envelope object is rejected', cp.readCheckpoint('malformed-2', { root }).reason === 'malformed_envelope');

  const file3 = cp.keyFilePath(root, 'malformed-3');
  fs.writeFileSync(file3, 'not even json {{{');
  t('non-JSON bytes are rejected as invalid_json', cp.readCheckpoint('malformed-3', { root }).reason === 'invalid_json');

  const file4 = cp.keyFilePath(root, 'malformed-4');
  fs.writeFileSync(file4, JSON.stringify({ record: null, _checksum: 'abc' }));
  t('a null "record" field is rejected', cp.readCheckpoint('malformed-4', { root }).reason === 'malformed_envelope');
}

console.log('16) PIN (L319 mutant-survivor fix) — claim() reports claimed:false (never claimed:true) when the underlying writeCheckpoint call fails, and leaves nothing on disk');
{
  const root = freshDir('cp-pin-l319');
  // `extra` intentionally omits run_id, so the 'running' record claim() assembles internally fails
  // writeCheckpoint's own validation (normalizeRecord requires run_id). Proven QA mutant: forcing the
  // `if (!w.ok) return {claimed:false, ...}` guard on L319 to always fall through makes claim() return
  // {claimed:true} with an undefined record even though writeCheckpoint wrote NOTHING to disk — the
  // caller would believe the work is safely claimed/tracked while resumePlan has an invisible gap
  // (lost or duplicated work). This test proves the current (correct) code never does that.
  const c = cp.claim('pin-l319-key', 'h1', { root }, { work_package_id: 'wp1', task_id: 't1' }); // no run_id
  t('claim() honestly reports claimed:false when writeCheckpoint validation fails', c.claimed === false);
  t('claim() surfaces a write_failed reason, not a silent success', c.reason === 'write_failed');
  const keysDir = path.join(cp.checkpointsBase(root), 'keys');
  t('nothing was written to disk for the failed claim (no phantom "claimed" checkpoint file)', !fs.existsSync(keysDir) || fs.readdirSync(keysDir).length === 0);
  const rc = cp.readCheckpoint('pin-l319-key', { root });
  t('reading the key back confirms not_found — caller cannot be fooled into thinking work is tracked', rc.ok === false && rc.reason === 'not_found');
}

console.log('17) PIN (L192 & L200 mutant-survivor fix) — normalizeRecord NEVER throws (per its own JSDoc "Never throws" contract), even for null/undefined/non-array-files input');
{
  // Proven QA mutants: weakening either OR-chain guard (L192's `!input || typeof input !== "object" ||
  // Array.isArray(input)` object-shape check, or L200's `!Array.isArray(input.files)` files-array check)
  // lets normalizeRecord(null), normalizeRecord(undefined), or normalizeRecord({..., files:{}}) fall
  // through to code that dereferences a property on null/undefined, or `for...of`-iterates a non-array
  // files value — an uncaught TypeError, violating the function's own documented "Never throws" contract.
  let threwNull = false, resNull;
  try { resNull = cp.normalizeRecord(null); } catch (e) { threwNull = true; }
  t('normalizeRecord(null) never throws', threwNull === false);
  t('normalizeRecord(null) returns ok:false', !!resNull && resNull.ok === false);

  let threwUndef = false, resUndef;
  try { resUndef = cp.normalizeRecord(undefined); } catch (e) { threwUndef = true; }
  t('normalizeRecord(undefined) never throws', threwUndef === false);
  t('normalizeRecord(undefined) returns ok:false', !!resUndef && resUndef.ok === false);

  let threwFilesObj = false, resFilesObj;
  try { resFilesObj = cp.normalizeRecord({ run_id: 'run1', idempotency_key: 'k1', files: {} }); } catch (e) { threwFilesObj = true; }
  t('normalizeRecord({..., files:{}}) (non-array files) never throws', threwFilesObj === false);
  t('normalizeRecord({..., files:{}}) returns ok:false (files must be an array if present)', !!resFilesObj && resFilesObj.ok === false);

  // A real mutation-testing run (forge-mutate.cjs) found a 4th surviving mutant on this SAME L192
  // guard beyond the 3 named inputs above: weakening only the guard's SECOND `||` (the one guarding
  // `Array.isArray(input)`) to `&&` is invisible to null/undefined/non-array-files, because an actual
  // ARRAY is `typeof 'object'` in JS — the mutated `(typeof input!=='object' && Array.isArray(input))`
  // clause is always false for a real array, silently disabling the "reject arrays" branch specifically.
  // A plain array can carry arbitrary own properties, so a hostile/malformed caller passing an ARRAY
  // that "looks like" a valid record must still be rejected — pin that explicitly.
  const arrayRecord = ['unused', 'array', 'elements'];
  arrayRecord.run_id = 'run1';
  arrayRecord.idempotency_key = 'k1';
  let threwArray = false, resArray;
  try { resArray = cp.normalizeRecord(arrayRecord); } catch (e) { threwArray = true; }
  t('normalizeRecord(<array with run_id/idempotency_key own-properties>) never throws', threwArray === false);
  t('an Array is REJECTED as a record even though typeof it is "object" and it has record-shaped own properties', !!resArray && resArray.ok === false && resArray.reason === 'record_must_be_object');
}

console.log('\nG) never touches the real project or a real run — every fixture lives under os.tmpdir()');
{
  const tmpRootPrefixed = path.resolve(os.tmpdir()) + path.sep;
  t('every one of the ' + ALL_FIXTURE_ROOTS.length + ' fixture dirs created this run is under os.tmpdir()',
    ALL_FIXTURE_ROOTS.length > 0 && ALL_FIXTURE_ROOTS.every((d) => path.resolve(d).startsWith(tmpRootPrefixed)));
  t('the real project .claude/forge-checkpoints/ was never created by this suite',
    !fs.existsSync(path.resolve(__dirname, '..', 'forge-checkpoints')));
  t('the real project root was never used as a fixture dir',
    !ALL_FIXTURE_ROOTS.some((d) => path.resolve(d) === path.resolve(__dirname, '..', '..')));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
