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
import { parseAgentRows, parseCurrentRunId, parseDefaultProjectId, parseMissionPayload, parseProjectRows, parseRunRows, parseRunsTruncated, type AgentRow, type MissionPayload, type ProjectRow, type RunRow } from './rows';
import {
  EMPTY_FINALIZE_RECEIPT,
  EMPTY_GATE_EVIDENCE,
  EMPTY_RUN_CONTRACT,
  parseFinalizeReceipt,
  parseGateEvidence,
  parseGatewayReviews,
  parseRunContract,
  type GatewayFinalizeReceipt,
  type GatewayGateEvidence,
  type GatewayReview,
  type GatewayRunContract,
} from './graph-and-proof';

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

/** WP-P1: `rows` (unchanged shape/contract) plus `defaultProjectId` — the wrapper-designated
 *  default project (`FORGE_CC_DEFAULT_PROJECT`), when the gateway resolved it to one of `rows`;
 *  `null` otherwise. A plain object return (not a tuple) since `dataset.ts`'s one call site reads
 *  both by name, not by position. */
export interface ProjectRowsResult {
  readonly rows: readonly ProjectRow[];
  readonly defaultProjectId: string | null;
}

export function useGatewayProjectRows(): ProjectRowsResult {
  const [rows, setRows] = useState<readonly ProjectRow[]>([]);
  const [defaultProjectId, setDefaultProjectId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet('/api/projects');
      if (cancelled || !result.ok) return;
      setRows(parseProjectRows(result.data));
      setDefaultProjectId(parseDefaultProjectId(result.data));
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return { rows, defaultProjectId };
}

const EMPTY_RUN_ROWS: readonly RunRow[] = [];
const EMPTY_AGENT_ROWS: readonly AgentRow[] = [];
const EMPTY_RAW_EVENTS: readonly Record<string, unknown>[] = [];

/**
 * WP-CCD (item 7): `GET /api/active-runs` — a NEW, project-agnostic route (no `?project=`, unlike
 * every other route in this file).
 *
 * REVIEW FIX: the route DOES exist on the real gateway (verified live against
 * `_scratch/wt-cc1-snap/gateway/src/active-runs.mjs` — `WP-CC1 item 3`), and its per-row shape is
 * `{project, run_id, title, started_at, last_work_at, open_dispatches, working_agents}`, where
 * `working_agents` is an array of `{agent, agent_slug, wp_id, task, started_at}` records (one per
 * DISTINCT working agent, de-duplicated by slug). Read defensively regardless — the route not
 * existing on an OLDER gateway build still reads back `{available:false, rows:[]}` so `HomeView.tsx`
 * falls back to its own existing single-project derivation rather than showing an empty "Active
 * missions" panel for a workspace that plainly has running work elsewhere.
 */
export interface ActiveRunRow {
  readonly project: string;
  readonly runId: string;
  readonly title: string | null;
  readonly startedAt: string | null;
  readonly lastWorkAt: string | null;
  readonly openDispatches: number | null;
  readonly agents: readonly string[];
}

export interface ActiveRunsResult {
  /** `false` on ANY fetch failure (404 today, a network error, a malformed body) — the honest
   *  "this workspace-wide signal is not available", never confused with "genuinely zero active
   *  runs" (`available: true, rows: []`). */
  readonly available: boolean;
  readonly rows: readonly ActiveRunRow[];
  /** WP-RB-CC (review finding L-1): the gateway's own `truncated` field on this same response —
   *  true once this fleet-wide sweep hit its own project-count or cumulative-run-count budget
   *  (`active-runs.mjs`'s `computeActiveRuns()`), meaning `rows` honestly does not cover every real
   *  active run in the workspace. Always `false` when `available` is `false` — an unavailable signal
   *  has no truncation state of its own to report. */
  readonly truncated: boolean;
}

const EMPTY_ACTIVE_RUNS: ActiveRunsResult = { available: false, rows: [], truncated: false };

/**
 * REVIEW FIX: the real field is `working_agents` (see this file's own header) — a plain `agents` key
 * is never actually sent by the verified-live gateway, so reading it alone always returned an empty
 * array on real data (this WP's own `HomeView.tsx` "N agents" count for a cross-project row was
 * therefore always 0). `agents` is still tried as a fallback (an older/renamed gateway build), and
 * each real `working_agents` record's own identity fields (`agent`/`agent_slug`) are tried before
 * the previously-assumed, never-actually-sent `name`/`slug`.
 */
function readAgentsField(row: Record<string, unknown>): readonly string[] {
  const raw = row.working_agents ?? row.agents;
  if (!Array.isArray(raw)) return [];
  const asStrings = raw.filter((v): v is string => typeof v === 'string');
  if (asStrings.length > 0) return asStrings;
  const asRecords = pickArray(row, ['working_agents', 'agents']);
  return asRecords.map((a) => pickString(a, ['agent', 'agent_slug', 'name', 'slug']) ?? '').filter((s) => s.length > 0);
}

function toActiveRunRow(row: Record<string, unknown>): ActiveRunRow {
  return {
    project: pickString(row, ['project']) ?? '',
    runId: pickString(row, ['run_id']) ?? '',
    title: pickString(row, ['title']),
    startedAt: pickString(row, ['started_at']),
    lastWorkAt: pickString(row, ['last_work_at']),
    openDispatches: pickNumber(row, ['open_dispatches']),
    agents: readAgentsField(row),
  };
}

/**
 * REVIEW FIX: extracted so the real `GET /api/active-runs` array-parsing (including the
 * `readAgentsField` fix above) is directly unit-testable without mounting the hook/mocking `fetch` —
 * mirrors `parseAgentDispatchRows`'s own precedent in `gateway-agent-dispatches.ts` for this exact
 * "export the pure array parser, not just the polling hook" pattern.
 */
export function parseActiveRunRows(data: Record<string, unknown>): readonly ActiveRunRow[] {
  return pickArray(data, ['active_runs', 'activeRuns', 'runs']).map(toActiveRunRow);
}

export function useGatewayActiveRuns(): ActiveRunsResult {
  const [state, setState] = useState<ActiveRunsResult>(EMPTY_ACTIVE_RUNS);
  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet('/api/active-runs');
      if (cancelled) return;
      if (!result.ok) {
        setState(EMPTY_ACTIVE_RUNS);
        return;
      }
      const rows = parseActiveRunRows(result.data);
      setState({ available: true, rows, truncated: pickBool(result.data, ['truncated']) ?? false });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  return state;
}

/** WP-CCD (item 1): `rows` (unchanged shape/contract) plus `currentRunId` — the gateway's own
 *  honest pick of "the run this project is actually on right now" (`current_run`, a sibling field
 *  on the same `/api/runs` payload, mirroring `default_project_id`'s own sibling-field convention),
 *  `null` when absent (an older gateway build) or when the gateway itself found none. A plain
 *  object, not a tuple — `dataset.ts`'s one call site reads both by name. */
export interface ProjectRunsResult {
  readonly rows: readonly RunRow[];
  readonly currentRunId: string | null;
  /** WP-RB-CC (review finding L-1): see `parseRunsTruncated`'s own doc comment — true once this
   *  project has more run directories than the gateway's own per-request scan bound. */
  readonly runsTruncated: boolean;
}

const EMPTY_PROJECT_RUNS_RESULT: ProjectRunsResult = { rows: EMPTY_RUN_ROWS, currentRunId: null, runsTruncated: false };

export function useGatewayProjectRuns(projectName: string): ProjectRunsResult {
  const [state, setState] = useState<Keyed<ProjectRunsResult>>({ key: '', value: EMPTY_PROJECT_RUNS_RESULT });
  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/runs?project=${encodeURIComponent(projectName)}`);
      if (cancelled || !result.ok) return;
      setState({
        key: projectName,
        value: { rows: parseRunRows(result.data), currentRunId: parseCurrentRunId(result.data), runsTruncated: parseRunsTruncated(result.data) },
      });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);
  return state.key === projectName ? state.value : EMPTY_PROJECT_RUNS_RESULT;
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
  const { rows: runRows } = useGatewayProjectRuns(projectName);
  return useMemo(() => {
    const map = new Map<string, string | null>();
    for (const row of runRows) map.set(row.runId, row.eventScanError);
    return map;
  }, [runRows]);
}

/**
 * WP-RB-CC (review finding L-1): `runs_truncated` — real, honest signal that this project's own runs
 * list (`ActivityView`'s "Run" picker, backed by `state.data.runs`) does not cover every run this
 * project actually has. Mirrors `useGatewayRunScanErrors`'s own precedent exactly: a small dedicated
 * hook the consuming view mounts directly, a second independent poll of `/api/runs` alongside
 * `useGatewayDataset`'s own internal `useGatewayProjectRuns` call for the same project (same named
 * tradeoff — real extra traffic, cheap because an unchanged project is served from cache).
 */
export function useGatewayRunsTruncated(projectName: string): boolean {
  const { runsTruncated } = useGatewayProjectRuns(projectName);
  return runsTruncated;
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
 * WP-CCD (item 6): `reviews`/`gate_evidence`/`finalize`/`contract` are read straight off the exact
 * same `/api/proof` payload `useGatewayProof` above already fetches for `gates`/`proof` — this is a
 * SECOND, independent poll of that route (mirrors `useGatewayRunScanErrors`'s own precedent of a
 * second independent poll for a concept `PrototypeDataset` does not carry), mounted directly by
 * `TestsView.tsx` rather than threaded through `useGatewayDataset`/`PrototypeDataset` (which stays
 * out of this slice's concern — those four are net-new display concepts, not a widened existing
 * field). Every one of the four parsers already degrades to an honest "not available yet" value
 * when the gateway build serving this request predates the field.
 */
export interface GatewayProofExtras {
  readonly reviews: readonly GatewayReview[];
  readonly gateEvidence: GatewayGateEvidence;
  readonly finalize: GatewayFinalizeReceipt;
  readonly contract: GatewayRunContract;
}

const EMPTY_PROOF_EXTRAS: GatewayProofExtras = {
  reviews: [],
  gateEvidence: EMPTY_GATE_EVIDENCE,
  finalize: EMPTY_FINALIZE_RECEIPT,
  contract: EMPTY_RUN_CONTRACT,
};

export function useGatewayProofExtras(projectName: string, runId: string | null): GatewayProofExtras {
  const [state, setState] = useState<Keyed<GatewayProofExtras>>({ key: '', value: EMPTY_PROOF_EXTRAS });
  useEffect(() => {
    if (projectName === '' || runId === null) return undefined;
    const rid = runId;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/proof?project=${encodeURIComponent(projectName)}&run=${encodeURIComponent(rid)}`);
      if (cancelled || !result.ok) return;
      setState({
        key: missionKey(projectName, rid),
        value: {
          reviews: parseGatewayReviews(result.data),
          gateEvidence: parseGateEvidence(result.data),
          finalize: parseFinalizeReceipt(result.data),
          contract: parseRunContract(result.data),
        },
      });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName, runId]);
  return state.key === missionKey(projectName, runId) ? state.value : EMPTY_PROOF_EXTRAS;
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

/**
 * WP-RB-CC (review finding L-1): `artifacts_truncated` on this SAME `GET /api/proof?run=all`
 * payload (`proof.mjs`'s `buildProofAll()`) — true whenever the forge-artifacts index read, or any
 * run-artifacts-dir listing, hit its own bound, meaning `ArtifactsView`'s gallery does not cover
 * every real artifact this project has produced. Mirrors `useGatewayRunScanErrors`'s own precedent:
 * a small dedicated hook the consuming view mounts directly — a second independent poll of the same
 * route `useGatewayDataset` already polls internally to build `state.data.artifacts`.
 */
export function useGatewayArtifactsTruncated(projectName: string): boolean {
  const payload = useGatewayProofAll(projectName);
  return payload !== null && (pickBool(payload, ['artifacts_truncated']) ?? false);
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
