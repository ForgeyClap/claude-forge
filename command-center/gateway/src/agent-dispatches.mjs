// Forge Command Center gateway — project-scoped real subagent-dispatch summary
// (feat-live-visibility, work package feat-live-visibility, Gap B: "no 'live now' view of the
// agents actually working").
//
// PURE READ, mirrors chat-runs.mjs's own project-scoping convention (listConversations().filter
// by project, then readConversation() per row, bounded, never fatal on one bad file).
//
// REAL SHAPE THIS READS (live-verified against this project's own `.data/conversations/*.jsonl`,
// forge-2026-07-30-cc-finish mission notes): exec-lifecycle.mjs's own `rl.on('line', ...)` handler
// already appends EVERY raw claude-CLI stream-json line as a conversation `event` whose `kind`
// equals the line's own `type` (`appendConversationEvent(convId, { kind: parsed.type || 'unknown',
// data: redactDeep(parsed) })`) — so a real subagent dispatch's lifecycle rides on THREE such
// events, all `kind: 'system'`:
//   - `subtype: 'task_started'`  — `data.task_id`, `data.tool_use_id`, `data.description`,
//     `data.subagent_type` (present ONLY for a real `Agent` dispatch — `data.task_type ===
//     'local_agent'`; a background Bash command reports `task_type: 'local_bash'` on the SAME
//     subtype with NO `subagent_type` field at all, and is deliberately excluded below).
//   - `subtype: 'task_progress'` — zero or more, ignored here (no lifecycle-relevant field).
//   - `subtype: 'task_updated'`  — `data.task_id`, `data.patch.status` (every real example
//     captured on this machine reports `'completed'`, but the real string is read through
//     verbatim rather than hardcoded, in case a future CLI version reports e.g. `'failed'`).
// A `task_id` with a `task_started` but NO later `task_updated` is either genuinely still running
// RIGHT NOW, or was abandoned mid-flight (the conversation's own execution ended without ever
// reporting completion) — `isConversationBusy(convId)` (exec-bridge.mjs's own live, in-process
// `running` Map, never derived from stored data) is the one honest way to tell those two apart:
// only a still-BUSY conversation's unresolved dispatch is reported as `running: true` here. An
// unresolved dispatch on a conversation that is NOT busy is real (a task_started event with no
// resolution genuinely exists), but claiming either "still running" or "completed" for it would be
// a guess — it is surfaced with `running: false, resolved_status: null`, never invented as either.
//
// feat-subagent-visibility AMENDMENT to the "appends EVERY raw line" statement above: that is no
// longer true for ONE class of line. A stream line carrying a non-null `parent_tool_use_id` belongs
// to a dispatched subagent, not to the conversation, and exec-lifecycle.mjs now routes it to its own
// bounded `subagent_activity` event (plus, on overflow, a single `subagent_activity_truncated`
// marker) INSTEAD of the raw append — see that file's own routing branch for why. Every other line
// still lands raw exactly as described. Two more real signals are read back here as a result:
//   - `subagent_activity` events, correlated to a dispatch by `data.parent_tool_use_id` ===
//     `task_started.tool_use_id` (live-verified against test/fixtures/subagent-stream-*.jsonl).
//   - `hook_event` events for the SubagentStart/SubagentStop hooks, which give a dispatch a real
//     start/end time reported by the HARNESS rather than derived from the task_* pair — attached
//     only when unambiguous (a hook line carries no parent_tool_use_id at all; see
//     collectSubagentHookTimes below), and an honest null otherwise. On a machine with no matching
//     hooks configured, no hook event is emitted at all and both times stay null — that is expected,
//     not a failure.
import { listConversations, readConversation } from './conversations.mjs';
import { isConversationBusy } from './exec-bridge.mjs';

// Mirrors chat-runs.mjs's own MAX_CHAT_RUNS_PER_PROJECT convention — a real ceiling, not a guess:
// this gateway's own dashboard project realistically has a handful to a few dozen conversations,
// never thousands.
const MAX_CONVERSATIONS_SCANNED = 50;
const MAX_DISPATCH_ROWS = 200;

// feat-subagent-visibility: how many of a dispatch's own live activity lines a row carries. The
// WRITE side already bounds total bytes per dispatch (exec-lifecycle.mjs's
// SUBAGENT_ACTIVITY_BYTES_PER_DISPATCH budget); this is the READ-side bound, and it deliberately
// keeps the LAST N rather than the first — a live strip wants what the subagent is doing NOW.
// `activity_truncated` on the row stays honest about anything either bound dropped.
const MAX_ACTIVITY_LINES_PER_DISPATCH = 20;

function compareByRecency(a, b) {
  const aKey = a.updated_at || '';
  const bKey = b.updated_at || '';
  if (aKey === bKey) return 0;
  return aKey < bKey ? 1 : -1;
}

function collectStartedLocalAgentTasks(events) {
  // task_id -> { subagentType, description, startedAt, toolUseId }
  const started = new Map();
  for (const event of events) {
    if (event.kind !== 'system') continue;
    const data = event.data && typeof event.data === 'object' ? event.data : null;
    if (!data || data.subtype !== 'task_started') continue;
    if (data.task_type !== 'local_agent') continue; // excludes local_bash and any other task_type
    const taskId = typeof data.task_id === 'string' ? data.task_id : null;
    const subagentType = typeof data.subagent_type === 'string' && data.subagent_type.length > 0 ? data.subagent_type : null;
    if (taskId === null || subagentType === null) continue;
    started.set(taskId, {
      subagentType,
      description: typeof data.description === 'string' ? data.description : null,
      startedAt: event.created_at || null,
      // feat-subagent-visibility: the correlation key. `task_started.tool_use_id` is the SAME id
      // the subagent's own stream lines carry as `parent_tool_use_id` (live-verified against the
      // real captures in test/fixtures/subagent-stream-*.jsonl), so this is what ties a dispatch
      // row to the activity that dispatch actually produced. It was already present on the real
      // event and simply thrown away before.
      toolUseId: typeof data.tool_use_id === 'string' && data.tool_use_id.length > 0 ? data.tool_use_id : null,
    });
  }
  return started;
}

// feat-subagent-visibility: every `subagent_activity` event this conversation recorded, grouped by
// the dispatch it belongs to. Read-side bounded to the LAST MAX_ACTIVITY_LINES_PER_DISPATCH lines;
// `truncated` is true when this read dropped older lines OR when the WRITE side already hit its own
// per-dispatch byte budget (a `subagent_activity_truncated` marker event) — either way the row says
// so instead of silently presenting a partial transcript as complete.
function collectSubagentActivity(events) {
  const byParent = new Map(); // parent_tool_use_id -> { lines: [...], truncated: boolean }
  for (const event of events) {
    const data = event.data && typeof event.data === 'object' ? event.data : null;
    if (!data) continue;
    const parentId = typeof data.parent_tool_use_id === 'string' && data.parent_tool_use_id.length > 0 ? data.parent_tool_use_id : null;
    if (parentId === null) continue;
    if (event.kind !== 'subagent_activity' && event.kind !== 'subagent_activity_truncated') continue;
    let bucket = byParent.get(parentId);
    if (!bucket) {
      bucket = { lines: [], truncated: false };
      byParent.set(parentId, bucket);
    }
    if (event.kind === 'subagent_activity_truncated') {
      bucket.truncated = true;
      continue;
    }
    bucket.lines.push({
      role: typeof data.role === 'string' ? data.role : null,
      entries: Array.isArray(data.entries) ? data.entries : [],
      at: event.created_at || null,
    });
    if (bucket.lines.length > MAX_ACTIVITY_LINES_PER_DISPATCH) {
      bucket.lines.shift();
      bucket.truncated = true;
    }
  }
  return byParent;
}

// feat-subagent-visibility: the harness's OWN SubagentStart/SubagentStop hook lifecycle times, as
// recorded by exec-lifecycle.mjs's `hook_event` branch. The `hook_started` phase is used for both
// (that is the moment the lifecycle event actually fired; the paired `hook_response` only reports
// how the hook script itself exited).
//
// HONEST LIMITATION, not an implementation shortcut: every real hook line has
// `parent_tool_use_id: null`, so a hook event cannot be tied to a specific dispatch by id. A
// SubagentStart carries its type only as a `hook_name` suffix ("SubagentStart:general-purpose") and
// a SubagentStop carries no type at all. These times are therefore attached ONLY when they are
// unambiguous — see attachHookTimes below — and stay null otherwise rather than being guessed.
function collectSubagentHookTimes(events) {
  const startsByType = new Map(); // subagent_type -> [ISO, ...]
  const stops = [];
  for (const event of events) {
    if (event.kind !== 'hook_event') continue;
    const data = event.data && typeof event.data === 'object' ? event.data : null;
    if (!data || data.phase !== 'started') continue;
    if (data.hook_event === 'SubagentStart') {
      const type = typeof data.subagent_type === 'string' && data.subagent_type.length > 0 ? data.subagent_type : '';
      if (!startsByType.has(type)) startsByType.set(type, []);
      startsByType.get(type).push(event.created_at || null);
    } else if (data.hook_event === 'SubagentStop') {
      stops.push(event.created_at || null);
    }
  }
  return { startsByType, stops };
}

function collectUpdatedTasks(events) {
  // task_id -> { status, endedAt }
  const updated = new Map();
  for (const event of events) {
    if (event.kind !== 'system') continue;
    const data = event.data && typeof event.data === 'object' ? event.data : null;
    if (!data || data.subtype !== 'task_updated') continue;
    const taskId = typeof data.task_id === 'string' ? data.task_id : null;
    if (taskId === null) continue;
    const patch = data.patch && typeof data.patch === 'object' ? data.patch : null;
    const status = patch && typeof patch.status === 'string' ? patch.status : null;
    // Real, later events overwrite an earlier one for the same task_id — mirrors this codebase's
    // own "last one wins" convention (exec-lifecycle.mjs's `lastAgentType`) rather than keeping
    // only the first.
    updated.set(taskId, { status, endedAt: event.created_at || null });
  }
  return updated;
}

/**
 * Every real subagent dispatch recorded for `projectName`'s conversations (bounded to the most
 * recently updated `MAX_CONVERSATIONS_SCANNED` conversations, then to `MAX_DISPATCH_ROWS` rows) —
 * one row per dispatch: `{ subagent_type, conversation_id, description, started_at, running,
 * resolved_status, ended_at }`. `running` is `true` ONLY for an unresolved dispatch whose own
 * conversation is currently busy (see this file's own header for why). An unknown/empty project
 * name, or a project with no recorded dispatch at all, reads back an honest empty array, never a
 * throw or a fabricated row.
 */
export function listAgentDispatches(projectName) {
  if (typeof projectName !== 'string' || projectName.length === 0) return [];

  const summaries = listConversations()
    .filter((c) => c.project === projectName)
    .sort(compareByRecency)
    .slice(0, MAX_CONVERSATIONS_SCANNED);

  const rows = [];
  for (const summary of summaries) {
    const conv = readConversation(summary.id);
    if (!conv.ok) continue;

    const started = collectStartedLocalAgentTasks(conv.events);
    if (started.size === 0) continue;
    const updated = collectUpdatedTasks(conv.events);
    const busy = isConversationBusy(summary.id);
    const activityByParent = collectSubagentActivity(conv.events);
    const hookTimes = collectSubagentHookTimes(conv.events);

    // Ambiguity gates for the hook-derived times (see collectSubagentHookTimes' own comment): a
    // SubagentStart time is attachable only when this conversation has exactly ONE dispatch of that
    // subagent type AND exactly ONE SubagentStart hook for it; a SubagentStop time only when this
    // conversation has exactly ONE dispatch in total AND exactly ONE SubagentStop hook (a
    // SubagentStop hook line carries no subagent type at all, so nothing finer is honest).
    const dispatchCountByType = new Map();
    for (const task of started.values()) {
      dispatchCountByType.set(task.subagentType, (dispatchCountByType.get(task.subagentType) || 0) + 1);
    }
    const stopAttachable = started.size === 1 && hookTimes.stops.length === 1;

    for (const [taskId, task] of started) {
      const resolution = updated.get(taskId) ?? null;
      const activity = task.toolUseId !== null ? (activityByParent.get(task.toolUseId) ?? null) : null;
      const startsForType = hookTimes.startsByType.get(task.subagentType) ?? [];
      const startAttachable = startsForType.length === 1 && dispatchCountByType.get(task.subagentType) === 1;
      rows.push({
        subagent_type: task.subagentType,
        conversation_id: summary.id,
        description: task.description,
        started_at: task.startedAt,
        running: resolution === null && busy,
        resolved_status: resolution ? resolution.status : null,
        ended_at: resolution ? resolution.endedAt : null,
        // feat-subagent-visibility — every field below is a REAL recorded value or an honest null:
        tool_use_id: task.toolUseId,
        activity: activity ? activity.lines : [],
        activity_truncated: activity ? activity.truncated : false,
        hook_started_at: startAttachable ? startsForType[0] : null,
        hook_ended_at: stopAttachable ? hookTimes.stops[0] : null,
      });
    }
  }

  rows.sort((a, b) => {
    const aKey = a.started_at || '';
    const bKey = b.started_at || '';
    if (aKey === bKey) return 0;
    return aKey < bKey ? 1 : -1; // newest first
  });
  return rows.slice(0, MAX_DISPATCH_ROWS);
}

export const _MAX_CONVERSATIONS_SCANNED_FOR_TESTS = MAX_CONVERSATIONS_SCANNED;
export const _MAX_DISPATCH_ROWS_FOR_TESTS = MAX_DISPATCH_ROWS;
