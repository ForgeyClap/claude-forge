// feat-subagent-visibility — exec-argv.mjs / exec-cli.mjs: the two REAL, help-confirmed stream
// visibility flags behind a capability-detected switch.
//
// GROUND TRUTH (measured on this machine, claude CLI v2.1.220 — `claude --help` really prints both
// of these lines verbatim; the HELP_WITH_FLAGS constant below is copied from that real output):
//   --forward-subagent-text    Forward subagent text and thinking blocks as assistant/user messages
//                              with parent_tool_use_id set (only works with --print and
//                              --output-format=stream-json)
//   --include-hook-events      Include all hook lifecycle events in the output stream (only works
//                              with --output-format=stream-json)
// The gateway already spawns with `-p` + `--output-format stream-json` + `--verbose`, so both
// preconditions genuinely hold. An OLDER CLI that documents neither flag must never receive them —
// that is what the HELP_WITHOUT_FLAGS half of every pair below proves.
//
// No real `claude` CLI is ever invoked in this file: the help text is injected through the same
// kind of test-only seam exec-argv.mjs already uses for its ask-mcp config dir, and the CLI path is
// pinned to this machine's own node binary (the exact idiom test/exec-ask-mcp-config.test.mjs
// already uses to exercise the REAL, non-mock branch of buildSpawnSpec).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSpawnSpec,
  resolveStreamVisibilityFlags,
  _buildRealArgsForTests,
  _setAskMcpConfigDirForTests,
} from '../src/exec-argv.mjs';
import { _setClaudeCliHelpTextForTests, _resetClaudeCliHelpForTests } from '../src/exec-cli.mjs';

// Copied verbatim from the real `claude --help` output on this machine (v2.1.220).
const HELP_WITH_FLAGS = [
  '  -p, --print                          Print response and exit',
  '      --forward-subagent-text          Forward subagent text and thinking blocks as assistant/user messages with parent_tool_use_id set (only works with --print and --output-format=stream-json)',
  '      --include-hook-events            Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)',
  '      --verbose                        Override verbose mode setting',
].join('\n');

// A realistic OLDER CLI: same shape, neither of the two flags documented anywhere.
const HELP_WITHOUT_FLAGS = [
  '  -p, --print                          Print response and exit',
  '      --verbose                        Override verbose mode setting',
].join('\n');

let tempDir;
let savedMock;
let savedOverride;
let savedSwitch;

before(() => {
  savedMock = process.env.CC_EXEC_MOCK;
  savedOverride = process.env.CC_CLAUDE_CLI_PATH;
  savedSwitch = process.env.CC_EXEC_STREAM_VISIBILITY;
  delete process.env.CC_EXEC_MOCK; // exercise the REAL (non-mock) branch of buildSpawnSpec
  delete process.env.CC_EXEC_STREAM_VISIBILITY;
  process.env.CC_CLAUDE_CLI_PATH = process.execPath;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-stream-visibility-test-'));
  _setAskMcpConfigDirForTests(tempDir);
});

after(() => {
  if (savedMock !== undefined) process.env.CC_EXEC_MOCK = savedMock; else delete process.env.CC_EXEC_MOCK;
  if (savedOverride !== undefined) process.env.CC_CLAUDE_CLI_PATH = savedOverride; else delete process.env.CC_CLAUDE_CLI_PATH;
  if (savedSwitch !== undefined) process.env.CC_EXEC_STREAM_VISIBILITY = savedSwitch; else delete process.env.CC_EXEC_STREAM_VISIBILITY;
  _resetClaudeCliHelpForTests();
  _setAskMcpConfigDirForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  delete process.env.CC_EXEC_STREAM_VISIBILITY;
  _resetClaudeCliHelpForTests();
  for (const f of fs.readdirSync(tempDir)) fs.rmSync(path.join(tempDir, f));
});

test('SUPPORTED: a CLI whose own --help documents both flags gets BOTH of them on the real spawn', () => {
  _setClaudeCliHelpTextForTests(HELP_WITH_FLAGS);
  const spec = buildSpawnSpec('hello', 'execute', undefined, undefined);
  assert.ok(spec.args.includes('--forward-subagent-text'), '--forward-subagent-text must be spawned when the CLI documents it');
  assert.ok(spec.args.includes('--include-hook-events'), '--include-hook-events must be spawned when the CLI documents it');
});

test('UNSUPPORTED: an older CLI whose --help documents NEITHER flag never receives either of them', () => {
  _setClaudeCliHelpTextForTests(HELP_WITHOUT_FLAGS);
  const spec = buildSpawnSpec('hello', 'execute', undefined, undefined);
  assert.ok(!spec.args.includes('--forward-subagent-text'), 'an older CLI must never be handed --forward-subagent-text');
  assert.ok(!spec.args.includes('--include-hook-events'), 'an older CLI must never be handed --include-hook-events');
});

test('PARTIAL SUPPORT: only the flag the CLI actually documents is added, never both as a pair', () => {
  _setClaudeCliHelpTextForTests(HELP_WITHOUT_FLAGS + '\n      --include-hook-events            Include all hook lifecycle events in the output stream');
  const spec = buildSpawnSpec('hello', 'execute', undefined, undefined);
  assert.ok(spec.args.includes('--include-hook-events'));
  assert.ok(!spec.args.includes('--forward-subagent-text'));
});

test('UNKNOWN CLI: help text that could not be read at all degrades to NEITHER flag (safe default, never a guess)', () => {
  _setClaudeCliHelpTextForTests(null);
  assert.deepEqual(resolveStreamVisibilityFlags(), []);
  const spec = buildSpawnSpec('hello', 'execute', undefined, undefined);
  assert.ok(!spec.args.includes('--forward-subagent-text'));
  assert.ok(!spec.args.includes('--include-hook-events'));
});

test('SWITCH off: an operator can turn the flags off even on a CLI that fully supports them', () => {
  _setClaudeCliHelpTextForTests(HELP_WITH_FLAGS);
  process.env.CC_EXEC_STREAM_VISIBILITY = 'off';
  assert.deepEqual(resolveStreamVisibilityFlags(), []);
  const spec = buildSpawnSpec('hello', 'execute', undefined, undefined);
  assert.ok(!spec.args.includes('--forward-subagent-text'));
  assert.ok(!spec.args.includes('--include-hook-events'));
});

test('SWITCH on: an explicit operator override forces both flags even when --help detection found nothing', () => {
  _setClaudeCliHelpTextForTests(HELP_WITHOUT_FLAGS);
  process.env.CC_EXEC_STREAM_VISIBILITY = 'on';
  assert.deepEqual(resolveStreamVisibilityFlags(), ['--forward-subagent-text', '--include-hook-events']);
});

test('SWITCH auto is the DEFAULT: an unset switch behaves exactly like an explicit "auto"', () => {
  _setClaudeCliHelpTextForTests(HELP_WITH_FLAGS);
  const withUnset = resolveStreamVisibilityFlags();
  process.env.CC_EXEC_STREAM_VISIBILITY = 'auto';
  assert.deepEqual(resolveStreamVisibilityFlags(), withUnset);
  assert.deepEqual(withUnset, ['--forward-subagent-text', '--include-hook-events']);
});

test('SWITCH garbage: an unrecognised switch value falls back to auto-detection, never to blindly-on', () => {
  _setClaudeCliHelpTextForTests(HELP_WITHOUT_FLAGS);
  process.env.CC_EXEC_STREAM_VISIBILITY = 'yes-please';
  assert.deepEqual(resolveStreamVisibilityFlags(), []);
});

test('MOCK MODE: the mock spawn spec never carries either flag (the mock child is a node script, not the CLI)', () => {
  _setClaudeCliHelpTextForTests(HELP_WITH_FLAGS);
  process.env.CC_EXEC_MOCK = '1';
  try {
    const spec = buildSpawnSpec('hello', 'execute', undefined, undefined);
    assert.equal(spec.cmd, process.execPath);
    assert.ok(!spec.args.includes('--forward-subagent-text'));
    assert.ok(!spec.args.includes('--include-hook-events'));
  } finally {
    delete process.env.CC_EXEC_MOCK;
  }
});

test('REGRESSION: the base argv builder itself stays byte-identical — the flags are layered on in buildSpawnSpec only', () => {
  _setClaudeCliHelpTextForTests(HELP_WITH_FLAGS);
  const args = _buildRealArgsForTests('hello', 'bypass', 'max', 'claude-fable-5');
  assert.deepEqual(args, [
    '-p', 'hello', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--effort', 'max',
    '--model', 'claude-fable-5',
  ]);
});

test('REGRESSION: the flags are appended at the very END, after the ask-mcp flags, so no existing argv position shifts', () => {
  _setClaudeCliHelpTextForTests(HELP_WITH_FLAGS);
  const spec = buildSpawnSpec('hello', 'execute', undefined, undefined, { convId: 'c-1', turnId: 't-1', requestId: 'req-1' });
  const strictIdx = spec.args.indexOf('--strict-mcp-config');
  const forwardIdx = spec.args.indexOf('--forward-subagent-text');
  const hooksIdx = spec.args.indexOf('--include-hook-events');
  assert.ok(strictIdx > -1, '--strict-mcp-config must still be present');
  assert.ok(forwardIdx > strictIdx, 'the visibility flags must come AFTER the existing ask-mcp flags');
  assert.ok(hooksIdx > strictIdx);
  // Everything up to --mcp-config is exactly the argv the pre-existing tests already assert.
  const mcpIdx = spec.args.indexOf('--mcp-config');
  assert.deepEqual(spec.args.slice(0, 5), ['-p', 'hello', '--output-format', 'stream-json', '--verbose']);
  assert.ok(mcpIdx > -1 && mcpIdx < forwardIdx);
});
