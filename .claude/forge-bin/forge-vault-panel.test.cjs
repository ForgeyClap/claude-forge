#!/usr/bin/env node
'use strict';
/** Offline, headless test for the WP5 Vault dock-tab + persistent-ticket integration in
 *  forge-dashboard/panels.js. Mirrors forge-prd-panel.test.cjs: builds the minimal DOM/global stub
 *  panels.js actually needs (same globals app.js defines before panels.js loads in index.html: $, esc,
 *  STATE, etc.) and loads the REAL panels.js source in a Node vm context — it exercises the ACTUAL
 *  DOCK_TABS/renderDock()/ticketCards() code paths, not a reimplementation, so a pass here proves the
 *  shipped panel renders correctly. Never touches the real project; pure in-memory. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const PANELS_PATH = path.join(__dirname, '..', 'forge-dashboard', 'panels.js');
const PANELS_SRC = fs.readFileSync(PANELS_PATH, 'utf8');

function makeEl() { return { innerHTML: '', textContent: '', className: '', hidden: false, style: {}, dataset: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0 }; }

// Loads a fresh copy of panels.js into its own vm context (new context per call -> no top-level
// const/let redeclaration clashes across calls) with a minimal document + global stub.
function loadPanels(initialState) {
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
    querySelectorAll() { return []; },
    createElement() { return makeEl(); },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  const hhmmss = (iso) => { try { const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); } catch { return ''; } };
  const trunc = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const fileName = (f) => !f ? '' : (typeof f === 'string' ? f : (f.file || ''));
  const statusLabel = (s) => ({ done: 'COMPLETED', running: 'RUNNING', failed: 'FAILED', waiting: 'WAITING', previewing: 'PREVIEWING', internal: 'INTERNAL ONLY' }[s] || 'WAITING');
  const STATE = Object.assign({
    meta: { name: '—', port: '' }, run: {}, events: [], report: null, memory: {}, runs: 0, malformed: 0,
    settings: { polling_interval_ms: 250, fast_mode: false, auto_scroll_logs: true },
    _nodes: [], _prevCount: 0, eccMode: { normal: 'on', full_test: 'off' }, session: { mode: 'off' },
    bosses: [], prds: [], tickets: [], artifacts: [],
    replay: { active: false, playing: false, cursor: 0, speed: 1 },
    ui: { insTab: 'summary', actFilter: 'all', dockTab: 'log', collapsed: new Set() },
  }, initialState || {});
  const Forge = {};
  const sandbox = {
    document, console, STATE, Forge,
    $: (id) => document.getElementById(id), esc, trunc, hhmmss, fileName, statusLabel,
    SYNTH: {}, GROUP_ORDER: [], GROUP_LABEL: {}, selRef: { refKey: null, refEvIdx: null },
    agentColor: () => ({ solid: '#fff', glyph: '' }),
    isSubagentNode: () => false,
    progress: () => 0, ago: () => '—',
    eccSummary: () => ({ state: 'off', normal: 'on', full_test: 'off', attempted: false, selected: [], invoked: [], skills: [], nativeFallback: false }),
    governanceSummary: () => ({ claudeMd: '—', skills: [], created: 0, used: 0, registry: '—' }),
    codexStatus: () => ({ label: '—', state: '' }),
  };
  sandbox.window = { Forge: sandbox.Forge };
  vm.createContext(sandbox);
  vm.runInContext(PANELS_SRC, sandbox, { filename: 'panels.js' });
  return { sandbox, document };
}

console.log('forge-vault (WP5) dashboard panel offline tests (headless vm + DOM stub)');

t('panels.js source registers a "vault" dock tab', /\[\s*['"]vault['"]\s*,\s*['"]Vault['"]\s*\]/.test(PANELS_SRC));

// 1) one real stored artifact -> the 'vault' dock tab (via the ACTUAL renderDock()) shows its title
const artifactRow = { artifact_id: 'a1', title: 'Build log', kind: 'build-log', produced_by: 'Build Boss', run_id: 'forge-1', created: '2026-07-10T00:00:00.000Z' };
const { sandbox: sb1, document: doc1 } = loadPanels({ artifacts: [artifactRow] });
t('renderDock is exposed by panels.js', typeof sb1.renderDock === 'function');
sb1.STATE.ui.dockTab = 'vault';
sb1.renderDock();
const html1 = doc1.getElementById('dock-body').innerHTML;
t('vault panel renders the artifact title', html1.includes('Build log'));
t('vault panel renders the artifact kind chip', html1.includes('build-log'));
t('vault panel points to the read-only per-record endpoint (never auto-fetches the body)', html1.includes('/api/artifact/a1'));
t('vault panel does not render the empty-state text when an artifact exists', !html1.includes('No artifacts stored yet'));
t('dock-tabs row includes a Vault button', doc1.getElementById('dock-tabs').innerHTML.includes('>Vault<'));

// 2) empty STATE.artifacts -> honest empty-state text, never a crash, never a fabricated card
const { sandbox: sb2, document: doc2 } = loadPanels({ artifacts: [] });
sb2.STATE.ui.dockTab = 'vault';
sb2.renderDock();
const html2 = doc2.getElementById('dock-body').innerHTML;
t('empty STATE.artifacts renders the honest empty-state message', html2.includes('No artifacts stored yet — produced during real runs.'));
t('empty state does not fabricate an artifact row', !html2.includes('Build log'));

// 3) ticketCards() includes a persistent-store ticket, mapped to the board vocabulary
const { sandbox: sb3 } = loadPanels({ _nodes: [], tickets: [{ ticket_id: 'tk-1', title: 'login works', status: 'open', owner: 'Test Boss', created: '2026-07-10T00:00:00.000Z' }] });
t('ticketCards() is exposed by panels.js', typeof sb3.ticketCards === 'function');
const cards = sb3.ticketCards();
const ticketCard = cards.find((c) => c.kind === 'ticket');
t('ticketCards() includes a kind:"ticket" card for the stored ticket', !!ticketCard);
t('the stored ticket status "open" maps to "waiting" (backlog column)', !!ticketCard && ticketCard.status === 'waiting');
t('the stored ticket title carries through', !!ticketCard && ticketCard.title === 'login works');
t('the stored ticket owner is formatted', !!ticketCard && ticketCard.owner === 'Test Boss');

// 4) other store statuses map correctly (active/review/blocked/done)
const { sandbox: sb4 } = loadPanels({ _nodes: [], tickets: [
  { ticket_id: 'tk-2', title: 'active one', status: 'active', created: '2026-07-10T00:00:00.000Z' },
  { ticket_id: 'tk-3', title: 'review one', status: 'review', created: '2026-07-10T00:00:00.000Z' },
  { ticket_id: 'tk-4', title: 'blocked one', status: 'blocked', created: '2026-07-10T00:00:00.000Z' },
  { ticket_id: 'tk-5', title: 'done one', status: 'done', created: '2026-07-10T00:00:00.000Z' },
  { ticket_id: 'tk-6', title: 'unknown one', status: 'totally-unknown', created: '2026-07-10T00:00:00.000Z' },
] });
const mapped = sb4.ticketCards().filter((c) => c.kind === 'ticket').reduce((acc, c) => { acc[c.title] = c.status; return acc; }, {});
t('store status "active" -> "running"', mapped['active one'] === 'running');
t('store status "review" -> "previewing"', mapped['review one'] === 'previewing');
t('store status "blocked" -> "failed"', mapped['blocked one'] === 'failed');
t('store status "done" -> "done"', mapped['done one'] === 'done');
t('an unrecognized store status honestly falls back to "waiting" (never assumed done)', mapped['unknown one'] === 'waiting');

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
