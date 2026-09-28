// A2 fix (WP-C2, 2026-09-26 laptop re-audit) — HTTP-level coverage: when two real discovered
// projects share a folder NAME (multi-root discovery, WP-C1), every name-based lookup route must
// answer 409 "ambiguous project name" rather than silently operating on whichever one happened to
// resolve first. Same real-server, real-port pattern as routes-wp3.test.mjs.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';
import {
  _resetProjectsCacheForTests,
  _setForgeSyncCjsForTests,
  _resetForgeSyncCjsForTests,
  _setScanRootsForTests,
  _resetScanRootsForTests,
} from '../src/projects.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

// Same "find the real, already-reviewed forge-sync.cjs by walking up from PROJECT_ROOT" approach
// as projects-multiroot.test.mjs — see that file's own header for why a fixed relative depth
// cannot be assumed from a worktree's own on-disk location.
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

let server;
let port;
let tempRoots = [];

function makeRootWithProject(projectDirName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ambiguous-route-test-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, projectDirName, '.claude', 'forge-dashboard'), { recursive: true });
  return root;
}

// WP-CC1 (item 12): the by-PATH resolution tests below need to reach `resolveProjectByName`'s
// SUCCESSFUL-match branch, which (unlike the ambiguity branch every other test in this file only
// ever exercises) also runs the real `anyContainmentOk(SYNC_SCAN_ROOTS, ...)` defense-in-depth
// check — see server.mjs's own `resolveProjectByName`. `SYNC_SCAN_ROOTS` is a fixed constant
// (never test-overridable the way `projects.mjs`'s own scan roots are), so an `os.tmpdir()` fixture
// fails it regardless of this fix — same reasoning as proof-cc1.test.mjs's own
// `freshRootUnderDataDir()`. Placed under `COMMAND_CENTER_DATA_DIR` instead, which real
// `SYNC_SCAN_ROOTS` always contains (it sits inside this project's own tree).
const DATA_DIR_FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-ambiguous-route');
function makeDataDirRootWithProject(projectDirName) {
  fs.mkdirSync(DATA_DIR_FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(DATA_DIR_FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, projectDirName, '.claude', 'forge-dashboard'), { recursive: true });
  return root;
}

before(async () => {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

beforeEach(() => {
  tempRoots = [];
  if (REAL_FORGE_SYNC_CJS) _setForgeSyncCjsForTests(REAL_FORGE_SYNC_CJS);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  _resetForgeSyncCjsForTests();
  _resetScanRootsForTests();
  _resetProjectsCacheForTests();
  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
  fs.rmSync(DATA_DIR_FIXTURE_PARENT, { recursive: true, force: true });
});

// Wires up two temp roots each holding a project folder named `my-site` and points discovery at
// exactly those two roots (never the real machine's own roots) for the duration of one test.
function setUpAmbiguousFixture() {
  const rootA = makeRootWithProject('my-site');
  const rootB = makeRootWithProject('my-site');
  _setScanRootsForTests([rootA, rootB]);
  _resetProjectsCacheForTests();
  return { rootA, rootB };
}

// Same shape as setUpAmbiguousFixture(), but rooted under COMMAND_CENTER_DATA_DIR so a SUCCESSFUL
// resolution (not just 409 ambiguity-detection) can pass the real SYNC_SCAN_ROOTS containment check
// too — see makeDataDirRootWithProject()'s own header for why.
function setUpAmbiguousFixtureUnderDataDir() {
  const rootA = makeDataDirRootWithProject('my-site');
  const rootB = makeDataDirRootWithProject('my-site');
  _setScanRootsForTests([rootA, rootB]);
  _resetProjectsCacheForTests();
  return { rootA, rootB };
}

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);

test('GET /api/projects marks both same-name entries ambiguous:true with their own real paths', { skip: SKIP_REASON }, async () => {
  setUpAmbiguousFixture();
  const res = await request(port, '/api/projects');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  const matches = res.json.projects.filter((p) => p.name === 'my-site');
  assert.equal(matches.length, 2);
  assert.ok(matches.every((p) => p.ambiguous === true));
  const paths = new Set(matches.map((p) => p.path));
  assert.equal(paths.size, 2, 'the dashboard must be able to tell the two apart by path');
});

test('GET /api/runs?project=<ambiguous name> answers 409, never picks either project', { skip: SKIP_REASON }, async () => {
  setUpAmbiguousFixture();
  const res = await request(port, '/api/runs?project=' + encodeURIComponent('my-site'));
  assert.equal(res.statusCode, 409);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /ambiguous/);
  assert.equal(res.json.matches.length, 2);
});

// WP-CC1 (item 12): "two folders named the same make every endpoint fail for that project" — the
// 409 above already hands back each colliding project's own real `path`; this proves a caller can
// retry the SAME `?project=` param with that exact path and actually reach the ONE project it means,
// rather than being permanently stuck at 409 for that name.
test('GET /api/runs?project=<the real PATH from a 409\'s own matches> resolves that ONE project, never the other', { skip: SKIP_REASON }, async () => {
  const { rootA, rootB } = setUpAmbiguousFixtureUnderDataDir();
  const pathA = path.join(rootA, 'my-site');
  const pathB = path.join(rootB, 'my-site');

  const resA = await request(port, '/api/runs?project=' + encodeURIComponent(pathA));
  assert.equal(resA.statusCode, 200, 'the exact real path must resolve, unlike the bare colliding name');
  assert.equal(resA.json.ok, true);

  const resB = await request(port, '/api/runs?project=' + encodeURIComponent(pathB));
  assert.equal(resB.statusCode, 200);
  assert.equal(resB.json.ok, true);
});

test('GET /api/runs?project=<a path NOT in the registry> is never trusted — falls through to the ordinary 404/409 path lookup', { skip: SKIP_REASON }, async () => {
  setUpAmbiguousFixtureUnderDataDir();
  const notRegistered = path.join(os.tmpdir(), 'definitely-not-a-registered-project-path-' + Date.now());
  const res = await request(port, '/api/runs?project=' + encodeURIComponent(notRegistered));
  assert.equal(res.statusCode, 404, 'an arbitrary filesystem path that is not already a discovered project must never be trusted');
});

// N7 wording test (WP-C4, 2026-09-26 independent security re-review): the 409 body must tell the
// user how to actually resolve the ambiguity (rename one of the two folders, or open the wanted
// one directly from its own folder) and must NOT mention the old, non-existent "path-qualified
// selection" feature the dashboard never had.
test('GET /api/runs?project=<ambiguous name> 409 text carries real resolution advice, not the old made-up feature', { skip: SKIP_REASON }, async () => {
  setUpAmbiguousFixture();
  const res = await request(port, '/api/runs?project=' + encodeURIComponent('my-site'));
  assert.equal(res.statusCode, 409);
  assert.match(res.json.error, /rename one of the two folders/);
  assert.match(res.json.error, /open the one you mean directly from its own folder/);
  assert.doesNotMatch(res.json.error, /path-qualified selection/);
});

test('GET /api/agents?project=<ambiguous name> answers 409, never picks either project', { skip: SKIP_REASON }, async () => {
  setUpAmbiguousFixture();
  const res = await request(port, '/api/agents?project=' + encodeURIComponent('my-site'));
  assert.equal(res.statusCode, 409);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /ambiguous/);
});

test('GET /api/projects/<ambiguous name>/profile (path-segment variant) answers 409', { skip: SKIP_REASON }, async () => {
  setUpAmbiguousFixture();
  const res = await request(port, '/api/projects/' + encodeURIComponent('my-site') + '/profile');
  assert.equal(res.statusCode, 409);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /ambiguous/);
});

test('POST /api/conversations with an ambiguous project answers 409 and never creates a conversation', { skip: SKIP_REASON }, async () => {
  setUpAmbiguousFixture();
  const res = await requestWithBody(port, '/api/conversations', { jsonBody: { project: 'my-site', title: 'x' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /ambiguous/);
});

// Control: an ordinary, uniquely-named real project (this very worktree, discovered via the real
// scan roots — same fixture shape routes-wp3.test.mjs already relies on) must be completely
// unaffected by this fix: no scan-root override active, so the real containment check on its real
// path still passes exactly as before.
// KNOWN ENVIRONMENTAL CAVEAT (see projects-multiroot.test.mjs's own header and this project's
// mission-blueprint.md "note"): PROJECT_ROOT is computed from a FIXED relative depth in paths.mjs,
// which resolves one directory too shallow in a git worktree nested deeper than the real
// command-center folder (e.g. under a scratch folder) — that makes THIS_PROJECT_NAME resolve to a
// folder that is not itself a registered Forge project there, so this control can 404 in such a
// worktree even though the fix under test is not involved at all (routes-wp3.test.mjs's own
// unmodified, pre-existing project-lookup tests fail the exact same way in that same worktree,
// which is how this was confirmed to be pre-existing/environmental rather than a regression).
test('CONTROL: a uniquely-named real project still resolves normally (no false-positive ambiguity)', async () => {
  _resetScanRootsForTests();
  _resetProjectsCacheForTests();
  const res = await request(port, '/api/runs?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200, 'a unique project name must still succeed, not be swept into the ambiguous branch');
  assert.equal(res.json.ok, true);
});
