/**
 * gateway-adapter.ts / adapter/polling-hooks.ts — `GET /api/active-runs` (WP-CCD item 7/8).
 *
 * Pure `parseActiveRunRows` tests (no network) plus `useGatewayActiveRuns` hook tests against a
 * stubbed `fetch` — mirrors `gateway-agent-dispatches.test.ts`'s own precedent for this exact split.
 *
 * REVIEW FIX: the real per-row shape (verified live against
 * `_scratch/wt-cc1-snap/gateway/src/active-runs.mjs`) carries `working_agents` — an array of
 * `{agent, agent_slug, wp_id, task, started_at}` records — never the plain `agents` array of
 * `{name, slug}` records this WP's own code previously assumed. That mismatch meant
 * `ActiveRunRow.agents` (and therefore Home's cross-project "N agents" count) was always empty on
 * real data; these tests pin both the OLD assumed shape (kept as a harmless fallback) and the real
 * `working_agents` shape.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';

import { parseActiveRunRows, useGatewayActiveRuns } from '@/prototype/state/gateway-adapter';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parseActiveRunRows — the real GET /api/active-runs response shape', () => {
  it('REAL shape: reads working_agents, keyed by each record\'s own agent/agent_slug identity', () => {
    const rows = parseActiveRunRows({
      ok: true,
      active_runs: [
        {
          project: 'forge-v2',
          run_id: 'forge-2026-09-27-resume',
          title: 'WP-CCD resume',
          started_at: '2026-09-27T20:00:00.000Z',
          last_work_at: '2026-09-28T09:00:00.000Z',
          open_dispatches: 2,
          working_agents: [
            { agent: 'UI Boss', agent_slug: 'ui-boss', wp_id: 'wp-ccd', task: 'Screenshot loop', started_at: '2026-09-28T08:00:00.000Z' },
            { agent: 'Build Boss', agent_slug: 'build-boss', wp_id: 'wp-cc1', task: 'Finish the gateway', started_at: '2026-09-28T08:30:00.000Z' },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toBe('forge-v2');
    expect(rows[0].runId).toBe('forge-2026-09-27-resume');
    expect(rows[0].title).toBe('WP-CCD resume');
    expect(rows[0].openDispatches).toBe(2);
    // REGRESSION: before this fix, `agents` read the (never-sent) `agents` key and was always [].
    // The real display name (`agent`) is preferred over the slug (`agent_slug`) when both exist —
    // a human-readable identity, matching how the rest of this app shows "Build Boss" not the slug.
    expect(rows[0].agents).toEqual(['UI Boss', 'Build Boss']);
  });

  it('a working_agents record with no agent_slug falls back to its own display name', () => {
    const rows = parseActiveRunRows({
      ok: true,
      active_runs: [
        {
          project: 'p1',
          run_id: 'r1',
          title: null,
          started_at: null,
          last_work_at: null,
          open_dispatches: 0,
          working_agents: [{ agent: 'codex', task: 'review' }],
        },
      ],
    });
    expect(rows[0].agents).toEqual(['codex']);
  });

  it('FALLBACK (old assumed shape): a plain "agents" array of {name|slug} records is still read', () => {
    const rows = parseActiveRunRows({
      ok: true,
      active_runs: [{ project: 'p1', run_id: 'r1', title: null, started_at: null, last_work_at: null, open_dispatches: null, agents: [{ name: 'Build Boss' }] }],
    });
    expect(rows[0].agents).toEqual(['Build Boss']);
  });

  it('FALLBACK: a plain string array under "agents" is read directly, never re-wrapped', () => {
    const rows = parseActiveRunRows({
      ok: true,
      active_runs: [{ project: 'p1', run_id: 'r1', title: null, started_at: null, last_work_at: null, open_dispatches: null, agents: ['ui-boss'] }],
    });
    expect(rows[0].agents).toEqual(['ui-boss']);
  });

  it('a row with no working_agents/agents field at all reads back an honest empty array, never fabricated', () => {
    const rows = parseActiveRunRows({
      ok: true,
      active_runs: [{ project: 'p1', run_id: 'r1', title: null, started_at: null, last_work_at: null, open_dispatches: null }],
    });
    expect(rows[0].agents).toEqual([]);
  });

  it('a response with no active_runs field at all reads back an empty array, never fabricated', () => {
    expect(parseActiveRunRows({ ok: true })).toEqual([]);
  });
});

describe('useGatewayActiveRuns', () => {
  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  it('a 404/unavailable route reads back available:false, never a crash or a fabricated row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) }) as Response),
    );
    const { result } = renderHook(() => useGatewayActiveRuns());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.available).toBe(false);
    expect(result.current.rows).toEqual([]);
  });

  it('polls GET /api/active-runs and returns the real cross-project rows, working_agents included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/active-runs')) {
          return jsonResponse({
            ok: true,
            active_runs: [
              {
                project: 'forge-v2',
                run_id: 'r1',
                title: 'Active mission',
                started_at: '2026-09-28T08:00:00.000Z',
                last_work_at: '2026-09-28T09:00:00.000Z',
                open_dispatches: 1,
                working_agents: [{ agent: 'UI Boss', agent_slug: 'ui-boss', task: 'x', started_at: '2026-09-28T08:00:00.000Z' }],
              },
            ],
          });
        }
        return jsonResponse({ ok: true });
      }),
    );

    const { result } = renderHook(() => useGatewayActiveRuns());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0].project).toBe('forge-v2');
    expect(result.current.rows[0].agents).toEqual(['UI Boss']);
  });

  // WP-RB-CC (review finding L-1): the gateway's own `truncated` flag — carried through so a
  // consuming view (HomeView's "Active missions" panel) can show an honest cut-off note.
  it('L-1: carries the real truncated:true flag through, never silently dropping it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true, active_runs: [], truncated: true })),
    );
    const { result } = renderHook(() => useGatewayActiveRuns());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.truncated).toBe(true);
  });

  it('L-1: an ordinary, non-truncated response reads back truncated:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true, active_runs: [], truncated: false })),
    );
    const { result } = renderHook(() => useGatewayActiveRuns());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.truncated).toBe(false);
  });

  it('L-1: a response with no truncated field at all (an older gateway build) reads back false, never a false alarm', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true, active_runs: [] })),
    );
    const { result } = renderHook(() => useGatewayActiveRuns());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.truncated).toBe(false);
  });
});
