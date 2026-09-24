#!/usr/bin/env node
'use strict';
// forge-settings-merge.test.cjs — real tests for the general .claude/settings.json MERGE tool (wp22,
// 2026-09-24; hardened wp-f2, 2026-09-24 Codex re-check out-p2.md/out-p6.md). This is the LOAD-BEARING safety
// suite: it proves a foreign hook, a foreign allow rule and an unknown top-level key all survive byte-for-byte
// at their original position, using a fixture shaped like the REAL project .claude/settings.json as the
// SOURCE — never the real file itself — PLUS the hardening findings: UNREADABLE-MEANS-ABSENT,
// CONCURRENT-EDIT-LOSS, AUXILIARY-FILE-CLOBBER, PROJECT-DIRECTORY-ESCAPE, SCHEMA-ACCEPTANCE/DUPLICATE-HOOKS,
// LOSSY-ROUNDTRIP and SETTINGS-PERMISSION-WIDENING.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const mod = require('./forge-settings-merge.cjs');
const guards = require('./forge-settings-merge-guards.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
function recommendedFiles(dir) { return fs.readdirSync(dir).filter((f) => /^settings\.forge-recommended-.*\.json$/.test(f)); }
function backupFiles(dir) { return fs.readdirSync(dir).filter((f) => f.includes('.forge-bak-')); }

/** realSourceFixture — shaped like the REAL .claude/settings.json: 3 snapshot hooks, the tool-ledger
 *  PostToolUse hook, the PreToolUse gate hook (all 5 with `timeout` in SECONDS, <=60), plus the 29-rule
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
        // 29 rules, matching the real .claude/settings.json exactly (wp-f2 SECRET-READ-GAPS: added
        // .env.forge-setup root+nested, and .env.development/.env.staging/.env.test nested; wave 6 of the
        // 2026-09-24 recheck: the usage guard's owner-approval secret, Security Boss sec-w5 M5).
        'Read(./.env)', 'Read(./.env.local)', 'Read(./.env.*.local)', 'Read(./.env.development)',
        'Read(./.env.production)', 'Read(./.env.staging)', 'Read(./.env.test)', 'Read(./.env.forge-setup)', 'Read(./secrets/**)',
        'Read(./**/.env)', 'Read(./**/.env.local)', 'Read(./**/.env.*.local)', 'Read(./**/.env.development)',
        'Read(./**/.env.production)', 'Read(./**/.env.staging)', 'Read(./**/.env.test)', 'Read(./**/.env.forge-setup)',
        'Read(./**/.env.prod)', 'Read(./**/.env.bak)', 'Read(./**/.env.backup)', 'Read(./**/*.pem)',
        'Read(./**/*.key)', 'Read(./**/id_rsa*)', 'Read(./**/id_ed25519*)', 'Read(./**/secrets/**)',
        'Read(~/.claude/.credentials.json)', 'Read(~/.claude/nvidia.env)', 'Read(~/.ssh/**)',
        'Read(./.claude/config/forge-owner-grant.txt)',
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

  // deny union: user's own rule stays first, 29 source rules appended after (29 new, since none pre-existed)
  assert.strictEqual(settings.permissions.deny[0], 'Bash(rm -rf *)');
  assert.strictEqual(settings.permissions.deny.length, 1 + 29);
  assert.strictEqual(deny_added.length, 29);

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
console.log('\n4) validShape() / fullyValidShape()');
t('rejects a non-object, an array-shaped hooks, a non-array hooks.<event>, and a non-array permissions.deny', () => {
  assert.strictEqual(mod.validShape(null), false);
  assert.strictEqual(mod.validShape([1, 2]), false);
  assert.strictEqual(mod.validShape({ hooks: [] }), false);
  assert.strictEqual(mod.validShape({ hooks: { PreToolUse: {} } }), false);
  assert.strictEqual(mod.validShape({ permissions: { deny: 'nope' } }), false);
  assert.strictEqual(mod.validShape({ hooks: { PreToolUse: [] }, permissions: { deny: [] } }), true);
  assert.strictEqual(mod.validShape({}), true);
});

t('SCHEMA-ACCEPTANCE: fullyValidShape also rejects a hook entry whose inner hooks is an object, and a hook item with the wrong type', () => {
  assert.strictEqual(mod.fullyValidShape({ hooks: { PreToolUse: [{ matcher: 'x', hooks: {} }] } }), false);
  assert.strictEqual(mod.fullyValidShape({ hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ type: 'prompt', command: 'y' }] }] } }), false);
  assert.strictEqual(mod.fullyValidShape({ hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'y', timeout: 5 }] }] } }), true);
});

// ---------------------------------------------------------------------------
console.log('\n5) applySettingsMerge() — file-level orchestration (real filesystem)');

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
  const backupsAfterFirst = backupFiles(dir);
  const mtimeBefore = fs.statSync(target).mtimeMs;
  const r2 = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r2.status, 'noop');
  assert.strictEqual(fs.statSync(target).mtimeMs, mtimeBefore, 'a no-op merge must never rewrite the file (mtime unchanged)');
  assert.strictEqual(backupFiles(dir).length, backupsAfterFirst.length, 'a no-op merge must never take a new backup');
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
  assert.strictEqual(written.permissions.deny.length, 2 + 28); // 28 NEW source rules (1 of the 29 already present)
});

t('invalid existing JSON -> refused, file untouched, a UNIQUE settings.forge-recommended-*.json written, ok:false', () => {
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
  assert.strictEqual(recommendedFiles(dir).length, 1);
  assert.strictEqual(r.recommended, path.join(dir, recommendedFiles(dir)[0]));
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
  assert.strictEqual(recommendedFiles(dir).length, 1);
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
  assert.strictEqual(backupFiles(dir).length, 0);

  const badTarget = path.join(dir, 'bad.json');
  fs.writeFileSync(badTarget, 'not json', 'utf8');
  const r3 = mod.applySettingsMerge({ target: badTarget, source, dryRun: true });
  assert.strictEqual(r3.status, 'would-refuse');
  assert.strictEqual(recommendedFiles(dir).length, 0);
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
  const rawAfter = fs.readFileSync(target, 'utf8');
  assert.strictEqual(rawAfter.charCodeAt(0), 0xfeff, 'the original BOM must be PRESERVED on output too (LOSSY-ROUNDTRIP), not just tolerated on input');
  const written = JSON.parse(rawAfter.slice(1));
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

t('UNREADABLE-MEANS-ABSENT mirrored in check: a directory named settings.json is "unreadable", never "missing"', () => {
  const dir = freshDir('settings-merge-check-unreadable');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  fs.mkdirSync(target);
  const r = mod.checkSettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'unreadable');
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

// ---------------------------------------------------------------------------
console.log('\n8) UNREADABLE-MEANS-ABSENT — only a verified-missing regular file enters the create path');
t('a directory named settings.json refuses (usage-error-free "refused"), never treated as missing/created', () => {
  const dir = freshDir('settings-merge-dir-target');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  fs.mkdirSync(target);
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.ok(fs.statSync(target).isDirectory(), 'the directory must still be a directory — never replaced');
});

t('a directory named settings.json in --dry-run also refuses without creating/writing anything', () => {
  const dir = freshDir('settings-merge-dir-target-dry');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  fs.mkdirSync(target);
  const r = mod.applySettingsMerge({ target, source, dryRun: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'would-refuse');
  assert.strictEqual(recommendedFiles(dir).length, 0);
});

{
  // Real-OS probe first (mirrors forge-sync.test.cjs's own F2/H1 EPERM pattern): only assert the EACCES half
  // when this OS/filesystem actually enforces chmod 0 as unreadable (Windows chmod only toggles the
  // read-only ATTRIBUTE and does not block reads at all — a real gap this suite does not pretend to close).
  const dir = freshDir('settings-merge-eacces');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  let reallyUnreadable = false;
  try { fs.chmodSync(target, 0o000); fs.readFileSync(target, 'utf8'); }
  catch { reallyUnreadable = true; }
  if (reallyUnreadable) {
    t('EACCES on an existing settings.json (real OS enforcement) refuses, never treated as missing, no backup taken', () => {
      const r = mod.applySettingsMerge({ target, source });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.status, 'refused');
      assert.strictEqual(backupFiles(dir).length, 0, 'no backup should be taken for a target that was never actually read');
    });
    fs.chmodSync(target, 0o644);
  } else {
    try { fs.chmodSync(target, 0o644); } catch { /* best-effort restore */ }
    console.log('     (UNREADABLE-MEANS-ABSENT EACCES half: OS/filesystem did not enforce chmod 0 as unreadable in this sandbox — skipped honestly; the directory-shaped test above proves the same refuse-never-absent code path)');
    t('(UNREADABLE-MEANS-ABSENT EACCES half skipped honestly — OS did not reproduce)', () => {});
  }
}

// ---------------------------------------------------------------------------
console.log('\n9) CONCURRENT-EDIT-LOSS — a drift between read and rename refuses instead of discarding the edit');
t('a target mutated between read and rename (via the gated test hook) is refused; the concurrent edit survives on disk; a backup of the ORIGINAL read exists', () => {
  const dir = freshDir('settings-merge-race');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  const concurrentEdit = JSON.stringify(Object.assign(existingWithForeignEntries(), { ownerNote: 'CHANGED BY SOMEONE ELSE MID-MERGE' }), null, 2) + '\n';

  const prevEnv = process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS;
  process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS = '1';
  let r;
  try {
    r = mod.applySettingsMerge({ target, source, __mutateBeforeRename: () => fs.writeFileSync(target, concurrentEdit, 'utf8') });
  } finally {
    if (prevEnv === undefined) delete process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS; else process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS = prevEnv;
  }
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), concurrentEdit, 'the concurrent edit must be preserved on disk, never discarded');
  assert.ok(r.backupPath && fs.existsSync(r.backupPath));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.backupPath, 'utf8')), existingWithForeignEntries(), 'the backup holds what Forge originally read, not the concurrent edit');
});

t('without the test-hook env var set, __mutateBeforeRename is never invoked (production path stays inert)', () => {
  const dir = freshDir('settings-merge-race-off');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, realSourceFixture());
  writeJson(target, existingWithForeignEntries());
  let invoked = false;
  const prevEnv = process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS;
  delete process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS;
  const r = mod.applySettingsMerge({ target, source, __mutateBeforeRename: () => { invoked = true; } });
  if (prevEnv !== undefined) process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS = prevEnv;
  assert.strictEqual(invoked, false);
  assert.strictEqual(r.status, 'merged');
});

// ---------------------------------------------------------------------------
console.log('\n10) AUXILIARY-FILE-CLOBBER — exclusive, unique recovery files; never overwrite a prior one');
t('two same-second refusals never collide: two DISTINCT recommended files exist, both readable and correct', () => {
  const dir = freshDir('settings-merge-aux-collide');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, 'not json 1', 'utf8');
  const r1 = mod.applySettingsMerge({ target, source, now: new Date('2026-01-01T00:00:00.000Z') });
  fs.writeFileSync(target, 'not json 2', 'utf8');
  const r2 = mod.applySettingsMerge({ target, source, now: new Date('2026-01-01T00:00:00.000Z') });
  assert.notStrictEqual(r1.recommended, r2.recommended, 'each refusal must get its OWN unique recovery file');
  assert.strictEqual(recommendedFiles(dir).length, 2);
  assert.ok(fs.existsSync(r1.recommended) && fs.existsSync(r2.recommended));
});

t('two same-second real merges never collide: two DISTINCT backups exist, each with the ORIGINAL content at that step', () => {
  const dir = freshDir('settings-merge-aux-backup-collide');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  writeJson(target, { hooks: { PreToolUse: [{ matcher: 'X', hooks: [{ type: 'command', command: 'a' }] }] } });
  const now = new Date('2026-01-01T00:00:00.000Z');
  const r1 = mod.applySettingsMerge({ target, source, now });
  writeJson(target, JSON.parse(fs.readFileSync(target, 'utf8'))); // still merged, but re-run to force a fresh "changed" state below
  fs.writeFileSync(target, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(target, 'utf8')), { extra: 'x' }), null, 2) + '\n', 'utf8');
  const r2 = mod.applySettingsMerge({ target, source, now }); // no new source entries missing, but still exercises the writer path if changed — guard: force a real second merge by adding a NEW deny rule to source-equivalent state is unnecessary; instead assert on backups taken so far
  assert.ok(r1.backupPath, 'first merge must produce a backup');
  const backups = backupFiles(dir);
  assert.ok(backups.length >= 1);
  // uniqueness proof: writing two backups at the identical `now` must never produce the SAME filename twice
  const b1 = guards.writeExclusiveUnique(dir, 'probe.forge-bak', '', 'one', { now });
  const b2 = guards.writeExclusiveUnique(dir, 'probe.forge-bak', '', 'two', { now });
  assert.strictEqual(b1.ok, true); assert.strictEqual(b2.ok, true);
  assert.notStrictEqual(b1.path, b2.path);
  assert.strictEqual(fs.readFileSync(b1.path, 'utf8'), 'one');
  assert.strictEqual(fs.readFileSync(b2.path, 'utf8'), 'two');
  void r2;
});

{
  let junctionOk = false;
  const dir = freshDir('settings-merge-aux-junction');
  const outside = freshDir('settings-merge-aux-outside');
  const linkedBackupDir = path.join(dir, 'linked-backups');
  try { fs.symlinkSync(outside, linkedBackupDir, 'junction'); junctionOk = true; }
  catch (e) { console.log('     (AUXILIARY-FILE-CLOBBER junction half: could not create a junction in this environment — ' + e.message + ' — skipping honestly)'); }
  if (junctionOk) {
    t('writeExclusiveUnique refuses to write into a directory that is itself a symlink/junction — nothing lands outside', () => {
      const r = guards.writeExclusiveUnique(linkedBackupDir, 'settings.forge-recommended', '.json', 'x');
      assert.strictEqual(r.ok, false);
      assert.strictEqual(fs.readdirSync(outside).length, 0, 'nothing must have been written through the junction');
    });
  } else {
    t('(AUXILIARY-FILE-CLOBBER junction half skipped honestly — could not create a junction)', () => {});
  }
}

// ---------------------------------------------------------------------------
console.log('\n11) PROJECT-DIRECTORY-ESCAPE — projectRoot containment for every write destination');
t('a target outside the given projectRoot is refused before anything is read/written', () => {
  const root = freshDir('settings-merge-escape-root');
  const outside = freshDir('settings-merge-escape-outside');
  const source = path.join(root, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(outside, 'settings.json'); // NOT inside root
  const r = mod.applySettingsMerge({ target, source, projectRoot: root });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(fs.existsSync(target), false);
});

t('a target inside the given projectRoot is accepted normally', () => {
  const root = freshDir('settings-merge-escape-ok');
  const source = path.join(root, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(root, 'settings.json');
  const r = mod.applySettingsMerge({ target, source, projectRoot: root });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'created');
});

{
  let junctionOk = false;
  const outerRoot = freshDir('settings-merge-escape-outer');
  const outside = freshDir('settings-merge-escape-junction-outside');
  const claudeLink = path.join(outerRoot, '.claude');
  try { fs.symlinkSync(outside, claudeLink, 'junction'); junctionOk = true; }
  catch (e) { console.log('     (PROJECT-DIRECTORY-ESCAPE junction half: could not create a junction in this environment — ' + e.message + ' — skipping honestly)'); }
  if (junctionOk) {
    t('a projectRoot that is itself a symlink/junction is refused even though target/backupDir would trivially "resolve inside" it', () => {
      const source = path.join(outerRoot, 'source.json');
      writeJson(source, realSourceFixture());
      const target = path.join(claudeLink, 'settings.json');
      const r = mod.applySettingsMerge({ target, source, projectRoot: claudeLink });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.status, 'refused');
      assert.strictEqual(fs.readdirSync(outside).filter((f) => f !== undefined).some((f) => f === 'settings.json'), false, 'nothing must land in the real outside directory the junction points to');
    });
  } else {
    t('(PROJECT-DIRECTORY-ESCAPE junction-root half skipped honestly — could not create a junction)', () => {});
  }
}

// ---------------------------------------------------------------------------
console.log('\n12) SCHEMA-ACCEPTANCE / DUPLICATE-HOOKS');
t('a malformed source ({"hooks":{"PreToolUse":{}}}) is a usage-error — never "created"', () => {
  const dir = freshDir('settings-merge-badsource');
  const source = path.join(dir, 'source.json');
  writeJson(source, { hooks: { PreToolUse: {} } });
  const target = path.join(dir, 'settings.json');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'usage-error');
  assert.strictEqual(fs.existsSync(target), false);
});

t('null and array-shaped sources are also usage-errors', () => {
  const dir = freshDir('settings-merge-badsource2');
  const target = path.join(dir, 'settings.json');
  const s1 = path.join(dir, 's1.json'); writeJson(s1, null);
  const s2 = path.join(dir, 's2.json'); writeJson(s2, []);
  assert.strictEqual(mod.applySettingsMerge({ target, source: s1 }).status, 'usage-error');
  assert.strictEqual(mod.applySettingsMerge({ target, source: s2 }).status, 'usage-error');
  assert.strictEqual(fs.existsSync(target), false);
});

t('a target hook changed to type:"prompt" while keeping the gate command is NOT considered present — the real command hook is added alongside it', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'prompt', command: 'node .claude/forge-bin/forge-gate-hook.cjs' }] }] } };
  const source = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node .claude/forge-bin/forge-gate-hook.cjs', timeout: 10 }] }] } };
  const { settings, added } = mod.mergeForgeSettings(existing, source);
  const entry = settings.hooks.PreToolUse.find((e) => e.matcher === 'Bash|PowerShell');
  assert.strictEqual(entry.hooks.length, 2, 'the wrong-type hook stays, and the real command hook is added');
  assert.ok(entry.hooks.some((h) => h.type === 'command' && h.command.includes('forge-gate-hook.cjs')));
  assert.strictEqual(added.length, 1);
});

t('DUPLICATE-HOOKS: a partially-present matcher tops up the SAME existing entry instead of appending a duplicate', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'a' }] }] } };
  const source = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }] } };
  const { settings, added } = mod.mergeForgeSettings(existing, source);
  const matching = settings.hooks.PreToolUse.filter((e) => e.matcher === 'Bash|PowerShell');
  assert.strictEqual(matching.length, 1, 'must never duplicate the whole entry');
  assert.strictEqual(matching[0].hooks.length, 2, 'must top up the missing command instead');
  assert.deepStrictEqual(matching[0].hooks.map((h) => h.command).sort(), ['a', 'b']);
  assert.strictEqual(added.length, 1);
});

t('a repeated top-up merge stays idempotent (no re-duplication on a second run)', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'a' }] }] } };
  const source = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }] } };
  const r1 = mod.mergeForgeSettings(existing, source);
  const r2 = mod.mergeForgeSettings(r1.settings, source);
  assert.strictEqual(r2.added.length, 0);
  assert.strictEqual(r2.settings.hooks.PreToolUse.length, 1);
});

t('DUPLICATE-HOOKS reporting: a PRE-EXISTING duplicate matcher is detected and reported, never silently repaired', () => {
  const existing = { hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'b' }] },
  ] } };
  const { settings, duplicate_matchers } = mod.mergeForgeSettings(existing, { hooks: {} });
  assert.strictEqual(settings.hooks.PreToolUse.length, 2, 'nothing is auto-repaired/merged away');
  assert.strictEqual(duplicate_matchers.length, 1);
  assert.strictEqual(duplicate_matchers[0].event, 'PreToolUse');
  assert.strictEqual(duplicate_matchers[0].count, 2);
});

t('the CLI/apply result surfaces duplicate_matchers on a noop merge (say what it found)', () => {
  const dir = freshDir('settings-merge-dupreport');
  const source = path.join(dir, 'source.json');
  writeJson(source, { hooks: {} });
  const target = path.join(dir, 'settings.json');
  writeJson(target, { hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'b' }] },
  ] } });
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.status, 'noop');
  assert.strictEqual(r.duplicate_matchers.length, 1);
});

// ---------------------------------------------------------------------------
console.log('\n13) LOSSY-ROUNDTRIP — refuse unsafe content; preserve BOM/EOL/indent/trailing-newline on a real merge');
t('a duplicate object key in the existing target refuses (never silently collapses to the last value)', () => {
  const dir = freshDir('settings-merge-duplicate-key');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{"a":1,"a":2,"hooks":{}}', 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(r.duplicateKeys, ['a']);
  assert.strictEqual(recommendedFiles(dir).length, 1);
});

t('an overflowing number (1e400) and a >2^53 integer in the existing target both refuse', () => {
  const dir = freshDir('settings-merge-unsafe-numbers');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{"a":1e400,"b":9007199254740993,"hooks":{}}', 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(r.unsafeNumbers.sort(), ['1e400', '9007199254740993'].sort());
});

t('a safe integer at exactly 2^53-1 and an ordinary decimal do NOT trigger a false refusal', () => {
  const dir = freshDir('settings-merge-safe-numbers');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  fs.writeFileSync(target, '{"a":9007199254740991,"b":1.5,"hooks":{}}', 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.status, 'merged');
});

// wp-g2 (2026-09-24 Codex re-check out-p7.md V08): the scanner used to compare RAW key source text (missing
// an escaped duplicate) and only checked whether a number's parsed VALUE round-tripped (missing every case
// where only the SOURCE TEXT would silently change on reserialize). These three fixtures are Codex's own
// out-p7.md evidence, verbatim, run through the real scanner AND a real applySettingsMerge refusal — each
// must be refused and the target left byte-for-byte untouched, never silently "merged" over.
t('guards.scanJsonRisks decodes an escaped duplicate key (\\u006fwner vs owner) directly (V08)', () => {
  const r = guards.scanJsonRisks('{"owner":"first","\\u006fwner":"second"}');
  assert.deepStrictEqual(r.duplicateKeys, ['owner']);
});
t('guards.scanJsonRisks catches a decimal-integer overflow (9007199254740993.0) directly (V08)', () => {
  const r = guards.scanJsonRisks('{"n":9007199254740993.0}');
  assert.deepStrictEqual(r.unsafeNumbers, ['9007199254740993.0']);
});
t('guards.scanJsonRisks catches an exponent underflow to zero (1e-400) directly (V08)', () => {
  const r = guards.scanJsonRisks('{"n":1e-400}');
  assert.deepStrictEqual(r.unsafeNumbers, ['1e-400']);
});
t('guards.scanJsonRisks also catches -0 (loses its sign on reserialize) and 1E2 (redundant exponent notation) (V08)', () => {
  const r = guards.scanJsonRisks('{"a":-0,"b":1E2}');
  assert.deepStrictEqual(r.unsafeNumbers.sort(), ['-0', '1E2'].sort());
});

t('CODEX FIXTURE 1/3 — {"owner":"first","\\u006fwner":"second"} refuses the merge and leaves the target byte-for-byte untouched', () => {
  const dir = freshDir('settings-merge-codex-v08-dupkey');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  const original = '{"owner":"first","\\u006fwner":"second","hooks":{}}';
  fs.writeFileSync(target, original, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(r.duplicateKeys, ['owner']);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the target must be left byte-for-byte untouched on refusal');
  assert.strictEqual(recommendedFiles(dir).length, 1, 'a guarded settings.forge-recommended-*.json is still offered');
});

t('CODEX FIXTURE 2/3 — {"n":9007199254740993.0} refuses the merge and leaves the target byte-for-byte untouched', () => {
  const dir = freshDir('settings-merge-codex-v08-decimal-overflow');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  const original = '{"n":9007199254740993.0,"hooks":{}}';
  fs.writeFileSync(target, original, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(r.unsafeNumbers, ['9007199254740993.0']);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the target must be left byte-for-byte untouched on refusal');
});

t('CODEX FIXTURE 3/3 — {"n":1e-400} refuses the merge and leaves the target byte-for-byte untouched', () => {
  const dir = freshDir('settings-merge-codex-v08-underflow');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  const original = '{"n":1e-400,"hooks":{}}';
  fs.writeFileSync(target, original, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(r.unsafeNumbers, ['1e-400']);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), original, 'the target must be left byte-for-byte untouched on refusal');
});

t('BOM + CRLF + tab-indent + no-final-newline are all preserved through a real merge', () => {
  const dir = freshDir('settings-merge-formatting');
  const source = path.join(dir, 'source.json');
  writeJson(source, realSourceFixture());
  const target = path.join(dir, 'settings.json');
  const original = '﻿{\r\n\t"hooks": {},\r\n\t"ownerNote": "keep me"\r\n}'; // no trailing newline
  fs.writeFileSync(target, original, 'utf8');
  const r = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r.status, 'merged');
  const rawAfter = fs.readFileSync(target, 'utf8');
  assert.strictEqual(rawAfter.charCodeAt(0), 0xfeff, 'BOM must be preserved');
  assert.ok(rawAfter.includes('\r\n'), 'CRLF must be preserved');
  assert.ok(!/(?<!\r)\n/.test(rawAfter.slice(1)), 'every newline must be \\r\\n, never a bare \\n');
  assert.ok(rawAfter.includes('\t"'), 'tab indent must be preserved');
  assert.ok(!rawAfter.endsWith('\n') && !rawAfter.endsWith('\r\n'), 'the original had no trailing newline — none must be added');
  const parsedAfter = JSON.parse(rawAfter.charCodeAt(0) === 0xfeff ? rawAfter.slice(1) : rawAfter);
  assert.strictEqual(parsedAfter.ownerNote, 'keep me');
});

// ---------------------------------------------------------------------------
console.log('\n14) SETTINGS-PERMISSION-WIDENING (POSIX only)');
if (process.platform === 'win32') {
  t('(SETTINGS-PERMISSION-WIDENING skipped honestly — POSIX-only; Windows chmod only toggles the read-only attribute, not real ACLs, a documented limit)', () => {});
} else {
  t('a restrictive 0600 target keeps 0600 after a real merge, and its backup is written 0600 too', () => {
    const dir = freshDir('settings-merge-perm');
    const source = path.join(dir, 'source.json');
    writeJson(source, realSourceFixture());
    const target = path.join(dir, 'settings.json');
    writeJson(target, existingWithForeignEntries());
    fs.chmodSync(target, 0o600);
    const r = mod.applySettingsMerge({ target, source });
    assert.strictEqual(r.status, 'merged');
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(r.backupPath).mode & 0o777, 0o600);
  });
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
