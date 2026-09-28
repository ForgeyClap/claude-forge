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

// WP-RB-CC (review finding M-1): the third, optional `currentEventsBytes` argument — a receipt whose
// pinned `bytes` no longer matches the CURRENT live events.jsonl size must never validate as finalized.
test('M-1: a receipt is refused once the CURRENT events.jsonl size no longer matches the pinned bytes (the log grew after finalizing)', () => {
  const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x', REAL_RECEIPT.bytes + 40);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'the log changed after it was finalized');
});

test('M-1: a SHRUNK current size (a truncated/replaced log) is refused too, not only a grown one', () => {
  const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x', REAL_RECEIPT.bytes - 40);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'the log changed after it was finalized');
});

test('M-1: the SAME current size as the pinned receipt still validates — nothing changed', () => {
  const result = validateFinalizeReceipt(REAL_RECEIPT, 'run-x', REAL_RECEIPT.bytes);
  assert.equal(result.valid, true);
});

test('M-1: no third argument at all, or a non-finite one, skips the check — an unknown current size is never guessed stale', () => {
  assert.equal(validateFinalizeReceipt(REAL_RECEIPT, 'run-x').valid, true, 'omitted entirely — the pre-existing 2-arg call sites (e.g. unit tests) still work');
  assert.equal(validateFinalizeReceipt(REAL_RECEIPT, 'run-x', null).valid, true);
  assert.equal(validateFinalizeReceipt(REAL_RECEIPT, 'run-x', undefined).valid, true);
  assert.equal(validateFinalizeReceipt(REAL_RECEIPT, 'run-x', NaN).valid, true);
});

test('M-1: an otherwise-forged receipt is still refused for its ORIGINAL reason, never masked by the size check', () => {
  // A digest that fails validation must report the digest problem, not silently be reinterpreted as
  // a size mismatch just because a (mismatched) currentEventsBytes was also passed.
  const result = validateFinalizeReceipt({ ...REAL_RECEIPT, digest: 'not-hex' }, 'run-x', REAL_RECEIPT.bytes + 999);
  assert.equal(result.valid, false);
  assert.match(result.reason, /digest/);
});
