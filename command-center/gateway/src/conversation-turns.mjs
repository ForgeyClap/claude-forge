// Forge Command Center gateway — conversation turns/meta read-write (refactor-gateway-split,
// forge-2026-07-30-cc-finish). Split out of the single conversations.mjs (had grown to ~546 lines,
// over this project's own 500-line-per-file guidance) into its own real seam: creating/reading/
// listing conversations, deriving/backfilling titles, appending user/assistant turns and stream
// events, the cached listing summary, and deleting a conversation. See conversations.mjs's own
// header for the full architecture/history/honesty rules this slice still follows; no other file in
// the codebase needed to change a single import.
import fs from 'node:fs';
import path from 'node:path';
import { safeConvIdOk } from './security.mjs';
import { redact, redactNullable, redactDeep } from './redact.mjs';
import {
  ensureDir,
  conversationPath,
  resolveSafe,
  appendRecord,
  generateConversationId,
  generateTurnId,
  generateRequestId,
  readAllRecords,
  activeConversationsDir,
} from './conversation-store.mjs';
import { TAIL_CACHE } from './conversation-stream.mjs';

// Creates a new conversation: writes exactly one `meta` line and returns its summary. `project`
// must already have been validated against the real project allowlist by the caller (server.mjs)
// — this module has no opinion on which projects exist, only how the store is shaped.
export function createConversation({ project, title }) {
  ensureDir();
  let id = generateConversationId();
  // Astronomically unlikely id collision — regenerate once rather than silently overwrite.
  for (let i = 0; i < 3 && fs.existsSync(conversationPath(id)); i++) id = generateConversationId(Date.now() + i);
  const createdAt = new Date().toISOString();
  const meta = {
    type: 'meta',
    conversation_id: id,
    project,
    title: typeof title === 'string' && title.length > 0 ? title : null,
    created_at: createdAt,
  };
  appendRecord(id, meta);
  return { id, project, title: meta.title, created_at: createdAt };
}

// cc-fix-chat-identity: titles are never fabricated out of thin air — they are derived ONLY from
// a real user turn's text. Whitespace (including every newline) is normalized to single spaces,
// then truncated to ~48 chars at a word boundary (never mid-word, unless the first 48 chars
// contain no space at all, in which case a hard cut is the honest fallback).
const TITLE_MAX_LEN = 48;
export function deriveTitleFromText(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= TITLE_MAX_LEN) return normalized;
  const slice = normalized.slice(0, TITLE_MAX_LEN);
  const lastSpaceIdx = slice.lastIndexOf(' ');
  const truncated = lastSpaceIdx > 0 ? slice.slice(0, lastSpaceIdx) : slice;
  return truncated.trim();
}

// The store is append-only JSONL: a title correction is never rewritten in place, it is a new
// `meta_patch` line layered on top of the original `meta` line. This merges the base meta with
// the LAST meta_patch's fields (last-writer-wins), so every read site sees one coherent object.
function mergeMeta(records) {
  const base = records.find((r) => r.type === 'meta') || null;
  if (!base) return null;
  let title = base.title;
  for (const r of records) {
    if (r.type === 'meta_patch' && 'title' in r) title = r.title;
  }
  return { ...base, title };
}

// Lazy backfill (list/read time): a conversation that already has a real user turn but no title
// yet (e.g. created before this fix existed) gets one derived from its FIRST user turn, persisted
// as a one-time meta_patch so every later read is a pure read again. Never invents a title when
// no user turn exists yet — title correctly stays null until one arrives.
function backfillTitleIfNeeded(convId, turns, meta) {
  if (!meta || meta.title != null) return meta;
  const firstUserTurn = turns.find((t) => t.role === 'user');
  if (!firstUserTurn || typeof firstUserTurn.text !== 'string') return meta;
  const derived = deriveTitleFromText(firstUserTurn.text);
  if (derived == null) return meta;
  appendRecord(convId, { type: 'meta_patch', title: derived });
  return { ...meta, title: derived };
}

export function readConversation(convId) {
  const p = resolveSafe(convId);
  if (!p || !fs.existsSync(p)) return { ok: false, error: 'conversation not found' };
  const records = readAllRecords(p);
  let meta = mergeMeta(records);
  const turns = records.filter((r) => r.type === 'turn');
  const events = records.filter((r) => r.type === 'event');
  meta = backfillTitleIfNeeded(convId, turns, meta);
  let updatedAt = meta ? meta.created_at : new Date(0).toISOString();
  try { updatedAt = fs.statSync(p).mtime.toISOString(); } catch { /* keep the meta-derived fallback */ }
  return { ok: true, id: convId, meta, turns, events, turn_count: turns.length, updated_at: updatedAt };
}

// P2-12 fix (cc-fix-gateway-perf, forge-2026-07-29-cc-finish): listConversations() used to fully
// readFileSync + JSON.parse EVERY line + redactDeep EVERY record of EVERY conversation file, on
// EVERY call — purely to derive three scalars (title/project/turn_count). Two independent pollers
// call this (the chat list every 4s, and the dashboard's health-poll every 5s), so an unchanged
// conversation was being fully re-parsed and re-redacted roughly 27x/minute, growing with total
// transcript size (see the forge-report for this WP for the real measured before/after cost).
// Cached here on real file identity (path, mtimeMs, size) — same proven pattern as runs.mjs's new
// scan cache and the existing tools.mjs/capabilities.mjs FIFO-bounded caches. Never caches full
// turn/event bodies (only the three summary scalars this endpoint actually returns), so this cache
// carries far less memory risk than events.mjs's line-record cache even before considering the
// bound below.
const SUMMARY_CACHE = new Map(); // absoluteFilePath -> { mtimeMs, size, title, project, turnCount, updatedAt }
const MAX_SUMMARY_CACHE_ENTRIES = 500;

function evictSummaryCacheIfNeeded(key) {
  if (SUMMARY_CACHE.has(key)) return;
  while (SUMMARY_CACHE.size >= MAX_SUMMARY_CACHE_ENTRIES) {
    const oldestKey = SUMMARY_CACHE.keys().next().value;
    SUMMARY_CACHE.delete(oldestKey);
  }
}

function summarizeConversationFileCached(fullPath, convId) {
  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    SUMMARY_CACHE.delete(fullPath);
    return null;
  }
  const cached = SUMMARY_CACHE.get(fullPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }
  // Cache MISS (new file, or a real append changed size/mtime): reuses the existing, already-
  // reviewed readAllRecords() — never a second, parallel parsing path that could drift from it.
  const records = readAllRecords(fullPath);
  const turns = records.filter((r) => r.type === 'turn');
  const meta = backfillTitleIfNeeded(convId, turns, mergeMeta(records));
  const entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    title: (meta && meta.title) || null,
    project: (meta && meta.project) || null,
    turnCount: turns.length,
    updatedAt: stat.mtime.toISOString(),
  };
  evictSummaryCacheIfNeeded(fullPath);
  SUMMARY_CACHE.set(fullPath, entry);
  return entry;
}

export function _resetConversationsSummaryCacheForTests() { SUMMARY_CACHE.clear(); }
export function _conversationsSummaryCacheSizeForTests() { return SUMMARY_CACHE.size; }
export const _CONVERSATIONS_SUMMARY_MAX_CACHE_ENTRIES_FOR_TESTS = MAX_SUMMARY_CACHE_ENTRIES;

// GET /api/conversations list shape: id/title/project/updated_at/turn_count only — never the
// full turn/event bodies (that is what GET /api/conversations/:id is for).
export function listConversations() {
  ensureDir();
  let files = [];
  try { files = fs.readdirSync(activeConversationsDir()); } catch { files = []; }
  const rows = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const id = file.slice(0, -'.jsonl'.length);
    if (!safeConvIdOk(id)) continue; // defense in depth against any unexpected file
    const full = path.join(activeConversationsDir(), file);
    const summary = summarizeConversationFileCached(full, id);
    if (!summary) continue;
    rows.push({
      id,
      title: summary.title,
      project: summary.project,
      updated_at: summary.updatedAt,
      turn_count: summary.turnCount,
    });
  }
  rows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return rows;
}

// `mode` ('execute' | 'plan' | 'accept-edits' | 'bypass', cc-fix-chat-identity + fix-exec-modes) is
// stored on the turn record itself — the "turn-meta" the UI reads back to show which permission
// mode a given send actually used. `effort` (fix-exec-modes: a real, help-confirmed `claude --effort`
// value) follows the exact same pattern — optional, stored as `null` when not requested. `model`
// (feat-model-picker: a real, help-confirmed `claude --model` value, server.mjs's EXEC_MODEL_VALUES)
// follows the exact same pattern one field over — this is the REQUESTED model, not necessarily the
// one that actually ran (see exec-lifecycle.mjs's own `model: usageFields.model`, which writes the
// real, CLI-reported model onto the ASSISTANT turn instead — a different field, on a different turn
// role, never conflated). The caller (server.mjs) already validated all three against their own
// strict allowlists; `mode` defaults to 'execute' so every pre-existing call site (and every turn
// sent before this fix existed) behaves unchanged.
export function appendUserTurn(convId, text, { mode = 'execute', effort = null, model = null } = {}) {
  const now = Date.now();
  const turnId = generateTurnId(now);
  const requestId = generateRequestId(now);
  // WP10 should-fix-now #12: redact on write too, so a secret pasted into a chat message never
  // even reaches disk (the read-side redactTurnForRead() above is the belt-and-suspenders layer).
  const safeText = typeof text === 'string' ? redact(text) : text;

  // Live title derivation: BEFORE appending this turn, check whether this conversation still has
  // no title AND no prior user turn — if both hold, this new turn IS the first user turn, and its
  // (already-redacted) text becomes the derived title. Never derives from anything but a real
  // user turn.
  const existingPath = resolveSafe(convId);
  let shouldDeriveTitle = false;
  if (existingPath && fs.existsSync(existingPath)) {
    const priorRecords = readAllRecords(existingPath);
    const priorMeta = mergeMeta(priorRecords);
    const hasPriorUserTurn = priorRecords.some((r) => r.type === 'turn' && r.role === 'user');
    shouldDeriveTitle = !!priorMeta && priorMeta.title == null && !hasPriorUserTurn;
  }

  const record = { type: 'turn', turn_id: turnId, request_id: requestId, role: 'user', text: safeText, mode, effort: effort ?? null, model: model ?? null, created_at: new Date(now).toISOString() };
  appendRecord(convId, record);

  if (shouldDeriveTitle) {
    const derivedTitle = deriveTitleFromText(safeText);
    if (derivedTitle != null) appendRecord(convId, { type: 'meta_patch', title: derivedTitle });
  }

  return { turnId, requestId, record };
}

export function appendAssistantTurn(convId, fields) {
  // WP10 should-fix-now #12: `text` (the model's reply) and `stderr` (up to STDERR_CAP_BYTES of a
  // spawned child's raw stderr, exec-bridge.mjs) are the two free-text fields named in the WP —
  // both redacted on write, on top of the read-side redactTurnForRead() defense-in-depth layer.
  const base = { type: 'turn', role: 'assistant', created_at: new Date().toISOString(), ...fields };
  const record = {
    ...base,
    text: typeof base.text === 'string' ? redact(base.text) : base.text,
    ...('stderr' in base ? { stderr: redactNullable(base.stderr) } : {}),
    // fix-stream-insights: write-side redaction for the same two new fields, mirrored on the read
    // side above — redactDeep() is a no-op on `null` (the honest "this turn touched neither tool"
    // value exec-bridge.mjs always sends explicitly).
    ...('file_edits' in base ? { file_edits: redactDeep(base.file_edits) } : {}),
    ...('todos' in base ? { todos: redactDeep(base.todos) } : {}),
    // feat-live-stream: write-side redaction for shell_commands, mirrored one field over.
    ...('shell_commands' in base ? { shell_commands: redactDeep(base.shell_commands) } : {}),
  };
  return appendRecord(convId, record);
}

// WP8-13 gap-closing round (the live-SSE hole): `fields.data` can be a raw unparsed stdout string
// OR an arbitrarily nested parsed stream-json object (see exec-bridge.mjs's rl.on('line')) — a
// credential can surface in EITHER shape. This is the write path attachConversationStream's live
// tail reads back from disk moments later, so redacting HERE (before the turn even closes) is what
// actually closes the "secret visible in real-time tailing before turn-close redaction" gap —
// appendAssistantTurn's existing redaction only ever covered the FINAL turn record, not the
// individual streamed events leading up to it. redactDeep() preserves the exact shape of `data`.
export function appendConversationEvent(convId, fields) {
  const record = { type: 'event', created_at: new Date().toISOString(), ...fields };
  if ('data' in record) record.data = redactDeep(record.data);
  return appendRecord(convId, record);
}

// feat-delete-conversation: removes the real per-conversation JSONL file from the data dir.
// resolveSafe() re-validates BOTH the id shape (safeConvIdOk) and real containment under the
// active conversations dir — the exact same defense-in-depth every other write/read helper above
// already applies — so this never builds or trusts a path derived any other way. server.mjs is
// responsible for the existence/busy/token checks that decide WHETHER to call this at all; this
// function's own job is narrower: a safe id resolves to a real file, or it doesn't.
export function deleteConversation(convId) {
  const p = resolveSafe(convId);
  if (!p) return { ok: false, error: 'invalid conversation id' };
  if (!fs.existsSync(p)) return { ok: false, error: 'conversation not found' };
  fs.unlinkSync(p);
  // Side-state cleanup (WP requirement): both in-process caches are keyed on this exact absolute
  // path (see summarizeConversationFileCached() above / syncTailCache() in `conversation-stream.mjs`) — dropping the entries here
  // means a caller that immediately re-lists conversations right after this call never sees a
  // stale cached summary for an id that no longer has a backing file on disk.
  SUMMARY_CACHE.delete(p);
  TAIL_CACHE.delete(p);
  return { ok: true };
}

// Test-only hooks.
export function _resetConversationsForTests() { TAIL_CACHE.clear(); SUMMARY_CACHE.clear(); }
