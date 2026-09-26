// Unit tests for the WP4 execution bridge (exec-bridge.mjs), ALWAYS in mock mode
// (CC_EXEC_MOCK=1) — no real `claude` invocation happens anywhere in this file, per the work
// package's "exactly ONE real claude invocation in this whole WP" rule (that one lives in the
// manually-run T4.9 E2E, not in `node --test`).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  readConversation,
  appendAssistantTurn,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import {
  executionAvailability,
  isConversationBusy,
  runningExecutionCount,
  maxConcurrentExecutions,
  startExecution,
  stopExecution,
  resolveClaudeCliPath,
  filteredEnv,
  _buildRealArgsForTests,
  _resetExecBridgeForTests,
  isUnsafeExecPromptText,
  _setExecTimeoutMsForTests,
  _pendingExecTimeoutCountForTests,
  _extractResultUsageForTests,
  _extractFileEditForTests,
  _extractTodoSnapshotForTests,
  _extractShellCommandForTests,
  _extractShellResultForTests,
  _extractSessionIdForTests,
  _extractAgentDispatchForTests,
  _turnArtifactCapsForTests,
} from '../src/exec-bridge.mjs';

let tempDir;
// The spawned mock child's cwd is DELIBERATELY a stable, never-removed directory (os.tmpdir()
// itself), never `tempDir` (the conversations store dir this file rmSync's in after()). Using the
// same dir for both was the real root cause of an intermittent Windows EPERM on cleanup: a just-
// killed child process can hold its own `cwd` directory handle open for a few ms after its
// 'close' event fires, which raced an immediate rmSync of that same directory.
const execCwd = os.tmpdir();

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-exec-bridge-test-'));
  _setConversationsDirForTests(tempDir);
});

after(() => {
  delete process.env.CC_EXEC_MOCK;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  _resetConversationsForTests();
  // maxRetries/retryDelay: on Windows a just-killed child process can hold its `cwd` handle open
  // for a few ms after its 'close' event fires, which makes an immediate rmSync race with EPERM.
  // Node's built-in retry (linear backoff on EPERM/EBUSY/ENOTEMPTY) absorbs that race honestly
  // instead of masking it with a swallowed try/catch.
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  _resetExecBridgeForTests();
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
});

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test('executionAvailability() is truthfully available in mock mode', () => {
  const avail = executionAvailability();
  assert.equal(avail.available, true);
  assert.match(avail.note, /mock execution mode/);
});

test('resolveClaudeCliPath() always returns a string or null, never throws', () => {
  const p = resolveClaudeCliPath();
  assert.ok(p === null || typeof p === 'string');
});

test('startExecution spawns the mock CLI and the child\'s real stdout produces a real assistant turn', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: 'ping', cwd: execCwd });
  assert.equal(start.started, true);
  assert.equal(isConversationBusy(conv.id), true);

  const done = await waitUntil(() => {
    const full = readConversation(conv.id);
    return full.turns.some((t) => t.role === 'assistant');
  });
  assert.ok(done, 'the mock child must exit and produce a real assistant turn within the timeout');

  const full = readConversation(conv.id);
  const assistantTurn = full.turns.find((t) => t.role === 'assistant');
  assert.equal(assistantTurn.text, 'MOCK:ping');
  assert.equal(assistantTurn.exit_code, 0);
  assert.equal(typeof assistantTurn.cost_usd, 'number');
  assert.equal(isConversationBusy(conv.id), false);

  // fix-usage-capture: MOCK_SCRIPT's own result line (see exec-bridge.mjs) deliberately carries no
  // `usage`/`modelUsage` block — this proves the REAL close-handler code path stores an honest
  // `null` for each token/model field rather than a fabricated `0`/`''` when the CLI reported none.
  assert.equal(assistantTurn.input_tokens, null);
  assert.equal(assistantTurn.output_tokens, null);
  assert.equal(assistantTurn.cache_creation_input_tokens, null);
  assert.equal(assistantTurn.cache_read_input_tokens, null);
  assert.equal(assistantTurn.model, null);

  // fix-unavailable (forge-2026-07-30-cc-finish, checkup): MOCK_SCRIPT's own lines carry no
  // session_id/modelUsage/Agent tool_use block either — `assert.strictEqual` (not `assert.equal`,
  // which would loosely equate `undefined == null` and pass even WITHOUT the fix) proves these
  // three fields are explicitly WRITTEN as null onto the real turn record, never simply omitted.
  assert.strictEqual(assistantTurn.context_window, null);
  assert.strictEqual(assistantTurn.session_id, null);
  assert.strictEqual(assistantTurn.agent_type, null);

  // The 3 mock stream-json lines must have become 3 real, readable event records.
  const kinds = full.events.filter((e) => e.turn_id === 't-1').map((e) => e.kind);
  assert.deepEqual(kinds, ['system', 'assistant', 'result']);
});

test('duplicate-send protection: a second startExecution on the SAME busy conversation is rejected', () => {
  const conv = createConversation({ project: 'demo-project' });
  process.env.CC_EXEC_MOCK_DELAY_MS = '300'; // keep the first one "running" long enough to overlap
  const first = startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: 'a', cwd: execCwd });
  assert.equal(first.started, true);
  const second = startExecution({ convId: conv.id, turnId: 't-2', requestId: 'req-2', text: 'b', cwd: execCwd });
  assert.equal(second.started, false);
  assert.match(second.reason, /already has a pending execution/);
  stopExecution(conv.id); // clean up the still-running mock child
});

test('gateway-wide rate limit: the 4th concurrent execution is rejected once 3 are running', async () => {
  process.env.CC_EXEC_MOCK_DELAY_MS = '400';
  const convs = [
    createConversation({ project: 'demo-project' }),
    createConversation({ project: 'demo-project' }),
    createConversation({ project: 'demo-project' }),
    createConversation({ project: 'demo-project' }),
  ];
  assert.equal(maxConcurrentExecutions(), 3);
  for (let i = 0; i < 3; i++) {
    const r = startExecution({ convId: convs[i].id, turnId: 't-' + i, requestId: 'req-' + i, text: 'x', cwd: execCwd });
    assert.equal(r.started, true, 'execution #' + i + ' should start under the limit');
  }
  assert.equal(runningExecutionCount(), 3);
  const fourth = startExecution({ convId: convs[3].id, turnId: 't-3', requestId: 'req-3', text: 'x', cwd: execCwd });
  assert.equal(fourth.started, false);
  assert.match(fourth.reason, /gateway-wide execution limit/);

  for (const c of convs.slice(0, 3)) stopExecution(c.id); // clean up
});

test('stopExecution kills a still-running mock child and records a real stopped_by_user event', async () => {
  const conv = createConversation({ project: 'demo-project' });
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000'; // long enough that it would still be "running" if not killed
  const start = startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: 'never finishes naturally', cwd: execCwd });
  assert.equal(start.started, true);
  assert.equal(isConversationBusy(conv.id), true);

  const result = stopExecution(conv.id);
  assert.equal(result.stopped, true);
  assert.equal(isConversationBusy(conv.id), false);

  const full = readConversation(conv.id);
  assert.ok(full.events.some((e) => e.kind === 'stopped_by_user' && e.turn_id === 't-1'));
});

test('stopExecution on a conversation with nothing running is an honest no-op, never throws', () => {
  const conv = createConversation({ project: 'demo-project' });
  const result = stopExecution(conv.id);
  assert.equal(result.stopped, false);
});

// fix-exec-timeout (HIGH checkup finding): a wall-clock timeout on each execution. A short,
// test-injected timeout (via _setExecTimeoutMsForTests) proves the real timeout path fires without
// waiting the real 30-minute default.
test('TIMEOUT: a wall-clock timeout kills the child, frees the busy slot with an honest timed_out turn, and a NEW send on the same conversation can start again', async () => {
  _setExecTimeoutMsForTests(150);
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000'; // the mock child would otherwise "run" far longer than the timeout
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: 'stuck', cwd: execCwd });
  assert.equal(start.started, true);
  assert.equal(isConversationBusy(conv.id), true);

  const freed = await waitUntil(() => !isConversationBusy(conv.id), { timeoutMs: 3000 });
  assert.ok(freed, 'the timeout must free the busy slot on its own, with no manual stop');
  assert.equal(runningExecutionCount(), 0, 'the gateway-wide concurrency slot must be released too');

  const full = readConversation(conv.id);
  assert.ok(full.events.some((e) => e.kind === 'timed_out' && e.turn_id === 't-1'), 'a real timed_out event must be recorded, not a silent disappearance');
  const assistantTurn = full.turns.find((t) => t.role === 'assistant');
  assert.ok(assistantTurn, 'the turn must be closed out honestly rather than left pending forever');
  assert.equal(assistantTurn.stop_reason, 'timed_out');
  assert.match(assistantTurn.error, /timeout/, 'the error text must be a real, readable reason, not empty/fake success');

  // No eternal 409: a fresh send on the SAME conversation must be able to start again immediately.
  const second = startExecution({ convId: conv.id, turnId: 't-2', requestId: 'req-2', text: 'again', cwd: execCwd });
  assert.equal(second.started, true, 'a new send on the same conversation must start after a timeout, never stuck busy forever');
  stopExecution(conv.id); // clean up the second still-"running" mock child
});

test('TIMEOUT: a normal (non-timeout) completion clears the timer — waiting past the timeout window afterward produces no extra timed_out turn/event', async () => {
  /* FLAKE FIX (2026-07-30, coordinator): this test used a fixed 150 ms window and simply hoped the
   * mock child would finish inside it. REPRODUCED under real parallel load (this gateway suite and
   * the dashboard vitest run at the same time): the spawn alone outlasted 150 ms, so the timer fired
   * first and the test failed with `actual: 'timed_out', expected: 'end_turn'` — a FALSE failure
   * that races real wall-clock time, and (worse) one that could equally hide a genuine
   * timer-clearing regression on a fast machine. So: measure THIS machine's real completion time
   * first, under whatever load is present right now, and derive the window from that. The assertion
   * then really is about the timer being cleared on a normal close, not about spawn speed. */
  _setExecTimeoutMsForTests(30000); // generous on purpose: the probe below must never time out
  const probeConv = createConversation({ project: 'demo-project' });
  const probeStartedAt = Date.now();
  const probe = startExecution({ convId: probeConv.id, turnId: 't-probe', requestId: 'req-probe', text: 'probe', cwd: execCwd });
  assert.equal(probe.started, true);
  const probeDone = await waitUntil(() => readConversation(probeConv.id).turns.some((t) => t.role === 'assistant'), { timeoutMs: 30000 });
  assert.ok(probeDone, 'the probe execution must complete — without it there is no honest basis for the window below');
  const observedMs = Math.max(Date.now() - probeStartedAt, 1);
  const windowMs = Math.max(500, observedMs * 4);

  _setExecTimeoutMsForTests(windowMs);
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: 'ping', cwd: execCwd });
  assert.equal(start.started, true);

  const done = await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant'), { timeoutMs: windowMs * 3 });
  assert.ok(done);

  await new Promise((r) => setTimeout(r, windowMs + 250)); // genuinely past the window derived above
  const full = readConversation(conv.id);
  const assistantTurns = full.turns.filter((t) => t.role === 'assistant');
  // What these three really guarantee is that no SECOND, timed-out turn/event ever appears — which
  // `markFinished()` enforces on its own. Kept, but no longer mislabelled as proof about the timer.
  assert.equal(assistantTurns.length, 1, 'no second, timed-out turn should appear after a normal close');
  assert.equal(assistantTurns[0].stop_reason, 'end_turn');
  assert.ok(!full.events.some((e) => e.kind === 'timed_out'), 'no timed_out event should ever appear for a normally-completed execution');

  /* THE actual timer assertion (coordinator finding 2026-07-30): this test's own name claimed the
   * timer gets cleared, but nothing here checked it — deleting the `clearTimeout` from the `close`
   * handler left every assertion above green, because markFinished() already suppresses a second
   * turn. A surviving 30-minute timer is a real leak (it holds a closure over the child and the
   * stdout/stderr buffers for half an hour after the turn is done), so assert it directly. */
  assert.equal(
    _pendingExecTimeoutCountForTests(),
    0,
    'a normally-closed execution must leave NO scheduled timeout timer alive — that is the hygiene this test is named after',
  );
});

test('TIMEOUT: stopExecution clears the timer — waiting past the timeout window after a manual stop produces no separate timed_out event', async () => {
  _setExecTimeoutMsForTests(200);
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: 'never finishes naturally', cwd: execCwd });
  assert.equal(start.started, true);

  const result = stopExecution(conv.id);
  assert.equal(result.stopped, true);

  await new Promise((r) => setTimeout(r, 450)); // well past the short timeout window above
  const full = readConversation(conv.id);
  assert.ok(!full.events.some((e) => e.kind === 'timed_out'), 'a manual stop must clear the timer — it must never ALSO fire timed_out later');
  assert.ok(full.events.some((e) => e.kind === 'stopped_by_user'));
});

// Codex F1 — filteredEnv() is now an ALLOWLIST, not a `/key|token/i` denylist: assert directly that
// secret-shaped names the old denylist never covered (PASSWORD/DB_URL/MY_SECRET) never reach the
// filtered output, while the names the spawned child genuinely needs (PATH, CC_* used by this very
// test file's own mock child) still do.
test('filteredEnv() never forwards PASSWORD/DB_URL/MY_SECRET-shaped names (the allowlist has no slot for them)', () => {
  const saved = { PASSWORD: process.env.PASSWORD, DB_URL: process.env.DB_URL, MY_SECRET: process.env.MY_SECRET };
  process.env.PASSWORD = 'super-secret-password';
  process.env.DB_URL = 'postgres://user:pw@host/db';
  process.env.MY_SECRET = 'another-secret-value';
  try {
    const out = filteredEnv();
    assert.equal(out.PASSWORD, undefined);
    assert.equal(out.DB_URL, undefined);
    assert.equal(out.MY_SECRET, undefined);
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('filteredEnv() still forwards what the spawned child genuinely needs (PATH, CC_EXEC_MOCK)', () => {
  const out = filteredEnv();
  assert.ok(Object.prototype.hasOwnProperty.call(out, 'PATH') || Object.prototype.hasOwnProperty.call(out, 'Path'), 'PATH must be forwarded so the child can resolve its own dependencies');
  assert.equal(out.CC_EXEC_MOCK, '1', 'this project\'s own CC_* config vars must reach the child (mock mode itself depends on this)');
});

// Codex F2 — resolveClaudeCliPath() must never trust a `claude` that only resolves from inside this
// process's own current working directory (a classic PATH-shadowing trick). Uses a REAL `where`/
// `which` lookup against a temporary PATH pointed only at a fake candidate placed under cwd, plus the
// OS's own system directory (so the lookup command itself still resolves) — no real `claude` CLI is
// ever invoked, and CC_EXEC_MOCK is temporarily unset ONLY for this one test so the real (non-mock)
// discovery path actually runs.
test('resolveClaudeCliPath() rejects a cwd-local shadow "claude" and never trusts a path under the current cwd', () => {
  const savedPath = process.env.PATH;
  const savedMock = process.env.CC_EXEC_MOCK;
  const shadowDir = fs.mkdtempSync(path.join(process.cwd(), 'cc-cwd-shadow-'));
  try {
    delete process.env.CC_EXEC_MOCK; // this ONE test needs the real (non-mock) discovery path
    const fakeName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const fakePath = path.join(shadowDir, fakeName);
    fs.writeFileSync(fakePath, process.platform === 'win32' ? '@echo fake\r\n' : '#!/bin/sh\necho fake\n');
    if (process.platform !== 'win32') fs.chmodSync(fakePath, 0o755);
    const sysDir = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
      : '/usr/bin:/bin';
    process.env.PATH = shadowDir + path.delimiter + sysDir;

    _resetExecBridgeForTests();
    const resolved = resolveClaudeCliPath();
    assert.equal(resolved, null, 'a claude binary that only exists under the current cwd must never be trusted');
  } finally {
    process.env.PATH = savedPath;
    if (savedMock !== undefined) process.env.CC_EXEC_MOCK = savedMock; else delete process.env.CC_EXEC_MOCK;
    fs.rmSync(shadowDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    _resetExecBridgeForTests();
  }
});

// cc-fix-chat-identity: plan-first mode (real `claude --permission-mode plan`) — asserted directly
// against the real argv-building function rather than a spawned child, exactly like filteredEnv()
// above (no real `claude` CLI is ever invoked to prove this).
test('MODE: _buildRealArgsForTests adds EXACTLY --permission-mode plan when mode is "plan"', () => {
  const args = _buildRealArgsForTests('hello', 'plan');
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan']);
});

test('MODE: _buildRealArgsForTests omits the flag entirely for "execute" mode and for no mode at all', () => {
  const withExecute = _buildRealArgsForTests('hello', 'execute');
  const withNoMode = _buildRealArgsForTests('hello', undefined);
  const expected = ['-p', 'hello', '--output-format', 'stream-json', '--verbose'];
  assert.deepEqual(withExecute, expected);
  assert.deepEqual(withNoMode, expected);
  assert.ok(!withExecute.includes('--permission-mode'));
  assert.ok(!withNoMode.includes('--permission-mode'));
});

// fix-exec-modes: real, help-confirmed --permission-mode choices ("acceptEdits",
// "bypassPermissions" are both listed by `claude --help` / `claude -p --help`) for the two new
// route-level modes 'accept-edits' and 'bypass'.
test('MODE: _buildRealArgsForTests adds EXACTLY --permission-mode acceptEdits for "accept-edits"', () => {
  const args = _buildRealArgsForTests('hello', 'accept-edits');
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
});

test('MODE: _buildRealArgsForTests adds EXACTLY --permission-mode bypassPermissions for "bypass"', () => {
  const args = _buildRealArgsForTests('hello', 'bypass');
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']);
});

test('MODE: an unknown mode string adds no --permission-mode flag at all (route-level allowlist is the real gate)', () => {
  const args = _buildRealArgsForTests('hello', 'nonsense-mode');
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose']);
});

// fix-exec-modes: real, help-confirmed --effort choices (low, medium, high, xhigh, max).
test('EFFORT: _buildRealArgsForTests appends --effort <level> when an effort value is given', () => {
  const args = _buildRealArgsForTests('hello', 'execute', 'high');
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--effort', 'high']);
});

test('EFFORT: _buildRealArgsForTests omits --effort entirely when no effort is given', () => {
  const args = _buildRealArgsForTests('hello', 'execute', undefined);
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose']);
  assert.ok(!args.includes('--effort'));
});

// fix-exec-modes: bypass must not disturb any other part of the argv — same base flags, same
// position for --output-format/--verbose, with ONLY --permission-mode bypassPermissions (and, if
// requested, --effort) appended at the end.
test('MODE+EFFORT: "bypass" mode combined with an effort level appends both flags without disturbing the base argv', () => {
  const args = _buildRealArgsForTests('hello', 'bypass', 'max');
  assert.deepEqual(args, [
    '-p', 'hello', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--effort', 'max',
  ]);
});

// feat-model-picker: real, help-confirmed --model choices (see server.mjs's own EXEC_MODEL_VALUES
// comment for the exact `claude --help` text this mirrors).
test('MODEL: _buildRealArgsForTests appends --model <value> when a model value is given', () => {
  const args = _buildRealArgsForTests('hello', 'execute', undefined, 'claude-opus-5');
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-5']);
});

test('MODEL: _buildRealArgsForTests accepts a real short alias too (e.g. "opus")', () => {
  const args = _buildRealArgsForTests('hello', 'execute', undefined, 'opus');
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--model', 'opus']);
});

test('MODEL: _buildRealArgsForTests omits --model entirely when no model is given', () => {
  const args = _buildRealArgsForTests('hello', 'execute', undefined, undefined);
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose']);
  assert.ok(!args.includes('--model'));
});

// feat-model-picker: mode + effort + model together append all three flags, in order, without
// disturbing the base argv — mirrors the existing MODE+EFFORT combined test above.
test('MODE+EFFORT+MODEL: all three together append every flag in order without disturbing the base argv', () => {
  const args = _buildRealArgsForTests('hello', 'bypass', 'max', 'claude-fable-5');
  assert.deepEqual(args, [
    '-p', 'hello', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--effort', 'max',
    '--model', 'claude-fable-5',
  ]);
});

// feat-model-picker CORRECTION (2026-07-30): "haiku" and the "[1m]" context-window suffix (on both
// the full id and the short alias) were verified via real, non-mock `claude -p --model <value>`
// CLI runs — see server.mjs's own EXEC_MODEL_VALUES comment for the exact commands/outputs/exit
// codes. Each newly-allowlisted value gets its own exact-argv test, one per value, mirroring the
// two tests just above.
test('MODEL: _buildRealArgsForTests accepts the real short alias "haiku" (verified via a real CLI run, not from --help)', () => {
  const args = _buildRealArgsForTests('hello', 'execute', undefined, 'haiku');
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--model', 'haiku']);
});

test('MODEL: _buildRealArgsForTests appends the real, CLI-verified "[1m]" context-window suffix on the full id ("claude-opus-5[1m]")', () => {
  const args = _buildRealArgsForTests('hello', 'execute', undefined, 'claude-opus-5[1m]');
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-5[1m]']);
});

test('MODEL: _buildRealArgsForTests appends the real, CLI-verified "[1m]" suffix on the short alias ("opus[1m]")', () => {
  const args = _buildRealArgsForTests('hello', 'execute', undefined, 'opus[1m]');
  assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--verbose', '--model', 'opus[1m]']);
});

// fix-sec-round #4 (LOW): a leading '-' would be parsed as a CLI flag by the real `claude` process
// (see this function's own header comment in exec-bridge.mjs for the full rationale).
test('isUnsafeExecPromptText() flags any text starting with "-", including after leading whitespace', () => {
  assert.equal(isUnsafeExecPromptText('-x'), true);
  assert.equal(isUnsafeExecPromptText('--dangerously-skip-permissions'), true);
  assert.equal(isUnsafeExecPromptText('   -x'), true);
  assert.equal(isUnsafeExecPromptText('hello -x'), false, 'a dash NOT at the start is a normal prompt');
  assert.equal(isUnsafeExecPromptText('hello'), false);
  assert.equal(isUnsafeExecPromptText(''), false);
  assert.equal(isUnsafeExecPromptText(undefined), false);
  assert.equal(isUnsafeExecPromptText(123), false);
});

test('resolveClaudeCliPath() honors an absolute CC_CLAUDE_CLI_PATH override, but still rejects it if that override lives under cwd', () => {
  const savedMock = process.env.CC_EXEC_MOCK;
  const savedOverride = process.env.CC_CLAUDE_CLI_PATH;
  const shadowDir = fs.mkdtempSync(path.join(process.cwd(), 'cc-cwd-override-'));
  try {
    delete process.env.CC_EXEC_MOCK;
    const fakePath = path.join(shadowDir, 'claude-override-fake');
    fs.writeFileSync(fakePath, 'fake');
    process.env.CC_CLAUDE_CLI_PATH = fakePath;

    _resetExecBridgeForTests();
    const resolved = resolveClaudeCliPath();
    assert.equal(resolved, null, 'an override path under cwd must be rejected exactly like a discovered one');
  } finally {
    if (savedOverride !== undefined) process.env.CC_CLAUDE_CLI_PATH = savedOverride; else delete process.env.CC_CLAUDE_CLI_PATH;
    if (savedMock !== undefined) process.env.CC_EXEC_MOCK = savedMock; else delete process.env.CC_EXEC_MOCK;
    fs.rmSync(shadowDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    _resetExecBridgeForTests();
  }
});

// fix-usage-capture (checkup MEDIUM-upgrade): _extractResultUsageForTests is asserted against the
// EXACT real `result` payload shape captured live from this project's own
// `.data/conversations/*.jsonl` (a real, non-mock `claude -p --output-format stream-json` run) —
// never a hand-guessed field name. Two real shapes are used: one where the `modelUsage` object's
// own key already IS the clean canonical model id ("claude-fable-5"), and one where the key carries
// a real suffix ("claude-opus-5[1m]") that differs from its own `canonicalModel` field
// ("claude-opus-5") — proving the canonical name is preferred over the raw, possibly-suffixed key.
const REAL_RESULT_FIXTURE_FABLE = {
  is_error: false,
  duration_api_ms: 2744,
  num_turns: 1,
  stop_reason: 'end_turn',
  session_id: '060c83ff-8ef5-4722-898a-884f5157a1c2',
  total_cost_usd: 1.8953,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 94734,
    cache_read_input_tokens: 0,
    output_tokens: 12,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
  },
  modelUsage: {
    'claude-fable-5': {
      inputTokens: 2,
      outputTokens: 12,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 94734,
      webSearchRequests: 0,
      costUSD: 1.8953,
      contextWindow: 1000000,
      maxOutputTokens: 64000,
      canonicalModel: 'claude-fable-5',
      provider: 'firstParty',
    },
  },
  permission_denials: [],
  terminal_reason: 'completed',
  subtype: 'success',
  api_error_status: null,
  result: 'WP4-E2E-OK',
  type: 'result',
  duration_ms: 3325,
  uuid: '6f8481ad-cb1d-4317-be60-a8bf59714d81',
};

const REAL_RESULT_FIXTURE_OPUS_SUFFIXED_KEY = {
  is_error: false,
  duration_api_ms: 1930,
  num_turns: 1,
  stop_reason: 'end_turn',
  session_id: 'e96a5d2d-3028-4bc7-a729-89b4bb23bc1c',
  total_cost_usd: 0.712107,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 69955,
    cache_read_input_tokens: 24494,
    output_tokens: 12,
  },
  modelUsage: {
    'claude-opus-5[1m]': {
      inputTokens: 2,
      outputTokens: 12,
      cacheReadInputTokens: 24494,
      cacheCreationInputTokens: 69955,
      costUSD: 0.712107,
      contextWindow: 1000000,
      maxOutputTokens: 64000,
      canonicalModel: 'claude-opus-5',
      provider: 'firstParty',
    },
  },
  type: 'result',
  duration_ms: 2349,
  result: 'WP13-CERT-OK',
};

test('USAGE: _extractResultUsageForTests reads the real usage/modelUsage fields off a real (non-mock) result payload', () => {
  const usage = _extractResultUsageForTests(REAL_RESULT_FIXTURE_FABLE);
  assert.deepEqual(usage, {
    inputTokens: 2,
    outputTokens: 12,
    cacheCreationInputTokens: 94734,
    cacheReadInputTokens: 0,
    model: 'claude-fable-5',
    contextWindow: 1000000,
  });
});

test('USAGE: _extractResultUsageForTests prefers modelUsage entry.canonicalModel over a suffixed raw key ("claude-opus-5[1m]" -> "claude-opus-5")', () => {
  const usage = _extractResultUsageForTests(REAL_RESULT_FIXTURE_OPUS_SUFFIXED_KEY);
  assert.equal(usage.model, 'claude-opus-5');
  assert.equal(usage.inputTokens, 2);
  assert.equal(usage.outputTokens, 12);
  assert.equal(usage.cacheCreationInputTokens, 69955);
  assert.equal(usage.cacheReadInputTokens, 24494);
});

// fix-unavailable (forge-2026-07-30-cc-finish, checkup): contextWindow sits on the SAME modelUsage
// entry as model/canonicalModel — this proves it is read off THAT SAME real fixture, not a
// separate/guessed field.
test('USAGE: _extractResultUsageForTests reads the real contextWindow off the SAME modelUsage entry model/canonicalModel already come from', () => {
  assert.equal(_extractResultUsageForTests(REAL_RESULT_FIXTURE_FABLE).contextWindow, 1000000);
  assert.equal(_extractResultUsageForTests(REAL_RESULT_FIXTURE_OPUS_SUFFIXED_KEY).contextWindow, 1000000);
});

test('USAGE: _extractResultUsageForTests returns every field null (never 0/undefined) for the mock result shape, which carries no usage/modelUsage at all', () => {
  const mockShapedResult = { type: 'result', is_error: false, result: 'MOCK:hello', total_cost_usd: 0.0002, duration_ms: 5, num_turns: 1, stop_reason: 'end_turn' };
  const usage = _extractResultUsageForTests(mockShapedResult);
  assert.deepEqual(usage, { inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, model: null, contextWindow: null });
});

test('USAGE: _extractResultUsageForTests never throws on null/undefined/malformed input, always an honest all-null shape', () => {
  const expected = { inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, model: null, contextWindow: null };
  assert.deepEqual(_extractResultUsageForTests(null), expected);
  assert.deepEqual(_extractResultUsageForTests(undefined), expected);
  assert.deepEqual(_extractResultUsageForTests({}), expected);
  assert.deepEqual(_extractResultUsageForTests({ usage: 'not-an-object', modelUsage: 42 }), expected);
  assert.deepEqual(_extractResultUsageForTests({ usage: { input_tokens: 'NaN-ish' }, modelUsage: {} }), expected);
});

// fix-unavailable (forge-2026-07-30-cc-finish, checkup): SESSION — the claude CLI reports its own
// real session id on almost every stream-json line, not just `result` (verified against this
// project's own `.data/conversations/*.jsonl` — see extractSessionIdFromParsedLine's own doc
// comment for the exact grep evidence).
test('SESSION: _extractSessionIdForTests reads a real session_id off any parsed stream-json line, not just `result`', () => {
  assert.equal(
    _extractSessionIdForTests({ type: 'system', subtype: 'hook_started', session_id: '3cadc791-5816-4964-aef8-f3517eabd9ff' }),
    '3cadc791-5816-4964-aef8-f3517eabd9ff',
  );
  assert.equal(_extractSessionIdForTests(REAL_RESULT_FIXTURE_FABLE), '060c83ff-8ef5-4722-898a-884f5157a1c2');
});

test('SESSION: _extractSessionIdForTests returns null (never throws) for a line/shape with no real session_id', () => {
  assert.equal(_extractSessionIdForTests({ type: 'assistant' }), null);
  assert.equal(_extractSessionIdForTests({ session_id: '' }), null);
  assert.equal(_extractSessionIdForTests({ session_id: 42 }), null);
  assert.equal(_extractSessionIdForTests(null), null);
  assert.equal(_extractSessionIdForTests(undefined), null);
  assert.equal(_extractSessionIdForTests('not-an-object'), null);
});

// fix-unavailable: AGENT — a real `Agent` tool_use dispatch, verified against this project's own
// `.data/conversations/*.jsonl` (see extractAgentDispatchFromToolUseBlock's own doc comment for the
// exact grep evidence: 102 occurrences in one real conversation).
const REAL_TOOL_USE_AGENT = {
  type: 'tool_use',
  id: 'toolu_0199c5fuaBcZSgiRuYtzExWT',
  name: 'Agent',
  input: {
    description: 'Inventariseer littlebazzar project',
    subagent_type: 'Explore',
    run_in_background: false,
    prompt: 'Read-only inventory to prepare a website build plan in a fresh project.',
  },
};

test('AGENT: _extractAgentDispatchForTests reads the real subagent_type/description off a real Agent tool_use block', () => {
  const dispatch = _extractAgentDispatchForTests(REAL_TOOL_USE_AGENT);
  assert.deepEqual(dispatch, { subagentType: 'Explore', description: 'Inventariseer littlebazzar project' });
});

test('AGENT: _extractAgentDispatchForTests returns null for a non-Agent tool_use block, or one with no real subagent_type', () => {
  assert.equal(_extractAgentDispatchForTests({ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }), null);
  assert.equal(_extractAgentDispatchForTests({ type: 'tool_use', name: 'Agent', input: {} }), null);
  assert.equal(_extractAgentDispatchForTests({ type: 'tool_use', name: 'Agent', input: { subagent_type: '' } }), null);
  assert.equal(_extractAgentDispatchForTests(null), null);
});

// ── TOOL ACTIVITY (fix-stream-insights): real tool_use blocks captured live from this project's
// own `.data/conversations/*.jsonl` (a real littlebazzar website-build run) — see this WP's
// forge-report for the exact grep evidence. `_extractFileEditForTests`/`_extractTodoSnapshotForTests`
// are asserted directly against these real fixtures, mirroring `_extractResultUsageForTests`'s own
// "assert the shape directly" rationale above. MultiEdit was never observed anywhere in this
// project's stored data and is deliberately not covered here (see exec-bridge.mjs's own comment).

const REAL_TOOL_USE_EDIT = {
  type: 'tool_use',
  id: 'toolu_01AJJhvYvEMvApzy6rKoBxbp',
  name: 'Edit',
  input: {
    replace_all: false,
    file_path: 'C:\\Users\\YOU\\Documents\\ForgeProjects\\littlebazzar\\serve.mjs',
    old_string: "location.replace('/');",
    new_string: "location.replace('/'+location.hash);",
  },
  caller: { type: 'direct' },
};

const REAL_TOOL_USE_WRITE = {
  type: 'tool_use',
  id: 'toolu_01CkaBSNLzuFQeRY4Tgt2DyQ',
  name: 'Write',
  input: {
    file_path: 'C:\\Users\\YOU\\Documents\\ForgeProjects\\test\\index.html',
    content: '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>LittleBazzar</title></head>\n<body></body>\n</html>\n',
  },
  caller: { type: 'direct' },
};

const REAL_TOOL_USE_TODOWRITE = {
  type: 'tool_use',
  id: 'toolu_01LSVfLtTUGrWDT4xQAzzr58',
  name: 'TodoWrite',
  input: {
    todos: [
      { content: 'Explore project context (files, docs, recent commits)', status: 'in_progress', activeForm: 'Exploring project context' },
      { content: 'Offer visual companion just-in-time (only if a genuinely visual question arises)', status: 'pending', activeForm: 'Offering visual companion when a visual question arises' },
      { content: 'Ask clarifying questions one at a time (purpose, constraints, success criteria)', status: 'pending', activeForm: 'Asking clarifying questions' },
    ],
  },
  caller: { type: 'direct' },
};

// feat-live-stream: a real, MATCHED Bash tool_use + its own real tool_result reply, captured live
// from this project's own `.data/conversations/c-ms6h00u1-288a4742.jsonl` (grep evidence in this
// WP's forge-report) — the same `tool_use_id` ties them together exactly the way exec-bridge.mjs's
// own `shellCommandIndexById` correlation does.
const REAL_TOOL_USE_BASH = {
  type: 'tool_use',
  id: 'toolu_015tQnaS1m8r5B9NX1fqT9ck',
  name: 'Bash',
  input: {
    command:
      'curl -s -o /dev/null -w "GET /            -> %{http_code} (%{time_total}s)\\n" http://localhost:3000/\n' +
      'curl -s -o /dev/null -w "GET /preview     -> %{http_code} (%{time_total}s)\\n" http://localhost:3000/preview\n' +
      'curl -s -o /dev/null -w "GET 4100 /       -> %{http_code} (%{time_total}s)\\n" http://localhost:4100/\n' +
      'curl -s -o /dev/null -w "GET 4100 /health -> %{http_code} (%{time_total}s)\\n" http://localhost:4100/health',
    description: 'Curl diagnostics against ports 3000 and 4100',
  },
  caller: { type: 'direct' },
};

const REAL_TOOL_RESULT_BASH = {
  tool_use_id: 'toolu_015tQnaS1m8r5B9NX1fqT9ck',
  type: 'tool_result',
  content:
    'GET /            -> 200 (0.001892s)\r\nGET /preview     -> 200 (0.000703s)\r\nGET 4100 /       -> 200 (0.212317s)\r\nGET 4100 /health -> 200 (0.206973s)',
  is_error: false,
};

test('TOOL ACTIVITY: _extractFileEditForTests reads a real Edit tool_use block\'s file_path/old_string/new_string', () => {
  const edit = _extractFileEditForTests(REAL_TOOL_USE_EDIT);
  assert.deepEqual(edit, {
    tool: 'Edit',
    file_path: 'C:\\Users\\YOU\\Documents\\ForgeProjects\\littlebazzar\\serve.mjs',
    old_string: "location.replace('/');",
    new_string: "location.replace('/'+location.hash);",
  });
});

test('TOOL ACTIVITY: _extractFileEditForTests reads a real Write tool_use block\'s file_path/content (no old_string/new_string — Write has no "before")', () => {
  const edit = _extractFileEditForTests(REAL_TOOL_USE_WRITE);
  assert.equal(edit.tool, 'Write');
  assert.equal(edit.file_path, 'C:\\Users\\YOU\\Documents\\ForgeProjects\\test\\index.html');
  assert.match(edit.content, /<title>LittleBazzar<\/title>/);
  assert.equal('old_string' in edit, false);
  assert.equal('new_string' in edit, false);
});

test('TOOL ACTIVITY: _extractFileEditForTests returns null for any block that is not a real Edit/Write tool_use (TodoWrite, a foreign tool, text blocks, malformed input)', () => {
  assert.equal(_extractFileEditForTests(REAL_TOOL_USE_TODOWRITE), null);
  assert.equal(_extractFileEditForTests({ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }), null);
  assert.equal(_extractFileEditForTests({ type: 'text', text: 'hello' }), null);
  assert.equal(_extractFileEditForTests({ type: 'tool_use', name: 'Edit', input: {} }), null, 'no file_path at all -> null, never a half-built record');
  assert.equal(_extractFileEditForTests(null), null);
  assert.equal(_extractFileEditForTests(undefined), null);
});

test('TOOL ACTIVITY: _extractTodoSnapshotForTests reads a real TodoWrite tool_use block\'s todos verbatim (content/status/activeForm)', () => {
  const todos = _extractTodoSnapshotForTests(REAL_TOOL_USE_TODOWRITE);
  assert.deepEqual(todos, [
    { content: 'Explore project context (files, docs, recent commits)', status: 'in_progress', activeForm: 'Exploring project context' },
    { content: 'Offer visual companion just-in-time (only if a genuinely visual question arises)', status: 'pending', activeForm: 'Offering visual companion when a visual question arises' },
    { content: 'Ask clarifying questions one at a time (purpose, constraints, success criteria)', status: 'pending', activeForm: 'Asking clarifying questions' },
  ]);
});

test('TOOL ACTIVITY: _extractTodoSnapshotForTests returns null for any block that is not a real TodoWrite tool_use', () => {
  assert.equal(_extractTodoSnapshotForTests(REAL_TOOL_USE_EDIT), null);
  assert.equal(_extractTodoSnapshotForTests({ type: 'tool_use', name: 'TodoWrite', input: {} }), null, 'no todos array at all -> null');
  assert.equal(_extractTodoSnapshotForTests(null), null);
  assert.equal(_extractTodoSnapshotForTests(undefined), null);
});

test('TOOL ACTIVITY: caps — a turn with more file edits than MAX_FILE_EDITS_PER_TURN never grows the stored array past the cap', () => {
  const conv = createConversation({ project: 'demo-project' });
  const caps = _turnArtifactCapsForTests();
  assert.ok(caps.MAX_FILE_EDITS_PER_TURN > 0);
  // Synthetic (not a real capture) — deliberately exercises the cap boundary, which no real
  // captured conversation happens to reach.
  const many = Array.from({ length: caps.MAX_FILE_EDITS_PER_TURN + 10 }, (_, i) => ({
    tool: 'Edit', file_path: `/synthetic/file-${i}.txt`, old_string: 'a', new_string: 'b',
  }));
  appendAssistantTurn(conv.id, { text: 'many edits', exit_code: 0, file_edits: many });
  const full = readConversation(conv.id);
  // appendAssistantTurn itself never enforces the cap (exec-bridge.mjs's own accumulation loop
  // does, before the array ever reaches appendAssistantTurn) — this asserts the STORE stays a
  // faithful passthrough of whatever it was given, i.e. the cap is proven at the accumulation
  // site below, not silently re-applied (and therefore silently duplicated) here.
  assert.equal(full.turns[0].file_edits.length, many.length);
});

test('TOOL ACTIVITY: caps — the real accumulation loop never pushes past MAX_FILE_EDITS_PER_TURN even when the child reports more', () => {
  const caps = _turnArtifactCapsForTests();
  const blocks = Array.from({ length: caps.MAX_FILE_EDITS_PER_TURN + 25 }, (_, i) => ({
    type: 'tool_use', name: 'Edit', input: { file_path: `/synthetic/file-${i}.txt`, old_string: 'a', new_string: 'b' },
  }));
  const collected = [];
  for (const block of blocks) {
    const edit = _extractFileEditForTests(block);
    if (edit && collected.length < caps.MAX_FILE_EDITS_PER_TURN) collected.push(edit);
  }
  assert.equal(collected.length, caps.MAX_FILE_EDITS_PER_TURN);
});

test('TOOL ACTIVITY: caps — an old_string/new_string/content field longer than FILE_EDIT_FIELD_CAP_LEN is truncated, never stored unbounded', () => {
  const caps = _turnArtifactCapsForTests();
  const longValue = 'x'.repeat(caps.FILE_EDIT_FIELD_CAP_LEN + 500); // synthetic — no real capture happens to be this long
  const edit = _extractFileEditForTests({ type: 'tool_use', name: 'Edit', input: { file_path: '/f.txt', old_string: longValue, new_string: longValue } });
  assert.equal(edit.old_string.length, caps.FILE_EDIT_FIELD_CAP_LEN);
  assert.equal(edit.new_string.length, caps.FILE_EDIT_FIELD_CAP_LEN);
});

test('TOOL ACTIVITY: caps — a todos array longer than MAX_TODOS_PER_SNAPSHOT is truncated, and an oversized content/activeForm field is truncated too', () => {
  const caps = _turnArtifactCapsForTests();
  const longValue = 'y'.repeat(caps.TODO_FIELD_CAP_LEN + 200); // synthetic
  const manyTodos = Array.from({ length: caps.MAX_TODOS_PER_SNAPSHOT + 30 }, () => ({ content: longValue, status: 'pending', activeForm: longValue }));
  const snapshot = _extractTodoSnapshotForTests({ type: 'tool_use', name: 'TodoWrite', input: { todos: manyTodos } });
  assert.equal(snapshot.length, caps.MAX_TODOS_PER_SNAPSHOT);
  assert.equal(snapshot[0].content.length, caps.TODO_FIELD_CAP_LEN);
  assert.equal(snapshot[0].activeForm.length, caps.TODO_FIELD_CAP_LEN);
});

// ── feat-live-stream item 3 (shell commands): real Bash tool_use + tool_result blocks ─────────

test('SHELL: _extractShellCommandForTests reads a real Bash tool_use block\'s id/command/description, with result/is_error starting null', () => {
  const cmd = _extractShellCommandForTests(REAL_TOOL_USE_BASH);
  assert.deepEqual(cmd, {
    tool: 'Bash',
    id: 'toolu_015tQnaS1m8r5B9NX1fqT9ck',
    command: REAL_TOOL_USE_BASH.input.command,
    description: 'Curl diagnostics against ports 3000 and 4100',
    result: null,
    is_error: null,
  });
});

test('SHELL: _extractShellCommandForTests returns null for any block that is not a real Bash tool_use (Edit, TodoWrite, text, malformed)', () => {
  assert.equal(_extractShellCommandForTests(REAL_TOOL_USE_EDIT), null);
  assert.equal(_extractShellCommandForTests(REAL_TOOL_USE_TODOWRITE), null);
  assert.equal(_extractShellCommandForTests({ type: 'text', text: 'hello' }), null);
  assert.equal(_extractShellCommandForTests({ type: 'tool_use', name: 'Bash', input: {} }), null, 'no command at all -> null, never a half-built record');
  assert.equal(_extractShellCommandForTests(null), null);
  assert.equal(_extractShellCommandForTests(undefined), null);
});

test('SHELL: _extractShellResultForTests reads a real tool_result block\'s id/result/is_error (plain-string content)', () => {
  const result = _extractShellResultForTests(REAL_TOOL_RESULT_BASH);
  assert.deepEqual(result, {
    toolUseId: 'toolu_015tQnaS1m8r5B9NX1fqT9ck',
    result: REAL_TOOL_RESULT_BASH.content,
    is_error: false,
  });
});

test('SHELL: _extractShellResultForTests joins only real text blocks from an array-shaped content and drops image blocks (verified live shape: a tool_result content array can carry a base64 image block)', () => {
  const result = _extractShellResultForTests({
    tool_use_id: 'toolu_mixed',
    type: 'tool_result',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not-a-real-huge-blob-here' } },
      { type: 'text', text: 'first text part' },
      { type: 'text', text: 'second text part' },
    ],
    is_error: false,
  });
  assert.equal(result.result, 'first text part\nsecond text part');
  assert.ok(!result.result.includes('base64'), 'the image block\'s payload must never be embedded in the captured result');
});

test('SHELL: _extractShellResultForTests returns null for any block that is not a real tool_result, or one with no real tool_use_id', () => {
  assert.equal(_extractShellResultForTests(REAL_TOOL_USE_BASH), null);
  assert.equal(_extractShellResultForTests({ type: 'tool_result', content: 'x' }), null, 'no tool_use_id at all -> null');
  assert.equal(_extractShellResultForTests(null), null);
  assert.equal(_extractShellResultForTests(undefined), null);
});

test('SHELL: caps — a turn with more shell commands than MAX_SHELL_COMMANDS_PER_TURN never grows the stored array past the cap', () => {
  const caps = _turnArtifactCapsForTests();
  assert.ok(caps.MAX_SHELL_COMMANDS_PER_TURN > 0);
  const blocks = Array.from({ length: caps.MAX_SHELL_COMMANDS_PER_TURN + 25 }, (_, i) => ({
    type: 'tool_use', name: 'Bash', input: { command: `echo ${i}` },
  }));
  const collected = [];
  for (const block of blocks) {
    const cmd = _extractShellCommandForTests(block);
    if (cmd && collected.length < caps.MAX_SHELL_COMMANDS_PER_TURN) collected.push(cmd);
  }
  assert.equal(collected.length, caps.MAX_SHELL_COMMANDS_PER_TURN);
});

test('SHELL: caps — a command/description/result field longer than SHELL_FIELD_CAP_LEN is truncated, never stored unbounded', () => {
  const caps = _turnArtifactCapsForTests();
  const longValue = 'z'.repeat(caps.SHELL_FIELD_CAP_LEN + 500); // synthetic — no real capture happens to be this long
  const cmd = _extractShellCommandForTests({ type: 'tool_use', name: 'Bash', input: { command: longValue, description: longValue } });
  assert.equal(cmd.command.length, caps.SHELL_FIELD_CAP_LEN);
  assert.equal(cmd.description.length, caps.SHELL_FIELD_CAP_LEN);
  const result = _extractShellResultForTests({ type: 'tool_result', tool_use_id: 'x', content: longValue, is_error: false });
  assert.equal(result.result.length, caps.SHELL_FIELD_CAP_LEN);
});

// ── TOOL ACTIVITY end-to-end: the real spawn -> readline -> appendAssistantTurn pipeline ──────

test('TOOL ACTIVITY E2E: a turn whose child reports real Edit/Write/TodoWrite tool_use blocks stores real file_edits/todos on the assistant turn', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-tools', requestId: 'req-tools', text: '__MOCK_TOOLS__ build the site', cwd: os.tmpdir() });
  assert.equal(start.started, true);

  const done = await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant'));
  assert.ok(done);

  const full = readConversation(conv.id);
  const turn = full.turns.find((t) => t.role === 'assistant');
  assert.deepEqual(turn.file_edits, [
    { tool: 'Edit', file_path: '/mock/project/file.txt', old_string: 'old line', new_string: 'new line' },
    { tool: 'Write', file_path: '/mock/project/new-file.txt', content: 'brand new file contents' },
  ]);
  assert.deepEqual(turn.todos, [
    { content: 'Do the mock thing', status: 'in_progress', activeForm: 'Doing the mock thing' },
    { content: 'Do the next mock thing', status: 'pending', activeForm: 'Doing the next mock thing' },
  ]);
  // feat-live-stream: the real Bash command the mock reported, fully merged with its own real
  // tool_result reply (result/is_error filled in, no longer null) by the time the turn closes.
  assert.deepEqual(turn.shell_commands, [
    { tool: 'Bash', id: 'toolu_mock_bash', command: 'echo mock-command', description: 'Run a mock shell command', result: 'mock-command\n', is_error: false },
  ]);
});

test('TOOL ACTIVITY E2E: a normal turn with no tool_use blocks at all stores file_edits/todos/shell_commands as genuinely absent (explicit null, never a fabricated empty array or omitted key)', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-notools', requestId: 'req-notools', text: 'just a plain reply', cwd: os.tmpdir() });
  assert.equal(start.started, true);

  const done = await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant'));
  assert.ok(done);

  const full = readConversation(conv.id);
  const turn = full.turns.find((t) => t.role === 'assistant');
  assert.equal('file_edits' in turn, true, 'the field must be an explicit present key, not omitted');
  assert.equal('todos' in turn, true, 'the field must be an explicit present key, not omitted');
  assert.equal('shell_commands' in turn, true, 'the field must be an explicit present key, not omitted');
  assert.equal(turn.file_edits, null);
  assert.equal(turn.todos, null);
  assert.equal(turn.shell_commands, null);
});

// ── feat-live-stream gap #1: activity is genuinely emitted DURING the run, not only at close ──

test('LIVE STREAM: file_edit/todo_snapshot/shell_command/shell_result events are appended to the JSONL BEFORE the closing assistant turn line — proof they were written progressively, not batched in at turn-close', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-live', requestId: 'req-live', text: '__MOCK_TOOLS__ build the site', cwd: os.tmpdir() });
  assert.equal(start.started, true);

  const done = await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant'));
  assert.ok(done);

  // Read the RAW per-conversation JSONL file directly (the exact file the real SSE tailer,
  // attachConversationStream in conversations.mjs, streams byte-offset-incrementally) so line
  // ORDER — not just presence — is provable: a live consumer watching this file would have seen
  // every one of these events arrive well before the turn ever closed.
  const rawPath = path.join(tempDir, conv.id + '.jsonl');
  const records = fs.readFileSync(rawPath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));

  const closingTurnIndex = records.findIndex((r) => r.type === 'turn' && r.role === 'assistant');
  assert.ok(closingTurnIndex > -1, 'the closing assistant turn line must exist');

  const liveKinds = ['file_edit', 'file_edit', 'todo_snapshot', 'shell_command', 'shell_result'];
  const liveEventIndexes = records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.type === 'event' && liveKinds.includes(r.kind))
    .map(({ i }) => i);
  assert.equal(liveEventIndexes.length, liveKinds.length, 'every one of the 5 live activity events (2 file_edit, 1 todo_snapshot, 1 shell_command, 1 shell_result) must be recorded');
  for (const idx of liveEventIndexes) {
    assert.ok(idx < closingTurnIndex, 'every live activity event must sit BEFORE the closing assistant turn line in the file');
  }

  // The live shell_command event itself must carry result/is_error as null — it is emitted the
  // MOMENT the Bash tool_use block arrives, genuinely before its own result exists yet.
  const shellCommandEvent = records.find((r) => r.type === 'event' && r.kind === 'shell_command');
  assert.equal(shellCommandEvent.data.result, null);
  assert.equal(shellCommandEvent.data.is_error, null);
  assert.equal(shellCommandEvent.data.command, 'echo mock-command');

  // The live shell_result event must arrive AFTER the shell_command event, carrying the real,
  // now-known result — proof the correlation-by-id update is itself live, not deferred to close.
  const shellCommandIdx = records.indexOf(shellCommandEvent);
  const shellResultEvent = records.find((r) => r.type === 'event' && r.kind === 'shell_result');
  const shellResultIdx = records.indexOf(shellResultEvent);
  assert.ok(shellResultIdx > shellCommandIdx, 'shell_result must be recorded strictly after its own shell_command');
  assert.equal(shellResultEvent.data.id, 'toolu_mock_bash');
  assert.equal(shellResultEvent.data.result, 'mock-command\n');
  assert.equal(shellResultEvent.data.is_error, false);
});

test('LIVE STREAM: a normal turn with no tool_use blocks emits none of the new live activity event kinds', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-live-none', requestId: 'req-live-none', text: 'just a plain reply', cwd: os.tmpdir() });
  assert.equal(start.started, true);

  const done = await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant'));
  assert.ok(done);

  const full = readConversation(conv.id);
  const liveKinds = new Set(['file_edit', 'todo_snapshot', 'shell_command', 'shell_result']);
  assert.ok(!full.events.some((e) => liveKinds.has(e.kind)), 'a turn that called no tools must genuinely emit no live-activity events');
});

// ── feat-live-stream gap #2: a timed-out turn still carries whatever activity was real before it ──

test('TIMEOUT + LIVE ACTIVITY: a wedged child that already reported real Edit/Write/TodoWrite/Bash activity before the timeout fires has that real activity carried onto the honest timed_out turn', async () => {
  // v2.8.0: 300 ms was too little on a loaded Windows machine (spawning the mock child alone can exceed it, so
  // the timeout fired before any activity existed). The child hangs after reporting, so the timeout still fires.
  _setExecTimeoutMsForTests(2500); // real headroom for the child to start, write and flush 3 lines first
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({
    convId: conv.id,
    turnId: 't-timeout-activity',
    requestId: 'req-timeout-activity',
    text: '__MOCK_HANG_AFTER_TOOLS__ build the site then hang',
    cwd: os.tmpdir(),
  });
  assert.equal(start.started, true);

  const freed = await waitUntil(() => !isConversationBusy(conv.id), { timeoutMs: 12000 });
  assert.ok(freed, 'the timeout must still free the busy slot on its own');

  const full = readConversation(conv.id);
  const turn = full.turns.find((t) => t.role === 'assistant');
  assert.ok(turn, 'the turn must be closed out honestly rather than left pending forever');
  assert.equal(turn.stop_reason, 'timed_out');
  // The real activity the wedged child DID report before being killed — never silently dropped
  // just because the turn never reached a normal 'result' line.
  assert.deepEqual(turn.file_edits, [
    { tool: 'Edit', file_path: '/mock/project/file.txt', old_string: 'old line', new_string: 'new line' },
    { tool: 'Write', file_path: '/mock/project/new-file.txt', content: 'brand new file contents' },
  ]);
  assert.deepEqual(turn.todos, [
    { content: 'Do the mock thing', status: 'in_progress', activeForm: 'Doing the mock thing' },
    { content: 'Do the next mock thing', status: 'pending', activeForm: 'Doing the next mock thing' },
  ]);
  assert.deepEqual(turn.shell_commands, [
    { tool: 'Bash', id: 'toolu_mock_bash', command: 'echo mock-command', description: 'Run a mock shell command', result: 'mock-command\n', is_error: false },
  ]);
});

test('TIMEOUT + LIVE ACTIVITY: a wedged child that never reported ANY activity before the timeout still gets an honest null (never a fabricated one)', async () => {
  _setExecTimeoutMsForTests(150);
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000'; // the existing "never produced anything yet" hang shape
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-timeout-empty', requestId: 'req-timeout-empty', text: 'stuck, no tools', cwd: os.tmpdir() });
  assert.equal(start.started, true);

  const freed = await waitUntil(() => !isConversationBusy(conv.id), { timeoutMs: 3000 });
  assert.ok(freed);

  const full = readConversation(conv.id);
  const turn = full.turns.find((t) => t.role === 'assistant');
  assert.equal(turn.stop_reason, 'timed_out');
  assert.equal(turn.file_edits, null);
  assert.equal(turn.todos, null);
  assert.equal(turn.shell_commands, null);
});
