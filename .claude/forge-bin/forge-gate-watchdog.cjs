#!/usr/bin/env node
'use strict';
/**
 * forge-gate-watchdog.cjs — a HARD wall-clock guarantee that forge-gate-hook.cjs's classify() step always
 * returns a verdict well inside Claude Code's own external hook timeout (wp-v1, wave 13, run
 * forge-2026-09-24-codex-fixes, security probe `_scratch/lead-probe-secl17-m1.log`). Before this file existed,
 * DEADLINE_MS (forge-gate-hook.cjs) was only ever compared AFTER classify() returned — useless against a
 * synchronous regex that does not return in time at all — and the file's own SB-M5 comment already named the
 * consequence: "a call that gets no exit code in time is a call the hook never blocked."
 *
 * ROOT CAUSE (measured 2026-09-25, wp-v1): the opaque-exec gate's `match.pattern_line` first alternative — a
 * pipe, optional whitespace, an optional `env` prefix and an optional path prefix (each prefix spelled as
 * "zero-or-more non-whitespace characters then a literal slash") before `(sh|bash|...)` in hard-gates.json —
 * has two of those "non-whitespace-run then slash" quantifiers that must each backtrack character-by-character
 * searching for a literal slash that, on an adversarial "dense pipe characters with no interpreter word
 * anywhere" input, never appears; that costs O(remaining length) at EVERY one of the O(n) pipe-start
 * positions, i.e. O(n^2) overall: 40,000 chars -> 2,289ms; 100,000 chars -> 14,257ms; 190,000 chars ->
 * 51,566ms (matches the Lead's independently measured 2.4s/14.5s/52s exactly). A rewrite attempt (turning the
 * optional "non-whitespace-run then slash" into a repeated, slash-excluding "segment then slash" loop — the
 * standard "unrolled loop" ReDoS fix) was tried and REJECTED: it did not help, because the pathological cost
 * comes from the segment scanning all the way to the end of the string looking for a slash that is not there
 * at all, which the character-class change does not bound. A LENGTH-bounded version of that same quantifier
 * WOULD fix the timing, but silently narrows opaque-exec's coverage for a legitimate (if unrealistic)
 * very-long-path interpreter invocation — a security-relevant behaviour change too risky to ship inside this
 * work package without independent review. Left AS-IS in hard-gates.json.
 *
 * CORRECTED CLAIM (sec-v1 M2, independent review): wp-v1 originally said "only opaque-exec's pattern_line is
 * affected" — that was an OVERCLAIM. What was actually measured in wp-v1: on the SAME dense/sparse-pipe
 * adversarial shapes, kill-by-name/destructive-delete/git-destructive all stayed under 20ms up to 190,000
 * chars — but that only rules those three gates out for THAT ONE adversarial shape, not for their OWN
 * worst-case shape. The reviewer was right to distrust it: kill-by-name's own `match.pattern_line` (a
 * `grep`/`pgrep`/`pidof` piped through `xargs` into `kill`, and a separate `Get-Process`/`gps`/`ps` piped into
 * `Stop-Process`/`kill` alternative) has TWO independently confirmed super-linear shapes, found with entirely
 * BENIGN, non-killing input (a search command with many repeated `| xargs echo` stages and no "kill" word
 * anywhere; and many repeated bare `ps aux` anchors with no pipe/Id/InputObject flag): the `xargs` shape is
 * WORSE than opaque-exec's — 5,000 chars -> 67ms, 10,000 -> 503ms, 20,000 -> 4,028ms, 40,000 -> 31,878ms; the
 * `ps`-repeat shape is milder but still quadratic — 40,000 -> 336ms, 100,000 -> 2,109ms, 190,000 -> 7,742ms
 * (already over this project's own "under 7s" bar on its own). This is exactly why a single size threshold
 * calibrated on one gate's worst case can never be trusted for every gate — see the THRESHOLD section below,
 * now removed in favour of routing every command through this watchdog whenever it is available.
 *
 * DESIGN — worker_threads Worker + Atomics.wait, NOT async/Promises. forge-gate-hook.cjs's public API
 * (decide/evaluate/run) is used SYNCHRONOUSLY by its own CLI and by every existing test; converting it to
 * Promise-returning would ripple through the whole test suite and stdin handler. Node explicitly PERMITS
 * Atomics.wait() to block a process's own main thread (unlike browsers, which forbid it on the UI thread). A
 * worker_threads Worker runs the WHOLE inspection pipeline (forge-gate-inspect.cjs::inspect() — stripInertData,
 * selfDisable, classify, the destructive-delete raw recheck, scratchPassThrough; moved here in wp-v3, see that
 * file's own header) on a genuinely separate V8 isolate; the main thread's `Atomics.wait(state, 0, 0,
 * timeoutMs)` blocks until EITHER the worker posts its result into the shared buffer OR the timeout elapses,
 * whichever comes first — a runaway synchronous regex ANYWHERE in that pipeline can never hold the main thread
 * hostage past the caller-supplied budget. decide()/evaluate()/run() keep their exact synchronous signature.
 *
 * WIRE FORMAT (SharedArrayBuffer, written by forge-gate-classify-worker.cjs): Int32 [0] status (0 pending, 1
 * done), Int32 [1] payload byte length, then up to PAYLOAD_BYTES of UTF-8 JSON — `{ok:true,verdict:{block,
 * gates,reason,notice,why}}` (the COMPLETE evaluate()-shaped verdict, wp-v3) on success or `{ok:false,error}` on
 * a worker-side exception. Measured worst case (all four command gates named in one `reason` string): ~2.9 KB —
 * PAYLOAD_BYTES leaves more than 2.8x headroom over that.
 *
 * NO SIZE THRESHOLD (sec-v1 M2, independent review — REMOVED from the original wp-v1 design). wp-v1 originally
 * only routed a command ABOVE a 20,000-char INLINE_THRESHOLD_CHARS through this watchdog, calibrated on
 * opaque-exec's own worst-case curve alone (15,000 chars -> 331ms, 20,000 -> 579ms, 25,000 -> 909ms). The
 * reviewer correctly distrusted a single per-gate threshold: kill-by-name's OWN pattern_line has an even worse,
 * previously-unmeasured shape (see the CORRECTED CLAIM above) that a 20,000-char cutoff would have let straight
 * through, unprotected, on the inline path. Measured fix cost instead: routing EVERY command through this
 * watchdog (5 runs each, git status / npm run build / node --version / ls -la / a 2kB commit message) added
 * ~24-27ms average latency versus the pre-existing inline-only path (was ~0.6-4ms, now ~27-28ms) — comfortably
 * under the ~40ms bar set for this fix, and a real worker_threads Worker spawn alone (measured, 8 runs) costs
 * ~17-21ms cold, which is most of that delta. forge-gate-hook.cjs's evaluate() now calls classifyWithWatchdog()
 * for every command whenever this module is available (opts.gate — an injected test-stub classifier — is the
 * only thing that still forces the inline path, since a function cannot cross a Worker boundary). When this
 * module or worker_threads itself is UNAVAILABLE, forge-gate-hook.cjs falls back to a conservative, separately
 * named ceiling (wp-v3, sec-v1r L1: WATCHDOG_UNAVAILABLE_FALLBACK_CHARS, lowered from 20,000 to 10,000 — see
 * that file's own comment for the measured justification) rather than silently running an unbounded inline
 * classification.
 *
 * wp-v3 (sec-v1r-H1/L2) — WHAT MOVED INTO THE WORKER. classifyWithWatchdog(command, ctx) now takes the RAW
 * command text and a plain, structured-cloneable `ctx` (shell/cwd/root/protectedRoots/tmp/platform/configPath —
 * see forge-gate-inspect.cjs's own header for the exact shape) instead of the already-stripped text and a bare
 * {matched,gate} contract. The worker runs forge-gate-inspect.cjs::inspect() — the WHOLE pipeline — and returns
 * the complete verdict; nothing about WHAT gets classified changes on the main thread beyond building this one
 * plain ctx object. The main thread now does ONLY: read stdin, apply the cheap top-level size ceiling, run the
 * watchdog (or the explicitly-bounded fallback), map the result, and the parts that must stay on the main
 * thread because they write state (gateHookEnabled()'s config read, and decide()'s once-approval consumption).
 */
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

const WORKER_SCRIPT = path.join(__dirname, 'forge-gate-classify-worker.cjs');
const HEADER_INT32S = 2;
const HEADER_BYTES = HEADER_INT32S * 4;
const PAYLOAD_BYTES = 8192; // comfortably larger than any real gate-id list or the 300-char-capped error string

const WATCHDOG_TIMEOUT_MS = 6000;

/** classifyWithWatchdog(command, ctx) -> { ok:true, verdict } | { ok:false, why, error? }. `ctx` carries the
 *  plain, structured-cloneable inspection context (see forge-gate-inspect.cjs's own header for the exact shape)
 *  PLUS the test-seam fields below. GENUINELY never throws (sec-v1 M1, independent review): the ENTIRE body
 *  below runs inside one try/catch, so a worker spawn failure, a timeout, an unparseable/corrupt payload, OR an
 *  environment-level failure (SharedArrayBuffer construction refused, Atomics.wait itself throwing, or anything
 *  else unforeseen) all resolve to the SAME ok:false contract — never propagate to the caller
 *  (forge-gate-hook.cjs::evaluate()), which maps every ok:false to the existing "too large / too slow to
 *  inspect" BLOCK. ctx.watchdogTimeoutMs/ctx.simulateSlowMs/ctx.simulateCrash/ctx.simulateInspectThrow/
 *  ctx.WorkerImpl/ctx.SharedArrayBufferImpl/ctx.atomicsWait are test seams only. */
function classifyWithWatchdog(command, ctx) {
  ctx = ctx || {};
  try {
    const timeoutMs = typeof ctx.watchdogTimeoutMs === 'number' ? ctx.watchdogTimeoutMs : WATCHDOG_TIMEOUT_MS;
    const SharedArrayBufferImpl = ctx.SharedArrayBufferImpl || SharedArrayBuffer;
    const atomicsWait = ctx.atomicsWait || Atomics.wait;
    const sab = new SharedArrayBufferImpl(HEADER_BYTES + PAYLOAD_BYTES);
    const state = new Int32Array(sab, 0, HEADER_INT32S);
    Atomics.store(state, 0, 0);
    Atomics.store(state, 1, 0);

    const WorkerImpl = ctx.WorkerImpl || Worker;
    // wp-v4 (sec-v3 M1, "the watchdog and worker included"): a missing/deleted forge-gate-classify-worker.cjs
    // does NOT make `new Worker(...)` throw synchronously -- Node fails to start the thread ASYNCHRONOUSLY,
    // which the swallowed 'error' handler below would otherwise turn into a full WATCHDOG_TIMEOUT_MS wait before
    // resolving. A cheap, synchronous existence check (real Worker only -- never applied to an injected test
    // WorkerImpl) lets this ONE specific, detectable failure fail fast instead of waiting the full budget.
    if (WorkerImpl === Worker && !fs.existsSync(WORKER_SCRIPT)) {
      return { ok: false, why: 'worker-script-missing' };
    }
    let worker;
    try {
      worker = new WorkerImpl(WORKER_SCRIPT, {
        workerData: {
          command,
          // the plain inspection context inspect() needs -- never includes ctx.gate (a function, which cannot
          // cross a Worker boundary; the caller never sets useWatchdog when opts.gate is present anyway).
          ctx: {
            shell: ctx.shell, cwd: ctx.cwd, root: ctx.root, protectedRoots: ctx.protectedRoots,
            tmp: ctx.tmp, platform: ctx.platform, configPath: ctx.configPath || null,
          },
          simulateSlowMs: ctx.simulateSlowMs || 0,
          simulateCrash: !!ctx.simulateCrash,
          simulateInspectThrow: !!ctx.simulateInspectThrow, // sec-v3r L2 test seam — never set outside a test
          sab,
        },
      });
    } catch (e) {
      return { ok: false, why: 'worker-spawn-failed', error: String((e && e.message) || e) };
    }
    // A worker-side error (a bad require, an unhandled throw before writeResult runs) must never hang the wait —
    // it simply never flips status to 1, so Atomics.wait below times out and falls through to the block verdict
    // exactly like any other failure; the empty handler only stops Node from crashing on an unhandled 'error'.
    // KNOWN, INHERENT LIMIT (wp-v4, sec-v3 M1): this cannot be woken early from here the way a real worker wakes
    // it via Atomics.notify() — Atomics.wait() blocks THIS thread at the OS/V8 level, so this thread's own event
    // loop (where this handler runs) never gets to execute until the wait already returns; a worker that fails
    // to START at all (e.g. a corrupted, syntactically-invalid script file rather than a missing one, which the
    // existsSync check above cannot catch) still resolves only via the full timeoutMs below — SAFE (it still
    // reaches the same fail-closed BLOCK) but not fast. This is not a new gap: ANY worker startup failure has
    // always been bound by this since wp-v1; only the cheaply-detectable MISSING-file case was worth a fast path.
    worker.on('error', () => {});
    if (typeof worker.unref === 'function') worker.unref();

    const waitResult = atomicsWait(state, 0, 0, timeoutMs);
    const status = Atomics.load(state, 0);
    const stopWorker = () => { try { worker.terminate(); } catch { /* best-effort cleanup only */ } };

    if (status !== 1) {
      stopWorker();
      return { ok: false, why: waitResult === 'timed-out' ? 'watchdog-timeout' : 'watchdog-no-result' };
    }
    const len = Atomics.load(state, 1);
    stopWorker();
    if (!Number.isInteger(len) || len < 0 || len > PAYLOAD_BYTES) {
      return { ok: false, why: 'watchdog-payload-corrupt' };
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(new Uint8Array(sab, HEADER_BYTES, len)).toString('utf8'));
    } catch {
      return { ok: false, why: 'watchdog-payload-unparseable' };
    }
    if (!parsed || parsed.ok !== true) {
      // sec-v3 L1: forward the worker's own classifier-unavailable tag unchanged so evaluate() can route to the
      // pre-wave-13 branch instead of the generic too-large BLOCK — see forge-gate-classify-worker.cjs's header.
      return { ok: false, why: 'worker-classify-error', classifierUnavailable: !!(parsed && parsed.classifierUnavailable), error: parsed && parsed.error };
    }
    return { ok: true, verdict: parsed.verdict };
  } catch (e) {
    // sec-v1 M1: the catch-all that makes "never throws" actually true -- see the doc comment above.
    return { ok: false, why: 'watchdog-internal-error', error: String((e && e.message) || e).split('\n')[0] };
  }
}

module.exports = { classifyWithWatchdog, WATCHDOG_TIMEOUT_MS, WORKER_SCRIPT };
