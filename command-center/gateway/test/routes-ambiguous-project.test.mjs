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
import { PROJECT_ROOT } from '../src/paths.mjs';
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
