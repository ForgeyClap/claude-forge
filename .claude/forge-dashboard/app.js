'use strict';
/* Forge Control Center — core: state, SSE/poll, agent/work-package model, role taxonomy, top bar.
   Real data only; no fabrication, no hidden chain-of-thought. Panels in panels.js, interaction/render in graph.js. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const trunc = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const hhmmss = (iso) => { try { const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); } catch { return ''; } };
const ago = (iso) => { try { const d = (Date.now() - new Date(iso).getTime()) / 1000; if (d < 60) return Math.max(0, Math.round(d)) + 's ago'; if (d < 3600) return Math.round(d / 60) + 'm ago'; return Math.round(d / 3600) + 'h ago'; } catch { return '—'; } };
const fileName = (f) => !f ? '' : (typeof f === 'string' ? f : (f.file || ''));

// Node-duplication fix (black-box run 2026-07-11): log-event.cjs now canonicalizes agent names on write,
// but HISTORICAL runs (and any non-canonical event) can still split one Boss into two nodes — the Lead logs
// the display name ("Build Boss") while a self-logging subagent logs the slug ("build-boss"). Fold every
// agent-referencing field to the permanent Boss display name ONCE, at ingestion, so every lens sees a single
// canonical node per Boss. The 12 Bosses are permanent (config/agents/agent-registry.json).
const BOSS_CANON = { 'boss': 'Boss', 'head-chef': 'Head Chef', 'review-boss': 'Review Boss', 'test-boss': 'Test Boss',
  'ui-boss': 'UI Boss', 'seo-boss': 'SEO Boss', 'security-boss': 'Security Boss', 'skill-boss': 'Skill Boss',
  'search-boss': 'Search Boss', 'build-boss': 'Build Boss', 'integration-boss': 'Integration Boss', 'docs-boss': 'Docs Boss' };
const canonAgent = (v) => { if (v == null) return v; const k = String(v).toLowerCase(); return BOSS_CANON[k] || v; };
const canonEvents = (arr) => { if (Array.isArray(arr)) for (const e of arr) { if (e && typeof e === 'object') for (const f of ['agent', 'to', 'target', 'handoff', 'handoff_to']) { if (e[f] != null) e[f] = canonAgent(e[f]); } } return arr; };

const STATE = { meta: { name: '—', port: '' }, run: {}, events: [], report: null, memory: {}, runs: 0, malformed: 0,
  settings: { polling_interval_ms: 250, fast_mode: false, auto_scroll_logs: true }, _nodes: [], _prevCount: 0,
  eccMode: { normal: 'on', full_test: 'off' },
  session: { mode: 'off' },
  bosses: [], // the 12 permanent Bosses (config/agents/agent-registry.json) — WP2 Agent Board
  prds: [], // stored PRDs (.claude/forge-prd/, forge-bin/forge-prd.cjs) — WP3 PRD viewer
  mindmaps: [], // stored mind maps (.claude/forge-mindmaps/, forge-bin/forge-mindmap.cjs) — WP4 Mind Map
  tickets: [], // stored tickets (.claude/forge-tickets/, forge-bin/forge-store.cjs) — WP5 Ticket board
  artifacts: [], // stored artifact METADATA only (.claude/forge-artifacts/, forge-bin/forge-artifact.cjs) — WP5 Vault
  doctor: null, // newest run's forge-doctor.cjs self-test result (.claude/forge-runs/<id>/doctor.json) — WP7 Doctor
  bossAgents: [], // the 12 Boss agent-files + memory lesson counts (server.cjs's readBossAgents()) — WP8 Bosses panel
  replay: { active: false, playing: false, cursor: 0, speed: 1 },
  ui: { insTab: 'summary', actFilter: 'all', dockTab: 'log', collapsed: new Set() } };
// Live vs Replay: visibleEvents() drives the whole model. Live = all events. Replay = slice up to cursor (animates WAITING→RUNNING→COMPLETED in event order).
function visibleEvents() { const r = STATE.replay; return r.active ? STATE.events.slice(0, Math.max(0, Math.min(r.cursor, STATE.events.length))) : STATE.events; }
function replayAtLive() { return !STATE.replay.active || STATE.replay.cursor >= STATE.events.length; }
let selectedKey = null, selRef = { refKey: null, refEvIdx: null }, CURRENT_MODEL = { nodes: [], edges: [], world: { w: 0, h: 0 } };

const SYNTH = { run_started: 'orchestrator', run_completed: 'orchestrator', agent_selected: 'forge-router',
  project_scanned: 'project-scan', profile_loaded: 'project-scan', memory_loaded: 'memory-loader', memory_updated: 'memory-loader',
  decision_logged: 'memory-loader', skill_loaded: 'skill-runner', command_run: 'command-runner', file_read: 'file-reader', file_changed: 'file-writer',
  check_started: 'reviewer', check_passed: 'reviewer', check_failed: 'reviewer', report_generated: 'report-writer',
  mission_packet_created: 'orchestrator', mission_blueprint_created: 'orchestrator', role_map_created: 'orchestrator', agent_work_package_created: 'orchestrator',
  lead_review_started: 'orchestrator', lead_review_completed: 'orchestrator', rework_task_created: 'orchestrator', merge_started: 'orchestrator', merge_completed: 'orchestrator',
  skill_discovery: 'orchestrator', skill_map_created: 'orchestrator', custom_skill_created: 'orchestrator', skill_assigned: 'orchestrator',
  codex_review_started: 'codex-reviewer', codex_review_completed: 'codex-reviewer', codex_finding: 'codex-reviewer', codex_blocked: 'codex-reviewer', codex_not_invoked: 'codex-reviewer',
  retest_started: 'tester', retest_completed: 'tester', final_output_created: 'report-writer',
  quality_gate_passed: 'orchestrator', quality_gate_blocked: 'orchestrator', ecc_inventory: 'orchestrator',
  ecc_blocked: 'orchestrator', ecc_agent_failed: 'orchestrator', native_fallback_used: 'orchestrator',
  claude_md_checked: 'orchestrator', claude_md_created: 'orchestrator', claude_md_updated: 'orchestrator', claude_md_conflict_detected: 'orchestrator',
  project_skill_dir_checked: 'orchestrator', custom_skill_updated: 'orchestrator', custom_skill_used: 'orchestrator', custom_skill_skipped: 'orchestrator', custom_skill_conflict_detected: 'orchestrator',
  skill_registry_checked: 'orchestrator', skill_registry_created: 'orchestrator', skill_registry_updated: 'orchestrator', skill_registry_conflict_detected: 'orchestrator',
  codex_diagnosis_started: 'codex-reviewer', codex_diagnosis_completed: 'codex-reviewer', codex_trust_gate_detected: 'codex-reviewer', codex_interactive_retry_required: 'codex-reviewer',
  codex_manual_command_created: 'codex-reviewer', codex_retry_started: 'codex-reviewer', codex_retry_completed: 'codex-reviewer', codex_retry_blocked: 'codex-reviewer',
  browser_proof_started: 'browser-qa', browser_screenshot_captured: 'browser-qa', browser_layout_verified: 'browser-qa', browser_proof_blocked: 'browser-qa',
  dashboard_isolation_check_started: 'dashboard', dashboard_isolation_check_completed: 'dashboard', dashboard_project_root_detected: 'dashboard',
  dashboard_state_project_mismatch: 'dashboard', dashboard_state_reset_for_project: 'dashboard', dashboard_port_selected: 'dashboard',
  dashboard_health_verified: 'dashboard', dashboard_cross_project_leak_blocked: 'dashboard',
  // MISSION CONTROL PHASE 2 (WP1 — flat-file stores: tickets/artifacts/prd/mindmaps, forge-bin/forge-store.cjs)
  prd_generated: 'orchestrator', mindmap_generated: 'orchestrator', deep_learn_started: 'project-scan', deep_learn_completed: 'project-scan',
  doctor_run: 'reviewer', registry_scanned: 'orchestrator', cost_sampled: 'orchestrator', ticket_created: 'orchestrator',
  ticket_updated: 'orchestrator', artifact_stored: 'report-writer', gate_evaluated: 'reviewer' };
// new swarm events alias their old counterparts: subagent_* ≈ agent_*, mission_blueprint ≈ mission_packet, final_output ≈ report.
const BACKBONE = new Set(['run_started', 'run_completed', 'agent_selected', 'agent_started', 'agent_completed', 'agent_failed',
  'subagent_started', 'subagent_completed', 'report_generated', 'final_output_created', 'mission_packet_created', 'mission_blueprint_created', 'role_map_created',
  'agent_work_package_created', 'custom_subagent_created', 'lead_review_started', 'lead_review_completed', 'rework_task_created', 'rework_completed',
  'merge_started', 'merge_completed', 'quality_gate_passed', 'quality_gate_blocked', 'codex_review_started', 'codex_review_completed', 'codex_finding', 'codex_blocked', 'codex_not_invoked',
  'subagent_failed', 'skill_discovery', 'skill_map_created', 'custom_skill_created', 'skill_assigned',
  // MISSION CONTROL PHASE 2 (WP1) structural milestones
  'prd_generated', 'mindmap_generated', 'deep_learn_completed', 'doctor_run', 'registry_scanned']);

// Fix 1 (task double-count, 2026-07-10): non-BACKBONE start/terminal event pairs that describe ONE logical
// task (e.g. check_started -> check_passed) — buildNodes() closes the open start-task instead of pushing a
// second entry ("3/6" -> "3/3"). buildNodes() only consults this table inside the `!BACKBONE.has(t)` branch,
// so a pair where the terminal side IS a BACKBONE event (e.g. rework_completed, lead_review_completed) is
// intentionally a no-op here — that start task then stays honestly OPEN instead of being silently closed.
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

/* ---------- status (6 states) ---------- */
function statusClass(s) { const v = String(s || '').toLowerCase();
  if (v.includes('internal') || v.includes('conceptual') || v.includes('role only')) return 'internal';
  if (v.includes('preview')) return 'previewing';
  if (v.includes('fail') || v.includes('block') || v.includes('refus')) return 'failed';
  if (v.includes('done') || v.includes('complete') || v.includes('pass')) return 'done';
  if (v.includes('wait') || v.includes('ask') || v.includes('paus') || v.includes('pend') || v.includes('queue') || v.includes('select')) return 'waiting';
  if (v.includes('run') || v.includes('progress') || v.includes('start')) return 'running';
  return 'waiting';
}
function taskStatus(e) { if (e.status) return statusClass(e.status); const t = e.event_type;
  if (['check_passed', 'retest_completed', 'fix_completed', 'quality_gate_passed', 'agent_completed', 'run_completed',
       'subagent_completed', 'lead_review_completed', 'rework_completed', 'merge_completed', 'codex_review_completed',
       'final_output_created', 'mission_blueprint_created', 'role_map_created', 'skill_discovery', 'skill_map_created', 'custom_skill_created',
       'claude_md_checked', 'claude_md_created', 'claude_md_updated', 'project_skill_dir_checked', 'custom_skill_updated', 'custom_skill_used',
       'skill_registry_checked', 'skill_registry_created', 'skill_registry_updated', 'codex_diagnosis_completed', 'codex_manual_command_created', 'codex_retry_completed',
       'browser_screenshot_captured', 'browser_layout_verified',
       'dashboard_isolation_check_completed', 'dashboard_project_root_detected', 'dashboard_state_reset_for_project', 'dashboard_port_selected', 'dashboard_health_verified',
       'report_generated', 'mission_packet_created', 'codex_finding', 'native_fallback_used', 'review_completed',
       'prd_generated', 'mindmap_generated', 'deep_learn_completed', 'doctor_run', 'registry_scanned', 'artifact_stored', 'gate_evaluated',
       // Fix 2 (taxonomy gap, 2026-07-10): one-shot FACT events — the event itself IS the completed micro-action,
       // there is no separate start/terminal pair for these — so they must not fall through to 'waiting' forever.
       'ticket_created', 'ticket_updated', 'cost_sampled'].includes(t)) return 'done';
  if (['check_failed', 'agent_failed', 'subagent_failed', 'quality_gate_blocked', 'codex_blocked', 'claude_md_conflict_detected', 'custom_skill_conflict_detected',
       'skill_registry_conflict_detected', 'codex_retry_blocked', 'browser_proof_blocked', 'dashboard_state_project_mismatch', 'dashboard_cross_project_leak_blocked',
       'ecc_blocked', 'ecc_agent_failed'].includes(t)) return 'failed';
  if (t === 'codex_not_invoked' || t === 'custom_skill_skipped') return 'internal';
  if (['agent_work_package_created', 'custom_subagent_created', 'rework_task_created', 'rework_assigned', 'skill_assigned',
       'codex_trust_gate_detected', 'codex_interactive_retry_required'].includes(t)) return 'previewing';
  if (t === 'agent_selected') return 'waiting';
  if (['check_started', 'agent_progress', 'agent_started', 'subagent_started', 'codex_review_started', 'fix_started',
       'retest_started', 'lead_review_started', 'rework_started', 'merge_started', 'codex_diagnosis_started', 'codex_retry_started', 'browser_proof_started', 'dashboard_isolation_check_started',
       'run_started', 'review_started'].includes(t)) return 'running';
  // informational/activity events that represent an action that already happened
  if (['file_read', 'file_changed', 'command_run', 'skill_loaded', 'project_scanned', 'profile_loaded', 'memory_loaded', 'memory_updated',
       'decision_logged', 'agent_note', 'agent_output', 'agent_decision_summary', 'agent_next_action', 'agent_evidence_added',
       'agent_artifact_created', 'subagent_artifact_created', 'subagent_output_created', 'agent_handoff', 'ecc_inventory'].includes(t)) return 'done';
  return 'waiting'; // unknown event_type — never imply completion
}
function statusLabel(s) { const en = { done: 'COMPLETED', running: 'RUNNING', failed: 'FAILED', waiting: 'WAITING', previewing: 'PREVIEWING', internal: 'INTERNAL ONLY' }; const key = en[s] ? s : 'waiting'; const fb = en[key]; return (window.i18nt ? window.i18nt('status.' + key, fb) : fb); }
function nodeState(x) { if (!x) return 'waiting'; if (x.event_type) return taskStatus(x); if (x.state) return x.state; return statusClass(x.status); }

/* ---------- role taxonomy + deterministic color ---------- */
const ROLE_DEFS = [
  { role: 'lead', label: 'LEAD', glyph: '♛', band: 'control', hue: 150, pin: '#46e08a', re: /lead|orchestr|integrat/ },
  { role: 'router', label: 'ROUTER', glyph: '◇', band: 'control', hue: 165, pin: '#37d6a6', re: /rout/ },
  { role: 'context', label: 'CONTEXT', glyph: '⌕', band: 'context', hue: 190, pin: '#37e0e0', re: /context|scan|profile|explor/ },
  { role: 'memory', label: 'MEMORY', glyph: '❖', band: 'context', hue: 205, pin: '#37b6e0', re: /memory|history/ },
  { role: 'planner', label: 'PLAN', glyph: '▤', band: 'plan', hue: 265, pin: '#9b8cff', re: /plan|architect|requirement/ },
  { role: 'codex', label: 'CODEX', glyph: '⧉', band: 'review', hue: 225, pin: '#6e9bff', re: /codex/ },
  { role: 'security', label: 'SEC', glyph: '⛨', band: 'review', hue: 10, pin: '#ff7a6e', re: /security|secret|audit|vuln/ },
  { role: 'tester', label: 'TEST', glyph: '◉', band: 'review', hue: 110, pin: '#7bd45a', re: /test|tdd|e2e|\bqa\b/ },
  { role: 'reviewer', label: 'REVIEW', glyph: '◈', band: 'review', hue: 320, pin: '#e08ad6', re: /review|gate|critic/ },
  { role: 'report', label: 'REPORT', glyph: '▭', band: 'report', hue: 48, pin: '#e0c46e', re: /report|deliver|docs?.?writer|documentation/ },
  { role: 'execution', label: 'EXEC', glyph: '⚙', band: 'execution', hue: 40, pin: '#ffb454', re: /exec|build|file|command|skill|runner|writer|data.?process|logger|coder/ },
  { role: 'specialist', label: 'SPEC', glyph: '✳', band: 'domain', hue: null, pin: null, re: /.*/ },
];
function hashStr(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
const SPEC_SEG = [[215, 250], [255, 290], [295, 330], [98, 120], [160, 185]];
const SPEC_GLYPHS = ['✳', '✦', '❂', '▣', '✸', '❖', '⬡', '◍'];
function specialistHue(name) { const h = hashStr('forge:' + String(name).toLowerCase()); const seg = SPEC_SEG[h % SPEC_SEG.length]; return seg[0] + ((h >>> 8) % (seg[1] - seg[0] + 1)); }
function oklch(L, C, H, a) { return 'oklch(' + L + '% ' + C + ' ' + H + (a != null ? ' / ' + a : '') + ')'; }
function roleOf(name, role, et) { const p = String(role || name || et || '').toLowerCase(); for (const d of ROLE_DEFS) if (d.re.test(p)) return d; return ROLE_DEFS[ROLE_DEFS.length - 1]; }
function agentColor(name, role, et) { const d = roleOf(name, role, et); const isSpec = d.hue == null; const hue = isSpec ? specialistHue(name || role || 'x') : d.hue;
  const C = isSpec ? 0.2 : 0.15; const glyph = isSpec ? SPEC_GLYPHS[hashStr('g:' + String(name).toLowerCase()) % SPEC_GLYPHS.length] : d.glyph;
  const label = isSpec ? String(name || role || 'agent') : d.label;
  return { role: d.role, label, glyph, band: d.band, hue, solid: d.pin || oklch(76, C, hue), head: d.pin || oklch(72, C - 0.02, hue),
    fill: oklch(16, 0.05, hue), fillLo: oklch(10, 0.035, hue) };
}
const GROUP_ORDER = ['control', 'context', 'planning', 'domain', 'execution', 'review', 'report'];
const GROUP_LABEL = { control: 'CONTROL', context: 'CONTEXT', planning: 'PLANNING', domain: 'DOMAIN', execution: 'EXECUTION', review: 'REVIEW', report: 'MEMORY · REPORT' };
function groupBandOf(n) { const b = agentColor(n.key, n.role).band; return ({ control: 'control', context: 'context', plan: 'planning', domain: 'domain', execution: 'execution', review: 'review', report: 'report' }[b]) || 'domain'; }

/* ---------- agent / work-package model ---------- */
function buildNodes() {
  const map = new Map(); const order = [];
  visibleEvents().forEach((e, idx) => {
    const explicit = !!e.agent; const key = e.agent || SYNTH[e.event_type] || 'system';
    let n = map.get(key);
    if (!n) { n = { key, role: '', group: '', status: 'waiting', title: key, firstIdx: idx, lastTs: e.timestamp, derived: !explicit,
      tasks: [], _btypes: new Set(), _failed: false, _hasStart: false, _hasDone: false, _hasActivity: false, _wpStatus: '', internal: false,
      _unregistered: false, _noDispatch: false, _proofUnverified: false,
      why: '', mission: '', wp: null, artifacts: [], handoffs: [], findings: [], _lastEvWaiting: false, _lastEvType: '', runtime: '', _runtimes: new Set(),
      custom: false, blueprint: false, reworks: [], customSkills: [],
      notes: [], outputs: [], decision: '', nextAction: '', evidence: '', filesRead: new Set(), filesChanged: new Set(), events: [] }; map.set(key, n); order.push(key); }
    if (explicit) n.derived = false;
    n.events.push(e); n.lastTs = e.timestamp || n.lastTs; n._lastEvType = e.event_type; n._lastEvWaiting = (taskStatus(e) === 'waiting');
    if (e.role) n.role = e.role;
    if (e.runtime) n._runtimes.add(String(e.runtime).toLowerCase());
    const fv = e._forge_verify; // honesty stamp from log-event.cjs (deep-scan 2026-07-07)
    if (fv) { if (fv.agent_registered === false) n._unregistered = true; if (fv.dispatch_unverified) n._noDispatch = true; if (fv.proof_verified === false) n._proofUnverified = true; }
    const t = e.event_type;
    if (String(e.status || '').toLowerCase().includes('internal') || String(e.role || '').toLowerCase() === 'internal' || String(e.attribution || '').toLowerCase() === 'internal') n.internal = true;
    if (e.note) n.notes.push({ ts: e.timestamp, text: e.note, evidence: e.evidence });
    if (e.output) { n.outputs.push({ ts: e.timestamp, text: e.output, evidence: e.evidence }); }
    if (e.decision_summary) n.decision = e.decision_summary; if (e.summary) n.decision = e.summary;
    if (e.next_action) n.nextAction = e.next_action;
    if (e.evidence) n.evidence = e.evidence;
    (e.files_read || []).forEach((f) => n.filesRead.add(fileName(f)));
    (e.files_changed || []).forEach((f) => n.filesChanged.add(fileName(f)));
    if (['agent_started', 'subagent_started', 'run_started', 'codex_review_started', 'fix_started', 'retest_started', 'lead_review_started', 'rework_started', 'merge_started'].includes(t)) n._hasStart = true;
    if (['agent_completed', 'subagent_completed', 'run_completed', 'report_generated', 'final_output_created', 'quality_gate_passed', 'lead_review_completed', 'rework_completed', 'fix_completed', 'retest_completed', 'merge_completed', 'codex_review_completed', 'mission_blueprint_created', 'role_map_created'].includes(t)) n._hasDone = true;
    if (['agent_started', 'subagent_started', 'agent_progress', 'agent_note', 'agent_output', 'subagent_output_created', 'file_read', 'file_changed', 'command_run', 'skill_loaded', 'agent_artifact_created', 'subagent_artifact_created', 'final_output_created', 'check_started', 'codex_review_started', 'fix_started', 'lead_review_started', 'rework_started', 'merge_started'].includes(t)) n._hasActivity = true;
    if (t === 'agent_failed' || t === 'subagent_failed' || t === 'codex_blocked') n._failed = true;
    if (t === 'agent_work_package_created' || t === 'custom_subagent_created') { const wp = e.work_package || e; n._wpStatus = statusClass(e.status || wp.status || 'previewing');
      n.wp = { mission: wp.mission, inputs: wp.inputs || [], allowed_actions: wp.allowed_actions || [], not_allowed: wp.not_allowed || [], output_artifact: wp.output_artifact || wp.artifact_path, evidence_required: wp.evidence_required || [], handoff: wp.handoff || wp.handoff_target, success_criteria: wp.success_criteria, rework_criteria: wp.rework_criteria, why: wp.why || wp.why_needed, skill: wp.skill || wp.method, skill_source: wp.skill_source || wp.skill_src, status: e.status || wp.status || 'previewing' };
      if (wp.mission) n.mission = wp.mission; if (n.wp.why) n.why = n.wp.why; if (t === 'custom_subagent_created') n.custom = true; }
    if (t === 'custom_subagent_created') n.custom = true;
    if (t === 'skill_assigned') { if (!n.wp) n.wp = { inputs: [], allowed_actions: [], not_allowed: [], evidence_required: [] }; n.wp.skill = e.skill || n.wp.skill; n.wp.skill_source = e.skill_source || e.skill_src || n.wp.skill_source; }
    if (t === 'custom_skill_created') n.customSkills.push({ ts: e.timestamp, skill: e.skill || e.name, path: e.path, note: e.note });
    if (t === 'mission_packet_created' || t === 'mission_blueprint_created') { n.mission = e.expanded_mission || e.mission || n.mission; n.blueprint = true; }
    if (t === 'agent_artifact_created' || t === 'subagent_artifact_created' || t === 'final_output_created') n.artifacts.push({ ts: e.timestamp, artifact: e.artifact || e.output_artifact || e.artifact_path, path: e.path || e.artifact_path, kind: e.artifact_kind || (t === 'final_output_created' ? 'final' : 'artifact'), note: e.note });
    if (t === 'agent_handoff') n.handoffs.push({ ts: e.timestamp, to: e.to || e.handoff_to || e.handoff, note: e.note });
    if (t === 'rework_task_created') { const tk = { ts: e.timestamp, issue: e.issue || e.note, severity: e.severity, reason: e.reason, fix: e.required_fix || e.fix, target: e.target || e.to || e.agent }; n.reworks.push(tk); }
    if (t === 'codex_finding') n.findings.push({ ts: e.timestamp, severity: e.severity, area: e.area || e.category, issue: e.issue || e.note, file: e.file });
    if (e.task && BACKBONE.has(t) && t !== 'mission_packet_created') n.title = e.task;
    if (BACKBONE.has(t)) n._btypes.add(t);
    if (!BACKBONE.has(t)) { const msg = e.note || e.output || e.decision_summary || e.summary || e.task || (e.files_changed && e.files_changed.length ? e.files_changed.map(fileName).join(', ') : '') || e.command || e.artifact || e.issue || e.status || t;
      // Fix 1: a paired terminal event closes its agent's EARLIEST still-open task from the matching
      // *_started event (same task entry, status/ts/evIdx updated) instead of pushing a second entry.
      // A start with no terminal (or a terminal with no open start) is pushed/left as its own honest entry.
      const startType = TASK_PAIR_TERMINAL_TO_START[t];
      const openTask = startType && n.tasks.find((tk) => !tk._closed && tk.event && tk.event.event_type === startType);
      if (openTask) { openTask.status = nodeState(e); openTask.evIdx = idx; openTask.ts = e.timestamp; openTask._closed = true; }
      else n.tasks.push({ id: 't:' + idx, evIdx: idx, parent: key, status: nodeState(e), title: trunc(msg, 30), event: e, ts: e.timestamp }); }
  });
  const runCompleted = replayAtLive() && (STATE.run.status || '').toLowerCase() === 'completed';
  for (const n of map.values()) {
    n.group = groupBandOf(n); if (n.title === n.key && n.role) n.title = n.role; if (n.wp && n.wp.mission && !n.mission) n.mission = n.wp.mission;
    const taskRunning = n.tasks.some((t) => t.status === 'running');
    const tasksAllDone = n.tasks.length > 0 && n.tasks.every((t) => t.status === 'done' || t.status === 'internal');
    if (n.internal) n.status = 'internal';
    else if (n._failed) n.status = 'failed';
    else if (n._hasDone) n.status = 'done';
    else if (n._hasStart) n.status = 'running'; // started but no completion signal yet — never infer 'done' (honesty); run_completed repaint finishes truly-running work
    else if (n._wpStatus) n.status = n._wpStatus;
    else if (n.tasks.length) n.status = tasksAllDone ? 'done' : (taskRunning ? 'running' : 'waiting');
    else n.status = 'waiting';
    if (n.status === 'running' && n._lastEvWaiting && n._lastEvType === 'agent_progress') n.status = 'waiting';
    n.runtime = ['ecc-agent', 'ecc-skill', 'codex', 'native', 'internal'].find((r) => n._runtimes.has(r)) || (n.internal ? 'internal' : '');
  }
  // run_completed only finishes work that was actually RUNNING — never repaint previewing/waiting/never-run agents as done (honesty)
  if (runCompleted) for (const n of map.values()) { if (n.status === 'running') n.status = 'done'; for (const t of n.tasks) if (t.status === 'running') t.status = 'done'; }
  // Fix 3 (claims-vs-tasks mismatch, honesty): an agent can end up 'done' while one of its own logged
  // sub-tasks is still open (e.g. agent_completed fired but a check_started never got a terminal event).
  // Status logic above is unchanged — this only flags the gap so it's visible instead of hidden.
  for (const n of map.values()) n._claimMismatch = n.status === 'done' && n.tasks.length > 0 && n.tasks.some((t) => t.status !== 'done' && t.status !== 'internal');
  return order.map((k) => map.get(k));
}
function eccSummary() { // honest ECC status derived from real mode config + events/nodes
  const m = STATE.eccMode || { normal: 'on', full_test: 'off' };
  const ev = visibleEvents(); const nodes = STATE._nodes;
  const isEcc = (r) => r === 'ecc-agent' || r === 'ecc-skill';
  const selected = nodes.filter((n) => isEcc(n.runtime)).map((n) => n.key);
  const invoked = nodes.filter((n) => isEcc(n.runtime) && (n._hasStart || n._hasActivity || n._hasDone)).map((n) => n.key);
  const skills = nodes.filter((n) => n.runtime === 'ecc-skill').map((n) => n.key);
  const nativeFallback = ev.some((e) => e.event_type === 'native_fallback_used'); // a real ECC->native fallback, not just any native agent
  const blockedEv = ev.filter((e) => e.event_type === 'ecc_blocked' || e.event_type === 'ecc_agent_failed');
  const blockedReason = blockedEv.length ? (blockedEv[blockedEv.length - 1].note || blockedEv[blockedEv.length - 1].reason || 'ECC blocked') : '';
  const eccEvents = ev.some((e) => String(e.event_type).indexOf('ecc') === 0) || selected.length > 0;
  let state = 'off';
  if (String(m.full_test).toLowerCase() === 'on') state = 'test';
  else if (blockedReason && !invoked.length) state = 'blocked';
  else if (String(m.normal).toLowerCase() === 'on') state = 'normal';
  return { state, normal: m.normal, full_test: m.full_test, attempted: eccEvents, selected, invoked, skills, nativeFallback, blockedReason };
}
function progress() { let total = 0, done = 0; // always computed from real node/task completion — no forced 100%
  for (const n of STATE._nodes) { if (n.internal) continue; total++; if (n.status === 'done') done++; for (const t of n.tasks) { total++; if (t.status === 'done') done++; } }
  return total ? Math.round(done / total * 100) : 0; }

/* ---------- node classification + badges (Lead-Agent studio FLOW) ---------- */
// match on role AND key (a role like "independent review" must not hide a key like "codex-reviewer")
function _rk(n) { return (String(n.role || '') + ' ' + String(n.key || '')).toLowerCase(); }
function isLeadNode(n) { return /lead|orchestr|integrat/.test(_rk(n)); }
function isCodexNode(n) { return /codex/.test(_rk(n)); }
function isReportNode(n) { return n.group === 'report' || /report.?writer|deliver|final.?output/.test(_rk(n)); }
function isPreflight(n) { if (isLeadNode(n)) return false; // setup/context — kept OUT of the main subagent row
  const k = String(n.key || '').toLowerCase(), r = String(n.role || '').toLowerCase();
  if (n.group === 'context') return true;
  return /forge-router|memory-loader|project-scan|ecc-mode|forge-core|task-history|dashboard-status|project-identity|skill-runner/.test(k) || /^rout|routing/.test(r); }
function isSubagentNode(n) { return !isPreflight(n) && !isLeadNode(n) && !isCodexNode(n) && !isReportNode(n); }
// honest runtime badge — compact on node, full words in inspector/report
function runtimeBadge(n) { const rt = n.runtime; const inv = n._hasStart || n._hasActivity || n._hasDone; let text = '', full = '';
  if (rt === 'ecc-agent') { text = inv ? 'ECC ✓' : 'ECC'; full = inv ? 'ECC REAL INVOKED' : 'ECC AGENT (selected)'; }
  else if (rt === 'ecc-skill') { text = 'ECC SKILL'; full = 'ECC SKILL LOADED'; }
  else if (rt === 'native') { text = 'NATIVE'; full = 'NATIVE FALLBACK'; }
  else if (rt === 'codex') { const proven = n._hasDone; text = proven ? 'CODEX ✓' : (inv ? 'CODEX…' : 'CODEX'); full = proven ? 'CODEX REAL INVOKED' : (inv ? 'CODEX RUNNING (not completed)' : 'CODEX'); } // ✓ only on real completion — started alone is not proof (Codex finding)
  else if (rt === 'internal' || n.internal) { text = 'INTERNAL'; full = 'INTERNAL ONLY'; }
  if (n.custom) { text = '✦' + (text ? ' ' + text : ' CUSTOM'); full = 'CUSTOM ROLE' + (full ? ' · ' + full : ''); }
  // HONESTY (deep-scan 2026-07-07): make fakes visible — an unregistered name, or a "subagent" with no
  // real Agent-tool dispatch proof, is flagged so a solo session can't pass logged events off as a real swarm.
  if (n._unregistered) { text = '⚠ UNREG' + (text ? ' ' + text : ''); full = 'UNREGISTERED NAME — not a permanent Boss (agent-registry.json)' + (full ? ' · ' + full : ''); }
  else if (n._noDispatch && (n._hasStart || n._hasDone) && rt !== 'internal' && !n.internal) { text = '⚠ UNVERIFIED' + (text ? ' ' + text : ''); full = 'NO DISPATCH PROOF — logged, not a proven Agent-tool subagent' + (full ? ' · ' + full : ''); }
  if (n._proofUnverified) { full = (full ? full + ' · ' : '') + '⚠ contains UNVERIFIED proof (no command/output/screenshot)'; }
  return { text, full }; }
// honest project-governance status (project CLAUDE.md + project-local custom skills) from real events
function governanceSummary() { const ev = visibleEvents(); const has = (t) => ev.some((e) => e.event_type === t);
  let claudeMd = '—';
  if (has('claude_md_conflict_detected')) claudeMd = 'conflict — see report';
  else if (has('claude_md_created')) claudeMd = 'created';
  else if (has('claude_md_updated')) claudeMd = 'updated (safe-merge)';
  else if (has('claude_md_checked')) claudeMd = 'existed · no change';
  const skillMap = new Map();
  ev.forEach((e) => { if (String(e.event_type).indexOf('custom_skill_') !== 0) return; const k = e.skill || e.name || e.agent || 'skill';
    const st = { custom_skill_created: 'created', custom_skill_updated: 'updated', custom_skill_used: 'used', custom_skill_skipped: 'skipped', custom_skill_conflict_detected: 'conflict' }[e.event_type] || 'seen';
    const prev = skillMap.get(k); skillMap.set(k, (prev && /created|updated|conflict/.test(prev)) ? prev : st); });
  const skills = [...skillMap.entries()].map(([name, status]) => ({ name, status }));
  const registry = has('skill_registry_conflict_detected') ? 'conflict' : has('skill_registry_updated') ? 'updated' : has('skill_registry_created') ? 'created' : has('skill_registry_checked') ? 'checked' : '—';
  return { claudeMd, skills, registry, created: skills.filter((s) => s.status === 'created' || s.status === 'updated').length, used: ev.filter((e) => e.event_type === 'custom_skill_used').length }; }

// granular, honest Codex state (v7.1) from real events — never claims proof without output
function codexStatus() { const ev = visibleEvents(); const find = (t) => ev.filter((e) => e.event_type === t);
  const reason = (arr) => arr.map((e) => String(e.reason || e.note || '').toLowerCase()).join(' ');
  const blocked = find('codex_retry_blocked').concat(find('codex_blocked'));
  const rGate = reason(find('codex_trust_gate_detected')) + ' ' + reason(find('codex_interactive_retry_required')); // trust/tty only from gate events
  const rAll = reason(blocked) + ' ' + rGate; // for no-git/no-output/not-available across all blocked reasons
  const done = (STATE.run.status || '').toLowerCase() === 'completed';
  // REAL INVOKED requires a real completion event — a finding alone is not proof.
  // Order-aware: a successful review/retry that happens AFTER the last block/trust-gate clears the blocked state.
  const lastIdx = (types) => { let i = -1; ev.forEach((e, k) => { if (types.includes(e.event_type)) i = k; }); return i; };
  const successIdx = lastIdx(['codex_review_completed', 'codex_retry_completed']);
  const blockIdx = lastIdx(['codex_blocked', 'codex_retry_blocked', 'codex_trust_gate_detected', 'codex_interactive_retry_required']);
  if (successIdx !== -1 && (blockIdx === -1 || successIdx > blockIdx)) return { state: 'done', label: 'CODEX REAL INVOKED' };
  if (/not.?available|no codex|command not found|unavail/.test(rAll)) return { state: 'failed', label: 'CODEX NOT AVAILABLE' };
  if (/no.?git|not a git|outside a git/.test(rAll)) return { state: 'failed', label: 'CODEX BLOCKED: NO GIT' };
  if (find('codex_trust_gate_detected').length || find('codex_interactive_retry_required').length || /trust|tty|interactiv|headless/.test(rGate)) return { state: 'failed', label: 'CODEX BLOCKED: TRUST/TTY' };
  if (/no.?output|empty output/.test(rAll)) return { state: 'failed', label: 'CODEX BLOCKED: NO OUTPUT' };
  if (blocked.length) return { state: 'failed', label: 'CODEX BLOCKED' };
  if (ev.some((e) => e.event_type === 'native_fallback_used' && /codex|review/.test(String(e.note || e.agent || '').toLowerCase()))) return { state: 'internal', label: 'CODEX FALLBACK USED' };
  if (find('codex_not_invoked').length) return { state: 'internal', label: 'CODEX NOT INVOKED' };
  if (!done && ev.some((e) => String(e.event_type).indexOf('codex') === 0)) return { state: 'running', label: 'CODEX RUNNING' };
  return { state: 'previewing', label: 'CODEX —' }; }

// readable category label for a subagent (replaces NP-style prefixes)
function categoryLabel(role, key, custom) { const s = (String(role || '') + ' ' + String(key || '')).toLowerCase();
  const map = [[/codex/, 'CODEX'], [/lead|orchestr|integrat/, 'LEAD'], [/report|deliver|docs?.?writer|documentation/, 'REPORT'],
    [/mobile|responsiv/, 'MOBILE'], [/front.?end/, 'FRONTEND'], [/perf|optimi[sz]|speed|seo|web.?vital|lighthouse/, 'OPTIMIZE'],
    [/access|a11y|aria/, 'ACCESSIBILITY'], [/design|ui.?ux|\bux\b|visual|brand|typograph/, 'DESIGN'],
    [/\bqa\b|test|tdd|e2e|screenshot|browser/, 'QA'], [/review|critic|\bgate\b|security|audit|vuln/, 'REVIEW'],
    [/n8n|workflow|webhook|node config|expression/, 'N8N'], [/rag|retrieval|embedding|chatbot|knowledge|ingest/, 'RAG'],
    [/scrap|crawl|harvest/, 'SCRAPE'], [/predict|forecast|odds|betting|sports|backtest/, 'PREDICT'],
    [/feature|booking|calendar|payment|stripe|chat|widget|email|telegram/, 'FEATURE'], [/product|requirement/, 'PRODUCT'],
    [/\bdata\b|provider|pipeline|cleaning|schema/, 'DATA'], [/backend|\bapi\b|server|auth|database|migration/, 'BACKEND'],
    [/plan|architect/, 'PLAN'], [/code|writer|build|refactor|command.?runner|logger/, 'CODE'], [/context|scan|memory|router/, 'CONTEXT']];
  for (const [re, lbl] of map) if (re.test(s)) return custom ? 'CUSTOM·' + lbl : lbl;
  return custom ? 'CUSTOM' : 'SPECIALIST'; }

/* ---------- top bar ---------- */
let _prevAnnounce = '';
function buildId() { const id = (STATE.run && STATE.run.run_id) || ''; if (!id) return '—'; const m = id.replace(/^[^0-9]*/, '').replace(/-/g, '.'); return m || id; }
function renderTop() {
  const run = STATE.run || {}; const st = (run.status || '').toLowerCase();
  const dot = $('state-dot'), tdot = $('title-dot'), txt = $('state-text');
  const T = (k, f) => (window.i18nt ? window.i18nt(k, f) : f);
  if (st === 'running') { dot.className = tdot.className = 'dot run'; txt.textContent = T('run.building', 'BUILDING'); }
  else if (st === 'completed') { dot.className = tdot.className = 'dot done'; txt.textContent = T('run.complete', 'COMPLETE'); }
  else if (st === 'failed') { dot.className = tdot.className = 'dot fail'; txt.textContent = T('run.failed', 'FAILED'); }
  else if (st === 'armed') { dot.className = tdot.className = 'dot'; txt.textContent = T('run.armed', 'ARMED — AWAITING START'); }
  else { dot.className = tdot.className = 'dot'; txt.textContent = T('run.idle', 'IDLE'); }
  const last = STATE.events.length ? STATE.events[STATE.events.length - 1].timestamp : run.started;
  $('state-ago').textContent = last ? ago(last) : '—';
  $('build-id').textContent = buildId();
  const proj = STATE.meta.name || 'FORGE'; const title = run.request ? (proj + ' / ' + run.request) : (proj || 'FORGE CONTROL CENTER');
  $('proj-title').textContent = trunc(title, 70).toUpperCase();
  // Fix 4c: a completed-run badge must never show COMPLETE while scrubbing a partial replay slice.
  const liveCompleted = st === 'completed' && replayAtLive();
  $('badge-complete').hidden = !liveCompleted; $('tp-check').hidden = !liveCompleted;
  const lvl = run.complexity || run.quality_target || run.project_type || ''; const lb = $('level-badge');
  if (lvl) { lb.hidden = false; lb.textContent = String(lvl).toUpperCase(); } else lb.hidden = true;
  const nodes = STATE._nodes;
  // "engaged" counts only VERIFIED activity — unregistered names + unproven dispatches don't inflate the headline (honesty)
  const isUnverified = (n) => n._unregistered || (n._noDispatch && isSubagentNode(n) && n.runtime !== 'internal' && !n.internal);
  const engaged = nodes.filter((n) => (n._hasStart || n._hasActivity || n._hasDone) && !isUnverified(n)).length;
  const unverifiedCount = nodes.filter(isUnverified).length;
  const files = new Set(); for (const n of nodes) n.filesChanged.forEach((f) => files.add(f));
  $('s-events').textContent = STATE.events.length; $('s-agents').textContent = engaged + '/' + nodes.length + (unverifiedCount ? ' ⚠' + unverifiedCount : ''); $('s-files').textContent = files.size; $('s-port').textContent = STATE.meta.port || '—';
  const sa = $('s-agents'); if (sa) sa.title = unverifiedCount ? (unverifiedCount + ' node(s) UNVERIFIED — unregistered name or no Agent-tool dispatch proof (logged, not a proven subagent)') : 'verified engaged agents / total nodes';
  const ecc = eccSummary(); const eb = $('ecc-badge');
  if (eb) { eb.className = 'ecc-badge ' + ecc.state; eb.textContent = 'ECC ' + ({ normal: 'NORMAL', test: 'FULL TEST', blocked: 'BLOCKED', off: 'OFF' }[ecc.state] || 'OFF'); eb.title = ecc.blockedReason || ('ECC Normal Mode ' + (ecc.normal || 'on').toUpperCase() + ' · Full Test ' + (ecc.full_test || 'off').toUpperCase()); }
  const sm = String((STATE.session && STATE.session.mode) || 'off').toLowerCase(); const sb = $('session-badge');
  if (sb) { const on = sm === 'on' || sm === 'active'; const paused = sm === 'paused'; sb.hidden = !(on || paused); sb.className = 'session-badge ' + (on ? 'on' : paused ? 'paused' : 'off'); sb.textContent = on ? 'FORGE SESSION' : 'FORGE PAUSED'; sb.title = 'Forge Session Mode: ' + sm; }
  // project isolation visibility (root + run id always shown so the served project is unmistakable)
  const iso = STATE.meta.isolation || 'OK'; const ib = $('iso-badge');
  if (ib) { const bad = iso !== 'OK'; ib.hidden = !bad; if (bad) { ib.className = 'iso-badge bad'; ib.textContent = '⚠ ' + iso; ib.title = 'Project isolation: ' + iso + ' — dashboard may be showing stale/cross-project state; check /api/health'; } }
  const pill = $('proj-title'); if (pill) pill.title = 'Project: ' + (STATE.meta.name || '') + ' · root: ' + (STATE.meta.dir || '') + ' · port: ' + (STATE.meta.port || '') + ' · run: ' + ((STATE.run && STATE.run.run_id) || '—') + ' · isolation: ' + iso;
  const src = $('sb-source'); if (src) { src.textContent = (iso !== 'OK' ? '⚠ ' + iso + ' · ' : '') + (STATE.meta.name || 'project') + ' · ' + (STATE.meta.dir || '') + ' · port ' + (STATE.meta.port || '—') + ' · run ' + ((STATE.run && STATE.run.run_id) || '—'); src.style.color = iso !== 'OK' ? 'var(--st-fail)' : ''; }
  $('sb-counts').textContent = (CURRENT_MODEL.nodes.length || nodes.length) + ' nodes · ' + STATE.events.length + ' events';
  const msg = (run.request || 'run') + ' — ' + (st || 'idle') + ', ' + STATE.events.length + ' events';
  if (msg !== _prevAnnounce) { _prevAnnounce = msg; const a = $('sr-announce'); if (a) a.textContent = msg; }
}

/* ---------- data ---------- */
async function fetchState() {
  try { const r = await fetch('/api/state', { cache: 'no-store' }); const s = await r.json();
    STATE.meta = { name: s.project.name, dir: s.project.dir, id: (s.project && s.project.id) || '', isolation: (s.project && s.project.isolation) || 'OK', port: s.port }; STATE.memory = s.memory || {}; STATE.runs = (s.runs || []).length; STATE.eccMode = s.ecc_mode || STATE.eccMode; STATE.session = s.session || STATE.session; STATE.bosses = s.bosses || []; STATE.prds = s.prds || []; STATE.mindmaps = s.mindmaps || []; STATE.tickets = s.tickets || []; STATE.artifacts = s.artifacts || []; STATE.doctor = s.doctor || null; STATE.bossAgents = s.boss_agents || [];
    STATE.settings = Object.assign(STATE.settings, s.settings || {});
    if (s.latest) { STATE.run = s.latest.run || {}; STATE.events = canonEvents(s.latest.events || []); STATE.report = s.latest.report; STATE.malformed = s.latest.malformed || 0; }
    else { STATE.run = {}; STATE.events = []; }
    // ?run=<id> — pin a specific historical run instead of the latest (Mission Control 2026-07-09: view any run).
    const pinned = new URLSearchParams(location.search).get('run');
    if (pinned && /^[A-Za-z0-9_-]+$/.test(pinned)) {
      try { const rr = await fetch('/api/run/' + encodeURIComponent(pinned), { cache: 'no-store' });
        if (rr.ok) { const one = await rr.json(); if (one && one.run) { STATE.run = one.run; STATE.events = canonEvents(one.events || []); STATE.report = one.report; STATE.malformed = one.malformed || 0; } } } catch {}
    }
    return true;
  } catch { return false; }
}
let es = null, sseFails = 0, openedOnce = false, polling = null;
function setLive(mode, text) { const el = $('live'); if (!el) return; el.className = 'live ' + mode; $('live-text').textContent = text; }
function connectSSE() {
  if (typeof EventSource === 'undefined') { startPolling('SSE unsupported'); return; }
  setLive('', 'connecting…'); es = new EventSource('/api/events/stream');
  es.onopen = () => { openedOnce = true; sseFails = 0; setLive('on', 'LIVE'); };
  es.addEventListener('run', (m) => { try { const d = JSON.parse(m.data); STATE.run = d.run || {}; STATE.events = []; STATE._prevCount = 0; STATE.malformed = d.malformed || 0; STATE.runs = d.runs || STATE.runs;
    STATE.replay = { active: false, playing: false, cursor: 0, speed: STATE.replay.speed || 1 }; if (typeof replayStop === 'function') replayStop(); // a new run → back to live; clear any replay cursor
    renderAll(); } catch {} });
  es.addEventListener('events', (m) => { try { const d = JSON.parse(m.data); if (d.events && d.events.length) { STATE.events = STATE.events.concat(canonEvents(d.events)); STATE.malformed = d.malformed || STATE.malformed; renderAll(); } } catch {} });
  es.addEventListener('report', (m) => { try { const d = JSON.parse(m.data); if (d.report) STATE.report = d.report; renderDock && renderDock(); } catch {} });
  es.addEventListener('ping', () => {});
  es.onerror = () => { if (!openedOnce) { sseFails++; if (sseFails >= 3) { es.close(); startPolling('SSE unavailable'); return; } } setLive('off', 'reconnecting…'); };
}
function startPolling(reason) { if (polling) return; const iv = STATE.settings.fast_mode ? 100 : (STATE.settings.polling_interval_ms || 250);
  setLive('poll', 'POLL ' + iv + 'ms'); polling = setInterval(async () => { if (await fetchState()) renderAll(); }, iv); }

window.Forge = Object.assign(window.Forge || {}, { buildNodes, agentColor, roleOf, nodeState, statusClass, taskStatus, statusLabel, SYNTH, trunc, esc, hhmmss,
  visibleEvents, replayAtLive, isPreflight, isSubagentNode, isLeadNode, isCodexNode, isReportNode, runtimeBadge, codexStatus, categoryLabel, governanceSummary });
