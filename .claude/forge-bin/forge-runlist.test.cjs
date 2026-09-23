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
// FRESH-INSTALL FIX (2026-08-06, a card-game project): a just-installed project has NO runs yet — `ids.length > 0`
// made every fresh install fail its own doctor on history it cannot possibly have (the same class as the
// canary precondition seedCanaryRun exists for). Zero runs is now a vacuous, honestly-reported pass: the
// property under test ("the newest listed run is not a synthetic demo") is about what IS listed, and an
// empty listing lists no demo. The moment the project has any real run, the full assertion bites again.
t('live project: the newest run reported to /forge status is NOT a synthetic demo', () => {
  const ids = S.listRunIds();
  if (ids.length === 0) {
    // CODEX ronde-3 #12 (2026-08-06): een lege lijst is alleen een eerlijke vacuous pass als de
    // forge-runs-map OOK ECHT leeg is — anders zou een listRunIds()-regressie die altijd [] retourneert
    // deze test permanent groen maken op een project vol echte runs. Onafhankelijk van de selector
    // gecontroleerd, rechtstreeks op het bestandssysteem.
    const runsDir = path.join(__dirname, '..', 'forge-runs');
    let runShaped = [];
    try {
      runShaped = fs.readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '_toollog')
        .filter((e) => fs.existsSync(path.join(runsDir, e.name, 'events.jsonl')));
    } catch { /* geen forge-runs-map: echt vers */ }
    assert.strictEqual(runShaped.length, 0,
      'listRunIds() returned [] but ' + runShaped.length + ' run-shaped dir(s) exist on disk (e.g. ' + (runShaped[0] && runShaped[0].name) + ') — the selector regressed, this is not a fresh install');
    console.log('    (fresh install: no runs yet — nothing listed, so no demo can be listed; assertion arms itself on the first real run)');
    return;
  }
  const first = S.classifyRunDir(path.join(__dirname, '..', 'forge-runs', ids[0]), ids[0]);
  assert.strictEqual(first.synthetic, false, 'ids[0] is a synthetic run: ' + ids[0]);
  assert.ok(!ids.includes('_toollog') && !ids.includes('.hotspot-locks'), 'operational dirs still listed as runs');
});

// ============================================================================================
// ONE SELECTOR, ONE TRUTH (Codex adversarial review #18/#19/#20, 2026-08-03).
// latestRunId() used to re-select independently by run.json.started, ignoring the synthetic flag — so a
// demo carrying a later `started` than any real run silently won "latest" again, undoing the listing fix
// for every consumer that asks for "the current run" (health, state, dashboard header). Recency also took
// the MAX of events/run.json/dir mtime, so writing any new child file into an old run (say a report)
// bumped it above a genuinely newer run. And a truncated run.json failed open as an ordinary real run.
// ============================================================================================
t('classifyRunDir: PRESENT-but-unparseable run.json is flagged malformed (absent is NOT malformed)', () => {
  const brokenDir = mkRun(RUNS, 'broken-json-2', { events: '{"event_type":"run_started"}\n' });
  fs.writeFileSync(path.join(brokenDir, 'run.json'), '{ "_demo": true', 'utf8'); // truncated demo marker
  const c = S.classifyRunDir(brokenDir, 'broken-json-2');
  assert.strictEqual(c.isRun, true);
  assert.strictEqual(c.malformed, true, 'a truncated run.json must not read as trustworthy metadata');
  const noMeta = S.classifyRunDir(path.join(RUNS, 'forge-2026-07-01-real-older'), 'x');
  assert.strictEqual(!!noMeta.malformed, false, 'a run WITHOUT run.json is ordinary, not malformed');
});

t('recency prefers the newest EVENT over a directory mtime bumped by an unrelated child write', () => {
  const old = mkRun(RUNS, 'recency-old', { events: '{"event_type":"run_started"}\n', mtimeMs: Date.now() - 5 * 86400000 });
  const before = S.classifyRunDir(old, 'recency-old').recency;
  // dropping a new file into the old run bumps the DIRECTORY mtime to now
  fs.writeFileSync(path.join(old, 'final-report.md'), '# late report\n', 'utf8');
  const after = S.classifyRunDir(old, 'recency-old').recency;
  assert.strictEqual(after, before, 'an unrelated child write must not make an old run look newest');
});

t('live project: latestRunId() and the listing agree — one selector, never a second opinion', () => {
  const id = S.latestRunId();
  if (id === null) { assert.ok(true, 'no eligible real run — honest null rather than presenting a demo'); return; }
  const c = S.classifyRunDir(path.join(__dirname, '..', 'forge-runs', id), id);
  assert.strictEqual(c.synthetic, false, 'latestRunId returned a synthetic run: ' + id);
  assert.strictEqual(!!c.malformed, false, 'latestRunId returned a run with unreadable metadata: ' + id);
  assert.strictEqual(id, S.listRunIds()[0], 'latestRunId disagrees with the listing it is supposed to share');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
