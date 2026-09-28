/**
 * WP-RB-CC (review finding L-1) — the gateway's own `runs_truncated` (`GET /api/runs`) and
 * `artifacts_truncated` (`GET /api/proof?run=all`) flags now reach the dashboard, through
 * `parseRunsTruncated`, `useGatewayRunsTruncated` (`ActivityView`'s "Run" picker) and
 * `useGatewayArtifactsTruncated` (`ArtifactsView`'s gallery). Before this fix neither flag was read
 * anywhere, so a cut-off list looked exactly like a complete one.
 *
 * Pure `parseRunsTruncated` tests (no network) plus hook tests against a stubbed `fetch` — mirrors
 * `gateway-active-runs.test.ts`'s own precedent for this exact split.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';

import { parseRunsTruncated, useGatewayRunsTruncated, useGatewayArtifactsTruncated } from '@/prototype/state/gateway-adapter';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parseRunsTruncated — the real GET /api/runs sibling field', () => {
  it('reads a genuine runs_truncated:true', () => {
    expect(parseRunsTruncated({ ok: true, runs: [], runs_truncated: true })).toBe(true);
  });

  it('reads a genuine runs_truncated:false', () => {
    expect(parseRunsTruncated({ ok: true, runs: [], runs_truncated: false })).toBe(false);
  });

  it('a response with no runs_truncated field at all (an older gateway build) reads back false, never a false alarm', () => {
    expect(parseRunsTruncated({ ok: true, runs: [] })).toBe(false);
  });

  it('a non-boolean value is refused, never coerced into a truthy alarm', () => {
    expect(parseRunsTruncated({ ok: true, runs: [], runs_truncated: 'yes' })).toBe(false);
  });
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('useGatewayRunsTruncated', () => {
  it('L-1: a project whose own scan hit its bound reads back true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, runs: [], runs_truncated: true })));
    const { result } = renderHook(() => useGatewayRunsTruncated('forge-v2'));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('L-1: the ordinary, non-truncated case reads back false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, runs: [], runs_truncated: false })));
    const { result } = renderHook(() => useGatewayRunsTruncated('forge-v2'));
    // Never flips to true — give the poll a real tick and confirm it stays honestly false.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(result.current).toBe(false);
  });

  it('an empty project name never polls at all, and reads back the honest default', () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true, runs: [], runs_truncated: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const { result } = renderHook(() => useGatewayRunsTruncated(''));
    expect(result.current).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useGatewayArtifactsTruncated', () => {
  it('L-1: a project whose artifacts scan hit its bound reads back true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, run_id: 'all', artifacts: [], artifacts_truncated: true })));
    const { result } = renderHook(() => useGatewayArtifactsTruncated('forge-v2'));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('L-1: the ordinary, non-truncated case reads back false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, run_id: 'all', artifacts: [], artifacts_truncated: false })));
    const { result } = renderHook(() => useGatewayArtifactsTruncated('forge-v2'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(result.current).toBe(false);
  });

  it('no payload yet (still loading) reads back false, never a fabricated alarm', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));
    const { result } = renderHook(() => useGatewayArtifactsTruncated(''));
    expect(result.current).toBe(false);
  });
});
