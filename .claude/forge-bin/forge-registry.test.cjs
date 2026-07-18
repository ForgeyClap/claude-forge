#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-registry.cjs — builds fake projects in an os.mkdtemp scan-root and writes the
 *  registry to a SEPARATE FORGE_REGISTRY_HOME temp dir. Never touches the real ~/.claude or real projects. */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reg-scan-'));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reg-out-'));
process.env.FORGE_REGISTRY_HOME = OUT;
const R = require('./forge-registry.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

function mkProject(name, opts) {
  opts = opts || {};
  const dir = path.join(SCAN, name);
  const dash = path.join(dir, '.claude', 'forge-dashboard');
  fs.mkdirSync(dash, { recursive: true });
  fs.writeFileSync(path.join(dash, 'server.cjs'), '// forge dashboard server\n');
  fs.writeFileSync(path.join(dash, 'DASHBOARD_STATE.json'), JSON.stringify(opts.state || { project_name: name, status: 'ready', latest_run_id: 'run-1' }));
  if (opts.port != null) fs.writeFileSync(path.join(dash, 'PORT'), String(opts.port));
  const runDir = path.join(dir, '.claude', 'forge-runs', 'run-1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), opts.runJson != null ? opts.runJson : JSON.stringify({ run_id: 'run-1', status: 'completed', stack: 'node', started: '2026-07-10T00:00:00Z' }));
  const tix = path.join(dir, '.claude', 'forge-tickets');
  fs.mkdirSync(tix, { recursive: true });
  const nt = opts.tickets == null ? 2 : opts.tickets;
  for (let i = 1; i <= nt; i++) fs.writeFileSync(path.join(tix, 'tk-' + i + '.json'), JSON.stringify({ ticket_id: 'tk-' + i, status: 'open' }));
  fs.writeFileSync(path.join(tix, 'index.jsonl'), '{"id":"tk-1"}\n'); // must be excluded from the count
  return dir;
}

// two clean projects + one with a malformed run.json (must not crash; defaults apply)
const FAKE_SECRET = '\x6Evapi-FAKEFAKEFAKEFAKE1234567890';
mkProject('alpha', { port: 3801, state: { project_name: 'alpha', status: 'ready', latest_run_id: 'run-1' } });
mkProject('beta', { port: 3802, state: { project_name: 'beta ' + FAKE_SECRET, status: 'ready', latest_run_id: 'run-1' } });
const gammaDir = mkProject('gamma', { port: 3803, runJson: '{ this is not valid json ', state: { project_name: 'gamma', status: 'ready' } });

// snapshot every scanned project's file tree BEFORE scan+write (isolation proof)
function snapshot(dir) { const out = []; (function w(d) { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); out.push(p); if (e.isDirectory()) w(p); } })(dir); return out.sort().join('\n'); }
const before = fs.readdirSync(SCAN).map((n) => [n, snapshot(path.join(SCAN, n))]);

// 1) scanProjects finds all 3
const projects = R.scanProjects(SCAN);
t('scanProjects finds 3 projects', projects.length === 3);
const byName = Object.fromEntries(projects.map((p) => [p.name.split(' ')[0], p]));
t('alpha read: name + port', byName.alpha && byName.alpha.port === '3801');
t('alpha read: open_tickets=2 (index.jsonl excluded)', byName.alpha && byName.alpha.open_tickets === 2);
t('alpha read: stack from run.json', byName.alpha && byName.alpha.stack === 'node');
t('alpha read: last_run_status completed', byName.alpha && byName.alpha.last_run_status === 'completed');
t('gamma with malformed run.json did NOT crash and is present', !!byName.gamma);
t('gamma malformed run -> run status defaults to unknown', byName.gamma && byName.gamma.last_run_status === 'unknown');

// 2) writeRegistry writes projects.json + index.html to FORGE_REGISTRY_HOME (not the real home)
const res = R.writeRegistry(projects);
t('writeRegistry reports 3', res.count === 3);
t('projects.json written to FORGE_REGISTRY_HOME', fs.existsSync(path.join(OUT, 'projects.json')));
t('index.html written to FORGE_REGISTRY_HOME', fs.existsSync(path.join(OUT, 'index.html')));

// 3) fake secret redacted from BOTH outputs
const jsonOut = fs.readFileSync(path.join(OUT, 'projects.json'), 'utf8');
const htmlOut = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
t('fake secret absent from projects.json', !jsonOut.includes(FAKE_SECRET));
t('fake secret absent from index.html', !htmlOut.includes(FAKE_SECRET));
t('redaction marker present (beta name was redacted)', jsonOut.includes('***REDACTED***'));

// 4) ISOLATION: no new files created inside any scanned project dir
const after = fs.readdirSync(SCAN).map((n) => [n, snapshot(path.join(SCAN, n))]);
const beforeMap = Object.fromEntries(before), afterMap = Object.fromEntries(after);
let isolated = true;
for (const n of Object.keys(afterMap)) { if (beforeMap[n] !== afterMap[n]) { isolated = false; console.error('    changed inside scanned project: ' + n); } }
t('ISOLATION: scan+write created NO files inside any scanned project', isolated === true);

// 5) requiring the module did not scan/write (registryHome empty until writeRegistry ran above is fine;
//    prove require.main guard by checking the module exposes fns without side effects) — implicit: this
//    test file requires it and nothing was written to OUT until we explicitly called writeRegistry.
t('module exports the API', typeof R.scanProjects === 'function' && typeof R.writeRegistry === 'function' && typeof R.findProjects === 'function');

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
