// feat-live-visibility (Gap B) — HTTP-level integration tests for GET /api/agent-dispatches, same
// harness pattern as routes-chat-runs.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, createConversation, appendUserTurn, appendConversationEvent } from '../src/conversations.mjs';
import { request } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);

let server;
let port;
let tempDir;

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-routes-agent-dispatches-test-'));
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

test('GET /api/agent-dispatches returns a real resolved dispatch for a real conversation, over real HTTP', async () => {
  const conv = createConversation({ project: THIS_PROJECT_NAME });
  const { turnId } = appendUserTurn(conv.id, 'Real HTTP-level agent-dispatch test prompt');
  appendConversationEvent(conv.id, {
    turn_id: turnId,
    kind: 'system',
    data: { type: 'system', subtype: 'task_started', task_id: 'task-http-1', tool_use_id: 'toolu_1', description: 'x', subagent_type: 'Explore', task_type: 'local_agent' },
  });
  appendConversationEvent(conv.id, {
    turn_id: turnId,
    kind: 'system',
    data: { type: 'system', subtype: 'task_updated', task_id: 'task-http-1', patch: { status: 'completed' } },
  });

  const res = await request(port, '/api/agent-dispatches?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.provenance, 'DERIVED');
  const found = res.json.dispatches.find((r) => r.conversation_id === conv.id);
  assert.ok(found, 'the real dispatch just written must be present in the real HTTP response');
  assert.equal(found.subagent_type, 'Explore');
  assert.equal(found.running, false);
});

test('GET /api/agent-dispatches for a project with no chat activity is an honest empty list, not a fabricated one', async () => {
  const res = await request(port, '/api/agent-dispatches?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '-definitely-unused-suffix');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('SECURITY: GET /api/agent-dispatches with an unknown project never reaches the conversation store', async () => {
  const res = await request(port, '/api/agent-dispatches?project=totally-not-a-real-project');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /unknown project/);
});

test('POST /api/agent-dispatches is rejected — this route is read-only like every other reader endpoint', async () => {
  const res = await request(port, '/api/agent-dispatches?project=' + encodeURIComponent(THIS_PROJECT_NAME), { method: 'POST' });
  assert.equal(res.statusCode, 405);
});
