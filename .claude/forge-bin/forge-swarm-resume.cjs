#!/usr/bin/env node
'use strict';
/**
 * forge-swarm-resume.cjs — mission-level swarm AUTO-RESUME (WAVE D / D1, 2026-07-18). The #1 owner pain
 * this piece exists for: a session/usage limit kills a big swarm mid-run and work is lost. This gives one
 * command that re-dispatches ONLY the unfinished work packages, reconstructed honestly from what a run's
 * `.claude/forge-runs/<run_id>/manifest.json` (see `forge-manifest.cjs`) says was ARMED plus what
 * `events.jsonl` actually logged since.
 *
 * NAMING NOTE (real collision, not a WP shortcut): the work package that requested this piece named the
 * file `forge-resume.cjs`. That exact filename ALREADY EXISTS in this project (untracked, pre-existing —
 * `git log` shows no prior commit for it) as a completely different, unrelated tool: a GLOBAL
 * cross-session checkpoint/to-do reminder CLI keyed by a home-directory state file
 * (`<home>/.claude/FORGE_RESUME_STATE.json`), with no `module.exports` at all (a top-level argv switch),
 * consumed by the usage-guard hook after an auto-resume. Overwriting it would destroy real, unrelated,
 * already-built functionality this file has nothing to do with. This piece is named
 * `forge-swarm-resume.cjs` instead to avoid that collision — flagged explicitly for Head Chef / D-integrate
 * to confirm/rename if a different final name is preferred.
 *
 * MODEL:
 *   resume({run_id}, opts) -> {run_id, unfinished, done, plan, resumable}. Internally calls
 *   `forge-manifest.cjs::reconcile({run_id}, opts)` (never re-implements the event-projection logic) and
 *   returns ONLY the not-done work packages (`status !== 'done'`, i.e. "armed" or "failed") with their
 *   original `narrowed_prompt`/`deps` so the caller can re-dispatch each one exactly as originally scoped.
 *   A `done` WP is NEVER re-dispatched — returned separately, purely for the caller's own reporting.
 *   `plan` is a short human-readable summary of what would be re-run (a string, not an executed action —
 *   this module has ZERO side effects beyond what `reconcile()` itself persists to manifest.json).
 *   Throws exactly when `forge-manifest.cjs::reconcile` throws (invalid run_id, or no manifest was ever
 *   armed for this run via `arm()`) — never silently returns an empty/fabricated resume plan.
 *
 * COMPOSITION (reference, not duplication): this file does NOT read usage-guard state or checkpoint
 * idempotency itself. A caller that wants "don't resume while usage-guard has us paused" should check
 * `usage-guard.cjs status` first; a caller re-dispatching a side-effecting WP (email/deploy/payment/etc.)
 * should still use `forge-checkpoint.cjs::shouldRun/claim` for that WP's own idempotency key before
 * repeating the real side effect — `resume()` only tells you WHICH work packages are unfinished, it does
 * not itself guard against double-running a side effect a WP's own re-dispatch might trigger.
 *
 * EVENT LOGGING (caller's responsibility, not this file's): this module is zero-dependency and does not
 * shell out to `log-event.cjs` itself (keeps it a pure library call, and avoids `log-event.cjs`'s STRICT
 * agent-registry/dispatch-proof checks firing on a plain library read). The orchestration layer that
 * actually re-dispatches a returned `unfinished` WP should log a `wp_resumed` event per WP, and whatever
 * called `forge-manifest.cjs::arm()` at swarm-dispatch time should log a `manifest_armed` event — both are
 * NEW event_type names this piece needs registered in `log-event.cjs`'s KNOWN_EVENT_TYPES (declared, not
 * wired here — see the SHARED-FILE RULE for this wave).
 *
 * CLI:
 *   node forge-swarm-resume.cjs --run <id> [--json]
 * Exit codes: 0 = complete (nothing to resume) · 3 = resumable (unfinished work packages remain, mirrors
 * forge-checkpoint.cjs's resume-plan convention) · 2 = usage error (bad run_id, or no manifest ever armed).
 */
const manifestMod = require('./forge-manifest.cjs');

/** resume({run_id}, opts) -> {run_id, unfinished, done, plan, resumable}. See file header MODEL section. */
function resume(input, opts) {
  opts = opts || {};
  input = input || {};
  const runId = input.run_id;
  if (!manifestMod.isValidRunId(runId)) throw new Error('forge-swarm-resume: resume requires a valid run_id');

  const r = manifestMod.reconcile({ run_id: runId }, opts); // throws if no manifest armed for this run

  const unfinished = r.unfinished.map((wp) => ({
    wp_id: wp.wp_id, agent: wp.agent, status: wp.status,
    narrowed_prompt: wp.narrowed_prompt, deps: wp.deps, last_proof: wp.last_proof,
  }));
  const done = r.done.map((wp) => ({ wp_id: wp.wp_id, agent: wp.agent, status: wp.status, last_proof: wp.last_proof }));

  const plan = unfinished.length === 0
    ? 'nothing to resume — all ' + r.manifest.length + ' work package(s) already done'
    : 're-dispatch ' + unfinished.length + ' of ' + r.manifest.length + ' work package(s): ' + unfinished.map((w) => w.wp_id + ' (' + w.status + ')').join(', ');

  return { run_id: runId, unfinished, done, plan, resumable: unfinished.length > 0 };
}

module.exports = { resume };

// ---- CLI ----
function parseArgs(argv) {
  const opts = { run: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') opts.run = argv[++i];
    else if (a === '--json') opts.json = true;
  }
  return opts;
}
function printUsage() { console.error('Usage: node forge-swarm-resume.cjs --run <id> [--json]'); }

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (!opts.run) { printUsage(); process.exitCode = 2; }
    else {
      const r = resume({ run_id: opts.run }, {});
      if (opts.json) {
        console.log(JSON.stringify(r));
      } else {
        console.log('forge-swarm-resume · ' + r.run_id + (r.resumable ? ' · RESUMABLE' : ' · COMPLETE'));
        console.log('  ' + r.plan);
        console.log('  done: ' + r.done.length + '  unfinished: ' + r.unfinished.length);
        for (const w of r.unfinished) console.log('  [' + w.status + '] ' + w.wp_id + ' (' + w.agent + ') <- ' + w.narrowed_prompt);
      }
      process.exitCode = r.resumable ? 3 : 0;
    }
  } catch (e) {
    console.error('forge-swarm-resume: ' + e.message);
    process.exitCode = 2;
  }
}
