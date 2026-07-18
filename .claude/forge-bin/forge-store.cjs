#!/usr/bin/env node
'use strict';
/**
 * forge-store.cjs — hardened, append-only flat-file store writer for Forge Mission Control Phase 2
 * (WP1 "Foundations"). Zero-dependency, Windows-safe. Stores live under THIS project's .claude/ only:
 *   tickets   -> .claude/forge-tickets/
 *   artifacts -> .claude/forge-artifacts/
 *   prd       -> .claude/forge-prd/
 *   mindmaps  -> .claude/forge-mindmaps/
 *
 * Pattern per store: one file per entity (<id>.json) + an append-only index.jsonl (one compact row
 * per put: {id, ts, store}). This is a WRITER, not a database — index.jsonl is a log, not an index
 * that gets rewritten; readers replay it or just fs.readdir() the store dir.
 *
 * SECURITY GUARDS (mirror forge-dashboard/log-event.cjs exactly — read that file first):
 *   - store name is allowlisted (STORES) — no free-form store names, no path built from raw input.
 *   - id is restricted to ^[A-Za-z0-9_-]+$ (same shape as log-event.cjs's run_id guard) — rejects
 *     traversal attempts like "../evil" outright (the regex has no room for "/" or ".").
 *   - belt-and-braces path-containment check: the resolved store dir must stay inside CLAUDE_DIR, and
 *     the resolved entity file must stay inside the store dir (same startsWith(base + sep) idea as
 *     log-event.cjs's RUNS_DIR check) — defense in depth even though the id regex already blocks this.
 *
 * SECRET HYGIENE: every string leaf of the stored value is redacted before anything touches disk (same
 * masking idea as forge-bin/nvidia-provider.cjs mask(), applied recursively so JSON structure/keys are
 * left alone and only leaf string VALUES are scanned). A raw secret is never written, never echoed.
 *
 * CLI:
 *   node forge-store.cjs put <store> <id> '<json>'   # validate + redact + write <id>.json + append index row
 *   node forge-store.cjs get <store> <id>             # print the stored entity JSON
 *   node forge-store.cjs list <store>                 # print one id per line
 *   node forge-store.cjs index <store>                # print index.jsonl raw
 *
 * Module API: require(...) ->
 *   { putEntity, getEntity, listStore, readIndex, redactValue, isValidId, isValidStore, STORES,
 *     resolveStoreDir, CLAUDE_DIR }
 *
 * TEST ISOLATION: set FORGE_STORE_ROOT to redirect CLAUDE_DIR to a throwaway temp dir. This is a
 * TEST-ONLY escape hatch (used by forge-store.test.cjs) — never point it at a real project.
 */
const fs = require('fs');
const path = require('path');

// This file lives in .claude/forge-bin/, so CLAUDE_DIR is one level up — same resolution as
// forge-bin/nvidia-provider.cjs and forge-dashboard/log-event.cjs. FORGE_STORE_ROOT overrides it
// for hermetic tests only.
const CLAUDE_DIR = process.env.FORGE_STORE_ROOT
  ? path.resolve(process.env.FORGE_STORE_ROOT)
  : path.resolve(__dirname, '..');

// Allowlisted stores only (mirrors log-event.cjs's KNOWN_EVENT_TYPES strictness) — no store name is
// ever taken from user input and used to build a path directly.
const STORES = {
  tickets: 'forge-tickets',
  artifacts: 'forge-artifacts',
  prd: 'forge-prd',
  mindmaps: 'forge-mindmaps',
};

function isValidStore(store) { return Object.prototype.hasOwnProperty.call(STORES, store); }
// Same id shape as log-event.cjs's run_id guard — deliberately has no room for "/", "\", or "..".
function isValidId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id); }

function resolveStoreDir(store) {
  if (!isValidStore(store)) throw new Error('unknown store "' + store + '" — allowed: ' + Object.keys(STORES).join(', '));
  const dir = path.join(CLAUDE_DIR, STORES[store]);
  const base = path.resolve(CLAUDE_DIR), resolved = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('store escapes .claude/ — refused');
  return dir;
}
function resolveEntityFile(store, id) {
  if (!isValidId(id)) throw new Error('invalid id (allowed: A-Z a-z 0-9 _ -): ' + id);
  const dir = resolveStoreDir(store);
  const file = path.join(dir, id + '.json');
  const base = path.resolve(dir), resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('id escapes store dir — refused');
  return file;
}

// ---- secret redaction (same masking idea as forge-bin/nvidia-provider.cjs mask()) ----
// Applied recursively to string leaves; ALSO redacts a value whose KEY name reads like a credential
// (catches unformatted secrets — plain passwords/tokens — that match no fixed pattern). Hardened
// 2026-07-10 after an independent security review of the /api/artifact endpoint flagged coverage gaps
// (Stripe underscore keys, PEM body, URL connection-string creds, keyless secrets). This is the SERVED
// redaction (tickets/artifacts/prd/mindmaps), so completeness here is defense-in-depth for the dashboard.
const SECRET_PATTERNS = [
  /nvapi-[A-Za-z0-9_-]+/g,                                            // NVIDIA Build/NIM key
  /sk-[A-Za-z0-9_-]{20,}/g,                                           // OpenAI-style secret key (hyphen)
  /sk_(?:live|test)_[A-Za-z0-9]{10,}/g,                              // Stripe secret key (underscore)
  /rk_(?:live|test)_[A-Za-z0-9]{10,}/g,                              // Stripe restricted key
  /gh[oprsu]_[A-Za-z0-9]{20,}/g,                                      // GitHub tokens (ghp_/gho_/ghr_/ghs_/ghu_)
  /xox[baprs]-[A-Za-z0-9-]+/g,                                        // Slack bot/user/app/refresh tokens
  /AKIA[0-9A-Z]{16}/g,                                                // AWS access key id
  /AIza[0-9A-Za-z_-]{35}/g,                                           // Google API key
  /SG\.[A-Za-z0-9_-]{16,256}\.[A-Za-z0-9_-]{16,256}/g,                // SendGrid API key (upper-bounded: ReDoS-safe)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8192}?-----END [A-Z ]*PRIVATE KEY-----/g, // full PEM block — body upper-bounded (ReDoS-safe: unbounded [\s\S]*? scanned to EOF per BEGIN marker; 8KB covers RSA-2048/4096 and RSA-8192 ~6.5KB)
  /eyJ[A-Za-z0-9_-]{10,256}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}/g, // JWT (header.payload.signature) — header tightly upper-bounded (ReDoS-safe vs eyJ-spam; real JWT headers are ~36 chars)
  // URL-embedded credentials in a connection string — mask the password only. 4th fix round (2026-07-15):
  // every quantifier is UPPER-BOUNDED. The old `[a-z][a-z0-9+.\-]*` scheme was unbounded and — because its
  // leading `[a-z]` matches at almost every position in ordinary lowercase text — caused catastrophic O(n^2)
  // backtracking (a 600KB run of a single letter took ~160s to scan, hanging the whole doctor). Real schemes
  // are <=~15 chars, hosts/passwords well under 512, so these bounds change no real match while making the
  // pattern strictly linear on any input, at any file size.
  /([a-z][a-z0-9+.\-]{0,39}:\/\/[^\s:/@]{1,512}):[^\s:/@]{1,512}@/gi,
];
// Replacement for the URL-creds pattern keeps scheme://user and drops the password; all others → marker.
function redactString(s) {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = re.source.includes(':\\/\\/') ? out.replace(re, '$1:***REDACTED***@') : out.replace(re, '***REDACTED***');
  }
  return out;
}
// Key names that mean "this value is a credential" — redact the whole value regardless of its shape.
// Separator/anchor-bounded so innocent keys like "author"/"description" never match.
const SECRET_KEY_RE = /(^|[_.\- ])(passwd|password|pwd|secret|secret[_-]?key|token|access[_-]?token|refresh[_-]?token|session[_-]?token|api[_-]?key|apikey|client[_-]?secret|access[_-]?key|private[_-]?key|credential|credentials|authorization|bearer)($|[_.\- ])/i;
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function redactValue(v, keyHint) {
  if (typeof v === 'string') {
    if (keyHint && SECRET_KEY_RE.test(String(keyHint)) && v.trim()) return '***REDACTED***';
    return redactString(v);
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x));
  if (isPlainObject(v)) { const out = {}; for (const k of Object.keys(v)) out[k] = redactValue(v[k], k); return out; }
  return v; // numbers/booleans/null pass through unchanged
}

function nowIso() { return new Date().toISOString(); }

// ---- store operations ----
function putEntity(store, id, value) {
  const file = resolveEntityFile(store, id);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const redacted = redactValue(value);
  // always land as an object envelope so `_stored` has somewhere to live, even for non-object input
  // (arrays/primitives) — JSON.stringify would silently drop a non-index property tacked onto an array.
  const envelope = isPlainObject(redacted) ? { ...redacted } : { value: redacted };
  envelope._stored = nowIso();
  // ---- WP-sizing lint (ADVISORY ONLY, tickets store only — Forge is security-light, never blocking) ----
  // A ticket touching many files with no stated reason is a signal the work package may be too large
  // to land safely in one pass (small scope = higher success). Warn on stderr and stamp the envelope;
  // never throw, never change the exit code, never touch any other store.
  if (store === 'tickets' && isPlainObject(value) && Array.isArray(value.related_files) &&
      value.related_files.length > 3 && !value.sizing_justification) {
    console.error('forge-store: ticket ' + id + ' touches ' + value.related_files.length +
      ' files (>3) without sizing_justification — consider splitting the work package (small scope = higher success)');
    envelope._sizing_warning = true;
  }
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  fs.appendFileSync(path.join(dir, 'index.jsonl'), JSON.stringify({ id, ts: envelope._stored, store }) + '\n', 'utf8');
  return envelope;
}
function getEntity(store, id) {
  const file = resolveEntityFile(store, id);
  if (!fs.existsSync(file)) throw new Error('not found: ' + store + '/' + id);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function listStore(store) {
  const dir = resolveStoreDir(store);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort();
}
function readIndex(store) {
  const dir = resolveStoreDir(store);
  const file = path.join(dir, 'index.jsonl');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

module.exports = {
  putEntity, getEntity, listStore, readIndex, redactValue, isValidId, isValidStore,
  STORES, resolveStoreDir, CLAUDE_DIR, SECRET_PATTERNS, SECRET_KEY_RE,
};

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const args = process.argv.slice(2);
    const cmd = args[0];
    switch (cmd) {
      case 'put': {
        const [, store, id, json] = args;
        if (!store || !id || json === undefined) { console.error("Usage: put <store> <id> '<json>'"); process.exitCode = 1; return; }
        let value;
        try { value = JSON.parse(json); } catch (e) { console.error('invalid JSON: ' + e.message); process.exitCode = 1; return; }
        putEntity(store, id, value);
        console.log('stored ' + store + '/' + id + '.json');
        return;
      }
      case 'get': {
        const [, store, id] = args;
        if (!store || !id) { console.error('Usage: get <store> <id>'); process.exitCode = 1; return; }
        console.log(JSON.stringify(getEntity(store, id), null, 2));
        return;
      }
      case 'list': {
        const [, store] = args;
        if (!store) { console.error('Usage: list <store>'); process.exitCode = 1; return; }
        listStore(store).forEach((id) => console.log(id));
        return;
      }
      case 'index': {
        const [, store] = args;
        if (!store) { console.error('Usage: index <store>'); process.exitCode = 1; return; }
        process.stdout.write(readIndex(store));
        return;
      }
      default:
        console.error('Usage: node forge-store.cjs <put|get|list|index> <store> [id] [json]');
        console.error('Stores: ' + Object.keys(STORES).join(', '));
        process.exitCode = 1;
    }
  };
  try { main(); } catch (e) { console.error('forge-store: ' + e.message); process.exitCode = 1; }
}
