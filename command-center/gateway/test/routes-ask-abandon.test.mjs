// HTTP-level integration tests for fix-ghost-asks (forge-2026-07-30-cc-finish, work package
// fix-ghost-asks, item 1) — proves the REAL measured defect from
// `command-center/mission/DIAGNOSE-2026-07-30-spookvragen.md` is fixed: a stopped or naturally-
// closed execution must close out its own still-pending ask, and the blocked `POST /api/ask`
// request must settle rather than hang. ALWAYS in mock execution mode (CC_EXEC_MOCK=1) — no real
// `claude`/ask-mcp.mjs subprocess is spawned by this file; `/api/ask` is exercised directly over
// real HTTP, exactly like routes-ask.test.mjs already does, while a REAL mock execution runs
// concurrently for the same conversation (routes-ask.test.mjs never starts one).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { _resetExecBridgeForTests, isConversationBusy } from '../src/exec-bridge.mjs';
import { _resetAskStoreForTests } from '../src/ask-store.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);

let server;
let port;
let tempDir;

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-routes-ask-abandon-test-'));
  _setConversationsDirForTests(tempDir);
  _resetProjectsCacheForTests();
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  delete process.env.CC_EXEC_MOCK;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  _resetExecBridgeForTests();
  _resetAskStoreForTests();
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
});

async function waitUntil(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function makeConversation() {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(created.statusCode, 201);
  return created.json.conversation.id;
}

async function waitForAskId(convId) {
  let askId = null;
  for (let i = 0; i < 60 && askId === null; i++) {
    const conv = await request(port, '/api/conversations/' + convId);
    const evt = conv.json.events.find((e) => e.kind === 'ask_questions');
    if (evt) askId = evt.data.id;
    else await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(askId, 'a real ask_questions event must appear on the conversation');
  return askId;
}

test('STOP: stopping a conversation with a genuinely pending ask abandons it (reason execution_stopped), the blocked /api/ask settles, and a real ask_abandoned event is recorded', async () => {
  const convId = await makeConversation();
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000'; // keeps the mock exec "running" for the whole test
  const send = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'ask me something' } });
  assert.equal(send.statusCode, 202);
  assert.equal(isConversationBusy(convId), true);

  const askPromise = requestWithBody(port, '/api/ask', { jsonBody: { conv_id: convId, questions: [{ question: 'Which color?' }] } });
  const askId = await waitForAskId(convId);

  const stopRes = await requestWithBody(port, '/api/conversations/' + convId + '/stop', { jsonBody: {} });
  assert.equal(stopRes.statusCode, 200);
  assert.equal(stopRes.json.stopped, true);

  // THE core proof from the diagnosis: this must settle, never hang until the ask's own 30-minute
  // timeout. node --test's own default timeout would fail this file long before that if it hung.
  const askRes = await askPromise;
  assert.equal(askRes.statusCode, 200);
  assert.equal(askRes.json.ok, true);
  assert.equal(askRes.json.abandoned, true, 'the settled response must honestly say the ask was abandoned, not answered');
  assert.equal(askRes.json.reason, 'execution_stopped');
  assert.equal(askRes.json.timed_out, undefined, 'abandoned and timed_out are different outcomes — never both/confused');

  const finalConv = await request(port, '/api/conversations/' + convId);
  const abandonedEvt = finalConv.json.events.find((e) => e.kind === 'ask_abandoned');
  assert.ok(abandonedEvt, 'a real ask_abandoned event must be recorded on the conversation');
  assert.equal(abandonedEvt.data.id, askId);
  assert.equal(abandonedEvt.data.reason, 'execution_stopped');
  assert.ok(!finalConv.json.events.some((e) => e.kind === 'ask_timed_out'), 'this must be a real ask_abandoned, never mislabeled as a timeout');
  assert.ok(finalConv.json.events.some((e) => e.kind === 'stopped_by_user'), 'the pre-existing stop event must still be recorded unchanged');
});

test('CLOSE: a mock execution that finishes naturally abandons its own still-pending ask (reason execution_closed) once it closes', async () => {
  const convId = await makeConversation();
  process.env.CC_EXEC_MOCK_DELAY_MS = '400'; // long enough to register the ask before it closes on its own
  const send = await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'ask me something' } });
  assert.equal(send.statusCode, 202);

  const askPromise = requestWithBody(port, '/api/ask', { jsonBody: { conv_id: convId, questions: [{ question: 'Which color?' }] } });
  const askId = await waitForAskId(convId);

  // Deliberately never stopped — the mock child's own 400 ms delay closes it naturally.
  const freed = await waitUntil(() => !isConversationBusy(convId), { timeoutMs: 3000 });
  assert.ok(freed, 'the mock execution must close on its own within the test window');

  const askRes = await askPromise;
  assert.equal(askRes.statusCode, 200);
  assert.equal(askRes.json.abandoned, true);
  assert.equal(askRes.json.reason, 'execution_closed');

  const finalConv = await request(port, '/api/conversations/' + convId);
  const abandonedEvt = finalConv.json.events.find((e) => e.kind === 'ask_abandoned');
  assert.ok(abandonedEvt);
  assert.equal(abandonedEvt.data.id, askId);
  assert.equal(abandonedEvt.data.reason, 'execution_closed');
});

test('a stop with NO pending ask at all is unaffected (pre-existing behavior unchanged) — no ask_abandoned event ever appears', async () => {
  const convId = await makeConversation();
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'no ask here' } });
  const stopRes = await requestWithBody(port, '/api/conversations/' + convId + '/stop', { jsonBody: {} });
  assert.equal(stopRes.json.stopped, true);

  const finalConv = await request(port, '/api/conversations/' + convId);
  assert.ok(!finalConv.json.events.some((e) => e.kind === 'ask_abandoned'), 'no ask was ever pending — nothing should be abandoned');
  assert.ok(finalConv.json.events.some((e) => e.kind === 'stopped_by_user'));
});

test('IDEMPOTENCE (ask-store side): stopping a conversation TWICE never double-appends ask_abandoned for the same ask', async () => {
  const convId = await makeConversation();
  process.env.CC_EXEC_MOCK_DELAY_MS = '5000';
  await requestWithBody(port, '/api/conversations/' + convId + '/messages', { jsonBody: { text: 'ask me something' } });
  const askPromise = requestWithBody(port, '/api/ask', { jsonBody: { conv_id: convId, questions: [{ question: 'Q' }] } });
  await waitForAskId(convId);

  await requestWithBody(port, '/api/conversations/' + convId + '/stop', { jsonBody: {} });
  await askPromise;
  // A second stop on an already-stopped conversation is a pre-existing, unchanged no-op
  // (stopExecution returns {stopped:false} when `running` has no entry for it) — abandonPendingAsk
  // is only ever reached inside the `if (!entry) return` guard's else-branch, so it cannot run twice.
  const secondStop = await requestWithBody(port, '/api/conversations/' + convId + '/stop', { jsonBody: {} });
  assert.equal(secondStop.json.stopped, false);

  const finalConv = await request(port, '/api/conversations/' + convId);
  const abandonedEvents = finalConv.json.events.filter((e) => e.kind === 'ask_abandoned');
  assert.equal(abandonedEvents.length, 1, 'exactly one ask_abandoned event — never doubled by a second stop call');
});
