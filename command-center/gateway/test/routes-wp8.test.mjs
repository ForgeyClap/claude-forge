// HTTP-level integration tests for the 4 new WP8 endpoints (/api/files, /api/files/read,
// /api/recovery, /api/checkpoints, /api/approvals) — same pattern as routes-wp6.test.mjs (left
// untouched; it is itself the regression proof for the WP6 endpoints). Runs against the REAL
// project registry entry for this project (read-only GET requests only — nothing here writes
// into the real .claude tree).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { request } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
const RUN_ID = 'forge-2026-07-26-command-center';

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

/* ------------------------------------------------------------------------------- /api/files --- */

test('GET /api/files lists the real project root', async () => {
  const res = await request(port, '/api/files?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&path=');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.path, '.');
  assert.ok(res.json.entries.some((e) => e.name === 'command-center' && e.type === 'dir'));
  assert.ok(res.json.entries.some((e) => e.name === 'CLAUDE.md' && e.type === 'file'));
});

test('GET /api/files/read returns real content for a real top-level file', async () => {
  const res = await request(
    port,
    '/api/files/read?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&path=' + encodeURIComponent('CLAUDE.md'),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.blocked, false);
  assert.equal(res.json.binary, false);
  assert.match(res.json.content, /Forge/);
});

test('SECURITY: GET /api/files/read blocks .git/config by name, over real HTTP', async () => {
  const res = await request(
    port,
    '/api/files/read?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&path=' + encodeURIComponent('.git/config'),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.blocked, true);
  assert.equal(res.json.reason, 'git-config');
  assert.equal(res.json.content, undefined);
});

test('SECURITY: GET /api/files rejects ../ traversal over real HTTP', async () => {
  const res = await request(
    port,
    '/api/files?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&path=' + encodeURIComponent('../../'),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /containment/);
});

test('SECURITY: GET /api/files with an unknown project never reaches the filesystem', async () => {
  const res = await request(port, '/api/files?project=totally-not-real&path=');
  assert.equal(res.statusCode, 404);
});

test('SECURITY: GET /api/files/read with a path-traversal project name is rejected by the allowlist', async () => {
  const res = await request(port, '/api/files/read?project=' + encodeURIComponent('../../') + '&path=CLAUDE.md');
  assert.equal(res.statusCode, 404);
});

test('GET /api/files/read with no ?path= is a clean 400, not a crash', async () => {
  const res = await request(port, '/api/files/read?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
});

/* ---------------------------------------------------------------------------- /api/recovery --- */

test('GET /api/recovery returns the real recovery-attempts + docdrift ledger for this project', async () => {
  const res = await request(port, '/api/recovery?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.recovery_provenance, 'LIVE');
  assert.ok(res.json.recovery_attempts.length > 0, 'this project has a real recovery-attempts.jsonl with entries');
  assert.equal(res.json.docdrift.provenance, 'LIVE');
  assert.ok(res.json.docdrift.findings.length > 0, 'this project has a real docdrift-state.json with entries');
});

test('SECURITY: GET /api/recovery with an unknown project never reaches the filesystem', async () => {
  const res = await request(port, '/api/recovery?project=totally-not-real');
  assert.equal(res.statusCode, 404);
});

/* -------------------------------------------------------------------------- /api/checkpoints --- */

test('GET /api/checkpoints honestly reports UNAVAILABLE resume state and no manifests for this project', async () => {
  const res = await request(port, '/api/checkpoints?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  // Verified true today: no FORGE_RESUME_STATE.json and no run manifest.json exist anywhere in
  // this fleet — the endpoint must say so honestly rather than fabricate either.
  assert.equal(res.json.resume_state.available, false);
  assert.equal(res.json.runs_with_manifest_count, 0);
  assert.equal(res.json.provenance, 'NOT CONFIGURED');
});

/* ---------------------------------------------------------------------------- /api/approvals --- */

test('GET /api/approvals returns the real hard-gates definitions', async () => {
  const res = await request(port, '/api/approvals?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.gates_provenance, 'LIVE');
  assert.ok(res.json.gates.length > 0);
  assert.ok(res.json.gates.some((g) => g.id === 'deploy'));
  // No ?run= given — honestly distinct from "checked this run, found none".
  assert.equal(res.json.evaluations_provenance, 'NOT REQUESTED');
  assert.deepEqual(res.json.evaluations, []);
});

test('GET /api/approvals with a real ?run= scans that run\'s own events for gate verdicts (honest, may be empty)', async () => {
  const res = await request(
    port,
    '/api/approvals?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=' + RUN_ID,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.evaluations_provenance, 'LIVE');
  assert.ok(Array.isArray(res.json.evaluations));
});

test('SECURITY: GET /api/approvals rejects a traversal-shaped ?run=', async () => {
  const res = await request(
    port,
    '/api/approvals?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=' + encodeURIComponent('../../etc'),
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
});

/* --------------------------------------------------------- WP8 secret-boundary scan addition --- */

const SECRET_PATTERNS = [
  { name: 'nvidia api key', re: /nvapi-[A-Za-z0-9_-]{10,}/ },
  { name: 'generic sk- style key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'github personal access token', re: /\bghp_[A-Za-z0-9]{10,}/ },
  { name: 'aws access key id', re: /\bAKIA[A-Z0-9]{10,}/ },
];

function assertNoSecrets(label, bodyText) {
  for (const p of SECRET_PATTERNS) {
    assert.doesNotMatch(bodyText, p.re, label + ' response body must never contain a ' + p.name);
  }
}

test('SECRET BOUNDARY: none of the 4 new WP8 endpoints ever return a secret-shaped string', async () => {
  const projectQ = 'project=' + encodeURIComponent(THIS_PROJECT_NAME);
  const endpoints = [
    '/api/files?' + projectQ + '&path=',
    '/api/files/read?' + projectQ + '&path=' + encodeURIComponent('CLAUDE.md'),
    '/api/recovery?' + projectQ,
    '/api/checkpoints?' + projectQ,
    '/api/approvals?' + projectQ + '&run=' + RUN_ID,
  ];
  for (const urlPath of endpoints) {
    const res = await request(port, urlPath);
    assert.equal(res.statusCode, 200, urlPath + ' must return 200 for this scan to be meaningful');
    assertNoSecrets(urlPath, res.body);
  }
});
