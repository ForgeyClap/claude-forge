#!/usr/bin/env node
'use strict';
/**
 * forge-deeplearn.cjs — "Deep Learn Mode" for Forge Mission Control Phase 2 (WP2).
 *
 * An on-demand, READ-ONLY full-codebase priming scanner. It walks a project (bounded depth),
 * detects stack + entry points + test coverage, finds the largest code files, and produces an
 * HONEST risk-list (missing tests, oversized files, missing README, TODO/FIXME density,
 * secret-looking strings, an unignored .env). This is a SCANNER — it never writes into the
 * scanned tree, and it NEVER prints or stores a raw secret (only {file, pattern_name} refs).
 *
 * Zero-dependency, Windows-safe (node "C:/Program Files/nodejs/node.exe" or any Node on PATH).
 *
 * CLI:
 *   node forge-deeplearn.cjs [--path <dir>] [--run <run_id>] [--store]
 *     --path <dir>   directory to scan (default: process.cwd())
 *     --run <run_id> log deep_learn_started/deep_learn_completed to that run's dashboard events
 *                    (shells out to ../forge-dashboard/log-event.cjs — event types are already
 *                    registered in KNOWN_EVENT_TYPES, nothing to re-register here). Omit to run
 *                    fully standalone (used by the test suite).
 *     --store        persist the full result via ../forge-bin/forge-store.cjs
 *                    (putEntity('artifacts', 'deeplearn-<epoch>', result)) — a second redaction
 *                    safety net on top of this file's own never-print-a-secret rule.
 *   Exit code: 0 on a successful scan (risks found is still a SUCCESSFUL scan — risks do not
 *   fail the process); non-zero only on a real error (bad --path, scan exception, store failure).
 *
 * Module API: require('./forge-deeplearn.cjs') -> { scanProject, SECRET_PATTERNS, categoryOf }
 *
 * SECRET PATTERNS: re-declared here to mirror forge-bin/forge-store.cjs's SECRET_PATTERNS exactly
 * (forge-store only exports a redactValue() helper, not the raw pattern list, so this is a
 * deliberate re-declaration per the WP2 spec — keep the two lists in sync if either changes).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- secret patterns (same 7 regexes as forge-bin/forge-store.cjs SECRET_PATTERNS) ----
// Each entry carries a stable `name` used ONLY in risk evidence — never the matched text itself.
const SECRET_PATTERNS = [
  { name: 'nvidia-nvapi-key', re: /nvapi-[A-Za-z0-9_-]+/g },
  { name: 'openai-style-key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'github-pat', re: /ghp_[A-Za-z0-9]{20,}/g },
  { name: 'slack-bot-token', re: /xoxb-[A-Za-z0-9-]+/g },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
];

// ---- excluded directories (mirrors forge-bin/forge-sync.cjs SKIP_DIRS + Forge's own store dirs +
// common heavy/vendor/venv dirs that add nothing to a codebase-priming scan) ----
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'graphify-out', // forge-sync.cjs SKIP_DIRS
  'out', 'coverage', 'forge-runs', 'forge-artifacts', 'forge-tickets', 'forge-prd', 'forge-mindmaps',
  '.cache', 'vendor', '__pycache__', '.venv', 'venv',
]);
function isSkippedDir(name) { return name.startsWith('.') || EXCLUDE_DIRS.has(name); }

// ---- category extension tables ----
const CODE_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.kts',
  '.rb', '.php', '.cs', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hxx', '.swift', '.dart',
  '.vue', '.svelte', '.scala', '.m', '.mm', '.sh', '.ps1', '.sql', '.graphql', '.gql',
]);
const DOCS_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc']);
const CONFIG_EXT = new Set(['.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.xml']);

const ENTRY_NAME_RE = /^(index|main|server|app)\.[A-Za-z0-9]+$/i;
const FRAMEWORK_HINTS = ['react', 'vue', 'next', 'express', 'svelte', 'angular', 'nuxt', 'fastify', 'koa', 'nestjs', 'gatsby', 'remix'];

function hasFrameworkDep(deps, hint) {
  return Object.keys(deps).some((d) => {
    const name = d.toLowerCase();
    return name === hint || name.startsWith(hint + '-') || name.startsWith('@' + hint + '/') || name === hint + '.js';
  });
}

function isTestPath(relPath) {
  const parts = String(relPath).split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === 'test' || p === 'tests' || p === '__tests__')) return true;
  const base = parts[parts.length - 1] || '';
  return /\.(test|spec)\.[^./\\]+$/i.test(base);
}

function categoryOf(relPath) {
  const parts = String(relPath).split(/[\\/]+/).filter(Boolean);
  const base = parts[parts.length - 1] || '';
  if (isTestPath(relPath)) return 'test';
  if (base === '.env' || base === '.env.example' || base === '.gitignore') return 'config';
  const ext = path.extname(base).toLowerCase();
  if (CODE_EXT.has(ext)) return 'code';
  if (DOCS_EXT.has(ext)) return 'docs';
  if (CONFIG_EXT.has(ext)) return 'config';
  return 'other';
}

// Line count that treats a single trailing newline as end-of-file, not an extra blank line —
// matches the intuitive "N-line file" meaning (same behavior as `wc -l` on a newline-terminated file).
function countLines(text) {
  if (text.length === 0) return 0;
  const parts = text.split(/\r\n|\r|\n/);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function isLikelyBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) { if (buf[i] === 0) return true; }
  return false;
}

function readTextGuarded(absPath, maxBytes) {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > maxBytes) return null;
    return fs.readFileSync(absPath, 'utf8');
  } catch { return null; }
}

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}

const LEVEL_RANK = { high: 0, med: 1, low: 2 };

/**
 * scanProject(root, opts) — pure, read-only, bounded-depth codebase scan.
 * opts.maxDepth — directory levels below root to recurse into (default 6).
 */
function scanProject(root, opts) {
  opts = opts || {};
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 6;
  root = path.resolve(root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('not a directory: ' + root);
  }

  const stackSet = new Set();
  const counts = { code: 0, docs: 0, config: 0, test: 0, other: 0, totalFiles: 0, totalBytes: 0 };
  const entryPoints = [];
  const testDirsSet = new Set();
  let testFileCount = 0;
  const codeFiles = []; // { path, lines }
  const risks = [];
  let todoCount = 0;
  let hasReadme = false;
  let envFile = null; // relative (posix) path of a real .env, if found (never .env.example)
  let gitignoreContent = null;
  let sawIndexHtml = false;

  function processFile(abs, rel) {
    const relPosix = rel.split(path.sep).join('/');
    const base = path.basename(rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { return; }
    const size = stat.size;
    counts.totalFiles += 1;
    counts.totalBytes += size;

    const cat = categoryOf(rel);
    counts[cat] += 1;

    if (cat === 'test') {
      testFileCount += 1;
      const parts = rel.split(path.sep);
      const idx = parts.findIndex((p) => p === 'test' || p === 'tests' || p === '__tests__');
      if (idx >= 0) testDirsSet.add(parts.slice(0, idx + 1).join('/'));
    }

    // ---- stack markers (checked regardless of category) ----
    if (base === 'package.json') {
      stackSet.add('node');
      try {
        const pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
        const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
        for (const hint of FRAMEWORK_HINTS) { if (hasFrameworkDep(deps, hint)) stackSet.add(hint); }
        const pkgDir = path.dirname(rel);
        const addEntry = (p) => { if (typeof p === 'string' && p) entryPoints.push(path.normalize(path.join(pkgDir, p)).split(path.sep).join('/')); };
        if (typeof pkg.main === 'string') addEntry(pkg.main);
        if (typeof pkg.bin === 'string') addEntry(pkg.bin);
        else if (pkg.bin && typeof pkg.bin === 'object') for (const k of Object.keys(pkg.bin)) addEntry(pkg.bin[k]);
      } catch { /* guarded — a malformed package.json must not fail the whole scan */ }
    }
    if (base === 'requirements.txt' || base === 'pyproject.toml') stackSet.add('python');
    if (base === 'go.mod') stackSet.add('go');
    if (base === 'Cargo.toml') stackSet.add('rust');
    if (base.endsWith('.csproj')) stackSet.add('dotnet');
    if (base === 'composer.json') stackSet.add('php');
    if (base.toLowerCase() === 'index.html') sawIndexHtml = true;

    if (/^readme(\.md)?$/i.test(base) && path.dirname(rel) === '.') hasReadme = true;
    if (base === '.env') envFile = relPosix;
    if (base === '.gitignore' && path.dirname(rel) === '.') gitignoreContent = readTextGuarded(abs, 256 * 1024) || '';

    // ---- entry points by filename ----
    if (ENTRY_NAME_RE.test(base)) entryPoints.push(relPosix);

    // ---- code-file line count + oversize risk + TODO/FIXME scan ----
    if (cat === 'code') {
      const text = readTextGuarded(abs, 2 * 1024 * 1024);
      if (text != null) {
        const lines = countLines(text);
        codeFiles.push({ path: relPosix, lines });
        if (lines > 800) {
          risks.push({ level: 'med', kind: 'oversized-file', detail: 'oversized file (maintainability)', evidence: { file: relPosix, lines } });
        }
        const todoMatches = text.match(/\b(TODO|FIXME)\b/g);
        if (todoMatches) todoCount += todoMatches.length;
      }
    }

    // ---- secret scan (skip .env.example — placeholders expected; skip >512KB; skip binary-ish) ----
    if (base !== '.env.example' && size <= 512 * 1024) {
      let buf = null;
      try { buf = fs.readFileSync(abs); } catch { buf = null; }
      if (buf && !isLikelyBinary(buf)) {
        const text = buf.toString('utf8');
        for (const pat of SECRET_PATTERNS) {
          pat.re.lastIndex = 0;
          if (pat.re.test(text)) {
            risks.push({ level: 'high', kind: 'secret-pattern', detail: 'secret-looking string detected', evidence: { file: relPosix, pattern_name: pat.name } });
          }
        }
      }
    }
  }

  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isSkippedDir(e.name)) continue;
        if (depth + 1 <= maxDepth) walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue; // skip symlinks/sockets/etc — read-only scan, no special-file handling
      processFile(abs, path.relative(root, abs));
    }
  }
  walk(root, 0);

  if (sawIndexHtml && stackSet.size === 0) stackSet.add('static');

  const tests = { present: testFileCount > 0 || testDirsSet.size > 0, dirs: [...testDirsSet].sort(), files: testFileCount };
  const largest = codeFiles.slice().sort((a, b) => b.lines - a.lines).slice(0, 5);

  if (!tests.present) {
    risks.push({ level: 'med', kind: 'no-tests', detail: 'no test files detected', evidence: { checked: ['test/', 'tests/', '__tests__/', '*.test.*', '*.spec.*'] } });
  }
  if (envFile) {
    const gitignoreCoversEnv = gitignoreContent != null && gitignoreContent.includes('.env');
    if (!gitignoreCoversEnv) {
      risks.push({
        level: 'high', kind: 'env-file-exposure', detail: 'possible committed secrets file',
        evidence: { file: envFile, gitignore: gitignoreContent == null ? 'missing' : 'does not mention .env' },
      });
    }
  }
  if (!hasReadme) {
    risks.push({ level: 'low', kind: 'no-readme', detail: 'no README(.md) found at project root', evidence: {} });
  }
  if (todoCount > 0) {
    risks.push({ level: 'low', kind: 'todo-fixme', detail: 'TODO/FIXME markers found in code', evidence: { count: todoCount } });
  }

  risks.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);

  return {
    root,
    stack: [...stackSet].sort(),
    counts,
    entryPoints: [...new Set(entryPoints)].sort(),
    tests,
    largest,
    risks,
    generatedAt: new Date().toISOString(),
  };
}

function printHuman(result) {
  const lines = [];
  lines.push('Deep Learn scan — ' + result.root);
  lines.push('Generated: ' + result.generatedAt);
  lines.push('Stack: ' + (result.stack.length ? result.stack.join(', ') : 'unknown'));
  lines.push('Files: ' + result.counts.totalFiles + ' (' + humanBytes(result.counts.totalBytes) + ')');
  lines.push('  code=' + result.counts.code + ' docs=' + result.counts.docs + ' config=' + result.counts.config + ' test=' + result.counts.test + ' other=' + result.counts.other);
  lines.push('Entry points: ' + (result.entryPoints.length ? result.entryPoints.join(', ') : 'none detected'));
  lines.push('Tests: ' + (result.tests.present ? ('present (' + result.tests.files + ' files, dirs: ' + (result.tests.dirs.join(', ') || 'n/a') + ')') : 'NOT DETECTED'));
  if (result.largest.length) {
    lines.push('Largest code files:');
    for (const f of result.largest) lines.push('  ' + f.lines + ' lines  ' + f.path);
  }
  lines.push('Risks (' + result.risks.length + '):');
  if (!result.risks.length) lines.push('  none found');
  for (const r of result.risks) {
    if (r.kind === 'secret-pattern') {
      lines.push('  ' + r.level.toUpperCase() + ' secret-pattern ' + r.evidence.pattern_name + ' in ' + r.evidence.file);
    } else {
      const ev = r.evidence && Object.keys(r.evidence).length ? ' ' + JSON.stringify(r.evidence) : '';
      lines.push('  ' + r.level.toUpperCase() + ' ' + r.kind + ' — ' + r.detail + ev);
    }
  }
  return lines.join('\n');
}

/** logEvent(root, runId, eventType, extra) — ROOT CONTAINMENT (2026-08-03, same bug class proven live in
 *  forge-runcontract/forge-manifest the same day): this tool scans the project given by `--path`, but the
 *  writer used to be resolved from `__dirname`, so scanning project B wrote its deep_learn_started/
 *  _completed events into THIS install's forge-runs. The writer now belongs to the SCANNED root (the
 *  convention forge-distill/forge-audit-loop/forge-docdrift already follow); a root without its own
 *  writer is reported honestly instead of silently falling back to another install's writer. */
function logEvent(root, runId, eventType, extra) {
  const logEventPath = path.join(path.resolve(root || '.'), '.claude', 'forge-dashboard', 'log-event.cjs');
  if (!fs.existsSync(logEventPath)) {
    return { status: 1, stdout: '', stderr: 'no event writer under the scanned root (' + logEventPath + ' missing) — refusing cross-install fallback' };
  }
  return spawnSync(process.execPath, [logEventPath, runId, eventType, JSON.stringify(extra || {})], { encoding: 'utf8' });
}

module.exports = { scanProject, SECRET_PATTERNS, categoryOf, logEvent };

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    const opts = { path: process.cwd(), run: null, store: false };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--path') opts.path = argv[++i];
      else if (a === '--run') opts.run = argv[++i];
      else if (a === '--store') opts.store = true;
    }

    const root = path.resolve(opts.path);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      console.error('forge-deeplearn: not an existing directory: ' + root);
      process.exitCode = 1;
      return;
    }

    if (opts.run) {
      const started = logEvent(root, opts.run, 'deep_learn_started', { agent: 'project-scan', note: 'deep learn scan started', path: root });
      if (started.status !== 0) console.error('forge-deeplearn: log-event (deep_learn_started) warning: ' + (started.stderr || '').trim());
    }

    let result;
    try {
      result = scanProject(root);
    } catch (e) {
      console.error('forge-deeplearn: scan failed: ' + e.message);
      process.exitCode = 1;
      return;
    }

    console.log(printHuman(result));

    if (opts.run) {
      const high = result.risks.filter((r) => r.level === 'high').length;
      const med = result.risks.filter((r) => r.level === 'med').length;
      const low = result.risks.filter((r) => r.level === 'low').length;
      const note = 'deep learn scan completed: ' + result.counts.totalFiles + ' files, risks high=' + high + ' med=' + med + ' low=' + low;
      const completed = logEvent(root, opts.run, 'deep_learn_completed', { agent: 'project-scan', note });
      if (completed.status !== 0) console.error('forge-deeplearn: log-event (deep_learn_completed) warning: ' + (completed.stderr || '').trim());
    }

    if (opts.store) {
      try {
        const store = require('./forge-store.cjs');
        const id = 'deeplearn-' + Date.now();
        store.putEntity('artifacts', id, result);
        console.log('stored artifacts/' + id + '.json');
      } catch (e) {
        console.error('forge-deeplearn: store failed: ' + e.message);
        process.exitCode = 1;
      }
    }
  };
  try { main(); } catch (e) { console.error('forge-deeplearn: ' + e.message); process.exitCode = 1; }
}
