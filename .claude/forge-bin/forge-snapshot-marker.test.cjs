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

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
