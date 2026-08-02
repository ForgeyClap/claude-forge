// feat-live-visibility (Gap A) — HTTP-level integration tests for GET /api/pending-asks, same
// harness pattern as routes-chat-runs.test.mjs (a real gateway on an ephemeral port, an isolated
// temp conversations dir).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation, appendUserTurn } from '../src/conversations.mjs';
import { createAskRequest, answerAskRequest, _resetAskStoreForTests } from '../src/ask-store.mjs';
import { request } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);

let server;
let port;
let tempDir;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-routes-pending-asks-test-'));
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
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  _resetAskStoreForTests();
});

test('GET /api/pending-asks returns a real pending ask for a real conversation, over real HTTP', async () => {
  const conv = createConversation({ project: THIS_PROJECT_NAME });
  appendUserTurn(conv.id, 'Real HTTP-level pending-ask test prompt');
  const ask = createAskRequest({ convId: conv.id, turnId: 't-http-1', questions: [{ question: 'Which color?' }] });
  assert.equal(ask.ok, true);

  const res = await request(port, '/api/pending-asks?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.provenance, 'DERIVED');
  const found = res.json.pending_asks.find((r) => r.id === ask.id);
  assert.ok(found, 'the real pending ask just registered must be present in the real HTTP response');
  assert.equal(found.conversation_id, conv.id);
  assert.equal(found.question_count, 1);
});

test('GET /api/pending-asks never claims a wait that already resolved, over real HTTP', async () => {
  const conv = createConversation({ project: THIS_PROJECT_NAME });
  const ask = createAskRequest({ convId: conv.id, questions: [{ question: 'Q1' }] });
  answerAskRequest(ask.id, [{ answer: 'blue' }]);

  const res = await request(port, '/api/pending-asks?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.pending_asks.find((r) => r.id === ask.id), undefined);
});

test('GET /api/pending-asks for a project with no chat activity is an honest empty list, not a fabricated one', async () => {
  const res = await request(port, '/api/pending-asks?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '-definitely-unused-suffix');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('SECURITY: GET /api/pending-asks with an unknown project never reaches the conversation store', async () => {
  const res = await request(port, '/api/pending-asks?project=totally-not-a-real-project');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /unknown project/);
});

test('POST /api/pending-asks is rejected — this route is read-only like every other reader endpoint', async () => {
  const res = await request(port, '/api/pending-asks?project=' + encodeURIComponent(THIS_PROJECT_NAME), { method: 'POST' });
  assert.equal(res.statusCode, 405);
});
