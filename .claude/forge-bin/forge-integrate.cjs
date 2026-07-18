#!/usr/bin/env node
'use strict';
/**
 * forge-integrate.cjs — HERMETIC INTEGRATION GATE (2026-07-11).
 *
 * Turns a "green" from ASSERTED into OBSERVED. It takes the assembled project, runs its REAL
 * install → build → test commands in a clean git worktree (or in place if not a git repo), parses the
 * test output for pass/fail counts, writes <run>/artifacts/integration-gate.json, and — when a run id is
 * given — logs a content-oracle-backed quality_gate_passed / quality_gate_blocked event (carrying the real
 * exit_code + evidence path) via log-event.cjs. A done-ticket can then be required to reference a parsed
 * pass here, instead of a free-text "it works".
 *
 * Zero-dependency (child_process/fs/path only). Node projects (package.json) are supported today; other
 * stacks report SKIP honestly rather than a fake pass. The browser/console-error check is deliberately NOT
 * here — that belongs to the screenshot-loop tool (Playwright exact viewport); this gate is build+test.
 *
 * Usage:
 *   node forge-integrate.cjs <projectDir> [--run <run_id>] [--json] [--in-place] [--no-install]
 * Exit: 0 = gate PASSED · 1 = gate BLOCKED · 2 = SKIP/unsupported/error.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const a = { projectDir: null, run: null, json: false, inPlace: false, install: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--run') a.run = argv[++i];
    else if (x === '--json') a.json = true;
    else if (x === '--in-place') a.inPlace = true;
    else if (x === '--no-install') a.install = false;
    else if (!a.projectDir) a.projectDir = x;
  }
  return a;
}

function run(cmd, args, cwd, timeoutMs) {
  const r = spawnSync(cmd, args, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs || 600000 });
  const out = ((r.stdout || '') + (r.stderr || ''));
  return { cmd: cmd + ' ' + args.join(' '), code: r.status == null ? -1 : r.status, out, timedOut: !!r.error && /ETIMEDOUT|timed?out/i.test(String(r.error)) };
}

// Best-effort test-count parse across common JS runners (vitest/jest/mocha/tap/playwright).
function parseTestCounts(out) {
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  let passed = num(/(\d+)\s+passed/i);
  let failed = num(/(\d+)\s+failed/i);
  if (passed == null) passed = num(/(\d+)\s+passing/i);        // mocha
  if (failed == null) failed = num(/(\d+)\s+failing/i);        // mocha
  if (passed == null) passed = num(/#\s*pass\s+(\d+)/i);       // TAP
  if (failed == null) failed = num(/#\s*fail\s+(\d+)/i);       // TAP
  return { passed, failed, parseable: passed != null || failed != null };
}

function isGitRepo(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', shell: true });
  return r.status === 0 && /true/.test(r.stdout || '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = { tool: 'forge-integrate', project: null, hermetic: false, worktree: null, steps: [], testCounts: null, verdict: 'skip', reason: '', generated_at: new Date().toISOString() };

  if (!args.projectDir) { console.error('usage: node forge-integrate.cjs <projectDir> [--run <id>] [--json] [--in-place] [--no-install]'); process.exit(2); }
  const projectDir = path.resolve(args.projectDir);
  result.project = projectDir;
  if (!fs.existsSync(projectDir)) { result.reason = 'project dir not found'; finish(result, args, 2); }

  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')); } catch { /* none */ }
  if (!pkg) { result.reason = 'no package.json — non-Node stack not supported by this gate (reported SKIP, not a fake pass)'; finish(result, args, 2); }
  const scripts = pkg.scripts || {};

  // Choose a hermetic workdir: a fresh detached git worktree if possible, else in place (flagged non-hermetic).
  let workdir = projectDir;
  let cleanupWorktree = null;
  if (!args.inPlace && isGitRepo(projectDir)) {
    const wt = path.join(os.tmpdir(), 'forge-integrate-' + Date.now());
    const add = spawnSync('git', ['-C', projectDir, 'worktree', 'add', '--detach', wt, 'HEAD'], { encoding: 'utf8', shell: true });
    if (add.status === 0) { workdir = wt; result.hermetic = true; result.worktree = wt; cleanupWorktree = () => spawnSync('git', ['-C', projectDir, 'worktree', 'remove', '--force', wt], { encoding: 'utf8', shell: true }); }
  }
  if (!result.hermetic) result.reason = 'ran in place (not a git repo or --in-place) — less hermetic';

  const steps = [];
  const record = (label, r) => { const step = { label, cmd: r.cmd, exit_code: r.code, timedOut: r.timedOut, tail: r.out.slice(-1500) }; steps.push(step); return r; };

  // 1) install (from lockfile when present → reproducible)
  let installOk = true;
  if (args.install) {
    const hasLock = fs.existsSync(path.join(workdir, 'package-lock.json'));
    const inst = record('install', run('npm', [hasLock ? 'ci' : 'install', '--no-audit', '--no-fund'], workdir, 600000));
    installOk = inst.code === 0;
  } else { steps.push({ label: 'install', cmd: '(skipped --no-install)', exit_code: 0 }); }

  // 2) build (only if a build script exists)
  let buildOk = true;
  if (scripts.build) { const b = record('build', run('npm', ['run', 'build'], workdir, 600000)); buildOk = b.code === 0; }
  else steps.push({ label: 'build', cmd: '(no build script)', exit_code: 0, skipped: true });

  // 3) test (only if a test script exists)
  let testOk = true, counts = { passed: null, failed: null, parseable: false };
  if (scripts.test) { const t = record('test', run('npm', ['test'], workdir, 600000)); counts = parseTestCounts(t.out); testOk = t.code === 0 && (counts.failed == null || counts.failed === 0); t.exit_code = t.code; }
  else steps.push({ label: 'test', cmd: '(no test script)', exit_code: 0, skipped: true });

  result.steps = steps;
  result.testCounts = counts;
  const passed = installOk && buildOk && testOk;
  result.verdict = passed ? 'pass' : 'blocked';
  if (!passed) result.reason = [!installOk ? 'install failed' : '', !buildOk ? 'build failed' : '', !testOk ? 'tests failed' : ''].filter(Boolean).join('; ');

  if (cleanupWorktree) cleanupWorktree();

  // Write artifact into the run's artifacts dir (durable proof), if a run id + forge-runs exist in the project.
  if (args.run && /^[A-Za-z0-9_-]+$/.test(args.run)) {
    const artDir = path.join(projectDir, '.claude', 'forge-runs', args.run, 'artifacts');
    try {
      fs.mkdirSync(artDir, { recursive: true });
      const artPath = path.join(artDir, 'integration-gate.json');
      fs.writeFileSync(artPath, JSON.stringify(result, null, 2), 'utf8');
      result.artifact = artPath;
      // Log a content-oracle-backed gate event (exit_code carried so the honesty gate can verify it).
      const logEvent = path.join(projectDir, '.claude', 'forge-dashboard', 'log-event.cjs');
      if (fs.existsSync(logEvent)) {
        const testStep = steps.find((s) => s.label === 'test') || { cmd: 'npm test', tail: '', exit_code: passed ? 0 : 1 };
        const payload = {
          agent: 'Integration Boss', role: 'integration-gate',
          command: testStep.cmd, output: (testStep.tail || '').slice(-400),
          evidence: artPath, exit_code: passed ? 0 : 1,
          note: 'hermetic integration gate ' + result.verdict + (counts.parseable ? (' (' + (counts.passed || 0) + ' passed / ' + (counts.failed || 0) + ' failed)') : ''),
        };
        spawnSync(process.execPath, [logEvent, args.run, passed ? 'quality_gate_passed' : 'quality_gate_blocked', JSON.stringify(payload)], { encoding: 'utf8' });
      }
    } catch (e) { result.artifact_error = String(e.message || e); }
  }

  finish(result, args, passed ? 0 : 1);
}

function finish(result, args, code) {
  if (args && args.json) console.log(JSON.stringify(result, null, 2));
  else {
    const v = result.verdict.toUpperCase();
    console.log('forge-integrate: ' + v + (result.reason ? ' — ' + result.reason : ''));
    for (const s of result.steps) console.log('  ' + (s.exit_code === 0 ? '✓' : (s.skipped ? '·' : '✗')) + ' ' + s.label.padEnd(8) + (s.skipped ? s.cmd : ('exit ' + s.exit_code)));
    if (result.testCounts && result.testCounts.parseable) console.log('  tests: ' + (result.testCounts.passed || 0) + ' passed / ' + (result.testCounts.failed || 0) + ' failed');
    if (result.hermetic) console.log('  (hermetic: fresh git worktree)'); else if (result.reason && /in place/.test(result.reason)) console.log('  (non-hermetic: in place)');
  }
  process.exit(code);
}

main();
