// Unit tests for the R3 fix (5s micro-cache on the Control Center health probe) in health.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealth, _resetHealthCacheForTests, _expireHealthCacheForTests, _getControlCenterProbeCallCountForTests } from '../src/health.mjs';

test('a burst of buildHealth() calls within the TTL performs exactly ONE real Control Center probe', async () => {
  _resetHealthCacheForTests();
  const first = await buildHealth(Date.now());
  assert.equal(_getControlCenterProbeCallCountForTests(), 1);
  const second = await buildHealth(Date.now());
  const third = await buildHealth(Date.now());
  assert.equal(_getControlCenterProbeCallCountForTests(), 1, 'the second and third calls must reuse the cached probe, not fire new network calls');
  assert.ok(['CONNECTED', 'DISCONNECTED', 'DEGRADED'].includes(second.forge.control_center.state));
  assert.ok(['CONNECTED', 'DISCONNECTED', 'DEGRADED'].includes(third.forge.control_center.state));
  assert.equal(typeof third.forge.control_center.age_ms, 'number');
  assert.ok(third.forge.control_center.age_ms >= second.forge.control_center.age_ms, 'age_ms must grow across cached calls');
});

test('once the 5s micro-cache expires, the next call performs a fresh probe', async () => {
  const before = _getControlCenterProbeCallCountForTests();
  _expireHealthCacheForTests();
  const result = await buildHealth(Date.now());
  assert.equal(_getControlCenterProbeCallCountForTests(), before + 1);
  assert.equal(result.forge.control_center.age_ms, 0, 'a genuinely fresh probe reports age_ms 0');
});

// P2-12 fix, part (a): /api/health now carries the SAME `execution` shape GET /api/conversations
// already returns, so a caller that only needs execution availability never has to pay
// conversations.mjs's full listConversations() cost just to read one small object.
test('buildHealth() exposes a real execution field with the same shape as GET /api/conversations', async () => {
  _resetHealthCacheForTests();
  const result = await buildHealth(Date.now());
  assert.equal(typeof result.execution, 'object');
  assert.equal(typeof result.execution.available, 'boolean');
  assert.equal(typeof result.execution.note, 'string');
});
