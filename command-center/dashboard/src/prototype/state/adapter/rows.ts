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

import { pickArray, pickBool, pickNumber, pickString, pickStringArray } from '@/prototype/state/gateway-client';

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
}

export interface MissionWpRow {
  readonly id: string | null;
  readonly note: string | null;
  readonly agent: string | null;
}

export interface MissionVerdictRow {
  /** `check_passed`/`check_failed` — drives the graph builder's verify node. */
  readonly eventType: string | null;
  /** cc-fix-adapter fix: previously discarded even though `missions.mjs` already reports it —
   *  this is what makes a real per-agent `verification` derivation possible below. */
  readonly agent: string | null;
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
  }));
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
  };
}

export function parseMissionPayload(runId: string, data: Record<string, unknown>): MissionPayload {
  return {
    runId,
    wps: pickArray(data, ['wps']).map((row) => ({
      id: pickString(row, ['id']),
      note: pickString(row, ['note']),
      agent: pickString(row, ['agent']),
    })),
    tasks: pickArray(data, ['tasks']).map(toMissionTaskRow),
    orphanCompletions: pickArray(data, ['orphan_completions']).map(toMissionTaskRow),
    verdicts: pickArray(data, ['verdicts']).map((row) => ({
      eventType: pickString(row, ['event_type']),
      agent: pickString(row, ['agent']),
    })),
  };
}

/* ========================================================================== */
/*  3. Status derivation — real fields only, neutral fallback otherwise       */
/* ========================================================================== */

export function toStatusKey(raw: string | null): StatusKey {
  if (raw === 'running') return 'running';
  if (raw === 'completed') return 'completed';
  if (raw === 'failed') return 'failed';
  return STATUS_WHEN_UNKNOWN;
}

export function deriveRunStatus(run: RunRow, mission: MissionPayload | null): StatusKey {
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

/** Latest task per agent (by real `started_at`), falling back to an orphan completion. */
export function buildAgentStatusMap(mission: MissionPayload | null): ReadonlyMap<string, StatusKey> {
  const out = new Map<string, StatusKey>();
  if (mission === null) return out;
  const latestStartedAt = new Map<string, string>();
  for (const t of mission.tasks) {
    if (t.agent === null) continue;
    const prevStarted = latestStartedAt.get(t.agent) ?? '';
    if ((t.startedAt ?? '') >= prevStarted) {
      latestStartedAt.set(t.agent, t.startedAt ?? '');
      out.set(t.agent, toStatusKey(t.status));
    }
  }
  for (const o of mission.orphanCompletions) {
    if (o.agent === null || out.has(o.agent)) continue;
    out.set(o.agent, toStatusKey(o.status));
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
export function buildAgentVerificationMap(mission: MissionPayload | null): ReadonlyMap<string, Agent['verification']> {
  const out = new Map<string, Agent['verification']>();
  if (mission === null) return out;
  for (const v of mission.verdicts) {
    if (v.agent === null) continue;
    if (v.eventType === 'check_failed') {
      out.set(v.agent, 'rejected');
      continue;
    }
    if (v.eventType === 'check_passed' && out.get(v.agent) !== 'rejected') out.set(v.agent, 'verified');
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
export function buildAgentProgressMap(mission: MissionPayload | null): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  if (mission === null) return out;
  const totals = new Map<string, number>();
  const completed = new Map<string, number>();
  for (const t of mission.tasks) {
    if (t.agent === null) continue;
    totals.set(t.agent, (totals.get(t.agent) ?? 0) + 1);
    if (t.status === 'completed') completed.set(t.agent, (completed.get(t.agent) ?? 0) + 1);
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
