// Unit tests for attachments.mjs — build-lastdemos T3 (the composer's real "Attach" upload).
// Every test points storage at an isolated temp dir via _setAttachmentsDirForTests — never the
// real command-center/.data/attachments/.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseMultipart,
  storeAttachment,
  attachmentsDirForConversation,
  readRawBody,
  AttachmentTooLargeError,
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_INLINE_BYTES,
  _setAttachmentsDirForTests,
  _resetAttachmentsDirForTests,
} from '../src/attachments.mjs';

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-attachments-test-'));
  _setAttachmentsDirForTests(tempDir);
});

after(() => {
  _resetAttachmentsDirForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
});

/* ------------------------------------------------------------------ parseMultipart */

function buildMultipart(boundary, parts) {
  const body = parts
    .map((p) => {
      const disposition = p.fileName
        ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.fileName}"\r\n`
        : `Content-Disposition: form-data; name="${p.name}"\r\n`;
      const contentType = p.contentType ? `Content-Type: ${p.contentType}\r\n` : '';
      return `--${boundary}\r\n${disposition}${contentType}\r\n${p.content}\r\n`;
    })
    .join('') + `--${boundary}--\r\n`;
  return Buffer.from(body, 'utf8');
}

test('parseMultipart extracts a single named file field with its filename, content-type and bytes', () => {
  const boundary = 'TestBoundary1';
  const buffer = buildMultipart(boundary, [
    { name: 'file', fileName: 'notes.txt', contentType: 'text/plain', content: 'hello attachment' },
  ]);
  const result = parseMultipart(buffer, `multipart/form-data; boundary=${boundary}`);
  assert.equal(result.ok, true);
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].name, 'file');
  assert.equal(result.fields[0].fileName, 'notes.txt');
  assert.equal(result.fields[0].contentType, 'text/plain');
  assert.equal(result.fields[0].data.toString('utf8'), 'hello attachment');
});

test('parseMultipart handles a quoted boundary', () => {
  const boundary = 'QuotedBoundary';
  const buffer = buildMultipart(boundary, [{ name: 'file', fileName: 'a.txt', content: 'x' }]);
  const result = parseMultipart(buffer, `multipart/form-data; boundary="${boundary}"`);
  assert.equal(result.ok, true);
  assert.equal(result.fields.length, 1);
});

test('parseMultipart fails honestly when no boundary is present in Content-Type', () => {
  const result = parseMultipart(Buffer.from('irrelevant'), 'multipart/form-data');
  assert.equal(result.ok, false);
  assert.match(result.error, /boundary/);
});

test('parseMultipart fails honestly when the body has no boundary delimiter at all', () => {
  const result = parseMultipart(Buffer.from('not a multipart body'), 'multipart/form-data; boundary=Nope');
  assert.equal(result.ok, false);
});

/* ------------------------------------------------------------------- storeAttachment */

test('storeAttachment writes a real file under .data/attachments/<convId>/ and reports a text preview for a text extension', () => {
  const stored = storeAttachment({ convId: 'conv-1', fileName: 'notes.txt', data: Buffer.from('real content') });
  assert.match(stored.id, /^att-/);
  assert.equal(stored.fileName, 'notes.txt');
  assert.equal(stored.size, Buffer.byteLength('real content'));
  assert.equal(stored.isText, true);
  assert.equal(stored.textPreview, 'real content');
  assert.equal(stored.textTruncated, false);
  assert.equal(fs.existsSync(stored.storedPath), true);
  assert.equal(fs.readFileSync(stored.storedPath, 'utf8'), 'real content');
  assert.equal(path.dirname(stored.storedPath), attachmentsDirForConversation('conv-1'));
});

test('storeAttachment reports no text preview for a binary-shaped extension, only the real storedPath', () => {
  const stored = storeAttachment({ convId: 'conv-1', fileName: 'photo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  assert.equal(stored.isText, false);
  assert.equal(stored.textPreview, null);
  assert.equal(stored.textTruncated, false);
  assert.equal(fs.existsSync(stored.storedPath), true);
});

test('storeAttachment caps the reported text preview at MAX_TEXT_INLINE_BYTES and flags truncation, while the FULL file is still written to disk', () => {
  const big = 'x'.repeat(MAX_TEXT_INLINE_BYTES + 500);
  const stored = storeAttachment({ convId: 'conv-1', fileName: 'big.log', data: Buffer.from(big) });
  assert.equal(stored.textTruncated, true);
  assert.equal(stored.textPreview.length, MAX_TEXT_INLINE_BYTES);
  assert.equal(fs.statSync(stored.storedPath).size, big.length);
});

test('storeAttachment sanitizes a traversal-shaped filename to a safe basename — nothing escapes the conversation directory', () => {
  const stored = storeAttachment({ convId: 'conv-1', fileName: '../../evil.txt', data: Buffer.from('x') });
  assert.doesNotMatch(stored.fileName, /[\\/]/);
  assert.equal(path.dirname(stored.storedPath), attachmentsDirForConversation('conv-1'));
  assert.equal(fs.existsSync(path.join(tempDir, '..', '..', 'evil.txt')), false);
});

test('storeAttachment rejects an unsafe conversation id', () => {
  assert.throws(() => storeAttachment({ convId: '../evil', fileName: 'a.txt', data: Buffer.from('x') }));
});

test('attachmentsDirForConversation returns null for an unsafe id', () => {
  assert.equal(attachmentsDirForConversation('../evil'), null);
  assert.equal(attachmentsDirForConversation(''), null);
});

/* --------------------------------------------------------------------- readRawBody */

// A minimal fake IncomingMessage-shaped EventEmitter, just enough for readRawBody's own
// req.on('data'/'end'/'error') + removeAllListeners('data') + resume() calls.
function fakeRequestStream(chunks) {
  const listeners = { data: [], end: [], error: [] };
  return {
    on(event, handler) {
      listeners[event]?.push(handler);
      return this;
    },
    removeAllListeners(event) {
      listeners[event] = [];
    },
    resume() {},
    emitAll() {
      for (const chunk of chunks) for (const handler of listeners.data) handler(chunk);
      for (const handler of listeners.end) handler();
    },
  };
}

test('readRawBody resolves the concatenated buffer for a small body', async () => {
  const req = fakeRequestStream([Buffer.from('abc'), Buffer.from('def')]);
  const promise = readRawBody(req);
  req.emitAll();
  const buffer = await promise;
  assert.equal(buffer.toString('utf8'), 'abcdef');
});

test('readRawBody rejects with AttachmentTooLargeError once the cap is exceeded, never buffering past it', async () => {
  const req = fakeRequestStream([Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 'x')]);
  const promise = readRawBody(req);
  req.emitAll();
  await assert.rejects(promise, AttachmentTooLargeError);
});
