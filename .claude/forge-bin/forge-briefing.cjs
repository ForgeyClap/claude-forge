#!/usr/bin/env node
'use strict';
/**
 * forge-briefing.cjs — Nightshift MORNING BRIEFING generator (piece J5, 2026-07-19). PURPOSE: give the
 * owner a real, evidenced answer to "what happened while I was away?" for a single run: what actually
 * finished, what's blocked, and what only the owner can decide next. This is the REAL, TESTABLE CORE the
 * `forge-nightshift` skill's doctrine depends on — the skill describes the overnight *process*; this file
 * is the one piece of it that is an actual runnable, tested tool.
 *
 * Zero-dependency (fs/path only, plus the sibling `forge-manifest.cjs` module — this file NEVER
 * reimplements manifest projection, event-chain reading, or run-root resolution; it composes the exact
 * functions `forge-swarm-resume.cjs` already reuses).
 *
 * HONESTY CORE (no fabrication): `generate()` is a PURE PROJECTION of what a run's own
 * `.claude/forge-runs/<run_id>/manifest.json` (if one was ever armed) and `events.jsonl` already say.
 * It never infers completion from a file that "looks right", never invents a decision that wasn't backed
 * by a real logged event/WP record, and never pads an empty run into a fake-looking briefing — a run with
 * no manifest and no events produces an honestly EMPTY briefing (0 ran, 0 blocked, 0 decisions), never an
 * error and never fabricated content. A `_forge_verify.proof_verified === false` event (log-event.cjs's
 * own CONTENT ORACLE stamp — a disproven "done" claim) is excluded from `ran`/`blocked`, exactly the same
 * disqualification `forge-manifest.cjs::projectManifest`/`eventIsDisproven` already apply — never
 * reimplemented here, only reused.
 *
 * WHAT COUNTS AS "RAN" vs "BLOCKED" (see MODEL below for the exact field shapes):
 *   1. If `run_id` ever had a manifest armed (`forge-manifest.cjs::arm()`), that manifest is reconciled
 *      fresh against the run's current `events.jsonl` (via `forge-manifest.cjs::reconcile`, never a second
 *      hand-rolled projection): `done` WPs -> ran, `failed` WPs -> blocked, and any WP that never got a
 *      `wp_completed`/`check_passed`/`wp_failed`/`check_failed` event at all stays "armed" (unfinished) ->
 *      also surfaces under blocked (the session simply ended before it ran) AND under decisions-needed
 *      ("resume, reprioritize, or drop?").
 *   2. Independently, `events.jsonl` is scanned for RAN_EVENT_TYPES / BLOCKED_EVENT_TYPES. An event with a
 *      `wp_id` already accounted for by the reconciled manifest is skipped here (the manifest is
 *      authoritative for a WP it tracks — never double-listed); an agent-level event with no `wp_id`
 *      (e.g. `agent_completed`, `agent_failed`) is always included, since no manifest tracks it.
 *
 * DECISIONS NEEDED: one entry per `blocked` item, phrased as the real, concrete choice the owner (not the
 * agent) must make — retry/reassign/drop for a failure, resume/reprioritize/drop for an unfinished WP.
 * Never a generic "review this" placeholder; always references the real wp_id/agent/event_type/timestamp
 * it was derived from.
 *
 * MODEL:
 *   generate({run_id}, opts) -> {
 *     ok, run_id, generated_at, manifest_present, events_count,
 *     ran: [{source, wp_id, agent, event_type, ts, detail}, ...],
 *     blocked: [{source, wp_id, agent, event_type, ts, detail, reason}, ...],
 *     decisions_needed: [{wp_id, agent, reason, detail}, ...],
 *     markdown, notes: [...]
 *   }
 *   Throws only on a usage error: missing/invalid run_id (mirrors forge-manifest.cjs::isValidRunId).
 *   opts.root — project root override (forge-manifest.cjs::resolveRoot convention).
 *   opts.now — Date override for `generated_at` (test determinism).
 * toMarkdown(result) -> the rendered morning-briefing markdown (also returned inline as result.markdown).
 *
 * CLI:
 *   node forge-briefing.cjs <run_id> [--json]        (positional form — matches commands/forge.md:22)
 *   node forge-briefing.cjs --run <id> [--json]       (equivalent flag form)
 * Exit codes: 0 = briefing generated (an honestly-empty briefing is still success) · 2 = usage error
 * (missing/invalid run id).
 */
const manifestMod = require('./forge-manifest.cjs');

const RAN_EVENT_TYPES = new Set([
  'wp_completed', 'check_passed', 'quality_gate_passed', 'codex_review_completed',
  'agent_completed', 'e2e_passed', 'integration_gate_passed',
]);
const BLOCKED_EVENT_TYPES = new Set([
  'wp_failed', 'check_failed', 'quality_gate_blocked', 'codex_blocked', 'fixtures_required', 'agent_failed',
]);

/** eventDetail(e) -> the first real, already-written narrative field on the event (never synthesised).
 *  Falls back to an honest "no additional detail logged" rather than inventing one. */
function eventDetail(e) {
  const fields = ['note', 'reason', 'output', 'decision_summary', 'message'];
  for (const f of fields) {
    const v = e && e[f];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return 'no additional detail logged';
}

/** tryReconcile(runId, opts) -> {manifest, done, failed, unfinished} | null. null means "no manifest was
 *  ever armed for this run" (the ordinary, expected state for most runs) OR a genuinely malformed
 *  manifest.json — either way this is NOT fatal to generating a briefing; the caller records why via a
 *  note and falls back to events-only reporting. */
function tryReconcile(runId, opts) {
  try { return { result: manifestMod.reconcile({ run_id: runId }, opts), error: null }; }
  catch (e) { return { result: null, error: e.message }; }
}

/** manifestRanBlocked(reconciled) -> {ran, blocked, wpIds} built purely from a reconciled manifest's own
 *  done/failed/unfinished arrays — see file header point 1. */
function manifestRanBlocked(reconciled) {
  const ran = [];
  const blocked = [];
  const wpIds = new Set();
  for (const wp of reconciled.done) {
    wpIds.add(wp.wp_id);
    const proofType = wp.last_proof ? wp.last_proof.event_type : null;
    ran.push({
      source: 'manifest', wp_id: wp.wp_id, agent: wp.agent, event_type: proofType,
      ts: wp.last_proof ? wp.last_proof.ts : null,
      detail: proofType ? ('completed via ' + proofType) : 'completed (no proof event recorded in manifest)',
    });
  }
  for (const wp of reconciled.failed) {
    wpIds.add(wp.wp_id);
    const proofType = wp.last_proof ? wp.last_proof.event_type : null;
    blocked.push({
      source: 'manifest', wp_id: wp.wp_id, agent: wp.agent, event_type: proofType,
      ts: wp.last_proof ? wp.last_proof.ts : null,
      detail: proofType ? ('failed via ' + proofType) : 'failed (no proof event recorded in manifest)',
      reason: 'failed',
    });
  }
  for (const wp of reconciled.manifest) {
    if (wp.status === 'done' || wp.status === 'failed') continue; // already accounted for above
    wpIds.add(wp.wp_id);
    blocked.push({
      source: 'manifest', wp_id: wp.wp_id, agent: wp.agent, event_type: null, ts: null,
      detail: 'armed but never got a completion or failure event before this briefing was generated',
      reason: 'unfinished',
    });
  }
  return { ran, blocked, wpIds };
}

/** eventsRanBlocked(events, alreadyTrackedWpIds) -> {ran, blocked} from raw events.jsonl content — see file
 *  header point 2. Skips any event whose wp_id is already represented by the manifest (never double-listed)
 *  and any event log-event.cjs's own CONTENT ORACLE already flagged as disproven (reused, not reimplemented). */
function eventsRanBlocked(events, alreadyTrackedWpIds) {
  const ran = [];
  const blocked = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (manifestMod.eventIsDisproven(e)) continue; // a disproven claim is not evidence — never fabricated as ran/blocked
    if (e.wp_id != null && alreadyTrackedWpIds.has(String(e.wp_id))) continue; // manifest already accounts for this WP
    const item = {
      source: 'event', wp_id: e.wp_id != null ? String(e.wp_id) : null, agent: e.agent || null,
      event_type: e.event_type, ts: e.timestamp || null, detail: eventDetail(e),
    };
    if (RAN_EVENT_TYPES.has(e.event_type)) ran.push(item);
    else if (BLOCKED_EVENT_TYPES.has(e.event_type)) blocked.push(Object.assign({ reason: 'blocker_event' }, item));
  }
  return { ran, blocked };
}

/** decisionsFrom(blocked) -> one concrete, evidenced decision per blocked item — see file header
 *  "DECISIONS NEEDED". Never a generic placeholder; always references the real source data. */
function decisionsFrom(blocked) {
  return blocked.map((b) => {
    const label = b.wp_id ? ('WP ' + b.wp_id) : (b.agent ? ('agent ' + b.agent) : 'an unattributed item');
    let choice;
    if (b.reason === 'unfinished') choice = 'resume it, reprioritize it, or drop it';
    else choice = 'retry it, reassign it, or drop it';
    return {
      wp_id: b.wp_id, agent: b.agent, reason: b.reason || 'blocker_event',
      detail: label + (b.agent && b.wp_id ? (' (' + b.agent + ')') : '') + ' — ' + b.detail + '. Decide: ' + choice + '.',
    };
  });
}

/** generate({run_id}, opts) -> morning-briefing result — see file header MODEL. Throws only on an invalid
 *  run_id (usage error); an otherwise-nonexistent run yields an honestly empty briefing, never an error. */
function generate(input, opts) {
  opts = opts || {};
  input = input || {};
  const runId = input.run_id;
  if (!manifestMod.isValidRunId(runId)) throw new Error('forge-briefing: generate requires a valid run_id');

  const root = manifestMod.resolveRoot(opts.root);
  const notes = [];

  const { result: reconciled, error: manifestError } = tryReconcile(runId, opts);
  let manifestPresent = false;
  let ranAcc = [];
  let blockedAcc = [];
  let trackedWpIds = new Set();
  if (reconciled) {
    manifestPresent = true;
    const mb = manifestRanBlocked(reconciled);
    ranAcc = mb.ran;
    blockedAcc = mb.blocked;
    trackedWpIds = mb.wpIds;
  } else if (manifestError && /no manifest found/.test(manifestError)) {
    notes.push('no manifest was ever armed for run "' + runId + '" — ran/blocked/decisions are derived from events.jsonl only (see forge-manifest.cjs::arm)');
  } else if (manifestError) {
    notes.push('manifest for run "' + runId + '" could not be read (' + manifestError + ') — ran/blocked/decisions are derived from events.jsonl only');
  }

  const events = manifestMod.readEventsJsonl(manifestMod.eventsPath(root, runId));
  const eb = eventsRanBlocked(events, trackedWpIds);
  const ran = ranAcc.concat(eb.ran);
  const blocked = blockedAcc.concat(eb.blocked);
  const decisionsNeeded = decisionsFrom(blocked);

  if (!manifestPresent && events.length === 0) {
    notes.push('no events or manifest found for run "' + runId + '" — nothing to report (this may be a run that never started, or the wrong run_id)');
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const result = {
    ok: true,
    run_id: runId,
    generated_at: now.toISOString(),
    manifest_present: manifestPresent,
    events_count: events.length,
    ran, blocked, decisions_needed: decisionsNeeded,
    notes,
  };
  result.markdown = toMarkdown(result);
  return result;
}

function formatItem(it) {
  const who = it.wp_id ? ('**' + it.wp_id + '**' + (it.agent ? ' (' + it.agent + ')' : '')) : (it.agent || 'unattributed');
  const when = it.ts ? ' _[' + it.ts + ']_' : '';
  return '- ' + who + ' — ' + it.detail + when;
}

/** toMarkdown(result) -> the rendered morning-briefing markdown: RAN / BLOCKED / DECISIONS NEEDED, in that
 *  order, each with an honest empty-state line when the section has no evidenced entries. */
function toMarkdown(result) {
  const lines = [];
  lines.push('# Morning Briefing — ' + result.run_id);
  lines.push('_generated ' + result.generated_at + ' · ' + result.ran.length + ' ran · ' +
    result.blocked.length + ' blocked · ' + result.decisions_needed.length + ' decision(s) needed' +
    (result.manifest_present ? '' : ' · no manifest armed') + '_');
  lines.push('');

  lines.push('## Ran (completed)');
  if (result.ran.length) result.ran.forEach((it) => lines.push(formatItem(it)));
  else lines.push('_Nothing completed yet — no `ran` evidence logged for this run._');
  lines.push('');

  lines.push('## Blocked');
  if (result.blocked.length) result.blocked.forEach((it) => lines.push(formatItem(it)));
  else lines.push('_Nothing blocked — no failures or unfinished work packages logged._');
  lines.push('');

  lines.push('## Decisions needed (only you can decide)');
  if (result.decisions_needed.length) result.decisions_needed.forEach((d) => lines.push('- ' + d.detail));
  else lines.push('_No blockers logged — nothing needs an owner decision right now._');

  for (const n of result.notes) lines.push('\n> ' + n);
  return lines.join('\n');
}

module.exports = {
  generate, toMarkdown,
  eventDetail, tryReconcile, manifestRanBlocked, eventsRanBlocked, decisionsFrom,
  RAN_EVENT_TYPES, BLOCKED_EVENT_TYPES,
};

// ---- CLI ----
// N9 laptop re-audit 2026-09-26: forge.md:22 documents the call as `forge-briefing.cjs <run_id>` (a plain
// positional argument), but this parser only ever accepted `--run <id>` — every documented call would have
// hit the "unknown argument" usage error. Both forms are accepted now; `--run` still works unchanged.
function parseArgs(argv) {
  const opts = { run: null, json: false, help: false, usageError: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { if (!opts.usageError) opts.usageError = '--run requires an <id>'; }
      else if (opts.run && opts.run !== v) { if (!opts.usageError) opts.usageError = 'a run id was given twice (positional and --run) with different values'; }
      else opts.run = v;
    }
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('--')) {
      // positional <run_id>, e.g. `node forge-briefing.cjs <run_id>` (forge.md:22)
      if (opts.run && opts.run !== a) { if (!opts.usageError) opts.usageError = 'a run id was given twice (positional and --run) with different values'; }
      else opts.run = a;
    }
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return opts;
}
function printUsage() { console.error('Usage: node forge-briefing.cjs <run_id> [--json]  (or: node forge-briefing.cjs --run <id> [--json])'); }

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); process.exitCode = 0; }
  else if (opts.usageError) { console.error('forge-briefing: ' + opts.usageError); printUsage(); process.exitCode = 2; }
  else if (!opts.run) { printUsage(); process.exitCode = 2; }
  else {
    try {
      const result = generate({ run_id: opts.run }, {});
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(result.markdown);
      process.exitCode = 0;
    } catch (e) {
      console.error('forge-briefing: ' + e.message);
      process.exitCode = 2;
    }
  }
}
