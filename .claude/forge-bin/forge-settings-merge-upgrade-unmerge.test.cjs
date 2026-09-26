#!/usr/bin/env node
'use strict';
// forge-settings-merge-upgrade-unmerge.test.cjs — WP-S7 (v2.8.0 fresh-laptop re-audit). Two NEW behaviors on
// top of the load-bearing forge-settings-merge.test.cjs suite:
//   1) HOOK-COMMAND-UPGRADE — an upgrading install (2.7.2's cwd-relative hook commands) must never end up
//      with BOTH the old and the new command under the same matcher (every Forge hook firing twice). The
//      real v2.8.0 template changed forge-snapshot-marker.cjs (x2 matchers), forge-snapshot-reinject.cjs and
//      the original PostToolUse forge-toolhook.cjs entry from a cwd-relative `node .claude/forge-bin/...` to
//      `node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/..."`, and appended a SEPARATE PostToolUse entry (matcher
//      "PowerShell") for forge-toolhook.cjs. forge-gate-hook.cjs was already in the new form since v2.7.0 and
//      is unchanged here — it must never be reported as an "upgrade".
//   2) unmerge — the uninstaller's counterpart to apply: removes every Forge hook + the template's own deny
//      rules, keeps every foreign hook/rule/key exactly as-is, and shares apply's refuse-safe/backup/format-
//      preservation guarantees.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const mod = require('./forge-settings-merge.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
function backupFiles(dir) { return fs.readdirSync(dir).filter((f) => f.includes('.forge-')); }

// the 29 permissions.deny rules, byte-identical in both the 2.7.2 and the v2.8.0 template (only the hook
// commands/entries changed between those two releases, not this list).
const DENY_RULES = [
  'Read(./.env)', 'Read(./.env.local)', 'Read(./.env.*.local)', 'Read(./.env.development)',
  'Read(./.env.production)', 'Read(./.env.staging)', 'Read(./.env.test)', 'Read(./.env.forge-setup)', 'Read(./secrets/**)',
  'Read(./**/.env)', 'Read(./**/.env.local)', 'Read(./**/.env.*.local)', 'Read(./**/.env.development)',
  'Read(./**/.env.production)', 'Read(./**/.env.staging)', 'Read(./**/.env.test)', 'Read(./**/.env.forge-setup)',
  'Read(./**/.env.prod)', 'Read(./**/.env.bak)', 'Read(./**/.env.backup)', 'Read(./**/*.pem)',
  'Read(./**/*.key)', 'Read(./**/id_rsa*)', 'Read(./**/id_ed25519*)', 'Read(./**/secrets/**)',
  'Read(~/.claude/.credentials.json)', 'Read(~/.claude/nvidia.env)', 'Read(~/.ssh/**)',
  'Read(./.claude/config/forge-owner-grant.txt)',
];

/** legacy272Fixture — a 2.7.2-shaped settings.json: the four cwd-relative hook commands (forge-snapshot-
 *  marker.cjs x2, forge-snapshot-reinject.cjs, forge-toolhook.cjs under the ONE old PostToolUse matcher), the
 *  gate hook (already `$CLAUDE_PROJECT_DIR`-form since v2.7.0 — unchanged in v2.8.0), and the 29 deny rules. */
function legacy272Fixture() {
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
    permissions: { deny: DENY_RULES.slice() },
  };
}

/** templateV280Fixture — the REAL v2.8.0 template shape: all four hook commands now `$CLAUDE_PROJECT_DIR`-
 *  quoted, PLUS a brand-new SEPARATE PostToolUse entry (matcher "PowerShell") for forge-toolhook.cjs. Same 29
 *  deny rules — this release did not change permissions.deny. */
function templateV280Fixture() {
  return {
    hooks: {
      PreCompact: [
        { matcher: 'manual', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-snapshot-marker.cjs"', timeout: 15 }] },
        { matcher: 'auto', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-snapshot-marker.cjs"', timeout: 15 }] },
      ],
      SessionStart: [
        { matcher: 'compact', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-snapshot-reinject.cjs"', timeout: 15 }] },
      ],
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-toolhook.cjs"', timeout: 10 }] },
        { matcher: 'PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-toolhook.cjs"', timeout: 10 }] },
      ],
      PreToolUse: [
        { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"', timeout: 10 }] },
      ],
    },
    permissions: { deny: DENY_RULES.slice() },
  };
}

console.log('forge-settings-merge-upgrade-unmerge tests (HOOK-COMMAND-UPGRADE + unmerge)');

// ---------------------------------------------------------------------------
console.log('\n1) HOOK-COMMAND-UPGRADE — mergeForgeSettings() pure-function behavior');

t('a 2.7.2-shaped target merged with the real v2.8.0 template ends with exactly one hook per script, all in the new $CLAUDE_PROJECT_DIR form, and the new PowerShell entry appended once', () => {
  const legacy = legacy272Fixture();
  const legacyJson = JSON.stringify(legacy);
  const template = templateV280Fixture();
  const { settings, added, adjusted, upgraded } = mod.mergeForgeSettings(legacy, template);

  assert.strictEqual(JSON.stringify(legacy), legacyJson, 'mergeForgeSettings must never mutate its `existing` argument');

  // PreCompact: still 2 entries, each with EXACTLY 1 hook, in the NEW form — never both old+new
  assert.strictEqual(settings.hooks.PreCompact.length, 2);
  for (const e of settings.hooks.PreCompact) {
    assert.strictEqual(e.hooks.length, 1, 'must never end up with both the old and the new command under the same matcher');
    assert.strictEqual(e.hooks[0].command, 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-snapshot-marker.cjs"');
  }

  // SessionStart: 1 entry, 1 hook, new form
  assert.strictEqual(settings.hooks.SessionStart.length, 1);
  assert.strictEqual(settings.hooks.SessionStart[0].hooks.length, 1);
  assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-snapshot-reinject.cjs"');

  // PostToolUse: the old matcher is upgraded IN PLACE (still 1 hook), PLUS the brand-new PowerShell entry
  // is appended ONCE (never duplicated)
  assert.strictEqual(settings.hooks.PostToolUse.length, 2);
  const writeEntry = settings.hooks.PostToolUse.find((e) => e.matcher === 'Write|Edit|MultiEdit|NotebookEdit|Bash');
  assert.strictEqual(writeEntry.hooks.length, 1, 'the upgraded matcher must never end up with 2 hooks (old+new)');
  assert.strictEqual(writeEntry.hooks[0].command, 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-toolhook.cjs"');
  const psEntry = settings.hooks.PostToolUse.find((e) => e.matcher === 'PowerShell');
  assert.ok(psEntry, 'the new PowerShell entry must be appended');
  assert.strictEqual(psEntry.hooks.length, 1);

  // PreToolUse: the gate hook was ALREADY the new form — untouched, not reported as an upgrade
  assert.strictEqual(settings.hooks.PreToolUse.length, 1);
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks.length, 1);
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"');

  // exactly 4 upgrades reported: marker(manual), marker(auto), reinject(compact), toolhook(old matcher).
  // the gate hook and the brand-new PowerShell entry must NOT appear in `upgraded`.
  assert.strictEqual(upgraded.length, 4, JSON.stringify(upgraded));
  assert.ok(upgraded.every((u) => u.from.startsWith('node .claude/forge-bin/')));
  assert.ok(upgraded.every((u) => u.to.includes('$CLAUDE_PROJECT_DIR')));
  assert.ok(!upgraded.some((u) => u.to.includes('forge-gate-hook.cjs')), 'the already-current gate hook must never be reported as an upgrade');

  // the new PowerShell entry is the only genuinely "added" thing; adjusted stays empty (timeouts already match)
  assert.strictEqual(added.length, 1, JSON.stringify(added));
  assert.ok(added[0].includes('PowerShell'));
  assert.strictEqual(adjusted.length, 0);
});

t('a second merge against the already-upgraded settings is a true no-op (idempotent upgrade)', () => {
  const legacy = legacy272Fixture();
  const template = templateV280Fixture();
  const r1 = mod.mergeForgeSettings(legacy, template);
  const r2 = mod.mergeForgeSettings(r1.settings, template);
  assert.strictEqual(r2.upgraded.length, 0);
  assert.strictEqual(r2.added.length, 0);
  assert.strictEqual(r2.adjusted.length, 0);
  assert.strictEqual(r2.deny_added.length, 0);
});

t('HOOK-COMMAND-UPGRADE never touches a non-Forge hook under the same matcher, even one that shares a matcher with an upgraded Forge hook', () => {
  const existing = {
    hooks: {
      PreCompact: [
        { matcher: 'manual', hooks: [
          { type: 'command', command: 'node .claude/forge-bin/forge-snapshot-marker.cjs', timeout: 15 },
          { type: 'command', command: 'node my-own-precompact-hook.cjs', timeout: 20 },
        ] },
      ],
    },
  };
  const source = { hooks: { PreCompact: [
    { matcher: 'manual', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-snapshot-marker.cjs"', timeout: 15 }] },
  ] } };
  const { settings, upgraded } = mod.mergeForgeSettings(existing, source);
  const entry = settings.hooks.PreCompact[0];
  assert.strictEqual(entry.hooks.length, 2, 'the foreign hook must survive alongside the upgraded Forge hook');
  const foreign = entry.hooks.find((h) => h.command === 'node my-own-precompact-hook.cjs');
  assert.ok(foreign, 'the foreign hook must never be removed or renamed');
  assert.strictEqual(foreign.timeout, 20);
  assert.strictEqual(upgraded.length, 1);
  assert.strictEqual(entry.hooks.find((h) => h.command.includes('forge-snapshot-marker.cjs')).command, 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-snapshot-marker.cjs"');
});

t('an exact-text-identical command is "already present", never reported as an upgrade', () => {
  const existing = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"', timeout: 10 }] }] } };
  const source = { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"', timeout: 10 }] }] } };
  const { added, adjusted, upgraded } = mod.mergeForgeSettings(existing, source);
  assert.strictEqual(added.length, 0);
  assert.strictEqual(adjusted.length, 0);
  assert.strictEqual(upgraded.length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n2) HOOK-COMMAND-UPGRADE — applySettingsMerge() end-to-end (real filesystem) + checkSettingsMerge()');

t('applySettingsMerge upgrades a real 2.7.2-shaped target file to the v2.8.0 template form; reports `upgraded`; a second apply is a true no-op', () => {
  const dir = freshDir('settings-merge-upgrade');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());
  writeJson(target, legacy272Fixture());

  const r1 = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  assert.strictEqual(r1.status, 'merged');
  assert.strictEqual(r1.upgraded.length, 4, JSON.stringify(r1.upgraded));
  assert.ok(r1.backupPath && fs.existsSync(r1.backupPath));

  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.strictEqual(written.hooks.PreCompact[0].hooks.length, 1);
  assert.strictEqual(written.hooks.PreCompact[0].hooks[0].command, 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-snapshot-marker.cjs"');
  assert.strictEqual(written.hooks.PostToolUse.length, 2);

  const mtimeAfterFirst = fs.statSync(target).mtimeMs;
  const backupsAfterFirst = backupFiles(dir).length;
  const r2 = mod.applySettingsMerge({ target, source });
  assert.strictEqual(r2.status, 'noop');
  assert.strictEqual(r2.upgraded.length, 0);
  assert.strictEqual(fs.statSync(target).mtimeMs, mtimeAfterFirst, 'a true no-op must never rewrite the file');
  assert.strictEqual(backupFiles(dir).length, backupsAfterFirst, 'a true no-op must never take a new backup');
});

t('checkSettingsMerge reports a pending upgrade as "not up to date" (missing-entries) via the `upgraded` array', () => {
  const dir = freshDir('settings-merge-check-upgrade');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());
  writeJson(target, legacy272Fixture());
  const r = mod.checkSettingsMerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'missing-entries');
  assert.strictEqual(r.upgraded.length, 4, JSON.stringify(r.upgraded));

  // once fully merged, check reports up-to-date with an empty `upgraded`
  mod.applySettingsMerge({ target, source });
  const r2 = mod.checkSettingsMerge({ target, source });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.status, 'up-to-date');
  assert.strictEqual(r2.upgraded.length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n3) unmergeForgeSettings() — pure-function safety property');

t('unmerging a freshly-merged v2.8.0 settings.json removes every Forge hook and every template deny rule, leaves hooks:{} and permissions.deny:[]', () => {
  const merged = mod.mergeForgeSettings({}, templateV280Fixture()).settings;
  const mergedJson = JSON.stringify(merged);
  const { settings, removed_hooks, removed_events, deny_removed } = mod.unmergeForgeSettings(merged, templateV280Fixture());
  assert.strictEqual(JSON.stringify(merged), mergedJson, 'unmergeForgeSettings must never mutate its `existing` argument');

  assert.deepStrictEqual(settings.hooks, {}, 'every event was ALL Forge hooks -> every event key is dropped');
  assert.deepStrictEqual(settings.permissions.deny, []);
  // 6 hooks total: marker x2, reinject x1, toolhook x2 (both PostToolUse matchers), gate-hook x1
  assert.strictEqual(removed_hooks.length, 6, JSON.stringify(removed_hooks));
  assert.strictEqual(removed_events.length, 4); // PreCompact, SessionStart, PostToolUse, PreToolUse
  assert.strictEqual(deny_removed.length, 29);
});

t('a foreign hook survives unmerge: its matcher entry is kept (with only the Forge hook removed from it)', () => {
  const existing = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|PowerShell', hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"', timeout: 10 },
          { type: 'command', command: 'node my-own-hook.cjs', timeout: 5 },
        ] },
      ],
    },
    permissions: { deny: ['Read(./.env)', 'Bash(rm -rf *)'] },
  };
  const source = {
    hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"', timeout: 10 }] }] },
    permissions: { deny: ['Read(./.env)'] },
  };
  const { settings, removed_hooks, deny_removed } = mod.unmergeForgeSettings(existing, source);
  assert.strictEqual(settings.hooks.PreToolUse.length, 1, 'the matcher entry survives because a foreign hook remains');
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks.length, 1);
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'node my-own-hook.cjs');
  assert.strictEqual(removed_hooks.length, 1);
  assert.deepStrictEqual(settings.permissions.deny, ['Bash(rm -rf *)'], 'the user\'s own deny rule survives; only the source rule is removed');
  assert.deepStrictEqual(deny_removed, ['Read(./.env)']);
});

t('unmergeForgeSettings never introduces a hooks/permissions key that was not already present', () => {
  const { settings } = mod.unmergeForgeSettings({ ownerNote: 'keep me' }, templateV280Fixture());
  assert.deepStrictEqual(settings, { ownerNote: 'keep me' }, 'nothing to unmerge from a target with no hooks/permissions at all -> completely untouched');
});

// ---------------------------------------------------------------------------
console.log('\n4) applySettingsUnmerge() — file-level orchestration (real filesystem)');

t('unmerge over a v2.8.0-merged file removes exactly Forge\'s hooks and the template\'s deny rules; a foreign hook + foreign deny rule survive; backup written', () => {
  const dir = freshDir('settings-merge-unmerge-e2e');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());

  // build a v2.8.0-merged target that ALSO carries a foreign hook + a foreign deny rule + an unrelated key,
  // exactly what a real merged-then-customized project would look like.
  const merged = mod.mergeForgeSettings({}, templateV280Fixture()).settings;
  merged.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'node my-own-hook.cjs', timeout: 5 });
  merged.permissions.deny.unshift('Bash(rm -rf *)');
  merged.ownerNote = 'do not touch this field';
  writeJson(target, merged);

  const r = mod.applySettingsUnmerge({ target, source });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.status, 'unmerged');
  assert.ok(r.backupPath && fs.existsSync(r.backupPath));
  const backupContent = JSON.parse(fs.readFileSync(r.backupPath, 'utf8'));
  assert.deepStrictEqual(backupContent, merged, 'backup must preserve the ORIGINAL (still-merged) content exactly');

  const written = JSON.parse(fs.readFileSync(target, 'utf8'));
  // every Forge event except PreToolUse (which still holds the surviving foreign hook) is fully dropped
  assert.ok(!('PreCompact' in written.hooks));
  assert.ok(!('SessionStart' in written.hooks));
  assert.ok(!('PostToolUse' in written.hooks));
  assert.strictEqual(written.hooks.PreToolUse.length, 1);
  assert.strictEqual(written.hooks.PreToolUse[0].hooks.length, 1);
  assert.strictEqual(written.hooks.PreToolUse[0].hooks[0].command, 'node my-own-hook.cjs');
  assert.deepStrictEqual(written.permissions.deny, ['Bash(rm -rf *)']);
  assert.strictEqual(written.ownerNote, 'do not touch this field');

  assert.strictEqual(r.removed_hooks.length, 6);
  assert.strictEqual(r.deny_removed.length, 29);
});

t('unmerge on a file with no Forge content is a true no-op: exit-equivalent noop, mtime unchanged, no new backup', () => {
  const dir = freshDir('settings-merge-unmerge-noop');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());
  writeJson(target, {
    hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node "my-own-hook.cjs"', timeout: 5 }] }] },
    permissions: { deny: ['Bash(rm -rf *)'] },
    ownerNote: 'do not touch this field',
  });
  const mtimeBefore = fs.statSync(target).mtimeMs;
  const r = mod.applySettingsUnmerge({ target, source });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'noop');
  assert.strictEqual(r.removed_hooks.length, 0);
  assert.strictEqual(r.deny_removed.length, 0);
  assert.strictEqual(fs.statSync(target).mtimeMs, mtimeBefore, 'a no-op unmerge must never rewrite the file');
  assert.strictEqual(backupFiles(dir).length, 0, 'a no-op unmerge must never take a backup');
});

t('unmerge on a MISSING target is a plain no-op, never a refusal (nothing to unmerge from a file that is not there)', () => {
  const dir = freshDir('settings-merge-unmerge-missing');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());
  const r = mod.applySettingsUnmerge({ target, source });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'noop');
  assert.strictEqual(fs.existsSync(target), false);
});

t('unmerge --dry-run writes nothing at all', () => {
  const dir = freshDir('settings-merge-unmerge-dryrun');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());
  const merged = mod.mergeForgeSettings({}, templateV280Fixture()).settings;
  writeJson(target, merged);
  const before = fs.readFileSync(target, 'utf8');
  const r = mod.applySettingsUnmerge({ target, source, dryRun: true });
  assert.strictEqual(r.status, 'would-unmerge');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before);
  assert.strictEqual(backupFiles(dir).length, 0);
});

t('unmerge refuses (never deletes) an existing settings.json that is not valid JSON, leaving it byte-for-byte untouched', () => {
  const dir = freshDir('settings-merge-unmerge-badjson');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());
  fs.writeFileSync(target, '{ this is not valid json', 'utf8');
  const before = fs.readFileSync(target, 'utf8');
  const r = mod.applySettingsUnmerge({ target, source });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before);
});

t('unmerge is refused when the projectRoot containment check fails (PROJECT-DIRECTORY-ESCAPE)', () => {
  const root = freshDir('settings-merge-unmerge-escape-root');
  const outside = freshDir('settings-merge-unmerge-escape-outside');
  const source = path.join(root, 'source.json');
  writeJson(source, templateV280Fixture());
  const target = path.join(outside, 'settings.json');
  writeJson(target, mod.mergeForgeSettings({}, templateV280Fixture()).settings);
  const r = mod.applySettingsUnmerge({ target, source, projectRoot: root });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'refused');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), fs.readFileSync(target, 'utf8')); // still readable/untouched
});

t('BOM + CRLF + tab-indent + no-final-newline are all preserved through a real unmerge', () => {
  const dir = freshDir('settings-merge-unmerge-formatting');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());
  const merged = mod.mergeForgeSettings({}, templateV280Fixture()).settings;
  merged.ownerNote = 'keep me';
  const body = JSON.stringify(merged, null, 2).replace(/\n/g, '\r\n');
  const original = '﻿' + body; // no trailing newline, tab-free but CRLF+BOM — proves preservation without depending on indent-unit detection nuance
  fs.writeFileSync(target, original, 'utf8');
  const r = mod.applySettingsUnmerge({ target, source });
  assert.strictEqual(r.status, 'unmerged', JSON.stringify(r));
  const rawAfter = fs.readFileSync(target, 'utf8');
  assert.strictEqual(rawAfter.charCodeAt(0), 0xfeff, 'BOM must be preserved');
  assert.ok(rawAfter.includes('\r\n'), 'CRLF must be preserved');
  assert.ok(!/(?<!\r)\n/.test(rawAfter.slice(1)), 'every newline must be \\r\\n, never a bare \\n');
  assert.ok(!rawAfter.endsWith('\n') && !rawAfter.endsWith('\r\n'), 'the original had no trailing newline — none must be added');
  const parsedAfter = JSON.parse(rawAfter.slice(1));
  assert.strictEqual(parsedAfter.ownerNote, 'keep me');
  assert.deepStrictEqual(parsedAfter.hooks, {});
});

// ---------------------------------------------------------------------------
console.log('\n5) unmerge CLI (real spawned subprocess, real filesystem)');
const { spawnSync } = require('child_process');
const CLI = path.join(__dirname, 'forge-settings-merge.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

t('CLI unmerge: a v2.8.0-merged target -> exit 0, status unmerged, JSON output includes removed_hooks/deny_removed', () => {
  const dir = freshDir('settings-merge-unmerge-cli');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());
  writeJson(target, mod.mergeForgeSettings({}, templateV280Fixture()).settings);
  const r = runCLI(['unmerge', '--target', target, '--source', source, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.status, 'unmerged');
  assert.strictEqual(parsed.removed_hooks.length, 6);
  assert.strictEqual(parsed.deny_removed.length, 29);
});

t('CLI unmerge is idempotent: a second real subprocess run reports noop, exit 0', () => {
  const dir = freshDir('settings-merge-unmerge-cli-idempotent');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());
  writeJson(target, mod.mergeForgeSettings({}, templateV280Fixture()).settings);
  runCLI(['unmerge', '--target', target, '--source', source]);
  const r2 = runCLI(['unmerge', '--target', target, '--source', source, '--json']);
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(JSON.parse(r2.stdout.trim()).status, 'noop');
});

t('CLI unmerge with missing required args exits 2', () => {
  const r = runCLI(['unmerge', '--target', path.join(os.tmpdir(), 'x.json')]);
  assert.strictEqual(r.status, 2);
});

t('CLI unmerge: malformed existing JSON -> exit 1, file untouched', () => {
  const dir = freshDir('settings-merge-unmerge-cli-bad');
  const source = path.join(dir, 'source.json');
  const target = path.join(dir, 'settings.json');
  writeJson(source, templateV280Fixture());
  fs.writeFileSync(target, '{ nope', 'utf8');
  const before = fs.readFileSync(target, 'utf8');
  const r = runCLI(['unmerge', '--target', target, '--source', source]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), before);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
