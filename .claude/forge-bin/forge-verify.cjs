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
 *   node forge-verify.cjs <run_id> [--root <projectRoot>] [--enforce] [--json] [--domain <domain>]
 *                                  [--max-rounds N] [--dry-streak N]
 *     --root     project root (default: two levels up from forge-bin, i.e. this project)
 *     --enforce  for every mismatch: log lead_review_completed + rework_task_created + rework_assigned
 *                (event vocabulary already registered in forge-dashboard/log-event.cjs KNOWN_EVENT_TYPES —
 *                this tool invents NO new event_type names). For every open ticket belonging to the run:
 *                re-store it with status 'open' unchanged + a note, and log ticket_updated. NEVER marks
 *                anything done.
 *     --json     also print the full machine-readable result.
 *     --domain   ADVISORY (WAVE C / C-INTEGRATE, 2026-07-18): required-evidence check for a website/
 *                fullstack/n8n/scraping/rag/prediction/integration run — see evidenceCheck() below.
 *                Prints a loud "Evidence:" section but NEVER changes the exit code (mirrors this project's
 *                other advisory-only checks, e.g. forge-doctor's completeness advisory). Omitted -> skipped.
 *     --max-rounds / --dry-streak  (2026-08-01, "pakket 2") tune the loop-until-dry brake, defaults
 *                LOOP_MAX_ROUNDS=5 / LOOP_DRY_STREAK=1. A "Loop:" section is ALWAYS printed (rounds, new
 *                findings per round, dry streak, cap) and, like Evidence:, never changes the exit code.
 *                Under --enforce it is not just printed but ENFORCED: once loopBrake() says the loop hit
 *                its cap or went dry AND this pass would otherwise have opened a new rework round, it opens
 *                none and logs exactly one already-registered `quality_gate_blocked` event instead — once
 *                per run, not once per --enforce. See loopBrake() and brakeAlreadyLogged() below.
 *   Exit code: 0 only when EVERY gate in EXIT_GATES is zero; 1 otherwise (gate-able). EXIT_GATES (see its
 *   own doc comment further down) is the authoritative list — today: mismatches, open tickets, unproven
 *   done-tickets, isolation violations, acceptance gaps, failure-condition hits. It is DATA, not a hand-
 *   written `&&` chain, because on 2026-08-01 a witness deleted one clause from that chain and the whole
 *   test suite stayed green; every gate now has an isolating scenario in forge-verify-gates.test.cjs.
 *   The --domain evidence check, the Non-Goals, Config Drift and Loop sections are NEVER part of this gate —
 *   they are advisory/loud only, which is exactly what "not in EXIT_GATES" means.
 *
 * Module API: { verifyRun, verifyTickets, isolationTripwire, roundsFromEvents, loopConvergence,
 *   TERMINAL_TYPES, BACKBONE, buildEnforceEvents, evidenceCheck, checkAcceptanceCoverage,
 *   buildAcceptanceEnforceEvents, checkFailureConditions, checkNonGoals, checkRequiredInputs,
 *   EXIT_GATES, gateCounts, gateSummary, exitCodeFor }
 *
 * BACKLOG ITEM 7 / spec-drift (2026-07-31, see .claude/forge-research/MINING-RONDE-1-2026-07-31.md section
 * 2 — Forge-native design mined from get-shit-done-cc's "Requirement Coverage" checker): verifyRun/
 * verifyTickets only ever look at tickets that already exist — a PRD acceptance criterion silently dropped
 * before/during planning (no ticket ever created for it, or its ticket later deleted) was previously
 * invisible to this tool. checkAcceptanceCoverage() below closes that gap by starting from the PRD's OWN
 * acceptance_criteria list instead — see its own header comment for the exact rule.
 *
 * TEST ISOLATION: verifyRun() takes a plain runDir path — no project coupling. verifyTickets() goes
 * through forge-store.cjs, which honors FORGE_STORE_ROOT for hermetic tests (same escape hatch as
 * forge-store.test.cjs / forge-prd.test.cjs). When this file is run as the CLI (not required as a
 * library) and FORGE_STORE_ROOT isn't already set, --root is used to derive it automatically so ticket
 * lookups agree with the same project the CLI was pointed at.
 *
 * WAVE A (2026-07-18, dd-orchestration-doctor B4 + A1) additions:
 *   - isolationTripwire(runDir, projectRoot): scans a run's file_changed/file_read/command_run/
 *     custom_skill_created/custom_skill_updated events for any logged path that resolves OUTSIDE
 *     projectRoot (absolute-outside-root or a `../` escape) — real logged evidence for the CLAUDE.md
 *     "only this folder" rule instead of trust. Reuses forge-actiongate.cjs's isPathEscape() classifier
 *     (the single source of truth for path-escape detection, shared with forge-doctor's advisory
 *     aggregation) when that module can be loaded; falls back to a local plain-resolve check otherwise
 *     so this tool degrades gracefully rather than throwing if forge-actiongate.cjs is ever absent.
 *     Wired into the CLI: an "Isolation:" section is printed and violations fold into the exit code,
 *     same weight as an open ticket or an agent mismatch.
 *   - roundsFromEvents(events) / loopConvergence(rounds, opts): the "loop-until-dry" convergence check
 *     for the QA/rework loop (dd-orchestration-doctor A1). Groups rework_task_created/check_failed/
 *     codex_finding events into rounds split at lead_review_started/retest_started markers, then reports
 *     converged=true once the trailing N rounds (opts.dryStreak, default 1) contributed ZERO findings not
 *     already seen in an earlier round. Pure/read-only — like verifyRun, it never logs the events it
 *     inspects; the caller (a future orchestrator) decides what to do with the verdict.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

/** isDisprovenEvent(e) -> boolean (V23 fix, 2026-09-24 second Codex recheck, out-p7.md) — delegates to the
 *  ONE shared predicate in forge-proof-gate.cjs (also consulted by forge-runcontract.cjs's isGoedkeuring)
 *  so this file's task-closure path and the independent-review protocol can never again disagree about
 *  whether a claim is disproven. Falls back to the identical inline check if the sibling is ever
 *  unreachable — same resilience convention every other loadXTool() lazy-loader in this file already uses. */
let _proofGateCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadProofGate() {
  if (_proofGateCache !== undefined) return _proofGateCache;
  try { _proofGateCache = require('./forge-proof-gate.cjs'); } catch { _proofGateCache = null; }
  return _proofGateCache;
}
function isDisprovenEvent(e) {
  const pg = loadProofGate();
  if (pg && typeof pg.isDisprovenEvent === 'function') return pg.isDisprovenEvent(e);
  return !!(e && typeof e === 'object' && e._forge_verify && e._forge_verify.proof_verified === false);
}

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
// 2026-08-01 — the cost cap on unattended runs. Only budgetStops() is used here: it reads the verdict
// trail an unattended wrapper leaves in the run directory. No project coupling (it takes a plain runDir,
// same convention as verifyRun), so it is hermetic in exactly the same way.
const { budgetStops } = require('./forge-run-budget.cjs');

// 2026-08-01 — forge-configdrift.cjs is a SOFT sibling dependency, exactly like forge-doctor.cjs treats
// forge-contextbudget.cjs: the "Config Drift:" section is ADVISORY, so this file must keep working (and keep
// gating on the things it really does gate on) if that module is ever absent, renamed, or broken. A missing
// module degrades to a printed "unavailable" line, never to a throw and never to a silent pass.
let configDriftTool;
try { configDriftTool = require('./forge-configdrift.cjs'); } catch { configDriftTool = null; }

// ---- status semantics — MIRRORED from forge-dashboard/app.js (read that file before editing this) ----
// VERIFY-FAILED-REVIEW-DONE (2026-09-24, out-p5.md) — substring matching turned "incomplete" into a DONE
// status, because "incomplete".includes("complete") is true and the done-check ran before anything caught
// it. A negation prefix on an otherwise-positive word is not a positive status; checked BEFORE the
// done/pass check so it can never be shadowed by it. Mirrored 1:1 in app.js's statusClass().
const NEGATED_DONE_RE = /\b(?:in|un|non|not)[ -]?(?:complete|completed|done|finished|pass|passed)\b|\bnot\s+(?:complete|completed|done|finished|pass(?:ed)?)\b/;
function statusClass(s) {
  const v = String(s || '').toLowerCase();
  if (v.includes('internal') || v.includes('conceptual') || v.includes('role only')) return 'internal';
  if (v.includes('preview')) return 'previewing';
  if (v.includes('fail') || v.includes('block') || v.includes('refus')) return 'failed';
  if (NEGATED_DONE_RE.test(v)) return 'failed';
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
  // OWNER GOVERNANCE (WAVE B / B4, 2026-07-18): the applied-prefs ECHO — one-shot informational event, mirrors
  // profile_loaded/memory_loaded. See log-event.cjs KNOWN_EVENT_TYPES and forge-dashboard/app.js taskStatus().
  'owner_prefs_loaded',
  // config_changed (v2.7.0, 2026-09-24): forge-config.cjs diff({run}) recorded that owner settings changed since
  // the last run — a one-shot informational fact like owner_prefs_loaded/decision_logged.
  'config_changed',
  // PAPERCLIP CONTROL PLANE done-status events (WAVE C / C-INTEGRATE, 2026-07-18) — every logEvent() call
  // site in forge-paperclip.cjs already carries an explicit status:'done'/'failed'/'previewing' field, so
  // statusClass() decides classification first in practice; these entries are the honest event_type-only
  // fallback bucket, mirrored 1:1 with app.js taskStatus(). See log-event.cjs KNOWN_EVENT_TYPES header.
  'paperclip_runtime_reused', 'paperclip_runtime_started', 'paperclip_skills_catalog_installed',
  'paperclip_agent_instructions_set', 'paperclip_agent_skills_attached', 'paperclip_selected',
  'paperclip_company_reused', 'paperclip_company_created', 'paperclip_goal_created', 'paperclip_project_created',
  'paperclip_workspace_bound', 'paperclip_agent_reused', 'paperclip_agent_docs_written', 'paperclip_agents_paused',
  'paperclip_agents_resumed', 'paperclip_runtime_stopped',
  // REQUIRED-EVIDENCE one-shot fact events (WAVE C / C2+C-INTEGRATE, 2026-07-18) — the event IS the completed
  // proof-fact, same taxonomy as ticket_created/cost_sampled/browser_screenshot_captured. See
  // config/orchestration/required-evidence.json + log-event.cjs KNOWN_EVENT_TYPES header.
  'zero_console_errors_noted', 'e2e_passed', 'e2e_result', 'integration_gate_passed',
  'validate_workflow_passed', 'workflow_validated', 'workflow_imported_inactive', 'robots_checked',
  'source_compliance_noted', 'citation_verified', 'ingestion_idempotency_verified', 'backtest_completed',
  'uncertainty_labels_applied', 'webhook_auth_verified', 'outreach_drafted_only_noted',
  // WAVE D (D-INTEGRATE, 2026-07-18) — manifest_armed (run-level one-shot fact, mirrors registry_scanned/
  // prd_generated) and fixtures_waived (check() accepted an explicit logged waiver — ok:true, flagged not
  // silent) are both "done". See log-event.cjs KNOWN_EVENT_TYPES header for the full model.
  'manifest_armed', 'fixtures_waived',
  // forge-harvest.cjs (2026-07-18, post-WAVE-E): lessons_harvested — a completed READ-ONLY cross-project
  // learning harvest, one-shot fact same taxonomy as memory_updated/registry_scanned. See log-event.cjs
  // KNOWN_EVENT_TYPES header for the full model.
  'lessons_harvested',
  // WAVE H (H1 forge-docs.cjs, H2 forge-repomap.cjs, H4 forge-beads.cjs, H-INTEGRATE, 2026-07-19): one-shot
  // deliverable/fact events, same taxonomy as artifact_stored/ticket_created — per-task facts, not run-wide
  // BACKBONE milestones. doc_generated has a REAL call site (forge-docs.cjs --run); repomap_generated /
  // bead_added / bead_closed are forward-declared (no current call site — see log-event.cjs KNOWN_EVENT_TYPES).
  'doc_generated', 'repomap_generated', 'bead_added', 'bead_closed',
  // WAVE G (G1 forge-mcp-gate.cjs + G-INTEGRATE, 2026-07-19) — MCP-as-client least-privilege one-shot fact
  // events, same taxonomy as gate_evaluated/native_fallback_used (the event IS the completed decision, no
  // separate start/terminal pair). mcp_grant_denied is handled separately below (FAILED_TYPES-equivalent in
  // app.js taskStatus()), not here. See log-event.cjs KNOWN_EVENT_TYPES header for the full model.
  'mcp_grant_validated', 'mcp_tool_loaded', 'mcp_native_fallback',
  // WAVE J (J1-J5 + J-INTEGRATE, 2026-07-19) — one-shot fact/deliverable events, same taxonomy as
  // registry_scanned/doc_generated/gate_evaluated. skill_approved: forge-genesis.cjs::approve() promoted a
  // staged draft (real owner-approval token). tournament_planned/tournament_scored: forge-tournament.cjs
  // plan()/score(). portfolio_scanned: forge-secondbrain.cjs scan()/report(). codemodel_built/
  // codemodel_updated: forge-codemodel.cjs build()/update(). briefing_generated: forge-briefing.cjs
  // generate(). skill_proposed (staged, not yet approved) is in PREVIEWING_TYPES below; proposal_rejected
  // is in FAILED_TYPES below. See log-event.cjs KNOWN_EVENT_TYPES header for the full model.
  'skill_approved', 'tournament_planned', 'tournament_scored', 'portfolio_scanned',
  'codemodel_built', 'codemodel_updated', 'briefing_generated',
  // V9-INTEGRATE (P1 forge-runcontract.cjs, P2 forge-capabilities.cjs, P4 forge-projectbrain.cjs,
  // P5 forge-scout.cjs, 2026-07-22) — one-shot fact/deliverable "done" events, same taxonomy as
  // registry_scanned/doc_generated/gate_evaluated. run_contract_violated is in FAILED_TYPES below (a genuine
  // ok:false contract result is a failure, not a done fact). See log-event.cjs KNOWN_EVENT_TYPES header.
  'research_done', 'run_contract_checked', 'capabilities_reported', 'scout_researched',
  'capability_vetted', 'projectbrain_generated',
  // V9-fix (2026-07-22, break-swarm DEFECT 2/3 honesty-gap close-out) — owner_override: a real, structured,
  // attributed owner act clearing one named rule (forge-runcontract.cjs::findOwnerOverride()). One-shot fact
  // event, same taxonomy as decision_logged/manifest_armed. See log-event.cjs KNOWN_EVENT_TYPES header.
  'owner_override',
  // V9 WAVE 2 (forge-bin/forge-audit-loop.cjs, 2026-07-22) — the continuous AUDIT-LOOP tool's own one-shot
  // fact events, same taxonomy as doctor_run/codex_finding: audit_iteration (one real iteration completed),
  // audit_finding (one real finding surfaced by that iteration). See log-event.cjs KNOWN_EVENT_TYPES header.
  'audit_iteration', 'audit_finding',
  // REJECTED-APPROACH MEMORY (forge-bin/forge-tool-index.cjs, 2026-07-31 — mining-ronde-1 §1) —
  // rejected_approach: a real, already-evidenced decision that one specific approach was tried and rejected.
  // One-shot FACT/'done' event, same taxonomy as decision_logged/lessons_harvested/codex_finding: the event
  // IS the completed, proven decision, NOT an open problem. See log-event.cjs KNOWN_EVENT_TYPES header.
  // DELIBERATELY NOT in FAILED_TYPES (honest logging is not a defect — classifying it red would punish
  // exactly the behaviour we want), NOT in BACKBONE/RUNNING_TYPES/PREVIEWING_TYPES, and above all NOT in
  // FINDING_EVENT_TYPES: a rejected approach recorded once per run would otherwise read as a RECURRING
  // finding and poison the loop-convergence check.
  'rejected_approach',
  // WORK-PACKAGE OUTCOMES + MODEL PROVENANCE (2026-08-01, "pakket 1") — mirrored 1:1 with log-event.cjs
  // KNOWN_EVENT_TYPES and app.js taskStatus(). wp_completed: the per-WP done fact forge-manifest.cjs's
  // DONE_EVENT_TYPES already consumed but that could never be written; a per-task terminal like check_passed,
  // NOT a BACKBONE milestone (its start counterpart wp_resumed is likewise a per-WP RUNNING_TYPES member,
  // and the two are paired in TASK_PAIRS below so a resumed WP is one task, not two). wp_failed is in
  // FAILED_TYPES below. agent_model_used: a one-shot per-agent FACT — the event IS the recorded model —
  // same taxonomy as cost_sampled/decision_logged; never a failure, never a run-level milestone.
  'wp_completed', 'agent_model_used',
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
  // 2026-08-01 ("pakket 1") — wp_resumed (a specific unfinished WP re-dispatched) is a START whose real
  // terminals are wp_completed/wp_failed, exactly the check_started -> check_passed/check_failed shape. Both
  // sides are non-BACKBONE, so this pairing genuinely applies (unlike e.g. rework_started, whose terminal IS
  // a BACKBONE event and is therefore intentionally a no-op in app.js). Mirrored in app.js TASK_PAIRS.
  wp_resumed: ['wp_completed', 'wp_failed'],
  // 2026-09-24 (loop wp-l1) — real defect: a verify-boss run ended with 2 "open" review_started tasks even
  // though both matching review_completed events were logged, and the Lead had to hand-close them with
  // fix_completed + closes_event_id. review_started/review_completed is otherwise the same start/terminal
  // shape as check_started/check_passed, except a review carries an OPTIONAL review_id that must be matched
  // exactly when present on the terminal (see the review_id-aware openTask lookup below) — a review_completed
  // for a DIFFERENT review_id must never close the wrong review_started. Mirrored in app.js TASK_PAIRS.
  review_started: ['review_completed'],
};
const TASK_PAIR_TERMINAL_TO_START = {};
for (const startType of Object.keys(TASK_PAIRS)) for (const term of TASK_PAIRS[startType]) TASK_PAIR_TERMINAL_TO_START[term] = startType;

/** VERIFY-ARBITRARY-CLOSURE (2026-09-24, out-p5.md) — closes_event_id's ONLY proof requirement used to be
 *  `typeof e.evidence === 'string' && e.evidence.trim().length > 0`, so a bare "." satisfied it; nothing
 *  checked the target's TYPE (any earlier task, of any kind, could be "closed"); nothing prevented a SECOND
 *  closer from re-closing an already-closed target (target._closed was set but never re-checked); and
 *  nothing distinguished a closer clearing its OWN earlier task (self-closure) from a genuinely independent
 *  one closing it. Four fixes, all additive to the existing forward-reference/unknown-id checks:
 *   (1) a minimal MEANINGFUL-evidence grammar — non-blank, at least 3 characters, and not just punctuation.
 *       A bare "." no longer counts as "evidence" (this alone closes the reproduced repro: a failed,
 *       already-closed review turning "done" via `evidence:"."`).
 *   (2) single consumption — an already-`_closed` target is refused, not silently re-closed.
 *   (3) an OPEN task only — the target's CURRENT status (taskStatus(), the same status the dashboard and
 *       every other gate in this file already agree on) must not already be 'done'. A closer that only ever
 *       becomes a task at all in this loop is, by construction, never a BACKBONE milestone (those `return`
 *       before a task object is created) — so this is genuinely "is there still open work here", not a
 *       second, parallel type taxonomy that could drift from taskStatus().
 *   (4) SELF-closure (the closer is the SAME agent that logged the target task) additionally needs a real
 *       tally (n/m) or exit-code line in the evidence — ordinary meaningful prose closes a DIFFERENT agent's
 *       task, but an agent clearing its own earlier task needs the stronger, harder-to-fabricate form. */
const CLOSURE_TALLY_OR_EXIT_RE = /\b\d+\s*\/\s*\d+\b|\bexit(?:\s*code)?\s*[:=]?\s*-?\d+\b/i;
function isMeaningfulClosureEvidence(evidence) {
  const v = typeof evidence === 'string' ? evidence.trim() : '';
  if (v.length < 3) return false; // "." / ".." / too short to be a real statement
  if (/^[.\-_*~`'"]+$/.test(v)) return false; // punctuation-only
  return true;
}
function hasTallyOrExitEvidence(evidence) {
  return CLOSURE_TALLY_OR_EXIT_RE.test(typeof evidence === 'string' ? evidence.trim() : '');
}
// app.js taskStatus() "failed" list (L83-85)
const FAILED_TYPES = new Set([
  'check_failed', 'agent_failed', 'subagent_failed', 'quality_gate_blocked', 'codex_blocked', 'claude_md_conflict_detected', 'custom_skill_conflict_detected',
  'skill_registry_conflict_detected', 'codex_retry_blocked', 'browser_proof_blocked', 'dashboard_state_project_mismatch', 'dashboard_cross_project_leak_blocked',
  'ecc_blocked', 'ecc_agent_failed',
  // PAPERCLIP CONTROL PLANE failed-status events (WAVE C / C-INTEGRATE, 2026-07-18) — see TERMINAL_TYPES note above.
  'paperclip_runtime_blocked', 'paperclip_agent_instructions_failed', 'paperclip_agent_skills_failed',
  'paperclip_git_guard_warning', 'paperclip_agent_failed',
  // WAVE D (D-INTEGRATE, 2026-07-18) — fixtures_required: forge-fixtures.cjs::check() found a
  // correctness-critical domain with no real fixtures and no logged waiver (ok:false, exit 3 BLOCKED).
  'fixtures_required',
  // WAVE G (G1 forge-mcp-gate.cjs + G-INTEGRATE, 2026-07-19) — mcp_grant_denied: a validateGrant() call
  // resolved allowed:false (not opted-in / above tier / not granted / tier-3 without a confirmed hard gate).
  'mcp_grant_denied',
  // WAVE J (J1 forge-genesis.cjs + J-INTEGRATE, 2026-07-19) — proposal_rejected: a staged skill proposal was
  // explicitly declined by the owner (a real refusal outcome, same taxonomy as codex_blocked/ecc_blocked).
  'proposal_rejected',
  // V9-INTEGRATE (P1 forge-runcontract.cjs, 2026-07-22) — run_contract_violated: forge-runcontract.cjs::check()
  // resolved a run's non-negotiables to ok:false (a genuinely missing, non-overridden block-rule).
  'run_contract_violated',
  // WORK-PACKAGE OUTCOMES (2026-08-01, "pakket 1") — wp_failed: the per-WP failure fact forge-manifest.cjs's
  // FAILED_EVENT_TYPES and forge-briefing.cjs's BLOCKED_EVENT_TYPES already consumed but that could never be
  // written. Same taxonomy as check_failed; its done counterpart wp_completed is in TERMINAL_TYPES above.
  // Deliberately NOT added to FINDING_EVENT_TYPES: loop convergence counts review/QA findings, and a failed
  // work package is a status, not a repeat finding.
  'wp_failed',
]);
// app.js taskStatus() "internal" (L86)
const INTERNAL_TYPES = new Set(['codex_not_invoked', 'custom_skill_skipped']);
// app.js taskStatus() "previewing" list (L87-88)
const PREVIEWING_TYPES = new Set([
  'agent_work_package_created', 'custom_subagent_created', 'rework_task_created', 'rework_assigned', 'skill_assigned',
  'codex_trust_gate_detected', 'codex_interactive_retry_required',
  // PAPERCLIP CONTROL PLANE previewing-status events (WAVE C / C-INTEGRATE, 2026-07-18) — see TERMINAL_TYPES note above.
  'paperclip_agent_created', 'paperclip_ticket_created',
  // WAVE J (J1 forge-genesis.cjs + J-INTEGRATE, 2026-07-19) — skill_proposed: a draft was staged to
  // `.claude/forge-genesis-staging/` but is NOT active — "logged, not executed", same taxonomy as
  // custom_subagent_created/rework_task_created.
  'skill_proposed',
]);
// app.js taskStatus() "running" list (L90-92)
const RUNNING_TYPES = new Set([
  'check_started', 'agent_progress', 'agent_started', 'subagent_started', 'codex_review_started', 'fix_started',
  'retest_started', 'lead_review_started', 'rework_started', 'merge_started', 'codex_diagnosis_started', 'codex_retry_started', 'browser_proof_started', 'dashboard_isolation_check_started',
  'run_started', 'review_started',
  // WAVE D (D-INTEGRATE, 2026-07-18) — wp_resumed: a specific unfinished work package was re-dispatched
  // (forge-swarm-resume.cjs::resume()), a per-WP "started again" event, same taxonomy as check_started —
  // never a run-level backbone milestone.
  'wp_resumed',
]);
/** VERIFY-FAILED-REVIEW-DONE (2026-09-24, out-p5.md) — taskStatus() only ever read the generic `status`
 *  field; a review_completed/codex_review_completed carrying `review_verdict:"fail"` (or `verdict`/`result`/
 *  `outcome`, or `ok:false`) with NO `status` field fell straight through to TERMINAL_TYPES membership and
 *  read as 'done' regardless — the verifier and forge-runcontract.cjs's own independent-review gate then
 *  DISAGREED about the same event. Fixed by reusing forge-runcontract.cjs's own explicit vocabulary
 *  (isGoedkeuring/UITKOMST_VELDEN/POSITIEVE_REVIEW_VERDICTS) rather than re-deriving a second one that could
 *  drift — REQUIRED here, this file already treats forge-runcontract.cjs as a sibling to lean on (see
 *  evidenceCheck() above). Scoped to REVIEW_DONE_EVENT_TYPES only: every other event_type's status
 *  derivation is unchanged. A bare `{event_type:'review_completed'}` carrying NONE of the outcome fields at
 *  all falls through to the ordinary TERMINAL_TYPES-membership default below (a legacy/minimal event is not
 *  penalised for a field it never had). */
const REVIEW_DONE_EVENT_TYPES = new Set(['review_completed', 'codex_review_completed']);
let _runcontractCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadRuncontractTool() {
  if (_runcontractCache !== undefined) return _runcontractCache;
  try { _runcontractCache = require('./forge-runcontract.cjs'); } catch { _runcontractCache = null; }
  return _runcontractCache;
}
// V24 (2026-09-24 second Codex recheck, out-p7.md) — `ok` was missing from this outcome-field list, so a
// review_completed logged with ONLY `{ok:false}` (no review_verdict/verdict/status/result/outcome field at
// all) had `hasOutcomeField === false`, returned null here, and fell through to taskStatus()'s ordinary
// TERMINAL_TYPES default ('done') — a paired review_completed carrying ok:false, followed by agent_completed,
// read as a fully done run. `ok` is exactly as machine-readable an outcome signal as the other five fields.
//
// V24 REGRESSION (2026-09-24 THIRD Codex recheck, out-p8.md) — the fix above then delegated the actual
// verdict to `rc.isGoedkeuring()`, a DIFFERENT, deliberately stricter protocol (forge-runcontract.cjs's
// independent-review gate) that requires one of the 5 TEXTUAL verdict fields to be present at all; a bare
// `{ok:true}` has none, so `isGoedkeuring()` said `{ok:false, reden:'geen machineleesbaar review_verdict'}`
// and a previously-DONE boolean-only positive review became 'failed' here while app.js's own mirror still
// said 'done' for the identical event. Fixed by delegating to forge-proof-gate.cjs's own `reviewOutcome()` —
// the ONE canonical boolean-aware contract app.js now mirrors too (see forge-proof-gate.cjs's doc for the
// full contract table) — instead of borrowing a sibling protocol never designed for this shape.
function reviewOutcome(e) {
  const pg = loadProofGate();
  if (pg && typeof pg.reviewOutcome === 'function') return pg.reviewOutcome(e);
  // inline fallback — IDENTICAL behavior to forge-proof-gate.cjs::reviewOutcome, same resilience convention
  // isDisprovenEvent() above already uses for its own sibling-unavailable case.
  if (!e || typeof e !== 'object') return null;
  if (isDisprovenEvent(e)) return 'failed';
  const norm = (a) => String(a == null ? '' : a).trim().toLowerCase();
  const fields = ['review_verdict', 'verdict', 'status', 'result', 'outcome'];
  const positive = new Set(['pass', 'passed', 'approved', 'ok', 'akkoord', 'goedgekeurd']);
  const present = fields.filter((f) => e[f] !== undefined).map((f) => norm(e[f]));
  const hasOk = e.ok !== undefined;
  if (!present.length && !hasOk) return null;
  if (present.some((v) => v === '')) return 'failed';
  if (present.some((v) => !positive.has(v))) return 'failed';
  if (hasOk && e.ok !== true) return 'failed';
  return 'done';
}

// app.js taskStatus() — same branch semantics, reordered around disjoint sets (see header comment).
function taskStatus(e) {
  // V23 (2026-09-24 second Codex recheck, out-p7.md) — checked FIRST, before any verdict/status/event_type
  // classification: log-event.cjs's own content oracle already flagged this event's claim as unproven
  // (`_forge_verify.proof_verified:false`). A disproven claim is not evidence of anything, whatever verdict
  // string or `status` field it also carries — REPRODUCED: a disproven `check_passed` still closed its
  // paired task and returned verifier exit 0. Central here means every caller of taskStatus() (the
  // TASK_PAIRS merge, the closes_event_id RULE 2 closure, and the initial per-task status assignment)
  // automatically inherits the fix from this ONE place, never re-checked per call site.
  if (isDisprovenEvent(e)) return 'failed';
  if (REVIEW_DONE_EVENT_TYPES.has(e.event_type)) {
    const ro = reviewOutcome(e);
    if (ro) return ro;
  }
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
  'prd_generated', 'mindmap_generated', 'deep_learn_completed', 'doctor_run', 'registry_scanned',
  // WAVE D (D-INTEGRATE, 2026-07-18) — manifest_armed: a run-level swarm dispatch manifest was persisted,
  // structural milestone (mirrors registry_scanned/prd_generated), never a per-agent task.
  'manifest_armed',
  // V9 WAVE 2 (forge-bin/forge-audit-loop.cjs, 2026-07-22) — audit_iteration/audit_finding: the continuous
  // AUDIT-LOOP tool's own one-shot facts, same taxonomy as doctor_run/codex_finding above — a system-level
  // self-check, never a per-agent task. See log-event.cjs KNOWN_EVENT_TYPES header.
  'audit_iteration', 'audit_finding']);

// ---- reading events.jsonl (line-delimited JSON, BOM-tolerant, malformed lines skipped) ----
/** EVENT-RUN-BINDING-GAP (2026-09-24, out-p5.md) — verifyRun() performed NO run-id validation at all: a
 *  copied/foreign event carrying another run's `run_id` was processed as if it genuinely belonged here, so a
 *  foreign-run heartbeat completion or a foreign-run closes_event_id could close/complete THIS run's work.
 *  `expectedRunId` is derived from the run directory's own basename (the same `<root>/.claude/forge-runs/
 *  <run_id>/` layout every caller already uses) — an event whose OWN `run_id` field is present and does not
 *  match is a foreign entry and is excluded before any task/closure logic ever sees it. An event with NO
 *  run_id field at all (older/minimal fixtures; the writer stamps run_id on every real write) is left alone —
 *  narrowing to "present and present-and-wrong" avoids a mass regression on run_id-less fixtures while still
 *  closing the reproduced exploit (a foreign run_id that IS present).
 *
 *  V31 (2026-09-24 second Codex recheck, out-p7.md) — "present-and-wrong" above only ever tested
 *  `typeof parsed.run_id === 'string'`, so a MALFORMED run_id (`null`, a number, an object/array — anything
 *  present but not a genuine string) fell through the `typeof ... === 'string'` guard entirely and was
 *  treated exactly like a legacy run_id-LESS event: silently ALLOWED to close a current-run obligation.
 *  REPRODUCED: a positive completion carrying `run_id:null` still closed its paired review and returned
 *  verifier exit 0, while an equivalent foreign STRING run_id was already correctly rejected. The envelope
 *  check now distinguishes GENUINELY ABSENT (the key/value is `undefined` — legacy, still allowed through)
 *  from PRESENT-BUT-INVALID (present with any other value, including `null` — non-string, empty-string and
 *  mismatched-string are all folded into the SAME `foreignRunId` counter, which already gates the CLI via
 *  EXIT_GATES's `malformed_events` entry). */
function readEventsJsonl(runDir) {
  const file = path.join(runDir, 'events.jsonl');
  if (!fs.existsSync(file)) {
    throw new Error('no events.jsonl found at ' + file + ' — run does not exist or has not logged anything yet');
  }
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  const expectedRunId = path.basename(runDir);
  const events = [];
  let malformed = 0;
  let foreignRunId = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let parsed;
    try { parsed = JSON.parse(s); } catch { malformed++; continue; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.run_id !== undefined) {
      const rid = parsed.run_id;
      if (typeof rid !== 'string' || !rid.trim() || rid !== expectedRunId) { foreignRunId++; continue; }
    }
    events.push(parsed);
  }
  return { events, malformed, foreignRunId };
}

function taskTitle(e) {
  return e.task || e.title || e.note || e.output || e.decision_summary || e.issue || e.event_type || '(untitled)';
}

/**
 * closeHeartbeats(rec, completionEvent, evIdx) — RULE 1 (2026-09-24, wp23 "verify: heartbeats and
 * evidence-closed tasks"): a subagent_completed/subagent_failed event closes every still-open
 * agent_progress task of the SAME agent (rec) that was LOGGED BEFORE it and matches by wp_id — falling
 * back to role only when the completion carries no wp_id, and closing nothing when the completion has
 * neither. The closed heartbeat's status becomes taskStatus(completionEvent) (via the existing
 * statusClass() substring rule, so completed_with_blockers/blocked/failed stay visibly 'failed' — a
 * blocker is never hidden as done). A heartbeat that already resolved 'done' (an explicit terminal
 * status field) is left untouched — it was never open. Mutates rec.tasks in place; never touches other
 * agents' tasks (heartbeats are scoped to their own agent by construction).
 */
function closeHeartbeats(rec, completionEvent, evIdx) {
  const wpId = (typeof completionEvent.wp_id === 'string' && completionEvent.wp_id.trim()) || null;
  const role = (typeof completionEvent.role === 'string' && completionEvent.role.trim()) || null;
  if (!wpId && !role) return; // neither present on the completion — close nothing (spec: no fallback available)
  const status = taskStatus(completionEvent);
  for (const tk of rec.tasks) {
    if (tk._closed || tk.status === 'done' || tk.event_type !== 'agent_progress') continue;
    if (tk.origEvIdx >= evIdx) continue; // must be logged BEFORE the completion
    /** VERIFY-DEAD-WORKER-GREEN (2026-09-24, out-p5.md) — the role-only fallback (no wp_id on the
     *  completion) used to match ANY heartbeat sharing that role, INCLUDING a heartbeat that itself carries
     *  a wp_id of its own. A role-only completion carries no evidence about WHICH work package it refers
     *  to, so it must never close a heartbeat that is itself already scoped to a specific wp_id — only an
     *  explicit wp_id match may close those. Role-only fallback now closes role-only heartbeats ONLY.
     *  Reproduced: a completion without wp_id, sharing only role, closed heartbeats belonging to two
     *  DIFFERENT explicit work-package IDs — both must stay open instead. */
    const match = wpId ? tk.wp_id === wpId : (!tk.wp_id && !!tk.role && tk.role === role);
    if (match) { tk.status = status; tk._closed = true; tk.evIdx = evIdx; }
  }
}

/**
 * verifyRun(runDir, opts) -> { agents, mismatches, malformed, closesAdvisories }
 * Reconstructs per-agent task state from events.jsonl the SAME way the dashboard does: each event is
 * attributed to e.agent as-is (no SYNTH fallback — events without an agent are skipped); a non-BACKBONE
 * event is a "task" for that agent; a task is "done" when taskStatus(e) === 'done'. An agent "claims
 * completed" if it has an agent_completed or subagent_completed event anywhere in the run.
 *
 * RULE 1 / RULE 2 (2026-09-24, wp23 — real defect: a completed agent's own `agent_progress` heartbeats,
 * and a Lead-fixed `completed_with_blockers` subagent_output, could NEVER close, so finished work stayed
 * "67 open tasks" forever): see closeHeartbeats() above (RULE 1) and the closes_event_id handling below
 * (RULE 2 — a fix_completed/check_passed with a `closes_event_id` pointing at an EARLIER event's
 * event_id, plus a non-empty `evidence` string, closes that exact earlier task with the closer's status —
 * whatever agent/type it belongs to). Both rules mirror the SAME semantics in forge-dashboard/app.js
 * buildNodes() (read that file before changing either).
 */
function verifyRun(runDir, opts) {
  opts = opts || {};
  const { events, malformed, foreignRunId } = readEventsJsonl(runDir);
  const byAgent = new Map();
  const eventIdToTask = new Map(); // event_id -> task object, for RULE 2 cross-task/cross-agent closure
  const closesAdvisories = []; // RULE 2 — one plain-language line per ignored closes_event_id, never gates
  events.forEach((e, evIdx) => {
    if (!e || typeof e !== 'object') return;
    const agent = e.agent;
    if (agent == null || agent === '') return; // skip events without an agent — no SYNTH fallback here
    if (!byAgent.has(agent)) byAgent.set(agent, { agent, claimsDone: false, claimsFailed: false, tasks: [] });
    const rec = byAgent.get(agent);
    if (e.event_type === 'agent_completed' || e.event_type === 'subagent_completed') rec.claimsDone = true;
    /** VERIFY-DEAD-WORKER-GREEN (2026-09-24, out-p5.md) — a worker that logged a heartbeat and then simply
     *  stopped (process death) never claims done, so the OLD `mismatch: claimsDone && tasksDone < total`
     *  predicate never saw it: "a start followed by an unfinished heartbeat" verified clean at exit 0. A
     *  genuine failure claim (agent_failed/subagent_failed) is tracked separately so a worker that honestly
     *  reported its own failure is not ALSO flagged as silently dead — see `deadWorker` below. */
    if (e.event_type === 'agent_failed' || e.event_type === 'subagent_failed') rec.claimsFailed = true;
    const t = e.event_type;

    // RULE 1 — runs even for subagent_completed/subagent_failed, which are BACKBONE (never a task
    // themselves) and would otherwise `return` below before ever touching that agent's open heartbeats.
    if (t === 'subagent_completed' || t === 'subagent_failed') closeHeartbeats(rec, e, evIdx);

    if (BACKBONE.has(t)) return; // structural milestone — not a task
    // Fix 1 pairing parity: a terminal event closes its agent's earliest still-open matching start-task
    // (same rule as app.js buildNodes) instead of counting as a second task.
    // review_started/review_completed refinement (2026-09-24, loop wp-l1): when the terminal carries a
    // review_id, only an open start-task with the SAME review_id may close (a mismatched or absent id on the
    // candidate must NOT close — independent reviews stay independent). When the terminal carries no
    // review_id, fall back to the plain same-agent match used by every other pair — the earliest open
    // start-task that also has no review_id (a task that DOES carry one requires an explicit id match). Every
    // other TASK_PAIRS entry never sets review_id, so this is a no-op for them (unchanged behavior).
    const startType = TASK_PAIR_TERMINAL_TO_START[t];
    const openCandidates = startType ? rec.tasks.filter((tk) => !tk._closed && tk.event_type === startType) : [];
    const reviewId = (typeof e.review_id === 'string' && e.review_id.trim()) || null;
    const openTask = reviewId
      ? openCandidates.find((tk) => tk.review_id === reviewId) || null
      : openCandidates.find((tk) => !tk.review_id) || null;
    if (openTask) { openTask.status = taskStatus(e); openTask.evIdx = evIdx; openTask._closed = true; }
    else {
      // VERIFY-FAILED-REVIEW-DONE: an orphan review_completed/codex_review_completed (no matching open
      // review_started to close) proves nothing was ever paired to it — such a claim is not done, regardless
      // of what taskStatus(e) would otherwise say (even an explicit positive verdict on an unpaired
      // completion is unattributed and unverifiable as a real review).
      const orphanReview = REVIEW_DONE_EVENT_TYPES.has(t);
      const task = {
        title: taskTitle(e), evIdx, origEvIdx: evIdx, status: orphanReview ? 'failed' : taskStatus(e), event_type: t, _closed: false,
        agent, wp_id: (typeof e.wp_id === 'string' && e.wp_id.trim()) || null,
        role: (typeof e.role === 'string' && e.role.trim()) || null,
        event_id: (typeof e.event_id === 'string' && e.event_id) || null,
        review_id: reviewId,
      };
      rec.tasks.push(task);
      if (task.event_id) eventIdToTask.set(task.event_id, task);
    }

    // RULE 2 — independent of the TASK_PAIRS merge above: a fix_completed/check_passed is still recorded
    // as its own task/pair exactly as before; closes_event_id is an ADDITIONAL, separate closure of
    // whatever earlier task it names. See VERIFY-ARBITRARY-CLOSURE's doc above for the full grammar.
    //
    // V27 (2026-09-24 second Codex recheck, out-p7.md) — this event's OWN evidence/status was already being
    // stretched to close TWO independent obligations at once: its natural TASK_PAIRS partner (`openTask`,
    // just closed above) AND, separately, whatever unrelated task its `closes_event_id` names. REPRODUCED:
    // one `fix_completed` closed both its own `fix_started` pair AND an unrelated reviewer's `check_failed`
    // via closes_event_id — one piece of proof clearing two obligations. A completion now closes exactly ONE
    // obligation: when it already closed its own natural pair, closes_event_id is NOT ALSO honored (an
    // advisory names why) — the caller must log a SEPARATE completion, bound to its own evidence, to close a
    // genuinely different task.
    if (t === 'fix_completed' || t === 'check_passed') {
      const closesId = (typeof e.closes_event_id === 'string' && e.closes_event_id.trim()) || null;
      if (closesId && openTask) {
        closesAdvisories.push('closes_event_id ignored: ' + t + ' already closed its own paired task (' + openTask.event_type + ') — one completion closes one obligation, not two; log a separate completion for ' + closesId);
      } else if (closesId) {
        const target = eventIdToTask.get(closesId);
        if (!target) {
          closesAdvisories.push('closes_event_id ignored: unknown event_id ' + closesId);
        } else if (target.origEvIdx >= evIdx) {
          closesAdvisories.push('closes_event_id ignored: forward reference (' + closesId + ' is not earlier than the closer)');
        } else if (target._closed) {
          closesAdvisories.push('closes_event_id ignored: target ' + closesId + ' is already closed — single consumption only');
        } else if (target.status === 'done') {
          closesAdvisories.push('closes_event_id ignored: target ' + closesId + ' is already done — nothing open to close');
        } else if (!isMeaningfulClosureEvidence(e.evidence)) {
          closesAdvisories.push('closes_event_id ignored: no evidence (target ' + closesId + ')');
        } else {
          const selfClosure = target.agent === agent;
          if (selfClosure && !hasTallyOrExitEvidence(e.evidence)) {
            closesAdvisories.push('closes_event_id ignored: ' + agent + ' closing its own earlier task ' + closesId + ' needs a tally/exit-code line in the evidence, not just prose');
          } else {
            target.status = taskStatus(e);
            target._closed = true;
            target.evIdx = evIdx;
          }
        }
      }
    }
  });
  const agents = Array.from(byAgent.values()).map((rec) => {
    const tasksDone = rec.tasks.filter((tk) => tk.status === 'done').length;
    const tasksOpen = rec.tasks.filter((tk) => tk.status !== 'done')
      .map((tk) => ({ title: tk.title, evIdx: tk.evIdx, status: tk.status, event_type: tk.event_type }));
    // VERIFY-DEAD-WORKER-GREEN: an agent that never claimed done, never claimed failed, but left at least
    // one 'agent_progress' heartbeat open is a worker that simply stopped reporting — a real gate, not
    // dependent on claimsDone at all (that predicate exists for a DIFFERENT lie: "claims done but isn't").
    const deadWorker = !rec.claimsDone && !rec.claimsFailed && rec.tasks.some((tk) => tk.event_type === 'agent_progress' && tk.status !== 'done');
    return {
      agent: rec.agent,
      claimsDone: rec.claimsDone,
      claimsFailed: rec.claimsFailed,
      tasksTotal: rec.tasks.length,
      tasksDone,
      tasksOpen,
      mismatch: rec.claimsDone && tasksDone < rec.tasks.length,
      deadWorker,
    };
  });
  const mismatches = agents.filter((a) => a.mismatch).length;
  return { agents, mismatches, malformed, foreignRunId, closesAdvisories };
}

/**
 * verifyTickets(opts) -> { tickets, open, unproven }
 * opts.run_id: filter to tickets whose run_id matches (null/omitted -> check all tickets). A ticket is
 * OPEN when its status is not 'done' (case-insensitive). A DONE ticket is UNPROVEN (test-first rule,
 * owner decision 2026-07-10) when it carries a non-empty required_tests[] but no non-empty test_evidence
 * — a done-claim on a code ticket REQUIRES real test evidence. Every read is guarded — an unreadable
 * entity (corrupt/partial file) is skipped, never crashes the check.
 */
/** VERIFY-READ-ERROR-GREEN (2026-09-24, out-p5.md) — a directory-listing error on the ticket store silently
 *  became `ids=[]` ("no tickets exist"), and a per-entity read/parse failure was silently `continue`d — both
 *  made an existing OPEN ticket vanish from the count instead of blocking on "we cannot prove this is
 *  resolved". `storeError`/`unreadable` now carry the real failure so a caller can fail closed instead of
 *  reading corruption as "clean". Folded into the EXISTING `open_tickets` exit gate (see EXIT_GATES below) —
 *  an unreadable ticket is treated the same as an open one: unresolved status, until someone repairs it. */
function verifyTickets(opts) {
  opts = opts || {};
  const runId = opts.run_id || null;
  let ids = [];
  let storeError = null;
  try { ids = store.listStore('tickets'); }
  catch (e) { storeError = (e && e.message) ? e.message : String(e); ids = []; }
  const tickets = [];
  const unreadable = [];
  for (const id of ids) {
    let data;
    try { data = store.getEntity('tickets', id); }
    catch (e) { unreadable.push({ id, reason: (e && e.message) ? e.message : String(e) }); continue; }
    tickets.push(Object.assign({ id }, data));
  }
  const relevant = runId ? tickets.filter((tk) => tk.run_id === runId) : tickets;
  const open = relevant.filter((tk) => String(tk.status || '').toLowerCase() !== 'done');
  const unproven = relevant.filter((tk) => String(tk.status || '').toLowerCase() === 'done'
    && Array.isArray(tk.required_tests) && tk.required_tests.length > 0
    && !(typeof tk.test_evidence === 'string' && tk.test_evidence.trim()));
  return { tickets: relevant, open, unproven, unreadable, storeError };
}

// ---- required-evidence wire (WAVE C / C-INTEGRATE, 2026-07-18) ----------------------------------------
// Lazily require forge-evidence.cjs (the single source of truth for required-evidence matching against
// config/orchestration/required-evidence.json — see that file's header) so a standalone/stripped deployment
// missing it degrades to "evidence check unavailable" instead of crashing this tool. Same lazy-cache pattern
// as loadActiongate() below.
let _evidenceToolCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadEvidenceTool() {
  if (_evidenceToolCache !== undefined) return _evidenceToolCache;
  try { _evidenceToolCache = require('./forge-evidence.cjs'); } catch { _evidenceToolCache = null; }
  return _evidenceToolCache;
}

// 'artifact_id' added 2026-07-26 (fix-ronde wp5): forge-artifact.cjs::storeArtifact() is the real tool
// this project uses to register a genuine artifact on a run — its `--run` path logs an `artifact_stored`
// event shaped {agent, artifact_id, kind, title} (see forge-artifact.cjs header/CLI). Before this fix,
// NONE of that shape's fields were in this list, so a genuinely-stored artifact was invisible to
// evidenceCheck() below — confirmed literally on forge-2026-07-25-full-audit's own events.jsonl
// (artifact_stored rows for 'final-report-full-audit' / 'wp0-audit-reports' carry only artifact_id/kind/
// title, none of the other 5 field names). 'title' is deliberately NOT added here: it is free-form
// descriptive prose (report-writer supplied), not a controlled identifier, so adding it would risk
// spurious substring hits (e.g. a title that happens to mention "desktop" crediting a website
// screenshot item that was never produced) — 'artifact_id' is a deliberately-chosen identifier, exactly
// analogous in kind to the other 5 fields already trusted here.
const EVIDENCE_ARTIFACT_FIELDS = ['artifact', 'output_artifact', 'screenshot_path', 'output_path', 'path', 'artifact_id'];
const EVIDENCE_ARTIFACT_ARRAY_FIELDS = ['files_changed', 'files_read'];

/**
 * evidenceCheck(events, domain, opts) -> { ok, domain, missing, satisfied } | null
 * ADVISORY-ONLY (mirrors forge-doctor's backfillContinuity/completeness advisory pattern — see forge-doctor.cjs
 * header): given a run's REAL logged events and a domain slug (website/fullstack/n8n/scraping/rag/prediction/
 * integration — matching required-evidence.json's domain keys), derives the artifact paths/ids and event
 * types actually present in THIS run (never scans the filesystem, never invents proof — same honesty
 * discipline forge-evidence.cjs itself documents) and asks forge-evidence.cjs::check() whether the domain's
 * required-evidence set is satisfied.
 *
 * Returns null — not {ok:true} — when domain is falsy/unknown to required-evidence.json, or when
 * forge-evidence.cjs can't be loaded: an explicit "not applicable / unavailable" signal so a caller can never
 * confuse "nothing to check" with "all evidence present". NEVER throws on a malformed events array; a
 * genuinely broken config still throws from forge-evidence.cjs itself (a real config error, not something to
 * swallow silently) — the caller (CLI) below prints that as an advisory line, it does not affect the exit code.
 *
 * This function, and the CLI section that prints its result, NEVER change forge-verify's exit code — the
 * required-evidence gate is advisory/loud (matches this project's light-security governance, CLAUDE.md: "no
 * mandatory security gates"), same as the isolation/mismatch checks are hard-gated but this one deliberately
 * is not, per the work package.
 */
function evidenceCheck(events, domain, opts) {
  opts = opts || {};
  if (!domain || typeof domain !== 'string') return null;
  const tool = loadEvidenceTool();
  if (!tool) return null;
  let domains;
  try { domains = tool.listDomains(opts); } catch { return null; }
  if (!domains.includes(domain) && !domains.includes(domain.toLowerCase())) return null;

  const artifacts = [];
  const eventTypes = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue;
    // RC-CLAIMS-AS-PROOF (2026-09-24, out-p5.md): a disproven claim (log-event.cjs's own content oracle
    // already flagged proof_verified:false) must not feed the domain evidence check either — the same
    // discipline forge-runcontract.cjs::hasEvent() now applies to the generic event-present path.
    if (e._forge_verify && e._forge_verify.proof_verified === false) continue;
    if (typeof e.event_type === 'string' && e.event_type) eventTypes.push(e.event_type);
    for (const field of EVIDENCE_ARTIFACT_FIELDS) {
      const v = e[field];
      if (typeof v === 'string' && v.trim()) artifacts.push(v.trim());
    }
    for (const field of EVIDENCE_ARTIFACT_ARRAY_FIELDS) {
      const arr = e[field];
      if (!Array.isArray(arr)) continue;
      for (const v of arr) { if (typeof v === 'string' && v.trim()) artifacts.push(v.trim()); }
    }
  }
  try {
    return tool.check({ domain, artifacts, events: eventTypes }, opts);
  } catch (e) {
    return { ok: false, domain, missing: [], satisfied: [], error: e.message };
  }
}

// ---- isolation-tripwire (WAVE A / dd-orchestration-doctor B4) ----------------------------------------
// Lazily require forge-actiongate.cjs (the single source of truth for path-escape classification, shared
// with forge-doctor's advisory aggregation) so a standalone/stripped deployment missing that file still
// degrades to the local fallback below instead of crashing this tool.
let _actiongateCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadActiongate() {
  if (_actiongateCache !== undefined) return _actiongateCache;
  try { _actiongateCache = require('./forge-actiongate.cjs'); } catch { _actiongateCache = null; }
  return _actiongateCache;
}

// Fallback path-escape check (plain path.resolve, no symlink-safety) — mirrors forge-actiongate's
// isPathEscape() contract for the common case; only used when that module can't be loaded.
function localPathEscape(projectRoot, targetPath) {
  if (!projectRoot || !targetPath) return false;
  const root = path.resolve(String(projectRoot));
  const target = path.isAbsolute(String(targetPath)) ? path.resolve(String(targetPath)) : path.resolve(root, String(targetPath));
  return !(target === root || target.startsWith(root + path.sep));
}

function isPathOutsideRoot(projectRoot, targetPath) {
  const gate = loadActiongate();
  if (gate && typeof gate.isPathEscape === 'function') return gate.isPathEscape(projectRoot, targetPath);
  return localPathEscape(projectRoot, targetPath);
}

// Event types that carry logged filesystem paths worth checking (design B4). command_run/custom_skill_*
// events sometimes carry a target/output path field even though their primary payload is a free-form
// command string — checked the same way, via the named path fields only (never the free-text `command`
// field itself, to avoid false positives on shell arguments that merely mention a path-like word).
const TRIPWIRE_EVENT_TYPES = new Set(['file_changed', 'file_read', 'command_run', 'custom_skill_created', 'custom_skill_updated']);
const TRIPWIRE_PATH_FIELDS = ['path', 'file', 'output_path', 'output_artifact', 'screenshot_path', 'artifact'];
const TRIPWIRE_PATH_ARRAY_FIELDS = ['files_changed', 'files_read'];

function extractPaths(e) {
  const out = [];
  for (const field of TRIPWIRE_PATH_FIELDS) {
    const v = e[field];
    if (typeof v === 'string' && v.trim()) out.push({ field, value: v.trim() });
  }
  for (const field of TRIPWIRE_PATH_ARRAY_FIELDS) {
    const arr = e[field];
    if (!Array.isArray(arr)) continue;
    for (const v of arr) if (typeof v === 'string' && v.trim()) out.push({ field, value: v.trim() });
  }
  return out;
}

/**
 * isolationTripwire(runDir, projectRoot) -> { ok, checked, violations }
 * Scans a run's events.jsonl for file_changed/file_read/command_run/custom_skill_(created|updated)
 * events and flags any logged path that resolves OUTSIDE projectRoot — enforces the CLAUDE.md "only this
 * folder" rule with real logged evidence instead of trust. `checked` is the total number of path-bearing
 * fields inspected (labeled, so a run that logged zero paths yields ok:true with checked:0 — never a
 * false "clean" with no evidence behind it). `violations` is [{evIdx, event_type, field, path, reason}].
 * Never mutates events; read-only, same contract as verifyRun/verifyTickets.
 */
function isolationTripwire(runDir, projectRoot) {
  const { events } = readEventsJsonl(runDir);
  const violations = [];
  let checked = 0;
  events.forEach((e, evIdx) => {
    if (!e || typeof e !== 'object') return;
    if (!TRIPWIRE_EVENT_TYPES.has(e.event_type)) return;
    for (const { field, value } of extractPaths(e)) {
      checked++;
      if (isPathOutsideRoot(projectRoot, value)) {
        violations.push({ evIdx, event_type: e.event_type, field, path: value, reason: 'resolves outside project root ' + projectRoot });
      }
    }
  });
  return { ok: violations.length === 0, checked, violations };
}

// ---- loop-until-dry convergence check (WAVE A / dd-orchestration-doctor A1) ---------------------------
const ROUND_BOUNDARY_TYPES = new Set(['lead_review_started', 'retest_started']);
const FINDING_EVENT_TYPES = new Set(['rework_task_created', 'check_failed', 'codex_finding']);
// Loop defaults (2026-08-01, "pakket 2" — see loopBrake() below and the CLI's Loop: section). 5 rounds is
// the hard ceiling the comparative research settled on (BMAD halts a review loop at >5, Aider caps
// reflections at 3); dryStreak 1 means one full round that surfaced nothing NEW is enough to call it dry.
// Both are overridable per invocation via --max-rounds / --dry-streak.
const LOOP_MAX_ROUNDS = 5;
const LOOP_DRY_STREAK = 1;

// Dedup key for a finding: same event_type + same normalized issue/note/output/reason/task text ==
// the "same" finding recurring across rounds, not a fresh one.
function findingSignature(e) {
  const text = e.issue || e.note || e.output || e.reason || e.task || '';
  return String(e.event_type) + '::' + String(text).trim().toLowerCase();
}

/**
 * roundsFromEvents(events) -> string[][]
 * Groups FINDING_EVENT_TYPES (rework_task_created / check_failed / codex_finding) events into rounds,
 * splitting at each ROUND_BOUNDARY_TYPES marker (lead_review_started / retest_started). Findings surfaced
 * before the first boundary belong to round 0 (e.g. an initial check run ahead of any explicit review
 * cycle). Returns one array of finding-signature strings per round, in event order.
 */
function roundsFromEvents(events) {
  const rounds = [[]];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (ROUND_BOUNDARY_TYPES.has(e.event_type)) { rounds.push([]); continue; }
    if (FINDING_EVENT_TYPES.has(e.event_type)) rounds[rounds.length - 1].push(findingSignature(e));
  }
  return rounds;
}

/**
 * loopConvergence(rounds, opts) -> { converged, rounds, newFindingsByRound, dryStreak, hitCap }
 * rounds: string[][] — one array of finding-signatures per round (e.g. from roundsFromEvents()).
 * opts.dryStreak (N, default 1): converged=true only once the LAST N rounds each contributed ZERO
 * findings that were not already seen in an EARLIER round (true novelty, not merely "this round happens
 * to be empty" — a single clean round right after a round with a genuinely new finding does not count
 * until N clean rounds in a row accumulate).
 * opts.max (hard cap, default Infinity): hitCap=true once round count reaches max, regardless of
 * convergence — the caller (a future loop driver) decides whether the hard cap still forces a stop; this
 * function only reports the fact.
 * Pure — never mutates rounds. An empty rounds[] (nothing checked yet) is never reported converged.
 */
function loopConvergence(rounds, opts) {
  opts = opts || {};
  const need = Math.max(1, opts.dryStreak || 1);
  const max = opts.max || Infinity;
  const seen = new Set();
  const newFindingsByRound = rounds.map((round) => {
    let novel = 0;
    for (const sig of round) { if (!seen.has(sig)) { seen.add(sig); novel++; } }
    return novel;
  });
  let dryStreak = 0;
  for (let i = newFindingsByRound.length - 1; i >= 0; i--) {
    if (newFindingsByRound[i] === 0) dryStreak++; else break;
  }
  return {
    converged: rounds.length > 0 && dryStreak >= need,
    rounds: rounds.length,
    newFindingsByRound,
    dryStreak,
    hitCap: rounds.length >= max,
  };
}

/**
 * loopBrake(loop) -> { braked, reason }
 * The DECISION half of the loop-until-dry check (2026-08-01, "pakket 2"): loopConvergence() has always
 * reported `converged`/`hitCap`, but nothing acted on it, so the rework loop had no upper bound at all.
 * This pure predicate turns that report into the one thing --enforce needs to know: may another rework
 * round be opened, yes or no?
 *
 * THE ONE SUBTLETY THAT MAKES THIS CORRECT: with the default dryStreak of 1, a run in which NOTHING has
 * ever been found is trivially "converged" (its single empty round contributed zero new findings). Braking
 * on that would mean the very FIRST rework round could never be created — the brake would block the loop
 * from ever starting instead of from spinning. So the brake additionally requires that the loop genuinely
 * ran: at least one round must have contributed a real, novel finding. Before that, there is no loop to
 * brake. (Pinned from both sides in forge-caller-wiring.test.cjs — B4/B6 prove it fires, B7/B8 prove it
 * does not fire early and that the cap is the CONFIGURED number.)
 *
 * A braked loop is never "resolved": it is escalated. The caller logs ONE already-registered
 * `quality_gate_blocked` event (no new event_type is invented here) naming the real round numbers, so an
 * owner decides — which is exactly what "repeat until a genuine pass or a truthful blocker" means once the
 * loop has stopped producing new information.
 */
function loopBrake(loop) {
  if (!loop || !Array.isArray(loop.newFindingsByRound)) return { braked: false, reason: 'no loop data' };
  const started = loop.newFindingsByRound.some((n) => n > 0);
  if (!started) return { braked: false, reason: 'the rework loop has not produced a single finding yet — there is no loop to brake' };
  if (loop.hitCap) {
    return { braked: true, reason: 'hard cap reached: ' + loop.rounds + ' rework round(s) and still finding new issues — owner decision needed' };
  }
  if (loop.converged) {
    return { braked: true, reason: 'converged: the last ' + loop.dryStreak + ' round(s) of ' + loop.rounds + ' produced no NEW finding — another round would only repeat itself' };
  }
  return { braked: false, reason: loop.rounds + ' round(s) so far, still finding genuinely new issues — the loop may continue' };
}

/**
 * BRAKE_NOTE_PREFIX / brakeAlreadyLogged(events, reason) -> boolean
 * The brake's idempotency key (2026-08-01, independent-witness defect 1). Every brake event --enforce writes
 * carries `note` === BRAKE_NOTE_PREFIX + the verbatim brake reason, so a repeated --enforce on an unchanged
 * run recognizes its OWN earlier blocker and appends no duplicate — the same discipline the rest of enforce()
 * already follows (see appendNote: "idempotent across repeated enforces"). Measured before this existed: 3
 * --enforce passes on one run left 3 quality_gate_blocked events, each of which forge-run-state, forge-
 * snapshot, forge-distill, forge-stats and forge-briefing read as a separate real blocker.
 * Matching is deliberately EXACT (prefix + identical reason) and only against quality_gate_blocked: a brake
 * for a genuinely DIFFERENT reason (e.g. the loop later hits the cap after having merely converged) is new
 * information and is still recorded, and a quality_gate_blocked logged by some other tool is never mistaken
 * for this tool's own brake.
 */
const BRAKE_NOTE_PREFIX = 'verify-loop brake: ';
function brakeAlreadyLogged(events, reason) {
  for (const e of events || []) {
    if (!e || typeof e !== 'object' || e.event_type !== 'quality_gate_blocked') continue;
    if (e.note === BRAKE_NOTE_PREFIX + reason) return true;
  }
  return false;
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

// ---- acceptance-criteria coverage (spec-drift detection, backlog item 7, 2026-07-31) ------------------
// LINKING A PRD TO A RUN: forge-prd.cjs's CLI (`write '<json>' --run <id>`) logs a `prd_generated` event on
// that run carrying `prd_id` (confirmed on the real forge-2026-07-10-mc-checkup run's events.jsonl) — NOT
// index.jsonl, which never carries a run_id anywhere in this codebase (forge-prd.cjs::writePrd only ever
// appends {id, ts, store, title}). That prd_generated event is therefore the real, existing run<->PRD link
// this function reads. A run with no such event has no PRD linked (requirement below) — true for most runs
// that predate forge-prd, not a failure.
function findLinkedPrdIds(events) {
  const ids = [];
  const seen = new Set();
  for (const e of events) {
    if (!e || typeof e !== 'object' || e.event_type !== 'prd_generated') continue;
    if (typeof e.prd_id !== 'string' || !e.prd_id || seen.has(e.prd_id)) continue;
    seen.add(e.prd_id);
    ids.push(e.prd_id);
  }
  return ids;
}

// Reads .claude/forge-prd/<id>.meta.json directly — NOT store.getEntity('prd', id): forge-prd.cjs writes
// <id>.md + <id>.meta.json, never a bare <id>.json, so getEntity() would always 404 on a real PRD. Guarded
// end-to-end: an invalid id, a missing store dir, a missing file, or malformed JSON all -> null (never
// throws) — same "unreadable entity is skipped, never crashes the check" discipline as verifyTickets().
function loadPrdMeta(prdId) {
  if (!store.isValidId(prdId)) return null;
  let dir;
  try { dir = store.resolveStoreDir('prd'); } catch { return null; }
  const file = path.join(dir, prdId + '.meta.json');
  const base = path.resolve(dir), resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null; // belt-and-braces, mirrors forge-store's own containment check
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(raw); } catch { return null; }
}

// Normalizes prd.sections.acceptance_criteria (string[] OR {id?,text,owner?,required_tests?}[] — see
// forge-prd.cjs::renderCriterion) into a flat [{id, text}] list. Uses the SAME 'ac-' + (idx+1) fallback id
// forge-prd.cjs's own renderer/criteriaToTickets already use, so ids line up with the tickets they minted.
function acceptanceCriteria(meta) {
  const raw = meta && meta.sections && meta.sections.acceptance_criteria;
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return arr.map((c, idx) => {
    const fallbackId = 'ac-' + (idx + 1);
    if (typeof c === 'string') return { id: fallbackId, text: c.trim() || '(empty criterion)' };
    if (c && typeof c === 'object') {
      return {
        id: (typeof c.id === 'string' && c.id.trim()) || fallbackId,
        text: (typeof c.text === 'string' && c.text.trim()) || '(no text)',
      };
    }
    return { id: fallbackId, text: '(invalid criterion)' };
  });
}

// VERIFY-SELF-WAIVER (2026-09-24, out-p5.md) — resolves the SAME owner allow-list forge-runcontract.cjs's
// findOwnerOverride() already enforces (FORGE_HARD_RULES.json's own `owners_allowlist` + FORGE_OWNER_
// PROFILE.json), reused rather than re-implemented. opts.ownerAllowlist (a Set) is a direct test seam;
// otherwise opts.rulesPath/opts.ownerProfilePath thread through to the sibling's own loader. A sibling that
// cannot be loaded, or a config that configures no id, resolves to an EMPTY Set — fail-closed, matching
// forge-runcontract.cjs's own "no override possible" discipline, never "anyone is the owner".
function resolveOwnerAllowlist(opts) {
  opts = opts || {};
  if (opts.ownerAllowlist instanceof Set) return opts.ownerAllowlist;
  const rc = loadRuncontractTool();
  if (!rc || typeof rc.loadOwnerAllowlist !== 'function') return new Set();
  let rulesData = null;
  try { rulesData = rc.loadRules(opts.rulesPath); } catch { rulesData = null; }
  try { return rc.loadOwnerAllowlist(rulesData, opts); } catch { return new Set(); }
}

// findAcOwnerDecision(events, prdId, acId, ownerAllowlist) -> {decision, by} | null — an explicit,
// structured, OWNER-attributed decision for THIS exact criterion. Reuses the ALREADY-REGISTERED
// `decision_logged` event_type (see log-event.cjs KNOWN_EVENT_TYPES) rather than inventing a new one or
// overloading forge-runcontract.cjs's `owner_override` (a differently-scoped mechanism keyed to
// config/orchestration/FORGE_HARD_RULES.json rule ids, not acceptance criteria). Requires a NON-blank
// decision text on the SAME event, and `by` — NEVER a fallback to `agent` — matching a configured owner id
// (VERIFY-SELF-WAIVER: `by` used to accept `agent` as a fallback, so the very agent whose own work this
// decision waives could author its own exception — a builder-authored waiver is now ignored outright).
function findAcOwnerDecision(events, prdId, acId, ownerAllowlist) {
  for (const e of events) {
    if (!e || typeof e !== 'object' || e.event_type !== 'decision_logged') continue;
    if (e.prd_id !== prdId || e.ac_id !== acId) continue;
    const decision = (typeof e.decision === 'string' && e.decision.trim()) || (typeof e.note === 'string' && e.note.trim()) || '';
    const by = (typeof e.by === 'string' && e.by.trim()) || '';
    if (!decision || !by) continue;
    if (!(ownerAllowlist instanceof Set) || !ownerAllowlist.has(by.toLowerCase())) continue;
    return { decision, by };
  }
  return null;
}

// ticketReferencedDone(events, ticketId) -> true iff at least one event in THIS run's events.jsonl
// references ticketId (via e.ticket_id) AND resolves to 'done' via the EXISTING taskStatus() taxonomy
// above — i.e. the ticket's done-ness has SOME trace in this run's own log, not just a store field that
// could have been hand-edited or carried over from an unrelated run (the same distrust-a-bare-field
// discipline the test-first rule already applies to tickets elsewhere in this file).
function ticketReferencedDone(events, ticketId) {
  for (const e of events) {
    if (!e || typeof e !== 'object' || e.ticket_id !== ticketId) continue;
    if (taskStatus(e) === 'done') return true;
  }
  return false;
}

/**
 * checkAcceptanceCoverage(run_id, opts) -> { run_id, prds_checked, acceptance_gaps, note }
 * opts.runDir overrides the derived run directory (test hermeticity, same convention as verifyRun's runDir
 * argument); default: <store.CLAUDE_DIR>/forge-runs/<run_id> (store.CLAUDE_DIR already honors
 * FORGE_STORE_ROOT). Throws the SAME clean error as readEventsJsonl() when the run has no events.jsonl yet
 * (consistent with verifyRun — a run that doesn't exist has nothing to check, never a false "0 gaps" pass).
 *
 * For every PRD linked to this run (see findLinkedPrdIds above), every one of its acceptance criteria is a
 * GAP — always severity:"blocker", never a warning, mirroring get-shit-done-cc's "a dropped requirement is
 * ALWAYS blocker" rule this design mines from — UNLESS EITHER:
 *   (1) an explicit owner decision was logged for this exact criterion (findAcOwnerDecision), or
 *   (2) BOTH (a) the criterion's ticket (`tk-<prd_id>-<n>`, the exact id forge-prd.cjs::criteriaToTickets
 *       mints, n = 1-based criterion position) still exists in the ticket store, AND (b) that ticket's own
 *       `status` is 'done' (same predicate verifyTickets() already uses) AND at least one event in THIS
 *       run's events.jsonl actually references that ticket_id with a real done-status (ticketReferencedDone).
 * A run with NO PRD linked is not a failure — most historic runs predate forge-prd (requirement #3).
 *
 * NEVER marks anything done, NEVER edits a ticket or a PRD — pure detection, same contract as verifyRun/
 * verifyTickets above.
 */
function checkAcceptanceCoverage(run_id, opts) {
  opts = opts || {};
  const runDir = opts.runDir || path.join(store.CLAUDE_DIR, 'forge-runs', run_id);
  const { events } = readEventsJsonl(runDir);
  const prdIds = findLinkedPrdIds(events);
  if (prdIds.length === 0) {
    return { run_id, prds_checked: [], acceptance_gaps: [], note: 'no PRD linked to this run' };
  }
  const ownerAllowlist = resolveOwnerAllowlist(opts);

  const gaps = [];
  for (const prdId of prdIds) {
    const meta = loadPrdMeta(prdId);
    if (!meta) {
      gaps.push({
        prd_id: prdId, ac_id: null, ticket_id: null, severity: 'blocker',
        description: 'PRD ' + prdId + ' is linked to this run (prd_generated event) but .claude/forge-prd/' + prdId + '.meta.json could not be read',
        fix_hint: 'restore/regenerate ' + prdId + '.meta.json, or correct the prd_id logged on the prd_generated event',
      });
      continue;
    }
    acceptanceCriteria(meta).forEach((ac, idx) => {
      const ticketId = 'tk-' + prdId + '-' + (idx + 1);
      if (findAcOwnerDecision(events, prdId, ac.id, ownerAllowlist)) return; // explicit OWNER decision clears this criterion

      let ticket = null;
      try { ticket = store.getEntity('tickets', ticketId); } catch { ticket = null; }
      if (!ticket) {
        gaps.push({
          prd_id: prdId, ac_id: ac.id, ticket_id: ticketId, severity: 'blocker',
          description: 'acceptance criterion ' + ac.id + ' ("' + ac.text + '") has no ticket ' + ticketId + ' in the store — dropped or deleted',
          fix_hint: 'recreate ticket ' + ticketId + ' for PRD ' + prdId + ' criterion ' + ac.id + ' (forge-prd.cjs::criteriaToTickets), or log an explicit decision_logged decision for it',
        });
        return;
      }

      const statusDone = String(ticket.status || '').toLowerCase() === 'done';
      const provenInRun = ticketReferencedDone(events, ticketId);
      if (!statusDone || !provenInRun) {
        gaps.push({
          prd_id: prdId, ac_id: ac.id, ticket_id: ticketId, severity: 'blocker',
          description: 'acceptance criterion ' + ac.id + ' ("' + ac.text + '") ticket ' + ticketId + ' is ' +
            (!statusDone
              ? 'not marked done (status=' + (ticket.status || 'unknown') + ')'
              : "marked done in the store but this run's events.jsonl never records a real completion event for it"),
          fix_hint: !statusDone
            ? 'finish and close ticket ' + ticketId + ' with real test evidence before this run is claimed complete'
            : 'log a real completion event referencing ticket_id ' + ticketId + ' in this run, or an explicit decision_logged decision',
        });
      }
    });
  }

  return { run_id, prds_checked: prdIds, acceptance_gaps: gaps, note: null };
}

// ---- the FAILURE side of the task contract (2026-08-01) ------------------------------------------------
// checkAcceptanceCoverage above answers "was anything the spec REQUIRED silently dropped". The three checks
// below answer the three questions it structurally cannot:
//   checkFailureConditions — did the run hit something the spec declared UNACCEPTABLE (a gate, like a gap)
//   checkNonGoals          — did the run deliver something the spec said not to build (advisory, see below)
//   checkRequiredInputs    — may this work package be dispatched at all, or is its input simply not there
// Measured on 2026-08-01: `failure_conditions`, `on_stuck`, `requires_inputs` and `result_caveat` had zero
// hits in this project and `non_goals` existed in forge-prd.cjs with no verify side whatsoever.

/** failureConditions(meta) -> [{id, text}] — same normalisation as acceptanceCriteria(), with the `fc-<n>`
 *  fallback id forge-prd.cjs's renderer uses. Two functions rather than one parameterised helper would drift;
 *  this one delegates so the two spec halves can never disagree about how an entry is read. */
function normalizeItems(raw, prefix) {
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return arr.map((c, idx) => {
    const fallbackId = prefix + (idx + 1);
    if (typeof c === 'string') return { id: fallbackId, text: c.trim() || '(empty)' };
    if (c && typeof c === 'object') {
      return {
        id: (typeof c.id === 'string' && c.id.trim()) || fallbackId,
        text: (typeof c.text === 'string' && c.text.trim()) || '(no text)',
        match: Array.isArray(c.match) ? c.match.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()) : null,
      };
    }
    return { id: fallbackId, text: '(invalid entry)' };
  });
}
function failureConditions(meta) {
  return normalizeItems(meta && meta.sections && meta.sections.failure_conditions, 'fc-');
}
function nonGoals(meta) {
  return normalizeItems(meta && meta.sections && meta.sections.non_goals, 'ng-');
}

/** findItemDecision(events, prdId, key, id) — the generalisation of findAcOwnerDecision() to any spec item
 *  key (`ac_id`, `fc_id`, `ng_id`). SAME rigor: an explicit, attributed, non-blank decision_logged on the SAME
 *  event, using the already-registered event type — a bare token that merely names the right ids is not a
 *  decision and must not clear anything. */
// VERIFY-SELF-WAIVER: same fail-closed discipline as findAcOwnerDecision() above — `by` is REQUIRED as its
// own field (never a fallback to `agent`) and must resolve against the configured owner allow-list.
function findItemDecision(events, prdId, key, id, ownerAllowlist) {
  for (const e of events) {
    if (!e || typeof e !== 'object' || e.event_type !== 'decision_logged') continue;
    if (e.prd_id !== prdId || e[key] !== id) continue;
    const decision = (typeof e.decision === 'string' && e.decision.trim()) || (typeof e.note === 'string' && e.note.trim()) || '';
    const by = (typeof e.by === 'string' && e.by.trim()) || '';
    if (!decision || !by) continue;
    if (!(ownerAllowlist instanceof Set) || !ownerAllowlist.has(by.toLowerCase())) continue;
    return { decision, by };
  }
  return null;
}

/**
 * checkFailureConditions(run_id, opts) -> {run_id, prds_checked, failure_hits, cleared, waived, unchecked, note}
 *
 * A failure condition is HIT when an event in THIS run's events.jsonl carries the same prd_id + fc_id and
 * resolves to 'failed' through the EXISTING taskStatus() taxonomy (check_failed, quality_gate_blocked, an
 * explicit status field saying fail/block/refuse …). Reusing taskStatus rather than hardcoding a list of
 * event types means this check and the dashboard can never disagree about what "failed" means — the same
 * reason the file header insists app.js and this file share their semantics.
 *
 * A hit is a BLOCKER and it gates, exactly like a dropped acceptance criterion: "this outcome is
 * unacceptable" is not a softer statement than "this outcome is required", it is the same statement from the
 * other side. It is cleared only by a real check_passed-class event against that same fc_id, or waived by an
 * explicit, attributed owner decision (which stays visible in `waived` — a waiver is a decision, not an
 * erasure).
 *
 * A condition NOBODY CHECKED is NOT a hit and NOT a blocker: it lands in `unchecked` with a plain reason.
 * That is deliberate and it is what keeps this field optional — a run predating the field, or one whose
 * author wrote conditions and never wired checks, must not turn red for a field it never used. The honest
 * report is "nobody looked", not "it passed" and not "it failed".
 */
function checkFailureConditions(run_id, opts) {
  opts = opts || {};
  const runDir = opts.runDir || path.join(store.CLAUDE_DIR, 'forge-runs', run_id);
  const { events } = readEventsJsonl(runDir);
  const prdIds = findLinkedPrdIds(events);
  if (prdIds.length === 0) {
    return { run_id, prds_checked: [], failure_hits: [], cleared: [], waived: [], unchecked: [], note: 'no PRD linked to this run' };
  }
  const ownerAllowlist = resolveOwnerAllowlist(opts);
  const hits = [], cleared = [], waived = [], unchecked = [];
  for (const prdId of prdIds) {
    const meta = loadPrdMeta(prdId);
    if (!meta) continue; // checkAcceptanceCoverage already reports an unreadable linked PRD as a blocker
    for (const fc of failureConditions(meta)) {
      let hitEvent = null, clearEvent = null;
      for (const e of events) {
        if (!e || typeof e !== 'object' || e.prd_id !== prdId || e.fc_id !== fc.id) continue;
        const st = taskStatus(e);
        if (st === 'failed' && !hitEvent) hitEvent = e;
        else if (st === 'done' && !clearEvent) clearEvent = e;
      }
      const decision = findItemDecision(events, prdId, 'fc_id', fc.id, ownerAllowlist);
      if (hitEvent && decision) {
        waived.push({ prd_id: prdId, fc_id: fc.id, text: fc.text, decision: decision.decision, by: decision.by });
        continue;
      }
      if (hitEvent) {
        const note = (typeof hitEvent.note === 'string' && hitEvent.note.trim()) || (typeof hitEvent.output === 'string' && hitEvent.output.trim()) || '';
        hits.push({
          prd_id: prdId, fc_id: fc.id, text: fc.text, severity: 'blocker',
          evidence_event: hitEvent.event_type,
          description: 'failure condition ' + fc.id + ' ("' + fc.text + '") was HIT — ' + hitEvent.event_type
            + (hitEvent.agent ? ' from ' + hitEvent.agent : '') + (note ? ': ' + note : '')
            + ' — the run produced an outcome the spec declared unacceptable',
          fix_hint: 'fix the condition that was hit, or log an explicit attributed decision_logged decision for '
            + 'prd ' + prdId + ' / fc ' + fc.id + ' accepting it',
        });
        continue;
      }
      if (clearEvent) {
        cleared.push({ prd_id: prdId, fc_id: fc.id, text: fc.text, evidence_event: clearEvent.event_type });
        continue;
      }
      unchecked.push({
        prd_id: prdId, fc_id: fc.id, text: fc.text,
        reason: 'no event in this run references prd ' + prdId + ' / fc_id ' + fc.id + ' — this condition was '
          + 'never checked. Reported as unchecked rather than as passed (nobody looked) and rather than as '
          + 'failed (nothing says it happened); it does not gate.',
      });
    }
  }
  return { run_id, prds_checked: prdIds, failure_hits: hits, cleared, waived, unchecked, note: null };
}

/** buildFailureEnforceEvents(hit) -> the SAME registered rework trio buildEnforceEvents/
 *  buildAcceptanceEnforceEvents use — no new event_type is introduced — threading prd_id/fc_id so the rework
 *  task names the specific unacceptable outcome instead of a generic failure. */
function buildFailureEnforceEvents(hit) {
  const target = hit.fc_id || hit.prd_id || '(unknown)';
  return [
    {
      event_type: 'lead_review_completed',
      extra: {
        agent: 'orchestrator',
        note: 'failure condition hit: prd ' + hit.prd_id + ' / fc ' + hit.fc_id,
        evidence: hit.description,
      },
    },
    {
      event_type: 'rework_task_created',
      extra: {
        agent: 'orchestrator', target, prd_id: hit.prd_id, fc_id: hit.fc_id,
        issue: hit.description, required_fix: hit.fix_hint,
      },
    },
    { event_type: 'rework_assigned', extra: { agent: 'orchestrator', to: target, fc_id: hit.fc_id } },
  ];
}

// --- non-goals: the mirror of coverage — did the run deliver what the spec said NOT to build ---------------
// WHY THIS IS ADVISORY AND THE FAILURE-CONDITION CHECK IS NOT. A failure-condition hit is PROOF: an agent
// explicitly logged a failed check against that exact fc_id. A non-goal violation is a KEYWORD MATCH against a
// delivered path — real evidence of suspicion, not proof, because "auth" legitimately appears in "author.ts".
// Gating on a heuristic would produce false reds, and the first false red is when a gate gets switched off. So
// this reports loudly at severity 'warning' and never touches the exit code — the same split this project
// already applies between its enforced checks and its advisory ones.
const NON_GOAL_STOPWORDS = new Set([
  'the', 'and', 'not', 'for', 'this', 'that', 'with', 'without', 'into', 'from', 'have', 'must', 'never',
  'build', 'building', 'built', 'make', 'making', 'support', 'supporting', 'include', 'including', 'add',
  'adding', 'implement', 'implementing', 'create', 'creating', 'module', 'modules', 'feature', 'features',
  'now', 'yet', 'any', 'all', 'out', 'scope', 'goal', 'goals', 'phase', 'sprint', 'version',
]);
/** derivedTerms(text) -> the words in a prose non-goal that are specific enough to match a path on. Words
 *  shorter than 4 characters and common spec vocabulary are dropped: "not for now" must match NOTHING, and a
 *  non-goal that yields no usable term is reported as UNCHECKED rather than quietly matching everything or
 *  quietly matching nothing. */
function derivedTerms(text) {
  const words = String(text || '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [];
  const out = [];
  for (const w of words) if (!NON_GOAL_STOPWORDS.has(w) && !out.includes(w)) out.push(w);
  return out;
}
/** deliveredPaths(events) -> [{path, event_type, agent}] — what the run actually produced, taken from the
 *  same file_changed evidence forge-verify's isolation tripwire already trusts. */
const DELIVERY_PATH_FIELDS = ['path', 'file', 'output_path', 'output_artifact', 'artifact'];
function deliveredPaths(events) {
  const out = [];
  const seen = new Set();
  const push = (v, e) => {
    if (typeof v !== 'string' || !v.trim()) return;
    const key = e.event_type + '|' + v.trim();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: v.trim(), event_type: e.event_type, agent: (typeof e.agent === 'string' && e.agent) || null });
  };
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.event_type !== 'file_changed' && e.event_type !== 'artifact_stored' && e.event_type !== 'final_output_created') continue;
    for (const f of DELIVERY_PATH_FIELDS) push(e[f], e);
    if (Array.isArray(e.files_changed)) e.files_changed.forEach((p) => push(p, e));
  }
  return out;
}

/**
 * checkNonGoals(run_id, opts) -> {run_id, prds_checked, scope_violations, unchecked, delivered_paths, note}
 * ADVISORY — severity is always 'warning' and the CLI never folds it into the exit code (see the block
 * comment above for why a keyword match must not gate).
 *
 * An author-declared `match: [...]` on a non-goal is used verbatim (`derived:false`). A prose non-goal falls
 * back to derivedTerms() (`derived:true`) so PRDs written before this check still get one — labelled, so a
 * reader can tell a declared trip from a guessed one at a glance.
 */
function checkNonGoals(run_id, opts) {
  opts = opts || {};
  const runDir = opts.runDir || path.join(store.CLAUDE_DIR, 'forge-runs', run_id);
  const { events } = readEventsJsonl(runDir);
  const prdIds = findLinkedPrdIds(events);
  const delivered = deliveredPaths(events);
  if (prdIds.length === 0) {
    return { run_id, prds_checked: [], scope_violations: [], unchecked: [], delivered_paths: delivered.length, note: 'no PRD linked to this run' };
  }
  const ownerAllowlist = resolveOwnerAllowlist(opts);
  const violations = [], unchecked = [];
  for (const prdId of prdIds) {
    const meta = loadPrdMeta(prdId);
    if (!meta) continue;
    for (const ng of nonGoals(meta)) {
      if (findItemDecision(events, prdId, 'ng_id', ng.id, ownerAllowlist)) continue; // an owner may deliberately re-scope
      const declared = ng.match && ng.match.length ? ng.match : null;
      const terms = declared || derivedTerms(ng.text);
      if (!terms.length) {
        unchecked.push({
          prd_id: prdId, ng_id: ng.id, text: ng.text,
          reason: 'no usable match term: this non-goal is too generic to check against delivered paths. Add an '
            + 'explicit `match: ["..."]` to make it checkable — reported as unchecked rather than matching '
            + 'everything (false alarms) or nothing (silent pass).',
        });
        continue;
      }
      let hit = null;
      for (const d of delivered) {
        const hay = d.path.toLowerCase().split('\\').join('/');
        const term = terms.map((x) => String(x).toLowerCase()).find((x) => hay.includes(x));
        if (term) { hit = { d, term }; break; }
      }
      if (!hit) continue;
      violations.push({
        prd_id: prdId, ng_id: ng.id, text: ng.text, severity: 'warning',
        matched_term: hit.term, derived: !declared, path: hit.d.path, event_type: hit.d.event_type, agent: hit.d.agent,
        description: 'non-goal ' + ng.id + ' ("' + ng.text + '") says this was not to be built, but the run '
          + 'delivered ' + hit.d.path + ' which matches ' + (declared ? 'the declared term' : 'the derived term')
          + ' "' + hit.term + '"',
        fix_hint: (declared
          ? 'remove the out-of-scope work, or log an attributed decision_logged decision for prd ' + prdId + ' / ng ' + ng.id + ' re-scoping it'
          : 'this term was GUESSED from the non-goal\'s prose — confirm it is real scope creep, then either remove '
            + 'the work, re-scope with a decision_logged decision, or narrow the non-goal with an explicit `match` list'),
      });
    }
  }
  return { run_id, prds_checked: prdIds, scope_violations: violations, unchecked, delivered_paths: delivered.length, note: null };
}

// --- requires_inputs: refuse a dispatch that has nothing to work from --------------------------------------
/** SUPPORTED_INPUT_KEYS — the vocabulary checkRequiredInputs resolves, spelled out here because the error
 *  message for an unknown key has to be able to say what IS supported:
 *    prd.<section>                  a linked PRD has a non-empty sections.<section>
 *    event.<event_type>             at least one event of that type exists in this run
 *    event.<event_type>.<field>     … and at least one of them carries a non-empty <field>
 *    ticket.<ticket_id>             that ticket exists in the ticket store */
const SUPPORTED_INPUT_KEYS = 'prd.<section> · event.<event_type> · event.<event_type>.<field> · ticket.<ticket_id>';

function nonEmptyValue(v) {
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== '';
}

/**
 * checkRequiredInputs(brief, run_id, opts) -> {work_package, dispatch_allowed, satisfied, missing,
 *                                              unresolvable, reason}
 * The CONSUME side of the contract: before a work package is dispatched, every key it declares it cannot
 * start without is resolved against the run state that actually exists (events.jsonl + the linked PRD + the
 * ticket store — the same three sources every other check in this file reads). A key that is absent REFUSES
 * the dispatch with an explicit reason, instead of letting the subagent improvise on empty input.
 *
 * AN UNRECOGNISED KEY BLOCKS. "I do not know how to check this" must never resolve to "it is fine" — that is
 * the single decision that would make the whole check decorative, because the easiest way to pass a checker
 * you do not understand is to hand it something it cannot parse.
 *
 * A brief with no requires_inputs is ALLOWED — the field is optional and nothing existing changes.
 */
function checkRequiredInputs(brief, run_id, opts) {
  opts = opts || {};
  const wp = (brief && typeof brief.work_package === 'string' && brief.work_package) || '(unnamed work package)';
  const keys = (brief && Array.isArray(brief.requires_inputs)) ? brief.requires_inputs.filter((k) => typeof k === 'string' && k.trim()) : [];
  if (!keys.length) {
    return {
      work_package: wp, dispatch_allowed: true, satisfied: [], missing: [], unresolvable: [],
      reason: wp + ': no required inputs declared — nothing is checked before dispatch',
    };
  }
  const runDir = opts.runDir || path.join(store.CLAUDE_DIR, 'forge-runs', run_id);
  const { events } = readEventsJsonl(runDir);
  const prdIds = findLinkedPrdIds(events);
  const metas = prdIds.map(loadPrdMeta).filter(Boolean);

  const satisfied = [], missing = [], unresolvable = [];
  for (const raw of keys) {
    const key = raw.trim();
    const parts = key.split('.');
    const kind = parts[0];

    if (kind === 'prd') {
      const section = parts.slice(1).join('.');
      if (!section) { unresolvable.push({ key, reason: 'a `prd.` key must name a section, e.g. prd.acceptance_criteria. Supported: ' + SUPPORTED_INPUT_KEYS }); continue; }
      if (!metas.length) { missing.push({ key, reason: 'no PRD is linked to run ' + run_id + ' (no prd_generated event), so ' + key + ' is not present' }); continue; }
      const found = metas.some((m) => m && m.sections && nonEmptyValue(m.sections[section]));
      if (found) satisfied.push({ key, how: 'PRD section "' + section + '" is present and non-empty' });
      else missing.push({ key, reason: 'the linked PRD(s) ' + prdIds.join(', ') + ' have no non-empty `' + section + '` section — the input this work package requires is absent' });
      continue;
    }

    if (kind === 'event') {
      const type = parts[1];
      const field = parts.slice(2).join('.');
      if (!type) { unresolvable.push({ key, reason: 'an `event.` key must name an event type. Supported: ' + SUPPORTED_INPUT_KEYS }); continue; }
      const matching = events.filter((e) => e && e.event_type === type);
      if (!matching.length) { missing.push({ key, reason: 'no `' + type + '` event is present in run ' + run_id }); continue; }
      if (!field) { satisfied.push({ key, how: matching.length + ' `' + type + '` event(s) present' }); continue; }
      const withField = matching.filter((e) => nonEmptyValue(e[field]));
      if (withField.length) satisfied.push({ key, how: withField.length + ' `' + type + '` event(s) carry a non-empty `' + field + '`' });
      else missing.push({ key, reason: matching.length + ' `' + type + '` event(s) exist but none carries a non-empty `' + field + '` — an empty field is absent input, not present input' });
      continue;
    }

    if (kind === 'ticket') {
      const id = parts.slice(1).join('.');
      if (!id) { unresolvable.push({ key, reason: 'a `ticket.` key must name a ticket id. Supported: ' + SUPPORTED_INPUT_KEYS }); continue; }
      let tk = null;
      try { tk = store.getEntity('tickets', id); } catch { tk = null; }
      if (tk) satisfied.push({ key, how: 'ticket ' + id + ' exists in the store' });
      else missing.push({ key, reason: 'ticket ' + id + ' is not in the ticket store' });
      continue;
    }

    unresolvable.push({
      key,
      reason: 'unrecognised input key `' + key + '` — this checker cannot resolve it, and an unresolvable key '
        + 'BLOCKS rather than passes (a checker that waves through what it does not understand is decorative). '
        + 'Supported: ' + SUPPORTED_INPUT_KEYS,
    });
  }

  const allowed = missing.length === 0 && unresolvable.length === 0;
  return {
    work_package: wp, dispatch_allowed: allowed, satisfied, missing, unresolvable,
    reason: allowed
      ? wp + ': all ' + satisfied.length + ' required input(s) present in run ' + run_id
      : wp + ': DISPATCH REFUSED — ' + missing.length + ' missing input(s), ' + unresolvable.length
        + ' unresolvable key(s): ' + missing.concat(unresolvable).map((m) => m.key).join(', '),
  };
}

/**
 * buildAcceptanceEnforceEvents(gap) -> [{event_type, extra}, ...]
 * Pure payload builder for one acceptance-coverage gap (an entry from checkAcceptanceCoverage().
 * acceptance_gaps). Reuses the EXACT SAME registered 3-event trio as buildEnforceEvents() above
 * (lead_review_completed, rework_task_created, rework_assigned) — no new event_type is introduced — but
 * threads prd_id/ac_id/ticket_id through so the rework task names the specific dropped/incomplete
 * acceptance criterion instead of a generic agent mismatch. Never marks anything done.
 */
function buildAcceptanceEnforceEvents(gap) {
  const target = gap.ticket_id || gap.prd_id || '(unknown)';
  return [
    {
      event_type: 'lead_review_completed',
      extra: {
        agent: 'orchestrator',
        note: 'acceptance-coverage gap: prd ' + gap.prd_id + ' / ac ' + gap.ac_id + (gap.ticket_id ? ' (ticket ' + gap.ticket_id + ')' : ''),
        evidence: gap.description,
      },
    },
    {
      event_type: 'rework_task_created',
      extra: {
        agent: 'orchestrator', target, prd_id: gap.prd_id, ac_id: gap.ac_id, ticket_id: gap.ticket_id,
        issue: gap.description, required_fix: gap.fix_hint,
      },
    },
    { event_type: 'rework_assigned', extra: { agent: 'orchestrator', to: target, ac_id: gap.ac_id } },
  ];
}

// ---- THE EXIT-CODE GATE SET (2026-08-01, independent-witness defect: an unprotected gate) --------------
/**
 * EXIT_GATES — the ONE list that decides forge-verify's exit code, and the ONE list the VERIFY: summary
 * line is rendered from. Before this existed, both were hand-written: a six-clause `&&` chain at the bottom
 * of cliMain() and a separate string concatenation a few lines above it. That is exactly how the 2026-08-01
 * defect happened — a clause could be deleted from the chain and NO test noticed, because every scenario a
 * test used tripped several gates at once, so its `exit === 1` assertion was satisfied by a different gate
 * than the one it claimed to be about.
 *
 * Making the set data instead of syntax buys three things that a per-case fix cannot:
 *   1. The exit code and the printed counters CANNOT DRIFT — both are derived here, so a gate that gates is
 *      always a gate that is reported, and a test can read the real per-gate counts off the CLI's own output
 *      instead of re-deriving them (which would just re-implement the bug in the test).
 *   2. A NEW gate is enumerable. forge-verify-gates.test.cjs iterates this list and REFUSES to pass unless
 *      every key has an isolating scenario — one in which that gate is the ONLY non-zero counter. Adding a
 *      seventh gate without such a scenario turns that suite red; it cannot be forgotten.
 *   3. A REMOVED gate is enumerable too. The same suite asserts the reverse direction (every registered
 *      scenario still maps to a live key), so deleting a gate here — the exact mutation that survived on
 *      2026-08-01 — is a red test rather than a silent weakening.
 *
 * `count` receives the CLI's context object {verify, tickets, isolation, acceptance, failures} and returns a
 * plain number. ADVISORY checks (non-goals, evidence, config drift, the loop verdict) deliberately have NO
 * entry here — that is what "advisory" means in this file, and this list is where that line is drawn.
 */
const EXIT_GATES = [
  { key: 'mismatches', label: 'mismatch(es)', count: (c) => c.verify.mismatches },
  // VERIFY-READ-ERROR-GREEN (2026-09-24, out-p5.md): a directory-listing error (storeError) or a corrupt
  // per-entity ticket file (unreadable) used to vanish into an empty ticket list, silently reading as "no
  // open tickets" instead of "we cannot prove this store is clean". Folded into the SAME gate an ordinary
  // open ticket already trips — an unreadable ticket is treated exactly like an unresolved one.
  { key: 'open_tickets', label: 'open/unreadable ticket(s)', count: (c) => c.tickets.open.length + c.tickets.unreadable.length + (c.tickets.storeError ? 1 : 0) },
  { key: 'unproven_tickets', label: 'unproven done-ticket(s)', count: (c) => c.tickets.unproven.length },
  { key: 'isolation_violations', label: 'isolation violation(s)', count: (c) => c.isolation.violations.length },
  { key: 'acceptance_gaps', label: 'acceptance gap(s)', count: (c) => c.acceptance.acceptance_gaps.length },
  { key: 'failure_hits', label: 'failure-condition hit(s)', count: (c) => c.failures.failure_hits.length },
  // 2026-08-01 — the cost cap on unattended runs. forge-run-budget.cjs writes one verdict per headless
  // invocation into the run directory; this gate counts the ones that are not a proven completion. A run
  // that stopped on its dollar ceiling did not finish its work, so "stopped_by_budget" must never be able
  // to leave forge-verify with exit 0 — that is the whole reason the cap was allowed to exist at all.
  // 'unknown' and an unreadable verdict line count too (see forge-run-budget.cjs::countsAsStop): a record
  // we cannot read is not proof of completion, exactly like gateCount's own rule for a throwing accessor.
  { key: 'budget_stops', label: 'budget stop(s)', count: (c) => c.budget.count },
  // RC/VERIFY-READ-ERROR-GREEN (2026-09-24, out-p5.md): a malformed events.jsonl line, or a copied/foreign-
  // run event smuggled into this run's log, used to be counted (`malformed`) or silently dropped
  // (`foreignRunId`) without ever affecting the exit code — "a malformed-only log produced exit:0". Both are
  // now one gate: a log this file cannot fully trust is not a clean verification.
  { key: 'malformed_events', label: 'malformed/foreign-run event line(s)', count: (c) => c.verify.malformed + c.verify.foreignRunId },
  // VERIFY-DEAD-WORKER-GREEN (2026-09-24, out-p5.md): a worker that logged a heartbeat and then simply
  // stopped (no completion, no failure claim) left unfinished work OUTSIDE the exit gate entirely, because
  // the old mismatch predicate only fired on a FALSE claimsDone. See verifyRun()'s `deadWorker` field.
  { key: 'dead_worker_heartbeats', label: 'dead-worker heartbeat(s)', count: (c) => c.verify.agents.filter((a) => a.deadWorker).length },
];
/** gateCount(gate, ctx) -> a non-negative number. A gate whose accessor throws or returns a non-number is
 *  NOT silently zero: 0 would read as "this gate is clean", which is the one lie this file must not tell —
 *  it counts as 1 so a broken accessor gates (and is visible in the VERIFY: line) instead of passing. */
function gateCount(gate, ctx) {
  let n;
  try { n = gate.count(ctx); } catch { return 1; }
  return (typeof n === 'number' && Number.isFinite(n) && n >= 0) ? n : 1;
}
function gateCounts(ctx) {
  const out = {};
  for (const g of EXIT_GATES) out[g.key] = gateCount(g, ctx);
  return out;
}
/** gateSummary(ctx) -> the exact counter list the VERIFY: line has always printed, now derived. */
function gateSummary(ctx) {
  return EXIT_GATES.map((g) => gateCount(g, ctx) + ' ' + g.label).join(', ');
}
/** exitCodeFor(ctx) -> 0 only when EVERY gate is zero; 1 otherwise. */
function exitCodeFor(ctx) {
  return EXIT_GATES.some((g) => gateCount(g, ctx) > 0) ? 1 : 0;
}

module.exports = {
  verifyRun, verifyTickets, TERMINAL_TYPES, BACKBONE, TASK_PAIRS, buildEnforceEvents,
  isolationTripwire, isPathOutsideRoot, roundsFromEvents, loopConvergence, ROUND_BOUNDARY_TYPES, FINDING_EVENT_TYPES,
  // 2026-09-24 (out-p5.md fix-round) — exported so tests can exercise the closure grammar, the review-
  // outcome vocabulary and the owner-allowlist resolution directly, without re-deriving them.
  isMeaningfulClosureEvidence, hasTallyOrExitEvidence, reviewOutcome, REVIEW_DONE_EVENT_TYPES, resolveOwnerAllowlist,
  // 2026-08-01 ("pakket 2"): loopConvergence's report finally has a decision function AND a caller — see
  // loopBrake()'s own doc comment and the CLI's Loop: section / --enforce brake below.
  loopBrake, LOOP_MAX_ROUNDS, LOOP_DRY_STREAK,
  // 2026-08-01 (independent-witness defect 1): the brake's idempotency key — see brakeAlreadyLogged() above.
  BRAKE_NOTE_PREFIX, brakeAlreadyLogged,
  evidenceCheck,
  // V9-INTEGRATE (2026-07-22): FAILED_TYPES was computed but never exported — needed so a caller (e.g.
  // forge-doctor.cjs's unregisteredEvent cross-check, or a test) can verify an event_type's classification
  // without re-deriving the set. TERMINAL_TYPES was already exported for the same reason.
  FAILED_TYPES,
  // 2026-07-31 (rejected_approach registration): same reason FAILED_TYPES was exported above — a caller/test
  // must be able to assert an event_type's FULL classification (in exactly one bucket, absent from the
  // others) against the real sets this tool uses, instead of re-deriving them or regex-scanning the source.
  RUNNING_TYPES, PREVIEWING_TYPES, INTERNAL_TYPES, taskStatus,
  // Backlog item 7 (2026-07-31): spec-drift / acceptance-coverage detection — see file header + this
  // function's own doc comment above.
  checkAcceptanceCoverage, buildAcceptanceEnforceEvents,
  // 2026-08-01 — the failure side of the task contract (see the block comment above checkFailureConditions):
  // what must NEVER be true (gates), what must NOT be built (advisory), and what a dispatch cannot start
  // without (refuses). Helpers are exported too so a caller/test can assert the normalisation and the
  // term-derivation directly instead of re-deriving them.
  checkFailureConditions, buildFailureEnforceEvents, checkNonGoals, checkRequiredInputs,
  failureConditions, nonGoals, derivedTerms, deliveredPaths, findItemDecision, SUPPORTED_INPUT_KEYS,
  // 2026-08-01 — ADDITIVE EXPORT ONLY (no behaviour change): forge-coldverify.cjs reads a PRD's acceptance
  // criteria through THESE exact functions instead of re-implementing them, so the cold read-side check and
  // the spec-drift blocker above can never disagree about what a criterion is or which fallback id ('ac-<n>')
  // it carries. Exporting them is the whole "attach to the existing truth, don't build a second one" move —
  // see forge-coldverify.cjs's header. Nothing else in this file reads or writes differently because of it.
  loadPrdMeta, acceptanceCriteria,
  // 2026-08-01 — the exit-code gate set as DATA (see EXIT_GATES' own doc comment). Exported so
  // forge-verify-gates.test.cjs can enumerate the real gates instead of hardcoding a list that would rot.
  EXIT_GATES, gateCounts, gateSummary, exitCodeFor,
  // 2026-08-01 — re-exported so forge-verify-gates.test.cjs can build the SAME ctx the CLI builds without
  // a second require, exactly like the other gate inputs above.
  budgetStops,
};

// ---- CLI ----
if (require.main === module) {
  function parseArgs(argv) {
    const out = { run_id: null, root: DEFAULT_ROOT, enforce: false, json: false, domain: null, maxRounds: LOOP_MAX_ROUNDS, dryStreak: LOOP_DRY_STREAK };
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--root') out.root = argv[++i];
      // --run alias (2026-08-02): the public quick-reference documented `--run <id>` while this parser
      // only knew the positional form — the flag fell into pos[], "--run" became the run_id, and the
      // caller got a loud-but-baffling "run --run does not exist" instead of their verify. An audit
      // first read that as a silent false pass; live repro showed it exits 1 loudly (the missing-dir
      // guard catches it) — still, a documented form that errors out is a defect. Both forms now work.
      else if (a === '--run') out.run_id = argv[++i] || null;
      else if (a === '--enforce') out.enforce = true;
      else if (a === '--json') out.json = true;
      else if (a === '--domain') out.domain = argv[++i];
      // an unparseable/non-positive value falls back to the documented default rather than silently
      // disabling the brake (Infinity/0 would be a cap that never trips)
      else if (a === '--max-rounds') { const n = parseInt(argv[++i], 10); out.maxRounds = (Number.isFinite(n) && n > 0) ? n : LOOP_MAX_ROUNDS; }
      else if (a === '--dry-streak') { const n = parseInt(argv[++i], 10); out.dryStreak = (Number.isFinite(n) && n > 0) ? n : LOOP_DRY_STREAK; }
      else pos.push(a);
    }
    if (!out.run_id) out.run_id = pos[0] || null;
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

  function enforce(root, runId, result, ticketResult, acceptance, loop, events, failures) {
    // THE BRAKE (2026-08-01, "pakket 2"): --enforce IS the rework driver — it is the thing that opens the
    // next round. So the bound belongs here, before a single new round-creating event is written. When the
    // loop has hit its cap or gone dry, this pass logs exactly ONE already-registered quality_gate_blocked
    // event and stops; it deliberately skips the ticket annotations too, because the whole point is that
    // this run needs an owner decision, not another automated lap. See loopBrake()'s doc comment.
    //
    // CORRECTED the same day (independent-witness defect 1) — TWO conditions, both load-bearing:
    //  (1) THERE MUST BE A ROUND TO STOP. The brake used to run before enforce() knew whether it had any
    //      rework to open at all, so on a run verify itself calls clean (0 mismatches / 0 open tickets /
    //      0 unproven / 0 isolation / 0 acceptance gaps, exit 0) it turned "write nothing" into "write a
    //      red blocker". quality_gate_blocked is not cosmetic: forge-run-state flips gates to 'blocked' on
    //      it, forge-snapshot lists it as an open gap (GAP_EVENT_TYPES), forge-distill counts it as a
    //      failure (FAILURE_TYPES), forge-stats and forge-briefing report the run as blocked
    //      (BLOCKED_EVENT_TYPES) — a clean run would enter project history as blocked. The only events
    //      below that open a round are the ones whose event_type is in FINDING_EVENT_TYPES (that IS the
    //      definition roundsFromEvents() groups by), i.e. the rework trio built from a mismatched agent or
    //      an acceptance gap. Ticket annotations are ticket_updated — bookkeeping, not a new round — so a
    //      run with only those is not braked and keeps its (already idempotent) annotations.
    //  (2) IT MUST NOT ALREADY BE LOGGED. See brakeAlreadyLogged(): one blocker per run per reason, so a
    //      re-run of --enforce cannot stack duplicates on an unchanged run.
    const mismatched = result.agents.filter((a) => a.mismatch);
    const acceptanceGaps = (acceptance && acceptance.acceptance_gaps) || [];
    // a HIT failure condition drives rework exactly like a dropped acceptance criterion — same registered
    // trio, same brake, so it cannot become a second, differently-behaving rework path (2026-08-01)
    const failureHits = (failures && failures.failure_hits) || [];
    const mismatchEvents = mismatched.map((m) => buildEnforceEvents(m));
    const gapEvents = acceptanceGaps.map((g) => buildAcceptanceEnforceEvents(g));
    const failureEvents = failureHits.map((h) => buildFailureEnforceEvents(h));
    const wouldOpenRound = [].concat(...mismatchEvents, ...gapEvents, ...failureEvents).some((ev) => FINDING_EVENT_TYPES.has(ev.event_type));
    const brake = wouldOpenRound ? loopBrake(loop) : { braked: false, reason: 'no new rework round would be opened by this pass — nothing to brake' };
    if (brake.braked) {
      if (brakeAlreadyLogged(events, brake.reason)) {
        console.log('BRAKED: no new rework round opened — ' + brake.reason + ' (already logged for this run; no duplicate written).');
        return;
      }
      logEvent(root, runId, 'quality_gate_blocked', {
        agent: 'orchestrator',
        note: BRAKE_NOTE_PREFIX + brake.reason,
        reason: brake.reason,
        rounds: loop.rounds,
        new_findings_by_round: loop.newFindingsByRound,
        dry_streak: loop.dryStreak,
        converged: loop.converged,
        hit_cap: loop.hitCap,
        required_fix: 'owner decision required — the rework loop was stopped instead of opening another round',
      });
      console.log('BRAKED: no new rework round opened — ' + brake.reason + ' (one quality_gate_blocked logged).');
      return;
    }
    for (const evs of mismatchEvents) {
      for (const ev of evs) logEvent(root, runId, ev.event_type, ev.extra);
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
    for (const evs of gapEvents) {
      for (const ev of evs) logEvent(root, runId, ev.event_type, ev.extra);
    }
    for (const evs of failureEvents) {
      for (const ev of evs) logEvent(root, runId, ev.event_type, ev.extra);
    }
    const did = mismatched.length || ticketResult.open.length || ticketResult.unproven.length || acceptanceGaps.length || failureHits.length;
    console.log(did
      ? 'ENFORCED: rework logged for ' + mismatched.length + ' agent(s), ' + ticketResult.open.length + ' ticket(s) flagged still-open, ' +
        ticketResult.unproven.length + ' unproven done-ticket(s) back to review, ' + acceptanceGaps.length + ' acceptance gap(s) flagged, ' +
        failureHits.length + ' failure-condition hit(s) flagged.'
      : 'ENFORCE: nothing to do (no mismatches, no open tickets, no unproven done-tickets, no acceptance gaps, no failure-condition hits).');
  }

  function cliMain(opts) {
    const root = path.resolve(opts.root);
    const runDir = path.join(root, '.claude', 'forge-runs', opts.run_id);
    const result = verifyRun(runDir, opts);
    const ticketResult = verifyTickets({ run_id: opts.run_id });
    const isolation = isolationTripwire(runDir, root);
    const acceptance = checkAcceptanceCoverage(opts.run_id, { runDir });
    // 2026-08-01 — the failure side. `failures` GATES (a hit condition is a blocker, same weight as a dropped
    // acceptance criterion); `scope` is ADVISORY (a keyword match on a delivered path is suspicion, not proof
    // — see the block comment above checkNonGoals).
    const failures = checkFailureConditions(opts.run_id, { runDir });
    const scope = checkNonGoals(opts.run_id, { runDir });
    // 2026-08-01 — the cost cap on UNATTENDED runs (forge-run-budget.cjs). An unattended wrapper writes one
    // verdict line per headless invocation into this run directory; a run that stopped because it hit its
    // dollar ceiling has NOT finished its work, so it may never leave this tool with exit 0. GATES.
    const budget = budgetStops(runDir);
    // read the run's events ONCE for both the (optional) evidence check and the loop-until-dry check below
    const { events: runEvents } = readEventsJsonl(runDir);
    // ADVISORY, never gates the exit code (see evidenceCheck's own header doc). opts.domain is only
    // set when the caller explicitly passes --domain; otherwise evidence stays null ("not applicable").
    let evidence = null;
    if (opts.domain) evidence = evidenceCheck(runEvents, opts.domain, {});
    // LOOP-UNTIL-DRY (2026-08-01, "pakket 2"): always computed, always printed, and — under --enforce —
    // actually enforced by loopBrake(). Like the Evidence section it never folds into the exit code: the
    // gate below still measures the run's real state (mismatches/tickets/isolation/acceptance), while the
    // loop verdict answers a different question — may ANOTHER round be opened.
    const loop = loopConvergence(roundsFromEvents(runEvents), { dryStreak: opts.dryStreak, max: opts.maxRounds });
    const brake = loopBrake(loop);
    // CONFIG DRIFT (2026-08-01), ADVISORY like Evidence:/Loop: — see forge-configdrift.cjs's header for why it
    // is a module rather than a doctor check, and why its verdict is surfaced here. It answers a question
    // nothing else in this repo asked: did the RULES this run is being judged by change while it ran, and did
    // anyone claim a rule change that turned out to be a no-op. A throw is swallowed into an honest
    // "unavailable" — a drift meter must never be able to break the verify it is a passenger on.
    let configDrift = null;
    if (configDriftTool) {
      try { configDrift = configDriftTool.checkDrift(root, opts.run_id, { runDir }); }
      catch (e) { configDrift = { ok: true, comparable: false, findings: [], notes: [], announced_changes: [], reason: 'forge-configdrift.checkDrift threw: ' + e.message }; }
    }

    const lines = ['Forge Verify — ' + opts.run_id];
    if (!result.agents.length) lines.push('  (no agent activity recorded yet)');
    for (const a of result.agents) lines.push(fmtAgentLine(a));
    // RULE 2 advisory (wp23, 2026-09-24) — never gates the exit code; an ignored closes_event_id is a
    // logging mistake to fix, not proof of unfinished work.
    if (result.closesAdvisories && result.closesAdvisories.length) {
      lines.push('Evidence Closures (advisory, non-blocking):');
      for (const msg of result.closesAdvisories) lines.push('  ⚠ ' + msg);
    }
    lines.push('Tickets:');
    if (!ticketResult.tickets.length) lines.push('  (no tickets found for this run)');
    else if (!ticketResult.open.length && !ticketResult.unproven.length) lines.push('  ✓ all tickets closed (with test evidence where required)');
    else {
      for (const tk of ticketResult.open) lines.push('  ⚠ OPEN ' + (tk.ticket_id || tk.id) + ' "' + (tk.title || '') + '"');
      for (const tk of ticketResult.unproven) lines.push('  ⚠ UNPROVEN DONE ' + (tk.ticket_id || tk.id) + ' "' + (tk.title || '') + '" — required_tests without test_evidence');
    }
    lines.push('Isolation:');
    if (isolation.violations.length === 0) lines.push('  ✓ no isolation violations (' + isolation.checked + ' path(s) checked)');
    else for (const v of isolation.violations) lines.push('  ⚠ ISOLATION ' + v.event_type + ' ' + v.field + '="' + v.path + '" — ' + v.reason);
    lines.push('Acceptance Coverage:');
    if (acceptance.note) lines.push('  (' + acceptance.note + ')');
    else if (acceptance.acceptance_gaps.length === 0) lines.push('  ✓ all acceptance criteria covered (' + acceptance.prds_checked.length + ' PRD(s) checked)');
    else for (const g of acceptance.acceptance_gaps) lines.push('  ⚠ BLOCKER ac=' + (g.ac_id || '(prd-level)') + ' prd=' + g.prd_id + (g.ticket_id ? ' ticket=' + g.ticket_id : '') + ' — ' + g.description);
    // GATES, like Acceptance Coverage above — "this outcome is unacceptable" carries the same weight as
    // "this outcome is required".
    lines.push('Failure Conditions:');
    if (failures.note) lines.push('  (' + failures.note + ')');
    else if (!failures.failure_hits.length && !failures.cleared.length && !failures.waived.length && !failures.unchecked.length) {
      lines.push('  (no failure_conditions declared in the linked PRD(s))');
    } else {
      for (const h of failures.failure_hits) lines.push('  ⚠ BLOCKER fc=' + h.fc_id + ' prd=' + h.prd_id + ' — ' + h.description);
      for (const w of failures.waived) lines.push('  • WAIVED fc=' + w.fc_id + ' prd=' + w.prd_id + ' — "' + w.decision + '" (' + w.by + ')');
      for (const c of failures.cleared) lines.push('  ✓ cleared fc=' + c.fc_id + ' prd=' + c.prd_id + ' (' + c.evidence_event + ')');
      for (const u of failures.unchecked) lines.push('  ? UNCHECKED fc=' + u.fc_id + ' prd=' + u.prd_id + ' — "' + u.text + '" · ' + u.reason);
    }
    // ADVISORY (never folds into the exit code below — same contract as Evidence:/Config Drift:/Loop:).
    lines.push('Non-Goals (advisory, non-blocking):');
    if (scope.note) lines.push('  (' + scope.note + ')');
    else if (!scope.scope_violations.length && !scope.unchecked.length) lines.push('  ✓ no non_goals declared, or nothing delivered matched one (' + scope.delivered_paths + ' delivered path(s) checked)');
    else {
      for (const v of scope.scope_violations) lines.push('  ⚠ SCOPE ng=' + v.ng_id + ' prd=' + v.prd_id + (v.derived ? ' [derived term]' : ' [declared term]') + ' — ' + v.description);
      for (const u of scope.unchecked) lines.push('  ? UNCHECKED ng=' + u.ng_id + ' prd=' + u.prd_id + ' — ' + u.reason);
    }
    lines.push('Config Drift (advisory, non-blocking):');
    if (!configDrift) lines.push('  (forge-configdrift.cjs unavailable — skipped)');
    else if (!configDrift.comparable) lines.push('  (not comparable) ' + configDrift.reason);
    else {
      lines.push('  ' + (configDrift.ok ? '✓ ' : '⚠ ') + configDriftTool.summarize(configDrift));
      for (const a of configDrift.announced_changes) lines.push('  ✓ announced ' + a.kind + ': ' + a.id + (a.announced_by ? ' by ' + a.announced_by : ''));
      for (const n of configDrift.notes) lines.push('  note (' + n.kind + '): ' + n.detail);
      for (const f of configDrift.findings) lines.push('  ⚠ ' + f.kind.toUpperCase() + ' ' + f.id + ' — ' + f.detail);
    }
    lines.push('Loop:');
    lines.push('  ' + loop.rounds + ' round(s) · new findings per round [' + loop.newFindingsByRound.join(', ') + '] · dry streak ' + loop.dryStreak + '/' + opts.dryStreak + ' · cap ' + opts.maxRounds);
    if (loop.hitCap && !loop.converged) lines.push('  ⚠ HARD CAP reached — ' + loop.rounds + ' round(s) and still finding new issues · owner decision needed');
    else if (brake.braked) lines.push('  ⚠ STOP — ' + brake.reason);
    else lines.push('  ✓ ' + brake.reason);
    // ADVISORY (never folds into the exit code below — see evidenceCheck's own header doc for why).
    if (opts.domain) {
      lines.push('Evidence (advisory, non-blocking):');
      if (!evidence) lines.push('  (domain "' + opts.domain + '" not recognized by required-evidence.json, or forge-evidence.cjs unavailable — skipped)');
      else if (evidence.ok) lines.push('  ✓ all required evidence present for domain "' + evidence.domain + '" (' + evidence.satisfied.length + ' item(s))');
      else lines.push('  ⚠ MISSING EVIDENCE for domain "' + evidence.domain + '": ' + evidence.missing.join(', '));
    }
    // The VERIFY: counter list and the exit code below are BOTH derived from EXIT_GATES, so a gate that
    // gates is always a gate that is printed (see EXIT_GATES' doc comment for why that matters). The
    // advisory tail stays separate on purpose — it is deliberately NOT a gate.
    const gateCtx = { verify: result, tickets: ticketResult, isolation, acceptance, failures, budget };
    lines.push('VERIFY: ' + gateSummary(gateCtx) +
      ' · advisory: ' + scope.scope_violations.length + ' non-goal warning(s)');
    console.log(lines.join('\n'));

    if (opts.json) {
      console.log(JSON.stringify({
        run_id: opts.run_id, root, agents: result.agents, mismatches: result.mismatches, malformed: result.malformed,
        closes_advisories: result.closesAdvisories,
        tickets: ticketResult.tickets, open_tickets: ticketResult.open, unproven_tickets: ticketResult.unproven,
        isolation, evidence, config_drift: configDrift,
        loop: Object.assign({}, loop, { brake, max: opts.maxRounds, dry_streak_required: opts.dryStreak }),
        acceptance_gaps: acceptance.acceptance_gaps, acceptance_prds_checked: acceptance.prds_checked, acceptance_note: acceptance.note,
        failure_condition_hits: failures.failure_hits, failure_conditions_cleared: failures.cleared,
        failure_conditions_waived: failures.waived, failure_conditions_unchecked: failures.unchecked,
        non_goal_violations: scope.scope_violations, non_goals_unchecked: scope.unchecked,
      }, null, 2));
    }

    // runEvents (read once above) doubles as the brake's idempotency source: this process is the only
    // writer during this pass, so an earlier pass's own blocker is exactly what is visible in it.
    if (opts.enforce) enforce(root, opts.run_id, result, ticketResult, acceptance, loop, runEvents, failures);

    // ONE gate set, defined once as data in EXIT_GATES above — mismatches, open tickets, unproven
    // done-tickets, isolation violations, acceptance gaps, failure-condition hits. scope.scope_violations
    // deliberately is NOT among them (keyword match on a path = suspicion, not proof), and neither are the
    // other advisory sections. Each gate is pinned by its own ISOLATING scenario in
    // forge-verify-gates.test.cjs — a run in which that gate is the only non-zero counter.
    process.exitCode = exitCodeFor(gateCtx);
  }

  const opts = parseArgs(process.argv.slice(2));
  // A run_id may not BEGIN with '-': the old class allowed a leading hyphen, so an unknown flag that fell
  // into the positionals could be accepted as a run_id and chased as a directory. Rejecting the shape at
  // the door gives "invalid run_id" instead of a confusing missing-dir chase (2026-08-02 command audit).
  if (!opts.run_id || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(opts.run_id)) {
    console.error('Usage: node forge-verify.cjs <run_id> [--run <run_id>] [--root <projectRoot>] [--enforce] [--json] [--domain <domain>]');
    console.error('invalid or missing run_id (must start with A-Z a-z 0-9 _ ; then also -)');
    process.exitCode = 1;
  } else {
    try { cliMain(opts); } catch (e) { console.error('forge-verify: ' + e.message); process.exitCode = 1; }
  }
}
