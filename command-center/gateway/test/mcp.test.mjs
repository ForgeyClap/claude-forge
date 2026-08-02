// T6.4 tests — buildMcpView() against THIS project's real mcp-registry.json + mcp-grants.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpView } from '../src/mcp.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';

test('buildMcpView reads the real 8-server dormant MCP registry', () => {
  const result = buildMcpView(PROJECT_ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.registry_present, true);
  assert.equal(result.grants_present, true);
  assert.equal(result.servers_count, 8);
});

test('every real server is honestly reported as NOT installed and NOT opted in (no mcp-opt-in.json ships with this project)', () => {
  const result = buildMcpView(PROJECT_ROOT);
  assert.equal(result.opt_in_file_present, false);
  assert.ok(result.servers.every((s) => s.status === 'not-installed'));
  assert.ok(result.servers.every((s) => s.opted_in === false));
  assert.equal(result.installed_count, 0);
  assert.equal(result.opted_in_count, 0);
});

test('a known real server (github-write) is reported as tier 3 with credentials_needed', () => {
  const result = buildMcpView(PROJECT_ROOT);
  const githubWrite = result.servers.find((s) => s.id === 'github-write');
  assert.ok(githubWrite);
  assert.equal(githubWrite.tier, 3);
  assert.equal(githubWrite.credentials_needed, true);
});

test('the real per-Boss grants matrix is included (build-boss has no MCP write access)', () => {
  const result = buildMcpView(PROJECT_ROOT);
  const buildBossGrant = result.boss_grants.find((g) => g.slug === 'build-boss');
  assert.ok(buildBossGrant);
  assert.equal(buildBossGrant.max_tier, 0);
  assert.ok(!buildBossGrant.allow_servers.includes('github-write'));
});
