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

function readMap(mapFile) {
  try {
    const j = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}
function writeMap(mapFile, map) {
  try {
    const tmp = mapFile + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n');
    fs.renameSync(tmp, mapFile);
    return true;
  } catch { return false; }
}

/** resolveLocalAccountLabel(fp, opts) -> { label, isNew, persisted } | null (fp falsy/non-string).
 *  opts.mapFile: the local mapping file path (REQUIRED for persistence across process restarts — the
 *  whole point of account-switch detection; a caller that omits it gets a fresh, unpersisted, per-call
 *  label, which is still safe — just not stable across a restart). Never throws: an unwritable mapping
 *  file still returns a usable label for the current call rather than failing the caller (fail-safe, the
 *  same direction this guard already takes elsewhere — see usage-guard.cjs's own header). */
function resolveLocalAccountLabel(fp, opts) {
  if (!fp || typeof fp !== 'string') return null;
  const o = opts || {};
  const mapFile = o.mapFile;
  if (!mapFile) return { label: 'account-' + crypto.randomBytes(4).toString('hex'), isNew: true, persisted: false };
  const map = readMap(mapFile);
  if (typeof map[fp] === 'string' && map[fp]) return { label: map[fp], isNew: false, persisted: true };
  const label = 'account-' + (Object.keys(map).length + 1) + '-' + crypto.randomBytes(3).toString('hex');
  map[fp] = label;
  const persisted = writeMap(mapFile, map);
  return { label, isNew: true, persisted };
}

module.exports = { validateTokenShape, transportErrorCode, resolveLocalAccountLabel, TOKEN_SHAPE_RE };
