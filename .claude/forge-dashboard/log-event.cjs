#!/usr/bin/env node
/**
 * Forge event logger — appends ONE real event to a run's events.jsonl.
 *
 * Usage:
 *   node log-event.cjs <run_id> <event_type> ['<json-extra>']
 *   node log-event.cjs '<full-json-with-run_id-and-event_type>'
 *
 * Examples:
 *   node .claude/forge-dashboard/log-event.cjs forge-2026-06-27-120000 agent_started "{\"agent\":\"Build Boss\",\"role\":\"hero\",\"dispatch_id\":\"toolu_...\",\"task\":\"build hero\"}"
 *   node .claude/forge-dashboard/log-event.cjs <run_id> agent_note "{\"agent\":\"orchestrator\",\"role\":\"lead\",\"note\":\"Selected forge-n8n; workflows/ present.\",\"evidence\":\"WORKFLOW_REGISTRY.md\"}"
 *   node .claude/forge-dashboard/log-event.cjs <run_id> agent_output "{\"agent\":\"forge-router\",\"output\":\"Project type: n8n; playbook forge-n8n.\"}"
 *
 * Event types (ENFORCED — event_type MUST be one of these; unknown names are hard-rejected under strict mode):
 *   LIFECYCLE: run_started · project_scanned · profile_loaded · memory_loaded · memory_updated · decision_logged ·
 *     agent_selected · agent_started · agent_progress · agent_completed · agent_failed · skill_loaded ·
 *     command_run · file_read · file_changed · check_started · check_passed · check_failed · report_generated · run_completed
 *   OWNER GOVERNANCE (WAVE B / B4, 2026-07-18): owner_prefs_loaded — the applied-prefs ECHO, logged once before
 *     intake by forge-bin/forge-echo.cjs::emitEcho(), summarizing which .claude/FORGE_OWNER_PROFILE.json prefs
 *     (forge-prefs.cjs) and which active config/orchestration/FORGE_STANDING_RULES.json rules (forge-standing.cjs)
 *     apply to this run, per config/orchestration/precedence.md's ordering. Informational/one-shot, like
 *     profile_loaded/memory_loaded — see forge-verify.cjs TERMINAL_TYPES and forge-dashboard/app.js taskStatus()
 *     for its mirrored registration (same 3-place discipline every event type here follows).
 *   VISIBLE-REASONING (NOT hidden chain-of-thought): agent_note · agent_output · agent_decision_summary · agent_next_action · agent_evidence_added
 *   SWARM EXECUTION (Lead-Agent studio): mission_packet_created · mission_blueprint_created · role_map_created ·
 *     skill_discovery · skill_map_created · custom_skill_created · skill_assigned ·
 *     agent_work_package_created · custom_subagent_created · subagent_started · subagent_completed · subagent_failed ·
 *     subagent_output_created · subagent_artifact_created · agent_artifact_created · agent_handoff ·
 *     lead_review_started · lead_review_completed · rework_task_created · rework_assigned · rework_started · rework_completed ·
 *     merge_started · merge_completed · codex_review_started · codex_review_completed · codex_finding · codex_blocked · codex_not_invoked ·
 *     fix_started · fix_completed · retest_started · retest_completed · quality_gate_passed · quality_gate_blocked · final_output_created
 *   ECC (ECC-first): ecc_inventory · ecc_blocked · ecc_agent_failed · native_fallback_used
 *   PROJECT GOVERNANCE (CLAUDE.md + project-local skills): claude_md_checked · claude_md_created · claude_md_updated · claude_md_conflict_detected ·
 *     project_skill_dir_checked · custom_skill_created · custom_skill_updated · custom_skill_used · custom_skill_skipped · custom_skill_conflict_detected
 *   SKILL REGISTRY (v7.1): skill_registry_checked · skill_registry_created · skill_registry_updated · skill_registry_conflict_detected
 *   CODEX UNLOCK (v7.1): codex_diagnosis_started · codex_diagnosis_completed · codex_trust_gate_detected · codex_interactive_retry_required ·
 *     codex_manual_command_created · codex_retry_started · codex_retry_completed · codex_retry_blocked (carry `reason`: trust/tty | no-git | no-output | not-available)
 *   BROWSER PROOF (v7.1): browser_proof_started · browser_screenshot_captured · browser_layout_verified · browser_proof_blocked
 *   PROJECT ISOLATION (v7.2): dashboard_isolation_check_started · dashboard_isolation_check_completed · dashboard_project_root_detected ·
 *     dashboard_state_project_mismatch · dashboard_state_reset_for_project · dashboard_port_selected · dashboard_health_verified · dashboard_cross_project_leak_blocked
 *   MISSION CONTROL PHASE 2 (WP1 — hardened flat-file store writer, forge-bin/forge-store.cjs): ticket_created · ticket_updated ·
 *     artifact_stored · prd_generated · mindmap_generated · deep_learn_started · deep_learn_completed · cost_sampled · doctor_run ·
 *     gate_evaluated · registry_scanned
 *   WAVE J (J1 forge-genesis.cjs, J2 forge-tournament.cjs, J3 forge-secondbrain.cjs, J4 forge-codemodel.cjs,
 *     J5 forge-briefing.cjs, J-INTEGRATE registration, 2026-07-19 — none of these 5 modules call logEvent()
 *     themselves per the shared-file rule; forward-declared here exactly like WAVE G/H so a future call site
 *     is never STRICT-REJECTED at write time): skill_proposed — forge-genesis.cjs::proposeSkill() staged a
 *     draft (never active). skill_approved — forge-genesis.cjs::approve() promoted a staged draft into
 *     `.claude/skills/` with a real owner-approval token. proposal_rejected — a staged proposal was
 *     explicitly declined by the owner (never inferred from silence). tournament_planned /
 *     tournament_scored — forge-tournament.cjs::plan()/score() produced a real best-of-N variant plan or
 *     rubric-weighted score. portfolio_scanned — forge-secondbrain.cjs::scan()/report() completed a
 *     read-only, evidence-cited cross-project portfolio scan. codemodel_built / codemodel_updated —
 *     forge-codemodel.cjs::build()/update() wrote or incrementally refreshed the living codebase index.
 *     briefing_generated — forge-briefing.cjs::generate() produced a real morning-briefing digest from a
 *     run's own manifest.json/events.jsonl.
 *   V9-INTEGRATE (P1 forge-runcontract.cjs, P2 forge-capabilities.cjs, P4 forge-projectbrain.cjs,
 *     P5 forge-scout.cjs, V9-INTEGRATE registration, 2026-07-22 — none of these 4 modules call logEvent()
 *     themselves per the shared-file rule for this wave; forward-declared here exactly like WAVE G/H/J so a
 *     future real call site is never STRICT-REJECTED at write time): research_done — a genuine research/reuse
 *     pass happened before new implementation work (CLAUDE.md "Research & Reuse" step, previously unlogged;
 *     also the ONE new run-contract rule with zero historical call sites — see FORGE_HARD_RULES.json's own
 *     _doc HONEST GAPS #1). run_contract_checked / run_contract_violated — forge-runcontract.cjs::check()
 *     resolved a run's non-negotiables to ok:true (every applicable block-rule satisfied or overridden) /
 *     ok:false (at least one applicable block-rule genuinely missing) respectively. capabilities_reported —
 *     forge-capabilities.cjs::report() produced a real capability-vs-usage inventory. scout_researched /
 *     capability_vetted — forge-scout.cjs's Search Boss/Skill Boss doctrine: a tailored-term research session
 *     completed, and a real APPROVE/HARD-PASS verdict was recorded to the persistent vetting ledger,
 *     respectively (see skills/forge-scout/SKILL.md "Events"). projectbrain_generated —
 *     forge-projectbrain.cjs::writeClaudeMd() actually wrote (created/merged/overwritten-forced) a real
 *     project CLAUDE.md.
 *   V9 WAVE 2 (forge-bin/forge-audit-loop.cjs, 2026-07-22): the continuous AUDIT-LOOP tool's own events —
 *     audit_iteration (one real audit iteration completed; `note` carries a summary, `iteration` carries the
 *     ledger sequence number) and audit_finding (one real finding surfaced by that iteration; `category`/
 *     `severity`/`note`/`evidence` carry the finding itself, never fabricated). Only logged when the CLI is
 *     given an explicit `--run <id>` (same optional convention as forge-doctor.cjs's own `--run`/doctor_run
 *     pairing) — a plain `iterate --json` run with no --run only appends to the ledger; no event is logged.
 *   V9-fix (2026-07-22, break-swarm DEFECT 2/3 honesty-gap close-out — forge-runcontract.cjs already READS
 *     this event type from a run's events.jsonl via findOwnerOverride(), and FORGE_HARD_RULES.json's own
 *     `override` strings for every overridable rule already document its exact shape; this registration is
 *     what lets an owner actually LOG one through the strict CLI without a STRICT REFUSED, and keeps the
 *     vocabulary honestly complete): owner_override — a real, structured, attributed owner act clearing ONE
 *     named non-`cannot_override` FORGE_HARD_RULES.json rule for the current run, shaped EXACTLY
 *     `{event_type:'owner_override', rule:'<exact-rule-id>', reason:'<real, non-bare-token reason>',
 *     by:'<configured owner id>'}` — see forge-runcontract.cjs's findOwnerOverride()/isMeaningfulReason() for
 *     the full recognition contract (exact rule-id match, meaningful reason, allow-listed `by`). One-shot
 *     fact event, same taxonomy as decision_logged/manifest_armed — the event IS the completed override act.
 *   PAPERCLIP CONTROL PLANE (forge-bin/forge-paperclip.cjs, registered WAVE C / C-INTEGRATE, 2026-07-18 — these
 *     23 event types were REAL pre-existing paperclip_* events emitted by forge-paperclip.cjs's own logEvent()
 *     calls that had never been added here, tripping forge-doctor's advisory `unregistered_event` completeness
 *     check; registering them is the fix, not a new feature):
 *     paperclip_runtime_reused · paperclip_runtime_blocked · paperclip_runtime_started ·
 *     paperclip_skills_catalog_installed · paperclip_agent_instructions_set · paperclip_agent_instructions_failed ·
 *     paperclip_agent_skills_attached · paperclip_agent_skills_failed · paperclip_selected · paperclip_git_guard_warning ·
 *     paperclip_company_reused · paperclip_company_created · paperclip_goal_created · paperclip_project_created ·
 *     paperclip_workspace_bound · paperclip_agent_reused · paperclip_agent_failed · paperclip_agent_created ·
 *     paperclip_agent_docs_written · paperclip_ticket_created · paperclip_agents_paused · paperclip_agents_resumed ·
 *     paperclip_runtime_stopped
 *   REQUIRED-EVIDENCE (WAVE C / C2+C-INTEGRATE, 2026-07-18 — config/orchestration/required-evidence.json's
 *     `any_of_events` entries per domain, consumed by forge-bin/forge-evidence.cjs::check() and forge-verify.cjs's
 *     evidenceCheck(); registered here so a future Boss logging one of these real proof-facts is never
 *     STRICT-REJECTED at write time): zero_console_errors_noted · e2e_passed · e2e_result · integration_gate_passed ·
 *     validate_workflow_passed · workflow_validated · workflow_imported_inactive · robots_checked ·
 *     source_compliance_noted · citation_verified · ingestion_idempotency_verified · backtest_completed ·
 *     uncertainty_labels_applied · webhook_auth_verified · outreach_drafted_only_noted
 *   WAVE H (H1 forge-docs.cjs, H2 forge-repomap.cjs, H4 forge-beads.cjs, H-INTEGRATE registration, 2026-07-19):
 *     doc_generated — a real .docx/.xlsx/.pptx/.pdf deliverable was written (forge-docs.cjs's CLI `--run`
 *     flag, logDocEvent()); REAL pre-existing call site. repomap_generated — a repo context map was produced
 *     (forge-repomap.cjs::map()). bead_added / bead_closed — a backlog "bead" work item was created / marked
 *     done (forge-beads.cjs::add()/close()). repomap_generated and bead_added/bead_closed are registered here
 *     per the Wave-H event vocabulary but have NO current call site in forge-repomap.cjs/forge-beads.cjs (those
 *     tools do not yet log events) — forward-declared so a future `--run`/logging wire-up is never
 *     STRICT-REJECTED at write time, same allow-first-use-later posture as most of this vocabulary.
 *   REJECTED-APPROACH MEMORY (forge-bin/forge-tool-index.cjs, 2026-07-31 — mining-ronde-1 §1, see
 *     `.claude/forge-research/MINING-RONDE-1-2026-07-31.md` §1): rejected_approach — ONE real, already-made,
 *     already-evidenced decision that a specific approach was tried and rejected, so a later run does not
 *     silently repeat it. Shaped EXACTLY
 *     `{event_type:'rejected_approach', agent:'<who>', approach:'<what was tried>', reason:'<why it was
 *     rejected>', evidence:'<the proof>'}`. It is a PROOF_EVENT (see PROOF_EVENTS below): a rejected approach
 *     with no `evidence`/`output`/`command`/`output_artifact` is STRICT-REFUSED (exit 2) rather than landing
 *     as a bare assertion — "we decided X is wrong" is only memory-worthy when it says how that was
 *     established. One-shot FACT event, same taxonomy as decision_logged/lessons_harvested: the event IS the
 *     completed, proven decision, NOT an open problem — so forge-verify.cjs classifies it terminal/'done' and
 *     deliberately keeps it OUT of FINDING_EVENT_TYPES (a rejected approach must never count as a recurring
 *     finding in the loop-convergence check). forge-bin/forge-tool-index.cjs indexes these across runs and
 *     answers `tried <query>` from them.
 *   WORK-PACKAGE OUTCOMES (2026-08-01, "pakket 1: repareer de bedrading"): wp_completed / wp_failed — the
 *     per-WP done/failed facts `forge-bin/forge-manifest.cjs`'s DONE_EVENT_TYPES/FAILED_EVENT_TYPES (L65/66)
 *     and `forge-bin/forge-briefing.cjs`'s RAN_EVENT_TYPES/BLOCKED_EVENT_TYPES (L62/66) have consumed since
 *     WAVE D — but which were never registered HERE, so under STRICT mode (the default) that entire
 *     manifest/resume/briefing chain could never receive a single real line. They are per-WP siblings of the
 *     already-registered `wp_resumed` (its "started again" counterpart, which pairs with them in
 *     forge-verify.cjs/app.js TASK_PAIRS), never run-level BACKBONE milestones. Shape:
 *     `{event_type:'wp_completed'|'wp_failed', agent:'<who>', wp_id:'<the manifest wp_id>', ...}` — the
 *     `wp_id` is what `forge-manifest.cjs::projectManifest` matches on; without it the event still logs but
 *     flips no work package. wp_completed is BOTH a PROOF_EVENT and a PASS_ASSERTION event (see below): it
 *     must carry real proof AND must not contradict itself (a non-zero `exit_code`, or a
 *     `result`/`outcome`/`verdict`/`status` field that reads as a failure, is refused — a work package is
 *     the exact unit a manifest flips to "done", so a bare or self-contradicting completion claim is
 *     precisely the fabricated completion this file exists to stop). wp_failed is deliberately NOT
 *     proof-gated, exactly like check_failed — honest failure reporting must never be harder than a
 *     success claim.
 *   MODEL PROVENANCE (2026-08-01, "pakket 1"): agent_model_used — the dashboard event
 *     `.claude/FORGE_MODEL_ROUTING.json`'s own `_doc` has always promised ("Forge logs the ACTUAL model used
 *     in FORGE_AGENT_LEDGER.md + a dashboard event") while no model-related event type existed at all.
 *     Records the model ONE agent actually ran on, shaped
 *     `{event_type:'agent_model_used', agent:'<registered agent>', model:'<real model id>'|null,
 *     source:'<how it was observed>', note:'...'}`. HONESTY GATE (MODEL_EVENTS below): the `model` key is
 *     MANDATORY and may be explicitly `null` when the runtime model is genuinely not observable — omitting
 *     it, blanking it, or filling in a placeholder/guess ("unknown", "default", "probably", …) is
 *     STRICT-REFUSED, and the stamp records `model_observed` either way. It is agent-name-checked (it is in
 *     WORKING_AGENT_EVENTS) but NOT dispatch-checked, so an agent can self-log its own model without
 *     knowing the parent's tool_use id.
 *   (back-compat: old agent_started/agent_completed/agent_output/agent_artifact_created/agent_handoff/review_started/review_completed still render.)
 * Common fields: agent, role, runtime (ecc-agent|ecc-skill|native|codex|internal), status (running|done|completed|waiting|previewing|failed|internal), task, note, output,
 *   decision_summary, next_action, evidence, files_read[], files_changed[], artifact, handoff/to, severity, iteration, custom (bool),
 *   work-package fields (mission, inputs[], allowed_actions[], not_allowed[], output_artifact, evidence_required[], handoff, success_criteria, rework_criteria),
 *   skill-routing fields (skill, skill_source: ecc-skill|forge-skill|project-local|native|internal|unavailable), and rework fields (target/to, issue, reason, required_fix).
 * STATUS legend: running=orange · completed=green · waiting=cyan · previewing=blue (work package logged, not executed) ·
 *   failed=red · internal=gray (INTERNAL ROLE ONLY). VISIBLE summaries/outputs only — never hidden chain-of-thought.
 *
 * It writes into THIS project's .claude/forge-runs/<run_id>/events.jsonl only.
 * Use this for real activity — do not log agents/notes/checks that did not actually happen.
 *
 * EVENT VOCABULARY IS ENFORCED (fix 2026-07-07, boekhouder progamma incident): event_type MUST be one
 * of the names listed above (KNOWN_EVENT_TYPES). Do NOT invent new event_type names for free-form
 * progress (e.g. "wp16_started", "contract_v8", "run_done" are FORBIDDEN — they render as nothing on
 * the dashboard and break the lenses). Put narrative/detail in `note`/`output`/`decision_summary` on a
 * STANDARD event type instead (e.g. {event_type:"agent_progress", agent:"Build Boss", note:"WP-16 done: 252 tests, smoke OK"}).
 * FORGE_STRICT_EVENTS defaults ON (opt out with =0) — an unregistered agent name, unproven dispatch, or
 * unknown event_type is HARD-REJECTED (exit 2), not just flagged.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLAUDE_DIR = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(CLAUDE_DIR, 'forge-runs');

function nowIso() { return new Date().toISOString(); }

let ev = {};
const args = process.argv.slice(2);
if (args.length === 1) {
  try { ev = JSON.parse(args[0]); } catch (e) { console.error('Invalid JSON:', e.message); process.exit(1); }
} else if (args.length >= 2) {
  ev.run_id = args[0];
  ev.event_type = args[1];
  if (args[2]) { try { Object.assign(ev, JSON.parse(args[2])); } catch (e) { console.error('Invalid extra JSON:', e.message); process.exit(1); } }
} else {
  console.error('Usage: node log-event.cjs <run_id> <event_type> [json] | node log-event.cjs <json>');
  process.exit(1);
}

if (!ev.run_id) { console.error('run_id is required'); process.exit(1); }
if (!ev.event_type) { console.error('event_type is required'); process.exit(1); }
if (!ev.timestamp) ev.timestamp = nowIso();

// same containment guard as server.cjs: run ids are alphanumeric + _ - only (no path chars, no traversal)
if (!/^[A-Za-z0-9_-]+$/.test(ev.run_id)) { console.error('invalid run_id (allowed: A-Z a-z 0-9 _ -): ' + ev.run_id); process.exit(1); }
const runDir = path.join(RUNS_DIR, ev.run_id);
const base = path.resolve(RUNS_DIR), resolved = path.resolve(runDir);
if (resolved !== base && !resolved.startsWith(base + path.sep)) { console.error('run_id escapes forge-runs — refused'); process.exit(1); }
// ── HONESTY ENFORCEMENT (deep-scan 2026-07-07) ──────────────────────────────────────────────
// Stamp every event with `_forge_verify` so the dashboard can tell a REAL dispatched/proven event
// from a claim the main session merely logged. This is what stops a solo session painting a fake
// swarm: unregistered agent names + unproven proof events are made VISIBLE, never silently trusted.
// STRICT mode is the DEFAULT (opt OUT with FORGE_STRICT_EVENTS=0). It HARD-REJECTS (exit 2): an unknown
// event_type, an unregistered agent name, a dispatch-proof START event without dispatch_id, and a
// PROOF_EVENT (check_passed/retest_completed/quality_gate_passed/codex_*_completed/browser_*/custom_skill_*)
// that carries no proof field. Without strict it only STAMPS _forge_verify and the dashboard flags it.
function loadBossRegistry() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'config', 'agents', 'agent-registry.json'), 'utf8'));
    const names = new Set();   // membership test (lowercased slug + lowercased display name)
    const canon = new Map();   // lowercased slug / lowercased name → canonical display name
    for (const [slug, a] of Object.entries(reg.agents || {})) {
      const display = a.name ? String(a.name) : slug;
      names.add(slug.toLowerCase()); canon.set(slug.toLowerCase(), display);
      if (a.name) { names.add(String(a.name).toLowerCase()); canon.set(String(a.name).toLowerCase(), display); }
    }
    return { names, canon };
  } catch { return null; } // no registry → cannot judge names (older/foreign project)
}
// Load the registry ONCE (was re-read per event) and use it for TWO jobs: (a) validate agent names, and
// (b) CANONICALIZE them. Node-duplication bug (black-box run 2026-07-11): the Lead logs the display name
// ("Build Boss") while a self-logging subagent logs the slug ("build-boss"), so the dashboard drew TWO
// nodes for one agent. Folding every agent-referencing field to the registry's canonical display name
// keeps exactly one node per Boss. The mapping was already loaded here — it was just never applied.
const BOSS_REGISTRY = loadBossRegistry();
function loadBossNames() { return BOSS_REGISTRY ? BOSS_REGISTRY.names : null; }
function canonicalAgent(v) {
  if (v == null) return v;
  const key = String(v).toLowerCase();
  // Boss registry FIRST: a Boss also has an agents/*.md file, and its registry display name ("Build Boss")
  // must win over the file slug so the dashboard keeps drawing exactly one node per Boss.
  if (BOSS_REGISTRY && BOSS_REGISTRY.canon.has(key)) return BOSS_REGISTRY.canon.get(key);
  // Project agents (2026-08-01) fold their aliases (filename / spaced spelling) to their own declared name,
  // same one-node-per-agent reason — never to a Boss name, since they are not Bosses.
  if (PROJECT_AGENTS.canon.has(key)) return PROJECT_AGENTS.canon.get(key);
  return v;
}
const GENERIC_AGENTS = new Set(['lead', 'boss', 'orchestrator', 'system', 'paperclip', 'forge-router', 'main', 'codex', '']);
// REAL PROJECT AGENTS (2026-08-01, "pakket 1") — the 12 permanent Bosses are NOT the only agents that really
// exist: `.claude/agents/*.md` also defines OPTIONAL, on-request specialists (verify-boss, codex-reviewer,
// data-scientist, electron-pro, mcp-developer, ml-engineer, payment-integration). Every one of them was
// hard-REFUSED by the name gate above, so e.g. `verify-boss` — the independent second witness whose ENTIRE
// job is to record a verdict nobody else can produce — could not log a single event about its own work
// (measured 2026-07-31: `STRICT REFUSED agent_started — unregistered agent "verify-boss"`). The fix is
// narrow on purpose: accept an agent name that is backed by a REAL agent-definition FILE on disk, and STAMP
// it `agent_kind:'project-agent'` so it is never silently indistinguishable from a permanent Boss.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not promote anyone to a 13th Boss. `config/agents/
// agent-registry.json` still documents exactly 12, its own `extensionRule` still governs real promotions,
// and a name with NO agent file (a fabricated "phantom-boss") is refused exactly as before. Existence of a
// real definition file is the evidence; the registry remains the authority on who is permanent.
function loadProjectAgents() {
  const dir = path.join(CLAUDE_DIR, 'agents');
  const names = new Set();  // membership test (lowercased slug / frontmatter name / spaced variant)
  const canon = new Map();  // any of those → the agent's own declared name
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')); } catch { return { names, canon, files: 0 }; }
  for (const f of files) {
    const base = f.replace(/\.md$/i, '');
    let declared = null;
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm) { const n = fm[1].match(/^name:\s*(.+)$/m); if (n) declared = n[1].trim().replace(/^["']|["']$/g, ''); }
    } catch { /* unreadable agent file — fall back to the filename, never guess a different agent */ }
    const display = declared || base;
    for (const alias of [base, display, String(display).replace(/-/g, ' ')]) {
      const key = String(alias).toLowerCase();
      if (!key) continue;
      names.add(key);
      if (!canon.has(key)) canon.set(key, display);
    }
  }
  return { names, canon, files: files.length };
}
const PROJECT_AGENTS = loadProjectAgents();
const WORKING_AGENT_EVENTS = new Set(['subagent_started', 'subagent_completed', 'subagent_failed', 'subagent_output_created', 'subagent_artifact_created', 'agent_started', 'agent_completed', 'custom_subagent_created',
  // agent_model_used (2026-08-01) is name-checked here — a model must be attributable to an agent that
  // really exists — but it is NOT in DISPATCH_PROOF_EVENTS below, so a self-logging agent can record its
  // own model without knowing the parent's dispatch_id.
  'agent_model_used']);
// dispatch_id proves a REAL Agent-tool call — but only the PARENT (Lead) knows the tool_use id, and it
// logs it on the START/creation event. A running subagent self-logs its own progress/output/completion
// and CANNOT know that id (fix 2026-07-09 checkup: strict-mode was rejecting the mandated self-logging
// contract). So the dispatch_id requirement applies ONLY to the start/creation events below; all other
// working events are still Boss-name-checked, just not dispatch-checked.
const DISPATCH_PROOF_EVENTS = new Set(['subagent_started', 'agent_started', 'custom_subagent_created']);
// Canonical vocabulary (fix 2026-07-07) — the exact set documented in the header comment above, incl. back-compat names.
const KNOWN_EVENT_TYPES = new Set([
  'run_started', 'project_scanned', 'profile_loaded', 'memory_loaded', 'memory_updated', 'decision_logged',
  'agent_selected', 'agent_started', 'agent_progress', 'agent_completed', 'agent_failed', 'skill_loaded',
  'command_run', 'file_read', 'file_changed', 'check_started', 'check_passed', 'check_failed', 'report_generated', 'run_completed',
  // OWNER GOVERNANCE (WAVE B / B4): the applied-prefs ECHO — see header comment above.
  'owner_prefs_loaded',
  'agent_note', 'agent_output', 'agent_decision_summary', 'agent_next_action', 'agent_evidence_added',
  'mission_packet_created', 'mission_blueprint_created', 'role_map_created', 'skill_discovery', 'skill_map_created',
  'custom_skill_created', 'skill_assigned', 'agent_work_package_created', 'custom_subagent_created',
  'subagent_started', 'subagent_completed', 'subagent_failed', 'subagent_output_created', 'subagent_artifact_created',
  'agent_artifact_created', 'agent_handoff', 'lead_review_started', 'lead_review_completed',
  'rework_task_created', 'rework_assigned', 'rework_started', 'rework_completed', 'merge_started', 'merge_completed',
  'codex_review_started', 'codex_review_completed', 'codex_finding', 'codex_blocked', 'codex_not_invoked',
  'fix_started', 'fix_completed', 'retest_started', 'retest_completed', 'quality_gate_passed', 'quality_gate_blocked', 'final_output_created',
  'ecc_inventory', 'ecc_blocked', 'ecc_agent_failed', 'native_fallback_used',
  'claude_md_checked', 'claude_md_created', 'claude_md_updated', 'claude_md_conflict_detected',
  'project_skill_dir_checked', 'custom_skill_updated', 'custom_skill_used', 'custom_skill_skipped', 'custom_skill_conflict_detected',
  'skill_registry_checked', 'skill_registry_created', 'skill_registry_updated', 'skill_registry_conflict_detected',
  'codex_diagnosis_started', 'codex_diagnosis_completed', 'codex_trust_gate_detected', 'codex_interactive_retry_required',
  'codex_manual_command_created', 'codex_retry_started', 'codex_retry_completed', 'codex_retry_blocked',
  'browser_proof_started', 'browser_screenshot_captured', 'browser_layout_verified', 'browser_proof_blocked',
  'dashboard_isolation_check_started', 'dashboard_isolation_check_completed', 'dashboard_project_root_detected',
  'dashboard_state_project_mismatch', 'dashboard_state_reset_for_project', 'dashboard_port_selected',
  'dashboard_health_verified', 'dashboard_cross_project_leak_blocked',
  // MISSION CONTROL PHASE 2 (WP1 — flat-file stores: tickets/artifacts/prd/mindmaps, forge-bin/forge-store.cjs)
  'ticket_created', 'ticket_updated', 'artifact_stored', 'prd_generated', 'mindmap_generated',
  'deep_learn_started', 'deep_learn_completed', 'cost_sampled', 'doctor_run', 'gate_evaluated', 'registry_scanned',
  // WORK-PACKAGE OUTCOMES + MODEL PROVENANCE (2026-08-01, pakket 1) — see the header doc comment above for
  // the full model of all three. wp_completed / wp_failed are the per-WP done/failed facts
  // forge-bin/forge-manifest.cjs and forge-bin/forge-briefing.cjs already consume but that were never
  // registered here, so under STRICT mode that whole chain could never receive one real line. wp_completed
  // is a PROOF_EVENT and a PASS_ASSERTION event (below); wp_failed is not proof-gated, exactly like
  // check_failed. agent_model_used records the model an agent ACTUALLY ran on, with a mandatory model field
  // that may be null when the runtime model is not observable but may never be a guess (MODEL_EVENTS below).
  // PLACEMENT NOTE, on purpose: this block sits ABOVE the required-evidence block that follows.
  // forge-doctor.cjs::extractKnownEventTypesFromSource scans this Set body INCLUDING comment lines, so an
  // apostrophe in later comment prose flips its quote parity and hides every type after it from the
  // ENFORCED unregistered_event gate (measured 2026-08-01: 20 of 183 real types invisible to it).
  // Registering these three here keeps them visible to that gate. For the same reason there is no
  // apostrophe or quote character anywhere in this comment block.
  'wp_completed', 'wp_failed', 'agent_model_used',
  // PAPERCLIP CONTROL PLANE (forge-bin/forge-paperclip.cjs) — registered WAVE C / C-INTEGRATE, 2026-07-18.
  // See header doc comment above: these were REAL pre-existing emitted events, previously unregistered.
  'paperclip_runtime_reused', 'paperclip_runtime_blocked', 'paperclip_runtime_started',
  'paperclip_skills_catalog_installed', 'paperclip_agent_instructions_set', 'paperclip_agent_instructions_failed',
  'paperclip_agent_skills_attached', 'paperclip_agent_skills_failed', 'paperclip_selected', 'paperclip_git_guard_warning',
  'paperclip_company_reused', 'paperclip_company_created', 'paperclip_goal_created', 'paperclip_project_created',
  'paperclip_workspace_bound', 'paperclip_agent_reused', 'paperclip_agent_failed', 'paperclip_agent_created',
  'paperclip_agent_docs_written', 'paperclip_ticket_created', 'paperclip_agents_paused', 'paperclip_agents_resumed',
  'paperclip_runtime_stopped',
  // REQUIRED-EVIDENCE (WAVE C / C2+C-INTEGRATE, 2026-07-18) — config/orchestration/required-evidence.json's
  // any_of_events per domain. See header doc comment above.
  'zero_console_errors_noted', 'e2e_passed', 'e2e_result', 'integration_gate_passed',
  'validate_workflow_passed', 'workflow_validated', 'workflow_imported_inactive', 'robots_checked',
  'source_compliance_noted', 'citation_verified', 'ingestion_idempotency_verified', 'backtest_completed',
  'uncertainty_labels_applied', 'webhook_auth_verified', 'outreach_drafted_only_noted',
  // WAVE D (D1 forge-manifest.cjs/forge-swarm-resume.cjs, D2 forge-fixtures.cjs, D-INTEGRATE, 2026-07-18):
  // manifest_armed — a run-level swarm dispatch manifest was persisted (forge-manifest.cjs::arm()), a
  // one-shot structural fact analogous to registry_scanned/prd_generated. wp_resumed — a specific
  // unfinished work package was re-dispatched after forge-swarm-resume.cjs::resume() (per-WP, mirrors
  // check_started's "running" semantics, not a run-level backbone milestone). fixtures_required —
  // forge-fixtures.cjs::check() found a correctness-critical domain with no real fixtures and no waiver
  // (BLOCKED, exit 3). fixtures_waived — check() accepted an explicit, logged waiver in place of real
  // fixtures (OK, but flagged, never silent). See forge-manifest.cjs/forge-swarm-resume.cjs/forge-fixtures.cjs
  // header comments for the full model.
  'manifest_armed', 'wp_resumed', 'fixtures_required', 'fixtures_waived',
  // forge-harvest.cjs (2026-07-18, post-WAVE-E): lessons_harvested — a READ-ONLY cross-project learning
  // harvest run completed (forge-harvest.cjs::harvest()), a one-shot structural fact analogous to
  // memory_updated/registry_scanned — the event IS the completed harvest, never a per-agent task. See
  // forge-harvest.cjs header doc comment for the full read-only/secret-exclusion/canonical-quote model.
  'lessons_harvested',
  // WAVE H (H1/H2/H4 + H-INTEGRATE, 2026-07-19): doc_generated (REAL call site, forge-docs.cjs --run) /
  // repomap_generated / bead_added / bead_closed (forward-declared — see header comment above).
  'doc_generated', 'repomap_generated', 'bead_added', 'bead_closed',
  // WAVE G (G1 forge-mcp-gate.cjs + G-INTEGRATE, 2026-07-19): MCP-as-client least-privilege events — the
  // gate module itself does NOT call logEvent (see forge-mcp-gate.cjs header, "shared-file rule for this
  // wave"); these are forward-declared for the Bosses/Head Chef call sites that will invoke validateGrant()/
  // planLoad() during real dispatch. mcp_grant_validated/mcp_grant_denied — a validateGrant() call resolved
  // allowed:true/false. mcp_tool_loaded — a planLoad() tool entry was actually used by a Boss. mcp_native_
  // fallback — a relevant tool was not usable (not opted-in / above tier / not granted) and the Boss fell
  // back to native Claude runtime instead (mirrors the existing native_fallback_used, MCP-specific).
  'mcp_grant_validated', 'mcp_grant_denied', 'mcp_tool_loaded', 'mcp_native_fallback',
  // WAVE J (J1-J5 + J-INTEGRATE, 2026-07-19): see header doc comment above for the full model per event.
  'skill_proposed', 'skill_approved', 'proposal_rejected',
  'tournament_planned', 'tournament_scored',
  'portfolio_scanned',
  'codemodel_built', 'codemodel_updated',
  'briefing_generated',
  // V9-INTEGRATE (P1/P2/P4/P5 + V9-INTEGRATE, 2026-07-22): see header doc comment above for the full model
  // per event. Forward-declared — none of the 4 source modules call logEvent() themselves (shared-file rule).
  'research_done', 'run_contract_checked', 'run_contract_violated', 'capabilities_reported',
  'scout_researched', 'capability_vetted', 'projectbrain_generated',
  // V9-fix (2026-07-22, break-swarm DEFECT 2/3 honesty-gap close-out): owner_override — see header doc
  // comment above. forge-runcontract.cjs already reads this event type; this just registers the vocabulary.
  'owner_override',
  // V9 WAVE 2 (forge-bin/forge-audit-loop.cjs, 2026-07-22): the continuous AUDIT-LOOP tool's own events —
  // see header doc comment above for the full model.
  'audit_iteration', 'audit_finding',
  // REJECTED-APPROACH MEMORY (forge-bin/forge-tool-index.cjs, 2026-07-31 — mining-ronde-1 §1): a real,
  // evidenced tried-and-rejected fact, indexed cross-run so a later run cannot silently repeat it. See the
  // header doc comment above for the exact shape; it is a PROOF_EVENT (below). NOTE: no apostrophe or quote
  // character in this comment block — forge-doctor.cjs::extractKnownEventTypesFromSource() scans this Set
  // body INCLUDING comment lines, so stray quote characters in comment prose corrupt its parse.
  'rejected_approach',
  // back-compat
  'review_started', 'review_completed',
]);
const PROOF_EVENTS = {
  check_passed: ['command', 'output', 'evidence', 'output_artifact'], retest_completed: ['command', 'output', 'evidence'],
  quality_gate_passed: ['evidence', 'output_artifact', 'command'], codex_review_completed: ['codex_job_id', 'evidence', 'output_path', 'codex_command'],
  codex_retry_completed: ['codex_job_id', 'evidence', 'output_path'], browser_screenshot_captured: ['screenshot_path', 'artifact', 'evidence'],
  browser_layout_verified: ['screenshot_path', 'artifact', 'evidence'], custom_skill_created: ['path'], custom_skill_updated: ['path'],
  // 2026-07-31 (mining-ronde-1 §1): a rejected approach without proof is an opinion, not memory — and this
  // index is what a LATER run trusts instead of re-deriving. Refuse it at write time rather than let a bare
  // assertion become the reason a future agent skips a viable route.
  rejected_approach: ['evidence', 'output', 'command', 'output_artifact'],
  // 2026-08-01 (pakket 1): a work package is the exact unit forge-manifest.cjs::projectManifest flips to
  // "done" and forge-briefing.cjs reports as RAN. A bare "wp5 is finished" with nothing behind it is the
  // fabricated completion this whole gate exists to stop, so it needs the same real proof check_passed
  // needs. wp_failed is intentionally absent from this map (see the header) — proving a failure must never
  // be harder than claiming a success.
  wp_completed: ['command', 'output', 'evidence', 'output_artifact'],
};
// CONTENT ORACLE (2026-07-11): a proof must not merely EXIST, it must not CONTRADICT success.
// (a) a "*_passed" event carrying a non-zero exit_code is a lie, not a pass; (b) a screenshot that is
// 0-byte/blank/truncated is not visual proof. This turns "artifact exists" into "artifact proves success".
const PASS_ASSERTION_EVENTS = new Set(['check_passed', 'retest_completed', 'quality_gate_passed', 'wp_completed']);
// (a2) RESULT-FIELD ORACLE (2026-08-01, pakket 1): the exit_code oracle above only catches a contradiction
// that happens to be expressed as a number. A pass event whose OWN result/outcome/verdict/status field reads
// as a failure ("wp_completed" + status:"failed") contradicts its own claim just as loudly, and the
// dashboard would render it red while forge-manifest.cjs flipped the work package to done — two readers,
// two answers, from one event. Refuse it at write time instead.
const CONTRADICTION_FIELDS = ['result', 'outcome', 'verdict', 'status'];
const FAILURE_VALUE_RE = /\b(fail|fails|failed|failing|failure|error|errored|blocked|refused|rejected|aborted|crash|crashed|timeout|timed[ _-]?out|not[ _-]?ok|nok)\b/i;
const SCREENSHOT_EVENTS = new Set(['browser_screenshot_captured', 'browser_layout_verified']);
const MIN_SCREENSHOT_BYTES = 512; // a real PNG/JPEG capture is many KB; below this it is empty/failed, not proof
// MODEL PROVENANCE gate (2026-08-01, pakket 1) — see the header doc comment. `model` is MANDATORY on these
// events; explicit null is the ONLY honest way to say "the runtime model was not observable". A placeholder
// or hedge is a guess dressed as a fact and is refused, because the entire value of this event is that a
// later reader can trust it without re-deriving anything.
const MODEL_EVENTS = new Set(['agent_model_used']);
const MODEL_PLACEHOLDER_RE = /^(unknown|unspecified|unobserved|not[ _-]?observed|n\/?a|tbd|todo|none|nil|null|undefined|\?+|guess|guessed|assumed|presumed|probably|maybe|default|auto|model|placeholder|x+|-+)$/i;
function verifyEvent(ev) {
  const v = {}; const et = ev.event_type;
  if (!KNOWN_EVENT_TYPES.has(et)) {
    v.event_type_unknown = true;
    v.event_type_warning = 'unknown event_type "' + et + '" — not in the standard vocabulary (see file header). Use a standard event_type and put free-form narrative in note/output/decision_summary, not a new event_type.';
  }
  if (WORKING_AGENT_EVENTS.has(et) && ev.agent != null) {
    const name = String(ev.agent).toLowerCase();
    const boss = loadBossNames();
    const internalRole = ['internal', 'native'].includes(String(ev.runtime || '').toLowerCase());
    const isBoss = boss ? boss.has(name) : false;
    const isGeneric = GENERIC_AGENTS.has(name);
    const isProjectAgent = PROJECT_AGENTS.names.has(name);
    v.agent_registered = boss ? (isBoss || isGeneric || isProjectAgent) : true;
    if (!v.agent_registered) v.agent_warning = 'unregistered agent "' + ev.agent + '" — not a permanent Boss (config/agents/agent-registry.json) and no matching agent definition in .claude/agents/. Use a Boss name, or add a real agent file first; put specialization in `role`.';
    // A real-but-not-permanent agent is ACCEPTED and LABELLED, never silently promoted (2026-08-01) — the
    // dashboard/certify/ledger readers can tell a permanent Boss from an optional project specialist.
    else if (!isBoss && !isGeneric && isProjectAgent) { v.agent_kind = 'project-agent'; v.agent_source = '.claude/agents/'; }
    // Only the parent-logged START/creation events must carry a dispatch id (proof of a real Agent call);
    // self-logged progress/output/completion events are name-checked only (see DISPATCH_PROOF_EVENTS note).
    if (DISPATCH_PROOF_EVENTS.has(et) && !ev.dispatch_id && !internalRole) v.dispatch_unverified = true;
  }
  if (PROOF_EVENTS[et]) {
    const need = PROOF_EVENTS[et];
    const has = need.find((k) => ev[k] != null && String(ev[k]).length);
    if (!has) { v.proof_verified = false; v.proof_reason = 'no proof field (' + need.join('/') + ') — CLAIMED, not verified'; }
    else {
      v.proof_verified = true;
      // (a) exit_code oracle — a "*_passed" event with a non-zero exit_code contradicts its own claim.
      if (PASS_ASSERTION_EVENTS.has(et) && ev.exit_code != null && Number(ev.exit_code) !== 0) {
        v.proof_verified = false; v.proof_reason = 'exit_code ' + ev.exit_code + ' != 0 — a pass event must carry a zero exit code';
      }
      // (a2) result-field oracle (2026-08-01) — same idea as the exit_code oracle, for the contradiction
      // expressed in words instead of a number. See CONTRADICTION_FIELDS/FAILURE_VALUE_RE above.
      if (v.proof_verified && PASS_ASSERTION_EVENTS.has(et)) {
        for (const f of CONTRADICTION_FIELDS) {
          const raw = ev[f];
          if (raw == null || typeof raw === 'object') continue;
          if (FAILURE_VALUE_RE.test(String(raw))) {
            v.proof_verified = false;
            v.proof_reason = f + ' "' + raw + '" contradicts the ' + et + ' claim — a pass event cannot also report a failed/blocked/refused outcome';
            break;
          }
        }
      }
      // (b) path oracle — the proof path must exist; a screenshot proof must also be non-trivial in size.
      const pathish = ev.screenshot_path || ev.output_path || ev.path || ev.artifact || ev.output_artifact;
      if (v.proof_verified && pathish && typeof pathish === 'string' && /[\\/]/.test(pathish)) {
        const abs = path.isAbsolute(pathish) ? pathish : path.join(CLAUDE_DIR, '..', pathish);
        if (!fs.existsSync(abs)) { v.proof_verified = false; v.proof_reason = 'proof path missing: ' + pathish; }
        else if (SCREENSHOT_EVENTS.has(et)) {
          let sz = 0; try { sz = fs.statSync(abs).size; } catch {}
          if (sz < MIN_SCREENSHOT_BYTES) { v.proof_verified = false; v.proof_reason = 'screenshot only ' + sz + ' bytes (< ' + MIN_SCREENSHOT_BYTES + ') — blank/failed capture, not proof'; }
        }
      }
    }
  }
  // MODEL PROVENANCE gate (2026-08-01, pakket 1) — see MODEL_EVENTS above and the header doc comment. The
  // stamp records model_observed either way, so a null model is visibly an honest "not observable", never
  // an accident that reads the same as a forgotten field.
  if (MODEL_EVENTS.has(et)) {
    if (!Object.prototype.hasOwnProperty.call(ev, 'model')) {
      v.model_unverified = true;
      v.model_reason = 'no `model` field — ' + et + ' requires an explicit model; log null when the actual model is not observable, never omit it and never guess';
    } else if (ev.model === null) {
      v.model_observed = false;
    } else {
      const m = String(ev.model).trim();
      if (!m) { v.model_unverified = true; v.model_reason = 'blank `model` value — log null when the actual model is not observable, never an empty string'; }
      else if (MODEL_PLACEHOLDER_RE.test(m)) { v.model_unverified = true; v.model_reason = 'placeholder model "' + ev.model + '" — a model that was not actually observed must be logged as null, never guessed'; }
      else v.model_observed = true;
    }
  }
  return Object.keys(v).length ? v : null;
}
// Canonicalize agent-referencing fields to the registry's display name BEFORE verify + write, so a slug
// ("build-boss") and its display name ("Build Boss") never split into two dashboard nodes for one agent.
for (const _f of ['agent', 'to', 'target', 'handoff']) { if (ev[_f] != null) ev[_f] = canonicalAgent(ev[_f]); }
const _v = verifyEvent(ev);
if (_v) ev._forge_verify = _v;
// STRICT is the DEFAULT since 2026-07-07 (was opt-in via =1; nobody turned it on, which let a fake
// swarm + free-form event names through undetected — boekhouder progamma incident). Opt OUT with =0.
const STRICT = process.env.FORGE_STRICT_EVENTS !== '0';
if (STRICT && _v && (_v.agent_registered === false || _v.proof_verified === false || _v.dispatch_unverified || _v.event_type_unknown || _v.model_unverified)) {
  console.error('STRICT REFUSED ' + ev.event_type + ' — ' + (_v.event_type_warning || _v.agent_warning || _v.proof_reason || _v.model_reason || 'unproven dispatch (no dispatch_id, runtime not internal/native)') + ' (set FORGE_STRICT_EVENTS=0 to opt out of strict mode — not recommended)');
  process.exit(2);
}

fs.mkdirSync(runDir, { recursive: true });
// TAMPER-EVIDENT HASH CHAIN (2026-07-11): each event carries entry_hash = sha256(canonical(event)+prev_hash),
// chaining it to the previous event's entry_hash (genesis = 'genesis:'+run_id). Makes the append-only log
// tamper-EVIDENT (not tamper-proof): forge-doctor walks the chain and detects any edited/removed event.
const _eventsFile = path.join(runDir, 'events.jsonl');
// Fix (2026-07-15, HIGH bug): this used to read ONLY the file's last line and use ITS entry_hash (or fall
// straight to 'genesis:'+run_id if that one line had none). On a LEGACY run (events written before the hash
// chain existed — 7 such runs are real in this project), that meant appending one new chained event set
// prev_hash='genesis:'+run_id even though the run already had prior (unchained) events — the doctor/certify
// chain-walk then read the run as 2 unchained + 1 chained event, indistinguishable from a truncated/edited
// chain. This is still the CORRECT prev_hash for that exact case (a fresh chain legitimately starts at
// genesis when no prior event had a hash) — the actual bug was on the READING side (forge-doctor.cjs
// chainCheck / forge-certify.cjs verifyChain), fixed there to validate only from the first chained event
// onward. This write-side fix is a belt-and-suspenders companion: search BACKWARD past any blank lines for
// the nearest event that already carries an entry_hash (continuing an existing chain correctly instead of
// silently trusting only the literal last line), falling back to genesis only when no chained event exists
// anywhere yet in this run.
const _prevHash = (() => {
  try {
    const d = fs.readFileSync(_eventsFile, 'utf8');
    const lines = d.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim();
      if (!s) continue; // blank/whitespace-only line — skip, not the chain tail
      let parsed;
      try { parsed = JSON.parse(s); } catch { continue; } // defensively skip an unparseable line rather than crash
      if (parsed && parsed.entry_hash) return parsed.entry_hash;
      // a real, parseable event without entry_hash — keep searching further back for an earlier chained one
    }
    return null;
  } catch { return null; }
})() || ('genesis:' + ev.run_id);
ev.prev_hash = _prevHash;
const _canon = (() => { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = ev[x]; return JSON.stringify(o); })();
ev.entry_hash = crypto.createHash('sha256').update(_canon + _prevHash).digest('hex');
fs.appendFileSync(_eventsFile, JSON.stringify(ev) + '\n', 'utf8');
// only emit a tag when there is real flag content — otherwise accepted events printed a confusing ' []' (fix 2026-07-09)
const _flags = _v ? [_v.event_type_unknown ? 'UNKNOWN-TYPE' : '', _v.agent_registered === false ? 'UNREGISTERED' : '', _v.proof_verified === false ? 'UNVERIFIED' : '', _v.dispatch_unverified ? 'NO-DISPATCH-ID' : '', _v.model_unverified ? 'MODEL-UNVERIFIED' : ''].filter(Boolean) : [];
const vtag = _flags.length ? ' [' + _flags.join(' ') + ']' : '';
console.log('logged ' + ev.event_type + ' -> ' + path.join('forge-runs', ev.run_id, 'events.jsonl') + vtag);
