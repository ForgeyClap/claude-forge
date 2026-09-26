// C1 fix (WP-C1, 2026-09-26 laptop re-audit) — unit coverage for computeProjectsAsync()'s
// multi-root merge/dedup/partial-failure behavior in projects.mjs.
//
// WHY THIS FILE USES THE TEST-ONLY OVERRIDE SEAMS (never the real SYNC_SCAN_ROOTS/FORGE_SYNC_CJS):
// paths.mjs computes PROJECT_ROOT from THIS file's own on-disk location, walking exactly two fixed
// directory levels up from gateway/src (gateway -> command-center -> project root). That is correct
// whenever command-center is nested directly inside the real project (every real install, and the
// main working tree) — but a git WORKTREE of the nested command-center repo checked out one level
// deeper than that (e.g. under a scratch folder) makes PROJECT_ROOT resolve one directory too
// shallow, which in turn makes FORGE_SYNC_CJS point at a path that does not exist THERE. That is a
// pre-existing characteristic of how this repo computes its own paths from a worktree's physical
// location — not a defect in the multi-root logic this file actually tests, and not something this
// work package's write scope (gateway/dashboard/discord) is asked to change. `_setForgeSyncCjsForTests`
// and `_setScanRootsForTests` (added alongside the C1 fix, same `_set*ForTests` convention as
// `projects-create.mjs`'s own seams) let this suite exercise the REAL forge-sync.cjs tool — read
// pointed at its real, absolute location in this checkout — against fully isolated temp fixture
// roots, so the assertions below are genuine integration coverage of the merge/dedup/partial-
// failure behavior, independent of wherever this particular checkout happens to be nested.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listProjects,
  _resetProjectsCacheForTests,
  _setForgeSyncCjsForTests,
  _resetForgeSyncCjsForTests,
  _setScanRootsForTests,
  _resetScanRootsForTests,
} from '../src/projects.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';

// The real, already-reviewed forge-sync.cjs this project ships — found by walking upward from
// PROJECT_ROOT for the real outer project's own .claude/forge-bin (never assumed to be a fixed
// number of levels, exactly because that assumption is this file's own reason for existing —
// see the header above). Falls back to `null` (every test below skips honestly) rather than
// guessing a wrong path if it truly cannot be found.
function findRealForgeSyncCjs() {
  let dir = PROJECT_ROOT;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.claude', 'forge-bin', 'forge-sync.cjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const REAL_FORGE_SYNC_CJS = findRealForgeSyncCjs();
const SKIP_REASON = REAL_FORGE_SYNC_CJS
  ? false
  : 'no real .claude/forge-bin/forge-sync.cjs found by walking up from PROJECT_ROOT — this suite needs the real, already-reviewed tool to spawn against isolated fixtures.';

let tempRoots = [];

function makeRootWithProject(projectDirName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-multiroot-test-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, projectDirName, '.claude', 'forge-dashboard'), { recursive: true });
  return root;
}

beforeEach(() => {
  tempRoots = [];
  _resetProjectsCacheForTests();
  if (REAL_FORGE_SYNC_CJS) _setForgeSyncCjsForTests(REAL_FORGE_SYNC_CJS);
});

after(() => {
  _resetForgeSyncCjsForTests();
  _resetScanRootsForTests();
  _resetProjectsCacheForTests();
});

test('two different scan roots each contribute their own real project — both are merged into one list', { skip: SKIP_REASON }, async () => {
  const rootA = makeRootWithProject('proj-alpha');
  const rootB = makeRootWithProject('proj-beta');
  _setScanRootsForTests([rootA, rootB]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  const names = result.projects.map((p) => p.name);
  assert.ok(names.includes('proj-alpha'), 'root A\'s project must be discovered');
  assert.ok(names.includes('proj-beta'), 'root B\'s project must be discovered');

  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
});

test('the SAME root scanned twice never double-counts the same real project (dedup by resolved path)', { skip: SKIP_REASON }, async () => {
  const rootA = makeRootWithProject('proj-gamma');
  _setScanRootsForTests([rootA, rootA]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  const matches = result.projects.filter((p) => p.name === 'proj-gamma');
  assert.equal(matches.length, 1, 'a project reachable from two identical scan roots must appear exactly once');

  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
});

// A2 fix (WP-C2, 2026-09-26 laptop re-audit): two DIFFERENT real projects (different roots,
// different resolved paths) that happen to share a folder NAME must both be marked `ambiguous`,
// never silently deduped or presented as if only one existed.
test('two different real projects that share a folder NAME are both marked ambiguous', { skip: SKIP_REASON }, async () => {
  const rootA = makeRootWithProject('my-site');
  const rootB = makeRootWithProject('my-site');
  _setScanRootsForTests([rootA, rootB]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  const matches = result.projects.filter((p) => p.name === 'my-site');
  assert.equal(matches.length, 2, 'both real, differently-pathed projects must be present — never deduped by name');
  assert.ok(matches.every((p) => p.ambiguous === true), 'every entry sharing the colliding name must be marked ambiguous');
  const paths = new Set(matches.map((p) => p.path));
  assert.equal(paths.size, 2, 'the two ambiguous entries must keep their own distinct real paths');

  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
});

test('a uniquely-named project is never marked ambiguous', { skip: SKIP_REASON }, async () => {
  const rootA = makeRootWithProject('proj-unique');
  _setScanRootsForTests([rootA]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  const entry = result.projects.find((p) => p.name === 'proj-unique');
  assert.ok(entry);
  assert.equal(entry.ambiguous, false);

  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
});

test('a root that does not exist on disk contributes zero projects but never fails the whole scan', { skip: SKIP_REASON }, async () => {
  const rootA = makeRootWithProject('proj-delta');
  const missingRoot = path.join(rootA, 'this-path-does-not-exist-anywhere');
  _setScanRootsForTests([rootA, missingRoot]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true, 'a missing root must degrade to "0 found there", never abort the other real root');
  assert.ok(result.projects.some((p) => p.name === 'proj-delta'));

  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
});

// This one deliberately does NOT use the real forge-sync.cjs override — it needs a tool whose OWN
// spawn genuinely fails for one specific root while succeeding for another, which the real tool
// never does for an ordinary missing/empty directory (see the test above). A tiny, self-contained
// stub with the exact same `list <root>` I/O contract (parseListOutput's own header describes it:
// "<N> Forge project(s) under <root>:" then one indented path per line) reproduces that failure
// mode deterministically, without touching or depending on the real tool at all.
function writeStubForgeSyncCjs(dir) {
  const stubPath = path.join(dir, 'stub-forge-sync.cjs');
  const src = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const root = process.argv[3];",
    "if (root && root.includes('FAIL-THIS-ROOT')) { console.error('stub: simulated spawn failure for ' + root); process.exit(1); }",
    "const out = [];",
    "let entries = [];",
    "try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { entries = []; }",
    "for (const e of entries) {",
    "  if (!e.isDirectory()) continue;",
    "  if (fs.existsSync(path.join(root, e.name, '.claude', 'forge-dashboard'))) out.push(path.join(root, e.name));",
    "}",
    "console.log(out.length + ' Forge project(s) under ' + root + ':');",
    "for (const p of out) console.log('  ' + p);",
    "process.exit(0);",
  ].join('\n');
  fs.writeFileSync(stubPath, src, 'utf8');
  return stubPath;
}

test('PARTIAL FAILURE: one root whose own spawn genuinely fails never hides a real project found on another root', async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-multiroot-stub-'));
  tempRoots.push(stubDir);
  const stubPath = writeStubForgeSyncCjs(stubDir);
  const rootA = makeRootWithProject('proj-epsilon');
  const failingRoot = path.join(stubDir, 'FAIL-THIS-ROOT');
  fs.mkdirSync(failingRoot, { recursive: true });

  _setForgeSyncCjsForTests(stubPath);
  _setScanRootsForTests([rootA, failingRoot]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true, 'the working root\'s real result must still surface even though the other root\'s spawn failed');
  assert.ok(result.projects.some((p) => p.name === 'proj-epsilon'));

  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
});

// Finding #4 (WP-C2, 2026-09-26 laptop re-audit): the client-visible `error` must be generic (no
// root path, no username, no raw process-error text) while the real per-root detail still reaches
// this process's own log — this test now asserts BOTH halves of that split.
test('TOTAL FAILURE: the client-visible error is generic (no leaked paths); the real detail goes to console.error only', async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-multiroot-stub-'));
  tempRoots.push(stubDir);
  const stubPath = writeStubForgeSyncCjs(stubDir);
  const failingRootA = path.join(stubDir, 'FAIL-THIS-ROOT-a');
  const failingRootB = path.join(stubDir, 'FAIL-THIS-ROOT-b');
  fs.mkdirSync(failingRootA, { recursive: true });
  fs.mkdirSync(failingRootB, { recursive: true });

  _setForgeSyncCjsForTests(stubPath);
  _setScanRootsForTests([failingRootA, failingRootB]);
  _resetProjectsCacheForTests();

  const originalConsoleError = console.error;
  const loggedLines = [];
  console.error = (...args) => { loggedLines.push(args.join(' ')); };
  let result;
  try {
    result = await listProjects();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(result.ok, false);
  assert.equal(result.projects.length, 0);
  assert.match(result.error, /forge-sync list failed for every scan root/);
  assert.doesNotMatch(result.error, /FAIL-THIS-ROOT-a/, 'the client-visible error must never contain a real root path');
  assert.doesNotMatch(result.error, /FAIL-THIS-ROOT-b/, 'the client-visible error must never contain a real root path');
  assert.ok(loggedLines.some((l) => l.includes('FAIL-THIS-ROOT-a')), 'the real detail must still reach the gateway\'s own log');
  assert.ok(loggedLines.some((l) => l.includes('FAIL-THIS-ROOT-b')), 'the real detail must still reach the gateway\'s own log');

  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
});
