// feat-live-visibility (Gap A) — pending-asks.mjs: pure-function tests. Every test registers a
// REAL pending ask via ask-store.mjs's own `createAskRequest` (never a hand-rolled fixture map),
// mirroring chat-runs.test.mjs's own convention of exercising the store's real write path
// directly rather than only through the HTTP layer.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  appendUserTurn,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import {
  createAskRequest,
  answerAskRequest,
  abandonPendingAsksForConversation,
  _setAskTimeoutMsForTests,
  _resetAskStoreForTests,
} from '../src/ask-store.mjs';
import { listPendingAsksForProject } from '../src/pending-asks.mjs';

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pending-asks-test-'));
  _setConversationsDirForTests(tempDir);
});

after(() => {
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  _resetAskStoreForTests();
});

test('a real, currently-pending ask for the project shows up', () => {
  const conv = createConversation({ project: 'demo-project' });
  appendUserTurn(conv.id, 'Build a landing page for LittleBazzar please');
  const ask = createAskRequest({ convId: conv.id, turnId: 't-1', requestId: 'req-1', questions: [{ question: 'Which color?' }] });
  assert.equal(ask.ok, true);

  const rows = listPendingAsksForProject('demo-project');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, ask.id);
  assert.equal(rows[0].conversation_id, conv.id);
  assert.equal(rows[0].turn_id, 't-1');
  assert.equal(rows[0].question_count, 1);
  assert.equal(rows[0].conversation_first_message, 'Build a landing page for LittleBazzar please');
});

test('once the ask is genuinely ANSWERED it disappears from the list — never a stale ghost', () => {
  const conv = createConversation({ project: 'demo-project-answered' });
  const ask = createAskRequest({ convId: conv.id, questions: [{ question: 'Q1' }] });
  assert.equal(listPendingAsksForProject('demo-project-answered').length, 1);

  const answer = answerAskRequest(ask.id, [{ answer: 'blue' }]);
  assert.equal(answer.ok, true);

  assert.deepEqual(listPendingAsksForProject('demo-project-answered'), []);
});

test('once the ask times out it disappears from the list', async () => {
  _setAskTimeoutMsForTests(10);
  const conv = createConversation({ project: 'demo-project-timeout' });
  const ask = createAskRequest({ convId: conv.id, questions: [{ question: 'Q1' }] });
  assert.equal(ask.ok, true);
  await ask.promise; // resolves once the short timeout fires
  assert.deepEqual(listPendingAsksForProject('demo-project-timeout'), []);
  _setAskTimeoutMsForTests(null);
});

test('once the ask is abandoned (execution ended) it disappears from the list', () => {
  const conv = createConversation({ project: 'demo-project-abandoned' });
  const ask = createAskRequest({ convId: conv.id, questions: [{ question: 'Q1' }] });
  assert.equal(listPendingAsksForProject('demo-project-abandoned').length, 1);

  const abandoned = abandonPendingAsksForConversation(conv.id, 'execution_stopped');
  assert.equal(abandoned.length, 1);

  assert.deepEqual(listPendingAsksForProject('demo-project-abandoned'), []);
});

test('a pending ask on a DIFFERENT project is never mixed into this project\'s list', () => {
  const other = createConversation({ project: 'some-other-project' });
  createAskRequest({ convId: other.id, questions: [{ question: 'Q1' }] });

  assert.deepEqual(listPendingAsksForProject('demo-project-nobody-asked-in'), []);
});

test('a project with no chat activity at all reads back an empty list, never fabricated', () => {
  assert.deepEqual(listPendingAsksForProject('a-project-nobody-ever-chatted-in'), []);
});

test('an unknown/empty project name is rejected honestly, never throws', () => {
  assert.deepEqual(listPendingAsksForProject(''), []);
  assert.deepEqual(listPendingAsksForProject(undefined), []);
});

test('multiple conversations in the same project can each carry their own pending ask', () => {
  const convA = createConversation({ project: 'demo-project-multi' });
  const convB = createConversation({ project: 'demo-project-multi' });
  const askA = createAskRequest({ convId: convA.id, questions: [{ question: 'A?' }] });
  const askB = createAskRequest({ convId: convB.id, questions: [{ question: 'B?' }] });

  const rows = listPendingAsksForProject('demo-project-multi');
  assert.equal(rows.length, 2);
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, [askA.id, askB.id].sort());
});
