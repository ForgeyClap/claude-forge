// Unit tests for fix-ghost-asks item 4 (forge-2026-07-30-cc-finish, work package fix-ghost-asks) —
// pauseExecTimeoutForAsk / resumeExecTimeoutAfterAsk, the exec-lifecycle-internal half of the
// "two contradicting clocks" fix. ALWAYS in mock mode (CC_EXEC_MOCK=1), mirroring
// exec-bridge.test.mjs's own conventions exactly — these tests exercise the wall-clock deadline
// bookkeeping directly (via the `_...ForTests` introspection seams), not over HTTP; the HTTP-level
// abandon proof lives in routes-ask-abandon.test.mjs.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  readConversation,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import {
  startExecution,
  stopExecution,
  isConversationBusy,
  runningExecutionCount,
  pauseExecTimeoutForAsk,
  resumeExecTimeoutAfterAsk,
  _isExecTimeoutPausedForAskForTests,
  _execTimeoutRemainingMsForTests,
  _setExecTimeoutMsForTests,
  _resetExecBridgeForTests,
} from '../src/exec-bridge.mjs';
import { createAskRequest, getAskMeta, _setAskTimeoutMsForTests, _resetAskStoreForTests } from '../src/ask-store.mjs';

let tempDir;
const execCwd = os.tmpdir();

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-exec-ask-pause-test-'));
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
  _resetAskStoreForTests();
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

test('pauseExecTimeoutForAsk replaces a short exec deadline with the ask\'s own (longer) window, and _isExecTimeoutPausedForAskForTests reports true while paused', () => {
  _setExecTimeoutMsForTests(100);
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: 'x', cwd: execCwd });
  assert.equal(start.started, true);
  assert.equal(_isExecTimeoutPausedForAskForTests(conv.id), false);

  pauseExecTimeoutForAsk(conv.id, 10000);
  assert.equal(_isExecTimeoutPausedForAskForTests(conv.id), true);
  const remaining = _execTimeoutRemainingMsForTests(conv.id);
  assert.ok(remaining > 9000, 'the replacement deadline must reflect the ask\'s own window (~10000ms), not the original short exec budget (100ms): got ' + remaining);

  stopExecution(conv.id); // cleanup
});

test('resumeExecTimeoutAfterAsk restores the ORIGINAL remaining exec budget — never a fresh full window and never the ask-paused cap', async () => {
  _setExecTimeoutMsForTests(5000);
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  const conv = createConversation({ project: 'demo-project' });
  startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: 'x', cwd: execCwd });

  await new Promise((r) => setTimeout(r, 250)); // burn ~250ms of the original 5000ms budget
  pauseExecTimeoutForAsk(conv.id, 10000); // a much larger cap than what remains — must not leak in
  resumeExecTimeoutAfterAsk(conv.id);

  const remaining = _execTimeoutRemainingMsForTests(conv.id);
  // Expected ~ (5000 - 250) = 4750, give a generous scheduling-jitter margin on both sides.
  assert.ok(remaining > 4000 && remaining < 5000, 'resume must restore roughly the ORIGINAL remaining budget (~4750ms here), not the 10000ms ask cap and not a fresh 5000ms: got ' + remaining);

  stopExecution(conv.id); // cleanup
});

test('the paused replacement timer really is capped: a genuinely un-resumed pause still reaps the child at its OWN capped duration (never the stale original budget, never unbounded)', async () => {
  _setExecTimeoutMsForTests(100);
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  const conv = createConversation({ project: 'demo-project' });
  startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: 'x', cwd: execCwd });
  pauseExecTimeoutForAsk(conv.id, 300);

  // Still alive well past the ORIGINAL 100ms budget — proof the pause genuinely took effect.
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(isConversationBusy(conv.id), true, 'a paused execution must survive past its pre-pause deadline');

  const freed = await waitUntil(() => !isConversationBusy(conv.id), { timeoutMs: 3000 });
  assert.ok(freed, 'the capped replacement timer must still eventually reap the child — a pause is never unbounded');
  assert.equal(runningExecutionCount(), 0);

  const full = readConversation(conv.id);
  const timedOutEvt = full.events.find((e) => e.kind === 'timed_out');
  assert.ok(timedOutEvt, 'a real timed_out event must be recorded');
  assert.equal(timedOutEvt.data.timeout_ms, 300, 'the recorded duration must be the ask-capped 300ms, never the stale original 100ms');
});

test('pauseExecTimeoutForAsk/resumeExecTimeoutAfterAsk on a conversation with NO running execution are honest no-ops, never throw', () => {
  assert.doesNotThrow(() => pauseExecTimeoutForAsk('c-does-not-exist', 1000));
  assert.doesNotThrow(() => resumeExecTimeoutAfterAsk('c-does-not-exist'));
  assert.equal(_isExecTimeoutPausedForAskForTests('c-does-not-exist'), null);
  assert.equal(_execTimeoutRemainingMsForTests('c-does-not-exist'), null);
});

// The real end-to-end tie-in: a genuine ask-store.mjs pending ask (created directly, bypassing
// HTTP — mirrors exec-bridge.test.mjs's own "call the real function, not the route" convention),
// abandoned by the SAME capped, paused exec timeout once it fires — proving items 1 and 4 compose
// correctly (the ask is closed out with reason execution_timed_out, not left dangling and not
// confused with ask-store's OWN much-longer internal timeout).
test('INTEGRATION: a real pending ask is abandoned (reason execution_timed_out) when the paused-and-capped exec timeout fires, never confused with ask-store\'s own internal timeout', async () => {
  _setAskTimeoutMsForTests(10 * 60 * 1000); // ask-store's OWN timer must not be what fires here
  _setExecTimeoutMsForTests(100);
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  const conv = createConversation({ project: 'demo-project' });
  startExecution({ convId: conv.id, turnId: 't-1', requestId: 'req-1', text: 'x', cwd: execCwd });

  const created = createAskRequest({ convId: conv.id, turnId: 't-1', requestId: 'req-1', questions: [{ question: 'Q' }] });
  assert.equal(created.ok, true);
  pauseExecTimeoutForAsk(conv.id, 300);

  // Still genuinely pending well past the ORIGINAL 100ms exec budget — the pause, not luck, is
  // what keeps this ask (and the child behind it) alive this long.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(getAskMeta(created.id).status, 'pending', 'the pause must keep this ask alive past the pre-pause 100ms deadline');

  const outcome = await created.promise;
  assert.deepEqual(outcome, { abandoned: true, reason: 'execution_timed_out' });

  const full = readConversation(conv.id);
  const abandonedEvt = full.events.find((e) => e.kind === 'ask_abandoned');
  assert.ok(abandonedEvt);
  assert.equal(abandonedEvt.data.id, created.id);
  assert.equal(abandonedEvt.data.reason, 'execution_timed_out');
  assert.ok(!full.events.some((e) => e.kind === 'ask_timed_out'), 'ask-store\'s own 10-minute timer must never have fired here');
});
