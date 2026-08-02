// Forge Command Center gateway — conversation store, low-level storage/paths + raw record IO
// (refactor-gateway-split, forge-2026-07-30-cc-finish). Split out of the single conversations.mjs
// (had grown to ~546 lines, over this project's own 500-line-per-file guidance) into its own real
// seam: resolving/validating a safe per-conversation file path, id generation, and the raw
// append-only record read/write. See conversations.mjs's own header for the full architecture/
// history/honesty rules this slice still follows (D2: gateway-owned, sole writer, NEVER writes into
// .claude/); no other file in the codebase needed to change a single import.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONVERSATIONS_DIR } from './paths.mjs';
import { containmentOk, safeConvIdOk } from './security.mjs';
import { redactRecordForRead } from './conversation-redact.mjs';

// Test-only override seam: the real CONVERSATIONS_DIR is a fixed path (this store is global to
// the gateway install, not parameterized per-project like agents.mjs/skills.mjs/etc.), so without
// this seam every test would write real files into this project's own real `.data/conversations/`
// dir. Production code never calls the setter — only gateway tests do, always pointed at an
// isolated temp dir, mirroring the "never touch the real store from a test" discipline used
// throughout this test suite (see events.mjs's makeTempProjectRoot()-based tests).
let convDirOverride = null;
export function activeConversationsDir() {
  return convDirOverride || CONVERSATIONS_DIR;
}
export function _setConversationsDirForTests(dir) { convDirOverride = dir; }

export function ensureDir() {
  fs.mkdirSync(activeConversationsDir(), { recursive: true });
}

export function conversationPath(convId) {
  return path.join(activeConversationsDir(), convId + '.jsonl');
}

// Every write/read that turns a conv_id into a path re-validates BOTH the id shape and real
// containment under the active conversations dir — defense in depth, never a single check point.
export function resolveSafe(convId) {
  if (!safeConvIdOk(convId)) return null;
  const p = conversationPath(convId);
  if (!containmentOk(activeConversationsDir(), p)) return null;
  return p;
}

export function generateConversationId(now = Date.now()) {
  return 'c-' + now.toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

export function generateTurnId(now = Date.now()) {
  return 't-' + now.toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

export function generateRequestId(now = Date.now()) {
  return 'req-' + now.toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

export function appendRecord(convId, record) {
  const p = resolveSafe(convId);
  if (!p) throw new Error('invalid or unsafe conversation id');
  fs.appendFileSync(p, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

export function conversationExists(convId) {
  const p = resolveSafe(convId);
  if (!p) return false;
  return fs.existsSync(p);
}

export function readAllRecords(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try { records.push(redactRecordForRead(JSON.parse(line))); } catch { /* a malformed line is skipped, never crashes a read */ }
  }
  return records;
}
