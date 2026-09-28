// Codex run B F-11 — unit tests for the shared receipt validator, in isolation from runs.mjs/proof.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalizeReceipt } from '../src/receipt-validator.mjs';

const REAL_DIGEST = 'f79e99e0f0492f3e6eb0d4f8af1bb84f14e869a53d71684d9fb0a2e5f03343a8'.slice(0, 64).padEnd(64, 'a');
const REAL_RECEIPT = { schema: 2, run_id: 'run-x', digest: REAL_DIGEST, bytes: 1234, events: 10, contract: 'ok', domain: 'tooling', ruleset_sha256: 'b'.repeat(64), finalized_at: '2026-09-28T00:00:00.000Z' };
// The live log exactly as the receipt pinned it (events-digest.mjs shape).
const OK_LOG = { state: 'ok', bytes: REAL_RECEIPT.bytes, digest: REAL_DIGEST };

test('F-11 hostile: {} is refused (the exact bug — any parseable object used to count as finalized)', () => {
  const result = validateFinalizeReceipt({}, 'run-x', OK_LOG);
  assert.equal(result.valid, false);
  assert.match(result.reason, /receipt_invalid/);
});

test('F-11 hostile: [] is refused (typeof [] === "object" in JS — the same trap)', () => {
  const result = validateFinalizeReceipt([], 'run-x', OK_LOG);
  assert.equal(result.valid, false);
  assert.match(result.reason, /not a plain object/);
});

test('F-11 hostile: a receipt for a DIFFERENT run_id is refused', () => {
  const result = validateFinalizeReceipt({ ...REAL_RECEIPT, run_id: 'run-other' }, 'run-x', OK_LOG);
  assert.equal(result.valid, false);
  assert.match(result.reason, /run_id/);
});

test('F-11 hostile: a malformed digest (wrong length / non-hex) is refused', () => {
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, digest: 'short' }, 'run-x', OK_LOG).valid, false);
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, digest: 'z'.repeat(64) }, 'run-x', OK_LOG).valid, false);
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, digest: 123 }, 'run-x', OK_LOG).valid, false);
});

test('F-11 hostile: a non-green contract is refused', () => {
  const result = validateFinalizeReceipt({ ...REAL_RECEIPT, contract: 'fail' }, 'run-x', OK_LOG);
  assert.equal(result.valid, false);
  assert.match(result.reason, /contract/);
});

test('F-11 hostile: missing bytes/events counts are refused', () => {
  const { bytes, ...noBytes } = REAL_RECEIPT;
  assert.equal(validateFinalizeReceipt(noBytes, 'run-x', OK_LOG).valid, false);
  const { events, ...noEvents } = REAL_RECEIPT;
  assert.equal(validateFinalizeReceipt(noEvents, 'run-x', OK_LOG).valid, false);
});

test('F-11 ordinary case: a real, well-formed receipt whose log still matches validates', () => {
  const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x', OK_LOG);
  assert.equal(result.valid, true);
  assert.equal(result.receipt.digest, REAL_DIGEST);
});

test('F-11 ordinary case: null (absent file) is reported distinctly from an invalid one', () => {
  const result = validateFinalizeReceipt(null, 'run-x', OK_LOG);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'absent');
});

test('F-11 hostile: a primitive (string/number/null-ish-but-not-null) is refused, never crashes', () => {
  assert.equal(validateFinalizeReceipt('not an object', 'run-x', OK_LOG).valid, false);
  assert.equal(validateFinalizeReceipt(42, 'run-x', OK_LOG).valid, false);
  assert.equal(validateFinalizeReceipt(true, 'run-x', OK_LOG).valid, false);
});

test('Codex verification F-11: an empty receipt (bytes 0, events 0) is never proof of a finalize', () => {
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, bytes: 0 }, 'run-x', OK_LOG).valid, false);
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, events: 0 }, 'run-x', OK_LOG).valid, false);
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, events: 2.5 }, 'run-x', OK_LOG).valid, false);
  assert.equal(validateFinalizeReceipt(REAL_RECEIPT, 'run-x', OK_LOG).valid, true, 'the real shape still validates');
});

// WP-RB-CC (review finding M-1), made strict by the Codex review of 2026-09-28 (R1): a receipt only
// counts while the CURRENT events.jsonl still has the receipt's exact byte size AND sha256.
test('M-1: a receipt is refused once the log grew after finalizing', () => {
  const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x', { ...OK_LOG, bytes: REAL_RECEIPT.bytes + 40 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'the log changed after it was finalized');
});

test('M-1: a SHRUNK log (truncated or replaced) is refused too', () => {
  const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x', { ...OK_LOG, bytes: REAL_RECEIPT.bytes - 40 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'the log changed after it was finalized');
});

test('Codex R1: an EQUAL-LENGTH edit (same bytes, different content) is refused — the size alone never vouches for the log', () => {
  const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x', { ...OK_LOG, digest: 'c'.repeat(64) });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'the log changed after it was finalized');
});

test('Codex R1: the digest comparison ignores hex letter case only', () => {
  assert.equal(validateFinalizeReceipt(REAL_RECEIPT, 'run-x', { ...OK_LOG, digest: REAL_DIGEST.toUpperCase() }).valid, true);
});

test('Codex R1: a MISSING log never lets a receipt count', () => {
  const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x', { state: 'missing' });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'the run log is missing, so the receipt cannot be checked');
});

test('Codex R1: an UNREADABLE log never lets a receipt count', () => {
  const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x', { state: 'unreadable', reason: 'EPERM' });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'the run log could not be read, so the receipt cannot be checked');
});

test('Codex R1: a log that was NOT checked (no fingerprint, or a bare number) never lets a receipt count', () => {
  for (const notChecked of [undefined, null, 1234, NaN, 'ok']) {
    const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x', notChecked);
    assert.equal(result.valid, false, String(notChecked));
    assert.equal(result.reason, 'the run log was not checked against the receipt');
  }
});

test('M-1: an otherwise-forged receipt is still refused for its ORIGINAL reason, never masked by the log check', () => {
  const result = validateFinalizeReceipt({ ...REAL_RECEIPT, digest: 'not-hex' }, 'run-x', { ...OK_LOG, bytes: 999 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /digest/);
});
