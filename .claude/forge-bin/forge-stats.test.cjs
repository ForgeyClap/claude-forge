#!/usr/bin/env node
'use strict';
/** Hermetic, offline tests for forge-stats.cjs. Builds a fixture project root under os.mkdtemp (registry +
 *  forge-runs with 3 runs: mixed "Build Boss"/"build-boss" name forms, a rework case, a malformed event
 *  line, and a run without run.json) and runs the REAL CLI via spawnSync with FORGE_PROJECT_ROOT pointed
 *  at the fixture — never touches this real project's .claude/forge-runs/. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'forge-stats.cjs');
let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-stats-test-'));
  fs.mkdirSync(path.join(root, '.claude', 'config', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'), JSON.stringify({
    agents: {
      boss: { name: 'Boss' }, 'head-chef': { name: 'Head Chef' }, 'build-boss': { name: 'Build Boss' },
      'test-boss': { name: 'Test Boss' }, 'review-boss': { name: 'Review Boss' },
    },
  }));
  return root;
}
function writeRun(root, id, runJson, lines) {
  const dir = path.join(root, '.claude', 'forge-runs', id);
  fs.mkdirSync(dir, { recursive: true });
  if (runJson) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(runJson));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return dir;
}
function run(root, ...args) { return spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...process.env, FORGE_PROJECT_ROOT: root }, encoding: 'utf8' }); }

console.log('forge-stats offline tests (hermetic fixture project root)');

// ---- fixture: 3 runs (run-a/run-b "website", run-c no run.json -> "unknown") ----
const ROOT = mkRoot();
writeRun(ROOT, 'run-a', { project_type: 'website' }, [
  { event_type: 'subagent_started', agent: 'Build Boss' },
  { event_type: 'subagent_completed', agent: 'build-boss' }, // lower-case slug form — must fold with "Build Boss"
  { event_type: 'quality_gate_passed', agent: 'Build Boss' },
  { event_type: 'subagent_started', agent: 'Test Boss' },
  { event_type: 'subagent_completed', agent: 'Test Boss' },
]);
writeRun(ROOT, 'run-b', { project_type: 'website' }, [
  { event_type: 'subagent_started', agent: 'Build Boss' },
  { event_type: 'subagent_completed', agent: 'Build Boss' },
  { event_type: 'rework_task_created', target: 'build-boss', issue: 'bug found in review' },
  { event_type: 'subagent_started', agent: 'Build Boss' },
  { event_type: 'subagent_completed', agent: 'Build Boss' },
]);
writeRun(ROOT, 'run-c', null, [ // no run.json -> project_type "unknown"
  { event_type: 'subagent_started', agent: 'Build Boss' },
  '{not valid json',                 // malformed line — must be skipped + counted, never crash
  { event_type: 'subagent_completed', agent: 'Build Boss' },
]);

// snapshot raw bytes of every events.jsonl BEFORE running, to prove READ-ONLY afterwards
const eventsPaths = ['run-a', 'run-b', 'run-c'].map((id) => path.join(ROOT, '.claude', 'forge-runs', id, 'events.jsonl'));
const before = eventsPaths.map((p) => fs.readFileSync(p));

// 1/2/3/4/6) default run: counts, rework, first-pass, per-type, STATS.json shape
const r1 = run(ROOT);
t('default run exits 0', r1.status === 0);
const statsPath = path.join(ROOT, '.claude', 'forge-runs', 'STATS.json');
t('STATS.json written by default', fs.existsSync(statsPath));
const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));

t('runs_scanned counts all 3 fixture runs', stats.runs_scanned === 3);
t('malformed_skipped counts the 1 bad line in run-c', stats.malformed_skipped === 1);
t('generated_at is an ISO timestamp string', typeof stats.generated_at === 'string' && !Number.isNaN(Date.parse(stats.generated_at)));

// counts correct per boss (both "Build Boss" and "build-boss" folded into ONE slug)
t('perBoss has exactly one build-boss entry (no separate "Build Boss" key)', Object.keys(stats.perBoss).includes('build-boss') && !Object.keys(stats.perBoss).includes('Build Boss'));
const bb = stats.perBoss['build-boss'];
t('build-boss dispatched = 4 (1 + 2 + 1 across runs a/b/c)', bb.dispatched === 4);
t('build-boss completed = 4 (both name forms folded and counted)', bb.completed === 4);
t('build-boss failed = 0 (no failure events in fixture)', bb.failed === 0);
t('build-boss gates_passed = 1 (quality_gate_passed in run-a)', bb.gates_passed === 1);
t('build-boss gates_blocked = 0', bb.gates_blocked === 0);

// rework_received counted from the target/to field, not the reporting agent
t('build-boss rework_received = 1 (from rework_task_created target:"build-boss" in run-b)', bb.rework_received === 1);

// first_pass_success: run-a and run-c had zero rework -> first-pass; run-b had rework -> not first-pass
t('build-boss total_runs_with_boss = 3', bb.total_runs_with_boss === 3);
t('build-boss first_pass_runs = 2 (run-a + run-c; run-b excluded by its rework)', bb.first_pass_runs === 2);
t('build-boss first_pass_rate = 67% (2/3, rounded)', bb.first_pass_rate === 67);

const tb = stats.perBoss['test-boss'];
t('test-boss completed = 1, never reworked -> first_pass_rate 100%', tb.completed === 1 && tb.first_pass_rate === 100);

// per-type aggregation
t('perType has "website" and "unknown" (run-c had no run.json)', Object.keys(stats.perType).sort().join(',') === 'unknown,website');
const website = stats.perType.website['build-boss'];
t('website/build-boss completed = 3 (run-a 1 + run-b 2)', website.completed === 3);
t('website/build-boss rework_received = 1', website.rework_received === 1);
t('website/build-boss rework_rate = 50% (1 of 2 runs reworked)', website.rework_rate === 50);
const unknown = stats.perType.unknown['build-boss'];
t('unknown/build-boss completed = 1 (run-c), rework_rate 0%', unknown.completed === 1 && unknown.rework_rate === 0);

// 5) advisory does NOT fire below min-samples (default min-samples=3; website/build-boss only has 2 runs)
t('default thresholds: no advisory fires (website/build-boss has 2 runs < min-samples 3)', stats.advisories.length === 0);

// 5b) advisory FIRES once min-samples is lowered to match the real sample count
const r2 = run(ROOT, '--min-samples', '2', '--threshold', '40');
t('lowered-threshold run exits 0', r2.status === 0);
const stats2 = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
t('advisory fires for build-boss/website (50% >= 40% threshold, 2 >= 2 min-samples)', stats2.advisories.some((a) => /build-boss/.test(a) && /50%/.test(a) && /2 runs/.test(a) && /website/.test(a)));

// 7) malformed line never crashes the run (already proven by r1.status===0 above); also assert clean stderr
t('malformed-line run produced no exception noise on stderr', !/Error|TypeError/.test(r1.stderr));

// 6b) --no-write leaves STATS.json absent
const ROOT2 = mkRoot();
writeRun(ROOT2, 'solo', { project_type: 'n8n' }, [
  { event_type: 'subagent_started', agent: 'Build Boss' },
  { event_type: 'subagent_completed', agent: 'Build Boss' },
]);
const r3 = run(ROOT2, '--no-write');
t('--no-write run exits 0', r3.status === 0);
t('--no-write leaves STATS.json absent', !fs.existsSync(path.join(ROOT2, '.claude', 'forge-runs', 'STATS.json')));
t('--no-write still prints the table output', /build-boss/.test(r3.stdout));

// 8) zero runs -> honest empty output, exit 0
const ROOT3 = mkRoot(); // registry present, forge-runs dir present but empty
const r4 = run(ROOT3);
t('zero-runs exits 0', r4.status === 0);
const stats4 = JSON.parse(fs.readFileSync(path.join(ROOT3, '.claude', 'forge-runs', 'STATS.json'), 'utf8'));
t('zero-runs: runs_scanned = 0', stats4.runs_scanned === 0);
t('zero-runs: perBoss is honestly empty', Object.keys(stats4.perBoss).length === 0);
t('zero-runs: advisories is honestly empty', stats4.advisories.length === 0);
t('zero-runs table output says so honestly', /no Boss activity/.test(r4.stdout));

// --json prints the object instead of the table
const r5 = run(ROOT, '--json');
t('--json exits 0', r5.status === 0);
let parsedJson = null; try { parsedJson = JSON.parse(r5.stdout); } catch {}
t('--json stdout parses as JSON with perBoss', !!parsedJson && !!parsedJson.perBoss);

// usage errors -> exit 2
const rBadThreshold = run(ROOT, '--threshold');
t('--threshold with no value exits 2 (usage error)', rBadThreshold.status === 2);
const rUnknownFlag = run(ROOT, '--not-a-real-flag');
t('unknown flag exits 2 (usage error)', rUnknownFlag.status === 2);

// 9) READ-ONLY proof: every run's events.jsonl is byte-identical after all the runs above
const after = eventsPaths.map((p) => fs.readFileSync(p));
t('events.jsonl files are byte-identical before/after (READ-ONLY proof)', before.every((buf, i) => Buffer.compare(buf, after[i]) === 0));
// run.json for run-a/run-b likewise untouched
const runJsonA = fs.readFileSync(path.join(ROOT, '.claude', 'forge-runs', 'run-a', 'run.json'), 'utf8');
t('run.json content still parses with the original project_type (untouched)', JSON.parse(runJsonA).project_type === 'website');

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
