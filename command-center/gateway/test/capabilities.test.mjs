// T6.6 tests — buildCapabilities() against THIS project's real forge-capabilities.cjs (the ONE
// allowlisted spawn this WP is permitted), plus its stale-while-revalidate cache and the truthful
// UNAVAILABLE path for a project with no forge-bin/forge-capabilities.cjs at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildCapabilities,
  _resetCapabilitiesCacheForTests,
  _expireCapabilitiesCacheForTests,
  _awaitCapabilitiesRefreshForTests,
} from '../src/capabilities.mjs';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

test('buildCapabilities runs the real report against this project and returns real capabilities + summary', async () => {
  _resetCapabilitiesCacheForTests();
  const result = await buildCapabilities(PROJECT_ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.state, 'OK');
  assert.ok(result.capabilities.length >= 100, 'this project has 100+ real tool/skill/gate capabilities');
  assert.ok(result.summary && typeof result.summary.total === 'number');
  assert.equal(result.provenance, 'DERIVED');
  assert.equal(result.age_ms, 0);
});

test('a 10-minute cache hit is reused within the TTL (no second spawn)', async () => {
  _resetCapabilitiesCacheForTests();
  const first = await buildCapabilities(PROJECT_ROOT);
  const second = await buildCapabilities(PROJECT_ROOT, Date.now() + 5000);
  assert.equal(second.captured_at, first.captured_at);
  assert.equal(second.provenance, 'DERIVED');
  assert.ok(second.age_ms >= 5000);
});

test('an expired cache serves the stale value immediately (STALE) then refreshes in the background', async () => {
  _resetCapabilitiesCacheForTests();
  const first = await buildCapabilities(PROJECT_ROOT);
  _expireCapabilitiesCacheForTests(PROJECT_ROOT);
  const stale = await buildCapabilities(PROJECT_ROOT);
  assert.equal(stale.provenance, 'STALE');
  assert.equal(stale.captured_at, first.captured_at); // still the OLD value, never fabricated as fresh
  await _awaitCapabilitiesRefreshForTests(PROJECT_ROOT);
  const fresh = await buildCapabilities(PROJECT_ROOT);
  assert.equal(fresh.provenance, 'DERIVED');
});

test('a concurrent call during an in-flight background refresh reuses it (CACHED)', async () => {
  _resetCapabilitiesCacheForTests();
  await buildCapabilities(PROJECT_ROOT);
  _expireCapabilitiesCacheForTests(PROJECT_ROOT);
  const a = await buildCapabilities(PROJECT_ROOT);
  assert.equal(a.provenance, 'STALE');
  const b = await buildCapabilities(PROJECT_ROOT);
  assert.equal(b.provenance, 'CACHED');
  await _awaitCapabilitiesRefreshForTests(PROJECT_ROOT);
});

test('a project with no forge-capabilities.cjs reports a truthful UNAVAILABLE state, never fake data', async () => {
  _resetCapabilitiesCacheForTests();
  const fakeProjectPath = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-caps', 'no-forge-bin-here');
  const result = await buildCapabilities(fakeProjectPath);
  assert.equal(result.ok, true);
  assert.equal(result.available, false);
  assert.equal(result.state, 'UNAVAILABLE');
  assert.ok(typeof result.note === 'string' && result.note.length > 0);
  assert.deepEqual(result.capabilities, []);
  assert.equal(result.summary, null);
});
