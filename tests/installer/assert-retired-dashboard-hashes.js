#!/usr/bin/env node
// Drift check (WP-P3b): .claude/forge-bin/forge-retired-dashboard-hashes.tsv embeds the known
// shipped content (CRLF-normalized sha256) of the 7 dashboard files retired in WP-N1 --
// .claude/forge-dashboard/{server.cjs,index.html,app.js,graph.js,lenses.js,panels.js,styles.css} --
// so install.ps1/install.sh's pre-2.8.0 (no-manifest) legacy fallback can recognize them. This
// recomputes the SAME table straight from this repo's own git history (every commit that ever
// touched each path) and fails loudly if the shipped table does not match exactly -- "recompute so
// it cannot drift" only holds if this actually runs and actually compares, not merely exists.
//
// A shallow or missing git history makes the recompute impossible to trust (a shallow clone simply
// does not have the old commits) -- that is reported plainly and exits 0, the SAME
// "skip, not a failure" precedent forge-doctor.test.cjs already uses for its own
// forge-backups/git-unavailable fixture. CI runs with a full checkout (fetch-depth: 0) specifically
// so this check is not silently skipped there -- see validate.yml's own comment on that setting.
'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..');
const TSV_PATH = path.join(REPO_ROOT, '.claude', 'forge-bin', 'forge-retired-dashboard-hashes.tsv');
const EXPECTED_TOTAL = 21;
const RETIRED_PATHS = [
  '.claude/forge-dashboard/server.cjs',
  '.claude/forge-dashboard/index.html',
  '.claude/forge-dashboard/app.js',
  '.claude/forge-dashboard/graph.js',
  '.claude/forge-dashboard/lenses.js',
  '.claude/forge-dashboard/panels.js',
  '.claude/forge-dashboard/styles.css',
];

let fail = 0;
function ok(msg) { console.log('ok   ' + msg); }
function bad(msg) { console.error('FAIL ' + msg); fail = 1; }

function git(args) {
  // stdio[2] (stderr) is piped and deliberately never inherited/printed: a commit that DELETED a
  // path (expected -- see recomputeFromGit's own comment) makes `git show <rev>:<path>` fail with a
  // "fatal: ... does not exist in ..." line that is correctly caught and skipped below; without this,
  // Node's execFileSync default of forwarding stderr to THIS process would print that expected,
  // already-handled failure as if it were a real error on every run.
  return execFileSync('git', args, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 64, stdio: ['ignore', 'pipe', 'pipe'] });
}

function normalizeCrlf(buf) {
  return Buffer.from(buf.toString('binary').replace(/\r\n/g, '\n'), 'binary');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function parseShippedTsv(tsvPath) {
  if (!fs.existsSync(tsvPath)) return null;
  const byPath = new Map();
  let total = 0;
  const lines = fs.readFileSync(tsvPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const p = line.slice(0, tab).trim();
    const h = line.slice(tab + 1).trim().toLowerCase();
    if (!p || !h) continue;
    if (!byPath.has(p)) byPath.set(p, new Set());
    byPath.get(p).add(h);
    total++;
  }
  return { byPath, total };
}

function recomputeFromGit(relPath) {
  const commits = git(['log', '--all', '--format=%H', '--', relPath]).toString('utf8').trim().split('\n').filter(Boolean);
  const hashes = new Set();
  for (const commit of commits) {
    let blob;
    try {
      blob = git(['show', commit + ':' + relPath]);
    } catch (e) {
      continue; // a path that existed in the tree list but was itself unreadable at this rev -- skip, never crash the check
    }
    hashes.add(sha256(normalizeCrlf(blob)));
  }
  return hashes;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 0. usage / fixture sanity
// ---------------------------------------------------------------------------
if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
  ok('(no .git at the repo root -- not a git checkout, drift check skipped, not a failure)');
  process.exit(0);
}

let isShallow = false;
try {
  isShallow = git(['rev-parse', '--is-shallow-repository']).toString('utf8').trim() === 'true';
} catch (e) {
  ok('(git is not usable here -- drift check skipped, not a failure: ' + e.message + ')');
  process.exit(0);
}
if (isShallow) {
  ok('(this is a shallow clone -- full history is required to recompute historical hashes, drift check skipped, not a failure)');
  process.exit(0);
}

const shipped = parseShippedTsv(TSV_PATH);
if (!shipped) {
  bad('shipped table not found: ' + TSV_PATH);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. recompute from git, per path, and compare exactly (no missing hash, no extra hash)
// ---------------------------------------------------------------------------
let recomputedTotal = 0;
for (const relPath of RETIRED_PATHS) {
  const gitHashes = recomputeFromGit(relPath);
  const shippedHashes = shipped.byPath.get(relPath) || new Set();
  recomputedTotal += gitHashes.size;
  if (gitHashes.size === 0) {
    bad(relPath + ': git history has NO commits for this path (fixture assumption broken -- was this file ever actually shipped?)');
    continue;
  }
  if (setsEqual(gitHashes, shippedHashes)) {
    ok(relPath + ': ' + gitHashes.size + ' historical hash(es) match the shipped table exactly');
  } else {
    const missing = [...gitHashes].filter((h) => !shippedHashes.has(h));
    const extra = [...shippedHashes].filter((h) => !gitHashes.has(h));
    if (missing.length) bad(relPath + ': the shipped table is MISSING a real historical hash: ' + missing.join(', '));
    if (extra.length) bad(relPath + ': the shipped table has an EXTRA hash git history does not recognize for this path: ' + extra.join(', '));
  }
}

// ---------------------------------------------------------------------------
// 2. the grand total the work package itself calls out (21) -- a distinct, sharper failure message
//    than the per-path diff above if the two ever disagree on COUNT for a reason the per-path loop
//    did not otherwise catch (e.g. a path this table lists that RETIRED_PATHS above does not).
// ---------------------------------------------------------------------------
if (shipped.total !== EXPECTED_TOTAL) {
  bad('shipped table has ' + shipped.total + ' total line(s), expected ' + EXPECTED_TOTAL);
} else {
  ok('shipped table has exactly ' + EXPECTED_TOTAL + ' total line(s)');
}
if (recomputedTotal !== EXPECTED_TOTAL) {
  bad('git history recomputed ' + recomputedTotal + ' total distinct hash(es) across the 7 paths, expected ' + EXPECTED_TOTAL);
} else {
  ok('git history recomputes to exactly ' + EXPECTED_TOTAL + ' total distinct hash(es) across the 7 paths');
}

if (shipped.byPath.size !== RETIRED_PATHS.length) {
  bad('shipped table lists ' + shipped.byPath.size + ' distinct path(s), expected exactly the 7 retired dashboard files');
} else {
  ok('shipped table lists exactly the 7 retired dashboard files, no more, no less');
}

process.exit(fail);
