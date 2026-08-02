// WP10 F4/F5 (Codex bounded-cache hardening, cheap parts): tools.mjs and capabilities.mjs each
// cache one entry per distinct project path with no prior cap — this proves the new FIFO eviction
// keeps the in-memory Map bounded no matter how many distinct project paths are probed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildToolsInventory,
  _resetToolsCacheForTests,
  _toolsCacheSizeForTests,
  _TOOLS_MAX_CACHE_ENTRIES_FOR_TESTS,
} from '../src/tools.mjs';
import {
  buildCapabilities,
  _resetCapabilitiesCacheForTests,
  _capabilitiesCacheSizeForTests,
  _CAPABILITIES_MAX_CACHE_ENTRIES_FOR_TESTS,
} from '../src/capabilities.mjs';

test('F4 SECURITY: buildToolsInventory never grows its cache past the hard cap, even with many distinct project paths', () => {
  _resetToolsCacheForTests();
  const overflow = 25;
  for (let i = 0; i < _TOOLS_MAX_CACHE_ENTRIES_FOR_TESTS + overflow; i++) {
    // Each call uses a genuinely distinct, non-existent project path — computeTools() degrades
    // honestly (forge-bin directory not readable) rather than throwing, so this stays cheap.
    buildToolsInventory('Z:/does-not-exist/fake-project-' + i);
  }
  assert.ok(_toolsCacheSizeForTests() <= _TOOLS_MAX_CACHE_ENTRIES_FOR_TESTS, 'cache size must never exceed the hard cap');
  assert.ok(_toolsCacheSizeForTests() > 0, 'the cap must not evict everything either');
  _resetToolsCacheForTests();
});

test('F4: an existing project\'s cache entry survives being re-queried (no self-eviction on a repeat call)', () => {
  _resetToolsCacheForTests();
  const first = buildToolsInventory('Z:/does-not-exist/fake-project-repeat');
  const second = buildToolsInventory('Z:/does-not-exist/fake-project-repeat');
  assert.equal(second.captured_at, first.captured_at, 'a fresh cache hit must reuse the same computed value, not evict+recompute');
  _resetToolsCacheForTests();
});

test('F5 SECURITY: buildCapabilities never grows its cache past the hard cap, even with many distinct project paths', async () => {
  _resetCapabilitiesCacheForTests();
  const overflow = 15;
  for (let i = 0; i < _CAPABILITIES_MAX_CACHE_ENTRIES_FOR_TESTS + overflow; i++) {
    // A non-existent project path resolves to a fast, honest UNAVAILABLE (no forge-capabilities.cjs
    // found) — no real spawn happens, so this loop stays cheap even at 100+ iterations.
    // eslint-disable-next-line no-await-in-loop
    await buildCapabilities('Z:/does-not-exist/fake-caps-project-' + i);
  }
  assert.ok(_capabilitiesCacheSizeForTests() <= _CAPABILITIES_MAX_CACHE_ENTRIES_FOR_TESTS, 'cache size must never exceed the hard cap');
  assert.ok(_capabilitiesCacheSizeForTests() > 0, 'the cap must not evict everything either');
  _resetCapabilitiesCacheForTests();
});
