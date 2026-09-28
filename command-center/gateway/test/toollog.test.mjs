// WP-CC1 (Lead review, HIGH) — unit tests for toollog.mjs against isolated temp fixtures.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readToolLogRows,
  hasAttributedToolLogActivity,
  _resetToolLogCacheForTests,
  _TOOLLOG_MAX_FILES_FOR_TESTS,
  _TOOLLOG_MAX_BYTES_PER_FILE_FOR_TESTS,
} from '../src/toollog.mjs';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-toollog-test-'));
}

function toolLogDir(root) {
  return path.join(root, '.claude', 'forge-runs', '_toollog');
}

function writeToolLogFile(root, fileName, lines, mtimeMs) {
  const dir = toolLogDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, fileName);
  fs.writeFileSync(full, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  if (mtimeMs !== undefined) fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
  return full;
}

beforeEach(() => {
  _resetToolLogCacheForTests();
});

test('a project with no _toollog directory at all returns an honest empty array, never a crash', () => {
  const root = makeRoot();
  try {
    assert.deepEqual(readToolLogRows(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parses only {ts, agent_id} out of a real-shaped line — every other field is structurally absent', () => {
  const root = makeRoot();
  try {
    writeToolLogFile(root, 'session-a.jsonl', [
      { ts: '2026-09-28T15:29:39.271Z', session: 's1', agent_id: 'a4cc5e129029195e4', agent_type: 'integration-boss', tool: 'Bash', target: 'rm -rf /', target_kind: 'command', ok: true, ms: 187, tool_use_id: 'x', permission_mode: 'bypassPermissions' },
    ]);
    const rows = readToolLogRows(root);
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['agent_id', 'ts']);
    assert.equal(rows[0].ts, '2026-09-28T15:29:39.271Z');
    assert.equal(rows[0].agent_id, 'a4cc5e129029195e4');
    // the privacy bound is structural, not just "happens to be absent" — assert the dangerous
    // fields are nowhere in the serialized row even if a future edit added them back accidentally
    const serialized = JSON.stringify(rows[0]);
    assert.doesNotMatch(serialized, /rm -rf|Bash|bypassPermissions|tool_use_id/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Lead-level row (agent_id:null) is preserved as null, not dropped', () => {
  const root = makeRoot();
  try {
    writeToolLogFile(root, 'session-a.jsonl', [
      { ts: '2026-09-28T15:00:00.000Z', agent_id: null, tool: 'Write', target: '/x' },
    ]);
    const rows = readToolLogRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_id, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed JSON line and a line missing ts are both skipped, never a crash', () => {
  const root = makeRoot();
  try {
    const dir = toolLogDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session-a.jsonl'),
      [
        '{not valid json',
        JSON.stringify({ agent_id: 'x' }), // no ts
        JSON.stringify({ ts: '2026-09-28T15:00:00.000Z', agent_id: 'good-row' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const rows = readToolLogRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_id, 'good-row');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only the newest MAX_FILES files (by mtime) are read — an older 4th+ file is excluded', () => {
  assert.equal(_TOOLLOG_MAX_FILES_FOR_TESTS, 3, 'sanity check on the bound this test proves');
  const root = makeRoot();
  try {
    const base = Date.parse('2026-09-28T00:00:00.000Z');
    writeToolLogFile(root, 'oldest.jsonl', [{ ts: '2026-09-01T00:00:00.000Z', agent_id: 'oldest' }], base - 4000);
    writeToolLogFile(root, 'b.jsonl', [{ ts: '2026-09-02T00:00:00.000Z', agent_id: 'b' }], base - 3000);
    writeToolLogFile(root, 'c.jsonl', [{ ts: '2026-09-03T00:00:00.000Z', agent_id: 'c' }], base - 2000);
    writeToolLogFile(root, 'newest.jsonl', [{ ts: '2026-09-04T00:00:00.000Z', agent_id: 'newest' }], base - 1000);
    const rows = readToolLogRows(root);
    const ids = rows.map((r) => r.agent_id).sort();
    assert.deepEqual(ids, ['b', 'c', 'newest'], 'exactly the 3 newest files contribute rows, the oldest is excluded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only the last MAX_BYTES_PER_FILE bytes of a large file are read, and the likely-partial first line is dropped', () => {
  const root = makeRoot();
  try {
    const dir = toolLogDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, 'big.jsonl');
    // pad well past the 512KB bound with real, parseable filler rows, so a naive "read whole file"
    // implementation would see them but the bounded tail-read must not.
    const filler = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', agent_id: 'filler' });
    const fillerLine = filler + '\n';
    // Padded to 20x the bound so the last-512KB tail read can only ever see ~1/20th of these rows
    // at most — a generous margin over the exact ratio, since line boundaries don't align perfectly.
    const paddingBytes = _TOOLLOG_MAX_BYTES_PER_FILE_FOR_TESTS * 20;
    const repeats = Math.ceil(paddingBytes / Buffer.byteLength(fillerLine));
    const fd = fs.openSync(full, 'w');
    for (let i = 0; i < repeats; i++) fs.writeSync(fd, fillerLine);
    fs.writeSync(fd, JSON.stringify({ ts: '2026-09-28T15:00:00.000Z', agent_id: 'tail-row' }) + '\n');
    fs.closeSync(fd);

    const rows = readToolLogRows(root);
    assert.ok(rows.some((r) => r.agent_id === 'tail-row'), 'the real, recent tail row must be present');
    // The vast majority of filler rows must be excluded by the byte bound — only whatever tiny
    // sliver falls inside the last 512KB (plus the dropped-as-partial first line) could remain.
    const fillerCount = rows.filter((r) => r.agent_id === 'filler').length;
    const totalFillerLines = repeats;
    assert.ok(fillerCount < totalFillerLines / 5, `expected the byte bound to exclude nearly all ${totalFillerLines} filler rows, got ${fillerCount} still present`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cached for ~5s — a file rewritten immediately after the first call does not change the result within the TTL', () => {
  const root = makeRoot();
  try {
    writeToolLogFile(root, 'session-a.jsonl', [{ ts: '2026-09-28T15:00:00.000Z', agent_id: 'first' }]);
    const rowsFirst = readToolLogRows(root, 1000);
    assert.equal(rowsFirst.length, 1);
    assert.equal(rowsFirst[0].agent_id, 'first');

    // Rewrite the file with different content, but call again well inside the 5s TTL window.
    writeToolLogFile(root, 'session-a.jsonl', [{ ts: '2026-09-28T16:00:00.000Z', agent_id: 'second' }]);
    const rowsCached = readToolLogRows(root, 2000); // 1s later, still < 5s TTL
    assert.deepEqual(rowsCached, rowsFirst, 'a call within the TTL must reuse the cached rows, not re-read the file');

    const rowsFresh = readToolLogRows(root, 7000); // past the 5s TTL from the first call
    assert.equal(rowsFresh[0].agent_id, 'second', 'a call past the TTL must see the real, current file content');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// WP-CC1 (Lead review round 2 — "heartbeat fallback") — hasAttributedToolLogActivity().
const NOW = Date.parse('2026-09-28T18:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

test('hasAttributedToolLogActivity: true when a real attributed row exists within 24h', () => {
  const rows = [{ ts: new Date(NOW - 1 * HOUR).toISOString(), agent_id: 'd1' }];
  assert.equal(hasAttributedToolLogActivity(rows, NOW), true);
});

test('hasAttributedToolLogActivity: false when every row has agent_id:null (attribution genuinely off)', () => {
  const rows = [
    { ts: new Date(NOW - 1 * MIN).toISOString(), agent_id: null },
    { ts: new Date(NOW - 2 * MIN).toISOString(), agent_id: null },
  ];
  assert.equal(hasAttributedToolLogActivity(rows, NOW), false);
});

test('hasAttributedToolLogActivity: false when the only attributed row is older than 24h', () => {
  const rows = [{ ts: new Date(NOW - 25 * HOUR).toISOString(), agent_id: 'd1' }];
  assert.equal(hasAttributedToolLogActivity(rows, NOW), false);
});

test('hasAttributedToolLogActivity: false on an empty row list', () => {
  assert.equal(hasAttributedToolLogActivity([], NOW), false);
});
