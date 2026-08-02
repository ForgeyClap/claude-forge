// HTTP-level integration tests for feat-chatruns-tabs's GET /api/chat-runs — same harness pattern as
// routes-wp4.test.mjs (a real gateway on an ephemeral port, mock execution mode, an isolated temp
// conversations dir), proving the real server.mjs wiring end to end (not just chat-runs.mjs's own
// pure-function tests in chat-runs.test.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation, appendUserTurn, appendAssistantTurn } from '../src/conversations.mjs';
import { request } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);

let server;
let port;
let tempDir;

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-routes-chat-runs-test-'));
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

test('GET /api/chat-runs returns a real chat-run for a real conversation execution, over real HTTP', async () => {
  const conv = createConversation({ project: THIS_PROJECT_NAME });
  const { turnId, requestId } = appendUserTurn(conv.id, 'Real HTTP-level chat-run test prompt');
  appendAssistantTurn(conv.id, {
    turn_id: turnId,
    request_id: requestId,
    text: 'done',
    stop_reason: 'end_turn',
    exit_code: 0,
    model: 'claude-sonnet-5',
  });

  const res = await request(port, '/api/chat-runs?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.provenance, 'DERIVED');
  const found = res.json.chat_runs.find((r) => r.run_id === 'chat-' + conv.id + '-' + turnId);
  assert.ok(found, 'the real chat-run just written must be present in the real HTTP response');
  assert.equal(found.title, 'Real HTTP-level chat-run test prompt');
  assert.equal(found.status, 'completed');
  assert.equal(found.model, 'claude-sonnet-5');
});

test('GET /api/chat-runs for a project with no chat activity is an honest empty list, not a fabricated one', async () => {
  const res = await request(port, '/api/chat-runs?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '-definitely-unused-suffix');
  // The suffixed name does not match any real registry entry, so this is the SAME honest 404 every
  // other `?project=` route gives for an unknown project — never a silent empty 200.
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('SECURITY: GET /api/chat-runs with an unknown project never reaches the conversation store', async () => {
  const res = await request(port, '/api/chat-runs?project=totally-not-a-real-project');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /unknown project/);
});

test('POST /api/chat-runs is rejected — this route is read-only like every other reader endpoint', async () => {
  const res = await request(port, '/api/chat-runs?project=' + encodeURIComponent(THIS_PROJECT_NAME), { method: 'POST' });
  assert.equal(res.statusCode, 405);
});
