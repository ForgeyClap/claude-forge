// Unit tests for exec-argv.mjs's feat-ask-owner additions (forge-2026-07-30-cc-finish): the
// per-execution --mcp-config file + argv wiring. ALWAYS asserted directly against the real
// argv-building/config-writing functions — no real `claude` CLI invocation anywhere in this file
// (mirrors exec-bridge.test.mjs's own MODE/EFFORT/MODEL tests, which assert `_buildRealArgsForTests`
// directly rather than spawning a real child).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSpawnSpec,
  _buildAskMcpConfigObjectForTests,
  _setAskMcpConfigDirForTests,
} from '../src/exec-argv.mjs';
import { getExecToken } from '../src/security.mjs';
import { FORGE_LEAD_PREAMBLE } from '../src/forge-preamble.mjs';

let tempDir;
let savedMock;
let savedOverride;

before(() => {
  savedMock = process.env.CC_EXEC_MOCK;
  savedOverride = process.env.CC_CLAUDE_CLI_PATH;
  delete process.env.CC_EXEC_MOCK; // exercise the REAL (non-mock) branch of buildSpawnSpec
  // A real, absolute, existing path outside this test's own cwd — resolveClaudeCliPath()'s own
  // cwd-shadow guard (exec-cli.mjs) only rejects a candidate living UNDER the current cwd; Node's
  // own binary satisfies that trivially and needs no real `claude` install on this machine.
  process.env.CC_CLAUDE_CLI_PATH = process.execPath;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ask-mcp-config-test-'));
  _setAskMcpConfigDirForTests(tempDir);
});

after(() => {
  if (savedMock !== undefined) process.env.CC_EXEC_MOCK = savedMock; else delete process.env.CC_EXEC_MOCK;
  if (savedOverride !== undefined) process.env.CC_CLAUDE_CLI_PATH = savedOverride; else delete process.env.CC_CLAUDE_CLI_PATH;
  _setAskMcpConfigDirForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tempDir)) fs.rmSync(path.join(tempDir, f));
});

test('_buildAskMcpConfigObjectForTests builds a real mcpServers config carrying THIS execution\'s own conv/turn/request id and the current-boot exec token', () => {
  const config = _buildAskMcpConfigObjectForTests({ convId: 'c-1', turnId: 't-1', requestId: 'req-1' });
  assert.ok(config.mcpServers['forge-ask']);
  const server = config.mcpServers['forge-ask'];
  assert.match(server.command, /node/i);
  assert.equal(server.args.length, 1);
  assert.match(server.args[0], /ask-mcp\.mjs$/);
  assert.equal(server.env.CC_ASK_CONV_ID, 'c-1');
  assert.equal(server.env.CC_ASK_TURN_ID, 't-1');
  assert.equal(server.env.CC_ASK_REQUEST_ID, 'req-1');
  assert.equal(server.env.CC_ASK_GATEWAY_ORIGIN, 'http://127.0.0.1:4100');
  assert.equal(server.env.CC_ASK_EXEC_TOKEN, getExecToken());
});

test('MCP WIRING: buildSpawnSpec with an askContext appends EXACTLY --mcp-config <realfile> --strict-mcp-config, and NEVER --allowed-tools/--disallowedTools', () => {
  const spec = buildSpawnSpec('hello', 'execute', undefined, undefined, { convId: 'c-1', turnId: 't-1', requestId: 'req-1' });
  assert.ok(spec.askMcpConfigPath, 'a real config file path must be returned so the caller can clean it up later');
  assert.ok(fs.existsSync(spec.askMcpConfigPath), 'the config file must actually have been written to disk');

  const idx = spec.args.indexOf('--mcp-config');
  assert.ok(idx > -1, '--mcp-config must be present');
  assert.equal(spec.args[idx + 1], spec.askMcpConfigPath);
  assert.ok(spec.args.includes('--strict-mcp-config'), '--strict-mcp-config must be present');

  // 2026-07-30 coordinator correction — see exec-argv.mjs's own header comment for the full
  // real-run evidence this regression guard protects: --allowed-tools silently starves every
  // OTHER built-in tool while the model can still claim success.
  assert.ok(!spec.args.includes('--allowed-tools'), 'MUST NEVER add --allowed-tools alongside the ask-mcp config');
  assert.ok(!spec.args.includes('--disallowedTools'), 'MUST NEVER add --disallowedTools alongside the ask-mcp config');
  assert.ok(!spec.args.some((a) => typeof a === 'string' && /allow.?tool/i.test(a)), 'no argv token of any casing/shape resembling an allowed-tools flag may appear');

  const written = JSON.parse(fs.readFileSync(spec.askMcpConfigPath, 'utf8'));
  assert.equal(written.mcpServers['forge-ask'].env.CC_ASK_CONV_ID, 'c-1');
});

test('MCP WIRING: the base argv (mode/effort/model flags + the feat-forge-preamble --append-system-prompt flag) is preserved unchanged in front of the new --mcp-config flags', () => {
  const spec = buildSpawnSpec('hello', 'bypass', 'max', 'claude-fable-5', { convId: 'c-1', turnId: 't-1', requestId: 'req-1' });
  const mcpIdx = spec.args.indexOf('--mcp-config');
  const baseArgs = spec.args.slice(0, mcpIdx);
  assert.deepEqual(baseArgs, [
    '-p', 'hello', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--effort', 'max',
    '--model', 'claude-fable-5',
    '--append-system-prompt', FORGE_LEAD_PREAMBLE,
  ]);
});

test('REGRESSION: buildSpawnSpec with NO askContext never adds --mcp-config/--strict-mcp-config at all (unaffected baseline)', () => {
  const spec = buildSpawnSpec('hello', 'execute', undefined, undefined);
  assert.ok(!spec.args.includes('--mcp-config'));
  assert.ok(!spec.args.includes('--strict-mcp-config'));
  assert.equal(spec.askMcpConfigPath, undefined);
});

test('MOCK MODE: buildSpawnSpec in mock mode (CC_EXEC_MOCK=1) ignores askContext entirely — no config file is ever written', () => {
  process.env.CC_EXEC_MOCK = '1';
  try {
    const before = fs.readdirSync(tempDir).length;
    const spec = buildSpawnSpec('hello', 'execute', undefined, undefined, { convId: 'c-1', turnId: 't-1', requestId: 'req-1' });
    assert.equal(spec.cmd, process.execPath);
    assert.ok(!('askMcpConfigPath' in spec) || spec.askMcpConfigPath === undefined);
    assert.equal(fs.readdirSync(tempDir).length, before, 'mock mode must never write an ask-mcp config file');
  } finally {
    delete process.env.CC_EXEC_MOCK;
  }
});

test('a fresh config file is written per call (never reused/overwritten across two executions)', () => {
  const specA = buildSpawnSpec('a', 'execute', undefined, undefined, { convId: 'c-1', turnId: 't-a', requestId: 'req-a' });
  const specB = buildSpawnSpec('b', 'execute', undefined, undefined, { convId: 'c-1', turnId: 't-b', requestId: 'req-b' });
  assert.notEqual(specA.askMcpConfigPath, specB.askMcpConfigPath);
  assert.ok(fs.existsSync(specA.askMcpConfigPath));
  assert.ok(fs.existsSync(specB.askMcpConfigPath));
});
