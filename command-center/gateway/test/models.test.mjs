// T3.6 tests — buildModelsView() against the real model-capability-matrix.json + a real (or
// honestly-degraded) NVIDIA health probe. The NVIDIA state assertion is deliberately tolerant of
// live flakiness (this project's own matrix file documents the endpoint flip-flopping over time)
// — the automated suite checks the SHAPE and truthful-state vocabulary, never hard-asserts
// CONNECTED; the live curl proof in the work-package report is where the real state is quoted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelsView, _resetNvidiaHealthCacheForTests } from '../src/models.mjs';

test('buildModelsView reads the real capability matrix and returns a truthful nvidia health state', async () => {
  _resetNvidiaHealthCacheForTests();
  const result = await buildModelsView();
  assert.equal(result.ok, true);
  assert.equal(result.matrix_available, true);
  assert.equal(result.roles.default.model, 'nvidia/nemotron-3-nano-30b-a3b');
  assert.ok(Array.isArray(result.catalog) && result.catalog.length >= 6);
  assert.ok(['CONNECTED', 'DISCONNECTED', 'NOT CONFIGURED', 'UNKNOWN'].includes(result.nvidia.state));
  assert.equal(typeof result.nvidia.age_ms, 'number');
  assert.ok(result.latest_verified_date === null || /^\d{4}-\d{2}-\d{2}$/.test(result.latest_verified_date));
});

test('the 60s nvidia health cache is reused across a repeat call', async () => {
  const first = await buildModelsView();
  const second = await buildModelsView();
  assert.equal(second.nvidia.state, first.nvidia.state);
  assert.ok(second.nvidia.age_ms >= first.nvidia.age_ms);
});
