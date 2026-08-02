#!/usr/bin/env node
'use strict';
/** Offline, headless test for the V9-INTEGRATE (2026-07-22) "Capabilities & Enforcement" dashboard panel
 *  (forge-dashboard/panels.js renderCapabilities()/renderRunContractSection()) + the READ-ONLY API surfaces it
 *  depends on: forge-dashboard/server.cjs's runIdOk() guard, and the REAL extracted route logic behind
 *  GET /api/capabilities / GET /api/runcontract (readCapabilities()/readRunContract()) — exercised directly
 *  against THIS project's real .claude/ data (never mocked), proving the actual capsTool.report()/
 *  rcTool.check() wiring + honest-degrade shape, without binding a port (require()-and-call-the-export, same
 *  discipline forge-artifact-endpoint.test.cjs already established for this dashboard). The panel-rendering
 *  section below stays fully offline: loads the REAL panels.js in a Node vm with a minimal DOM/global stub and
 *  drives the ACTUAL DOCK_TABS/renderDock() path — a pass proves the shipped 'capabilities' panel renders.
 *  Mirrors forge-doctor-panel.test.cjs's proven harness shape. Never writes to the project, never binds a
 *  port. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-capabilities dashboard panel offline tests (headless vm + DOM stub)');

// ---------------------------------------------------------------------------------------------------------
// 1) server.cjs's runIdOk() guard — same allowlist-regex convention as artifactIdOk()
// ---------------------------------------------------------------------------------------------------------
const server = require('../forge-dashboard/server.cjs');
t('server.cjs exports runIdOk', typeof server.runIdOk === 'function');
t('runIdOk: a real run id shape is accepted', server.runIdOk('forge-2026-07-22-v9-integrate') === true);
t('runIdOk: traversal is rejected', server.runIdOk('../evil') === false);
t('runIdOk: a path-separator id is rejected', server.runIdOk('a/b') === false);
t('runIdOk: empty/non-string ids are rejected', server.runIdOk('') === false && server.runIdOk(null) === false && server.runIdOk(undefined) === false);

// ---------------------------------------------------------------------------------------------------------
// 1b) server.cjs's readCapabilities()/readRunContract() — the REAL, exported route logic behind
// GET /api/capabilities and GET /api/runcontract (extracted from the inline handler so it's testable without
// binding a port — see server.cjs's own doc comment above these functions). Exercised against THIS project's
// REAL .claude/ data (never mocked) — the same "require server.cjs, call the exported pure function directly"
// discipline forge-artifact-endpoint.test.cjs already established for this dashboard.
t('server.cjs exports readCapabilities and readRunContract', typeof server.readCapabilities === 'function' && typeof server.readRunContract === 'function');

const realCaps = server.readCapabilities();
t('readCapabilities() on the real project returns ok:true with a real capabilities array + summary', realCaps.ok === true && Array.isArray(realCaps.capabilities) && realCaps.capabilities.length > 0 && !!realCaps.summary && typeof realCaps.summary.total === 'number');
// each condition below is guarded (?.) so a genuine regression FAILS this one assertion instead of throwing
// mid-argument-evaluation and aborting the rest of the suite (t() only catches errors INSIDE a function body,
// not errors thrown while evaluating its own boolean-expression argument).
t('readCapabilities() summary.total matches the real capabilities array length (no fabricated tally)', realCaps.summary?.total === realCaps.capabilities?.length);
t('readCapabilities() every capability row carries the real report() shape (capability/name/kind/present/status/times_used)', Array.isArray(realCaps.capabilities) && realCaps.capabilities.every((c) => c && typeof c.capability === 'string' && typeof c.name === 'string' && ['tool', 'skill', 'gate'].includes(c.kind) && typeof c.present === 'boolean' && typeof c.status === 'string' && typeof c.times_used === 'number'));

const realRunsDir = path.join(__dirname, '..', 'forge-runs');
// Fresh-install fix (2026-07-29, found by the New-project e2e proof): a brand-new project has ZERO
// runs — forge-runs/ may not even exist — so the old precondition ('at least one run exists') could
// never hold and every fresh full install went doctor-red and rolled back. The precondition is now
// vacuous when there are no run DIRECTORIES at all (nothing to validate on a fresh project), while
// the case this test actually guards — run dirs present but none carrying events.jsonl, i.e. the
// wiped-canary class — still FAILS exactly as before.
const realRunDirs = fs.existsSync(realRunsDir) ? fs.readdirSync(realRunsDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
const realRunIds = realRunDirs.filter((e) => fs.existsSync(path.join(realRunsDir, e.name, 'events.jsonl'))).map((e) => e.name);
t('run dirs, when present, include at least one real run with events.jsonl (vacuously OK on a fresh project with zero runs)', realRunDirs.length === 0 || realRunIds.length > 0);
if (realRunIds.length > 0) {
  const realRc = server.readRunContract(realRunIds[0], null);
  t('readRunContract() on a real run returns the real forge-runcontract.cjs check() shape (ok/run_id/satisfied/missing/warnings/overridden)', typeof realRc.ok === 'boolean' && realRc.run_id === realRunIds[0] && Array.isArray(realRc.satisfied) && Array.isArray(realRc.missing) && Array.isArray(realRc.warnings) && Array.isArray(realRc.overridden));
}
const badRc = server.readRunContract('definitely-not-a-real-run-xyz123-nonexistent', null);
t('readRunContract() on a nonexistent run degrades honestly (ok:false + a real error string), never throws', badRc.ok === false && typeof badRc.error === 'string' && badRc.error.length > 0);

// ---------------------------------------------------------------------------------------------------------
// 2) panels.js — headless vm render of the 'capabilities' dock tab
// ---------------------------------------------------------------------------------------------------------
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
    capabilities: null, runcontract: null,
    replay: { active: false, playing: false, cursor: 0, speed: 1 },
    ui: { insTab: 'summary', actFilter: 'all', dockTab: 'log', collapsed: new Set() },
  }, initialState || {});
  const sandbox = {
    document, console, STATE, Forge: {}, fetch: async () => { throw new Error('fetch not stubbed in this offline test'); },
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

t('panels.js registers a "capabilities" dock tab', /\[\s*['"]capabilities['"]\s*,\s*['"]Capabilities['"]\s*\]/.test(PANELS_SRC));

// a) a real inventory + a satisfied run contract renders cleanly
const REPORT_OK = {
  ok: true,
  summary: { total: 4, active: 2, dormant: 0, opt_in: 1, never_used: 1 },
  capabilities: [
    { capability: 'tool:forge-scout', name: 'forge-scout', kind: 'tool', present: true, status: 'active', times_used: 3, last_used_run: 'forge-2026-07-22-a', last_used_ts: '2026-07-22T00:00:00Z' },
    { capability: 'skill:forge-projectbrain', name: 'forge-projectbrain', kind: 'skill', present: true, status: 'opt-in', times_used: 0, last_used_run: null, last_used_ts: null },
    { capability: 'gate:deploy', name: 'deploy', kind: 'gate', present: true, status: 'active', times_used: 1, last_used_run: 'forge-2026-07-22-a', last_used_ts: '2026-07-22T00:00:00Z' },
    { capability: 'gate:spend', name: 'spend', kind: 'gate', present: false, status: 'dormant', times_used: 0, last_used_run: null, last_used_ts: null },
  ],
};
const RC_OK = { ok: true, run_id: 'forge-2026-07-22-a', domain: null, satisfied: ['memory-read', 'report-present'], missing: [], warnings: ['research-done'], overridden: [{ id: 'evidence-satisfied', note: 'override:evidence-satisfied — spike' }] };
const { sandbox: sb1, document: doc1 } = loadPanels({ capabilities: REPORT_OK, runcontract: RC_OK, run: { run_id: 'forge-2026-07-22-a' } });
t('renderDock is exposed', typeof sb1.renderDock === 'function');
sb1.STATE.ui.dockTab = 'capabilities';
sb1.renderDock();
const h1 = doc1.getElementById('dock-body').innerHTML;
t('capabilities panel renders the summary tally (4 total, 1 never used)', h1.includes('4 total') && h1.includes('1 never used'));
t('capabilities panel lists the never-used capability distinctly', h1.includes('forge-projectbrain') && h1.includes('never used'));
t('capabilities panel lists a used capability with its usage count', h1.includes('forge-scout') && h1.includes('3x'));
t('run contract section shows CONTRACT OK banner + the real run id', h1.includes('CONTRACT OK') && h1.includes('forge-2026-07-22-a'));
t('run contract section renders the satisfied/warning/overridden rows', h1.includes('SATISFIED') && h1.includes('WARN') && h1.includes('OVERRIDDEN'));
t('dock-tabs row includes a Capabilities button', doc1.getElementById('dock-tabs').innerHTML.includes('>Capabilities<'));

// b) NOT DONE run contract renders a missing-rule row + the NOT DONE banner (honest, not hidden)
const RC_BAD = { ok: false, run_id: 'forge-2026-07-22-b', domain: null, satisfied: [], missing: ['research-done'], warnings: [], overridden: [] };
const { sandbox: sb2, document: doc2 } = loadPanels({ capabilities: REPORT_OK, runcontract: RC_BAD, run: { run_id: 'forge-2026-07-22-b' } });
sb2.STATE.ui.dockTab = 'capabilities'; sb2.renderDock();
const h2 = doc2.getElementById('dock-body').innerHTML;
t('run contract section shows NOT DONE banner when a block-rule is missing', h2.includes('NOT DONE'));
t('run contract section shows a MISSING pill for the missing rule', h2.includes('research-done') && h2.includes('MISSING'));

// c) not-yet-loaded (null) -> honest "not loaded" state, never a fabricated result
const { sandbox: sb3, document: doc3 } = loadPanels({ capabilities: null, runcontract: null });
sb3.STATE.ui.dockTab = 'capabilities'; sb3.renderDock();
const h3 = doc3.getElementById('dock-body').innerHTML;
t('null capabilities renders an honest "Loading" state, never a fabricated tally', h3.includes('Loading capabilities'));
t('null runcontract renders an honest "not loaded" state', h3.includes('not loaded'));
t('empty state never fabricates a CONTRACT OK banner', !h3.includes('CONTRACT OK'));

// d) a degraded ({ok:false, error}) API result renders honestly, never as if it were clean data
const { sandbox: sb4, document: doc4 } = loadPanels({ capabilities: { ok: false, error: 'forge-capabilities.cjs not available' }, runcontract: { ok: false, error: 'forge-runcontract.cjs not available' } });
sb4.STATE.ui.dockTab = 'capabilities'; sb4.renderDock();
const h4 = doc4.getElementById('dock-body').innerHTML;
t('a degraded capabilities result is surfaced honestly, not silently blank', h4.includes('Capabilities unavailable') && h4.includes('forge-capabilities.cjs not available'));
t('a degraded run contract result is surfaced honestly', h4.includes('Run contract unavailable'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
