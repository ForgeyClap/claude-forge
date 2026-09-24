#!/usr/bin/env node
'use strict';
/**
 * forge-settings-merge-guards.cjs — wp-f2 (2026-09-24 Codex re-check, out-p2.md/out-p6.md). Pure/near-pure
 * helper functions extracted out of forge-settings-merge.cjs so that file stays under the project's file-size
 * guidance while still fixing every settings-merge finding: containment/symlink guards (PROJECT-DIRECTORY-
 * ESCAPE), exclusive-create unique recovery files (AUXILIARY-FILE-CLOBBER), a duplicate-key/unsafe-number JSON
 * scanner (LOSSY-ROUNDTRIP), and formatting (BOM/EOL/indent/trailing-newline) detection + rendering so a merge
 * write matches the target's own original style instead of always re-indenting to 2 spaces/LF.
 *
 * Nothing in this file touches forge-gate-hook.cjs/forge-gate-data.cjs/hard-gates.json (wp-f1's territory) or
 * forge-config.cjs/forge-setup.cjs/forge.md (wp-f3's territory) — it is used ONLY by forge-settings-merge.cjs
 * and, indirectly, by forge-sync.cjs's settings-merge call sites.
 */
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// containment / symlink guards (mirrors forge-sync.cjs's own realpathViaExistingAncestor/containmentSafe —
// duplicated here in a small, dependency-free form rather than requiring the 2600-line forge-sync.cjs from
// this small standalone tool, which also has to work when invoked directly by the installers).
// ---------------------------------------------------------------------------

/** realpathViaExistingAncestor — the REAL path of `p` even when `p` (or its tail) does not exist yet: resolve
 *  the longest existing ancestor and re-append the missing tail. Both sides of a containment comparison MUST
 *  go through this same function (see forge-sync.cjs's own copy for the short-path/8.3 rationale). */
function realpathViaExistingAncestor(p) {
  let existing = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real;
  try { real = fs.realpathSync.native(existing); } catch { real = existing; }
  return tail.length ? path.join(real, ...tail) : real;
}

/** isSymlinkPath — true when `p` itself (this exact path, no ancestor walk) is a symlink or a Windows
 *  reparse point (junction — Node reports these via `isSymbolicLink()` too). Mirrors forge-sync.cjs's own
 *  `isSymlinkPath` name/semantics exactly (one lstat, no ancestor climb) — deliberately bounded to the exact
 *  path being checked (the `.claude` directory itself, or a recovery-file's own leaf/containing directory)
 *  rather than climbing to the filesystem root, which would false-positive on an unrelated, legitimately
 *  symlinked ancestor far above the project (e.g. a symlinked home directory) that this tool has no stake in. */
function isSymlinkPath(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** containedWithin(root, p) — true when `p`'s REAL path is `root`'s real path or a real descendant of it.
 *  Both sides resolve through realpathViaExistingAncestor so a not-yet-created leaf/root still compares
 *  correctly. Callers should ALSO run isSymlinkPath on `root` itself — containment alone does not reject a
 *  `root` that is ITSELF a symlink/junction (both sides would resolve into the same outside location and
 *  "contain" each other trivially — the exact PROJECT-DIRECTORY-ESCAPE shape this pairing exists to catch). */
function containedWithin(root, p) {
  const realRoot = realpathViaExistingAncestor(root);
  const realP = realpathViaExistingAncestor(p);
  return realP === realRoot || realP.startsWith(realRoot + path.sep);
}

// ---------------------------------------------------------------------------
// JSON round-trip safety scanner (LOSSY-ROUNDTRIP): only ever called on TEXT THAT ALREADY PARSED
// successfully via JSON.parse (so it never has to handle malformed syntax) — it looks specifically for the
// two byte-level things a parse+reserialize round trip silently corrupts:
//   (1) a duplicate object key compared on its DECODED value, not its raw source text (Codex re-check
//       out-p7.md V08): a key written with a Unicode escape for one of its letters decodes to the exact same
//       string as a plain-spelled duplicate key — a duplicate either way — even though the two key SOURCE
//       literals differ byte-for-byte. Each raw literal is already a lone, self-contained, valid JSON string
//       token (the whole document already parsed), so `JSON.parse(raw)` alone is a safe, correct decoder here
//       — no hand-rolled surrogate-pair/escape-sequence logic needed.
//   (2) a numeric literal whose SOURCE TEXT would not come back unchanged from JSON.stringify(Number(literal))
//       — not merely one whose numeric VALUE changed. Comparing text (not just value) is what catches every
//       form Codex demonstrated: overflow to Infinity (`1e400`/`1e+400` -> stringifies to the literal `null`),
//       underflow to zero (`1e-400` -> `0`), a pure/decimal integer beyond Number.MAX_SAFE_INTEGER
//       (`9007199254740993` or `9007199254740993.0` -> `9007199254740992`), `-0` (stringifies to plain `0`,
//       silently dropping the sign), and redundant-but-value-preserving notation such as `1E2` (stringifies to
//       `100`) or a huge-but-finite exponent that reserializes in a different notation. A ordinary literal a
//       human would actually type by hand (`30`, `1.5`, `0.1`, `9007199254740991`) already round-trips
//       byte-identically, so this does not flag typical settings.json content.
// ---------------------------------------------------------------------------
function scanJsonRisks(text) {
  const duplicateKeys = [];
  const unsafeNumbers = [];
  const stack = []; // { type: 'object', keys: Set<string> } | { type: 'array' }
  const n = text.length;
  let i = 0;

  function isWs(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }
  function skipWs() { while (i < n && isWs(text[i])) i++; }
  function parseStringLiteral() {
    const start = i;
    i++; // opening quote
    while (i < n) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') { i++; break; }
      i++;
    }
    return text.slice(start, i); // includes surrounding quotes
  }
  function parseNumberLiteral() {
    const start = i;
    if (text[i] === '-') i++;
    while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    if (text[i] === '.') { i++; while (i < n && text[i] >= '0' && text[i] <= '9') i++; }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      while (i < n && text[i] >= '0' && text[i] <= '9') i++;
    }
    return text.slice(start, i);
  }

  while (i < n) {
    skipWs();
    if (i >= n) break;
    const c = text[i];
    if (c === '{') { stack.push({ type: 'object', keys: new Set() }); i++; continue; }
    if (c === '[') { stack.push({ type: 'array' }); i++; continue; }
    if (c === '}' || c === ']') { stack.pop(); i++; continue; }
    if (c === ',' || c === ':') { i++; continue; }
    if (c === '"') {
      const raw = parseStringLiteral();
      const savedI = i;
      skipWs();
      const top = stack[stack.length - 1];
      const isKeyPosition = !!(top && top.type === 'object' && text[i] === ':');
      if (isKeyPosition) {
        // decode (not raw.slice(1,-1)) so a Unicode-escaped duplicate (decodes to the same string as a
        // plain-spelled key) is caught too (V08).
        // `raw` is always a lone, already-valid JSON string token here — JSON.parse cannot throw on it.
        const key = JSON.parse(raw);
        if (top.keys.has(key)) duplicateKeys.push(key);
        else top.keys.add(key);
      } else {
        i = savedI; // not a key — do not consume the whitespace we peeked past; harmless either way, kept explicit
      }
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const raw = parseNumberLiteral();
      // V08: compare SOURCE TEXT to what JSON.stringify(Number(raw)) would emit — not just the parsed value —
      // so every reserialize-changing form is caught (overflow-to-null, underflow-to-zero, >2^53 integers in
      // either integer or decimal notation, -0 losing its sign, 1E2-style redundant exponent notation), while
      // an ordinary hand-typed literal (30, 1.5, 0.1, 9007199254740991) round-trips unchanged and is never
      // flagged.
      const reserialized = JSON.stringify(Number(raw));
      if (reserialized !== raw) unsafeNumbers.push(raw);
      continue;
    }
    if (/[a-zA-Z]/.test(c)) { while (i < n && /[a-zA-Z]/.test(text[i])) i++; continue; } // true/false/null
    i++; // defensive: never loop forever on already-validated JSON
  }
  return { duplicateKeys, unsafeNumbers };
}

// ---------------------------------------------------------------------------
// formatting detection/render (BOM, EOL, indent unit, trailing newline) — LOSSY-ROUNDTRIP's "preserve
// encoding/newline/indentation" half. This does NOT preserve comments, key order beyond what the merge itself
// already keeps, or per-node original spacing beyond the single detected indent unit — a full lossless
// syntax-tree editor is out of scope for this fix; see forge-settings-merge.cjs's own header for the honest
// scope note.
// ---------------------------------------------------------------------------
function detectFormatting(rawText) {
  const hadBom = typeof rawText === 'string' && rawText.charCodeAt(0) === 0xfeff;
  const body = hadBom ? rawText.slice(1) : rawText;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = body.endsWith('\n') || body.endsWith('\r\n');
  // shortest non-empty leading-whitespace run across all lines = the one indent "unit" (works for the
  // overwhelming common case of consistently-indented JSON; a file mixing indent styles per level is a
  // known, documented limit, not silently mis-handled — it just yields a plausible-but-imperfect unit).
  const lines = body.split(/\r\n|\n/);
  let indent = '  ';
  let shortest = Infinity;
  for (const line of lines) {
    const m = line.match(/^([ \t]+)\S/);
    if (m && m[1].length < shortest) { shortest = m[1].length; indent = m[1]; }
  }
  return { hadBom, eol, indent, trailingNewline };
}

/** renderWithFormatting(obj, fmt) — JSON.stringify always emits LF + no BOM + no guaranteed trailing newline;
 *  re-shape its output to match a target's ORIGINAL formatting so a merge does not gratuitously rewrite every
 *  line of a file whose owner used tabs, CRLF, or 4-space indent. */
function renderWithFormatting(obj, fmt) {
  let out = JSON.stringify(obj, null, fmt.indent);
  if (fmt.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  if (fmt.trailingNewline) out += fmt.eol;
  if (fmt.hadBom) out = '﻿' + out;
  return out;
}

// ---------------------------------------------------------------------------
// exclusive-create unique recovery files (AUXILIARY-FILE-CLOBBER): backup and settings.forge-recommended.json
// copies must never silently overwrite a previous recovery artifact and must never follow a symlink/junction
// planted at (or above) the destination path.
// ---------------------------------------------------------------------------
function randomSuffix() { return Math.random().toString(36).slice(2, 8); }

/** writeExclusiveUnique(dir, prefix, suffix, contents, opts) — refuses outright (no write attempted at all)
 *  when `dir` itself or any of its ancestors is a symlink/junction. Otherwise tries `<prefix>-<stamp>-<rand><suffix>`
 *  with `wx` (fails if that exact name already exists — including as a dangling symlink, since O_EXCL never
 *  follows a symlink at the final path component either), retrying with a fresh random suffix on collision.
 *  opts.mode: POSIX mode bits to apply via chmod after creation (harmless best-effort no-op on Windows —
 *  Windows ACLs are NOT implemented here, only the read-only attribute bit, a documented limit). */
function writeExclusiveUnique(dir, prefix, suffix, contents, opts) {
  opts = opts || {};
  if (isSymlinkPath(dir)) {
    return { ok: false, reason: 'refusing to write into ' + dir + ' — it is a symlink/junction, not a real directory' };
  }
  const stamp = (opts.timestampStamp || defaultTimestampStamp)(opts.now);
  const maxAttempts = opts.maxAttempts || 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const name = prefix + '-' + stamp + '-' + randomSuffix() + suffix;
    const fullPath = path.join(dir, name);
    let fd = null;
    try {
      fd = fs.openSync(fullPath, 'wx', opts.mode);
      fs.writeSync(fd, contents);
      fs.closeSync(fd); fd = null;
      if (typeof opts.mode === 'number') { try { fs.chmodSync(fullPath, opts.mode); } catch { /* best-effort, esp. on Windows */ } }
      return { ok: true, path: fullPath };
    } catch (e) {
      if (fd != null) { try { fs.closeSync(fd); } catch { /* already closed/broken */ } }
      if (e && e.code === 'EEXIST') continue; // never overwrite an existing recovery artifact — retry with a new name
      return { ok: false, reason: 'could not create ' + fullPath + ': ' + (e && e.message) };
    }
  }
  return { ok: false, reason: 'could not create a unique recovery file in ' + dir + ' after ' + maxAttempts + ' attempts' };
}

function defaultTimestampStamp(d) {
  d = d || new Date();
  const p = (v) => String(v).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// ---------------------------------------------------------------------------
// deep hook-entry shape validation (SCHEMA-ACCEPTANCE): a hooks.<event>[] array must contain only well-shaped
// entries — { matcher?: string, hooks: [ { type: 'command', command: string, timeout?: number }, ... ] } — so
// an entry whose `hooks` is itself an object/string/etc, or whose hook items are not real command hooks, is
// refused rather than silently treated as "valid but empty".
// ---------------------------------------------------------------------------
function isValidHookItem(h) {
  return !!h && typeof h === 'object' && !Array.isArray(h)
    && h.type === 'command' && typeof h.command === 'string' && h.command.length > 0
    && (h.timeout === undefined || typeof h.timeout === 'number');
}
function isValidHookEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if ('matcher' in e && e.matcher !== undefined && typeof e.matcher !== 'string') return false;
  if (!Array.isArray(e.hooks)) return false;
  return e.hooks.every(isValidHookItem);
}
/** deepValidateHooksShape(json) — like forge-settings-merge.cjs's existing validShape but also walks every
 *  hooks.<event>[] entry. Root/permissions checks are intentionally NOT duplicated here (the caller already
 *  has validShape for that) — this only adds the entry-level depth validShape never had. */
function deepValidateHooksShape(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return true; // nothing to check — caller's validShape already rejects this
  if (!('hooks' in json)) return true;
  const hooks = json.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return true; // caller's validShape already rejects this
  for (const event of Object.keys(hooks)) {
    const list = hooks[event];
    if (!Array.isArray(list)) return true; // caller's validShape already rejects this
    for (const entry of list) if (!isValidHookEntry(entry)) return false;
  }
  return true;
}

module.exports = {
  realpathViaExistingAncestor, isSymlinkPath, containedWithin,
  scanJsonRisks,
  detectFormatting, renderWithFormatting,
  writeExclusiveUnique, defaultTimestampStamp,
  isValidHookItem, isValidHookEntry, deepValidateHooksShape,
};
