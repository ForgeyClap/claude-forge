#!/usr/bin/env node
'use strict';
// forge-scout.test.cjs — real tests for the Scout term-generator + persistent vetting ledger (PIECE P5,
// 2026-07-22). Every fixture-based section writes ONLY under a fresh os.tmpdir() directory (freshDir()) via
// opts.vettingPath / the FORGE_SCOUT_VETTING_PATH env var — this file NEVER writes to this repo's real
// config/orchestration/FORGE_SCOUT_VETTING.json. Hermetic.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const scout = require('./forge-scout.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function freshLedgerPath(prefix) { return path.join(freshDir(prefix), 'FORGE_SCOUT_VETTING.json'); }
const NOWHERE = path.join(os.tmpdir(), 'forge-scout-does-not-exist-' + Date.now(), 'FORGE_SCOUT_VETTING.json');

const CLI = path.join(__dirname, 'forge-scout.cjs');
function runCLI(argv, env) {
  return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: env || process.env });
}

console.log('forge-scout tests (term-generator + vetting ledger — PIECE P5)');

// ---------------------------------------------------------------------------
// 1) terms() — domain-tailored, NOT generic; distinct across domains
// ---------------------------------------------------------------------------
console.log('\n1) terms() is domain-tailored and distinct');

t('slides domain returns the exact tailored examples from the doctrine', () => {
  const r = scout.terms({ domain: 'slides' }, {});
  assert.strictEqual(r.domain, 'slides');
  assert.ok(r.terms.includes('claude powerpoint skill'));
  assert.ok(r.terms.includes('claude slide generator skill'));
  assert.ok(r.terms.includes('I stopped using PowerPoint claude code skill'));
});

t('astro domain returns astro-tailored terms', () => {
  const r = scout.terms({ domain: 'astro' }, {});
  assert.ok(r.terms.includes('claude astro skill'));
  assert.ok(r.terms.includes('bulk website generator claude'));
});

t('slides and astro produce DISTINCT term sets (no accidental generic overlap-only list)', () => {
  const slides = scout.terms({ domain: 'slides' }, {}).terms;
  const astro = scout.terms({ domain: 'astro' }, {}).terms;
  assert.notDeepStrictEqual(slides.slice().sort(), astro.slice().sort());
  // no shared terms at all between two curated, unrelated domains
  const overlap = slides.filter((x) => astro.includes(x));
  assert.strictEqual(overlap.length, 0, 'slides and astro terms should not overlap: ' + JSON.stringify(overlap));
});

t('domain is case-insensitive (SEED_TEMPLATES lookup lowercases)', () => {
  const r = scout.terms({ domain: 'SLIDES' }, {});
  assert.ok(r.terms.includes('claude powerpoint skill'));
});

t('an uncurated domain still gets a domain-TAILORED fallback (bakes the domain word in, never a bare generic phrase)', () => {
  const r = scout.terms({ domain: 'beekeeping' }, {});
  assert.ok(r.terms.some((x) => x.includes('beekeeping')), 'fallback terms must mention the actual domain: ' + JSON.stringify(r.terms));
  assert.ok(!r.terms.includes('claude skill'), 'must never degrade to a bare generic "claude skill" search');
});

t('two different uncurated domains produce distinct fallback term sets', () => {
  const a = scout.terms({ domain: 'beekeeping' }, {}).terms;
  const b = scout.terms({ domain: 'candlemaking' }, {}).terms;
  assert.notDeepStrictEqual(a.slice().sort(), b.slice().sort());
});

t('keywords add extra tailored terms beyond the curated seed', () => {
  const r = scout.terms({ domain: 'website', keywords: ['shopify'] }, {});
  assert.ok(r.terms.some((x) => x.toLowerCase().includes('shopify')));
});

t('duplicate/blank keywords are deduped and ignored, never producing empty/duplicate entries', () => {
  const r = scout.terms({ domain: 'slides', keywords: ['powerpoint', 'powerpoint', '  ', ''] }, {});
  const lowered = r.terms.map((x) => x.toLowerCase());
  const countPowerpointSkill = lowered.filter((x) => x === 'claude powerpoint skill').length;
  assert.strictEqual(countPowerpointSkill, 1, 'seed + duplicate keyword must not double up the same term');
});

t('terms() throws on a missing domain', () => {
  assert.throws(() => scout.terms({}, {}), /domain/);
});

t('terms() throws on an empty-string domain', () => {
  assert.throws(() => scout.terms({ domain: '   ' }, {}), /domain/);
});

t('terms() result is capped at MAX_TERMS even with many keywords', () => {
  const manyKeywords = Array.from({ length: 20 }, (_, i) => 'kw' + i);
  const r = scout.terms({ domain: 'website', keywords: manyKeywords }, {});
  assert.ok(r.terms.length <= scout.MAX_TERMS, 'expected <= ' + scout.MAX_TERMS + ' terms, got ' + r.terms.length);
});

// ---------------------------------------------------------------------------
// 2) vetting ledger — record() / list() / isVetted(), missing ledger degrades honestly
// ---------------------------------------------------------------------------
console.log('\n2) vetting ledger: record/list/isVetted, honest missing-file degrade');

t('missing ledger file: list() returns an honest empty result, no crash', () => {
  const r = scout.list({ vettingPath: NOWHERE });
  assert.deepStrictEqual(r.entries, []);
});

t('missing ledger file: isVetted() returns null (never vetted), no crash', () => {
  const r = scout.isVetted('some-capability', { vettingPath: NOWHERE });
  assert.strictEqual(r, null);
});

t('record() appends an entry and it is retrievable via list()', () => {
  const p = freshLedgerPath('scout-record');
  const entry = scout.record({ capability: 'demo-skill', verdict: 'approve', reason: 'genuinely useful, no overlap', source: 'https://example.test/demo-skill' }, { vettingPath: p });
  assert.strictEqual(entry.capability, 'demo-skill');
  assert.strictEqual(entry.verdict, 'approve');
  assert.strictEqual(typeof entry.ts, 'string');
  const r = scout.list({ vettingPath: p });
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].capability, 'demo-skill');
});

t('a second record() call for a DIFFERENT capability appends, never overwrites the first entry', () => {
  const p = freshLedgerPath('scout-record-append');
  scout.record({ capability: 'skill-a', verdict: 'approve', reason: 'reason a' }, { vettingPath: p });
  scout.record({ capability: 'skill-b', verdict: 'hard-pass', reason: 'reason b' }, { vettingPath: p });
  const r = scout.list({ vettingPath: p });
  assert.strictEqual(r.entries.length, 2);
  assert.deepStrictEqual(r.entries.map((e) => e.capability).sort(), ['skill-a', 'skill-b']);
});

t('isVetted() on an unrecorded capability returns null', () => {
  const p = freshLedgerPath('scout-unvetted');
  scout.record({ capability: 'something-else', verdict: 'approve', reason: 'x' }, { vettingPath: p });
  const r = scout.isVetted('never-recorded', { vettingPath: p });
  assert.strictEqual(r, null);
});

t('isVetted() on an approved capability returns that entry', () => {
  const p = freshLedgerPath('scout-approved');
  scout.record({ capability: 'my-approved-tool', verdict: 'approve', reason: 'clean, maintained, useful' }, { vettingPath: p });
  const r = scout.isVetted('my-approved-tool', { vettingPath: p });
  assert.ok(r);
  assert.strictEqual(r.verdict, 'approve');
});

t('capability lookup in isVetted() is case-insensitive', () => {
  const p = freshLedgerPath('scout-case');
  scout.record({ capability: 'MixedCase-Tool', verdict: 'approve', reason: 'x' }, { vettingPath: p });
  const r = scout.isVetted('mixedcase-tool', { vettingPath: p });
  assert.ok(r);
  assert.strictEqual(r.capability, 'MixedCase-Tool');
});

// ---------------------------------------------------------------------------
// 3) THE CORE PERSISTENCE GUARANTEE — a HARD-PASS persists, is never overridden
//    by a later approve attempt for the same capability. (mutation-verify target)
// ---------------------------------------------------------------------------
console.log('\n3) a HARD-PASS persists — never overridden by a later approve');

t('a HARD-PASS recorded first, then an approve attempted for the SAME capability: isVetted() STILL returns the hard-pass', () => {
  const p = freshLedgerPath('scout-hardpass-first');
  scout.record({ capability: 'junk-plugin', verdict: 'hard-pass', reason: 'unmaintained, security risk' }, { vettingPath: p });
  scout.record({ capability: 'junk-plugin', verdict: 'approve', reason: 'someone tried to re-approve it later' }, { vettingPath: p });
  const r = scout.isVetted('junk-plugin', { vettingPath: p });
  assert.ok(r);
  assert.strictEqual(r.verdict, 'hard-pass', 'a later approve attempt must never override a recorded hard-pass');
  assert.strictEqual(r.reason, 'unmaintained, security risk');
});

t('an approve recorded first, then a HARD-PASS for the SAME capability: isVetted() reports the hard-pass (the stricter verdict always wins)', () => {
  const p = freshLedgerPath('scout-hardpass-second');
  scout.record({ capability: 'flip-flop-tool', verdict: 'approve', reason: 'looked fine at first' }, { vettingPath: p });
  scout.record({ capability: 'flip-flop-tool', verdict: 'hard-pass', reason: 'later found to be a security risk' }, { vettingPath: p });
  const r = scout.isVetted('flip-flop-tool', { vettingPath: p });
  assert.strictEqual(r.verdict, 'hard-pass');
  assert.strictEqual(r.reason, 'later found to be a security risk');
});

t('BOTH entries remain in the ledger after the override attempt (append-only — nothing was deleted/mutated)', () => {
  const p = freshLedgerPath('scout-hardpass-both-kept');
  scout.record({ capability: 'kept-both', verdict: 'hard-pass', reason: 'first verdict' }, { vettingPath: p });
  scout.record({ capability: 'kept-both', verdict: 'approve', reason: 'second attempt' }, { vettingPath: p });
  const r = scout.list({ vettingPath: p });
  const forCap = r.entries.filter((e) => e.capability === 'kept-both');
  assert.strictEqual(forCap.length, 2, 'both the original hard-pass and the later approve attempt must remain on record');
});

t('a hard-pass for capability X does not affect isVetted() for an unrelated capability Y', () => {
  const p = freshLedgerPath('scout-isolation');
  scout.record({ capability: 'bad-tool-x', verdict: 'hard-pass', reason: 'junk' }, { vettingPath: p });
  const r = scout.isVetted('good-tool-y', { vettingPath: p });
  assert.strictEqual(r, null);
});

// ---------------------------------------------------------------------------
// 4) record() input validation — throws, never silently accepts garbage
// ---------------------------------------------------------------------------
console.log('\n4) record() input validation throws on garbage input');

t('record() throws on a missing capability', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ verdict: 'approve', reason: 'x' }, { vettingPath: p }), /capability/);
});

t('record() throws on a blank capability', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ capability: '   ', verdict: 'approve', reason: 'x' }, { vettingPath: p }), /capability/);
});

t('record() throws on a missing verdict', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ capability: 'x', reason: 'x' }, { vettingPath: p }), /verdict/);
});

t('record() throws on an invalid verdict value', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ capability: 'x', verdict: 'maybe', reason: 'x' }, { vettingPath: p }), /verdict/);
});

t('record() throws on a missing reason', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ capability: 'x', verdict: 'approve' }, { vettingPath: p }), /reason/);
});

t('record() throws on a blank reason', () => {
  const p = freshLedgerPath('scout-bad-input');
  assert.throws(() => scout.record({ capability: 'x', verdict: 'approve', reason: '   ' }, { vettingPath: p }), /reason/);
});

t('record() with no source stores source:null (never fabricates a source)', () => {
  const p = freshLedgerPath('scout-no-source');
  const entry = scout.record({ capability: 'no-source-tool', verdict: 'approve', reason: 'x' }, { vettingPath: p });
  assert.strictEqual(entry.source, null);
});

// ---------------------------------------------------------------------------
// 5) malformed ledger throws — fail closed, never a silent "nothing vetted" pass
// ---------------------------------------------------------------------------
console.log('\n5) malformed ledger throws — fail closed');

t('invalid JSON in the ledger file throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, '{ not valid json');
  assert.throws(() => scout.list({ vettingPath: p }));
});

t('a ledger file that is valid JSON but not an object throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, JSON.stringify([1, 2, 3]));
  assert.throws(() => scout.list({ vettingPath: p }));
});

t('a ledger file missing the "entries" array throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, JSON.stringify({ version: 1 }));
  assert.throws(() => scout.list({ vettingPath: p }));
});

t('a ledger entry missing "capability" throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries: [{ verdict: 'approve', reason: 'x' }] }));
  assert.throws(() => scout.list({ vettingPath: p }), /capability/);
});

t('a ledger entry with an invalid "verdict" throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries: [{ capability: 'x', verdict: 'maybe', reason: 'x' }] }));
  assert.throws(() => scout.list({ vettingPath: p }), /verdict/);
});

t('a ledger entry missing "reason" throws', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries: [{ capability: 'x', verdict: 'approve' }] }));
  assert.throws(() => scout.list({ vettingPath: p }), /reason/);
});

t('a malformed ledger is NEVER silently treated as "nothing vetted" — isVetted() also throws, not null', () => {
  const p = freshLedgerPath('scout-malformed');
  fs.writeFileSync(p, '{ broken');
  assert.throws(() => scout.isVetted('anything', { vettingPath: p }));
});

t('record() on a pre-existing malformed ledger throws instead of silently overwriting it clean', () => {
  const p = freshLedgerPath('scout-malformed-record');
  fs.writeFileSync(p, '{ broken');
  assert.throws(() => scout.record({ capability: 'x', verdict: 'approve', reason: 'y' }, { vettingPath: p }));
});

// ---------------------------------------------------------------------------
// 6) CLI — real subprocess, exit codes, --json, FORGE_SCOUT_VETTING_PATH hermeticity
// ---------------------------------------------------------------------------
console.log('\n6) CLI (real spawned subprocess, hermetic via FORGE_SCOUT_VETTING_PATH)');

t('CLI terms --domain slides --json exits 0 and includes the tailored powerpoint term', () => {
  const r = runCLI(['terms', '--domain', 'slides', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.terms.includes('claude powerpoint skill'));
});

t('CLI terms with no --domain exits 2 (usage error)', () => {
  const r = runCLI(['terms']);
  assert.strictEqual(r.status, 2);
});

t('CLI record --json exits 0, writes to the FORGE_SCOUT_VETTING_PATH override, never the real repo ledger', () => {
  const p = freshLedgerPath('scout-cli-record');
  const env = Object.assign({}, process.env, { FORGE_SCOUT_VETTING_PATH: p });
  const r = runCLI(['record', '--capability', 'cli-tool', '--verdict', 'approve', '--reason', 'cli test reason', '--json'], env);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.capability, 'cli-tool');
  assert.ok(fs.existsSync(p), 'CLI record must write to the overridden path');
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(onDisk.entries.length, 1);
});

t('CLI record with a missing required flag exits 2', () => {
  const r = runCLI(['record', '--capability', 'x']);
  assert.strictEqual(r.status, 2);
});

t('CLI list --json exits 0 and reflects a prior CLI record via the same env override', () => {
  const p = freshLedgerPath('scout-cli-list');
  const env = Object.assign({}, process.env, { FORGE_SCOUT_VETTING_PATH: p });
  runCLI(['record', '--capability', 'listed-tool', '--verdict', 'hard-pass', '--reason', 'junk'], env);
  const r = runCLI(['list', '--json'], env);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.entries.some((e) => e.capability === 'listed-tool' && e.verdict === 'hard-pass'));
});

t('CLI honors the hard-pass-persists rule end-to-end (record hard-pass, then approve, then list still shows hard-pass as the last-in verdict for downstream isVetted logic)', () => {
  const p = freshLedgerPath('scout-cli-persist');
  const env = Object.assign({}, process.env, { FORGE_SCOUT_VETTING_PATH: p });
  runCLI(['record', '--capability', 'cli-junk', '--verdict', 'hard-pass', '--reason', 'first verdict'], env);
  runCLI(['record', '--capability', 'cli-junk', '--verdict', 'approve', '--reason', 'later attempt'], env);
  const cliListed = JSON.parse(runCLI(['list', '--json'], env).stdout.trim());
  const forCap = cliListed.entries.filter((e) => e.capability === 'cli-junk');
  assert.strictEqual(forCap.length, 2, 'CLI must append, not overwrite');
  const vetted = scout.isVetted('cli-junk', { vettingPath: p });
  assert.strictEqual(vetted.verdict, 'hard-pass', 'isVetted() against the CLI-written ledger must still surface the persisted hard-pass');
});

t('CLI with an unknown command exits 2', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});

t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

// ---------------------------------------------------------------------------
// 7) real repo integration — the actual project ledger path resolves and is either absent
//    (fresh project, honest) or well-formed (never malformed) — read-only check, no writes here.
// ---------------------------------------------------------------------------
console.log('\n7) real repo integration (read-only)');

t('the real project ledger (if present) is well-formed; if absent, list() degrades honestly with no crash', () => {
  // No opts.vettingPath / env override here on purpose — this is the one deliberate read of the REAL
  // default path, proving the fresh-project "not present yet" case degrades honestly rather than crashing.
  const r = scout.list({});
  assert.ok(Array.isArray(r.entries));
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
