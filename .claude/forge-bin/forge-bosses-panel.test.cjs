#!/usr/bin/env node
'use strict';
/** Offline, headless test for the WP8 Bosses dashboard panel (forge-dashboard/panels.js). Loads the REAL
 *  panels.js in a Node vm with a minimal DOM/global stub and drives the ACTUAL DOCK_TABS/renderDock() path
 *  — a pass proves the shipped 'bosses' panel renders correctly. Pure in-memory; never touches the project. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const PANELS_PATH = path.join(__dirname, '..', 'forge-dashboard', 'panels.js');
const PANELS_SRC = fs.readFileSync(PANELS_PATH, 'utf8');

function makeEl() { return { innerHTML: '', textContent: '', className: '', hidden: false, style: {}, dataset: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0 }; }

function loadPanels(initialState) {
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
    querySelectorAll() { return []; }, createElement() { return makeEl(); },
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
    bosses: [], prds: [], mindmaps: [], tickets: [], artifacts: [], doctor: null, bossAgents: [],
    replay: { active: false, playing: false, cursor: 0, speed: 1 },
    ui: { insTab: 'summary', actFilter: 'all', dockTab: 'log', collapsed: new Set() },
  }, initialState || {});
  const sandbox = {
    document, console, STATE, Forge: {},
    $: (id) => document.getElementById(id), esc, trunc, hhmmss, fileName, statusLabel,
    SYNTH: {}, GROUP_ORDER: [], GROUP_LABEL: {}, selRef: { refKey: null, refEvIdx: null },
    agentColor: () => ({ solid: '#fff', glyph: '' }), isSubagentNode: () => false, progress: () => 0, ago: () => '—',
    eccSummary: () => ({ state: 'off', normal: 'on', full_test: 'off', attempted: false, selected: [], invoked: [], skills: [], nativeFallback: false }),
    governanceSummary: () => ({ claudeMd: '—', skills: [], created: 0, used: 0, registry: '—' }),
    codexStatus: () => ({ label: '—', state: '' }),
  };
  sandbox.window = { Forge: sandbox.Forge };
  vm.createContext(sandbox);
  vm.runInContext(PANELS_SRC, sandbox, { filename: 'panels.js' });
  return { sandbox, document };
}

console.log('forge-bosses dashboard panel offline tests (headless vm + DOM stub)');

t('panels.js registers a "bosses" dock tab', /\[\s*['"]bosses['"]\s*,\s*['"]Bosses['"]\s*\]/.test(PANELS_SRC));

const { sandbox: sb0 } = loadPanels({});
t('renderBossAgents is exposed', typeof sb0.renderBossAgents === 'function');

// 1) populated case: 3 fake Bosses covering all 3 tool_tier values + plural/singular/zero memory text
const populated = [
  { slug: 'boss', name: 'Boss', model: 'opus', tools: 'Read, Write, Edit, Grep, Glob', tool_tier: 'orchestrator', memory_lessons: 3 },
  { slug: 'review-boss', name: 'Review Boss', model: 'opus', tools: 'Read, Grep, Glob', tool_tier: 'read-only', memory_lessons: 0 },
  { slug: 'build-boss', name: 'Build Boss', model: 'sonnet', tools: 'Read, Write, Edit, Bash, Grep, Glob', tool_tier: 'balanced', memory_lessons: 1 },
];
const { sandbox: sb1, document: doc1 } = loadPanels({ bossAgents: populated });
sb1.STATE.ui.dockTab = 'bosses';
sb1.renderDock();
const h1 = doc1.getElementById('dock-body').innerHTML;
t('renders each Boss name', h1.includes('Boss') && h1.includes('Review Boss') && h1.includes('Build Boss'));
t('renders each Boss model', h1.includes('opus') && h1.includes('sonnet'));
t('renders all 3 tool_tier values', h1.includes('orchestrator') && h1.includes('read-only') && h1.includes('balanced'));
t('renders plural "3 lessons"', h1.includes('3 lessons'));
t('renders singular "1 lesson" (not "1 lessons")', h1.includes('1 lesson<') || /1 lesson(?!s)/.test(h1));
t('renders zero-case "no memory yet"', h1.includes('no memory yet'));
t('dock-tabs row includes a Bosses button', doc1.getElementById('dock-tabs').innerHTML.includes('>Bosses<'));

// 2) honest empty state — never a fabricated row
const { sandbox: sb2, document: doc2 } = loadPanels({ bossAgents: [] });
sb2.STATE.ui.dockTab = 'bosses'; sb2.renderDock();
const h2 = doc2.getElementById('dock-body').innerHTML;
t('empty bossAgents renders the honest empty state', h2.includes('No Boss agent files found yet.'));
t('empty bossAgents does not fabricate a boss-row', !h2.includes('boss-row'));

// 3) SECURITY — memory content must never leak: an unexpected extra field carrying sentinel text must
// never render, proving bossRowHtml() only reads the whitelisted fields.
const leaky = [{ slug: 'x', name: 'X', model: 'sonnet', tools: 'Read', tool_tier: 'read-only', memory_lessons: 2, _leak_probe: 'SENTINEL-LESSON-BODY-MUST-NOT-RENDER' }];
const { sandbox: sb3, document: doc3 } = loadPanels({ bossAgents: leaky });
sb3.STATE.ui.dockTab = 'bosses'; sb3.renderDock();
const h3 = doc3.getElementById('dock-body').innerHTML;
t('memory content sentinel never leaks into rendered HTML', !h3.includes('SENTINEL-LESSON-BODY-MUST-NOT-RENDER'));
t('leaky entry still renders its whitelisted fields', h3.includes('X') && h3.includes('2 lessons'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
