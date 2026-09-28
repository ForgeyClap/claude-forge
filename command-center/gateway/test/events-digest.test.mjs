// Codex review 2026-09-28 (R1): the run-log fingerprint a finalize receipt is checked against.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { eventsLogFingerprint, _resetEventsLogFingerprintCacheForTests, _setEventsLogClockForTests } from '../src/events-digest.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmpRunDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-evdigest-'));
  dirs.push(d);
  return d;
}

test('a missing log is reported as missing, never as a guessed fingerprint', () => {
  assert.deepEqual(eventsLogFingerprint(tmpRunDir()), { state: 'missing' });
});

test('the fingerprint is the real sha256 and byte size of events.jsonl', () => {
  const d = tmpRunDir();
  const body = '{"event_type":"run_started"}\n';
  fs.writeFileSync(path.join(d, 'events.jsonl'), body);
  const fp = eventsLogFingerprint(d);
  assert.equal(fp.state, 'ok');
  assert.equal(fp.bytes, Buffer.byteLength(body));
  assert.equal(fp.digest, crypto.createHash('sha256').update(body).digest('hex'));
});

test('an equal-length edit with a new modification time gives a new digest (the cache never hides it)', () => {
  _resetEventsLogFingerprintCacheForTests();
  const d = tmpRunDir();
  const f = path.join(d, 'events.jsonl');
  fs.writeFileSync(f, '{"event_type":"check_passed"}\n');
  const before = eventsLogFingerprint(d);
  fs.writeFileSync(f, '{"event_type":"check_failed"}\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  const afterEdit = eventsLogFingerprint(d);
  assert.equal(before.bytes, afterEdit.bytes);
  assert.notEqual(before.digest, afterEdit.digest);
});

test('a folder in place of the log is unreadable, never ok', () => {
  const d = tmpRunDir();
  fs.mkdirSync(path.join(d, 'events.jsonl'));
  assert.equal(eventsLogFingerprint(d).state, 'unreadable');
});

// Codex verification of R1 (N1): timestamps are not a content identity, so a cached digest is provisional —
// even when every metadata field looks unchanged (a timestamp collision, simulated here), the log is hashed
// again once the cache entry is older than a minute.
test('N1: a cached digest is provisional — after 60 s the log is hashed again even when its metadata looks unchanged', () => {
  _resetEventsLogFingerprintCacheForTests();
  const d = tmpRunDir();
  const f = path.join(d, 'events.jsonl');
  fs.writeFileSync(f, '{"event_type":"check_passed"}\n');
  let t = 1_000_000;
  _setEventsLogClockForTests(() => t);
  const frozen = fs.statSync(f);
  const realStat = fs.statSync;
  fs.statSync = (p, ...rest) => (path.resolve(String(p)) === path.resolve(f) ? frozen : realStat(p, ...rest));
  try {
    const first = eventsLogFingerprint(d);
    fs.writeFileSync(f, '{"event_type":"check_failed"}\n'); // same length; the stat above stays frozen
    t += 30_000;
    assert.equal(eventsLogFingerprint(d).digest, first.digest, 'within the minute the provisional cache may still answer');
    t += 31_000;
    const again = eventsLogFingerprint(d);
    assert.notEqual(again.digest, first.digest, 'after the minute the real content is hashed again');
    assert.equal(again.digest, crypto.createHash('sha256').update('{"event_type":"check_failed"}\n').digest('hex'));
  } finally {
    fs.statSync = realStat;
    _setEventsLogClockForTests(null);
    _resetEventsLogFingerprintCacheForTests();
  }
});

// Codex verification of R1 (N4): the size bound and the read are one consistent operation.
test('N4: a log that changes while it is being read is unreadable, never ok', () => {
  _resetEventsLogFingerprintCacheForTests();
  const d = tmpRunDir();
  const f = path.join(d, 'events.jsonl');
  fs.writeFileSync(f, '{"event_type":"run_started"}\n');
  const realFstat = fs.fstatSync;
  let calls = 0;
  fs.fstatSync = (fd, ...rest) => {
    const st = realFstat(fd, ...rest);
    calls += 1;
    return calls === 2 ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: st.size + 10 }) : st;
  };
  try {
    assert.deepEqual(eventsLogFingerprint(d), { state: 'unreadable', reason: 'changed while being read' });
  } finally {
    fs.fstatSync = realFstat;
  }
});

test('N4: a log over the 64 MB bound is not verifiable, never read whole', () => {
  _resetEventsLogFingerprintCacheForTests();
  const d = tmpRunDir();
  const f = path.join(d, 'events.jsonl');
  fs.writeFileSync(f, 'x\n');
  const realStat = fs.statSync;
  const big = Object.assign(Object.create(Object.getPrototypeOf(realStat(f))), realStat(f), { size: 65 * 1024 * 1024 });
  fs.statSync = (p, ...rest) => (path.resolve(String(p)) === path.resolve(f) ? big : realStat(p, ...rest));
  try {
    assert.deepEqual(eventsLogFingerprint(d), { state: 'unreadable', reason: 'too large to verify' });
  } finally {
    fs.statSync = realStat;
  }
});
