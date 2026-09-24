#!/usr/bin/env node
'use strict';
// forge-gate-hook.test.cjs — real tests for the PreToolUse gate hook (v2.7.0, WP16, run
// forge-2026-09-24-config-v250). HERMETIC: every spawned hook gets FORGE_CONFIG_HOME and FORGE_PROJECT_ROOT
// pointed at fresh temp dirs, so neither the owner's real ~/.claude/FORGE_CONFIG.json nor this project's own
// .claude/FORGE_CONFIG.json can decide an outcome. Exit codes are proven through a REAL spawned process fed a
// real stdin payload — the exact path Claude Code uses — not only through the module API.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const hook = require('./forge-gate-hook.cjs');
const gate = require('./forge-actiongate.cjs');
const data = require('./forge-gate-data.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const HOOK = path.join(__dirname, 'forge-gate-hook.cjs');
const CONFIG_MODULE = path.join(__dirname, 'forge-config.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-hook-'));
const HOME = path.join(TMP, 'home');                       // empty global config dir
const PROJ = path.join(TMP, 'project');                    // project with no FORGE_CONFIG.json -> defaults
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });

function envFor(projectRoot) {
  return Object.assign({}, process.env, { FORGE_CONFIG_HOME: HOME, FORGE_PROJECT_ROOT: projectRoot || PROJ });
}
function spawnHook(input, opts) {
  opts = opts || {};
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [opts.hookPath || HOOK], { input: stdin, encoding: 'utf8', env: envFor(opts.projectRoot), timeout: 15000 });
}
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
function projectWithConfig(name, body) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), typeof body === 'string' ? body : JSON.stringify(body));
  return root;
}

console.log('forge-gate-hook tests (PreToolUse: the three command hard gates become a real stop)');

// ---------------------------------------------------------------------------
// 1) the three command gates BLOCK (exit 2) through a real spawned hook
// ---------------------------------------------------------------------------
console.log('\n1) blocking — exit 2 + one plain-language NL/EN reason on stderr, nothing on stdout');

const BLOCKS = [
  { cmd: 'rm -rf ./build', id: 'destructive-delete' },
  { cmd: 'taskkill /IM node.exe /F', id: 'kill-by-name' },
  { cmd: 'git reset --hard', id: 'git-destructive' },
  { cmd: 'git checkout .', id: 'git-destructive' },
  { cmd: 'git checkout -- src/app.js', id: 'git-destructive' },
  { cmd: 'git restore src/app.js', id: 'git-destructive' },
  { cmd: 'npm run build && rm -rf ./src', id: 'destructive-delete' },
  { cmd: 'git switch -f main', id: 'git-destructive' },
];
for (const c of BLOCKS) {
  t('"' + c.cmd + '" -> exit 2, reason names ' + c.id, () => {
    const r = spawnHook(bash(c.cmd));
    assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
    assert.ok(r.stderr.startsWith('FORGE GATE (' + c.id), 'stderr must open with the gate id: ' + r.stderr.slice(0, 80));
    assert.ok(r.stderr.includes('Forge vraagt eerst') && r.stderr.includes('Forge asks first'), 'reason must be NL and EN');
    assert.ok(r.stderr.includes('set gate-hook off --once'), 'reason must name the owner-approved one-off (the beginner yes-path)');
    assert.ok(r.stderr.includes('Forge biedt eerst de veilige variant aan') && r.stderr.includes('Forge offers the safe variant first'), 'NL+EN yes-path wording');
    assert.ok(!/! gevolgd door|! followed by|run the command themselves|zelf draaien/.test(r.stderr), 'the message must never ask the user to run anything');
    assert.strictEqual(r.stdout, '', 'a PreToolUse block must not write stdout');
  });
}

t('PowerShell tool: "Stop-Process -Name node" -> exit 2 (kill-by-name is PowerShell-native)', () => {
  const r = spawnHook({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'Stop-Process -Name node' } });
  assert.strictEqual(r.status, 2, 'exit ' + r.status);
  assert.ok(r.stderr.startsWith('FORGE GATE (kill-by-name'));
});

t('two command gates in one line are both named in ONE block', () => {
  const r = spawnHook(bash('rm -rf ./src && git reset --hard'));
  assert.strictEqual(r.status, 2);
  assert.ok(r.stderr.startsWith('FORGE GATE (destructive-delete, git-destructive):'), r.stderr.split('\n')[0]);
  assert.strictEqual((r.stderr.match(/FORGE GATE/g) || []).length, 1, 'exactly one block header');
});

t('the command text is never echoed back (it can carry a secret)', () => {
  const r = spawnHook(bash('rm -rf ./CANARY_7f3a9c'));
  assert.strictEqual(r.status, 2);
  assert.ok(!r.stderr.includes('CANARY_7f3a9c'), 'stderr echoed the command');
});

// ---------------------------------------------------------------------------
// 2) everything else passes silently (exit 0, no output)
// ---------------------------------------------------------------------------
console.log('\n2) allowed — exit 0, silent');

for (const cmd of ['git status', 'npm test', 'node x.cjs', 'git restore --staged a', 'git checkout main', 'git add .',
  'rm -rf node_modules', 'rm ./notes.txt', 'taskkill /PID 22420 /F']) {
  t('"' + cmd + '" -> exit 0, silent', () => {
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
    assert.strictEqual(r.stderr, '');
    assert.strictEqual(r.stdout, '');
  });
}

t('TEXT gates are NOT enforced by the hook (classifier fires, hook still exits 0)', () => {
  for (const cmd of ['git push origin main', 'npx wrangler deploy']) {
    assert.ok(gate.classify(cmd).gate, 'precondition: the classifier must fire a text gate on: ' + cmd);
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 0, cmd + ' was blocked — text gates stay classifier + prose gates');
    assert.strictEqual(r.stderr, '');
  }
});

t('a non-shell tool is ignored, even with a destructive-looking command field', () => {
  for (const tool of ['Write', 'Read', 'Edit']) {
    const r = spawnHook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: 'rm -rf ./src', file_path: 'a.txt' } });
    assert.strictEqual(r.status, 0, tool + ' exit ' + r.status);
    assert.strictEqual(r.stderr, '');
  }
});

t('another hook event (PostToolUse) is ignored — blocking there would be meaningless', () => {
  const r = spawnHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./src' } });
  assert.strictEqual(r.status, 0);
});

t('malformed / empty / hostile stdin -> exit 0, nothing on stdout', () => {
  const inputs = ['{not json', '', 'null', '[]', '"rm -rf ./src"', '\u0000\u0001\u0002',
    JSON.stringify({ tool_name: 'Bash' }), JSON.stringify({ tool_name: 'Bash', tool_input: { command: 42 } }),
    JSON.stringify({ tool_name: 'Bash', tool_input: 'rm -rf ./src' })];
  for (const raw of inputs) {
    const r = spawnHook(raw);
    assert.strictEqual(r.status, 0, JSON.stringify(raw) + ' exit ' + r.status + ' stderr ' + r.stderr);
    assert.strictEqual(r.stdout, '');
  }
});

t('an oversized payload (> MAX_STDIN_BYTES) is not inspected: exit 1 (non-blocking but VISIBLE, security M2) + one line', () => {
  const big = JSON.stringify(bash('echo ' + 'x'.repeat(hook.MAX_STDIN_BYTES) + ' && rm -rf ./src'));
  const r = spawnHook(big);
  assert.strictEqual(r.status, 1);
  assert.ok(/NOT checked/.test(r.stderr) && r.stderr.trim().split('\n').length === 1, r.stderr.slice(0, 120));
});

t('M1 forms block through the real hook too (kill $(pgrep …), a non-PID taskkill /FI, gps | Stop-Process)', () => {
  for (const cmd of ['kill $(pgrep node)', 'taskkill /FI "WINDOWTITLE eq x"', 'gps node | Stop-Process', 'rm -r ./src']) {
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 2, cmd + ' -> exit ' + r.status);
  }
});

// Self-disable (security wp9b M3) and the ONE owner-approved one-off (review wp9a M4).
const CFG = 'node .claude/forge-bin/forge-config.cjs';
for (const [tool, cmd] of [['Bash', CFG + ' set gate-hook off'], ['Bash', CFG + ' set gate-hook uit'], ['Bash', CFG + ' set gate-hook false --global'],
  ['Bash', CFG + ' unset gate-hook'], ['PowerShell', CFG + ' set gate-hook off'],
  ['Bash', CFG + ' set gate-hook off --once "ja, doe het" && rm -rf ./src'], ['Bash', CFG + ' set gate-hook off --once "ja"; ' + CFG + ' set gate-hook off']]) {
  t('M3 self-disable blocked (' + tool + '): "' + cmd + '"', () => {
    const r = spawnHook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: cmd } });
    assert.strictEqual(r.status, 2, 'exit ' + r.status);
    assert.ok(/FORGE GATE \((gate-hook-self-disable|destructive-delete)/.test(r.stderr), r.stderr.split('\n')[0]);
  });
}
t('M4: the owner-approved one-off shape passes the hook — alone, exactly this form', () => {
  for (const cmd of [CFG + ' set gate-hook off --once "ja, doe het"', CFG + " set gate-hook off --once 'yes, do it'"]) {
    assert.strictEqual(spawnHook(bash(cmd)).status, 0, cmd);
  }
  for (const cmd of [CFG + ' set gate-hook on', CFG + ' get gate-hook', CFG + ' list',
    CFG + ' reset', CFG + ' reset --yes', CFG + ' reset --yes --global', // reset restores the default (ON)
    'git commit -m "docs: forge config set gate-hook off is blocked"']) {
    assert.strictEqual(spawnHook(bash(cmd)).status, 0, cmd);
  }
});

// ---------------------------------------------------------------------------
// 3) the gate-hook setting (forge-config.cjs soft-require; FORGE_PROJECT_ROOT seam)
// ---------------------------------------------------------------------------
console.log('\n3) gate-hook setting — off means silent, a missing/damaged config means the default (ON)');

if (fs.existsSync(CONFIG_MODULE)) {
  t('gate-hook = false: "rm -rf ./build" is NOT blocked but VISIBLE — exit 1 + "FORGE GATE is OFF (set_at …, set_by …)"', () => {
    const root = projectWithConfig('proj-off', { version: 1, settings: { 'gate-hook': { value: false, set_at: '2026-09-24T01:00:00.000Z', set_by: 'owner /forge config set' } } });
    const r = spawnHook(bash('rm -rf ./build'), { projectRoot: root });
    assert.strictEqual(r.status, 1, 'exit ' + r.status + ' stderr ' + r.stderr);
    assert.ok(r.stderr.startsWith('FORGE GATE is OFF (set_at 2026-09-24T01:00:00.000Z, set_by owner /forge config set) — this would have been blocked (destructive-delete)'), r.stderr);
    const quiet = spawnHook(bash('git status'), { projectRoot: root });
    assert.strictEqual(quiet.status, 0, 'a call that would not have been blocked stays silent');
    assert.strictEqual(quiet.stderr, '');
  });
  t('COUNTERFACTUAL: the same fixture with gate-hook = true blocks — so the seam is really read', () => {
    const root = projectWithConfig('proj-on', { version: 1, settings: { 'gate-hook': { value: true } } });
    assert.strictEqual(spawnHook(bash('rm -rf ./build'), { projectRoot: root }).status, 2);
  });
  t('a DAMAGED FORGE_CONFIG.json does not switch the stop off (schema default ON -> exit 2)', () => {
    const root = projectWithConfig('proj-broken', '{ this is not json');
    assert.strictEqual(spawnHook(bash('rm -rf ./build'), { projectRoot: root }).status, 2);
    const root2 = projectWithConfig('proj-badvalue', { version: 1, settings: { 'gate-hook': { value: 'maybe' } } });
    assert.strictEqual(spawnHook(bash('rm -rf ./build'), { projectRoot: root2 }).status, 2);
  });
} else {
  console.log('  SKIP gate-hook=off fixture cases — forge-config.cjs is not present next to the hook, so there is no setting to switch (the hook then applies the schema default ON, proven in the next test)');
}

t('forge-config.cjs ABSENT -> the hook still blocks (copied hook + classifier, no config module)', () => {
  const root = path.join(TMP, 'no-config-module');
  const bin = path.join(root, '.claude', 'forge-bin');
  const cfgDir = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.copyFileSync(HOOK, path.join(bin, 'forge-gate-hook.cjs'));
  fs.copyFileSync(path.join(__dirname, 'forge-actiongate.cjs'), path.join(bin, 'forge-actiongate.cjs'));
  fs.copyFileSync(gate.CONFIG_PATH, path.join(cfgDir, 'hard-gates.json'));
  assert.ok(!fs.existsSync(path.join(bin, 'forge-config.cjs')), 'fixture must lack forge-config.cjs');
  const r = spawnHook(bash('git checkout .'), { hookPath: path.join(bin, 'forge-gate-hook.cjs'), projectRoot: root });
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ' stderr ' + r.stderr);
  assert.ok(r.stderr.startsWith('FORGE GATE (git-destructive'));
});

t('M2: hard-gates.json MISSING (classifier cannot load) -> destructive verbs blocked by the fallback, the rest exit 1 visibly', () => {
  const root = path.join(TMP, 'no-hard-gates');
  const bin = path.join(root, '.claude', 'forge-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ['forge-gate-hook.cjs', 'forge-actiongate.cjs', 'forge-gate-data.cjs']) fs.copyFileSync(path.join(__dirname, f), path.join(bin, f));
  const hookAt = path.join(bin, 'forge-gate-hook.cjs');
  const r = spawnHook(bash('rm -rf ./x'), { hookPath: hookAt, projectRoot: root });
  assert.strictEqual(r.status, 2, 'fail-CLOSED fallback: exit ' + r.status + ' ' + r.stderr);
  assert.ok(r.stderr.startsWith('FORGE GATE (classifier-unavailable'), r.stderr.split('\n')[0]);
  const q = spawnHook(bash('git status'), { hookPath: hookAt, projectRoot: root });
  assert.strictEqual(q.status, 1, 'unchecked call must be VISIBLE (exit 1): ' + q.status);
  assert.ok(/classifier unavailable/.test(q.stderr), q.stderr);
});

t('M4 off-notice for an owner-approved one-off shows the expiry and the quote (injected config, wp21 contract)', () => {
  const cfg = { get: () => ({ value: false, source: 'project', expires_at: '2026-09-24T12:10:00.000Z', once_quote: 'ja, doe het' }) };
  const r = hook.run(JSON.stringify(bash('git reset --hard')), { config: cfg });
  assert.strictEqual(r.exitCode, 1);
  assert.ok(r.stderr.startsWith('FORGE GATE is OFF until 2026-09-24T12:10:00.000Z — one-off approval: "ja, doe het" — this would have been blocked (git-destructive)'), r.stderr);
});

t('the hook never creates files in the config dirs it reads', () => {
  const list = (d) => fs.readdirSync(d);
  assert.deepStrictEqual(list(HOME), [], 'the global config dir must stay empty');
  assert.deepStrictEqual(list(path.join(PROJ, '.claude')), [], 'the project .claude dir must stay empty');
});

// ---------------------------------------------------------------------------
// 4) module API — the decisions the CLI is built on, including fail-open
// ---------------------------------------------------------------------------
console.log('\n4) module API — gateHookEnabled / decide / run / commandGateIds');

t('gateHookEnabled: module absent -> ON; value false -> OFF; get() throws -> ON (never silently off)', () => {
  assert.strictEqual(hook.gateHookEnabled({ config: null }).on, true);
  assert.strictEqual(hook.gateHookEnabled({ config: { get: () => ({ value: false, source: 'project' }) } }).on, false);
  assert.strictEqual(hook.gateHookEnabled({ config: { get: () => ({ value: true, source: 'default' }) } }).on, true);
  const broken = hook.gateHookEnabled({ config: { get: () => { const e = new Error('bad'); e.code = 'malformed'; throw e; } } });
  assert.strictEqual(broken.on, true);
  assert.ok(/malformed/.test(broken.source));
});

t('commandGateIds() is read from hard-gates.json, not hard-coded: exactly the command-kind gates', () => {
  const fromConfig = gate.listGates().filter((g) => g.kind === 'command').map((g) => g.id).sort();
  assert.deepStrictEqual([...hook.commandGateIds(gate)].sort(), fromConfig);
  assert.deepStrictEqual(fromConfig, ['destructive-delete', 'git-destructive', 'kill-by-name']);
  for (const id of fromConfig) assert.ok(hook.WORDS[id], 'no plain-language wording for command gate ' + id);
});

t('write-outside-root / text gates are never enforced here, even when the classifier reports them', () => {
  // a stub classifier that DOES report the isolation gate and a text gate: only command-kind ids may block
  const stub = {
    listGates: () => gate.listGates(),
    classify: () => ({ gate: true, id: 'write-outside-root', class: 'isolation', reason: 'x', matched: ['write-outside-root', 'git-push'] }),
  };
  const d = hook.decide(bash('cp -r . ../other'), { config: null, gate: stub });
  assert.strictEqual(d.block, false);
  assert.ok(/^no-command-gate/.test(d.why), d.why);
  const both = { listGates: stub.listGates, classify: () => ({ gate: true, matched: ['write-outside-root', 'kill-by-name'] }) };
  assert.deepStrictEqual(hook.decide(bash('x'), { config: null, gate: both }).gates, ['kill-by-name'], 'only the command gate may be named');
});

t('M2: a classifier that throws -> the fallback blocks a destructive verb (2) and makes everything else VISIBLE (1)', () => {
  const badGate = { listGates: () => [{ id: 'x', kind: 'command' }], classify: () => { throw new Error('boom\nsecond line'); } };
  const r = hook.run(JSON.stringify(bash('rm -rf ./src')), { config: null, gate: badGate });
  assert.strictEqual(r.exitCode, 2);
  assert.ok(/fail-closed fallback \(boom\)/.test(r.why), r.why);
  const q = hook.run(JSON.stringify(bash('npm test')), { config: null, gate: badGate });
  assert.strictEqual(q.exitCode, 1);
  assert.ok(/classifier unavailable \(boom\)/.test(q.stderr) && !q.stderr.includes('\n'), q.stderr);
});

t('M2: an internal error outside the classifier -> exit 1 (visible), never a silent 0', () => {
  const r = hook.run(JSON.stringify(bash('npm test')), { get config() { throw new Error('seam exploded'); } });
  assert.strictEqual(r.exitCode, 1);
  assert.ok(/NOT checked: seam exploded/.test(r.stderr), r.stderr);
});

t('decide() reasons are specific (not-a-shell-tool / no-command / gate-hook-off / no-command-gate / no-gate)', () => {
  assert.strictEqual(hook.decide({ tool_name: 'Write', tool_input: {} }, { config: null }).why, 'not-a-shell-tool');
  assert.strictEqual(hook.decide(bash('   '), { config: null }).why, 'no-command');
  assert.ok(/^gate-hook-off/.test(hook.decide(bash('rm -rf ./x'), { config: { get: () => ({ value: false, source: 'flag' }) } }).why));
  assert.ok(/^no-command-gate/.test(hook.decide(bash('git push origin main'), { config: null }).why));
  assert.strictEqual(hook.decide(bash('git status'), { config: null }).why, 'no-gate');
});

// ---------------------------------------------------------------------------
// 4b) SCRATCH PASS-THROUGH (WP16 follow-up) — a destructive-delete that fired alone passes ONLY when every
// target provably resolves inside a scratch area. Spawned through the real hook with the payload's cwd set to
// the real project root (the root the hook itself hangs the areas from). Nothing is deleted — the hook only
// decides; targets need not exist.
// ---------------------------------------------------------------------------
console.log('\n4b) scratch pass-through — provable scratch targets pass, everything unprovable stays blocked');

const ROOT = hook.PROJECT_ROOT;
const TMP_TARGET = path.join(os.tmpdir(), 'forge-gate-hook-probe-' + process.pid, 'x');
const shellCall = (tool, command) => ({ hook_event_name: 'PreToolUse', tool_name: tool, cwd: ROOT, tool_input: { command } });

const PASSES = [
  ['Bash', 'rm -rf ./_scratch/run-1', '_scratch/run-1'],
  ['Bash', 'rm -rf ./packages/app/node_modules', 'packages/app/node_modules'],
  ['Bash', 'sudo rm -rf node_modules', 'node_modules'],
  ['PowerShell', 'Remove-Item -Recurse -Force .\\_scratch\\x', '_scratch/x'],
  ['PowerShell', 'Remove-Item -Recurse -Force ./_scratch/x', '_scratch/x'],
  ['Bash', 'rm -rf ' + TMP_TARGET.replace(/\\/g, '/'), '<tmp>/'],
  ['Bash', 'rm -rf dist', 'dist'],
  ['Bash', 'npx --yes rimraf ./_scratch/a ./_scratch/b', '_scratch/a, _scratch/b'],
  ['Bash', 'rm -r ./_scratch/x', '_scratch/x'],
  ['Bash', 'rm -rf node_modules && rm -rf ./_scratch/run-1', '_scratch/run-1'],
  ['Bash', 'rm -rf "./_scratch/a b"', '_scratch/a b'],
  ['Bash', 'rm -rf .claude/forge-backups/2026-09-01', '.claude/forge-backups/2026-09-01'],
  ['Bash', 'rm -rf .claude/forge-runs/r1/gate-output', '.claude/forge-runs/r1/gate-output'],
  ['Bash', 'rm -rf command-center/.data/tmp/x', 'command-center/.data/tmp/x'],
];
for (const [tool, cmd, shown] of PASSES) {
  t('PASS (' + tool + '): "' + cmd.replace(os.tmpdir().replace(/\\/g, '/'), '<tmp>') + '" -> exit 0 + one allowed-line', () => {
    assert.ok(gate.classify(cmd).matched.includes('destructive-delete'), 'precondition: the gate must fire, else this proves nothing');
    const r = spawnHook(shellCall(tool, cmd));
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ' stderr ' + r.stderr);
    assert.ok(r.stderr.startsWith('FORGE GATE: destructive delete allowed — all targets inside a project scratch area or in the OS temp dir outside the project ('), r.stderr);
    assert.ok(r.stderr.includes(shown), 'expected the target list to show ' + shown + ': ' + r.stderr);
    assert.strictEqual(r.stderr.trim().split('\n').length, 1, 'exactly one line');
    assert.strictEqual(r.stdout, '');
  });
}

if (process.platform === 'win32') {
  t('PASS (Bash, Git Bash drive form): /c/... under the temp dir resolves like C:/...', () => {
    const msys = TMP_TARGET.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase());
    const r = spawnHook(shellCall('Bash', 'rm -rf ' + msys));
    assert.strictEqual(r.status, 0, msys + ' -> ' + r.stderr);
  });
}

const STILL_BLOCKED = [
  ['Bash', 'rm -rf .', 'the project root itself'],
  ['Bash', 'rm -rf *', 'a glob cannot be proven'],
  ['Bash', 'rm -rf ../x', 'outside the project'],
  ['Bash', 'rm -rf src', 'a real source dir'],
  ['Bash', 'rm -rf build', 'a bare dir at the root that is not a scratch area'],
  ['Bash', 'rm -rf .claude', '.claude'],
  ['Bash', 'rm -rf .git', '.git'],
  ['Bash', 'rm -rf ~/.claude', '~ expands at run time'],
  ['Bash', 'rm -rf $TMP/x', 'a variable in the target'],
  ['PowerShell', 'Remove-Item -Recurse -Force $env:TEMP\\x', 'a PowerShell variable in the target'],
  ['Bash', 'rm -rf %USERPROFILE%\\x', 'a cmd variable in the target'],
  ['Bash', 'rm -rf ./_scratch/../src', 'a .. segment (never reasoned about)'],
  ['Bash', 'rm -rf C:\\', 'a drive root (and a backslash under bash)'],
  ['PowerShell', 'Remove-Item -Recurse -Force C:\\', 'a drive root'],
  ['Bash', 'rm -rf /', 'the file-system root'],
  ['Bash', 'rm -rf ' + os.tmpdir().replace(/\\/g, '/'), 'the temp dir ITSELF (only strictly inside passes)'],
  ['Bash', 'rm -rf .claude/forge-backups', 'the backups dir itself (only strictly inside passes)'],
  ['Bash', 'rm -rf ./_scratch/x src', 'one target outside is enough to block'],
  ['Bash', 'cd src && rm -rf ./_scratch/x', 'a cwd change makes the proof stale'],
  ['Bash', 'mv src _scratch/x && rm -rf ./_scratch/x', 'a same-line layout change makes the proof stale'],
  ['Bash', 'rm -rf ./_scratch/run-1 && npm ci', 'L2: every segment must itself be a provable delete'],
  ['Bash', '(mv src _scratch/x); rm -rf ./_scratch/x', 'L2: a subshell'],
  ['Bash', 'git mv src _scratch/x && rm -rf ./_scratch/x', 'L2: git mv'],
  ['Bash', '/bin/mv src _scratch/x && rm -rf ./_scratch/x', 'L2: a path-invoked mv'],
  ['Bash', 'command mv src _scratch/x; rm -rf ./_scratch/x', 'L2 / L3: command mv'],
  ['Bash', 'rm -rf ./_scratch/{a,b}', 'L3: brace expansion'],
  ['Bash', 'env -C / rm -rf ./_scratch/x', 'L3: env -C changes the cwd'],
  ['Bash', 'exec rm -rf ./_scratch/x', 'L3: exec'],
  ['Bash', 'rm -r ./src', 'H1: rm -r on a real dir'],
  ['Bash', 'rm -rf .\\_scratch\\x', 'bash reads \\ as an escape, not a separator'],
  ['Bash', 'rm -rf ./_scratch/x 2>/dev/null', 'a redirection is not provable'],
  ['Bash', 'git rm -r -f src', 'not a plain delete verb'],
  ['PowerShell', 'Get-ChildItem ./_scratch -Recurse | Remove-Item -Force', 'a pipeline delete'],
  ['PowerShell', 'Remove-Item -Recurse -Force -Path:C:\\src ./_scratch/x', 'a target hidden in a -Param:value'],
  ['Bash', 'rm -rf ./node_modules_backup', 'node_modules must be a whole path segment'],
  ['Bash', 'rmdir /s /q dist', '/s is a path to bash and to PowerShell, not a switch'],
];
for (const [tool, cmd, why] of STILL_BLOCKED) {
  t('STILL BLOCKED (' + why + '): "' + cmd.replace(os.tmpdir().replace(/\\/g, '/'), '<tmp>') + '"', () => {
    const r = spawnHook(shellCall(tool, cmd));
    assert.strictEqual(r.status, 2, 'exit ' + r.status + ' stderr ' + r.stderr);
    assert.ok(r.stderr.startsWith('FORGE GATE (destructive-delete'), r.stderr.split('\n')[0]);
  });
}

t('kill-by-name and git-destructive NEVER get a pass-through, even next to a provable scratch delete', () => {
  for (const cmd of ['rm -rf ./_scratch/x && taskkill /IM node.exe', 'git checkout -- _scratch/x', 'git clean -fdx _scratch',
    'rm -rf ./_scratch/x && git reset --hard']) {
    const r = spawnHook(shellCall('Bash', cmd));
    assert.strictEqual(r.status, 2, cmd + ' -> exit ' + r.status);
  }
});

t('FAIL-CLOSED: a pass-through that cannot read the gate config keeps the block (the gate already fired)', () => {
  const stub = {
    listGates: () => gate.listGates(),
    classify: () => ({ gate: true, matched: ['destructive-delete'] }),
    loadGates: () => { throw new Error('config unreadable'); },
    splitCommandsDetailed: gate.splitCommandsDetailed,
    isExcusedSegment: gate.isExcusedSegment,
  };
  const d = hook.decide(shellCall('Bash', 'rm -rf ./_scratch/x'), { config: null, gate: stub });
  assert.strictEqual(d.block, true);
  assert.ok(/no pass-through: internal-error/.test(d.why), d.why);
});

t('a symlink/junction inside _scratch that points OUT is judged by its real target (blocked)', () => {
  const root = path.join(TMP, 'link-root');
  fs.mkdirSync(path.join(root, '_scratch', 'real'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  let linked = true;
  try { fs.symlinkSync(path.join(root, 'src'), path.join(root, '_scratch', 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { linked = false; }
  // opts.tmpdir points elsewhere so this fixture (itself inside the real temp dir) is judged as a project, not as temp
  const opts = { config: null, projectRoot: root, tmpdir: path.join(TMP, 'not-the-fixture') };
  const at = (command) => hook.decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command } }, opts);
  assert.strictEqual(at('rm -rf ./_scratch/real/x').block, false, 'control: a real scratch dir must pass');
  assert.strictEqual(at('rm -rf ./src/x').block, true, 'control: src must block');
  if (!linked) { console.log('       (SKIP link half — this machine refused to create a junction/symlink)'); return; }
  const d = at('rm -rf ./_scratch/link/x');
  assert.strictEqual(d.block, true, 'a link out of _scratch must not pass: ' + d.why);
});

// ---------------------------------------------------------------------------
// 4d) EINDTEST GAP (2026-09-24): a PROJECT that itself lives under the OS temp dir. Before the fix the temp rule
// swallowed the whole project — every delete in it passed as "<tmp>/…/proj/src". Now the temp rule only applies
// to targets OUTSIDE every protected root (this file's project root + CLAUDE_PROJECT_DIR, else the cwd), and a
// target that equals or CONTAINS a protected root never passes. Spawned from a hook copied into the fixture, with
// and without CLAUDE_PROJECT_DIR — exactly the fresh-install situation of the eindtest.
// ---------------------------------------------------------------------------
console.log('\n4d) a project under the OS temp dir is still protected — the temp rule only covers targets outside it');

const TP_PARENT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-tmpproj-'));
const TP = path.join(TP_PARENT, 'proj');
const SIBLING = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-sibling-'));
fs.mkdirSync(path.join(TP, '.claude', 'forge-bin'), { recursive: true });
fs.mkdirSync(path.join(TP, '.claude', 'config', 'orchestration'), { recursive: true });
for (const f of ['forge-gate-hook.cjs', 'forge-actiongate.cjs', 'forge-gate-data.cjs']) fs.copyFileSync(path.join(__dirname, f), path.join(TP, '.claude', 'forge-bin', f));
fs.copyFileSync(gate.CONFIG_PATH, path.join(TP, '.claude', 'config', 'orchestration', 'hard-gates.json'));
const fwd = (p) => p.replace(/\\/g, '/');
function spawnInTmpProject(command, claudeProjectDir) {
  const env = Object.assign({}, process.env, { FORGE_CONFIG_HOME: HOME, FORGE_PROJECT_ROOT: TP });
  if (claudeProjectDir) env.CLAUDE_PROJECT_DIR = claudeProjectDir; else delete env.CLAUDE_PROJECT_DIR;
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: TP, tool_input: { command } };
  return spawnSync(process.execPath, [path.join(TP, '.claude', 'forge-bin', 'forge-gate-hook.cjs')],
    { input: JSON.stringify(payload), encoding: 'utf8', env, cwd: TP, timeout: 15000 });
}
for (const cpd of [null, TP]) {
  const how = cpd ? 'CLAUDE_PROJECT_DIR set' : 'no CLAUDE_PROJECT_DIR';
  for (const cmd of ['rm -rf src', 'rm -rf .', 'rm -r ./src', 'rm -rf .claude', 'rm -rf ' + fwd(TP), 'rm -rf ' + fwd(TP_PARENT)]) {
    t('tmp-located project (' + how + '): "' + cmd.replace(fwd(os.tmpdir()), '<tmp>') + '" is BLOCKED', () => {
      const r = spawnInTmpProject(cmd, cpd);
      assert.strictEqual(r.status, 2, 'exit ' + r.status + ' ' + r.stderr.split('\n')[0]);
    });
  }
  for (const cmd of ['rm -rf ./_scratch/x', 'rm -r ./node_modules/.cache', 'rm -rf ' + fwd(path.join(SIBLING, 'x'))]) {
    t('tmp-located project (' + how + '): "' + cmd.replace(fwd(os.tmpdir()), '<tmp>') + '" still PASSES', () => {
      const r = spawnInTmpProject(cmd, cpd);
      assert.strictEqual(r.status, 0, 'exit ' + r.status + ' ' + r.stderr);
      assert.ok(r.stderr.startsWith('FORGE GATE: destructive delete allowed'), r.stderr);
    });
  }
}
t('module level: CLAUDE_PROJECT_DIR (else the cwd) is protected even when the hook lives elsewhere', () => {
  const at = (command, env) => hook.decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: TP, tool_input: { command } },
    { config: null, env: env || {} });
  assert.strictEqual(at('rm -rf ' + fwd(path.join(TP, 'src'))).block, true, 'cwd-derived root must be protected');
  assert.strictEqual(at('rm -rf ' + fwd(path.join(TP, 'src')), { CLAUDE_PROJECT_DIR: TP }).block, true, 'CLAUDE_PROJECT_DIR root must be protected');
  assert.strictEqual(at('rm -rf ' + fwd(path.join(SIBLING, 'y'))).block, false, 'a sibling temp dir outside the project passes');
});

// ---------------------------------------------------------------------------
// 4c) INERT DATA (WP16 follow-up 2) — three real over-fires in one day blocked a call whose QUOTED DATA only
// mentioned a gated command. Only provably-inert regions are stripped before classifying; every case where
// the "data" could execute must still exit 2. Spawned through the real hook.
// ---------------------------------------------------------------------------
console.log('\n4c) inert data — quoted writer heredocs / echo / commit messages / log-event payloads are not commands');

const BODY = 'Review: never run rm -rf ./src here, never git reset --hard origin/main,\nand never taskkill /IM node.exe.';
const DATA_CASES = [
  // [number/label, tool, command, expected exit]
  ['(1) cat > file <<\'EOF\' body with recursive delete + hard reset', 'Bash', "cat > tmp/prompt.txt <<'EOF'\n" + BODY + '\nEOF', 0],
  ['(2) the same body fed to bash <<\'EOF\'', 'Bash', "bash <<'EOF'\n" + BODY + '\nEOF', 2],
  ['(3) log-event.cjs single-quoted JSON payload', 'Bash', "node .claude/forge-dashboard/log-event.cjs run x agent_note '{\"note\":\"never rm -rf ./src\"}'", 0],
  ['(3b) log-event.cjs double-quoted escaped JSON payload', 'Bash', 'node .claude/forge-dashboard/log-event.cjs run x agent_note "{\\"note\\":\\"never rm -rf ./src\\"}"', 0],
  ['(4) echo "git reset --hard" | bash', 'Bash', 'echo "git reset --hard" | bash', 2],
  ['(5) bash -c "rm -rf x"', 'Bash', 'bash -c "rm -rf x"', 2],
  ['(6) git commit -m with a gated command in the message', 'Bash', 'git commit -m "docs: never run rm -rf on home"', 0],
  ['(7) UNQUOTED heredoc with $(rm -rf x) in the body', 'Bash', 'cat > f.txt <<EOF\nhello $(rm -rf x)\nEOF', 2],
  ['(8) tee file <<\'EOF\' body with kill-by-name text', 'Bash', "tee notes.md <<'EOF'\nStop-Process -Name node\ntaskkill /IM node.exe\nEOF", 0],
  ['git commit -m "$(cat <<\'EOF\' ...)" (the Claude Code commit form)', 'Bash', "git commit -m \"$(cat <<'EOF'\nfix: document that git reset --hard is gated\nEOF\n)\"", 0],
  ['commit heredoc whose substitution pipes into bash', 'Bash', "git commit -m \"$(cat <<'EOF'\nrm -rf ./src\nEOF\n| bash)\"", 2],
  ['cat <<\'EOF\' | bash (a piped writer)', 'Bash', "cat <<'EOF' | bash\nrm -rf ./src\nEOF", 2],
  ['a writer heredoc that writes a SCRIPT file (.sh)', 'Bash', "cat > cleanup.sh <<'EOF'\nrm -rf ./src\nEOF", 2],
  ['write a file, then run it with bash in the same command', 'Bash', "cat > cleanup <<'EOF'\nrm -rf ./src\nEOF\nbash cleanup", 2],
  ['echo a literal into run.sh, then bash run.sh', 'Bash', "echo 'rm -rf ./src' > run.sh && bash run.sh", 2],
  ['a literal assigned to a variable and expanded', 'Bash', "X='rm -rf ./src'; $X", 2],
  ['node -e executes its literal', 'Bash', "node -e 'require(\"fs\"); /* rm -rf ./src */'", 2],
  ['an escaped quote outside quotes (it\\\'s) cannot open a fake literal', 'Bash', "echo it\\'s; rm -rf ./src; echo 'x'", 2],
  ['a double-quoted literal with $(...) inside is not inert', 'Bash', 'echo "value $(rm -rf ./src)"', 2],
  ['a real command next to a data literal is still classified', 'Bash', 'echo "rm -rf ./src" ; rm -rf ./src', 2],
  ['echo piped into ANY command is not stripped (conservative)', 'Bash', 'echo "git reset --hard" | cat', 2],
  ['an unbalanced quote before the heredoc head strips nothing', 'Bash', "echo \"a && cat > f <<'EOF'\nx\" ; rm -rf ./src ; echo \"\nEOF", 2],
  ['PowerShell: echo \'...\' literal', 'PowerShell', "echo 'never Stop-Process -Name node'", 0],
  ['PowerShell: git commit -m "..." literal', 'PowerShell', 'git commit -m "docs: rm -rf is gated"', 0],
  ['PowerShell: a lone & (call operator / unreadable) strips nothing', 'PowerShell', "echo 'x' & rm -rf ./src", 2],
  // review wp9a L1 — ANY interpreter / layout command LATER in the line keeps the data classified
  ['L1: write a .txt, rename it to .sh, run it', 'Bash', "cat > x.txt <<'EOF'\nrm -rf ./src\nEOF\nmv x.txt x.sh; bash x.sh", 2],
  ['L1: echo into a file, then cat it into sh', 'Bash', 'echo "rm -rf ./src" > x.txt; cat x.txt | sh', 2],
  ['L1: a commit message followed by a later interpreter', 'Bash', 'git commit -m "rm -rf ./src" && node x.cjs', 2],
  // review wp9a L3 — search tools never execute their quoted pattern
  ['L3: grep -rn "pkill" .', 'Bash', 'grep -rn "pkill" .', 0],
  ['L3: rg over a quoted kill-by-name pattern', 'Bash', 'rg "taskkill /IM node.exe" .claude', 0],
  ['L3: git log --grep="rm -rf"', 'Bash', 'git log --grep="rm -rf" --oneline', 0],
  ['L3: git grep "git reset --hard"', 'Bash', 'git grep "git reset --hard"', 0],
  ['L3: PowerShell Select-String -Pattern', 'PowerShell', 'Select-String -Pattern "Stop-Process -Name node" -Path notes.md', 0],
  ['L3: findstr "pkill"', 'PowerShell', 'findstr "pkill" notes.md', 0],
  ['L3: a search piped into xargs kill is NOT data', 'Bash', 'grep -l "pkill" . | xargs kill', 2],
];
for (const [label, tool, command, want] of DATA_CASES) {
  t(label + ' -> exit ' + want, () => {
    const r = spawnHook(shellCall(tool, command));
    assert.strictEqual(r.status, want, 'exit ' + r.status + ' stderr ' + r.stderr.split('\n')[0]);
    if (want === 0) assert.strictEqual(r.stderr, '', 'an inert-data pass is silent');
  });
}

t('stripInertData never throws and strips nothing it cannot read (garbage, unbalanced quotes, two heredocs on a line)', () => {
  for (const s of ["echo 'unclosed", "cat <<A <<B\nx\nA\ny\nB", "cat > f <<'EOF'\nno end", '\u0000\u0001', 42, null]) {
    const r = data.stripInertData(s, 'Bash');
    assert.strictEqual(r.regions, 0, JSON.stringify(s));
    assert.strictEqual(r.text, String(s).replace(/\r\n/g, '\n'));
  }
});

t('the data pass-through is not a scratch pass: stripping leaves the real command intact for classification', () => {
  const r = data.stripInertData("git commit -m 'never rm -rf' && rm -rf ./src", 'Bash');
  assert.strictEqual(r.regions, 1);
  assert.ok(r.text.includes('&& rm -rf ./src') && !r.text.includes('never'), r.text);
});

// ---------------------------------------------------------------------------
// 5) wiring + timing
// ---------------------------------------------------------------------------
console.log('\n5) wiring in .claude/settings.json + timing budget');

t('.claude/settings.json wires this hook as PreToolUse for Bash (and PowerShell), keeping the 3 existing hooks', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.json'), 'utf8'));
  const GATE_CMDS = ['node .claude/forge-bin/forge-gate-hook.cjs', 'node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-gate-hook.cjs"'];
  const pre = (settings.hooks.PreToolUse || []).find((e) => (e.hooks || []).some((h) => GATE_CMDS.includes(h.command)));
  assert.ok(pre, 'no PreToolUse entry runs forge-gate-hook.cjs');
  assert.deepStrictEqual(pre.matcher.split('|').sort(), ['Bash', 'PowerShell']);
  const cmds = JSON.stringify(settings.hooks);
  for (const f of ['forge-snapshot-marker.cjs', 'forge-snapshot-reinject.cjs', 'forge-toolhook.cjs']) {
    assert.ok(cmds.includes(f), 'existing hook lost: ' + f);
  }
  assert.ok(Array.isArray(settings.permissions.deny) && settings.permissions.deny.includes('Read(./.env)'), 'Read(./.env) deny rule missing');
  for (const r of ['Read(./**/.env)', 'Read(./**/*.pem)', 'Read(~/.ssh/**)', 'Read(~/.claude/.credentials.json)']) {
    assert.ok(settings.permissions.deny.includes(r), 'security wp9b L5 deny rule missing: ' + r);
  }
  assert.ok(!settings.permissions.deny.some((r) => /\.env\.\*\)$|\.env\.example|\.env\*\)$/.test(r)), 'a deny rule would also hide .env.example');
});

t('security wp9b L8: every hook timeout is in SECONDS (Claude Code contract) — 1..60, not milliseconds', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.json'), 'utf8'));
  for (const [event, entries] of Object.entries(settings.hooks)) {
    for (const e of entries) for (const h of e.hooks) {
      assert.ok(Number.isInteger(h.timeout) && h.timeout >= 1 && h.timeout <= 60, event + ' ' + h.command + ' timeout ' + h.timeout);
    }
  }
});

// review wp9a L9: this suite runs inside every beginner's doctor and on windows-latest CI, so the HARD budget is
// generous (1000 ms, env FORGE_GATE_HOOK_TIMING_MS) and the 200 ms design target is an advisory line only.
const BUDGET_MS = Number(process.env.FORGE_GATE_HOOK_TIMING_MS) || 1000;
t('timing: best of 5 real spawns (block path, config resolved) under ' + BUDGET_MS + ' ms (200 ms is advisory)', () => {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnHook(bash('git checkout .'));
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.strictEqual(r.status, 2);
  }
  times.sort((a, b) => a - b);
  console.log('       timings ms: ' + times.map((x) => x.toFixed(0)).join(', ') + ' (min ' + times[0].toFixed(0) + ', median ' + times[2].toFixed(0) + ')');
  if (times[0] >= 200) console.log('       ADVISORY: fastest run ' + times[0].toFixed(0) + ' ms is above the 200 ms design target (not a failure)');
  assert.ok(times[0] < BUDGET_MS, 'fastest run took ' + times[0].toFixed(0) + ' ms (hard budget ' + BUDGET_MS + ' ms; override FORGE_GATE_HOOK_TIMING_MS on a slow runner)');
});

for (const d of [TMP, TP_PARENT, SIBLING]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ } }

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
