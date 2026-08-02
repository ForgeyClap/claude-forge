/**
 * `gateway-recovery.ts` — the recovery / checkpoints / approvals parsers
 * (cc-wire-views). No network, no React, no timers: pure-function tests
 * against representative `/api/recovery`, `/api/checkpoints` and
 * `/api/approvals` response shapes, mirroring `account-usage.test.ts`'s own
 * precedent for this seam. These parsers are exposed for a future consumer —
 * see `gateway-adapter.ts`'s header for why no view wires them in this WP.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_GATEWAY_APPROVALS,
  EMPTY_GATEWAY_CHECKPOINTS,
  EMPTY_GATEWAY_RECOVERY,
  parseGatewayApprovals,
  parseGatewayCheckpoints,
  parseGatewayRecovery,
} from '@/prototype/state/gateway-recovery';

describe('parseGatewayRecovery — GET /api/recovery', () => {
  it('reads real recovery attempts and docdrift findings straight off the response', () => {
    const result = parseGatewayRecovery({
      ok: true,
      recovery_attempts: [{ method: 'github-search', final_status: 'FOUND_VIA_GITHUB_SEARCH' }],
      recovery_attempts_count: 1,
      recovery_provenance: 'LIVE',
      docdrift: {
        last_check: '2026-07-28T09:00:00.000Z',
        sources: ['https://example.com/docs'],
        findings: [
          { rule_id: 'rule-1', drifted: true, last_status: 'DRIFTED', last_checked: '2026-07-28T09:00:00.000Z' },
        ],
        findings_count: 1,
        drifted_count: 1,
        provenance: 'LIVE',
      },
      captured_at: '2026-07-28T09:00:01.000Z',
      age_ms: 0,
    });

    expect(result.recoveryAttemptsCount).toBe(1);
    expect(result.recoveryAttempts).toEqual([{ method: 'github-search', final_status: 'FOUND_VIA_GITHUB_SEARCH' }]);
    expect(result.recoveryProvenance).toBe('LIVE');
    expect(result.docdriftFindings).toEqual([
      { ruleId: 'rule-1', drifted: true, lastStatus: 'DRIFTED', lastChecked: '2026-07-28T09:00:00.000Z' },
    ]);
    expect(result.docdriftDriftedCount).toBe(1);
  });

  it('NOT CONFIGURED: no ledger file — every count is a real 0, never a guess', () => {
    const result = parseGatewayRecovery({
      ok: true,
      recovery_attempts: [],
      recovery_attempts_count: 0,
      recovery_provenance: 'NOT CONFIGURED',
      docdrift: { last_check: null, sources: [], findings: [], findings_count: 0, drifted_count: 0, provenance: 'NOT CONFIGURED' },
      captured_at: '2026-07-28T09:00:01.000Z',
      age_ms: 0,
    });

    expect(result.recoveryAttempts).toEqual([]);
    expect(result.recoveryProvenance).toBe('NOT CONFIGURED');
    expect(result.docdriftProvenance).toBe('NOT CONFIGURED');
  });

  it('a missing docdrift key entirely resolves to the honest empty shape, not a crash', () => {
    const result = parseGatewayRecovery({ ok: true, recovery_attempts: [], recovery_attempts_count: 0 });
    expect(result.docdriftFindings).toEqual([]);
    expect(result.docdriftProvenance).toBeNull();
  });

  it('an empty object resolves to the module constant shape', () => {
    expect(parseGatewayRecovery({})).toEqual(EMPTY_GATEWAY_RECOVERY);
  });
});

describe('parseGatewayCheckpoints — GET /api/checkpoints', () => {
  it('reads a real resume state and manifest list', () => {
    const result = parseGatewayCheckpoints({
      ok: true,
      resume_state: { available: true, data: { interrupted_at: 'wp3' } },
      runs_with_manifest: [{ run_id: 'run-1', manifest_present: true, manifest: { version: 1 } }],
      runs_with_manifest_count: 1,
      captured_at: '2026-07-28T09:00:01.000Z',
      age_ms: 0,
      provenance: 'LIVE',
    });

    expect(result.resumeAvailable).toBe(true);
    expect(result.resumeData).toEqual({ interrupted_at: 'wp3' });
    expect(result.runsWithManifest).toEqual([{ runId: 'run-1', manifestPresent: true, manifest: { version: 1 } }]);
    expect(result.provenance).toBe('LIVE');
  });

  it('honestly reports UNAVAILABLE when neither resume state nor any manifest exists', () => {
    const result = parseGatewayCheckpoints({
      ok: true,
      resume_state: { available: false, note: 'no FORGE_RESUME_STATE.json found' },
      runs_with_manifest: [],
      runs_with_manifest_count: 0,
      captured_at: '2026-07-28T09:00:01.000Z',
      age_ms: 0,
      provenance: 'NOT CONFIGURED',
    });

    expect(result.resumeAvailable).toBe(false);
    expect(result.resumeNote).toContain('no FORGE_RESUME_STATE.json');
    expect(result.runsWithManifest).toEqual([]);
    expect(result.provenance).toBe('NOT CONFIGURED');
  });

  it('an empty object resolves to the module constant shape', () => {
    expect(parseGatewayCheckpoints({})).toEqual(EMPTY_GATEWAY_CHECKPOINTS);
  });
});

describe('parseGatewayApprovals — GET /api/approvals', () => {
  it('reads real hard-gate definitions and gate-evaluation events', () => {
    const result = parseGatewayApprovals({
      ok: true,
      gates: [{ id: 'no-secrets-committed', class: 'security', reason: 'never commit a real credential' }],
      gates_count: 1,
      gates_provenance: 'LIVE',
      evaluations: [
        {
          event_type: 'quality_gate_blocked',
          gate_id: 'no-secrets-committed',
          agent: 'build-boss',
          role: 'cc-wire-views',
          owner_confirmed: false,
          reason: 'a secret pattern was detected',
          timestamp: '2026-07-28T09:00:00.000Z',
        },
      ],
      evaluations_count: 1,
      evaluations_provenance: 'LIVE',
      captured_at: '2026-07-28T09:00:01.000Z',
      age_ms: 0,
    });

    expect(result.gates).toEqual([{ id: 'no-secrets-committed', class: 'security', reason: 'never commit a real credential' }]);
    expect(result.evaluations[0].eventType).toBe('quality_gate_blocked');
    expect(result.evaluations[0].ownerConfirmed).toBe(false);
    expect(result.evaluationsProvenance).toBe('LIVE');
  });

  it('distinguishes NOT REQUESTED (no ?run= given) from LIVE-but-empty (asked, found none)', () => {
    const notRequested = parseGatewayApprovals({
      ok: true,
      gates: [],
      gates_count: 0,
      gates_provenance: 'NOT CONFIGURED',
      evaluations: [],
      evaluations_count: 0,
      evaluations_provenance: 'NOT REQUESTED',
    });
    const liveEmpty = parseGatewayApprovals({
      ok: true,
      gates: [],
      gates_count: 0,
      gates_provenance: 'NOT CONFIGURED',
      evaluations: [],
      evaluations_count: 0,
      evaluations_provenance: 'LIVE',
    });

    expect(notRequested.evaluationsProvenance).toBe('NOT REQUESTED');
    expect(liveEmpty.evaluationsProvenance).toBe('LIVE');
    expect(notRequested.evaluations).toEqual(liveEmpty.evaluations);
  });

  it('an empty object resolves to the module constant shape', () => {
    expect(parseGatewayApprovals({})).toEqual(EMPTY_GATEWAY_APPROVALS);
  });
});
