/**
 * `gateway-recovery.ts` — `useGatewayRecovery`/`useGatewayCheckpoints` keyed
 * state (P2-8, fix-crossproject, forge-2026-07-29-cc-finish).
 *
 * BUG THIS GUARDS AGAINST: both hooks used to hold a single, ungated
 * `useState<GatewayRecovery|GatewayCheckpoints>`. Switching the selected
 * project immediately re-renders the panel header under the NEW project's
 * name while the rows underneath still show whatever the OLD project's last
 * successful poll produced — up to one `POLL_MS` (15s) in the ordinary case,
 * and PERMANENTLY if the new project's own request fails, because the
 * existing `if (cancelled || !result.ok) return;` early-return left the old
 * state completely untouched. The panel would then attribute one project's
 * drift/checkpoint data to a different project's name — the exact class of
 * dishonesty this codebase polices everywhere else.
 *
 * THE FIX: both hooks now hold `{key, value}` state, gated on
 * `state.key === projectName` at read time — the SAME pattern
 * `useGatewayApprovals` already used in this same file before this WP. A
 * still-in-flight or failed fetch for the new project now reads as the
 * honest `EMPTY_GATEWAY_*` constant instead of the stale previous project's
 * rows.
 *
 * No network, mocked `fetch` only — mirrors `gateway-recovery-hooks.test.ts`'s
 * own precedent (which this file deliberately does NOT edit, to stay clear of
 * the parallel Test Boss's write scope on that exact file this run).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

import {
  EMPTY_GATEWAY_CHECKPOINTS,
  EMPTY_GATEWAY_RECOVERY,
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

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

describe('useGatewayRecovery — a project switch never keeps the previous project\'s rows under the new name', () => {
  it('switching project while the NEW project\'s request fails yields the honest empty constant, never the old project\'s stale recovery attempts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes(encodeURIComponent(PROJECT_A))) {
          return jsonResponse({
            ok: true,
            recovery_attempts: [{ objective: `${PROJECT_A} attempt` }],
            recovery_attempts_count: 1,
            recovery_provenance: 'LIVE',
          });
        }
        if (url.includes(encodeURIComponent(PROJECT_B))) {
          // The new project's own request genuinely fails.
          return jsonResponse({}, false, 500);
        }
        return jsonResponse({ ok: true });
      }),
    );

    const { result, rerender } = renderHook(({ project }: { project: string }) => useGatewayRecovery(project), {
      initialProps: { project: PROJECT_A },
    });

    await waitFor(() => expect(result.current.recoveryAttemptsCount).toBe(1));
    expect(result.current.recoveryAttempts).toEqual([{ objective: `${PROJECT_A} attempt` }]);

    rerender({ project: PROJECT_B });

    // Never PROJECT_A's stale attempts under PROJECT_B's name — the honest
    // empty constant instead, even though the failed request never resolves
    // to a real PROJECT_B value.
    await waitFor(() => expect(result.current).toEqual(EMPTY_GATEWAY_RECOVERY));
  });

  it('switching project while the NEW project\'s request is still in flight does not show the OLD project\'s rows in the meantime', async () => {
    // A plain object property (rather than a bare `let`) so TypeScript's
    // control-flow narrowing does not collapse the field to `null` forever —
    // it is reassigned from inside a `Promise` executor, a different scope.
    const deferred: { resolve: ((value: Response) => void) | null } = { resolve: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes(encodeURIComponent(PROJECT_A))) {
          return jsonResponse({
            ok: true,
            recovery_attempts: [{ objective: `${PROJECT_A} attempt` }],
            recovery_attempts_count: 1,
            recovery_provenance: 'LIVE',
          });
        }
        if (url.includes(encodeURIComponent(PROJECT_B))) {
          return new Promise<Response>((resolve) => {
            deferred.resolve = resolve;
          });
        }
        return jsonResponse({ ok: true });
      }),
    );

    const { result, rerender } = renderHook(({ project }: { project: string }) => useGatewayRecovery(project), {
      initialProps: { project: PROJECT_A },
    });

    await waitFor(() => expect(result.current.recoveryAttemptsCount).toBe(1));

    rerender({ project: PROJECT_B });

    // While PROJECT_B's fetch is still pending, the panel must read as empty,
    // never as PROJECT_A's still-cached rows under PROJECT_B's header.
    expect(result.current).toEqual(EMPTY_GATEWAY_RECOVERY);

    deferred.resolve?.(
      jsonResponse({
        ok: true,
        recovery_attempts: [{ objective: `${PROJECT_B} attempt` }],
        recovery_attempts_count: 1,
        recovery_provenance: 'LIVE',
      }),
    );

    await waitFor(() => expect(result.current.recoveryAttempts).toEqual([{ objective: `${PROJECT_B} attempt` }]));
  });
});

describe('useGatewayCheckpoints — a project switch never keeps the previous project\'s manifests under the new name', () => {
  it('switching project while the NEW project\'s request fails yields the honest empty constant, never the old project\'s stale manifests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes(encodeURIComponent(PROJECT_A))) {
          return jsonResponse({
            ok: true,
            resume_state: { available: true, data: { interrupted_at: 'wp3' } },
            runs_with_manifest: [{ run_id: 'run-1', manifest_present: true, manifest: { version: 1 } }],
            runs_with_manifest_count: 1,
            provenance: 'LIVE',
          });
        }
        if (url.includes(encodeURIComponent(PROJECT_B))) {
          return jsonResponse({}, false, 500);
        }
        return jsonResponse({ ok: true });
      }),
    );

    const { result, rerender } = renderHook(({ project }: { project: string }) => useGatewayCheckpoints(project), {
      initialProps: { project: PROJECT_A },
    });

    await waitFor(() => expect(result.current.resumeAvailable).toBe(true));
    expect(result.current.runsWithManifest).toHaveLength(1);

    rerender({ project: PROJECT_B });

    await waitFor(() => expect(result.current).toEqual(EMPTY_GATEWAY_CHECKPOINTS));
  });

  it('an empty project name never fetches and never carries over a previous real project\'s state', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useGatewayCheckpoints(''));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current).toEqual(EMPTY_GATEWAY_CHECKPOINTS);
  });
});
