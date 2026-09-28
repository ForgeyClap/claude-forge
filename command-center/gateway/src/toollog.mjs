// WP-CC1 (Lead review, HIGH) — reads `.claude/forge-runs/_toollog/*.jsonl`, the harness's own
// per-tool-call heartbeat: one JSON line per real tool call, written independently of anything
// Forge itself decides to log as a mission event. This is what lets a Boss that works 30+ minutes
// without ever emitting a `subagent_started`/`check_passed`/etc. event still be seen as genuinely
// working — `runs.mjs`'s own event-only liveness (item 1/2) had no signal for that case at all.
//
// Real line shape (verified live against this project's own `_toollog/*.jsonl`):
//   {"ts":"2026-09-28T15:29:39.271Z","session":"...","agent_id":"a4cc5e129029195e4",
//    "agent_type":"integration-boss","tool":"Bash","target":"cd","target_kind":"command",
//    "ok":true,"ok_basis":"present","ms":187,"tool_use_id":"...","permission_mode":"..."}
// `agent_id` is the real dispatch id for a subagent's own tool call, or `null` for a call made
// directly by the Lead (not yet dispatched to any subagent) — both are genuine evidence of life.
//
// PRIVACY BOUND (explicit Lead instruction): `tool`/`target`/`target_kind`/`command`/
// `permission_mode` etc. are never parsed out here at all — `target` can be a raw shell command or
// a file path, neither safe to let leave this module let alone reach an HTTP response. Only `ts`
// and `agent_id` are ever read off a line; every other field is invisible to every caller of this
// module by construction, not by a later filter someone could forget to apply.
import fs from 'node:fs';
import path from 'node:path';

// Bounded on two axes, per the Lead's own instruction: at most the NEWEST 3 files (by mtime; this
// fleet already has 5+ toollog files, one per Claude session, some of them multi-MB), and at most
// the LAST 512 KB of each (a heartbeat check only ever needs recent rows — this deliberately never
// becomes an unbounded read of a multi-MB session log).
const MAX_FILES = 3;
const MAX_BYTES_PER_FILE = 512 * 1024;
const CACHE_TTL_MS = 5_000;

// projectPath -> { rows, expiresAt } — same short-TTL, bounded-entry-count convention as this
// codebase's other hot-path caches (runs.mjs's SCAN_CACHE, active-runs.mjs's fleet cache).
const CACHE = new Map();
const MAX_CACHE_ENTRIES = 200;

function evictCacheIfNeeded(key) {
  if (CACHE.has(key)) return;
  while (CACHE.size >= MAX_CACHE_ENTRIES) {
    CACHE.delete(CACHE.keys().next().value);
  }
}

function toolLogDir(projectPath) {
  return path.join(projectPath, '.claude', 'forge-runs', '_toollog');
}

// Newest MAX_FILES *.jsonl files in the toollog dir, by real mtime — `null` (never `[]`) when the
// directory itself does not exist, so the caller can tell "genuinely no toollog on this machine"
// (honestly: no tool heartbeat at all) apart from "a toollog dir that exists but is empty".
function newestToolLogFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const withMtimes = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, e.name);
    let mtimeMs;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch { continue; } // a race with a concurrent write/rotate — skip, never throw
    withMtimes.push({ full, mtimeMs });
  }
  withMtimes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtimes.slice(0, MAX_FILES);
}

// Reads only the last MAX_BYTES_PER_FILE bytes of `filePath` and parses out `{ts, agent_id}` pairs.
// The very first "line" of a tail read is very likely a partial line (the read started mid-record)
// — dropped whenever the read did not start at byte 0, rather than risk parsing a truncated
// fragment as if it were a real, complete row.
function readTailToolLogRows(filePath) {
  const rows = [];
  let fd;
  try {
    const size = fs.statSync(filePath).size;
    const readLen = Math.min(size, MAX_BYTES_PER_FILE);
    const startedMidFile = size > readLen;
    const buf = Buffer.alloc(readLen);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = startedMidFile ? 1 : 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; } // a malformed/truncated line is skipped, never a crash
      if (!obj || typeof obj !== 'object') continue;
      if (typeof obj.ts !== 'string' || obj.ts === '') continue; // no readable clock -> not usable as a heartbeat
      // agent_id is EITHER a real dispatch id string OR null (a Lead-level call) — never coerced
      // from anything else, so a stray non-string/non-null value is honestly dropped rather than
      // silently treated as one of the two real shapes.
      const agentId = obj.agent_id === null ? null : (typeof obj.agent_id === 'string' ? obj.agent_id : undefined);
      if (agentId === undefined) continue;
      rows.push({ ts: obj.ts, agent_id: agentId });
    }
  } catch {
    /* file vanished/unreadable mid-scan — honestly contributes nothing, never throws */
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
  return rows;
}

function computeToolLogRows(projectPath) {
  const dir = toolLogDir(projectPath);
  const files = newestToolLogFiles(dir);
  if (files === null) return []; // no _toollog directory at all -> no tool heartbeat, honestly
  const rows = [];
  for (const f of files) rows.push(...readTailToolLogRows(f.full));
  return rows;
}

/**
 * readToolLogRows(projectPath) -> Array<{ts: string, agent_id: string|null}>. The newest tool-call
 * heartbeat rows this project's `_toollog/` can currently show, bounded and cached as described
 * above. Never throws; a missing directory or an unreadable file degrades to fewer/zero rows, never
 * an error — this is an OPTIONAL liveness signal, not a required one.
 */
export function readToolLogRows(projectPath, now = Date.now()) {
  const cached = CACHE.get(projectPath);
  if (cached && cached.expiresAt > now) return cached.rows;
  const rows = computeToolLogRows(projectPath);
  evictCacheIfNeeded(projectPath);
  CACHE.set(projectPath, { rows, expiresAt: now + CACHE_TTL_MS });
  return rows;
}

// WP-CC1 (Lead review round 2 — "heartbeat fallback"): whether THIS project's tool-log currently
// shows real per-dispatch attribution at all. An older Claude Code build (or a machine with tool
// logging off) writes rows with `agent_id` always `null` — on such a machine, a per-dispatch
// heartbeat can never be built from this log, and falling back to the run's own last work event is
// the only honest signal available. Once ANY attributed row exists within the last 24h, attribution
// is trusted to be genuinely working, and a caller should require an open dispatch's OWN attributed
// activity rather than accepting a coarser, run-wide signal in its place — this is exactly the gap
// that let three different agents' open dispatches all read `running:true` off of ONE agent's real
// recent activity (live-measured: only UI Boss, of "UI Boss, Integration Boss, Review Boss", was
// actually doing anything at that moment).
const ATTRIBUTION_CHECK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * hasAttributedToolLogActivity(toolLogRows, nowMs) -> boolean. `toolLogRows` is whatever
 * `readToolLogRows()` already returned for this project (never re-read here) — true when at least
 * one row carries a non-null `agent_id` and a timestamp within the last 24h.
 */
export function hasAttributedToolLogActivity(toolLogRows, nowMs = Date.now()) {
  for (const row of toolLogRows) {
    if (row.agent_id === null) continue;
    const ms = Date.parse(row.ts);
    if (Number.isFinite(ms) && (nowMs - ms) <= ATTRIBUTION_CHECK_WINDOW_MS) return true;
  }
  return false;
}

export const _ATTRIBUTION_CHECK_WINDOW_MS_FOR_TESTS = ATTRIBUTION_CHECK_WINDOW_MS;

export function _resetToolLogCacheForTests() { CACHE.clear(); }
export const _TOOLLOG_CACHE_TTL_MS_FOR_TESTS = CACHE_TTL_MS;
export const _TOOLLOG_MAX_FILES_FOR_TESTS = MAX_FILES;
export const _TOOLLOG_MAX_BYTES_PER_FILE_FOR_TESTS = MAX_BYTES_PER_FILE;
