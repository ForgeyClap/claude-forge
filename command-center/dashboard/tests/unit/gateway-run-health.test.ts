/**
 * gateway-adapter.ts / adapter/graph-and-proof.ts — `/api/proof`'s reviews / gate-evidence /
 * finalize-receipt / run-contract fields (WP-CCD item 6).
 *
 * The paused WIP shipped these four parsers with NO unit test coverage at all, and its own doc
 * comment honestly flagged `finalize`/`contract`'s field names as "a best-effort guess pending the
 * real gateway shape". Both guesses turned out wrong once verified against
 * `_scratch/wt-cc1-snap/gateway/src/proof.mjs::buildProof()` — the real top-level keys are
 * `finalize_receipt`/`run_contract` (not `finalize`/`contract`), and `run_contract` is a two-level
 * envelope (`{available, result: {ok, missing, ...}}`), never the flat `{status, missing_rules}`
 * shape previously assumed. `reviews` and `gate_evidence`'s core aggregate fields DID already match;
 * `gate_evidence` gained a real `gates[]`/`commit`/`worktree_clean` reading it was missing.
 *
 * Pure-function tests, no network — imported directly from the sibling module (not part of the
 * smaller public `gateway-adapter.ts` barrel), the same established pattern this codebase already
 * uses (see `gateway-mission-verify.test.ts`'s own header for the precedent).
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_FINALIZE_RECEIPT,
  EMPTY_GATE_EVIDENCE,
  EMPTY_RUN_CONTRACT,
  parseFinalizeReceipt,
  parseGateEvidence,
  parseGatewayReviews,
  parseRunContract,
  toGatewayArtifact,
} from '@/prototype/state/adapter/graph-and-proof';

describe('parseGatewayReviews — the real /api/proof "reviews" shape (already correct, regression-pinned)', () => {
  it('reads a real review row straight through', () => {
    const reviews = parseGatewayReviews({
      reviews: [{ review_id: 'r1', agent: 'Review Boss', subject: 'WP-CCD adapter fix', verdict: 'approved', commit_sha: 'abc1234', completed_at: '2026-09-28T10:00:00.000Z' }],
    });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual({
      reviewId: 'r1',
      agent: 'Review Boss',
      verdict: 'approved',
      subject: 'WP-CCD adapter fix',
      commitSha: 'abc1234',
      completedAt: '2026-09-28T10:00:00.000Z',
    });
  });

  it('no reviews field at all reads back an empty list, never fabricated', () => {
    expect(parseGatewayReviews({})).toEqual([]);
    expect(parseGatewayReviews(null)).toEqual([]);
  });
});

describe('parseGateEvidence — real gate_evidence, including the per-gate gates[] breakdown (review fix)', () => {
  it('reads the aggregate numbers AND the real per-gate breakdown, commit and worktree_clean', () => {
    const evidence = parseGateEvidence({
      gate_evidence: {
        gates_total: 3,
        gates_failed: 1,
        all_green: false,
        generated_at: '2026-09-28T09:00:00.000Z',
        commit: 'deadbeef',
        worktree_clean: true,
        gates: [
          { name: 'npm test', exit_code: 0, duration_ms: 1200, timed_out: false },
          { name: 'eslint', exit_code: 1, duration_ms: 300, timed_out: false },
        ],
      },
    });
    expect(evidence.present).toBe(true);
    expect(evidence.gatesTotal).toBe(3);
    expect(evidence.gatesFailed).toBe(1);
    expect(evidence.allGreen).toBe(false);
    expect(evidence.commit).toBe('deadbeef');
    expect(evidence.worktreeClean).toBe(true);
    expect(evidence.gates).toEqual([
      { name: 'npm test', exitCode: 0, durationMs: 1200, timedOut: false },
      { name: 'eslint', exitCode: 1, durationMs: 300, timedOut: false },
    ]);
  });

  it('a gate_evidence object with no gates[] array at all reads back an honest empty array', () => {
    const evidence = parseGateEvidence({ gate_evidence: { gates_total: 0, gates_failed: 0, all_green: true } });
    expect(evidence.gates).toEqual([]);
  });

  it('no gate_evidence field at all is the honest empty state', () => {
    expect(parseGateEvidence({})).toEqual(EMPTY_GATE_EVIDENCE);
    expect(parseGateEvidence(null)).toEqual(EMPTY_GATE_EVIDENCE);
  });
});

describe('parseFinalizeReceipt — the REAL top-level key is finalize_receipt, not finalize (review fix)', () => {
  it('REGRESSION: reads a real finalize_receipt object (the actual gateway key)', () => {
    const receipt = parseFinalizeReceipt({
      finalize_receipt: { digest: 'sha256:abc123', finalized_at: '2026-09-28T11:00:00.000Z', contract: 'green', domain: 'tooling', events: 500 },
    });
    expect(receipt.present).toBe(true);
    expect(receipt.digest).toBe('sha256:abc123');
    expect(receipt.finalizedAt).toBe('2026-09-28T11:00:00.000Z');
  });

  it('FALLBACK: the old speculative "finalize" key still parses, for a differently-shaped build', () => {
    const receipt = parseFinalizeReceipt({ finalize: { digest: 'sha256:def456', finalized_at: '2026-09-28T12:00:00.000Z' } });
    expect(receipt.present).toBe(true);
    expect(receipt.digest).toBe('sha256:def456');
  });

  it('no finalize_receipt/finalize field at all (a run genuinely not finalized) is the honest empty state', () => {
    expect(parseFinalizeReceipt({})).toEqual(EMPTY_FINALIZE_RECEIPT);
  });
});

describe('parseRunContract — the REAL nested run_contract.{available,result} envelope (review fix)', () => {
  it('REGRESSION: a real PASSING run_contract (available:true, result.ok:true) reads status "green" with no missing rules', () => {
    const contract = parseRunContract({
      run_contract: {
        available: true,
        checked_at: '2026-09-28T13:00:00.000Z',
        result: { ok: true, run_id: 'r1', missing: [], satisfied: ['independent-verification', 'evidence-required'] },
      },
    });
    expect(contract.present).toBe(true);
    expect(contract.status).toBe('green');
    expect(contract.missingRules).toEqual([]);
  });

  it('REGRESSION: a real FAILING run_contract (result.ok:false) reads status "red" with the real missing rule ids', () => {
    const contract = parseRunContract({
      run_contract: {
        available: true,
        result: { ok: false, missing: ['independent-verification', 'screenshot-evidence'] },
      },
    });
    expect(contract.status).toBe('red');
    expect(contract.missingRules).toEqual(['independent-verification', 'screenshot-evidence']);
  });

  it('available:false (the checker itself could not run) is present:true with an honest note, status null — never guessed red/green', () => {
    const contract = parseRunContract({
      run_contract: { available: false, note: 'the central forge-runcontract.cjs was not found', checked_at: '2026-09-28T13:00:00.000Z' },
    });
    expect(contract.present).toBe(true);
    expect(contract.status).toBeNull();
    expect(contract.note).toBe('the central forge-runcontract.cjs was not found');
  });

  it('FALLBACK: the old speculative flat {status, missing_rules} shape under "contract" still parses', () => {
    const contract = parseRunContract({ contract: { status: 'red', missing_rules: ['some-rule'] } });
    // The flat fallback shape has no `available`/`result` at all, so `available` reads as the honest
    // `false` default — this exercises the "no real result object" branch, not a guessed pass.
    expect(contract.present).toBe(true);
    expect(contract.status).toBeNull();
  });

  it('no run_contract/contract field at all (a gateway build that predates this) is the honest empty state', () => {
    expect(parseRunContract({})).toEqual(EMPTY_RUN_CONTRACT);
    expect(parseRunContract(null)).toEqual(EMPTY_RUN_CONTRACT);
  });
});

/* ========================================================================== */
/*  resolveArtifactKind (via toGatewayArtifact) — WP-CCD item 11              */
/* ========================================================================== */

describe('toGatewayArtifact kind — synonym mapping + extension inference (WP-CCD item 11)', () => {
  it('an exact known kind passes through unchanged', () => {
    expect(toGatewayArtifact({ type: 'screenshot', name: 'x.png' }, 0).kind).toBe('screenshot');
  });

  it('"final-report"/"finalize"/"gate-evidence" synonyms map to the closest real ArtifactKind', () => {
    expect(toGatewayArtifact({ type: 'final-report', name: 'final-report.md' }, 0).kind).toBe('report');
    expect(toGatewayArtifact({ type: 'gate-evidence', name: 'gate-evidence.json' }, 0).kind).toBe('proof');
    expect(toGatewayArtifact({ type: 'finalize', name: 'run-finalized.json' }, 0).kind).toBe('proof');
    expect(toGatewayArtifact({ type: 'research', name: 'notes.md' }, 0).kind).toBe('markdown');
  });

  it('an unknown type with no synonym falls back to the file extension', () => {
    expect(toGatewayArtifact({ type: 'something-new', name: 'notes.md' }, 0).kind).toBe('markdown');
    expect(toGatewayArtifact({ type: 'something-new', name: 'screen.png' }, 0).kind).toBe('screenshot');
  });

  it('no type at all still infers a real kind from the extension, never defaulting straight to log', () => {
    expect(toGatewayArtifact({ name: 'playwright-desktop.png' }, 0).kind).toBe('screenshot');
    expect(toGatewayArtifact({ path: 'vault/notes/lesson.md' }, 0).kind).toBe('markdown');
  });

  it('neither a type nor a recognisable extension honestly falls back to "log"', () => {
    expect(toGatewayArtifact({ name: 'data.bin' }, 0).kind).toBe('log');
  });
});
