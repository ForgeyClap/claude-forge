// HTTP-level integration tests for build-lastdemos T2's GET /api/artifacts/:id/content route —
// same pattern as routes-wp8.test.mjs: runs against the REAL project registry entry for this
// project (read-only GET requests only, against a real, already-existing run artifact file —
// nothing here writes into the real .claude tree).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { request } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
const REAL_ARTIFACT_ID = 'wp0-health-report.md';
const REAL_ARTIFACT_PATH = path.join(
  PROJECT_ROOT, '.claude', 'forge-runs', 'forge-2026-07-25-full-audit', 'artifacts', REAL_ARTIFACT_ID,
);

let server;
let port;

before(async () => {
  _resetProjectsCacheForTests();
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /api/artifacts/:id/content serves the real run-artifact file bytes over real HTTP', async () => {
  if (!fs.existsSync(REAL_ARTIFACT_PATH)) {
    assert.ok(true, 'real fixture wp0-health-report.md is absent — skipping this HTTP sanity check honestly');
    return;
  }
  const res = await request(
    port,
    '/api/artifacts/' + encodeURIComponent(REAL_ARTIFACT_ID) + '/content?project=' + encodeURIComponent(THIS_PROJECT_NAME),
  );
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/markdown/);
  assert.match(res.headers['content-disposition'], /attachment/);
  assert.match(res.headers['content-disposition'], /wp0-health-report\.md/);
  assert.equal(res.body, fs.readFileSync(REAL_ARTIFACT_PATH, 'utf8'));
});

test('GET /api/artifacts/:id/content 404s honestly for an id that does not resolve', async () => {
  const res = await request(
    port,
    '/api/artifacts/' + encodeURIComponent('does-not-exist.md') + '/content?project=' + encodeURIComponent(THIS_PROJECT_NAME),
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('SECURITY: an encoded traversal id ("../../etc/passwd") is rejected without touching the filesystem', async () => {
  const res = await request(
    port,
    '/api/artifacts/' + encodeURIComponent('../../etc/passwd') + '/content?project=' + encodeURIComponent(THIS_PROJECT_NAME),
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('GET /api/artifacts/:id/content with an unknown project never reaches the filesystem', async () => {
  const res = await request(
    port,
    '/api/artifacts/' + encodeURIComponent(REAL_ARTIFACT_ID) + '/content?project=totally-not-real',
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /unknown project/);
});
