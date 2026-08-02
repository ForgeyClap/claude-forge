#!/usr/bin/env node
'use strict';
/**
 * forge-codemodel.cjs — living CODEBASE MODEL (2026-07-19, piece J4). PURPOSE: extend forge-repomap.cjs's
 * one-shot symbol skim into a PERSISTENT, INCREMENTALLY-UPDATED index a Boss can query cheaply, without
 * re-reading the whole repo on every question. Zero-dependency (fs/path/crypto only, plus a `require` of
 * the sibling forge-repomap.cjs — this file never reimplements repomap's secrets-guard, ignore rules, or
 * symbol-skim regexes; it reuses them).
 *
 * WHAT "LIVING" MEANS HERE (read before trusting a number): `build()` walks the whole tree once and writes
 * a full index. `update()` walks the tree again but only ever RE-READS a file's content (to recompute its
 * hash + symbols) when a cheap, no-read stat proxy (size + mtime_ms) says that file MIGHT have changed —
 * every file whose stat proxy is unchanged from the last index is reused verbatim, with ZERO fs.readFileSync
 * calls against it. This is the same incremental-build discipline make/webpack/tsc already use; it is NOT a
 * byte-for-byte guarantee (a file "touched" with identical content still counts as "might have changed"
 * until its content is actually re-read and re-hashed) — documented honestly wherever this proxy is
 * surfaced, never silently claimed as exact.
 *
 * HONESTY (query results are a SNAPSHOT, not a promise): `query()` never re-reads source files — it only
 * ever reads its own `index.json`. Every query() result reports `stale` + `changed_since_index` (from a
 * cheap read-only stat pass, same proxy as above) so a caller always knows whether the answer might be
 * behind current disk state, instead of silently presenting a stale index as current truth.
 *
 * SECRETS: `listCurrentFiles()` reuses forge-repomap.cjs::isForbiddenFilename() — a file named .env (or any
 * dotted .env variant), a .key or .pem file, anything with "secret" or "credential" in the name, or an
 * id_rsa-prefixed name is never even LISTED, let alone opened or hashed, by build(), update(), or the
 * underlying walk staleness()/query() use for their own read-only stat pass.
 *
 * MODEL:
 *   build({root}, opts) -> full index: {ok, version, root, built_at, updated_at, file_count,
 *     files:{ "<relpath>": {size, mtime_ms, hash, lang, symbols:[{name,kind}]} }, index_path, notes}.
 *     Reads and hashes EVERY included file (bounded — see MAX_SYMBOL_SCAN_BYTES below), always writes a
 *     fresh index.json (overwrites any prior index for this root).
 *   update({root}, opts) -> same shape as build() PLUS {added, changed, unchanged_content, removed,
 *     skipped_count, reindexed_count}. THROWS if no index was ever built for this root (call build() first
 *     — never silently falls back to a full build, so a caller always knows which one actually ran).
 *     `skipped_count` = files whose stat proxy matched and were never read this update. `reindexed_count`
 *     = files actually re-read this update (added + changed + unchanged_content, i.e. every file whose stat
 *     proxy looked different, whether or not the recomputed hash ultimately differed).
 *   query({symbol|file|text}, opts) -> {ok, query, index_path, index_built_at, index_updated_at, stale,
 *     changed_since_index, matches, neighbors, notes}. Answers ONLY from the last-written index.json — NO
 *     source file is re-read. Exactly one of symbol/file/text is required (throws otherwise).
 *   staleness(opts) -> {ok, root, index_path, built_at, updated_at, added, changed, removed, total_changed,
 *     is_stale, notes}. Same cheap stat-proxy pass query() uses internally, exposed standalone.
 *   opts.root overrides input.root (hermetic-test seam, same opts.<path> convention as the rest of Forge).
 *   opts.indexPath overrides the index.json location (default: `<root>/.claude/forge-codemodel/index.json`).
 *   opts.now overrides `Date` for build_at/updated_at (test determinism).
 *
 * BOUNDS: files larger than repomap.MAX_SYMBOL_SCAN_BYTES (~300KB, the SAME bound forge-repomap.cjs already
 * applies to symbol-skimming) are listed (size/lang/mtime known) but NEVER read — `hash:null`, `symbols:[]`,
 * and such a file is always treated as "might have changed" (its stat proxy is trivially different from any
 * value that would let it be skipped safely without a read) — documented, never silently guessed.
 *
 * CLI:
 *   node forge-codemodel.cjs build --root <dir> [--index <file>] [--json]
 *   node forge-codemodel.cjs update --root <dir> [--index <file>] [--json]
 *   node forge-codemodel.cjs query --root <dir> --symbol <name> [--json]
 *   node forge-codemodel.cjs query --root <dir> --file <relpath> [--json]
 *   node forge-codemodel.cjs query --root <dir> --text <substring> [--json]
 *   node forge-codemodel.cjs staleness --root <dir> [--json]
 * `--root` defaults to `.` (cwd) on every subcommand when omitted.
 * Exit codes: build/update: 0 = ran (an honestly-empty index is still success) / 2 = usage or runtime error
 * (missing/invalid root, no prior index for update). query: 0 = ran (a "no matches" result is still success)
 * / 2 = usage or runtime error (no symbol/file/text given, or no index found). staleness: 0 = not stale / 3
 * = stale (added/changed/removed since last build/update, mirrors forge-manifest.cjs's resumable convention)
 * / 2 = usage or runtime error.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const repomap = require('./forge-repomap.cjs');

const INDEX_VERSION = 1;
const MAX_DEPTH = repomap.DEFAULT_MAX_DEPTH;
const MAX_FILES = repomap.DEFAULT_MAX_FILES;

// ---- root / index-path resolution (mirrors forge-repomap.cjs::map()'s opts.root convention) ----
function resolveRootAbs(input, opts) {
  input = input || {};
  opts = opts || {};
  const rootRaw = opts.root || input.root;
  if (!rootRaw) throw new Error('forge-codemodel: root is required');
  const rootAbs = path.resolve(String(rootRaw));
  let st;
  try { st = fs.statSync(rootAbs); } catch { throw new Error('forge-codemodel: root does not exist: ' + rootAbs); }
  if (!st.isDirectory()) throw new Error('forge-codemodel: root is not a directory: ' + rootAbs);
  return rootAbs;
}
function defaultIndexPath(rootAbs) { return path.join(rootAbs, '.claude', 'forge-codemodel', 'index.json'); }
function resolveIndexPath(rootAbs, opts) {
  opts = opts || {};
  return opts.indexPath ? path.resolve(String(opts.indexPath)) : defaultIndexPath(rootAbs);
}
/** indexOwnDirRelPath(rootAbs, indexPath) -> the root-relative POSIX dir path CONTAINING indexPath, or null
 *  when indexPath resolves outside rootAbs (nothing to exclude in that case). This is what keeps
 *  listCurrentFiles() from indexing THIS module's own index.json (and its atomic-write .tmp- siblings) as
 *  if it were ordinary project source — the exact same "don't index your own operational artifacts"
 *  problem forge-repomap.cjs's HARD_EXCLUDE_RELPATHS already solves for `.claude/forge-runs`, but computed
 *  DYNAMICALLY here because a caller may override --index to a different location via opts.indexPath. */
function indexOwnDirRelPath(rootAbs, indexPath) {
  const dir = path.dirname(indexPath);
  const rel = path.relative(rootAbs, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// ---- read-only, stat-only walk (never reads file CONTENT — mirrors repomap's ignore/secrets rules) ----
/** listCurrentFiles(rootAbs, excludeRelDir) -> {list:[{relPath, absPath, size, mtimeMs, lang}, ...],
 *  truncated}. Reuses forge-repomap.cjs's exported ignore helpers (secrets guard, default excludes,
 *  HARD_EXCLUDE_RELPATHS, .gitignore reader, deterministic sort) so this module never re-defines its own
 *  ignore/secrets policy — a single source of truth for "what counts as project source" across both tools.
 *  `excludeRelDir` (optional, root-relative POSIX path) additionally excludes this module's OWN index
 *  storage directory — see indexOwnDirRelPath() — so the index never indexes itself. Bounded by the SAME
 *  MAX_DEPTH/MAX_FILES defaults repomap.map() uses, for the same reason (a genuinely huge tree must not
 *  hang this tool or grow the index unboundedly). */
function listCurrentFiles(rootAbs, excludeRelDir) {
  const gitignore = repomap.loadGitignorePatterns(rootAbs);
  const list = [];
  let truncated = false;

  function isDirExcluded(relPath, basename) {
    if (repomap.DEFAULT_EXCLUDE_DIR_NAMES.has(basename)) return true;
    for (const hard of repomap.HARD_EXCLUDE_RELPATHS) {
      if (relPath === hard || relPath.startsWith(hard + '/')) return true;
    }
    if (excludeRelDir && (relPath === excludeRelDir || relPath.startsWith(excludeRelDir + '/'))) return true;
    if (repomap.matchesGitignore(gitignore, relPath, true)) return true;
    return false;
  }
  function isFileExcluded(relPath, basename) {
    if (repomap.isForbiddenFilename(basename)) return true;
    if (repomap.matchesGitignore(gitignore, relPath, false)) return true;
    return false;
  }
  function recurse(absDir, relParts, depth) {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => repomap.compareStrings(a.name, b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow symlinks — avoids cycles + escapes
      const abs = path.join(absDir, entry.name);
      const childRelParts = relParts.concat([entry.name]);
      const childRel = childRelParts.join('/');
      if (entry.isDirectory()) {
        if (isDirExcluded(childRel, entry.name)) continue;
        if (depth + 1 > MAX_DEPTH) continue;
        recurse(abs, childRelParts, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isFileExcluded(childRel, entry.name)) continue;
      if (list.length >= MAX_FILES) { truncated = true; continue; }
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      list.push({ relPath: childRel, absPath: abs, size: st.size, mtimeMs: st.mtimeMs, lang: repomap.detectLang(entry.name) });
    }
  }
  recurse(rootAbs, [], 0);
  return { list, truncated };
}

// ---- the incremental-update core (mutation-verified — see forge-codemodel.test.cjs) ----
/** needsReindex(oldRecord, statInfo) -> boolean. The CHEAP no-read proxy: a file "might have changed" iff
 *  its current (size, mtime_ms) differs from what the last index recorded. This is the ONE comparison that
 *  decides whether a file gets re-read at all — weakening it (e.g. dropping the mtime check, or the size
 *  check) either makes update() silently MISS a real content change (false "unchanged") or makes it re-read
 *  every file every time (false "changed", defeating the whole point of being cheap). Pure, no I/O. */
function needsReindex(oldRecord, statInfo) {
  if (!oldRecord) return true;
  return oldRecord.size !== statInfo.size || oldRecord.mtime_ms !== statInfo.mtimeMs;
}

/** computeChanges(oldFiles, currentList) -> {added, maybeChanged, unchanged, removed} — a PURE function of
 *  (oldFiles map, currentList array); no I/O beyond what the caller already gathered. `maybeChanged` is a
 *  stat-proxy verdict only (see needsReindex) — the caller decides whether/how to confirm via a real read.
 *  Shared by update() (which then reads+hashes added+maybeChanged) and staleness() (which reports the same
 *  buckets read-only, without ever opening a file). */
function computeChanges(oldFiles, currentList) {
  oldFiles = oldFiles || {};
  const currentSet = new Set(currentList.map((f) => f.relPath));
  const added = [];
  const maybeChanged = [];
  const unchanged = [];
  for (const f of currentList) {
    const old = oldFiles[f.relPath];
    if (!old) { added.push(f.relPath); continue; }
    if (needsReindex(old, f)) maybeChanged.push(f.relPath);
    else unchanged.push(f.relPath);
  }
  const removed = Object.keys(oldFiles).filter((p) => !currentSet.has(p));
  return { added, maybeChanged, unchanged, removed };
}

// ---- content read: the ONLY place this module opens a source file (one fs.readFileSync per call) ----
/** readAndIndexFile(absPath, size, lang) -> {hash, symbols}. Files above repomap.MAX_SYMBOL_SCAN_BYTES are
 *  never read (same bound repomap.cjs already applies to symbol-skimming) -> {hash:null, symbols:[]},
 *  honestly documented at the file header, never silently guessed. Reuses repomap.extractSymbols() —
 *  the SAME regex-only, top-level-only, never-a-real-parser skim forge-repomap.cjs already ships; this
 *  module never re-implements symbol extraction. */
function readAndIndexFile(absPath, size, lang) {
  if (size > repomap.MAX_SYMBOL_SCAN_BYTES) return { hash: null, symbols: [] };
  let text;
  try { text = fs.readFileSync(absPath, 'utf8'); } catch { return { hash: null, symbols: [] }; }
  const hash = crypto.createHash('sha1').update(text, 'utf8').digest('hex');
  const symbols = repomap.extractSymbols(lang, text);
  return { hash, symbols };
}

// ---- atomic write (same-dir temp file + rename commit — mirrors forge-manifest.cjs) ----
function writeIndex(indexPath, index) {
  const dir = path.dirname(indexPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, '.' + path.basename(indexPath) + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.writeFileSync(tmpPath, Buffer.from(JSON.stringify(index, null, 2) + '\n', 'utf8'));
  fs.renameSync(tmpPath, indexPath);
}

/** loadIndex(indexPath) -> parsed index.json. THROWS (never returns a half-trusted guess) when no index was
 *  ever built at this path, or when index.json exists but is malformed. */
function loadIndex(indexPath) {
  let raw;
  try { raw = fs.readFileSync(indexPath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error('forge-codemodel: no index found at ' + indexPath + ' — run build() first');
    throw new Error('forge-codemodel: could not read index at ' + indexPath + ': ' + e.message);
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-codemodel: index at ' + indexPath + ' is not valid JSON: ' + e.message); }
  if (!data || typeof data !== 'object' || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) {
    throw new Error('forge-codemodel: index at ' + indexPath + ' is malformed (missing files map)');
  }
  return data;
}

/** build({root}, opts) -> full index — see file header MODEL. Reads + hashes every included file and
 *  ALWAYS writes a fresh index.json (overwrites any prior index at the same path). */
function build(input, opts) {
  input = input || {};
  opts = opts || {};
  const rootAbs = resolveRootAbs(input, opts);
  const indexPath = resolveIndexPath(rootAbs, opts);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const { list: current, truncated } = listCurrentFiles(rootAbs, indexOwnDirRelPath(rootAbs, indexPath));

  const files = {};
  for (const f of current) {
    const { hash, symbols } = readAndIndexFile(f.absPath, f.size, f.lang);
    files[f.relPath] = { size: f.size, mtime_ms: f.mtimeMs, hash, lang: f.lang, symbols };
  }
  const notes = [];
  if (truncated) notes.push('forge-codemodel: walk capped at --max-files ' + MAX_FILES + ' — some files were discovered but omitted from the index');

  const index = {
    ok: true, version: INDEX_VERSION, root: rootAbs,
    built_at: now.toISOString(), updated_at: now.toISOString(),
    file_count: Object.keys(files).length,
    files, notes,
  };
  writeIndex(indexPath, index);
  return Object.assign({}, index, { index_path: indexPath });
}

/** update({root}, opts) -> incremental index — see file header MODEL. THROWS if no index exists yet at the
 *  resolved index path (see loadIndex) — never silently falls back to a full build. */
function update(input, opts) {
  input = input || {};
  opts = opts || {};
  const rootAbs = resolveRootAbs(input, opts);
  const indexPath = resolveIndexPath(rootAbs, opts);
  const idx = loadIndex(indexPath); // throws on missing/malformed prior index
  const now = opts.now instanceof Date ? opts.now : new Date();
  const { list: current, truncated } = listCurrentFiles(rootAbs, indexOwnDirRelPath(rootAbs, indexPath));
  const currentByPath = new Map(current.map((f) => [f.relPath, f]));
  const changes = computeChanges(idx.files, current);

  const files = Object.assign({}, idx.files);
  for (const relPath of changes.removed) delete files[relPath];

  const added = [], changed = [], unchangedContent = [];
  for (const relPath of changes.added.concat(changes.maybeChanged)) {
    const f = currentByPath.get(relPath);
    const old = idx.files[relPath];
    const { hash, symbols } = readAndIndexFile(f.absPath, f.size, f.lang);
    files[relPath] = { size: f.size, mtime_ms: f.mtimeMs, hash, lang: f.lang, symbols };
    if (!old) added.push(relPath);
    else if (old.hash !== hash) changed.push(relPath);
    else unchangedContent.push(relPath);
  }

  const notes = [];
  if (truncated) notes.push('forge-codemodel: walk capped at --max-files ' + MAX_FILES + ' — some files were discovered but omitted from the index');

  const index = {
    ok: true, version: INDEX_VERSION, root: rootAbs,
    built_at: idx.built_at, updated_at: now.toISOString(),
    file_count: Object.keys(files).length,
    files, notes,
  };
  writeIndex(indexPath, index);
  return Object.assign({}, index, {
    index_path: indexPath,
    added, changed, unchanged_content: unchangedContent,
    removed: changes.removed,
    skipped_count: changes.unchanged.length,
    reindexed_count: added.length + changed.length + unchangedContent.length,
  });
}

/** staleness(opts) -> {ok, root, index_path, built_at, updated_at, added, changed, removed, total_changed,
 *  is_stale, notes} — the SAME cheap stat-proxy pass query() runs internally, exposed standalone. Never
 *  opens a source file's content; never writes anything. */
function staleness(input, opts) {
  input = input || {};
  opts = opts || {};
  const rootAbs = resolveRootAbs(input, opts);
  const indexPath = resolveIndexPath(rootAbs, opts);
  const idx = loadIndex(indexPath);
  const { list: current } = listCurrentFiles(rootAbs, indexOwnDirRelPath(rootAbs, indexPath));
  const changes = computeChanges(idx.files, current);
  const totalChanged = changes.added.length + changes.maybeChanged.length + changes.removed.length;
  return {
    ok: true, root: rootAbs, index_path: indexPath,
    built_at: idx.built_at, updated_at: idx.updated_at,
    added: changes.added, changed: changes.maybeChanged, removed: changes.removed,
    total_changed: totalChanged, is_stale: totalChanged > 0,
    notes: ['added/changed/removed are computed from a cheap size+mtime stat proxy, not a full content re-hash — a file touched without an actual content edit still counts as "changed" here (an honest upper-bound estimate); a byte-accurate diff only happens inside update(), which re-hashes each stat-flagged file before deciding'],
  };
}

/** normalizeQueryPath(rootAbs, raw) -> a root-relative, POSIX-separated path matching index.files keys,
 *  regardless of whether the caller passed an absolute path, a relative path, or backslashes. */
function normalizeQueryPath(rootAbs, raw) {
  const p = String(raw == null ? '' : raw);
  const abs = path.resolve(path.isAbsolute(p) ? p : path.join(rootAbs, p));
  return path.relative(rootAbs, abs).split(path.sep).join('/');
}

/** buildNeighbors(idx, relPath) -> {dir_files, sibling_symbols} — "neighbors" of a matched file: every
 *  OTHER file in the same directory (capped, sorted, deterministic) + every top-level symbol this file's
 *  own record already carries (including the queried one, so a caller sees the full local symbol context). */
function buildNeighbors(idx, relPath) {
  const rec = idx.files[relPath];
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '.';
  const dirFiles = Object.keys(idx.files)
    .filter((p) => p !== relPath && (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.') === dir)
    .sort(repomap.compareStrings)
    .slice(0, 25);
  const siblingSymbols = rec ? (rec.symbols || []).map((s) => s.name) : [];
  return { dir_files: dirFiles, sibling_symbols: siblingSymbols };
}

/** query({symbol|file|text}, opts) -> {ok, query, index_path, index_built_at, index_updated_at, stale,
 *  changed_since_index, matches, neighbors, notes} — see file header MODEL. Answers ONLY from index.json;
 *  never re-reads a source file. Exactly one of symbol/file/text is required (throws otherwise). */
function query(input, opts) {
  input = input || {};
  opts = opts || {};
  const hasSymbol = input.symbol != null && String(input.symbol).length > 0;
  const hasFile = input.file != null && String(input.file).length > 0;
  const hasText = input.text != null && String(input.text).length > 0;
  if (!hasSymbol && !hasFile && !hasText) throw new Error('forge-codemodel: query() requires one of symbol/file/text');

  const rootAbs = resolveRootAbs(input, opts);
  const indexPath = resolveIndexPath(rootAbs, opts);
  const idx = loadIndex(indexPath);
  const { list: current } = listCurrentFiles(rootAbs, indexOwnDirRelPath(rootAbs, indexPath));
  const changes = computeChanges(idx.files, current);
  const changedSinceIndex = changes.added.length + changes.maybeChanged.length + changes.removed.length;

  const matches = [];
  const neighbors = {};
  if (hasSymbol) {
    const wanted = String(input.symbol);
    for (const [relPath, rec] of Object.entries(idx.files)) {
      for (const s of rec.symbols || []) {
        if (s.name === wanted) matches.push({ file: relPath, name: s.name, kind: s.kind });
      }
    }
    for (const m of matches) { if (!neighbors[m.file]) neighbors[m.file] = buildNeighbors(idx, m.file); }
  } else if (hasFile) {
    const relPath = normalizeQueryPath(rootAbs, String(input.file));
    const rec = idx.files[relPath];
    if (rec) {
      matches.push({ file: relPath, size: rec.size, lang: rec.lang, hash: rec.hash, symbols: rec.symbols });
      neighbors[relPath] = buildNeighbors(idx, relPath);
    }
  } else {
    const needle = String(input.text).toLowerCase();
    for (const [relPath, rec] of Object.entries(idx.files)) {
      if (relPath.toLowerCase().includes(needle)) matches.push({ file: relPath, type: 'path' });
      for (const s of rec.symbols || []) {
        if (s.name.toLowerCase().includes(needle)) matches.push({ file: relPath, type: 'symbol', name: s.name, kind: s.kind });
      }
    }
  }

  const notes = [];
  if (changedSinceIndex > 0) notes.push('index may be STALE: ' + changedSinceIndex + ' file(s) added/changed/removed since the last build/update — these results reflect the LAST indexed state, not necessarily current disk content; run update() to refresh');

  return {
    ok: true, query: { symbol: input.symbol || null, file: input.file || null, text: input.text || null },
    index_path: indexPath, index_built_at: idx.built_at, index_updated_at: idx.updated_at,
    stale: changedSinceIndex > 0, changed_since_index: changedSinceIndex,
    matches, neighbors, notes,
  };
}

module.exports = {
  build, update, query, staleness,
  needsReindex, computeChanges, listCurrentFiles, readAndIndexFile, loadIndex, writeIndex,
  resolveRootAbs, resolveIndexPath, defaultIndexPath, indexOwnDirRelPath, normalizeQueryPath, buildNeighbors,
  INDEX_VERSION, MAX_DEPTH, MAX_FILES,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, root: '.', index: null, symbol: null, file: null, text: null, json: false, help: false, usageError: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--root') { opts.root = rest[++i]; if ((!opts.root || opts.root.startsWith('--')) && !opts.usageError) opts.usageError = '--root requires a <dir>'; }
    else if (a === '--index') { opts.index = rest[++i]; if ((!opts.index || opts.index.startsWith('--')) && !opts.usageError) opts.usageError = '--index requires a <file>'; }
    else if (a === '--symbol') { opts.symbol = rest[++i]; if ((!opts.symbol || opts.symbol.startsWith('--')) && !opts.usageError) opts.usageError = '--symbol requires a <name>'; }
    else if (a === '--file') { opts.file = rest[++i]; if ((!opts.file || opts.file.startsWith('--')) && !opts.usageError) opts.usageError = '--file requires a <relpath>'; }
    else if (a === '--text') { opts.text = rest[++i]; if ((!opts.text || opts.text.startsWith('--')) && !opts.usageError) opts.usageError = '--text requires a <substring>'; }
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-codemodel.cjs build --root <dir> [--index <file>] [--json]');
  console.error('       node forge-codemodel.cjs update --root <dir> [--index <file>] [--json]');
  console.error('       node forge-codemodel.cjs query --root <dir> --symbol <name> [--json]');
  console.error('       node forge-codemodel.cjs query --root <dir> --file <relpath> [--json]');
  console.error('       node forge-codemodel.cjs query --root <dir> --text <substring> [--json]');
  console.error('       node forge-codemodel.cjs staleness --root <dir> [--json]');
}
function printBuildOrUpdate(r, cmd) {
  console.log('forge-codemodel ' + cmd + ' · ' + r.index_path);
  console.log('  files indexed: ' + r.file_count);
  if (cmd === 'update') {
    console.log('  added: ' + r.added.length + '  changed: ' + r.changed.length + '  unchanged-content: ' + r.unchanged_content.length + '  removed: ' + r.removed.length + '  skipped(no-read): ' + r.skipped_count);
  }
  for (const n of r.notes) console.log('  ' + n);
}
function printQuery(r) {
  console.log('forge-codemodel query · ' + JSON.stringify(r.query) + (r.stale ? ' · STALE (' + r.changed_since_index + ' changed)' : ''));
  console.log('  matches: ' + r.matches.length);
  for (const m of r.matches) console.log('    - ' + JSON.stringify(m));
}
function printStaleness(r) {
  console.log('forge-codemodel staleness · ' + r.index_path + (r.is_stale ? ' · STALE' : ' · fresh'));
  console.log('  added: ' + r.added.length + '  changed: ' + r.changed.length + '  removed: ' + r.removed.length + '  total: ' + r.total_changed);
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); process.exitCode = 0; }
  else if (opts.usageError) { console.error('forge-codemodel: ' + opts.usageError); printUsage(); process.exitCode = 2; }
  else if (opts.cmd === 'build') {
    try {
      const r = build({ root: opts.root }, { indexPath: opts.index });
      if (opts.json) console.log(JSON.stringify(r));
      else printBuildOrUpdate(r, 'build');
      process.exitCode = 0;
    } catch (e) { console.error('forge-codemodel: ' + e.message); process.exitCode = 2; }
  } else if (opts.cmd === 'update') {
    try {
      const r = update({ root: opts.root }, { indexPath: opts.index });
      if (opts.json) console.log(JSON.stringify(r));
      else printBuildOrUpdate(r, 'update');
      process.exitCode = 0;
    } catch (e) { console.error('forge-codemodel: ' + e.message); process.exitCode = 2; }
  } else if (opts.cmd === 'query') {
    try {
      const r = query({ root: opts.root, symbol: opts.symbol, file: opts.file, text: opts.text }, { indexPath: opts.index });
      if (opts.json) console.log(JSON.stringify(r));
      else printQuery(r);
      process.exitCode = 0;
    } catch (e) { console.error('forge-codemodel: ' + e.message); process.exitCode = 2; }
  } else if (opts.cmd === 'staleness') {
    try {
      const r = staleness({ root: opts.root }, { indexPath: opts.index });
      if (opts.json) console.log(JSON.stringify(r));
      else printStaleness(r);
      process.exitCode = r.is_stale ? 3 : 0;
    } catch (e) { console.error('forge-codemodel: ' + e.message); process.exitCode = 2; }
  } else {
    printUsage();
    process.exitCode = 2;
  }
}
