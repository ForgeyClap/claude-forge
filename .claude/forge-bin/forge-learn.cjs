#!/usr/bin/env node
'use strict';
/**
 * forge-learn.cjs — OPT-IN, READ-ONLY, cross-project FEDERATED lesson recall (WP6, scout find #6,
 * 2026-07-13).
 *
 * PROBLEM (verified gap): forge-memory.cjs's lessons are strictly per-project (.claude/agent-memory/).
 * forge-sync.cjs only PUSHES the canonical template DOWN into projects. There is no PULL-based, READ-ONLY
 * cross-project lesson store that a Boss's recall can be blended with, with clear provenance on every
 * federated hit. This tool adds exactly that, without ever touching forge-memory.cjs's storage format,
 * write path, or redaction logic (owned there — never re-implemented here).
 *
 * GUARANTEES
 *   OPT-IN:          no `.claude/config/forge-stores.json` (or an empty `stores: []`) means recall()
 *                    returns EXACTLY what forge-memory.cjs's own recall() would return — zero behavior
 *                    change for every project that hasn't declared a store.
 *   ISOLATION-SAFE:  this tool NEVER reads another project's raw `.claude/` folder. It only reads a
 *                    deliberately-separate, explicitly-declared shared "forge-learnings" directory named
 *                    in the manifest — a project's own agent-memory is never treated as a store source.
 *   READ-ONLY:       every store this tool touches is opened with fs.readFileSync/readdirSync/statSync/
 *                    lstatSync/accessSync only. Nothing under a store's `source` is ever created,
 *                    modified, renamed, or deleted. The only file this tool ever WRITES is this project's
 *                    OWN `.claude/config/forge-stores.lock` (via the `lock` command).
 *   NOT a promotion path: turning a run's outcome INTO a store lesson stays the owner-gated
 *                    distill -> canonical flow (forge-distill.cjs + a human copying/publishing a
 *                    lessons.jsonl into a shared location). This tool only ever CONSUMES a store.
 *
 * MANIFEST — `.claude/config/forge-stores.json`:
 *   { "stores": [ { "name": "team-shared", "source": "C:/abs/path/forge-learnings", "mode": "read-only",
 *                   "priority": 0.8 } ] }
 *   priority (0..1, default 0.8) is a score MULTIPLIER applied only to federated (never local) lessons,
 *   so a local lesson always wins a tie against a federated one of equal base relevance.
 *
 * STORE SHAPE — a store's `source` directory holds one subdirectory PER BOSS SLUG, each containing a
 * `lessons.jsonl` (same one-JSON-per-line lesson shape forge-memory.cjs writes: {type,text,tags,evidence,
 * ts}, optionally {v: 1}). Example: <source>/build-boss/lessons.jsonl.
 *
 * CLI
 *   node forge-learn.cjs recall <boss-slug> [keywords...] [--k N] [--json]
 *     Merge LOCAL per-Boss lessons (forge-memory.cjs) with every declared read-only store's lessons for
 *     that Boss, score by keyword/recency (same formula as forge-memory.cjs's recall), multiply federated
 *     scores by the store's priority, sort, and return the top-K (default 5). Federated lessons in the
 *     result carry `provenance: {store, source}`; local lessons are untouched (no provenance field) so
 *     the opt-in-off case is byte-for-byte what forge-memory.cjs's own recall() returns.
 *   node forge-learn.cjs stores [--json]
 *     List declared stores with resolved status (exists? readable? lesson count), or an honest
 *     "no stores declared (opt-in off) — local-only" when the manifest is absent/empty.
 *   node forge-learn.cjs lock [--json]
 *     Write `.claude/config/forge-stores.lock` recording each store's resolved version (git HEAD commit
 *     when `source` is a git repo, else an mtime+size hash over its files) for go.sum-style
 *     reproducibility. Read-only on the stores themselves — only the local .lock file is written.
 *
 * INGEST HARDENING (mandatory): regular files only — every entry is fs.lstatSync'd and a symlink is
 * SKIPPED, never followed; every resolved path is verified to stay under the store's `source` root
 * (path.resolve + containment check) before it is read, rejecting any traversal attempt; a malformed
 * JSON line is skipped and counted, never thrown; a lesson with an unknown `v` (format-version) is
 * ignored and counted (fail CLOSED on an unrecognized shape) rather than guessed at.
 *
 * Exit codes: 0 = success (including opt-in-off / an honest empty result) · 1 = real error · 2 = usage
 * error. FORGE_PROJECT_ROOT overrides the project root (same convention as forge-memory.cjs /
 * forge-distill.cjs) — every path is built with path.join/path.resolve, so this is Windows-safe.
 * Zero npm dependencies (fs/path/crypto only). No network. No LLM call anywhere in this file.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const memory = require('./forge-memory.cjs');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const TYPE_LABEL = { episodic: 'guard-rail', semantic: 'strategy', procedural: 'procedure' };

// ---- small pure helpers -----------------------------------------------------------------------

// Mirrors forge-memory.cjs's memDir() slug rule exactly, duplicated here (not exported there) so
// local and federated boss subdirectories resolve to the same name. forge-memory.cjs is not modified.
function sanitizeSlug(boss) {
  return String(boss == null ? '' : boss).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

// Containment check: resolves `parts` under `root` and returns the resolved path ONLY if it stays
// inside `root` (or equals it). Returns null on any traversal attempt — the caller must reject, never
// silently clamp. Exported so ingest-hardening can be proven directly in tests.
function safeResolve(root, ...parts) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (target === base) return target;
  return target.startsWith(base + path.sep) ? target : null;
}

// Same scoring formula as forge-memory.cjs's internal recall() (keyword/tag hits + recency decay over
// 60 days), duplicated here (not exported there) so local and federated lessons are ranked on one
// consistent scale before the store `priority` multiplier is applied.
function scoreLesson(lesson, terms, now) {
  const hay = ((lesson.text || '') + ' ' + (lesson.tags || []).join(' ')).toLowerCase();
  let s = 0;
  for (const t of terms) { if ((lesson.tags || []).includes(t)) s += 2; else if (hay.includes(t)) s += 1; }
  const ageDays = (now - Date.parse(lesson.ts)) / 86400000;
  const recency = Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / 60) : 0;
  return s + recency * 0.5;
}

function parseEvidenceRunId(evidence) { try { const o = JSON.parse(evidence); if (o && o.run_id) return o.run_id; } catch { /* not JSON */ } return evidence || 'unknown'; }

// ---- manifest / store resolution --------------------------------------------------------------

function manifestPath(root) { return path.join(root, '.claude', 'config', 'forge-stores.json'); }
function lockPath(root) { return path.join(root, '.claude', 'config', 'forge-stores.lock'); }

/** loadManifest(root) -> { stores:[...] } — absent/invalid manifest => stores:[] (opt-in off). Never throws. */
function loadManifest(root) {
  let raw;
  try { raw = fs.readFileSync(manifestPath(root), 'utf8'); } catch { return { stores: [] }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { stores: [] }; }
  return { stores: Array.isArray(parsed && parsed.stores) ? parsed.stores : [] };
}

/** Reads one boss subdirectory's lessons.jsonl file(s) from a store's source root, applying all
 *  ingest hardening. Returns { lessons, stats } — never throws; a missing/unreadable dir is an honest
 *  empty result, not an error. `stats` is mutated in place when passed in so a caller can accumulate
 *  counts across multiple boss dirs (used by countStoreLessons). */
function readBossLessonsFromStore(storeSourceAbs, bossSlugRaw, statsIn) {
  const stats = statsIn || { malformed: 0, skippedSymlink: 0, rejectedTraversal: 0, unknownVersion: 0 };
  const sourceRoot = path.resolve(storeSourceAbs);
  const lessons = [];
  const bossDir = safeResolve(sourceRoot, sanitizeSlug(bossSlugRaw));
  if (!bossDir) { stats.rejectedTraversal++; return { lessons, stats }; }
  let entries;
  try { entries = fs.readdirSync(bossDir, { withFileTypes: true }); } catch { return { lessons, stats }; }
  for (const entry of entries) {
    if (!/\.jsonl$/i.test(entry.name)) continue;
    const filePath = safeResolve(sourceRoot, path.relative(sourceRoot, path.join(bossDir, entry.name)));
    if (!filePath) { stats.rejectedTraversal++; continue; }
    let lst;
    try { lst = fs.lstatSync(filePath); } catch { continue; }
    if (lst.isSymbolicLink()) { stats.skippedSymlink++; continue; } // NEVER follow a symlink
    if (!lst.isFile()) continue;
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { stats.malformed++; continue; }
      if (!obj || typeof obj !== 'object') { stats.malformed++; continue; }
      if (obj.v != null && obj.v !== 1) { stats.unknownVersion++; continue; } // fail CLOSED on unknown format-version
      if (typeof obj.text !== 'string') { stats.malformed++; continue; }
      lessons.push(obj);
    }
  }
  return { lessons, stats };
}

/** Counts every lesson across ALL boss subdirectories directly under a store's source root (used for
 *  the `stores` status listing). Symlinked entries at the store root are skipped, never followed. */
function countStoreLessons(storeSourceAbs) {
  const sourceRoot = path.resolve(storeSourceAbs);
  const stats = { malformed: 0, skippedSymlink: 0, rejectedTraversal: 0, unknownVersion: 0 };
  let entries;
  try { entries = fs.readdirSync(sourceRoot, { withFileTypes: true }); } catch { return { count: 0, stats }; }
  let total = 0;
  for (const e of entries) {
    if (e.isSymbolicLink()) { stats.skippedSymlink++; continue; }
    if (!e.isDirectory()) continue;
    const { lessons } = readBossLessonsFromStore(sourceRoot, e.name, stats);
    total += lessons.length;
  }
  return { count: total, stats };
}

/** Resolves one manifest store entry into { name, source, mode, priority, ok, reason, lessonCount }.
 *  A missing/unreadable/non-directory source is reported (ok:false, reason) — never thrown. */
function resolveStore(storeDef, root) {
  const name = String((storeDef && storeDef.name) || '').trim() || '(unnamed)';
  const sourceRaw = storeDef && storeDef.source ? String(storeDef.source) : '';
  const mode = (storeDef && storeDef.mode) || 'read-only';
  let priority = 0.8;
  if (storeDef && Number.isFinite(storeDef.priority)) priority = Math.min(1, Math.max(0, storeDef.priority));
  const source = sourceRaw ? path.resolve(root, sourceRaw) : '';
  const result = { name, source, mode, priority, ok: false, reason: null, lessonCount: 0 };
  if (!source) { result.reason = 'store has no source path'; return result; }
  let st;
  try { st = fs.statSync(source); } catch { result.reason = 'source path does not exist: ' + source; return result; }
  if (!st.isDirectory()) { result.reason = 'source path is not a directory: ' + source; return result; }
  try { fs.accessSync(source, fs.constants.R_OK); } catch { result.reason = 'source path is not readable: ' + source; return result; }
  result.ok = true;
  result.lessonCount = countStoreLessons(source).count;
  return result;
}

/** listStores(root) -> { optInOff, stores:[resolveStore(...), ...] }. optInOff=true when the manifest
 *  is absent or declares zero stores — the honest "local-only" state. */
function listStores(root) {
  const manifest = loadManifest(root);
  if (!manifest.stores.length) return { optInOff: true, stores: [] };
  return { optInOff: false, stores: manifest.stores.map((s) => resolveStore(s, root)) };
}

// ---- federated recall --------------------------------------------------------------------------

/** recall(boss, query, k, root) -> lesson[]. With no manifest/empty stores this is BYTE-IDENTICAL to
 *  forge-memory.cjs's own recall() (opt-in-off proof). With declared stores, federated lessons are
 *  merged in, score-multiplied by store priority, and tagged `provenance:{store,source}`; local
 *  lessons are returned untouched so a local lesson always wins a tied score against a federated one. */
function recall(bossRaw, query, k, root) {
  root = root || PROJECT_ROOT;
  const terms = String(query == null ? '' : query).toLowerCase().split(/\W+/).filter(Boolean);
  const now = Date.parse(new Date().toISOString());

  const localAll = memory.listLessons(bossRaw, root);
  const items = localAll.map((l) => ({ lesson: l, isLocal: true, score: scoreLesson(l, terms, now) }));

  const manifest = loadManifest(root);
  for (const storeDef of manifest.stores) {
    const resolved = resolveStore(storeDef, root);
    if (!resolved.ok) continue; // reported via `stores`, never crashes recall
    const { lessons } = readBossLessonsFromStore(resolved.source, bossRaw, undefined);
    for (const fl of lessons) {
      const base = scoreLesson(fl, terms, now);
      const tagged = Object.assign({}, fl, { provenance: { store: resolved.name, source: resolved.source } });
      items.push({ lesson: tagged, isLocal: false, score: base * resolved.priority });
    }
  }

  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1; // LOCAL WINS TIES
    return 0;
  });
  return items.slice(0, k || 5).filter((x) => x.score > 0).map((x) => x.lesson);
}

function formatRecall(boss, lessons, optInOff) {
  if (!lessons.length) {
    return [optInOff
      ? `no lessons yet for ${boss} (local-only — no stores declared, opt-in off)`
      : `no lessons found for ${boss} (local + declared read-only stores checked)`];
  }
  const out = [`FEDERATED ADVISORY LESSONS for ${boss} (local + read-only stores, non-binding):`];
  lessons.forEach((l, i) => {
    const marker = l.provenance ? ` [store:${l.provenance.store}]` : '';
    out.push(`${i + 1}. [${TYPE_LABEL[l.type] || l.type}]${marker} ${l.text} (evidence: ${parseEvidenceRunId(l.evidence)})`);
  });
  return out;
}

// ---- lock (go.sum-style reproducibility) --------------------------------------------------------

/** Resolves a store's version: the git HEAD commit when `sourceAbs` is a git repo (handles both a
 *  symbolic ref and a detached HEAD), else a bounded mtime+size hash over its files (symlinks never
 *  followed). Read-only — never writes into the store. */
function resolveStoreVersion(sourceAbs) {
  try {
    const head = fs.readFileSync(path.join(sourceAbs, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*(.+)$/.exec(head);
    if (m) {
      const refPath = path.join(sourceAbs, '.git', m[1].split('/').join(path.sep));
      try { return { kind: 'git', ref: m[1], commit: fs.readFileSync(refPath, 'utf8').trim() }; }
      catch { return { kind: 'git', ref: m[1], commit: null }; } // packed-refs or unreadable — honest unknown
    }
    if (/^[0-9a-f]{7,40}$/i.test(head)) return { kind: 'git', ref: null, commit: head }; // detached HEAD
  } catch { /* not a git repo or unreadable — fall through to mtime-hash */ }
  return { kind: 'mtime-hash', commit: mtimeHash(sourceAbs) };
}

function mtimeHash(sourceAbs) {
  const root = path.resolve(sourceAbs);
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow symlinks
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) files.push(p);
    }
  }
  files.sort();
  const h = crypto.createHash('sha1');
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    h.update(path.relative(root, f) + ':' + st.mtimeMs + ':' + st.size + '\n');
  }
  return h.digest('hex').slice(0, 16);
}

/** writeLock(root) -> lock object, also persisted to `.claude/config/forge-stores.lock`. Read-only on
 *  every store; the ONLY file this function writes is the local .lock file. */
function writeLock(root) {
  const manifest = loadManifest(root);
  const stores = manifest.stores.map((s) => {
    const resolved = resolveStore(s, root);
    if (!resolved.ok) return { name: resolved.name, source: resolved.source, ok: false, reason: resolved.reason };
    return { name: resolved.name, source: resolved.source, ok: true, lessonCount: resolved.lessonCount, version: resolveStoreVersion(resolved.source) };
  });
  const lock = { generatedAt: new Date().toISOString(), stores };
  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
  fs.writeFileSync(lockPath(root), JSON.stringify(lock, null, 2) + '\n', 'utf8');
  return lock;
}

// ---- CLI ------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const cmd = argv[0] || null;
  const opts = { cmd, boss: null, keywords: [], k: 5, json: false };
  if (cmd === 'recall') {
    let i = 1;
    opts.boss = argv[i] && !argv[i].startsWith('--') ? argv[i++] : null;
    for (; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--k') opts.k = Number(argv[++i]);
      else if (a === '--json') opts.json = true;
      else opts.keywords.push(a);
    }
  } else if (cmd === 'stores' || cmd === 'lock') {
    for (let i = 1; i < argv.length; i++) if (argv[i] === '--json') opts.json = true;
  }
  return opts;
}

function printUsage() {
  console.error('Usage: node forge-learn.cjs recall <boss-slug> [keywords...] [--k N] [--json]');
  console.error('       node forge-learn.cjs stores [--json]');
  console.error('       node forge-learn.cjs lock [--json]');
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.cmd === 'recall') {
      if (!opts.boss) { printUsage(); process.exitCode = 2; }
      else {
        const k = Number.isFinite(opts.k) && opts.k > 0 ? opts.k : 5;
        const lessons = recall(opts.boss, opts.keywords.join(' '), k, PROJECT_ROOT);
        const manifest = loadManifest(PROJECT_ROOT);
        const optInOff = manifest.stores.length === 0;
        if (opts.json) console.log(JSON.stringify({ lessons, optInOff }));
        else console.log(formatRecall(opts.boss, lessons, optInOff).join('\n'));
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'stores') {
      const result = listStores(PROJECT_ROOT);
      if (opts.json) console.log(JSON.stringify(result));
      else if (result.optInOff) console.log('no stores declared (opt-in off) — local-only');
      else {
        console.log('declared stores:');
        for (const s of result.stores) console.log(`  ${s.name}: ${s.ok ? 'ok (' + s.lessonCount + ' lessons)' : 'UNAVAILABLE (' + s.reason + ')'} -> ${s.source}`);
      }
      process.exitCode = 0;
    } else if (opts.cmd === 'lock') {
      const lock = writeLock(PROJECT_ROOT);
      if (opts.json) console.log(JSON.stringify(lock));
      else console.log('wrote forge-stores.lock with ' + lock.stores.length + ' store(s).');
      process.exitCode = 0;
    } else { printUsage(); process.exitCode = 2; }
  } catch (e) { console.error('forge-learn: ' + e.message); process.exitCode = 1; }
}

module.exports = {
  recall, formatRecall, listStores, resolveStore, loadManifest, writeLock, resolveStoreVersion, mtimeHash,
  readBossLessonsFromStore, countStoreLessons, sanitizeSlug, safeResolve, scoreLesson, parseArgs,
  manifestPath, lockPath,
};
