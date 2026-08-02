// HTTP-level integration test for the new cc-fix-adapter T6d endpoint
// (GET /api/projects/:name/profile) — same server-boot pattern as routes-wp8.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { request } from '../test-support/helpers.mjs';

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

test('GET /api/projects/:name/profile returns the real profile + version for this project', async () => {
  const res = await request(port, '/api/projects/' + encodeURIComponent(THIS_PROJECT_NAME) + '/profile');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.profile_present, true);
  assert.match(res.json.project_type_raw, /tooling \/ meta/);
  assert.equal(res.json.version_present, true);
  assert.ok(res.json.forge_version.length > 0);
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
