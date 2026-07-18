#!/usr/bin/env node
'use strict';
/**
 * forge-checkpoint.cjs — idempotency + ATOMIC checkpoint layer (WP6, 2026-07-14). Zero-dependency
 * (fs/path/crypto only), Windows-safe. Answers the honest limitation `forge-run-state.cjs` documents in
 * its own header ("exactly-once is really effectively-once — before RE-running any side-effecting action
 * on resume, the owning Boss MUST check an intent/receipt key so replay never re-sends"): THIS file is
 * that intent/receipt-key check, generalized to any work package/phase/task, not just email/SMS/deploy.
 *
 * CHECKPOINT RECORD (what `writeCheckpoint` persists):
 *   { run_id, work_package_id, phase_id, task_id, attempt_id, idempotency_key, input_hash, output_hash,
 *     files: [{path, hash}], status: 'pending'|'running'|'done'|'failed', proof_refs, ts }
 *
 * STORAGE LAYOUT (project-local, under THIS project's .claude/ only — never a global/shared location):
 *   .claude/forge-checkpoints/keys/<sanitized(idempotency_key)>.json   — ONE canonical file per
 *     idempotency_key, the single source of truth for "is this exact unit of work done". Overwritten
 *     (atomically) on every writeCheckpoint call for that key. This is deliberately NOT scoped by run_id:
 *     an idempotency_key models a real-world "this side effect must never happen twice" identity (e.g. a
 *     Stripe-style idempotency key), which by definition must survive across a crashed run's resume, and
 *     in principle across a completely separate later run that happens to reuse the same key.
 *   .claude/forge-checkpoints/runs/<run_id>/index.jsonl  — an APPEND-ONLY pointer log (mirrors
 *     forge-store.cjs's index.jsonl convention): one compact `{idempotency_key, work_package_id,
 *     phase_id, task_id, ts}` row per writeCheckpoint call made UNDER that run_id. `resumePlan(run_id)`
 *     replays this log to find which idempotency_keys this run has touched, then asks the CANONICAL
 *     keys/ store (never the log itself) for each key's CURRENT verified status.
 *
 * KNOWN LIMITATIONS / CALLER CONTRACT (reported honestly, not hidden — these are responsibilities the
 * CALLER must uphold; the logic in this file is correct, but none of it can enforce these FOR you):
 *   1. resumePlan(run_id) only lists keys this run itself called writeCheckpoint for at least once. If a
 *      caller's `claim()` correctly refuses to re-run a task purely because the GLOBAL keys/ store already
 *      shows it done for a matching input_hash (real, correct dedup — see shouldRun/claim below) and the
 *      caller never calls writeCheckpoint again under the new run_id, that skip is real and safe (no
 *      double work happens) but will not appear in that run's own resumePlan listing. Callers that want a
 *      complete per-run audit trail should still call writeCheckpoint (status stays/goes 'done', idempotent
 *      to repeat) even on a skip path.
 *   2. input_hash TOTALITY is the caller's responsibility, not this module's. `input_hash` is an opaque,
 *      caller-supplied string — shouldRun/claim only ever compare it with `===` (plain String() equality);
 *      this module never inspects what it represents or how it was derived. The caller MUST build it from
 *      a real content hash of the FULL set of inputs that determine the outcome of the work (e.g. via the
 *      exported `sha256OfString` over a canonical serialization of every determining input — payload,
 *      config, file contents, etc.), not a hand-picked or reused subset. A reused/lazy/partial input_hash
 *      string across two genuinely DIFFERENT inputs makes shouldRun/claim believe the second (actually
 *      different) unit of work is a replay of the first — it is silently SKIPPED. That is lost/incorrect
 *      work caused by an under-specified input_hash, not a defect in this module's comparison logic.
 *   3. claim() is NOT a distributed lock — single-writer-per-idempotency_key is an ASSUMED precondition,
 *      not something this module enforces. claim() is a plain read-then-write with no cross-process or
 *      cross-thread lock around the shouldRun-check + writeCheckpoint-write pair. If two processes
 *      concurrently call claim() for the SAME idempotency_key before either has committed its 'running'
 *      checkpoint, BOTH can independently observe shouldRun()->should:true and BOTH proceed to run the
 *      real side effect — DOUBLE work, which this module does not detect or prevent. This is safe within
 *      Forge's normal single-process-per-run execution model, but must never be treated as a general
 *      concurrency-safe lock just because an idempotency_key is framed like a Stripe-style key that
 *      "survives a separate later run" — that framing is a real, correct guarantee ACROSS runs, not a
 *      guarantee against CONCURRENT claim() calls within/across processes.
 *   4. "Effectively-once", not exactly-once — the side-effect-then-crash window. If a caller performs the
 *      real side effect and then crashes BEFORE calling writeCheckpoint(..., {status:'done', ...}), a later
 *      resume will find the checkpoint still at (or stuck at) 'running'/'pending' and will legitimately
 *      re-run the side effect — this module has no way to see, or undo, a side effect that already happened
 *      outside of it. Callers MUST do BOTH of the following to get effectively-once delivery: (a) use the
 *      documented claim() two-step (write the 'running' checkpoint BEFORE performing the side effect, so a
 *      crash leaves an honest non-'done' trail behind for resumePlan to flag as unfinished — never perform
 *      the side effect first and checkpoint later), AND (b) make the side effect itself idempotent (safe to
 *      execute twice) for any case where it cannot be strictly ordered after a durable commit point. Neither
 *      step alone is sufficient, and this module provides neither the atomicity of the side effect nor a
 *      lock that would prevent a second attempt from starting in the first place.
 *
 * ATOMICITY / WINDOWS SAFETY: `writeCheckpoint` never writes the destination file directly. It writes a
 * uniquely-named temp file IN THE SAME DIRECTORY as the destination, then commits with fs.renameSync
 * (same directory => same volume => same-dir rename is the atomic commit point on NTFS/ext4/APFS alike).
 * Directly probed on this Windows/Node combo before relying on it (not assumed): fs.renameSync CAN
 * overwrite an existing destination file on Windows — Node/libuv's rename implementation calls
 * MoveFileExW with MOVEFILE_REPLACE_EXISTING under the hood, contrary to the common "Windows rename can't
 * overwrite" myth. A crash injected between the temp-file write and the rename (see the
 * FORGE_CHECKPOINT_TEST_HOOKS-gated `__throwAfterTempWrite` option, used ONLY by
 * forge-checkpoint.test.cjs) therefore never leaves a half-written file at the final path — the
 * destination is either the fully-old bytes or the fully-new bytes, never a mix. A bounded retry
 * (renameWithRetry) tolerates a transient EPERM/EBUSY/EACCES (e.g. a virus scanner or indexer briefly
 * holding the file) with a short native-JS synchronous backoff (Atomics.wait — zero extra dependency).
 *
 * INTEGRITY / "fail closed": every canonical checkpoint file is a `{record, _checksum}` envelope, where
 * `_checksum` is a sha256 over a canonical (recursively key-sorted) JSON serialization of `record`.
 * `readCheckpoint` recomputes that checksum on every read; ANY mismatch, unreadable file, invalid JSON,
 * or malformed envelope returns `{ok:false, reason}` — NEVER a half/guessed record treated as valid. A
 * missing file is reported as `{ok:false, reason:'not_found'}` (not an exception) so callers can branch
 * on it directly.
 *
 * IDEMPOTENCY:
 *   shouldRun(key, inputHash, opts) -> {should, reason}. should:false ONLY when the canonical checkpoint
 *     for `key` reads back OK, has status 'done', AND its input_hash === inputHash (same work, already
 *     done — skip, no double work). Anything else (missing, corrupt/unreadable, status not 'done', or a
 *     DIFFERENT input_hash under the same key) => should:true — fail CLOSED toward "must (re)run", never
 *     toward "trust it, skip it" on uncertain evidence.
 *   claim(key, inputHash, opts, extra) -> {claimed, reason} | {claimed:true, record}. Convenience wrapper:
 *     if shouldRun is false, returns {claimed:false}. Otherwise writes a 'running' checkpoint (so a crash
 *     mid-work leaves an honest 'running' status behind for resumePlan to flag as unfinished, never as
 *     silently done) and returns {claimed:true}. The caller does the real work AFTER a successful claim,
 *     then calls writeCheckpoint(..., {status:'done', output_hash, ...}) itself to finalize.
 *
 * CLI:
 *   node forge-checkpoint.cjs write '<json-record>' [--root <dir>] [--json]
 *   node forge-checkpoint.cjs read <idempotency_key> [--root <dir>] [--json]
 *   node forge-checkpoint.cjs should-run <idempotency_key> <input_hash> [--root <dir>] [--json]
 *   node forge-checkpoint.cjs resume-plan <run_id> [--root <dir>] [--json]
 *   node forge-checkpoint.cjs verify <idempotency_key> [--root <dir>] [--json]
 * Exit codes: write/read/verify: 0 ok / 1 not-ok / 2 usage error. should-run: 0 = SHOULD run (proceed,
 * shell-boolean convention) / 1 = should SKIP / 2 usage error. resume-plan: 0 = complete (nothing to
 * resume) / 3 = resumable (pending work remains, mirrors forge-run-state.cjs's exit convention) / 2 =
 * usage error or unknown run_id.
 *
 * TEST ISOLATION: every function takes an explicit `opts.root` (preferred — no env var needed at all) and
 * the CLI also accepts `--root <dir>`. FORGE_CHECKPOINT_ROOT is an additional env-var override honored
 * only when neither is given, for parity with sibling tools' FORGE_STORE_ROOT/FORGE_PROJECT_ROOT
 * convention. FORGE_CHECKPOINT_TEST_HOOKS=1 gates the `__throwAfterTempWrite` crash-injection option —
 * TEST-ONLY, never active unless that env var is explicitly set (mirrors forge-sync.cjs's
 * FORGE_SYNC_TEST_HOOKS `__throwAfter` pattern).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');
const TEST_HOOKS_ENABLED = process.env.FORGE_CHECKPOINT_TEST_HOOKS === '1';
const VALID_STATUS = new Set(['pending', 'running', 'done', 'failed']);
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

// ---- root / path resolution ----
function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.FORGE_CHECKPOINT_ROOT) return path.resolve(process.env.FORGE_CHECKPOINT_ROOT);
  return PROJECT_ROOT_DEFAULT;
}
function checkpointsBase(root) { return path.join(root, '.claude', 'forge-checkpoints'); }
function assertContained(target, base) {
  const b = path.resolve(base), r = path.resolve(target);
  if (r !== b && !r.startsWith(b + path.sep)) throw new Error('forge-checkpoint: path escapes checkpoints dir — refused');
}
function isValidRunId(id) { return typeof id === 'string' && RUN_ID_RE.test(id); }
// Free-form idempotency keys (may contain ':', '/', etc. as real-world namespacing) are sanitized into a
// safe filename: strip anything outside [A-Za-z0-9_.-], cap the readable prefix, then append a short hash
// of the RAW key so two keys that sanitize to the same prefix (or a key that sanitizes to '' or '..')
// never collide or escape the directory — same "basename + hash suffix" idea as forge-sync.cjs's
// canary-name generator.
function sanitizeKey(rawKey) {
  const s = String(rawKey == null ? '' : rawKey);
  const cleaned = s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const suffix = sha256OfString(s).slice(0, 12);
  return (cleaned || 'key') + '-' + suffix;
}
function keyFilePath(root, key) {
  const base = checkpointsBase(root);
  const file = path.join(base, 'keys', sanitizeKey(key) + '.json');
  assertContained(file, base);
  return file;
}
function runIndexDir(root, runId) {
  const base = checkpointsBase(root);
  const dir = path.join(base, 'runs', runId);
  assertContained(dir, base);
  return dir;
}
function runIndexPath(root, runId) { return path.join(runIndexDir(root, runId), 'index.jsonl'); }

// ---- hashing / canonical serialization (deterministic checksum) ----
function sha256OfString(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}
function canonicalJSON(value) { return JSON.stringify(sortKeysDeep(value)); }
function nowIso() { return new Date().toISOString(); }

// ---- atomic write (same-dir temp file + rename commit) ----
function sleepMs(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch { /* Atomics.wait unavailable (rare) — best-effort no-op, retry loop just spins faster */ }
}
/** renameWithRetry — tolerates a transient Windows sharing violation (EPERM/EBUSY/EACCES, e.g. a virus
 *  scanner briefly holding the temp or destination file) with a short bounded backoff. Any other error
 *  (including ENOENT) is rethrown immediately — this is resilience against transient locks, not a
 *  general-purpose error swallower. */
function renameWithRetry(src, dest, attempts) {
  attempts = attempts || 5;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(src, dest); return; }
    catch (e) {
      const transient = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES';
      if (!transient || i === attempts - 1) throw e;
      sleepMs(15 * (i + 1));
    }
  }
}
/** atomicWriteFile(destPath, buffer, opts) — the ONLY way this module ever writes a checkpoint file.
 *  Writes to a uniquely-named temp file in the SAME directory as destPath (guarantees same volume, which
 *  is required for an atomic rename), then commits via renameWithRetry. `opts.__throwAfterTempWrite`
 *  (only honored when FORGE_CHECKPOINT_TEST_HOOKS=1) throws AFTER the temp bytes land on disk but BEFORE
 *  the rename — simulating a process crash at the most dangerous possible instant. The temp file is
 *  deliberately left behind in that case (a real crash would not clean up either) — it is harmless: it
 *  does not end in '.json' at the expected name, so nothing in this module ever lists it as a checkpoint. */
function atomicWriteFile(destPath, buffer, opts) {
  opts = opts || {};
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, '.' + path.basename(destPath) + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.writeFileSync(tmpPath, buffer);
  if (TEST_HOOKS_ENABLED && opts.__throwAfterTempWrite) {
    throw new Error('forge-checkpoint TEST HOOK: simulated crash after temp write, before rename (tmp left at ' + tmpPath + ')');
  }
  renameWithRetry(tmpPath, destPath);
  return destPath;
}

// ---- record validation ----
/** normalizeRecord(input) -> {ok:true, record} | {ok:false, reason, errors}. Never throws. Required:
 *  run_id (matches ^[A-Za-z0-9_-]+$), idempotency_key (non-empty string). status defaults to 'pending'
 *  and must be one of pending/running/done/failed. files[], if present, must be [{path,hash}, ...]. */
function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'record_must_be_object', errors: ['record must be a JSON object'] };
  const errors = [];
  if (!isValidRunId(input.run_id)) errors.push('run_id must be a non-empty string matching ^[A-Za-z0-9_-]+$');
  if (typeof input.idempotency_key !== 'string' || !input.idempotency_key.trim()) errors.push('idempotency_key must be a non-empty string');
  const status = input.status == null ? 'pending' : input.status;
  if (!VALID_STATUS.has(status)) errors.push('status must be one of: ' + Array.from(VALID_STATUS).join(', '));
  let files = [];
  if (input.files != null) {
    if (!Array.isArray(input.files)) errors.push('files must be an array if present');
    else {
      for (const f of input.files) {
        if (!f || typeof f !== 'object' || typeof f.path !== 'string' || typeof f.hash !== 'string') { errors.push('each files[] entry must be {path, hash} strings'); break; }
      }
      if (!errors.length) files = input.files.map((f) => ({ path: f.path, hash: f.hash }));
    }
  }
  if (errors.length) return { ok: false, reason: 'validation_error', errors };
  const record = {
    run_id: input.run_id,
    work_package_id: input.work_package_id != null ? String(input.work_package_id) : null,
    phase_id: input.phase_id != null ? String(input.phase_id) : null,
    task_id: input.task_id != null ? String(input.task_id) : null,
    attempt_id: input.attempt_id != null ? input.attempt_id : 1,
    idempotency_key: input.idempotency_key,
    input_hash: input.input_hash != null ? String(input.input_hash) : null,
    output_hash: input.output_hash != null ? String(input.output_hash) : null,
    files,
    status,
    proof_refs: Array.isArray(input.proof_refs) ? input.proof_refs.slice() : (input.proof_refs != null ? [input.proof_refs] : []),
    ts: input.ts || nowIso(),
  };
  return { ok: true, record };
}

// ---- core API ----
/** writeCheckpoint(record, opts) -> {ok:true, path, record} | {ok:false, reason, errors?}. Validates,
 *  then ATOMICALLY writes the canonical `keys/<key>.json` envelope (see atomicWriteFile), then appends a
 *  pointer row to this run's `runs/<run_id>/index.jsonl`. A validation failure writes nothing. A crash
 *  during the atomic write (test-only injection) throws BEFORE the index append is ever reached, so the
 *  index never references a checkpoint that didn't actually land. */
function writeCheckpoint(record, opts) {
  opts = opts || {};
  const root = resolveRoot(opts.root);
  const v = normalizeRecord(record);
  if (!v.ok) return v;
  const rec = v.record;
  const file = keyFilePath(root, rec.idempotency_key);
  const envelope = { record: rec, _checksum: sha256OfString(canonicalJSON(rec)), _written: nowIso() };
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  atomicWriteFile(file, bytes, opts); // throws on injected test-hook crash — propagates to caller, index never touched
  appendRunIndex(root, rec);
  return { ok: true, path: file, record: rec };
}

/** appendRunIndex — best-effort append-only pointer log for resumePlan(run_id). A failure here (e.g. an
 *  unwritable runs/ dir) does not undo the already-committed canonical checkpoint; it is surfaced by
 *  letting the exception propagate, since a missing pointer would silently blind resumePlan for this run
 *  — callers should treat a writeCheckpoint throw here as "checkpoint saved, but tell someone the run
 *  index couldn't be updated," not as "nothing happened." */
function appendRunIndex(root, rec) {
  const dir = runIndexDir(root, rec.run_id);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    idempotency_key: rec.idempotency_key,
    work_package_id: rec.work_package_id,
    phase_id: rec.phase_id,
    task_id: rec.task_id,
    ts: rec.ts,
  }) + '\n';
  fs.appendFileSync(path.join(dir, 'index.jsonl'), line, 'utf8');
}

/** readCheckpoint(key, opts) -> {ok:true, record, path} | {ok:false, reason, detail?}. FAIL CLOSED: a
 *  missing file, an unreadable file, invalid JSON, a malformed envelope, or a checksum mismatch ALL return
 *  ok:false — never a partially-trusted record. `reason` is one of: 'not_found', 'unreadable',
 *  'invalid_json', 'malformed_envelope', 'checksum_mismatch'. */
function readCheckpoint(key, opts) {
  opts = opts || {};
  const root = resolveRoot(opts.root);
  const file = keyFilePath(root, key);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? 'not_found' : 'unreadable', detail: e.message }; }
  let envelope;
  try { envelope = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'invalid_json', detail: e.message }; }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !envelope.record || typeof envelope._checksum !== 'string') {
    return { ok: false, reason: 'malformed_envelope' };
  }
  const expected = sha256OfString(canonicalJSON(envelope.record));
  if (expected !== envelope._checksum) return { ok: false, reason: 'checksum_mismatch', detail: 'expected ' + expected + ' got ' + envelope._checksum };
  return { ok: true, record: envelope.record, path: file };
}

/** verify(key, opts) -> {ok, reason?} — a thin, record-free wrapper over readCheckpoint for the CLI's
 *  `verify` subcommand / a caller that only wants a pass/fail integrity signal. */
function verify(key, opts) {
  const r = readCheckpoint(key, opts);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason, detail: r.detail };
}

/** shouldRun(key, inputHash, opts) -> {should, reason}. FAIL CLOSED toward should:true (must run) on any
 *  uncertainty — missing checkpoint, corrupt checkpoint, wrong status, or a different input_hash under
 *  the same key (a real re-run, not a replay) all return should:true. should:false is returned ONLY when
 *  the checkpoint reads back OK, status is 'done', and input_hash matches exactly. */
function shouldRun(key, inputHash, opts) {
  const r = readCheckpoint(key, opts);
  if (!r.ok) return { should: true, reason: 'no_trustworthy_checkpoint:' + r.reason };
  const rec = r.record;
  if (rec.status === 'done' && rec.input_hash === inputHash) return { should: false, reason: 'already_done_same_input' };
  if (rec.status === 'done') return { should: true, reason: 'input_changed_real_rerun' };
  return { should: true, reason: 'not_done_yet:' + rec.status };
}

/** claim(key, inputHash, opts, extra) -> {claimed:false, reason} | {claimed:true, record}. `extra` should
 *  at minimum carry `run_id` (and ideally work_package_id/phase_id/task_id/attempt_id) — it is merged into
 *  the 'running' checkpoint written on a successful claim. If `extra` is missing required fields, the
 *  underlying writeCheckpoint validation failure is surfaced as {claimed:false, reason:'write_failed', ...}
 *  rather than throwing. On claim, this WRITES a 'running' status checkpoint immediately — so if the
 *  caller's real work crashes before it ever calls writeCheckpoint again, the checkpoint honestly shows
 *  'running' (unfinished), which resumePlan surfaces as pending/needs-retry, never as silently done. */
function claim(key, inputHash, opts, extra) {
  const chk = shouldRun(key, inputHash, opts);
  if (!chk.should) return { claimed: false, reason: chk.reason };
  const base = (extra && typeof extra === 'object') ? extra : {};
  const record = Object.assign({}, base, { idempotency_key: key, input_hash: inputHash, status: 'running' });
  const w = writeCheckpoint(record, opts);
  if (!w.ok) return { claimed: false, reason: 'write_failed', detail: w.reason, errors: w.errors };
  return { claimed: true, record: w.record };
}

/** resumePlan(runId, opts) -> {ok:true, run_id, tasks, done, pending, resumable} | {ok:false, reason}.
 *  Replays `runs/<run_id>/index.jsonl` (tolerating a truncated/corrupt trailing line, same defensive
 *  per-line try/catch as forge-run-state.cjs's readEvents) to find every idempotency_key this run has
 *  touched, then asks the CANONICAL keys/ store (readCheckpoint, which fails closed) for each key's
 *  CURRENT verified status — never trusting the index log's own stale copy of status. A key whose
 *  canonical checkpoint is missing or fails integrity verification is classified 'missing'/'corrupt'
 *  respectively and always lands in `pending` (never `done`) — a corrupt checkpoint is NEVER treated as
 *  proof of completion. No run at all (empty/missing index) is a valid, complete (nothing to resume) run,
 *  not an error — only an invalid run_id shape is an error. */
function resumePlan(runId, opts) {
  opts = opts || {};
  if (!isValidRunId(runId)) return { ok: false, reason: 'invalid_run_id' };
  const root = resolveRoot(opts.root);
  const idxFile = runIndexPath(root, runId);
  let raw = null;
  try { raw = fs.readFileSync(idxFile, 'utf8'); } catch { raw = null; }
  const seen = new Map();
  if (raw) {
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      let obj;
      try { obj = JSON.parse(s); } catch { continue; } // tolerate a truncated/corrupt trailing line
      if (obj && typeof obj === 'object' && typeof obj.idempotency_key === 'string' && obj.idempotency_key) {
        seen.set(obj.idempotency_key, obj); // last occurrence wins — most recent pointer for that key
      }
    }
  }
  const tasks = [];
  for (const [key, ptr] of seen) {
    const r = readCheckpoint(key, { root });
    let status, corrupt = false;
    if (!r.ok) {
      status = r.reason === 'not_found' ? 'missing' : 'corrupt';
      corrupt = r.reason !== 'not_found';
    } else {
      status = r.record.status;
    }
    tasks.push({
      idempotency_key: key,
      work_package_id: ptr.work_package_id != null ? ptr.work_package_id : null,
      phase_id: ptr.phase_id != null ? ptr.phase_id : null,
      task_id: ptr.task_id != null ? ptr.task_id : null,
      status, corrupt,
    });
  }
  const done = tasks.filter((t) => t.status === 'done').map((t) => t.idempotency_key);
  const pending = tasks.filter((t) => t.status !== 'done').map((t) => t.idempotency_key);
  return { ok: true, run_id: runId, tasks, done, pending, resumable: pending.length > 0 };
}

module.exports = {
  writeCheckpoint, readCheckpoint, verify, shouldRun, claim, resumePlan,
  atomicWriteFile, renameWithRetry, canonicalJSON, sha256OfString, sortKeysDeep,
  normalizeRecord, isValidRunId, sanitizeKey, keyFilePath, runIndexPath, runIndexDir, checkpointsBase,
  resolveRoot, PROJECT_ROOT_DEFAULT,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, root: null, json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--root') opts.root = rest[++i];
    else if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error("Usage: node forge-checkpoint.cjs write '<json-record>' [--root <dir>] [--json]");
  console.error('       node forge-checkpoint.cjs read <idempotency_key> [--root <dir>] [--json]');
  console.error('       node forge-checkpoint.cjs should-run <idempotency_key> <input_hash> [--root <dir>] [--json]');
  console.error('       node forge-checkpoint.cjs resume-plan <run_id> [--root <dir>] [--json]');
  console.error('       node forge-checkpoint.cjs verify <idempotency_key> [--root <dir>] [--json]');
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const fnOpts = { root: opts.root };
    const validCmds = ['write', 'read', 'should-run', 'resume-plan', 'verify'];
    if (!opts.cmd || !validCmds.includes(opts.cmd)) {
      printUsage();
      process.exitCode = 2;
    } else if (opts.cmd === 'write') {
      const json = opts.positional[0];
      if (!json) { console.error('forge-checkpoint: write requires a JSON record argument'); process.exitCode = 2; }
      else {
        let input;
        try { input = JSON.parse(json); }
        catch (e) { console.error('forge-checkpoint: invalid JSON: ' + e.message); process.exitCode = 1; input = undefined; }
        if (input !== undefined) {
          const r = writeCheckpoint(input, fnOpts);
          if (opts.json) console.log(JSON.stringify(r));
          else console.log(r.ok ? ('written: ' + r.path) : ('ERROR: ' + r.reason + (r.errors ? ' (' + r.errors.join('; ') + ')' : '')));
          process.exitCode = r.ok ? 0 : 1;
        }
      }
    } else if (opts.cmd === 'read') {
      const key = opts.positional[0];
      if (!key) { console.error('forge-checkpoint: read requires <idempotency_key>'); process.exitCode = 2; }
      else {
        const r = readCheckpoint(key, fnOpts);
        if (opts.json) console.log(JSON.stringify(r));
        else console.log(r.ok ? JSON.stringify(r.record, null, 2) : ('NOT OK: ' + r.reason));
        process.exitCode = r.ok ? 0 : 1;
      }
    } else if (opts.cmd === 'should-run') {
      const key = opts.positional[0], inputHash = opts.positional[1];
      if (!key || inputHash === undefined) { console.error('forge-checkpoint: should-run requires <idempotency_key> <input_hash>'); process.exitCode = 2; }
      else {
        const r = shouldRun(key, inputHash, fnOpts);
        if (opts.json) console.log(JSON.stringify(r));
        else console.log((r.should ? 'RUN' : 'SKIP') + ' — ' + r.reason);
        process.exitCode = r.should ? 0 : 1;
      }
    } else if (opts.cmd === 'resume-plan') {
      const runId = opts.positional[0];
      if (!runId) { console.error('forge-checkpoint: resume-plan requires <run_id>'); process.exitCode = 2; }
      else {
        const r = resumePlan(runId, fnOpts);
        if (!r.ok) { console.error('forge-checkpoint: ' + r.reason); process.exitCode = 2; }
        else {
          if (opts.json) console.log(JSON.stringify(r));
          else {
            console.log('forge checkpoint resume-plan · ' + runId + (r.resumable ? ' · RESUMABLE' : ' · COMPLETE'));
            console.log('  done: ' + r.done.length + '  pending: ' + r.pending.length);
            for (const t of r.tasks) console.log('  [' + t.status + (t.corrupt ? '·CORRUPT' : '') + '] ' + t.idempotency_key);
          }
          process.exitCode = r.resumable ? 3 : 0;
        }
      }
    } else if (opts.cmd === 'verify') {
      const key = opts.positional[0];
      if (!key) { console.error('forge-checkpoint: verify requires <idempotency_key>'); process.exitCode = 2; }
      else {
        const r = verify(key, fnOpts);
        if (opts.json) console.log(JSON.stringify(r));
        else console.log(r.ok ? 'OK' : ('NOT OK: ' + r.reason));
        process.exitCode = r.ok ? 0 : 1;
      }
    }
  } catch (e) {
    console.error('forge-checkpoint: ' + e.message);
    process.exitCode = 1;
  }
}
