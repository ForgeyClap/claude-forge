// Codex run B F-11 — unit tests for the shared receipt validator, in isolation from runs.mjs/proof.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalizeReceipt } from '../src/receipt-validator.mjs';

const REAL_DIGEST = 'f79e99e0f0492f3e6eb0d4f8af1bb84f14e869a53d71684d9fb0a2e5f03343a8'.slice(0, 64).padEnd(64, 'a');
const REAL_RECEIPT = { schema: 2, run_id: 'run-x', digest: REAL_DIGEST, bytes: 1234, events: 10, contract: 'ok', domain: 'tooling', ruleset_sha256: 'b'.repeat(64), finalized_at: '2026-09-28T00:00:00.000Z' };

test('F-11 hostile: {} is refused (the exact bug — any parseable object used to count as finalized)', () => {
  const result = validateFinalizeReceipt({}, 'run-x');
  assert.equal(result.valid, false);
  assert.match(result.reason, /receipt_invalid/);
});

test('F-11 hostile: [] is refused (typeof [] === "object" in JS — the same trap)', () => {
  const result = validateFinalizeReceipt([], 'run-x');
  assert.equal(result.valid, false);
  assert.match(result.reason, /not a plain object/);
});

test('F-11 hostile: a receipt for a DIFFERENT run_id is refused', () => {
  const result = validateFinalizeReceipt({ ...REAL_RECEIPT, run_id: 'run-other' }, 'run-x');
  assert.equal(result.valid, false);
  assert.match(result.reason, /run_id/);
});

test('F-11 hostile: a malformed digest (wrong length / non-hex) is refused', () => {
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, digest: 'short' }, 'run-x').valid, false);
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, digest: 'z'.repeat(64) }, 'run-x').valid, false);
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, digest: 123 }, 'run-x').valid, false);
});

test('F-11 hostile: a non-green contract is refused', () => {
  const result = validateFinalizeReceipt({ ...REAL_RECEIPT, contract: 'fail' }, 'run-x');
  assert.equal(result.valid, false);
  assert.match(result.reason, /contract/);
});

test('F-11 hostile: missing bytes/events counts are refused', () => {
  const { bytes, ...noBytes } = REAL_RECEIPT;
  assert.equal(validateFinalizeReceipt(noBytes, 'run-x').valid, false);
  const { events, ...noEvents } = REAL_RECEIPT;
  assert.equal(validateFinalizeReceipt(noEvents, 'run-x').valid, false);
});

test('F-11 ordinary case: a real, well-formed receipt still validates', () => {
  const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x');
  assert.equal(result.valid, true);
  assert.equal(result.receipt.digest, REAL_DIGEST);
});

test('F-11 ordinary case: null (absent file) is reported distinctly from an invalid one', () => {
  const result = validateFinalizeReceipt(null, 'run-x');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'absent');
});

test('F-11 hostile: a primitive (string/number/null-ish-but-not-null) is refused, never crashes', () => {
  assert.equal(validateFinalizeReceipt('not an object', 'run-x').valid, false);
  assert.equal(validateFinalizeReceipt(42, 'run-x').valid, false);
  assert.equal(validateFinalizeReceipt(true, 'run-x').valid, false);
});

test('Codex verification F-11: an empty receipt (bytes 0, events 0) is never proof of a finalize', () => {
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, bytes: 0 }, 'run-x').valid, false);
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, events: 0 }, 'run-x').valid, false);
  assert.equal(validateFinalizeReceipt({ ...REAL_RECEIPT, events: 2.5 }, 'run-x').valid, false);
  assert.equal(validateFinalizeReceipt(REAL_RECEIPT, 'run-x').valid, true, 'the real shape still validates');
});
