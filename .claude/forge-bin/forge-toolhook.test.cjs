#!/usr/bin/env node
'use strict';
/**
 * forge-toolhook.test.cjs — tests for the PostToolUse tool-behaviour ledger (2026-08-01).
 *
 * WHY THIS EXISTS: measured on 2026-08-01 across all 28 events.jsonl in this project — 846 events, of which
 * `file_read` 0 and `command_run` 1. Both types are registered in log-event.cjs; they are simply never
 * written, because an agent has to log them by hand and doesn't. So "I ran the tests" is a CLAIM with no
 * counter-evidence. This module is the counter-evidence: a PostToolUse hook writes it, not the agent.
 *
 * The load-bearing tests are the CLI robustness ones (section F): this hook fires on EVERY tool call in a
 * LIVE session, so a throw, a hang, or a stray stdout byte would poison every agent in the project. Those
 * tests spawn the real script as a real subprocess and assert exit 0 + empty stdout on garbage, on an
 * un-creatable log path, and on a multi-megabyte payload.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, 'forge-toolhook.cjs');
const hook = require('./forge-toolhook.cjs');

// Hermetic owner settings (forge-config.cjs, v2.7.0): the global settings file is read from a throwaway home,
// never ~/.claude, and FORGE_PROJECT_ROOT is cleared so each fixture ROOT decides which project file is read.
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-toolhook-cfghome-'));
process.env.FORGE_CONFIG_HOME = CONFIG_HOME;
delete process.env.FORGE_PROJECT_ROOT;

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function tmpRoot(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-toolhook-' + label + '-'));
  fs.mkdirSync(path.join(d, '.claude', 'forge-runs'), { recursive: true });
  return d;
}
function logFile(root, sid) { return path.join(root, '.claude', 'forge-runs', '_toollog', sid + '.jsonl'); }
function readLines(f) {
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim().length);
}
function payload(over) {
  return Object.assign({
    session_id: 'sess1', hook_event_name: 'PostToolUse', tool_name: 'Read',
    tool_input: { file_path: '/x/y.txt' }, tool_response: { ok: true },
    agent_id: 'ag1', agent_type: 'general-purpose', tool_use_id: 'toolu_01', duration_ms: 12,
    permission_mode: 'default',
  }, over || {});
}

console.log('forge-toolhook tests (PostToolUse tool-behaviour ledger)');

// ---- A. summarizeTarget — what we keep of the tool's target, and what we deliberately drop ----
console.log('\nA) summarizeTarget — safe target summary, never content');

t('A1 file_path is kept and made project-relative', () => {
  const root = path.resolve('/proj');
  const r = hook.summarizeTarget('Read', { file_path: path.join(root, 'src', 'a.js') }, root);
  assert.strictEqual(r.target_kind, 'path');
  assert.ok(/^src[\\/]a\.js$/.test(r.target), 'expected relative path, got ' + r.target);
});

t('A2 Bash keeps ONLY the first token — the arguments never reach disk', () => {
  const r = hook.summarizeTarget('Bash', { command: 'curl -H "Authorization: Bearer hunter2secret" https://api.x/v1' }, '/proj');
  assert.strictEqual(r.target_kind, 'command');
  assert.strictEqual(r.target, 'curl');
  assert.ok(!/hunter2secret/.test(JSON.stringify(r)), 'argument text leaked into the summary');
});

t('A3 a leading VAR=value assignment is skipped, the real binary is recorded', () => {
  const r = hook.summarizeTarget('Bash', { command: 'API_KEY=sk-live-abcdefghijklmnop node run.js' }, '/proj');
  assert.strictEqual(r.target, 'node');
  assert.ok(!/sk-live-abcdefghijklmnop/.test(JSON.stringify(r)), 'env-assignment secret leaked');
});

t('A4 a quoted first token is parsed whole, then reduced to its canonical command name', () => {
  // CHANGED 2026-08-01 (leak X1): the full path used to be written verbatim. It no longer is — a path can
  // carry a secret in a directory component that matches no key format, so `target` for a command is now
  // always a constant from KNOWN_COMMANDS. firstToken still parses the quoted token whole; only what
  // reaches disk changed.
  const cmd = '"C:/Program Files/nodejs/node.exe" x.js --token=abc';
  assert.strictEqual(hook.firstToken(cmd), 'C:/Program Files/nodejs/node.exe');
  const r = hook.summarizeTarget('Bash', { command: cmd }, '/proj');
  assert.strictEqual(r.target, 'node');
  assert.strictEqual(r.target_kind, 'command');
  assert.ok(!/--token=abc|Program Files/.test(JSON.stringify(r)), 'argument or path bytes leaked');
});

t('A5 Grep: the search PATTERN is never stored (it is content); the search path is', () => {
  const r = hook.summarizeTarget('Grep', { pattern: 'PASSWORD=(\\S+)', path: '/proj/src' }, '/proj');
  assert.strictEqual(r.target_kind, 'path');
  assert.ok(!/PASSWORD/.test(JSON.stringify(r)), 'grep pattern leaked into the ledger');
});

t('A6 Glob with no path yields no target rather than storing the pattern', () => {
  const r = hook.summarizeTarget('Glob', { pattern: '**/*.env' }, '/proj');
  assert.strictEqual(r.target, null);
  assert.strictEqual(r.target_kind, 'none');
});

t('A7 a URL is reduced to its host — query strings can carry tokens', () => {
  const r = hook.summarizeTarget('WebFetch', { url: 'https://api.example.com/v1/x?access_token=SEKRET' }, '/proj');
  assert.strictEqual(r.target_kind, 'url_host');
  assert.strictEqual(r.target, 'api.example.com');
  assert.ok(!/SEKRET/.test(JSON.stringify(r)), 'url query leaked');
});

t('A8 a Task dispatch records the subagent type', () => {
  const r = hook.summarizeTarget('Task', { subagent_type: 'general-purpose', prompt: 'secret mission text' }, '/proj');
  assert.strictEqual(r.target_kind, 'subagent');
  assert.strictEqual(r.target, 'general-purpose');
  assert.ok(!/secret mission text/.test(JSON.stringify(r)), 'prompt body leaked');
});

t('A9 a secret embedded in a path is redacted with the project scrub patterns', () => {
  const r = hook.summarizeTarget('Read', { file_path: '/tmp/sk-abcdefghijklmnopqrstuvwxyz012/x.txt' }, '/proj');
  assert.ok(/REDACTED/.test(r.target), 'expected redaction marker, got ' + r.target);
  assert.ok(!/abcdefghijklmnopqrstuvwxyz012/.test(r.target), 'raw key survived');
});

t('A10 an absurdly long target is capped', () => {
  const r = hook.summarizeTarget('Read', { file_path: '/' + 'a'.repeat(5000) }, '/proj');
  assert.ok(r.target.length <= hook.MAX_TARGET_CHARS, 'target length ' + r.target.length);
});

t('A11 a non-object tool_input yields no target instead of throwing', () => {
  assert.strictEqual(hook.summarizeTarget('X', 'a string', '/proj').target_kind, 'none');
  assert.strictEqual(hook.summarizeTarget('X', null, '/proj').target_kind, 'none');
});

// ---- B. deriveOk — did the call succeed, and on what basis do we say so ----
console.log('\nB) deriveOk — success is derived, and the basis is recorded');

t('B1 no tool_response -> unknown, never a guessed true', () => {
  const r = hook.deriveOk(undefined);
  assert.strictEqual(r.ok, null); assert.strictEqual(r.ok_basis, 'absent');
});
t('B2 is_error true -> false', () => assert.strictEqual(hook.deriveOk({ is_error: true }).ok, false));
t('B3 success:false -> false', () => assert.strictEqual(hook.deriveOk({ success: false }).ok, false));
t('B4 success:true -> true with basis success-field', () => {
  const r = hook.deriveOk({ success: true });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.ok_basis, 'success-field');
});
t('B5 a non-empty error field -> false', () => assert.strictEqual(hook.deriveOk({ error: 'boom' }).ok, false));
t('B6 a plain string response -> true with basis present', () => {
  const r = hook.deriveOk('file contents here');
  assert.strictEqual(r.ok, true); assert.strictEqual(r.ok_basis, 'present');
});

// ---- C. sessionBucket — the partition key is also a path component, so it is a traversal guard ----
console.log('\nC) sessionBucket — partition key doubles as a path guard');

t('C1 a normal session id passes through', () => assert.strictEqual(hook.sessionBucket('abc-123_XY'), 'abc-123_XY'));
t('C2 a traversal attempt is refused, not sanitized into something clever', () => {
  assert.strictEqual(hook.sessionBucket('../../etc/passwd'), 'unknown-session');
  assert.strictEqual(hook.sessionBucket('a/b'), 'unknown-session');
  assert.strictEqual(hook.sessionBucket('a\\b'), 'unknown-session');
});
t('C3 missing/empty -> unknown-session', () => {
  assert.strictEqual(hook.sessionBucket(undefined), 'unknown-session');
  assert.strictEqual(hook.sessionBucket(''), 'unknown-session');
});
t('C4 an over-long id is refused', () => assert.strictEqual(hook.sessionBucket('x'.repeat(200)), 'unknown-session'));

// ---- D. buildLine — the record itself ----
console.log('\nD) buildLine — required fields present, content fields absent');

t('D1 carries time, agent, tool, target, duration and outcome', () => {
  const l = hook.buildLine(payload(), { root: '/proj' });
  for (const k of ['ts', 'session', 'agent_id', 'agent_type', 'tool', 'target', 'target_kind', 'ok', 'ok_basis', 'ms', 'tool_use_id']) {
    assert.ok(Object.prototype.hasOwnProperty.call(l, k), 'missing field ' + k);
  }
  assert.strictEqual(l.tool, 'Read');
  assert.strictEqual(l.agent_type, 'general-purpose');
  assert.strictEqual(l.ms, 12);
});

t('D2 no tool_response body and no tool_input body ever reach the line', () => {
  const l = hook.buildLine(payload({
    tool_input: { file_path: '/x/y.txt', old_string: 'MY_SECRET_CONTENT_A', new_string: 'MY_SECRET_CONTENT_B' },
    tool_response: { content: 'MY_SECRET_RESPONSE_BODY' },
  }), { root: '/proj' });
  const s = JSON.stringify(l);
  assert.ok(!/MY_SECRET_CONTENT_A|MY_SECRET_CONTENT_B|MY_SECRET_RESPONSE_BODY/.test(s), 'content leaked: ' + s);
});

t('D3 run id is attached only when one is explicitly supplied', () => {
  assert.strictEqual(hook.buildLine(payload(), { root: '/proj' }).run, undefined);
  assert.strictEqual(hook.buildLine(payload(), { root: '/proj', runId: 'forge-2026-08-01-x' }).run, 'forge-2026-08-01-x');
  assert.strictEqual(hook.buildLine(payload(), { root: '/proj', runId: '../evil' }).run, undefined);
});

// ---- E. run() — the write path ----
console.log('\nE) run() — writes one bounded line per tool call');

t('E1 writes exactly one line to forge-runs/_toollog/<session>.jsonl', () => {
  const root = tmpRoot('e1');
  const r = hook.run(JSON.stringify(payload()), { root });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.wrote, true);
  const lines = readLines(logFile(root, 'sess1'));
  assert.strictEqual(lines.length, 1);
  const o = JSON.parse(lines[0]);
  assert.strictEqual(o.tool, 'Read'); assert.strictEqual(o.agent_id, 'ag1');
});

t('E2 successive calls append rather than overwrite', () => {
  const root = tmpRoot('e2');
  hook.run(JSON.stringify(payload()), { root });
  hook.run(JSON.stringify(payload({ tool_name: 'Bash', tool_input: { command: 'git status' } })), { root });
  const lines = readLines(logFile(root, 'sess1'));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[1]).target, 'git');
});

t('E3 a payload with no tool_name writes nothing and says why', () => {
  const root = tmpRoot('e3');
  const r = hook.run(JSON.stringify({ session_id: 'sess1', hook_event_name: 'SessionStart' }), { root });
  assert.strictEqual(r.wrote, false);
  assert.strictEqual(r.reason, 'no-tool_name');
  assert.ok(!fs.existsSync(logFile(root, 'sess1')));
});

t('E4 garbage stdin never throws and never writes', () => {
  const root = tmpRoot('e4');
  for (const junk of ['', 'not json at all', '{"a":', '\u0000\u0001', '[]', 'null']) {
    const r = hook.run(junk, { root });
    assert.strictEqual(r.wrote, false, 'junk unexpectedly written: ' + junk);
  }
});

t('E5 an un-creatable log directory returns ok:false instead of throwing', () => {
  const root = tmpRoot('e5');
  // a FILE where the _toollog directory must be — cross-platform way to make the write impossible
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', '_toollog'), 'blocker', 'utf8');
  const r = hook.run(JSON.stringify(payload()), { root });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.wrote, false);
  assert.ok(r.reason && r.reason.length, 'expected a reason');
});

t('E6 an oversized payload is salvaged: the call is still recorded, marked truncated', () => {
  const root = tmpRoot('e6');
  const big = JSON.stringify(payload({ tool_response: { content: 'Z'.repeat(4000) } }));
  const r = hook.run(big, { root, headBytes: 300 });
  assert.strictEqual(r.wrote, true, 'a huge payload must still leave a trace');
  const o = JSON.parse(readLines(logFile(root, 'sess1'))[0]);
  assert.strictEqual(o.truncated, true);
  assert.strictEqual(o.tool, 'Read', 'tool name must survive salvage');
  assert.ok(!/ZZZZ/.test(JSON.stringify(o)), 'response body survived salvage');
});

t('E7 every written line stays under MAX_LINE_BYTES', () => {
  const root = tmpRoot('e7');
  hook.run(JSON.stringify(payload({
    tool_input: { file_path: '/' + 'p'.repeat(9000) },
    agent_type: 'q'.repeat(4000),
  })), { root });
  const raw = readLines(logFile(root, 'sess1'))[0];
  assert.ok(Buffer.byteLength(raw, 'utf8') <= hook.MAX_LINE_BYTES, 'line was ' + Buffer.byteLength(raw, 'utf8') + ' bytes');
});

t('E8 the log rotates at the byte cap and keeps exactly one generation', () => {
  const root = tmpRoot('e8');
  const f = logFile(root, 'sess1');
  for (let i = 0; i < 12; i++) hook.run(JSON.stringify(payload({ tool_use_id: 'toolu_' + i })), { root, maxLogBytes: 600 });
  assert.ok(fs.existsSync(f + '.1') || fs.existsSync(f.replace(/\.jsonl$/, '.1.jsonl')), 'no rotated generation found');
  const rotated = fs.existsSync(f.replace(/\.jsonl$/, '.1.jsonl')) ? f.replace(/\.jsonl$/, '.1.jsonl') : f + '.1';
  assert.ok(fs.statSync(f).size < 600 * 3, 'live file did not restart after rotation');
  assert.ok(fs.statSync(rotated).size > 0, 'rotated generation is empty');
  const names = fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith('sess1'));
  assert.ok(names.length <= 2, 'more than 2 generations kept: ' + names.join(','));
});

t('E9 an unusable session id still lands in a safe bucket, never outside _toollog', () => {
  const root = tmpRoot('e9');
  const r = hook.run(JSON.stringify(payload({ session_id: '../../escape' })), { root });
  assert.strictEqual(r.wrote, true);
  const dir = path.join(root, '.claude', 'forge-runs', '_toollog');
  assert.ok(path.resolve(r.path).startsWith(path.resolve(dir) + path.sep), 'wrote outside _toollog: ' + r.path);
  assert.ok(fs.existsSync(logFile(root, 'unknown-session')));
});

// ---- F. CLI robustness — the live-session contract. THESE are the load-bearing tests. ----
console.log('\nF) CLI robustness — never blocks a tool call (real subprocesses)');

function runCli(input, cwd, env) {
  return spawnSync(process.execPath, [HOOK], {
    input, cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, env || {}),
  });
}

t('F1 garbage on stdin -> exit 0, no stdout', () => {
  const root = tmpRoot('f1');
  const r = runCli('this is not json {{{', root, { CLAUDE_PROJECT_DIR: root });
  assert.strictEqual(r.status, 0, 'exit was ' + r.status + ' stderr=' + r.stderr);
  assert.strictEqual(r.stdout, '', 'stdout was not empty: ' + JSON.stringify(r.stdout));
});

t('F2 empty stdin -> exit 0, no stdout', () => {
  const root = tmpRoot('f2');
  const r = runCli('', root, { CLAUDE_PROJECT_DIR: root });
  assert.strictEqual(r.status, 0, 'exit was ' + r.status);
  assert.strictEqual(r.stdout, '');
});

t('F3 an un-creatable log path -> exit 0, no stdout, tool call unaffected', () => {
  const root = tmpRoot('f3');
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', '_toollog'), 'blocker', 'utf8');
  const r = runCli(JSON.stringify(payload()), root, { CLAUDE_PROJECT_DIR: root });
  assert.strictEqual(r.status, 0, 'exit was ' + r.status + ' stderr=' + r.stderr);
  assert.strictEqual(r.stdout, '');
});

t('F4 a multi-megabyte payload -> exit 0, no stdout, still recorded', () => {
  const root = tmpRoot('f4');
  const huge = JSON.stringify(payload({ tool_response: { content: 'Z'.repeat(2 * 1024 * 1024) } }));
  assert.ok(huge.length > 2 * 1024 * 1024, 'test payload not actually huge');
  const started = Date.now();
  const r = runCli(huge, root, { CLAUDE_PROJECT_DIR: root });
  const elapsed = Date.now() - started;
  assert.strictEqual(r.status, 0, 'exit was ' + r.status + ' stderr=' + r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.ok(elapsed < 15000, 'took ' + elapsed + 'ms — too slow for a per-tool-call hook');
  assert.ok(fs.existsSync(logFile(root, 'sess1')), 'huge call left no trace at all');
});

t('F5 a valid payload via the real CLI lands on disk -> exit 0, no stdout', () => {
  const root = tmpRoot('f5');
  const r = runCli(JSON.stringify(payload({ tool_name: 'Bash', tool_input: { command: 'npm test --silent' } })), root, { CLAUDE_PROJECT_DIR: root });
  assert.strictEqual(r.status, 0, 'exit was ' + r.status + ' stderr=' + r.stderr);
  assert.strictEqual(r.stdout, '');
  const o = JSON.parse(readLines(logFile(root, 'sess1'))[0]);
  assert.strictEqual(o.tool, 'Bash');
  assert.strictEqual(o.target, 'npm');
});

t('F6 a payload whose fields are hostile types -> exit 0, no throw', () => {
  const root = tmpRoot('f6');
  const r = runCli(JSON.stringify({
    session_id: { nested: true }, tool_name: ['Read'], tool_input: 42, tool_response: [1, 2],
    duration_ms: 'not-a-number', agent_id: null, hook_event_name: 'PostToolUse',
  }), root, { CLAUDE_PROJECT_DIR: root });
  assert.strictEqual(r.status, 0, 'exit was ' + r.status + ' stderr=' + r.stderr);
  assert.strictEqual(r.stdout, '');
});

// ---- G. storage-choice guards — the reasons the location is safe must stay true ----
console.log('\nG) storage choice — no new event type, invisible to every run picker');

t('G1 the hook never touches events.jsonl and never loads log-event.cjs', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/log-event/.test(code), 'hook references log-event.cjs — it would need a new registered event_type');
  assert.ok(!/events\.jsonl/.test(code), 'hook references events.jsonl — that is the run ledger, not this log');
});

t('G2 the tool-log directory is not a run directory, so run pickers skip it', () => {
  const root = tmpRoot('g2');
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', 'forge-real-run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', 'forge-real-run', 'events.jsonl'), '{"event_type":"run_started"}\n', 'utf8');
  hook.run(JSON.stringify(payload()), { root });
  const doctor = require('./forge-doctor.cjs');
  const names = doctor.rankRunCandidates(root, {}).map((c) => c.name);
  assert.ok(names.includes('forge-real-run'), 'sanity: the real run must be a candidate');
  assert.ok(!names.includes('_toollog'), '_toollog was picked up as a run: ' + names.join(','));
});

t('G3 the log path is gitignored by the existing forge-runs rule (no .gitignore edit needed)', () => {
  const projectRoot = path.resolve(__dirname, '..', '..');
  // INSTALL-DEADLOCK FIX (2026-08-03): in a project that is not (yet) a git repository — the normal state
  // of a fresh install target, where this suite runs as forge-sync's post-install validation — nothing is
  // committable at all, so "must never be committable" is vacuously satisfied and `git check-ignore`
  // cannot even answer (exit 128, "not a git repository"; exit ENOENT when git itself is absent). That
  // non-answer made every gitless fresh install fail validation and roll back — the owner's live
  // workaround trail ("retry after git init") is this exact defect. Honest outcome: pass-with-reason on
  // "no git here", stay STRICT the moment a real repository exists.
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot, encoding: 'utf8' });
  if (probe.error || probe.status !== 0 || String(probe.stdout).trim() !== 'true') {
    console.log('       (no git repository at this root — nothing is committable, rule check not applicable here)');
    return;
  }
  const r = spawnSync('git', ['check-ignore', '-v', '.claude/forge-runs/_toollog/x.jsonl'], { cwd: projectRoot, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'path is NOT gitignored — a tool ledger must never be committable');
  assert.ok(/forge-runs/.test(r.stdout), 'unexpected ignore rule: ' + r.stdout);
});

// ---- H. LEAK REGRESSIONS — every one of these was a REPRODUCED leak on 2026-08-01, found by an
// independent witness who ran the real CLI subprocess and then combed the whole tree for a canary marker.
// Each test below reproduces one of them the same way: real subprocess, then an on-disk search of every
// file NAME and every file BODY under the project root — never merely an assertion on the return value,
// because the return value is exactly what the original review looked at and it is what hid these. ----
console.log('\nH) leak regressions — canary hunted on disk, not in the return value');

/** every file under dir, recursively — bounded, symlink-free, so a hostile tree cannot spin this. */
function walkFiles(dir, out, depth) {
  out = out || []; depth = depth || 0;
  if (depth > 12) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out, depth + 1);
    else if (e.isFile()) out.push(p);
  }
  return out;
}
/** treeHits — where does `needle` appear on disk: in a file's NAME (a session id becomes a filename!) or
 *  in its BYTES. Returns human-readable locations so a failure says exactly where the secret landed. */
function treeHits(root, needle) {
  const hits = [];
  for (const f of walkFiles(root)) {
    const rel = path.relative(root, f);
    if (rel.includes(needle)) hits.push('FILENAME ' + rel);
    let body = '';
    try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (body.includes(needle)) hits.push('CONTENT ' + rel);
  }
  return hits;
}
function assertNotOnDisk(root, needle, label) {
  const hits = treeHits(root, needle);
  assert.strictEqual(hits.length, 0, label + ' — canary reached disk at: ' + hits.join(' | '));
}

t('H1 LEAK B1: a PowerShell assignment without spaces never lands on disk', () => {
  const root = tmpRoot('h1');
  const CANARY = 'hunter2CorrectHorseBatteryStaple';
  const r = runCli(JSON.stringify(payload({
    tool_name: 'Bash', tool_input: { command: '$pw="' + CANARY + '"; node login.js' },
  })), root, { CLAUDE_PROJECT_DIR: root });
  assert.strictEqual(r.status, 0, 'exit was ' + r.status + ' stderr=' + r.stderr);
  assertNotOnDisk(root, CANARY, 'PowerShell $var= assignment');
  const o = JSON.parse(readLines(logFile(root, 'sess1'))[0]);
  assert.strictEqual(o.target, 'node', 'the real executable must still be recorded, got ' + o.target);
});

t('H2 LEAK B2: $env:NAME="..." (the idiomatic PowerShell form) never lands on disk', () => {
  const root = tmpRoot('h2');
  const CANARY = 'hunter2CorrectHorseBatteryStaple';
  for (const cmd of [
    '$env:DB_PASSWORD="' + CANARY + '"; node login.js',
    '$env:DB_PASSWORD = "' + CANARY + '" ; node login.js',
    '$pw = \'' + CANARY + '\'; node login.js',
  ]) {
    const r = runCli(JSON.stringify(payload({ tool_name: 'Bash', tool_input: { command: cmd } })), root, { CLAUDE_PROJECT_DIR: root });
    assert.strictEqual(r.status, 0, 'exit was ' + r.status + ' stderr=' + r.stderr);
  }
  assertNotOnDisk(root, CANARY, 'PowerShell $env: assignment');
  const lines = readLines(logFile(root, 'sess1'));
  assert.strictEqual(lines.length, 3, 'expected 3 recorded calls, got ' + lines.length);
  for (const l of lines) assert.strictEqual(JSON.parse(l).target, 'node', 'lost the real executable: ' + l);
});

t('H3 LEAK X1: a secret used AS the executable name never lands on disk', () => {
  const root = tmpRoot('h3');
  const CANARY = 'hunter2CorrectHorseBatteryStaple';
  const r = runCli(JSON.stringify(payload({
    tool_name: 'Bash', tool_input: { command: './' + CANARY + '.sh --go' },
  })), root, { CLAUDE_PROJECT_DIR: root });
  assert.strictEqual(r.status, 0, 'exit was ' + r.status + ' stderr=' + r.stderr);
  assertNotOnDisk(root, CANARY, 'secret as the executable name');
  const o = JSON.parse(readLines(logFile(root, 'sess1'))[0]);
  assert.strictEqual(o.target, null, 'an unlisted executable must contribute no bytes, got ' + o.target);
  assert.strictEqual(o.target_kind, 'command-unlisted');
});

t('H4 LEAK X2: agent_type/permission_mode/tool_use_id/agent_id/tool are scrubbed like target', () => {
  const root = tmpRoot('h4');
  const C = {
    agent_type: 'sk-canaryAGENTTYPE0123456789xy',
    permission_mode: 'sk-canaryPERMMODE0123456789xy',
    tool_use_id: 'sk-canaryTOOLUSEID0123456789xy',
    agent_id: 'sk-canaryAGENTID0123456789xy',
    tool_name: 'sk-canaryTOOLNAME0123456789xy',
  };
  const r = runCli(JSON.stringify(payload(C)), root, { CLAUDE_PROJECT_DIR: root });
  assert.strictEqual(r.status, 0, 'exit was ' + r.status + ' stderr=' + r.stderr);
  for (const k of Object.keys(C)) assertNotOnDisk(root, C[k], 'field ' + k);
  const o = JSON.parse(readLines(logFile(root, 'sess1'))[0]);
  assert.ok(/REDACTED/.test(o.agent_type), 'agent_type not redacted: ' + o.agent_type);
  assert.ok(/REDACTED/.test(o.tool), 'tool not redacted: ' + o.tool);
});

t('H5 LEAK X5: a secret-shaped session_id never becomes a filename on disk', () => {
  const root = tmpRoot('h5');
  const CANARY = 'sk-canarySESSION0123456789xy';
  const r = runCli(JSON.stringify(payload({ session_id: CANARY })), root, { CLAUDE_PROJECT_DIR: root });
  assert.strictEqual(r.status, 0, 'exit was ' + r.status + ' stderr=' + r.stderr);
  assertNotOnDisk(root, CANARY, 'session_id used as the log filename');
  assert.ok(fs.existsSync(logFile(root, 'unknown-session')), 'the call must still be recorded, in a safe bucket');
});

t('H6 the scrub gate is at SERIALIZATION, so a field added tomorrow is covered automatically', () => {
  const CANARY = 'sk-canaryFUTUREFIELD0123456789';
  const s = hook.serialize({
    ts: '2026-08-01T00:00:00.000Z', session: 'sess1', tool: 'Read', target: null,
    target_kind: 'none', ok: true, ok_basis: 'present', ms: 1,
    some_field_invented_later: CANARY,
  });
  assert.ok(!s.includes(CANARY), 'an unknown field bypassed the scrubber: ' + s);
  assert.ok(/REDACTED/.test(s), 'expected the redaction marker in: ' + s);
});

// ---- I. owner setting `tool-log` (forge-config.cjs, v2.7.0) ----
console.log('\nI) owner setting tool-log — OFF writes nothing; ON / module absent = unchanged');

function writeConfig(root, settings) {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings }, null, 2));
}
const toollogDir = (root) => path.join(root, '.claude', 'forge-runs', '_toollog');

t('I1 tool-log=false -> skipped with the owner-config reason; no ledger dir, no diagnostics file', () => {
  const root = tmpRoot('i1');
  writeConfig(root, { 'tool-log': { value: false } });
  const r = hook.run(JSON.stringify(payload()), { root });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.wrote, false);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'owner config tool-log=off');
  assert.ok(!fs.existsSync(toollogDir(root)), 'the ledger directory was created');
  assert.ok(!fs.existsSync(path.join(root, '.claude', '.forge-toolhook.log')), 'a diagnostics file was written');
});

t('I2 tool-log=true -> the unchanged behaviour (one line written)', () => {
  const root = tmpRoot('i2');
  writeConfig(root, { 'tool-log': { value: true } });
  const r = hook.run(JSON.stringify(payload()), { root });
  assert.strictEqual(r.wrote, true);
  assert.strictEqual(readLines(logFile(root, 'sess1')).length, 1);
});

t('I3 no settings file -> the schema default (ON): the line is written exactly as before', () => {
  const root = tmpRoot('i3');
  const r = hook.run(JSON.stringify(payload()), { root });
  assert.strictEqual(r.wrote, true);
  assert.strictEqual(r.skipped, undefined);
});

t('I4 config module absent (null) or throwing -> schema default ON, even when a file says OFF', () => {
  for (const configModule of [null, { get() { throw new Error('boom'); } }]) {
    const root = tmpRoot('i4');
    writeConfig(root, { 'tool-log': { value: false } });
    const r = hook.run(JSON.stringify(payload()), { root, configModule });
    assert.strictEqual(r.wrote, true);
  }
});

t('I4b M3: a malformed FORGE_CONFIG.json -> ledger stays ON (no data flag) and the result carries a one-line config_note', () => {
  const root = tmpRoot('i4b');
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), '{ not json');
  const r = hook.run(JSON.stringify(payload()), { root });
  assert.strictEqual(r.wrote, true);
  assert.ok(/damaged/.test(r.config_note || '') && !/\n/.test(r.config_note), 'config_note: ' + r.config_note);
  const fine = tmpRoot('i4b-fine');
  writeConfig(fine, { 'tool-log': { value: true } });
  assert.strictEqual(hook.run(JSON.stringify(payload()), { root: fine }).config_note, undefined);
});

t('I5 configOn ignores a wrong-typed value and honours a real boolean', () => {
  assert.strictEqual(hook.configOn('tool-log', true, { configModule: { get: () => ({ value: 'no' }) } }), true);
  assert.strictEqual(hook.configOn('tool-log', true, { configModule: { get: () => ({ value: false }) } }), false);
});

const OFF_BUDGET_MS = Number(process.env.FORGE_HOOK_OFF_BUDGET_MS) || 500;
t('I6 CLI OFF path (FORGE_PROJECT_ROOT fixture): exit 0, empty stdout/stderr, no ledger, best of 3 under ' + OFF_BUDGET_MS + ' ms', () => {
  const fixture = tmpRoot('i6-fixture');
  writeConfig(fixture, { 'tool-log': { value: false } });
  const acting = tmpRoot('i6-acting');
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const r = runCli(JSON.stringify(payload()), acting, { CLAUDE_PROJECT_DIR: acting, FORGE_PROJECT_ROOT: fixture });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(r.stderr, '');
  }
  assert.ok(!fs.existsSync(toollogDir(acting)) && !fs.existsSync(toollogDir(fixture)), 'a ledger was written on the OFF path');
  times.sort((a, b) => a - b);
  console.log('       OFF-path timings ms: ' + times.map((x) => x.toFixed(0)).join(', '));
  assert.ok(times[0] < OFF_BUDGET_MS, 'fastest OFF run took ' + times[0].toFixed(0) + ' ms (budget ' + OFF_BUDGET_MS + ' ms; override FORGE_HOOK_OFF_BUDGET_MS on a slow runner)');
});

try { fs.rmSync(CONFIG_HOME, { recursive: true, force: true }); } catch { /* temp cleanup is best effort */ }

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
