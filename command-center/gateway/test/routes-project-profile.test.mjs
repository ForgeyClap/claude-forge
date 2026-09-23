// HTTP-level integration test for the new cc-fix-adapter T6d endpoint
// (GET /api/projects/:name/profile) — same server-boot pattern as routes-wp8.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { request } from '../test-support/helpers.mjs';
import { needsFilledProjectProfile } from './.real-data-guard.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);

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

// Real-data assertion: only THIS repository's own filled-in profile says "tooling / meta". On a fresh clone the
// profile is still the installer scaffold and FORGE_VERSION.json does not exist yet, so the endpoint honestly
// returns project_type_raw:null / version_present:false — skipped there with the reason (2026-09-23), while the
// endpoint's shape and its 404 security path below are asserted everywhere.
test('GET /api/projects/:name/profile returns the real profile + version for this project', { skip: needsFilledProjectProfile() }, async () => {
  const res = await request(port, '/api/projects/' + encodeURIComponent(THIS_PROJECT_NAME) + '/profile');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.profile_present, true);
  assert.match(res.json.project_type_raw, /tooling \/ meta/);
  assert.equal(res.json.version_present, true);
  assert.ok(res.json.forge_version.length > 0);
});

test('GET /api/projects/:name/profile answers with the documented shape even before /setup-forge filled the profile in', async () => {
  const res = await request(port, '/api/projects/' + encodeURIComponent(THIS_PROJECT_NAME) + '/profile');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(typeof res.json.profile_present, 'boolean');
  assert.ok(res.json.project_type_raw === null || typeof res.json.project_type_raw === 'string');
  assert.equal(typeof res.json.version_present, 'boolean');
});

test('SECURITY: an unknown project name returns 404, never a filesystem probe outside the registry', async () => {
  const res = await request(port, '/api/projects/' + encodeURIComponent('../../evil') + '/profile');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('an unregistered but real-looking project name returns 404 honestly', async () => {
  const res = await request(port, '/api/projects/definitely-not-a-real-registered-project/profile');
  assert.equal(res.statusCode, 404);
});
