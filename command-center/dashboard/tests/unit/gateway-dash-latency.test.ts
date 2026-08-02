/**
 * cc-fix-dash-latency (forge-2026-07-29-cc-finish, WP fix-dash-latency) — tests for the three
 * client-side fixes this work package makes in `gateway-adapter.ts`, consuming
 * cc-fix-gateway-perf's gateway-side handoff (verified live against the running gateway before
 * relying on it — see the comments this WP left in `gateway-adapter.ts` itself):
 *
 *   1. `GatewayConnectionStore.poll()` makes exactly ONE request per tick (`/api/health`), never a
 *      second `/api/conversations` call — `execution` now comes straight off the health response.
 *   2. `PROJECTS_POLL_MS` keeps a new project's worst-case time-to-visible under the 10s Nielsen
 *      threshold against the new 5s server-side registry TTL, proven with the real (ceiling-based)
 *      worst-case formula, not the naive `TTL + P` sum alone.
 *   3. `useGatewayRunScanErrors` surfaces `runs.mjs`'s new `event_scan_error` per run.
 *
 * Mirrors this file's own established conventions: `gateway-connection-store.test.ts`'s fetch-stub
 * + fake-timer style for #1, `gateway-capabilities.test.ts`'s `renderHook` + `stubFetchJson` style
 * for #3, and a small pure-function test for #2.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { GatewayConnectionStore, PROJECTS_POLL_MS, useGatewayRunScanErrors } from '@/prototype/state/gateway-adapter';

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ========================================================================== */
/*  1. No more redundant /api/conversations call in the health poll           */
/* ========================================================================== */

/** Tracks every URL `fetch` was called with, alongside a realistic /api/health body carrying the
 *  new `execution` field cc-fix-gateway-perf added — verified live before this WP relied on it. */
function stubFetchTrackingUrls(): { fetchMock: ReturnType<typeof vi.fn>; urls: string[] } {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/api/health')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          execution: { available: true, note: 'resolved claude CLI at /usr/local/bin/claude' },
        }),
      };
    }
    // Anything else (e.g. a leftover /api/conversations call) still answers honestly rather than
    // rejecting — a regression would show up as a real recorded URL in `urls`, not a swallowed error.
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return { fetchMock, urls };
}

describe('GatewayConnectionStore.poll() — #1: the redundant /api/conversations call is gone', () => {
  it('makes exactly ONE fetch per poll tick, and it is /api/health — never /api/conversations', async () => {
    vi.useFakeTimers();
    try {
      const { fetchMock, urls } = stubFetchTrackingUrls();
      const store = new GatewayConnectionStore();
      const unsubscribe = store.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0); // let the first-subscribe immediate poll() resolve

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(urls).toEqual([expect.stringContaining('/api/health')]);
      expect(urls.some((u) => u.includes('/api/conversations'))).toBe(false);

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives claudeAvailable/claudeExecutablePath/claudeNote straight off /api/health's own execution field", async () => {
    vi.useFakeTimers();
    try {
      stubFetchTrackingUrls();
      const store = new GatewayConnectionStore();
      const unsubscribe = store.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      const state = store.getState();
      expect(state.status).toBe('CONNECTED');
      expect(state.claudeAvailable).toBe(true);
      expect(state.claudeExecutablePath).toBe('/usr/local/bin/claude');
      expect(state.claudeNote).toBe('resolved claude CLI at /usr/local/bin/claude');

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a health response with no execution field at all reports honest nulls, never a guessed default', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const store = new GatewayConnectionStore();
      const unsubscribe = store.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      const state = store.getState();
      expect(state.claudeAvailable).toBeNull();
      expect(state.claudeExecutablePath).toBeNull();
      expect(state.claudeNote).toBeNull();

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ========================================================================== */
/*  2. PROJECTS_POLL_MS — new-project visibility worst case stays under 10s   */
/* ========================================================================== */

describe('PROJECTS_POLL_MS — #2: worst-case new-project visibility latency', () => {
  // Read live from `gateway/src/projects.mjs`'s own `CACHE_TTL_MS` export (2026-07-29, this WP's
  // own read of the source) — duplicated here as a literal because the dashboard package never
  // imports the gateway package (fetch-only boundary). If that constant ever changes, this
  // comment is the trip-wire a future reader needs to re-check both sides.
  const SERVER_CACHE_TTL_MS = 5000;

  /**
   * The REAL worst case under `listProjects()`'s stale-while-revalidate design: a request that
   * finds the cache expired returns the OLD value immediately and only TRIGGERS a background
   * refresh — it does not itself receive the refreshed data. Only the NEXT request does. That
   * makes the true worst case `ceil(TTL/P) * P + P`, not the flatter `TTL + P` sum, whenever P
   * does not evenly divide TTL.
   */
  function worstCaseVisibilityMs(ttlMs: number, pollMs: number): number {
    return Math.ceil(ttlMs / pollMs) * pollMs + pollMs;
  }

  it('is an exact divisor of the server TTL — no ceiling-rounding penalty on the real worst case', () => {
    expect(SERVER_CACHE_TTL_MS % PROJECTS_POLL_MS).toBe(0);
  });

  it('keeps the real (ceiling-based) worst-case visibility latency safely under the 10s threshold', () => {
    const worst = worstCaseVisibilityMs(SERVER_CACHE_TTL_MS, PROJECTS_POLL_MS);
    expect(worst).toBe(7500);
    expect(worst).toBeLessThan(10000);
  });

  it('documents why a poll interval close to but not dividing the TTL would have been unsafe', () => {
    // The naive `TTL + P` sum this work package's formula suggests LOOKS safe for P=4000ms against
    // TTL=5000ms (5000+4000=9000ms, under 10s) — but the real ceiling-based worst case is 12000ms,
    // OVER the threshold, because the poll that first notices expiry never receives the refresh it
    // triggers. This is exactly the trap `PROJECTS_POLL_MS`'s own comment in gateway-adapter.ts
    // explains, and exactly why an EXACT divisor of the TTL was chosen instead.
    expect(worstCaseVisibilityMs(5000, 4000)).toBe(12000);
    expect(worstCaseVisibilityMs(5000, 4000)).toBeGreaterThan(10000);
  });
});

/* ========================================================================== */
/*  3. useGatewayRunScanErrors — runs.mjs's new event_scan_error, per run     */
/* ========================================================================== */

function stubFetchJson(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe('useGatewayRunScanErrors — #3', () => {
  it('never fetches while no project is selected — the map stays empty', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { result } = renderHook(() => useGatewayRunScanErrors(''));
    expect(result.current.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keys a real GET /api/runs response by run_id — null for a healthy run, the real message for a broken scan', async () => {
    stubFetchJson({
      runs: [
        { run_id: 'run-ok', has_final_report: true, event_count: 12, mtime: 'x', duration_ms: null, duration_source: null, event_scan_error: null },
        {
          run_id: 'run-broken',
          has_final_report: false,
          event_count: 0,
          mtime: 'x',
          duration_ms: null,
          duration_source: null,
          event_scan_error: "failed to read events.jsonl: EACCES: permission denied, open 'events.jsonl'",
        },
      ],
    });

    const { result } = renderHook(() => useGatewayRunScanErrors('demo-project'));
    await waitFor(() => expect(result.current.size).toBe(2));

    expect(result.current.get('run-ok')).toBeNull();
    expect(result.current.get('run-broken')).toBe("failed to read events.jsonl: EACCES: permission denied, open 'events.jsonl'");
  });

  it('a run row with no event_scan_error field at all (the pre-fix honest shape) parses to null, never undefined', async () => {
    stubFetchJson({ runs: [{ run_id: 'run-x', has_final_report: true, event_count: 1 }] });

    const { result } = renderHook(() => useGatewayRunScanErrors('demo-project'));
    await waitFor(() => expect(result.current.size).toBe(1));

    expect(result.current.get('run-x')).toBeNull();
  });

  it('a genuinely empty registry (no runs yet) resolves to an empty map, never a fabricated entry', async () => {
    const fetchMock = stubFetchJson({ runs: [] });

    const { result } = renderHook(() => useGatewayRunScanErrors('demo-project'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });
});
