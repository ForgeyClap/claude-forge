/**
 * gateway-discord-activity — v2.9.0 (Command Center audit finding 31): the parser for
 * `GET /api/discord/activity`. Pins the honesty contract: a missing `activity` object means
 * "not available", never "the bot did nothing", and malformed fields become null/empty values
 * instead of guessed numbers.
 */
import { describe, expect, it } from 'vitest';

import { EMPTY_DISCORD_ACTIVITY, parseDiscordActivity } from '@/prototype/state/gateway-discord-activity';

const BODY = {
  ok: true,
  activity: {
    available: true,
    state_dir: 'C:\\cc\\.data\\discord\\state',
    jobs: {
      total: 31,
      open: 1,
      by_state: { COMPLETED: 28, CANCELLED: 2, RUNNING: 1, BOGUS: 'x' },
      recent: [
        {
          id: 'item-9',
          project_id: 'alpha',
          project_name: 'Alpha Shop',
          state: 'RUNNING',
          received_at: '2026-09-27T19:00:00.000Z',
          started_at: '2026-09-27T19:00:05.000Z',
          completed_at: null,
          duration_ms: null,
          attempts: 1,
          run_id: 'discord-run-9',
          error: null,
        },
        'not-an-object',
      ],
    },
    cost: {
      recorded_runs: 22,
      runs_without_cost: 0,
      total_usd: 121.45,
      last_7d_usd: 12.5,
      last_24h_usd: 1.25,
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 5000,
      first_at: '2026-08-01T00:00:00.000Z',
      last_at: '2026-09-27T19:00:00.000Z',
      by_project: [{ project_id: 'alpha', project_name: 'Alpha Shop', runs: 20, cost_usd: 100 }],
    },
    notes: ['1 line in usage.jsonl could not be read and was skipped.', 42],
  },
};

describe('parseDiscordActivity', () => {
  it('reads every real field of a full response', () => {
    const a = parseDiscordActivity(BODY);
    expect(a.available).toBe(true);
    expect(a.stateDir).toBe('C:\\cc\\.data\\discord\\state');
    expect(a.jobs.total).toBe(31);
    expect(a.jobs.open).toBe(1);
    expect(a.jobs.byState).toEqual({ COMPLETED: 28, CANCELLED: 2, RUNNING: 1 });
    expect(a.jobs.recent).toHaveLength(1);
    expect(a.jobs.recent[0]).toEqual({
      id: 'item-9',
      projectId: 'alpha',
      projectName: 'Alpha Shop',
      state: 'RUNNING',
      receivedAt: '2026-09-27T19:00:00.000Z',
      startedAt: '2026-09-27T19:00:05.000Z',
      completedAt: null,
      durationMs: null,
      attempts: 1,
      runId: 'discord-run-9',
      error: null,
    });
    expect(a.cost.totalUsd).toBe(121.45);
    expect(a.cost.last7dUsd).toBe(12.5);
    expect(a.cost.last24hUsd).toBe(1.25);
    expect(a.cost.cacheReadTokens).toBe(5000);
    expect(a.cost.byProject).toEqual([{ projectId: 'alpha', projectName: 'Alpha Shop', runs: 20, costUsd: 100 }]);
    expect(a.notes).toEqual(['1 line in usage.jsonl could not be read and was skipped.']);
  });

  it('no activity object at all means not available, never a fabricated "0 jobs"', () => {
    expect(parseDiscordActivity({ ok: true })).toEqual(EMPTY_DISCORD_ACTIVITY);
    expect(parseDiscordActivity({ ok: true }).available).toBe(false);
  });

  it('a job without a state reads UNKNOWN; missing numbers become null, not zero', () => {
    const a = parseDiscordActivity({ ok: true, activity: { available: true, jobs: { recent: [{ id: 'x' }] } } });
    expect(a.jobs.recent[0].state).toBe('UNKNOWN');
    expect(a.jobs.recent[0].durationMs).toBeNull();
    expect(a.jobs.recent[0].attempts).toBeNull();
  });
});
