/**
 * Forge Command Center — gateway adapter, raw rows + status derivation slice
 * (WP refactor-adapter-split).
 *
 * Split out of the single `gateway-adapter.ts` (was ~2400 lines) into its already-marked
 * "2. Raw row shapes + parsers" + "3. Status derivation" sections, verbatim — see that file's own
 * header for the full architecture/history/honesty rules this slice still follows. `toPermissionLevel`
 * moved to `mappers.ts` instead (its only caller, `toGatewayAgent`, lives there — see that file's own
 * comment). Several functions below (`parseProjectRows`, `parseRunRows`, `parseAgentRows`,
 * `parseMissionPayload`, `toStatusKey`, `deriveRunStatus`, `buildAgentStatusMap`) gained an `export`
 * keyword they did not have in the single-file version, purely so the sibling modules that now call
 * them across a file boundary (`polling-hooks.ts`, `mappers.ts`, `graph-and-proof.ts`, `dataset.ts`)
 * can import them — `gateway-adapter.ts`'s own public re-export list is unchanged either way, since
 * none of those were part of it.
 */

import type { Agent, StatusKey } from '@/prototype/types/prototype-types';

import { pickArray, pickBool, pickNumber, pickRecord, pickString, pickStringArray } from '@/prototype/state/gateway-client';

import { STATUS_WHEN_UNKNOWN } from './shared';

/* ========================================================================== */
/*  2. Raw row shapes + parsers                                               */
/* ========================================================================== */

export interface ProjectRow {
  readonly name: string;
  readonly path: string;
  readonly hasDashboard: boolean;
  /**
   * fix-ui-clutter (item 6): the project directory's own real mtime, read defensively —
   * `null` both when the field is genuinely absent (a gateway build that has not shipped
   * `dir_mtime_ms` yet — this parses that missing case safely, so this file compiles and
   * runs correctly before that field lands) and when the gateway itself could not stat the
   * row. Never a fabricated recency signal.
   */
  readonly dirMtimeMs: number | null;
  /**
   * WP-CCD (item 8): a real backup or test copy of another project — read defensively (see
   * `RunRow`'s own note above for the fallback contract). `null` on a gateway build that predates
   * it, or for an ordinary project (the honest default — never guessed from the project's name).
   */
  readonly kind?: string | null;
  /**
   * WP-CCD (item 8): a real open-ticket count (`.claude/forge-tickets`, when the gateway exposes
   * it) — `null` when the gateway did not report one, which is the honest "not measured" state.
   * Never coerced to a fabricated `0`; see `ProjectHealth.openTickets`'s own doc comment. Optional
   * (unlike this file's other required-but-nullable fields) so the pre-existing
   * `gateway-adapter-antifabrication.test.ts` / `project-type-and-confidence.test.ts` literals —
   * written before this field existed — keep compiling and passing unmodified.
   */
  readonly openTickets?: number | null;
}

export interface RunRow {
  readonly runId: string;
  readonly hasFinalReport: boolean;
  readonly eventCount: number;
  readonly mtime: string | null;
  /** cc-fix-adapter T6c: real, derived from the run's own first/last event timestamp — `null`
   *  (never 0) when fewer than two real timestamps exist to difference. */
  readonly durationMs: number | null;
  /** `'run-completed-event'` | `'derived-from-events'` | `null` — labels HOW `durationMs` was
   *  derived, never silently presented as a precise measurement. */
  readonly durationSource: string | null;
  /** cc-fix-dash-latency: `runs.mjs`'s new honest-failure signal (P1-2, `event_scan_error`) — non-
   *  null exactly when this run's events.jsonl exists but genuinely could not be read/parsed (an
   *  EACCES, a RangeError, anything other than the honest "file doesn't exist yet" case), which
   *  USED TO be silently reported as `event_count: 0` — indistinguishable from an honestly-empty
   *  run. `null` covers both "no error" and "file genuinely doesn't exist yet", matching the
   *  gateway's own `error: null` convention for both. */
  readonly eventScanError: string | null;
  /**
   * WP-CCD: `/api/runs` rows are being extended (in-flight gateway work, read here defensively —
   * this parses safely both before and after that lands) with the run's own real, recorded status
   * (`'finalized'|'completed'|'running'|'stalled'|'failed'|'unknown'`), title, `last_work_at`,
   * `finalized`/`has_gate_evidence` flags and a `synthetic` marker. `null`/`false` on a gateway
   * build that predates them — every consumer below falls back to today's exact derivation in
   * that case (see `deriveRunStatus`, `toGatewayRun`). All seven are optional (rather than
   * required-but-nullable, unlike this row's other fields) so the pre-existing
   * `gateway-adapter-antifabrication.test.ts` / `gateway-events-honesty.test.ts` literals — written
   * before these fields existed — keep compiling and passing unmodified; every real reader below
   * normalizes a structurally-possible `undefined` to the same honest default it already uses.
   */
  readonly status?: string | null;
  readonly title?: string | null;
  readonly startedAt?: string | null;
  readonly lastWorkAt?: string | null;
  readonly finalized?: boolean | null;
  readonly hasGateEvidence?: boolean | null;
  readonly synthetic?: boolean;
}

export interface AgentRow {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly modelTier: string | null;
  readonly claudeEffort: string | null;
  readonly nvidiaRole: string | null;
  readonly isPermanentBoss: boolean;
  readonly role: string | null;
  // cc-fix-adapter T4/T6a — the 7 real fields `parseAgentRows` used to silently drop. Kept here
  // even though most have no `Agent` field slot yet (see this file's header) — the point of this
  // fix is to stop discarding real gateway data at the parsing boundary, not to guarantee every
  // dropped field already has a view-facing home.
  readonly tools: readonly string[];
  readonly agentClass: string | null;
  readonly nvidiaFallback: string | null;
  readonly premium: boolean | null;
  readonly usagePolicyBucket: string | null;
  readonly memory: string | null;
  readonly responsibilities: string | null;
  /** cc-fix-adapter T6a: the real per-agent CORE skill list from `agent-skill-map.json`. */
  readonly skills: readonly string[];
  /**
   * WP-CCD: `GET /api/agents` is being extended (read defensively — see `RunRow`'s own note above
   * for why) with the agent's real human display name (`agent-registry.json`'s own `name` field,
   * e.g. "Build Boss" for slug `build-boss` — today's frontmatter-derived `AgentRow.name` above is
   * the SLUG again, `fm.name || slug`, never the display name) and any real aliases the registry
   * records. `null`/`[]` on a gateway build that predates them. Both optional (see `RunRow`'s own
   * note above) so the pre-existing `gateway-adapter-antifabrication.test.ts` `baseAgentRow()`
   * fixture keeps compiling unmodified.
   */
  readonly displayName?: string | null;
  readonly aliases?: readonly string[];
  /**
   * WP-CCD (item 3, review fix): `GET /api/agents` (verified live against
   * `_scratch/wt-cc1-snap/gateway/src/agents.mjs`) also reports this agent's REAL live-dispatch
   * status — `is_running` (true only when a run-log dispatch for this agent is genuinely open AND
   * its run is live within the heartbeat window; the exact same computation the "Live now" strip
   * itself uses, see `agent-dispatches.mjs::listRunLogDispatches`), and `live_dispatches` (every
   * dispatch this agent has in the candidate live run(s), running or not). `runningTask` below is
   * pre-extracted here (the first genuinely-running dispatch's own `task` text) so `dataset.ts` does
   * not need to know this row shape's own nested structure. Both `null`/`false` on a gateway build
   * that predates them, or when this row's project the gateway queried without `?project=` (the
   * static-registry-only call shape `agents.mjs` still supports) — never a guess.
   */
  readonly isRunning?: boolean;
  readonly runningTask?: string | null;
}

export interface MissionTaskRow {
  readonly role: string | null;
  readonly agent: string | null;
  readonly dispatchId: string | null;
  readonly wpGuess: string | null;
  /** cc-fix-adapter T4: kept alongside `wpGuess` (was previously discarded even though
   *  `missions.mjs`'s own `guessWp()` always attaches it) so a consumer can distinguish an
   *  explicit `wp<N>` match from a low-confidence inference — `Task`/`WorkPackage` have no field
   *  slot for it yet, so today this only flows as far as this row shape (see file header). */
  readonly wpGuessConfidence: string | null;
  readonly task: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly status: string | null;
  readonly notes: readonly string[];
  /**
   * Z1 (pair inversion). The gateway refuses to pair a completion when more than one still-open
   * start shares its exact (agent, role) — the identity of the finisher is then unknowable, and
   * guessing could stamp 'completed' on the dispatch that is genuinely still running. `true` means
   * at least one real completion could NOT be assigned to this task, so its status is honestly
   * under-reported: what is shown is never MORE finished than the evidence supports.
   *
   * These four fields were previously dropped here, which is what made the warning unreachable —
   * the gateway recorded the ambiguity and no consumer could ever see it. Parsed defensively, so a
   * gateway build that predates them still reads as an honest not-ambiguous (`false`/`null`),
   * never as a fabricated warning.
   */
  readonly pairingAmbiguous: boolean;
  /** Why the pairing was refused (how many open starts shared the key, how many completions were
   *  declined) — `null` when there is no ambiguity to explain. */
  readonly pairingAmbiguityReason: string | null;
  /** How many real completions this task's key had to refuse. `null` when the gateway did not
   *  report it — never coerced to `0`, which would read as a measured "none". */
  readonly declinedCompletions: number | null;
  /** Only on an `orphanCompletions` row: why that completion was left unmatched. */
  readonly unmatchedReason: string | null;
  /**
   * WP-CCD: the run's own real, explicit work-package id for this task — read defensively (see
   * `RunRow`'s own note above). `wpGuess` above is a NAME-CONVENTION INFERENCE (`missions.mjs`'s
   * own `guessWp()`, explicitly documented there as never a verified fact); `wpId` is the honest,
   * explicit field a gateway build that tracks per-task work-package assignment reports instead.
   * `toGatewayTask` prefers this over `wpGuess` whenever it is present. Optional (see `RunRow`'s
   * own note above) so every pre-existing hand-written `MissionTaskRow`/`toGatewayTask` fixture in
   * this codebase's tests keeps compiling unmodified.
   */
  readonly wpId?: string | null;
  /** The run's own verdict text for this task's completion (e.g. "PASS-WITH-NOTES") — `null` when
   *  none was reported. Optional, same reason as `wpId` above. */
  readonly verdict?: string | null;
  /** A human-readable summary of this task, straight through when the gateway reports one — `null`
   *  otherwise (`toGatewayTask` falls back to the joined `notes` exactly as before). Optional,
   *  same reason as `wpId` above. */
  readonly summary?: string | null;
}

export interface MissionWpRow {
  readonly id: string | null;
  readonly note: string | null;
  readonly agent: string | null;
  /** WP-CCD: a human-readable summary of this work package, read defensively — `null` on a gateway
   *  build that predates it (`toGatewayWorkPackage` falls back to `note` exactly as before).
   *  Optional, same reason as `MissionTaskRow.wpId` above.
   *
   *  REVIEW FIX (verified live against `_scratch/wt-cc1-snap/gateway/src/missions.mjs`): the real
   *  `agent_work_package_created` handler folds `ev.summary` into THIS row's `note` field already
   *  (`note: ev.summary || ev.note || null`) — a distinct top-level `summary` key is never actually
   *  sent for a `wps` row. This field is kept (harmless, forward-compatible) for a gateway build
   *  that might one day send it separately, but `note` alone already carries the resolved text. */
  readonly summary?: string | null;
  /**
   * WP-CCD (item 2, review fix): the work package's own real, canonical CANONICAL id
   * (`missions.mjs`'s `wp_id`, e.g. `"wp-ccd"`) — a SEPARATE, differently-formatted field from `id`
   * above (`ev.wp`, the human display code, e.g. `"WP-CCD"` — verified live against this project's
   * own real events.jsonl across many runs: `wp`/`id` is mixed-case with hyphens, `wp_id` is always
   * lowercase). `MissionTaskRow.wpId` on a real per-task event is populated from that SAME canonical
   * `wp_id` field, so joining a work package to its own tasks by `id` alone (the pre-existing
   * behaviour) silently fails for every modern run once both sides carry `wp_id` — `id` and `wp_id`
   * are the SAME work package but do not compare equal as strings. `toGatewayWorkPackage` and
   * `dataset.ts`'s own `taskIdsByWp` grouping both prefer this field over `id` for that reason,
   * mirroring the exact `wpId ?? wpGuess`/`wpId ?? id` preference already used elsewhere in this
   * file. `null` on a gateway build that predates it, or for a legacy work package that never had
   * one — the join then falls back to `id` unchanged, exactly like before this fix.
   */
  readonly wpId?: string | null;
}

export interface MissionVerdictRow {
  /** `check_passed`/`check_failed` — drives the graph builder's verify node. */
  readonly eventType: string | null;
  /** cc-fix-adapter fix: previously discarded even though `missions.mjs` already reports it —
   *  this is what makes a real per-agent `verification` derivation possible below. */
  readonly agent: string | null;
  /**
   * WP-CCD additions — `missions.mjs` already emits `role`/`command`/`timestamp` on every real
   * verdict event (verified live: `check_passed`/`check_failed` carry all three), but this row
   * shape discarded every one of them until now. They are what makes "the LATEST result per real
   * check, not any failure ever" possible (`dedupeLatestMissionVerdicts` in `graph-and-proof.ts`) —
   * without an identity to dedupe BY, every verdict for the same check looked like a different one.
   * All five are optional, same reason as `MissionTaskRow.wpId` above.
   */
  readonly role?: string | null;
  readonly command?: string | null;
  readonly timestamp?: string | null;
  /** A readable check name, when the gateway reports one distinct from `command`. */
  readonly check?: string | null;
  /** A human-readable summary of this verdict, when the gateway reports one. */
  readonly summary?: string | null;
}

export interface MissionPayload {
  readonly runId: string;
  readonly wps: readonly MissionWpRow[];
  readonly tasks: readonly MissionTaskRow[];
  readonly orphanCompletions: readonly MissionTaskRow[];
  readonly verdicts: readonly MissionVerdictRow[];
}

export function parseProjectRows(data: Record<string, unknown>): readonly ProjectRow[] {
  return pickArray(data, ['projects']).map((row) => ({
    name: pickString(row, ['name']) ?? '',
    path: pickString(row, ['path']) ?? '',
    hasDashboard: pickBool(row, ['has_dashboard']) ?? false,
    // fix-ui-clutter (item 6): `pickNumber` already returns `null` for a field that does not
    // exist on `row` yet, so this reads safely both before and after the gateway starts
    // sending `dir_mtime_ms`.
    dirMtimeMs: pickNumber(row, ['dir_mtime_ms']),
    // WP-CCD (item 8).
    kind: pickString(row, ['kind']),
    openTickets: pickNumber(row, ['open_tickets', 'ticket_count', 'tickets_open']),
  }));
}

/** WP-P1 (Forge v2.9.0): `default_project_id` is a SIBLING of the `projects` array on the same
 *  `GET /api/projects` payload (never one of the rows themselves) — the gateway already resolves
 *  it against a project it actually found (see projects.mjs's own `resolveDefaultProjectId()`),
 *  so this is a plain passthrough: present and non-empty -> that string; anything else (absent,
 *  not a string, empty) -> `null`, never a guess. */
export function parseDefaultProjectId(data: Record<string, unknown>): string | null {
  return pickString(data, ['default_project_id']);
}

/**
 * WP-CCD: `current_run` is a SIBLING of the `runs` array on the same `GET /api/runs` payload
 * (mirrors `default_project_id`'s own sibling-field convention on `/api/projects`) — the gateway's
 * own honest pick of "the run this project is actually on right now", explicitly excluding a
 * synthetic/example run (see `Run.synthetic`'s own doc comment). Read defensively: a plain string
 * (the run id itself) and `{run_id: string}` are both accepted, since the exact shape is still
 * in-flight gateway work; anything else (absent, wrong type) is an honest `null` — never guessed
 * from `runs[0]`, which is exactly the fallback `useGatewayDataset` itself still applies when this
 * is `null`.
 */
export function parseCurrentRunId(data: Record<string, unknown>): string | null {
  const direct = pickString(data, ['current_run']);
  if (direct !== null) return direct;
  const nested = pickRecord(data, ['current_run']);
  return nested !== null ? pickString(nested, ['run_id']) : null;
}

export function parseRunRows(data: Record<string, unknown>): readonly RunRow[] {
  return pickArray(data, ['runs']).map((row) => ({
    runId: pickString(row, ['run_id']) ?? '',
    hasFinalReport: pickBool(row, ['has_final_report']) ?? false,
    eventCount: pickNumber(row, ['event_count']) ?? 0,
    mtime: pickString(row, ['mtime']),
    durationMs: pickNumber(row, ['duration_ms']),
    durationSource: pickString(row, ['duration_source']),
    eventScanError: pickString(row, ['event_scan_error']),
    // WP-CCD — see `RunRow`'s own doc comment for the full fallback contract.
    status: pickString(row, ['status']),
    title: pickString(row, ['title']),
    startedAt: pickString(row, ['started_at']),
    lastWorkAt: pickString(row, ['last_work_at']),
    finalized: pickBool(row, ['finalized']),
    hasGateEvidence: pickBool(row, ['has_gate_evidence']),
    synthetic: pickBool(row, ['synthetic']) ?? false,
  }));
}

export function parseAgentRows(data: Record<string, unknown>): readonly AgentRow[] {
  return pickArray(data, ['agents']).map((row) => ({
    slug: pickString(row, ['slug']) ?? '',
    name: pickString(row, ['name']) ?? pickString(row, ['slug']) ?? '',
    description: pickString(row, ['description']),
    modelTier: pickString(row, ['model_tier']),
    claudeEffort: pickString(row, ['claude_effort']),
    nvidiaRole: pickString(row, ['nvidia_role']),
    isPermanentBoss: pickBool(row, ['is_permanent_boss']) ?? false,
    role: pickString(row, ['role']),
    tools: pickStringArray(row, ['tools']),
    agentClass: pickString(row, ['class']),
    nvidiaFallback: pickString(row, ['nvidia_fallback']),
    premium: pickBool(row, ['premium']),
    usagePolicyBucket: pickString(row, ['usage_policy_bucket']),
    memory: pickString(row, ['memory']),
    responsibilities: pickString(row, ['responsibilities']),
    skills: pickStringArray(row, ['skills']),
    // WP-CCD — see `AgentRow`'s own doc comment.
    displayName: pickString(row, ['display_name']),
    aliases: pickStringArray(row, ['aliases']),
    // WP-CCD (item 3, review fix) — see `AgentRow.isRunning`'s own doc comment.
    isRunning: pickBool(row, ['is_running']) ?? false,
    runningTask: (() => {
      const liveDispatches = pickArray(row, ['live_dispatches']);
      const runningDispatch = liveDispatches.find((d) => pickBool(d, ['running']) === true);
      return runningDispatch !== undefined ? pickString(runningDispatch, ['task']) : null;
    })(),
  }));
}

function toMissionTaskRow(row: Record<string, unknown>): MissionTaskRow {
  return {
    role: pickString(row, ['role']),
    agent: pickString(row, ['agent']),
    dispatchId: pickString(row, ['dispatch_id']),
    wpGuess: pickString(row, ['wp_guess']),
    wpGuessConfidence: pickString(row, ['wp_guess_confidence']),
    task: pickString(row, ['task']),
    startedAt: pickString(row, ['started_at']),
    completedAt: pickString(row, ['completed_at']),
    status: pickString(row, ['status']),
    notes: pickStringArray(row, ['notes']),
    // Z1 passthrough — see `MissionTaskRow` for why these must not be dropped here. `?? false` is
    // an honest default, not an invented value: absent means "the gateway reported no ambiguity".
    pairingAmbiguous: pickBool(row, ['pairing_ambiguous']) ?? false,
    pairingAmbiguityReason: pickString(row, ['pairing_ambiguity_reason']),
    declinedCompletions: pickNumber(row, ['declined_completions']),
    unmatchedReason: pickString(row, ['unmatched_reason']),
    // WP-CCD — see `MissionTaskRow`'s own doc comments.
    wpId: pickString(row, ['wp_id']),
    verdict: pickString(row, ['verdict']),
    summary: pickString(row, ['summary']),
  };
}

export function parseMissionPayload(runId: string, data: Record<string, unknown>): MissionPayload {
  return {
    runId,
    wps: pickArray(data, ['wps']).map((row) => ({
      id: pickString(row, ['id']),
      note: pickString(row, ['note']),
      agent: pickString(row, ['agent']),
      summary: pickString(row, ['summary']),
      // WP-CCD (item 2, review fix) — see `MissionWpRow.wpId`'s own doc comment.
      wpId: pickString(row, ['wp_id']),
    })),
    tasks: pickArray(data, ['tasks']).map(toMissionTaskRow),
    orphanCompletions: pickArray(data, ['orphan_completions']).map(toMissionTaskRow),
    verdicts: pickArray(data, ['verdicts']).map((row) => ({
      eventType: pickString(row, ['event_type']),
      agent: pickString(row, ['agent']),
      role: pickString(row, ['role']),
      command: pickString(row, ['command']),
      timestamp: pickString(row, ['timestamp']),
      check: pickString(row, ['check']),
      summary: pickString(row, ['summary']),
    })),
  };
}

/**
 * WP-CCD (item 2, review fix): the ONE real identifier a work package and its OWN tasks join on —
 * used by `toGatewayWorkPackage` (this file's sibling `mappers.ts`), `toGatewayRun`'s
 * `workPackageIds`, and `dataset.ts`'s `taskIdsByWp` grouping, so all three agree. Mirrors
 * `MissionTaskRow`'s own `wpId ?? wpGuess` preference (`toGatewayTask`): the work package's real
 * canonical `wp_id` (e.g. `"wp-ccd"`) wins when present, since that is the SAME string a modern
 * task's own `wpId` carries — `id` (`ev.wp`, e.g. `"WP-CCD"`) is a differently-cased/formatted
 * display code for the exact same real work package and does not compare equal to it. Falls back to
 * `id` for a legacy work package that never had a `wp_id` (paired with a legacy task's own
 * `wpGuess` fallback, which uses that same older, uppercase-"WP"-prefixed convention) — unchanged
 * from this codebase's behaviour before this fix. `''` only when NEITHER identifier exists at all.
 */
export function workPackageJoinId(wp: Pick<MissionWpRow, 'id' | 'wpId'>): string {
  return wp.wpId ?? wp.id ?? '';
}

/* ========================================================================== */
/*  3. Status derivation — real fields only, neutral fallback otherwise       */
/* ========================================================================== */

/**
 * WP-CCD (review fix): `'stalled'`/`'ended_unknown'` are real, recorded `missions.mjs` task states
 * (verified live in `_scratch/wt-cc1-snap/gateway/src/missions.mjs` PASS 3/PASS 4 — a task the run
 * itself ended without a real outcome, or one whose agent has gone silent past the stale window) —
 * before this fix both silently fell through to the neutral `STATUS_WHEN_UNKNOWN` ('idle'), which
 * reads identically to a task that never started at all. Both map to `'blocked'` ("this needs a
 * second look"), never to `'idle'`/backlog — `Task.rawStatus` (kept alongside this derived key)
 * still carries the literal string so a view can show the two apart (see `StalledFlag` in
 * `TasksView.tsx`).
 */
export function toStatusKey(raw: string | null): StatusKey {
  if (raw === 'running') return 'running';
  if (raw === 'completed') return 'completed';
  if (raw === 'failed') return 'failed';
  if (raw === 'stalled' || raw === 'ended_unknown') return 'blocked';
  return STATUS_WHEN_UNKNOWN;
}

/**
 * WP-CCD: the run-level counterpart of `toStatusKey` above — a run's own real status vocabulary is
 * WIDER than a task's, so it gets its own mapping rather than overloading `toStatusKey` with
 * run-only cases.
 *
 * REVIEW FIX (round 1, superseded in part below): the literal strings this function recognises were
 * verified live against `_scratch/wt-cc1-snap/gateway/src/runs.mjs::deriveStatus()` and this
 * project's own real per-run `run.json` files (32+ real runs surveyed under `.claude/forge-runs`) —
 * they do NOT match the `'finalized'|'completed'|'running'|'stalled'|'failed'|'unknown'` vocabulary
 * this WP's own brief originally assumed.
 *
 * LEAD CORRECTION (mid-task, 2026-09-28): the gateway's OWN "is this run live" rule was ALSO wrong at
 * the time of round-1 verification — an open dispatch that simply never closed made a run read
 * `'live'` forever (380 stale runs on this fleet read live under that rule). The corrected
 * `runs.mjs::deriveStatus()` now reports exactly SEVEN buckets: `'live'` (real activity in the last
 * 10 min), `'stalled'` (open work but no activity for 10 min–24 h), `'ended_unknown'` (never closed
 * properly, no activity for over 24 h), `'finalized'`, the run's own `run.json` end-state string AS
 * WRITTEN (e.g. `'completed'`/`'failed'`), `'report-only'`, and `'unknown'`. Rendering, per the Lead's
 * own explicit instruction: `'stalled'` is a VISIBLE WARNING (`'blocked'` — not green, not failed);
 * `'ended_unknown'` renders QUIETLY as "never closed" (the neutral `STATUS_WHEN_UNKNOWN` — not
 * failed, not running); anything this mapping does not specifically recognise (including this
 * fleet's own historical `'ended_unproven'`/`'done'` raw values, which predate the corrected rule and
 * are NOT part of the seven-bucket contract above) is the same honest neutral unknown, never guessed
 * into `'completed'` or `'blocked'`. Matching is case-insensitive (`deriveStatus` preserves the raw
 * file's original casing) since a future run.json is not guaranteed to match this fleet's historical
 * all-lowercase convention.
 */
export function toRunStatusKey(raw: string | null | undefined): StatusKey {
  if (raw === null || raw === undefined) return STATUS_WHEN_UNKNOWN;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'running' || normalized === 'live') return 'running';
  if (normalized === 'stalled') return 'blocked';
  if (normalized === 'ended_unknown') return STATUS_WHEN_UNKNOWN;
  if (normalized === 'completed' || normalized === 'finalized' || normalized === 'report-only') return 'completed';
  if (normalized === 'failed') return 'failed';
  return STATUS_WHEN_UNKNOWN;
}

export function deriveRunStatus(run: RunRow, mission: MissionPayload | null): StatusKey {
  // WP-CCD: a real, recorded run status (the gateway's own `run.json`/finalize-receipt reading)
  // always wins when present — it is ground truth about the RUN itself, not an inference from this
  // one mission's tasks. Falls back to the exact pre-existing task-derived heuristic on a gateway
  // build that predates this field (or for a run this project's `/api/runs` never annotated). `??
  // null` normalizes the structurally-possible `undefined` from an optional field on a hand-written
  // test fixture — every real parsed `RunRow` already sets this explicitly to `string | null`.
  if ((run.status ?? null) !== null) return toRunStatusKey(run.status);
  if (mission !== null && mission.tasks.some((t) => t.status === 'running')) return 'running';
  // cc-fix-events-honesty (P3-13): a real per-task `failed` verdict must win over
  // `hasFinalReport` — an orchestrator can still write a final report after a real task
  // failure, and that failure is real and recorded; it must never be masked by the report's
  // mere existence (previously checked in the opposite order, so a run with both a final
  // report AND a failed task silently reported 'completed').
  if (mission !== null && mission.tasks.some((t) => t.status === 'failed')) return 'failed';
  if (run.hasFinalReport) return 'completed';
  return STATUS_WHEN_UNKNOWN;
}

/**
 * WP-CCD: normalizes a free-text agent identifier (a display name like `"Build Boss"`, a slug like
 * `"build-boss"`, or any punctuation/case variant) down to a bare lowercase alphanumeric string, so
 * the two forms this fleet's own real data actually uses (events log the display name; the agent
 * registry's own slug is hyphenated) compare equal. Never throws on a non-string/empty input.
 */
export function normalizeAgentKey(raw: string | null | undefined): string {
  return typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

/**
 * WP-CCD (item 3): a normalized-name -> canonical slug index built from this project's REAL agent
 * rows — every row's own slug, `displayName` and every alias all resolve to the SAME canonical slug
 * (the row's own `slug`). This is what lets a mission event's free-text `agent` field (this fleet's
 * own real events log the human display name, e.g. `"Build Boss"`, "verified live against
 * events.jsonl — see `dataset.ts`'s own header) resolve back to the registry slug (`build-boss`)
 * `AgentRow.slug`/`Agent.id` actually use, WITHOUT needing the gateway's new `display_name`/
 * `aliases` fields at all: normalized-slug-vs-normalized-display-text already collide correctly
 * ("uiboss" for both "UI Boss" and "ui-boss"). `display_name`/`aliases`, once a gateway build sends
 * them, only widen the set of names that resolve — they were never required for the common case.
 */
export function buildAgentNameIndex(agentRows: readonly AgentRow[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const row of agentRows) {
    const candidates = [row.slug, row.name, row.displayName, ...(row.aliases ?? [])];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue;
      const key = normalizeAgentKey(candidate);
      if (key.length > 0 && !index.has(key)) index.set(key, row.slug);
    }
  }
  return index;
}

/**
 * WP-CCD (item 3): resolves a mission/dispatch's free-text `agent` field to a real registry slug.
 * An EXACT slug match always wins first (cheap, and correct even against an empty index); otherwise
 * the normalized-name index above is consulted. `null` when nothing in this project's real registry
 * matches (an honest "not a registered agent" — this fleet's own events log e.g. `"codex"` and
 * `"orchestrator"`, neither of which is a per-agent registry slug) — never a guessed slug.
 */
export function resolveAgentSlug(
  raw: string | null,
  agentRows: readonly AgentRow[],
  index: ReadonlyMap<string, string>,
): string | null {
  if (raw === null) return null;
  if (agentRows.some((row) => row.slug === raw)) return raw;
  return index.get(normalizeAgentKey(raw)) ?? null;
}

/** Latest task per agent (by real `started_at`), falling back to an orphan completion.
 *  `resolveAgentKey` (WP-CCD, item 3) is applied to every raw `agent` field before it becomes a map
 *  key — optional, defaults to the identity function, so every pre-existing call site (and its
 *  tests) that already passes a canonical slug keeps behaving byte-identically. */
export function buildAgentStatusMap(
  mission: MissionPayload | null,
  resolveAgentKey: (raw: string) => string = (raw) => raw,
): ReadonlyMap<string, StatusKey> {
  const out = new Map<string, StatusKey>();
  if (mission === null) return out;
  const latestStartedAt = new Map<string, string>();
  for (const t of mission.tasks) {
    if (t.agent === null) continue;
    const key = resolveAgentKey(t.agent);
    const prevStarted = latestStartedAt.get(key) ?? '';
    if ((t.startedAt ?? '') >= prevStarted) {
      latestStartedAt.set(key, t.startedAt ?? '');
      out.set(key, toStatusKey(t.status));
    }
  }
  for (const o of mission.orphanCompletions) {
    if (o.agent === null) continue;
    const key = resolveAgentKey(o.agent);
    if (out.has(key)) continue;
    out.set(key, toStatusKey(o.status));
  }
  return out;
}

/**
 * cc-fix-adapter fix: real per-agent verification, derived from THIS run's own `check_passed`/
 * `check_failed` verdicts (now that `MissionVerdictRow` keeps the real `agent` field instead of
 * discarding it) — replaces the previous constant `'not-required'` every agent used to get
 * regardless of what actually happened. A `check_failed` for an agent always wins over an earlier
 * `check_passed` (the worse real outcome is reported, never averaged away). An agent with no
 * verdict at all is left OUT of this map — the caller (`resolveAgentVerification` below) applies
 * the honest `null` fallback, not `'not-required'` (fix-cert-rest, item 2): `'not-required'` is a
 * genuine claim about the ROLE that no real source here reports; absence of a verdict in this run
 * is a different, honest "unknown" state, not evidence that verification was never needed.
 */
export function buildAgentVerificationMap(
  mission: MissionPayload | null,
  resolveAgentKey: (raw: string) => string = (raw) => raw,
): ReadonlyMap<string, Agent['verification']> {
  const out = new Map<string, Agent['verification']>();
  if (mission === null) return out;
  for (const v of mission.verdicts) {
    if (v.agent === null) continue;
    const key = resolveAgentKey(v.agent);
    if (v.eventType === 'check_failed') {
      out.set(key, 'rejected');
      continue;
    }
    if (v.eventType === 'check_passed' && out.get(key) !== 'rejected') out.set(key, 'verified');
  }
  return out;
}

/**
 * fix-cert-rest (item 2): the real per-agent `verification` this run reports for `slug`, or `null`
 * when `buildAgentVerificationMap` has no entry for it — a genuine, honest absence of verification
 * evidence, never the previous blanket `'not-required'` (a claim about the ROLE that no real
 * source in this gateway reports; only fixture/example data may assert that literal — see
 * `Agent.verification`'s own doc comment). Extracted to a small, directly-testable seam, the same
 * way `hasMeasuredProjectDetail` above is — `useGatewayDataset`'s own per-agent mapping loop is a
 * React hook body and not otherwise unit-testable in isolation.
 */
export function resolveAgentVerification(
  agentVerificationMap: ReadonlyMap<string, Agent['verification']>,
  slug: string,
): Agent['verification'] {
  return agentVerificationMap.get(slug) ?? null;
}

/**
 * cc-fix-adapter fix: a real per-agent progress percentage — completed / total real tasks that
 * agent was dispatched in this run, rounded. Replaces the previous constant `0`. `Agent.progress`'s
 * own doc comment says it is "only meaningful while status is 'running'" — this still reports a
 * real ratio for a finished agent too (100 for a fully completed set), which is honest, not
 * fabricated: it is a real fact about that agent's task history, just not the field's primary use.
 */
export function buildAgentProgressMap(
  mission: MissionPayload | null,
  resolveAgentKey: (raw: string) => string = (raw) => raw,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  if (mission === null) return out;
  const totals = new Map<string, number>();
  const completed = new Map<string, number>();
  for (const t of mission.tasks) {
    if (t.agent === null) continue;
    const key = resolveAgentKey(t.agent);
    totals.set(key, (totals.get(key) ?? 0) + 1);
    if (t.status === 'completed') completed.set(key, (completed.get(key) ?? 0) + 1);
  }
  for (const [agent, total] of totals) {
    out.set(agent, total > 0 ? Math.round(((completed.get(agent) ?? 0) / total) * 100) : 0);
  }
  return out;
}

/** A real millisecond duration into a short display string — a format transform of real data,
 *  mirroring `gateway-files.ts`'s own `formatFileBytes` convention for this same file. `null`
 *  (never measured) renders as `''`, not a fabricated "0s". */
export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * cc-fix-events-honesty (P1-6): `RunRow.durationSource` was parsed onto the row (`:701`) and then
 * never read again — `toGatewayRun` formatted `durationMs` alone, so a `'derived-from-events'`
 * span (the gap between a run's first and last recorded event — `runs.mjs` itself documents this
 * is NOT the same thing as true elapsed runtime, since nothing before the first event or after the
 * last is included) rendered pixel-identical to a real `'run-completed-event'` measurement,
 * contradicting this file's own comment above `RunRow.durationSource`: "never silently presented
 * as a precise measurement". Only the honest fallback gets the qualifier; a real
 * `'run-completed-event'` measurement (or the `''` "not measured" case) is untouched.
 */
export function formatDurationWithSource(ms: number | null, source: string | null): string {
  const base = formatDurationMs(ms);
  if (base === '') return base;
  return source === 'derived-from-events' ? `${base} (from events)` : base;
}

/**
 * cc-fix-events-honesty (P2-9): a real ISO 8601 timestamp into a short human-relative label —
 * `Project.lastActivity` was carrying `currentRun?.mtime` verbatim (a 24-character
 * `2026-07-29T09:41:02.311Z`) into five render sites built for a ~9-character label
 * (`Sidebar.tsx`, `ProjectsView.tsx`, `HomeView.tsx`, `Inspector.tsx`,
 * `ProjectOverviewView.tsx`) — all five are out of this WP's write scope, so this formats the
 * ONE real source of that field (`activeDetail.lastActivity` below) instead of touching any of
 * them, fixing every render site at once. The output shape ("4 min ago", "2 hr ago") is
 * DELIBERATELY the same "<digits> <space> <unit word>" shape `ProjectsView.tsx`'s own
 * `agoMinutes()` (`:60-66`) and `HomeView.tsx`'s copy (`:62-68`) already parse as their
 * documented fixture-only sort fallback for this exact field — reusing it here keeps both
 * views' existing "Recent" sort correct in production without editing either file. An absent
 * or unparsable timestamp renders as '' (never a fabricated "just now"), matching this file's
 * "unknown attributes are shown as absence" rule; a future timestamp (clock skew) reads as
 * "just now" rather than a nonsensical negative age.
 */
export function formatRelativeTime(iso: string | null): string {
  if (iso === null || iso.trim() === '') return '';
  const thenMs = Date.parse(iso);
  if (!Number.isFinite(thenMs)) return '';
  const diffMinutes = Math.max(0, (Date.now() - thenMs) / 60000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${Math.round(diffMinutes)} min ago`;
  const diffHours = diffMinutes / 60;
  if (diffHours < 24) return `${Math.round(diffHours)} hr ago`;
  const diffDays = diffHours / 24;
  if (diffDays < 7) {
    const d = Math.round(diffDays);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }
  const w = Math.round(diffDays / 7);
  return `${w} week${w === 1 ? '' : 's'} ago`;
}
