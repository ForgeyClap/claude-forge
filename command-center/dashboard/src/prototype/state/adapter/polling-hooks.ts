/**
 * Forge Command Center — gateway adapter, per-resource polling hooks slice
 * (WP refactor-adapter-split).
 *
 * Split out of the single `gateway-adapter.ts` (was ~2400 lines) into its already-marked
 * "8. Per-resource polling hooks" + "8b. Project profile" sections, verbatim, plus the
 * event-accumulation group (`createCoalescedRunner`, `GatewayEventsState`,
 * `foldGatewayEventsResponse`, `createEventsAccumulator`, `useGatewayEvents`,
 * `useGatewayEventsMeta`) — those five were textually sitting under the original file's "8c.
 * Chat-runs" section header even though none of them are chat-run concerns (a mislabeling from a
 * header never having been added when they were written); they belong here instead, alongside the
 * other resource-polling hooks that keep data fresh via a poll + (where relevant) an SSE tail. See
 * `gateway-adapter.ts`'s own header for the full architecture/history/honesty rules this slice
 * still follows. `useGatewayProjectRows`, `useGatewayProjectRuns`, `useGatewayProjectAgents`,
 * `useGatewayMission`, `useGatewayProof`, and `useGatewayProofAll` gained an `export` keyword they
 * did not have in the single-file version, purely so `dataset.ts` can call them across a file
 * boundary — `gateway-adapter.ts`'s own public re-export list is unchanged either way, since none
 * of those six were part of it.
 */

import { useEffect, useMemo, useState } from 'react';

import { gwEventSource, gwGet, pickArray, pickBool, pickNumber, pickString } from '@/prototype/state/gateway-client';

import { PROJECT_DATA_POLL_MS, type Keyed } from './shared';
import { parseAgentRows, parseMissionPayload, parseProjectRows, parseRunRows, type AgentRow, type MissionPayload, type ProjectRow, type RunRow } from './rows';

/* ========================================================================== */
/*  8. Per-resource polling hooks                                             */
/* ========================================================================== */

// cc-fix-dash-latency (forge-2026-07-29-cc-finish, WP fix-dash-latency, D2): a new project used to
// take up to ~45s to appear (30s server TTL + one 15s client poll). cc-fix-gateway-perf already cut
// the server side to `CACHE_TTL_MS = 5_000` (`gateway/src/projects.mjs`, read live before choosing
// a value here). The remaining worst case is: (server TTL, until the stale cache is even noticed as
// expired) + (one client poll interval, for THIS store's own poll to fetch the now-current data).
// That gives the target formula the work package asks for: worst_case = server_TTL + poll_interval.
//
// A naive "just pick something under 5s" is not enough — `listProjects()`'s stale-while-revalidate
// design (a request that finds the cache expired returns the OLD value immediately and refreshes in
// the BACKGROUND; only the NEXT request sees the refreshed data) means the real worst case follows
// `ceil(TTL / P) * P + P`, not the flat `TTL + P` sum, whenever P does not evenly divide TTL — e.g.
// P=4000ms against TTL=5000ms actually gives ceil(5000/4000)*4000+4000 = 12000ms (12s, WORSE than
// the naive 9s estimate would suggest), because the first poll after expiry only ever TRIGGERS the
// refresh, it does not itself receive the refreshed value.
//
// PROJECTS_POLL_MS = 2500ms is HALF of CACHE_TTL_MS (an exact divisor, so `ceil(TTL/P) == TTL/P`
// with no rounding-up penalty) — worst_case = ceil(5000/2500)*2500 + 2500 = 5000 + 2500 = 7500ms,
// i.e. 7.5s, comfortably inside the 10s Nielsen threshold with real margin, not shaved to the edge.
// Deliberately NOT pushed faster than that: the goal is "under 10s", not "as fast as possible" (see
// the work package) — every extra poll is a real request, even though most are cheap in-memory
// cache hits server-side.
export const PROJECTS_POLL_MS = 2500;

export function useGatewayProjectRows(): readonly ProjectRow[] {
  const [rows, setRows] = useState<readonly ProjectRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet('/api/projects');
      if (cancelled || !result.ok) return;
      setRows(parseProjectRows(result.data));
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return rows;
}

const EMPTY_RUN_ROWS: readonly RunRow[] = [];
const EMPTY_AGENT_ROWS: readonly AgentRow[] = [];
const EMPTY_RAW_EVENTS: readonly Record<string, unknown>[] = [];

export function useGatewayProjectRuns(projectName: string): readonly RunRow[] {
  const [state, setState] = useState<Keyed<readonly RunRow[]>>({ key: '', value: EMPTY_RUN_ROWS });
  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/runs?project=${encodeURIComponent(projectName)}`);
      if (cancelled || !result.ok) return;
      setState({ key: projectName, value: parseRunRows(result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);
  return state.key === projectName ? state.value : EMPTY_RUN_ROWS;
}

/**
 * cc-fix-dash-latency: `ActivityView` needs `event_scan_error` per run (WP fix-dash-latency #3),
 * but `Run` (`prototype-types.ts`) is out of this WP's write scope and stays frozen to its existing
 * shape — mirroring the SAME precedent `useGatewayEventsMeta` already established for
 * `truncated`/`malformedLines`: a small dedicated hook the consuming view mounts directly,
 * independent of `useGatewayDataset`'s own internal `useGatewayProjectRuns` call for the same
 * project. Named tradeoff, same as that one: this is a SECOND independent poll of `/api/runs`
 * while the view is mounted — real extra traffic, but cheap (an unchanged run is now served
 * straight from `runs.mjs`'s own P1-2 scan cache, not re-parsed from disk on every poll).
 */
export function useGatewayRunScanErrors(projectName: string): ReadonlyMap<string, string | null> {
  const runRows = useGatewayProjectRuns(projectName);
  return useMemo(() => {
    const map = new Map<string, string | null>();
    for (const row of runRows) map.set(row.runId, row.eventScanError);
    return map;
  }, [runRows]);
}

export function useGatewayProjectAgents(projectName: string): readonly AgentRow[] {
  const [state, setState] = useState<Keyed<readonly AgentRow[]>>({ key: '', value: EMPTY_AGENT_ROWS });
  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/agents?project=${encodeURIComponent(projectName)}`);
      if (cancelled || !result.ok) return;
      setState({ key: projectName, value: parseAgentRows(result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);
  return state.key === projectName ? state.value : EMPTY_AGENT_ROWS;
}

function missionKey(projectName: string, runId: string | null): string {
  return runId === null ? '' : `${projectName}::${runId}`;
}

export function useGatewayMission(projectName: string, runId: string | null): MissionPayload | null {
  const [state, setState] = useState<Keyed<MissionPayload | null>>({ key: '', value: null });
  useEffect(() => {
    if (projectName === '' || runId === null) return undefined;
    const rid = runId; // narrowed const — stays non-null inside the closure below
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/missions?project=${encodeURIComponent(projectName)}&run=${encodeURIComponent(rid)}`);
      if (cancelled || !result.ok) return;
      setState({ key: missionKey(projectName, rid), value: parseMissionPayload(rid, result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName, runId]);
  return state.key === missionKey(projectName, runId) ? state.value : null;
}

export function useGatewayProof(projectName: string, runId: string | null): Record<string, unknown> | null {
  const [state, setState] = useState<Keyed<Record<string, unknown> | null>>({ key: '', value: null });
  useEffect(() => {
    if (projectName === '' || runId === null) return undefined;
    const rid = runId; // narrowed const — stays non-null inside the closure below
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/proof?project=${encodeURIComponent(projectName)}&run=${encodeURIComponent(rid)}`);
      if (cancelled || !result.ok) return;
      setState({ key: missionKey(projectName, rid), value: result.data });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName, runId]);
  return state.key === missionKey(projectName, runId) ? state.value : null;
}

/**
 * cc-fix-artifacts-empty: the project-wide artifact source — `GET /api/proof?run=all`
 * (`buildProofAll`, gateway/src/proof.mjs). Keyed on `projectName` ALONE (mirrors
 * `useGatewayProjectRuns`'s own precedent), never on a selected run — Artifacts is meant to show
 * everything the PROJECT has produced, not just whatever the currently-selected run happens to
 * carry (that was the actual bug: the prior single-run `useGatewayProof` fetch reported 0/0 for
 * every project whose newest run had not yet produced anything, even though older runs and the
 * forge-artifacts index carried real evidence). `proof`/`gates` (the verdict ledger) stay on
 * `useGatewayProof`'s existing per-run fetch below, unmodified — a verdict genuinely only makes
 * sense for the one run it came from.
 */
export function useGatewayProofAll(projectName: string): Record<string, unknown> | null {
  const [state, setState] = useState<Keyed<Record<string, unknown> | null>>({ key: '', value: null });
  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/proof?project=${encodeURIComponent(projectName)}&run=all`);
      if (cancelled || !result.ok) return;
      setState({ key: projectName, value: result.data });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);
  return state.key === projectName ? state.value : null;
}

/* ========================================================================== */
/*  8b. Project profile (cc-fix-adapter T6d) — GET /api/projects/:name/profile */
/* ========================================================================== */

/** Maps `GET /api/projects/:name/profile`'s real response 1:1 — a field is real, derived from a
 *  real response, or explicitly absent (never invented). See `toGatewayProject`'s own comment for
 *  why `projectTypeRaw` is never forced into the closed `ProjectType` union. */
export interface GatewayProjectProfile {
  readonly profilePresent: boolean;
  readonly projectName: string | null;
  readonly projectTypeRaw: string | null;
  readonly projectGoal: string | null;
  readonly maturity: string | null;
  readonly versionPresent: boolean;
  readonly forgeVersion: string | null;
  readonly syncedAt: string | null;
}

export const EMPTY_PROJECT_PROFILE: GatewayProjectProfile = {
  profilePresent: false,
  projectName: null,
  projectTypeRaw: null,
  projectGoal: null,
  maturity: null,
  versionPresent: false,
  forgeVersion: null,
  syncedAt: null,
};

export function parseProjectProfile(data: Record<string, unknown>): GatewayProjectProfile {
  return {
    profilePresent: pickBool(data, ['profile_present']) ?? false,
    projectName: pickString(data, ['project_name']),
    projectTypeRaw: pickString(data, ['project_type_raw']),
    projectGoal: pickString(data, ['project_goal']),
    maturity: pickString(data, ['maturity']),
    versionPresent: pickBool(data, ['version_present']) ?? false,
    forgeVersion: pickString(data, ['forge_version']),
    syncedAt: pickString(data, ['synced_at']),
  };
}

/** Polls the ACTIVE project's own real profile/version — same "real only for the selected
 *  project" cadence as `useGatewayProjectRuns`/`useGatewayProjectAgents`. */
export function useGatewayProjectProfile(projectName: string): GatewayProjectProfile {
  const [state, setState] = useState<Keyed<GatewayProjectProfile>>({ key: '', value: EMPTY_PROJECT_PROFILE });
  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/projects/${encodeURIComponent(projectName)}/profile`);
      if (cancelled || !result.ok) return;
      setState({ key: projectName, value: parseProjectProfile(result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);
  return state.key === projectName ? state.value : EMPTY_PROJECT_PROFILE;
}

/**
 * Codex F7: in-flight coalescing + trailing-refresh. `useGatewayEvents` below has TWO independent
 * refresh triggers (a poll interval and an SSE `onmessage`) that can fire while a previous `refresh()`
 * call is still awaiting its own `gwGet()` — without this, two overlapping fetches could resolve OUT
 * OF ORDER (a slow poll-triggered fetch settling AFTER a fast SSE-triggered one), letting the OLDER
 * response silently overwrite newer state. `createCoalescedRunner(fn)` returns a trigger that never
 * runs `fn` concurrently with itself: a trigger that arrives while one is already in flight sets a
 * "dirty" flag instead of starting a second overlapping call; the in-flight call re-runs itself
 * exactly once more after it settles when that flag is set. Every real fetch this hook performs is
 * therefore fully serialized — the race is closed at its root, not reconciled after the fact.
 * Exported (pure, no React/DOM/network) so it has its own direct hermetic unit test.
 */
export function createCoalescedRunner(fn: () => Promise<void>): () => void {
  let inFlight = false;
  let dirty = false;
  const run = (): void => {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    void fn()
      .catch(() => { /* fn already reports its own failures via a returned {ok:false}; a coalescing
        wrapper must still never let a rejection break the dirty-triggered re-run chain below */ })
      .finally(() => {
        inFlight = false;
        if (dirty) {
          dirty = false;
          run();
        }
      });
  };
  return run;
}

/**
 * cc-fix-events-honesty (P1-1 + P1-3): the accumulated, honesty-aware state one run's event
 * history folds into. `truncated`/`malformedLines` are real fields `events.mjs` already computes
 * server-side (`:180`, `:184`) that every caller used to discard via `pickArray(result.data,
 * ['events'])` alone — Activity then showed "N/N events" over a timeline whose beginning was
 * provably missing, with nothing on screen saying so. `truncated` is sticky-OR'd across every
 * read this run's lifetime (the gateway's own cache entry never un-truncates once it has dropped
 * a byte range — see `events.mjs:113-115`); `malformedLines` accumulates across reads because each
 * response's own `malformed_lines` is scoped to just the slice that response returned (the whole
 * history on a full read, only the new delta on an incremental one).
 */
export interface GatewayEventsState {
  readonly events: readonly Record<string, unknown>[];
  readonly truncated: boolean;
  readonly malformedLines: number;
}

const EMPTY_GATEWAY_EVENTS_STATE: GatewayEventsState = { events: EMPTY_RAW_EVENTS, truncated: false, malformedLines: 0 };

/**
 * Folds one real `/api/events` response into the running state — exported (pure, no React/DOM/
 * network) for a direct hermetic unit test, matching this file's own `createCoalescedRunner`
 * precedent. `isFullRead` distinguishes "`response.events` is the whole history" (first read for
 * this run, or a deliberate resync) from "just the delta since the previous `next_after` cursor".
 */
export function foldGatewayEventsResponse(
  previous: GatewayEventsState,
  response: Record<string, unknown>,
  isFullRead: boolean,
): GatewayEventsState {
  const newEvents = pickArray(response, ['events']);
  const malformed = pickNumber(response, ['malformed_lines']) ?? 0;
  const isTruncated = pickBool(response, ['truncated']) ?? false;
  return {
    events: isFullRead ? newEvents : [...previous.events, ...newEvents],
    truncated: previous.truncated || isTruncated,
    malformedLines: isFullRead ? malformed : previous.malformedLines + malformed,
  };
}

/**
 * cc-fix-events-honesty (P1-3): owns the incremental `after`/`next_after` cursor `server.mjs`
 * (`:97`) and `events.mjs` (`:143-186`) already implement — parsed and thrown away by every
 * caller until now, forcing a full O(n) re-download of a run's ENTIRE history on every single SSE
 * frame (O(n^2) bytes over a whole run; 5000 events meant the last frame re-sent 5000 records to
 * learn about one). `nextQuery()` appends `&after=<cursor>` once a cursor exists; `ingest()` folds
 * a response via `foldGatewayEventsResponse` and advances it from the response's own `next_after`.
 *
 * The REST `/api/events` protocol carries no generation/identity signal (unlike the SSE stream's
 * own `{generation, index}` cursor in `attachEventsStream()`), so the first time truncation is
 * newly observed on an INCREMENTAL read, the NEXT call resyncs with one full read — never trusting
 * an incremental delta layered on top of a boundary this client cannot otherwise verify. After
 * that one-time resync the cursor advances normally again; `truncated` itself stays sticky.
 * Exported standalone for a direct hermetic unit test — mirrors `createCoalescedRunner`.
 */
export function createEventsAccumulator(): {
  nextQuery: (baseQuery: string) => string;
  ingest: (response: Record<string, unknown>) => GatewayEventsState;
  current: () => GatewayEventsState;
} {
  let state: GatewayEventsState = EMPTY_GATEWAY_EVENTS_STATE;
  let cursor: number | null = null; // null => the next query is a full (after-less) read

  function nextQuery(baseQuery: string): string {
    return cursor === null ? baseQuery : `${baseQuery}&after=${cursor}`;
  }

  function ingest(response: Record<string, unknown>): GatewayEventsState {
    const isFullRead = cursor === null;
    const wasTruncated = state.truncated;
    state = foldGatewayEventsResponse(state, response, isFullRead);
    const nextAfter = pickNumber(response, ['next_after']);
    const justTruncated = state.truncated && !wasTruncated;
    cursor = justTruncated && !isFullRead ? null : (nextAfter ?? cursor);
    return state;
  }

  return { nextQuery, ingest, current: () => state };
}

/** The selected run's own events, kept fresh by a poll AND a real SSE tail. */
export function useGatewayEvents(projectName: string, runId: string | null): GatewayEventsState {
  const [state, setState] = useState<Keyed<GatewayEventsState>>({ key: '', value: EMPTY_GATEWAY_EVENTS_STATE });
  useEffect(() => {
    if (projectName === '' || runId === null) return undefined;
    const rid = runId; // narrowed const — stays non-null inside the closures below
    let cancelled = false;
    const query = `project=${encodeURIComponent(projectName)}&run=${encodeURIComponent(rid)}`;
    const accumulator = createEventsAccumulator(); // P1-3: incremental after/next_after cursor
    async function refresh(): Promise<void> {
      const result = await gwGet(`/api/events?${accumulator.nextQuery(query)}`);
      if (cancelled || !result.ok) return;
      setState({ key: missionKey(projectName, rid), value: accumulator.ingest(result.data) });
    }
    const trigger = createCoalescedRunner(refresh); // Codex F7 — poll + SSE never overlap a real fetch
    trigger();
    const pollId = setInterval(trigger, PROJECT_DATA_POLL_MS);

    let source: EventSource | null = null;
    try {
      source = gwEventSource(`/api/events/stream?${query}`);
      source.onmessage = () => trigger();
    } catch {
      source = null; // SSE is a bonus; the poll above still keeps this correct
    }

    return () => {
      cancelled = true;
      clearInterval(pollId);
      if (source !== null) source.close();
    };
  }, [projectName, runId]);
  return state.key === missionKey(projectName, runId) ? state.value : EMPTY_GATEWAY_EVENTS_STATE;
}

/**
 * cc-fix-events-honesty (P1-1): `ActivityView.tsx` needs `truncated`/`malformedLines` to show its
 * one honest metaline, but `PrototypeDataset`/`PrototypeProvider.tsx` are out of this WP's write
 * scope (they stay frozen to the exact shape every other view already reads) — so, mirroring the
 * already-established pattern for gateway data that never joined that shared shape
 * (`useGatewayApprovals`/`useGatewayRecovery`, mounted directly by their own consuming views, see
 * `gateway-recovery.ts`'s header), `ActivityView` mounts this hook directly, independent of
 * `useGatewayDataset`'s own internal `useGatewayEvents` call for the same run. Named tradeoff: this
 * is a SECOND independent poll + SSE connection to the same `/api/events` endpoint while Activity
 * is mounted — after the P1-3 fix above, every poll but the first is a cheap incremental delta, so
 * the added cost is one more small periodic request, not a second full history re-read.
 */
export function useGatewayEventsMeta(projectName: string, runId: string | null): Pick<GatewayEventsState, 'truncated' | 'malformedLines'> {
  const { truncated, malformedLines } = useGatewayEvents(projectName, runId);
  return { truncated, malformedLines };
}
