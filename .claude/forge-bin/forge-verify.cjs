#!/usr/bin/env node
'use strict';
/**
 * forge-verify.cjs — the "verify-loop": after an agent (or the whole run) claims to be DONE, check
 * whether that claim actually holds against the real events.jsonl and the ticket store. Zero-dependency,
 * Windows-safe. This tool never marks anything done — it only detects mismatches and (with --enforce)
 * reopens/flags them so the task genuinely goes BACK to the agent. A human/agent still has to close it
 * for real.
 *
 * WHY: an agent can log agent_completed while several of its own task events are still open/running/
 * failed. The dashboard already renders that honestly (see forge-dashboard/app.js taskStatus), but
 * nothing previously forced a re-check. This tool is that forcing function.
 *
 * SEMANTICS (mirrored EXACTLY from forge-dashboard/app.js, read before changing either file):
 *   - BACKBONE (app.js ~L55-61): structural milestone event types that are NEVER counted as a per-agent
 *     "task" (run_started, agent_completed, lead_review_completed, etc.).
 *   - statusClass (app.js ~L64-72) + taskStatus (app.js ~L73-98): an event's status is decided by its
 *     explicit `status` field first (via the same substring keyword mapping — "done"/"complete"/"pass"
 *     -> done, "fail"/"block"/"refus" -> failed, etc.); otherwise by its `event_type` falling into one of
 *     six buckets (done / failed / internal / previewing / waiting / running). TERMINAL_TYPES below is the
 *     union of app.js's two "done" event_type lists (the main done list L74-82 + the "already happened"
 *     informational list L94-96) — the two lists are disjoint from every other bucket in app.js, so
 *     checking TERMINAL_TYPES first here is behaviorally identical to app.js's original branch order.
 *   If app.js's BACKBONE/statusClass/taskStatus ever changes, update the matching constants/function here
 *   too — otherwise this tool and the dashboard will disagree about what "done" means.
 *
 * CLI:
 *   node forge-verify.cjs <run_id> [--root <projectRoot>] [--enforce] [--json]
 *     --root     project root (default: two levels up from forge-bin, i.e. this project)
 *     --enforce  for every mismatch: log lead_review_completed + rework_task_created + rework_assigned
 *                (event vocabulary already registered in forge-dashboard/log-event.cjs KNOWN_EVENT_TYPES —
 *                this tool invents NO new event_type names). For every open ticket belonging to the run:
 *                re-store it with status 'open' unchanged + a note, and log ticket_updated. NEVER marks
 *                anything done.
 *     --json     also print the full machine-readable result.
 *   Exit code: 0 when there are no mismatches AND no open tickets for the run; 1 otherwise (gate-able).
 *
 * Module API: { verifyRun, verifyTickets, TERMINAL_TYPES, BACKBONE, buildEnforceEvents }
 *
 * TEST ISOLATION: verifyRun() takes a plain runDir path — no project coupling. verifyTickets() goes
 * through forge-store.cjs, which honors FORGE_STORE_ROOT for hermetic tests (same escape hatch as
 * forge-store.test.cjs / forge-prd.test.cjs). When this file is run as the CLI (not required as a
 * library) and FORGE_STORE_ROOT isn't already set, --root is used to derive it automatically so ticket
 * lookups agree with the same project the CLI was pointed at.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

// When invoked directly as `node forge-verify.cjs ...`, derive FORGE_STORE_ROOT from --root BEFORE
// requiring forge-store.cjs (it resolves its CLAUDE_DIR once, at require time). Skipped when required
// as a library (require.main !== module here) or when the caller already set FORGE_STORE_ROOT (tests).
if (require.main === module && !process.env.FORGE_STORE_ROOT) {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--root');
  const cliRoot = ri !== -1 && argv[ri + 1] ? argv[ri + 1] : DEFAULT_ROOT;
  process.env.FORGE_STORE_ROOT = path.join(path.resolve(cliRoot), '.claude');
}
const store = require('./forge-store.cjs');

// ---- status semantics — MIRRORED from forge-dashboard/app.js (read that file before editing this) ----
function statusClass(s) {
  const v = String(s || '').toLowerCase();
  if (v.includes('internal') || v.includes('conceptual') || v.includes('role only')) return 'internal';
  if (v.includes('preview')) return 'previewing';
  if (v.includes('fail') || v.includes('block') || v.includes('refus')) return 'failed';
  if (v.includes('done') || v.includes('complete') || v.includes('pass')) return 'done';
  if (v.includes('wait') || v.includes('ask') || v.includes('paus') || v.includes('pend') || v.includes('queue') || v.includes('select')) return 'waiting';
  if (v.includes('run') || v.includes('progress') || v.includes('start')) return 'running';
  return 'waiting';
}
// app.js taskStatus() "done" list (L74-82, incl. the 2026-07-10 Fix 2 taxonomy additions
// ticket_created/ticket_updated/cost_sampled) UNION its informational "done" list (L94-96).
const TERMINAL_TYPES = new Set([
  'check_passed', 'retest_completed', 'fix_completed', 'quality_gate_passed', 'agent_completed', 'run_completed',
  'subagent_completed', 'lead_review_completed', 'rework_completed', 'merge_completed', 'codex_review_completed',
  'final_output_created', 'mission_blueprint_created', 'role_map_created', 'skill_discovery', 'skill_map_created', 'custom_skill_created',
  'claude_md_checked', 'claude_md_created', 'claude_md_updated', 'project_skill_dir_checked', 'custom_skill_updated', 'custom_skill_used',
  'skill_registry_checked', 'skill_registry_created', 'skill_registry_updated', 'codex_diagnosis_completed', 'codex_manual_command_created', 'codex_retry_completed',
  'browser_screenshot_captured', 'browser_layout_verified',
  'dashboard_isolation_check_completed', 'dashboard_project_root_detected', 'dashboard_state_reset_for_project', 'dashboard_port_selected', 'dashboard_health_verified',
  'report_generated', 'mission_packet_created', 'codex_finding', 'native_fallback_used', 'review_completed',
  'prd_generated', 'mindmap_generated', 'deep_learn_completed', 'doctor_run', 'registry_scanned', 'artifact_stored', 'gate_evaluated',
  'ticket_created', 'ticket_updated', 'cost_sampled', // Fix 2 (2026-07-10): one-shot FACT events — the event IS the completed micro-action
  // app.js L94-96 — informational/activity events that represent an action that already happened
  'file_read', 'file_changed', 'command_run', 'skill_loaded', 'project_scanned', 'profile_loaded', 'memory_loaded', 'memory_updated',
  'decision_logged', 'agent_note', 'agent_output', 'agent_decision_summary', 'agent_next_action', 'agent_evidence_added',
  'agent_artifact_created', 'subagent_artifact_created', 'subagent_output_created', 'agent_handoff', 'ecc_inventory',
]);

// Fix 1 pairing parity (2026-07-10) — MIRRORED from app.js TASK_PAIRS: a non-BACKBONE start/terminal pair
// describes ONE logical task; the terminal event closes the earliest open start-task instead of counting
// as a second task. Keep in sync with app.js or this tool and the dashboard disagree about X/Y counts.
const TASK_PAIRS = {
  check_started: ['check_passed', 'check_failed'],
  fix_started: ['fix_completed'],
  retest_started: ['retest_completed'],
  rework_started: ['rework_completed'],
  codex_diagnosis_started: ['codex_diagnosis_completed'],
  codex_retry_started: ['codex_retry_completed', 'codex_retry_blocked'],
  browser_proof_started: ['browser_screenshot_captured', 'browser_layout_verified', 'browser_proof_blocked'],
  dashboard_isolation_check_started: ['dashboard_isolation_check_completed'],
  deep_learn_started: ['deep_learn_completed'],
  lead_review_started: ['lead_review_completed'],
};
const TASK_PAIR_TERMINAL_TO_START = {};
for (const startType of Object.keys(TASK_PAIRS)) for (const term of TASK_PAIRS[startType]) TASK_PAIR_TERMINAL_TO_START[term] = startType;
// app.js taskStatus() "failed" list (L83-85)
const FAILED_TYPES = new Set([
  'check_failed', 'agent_failed', 'subagent_failed', 'quality_gate_blocked', 'codex_blocked', 'claude_md_conflict_detected', 'custom_skill_conflict_detected',
  'skill_registry_conflict_detected', 'codex_retry_blocked', 'browser_proof_blocked', 'dashboard_state_project_mismatch', 'dashboard_cross_project_leak_blocked',
  'ecc_blocked', 'ecc_agent_failed',
]);
// app.js taskStatus() "internal" (L86)
const INTERNAL_TYPES = new Set(['codex_not_invoked', 'custom_skill_skipped']);
// app.js taskStatus() "previewing" list (L87-88)
const PREVIEWING_TYPES = new Set([
  'agent_work_package_created', 'custom_subagent_created', 'rework_task_created', 'rework_assigned', 'skill_assigned',
  'codex_trust_gate_detected', 'codex_interactive_retry_required',
]);
// app.js taskStatus() "running" list (L90-92)
const RUNNING_TYPES = new Set([
  'check_started', 'agent_progress', 'agent_started', 'subagent_started', 'codex_review_started', 'fix_started',
  'retest_started', 'lead_review_started', 'rework_started', 'merge_started', 'codex_diagnosis_started', 'codex_retry_started', 'browser_proof_started', 'dashboard_isolation_check_started',
  'run_started', 'review_started',
]);
// app.js taskStatus() — same branch semantics, reordered around disjoint sets (see header comment).
function taskStatus(e) {
  if (e.status) return statusClass(e.status);
  const t = e.event_type;
  if (TERMINAL_TYPES.has(t)) return 'done';
  if (FAILED_TYPES.has(t)) return 'failed';
  if (INTERNAL_TYPES.has(t)) return 'internal';
  if (PREVIEWING_TYPES.has(t)) return 'previewing';
  if (t === 'agent_selected') return 'waiting';
  if (RUNNING_TYPES.has(t)) return 'running';
  return 'waiting'; // unknown event_type — never imply completion (app.js L97)
}

// app.js BACKBONE (~L55-61) — structural milestones, never a per-agent "task".
const BACKBONE = new Set(['run_started', 'run_completed', 'agent_selected', 'agent_started', 'agent_completed', 'agent_failed',
  'subagent_started', 'subagent_completed', 'report_generated', 'final_output_created', 'mission_packet_created', 'mission_blueprint_created', 'role_map_created',
  'agent_work_package_created', 'custom_subagent_created', 'lead_review_started', 'lead_review_completed', 'rework_task_created', 'rework_completed',
  'merge_started', 'merge_completed', 'quality_gate_passed', 'quality_gate_blocked', 'codex_review_started', 'codex_review_completed', 'codex_finding', 'codex_blocked', 'codex_not_invoked',
  'subagent_failed', 'skill_discovery', 'skill_map_created', 'custom_skill_created', 'skill_assigned',
  'prd_generated', 'mindmap_generated', 'deep_learn_completed', 'doctor_run', 'registry_scanned']);

// ---- reading events.jsonl (line-delimited JSON, BOM-tolerant, malformed lines skipped) ----
function readEventsJsonl(runDir) {
  const file = path.join(runDir, 'events.jsonl');
  if (!fs.existsSync(file)) {
    throw new Error('no events.jsonl found at ' + file + ' — run does not exist or has not logged anything yet');
  }
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  const events = [];
  let malformed = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch { malformed++; }
  }
  return { events, malformed };
}

function taskTitle(e) {
  return e.task || e.title || e.note || e.output || e.decision_summary || e.issue || e.event_type || '(untitled)';
}

/**
 * verifyRun(runDir, opts) -> { agents, mismatches, malformed }
 * Reconstructs per-agent task state from events.jsonl the SAME way the dashboard does: each event is
 * attributed to e.agent as-is (no SYNTH fallback — events without an agent are skipped); a non-BACKBONE
 * event is a "task" for that agent; a task is "done" when taskStatus(e) === 'done'. An agent "claims
 * completed" if it has an agent_completed or subagent_completed event anywhere in the run.
 */
function verifyRun(runDir, opts) {
  opts = opts || {};
  const { events, malformed } = readEventsJsonl(runDir);
  const byAgent = new Map();
  events.forEach((e, evIdx) => {
    if (!e || typeof e !== 'object') return;
    const agent = e.agent;
    if (agent == null || agent === '') return; // skip events without an agent — no SYNTH fallback here
    if (!byAgent.has(agent)) byAgent.set(agent, { agent, claimsDone: false, tasks: [] });
    const rec = byAgent.get(agent);
    if (e.event_type === 'agent_completed' || e.event_type === 'subagent_completed') rec.claimsDone = true;
    const t = e.event_type;
    if (BACKBONE.has(t)) return; // structural milestone — not a task
    // Fix 1 pairing parity: a terminal event closes its agent's earliest still-open matching start-task
    // (same rule as app.js buildNodes) instead of counting as a second task.
    const startType = TASK_PAIR_TERMINAL_TO_START[t];
    const openTask = startType && rec.tasks.find((tk) => !tk._closed && tk.event_type === startType);
    if (openTask) { openTask.status = taskStatus(e); openTask.evIdx = evIdx; openTask._closed = true; return; }
    rec.tasks.push({ title: taskTitle(e), evIdx, status: taskStatus(e), event_type: t, _closed: false });
  });
  const agents = Array.from(byAgent.values()).map((rec) => {
    const tasksDone = rec.tasks.filter((tk) => tk.status === 'done').length;
    const tasksOpen = rec.tasks.filter((tk) => tk.status !== 'done')
      .map((tk) => ({ title: tk.title, evIdx: tk.evIdx, status: tk.status, event_type: tk.event_type }));
    return {
      agent: rec.agent,
      claimsDone: rec.claimsDone,
      tasksTotal: rec.tasks.length,
      tasksDone,
      tasksOpen,
      mismatch: rec.claimsDone && tasksDone < rec.tasks.length,
    };
  });
  const mismatches = agents.filter((a) => a.mismatch).length;
  return { agents, mismatches, malformed };
}

/**
 * verifyTickets(opts) -> { tickets, open, unproven }
 * opts.run_id: filter to tickets whose run_id matches (null/omitted -> check all tickets). A ticket is
 * OPEN when its status is not 'done' (case-insensitive). A DONE ticket is UNPROVEN (test-first rule,
 * owner decision 2026-07-10) when it carries a non-empty required_tests[] but no non-empty test_evidence
 * — a done-claim on a code ticket REQUIRES real test evidence. Every read is guarded — an unreadable
 * entity (corrupt/partial file) is skipped, never crashes the check.
 */
function verifyTickets(opts) {
  opts = opts || {};
  const runId = opts.run_id || null;
  let ids = [];
  try { ids = store.listStore('tickets'); } catch { ids = []; }
  const tickets = [];
  for (const id of ids) {
    let data;
    try { data = store.getEntity('tickets', id); } catch { continue; } // guarded — skip unreadable entities
    tickets.push(Object.assign({ id }, data));
  }
  const relevant = runId ? tickets.filter((tk) => tk.run_id === runId) : tickets;
  const open = relevant.filter((tk) => String(tk.status || '').toLowerCase() !== 'done');
  const unproven = relevant.filter((tk) => String(tk.status || '').toLowerCase() === 'done'
    && Array.isArray(tk.required_tests) && tk.required_tests.length > 0
    && !(typeof tk.test_evidence === 'string' && tk.test_evidence.trim()));
  return { tickets: relevant, open, unproven };
}

/**
 * buildEnforceEvents(mismatch) -> [{event_type, extra}, ...]
 * Pure payload builder for one mismatched agent (an entry from verifyRun().agents with mismatch===true).
 * Only emits event_type names already registered in forge-dashboard/log-event.cjs KNOWN_EVENT_TYPES:
 * lead_review_completed, rework_task_created, rework_assigned. Never marks anything done.
 */
function buildEnforceEvents(m) {
  const agent = m.agent;
  const frac = m.tasksDone + '/' + m.tasksTotal;
  const openTitles = (m.tasksOpen || []).map((t) => t.title).filter(Boolean).join('; ');
  return [
    {
      event_type: 'lead_review_completed',
      extra: {
        agent: 'orchestrator',
        note: 'verify-loop: ' + agent + ' claims done with ' + frac + ' tasks',
        evidence: openTitles || ((m.tasksTotal - m.tasksDone) + ' open task(s), no titles recorded'),
      },
    },
    {
      event_type: 'rework_task_created',
      extra: {
        agent: 'orchestrator',
        target: agent,
        issue: 'claims done with ' + frac + ' tasks done',
        required_fix: 'finish or honestly report remaining tasks',
      },
    },
    { event_type: 'rework_assigned', extra: { agent: 'orchestrator', to: agent } },
  ];
}

module.exports = { verifyRun, verifyTickets, TERMINAL_TYPES, BACKBONE, TASK_PAIRS, buildEnforceEvents };

// ---- CLI ----
if (require.main === module) {
  function parseArgs(argv) {
    const out = { run_id: null, root: DEFAULT_ROOT, enforce: false, json: false };
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--root') out.root = argv[++i];
      else if (a === '--enforce') out.enforce = true;
      else if (a === '--json') out.json = true;
      else pos.push(a);
    }
    out.run_id = pos[0] || null;
    return out;
  }

  function fmtAgentLine(a) {
    if (a.mismatch) {
      const titles = a.tasksOpen.map((t) => t.title).join('; ');
      return '  ⚠ MISMATCH ' + a.agent + ' — claims done · ' + a.tasksDone + '/' + a.tasksTotal +
        ' tasks (' + a.tasksOpen.length + ' open: ' + titles + ')';
    }
    if (a.claimsDone) return '  ✓ ' + a.agent + ' — claims done · ' + a.tasksDone + '/' + a.tasksTotal + ' tasks';
    return '  • ' + a.agent + ' — in progress · ' + a.tasksDone + '/' + a.tasksTotal + ' tasks';
  }

  function logEvent(root, runId, eventType, extra) {
    const logEventPath = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
    const r = spawnSync(process.execPath, [logEventPath, runId, eventType, JSON.stringify(extra || {})], { encoding: 'utf8' });
    if (r.status !== 0) console.error('forge-verify: log-event warning (' + eventType + '): ' + ((r.stderr || r.stdout || '').trim()));
    return r;
  }

  // append a verify-loop note without clobbering an existing note; idempotent across repeated enforces
  function appendNote(existing, msg) {
    const cur = typeof existing === 'string' ? existing : '';
    if (cur.includes(msg)) return cur;
    return cur ? cur + ' | ' + msg : msg;
  }

  function enforce(root, runId, result, ticketResult) {
    const mismatched = result.agents.filter((a) => a.mismatch);
    for (const m of mismatched) {
      for (const ev of buildEnforceEvents(m)) logEvent(root, runId, ev.event_type, ev.extra);
    }
    for (const tk of ticketResult.open) {
      const id = tk.id;
      try {
        const rest = Object.assign({}, tk);
        delete rest.id; // strip the synthetic store-id key verifyTickets() attaches — not part of the entity
        // status PRESERVED (a 'review'/'blocked' ticket keeps its kanban column) — verify-loop never
        // closes anything and never resets a ticket's position; it only annotates.
        rest.note = appendNote(rest.note, 'verify-loop: still open at verification');
        store.putEntity('tickets', id, rest);
        logEvent(root, runId, 'ticket_updated', { agent: 'orchestrator', ticket_id: (tk.ticket_id || id), note: 'verify-loop: still open at verification' });
      } catch (e) {
        console.error('forge-verify: could not update ticket ' + id + ': ' + e.message);
      }
    }
    // test-first rule: a done-ticket with required_tests but no test_evidence is an UNPROVEN claim —
    // send it back: status -> 'review' (un-marking an unproven done is the one status change allowed;
    // this tool still never marks anything done).
    for (const tk of ticketResult.unproven) {
      const id = tk.id;
      try {
        const rest = Object.assign({}, tk);
        delete rest.id;
        rest.status = 'review';
        rest.note = appendNote(rest.note, 'verify-loop: done claimed without test_evidence for required_tests — back to review');
        store.putEntity('tickets', id, rest);
        logEvent(root, runId, 'ticket_updated', { agent: 'orchestrator', ticket_id: (tk.ticket_id || id), note: 'verify-loop: unproven done (required_tests without test_evidence) — back to review' });
      } catch (e) {
        console.error('forge-verify: could not update ticket ' + id + ': ' + e.message);
      }
    }
    const did = mismatched.length || ticketResult.open.length || ticketResult.unproven.length;
    console.log(did
      ? 'ENFORCED: rework logged for ' + mismatched.length + ' agent(s), ' + ticketResult.open.length + ' ticket(s) flagged still-open, ' + ticketResult.unproven.length + ' unproven done-ticket(s) back to review.'
      : 'ENFORCE: nothing to do (no mismatches, no open tickets, no unproven done-tickets).');
  }

  function cliMain(opts) {
    const root = path.resolve(opts.root);
    const runDir = path.join(root, '.claude', 'forge-runs', opts.run_id);
    const result = verifyRun(runDir, opts);
    const ticketResult = verifyTickets({ run_id: opts.run_id });

    const lines = ['Forge Verify — ' + opts.run_id];
    if (!result.agents.length) lines.push('  (no agent activity recorded yet)');
    for (const a of result.agents) lines.push(fmtAgentLine(a));
    lines.push('Tickets:');
    if (!ticketResult.tickets.length) lines.push('  (no tickets found for this run)');
    else if (!ticketResult.open.length && !ticketResult.unproven.length) lines.push('  ✓ all tickets closed (with test evidence where required)');
    else {
      for (const tk of ticketResult.open) lines.push('  ⚠ OPEN ' + (tk.ticket_id || tk.id) + ' "' + (tk.title || '') + '"');
      for (const tk of ticketResult.unproven) lines.push('  ⚠ UNPROVEN DONE ' + (tk.ticket_id || tk.id) + ' "' + (tk.title || '') + '" — required_tests without test_evidence');
    }
    lines.push('VERIFY: ' + result.mismatches + ' mismatch(es), ' + ticketResult.open.length + ' open ticket(s), ' + ticketResult.unproven.length + ' unproven done-ticket(s)');
    console.log(lines.join('\n'));

    if (opts.json) {
      console.log(JSON.stringify({
        run_id: opts.run_id, root, agents: result.agents, mismatches: result.mismatches, malformed: result.malformed,
        tickets: ticketResult.tickets, open_tickets: ticketResult.open, unproven_tickets: ticketResult.unproven,
      }, null, 2));
    }

    if (opts.enforce) enforce(root, opts.run_id, result, ticketResult);

    process.exitCode = (result.mismatches === 0 && ticketResult.open.length === 0 && ticketResult.unproven.length === 0) ? 0 : 1;
  }

  const opts = parseArgs(process.argv.slice(2));
  if (!opts.run_id || !/^[A-Za-z0-9_-]+$/.test(opts.run_id)) {
    console.error('Usage: node forge-verify.cjs <run_id> [--root <projectRoot>] [--enforce] [--json]');
    console.error('invalid or missing run_id (allowed: A-Z a-z 0-9 _ -)');
    process.exitCode = 1;
  } else {
    try { cliMain(opts); } catch (e) { console.error('forge-verify: ' + e.message); process.exitCode = 1; }
  }
}
