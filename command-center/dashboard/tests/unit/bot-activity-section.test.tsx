/**
 * BotActivitySection — v2.9.0 (Command Center audit finding 31). Same stubbed-fetch component-test
 * pattern as `projects-dir-section.test.tsx`: no store, no router — the panel reads
 * `GET /api/discord/activity` directly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';

import BotActivitySection from '@/views/discord/BotActivitySection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as Response;
}

function stubActivity(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(body, ok)),
  );
}

const FULL = {
  ok: true,
  activity: {
    available: true,
    state_dir: 'C:\\cc\\.data\\discord\\state',
    jobs: {
      total: 31,
      open: 1,
      by_state: { COMPLETED: 28, CANCELLED: 2, RUNNING: 1 },
      recent: [
        {
          id: 'item-31',
          project_id: 'alpha',
          project_name: 'Alpha Shop',
          state: 'FAILED',
          received_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
          started_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
          completed_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
          duration_ms: 90000,
          attempts: 3,
          run_id: 'discord-run-31',
          error: 'Claude could not start: [REDACTED:DISCORD_BOT_TOKEN]',
        },
        {
          id: 'item-30',
          project_id: 'beta',
          project_name: null,
          state: 'COMPLETED',
          received_at: null,
          started_at: null,
          completed_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
          duration_ms: null,
          attempts: 1,
          run_id: null,
          error: null,
        },
      ],
    },
    cost: {
      recorded_runs: 22,
      runs_without_cost: 2,
      total_usd: 121.45,
      last_7d_usd: 12.5,
      last_24h_usd: 1.25,
      input_tokens: 614,
      output_tokens: 288882,
      cache_read_tokens: 62478568,
      first_at: '2026-08-01T00:00:00.000Z',
      last_at: '2026-09-27T19:00:00.000Z',
      by_project: [
        { project_id: 'alpha', project_name: 'Alpha Shop', runs: 20, cost_usd: 100 },
        { project_id: 'beta', project_name: null, runs: 2, cost_usd: 21.45 },
      ],
    },
    notes: ['1 line in usage.jsonl could not be read and was skipped.'],
  },
};

describe('BotActivitySection', () => {
  it('shows a loading state, then the real totals, cost windows and token counts', async () => {
    stubActivity(FULL);
    render(createElement(BotActivitySection));
    expect(screen.getByText('Reading bot activity…')).toBeInTheDocument();

    expect(await screen.findByText('$121.45')).toBeInTheDocument();
    expect(screen.getByText('31')).toBeInTheDocument();
    expect(screen.getByText('1 still open.')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('$1.25')).toBeInTheDocument();
    // cached input is counted in, never dropped: 614 new + 62,478,568 from cache
    expect(screen.getByText('62.5M in / 288.9K out')).toBeInTheDocument();
    expect(screen.getByText(/62.5M of the input was read from the prompt cache./)).toBeInTheDocument();
    expect(screen.getByText(/2 jobs recorded no cost./)).toBeInTheDocument();
  });

  it('says plainly that the cost is Claude Code\'s own figure, not a separate bill on a subscription', async () => {
    stubActivity(FULL);
    render(createElement(BotActivitySection));
    expect(await screen.findByText(/Claude Code's own cost figure for each job/)).toBeInTheDocument();
  });

  it('lists jobs by state with their real state names', async () => {
    stubActivity(FULL);
    render(createElement(BotActivitySection));
    const states = await screen.findByRole('list', { name: 'Jobs by state' });
    expect(within(states).getByText('Completed')).toBeInTheDocument();
    expect(within(states).getByText('Cancelled')).toBeInTheDocument();
    expect(within(states).getByText('Running')).toBeInTheDocument();
    expect(within(states).getByText('28')).toBeInTheDocument();
  });

  it('per project: the name when known, the id otherwise, with jobs and cost', async () => {
    stubActivity(FULL);
    render(createElement(BotActivitySection));
    const perProject = await screen.findByRole('region', { name: 'Recorded cost per project' });
    expect(within(perProject).getByText('Alpha Shop')).toBeInTheDocument();
    expect(within(perProject).getByText('20 jobs')).toBeInTheDocument();
    expect(within(perProject).getByText('$100.00')).toBeInTheDocument();
    expect(within(perProject).getByText('beta')).toBeInTheDocument();
    expect(within(perProject).getByText('$21.45')).toBeInTheDocument();
  });

  it('recent jobs show state, age, duration and the redacted error', async () => {
    stubActivity(FULL);
    render(createElement(BotActivitySection));
    const recent = await screen.findByRole('region', { name: 'Recent jobs' });
    expect(within(recent).getByText('Failed · 2 hr ago · 1m 30s')).toBeInTheDocument();
    expect(within(recent).getByText('Claude could not start: [REDACTED:DISCORD_BOT_TOKEN]')).toBeInTheDocument();
    expect(within(recent).getByText('Completed · 1 day ago')).toBeInTheDocument();
  });

  it('shows the gateway notes', async () => {
    stubActivity(FULL);
    render(createElement(BotActivitySection));
    expect(await screen.findByText('1 line in usage.jsonl could not be read and was skipped.')).toBeInTheDocument();
  });

  it('no activity yet is its own honest empty state, not a row of zeros', async () => {
    stubActivity({ ok: true, activity: { available: false, state_dir: 'x', jobs: { total: 0, open: 0, by_state: {}, recent: [] }, cost: {}, notes: [] } });
    render(createElement(BotActivitySection));
    expect(await screen.findByText('No bot activity yet')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('a gateway failure is shown as a transport error', async () => {
    stubActivity({ ok: false, error: 'boom' }, false);
    render(createElement(BotActivitySection));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the gateway');
  });
});
