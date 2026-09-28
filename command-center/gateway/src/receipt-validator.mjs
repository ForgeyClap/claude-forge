// Codex run B F-11 (2026-09-28) — ONE shared validator for a run-finalized.json receipt, used by
// both runs.mjs (the run's own `finalized`/`status` field) and proof.mjs (`finalize_receipt`/
// `finalized`). Before this fix, `parsed !== null && typeof parsed === 'object'` was the WHOLE
// check in both files — `{}` and `[]` both satisfy that (`typeof [] === 'object'` in JS), so either
// one, planted in a run's own run-finalized.json, made the run read `finalized:true` with no real
// digest at all.
//
// Checks the fields the real writer (.claude/forge-bin/forge-finalize.cjs, read to learn the exact
// shape) actually requires for a receipt to mean anything: a plain object (never an array), the
// EXACT matching run_id (forge-finalize.cjs's own receiptState() refuses a receipt whose run_id
// does not match), a real 64-hex-char digest, a literal green `contract:'ok'`, and the `bytes`/
// `events` counts the real writer always includes alongside it.
//
// Deliberately DOES NOT re-run forge-finalize.cjs's own LIVE git-commit probe (its `code_commit`
// validation spawns/reads the actual git HEAD of the project root) — that is a process-spawning,
// write-tool-owned concern belonging to forge-finalize.cjs itself, not a lightweight, read-only
// structural check for the dashboard's own "is this trustworthy enough to show as finalized"
// question. A receipt that passes here is STRUCTURALLY sound; forge-finalize.cjs itself remains the
// sole authority on whether it was ever legitimately EARNED.
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * validateFinalizeReceipt(parsed, expectedRunId, currentLog) -> { valid: true, receipt } |
 * { valid: false, reason }. `parsed` is whatever JSON.parse() returned for run-finalized.json, or
 * `null` when the file is absent/unreadable/unparseable — callers pass that same `null` straight
 * through here too, so there is exactly ONE place that decides "does this run count as finalized",
 * never two independently drifting checks.
 *
 * `currentLog` is the CURRENT fingerprint of this run's events.jsonl, from events-digest.mjs:
 * `{state:'ok', bytes, digest}`, `{state:'missing'}` or `{state:'unreadable', reason}`. The receipt
 * pins the log exactly as forge-finalize.cjs wrote it (`digest` = sha256 of the whole file, `bytes` =
 * its length), and it only counts while the live log still has BOTH. WP-RB-CC (review finding M-1)
 * first compared the byte size only; the Codex review of 2026-09-28 (R1) showed that an equal-length
 * edit (check_passed -> check_failed) kept the size, and that a missing log skipped the check — so the
 * digest is compared too, and a log that is missing, unreadable or simply not checked never lets a run
 * read as finalized. Only a receipt that exists is ever checked (the `absent` case returns first).
 */
export function validateFinalizeReceipt(parsed, expectedRunId, currentLog) {
  if (parsed === null) return { valid: false, reason: 'absent' };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, reason: 'receipt_invalid: not a plain object' };
  }
  if (typeof expectedRunId !== 'string' || expectedRunId === '' || parsed.run_id !== expectedRunId) {
    return { valid: false, reason: 'receipt_invalid: run_id does not match this run' };
  }
  if (typeof parsed.digest !== 'string' || !SHA256_HEX_RE.test(parsed.digest)) {
    return { valid: false, reason: 'receipt_invalid: missing or malformed digest' };
  }
  if (parsed.contract !== 'ok') {
    return { valid: false, reason: 'receipt_invalid: contract is not green' };
  }
  // Codex verification (F-11): a real finalize always covers at least one event, so an empty
  // receipt (bytes 0, events 0) is never proof. A fully consistent forgery by someone who can write
  // the whole run folder is out of reach here (the chain is not signed); this rejects malformed,
  // mismatched and empty receipts.
  if (!Number.isFinite(parsed.bytes) || parsed.bytes <= 0) {
    return { valid: false, reason: 'receipt_invalid: missing or empty bytes count' };
  }
  if (!Number.isInteger(parsed.events) || parsed.events <= 0) {
    return { valid: false, reason: 'receipt_invalid: missing or empty events count' };
  }
  if (!currentLog || typeof currentLog !== 'object') {
    return { valid: false, reason: 'the run log was not checked against the receipt' };
  }
  if (currentLog.state === 'missing') {
    return { valid: false, reason: 'the run log is missing, so the receipt cannot be checked' };
  }
  if (currentLog.state !== 'ok' || typeof currentLog.digest !== 'string') {
    return { valid: false, reason: 'the run log could not be read, so the receipt cannot be checked' };
  }
  if (currentLog.bytes !== parsed.bytes || currentLog.digest.toLowerCase() !== parsed.digest.toLowerCase()) {
    return { valid: false, reason: 'the log changed after it was finalized' };
  }
  return { valid: true, receipt: parsed };
}
