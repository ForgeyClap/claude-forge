// feat-chatruns-tabs: chat-runs.mjs — real dashboard-CHAT "runs" derived from the existing
// conversation store. Every test writes real conversation records via conversations.mjs's own
// production functions (never a hand-rolled fixture file) and reads them back through
// `listChatRuns()`, mirroring this project's own `redact-turn-artifacts.test.mjs` convention of
// exercising the store's real write path directly rather than only through the HTTP layer.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  appendUserTurn,
  appendAssistantTurn,
  appendConversationEvent,
  readConversation,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import {
  startExecution,
  isConversationBusy,
  _setExecTimeoutMsForTests,
  _resetExecBridgeForTests,
} from '../src/exec-bridge.mjs';
import { listChatRuns } from '../src/chat-runs.mjs';

let tempDir;
const execCwd = os.tmpdir();

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-runs-test-'));
  _setConversationsDirForTests(tempDir);
});

after(() => {
  delete process.env.CC_EXEC_MOCK;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  _resetConversationsForTests();
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

test('a completed execution becomes a real, readable chat-run with its own real fields', () => {
  const conv = createConversation({ project: 'demo-project' });
  const { turnId, requestId } = appendUserTurn(conv.id, 'Build a landing page for LittleBazzar please');
  appendAssistantTurn(conv.id, {
    turn_id: turnId,
    request_id: requestId,
    text: 'Done.',
    cost_usd: 0.002,
    duration_ms: 4200,
    stop_reason: 'end_turn',
    exit_code: 0,
    model: 'claude-opus-5',
    input_tokens: 120,
    output_tokens: 340,
    file_edits: [{ tool: 'Write', file_path: '/proj/index.html', content: '<html></html>' }],
    todos: [
      { content: 'Draft the hero section', status: 'completed', activeForm: 'Drafting the hero section' },
      { content: 'Wire the contact form', status: 'in_progress', activeForm: 'Wiring the contact form' },
    ],
  });

  const runs = listChatRuns('demo-project');
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.run_id, 'chat-' + conv.id + '-' + turnId);
  assert.equal(run.status, 'completed');
  assert.equal(run.title, 'Build a landing page for LittleBazzar please');
  assert.equal(run.model, 'claude-opus-5');
  assert.equal(run.input_tokens, 120);
  assert.equal(run.output_tokens, 340);
  assert.equal(run.stop_reason, 'end_turn');
  assert.equal(run.file_edits.length, 1);
  // feat-chatrun-diff: the projection now also passes through the before/after text the capture
  // layer already stored (see chat-runs.mjs's own `toFileEditRow` comment). A Write has no
  // "before", so old_string/new_string stay honestly null. Full coverage of the widened shape —
  // including the diff budget and the redaction proof — lives in `chat-runs-diff.test.mjs`.
  assert.deepEqual(run.file_edits[0], {
    tool: 'Write',
    file_path: '/proj/index.html',
    old_string: null,
    new_string: null,
    content: '<html></html>',
    diff_state: 'present',
  });
  assert.equal(run.todos.length, 2);
  assert.equal(run.todos[0].status, 'completed');
  assert.equal(run.todos[1].status, 'in_progress');
  assert.ok(run.started_at);
  assert.ok(run.ended_at);
});

test('a project with no chat activity at all reads back an empty list, never fabricated', () => {
  assert.deepEqual(listChatRuns('a-project-nobody-ever-chatted-in'), []);
});

test('an unknown/empty project name is rejected honestly, never throws', () => {
  assert.deepEqual(listChatRuns(''), []);
  assert.deepEqual(listChatRuns(undefined), []);
});

test('geen executie -> geen run: a send that never started (execution_not_started) is never shown as a run', () => {
  const conv = createConversation({ project: 'demo-project-2' });
  const { turnId, requestId } = appendUserTurn(conv.id, 'Do something while the gateway is at capacity');
  appendConversationEvent(conv.id, {
    turn_id: turnId,
    request_id: requestId,
    kind: 'execution_not_started',
    data: { reason: 'gateway-wide execution limit reached (3 running)' },
  });

  assert.deepEqual(listChatRuns('demo-project-2'), []);
});

test('an ambiguous send (no assistant turn, not busy, no execution_not_started event) is never fabricated as a run either', () => {
  const conv = createConversation({ project: 'demo-project-3' });
  appendUserTurn(conv.id, 'orphaned send'); // no matching assistant turn, no event, not busy
  assert.deepEqual(listChatRuns('demo-project-3'), []);
});

test('a currently-running execution with NO tool activity yet is a real, honestly-EMPTY "running" chat-run', async () => {
  const conv = createConversation({ project: 'demo-project-4' });
  process.env.CC_EXEC_MOCK_DELAY_MS = '300';
  const { turnId } = appendUserTurn(conv.id, 'Still working on this one');
  const start = startExecution({ convId: conv.id, turnId, requestId: 'req-running', text: 'still working', cwd: execCwd });
  assert.equal(start.started, true);

  const runningRuns = listChatRuns('demo-project-4');
  assert.equal(runningRuns.length, 1);
  assert.equal(runningRuns[0].status, 'running');
  assert.equal(runningRuns[0].ended_at, null);
  // No __MOCK_TOOLS__/__MOCK_HANG_AFTER_TOOLS__ marker in the prompt text -> the mock child never
  // emits a single todo_snapshot/file_edit event for this turn, so a genuinely empty list is the
  // honest answer here (proven by the DEDICATED live-activity test right below, which uses the same
  // mechanism but WITH real tool activity and asserts real, non-empty todos/file_edits instead).
  assert.deepEqual(runningRuns[0].todos, []);
  assert.deepEqual(runningRuns[0].file_edits, []);

  // Let the mock child actually finish so it never leaks a live process into a later test file.
  const done = await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant'));
  assert.ok(done, 'the mock child must exit within the timeout');
  assert.equal(listChatRuns('demo-project-4')[0].status, 'completed');
});

// fix-run-visibility (owner screenshot: the Tasks tab said "2 tasks" but every visible column read
// "Nothing in this column") — a currently-running execution must show its REAL, live tool activity,
// not an honest-but-useless empty placeholder just because the turn has not closed yet.
test('LIVE: a currently-running execution shows its REAL live todos/file_edits, not an empty placeholder', async () => {
  // Bounds the hang: real headroom for the mock to write its tool-activity lines (system/assistant-
  // with-tools/tool_result — same shape exec-bridge.test.mjs's own TIMEOUT+LIVE-ACTIVITY test relies
  // on), then the gateway's own wall-clock timeout frees the busy slot on its own — no leaked process.
  _setExecTimeoutMsForTests(400);
  const conv = createConversation({ project: 'demo-project-live' });
  const { turnId } = appendUserTurn(conv.id, 'Building with real tool activity, still running');
  const start = startExecution({
    convId: conv.id,
    turnId,
    requestId: 'req-live-running',
    text: '__MOCK_HANG_AFTER_TOOLS__ build the site then hang',
    cwd: execCwd,
  });
  assert.equal(start.started, true);

  // Deterministic wait for the real live event to land on disk — never a fixed-sleep guess.
  const gotLiveTodoEvent = await waitUntil(() => readConversation(conv.id).events.some((e) => e.kind === 'todo_snapshot'));
  assert.ok(gotLiveTodoEvent, 'the mock child must have written its live todo_snapshot event by now');

  const runningRuns = listChatRuns('demo-project-live');
  assert.equal(runningRuns.length, 1);
  assert.equal(runningRuns[0].status, 'running');
  assert.equal(runningRuns[0].ended_at, null);
  assert.deepEqual(runningRuns[0].todos, [
    { content: 'Do the mock thing', status: 'in_progress', activeForm: 'Doing the mock thing' },
    { content: 'Do the next mock thing', status: 'pending', activeForm: 'Doing the next mock thing' },
  ]);
  // feat-chatrun-diff: the LIVE path carries the same widened shape as the closed-turn path — the
  // mock child's own real Edit/Write tool_use blocks include before/after text, and it reaches the
  // running run's rows through the exact same `toFileEditRow` projection.
  assert.deepEqual(runningRuns[0].file_edits, [
    {
      tool: 'Edit',
      file_path: '/mock/project/file.txt',
      old_string: 'old line',
      new_string: 'new line',
      content: null,
      diff_state: 'present',
    },
    {
      tool: 'Write',
      file_path: '/mock/project/new-file.txt',
      old_string: null,
      new_string: null,
      content: 'brand new file contents',
      diff_state: 'present',
    },
  ]);

  // Let the gateway's own wall-clock timeout naturally free the busy slot so this test never leaks
  // a hung mock child into a later test file.
  const freed = await waitUntil(() => !isConversationBusy(conv.id), { timeoutMs: 3000 });
  assert.ok(freed, 'the timeout must eventually free the busy slot on its own');
});

test('a timed-out execution is a real, readable chat-run with status "timed_out" (mirrors exec-bridge.mjs\'s real timeout write)', () => {
  const conv = createConversation({ project: 'demo-project-5' });
  const { turnId, requestId } = appendUserTurn(conv.id, 'A very long task that will not finish in time');
  const timeoutMs = 1_800_000;
  appendConversationEvent(conv.id, { turn_id: turnId, request_id: requestId, kind: 'timed_out', data: { timeout_ms: timeoutMs } });
  appendAssistantTurn(conv.id, {
    turn_id: turnId,
    request_id: requestId,
    text: 'partial progress before the timeout',
    cost_usd: null,
    duration_ms: timeoutMs,
    stop_reason: 'timed_out',
    exit_code: null,
    error: 'execution exceeded the ' + timeoutMs + 'ms wall-clock timeout and was terminated',
    stderr: null,
  });

  const runs = listChatRuns('demo-project-5');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'timed_out');
  assert.equal(runs[0].stop_reason, 'timed_out');
  assert.equal(runs[0].duration_ms, timeoutMs);
  assert.equal(runs[0].model, null); // exec-bridge's timeout path never reports usage/model — honest absence
});

test('multiple sends in the SAME conversation are multiple distinct chat-runs, each with its own real title/status', () => {
  const conv = createConversation({ project: 'demo-project-6' });
  const first = appendUserTurn(conv.id, 'First real task for this project');
  appendAssistantTurn(conv.id, { turn_id: first.turnId, request_id: first.requestId, text: 'ok', stop_reason: 'end_turn', exit_code: 0 });
  const second = appendUserTurn(conv.id, 'Second, unrelated real task');
  appendAssistantTurn(conv.id, { turn_id: second.turnId, request_id: second.requestId, text: 'ok too', stop_reason: 'end_turn', exit_code: 0 });

  const runs = listChatRuns('demo-project-6');
  assert.equal(runs.length, 2);
  const titles = runs.map((r) => r.title).sort();
  assert.deepEqual(titles, ['First real task for this project', 'Second, unrelated real task'].sort());
  assert.notEqual(runs[0].run_id, runs[1].run_id);
});

test('a model-reported error (is_error:true path) reads back as a real "failed" chat-run', () => {
  const conv = createConversation({ project: 'demo-project-7' });
  const { turnId, requestId } = appendUserTurn(conv.id, 'Try something that the model reports failing');
  appendAssistantTurn(conv.id, {
    turn_id: turnId,
    request_id: requestId,
    text: 'could not complete this',
    stop_reason: 'end_turn',
    exit_code: 0,
    error: 'the model reported is_error:true',
  });

  const runs = listChatRuns('demo-project-7');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
});

test('a conversation belonging to a DIFFERENT project is never mixed into this project\'s chat-runs', () => {
  const other = createConversation({ project: 'some-other-project' });
  const { turnId, requestId } = appendUserTurn(other.id, 'Task for a different project entirely');
  appendAssistantTurn(other.id, { turn_id: turnId, request_id: requestId, text: 'done', stop_reason: 'end_turn', exit_code: 0 });

  assert.deepEqual(listChatRuns('demo-project-8-nobody-used'), []);
});

test('DESIGN/SECURITY: listChatRuns never writes anything of its own — no file changes, no new store directory', () => {
  const filesBefore = fs.readdirSync(tempDir).sort();
  for (let i = 0; i < 5; i++) listChatRuns('demo-project');
  const filesAfter = fs.readdirSync(tempDir).sort();
  assert.deepEqual(filesAfter, filesBefore, 'listChatRuns must never create/remove any file under the conversations store');
  // The design rule this WP's own header documents: no sibling "chat-runs" directory is ever
  // created anywhere near the conversation store root.
  assert.equal(fs.existsSync(path.join(path.dirname(tempDir), 'chat-runs')), false);
  assert.equal(fs.existsSync(path.join(tempDir, 'chat-runs')), false);
});
