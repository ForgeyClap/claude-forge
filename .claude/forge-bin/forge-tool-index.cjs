#!/usr/bin/env node
'use strict';
/**
 * forge-tool-index.cjs — CROSS-RUN event search index (mining-ronde-1 §1, 2026-07-31). Answers the one
 * question grep cannot: "has this already been tried?" — across every run in THIS project, not just the run
 * the asking agent already has in context.
 *
 * WHY PER PROJECT, NOT PER RUN: an agent in run N needs to know what run N-3 already rejected. Per-run
 * storage would only ever answer about the run the agent is already living in. So the derived index lives at
 * `<root>/.claude/forge-index/` (mirrors the existing `.claude/forge-codemodel/index.json` precedent):
 *   tool-index.jsonl — the CANONICAL derived record store (always written, greppable, one JSON record/line)
 *   tool-index.db    — a node:sqlite FTS5 search accelerator derived from those same records
 *   state.json       — per run the ingest offset {bytes, lines, last_entry_hash, prefix_sha256, mtime_ms}
 * `events.jsonl` stays the SINGLE SOURCE OF TRUTH. This index is a cache: throw it away and `rebuild()`
 * reproduces it exactly, so index corruption is never data loss. Project isolation holds — one project, one
 * index; run_id is a column/filter, and every path goes through assertContained() (copied from
 * forge-manifest.cjs) so nothing can point outside `<root>/.claude/forge-index` or `<root>/.claude/forge-runs`.
 *
 * BACKEND (honest, never assumed): `backendInfo()` really requires node:sqlite and really creates a throwaway
 * ':memory:' FTS5 table. Success => 'sqlite-fts5'. ANY failure degrades to 'jsonl-keyword' carrying the REAL
 * error message in `reason` — never a silent pretend-success. Forceable via opts.backend or
 * FORGE_TOOL_INDEX_BACKEND=sqlite|jsonl (tests exercise BOTH). Verified live on Node v24.18.0.
 *   sqlite schema: entries(id, event_uid UNIQUE, ts, run_id, agent, event_type, tool, summary, ref_path,
 *   line_no, summary_fields) + indexes on run_id/event_type/ts + an external-content FTS5 table over ONLY
 *   `summary` (agent/event_type/run_id/ts are SQL filters, never FTS columns) + meta(key,value). WAL +
 *   busy_timeout=5000. UNIQUE event_uid + INSERT OR IGNORE is what makes re-ingest idempotent.
 *   bm25() returns negative values (best = most negative), so score = -bm25 — "higher is better" then means
 *   the same thing in BOTH backends.
 *   keyword fallback scoring: 10 * (# distinct matching query terms) + (total occurrences) + 5 when the whole
 *   query string appears literally. A record matching 0 terms is dropped.
 *
 * QUERY ESCAPING IS MANDATORY: raw user text in a FTS5 MATCH throws (proven: `fts5: syntax error near ""`).
 * buildMatchExpr() re-tokenizes and rebuilds the query as '"term1" OR "term2"' — every term a quoted FTS5
 * string literal — so no raw query string ever reaches MATCH. Any residual FTS error still degrades honestly
 * to keyword scoring with backend:'jsonl-keyword' + a real reason.
 *
 * STALENESS IS SURFACED, NEVER HIDDEN: search()/wasRejected() return `stale` and stats() returns a `stale[]`
 * of run ids whose events.jsonl has moved on since its last ingest. CONTRACT FOR CALLERS: when stale is true,
 * "no hit" may NEVER be presented as "not yet tried".
 *
 * API: resolveRoot · indexPaths · backendInfo · toIndexRecord (pure) · ingest · search · wasRejected ·
 *      resolve · stats · rebuild (+ tokenize/scoreKeyword/buildMatchExpr and the SCHEMA_VERSION/
 *      REJECTED_EVENT_TYPE/SUMMARY_FIELDS/SUMMARY_MAX_CHARS constants, exported for the tests).
 *
 * CLI:
 *   node forge-tool-index.cjs ingest  [--run <id>] [--all] [--full] [--root <p>] [--backend sqlite|jsonl] [--json]
 *   node forge-tool-index.cjs search  <query> [--run <id>] [--agent <n>] [--type <t>] [--since <iso>]
 *                                     [--until <iso>] [--limit <n>] [--rejected] [--exclude-rejected] [--json]
 *   node forge-tool-index.cjs tried   <query> [--limit <n>] [--root <p>] [--json]
 *   node forge-tool-index.cjs resolve <ref_path> [--root <p>] [--json]
 *   node forge-tool-index.cjs stats   [--root <p>] [--json]
 *   node forge-tool-index.cjs rebuild [--root <p>] [--json]
 * Exit codes: 0 ok (search/tried: >=1 hit — NOTE the deliberate inversion, `tried` exit 0 means "yes, this
 * was already tried") · 3 no result (its own code, like forge-snapshot's stale-3) · 2 usage error · 1 real error.
 *
 * DEVIATIONS FROM THE DESIGN CONTRACT (declared, with the reason):
 *  (1) SUMMARY_FIELDS gained 'approach' (right after 'task'). The contract's field-frequency list predates
 *      the `rejected_approach` event type it also specifies, whose PRIMARY text lives in `approach` — without
 *      it the one question this tool exists to answer would search everything except the rejected approach
 *      itself. Verified: the frequency ordering of the pre-existing fields is otherwise untouched.
 *  (2) The sqlite `entries` table carries a `summary_fields` column (JSON array) that the contract's schema
 *      sketch omits. Without it a sqlite Hit would be missing a field a jsonl Hit has; both backends must
 *      return the identical IndexRecord shape.
 *  (3) scoreKeyword(queryTokens, summary, rawQuery?) takes an OPTIONAL third argument. The contract's
 *      2-argument signature cannot express its own "+5 when the whole query string occurs literally" rule.
 *      The 2-argument call still works exactly as specified (no phrase bonus).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const REJECTED_EVENT_TYPE = 'rejected_approach';
// Ordered by real field frequency over this project's runs (note 537, evidence 402, task 178, output 87,
// summary 23, detail 12) — see deviation (1) in the header for 'approach'.
const SUMMARY_FIELDS = ['task', 'approach', 'note', 'detail', 'output', 'summary', 'decision_summary',
  'issue', 'reason', 'next_action', 'result', 'evidence', 'command'];
const SUMMARY_MAX_CHARS = 400;
const SUMMARY_JOIN = ' · ';
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const REF_RE = /^\.claude\/forge-runs\/([^/\\]+)\/events\.jsonl#L(\d+)$/;
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

// ---- root / path resolution (identical to forge-snapshot.cjs / forge-manifest.cjs) ----
function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  return path.resolve(__dirname, '..', '..');
}
/** assertContained — copied from forge-manifest.cjs. Nothing may ever resolve outside its own base dir. */
function assertContained(target, base, label) {
  const b = path.resolve(base), t = path.resolve(target);
  if (t !== b && !t.startsWith(b + path.sep)) throw new Error('forge-tool-index: path escapes ' + (label || base) + ' — refused');
}
function indexPaths(root) {
  const base = path.join(path.resolve(root), '.claude', 'forge-index');
  const p = {
    dir: base,
    dbPath: path.join(base, 'tool-index.db'),
    jsonlPath: path.join(base, 'tool-index.jsonl'),
    statePath: path.join(base, 'state.json'),
  };
  for (const k of ['dbPath', 'jsonlPath', 'statePath']) assertContained(p[k], base, '.claude/forge-index');
  return p;
}
function runsDir(root) { return path.join(path.resolve(root), '.claude', 'forge-runs'); }
function eventsPathFor(root, runId) {
  const base = runsDir(root);
  const p = path.join(base, runId, 'events.jsonl');
  assertContained(p, base, '.claude/forge-runs');
  return p;
}
function isValidRunId(id) { return typeof id === 'string' && RUN_ID_RE.test(id); }
function listRunDirs(root) {
  let entries;
  try { entries = fs.readdirSync(runsDir(root), { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && isValidRunId(e.name)).map((e) => e.name).sort();
}

// ---- atomic write (same-dir temp + rename, EPERM/EBUSY retry — mirrors forge-manifest.cjs) ----
function sleepMs(ms) {
  try { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }
  catch { /* Atomics.wait unavailable — best-effort no-op */ }
}
function renameWithRetry(src, dest, attempts) {
  attempts = attempts || 5;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(src, dest); return; }
    catch (e) {
      const transient = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES';
      if (!transient || i === attempts - 1) throw e;
      sleepMs(15 * (i + 1));
    }
  }
}
function atomicWriteFile(destPath, buffer) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, '.' + path.basename(destPath) + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.writeFileSync(tmpPath, buffer);
  renameWithRetry(tmpPath, destPath);
  return destPath;
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ---- backend probe (REAL require + REAL throwaway FTS5 table; never an assumption) ----
let _probeCache = null;
function probeSqlite() {
  if (_probeCache) return _probeCache;
  let out;
  try {
    const mod = require('node:sqlite');
    if (!mod || typeof mod.DatabaseSync !== 'function') {
      out = { available: false, fts5: false, reason: 'node:sqlite present but exposes no DatabaseSync constructor' };
    } else {
      const db = new mod.DatabaseSync(':memory:');
      try { db.exec('CREATE VIRTUAL TABLE forge_probe_fts USING fts5(x)'); }
      finally { try { db.close(); } catch { /* probe cleanup is best-effort */ } }
      out = { available: true, fts5: true, reason: null };
    }
  } catch (e) {
    out = { available: false, fts5: false, reason: (e && e.message) ? e.message : String(e) };
  }
  _probeCache = out;
  return out;
}
/** backendInfo(opts) -> {backend, sqliteAvailable, fts5, reason}. A forced backend that cannot actually be
 *  honoured degrades and SAYS SO in `reason` — it never reports a capability it does not have. */
function backendInfo(opts) {
  opts = opts || {};
  const forced = opts.backend || process.env.FORGE_TOOL_INDEX_BACKEND || null;
  const probe = probeSqlite();
  if (forced === 'jsonl') {
    return { backend: 'jsonl-keyword', sqliteAvailable: probe.available, fts5: probe.fts5, reason: 'forced to the keyword backend (backend=jsonl)' };
  }
  if (probe.available && probe.fts5) return { backend: 'sqlite-fts5', sqliteAvailable: true, fts5: true, reason: null };
  const why = probe.reason || 'node:sqlite unavailable';
  return { backend: 'jsonl-keyword', sqliteAvailable: probe.available, fts5: probe.fts5, reason: forced === 'sqlite' ? ('sqlite was requested but is unusable: ' + why) : why };
}

// ---- the pure record builder ------------------------------------------------------------------------
function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.filter((x) => x != null).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').trim();
  return '';
}
/** toIndexRecord(event, {runId, lineNo, root}) -> IndexRecord|null. PURE — no I/O. Returns null for a
 *  non-object, an event with no event_type, or a missing/invalid run id or line number. NEVER invents a
 *  value: an absent field becomes null (not '' and not a guess), and an event with no text field at all gets
 *  summary === its own event_type with summary_fields === [] — the honest "nothing to describe" record. */
function toIndexRecord(event, ctx) {
  ctx = ctx || {};
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const eventType = (typeof event.event_type === 'string' && event.event_type.trim()) ? event.event_type.trim() : null;
  if (!eventType) return null;
  const runId = ctx.runId != null ? String(ctx.runId) : (event.run_id != null ? String(event.run_id) : null);
  if (!isValidRunId(runId)) return null;
  const lineNo = Number(ctx.lineNo);
  if (!Number.isInteger(lineNo) || lineNo < 1) return null;

  const parts = [], fields = [];
  for (const f of SUMMARY_FIELDS) {
    const s = textOf(event[f]);
    if (!s) continue;
    parts.push(s); fields.push(f);
  }
  let summary = parts.join(SUMMARY_JOIN);
  let summaryFields = fields;
  if (!summary) { summary = eventType; summaryFields = []; }
  if (summary.length > SUMMARY_MAX_CHARS) summary = summary.slice(0, SUMMARY_MAX_CHARS) + '…';

  // tool: only ever a value the event REALLY carries (in 829 real events `tool` occurs exactly once, so
  // null is the normal, honest answer — never guessed from context).
  let tool = null;
  const toolRaw = textOf(event.tool) || textOf(event.skill);
  if (toolRaw) tool = toolRaw;
  else { const cmd = textOf(event.command); if (cmd) tool = cmd.split(/\s+/)[0] || null; }

  const entryHash = (typeof event.entry_hash === 'string' && event.entry_hash) ? event.entry_hash : null;
  return {
    ts: (typeof event.timestamp === 'string' && event.timestamp) ? event.timestamp : null,
    run_id: runId,
    agent: textOf(event.agent) || null,
    event_type: eventType,
    tool,
    summary,
    ref_path: '.claude/forge-runs/' + runId + '/events.jsonl#L' + lineNo,
    line_no: lineNo,
    event_uid: entryHash || (runId + ':' + lineNo),
    summary_fields: summaryFields,
  };
}

// ---- query helpers ----------------------------------------------------------------------------------
/** tokenize(text) -> lowercase word tokens (duplicates preserved — occurrence counting needs them). */
function tokenize(text) {
  if (text == null) return [];
  TOKEN_RE.lastIndex = 0;
  return String(text).toLowerCase().match(TOKEN_RE) || [];
}
/** buildMatchExpr(query) -> '"t1" OR "t2"'. Every term becomes an FTS5 STRING LITERAL, so no user text is
 *  ever interpreted as an FTS operator. A query with no real tokens yields '' — the caller must then return
 *  zero hits WITHOUT touching MATCH (a raw or empty MATCH is exactly what throws). */
function buildMatchExpr(query) {
  const seen = new Set(), terms = [];
  for (const tok of tokenize(query)) { if (!seen.has(tok)) { seen.add(tok); terms.push(tok); } }
  return terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ');
}
/** scoreKeyword(queryTokens, summary, rawQuery?) -> number (higher = better; 0 = no match at all).
 *  10 * distinct matching terms + total occurrences (+5 when rawQuery occurs literally). See deviation (3). */
function scoreKeyword(queryTokens, summary, rawQuery) {
  const hay = String(summary == null ? '' : summary).toLowerCase();
  if (!hay) return 0;
  const hayTokens = tokenize(hay);
  const counts = new Map();
  for (const tok of hayTokens) counts.set(tok, (counts.get(tok) || 0) + 1);
  let distinct = 0, occurrences = 0;
  const seen = new Set();
  for (const q of (queryTokens || [])) {
    if (seen.has(q)) continue;
    seen.add(q);
    const c = counts.get(q) || 0;
    if (c > 0) { distinct++; occurrences += c; }
  }
  if (distinct === 0) return 0;
  let score = 10 * distinct + occurrences;
  const phrase = rawQuery == null ? '' : String(rawQuery).toLowerCase().trim();
  if (phrase && phrase.length > 1 && hay.includes(phrase)) score += 5;
  return score;
}

// ---- derived stores ---------------------------------------------------------------------------------
function readJsonlRecords(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { const r = JSON.parse(s); if (r && typeof r === 'object') out.push(r); }
    catch { /* malformed derived line — skip; events.jsonl remains the source of truth */ }
  }
  return out;
}
function serializeRecords(records) { return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''); }
function readState(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return {}; }
  try { const s = JSON.parse(raw); return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {}; }
  catch { return {}; } // an unreadable offset file only costs a full re-ingest, never correctness
}
function writeState(p, state) { atomicWriteFile(p, Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf8')); }

const SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS entries (',
  '  id INTEGER PRIMARY KEY, event_uid TEXT NOT NULL UNIQUE, ts TEXT, run_id TEXT NOT NULL, agent TEXT,',
  '  event_type TEXT NOT NULL, tool TEXT, summary TEXT NOT NULL, ref_path TEXT NOT NULL, line_no INTEGER NOT NULL,',
  '  summary_fields TEXT);',
  'CREATE INDEX IF NOT EXISTS entries_run_id_idx ON entries(run_id);',
  'CREATE INDEX IF NOT EXISTS entries_event_type_idx ON entries(event_type);',
  'CREATE INDEX IF NOT EXISTS entries_ts_idx ON entries(ts);',
  "CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(summary, content='entries', content_rowid='id');",
  'CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN',
  '  INSERT INTO entries_fts(rowid, summary) VALUES (new.id, new.summary);',
  'END;',
  'CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN',
  "  INSERT INTO entries_fts(entries_fts, rowid, summary) VALUES ('delete', old.id, old.summary);",
  'END;',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);',
].join('\n');

function openDb(paths, create) {
  if (!create && !fs.existsSync(paths.dbPath)) return null;
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(paths.dir, { recursive: true });
  const db = new DatabaseSync(paths.dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
  } catch (e) { try { db.close(); } catch { /* ignore */ } throw e; }
  return db;
}
function closeDb(db) { if (db) { try { db.close(); } catch { /* best-effort */ } } }

// ---- ingest -----------------------------------------------------------------------------------------
/** splitConsumableLines — returns only WHOLE lines (a trailing partial line, i.e. a writer mid-append, is
 *  deliberately left unconsumed so the next ingest picks it up complete). Windows-safe (\r\n) + BOM-tolerant. */
function splitConsumableLines(chunkBuf, isFileStart) {
  let text = chunkBuf.toString('utf8');
  let bomBytes = 0;
  if (isFileStart && text.charCodeAt(0) === 0xfeff) { text = text.slice(1); bomBytes = 3; }
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { lines: [], consumedBytes: 0 };
  const consumable = text.slice(0, lastNl + 1);
  const lines = consumable.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, consumedBytes: bomBytes + Buffer.byteLength(consumable, 'utf8') };
}

function emptyIngest(backend, paths, reason) {
  return { ok: false, reason, backend, runs: [], added: 0, total: 0, dbPath: paths ? paths.dbPath : null, jsonlPath: paths ? paths.jsonlPath : null, indexed_at: null };
}

/** ingest(opts) -> {ok, backend, runs[], added, total, dbPath, jsonlPath, indexed_at}.
 *  Incremental via state.json; a shrunk file or a prefix whose hash no longer matches triggers a FULL
 *  re-ingest of THAT run only (rebuilt:true + a real reason). Idempotent: a duplicate event_uid is ignored. */
function ingest(opts) {
  opts = opts || {};
  const root = resolveRoot(opts.root);
  const info = backendInfo(opts);
  let paths;
  try { paths = indexPaths(root); }
  catch (e) { return emptyIngest(info.backend, null, e.message); }

  let runIds;
  if (opts.runId != null) runIds = [String(opts.runId)];
  else if (Array.isArray(opts.runIds)) runIds = opts.runIds.map(String);
  else runIds = listRunDirs(root);
  for (const r of runIds) {
    if (!isValidRunId(r)) return emptyIngest(info.backend, paths, 'invalid run_id (allowed: A-Z a-z 0-9 _ -): ' + r);
  }

  const state = readState(paths.statePath);
  let records = readJsonlRecords(paths.jsonlPath);
  const uids = new Set(records.map((r) => r.event_uid));

  let db = null;
  if (info.backend === 'sqlite-fts5') {
    try { db = openDb(paths, true); }
    catch (e) { db = null; info.backend = 'jsonl-keyword'; info.reason = 'sqlite index unusable, keyword store still canonical: ' + e.message; }
  }

  const runsOut = [];
  const appended = [];
  let rewriteWholeJsonl = false;
  const nowIso = new Date().toISOString();

  try {
    for (const runId of runIds) {
      const file = eventsPathFor(root, runId);
      let st;
      try { st = fs.statSync(file); } catch { continue; } // no events.jsonl => not a run we can index
      if (!st.isFile()) continue;

      const prev = state[runId];
      let startBytes = 0, startLines = 0, rebuilt = false, reason = null;
      if (opts.full === true) {
        if (prev) { rebuilt = true; reason = 'full re-ingest requested (--full)'; }
      } else if (prev) {
        const check = validateOffset(file, prev, st);
        if (check.valid) { startBytes = prev.bytes; startLines = prev.lines; }
        else { rebuilt = true; reason = check.reason; }
      }

      if (rebuilt || (opts.full === true && prev)) {
        // drop everything previously indexed for THIS run, then re-read it from byte 0
        const before = records.length;
        records = records.filter((r) => r.run_id !== runId);
        if (records.length !== before) rewriteWholeJsonl = true;
        for (const r of uids) { /* uids rebuilt below */ void r; break; }
        uids.clear();
        for (const r of records) uids.add(r.event_uid);
        for (const a of appended) if (a.run_id !== runId) uids.add(a.event_uid);
        if (db) { try { db.prepare('DELETE FROM entries WHERE run_id = ?').run(runId); } catch (e) { reason = (reason || '') + ' (sqlite purge failed: ' + e.message + ')'; } }
        startBytes = 0; startLines = 0;
      }

      const fd = fs.openSync(file, 'r');
      let chunk;
      try {
        const size = st.size;
        const len = Math.max(0, size - startBytes);
        chunk = Buffer.alloc(len);
        if (len > 0) fs.readSync(fd, chunk, 0, len, startBytes);
      } finally { fs.closeSync(fd); }

      const { lines, consumedBytes } = splitConsumableLines(chunk, startBytes === 0);
      let added = 0, skipped = 0;
      for (let i = 0; i < lines.length; i++) {
        const lineNo = startLines + i + 1;
        const raw = lines[i].trim();
        if (!raw) { skipped++; continue; }
        let ev;
        try { ev = JSON.parse(raw); } catch { skipped++; continue; }
        const rec = toIndexRecord(ev, { runId, lineNo, root });
        if (!rec) { skipped++; continue; }
        if (uids.has(rec.event_uid)) { skipped++; continue; }
        uids.add(rec.event_uid);
        appended.push(rec);
        added++;
      }

      if (db && appended.length) insertRecords(db, appended.filter((r) => r.run_id === runId && !r._stored), true);

      const consumedText = lines.length ? lines.join('\n') : '';
      state[runId] = {
        bytes: startBytes + consumedBytes,
        lines: startLines + lines.length,
        last_entry_hash: lines.length ? sha256(lines[lines.length - 1]) : (prev && !rebuilt ? prev.last_entry_hash : null),
        prefix_sha256: prefixHash(file, startBytes + consumedBytes),
        mtime_ms: fs.statSync(file).mtimeMs,
        indexed_at: nowIso,
      };
      void consumedText;
      runsOut.push({ run_id: runId, scanned: lines.length, added, skipped, rebuilt, reason });
    }

    // one bundled write per ingest (never a per-record append)
    if (appended.length || rewriteWholeJsonl) {
      if (rewriteWholeJsonl) {
        records = records.concat(appended);
        atomicWriteFile(paths.jsonlPath, Buffer.from(serializeRecords(records), 'utf8'));
      } else {
        fs.mkdirSync(paths.dir, { recursive: true });
        if (!fs.existsSync(paths.jsonlPath)) atomicWriteFile(paths.jsonlPath, Buffer.from('', 'utf8'));
        fs.appendFileSync(paths.jsonlPath, serializeRecords(appended), 'utf8');
        records = records.concat(appended);
      }
    } else {
      fs.mkdirSync(paths.dir, { recursive: true });
      if (!fs.existsSync(paths.jsonlPath)) atomicWriteFile(paths.jsonlPath, Buffer.from('', 'utf8'));
    }
    writeState(paths.statePath, state);
  } finally { closeDb(db); }

  return {
    ok: true,
    backend: info.backend,
    runs: runsOut,
    added: runsOut.reduce((n, r) => n + r.added, 0),
    total: records.length,
    dbPath: paths.dbPath,
    jsonlPath: paths.jsonlPath,
    indexed_at: nowIso,
  };
}

/** prefixHash — sha256 over the first `bytes` bytes of the file. This is what makes a resumed offset an
 *  actual VERIFIED offset rather than a hopeful one: rewrite the history and the hash stops matching. */
function prefixHash(file, bytes) {
  if (!bytes) return sha256('');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, 0);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } finally { fs.closeSync(fd); }
}
function validateOffset(file, prev, st) {
  if (!prev || typeof prev.bytes !== 'number' || typeof prev.lines !== 'number') return { valid: false, reason: 'no usable stored offset — full re-ingest' };
  if (st.size < prev.bytes) return { valid: false, reason: 'events.jsonl shrank (' + st.size + ' < stored offset ' + prev.bytes + ') — the file was truncated or rewritten' };
  if (prev.prefix_sha256) {
    let h;
    try { h = prefixHash(file, prev.bytes); } catch (e) { return { valid: false, reason: 'could not verify the stored offset: ' + e.message }; }
    if (h !== prev.prefix_sha256) return { valid: false, reason: 'content at the stored offset no longer matches its recorded hash — the file was rewritten' };
  }
  return { valid: true, reason: null };
}

function insertRecords(db, recs, markStored) {
  if (!recs.length) return 0;
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO entries (event_uid, ts, run_id, agent, event_type, tool, summary, ref_path, line_no, summary_fields) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of recs) {
      const res = stmt.run(r.event_uid, r.ts, r.run_id, r.agent, r.event_type, r.tool, r.summary, r.ref_path, r.line_no, JSON.stringify(r.summary_fields || []));
      if (res && res.changes) n++;
      if (markStored) Object.defineProperty(r, '_stored', { value: true, enumerable: false, configurable: true });
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  return n;
}

// ---- staleness --------------------------------------------------------------------------------------
function staleRuns(root, state) {
  const out = [];
  for (const runId of listRunDirs(root)) {
    let st;
    try { st = fs.statSync(eventsPathFor(root, runId)); } catch { continue; }
    const prev = state[runId];
    if (!prev) { out.push(runId); continue; }
    if (st.size !== prev.bytes) { out.push(runId); continue; }
    if (prev.mtime_ms != null && st.mtimeMs > prev.mtime_ms) out.push(runId);
  }
  return out;
}
function newestIndexedAt(state) {
  let newest = null;
  for (const k of Object.keys(state)) {
    const v = state[k];
    if (v && typeof v.indexed_at === 'string' && (!newest || v.indexed_at > newest)) newest = v.indexed_at;
  }
  return newest;
}

// ---- search -----------------------------------------------------------------------------------------
function recordFromRow(row) {
  let fields = [];
  try { const p = JSON.parse(row.summary_fields || '[]'); if (Array.isArray(p)) fields = p; } catch { fields = []; }
  return {
    ts: row.ts == null ? null : row.ts,
    run_id: row.run_id,
    agent: row.agent == null ? null : row.agent,
    event_type: row.event_type,
    tool: row.tool == null ? null : row.tool,
    summary: row.summary,
    ref_path: row.ref_path,
    line_no: row.line_no,
    event_uid: row.event_uid,
    summary_fields: fields,
  };
}
function buildFilters(opts) {
  return {
    runId: opts.runId != null ? String(opts.runId) : null,
    agent: opts.agent != null ? String(opts.agent) : null,
    eventType: opts.eventType != null ? String(opts.eventType) : null,
    since: opts.since != null ? String(opts.since) : null,
    until: opts.until != null ? String(opts.until) : null,
    rejectedOnly: opts.rejectedOnly === true,
    excludeRejected: opts.excludeRejected === true,
    minScore: Number.isFinite(opts.minScore) ? opts.minScore : 0,
  };
}
function passesFilters(rec, f) {
  if (f.runId && rec.run_id !== f.runId) return false;
  if (f.agent && String(rec.agent || '') !== f.agent) return false;
  if (f.eventType && rec.event_type !== f.eventType) return false;
  if (f.rejectedOnly && rec.event_type !== REJECTED_EVENT_TYPE) return false;
  if (f.excludeRejected && rec.event_type === REJECTED_EVENT_TYPE) return false;
  if (f.since && (!rec.ts || rec.ts < f.since)) return false;
  if (f.until && (!rec.ts || rec.ts > f.until)) return false;
  return true;
}
/** Deterministic ordering in BOTH backends: score DESC, then ts DESC, then event_uid ASC. */
function compareHits(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const at = a.ts || '', bt = b.ts || '';
  if (at !== bt) return at < bt ? 1 : -1;
  return a.event_uid < b.event_uid ? -1 : (a.event_uid > b.event_uid ? 1 : 0);
}
function sqlFiltersFor(f) {
  const where = [], params = [];
  if (f.runId) { where.push('e.run_id = ?'); params.push(f.runId); }
  if (f.agent) { where.push('e.agent = ?'); params.push(f.agent); }
  if (f.eventType) { where.push('e.event_type = ?'); params.push(f.eventType); }
  if (f.rejectedOnly) { where.push('e.event_type = ?'); params.push(REJECTED_EVENT_TYPE); }
  if (f.excludeRejected) { where.push('e.event_type <> ?'); params.push(REJECTED_EVENT_TYPE); }
  if (f.since) { where.push('e.ts IS NOT NULL AND e.ts >= ?'); params.push(f.since); }
  if (f.until) { where.push('e.ts IS NOT NULL AND e.ts <= ?'); params.push(f.until); }
  return { where, params };
}

/** search(query, opts) -> {ok, backend, query, matchExpr, filters, total, hits, indexed_at, stale, reason}.
 *  `total` is the real number of matching records; `hits` is that list capped at `limit`. */
function search(query, opts) {
  opts = opts || {};
  const root = resolveRoot(opts.root);
  const info = backendInfo(opts);
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 20;
  const filters = buildFilters(opts);
  const matchExpr = buildMatchExpr(query);
  const base = {
    ok: true, backend: info.backend, query: query == null ? '' : String(query), matchExpr, filters,
    total: 0, hits: [], indexed_at: null, stale: false, reason: info.reason || null,
  };
  if (filters.runId && !isValidRunId(filters.runId)) {
    return Object.assign(base, { ok: false, reason: 'invalid run_id filter (allowed: A-Z a-z 0-9 _ -): ' + filters.runId });
  }
  let paths;
  try { paths = indexPaths(root); } catch (e) { return Object.assign(base, { ok: false, reason: e.message }); }

  const state = readState(paths.statePath);
  base.indexed_at = newestIndexedAt(state);
  base.stale = staleRuns(root, state).length > 0;

  const qTokens = tokenize(query);
  let hits = null;

  if (info.backend === 'sqlite-fts5') {
    const jsonlCount = countJsonlRecords(paths.jsonlPath);
    let db = null;
    try {
      db = openDb(paths, false);
      if (db) {
        const dbCount = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
        if (dbCount === 0 && jsonlCount > 0) {
          base.backend = 'jsonl-keyword';
          base.reason = 'the sqlite index is empty while the canonical JSONL store holds ' + jsonlCount + ' record(s) — falling back to keyword scoring';
        } else if (matchExpr) {
          const { where, params } = sqlFiltersFor(filters);
          const sql = 'SELECT e.event_uid, e.ts, e.run_id, e.agent, e.event_type, e.tool, e.summary, e.ref_path, e.line_no, e.summary_fields, bm25(entries_fts) AS bm ' +
            'FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid WHERE entries_fts MATCH ?' +
            (where.length ? ' AND ' + where.join(' AND ') : '');
          const rows = db.prepare(sql).all.apply(db.prepare(sql), [matchExpr].concat(params));
          hits = rows.map((row) => Object.assign(recordFromRow(row), { score: -Number(row.bm), rank: 0 }));
        } else {
          hits = []; // no real tokens — zero hits, and MATCH is never touched
        }
      } else if (jsonlCount > 0) {
        base.backend = 'jsonl-keyword';
        base.reason = 'no sqlite index file yet — falling back to keyword scoring over the canonical JSONL store';
      } else {
        hits = [];
      }
    } catch (e) {
      // any residual FTS/sqlite failure degrades HONESTLY, it never throws at the caller
      hits = null;
      base.backend = 'jsonl-keyword';
      base.reason = 'sqlite/FTS5 query failed, fell back to keyword scoring: ' + e.message;
    } finally { closeDb(db); }
  }

  if (hits === null) {
    const records = readJsonlRecords(paths.jsonlPath);
    hits = [];
    if (matchExpr) {
      for (const r of records) {
        const score = scoreKeyword(qTokens, r.summary, query);
        if (score <= 0) continue;
        hits.push(Object.assign({}, r, { summary_fields: Array.isArray(r.summary_fields) ? r.summary_fields : [], score, rank: 0 }));
      }
    }
    hits = hits.filter((h) => passesFilters(h, filters));
  }

  hits = hits.filter((h) => h.score >= filters.minScore);
  hits.sort(compareHits);
  base.total = hits.length;
  base.hits = hits.slice(0, limit).map((h, i) => Object.assign(h, { rank: i + 1 }));
  return base;
}
function countJsonlRecords(p) { return readJsonlRecords(p).length; }

/** wasRejected(query, opts) -> {tried, hits, total, backend, query, stale}. tried:false means ONLY "nothing
 *  in the index". When stale is true the caller MUST NOT present that as "not yet tried". */
function wasRejected(query, opts) {
  opts = opts || {};
  const r = search(query, Object.assign({}, opts, { rejectedOnly: true, excludeRejected: false }));
  return { tried: r.ok && r.total > 0, hits: r.hits, total: r.total, backend: r.backend, query: r.query, stale: r.stale, ok: r.ok, reason: r.reason };
}

// ---- resolve ----------------------------------------------------------------------------------------
function parseRef(ref) {
  if (ref == null) return null;
  const m = REF_RE.exec(String(ref).replace(/\\/g, '/'));
  if (!m) return null;
  if (!isValidRunId(m[1])) return null;
  const lineNo = Number(m[2]);
  if (!Number.isInteger(lineNo) || lineNo < 1) return null;
  return { runId: m[1], lineNo };
}
function looksLikeEntryHash(uid, runId, lineNo) { return uid !== runId + ':' + lineNo; }
/** resolve(refOrRecord, opts) -> {ok, path, line_no, event, reason}. Reads EXACTLY the referenced line from
 *  events.jsonl and hands back the FULL original event. Verifies the line exists, parses, its event_type
 *  matches the index record, and (when the index holds one) its entry_hash. On ANY mismatch it returns
 *  {ok:false, event:null, reason} — never a reconstructed or guessed event. */
function resolve(refOrRecord, opts) {
  opts = opts || {};
  const root = resolveRoot(opts.root);
  const rec = (refOrRecord && typeof refOrRecord === 'object' && !Array.isArray(refOrRecord)) ? refOrRecord : null;
  const ref = rec ? rec.ref_path : refOrRecord;
  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, path: null, line_no: null, event: null, reason: 'unparsable or out-of-project ref_path: ' + String(ref) };

  let file;
  try { file = eventsPathFor(root, parsed.runId); }
  catch (e) { return { ok: false, path: null, line_no: parsed.lineNo, event: null, reason: e.message }; }

  let expected = rec;
  if (!expected) {
    let paths;
    try { paths = indexPaths(root); } catch (e) { return { ok: false, path: file, line_no: parsed.lineNo, event: null, reason: e.message }; }
    expected = readJsonlRecords(paths.jsonlPath).find((r) => r.run_id === parsed.runId && Number(r.line_no) === parsed.lineNo) || null;
  }
  if (!expected) {
    return { ok: false, path: file, line_no: parsed.lineNo, event: null, reason: 'no index record for ' + ref + ' — run `ingest` first (resolve verifies the line against the index)' };
  }

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, path: file, line_no: parsed.lineNo, event: null, reason: 'could not read ' + ref + ': ' + e.message }; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const lines = raw.split(/\r?\n/);
  const line = lines[parsed.lineNo - 1];
  if (line == null || !line.trim()) {
    return { ok: false, path: file, line_no: parsed.lineNo, event: null, reason: 'line ' + parsed.lineNo + ' no longer exists in ' + ref + ' — the source file changed since indexing' };
  }
  let event;
  try { event = JSON.parse(line.trim()); }
  catch (e) { return { ok: false, path: file, line_no: parsed.lineNo, event: null, reason: 'line ' + parsed.lineNo + ' is no longer valid JSON: ' + e.message }; }
  if (!event || typeof event !== 'object' || event.event_type !== expected.event_type) {
    return { ok: false, path: file, line_no: parsed.lineNo, event: null, reason: 'event_type drift at line ' + parsed.lineNo + ': index says "' + expected.event_type + '", file says "' + (event && event.event_type) + '"' };
  }
  if (expected.event_uid && looksLikeEntryHash(expected.event_uid, parsed.runId, parsed.lineNo) && event.entry_hash && event.entry_hash !== expected.event_uid) {
    return { ok: false, path: file, line_no: parsed.lineNo, event: null, reason: 'entry_hash mismatch at line ' + parsed.lineNo + ' — the logged event was altered after indexing' };
  }
  return { ok: true, path: file, line_no: parsed.lineNo, event, reason: null };
}

// ---- stats / rebuild --------------------------------------------------------------------------------
/** stats(opts) — reports BOTH store counts and sets mismatch:true when they disagree. It never silently
 *  reports whichever number looks better. */
function stats(opts) {
  opts = opts || {};
  const root = resolveRoot(opts.root);
  const info = backendInfo(opts);
  const paths = indexPaths(root);
  const records = readJsonlRecords(paths.jsonlPath);
  const state = readState(paths.statePath);

  const byRunId = {}, byEventType = {};
  let newestTs = null;
  for (const r of records) {
    byRunId[r.run_id] = (byRunId[r.run_id] || 0) + 1;
    byEventType[r.event_type] = (byEventType[r.event_type] || 0) + 1;
    if (r.ts && (!newestTs || r.ts > newestTs)) newestTs = r.ts;
  }
  let dbRecords = null;
  if (info.backend === 'sqlite-fts5' && fs.existsSync(paths.dbPath)) {
    let db = null;
    try { db = openDb(paths, false); if (db) dbRecords = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n; }
    catch { dbRecords = null; }
    finally { closeDb(db); }
  }
  return {
    ok: true, backend: info.backend, records: records.length, byRunId, byEventType,
    jsonlRecords: records.length, dbRecords,
    mismatch: dbRecords !== null && dbRecords !== records.length,
    newestTs, stale: staleRuns(root, state), indexed_at: newestIndexedAt(state),
    dbPath: paths.dbPath, jsonlPath: paths.jsonlPath, schemaVersion: SCHEMA_VERSION,
  };
}

/** rebuild(opts) — deletes ONLY the derived files under .claude/forge-index/ and re-ingests everything.
 *  events.jsonl is never touched: it is the single source of truth. */
function rebuild(opts) {
  opts = opts || {};
  const root = resolveRoot(opts.root);
  const paths = indexPaths(root);
  const removed = [];
  for (const p of [paths.dbPath, paths.dbPath + '-wal', paths.dbPath + '-shm', paths.dbPath + '-journal', paths.jsonlPath, paths.statePath]) {
    assertContained(p, paths.dir, '.claude/forge-index');
    try { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(p); } }
    catch { /* a file we cannot remove is reported by simply not being listed */ }
  }
  const r = ingest(Object.assign({}, opts, { full: true }));
  return Object.assign({ removed }, r);
}

module.exports = {
  resolveRoot, indexPaths, backendInfo, toIndexRecord, ingest, search, wasRejected, resolve, stats, rebuild,
  tokenize, scoreKeyword, buildMatchExpr, parseRef, isValidRunId, listRunDirs, staleRuns, compareHits,
  SCHEMA_VERSION, REJECTED_EVENT_TYPE, SUMMARY_FIELDS, SUMMARY_MAX_CHARS,
};

// ---- CLI --------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { cmd: argv[0] || null, positional: [], root: null, run: null, agent: null, type: null, since: null, until: null, limit: null, backend: null, json: false, full: false, all: false, rejected: false, excludeRejected: false, unknownFlag: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = argv[++i];
    else if (a === '--run') o.run = argv[++i];
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '--type') o.type = argv[++i];
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--until') o.until = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--backend') o.backend = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--full') o.full = true;
    else if (a === '--all') o.all = true;
    else if (a === '--rejected') o.rejected = true;
    else if (a === '--exclude-rejected') o.excludeRejected = true;
    else if (a.startsWith('--')) o.unknownFlag = a;
    else o.positional.push(a);
  }
  return o;
}
function printUsage() {
  console.error('Usage: node forge-tool-index.cjs ingest  [--run <id>] [--all] [--full] [--root <p>] [--backend sqlite|jsonl] [--json]');
  console.error('       node forge-tool-index.cjs search  <query> [--run <id>] [--agent <n>] [--type <t>] [--since <iso>] [--until <iso>] [--limit <n>] [--rejected] [--exclude-rejected] [--root <p>] [--json]');
  console.error('       node forge-tool-index.cjs tried   <query> [--limit <n>] [--root <p>] [--json]');
  console.error('       node forge-tool-index.cjs resolve <ref_path> [--root <p>] [--json]');
  console.error('       node forge-tool-index.cjs stats   [--root <p>] [--json]');
  console.error('       node forge-tool-index.cjs rebuild [--root <p>] [--json]');
  console.error('Exit: 0 ok (search/tried: >=1 hit) · 3 no result · 2 usage error · 1 real error');
}
function searchOptsFrom(o) {
  const s = { root: o.root, backend: o.backend };
  if (o.run) s.runId = o.run;
  if (o.agent) s.agent = o.agent;
  if (o.type) s.eventType = o.type;
  if (o.since) s.since = o.since;
  if (o.until) s.until = o.until;
  if (Number.isFinite(o.limit)) s.limit = o.limit;
  if (o.rejected) s.rejectedOnly = true;
  if (o.excludeRejected) s.excludeRejected = true;
  return s;
}
function printHits(r) {
  if (r.stale) console.log('! index is STALE (an events.jsonl moved on since the last ingest) — "no hit" here does NOT mean "never tried"');
  console.log(r.total + ' hit(s) · backend ' + r.backend + (r.reason ? ' (' + r.reason + ')' : ''));
  for (const h of r.hits) {
    console.log('  #' + h.rank + ' score=' + h.score.toFixed(4) + '  ' + h.run_id + '  ' + h.event_type + '  ' + (h.agent || '-') + '  ' + h.ref_path);
    console.log('       ' + h.summary);
  }
}

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  try {
    if (o.unknownFlag) { console.error('forge-tool-index: unknown flag ' + o.unknownFlag); printUsage(); process.exitCode = 2; }
    else if (o.cmd === 'ingest') {
      const r = ingest({ root: o.root, runId: o.run || undefined, full: o.full, backend: o.backend });
      if (o.json) console.log(JSON.stringify(r));
      else if (r.ok) console.log('indexed ' + r.added + ' new record(s) across ' + r.runs.length + ' run(s) · total ' + r.total + ' · backend ' + r.backend);
      else console.error('forge-tool-index: ' + r.reason);
      process.exitCode = r.ok ? 0 : 1;
    } else if (o.cmd === 'search') {
      const q = o.positional[0];
      if (!q) { console.error('forge-tool-index: search needs a query'); printUsage(); process.exitCode = 2; }
      else {
        const r = search(q, searchOptsFrom(o));
        if (o.json) console.log(JSON.stringify(r));
        else printHits(r);
        process.exitCode = !r.ok ? 1 : (r.total > 0 ? 0 : 3);
      }
    } else if (o.cmd === 'tried') {
      const q = o.positional[0];
      if (!q) { console.error('forge-tool-index: tried needs a query'); printUsage(); process.exitCode = 2; }
      else {
        const r = wasRejected(q, { root: o.root, backend: o.backend, limit: Number.isFinite(o.limit) ? o.limit : undefined });
        if (o.json) console.log(JSON.stringify(r));
        else {
          console.log(r.tried ? ('ALREADY TRIED — ' + r.total + ' rejected approach(es) match') : 'no rejected approach on record for this query');
          if (r.stale) console.log('! index is STALE — this is NOT proof that it was never tried');
          for (const h of r.hits) console.log('  ' + h.run_id + '  ' + h.ref_path + '\n       ' + h.summary);
        }
        process.exitCode = r.ok === false ? 1 : (r.tried ? 0 : 3);
      }
    } else if (o.cmd === 'resolve') {
      const ref = o.positional[0];
      if (!ref) { console.error('forge-tool-index: resolve needs a ref_path'); printUsage(); process.exitCode = 2; }
      else {
        const r = resolve(ref, { root: o.root });
        if (o.json) console.log(JSON.stringify(r));
        else if (r.ok) console.log(JSON.stringify(r.event, null, 2));
        else console.error('forge-tool-index: ' + r.reason);
        process.exitCode = r.ok ? 0 : 3;
      }
    } else if (o.cmd === 'stats') {
      const r = stats({ root: o.root, backend: o.backend });
      if (o.json) console.log(JSON.stringify(r));
      else {
        console.log('forge-tool-index · backend ' + r.backend + ' · schema v' + r.schemaVersion);
        console.log('  records: ' + r.records + ' (jsonl ' + r.jsonlRecords + ' / db ' + (r.dbRecords === null ? 'n/a' : r.dbRecords) + ')' + (r.mismatch ? '  MISMATCH' : ''));
        console.log('  runs: ' + Object.keys(r.byRunId).length + ' · event types: ' + Object.keys(r.byEventType).length + ' · newest ts: ' + (r.newestTs || 'n/a'));
        if (r.stale.length) console.log('  STALE runs (' + r.stale.length + '): ' + r.stale.slice(0, 10).join(', ') + (r.stale.length > 10 ? ' …' : ''));
      }
      process.exitCode = 0;
    } else if (o.cmd === 'rebuild') {
      const r = rebuild({ root: o.root, backend: o.backend });
      if (o.json) console.log(JSON.stringify(r));
      else console.log('rebuilt: removed ' + r.removed.length + ' derived file(s), re-indexed ' + r.total + ' record(s) · backend ' + r.backend);
      process.exitCode = r.ok ? 0 : 1;
    } else {
      if (o.cmd) console.error('forge-tool-index: unknown command "' + o.cmd + '"');
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-tool-index: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  }
}
