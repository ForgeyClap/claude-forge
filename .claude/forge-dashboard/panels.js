'use strict';
/* Forge Control Center — workbench panels: agent-groups sidebar, work-package inspector (tabs),
   live activity feed, bottom dock tabs, summary metrics. Pure render fns; wiring lives in graph.js. */

function kv(k, v, cls) { return '<div class="kv"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + esc(v == null || v === '' ? '—' : v) + '</div></div>'; }
function snItem(o) { return '<div class="sn-item"><div class="ts">' + esc(hhmmss(o.ts)) + '</div><div class="tx">' + esc(o.text) + '</div>' + (o.evidence ? '<div class="ev">✔ ' + esc(o.evidence) + '</div>' : '') + '</div>'; }
function liList(arr, mark) { if (!arr || !arr.length) return '<div class="sn-empty">none</div>'; return arr.map((x) => '<div class="sn-li ' + (mark === 'no' ? 'no' : '') + '">' + esc(typeof x === 'string' ? x : fileName(x)) + '</div>').join(''); }
function stChip(state) { return '<span class="st-chip ' + state + '">' + esc(statusLabel(state)) + '</span>'; }

/* ---------- sidebar: agent groups ---------- */
function renderSidebar() {
  const nodes = STATE._nodes; const wrap = $('sb-groups'); if (!wrap) return;
  $('sb-agent-count').textContent = nodes.length;
  let html = '';
  for (const g of GROUP_ORDER) {
    const list = nodes.filter((n) => n.group === g); if (!list.length) continue;
    const collapsed = STATE.ui.collapsed.has(g);
    html += '<div class="sb-group ' + (collapsed ? 'collapsed' : '') + '" data-g="' + g + '">'
      + '<div class="sb-ghead" data-toggle="' + g + '"><span class="caret">▼</span>' + esc(GROUP_LABEL[g]) + '<span class="sb-gcount">' + list.length + '</span></div>'
      + '<div class="sb-rows">' + list.map((n) => '<div class="sb-row ' + (selRef.refKey === n.key ? 'sel' : '') + '" data-agent="' + esc(n.key) + '"><span class="sd ' + n.status + '"></span>' + esc(n.key) + '</div>').join('') + '</div></div>';
  }
  wrap.innerHTML = html || '<div class="sn-empty" style="padding:10px 13px">no agents yet</div>';
  const leg = $('status-legend');
  if (leg && !leg.dataset.done) { leg.dataset.done = '1';
    const L = [['running', 'Running'], ['done', 'Completed'], ['waiting', 'Waiting'], ['previewing', 'Previewing'], ['failed', 'Failed'], ['internal', 'Internal only']];
    leg.innerHTML = L.map(([s, t]) => '<span class="lg"><span class="sd ' + s + '"></span>' + t + '</span>').join('');
  }
}

/* ---------- inspector: SELECTED AGENT (9 tabs) ---------- */
const INS_TABS = [['summary', 'Summary'], ['wp', 'Work Package'], ['notes', 'Notes'], ['inputs', 'Inputs'], ['files', 'Files'], ['output', 'Output'], ['evidence', 'Evidence'], ['handoff', 'Handoff'], ['events', 'Events']];
function selectedAgentNode() {
  if (selRef.refKey) { const n = STATE._nodes.find((x) => x.key === selRef.refKey); if (n) return n; }
  if (selRef.refEvIdx != null) { const e = STATE.events[selRef.refEvIdx]; if (e) { const k = e.agent || SYNTH[e.event_type]; const n = STATE._nodes.find((x) => x.key === k); if (n) return n; } }
  return null;
}
function renderInspector() {
  const n = selectedAgentNode(); const tabsEl = $('ins-tabs'), body = $('ins-body'), titleEl = $('ins-agent'), chip = $('ins-status'); if (!body) return;
  if (!n) { titleEl.textContent = 'SELECTED AGENT'; chip.hidden = true; tabsEl.innerHTML = ''; body.innerHTML = '<div class="sn-empty">Select an agent to inspect it.</div>'; return; }
  const c = agentColor(n.key, n.role); titleEl.textContent = n.key; chip.hidden = false; chip.className = 'st-chip ' + n.status;
  chip.textContent = statusLabel(n.status) + (n._claimMismatch ? ' ⚠' : ''); // Fix 3c: claims-done-but-open-task mismatch, same text convention as ⚠ UNREG
  tabsEl.innerHTML = INS_TABS.map(([id, lbl]) => '<button role="tab" data-itab="' + id + '" aria-selected="' + (STATE.ui.insTab === id) + '">' + lbl + '</button>').join('');
  const tab = STATE.ui.insTab; const doneT = n.tasks.filter((t) => t.status === 'done').length; let h = '';
  const head = '<div class="sn-cat"><span class="gl" style="color:' + c.solid + '">' + c.glyph + '</span> ' + esc((n.role || c.label).toUpperCase()) + (n.derived ? '<span class="derived">derived</span>' : '') + '</div>';
  const rtFull = (Forge.runtimeBadge ? Forge.runtimeBadge(n).full : '') || (n.runtime || '—');
  // rework attribution: match the TARGET agent (target/to), not only the reporter (agent)
  const hits = (t, e) => e.event_type === t && (e.target === n.key || e.to === n.key || e.agent === n.key);
  const reworkDone = STATE.events.some((e) => hits('rework_completed', e));
  const reworkAsked = n.reworks.length || STATE.events.some((e) => hits('rework_task_created', e) || hits('rework_assigned', e));
  const retestEv = STATE.events.filter((e) => (e.event_type === 'retest_completed' || e.event_type === 'check_passed' || e.event_type === 'check_failed') && e.agent === n.key);
  const retestTxt = retestEv.length ? (retestEv.some((e) => e.event_type === 'check_failed') ? 'failed' : 'passed') : '—';
  const handoffTxt = (n.wp && n.wp.handoff) || (n.handoffs[0] && n.handoffs[0].to) || '—';
  if (tab === 'summary') {
    h = head + kv('role', (n.custom ? 'CUSTOM · ' : '') + (n.role || c.label)) + kv('status', statusLabel(n.status)) + kv('runtime', rtFull)
      + (n.wp && n.wp.skill ? kv('skill / source', n.wp.skill + (n.wp.skill_source ? ' · ' + n.wp.skill_source : '')) : '')
      + kv('mission', n.mission || n.title) + kv('why selected', n.why)
      + kv('current task', n.title) + kv('sub-steps', n.tasks.length ? (doneT + ' / ' + n.tasks.length + ' done') : 'none')
      + kv('files read', n.filesRead.size) + kv('files changed', n.filesChanged.size)
      + kv('rework', reworkAsked ? (reworkDone ? 'assigned → completed ✓' : 'assigned (open)') : 'none') + kv('retest', retestTxt) + kv('handoff', handoffTxt)
      + kv('attribution', n._unregistered ? '⚠ UNREGISTERED name (not a permanent Boss)' : (n._noDispatch && (n._hasStart || n._hasDone) && n.runtime !== 'internal' && !n.internal) ? '⚠ UNVERIFIED — logged, no Agent-tool dispatch proof' : n.derived ? 'derived from event log' : (n.runtime === 'internal' || n.internal) ? 'internal role (main session)' : 'agent-tagged (real dispatch requires runtime + dispatch_id)', (n._unregistered || n._noDispatch || n.derived) ? 'dim' : '')
      + kv('last active', n.lastTs ? ago(n.lastTs) : '—');
    if (n.decision) h += '<div class="sn-block"><div class="lbl">latest reasoning summary</div><div class="sn-item"><div class="tx">' + esc(n.decision) + '</div></div></div>';
    if (n.nextAction) h += '<div class="sn-block"><div class="lbl">next action</div><div class="sn-item"><div class="tx">' + esc(n.nextAction) + '</div></div></div>';
    if (n.reworks && n.reworks.length) h += '<div class="sn-block"><div class="lbl">rework tasks (' + n.reworks.length + ')</div>' + n.reworks.map((r) => '<div class="sn-item"><div class="ts">' + esc((r.severity || '').toUpperCase()) + '</div><div class="tx">' + esc(r.issue || r.fix || 'rework') + '</div></div>').join('') + '</div>';
    if (n.customSkills && n.customSkills.length) h += '<div class="sn-block"><div class="lbl">custom skills created (' + n.customSkills.length + ')</div>' + n.customSkills.map((s) => '<div class="sn-item"><div class="tx">' + esc(s.skill || s.path) + '</div>' + (s.path ? '<div class="ev">✔ ' + esc(s.path) + '</div>' : '') + '</div>').join('') + '</div>';
  } else if (tab === 'wp') {
    if (!n.wp) h = head + '<div class="sn-empty">' + (n.internal ? 'INTERNAL ROLE ONLY — conceptual role, no work package.' : 'No work package event for this agent' + (n.derived ? ' (derived).' : '.')) + '</div>';
    else { const w = n.wp; h = head + (n.custom ? kv('custom role', 'yes — ' + (n.role || c.label)) : '') + kv('mission', w.mission) + kv('skill / method', w.skill) + kv('skill source', w.skill_source) + kv('success criteria', w.success_criteria) + kv('rework criteria', w.rework_criteria) + kv('output artifact', w.output_artifact) + kv('handoff', w.handoff) + kv('runtime', rtFull) + kv('status', statusLabel(n.status))
      + '<div class="sn-block"><div class="lbl">inputs</div>' + liList(w.inputs) + '</div>'
      + '<div class="sn-block"><div class="lbl">allowed actions</div>' + liList(w.allowed_actions) + '</div>'
      + '<div class="sn-block"><div class="lbl">not allowed</div>' + (w.not_allowed && w.not_allowed.length ? w.not_allowed.map((x) => '<div class="sn-li no">' + esc(x) + '</div>').join('') : '<div class="sn-empty">—</div>') + '</div>'
      + '<div class="sn-block"><div class="lbl">evidence required</div>' + liList(w.evidence_required) + '</div>'; }
  } else if (tab === 'notes') {
    h = head + (n.notes.length ? n.notes.map(snItem).join('') : '<div class="sn-empty">No working notes logged.</div>');
  } else if (tab === 'inputs') {
    const declared = (n.wp && n.wp.inputs) || []; const readSet = n.filesRead;
    h = head + '<div class="sn-block"><div class="lbl">declared inputs</div>' + (declared.length ? declared.map((x) => { const got = [...readSet].some((f) => f && (f === x || f.indexOf(x) >= 0 || x.indexOf(f) >= 0)); return '<div class="sn-li ' + (got ? '' : 'no') + '">' + esc(x) + (got ? ' — read ✓' : '') + '</div>'; }).join('') : '<div class="sn-empty">none declared</div>') + '</div>';
  } else if (tab === 'files') {
    h = head + '<div class="sn-block"><div class="lbl">files read (' + n.filesRead.size + ')</div>' + ([...n.filesRead].length ? [...n.filesRead].map((f) => '<div class="sn-file"><span class="ar">↑</span>' + esc(f) + '</div>').join('') : '<div class="sn-empty">none</div>') + '</div>'
      + '<div class="sn-block"><div class="lbl">files changed (' + n.filesChanged.size + ')</div>' + ([...n.filesChanged].length ? [...n.filesChanged].map((f) => '<div class="sn-file"><span class="ar">↓</span>' + esc(f) + '</div>').join('') : '<div class="sn-empty">none</div>') + '</div>';
  } else if (tab === 'output') {
    h = head + kv('declared artifact', n.wp && n.wp.output_artifact);
    h += '<div class="sn-block"><div class="lbl">artifacts produced (' + n.artifacts.length + ')</div>' + (n.artifacts.length ? n.artifacts.map((a) => '<div class="sn-item"><div class="ts">' + esc(hhmmss(a.ts)) + (a.kind ? ' · ' + esc(a.kind) : '') + '</div><div class="tx">' + esc(a.artifact || a.path) + '</div></div>').join('') : '<div class="sn-empty">none produced yet</div>') + '</div>';
    if (n.outputs.length) h += '<div class="sn-block"><div class="lbl">output summaries</div>' + n.outputs.map(snItem).join('') + '</div>';
  } else if (tab === 'evidence') {
    const req = (n.wp && n.wp.evidence_required) || [];
    h = head + '<div class="sn-block"><div class="lbl">evidence required</div>' + (req.length ? req.map((x) => '<div class="sn-li">' + esc(x) + '</div>').join('') : '<div class="sn-empty">—</div>') + '</div>';
    if (n.evidence) h += kv('evidence', n.evidence);
    h += kv('runtime', rtFull) + kv('rework completed', reworkAsked ? (reworkDone ? 'yes' : 'no (open)') : 'n/a') + kv('test / retest', retestTxt) + kv('final status', statusLabel(n.status));
    const allFiles = [...n.filesRead].map((f) => ['↑', f]).concat([...n.filesChanged].map((f) => ['↓', f]));
    h += '<div class="sn-block"><div class="lbl">files (evidence) — read ' + n.filesRead.size + ' · changed ' + n.filesChanged.size + '</div>' + (allFiles.length ? allFiles.map(([ar, f]) => '<div class="sn-file"><span class="ar">' + ar + '</span>' + esc(f) + '</div>').join('') : '<div class="sn-empty">none</div>') + '</div>';
    h += '<div class="sn-block"><div class="lbl">event-backed activity (' + n.events.length + ', newest)</div>' + (n.events.length ? n.events.slice(-8).reverse().map((e) => '<div class="sn-item"><div class="ts">' + esc(hhmmss(e.timestamp) + ' · ' + e.event_type) + '</div>' + (e.evidence ? '<div class="ev">✔ ' + esc(e.evidence) + '</div>' : '') + '</div>').join('') : '<div class="sn-empty">none</div>') + '</div>';
    if (n.findings.length) h += '<div class="sn-block"><div class="lbl">findings (' + n.findings.length + ')</div>' + n.findings.map((f) => '<div class="sn-item"><div class="ts">' + esc((f.severity || '').toUpperCase()) + (f.area ? ' · ' + esc(f.area) : '') + '</div><div class="tx">' + esc(f.issue) + '</div></div>').join('') + '</div>';
  } else if (tab === 'handoff') {
    h = head + kv('declared handoff', n.wp && n.wp.handoff);
    h += '<div class="sn-block"><div class="lbl">actual handoffs (' + n.handoffs.length + ')</div>' + (n.handoffs.length ? n.handoffs.map((x) => '<div class="sn-item"><div class="ts">' + esc(hhmmss(x.ts)) + '</div><div class="tx">→ ' + esc(x.to) + (x.note ? ' · ' + esc(x.note) : '') + '</div></div>').join('') : '<div class="sn-empty">none yet</div>') + '</div>';
  } else if (tab === 'events') {
    h = head + n.events.map((e) => '<div class="sn-item"><div class="ts">' + esc(hhmmss(e.timestamp) + ' · ' + e.event_type) + '</div><div class="tx">' + esc(trunc(e.note || e.output || e.task || e.issue || e.command || (e.files_changed && e.files_changed.map(fileName).join(', ')) || '', 70)) + '</div></div>').join('');
  }
  body.innerHTML = h;
}

/* ---------- live activity feed ---------- */
const ACT_FILTERS = [['all', 'All'], ['agents', 'Agents'], ['files', 'Files'], ['checks', 'Checks'], ['errors', 'Errors']];
function actMatch(e, f) { const t = e.event_type;
  if (f === 'all') return true;
  if (f === 'agents') return !!e.agent || t.indexOf('agent') === 0;
  if (f === 'files') return t === 'file_read' || t === 'file_changed' || (e.files_changed && e.files_changed.length);
  if (f === 'checks') return /check|codex|retest|quality|fix/.test(t);
  if (f === 'errors') return t === 'check_failed' || t === 'agent_failed' || t === 'quality_gate_blocked' || (t === 'codex_finding' && /critical|high/.test(e.severity || ''));
  return true;
}
function actTag(e) { const t = e.event_type;
  if (t === 'file_read') return 'file read'; if (t === 'file_changed') return 'file'; if (t === 'command_run') return 'cmd';
  if (t === 'mission_blueprint_created' || t === 'mission_packet_created') return 'blueprint'; if (t === 'role_map_created') return 'role map';
  if (t === 'custom_subagent_created') return 'custom'; if (t.indexOf('subagent') === 0) return t.indexOf('artifact') > 0 || t.indexOf('output') > 0 ? 'artifact' : 'subagent';
  if (t.indexOf('lead_review') === 0) return 'review'; if (t.indexOf('rework') === 0) return 'rework'; if (t.indexOf('merge') === 0) return 'merge'; if (t === 'final_output_created') return 'final';
  if (t.indexOf('claude_md') === 0) return 'CLAUDE.md'; if (t === 'project_skill_dir_checked') return 'skills dir';
  if (t.indexOf('skill_registry') === 0) return 'registry'; if (t.indexOf('browser') === 0) return 'browser';
  if (t === 'skill_discovery' || t === 'skill_map_created') return 'skills'; if (t.indexOf('custom_skill') === 0) return 'skill+'; if (t === 'skill_assigned' || t === 'skill_loaded') return 'skill';
  if (t.indexOf('codex') === 0) return 'codex'; if (t.indexOf('check') === 0) return 'check'; if (t.indexOf('fix') === 0) return 'fix';
  if (t.indexOf('retest') === 0) return 'retest'; if (t.indexOf('quality') === 0) return 'gate'; if (t === 'memory_loaded' || t === 'memory_updated') return 'memory';
  if (t === 'ecc_inventory') return 'ecc'; if (t === 'agent_selected') return 'routing'; if (t === 'agent_work_package_created') return 'work pkg'; if (t === 'agent_artifact_created') return 'artifact'; if (t === 'agent_handoff') return 'handoff';
  if (t === 'owner_prefs_loaded') return 'prefs'; // WAVE B / B4: the applied-prefs ECHO
  return e.role ? String(e.role).split('/')[0] : 'event'; }
function actMsg(e) { return e.note || e.output || e.task || e.issue || e.command || e.artifact || (e.files_changed && e.files_changed.map(fileName).join(', ')) || (e.files_read && e.files_read.map(fileName).join(', ')) || e.decision_summary || e.event_type; }
function renderActivity() {
  const wrap = $('act-feed'); if (!wrap) return; const f = STATE.ui.actFilter;
  $('act-filters').innerHTML = ACT_FILTERS.map(([id, lbl]) => '<button data-actf="' + id + '" aria-selected="' + (f === id) + '">' + lbl + '</button>').join('');
  const rows = STATE.events.map((e, i) => ({ e, i })).filter((x) => actMatch(x.e, f)).slice(-40).reverse();
  wrap.innerHTML = rows.length ? rows.map(({ e, i }) => { const err = e.event_type === 'check_failed' || e.event_type === 'agent_failed' || e.event_type === 'quality_gate_blocked' || (e.event_type === 'codex_finding' && /critical|high/.test(e.severity || ''));
    return '<div class="act-row ' + (err ? 'err' : '') + '" data-ev="' + i + '"><span class="at">' + esc(hhmmss(e.timestamp)) + '</span><span class="am"><span class="aa">' + esc(e.agent || SYNTH[e.event_type] || 'system') + '</span><span class="atag">' + esc(actTag(e)) + '</span><br>' + esc(trunc(actMsg(e), 52)) + '</span></div>'; }).join('') : '<div class="sn-empty">no activity yet</div>';
}

/* ---------- agent board: the 12 permanent Bosses as live cards (WP2) ---------- */
// match a Boss (registry slug/name) to a live node in STATE._nodes — case-insensitive on both n.key
// forms Forge dispatches actually use (the Boss NAME, e.g. "Build Boss") and the registry slug (e.g. "build-boss").
function _bossMatchNode(boss, nodes) {
  const slug = String(boss.slug || '').toLowerCase(), name = String(boss.name || '').toLowerCase();
  return nodes.find((n) => { const k = String(n.key || '').toLowerCase(); return k === name || k === slug; }) || null;
}
// pure model: 12 cards, one per registry Boss — a Boss with no matched node is honestly "NOT USED" (never invented).
function agentBoardCards() {
  const bosses = STATE.bosses || []; const nodes = STATE._nodes || [];
  return bosses.map((b) => {
    const n = _bossMatchNode(b, nodes);
    if (!n) return { boss: b, node: null, used: false, status: 'unused', statusText: 'NOT USED', tasksDone: 0, tasksTotal: 0, filesChanged: 0, badge: null, honesty: [] };
    const tasksDone = n.tasks.filter((t) => t.status === 'done').length;
    const badge = (window.Forge && window.Forge.runtimeBadge) ? window.Forge.runtimeBadge(n) : { text: '', full: '' };
    const honesty = [];
    if (n._unregistered) honesty.push('UNREGISTERED NAME');
    if (n._noDispatch) honesty.push('NO DISPATCH PROOF');
    if (n._claimMismatch) honesty.push('⚠ CLAIMS DONE — ' + n.tasks.filter((t) => t.status === 'done').length + '/' + n.tasks.length + ' TASKS');
    return { boss: b, node: n, used: true, status: n.status, statusText: statusLabel(n.status), tasksDone, tasksTotal: n.tasks.length, filesChanged: n.filesChanged.size, badge, honesty };
  });
}
function renderAgentBoard() {
  const cards = agentBoardCards();
  if (!cards.length) return '<div class="sn-empty">No Boss registry found (config/agents/agent-registry.json).</div>';
  return '<div class="agentboard">' + cards.map((c) => {
    const cls = 'ab-card ab-' + (c.used ? c.status : 'unused');
    const badgeHtml = c.used && c.badge && c.badge.text ? '<span class="ab-rt" title="' + esc(c.badge.full) + '">' + esc(c.badge.text) + '</span>' : '';
    const honestyHtml = c.honesty.length ? '<div class="ab-honesty">⚠ ' + esc(c.honesty.join(' · ')) + '</div>' : '';
    const statsHtml = c.used
      ? ('<div class="ab-stats"><span>' + c.tasksDone + '/' + c.tasksTotal + ' tasks</span><span>' + c.filesChanged + ' files</span>' + badgeHtml + '</div>' + honestyHtml)
      : '<div class="ab-stats ab-dim"><span>no activity this run</span></div>';
    return '<div class="' + cls + '" data-boss="' + esc(c.boss.slug) + '">'
      + '<div class="ab-head"><span class="ab-name">' + esc(c.boss.name) + '</span><span class="ab-st ' + (c.used ? c.status : 'internal') + '">' + esc(c.statusText) + '</span></div>'
      + '<div class="ab-role">' + esc(c.boss.role) + '</div>'
      + statsHtml + '</div>';
  }).join('') + '</div>';
}

/* ---------- ticket board: every task + rework as a kanban ticket (WP3), plus persistent store tickets (WP5) ---------- */
function prettyOwner(key) { return String(key || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
// WP5: map a persistent forge-tickets/ store status onto the board vocabulary the event-derived tasks
// already use (waiting|running|previewing|failed|done), so TICKET_COLS matches both sources identically.
// Unknown/missing status -> 'waiting' (honest default: an unrecognized status is never assumed done).
function storeTicketStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active') return 'running';
  if (s === 'review' || s === 'needs_approval') return 'previewing';
  if (s === 'blocked') return 'failed';
  if (s === 'done') return 'done';
  if (s === 'open') return 'waiting';
  return 'waiting';
}
// pure model: flatten every node's tasks[] + reworks[] (event-derived, WP3) PLUS STATE.tickets (persistent
// forge-tickets/ store, WP5) into tickets — real logged/stored activity only, nothing invented. The two
// sources are different (an event-derived "task" is not the same record as a stored ticket) so they are
// never deduped — store-backed cards are labeled kind:'ticket' to keep that distinction visible.
function ticketCards() {
  const nodes = STATE._nodes || []; const out = [];
  for (const n of nodes) {
    const owner = prettyOwner(n.key);
    for (const t of n.tasks) out.push({ title: t.title, owner, status: t.status, ts: t.ts, kind: 'task' });
    for (const r of n.reworks) { const sev = String(r.severity || '').toLowerCase();
      out.push({ title: r.issue || r.fix || 'rework', owner, status: /crit|high/.test(sev) ? 'failed' : 'previewing', ts: r.ts, kind: 'rework' }); }
  }
  const storeTickets = STATE.tickets || [];
  for (const tk of storeTickets) {
    out.push({ title: tk.title || '(untitled ticket)', owner: tk.owner ? prettyOwner(tk.owner) : '—', status: storeTicketStatus(tk.status), ts: tk.created, kind: 'ticket' });
  }
  return out;
}
const TICKET_COLS = [
  ['backlog', 'Backlog', (s) => s === 'waiting'],
  ['active', 'Active', (s) => s === 'running'],
  ['review', 'Review', (s) => s === 'previewing'],
  ['blocked', 'Blocked', (s) => s === 'failed'],
  ['done', 'Done', (s) => s === 'done' || s === 'internal'],
];
function ticketCardHtml(t) {
  return '<div class="tk-card tk-' + t.kind + '"><div class="tk-title">' + esc(t.title) + '</div>'
    + '<div class="tk-meta"><span class="tk-owner">' + esc(t.owner) + '</span><span class="st-chip ' + t.status + '">' + esc(statusLabel(t.status)) + '</span></div>'
    + '<div class="tk-ts">' + esc(hhmmss(t.ts)) + '</div></div>';
}
function renderTicketBoard() {
  const tickets = ticketCards();
  const board = '<div class="ticket-board">' + TICKET_COLS.map(([id, label, match]) => {
    const items = tickets.filter((t) => match(t.status));
    return '<div class="tk-col" data-col="' + id + '"><div class="tk-chead">' + esc(label) + '<span class="tk-count">' + items.length + '</span></div>'
      + '<div class="tk-cbody">' + (items.length ? items.map(ticketCardHtml).join('') : '<div class="sn-empty tk-empty">empty</div>') + '</div></div>';
  }).join('') + '</div>';
  return board + (tickets.length ? '' : '<div class="sn-empty tk-none">no tasks or rework tickets logged for this run yet — columns above are honestly empty.</div>');
}

/* ---------- review-gate panel: 6 gates computed only from real logged events (WP4) ---------- */
function _gateLastIdx(evs, types) { let i = -1; evs.forEach((e, k) => { if (types.includes(e.event_type)) i = k; }); return i; }
// "security-flagged" codex_finding: critical/high severity AND the area/category/issue text reads security-related.
function _gateSecurityFinding(e) { if (e.event_type !== 'codex_finding') return false; const sev = String(e.severity || '').toLowerCase();
  if (!/crit|high/.test(sev)) return false; const hay = ((e.area || '') + ' ' + (e.category || '') + ' ' + (e.issue || '') + ' ' + (e.note || '')).toLowerCase();
  return /secur|vuln|auth|inject|secret|xss|csrf|crypto|owasp/.test(hay); }
// "a passed security check": a check_passed event whose task/command/output/note/agent/role reads security-related.
function _gateSecurityCheckPassed(e) { if (e.event_type !== 'check_passed') return false;
  const hay = ((e.task || '') + ' ' + (e.command || '') + ' ' + (e.output || '') + ' ' + (e.note || '') + ' ' + (e.agent || '') + ' ' + (e.role || '')).toLowerCase();
  return /secur|vuln|auth|secret|owasp/.test(hay); }
// pure model: 6 gates, each { state: pass|fail|pending|skip, evidence: one-line hint } — computed ONLY from visibleEvents(), never fabricated.
function gateVerdicts() {
  const evs = (window.Forge && window.Forge.visibleEvents) ? window.Forge.visibleEvents() : STATE.events; const g = {};
  { const passN = evs.filter((e) => e.event_type === 'check_passed').length, failN = evs.filter((e) => e.event_type === 'check_failed').length; // TESTS: literal — any failure fails the gate
    g.tests = { state: failN ? 'fail' : (passN ? 'pass' : 'pending'), evidence: (passN || failN) ? (passN + '/' + (passN + failN) + ' checks') : 'no checks logged yet' }; }
  { const pi = _gateLastIdx(evs, ['quality_gate_passed']), fi = _gateLastIdx(evs, ['quality_gate_blocked']); // BUILD: order-aware (a later pass clears an earlier block)
    const state = pi === -1 && fi === -1 ? 'pending' : (fi > pi ? 'fail' : 'pass'); const ev = state === 'fail' ? evs[fi] : (state === 'pass' ? evs[pi] : null);
    g.build = { state, evidence: ev ? (ev.reason || ev.note || (state === 'pass' ? 'quality gate passed' : 'quality gate blocked')) : 'no build gate logged yet' }; }
  { const pi = _gateLastIdx(evs, ['browser_screenshot_captured', 'browser_layout_verified']), fi = _gateLastIdx(evs, ['browser_proof_blocked']); // SCREENSHOT: order-aware
    const state = pi === -1 && fi === -1 ? 'pending' : (fi > pi ? 'fail' : 'pass'); const ev = state === 'fail' ? evs[fi] : (state === 'pass' ? evs[pi] : null);
    g.screenshot = { state, evidence: ev ? (ev.reason || ev.note || (state === 'pass' ? (ev.event_type === 'browser_layout_verified' ? 'layout verified' : 'screenshot captured') : 'browser proof blocked')) : 'no screenshot/proof logged yet' }; }
  { let pi = -1, fi = -1, fEv = null, pEv = null; // SECURITY: order-aware between block/security-finding and a passed security check
    evs.forEach((e, k) => { if (e.event_type === 'ecc_blocked' || e.event_type === 'ecc_agent_failed' || _gateSecurityFinding(e)) { fi = k; fEv = e; }
      if (_gateSecurityCheckPassed(e)) { pi = k; pEv = e; } });
    const state = pi === -1 && fi === -1 ? 'pending' : (fi > pi ? 'fail' : 'pass'); const ev = state === 'fail' ? fEv : (state === 'pass' ? pEv : null);
    g.security = { state, evidence: ev ? (ev.note || ev.reason || ev.issue || (state === 'pass' ? 'security check passed' : 'security block/finding logged')) : 'no security signal logged yet' }; }
  { let best = -1, kind = null; // CODEX: pass/fail/skip/pending, order-aware among all three
    evs.forEach((e, k) => { if (e.event_type === 'codex_review_completed' && k > best) { best = k; kind = 'pass'; }
      if (e.event_type === 'codex_blocked' && k > best) { best = k; kind = 'fail'; }
      if (e.event_type === 'codex_not_invoked' && k > best) { best = k; kind = 'skip'; } });
    g.codex = { state: kind || 'pending', evidence: kind ? (evs[best].reason || evs[best].note || kind) : 'no codex activity logged yet' }; }
  { const pi = _gateLastIdx(evs, ['lead_review_completed', 'quality_gate_passed']), fi = _gateLastIdx(evs, ['quality_gate_blocked']); // LEAD: order-aware
    const state = pi === -1 && fi === -1 ? 'pending' : (fi > pi ? 'fail' : 'pass'); const ev = state === 'fail' ? evs[fi] : (state === 'pass' ? evs[pi] : null);
    g.lead = { state, evidence: ev ? (ev.reason || ev.note || (state === 'pass' ? 'lead review passed' : 'lead review blocked')) : 'no lead review logged yet' }; }
  return g;
}
const GATE_DEFS = [['tests', 'Tests'], ['build', 'Build'], ['screenshot', 'Screenshot'], ['security', 'Security'], ['codex', 'Codex'], ['lead', 'Lead']];
const GATE_REQUIRED = ['tests', 'build', 'screenshot', 'security', 'lead']; // codex is optional — a skip never blocks green
function gatesOverall(g) {
  const failing = GATE_REQUIRED.filter((k) => g[k].state === 'fail'); const pending = GATE_REQUIRED.filter((k) => g[k].state === 'pending');
  if (failing.length) return { ok: false, text: failing.length + ' required gate' + (failing.length > 1 ? 's' : '') + ' failing' };
  if (pending.length) return { ok: false, text: pending.length + ' required gate' + (pending.length > 1 ? 's' : '') + ' pending' };
  // Fix 5: codex stays optional (a skip never blocks green) BUT a real codex FAIL must not be hidden behind
  // an "all required gates pass" banner that reads as fully clean.
  if (g.codex && g.codex.state === 'fail') return { ok: false, text: 'required gates pass · Codex flagged an issue' };
  return { ok: true, text: 'all required gates pass' };
}
function renderGates() {
  const g = gateVerdicts(); const overall = gatesOverall(g);
  return '<div class="gate-banner ' + (overall.ok ? 'ok' : 'bad') + '">' + (overall.ok ? '✓ ' : '⚠ ') + esc(overall.text) + '</div>'
    + '<div class="gate-list">' + GATE_DEFS.map(([id, label]) => { const gg = g[id];
      return '<div class="gate-row gate-' + gg.state + '"><span class="gate-name">' + esc(label) + '</span><span class="gate-pill ' + gg.state + '">' + esc(gg.state.toUpperCase()) + '</span><span class="gate-ev">' + esc(gg.evidence) + '</span></div>';
    }).join('') + '</div>';
}

/* ---------- proof/trust strip: verified vs merely-claimed events (WP5) ---------- */
// honest counter: reads the SAME _forge_verify flags log-event.cjs stamps (deep-scan 2026-07-07) — a problem
// flag means the event is a CLAIM, not proven activity. Never invented; absent flags = clean by default.
function trustStats() {
  const evs = (window.Forge && window.Forge.visibleEvents) ? window.Forge.visibleEvents() : STATE.events;
  const total = evs.length; let unregistered = 0, noDispatch = 0, unverifiedProof = 0, unknownType = 0, flagged = 0, unstamped = 0;
  evs.forEach((e) => { const fv = e._forge_verify;
    if (!fv) { unstamped++; return; } // Fix 6: no _forge_verify stamp at all — never counted as "clean", it was simply never checked
    let bad = false;
    if (fv.agent_registered === false) { unregistered++; bad = true; }
    if (fv.dispatch_unverified) { noDispatch++; bad = true; }
    if (fv.proof_verified === false) { unverifiedProof++; bad = true; }
    if (fv.event_type_unknown) { unknownType++; bad = true; }
    if (bad) flagged++; });
  const stamped = total - unstamped; const clean = stamped - flagged; // clean/pct read from STAMPED events only
  const pct = stamped ? Math.round((clean / stamped) * 100) : null;
  return { total, stamped, unstamped, flagged, clean, pct, unregistered, noDispatch, unverifiedProof, unknownType };
}
function renderTrust() {
  const s = trustStats();
  if (!s.total) return '<div class="sn-empty">no events logged yet — nothing to verify.</div>';
  const ok = s.stamped > 0 && s.flagged === 0; // Fix 6: never claim OK when nothing was actually verification-stamped
  const bigCls = ok ? 'ok' : (s.pct != null && s.pct < 70 ? 'bad' : 'warn');
  const verdictText = s.stamped === 0 ? 'no stamped events — nothing verified yet' : (ok ? 'OK' : (s.flagged + ' unverified event' + (s.flagged === 1 ? '' : 's')));
  return '<div class="trust-wrap">'
    + '<div class="trust-big ' + bigCls + '">' + (s.pct == null ? '—' : s.pct + '%') + '<span class="trust-sub">verified</span></div>'
    + '<div class="trust-verdict ' + (ok ? 'ok' : 'warn') + '">swarm honesty: ' + verdictText + '</div>'
    + '<div class="trust-grid">'
      + kv('total events', s.total) + kv('clean / verified', s.clean) + kv('flagged (any issue)', s.flagged, s.flagged ? 'bad' : 'good')
      + kv('unregistered agent name', s.unregistered, s.unregistered ? 'bad' : '') + kv('no dispatch proof', s.noDispatch, s.noDispatch ? 'bad' : '')
      + kv('unverified proof field', s.unverifiedProof, s.unverifiedProof ? 'bad' : '') + kv('unknown event type', s.unknownType, s.unknownType ? 'bad' : '')
      + (s.unstamped > 0 ? kv('never verification-stamped', s.unstamped, 'warn') : '')
    + '</div></div>';
}

/* ---------- cost/token meter: real cost data only, forward-compatible (WP6) ---------- */
function _numOrNull(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
// pure model: sums any REAL numeric tokens/cost fields present on events, per agent + total. A field being
// present with no parseable number is skipped (never fabricated). Most current runs log none of this yet —
// that produces an honest empty state, not invented numbers. Lights up automatically once cost events exist.
function costStats() {
  const evs = (window.Forge && window.Forge.visibleEvents) ? window.Forge.visibleEvents() : STATE.events;
  const perAgent = new Map(); let totalTokens = 0, totalCost = 0, any = false;
  evs.forEach((e) => {
    let tok = _numOrNull(e.tokens), cost = _numOrNull(e.cost);
    if (e.usage && typeof e.usage === 'object') { const u = e.usage;
      const utok = _numOrNull(u.tokens != null ? u.tokens : u.total_tokens); const ucost = _numOrNull(u.cost);
      if (utok != null) tok = (tok || 0) + utok; if (ucost != null) cost = (cost || 0) + ucost; }
    if (tok == null && cost == null) return; // no real numeric cost/token data on this event — skip
    any = true; const agent = e.agent || 'unattributed';
    const cur = perAgent.get(agent) || { tokens: 0, cost: 0 }; cur.tokens += tok || 0; cur.cost += cost || 0; perAgent.set(agent, cur);
    totalTokens += tok || 0; totalCost += cost || 0;
  });
  let budget = null; const runBudget = STATE.run && _numOrNull(STATE.run.budget); if (runBudget != null) budget = runBudget;
  const budgetEvs = evs.filter((e) => e.event_type === 'cost_budget');
  if (budgetEvs.length) { const be = budgetEvs[budgetEvs.length - 1]; const b = _numOrNull(be.budget != null ? be.budget : (be.limit != null ? be.limit : be.tokens)); if (b != null) budget = b; }
  return { any, perAgent, totalTokens, totalCost, budget };
}
function renderCost() {
  const s = costStats();
  if (!s.any) return '<div class="sn-empty">no cost/token data logged for this run yet.</div>';
  let h = '<div class="cost-wrap"><div class="cost-total">'
    + kv('total tokens', s.totalTokens ? s.totalTokens.toLocaleString() : '—') + kv('total cost', s.totalCost ? ('$' + s.totalCost.toFixed(4)) : '—') + '</div>';
  if (s.budget != null && s.budget > 0) { const basis = s.totalTokens || s.totalCost || 0; const pct = Math.max(0, Math.min(100, Math.round((basis / s.budget) * 100)));
    h += '<div class="cost-budget"><div class="cost-budget-label">budget ' + s.budget.toLocaleString() + ' · ' + pct + '%</div>'
      + '<div class="cost-bar"><div class="cost-bar-fill' + (pct >= 100 ? ' over' : '') + '" style="width:' + pct + '%"></div></div></div>'; }
  h += '<div class="cost-rows">' + [...s.perAgent.entries()].map(([a, v]) =>
    '<div class="cost-row"><span class="cost-agent">' + esc(a) + '</span><span class="cost-tok">' + (v.tokens ? v.tokens.toLocaleString() + ' tok' : '—') + '</span><span class="cost-usd">' + (v.cost ? '$' + v.cost.toFixed(4) : '—') + '</span></div>'
  ).join('') + '</div></div>';
  return h;
}

/* ---------- PRD panel: read-only list of generated PRDs (WP3, .claude/forge-prd/, forge-prd.cjs) ---------- */
const PRD_SECTION_LABELS = { goal: 'Goal', users: 'Users', problem: 'Problem', solution: 'Solution', modules: 'Modules',
  user_stories: 'User Stories', mvp_scope: 'MVP Scope', non_goals: 'Non-Goals', architecture: 'Architecture',
  risks: 'Risks', acceptance_criteria: 'Acceptance Criteria', test_plan: 'Test Plan', roadmap: 'Roadmap' };
function prdDate(iso) { if (!iso) return '—'; const s = String(iso); return s.length >= 16 ? s.replace('T', ' ').slice(0, 16) : s; }
// pure model + render: state.prds is READ-ONLY (server.cjs's readPrds()) — nothing here writes or invents a PRD.
function prdCardHtml(p) {
  const sections = p.sections_present || [];
  return '<details class="prd-card"><summary class="prd-summary">'
    + '<span class="prd-title">' + esc(p.title || '(untitled)') + '</span>'
    + '<span class="prd-meta">' + esc(p.project || 'unknown project') + ' · ' + esc(prdDate(p.created)) + ' · ' + (p.acceptance_count || 0) + ' AC</span>'
    + '</summary><div class="prd-detail">'
    + kv('prd id', p.prd_id) + kv('acceptance criteria', p.acceptance_count || 0)
    + '<div class="sn-block"><div class="lbl">sections present (' + sections.length + '/13)</div>'
    + (sections.length ? sections.map((s) => '<div class="sn-li">' + esc(PRD_SECTION_LABELS[s] || s) + '</div>').join('') : '<div class="sn-empty">none</div>')
    + '</div></div></details>';
}
function renderPrdBoard() {
  const prds = STATE.prds || [];
  if (!prds.length) return '<div class="sn-empty">No PRDs yet — generate one with forge-prd.</div>';
  return '<div class="prd-board">' + prds.map(prdCardHtml).join('') + '</div>';
}

/* ---------- Vault panel: read-only list of stored artifacts (WP5, .claude/forge-artifacts/, forge-artifact.cjs) ---------- */
function vaultDate(iso) { if (!iso) return '—'; const s = String(iso); return s.length >= 16 ? s.replace('T', ' ').slice(0, 16) : s; }
// pure model + render: STATE.artifacts is READ-ONLY metadata (server.cjs's readArtifacts()) — nothing here
// writes or invents an artifact. Clicking a card is a plain <details> (zero-JS) — the full record lives at
// GET /api/artifact/<id> and is never auto-fetched into this list (metadata only, per WP5 constraint).
function vaultCardHtml(a) {
  return '<details class="vault-card"><summary class="vault-summary">'
    + '<span class="vault-title">' + esc(a.title || '(untitled)') + '</span>'
    + (a.kind ? '<span class="vault-kind">' + esc(a.kind) + '</span>' : '')
    + '<span class="vault-meta">' + esc(a.produced_by || 'unknown') + ' · ' + esc(vaultDate(a.created)) + '</span>'
    + '</summary><div class="vault-detail">'
    + kv('artifact id', a.artifact_id) + kv('run', a.run_id)
    + '<div class="vault-hint">Full record (not fetched here): <code>/api/artifact/' + esc(a.artifact_id) + '</code></div>'
    + '</div></details>';
}
function renderVault() {
  const artifacts = STATE.artifacts || [];
  if (!artifacts.length) return '<div class="sn-empty">No artifacts stored yet — produced during real runs.</div>';
  return '<div class="vault-board">' + artifacts.map(vaultCardHtml).join('') + '</div>';
}

/* ---------- Doctor panel: read-only forge-doctor.cjs self-test result (WP7, <run>/doctor.json) ---------- */
// pure render: STATE.doctor is READ-ONLY (server.cjs's readDoctor()) — nothing here runs the doctor or
// invents a result. Honest empty state when no doctor run exists yet; each check shows its real pass/fail.
function docRow(label, ok, detail) {
  return '<div class="doc-row doc-' + (ok ? 'ok' : 'bad') + '"><span class="doc-name">' + esc(label) + '</span>'
    + '<span class="doc-pill ' + (ok ? 'ok' : 'bad') + '">' + (ok ? 'PASS' : 'FAIL') + '</span>'
    + '<span class="doc-ev">' + esc(detail) + '</span></div>';
}
function renderDoctor() {
  const d = STATE.doctor;
  if (!d) return '<div class="sn-empty">No doctor run yet — run <code>forge-doctor.cjs --run &lt;id&gt;</code> to self-test + leak-scan.</div>';
  const c = d;
  return '<div class="doc-banner ' + (d.ok ? 'ok' : 'bad') + '">' + (d.ok ? '✓ ALL GREEN' : '⚠ FAILURES') + ' · run ' + esc(d.run_id) + '</div>'
    + '<div class="doc-list">'
    + docRow('node --check', c.node_check.ok, c.node_check.total + ' files')
    + docRow('tests', c.tests.ok, c.tests.suites + ' suites · ' + c.tests.passed + ' passed / ' + c.tests.failed + ' failed')
    + docRow('honesty gate', c.strict_events.ok, 'strict events reject unknown types')
    + docRow('dashboard SPA', c.dashboard_spa.ok, 'render files present')
    + docRow('leak scan', c.leak_scan.ok, c.leak_scan.scanned + ' tracked files · ' + (c.leak_scan.ok ? 'clean' : c.leak_scan.hits + ' hit(s)'))
    + '</div>';
}

/* ---------- Bosses panel: read-only per-Boss agent-file + memory status (WP8, STATE.bossAgents) ---------- */
// pure render: STATE.bossAgents is READ-ONLY (server.cjs's readBossAgents()) — nothing here writes or invents
// a Boss. Renders ONLY name/model/tool_tier/memory_lessons — never any memory file content (SECURITY).
function bossRowHtml(b) {
  const hasMem = (b.memory_lessons || 0) > 0;
  const memText = hasMem ? (b.memory_lessons + ' lesson' + (b.memory_lessons === 1 ? '' : 's')) : 'no memory yet';
  return '<div class="boss-row"><span class="boss-name">' + esc(b.name) + '</span>'
    + '<span class="boss-chip">' + esc(b.model) + '</span>'
    + '<span class="boss-chip boss-tier-' + esc(b.tool_tier) + '">' + esc(b.tool_tier) + '</span>'
    + '<span class="boss-mem ' + (hasMem ? 'boss-mem-has' : 'boss-mem-none') + '">' + esc(memText) + '</span></div>';
}
function renderBossAgents() {
  const bosses = STATE.bossAgents || [];
  if (!bosses.length) return '<div class="sn-empty">No Boss agent files found yet.</div>';
  return '<div class="boss-list">' + bosses.map(bossRowHtml).join('') + '</div>';
}

/* ---------- Capabilities & Enforcement panel (V9-INTEGRATE, 2026-07-22) ----------
   read-only render of GET /api/capabilities (forge-capabilities.cjs report()) and GET /api/runcontract
   (forge-runcontract.cjs check() for the currently-viewed run). Pure render: STATE.capabilities/
   STATE.runcontract are lazy-loaded ONLY when this dock tab opens (see graph.js loadCapabilitiesPanel()
   call + panels.js loadCapabilitiesPanel() below) — never invented, never polled on the fast tick. Honest
   "not loaded yet" state until the fetch resolves, honest degraded state when the sibling tool is
   unavailable (server.cjs returns {ok:false, error, ...}) — never rendered as if it were a clean result. */
function capRowHtml(c) {
  const used = c.times_used > 0;
  const pill = c.status === 'active' ? 'ok' : (c.status === 'dormant' ? 'bad' : 'neutral');
  const usedText = used ? (c.times_used + 'x' + (c.last_used_run ? ' · last ' + c.last_used_run : '')) : 'never used';
  return '<div class="cap-row cap-' + pill + '"><span class="cap-kind">' + esc(c.kind) + '</span>'
    + '<span class="cap-name">' + esc(c.name) + '</span>'
    + '<span class="cap-pill ' + pill + '">' + esc(c.status) + '</span>'
    + '<span class="cap-used' + (used ? '' : ' cap-never') + '">' + esc(usedText) + '</span></div>';
}
function renderRunContractSection() {
  const rc = STATE.runcontract;
  if (!rc) return '<div class="sn-empty">Run contract: not loaded.</div>';
  if (rc.error) return '<div class="sn-empty">Run contract unavailable: ' + esc(rc.error) + '</div>';
  const rows = []
    .concat((rc.satisfied || []).map((id) => '<div class="rc-row rc-ok"><span class="rc-id">' + esc(id) + '</span><span class="rc-pill ok">SATISFIED</span></div>'))
    .concat((rc.missing || []).map((id) => '<div class="rc-row rc-bad"><span class="rc-id">' + esc(id) + '</span><span class="rc-pill bad">MISSING</span></div>'))
    .concat((rc.warnings || []).map((id) => '<div class="rc-row rc-warn"><span class="rc-id">' + esc(id) + '</span><span class="rc-pill warn">WARN</span></div>'))
    .concat((rc.overridden || []).map((o) => '<div class="rc-row rc-over"><span class="rc-id">' + esc(o.id) + '</span><span class="rc-pill over">OVERRIDDEN</span><span class="rc-note">' + esc(o.note) + '</span></div>'));
  return '<div class="doc-banner ' + (rc.ok ? 'ok' : 'bad') + '">' + (rc.ok ? '✓ CONTRACT OK' : '⚠ NOT DONE') + ' · run ' + esc(rc.run_id || '—') + '</div>'
    + '<div class="rc-list">' + (rows.length ? rows.join('') : '<div class="sn-empty">no applicable rules</div>') + '</div>';
}
function renderCapabilities() {
  const rep = STATE.capabilities;
  let out = '<div class="cap-section"><div class="cap-h">Run contract (current run)</div>' + renderRunContractSection() + '</div>';
  out += '<div class="cap-section"><div class="cap-h">Capabilities inventory</div>';
  if (!rep) { out += '<div class="sn-empty">Loading capabilities…</div></div>'; return out; }
  if (rep.error) { out += '<div class="sn-empty">Capabilities unavailable: ' + esc(rep.error) + '</div></div>'; return out; }
  const s = rep.summary || {};
  out += '<div class="doc-banner ' + (s.never_used ? 'bad' : 'ok') + '">' + (s.total || 0) + ' total · ' + (s.active || 0) + ' active · '
    + (s.dormant || 0) + ' dormant · ' + (s.opt_in || 0) + ' opt-in · <b>' + (s.never_used || 0) + ' never used</b></div>';
  const caps = (rep.capabilities || []).slice().sort((a, b) => (a.times_used > 0) - (b.times_used > 0) || String(a.name).localeCompare(String(b.name)));
  out += '<div class="cap-list">' + (caps.length ? caps.map(capRowHtml).join('') : '<div class="sn-empty">no capabilities found</div>') + '</div></div>';
  return out;
}
// loadCapabilitiesPanel() — fires the two lazy GETs (fire-and-forget; each independently degrades honestly
// via server.cjs, never thrown to the caller) and re-renders the dock ONLY if the tab is still active when
// the response lands (a user who already switched tabs must never see a stale panel flash back).
async function loadCapabilitiesPanel() {
  try {
    const r = await fetch('/api/capabilities', { cache: 'no-store' });
    STATE.capabilities = await r.json();
  } catch (e) { STATE.capabilities = { ok: false, error: String(e && e.message || e) }; }
  const runId = STATE.run && STATE.run.run_id;
  if (runId) {
    try {
      const rr = await fetch('/api/runcontract?run=' + encodeURIComponent(runId), { cache: 'no-store' });
      STATE.runcontract = await rr.json();
    } catch (e) { STATE.runcontract = { ok: false, error: String(e && e.message || e) }; }
  } else {
    STATE.runcontract = { ok: false, error: 'no active run' };
  }
  if (STATE.ui.dockTab === 'capabilities') renderDock();
}

/* ---------- Stats panel: read-only cross-run analytics from STATS.json (forge-stats.cjs) ---------- */
// STATE.stats is the raw /api/stats payload (server readStats()). Pure render — never fabricates a number;
// honest loading/empty/error states. Reuses the existing cost-* + doc-banner classes (no new CSS).
function renderStats() {
  const s = STATE.stats;
  if (!s) return '<div class="sn-empty">Loading cross-run stats…</div>';
  if (s.ok === false || s.error) return '<div class="sn-empty">' + esc(s.error || 'stats unavailable') + '</div>';
  const perBoss = s.perBoss || {};
  const names = Object.keys(perBoss).sort((a, b) => (perBoss[b].dispatched || 0) - (perBoss[a].dispatched || 0) || a.localeCompare(b));
  if (!names.length) return '<div class="sn-empty">No cross-run stats yet — run forge-stats.cjs after some runs.</div>';
  const when = s.generated_at ? String(s.generated_at).replace('T', ' ').slice(0, 16) : '';
  let h = '<div class="cost-wrap"><div class="doc-banner ok">' + (s.runs_scanned || 0) + ' runs scanned · ' + names.length + ' bosses' + (when ? ' · ' + esc(when) : '') + '</div>';
  h += '<div class="cost-rows">' + names.map((n) => {
    const b = perBoss[n] || {};
    const fp = (b.first_pass_rate != null) ? (b.first_pass_rate + '% 1st-pass') : '—';
    return '<div class="cost-row"><span class="cost-agent">' + esc(n) + '</span>'
      + '<span class="cost-tok">' + (b.dispatched || 0) + ' disp · ' + (b.completed || 0) + ' done · ' + (b.failed || 0) + ' fail' + (b.rework_received ? ' · ' + b.rework_received + ' rework' : '') + '</span>'
      + '<span class="cost-usd">' + esc(fp) + '</span></div>';
  }).join('') + '</div></div>';
  return h;
}
async function loadStatsPanel() {
  try { const r = await fetch('/api/stats', { cache: 'no-store' }); STATE.stats = await r.json(); }
  catch (e) { STATE.stats = { ok: false, error: String(e && e.message || e) }; }
  if (STATE.ui.dockTab === 'stats') renderDock();
}

/* ---------- bottom dock ---------- */
const DOCK_TABS = [['log', 'Live Log'], ['files', 'Files Changed'], ['memory', 'Memory Status'], ['report', 'Final Report'], ['preview', 'Preview'], ['board', 'Agent Board'], ['tickets', 'Tickets'], ['prd', 'PRD'], ['vault', 'Vault'], ['gates', 'Gates'], ['trust', 'Proof/Trust'], ['cost', 'Cost'], ['doctor', 'Doctor'], ['bosses', 'Bosses'], ['capabilities', 'Capabilities'], ['stats', 'Stats']];
function logMsg(e) { return e.note || e.output || e.decision_summary || e.summary || e.task || e.issue || (e.files_changed && e.files_changed.length ? e.files_changed.map(fileName).join(', ') : '') || e.command || e.artifact || e.status || ''; }
function renderDock() {
  const body = $('dock-body'); if (!body) return; const d = STATE.ui.dockTab;
  $('dock-tabs').innerHTML = DOCK_TABS.map(([id, lbl]) => '<button role="tab" data-dock="' + id + '" aria-selected="' + (d === id) + '">' + lbl + '</button>').join('');
  if (d === 'log') {
    const near = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    body.innerHTML = STATE.events.length ? '<div class="log">' + STATE.events.map((e, i) => { const t = e.event_type; let cls = ''; if (['check_passed', 'run_completed', 'fix_completed', 'retest_completed', 'quality_gate_passed'].includes(t)) cls = 'pass'; if (['check_failed', 'agent_failed', 'quality_gate_blocked'].includes(t) || (t === 'codex_finding' && /crit|high/.test(e.severity || ''))) cls = 'fail';
      return '<div class="line ' + cls + ' ' + (i >= STATE._prevCount ? 'new' : '') + '"><span class="lt">' + esc(hhmmss(e.timestamp)) + '</span><span class="lm">' + (e.agent ? '<span class="lag">' + esc(e.agent) + '</span> ' : '') + esc(t) + (logMsg(e) ? ' · ' + esc(trunc(logMsg(e), 88)) : '') + '</span></div>'; }).join('') + '</div>' + (STATE.malformed ? '<span class="ll-warn">' + STATE.malformed + ' malformed skipped</span>' : '') : '<div class="sn-empty">waiting for events…</div>';
    if (STATE.settings.auto_scroll_logs && near) body.scrollTop = body.scrollHeight;
  } else if (d === 'files') {
    const m = new Map(); STATE.events.forEach((e) => (e.files_changed || []).forEach((f) => { const fn = fileName(f); if (fn) m.set(fn, { agent: e.agent || '', ts: e.timestamp }); }));
    body.innerHTML = m.size ? [...m.entries()].map(([f, v]) => '<div class="frow"><span class="fa">↓</span>' + esc(f) + '<span class="fag">' + esc(v.agent) + ' · ' + esc(hhmmss(v.ts)) + '</span></div>').join('') : '<div class="sn-empty">No file changes.</div>';
  } else if (d === 'memory') {
    const mem = STATE.memory || {}; const keys = Object.keys(mem);
    body.innerHTML = keys.length ? keys.map((k) => '<div class="memrow"><span>' + esc(k.replace('FORGE_', '').replace('.md', '')) + '</span>' + (mem[k].exists ? '<span class="ok">present</span>' : '<span class="no">not present</span>') + '</div>').join('') : '<div class="sn-empty">no memory files</div>';
  } else if (d === 'report') {
    body.innerHTML = STATE.report ? '<pre class="report-pre">' + esc(STATE.report) + '</pre>' : '<div class="sn-empty">No final-report.md yet.</div>';
  } else if (d === 'preview') {
    const url = STATE.run && STATE.run.preview_url; const safe = url && /^https?:\/\//i.test(url); const prevArt = STATE._nodes.flatMap((n) => n.artifacts).find((a) => /preview/i.test(a.kind || ''));
    body.innerHTML = safe ? '<a href="' + esc(url) + '" target="_blank" rel="noopener" style="color:var(--cyan)">' + esc(url) + '</a>' : (url ? '<div class="sn-empty">Invalid preview URL (non-http).</div>' : (prevArt ? '<div class="frow">' + esc(prevArt.artifact) + '</div>' : '<div class="sn-empty">No preview available — not produced yet.</div>'));
  } else if (d === 'board') {
    body.innerHTML = renderAgentBoard();
  } else if (d === 'tickets') {
    body.innerHTML = renderTicketBoard();
  } else if (d === 'prd') {
    body.innerHTML = renderPrdBoard();
  } else if (d === 'vault') {
    body.innerHTML = renderVault();
  } else if (d === 'gates') {
    body.innerHTML = renderGates();
  } else if (d === 'trust') {
    body.innerHTML = renderTrust();
  } else if (d === 'cost') {
    body.innerHTML = renderCost();
  } else if (d === 'doctor') {
    body.innerHTML = renderDoctor();
  } else if (d === 'bosses') {
    body.innerHTML = renderBossAgents();
  } else if (d === 'capabilities') {
    body.innerHTML = renderCapabilities();
  } else if (d === 'stats') {
    body.innerHTML = renderStats();
  }
}

/* ---------- summary metrics ---------- */
function criticalPath() { const n = STATE._nodes; const sub = n.filter((x) => !['control', 'review', 'report'].includes(x.group) && x.status !== 'internal');
  const active = sub.find((x) => x.status === 'running') || [...sub].reverse().find((x) => x.status === 'done') || sub[0];
  const codex = n.find((x) => /codex|review/i.test(x.role || x.key)); const rep = n.find((x) => x.group === 'report');
  const path = [active, codex, rep].filter(Boolean).map((x) => x.key); return path.length ? path.join(' → ') : '—'; }
function nextStep() { const r = STATE._nodes.find((x) => x.status === 'running' && x.nextAction); if (r) return r.nextAction;
  const codex = STATE._nodes.find((x) => /codex/i.test(x.key) && (x.status === 'previewing' || x.status === 'running')); if (codex) return 'codex-reviewer reviewing ' + trunc(codex.mission || 'analysis', 32);
  const w = STATE._nodes.find((x) => x.status === 'waiting' || x.status === 'previewing'); if (w) return w.key + ': ' + trunc(w.mission || w.title, 40);
  // Fix 4b: 'run complete' must be backed by real completed progress + a live (non-replay) view — a
  // STATE.run.status flag alone (or a partial replay slice) is not proof the work is actually finished.
  return ((STATE.run.status || '') === 'completed' && (typeof replayAtLive !== 'function' || replayAtLive()) && progress() >= 100) ? 'run complete' : '—'; }
function eta() { const p = progress(); if (p >= 100) return 'done'; const started = STATE.run.started; if (!started) return '—'; // Fix 4a: only real progress proves 'done' — a run.status flag alone is a claim, not evidence
  const elapsed = (Date.now() - new Date(started).getTime()) / 1000; if (p < 5 || elapsed <= 0) return 'derived (low confidence)';
  const rem = Math.max(0, elapsed / (p / 100) - elapsed); const m = Math.floor(rem / 60), s = Math.round(rem % 60); return '~' + (m ? m + 'm ' : '') + s + 's'; }
function renderMetrics() { const p = progress(); const setM = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const pf = $('m-progfill'); if (pf) pf.style.width = p + '%'; setM('m-progpct', p + '%');
  setM('m-critpath', criticalPath()); setM('m-next', nextStep()); setM('m-eta', eta());
  const ecc = eccSummary();
  setM('m-ecc-mode', ecc.state === 'blocked' ? ('BLOCKED — ' + (ecc.blockedReason || 'ECC blocked')) : ('Normal ' + String(ecc.normal || 'on').toUpperCase() + ' · Test ' + String(ecc.full_test || 'off').toUpperCase()));
  setM('m-ecc-agents', ecc.attempted ? (ecc.selected.length + ' selected · ' + ecc.invoked.length + ' invoked' + (ecc.skills.length ? ' · ' + ecc.skills.length + ' skill' : '')) : 'no ECC activity yet');
  setM('m-ecc-fallback', ecc.nativeFallback ? 'native fallback used' : (ecc.attempted ? 'none (ECC-first)' : '—'));
  const subs = STATE._nodes.filter((n) => isSubagentNode(n)); const custom = subs.filter((n) => n.custom).length;
  const msub = $('m-subs'); if (msub) msub.textContent = subs.length ? (subs.length + ' subagent' + (subs.length !== 1 ? 's' : '') + (custom ? (' · ' + custom + ' custom') : '')) : '—';
  const rwC = STATE.events.filter((e) => e.event_type === 'rework_task_created').length; const rwD = STATE.events.filter((e) => e.event_type === 'rework_completed').length;
  const mrw = $('m-rework'); if (mrw) mrw.textContent = rwC ? (rwC + ' created · ' + rwD + ' fixed') : 'none';
  const sm = String((STATE.session && STATE.session.mode) || 'off').toLowerCase(); const msess = $('m-session');
  if (msess) msess.textContent = (sm === 'on' || sm === 'active') ? 'active (Forge-first)' : sm === 'paused' ? 'paused' : 'off';
  const gov = governanceSummary(); const mcm = $('m-claudemd'); if (mcm) mcm.textContent = gov.claudeMd;
  const mcs = $('m-customskills'); if (mcs) mcs.textContent = (gov.skills.length ? (gov.skills.length + ' (' + gov.created + ' created' + (gov.used ? ', ' + gov.used + ' used' : '') + ')') : 'none') + (gov.registry !== '—' ? ' · registry ' + gov.registry : '');
  const cx = (typeof codexStatus === 'function') ? codexStatus() : { label: '—' }; const mcx = $('m-codex'); if (mcx) { mcx.textContent = cx.label; mcx.className = 'm-v' + (cx.state === 'failed' ? ' bad' : cx.state === 'done' ? ' good' : ''); }
  const ev = STATE.events; const bp = ev.some((e) => e.event_type === 'browser_layout_verified') ? 'verified' : ev.some((e) => e.event_type === 'browser_screenshot_captured') ? 'screenshot captured' : ev.some((e) => e.event_type === 'browser_proof_blocked') ? 'blocked' : ev.some((e) => e.event_type === 'browser_proof_started') ? 'in progress' : '—';
  const mbp = $('m-browser'); if (mbp) mbp.textContent = bp; }
