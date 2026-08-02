// Forge Command Center gateway — per-execution token measurement (feat-gateway-cost-sampling).
//
// WHY THIS EXISTS (owner-agent measurement, 2026-07-31): across every stored Forge run there are 831
// events, of which exactly ONE is a real `cost_sampled` (0.12%; a naive grep says 2, but the second
// hit is a subagent_started event whose task text merely contains the string). The reason is structural, not sloppiness:
// that event can only be produced by a Boss that first writes a `claude -p --output-format json`
// envelope to disk and THEN remembers to invoke `.claude/forge-bin/forge-cost.cjs capture` on it, so
// in practice it essentially never happens. Meanwhile this gateway already parses the very same
// numbers off the child's real stream-json (`exec-stream-parse.mjs`, `extractResultUsage`) and threw
// most of them away. This module moves the measurement from the party that forgets to the party that
// already has the data. It invents nothing: no price table, no estimate, no default zero.
//
// RECORD FORMAT — deliberately NOT a new one. It is the existing `cost_sampled` record that
// `.claude/forge-bin/forge-cost.cjs` `buildCostEvent()` already produces:
//     { agent, role: 'orchestrator', tokens?, cost?, model?, note? }
// (that file is read-only here; the `event_type` key it strips before handing the rest to
// log-event.cjs is carried by the gateway's own event `kind` instead). Extra fields are added
// alongside those names, never in place of them.
//
// DOLLARS ARE NULL, ON PURPOSE. This project has no price table, so there is no honest way to turn
// tokens into money, and a fabricated rate would be worse than no number at all. `cost`/`cost_usd`
// are therefore explicitly null with `unit:'tokens'` + `cost_basis:'no_price_table'` next to them, so
// a reader can never mistake a token count for a dollar amount. (The CLI's own `total_cost_usd` is
// still stored verbatim per turn by `exec-lifecycle.mjs` as `cost_usd` on the assistant turn — that
// is the CLI's own claim about its own call and is left exactly where it already was; it is
// deliberately not aggregated here, because the two `result` lines of a single invocation report
// two DIFFERENT session-cost snapshots (0.0816 then 0.158 in the captures below) and adding them
// would be exactly the double count this module exists to prevent.)
//
// ── THE DOUBLE-COUNT TRAP THIS MODULE IS BUILT AROUND ────────────────────────────────────────────
// Measured on the four real captures in test/fixtures/subagent-stream-*.jsonl (claude CLI v2.1.220,
// one `Agent` dispatch — the same fixtures test/subagent-visibility.test.mjs is grounded in). ONE
// `claude -p` invocation emitted TWO `system:init` lines and TWO `result` lines, because the Agent
// tool runs async and the CLI flushes a second result for the task notification. Both are ordinary
// main-conversation lines (no `parent_tool_use_id`), so both really do arrive here. Concretely, in
// `subagent-stream-both-flags.jsonl`:
//
//   result #1  usage {in 18, out 386, cacheCreation 35616, cacheRead 84134}   num_turns 2
//   result #2  usage {in 10, out  43, cacheCreation  5143, cacheRead 60188}   num_turns 1
//   modelUsage['claude-haiku-4-5-20251001'] — BYTE-IDENTICAL on both lines:
//              {inputTokens 46, outputTokens 1531, cacheCreationInputTokens 79337,
//               cacheReadInputTokens 205304, canonicalModel 'claude-haiku-4-5'}
//
// Two different things are being reported, and they need OPPOSITE treatment:
//   - the top-level `usage` block is PER-SEGMENT — proven by #2 reporting FEWER cache-creation
//     tokens than #1, which a running total can never do. It is therefore SUMMED.
//   - the `modelUsage` entry is a CUMULATIVE SESSION SNAPSHOT — proven by being identical on both
//     lines while their `usage` blocks differ, and by exceeding the sum of those blocks (it also
//     covers the subagent's own turns). It is therefore taken ONCE (max per model, never summed
//     across lines); summing it would report exactly 2x the real usage.
//   - `num_turns` is per-segment too and is SUMMED (2 + 1 = 3). It is never derived from counting
//     init lines or result lines: "one turn = one init + one result" is false here (2 inits, 2
//     results, 3 turns).
// A repeat of a line already seen (same `uuid`) is refused outright as a third layer of defense.
//
// Sessions are never shared between executions (`exec-argv.mjs` builds no `--resume`/`--continue`
// flag — every spawn is a fresh session), so a cumulative session snapshot is scoped to exactly one
// execution and cannot leak usage from an earlier turn into this one.

// Bound, mirroring this gateway's own "never unbounded growth" convention (STDERR_CAP_BYTES,
// MAX_FILE_EDITS_PER_TURN, MAX_SUBAGENT_ENTRIES_PER_LINE, ...). Real streams carry 2 result lines;
// this only ever protects against a pathological child. Past the cap the id sets stop growing (the
// counters still count) — dedupe is a safety net on top of the aggregation rules, not the mechanism
// they depend on.
const MAX_TRACKED_LINE_IDS = 500;

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// null + null stays null ("never measured"), null + n becomes n. A field that was never reported is
// never silently turned into a 0 — this module's whole point is that absence is not zero.
function addOrNull(current, value) {
  const n = numOrNull(value);
  if (n === null) return current;
  return current === null ? n : current + n;
}

// For a CUMULATIVE counter: keep the largest value ever seen for that model. Identical to "the last
// one wins" while the counter is monotonic (which is what the captures show), but order-independent
// and, crucially, incapable of double counting.
function maxOrNull(current, value) {
  const n = numOrNull(value);
  if (n === null) return current;
  return current === null ? n : Math.max(current, n);
}

/**
 * One aggregator per execution. `observe(parsedLine)` is fed every parsed main-conversation
 * stream-json line; `snapshot()` returns the honest measurement, or `null` when the stream never
 * reported a single usable token number (a mock child, a spawn error, a killed turn) — the caller
 * must then write NO event at all rather than an event full of zeroes.
 */
export function createExecCostAggregator() {
  const seenResultIds = new Set();
  const seenInitIds = new Set();
  let resultLines = 0;
  let initLines = 0;
  let duplicateResultLines = 0;
  let turns = null; // null until a real num_turns is reported

  // Per-segment `usage`, summed across distinct result lines.
  const usageSum = { input: null, output: null, cacheCreation: null, cacheRead: null };
  // Cumulative `modelUsage`, keyed by the model id the CLI reported, max-per-field per model.
  // Insertion order is preserved, so `models[0]` is genuinely the first model this stream named.
  const sessionByModel = new Map();

  function trackId(set, id) {
    if (typeof id !== 'string' || id.length === 0) return { known: false, tracked: false };
    if (set.has(id)) return { known: true, tracked: true };
    if (set.size < MAX_TRACKED_LINE_IDS) set.add(id);
    return { known: false, tracked: true };
  }

  function observeModelUsage(modelUsage) {
    if (!modelUsage || typeof modelUsage !== 'object') return;
    for (const [key, entry] of Object.entries(modelUsage)) {
      if (typeof key !== 'string' || key.length === 0 || !entry || typeof entry !== 'object') continue;
      const existing = sessionByModel.get(key) || { canonical: null, input: null, output: null, cacheCreation: null, cacheRead: null };
      if (existing.canonical === null && typeof entry.canonicalModel === 'string' && entry.canonicalModel.length > 0) {
        existing.canonical = entry.canonicalModel;
      }
      existing.input = maxOrNull(existing.input, entry.inputTokens);
      existing.output = maxOrNull(existing.output, entry.outputTokens);
      existing.cacheCreation = maxOrNull(existing.cacheCreation, entry.cacheCreationInputTokens);
      existing.cacheRead = maxOrNull(existing.cacheRead, entry.cacheReadInputTokens);
      sessionByModel.set(key, existing);
    }
  }

  return {
    observe(parsed) {
      if (!parsed || typeof parsed !== 'object') return;

      if (parsed.type === 'system' && parsed.subtype === 'init') {
        // Counted for transparency ONLY — an init line carries no usage, and the count is reported
        // next to `turns` precisely so a reader can see that the two genuinely differ.
        if (trackId(seenInitIds, parsed.uuid).known) return;
        initLines += 1;
        return;
      }

      if (parsed.type !== 'result') return;

      if (trackId(seenResultIds, parsed.uuid).known) {
        duplicateResultLines += 1;
        return;
      }
      resultLines += 1;

      const numTurns = numOrNull(parsed.num_turns);
      if (numTurns !== null) turns = (turns === null ? 0 : turns) + numTurns;

      const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : null;
      if (usage) {
        usageSum.input = addOrNull(usageSum.input, usage.input_tokens);
        usageSum.output = addOrNull(usageSum.output, usage.output_tokens);
        usageSum.cacheCreation = addOrNull(usageSum.cacheCreation, usage.cache_creation_input_tokens);
        usageSum.cacheRead = addOrNull(usageSum.cacheRead, usage.cache_read_input_tokens);
      }
      observeModelUsage(parsed.modelUsage);
    },

    snapshot() {
      // Across DIFFERENT models the per-model cumulative totals are summed — two model keys are two
      // genuinely different models, not two reports of the same one.
      const session = { input: null, output: null, cacheCreation: null, cacheRead: null };
      for (const entry of sessionByModel.values()) {
        session.input = addOrNull(session.input, entry.input);
        session.output = addOrNull(session.output, entry.output);
        session.cacheCreation = addOrNull(session.cacheCreation, entry.cacheCreation);
        session.cacheRead = addOrNull(session.cacheRead, entry.cacheRead);
      }

      const hasSession = session.input !== null || session.output !== null || session.cacheCreation !== null || session.cacheRead !== null;
      const hasUsageSum = usageSum.input !== null || usageSum.output !== null || usageSum.cacheCreation !== null || usageSum.cacheRead !== null;
      // Absence of measurement is NOT a measurement of zero: no usable token number anywhere means
      // there is nothing to report, and the caller writes no event.
      if (!hasSession && !hasUsageSum) return null;

      const primary = hasSession ? session : usageSum;
      const models = [...sessionByModel.keys()];
      const firstEntry = models.length > 0 ? sessionByModel.get(models[0]) : null;
      const tokens = primary.input !== null && primary.output !== null ? primary.input + primary.output : null;

      return {
        input_tokens: primary.input,
        output_tokens: primary.output,
        cache_creation_input_tokens: primary.cacheCreation,
        cache_read_input_tokens: primary.cacheRead,
        // Only a real total: an input+output sum is refused outright when one of the two sides was
        // never measured, exactly like forge-cost.cjs's own buildCostEvent() refuses it.
        tokens,
        model: firstEntry ? firstEntry.canonical || models[0] : null,
        models,
        turns,
        result_lines: resultLines,
        init_lines: initLines,
        duplicate_result_lines: duplicateResultLines,
        token_source: hasSession ? 'modelUsage_session_max' : 'result_usage_sum',
        // Always carried alongside, even when it IS the primary source: the parent-only per-segment
        // sum and the session-wide snapshot are two different real facts, and the gap between them
        // is the subagents' own share. Nested, so a dashboard that sums numeric top-level fields
        // across events (panels.js costStats()) can never add these on top of the totals.
        result_usage_sum: {
          input_tokens: usageSum.input,
          output_tokens: usageSum.output,
          cache_creation_input_tokens: usageSum.cacheCreation,
          cache_read_input_tokens: usageSum.cacheRead,
        },
      };
    },

    _trackedIdCountForTests() {
      return seenResultIds.size + seenInitIds.size;
    },
  };
}

export const MAX_TRACKED_LINE_IDS_FOR_TESTS = MAX_TRACKED_LINE_IDS;

const COST_NOTE =
  'tokens measured by the gateway from the CLI stream-json result lines; ' +
  'no price table in this project, so no dollar amount is reported — tokens only, never a money estimate';

/**
 * Turns a snapshot into the stored `cost_sampled` record. Returns null for a null snapshot, so the
 * "no measurement -> no event" rule is enforced in one place instead of at every call site.
 */
export function buildCostSampledRecord(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const agent = typeof options.agent === 'string' && options.agent.length > 0 ? options.agent : 'gateway';
  return {
    // ── the existing forge-cost.cjs buildCostEvent() field names ──
    agent,
    role: 'orchestrator',
    tokens: snapshot.tokens,
    model: snapshot.model,
    note: COST_NOTE,
    // ── the measurement itself ──
    input_tokens: snapshot.input_tokens,
    output_tokens: snapshot.output_tokens,
    cache_creation_input_tokens: snapshot.cache_creation_input_tokens,
    cache_read_input_tokens: snapshot.cache_read_input_tokens,
    models: snapshot.models,
    turns: snapshot.turns,
    // ── how it was counted, so the numbers can be argued with ──
    measured_by: 'gateway_exec_stream',
    token_source: snapshot.token_source,
    result_lines: snapshot.result_lines,
    init_lines: snapshot.init_lines,
    duplicate_result_lines: snapshot.duplicate_result_lines,
    result_usage_sum: snapshot.result_usage_sum,
    // ── this is a token count, not money ──
    unit: 'tokens',
    cost: null,
    cost_usd: null,
    cost_basis: 'no_price_table',
  };
}
