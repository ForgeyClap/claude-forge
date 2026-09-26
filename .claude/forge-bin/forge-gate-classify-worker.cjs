#!/usr/bin/env node
'use strict';
/**
 * forge-gate-classify-worker.cjs — the worker_threads ENTRY POINT forge-gate-watchdog.cjs spawns (wp-v1/wp-v3,
 * run forge-2026-09-24-codex-fixes). Runs the WHOLE inspection pipeline (forge-gate-inspect.cjs::inspect() —
 * stripInertData, selfDisable, classify, the destructive-delete raw recheck, scratchPassThrough) on a separate
 * V8 isolate — moved here in wp-v3 (sec-v1r-H1/L2) after wp-v1/wp-v2 only ever protected the classify() step
 * itself, leaving stripInertData() (a separately confirmed super-linear cost on harmless input, see
 * forge-gate-data.cjs's own header) and the destructive-delete/scratch steps unguarded on the main thread. See
 * forge-gate-watchdog.cjs's header for the full design and the SharedArrayBuffer wire format this file writes.
 *
 * opts.simulateSlowMs (TEST SEAM ONLY — wp-v1's own requirement: "a test seam that makes classification
 * deliberately slow on a harmless command, e.g. an injected delay"): a synchronous busy-wait run BEFORE
 * inspect(), long enough that a small watchdogTimeoutMs in a test reliably times out without waiting the real
 * 6s production budget. Never set outside a test.
 *
 * opts.simulateCrash (TEST SEAM ONLY — sec-v1 M1, independent review): exits this worker immediately, before
 * writeResult() ever runs, so a test can exercise a GENUINE worker crash (never writes to the shared buffer, so
 * the main thread's watchdog-timeout/no-result fallback fires for real) rather than only a slow-but-alive
 * worker. Never set outside a test.
 */
const { workerData, isMainThread } = require('worker_threads');

const HEADER_INT32S = 2; // [0] = status (0 pending, 1 done), [1] = payload byte length
const HEADER_BYTES = HEADER_INT32S * 4;

/** writeResult(sab, payloadObj) -> void. Encodes payloadObj as UTF-8 JSON into the shared buffer's payload
 *  region and flips status to done, waking up the main thread's Atomics.wait(). A payload too large for the
 *  buffer (should never happen for a full verdict object or a 300-char-capped error string) degrades to a
 *  short, guaranteed-to-fit error object rather than corrupting the buffer. */
function writeResult(sab, payloadObj) {
  const state = new Int32Array(sab, 0, HEADER_INT32S);
  const maxLen = sab.byteLength - HEADER_BYTES;
  let encoded = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  if (encoded.length > maxLen) {
    encoded = Buffer.from(JSON.stringify({ ok: false, error: 'watchdog-payload-too-large' }), 'utf8');
  }
  const bytes = new Uint8Array(sab, HEADER_BYTES, maxLen);
  bytes.set(encoded);
  Atomics.store(state, 1, encoded.length);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
}

function run() {
  const { command, ctx, simulateSlowMs, simulateCrash, simulateInspectThrow, sab } = workerData;
  if (simulateCrash) process.exit(7); // test seam only -- a real crash, before any writeResult() ever runs
  if (typeof simulateSlowMs === 'number' && simulateSlowMs > 0) {
    const until = Date.now() + simulateSlowMs;
    while (Date.now() < until) { /* deliberate synchronous busy-wait — test seam only, never set in production */ }
  }
  // sec-v3r L2 (independent re-review): the ORIGINAL single try/catch here tagged classifierUnavailable:true for
  // ANY throw, including one from INSIDE a successfully-loaded inspect() call itself (e.g. a bug in
  // scratchPassThrough, or any other genuinely unexpected runtime error during a WORKING classifier's own
  // execution) -- that is not an honest description of what happened: the classifier loaded fine and ran, it
  // just failed partway through. Split into two SEPARATE tries so each failure is tagged for what it actually
  // is. The first LOADS everything inspect() depends on (forge-gate-inspect.cjs itself, plus forcing
  // forge-actiongate.cjs + hard-gates.json to load/parse now rather than lazily inside inspect()) without
  // running any real classification yet -- a throw HERE means the classifier truly cannot run at all (a broken/
  // missing hard-gates.json, a broken forge-actiongate.cjs, or forge-gate-inspect.cjs/its dependencies
  // themselves missing), tagged classifierUnavailable so the main thread maps it to the pre-wave-13
  // classifier-unavailable branch (FALLBACK_RE + honest wording). The second try runs the REAL inspect() call
  // using those already-proven-loadable pieces; a throw HERE is an unexpected internal error DURING a working
  // classifier's own execution -- left UNTAGGED, so evaluate() maps it to the generic watchdog/BLOCK path
  // instead of falsely claiming the classifier itself is unavailable.
  let INSPECT;
  try {
    INSPECT = require('./forge-gate-inspect.cjs');
    // forge-actiongate.cjs's own loadGates() is LAZY (hard-gates.json is only read/parsed the first time it is
    // actually called, never at require() time) -- a bare require('./forge-actiongate.cjs') here would prove
    // nothing about whether hard-gates.json itself is readable/valid JSON/well-shaped. Calling loadGates()
    // directly, with the SAME configPath ctx.configPath would make inspect() use (the same test-seam reach
    // classify() has always had), forces that real read+parse+validate to happen HERE, and its own internal
    // cache (keyed by resolved path) means inspect()'s own later classify() call reuses this exact result
    // rather than re-parsing.
    require('./forge-actiongate.cjs').loadGates(ctx && ctx.configPath);
  } catch (e) {
    writeResult(sab, { ok: false, classifierUnavailable: true, error: String((e && e.message) || e).split('\n')[0].slice(0, 300) });
    return;
  }
  try {
    // TEST SEAM ONLY (sec-v3r L2): simulates an unexpected runtime error INSIDE a successfully-loaded
    // inspect() call — proves this specific throw is left UNTAGGED (never classifierUnavailable). Never set
    // outside a test.
    if (simulateInspectThrow) throw new Error('simulated-inspect-runtime-error');
    const verdict = INSPECT.inspect(command, ctx);
    writeResult(sab, { ok: true, verdict });
  } catch (e) {
    writeResult(sab, { ok: false, error: String((e && e.message) || e).split('\n')[0].slice(0, 300) });
  }
}

// WP-S4 (v2.8.0 laptop-audit Part VI): running this file directly (`node forge-gate-classify-worker.cjs`)
// printed a raw stack trace — `workerData` is `null` outside a real Worker context, so `run()`'s own
// destructure (`const { command, ctx, ... } = workerData`) threw uncaught. `require.main === module` cannot
// tell the two apart (a `new Worker(filename)` also makes that file its OWN main module) — `isMainThread` is
// the correct discriminator: false inside any real Worker, true only on the actual process entry thread.
if (isMainThread) {
  console.error('forge-gate-classify-worker.cjs is a worker_threads entry point spawned by forge-gate-watchdog.cjs — it is a library, not a CLI. Run node forge-gate-hook.cjs instead.');
  process.exit(1);
} else {
  run();
}
