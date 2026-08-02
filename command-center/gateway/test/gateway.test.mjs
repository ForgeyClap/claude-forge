// Integration tests: real HTTP requests against a real instance of the gateway's request
// listener, bound to 127.0.0.1 on an ephemeral port (0) so this never collides with a
// production instance on :4100. Exercises the real project registry (forge-sync.cjs spawn),
// this project's own real forge-runs directory, and the security guards, end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { request } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT); // "my-forge-project" on this machine
const KNOWN_RUN_ID = 'forge-2026-07-26-command-center'; // the run this very slice was dispatched under

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

test('server binds only to 127.0.0.1 (never 0.0.0.0)', () => {
  const addr = server.address();
  assert.equal(addr.address, '127.0.0.1');
});

test('GET /api/health returns a live, structured, truthful-state health report', async () => {
  const res = await request(port, '/api/health');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.forge, 'has forge sub-object');
  assert.ok(['CONNECTED', 'DISCONNECTED', 'DEGRADED'].includes(res.json.forge.control_center.state));
  assert.ok(res.json.forge.doctor_last && typeof res.json.forge.doctor_last.state === 'string');
  assert.equal(res.json.provenance, 'LIVE');
});

test('GET /api/projects returns the real discovered Forge project registry', async () => {
  const res = await request(port, '/api/projects');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.projects) && res.json.projects.length >= 10, 'at least the known ~15 real projects');
  const self = res.json.projects.find((p) => p.name === THIS_PROJECT_NAME);
  assert.ok(self, 'this project itself must appear in the real registry');
  assert.equal(self.has_dashboard, true);
  assert.equal(res.json.provenance, 'DERIVED');
  assert.ok(typeof res.json.age_ms === 'number');
});

test('GET /api/runs?project=<real project> contains this very run', async () => {
  const res = await request(port, '/api/runs?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  const found = res.json.runs.find((r) => r.run_id === KNOWN_RUN_ID);
  assert.ok(found, 'the live run this slice was dispatched under must be listed');
  assert.equal(found.has_run_json, false); // this run has never written run.json — honest, not assumed
  assert.ok(found.event_count > 0);
});

test('GET /api/events returns this run\'s real events', async () => {
  const res = await request(port, '/api/events?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=' + KNOWN_RUN_ID + '&after=0');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.events.length > 0);
  const hasOurDispatch = res.json.events.some((e) => e.dispatch_id === 'a0f0dbae827429bc2');
  assert.ok(hasOurDispatch, 'must contain this task\'s own real subagent_started dispatch event');
});

test('SECURITY: Host header mismatch is rejected with 403', async () => {
  const res = await request(port, '/api/health', { headers: { Host: 'evil.com' } });
  assert.equal(res.statusCode, 403);
});

test('SECURITY: path traversal via ?project= is rejected (never matches the allowlist)', async () => {
  const res = await request(port, '/api/runs?project=' + encodeURIComponent('../../'));
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('SECURITY: path traversal via ?run= is rejected with 400', async () => {
  const res = await request(port, '/api/events?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=' + encodeURIComponent('..%2F'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
});

test('SECURITY: an unknown project name never reaches the filesystem', async () => {
  const res = await request(port, '/api/runs?project=' + encodeURIComponent('totally-not-a-real-project'));
  assert.equal(res.statusCode, 404);
});

test('non-GET methods on /api/* are rejected (this slice is read-only)', async () => {
  const res = await request(port, '/api/health', { method: 'POST' });
  assert.equal(res.statusCode, 405);
});

test('unknown route returns 404', async () => {
  const res = await request(port, '/api/does-not-exist');
  assert.equal(res.statusCode, 404);
});
