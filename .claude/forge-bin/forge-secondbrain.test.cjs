#!/usr/bin/env node
'use strict';
// forge-secondbrain.test.cjs — real tests for the READ-ONLY, evidence-cited portfolio strategist
// (2026-07-19). Every fixture lives under a fresh os.tmpdir() "portfolio" of fake project dirs — this file
// NEVER reads or writes any of THIS repo's real .claude/ content. The seeded ".env" fixture files below
// intentionally hold a placeholder-looking string, never a real credential shape, and this tool never opens
// a .env's contents anyway (see forge-secondbrain.cjs guardrail 2).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const sb = require('./forge-secondbrain.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function buildFakeProject(root, name, claudeFiles, rootFiles) {
  const projectDir = path.join(root, name);
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  for (const [filename, content] of Object.entries(claudeFiles || {})) fs.writeFileSync(path.join(claudeDir, filename), content, 'utf8');
  for (const [filename, content] of Object.entries(rootFiles || {})) fs.writeFileSync(path.join(projectDir, filename), content, 'utf8');
  return projectDir;
}
function gitInit(projectDir) {
  spawnSync('git', ['init', '-q'], { cwd: projectDir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: projectDir, encoding: 'utf8' });
}
function gitAddCommit(projectDir, files) {
  spawnSync('git', ['add', ...files], { cwd: projectDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-q', '-m', 'seed fixture'], { cwd: projectDir, encoding: 'utf8' });
}
function trackFsCalls(methodNames) {
  const calls = {}; const originals = {};
  for (const m of methodNames) {
    calls[m] = [];
    originals[m] = fs[m];
    fs[m] = function (...args) { calls[m].push(args[0]); return originals[m].apply(fs, args); };
  }
  return { calls, restore() { for (const m of methodNames) fs[m] = originals[m]; } };
}
function daysAgoMs(days) { return Date.now() - days * 86400000; }
function setMtime(absPath, whenMs) { const d = new Date(whenMs); fs.utimesSync(absPath, d, d); }

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

const CLI = path.join(__dirname, 'forge-secondbrain.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

console.log('forge-secondbrain tests (read-only, evidence-cited portfolio strategist)');

// ---------------------------------------------------------------------------
// 1) discovery reuses forge-harvest.cjs verbatim (guardrail 3)
// ---------------------------------------------------------------------------
console.log('\n1) discoverProjects() reuses forge-harvest.cjs::discover()');

t('discoverProjects() with neither projects nor scanDir returns []', () => {
  assert.deepStrictEqual(sb.discoverProjects({}), []);
});

t('discoverProjects() finds only marker-carrying immediate children (same rule as forge-harvest)', () => {
  const portfolio = freshRoot('sb-discover');
  buildFakeProject(portfolio, 'proj-a', { 'FORGE_MEMORY.md': '# memory\n' });
  fs.mkdirSync(path.join(portfolio, 'unmarked'), { recursive: true });
  const found = sb.discoverProjects({ scanDir: portfolio });
  assert.deepStrictEqual(found.map((f) => f.project), ['proj-a']);
});

// ---------------------------------------------------------------------------
// 2) a committed .env is flagged, evidence-cited; an untracked .env is not falsely called "committed"
// ---------------------------------------------------------------------------
console.log('\n2) committed .env detection (evidence-cited, never opens contents)');

if (HAS_GIT) {
  t('a project with a git-TRACKED .env is flagged env_committed, with real evidence', () => {
    const portfolio = freshRoot('sb-env-committed');
    const projectDir = buildFakeProject(portfolio, 'proj-env', { 'FORGE_MEMORY.md': '# memory\n' }, { '.env': 'PLACEHOLDER_TOKEN=not-a-real-secret\n' });
    gitInit(projectDir);
    gitAddCommit(projectDir, ['.env', '.claude/FORGE_MEMORY.md']);
    const findings = sb.checkEnvSignals({ project: 'proj-env', path: projectDir });
    const hit = findings.find((f) => f.type === 'env_committed');
    assert.ok(hit, 'expected an env_committed finding');
    assert.strictEqual(hit.evidence.project, 'proj-env');
    assert.strictEqual(hit.evidence.file, '.env');
    assert.ok(/tracked/.test(hit.evidence.fact));
    assert.ok(sb.hasRealEvidence(hit));
  });

  t('a project with an UNTRACKED (git-ignored/never-added) .env is NOT flagged as committed', () => {
    const portfolio = freshRoot('sb-env-untracked');
    const projectDir = buildFakeProject(portfolio, 'proj-env-un', { 'FORGE_MEMORY.md': '# memory\n' }, { '.env': 'PLACEHOLDER_TOKEN=not-a-real-secret\n' });
    gitInit(projectDir);
    gitAddCommit(projectDir, ['.claude/FORGE_MEMORY.md']); // .env deliberately never added
    const findings = sb.checkEnvSignals({ project: 'proj-env-un', path: projectDir });
    assert.ok(!findings.some((f) => f.type === 'env_committed'), 'an untracked .env must never be reported as committed');
  });
}

t('checkEnvSignals NEVER calls fs.readFileSync on the .env file itself', () => {
  const portfolio = freshRoot('sb-env-noread');
  const projectDir = buildFakeProject(portfolio, 'proj-env-noread', { 'FORGE_MEMORY.md': '# memory\n' }, { '.env': 'PLACEHOLDER_TOKEN=not-a-real-secret\n' });
  const tracker = trackFsCalls(['readFileSync']);
  try { sb.checkEnvSignals({ project: 'proj-env-noread', path: projectDir }); }
  finally { tracker.restore(); }
  assert.ok(!tracker.calls.readFileSync.some((p) => path.basename(String(p)) === '.env'), '.env contents must never be read');
});

t('a project with a .env and no .env.example is flagged missing_env_example, evidence-cited', () => {
  const portfolio = freshRoot('sb-env-example');
  const projectDir = buildFakeProject(portfolio, 'proj-noexample', { 'FORGE_MEMORY.md': '# memory\n' }, { '.env': 'PLACEHOLDER_TOKEN=not-a-real-secret\n' });
  const findings = sb.checkEnvSignals({ project: 'proj-noexample', path: projectDir });
  const hit = findings.find((f) => f.type === 'missing_env_example');
  assert.ok(hit);
  assert.ok(sb.hasRealEvidence(hit));
});

t('a project with BOTH .env and .env.example is not flagged missing_env_example', () => {
  const portfolio = freshRoot('sb-env-hasexample');
  const projectDir = buildFakeProject(portfolio, 'proj-hasexample', { 'FORGE_MEMORY.md': '# memory\n' }, { '.env': 'x=1\n', '.env.example': 'x=\n' });
  const findings = sb.checkEnvSignals({ project: 'proj-hasexample', path: projectDir });
  assert.ok(!findings.some((f) => f.type === 'missing_env_example'));
});

t('a project with no .env at all produces zero env findings', () => {
  const portfolio = freshRoot('sb-env-none');
  const projectDir = buildFakeProject(portfolio, 'proj-noenv', { 'FORGE_MEMORY.md': '# memory\n' });
  assert.deepStrictEqual(sb.checkEnvSignals({ project: 'proj-noenv', path: projectDir }), []);
});

// ---------------------------------------------------------------------------
// 3) stale-dep and memory-staleness hints, evidence-cited real mtimes
// ---------------------------------------------------------------------------
console.log('\n3) stale-dep / memory-staleness hints (real mtime evidence)');

t('a project flags a stale project (old package.json mtime) with a real, cited age', () => {
  const portfolio = freshRoot('sb-stale');
  const projectDir = buildFakeProject(portfolio, 'proj-stale', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': '{"name":"proj-stale","dependencies":{}}' });
  setMtime(path.join(projectDir, 'package.json'), daysAgoMs(400));
  const findings = sb.checkStaleDependencies({ project: 'proj-stale', path: projectDir }, {});
  const hit = findings.find((f) => f.type === 'stale_dependencies_hint');
  assert.ok(hit, 'expected a stale_dependencies_hint finding');
  assert.ok(sb.hasRealEvidence(hit));
  assert.ok(/\d+ days old/.test(hit.evidence.fact));
});

t('a project with a RECENT package.json is not flagged stale', () => {
  const portfolio = freshRoot('sb-fresh');
  const projectDir = buildFakeProject(portfolio, 'proj-fresh', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': '{"name":"proj-fresh"}' });
  setMtime(path.join(projectDir, 'package.json'), daysAgoMs(2));
  const findings = sb.checkStaleDependencies({ project: 'proj-fresh', path: projectDir }, {});
  assert.deepStrictEqual(findings, []);
});

t('a project with no package.json produces zero stale-dep findings (never fabricated)', () => {
  const portfolio = freshRoot('sb-nopkg');
  const projectDir = buildFakeProject(portfolio, 'proj-nopkg', { 'FORGE_MEMORY.md': '# memory\n' });
  assert.deepStrictEqual(sb.checkStaleDependencies({ project: 'proj-nopkg', path: projectDir }, {}), []);
});

t('opts.staleDependencyDays overrides the default threshold', () => {
  const portfolio = freshRoot('sb-stale-threshold');
  const projectDir = buildFakeProject(portfolio, 'proj-threshold', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': '{"name":"x"}' });
  setMtime(path.join(projectDir, 'package.json'), daysAgoMs(10));
  assert.deepStrictEqual(sb.checkStaleDependencies({ project: 'proj-threshold', path: projectDir }, { staleDependencyDays: 5 }).length, 1);
  assert.deepStrictEqual(sb.checkStaleDependencies({ project: 'proj-threshold', path: projectDir }, { staleDependencyDays: 20 }).length, 0);
});

t('memory staleness flags an old FORGE_MEMORY.md with real, cited age', () => {
  const portfolio = freshRoot('sb-mem-stale');
  const projectDir = buildFakeProject(portfolio, 'proj-memstale', { 'FORGE_MEMORY.md': '# memory\n' });
  setMtime(path.join(projectDir, '.claude', 'FORGE_MEMORY.md'), daysAgoMs(200));
  const findings = sb.checkMemoryStaleness({ project: 'proj-memstale', path: projectDir }, {});
  const hit = findings.find((f) => f.type === 'memory_stale');
  assert.ok(hit);
  assert.ok(sb.hasRealEvidence(hit));
});

t('memory staleness does not flag a recently-updated FORGE_MEMORY.md', () => {
  const portfolio = freshRoot('sb-mem-fresh');
  const projectDir = buildFakeProject(portfolio, 'proj-memfresh', { 'FORGE_MEMORY.md': '# memory\n' });
  setMtime(path.join(projectDir, '.claude', 'FORGE_MEMORY.md'), daysAgoMs(1));
  assert.deepStrictEqual(sb.checkMemoryStaleness({ project: 'proj-memfresh', path: projectDir }, {}), []);
});

// ---------------------------------------------------------------------------
// 4) doctor/test status ONLY when a real forge-runs receipt exists
// ---------------------------------------------------------------------------
console.log('\n4) doctor/test status from a real forge-runs receipt');

t('a project with the most recent doctor.json ok:false is flagged doctor_failing', () => {
  const portfolio = freshRoot('sb-doctor-fail');
  const projectDir = buildFakeProject(portfolio, 'proj-doc', { 'FORGE_MEMORY.md': '# memory\n' });
  const runDir = path.join(projectDir, '.claude', 'forge-runs', 'run-1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'doctor.json'), JSON.stringify({ ok: false, checks: { leak_scan: { ok: false } } }), 'utf8');
  const findings = sb.checkDoctorReceipt({ project: 'proj-doc', path: projectDir });
  const hit = findings.find((f) => f.type === 'doctor_failing');
  assert.ok(hit);
  assert.ok(sb.hasRealEvidence(hit));
  assert.ok(hit.evidence.file.includes('run-1'));
});

t('a project with doctor.json ok:true produces no doctor_failing finding', () => {
  const portfolio = freshRoot('sb-doctor-ok');
  const projectDir = buildFakeProject(portfolio, 'proj-docok', { 'FORGE_MEMORY.md': '# memory\n' });
  const runDir = path.join(projectDir, '.claude', 'forge-runs', 'run-1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'doctor.json'), JSON.stringify({ ok: true }), 'utf8');
  assert.deepStrictEqual(sb.checkDoctorReceipt({ project: 'proj-docok', path: projectDir }), []);
});

t('a project with NO forge-runs directory at all produces zero doctor findings (never fabricated)', () => {
  const portfolio = freshRoot('sb-doctor-none');
  const projectDir = buildFakeProject(portfolio, 'proj-noruns', { 'FORGE_MEMORY.md': '# memory\n' });
  assert.deepStrictEqual(sb.checkDoctorReceipt({ project: 'proj-noruns', path: projectDir }), []);
});

t('the MOST RECENT run dir (by mtime) is the one consulted, not an arbitrary one', () => {
  const portfolio = freshRoot('sb-doctor-latest');
  const projectDir = buildFakeProject(portfolio, 'proj-latest', { 'FORGE_MEMORY.md': '# memory\n' });
  const oldRun = path.join(projectDir, '.claude', 'forge-runs', 'run-old');
  const newRun = path.join(projectDir, '.claude', 'forge-runs', 'run-new');
  fs.mkdirSync(oldRun, { recursive: true });
  fs.writeFileSync(path.join(oldRun, 'doctor.json'), JSON.stringify({ ok: false }), 'utf8');
  setMtime(oldRun, daysAgoMs(30));
  fs.mkdirSync(newRun, { recursive: true });
  fs.writeFileSync(path.join(newRun, 'doctor.json'), JSON.stringify({ ok: true }), 'utf8');
  setMtime(newRun, daysAgoMs(1));
  assert.deepStrictEqual(sb.checkDoctorReceipt({ project: 'proj-latest', path: projectDir }), []);
});

// ---------------------------------------------------------------------------
// 5) a real cross-project overlap, from real shared package.json dependency names
// ---------------------------------------------------------------------------
console.log('\n5) cross-project overlap (real shared dependency evidence)');

t('two projects sharing >= threshold dependency names produce a cited overlap finding', () => {
  const portfolio = freshRoot('sb-overlap');
  const pA = buildFakeProject(portfolio, 'proj-overlap-a', { 'FORGE_MEMORY.md': '# memory\n' },
    { 'package.json': JSON.stringify({ dependencies: { express: '1.0.0', lodash: '1.0.0', axios: '1.0.0' } }) });
  const pB = buildFakeProject(portfolio, 'proj-overlap-b', { 'FORGE_MEMORY.md': '# memory\n' },
    { 'package.json': JSON.stringify({ dependencies: { express: '1.0.0', lodash: '1.0.0', axios: '1.0.0' } }) });
  const discovered = [{ project: 'proj-overlap-a', path: pA }, { project: 'proj-overlap-b', path: pB }];
  const overlaps = sb.crossProjectOverlaps(discovered, {});
  assert.strictEqual(overlaps.length, 1);
  assert.ok(sb.hasRealEvidence(overlaps[0]));
  assert.deepStrictEqual(overlaps[0].shared_dependencies, ['axios', 'express', 'lodash']);
  assert.deepStrictEqual(overlaps[0].projects.sort(), ['proj-overlap-a', 'proj-overlap-b']);
});

t('two projects sharing FEWER than the threshold do not produce an overlap finding', () => {
  const portfolio = freshRoot('sb-overlap-low');
  const pA = buildFakeProject(portfolio, 'proj-low-a', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': JSON.stringify({ dependencies: { express: '1.0.0' } }) });
  const pB = buildFakeProject(portfolio, 'proj-low-b', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': JSON.stringify({ dependencies: { express: '1.0.0' } }) });
  const discovered = [{ project: 'proj-low-a', path: pA }, { project: 'proj-low-b', path: pB }];
  assert.deepStrictEqual(sb.crossProjectOverlaps(discovered, {}), []);
});

t('opts.overlapMinShared lowers the threshold', () => {
  const portfolio = freshRoot('sb-overlap-custom');
  const pA = buildFakeProject(portfolio, 'proj-custom-a', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': JSON.stringify({ dependencies: { express: '1.0.0' } }) });
  const pB = buildFakeProject(portfolio, 'proj-custom-b', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': JSON.stringify({ dependencies: { express: '1.0.0' } }) });
  const discovered = [{ project: 'proj-custom-a', path: pA }, { project: 'proj-custom-b', path: pB }];
  assert.strictEqual(sb.crossProjectOverlaps(discovered, { overlapMinShared: 1 }).length, 1);
});

// ---------------------------------------------------------------------------
// 6) evidence-gating in report() — a recommendation without a citation must be DROPPED (mutation target)
// ---------------------------------------------------------------------------
console.log('\n6) evidence-gating (mutation-verification target)');

t('hasRealEvidence rejects missing/empty/partial evidence', () => {
  assert.strictEqual(sb.hasRealEvidence({}), false);
  assert.strictEqual(sb.hasRealEvidence({ evidence: null }), false);
  assert.strictEqual(sb.hasRealEvidence({ evidence: {} }), false);
  assert.strictEqual(sb.hasRealEvidence({ evidence: { project: 'x', file: 'y' } }), false, 'missing fact');
  assert.strictEqual(sb.hasRealEvidence({ evidence: { project: 'x', file: '', fact: 'z' } }), false, 'empty file');
  assert.strictEqual(sb.hasRealEvidence({ evidence: { project: '  ', file: 'y', fact: 'z' } }), false, 'whitespace-only project');
  assert.strictEqual(sb.hasRealEvidence({ evidence: { project: 'x', file: 'y', fact: 'z' } }), true);
});

t('MUTATION TARGET: report() fed a mix of evidenced and unevidenced findings drops every unevidenced one', () => {
  const good1 = { type: 'a', message: 'ok one', evidence: { project: 'p1', file: 'f1', fact: 'fact one' } };
  const bad1 = { type: 'b', message: 'no evidence object at all' }; // evidence entirely missing
  const bad2 = { type: 'c', message: 'evidence with empty fact', evidence: { project: 'p2', file: 'f2', fact: '' } };
  const bad3 = { type: 'd', message: 'fabricated claim, no proof', evidence: { project: '', file: '', fact: '' } };
  const good2 = { type: 'e', message: 'ok two', evidence: { project: 'p3', file: 'f3', fact: 'fact two' } };
  const result = sb.report([good1, bad1, bad2, bad3, good2]);
  assert.strictEqual(result.recommendations.length, 2);
  assert.deepStrictEqual(result.recommendations.map((r) => r.type).sort(), ['a', 'e']);
  assert.strictEqual(result.dropped_unevidenced, 3);
  for (const rec of result.recommendations) assert.ok(sb.hasRealEvidence(rec), 'every surfaced recommendation must itself carry real evidence');
});

t('report() on an ALL-unevidenced input yields zero recommendations, not a fallback/guessed one', () => {
  const result = sb.report([{ type: 'x', message: 'no proof' }, { type: 'y', message: 'still no proof', evidence: {} }]);
  assert.deepStrictEqual(result.recommendations, []);
  assert.strictEqual(result.dropped_unevidenced, 2);
});

t('buildRecommendations is the same chokepoint report() uses (direct call matches report() behavior)', () => {
  const findings = [{ type: 'a', evidence: { project: 'p', file: 'f', fact: 'z' } }, { type: 'b' }];
  const { accepted, dropped } = sb.buildRecommendations(findings);
  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(dropped.length, 1);
});

// ---------------------------------------------------------------------------
// 7) end-to-end: scan() -> report() over a real fake portfolio produces ZERO unevidenced recommendations
// ---------------------------------------------------------------------------
console.log('\n7) end-to-end scan() -> report() (zero unevidenced recommendations)');

t('a realistic fake portfolio scan -> report produces only evidenced recommendations, every one cited', () => {
  const portfolio = freshRoot('sb-e2e');
  const pStale = buildFakeProject(portfolio, 'proj-e2e-stale', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': JSON.stringify({ dependencies: { react: '1', redux: '1', axios: '1' } }) });
  setMtime(path.join(pStale, 'package.json'), daysAgoMs(400));
  const pTwin = buildFakeProject(portfolio, 'proj-e2e-twin', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': JSON.stringify({ dependencies: { react: '1', redux: '1', axios: '1' } }) });
  const pClean = buildFakeProject(portfolio, 'proj-e2e-clean', { 'FORGE_MEMORY.md': '# memory\n' });
  assert.ok(pClean, 'sanity: fixture created');

  const scanResult = sb.scan({ scanDir: portfolio });
  assert.strictEqual(scanResult.projects_scanned, 3);
  const reportResult = sb.report(scanResult);
  assert.ok(reportResult.recommendations.length > 0, 'sanity: this portfolio must produce at least one real recommendation');
  for (const rec of reportResult.recommendations) assert.ok(sb.hasRealEvidence(rec), 'ZERO unevidenced recommendations allowed');
  assert.strictEqual(reportResult.dropped_unevidenced, 0, 'a clean scan()-built pipeline should never itself generate unevidenced findings');
  assert.ok(reportResult.recommendations.some((r) => r.type === 'stale_dependencies_hint' && r.evidence.project === 'proj-e2e-stale'));
  assert.ok(reportResult.recommendations.some((r) => r.type === 'cross_project_overlap'));
});

t('scan() never opens ANY .env contents anywhere across the whole portfolio', () => {
  const portfolio = freshRoot('sb-e2e-noread');
  buildFakeProject(portfolio, 'proj-noread-1', { 'FORGE_MEMORY.md': '# memory\n' }, { '.env': 'X=placeholder\n' });
  buildFakeProject(portfolio, 'proj-noread-2', { 'FORGE_MEMORY.md': '# memory\n' }, { '.env': 'Y=placeholder\n' });
  const tracker = trackFsCalls(['readFileSync']);
  try { sb.scan({ scanDir: portfolio }); }
  finally { tracker.restore(); }
  assert.ok(!tracker.calls.readFileSync.some((p) => path.basename(String(p)) === '.env'));
});

t('scan() performs NO write call anywhere (writeFileSync/appendFileSync/mkdirSync/rmSync) — fully read-only', () => {
  const portfolio = freshRoot('sb-e2e-readonly');
  buildFakeProject(portfolio, 'proj-ro-1', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': '{"dependencies":{}}' });
  const tracker = trackFsCalls(['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync']);
  let result;
  try { result = sb.scan({ scanDir: portfolio }); }
  finally { tracker.restore(); }
  assert.strictEqual(result.projects_scanned, 1);
  for (const m of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync']) assert.strictEqual(tracker.calls[m].length, 0, m + ' must never be called by scan()');
});

// ---------------------------------------------------------------------------
// 8) CLI
// ---------------------------------------------------------------------------
console.log('\n8) CLI');

t('CLI --help exits 0', () => {
  const r = runCLI(['--help']);
  assert.strictEqual(r.status, 0);
});

t('CLI with an unknown subcommand is a usage error (exit 2)', () => {
  const r = runCLI(['bogus']);
  assert.strictEqual(r.status, 2);
});

t('CLI scan --dir with no value is a usage error (exit 2)', () => {
  const r = runCLI(['scan', '--dir']);
  assert.strictEqual(r.status, 2);
});

t('CLI scan --dir <empty-portfolio> --json reports an honest 0-projects result (exit 0)', () => {
  const portfolio = freshRoot('sb-cli-empty');
  const r = runCLI(['scan', '--dir', portfolio, '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.projects_scanned, 0);
});

t('CLI report --dir over a real fake portfolio prints an evidenced digest (exit 0)', () => {
  const portfolio = freshRoot('sb-cli-report');
  const p = buildFakeProject(portfolio, 'proj-cli-report', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': '{"dependencies":{}}' });
  setMtime(path.join(p, 'package.json'), daysAgoMs(400));
  const r = runCLI(['report', '--dir', portfolio, '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.recommendations.some((rec) => rec.type === 'stale_dependencies_hint'));
  assert.strictEqual(parsed.dropped_unevidenced, 0);
});

t('CLI report --dir (text mode) prints a human-readable digest citing evidence', () => {
  const portfolio = freshRoot('sb-cli-report-text');
  const p = buildFakeProject(portfolio, 'proj-cli-text', { 'FORGE_MEMORY.md': '# memory\n' }, { 'package.json': '{"dependencies":{}}' });
  setMtime(path.join(p, 'package.json'), daysAgoMs(400));
  const r = runCLI(['report', '--dir', portfolio]);
  assert.strictEqual(r.status, 0);
  assert.ok(/evidence:/.test(r.stdout));
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
