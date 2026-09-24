#!/usr/bin/env node
'use strict';
// forge-snapshot-marker.test.cjs — real tests for the PreCompact hook target. Every fixture runs under a
// fresh os.tmpdir() project — this file NEVER writes to this repo's real .claude/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const marker = require('./forge-snapshot-marker.cjs');

// Hermetic owner settings (forge-config.cjs, v2.7.0): the global settings file is read from a throwaway home,
// never ~/.claude, and FORGE_PROJECT_ROOT is cleared so each fixture ROOT decides which project file is read.
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-cfghome-'));
process.env.FORGE_CONFIG_HOME = CONFIG_HOME;
delete process.env.FORGE_PROJECT_ROOT;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
/** installForgeSnapshot — copies the REAL, already-edited forge-snapshot.cjs (+ its own real deps) into a
 *  fixture project, so a fixture can prove the marker's real integration with the real generator. */
function installForgeSnapshot(root) {
  const dir = path.join(root, '.claude', 'forge-bin');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['forge-snapshot.cjs', 'forge-manifest.cjs', 'forge-doctor.cjs', 'forge-store.cjs']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
  }
}
function preCompactPayload(overrides) {
  return JSON.stringify(Object.assign({
    session_id: 'sess-123', transcript_path: '/tmp/transcript.jsonl', cwd: '/some/cwd',
    hook_event_name: 'PreCompact', compaction_type: 'manual',
  }, overrides || {}));
}

console.log('forge-snapshot-marker tests (PreCompact hook target)');

// ---------------------------------------------------------------------------
console.log('\n1) run() — reason mapping + marker file contents');
t('compaction_type "manual" maps to reason precompact-manual and writes the due-marker', () => {
  const root = freshRoot('mark-manual');
  const r = marker.run(preCompactPayload({ compaction_type: 'manual' }), { projectRoot: root });
  assert.strictEqual(r.reason, 'precompact-manual');
  assert.strictEqual(r.wrote, true);
  const due = JSON.parse(fs.readFileSync(path.join(root, '.claude', '.forge-snapshot-due.json'), 'utf8'));
  assert.strictEqual(due.reason, 'precompact-manual');
  assert.strictEqual(due.compaction_type, 'manual');
  assert.strictEqual(due.session_id, 'sess-123');
  assert.strictEqual(due.transcript_path, '/tmp/transcript.jsonl');
  assert.ok(due.at);
});

t('compaction_type "auto" (and any non-"manual" value) maps to reason precompact-auto', () => {
  const root = freshRoot('mark-auto');
  const r1 = marker.run(preCompactPayload({ compaction_type: 'auto' }), { projectRoot: root });
  assert.strictEqual(r1.reason, 'precompact-auto');
  const r2 = marker.run(preCompactPayload({ compaction_type: 'something-unexpected' }), { projectRoot: root });
  assert.strictEqual(r2.reason, 'precompact-auto');
});

// ---------------------------------------------------------------------------
console.log('\n2) real integration with forge-snapshot.cjs');
t('when a real Forge install exists at the resolved root, run() also regenerates FORGE_SNAPSHOT.md', () => {
  const root = freshRoot('mark-realsnap');
  installForgeSnapshot(root);
  const r = marker.run(preCompactPayload({}), { projectRoot: root });
  assert.strictEqual(r.snapshotWritten, true);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'FORGE_SNAPSHOT.md')));
});

// ---------------------------------------------------------------------------
console.log('\n3) degrade silently when there is NO Forge install (core "degrades silently" requirement)');
t('a project root with no .claude/forge-bin/forge-snapshot.cjs never throws and reports snapshotWritten:false', () => {
  const root = freshRoot('mark-noforge');
  const r = marker.run(preCompactPayload({}), { projectRoot: root });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.snapshotWritten, false);
  assert.strictEqual(r.wrote, true, 'the marker file itself is project-agnostic and is still written');
});

// ---------------------------------------------------------------------------
console.log('\n4) robustness — malformed input never throws, never blocks');
t('malformed JSON on stdin still writes an honest marker with null session/transcript fields', () => {
  const root = freshRoot('mark-malformed');
  const r = marker.run('{ not valid json', { projectRoot: root });
  assert.strictEqual(r.ok, true);
  const due = JSON.parse(fs.readFileSync(path.join(root, '.claude', '.forge-snapshot-due.json'), 'utf8'));
  assert.strictEqual(due.session_id, null);
  assert.strictEqual(due.transcript_path, null);
});

t('empty stdin never throws', () => {
  const root = freshRoot('mark-empty');
  const r = marker.run('', { projectRoot: root });
  assert.strictEqual(r.ok, true);
});

// ---------------------------------------------------------------------------
console.log('\n5) resolveProjectRoot()');
t('resolveProjectRoot honors CLAUDE_PROJECT_DIR over process.cwd()', () => {
  const fakeProjectDir = freshRoot('mark-envroot');
  const prev = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = fakeProjectDir;
  try {
    const resolved = marker.resolveProjectRoot({});
    assert.strictEqual(resolved, path.resolve(fakeProjectDir));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prev;
  }
});

// ---------------------------------------------------------------------------
console.log('\n6) CLI (real spawned subprocess, real stdin pipe) — never blocks, never prints');
const CLI = path.join(__dirname, 'forge-snapshot-marker.cjs');
t('CLI with a real PreCompact JSON piped on stdin exits 0 and writes the marker at CLAUDE_PROJECT_DIR', () => {
  const root = freshRoot('mark-cli');
  const r = spawnSync(process.execPath, [CLI], {
    input: preCompactPayload({ compaction_type: 'manual', session_id: 'cli-sess' }),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
  });
  assert.strictEqual(r.status, 0);
  const dueFile = path.join(root, '.claude', '.forge-snapshot-due.json');
  assert.ok(fs.existsSync(dueFile));
  const due = JSON.parse(fs.readFileSync(dueFile, 'utf8'));
  assert.strictEqual(due.session_id, 'cli-sess');
});

t('CLI never prints anything to stdout in the success path (PreCompact stdout is not context-injected)', () => {
  const root = freshRoot('mark-cli-silent');
  const r = spawnSync(process.execPath, [CLI], {
    input: preCompactPayload({}),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

t('CLI with malformed stdin still exits 0 (never blocks)', () => {
  const root = freshRoot('mark-cli-malformed');
  const r = spawnSync(process.execPath, [CLI], {
    input: 'not json at all {{{',
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
  });
  assert.strictEqual(r.status, 0);
});

// ---------------------------------------------------------------------------
console.log('\n7) owner setting `snapshots` (forge-config.cjs, v2.7.0) — OFF writes nothing; ON / module absent = unchanged');
function writeConfig(root, settings) {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings }, null, 2));
}
function claudeEntries(root) { try { return fs.readdirSync(path.join(root, '.claude')).sort(); } catch { return []; } }

t('snapshots=false in the project file -> skipped with the owner-config reason, and NOTHING is written', () => {
  const root = freshRoot('mark-off');
  installForgeSnapshot(root);
  writeConfig(root, { snapshots: { value: false } });
  const r = marker.run(preCompactPayload({}), { projectRoot: root });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'owner config snapshots=off');
  assert.strictEqual(r.wrote, false);
  assert.strictEqual(r.snapshotWritten, false);
  assert.deepStrictEqual(claudeEntries(root), ['FORGE_CONFIG.json', 'forge-bin'], 'no marker, no FORGE_SNAPSHOT.md, no diagnostics log');
});

t('snapshots=true in the project file -> the unchanged behaviour (marker + real snapshot written)', () => {
  const root = freshRoot('mark-on');
  installForgeSnapshot(root);
  writeConfig(root, { snapshots: { value: true } });
  const r = marker.run(preCompactPayload({}), { projectRoot: root });
  assert.strictEqual(r.skipped, undefined);
  assert.strictEqual(r.wrote, true);
  assert.strictEqual(r.snapshotWritten, true);
});

t('no settings file at all -> the schema default (ON): the marker is written exactly as before', () => {
  const root = freshRoot('mark-default');
  const r = marker.run(preCompactPayload({}), { projectRoot: root });
  assert.strictEqual(r.skipped, undefined);
  assert.strictEqual(r.wrote, true);
});

t('the GLOBAL settings file (FORGE_CONFIG_HOME) turning snapshots off is honoured when the project sets nothing', () => {
  const home = freshRoot('mark-globalhome');
  fs.writeFileSync(path.join(home, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { snapshots: { value: false } } }));
  const root = freshRoot('mark-global-off');
  process.env.FORGE_CONFIG_HOME = home;
  try {
    const r = marker.run(preCompactPayload({}), { projectRoot: root });
    assert.strictEqual(r.skipped, true);
    assert.deepStrictEqual(claudeEntries(root), []);
  } finally { process.env.FORGE_CONFIG_HOME = CONFIG_HOME; }
});

t('config module absent (configModule:null) -> schema default ON, even when a file says OFF', () => {
  const root = freshRoot('mark-absent');
  writeConfig(root, { snapshots: { value: false } });
  const r = marker.run(preCompactPayload({}), { projectRoot: root, configModule: null });
  assert.strictEqual(r.skipped, undefined);
  assert.strictEqual(r.wrote, true);
});

t('a config module that throws -> schema default ON (fail-open to the default, never a crash)', () => {
  const root = freshRoot('mark-throws');
  const r = marker.run(preCompactPayload({}), { projectRoot: root, configModule: { get() { throw new Error('boom'); } } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wrote, true);
});

t('a malformed FORGE_CONFIG.json makes the REAL resolver throw -> configOn falls back to ON', () => {
  const root = freshRoot('mark-badcfg');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), '{ not json');
  const r = marker.run(preCompactPayload({}), { projectRoot: root });
  assert.strictEqual(r.wrote, true);
  assert.ok(/damaged/.test(r.config_note || '') && /snapshots/.test(r.config_note), 'degraded (M3): ' + r.config_note);
});

t('M3: configRead prefers safeGet, reports degraded, and falls back to get() for an older module copy', () => {
  const degraded = marker.configRead('snapshots', true, { configModule: { safeGet: () => ({ value: true, source: 'default', degraded: true, reason: 'the file is damaged' }), get() { throw new Error('get must not be used'); } } });
  assert.deepStrictEqual([degraded.value, degraded.degraded, degraded.reason], [true, true, 'the file is damaged']);
  const old = marker.configRead('snapshots', true, { configModule: { get: () => ({ value: false, source: 'project' }) } });
  assert.deepStrictEqual([old.value, old.degraded], [false, false]);
  const absent = marker.configRead('snapshots', true, { configModule: null });
  assert.deepStrictEqual([absent.value, absent.degraded, /not found/.test(absent.reason)], [true, true, true]);
  const r = marker.run(preCompactPayload({}), { projectRoot: freshRoot('mark-cfgnote'), configModule: null });
  assert.ok(/not found/.test(r.config_note || ''), 'the absent module is named in the result');
});

t('configOn ignores a wrong-typed value and honours a real boolean', () => {
  assert.strictEqual(marker.configOn('snapshots', true, { configModule: { get: () => ({ value: 'off' }) } }), true);
  assert.strictEqual(marker.configOn('snapshots', true, { configModule: { get: () => ({ value: false }) } }), false);
  assert.strictEqual(marker.configOn('snapshots', true, { configModule: {} }), true, 'a module without get() counts as absent');
});

t('a copy with NO sibling forge-config.cjs (the global ~/.claude/forge-bin deployment) reads the setting of the TARGET project', () => {
  const proj = freshRoot('mark-globalcopy-proj');
  const pbin = path.join(proj, '.claude', 'forge-bin');
  fs.mkdirSync(pbin, { recursive: true });
  // forge-config-once.cjs (Codex recheck 2026-09-24) is a required sibling of forge-config.cjs — any copy of
  // the latter needs it too, exactly like forge-config-text.cjs already did. forge-config-once-store.cjs (wave 6,
  // V09: the exactly-once pending -> consumed store) joined that list the same way: a vendored forge-config.cjs
  // without it throws MODULE_NOT_FOUND, and the marker's fail-open default would then hide the missing sibling.
  for (const f of ['forge-config.cjs', 'forge-config-text.cjs', 'forge-config-once.cjs', 'forge-config-once-store.cjs']) fs.copyFileSync(path.join(__dirname, f), path.join(pbin, f));
  const orch = path.join(proj, '.claude', 'config', 'orchestration');
  fs.mkdirSync(orch, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'), path.join(orch, 'FORGE_CONFIG_SCHEMA.json'));
  writeConfig(proj, { snapshots: { value: false } });
  const globalBin = path.join(freshRoot('mark-globalcopy-home'), 'forge-bin');
  fs.mkdirSync(globalBin, { recursive: true });
  fs.copyFileSync(CLI, path.join(globalBin, 'forge-snapshot-marker.cjs'));
  const r = spawnSync(process.execPath, [path.join(globalBin, 'forge-snapshot-marker.cjs')], {
    input: preCompactPayload({}), encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: proj }),
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(path.join(proj, '.claude', '.forge-snapshot-due.json')), 'the global copy ignored the project setting');
});

const OFF_BUDGET_MS = Number(process.env.FORGE_HOOK_OFF_BUDGET_MS) || 500;
t('CLI OFF path (FORGE_PROJECT_ROOT fixture, snapshots=false): exit 0, no stdout/stderr, nothing written anywhere, best of 3 under ' + OFF_BUDGET_MS + ' ms', () => {
  const fixture = freshRoot('mark-cli-off-fixture');
  writeConfig(fixture, { snapshots: { value: false } });
  const acting = freshRoot('mark-cli-off-acting');
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [CLI], {
      input: preCompactPayload({}), encoding: 'utf8',
      env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: fixture, CLAUDE_PROJECT_DIR: acting }),
    });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(r.stderr, '');
  }
  assert.deepStrictEqual(claudeEntries(fixture), ['FORGE_CONFIG.json']);
  assert.deepStrictEqual(claudeEntries(acting), []);
  times.sort((a, b) => a - b);
  console.log('       OFF-path timings ms: ' + times.map((x) => x.toFixed(0)).join(', '));
  assert.ok(times[0] < OFF_BUDGET_MS, 'fastest OFF run took ' + times[0].toFixed(0) + ' ms (budget ' + OFF_BUDGET_MS + ' ms; override FORGE_HOOK_OFF_BUDGET_MS on a slow runner)');
});

try { fs.rmSync(CONFIG_HOME, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
