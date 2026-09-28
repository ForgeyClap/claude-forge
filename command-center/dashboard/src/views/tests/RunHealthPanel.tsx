/**
 * RunHealthPanel — WP-CCD (item 6): the run's own gate evidence, finalize receipt, run contract
 * and Codex-style reviews, next to the pre-existing gate board / proof ledger in `TestsView.tsx`.
 *
 * All FOUR are REAL `/api/proof` fields — read defensively throughout regardless (every sub-section
 * renders its own honest "not available yet" empty state when the field/source genuinely does not
 * exist for this run). REVIEW FIX: the exact shapes are now verified live against
 * `_scratch/wt-cc1-snap/gateway/src/proof.mjs::buildProof()` — see `graph-and-proof.ts`'s own header
 * and each parser's own doc comment for exactly what changed (`reviews` already matched; `finalize`/
 * `contract`'s top-level KEY NAMES did not — `finalize_receipt`/`run_contract` — and always read
 * "not available" on real data before this fix).
 *
 * Existing primitives/classes only — `Eyebrow`/`Icon`/`Machine`/`Panel`/`EmptyState`, and this
 * view's own `.fw-tests__panel`/`.fw-tests__stat` treatment, extended with a handful of new,
 * narrowly-scoped classes in `run-health-panel.css` that reuse existing tokens only.
 */

import { Eyebrow, Icon, Machine, Panel } from '@/components/primitives';
import type { GatewayProofExtras } from '@/prototype/state/gateway-adapter';
import './run-health-panel.css';

function GateEvidenceSection({ gateEvidence }: { gateEvidence: GatewayProofExtras['gateEvidence'] }) {
  if (!gateEvidence.present) {
    return (
      <section className="fw-run-health__section">
        <Eyebrow>Gate evidence</Eyebrow>
        <p className="fw-run-health__empty">No gate-evidence record has been read for this run yet.</p>
      </section>
    );
  }
  return (
    <section className="fw-run-health__section">
      <Eyebrow>Gate evidence</Eyebrow>
      <dl className="fw-run-health__facts">
        <div className="fw-run-health__fact">
          <dt>Gates run</dt>
          <dd>
            <Machine>{gateEvidence.gatesTotal ?? '—'}</Machine>
          </dd>
        </div>
        <div className="fw-run-health__fact">
          <dt>Gates failed</dt>
          <dd>
            <Machine>{gateEvidence.gatesFailed ?? '—'}</Machine>
          </dd>
        </div>
        <div className="fw-run-health__fact">
          <dt>All green</dt>
          <dd>
            <span className="fw-run-health__flag" data-flag={gateEvidence.allGreen === null ? 'unknown' : String(gateEvidence.allGreen)}>
              <Icon name={gateEvidence.allGreen === true ? 'CircleCheck' : gateEvidence.allGreen === false ? 'CircleX' : 'CircleDashed'} size="xs" />
              <Machine>{gateEvidence.allGreen === null ? 'unknown' : gateEvidence.allGreen ? 'yes' : 'no'}</Machine>
            </span>
          </dd>
        </div>
        {gateEvidence.generatedAt !== null ? (
          <div className="fw-run-health__fact">
            <dt>Generated</dt>
            <dd>
              <Machine muted>{gateEvidence.generatedAt}</Machine>
            </dd>
          </div>
        ) : null}
      </dl>
      {/* REVIEW FIX (WP-CCD item 6): the real per-gate breakdown (`gate-evidence.json`'s own
          `gates[]`, readable names) — reuses `.fw-run-health__reviews`/`.fw-run-health__review`'s
          exact flex-row-card treatment (this same file's Reviews section below), never a new visual
          language: both are "an icon-ish status + a label + muted meta" row. */}
      {gateEvidence.gates.length > 0 ? (
        <ul className="fw-run-health__reviews">
          {gateEvidence.gates.map((gate, index) => (
            <li key={gate.name ?? `gate-${index}`} className="fw-run-health__review">
              <Icon name={gate.exitCode === 0 ? 'CircleCheck' : 'CircleX'} size="xs" />
              <span className="fw-run-health__review-subject fw-truncate">{gate.name ?? 'unnamed gate'}</span>
              {gate.exitCode !== null ? <Machine muted>exit {gate.exitCode}</Machine> : null}
              {gate.timedOut === true ? <Machine muted>timed out</Machine> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {gateEvidence.note !== null ? <p className="fw-run-health__note">{gateEvidence.note}</p> : null}
    </section>
  );
}

function FinalizeSection({ finalize }: { finalize: GatewayProofExtras['finalize'] }) {
  return (
    <section className="fw-run-health__section">
      <Eyebrow>Finalize receipt</Eyebrow>
      {finalize.present ? (
        <dl className="fw-run-health__facts">
          {finalize.finalizedAt !== null ? (
            <div className="fw-run-health__fact">
              <dt>Finalized</dt>
              <dd>
                <Machine muted>{finalize.finalizedAt}</Machine>
              </dd>
            </div>
          ) : null}
          {finalize.digest !== null ? (
            <div className="fw-run-health__fact">
              <dt>Digest</dt>
              <dd>
                <Machine muted className="fw-truncate">
                  {finalize.digest}
                </Machine>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : finalize.invalidReason !== null ? (
        // RB2-M1: a receipt exists but no longer counts — say why, never that the file does not exist.
        <p className="fw-run-health__note">A finalize receipt exists but no longer counts: {finalize.invalidReason}.</p>
      ) : (
        <p className="fw-run-health__empty">This run has not been finalized yet — no `run-finalized.json` receipt exists.</p>
      )}
    </section>
  );
}

function ContractSection({ contract }: { contract: GatewayProofExtras['contract'] }) {
  return (
    <section className="fw-run-health__section">
      <Eyebrow>Run contract</Eyebrow>
      {contract.present ? (
        <>
          <p className="fw-run-health__contract-status" data-status={contract.status ?? 'unknown'}>
            <Icon name={contract.status === 'green' ? 'CircleCheck' : contract.status === 'red' ? 'CircleX' : 'CircleDashed'} size="xs" />
            <Machine>{contract.status ?? 'unknown'}</Machine>
          </p>
          {/* REVIEW FIX (found via real screenshot verification, WP-CCD item 6): a real
              `run_contract.note` (e.g. "the central forge-runcontract.cjs was not found") was parsed
              but never rendered anywhere — a genuinely unknown status showed with no explanation of
              WHY, even when the gateway supplied a perfectly good one. */}
          {contract.note !== null ? <p className="fw-run-health__note">{contract.note}</p> : null}
          {contract.missingRules.length > 0 ? (
            <ul className="fw-run-health__missing">
              {contract.missingRules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="fw-run-health__empty">No run-contract check has been recorded for this run yet.</p>
      )}
    </section>
  );
}

function ReviewsSection({ reviews }: { reviews: GatewayProofExtras['reviews'] }) {
  if (reviews.length === 0) {
    return (
      <section className="fw-run-health__section">
        <Eyebrow>Reviews</Eyebrow>
        <p className="fw-run-health__empty">No review has been recorded for this run yet.</p>
      </section>
    );
  }
  return (
    <section className="fw-run-health__section">
      <Eyebrow>Reviews</Eyebrow>
      <ul className="fw-run-health__reviews">
        {reviews.map((review) => (
          <li key={review.reviewId} className="fw-run-health__review">
            <span className="fw-run-health__review-verdict" data-verdict={review.verdict ?? 'unknown'}>
              <Machine>{review.verdict ?? 'unknown'}</Machine>
            </span>
            <span className="fw-run-health__review-subject fw-truncate">{review.subject ?? review.reviewId}</span>
            <Machine muted>{review.agent ?? 'unknown reviewer'}</Machine>
            {review.commitSha !== null ? <Machine muted>{review.commitSha}</Machine> : null}
            {review.completedAt !== null ? <Machine muted>{review.completedAt}</Machine> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RunHealthPanel({ extras }: { extras: GatewayProofExtras }) {
  return (
    <Panel
      title="Run health"
      subtitle="Gate evidence, the finalize receipt, the run contract, and any recorded reviews for this run."
      padded={false}
      className="fw-tests__panel"
    >
      <div className="fw-run-health">
        <GateEvidenceSection gateEvidence={extras.gateEvidence} />
        <FinalizeSection finalize={extras.finalize} />
        <ContractSection contract={extras.contract} />
        <ReviewsSection reviews={extras.reviews} />
      </div>
    </Panel>
  );
}

export default RunHealthPanel;
