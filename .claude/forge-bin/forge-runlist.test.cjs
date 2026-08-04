#!/usr/bin/env node
'use strict';
/**
 * forge-runlist.test.cjs — hermetic tests for the run LISTING used by `/forge status`, `/forge runs`
 * and `/forge open-report` (`.claude/forge-dashboard/server.cjs`'s classifyRunDir/listRunIds).
 *
 * MEASURED DEFECT (audit sweep, 2026-08-03) — the listing sorted by DIRECTORY NAME and accepted every
 * directory under forge-runs/. Consequences, both observed on the real project:
 *   1. `forge-demo-10agents-layout-preview` — a run whose own run.json declares
 *      {"_demo":true,"synthetic":true,"request":"DEMO LAYOUT PREVIEW — 10 agents (geen echt werk)"} —
 *      sorted FIRST, so the owner's `/forge status` and the dashboard header presented a fabricated
 *      demo as the system's current state, and `/forge open-report` pointed at a report that does not
 *      exist (that run has no final-report.md).
 *   2. Operational directories (`_toollog`, `.hotspot-locks`, a doctor self-check dir) were counted and
 *      listed as missions: 37 "runs" for 32 real ones.
 * The gateway already had rule 2 (its FU2 fix); this file brings the CLI path in line and adds the
 * synthetic-never-wins-latest rule. Fixtures are os.mkdtemp-only — the real project is never touched.
 *
 * Run: node forge-runlist.test.cjs   (exit 0 = all pass)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
// (no child process needed: the ordering rule is tested purely and the live assertion runs in-process)

const SERVER = path.join(__dirname, '..', 'forge-dashboard', 'server.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };

function mkRun(runsDir, name, opts) {
  const dir = path.join(runsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.runJson !== undefined) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(opts.runJson), 'utf8');
  if (opts.events !== undefined) fs.writeFileSync(path.join(dir, 'events.jsonl'), opts.events, 'utf8');
  if (opts.mtimeMs) { const d = new Date(opts.mtimeMs); for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), d, d); fs.utimesSync(dir, d, d); }
  return dir;
}

// classifyRunDir and orderRunRows are pure and are tested directly against the fixtures below;
// listRunIds() reads a module-level RUNS_DIR resolved from the server's OWN install (detectProjectRoot's
// isolation guard refuses an env root that does not contain this very server), so it is exercised once
// against the real project — the tree where the defect was actually found and must stay fixed.
// (Codex review #26 caught an unused child-process import left over from an earlier attempt at that.)
const S = require(SERVER);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runlist-'));
const RUNS = path.join(TMP, '.claude', 'forge-runs');
fs.mkdirSync(RUNS, { recursive: true });

const T0 = Date.now() - 3 * 86400000;
mkRun(RUNS, 'forge-2026-08-03-real-newest', { runJson: { run_id: 'forge-2026-08-03-real-newest', status: 'completed' }, events: '{"event_type":"run_started"}\n', mtimeMs: Date.now() });
mkRun(RUNS, 'forge-2026-07-01-real-older', { runJson: { run_id: 'forge-2026-07-01-real-older' }, events: '{"event_type":"run_started"}\n', mtimeMs: T0 });
// the demo run: alphabetically LAST (so name-sort-reversed puts it first — the exact real-world shape)
mkRun(RUNS, 'zzz-demo-preview', { runJson: { _demo: true, synthetic: true, request: 'DEMO LAYOUT PREVIEW' }, events: '{"event_type":"agent_started"}\n', mtimeMs: Date.now() });
// operational directories that are NOT runs
fs.mkdirSync(path.join(RUNS, '_toollog'), { recursive: true });
fs.writeFileSync(path.join(RUNS, '_toollog', 'session-abc.jsonl'), '{"tool":"Read"}\n', 'utf8');
fs.mkdirSync(path.join(RUNS, '.hotspot-locks'), { recursive: true });

t('classifyRunDir: a directory with run.json and/or events.jsonl IS a run', () => {
  assert.strictEqual(S.classifyRunDir(path.join(RUNS, 'forge-2026-08-03-real-newest'), 'x').isRun, true);
});

t('classifyRunDir: an operational directory without run shape is NOT a run', () => {
  assert.strictEqual(S.classifyRunDir(path.join(RUNS, '_toollog'), '_toollog').isRun, false);
  assert.strictEqual(S.classifyRunDir(path.join(RUNS, '.hotspot-locks'), '.hotspot-locks').isRun, false);
});

t('classifyRunDir: a run that declares itself _demo/synthetic is flagged as such', () => {
  const c = S.classifyRunDir(path.join(RUNS, 'zzz-demo-preview'), 'zzz-demo-preview');
  assert.strictEqual(c.isRun, true);
  assert.strictEqual(c.synthetic, true);
});

t('classifyRunDir: an unreadable run.json is NOT treated as evidence of anything (stays a normal run)', () => {
  const dir = mkRun(RUNS, 'broken-json', { events: '{"event_type":"run_started"}\n' });
  fs.writeFileSync(path.join(dir, 'run.json'), '{not json', 'utf8');
  const c = S.classifyRunDir(dir, 'broken-json');
  assert.strictEqual(c.isRun, true);
  assert.strictEqual(c.synthetic, false);
});

// The ORDERING rule is tested purely (server.cjs deliberately refuses to be pointed at a fixture
// project — detectProjectRoot()'s isolation guard requires the env root to contain THIS very install,
// which is exactly the protection that stops a dashboard serving another project's runs).
t('orderRunRows: newest REAL run first — a synthetic demo never wins "latest"', () => {
  const rows = [
    { name: 'zzz-demo-preview', synthetic: true, recency: 9999 },   // newest AND alphabetically last
    { name: 'forge-real-older', synthetic: false, recency: 100 },
    { name: 'forge-real-newest', synthetic: false, recency: 500 },
  ];
  assert.deepStrictEqual(S.orderRunRows(rows).map((r) => r.name), ['forge-real-newest', 'forge-real-older', 'zzz-demo-preview']);
});

t('orderRunRows: ordering is by real recency, not by directory name', () => {
  const rows = [
    { name: 'aaa-newest', synthetic: false, recency: 900 },
    { name: 'zzz-oldest', synthetic: false, recency: 100 },
  ];
  assert.deepStrictEqual(S.orderRunRows(rows).map((r) => r.name), ['aaa-newest', 'zzz-oldest']);
});

// One assertion against the REAL project — the defect was found there and must stay fixed there.
t('live project: the newest run reported to /forge status is NOT a synthetic demo', () => {
  const ids = S.listRunIds();
  assert.ok(ids.length > 0, 'the real project must list at least one run');
  const first = S.classifyRunDir(path.join(__dirname, '..', 'forge-runs', ids[0]), ids[0]);
  assert.strictEqual(first.synthetic, false, 'ids[0] is a synthetic run: ' + ids[0]);
  assert.ok(!ids.includes('_toollog') && !ids.includes('.hotspot-locks'), 'operational dirs still listed as runs');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
