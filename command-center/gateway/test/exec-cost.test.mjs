// feat-gateway-cost-sampling — the gateway measures its OWN token usage at run-close, instead of
// depending on an agent remembering to run `.claude/forge-bin/forge-cost.cjs` by hand.
//
// WHY THIS EXISTS (owner-agent measurement, 2026-07-31): across every stored Forge run there are 831
// events, of which exactly ONE is a real `cost_sampled` (0.12%) — because that event can only be produced by
// a Boss that first writes a `claude -p --output-format json` envelope to disk and then remembers to
// invoke forge-cost.cjs on it. Meanwhile this gateway already parses `usage`/`modelUsage` off the
// child's real stream-json (`exec-stream-parse.mjs`), so the raw material was already arriving and
// being thrown away. Nothing here invents a number; it only stops discarding measured ones.
//
// EVERY number asserted below is re-derived from the four REAL, sanitised stream captures in
// test/fixtures/subagent-stream-*.jsonl (claude CLI v2.1.220, one `Agent` dispatch, measured on this
// machine) — the same fixtures test/subagent-visibility.test.mjs already grounds itself in. The
// measured ground truth this file re-derives rather than trusts:
//
//   - ONE `claude -p` invocation produced TWO `system:init` lines and TWO `result` lines (the Agent
//     tool runs async and the CLI flushes a second result for the task notification). So neither
//     "one init = one turn" nor "the last result line IS the turn" is true.
//   - each `result` line's own top-level `usage` block is PER-SEGMENT (result #2's
//     cache_creation_input_tokens 5143 < result #1's 35616 — a cumulative counter can never shrink),
//     so those must be SUMMED.
//   - each `result` line's `modelUsage` entry is a CUMULATIVE SESSION SNAPSHOT and is byte-identical
//     on both lines, and larger than the sum of the two per-line `usage` blocks (it also covers the
//     subagent's own turns). Summing THAT across the two result lines would double every number —
//     that is the exact double-count trap this file pins down.
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
import { startExecution, _resetExecBridgeForTests, _setExecTimeoutMsForTests } from '../src/exec-bridge.mjs';
import { createExecCostAggregator, buildCostSampledRecord, MAX_TRACKED_LINE_IDS_FOR_TESTS } from '../src/exec-cost.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));
const ALL_FIXTURES = [
  'subagent-stream-no-flags.jsonl',
  'subagent-stream-forward-subagent-text-only.jsonl',
  'subagent-stream-include-hook-events-only.jsonl',
  'subagent-stream-both-flags.jsonl',
];
// The one capture whose exact measured numbers are hardcoded below (all four are asserted
// structurally in the loop test). Its two result lines, verbatim from the file:
//   #1 usage {in 18, out 386, cacheCreation 35616, cacheRead 84134}  num_turns 2
//   #2 usage {in 10, out  43, cacheCreation  5143, cacheRead 60188}  num_turns 1
//   modelUsage['claude-haiku-4-5-20251001'] (IDENTICAL on both lines):
//        {inputTokens 46, outputTokens 1531, cacheCreationInputTokens 79337, cacheReadInputTokens 205304}
const MEASURED = 'subagent-stream-both-flags.jsonl';

function readFixture(name) {
  return fs
    .readFileSync(path.join(FIXTURE_DIR, name), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function aggregateFixture(name) {
  const agg = createExecCostAggregator();
  for (const line of readFixture(name)) agg.observe(line);
  return agg.snapshot();
}

let tempDir;

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-exec-cost-test-'));
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

// ── MEASURED GROUND TRUTH (re-derived from the real captures, not trusted from a comment) ────────

test('MEASURED: one real `claude -p` invocation produced TWO system:init and TWO result lines, none of them a subagent line', () => {
  for (const name of ALL_FIXTURES) {
    const lines = readFixture(name);
    const inits = lines.filter((l) => l.type === 'system' && l.subtype === 'init');
    const results = lines.filter((l) => l.type === 'result');
    assert.equal(inits.length, 2, name + ' must carry exactly 2 init lines');
    assert.equal(results.length, 2, name + ' must carry exactly 2 result lines');
    // Neither init nor result carries a parent_tool_use_id, so exec-lifecycle.mjs's subagent
    // early-return never shields the aggregator from the second one — it really does see both.
    for (const l of [...inits, ...results]) {
      assert.ok(l.parent_tool_use_id === undefined || l.parent_tool_use_id === null, name + ': init/result lines must not be subagent lines');
    }
  }
});

test('MEASURED: each result line`s own usage is PER-SEGMENT (a cumulative counter could never shrink)', () => {
  const results = readFixture(MEASURED).filter((l) => l.type === 'result');
  assert.ok(
    results[1].usage.cache_creation_input_tokens < results[0].usage.cache_creation_input_tokens,
    'result #2 reports FEWER cache-creation tokens than #1 — proof the per-line usage is a segment, not a running total',
  );
  assert.ok(results[1].usage.output_tokens < results[0].usage.output_tokens);
});

test('MEASURED: modelUsage is a CUMULATIVE session snapshot — identical on both result lines, and larger than the sum of their per-line usage', () => {
  const results = readFixture(MEASURED).filter((l) => l.type === 'result');
  assert.equal(
    JSON.stringify(results[0].modelUsage),
    JSON.stringify(results[1].modelUsage),
    'both result lines carry the SAME modelUsage object — summing it would double every number',
  );
  const entry = results[0].modelUsage['claude-haiku-4-5-20251001'];
  const perSegmentOut = results[0].usage.output_tokens + results[1].usage.output_tokens;
  assert.ok(entry.outputTokens > perSegmentOut, 'the session snapshot also covers the subagent`s own turns');
});

// ── AGGREGATION over the real captures ───────────────────────────────────────────────────────────

test('AGGREGATE: turns come from the result lines` own num_turns — never from counting init lines, never from the last result alone', () => {
  const lines = readFixture(MEASURED);
  const results = lines.filter((l) => l.type === 'result');
  const snap = aggregateFixture(MEASURED);

  assert.equal(snap.turns, 3, 'num_turns 2 + 1 = 3');
  assert.equal(snap.result_lines, 2);
  assert.equal(snap.init_lines, 2);
  // The two wrong answers this must not accidentally agree with.
  assert.notEqual(snap.turns, snap.init_lines, 'a turn is NOT "one init"');
  assert.notEqual(snap.turns, results[results.length - 1].num_turns, 'a turn count is NOT "the last result line wins"');
});

test('NO DOUBLE COUNT: the cumulative modelUsage totals are taken ONCE, never summed across the two result lines', () => {
  const snap = aggregateFixture(MEASURED);
  assert.equal(snap.input_tokens, 46, 'not 92');
  assert.equal(snap.output_tokens, 1531, 'not 3062');
  assert.equal(snap.cache_creation_input_tokens, 79337, 'not 158674');
  assert.equal(snap.cache_read_input_tokens, 205304, 'not 410608');
  assert.equal(snap.tokens, 46 + 1531);
  assert.equal(snap.token_source, 'modelUsage_session_max');
  assert.equal(snap.model, 'claude-haiku-4-5');
  assert.deepEqual(snap.models, ['claude-haiku-4-5-20251001']);
});

test('AGGREGATE: the PER-SEGMENT usage blocks ARE summed, and stay strictly below the session totals', () => {
  const snap = aggregateFixture(MEASURED);
  assert.deepEqual(snap.result_usage_sum, {
    input_tokens: 18 + 10,
    output_tokens: 386 + 43,
    cache_creation_input_tokens: 35616 + 5143,
    cache_read_input_tokens: 84134 + 60188,
  });
  assert.ok(snap.result_usage_sum.output_tokens < snap.output_tokens, 'the parent-only sum must stay below the session total that also covers the subagent');
});

test('AGGREGATE: all four real captures aggregate without ever doubling a cumulative number', () => {
  for (const name of ALL_FIXTURES) {
    const lines = readFixture(name);
    const results = lines.filter((l) => l.type === 'result');
    const entry = results[0].modelUsage['claude-haiku-4-5-20251001'];
    const snap = aggregateFixture(name);

    assert.equal(snap.input_tokens, entry.inputTokens, name);
    assert.equal(snap.output_tokens, entry.outputTokens, name);
    assert.equal(snap.cache_read_input_tokens, entry.cacheReadInputTokens, name);
    assert.equal(snap.cache_creation_input_tokens, entry.cacheCreationInputTokens, name);
    assert.equal(snap.turns, results[0].num_turns + results[1].num_turns, name);
    assert.equal(snap.result_lines, 2, name);
    assert.equal(snap.duplicate_result_lines, 0, name);
  }
});

test('NO DOUBLE COUNT: an exact repeat of the same result line (same uuid) is refused, not added twice', () => {
  const results = readFixture(MEASURED).filter((l) => l.type === 'result');
  const agg = createExecCostAggregator();
  agg.observe(results[0]);
  agg.observe(results[1]);
  const clean = agg.snapshot();

  const dup = createExecCostAggregator();
  dup.observe(results[0]);
  dup.observe(results[1]);
  dup.observe(JSON.parse(JSON.stringify(results[1]))); // a byte-identical repeat of a line already seen
  const withDup = dup.snapshot();

  assert.equal(withDup.duplicate_result_lines, 1);
  assert.equal(withDup.result_lines, clean.result_lines, 'a repeat must not count as another segment');
  assert.equal(withDup.turns, clean.turns, 'a repeat must not add its num_turns again');
  assert.deepEqual(withDup.result_usage_sum, clean.result_usage_sum, 'a repeat must not add its usage again');
});

// ── HONEST ABSENCE ───────────────────────────────────────────────────────────────────────────────

test('ABSENCE: a stream with no observable usage yields NO snapshot at all — absence of measurement is not a measurement of zero', () => {
  const agg = createExecCostAggregator();
  agg.observe({ type: 'system', subtype: 'init', session_id: 's' });
  agg.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  // The exact shape MOCK_SCRIPT's own result line has: a cost/duration/num_turns, but no usage and
  // no modelUsage anywhere.
  agg.observe({ type: 'result', is_error: false, result: 'x', total_cost_usd: 0.0002, duration_ms: 5, num_turns: 1, stop_reason: 'end_turn' });
  assert.equal(agg.snapshot(), null, 'no token field was ever reported, so there is nothing to report');
});

test('ABSENCE: an empty stream yields no snapshot', () => {
  assert.equal(createExecCostAggregator().snapshot(), null);
});

test('PARTIAL: an unmeasured field stays null (never 0) and a total is refused when only one side was measured', () => {
  const agg = createExecCostAggregator();
  agg.observe({ type: 'result', uuid: 'r1', num_turns: 1, usage: { output_tokens: 43 } });
  const snap = agg.snapshot();
  assert.notEqual(snap, null, 'one real measured number is still a real measurement');
  assert.equal(snap.output_tokens, 43);
  assert.strictEqual(snap.input_tokens, null, 'never 0 — it was never reported');
  assert.strictEqual(snap.cache_read_input_tokens, null);
  assert.strictEqual(snap.tokens, null, 'input+output is refused when input was never measured');
  assert.equal(snap.token_source, 'result_usage_sum', 'no modelUsage was reported, so the per-segment sum is the only real source');
  assert.strictEqual(snap.model, null);
});

test('SYNTHETIC (hand-built, not a capture): two DIFFERENT models are summed with each other, while each model`s own cumulative snapshot is still taken only once', () => {
  const mu = {
    'model-a': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 1000, cacheCreationInputTokens: 5, canonicalModel: 'model-a-canonical' },
    'model-b': { inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 20, cacheCreationInputTokens: 1 },
  };
  const agg = createExecCostAggregator();
  agg.observe({ type: 'result', uuid: 'r1', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: mu });
  agg.observe({ type: 'result', uuid: 'r2', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: JSON.parse(JSON.stringify(mu)) });
  const snap = agg.snapshot();

  assert.equal(snap.input_tokens, 107, 'across models: summed; across the two lines: taken once');
  assert.equal(snap.output_tokens, 13);
  assert.deepEqual(snap.models, ['model-a', 'model-b']);
  assert.equal(snap.model, 'model-a-canonical', 'canonicalModel wins over the raw key, exactly like extractResultUsage already does');
});

test('BOUND: a pathological stream stops growing the tracked-id set at the cap, while still counting every line', () => {
  const agg = createExecCostAggregator();
  const lines = MAX_TRACKED_LINE_IDS_FOR_TESTS + 50;
  for (let i = 0; i < lines; i++) {
    agg.observe({ type: 'result', uuid: 'r' + i, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  }
  assert.equal(agg._trackedIdCountForTests(), MAX_TRACKED_LINE_IDS_FOR_TESTS, 'the id set must saturate, never grow without bound');
  const snap = agg.snapshot();
  assert.equal(snap.result_lines, lines, 'counting is O(1) and keeps working past the cap');
  assert.equal(snap.turns, lines);
  assert.equal(snap.input_tokens, lines);
});

// ── THE RECORD FORMAT (must stay compatible with the existing cost_sampled record) ────────────────

test('RECORD: dollars are explicitly null with a stated reason — the record says it measured TOKENS, never money', () => {
  const record = buildCostSampledRecord(aggregateFixture(MEASURED));
  // Field names inherited from the existing producer of this event type,
  // `.claude/forge-bin/forge-cost.cjs` buildCostEvent() -> {agent, role, tokens, cost, model, note}.
  assert.equal(record.role, 'orchestrator');
  assert.equal(typeof record.agent, 'string');
  assert.equal(record.tokens, 46 + 1531);
  assert.equal(record.model, 'claude-haiku-4-5');
  assert.equal(typeof record.note, 'string');
  // The honesty requirement: this project has no price table, so there is no dollar amount.
  assert.strictEqual(record.cost, null);
  assert.strictEqual(record.cost_usd, null);
  assert.equal(record.unit, 'tokens');
  assert.equal(record.cost_basis, 'no_price_table');
  assert.match(record.note, /token/i);
  // ...and nothing anywhere in the record may smuggle a dollar number back in.
  for (const [key, value] of Object.entries(record)) {
    if (/cost/i.test(key)) assert.ok(value === null || typeof value === 'string', 'cost-ish field ' + key + ' must be null or an explanatory string, never a number');
  }
});

test('RECORD: a null snapshot never becomes a record', () => {
  assert.equal(buildCostSampledRecord(null), null);
});

// ── E2E through the real execution lifecycle ─────────────────────────────────────────────────────

test('E2E: a real execution whose stream carries usage writes EXACTLY ONE cost_sampled event with the aggregated real numbers', async () => {
  const conv = createConversation({ project: 'demo-project' });
  const start = startExecution({ convId: conv.id, turnId: 't-cost-1', requestId: 'req-cost-1', text: '__MOCK_USAGE__ measure me', cwd: os.tmpdir() });
  assert.equal(start.started, true);

  const done = await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant'));
  assert.ok(done, 'the mock child must close and produce a real assistant turn');

  const full = readConversation(conv.id);
  const costEvents = full.events.filter((e) => e.kind === 'cost_sampled');
  assert.equal(costEvents.length, 1, 'exactly one cost sample per closed run — never one per result line');

  const data = costEvents[0].data;
  assert.equal(costEvents[0].turn_id, 't-cost-1');
  assert.equal(data.input_tokens, 46);
  assert.equal(data.output_tokens, 1531);
  assert.equal(data.cache_creation_input_tokens, 79337);
  assert.equal(data.cache_read_input_tokens, 205304);
  assert.equal(data.turns, 3);
  assert.equal(data.result_lines, 2);
  assert.equal(data.init_lines, 2);
  assert.equal(data.model, 'claude-haiku-4-5');
  assert.strictEqual(data.cost, null);
  assert.strictEqual(data.cost_usd, null);
});

test('E2E: an ordinary run whose stream reports no usage writes NO cost_sampled event at all', async () => {
  const conv = createConversation({ project: 'demo-project' });
  startExecution({ convId: conv.id, turnId: 't-cost-2', requestId: 'req-cost-2', text: 'plain ping', cwd: os.tmpdir() });

  const done = await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant'));
  assert.ok(done);

  const full = readConversation(conv.id);
  assert.equal(full.events.filter((e) => e.kind === 'cost_sampled').length, 0, 'no measurement -> no event, never an event full of zeroes');
});

test('E2E TIMEOUT: a wedged child that already reported real usage still gets its one honest cost_sampled event', async () => {
  _setExecTimeoutMsForTests(400); // real headroom for the child to write+flush its lines first
  const conv = createConversation({ project: 'demo-project' });
  startExecution({ convId: conv.id, turnId: 't-cost-3', requestId: 'req-cost-3', text: '__MOCK_USAGE_HANG__ report then hang', cwd: os.tmpdir() });

  const done = await waitUntil(() => readConversation(conv.id).turns.some((t) => t.role === 'assistant' && t.stop_reason === 'timed_out'));
  _setExecTimeoutMsForTests(null);
  assert.ok(done, 'the wall-clock timeout must reap the wedged child');

  const full = readConversation(conv.id);
  const costEvents = full.events.filter((e) => e.kind === 'cost_sampled');
  assert.equal(costEvents.length, 1, 'usage measured before the kill is still a real measurement');
  assert.equal(costEvents[0].data.output_tokens, 1531);
  assert.equal(costEvents[0].data.turns, 3);
});
