/**
 * gateway-agent-dispatches.ts — feat-live-visibility (Gap B). Pure `parseAgentDispatchRows` tests
 * (no network) plus `useGatewayAgentDispatches` hook tests against a stubbed `fetch`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';

import { parseAgentDispatchRows, useGatewayAgentDispatches } from '@/prototype/state/gateway-agent-dispatches';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parseAgentDispatchRows — the real GET /api/agent-dispatches response shape', () => {
  it('parses a real, RESOLVED dispatch row', () => {
    const rows = parseAgentDispatchRows({
      ok: true,
      dispatches: [
        {
          subagent_type: 'Explore',
          conversation_id: 'c-1',
          description: 'Inventarise the project',
          started_at: '2026-07-30T08:00:43.467Z',
          running: false,
          resolved_status: 'completed',
          ended_at: '2026-07-30T08:03:23.843Z',
        },
      ],
    });
    expect(rows).toEqual([
      {
        subagentType: 'Explore',
        conversationId: 'c-1',
        description: 'Inventarise the project',
        startedAt: '2026-07-30T08:00:43.467Z',
        running: false,
        resolvedStatus: 'completed',
        endedAt: '2026-07-30T08:03:23.843Z',
      },
    ]);
  });

  it('a real, STILL-RUNNING dispatch reads back honest nulls for resolved_status/ended_at, never guessed', () => {
    const rows = parseAgentDispatchRows({
      ok: true,
      dispatches: [
        { subagent_type: 'Plan', conversation_id: 'c-2', description: null, started_at: '2026-07-30T09:00:00.000Z', running: true, resolved_status: null, ended_at: null },
      ],
    });
    expect(rows[0].running).toBe(true);
    expect(rows[0].resolvedStatus).toBeNull();
    expect(rows[0].endedAt).toBeNull();
  });

  it('a response with no dispatches field at all reads back an empty array, never fabricated', () => {
    expect(parseAgentDispatchRows({ ok: true })).toEqual([]);
  });

  it('a genuinely empty dispatches array stays empty', () => {
    expect(parseAgentDispatchRows({ ok: true, dispatches: [] })).toEqual([]);
  });
});

describe('useGatewayAgentDispatches', () => {
  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  it('an empty project name never fetches and stays a stable empty array', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true, dispatches: [] }));
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useGatewayAgentDispatches(''));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('polls GET /api/agent-dispatches?project= and returns the real rows for the active project', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/agent-dispatches') && url.includes('project=demo-project')) {
          return jsonResponse({
            ok: true,
            dispatches: [
              { subagent_type: 'Explore', conversation_id: 'c-1', description: 'x', started_at: '2026-07-30T08:00:00.000Z', running: true, resolved_status: null, ended_at: null },
            ],
          });
        }
        return jsonResponse({ ok: true });
      }),
    );

    const { result } = renderHook(() => useGatewayAgentDispatches('demo-project'));
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].subagentType).toBe('Explore');
    expect(result.current[0].running).toBe(true);
  });
});
