// feat-chatruns-tabs — dashboard-CHAT "runs", derived for Mission Control / Tasks / Artifacts.
//
// OWNER FINDING this closes (screenshots in mission/test-evidence/shots-final-20260730/): Mission
// Control / Tasks / Artifacts / Tests & proof only ever read a Forge MISSION's own event trail
// (`.claude/forge-runs/`, via runs.mjs/missions.mjs/proof.mjs) — a project the owner drives entirely
// through this gateway's dashboard CHAT (no `/forge` mission at all) produces real, useful activity
// (real file edits, a real TodoWrite task list, a real model/token/stop_reason) that never showed up
// anywhere in those tabs, even though the project's own files were genuinely being built.
//
// DESIGN CHOICE (D2 write-boundary — read this before adding a new store anywhere near this file):
// this module is PURE READ. It derives a "chat run" view straight off the conversation store
// `conversations.mjs` already owns (`command-center/.data/conversations/*.jsonl` — the gateway's OWN
// store, never the target project's directory) and writes nothing of its own; it imports no `fs`.
// A second physical copy under e.g. `.data/chat-runs/<run_id>/...` was considered and rejected: every
// fact a chat-run needs (turn_id, tokens, model, file_edits, todos, stop_reason) is ALREADY written,
// once, by conversations.mjs's existing `appendUserTurn`/`appendAssistantTurn` — a second store would
// just be the same facts copied a second time, with a real risk of drifting out of sync with the
// original. That is the exact two-sources-of-truth problem this project's own `missions.mjs`/
// `proof.mjs` already avoid by deriving from `events.jsonl` instead of keeping a separate "mission"
// file — this module follows the SAME precedent for the SAME reason. The D2 boundary ("the gateway
// never writes into the target project's directory") holds either way, since the only store either
// design would touch is this gateway's own `.data/conversations/`, never `.claude/` and never the
// project root.
//
// GRANULARITY: one "chat run" = one chat EXECUTION — one user turn's `turn_id`, matched to its own
// assistant turn by that SAME `turn_id` (server.mjs always threads the user turn's `turnId` straight
// through to `startExecution` -> `appendAssistantTurn`) — not one whole conversation. A conversation
// with several sends over time is several real chat-runs, exactly like several `claude -p`
// invocations would be several Forge runs.
import { listConversations, readConversation, deriveTitleFromText } from './conversations.mjs';
import { isConversationBusy } from './exec-bridge.mjs';

// Mirrors this gateway's own "never unbounded growth" convention (STDERR_CAP_BYTES,
// MAX_FILE_EDITS_PER_TURN, MAX_SUMMARY_CACHE_ENTRIES, ...) — a real ceiling, not a guess: a
// dashboard project realistically has a handful to a few dozen real chat executions, never
// thousands, so this only ever protects against a genuinely pathological case.
const MAX_CHAT_RUNS_PER_PROJECT = 50;

// feat-chatrun-diff — the volume ceiling for the before/after text `toFileEditRow()` now passes
// through, and the reason it needs one at all.
//
// The data was already being captured and already being stored: `exec-stream-parse.mjs` keeps each
// Edit's `old_string`/`new_string` and each Write's `content`, capped at its own
// FILE_EDIT_FIELD_CAP_LEN = 4000 chars per field, MAX_FILE_EDITS_PER_TURN = 50 edits per turn — and
// this module returns up to MAX_CHAT_RUNS_PER_PROJECT = 50 runs. Multiplied out, an unbounded
// projection could hand a single `GET /api/chat-runs` response ~20 MB of diff text (50 runs x 50
// edits x 2 fields x 4000 chars). Those per-field caps bound ONE edit; nothing bounded the response.
//
// 256,000 characters (~256 KB, ~32 maximum-size Edits or ~64 maximum-size Writes) is the ceiling
// for one whole response. It is spent in the order rows are returned — newest run first, and within
// a run in the order the edits were actually made — so the diffs a reviewer is most likely to be
// looking at are the ones that survive. It is a real ceiling, not a guess: a realistic chat run
// edits a handful of files, so this only ever engages in a genuinely pathological case.
//
// WHAT HAPPENS WHEN IT IS HIT — the honesty rule this whole module is built on: the edit is NEVER
// dropped and its text is NEVER silently sliced. The edit row stays, with its real tool and real
// file path, and reports `diff_state: 'omitted_budget'` plus the real `diff_budget_chars` number,
// so the UI can say exactly why the diff is missing instead of showing an empty diff (which would
// read as "nothing changed") or a half-diff (which would read as a complete change that it isn't).
// Once the budget is exhausted it stays exhausted for the rest of the response — a later, smaller
// edit is not quietly slipped in ahead of an earlier, larger one, so the boundary is one clean cut
// a reader can reason about rather than a scattered set of holes.
const CHAT_RUN_DIFF_BUDGET_CHARS = 256_000;

function findAssistantTurn(turns, turnId) {
  return turns.find((t) => t.role === 'assistant' && t.turn_id === turnId) || null;
}

function wasNeverStarted(events, turnId) {
  return events.some((e) => e.turn_id === turnId && e.kind === 'execution_not_started');
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// feat-chatrun-diff: the projection this module always should have had.
//
// WHAT CHANGED AND WHY: this function used to return only `{tool, file_path}`. Every other field
// was already there, one line earlier — `exec-stream-parse.mjs`'s `extractFileEditFromToolUseBlock`
// captures each Edit's `old_string`/`new_string` and each Write's `content` from the CLI's own real
// `tool_use` block, and `conversations.mjs` redacts them on the way to disk AND again on the way
// back out (`conversation-redact.mjs`'s `redactDeep(next.file_edits)`). The gateway therefore knew
// exactly what changed and threw it away here, which is why the UI could only honestly say "not
// tracked" about a change it genuinely had. Nothing new is captured, no new event kind, no new
// endpoint: the same already-redacted record is simply no longer discarded.
//
// `diff_state` is the honesty carrier, and it is the reason this returns a state instead of just
// the three strings:
//   'present' — at least one of the three fields is a real recorded string. The UI can render it.
//   'none'    — the record genuinely carries no before/after text. The overwhelmingly common cause
//               is an OLDER run, recorded before this capture existed (its stored shape really is
//               just tool + path). This must stay distinguishable from 'present': an empty diff on
//               screen would claim "this edit changed nothing", which is a different — and false —
//               statement from "no diff was recorded for this edit".
//   'omitted_budget' — set later, by applyDiffBudget(), never here.
// A Write never carries old/new (there is no "before" — it replaces the file) and an Edit never
// carries content; the absent side is an honest `null`, never a fabricated empty string.
function toFileEditRow(edit) {
  if (!edit || typeof edit !== 'object') return null;
  const oldString = typeof edit.old_string === 'string' ? edit.old_string : null;
  const newString = typeof edit.new_string === 'string' ? edit.new_string : null;
  const content = typeof edit.content === 'string' ? edit.content : null;
  return {
    tool: typeof edit.tool === 'string' ? edit.tool : null,
    file_path: typeof edit.file_path === 'string' ? edit.file_path : null,
    old_string: oldString,
    new_string: newString,
    content,
    diff_state: oldString !== null || newString !== null || content !== null ? 'present' : 'none',
  };
}

function diffCostOf(edit) {
  return (
    (edit.old_string === null ? 0 : edit.old_string.length) +
    (edit.new_string === null ? 0 : edit.new_string.length) +
    (edit.content === null ? 0 : edit.content.length)
  );
}

/**
 * Spends CHAT_RUN_DIFF_BUDGET_CHARS across the response, in the order the rows are actually
 * returned, and reports every edit it could not afford. See the constant's own comment above for
 * the ceiling's rationale and for exactly what "reports" means here (the edit survives with its
 * real tool/path; only the diff text is absent, and it says so).
 *
 * Mutates the freshly-built row objects in place — they are constructed per call by
 * `buildChatRun()` and are never shared with the store, so nothing outside this call can observe
 * a half-budgeted row. `diff_state:'none'` edits cost nothing and are never touched: there is no
 * text to omit, and rewriting them to 'omitted_budget' would replace one honest statement with a
 * different, wrong one.
 */
function applyDiffBudget(rows) {
  let spent = 0;
  let exhausted = false;
  for (const row of rows) {
    for (let i = 0; i < row.file_edits.length; i += 1) {
      const edit = row.file_edits[i];
      if (edit.diff_state !== 'present') continue;
      const cost = diffCostOf(edit);
      if (!exhausted && spent + cost <= CHAT_RUN_DIFF_BUDGET_CHARS) {
        spent += cost;
        continue;
      }
      exhausted = true;
      row.file_edits[i] = {
        ...edit,
        old_string: null,
        new_string: null,
        content: null,
        diff_state: 'omitted_budget',
        diff_budget_chars: CHAT_RUN_DIFF_BUDGET_CHARS,
      };
    }
  }
  return rows;
}

function toTodoRow(todo) {
  return {
    content: todo && typeof todo === 'object' && typeof todo.content === 'string' ? todo.content : null,
    status: todo && typeof todo === 'object' && typeof todo.status === 'string' ? todo.status : null,
    activeForm: todo && typeof todo === 'object' && typeof todo.activeForm === 'string' ? todo.activeForm : null,
  };
}

// fix-run-visibility: a still-running execution's LIVE activity, read straight off the SAME
// `todo_snapshot`/`file_edit` events exec-lifecycle.mjs already emits the moment each tool_use block
// is parsed (see exec-lifecycle.mjs's own `rl.on('line')` handler — feat-live-stream gap #1). This
// replaces the old "never incrementally" comment below, which was true before feat-live-stream
// existed but has been stale since: a live consumer (this function, the dashboard's Tasks tab) can
// see real todos/file_edits for a run that has not closed yet, not just an honest-but-useless empty
// placeholder. `todo_snapshot`'s data always carries the FULL current list (exec-lifecycle.mjs's own
// `todoSnapshot` accumulator is overwritten, never appended, on each TodoWrite call) — so only the
// LATEST snapshot event for this turn is real; every earlier one is stale by construction. Each
// `file_edit` event carries exactly one edit, so every one of them for this turn is collected, in the
// order they were recorded (the same order exec-lifecycle.mjs's own final `file_edits` array would
// have used, had the turn already closed). No live events yet for this turn -> a genuinely empty
// list, exactly as honest as the placeholder this replaces.
function collectLiveTodos(events, turnId) {
  const snapshots = events.filter((e) => e.turn_id === turnId && e.kind === 'todo_snapshot');
  if (snapshots.length === 0) return [];
  const latest = snapshots[snapshots.length - 1];
  const todos = latest.data && Array.isArray(latest.data.todos) ? latest.data.todos : [];
  return todos.map(toTodoRow);
}

function collectLiveFileEdits(events, turnId) {
  return events
    .filter((e) => e.turn_id === turnId && e.kind === 'file_edit')
    .map((e) => toFileEditRow(e.data))
    .filter((e) => e !== null);
}

// One real chat-run record — either a real, closed execution (`assistantTurn` present: a normal
// completion, a model-reported error, or exec-bridge.mjs's own wall-clock `timed_out` path) or a
// currently RUNNING one (`assistantTurn` is null, but exec-bridge.mjs's own `running` map still
// holds this conversation busy for this exact turn — see `listChatRuns`'s own caller for why that is
// always this turn and never a different, unrelated one).
function buildChatRun(conv, userTurn, assistantTurn) {
  const runId = 'chat-' + conv.id + '-' + userTurn.turn_id;
  const title = deriveTitleFromText(userTurn.text);

  if (!assistantTurn) {
    return {
      run_id: runId,
      conversation_id: conv.id,
      title,
      status: 'running',
      started_at: userTurn.created_at || null,
      ended_at: null,
      duration_ms: null,
      stop_reason: null,
      model: null,
      input_tokens: null,
      output_tokens: null,
      // fix-run-visibility: real, LIVE todos/file_edits for a still-running execution — see
      // collectLiveTodos()/collectLiveFileEdits() above for exactly which events these come from and
      // why they are never fabricated. An honest empty list when no live event has landed yet.
      todos: collectLiveTodos(conv.events, userTurn.turn_id),
      file_edits: collectLiveFileEdits(conv.events, userTurn.turn_id),
    };
  }

  const status = assistantTurn.stop_reason === 'timed_out' ? 'timed_out' : assistantTurn.error ? 'failed' : 'completed';
  const fileEdits = Array.isArray(assistantTurn.file_edits) ? assistantTurn.file_edits.map(toFileEditRow).filter((e) => e !== null) : [];
  const todos = Array.isArray(assistantTurn.todos) ? assistantTurn.todos.map(toTodoRow) : [];

  return {
    run_id: runId,
    conversation_id: conv.id,
    title,
    status,
    started_at: userTurn.created_at || null,
    ended_at: assistantTurn.created_at || null,
    duration_ms: numberOrNull(assistantTurn.duration_ms),
    stop_reason: assistantTurn.stop_reason || null,
    model: assistantTurn.model || null,
    input_tokens: numberOrNull(assistantTurn.input_tokens),
    output_tokens: numberOrNull(assistantTurn.output_tokens),
    todos,
    file_edits: fileEdits,
  };
}

// Newest first — the same recency convention `runs.mjs`'s own `listRuns()` uses for Forge runs.
// `ended_at` is preferred (a finished run's real completion time); a still-running run has none yet,
// so it sorts by its own `started_at` instead. A tie (or two missing timestamps) falls back to a
// stable run-id tiebreak, never a random re-order between two otherwise-identical calls.
function compareChatRunsByRecency(a, b) {
  const aKey = a.ended_at || a.started_at || '';
  const bKey = b.ended_at || b.started_at || '';
  if (aKey === bKey) return b.run_id.localeCompare(a.run_id);
  return aKey < bKey ? 1 : -1;
}

/**
 * Returns every real chat-run this gateway's own conversation store has for `projectName` (the
 * project's registry name — the SAME string `conv.meta.project` was already validated against at
 * conversation-creation time, `server.mjs`'s `resolveProjectByName`), newest first, bounded to the
 * last `MAX_CHAT_RUNS_PER_PROJECT`. Never throws; an unreadable conversation is skipped, not fatal.
 */
export function listChatRuns(projectName) {
  if (typeof projectName !== 'string' || projectName.length === 0) return [];

  const summaries = listConversations().filter((c) => c.project === projectName);
  const rows = [];

  for (const summary of summaries) {
    const conv = readConversation(summary.id);
    if (!conv.ok) continue;

    const userTurns = conv.turns.filter((t) => t.role === 'user' && typeof t.turn_id === 'string');
    for (const userTurn of userTurns) {
      const assistantTurn = findAssistantTurn(conv.turns, userTurn.turn_id);

      if (!assistantTurn) {
        // Honesty gate: "no execution -> no run". A send that never even started (gateway-wide
        // capacity, missing CLI, ...) records an honest `execution_not_started` event and nothing
        // else — that must never be shown as a "run". A send that IS currently executing (this
        // conversation's exec-bridge.mjs slot is still occupied — and the 409 duplicate-send guard
        // in server.mjs means at most ONE such turn can ever be unresolved per conversation at a
        // time, so "busy" unambiguously means THIS turn) is a real, in-progress run. Anything else
        // (neither an `execution_not_started` event exists nor is the conversation busy — e.g. a
        // gateway restart mid-turn) is a genuinely ambiguous state this module refuses to guess at,
        // so it is skipped rather than invented as either status.
        if (wasNeverStarted(conv.events, userTurn.turn_id)) continue;
        if (!isConversationBusy(conv.id)) continue;
      }

      rows.push(buildChatRun(conv, userTurn, assistantTurn));
    }
  }

  rows.sort(compareChatRunsByRecency);
  // feat-chatrun-diff: budgeted AFTER the sort and the slice, deliberately — the budget is then
  // spent on the runs this response actually returns, newest first, instead of on runs that are
  // about to be cut anyway.
  return applyDiffBudget(rows.slice(0, MAX_CHAT_RUNS_PER_PROJECT));
}

export const _MAX_CHAT_RUNS_PER_PROJECT_FOR_TESTS = MAX_CHAT_RUNS_PER_PROJECT;
export const _CHAT_RUN_DIFF_BUDGET_CHARS_FOR_TESTS = CHAT_RUN_DIFF_BUDGET_CHARS;
