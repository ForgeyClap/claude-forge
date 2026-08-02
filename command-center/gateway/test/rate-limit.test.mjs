// fix-test-hygiene (owner-flagged system-checkup finding, MEDIUM/INFO): proves the new in-memory
// token-bucket rate limit on POST /api/conversations and POST /api/conversations/:id/messages —
// under the limit succeeds, over the limit is a real 429 with a Retry-After header, and a full
// refill window (via an INJECTED clock, never a real multi-second sleep) restores capacity.
//
// Uses server.mjs's own test-only seams (_setRateLimitClockForTests / _configureRateLimitForTests)
// to shrink the bucket to a small, fast-to-exhaust size instead of the real production capacity —
// see server.mjs's own rate-limit comment for why 60/60s is the real, shipped default and why it
// never interferes with this project's existing test suite (routes-wp4.test.mjs's real usage is
// the evidence floor that default was sized against).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, _setRateLimitClockForTests, _configureRateLimitForTests } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests } from '../src/conversations.mjs';
import { _resetExecBridgeForTests } from '../src/exec-bridge.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
const TEST_CAPACITY = 3;
const TEST_REFILL_MS = 1000;

let server;
let port;
let tempDir;
let fakeNowMs;

// Mirrors routes-wp4.test.mjs's own waitUntil(): a bounded poll for the mock execution's async
// completion, NOT a fixed real sleep — needed so a successful (202) message-send test doesn't
// tear down tempDir while the mock child is still mid-write (real, previously-seen failure mode:
// "ENOENT ... generated asynchronous activity after the test ended").
async function waitUntilAssistantTurn(convId, { timeoutMs = 2000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await request(port, '/api/conversations/' + convId);
    if (r.json && Array.isArray(r.json.turns) && r.json.turns.some((t) => t.role === 'assistant')) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

before(async () => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rate-limit-test-'));
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
  _setRateLimitClockForTests(null);
  _configureRateLimitForTests(); // restore the real production capacity/window
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  _resetExecBridgeForTests();
  fakeNowMs = 1_000_000; // arbitrary fixed epoch — only relative deltas ever matter to the bucket
  _setRateLimitClockForTests(() => fakeNowMs);
  _configureRateLimitForTests({ capacity: TEST_CAPACITY, refillMs: TEST_REFILL_MS });
});

test('RATE LIMIT: POST /api/conversations allows up to capacity, then 429s with a real Retry-After', async () => {
  for (let i = 0; i < TEST_CAPACITY; i++) {
    const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
    assert.equal(res.statusCode, 201, 'request ' + (i + 1) + ' of ' + TEST_CAPACITY + ' must succeed (within capacity)');
  }
  const overLimit = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(overLimit.statusCode, 429);
  assert.equal(overLimit.json.ok, false);
  assert.match(overLimit.json.error, /rate limit/);
  assert.ok(typeof overLimit.json.retry_after_ms === 'number' && overLimit.json.retry_after_ms > 0);
  assert.ok(Number(overLimit.headers['retry-after']) > 0, 'a real Retry-After header must be present');
});

test('RATE LIMIT: after a full refill window elapses (injected clock, zero real sleep), capacity is restored', async () => {
  for (let i = 0; i < TEST_CAPACITY; i++) {
    const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
    assert.equal(res.statusCode, 201);
  }
  const blocked = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(blocked.statusCode, 429);

  fakeNowMs += TEST_REFILL_MS; // advance the injected clock past the full window — no real waiting
  const afterWindow = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(afterWindow.statusCode, 201, 'a full refill window must restore capacity');
});

test('RATE LIMIT: POST /api/conversations/:id/messages allows up to capacity, then 429s with a real Retry-After', async () => {
  // Create the fixtures needed (one conversation per message-send below) under the real, generous
  // production capacity first — this phase only exercises the UNRELATED create-bucket, not the
  // message-bucket under test, and 4 creates is trivially under its own default 60-capacity.
  _configureRateLimitForTests();
  const convIds = [];
  for (let i = 0; i <= TEST_CAPACITY; i++) {
    const created = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
    assert.equal(created.statusCode, 201);
    convIds.push(created.json.conversation.id);
  }

  // Now shrink to the small test capacity/window for the MESSAGE bucket itself (reconfiguring
  // rebuilds both buckets fresh — the create-bucket headroom used above no longer matters).
  _setRateLimitClockForTests(() => fakeNowMs);
  _configureRateLimitForTests({ capacity: TEST_CAPACITY, refillMs: TEST_REFILL_MS });

  // A DIFFERENT conversation per send, so the unrelated duplicate-send 409 guard (one pending
  // turn per conversation) can never interfere with proving the rate limit itself — the message
  // bucket is shared across every conversation, so this still exercises the exact same bucket.
  for (let i = 0; i < TEST_CAPACITY; i++) {
    const res = await requestWithBody(port, '/api/conversations/' + convIds[i] + '/messages', { jsonBody: { text: 'msg ' + i } });
    assert.equal(res.statusCode, 202, 'message ' + (i + 1) + ' of ' + TEST_CAPACITY + ' must succeed (within capacity)');
    assert.ok(await waitUntilAssistantTurn(convIds[i]), 'mock execution must finish before teardown');
  }
  const overLimit = await requestWithBody(port, '/api/conversations/' + convIds[TEST_CAPACITY] + '/messages', { jsonBody: { text: 'over limit' } });
  assert.equal(overLimit.statusCode, 429);
  assert.equal(overLimit.json.ok, false);
  assert.match(overLimit.json.error, /rate limit/);
  assert.ok(Number(overLimit.headers['retry-after']) > 0, 'a real Retry-After header must be present');
});

test('RATE LIMIT: the create-bucket and message-bucket are independent — exhausting one never blocks the other', async () => {
  let freshConvId;
  for (let i = 0; i < TEST_CAPACITY; i++) {
    const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
    assert.equal(res.statusCode, 201);
    freshConvId = res.json.conversation.id; // a conversation created IN this test, guaranteed not busy
  }
  const overLimitCreate = await requestWithBody(port, '/api/conversations', { jsonBody: { project: THIS_PROJECT_NAME } });
  assert.equal(overLimitCreate.statusCode, 429, 'the create bucket must now be exhausted');

  // The message bucket is a SEPARATE bucket — sending against an existing, never-messaged
  // conversation must still succeed even though the create bucket above is fully drained.
  const sendRes = await requestWithBody(port, '/api/conversations/' + freshConvId + '/messages', { jsonBody: { text: 'independent bucket' } });
  assert.equal(sendRes.statusCode, 202, 'the message bucket must be independent of the drained create bucket');
  assert.ok(await waitUntilAssistantTurn(freshConvId), 'mock execution must finish before teardown');
});
