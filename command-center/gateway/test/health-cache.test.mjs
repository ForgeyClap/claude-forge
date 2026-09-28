// Unit tests for gateway/src/health.mjs's forge.control_center field.
//
// WP-N2 (Forge 2.9.0): this file used to test the R3 fix — a 5s micro-cache on a real network
// probe of the (now-removed) per-project Control Center. That server was retired from Forge
// entirely, so the probe and its cache went with it: `forge.control_center` is now a fixed,
// honest RETIRED note, never a network call, never stale, never anything to expire. These tests
// verify that fixed shape instead, plus the still-real `execution` field this file always tested
// alongside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealth } from '../src/health.mjs';

test('forge.control_center reports a fixed RETIRED state with no network probe', async () => {
  const result = await buildHealth(Date.now());
  assert.equal(result.forge.control_center.state, 'RETIRED');
  assert.equal(typeof result.forge.control_center.note, 'string');
  assert.ok(result.forge.control_center.note.length > 0, 'the note must actually explain what RETIRED means');
});

test('forge.control_center is stable across repeated calls (no cache, no drift — it is a constant)', async () => {
  const first = await buildHealth(Date.now());
  const second = await buildHealth(Date.now());
  assert.deepEqual(first.forge.control_center, second.forge.control_center);
});

// P2-12 fix, part (a): /api/health now carries the SAME `execution` shape GET /api/conversations
// already returns, so a caller that only needs execution availability never has to pay
// conversations.mjs's full listConversations() cost just to read one small object.
test('buildHealth() exposes a real execution field with the same shape as GET /api/conversations', async () => {
  const result = await buildHealth(Date.now());
  assert.equal(typeof result.execution, 'object');
  assert.equal(typeof result.execution.available, 'boolean');
  assert.equal(typeof result.execution.note, 'string');
});
