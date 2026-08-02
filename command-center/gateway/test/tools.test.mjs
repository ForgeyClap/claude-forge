// T6.4 tests — buildToolsInventory() against THIS project's real .claude/forge-bin/ directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolsInventory, _resetToolsCacheForTests } from '../src/tools.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';

test('buildToolsInventory finds the real forge-bin tool scripts, excluding *.test.cjs files themselves', () => {
  _resetToolsCacheForTests();
  const result = buildToolsInventory(PROJECT_ROOT);
  assert.equal(result.ok, true);
  assert.ok(result.tools_count >= 60, 'this project has 70+ real forge-bin/*.cjs tool scripts');
  assert.ok(!result.tools.some((t) => t.name.endsWith('.test.cjs')), 'test files must never appear as tools themselves');
});

test('a known real tool with a real matching test file reports has_test:true', () => {
  _resetToolsCacheForTests();
  const result = buildToolsInventory(PROJECT_ROOT);
  const capabilities = result.tools.find((t) => t.name === 'forge-capabilities.cjs');
  assert.ok(capabilities, 'forge-capabilities.cjs must be listed');
  assert.equal(capabilities.has_test, true);
  assert.ok(typeof capabilities.size === 'number' && capabilities.size > 0);
  assert.ok(typeof capabilities.mtime === 'string');
});

test('the 60s cache is reused across a repeat call within the TTL', () => {
  _resetToolsCacheForTests();
  const first = buildToolsInventory(PROJECT_ROOT);
  const second = buildToolsInventory(PROJECT_ROOT, Date.now() + 1000);
  assert.equal(second.captured_at, first.captured_at); // same underlying compute, never re-run
  assert.ok(second.age_ms >= 900 && second.age_ms <= 1100, 'age_ms reflects ~1000ms elapsed since the real compute');
});

test('an unreadable forge-bin directory is reported as an honest empty inventory, not a crash', () => {
  _resetToolsCacheForTests();
  const result = buildToolsInventory('Z:\\definitely-not-a-real-drive-path-for-this-test');
  assert.equal(result.ok, true);
  assert.equal(result.tools_count, 0);
  assert.ok(typeof result.note === 'string');
});
