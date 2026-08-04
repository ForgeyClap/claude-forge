#!/usr/bin/env node
'use strict';
/**
 * forge-coldverify.cjs — COLD verification, READ SIDE ONLY (2026-08-01).
 *
 * WHY THIS EXISTS
 * A normal verify pass reads the run as a story: the builder's notes, its progress narration, its
 * "subagent_completed — all criteria met" claim. That narration is persuasive, and a reviewer who
 * reads it inherits the builder's own reasoning before ever looking at the evidence. This tool is
 * the counter-measure: it re-asks "was this criterion actually proven?" with the BUILDER'S REASONING
 * STRUCTURALLY REMOVED FROM ITS INPUT, and answers with one of exactly three honest verdicts:
 *
 *     proven        — a criterion-specific, mechanically checkable corroboration exists
 *     unproven      — both sides are present and NOTHING corroborates the done-claim
 *     unassessable  — a whole side is missing; this tool cannot judge it either way
 *
 * WHAT MAKES IT "COLD" (this is the load-bearing design decision)
 * "Cold" here is STRUCTURAL, not temporal. The motivating idea is a check that runs hours later with
 * only the ticket + acceptance criteria in hand — but wall-clock delay is not what makes such a check
 * honest; INPUT ISOLATION is. So the coldness is implemented as a mechanical narrative firewall that
 * holds no matter when the tool runs (it is stateless and reads only persisted artifacts, so running
 * it minutes or weeks after the run gives the identical verdict):
 *
 *   - COLD_EXCLUDED_EVENT_TYPES — every event type that carries builder narrative or a bare completion
 *     CLAIM (agent_note, agent_progress, subagent_output_created, subagent_completed, agent_completed,
 *     report_generated, decision_logged, …) is dropped before any judging. A run can be wall-to-wall
 *     glowing self-assessment and not one verdict moves.
 *   - COLD_NARRATIVE_FIELDS — even on an ADMITTED event, free-prose fields (note/output/summary/
 *     decision_summary/reason/…) are stripped, so reasoning cannot be smuggled in on a hard event.
 *   - COLD_EXCLUDED_TICKET_FIELDS — the ticket's own builder-written prose (note, description) is
 *     dropped. Its SPEC side (the acceptance-criterion text) and its CLAIM side (test_evidence,
 *     related_files, required_tests) are kept, because those are the two things being compared.
 *   - test_evidence is treated as a CLAIM TO BE CORROBORATED, never as evidence. Its file-like
 *     referents are extracted and checked against the real filesystem. "forge-x.test.cjs: 33/33 +
 *     screenshot y.png" does not pass because it sounds thorough — it passes only if those files
 *     actually exist and something in the run's hard log ties them to this ticket.
 *   - ticket_updated is admitted for ASSESSABILITY only and can NEVER contribute to `proven`: a ticket
 *     being closed is the claim under examination, so letting it prove itself would be circular.
 *
 * ATTACHES TO WHAT ALREADY EXISTS — DOES NOT BUILD A SECOND TRUTH
 *   - the ticket store            -> forge-store.cjs (listStore/getEntity), same entities the board shows
 *   - the spec (PRD criteria)     -> forge-verify.cjs's OWN loadPrdMeta()/acceptanceCriteria(), so this
 *                                    check and the spec-drift blocker read a criterion identically
 *   - the ticket<->criterion join -> `tk-<prd_id>-<n>`, the exact id forge-prd.cjs::criteriaToTickets mints
 *   - done/failed classification  -> forge-verify.cjs's exported taskStatus(), not a re-derived copy
 *   - the evidence log            -> the run's own events.jsonl (filtered, never re-formatted)
 *
 * TWO MODES — READ BY DEFAULT, WRITE ONLY WHEN ASKED TWICE
 * The DEFAULT invocation is READ-ONLY and stays that way: no ticket is reopened, no status changed, no
 * event logged, no file created. That is the mode everything above describes, and it is pinned by a test
 * that snapshots the whole project tree (paths + sizes + mtimes) around a full run and requires it back
 * byte-identical.
 *
 * The `reopen` SUBCOMMAND is the one write path (owner decision, 2026-08-02 — added after the read side
 * put three tickets the warm verify-loop had closed onto `unproven`). Its restraints ARE the feature:
 *
 *   - DRY RUN IS THE DEFAULT. Without `--confirm` nothing is written and nothing is logged — not a
 *     softened version, nothing. It prints exactly what it WOULD do, against the real verdicts.
 *   - IT MAY ONLY ACT ON ITS OWN `unproven` VERDICTS. Candidates come from coldVerify()'s own items, so a
 *     ticket this check did not itself judge can never be touched. `unassessable` is deliberately NOT a
 *     candidate: it means "I could not judge this", which is not "this is wrong", and turning an
 *     admission of ignorance into an accusation would corrupt the one thing this tool is for.
 *   - DONE -> REVIEW ONLY. It never closes anything, never marks anything done, and never moves a ticket
 *     that is not currently `done` — the same one-way restraint forge-verify.cjs's warm loop applies when
 *     it sends an unproven done back to 'review' (which is why it reuses that exact status, not a new one).
 *   - EVERY CHANGE IS RECORDED BY THE ONE REAL WRITER. The `ticket_updated` event goes through
 *     forge-dashboard/log-event.cjs (registered vocabulary, strict-mode gate, tamper-evident hash chain);
 *     this file appends to no log itself and contains no fs write call at all. The ticket write goes
 *     through forge-store.cjs's own putEntity(), so there is no second write path and no second set of
 *     id/containment/secret guards to keep in sync.
 *   - THE EVENT COMES FIRST. If the writer refuses the event, the ticket is left untouched. That ordering
 *     is deliberate rather than arbitrary: a refusal is the PLAUSIBLE failure (strict mode, an invalid run
 *     id, a missing writer), while a putEntity failure is not — so the gate sits on the failure that can
 *     actually happen. If the write then fails anyway, the result says so loudly instead of leaving the
 *     log claiming a change that never landed.
 *   - A CHANGE THAT CANNOT BE LOGGED IS NOT MADE. A ticket naming no run_id has nowhere to record the
 *     change, so it is skipped with a reason (`--event-run <run_id>` says where it belongs) rather than
 *     being changed off the record.
 *   - IT CANNOT FIRE TWICE. Reopening moves the ticket out of `done`, and only `done` tickets are ever
 *     assessed — so a second `reopen --confirm` on an already reopened ticket finds no candidate, writes
 *     nothing, logs nothing. The status is re-read at WRITE time as well, so a ticket that moved between
 *     the verdict and the write is refused rather than clobbered by a stale judgement.
 *
 * CLI
 *   node forge-coldverify.cjs [--run <run_id>] [--ticket <ticket_id>] [--json] [--root <projectRoot>]
 *   exit 0 = no `unproven` verdicts · 1 = at least one `unproven` · 2 = usage/read error
 *   (`unassessable` never fails the run — "I cannot judge this" is not the same as "this is wrong".)
 *
 *   node forge-coldverify.cjs reopen [--confirm] [--run <id>] [--ticket <id>] [--event-run <id>] [--json] [--root <dir>]
 *   exit 0 = dry run, or every planned change landed · 1 = at least one planned change FAILED · 2 = usage
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const store = require('./forge-store.cjs');
const verify = require('./forge-verify.cjs');

// ---- the narrative firewall ---------------------------------------------------------------------------
// Every event type whose payload is (or routinely carries) the builder's own account of its work. Dropped
// wholesale before judging. Note that this deliberately includes the COMPLETION CLAIMS themselves
// (subagent_completed/agent_completed/fix_completed/retest_completed): a claim of doneness is the thing
// under examination, so it can never be part of its own proof.
const COLD_EXCLUDED_EVENT_TYPES = new Set([
  'agent_note', 'agent_progress', 'agent_output', 'agent_decision_summary', 'agent_next_action',
  'agent_evidence_added', 'subagent_output_created', 'subagent_started', 'subagent_completed',
  'subagent_failed', 'agent_started', 'agent_completed', 'agent_failed', 'agent_handoff',
  'lead_review_started', 'lead_review_completed', 'report_generated', 'final_output_created',
  'decision_logged', 'mission_blueprint_created', 'mission_packet_created', 'agent_work_package_created',
  'custom_subagent_created', 'skill_discovery', 'skill_map_created', 'skill_assigned', 'role_map_created',
  'memory_loaded', 'memory_updated', 'run_started', 'run_completed', 'fix_started', 'fix_completed',
  'retest_started', 'retest_completed', 'rework_started', 'rework_completed', 'rework_task_created',
  'rework_assigned', 'merge_started', 'merge_completed', 'codex_review_started', 'codex_review_completed',
  'codex_finding', 'agent_selected', 'owner_prefs_loaded', 'prd_generated',
]);

// The only event types this check will look at: each one's payload contains something a machine can
// actually re-check later (a path that must exist on disk, or a NAMED check with a terminal outcome).
// Anything not listed here is excluded by default — the firewall is an allow-list, so a future event type
// cannot silently become admissible narrative.
const COLD_ADMITTED_EVENT_TYPES = new Set([
  'file_changed',                                                     // paths -> checkable on disk
  'check_passed', 'check_failed',                                     // a named check + terminal outcome
  'quality_gate_passed', 'quality_gate_blocked',                      // a named gate + terminal outcome
  'artifact_stored', 'subagent_artifact_created', 'agent_artifact_created', // paths -> checkable on disk
  'doctor_run',                                                       // project self-test fact (context only)
  'ticket_created', 'ticket_updated',                                 // lifecycle only — NEVER proof (see below)
]);

// Admitted event types that establish only that the run's hard log KNOWS this ticket. They make a ticket
// assessable; they can never make it `proven` (a ticket closing itself is circular — see header).
const COLD_NON_PROVING_TYPES = new Set(['ticket_created', 'ticket_updated', 'doctor_run']);

// Free-prose fields stripped from every admitted event, so reasoning cannot ride in on a hard fact.
// `task`/`title` survive deliberately: on a check_passed they are the NAME of the check, not an argument
// for it, and the name is what binds evidence to a criterion.
const COLD_NARRATIVE_FIELDS = ['note', 'output', 'summary', 'decision_summary', 'next_action', 'issue',
  'reason', 'mission', 'rationale', 'analysis', 'description', 'detail', 'details', 'message'];

// The ticket's own builder-written prose. Its spec side (title/criterion) and claim side (test_evidence,
// related_files, required_tests) are kept — those are exactly what gets compared.
const COLD_EXCLUDED_TICKET_FIELDS = ['note', 'description'];

const VERDICTS = ['proven', 'unproven', 'unassessable'];

/** admitEvents(events) -> events reduced to admitted types with narrative fields stripped. Pure; never
 *  mutates the input (each survivor is a shallow copy minus the prose fields). */
function admitEvents(events) {
  const out = [];
  for (const e of events || []) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.event_type !== 'string') continue;
    if (COLD_EXCLUDED_EVENT_TYPES.has(e.event_type)) continue;
    if (!COLD_ADMITTED_EVENT_TYPES.has(e.event_type)) continue; // allow-list: unknown types are not admissible
    const copy = Object.assign({}, e);
    for (const f of COLD_NARRATIVE_FIELDS) delete copy[f];
    out.push(copy);
  }
  return out;
}

/** coldTicket(ticket) -> the ticket with its builder prose removed. Same firewall discipline as
 *  admitEvents, applied to the store entity. */
function coldTicket(ticket) {
  const copy = Object.assign({}, ticket || {});
  for (const f of COLD_EXCLUDED_TICKET_FIELDS) delete copy[f];
  return copy;
}

// ---- referents: turning a prose CLAIM into checkable filesystem facts ---------------------------------
// Conservative on purpose: only tokens that genuinely look like a file (a name with a known code/asset
// extension). A tally like "33/33" is NOT a referent — it is unverifiable prose, and treating it as proof
// is precisely the failure mode this tool exists to catch.
const REFERENT_RE = /[A-Za-z0-9_.\\/-]+\.(?:cjs|mjs|js|jsx|ts|tsx|json|jsonl|md|png|jpg|jpeg|svg|webp|html|css|py|sh|ps1|yml|yaml|txt)\b/g;

function extractReferents(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const seen = new Set();
  const out = [];
  let m;
  REFERENT_RE.lastIndex = 0;
  while ((m = REFERENT_RE.exec(text)) !== null) {
    const raw = m[0].replace(/^[./\\]+/, '').trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** candidateRoots(projectRoot, runDir) — the BOUNDED set of directories a referent is looked up in. A
 *  bounded lookup (never a recursive filesystem walk) keeps this check cheap and predictable; a referent
 *  that lives somewhere else simply resolves to "not found", which is reported honestly rather than
 *  guessed at. */
function candidateRoots(projectRoot, runDir) {
  const claude = store.CLAUDE_DIR;
  const roots = [projectRoot, claude, path.join(claude, 'forge-bin'), path.join(claude, 'forge-dashboard'),
    path.join(claude, 'forge-prd'), path.join(claude, 'forge-tickets')];
  if (runDir) { roots.push(runDir); roots.push(path.join(runDir, 'artifacts')); }
  return roots.filter((r) => typeof r === 'string' && r);
}

/** resolveReferent(ref, projectRoot, runDir) -> {ref, exists, path|null}. Tries the referent as given
 *  under each candidate root, then its bare basename under each root (a claim usually names the file, not
 *  its path). Containment-guarded: a resolved path that escapes projectRoot is refused, never followed. */
function resolveReferent(ref, projectRoot, runDir) {
  const base = path.resolve(projectRoot);
  const attempts = [];
  for (const root of candidateRoots(projectRoot, runDir)) {
    attempts.push(path.join(root, ref));
    const bn = path.basename(ref);
    if (bn && bn !== ref) attempts.push(path.join(root, bn));
  }
  for (const a of attempts) {
    const resolved = path.resolve(a);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) continue; // containment — never follow an escape
    let st;
    try { st = fs.statSync(resolved); } catch { continue; }
    if (st.isFile()) return { ref, exists: true, path: path.relative(base, resolved).split(path.sep).join('/') };
  }
  return { ref, exists: false, path: null };
}

// ---- reading the evidence channel ---------------------------------------------------------------------
/** readAdmittedEvents(runDir) -> {ok, events, reason}. A missing/unreadable events.jsonl is NOT an error
 *  here — it means the evidence channel is absent, which is exactly what makes a ticket `unassessable`.
 *  Malformed lines are skipped (same tolerance forge-verify's own reader applies). */
function readAdmittedEvents(runDir) {
  const file = path.join(runDir, 'events.jsonl');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return { ok: false, events: [], reason: 'no events.jsonl at ' + file }; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const parsed = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { parsed.push(JSON.parse(s)); } catch { /* malformed line skipped, never a crash */ }
  }
  return { ok: true, events: admitEvents(parsed), reason: null };
}

/** eventPaths(e) -> every path-like string an admitted event carries. Mirrors the field names the real
 *  log-event payloads use (files_changed[]/file/path/artifact) rather than inventing a new convention. */
function eventPaths(e) {
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) out.push(v.trim()); };
  push(e.path); push(e.file); push(e.artifact); push(e.artifact_path);
  if (Array.isArray(e.files_changed)) e.files_changed.forEach(push);
  if (Array.isArray(e.files)) e.files.forEach(push);
  if (Array.isArray(e.paths)) e.paths.forEach(push);
  return out;
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

// ---- the spec side ------------------------------------------------------------------------------------
/** criterionFor(ticket) -> {text, source, ac_id}. Prefers the PRD (the authoritative spec) read through
 *  forge-verify's OWN loadPrdMeta/acceptanceCriteria, joined by the `tk-<prd_id>-<n>` index forge-prd mints.
 *  Falls back to the ticket's title only when there is no readable PRD criterion, and says so via `source`
 *  — a caller can always tell whether it compared against the spec or against the builder's restatement. */
function criterionFor(ticket) {
  const id = String(ticket.ticket_id || ticket.id || '');
  const prdId = typeof ticket.prd_id === 'string' ? ticket.prd_id : '';
  if (prdId) {
    const suffix = id.startsWith('tk-' + prdId + '-') ? id.slice(('tk-' + prdId + '-').length) : '';
    const idx = /^\d+$/.test(suffix) ? Number(suffix) - 1 : -1;
    const meta = verify.loadPrdMeta(prdId);
    if (meta) {
      const criteria = verify.acceptanceCriteria(meta);
      if (idx >= 0 && idx < criteria.length) {
        return { text: criteria[idx].text, source: 'prd', ac_id: criteria[idx].id };
      }
    }
  }
  const title = typeof ticket.title === 'string' ? ticket.title.trim() : '';
  if (title) return { text: title, source: 'ticket-title', ac_id: null };
  return { text: '', source: 'none', ac_id: null };
}

// ---- the verdict --------------------------------------------------------------------------------------
/**
 * coldVerifyTicket(ticket, opts) -> one report item.
 * opts.projectRoot (default: the parent of store.CLAUDE_DIR) · opts.runDir (override, test hermeticity).
 *
 * Verdict rules — deliberately explicit, because the whole value of this tool is that its bar is stated
 * rather than felt:
 *
 *   unassessable  when a whole SIDE is missing:
 *                   - no criterion text at all (no readable PRD criterion and no ticket title), or
 *                   - no evidence channel (ticket names no run_id, or that run's events.jsonl is
 *                     unreadable) AND the ticket names no referent that could be checked on disk instead.
 *   unproven      when both sides are present but nothing corroborates — including the important cases
 *                 "test_evidence is blank", "every file it names is missing from disk", and "the files
 *                 exist but no admitted in-run event ties any of them to this ticket". Counter-evidence
 *                 (a check_failed / quality_gate_blocked bound to this ticket) also lands here, loudly.
 *   proven        when there is no counter-evidence AND at least one criterion-SPECIFIC corroboration:
 *                   P1 — an admitted hard event carrying this ticket_id that resolves to done via
 *                        forge-verify's taskStatus(); and when that event CLAIMS a delivery (it names
 *                        paths), at least one of those paths must actually be on disk, or
 *                   P2 — a referent the ticket names that BOTH exists on disk AND is named by an admitted
 *                        file_changed / artifact event in this ticket's own run.
 *                 A file merely existing (P3) is explicitly NOT enough: that is a filename, not a proof,
 *                 and accepting it is the exact softness this check was built to remove.
 */
function coldVerifyTicket(ticket, opts) {
  opts = opts || {};
  const projectRoot = opts.projectRoot || path.dirname(store.CLAUDE_DIR);
  const cold = coldTicket(ticket);
  const ticketId = String(cold.ticket_id || cold.id || '');
  const runId = typeof cold.run_id === 'string' && cold.run_id.trim() ? cold.run_id.trim() : null;
  const runDir = opts.runDir || (runId ? path.join(store.CLAUDE_DIR, 'forge-runs', runId) : null);

  const criterion = criterionFor(cold);
  const item = {
    ticket_id: ticketId,
    prd_id: typeof cold.prd_id === 'string' ? cold.prd_id : null,
    run_id: runId,
    criterion: criterion.text,
    criterion_source: criterion.source,
    ac_id: criterion.ac_id,
    verdict: null,
    reasons: [],
    corroborations: [],
    counter_evidence: [],
    referents: { resolved: [], missing: [] },
    evidence_channel: null,
  };

  // --- claim side: the referents the ticket names (test_evidence prose + declared related_files) --------
  const claimText = typeof cold.test_evidence === 'string' ? cold.test_evidence : '';
  const related = Array.isArray(cold.related_files) ? cold.related_files.filter((f) => typeof f === 'string' && f.trim()) : [];
  const refs = [];
  const seenRef = new Set();
  for (const r of extractReferents(claimText).concat(related.map((f) => f.trim()))) {
    if (seenRef.has(r)) continue;
    seenRef.add(r);
    refs.push(r);
  }
  const resolvedRefs = [];
  for (const r of refs) {
    const res = resolveReferent(r, projectRoot, runDir);
    if (res.exists) { item.referents.resolved.push(res); resolvedRefs.push(res); }
    else item.referents.missing.push(r);
  }

  // --- evidence side: the run's hard log, narrative firewalled out -------------------------------------
  let admitted = [];
  if (!runDir) {
    item.evidence_channel = 'absent (ticket carries no run_id)';
  } else {
    const read = readAdmittedEvents(runDir);
    if (!read.ok) item.evidence_channel = 'unreadable (' + read.reason + ')';
    else { admitted = read.events; item.evidence_channel = 'events.jsonl · ' + admitted.length + ' admitted event(s)'; }
  }

  const boundToTicket = admitted.filter((e) => typeof e.ticket_id === 'string' && e.ticket_id === ticketId);
  for (const e of boundToTicket) {
    if (COLD_NON_PROVING_TYPES.has(e.event_type)) continue;
    const st = verify.taskStatus(e);
    if (st === 'failed' || e.event_type === 'check_failed' || e.event_type === 'quality_gate_blocked') {
      item.counter_evidence.push({ type: e.event_type, check: e.task || e.title || null });
      continue;
    }
    if (st !== 'done') continue;
    // A bound event that CLAIMS a delivery (it names paths) only corroborates when at least one of those
    // paths is actually on disk. "the log says a file changed" and "a file that changed is really there"
    // are different facts, and this tool exists to distrust the first without the second. An event with no
    // paths at all (a check_passed) is judged on its named check + terminal outcome instead.
    const claimed = eventPaths(e);
    if (claimed.length) {
      const live = claimed.map((p) => resolveReferent(p, projectRoot, runDir)).filter((r) => r.exists);
      if (!live.length) {
        for (const p of claimed) if (!item.referents.missing.includes(p)) item.referents.missing.push(p);
        continue; // claimed delivery is not on disk — not a corroboration
      }
      item.corroborations.push({ kind: 'P1', type: e.event_type, check: e.task || e.title || null,
        detail: 'admitted ' + e.event_type + ' carries ticket_id ' + ticketId + ' and its delivered path ' + live[0].path + ' is on disk' });
      continue;
    }
    item.corroborations.push({ kind: 'P1', type: e.event_type, check: e.task || e.title || null,
      detail: 'admitted ' + e.event_type + ' carries ticket_id ' + ticketId });
  }

  const deliveredNorm = new Set();
  for (const e of admitted) {
    if (COLD_NON_PROVING_TYPES.has(e.event_type)) continue;
    for (const p of eventPaths(e)) deliveredNorm.add(norm(p));
  }
  for (const res of resolvedRefs) {
    const hit = [norm(res.path), norm(res.ref), norm(path.basename(res.ref))]
      .some((n) => Array.from(deliveredNorm).some((d) => d === n || d.endsWith('/' + n)));
    if (hit) {
      item.corroborations.push({ kind: 'P2', type: 'file_changed/artifact', check: null,
        detail: 'referent "' + res.ref + '" exists at ' + res.path + ' AND is named by an admitted in-run event' });
    }
  }

  // --- verdict ------------------------------------------------------------------------------------------
  const channelPresent = admitted.length > 0 || (item.evidence_channel || '').startsWith('events.jsonl');
  if (!criterion.text) {
    item.verdict = 'unassessable';
    item.reasons.push('no acceptance criterion could be resolved for this ticket (no readable PRD criterion and no ticket title) — there is nothing to verify the evidence against');
    return item;
  }
  if (!channelPresent && refs.length === 0) {
    item.verdict = 'unassessable';
    item.reasons.push('no evidence channel (' + item.evidence_channel + ') and the ticket names no checkable evidence — this check has nothing to read either way');
    return item;
  }
  if (item.counter_evidence.length) {
    item.verdict = 'unproven';
    item.reasons.push('counter-evidence bound to this ticket: ' + item.counter_evidence.map((c) => c.type + (c.check ? ' (' + c.check + ')' : '')).join(', '));
    return item;
  }
  if (item.corroborations.length) {
    item.verdict = 'proven';
    item.reasons.push(item.corroborations.length + ' criterion-specific corroboration(s): ' + item.corroborations.map((c) => c.kind).join(', '));
    return item;
  }
  item.verdict = 'unproven';
  if (item.referents.missing.length) {
    item.reasons.push('the ticket names evidence that is NOT on disk: ' + item.referents.missing.join(', '));
  }
  if (resolvedRefs.length) {
    item.reasons.push('named evidence exists on disk (' + resolvedRefs.map((r) => r.path).join(', ') + ') but no admitted in-run event ties it to this ticket — a filename is not a proof');
  }
  if (!refs.length) {
    item.reasons.push('the ticket is closed but carries no checkable evidence at all (test_evidence names no file, related_files is empty)');
  }
  if (!item.reasons.length) item.reasons.push('nothing in the admitted (narrative-free) evidence corroborates this criterion');
  return item;
}

/**
 * coldVerify(opts) -> {checked, skipped_not_done, items, summary:{proven,unproven,unassessable}, scope}
 * opts.run_id — restrict to tickets of one run · opts.ticket_id — a single ticket · opts.projectRoot.
 * Only tickets whose status is 'done' are assessed: an open ticket is not claiming anything yet. Reads
 * every ticket through forge-store (guarded — an unreadable entity is skipped, never a crash).
 */
function coldVerify(opts) {
  opts = opts || {};
  let ids = [];
  try { ids = store.listStore('tickets'); } catch { ids = []; }
  if (opts.ticket_id) ids = ids.filter((i) => i === opts.ticket_id);

  const items = [];
  let skipped = 0;
  for (const id of ids) {
    let data;
    try { data = store.getEntity('tickets', id); } catch { continue; }
    const ticket = Object.assign({ id }, data);
    if (opts.run_id && ticket.run_id !== opts.run_id) continue;
    if (String(ticket.status || '').toLowerCase() !== 'done') { skipped++; continue; }
    const item = coldVerifyTicket(ticket, opts);
    // The FILE this verdict belongs to, kept separate from the ticket's self-declared ticket_id. They are
    // the same for every ticket forge-prd mints, but only this one is the key putEntity accepts — and the
    // write side must never address a ticket by a name the ticket wrote about itself.
    item.store_id = id;
    items.push(item);
  }
  const summary = { proven: 0, unproven: 0, unassessable: 0 };
  for (const it of items) summary[it.verdict] = (summary[it.verdict] || 0) + 1;
  return {
    checked: items.length,
    skipped_not_done: skipped,
    items,
    summary,
    scope: { run_id: opts.run_id || null, ticket_id: opts.ticket_id || null },
  };
}

// ---- the write side: sending an UNPROVEN ticket back --------------------------------------------------
// Read the "TWO MODES" block in the header before changing anything below it — every restraint there is
// load-bearing and is pinned by a test.

// The one status a reopen may produce. Deliberately the SAME target forge-verify.cjs's warm loop uses for
// an unproven done (see its "back to review" branch): the work exists, only the proof does not, and
// inventing a second vocabulary for the same situation would split the board into two dialects.
const REOPEN_TO_STATUS = 'review';
const REOPEN_FROM_STATUS = 'done';
const REOPEN_NOTE = 'cold-verify: reopened — closed on evidence this check could not corroborate';
const EVENT_WRITER = ['forge-dashboard', 'log-event.cjs'];

/** realLogEvent(runId, eventType, extra) -> {ok, status, stdout, stderr, writer}. Shells out to the ONE
 *  real event writer, exactly like forge-artifact.cjs and forge-verify.cjs do — same path resolution off
 *  store.CLAUDE_DIR, so a hermetic FORGE_STORE_ROOT redirects it too. Injectable via opts.logEvent purely
 *  so a test can observe the call without spawning; production always goes through the real writer. */
function realLogEvent(runId, eventType, extra) {
  const writer = path.join(store.CLAUDE_DIR, EVENT_WRITER[0], EVENT_WRITER[1]);
  const r = spawnSync(process.execPath, [writer, runId, eventType, JSON.stringify(extra || {})], { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || (r.error && r.error.message) || '').trim(),
    writer,
  };
}

/** appendNote — same non-clobbering, repeat-safe append forge-verify.cjs uses, so re-running can never
 *  stack the same sentence twice on one ticket. */
function appendNote(existing, msg) {
  const cur = typeof existing === 'string' ? existing : '';
  if (cur.includes(msg)) return cur;
  return cur ? cur + ' | ' + msg : msg;
}

/**
 * planReopen(opts) -> {scope, checked, skipped_not_done, summary, candidates, skipped, event_run_id}
 * Pure: it reads, judges, and decides — it writes nothing, and `reopen` without --confirm returns exactly
 * this. opts are coldVerify's (run_id / ticket_id / projectRoot) plus opts.event_run_id, the run a change
 * should be recorded on when the ticket itself names none.
 *
 * A candidate must clear BOTH bars: this check's own verdict on it is `unproven`, AND there is a run its
 * change can be logged to. Nothing else is eligible — see the header for why `unassessable` is excluded.
 */
function planReopen(opts) {
  opts = opts || {};
  const cold = coldVerify(opts);
  const override = typeof opts.event_run_id === 'string' && opts.event_run_id.trim() ? opts.event_run_id.trim() : null;
  const candidates = [];
  const skipped = [];
  for (const it of cold.items) {
    if (it.verdict !== 'unproven') continue;
    const storeId = it.store_id || it.ticket_id;
    const runId = override || it.run_id;
    if (!storeId) {
      skipped.push({ ticket_id: it.ticket_id, store_id: null, verdict: it.verdict,
        why: 'this verdict carries no store id, so there is no entity to address — refusing to guess one' });
      continue;
    }
    if (!runId) {
      skipped.push({ ticket_id: it.ticket_id, store_id: storeId, verdict: it.verdict,
        why: 'the ticket names no run_id, so a ticket_updated event has no run to land in — a change that cannot be recorded is not made. Pass --event-run <run_id> to say where it belongs.' });
      continue;
    }
    candidates.push({
      ticket_id: it.ticket_id, store_id: storeId, run_id: runId, verdict: it.verdict,
      from_status: REOPEN_FROM_STATUS, to_status: REOPEN_TO_STATUS,
      criterion: it.criterion, criterion_source: it.criterion_source, ac_id: it.ac_id,
      reasons: it.reasons.slice(),
    });
  }
  return {
    scope: cold.scope, checked: cold.checked, skipped_not_done: cold.skipped_not_done,
    summary: cold.summary, candidates, skipped, event_run_id: override,
  };
}

/**
 * reopen(opts) -> planReopen's shape plus {dry_run, changes, reopened, failed}
 * DRY RUN UNLESS opts.confirm === true. A dry run executes nothing and logs nothing — it changed nothing,
 * so it may claim nothing.
 *
 * Per candidate, in this order (see the header's "THE EVENT COMES FIRST"):
 *   1. re-read the entity and re-check that it is STILL `done` — a verdict is about a state, and if that
 *      state has moved the verdict no longer applies to what is on disk;
 *   2. log the ticket_updated through the real writer; a refusal ends this candidate untouched;
 *   3. only then write the ticket back through forge-store's putEntity.
 */
function reopen(opts) {
  const o = opts || {};
  const plan = planReopen(o);
  const dry = o.confirm !== true;
  const result = Object.assign({ dry_run: dry }, plan, { changes: [], reopened: 0, failed: 0 });
  if (dry) return result;

  const logEvent = o.logEvent || realLogEvent;
  const at = new Date().toISOString();
  const done = new Set();
  for (const c of plan.candidates) {
    if (done.has(c.store_id)) continue; // one change per ticket per pass, never twice in the same breath
    done.add(c.store_id);
    const change = {
      ticket_id: c.ticket_id, store_id: c.store_id, run_id: c.run_id,
      from_status: null, to_status: REOPEN_TO_STATUS, event_logged: false, written: false, error: null,
    };

    let data;
    try { data = store.getEntity('tickets', c.store_id); }
    catch (e) {
      change.error = 'could not re-read the ticket before writing: ' + (e && e.message ? e.message : String(e));
      result.changes.push(change); continue;
    }
    const current = String((data && data.status) || '').toLowerCase();
    change.from_status = current;
    if (current !== REOPEN_FROM_STATUS) {
      change.error = 'the ticket is no longer "' + REOPEN_FROM_STATUS + '" (it is now "' + current +
        '") — it moved between the verdict and this write, so the stale judgement is refused rather than applied';
      result.changes.push(change); continue;
    }

    const why = c.reasons.join(' · ');
    const note = REOPEN_NOTE + ': ' + (why.length > 300 ? why.slice(0, 297) + '...' : why);
    const logged = logEvent(c.run_id, 'ticket_updated', {
      agent: 'orchestrator', ticket_id: c.ticket_id, status: REOPEN_TO_STATUS,
      previous_status: REOPEN_FROM_STATUS, verdict: c.verdict, ac_id: c.ac_id, note,
    });
    if (!logged || logged.ok !== true) {
      change.error = 'the ticket_updated event was NOT accepted by ' + EVENT_WRITER.join('/') + ' (' +
        ((logged && (logged.stderr || logged.stdout)) || 'no result from the writer') + ') — the ticket was left untouched';
      result.changes.push(change); continue;
    }
    change.event_logged = true;

    const next = Object.assign({}, data);
    delete next.id; // never persist the synthetic store-key some readers attach; it is not part of the entity
    next.status = REOPEN_TO_STATUS;
    next.previous_status = REOPEN_FROM_STATUS;
    next.note = appendNote(next.note, note);
    next.cold_verify = {
      verdict: c.verdict, reopened_at: at, criterion_source: c.criterion_source, ac_id: c.ac_id,
      reasons: c.reasons, by: 'forge-coldverify.cjs reopen --confirm',
    };
    try { store.putEntity('tickets', c.store_id, next); change.written = true; }
    catch (e) {
      change.error = 'the event was logged but the ticket write FAILED: ' + (e && e.message ? e.message : String(e)) +
        ' — the run log now records a change that did not land; reconcile this before trusting the board';
    }
    result.changes.push(change);
  }
  result.reopened = result.changes.filter((c) => c.written).length;
  result.failed = result.changes.filter((c) => !c.written).length;
  return result;
}

module.exports = {
  coldVerify, coldVerifyTicket, admitEvents, coldTicket, extractReferents, resolveReferent,
  readAdmittedEvents, criterionFor, eventPaths,
  planReopen, reopen, realLogEvent, appendNote,
  COLD_EXCLUDED_EVENT_TYPES, COLD_ADMITTED_EVENT_TYPES, COLD_NON_PROVING_TYPES,
  COLD_NARRATIVE_FIELDS, COLD_EXCLUDED_TICKET_FIELDS, VERDICTS,
  REOPEN_TO_STATUS, REOPEN_FROM_STATUS, REOPEN_NOTE,
};

// ---- CLI ----------------------------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {};
  let asJson = false;
  // The default (no subcommand) invocation is unchanged, down to its flags and exit codes — `reopen` is
  // strictly additive, so every existing caller keeps the read-only behaviour it was written against.
  const sub = argv[0] === 'reopen' ? 'reopen' : 'verify';
  for (let i = (sub === 'reopen' ? 1 : 0); i < argv.length; i++) {
    if (argv[i] === '--run') opts.run_id = argv[++i];
    else if (argv[i] === '--ticket') opts.ticket_id = argv[++i];
    else if (argv[i] === '--root') opts.projectRoot = argv[++i];
    else if (argv[i] === '--event-run') opts.event_run_id = argv[++i];
    else if (argv[i] === '--confirm') opts.confirm = true;
    else if (argv[i] === '--json') asJson = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node forge-coldverify.cjs [--run <run_id>] [--ticket <ticket_id>] [--json] [--root <projectRoot>]');
      console.log('       node forge-coldverify.cjs reopen [--confirm] [--run <id>] [--ticket <id>] [--event-run <id>] [--json] [--root <dir>]');
      console.log('READ-ONLY cold verification: re-checks each DONE ticket against its acceptance criterion with the');
      console.log("builder's narrative structurally removed. Verdicts: proven | unproven | unassessable.");
      console.log('Never writes in this default mode: no ticket is reopened, no status changed, no event logged.');
      console.log('');
      console.log('reopen — sends tickets THIS check judged `unproven` back from done to review. DRY RUN by default:');
      console.log('  without --confirm nothing is written and nothing is logged. A `proven` or `unassessable` ticket is');
      console.log('  never touched ("I could not judge it" is not "it is wrong"). Every change is recorded as a real');
      console.log('  ticket_updated via forge-dashboard/log-event.cjs; a change that cannot be logged is not made');
      console.log('  (--event-run names the run for a ticket that carries none). Re-running it changes nothing twice.');
      process.exit(0);
    } else { console.error('forge-coldverify: unknown argument ' + argv[i]); process.exit(2); }
  }

  if (sub === 'reopen') {
    let r;
    try { r = reopen(opts); }
    catch (e) { console.error('forge-coldverify: ' + (e && e.message ? e.message : String(e))); process.exit(2); }

    if (asJson) {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.failed > 0 ? 1 : 0);
    }
    const sc = r.scope.ticket_id ? 'ticket ' + r.scope.ticket_id : (r.scope.run_id ? 'run ' + r.scope.run_id : 'all tickets');
    console.log('Forge COLD verify — REOPEN' + (r.dry_run ? ' (DRY RUN)' : ' (CONFIRMED)'));
    console.log('  scope: ' + sc + ' · ' + r.checked + ' done ticket(s) assessed · ' +
      r.summary.proven + ' proven · ' + r.summary.unproven + ' unproven · ' + r.summary.unassessable + ' unassessable');
    console.log('  ' + (r.dry_run ? 'WOULD REOPEN' : 'CANDIDATES') + ' (unproven · done -> ' + REOPEN_TO_STATUS + '): ' + r.candidates.length);
    for (const c of r.candidates) {
      console.log('    ' + c.ticket_id + (c.ac_id ? ' [' + c.ac_id + ']' : '') + '  done -> ' + c.to_status);
      console.log('        criterion (' + c.criterion_source + '): ' + (c.criterion || '(none)'));
      for (const why of c.reasons) console.log('        -> ' + why);
      console.log('        ' + (r.dry_run ? 'would log' : 'logs') + ' ticket_updated on run ' + c.run_id +
        ' via ' + EVENT_WRITER.join('/'));
    }
    if (r.skipped.length) {
      console.log('  NOT REOPENED (unproven, but the change could not be recorded):');
      for (const s of r.skipped) console.log('    ' + s.ticket_id + ' — ' + s.why);
    }
    if (!r.dry_run) {
      console.log('  RESULT:');
      for (const c of r.changes) {
        if (c.written) console.log('    ' + c.ticket_id + ': ' + c.from_status + ' -> ' + c.to_status + ' (ticket_updated logged on run ' + c.run_id + ')');
        else console.log('    ' + c.ticket_id + ': NOT CHANGED — ' + c.error);
      }
      console.log('  summary: ' + r.reopened + ' reopened · ' + r.failed + ' failed · ' + r.skipped.length + ' skipped');
      console.log('  (only tickets this check itself judged `unproven` were eligible; nothing was closed or marked done)');
    } else {
      console.log('  summary: ' + r.candidates.length + ' candidate(s) · ' + r.skipped.length + ' skipped');
      console.log('  DRY RUN. Nothing was changed and no event was logged. Add --confirm to actually do this.');
    }
    process.exit(r.failed > 0 ? 1 : 0);
  }

  let res;
  try { res = coldVerify(opts); }
  catch (e) { console.error('forge-coldverify: ' + (e && e.message ? e.message : String(e))); process.exit(2); }

  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log('Forge COLD verify (read-only · builder narrative excluded from input)');
    const sc = res.scope.ticket_id ? 'ticket ' + res.scope.ticket_id : (res.scope.run_id ? 'run ' + res.scope.run_id : 'all tickets');
    console.log('  scope: ' + sc + ' · ' + res.checked + ' done ticket(s) assessed · ' + res.skipped_not_done + ' not-done ticket(s) skipped');
    for (const it of res.items) {
      const mark = it.verdict === 'proven' ? 'PROVEN     ' : (it.verdict === 'unproven' ? 'UNPROVEN   ' : 'UNASSESSABLE');
      console.log('  ' + mark + ' ' + it.ticket_id + (it.ac_id ? ' [' + it.ac_id + ']' : ''));
      console.log('      criterion (' + it.criterion_source + '): ' + (it.criterion || '(none)'));
      console.log('      evidence  : ' + it.evidence_channel);
      for (const r of it.reasons) console.log('      -> ' + r);
    }
    console.log('  summary: ' + res.summary.proven + ' proven · ' + res.summary.unproven + ' unproven · ' + res.summary.unassessable + ' unassessable');
    console.log('  (read-only: nothing was reopened, changed, or logged)');
  }
  process.exit(res.summary.unproven > 0 ? 1 : 0);
}
