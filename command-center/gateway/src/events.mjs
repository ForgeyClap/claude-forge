// Per-run event tailing: incremental byte-offset reads (R1 fix, WP3 T3.1-T3.10 architecture
// review) plus a real SSE tail-follow endpoint. The OLD version re-read and re-parsed the ENTIRE
// events.jsonl on every poll — wasteful and growing linearly with a run's history. Now a
// per-eventsPath in-memory cache tracks exactly how many bytes of the file have been consumed;
// each sync only reads the bytes appended since the LAST read (fs.stat size + fs.readSync from
// that byte offset), never the whole file again. A trailing partial line (a write caught
// mid-append) is buffered and completed on the next sync rather than dropped or mis-parsed.
//
// `readEvents()` keeps its EXACT prior external contract (line-count based `after`/`next_after`,
// same fields) — this is what the existing /api/events polling route and its regression test
// depend on. `attachEventsStream()` is new: a real text/event-stream endpoint that replays any
// backlog (from a reconnecting client's `Last-Event-ID` byte offset, or from the start) and then
// tails the file live via fs.watch, with a heartbeat and a small fallback poll as a safety net
// (fs.watch is not 100% reliable on every platform/filesystem — see comment below).
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk, safeIdOk } from './security.mjs';
import { redactDeep } from './redact.mjs';

// Map<absoluteEventsPath, CacheEntry>. CacheEntry = {
//   size: number,                 // bytes of the file incorporated so far (== file size as of last sync)
//   lineRecords: Array<{ startOffset, endOffset, ok, event }>, // one entry per non-empty line CURRENTLY
//                                  // held in memory — see MAX_LINE_RECORDS_PER_ENTRY below; the run's
//                                  // EARLIEST lines may have been dropped from the front to stay bounded.
//   droppedLineCount: number,     // how many of this run's earliest lines were evicted from lineRecords
//                                  // to respect MAX_LINE_RECORDS_PER_ENTRY — added back to
//                                  // lineRecords.length to recover the TRUE cumulative line count that
//                                  // readEvents()'s total_lines/next_after (a line-count cursor) needs.
//   tailBuf: Buffer,              // trailing bytes not yet forming a complete (\n-terminated) line
//   ino: number, dev: number,     // real file identity (fs.statSync) — a change forces a rebuild
//   generation: number,           // increments on every rebuild (full rebuild OR a line-cap trim); lets
//                                  // an open SSE tail detect it must reset its {generation,index} cursor
//   truncated: boolean,           // true once EITHER a delta read had to be capped (MAX_DELTA_READ_BYTES)
//                                  // OR the per-entry line cap (MAX_LINE_RECORDS_PER_ENTRY) dropped old
//                                  // lines — either way, the honest meaning is the same: this run's full
//                                  // history is no longer entirely available from this in-memory cache.
// }
const CACHE = new Map();

// P1-4 fix (cc-fix-gateway-perf, forge-2026-07-29-cc-finish): CACHE above used to grow WITHOUT BOUND —
// every run whose events.jsonl was ever touched (one poll, one SSE connect) kept its ENTIRE parsed
// event history pinned in memory for the rest of the gateway process's life; the only `delete` was an
// unreachable-in-practice statSync-throws branch. The gateway is a long-lived local daemon serving a
// growing multi-project fleet, so "today's runs are small" is not itself a bound. Two independent
// caps, mirrored from the already-reviewed pattern in tools.mjs (WP10 F4, `MAX_CACHE_ENTRIES` + FIFO
// eviction) rather than inventing a new mechanism:
//   1. MAX_CACHE_ENTRIES bounds how many DISTINCT run event files stay cached at once. Eviction here
//      is LRU, not plain insertion-order FIFO like tools.mjs: every syncCache() call (a poll OR a live
//      SSE tail's checkForNew()) "touches" its entry to the most-recently-used end of the Map (a Map
//      preserves insertion order; delete()+set() re-inserts at the end) via touchCache() below, so an
//      actively-watched run can never be evicted out from under an open connection just because OTHER
//      runs were queried in between — only genuinely idle entries age out.
//   2. MAX_LINE_RECORDS_PER_ENTRY bounds how many parsed event objects ONE run's cache entry can hold
//      at once, independent of cap #1 — protects against a single pathologically chatty run. When
//      exceeded, the OLDEST records are dropped from the front (never the newest — a live tail must
//      keep seeing new events as they arrive). This reuses the EXISTING `truncated` signal already
//      surfaced to callers via readEvents()'s `truncated` field (and, per the same backlog's P1
//      finding #1, now shown in the UI) instead of inventing a second flag.
const MAX_CACHE_ENTRIES = 100;
export const MAX_LINE_RECORDS_PER_ENTRY = 5000;

// Moves `key` to the most-recently-used end of CACHE and evicts the least-recently-used entry first
// if `key` is a genuinely NEW key that would push the cache over MAX_CACHE_ENTRIES. Touching an
// EXISTING key (the common case — a repeat poll/tail-check on a run already being watched) never
// evicts anything, so a hot run's own re-syncs can never trigger its own eviction.
function touchCache(key, entry) {
  if (CACHE.has(key)) {
    CACHE.delete(key);
  } else {
    while (CACHE.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = CACHE.keys().next().value;
      CACHE.delete(oldestKey);
    }
  }
  CACHE.set(key, entry);
}

function stripTrailingCR(buf) {
  return buf.length > 0 && buf[buf.length - 1] === 0x0D ? buf.subarray(0, buf.length - 1) : buf;
}

// Splits `newBuf` (bytes read starting at file offset `readStartOffset`) into complete lines,
// appending each non-empty one to entry.lineRecords with its real byte-range in the file. Splits
// on the raw byte 0x0A ('\n') — always safe on a UTF-8 buffer, since 0x0A can never appear as
// part of a multi-byte UTF-8 sequence (continuation bytes are 0x80-0xBF, lead bytes 0xC0-0xFF).
function appendLines(entry, newBuf, readStartOffset) {
  const combined = entry.tailBuf.length ? Buffer.concat([entry.tailBuf, newBuf]) : newBuf;
  const combinedStartOffset = readStartOffset - entry.tailBuf.length;
  let lineStart = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] !== 0x0A) continue;
    const startOffset = combinedStartOffset + lineStart;
    const endOffset = combinedStartOffset + i + 1; // includes the '\n'
    const raw = stripTrailingCR(combined.subarray(lineStart, i));
    const text = raw.toString('utf8');
    if (text.trim().length > 0) {
      let ok = true; let event = null;
      try { event = JSON.parse(text); } catch { ok = false; }
      entry.lineRecords.push({ startOffset, endOffset, ok, event });
    }
    lineStart = i + 1;
  }
  entry.tailBuf = combined.subarray(lineStart);
}

// Defensive cap on a single delta read (Security Boss AP-6 finding: the old Buffer.alloc(deltaLen)
// was unbounded). A poll/tail-check that discovers more new bytes than this since the last sync
// reads only the FINAL MAX_DELTA_READ_BYTES bytes of the new region instead of allocating an
// unbounded buffer. Bytes before that window are honestly reported as lost via
// `entry.truncated = true` (surfaced to callers as `truncated: true`) — never silently dropped
// without a signal, and never presented as a complete read. Exported so tests can reference the
// exact real cap instead of duplicating the literal.
export const MAX_DELTA_READ_BYTES = 8 * 1024 * 1024; // 8MB

// Reads only the bytes appended since the last sync (or the whole file, once, on a cold cache /
// after a rebuild) and updates the in-memory line index. Returns the CacheEntry, or null if the
// file does not exist.
//
// Two independent, real on-disk failure modes (WP12 chaos-testing findings, fixed here in
// cc-fix-events / WP8-13) are guarded against, not just a byte-shrink:
//   1. FABRICATION (WP12 Finding 2): a delete+replace whose new size is >= the previously cached
//      size used to be indistinguishable from a normal in-place append, so the incremental reader
//      kept serving the OLD (deleted) file's already-cached lineRecords as current. Fix: track the
//      file's real identity (ino + dev from fs.statSync — verified live on this Windows/NTFS host
//      to change reliably across unlink+recreate, INCLUDING when the replacement size is equal to
//      or larger than the original; `birthtimeMs` was ALSO probed and found UNRELIABLE here —
//      Windows NTFS "tunnels" and reuses the original creation timestamp for a file recreated
//      shortly after deletion at the same path, so it is deliberately NOT part of this check)
//      alongside the existing byte-shrink check. Either signal changing forces a full rebuild.
//   2. STALE SSE TAIL (WP12 Finding 1): every rebuild bumps `entry.generation` so an already-open
//      attachEventsStream() connection (which tracks its own {generation, index} cursor) can tell
//      it must reset its cursor to 0 against the rebuilt array, instead of comparing its old sent
//      count against a shorter/different array forever (see attachEventsStream() below).
function syncCache(eventsPath) {
  let stat;
  try { stat = fs.statSync(eventsPath); } catch { CACHE.delete(eventsPath); return null; }
  let entry = CACHE.get(eventsPath);
  const sameIdentity = !!entry && entry.ino === stat.ino && entry.dev === stat.dev;
  const shrank = !!entry && stat.size < entry.size;
  const priorGeneration = entry ? entry.generation : -1;
  if (entry && (!sameIdentity || shrank)) entry = undefined; // different file (ino/dev changed) or shrank — never trust stale offsets/identity
  if (!entry) {
    entry = {
      size: 0,
      lineRecords: [],
      droppedLineCount: 0,
      tailBuf: Buffer.alloc(0),
      ino: stat.ino,
      dev: stat.dev,
      generation: priorGeneration + 1,
      truncated: false,
    };
  }
  if (stat.size > entry.size) {
    const oldSize = entry.size;
    let deltaLen = stat.size - oldSize;
    let readStart = oldSize;
    if (deltaLen > MAX_DELTA_READ_BYTES) {
      readStart = stat.size - MAX_DELTA_READ_BYTES;
      deltaLen = MAX_DELTA_READ_BYTES;
      entry.tailBuf = Buffer.alloc(0); // the skipped region invalidates any pending partial-line bytes
      // Sticky for this cache entry: real history was just dropped and can never be recovered
      // without a full rebuild, so every read from this entry stays honestly marked truncated.
      entry.truncated = true;
    }
    const fd = fs.openSync(eventsPath, 'r');
    try {
      const buf = Buffer.alloc(deltaLen);
      fs.readSync(fd, buf, 0, deltaLen, readStart);
      appendLines(entry, buf, readStart);
    } finally {
      fs.closeSync(fd);
    }
    entry.size = stat.size;
  }
  // P1-4 fix, cap #2: trim the OLDEST buffered lines once this single entry exceeds
  // MAX_LINE_RECORDS_PER_ENTRY, regardless of how the entry got here (fresh rebuild or an
  // incremental append). Never trims the newest records — a live tail must keep seeing new events.
  if (entry.lineRecords.length > MAX_LINE_RECORDS_PER_ENTRY) {
    const excess = entry.lineRecords.length - MAX_LINE_RECORDS_PER_ENTRY;
    entry.lineRecords.splice(0, excess);
    entry.droppedLineCount += excess;
    entry.truncated = true;
    // A trim changes what array index N means (it used to be the Nth line ever seen; now it is the
    // (N + droppedLineCount)th) — bump generation so any open SSE tail (which tracks {generation,
    // sentIndex}, see attachEventsStream() below) detects this and resets its cursor exactly like a
    // full rebuild, resending the records still in the buffer once rather than desyncing silently.
    entry.generation += 1;
  }
  touchCache(eventsPath, entry);
  return entry;
}

// Test-only accessor: the real size of the module-level cache, without exposing the Map itself.
export function _eventsCacheSizeForTests() { return CACHE.size; }
export const _EVENTS_MAX_CACHE_ENTRIES_FOR_TESTS = MAX_CACHE_ENTRIES;

function resolveEventsPath(projectPath, runId) {
  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const runDir = path.join(runsDir, runId);
  const eventsPath = path.join(runDir, 'events.jsonl');
  return { runsDir, eventsPath };
}

// Returns { ok, events, total_lines, next_after, captured_at, age_ms, provenance } or
// { ok:false, error }. `runId` MUST already have passed safeIdOk() at the route layer — this
// function re-checks anyway (defense in depth, never trust a single check point). Same external
// contract as before the R1 fix: `after`/`next_after` are line counts (valid+malformed lines
// combined), backed now by the incremental cache instead of a full re-read.
export function readEvents(projectPath, runId, after) {
  if (!safeIdOk(runId)) return { ok: false, error: 'invalid run id' };
  const { runsDir, eventsPath } = resolveEventsPath(projectPath, runId);
  if (!containmentOk(runsDir, eventsPath)) return { ok: false, error: 'path containment violation' };

  const capturedAt = new Date();
  const afterIdx = Number.isInteger(after) && after >= 0 ? after : 0;

  if (!fs.existsSync(eventsPath)) {
    return { ok: true, events: [], total_lines: 0, next_after: afterIdx, captured_at: capturedAt.toISOString(), age_ms: 0, provenance: 'LIVE', note: 'no events.jsonl yet for this run', truncated: false };
  }
  let entry;
  try {
    entry = syncCache(eventsPath);
  } catch (err) {
    return { ok: false, error: 'failed to read events: ' + err.message };
  }
  if (!entry) {
    return { ok: true, events: [], total_lines: 0, next_after: afterIdx, captured_at: capturedAt.toISOString(), age_ms: 0, provenance: 'LIVE', note: 'no events.jsonl yet for this run', truncated: false };
  }
  // P1-4 fix: total_lines/next_after stay a cumulative line count across the run's WHOLE life, even
  // once old lines have been trimmed out of lineRecords (see MAX_LINE_RECORDS_PER_ENTRY above) — add
  // droppedLineCount back in. afterIdx is likewise translated from "cumulative line count" into "index
  // into the (possibly trimmed) in-memory array" before slicing; a caller whose afterIdx falls before
  // the trimmed region simply gets everything still buffered, same honest behavior as the pre-existing
  // MAX_DELTA_READ_BYTES truncation (truncated:true already tells the caller history was dropped).
  const totalLines = entry.droppedLineCount + entry.lineRecords.length;
  const effectiveAfterIdx = Math.max(0, afterIdx - entry.droppedLineCount);
  const slice = entry.lineRecords.slice(effectiveAfterIdx);
  const events = [];
  let malformed = 0;
  // WP8-13 gap-closing round: this is the only place in the gateway that ever forwarded a whole,
  // agent-written event object verbatim — an agent that puts a credential in `note`/`evidence`/
  // `output` (anywhere in the object, at any depth) would otherwise reach the browser raw.
  // redactDeep() walks the WHOLE parsed object (never just a fixed field name) and preserves its
  // exact shape — see redact.mjs for the structure-preservation guarantee.
  for (const rec of slice) {
    if (rec.ok) events.push(redactDeep(rec.event)); else malformed += 1;
  }
  return {
    ok: true,
    events,
    total_lines: totalLines,
    next_after: totalLines,
    malformed_lines: malformed,
    captured_at: capturedAt.toISOString(),
    age_ms: 0,
    provenance: 'LIVE',
    truncated: !!entry.truncated,
  };
}

const DEFAULT_HEARTBEAT_MS = 15_000;
// fs.watch is documented by Node as "not 100% consistent across platforms" (missed events are a
// known real-world failure mode, especially on some network filesystems). A small safety-net poll
// is defense-in-depth so a live tail never silently goes stale just because one native watch
// event was dropped — cheap, since each poll is itself an incremental byte-offset read.
const DEFAULT_FALLBACK_POLL_MS = 3_000;

// Attaches a real text/event-stream response to `res` and tails `eventsPath` live. The caller
// (server.mjs) is responsible for every access-control check (project allowlist, run-id shape)
// BEFORE calling this — by the time we get here the request is authorized and containment-clean.
// Reconnect-safe: a client sends `Last-Event-ID: <byte-offset>` (the exact value this function
// emitted as `id:` on the last event it received) and resumes exactly from there, backed by the
// SAME incremental cache used by readEvents() above — no separate re-read of history it already
// has.
export function attachEventsStream({ req, res, projectPath, runId, heartbeatMs = DEFAULT_HEARTBEAT_MS, fallbackPollMs = DEFAULT_FALLBACK_POLL_MS }) {
  const { runsDir, eventsPath } = resolveEventsPath(projectPath, runId);
  if (!containmentOk(runsDir, eventsPath)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'path containment violation' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const lastEventIdHeader = req.headers['last-event-id'];
  const sinceOffset = lastEventIdHeader != null && /^\d+$/.test(String(lastEventIdHeader)) ? Number(lastEventIdHeader) : null;

  function writeRecord(record) {
    if (!record.ok) return; // a malformed line is never forwarded as a live event
    res.write('id: ' + record.endOffset + '\n');
    // WP8-13 gap-closing round: same redactDeep() applied on the polling path above, applied here
    // too so a live SSE frame can never leak a credential the polling path would have caught.
    res.write('data: ' + JSON.stringify(redactDeep(record.event)) + '\n\n');
  }

  // The cursor is {sentGeneration, sentIndex} TOGETHER, never an index alone (WP12 Finding 1 /
  // BUG 1, fixed in cc-fix-events). A rebuild (byte-shrink OR file-identity change — see
  // syncCache()) bumps entry.generation; seeing a new generation resets sentIndex to 0 against the
  // REBUILT lineRecords array so an already-open connection can never get stuck comparing its old
  // sent count against a shorter/different array forever.
  let sentIndex = 0;
  let sentGeneration = -1;

  function checkForNew() {
    if (res.writableEnded) return;
    if (!fs.existsSync(eventsPath)) return;
    const entry = syncCache(eventsPath);
    if (!entry) return;
    if (entry.generation !== sentGeneration) {
      sentIndex = 0;
      sentGeneration = entry.generation;
    }
    if (entry.lineRecords.length > sentIndex) {
      for (let i = sentIndex; i < entry.lineRecords.length; i++) writeRecord(entry.lineRecords[i]);
      sentIndex = entry.lineRecords.length;
    }
  }

  // Initial backlog: from the reconnecting client's byte offset if given, else from the start —
  // same code path either way, so cold-connect and reconnect are not two different mechanisms.
  if (fs.existsSync(eventsPath)) {
    const entry = syncCache(eventsPath);
    let startIdx = 0;
    if (entry && sinceOffset != null) {
      const idx = entry.lineRecords.findIndex((r) => r.startOffset >= sinceOffset);
      startIdx = idx === -1 ? entry.lineRecords.length : idx;
    }
    if (entry) {
      for (let i = startIdx; i < entry.lineRecords.length; i++) writeRecord(entry.lineRecords[i]);
      sentIndex = entry.lineRecords.length;
      sentGeneration = entry.generation;
    }
  } else {
    res.write(': no events.jsonl yet for this run\n\n');
  }

  let watcher = null;
  try {
    if (fs.existsSync(eventsPath)) watcher = fs.watch(eventsPath, { persistent: false }, () => checkForNew());
  } catch {
    watcher = null; // fs.watch can throw on some platforms/paths — the fallback poll still covers it
  }

  const fallbackPoll = setInterval(checkForNew, fallbackPollMs);
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(':heartbeat\n\n'); }, heartbeatMs);

  function cleanup() {
    clearInterval(fallbackPoll);
    clearInterval(heartbeat);
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
  }
  req.on('close', cleanup);
  res.on('close', cleanup);
}

// Test-only hook: clears the module-level incremental cache so tests never leak state (and never
// need to touch a real .claude/forge-runs — every test uses its own temp events file).
export function _resetEventsCacheForTests() { CACHE.clear(); }
