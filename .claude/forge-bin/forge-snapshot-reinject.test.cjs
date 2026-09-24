#!/usr/bin/env node
'use strict';
// forge-snapshot-reinject.test.cjs — real tests for the SessionStart(matcher:compact) re-injection hook
// target. Every fixture runs under a fresh os.tmpdir() project — never touches this repo's real .claude/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const reinject = require('./forge-snapshot-reinject.cjs');

// Hermetic owner settings (forge-config.cjs, v2.7.0): the global settings file is read from a throwaway home,
// never ~/.claude, and FORGE_PROJECT_ROOT is cleared so each fixture ROOT decides which project file is read.
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reinj-cfghome-'));
process.env.FORGE_CONFIG_HOME = CONFIG_HOME;
delete process.env.FORGE_PROJECT_ROOT;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeDue(root, overrides) {
  const dir = path.join(root, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge-snapshot-due.json'), JSON.stringify(Object.assign({
    reason: 'precompact-auto', compaction_type: 'auto', session_id: 's1', transcript_path: null, at: new Date().toISOString(),
  }, overrides || {})));
}
function writeSnapshot(root, sections) {
  const md = [
    '# FORGE SNAPSHOT — test',
    '',
    '## 1. Mission',
    sections.mission || '<!-- MISSION:BEGIN -->\nBuild the thing.\n<!-- MISSION:END -->',
    '',
    '## 2. Why',
    'because reasons',
    '',
    '## 3. Current state',
    sections.currentState || '### Done\n- something done',
    '',
    '## 8. Next actions',
    sections.nextActions || '- do the next thing',
    '',
    '## 9. Evidence pointers',
    '- some/path',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_SNAPSHOT.md'), md);
}

console.log('forge-snapshot-reinject tests (SessionStart matcher:compact hook target)');

// ---------------------------------------------------------------------------
console.log('\n1) no due-marker -> prints NOTHING, honest no-op');
t('no marker present -> printed:false, text:null, no throw', () => {
  const root = freshRoot('reinj-nomarker');
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.printed, false);
  assert.strictEqual(r.text, null);
});

// ---------------------------------------------------------------------------
console.log('\n2) marker present -> bounded, high-signal block + marker consumed');
t('with a marker + a real snapshot, prints Mission/Current state/Next actions and deletes the marker', () => {
  const root = freshRoot('reinj-withmarker');
  writeDue(root, { reason: 'precompact-manual' });
  writeSnapshot(root, {});
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.printed, true);
  assert.ok(r.text.includes('Build the thing.'));
  assert.ok(r.text.includes('do the next thing'));
  assert.ok(r.text.includes('precompact-manual'));
  assert.strictEqual(r.dueConsumed, true);
  assert.ok(!fs.existsSync(path.join(root, '.claude', '.forge-snapshot-due.json')));
});

t('a SECOND run with no marker left (already consumed) prints nothing', () => {
  const root = freshRoot('reinj-secondrun');
  writeDue(root, {});
  writeSnapshot(root, {});
  reinject.run({ projectRoot: root }); // consumes it
  const r2 = reinject.run({ projectRoot: root });
  assert.strictEqual(r2.printed, false);
});

// ---------------------------------------------------------------------------
console.log('\n3) size discipline — bounded output even for an oversized snapshot');
t('an oversized Current state section is truncated so the printed block stays bounded', () => {
  const root = freshRoot('reinj-oversized');
  writeDue(root, {});
  const bigList = Array.from({ length: 300 }, (_, i) => '- item ' + i + ' with some padding text to grow the section').join('\n');
  writeSnapshot(root, { currentState: bigList });
  const r = reinject.run({ projectRoot: root });
  assert.ok(r.text.length <= reinject.MAX_CHARS + 200, 'expected the printed block to respect the size budget (with small overhead for the truncation marker)');
  assert.ok(r.text.includes('truncated'));
});

// ---------------------------------------------------------------------------
console.log('\n4) missing snapshot file — honest message, marker still consumed');
t('marker present but FORGE_SNAPSHOT.md missing -> honest "no prior snapshot" text, marker still cleared', () => {
  const root = freshRoot('reinj-nosnapshot');
  writeDue(root, {});
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.printed, true);
  assert.ok(r.text.includes('was not found'));
  assert.strictEqual(r.dueConsumed, true);
});

// ---------------------------------------------------------------------------
console.log('\n5) extractSection()');
t('extractSection isolates exactly the named section body, stopping at the next numbered heading', () => {
  const text = '## 1. Mission\nmission text\nmore mission\n\n## 2. Why\nwhy text\n';
  assert.strictEqual(reinject.extractSection(text, 'Mission'), 'mission text\nmore mission');
  assert.strictEqual(reinject.extractSection(text, 'Why'), 'why text');
});
t('extractSection returns null when the heading is not found', () => {
  assert.strictEqual(reinject.extractSection('## 1. Mission\nfoo\n', 'Nonexistent'), null);
});

// ---------------------------------------------------------------------------
console.log('\n6) CLI (real spawned subprocess, real stdin pipe)');
const CLI = path.join(__dirname, 'forge-snapshot-reinject.cjs');
function sessionStartPayload(overrides) {
  return JSON.stringify(Object.assign({ session_id: 's1', source: 'compact', hook_event_name: 'SessionStart' }, overrides || {}));
}

t('CLI with a marker present prints the re-injection block on stdout and exits 0', () => {
  const root = freshRoot('reinj-cli-with');
  writeDue(root, {});
  writeSnapshot(root, {});
  const r = spawnSync(process.execPath, [CLI], {
    input: sessionStartPayload({}),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
  });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('MISSION:'));
  assert.ok(!fs.existsSync(path.join(root, '.claude', '.forge-snapshot-due.json')));
});

t('CLI with NO marker prints nothing and exits 0', () => {
  const root = freshRoot('reinj-cli-without');
  const r = spawnSync(process.execPath, [CLI], {
    input: sessionStartPayload({ source: 'startup' }),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

t('CLI with malformed stdin never blocks (still exits 0)', () => {
  const root = freshRoot('reinj-cli-malformed');
  const r = spawnSync(process.execPath, [CLI], {
    input: 'not json {{{',
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
  });
  assert.strictEqual(r.status, 0);
});

// ---------------------------------------------------------------------------
console.log('\n7) owner setting `snapshots` (forge-config.cjs, v2.7.0) — OFF prints nothing and touches nothing');
function writeConfig(root, settings) {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings }, null, 2));
}
const dueFile = (root) => path.join(root, '.claude', '.forge-snapshot-due.json');

t('snapshots=false -> skipped, nothing printed, the due-marker is left untouched (nothing written or deleted)', () => {
  const root = freshRoot('reinj-off');
  writeDue(root, {});
  writeSnapshot(root, {});
  writeConfig(root, { snapshots: { value: false } });
  const before = fs.readFileSync(dueFile(root), 'utf8');
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'owner config snapshots=off');
  assert.strictEqual(r.printed, false);
  assert.strictEqual(r.text, null);
  assert.strictEqual(r.dueConsumed, false);
  assert.strictEqual(fs.readFileSync(dueFile(root), 'utf8'), before);
});

t('snapshots=true -> the unchanged behaviour (block printed, marker consumed)', () => {
  const root = freshRoot('reinj-on');
  writeDue(root, {});
  writeSnapshot(root, {});
  writeConfig(root, { snapshots: { value: true } });
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.skipped, undefined);
  assert.strictEqual(r.printed, true);
  assert.ok(r.text.includes('Build the thing.'));
  assert.ok(!fs.existsSync(dueFile(root)));
});

t('config module absent (configModule:null) or throwing -> schema default ON', () => {
  for (const configModule of [null, { get() { throw new Error('boom'); } }]) {
    const root = freshRoot('reinj-absent');
    writeDue(root, {});
    writeSnapshot(root, {});
    writeConfig(root, { snapshots: { value: false } });
    const r = reinject.run({ projectRoot: root, configModule });
    assert.strictEqual(r.printed, true);
  }
});

t('M3: a malformed FORGE_CONFIG.json -> the fail-safe read keeps snapshots ON (no data flag) and returns a one-line config_note', () => {
  const root = freshRoot('reinj-badcfg');
  writeDue(root, {});
  writeSnapshot(root, {});
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), '{ not json');
  const r = reinject.run({ projectRoot: root });
  assert.strictEqual(r.printed, true);
  assert.ok(/damaged/.test(r.config_note || '') && !/\n/.test(r.config_note), 'config_note: ' + r.config_note);
  const clean = freshRoot('reinj-cleancfg');
  writeDue(clean, {});
  writeConfig(clean, { snapshots: { value: true } });
  assert.strictEqual(reinject.run({ projectRoot: clean }).config_note, undefined, 'no note when the settings are fine');
});

t('configOn ignores a wrong-typed value and honours a real boolean', () => {
  assert.strictEqual(reinject.configOn('snapshots', true, { configModule: { get: () => ({ value: 0 }) } }), true);
  assert.strictEqual(reinject.configOn('snapshots', true, { configModule: { get: () => ({ value: false }) } }), false);
});

const OFF_BUDGET_MS = Number(process.env.FORGE_HOOK_OFF_BUDGET_MS) || 500;
t('CLI OFF path (FORGE_PROJECT_ROOT fixture, snapshots=false) with a due-marker present: exit 0, empty stdout/stderr, marker kept, best of 3 under ' + OFF_BUDGET_MS + ' ms', () => {
  const fixture = freshRoot('reinj-cli-off-fixture');
  writeConfig(fixture, { snapshots: { value: false } });
  const acting = freshRoot('reinj-cli-off-acting');
  writeDue(acting, {});
  writeSnapshot(acting, {});
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [CLI], {
      input: sessionStartPayload({}), encoding: 'utf8',
      env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: fixture, CLAUDE_PROJECT_DIR: acting }),
    });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(r.stderr, '');
  }
  assert.ok(fs.existsSync(dueFile(acting)), 'the OFF path consumed the marker');
  times.sort((a, b) => a - b);
  console.log('       OFF-path timings ms: ' + times.map((x) => x.toFixed(0)).join(', '));
  assert.ok(times[0] < OFF_BUDGET_MS, 'fastest OFF run took ' + times[0].toFixed(0) + ' ms (budget ' + OFF_BUDGET_MS + ' ms; override FORGE_HOOK_OFF_BUDGET_MS on a slow runner)');
});

try { fs.rmSync(CONFIG_HOME, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
