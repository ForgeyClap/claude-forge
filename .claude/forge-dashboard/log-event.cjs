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
  if (v == null || !BOSS_REGISTRY) return v;
  const key = String(v).toLowerCase();
  return BOSS_REGISTRY.canon.has(key) ? BOSS_REGISTRY.canon.get(key) : v;
}
const GENERIC_AGENTS = new Set(['lead', 'boss', 'orchestrator', 'system', 'paperclip', 'forge-router', 'main', 'codex', '']);
const WORKING_AGENT_EVENTS = new Set(['subagent_started', 'subagent_completed', 'subagent_failed', 'subagent_output_created', 'subagent_artifact_created', 'agent_started', 'agent_completed', 'custom_subagent_created']);
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
  // back-compat
  'review_started', 'review_completed',
]);
const PROOF_EVENTS = {
  check_passed: ['command', 'output', 'evidence', 'output_artifact'], retest_completed: ['command', 'output', 'evidence'],
  quality_gate_passed: ['evidence', 'output_artifact', 'command'], codex_review_completed: ['codex_job_id', 'evidence', 'output_path', 'codex_command'],
  codex_retry_completed: ['codex_job_id', 'evidence', 'output_path'], browser_screenshot_captured: ['screenshot_path', 'artifact', 'evidence'],
  browser_layout_verified: ['screenshot_path', 'artifact', 'evidence'], custom_skill_created: ['path'], custom_skill_updated: ['path'],
};
// CONTENT ORACLE (2026-07-11): a proof must not merely EXIST, it must not CONTRADICT success.
// (a) a "*_passed" event carrying a non-zero exit_code is a lie, not a pass; (b) a screenshot that is
// 0-byte/blank/truncated is not visual proof. This turns "artifact exists" into "artifact proves success".
const PASS_ASSERTION_EVENTS = new Set(['check_passed', 'retest_completed', 'quality_gate_passed']);
const SCREENSHOT_EVENTS = new Set(['browser_screenshot_captured', 'browser_layout_verified']);
const MIN_SCREENSHOT_BYTES = 512; // a real PNG/JPEG capture is many KB; below this it is empty/failed, not proof
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
    v.agent_registered = boss ? (boss.has(name) || GENERIC_AGENTS.has(name)) : true;
    if (!v.agent_registered) v.agent_warning = 'unregistered agent "' + ev.agent + '" — not a permanent Boss (config/agents/agent-registry.json). Use a Boss name; put specialization in `role`.';
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
if (STRICT && _v && (_v.agent_registered === false || _v.proof_verified === false || _v.dispatch_unverified || _v.event_type_unknown)) {
  console.error('STRICT REFUSED ' + ev.event_type + ' — ' + (_v.event_type_warning || _v.agent_warning || _v.proof_reason || 'unproven dispatch (no dispatch_id, runtime not internal/native)') + ' (set FORGE_STRICT_EVENTS=0 to opt out of strict mode — not recommended)');
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
const _flags = _v ? [_v.event_type_unknown ? 'UNKNOWN-TYPE' : '', _v.agent_registered === false ? 'UNREGISTERED' : '', _v.proof_verified === false ? 'UNVERIFIED' : '', _v.dispatch_unverified ? 'NO-DISPATCH-ID' : ''].filter(Boolean) : [];
const vtag = _flags.length ? ' [' + _flags.join(' ') + ']' : '';
console.log('logged ' + ev.event_type + ' -> ' + path.join('forge-runs', ev.run_id, 'events.jsonl') + vtag);
