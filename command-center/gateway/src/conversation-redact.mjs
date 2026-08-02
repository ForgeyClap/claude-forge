// Forge Command Center gateway — conversation record redaction pass-through
// (refactor-gateway-split, forge-2026-07-30-cc-finish). Split out of the single conversations.mjs
// (had grown to ~546 lines, over this project's own 500-line-per-file guidance) into its own real
// seam: the read-side defense-in-depth redaction every stored/streamed record passes through. See
// conversations.mjs's own header for the full architecture/history/honesty rules this slice still
// follows; no other file in the codebase needed to change a single import.
import { redact, redactNullable, redactDeep } from './redact.mjs';

// WP10 should-fix-now #12: redacted on the READ side too (not only on write) — defense in depth
// for any record written before this fix existed, or by a future write path that forgets to
// redact. `turn` records carry free-text (`text`/`stderr`); `event` records carry a `data` field
// whose shape is whatever the child/parser produced (a string OR an arbitrarily nested object) —
// WP8-13 gap-closing round extends this same defense-in-depth layer to `event` records too
// (redactDeep(), structure-preserving), since appendConversationEvent()'s own write-side redaction
// only covers records written AFTER that fix landed. Every other record type passes through
// unchanged. Idempotent: redacting already-redacted text is a no-op (the `[REDACTED:...]` marker
// matches none of the 5 secret patterns).
export function redactRecordForRead(record) {
  if (!record) return record;
  if (record.type === 'turn') {
    const next = { ...record };
    if (typeof next.text === 'string') next.text = redact(next.text);
    if ('stderr' in next) next.stderr = redactNullable(next.stderr);
    // fix-stream-insights: `file_edits` (Edit/Write tool_use blocks — file paths and/or file
    // content/diff strings) and `todos` (a TodoWrite snapshot) are free text an agent/child
    // process shapes freely, the exact same "could carry a credential anywhere" class WP8-13
    // already fixed for `event.data` — redactDeep() preserves the array/object shape and passes
    // null through unchanged (a turn that never called these tools keeps its honest null).
    if ('file_edits' in next) next.file_edits = redactDeep(next.file_edits);
    if ('todos' in next) next.todos = redactDeep(next.todos);
    // feat-live-stream: `shell_commands` (real Bash command/description/result text) is the exact
    // same free-text class — a command or its captured output can carry a credential just as
    // easily as an Edit's old_string/new_string can.
    if ('shell_commands' in next) next.shell_commands = redactDeep(next.shell_commands);
    return next;
  }
  if (record.type === 'event' && 'data' in record) {
    return { ...record, data: redactDeep(record.data) };
  }
  return record;
}
