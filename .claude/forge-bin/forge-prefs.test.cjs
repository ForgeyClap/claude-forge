#!/usr/bin/env node
'use strict';
// forge-prefs.test.cjs — real tests for the owner-profile resolver (WAVE B / PIECE B1, 2026-07-18).
// Every fixture-based section lives under a fresh os.tmpdir() directory (freshDir()) — this file NEVER
// writes to this repo's real .claude/ and NEVER writes to a real ~/.claude. The module itself has no
// write function at all (resolve/get/list/listCandidates are all read-only), so hermeticity here is
// about fixture ISOLATION (never depending on / polluting real state), not about guarding against writes
// that can't happen. Sections that DO read this repo's real seeded .claude/FORGE_OWNER_PROFILE.json /
// FORGE_PREF_CANDIDATES.json are read-only integration checks (mirrors forge-actiongate.test.cjs's use
// of the real hard-gates.json) and always pass opts.globalProfilePath at a guaranteed-nonexistent temp
// path so they can never be affected by whatever the real ~/.claude/FORGE_OWNER_PROFILE.json happens to
// contain on the machine running this suite (confirmed absent on this dev machine right now, but a test
// must not silently depend on that staying true forever).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const prefs = require('./forge-prefs.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeProfile(dir, name, prefsObj, extra) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(Object.assign({ version: 1, prefs: prefsObj }, extra || {})));
  return p;
}
function entry(value, source, confidence, scope) {
  return { value, source: source || 'test source quote', confidence: confidence || 'evidenced', scope: scope || 'global' };
}
const NOWHERE = path.join(os.tmpdir(), 'forge-prefs-does-not-exist-' + Date.now(), 'FORGE_OWNER_PROFILE.json');
const NOWHERE_CAND = path.join(os.tmpdir(), 'forge-prefs-does-not-exist-' + Date.now(), 'FORGE_PREF_CANDIDATES.json');

const CLI = path.join(__dirname, 'forge-prefs.cjs');
function runCLI(argv, env) {
  return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: env || process.env });
}

console.log('forge-prefs tests (owner-profile resolver — WAVE B / PIECE B1)');

// ---------------------------------------------------------------------------
// 1) layer resolution order — project < global < env (higher precedence wins)
// ---------------------------------------------------------------------------
console.log('\n1) layer resolution order');

t('project-only: a key only in the project layer resolves from project', () => {
  const dir = freshDir('prefs-order');
  const projectPath = writeProfile(dir, 'project.json', { only_project: entry('p') });
  const r = prefs.resolve({ profilePath: projectPath, globalProfilePath: NOWHERE });
  assert.strictEqual(r.prefs.only_project.value, 'p');
  assert.strictEqual(r.layerOf.only_project, 'project');
});

t('global beats project for the same key', () => {
  const dir = freshDir('prefs-order');
  const projectPath = writeProfile(dir, 'project.json', { shared: entry('from-project') });
  const globalPath = writeProfile(dir, 'global.json', { shared: entry('from-global') });
  const r = prefs.resolve({ profilePath: projectPath, globalProfilePath: globalPath });
  assert.strictEqual(r.prefs.shared.value, 'from-global');
  assert.strictEqual(r.layerOf.shared, 'global');
});

t('env beats global AND project for the same key', () => {
  const dir = freshDir('prefs-order');
  const projectPath = writeProfile(dir, 'project.json', { shared: entry('from-project') });
  const globalPath = writeProfile(dir, 'global.json', { shared: entry('from-global') });
  const envPath = writeProfile(dir, 'env.json', { shared: entry('from-env') });
  const prevEnv = process.env.FORGE_OWNER_PROFILE;
  process.env.FORGE_OWNER_PROFILE = envPath;
  try {
    const r = prefs.resolve({ profilePath: projectPath, globalProfilePath: globalPath });
    assert.strictEqual(r.prefs.shared.value, 'from-env');
    assert.strictEqual(r.layerOf.shared, 'env');
  } finally {
    if (prevEnv === undefined) delete process.env.FORGE_OWNER_PROFILE; else process.env.FORGE_OWNER_PROFILE = prevEnv;
  }
});

t('keys absent from a higher layer still fall through to a lower layer (a merge, not a full override)', () => {
  const dir = freshDir('prefs-order');
  const projectPath = writeProfile(dir, 'project.json', { only_project: entry('p'), shared: entry('from-project') });
  const globalPath = writeProfile(dir, 'global.json', { only_global: entry('g'), shared: entry('from-global') });
  const r = prefs.resolve({ profilePath: projectPath, globalProfilePath: globalPath });
  assert.strictEqual(r.prefs.only_project.value, 'p');
  assert.strictEqual(r.prefs.only_global.value, 'g');
  assert.strictEqual(r.prefs.shared.value, 'from-global');
});

// ---------------------------------------------------------------------------
// 2) missing layers degrade honestly — never crash, never fabricate
// ---------------------------------------------------------------------------
console.log('\n2) missing layers degrade gracefully (never crash)');

t('missing global file: resolve() still succeeds, note explains it, project data intact', () => {
  const dir = freshDir('prefs-missing');
  const projectPath = writeProfile(dir, 'project.json', { k: entry('v') });
  const r = prefs.resolve({ profilePath: projectPath, globalProfilePath: NOWHERE });
  assert.strictEqual(r.prefs.k.value, 'v');
  assert.strictEqual(r.layers.global.present, false);
  assert.ok(r.notes.some((n) => n.includes('global layer') && n.includes('not found')));
});

t('missing project file: resolve() still succeeds via global layer, honest note present', () => {
  const dir = freshDir('prefs-missing');
  const globalPath = writeProfile(dir, 'global.json', { k: entry('v') });
  const r = prefs.resolve({ profilePath: NOWHERE, globalProfilePath: globalPath });
  assert.strictEqual(r.prefs.k.value, 'v');
  assert.strictEqual(r.layers.project.present, false);
});

t('env var unset: env layer degrades gracefully, no crash', () => {
  const dir = freshDir('prefs-missing');
  const projectPath = writeProfile(dir, 'project.json', { k: entry('v') });
  const prevEnv = process.env.FORGE_OWNER_PROFILE;
  delete process.env.FORGE_OWNER_PROFILE;
  try {
    const r = prefs.resolve({ profilePath: projectPath, globalProfilePath: NOWHERE });
    assert.strictEqual(r.layers.env.present, false);
    assert.strictEqual(r.prefs.k.value, 'v');
  } finally {
    if (prevEnv !== undefined) process.env.FORGE_OWNER_PROFILE = prevEnv;
  }
});

t('all three layers missing: honest EMPTY result, not a crash, note explains it', () => {
  const r = prefs.resolve({ profilePath: NOWHERE, globalProfilePath: NOWHERE });
  assert.deepStrictEqual(r.prefs, {});
  assert.ok(r.notes.some((n) => n.includes('no prefs resolved')));
});

// ---------------------------------------------------------------------------
// 3) get() / list()
// ---------------------------------------------------------------------------
console.log('\n3) get() and list()');

t('get() on a present key returns found:true with entry + layer', () => {
  const dir = freshDir('prefs-get');
  const projectPath = writeProfile(dir, 'project.json', { k: entry('v', 'src', 'evidenced', 'global') });
  const r = prefs.get('k', { profilePath: projectPath, globalProfilePath: NOWHERE });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.entry.value, 'v');
  assert.strictEqual(r.layer, 'project');
});

t('get() on a missing key returns found:false, no throw', () => {
  const dir = freshDir('prefs-get');
  const projectPath = writeProfile(dir, 'project.json', { k: entry('v') });
  const r = prefs.get('does_not_exist', { profilePath: projectPath, globalProfilePath: NOWHERE });
  assert.strictEqual(r.found, false);
});

t('list() returns every resolved key, sorted, with layer/confidence/scope surfaced', () => {
  const dir = freshDir('prefs-list');
  const projectPath = writeProfile(dir, 'project.json', { zebra: entry(1, 's', 'evidenced', 'global'), apple: entry(2, 's', 'inferred', 'domain:website') });
  const r = prefs.list({ profilePath: projectPath, globalProfilePath: NOWHERE });
  assert.strictEqual(r.prefs.length, 2);
  assert.strictEqual(r.prefs[0].key, 'apple'); // sorted
  assert.strictEqual(r.prefs[1].key, 'zebra');
  assert.strictEqual(r.prefs[0].confidence, 'inferred');
  assert.strictEqual(r.prefs[0].scope, 'domain:website');
});

// ---------------------------------------------------------------------------
// 4) malformed profile refuses (throws), never silently passes
// ---------------------------------------------------------------------------
console.log('\n4) malformed profile data throws — fail closed, not a silent pass');

t('invalid JSON in the project layer throws', () => {
  const dir = freshDir('prefs-bad');
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.throws(() => prefs.resolve({ profilePath: p, globalProfilePath: NOWHERE }));
});

t('a profile file that is valid JSON but not an object throws', () => {
  const dir = freshDir('prefs-bad');
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, JSON.stringify([1, 2, 3]));
  assert.throws(() => prefs.resolve({ profilePath: p, globalProfilePath: NOWHERE }));
});

t('a profile file missing the "prefs" object throws', () => {
  const dir = freshDir('prefs-bad');
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1 }));
  assert.throws(() => prefs.resolve({ profilePath: p, globalProfilePath: NOWHERE }));
});

t('a pref entry missing "source" throws', () => {
  const dir = freshDir('prefs-bad');
  const p = writeProfile(dir, 'bad.json', { k: { value: true, confidence: 'evidenced', scope: 'global' } });
  assert.throws(() => prefs.resolve({ profilePath: p, globalProfilePath: NOWHERE }), /source/);
});

t('a pref entry with an invalid "confidence" throws', () => {
  const dir = freshDir('prefs-bad');
  const p = writeProfile(dir, 'bad.json', { k: entry('v', 's', 'super-duper-sure', 'global') });
  assert.throws(() => prefs.resolve({ profilePath: p, globalProfilePath: NOWHERE }), /confidence/);
});

t('a pref entry with an invalid "scope" throws', () => {
  const dir = freshDir('prefs-bad');
  const p = writeProfile(dir, 'bad.json', { k: entry('v', 's', 'evidenced', 'not-a-real-scope') });
  assert.throws(() => prefs.resolve({ profilePath: p, globalProfilePath: NOWHERE }), /scope/);
});

t('a pref entry missing "value" entirely throws', () => {
  const dir = freshDir('prefs-bad');
  const p = writeProfile(dir, 'bad.json', { k: { source: 's', confidence: 'evidenced', scope: 'global' } });
  assert.throws(() => prefs.resolve({ profilePath: p, globalProfilePath: NOWHERE }));
});

t('malformed GLOBAL layer throws too (not just project) — same fail-closed rule applies per layer', () => {
  const dir = freshDir('prefs-bad');
  const projectPath = writeProfile(dir, 'project.json', { k: entry('v') });
  const badGlobal = path.join(dir, 'bad-global.json');
  fs.writeFileSync(badGlobal, '{ broken');
  assert.throws(() => prefs.resolve({ profilePath: projectPath, globalProfilePath: badGlobal }));
});

t('malformed ENV layer throws too', () => {
  const dir = freshDir('prefs-bad');
  const projectPath = writeProfile(dir, 'project.json', { k: entry('v') });
  const badEnv = path.join(dir, 'bad-env.json');
  fs.writeFileSync(badEnv, '{ broken');
  const prevEnv = process.env.FORGE_OWNER_PROFILE;
  process.env.FORGE_OWNER_PROFILE = badEnv;
  try {
    assert.throws(() => prefs.resolve({ profilePath: projectPath, globalProfilePath: NOWHERE }));
  } finally {
    if (prevEnv === undefined) delete process.env.FORGE_OWNER_PROFILE; else process.env.FORGE_OWNER_PROFILE = prevEnv;
  }
});

// ---------------------------------------------------------------------------
// 5) candidates — STAGE-ONLY, never merged/auto-active
// ---------------------------------------------------------------------------
console.log('\n5) candidates are STAGE-ONLY, never active');

t('missing candidates file degrades gracefully: present:false, empty list, note', () => {
  const r = prefs.listCandidates({ candidatesPath: NOWHERE_CAND });
  assert.strictEqual(r.present, false);
  assert.deepStrictEqual(r.candidates, []);
  assert.ok(r.note.includes('STAGE-ONLY'));
});

t('malformed candidates file (no "candidates" array) throws', () => {
  const dir = freshDir('prefs-cand-bad');
  const p = path.join(dir, 'cand.json');
  fs.writeFileSync(p, JSON.stringify({ notCandidates: [] }));
  assert.throws(() => prefs.listCandidates({ candidatesPath: p }));
});

t('malformed candidates file (invalid JSON) throws', () => {
  const dir = freshDir('prefs-cand-bad');
  const p = path.join(dir, 'cand.json');
  fs.writeFileSync(p, '{ broken');
  assert.throws(() => prefs.listCandidates({ candidatesPath: p }));
});

t('a staged candidate is returned by listCandidates() verbatim but NEVER appears in resolve()/get() output, even when its key collides with a real active pref', () => {
  const dir = freshDir('prefs-cand-isolation');
  const projectPath = writeProfile(dir, 'project.json', { shared_key: entry('ACTIVE-VALUE') });
  const candPath = path.join(dir, 'cand.json');
  fs.writeFileSync(candPath, JSON.stringify({ candidates: [{ key: 'shared_key', value: 'CANDIDATE-VALUE', status: 'proposed' }] }));

  const resolved = prefs.resolve({ profilePath: projectPath, globalProfilePath: NOWHERE });
  assert.strictEqual(resolved.prefs.shared_key.value, 'ACTIVE-VALUE', 'resolve() must never be influenced by the candidates file');

  const got = prefs.get('shared_key', { profilePath: projectPath, globalProfilePath: NOWHERE });
  assert.strictEqual(got.entry.value, 'ACTIVE-VALUE');

  const cands = prefs.listCandidates({ candidatesPath: candPath });
  assert.strictEqual(cands.candidates.length, 1);
  assert.strictEqual(cands.candidates[0].value, 'CANDIDATE-VALUE');
  assert.ok(cands.note.includes('never auto-active'));
});

t('a candidate with status:"active" written into the candidates file is STILL never promoted (module has no promote path at all)', () => {
  const dir = freshDir('prefs-cand-isolation');
  const candPath = path.join(dir, 'cand.json');
  fs.writeFileSync(candPath, JSON.stringify({ candidates: [{ key: 'sneaky', value: 'x', status: 'active' }] }));
  const r = prefs.resolve({ profilePath: NOWHERE, globalProfilePath: NOWHERE });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.prefs, 'sneaky'), false, 'resolve() never even reads the candidates path, regardless of a candidate\'s own status field');
});

// ---------------------------------------------------------------------------
// 6) real repo integration — the ACTUAL seeded .claude/FORGE_OWNER_PROFILE.json + candidates file
//    (read-only; globalProfilePath always pinned to a guaranteed-nonexistent path so this section never
//    depends on whatever the real ~/.claude/FORGE_OWNER_PROFILE.json happens to contain)
// ---------------------------------------------------------------------------
console.log('\n6) real seeded project profile — every promised pref present with real evidence');

const EXPECTED_KEYS = [
  'never_auto_push', 'language', 'deep_research_first', 'real_file_testing_for_correctness_critical',
  'codex_on_high_risk', 'ui_quality_default', 'autonomy_default', 'outreach_draft_only', 'honesty_core',
];

t('resolve() against the REAL project seed finds all 9 promised keys, each evidenced with a real source', () => {
  const r = prefs.resolve({ globalProfilePath: NOWHERE }); // real DEFAULT_PROJECT_PROFILE_PATH, isolated global
  for (const key of EXPECTED_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.prefs, key), 'missing expected seeded pref: ' + key);
    const e = r.prefs[key];
    assert.strictEqual(typeof e.source, 'string');
    assert.ok(e.source.trim().length > 0, key + ' has an empty source');
    assert.strictEqual(e.confidence, 'evidenced', key + ' should be evidenced, not inferred (no inferred prefs were seeded)');
    assert.ok(e.scope === 'global' || /^domain:/.test(e.scope), key + ' has an unexpected scope shape');
  }
});

t('real seed: never_auto_push is true (never fabricated as false)', () => {
  const r = prefs.get('never_auto_push', { globalProfilePath: NOWHERE });
  assert.strictEqual(r.entry.value, true);
});

t('real seed: honesty_core.cannot_override_core is true — the untouchable invariant', () => {
  const r = prefs.get('honesty_core', { globalProfilePath: NOWHERE });
  assert.strictEqual(r.entry.value.cannot_override_core, true);
});

t('real seed: autonomy_default is the literal string "continue-within-mission"', () => {
  const r = prefs.get('autonomy_default', { globalProfilePath: NOWHERE });
  assert.strictEqual(r.entry.value, 'continue-within-mission');
});

t('real seed: no pref beyond the 9 promised ones was silently invented', () => {
  const r = prefs.resolve({ globalProfilePath: NOWHERE });
  assert.deepStrictEqual(Object.keys(r.prefs).sort(), EXPECTED_KEYS.slice().sort());
});

t('real candidates file resolves as present, empty, STAGE-ONLY', () => {
  const r = prefs.listCandidates({});
  assert.strictEqual(r.present, true);
  assert.deepStrictEqual(r.candidates, []);
  assert.ok(r.note.includes('STAGE-ONLY'));
});

// ---------------------------------------------------------------------------
// 7) CLI — real subprocess, exit codes, --json
// ---------------------------------------------------------------------------
console.log('\n7) CLI (real spawned subprocess)');

t('CLI get <known-key> --json exits 0 and reports found:true', () => {
  const r = runCLI(['get', 'never_auto_push', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.found, true);
  assert.strictEqual(parsed.entry.value, true);
});

t('CLI get <unknown-key> --json exits 1 and reports found:false', () => {
  const r = runCLI(['get', 'this_key_does_not_exist_xyz', '--json']);
  assert.strictEqual(r.status, 1);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.found, false);
});

t('CLI get with no key argument exits 2 (usage error)', () => {
  const r = runCLI(['get']);
  assert.strictEqual(r.status, 2);
});

t('CLI list --json exits 0 and includes every seeded key', () => {
  const r = runCLI(['list', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  const keys = parsed.prefs.map((p) => p.key);
  for (const key of EXPECTED_KEYS) assert.ok(keys.includes(key), 'CLI list missing ' + key);
});

t('CLI candidates --json exits 0 and reports a STAGE-ONLY empty list', () => {
  const r = runCLI(['candidates', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.present, true);
  assert.deepStrictEqual(parsed.candidates, []);
});

t('CLI honors FORGE_OWNER_PROFILE env override — an env-layer pref shows up in list output with layer "env"', () => {
  const dir = freshDir('prefs-cli-env');
  const envPath = writeProfile(dir, 'env.json', { cli_env_marker: entry('from-env-cli') });
  const r = runCLI(['list', '--json'], Object.assign({}, process.env, { FORGE_OWNER_PROFILE: envPath }));
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  const found = parsed.prefs.find((p) => p.key === 'cli_env_marker');
  assert.ok(found, 'env-layer marker pref not found in CLI list output');
  assert.strictEqual(found.layer, 'env');
  assert.strictEqual(found.value, 'from-env-cli');
});

t('CLI exits 2 when the FORGE_OWNER_PROFILE env override points at a malformed file', () => {
  const dir = freshDir('prefs-cli-env-bad');
  const badEnvPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badEnvPath, '{ broken');
  const r = runCLI(['list', '--json'], Object.assign({}, process.env, { FORGE_OWNER_PROFILE: badEnvPath }));
  assert.strictEqual(r.status, 2);
  assert.ok(r.stderr.includes('forge-prefs'));
});

t('CLI with an unknown command exits 2', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});

t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
