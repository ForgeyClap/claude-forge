/**
 * Render-level coverage for the two panels wire-recovery mounted
 * (forge-2026-07-29-cc-finish): `ApprovalsMeta` (Mission Control's header) and
 * `RecoveryPanel` (Activity's footer). Both are plain, prop/hook-driven
 * components with no `PrototypeContext` dependency, so they render directly —
 * no store harness needed. `RecoveryPanel` calls the real gateway hooks
 * itself, so its own `fetch` is mocked here the same way
 * `gateway-recovery-hooks.test.ts` and `no-prototype-copy.test.ts` already do.
 *
 * Covers: a real payload renders real values; a genuinely empty collection
 * renders `EmptyState`, never a fabricated row; and neither panel ever prints
 * a forbidden prototype/example word for either state. `FORBIDDEN_PATTERNS` is
 * intentionally re-declared narrowly here rather than imported from
 * `no-prototype-copy.test.ts` — importing one vitest test file from another
 * would re-register that file's own `describe`/`it` blocks a second time.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { ApprovalsMeta } from '@/views/mission/ApprovalsMeta';
import { RecoveryPanel } from '@/views/activity/RecoveryPanel';
import { EMPTY_GATEWAY_APPROVALS } from '@/prototype/state/gateway-recovery';
import type { GatewayApprovals } from '@/prototype/state/gateway-recovery';

/* ========================================================================== */
/*  Forbidden vocabulary — narrow local copy, see file header                 */
/* ========================================================================== */

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bexample\b/i,
  /\bprototype\b/i,
  /\bplaceholder\b/i,
  /\bnot connected\b/i,
  /\bno backend\b/i,
  /\bnothing was generated\b/i,
  /\bsimulated\b/i,
];

function scanForbidden(container: HTMLElement): string[] {
  const text = container.textContent ?? '';
  return FORBIDDEN_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ========================================================================== */
/*  1. ApprovalsMeta                                                          */
/* ========================================================================== */

describe('ApprovalsMeta', () => {
  it('renders a real blocked gate evaluation with status, gate id and timestamp', () => {
    const approvals: GatewayApprovals = {
      ok: true,
      gates: [{ id: 'deploy', class: 'irreversible', reason: 'Deploying is irreversible without owner approval.' }],
      gatesCount: 1,
      gatesProvenance: 'LIVE',
      evaluations: [
        {
          eventType: 'quality_gate_blocked',
          gateId: 'deploy',
          agent: 'build-boss',
          role: 'wire-recovery',
          ownerConfirmed: false,
          reason: 'awaiting owner',
          timestamp: '2026-07-29T00:00:00.000Z',
        },
      ],
      evaluationsCount: 1,
      evaluationsProvenance: 'LIVE',
    };

    const { container, getByText, getAllByText } = render(<ApprovalsMeta approvals={approvals} />);

    expect(getByText('deploy')).toBeTruthy();
    expect(getByText('build-boss')).toBeTruthy();
    expect(getByText('2026-07-29T00:00:00.000Z')).toBeTruthy();
    // Both the summary badge (worst-of) and the per-evaluation badge read BLOCKED here — one real evaluation, both honest.
    expect(getAllByText('BLOCKED')).toHaveLength(2);
    expect(scanForbidden(container)).toEqual([]);
  });

  it('keeps NOT REQUESTED (no run selected) visibly distinct from a real LIVE-but-empty answer', () => {
    const notRequested: GatewayApprovals = { ...EMPTY_GATEWAY_APPROVALS, evaluationsProvenance: 'NOT REQUESTED' };
    const { getByText: getA } = render(<ApprovalsMeta approvals={notRequested} />);
    expect(getA('not requested')).toBeTruthy();

    cleanup();

    const liveEmpty: GatewayApprovals = { ...EMPTY_GATEWAY_APPROVALS, evaluationsProvenance: 'LIVE' };
    const { getByText: getB, container } = render(<ApprovalsMeta approvals={liveEmpty} />);
    expect(getB('none recorded')).toBeTruthy();
    expect(scanForbidden(container)).toEqual([]);
  });

  it('never fabricates a value: no data yet renders a dash, not a guess', () => {
    const { container, getByText } = render(<ApprovalsMeta approvals={EMPTY_GATEWAY_APPROVALS} />);
    expect(getByText('—')).toBeTruthy();
    expect(scanForbidden(container)).toEqual([]);
  });
});

/* ========================================================================== */
/*  2. RecoveryPanel                                                          */
/* ========================================================================== */

describe('RecoveryPanel', () => {
  it('renders real recovery attempts, docdrift counts and checkpoint state from a real payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/recovery')) {
          return jsonResponse({
            ok: true,
            recovery_attempts: [{ objective: 'resolve a skills.sh 401', itemId: 'skills.sh:gws-gmail-reply', finalStatus: 'FOUND_VIA_GITHUB_SEARCH', timestamp: '2026-07-23T00:50:00+0200' }],
            recovery_attempts_count: 1,
            recovery_provenance: 'LIVE',
            docdrift: { last_check: '2026-07-28T23:21:10.098Z', sources: [], findings: [], findings_count: 11, drifted_count: 0, provenance: 'LIVE' },
          });
        }
        if (url.includes('/api/checkpoints')) {
          return jsonResponse({
            ok: true,
            resume_state: { available: false, note: "no FORGE_RESUME_STATE.json found under this project's .claude" },
            runs_with_manifest: [],
            runs_with_manifest_count: 0,
            provenance: 'NOT CONFIGURED',
          });
        }
        return jsonResponse({});
      }),
    );

    const { container, findByText } = render(<RecoveryPanel projectName="my-forge-project" />);

    expect(await findByText('resolve a skills.sh 401')).toBeTruthy();
    expect(await findByText('skills.sh:gws-gmail-reply')).toBeTruthy();
    expect(await findByText('11 rule(s) checked')).toBeTruthy();
    expect(await findByText('0 drifted')).toBeTruthy();
    expect(scanForbidden(container)).toEqual([]);
  });

  it('a genuinely empty ledger + checkpoints renders honest EmptyState, never a fabricated row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/recovery')) {
          return jsonResponse({
            ok: true,
            recovery_attempts: [],
            recovery_attempts_count: 0,
            recovery_provenance: 'NOT CONFIGURED',
            docdrift: { last_check: null, sources: [], findings: [], findings_count: 0, drifted_count: 0, provenance: 'NOT CONFIGURED' },
          });
        }
        if (url.includes('/api/checkpoints')) {
          return jsonResponse({
            ok: true,
            resume_state: { available: false, note: 'no resume state' },
            runs_with_manifest: [],
            runs_with_manifest_count: 0,
            provenance: 'NOT CONFIGURED',
          });
        }
        return jsonResponse({});
      }),
    );

    const { container, findByText } = render(<RecoveryPanel projectName="my-forge-project" />);

    expect(await findByText('No recovery ledger configured')).toBeTruthy();
    expect(await findByText('No run manifests')).toBeTruthy();
    expect(scanForbidden(container)).toEqual([]);
  });

  it('a gateway/network error renders the honest "no data yet" empty state, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const { container, findByText } = render(<RecoveryPanel projectName="my-forge-project" />);

    expect(await findByText('No recovery data yet')).toBeTruthy();
    expect(scanForbidden(container)).toEqual([]);
  });
});
