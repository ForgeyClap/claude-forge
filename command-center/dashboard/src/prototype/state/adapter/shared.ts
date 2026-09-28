/**
 * Forge Command Center — gateway adapter, shared cross-cutting primitives (WP refactor-adapter-split).
 *
 * Pure organizational extraction out of the single `gateway-adapter.ts` (was ~2400 lines) — see
 * that file's own header for the full architecture/history/honesty rules this split still follows.
 * Every name below used to be a private top-of-file declaration inside that one file, needed by
 * more than one of the sibling modules it has now been split into — no logic changed, only which
 * file a declaration physically lives in.
 */

import type { MissionGraph, StatusKey } from '@/prototype/types/prototype-types';

/* fix-status-honesty: 'waiting' here painted the WHOLE dashboard with wait-claims — all 23 project
 * cards, all 19 idle roster agents and loose activity lines showed WAITING while the Home header
 * honestly said "Nothing is running right now" (measured on the 2026-07-30 full-screenshot sweep).
 * Unknown is the absence of a status, and now renders as the quiet IDLE, never as a fake queue. */
export const STATUS_WHEN_UNKNOWN: StatusKey = 'idle';
export const EMPTY_GRAPH = { id: '', runId: '', lanes: [], nodes: [], edges: [] } as unknown as MissionGraph;

// Shared with `chat-runs.ts` (`useGatewayChatRuns` uses the same cadence) — see
// `polling-hooks.ts`'s own `PROJECTS_POLL_MS` comment for the sibling constant's full worst-case
// derivation.
export const PROJECT_DATA_POLL_MS = 5000;

/**
 * Every keyed poll below stores its own fetch key ALONGSIDE its payload and
 * gates the returned value on that key matching the current input — rather
 * than resetting state to empty from inside the effect body (which
 * `react-hooks/set-state-in-effect` correctly flags: an effect should
 * synchronize with an external system, not reset React state as a side
 * effect of its own guard clause). A key mismatch (an empty selection, or a
 * still-in-flight fetch for a newly selected project/run) reads as the
 * honest empty fallback with no extra render.
 */
export interface Keyed<T> {
  readonly key: string;
  readonly value: T;
}

/**
 * WP-CCD: collapses a list that may carry SEVERAL rows for the same real-world "thing" (a check
 * that was run more than once, e.g.) down to exactly one row per identity — the LATEST one by
 * array/file order, never "any failure ever wins". Mirrors this codebase's own established
 * "last one wins" convention (`missions.mjs`'s own `event_scan_error`/`lastAgentType` comments) —
 * reused here so Mission Control's Boss/Verify nodes, the Tests & proof gate board, Home's
 * "Failures and blockers" and the Dock's notices all agree that a check which failed once and later
 * passed reads as passing, not as permanently red.
 *
 * The RESULT preserves each identity's FIRST-SEEN position (so the list does not visually reshuffle
 * to "most-recently-updated first" — only the row shown per identity is the latest one), which is
 * why this is a real two-pass function rather than a one-line `Map` dedupe.
 */
export function dedupeLatestByKey<T>(rows: readonly T[], keyOf: (row: T) => string): readonly T[] {
  const lastIndexByKey = new Map<string, number>();
  rows.forEach((row, index) => {
    lastIndexByKey.set(keyOf(row), index);
  });
  const firstIndexByKey = new Map<string, number>();
  rows.forEach((row, index) => {
    const key = keyOf(row);
    if (!firstIndexByKey.has(key)) firstIndexByKey.set(key, index);
  });
  return [...lastIndexByKey.entries()]
    .sort((a, b) => (firstIndexByKey.get(a[0]) ?? 0) - (firstIndexByKey.get(b[0]) ?? 0))
    .map(([, index]) => rows[index]);
}
