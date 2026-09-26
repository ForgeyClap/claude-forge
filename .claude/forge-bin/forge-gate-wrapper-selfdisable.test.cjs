#!/usr/bin/env node
'use strict';
// forge-gate-wrapper-selfdisable.test.cjs — WP-S4 (v2.8.0 laptop-audit Part V-F). Real tests, through a real
// spawned forge-gate-hook.cjs process (the exact path Claude Code uses — see forge-gate-hook.test.cjs, whose
// hermetic spawnHook()/envFor() pattern this file mirrors), for the finding the fresh-laptop re-audit executed
// end to end: `forge.cmd|forge.ps1|forge.sh config set gate-hook off|uit` (and `unset gate-hook`) passed the
// gate hook 4/4 with nothing printed, because forge-gate-selfdisable.cjs:53 only ever recognised the SCRIPT
// itself (forge-config(-cli).cjs), never the dispatcher wrapper that forwards its own `config` subcommand
// straight to that same script (see forge.cmd/.ps1/.sh's own `config` branch). HERMETIC: every spawned hook
// gets FORGE_CONFIG_HOME and FORGE_PROJECT_ROOT pointed at fresh temp dirs, so neither the owner's real
// ~/.claude/FORGE_CONFIG.json nor this project's own .claude/FORGE_CONFIG.json can decide an outcome.
//
// HOOK, NOT WRAPPER: forge.cmd/.ps1/.sh never actually run here — this hook only ever CLASSIFIES the raw
// command TEXT a shell would run, it never executes it. Spawning a real .ps1/.cmd/.sh in a test would prove
// nothing about the CLASSIFIER (and would need bash/PowerShell present, which a fresh-laptop CI runner may
// not have — see the mission blueprint's "perspective rule"); the wrapper's own SOURCE (read directly below)
// is what proves the text this test feeds the hook is exactly what a real shell would send it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const BIN = __dirname;
const HOOK = path.join(BIN, 'forge-gate-hook.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-wrapper-selfdisable-'));
const HOME = path.join(TMP, 'home');                       // empty global config dir
const PROJ = path.join(TMP, 'project');                    // project with no FORGE_CONFIG.json -> defaults
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });

function envFor(projectRoot) {
  return Object.assign({}, process.env, { FORGE_CONFIG_HOME: HOME, FORGE_PROJECT_ROOT: projectRoot || PROJ });
}
function spawnHook(input) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: envFor(), timeout: 15000 });
}
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const powershellTool = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command } });

function assertBlocked(r, cmd) {
  assert.strictEqual(r.status, 2, cmd + ' -> exit ' + r.status + ' stderr ' + r.stderr);
  assert.ok(r.stderr.startsWith('FORGE GATE (gate-hook-self-disable'), cmd + ': ' + r.stderr.split('\n')[0]);
}
function assertAllowed(r, cmd) {
  assert.strictEqual(r.status, 0, cmd + ' -> exit ' + r.status + ' stderr ' + r.stderr);
  assert.strictEqual(r.stderr, '', cmd + ': unexpected stderr ' + r.stderr);
}

console.log('forge-gate-wrapper-selfdisable tests (forge.cmd/.ps1/.sh config set/unset gate-hook must block exactly like the direct forge-config.cjs call)');

// ---------------------------------------------------------------------------
// 1) the four wrapper spellings the audit named, through the real hook
// ---------------------------------------------------------------------------
console.log('\n1) audit Part V-F — forge.cmd|forge.ps1|forge.sh config set/unset gate-hook off|uit blocks (Bash tool)');

const BLOCKED_BASENAMES = [
  'forge.cmd config set gate-hook off',
  'forge.ps1 config set gate-hook off',
  'forge.sh config set gate-hook off',
  'forge config set gate-hook off',                 // bare basename, no extension (Windows PATHEXT resolves it)
  'forge.cmd config set gate-hook uit',
  'forge.ps1 config set gate-hook false',
  'forge.sh config set gate-hook off --global',
  'forge.cmd config unset gate-hook',
  'forge.ps1 config unset gate-hook',
];
for (const cmd of BLOCKED_BASENAMES) {
  t('"' + cmd + '" -> blocked (gate-hook-self-disable)', () => assertBlocked(spawnHook(bash(cmd)), cmd));
}

t('PowerShell tool: "forge.ps1 config set gate-hook off" blocks too (not Bash-only)', () => {
  assertBlocked(spawnHook(powershellTool('forge.ps1 config set gate-hook off')), 'forge.ps1 config set gate-hook off');
});

// ---------------------------------------------------------------------------
// 2) every path spelling the mission named, plus the launcher forms
// ---------------------------------------------------------------------------
console.log('\n2) every path/launcher spelling — relative dot-path, PowerShell -File, bash <script>, bare path');

const PATH_FORMS = [
  '.\\.claude\\forge-bin\\forge.ps1 config set gate-hook off',
  'powershell -File .claude\\forge-bin\\forge.ps1 config set gate-hook off',
  'powershell.exe -File .claude\\forge-bin\\forge.ps1 config set gate-hook off',
  'pwsh -File .claude/forge-bin/forge.ps1 config set gate-hook off',
  'bash .claude/forge-bin/forge.sh config set gate-hook off',
  'sh .claude/forge-bin/forge.sh config set gate-hook off',
  '.claude\\forge-bin\\forge.cmd config set gate-hook off',
  '.claude/forge-bin/forge.sh config set gate-hook off',
  '.claude\\forge-bin\\forge config set gate-hook off',      // bare, no extension, with a path prefix
  'node .claude\\forge-bin\\forge.ps1 config set gate-hook off', // must NOT be confused with the node+forge-config.cjs path — still blocks (wrapper branch)
];
for (const cmd of PATH_FORMS) {
  t('"' + cmd + '" -> blocked', () => assertBlocked(spawnHook(bash(cmd)), cmd));
}

// ---------------------------------------------------------------------------
// 3) the once-exemption still works through the wrapper, identically to the direct call
// ---------------------------------------------------------------------------
console.log('\n3) once-exemption survives through the wrapper (same exact-shape rule as forge-config.cjs)');

t('"forge.ps1 config set gate-hook off --once <quote>" passes — alone, exactly this form', () => {
  for (const cmd of [
    'forge.ps1 config set gate-hook off --once "ja, doe het"',
    "forge.sh config set gate-hook off --once 'yes, do it'",
    'forge.cmd config set gate-hook off --once "ja, doe het"',
  ]) {
    assertAllowed(spawnHook(bash(cmd)), cmd);
  }
});

t('the once-shape must be EXACT through the wrapper too — an extra flag or trailing argument is NOT exempt', () => {
  for (const cmd of [
    'forge.ps1 config --json set gate-hook off --once "ja, doe het"',
    'forge.ps1 config set gate-hook off --once "ja, doe het" extra',
  ]) {
    assertBlocked(spawnHook(bash(cmd)), cmd);
  }
});

t('once-exemption is per-segment, same as the direct call: a legitimate once-shape followed by an UNRELATED destructive command still blocks — on the destructive-delete gate, exactly like the direct forge-config.cjs form', () => {
  // Mirrors forge-gate-hook.test.cjs's own M3 case for the direct CFG form (CFG + \' set gate-hook off --once
  // "ja, doe het" && rm -rf ./src\'), which accepts EITHER gate id for this exact reason: `&&` splits the
  // self-disable scan into independent segments, so the once-shape segment is legitimately exempt on its own
  // — the block comes from the unrelated `rm -rf ./src` segment\'s own destructive-delete gate, not self-disable.
  const cmd = 'forge.ps1 config set gate-hook off --once "ja, doe het" && rm -rf ./src';
  const r = spawnHook(bash(cmd));
  assert.strictEqual(r.status, 2, cmd + ' -> exit ' + r.status + ' stderr ' + r.stderr);
  assert.ok(/FORGE GATE \((gate-hook-self-disable|destructive-delete)/.test(r.stderr), cmd + ': ' + r.stderr.split('\n')[0]);
});

// ---------------------------------------------------------------------------
// 4) benign counterfactuals — every wrapper subcommand that must stay silently allowed
// ---------------------------------------------------------------------------
console.log('\n4) benign counterfactuals stay allowed — read-only config subcommands and every other wrapper command');

const ALLOWED = [
  'forge.ps1 config list',
  'forge.ps1 config get gate-hook',
  'forge.ps1 config explain gate-hook',
  'forge.ps1 config diff',
  'forge.ps1 config set gate-hook on',                 // turning it ON is never a self-disable
  'forge.ps1 config set some-other-key off',            // a different key entirely
  'forge.cmd config list',
  'forge.sh config get gate-hook',
  'forge.ps1 status',
  'forge.ps1 runs',
  'forge.ps1 dashboard',
  'forge.cmd runs',
  'forge.cmd status',
  'forge.sh health',
  'forge.ps1 config',                                    // wrapper + "config" alone, no verb after it
  'forge-status.ps1',                                    // a DIFFERENT wrapper — never has a config subcommand at all
  'forge-dashboard.cmd',
  'git commit -m "docs: forge.ps1 config set gate-hook off is blocked"', // the shape appears only in inert commit text
];
for (const cmd of ALLOWED) {
  t('"' + cmd + '" -> allowed, silent', () => assertAllowed(spawnHook(bash(cmd)), cmd));
}

// ---------------------------------------------------------------------------
// 5) direct module-level coverage (fast, no spawn) — pins the exact new surface
// ---------------------------------------------------------------------------
console.log('\n5) direct module coverage — forge-gate-selfdisable.cjs exports and forge-gate-inspect.cjs fallback');

t('forge-gate-selfdisable.cjs exports the new wrapper regexes/constant (drift canary)', () => {
  const SD = require('./forge-gate-selfdisable.cjs');
  assert.strictEqual(typeof SD.WRAPPER_BASENAME_RE, 'object');
  assert.strictEqual(typeof SD.WRAPPER_LAUNCHER_RE, 'object');
  assert.strictEqual(SD.WRAPPER_CONFIG_SUBCOMMAND, 'config');
  assert.ok(SD.WRAPPER_BASENAME_RE.test('forge.cmd'));
  assert.ok(SD.WRAPPER_BASENAME_RE.test('forge.ps1'));
  assert.ok(SD.WRAPPER_BASENAME_RE.test('forge.sh'));
  assert.ok(SD.WRAPPER_BASENAME_RE.test('forge'));
  assert.ok(!SD.WRAPPER_BASENAME_RE.test('forge-status.cmd'), 'a DIFFERENT wrapper must never match the bare forge(.ext) basename');
  assert.ok(!SD.WRAPPER_BASENAME_RE.test('forge-config.cjs'), 'must stay disjoint from the real script basename');
});

t('parseConfigCall(): a wrapper call parses to the identical shape as the direct forge-config.cjs call', () => {
  const SD = require('./forge-gate-selfdisable.cjs');
  const direct = SD.parseConfigCall('node .claude/forge-bin/forge-config.cjs set gate-hook off');
  const wrapped = SD.parseConfigCall('forge.ps1 config set gate-hook off');
  assert.ok(direct && wrapped, 'both must parse');
  assert.deepStrictEqual(wrapped, direct);
});

t('parseConfigCall(): "forge.ps1 status" (no config subcommand) is not a config call at all', () => {
  const SD = require('./forge-gate-selfdisable.cjs');
  assert.strictEqual(SD.parseConfigCall('forge.ps1 status'), null);
  assert.strictEqual(SD.parseConfigCall('forge.ps1 config'), null); // wrapper + "config" with nothing after it
});

t('forge-gate-inspect.cjs fallback self-disable test also recognises the wrapper shape (defense in depth when the real module cannot load)', () => {
  const INSPECT = require('./forge-gate-inspect.cjs');
  assert.strictEqual(INSPECT.fallbackSelfDisableTest('forge.ps1 config set gate-hook off'), true);
  assert.strictEqual(INSPECT.fallbackSelfDisableTest('forge.cmd config unset gate-hook'), true);
  assert.strictEqual(INSPECT.fallbackSelfDisableTest('forge.ps1 config list'), false);
  assert.strictEqual(INSPECT.fallbackSelfDisableTest('forge.ps1 status'), false);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
