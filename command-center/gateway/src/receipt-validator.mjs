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
 * validateFinalizeReceipt(parsed, expectedRunId, currentEventsBytes) -> { valid: true, receipt } |
 * { valid: false, reason }. `parsed` is whatever JSON.parse() returned for run-finalized.json, or
 * `null` when the file is absent/unreadable/unparseable — callers pass that same `null` straight
 * through here too, so there is exactly ONE place that decides "does this run count as finalized",
 * never two independently drifting checks.
 *
 * WP-RB-CC (review finding M-1): `currentEventsBytes` is optional — the caller's own already-stat()'d
 * LIVE byte size of this run's events.jsonl right now. Before this parameter existed, this validator
 * checked the receipt's SHAPE only, never compared it against the current log, so a run finalized
 * once and then re-opened (more events logged into the SAME run afterwards) still read back as a
 * fully "Finalized" run forever — the exact STALE case `check()` in `.claude/forge-bin/
 * forge-finalize.cjs` (read-only, that project's own real authority) already refuses via an exact
 * digest+bytes match against the current file. Recomputing a full sha256 digest on every dashboard
 * poll is not worth its cost here; a byte-size mismatch alone already proves the file changed (an
 * append changes the length by construction), so it is checked cheaply below instead. Omit this
 * argument (or pass `null`/`NaN`/anything non-finite) when the caller could not determine the current
 * size (no events.jsonl at all, or a read failure) — the check is then honestly skipped, never
 * guessed stale from missing information.
 */
export function validateFinalizeReceipt(parsed, expectedRunId, currentEventsBytes = null) {
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
  // WP-RB-CC (M-1): the receipt's own pinned `bytes` no longer matches the CURRENT live file — the
  // log changed (almost always grew — a follow-up logged more events into this already-finalized
  // run) since this receipt was written. See this function's own header for why only a byte-size
  // comparison is done here, not a full digest recompute.
  if (Number.isFinite(currentEventsBytes) && currentEventsBytes !== parsed.bytes) {
    return { valid: false, reason: 'the log changed after it was finalized' };
  }
  return { valid: true, receipt: parsed };
}
