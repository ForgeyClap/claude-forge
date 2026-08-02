#!/usr/bin/env node
'use strict';
/**
 * forge-run-budget.test.cjs — the per-run cost cap for UNATTENDED runs (2026-08-01).
 *
 * WHY THIS SUITE EXISTS. forge-cost.cjs says so itself in its own header: it is a "cost/token sampler"
 * that LOGS a cost_sampled event. It measures; it cannot stop anything. usage-guard.cjs watches the
 * subscription WINDOW (5h session / weekly) and pauses everything at 95% — it knows nothing about one
 * single run running away inside a window that still has room. So a headless wrapper that loses the plot
 * had, before this file existed, no brake at all.
 *
 * The two halves this suite pins, and they are equally load-bearing:
 *   (1) the CAP resolves from CONFIG, never from a number baked into a wrapper, and it cannot be widened
 *       into meaninglessness by a typo or an env var (both are clamped to the configured ceiling);
 *   (2) a run that hit the cap is NEVER called finished. The status is the literal string
 *       'stopped_by_budget', isCompletion() is false for it, and a verdict we cannot read counts as a
 *       stop rather than as silence — the same "a broken counter may never read as clean" rule
 *       forge-verify.cjs::gateCount already applies to its own gates.
 *
 * Hermetic: every case builds its own temp config/run dir and injects env/opts. Nothing reads the real
 * project config, spawns the real claude CLI, or spends a cent.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('./forge-run-budget.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-run-budget-'));
let seq = 0;
function tmpRoot(config) {
  const root = path.join(TMP, 'root-' + (seq++));
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(root, '.claude', B.CONFIG_REL),
      typeof config === 'string' ? config : JSON.stringify(config, null, 2), 'utf8');
  }
  return root;
}
function runDir() { const d = path.join(TMP, 'run-' + (seq++)); fs.mkdirSync(d, { recursive: true }); return d; }

const CFG = {
  default_usd: 5,
  limits: { min_usd: 0.25, max_usd: 25 },
  levels: { L1: 2, L2: 5, L3: 10, L4: 20 },
  wrappers: { 'maand-sweep': 5, 'tiny-thing': 1 },
};

console.log('forge-run-budget tests (cost cap on unattended runs)');

// ======================================================================================================
// 1) the cap is a CONFIG value, resolved by precedence, and always clamped
// ======================================================================================================
t('no wrapper and no level -> the configured default, sourced from the config file', () => {
  const r = B.resolveCap({}, { root: tmpRoot(CFG), env: {} });
  assert.strictEqual(r.cap_usd, 5);
  assert.strictEqual(r.source, 'config.default');
  assert.strictEqual(r.degraded, false);
});

t('a wrapper with its own entry gets that entry, not the default', () => {
  const r = B.resolveCap({ wrapper: 'tiny-thing' }, { root: tmpRoot(CFG), env: {} });
  assert.strictEqual(r.cap_usd, 1);
  assert.strictEqual(r.source, 'config.wrappers.tiny-thing');
});

t('an unknown wrapper falls through to the level cap when a level is given', () => {
  const r = B.resolveCap({ wrapper: 'no-such-wrapper', level: 'L3' }, { root: tmpRoot(CFG), env: {} });
  assert.strictEqual(r.cap_usd, 10);
  assert.strictEqual(r.source, 'config.levels.L3');
});

t('a named wrapper beats the level cap (the more specific rule wins)', () => {
  const r = B.resolveCap({ wrapper: 'tiny-thing', level: 'L4' }, { root: tmpRoot(CFG), env: {} });
  assert.strictEqual(r.cap_usd, 1);
});

t('level names are case-insensitive (l2 resolves the same as L2)', () => {
  assert.strictEqual(B.resolveCap({ level: 'l2' }, { root: tmpRoot(CFG), env: {} }).cap_usd, 5);
});

t('FORGE_RUN_BUDGET_USD overrides the config for a deliberate one-off', () => {
  const r = B.resolveCap({ wrapper: 'maand-sweep' }, { root: tmpRoot(CFG), env: { FORGE_RUN_BUDGET_USD: '3.5' } });
  assert.strictEqual(r.cap_usd, 3.5);
  assert.strictEqual(r.source, 'env.FORGE_RUN_BUDGET_USD');
});

t('the env override CANNOT widen the cap past the configured ceiling — it is clamped down and flagged', () => {
  const r = B.resolveCap({}, { root: tmpRoot(CFG), env: { FORGE_RUN_BUDGET_USD: '9999' } });
  assert.strictEqual(r.cap_usd, 25, 'an env var must not be able to disable the protection');
  assert.strictEqual(r.clamped, 'max');
});

t('a garbage env override is IGNORED (falls back to config), never treated as "no cap"', () => {
  const r = B.resolveCap({}, { root: tmpRoot(CFG), env: { FORGE_RUN_BUDGET_USD: 'lots' } });
  assert.strictEqual(r.cap_usd, 5);
  assert.strictEqual(r.source, 'config.default');
});

t('an env override of 0 or a negative number is ignored, not honoured as an instant kill', () => {
  assert.strictEqual(B.resolveCap({}, { root: tmpRoot(CFG), env: { FORGE_RUN_BUDGET_USD: '0' } }).cap_usd, 5);
  assert.strictEqual(B.resolveCap({}, { root: tmpRoot(CFG), env: { FORGE_RUN_BUDGET_USD: '-4' } }).cap_usd, 5);
});

t('a config value above the ceiling is clamped down (a typo cannot remove the brake)', () => {
  const r = B.resolveCap({ wrapper: 'fat' }, { root: tmpRoot(Object.assign({}, CFG, { wrappers: { fat: 5000 } })), env: {} });
  assert.strictEqual(r.cap_usd, 25);
  assert.strictEqual(r.clamped, 'max');
});

t('a config value below the floor is clamped UP (a stray 0 must not make every run die instantly)', () => {
  const r = B.resolveCap({ wrapper: 'zero' }, { root: tmpRoot(Object.assign({}, CFG, { wrappers: { zero: 0 } })), env: {} });
  assert.strictEqual(r.cap_usd, 0.25);
  assert.strictEqual(r.clamped, 'min');
});

// ======================================================================================================
// 2) a missing or broken config degrades LOUDLY to the builtin fallback — it never means "uncapped"
// ======================================================================================================
t('a missing config file yields the builtin fallback, marked degraded (never an absent cap)', () => {
  const r = B.resolveCap({}, { root: tmpRoot(undefined), env: {} });
  assert.strictEqual(r.cap_usd, B.DEFAULTS.default_usd);
  assert.strictEqual(r.source, 'builtin-fallback');
  assert.strictEqual(r.degraded, true);
  assert.ok(/config/i.test(r.reason || ''), 'the reason must say why it degraded, got: ' + r.reason);
});

t('a malformed config file degrades the same way instead of throwing', () => {
  const r = B.resolveCap({}, { root: tmpRoot('{ this is not json'), env: {} });
  assert.strictEqual(r.degraded, true);
  assert.strictEqual(r.cap_usd, B.DEFAULTS.default_usd);
});

t('a config whose default is missing/non-numeric still produces a real cap', () => {
  const r = B.resolveCap({}, { root: tmpRoot({ limits: { min_usd: 0.25, max_usd: 25 } }), env: {} });
  assert.ok(Number.isFinite(r.cap_usd) && r.cap_usd > 0, 'got ' + r.cap_usd);
});

// ======================================================================================================
// 3) the CLI flag itself
// ======================================================================================================
t('budgetArgs renders the real claude flag for a valid cap', () => {
  const r = B.budgetArgs(5);
  assert.deepStrictEqual(r.args, ['--max-budget-usd', '5']);
  assert.strictEqual(r.ok, true);
});

t('budgetArgs REFUSES a non-finite or non-positive cap and emits no flag at all', () => {
  for (const bad of [0, -1, NaN, Infinity, null, undefined, 'five']) {
    const r = B.budgetArgs(bad);
    assert.strictEqual(r.ok, false, 'accepted ' + String(bad));
    assert.deepStrictEqual(r.args, [], 'emitted a flag for ' + String(bad));
  }
});

t('budgetArgs never emits a bare flag without its value (the shape claude actually needs)', () => {
  const { args } = B.budgetArgs(12.5);
  assert.strictEqual(args.length, 2);
  assert.strictEqual(args[0], '--max-budget-usd');
  assert.strictEqual(args[1], '12.5');
});

// ======================================================================================================
// 4) the honest end status — the heart of this whole change
// ======================================================================================================
t("the stopped status is the literal string 'stopped_by_budget'", () => {
  assert.strictEqual(B.STATUS.STOPPED, 'stopped_by_budget');
});

t('isCompletion is TRUE only for a real completion', () => {
  assert.strictEqual(B.isCompletion(B.STATUS.COMPLETED), true);
  assert.strictEqual(B.isCompletion(B.STATUS.STOPPED), false, 'a budget stop may never read as finished');
  assert.strictEqual(B.isCompletion(B.STATUS.FAILED), false);
  assert.strictEqual(B.isCompletion(B.STATUS.UNKNOWN), false, 'unknown is not proof of completion');
  assert.strictEqual(B.isCompletion('done'), false, 'only the vocabulary this module defines counts');
});

t('exit 0 with a cost well under the cap is a genuine completion', () => {
  const r = B.classifyOutcome({ exitCode: 0, cap_usd: 5, envelope: { total_cost_usd: 0.42 } });
  assert.strictEqual(r.status, B.STATUS.COMPLETED);
  assert.strictEqual(r.budget_stopped, false);
  assert.strictEqual(r.cost_usd, 0.42);
});

t('cost that reached the cap is a budget stop EVEN on exit 0 (the wording-independent signal)', () => {
  const r = B.classifyOutcome({ exitCode: 0, cap_usd: 5, envelope: { total_cost_usd: 5 } });
  assert.strictEqual(r.status, B.STATUS.STOPPED);
  assert.strictEqual(r.budget_stopped, true);
});

t('cost past the cap is a budget stop', () => {
  assert.strictEqual(B.classifyOutcome({ exitCode: 1, cap_usd: 5, envelope: { total_cost_usd: 5.01 } }).status, B.STATUS.STOPPED);
});

t('a budget message on stderr is a budget stop even without an envelope', () => {
  const r = B.classifyOutcome({ exitCode: 1, cap_usd: 5, stderr: 'Error: max budget of $5.00 reached; stopping.' });
  assert.strictEqual(r.status, B.STATUS.STOPPED);
  assert.ok(/marker/i.test(r.reason), 'the reason must name the evidence, got: ' + r.reason);
});

t('the same message on stdout counts too (the CLI is not required to use one stream)', () => {
  assert.strictEqual(B.classifyOutcome({ exitCode: 0, cap_usd: 5, stdout: 'stopped: --max-budget-usd limit exceeded' }).status, B.STATUS.STOPPED);
});

// ---- FOUND BY THE WITNESS AUDIT (2026-08-01) --------------------------------------------------------
// The marker was checked BEFORE the "exit 0 with a cost below the cap" rule, so a text coincidence beat a
// conclusive envelope. That is not hypothetical for THIS wrapper: the monthly sweep is a Claude-NEWS
// sweep, so writing the words "--max-budget-usd" into its own report is its job, not a failure. The
// marker exists to corroborate a stop when NO envelope was captured; it must never overrule one that
// proves the cap was not reached.
t('a conclusive envelope UNDER the cap beats a text marker (the sweep may write about the flag)', () => {
  const r = B.classifyOutcome({
    exitCode: 0, cap_usd: 5, envelope: { total_cost_usd: 0.31 },
    stdout: 'Notable new CLI feature found this month: --max-budget-usd <amount> caps headless spend.',
  });
  assert.strictEqual(r.status, B.STATUS.COMPLETED, 'a run that provably spent 0.31 of 5 was called a budget stop');
  assert.strictEqual(r.budget_stopped, false);
});

t('...but the marker still wins when there is NO envelope to contradict it', () => {
  const r = B.classifyOutcome({ exitCode: 0, cap_usd: 5, stdout: 'stopped: --max-budget-usd limit exceeded' });
  assert.strictEqual(r.status, B.STATUS.STOPPED, 'the corroborating signal was weakened, not just subordinated');
});

t('a marker alongside an envelope that REACHED the cap is still a stop (both agree)', () => {
  const r = B.classifyOutcome({
    exitCode: 0, cap_usd: 5, envelope: { total_cost_usd: 5.02 },
    stdout: 'budget limit reached',
  });
  assert.strictEqual(r.status, B.STATUS.STOPPED);
});

t('an envelope under the cap does not turn a crash into a completion', () => {
  const r = B.classifyOutcome({
    exitCode: 2, cap_usd: 5, envelope: { total_cost_usd: 0.31 },
    stdout: 'a line mentioning --max-budget-usd in passing',
  });
  assert.strictEqual(r.status, B.STATUS.FAILED, 'a non-zero exit must stay a failure, not become completed');
});

t('an ordinary failure is reported as failed, NOT invented as a budget stop', () => {
  const r = B.classifyOutcome({ exitCode: 1, cap_usd: 5, stderr: 'yt-dlp exited 2: network unreachable' });
  assert.strictEqual(r.status, B.STATUS.FAILED);
  assert.strictEqual(r.budget_stopped, false);
});

t('exit 0 with NO cost information is unknown, not a completion (fail-closed)', () => {
  const r = B.classifyOutcome({ exitCode: 0, cap_usd: 5 });
  assert.strictEqual(r.status, B.STATUS.UNKNOWN);
  assert.strictEqual(B.isCompletion(r.status), false);
});

t('a run with no cap applied at all is unknown — an uncapped run can never be certified capped', () => {
  const r = B.classifyOutcome({ exitCode: 0, envelope: { total_cost_usd: 0.1 } });
  assert.strictEqual(r.status, B.STATUS.UNKNOWN);
  assert.ok(/cap/i.test(r.reason || ''), 'reason should mention the missing cap, got: ' + r.reason);
});

t('the envelope cost is read from the real claude -p --output-format json field name', () => {
  assert.strictEqual(B.classifyOutcome({ exitCode: 0, cap_usd: 5, envelope: { total_cost_usd: 1.5 } }).cost_usd, 1.5);
});

// ======================================================================================================
// 5) the verdict trail forge-verify reads
// ======================================================================================================
t('recordVerdict appends one JSON line to the run dir and readVerdicts reads it back', () => {
  const dir = runDir();
  const w = B.recordVerdict({ wrapper: 'maand-sweep', status: B.STATUS.COMPLETED, cap_usd: 5, cost_usd: 0.4 }, { runDir: dir });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(path.basename(w.file), B.VERDICT_FILE);
  const v = B.readVerdicts(dir);
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].status, 'completed');
  assert.strictEqual(v[0].wrapper, 'maand-sweep');
  assert.ok(v[0].ts, 'a verdict must be timestamped');
});

t('two invocations append, they do not overwrite each other', () => {
  const dir = runDir();
  B.recordVerdict({ status: B.STATUS.COMPLETED, cap_usd: 5 }, { runDir: dir });
  B.recordVerdict({ status: B.STATUS.STOPPED, cap_usd: 5, budget_stopped: true }, { runDir: dir });
  assert.strictEqual(B.readVerdicts(dir).length, 2);
});

t('a run dir with no verdict file reads as an empty list, not an error', () => {
  assert.deepStrictEqual(B.readVerdicts(runDir()), []);
});

t('budgetStops counts a budget stop and reports it', () => {
  const dir = runDir();
  B.recordVerdict({ status: B.STATUS.COMPLETED, cap_usd: 5 }, { runDir: dir });
  B.recordVerdict({ status: B.STATUS.STOPPED, cap_usd: 5, budget_stopped: true, wrapper: 'maand-sweep' }, { runDir: dir });
  const s = B.budgetStops(dir);
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.stops[0].wrapper, 'maand-sweep');
  assert.strictEqual(s.verdicts.length, 2);
});

t('a clean run reports zero stops', () => {
  const dir = runDir();
  B.recordVerdict({ status: B.STATUS.COMPLETED, cap_usd: 5 }, { runDir: dir });
  assert.strictEqual(B.budgetStops(dir).count, 0);
});

t('an UNKNOWN verdict counts as a stop — indeterminate is not proof of completion', () => {
  const dir = runDir();
  B.recordVerdict({ status: B.STATUS.UNKNOWN, cap_usd: 5 }, { runDir: dir });
  assert.strictEqual(B.budgetStops(dir).count, 1);
});

t('a plain FAILED verdict is not counted by this gate (that is another gate\'s job)', () => {
  const dir = runDir();
  B.recordVerdict({ status: B.STATUS.FAILED, cap_usd: 5 }, { runDir: dir });
  assert.strictEqual(B.budgetStops(dir).count, 0);
});

t('an UNPARSEABLE verdict line counts as a stop — a record we cannot read may never read as clean', () => {
  const dir = runDir();
  B.recordVerdict({ status: B.STATUS.COMPLETED, cap_usd: 5 }, { runDir: dir });
  fs.appendFileSync(path.join(dir, B.VERDICT_FILE), '{ corrupted half-line\n', 'utf8');
  const s = B.budgetStops(dir);
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.stops[0].parse_error, true);
});

t('budgetStops on a nonexistent dir is 0 stops and does not throw', () => {
  assert.strictEqual(B.budgetStops(path.join(TMP, 'no-such-dir-at-all')).count, 0);
});

t('countsAsStop is the single exported predicate both the gate and the reporter use', () => {
  assert.strictEqual(B.countsAsStop({ status: 'stopped_by_budget' }), true);
  assert.strictEqual(B.countsAsStop({ status: 'unknown' }), true);
  assert.strictEqual(B.countsAsStop({ parse_error: true }), true);
  assert.strictEqual(B.countsAsStop({ status: 'completed' }), false);
  assert.strictEqual(B.countsAsStop({ status: 'failed' }), false);
});

// ======================================================================================================
// 6) the config that actually ships with this project
// ======================================================================================================
t('the REAL project config exists, parses, and its numbers are internally consistent', () => {
  const real = path.join(__dirname, '..', B.CONFIG_REL);
  assert.ok(fs.existsSync(real), 'missing shipped config: ' + real);
  const cfg = JSON.parse(fs.readFileSync(real, 'utf8'));
  assert.ok(Number.isFinite(cfg.default_usd) && cfg.default_usd > 0, 'default_usd must be a positive number');
  assert.ok(cfg.limits && cfg.limits.min_usd > 0 && cfg.limits.max_usd >= cfg.limits.min_usd, 'limits are inconsistent');
  assert.ok(cfg.default_usd >= cfg.limits.min_usd && cfg.default_usd <= cfg.limits.max_usd, 'the default sits outside its own limits');
  assert.ok(cfg.wrappers && Number.isFinite(cfg.wrappers['maand-sweep']),
    'the one real unattended wrapper in this project must have an entry');
  assert.ok(typeof cfg._motivation === 'string' && cfg._motivation.length > 40,
    'the chosen numbers must carry their reasoning in the file itself');
});

t('the shipped config resolves through the real reader for the real wrapper', () => {
  const root = path.join(__dirname, '..', '..');
  const r = B.resolveCap({ wrapper: 'maand-sweep' }, { root, env: {} });
  assert.strictEqual(r.degraded, false, 'the shipped config must not degrade: ' + r.reason);
  assert.strictEqual(r.source, 'config.wrappers.maand-sweep');
  assert.ok(r.cap_usd > 0);
});

// ======================================================================================================
// 7) the wrapper this cap exists for must actually pass it
// ======================================================================================================
t('maand-sweep.cmd resolves its cap through this tool and passes --max-budget-usd to claude', () => {
  const cmd = fs.readFileSync(path.join(__dirname, 'maand-sweep.cmd'), 'utf8');
  assert.ok(/forge-run-budget\.cjs/.test(cmd), 'the wrapper does not consult the budget resolver');
  assert.ok(/--max-budget-usd/.test(cmd), 'the wrapper does not pass the cap to claude');
  assert.ok(!/--max-budget-usd\s+\d/.test(cmd),
    'the wrapper hardcodes a number after --max-budget-usd; the cap must come from the config');
});

t('maand-sweep.cmd refuses to start the run when no cap could be resolved', () => {
  const cmd = fs.readFileSync(path.join(__dirname, 'maand-sweep.cmd'), 'utf8');
  assert.ok(/if\s+not\s+defined\s+FORGE_RUN_CAP/i.test(cmd) || /if\s+"%FORGE_RUN_CAP%"\s*==\s*""/i.test(cmd),
    'the wrapper has no guard for an unresolved cap — an unattended run must never start uncapped');
  const guardIdx = cmd.search(/if\s+(not\s+defined\s+FORGE_RUN_CAP|"%FORGE_RUN_CAP%"\s*==\s*"")/i);
  const spawnIdx = cmd.search(/--max-budget-usd/);
  assert.ok(guardIdx > -1 && spawnIdx > -1 && guardIdx < spawnIdx, 'the guard must come BEFORE the claude invocation');
});

t('the cap change touches ONLY unattended wrappers — no interactive entry point is capped', () => {
  // The owner's own interactive session must keep working exactly as before. The only files allowed to
  // carry --max-budget-usd are this module, its test, and the unattended wrappers.
  const allowed = new Set(['forge-run-budget.cjs', 'forge-run-budget.test.cjs', 'maand-sweep.cmd']);
  const offenders = fs.readdirSync(__dirname)
    .filter((f) => !allowed.has(f))
    .filter((f) => { try { return /--max-budget-usd/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')); } catch { return false; } });
  assert.deepStrictEqual(offenders, [], 'unexpected files carry the cap flag: ' + offenders.join(', '));
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
