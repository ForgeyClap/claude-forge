// feat-subagent-visibility — routing every `parent_tool_use_id`-carrying stream-json line away from
// the main conversation and onto its own dispatch, plus registering real hook lifecycle events.
//
// EVERY shape asserted here is grounded in the four REAL, sanitised stream captures in
// test/fixtures/subagent-stream-*.jsonl (claude CLI v2.1.220, one `Agent` dispatch with
// subagent_type general-purpose, measured on this machine). The measured ground truth those files
// carry, and which the FIXTURE tests below re-derive rather than trust:
//   - all four runs carry EXACTLY 5 lines with a non-null parent_tool_use_id
//     (assistant[thinking] | assistant[tool_use:Glob] | user[tool_result] | assistant[thinking] |
//     assistant[text]) — subagent text/thinking is forwarded even WITHOUT --forward-subagent-text
//     on this CLI version, so that flag is honest-but-inert here; it is the *contract*, not the
//     observed delta.
//   - hook lines are the real delta of --include-hook-events: 4 started + 4 response (SessionStart
//     only) without it, 19 + 19 (SessionStart/UserPromptSubmit/PreToolUse/SubagentStart/Stop/
//     SubagentStop) with it. Hook events only ever appear for hooks that GENUINELY exist and match
//     on the machine — on a machine with no configured hooks the flag yields nothing at all.
//   - `parent_tool_use_id` on a subagent line === the `tool_use_id` on the dispatch's own
//     `system:task_started` line. `session_id` is IDENTICAL for parent and subagent, so it can
//     never discriminate; parent_tool_use_id is the only real discriminator.
//   - `parent_tool_use_id` is null on EVERY hook line, including SubagentStart/SubagentStop — a
//     hook event therefore cannot be tied to a specific dispatch by id at all. That is a real
//     limitation of the stream, not an implementation shortcut, and is why the hook-derived times
//     below are only ever attached when they are unambiguous.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createConversation,
  readConversation,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import { startExecution, _resetExecBridgeForTests } from '../src/exec-bridge.mjs';
import {
  extractSubagentLine,
  extractHookEventFromParsedLine,
  createSubagentActivityBudget,
  SUBAGENT_ACTIVITY_BYTES_PER_DISPATCH,
  _subagentActivityCapsForTests,
} from '../src/exec-stream-parse.mjs';
import { listAgentDispatches } from '../src/agent-dispatches.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

function readFixture(name) {
  return fs
    .readFileSync(path.join(FIXTURE_DIR, name), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

let tempDir;

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-subagent-visibility-test-'));
  _setConversationsDirForTests(tempDir);
});

after(() => {
  delete process.env.CC_EXEC_MOCK;
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

beforeEach(() => {
  _resetExecBridgeForTests();
});

async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ── FIXTURE ground truth: the pure extractors, run over the REAL captured streams ──────────────

const ALL_FIXTURES = [
  'subagent-stream-no-flags.jsonl',
  'subagent-stream-forward-subagent-text-only.jsonl',
  'subagent-stream-include-hook-events-only.jsonl',
  'subagent-stream-both-flags.jsonl',
];

test('FIXTURE: every one of the four real captures yields EXACTLY the 5 measured subagent lines, and nothing else', () => {
  for (const name of ALL_FIXTURES) {
    const lines = readFixture(name);
    const subagent = lines.map(extractSubagentLine).filter((r) => r !== null);
    assert.equal(subagent.length, 5, name + ' must yield exactly 5 subagent lines');
    // One single dispatch per capture — every line points at the same parent tool_use id.
    const parents = new Set(subagent.map((r) => r.parentToolUseId));
    assert.equal(parents.size, 1, name + ' must carry exactly one dispatch');
    assert.deepEqual(subagent.map((r) => r.role), ['assistant', 'assistant', 'user', 'assistant', 'assistant']);
  }
});

test('FIXTURE: a parent (non-subagent) line is never mistaken for a subagent line', () => {
  const lines = readFixture('subagent-stream-both-flags.jsonl');
  const parentLines = lines.filter((l) => l.parent_tool_use_id === null || l.parent_tool_use_id === undefined);
  assert.equal(parentLines.length, lines.length - 5);
  for (const l of parentLines) assert.equal(extractSubagentLine(l), null);
});

test('FIXTURE CORRELATION: parent_tool_use_id on the subagent lines equals the dispatch task_started tool_use_id', () => {
  const lines = readFixture('subagent-stream-both-flags.jsonl');
  const taskStarted = lines.find((l) => l.type === 'system' && l.subtype === 'task_started');
  assert.ok(taskStarted, 'the real capture must contain a task_started line');
  const subagent = lines.map(extractSubagentLine).filter((r) => r !== null);
  for (const r of subagent) assert.equal(r.parentToolUseId, taskStarted.tool_use_id);
  // session_id can NEVER discriminate — proven directly against the real capture.
  const parentAssistant = lines.find((l) => l.type === 'assistant' && !l.parent_tool_use_id);
  const subagentAssistant = lines.find((l) => l.type === 'assistant' && l.parent_tool_use_id);
  assert.equal(parentAssistant.session_id, subagentAssistant.session_id);
});

test('FIXTURE: the real subagent content blocks are distilled into short, typed entries (thinking/tool_use/tool_result/text)', () => {
  const lines = readFixture('subagent-stream-both-flags.jsonl');
  const subagent = lines.map(extractSubagentLine).filter((r) => r !== null);
  const types = subagent.flatMap((r) => r.entries.map((e) => e.type));
  assert.deepEqual(types, ['thinking', 'tool_use', 'tool_result', 'thinking', 'text']);
  const toolEntry = subagent.flatMap((r) => r.entries).find((e) => e.type === 'tool_use');
  assert.equal(toolEntry.tool, 'Glob');
  const finalText = subagent[subagent.length - 1].entries[0];
  assert.equal(finalText.type, 'text');
  assert.equal(finalText.text, '67');
});

test('FIXTURE HOOKS: --include-hook-events is the real delta — 4+4 SessionStart-only without it, 19+19 across six lifecycle events with it', () => {
  const counts = {};
  for (const name of ALL_FIXTURES) {
    const hooks = readFixture(name).map(extractHookEventFromParsedLine).filter((h) => h !== null);
    counts[name] = {
      started: hooks.filter((h) => h.phase === 'started').length,
      response: hooks.filter((h) => h.phase === 'response').length,
      events: [...new Set(hooks.map((h) => h.hook_event))].sort(),
    };
  }
  assert.deepEqual(counts['subagent-stream-no-flags.jsonl'], { started: 4, response: 4, events: ['SessionStart'] });
  assert.deepEqual(counts['subagent-stream-forward-subagent-text-only.jsonl'], { started: 4, response: 4, events: ['SessionStart'] });
  const withHooks = { started: 19, response: 19, events: ['PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'] };
  assert.deepEqual(counts['subagent-stream-include-hook-events-only.jsonl'], withHooks);
  assert.deepEqual(counts['subagent-stream-both-flags.jsonl'], withHooks);
});

test('FIXTURE HOOKS: a SubagentStart hook carries its subagent type in the hook_name suffix; SubagentStop honestly carries none', () => {
  const hooks = readFixture('subagent-stream-both-flags.jsonl').map(extractHookEventFromParsedLine).filter((h) => h !== null);
  const start = hooks.find((h) => h.hook_event === 'SubagentStart' && h.phase === 'started');
  assert.equal(start.hook_name, 'SubagentStart:general-purpose');
  assert.equal(start.subagent_type, 'general-purpose');
  const stop = hooks.find((h) => h.hook_event === 'SubagentStop' && h.phase === 'started');
  assert.equal(stop.hook_name, 'SubagentStop');
  assert.equal(stop.subagent_type, null, 'a SubagentStop hook genuinely carries no subagent type — never invent one');
  // Every real hook line's parent_tool_use_id is null — the documented limitation.
  const rawHookLines = readFixture('subagent-stream-both-flags.jsonl').filter((l) => l.type === 'system' && (l.subtype === 'hook_started' || l.subtype === 'hook_response'));
  for (const l of rawHookLines) assert.equal(l.parent_tool_use_id ?? null, null);
  // A hook_response carries the hook's real outcome/exit code, paired back by hook_id.
  const stopResponse = hooks.find((h) => h.hook_event === 'SubagentStop' && h.phase === 'response');
  assert.equal(stopResponse.hook_id, stop.hook_id);
  assert.equal(stopResponse.outcome, 'success');
  assert.equal(stopResponse.exit_code, 0);
  assert.equal(stopResponse.output, '[OK] Task completed\n');
});

test('a non-hook system line (task_started/init) is never reported as a hook event', () => {
  const lines = readFixture('subagent-stream-both-flags.jsonl');
  for (const l of lines.filter((x) => x.type === 'system' && x.subtype !== 'hook_started' && x.subtype !== 'hook_response')) {
    assert.equal(extractHookEventFromParsedLine(l), null);
  }
  assert.equal(extractHookEventFromParsedLine(null), null);
  assert.equal(extractHookEventFromParsedLine({ type: 'assistant' }), null);
});

// ── VOLUME BOUNDS: a subagent can produce enormous text; nothing here may grow without bound ────

test('CAP: a huge subagent thinking/text block is capped per entry, never stored whole', () => {
  const caps = _subagentActivityCapsForTests();
  const huge = 'z'.repeat(caps.SUBAGENT_TEXT_CAP_LEN + 5000);
  const rec = extractSubagentLine({
    type: 'assistant',
    parent_tool_use_id: 'toolu_x',
    message: { content: [{ type: 'thinking', thinking: huge }, { type: 'text', text: huge }] },
  });
  assert.equal(rec.entries.length, 2);
  assert.equal(rec.entries[0].text.length, caps.SUBAGENT_TEXT_CAP_LEN);
  assert.equal(rec.entries[1].text.length, caps.SUBAGENT_TEXT_CAP_LEN);
});

test('CAP: a line with an absurd number of content blocks keeps only the first N entries', () => {
  const caps = _subagentActivityCapsForTests();
  const content = [];
  for (let i = 0; i < caps.MAX_SUBAGENT_ENTRIES_PER_LINE + 25; i++) content.push({ type: 'text', text: 'block ' + i });
  const rec = extractSubagentLine({ type: 'assistant', parent_tool_use_id: 'toolu_x', message: { content } });
  assert.equal(rec.entries.length, caps.MAX_SUBAGENT_ENTRIES_PER_LINE);
});

test('BUDGET: a per-dispatch byte budget stops admitting records and reports the truncation exactly once', () => {
  const budget = createSubagentActivityBudget();
  const record = { role: 'assistant', entries: [{ type: 'text', text: 'y'.repeat(400) }] };
  let admitted = 0;
  let truncationSignals = 0;
  for (let i = 0; i < 500; i++) {
    const verdict = budget.admit('toolu_a', record);
    if (verdict.admit) admitted++;
    if (verdict.truncatedNow) truncationSignals++;
  }
  assert.ok(admitted > 0, 'the budget must admit real records before it fills up');
  assert.ok(admitted < 500, 'the budget must genuinely stop admitting');
  assert.equal(truncationSignals, 1, 'the truncation must be reported exactly once, never on every later line');
  assert.ok(admitted * 400 <= SUBAGENT_ACTIVITY_BYTES_PER_DISPATCH + 4000);
});

test('BUDGET: each dispatch gets its OWN independent budget — one noisy subagent never silences another', () => {
  const budget = createSubagentActivityBudget();
  const record = { role: 'assistant', entries: [{ type: 'text', text: 'y'.repeat(400) }] };
  for (let i = 0; i < 500; i++) budget.admit('toolu_a', record);
  assert.equal(budget.admit('toolu_a', record).admit, false);
  assert.equal(budget.admit('toolu_b', record).admit, true);
});

// ── END TO END through the REAL lifecycle: spawn -> readline -> stored events/turn ─────────────
// `__MOCK_SUBAGENT__` makes the mock child emit the exact real line shapes captured in the
// fixtures above (an Agent tool_use, its task_started/task_updated pair, the SubagentStart/
// SubagentStop hook pairs, and three parent_tool_use_id-carrying subagent lines).

// THE core defect this feature closes: a subagent's OWN tool calls were accumulated onto the PARENT
// turn's record, so the parent looked like it had run a shell command and edited a file it never
// touched. The mock's subagent runs a real Bash and a real Edit block (the two tool names the
// parent-turn extractors act on) — with the routing branch removed, both land on the parent turn.
test('E2E ROUTING: a subagent\'s OWN Bash/Edit tool calls are never accumulated onto the parent turn record', async () => {
  const conv = createConversation({ project: 'subagent-e2e' });
  const start = startExecution({ convId: conv.id, turnId: 't-sub', requestId: 'req-sub', text: '__MOCK_SUBAGENT__ count the tests', cwd: os.tmpdir() });
  assert.equal(start.started, true);
  assert.ok(await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant')));

  const turn = readConversation(conv.id).turns.find((t) => t.role === 'assistant');
  assert.equal(turn.shell_commands, null, 'the parent ran no shell command of its own — the subagent\'s Bash call must not be attributed to it');
  assert.equal(turn.file_edits, null, 'the parent edited no file of its own — the subagent\'s Edit call must not be attributed to it');
  assert.ok(!JSON.stringify(turn).includes('SUBAGENT-ONLY'), 'no subagent-only payload may appear anywhere on the parent turn record');
  // The parent keeps its own real reply (on a normal close this comes from the CLI's own `result`
  // line, not from the accumulated text buffer — so this assertion is a sanity check, not the proof).
  assert.match(turn.text, /PARENT-TEXT/);
});

test('E2E ROUTING: subagent lines are stored as their own subagent_activity events, never as plain assistant/user events', async () => {
  const conv = createConversation({ project: 'subagent-e2e-events' });
  const start = startExecution({ convId: conv.id, turnId: 't-sub2', requestId: 'req-sub2', text: '__MOCK_SUBAGENT__ count the tests', cwd: os.tmpdir() });
  assert.equal(start.started, true);
  assert.ok(await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant')));

  const { events } = readConversation(conv.id);
  const activity = events.filter((e) => e.kind === 'subagent_activity');
  assert.equal(activity.length, 3, 'all three subagent lines must be recorded as dispatch activity');
  for (const e of activity) assert.equal(e.data.parent_tool_use_id, 'toolu_mock_agent');
  assert.deepEqual(activity.map((e) => e.data.role), ['assistant', 'user', 'assistant']);
  assert.ok(JSON.stringify(activity).includes('SUBAGENT-ONLY-TEXT-67'));

  // No raw main-conversation event may carry a parent_tool_use_id any more.
  const leaked = events.filter((e) => (e.kind === 'assistant' || e.kind === 'user') && e.data && e.data.parent_tool_use_id);
  assert.deepEqual(leaked, [], 'a parent_tool_use_id line must never also be stored as a main-conversation assistant/user event');
});

test('E2E HOOKS: real SubagentStart/SubagentStop hook lifecycle lines are registered as hook_event records', async () => {
  const conv = createConversation({ project: 'subagent-e2e-hooks' });
  const start = startExecution({ convId: conv.id, turnId: 't-sub3', requestId: 'req-sub3', text: '__MOCK_SUBAGENT__ count the tests', cwd: os.tmpdir() });
  assert.equal(start.started, true);
  assert.ok(await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant')));

  const hookEvents = readConversation(conv.id).events.filter((e) => e.kind === 'hook_event');
  assert.equal(hookEvents.length, 4, 'both hook pairs (started+response for SubagentStart and SubagentStop) must be registered');
  const startedNames = hookEvents.filter((e) => e.data.phase === 'started').map((e) => e.data.hook_event).sort();
  assert.deepEqual(startedNames, ['SubagentStart', 'SubagentStop']);
  const startHook = hookEvents.find((e) => e.data.hook_event === 'SubagentStart' && e.data.phase === 'started');
  assert.equal(startHook.data.subagent_type, 'general-purpose');
});

test('VOLUME SCOPE: a non-subagent hook (PreToolUse) gets NO distilled record, but is still stored raw — nothing is lost', async () => {
  const conv = createConversation({ project: 'subagent-e2e-hookscope' });
  const start = startExecution({ convId: conv.id, turnId: 't-sub6', requestId: 'req-sub6', text: '__MOCK_SUBAGENT__ count the tests', cwd: os.tmpdir() });
  assert.equal(start.started, true);
  assert.ok(await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant')));

  const { events } = readConversation(conv.id);
  const distilled = events.filter((e) => e.kind === 'hook_event').map((e) => e.data.hook_event);
  assert.ok(!distilled.includes('PreToolUse'), 'a per-tool-call hook must never be duplicated into a distilled record — that is the volume bound');
  assert.deepEqual([...new Set(distilled)].sort(), ['SubagentStart', 'SubagentStop']);

  // ...and the raw system line for that same hook is still there, exactly as before this feature.
  const rawPreToolUse = events.filter((e) => e.kind === 'system' && e.data && e.data.hook_event === 'PreToolUse');
  assert.equal(rawPreToolUse.length, 2, 'both raw PreToolUse hook lines (started + response) must still be stored');
});

test('E2E DISPATCH: the dispatch row carries its real tool_use_id, live activity and harness-reported start/end times', async () => {
  const conv = createConversation({ project: 'subagent-e2e-dispatch' });
  const start = startExecution({ convId: conv.id, turnId: 't-sub4', requestId: 'req-sub4', text: '__MOCK_SUBAGENT__ count the tests', cwd: os.tmpdir() });
  assert.equal(start.started, true);
  assert.ok(await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant')));

  const rows = listAgentDispatches('subagent-e2e-dispatch');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.subagent_type, 'general-purpose');
  assert.equal(row.tool_use_id, 'toolu_mock_agent');
  assert.equal(row.resolved_status, 'completed');
  assert.ok(Array.isArray(row.activity) && row.activity.length === 3, 'the dispatch must carry its own three live activity lines');
  assert.ok(JSON.stringify(row.activity).includes('SUBAGENT-ONLY-TEXT-67'));
  assert.equal(row.activity_truncated, false);
  // The harness's OWN hook lifecycle times, not a derivation from the task_started/task_updated pair.
  assert.ok(row.hook_started_at, 'a SubagentStart hook fired — its real time must be reported');
  assert.ok(row.hook_ended_at, 'a SubagentStop hook fired — its real time must be reported');
  assert.ok(row.hook_started_at <= row.hook_ended_at);
});

test('HONEST GAP: a dispatch with no hook events at all reports null hook times, never a derived guess', async () => {
  const conv = createConversation({ project: 'subagent-e2e-nohooks' });
  // The plain __MOCK_TOOLS__ path emits no Agent dispatch at all; use the dedicated no-hook marker.
  const start = startExecution({ convId: conv.id, turnId: 't-sub5', requestId: 'req-sub5', text: '__MOCK_SUBAGENT_NO_HOOKS__ count the tests', cwd: os.tmpdir() });
  assert.equal(start.started, true);
  assert.ok(await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant')));

  const rows = listAgentDispatches('subagent-e2e-nohooks');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hook_started_at, null, 'no hook fired — the time must stay an honest null');
  assert.equal(rows[0].hook_ended_at, null);
  assert.equal(rows[0].tool_use_id, 'toolu_mock_agent');
  assert.ok(rows[0].activity.length > 0, 'subagent activity is still routed even with no hooks configured at all');
});
