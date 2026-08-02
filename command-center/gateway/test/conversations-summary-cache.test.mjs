// P2-12 fix (cc-fix-gateway-perf, forge-2026-07-29-cc-finish): listConversations() used to fully
// read + JSON.parse + redactDeep EVERY line of EVERY conversation file on EVERY call — two separate
// pollers call this endpoint (~27x/minute, see the forge-report for this WP). Now cached on real
// file identity (path, mtimeMs, size). These tests prove an unchanged file is never re-read, a real
// append is correctly detected, and the cache stays bounded.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  listConversations,
  appendUserTurn,
  _setConversationsDirForTests,
  _resetConversationsForTests,
  _resetConversationsSummaryCacheForTests,
  _conversationsSummaryCacheSizeForTests,
  _CONVERSATIONS_SUMMARY_MAX_CACHE_ENTRIES_FOR_TESTS,
} from '../src/conversations.mjs';

let tempDir;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-conv-summary-cache-test-'));
  _setConversationsDirForTests(tempDir);
});

after(() => {
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  _resetConversationsSummaryCacheForTests();
});

test('a repeat listConversations() call on unchanged files reuses the cached summary (no re-read)', () => {
  const a = createConversation({ project: 'proj-a', title: 'first' });
  const filePath = path.join(tempDir, a.id + '.jsonl');

  const realReadFileSync = fs.readFileSync;
  let readCount = 0;
  fs.readFileSync = function patched(p, ...rest) {
    if (p === filePath) readCount += 1;
    return realReadFileSync.call(fs, p, ...rest);
  };
  try {
    const first = listConversations();
    assert.equal(first.length, 1);
    assert.equal(readCount, 1, 'the first call genuinely reads the file once (cold cache)');

    for (let i = 0; i < 5; i++) listConversations();
    assert.equal(readCount, 1, 'FIX: an unchanged conversation file is never re-read on subsequent polls');
  } finally {
    fs.readFileSync = realReadFileSync;
  }
});

test('a genuine append (new size/mtime) is correctly re-summarized, never serving a stale turn_count', () => {
  const a = createConversation({ project: 'proj-a' });
  const before1 = listConversations();
  assert.equal(before1[0].turn_count, 0);

  appendUserTurn(a.id, 'hello');
  const after1 = listConversations();
  assert.equal(after1[0].turn_count, 1, 'the cache correctly detected the real size/mtime change from the append');
});

test('the summary cache stays bounded (FIFO-evicted) across more distinct conversation files than the hard cap', () => {
  const overflow = 15;
  const total = _CONVERSATIONS_SUMMARY_MAX_CACHE_ENTRIES_FOR_TESTS + overflow;
  for (let i = 0; i < total; i++) {
    createConversation({ project: 'proj-bulk-' + i });
  }
  listConversations();
  assert.ok(_conversationsSummaryCacheSizeForTests() <= _CONVERSATIONS_SUMMARY_MAX_CACHE_ENTRIES_FOR_TESTS, 'cache size must never exceed the hard cap');
  assert.equal(_conversationsSummaryCacheSizeForTests(), _CONVERSATIONS_SUMMARY_MAX_CACHE_ENTRIES_FOR_TESTS, 'the cap is genuinely reached, not just never-hit by coincidence');
});
