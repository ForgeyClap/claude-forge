// HTTP-level integration tests for build-lastdemos T3's POST /api/conversations/:id/attachments
// route, against a real instance of the gateway bound to an ephemeral port. Both the conversation
// store and the attachments store are pointed at isolated temp dirs — this suite never writes
// into the real command-center/.data/.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import {
  createConversation,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import { _setAttachmentsDirForTests, _resetAttachmentsDirForTests } from '../src/attachments.mjs';
import { requestWithBody } from '../test-support/helpers.mjs';

let server;
let port;
let convDir;
let attachDir;

function multipartBody(boundary, fileName, content, contentType = 'text/plain') {
  return (
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--\r\n`
  );
}

before(async () => {
  convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-conv-test-'));
  attachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-attach-test-'));
  _setConversationsDirForTests(convDir);
  _setAttachmentsDirForTests(attachDir);
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  _resetConversationsForTests();
  _resetAttachmentsDirForTests();
  fs.rmSync(convDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.rmSync(attachDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await new Promise((resolve) => server.close(resolve));
});

let convId;
beforeEach(() => {
  convId = createConversation({ project: 'demo-project', title: 'Test thread' }).id;
});

test('POST /api/conversations/:id/attachments stores a real file and reports a real text preview', async () => {
  const boundary = 'HttpBoundary1';
  const res = await requestWithBody(port, `/api/conversations/${convId}/attachments`, {
    rawBody: multipartBody(boundary, 'notes.txt', 'a real attached note'),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.attachment.fileName, 'notes.txt');
  assert.equal(res.json.attachment.isText, true);
  assert.equal(res.json.attachment.textPreview, 'a real attached note');
  assert.equal(fs.existsSync(res.json.attachment.storedPath), true);
  assert.equal(fs.readFileSync(res.json.attachment.storedPath, 'utf8'), 'a real attached note');
});

test('POST /api/conversations/:id/attachments reports a binary attachment with no text preview', async () => {
  const boundary = 'HttpBoundary2';
  const res = await requestWithBody(port, `/api/conversations/${convId}/attachments`, {
    rawBody: multipartBody(boundary, 'photo.png', 'not-real-png-bytes', 'image/png'),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.attachment.isText, false);
  assert.equal(res.json.attachment.textPreview, null);
});

test('POST /api/conversations/:id/attachments for an unknown conversation is rejected with 404', async () => {
  const boundary = 'HttpBoundary3';
  const res = await requestWithBody(port, '/api/conversations/not-a-real-conv/attachments', {
    rawBody: multipartBody(boundary, 'a.txt', 'x'),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('POST /api/conversations/:id/attachments without a "file" field is rejected with 400', async () => {
  const boundary = 'HttpBoundary4';
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="not-file"\r\n\r\n` +
    `x\r\n--${boundary}--\r\n`;
  const res = await requestWithBody(port, `/api/conversations/${convId}/attachments`, {
    rawBody: body,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /file/);
});

test('SIZE: POST /api/conversations/:id/attachments over the ~5MB cap is rejected with 413, never silently truncated', async () => {
  const boundary = 'HttpBoundary5';
  const oversized = 'x'.repeat(5 * 1024 * 1024 + 1000);
  const res = await requestWithBody(port, `/api/conversations/${convId}/attachments`, {
    rawBody: multipartBody(boundary, 'huge.txt', oversized),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  assert.equal(res.statusCode, 413);
}, { timeout: 20000 });

test('GET /api/conversations/:id/attachments (wrong method) is rejected — attachments is a write-only route shape', async () => {
  const res = await requestWithBody(port, `/api/conversations/${convId}/attachments`, {
    method: 'GET',
    rawBody: '',
  });
  // No route matches GET on this path (only POST is wired) — the same honest "not found" fallback
  // every other write-only conversation route (e.g. /stop) falls through to on the wrong method.
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});
