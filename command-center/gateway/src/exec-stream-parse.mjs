// Forge Command Center gateway — exec-bridge stream-json parsing + tool-activity extraction
// (refactor-gateway-split, forge-2026-07-30-cc-finish). Split out of the single exec-bridge.mjs (had
// grown to ~754 lines, over this project's own 500-line-per-file guidance) into its own real seam:
// pure functions that turn one real stream-json line's parsed content into a bounded, honest record
// (usage/model, file edits, todo snapshots, shell commands/results). Every name below is re-exported
// from exec-bridge.mjs under its EXACT original name — see that file's own header for the full
// architecture/history/honesty rules this slice still follows; no other file in the codebase needed
// to change a single import.
import { redactAndCap } from './redact.mjs';

// fix-usage-capture (checkup MEDIUM-upgrade, forge-2026-07-29-cc-finish/forge-2026-07-30-cc-finish):
// the child's real stream-json `result` line already carries a full `usage` block
// (input_tokens/output_tokens/cache_creation_input_tokens/cache_read_input_tokens/...) and a
// `modelUsage` object keyed by the model id the CLI actually invoked — verified against 9 real
// (non-mock) `result` events already stored in this project's own `.data/conversations/*.jsonl`
// (see this WP's forge-report for the exact captured JSON). Only cost_usd/duration_ms/stop_reason/
// exit_code were ever read off `resultPayload` below this point — every other real field was parsed
// by the readline handler above, then thrown away. This function reads the same real shape
// defensively: any shape drift (a future CLI version renaming/removing a field, or the mock child's
// deliberately usage-less result line) degrades to an honest `null`, never a guess and never a
// fabricated `0` — mirrors this file's own "never throw, always a truthful reason" rule.
//
// fix-unavailable (forge-2026-07-30-cc-finish, checkup): `contextWindow` sits on the exact SAME
// `modelUsage` entry `model`/`canonicalModel` already come from (verified against the same real
// captured JSON: `modelUsage["claude-fable-5"].contextWindow: 1000000`) — reading it here, off the
// SAME entry, means it can never disagree with which model this turn actually reports.
export function extractResultUsage(resultPayload) {
  const empty = { inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, model: null, contextWindow: null };
  if (!resultPayload || typeof resultPayload !== 'object') return empty;
  const usage = resultPayload.usage && typeof resultPayload.usage === 'object' ? resultPayload.usage : null;
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  let model = null;
  let contextWindow = null;
  const modelUsage = resultPayload.modelUsage && typeof resultPayload.modelUsage === 'object' ? resultPayload.modelUsage : null;
  if (modelUsage) {
    // Real, verified shape: an object keyed by the model id the CLI actually invoked (sometimes
    // suffixed, e.g. "claude-opus-5[1m]"), each entry carrying its own clean `canonicalModel` — the
    // canonical name is preferred when present, the raw key is the honest fallback.
    const firstKey = Object.keys(modelUsage)[0];
    if (typeof firstKey === 'string' && firstKey.length > 0) {
      const entry = modelUsage[firstKey];
      const canonical = entry && typeof entry === 'object' && typeof entry.canonicalModel === 'string' ? entry.canonicalModel : null;
      model = canonical || firstKey;
      contextWindow = entry && typeof entry === 'object' ? numOrNull(entry.contextWindow) : null;
    }
  }

  return {
    inputTokens: usage ? numOrNull(usage.input_tokens) : null,
    outputTokens: usage ? numOrNull(usage.output_tokens) : null,
    cacheCreationInputTokens: usage ? numOrNull(usage.cache_creation_input_tokens) : null,
    cacheReadInputTokens: usage ? numOrNull(usage.cache_read_input_tokens) : null,
    model,
    contextWindow,
  };
}

// Test-only: the pure extraction function, asserted directly against real captured fixtures rather
// than requiring a spawned child whose mock script deliberately never emits a `usage`/`modelUsage`
// block (see MOCK_SCRIPT in `exec-argv.mjs`) — mirrors `_buildRealArgsForTests`'s own "assert the shape directly"
// rationale.
export function _extractResultUsageForTests(resultPayload) {
  return extractResultUsage(resultPayload);
}

// fix-unavailable (forge-2026-07-30-cc-finish, checkup): the claude CLI reports its OWN real
// session id on almost every stream-json line it emits — verified against this project's own
// `.data/conversations/*.jsonl` (49 hits across a single conversation's own stream, 1 unique id;
// present on `system`/`assistant`/`user`/`result` lines alike, not only the final `result` line —
// see this WP's forge-report for the exact grep evidence). Captured live, the moment the FIRST line
// carrying one arrives, rather than waiting for the turn to close — a still-running or later-killed
// turn can still have a real session id captured before it ever produces a `result` line. Returns
// null for a line/shape that never carries one (a malformed/foreign line, or MOCK_SCRIPT's own
// deliberately session-id-less lines), never a guess.
export function extractSessionIdFromParsedLine(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return typeof parsed.session_id === 'string' && parsed.session_id.length > 0 ? parsed.session_id : null;
}

export function _extractSessionIdForTests(parsed) {
  return extractSessionIdFromParsedLine(parsed);
}

// fix-stream-insights (checkup #5 task progress / #6 diff view): the child's real stream-json
// `assistant` lines already carry a `tool_use` content block for EVERY tool call the model
// makes — verified against this project's own `.data/conversations/*.jsonl` (a real, non-mock
// littlebazzar website-build run, see this WP's forge-report for the exact captured JSON):
//   Edit:      { type:'tool_use', name:'Edit',  input:{ file_path, old_string, new_string } }
//   Write:     { type:'tool_use', name:'Write', input:{ file_path, content } }
//   TodoWrite: { type:'tool_use', name:'TodoWrite', input:{ todos:[{content,status,activeForm}] } }
// `MultiEdit` was never observed anywhere in this project's stored conversations, so it is
// deliberately NOT handled here — only the two tool names this project actually has real evidence
// for. Every cap below mirrors this file's own "never unbounded growth" rule (STDERR_CAP_BYTES,
// MAX_CONCURRENT_EXECUTIONS): a single wild turn can never grow the stored turn record without
// bound, no matter how many edits/todos the model produces.
const FILE_EDIT_TOOL_NAMES = new Set(['Edit', 'Write']);
const MAX_FILE_EDITS_PER_TURN = 50;
const FILE_EDIT_FIELD_CAP_LEN = 4000; // mirrors STDERR_CAP_BYTES's own silent-slice convention
const MAX_TODOS_PER_SNAPSHOT = 200;
const TODO_FIELD_CAP_LEN = 500;

// feat-live-stream: real Bash tool_use blocks — verified live against this project's own
// `.data/conversations/*.jsonl` (see this WP's forge-report for the exact grep evidence):
//   { type:'tool_use', name:'Bash', input:{ command, description } }
// ...followed a few stream-json lines later by the real reply, a SEPARATE line with
// `type:'user'` carrying a `tool_result` content block keyed back to the command by id:
//   { type:'tool_result', tool_use_id, content, is_error }
// `content` is either a plain string OR an array of Anthropic content blocks (a real `image`
// block — base64 screenshot data — was also observed live); only real `text` blocks are ever
// kept below, an `image` block is deliberately never captured here (no chat value in embedding
// a multi-MB base64 blob into a JSONL turn record, and this file's own STDERR_CAP_BYTES/
// FILE_EDIT_FIELD_CAP_LEN already establish the "never unbounded growth" convention this
// mirrors). There is no numeric exit code anywhere in the real captured shape, only the
// boolean `is_error` — reported as such, never invented.
const MAX_SHELL_COMMANDS_PER_TURN = 50; // mirrors MAX_FILE_EDITS_PER_TURN
const SHELL_FIELD_CAP_LEN = 4000; // mirrors FILE_EDIT_FIELD_CAP_LEN

// fix-cap-order: this file used to own a local slice-only `capString(value, maxLen)` helper, leaving
// redaction to run later — downstream, on the already-cut result. That order defeats every secret
// pattern needing a trailing anchor (the PEM block needs its `-----END ... PRIVATE KEY-----`): a real
// Write of a 5462-char PEM came out of here as 4000 chars of raw key material, `diff_state:"present"`,
// and was rendered into the DOM. Every bounded field below now goes through `redactAndCap()`, which
// redacts on the FULL value BEFORE cutting — see redact.mjs for why the order lives there and not here.
// There is deliberately no slice-only helper left in this file to reach for by mistake.
// (`redactAndCap` is imported at the top of this file.)

// Returns one bounded `{tool, file_path, ...}` record for a real Edit/Write tool_use block, or
// null when `block` isn't one of the two proven shapes. Never throws on a malformed/foreign block.
export function extractFileEditFromToolUseBlock(block) {
  if (!block || block.type !== 'tool_use' || !FILE_EDIT_TOOL_NAMES.has(block.name)) return null;
  const input = block.input && typeof block.input === 'object' ? block.input : null;
  const filePath = input && typeof input.file_path === 'string' ? input.file_path : null;
  if (filePath === null) return null;
  if (block.name === 'Edit') {
    return {
      tool: 'Edit',
      file_path: filePath,
      old_string: redactAndCap(input.old_string, FILE_EDIT_FIELD_CAP_LEN),
      new_string: redactAndCap(input.new_string, FILE_EDIT_FIELD_CAP_LEN),
    };
  }
  return { tool: 'Write', file_path: filePath, content: redactAndCap(input.content, FILE_EDIT_FIELD_CAP_LEN) };
}

// Returns the bounded `todos` array off a real TodoWrite tool_use block, or null when `block`
// isn't one. This is a SNAPSHOT, not an accumulation — a turn that calls TodoWrite more than once
// (updating status as it goes) is represented by only its LAST call's own list, which is the real
// current state of the task list by the time the turn closes.
export function extractTodoSnapshotFromToolUseBlock(block) {
  if (!block || block.type !== 'tool_use' || block.name !== 'TodoWrite') return null;
  const todos = block.input && Array.isArray(block.input.todos) ? block.input.todos : null;
  if (todos === null) return null;
  return todos.slice(0, MAX_TODOS_PER_SNAPSHOT).map((t) => ({
    content: t && typeof t === 'object' ? redactAndCap(t.content, TODO_FIELD_CAP_LEN) : null,
    status: t && typeof t === 'object' && typeof t.status === 'string' ? t.status : null,
    activeForm: t && typeof t === 'object' ? redactAndCap(t.activeForm, TODO_FIELD_CAP_LEN) : null,
  }));
}

// Returns one bounded `{tool:'Bash', id, command, description, result, is_error}` record for a
// real Bash tool_use block, or null when `block` isn't one. `result`/`is_error` start null — they
// are filled in later, in place, when this same turn's matching tool_result line arrives (see
// extractShellResultFromToolResultBlock below). Never throws on a malformed/foreign block.
export function extractShellCommandFromToolUseBlock(block) {
  if (!block || block.type !== 'tool_use' || block.name !== 'Bash') return null;
  const input = block.input && typeof block.input === 'object' ? block.input : null;
  const command = input && typeof input.command === 'string' ? input.command : null;
  if (command === null) return null;
  return {
    tool: 'Bash',
    id: typeof block.id === 'string' ? block.id : null,
    command: redactAndCap(command, SHELL_FIELD_CAP_LEN),
    description: redactAndCap(input.description, SHELL_FIELD_CAP_LEN),
    result: null,
    is_error: null,
  };
}

// fix-unavailable (forge-2026-07-30-cc-finish, checkup): a real `Agent` tool_use block — verified
// against this project's own `.data/conversations/*.jsonl` (102 occurrences in a single real
// conversation: `{ type:'tool_use', name:'Agent', input:{ description, subagent_type:'Explore'|
// 'Plan', prompt, ... } }` — see this WP's forge-report for the exact grep evidence). Only
// `subagentType` (the usage bar's AGENT label) and `description` are kept; `prompt` can be
// arbitrarily long free text with no display value here and is deliberately dropped, mirroring
// this file's own "never unbounded growth" convention (STDERR_CAP_BYTES, FILE_EDIT_FIELD_CAP_LEN,
// ...). Never throws on a malformed/foreign block.
export function extractAgentDispatchFromToolUseBlock(block) {
  if (!block || block.type !== 'tool_use' || block.name !== 'Agent') return null;
  const input = block.input && typeof block.input === 'object' ? block.input : null;
  const subagentType = input && typeof input.subagent_type === 'string' && input.subagent_type.length > 0 ? input.subagent_type : null;
  if (subagentType === null) return null;
  return { subagentType, description: redactAndCap(input.description, SHELL_FIELD_CAP_LEN) };
}

// A real `tool_result.content` is either a plain string, or an array of Anthropic content
// blocks (text/image/...). Only `text` blocks are ever joined into the captured result — an
// `image` block's base64 payload is deliberately dropped (see this file's own header comment
// above for why). Returns null when there is genuinely no text to show, never an empty string.
function extractToolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

// Returns `{toolUseId, result, is_error}` for a real tool_result block (any tool, not just
// Bash — the caller below only acts on it when the id matches a Bash command this turn already
// recorded), or null when `block` isn't a tool_result at all or carries no real id.
export function extractShellResultFromToolResultBlock(block) {
  if (!block || block.type !== 'tool_result') return null;
  const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
  if (toolUseId === null) return null;
  return {
    toolUseId,
    result: redactAndCap(extractToolResultText(block.content), SHELL_FIELD_CAP_LEN),
    is_error: typeof block.is_error === 'boolean' ? block.is_error : null,
  };
}

// ── feat-subagent-visibility: subagent lines and hook lifecycle events ────────────────────────
//
// REAL SHAPE (four sanitised captures live-measured on this machine, claude CLI v2.1.220 — see
// test/fixtures/subagent-stream-*.jsonl and test/subagent-visibility.test.mjs, which re-derive
// every number below from those files rather than trusting this comment):
//
//   A subagent's own stream lines are ORDINARY `assistant`/`user` lines that additionally carry a
//   non-null `parent_tool_use_id`, equal to the `id` of the parent's `Agent` tool_use block (and
//   to the `tool_use_id` on that dispatch's `system:task_started` line). `session_id` is IDENTICAL
//   for parent and subagent, so it can NEVER discriminate — `parent_tool_use_id` is the only real
//   discriminator (null = parent, filled = subagent).
//
//   Without this routing those lines were silently merged into the MAIN conversation: a subagent's
//   reply text was concatenated into the parent turn's `text`, and its tool_use blocks were
//   recorded as the parent turn's own file_edits/shell_commands. That is the bug this closes.
//
// VOLUME: a subagent can emit an unbounded amount of thinking/tool output, so every capture here is
// bounded twice over — per-entry text length and per-line entry count below, plus a per-dispatch
// byte budget (createSubagentActivityBudget) applied by the caller. Mirrors this file's own
// STDERR_CAP_BYTES/FILE_EDIT_FIELD_CAP_LEN "never unbounded growth" convention.
const SUBAGENT_TEXT_CAP_LEN = 500;
const MAX_SUBAGENT_ENTRIES_PER_LINE = 8;
export const SUBAGENT_ACTIVITY_BYTES_PER_DISPATCH = 32000;

/**
 * Returns `{ parentToolUseId, role, entries }` for a real subagent stream-json line, or null when
 * the line belongs to the main conversation (no `parent_tool_use_id`). `entries` is a short, typed,
 * capped distillation of the line's own content blocks — `thinking`/`text` keep their (capped)
 * text, a `tool_use` keeps only its tool NAME (a tool input can be arbitrarily large and has no
 * display value in a live activity strip), a `tool_result` keeps its (capped) text only, never an
 * image block's base64 payload. Never throws on a malformed/foreign line.
 */
export function extractSubagentLine(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const parentToolUseId = typeof parsed.parent_tool_use_id === 'string' && parsed.parent_tool_use_id.length > 0
    ? parsed.parent_tool_use_id
    : null;
  if (parentToolUseId === null) return null;

  const role = typeof parsed.type === 'string' && parsed.type.length > 0 ? parsed.type : null;
  const content = parsed.message && Array.isArray(parsed.message.content) ? parsed.message.content : [];
  const entries = [];
  for (const block of content) {
    if (entries.length >= MAX_SUBAGENT_ENTRIES_PER_LINE) break;
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      entries.push({ type: 'text', text: redactAndCap(block.text, SUBAGENT_TEXT_CAP_LEN) });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      entries.push({ type: 'thinking', text: redactAndCap(block.thinking, SUBAGENT_TEXT_CAP_LEN) });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      entries.push({ type: 'tool_use', tool: block.name });
    } else if (block.type === 'tool_result') {
      entries.push({ type: 'tool_result', text: redactAndCap(extractToolResultText(block.content), SUBAGENT_TEXT_CAP_LEN) });
    }
  }
  return { parentToolUseId, role, entries };
}

// A hook lifecycle line. REAL SHAPE (verbatim from the captures):
//   started:  {type:'system', subtype:'hook_started',  hook_id, hook_name, hook_event, uuid, session_id}
//   response: {type:'system', subtype:'hook_response', hook_id, hook_name, hook_event, output,
//              stdout, stderr, exit_code, outcome, uuid, session_id}
// `hook_id` pairs the two 1-to-1 (measured: 19 started / 19 responded / 0 unpaired). `hook_event` is
// the bare lifecycle name (PreToolUse, SubagentStart, SubagentStop, Stop, UserPromptSubmit,
// SessionStart); `hook_name` is the matcher-qualified variant ("SubagentStart:general-purpose",
// "SessionStart:startup", "SubagentStop", ...).
//
// HONEST LIMITATION: `parent_tool_use_id` is null on EVERY hook line, including SubagentStart and
// SubagentStop — a hook event therefore cannot be tied to a specific dispatch by id at all. The
// only subagent identity available is the matcher suffix on `hook_name`, and SubagentStop does not
// even carry that. Two concurrent subagents of the same type are genuinely indistinguishable here;
// agent-dispatches.mjs therefore only attaches a hook time when it is unambiguous.
const HOOK_OUTPUT_CAP_LEN = 500;

export function extractHookEventFromParsedLine(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'system') return null;
  const phase = parsed.subtype === 'hook_started' ? 'started' : parsed.subtype === 'hook_response' ? 'response' : null;
  if (phase === null) return null;
  const hookEvent = typeof parsed.hook_event === 'string' && parsed.hook_event.length > 0 ? parsed.hook_event : null;
  if (hookEvent === null) return null;
  const hookName = typeof parsed.hook_name === 'string' && parsed.hook_name.length > 0 ? parsed.hook_name : null;
  // The matcher suffix ("SubagentStart:general-purpose" -> "general-purpose") is the ONLY subagent
  // identity a hook line carries; a bare name ("SubagentStop") honestly yields null.
  let subagentType = null;
  if (hookName !== null) {
    const colon = hookName.indexOf(':');
    if (colon > -1 && colon < hookName.length - 1) subagentType = hookName.slice(colon + 1);
  }
  return {
    phase,
    hook_event: hookEvent,
    hook_name: hookName,
    hook_id: typeof parsed.hook_id === 'string' && parsed.hook_id.length > 0 ? parsed.hook_id : null,
    subagent_type: subagentType,
    outcome: typeof parsed.outcome === 'string' ? parsed.outcome : null,
    exit_code: typeof parsed.exit_code === 'number' && Number.isFinite(parsed.exit_code) ? parsed.exit_code : null,
    output: redactAndCap(parsed.output, HOOK_OUTPUT_CAP_LEN),
  };
}

// The only two hook lifecycle events that name a SUBAGENT, and therefore the only ones this feature
// distills into its own stored record (exec-lifecycle.mjs). This is a volume bound BY CONSTRUCTION
// rather than an arbitrary numeric cap: SubagentStart/SubagentStop fire once per dispatch, whereas
// PreToolUse/Stop/UserPromptSubmit fire per tool call / per turn and would grow with the length of
// an agentic run (the real captures already show 6 UserPromptSubmit + 6 Stop pairs for ONE short
// prompt). Nothing is lost by scoping it: every hook line is still stored raw as its ordinary
// `system` event, exactly as before this feature existed — only the distilled, directly-readable
// signal is limited to the two events a dispatch's real start/end time can come from.
const SUBAGENT_LIFECYCLE_HOOK_EVENTS = new Set(['SubagentStart', 'SubagentStop']);

export function isSubagentLifecycleHook(hookEventName) {
  return SUBAGENT_LIFECYCLE_HOOK_EVENTS.has(hookEventName);
}

/**
 * A per-dispatch byte budget for stored subagent activity. One instance per execution; each
 * `parentToolUseId` gets its OWN independent budget, so one very noisy subagent can never silence
 * another running alongside it.
 *
 * `admit(parentToolUseId, record)` returns `{ admit, truncatedNow }`:
 *   - `admit: true`  — the record fits and its size has been charged to that dispatch's budget.
 *   - `truncatedNow: true` — this is the FIRST record that did not fit; the caller should emit one
 *     honest truncation signal. Every later over-budget record returns `{admit:false,
 *     truncatedNow:false}` so a long-running subagent never produces a truncation-marker flood.
 */
export function createSubagentActivityBudget() {
  const used = new Map(); // parentToolUseId -> bytes charged so far
  const truncated = new Set(); // parentToolUseIds that already reported their truncation once
  return {
    admit(parentToolUseId, record) {
      const key = typeof parentToolUseId === 'string' ? parentToolUseId : '';
      let size;
      try {
        size = JSON.stringify(record).length;
      } catch {
        return { admit: false, truncatedNow: false }; // unserialisable is never silently stored
      }
      const charged = used.get(key) || 0;
      if (charged + size > SUBAGENT_ACTIVITY_BYTES_PER_DISPATCH) {
        used.set(key, SUBAGENT_ACTIVITY_BYTES_PER_DISPATCH); // saturate — never wrap or shrink
        if (truncated.has(key)) return { admit: false, truncatedNow: false };
        truncated.add(key);
        return { admit: false, truncatedNow: true };
      }
      used.set(key, charged + size);
      return { admit: true, truncatedNow: false };
    },
  };
}

export function _subagentActivityCapsForTests() {
  return {
    SUBAGENT_TEXT_CAP_LEN,
    MAX_SUBAGENT_ENTRIES_PER_LINE,
    HOOK_OUTPUT_CAP_LEN,
    SUBAGENT_ACTIVITY_BYTES_PER_DISPATCH,
  };
}

// Test-only: pure extraction, asserted directly against real captured tool_use fixtures — same
// "assert the shape directly" rationale as `_extractResultUsageForTests` above.
export function _extractFileEditForTests(block) {
  return extractFileEditFromToolUseBlock(block);
}
export function _extractTodoSnapshotForTests(block) {
  return extractTodoSnapshotFromToolUseBlock(block);
}
export function _extractShellCommandForTests(block) {
  return extractShellCommandFromToolUseBlock(block);
}
export function _extractShellResultForTests(block) {
  return extractShellResultFromToolResultBlock(block);
}
export function _extractAgentDispatchForTests(block) {
  return extractAgentDispatchFromToolUseBlock(block);
}
export function _turnArtifactCapsForTests() {
  return {
    MAX_FILE_EDITS_PER_TURN,
    FILE_EDIT_FIELD_CAP_LEN,
    MAX_TODOS_PER_SNAPSHOT,
    TODO_FIELD_CAP_LEN,
    MAX_SHELL_COMMANDS_PER_TURN,
    SHELL_FIELD_CAP_LEN,
  };
}

// Exported so exec-lifecycle.mjs can size its own bounded accumulation arrays without duplicating
// the numeric literal — mirrors this file's own "one real ceiling, never a guess" convention.
export { MAX_FILE_EDITS_PER_TURN, MAX_SHELL_COMMANDS_PER_TURN };
