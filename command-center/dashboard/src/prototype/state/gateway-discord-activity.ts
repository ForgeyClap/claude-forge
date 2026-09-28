/**
 * gateway-discord-activity — v2.9.0 (Command Center audit finding 31): what the Discord bot has
 * actually done, its jobs and the cost Claude Code recorded for them. Before this the bot's work
 * (31 jobs, $121.45 recorded) appeared in no Command Center view at all.
 *
 * One read-only gateway route (discord-activity.mjs):
 *   GET /api/discord/activity -> { ok, activity: { available, state_dir, jobs, cost, notes } }
 *
 * HONESTY CONTRACT (same as `gateway-discord.ts` / `gateway-discord-projects-dir.ts`): an absent
 * or malformed field on the wire becomes `null` or an empty value, never a guessed number. Counts
 * that are genuinely counts (`total`, `open`, `runs`) default to 0 only because the gateway always
 * sends them; a missing `activity` object means `available: false`, never "the bot did nothing".
 * The gateway never sends message text or any Discord id, and this client never asks for them.
 */

import { useEffect, useState } from 'react';

import { gwGet, pickArray, pickBool, pickNumber, pickRecord, pickString, pickStringArray } from '@/prototype/state/gateway-client';

const POLL_MS = 15000;

/* ------------------------------------------------------------------- types */

export interface DiscordJob {
  readonly id: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  /** The bot's own queue state, verbatim (COMPLETED, FAILED, RUNNING, CANCELLED, ...). */
  readonly state: string;
  readonly receivedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly attempts: number | null;
  readonly runId: string | null;
  /** Already redacted and capped by the gateway. */
  readonly error: string | null;
}

export interface DiscordProjectCost {
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly runs: number;
  readonly costUsd: number;
}

export interface DiscordActivity {
  /** False when the bot has never run on this machine (no queue and no usage log yet). */
  readonly available: boolean;
  readonly stateDir: string;
  readonly jobs: {
    readonly total: number;
    readonly open: number;
    /** State name -> count, only states that actually occur. */
    readonly byState: Readonly<Record<string, number>>;
    /** Newest first, capped by the gateway. */
    readonly recent: readonly DiscordJob[];
  };
  readonly cost: {
    readonly recordedRuns: number;
    readonly runsWithoutCost: number;
    readonly totalUsd: number;
    readonly last7dUsd: number;
    readonly last24hUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Input tokens read from the prompt cache, counted apart from `inputTokens` (new input). */
    readonly cacheReadTokens: number;
    readonly firstAt: string | null;
    readonly lastAt: string | null;
    readonly byProject: readonly DiscordProjectCost[];
  };
  /** Plain-language notes about anything the gateway could not read. */
  readonly notes: readonly string[];
}

export const EMPTY_DISCORD_ACTIVITY: DiscordActivity = {
  available: false,
  stateDir: '',
  jobs: { total: 0, open: 0, byState: {}, recent: [] },
  cost: {
    recordedRuns: 0,
    runsWithoutCost: 0,
    totalUsd: 0,
    last7dUsd: 0,
    last24hUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    firstAt: null,
    lastAt: null,
    byProject: [],
  },
  notes: [],
};

export interface GatewayDiscordActivityState {
  /** True only until the FIRST response (success or failure) resolves. */
  readonly loading: boolean;
  readonly error: string | null;
  readonly data: DiscordActivity;
}

/* -------------------------------------------------------------------- parse */

function parseByState(value: Record<string, unknown> | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (value === null) return out;
  for (const [state, count] of Object.entries(value)) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) out[state] = count;
  }
  return out;
}

function parseJob(raw: Record<string, unknown>): DiscordJob {
  return {
    id: pickString(raw, ['id']),
    projectId: pickString(raw, ['project_id']),
    projectName: pickString(raw, ['project_name']),
    state: pickString(raw, ['state']) ?? 'UNKNOWN',
    receivedAt: pickString(raw, ['received_at']),
    startedAt: pickString(raw, ['started_at']),
    completedAt: pickString(raw, ['completed_at']),
    durationMs: pickNumber(raw, ['duration_ms']),
    attempts: pickNumber(raw, ['attempts']),
    runId: pickString(raw, ['run_id']),
    error: pickString(raw, ['error']),
  };
}

function parseProjectCost(raw: Record<string, unknown>): DiscordProjectCost {
  return {
    projectId: pickString(raw, ['project_id']),
    projectName: pickString(raw, ['project_name']),
    runs: pickNumber(raw, ['runs']) ?? 0,
    costUsd: pickNumber(raw, ['cost_usd']) ?? 0,
  };
}

/** Parses the `GET /api/discord/activity` body. Exported for unit tests. */
export function parseDiscordActivity(body: Record<string, unknown>): DiscordActivity {
  const activity = pickRecord(body, ['activity']);
  if (activity === null) return EMPTY_DISCORD_ACTIVITY;
  const jobs = pickRecord(activity, ['jobs']);
  const cost = pickRecord(activity, ['cost']);
  return {
    available: pickBool(activity, ['available']) ?? false,
    stateDir: pickString(activity, ['state_dir']) ?? '',
    jobs: {
      total: pickNumber(jobs, ['total']) ?? 0,
      open: pickNumber(jobs, ['open']) ?? 0,
      byState: parseByState(pickRecord(jobs, ['by_state'])),
      recent: pickArray(jobs, ['recent']).map(parseJob),
    },
    cost: {
      recordedRuns: pickNumber(cost, ['recorded_runs']) ?? 0,
      runsWithoutCost: pickNumber(cost, ['runs_without_cost']) ?? 0,
      totalUsd: pickNumber(cost, ['total_usd']) ?? 0,
      last7dUsd: pickNumber(cost, ['last_7d_usd']) ?? 0,
      last24hUsd: pickNumber(cost, ['last_24h_usd']) ?? 0,
      inputTokens: pickNumber(cost, ['input_tokens']) ?? 0,
      outputTokens: pickNumber(cost, ['output_tokens']) ?? 0,
      cacheReadTokens: pickNumber(cost, ['cache_read_tokens']) ?? 0,
      firstAt: pickString(cost, ['first_at']),
      lastAt: pickString(cost, ['last_at']),
      byProject: pickArray(cost, ['by_project']).map(parseProjectCost),
    },
    notes: pickStringArray(activity, ['notes']),
  };
}

/* --------------------------------------------------------------------- poll */

/** Polls `GET /api/discord/activity` every `POLL_MS`. Not project-scoped: the bot is one
 *  machine-wide service, the same fixed contract `gateway-discord.ts`'s status poll follows. */
export function useGatewayDiscordActivity(): GatewayDiscordActivityState {
  const [state, setState] = useState<{ resolved: boolean; error: string | null; data: DiscordActivity }>({
    resolved: false,
    error: null,
    data: EMPTY_DISCORD_ACTIVITY,
  });

  useEffect(() => {
    let cancelled = false;

    // Same shape as gateway-discord-projects-dir.ts: every setState happens after the first await,
    // so this stays clear of react-hooks/set-state-in-effect.
    async function tick(): Promise<void> {
      const result = await gwGet('/api/discord/activity');
      if (cancelled) return;
      if (result.ok) {
        setState({ resolved: true, error: null, data: parseDiscordActivity(result.data) });
      } else {
        setState((current) => ({ resolved: true, error: result.error, data: current.data }));
      }
    }

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { loading: !state.resolved, error: state.error, data: state.data };
}
