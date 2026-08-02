/**
 * `gateway-recovery.ts` — the THREE HOOKS themselves (`useGatewayRecovery`,
 * `useGatewayCheckpoints`, `useGatewayApprovals`), not just their pure parsers.
 * `gateway-recovery.test.ts` already covers `parseGatewayRecovery` /
 * `parseGatewayCheckpoints` / `parseGatewayApprovals` in isolation (real
 * payload, missing field, empty object) — this file covers the same four
 * cases through the REAL hook (mocked `fetch`, real `useEffect`/`useState`),
 * plus what a pure-function test cannot: a fetch failure never crashing the
 * hook or leaving it in a fabricated state (wire-recovery,
 * forge-2026-07-29-cc-finish).
 *
 * `vi.stubGlobal('fetch', ...)` mirrors `no-prototype-copy.test.ts`'s own
 * `installFetchMock` — `gwGet` (`gateway-client.ts`) never throws on a
 * failed/mocked fetch, so this exercises the real production hook code path
 * against a fetch double, never a live gateway on :4100.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

import {
  EMPTY_GATEWAY_APPROVALS,
  EMPTY_GATEWAY_CHECKPOINTS,
  EMPTY_GATEWAY_RECOVERY,
  useGatewayApprovals,
  useGatewayCheckpoints,
  useGatewayRecovery,
} from '@/prototype/state/gateway-recovery';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ========================================================================== */
/*  1. useGatewayRecovery                                                     */
/* ========================================================================== */

describe('useGatewayRecovery (hook, not just the parser)', () => {
  it('a real payload resolves to real values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          recovery_attempts: [{ objective: 'resolve a 401', finalStatus: 'FOUND_VIA_GITHUB_SEARCH' }],
          recovery_attempts_count: 1,
          recovery_provenance: 'LIVE',
          docdrift: {
            last_check: '2026-07-28T23:21:10.098Z',
            sources: ['https://docs.anthropic.com/en/docs/claude-code/hooks-guide'],
            findings: [{ rule_id: 'agent-memory-scope', drifted: false, last_status: 'OK', last_checked: '2026-07-28T23:21:06.713Z' }],
            findings_count: 11,
            drifted_count: 0,
            provenance: 'LIVE',
          },
        }),
      ),
    );

    const { result } = renderHook(() => useGatewayRecovery('demo-project'));

    await waitFor(() => expect(result.current.recoveryAttemptsCount).toBe(1));
    expect(result.current.recoveryAttempts).toEqual([{ objective: 'resolve a 401', finalStatus: 'FOUND_VIA_GITHUB_SEARCH' }]);
    expect(result.current.recoveryProvenance).toBe('LIVE');
    expect(result.current.docdriftFindingsCount).toBe(11);
    expect(result.current.docdriftDriftedCount).toBe(0);
  });

  it('a missing field resolves to null, never a fabricated default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true, recovery_attempts: [], recovery_attempts_count: 0 })),
    );

    const { result } = renderHook(() => useGatewayRecovery('demo-project'));

    await waitFor(() => expect(result.current.recoveryProvenance).toBeNull());
    expect(result.current.docdriftProvenance).toBeNull();
    expect(result.current.docdriftFindings).toEqual([]);
  });

  it('a genuinely empty ledger (NOT CONFIGURED) never renders a fabricated row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          recovery_attempts: [],
          recovery_attempts_count: 0,
          recovery_provenance: 'NOT CONFIGURED',
          docdrift: { last_check: null, sources: [], findings: [], findings_count: 0, drifted_count: 0, provenance: 'NOT CONFIGURED' },
        }),
      ),
    );

    const { result } = renderHook(() => useGatewayRecovery('demo-project'));

    await waitFor(() => expect(result.current.recoveryProvenance).toBe('NOT CONFIGURED'));
    expect(result.current.recoveryAttempts).toEqual([]);
  });

  it('a gateway/network error leaves the hook at its honest empty default, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const { result } = renderHook(() => useGatewayRecovery('demo-project'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.current).toEqual(EMPTY_GATEWAY_RECOVERY);
  });

  it('an empty project name never fetches — no active project selected', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    renderHook(() => useGatewayRecovery(''));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/*  2. useGatewayCheckpoints                                                  */
/* ========================================================================== */

describe('useGatewayCheckpoints (hook, not just the parser)', () => {
  it('a real payload resolves to real values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          resume_state: { available: true, data: { interrupted_at: 'wp3' } },
          runs_with_manifest: [{ run_id: 'run-1', manifest_present: true, manifest: { version: 1 } }],
          runs_with_manifest_count: 1,
          provenance: 'LIVE',
        }),
      ),
    );

    const { result } = renderHook(() => useGatewayCheckpoints('demo-project'));

    await waitFor(() => expect(result.current.provenance).toBe('LIVE'));
    expect(result.current.resumeAvailable).toBe(true);
    expect(result.current.runsWithManifest).toEqual([{ runId: 'run-1', manifestPresent: true, manifest: { version: 1 } }]);
  });

  it('a missing field resolves to null, never a fabricated default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })));

    const { result } = renderHook(() => useGatewayCheckpoints('demo-project'));

    await waitFor(() => expect(result.current.provenance).toBeNull());
    expect(result.current.resumeAvailable).toBe(false);
    expect(result.current.resumeNote).toBeNull();
  });

  it('the real live-verified empty case: no resume state, no manifest — NOT CONFIGURED, not fabricated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          resume_state: { available: false, note: "no FORGE_RESUME_STATE.json found under this project's .claude" },
          runs_with_manifest: [],
          runs_with_manifest_count: 0,
          provenance: 'NOT CONFIGURED',
        }),
      ),
    );

    const { result } = renderHook(() => useGatewayCheckpoints('demo-project'));

    await waitFor(() => expect(result.current.provenance).toBe('NOT CONFIGURED'));
    expect(result.current.runsWithManifest).toEqual([]);
    expect(result.current.resumeAvailable).toBe(false);
  });

  it('a gateway error (HTTP 500) leaves the hook at its honest empty default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false, 500)));

    const { result } = renderHook(() => useGatewayCheckpoints('demo-project'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.current).toEqual(EMPTY_GATEWAY_CHECKPOINTS);
  });
});

/* ========================================================================== */
/*  3. useGatewayApprovals                                                    */
/* ========================================================================== */

describe('useGatewayApprovals (hook, not just the parser)', () => {
  it('a real payload resolves to real gate + evaluation values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          gates: [{ id: 'deploy', class: 'irreversible', reason: 'Deploying is irreversible without owner approval.' }],
          gates_count: 1,
          gates_provenance: 'LIVE',
          evaluations: [
            {
              event_type: 'quality_gate_blocked',
              gate_id: 'deploy',
              agent: 'build-boss',
              role: 'wire-recovery',
              owner_confirmed: false,
              reason: 'awaiting owner',
              timestamp: '2026-07-29T00:00:00.000Z',
            },
          ],
          evaluations_count: 1,
          evaluations_provenance: 'LIVE',
        }),
      ),
    );

    const { result } = renderHook(() => useGatewayApprovals('demo-project', 'run-1'));

    await waitFor(() => expect(result.current.evaluations).toHaveLength(1));
    expect(result.current.evaluations[0].gateId).toBe('deploy');
    expect(result.current.evaluations[0].ownerConfirmed).toBe(false);
    expect(result.current.gates[0].id).toBe('deploy');
  });

  it('a missing field resolves to null, never a fabricated default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, gates: [], gates_count: 0 })));

    const { result } = renderHook(() => useGatewayApprovals('demo-project', null));

    await waitFor(() => expect(result.current.gatesProvenance).toBeNull());
    expect(result.current.evaluationsProvenance).toBeNull();
  });

  it('distinguishes NOT REQUESTED (no run given) from a real LIVE-but-empty answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('run=')) {
          return jsonResponse({
            ok: true,
            gates: [],
            gates_count: 0,
            gates_provenance: 'NOT CONFIGURED',
            evaluations: [],
            evaluations_count: 0,
            evaluations_provenance: 'LIVE',
          });
        }
        return jsonResponse({
          ok: true,
          gates: [],
          gates_count: 0,
          gates_provenance: 'NOT CONFIGURED',
          evaluations: [],
          evaluations_count: 0,
          evaluations_provenance: 'NOT REQUESTED',
        });
      }),
    );

    const { result, rerender } = renderHook(
      ({ runId }: { runId: string | null }) => useGatewayApprovals('demo-project', runId),
      { initialProps: { runId: null as string | null } },
    );

    await waitFor(() => expect(result.current.evaluationsProvenance).toBe('NOT REQUESTED'));

    rerender({ runId: 'run-1' });

    await waitFor(() => expect(result.current.evaluationsProvenance).toBe('LIVE'));
    expect(result.current.evaluations).toEqual([]);
  });

  it('a gateway/network error leaves the hook at its honest empty default, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );

    const { result } = renderHook(() => useGatewayApprovals('demo-project', null));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(result.current).toEqual(EMPTY_GATEWAY_APPROVALS);
  });

  it('an empty project name never fetches — no active project selected', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    renderHook(() => useGatewayApprovals('', 'run-1'));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
