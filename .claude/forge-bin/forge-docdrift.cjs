#!/usr/bin/env node
'use strict';
/**
 * forge-docdrift.cjs — doc-drift detector (WP-GH-WIRE, 2026-07-26). Forge-NATIVE reimplementation of the
 * idea behind the shanraisshan/claude-code-best-practice research finding (PATTERN_ADAPTED, no code copied
 * — see skills/forge-docdrift/SKILL.md "Provenance"). Answers ONE question: "does an external doc page our
 * own skills/docs cite still say what we claim it says?" Zero-dependency (fs/path/child_process/node:https
 * /node:http only).
 *
 * DESIGN (honest heuristic, never a fact-claim):
 *   config/orchestration/docdrift-sources.json seeds real claims {id, skill, rule_id, category, check,
 *   check_tokens[], source_url, added} — each already hand-verified against the live source at seed time
 *   (see that file's own _doc). A check fetches source_url (following redirects, timeout-bounded) and
 *   token-searches the raw response body for every check_tokens entry. This is a HEURISTIC, not a diff
 *   against a known-good snapshot of the whole page: a token search can miss real rewording, and it can
 *   also false-positive if a token merely stops matching for an unrelated reason (a redesign, a paraphrase
 *   that keeps the same meaning in different words). It NEVER asserts "the docs changed" as fact — the
 *   report language is always "possible drift, verify by hand." A network failure/timeout/non-2xx is
 *   UNREACHABLE, which NEVER counts as drift (honesty: unverifiable is not the same as wrong) and never
 *   overwrites the last KNOWN drift state.
 *
 * CLASSIFICATION per claim, compared against .claude/forge-research/docdrift-state.json's persisted
 * "drifted" boolean for that claim id (the last time a REAL, reachable check ran — an UNREACHABLE check
 * never updates it):
 *   OK          — tokens found this check, and the claim was NOT drifted last known check.
 *   NEW-DRIFT   — a token is missing this check, and the claim was NOT drifted last known check.
 *   RECURRING   — a token is missing this check, and the claim WAS ALSO drifted last known check.
 *   RESOLVED    — tokens found this check, but the claim WAS drifted last known check.
 *   UNREACHABLE — the fetch failed/timed out/returned non-2xx; drift state is left exactly as it was.
 *
 * MODULE API:
 *   loadSources(configPath) -> [source, ...]. Throws (err.code='ECONFIG') on any malformed config: missing
 *     file, invalid JSON, missing/empty "sources" array, a source missing a required field, an empty/bad
 *     check_tokens array, a non-http(s) source_url, or a duplicate id.
 *   loadState(statePath) -> {} on a missing OR malformed state file (tolerant reader — a corrupted cache
 *     must never crash a real check; same convention as forge-audit-loop.cjs::readLedger).
 *   saveState(statePath, state) -> writes the state object as pretty JSON (mkdir -p first).
 *   appendLedgerEntry(ledgerPath, entry) -> appends ONE JSON line (mkdir -p first, NEVER truncates).
 *   readLedger(ledgerPath) -> [entry, ...], malformed lines silently skipped.
 *   defaultFetcher(url, opts) -> Promise<{reachable, status, body, finalUrl, error}>. NEVER throws/rejects —
 *     always resolves, even on error (reachable:false + error message). opts.timeoutMs (default 10000),
 *     opts.maxRedirects (default 5). Real node:https/node:http GET — the ONLY place this file touches the
 *     network. Tests MUST inject opts.fetcher instead (hermetic — see forge-docdrift.test.cjs).
 *   checkOne(source, state, opts) -> Promise<result> — one claim's classification (see CLASSIFICATION
 *     above). opts.fetcher overrides defaultFetcher (test seam); opts.now overrides `new Date()` (test
 *     determinism).
 *   checkAll(opts) -> Promise<{checked_at, root, results:[...], summary:{total, by_status}, event_log?}>.
 *     opts.root (project root, default: two dirs up from this file), opts.configPath, opts.statePath,
 *     opts.ledgerPath (all test-hermeticity seams), opts.sourceId (check only that one claim — throws
 *     err.code='ECONFIG' if unknown), opts.fetcher, opts.now, opts.runId (when a valid run_id is given,
 *     also calls logDriftEvents — see below). Persists updated state + appends one ledger line per claim
 *     checked, every real invocation (this is the ONLY write this tool performs against the project, besides
 *     the optional event log).
 *   logDriftEvents(root, runId, results) -> {ok, count, statuses} — logs ONE `audit_finding` event (an
 *     ALREADY-REGISTERED event_type — see log-event.cjs's KNOWN_EVENT_TYPES; no new registration needed) per
 *     NEW-DRIFT result ONLY (never for OK/RESOLVED/RECURRING/UNREACHABLE — a recurring or resolved drift was
 *     already surfaced on a prior run; re-firing every check would spam the ledger for a standing, already-
 *     known condition). Best-effort (never throws) — a logging failure never invalidates the ledger entry
 *     already written by checkAll.
 *   tally(results) -> {total, by_status:{OK:n, 'NEW-DRIFT':n, RECURRING:n, RESOLVED:n, UNREACHABLE:n}}.
 *
 * CLI:
 *   node forge-docdrift.cjs check [--source <id>] [--json] [--run <run_id>] [--root <dir>]
 * Exit codes: 0 = ran (any mix of OK/DRIFT/UNREACHABLE is still success — this tool is advisory, never a
 * build gate) · 1 = a real error while checking · 2 = usage/config error (bad args, malformed config, unknown
 * --source id).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const dns = require('dns');
const { spawnSync } = require('child_process');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'docdrift-sources.json');
function defaultStatePath(root) { return path.join(root, '.claude', 'forge-research', 'docdrift-state.json'); }
function defaultLedgerPath(root) { return path.join(root, '.claude', 'forge-research', 'docdrift-ledger.jsonl'); }

// ---------------------------------------------------------------------------
// SSRF hardening (Codex F10/F11/F12, 2026-07-26) — every real network attempt this file ever
// makes goes through defaultFetcher() below, so all of this lives here, not scattered per-caller.
// ---------------------------------------------------------------------------
// F11 — response-body byte cap; destroyed mid-stream on exceed. Deliberately 4MB, not the 512KB
// first proposed: a REAL live check (run by hand against all 8 seeded sources) measured the two
// actual doc pages this tool fetches at ~1.04MB (docs.anthropic.com, redirected to code.claude.com)
// and ~0.94MB (docs.n8n.io) — a 512KB cap turned every one of those 8 real, previously-OK checks
// into a false UNREACHABLE. 4MB keeps real headroom above today's measured page sizes (~4x) while
// still bounding memory to a small, safe amount per fetch (the PRIOR code had NO cap at all).
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 20000; // F11 — absolute wall-clock cap across the WHOLE redirect chain

/** Numeric (unsigned 32-bit) value of a dotted-quad IPv4 string's 4 captured octets. */
function ipv4ToLong(parts) { return ((+parts[0]) << 24 | (+parts[1]) << 16 | (+parts[2]) << 8 | (+parts[3])) >>> 0; }
function inCidr4(ip, base, bits) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  const b = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (!m || !b) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipv4ToLong(m.slice(1, 5)) & mask) === (ipv4ToLong(b.slice(1, 5)) & mask);
}
// The exact ranges F10 names, plus two cheap, well-known additions: 0.0.0.0/8 ("this network") and
// the IPv4-mapped-IPv6 unwrap below (::ffff:127.0.0.1 is a classic SSRF-filter-bypass trick).
const PRIVATE_V4_RANGES = [
  ['127.0.0.0', 8],   // loopback
  ['10.0.0.0', 8],    // RFC1918
  ['172.16.0.0', 12], // RFC1918
  ['192.168.0.0', 16],// RFC1918
  ['169.254.0.0', 16],// link-local (covers the 169.254.169.254 cloud-metadata address too)
  ['0.0.0.0', 8],     // "this network" / unspecified
];
/** isPrivateOrLoopbackIp(ip) -> bool. Pure, exported for direct unit test (no network, no DNS). Fails
 *  CLOSED: an empty/unrecognized address is treated as blocked, never silently allowed through. */
function isPrivateOrLoopbackIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const addr = ip.trim();
  if (addr.includes(':')) {
    const low = addr.toLowerCase();
    if (low === '::1' || low === '::') return true; // loopback / unspecified
    if (/^f[cd][0-9a-f]{0,2}:/.test(low)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(low)) return true; // fe80::/10 link-local
    if (low.startsWith('::ffff:')) { // IPv4-mapped IPv6 — unwrap and re-check the v4 form
      const v4 = low.slice('::ffff:'.length);
      return /^\d+\.\d+\.\d+\.\d+$/.test(v4) ? isPrivateOrLoopbackIp(v4) : true;
    }
    return false;
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return true; // unrecognized form — fail closed
  return PRIVATE_V4_RANGES.some(([base, bits]) => inCidr4(addr, base, bits));
}
/** defaultResolver(hostname) -> Promise<string[]>. Real DNS lookup (an IP-literal hostname resolves
 *  to itself with no real query — Node's dns.lookup handles that natively). Rejects on lookup failure;
 *  the caller treats that as UNREACHABLE, exactly like any other honest network failure. */
function defaultResolver(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) return reject(err);
      resolve((addresses || []).map((a) => a.address));
    });
  });
}
/** checkHostAllowed(hostname, resolverFn) -> {ok, reason?}. Resolves `hostname` and blocks it if ANY
 *  returned address is private/loopback/link-local (F10). Called for the initial URL AND every redirect
 *  hop — never just the first — so a redirect cannot smuggle a request to an internal address. */
async function checkHostAllowed(hostname, resolverFn) {
  let addresses;
  try { addresses = await resolverFn(hostname); }
  catch (e) { return { ok: false, reason: 'dns lookup failed for ' + hostname + ': ' + (e && e.message ? e.message : String(e)) }; }
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, reason: 'dns lookup for ' + hostname + ' returned no usable address' };
  const blocked = addresses.find((ip) => isPrivateOrLoopbackIp(ip));
  if (blocked) return { ok: false, reason: 'refusing to fetch ' + hostname + ' — resolves to a private/loopback/link-local address (' + blocked + ')' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Config loading — REFUSES malformed config rather than silently checking nothing (same posture as
// forge-autonomy.cjs::loadConfig / forge-actiongate.cjs).
// ---------------------------------------------------------------------------
const REQUIRED_STRING_FIELDS = ['id', 'skill', 'rule_id', 'category', 'check', 'source_url'];
function configError(msg) { const e = new Error('forge-docdrift: ' + msg); e.code = 'ECONFIG'; return e; }
/** loadSources(configPath) -> [source, ...]. See file header for the full validation contract. */
function loadSources(configPath) {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); }
  catch (e) { throw configError('cannot read config at ' + configPath + ': ' + e.message); }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw configError(configPath + ' is not valid JSON: ' + e.message); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw configError(configPath + ' must be a JSON object');
  if (!Array.isArray(data.sources) || data.sources.length === 0) throw configError(configPath + ' is missing a non-empty "sources" array');

  const seen = new Set();
  for (const s of data.sources) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw configError('a source entry must be an object');
    for (const field of REQUIRED_STRING_FIELDS) {
      if (typeof s[field] !== 'string' || !s[field]) {
        throw configError('source "' + (s.id || '?') + '" is missing required string field "' + field + '"');
      }
    }
    if (!Array.isArray(s.check_tokens) || s.check_tokens.length === 0 || s.check_tokens.some((t) => typeof t !== 'string' || !t)) {
      throw configError('source "' + s.id + '" is missing a non-empty "check_tokens" array of non-empty strings');
    }
    if (!/^https?:\/\//i.test(s.source_url)) throw configError('source "' + s.id + '" source_url must be http(s)://...');
    if (seen.has(s.id)) throw configError('duplicate source id "' + s.id + '"');
    seen.add(s.id);
  }
  return data.sources;
}

// ---------------------------------------------------------------------------
// State (persisted drift memory) + ledger (append-only audit trail)
// ---------------------------------------------------------------------------
/** loadState(statePath) -> {} on ANY read/parse problem (missing file, malformed JSON, non-object shape) —
 *  a corrupted cache degrades to "no prior state known" rather than crashing a real check. */
function loadState(statePath) {
  let raw;
  try { raw = fs.readFileSync(statePath, 'utf8'); } catch { return {}; }
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
function appendLedgerEntry(ledgerPath, entry) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');
}
/** readLedger(ledgerPath) -> [entry, ...]. Missing ledger -> []. Malformed lines silently skipped (same
 *  tolerance convention as forge-audit-loop.cjs::readLedger). */
function readLedger(ledgerPath) {
  let raw;
  try { raw = fs.readFileSync(ledgerPath, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v); } catch { /* skipped */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Network fetch (the ONLY place this file touches the network) — real, zero-dep, redirect-following,
// timeout-bounded, NEVER throws/rejects.
// ---------------------------------------------------------------------------
function defaultFetcher(url, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 10000;
  const maxRedirects = opts.maxRedirects != null ? opts.maxRedirects : 5;
  const deadlineMs = opts.deadlineMs || DEFAULT_DEADLINE_MS; // F11 — absolute cap, the WHOLE chain
  const maxBodyBytes = opts.maxBodyBytes || MAX_BODY_BYTES; // F11 — response-body byte cap
  const allowHttp = !!opts.allowHttp; // F12 — HTTPS-only by default; test-only escape hatch
  // TEST-ONLY seams (never set by any real caller in this file): `resolver` replaces the real DNS
  // lookup used for the private-IP check; `connectLookup` replaces the address the ACTUAL socket
  // connects to (so a hermetic test can point a fake public hostname at a real local fixture server
  // without that fixture's real loopback address ever reaching the privacy check); `insecureTLS`
  // disables cert validation so a hermetic test can use a throwaway self-signed certificate.
  const resolverFn = opts.resolver || defaultResolver;
  const connectLookup = opts.connectLookup || null;
  const insecureTLS = !!opts.insecureTLS;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let currentReq = null;
    const deadlineTimer = setTimeout(() => {
      if (currentReq) { try { currentReq.destroy(); } catch { /* best-effort abort only */ } }
      settle({ reachable: false, status: null, body: '', finalUrl: url, error: 'absolute deadline exceeded (' + deadlineMs + 'ms) across the redirect chain' });
    }, deadlineMs);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    function settle(result) {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      resolve(result);
    }

    async function attempt(u, redirectsLeft, prevProtocol) {
      if (settled) return;
      if (Date.now() - startedAt > deadlineMs) {
        return settle({ reachable: false, status: null, body: '', finalUrl: u, error: 'absolute deadline exceeded (' + deadlineMs + 'ms) across the redirect chain' });
      }
      let parsed;
      try { parsed = new URL(u); }
      catch (e) { return settle({ reachable: false, status: null, body: '', finalUrl: u, error: 'bad url: ' + e.message }); }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return settle({ reachable: false, status: null, body: '', finalUrl: u, error: 'unsupported protocol: ' + parsed.protocol });
      }
      if (parsed.protocol === 'http:' && !allowHttp) {
        return settle({ reachable: false, status: null, body: '', finalUrl: u, error: 'http (non-TLS) is blocked by default — source_url must be https://...' });
      }
      // F12 — an https->http hop is always refused, independent of allowHttp: a downgrade mid-chain
      // is a distinct threat (a compromised/careless redirect silently stripping TLS) from "this whole
      // check was configured to allow plain http from the start."
      if (prevProtocol === 'https:' && parsed.protocol === 'http:') {
        return settle({ reachable: false, status: null, body: '', finalUrl: u, error: 'refusing an HTTPS→HTTP downgrade redirect to ' + u });
      }
      const hostCheck = await checkHostAllowed(parsed.hostname, resolverFn); // F10 — every hop, not just the first
      if (settled) return;
      if (!hostCheck.ok) {
        return settle({ reachable: false, status: null, body: '', finalUrl: u, error: hostCheck.reason });
      }

      const lib = parsed.protocol === 'https:' ? https : http;
      const reqOpts = { timeout: timeoutMs, headers: { 'User-Agent': 'forge-docdrift/1.0 (+internal doc-drift check, read-only)' } };
      if (connectLookup) reqOpts.lookup = connectLookup;
      if (insecureTLS) reqOpts.rejectUnauthorized = false;
      let req;
      try {
        req = lib.get(parsed, reqOpts, (res) => {
          if (settled) { res.resume(); return; }
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            let nextUrl;
            try { nextUrl = new URL(res.headers.location, u).toString(); }
            catch { return settle({ reachable: false, status: res.statusCode, body: '', finalUrl: u, error: 'bad redirect location' }); }
            void attempt(nextUrl, redirectsLeft - 1, parsed.protocol);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return settle({ reachable: false, status: res.statusCode, body: '', finalUrl: u, error: 'non-2xx status ' + res.statusCode });
          }
          let body = '';
          let bytes = 0;
          let overflowed = false;
          res.on('data', (d) => {
            if (overflowed) return;
            bytes += d.length;
            if (bytes > maxBodyBytes) {
              overflowed = true;
              res.destroy(); // F11 — stop buffering immediately, never hold the whole oversize body in memory
              return settle({ reachable: false, status: res.statusCode, body: '', finalUrl: u, error: 'response body exceeded the ' + maxBodyBytes + '-byte cap; destroyed mid-stream' });
            }
            body += d;
          });
          res.on('end', () => { if (!overflowed) settle({ reachable: true, status: res.statusCode, body, finalUrl: u, error: null }); });
          res.on('error', (e) => { if (!overflowed) settle({ reachable: false, status: res.statusCode, body: '', finalUrl: u, error: e.message }); });
        });
      } catch (e) {
        return settle({ reachable: false, status: null, body: '', finalUrl: u, error: e.message });
      }
      currentReq = req;
      req.on('timeout', () => { req.destroy(); settle({ reachable: false, status: null, body: '', finalUrl: u, error: 'timeout after ' + timeoutMs + 'ms' }); });
      req.on('error', (e) => settle({ reachable: false, status: null, body: '', finalUrl: u, error: e.message }));
    }
    void attempt(url, maxRedirects, null);
  });
}

// ---------------------------------------------------------------------------
// Classification — one claim at a time (see file header CLASSIFICATION for the exact rule).
// ---------------------------------------------------------------------------
/** checkOne(source, state, opts) -> Promise<result>. `state` is the FULL state map (keyed by source.id); this
 *  function only READS state[source.id] — checkAll() is responsible for writing the update back so a single
 *  source can be checked in isolation without mutating a shared map mid-loop in a surprising way. */
async function checkOne(source, state, opts) {
  opts = opts || {};
  const fetcher = opts.fetcher || defaultFetcher;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const checkedAt = now.toISOString();
  const prev = state[source.id] || null;
  const wasDrifted = prev ? !!prev.drifted : false;

  let fetchResult;
  try { fetchResult = await fetcher(source.source_url, { timeoutMs: opts.timeoutMs, maxRedirects: opts.maxRedirects }); }
  catch (e) { fetchResult = { reachable: false, status: null, body: '', finalUrl: source.source_url, error: e && e.message }; }

  if (!fetchResult || !fetchResult.reachable) {
    return {
      id: source.id, rule_id: source.rule_id, category: source.category, skill: source.skill,
      source_url: source.source_url, checked_at: checkedAt, status: 'UNREACHABLE',
      drifted: wasDrifted, missing_tokens: null,
      error: (fetchResult && fetchResult.error) || 'unreachable',
      note: 'network fetch failed/timed out/non-2xx — UNREACHABLE never counts as drift (unverifiable is not the same as wrong); prior drift state left unchanged',
    };
  }

  const missing = source.check_tokens.filter((tok) => !fetchResult.body.includes(tok));
  const isDrift = missing.length > 0;
  let status;
  if (isDrift && wasDrifted) status = 'RECURRING';
  else if (isDrift && !wasDrifted) status = 'NEW-DRIFT';
  else if (!isDrift && wasDrifted) status = 'RESOLVED';
  else status = 'OK';

  return {
    id: source.id, rule_id: source.rule_id, category: source.category, skill: source.skill,
    source_url: source.source_url, checked_at: checkedAt, status,
    drifted: isDrift, missing_tokens: isDrift ? missing : [],
    note: 'heuristic token search only — possible drift, verify by hand; never asserts the docs definitely changed',
  };
}

function tally(results) {
  const by_status = {};
  for (const r of results) by_status[r.status] = (by_status[r.status] || 0) + 1;
  return { total: results.length, by_status };
}

/** logDriftEvents(root, runId, results) -> {ok, count, statuses}. Fires ONE `audit_finding` event per
 *  NEW-DRIFT result ONLY — see file header for why RECURRING/RESOLVED/OK/UNREACHABLE never log. Best-effort,
 *  never throws. */
function logDriftEvents(root, runId, results) {
  const le = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
  const newDrift = (results || []).filter((r) => r.status === 'NEW-DRIFT');
  const statuses = [];
  for (const r of newDrift) {
    let status = 1;
    try {
      const res = spawnSync(process.execPath, [le, runId, 'audit_finding', JSON.stringify({
        agent: 'build-boss',
        note: 'docdrift NEW-DRIFT (' + r.rule_id + ' / ' + r.id + '): possible drift, verify by hand — missing token(s) ' + (r.missing_tokens || []).join(', ') + ' at ' + r.source_url,
        category: 'DOCDRIFT',
        severity: 'medium',
        evidence: JSON.stringify({ id: r.id, rule_id: r.rule_id, source_url: r.source_url, missing_tokens: r.missing_tokens }),
      })], { encoding: 'utf8' });
      status = res.status;
    } catch { status = 1; }
    statuses.push(status);
  }
  return { ok: statuses.every((s) => s === 0), count: newDrift.length, statuses };
}

/** checkAll(opts) -> Promise<{checked_at, root, results, summary, event_log?}>. See file header MODULE API
 *  for the full opts contract. This is the ONLY function that WRITES against the project (state + ledger,
 *  plus the optional event log) — every real invocation persists its findings, never a dry-run-only read. */
async function checkAll(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || PROJECT_ROOT_DEFAULT);
  const configPath = opts.configPath || DEFAULT_CONFIG_PATH;
  const statePath = opts.statePath || defaultStatePath(root);
  const ledgerPath = opts.ledgerPath || defaultLedgerPath(root);

  const sources = loadSources(configPath); // throws (ECONFIG) on malformed config
  const targets = opts.sourceId ? sources.filter((s) => s.id === opts.sourceId) : sources;
  if (opts.sourceId && targets.length === 0) throw configError('unknown source id "' + opts.sourceId + '"');

  const state = loadState(statePath);
  const results = [];
  for (const source of targets) {
    const prevRecord = state[source.id] || null;
    const r = await checkOne(source, state, opts);
    results.push(r);
    state[source.id] = {
      drifted: r.drifted,
      last_status: r.status,
      last_checked: r.checked_at,
      missing_tokens: r.status === 'UNREACHABLE' ? (prevRecord ? prevRecord.missing_tokens || [] : []) : (r.missing_tokens || []),
    };
    appendLedgerEntry(ledgerPath, r);
  }
  saveState(statePath, state);

  const out = {
    checked_at: (opts.now instanceof Date ? opts.now : new Date()).toISOString(),
    root, results, summary: tally(results),
  };
  if (opts.runId && /^[A-Za-z0-9_-]+$/.test(opts.runId)) {
    out.event_log = logDriftEvents(root, opts.runId, results);
  }
  return out;
}

module.exports = {
  loadSources, loadState, saveState, appendLedgerEntry, readLedger,
  defaultFetcher, checkOne, checkAll, tally, logDriftEvents,
  DEFAULT_CONFIG_PATH, defaultStatePath, defaultLedgerPath, PROJECT_ROOT_DEFAULT,
  // SSRF-hardening seams (F10/F11/F12) — exported for direct hermetic unit testing.
  isPrivateOrLoopbackIp, checkHostAllowed, defaultResolver, MAX_BODY_BYTES, DEFAULT_DEADLINE_MS,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, json: false, source: null, run: null, root: null, usageError: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--source') { opts.source = rest[++i]; if (!opts.source && !opts.usageError) opts.usageError = '--source requires an <id>'; }
    else if (a === '--run') { opts.run = rest[++i]; if (!opts.run && !opts.usageError) opts.usageError = '--run requires a <run_id>'; }
    else if (a === '--root') { opts.root = rest[++i]; if (!opts.root && !opts.usageError) opts.usageError = '--root requires a <dir>'; }
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-docdrift.cjs check [--source <id>] [--json] [--run <run_id>] [--root <dir>]');
}
function formatResults(out) {
  const lines = ['forge-docdrift — checked ' + out.results.length + ' source(s) @ ' + out.checked_at];
  for (const r of out.results) {
    const missing = r.missing_tokens && r.missing_tokens.length ? ' — missing: ' + r.missing_tokens.join(', ') : '';
    const err = r.error ? ' — ' + r.error : '';
    lines.push('  [' + r.status + '] ' + r.id + ' (' + r.rule_id + ') — ' + r.source_url + missing + err);
  }
  lines.push('  summary: ' + JSON.stringify(out.summary.by_status));
  return lines.join('\n');
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.usageError) {
    console.error('forge-docdrift: ' + args.usageError);
    printUsage();
    process.exitCode = 2;
  } else if (args.cmd === 'check') {
    const root = args.root ? path.resolve(args.root) : PROJECT_ROOT_DEFAULT;
    checkAll({ root, sourceId: args.source, runId: args.run })
      .then((out) => {
        if (args.json) console.log(JSON.stringify(out));
        else console.log(formatResults(out));
        process.exitCode = 0;
      })
      .catch((e) => {
        console.error('forge-docdrift: ' + e.message);
        process.exitCode = e && e.code === 'ECONFIG' ? 2 : 1;
      });
  } else {
    printUsage();
    process.exitCode = 2;
  }
}
