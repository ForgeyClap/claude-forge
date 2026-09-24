#!/usr/bin/env node
'use strict';
/**
 * forge-sweep-core.cjs — shared plumbing for forge-sweep.cjs (wp14, run forge-2026-09-24-config-v250).
 * Zero-dependency (fs/path/crypto). Holds ONLY the pieces every sweep stage needs: containment of every
 * path under the sweep dir, the append-only ledger (the single source of truth for every counter), the
 * checkpoint file (always written from ledger facts, so a lost write self-heals on the next action),
 * per-stage locks (one writer per stage per sweep dir), secret redaction, pacing, and the ledger-only
 * status counters.
 *
 * HONESTY: computeStatus() reads nothing but sweep-ledger.jsonl rows. A transcript file on disk without a
 * ledger row does not count; a counter can therefore never exceed what a real stage action recorded.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

class UsageError extends Error { constructor(m) { super(m); this.exitCode = 2; } }
class HardError extends Error { constructor(m) { super(m); this.exitCode = 1; } }

// Containment root: the project, or FORGE_SWEEP_ROOT (hermetic tests point it at a temp dir).
function containmentRoot() { return path.resolve(process.env.FORGE_SWEEP_ROOT || PROJECT_DIR); }
function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function localDate(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
function resolveSweepDir(dirArg) {
  const root = containmentRoot();
  const d = dirArg ? path.resolve(dirArg)
    : path.join(root, '.claude', 'forge-research', 'beginner-sweep-' + localDate());
  if (!isInside(root, d)) throw new UsageError('--dir must stay under ' + root + ' (got ' + d + ')');
  fs.mkdirSync(d, { recursive: true });
  if (!isInside(fs.realpathSync(root), fs.realpathSync(d))) throw new UsageError('--dir resolves outside ' + root + ' (symlink?)');
  return d;
}
// Every file the sweep writes goes through safeJoin — a hostile id/name can never escape the sweep dir.
function safeJoin(dir, ...parts) {
  const p = path.resolve(dir, ...parts);
  if (!isInside(path.resolve(dir), p)) throw new HardError('path escapes the sweep dir: ' + parts.join('/'));
  return p;
}
function isVideoId(id) { return typeof id === 'string' && VIDEO_ID_RE.test(id); }
function sweepDate(dir) { const m = /beginner-sweep-(\d{4}-\d{2}-\d{2})$/.exec(path.basename(dir)); return m ? m[1] : localDate(); }

// ---- redaction: applied to every error/stderr string before it is stored or printed ----
const REDACTIONS = [
  [/nvapi-[A-Za-z0-9_-]+/g, 'nvapi-***REDACTED***'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***REDACTED***'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***REDACTED***'],
  [/(account\s+')[^']+(')/gi, '$1***REDACTED***$2'],
];
function redact(s) {
  let out = String(s == null ? '' : s);
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

// ---- pacing (FORGE_SWEEP_SLEEP_SCALE=0 makes tests instant; the planned ms are still recorded) ----
function sleepScale() { const v = Number(process.env.FORGE_SWEEP_SLEEP_SCALE); return Number.isFinite(v) && v >= 0 ? v : 1; }
function sleepSync(ms) {
  const t = Math.round(ms * sleepScale());
  if (t > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, t);
  return t;
}
function sleepAsync(ms) { const t = Math.round(ms * sleepScale()); return new Promise((r) => setTimeout(r, t)); }
function jitter(min, max) { return Math.round(min + Math.random() * (max - min)); }

// ---- files ----
function writeFileAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i === 4) { fs.writeFileSync(file, text); try { fs.unlinkSync(tmp); } catch {} return; }
      sleepSync(50);
    }
  }
}
function readJsonl(file) {
  const rows = []; let malformed = 0; let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { rows, malformed, missing: true }; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { malformed++; }
  }
  return { rows, malformed, missing: false };
}
function writeJsonl(file, rows) { writeFileAtomic(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ---- ledger: one JSON row per real action ----
function ledgerFile(dir) { return safeJoin(dir, 'sweep-ledger.jsonl'); }
function appendLedger(dir, row) {
  const r = { ts: new Date().toISOString(), ...row };
  if (r.error) r.error = redact(r.error).slice(0, 600);
  fs.appendFileSync(ledgerFile(dir), JSON.stringify(r) + '\n');
  return r;
}
function readLedger(dir) { return readJsonl(ledgerFile(dir)); }
function latestBy(rows, stage, key) {
  const m = new Map();
  for (const r of rows) if (r.stage === stage && r[key] != null) m.set(r[key], r);
  return m;
}

// ---- checkpoints.json: { stage, done_ids, next, updated_at, stages{} } — read-modify-write of ONE stage ----
function writeCheckpoint(dir, stage, doneIds, next, extra) {
  const file = safeJoin(dir, 'checkpoints.json');
  let cp = {};
  try { cp = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const stages = (cp && typeof cp.stages === 'object' && cp.stages) || {};
  const done = [...doneIds];
  const now = new Date().toISOString();
  stages[stage] = { done_count: done.length, next, ...(extra || {}), done, updated_at: now };
  writeFileAtomic(file, JSON.stringify({ stage, done_ids: done, next, updated_at: now, stages }, null, 1) + '\n');
}

// ---- per-stage lock (logs/<stage>.pid doubles as the PID record for detached runs) ----
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireLock(dir, stage) {
  fs.mkdirSync(safeJoin(dir, 'logs'), { recursive: true });
  const lock = safeJoin(dir, 'logs', stage + '.pid');
  let prev = null;
  try { prev = Number(String(fs.readFileSync(lock, 'utf8')).trim().split(/\s+/)[0]); } catch {}
  if (prev && prev !== process.pid && pidAlive(prev)) {
    throw new HardError('stage "' + stage + '" is already running in this sweep dir (pid ' + prev + ', ' + lock
      + ') — one writer per stage; wait for it, or stop that exact PID if it is yours');
  }
  fs.writeFileSync(lock, process.pid + ' ' + new Date().toISOString() + '\n');
  const release = () => {
    try { if (String(fs.readFileSync(lock, 'utf8')).startsWith(process.pid + ' ')) fs.unlinkSync(lock); } catch {}
  };
  process.on('exit', release);
  return release;
}

// ---- status: counters from ledger rows ONLY ----
function sumUsage(acc, u) {
  if (!u || typeof u !== 'object') return acc;
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (Number.isFinite(Number(u[k]))) acc[k] += Number(u[k]);
  return acc;
}
function countBy(map, field) {
  const out = {};
  for (const r of map.values()) out[r[field]] = (out[r[field]] || 0) + 1;
  return out;
}
function computeStatus(dir) {
  const { rows, malformed, missing } = readLedger(dir);
  const enumRows = rows.filter((r) => r.stage === 'enumerate');
  const enumLatest = latestBy(rows, 'enumerate', 'query');
  const enumerate = {
    queries_attempted: enumLatest.size,
    by_outcome: countBy(enumLatest, 'outcome'),
    rows_returned: [...enumLatest.values()].reduce((a, r) => a + (Number(r.rows) || 0), 0),
    unique_candidates: enumRows.reduce((a, r) => a + (Number(r.new) || 0), 0),
    previously_seen_candidates: enumRows.reduce((a, r) => a + (Number(r.new_previously_seen) || 0), 0),
    ytdlp_calls: enumRows.length,
  };
  const filterRows = rows.filter((r) => r.stage === 'filter');
  const seedLatest = latestBy(rows, 'seed', 'id');
  const seeds = { ids: seedLatest.size, by_outcome: countBy(seedLatest, 'outcome'),
    ytdlp_calls: rows.filter((r) => r.stage === 'seed').reduce((a, r) => a + (Number(r.requests) || 0), 0) };
  const trRows = rows.filter((r) => r.stage === 'transcripts');
  const trLatest = latestBy(rows, 'transcripts', 'id');
  const trBy = countBy(trLatest, 'outcome');
  const transcripts = {
    videos_attempted: trLatest.size, by_outcome: trBy,
    ok: trBy.ok || 0, no_captions: trBy.no_captions || 0, rate_limited: trBy.rate_limited || 0, error: trBy.error || 0,
    transcript_chars: [...trLatest.values()].reduce((a, r) => a + (r.outcome === 'ok' ? Number(r.chars) || 0 : 0), 0),
    ytdlp_calls: trRows.reduce((a, r) => a + (Number(r.requests) || 0), 0),
    ledger_rows: trRows.length,
  };
  const exRows = rows.filter((r) => r.stage === 'extract');
  const exLatest = latestBy(rows, 'extract', 'id');
  const exBy = countBy(exLatest, 'outcome');
  const extract = {
    videos_attempted: exLatest.size, by_outcome: exBy, ok: exBy.ok || 0, extract_failed: exBy.extract_failed || 0,
    extract_error: exBy.extract_error || 0, model_calls: exRows.reduce((a, r) => a + (Number(r.calls) || 0), 0),
    nvidia_usage: exRows.reduce((a, r) => sumUsage(a, r.usage), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
    models: [...new Set(exRows.flatMap((r) => r.models || []))],
    mock_records: [...exLatest.values()].filter((r) => r.engine === 'mock').length,
  };
  const aggRows = rows.filter((r) => r.stage === 'aggregate');
  return {
    sweep_dir: dir, ledger_missing: missing, ledger_rows: rows.length, ledger_malformed: malformed,
    enumerate, seeds, filter: filterRows[filterRows.length - 1] || null, transcripts, extract,
    aggregate: aggRows[aggRows.length - 1] || null,
  };
}

// ---- known ids (dedupe base): earlier sweeps + the July YouTube batches + monthly-sweep id lists ----
function loadKnownIds() {
  const research = path.join(containmentRoot(), '.claude', 'forge-research');
  const ids = new Set(); const sources = [];
  const addText = (file) => {
    let n = 0;
    try { for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { const id = l.trim(); if (isVideoId(id)) { ids.add(id); n++; } } } catch { return; }
    sources.push({ file: path.relative(containmentRoot(), file), ids: n });
  };
  addText(path.join(research, '_known_video_ids.txt'));
  const batches = path.join(research, 'youtube-batches');
  let rowsN = 0; const batchIds = new Set();
  try {
    for (const f of fs.readdirSync(batches).filter((x) => x.endsWith('.jsonl'))) {
      for (const r of readJsonl(path.join(batches, f)).rows) { rowsN++; if (isVideoId(r.id)) { ids.add(r.id); batchIds.add(r.id); } }
    }
    sources.push({ file: path.relative(containmentRoot(), batches) + '/*.jsonl', rows: rowsN, unique_ids: batchIds.size });
  } catch {}
  try {
    for (const d of fs.readdirSync(research).filter((x) => /^maand-sweep-/.test(x))) {
      for (const f of fs.readdirSync(path.join(research, d)).filter((x) => /^_all_known_ids.*\.txt$/.test(x))) addText(path.join(research, d, f));
    }
  } catch {}
  return { ids, sources };
}


module.exports = {
  PROJECT_DIR, VIDEO_ID_RE, UsageError, HardError, containmentRoot, isInside, localDate, resolveSweepDir, safeJoin,
  isVideoId, sweepDate, redact, sleepSync, sleepAsync, sleepScale, jitter, writeFileAtomic, readJsonl, writeJsonl, sha256,
  appendLedger, readLedger, latestBy, writeCheckpoint, acquireLock, pidAlive, computeStatus, loadKnownIds,
};
