// feat-live-visibility (Gap B) — agent-dispatches.mjs: pure-function tests. Every event is written
// via conversations.mjs's own real `appendConversationEvent`, shaped EXACTLY like the real
// task_started/task_updated system events this project's own `.data/conversations/*.jsonl` files
// carry (live-verified, see agent-dispatches.mjs's own header) — never a hand-rolled shortcut shape.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  appendUserTurn,
  appendConversationEvent,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import { startExecution, isConversationBusy, _resetExecBridgeForTests } from '../src/exec-bridge.mjs';
import { listAgentDispatches } from '../src/agent-dispatches.mjs';

let tempDir;
const execCwd = os.tmpdir();

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-dispatches-test-'));
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
});

function taskStartedEvent(convId, { turnId, taskId, subagentType, description, taskType = 'local_agent' }) {
  appendConversationEvent(convId, {
    turn_id: turnId,
    request_id: 'req-' + taskId,
    kind: 'system',
    data: {
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: 'toolu_' + taskId,
      description,
      subagent_type: subagentType,
      task_type: taskType,
    },
  });
}

function taskUpdatedEvent(convId, { turnId, taskId, status = 'completed' }) {
  appendConversationEvent(convId, {
    turn_id: turnId,
    request_id: 'req-' + taskId,
    kind: 'system',
    data: { type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status, end_time: Date.now() } },
  });
}

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test('a real, RESOLVED subagent dispatch reads back as a real row with running:false', () => {
  const conv = createConversation({ project: 'demo-project' });
  const { turnId } = appendUserTurn(conv.id, 'Inventory this project please');
  taskStartedEvent(conv.id, { turnId, taskId: 'task-1', subagentType: 'Explore', description: 'Inventarise the project' });
  taskUpdatedEvent(conv.id, { turnId, taskId: 'task-1', status: 'completed' });

  const rows = listAgentDispatches('demo-project');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subagent_type, 'Explore');
  assert.equal(rows[0].conversation_id, conv.id);
  assert.equal(rows[0].description, 'Inventarise the project');
  assert.equal(rows[0].running, false);
  assert.equal(rows[0].resolved_status, 'completed');
  assert.ok(rows[0].ended_at);
});

test('a local_bash task_started (no subagent_type) is never reported as a subagent dispatch', () => {
  const conv = createConversation({ project: 'demo-project-bash' });
  const { turnId } = appendUserTurn(conv.id, 'Start the dev server in background');
  taskStartedEvent(conv.id, { turnId, taskId: 'task-bash-1', subagentType: undefined, description: 'Start local dev server', taskType: 'local_bash' });

  assert.deepEqual(listAgentDispatches('demo-project-bash'), []);
});

// A dedicated, independent proof of the task_type gate itself — distinct from the test above,
// which would ALSO pass on a subagent_type-only null-check with no task_type gate at all (real
// local_bash events never carry subagent_type in the first place). This fixture deliberately
// carries BOTH fields so only the task_type check can be the thing excluding it.
test('task_type gate: a non-local_agent task_started is excluded even if it carries a subagent_type field', () => {
  const conv = createConversation({ project: 'demo-project-nonagent-type' });
  const { turnId } = appendUserTurn(conv.id, 'Some other kind of tracked task');
  taskStartedEvent(conv.id, { turnId, taskId: 'task-weird-1', subagentType: 'Explore', description: 'not really a subagent', taskType: 'something_else' });

  assert.deepEqual(listAgentDispatches('demo-project-nonagent-type'), []);
});

test('an unresolved dispatch on a conversation that is NOT currently busy is honestly neither running nor completed', () => {
  const conv = createConversation({ project: 'demo-project-orphan' });
  const { turnId } = appendUserTurn(conv.id, 'A task that never reported back');
  taskStartedEvent(conv.id, { turnId, taskId: 'task-orphan-1', subagentType: 'Plan', description: 'Plan something' });
  // No task_updated event — and this conversation's own exec slot was never occupied by THIS test.
  assert.equal(isConversationBusy(conv.id), false);

  const rows = listAgentDispatches('demo-project-orphan');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].running, false);
  assert.equal(rows[0].resolved_status, null);
  assert.equal(rows[0].ended_at, null);
});

test('LIVE: an unresolved dispatch on a conversation that IS currently busy reads back running:true', async () => {
  process.env.CC_EXEC_MOCK_DELAY_MS = '400';
  const conv = createConversation({ project: 'demo-project-live' });
  const { turnId } = appendUserTurn(conv.id, 'Still dispatching a subagent');
  taskStartedEvent(conv.id, { turnId, taskId: 'task-live-1', subagentType: 'Explore', description: 'Still working' });

  const start = startExecution({ convId: conv.id, turnId, requestId: 'req-live', text: 'still working', cwd: execCwd });
  assert.equal(start.started, true);
  assert.equal(isConversationBusy(conv.id), true);

  const rows = listAgentDispatches('demo-project-live');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].resolved_status, null);

  // Let the mock child finish so it never leaks into a later test file.
  const done = await waitUntil(() => !isConversationBusy(conv.id));
  assert.ok(done, 'the mock child must exit within the timeout');
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
});

test('a dispatch on a DIFFERENT project is never mixed into this project\'s list', () => {
  const other = createConversation({ project: 'some-other-project' });
  const { turnId } = appendUserTurn(other.id, 'Task for a different project entirely');
  taskStartedEvent(other.id, { turnId, taskId: 'task-other-1', subagentType: 'Explore', description: 'x' });
  taskUpdatedEvent(other.id, { turnId, taskId: 'task-other-1' });

  assert.deepEqual(listAgentDispatches('demo-project-nobody-dispatched-in'), []);
});

test('a project with no chat activity at all reads back an empty list, never fabricated', () => {
  assert.deepEqual(listAgentDispatches('a-project-nobody-ever-chatted-in'), []);
});

test('an unknown/empty project name is rejected honestly, never throws', () => {
  assert.deepEqual(listAgentDispatches(''), []);
  assert.deepEqual(listAgentDispatches(undefined), []);
});

test('multiple resolved dispatches in one conversation are all reported, newest first', () => {
  const conv = createConversation({ project: 'demo-project-multi' });
  const { turnId } = appendUserTurn(conv.id, 'Do two things');
  taskStartedEvent(conv.id, { turnId, taskId: 'task-a', subagentType: 'Explore', description: 'first' });
  taskUpdatedEvent(conv.id, { turnId, taskId: 'task-a' });
  taskStartedEvent(conv.id, { turnId, taskId: 'task-b', subagentType: 'Plan', description: 'second' });
  taskUpdatedEvent(conv.id, { turnId, taskId: 'task-b' });

  const rows = listAgentDispatches('demo-project-multi');
  assert.equal(rows.length, 2);
  const types = rows.map((r) => r.subagent_type).sort();
  assert.deepEqual(types, ['Explore', 'Plan']);
});
