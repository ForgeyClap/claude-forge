#!/usr/bin/env node
'use strict';
/**
 * forge-docdrift.test.cjs — hermetic tests for the doc-drift detector (WP-GH-WIRE, 2026-07-26). Every
 * fixture lives under a fresh os.tmpdir() mkdtemp root — this file NEVER touches this project's real
 * .claude/forge-research/docdrift-*, never edits the real docdrift-sources.json, and makes ZERO real network
 * calls: every checkOne()/checkAll() call in this suite passes an injected `opts.fetcher` stub instead of
 * forge-docdrift.cjs's own defaultFetcher (the ONLY function in the module that touches the network — see
 * that function's own doc header). A real, live docdrift check against real sources is a SEPARATE, manual
 * verification step (documented in the build report), never part of this hermetic suite.
 *
 * checkOne()/checkAll() are Promise-returning (they await an injected async fetcher), so this suite runs
 * inside a single async IIFE with an async-aware `at()` assertion helper alongside the synchronous `t()` used
 * by every other forge-bin *.test.cjs file — same pass/fail tally + exit-code convention, just async-safe.
 *
 * Section map:
 *   1) loadSources()            — valid parse + every malformed-config rejection path
 *   2) checkOne()                — OK / NEW-DRIFT / RECURRING / RESOLVED / UNREACHABLE classification
 *   3) checkAll()                — state persistence, ledger append (never truncates), --source filter,
 *                                   unknown --source rejection, malformed pre-existing state degrades safely,
 *                                   a real cross-run OK -> NEW-DRIFT transition
 *   4) logDriftEvents() via checkAll({runId}) — ONLY NEW-DRIFT logs an audit_finding event (copied real
 *      log-event.cjs, real events.jsonl, never fabricated)
 *   5) small pure helpers — tally(), readLedger() tolerance, defaultFetcher() bad-input paths (no network)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const D = require('./forge-docdrift.cjs');

// A throwaway self-signed cert/key (CN=localhost, openssl-generated for THIS test file only — not a
// secret, not used anywhere real) so section 6 can prove the HTTPS->HTTP downgrade guard against a
// real local TLS listener without any new npm dependency or touching the real network.
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCSiAI2zchKmqrn
rdr0aWnMgtWw5TJspqY58l+ZIxu8TTiMnFSkeZm5qhDCMRjHPTZeayQd43Mmv4a+
f29RuWGKJC5VvCDoRQESmSjNJEUxGycB8GMRLE4hYpK1rZL/BR7Rveue5R2Dh2P/
PnG4Ml9DdpeDYr4Y8N45xbQJnWTwWqGXtPNqjhba1mbhkcSWBylK2v5c879jEUde
s7KhcRngnLPiuk3VUj+A9lUlMggE35QSQ5QRublNkkcbkuS2+IqGjKzM0GlLO6GP
gzqPqjD9RIB4YJzdb/+dzgWfYDrTgyTx1MKEKxy7NVfGKiZvc3Yp+C8I0UjtjSqQ
JtWY+PapAgMBAAECggEAAi/JaKv1ezeHqWFszQztqUGikrs432o1PNQjHRPrDApS
97Y1hSbTZnPlQCCfcAm3z/zlUxTb2Q4uopUgQiX0EK2ti1X9X7n35CEo/La32Z3A
HUVLFSyGFfV0nwVyFiArb5HX/E0K/bV9hoeWBtuplEYmyK0mjRS7HD2ZDDOvF+8c
hTIBhI0qeZefdsieWM1Jhd48wFXHFJLO65UlYvyKbrt2nAUl/mrGW8Rkv0q0X1Mj
LYxe9F+adWLESOPJigtE2gkhwmsDkxZzhnN6nts3BDILhFZNe4zBn85yWBrCas0G
1XP/0puTGg/myovFkxCmCm2/R/UzIp1Ku9RXQIDDSQKBgQDJmsM7QW8QVdgq55QT
ip519x/UHRRGJaBRx4qbIY8A4AsA7DIBh+33cQMYvhZgC5lGJLvdpl0wm16ieWBB
xIWbwij4LoDof/I4ggwn+RcG6ifw3JwmAPtBge+G+4KOeTDEoFrvqtoTeuMOpP2t
erKCqfZiFupACt37tiqOsF842wKBgQC6ETlBLSFf167oG3l4IgQZolJMpt4OWb2G
gKHFRcqxAzbHg/ILf/jB5mU6ZBxEf2xjvHAFzJbzPBbvliNXms9cXULHDzAYEGJg
9rDnDGjK8uYwwHX734jaO0L4ebIVseUOhiIP8QhX37tKDzoNanyavlxx7hyrv38w
puxJ1C3zywKBgHszmq9xk1/WNh4yGym+AoxwkwDbLHKZt9mCKdAXt/5+6/qKXRzW
ZrRaWdwa/i1/qRFWjYAslLKJoFGF/y7x2/yNsN/J+3kaB3pE7wzWih3tpq7pAnuv
CdzEfQ5uUSCkKwteO3RPYqmY5X0jkusbGlADcdAL1OeCPJoAfw1n9ykVAoGBAIwL
kKt0u2z22qfKnheEis98dDNLWVE1zEejI59mk1O+Fon+zrxHGsVekwxq8ze/LKa4
2xwSS/9RV/YGbB1w4OglLbDDxrAmDNXsd2O/3FP8lLNW+LaWHdwbxKFef2KC3eOb
o6GaCmyRcdchNNGKN7UE2HHMBXpjjOjiinBbKicXAoGAVCmSMubry6tPGB+On2cs
rqH+nR8U9Fcb1+q+pcedtL4dxjKpcHypwkGWgnJrU+OEybc2CRV9p7CJ5Fv0JcL/
0iUVxlK/00JCjL/nw5KDjOc61oDY+Nywj5CNHTmF1FCBo8s/CR9WPdYkCev82HjB
CVumw2+Ub5rBx5xBGoySchc=
-----END PRIVATE KEY-----`;
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUMUAWnhjWiXZDi/WfEsJW0eW5LXMwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyNjE1MzAyM1oXDTM2MDcy
MzE1MzAyM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAkogCNs3ISpqq563a9GlpzILVsOUybKamOfJfmSMbvE04
jJxUpHmZuaoQwjEYxz02XmskHeNzJr+Gvn9vUblhiiQuVbwg6EUBEpkozSRFMRsn
AfBjESxOIWKSta2S/wUe0b3rnuUdg4dj/z5xuDJfQ3aXg2K+GPDeOcW0CZ1k8Fqh
l7Tzao4W2tZm4ZHElgcpStr+XPO/YxFHXrOyoXEZ4Jyz4rpN1VI/gPZVJTIIBN+U
EkOUEbm5TZJHG5LktviKhoyszNBpSzuhj4M6j6ow/USAeGCc3W//nc4Fn2A604Mk
8dTChCscuzVXxiomb3N2KfgvCNFI7Y0qkCbVmPj2qQIDAQABo1MwUTAdBgNVHQ4E
FgQU32Neu8iX+7Ru72XfnXPHJfx7nF0wHwYDVR0jBBgwFoAU32Neu8iX+7Ru72Xf
nXPHJfx7nF0wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAXDnj
rFt+z7s3dEYYIFqCbWWesHA2ZvjxMAXdR4Wc1nkWo6g93WbaRDYWPURnEexaF2Y/
3fvGR75/IMrUp0hPQdfCjAfpCrx/tDNEQ+2un481hexC2FQsJCKAnrmMZdIltwTc
ccvjalgL+b6G/K0Y8hgezMBIDpc6FQzAaznSVyguGLRNXguBMAq/NWEY/a4eo4eT
4j7NEBhc+S241JlnmUeueHU8FA59UjFLV8DfA+/iYX/gDGWJtr2GhuX3ktN3dd+g
yQJcTeDHbsU6T5PNNUyG7hEzJqsudhTYAgEP9ZPl0CtecbFhhjSG/8EcOJspKS6v
ClV0JnnzLDUU0guZvg==
-----END CERTIFICATE-----`;

/** localLookup() -> a defaultFetcher `connectLookup` that always points the ACTUAL socket at
 *  this test file's own local fixture server (127.0.0.1) regardless of the URL's real hostname —
 *  Node's http/https `lookup` option is invoked with `{all:true}` internally, which expects the
 *  callback in the `dns.lookup(host, {all:true}, cb)` array shape, not the single-address shape. */
function localLookup() {
  return (hostname, options, callback) => {
    if (options && options.all) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return callback(null, '127.0.0.1', 4);
  };
}

let passed = 0, failed = 0;
function t(name, cond, extra) {
  try {
    if (cond) { passed++; console.log('  ok   ' + name); }
    else { failed++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
  } catch (e) { failed++; console.log('  FAIL ' + name + ' — threw: ' + e.message); }
}
async function at(name, promise, extra) {
  try {
    const cond = await promise;
    if (cond) { passed++; console.log('  ok   ' + name); }
    else { failed++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
  } catch (e) { failed++; console.log('  FAIL ' + name + ' — threw: ' + e.message); }
}
async function throwsAsyncCode(fn, code) {
  try { await fn(); return false; }
  catch (e) { return e && e.code === code; }
}
function throwsSyncCode(fn, code) {
  try { fn(); return false; }
  catch (e) { return e && e.code === code; }
}

const REAL_ROOT = path.resolve(__dirname, '..', '..');
function freshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeConfig(root, sources, name) {
  const p = path.join(root, name || 'docdrift-sources.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, sources }), 'utf8');
  return p;
}
function src(id, overrides) {
  return Object.assign({
    id, skill: 'skills/' + id + '.md', rule_id: 'rule-' + id, category: 'test',
    check: 'claim ' + id, check_tokens: ['token-' + id], source_url: 'https://example.test/' + id, added: '2026-07-26',
  }, overrides || {});
}
/** fakeFetcher(map) -> a fetcher stub matching defaultFetcher's contract, NEVER touches the network. `map` is
 *  keyed by url -> {reachable, body} (status/error/finalUrl filled in with sane defaults). A url not present
 *  in `map` resolves reachable:false (simulates an unreachable/unmocked source, never throws). */
function fakeFetcher(map) {
  return async (url) => {
    const m = map[url];
    if (!m) return { reachable: false, status: null, body: '', finalUrl: url, error: 'no mock for url: ' + url };
    return { reachable: m.reachable !== false, status: m.status != null ? m.status : 200, body: m.body || '', finalUrl: url, error: m.error || null };
  };
}

console.log('forge-docdrift.cjs tests (hermetic — every fixture under os.tmpdir(), ZERO real network calls)');

(async () => {

// ===========================================================================
// 1) loadSources() — valid parse + every malformed-config rejection path
// ===========================================================================
console.log('\n1) loadSources()');

t('a valid config with 2 sources parses to an array of 2, fields intact', (() => {
  const root = freshRoot('cfg-valid');
  const p = writeConfig(root, [src('a'), src('b')]);
  const sources = D.loadSources(p);
  return sources.length === 2 && sources[0].id === 'a' && sources[1].rule_id === 'rule-b';
})());

t('a missing config file throws ECONFIG', throwsSyncCode(() => D.loadSources(path.join(freshRoot('cfg-missing'), 'nope.json')), 'ECONFIG'));

t('invalid JSON content throws ECONFIG', (() => {
  const root = freshRoot('cfg-badjson');
  const p = path.join(root, 'bad.json');
  fs.writeFileSync(p, '{ not valid json');
  return throwsSyncCode(() => D.loadSources(p), 'ECONFIG');
})());

t('a config object with no "sources" array throws ECONFIG', (() => {
  const root = freshRoot('cfg-nosources');
  const p = path.join(root, 'nosources.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1 }));
  return throwsSyncCode(() => D.loadSources(p), 'ECONFIG');
})());

t('a config with an EMPTY "sources" array throws ECONFIG', (() => {
  const root = freshRoot('cfg-emptysources');
  const p = writeConfig(root, []);
  return throwsSyncCode(() => D.loadSources(p), 'ECONFIG');
})());

t('a source missing a required field ("rule_id") throws ECONFIG naming the field', (() => {
  const root = freshRoot('cfg-missingfield');
  const bad = src('a'); delete bad.rule_id;
  const p = writeConfig(root, [bad]);
  try { D.loadSources(p); return false; } catch (e) { return e.code === 'ECONFIG' && /rule_id/.test(e.message); }
})());

t('a source with an EMPTY check_tokens array throws ECONFIG', (() => {
  const root = freshRoot('cfg-emptytokens');
  const p = writeConfig(root, [src('a', { check_tokens: [] })]);
  return throwsSyncCode(() => D.loadSources(p), 'ECONFIG');
})());

t('a source with a blank-string entry inside check_tokens throws ECONFIG', (() => {
  const root = freshRoot('cfg-blanktoken');
  const p = writeConfig(root, [src('a', { check_tokens: ['real-token', ''] })]);
  return throwsSyncCode(() => D.loadSources(p), 'ECONFIG');
})());

t('a source with a non-http(s) source_url throws ECONFIG', (() => {
  const root = freshRoot('cfg-badurl');
  const p = writeConfig(root, [src('a', { source_url: 'ftp://example.test/a' })]);
  return throwsSyncCode(() => D.loadSources(p), 'ECONFIG');
})());

t('duplicate source ids throw ECONFIG', (() => {
  const root = freshRoot('cfg-dupe');
  const p = writeConfig(root, [src('a'), src('a')]);
  return throwsSyncCode(() => D.loadSources(p), 'ECONFIG');
})());

// ===========================================================================
// 2) checkOne() — classification
// ===========================================================================
console.log('\n2) checkOne() classification');

await at('OK: token present, no prior state -> status OK, drifted:false', (async () => {
  const s = src('ok1');
  const fetcher = fakeFetcher({ [s.source_url]: { reachable: true, body: 'contains token-ok1 right here' } });
  const r = await D.checkOne(s, {}, { fetcher });
  return r.status === 'OK' && r.drifted === false && Array.isArray(r.missing_tokens) && r.missing_tokens.length === 0;
})());

await at('NEW-DRIFT: token missing, no prior state -> status NEW-DRIFT, drifted:true, names the missing token', (async () => {
  const s = src('nd1');
  const fetcher = fakeFetcher({ [s.source_url]: { reachable: true, body: 'this page no longer mentions it' } });
  const r = await D.checkOne(s, {}, { fetcher });
  return r.status === 'NEW-DRIFT' && r.drifted === true && r.missing_tokens.includes('token-nd1');
})());

await at('RECURRING: token missing again, prior state drifted:true -> status RECURRING', (async () => {
  const s = src('rec1');
  const fetcher = fakeFetcher({ [s.source_url]: { reachable: true, body: 'still missing' } });
  const state = { rec1: { drifted: true, last_status: 'NEW-DRIFT', last_checked: '2026-07-01T00:00:00Z', missing_tokens: ['token-rec1'] } };
  const r = await D.checkOne(s, state, { fetcher });
  return r.status === 'RECURRING' && r.drifted === true;
})());

await at('RESOLVED: token now present, prior state drifted:true -> status RESOLVED, drifted:false', (async () => {
  const s = src('res1');
  const fetcher = fakeFetcher({ [s.source_url]: { reachable: true, body: 'token-res1 is back' } });
  const state = { res1: { drifted: true, last_status: 'NEW-DRIFT', last_checked: '2026-07-01T00:00:00Z', missing_tokens: ['token-res1'] } };
  const r = await D.checkOne(s, state, { fetcher });
  return r.status === 'RESOLVED' && r.drifted === false;
})());

await at('UNREACHABLE (no prior state): status UNREACHABLE, drifted:false (never counts as drift), missing_tokens:null', (async () => {
  const s = src('unr1');
  const fetcher = fakeFetcher({}); // no mock for this url -> reachable:false
  const r = await D.checkOne(s, {}, { fetcher });
  return r.status === 'UNREACHABLE' && r.drifted === false && r.missing_tokens === null && typeof r.error === 'string';
})());

await at('UNREACHABLE with a prior drifted:true state PRESERVES drifted:true (never silently resolves a real drift)', (async () => {
  const s = src('unr2');
  const fetcher = fakeFetcher({}); // unreachable
  const state = { unr2: { drifted: true, last_status: 'NEW-DRIFT', last_checked: '2026-07-01T00:00:00Z', missing_tokens: ['token-unr2'] } };
  const r = await D.checkOne(s, state, { fetcher });
  return r.status === 'UNREACHABLE' && r.drifted === true;
})());

await at('UNREACHABLE with a prior drifted:false state stays drifted:false (never fabricates a drift out of a network failure)', (async () => {
  const s = src('unr3');
  const fetcher = fakeFetcher({});
  const state = { unr3: { drifted: false, last_status: 'OK', last_checked: '2026-07-01T00:00:00Z', missing_tokens: [] } };
  const r = await D.checkOne(s, state, { fetcher });
  return r.status === 'UNREACHABLE' && r.drifted === false;
})());

// ===========================================================================
// 3) checkAll() — persistence, ledger, filters, resilience
// ===========================================================================
console.log('\n3) checkAll()');

await at('checkAll on a 2-source config writes state (2 keys) + ledger (2 lines), results.length === 2', (async () => {
  const root = freshRoot('all-basic');
  const s1 = src('m1'); const s2 = src('m2');
  const configPath = writeConfig(root, [s1, s2]);
  const fetcher = fakeFetcher({ [s1.source_url]: { reachable: true, body: 'token-m1 present' }, [s2.source_url]: { reachable: true, body: 'token-m2 present' } });
  const out = await D.checkAll({ root, configPath, fetcher });
  const statePath = D.defaultStatePath(root);
  const ledgerPath = D.defaultLedgerPath(root);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const ledgerLines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean);
  return out.results.length === 2 && Object.keys(state).length === 2 && ledgerLines.length === 2
    && out.summary.total === 2 && out.summary.by_status.OK === 2;
})());

await at('--source (opts.sourceId) checks ONLY that one source', (async () => {
  const root = freshRoot('all-filter');
  const s1 = src('f1'); const s2 = src('f2');
  const configPath = writeConfig(root, [s1, s2]);
  const fetcher = fakeFetcher({ [s1.source_url]: { reachable: true, body: 'token-f1' }, [s2.source_url]: { reachable: true, body: 'token-f2' } });
  const out = await D.checkAll({ root, configPath, fetcher, sourceId: 'f2' });
  return out.results.length === 1 && out.results[0].id === 'f2';
})());

await at('an unknown --source id rejects with ECONFIG', (async () => {
  const root = freshRoot('all-unknown-src');
  const configPath = writeConfig(root, [src('g1')]);
  const fetcher = fakeFetcher({});
  return throwsAsyncCode(() => D.checkAll({ root, configPath, fetcher, sourceId: 'does-not-exist' }), 'ECONFIG');
})());

await at('a malformed pre-existing state.json degrades to "no prior state" rather than crashing checkAll', (async () => {
  const root = freshRoot('all-badstate');
  const s1 = src('h1');
  const configPath = writeConfig(root, [s1]);
  const statePath = D.defaultStatePath(root);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, '{ this is not valid json');
  const fetcher = fakeFetcher({ [s1.source_url]: { reachable: true, body: 'no token here' } });
  const out = await D.checkAll({ root, configPath, fetcher });
  return out.results.length === 1 && out.results[0].status === 'NEW-DRIFT'; // treated as fresh (no prior "drifted") -> NEW, not RECURRING
})());

await at('a REAL cross-run transition: run 1 (token present) -> OK, run 2 (token now missing, real persisted state) -> NEW-DRIFT', (async () => {
  const root = freshRoot('all-crossrun');
  const s1 = src('x1');
  const configPath = writeConfig(root, [s1]);
  const out1 = await D.checkAll({ root, configPath, fetcher: fakeFetcher({ [s1.source_url]: { reachable: true, body: 'token-x1 is here' } }) });
  const out2 = await D.checkAll({ root, configPath, fetcher: fakeFetcher({ [s1.source_url]: { reachable: true, body: 'token gone' } }) });
  const ledgerLines = fs.readFileSync(D.defaultLedgerPath(root), 'utf8').trim().split('\n').filter(Boolean);
  return out1.results[0].status === 'OK' && out2.results[0].status === 'NEW-DRIFT' && ledgerLines.length === 2; // ledger NEVER truncates across runs
})());

// ===========================================================================
// 4) logDriftEvents() via checkAll({runId}) — ONLY NEW-DRIFT fires an event
// ===========================================================================
console.log('\n4) event logging (real copied log-event.cjs, real events.jsonl)');

function seedRealLogEvent(root) {
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
}

await at('checkAll({runId}) with 1 NEW-DRIFT + 1 OK source logs EXACTLY 1 real audit_finding event (not 2)', (async () => {
  const root = freshRoot('events-mixed');
  seedRealLogEvent(root);
  const sDrift = src('ev-drift'); const sOk = src('ev-ok');
  const configPath = writeConfig(root, [sDrift, sOk]);
  const fetcher = fakeFetcher({
    [sDrift.source_url]: { reachable: true, body: 'no matching token here' },
    [sOk.source_url]: { reachable: true, body: 'token-ev-ok present' },
  });
  const out = await D.checkAll({ root, configPath, fetcher, runId: 'docdrift-test-run-1' });
  const evPath = path.join(root, '.claude', 'forge-runs', 'docdrift-test-run-1', 'events.jsonl');
  const evs = fs.readFileSync(evPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const findings = evs.filter((e) => e.event_type === 'audit_finding');
  return out.event_log.ok === true && out.event_log.count === 1 && findings.length === 1
    && (!findings[0]._forge_verify || findings[0]._forge_verify.event_type_unknown !== true);
})());

await at('a RECURRING result (already drifted from a prior run) with runId logs ZERO new events on the second run', (async () => {
  const root = freshRoot('events-recurring');
  seedRealLogEvent(root);
  const s1 = src('ev-rec');
  const configPath = writeConfig(root, [s1]);
  const missingFetcher = fakeFetcher({ [s1.source_url]: { reachable: true, body: 'still no token' } });
  const out1 = await D.checkAll({ root, configPath, fetcher: missingFetcher, runId: 'docdrift-test-run-2a' }); // NEW-DRIFT -> 1 event
  const out2 = await D.checkAll({ root, configPath, fetcher: missingFetcher, runId: 'docdrift-test-run-2b' }); // RECURRING -> 0 events
  return out1.results[0].status === 'NEW-DRIFT' && out1.event_log.count === 1
    && out2.results[0].status === 'RECURRING' && out2.event_log.count === 0;
})());

// ===========================================================================
// 5) small pure helpers
// ===========================================================================
console.log('\n5) tally() / readLedger() / defaultFetcher() bad-input paths (no network)');

t('tally() counts every status bucket correctly', (() => {
  const results = [{ status: 'OK' }, { status: 'OK' }, { status: 'NEW-DRIFT' }, { status: 'UNREACHABLE' }];
  const s = D.tally(results);
  return s.total === 4 && s.by_status.OK === 2 && s.by_status['NEW-DRIFT'] === 1 && s.by_status.UNREACHABLE === 1;
})());

t('readLedger() skips a blank line and a malformed JSON line, keeps the 1 real entry', (() => {
  const root = freshRoot('ledger-tolerant');
  const p = path.join(root, 'ledger.jsonl');
  fs.writeFileSync(p, JSON.stringify({ id: 'real' }) + '\n\nnot valid json at all\n');
  const entries = D.readLedger(p);
  return entries.length === 1 && entries[0].id === 'real';
})());

t('readLedger() on a missing file returns [] (never throws)', (() => {
  const root = freshRoot('ledger-missing');
  return Array.isArray(D.readLedger(path.join(root, 'nope.jsonl'))) && D.readLedger(path.join(root, 'nope.jsonl')).length === 0;
})());

await at('defaultFetcher() on a syntactically-bad URL resolves {reachable:false} WITHOUT ever attempting a network call', (async () => {
  const r = await D.defaultFetcher('this is not a url', { timeoutMs: 1000 });
  return r.reachable === false && typeof r.error === 'string';
})());

await at('defaultFetcher() on an unsupported protocol resolves {reachable:false} WITHOUT ever attempting a network call', (async () => {
  const r = await D.defaultFetcher('ftp://example.test/file', { timeoutMs: 1000 });
  return r.reachable === false && /protocol/.test(r.error);
})());

// ===========================================================================
// 6) SSRF hardening (Codex F10/F11/F12) — private/loopback block, body-byte cap, absolute
// deadline, HTTPS-only default, HTTPS->HTTP downgrade rejection. Every test here is hermetic: no
// real DNS lookup and no real internet connection ever happens. Tests that need a real socket use
// an injected `resolver` (only ever consulted for the private/loopback CHECK) plus an injected
// `connectLookup` (the address the ACTUAL socket connects to — always this file's own local
// fixture server on 127.0.0.1) so the fixture's real loopback address never has to pass as "public".
// ===========================================================================
console.log('\n6) SSRF hardening (F10 private/loopback block, F11 body-cap + deadline, F12 https-only + downgrade)');

t('isPrivateOrLoopbackIp() blocks every named private/loopback/link-local range (incl. the 169.254.169.254 cloud-metadata address and an IPv4-mapped-IPv6 bypass attempt)', (() => {
  const blocked = [
    '127.0.0.1', '10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.168.255.255', '169.254.1.1', '169.254.169.254', '0.0.0.0',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1',
  ];
  return blocked.every((ip) => D.isPrivateOrLoopbackIp(ip) === true);
})());

t('isPrivateOrLoopbackIp() allows real public addresses through, and respects the /12 + /16 range boundaries', (() => {
  const allowed = ['8.8.8.8', '1.1.1.1', '203.0.113.5', '172.15.255.255', '172.32.0.0', '2001:4860:4860::8888'];
  return allowed.every((ip) => D.isPrivateOrLoopbackIp(ip) === false);
})());

t('isPrivateOrLoopbackIp() fails CLOSED on an empty or unrecognized address', D.isPrivateOrLoopbackIp('') === true && D.isPrivateOrLoopbackIp('not-an-ip') === true);

await at('checkHostAllowed() blocks a hostname whose (injected) resolver returns a private address', (async () => {
  const fakeResolver = async (host) => (host === 'private.docdrift-test.invalid' ? ['10.1.2.3'] : ['203.0.113.9']);
  const r = await D.checkHostAllowed('private.docdrift-test.invalid', fakeResolver);
  return r.ok === false && /private\/loopback\/link-local/.test(r.reason);
})());

await at('checkHostAllowed() allows a hostname whose (injected) resolver returns a public address', (async () => {
  const r = await D.checkHostAllowed('public.docdrift-test.invalid', async () => ['203.0.113.9']);
  return r.ok === true;
})());

await at('defaultFetcher() blocks a private-resolving hostname BEFORE any real connection attempt (resolves in well under its own 5s timeout)', (async () => {
  const fakeResolver = async () => ['10.123.45.67']; // private, non-routable — a real connect attempt here would hang for the full timeout
  const startedAt = Date.now();
  const r = await D.defaultFetcher('https://private-resolving-host.docdrift-test.invalid/x', { resolver: fakeResolver, timeoutMs: 5000, deadlineMs: 5000 });
  const elapsedMs = Date.now() - startedAt;
  return r.reachable === false && /private\/loopback\/link-local/.test(r.error) && elapsedMs < 2000;
})());

await at('defaultFetcher() blocks a plain http:// source by default (HTTPS-only, F12) — never even calls the resolver', (async () => {
  const resolver = async () => { throw new Error('resolver must never be called for a default-blocked http URL'); };
  const r = await D.defaultFetcher('http://plain-http-host.docdrift-test.invalid/x', { resolver, timeoutMs: 1000 });
  return r.reachable === false && /http \(non-TLS\) is blocked by default/.test(r.error);
})());

await at('defaultFetcher() follows a real redirect but BLOCKS the hop once it resolves to a private address (F10, every hop)', (async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { Location: 'http://private-redirect-target.docdrift-test.invalid/next' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const resolver = async (host) => (host === 'private-redirect-target.docdrift-test.invalid' ? ['10.9.8.7'] : ['203.0.113.10']);
    const connectLookup = localLookup();
    const r = await D.defaultFetcher('http://public-initial-host.docdrift-test.invalid:' + port + '/start', {
      resolver, connectLookup, allowHttp: true, timeoutMs: 3000, deadlineMs: 3000,
    });
    return r.reachable === false && /private\/loopback\/link-local/.test(r.error);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})());

await at('defaultFetcher() destroys a response mid-stream once it exceeds the body-byte cap, never buffering past it', (async () => {
  const bigChunk = 'A'.repeat(2048);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    for (let i = 0; i < 4; i++) res.write(bigChunk); // 8192 bytes total, well over the 1024-byte test cap below
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const resolver = async () => ['203.0.113.11'];
    const connectLookup = localLookup();
    const r = await D.defaultFetcher('http://oversize-host.docdrift-test.invalid:' + port + '/big', {
      resolver, connectLookup, allowHttp: true, maxBodyBytes: 1024, timeoutMs: 3000, deadlineMs: 3000,
    });
    return r.reachable === false && /byte cap/.test(r.error) && r.body === '';
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})());

await at('defaultFetcher() refuses an HTTPS->HTTP downgrade redirect even when allowHttp is explicitly on (F12)', (async () => {
  const server = https.createServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (req, res) => {
    res.writeHead(302, { Location: 'http://downgrade-target.docdrift-test.invalid/after' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const resolver = async () => ['203.0.113.12'];
    const connectLookup = localLookup();
    const r = await D.defaultFetcher('https://tls-initial-host.docdrift-test.invalid:' + port + '/start', {
      resolver, connectLookup, insecureTLS: true, allowHttp: true, timeoutMs: 3000, deadlineMs: 3000,
    });
    return r.reachable === false && /downgrade/.test(r.error);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})());

await at('defaultFetcher() enforces its OWN absolute deadline, independent of the per-hop timeout (a slow server is cut off at the deadline, not the timeout)', (async () => {
  const server = http.createServer((req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('too late'); }, 500); // deliberately slower than the 150ms deadline below
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const resolver = async () => ['203.0.113.13'];
    const connectLookup = localLookup();
    const startedAt = Date.now();
    const r = await D.defaultFetcher('http://slow-host.docdrift-test.invalid:' + port + '/slow', {
      resolver, connectLookup, allowHttp: true, timeoutMs: 5000, deadlineMs: 150, // per-hop timeout is generous; the ABSOLUTE deadline must fire first
    });
    const elapsedMs = Date.now() - startedAt;
    return r.reachable === false && /absolute deadline/.test(r.error) && elapsedMs < 2000;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})());

t('DEFAULT_DEADLINE_MS is the documented 20 real seconds, and MAX_BODY_BYTES is 4MB (raised from the first-proposed 512KB — see the constant\'s own comment: a real check against the 2 live doc pages measured ~1MB each, so 512KB broke all 8 real sources)', D.DEFAULT_DEADLINE_MS === 20000 && D.MAX_BODY_BYTES === 4 * 1024 * 1024);

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

})();
