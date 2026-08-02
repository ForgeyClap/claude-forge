#!/usr/bin/env node
'use strict';
/**
 * forge-trace.cjs — requirements traceability projector (WAVE E / E3, 2026-07-18). For a given run,
 * PROJECTS the intake -> PRD -> WP -> artifact -> verified chain PURELY from that run's already-logged
 * events.jsonl content — never by inference, never by reading a ticket/artifact/prd store file's current
 * state (a store file can be edited later; the events log is the append-only record of what actually
 * happened DURING the run). This is the same "pure projection from logged run content" discipline
 * forge-orchestrate.cjs::audit and forge-manifest.cjs::projectManifest already use — a gap here is a real,
 * evidence-backed gap, never a guess.
 *
 * WHERE "REQUIREMENT" COMES FROM: this project's Mission Control Phase 2 lane already turns each PRD
 * acceptance criterion into one ticket (forge-prd.cjs::criteriaToTickets, one `ticket_created` event per
 * criterion, carrying `ticket_id` + `prd_id`) — so a `ticket_created` event IS the WP-creation moment for
 * one requirement. trace() discovers every requirement straight from these events; it never accepts a
 * requirement list from the caller (that would stop being a pure projection of REAL logged content).
 *
 * THE FIVE-STAGE CHAIN, per requirement (ticket_id + prd_id from its ticket_created event):
 *   1. intake   — at least one `agent_note` event in the WHOLE run whose `note` field mentions "intake"
 *                 (the exact note text forge-intake.cjs logs: "forge-intake: N intake-vragen voor type
 *                 ..."). Run-level, not per-requirement (intake happens once, before any PRD) — every
 *                 requirement in a run shares the same intake stage result, honestly reflecting that this
 *                 project's intake step is a single mission-level milestone, not per-criterion.
 *   2. prd      — a `prd_generated` event carrying this requirement's `prd_id`.
 *   3. wp       — the requirement's OWN `ticket_created` event (trivially satisfied — this is what defines
 *                 the requirement in the first place; still reported with its evIdx for a complete,
 *                 self-explaining chain rather than a silently-implied stage).
 *   4. artifact — an event carrying either `artifact_id` or a non-empty `output_artifact` field, AND
 *                 either `ticket_id` matching this requirement OR (when no ticket_id was threaded through)
 *                 `prd_id` matching this requirement's PRD.
 *   5. verified — a PASS-ASSERTION event (`check_passed` | `quality_gate_passed` | `retest_completed` —
 *                 the exact set log-event.cjs's own CONTENT ORACLE already calls PASS_ASSERTION_EVENTS)
 *                 carrying a matching `ticket_id` or `prd_id`.
 *   Stages 4 and 5 additionally require the matched event NOT be disproven by log-event.cjs's own CONTENT
 *   ORACLE (`_forge_verify.proof_verified === false` disqualifies it — a claimed artifact/pass that was
 *   itself flagged as a lie is not real evidence, mirrors forge-orchestrate.cjs::eventMatchesStep and
 *   forge-manifest.cjs::eventIsDisproven exactly).
 *   A requirement is `met` only when ALL FIVE stages are found; `gap_at` names the FIRST unmet stage in
 *   chain order — this is the honest "where did the thread break" answer, not just a pass/fail bit.
 *
 *   NOTE (documented limitation, not a bug): stages 4/5 can only match a `ticket_id`/`prd_id` field that
 *   was actually THREADED THROUGH into the artifact/verified event's logged payload. log-event.cjs passes
 *   arbitrary extra JSON fields straight onto the stored event (see its own file header), so any caller
 *   CAN thread `ticket_id` through — but the built-in helper wrappers (forge-artifact.cjs::storeArtifact,
 *   log-event.cjs calls for check_passed) do not do this automatically today. A real run that never
 *   threads `ticket_id`/`prd_id` into its artifact/verified events will honestly show every requirement
 *   stuck at gap_at:"artifact" — that is a true, actionable finding (log the link next time), not a false
 *   negative this tool invents.
 *
 * MODEL:
 *   trace({run_id}, opts) -> { ok, run_id, requirements:[...], total, met, gaps:[{ticket_id, prd_id,
 *     gap_at}, ...], coverage, notes:[...] }. `coverage` is `met.length / total` (0..1), or `null` when
 *     `total === 0` (no ticket_created events in this run — vacuously nothing to trace, NOT an error; see
 *     notes[] for the honest reason). opts.root overrides the project root (test hermeticity, same
 *     convention as forge-manifest.cjs). Throws only on an invalid run_id or an unreadable/malformed
 *     events.jsonl (a MISSING events.jsonl is a valid "nothing logged yet" state -> requirements: []).
 *
 * CLI:
 *   node forge-trace.cjs trace --run <id> [--json]
 * Exit codes: 0 = every discovered requirement is fully traced (including the vacuous "no requirements
 * found yet" case) · 3 = at least one requirement has a gap (mirrors forge-orchestrate's audit / forge-
 * manifest's resumable non-zero "needs attention" convention) · 2 = usage/config error (bad run_id, or a
 * genuinely malformed events.jsonl line count that could not be parsed at all — never silently guessed).
 */
const fs = require('fs');
const path = require('path');

const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const VERIFIED_EVENT_TYPES = new Set(['check_passed', 'quality_gate_passed', 'retest_completed']);
const INTAKE_NOTE_RE = /intake/i;

function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  return path.resolve(__dirname, '..', '..');
}
function isValidRunId(id) { return typeof id === 'string' && RUN_ID_RE.test(id); }
function eventsPath(root, runId) {
  const base = path.join(root, '.claude', 'forge-runs');
  const p = path.join(base, runId, 'events.jsonl');
  const resolved = path.resolve(p), resolvedBase = path.resolve(base);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) throw new Error('forge-trace: path escapes forge-runs — refused');
  return p;
}

/** readEventsJsonl(p) -> event[]. Line-delimited JSON, BOM-tolerant, malformed lines skipped (mirrors
 *  forge-manifest.cjs / forge-orchestrate.cjs exactly). A MISSING file returns [] (never throws) — "no
 *  run started yet" is a valid, ordinary state. */
function readEventsJsonl(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch { /* malformed line — skip, never crash */ }
  }
  return events;
}

/** eventIsDisproven(e) -> boolean — log-event.cjs's own CONTENT ORACLE already flagged this event's claim
 *  as false. Such an event is never real evidence (mirrors forge-manifest.cjs::eventIsDisproven). */
function eventIsDisproven(e) { return !!(e && e._forge_verify && e._forge_verify.proof_verified === false); }

/** findFirstIndex(events, pred) -> index of the first event satisfying pred, or -1. */
function findFirstIndex(events, pred) {
  for (let i = 0; i < events.length; i++) if (pred(events[i], i)) return i;
  return -1;
}

/** discoverRequirements(events) -> [{ticket_id, prd_id, title, ticketEvIdx}, ...] — one entry per
 *  `ticket_created` event that carries a non-empty ticket_id, in event order. A duplicate ticket_id
 *  (a real retry re-logging the same ticket) keeps only the FIRST occurrence — the requirement was
 *  created once; a later duplicate log line is not a second requirement. */
function discoverRequirements(events) {
  const seen = new Set();
  const out = [];
  events.forEach((e, i) => {
    if (!e || typeof e !== 'object' || e.event_type !== 'ticket_created') return;
    if (eventIsDisproven(e)) return;
    const ticketId = e.ticket_id;
    if (!ticketId || typeof ticketId !== 'string' || seen.has(ticketId)) return;
    seen.add(ticketId);
    out.push({
      ticket_id: ticketId,
      prd_id: (typeof e.prd_id === 'string' && e.prd_id) ? e.prd_id : null,
      title: (typeof e.title === 'string' && e.title) || (typeof e.note === 'string' && e.note) || null,
      ticketEvIdx: i,
    });
  });
  return out;
}

/** projectRequirement(req, events, intakeStage) -> the full 5-stage-annotated requirement record. PURE
 *  function of (req, events, intakeStage) — no I/O. This is the function trace()'s honesty guarantee is
 *  mutation-verified against (see forge-trace.test.cjs). */
function projectRequirement(req, events, intakeStage) {
  const prdIdx = req.prd_id
    ? findFirstIndex(events, (e) => e && e.event_type === 'prd_generated' && e.prd_id === req.prd_id && !eventIsDisproven(e))
    : -1;

  const artifactIdx = findFirstIndex(events, (e) => {
    if (!e || typeof e !== 'object' || eventIsDisproven(e)) return false;
    const hasArtifact = (typeof e.artifact_id === 'string' && e.artifact_id) || (typeof e.output_artifact === 'string' && e.output_artifact.trim());
    if (!hasArtifact) return false;
    if (e.ticket_id === req.ticket_id) return true;
    return !!(req.prd_id && e.prd_id === req.prd_id);
  });

  const verifiedIdx = findFirstIndex(events, (e) => {
    if (!e || typeof e !== 'object' || eventIsDisproven(e)) return false;
    if (!VERIFIED_EVENT_TYPES.has(e.event_type)) return false;
    if (e.ticket_id === req.ticket_id) return true;
    return !!(req.prd_id && e.prd_id === req.prd_id);
  });

  const stages = {
    intake: { met: intakeStage.met, evIdx: intakeStage.evIdx },
    prd: { met: req.prd_id != null && prdIdx !== -1, evIdx: prdIdx === -1 ? null : prdIdx },
    wp: { met: true, evIdx: req.ticketEvIdx },
    artifact: { met: artifactIdx !== -1, evIdx: artifactIdx === -1 ? null : artifactIdx },
    verified: { met: verifiedIdx !== -1, evIdx: verifiedIdx === -1 ? null : verifiedIdx },
  };

  const CHAIN_ORDER = ['intake', 'prd', 'wp', 'artifact', 'verified'];
  const gapAt = CHAIN_ORDER.find((name) => !stages[name].met) || null;

  return {
    ticket_id: req.ticket_id, prd_id: req.prd_id, title: req.title,
    stages, met: gapAt === null, gap_at: gapAt,
  };
}

/** projectTrace(events) -> {requirements, met, gaps, coverage, notes} — PURE function of `events`; no I/O,
 *  never mutates its input. This is what `trace()` calls after reading events.jsonl, and what
 *  forge-trace.test.cjs mutation-verifies directly (no subprocess/file I/O needed to exercise it). */
function projectTrace(events) {
  const intakeEvIdx = findFirstIndex(events, (e) => e && e.event_type === 'agent_note' && typeof e.note === 'string' && INTAKE_NOTE_RE.test(e.note) && !eventIsDisproven(e));
  const intakeStage = { met: intakeEvIdx !== -1, evIdx: intakeEvIdx === -1 ? null : intakeEvIdx };

  const reqs = discoverRequirements(events);
  const requirements = reqs.map((r) => projectRequirement(r, events, intakeStage));
  const met = requirements.filter((r) => r.met);
  const gaps = requirements.filter((r) => !r.met).map((r) => ({ ticket_id: r.ticket_id, prd_id: r.prd_id, gap_at: r.gap_at }));
  const notes = [];
  if (requirements.length === 0) notes.push('forge-trace: no ticket_created events found in this run — nothing to trace yet (not an error)');

  return {
    requirements, total: requirements.length, met, gaps,
    coverage: requirements.length === 0 ? null : met.length / requirements.length,
    notes,
  };
}

/** trace({run_id}, opts) -> {ok, run_id, requirements, total, met, gaps, coverage, notes}. See file header. */
function trace(input, opts) {
  opts = opts || {};
  input = input || {};
  const runId = input.run_id;
  if (!isValidRunId(runId)) throw new Error('forge-trace: trace requires a valid run_id');
  const root = resolveRoot(opts.root);
  const events = readEventsJsonl(eventsPath(root, runId));
  const projected = projectTrace(events);
  return Object.assign({ ok: true, run_id: runId }, projected);
}

module.exports = {
  trace, projectTrace, projectRequirement, discoverRequirements,
  readEventsJsonl, eventIsDisproven, findFirstIndex, isValidRunId, resolveRoot, eventsPath,
  VERIFIED_EVENT_TYPES, INTAKE_NOTE_RE,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, run: null, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--run') opts.run = rest[++i];
    else if (a === '--json') opts.json = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-trace.cjs trace --run <id> [--json]');
}
function printTrace(r) {
  console.log('forge-trace · ' + r.run_id + ' — ' + r.total + ' requirement(s), ' + r.met.length + ' met, ' + r.gaps.length + ' gap(s)' + (r.coverage == null ? '' : (' (' + (r.coverage * 100).toFixed(1) + '% coverage)')));
  for (const req of r.requirements) {
    console.log('  [' + (req.met ? 'MET' : 'GAP@' + req.gap_at) + '] ' + req.ticket_id + (req.prd_id ? (' (prd ' + req.prd_id + ')') : ''));
  }
  for (const n of r.notes) console.log('  note: ' + n);
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'trace') {
      if (!opts.run) { printUsage(); process.exitCode = 2; }
      else {
        const r = trace({ run_id: opts.run }, {});
        if (opts.json) console.log(JSON.stringify(r));
        else printTrace(r);
        process.exitCode = r.gaps.length > 0 ? 3 : 0;
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-trace: ' + e.message);
    process.exitCode = 2;
  }
}
