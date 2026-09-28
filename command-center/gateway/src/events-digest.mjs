// Codex review 2026-09-28 (R1): the fingerprint of a run's events.jsonl — its byte size and sha256 —
// so a finalize receipt is checked against the log's real CONTENT, not only its length (an equal-length
// edit such as check_passed -> check_failed kept the length). Callers only ask for runs that HAVE a
// receipt. Read-only; never writes anything.
//
// Codex verification of that fix (N1, N4): file timestamps are not a content identity, so a cached digest
// is only PROVISIONAL — reused while the file's identity (dev, ino) and metadata (size, mtime, ctime) are
// unchanged AND for at most CACHE_TTL_MS, then the log is hashed again; and the read goes through ONE
// descriptor with a hard byte bound and a before/after consistency check, so a file that grows, shrinks or
// is replaced while it is read is reported as unreadable, never as "ok". The dashboard's "finalized" is
// informational; `.claude/forge-bin/forge-finalize.cjs check` stays the authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A log bigger than this is reported as not verifiable (the receipt then does not count) rather than
// read whole on a dashboard poll; real run logs are a few MB at most.
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 2000;
const CACHE_TTL_MS = 60_000;
const cache = new Map();
let nowFn = () => Date.now();

const unreadable = (reason) => ({ state: 'unreadable', reason });
const codeOf = (err) => String((err && err.code) || err);

function sameFile(entry, st) {
  return entry.size === st.size && entry.mtimeMs === st.mtimeMs && entry.ctimeMs === st.ctimeMs
    && entry.ino === st.ino && entry.dev === st.dev;
}

// The whole file through one descriptor, never more than MAX_HASH_BYTES, and only when it did not change
// while being read.
function readWhole(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    return err && err.code === 'ENOENT' ? { state: 'missing' } : unreadable(codeOf(err));
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) return unreadable('not a file');
    if (before.size > MAX_HASH_BYTES) return unreadable('too large to verify');
    const buf = Buffer.alloc(before.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    const grew = fs.readSync(fd, Buffer.alloc(1), 0, 1, buf.length) > 0;
    const after = fs.fstatSync(fd);
    if (off !== buf.length || grew || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return unreadable('changed while being read');
    }
    return { state: 'ok', bytes: buf.length, digest: crypto.createHash('sha256').update(buf).digest('hex'), stat: after };
  } catch (err) {
    return unreadable(codeOf(err));
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * eventsLogFingerprint(runDir) -> {state:'ok', bytes, digest} | {state:'missing'} |
 * {state:'unreadable', reason}. `missing` only for a genuinely absent file (ENOENT); anything else that
 * stops a full, consistent read is `unreadable`, never a guessed fingerprint.
 */
export function eventsLogFingerprint(runDir) {
  const file = path.join(runDir, 'events.jsonl');
  let st;
  try {
    st = fs.statSync(file);
  } catch (err) {
    return err && err.code === 'ENOENT' ? { state: 'missing' } : unreadable(codeOf(err));
  }
  if (!st.isFile()) return unreadable('not a file');
  if (st.size > MAX_HASH_BYTES) return unreadable('too large to verify');
  const hit = cache.get(file);
  if (hit && sameFile(hit, st) && nowFn() - hit.at < CACHE_TTL_MS) {
    return { state: 'ok', bytes: hit.size, digest: hit.digest };
  }
  const read = readWhole(file);
  if (read.state !== 'ok') {
    cache.delete(file);
    return read;
  }
  if (!cache.has(file) && cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  const s = read.stat;
  cache.set(file, { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino, dev: s.dev, digest: read.digest, at: nowFn() });
  return { state: 'ok', bytes: read.bytes, digest: read.digest };
}

export function _resetEventsLogFingerprintCacheForTests() {
  cache.clear();
}

export function _setEventsLogClockForTests(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}
