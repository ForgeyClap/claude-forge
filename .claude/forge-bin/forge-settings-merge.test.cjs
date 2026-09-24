#!/usr/bin/env node
'use strict';
// forge-settings-merge.test.cjs — real tests for the general .claude/settings.json MERGE tool (wp22,
// 2026-09-24). This is the LOAD-BEARING safety suite: it proves a foreign hook, a foreign allow rule and an
// unknown top-level key all survive byte-for-byte at their original position, using a fixture shaped like
// the REAL project .claude/settings.json (5 hooks + 23 deny rules) as the SOURCE — never the real file
// itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const mod = require('./forge-settings-merge.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

/** realSourceFixture — shaped like the REAL .claude/settings.json: 3 snapshot hooks, the tool-ledger
 *  PostToolUse hook, the PreToolUse gate hook (all 5 with `timeout` in SECONDS, <=60), plus the 23-rule
 *  permissions.deny block. A hand-built FIXTURE, not the real file. */
function realSourceFixture() {
  return {
    hooks: {
      PreCompact: [
        { matcher: 'manual', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-snapshot-marker.cjs', timeout: 15 }] },
        { matcher: 'auto', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-snapshot-marker.cjs', timeout: 15 }] },
      ],
      SessionStart: [
        { matcher: 'compact', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-snapshot-reinject.cjs', timeout: 15 }] },
      ],
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-toolhook.cjs', timeout: 10 }] },
      ],
      PreToolUse: [
        { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"', timeout: 10 }] },
      ],
    },
    permissions: {
      deny: [
        'Read(./.env)', 'Read(./.env.local)', 'Read(./.env.*.local)', 'Read(./.env.development)',
        'Read(./.env.production)', 'Read(./.env.staging)', 'Read(./.env.test)', 'Read(./secrets/**)',
        'Read(./**/.env)', 'Read(./**/.env.local)', 'Read(./**/.env.*.local)', 'Read(./**/.env.production)',
        'Read(./**/.env.prod)', 'Read(./**/.env.bak)', 'Read(./**/.env.backup)', 'Read(./**/*.pem)',
        'Read(./**/*.key)', 'Read(./**/id_rsa*)', 'Read(./**/id_ed25519*)', 'Read(./**/secrets/**)',
        'Read(~/.claude/.credentials.json)', 'Read(~/.claude/nvidia.env)', 'Read(~/.ssh/**)',
      ],
    },
  };
}

/** existingWithForeignEntries — a target that already has its OWN unrelated hook, allow rule, and unknown
 *  top-level key, plus ONE stale Forge hook using the old milliseconds-as-seconds timeout (8000, > 60). */
function existingWithForeignEntries() {
  return {
    env: { SOME_OWNER_VAR: '1' },
    permissions: {
      allow: ['Bash(npm run build)'],
      deny: ['Bash(rm -rf *)'],
    },
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node "my-own-hook.cjs"', timeout: 5 }] },
      ],
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-toolhook.cjs', timeout: 8000 }] },
      ],
    },
    ownerNote: 'do not touch this field',
  };
}

console.log('forge-settings-merge tests (LOAD-BEARING: general settings.json merge safety)');

// ---------------------------------------------------------------------------
console.log('\n1) mergeForgeSettings() — pure-function safety property');
t('foreign hook + foreign allow rule + unknown top-level key survive byte-for-byte; missing entries appended', () => {
  const existing = existingWithForeignEntries();
  const existingJson = JSON.stringify(existing); // snapshot BEFORE calling merge, to prove no mutation
  const source = realSourceFixture();
  const sourceJson = JSON.stringify(source);
  const { settings, added, adjusted, deny_added } = mod.mergeForgeSettings(existing, source);

  assert.strictEqual(JSON.stringify(existing), existingJson, 'mergeForgeSettings must never mutate existing');
  assert.strictEqual(JSON.stringify(source), sourceJson, 'mergeForgeSettings must never mutate source');

  // foreign PreToolUse hook survives at its original position, own hooks array still length 1 + the new gate hook appended
  assert.strictEqual(settings.hooks.PreToolUse.length, 2);
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'node "my-own-hook.cjs"');
  assert.ok(settings.hooks.PreToolUse.some((e) => e.hooks[0].command.includes('forge-gate-hook.cjs')));

  // the 3 missing events (PreCompact x2 entries, SessionStart) are all appended
  assert.strictEqual(settings.hooks.PreCompact.length, 2);
  assert.strictEqual(settings.hooks.SessionStart.length, 1);

  // unrelated top-level keys survive
  assert.deepStrictEqual(settings.env, { SOME_OWNER_VAR: '1' });
  assert.strictEqual(settings.ownerNote, 'do not touch this field');
  assert.deepStrictEqual(settings.permissions.allow, ['Bash(npm run build)']);

  // deny union: user's own rule stays first, 23 source rules appended after (23 new, since none pre-existed)
  assert.strictEqual(settings.permissions.deny[0], 'Bash(rm -rf *)');
  assert.strictEqual(settings.permissions.deny.length, 1 + 23);
  assert.strictEqual(deny_added.length, 23);

  assert.ok(added.length >= 3);
});

// ---------------------------------------------------------------------------
console.log('\n2) millisecond timeout fix — Forge hooks only, only when > 60');
t('a stale Forge hook timeout (8000) is fixed to the source value; a foreign hook with the same shape is untouched', () => {
  const existing = existingWithForeignEntries();
  const source = realSourceFixture();
  const { settings, adjusted } = mod.mergeForgeSettings(existing, source);
  const forgeHook = settings.hooks.PostToolUse.find((e) => e.hooks[0].command.includes('forge-toolhook.cjs'));
  assert.strictEqual(forgeHook.hooks[0].timeout, 10, 'the stale 8000 must be fixed to the source seconds value');
  assert.strictEqual(adjusted.length, 1);
  assert.strictEqual(adjusted[0].from, 8000);
  assert.strictEqual(adjusted[0].to, 10);
  // the foreign hook (non-Forge command, timeout 5, already <= 60 anyway) is untouched
  const foreignHook = settings.hooks.PreToolUse.find((e) => e.hooks[0].command === 'node "my-own-hook.cjs"');
  assert.strictEqual(foreignHook.hooks[0].timeout, 5);
});

t('a Forge hook timeout that is already <= 60 is left alone (no false adjustment)', () => {
  const existing = { hooks: { PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-toolhook.cjs', timeout: 10 }] }] } };
  const source = realSourceFixture();
  const { adjusted } = mod.mergeForgeSettings(existing, source);
  assert.strictEqual(adjusted.length, 0);
});

t('a NON-Forge hook command with a timeout > 60 is never adjusted (Forge-command test must be real)', () => {
  const existing = { hooks: { PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-toolhook.cjs', timeout: 10 }, { type: 'command', command: 'node my-other-tool.cjs', timeout: 9999 }] }] } };
  // craft a source entry with a matching foreign-shaped command that would collide if the guard were missing
  const source = { hooks: { PostToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node my-other-tool.cjs', timeout: 30 }] }] } };
  const { adjusted } = mod.mergeForgeSettings(existing, source);
  assert.strictEqual(adjusted.length, 0, 'a non forge-bin/forge-*.cjs command must never be auto-adjusted');
});

// ---------------------------------------------------------------------------
console.log('\n3) idempotency — target with ALL 5 hooks + 23 deny already merged is a true no-op');
t('applying against an already-fully-merged target adds/adjusts nothing', () => {
  const already = mod.mergeForgeSettings({}, realSourceFixture()).settings;
  const { added, adjusted, deny_added } = mod.mergeForgeSettings(already, realSourceFixture());
  assert.strictEqual(added.length, 0);
  assert.strictEqual(adjusted.length, 0);
  assert.strictEqual(deny_added.length, 0);
});

t('applying the merge twice in a row (against a target with foreign entries) is idempotent the second time', () => {
  const existing = existingWithForeignEntries();
  const r1 = mod.mergeForgeSettings(existing, realSourceFixture());
  const r2 = mod.mergeForgeSettings(r1.settings, realSourceFixture());
  assert.strictEqual(r2.added.length, 0);
  assert.strictEqual(r2.adjusted.length, 0);
  assert.strictEqual(r2.deny_added.length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n4) validShape()');
t('rejects a non-object, an array-shaped hooks, a non-array hooks.<event>, and a non-array permissions.deny', () => {
  assert.strictEqual(mod.validShape(null), false);
  assert.strictEqual(mod.validShape([1, 2]), false);
  assert.strictEqual(mod.validShape({ hooks: [] }), false);
  assert.strictEqual(mod.validShape({ hooks: { PreToolUse: {} } }), false);
  assert.strictEqual(mod.validShape({ permissions: { deny: 'nope' } }), false);
  assert.strictEqual(mod.validShape({ hooks: { PreToolUse: [] }, permissions: { deny: [] } }), true);
  assert.strictEqual(mod.validShape({}), true);
});

// ---------------------------------------------------------------------------
console.log('\n5) applySettingsMerge() — file-level orchestration (real filesystem)');
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }

t('target absent -> created (a copy of the source)', () => {
  const dir = freshDir('settings-merge-create');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'nested', 'settings.json');
  writeJson(source, realSourceFixture());
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'created');
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(written.hooks.PreToolUse.length, 1);
});

t('target present with foreign entries -> merged; foreign hook + allow rule + unknown key kept; backup written', () => {
  const dir = freshDir('settings-merge-merge');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'merged');
  assert.ok(r.backupPath && fs.existsSync(r.backupPath), 'a backup file must exist');
  const backupContent = JSON.parse(fs.readFileSync(r.backupPath, 'utf8'));
  assert.deepStrictEqual(backupContent, existingWithForeignEntries(), 'backup must preserve the ORIGINAL content exactly');
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(written.hooks.PreToolUse[0].hooks[0].command, 'node "my-own-hook.cjs"', 'foreign hook kept at original position');
  assert.deepStrictEqual(written.permissions.allow, ['Bash(npm run build)']);
  assert.strictEqual(written.ownerNote, 'do not touch this field');
});

t('second run against an already-merged target is a true no-op: exit-equivalent noop, mtime unchanged, no new backup', () => {
  const dir = freshDir('settings-merge-noop');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  mod.applySettingsMerge({ target, source }); // first run: real merge + backup
  const backupsAfterFirst = fs.readdirSync(dir).filter((f) => f.includes('.forge-bak-'));
  const mtimeBefore = fs.statSync(target).mtimeMs;
  const r2 = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r2.status, 'noop');
  assert.strictEqual(fs.statSync(target).mtimeMs, mtimeBefore, 'a no-op merge must never rewrite the file (mtime unchanged)');
  const backupsAfterSecond = fs.readdirSync(dir).filter((f) => f.includes('.forge-bak-'));
  assert.strictEqual(backupsAfterSecond.length, backupsAfterFirst.length, 'a no-op merge must never take a new backup');
});

t('deny union keeps the user\'s own rule(s) first, source rules appended after in source order', () => {
  const dir = freshDir('settings-merge-deny-order');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, { permissions: { deny: ['Bash(rm -rf *)', 'Read(./.env)'] } }); // one already-present source rule
  mod.applySettingsMerge({ target, source });
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(written.permissions.deny[0], 'Bash(rm -rf *)');
  assert.strictEqual(written.permissions.deny[1], 'Read(./.env)');
  assert.strictEqual(written.permissions.deny.length, 2 + 22); // 22 NEW source rules (1 already present)
});

t('invalid existing JSON -> refused, file untouched, settings.forge-recommended.json written, ok:false', () => {
  const dir = freshDir('settings-merge-badjson');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  fs.writeFileSync(target, '{ this is not valid json', 'utf8');
  const before = fs.readFileSync(target, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before, 'a malformed existing file must never be overwritten');
  assert.ok(fs.existsSync(path.join(dir, 'settings.forge-recommended.json')));
});

t('unexpected shape (hooks not an object) -> refused, file untouched, recommended file written', () => {
  const dir = freshDir('settings-merge-badshape');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, { hooks: 'nope' });
  const before = fs.readFileSync(target, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before);
  assert.ok(fs.existsSync(path.join(dir, 'settings.forge-recommended.json')));
});

t('--dry-run (opts.dryRun) writes nothing at all, in every branch', () => {
  const dir = freshDir('settings-merge-dryrun');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());

  const absentTarget = path.join(dir, 'absent', 'settings.json');
  const r1 = mod.applySettingsMerge({ target: absentTarget, source, dryRun: true });
  assert.strictEqual(r1.status, 'would-create');
  assert.strictEqual(fs.existsSync(absentTarget), false);

  const mergeTarget = path.join(dir, 'settings.json');
  writeJson(mergeTarget, existingWithForeignEntries());
  const beforeContent = fs.readFileSync(mergeTarget, 'utf8');
  const r2 = mod.applySettingsMerge({ target: mergeTarget, source, dryRun: true });
  assert.strictEqual(r2.status, 'would-merge');
  assert.strictEqual(fs.readFileSync(mergeTarget, 'utf8'), beforeContent);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes('.forge-bak-')).length, 0);

  const badTarget = path.join(dir, 'bad.json');
  fs.writeFileSync(badTarget, 'not json', 'utf8');
  const r3 = mod.applySettingsMerge({ target: badTarget, source, dryRun: true });
  assert.strictEqual(r3.status, 'would-refuse');
  assert.strictEqual(fs.existsSync(path.join(dir, 'settings.forge-recommended.json')), false);
});

t('a UTF-8 BOM before the target JSON (Windows PowerShell Set-Content -Encoding utf8) is stripped, not treated as invalid JSON', () => {
  const dir = freshDir('settings-merge-bom');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  fs.writeFileSync(target, '﻿' + JSON.stringify(existingWithForeignEntries(), null, 2) + '\n', 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.status, 'merged');
  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(written.ownerNote, 'do not touch this field');
});

// ---------------------------------------------------------------------------
console.log('\n6) checkSettingsMerge()');
t('check reports up-to-date (ok) when nothing would change, missing-entries (not ok) otherwise', () => {
  const dir = freshDir('settings-merge-check');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());

  const merged = path.join(dir, 'merged.json');
  writeJson(merged, mod.mergeForgeSettings({}, realSourceFixture()).settings);
  assert.deepStrictEqual(mod.checkSettingsMerge({ target: merged, source }).status, 'up-to-date');
  assert.strictEqual(mod.checkSettingsMerge({ target: merged, source }).ok, true);

  const behind = path.join(dir, 'behind.json');
  writeJson(behind, existingWithForeignEntries());
  const r = mod.checkSettingsMerge({ target: behind, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'missing-entries');

  const missing = path.join(dir, 'does-not-exist.json');
  const r2 = mod.checkSettingsMerge({ target: missing, source });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.status, 'missing');
});

// ---------------------------------------------------------------------------
console.log('\n7) CLI (real spawned subprocess, real filesystem)');
const CLI = path.join(__dirname, 'forge-settings-merge.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

t('CLI apply: target absent -> exit 0, created', () => {
  const dir = freshDir('settings-merge-cli-create');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  const r = runCLI(['apply', '--target', target, '--source', source, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.status, 'created');
});

t('CLI apply: malformed existing JSON -> exit 1, file untouched', () => {
  const dir = freshDir('settings-merge-cli-bad');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  fs.writeFileSync(target, '{ nope', 'utf8');
  const before = fs.readFileSync(target, 'utf8');
  const r = runCLI(['apply', '--target', target, '--source', source]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before);
});

t('CLI apply is idempotent across two real subprocess runs (second reports noop, exit 0)', () => {
  const dir = freshDir('settings-merge-cli-idempotent');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  runCLI(['apply', '--target', target, '--source', source]);
  const r2 = runCLI(['apply', '--target', target, '--source', source, '--json']);
  assert.strictEqual(r2.status, 0);
  const parsed = JSON.parse(r2.stdout.trim());
  assert.strictEqual(parsed.status, 'noop');
});

t('CLI check: exit 0 when up to date, exit 1 when entries are missing', () => {
  const dir = freshDir('settings-merge-cli-check');
  const source = path.join(dir, 'source.json');
  const merged = path.join(dir, 'merged.json');
  const behind = path.join(dir, 'behind.json');
  writeJson(source, realSourceFixture());
  writeJson(merged, mod.mergeForgeSettings({}, realSourceFixture()).settings);
  writeJson(behind, existingWithForeignEntries());
  assert.strictEqual(runCLI(['check', '--target', merged, '--source', source]).status, 0);
  assert.strictEqual(runCLI(['check', '--target', behind, '--source', source]).status, 1);
});

t('CLI with missing required args exits 2', () => {
  const r = runCLI(['apply', '--target', path.join(os.tmpdir(), 'x.json')]);
  assert.strictEqual(r.status, 2);
});

t('CLI --dry-run leaves the target file byte-identical', () => {
  const dir = freshDir('settings-merge-cli-dryrun');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  const before = fs.readFileSync(target, 'utf8');
  const r = runCLI(['apply', '--target', target, '--source', source, '--dry-run']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
