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
import { needsRunEvents, needsRunArtifacts, needsDoctorReceipt, needsArtifactsIndex, needsAll } from './.real-data-guard.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
const RUN_ID = 'forge-2026-07-26-command-center';
const FULL_AUDIT_RUN_ID = 'forge-2026-07-25-full-audit';

// Only the four assertions that read this project's real run data are guarded. Every security /
// rejection / shape test in this file stays unconditional — those exercise gateway logic, not the
// environment, and must run everywhere.
const NEEDS_RUN_EVENTS = needsRunEvents(RUN_ID);
const NEEDS_AUDIT_PROOF = needsAll(needsDoctorReceipt(FULL_AUDIT_RUN_ID), needsArtifactsIndex());
const NEEDS_AUDIT_ARTIFACTS = needsRunArtifacts(FULL_AUDIT_RUN_ID);

let server;
let port;
let usageTempDir;
const ABSENT_PRESSURE_PATH_INIT = () => path.join(usageTempDir, 'does-not-exist-pressure.json');
const ABSENT_GUARD_PATH_INIT = () => path.join(usageTempDir, 'does-not-exist-guard.json');

// Hermetic-by-default (2026-09-24, loop wp-l1): GET /api/models runs the SAME real nvidia-provider.cjs
// health probe as models.test.mjs (see that file's own comment) — the server here runs IN-PROCESS, so a
// child spawned by its route handler inherits THIS process's env. Force a hermetic child env for the
// whole file by default (no dotenv-file loading, no key); set FORGE_GATEWAY_LIVE_NVIDIA=1 to opt into the
// real, live-network variant instead. Never changes what the /api/models test asserts about response shape.
const LIVE_NVIDIA = process.env.FORGE_GATEWAY_LIVE_NVIDIA === '1';
const HERMETIC_NVIDIA_ENV_NAMES = ['NVIDIA_API_KEY', 'NVIDIA_SKIP_ENV_FILES'];
let savedNvidiaEnv = null;

before(async () => {
  _resetProjectsCacheForTests();
  if (!LIVE_NVIDIA) {
    savedNvidiaEnv = Object.fromEntries(HERMETIC_NVIDIA_ENV_NAMES.map((k) => [k, process.env[k]]));
    process.env.NVIDIA_API_KEY = '';
    process.env.NVIDIA_SKIP_ENV_FILES = '1';
  }
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
  if (savedNvidiaEnv) { for (const [k, v] of Object.entries(savedNvidiaEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
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

test('GET /api/missions returns this run\'s real derived mission state', { skip: NEEDS_RUN_EVENTS }, async () => {
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
  assert.ok(['CONNECTED', 'DISCONNECTED', 'NOT CONFIGURED', 'OFF', 'UNKNOWN'].includes(res.json.nvidia.state));
});

test('GET /api/proof returns the real evidence chain for the full-audit run (2 registered artifacts)', { skip: NEEDS_AUDIT_PROOF }, async () => {
  const res = await request(port, '/api/proof?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=' + FULL_AUDIT_RUN_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.report_present, true);
  assert.equal(res.json.doctor_present, true);
  const storeArtifacts = res.json.artifacts.filter((a) => a.source === 'forge-artifacts-index');
  assert.equal(storeArtifacts.length, 2);
});

// cc-fix-artifacts-empty: the one HTTP-level wiring test — buildProofAll() itself is covered in
// depth (aggregation, labels, bound) by proof-all.test.mjs's own dedicated unit tests.
test('GET /api/proof?run=all is wired to buildProofAll: aggregate list with the window-independent index entries present', { skip: NEEDS_AUDIT_ARTIFACTS }, async () => {
  // The run-dir scan is bounded to the 10 newest runs BY DESIGN (owner bound in buildProofAll) — as
  // real missions land, the full-audit fixture run ages out of that window, so this wiring test may
  // not demand its label here (that labelling logic has its own wide-window unit tests in
  // proof-all.test.mjs). What IS window-independent: the forge-artifacts index is always read in
  // full, so its real entries must be present in the aggregate.
  const res = await request(port, '/api/proof?project=' + encodeURIComponent(THIS_PROJECT_NAME) + '&run=all');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.run_id, 'all');
  assert.ok(Array.isArray(res.json.artifacts));
  const indexArtifacts = res.json.artifacts.filter((a) => a.source === 'forge-artifacts-index');
  assert.ok(indexArtifacts.length > 0, 'the always-read forge-artifacts-index entries must be present in the aggregate');
  assert.ok(indexArtifacts.some((a) => a.id === 'wp0-audit-reports'), 'the real wp0-audit-reports index entry must be present');
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

test('GET /api/events/stream connects and replays this run\'s real backlog as SSE frames', { skip: NEEDS_RUN_EVENTS }, async () => {
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
