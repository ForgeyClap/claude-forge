#!/usr/bin/env node
'use strict';
/**
 * forge-registry.cjs — GLOBAL, opt-in, READ-ONLY Forge project registry (Mission Control Phase 2, WP6).
 * Windows-safe, zero-dependency.
 *
 * Scans every Forge project under a root (default: ~/Documents, same walk as forge-sync.cjs
 * findForgeProjects) and produces a cross-project aggregate:
 *   <home>/.claude/forge/registry/projects.json   — the machine-readable index
 *   <home>/.claude/forge/registry/index.html       — a self-contained home-view (data inlined; opens from file://)
 *
 * HARD ISOLATION RULE (do not break): this tool READS other projects' .claude/ (its explicit opt-in
 * aggregation job) but MUST NEVER WRITE into any scanned project. The ONLY thing it writes is the global
 * registry dir. It never runs automatically — it is a CLI you invoke deliberately (`scan`). Every project
 * record is redacted (forge-store.redactValue) before it is written, as defense in depth.
 *
 * CLI:
 *   node forge-registry.cjs scan [--root <dir>] [--run <run_id>] [--json]
 *     --root <dir>  scan base (default ~/Documents). --json also prints the index to stdout.
 *     --run <id>    log a `registry_scanned` event to that run's dashboard events (already-registered type).
 *
 * TEST ISOLATION: set FORGE_REGISTRY_HOME to redirect the OUTPUT dir at a throwaway temp dir — never
 * points the real ~/.claude/forge/registry/ during tests.
 *
 * Module API: require('./forge-registry.cjs') ->
 *   { findProjects, readProject, scanProjects, writeRegistry, registryHome }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { redactValue } = require('./forge-store.cjs');

// same skip set + walk shape as forge-sync.cjs findForgeProjects (kept in sync deliberately)
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'graphify-out']);

function homeDir() { return process.env.USERPROFILE || process.env.HOME || os.homedir(); }
function defaultRoot() { return path.join(homeDir(), 'Documents'); }

/** findProjects(root, maxDepth) — bounded read-only walk; a project = a dir containing .claude/forge-dashboard. */
function findProjects(root, maxDepth) {
  maxDepth = maxDepth == null ? 3 : maxDepth;
  root = path.resolve(root || defaultRoot());
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (fs.existsSync(path.join(dir, '.claude', 'forge-dashboard'))) { out.push(dir); return; } // don't recurse into a found project
    if (depth === maxDepth) return;
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  let top = []; try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of top) { if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(root, e.name), 1); }
  return out;
}

function readJsonGuarded(file) {
  try { const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); return JSON.parse(raw); } catch { return null; }
}
function readTextGuarded(file) { try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return null; } }

// stack from FORGE_PROJECT_PROFILE.md's "Detected stack:" line (guarded, first ~120 chars)
function stackFromProfile(projDir) {
  const txt = readTextGuarded(path.join(projDir, '.claude', 'FORGE_PROJECT_PROFILE.md'));
  if (!txt) return null;
  const m = txt.match(/(?:detected\s+stack|stack)\s*:\**\s*([^\n]+)/i);
  if (!m) return null;
  return m[1].replace(/[*_`]/g, '').trim().slice(0, 120) || null;
}

/** newest run.json in .claude/forge-runs/ — prefer the state's latest_run_id, else the highest-sorting run dir. */
function newestRun(projDir, preferredId) {
  const runsDir = path.join(projDir, '.claude', 'forge-runs');
  if (preferredId && /^[A-Za-z0-9_-]+$/.test(preferredId)) {
    const j = readJsonGuarded(path.join(runsDir, preferredId, 'run.json'));
    if (j) return j;
  }
  let ids = []; try { ids = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  ids.sort(); // run ids are date-stamped, so lexical sort ≈ chronological
  for (let i = ids.length - 1; i >= 0; i--) { const j = readJsonGuarded(path.join(runsDir, ids[i], 'run.json')); if (j) return j; }
  return null;
}

function countTickets(projDir) {
  const dir = path.join(projDir, '.claude', 'forge-tickets');
  let files = []; try { files = fs.readdirSync(dir); } catch { return 0; }
  return files.filter((f) => f.endsWith('.json') && f !== 'index.jsonl').length;
}

// test_status from the newest run's doctor.json, if one exists (WP7 produces these); else 'unknown'.
function testStatus(projDir, runId) {
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) return 'unknown';
  const doc = readJsonGuarded(path.join(projDir, '.claude', 'forge-runs', runId, 'doctor.json'));
  if (!doc) return 'unknown';
  if (typeof doc.ok === 'boolean') return doc.ok ? 'pass' : 'fail';
  if (doc.status) return String(doc.status);
  return 'unknown';
}

/** readProject(dir) — guarded, READ-ONLY. Returns one registry record; never throws, defaults on missing data. */
function readProject(dir) {
  try {
    const dash = path.join(dir, '.claude', 'forge-dashboard');
    const state = readJsonGuarded(path.join(dash, 'DASHBOARD_STATE.json')) || {};
    const name = state.project_name || path.basename(dir);
    const portTxt = readTextGuarded(path.join(dash, 'PORT'));
    const port = (portTxt && portTxt.trim()) || (state.last_actual_port || state.preferred_port || null);
    const run = newestRun(dir, state.latest_run_id);
    const lastRunId = (run && run.run_id) || state.latest_run_id || null;
    return {
      project_id: state.project_id || name,
      name,
      path: dir,
      stack: (run && run.stack) || stackFromProfile(dir) || 'unknown',
      status: state.status || 'unknown',
      last_run_id: lastRunId,
      last_run_status: (run && run.status) || 'unknown',
      last_run_at: (run && (run.completed || run.started)) || state.last_started_at || null,
      open_tickets: countTickets(dir),
      test_status: testStatus(dir, lastRunId),
      port: port ? String(port) : null,
    };
  } catch { return null; }
}

/** scanProjects(root) — findProjects then readProject each; skips a project that fails to read. Never throws. */
function scanProjects(root) {
  return findProjects(root).map(readProject).filter(Boolean);
}

function registryHome() {
  if (process.env.FORGE_REGISTRY_HOME) return path.resolve(process.env.FORGE_REGISTRY_HOME);
  return path.join(homeDir(), '.claude', 'forge', 'registry');
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderHtml(projects, generatedAt) {
  const rows = projects.map((p) => {
    const st = String(p.status || 'unknown').toLowerCase();
    const ts = String(p.test_status || 'unknown').toLowerCase();
    return '<article class="card">'
      + '<div class="ct"><span class="nm">' + esc(p.name) + '</span><span class="pill st-' + esc(st) + '">' + esc(p.status || 'unknown') + '</span></div>'
      + '<div class="pth">' + esc(p.path) + '</div>'
      + '<div class="grid">'
      + kv('stack', p.stack) + kv('port', p.port || '—')
      + kv('last run', p.last_run_id || '—') + kv('run status', p.last_run_status || '—')
      + kv('open tickets', String(p.open_tickets)) + kv('tests', '<span class="pill ts-' + esc(ts) + '">' + esc(p.test_status || 'unknown') + '</span>', true)
      + kv('last activity', p.last_run_at ? esc(p.last_run_at) : '—')
      + '</div></article>';
  }).join('');
  const empty = '<div class="empty">No Forge projects found — run <code>forge-registry scan</code> from any Forge project.</div>';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Forge Registry</title><style>'
    + ':root{--bg:#0b0e14;--panel:#141924;--line:#232a38;--ink:#e6edf3;--ink2:#8b98ab;--cyan:#39d3c3;--green:#57d18a;--red:#e05561;--amber:#e0b055;}'
    + '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}'
    + 'header{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px}'
    + 'h1{margin:0;font-size:18px;letter-spacing:.5px}.sub{color:var(--ink2);font-size:12px}'
    + 'main{padding:20px 24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}'
    + '.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}'
    + '.ct{display:flex;justify-content:space-between;align-items:center;gap:8px}.nm{font-weight:600;font-size:15px}'
    + '.pth{color:var(--ink2);font-size:11px;margin:4px 0 10px;word-break:break-all}'
    + '.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px}'
    + '.kv{display:flex;flex-direction:column}.kv .l{color:var(--ink2);font-size:10px;text-transform:uppercase;letter-spacing:.4px}.kv .v{font-size:13px}'
    + '.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line)}'
    + '.st-ready,.st-completed,.ts-pass{color:var(--green);border-color:var(--green)}'
    + '.st-failed,.ts-fail{color:var(--red);border-color:var(--red)}.ts-unknown,.st-unknown{color:var(--ink2)}'
    + '.empty{grid-column:1/-1;color:var(--ink2);text-align:center;padding:40px}code{color:var(--cyan)}'
    + '</style></head><body>'
    + '<header><h1>⚒ Forge Project Registry</h1><span class="sub">' + projects.length + ' project(s) · generated ' + esc(generatedAt) + ' · read-only aggregate</span></header>'
    + '<main>' + (projects.length ? rows : empty) + '</main>'
    + '<script>window.__REGISTRY__=' + JSON.stringify(projects).replace(/</g, '\\u003c') + ';</script>'
    + '</body></html>';
}
function kv(l, v, raw) { return '<div class="kv"><span class="l">' + esc(l) + '</span><span class="v">' + (raw ? v : esc(v)) + '</span></div>'; }

/** writeRegistry(projects) — redacts every record, then writes projects.json + index.html to the GLOBAL
 *  registry dir ONLY. Returns { dir, count }. Never writes into a scanned project. */
function writeRegistry(projects) {
  const safe = redactValue(projects); // defense-in-depth: never persist a raw secret
  const generatedAt = new Date().toISOString();
  const dir = registryHome();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ generated_at: generatedAt, projects: safe }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'index.html'), renderHtml(safe, generatedAt), 'utf8');
  return { dir, count: safe.length };
}

function logEvent(runId, eventType, extra) {
  const logEventPath = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
  return spawnSync(process.execPath, [logEventPath, runId, eventType, JSON.stringify(extra || {})], { encoding: 'utf8' });
}

module.exports = { findProjects, readProject, scanProjects, writeRegistry, registryHome };

// ---- CLI (opt-in only; never scans/writes on require) ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    if (cmd !== 'scan') { console.error('Usage: node forge-registry.cjs scan [--root <dir>] [--run <id>] [--json]'); process.exitCode = 1; return; }
    let root = null, run = null, wantJson = false;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--root') root = argv[++i];
      else if (argv[i] === '--run') run = argv[++i];
      else if (argv[i] === '--json') wantJson = true;
    }
    const projects = scanProjects(root);
    const res = writeRegistry(projects);
    if (run) { const e = logEvent(run, 'registry_scanned', { agent: 'orchestrator', note: 'registry scanned: ' + res.count + ' projects', count: res.count }); if (e.status !== 0) console.error('forge-registry: log-event warning: ' + (e.stderr || '').trim()); }
    if (wantJson) console.log(JSON.stringify(projects, null, 2));
    console.log(res.count + ' project(s) -> ' + path.join(res.dir, 'index.html'));
  };
  try { main(); } catch (e) { console.error('forge-registry: ' + e.message); process.exitCode = 1; }
}
