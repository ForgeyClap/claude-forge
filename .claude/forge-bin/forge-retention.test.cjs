#!/usr/bin/env node
'use strict';
/**
 * forge-retention.test.cjs — the bounded-retention tool (audit G9) and its owner setting `cleanup`
 * (forge-config.cjs, v2.7.0; default `report`).
 *
 * WHAT IS PINNED:
 *   - `scan` is ALWAYS allowed and never deletes anything, whatever the setting says;
 *   - `apply` is REFUSED (exit 3, one plain line naming `/forge config set cleanup auto`, nothing deleted)
 *     while cleanup=report — which is also the default when no settings file exists;
 *   - `apply --force` (an explicit request right now) and cleanup=auto let it run, and it then removes
 *     exactly the frozen plan (old batches beyond keep-N, old toollog files) and nothing younger;
 *   - a missing or throwing config module falls back to the schema default (report): a broken settings
 *     file can never cause a deletion.
 *
 * Hermetic: every case builds its own temp project root; the global settings file comes from a throwaway
 * FORGE_CONFIG_HOME (never ~/.claude) and FORGE_PROJECT_ROOT is cleared so `--root` decides which project
 * settings file is read. Nothing in the real project is touched.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./forge-retention.cjs');

const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-retention-cfghome-'));
process.env.FORGE_CONFIG_HOME = CONFIG_HOME;
delete process.env.FORGE_PROJECT_ROOT;

const CLI = path.join(__dirname, 'forge-retention.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-retention-test-'));
const DAY_MS = 86400000;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

let seq = 0;
/** fixtureRoot(settings) — 7 backup batches (the 6 oldest 30+ days old, the newest 1 day old) and two
 *  toollog files (one 30 days old, one fresh). With keep=5 / days=14 the plan is: 2 old batches + 1 toollog. */
function fixtureRoot(settings) {
  const root = path.join(TMP, 'root-' + (seq++));
  const bdir = path.join(root, '.claude', 'forge-backups');
  const tdir = path.join(root, '.claude', 'forge-runs', '_toollog');
  fs.mkdirSync(bdir, { recursive: true });
  fs.mkdirSync(tdir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 7; i++) {
    const b = path.join(bdir, 'batch-' + i);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, 'file.txt'), 'backup ' + i);
    const ageDays = i === 6 ? 1 : 30 + (6 - i); // batch-0 oldest ... batch-6 newest
    const at = new Date(now - ageDays * DAY_MS);
    fs.utimesSync(b, at, at);
  }
  fs.writeFileSync(path.join(tdir, 'old-session.jsonl'), '{}\n');
  fs.utimesSync(path.join(tdir, 'old-session.jsonl'), new Date(now - 30 * DAY_MS), new Date(now - 30 * DAY_MS));
  fs.writeFileSync(path.join(tdir, 'fresh-session.jsonl'), '{}\n');
  if (settings) fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings }));
  return root;
}
function batches(root) { return fs.readdirSync(path.join(root, '.claude', 'forge-backups')).sort(); }
function toollogs(root) { return fs.readdirSync(path.join(root, '.claude', 'forge-runs', '_toollog')).sort(); }
function runCli(args) { return spawnSync(process.execPath, [CLI].concat(args), { encoding: 'utf8', timeout: 20000 }); }
const ALL_BATCHES = ['batch-0', 'batch-1', 'batch-2', 'batch-3', 'batch-4', 'batch-5', 'batch-6'];

console.log('forge-retention tests (bounded retention + owner setting cleanup)');

// ---- 1) scan: the dry-run, always allowed ----
console.log('\n1) scan — dry-run, never gated, never deletes');
t('scan reports the frozen plan (2 old batches beyond keep-5, 1 old toollog) and deletes nothing', () => {
  const root = fixtureRoot(null);
  const r = R.scan(root, 5, 14);
  assert.deepStrictEqual(r.backups.prune_candidates.map((c) => c.name).sort(), ['batch-0', 'batch-1']);
  assert.deepStrictEqual(r.toollog.prune_candidates.map((c) => c.name), ['old-session.jsonl']);
  assert.deepStrictEqual(batches(root), ALL_BATCHES);
});
t('CLI scan with cleanup=report (default) -> exit 0, DRY-RUN output, nothing deleted', () => {
  const root = fixtureRoot(null);
  const r = runCli(['scan', '--root', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/DRY-RUN/.test(r.stdout), r.stdout);
  assert.deepStrictEqual(batches(root), ALL_BATCHES);
});

// ---- 2) the gate: apply refused while cleanup=report ----
console.log('\n2) apply — refused while cleanup=report (the default)');
t('CLI apply with NO settings file -> exit 3, one plain line naming /forge config set cleanup auto, nothing deleted', () => {
  const root = fixtureRoot(null);
  const r = runCli(['apply', '--root', root]);
  assert.strictEqual(r.status, 3, 'exit ' + r.status + ' ' + r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr.trim(), R.CLEANUP_REFUSAL);
  assert.ok(r.stderr.includes('/forge config set cleanup auto'));
  assert.deepStrictEqual(batches(root), ALL_BATCHES);
  assert.deepStrictEqual(toollogs(root), ['fresh-session.jsonl', 'old-session.jsonl']);
});
t('CLI apply --json with cleanup=report explicitly set -> still refused (exit 3), stdout stays empty', () => {
  const root = fixtureRoot({ cleanup: { value: 'report' } });
  const r = runCli(['apply', '--root', root, '--json']);
  assert.strictEqual(r.status, 3);
  assert.strictEqual(r.stdout, '');
  assert.deepStrictEqual(batches(root), ALL_BATCHES);
});

// ---- 3) the ways through: cleanup=auto or --force ----
console.log('\n3) apply — allowed with cleanup=auto or --force, removes exactly the plan');
t('CLI apply with cleanup=auto -> exit 0, removes the 2 old batches + the old toollog, keeps the rest', () => {
  const root = fixtureRoot({ cleanup: { value: 'auto' } });
  const r = runCli(['apply', '--root', root]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/RETENTIE TOEGEPAST/.test(r.stdout), r.stdout);
  assert.deepStrictEqual(batches(root), ['batch-2', 'batch-3', 'batch-4', 'batch-5', 'batch-6']);
  assert.deepStrictEqual(toollogs(root), ['fresh-session.jsonl']);
});
t('CLI apply --force with cleanup=report -> the explicit request wins for this one run', () => {
  const root = fixtureRoot(null);
  const r = runCli(['apply', '--root', root, '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(batches(root), ['batch-2', 'batch-3', 'batch-4', 'batch-5', 'batch-6']);
});

// ---- 4) cleanupGate + configOn: the pure decision, including the fail-safe default ----
console.log('\n4) cleanupGate — pure decision, fail-safe default report');
t('scan is never gated; apply is refused by default and names the owner reason', () => {
  assert.strictEqual(R.cleanupGate('scan', { projectRoot: fixtureRoot(null) }).allowed, true);
  const g = R.cleanupGate('apply', { projectRoot: fixtureRoot(null) });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.reason, 'owner config cleanup=report');
});
t('cleanup=auto in the project settings -> apply allowed', () => {
  assert.strictEqual(R.cleanupGate('apply', { projectRoot: fixtureRoot({ cleanup: { value: 'auto' } }) }).allowed, true);
});
t('config module absent (null) or throwing -> schema default report (refused), even when the file says auto', () => {
  const root = fixtureRoot({ cleanup: { value: 'auto' } });
  assert.strictEqual(R.cleanupGate('apply', { projectRoot: root, configModule: null }).allowed, false);
  assert.strictEqual(R.cleanupGate('apply', { projectRoot: root, configModule: { get() { throw new Error('boom'); } } }).allowed, false);
});
t('a malformed settings file makes the REAL resolver throw -> refused (a broken file never deletes)', () => {
  const root = fixtureRoot(null);
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), '{ not json');
  assert.strictEqual(R.cleanupGate('apply', { projectRoot: root }).allowed, false);
  const r = runCli(['apply', '--root', root]);
  assert.strictEqual(r.status, 3);
  assert.deepStrictEqual(batches(root), ALL_BATCHES);
});
t('M3: a damaged settings file that said cleanup=auto -> refused at the SAFE value report (flag D) + a one-line note (CLI: stderr)', () => {
  const root = fixtureRoot(null);
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { cleanup: { value: 'auto' }, nvidia: { value: 'banana' } } }));
  const g = R.cleanupGate('apply', { projectRoot: root });
  assert.strictEqual(g.allowed, false);
  assert.ok(/damaged/.test(g.config_note || '') && /cleanup = report/.test(g.config_note) && !/\n/.test(g.config_note), 'config_note: ' + g.config_note);
  const r = runCli(['apply', '--root', root]);
  assert.strictEqual(r.status, 3);
  assert.ok(/NOTE \(settings\)/.test(r.stderr || ''), 'stderr: ' + r.stderr);
  assert.deepStrictEqual(batches(root), ALL_BATCHES, 'a broken settings file never deletes');
  assert.strictEqual(R.cleanupGate('apply', { projectRoot: fixtureRoot({ cleanup: { value: 'auto' } }) }).config_note, undefined);
});
t('configOn ignores a wrong-typed value and honours a real enum value', () => {
  assert.strictEqual(R.configOn('cleanup', 'report', { configModule: { get: () => ({ value: true }) } }), 'report');
  assert.strictEqual(R.configOn('cleanup', 'report', { configModule: { get: () => ({ value: 'auto' }) } }), 'auto');
});
t('the GLOBAL settings file (FORGE_CONFIG_HOME) cleanup=auto is honoured when the project sets nothing', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  fs.writeFileSync(path.join(home, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { cleanup: { value: 'auto' } } }));
  process.env.FORGE_CONFIG_HOME = home;
  try { assert.strictEqual(R.cleanupGate('apply', { projectRoot: fixtureRoot(null) }).allowed, true); }
  finally { process.env.FORGE_CONFIG_HOME = CONFIG_HOME; }
});

for (const d of [TMP, CONFIG_HOME]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ } }

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
