#!/usr/bin/env node
'use strict';
/**
 * forge-repomap.cjs — cheap, token-light repository context map (2026-07-19, piece H2). PURPOSE: let a
 * Boss orient in an unfamiliar/large repo WITHOUT a whole-repo read. `map()` walks a directory tree
 * (bounded depth, sensible ignores — the literal spec list node_modules/.git/dist/build/backups, plus a
 * project-specific relative-path exclude for THIS project's own `.claude/forge-runs` artifact subtree —
 * see IGNORES below for exactly why that one is path-scoped rather than a generic basename), lists
 * every remaining file with its size + a cheap language guess, and for recognized code languages runs a
 * REGEX-ONLY top-level "symbol skim" (function/class/struct/enum/interface names) — never a real parser,
 * never an AST, never an LLM call. Output is a compact JSON structure (or a rendered markdown tree) plus a
 * cheap `token_estimate` (chars/4 heuristic — NOT a real tokenizer; documented, never claimed exact).
 *
 * Zero-dependency (fs/path only). Pure-ish: the only I/O is fs.readdirSync/fs.statSync/fs.readFileSync
 * under the resolved root — this module NEVER writes anything.
 *
 * SAFETY (secrets, guardrail-style, mirrors forge-harvest.cjs's isForbiddenFilename):
 *   isForbiddenFilename() refuses to even LIST (let alone open) any file named .env / .env.* / *.key /
 *   *.pem / *secret* / *credential* / id_rsa* — checked before the file is added to the output at all, and
 *   BEFORE any fs.readFileSync call for symbol-skimming. A seeded `.env` in a fixture repo never appears
 *   anywhere in a map() result.
 *
 * IGNORES (directories, never entered/recursed):
 *   DEFAULT_EXCLUDE_DIR_NAMES (basename match, any depth) — the literal spec list (node_modules, .git,
 *   dist, build, backups) plus a few equally "sensible" cache/venv basenames (.next, coverage, .cache,
 *   __pycache__, .venv, .turbo, .vercel) that are equally build/cache noise in most repos, never source.
 *   NOTE (deliberately NOT in this generic basename set): `forge-runs` is NOT excluded as a bare basename
 *   anywhere in the tree — an arbitrary target repo could legitimately have its own unrelated `forge-runs`
 *   directory, and a general-purpose repomap tool must not silently swallow it. Instead, THIS project's own
 *   operational artifact subtree is excluded precisely by RELATIVE PATH via HARD_EXCLUDE_RELPATHS
 *   (`.claude/forge-runs` only — `.claude/skills`, `.claude/agents`, `.claude/forge-bin` etc. stay
 *   walkable; only the generated-run-log subtree is excluded).
 *   Plus a lightweight, DOCUMENTED-AS-PARTIAL ".gitignore-ish" reader: if `<root>/.gitignore` exists, each
 *   non-comment, non-blank, non-negated (`!...`) line is treated as a simple exact/prefix/basename match
 *   (or a minimal `*`-wildcard-to-regex conversion) — this is NOT full gitignore glob semantics, just a
 *   cheap best-effort extra filter layered on top of the hard defaults above.
 *
 * SYMBOL SKIM (per language, regex on raw source, capped at MAX_SYMBOLS_PER_FILE, only for files
 * <= MAX_SYMBOL_SCAN_BYTES to keep this genuinely cheap):
 *   javascript/typescript: top-level `function`/`class` declarations, `export const|let|var`,
 *     `exports.NAME =` / `module.exports.NAME =`.
 *   python: top-level (column-0) `def`/`class`.
 *   go: `func` (incl. receiver methods) / `type NAME struct`.
 *   rust: `fn` / `struct` / `enum` (pub or private).
 *   java: `class` / `interface`.
 *   Any other language: symbols stays `[]` — never guessed, never fabricated.
 *
 * MODEL:
 *   map(input, opts) -> {
 *     ok, root, generated_at, max_depth, max_files,
 *     dirs: [{path, depth, file_count}, ...],           // path is root-relative, POSIX-separated, '.' = root
 *     files: [{path, size, lang, symbols:[{name, kind}]}, ...],
 *     dir_count, file_count, truncated, token_estimate, notes: [...]
 *   }
 *   input.root (string, REQUIRED unless opts.root given) — the directory to map.
 *   input.maxDepth (number, default 6) — directory depth bound (root itself is depth 0).
 *   input.maxFiles (number, default 1500) — output size bound; once hit, remaining files are dropped and
 *     `truncated:true` + an honest note is added (dirs already discovered still get an accurate file_count
 *     which MAY exceed what's actually present in `files` — the note says so explicitly).
 *   input.include (string[] of regex source, optional) — when given, a file is kept only if its
 *     root-relative POSIX path matches at least one of these.
 *   input.exclude (string[] of regex source, optional) — extra exclusions layered on top of the defaults;
 *     tested against the root-relative POSIX path for both directories and files.
 *   opts.root — overrides input.root (hermetic-test seam, same `opts.<path>` convention as the rest of Forge).
 *   opts.now — Date override for `generated_at` (test determinism).
 * toMarkdown(result) -> a compact markdown rendering of the same result (tree + per-file symbol summary).
 *
 * CLI:
 *   node forge-repomap.cjs --root <dir> [--json] [--max-depth N] [--max-files N]
 *     [--include <regex,regex,...>] [--exclude <regex,regex,...>]
 * Exit codes: 0 = ran (including an honestly-empty map of an empty dir) · 2 = usage/config error
 * (missing --root, root does not exist / is not a directory, or an invalid --include/--exclude regex).
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_FILES = 1500;
const MAX_SYMBOLS_PER_FILE = 40;
const MAX_SYMBOL_SCAN_BYTES = 300000; // ~300KB — skip symbol-skimming (not listing) of unusually large files

// literal spec ignores (node_modules/.git/dist/build/backups) + a few equally "sensible" generic
// cache/venv basenames — see file header for why `forge-runs` is intentionally NOT in this generic set.
const DEFAULT_EXCLUDE_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', 'backups',
  '.next', 'coverage', '.cache', '__pycache__', '.venv', '.turbo', '.vercel',
]);
// project-specific hard exclude, by RELATIVE PATH (not basename): THIS project's generated run-log
// subtree only (not all of .claude/, and not any unrelated repo's own "forge-runs" directory elsewhere).
const HARD_EXCLUDE_RELPATHS = ['.claude/forge-runs'];

// ---- secrets: never list, never open (mirrors forge-harvest.cjs::isForbiddenFilename) ----
function isForbiddenFilename(name) {
  const base = String(name || '');
  if (/^\.env(\.|$)/i.test(base)) return true;
  if (/\.key$/i.test(base)) return true;
  if (/\.pem$/i.test(base)) return true;
  if (/secret/i.test(base)) return true;
  if (/credential/i.test(base)) return true;
  if (/^id_rsa/i.test(base)) return true;
  return false;
}

// ---- language detection (cheap extension map) ----
const LANG_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.cjs': 'javascript', '.mjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.php': 'php', '.rb': 'ruby', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.md': 'markdown', '.json': 'json', '.css': 'css', '.scss': 'css', '.html': 'html',
  '.sh': 'shell', '.ps1': 'powershell', '.cmd': 'batch', '.yml': 'yaml', '.yaml': 'yaml',
};
function detectLang(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return LANG_BY_EXT[ext] || (ext ? ext.replace(/^\./, '') : 'unknown');
}

// ---- symbol skim: regex-only, per language, top-level only, never a real parser ----
function collectMatches(text, re, kind, nameGroup) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[nameGroup == null ? 1 : nameGroup];
    if (name) out.push({ name, kind });
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width-match infinite loops
  }
  return out;
}
const SYMBOL_EXTRACTORS = {
  javascript(text) {
    return []
      .concat(collectMatches(text, /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/gm, 'function'))
      .concat(collectMatches(text, /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/gm, 'class'))
      .concat(collectMatches(text, /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, 'export'))
      .concat(collectMatches(text, /(?:^|\s)(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm, 'export'));
  },
  python(text) {
    return []
      .concat(collectMatches(text, /^def\s+([A-Za-z_]\w*)\s*\(/gm, 'function'))
      .concat(collectMatches(text, /^class\s+([A-Za-z_]\w*)/gm, 'class'));
  },
  go(text) {
    return []
      .concat(collectMatches(text, /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, 'function'))
      .concat(collectMatches(text, /^type\s+([A-Za-z_]\w*)\s+struct/gm, 'struct'));
  },
  rust(text) {
    return []
      .concat(collectMatches(text, /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/gm, 'function'))
      .concat(collectMatches(text, /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/gm, 'struct'))
      .concat(collectMatches(text, /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/gm, 'enum'));
  },
  java(text) {
    return []
      .concat(collectMatches(text, /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/gm, 'class'))
      .concat(collectMatches(text, /^\s*(?:public\s+)?interface\s+([A-Za-z_]\w*)/gm, 'interface'));
  },
};
SYMBOL_EXTRACTORS.typescript = SYMBOL_EXTRACTORS.javascript;

/** extractSymbols(lang, text) -> [{name, kind}, ...] deduped, capped at MAX_SYMBOLS_PER_FILE. Unknown
 *  languages (no extractor registered) always return [] — never guessed. */
function extractSymbols(lang, text) {
  const extractor = SYMBOL_EXTRACTORS[lang];
  if (!extractor || !text) return [];
  const raw = extractor(text);
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    const key = s.kind + ':' + s.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out;
}

// ---- lightweight, documented-as-partial .gitignore reader ----
/** loadGitignorePatterns(root) -> [{re, isDirOnly}, ...]. Only `<root>/.gitignore` (no nested .gitignore
 *  files, no negation support) — a cheap best-effort layer on top of DEFAULT_EXCLUDE_DIR_NAMES, never
 *  claimed to be full gitignore semantics. Missing/unreadable file -> []. */
function loadGitignorePatterns(root) {
  let raw;
  try { raw = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line0 of raw.split(/\r?\n/)) {
    let line = line0.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const isDirOnly = line.endsWith('/');
    if (isDirOnly) line = line.slice(0, -1);
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    const escaped = line.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    let re;
    try { re = new RegExp('(^|/)' + escaped + '($|/)'); } catch { continue; }
    out.push({ re, isDirOnly });
  }
  return out;
}
function matchesGitignore(patterns, relPath, isDir) {
  for (const p of patterns) {
    if (p.isDirOnly && !isDir) continue;
    if (p.re.test(relPath)) return true;
  }
  return false;
}

function compileRegexes(list, label) {
  if (!Array.isArray(list) || list.length === 0) return [];
  return list.map((src) => {
    try { return new RegExp(src); }
    catch (e) { throw new Error('forge-repomap: invalid ' + label + ' regex "' + src + '": ' + e.message); }
  });
}

/** compareStrings(a, b) -> -1/0/1 plain lexicographic comparator, shared by every sort in this module
 *  (directory-entry read order, dirs[]/files[] rendering order in toMarkdown) so ordering is deterministic
 *  across platforms/filesystems regardless of native readdir order, and is unit-testable on its own
 *  (a filesystem's native readdir order can already happen to be sorted on some platforms, which would
 *  otherwise mask a broken comparator in an end-to-end test). */
function compareStrings(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** walkRepo(rootAbs, cfg) -> {dirs, files, truncated} — the core bounded, ignore-aware filesystem walk.
 *  Pure w.r.t. its inputs beyond real fs reads; never writes anything. Directories are read in sorted
 *  order for deterministic output across runs/platforms. */
function walkRepo(rootAbs, cfg) {
  const gitignore = loadGitignorePatterns(rootAbs);
  const dirFileCounts = new Map(); // relDirPath ('.' for root) -> file count actually included
  const dirs = [];
  const files = [];
  let truncated = false;

  function relPosix(relParts) { return relParts.join('/'); }

  function isDirExcluded(relPath, basename) {
    if (DEFAULT_EXCLUDE_DIR_NAMES.has(basename)) return true;
    for (const hard of HARD_EXCLUDE_RELPATHS) {
      if (relPath === hard || relPath.startsWith(hard + '/')) return true;
    }
    if (matchesGitignore(gitignore, relPath, true)) return true;
    if (cfg.excludeRes.some((re) => re.test(relPath))) return true;
    return false;
  }
  function isFileExcluded(relPath, basename) {
    if (isForbiddenFilename(basename)) return true;
    if (matchesGitignore(gitignore, relPath, false)) return true;
    if (cfg.excludeRes.some((re) => re.test(relPath))) return true;
    if (cfg.includeRes.length && !cfg.includeRes.some((re) => re.test(relPath))) return true;
    return false;
  }

  function recurse(absDir, relParts, depth) {
    const relPath = relParts.length ? relPosix(relParts) : '.';
    dirs.push({ path: relPath, depth, file_count: 0 }); // file_count filled in after the full walk
    dirFileCounts.set(relPath, 0);

    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => compareStrings(a.name, b.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow symlinks — avoids cycles + escapes
      const abs = path.join(absDir, entry.name);
      const childRelParts = relParts.concat([entry.name]);
      const childRel = relPosix(childRelParts);

      if (entry.isDirectory()) {
        if (isDirExcluded(childRel, entry.name)) continue;
        if (depth + 1 > cfg.maxDepth) continue; // depth cap: do not descend, and this dir is never listed
        recurse(abs, childRelParts, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue; // skip devices/fifos/etc — real files only
      if (isFileExcluded(childRel, entry.name)) continue;
      if (files.length >= cfg.maxFiles) { truncated = true; continue; }

      let size = 0;
      try { size = fs.statSync(abs).size; } catch { size = 0; }
      const lang = detectLang(entry.name);
      let symbols = [];
      if (SYMBOL_EXTRACTORS[lang] && size <= MAX_SYMBOL_SCAN_BYTES) {
        let text = '';
        try { text = fs.readFileSync(abs, 'utf8'); } catch { text = ''; }
        symbols = extractSymbols(lang, text);
      }
      files.push({ path: childRel, size, lang, symbols });
      dirFileCounts.set(relPath, (dirFileCounts.get(relPath) || 0) + 1);
    }
  }

  recurse(rootAbs, [], 0);
  for (const d of dirs) d.file_count = dirFileCounts.get(d.path) || 0;
  return { dirs, files, truncated };
}

/** estimateTokens(result) -> a cheap chars/4 heuristic over the dirs+files payload. NOT a real tokenizer —
 *  documented as an estimate everywhere it is surfaced (module + CLI + markdown). */
function estimateTokens(dirs, files) {
  const approxChars = JSON.stringify({ dirs, files }).length;
  return Math.ceil(approxChars / 4);
}

/** map(input, opts) -> repomap result — see file header MODEL. Throws only on a missing/invalid root or
 *  an invalid --include/--exclude regex (usage errors, never a silent guess). */
function map(input, opts) {
  input = input || {};
  opts = opts || {};
  const rootRaw = opts.root || input.root;
  if (!rootRaw) throw new Error('forge-repomap: map() requires a root directory');
  const rootAbs = path.resolve(String(rootRaw));
  let st;
  try { st = fs.statSync(rootAbs); } catch { throw new Error('forge-repomap: root does not exist: ' + rootAbs); }
  if (!st.isDirectory()) throw new Error('forge-repomap: root is not a directory: ' + rootAbs);

  const maxDepth = Number.isFinite(input.maxDepth) && input.maxDepth >= 0 ? Math.floor(input.maxDepth) : DEFAULT_MAX_DEPTH;
  const maxFiles = Number.isFinite(input.maxFiles) && input.maxFiles > 0 ? Math.floor(input.maxFiles) : DEFAULT_MAX_FILES;
  const excludeRes = compileRegexes(input.exclude, '--exclude');
  const includeRes = compileRegexes(input.include, '--include');

  const { dirs, files, truncated } = walkRepo(rootAbs, { maxDepth, maxFiles, excludeRes, includeRes });
  const tokenEstimate = estimateTokens(dirs, files);

  const notes = [];
  if (truncated) notes.push('forge-repomap: output capped at --max-files ' + maxFiles + ' — some files under the walked tree were discovered but omitted from files[] (dirs[].file_count still reflects the true count, which may exceed files.length)');

  const now = opts.now instanceof Date ? opts.now : new Date();
  return {
    ok: true,
    root: rootAbs,
    generated_at: now.toISOString(),
    max_depth: maxDepth,
    max_files: maxFiles,
    dirs,
    files,
    dir_count: dirs.length,
    file_count: files.length,
    truncated,
    token_estimate: tokenEstimate,
    notes,
  };
}

/** toMarkdown(result) -> a compact markdown rendering: a per-directory tree with files (size + top symbol
 *  names) nested underneath. Sorted by path so output is deterministic. */
function toMarkdown(result) {
  const lines = [];
  lines.push('# Repo Map — ' + result.root);
  lines.push('_generated ' + result.generated_at + ' · ' + result.dir_count + ' dir(s) · ' + result.file_count +
    ' file(s) · ~' + result.token_estimate + ' tokens (chars/4 estimate)' + (result.truncated ? ' · TRUNCATED' : '') + '_');
  lines.push('');

  const filesByDir = new Map();
  for (const f of result.files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
    if (!filesByDir.has(dir)) filesByDir.set(dir, []);
    filesByDir.get(dir).push(f);
  }

  const sortedDirs = result.dirs.slice().sort((a, b) => compareStrings(a.path, b.path));
  for (const d of sortedDirs) {
    const indent = '  '.repeat(d.depth);
    lines.push(indent + '- **' + d.path + '/** (' + d.file_count + ' file(s))');
    const dirFiles = (filesByDir.get(d.path) || []).slice().sort((a, b) => compareStrings(a.path, b.path));
    for (const f of dirFiles) {
      const base = f.path.includes('/') ? f.path.slice(f.path.lastIndexOf('/') + 1) : f.path;
      const symText = f.symbols.length ? ' — ' + f.symbols.slice(0, 8).map((s) => s.kind + ' ' + s.name).join(', ') : '';
      lines.push(indent + '  - ' + base + ' (' + f.size + 'B, ' + f.lang + ')' + symText);
    }
  }
  for (const n of result.notes) lines.push('\n> ' + n);
  return lines.join('\n');
}

module.exports = {
  map, toMarkdown,
  isForbiddenFilename, detectLang, extractSymbols, collectMatches,
  loadGitignorePatterns, matchesGitignore, estimateTokens, walkRepo, compareStrings,
  DEFAULT_MAX_DEPTH, DEFAULT_MAX_FILES, DEFAULT_EXCLUDE_DIR_NAMES, HARD_EXCLUDE_RELPATHS,
  MAX_SYMBOLS_PER_FILE, MAX_SYMBOL_SCAN_BYTES, LANG_BY_EXT, SYMBOL_EXTRACTORS,
};

// ---- CLI ----
function parseArgs(argv) {
  const opts = {
    root: null, json: false, maxDepth: null, maxFiles: null,
    include: null, exclude: null, help: false, usageError: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') { opts.root = argv[++i]; if ((!opts.root || opts.root.startsWith('--')) && !opts.usageError) opts.usageError = '--root requires a <dir>'; }
    else if (a === '--json') opts.json = true;
    else if (a === '--max-depth') { const v = Number(argv[++i]); if (!Number.isFinite(v) && !opts.usageError) opts.usageError = '--max-depth requires a number'; else opts.maxDepth = v; }
    else if (a === '--max-files') { const v = Number(argv[++i]); if (!Number.isFinite(v) && !opts.usageError) opts.usageError = '--max-files requires a number'; else opts.maxFiles = v; }
    else if (a === '--include') { const raw = argv[++i]; if (!raw || raw.startsWith('--')) { if (!opts.usageError) opts.usageError = '--include requires a comma-separated list'; } else opts.include = raw.split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--exclude') { const raw = argv[++i]; if (!raw || raw.startsWith('--')) { if (!opts.usageError) opts.usageError = '--exclude requires a comma-separated list'; } else opts.exclude = raw.split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-repomap.cjs --root <dir> [--json] [--max-depth N] [--max-files N] [--include <regex,...>] [--exclude <regex,...>]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); process.exitCode = 0; }
  else if (opts.usageError) { console.error('forge-repomap: ' + opts.usageError); printUsage(); process.exitCode = 2; }
  else if (!opts.root) { console.error('forge-repomap: --root is required'); printUsage(); process.exitCode = 2; }
  else {
    try {
      const result = map({ root: opts.root, maxDepth: opts.maxDepth == null ? undefined : opts.maxDepth, maxFiles: opts.maxFiles == null ? undefined : opts.maxFiles, include: opts.include, exclude: opts.exclude }, {});
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(toMarkdown(result));
      process.exitCode = 0;
    } catch (e) {
      console.error('forge-repomap: ' + e.message);
      process.exitCode = 2;
    }
  }
}
