// HTTP-level integration tests for the feat-ask-owner routes (POST /api/ask, POST
// /api/ask/:id/answer), against a real instance of the gateway bound to an ephemeral port. ALWAYS
// in mock execution mode (CC_EXEC_MOCK=1) — no real `claude`/ask-mcp.mjs subprocess is spawned by
// this file; the routes themselves are exercised directly over real HTTP.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { _resetExecBridgeForTests } from '../src/exec-bridge.mjs';
import { _setAskTimeoutMsForTests, _resetAskStoreForTests } from '../src/ask-store.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';
import { EXEC_TOKEN_HEADER, getExecToken } from '../src/security.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);

let server;
let port;
let tempDir;

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-routes-ask-test-'));
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
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  _resetExecBridgeForTests();
  _resetAskStoreForTests();
});

async function makeConversation() {
  const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(created.statusCode, 201);
  return created.json.conversation.id;
}

test('POST /api/ask registers a question, appends a real ask_questions event, and BLOCKS until answered — then the SAME request resolves with the real answer', async () => {
  const convId = await makeConversation();

  const askPromise = requestWithBody(port, '/api/ask', {
    jsonBody: { conv_id: convId, turn_id: 't-ask-1', questions: [{ question: 'Which color?', options: ['red', 'blue'] }] },
  });

  // The question must already be visible on the conversation (a real ask_questions event) while
  // the /api/ask request above is still pending — this is the dashboard's own read path.
  let askId = null;
  for (let i = 0; i < 40 && askId === null; i++) {
    const conv = await request(port, '/api/conversations/' + convId);
    const evt = conv.json.events.find((e) => e.kind === 'ask_questions');
    if (evt) askId = evt.data.id;
    else await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(askId, 'a real ask_questions event must appear on the conversation before the ask is answered');

  const answerRes = await requestWithBody(port, '/api/ask/' + askId + '/answer', { jsonBody: { answers: [{ answer: 'blue' }] } });
  assert.equal(answerRes.statusCode, 200);
  assert.equal(answerRes.json.ok, true);
  assert.equal(answerRes.json.answered, true);

  const askRes = await askPromise;
  assert.equal(askRes.statusCode, 200);
  assert.equal(askRes.json.ok, true);
  assert.equal(askRes.json.timed_out, false);
  assert.deepEqual(askRes.json.answers, [{ question: 'Which color?', answer: 'blue' }]);

  const finalConv = await request(port, '/api/conversations/' + convId);
  const answeredEvt = finalConv.json.events.find((e) => e.kind === 'ask_answered');
  assert.ok(answeredEvt, 'a real ask_answered event must be recorded');
  assert.equal(answeredEvt.data.id, askId);
});

test('TIMEOUT: POST /api/ask resolves honestly with timed_out:true when nobody answers in time, and a real ask_timed_out event is recorded', async () => {
  _setAskTimeoutMsForTests(80);
  const convId = await makeConversation();

  const res = await requestWithBody(port, '/api/ask', { jsonBody: { conv_id: convId, questions: [{ question: 'Anyone there?' }] } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.timed_out, true);
  assert.match(res.json.note, /did not answer/);

  const conv = await request(port, '/api/conversations/' + convId);
  assert.ok(conv.json.events.some((e) => e.kind === 'ask_timed_out'));
});

test('POST /api/ask/:id/answer on an unknown ask id is a real 404, never a crash', async () => {
  const res = await requestWithBody(port, '/api/ask/ask-does-not-exist/answer', { jsonBody: { answers: [{ answer: 'x' }] } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('PLAFOND: POST /api/ask with more than the 25-question ceiling is rejected with an honest 400, never silently truncated', async () => {
  const convId = await makeConversation();
  const tooMany = Array.from({ length: 26 }, (_, i) => ({ question: 'Q' + i }));
  const res = await requestWithBody(port, '/api/ask', { jsonBody: { conv_id: convId, questions: tooMany } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /too many questions/);
});

test('POST /api/ask against an unknown conversation id is a real 404', async () => {
  const res = await requestWithBody(port, '/api/ask', { jsonBody: { conv_id: 'c-does-not-exist', questions: [{ question: 'Q' }] } });
  assert.equal(res.statusCode, 404);
});

test('SCHEMA: POST /api/ask with an unknown field is rejected with 400', async () => {
  const convId = await makeConversation();
  const res = await requestWithBody(port, '/api/ask', { jsonBody: { conv_id: convId, questions: [{ question: 'Q' }], evil: true } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /unknown field/);
});

test('SCHEMA: POST /api/ask/:id/answer with a malformed answers shape is rejected with 400 (strict validation)', async () => {
  const convId = await makeConversation();
  const askPromise = requestWithBody(port, '/api/ask', { jsonBody: { conv_id: convId, questions: [{ question: 'Q1' }, { question: 'Q2' }] } });

  let askId = null;
  for (let i = 0; i < 40 && askId === null; i++) {
    const conv = await request(port, '/api/conversations/' + convId);
    const evt = conv.json.events.find((e) => e.kind === 'ask_questions');
    if (evt) askId = evt.data.id;
    else await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(askId);

  const wrongLength = await requestWithBody(port, '/api/ask/' + askId + '/answer', { jsonBody: { answers: [{ answer: 'only one' }] } });
  assert.equal(wrongLength.statusCode, 400);

  const goodAnswer = await requestWithBody(port, '/api/ask/' + askId + '/answer', { jsonBody: { answers: [{ answer: 'a1' }, { answer: 'a2' }] } });
  assert.equal(goodAnswer.statusCode, 200);
  await askPromise;
});

test('AUTH: POST /api/ask with NO exec token is rejected with 403, and no question is registered', async () => {
  const convId = await makeConversation();
  const res = await requestWithBody(port, '/api/ask', {
    jsonBody: { conv_id: convId, questions: [{ question: 'Q' }] },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);

  const conv = await request(port, '/api/conversations/' + convId);
  assert.ok(!conv.json.events.some((e) => e.kind === 'ask_questions'), 'a rejected /api/ask must never register a question');
});

test('AUTH: POST /api/ask/:id/answer with NO exec token is rejected with 403', async () => {
  const convId = await makeConversation();
  const askPromise = requestWithBody(port, '/api/ask', { jsonBody: { conv_id: convId, questions: [{ question: 'Q' }] } });

  let askId = null;
  for (let i = 0; i < 40 && askId === null; i++) {
    const conv = await request(port, '/api/conversations/' + convId);
    const evt = conv.json.events.find((e) => e.kind === 'ask_questions');
    if (evt) askId = evt.data.id;
    else await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(askId);

  const res = await requestWithBody(port, '/api/ask/' + askId + '/answer', { jsonBody: { answers: [{ answer: 'x' }] }, omitExecToken: true });
  assert.equal(res.statusCode, 403);

  // The ask must still be answerable afterwards with the real token — a rejected attempt must
  // never have consumed it.
  const real = await requestWithBody(port, '/api/ask/' + askId + '/answer', {
    jsonBody: { answers: [{ answer: 'x' }] },
    omitExecToken: true,
    headers: { [EXEC_TOKEN_HEADER]: getExecToken() },
  });
  assert.equal(real.statusCode, 200);
  await askPromise;
});

test('non-GET/POST methods on /api/ask are rejected with 405', async () => {
  const res = await request(port, '/api/ask', { method: 'DELETE' });
  assert.equal(res.statusCode, 405);
});
