// Forge Command Center gateway — conversation live SSE tail + concurrency ceilings
// (refactor-gateway-split, forge-2026-07-30-cc-finish). Split out of the single conversations.mjs
// (had grown to ~546 lines, over this project's own 500-line-per-file guidance) into its own real
// seam: the byte-offset live tail cache, the `/api/conversations/:id/stream` SSE handler, and its
// two concurrency caps. See conversations.mjs's own header for the full architecture/history/
// honesty rules this slice still follows (mirrors events.mjs's proven byte-offset design, kept
// independent on purpose — see that file's own header); no other file in the codebase needed to
// change a single import.
import fs from 'node:fs';
import { resolveSafe } from './conversation-store.mjs';
import { redactRecordForRead } from './conversation-redact.mjs';

// ── Live SSE tail (mirrors events.mjs's proven byte-offset design, kept independent on purpose
//    — see file header) ──────────────────────────────────────────────────────────────────────
// Exported (not part of conversations.mjs's original public API) so conversation-turns.mjs's own
// deleteConversation()/_resetConversationsForTests() can clear this cache too — a purely mechanical
// cross-module seam this split requires, with no behavior change of its own.
export const TAIL_CACHE = new Map(); // absolutePath -> { size, lineRecords:[{startOffset,endOffset,ok,event}], tailBuf }

function stripTrailingCR(buf) {
  return buf.length > 0 && buf[buf.length - 1] === 0x0d ? buf.subarray(0, buf.length - 1) : buf;
}

function appendLines(entry, newBuf, readStartOffset) {
  const combined = entry.tailBuf.length ? Buffer.concat([entry.tailBuf, newBuf]) : newBuf;
  const combinedStartOffset = readStartOffset - entry.tailBuf.length;
  let lineStart = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] !== 0x0a) continue;
    const startOffset = combinedStartOffset + lineStart;
    const endOffset = combinedStartOffset + i + 1;
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

function syncTailCache(p) {
  let stat;
  try { stat = fs.statSync(p); } catch { TAIL_CACHE.delete(p); return null; }
  let entry = TAIL_CACHE.get(p);
  if (entry && stat.size < entry.size) entry = undefined; // file shrank/replaced — rebuild
  if (!entry) entry = { size: 0, lineRecords: [], tailBuf: Buffer.alloc(0) };
  if (stat.size > entry.size) {
    const oldSize = entry.size;
    const deltaLen = stat.size - oldSize;
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(deltaLen);
      fs.readSync(fd, buf, 0, deltaLen, oldSize);
      appendLines(entry, buf, oldSize);
    } finally {
      fs.closeSync(fd);
    }
    entry.size = stat.size;
  }
  TAIL_CACHE.set(p, entry);
  return entry;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_FALLBACK_POLL_MS = 2_000; // conversation files are small; a tight poll is cheap

// WP10 F6 (Codex, concurrent-SSE hardening): an unauthenticated caller (the whole loopback trust
// model, per WP10 AP-5) could otherwise open unbounded concurrent SSE connections to the same or
// different conversations, each holding its own fs.watch + 2 timers open indefinitely — a real
// resource-exhaustion path. Two independent caps, mirrored in spirit from the "no unbounded
// growth" lesson events.mjs's own byte-offset cache already applies to file reads: per-conversation
// (one runaway client/tab pair can't hog a single conversation) and gateway-wide (a bound on total
// concurrent streams regardless of how they're spread across conversations).
const MAX_STREAMS_PER_CONVERSATION = 8;
const MAX_STREAMS_TOTAL = 32;
const activeStreamsByConv = new Map(); // convId -> count
let activeStreamsTotal = 0;

// Attaches a text/event-stream response tailing ONE conversation's JSONL file. Every access
// control decision (conv id shape/containment/existence) MUST already have happened in
// server.mjs before this is called — mirrors events.mjs's attachEventsStream contract exactly.
export function attachConversationStream({ req, res, convId, heartbeatMs = DEFAULT_HEARTBEAT_MS, fallbackPollMs = DEFAULT_FALLBACK_POLL_MS }) {
  const p = resolveSafe(convId);
  if (!p) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'invalid conversation id' }));
    return;
  }

  const currentForConv = activeStreamsByConv.get(convId) || 0;
  if (activeStreamsTotal >= MAX_STREAMS_TOTAL || currentForConv >= MAX_STREAMS_PER_CONVERSATION) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: false,
      error: currentForConv >= MAX_STREAMS_PER_CONVERSATION
        ? 'too many concurrent streams for this conversation (max ' + MAX_STREAMS_PER_CONVERSATION + ') — close another tab/connection and retry'
        : 'gateway-wide concurrent-stream cap reached (max ' + MAX_STREAMS_TOTAL + ') — retry shortly',
    }));
    return;
  }
  activeStreamsByConv.set(convId, currentForConv + 1);
  activeStreamsTotal += 1;
  let slotReleased = false;
  function releaseSlot() {
    if (slotReleased) return; // req 'close' and res 'close' can both fire — release exactly once
    slotReleased = true;
    const remaining = (activeStreamsByConv.get(convId) || 1) - 1;
    if (remaining <= 0) activeStreamsByConv.delete(convId); else activeStreamsByConv.set(convId, remaining);
    activeStreamsTotal = Math.max(0, activeStreamsTotal - 1);
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
    if (!record.ok) return; // a malformed line is never forwarded
    res.write('id: ' + record.endOffset + '\n');
    // WP8-13 gap-closing round: defense-in-depth mirror of appendConversationEvent()'s write-side
    // fix — a record already on disk from before that fix existed must still never reach a live
    // SSE frame unredacted. redactRecordForRead() is a no-op for anything that isn't an
    // event/turn record, and idempotent on already-redacted text.
    res.write('data: ' + JSON.stringify(redactRecordForRead(record.event)) + '\n\n');
  }

  let lastSentIndex = 0;

  function checkForNew() {
    if (res.writableEnded) return;
    if (!fs.existsSync(p)) return;
    const entry = syncTailCache(p);
    if (!entry) return;
    if (entry.lineRecords.length > lastSentIndex) {
      for (let i = lastSentIndex; i < entry.lineRecords.length; i++) writeRecord(entry.lineRecords[i]);
      lastSentIndex = entry.lineRecords.length;
    }
  }

  if (fs.existsSync(p)) {
    const entry = syncTailCache(p);
    let startIdx = 0;
    if (entry && sinceOffset != null) {
      const idx = entry.lineRecords.findIndex((r) => r.startOffset >= sinceOffset);
      startIdx = idx === -1 ? entry.lineRecords.length : idx;
    }
    if (entry) {
      for (let i = startIdx; i < entry.lineRecords.length; i++) writeRecord(entry.lineRecords[i]);
      lastSentIndex = entry.lineRecords.length;
    }
  } else {
    res.write(': conversation not found\n\n');
  }

  let watcher = null;
  try {
    if (fs.existsSync(p)) watcher = fs.watch(p, { persistent: false }, () => checkForNew());
  } catch {
    watcher = null;
  }

  const fallbackPoll = setInterval(checkForNew, fallbackPollMs);
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(':heartbeat\n\n'); }, heartbeatMs);

  function cleanup() {
    clearInterval(fallbackPoll);
    clearInterval(heartbeat);
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
    releaseSlot();
  }
  req.on('close', cleanup);
  res.on('close', cleanup);
}

// Test-only hook: never leak the concurrent-stream slot counters across test files.
export function _resetConversationStreamCapForTests() {
  activeStreamsByConv.clear();
  activeStreamsTotal = 0;
}
export function _conversationStreamCapConstantsForTests() {
  return { MAX_STREAMS_PER_CONVERSATION, MAX_STREAMS_TOTAL };
}
