// T3.6 tests — buildModelsView() against the real model-capability-matrix.json + a real (or
// honestly-degraded) NVIDIA health probe. The NVIDIA state assertion is deliberately tolerant of
// live flakiness (this project's own matrix file documents the endpoint flip-flopping over time)
// — the automated suite checks the SHAPE and truthful-state vocabulary, never hard-asserts
// CONNECTED; the live curl proof in the work-package report is where the real state is quoted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildModelsView, _resetNvidiaHealthCacheForTests, _setNvidiaProviderCjsForTests, _parseNvidiaHealthOutputForTests,
} from '../src/models.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';

// Hermetic-by-default (2026-09-24, loop wp-l1): buildModelsView() spawns the REAL nvidia-provider.cjs
// child, which inherits process.env unless told otherwise. On a machine with a real NVIDIA_API_KEY
// configured (and NVIDIA_SKIP_ENV_FILES unset), the two tests below would make one REAL network call to
// NVIDIA on every run. Force a hermetic child env by default (no dotenv-file loading, no key — the exact
// seam nvidia-provider.cjs already documents for hermetic test isolation); set FORGE_GATEWAY_LIVE_NVIDIA=1
// to opt into the real, live-network variant instead. This never changes what either test asserts about
// the response SHAPE — both already tolerate every truthful nvidia.state, live or not.
const LIVE_NVIDIA = process.env.FORGE_GATEWAY_LIVE_NVIDIA === '1';
const HERMETIC_NVIDIA_ENV_NAMES = ['NVIDIA_API_KEY', 'NVIDIA_SKIP_ENV_FILES'];
async function withHermeticNvidiaEnv(fn) {
  if (LIVE_NVIDIA) return fn();
  const saved = Object.fromEntries(HERMETIC_NVIDIA_ENV_NAMES.map((k) => [k, process.env[k]]));
  process.env.NVIDIA_API_KEY = '';
  process.env.NVIDIA_SKIP_ENV_FILES = '1';
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('buildModelsView reads the real capability matrix and returns a truthful nvidia health state', async () => {
  await withHermeticNvidiaEnv(async () => {
    _resetNvidiaHealthCacheForTests();
    const result = await buildModelsView();
    assert.equal(result.ok, true);
    assert.equal(result.matrix_available, true);
    // 2026-09-24: the default role model is re-validated against the live NVIDIA catalog and changes when a model reaches
    // end-of-life (nemotron-3-nano-30b-a3b returned HTTP 410 that day). Pin the matrix FILE as the source of truth, not a literal.
    const matrix = JSON.parse(readFileSync(path.join(PROJECT_ROOT, '.claude', 'config', 'models', 'model-capability-matrix.json'), 'utf8'));
    const expectedDefault = typeof matrix.roles.default === 'string' ? matrix.roles.default : matrix.roles.default.model;
    assert.equal(result.roles.default.model, expectedDefault);
    assert.ok(Array.isArray(result.catalog) && result.catalog.length >= 6);
    assert.ok(['CONNECTED', 'DISCONNECTED', 'NOT CONFIGURED', 'OFF', 'UNKNOWN'].includes(result.nvidia.state));
    assert.equal(typeof result.nvidia.age_ms, 'number');
    assert.ok(result.latest_verified_date === null || /^\d{4}-\d{2}-\d{2}$/.test(result.latest_verified_date));
  });
});

test('the 60s nvidia health cache is reused across a repeat call', async () => {
  await withHermeticNvidiaEnv(async () => {
    const first = await buildModelsView();
    const second = await buildModelsView();
    assert.equal(second.nvidia.state, first.nvidia.state);
    assert.ok(second.nvidia.age_ms >= first.nvidia.age_ms);
  });
});

// wp20 M4: the owner's `nvidia` setting OFF must reach the dashboard as its own truthful state, never as a
// failed connection — and the probe must not send anything.
test('an "NVIDIA OFF — ..." health line parses to state OFF (not DISCONNECTED/UNKNOWN)', () => {
  const parsed = _parseNvidiaHealthOutputForTests('NVIDIA OFF — owner config nvidia=off — no NVIDIA request made (check anyway: --force; turn it back on: /forge config set nvidia aan)\n');
  assert.equal(parsed.state, 'OFF');
  assert.match(parsed.note, /^NVIDIA OFF — owner config nvidia=off/);
});

test('a health probe that exits 3 with the OFF line is reported as OFF (fixture script)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-models-off-'));
  try {
    const fixture = path.join(dir, 'fake-nvidia-provider.cjs');
    writeFileSync(fixture, "console.log('NVIDIA OFF — config unreadable → safe default off — no NVIDIA request made'); process.exit(3);\n", 'utf8');
    _setNvidiaProviderCjsForTests(fixture);
    _resetNvidiaHealthCacheForTests();
    const result = await buildModelsView();
    assert.equal(result.nvidia.state, 'OFF');
    assert.match(result.nvidia.note, /config unreadable → safe default off/);
  } finally {
    _setNvidiaProviderCjsForTests(null);
    _resetNvidiaHealthCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

// wp-l4 (2026-09-24, loop iteration 4): a MOCK MODE health line (no NVIDIA_API_KEY) exits 1, the SAME exit
// code a real "NVIDIA FAIL" (key present, live call failed) uses — exit code alone cannot tell them apart.
// "no key configured" must reach the dashboard as NOT CONFIGURED, never DISCONNECTED (that state stays
// reserved for a genuine network/HTTP failure against a configured key).
test('a health probe that exits 1 with the MOCK MODE line is reported as NOT CONFIGURED (not DISCONNECTED)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-models-mock-'));
  try {
    const fixture = path.join(dir, 'fake-nvidia-provider.cjs');
    writeFileSync(fixture, "console.log('NVIDIA MOCK MODE (no key — NOT live-ready) — no NVIDIA_API_KEY configured'); process.exit(1);\n", 'utf8');
    _setNvidiaProviderCjsForTests(fixture);
    _resetNvidiaHealthCacheForTests();
    const result = await buildModelsView();
    assert.equal(result.nvidia.state, 'NOT CONFIGURED', JSON.stringify(result.nvidia));
    assert.match(result.nvidia.note, /^NVIDIA MOCK MODE/);
  } finally {
    _setNvidiaProviderCjsForTests(null);
    _resetNvidiaHealthCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A real failure (key present, live call failed) still exits 1 but prints "NVIDIA FAIL — ..." — must stay
// DISCONNECTED, proving the MOCK MODE fix above did not widen to swallow genuine failures too.
test('a health probe that exits 1 with an "NVIDIA FAIL — ..." line stays DISCONNECTED (not NOT CONFIGURED)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-models-fail-'));
  try {
    const fixture = path.join(dir, 'fake-nvidia-provider.cjs');
    writeFileSync(fixture, "console.log('NVIDIA FAIL — connect ECONNREFUSED 127.0.0.1:9'); process.exit(1);\n", 'utf8');
    _setNvidiaProviderCjsForTests(fixture);
    _resetNvidiaHealthCacheForTests();
    const result = await buildModelsView();
    assert.equal(result.nvidia.state, 'DISCONNECTED', JSON.stringify(result.nvidia));
  } finally {
    _setNvidiaProviderCjsForTests(null);
    _resetNvidiaHealthCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SECURITY: with nvidia=false the REAL provider CLI reports OFF and sends nothing, even with a key and a reachable-looking endpoint', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-models-offcfg-'));
  const names = ['FORGE_PROJECT_ROOT', 'FORGE_CONFIG_HOME', 'NVIDIA_API_KEY', 'NVIDIA_BASE_URL', 'NVIDIA_ALLOW_CUSTOM_BASE_URL', 'NVIDIA_SKIP_ENV_FILES'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    mkdirSync(path.join(dir, 'project', '.claude'), { recursive: true });
    mkdirSync(path.join(dir, 'home'), { recursive: true });
    writeFileSync(path.join(dir, 'project', '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { nvidia: { value: false } } }));
    // Any request would go to the discard port and fail loudly (FAIL / timeout) — OFF proves none was attempted.
    Object.assign(process.env, {
      FORGE_PROJECT_ROOT: path.join(dir, 'project'), FORGE_CONFIG_HOME: path.join(dir, 'home'),
      NVIDIA_API_KEY: 'nvapi-FAKEwp20modelsKEY0123456789', NVIDIA_BASE_URL: 'http://127.0.0.1:9/v1',
      NVIDIA_ALLOW_CUSTOM_BASE_URL: '1', NVIDIA_SKIP_ENV_FILES: '1',
    });
    _setNvidiaProviderCjsForTests(null);
    _resetNvidiaHealthCacheForTests();
    const t0 = Date.now();
    const result = await buildModelsView();
    assert.equal(result.nvidia.state, 'OFF', JSON.stringify(result.nvidia));
    assert.match(result.nvidia.note, /^NVIDIA OFF — owner config nvidia=off — no NVIDIA request made/);
    assert.ok(Date.now() - t0 < 4000, 'no retry/backoff happened (a request to the discard port would retry for ~4.5 s)');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _resetNvidiaHealthCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
