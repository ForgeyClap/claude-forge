#!/usr/bin/env node
'use strict';
// forge-snapshot-settings.test.cjs — real tests for the settings.json MERGE helper. This is the LOAD-BEARING
// safety suite: it proves pre-existing hooks/keys survive the merge byte-for-byte, using a FIXTURE file
// shaped like the real global ~/.claude/settings.json (never the real file itself — this suite never reads
// or writes ~/.claude/settings.json).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const mod = require('./forge-snapshot-settings.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

/** realisticGlobalFixture — shaped like the REAL ~/.claude/settings.json's hook section (2 pre-existing
 *  Forge hooks — hotspot-lock PreToolUse + secret-scrub PostToolUse — plus its own pre-existing PreCompact
 *  manual/auto entries and a matcher-less SessionStart entry, plus unrelated top-level keys). This is a
 *  hand-built FIXTURE, not the real file. */
function realisticGlobalFixture() {
  return {
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    permissions: { allow: ['Bash(npx @claude-flow*)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node "hook-safe.cjs" handler pre-edit', timeout: 5000 }] },
        { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node "forge-hook-hotspot-lock.cjs"', timeout: 5000 }] },
      ],
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node "forge-hook-secret-scrub.cjs"', timeout: 8000 }] },
      ],
      PreCompact: [
        { matcher: 'manual', hooks: [{ type: 'command', command: 'node "hook-safe.cjs" handler compact-manual' }] },
        { matcher: 'auto', hooks: [{ type: 'command', command: 'node "hook-safe.cjs" handler compact-auto' }] },
      ],
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node "hook-safe.cjs" handler session-restore', timeout: 15000 }] },
      ],
    },
    effortLevel: 'xhigh',
    model: 'opus[1m]',
  };
}

console.log('forge-snapshot-settings tests (LOAD-BEARING: settings.json merge safety)');

// ---------------------------------------------------------------------------
console.log('\n1) mergeSnapshotHooks() — fresh (no existing file)');
t('null/absent existing -> creates PreCompact[2] + SessionStart[1] from scratch', () => {
  const { settings, added } = mod.mergeSnapshotHooks(null, { markerCommand: 'node marker.cjs', reinjectCommand: 'node reinject.cjs' });
  assert.strictEqual(settings.hooks.PreCompact.length, 2);
  assert.strictEqual(settings.hooks.SessionStart.length, 1);
  assert.strictEqual(added.length, 3);
});

// ---------------------------------------------------------------------------
console.log('\n2) mergeSnapshotHooks() — THE load-bearing safety property');
t('every pre-existing hook entry (hotspot-lock, secret-scrub, existing PreCompact/SessionStart) survives byte-for-byte, plus new entries are appended', () => {
  const existing = realisticGlobalFixture();
  const existingJson = JSON.stringify(existing); // snapshot BEFORE calling merge, to prove no mutation
  const { settings, added } = mod.mergeSnapshotHooks(existing, { markerCommand: 'node ".claude\\forge-bin\\forge-snapshot-marker.cjs"', reinjectCommand: 'node ".claude\\forge-bin\\forge-snapshot-reinject.cjs"' });

  // 1. the input object itself was never mutated
  assert.strictEqual(JSON.stringify(existing), existingJson, 'mergeSnapshotHooks must never mutate its input');

  // 2. every pre-existing PreToolUse/PostToolUse hook survives untouched (different event names entirely)
  assert.strictEqual(settings.hooks.PreToolUse.length, 2);
  assert.ok(settings.hooks.PreToolUse.some((e) => e.hooks[0].command.includes('forge-hook-hotspot-lock.cjs')));
  assert.strictEqual(settings.hooks.PostToolUse.length, 1);
  assert.ok(settings.hooks.PostToolUse[0].hooks[0].command.includes('forge-hook-secret-scrub.cjs'));

  // 3. the 2 pre-existing PreCompact entries (hook-safe.cjs compact-manual/compact-auto) survive AND 2 new
  //    ones are appended (never replaced)
  assert.strictEqual(settings.hooks.PreCompact.length, 4);
  assert.ok(settings.hooks.PreCompact.some((e) => e.matcher === 'manual' && e.hooks[0].command.includes('hook-safe.cjs')));
  assert.ok(settings.hooks.PreCompact.some((e) => e.matcher === 'auto' && e.hooks[0].command.includes('hook-safe.cjs')));
  assert.ok(settings.hooks.PreCompact.some((e) => e.matcher === 'manual' && e.hooks[0].command.includes('forge-snapshot-marker.cjs')));
  assert.ok(settings.hooks.PreCompact.some((e) => e.matcher === 'auto' && e.hooks[0].command.includes('forge-snapshot-marker.cjs')));

  // 4. the pre-existing (matcher-less) SessionStart entry survives AND a new matcher:"compact" entry is added
  assert.strictEqual(settings.hooks.SessionStart.length, 2);
  assert.ok(settings.hooks.SessionStart.some((e) => !e.matcher && e.hooks[0].command.includes('session-restore')));
  assert.ok(settings.hooks.SessionStart.some((e) => e.matcher === 'compact' && e.hooks[0].command.includes('forge-snapshot-reinject.cjs')));

  // 5. unrelated top-level keys survive untouched
  assert.strictEqual(settings.effortLevel, 'xhigh');
  assert.strictEqual(settings.model, 'opus[1m]');
  assert.deepStrictEqual(settings.env, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  assert.deepStrictEqual(settings.permissions, { allow: ['Bash(npx @claude-flow*)'] });

  assert.strictEqual(added.length, 3);
});

// ---------------------------------------------------------------------------
console.log('\n3) idempotency — re-running never duplicates entries');
t('applying the merge twice adds nothing new the second time', () => {
  const existing = realisticGlobalFixture();
  const opts = { markerCommand: 'node marker.cjs', reinjectCommand: 'node reinject.cjs' };
  const r1 = mod.mergeSnapshotHooks(existing, opts);
  const r2 = mod.mergeSnapshotHooks(r1.settings, opts);
  assert.strictEqual(r2.added.length, 0);
  assert.strictEqual(r2.settings.hooks.PreCompact.length, r1.settings.hooks.PreCompact.length);
  assert.strictEqual(r2.settings.hooks.SessionStart.length, r1.settings.hooks.SessionStart.length);
});

// ---------------------------------------------------------------------------
console.log('\n4) hasExactHook()');
t('hasExactHook finds an exact matcher+command match and rejects a near-miss', () => {
  const list = [{ matcher: 'manual', hooks: [{ command: 'node x.cjs' }] }];
  assert.strictEqual(mod.hasExactHook(list, 'manual', 'node x.cjs'), true);
  assert.strictEqual(mod.hasExactHook(list, 'auto', 'node x.cjs'), false);
  assert.strictEqual(mod.hasExactHook(list, 'manual', 'node y.cjs'), false);
  assert.strictEqual(mod.hasExactHook(null, 'manual', 'node x.cjs'), false);
});

// ---------------------------------------------------------------------------
console.log('\n5) CLI (real spawned subprocess, real filesystem)');
const CLI = path.join(__dirname, 'forge-snapshot-settings.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

t('CLI apply creates a minimal file when the target is absent', () => {
  const dir = freshDir('settings-cli-fresh');
  const target = path.join(dir, 'settings.json');
  const r = runCLI(['apply', '--target', target, '--marker-command', 'node marker.cjs', '--reinject-command', 'node reinject.cjs', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(written.hooks.PreCompact.length, 2);
});

t('CLI apply --backup preserves the ORIGINAL bytes in a sibling .bak-snapshot-<ts> file', () => {
  const dir = freshDir('settings-cli-backup');
  const target = path.join(dir, 'settings.json');
  const originalContent = JSON.stringify(realisticGlobalFixture(), null, 2);
  fs.writeFileSync(target, originalContent);
  const r = runCLI(['apply', '--target', target, '--marker-command', 'node marker.cjs', '--reinject-command', 'node reinject.cjs', '--backup']);
  assert.strictEqual(r.status, 0, r.stderr);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-snapshot-'));
  assert.strictEqual(backups.length, 1, 'expected exactly one backup file');
  const backupContent = fs.readFileSync(path.join(dir, backups[0]), 'utf8');
  assert.strictEqual(backupContent, originalContent, 'backup must preserve the ORIGINAL bytes exactly');
});

t('CLI apply refuses to touch a malformed existing JSON file (fail closed, exit 2, file untouched)', () => {
  const dir = freshDir('settings-cli-malformed');
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{ this is not valid json');
  const before = fs.readFileSync(target, 'utf8');
  const r = runCLI(['apply', '--target', target, '--marker-command', 'node marker.cjs', '--reinject-command', 'node reinject.cjs']);
  assert.strictEqual(r.status, 2);
  const after = fs.readFileSync(target, 'utf8');
  assert.strictEqual(after, before, 'a malformed existing file must never be overwritten');
});

t('CLI apply is idempotent when run twice against the same target', () => {
  const dir = freshDir('settings-cli-idempotent');
  const target = path.join(dir, 'settings.json');
  runCLI(['apply', '--target', target, '--marker-command', 'node marker.cjs', '--reinject-command', 'node reinject.cjs']);
  const r2 = runCLI(['apply', '--target', target, '--marker-command', 'node marker.cjs', '--reinject-command', 'node reinject.cjs', '--json']);
  assert.strictEqual(r2.status, 0);
  const parsed = JSON.parse(r2.stdout.trim());
  assert.strictEqual(parsed.added.length, 0);
});

t('CLI with missing required args exits 2', () => {
  const r = runCLI(['apply', '--target', '/tmp/x.json']);
  assert.strictEqual(r.status, 2);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
