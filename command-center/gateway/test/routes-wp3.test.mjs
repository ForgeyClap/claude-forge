// HTTP-level integration tests for the 6 new WP3 JSON endpoints + the SSE route, against a real
// instance of the gateway bound to an ephemeral port — same pattern as the existing
// gateway.test.mjs (which is left untouched; it is itself the regression proof for the original
// 4 endpoints).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _setUsagePressureFileForTests, _setUsageGuardStateFileForTests } from '../src/usage.mjs';
import { request } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
const RUN_ID = 'forge-2026-07-26-command-center';
const FULL_AUDIT_RUN_ID = 'forge-2026-07-25-full-audit';

let server;
let port;
let usageTempDir;
const ABSENT_PRESSURE_PATH_INIT = () => path.join(usageTempDir, 'does-not-exist-pressure.json');
const ABSENT_GUARD_PATH_INIT = () => path.join(usageTempDir, 'does-not-exist-guard.json');

before(async () => {
  _resetProjectsCacheForTests();
  // fix-test-hygiene: GET /api/usage must not depend on whatever this machine's real
  // ~/.claude/FORGE_USAGE_PRESSURE.json happens to contain right now — point buildUsage() at an
  // isolated, test-owned fixture dir by default (a real-but-empty temp dir, both files initially
  // absent) via its own test-only override seam; see usage.test.mjs for the deeper unit coverage
  // of both branches.
  usageTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-routes-wp3-usage-test-'));
  _setUsagePressureFileForTests(ABSENT_PRESSURE_PATH_INIT());
  _setUsageGuardStateFileForTests(ABSENT_GUARD_PATH_INIT());
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(usageTempDir, { recursive: true, force: true });
});

function requestStream(urlPath, { headers = {}, readMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      const timer = setTimeout(() => { req.destroy(); resolve({ statusCode: res.statusCode, headers: res.headers, body }); }, readMs);
      res.on('end', () => { clearTimeout(timer); resolve({ statusCode: res.statusCode, headers: res.headers, body }); });
    });
    req.on('error', () => resolve({ statusCode: null, headers: {}, body: '', aborted: true }));
    req.end();
  });
}

test('GET /api/missions returns this run\'s real derived mission state', async () => {
  const res = await request(port, '/api/missions?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=' + RUN_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.wps.length >= 1);
  assert.ok(res.json.tasks.some((t) => t.role === 'cc-wp3-gateway'));
});

test('GET /api/agents returns the real 19-agent registry', async () => {
  const res = await request(port, '/api/agents?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.total_agents, 19);
  assert.equal(res.json.permanent_boss_count, 12);
});

test('GET /api/skills returns the real skill catalog + registry table', async () => {
  const res = await request(port, '/api/skills?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.ok(res.json.skills_count >= 40);
  assert.equal(res.json.registry_present, true);
});

test('GET /api/models returns the real capability matrix + a truthful nvidia state', async () => {
  const res = await request(port, '/api/models');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.matrix_available, true);
  assert.ok(['CONNECTED', 'DISCONNECTED', 'NOT CONFIGURED', 'UNKNOWN'].includes(res.json.nvidia.state));
});

test('GET /api/proof returns the real evidence chain for the full-audit run (2 registered artifacts)', async () => {
  const res = await request(port, '/api/proof?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=' + FULL_AUDIT_RUN_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.report_present, true);
  assert.equal(res.json.doctor_present, true);
  const storeArtifacts = res.json.artifacts.filter((a) => a.source === 'forge-artifacts-index');
  assert.equal(storeArtifacts.length, 2);
});

// cc-fix-artifacts-empty: the one HTTP-level wiring test — buildProofAll() itself is covered in
// depth (aggregation, labels, bound) by proof-all.test.mjs's own dedicated unit tests.
test('GET /api/proof?run=all returns a real project-wide artifact list, including one from an older run than the newest', async () => {
  const res = await request(port, '/api/proof?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=all');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.run_id, 'all');
  const fromOlderRun = res.json.artifacts.filter((a) => a.run_id === FULL_AUDIT_RUN_ID);
  assert.ok(fromOlderRun.length > 0, 'the full-audit run\'s real artifacts must be present in the aggregate');
});

// fix-test-hygiene: both real branches of GET /api/usage are now driven explicitly via the
// isolated fixture dir set up in before() — never the real, machine-owned usage-pressure file
// (see usage.test.mjs for the deeper unit-level coverage of buildUsage() itself).
test('GET /api/usage: fixture file present -> real REPORTED snapshot with the exact values written to it', async () => {
  const pressurePath = path.join(usageTempDir, 'present-pressure.json');
  fs.writeFileSync(pressurePath, JSON.stringify({ level: 'high', week: 7, updated_at: new Date().toISOString() }), 'utf8');
  _setUsagePressureFileForTests(pressurePath);
  try {
    const res = await request(port, '/api/usage');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.provenance, 'REPORTED');
    assert.equal(res.json.level, 'high');
    assert.equal(res.json.week, 7);
  } finally {
    _setUsagePressureFileForTests(ABSENT_PRESSURE_PATH_INIT());
  }
});

test('GET /api/usage: fixture file absent -> honest NOT CONFIGURED, never a fabricated level/week', async () => {
  _setUsagePressureFileForTests(ABSENT_PRESSURE_PATH_INIT());
  const res = await request(port, '/api/usage');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.provenance, 'NOT CONFIGURED');
  assert.equal(res.json.level, undefined);
  assert.equal(res.json.week, undefined);
});

test('SECURITY: /api/missions with an unknown project never reaches the filesystem', async () => {
  const res = await request(port, '/api/missions?project=totally-not-real&run=' + RUN_ID);
  assert.equal(res.statusCode, 404);
});

test('SECURITY: /api/agents with a path-traversal project name is rejected by the allowlist', async () => {
  const res = await request(port, '/api/agents?project=' + encodeURIComponent('../../'));
  assert.equal(res.statusCode, 404);
});

test('SECURITY: /api/proof with a traversal-shaped run id is rejected with 400', async () => {
  const res = await request(port, '/api/proof?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=' + encodeURIComponent('..%2F'));
  assert.equal(res.statusCode, 400);
});

test('SECURITY: /api/missions with a missing run id is rejected with 400', async () => {
  const res = await request(port, '/api/missions?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 400);
});

test('GET /api/events/stream connects and replays this run\'s real backlog as SSE frames', async () => {
  const res = await requestStream('/api/events/stream?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=' + RUN_ID);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.match(res.body, /"dispatch_id":"a0f0dbae827429bc2"/);
});

test('SECURITY: /api/events/stream with an unknown project is rejected with 404 JSON, never upgraded to SSE', async () => {
  const res = await requestStream('/api/events/stream?project=totally-not-real&run=' + RUN_ID);
  assert.equal(res.statusCode, 404);
  assert.doesNotMatch(String(res.headers['content-type'] || ''), /text\/event-stream/);
});

test('SECURITY: /api/events/stream with a traversal-shaped run id is rejected with 400', async () => {
  const res = await requestStream('/api/events/stream?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=' + encodeURIComponent('..%2F'));
  assert.equal(res.statusCode, 400);
});
