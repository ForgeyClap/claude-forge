#!/usr/bin/env node
'use strict';
/**
 * usage-guard-redact.cjs — the credential/redaction boundary split out of usage-guard.cjs (2026-09-24,
 * Codex recheck wp-f4: GUARD-TOKEN-ERROR / GUARD-TOKEN-FINGERPRINT). Zero dependency beyond core Node
 * modules; the only I/O this file performs is reading/writing the ONE opaque local account-mapping
 * file it owns (see resolveLocalAccountLabel below) — never the credentials file, never the state file,
 * never the log.
 *
 * WHY THIS EXISTS: usage-guard.cjs is ~1500 lines (this project's own file-size guidance names 500 as
 * the per-file target). The one genuinely separable concern — "how do we ever let a credential-shaped
 * value near a persisted artifact (state file / pause journal / log / stdout)" — is this file's entire
 * job:
 *
 *  - validateTokenShape(token): reject a structurally broken OAuth token BEFORE it is ever used to
 *    build a request header (GUARD-TOKEN-ERROR). A token containing a newline/control character makes
 *    Node's own `Headers` validation throw a TypeError whose message echoes the raw header value
 *    verbatim ("... is an invalid header value") — if that message is ever logged/persisted unchanged,
 *    the credential fragment leaks through the very code path meant to reject it.
 *  - transportErrorCode(e): maps ANY thrown fetch/header/parse error to a FIXED, non-echoing diagnostic
 *    code (e.code when it looks like a real Node error code, else e.name, else "Error"). Never returns
 *    e.message, which is exactly what can carry a leaked credential fragment.
 *  - resolveLocalAccountLabel(fp, opts): the ONE place a credential-derived account fingerprint (a
 *    sha256 of accountUuid+organizationUuid, computed in-memory by usage-guard.cjs's own
 *    fingerprintAccount()) is translated into an OPAQUE, randomly generated LOCAL label before it is
 *    allowed anywhere near a persisted artifact (GUARD-TOKEN-FINGERPRINT). The fp -> label mapping
 *    lives in one small, purpose-built, local-only file that is never synced between projects, never
 *    read by a dashboard and never (sanitized-)published — unlike the state/journal/log files the
 *    header of usage-guard.cjs specifically warns about. Every consumer downstream of the label (state,
 *    journal, log, stdout) only ever sees the label, never the fp that produced it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A plausible bearer/OAuth token: a string, bounded length, drawn only from the RFC 6750 / base64url-ish
// token-safe character set — no whitespace, no control characters, nothing that could ever be mistaken
// for a header-injection payload (\r\n) by Node's own Headers validation.
const TOKEN_SHAPE_RE = /^[A-Za-z0-9._~+/=-]{10,4096}$/;

/** validateTokenShape(token) -> boolean. Pure, never throws. */
function validateTokenShape(token) {
  return typeof token === 'string' && TOKEN_SHAPE_RE.test(token);
}

/** transportErrorCode(e) -> a FIXED, non-echoing diagnostic label for a thrown fetch/header/parse error
 *  (GUARD-TOKEN-ERROR). Only a value from a closed, machine-defined vocabulary ever reaches the
 *  returned string: a real Node error `code` (e.g. ECONNRESET, ENOTFOUND) when it is shaped like one,
 *  else the error's `name` (e.g. TypeError) when that itself is a plain identifier, else the literal
 *  string "Error". `e.message` — the field that can carry request/response bytes, including a rejected
 *  header value quoted verbatim — is never read here. Pure, never throws. */
function transportErrorCode(e) {
  if (e && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(e.code)) return e.code;
  if (e && typeof e.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(e.name)) return e.name;
  return 'Error';
}

/** readMapResult(mapFile) -> { ok:true, map, absent:boolean } | { ok:false, error }. GUARD-ACCOUNT-STABILITY,
 *  second recheck (V14, 2026-09-24): distinguishes "the map does not exist YET" (ENOENT on the read — a
 *  genuinely fresh install, safe to treat as an empty map and mint the first entry) from "the map could
 *  NOT be read for any other reason" (EACCES, EISDIR, a SyntaxError from malformed JSON, or valid JSON
 *  that is not a plain object) — a real failure that must NEVER be treated as "no entry yet", because we
 *  cannot tell whether fp already had a persisted label sitting in the unreadable content. Never throws. */
function readMapResult(mapFile) {
  let raw;
  try {
    raw = fs.readFileSync(mapFile, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, map: {}, absent: true };
    return { ok: false, error: e };
  }
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) return { ok: true, map: j, absent: false };
    return { ok: false, error: new Error('account map is valid JSON but not a plain object') };
  } catch (e) {
    return { ok: false, error: e };
  }
}
function writeMap(mapFile, map) {
  try {
    const tmp = mapFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n');
    fs.renameSync(tmp, mapFile);
    return true;
  } catch { return false; }
}
/** fallbackLabel(fp, mapFile) -> a PURE, DETERMINISTIC local label — same (fp, mapFile) in, same label
 *  out, every single call, no I/O and no randomness (GUARD-ACCOUNT-STABILITY, Codex recheck wp-f4 V14,
 *  2026-09-24). Used ONLY when the map could not be persisted (read failed for any reason other than "no
 *  entry yet", OR the newly-generated label's write/rename failed) — the caller (usage-guard.cjs's tick())
 *  treats ANY label change across calls as an account switch and discards its measurement, so a random
 *  label minted fresh on every failed call turned a *persistence* failure into a never-ending sequence of
 *  false "account switches" that could indefinitely suppress a real pause (an EACCES map read/write with
 *  utilization pinned at 100% reported pauses:0). HMAC-keyed by the map file's own path (a non-secret,
 *  stable local fact — never the raw fp alone) so the fallback can never be produced by anyone who only
 *  knows fp, and stays distinguishable in the mapping file's own format from a genuinely-persisted label. */
function fallbackLabel(fp, mapFile) {
  const key = typeof mapFile === 'string' && mapFile ? mapFile : 'no-map-file';
  const h = crypto.createHmac('sha256', key).update('fp:' + fp).digest('hex').slice(0, 12);
  return 'account-fallback-' + h;
}

/** resolveLocalAccountLabel(fp, opts) -> { label, isNew, persisted } | null (fp falsy/non-string).
 *  opts.mapFile: the local mapping file path (REQUIRED for persistence across process restarts — the
 *  whole point of account-switch detection). Never throws. GUARD-ACCOUNT-STABILITY (V14, first fix
 *  2026-09-24, HARDENED on second Codex recheck 2026-09-24): the RANDOM, incrementing "account-N-hex"
 *  label is only ever returned/attempted when the map was ACTUALLY READABLE this call — self-healing
 *  ("mint + persist a fresh entry") only ever applies to the "map does not exist YET" case (readMapResult's
 *  `absent:true`, a genuinely fresh install), never to "the map exists but could not be read" (EACCES,
 *  EISDIR, malformed JSON). The second recheck's reproduction: a map that is UNREADABLE but whose
 *  write+rename WOULD still succeed (e.g. a write-only file) used to fall into the old code's blanket
 *  `catch { return {} }`, look identical to "absent", mint a BRAND NEW random label, persist it
 *  (overwriting the one entry we could not prove was already there), and repeat — a NEW random identity on
 *  every single call despite "successfully" persisting each time, exactly the mid-check "account switched"
 *  false-positive V14 was meant to close. The fix: on a genuine READ FAILURE (not absence), go straight to
 *  the deterministic fallback and NEVER attempt a write — we cannot tell whether fp already has a real
 *  entry in the unreadable content, so writing a fresh single-entry replacement risks both a false identity
 *  churn AND silently destroying every OTHER account's mapping. Write failure and rename failure (map WAS
 *  readable) keep their existing, already-correct fallback behaviour unchanged. Omitting mapFile entirely
 *  is the same contract with a fixed key, so even that path is stable within a run. */
function resolveLocalAccountLabel(fp, opts) {
  if (!fp || typeof fp !== 'string') return null;
  const o = opts || {};
  const mapFile = o.mapFile;
  if (!mapFile) return { label: fallbackLabel(fp, null), isNew: true, persisted: false };
  const r = readMapResult(mapFile);
  if (!r.ok) {
    // V14 (second recheck): a genuine read failure — never "absent" — must never attempt a write. See the
    // function doc comment above for the full rationale.
    return { label: fallbackLabel(fp, mapFile), isNew: false, persisted: false };
  }
  const map = r.map;
  if (typeof map[fp] === 'string' && map[fp]) return { label: map[fp], isNew: false, persisted: true };
  const label = 'account-' + (Object.keys(map).length + 1) + '-' + crypto.randomBytes(3).toString('hex');
  const persisted = writeMap(mapFile, Object.assign({}, map, { [fp]: label }));
  if (!persisted) return { label: fallbackLabel(fp, mapFile), isNew: true, persisted: false };
  return { label, isNew: true, persisted: true };
}

// A long (>=32 char), whitespace-free run drawn from the SAME token-safe alphabet TOKEN_SHAPE_RE accepts —
// the shape an owner might paste in BY MISTAKE alongside a short, legitimate free-text reason. A real
// bearer/OAuth token is typically 40+ characters (e.g. "sk-ant-oat01-" + 40 random chars); an ordinary
// hyphenated/technical compound word a real reason is likely to contain (e.g. "usage-guard-override-grant",
// 26 chars) stays well under this threshold and is left alone — this is a defensive mask, not a token
// detector with false-negative guarantees.
const REASON_TOKEN_LOOKALIKE_RE = /[A-Za-z0-9._~+/=-]{32,4096}/g;
const REASON_MAX_LEN = 500;

/** sanitizeReason(text) -> a safe string for persistence in a displayed/synced artifact (usage-guard's
 *  state.json `ownerOverride.reason` cache — GUARD-TOKEN-ERROR/N10-N12 Codex recheck, 2026-09-24: "reasons
 *  are stored without redaction"). Three defenses, in order: (1) strip control characters (C0/C1, including
 *  CR/LF) so an owner/agent-supplied reason can never inject a fake log line or corrupt persisted JSON
 *  formatting when later embedded in a log/report; (2) mask any long token-shaped run so a credential
 *  pasted into `--reason` by mistake is never echoed into a synced/dashboard-visible file; (3) cap total
 *  length. Returns null for non-string/empty input (never throws, matches this module's other functions).
 *  Pure. */
function sanitizeReason(text) {
  if (typeof text !== 'string') return null;
  let s = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim();
  if (!s) return null;
  s = s.replace(REASON_TOKEN_LOOKALIKE_RE, '[redacted-token-like-value]');
  if (s.length > REASON_MAX_LEN) s = s.slice(0, REASON_MAX_LEN) + '…';
  return s;
}

module.exports = { validateTokenShape, transportErrorCode, resolveLocalAccountLabel, sanitizeReason, TOKEN_SHAPE_RE };
