/**
 * Review Boss RB2-M1 (2026-09-29): a finalize receipt that EXISTS but no longer counts comes back from the gateway
 * as `finalize_receipt: null` plus `finalize_invalid_reason`. The panel must show that reason, never claim that no
 * receipt file exists.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunHealthPanel } from '@/views/tests/RunHealthPanel';
import {
  EMPTY_FINALIZE_RECEIPT,
  EMPTY_GATE_EVIDENCE,
  EMPTY_RUN_CONTRACT,
  parseFinalizeReceipt,
} from '@/prototype/state/adapter/graph-and-proof';

describe('RunHealthPanel — a finalize receipt that no longer counts (RB2-M1)', () => {
  it('shows the gateway reason and never says the receipt file does not exist', () => {
    const finalize = parseFinalizeReceipt({ finalize_receipt: null, finalize_invalid_reason: 'the log changed after it was finalized' });
    render(<RunHealthPanel extras={{ reviews: [], gateEvidence: EMPTY_GATE_EVIDENCE, finalize, contract: EMPTY_RUN_CONTRACT }} />);
    expect(screen.getByText(/A finalize receipt exists but no longer counts: the log changed after it was finalized/)).toBeTruthy();
    expect(screen.queryByText(/no `run-finalized\.json` receipt exists/)).toBeNull();
  });

  it('a run genuinely without a receipt still says so', () => {
    render(<RunHealthPanel extras={{ reviews: [], gateEvidence: EMPTY_GATE_EVIDENCE, finalize: EMPTY_FINALIZE_RECEIPT, contract: EMPTY_RUN_CONTRACT }} />);
    expect(screen.getByText(/This run has not been finalized yet/)).toBeTruthy();
  });
});
