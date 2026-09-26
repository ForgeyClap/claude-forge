#!/usr/bin/env node
'use strict';
// forge-gate-fp-quoted-keyword.test.cjs — WP-S9 (v2.8.0, 2026-09-26), follow-up to WP-S8: three live false
// positives in the PreToolUse gate hook's kill-by-name/destructive-delete gates, reproduced against the real
// hook on a fresh laptop (the Lead's own harmless commands were blocked):
//
//   BLOCK kill-by-name        grep -nE "a|xargs|kill" file.txt
//   BLOCK destructive-delete  ls -R docs | grep "rm"
//   BLOCK destructive-delete  $j = '{"tool_input":{"command":"Remove-Item -Recurse -Force .\src"}}'
//
// ROOT CAUSE: WP-S8's patternLineFires() only checked whether a `pattern_line` match's own START position
// sits outside quoted data — correct for opaque-exec (every alternative there BEGINS with the dangerous
// token), not enough here: kill-by-name's/destructive-delete's pattern_line alternatives (and
// destructive-delete's own per-segment `pattern`) commonly START on a real, unquoted CONTEXT token (a search
// tool's own name, or an unrelated variable) while the token that actually makes the match dangerous sits
// LATER in the SAME match, inside quoted data that context token's own argument carries.
//
// FIX (forge-actiongate.cjs): each affected gate now names its own DANGER_TRIGGER — the specific verb(s) a
// match can never be dangerous without. patternLineFires() gained an optional 5th `trigger` argument, and
// the per-segment `pattern` loop gained the SAME check via triggerClearsQuotes(); a match only counts when
// the trigger has at least one occurrence outside quoted data (or the mask is unresolved, which still fails
// toward blocking). destructive-delete's OWN `pattern` trigger is further gated to apply ONLY to a bare
// assignment that is the WHOLE of the command text (onlyQuotedAssignmentAtRest()) — a live probe against the
// shipped forge-gate-hook.test.cjs found that suppressing it unconditionally broke five PINNED "must still
// block" fixtures (`bash -c "rm -rf x"`, a written-then-run script, a variable expanded as a command, `node
// -e`, and a commit message followed by a later interpreter) that all rely on the SAME quote-blind catch as
// their own last line of defence, by design (forge-gate-data.cjs's stripInertData deliberately leaves them
// un-stripped). See forge-actiongate.cjs's own doc comments (patternLineFires, triggerClearsQuotes,
// DANGER_TRIGGER, onlyQuotedAssignmentAtRest) for the full "why".
//
// THIS FILE proves:
//   (1) every one of the three reported false-positive shapes now ALLOWS, via both the module API
//       (gate.classify) and a real spawned hook process fed the exact PreToolUse JSON shape Claude Code
//       sends on stdin (>= 2 end-to-end spawns, per the work package);
//   (2) the "MUST STAY BLOCKED" corpus named in the work package — including the five shapes the narrower
//       bare-assignment guard exists to protect — still blocks, unchanged, through both classify() and the
//       real spawned hook;
//   (3) triggerClearsQuotes()/segmentTriggerClears()/onlyQuotedAssignmentAtRest() are covered directly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const gate = require('./forge-actiongate.cjs');
const hook = require('./forge-gate-hook.cjs');
const QUOTES = require('./forge-gate-quotes.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

console.log('forge-gate-fp-quoted-keyword tests (WP-S9: kill-by-name/destructive-delete quoted-keyword false positives)');

// ---------------------------------------------------------------------------
// 1) module API — the three reported false-positive shapes must NOT fire
// ---------------------------------------------------------------------------
console.log('\n1) gate.classify() — the three live repro shapes must not fire');

const REPRO_ALLOW = [
  { cmd: 'grep -nE "a|xargs|kill" file.txt', notGate: 'kill-by-name' },
  { cmd: 'ls -R docs | grep "rm"', notGate: 'destructive-delete' },
  { cmd: '$j = \'{"tool_input":{"command":"Remove-Item -Recurse -Force .\\\\src"}}\'', notGate: 'destructive-delete' },
];
for (const { cmd, notGate } of REPRO_ALLOW) {
  t('must NOT fire ' + notGate + ': ' + cmd, () => {
    const r = gate.classify({ text: cmd });
    assert.ok(!r.matched.includes(notGate), 'unexpectedly matched: ' + JSON.stringify(r.matched));
  });
}

// a couple of siblings named in the work package's "MUST BE ALLOWED" list — already handled upstream by
// forge-gate-data.cjs's own stripInertData for the REAL hook (see section 4), but classify() itself is also
// quote-aware for kill-by-name's own `pattern` now (defence in depth, not a re-implementation of that file).
console.log('\n1b) classify() — the two named "MUST BE ALLOWED" siblings for kill-by-name');
for (const cmd of ['grep -rn "Stop-Process -Name" docs', 'Select-String -Pattern "taskkill /IM" -Path *.md']) {
  t('must NOT fire kill-by-name: ' + cmd, () => {
    const r = gate.classify({ text: cmd });
    assert.ok(!r.matched.includes('kill-by-name'), 'unexpectedly matched: ' + JSON.stringify(r.matched));
  });
}

// ---------------------------------------------------------------------------
// 2) module API — the work package's "MUST STAY BLOCKED" corpus must still fire (no weakened detection)
// ---------------------------------------------------------------------------
console.log('\n2) gate.classify() — the MUST STAY BLOCKED corpus (classification only, never executed)');

const MUST_STILL_FIRE = [
  'rm -rf ./src',
  'rm -r build',
  'Remove-Item -Recurse -Force .\\src',
  'rd /s /q build',
  'rimraf dist',
  'taskkill /IM node.exe /F',
  'Stop-Process -Name node',
  'pkill node',
  'killall node',
  'kill $(pgrep node)',
  'ps aux | grep node | awk \'{print $2}\' | xargs kill',
  'find . -name "*.tmp" | xargs rm -rf',
  'sh -c "rm -rf $DIR"',
  'echo "done" && rm -rf ./src',
  'grep -l "pkill" . | xargs kill',
];
for (const cmd of MUST_STILL_FIRE) {
  t('must still fire (gate:true): ' + cmd, () => {
    const r = gate.classify({ text: cmd });
    assert.strictEqual(r.gate, true, 'classify() unexpectedly allowed: ' + cmd);
  });
}

// the exact five shapes a live probe against the shipped forge-gate-hook.test.cjs found regress WITHOUT the
// onlyQuotedAssignmentAtRest() guard — pinned here too, by gate id, so a future change cannot re-widen the
// destructive-delete `pattern` trigger back to "any bare-assignment shape at all", never mind "any quote".
console.log('\n2b) the exact shapes onlyQuotedAssignmentAtRest() protects (real, live-probed regressions)');
const BARE_ASSIGNMENT_GUARD_CASES = [
  'bash -c "rm -rf x"',
  "echo 'rm -rf ./src' > run.sh && bash run.sh",
  "X='rm -rf ./src'; $X",
  'node -e \'require("fs"); /* rm -rf ./src */\'',
  'git commit -m "rm -rf ./src" && node x.cjs',
];
for (const cmd of BARE_ASSIGNMENT_GUARD_CASES) {
  t('must still fire destructive-delete: ' + cmd, () => {
    const r = gate.classify({ text: cmd });
    assert.ok(r.matched.includes('destructive-delete'), 'matched: ' + JSON.stringify(r.matched));
  });
}

// ---------------------------------------------------------------------------
// 3) direct unit coverage of the new helpers
// ---------------------------------------------------------------------------
console.log('\n3) triggerClearsQuotes() / segmentTriggerClears() / onlyQuotedAssignmentAtRest() — direct unit coverage');

t('triggerClearsQuotes: no trigger at all is a pure no-op (always clears)', () => {
  const mask = QUOTES.scanQuotes('anything');
  assert.strictEqual(gate.triggerClearsQuotes(undefined, 'anything', 0, mask), true);
});
t('triggerClearsQuotes: the trigger occurs once, outside any quote -> clears', () => {
  const full = 'pkill node';
  const mask = QUOTES.scanQuotes(full);
  assert.strictEqual(gate.triggerClearsQuotes(/\bpkill\b/i, full, 0, mask), true);
});
t('triggerClearsQuotes: the trigger occurs once, entirely inside a quote -> does NOT clear', () => {
  const full = 'grep -nE "a|xargs|kill" file.txt';
  const mask = QUOTES.scanQuotes(full);
  assert.strictEqual(gate.triggerClearsQuotes(/\bkill\b/i, full, 0, mask), false);
});
t('triggerClearsQuotes: one quoted occurrence, one real occurrence later -> clears', () => {
  const full = 'grep -l "pkill" . | xargs kill';
  const mask = QUOTES.scanQuotes(full);
  assert.strictEqual(gate.triggerClearsQuotes(/\b(?:pkill|kill)\b/i, full, 0, mask), true);
});
t('triggerClearsQuotes: an unresolved (unterminated) mask fails toward firing, not toward silence', () => {
  const full = 'echo "unterminated rm -rf ./src';
  const mask = QUOTES.scanQuotes(full);
  assert.strictEqual(mask.unterminated, true, 'fixture assumption: this quote never closes');
  assert.strictEqual(gate.triggerClearsQuotes(/\brm\b/i, full, 0, mask), true);
});
t('triggerClearsQuotes: the trigger never occurs at all -> fails toward firing (config-mismatch fallback)', () => {
  const full = 'echo hello';
  const mask = QUOTES.scanQuotes(full);
  assert.strictEqual(gate.triggerClearsQuotes(/\bkill\b/i, full, 0, mask), true);
});
t('triggerClearsQuotes: never spins on a zero-width trigger match', () => {
  const full = 'no trigger mention here';
  const mask = QUOTES.scanQuotes(full);
  const start = Date.now();
  assert.strictEqual(gate.triggerClearsQuotes(/x?/i, full, 0, mask), true);
  assert.ok(Date.now() - start < 2000, 'must terminate quickly, not hang');
});

t('onlyQuotedAssignmentAtRest: a bare PowerShell assignment with nothing else in the text qualifies', () => {
  const full = '$j = \'{"tool_input":{"command":"Remove-Item -Recurse -Force .\\\\src"}}\'';
  const [entry] = gate.splitCommandsDetailed(full);
  assert.strictEqual(gate.onlyQuotedAssignmentAtRest(entry), true);
});
t('onlyQuotedAssignmentAtRest: a bare bash assignment with nothing else in the text qualifies', () => {
  const full = "X='rm -rf ./src'";
  const [entry] = gate.splitCommandsDetailed(full);
  assert.strictEqual(gate.onlyQuotedAssignmentAtRest(entry), true);
});
t('onlyQuotedAssignmentAtRest: the SAME assignment followed by a later segment does NOT qualify', () => {
  const full = "X='rm -rf ./src'; $X";
  const [entry] = gate.splitCommandsDetailed(full);
  assert.strictEqual(gate.onlyQuotedAssignmentAtRest(entry), false);
});
t('onlyQuotedAssignmentAtRest: a real interpreter -c invocation is never mistaken for an assignment', () => {
  const full = 'bash -c "rm -rf x"';
  const [entry] = gate.splitCommandsDetailed(full);
  assert.strictEqual(gate.onlyQuotedAssignmentAtRest(entry), false);
});
t('onlyQuotedAssignmentAtRest: a comparison ("==") is never mistaken for an assignment', () => {
  const full = "test $X == 'rm -rf ./src'";
  const [entry] = gate.splitCommandsDetailed(full);
  assert.strictEqual(gate.onlyQuotedAssignmentAtRest(entry), false);
});

t('segmentTriggerClears: no pattern trigger for this gate id -> always clears (pure no-op)', () => {
  const full = 'git reset --hard origin/main';
  const mask = QUOTES.scanQuotes(full);
  const [entry] = gate.splitCommandsDetailed(full);
  assert.strictEqual(gate.segmentTriggerClears(gate.DANGER_TRIGGER['git-destructive'], entry, mask), true);
});
t('segmentTriggerClears: kill-by-name\'s pattern trigger is NOT bare-assignment-gated — applies unconditionally', () => {
  const full = 'grep -rn "Stop-Process -Name" docs';
  const mask = QUOTES.scanQuotes(full);
  const [entry] = gate.splitCommandsDetailed(full);
  assert.strictEqual(gate.segmentTriggerClears(gate.DANGER_TRIGGER['kill-by-name'], entry, mask), false);
});
t('segmentTriggerClears: destructive-delete\'s pattern trigger IS bare-assignment-gated — a non-assignment shape is unaffected', () => {
  const full = 'bash -c "rm -rf x"';
  const mask = QUOTES.scanQuotes(full);
  const [entry] = gate.splitCommandsDetailed(full);
  assert.strictEqual(gate.segmentTriggerClears(gate.DANGER_TRIGGER['destructive-delete'], entry, mask), true,
    'gated off for a non-bare-assignment shape -> old quote-blind behaviour, i.e. still "clears" (fires)');
});
t('segmentTriggerClears: destructive-delete\'s pattern trigger DOES suppress the genuine bare-assignment repro', () => {
  const full = '$j = \'{"tool_input":{"command":"Remove-Item -Recurse -Force .\\\\src"}}\'';
  const mask = QUOTES.scanQuotes(full);
  const [entry] = gate.splitCommandsDetailed(full);
  assert.strictEqual(gate.segmentTriggerClears(gate.DANGER_TRIGGER['destructive-delete'], entry, mask), false);
});

t('patternLineFires: an optional 5th trigger argument is fully backward compatible when omitted', () => {
  const full = 'cat script | bash';
  const mask = QUOTES.scanQuotes(full);
  const patternLine = '\\|\\s*(?:sh|bash|zsh|dash|ksh|pwsh|powershell)\\b';
  assert.strictEqual(gate.patternLineFires(patternLine, 'i', full, mask), true);
});
t('patternLineFires: kill-by-name\'s own pattern_line trigger suppresses the "xargs kill" quoted-search repro', () => {
  const full = 'grep -nE "a|xargs|kill" file.txt';
  const mask = QUOTES.scanQuotes(full);
  const kbn = gate.loadGates().gates.find((g) => g.id === 'kill-by-name');
  assert.strictEqual(gate.patternLineFires(kbn.match.pattern_line, kbn.match.flags, full, mask, gate.DANGER_TRIGGER['kill-by-name'].pattern_line), false);
});
t('patternLineFires: destructive-delete\'s own pattern_line trigger suppresses the quoted "rm" search repro', () => {
  const full = 'ls -R docs | grep "rm"';
  const mask = QUOTES.scanQuotes(full);
  const dd = gate.loadGates().gates.find((g) => g.id === 'destructive-delete');
  assert.strictEqual(gate.patternLineFires(dd.match.pattern_line, dd.match.flags, full, mask, gate.DANGER_TRIGGER['destructive-delete'].pattern_line), false);
});

// ---------------------------------------------------------------------------
// 4) end-to-end: real spawned forge-gate-hook.cjs process, exact PreToolUse stdin shape Claude Code sends
// ---------------------------------------------------------------------------
console.log('\n4) end-to-end — real spawned forge-gate-hook.cjs process');

const HOOK = path.join(__dirname, 'forge-gate-hook.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-fp-quoted-keyword-'));
const HOME = path.join(TMP, 'home');
const PROJ = path.join(TMP, 'project');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });
function envFor() {
  return Object.assign({}, process.env, { FORGE_CONFIG_HOME: HOME, FORGE_PROJECT_ROOT: PROJ });
}
// mirrors forge-gate-hook.test.cjs's own spawnHook(): feed the exact stdin BYTES the real hook reads, never
// rely on a shell pipe (a probe command whose own text contains kill/rm/eval words could itself be classified
// by an outer PreToolUse hook watching THIS session, not just the one under test).
function spawnHook(input) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: envFor(), timeout: 15000 });
}
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const powershell = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command } });

t('spawned hook ALLOWS (exit 0, empty stdout/stderr): the kill-by-name quoted "xargs|kill" search repro', () => {
  const r = spawnHook(bash('grep -nE "a|xargs|kill" file.txt'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
});
t('spawned hook ALLOWS (exit 0): the destructive-delete quoted "rm" search repro (piped grep)', () => {
  const r = spawnHook(bash('ls -R docs | grep "rm"'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.strictEqual(r.stdout, '');
});
t('spawned hook ALLOWS (exit 0): the PowerShell bare-assignment JSON-blob repro', () => {
  const r = spawnHook(powershell('$j = \'{"tool_input":{"command":"Remove-Item -Recurse -Force .\\src"}}\''));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.strictEqual(r.stdout, '');
});
t('spawned hook still BLOCKS (exit 2, names kill-by-name): a search piped into a real xargs kill', () => {
  const r = spawnHook(bash('grep -l "pkill" . | xargs kill'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.startsWith('FORGE GATE (kill-by-name'), r.stderr.split('\n')[0]);
});
t('spawned hook still BLOCKS (exit 2, names destructive-delete): a real recursive delete', () => {
  const r = spawnHook(bash('rm -rf ./src'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.startsWith('FORGE GATE (destructive-delete'), r.stderr.split('\n')[0]);
});
t('spawned hook still BLOCKS (exit 2): the exact bare-assignment-guard shapes remain blocked end-to-end', () => {
  for (const cmd of ['bash -c "rm -rf x"', "X='rm -rf ./src'; $X"]) {
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 2, cmd + ' -> exit ' + r.status + ', stderr: ' + r.stderr);
  }
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }

console.log('');
// ---------------------------------------------------------------------------
// v2.8.0 independent gate review (HIGH): a kill verb inside a STATIC interpreter argument EXECUTES, and
// opaque-exec deliberately ignores static -c/-Command args — so kill-by-name must still fire on these. Pure
// search tools with a quoted kill verb stay silent (the WP-S9 goal is kept).
// ---------------------------------------------------------------------------
console.log('\n9) review HIGH — kill-by-name inside a static interpreter argument must still fire');
const INTERP_BLOCK = [
  'powershell -Command "Stop-Process -Name node"',
  'pwsh -Command "Stop-Process -Name node"',
  'cmd /c "taskkill /IM node.exe /F"',
  'sh -c "pkill node"',
  'bash -c "killall node"',
  'timeout 5 bash -c "pkill node"',
  "xargs sh -c 'pkill node'",
  'sudo sh -c "pkill node"',
];
for (const cmd of INTERP_BLOCK) {
  t('must fire kill-by-name: ' + cmd, () => {
    const r = gate.classify({ text: cmd });
    assert.ok(r.matched.includes('kill-by-name'), 'NOT matched (under-block): ' + JSON.stringify(r.matched));
  });
  t('decide() blocks: ' + cmd, () => {
    const v = hook.decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } }, { watchdogTimeoutMs: 6000 });
    assert.strictEqual(v.block, true, JSON.stringify(v));
  });
}
const SEARCH_ALLOW = [
  'grep -rn "Stop-Process -Name" docs',
  'rg "pkill" src',
  'findstr /S "taskkill /IM" *.md',
  'Select-String -Pattern "Stop-Process -Name" -Path *.ps1',
  'git grep "killall" -- docs',
  'git log --grep "kill" --oneline',
];
for (const cmd of SEARCH_ALLOW) {
  t('search tool stays silent for kill-by-name: ' + cmd, () => {
    const r = gate.classify({ text: cmd });
    assert.ok(!r.matched.includes('kill-by-name'), 'unexpectedly matched: ' + JSON.stringify(r.matched));
  });
}
t('leadsWithInertSearchTool: wrappers, awk, sed, xargs and interpreters are never inert', () => {
  for (const s of ['sudo grep x', 'env grep x', 'awk "/kill/" f', 'sed -e "e pkill x"', 'xargs grep x', 'sh -c "grep x"', 'timeout 5 grep x']) {
    assert.strictEqual(gate.leadsWithInertSearchTool(s), false, s);
  }
  for (const s of ['grep -n x f', 'C:\\Tools\\rg.exe x', '/usr/bin/grep x', 'Select-String -Pattern x', 'sls x', 'git grep x', 'git log --grep x']) {
    assert.strictEqual(gate.leadsWithInertSearchTool(s), true, s);
  }
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
