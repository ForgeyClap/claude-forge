// Unit tests for fix-ghost-asks item 2 (forge-2026-07-30-cc-finish, work package fix-ghost-asks) —
// the gateway-restart boot scan. `findDanglingAskIds` is tested as pure detection logic;
// `runAskBootScan` is tested against REAL JSONL fixture files written to a temp conversations dir,
// adapted from the actual shape measured on this project's own dangling records
// (`command-center/.data/conversations/c-ms7cqy79-882524f6.jsonl` — an `ask_questions` event
// followed only by a `stopped_by_user` event and a final assistant turn, with NO
// ask_answered/ask_timed_out/ask_abandoned resolution — exactly the ten records
// DIAGNOSE-2026-07-30-spookvragen.md found on this project's own real gateway).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findDanglingAskIds,
  runAskBootScan,
  MAX_BOOT_SCAN_FILES,
  MAX_BOOT_SCAN_TOTAL_BYTES,
  _setBootScanLimitsForTests,
  _resetBootScanLimitsForTests,
} from '../src/ask-boot-scan.mjs';
import { _setConversationsDirForTests, _resetConversationsForTests, readConversation } from '../src/conversations.mjs';

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ask-boot-scan-test-'));
  _setConversationsDirForTests(tempDir);
});

afterEach(() => {
  _resetConversationsForTests();
  _resetBootScanLimitsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function writeRealShapedConversation(id, { askId, resolutionLine = null }) {
  // Adapted (not copied verbatim) from the real dangling record shape measured live on
  // c-ms7cqy79-882524f6.jsonl: meta -> user turn -> assistant tool_use (ask_owner) -> ask_questions
  // event -> stopped_by_user -> a final assistant turn with exit_code:1 and real shell_commands. The
  // exact field VALUES here are synthetic; the STRUCTURE (record types, event kinds, field names)
  // matches what this project's own real gateway actually wrote.
  const lines = [
    JSON.stringify({ type: 'meta', conversation_id: id, project: 'demo-project', title: 'Dashboard intake', created_at: '2026-07-30T10:00:00.000Z' }),
    JSON.stringify({ type: 'turn', turn_id: 't-1', request_id: 'req-1', role: 'user', text: 'Build me a dashboard', mode: 'execute', effort: null, model: null, created_at: '2026-07-30T10:00:01.000Z' }),
    JSON.stringify({
      type: 'event',
      created_at: '2026-07-30T10:00:54.499Z',
      turn_id: 't-1',
      request_id: 'req-1',
      kind: 'ask_questions',
      data: {
        id: askId,
        questions: [{ header: 'Which business', question: 'Is this for the same business?', options: ['Yes', 'No — a different one'], multiSelect: false }],
        timeout_ms: 1800000,
      },
    }),
  ];
  if (resolutionLine) lines.push(JSON.stringify(resolutionLine));
  lines.push(JSON.stringify({ type: 'event', created_at: '2026-07-30T10:01:27.258Z', turn_id: 't-1', request_id: 'req-1', kind: 'stopped_by_user' }));
  lines.push(JSON.stringify({
    type: 'turn', role: 'assistant', created_at: '2026-07-30T10:01:27.348Z', turn_id: 't-1', request_id: 'req-1',
    text: '', cost_usd: null, duration_ms: null, stop_reason: null, exit_code: 1, error: null,
  }));
  fs.writeFileSync(path.join(tempDir, id + '.jsonl'), lines.join('\n') + '\n', 'utf8');
}

test('findDanglingAskIds: an ask_questions with no later resolution of any kind is dangling', () => {
  const records = [
    { type: 'event', kind: 'ask_questions', turn_id: 't-1', request_id: 'req-1', data: { id: 'ask-1', questions: [] } },
    { type: 'event', kind: 'stopped_by_user' },
  ];
  assert.deepEqual(findDanglingAskIds(records), [{ id: 'ask-1', turnId: 't-1', requestId: 'req-1' }]);
});

test('findDanglingAskIds: ask_answered/ask_timed_out/ask_abandoned each resolve their own matching id', () => {
  for (const kind of ['ask_answered', 'ask_timed_out', 'ask_abandoned']) {
    const records = [
      { type: 'event', kind: 'ask_questions', data: { id: 'ask-1' } },
      { type: 'event', kind, data: { id: 'ask-1' } },
    ];
    assert.deepEqual(findDanglingAskIds(records), [], 'kind=' + kind + ' must resolve the matching ask');
  }
});

test('findDanglingAskIds: a resolution for a DIFFERENT id never resolves this one', () => {
  const records = [
    { type: 'event', kind: 'ask_questions', data: { id: 'ask-1' } },
    { type: 'event', kind: 'ask_answered', data: { id: 'ask-other' } },
  ];
  assert.deepEqual(findDanglingAskIds(records), [{ id: 'ask-1', turnId: null, requestId: null }]);
});

test('findDanglingAskIds: multiple ask_questions in one file — only the ones without their OWN resolution are dangling', () => {
  const records = [
    { type: 'event', kind: 'ask_questions', data: { id: 'ask-1' } },
    { type: 'event', kind: 'ask_answered', data: { id: 'ask-1' } },
    { type: 'event', kind: 'ask_questions', data: { id: 'ask-2' } },
  ];
  assert.deepEqual(findDanglingAskIds(records), [{ id: 'ask-2', turnId: null, requestId: null }]);
});

test('findDanglingAskIds: never throws on malformed records (non-object, missing data, non-string id)', () => {
  assert.deepEqual(findDanglingAskIds([null, undefined, { type: 'turn' }, { type: 'event', kind: 'ask_questions' }, { type: 'event', kind: 'ask_questions', data: { id: 42 } }]), []);
});

test('runAskBootScan: closes out a real dangling ask (adapted from this project\'s own measured record shape) with reason gateway_restart, appending exactly one honest event', () => {
  writeRealShapedConversation('c-dangling-1', { askId: 'ask-real-1' });

  const warnings = [];
  const result = runAskBootScan({ warn: (m) => warnings.push(m) });
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.skippedFiles, 0);
  assert.equal(result.abandonedCount, 1);

  const full = readConversation('c-dangling-1');
  const abandonedEvt = full.events.find((e) => e.kind === 'ask_abandoned');
  assert.ok(abandonedEvt, 'a real ask_abandoned event must be appended');
  assert.equal(abandonedEvt.data.id, 'ask-real-1');
  assert.equal(abandonedEvt.data.reason, 'gateway_restart');
  assert.equal(abandonedEvt.turn_id, 't-1');
  assert.equal(abandonedEvt.request_id, 'req-1');
});

test('runAskBootScan: a conversation whose ask was already answered is left completely untouched', () => {
  writeRealShapedConversation('c-answered-1', {
    askId: 'ask-real-2',
    resolutionLine: { type: 'event', created_at: '2026-07-30T10:01:00.000Z', turn_id: 't-1', request_id: 'req-1', kind: 'ask_answered', data: { id: 'ask-real-2', answers: [{ question: 'Q', answer: 'Yes' }] } },
  });

  const result = runAskBootScan({ warn: () => {} });
  assert.equal(result.abandonedCount, 0);
  const full = readConversation('c-answered-1');
  assert.ok(!full.events.some((e) => e.kind === 'ask_abandoned'));
});

test('IDEMPOTENCE: running the scan TWICE never double-appends ask_abandoned for the same ask', () => {
  writeRealShapedConversation('c-dangling-2', { askId: 'ask-real-3' });

  const first = runAskBootScan({ warn: () => {} });
  assert.equal(first.abandonedCount, 1);
  const second = runAskBootScan({ warn: () => {} });
  assert.equal(second.abandonedCount, 0, 'the second run must see its own first-run ask_abandoned event as a real resolution and abandon nothing new');

  const full = readConversation('c-dangling-2');
  const abandonedEvents = full.events.filter((e) => e.kind === 'ask_abandoned');
  assert.equal(abandonedEvents.length, 1, 'exactly one ask_abandoned event on disk, never duplicated');
});

test('BOUNDED (file count): a scan capped at 1 file scans exactly 1 and skips the rest, warning honestly about it', () => {
  writeRealShapedConversation('c-a', { askId: 'ask-a' });
  writeRealShapedConversation('c-b', { askId: 'ask-b' });
  writeRealShapedConversation('c-c', { askId: 'ask-c' });
  _setBootScanLimitsForTests({ maxFiles: 1 });

  const warnings = [];
  const result = runAskBootScan({ warn: (m) => warnings.push(m) });
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.skippedFiles, 2);
  assert.equal(result.abandonedCount, 1, 'only the one scanned file gets resolved this boot');
  assert.ok(warnings.some((w) => w.includes('skipped 2')), 'a real, honest warning must name how many files were skipped');
});

test('BOUNDED (total bytes): a byte budget smaller than the fixture file skips it entirely rather than reading a truncated/partial file', () => {
  writeRealShapedConversation('c-big', { askId: 'ask-big' });
  const realSize = fs.statSync(path.join(tempDir, 'c-big.jsonl')).size;
  _setBootScanLimitsForTests({ maxBytes: realSize - 1 }); // strictly smaller than the one real file

  const warnings = [];
  const result = runAskBootScan({ warn: (m) => warnings.push(m) });
  assert.equal(result.scannedFiles, 0);
  assert.equal(result.skippedFiles, 1);
  assert.equal(result.abandonedCount, 0);
  assert.ok(warnings.length > 0);

  // The dangling ask is still genuinely dangling (never partially/incorrectly resolved) — a LATER
  // scan with a normal budget must still be able to catch it.
  _resetBootScanLimitsForTests();
  const later = runAskBootScan({ warn: () => {} });
  assert.equal(later.abandonedCount, 1);
});

test('NEVER CRASHES: a missing conversations directory degrades to a warning and an honest empty result, never a thrown error', () => {
  _setConversationsDirForTests(path.join(tempDir, 'does-not-exist-at-all'));
  const warnings = [];
  const result = runAskBootScan({ warn: (m) => warnings.push(m) });
  assert.deepEqual(result, { scannedFiles: 0, skippedFiles: 0, abandonedCount: 0 });
  assert.ok(warnings.length > 0);
});

test('a non-.jsonl file and a directory entry in the conversations dir are silently ignored, never crash the scan', () => {
  writeRealShapedConversation('c-real', { askId: 'ask-real-4' });
  fs.writeFileSync(path.join(tempDir, 'not-a-conversation.txt'), 'hello');
  fs.mkdirSync(path.join(tempDir, 'some-subdir'));

  const result = runAskBootScan({ warn: () => {} });
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.abandonedCount, 1);
});

test('constants stay real, positive, and generous enough to cover this project\'s own real store today (32 real conversation files, largest ~3.3MB, measured 2026-07-30)', () => {
  assert.ok(MAX_BOOT_SCAN_FILES >= 100);
  assert.ok(MAX_BOOT_SCAN_TOTAL_BYTES >= 10 * 1024 * 1024);
});
