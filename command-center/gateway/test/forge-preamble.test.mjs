// Unit tests for forge-preamble.mjs (feat-forge-preamble, forge-2026-07-30-cc-finish): the Forge
// Lead system-prompt text appended to every REAL (non-mock) dashboard execution via
// --append-system-prompt, and the argv wiring itself. Content assertions only (never a length
// check), per this WP's own instruction — the exact wording is free to evolve; the HARD invariants
// (project-path rule, ask_owner instruction, no-ExitPlanMode acknowledgment, the plan-mode-has-no-
// tools warning, honesty clause) are not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FORGE_LEAD_PREAMBLE } from '../src/forge-preamble.mjs';
import { buildSpawnSpec, _setAskMcpConfigDirForTests } from '../src/exec-argv.mjs';

let savedMock;
let savedOverride;
let tempDir;

before(() => {
  savedMock = process.env.CC_EXEC_MOCK;
  savedOverride = process.env.CC_CLAUDE_CLI_PATH;
  delete process.env.CC_EXEC_MOCK; // exercise the REAL (non-mock) branch of buildSpawnSpec
  // A real, absolute, existing path outside this test's own cwd (mirrors exec-ask-mcp-config.test.mjs's
  // own precedent) — resolveClaudeCliPath()'s cwd-shadow guard only rejects a candidate living under
  // the current cwd; Node's own binary satisfies that trivially, no real `claude` install required.
  process.env.CC_CLAUDE_CLI_PATH = process.execPath;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-forge-preamble-test-'));
  _setAskMcpConfigDirForTests(tempDir);
});

after(() => {
  if (savedMock !== undefined) process.env.CC_EXEC_MOCK = savedMock; else delete process.env.CC_EXEC_MOCK;
  if (savedOverride !== undefined) process.env.CC_CLAUDE_CLI_PATH = savedOverride; else delete process.env.CC_CLAUDE_CLI_PATH;
  _setAskMcpConfigDirForTests(null);
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

/* ---------------------------------------------------------------- content ---------------------- */

test('FORGE_LEAD_PREAMBLE states the hard project-path rule (every artifact stays inside this project, never ~/.claude/plans)', () => {
  assert.match(FORGE_LEAD_PREAMBLE, /every artifact stays in the project/i);
  assert.match(FORGE_LEAD_PREAMBLE, /never write outside this project/i);
  assert.match(FORGE_LEAD_PREAMBLE, /~\/\.claude\/plans/);
});

test('FORGE_LEAD_PREAMBLE instructs generating ask_owner questions from the prompt/project, never a fixed checklist, never inventing an answer', () => {
  assert.match(FORGE_LEAD_PREAMBLE, /ask_owner/);
  assert.match(FORGE_LEAD_PREAMBLE, /never reuse\s+a fixed checklist/i);
  assert.match(FORGE_LEAD_PREAMBLE, /never invent an answer/i);
});

test('FORGE_LEAD_PREAMBLE carries the "ask first, then plan, then execute" instruction', () => {
  assert.match(FORGE_LEAD_PREAMBLE, /ASK FIRST, THEN PLAN, THEN EXECUTE/);
});

// coordinator finding (2026-07-30, two independent measurements): plan mode cannot call ANY
// external tool at all, ask_owner included — the preamble must say so explicitly, and must forbid
// the "print the questions as chat text instead" fallback a real transcript showed.
test('FORGE_LEAD_PREAMBLE warns that plan mode has no tools at all (ask_owner included) and forbids falling back to chat-text questions', () => {
  assert.match(FORGE_LEAD_PREAMBLE, /PLAN MODE HAS NO TOOLS AT ALL/);
  assert.match(FORGE_LEAD_PREAMBLE, /ask_owner included/i);
  assert.match(FORGE_LEAD_PREAMBLE, /never fall back to typing your questions out as plain chat text/i);
});

// coordinator finding (2026-07-30, THIRD live measurement): with tools fully available (bypass) and
// forge-ask connected, a session still died without asking anybody — it invoked the global
// `brainstorming` skill, obeyed that skill's own "ask, then wait for approval before implementing"
// rule literally, printed its questions as chat text and ended the turn. So the ask_owner rule must
// be UNCONDITIONAL and must explicitly outrank a skill/playbook step that says to ask-and-wait,
// rather than being scoped to the plan-mode paragraph.
test('FORGE_LEAD_PREAMBLE makes ask_owner the only way to ask, unconditionally — outranking any skill/playbook "ask the user and wait for approval" step', () => {
  assert.match(FORGE_LEAD_PREAMBLE, /ask_owner IS THE ONLY WAY TO ASK/);
  assert.match(FORGE_LEAD_PREAMBLE, /unconditionally/i);
  // the exact failure mode measured live: ending the turn with the questions in chat text
  assert.match(FORGE_LEAD_PREAMBLE, /ending the turn does NOT ask anybody/i);
  // and the specific hijack that caused it: a skill telling it to ask/confirm/wait for approval
  assert.match(FORGE_LEAD_PREAMBLE, /skill, playbook, or workflow/i);
  assert.match(FORGE_LEAD_PREAMBLE, /wait for approval before implementing/i);
  assert.match(FORGE_LEAD_PREAMBLE, /never by stopping/i);
});

test('FORGE_LEAD_PREAMBLE tells the session how to reach ask_owner when it is a deferred tool (the live run had to ToolSearch for it first)', () => {
  assert.match(FORGE_LEAD_PREAMBLE, /deferred tool/i);
  assert.match(FORGE_LEAD_PREAMBLE, /ToolSearch/);
});

// owner complaint, twice now (2026-07-30): a plan landed in C:\Users\<user>\.claude\plans despite the
// hard project-path rule — plan MODE's harness allows no other write target, so the rule alone cannot
// prevent it. The preamble must therefore order the recovery: first action of the execution turn is
// copying the plan into the project and continuing from the project copy.
test('FORGE_LEAD_PREAMBLE orders the plan to be copied INTO the project as the first execution action when the harness forced it into ~/.claude/plans', () => {
  assert.match(FORGE_LEAD_PREAMBLE, /IF THE HARNESS FORCED YOUR PLAN INTO ~\/\.claude\/plans/);
  assert.match(FORGE_LEAD_PREAMBLE, /FIRST action of the execution/i);
  assert.match(FORGE_LEAD_PREAMBLE, /copy that plan's full content into the project/i);
  assert.match(FORGE_LEAD_PREAMBLE, /continue working from the project copy/i);
});

test('FORGE_LEAD_PREAMBLE names the real ExitPlanMode gap so plan mode is never a dead end', () => {
  assert.match(FORGE_LEAD_PREAMBLE, /no ExitPlanMode tool/i);
  assert.match(FORGE_LEAD_PREAMBLE, /equivalent to doing nothing/i);
});

test('FORGE_LEAD_PREAMBLE carries an explicit honesty clause', () => {
  assert.match(FORGE_LEAD_PREAMBLE, /never claim something was tested, built, or verified/i);
});

/* ---------------------------------------------------------------- argv wiring ------------------ */

test('ARGV: a REAL (non-mock) execution appends --append-system-prompt with the real FORGE_LEAD_PREAMBLE text', () => {
  const spec = buildSpawnSpec('hello', 'execute', undefined, undefined);
  const idx = spec.args.indexOf('--append-system-prompt');
  assert.ok(idx > -1, '--append-system-prompt must be present on a real execution');
  assert.equal(spec.args[idx + 1], FORGE_LEAD_PREAMBLE);
});

test('ARGV: a REAL execution with an askContext still carries --append-system-prompt (before the --mcp-config flags), and never --allowed-tools', () => {
  const spec = buildSpawnSpec('hello', 'bypass', undefined, undefined, { convId: 'c-1', turnId: 't-1', requestId: 'req-1' });
  const preambleIdx = spec.args.indexOf('--append-system-prompt');
  const mcpIdx = spec.args.indexOf('--mcp-config');
  assert.ok(preambleIdx > -1 && mcpIdx > -1, 'both flags must be present');
  assert.ok(preambleIdx < mcpIdx, '--append-system-prompt must appear before --mcp-config');
  assert.equal(spec.args[preambleIdx + 1], FORGE_LEAD_PREAMBLE);
  assert.ok(!spec.args.includes('--allowed-tools'));
  assert.ok(fs.existsSync(spec.askMcpConfigPath));
});

test('ARGV: mock-mode (CC_EXEC_MOCK=1) execution never appends --append-system-prompt at all', () => {
  process.env.CC_EXEC_MOCK = '1';
  try {
    const spec = buildSpawnSpec('hello', 'execute', undefined, undefined);
    assert.ok(!spec.args.includes('--append-system-prompt'));
  } finally {
    delete process.env.CC_EXEC_MOCK;
  }
});

// feat-ask-recommended + owner sharpening ("het moet wel echt de beste recommenderen en niet
// random!"): a recommendation must be earned from the actual context, with its reasoning visible,
// and omitted when nothing is clearly better — never positional/popularity/convenience advice.
test('FORGE_LEAD_PREAMBLE demands an EARNED recommendation with visible reasoning, and none when no option is clearly better', () => {
  assert.match(FORGE_LEAD_PREAMBLE, /"recommended" field/);
  assert.match(FORGE_LEAD_PREAMBLE, /must be EARNED, never a\s+habit/i);
  assert.match(FORGE_LEAD_PREAMBLE, /state that reasoning/i);
  assert.match(FORGE_LEAD_PREAMBLE, /If no option is clearly better[\s\S]{0,60}mark none/i);
  assert.match(FORGE_LEAD_PREAMBLE, /never recommend by position/i);
});
