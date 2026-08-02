// Forge Command Center gateway — ask boot scan (fix-ghost-asks, forge-2026-07-30-cc-finish, work
// package fix-ghost-asks, item 2).
//
// WHY THIS EXISTS: ask-store.mjs's pending-question registry is IN-MEMORY ONLY, reset to empty on
// every gateway restart — so any `ask_questions` conversation event left over from a PREVIOUS boot
// with no later resolution event is dead BY DEFINITION; nothing in this process can ever answer or
// abandon it organically (see this project's own
// `command-center/mission/DIAGNOSE-2026-07-30-spookvragen.md` for the full root-cause: measured
// live on `c-ms7cqy79-882524f6`, the wizard opened for a dead question and answering it 404'd).
// This module runs ONCE at gateway startup (bin.mjs, after the port is already bound and serving)
// and closes every such dangling ask out honestly (`ask_abandoned`, reason `gateway_restart`) so
// the dashboard never resurrects a dead question.
//
// IDEMPOTENT BY CONSTRUCTION: detection re-reads each file's CURRENT on-disk state every run — an
// `ask_abandoned` event this scan itself appended on a PRIOR run IS a real resolution the next
// run's own detection sees (it is scanned by the exact same `findDanglingAskIds` logic that
// resolves an `ask_answered`/`ask_timed_out`), so a second call (or a second boot) never
// double-appends for the same ask id. No separate "already scanned" flag exists or is needed.
//
// BOUNDED (do not read unbounded data — bin.mjs must never see this "measurably delay boot"):
//   - MAX_BOOT_SCAN_FILES: only the MAX_BOOT_SCAN_FILES most-recently-modified conversation files
//     are scanned per boot; the rest are skipped with one honest warning naming the count skipped.
//     Most-recent-first because a genuinely dangling ask realistically sits in a recently-touched
//     file — the bound only sacrifices very old, already-cold conversations once the store grows
//     past this cap.
//   - MAX_BOOT_SCAN_TOTAL_BYTES: a single running byte budget across the WHOLE scan (summed from
//     each file's real `stat().size`, checked BEFORE that file is read) — the moment reading the
//     next file would exceed it, scanning stops and every remaining candidate is skipped+warned.
//     This bounds total work regardless of how many/how large files exist, which a per-file cap
//     alone would not (many small files could still add up to unbounded total I/O).
// A file that fails to stat/read is skipped with a warning, never a crash. `runAskBootScan` itself
// NEVER throws — every internal failure degrades to a logged warning and an honest partial result.
import fs from 'node:fs';
import path from 'node:path';
import { activeConversationsDir, readAllRecords } from './conversation-store.mjs';
import { appendConversationEvent } from './conversations.mjs';
import { safeConvIdOk } from './security.mjs';

export const MAX_BOOT_SCAN_FILES = 2000;
export const MAX_BOOT_SCAN_TOTAL_BYTES = 32 * 1024 * 1024; // 32 MB total read budget per boot

// Test-only overrides — mirrors this codebase's own `_setXxxForTests()` convention (ask-store.mjs,
// exec-lifecycle.mjs) so a test can exercise the bound MECHANISM without creating thousands of real
// fixture files or multi-megabyte fixtures.
let maxFilesOverride = null;
let maxBytesOverride = null;
export function _setBootScanLimitsForTests({ maxFiles = null, maxBytes = null } = {}) {
  maxFilesOverride = maxFiles;
  maxBytesOverride = maxBytes;
}
export function _resetBootScanLimitsForTests() {
  maxFilesOverride = null;
  maxBytesOverride = null;
}
function resolveMaxFiles() { return maxFilesOverride !== null ? maxFilesOverride : MAX_BOOT_SCAN_FILES; }
function resolveMaxBytes() { return maxBytesOverride !== null ? maxBytesOverride : MAX_BOOT_SCAN_TOTAL_BYTES; }

// The three real resolving event kinds — `ask_abandoned` sits alongside the two the dashboard's own
// `findPendingAsk` (dashboard/src/prototype/state/gateway-chat/ask-questions.ts) already recognized,
// so a record this scan itself just wrote is indistinguishable, on the NEXT read, from one the live
// gateway wrote — which is exactly what makes this idempotent without a separate marker.
const RESOLVING_KINDS = new Set(['ask_answered', 'ask_timed_out', 'ask_abandoned']);

/**
 * Pure detection over one file's ALREADY-READ records (`conversation-store.mjs`'s own
 * `readAllRecords()` shape: `{type, kind, data, turn_id, request_id, ...}`): every `ask_questions`
 * id with no LATER event of a resolving kind carrying the same `data.id`. Exported for direct unit
 * testing against a synthetic record array, independent of any real file on disk.
 */
export function findDanglingAskIds(records) {
  const opened = []; // [{ id, turnId, requestId }], in file order
  const resolvedIds = new Set();
  for (const record of records) {
    if (!record || record.type !== 'event') continue;
    const kind = record.kind;
    const data = record.data && typeof record.data === 'object' ? record.data : null;
    const id = data && typeof data.id === 'string' ? data.id : null;
    if (id === null) continue;
    if (kind === 'ask_questions') {
      opened.push({ id, turnId: record.turn_id ?? null, requestId: record.request_id ?? null });
    } else if (RESOLVING_KINDS.has(kind)) {
      resolvedIds.add(id);
    }
  }
  return opened.filter((ask) => !resolvedIds.has(ask.id));
}

/**
 * Runs the real boot scan once. Returns `{ scannedFiles, skippedFiles, abandonedCount }` — never
 * throws; every per-file failure is caught and logged via `warn`, never escalated. `warn` defaults
 * to `console.warn` and is overridable (tests pass a collecting stub instead of touching stdout).
 */
export function runAskBootScan({ warn = (msg) => console.warn(msg) } = {}) {
  const dir = activeConversationsDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    warn('[ask-boot-scan] could not list conversations directory (' + dir + '): ' + (err && err.message ? err.message : String(err)));
    return { scannedFiles: 0, skippedFiles: 0, abandonedCount: 0 };
  }

  const candidates = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const id = file.slice(0, -'.jsonl'.length);
    if (!safeConvIdOk(id)) continue; // defense in depth against any unexpected file name
    const full = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // gone between readdir and stat (e.g. deleted concurrently) — not this scan's problem
    }
    if (!stat.isFile()) continue;
    candidates.push({ id, full, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs); // most-recently-modified first, see file header

  const maxFiles = resolveMaxFiles();
  const maxBytes = resolveMaxBytes();
  let scannedFiles = 0;
  let skippedFiles = 0;
  let bytesRead = 0;
  let abandonedCount = 0;

  for (const candidate of candidates) {
    if (scannedFiles >= maxFiles || bytesRead + candidate.size > maxBytes) {
      skippedFiles++;
      continue;
    }

    let records;
    try {
      records = readAllRecords(candidate.full);
    } catch (err) {
      warn('[ask-boot-scan] could not read ' + candidate.id + ': ' + (err && err.message ? err.message : String(err)));
      skippedFiles++;
      continue;
    }
    bytesRead += candidate.size;
    scannedFiles++;

    const dangling = findDanglingAskIds(records);
    for (const ask of dangling) {
      try {
        appendConversationEvent(candidate.id, {
          turn_id: ask.turnId,
          request_id: ask.requestId,
          kind: 'ask_abandoned',
          data: { id: ask.id, reason: 'gateway_restart' },
        });
        abandonedCount++;
      } catch (err) {
        warn('[ask-boot-scan] could not close out ask ' + ask.id + ' in ' + candidate.id + ': ' + (err && err.message ? err.message : String(err)));
      }
    }
  }

  if (skippedFiles > 0) {
    warn(
      '[ask-boot-scan] skipped ' + skippedFiles + ' conversation file(s) past this boot\'s scan budget ' +
      '(maxFiles=' + maxFiles + ', maxBytes=' + maxBytes + ') — any dangling ask inside them stays until a later boot scan catches it',
    );
  }
  return { scannedFiles, skippedFiles, abandonedCount };
}
