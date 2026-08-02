// WP10 F6 (Codex, concurrent-SSE hardening): attachConversationStream had no cap on concurrent
// streams — a single unauthenticated loopback caller (the whole trust model per WP10 AP-5) could
// open unbounded fs.watch + timer pairs. Uses the same fake req/res pattern as events-stream.test.mjs
// (no real socket needed to prove the counting/rejection logic).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  createConversation,
  attachConversationStream,
  _setConversationsDirForTests,
  _resetConversationsForTests,
  _resetConversationStreamCapForTests,
  _conversationStreamCapConstantsForTests,
} from '../src/conversations.mjs';

function makeFakeRes() {
  const emitter = new EventEmitter();
  const res = {
    chunks: [],
    status: null,
    headers: null,
    writableEnded: false,
    writeHead(status, headers) { res.status = status; res.headers = headers; },
    write(chunk) { if (!res.writableEnded) res.chunks.push(chunk); return true; },
    end(chunk) { if (chunk) res.chunks.push(chunk); res.writableEnded = true; },
    on(evt, cb) { emitter.on(evt, cb); },
    text() { return res.chunks.join(''); },
    _emitClose() { res.writableEnded = true; emitter.emit('close'); },
  };
  return res;
}

function makeFakeReq() {
  const emitter = new EventEmitter();
  return { headers: {}, on(evt, cb) { emitter.on(evt, cb); } };
}

let tempDir;
before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sse-cap-test-'));
  _setConversationsDirForTests(tempDir);
});
after(() => {
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
beforeEach(() => {
  _resetConversationStreamCapForTests();
});

test('F6 SECURITY: the per-conversation and gateway-wide caps are the documented values', () => {
  const { MAX_STREAMS_PER_CONVERSATION, MAX_STREAMS_TOTAL } = _conversationStreamCapConstantsForTests();
  assert.equal(MAX_STREAMS_PER_CONVERSATION, 8);
  assert.equal(MAX_STREAMS_TOTAL, 32);
});

test('F6 SECURITY: the (MAX_STREAMS_PER_CONVERSATION + 1)th concurrent stream on ONE conversation gets a 503, not a hang', () => {
  const conv = createConversation({ project: 'demo-project' });
  const { MAX_STREAMS_PER_CONVERSATION } = _conversationStreamCapConstantsForTests();
  const opened = [];
  for (let i = 0; i < MAX_STREAMS_PER_CONVERSATION; i++) {
    const req = makeFakeReq();
    const res = makeFakeRes();
    attachConversationStream({ req, res, convId: conv.id, heartbeatMs: 999_999, fallbackPollMs: 999_999 });
    assert.equal(res.status, 200, 'stream #' + (i + 1) + ' must be accepted (under the cap)');
    opened.push(res);
  }

  const overflowReq = makeFakeReq();
  const overflowRes = makeFakeRes();
  attachConversationStream({ req: overflowReq, res: overflowRes, convId: conv.id, heartbeatMs: 999_999, fallbackPollMs: 999_999 });
  assert.equal(overflowRes.status, 503);
  const parsed = JSON.parse(overflowRes.text());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /too many concurrent streams for this conversation/);

  for (const res of opened) res._emitClose();
});

test('F6 SECURITY: a released slot (stream closed) is reusable — the cap is a live count, not a lifetime ceiling', () => {
  const conv = createConversation({ project: 'demo-project' });
  const { MAX_STREAMS_PER_CONVERSATION } = _conversationStreamCapConstantsForTests();
  const opened = [];
  for (let i = 0; i < MAX_STREAMS_PER_CONVERSATION; i++) {
    const req = makeFakeReq();
    const res = makeFakeRes();
    attachConversationStream({ req, res, convId: conv.id, heartbeatMs: 999_999, fallbackPollMs: 999_999 });
    opened.push(res);
  }
  // Close one — its slot must free up immediately.
  opened[0]._emitClose();

  const req = makeFakeReq();
  const res = makeFakeRes();
  attachConversationStream({ req, res, convId: conv.id, heartbeatMs: 999_999, fallbackPollMs: 999_999 });
  assert.equal(res.status, 200, 'a freed slot must be reusable by a new stream');

  for (const r of opened.slice(1)) r._emitClose();
  res._emitClose();
});

test('F6 SECURITY: the gateway-wide cap rejects a new stream on a DIFFERENT conversation once the total is reached', () => {
  const { MAX_STREAMS_TOTAL, MAX_STREAMS_PER_CONVERSATION } = _conversationStreamCapConstantsForTests();
  const conversations = [];
  const numConvsNeeded = Math.ceil(MAX_STREAMS_TOTAL / MAX_STREAMS_PER_CONVERSATION);
  for (let c = 0; c < numConvsNeeded; c++) conversations.push(createConversation({ project: 'demo-project' }));

  const opened = [];
  let totalOpened = 0;
  outer: for (const conv of conversations) {
    for (let i = 0; i < MAX_STREAMS_PER_CONVERSATION; i++) {
      if (totalOpened >= MAX_STREAMS_TOTAL) break outer;
      const req = makeFakeReq();
      const res = makeFakeRes();
      attachConversationStream({ req, res, convId: conv.id, heartbeatMs: 999_999, fallbackPollMs: 999_999 });
      assert.equal(res.status, 200);
      opened.push(res);
      totalOpened += 1;
    }
  }
  assert.equal(totalOpened, MAX_STREAMS_TOTAL);

  // One more stream on a brand-new conversation (well under ITS OWN per-conversation cap) must
  // still be rejected — this is what proves the cap is truly gateway-wide, not just per-conversation.
  const freshConv = createConversation({ project: 'demo-project' });
  const req = makeFakeReq();
  const res = makeFakeRes();
  attachConversationStream({ req, res, convId: freshConv.id, heartbeatMs: 999_999, fallbackPollMs: 999_999 });
  assert.equal(res.status, 503);
  const parsed = JSON.parse(res.text());
  assert.match(parsed.error, /gateway-wide concurrent-stream cap reached/);

  for (const r of opened) r._emitClose();
});

test('F6: a stream whose close event fires twice releases its slot exactly once (no under-count from a double release)', () => {
  // The real risk this guards against: req 'close' AND res 'close' can both fire for the SAME
  // connection. If releaseSlot() ran twice, it would decrement the counter for ANOTHER, still-open
  // stream's slot by mistake — an under-count that would let MORE concurrent streams through than
  // the real cap allows (the opposite failure mode of a stuck-forever cap, but just as real a
  // resource-exhaustion path).
  const conv = createConversation({ project: 'demo-project' });
  const { MAX_STREAMS_PER_CONVERSATION } = _conversationStreamCapConstantsForTests();
  const opened = [];
  for (let i = 0; i < MAX_STREAMS_PER_CONVERSATION; i++) {
    const req = makeFakeReq();
    const res = makeFakeRes();
    attachConversationStream({ req, res, convId: conv.id, heartbeatMs: 999_999, fallbackPollMs: 999_999 });
    assert.equal(res.status, 200);
    opened.push(res);
  }
  // Double-fire the LAST stream's close — its own slot must free exactly once, and every OTHER
  // still-open stream's slot must be completely unaffected.
  opened[opened.length - 1]._emitClose();
  opened[opened.length - 1]._emitClose();

  const firstReplacement = makeFakeRes();
  attachConversationStream({ req: makeFakeReq(), res: firstReplacement, convId: conv.id, heartbeatMs: 999_999, fallbackPollMs: 999_999 });
  assert.equal(firstReplacement.status, 200, 'exactly one freed slot must be reusable');

  const secondReplacement = makeFakeRes();
  attachConversationStream({ req: makeFakeReq(), res: secondReplacement, convId: conv.id, heartbeatMs: 999_999, fallbackPollMs: 999_999 });
  assert.equal(secondReplacement.status, 503, 'a double-fired close must NOT free a second slot that belongs to a still-open stream');

  for (const r of opened.slice(0, -1)) r._emitClose();
  firstReplacement._emitClose();
});
