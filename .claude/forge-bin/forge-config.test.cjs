#!/usr/bin/env node
'use strict';
// forge-config.test.cjs — real tests for the settings resolver/validator/writer (v2.7.0, 2026-09-24).
// HERMETIC: every fixture (config home, project root, owner profile, session state, stub log-event) lives in
// a fresh os.tmpdir() directory. Before the module is even required, FORGE_CONFIG_HOME / FORGE_PROJECT_ROOT
// point at a throwaway TRAP dir, so a call that forgot its opts can never reach the real ~/.claude or this
// repo's .claude — and section 9 proves nothing ever landed in the trap and the real files were untouched.
// CLI runs get the same isolation plus HOME/USERPROFILE redirected to the fixture.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const TRAP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-trap-'));
process.env.FORGE_CONFIG_HOME = path.join(TRAP, 'home');
process.env.FORGE_PROJECT_ROOT = path.join(TRAP, 'proj');
delete process.env.FORGE_OWNER_PROFILE;
delete process.env.FORGE_CONFIG_ASCII;

const REAL_GLOBAL = path.join(os.homedir(), '.claude', 'FORGE_CONFIG.json');
const REAL_PROJECT = path.join(__dirname, '..', 'FORGE_CONFIG.json');
const REAL_ECC_MODE = path.join(__dirname, '..', 'FORGE_ECC_MODE.json');
const sig = (p) => { try { const s = fs.statSync(p); return s.size + ':' + s.mtimeMs; } catch { return 'absent'; } };
const REAL_BEFORE = { g: sig(REAL_GLOBAL), p: sig(REAL_PROJECT), e: sig(REAL_ECC_MODE) };

const cfg = require('./forge-config.cjs');
const text = require('./forge-config-text.cjs');
const actiongate = require('./forge-actiongate.cjs');
const autonomy = require('./forge-autonomy.cjs');

const CLI = path.join(__dirname, 'forge-config.cjs');
const SCHEMA_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json');
const RAW = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const KEYS = Object.keys(RAW.settings);
const GATES = actiongate.KNOWN_GATES.slice();
const ALWAYS = autonomy.getConfig().always_interrupt.slice();
const LOCKED_SCHEMA_IDS = RAW.locked.map((l) => l.id);

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function throwsCode(fn, code, exitCode) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected a throw with code ' + code);
  assert.strictEqual(err.code, code, 'wrong error code: ' + (err && err.message));
  if (exitCode != null) assert.strictEqual(err.exitCode, exitCode);
  return err;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  return {
    root, home, proj,
    o: { configHome: home, projectRoot: proj },
    globalFile: path.join(home, 'FORGE_CONFIG.json'),
    projectFile: path.join(proj, '.claude', 'FORGE_CONFIG.json'),
    stateFile: path.join(proj, '.claude', 'FORGE_SESSION_STATE.json'),
  };
}
const withOpts = (fx, extra) => Object.assign({}, fx.o, extra || {});
const writeJson = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const bytes = (p) => { try { return fs.readFileSync(p).toString('base64'); } catch { return 'absent'; } };
function cli(fx, args, extraEnv) {
  const env = Object.assign({}, process.env, { FORGE_CONFIG_HOME: fx.home, FORGE_PROJECT_ROOT: fx.proj, HOME: fx.home, USERPROFILE: fx.home }, extraEnv || {});
  delete env.FORGE_OWNER_PROFILE;
  delete env.FORGE_CONFIG_ASCII;
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
}
function tableKeys(out) {
  const keys = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(AAN|UIT|ON|OFF|-)\s{2,}(\S+)\s{2,}/.exec(line);
    if (m) keys.push(m[2]);
  }
  return keys;
}
function profile(dir, prefs) {
  const p = path.join(dir, 'owner-profile.json');
  const out = {};
  for (const [k, v] of Object.entries(prefs)) out[k] = { value: v, source: 'test fixture', confidence: 'evidenced', scope: 'global' };
  writeJson(p, { version: 1, prefs: out });
  return p;
}
const NOWHERE = path.join(os.tmpdir(), 'forge-config-nowhere-' + Date.now(), 'x.json');
function stubLogEvent(dir, exitCode) {
  const p = path.join(dir, 'stub-log-event.cjs');
  const rec = path.join(dir, 'stub-calls.jsonl');
  fs.writeFileSync(p, 'const fs = require("fs");\nfs.appendFileSync(' + JSON.stringify(rec) + ', JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));\nprocess.exit(' + exitCode + ');\n');
  return { p, rec, calls: () => (fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

console.log('forge-config tests (settings resolver / validator / writer — v2.7.0)');

// ---------------------------------------------------------------------------------------------------
console.log('\n1) schema integrity');
t('every setting has type/default/scope/group/desc.nl/desc.en/consumers', () => {
  for (const k of KEYS) {
    const s = RAW.settings[k];
    for (const f of ['type', 'default', 'scope', 'group', 'desc', 'consumers']) assert.ok(Object.prototype.hasOwnProperty.call(s, f), k + ' misses ' + f);
    assert.ok(s.desc.nl && s.desc.en, k + ' desc nl/en');
    assert.ok(Array.isArray(s.consumers) && s.consumers.length > 0, k + ' consumers');
    assert.ok(Object.prototype.hasOwnProperty.call(RAW.groups, s.group), k + ' group');
  }
});
t('every default validates against its own type (parseValue round-trips it unchanged)', () => {
  for (const k of KEYS) assert.strictEqual(cfg.parseValue(k, RAW.settings[k].default, RAW), RAW.settings[k].default, k);
});
t('validateSchema() finds no problem in the real schema, including against every gate id', () => {
  assert.deepStrictEqual(cfg.validateSchema(RAW, GATES.concat(ALWAYS)), []);
});
t('no settings key equals a KNOWN_GATES id, an always_interrupt entry or a locked id', () => {
  for (const k of KEYS) {
    assert.ok(!GATES.includes(k), k + ' is a gate');
    assert.ok(!ALWAYS.includes(k), k + ' is always_interrupt');
    assert.ok(!LOCKED_SCHEMA_IDS.includes(k), k + ' is locked');
  }
});
t('LOCKED_IDS is a superset of KNOWN_GATES + always_interrupt + schema.locked (drift canary)', () => {
  const locked = new Set(cfg.LOCKED_IDS);
  for (const id of GATES.concat(ALWAYS, LOCKED_SCHEMA_IDS)) assert.ok(locked.has(id), id + ' missing from LOCKED_IDS');
});
t('owner directive pinned: usage-guard default ON, pause-at default 98, the three documented exceptions OFF', () => {
  assert.strictEqual(RAW.settings['usage-guard'].default, true);
  assert.strictEqual(RAW.settings['usage-guard.pause-at'].default, 98);
  assert.strictEqual(RAW.settings.paperclip.default, false);
  assert.strictEqual(RAW.settings['ecc-full-test'].default, false);
  assert.strictEqual(RAW.settings.cleanup.default, 'report');
});
t('a schema whose setting collides with a gate id is rejected, and resolve() fails closed on it (exit 2)', () => {
  const bad = JSON.parse(JSON.stringify(RAW));
  bad.settings['git-push'] = Object.assign({}, RAW.settings.nvidia);
  assert.ok(cfg.validateSchema(bad, GATES).some((p) => /collides/.test(p)));
  const fx = fixture();
  const sp = path.join(fx.root, 'schema.json');
  writeJson(sp, bad);
  throwsCode(() => cfg.resolve(withOpts(fx, { schemaPath: sp })), 'malformed', 2);
});
t('validateSchema() catches a default outside its own range and a missing desc language', () => {
  const bad = JSON.parse(JSON.stringify(RAW));
  bad.settings['usage-guard.pause-at'].default = 120;
  delete bad.settings.nvidia.desc.en;
  const probs = cfg.validateSchema(bad, []);
  assert.ok(probs.some((p) => /pause-at.*default/.test(p)), JSON.stringify(probs));
  assert.ok(probs.some((p) => /nvidia.*desc/.test(p)), JSON.stringify(probs));
});
t('SCHEMA and DEFAULT_PATHS are exported; DEFAULT_PATHS follows FORGE_CONFIG_HOME / FORGE_PROJECT_ROOT', () => {
  assert.deepStrictEqual(Object.keys(cfg.SCHEMA.settings), KEYS);
  const d = cfg.DEFAULT_PATHS;
  assert.strictEqual(d.global, path.join(path.resolve(TRAP, 'home'), 'FORGE_CONFIG.json'));
  assert.strictEqual(d.project, path.join(path.resolve(TRAP, 'proj'), '.claude', 'FORGE_CONFIG.json'));
  assert.ok(d.schema.endsWith('FORGE_CONFIG_SCHEMA.json'));
});

// ---------------------------------------------------------------------------------------------------
console.log('\n2) precedence: default < product-default < global < project < flag');
t('no files, no profile: every value is the schema default with source "default"', () => {
  const fx = fixture();
  const r = cfg.resolve(fx.o);
  for (const k of KEYS) { assert.strictEqual(r.settings[k].value, RAW.settings[k].default, k); assert.strictEqual(r.settings[k].source, 'default'); }
  assert.strictEqual(r.files.global.present, false);
  assert.strictEqual(r.files.project.present, false);
  assert.ok(r.notes.some((n) => /normal/.test(n)), 'missing files are noted as normal');
});
t('product-default comes from the owner profile (read-only) and applies the schema map', () => {
  const fx = fixture();
  const pp = profile(fx.root, { codex_on_high_risk: 'optional-on-request', autonomy_default: 'ask-each-phase', ui_quality_default: false });
  const before = bytes(pp);
  const r = cfg.resolve(withOpts(fx, { prefsOpts: { profilePath: pp, globalProfilePath: NOWHERE } }));
  // review-boss M1 (2026-09-24): codex-review is deliberately NOT mapped from the profile any more — the shipped
  // profile's optional-on-request would silently downgrade the everything-on default on every fresh install.
  assert.strictEqual(r.settings['codex-review'].value, 'auto');
  assert.strictEqual(r.settings['codex-review'].source, 'default');
  assert.strictEqual(r.settings.autonomy.value, 'ask-each-phase');
  assert.strictEqual(r.settings['ui-quality'].value, false, 'a boolean pref maps straight onto a bool key');
  assert.strictEqual(bytes(pp), before, 'the owner profile is never written');
});
t('the product-default layer is derived from projectRoot/.claude + FORGE_CONFIG_HOME when no prefsOpts is given', () => {
  const fx = fixture();
  writeJson(path.join(fx.home, 'FORGE_OWNER_PROFILE.json'), { version: 1, prefs: { autonomy_default: { value: 'full-auto-within-mission', source: 't', confidence: 'evidenced', scope: 'global' } } });
  assert.strictEqual(cfg.get('autonomy', fx.o).value, 'full-auto-within-mission');
  assert.strictEqual(cfg.get('autonomy', fx.o).source, 'product-default');
});
t('an unfit or unreadable owner profile is skipped with a note, never a crash', () => {
  const fx = fixture();
  const pp = profile(fx.root, { autonomy_default: 'banana' });
  const r = cfg.resolve(withOpts(fx, { prefsOpts: { profilePath: pp, globalProfilePath: NOWHERE } }));
  assert.strictEqual(r.settings.autonomy.source, 'default');
  assert.ok(r.notes.some((n) => /autonomy_default/.test(n)));
  const broken = path.join(fx.root, 'broken-profile.json');
  fs.writeFileSync(broken, '{ nope');
  const r2 = cfg.resolve(withOpts(fx, { prefsOpts: { profilePath: broken, globalProfilePath: NOWHERE } }));
  assert.strictEqual(r2.settings['codex-review'].source, 'default');
  assert.ok(r2.notes.some((n) => /Owner profile unreadable/.test(n)));
});
t('global beats product-default, project beats global, flag beats project', () => {
  const fx = fixture();
  const pp = profile(fx.root, { codex_on_high_risk: 'optional-on-request' });
  const o = withOpts(fx, { prefsOpts: { profilePath: pp, globalProfilePath: NOWHERE } });
  cfg.set('codex-review', 'off', Object.assign({ global: true }, o));
  assert.deepStrictEqual([cfg.get('codex-review', o).value, cfg.get('codex-review', o).source], ['off', 'global']);
  cfg.set('codex-review', 'auto', o);
  assert.deepStrictEqual([cfg.get('codex-review', o).value, cfg.get('codex-review', o).source], ['auto', 'project']);
  const f = cfg.get('codex-review', Object.assign({ flags: ['codex-review=on-request'] }, o));
  assert.deepStrictEqual([f.value, f.source, f.set_by], ['on-request', 'flag', '--flag']);
  assert.strictEqual(cfg.get('codex-review', Object.assign({ flags: { 'codex-review': 'off' } }, o)).value, 'off', 'object form of flags');
  assert.ok(!fs.readFileSync(fx.projectFile, 'utf8').includes('on-request'), 'a flag is never written');
});
t('unset falls through: project -> global -> product-default -> default', () => {
  const fx = fixture();
  // ui-quality is still profile-mapped (ui_quality_default); codex-review no longer is (review-boss M1, 2026-09-24).
  const pp = profile(fx.root, { ui_quality_default: false });
  const o = withOpts(fx, { prefsOpts: { profilePath: pp, globalProfilePath: NOWHERE } });
  cfg.set('ui-quality', 'on', Object.assign({ global: true }, o));
  cfg.set('ui-quality', 'off', o);
  cfg.unset('ui-quality', o);
  assert.strictEqual(cfg.get('ui-quality', o).source, 'global');
  cfg.unset('ui-quality', Object.assign({ global: true }, o));
  assert.strictEqual(cfg.get('ui-quality', o).source, 'product-default');
  assert.strictEqual(cfg.get('ui-quality', o).value, false);
  assert.strictEqual(cfg.get('ui-quality', fx.o).source, 'default');
});
t('a global-scope key in the project file is IGNORED with a visible note', () => {
  const fx = fixture();
  writeJson(fx.projectFile, { version: 1, settings: { 'usage-guard.pause-at': { value: 60 } } });
  const r = cfg.resolve(withOpts(fx, { lang: 'en' }));
  assert.strictEqual(r.settings['usage-guard.pause-at'].value, 98);
  assert.strictEqual(r.settings['usage-guard.pause-at'].source, 'default');
  assert.deepStrictEqual(r.ignored_project_values, ['usage-guard.pause-at']);
  assert.ok(r.notes.some((n) => /usage-guard\.pause-at is machine-wide; set it with --global/.test(n)), JSON.stringify(r.notes));
});
t('when the global and project file are the same path (Forge in the home dir) nothing is double-read', () => {
  const fx = fixture();
  writeJson(fx.projectFile, { version: 1, settings: { autonomy: { value: 'ask-each-phase' } } });
  const r = cfg.resolve(withOpts(fx, { globalPath: fx.projectFile }));
  assert.strictEqual(r.settings.autonomy.value, 'ask-each-phase');
  assert.deepStrictEqual(r.ignored_project_values, []);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n3) validation');
t('bool synonyms incl. aan/uit/ja/nee, case-insensitive', () => {
  const yes = ['on', 'aan', 'true', 'yes', 'ja', '1', 'enabled', 'enable', 'AAN', 'Ja', ' on '];
  const no = ['off', 'uit', 'false', 'no', 'nee', '0', 'disabled', 'disable', 'UIT', 'Nee'];
  for (const v of yes) assert.strictEqual(cfg.parseValue('usage-guard', v), true, v);
  for (const v of no) assert.strictEqual(cfg.parseValue('usage-guard', v), false, v);
  assert.strictEqual(cfg.parseValue('usage-guard', false), false);
});
t('a bad bool is refused with a beginner-plain message (nl)', () => {
  const e = throwsCode(() => cfg.parseValue('usage-guard', 'misschien', null, 'nl'), 'invalid_value', 2);
  assert.ok(e.message.includes('usage-guard moet aan of uit zijn') && e.message.includes('Voorbeeld: /forge config set usage-guard aan'), e.message);
});
t('an enum error lists every allowed value; enum is case-insensitive; "uit" maps to "off" only when allowed', () => {
  const e = throwsCode(() => cfg.parseValue('autonomy', 'wild', null, 'en'), 'invalid_value', 2);
  for (const a of RAW.settings.autonomy.allowed) assert.ok(e.message.includes(a), a);
  assert.strictEqual(cfg.parseValue('autonomy', 'ASK-EACH-PHASE'), 'ask-each-phase');
  assert.strictEqual(cfg.parseValue('codex-review', 'uit'), 'off');
  throwsCode(() => cfg.parseValue('autonomy', 'uit'), 'invalid_value', 2);
});
t('int range: 50 and 99 ok, 49/100/97.5/abc refused, a % suffix is accepted', () => {
  assert.strictEqual(cfg.parseValue('usage-guard.pause-at', '50'), 50);
  assert.strictEqual(cfg.parseValue('usage-guard.pause-at', 99), 99);
  assert.strictEqual(cfg.parseValue('usage-guard.pause-at', '98%'), 98);
  assert.strictEqual(cfg.parseValue('usage-guard.pause-at', '98 %'), 98);
  for (const bad of ['49', '100', '97.5', 'abc', '']) throwsCode(() => cfg.parseValue('usage-guard.pause-at', bad), 'invalid_value', 2);
});
t('the exact beginner message for an out-of-range int (spec wording)', () => {
  const e = throwsCode(() => cfg.parseValue('usage-guard.pause-at', '120', null, 'nl'), 'invalid_value', 2);
  assert.strictEqual(e.message, 'usage-guard.pause-at moet een heel getal tussen 50 en 99 zijn — je gaf "120". Voorbeeld: /forge config set usage-guard.pause-at 98');
});
t('number range with a Dutch decimal comma and a $ prefix', () => {
  assert.strictEqual(cfg.parseValue('budget-usd', '2,5'), 2.5);
  assert.strictEqual(cfg.parseValue('budget-usd', '$5'), 5);
  assert.strictEqual(cfg.parseValue('budget-usd', 0.25), 0.25);
  for (const bad of ['0.2', '26', 'veel']) throwsCode(() => cfg.parseValue('budget-usd', bad), 'invalid_value', 2);
});
t('int-or-auto accepts auto (any case) or an int in range', () => {
  assert.strictEqual(cfg.parseValue('team-max', 'AUTO'), 'auto');
  assert.strictEqual(cfg.parseValue('team-max', '4'), 4);
  for (const bad of ['0', '13', 'x', '2.5']) throwsCode(() => cfg.parseValue('team-max', bad), 'invalid_value', 2);
});
t('an unknown key gives a nearest-key suggestion (via key and via alias) and points to the list', () => {
  const fx = fixture();
  const e = throwsCode(() => cfg.set('pauze-at', '90', withOpts(fx, { lang: 'nl' })), 'unknown_key', 2);
  assert.strictEqual(e.suggestion, 'usage-guard.pause-at');
  assert.ok(e.message.includes('Alle instellingen: /forge config list'), e.message);
  assert.strictEqual(throwsCode(() => cfg.set('autonomie', 'x', fx.o), 'unknown_key', 2).suggestion, 'autonomy');
  assert.strictEqual(throwsCode(() => cfg.get('zzzzqqqq', fx.o), 'unknown_key', 1).suggestion, null);
});
t('every locked id (gates, always_interrupt, schema.locked) is refused with exit 3 and file bytes unchanged', () => {
  const fx = fixture();
  cfg.set('autonomy', 'ask-each-phase', fx.o);
  cfg.set('usage-guard.pause-at', '95', fx.o);
  const pb = bytes(fx.projectFile), gb = bytes(fx.globalFile);
  for (const id of new Set(GATES.concat(ALWAYS, LOCKED_SCHEMA_IDS))) {
    throwsCode(() => cfg.set(id, 'off', fx.o), 'locked', 3);
    throwsCode(() => cfg.set(id, 'off', withOpts(fx, { global: true })), 'locked', 3);
    throwsCode(() => cfg.unset(id, fx.o), 'locked', 3);
    throwsCode(() => cfg.resolve(withOpts(fx, { flags: [id + '=off'] })), 'locked', 3);
  }
  assert.strictEqual(bytes(fx.projectFile), pb);
  assert.strictEqual(bytes(fx.globalFile), gb);
});
t('a locked id or an unknown key inside a file is ignored with a note, never applied', () => {
  const fx = fixture();
  writeJson(fx.projectFile, { version: 1, settings: { 'hard-gates': { value: false }, 'no-such-thing': { value: 1 }, nvidia: { value: false } } });
  const r = cfg.resolve(withOpts(fx, { lang: 'en' }));
  assert.strictEqual(r.settings.nvidia.value, false);
  assert.ok(r.notes.some((n) => /"hard-gates" .* is locked/.test(n)));
  assert.ok(r.notes.some((n) => /"no-such-thing" .* not a known setting/.test(n)));
  assert.ok(!Object.prototype.hasOwnProperty.call(r.settings, 'hard-gates'));
});

// ---------------------------------------------------------------------------------------------------
console.log('\n4) writes');
t('set writes atomically (no temp file left) with set_at/set_by, into the project file for a project key', () => {
  const fx = fixture();
  const R = cfg.set('autonomy', 'ask-each-phase', withOpts(fx, { now: '2026-09-24T10:00:00.000Z' }));
  assert.strictEqual(R.file, fx.projectFile);
  assert.deepStrictEqual([R.from, R.to, R.scope, R.auto_global], ['continue-within-mission', 'ask-each-phase', 'project', false]);
  const d = readJson(fx.projectFile);
  assert.deepStrictEqual(d.settings.autonomy, { value: 'ask-each-phase', set_at: '2026-09-24T10:00:00.000Z', set_by: 'owner /forge config set' });
  assert.strictEqual(d.version, 1);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(fx.projectFile)).filter((f) => f.endsWith('.tmp')), []);
  assert.strictEqual(fs.existsSync(fx.globalFile), false, 'a project key never touches the global file');
});
t('a global-scope key goes to the global file automatically; --global writes ONLY into the temp home', () => {
  const fx = fixture();
  const R = cfg.set('usage-guard.pause-at', '95', fx.o);
  assert.deepStrictEqual([R.file, R.scope, R.auto_global], [fx.globalFile, 'global', true]);
  assert.strictEqual(fs.existsSync(fx.projectFile), false);
  const R2 = cfg.set('nvidia', 'uit', withOpts(fx, { global: true }));
  assert.deepStrictEqual([R2.file, R2.auto_global], [fx.globalFile, false]);
  assert.strictEqual(readJson(fx.globalFile).settings.nvidia.value, false);
  assert.strictEqual(fs.existsSync(fx.projectFile), false);
  assert.deepStrictEqual(fs.readdirSync(fx.home).filter((f) => f.endsWith('.tmp')), []);
});
t('writes preserve unknown top-level keys and other entries', () => {
  const fx = fixture();
  writeJson(fx.projectFile, { version: 1, custom_note: 'keep me', extra: { a: 1 }, settings: { nvidia: { value: false, set_at: 'x', set_by: 'y' } } });
  cfg.set('council', 'off', fx.o);
  cfg.unset('nvidia', fx.o);
  const d = readJson(fx.projectFile);
  assert.strictEqual(d.custom_note, 'keep me');
  assert.deepStrictEqual(d.extra, { a: 1 });
  assert.strictEqual(d.settings.council.value, 'off');
  assert.ok(!Object.prototype.hasOwnProperty.call(d.settings, 'nvidia'));
  cfg.reset(withOpts(fx, { yes: true }));
  const d2 = readJson(fx.projectFile);
  assert.deepStrictEqual(d2.settings, {});
  assert.strictEqual(d2.custom_note, 'keep me');
});
t('a malformed file is refused (exit 2) and its bytes stay identical — bad JSON, wrong shape, bad value, bad version', () => {
  const cases = ['{ broken', JSON.stringify({ version: 1, settings: [] }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 2, settings: {} }),
    JSON.stringify({ version: 1, settings: { autonomy: { value: 'wild' } } }), JSON.stringify({ version: 1, settings: { autonomy: 'ask-each-phase' } }), '[]'];
  for (const c of cases) {
    const fx = fixture();
    fs.writeFileSync(fx.projectFile, c);
    const before = bytes(fx.projectFile);
    throwsCode(() => cfg.set('council', 'off', fx.o), 'malformed', 2);
    throwsCode(() => cfg.resolve(fx.o), 'malformed', 2);
    const plan = cfg.reset(fx.o); // without --yes: only the plan, nothing moves
    assert.deepStrictEqual([plan.damaged, plan.confirmed], [true, false], c);
    assert.strictEqual(bytes(fx.projectFile), before, 'bytes changed for ' + c);
  }
});
t('reset --yes on a DAMAGED settings file keeps its exact bytes as a .damaged-<time> backup and starts clean', () => {
  const fx = fixture();
  fs.writeFileSync(fx.projectFile, '{ broken');
  const before = bytes(fx.projectFile);
  const R = cfg.reset(withOpts(fx, { yes: true, now: '2026-09-24T12:00:00.000Z', lang: 'en' }));
  assert.deepStrictEqual([R.damaged, R.confirmed], [true, true]);
  assert.strictEqual(path.dirname(R.moved_to), path.dirname(fx.projectFile));
  assert.ok(path.basename(R.moved_to).startsWith('FORGE_CONFIG.json.damaged-2026-09-24T12-00-00-000Z'), R.moved_to);
  assert.strictEqual(bytes(R.moved_to), before, 'the damaged bytes are kept, never deleted');
  assert.deepStrictEqual(readJson(fx.projectFile), { version: 1, settings: {} });
  assert.strictEqual(cfg.resolve(fx.o).settings.nvidia.value, true, 'readable again: defaults apply');
  assert.ok(/kept as/.test(text.renderReset(R, 'en')), text.renderReset(R, 'en'));
});
t('a malformed GLOBAL file also blocks a project write (fail-closed), nothing written anywhere', () => {
  const fx = fixture();
  fs.writeFileSync(fx.globalFile, '{"version":1,"settings":{"usage-guard":{"value":"banana"}}}');
  const gb = bytes(fx.globalFile);
  throwsCode(() => cfg.set('council', 'off', fx.o), 'malformed', 2);
  assert.strictEqual(bytes(fx.globalFile), gb);
  assert.strictEqual(fs.existsSync(fx.projectFile), false);
});
t('setting the same value again is a no-op (unchanged:true, set_at kept)', () => {
  const fx = fixture();
  cfg.set('council', 'off', withOpts(fx, { now: '2026-09-24T09:00:00.000Z' }));
  const before = bytes(fx.projectFile);
  const R = cfg.set('council', 'uit', withOpts(fx, { now: '2026-09-24T11:00:00.000Z' }));
  assert.strictEqual(R.unchanged, true);
  assert.strictEqual(bytes(fx.projectFile), before);
});
t('--global under a project value reports the shadow and how to remove it', () => {
  const fx = fixture();
  cfg.set('council', 'off', fx.o);
  const R = cfg.set('council', 'auto', withOpts(fx, { global: true }));
  assert.ok(R.shadow && R.shadow.source === 'project' && R.shadow.undo === '/forge config unset council', JSON.stringify(R.shadow));
  assert.strictEqual(cfg.get('council', fx.o).value, 'off');
});
t('unset of a global-scope key also removes a stray (ignored) copy from the project file', () => {
  const fx = fixture();
  cfg.set('usage-guard.pause-at', '90', fx.o);
  writeJson(fx.projectFile, { version: 1, settings: { 'usage-guard.pause-at': { value: 60 } } });
  const R = cfg.unset('usage-guard.pause-at', fx.o);
  assert.strictEqual(R.files.length, 2);
  assert.ok(!('usage-guard.pause-at' in readJson(fx.globalFile).settings));
  assert.ok(!('usage-guard.pause-at' in readJson(fx.projectFile).settings));
  assert.strictEqual(cfg.get('usage-guard.pause-at', fx.o).value, 98);
});
t('reset without yes writes nothing and lists what it would remove', () => {
  const fx = fixture();
  cfg.set('council', 'off', fx.o);
  const before = bytes(fx.projectFile);
  const R = cfg.reset(fx.o);
  assert.deepStrictEqual([R.confirmed, R.would_remove], [false, ['council']]);
  assert.strictEqual(bytes(fx.projectFile), before);
});
t('turning a setting with a disclosure back ON returns the disclosure text', () => {
  const fx = fixture();
  cfg.set('usage-guard', 'uit', fx.o);
  const R = cfg.set('usage-guard', 'aan', withOpts(fx, { lang: 'en' }));
  assert.strictEqual(R.disclosure, RAW.settings['usage-guard'].disclosure.en);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n5) diff / markSeen (change detection)');
t('first run: first_run true, no changes, nothing written without markSeen', () => {
  const fx = fixture();
  const D = cfg.diff(fx.o);
  assert.deepStrictEqual([D.first_run, D.changed.length, D.seen_hash, D.count], [true, 0, null, KEYS.length]);
  assert.strictEqual(fs.existsSync(fx.stateFile), false);
});
t('first run with markSeen records {hash, at, values}; the hash equals current_hash', () => {
  const fx = fixture();
  const D = cfg.diff(withOpts(fx, { markSeen: true }));
  assert.strictEqual(D.seen_marked, true);
  const seen = readJson(fx.stateFile).config_seen;
  assert.strictEqual(seen.hash, D.current_hash);
  assert.strictEqual(seen.values['usage-guard.pause-at'], 98);
  assert.ok(Date.parse(seen.at) > 0);
});
t('after a set: one changed row with from/to/source/set_by and the exact human line', () => {
  const fx = fixture();
  cfg.markSeen(fx.o);
  cfg.set('usage-guard.pause-at', '95', withOpts(fx, { now: '2026-09-24T10:00:00.000Z' }));
  const D = cfg.diff(withOpts(fx, { lang: 'nl', now: '2026-09-24T10:02:00.000Z' }));
  assert.strictEqual(D.first_run, false);
  assert.strictEqual(D.changed.length, 1);
  assert.deepStrictEqual(D.changed[0], { key: 'usage-guard.pause-at', from: 98, to: 95, source: 'global', set_at: '2026-09-24T10:00:00.000Z', set_by: 'owner /forge config set' });
  assert.strictEqual(D.lines[0], 'usage-guard.pause-at: 98 → 95 (jij, /forge config set, 2 min geleden)');
  assert.notStrictEqual(D.seen_hash, D.current_hash);
});
t('markSeen -> diff is empty and the hashes match', () => {
  const fx = fixture();
  cfg.markSeen(fx.o);
  cfg.set('council', 'off', fx.o);
  cfg.markSeen(fx.o);
  const D = cfg.diff(fx.o);
  assert.deepStrictEqual(D.changed, []);
  assert.strictEqual(D.seen_hash, D.current_hash);
});
t('config_seen is merge-written: mode/since/last_activity/notes and unknown fields are preserved', () => {
  const fx = fixture();
  const state = { mode: 'on', since: '2026-09-24T08:00:00Z', last_activity: '2026-09-24T09:00:00Z', project_isolation: 'on', notes: 'keep this note', custom: { x: 1 } };
  writeJson(fx.stateFile, state);
  cfg.markSeen(fx.o);
  const d = readJson(fx.stateFile);
  for (const k of Object.keys(state)) assert.deepStrictEqual(d[k], state[k], k);
  assert.ok(d.config_seen && d.config_seen.hash);
});
t('a malformed session state refuses diff/markSeen (exit 2) and is left byte-identical', () => {
  const fx = fixture();
  fs.writeFileSync(fx.stateFile, '{ not json');
  const before = bytes(fx.stateFile);
  throwsCode(() => cfg.diff(withOpts(fx, { markSeen: true })), 'malformed', 2);
  throwsCode(() => cfg.markSeen(fx.o), 'malformed', 2);
  assert.strictEqual(bytes(fx.stateFile), before);
});
t('per-run flags are compared but never stored as seen', () => {
  const fx = fixture();
  cfg.markSeen(fx.o);
  const D = cfg.diff(withOpts(fx, { flags: ['council=off'], markSeen: true }));
  assert.deepStrictEqual(D.changed.map((c) => [c.key, c.source]), [['council', 'flag']]);
  assert.deepStrictEqual(cfg.diff(fx.o).changed, [], 'the persistent value was stored, not the flag value');
});
t('unset back to the default is reported as "back to default"', () => {
  const fx = fixture();
  cfg.set('council', 'off', fx.o);
  cfg.markSeen(fx.o);
  cfg.unset('council', fx.o);
  const D = cfg.diff(withOpts(fx, { lang: 'en' }));
  assert.strictEqual(D.lines[0], 'council: off → auto (back to default)');
});
t('--run with a log-event stub that exits 1: logged:false, no throw, NOT marked seen (change kept)', () => {
  const fx = fixture();
  const stub = stubLogEvent(fx.root, 1);
  cfg.markSeen(fx.o);
  cfg.set('council', 'off', fx.o);
  const D = cfg.diff(withOpts(fx, { run: 'test-run-1', markSeen: true, logEventPath: stub.p }));
  assert.deepStrictEqual([D.logged, D.status, D.seen_marked], [false, 1, false]);
  assert.strictEqual(stub.calls().length, 1);
  assert.strictEqual(cfg.diff(fx.o).changed.length, 1, 'the unlogged change is still reported next time');
});
t('--run with a stub that exits 0: ONE config_changed call with the documented payload, then marked seen', () => {
  const fx = fixture();
  const stub = stubLogEvent(fx.root, 0);
  cfg.markSeen(fx.o);
  cfg.set('council', 'off', fx.o);
  cfg.set('usage-guard.pause-at', '95', fx.o);
  const D = cfg.diff(withOpts(fx, { run: 'test-run-2', markSeen: true, logEventPath: stub.p, lang: 'en' }));
  assert.deepStrictEqual([D.logged, D.status, D.seen_marked], [true, 0, true]);
  const calls = stub.calls();
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].slice(0, 2), ['test-run-2', 'config_changed']);
  const ev = JSON.parse(calls[0][2]);
  assert.deepStrictEqual([ev.agent, ev.role, ev.runtime, ev.count], ['orchestrator', 'lead', 'internal', 2]);
  assert.deepStrictEqual(ev.changed.map((c) => c.key).sort(), ['council', 'usage-guard.pause-at']);
  assert.ok(ev.note.includes('council: auto -> off') && ev.note.includes('; '), ev.note);
  assert.deepStrictEqual(cfg.diff(fx.o).changed, []);
});
t('--run without a change never spawns log-event; a missing log-event is reported, not thrown', () => {
  const fx = fixture();
  const stub = stubLogEvent(fx.root, 0);
  cfg.markSeen(fx.o);
  const D = cfg.diff(withOpts(fx, { run: 'test-run-3', logEventPath: stub.p }));
  assert.deepStrictEqual([D.logged, stub.calls().length], [false, 0]);
  cfg.set('council', 'off', fx.o);
  const D2 = cfg.diff(withOpts(fx, { run: 'test-run-3', logEventPath: NOWHERE }));
  assert.deepStrictEqual([D2.logged, D2.status], [false, null]);
  assert.ok(/not found/.test(D2.stderr));
  throwsCode(() => cfg.diff(withOpts(fx, { run: 'bad id!' })), 'usage', 2);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n6) output (CLI)');
const CORE_WHEN = KEYS.filter((k) => RAW.settings[k].group !== 'advanced');
const ADVANCED = KEYS.filter((k) => RAW.settings[k].group === 'advanced');
t('list prints each core/when-needed key exactly once and no advanced key; --all adds each advanced key once', () => {
  const fx = fixture();
  const a = cli(fx, ['list', '--lang', 'nl']);
  assert.strictEqual(a.status, 0, a.err);
  const keys = tableKeys(a.out);
  for (const k of CORE_WHEN) assert.strictEqual(keys.filter((x) => x === k).length, 1, k);
  for (const k of ADVANCED) assert.ok(!keys.includes(k), k);
  const b = tableKeys(cli(fx, ['list', '--all', '--lang', 'nl']).out);
  for (const k of KEYS) assert.strictEqual(b.filter((x) => x === k).length, 1, k);
  assert.strictEqual(b.length, KEYS.length);
});
t('header, columns, group titles and status words follow the language (--lang en / nl)', () => {
  const fx = fixture();
  const nl = cli(fx, ['list', '--lang', 'nl']).out;
  const en = cli(fx, ['list', '--lang', 'en']).out;
  assert.ok(nl.startsWith('Forge instellingen — project "proj" (alles staat standaard AAN; wijzig met één commando)'));
  assert.ok(en.startsWith('Forge settings — project "proj"'));
  assert.ok(/Status\s+Instelling\s+Waarde\s+Vanwaar\s+Wat het doet/.test(nl));
  assert.ok(/Status\s+Setting\s+Value\s+From\s+What it does/.test(en));
  assert.ok(nl.includes('== ' + RAW.groups.core.nl + ' =='));
  assert.ok(/^UIT\s+paperclip\s+uit\s+standaard/m.test(nl) && /^ON\s+usage-guard\s+on\s+default/m.test(en));
  assert.ok(/^AAN\s+start-gate\s+off/m.test(nl), 'start-gate "off" (no waiting) is the ON behaviour');
});
t('--ascii output is pure 7-bit ASCII (list --all and explain)', () => {
  const fx = fixture();
  for (const args of [['list', '--all', '--ascii', '--lang', 'nl'], ['explain', 'usage-guard', '--ascii', '--lang', 'nl'], ['diff', '--ascii']]) {
    const r = cli(fx, args);
    assert.strictEqual(r.status, 0, r.err);
    assert.ok(/^[\x00-\x7f]*$/.test(r.all), args.join(' ') + ' has non-ASCII');
  }
});
t('footer carries the locked paragraph (every locked id) and the change/explain/all hint', () => {
  const fx = fixture();
  const nl = cli(fx, ['list', '--lang', 'nl']).out;
  const tail = nl.slice(nl.indexOf('Vergrendeld — altijd aan, nooit instelbaar:'));
  assert.ok(tail.length > 0);
  for (const id of LOCKED_SCHEMA_IDS) assert.ok(tail.includes(id + ' ('), id);
  assert.ok(nl.includes('Wijzigen: /forge config set <instelling> <waarde> · Uitleg: /forge config explain <instelling> · Alles: /forge config list --all'));
});
t('every setting with a disclosure gets a footnote carrying that disclosure', () => {
  const fx = fixture();
  const en = cli(fx, ['list', '--all', '--lang', 'en']).out.replace(/\s+/g, ' ');
  for (const k of KEYS) if (RAW.settings[k].disclosure) assert.ok(en.includes(RAW.settings[k].disclosure.en.replace(/\s+/g, ' ')), k);
});
t('--json parses and every entry exposes source/set_at/set_by', () => {
  const fx = fixture();
  cli(fx, ['set', 'council', 'off']);
  const r = cli(fx, ['list', '--json', '--all']);
  const L = JSON.parse(r.out);
  assert.strictEqual(L.settings.length, KEYS.length);
  for (const s of L.settings) for (const f of ['source', 'set_at', 'set_by']) assert.ok(Object.prototype.hasOwnProperty.call(s, f), s.key + '.' + f);
  const c = L.settings.find((s) => s.key === 'council');
  assert.deepStrictEqual([c.source, c.set_by], ['project', 'owner /forge config set']);
  assert.ok(Date.parse(c.set_at) > 0);
});
t('get prints the documented one-liner', () => {
  const fx = fixture();
  const r = cli(fx, ['get', 'usage-guard.pause-at', '--lang', 'nl']);
  assert.strictEqual(r.out.trim(), 'usage-guard.pause-at = 98 % [standaard] ' + RAW.settings['usage-guard.pause-at'].desc.nl);
});
t('set prints the documented OK line for a machine-wide key', () => {
  const fx = fixture();
  const r = cli(fx, ['set', 'usage-guard.pause-at', '95', '--lang', 'nl']);
  const first = r.out.split(/\r?\n/)[0];
  assert.ok(first.startsWith('OK — usage-guard.pause-at: 98 → 95 (voor alle projecten, opgeslagen in ') && first.endsWith('). Forge gebruikt dit vanaf de volgende check.'), first);
  assert.ok(r.out.includes('geldt voor de hele computer'));
});
t('explain shows the disclosure and every flag meaning for each C/N/$/U/X/D key, plus consumers and undo', () => {
  const fx = fixture();
  const flagged = KEYS.filter((k) => (RAW.settings[k].flags || []).length);
  assert.ok(flagged.length >= 6);
  for (const k of flagged) {
    const out = cli(fx, ['explain', k, '--lang', 'en']).out;
    const s = RAW.settings[k];
    if (s.disclosure) assert.ok(out.includes(s.disclosure.en), k + ' disclosure');
    for (const f of s.flags) assert.ok(out.includes(f + ' = ' + text.t('en').flag[f]), k + ' flag ' + f);
    assert.ok(out.includes(s.consumers[0]), k + ' consumers');
  }
  cli(fx, ['set', 'council', 'off']);
  assert.ok(cli(fx, ['explain', 'council', '--lang', 'en']).out.includes('Undo: /forge config unset council'));
});
t('language: --lang > config language > .forge-setup.json > en', () => {
  const fx = fixture();
  assert.ok(cli(fx, ['list']).out.startsWith('Forge settings'));
  writeJson(path.join(fx.proj, '.claude', '.forge-setup.json'), { answers: { lang: 'nl' } });
  assert.ok(cli(fx, ['list']).out.startsWith('Forge instellingen'));
  cli(fx, ['set', 'language', 'en']);
  assert.ok(cli(fx, ['list']).out.startsWith('Forge settings'));
  assert.ok(cli(fx, ['list', '--lang', 'nl']).out.startsWith('Forge instellingen'));
});
t('status column: pause-at follows its parent usage-guard; ask-each-phase shows OFF', () => {
  const fx = fixture();
  cli(fx, ['set', 'usage-guard', 'off']);
  cli(fx, ['set', 'autonomy', 'ask-each-phase']);
  const en = cli(fx, ['list', '--lang', 'en']).out;
  assert.ok(/^OFF\s+usage-guard\.pause-at\s+98 %/m.test(en));
  assert.ok(/^OFF\s+autonomy\s+ask-each-phase\s+project/m.test(en));
});
t('parse maps a plain sentence to the exact set command and never writes', () => {
  const fx = fixture();
  const cases = [['zet de usage guard op 97%', '/forge config set usage-guard.pause-at 97'], ['zet usage guard uit', '/forge config set usage-guard uit'],
    ['taal nederlands', '/forge config set language nl'], ['zet codex uit', '/forge config set codex-review off']];
  for (const [s, cmd] of cases) {
    const r = cli(fx, ['parse', s, '--lang', 'nl', '--json']);
    assert.strictEqual(r.status, 0, s + ' ' + r.all);
    assert.strictEqual(JSON.parse(r.out).command, cmd, s);
  }
  assert.strictEqual(fs.existsSync(fx.projectFile) || fs.existsSync(fx.globalFile), false);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n7) no credential reads');
t('static: none of the four source files mentions the login file, token fields, fetch( or https.request', () => {
  for (const f of ['forge-config.cjs', 'forge-config-text.cjs', 'forge-config-cli.cjs', 'forge-config-once.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const bad of ['.credentials.json', 'accessToken', 'fetch(', 'https.request', "require('https')", "require('http')", "require('net')"]) assert.ok(!src.includes(bad), f + ' contains ' + bad);
  }
});
t('runtime: a sentinel login file in the temp home never shows up in any command output', () => {
  const fx = fixture();
  const SENTINEL = 'SENTINEL-' + Math.random().toString(36).slice(2) + '-must-never-print';
  fs.writeFileSync(path.join(fx.home, '.credentials.json'), JSON.stringify({ secret: SENTINEL }));
  const runs = [['list', '--all', '--json'], ['list', '--all', '--lang', 'nl'], ['get', 'usage-guard'], ['explain', 'usage-guard', '--json'], ['set', 'usage-guard', 'on'],
    ['diff', '--mark-seen'], ['set', 'usage-guard.pause-at', '97'], ['diff', '--json'], ['parse', 'usage guard aan'], ['unset', 'usage-guard'], ['reset', '--global', '--yes']];
  for (const args of runs) assert.ok(!cli(fx, args).all.includes(SENTINEL), args.join(' '));
});
t('runtime: no module call ever opens a file named .credentials.json', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.home, '.credentials.json'), '{}');
  const seen = [];
  const orig = { readFileSync: fs.readFileSync, openSync: fs.openSync, statSync: fs.statSync, existsSync: fs.existsSync };
  for (const n of Object.keys(orig)) fs[n] = function (p) { seen.push(String(p)); return orig[n].apply(fs, arguments); };
  try {
    cfg.list(withOpts(fx, { all: true }));
    cfg.set('usage-guard', 'on', fx.o);
    cfg.explain('usage-guard', fx.o);
    cfg.diff(withOpts(fx, { markSeen: true }));
    cfg.parseSentence('usage guard uit', fx.o);
  } finally { Object.assign(fs, orig); }
  assert.ok(seen.length > 0, 'the spy saw reads');
  assert.deepStrictEqual(seen.filter((p) => path.basename(p) === '.credentials.json'), []);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n8) CLI exit codes');
t('list 0 · malformed 2 · --flag locked 3 · --flag bogus 2 · bad --lang 2 · unknown option 2', () => {
  const fx = fixture();
  assert.strictEqual(cli(fx, ['list']).status, 0);
  assert.strictEqual(cli(fx, ['list', '--flag', 'hard-gates=off']).status, 3);
  assert.strictEqual(cli(fx, ['list', '--flag', 'nope=1']).status, 2);
  assert.strictEqual(cli(fx, ['list', '--flag', 'novalue']).status, 2);
  assert.strictEqual(cli(fx, ['list', '--lang', 'fr']).status, 2);
  assert.strictEqual(cli(fx, ['list', '--bogus']).status, 2);
  fs.writeFileSync(fx.projectFile, '{ broken');
  const r = cli(fx, ['list']);
  assert.strictEqual(r.status, 2);
  assert.ok(r.err.includes('.claude/FORGE_CONFIG.json'), r.err);
});
t('get 0 · unknown 1 · missing key 2 · locked id 0 (explained, not an error)', () => {
  const fx = fixture();
  assert.strictEqual(cli(fx, ['get', 'nvidia']).status, 0);
  assert.strictEqual(cli(fx, ['get', 'nvidiaa']).status, 1);
  assert.strictEqual(cli(fx, ['get']).status, 2);
  assert.strictEqual(cli(fx, ['get', 'hard-gates']).status, 0);
});
t('set 0 · invalid 2 · unknown 2 · missing value 2 · locked 3 (also without a value) — bytes unchanged on refusal', () => {
  const fx = fixture();
  assert.strictEqual(cli(fx, ['set', 'nvidia', 'uit']).status, 0);
  const before = bytes(fx.projectFile);
  assert.strictEqual(cli(fx, ['set', 'nvidia', 'misschien']).status, 2);
  assert.strictEqual(cli(fx, ['set', 'nvidiaa', 'uit']).status, 2);
  assert.strictEqual(cli(fx, ['set', 'nvidia']).status, 2);
  assert.strictEqual(cli(fx, ['set', 'hard-gates', 'off']).status, 3);
  assert.strictEqual(cli(fx, ['set', 'git-push']).status, 3);
  assert.strictEqual(bytes(fx.projectFile), before);
});
t('unset 0 · unknown 2 · locked 3; reset without --yes 3 · with --yes 0; explain 0 · unknown 1', () => {
  const fx = fixture();
  assert.strictEqual(cli(fx, ['unset', 'nvidia']).status, 0);
  assert.strictEqual(cli(fx, ['unset', 'nvidiaa']).status, 2);
  assert.strictEqual(cli(fx, ['unset', 'usage-limit']).status, 3);
  cli(fx, ['set', 'council', 'off']);
  assert.strictEqual(cli(fx, ['reset']).status, 3);
  assert.strictEqual(readJson(fx.projectFile).settings.council.value, 'off');
  assert.strictEqual(cli(fx, ['reset', '--yes']).status, 0);
  assert.deepStrictEqual(readJson(fx.projectFile).settings, {});
  assert.strictEqual(cli(fx, ['explain', 'council']).status, 0);
  assert.strictEqual(cli(fx, ['explain', 'councill']).status, 1);
});
t('diff: first run 0 (prints "instellingen geladen (n)") · change 3 · no change 0 · --run stub logs once', () => {
  const fx = fixture();
  const first = cli(fx, ['diff', '--mark-seen', '--lang', 'nl']);
  assert.deepStrictEqual([first.status, first.out.trim()], [0, 'instellingen geladen (' + KEYS.length + ')']);
  cli(fx, ['set', 'council', 'off']);
  assert.strictEqual(cli(fx, ['diff']).status, 3);
  const dash = path.join(fx.proj, '.claude', 'forge-dashboard');
  fs.mkdirSync(dash, { recursive: true });
  const stub = stubLogEvent(dash, 0);
  fs.renameSync(stub.p, path.join(dash, 'log-event.cjs'));
  const d = cli(fx, ['diff', '--run', 'cli-run-1', '--mark-seen', '--lang', 'en']);
  assert.strictEqual(d.status, 3, d.all);
  assert.ok(d.out.includes('Logged as config_changed in run cli-run-1.'), d.out);
  assert.strictEqual(stub.calls().length, 1);
  assert.strictEqual(cli(fx, ['diff']).status, 0);
  assert.strictEqual(cli(fx, ['diff', '--run', 'bad id']).status, 2);
});
t('parse 0 · ambiguous 3 · no match 3 · no value 3 · locked 3 · empty 2', () => {
  const fx = fixture();
  assert.strictEqual(cli(fx, ['parse', 'zet', 'nvidia', 'uit']).status, 0);
  const amb = cli(fx, ['parse', 'zet memory en nvidia uit', '--json']);
  assert.strictEqual(amb.status, 3);
  assert.strictEqual(JSON.parse(amb.out).reason, 'ambiguous');
  assert.strictEqual(cli(fx, ['parse', 'ik wil iets anders']).status, 3);
  assert.strictEqual(JSON.parse(cli(fx, ['parse', 'zet autonomie', '--json']).out).reason, 'no_value');
  assert.strictEqual(JSON.parse(cli(fx, ['parse', 'zet git push aan', '--json']).out).reason, 'locked');
  assert.strictEqual(cli(fx, ['parse']).status, 2);
});
t('--help on every command exits 0 and names the command; no command 2; unknown command 2', () => {
  const fx = fixture();
  for (const c of Object.keys(text.USAGE)) {
    const r = cli(fx, [c, '--help']);
    assert.strictEqual(r.status, 0, c);
    assert.ok(r.out.includes('/forge config ' + text.USAGE[c]), c);
  }
  assert.strictEqual(cli(fx, ['--help']).status, 0);
  assert.strictEqual(cli(fx, []).status, 2);
  assert.strictEqual(cli(fx, ['frobnicate']).status, 2);
});

t('forge-config-cli.cjs run directly behaves exactly like forge-config.cjs (same output, same exit codes)', () => {
  const fx = fixture();
  const env = Object.assign({}, process.env, { FORGE_CONFIG_HOME: fx.home, FORGE_PROJECT_ROOT: fx.proj, HOME: fx.home, USERPROFILE: fx.home });
  const direct = (args) => { const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-config-cli.cjs'), ...args], { encoding: 'utf8', env }); return { status: r.status, out: r.stdout || '' }; };
  const a = cli(fx, ['list', '--all', '--json']);
  const b = direct(['list', '--all', '--json']);
  assert.deepStrictEqual([b.status, b.out], [a.status, a.out]);
  assert.strictEqual(direct(['set', 'hard-gates', 'off']).status, 3);
  assert.strictEqual(direct(['get', 'nvidiaa']).status, 1);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n10) ecc-full-test bridge (.claude/FORGE_ECC_MODE.json ecc_full_test_mode)');
const LEGACY_SHAPE = { ecc_normal_mode: 'on', ecc_full_test_mode: 'off', project_isolation: 'on', heavy_security_gates: 'off', global_unblock: 'off', notes: 'keep me' };
const eccFile = (fx) => path.join(fx.proj, '.claude', 'FORGE_ECC_MODE.json');
const tmpLeft = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
t('schema declares the bridge this code mirrors (ecc-full-test -> .claude/FORGE_ECC_MODE.json:ecc_full_test_mode)', () => {
  assert.strictEqual(RAW.settings['ecc-full-test'].bridge, '.claude/FORGE_ECC_MODE.json:ecc_full_test_mode');
});
t('set on / set off write "on" / "off" into the legacy file, every other key preserved, no temp file left', () => {
  const fx = fixture();
  writeJson(eccFile(fx), LEGACY_SHAPE);
  const R = cfg.set('ecc-full-test', 'on', fx.o);
  assert.deepStrictEqual([R.bridge.value, R.bridge.written, R.bridge.agrees, R.bridge.notes], ['on', true, true, []]);
  assert.deepStrictEqual(readJson(eccFile(fx)), Object.assign({}, LEGACY_SHAPE, { ecc_full_test_mode: 'on' }));
  assert.deepStrictEqual(Object.keys(readJson(eccFile(fx))), Object.keys(LEGACY_SHAPE), 'key order changed');
  cfg.set('ecc-full-test', 'uit', fx.o);
  assert.strictEqual(readJson(eccFile(fx)).ecc_full_test_mode, 'off');
  assert.deepStrictEqual(tmpLeft(path.join(fx.proj, '.claude')), []);
});
t('unset ecc-full-test writes the value it falls back to (the default: "off")', () => {
  const fx = fixture();
  writeJson(eccFile(fx), LEGACY_SHAPE);
  cfg.set('ecc-full-test', 'on', fx.o);
  const U = cfg.unset('ecc-full-test', fx.o);
  assert.deepStrictEqual([U.removed, U.to, U.bridge.value, U.bridge.written], [true, false, 'off', true]);
  assert.strictEqual(readJson(eccFile(fx)).ecc_full_test_mode, 'off');
});
t('a missing legacy file is not created for the default ("off"), and is created with only the field for "on"', () => {
  const fx = fixture();
  const R = cfg.set('ecc-full-test', 'off', fx.o);
  assert.deepStrictEqual([R.bridge.written, fs.existsSync(eccFile(fx))], [false, false]);
  cfg.set('ecc-full-test', 'on', fx.o);
  assert.deepStrictEqual(readJson(eccFile(fx)), { ecc_full_test_mode: 'on' });
});
t('a damaged legacy file refuses set AND unset (exit 2) and nothing is written anywhere', () => {
  const fx = fixture();
  fs.writeFileSync(eccFile(fx), '{ not json');
  const before = { ecc: bytes(eccFile(fx)), proj: bytes(fx.projectFile) };
  throwsCode(() => cfg.set('ecc-full-test', 'on', fx.o), 'malformed', 2);
  assert.deepStrictEqual({ ecc: bytes(eccFile(fx)), proj: bytes(fx.projectFile) }, before);
  writeJson(fx.projectFile, { version: 1, settings: { 'ecc-full-test': { value: true } } });
  const before2 = { ecc: bytes(eccFile(fx)), proj: bytes(fx.projectFile) };
  throwsCode(() => cfg.unset('ecc-full-test', fx.o), 'malformed', 2);
  throwsCode(() => cfg.reset(withOpts(fx, { yes: true })), 'malformed', 2);
  assert.deepStrictEqual({ ecc: bytes(eccFile(fx)), proj: bytes(fx.projectFile) }, before2);
});
t('get ecc-full-test: a note (nl + en) when the legacy file disagrees; none once they agree', () => {
  const fx = fixture();
  writeJson(eccFile(fx), Object.assign({}, LEGACY_SHAPE, { ecc_full_test_mode: 'on' }));
  const G = cfg.get('ecc-full-test', withOpts(fx, { lang: 'en' }));
  assert.deepStrictEqual([G.value, G.bridge.agrees, G.bridge.legacy, G.notes.length], [false, false, 'on', 1]);
  assert.ok(G.notes[0].includes('.claude/FORGE_ECC_MODE.json ecc_full_test_mode') && G.notes[0].includes('/forge config set ecc-full-test off'), G.notes[0]);
  const Gnl = cfg.get('ecc-full-test', withOpts(fx, { lang: 'nl' }));
  assert.ok(/^Let op: /.test(Gnl.notes[0]) && Gnl.notes[0].includes('/forge config set ecc-full-test uit'), Gnl.notes[0]);
  assert.ok(cfg.list(withOpts(fx, { lang: 'en' })).notes.includes(G.notes[0]), 'list does not carry the note');
  assert.ok(cfg.explain('ecc-full-test', withOpts(fx, { lang: 'en' })).notes.includes(G.notes[0]), 'explain does not carry the note');
  cfg.set('ecc-full-test', 'off', fx.o);
  const G2 = cfg.get('ecc-full-test', fx.o);
  assert.deepStrictEqual([G2.bridge.agrees, G2.notes], [true, []]);
});
t('the ECC_TEST_MODE.md marker forces the legacy reader ON: get names the marker file while the setting is off', () => {
  const fx = fixture();
  writeJson(eccFile(fx), LEGACY_SHAPE);
  fs.writeFileSync(path.join(fx.proj, '.claude', 'ECC_TEST_MODE.md'), 'opt-in marker' + String.fromCharCode(10));
  const G = cfg.get('ecc-full-test', withOpts(fx, { lang: 'en' }));
  assert.deepStrictEqual([G.bridge.marker, G.bridge.agrees], [true, false]);
  assert.ok(G.notes[0].includes('.claude/ECC_TEST_MODE.md'), G.notes[0]);
  cfg.set('ecc-full-test', 'on', fx.o);
  assert.deepStrictEqual(cfg.get('ecc-full-test', fx.o).notes, [], 'marker + on agree');
});
t('a key without a bridge keeps its get() shape (no bridge / notes fields)', () => {
  const fx = fixture();
  const G = cfg.get('council', fx.o);
  assert.ok(!('bridge' in G) && !('notes' in G), Object.keys(G).join(','));
  assert.strictEqual(cfg.set('council', 'off', fx.o).bridge, null);
});
t('--global under a project value mirrors the EFFECTIVE value; reset --yes re-mirrors what remains', () => {
  const fx = fixture();
  writeJson(eccFile(fx), LEGACY_SHAPE);
  cfg.set('ecc-full-test', 'off', fx.o); // project value
  const R = cfg.set('ecc-full-test', 'on', withOpts(fx, { global: true }));
  assert.deepStrictEqual([R.entry.value, R.bridge.value], [false, 'off'], 'the shadowed global value must not leak into the legacy file');
  cfg.set('ecc-full-test', 'on', fx.o);
  assert.strictEqual(readJson(eccFile(fx)).ecc_full_test_mode, 'on');
  const X = cfg.reset(withOpts(fx, { yes: true }));
  assert.deepStrictEqual(X.bridges.map((b) => [b.value, b.written]), [['on', false]], 'the global "on" now applies');
  cfg.unset('ecc-full-test', withOpts(fx, { global: true }));
  assert.strictEqual(readJson(eccFile(fx)).ecc_full_test_mode, 'off');
});
t('seam opts.bridgePaths redirects the legacy write; the default location is left alone', () => {
  const fx = fixture();
  const alt = path.join(fx.root, 'alt-ecc.json');
  writeJson(alt, LEGACY_SHAPE);
  cfg.set('ecc-full-test', 'on', withOpts(fx, { bridgePaths: { 'ecc-full-test': alt } }));
  assert.deepStrictEqual([readJson(alt).ecc_full_test_mode, fs.existsSync(eccFile(fx))], ['on', false]);
});
t('CLI: set ecc-full-test on exits 0 and updates the legacy file; get --json carries the bridge status', () => {
  const fx = fixture();
  writeJson(eccFile(fx), LEGACY_SHAPE);
  const r = cli(fx, ['set', 'ecc-full-test', 'on', '--lang', 'en']);
  assert.strictEqual(r.status, 0, r.all);
  assert.strictEqual(readJson(eccFile(fx)).ecc_full_test_mode, 'on');
  const g = cli(fx, ['get', 'ecc-full-test', '--json']);
  const j = JSON.parse(g.out);
  assert.deepStrictEqual([g.status, j.value, j.bridge.agrees, j.notes], [0, true, true, []]);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n11) diff --run through the REAL log-event.cjs (fixture project, never this repo\'s forge-runs)');
function realWriterFixture() {
  const fx = fixture();
  const dash = path.join(fx.proj, '.claude', 'forge-dashboard');
  fs.mkdirSync(dash, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(dash, 'log-event.cjs'));
  const reg = path.join(fx.proj, '.claude', 'config', 'agents');
  fs.mkdirSync(reg, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(reg, 'agent-registry.json'));
  return fx;
}
const runEvents = (fx, run) => {
  const p = path.join(fx.proj, '.claude', 'forge-runs', run, 'events.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
};
t('a change logs exactly ONE config_changed line (changed[], count, no UNKNOWN-TYPE stamp) and is then marked seen', () => {
  const fx = realWriterFixture();
  const run = 'cfg-real-writer-1';
  cfg.markSeen(fx.o);
  cfg.set('usage-guard.pause-at', '97', withOpts(fx, { global: true }));
  const D = cfg.diff(withOpts(fx, { run, markSeen: true, lang: 'en' }));
  assert.deepStrictEqual([D.logged, D.status, D.seen_marked], [true, 0, true], D.stderr);
  assert.ok(!/UNKNOWN-TYPE|STRICT REFUSED/.test(D.stdout + D.stderr), D.stdout + D.stderr);
  const evs = runEvents(fx, run).filter((e) => e.event_type === 'config_changed');
  assert.strictEqual(evs.length, 1, 'config_changed lines: ' + evs.length);
  const ev = evs[0];
  assert.deepStrictEqual([ev.count, ev.changed.length, ev.changed[0].key, ev.changed[0].from, ev.changed[0].to, ev.changed[0].source], [1, 1, 'usage-guard.pause-at', 98, 97, 'global']);
  assert.ok(!ev._forge_verify || !ev._forge_verify.event_type_unknown, JSON.stringify(ev._forge_verify));
  assert.ok(ev.note.includes('usage-guard.pause-at: 98 -> 97'), ev.note);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'forge-runs', run)), 'leaked into this repo\'s forge-runs');
});
t('no change -> no event at all (still exactly one line after a second diff --run)', () => {
  const fx = realWriterFixture();
  const run = 'cfg-real-writer-2';
  cfg.markSeen(fx.o);
  const D0 = cfg.diff(withOpts(fx, { run }));
  assert.deepStrictEqual([D0.changed.length, D0.logged, runEvents(fx, run).length], [0, false, 0]);
  cfg.set('council', 'off', fx.o);
  cfg.diff(withOpts(fx, { run, markSeen: true }));
  const D2 = cfg.diff(withOpts(fx, { run, markSeen: true }));
  assert.deepStrictEqual([D2.changed.length, D2.logged], [0, false]);
  assert.strictEqual(runEvents(fx, run).filter((e) => e.event_type === 'config_changed').length, 1);
});
t('CLI diff --run --mark-seen logs through the real writer (exit 3), then diff is empty (exit 0)', () => {
  const fx = realWriterFixture();
  const run = 'cfg-real-writer-3';
  cfg.markSeen(fx.o);
  cfg.set('usage-guard.pause-at', '96', withOpts(fx, { global: true }));
  const a = cli(fx, ['diff', '--run', run, '--mark-seen', '--lang', 'en']);
  assert.strictEqual(a.status, 3, a.all);
  assert.strictEqual(runEvents(fx, run).filter((e) => e.event_type === 'config_changed').length, 1, a.all);
  const b = cli(fx, ['diff', '--json']);
  const j = JSON.parse(b.out);
  assert.deepStrictEqual([b.status, j.changed.length, j.first_run], [0, 0, false], b.all);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n12) safeGet — fail-SAFE reads for consumers (review-boss M3)');
const FLAGGED_KEYS = KEYS.filter((k) => (RAW.settings[k].flags || []).length);
t('FAILSAFE_FLAGGED names exactly the schema\'s flagged keys, each at its computed safe value', () => {
  assert.deepStrictEqual(Object.keys(cfg.FAILSAFE_FLAGGED).sort(), FLAGGED_KEYS.slice().sort());
  for (const k of FLAGGED_KEYS) assert.strictEqual(cfg.FAILSAFE_FLAGGED[k], cfg.safeValueOf(RAW.settings[k]), k);
  assert.deepStrictEqual([cfg.FAILSAFE_FLAGGED.nvidia, cfg.FAILSAFE_FLAGGED['codex-review'], cfg.FAILSAFE_FLAGGED.cleanup], [false, 'off', 'report']);
});
t('a readable config: safeGet = get, degraded:false (an owner OFF stays off, the default stays on)', () => {
  const fx = fixture();
  writeJson(fx.projectFile, { version: 1, settings: { nvidia: { value: false } } });
  const n = cfg.safeGet('nvidia', fx.o);
  assert.deepStrictEqual([n.value, n.source, n.degraded, n.reason], [false, 'project', false, null]);
  assert.deepStrictEqual([cfg.safeGet('snapshots', fx.o).value, cfg.safeGet('snapshots', fx.o).degraded], [true, false]);
});
t('a MALFORMED FORGE_CONFIG.json: flagged nvidia -> false + degraded; unflagged snapshots -> its default true + degraded', () => {
  const fx = fixture();
  fs.writeFileSync(fx.projectFile, '{ "settings": ');
  const n = cfg.safeGet('nvidia', withOpts(fx, { lang: 'en' }));
  assert.strictEqual(n.value, false);
  assert.strictEqual(n.degraded, true);
  assert.strictEqual(n.source, 'safe-fallback');
  assert.ok(/damaged/.test(n.reason) && /nvidia = off/.test(n.reason) && /reset --yes/.test(n.reason) && !/\n/.test(n.reason), n.reason);
  const s = cfg.safeGet('snapshots', withOpts(fx, { lang: 'en' }));
  assert.deepStrictEqual([s.value, s.degraded, s.source], [true, true, 'default']);
  assert.ok(/its default/.test(s.reason), s.reason);
  for (const k of FLAGGED_KEYS) assert.strictEqual(cfg.safeGet(k, fx.o).value, cfg.safeValueOf(RAW.settings[k]), k);
  assert.throws(() => cfg.get('nvidia', fx.o), /damaged/, 'get itself stays fail-closed');
});
t('a damaged GLOBAL file points at reset --global --yes; safeGet never writes anything', () => {
  const fx = fixture();
  fs.writeFileSync(fx.globalFile, '{"version":1,"settings":{"usage-guard":{"value":"banana"}}}');
  const gb = bytes(fx.globalFile);
  const u = cfg.safeGet('usage-guard', withOpts(fx, { lang: 'en' }));
  assert.deepStrictEqual([u.value, u.degraded], [false, true]);
  assert.ok(/reset --global --yes/.test(u.reason), u.reason);
  assert.strictEqual(bytes(fx.globalFile), gb);
  assert.strictEqual(fs.existsSync(fx.projectFile), false);
});
t('an unreadable schema: flagged keys still come back safe (FAILSAFE_FLAGGED), others take opts.fallback', () => {
  const fx = fixture();
  const o = withOpts(fx, { schemaPath: path.join(fx.root, 'no-such-schema.json') });
  const c = cfg.safeGet('codex-review', o);
  assert.deepStrictEqual([c.value, c.degraded], ['off', true]);
  assert.deepStrictEqual([cfg.safeGet('mcp', o).value, cfg.safeGet('tool-log', Object.assign({ fallback: true }, o)).value], [false, true]);
  assert.strictEqual(cfg.safeGet('tool-log', o).value, undefined, 'no schema and no fallback: nothing invented');
});
t('safeGet never throws: an unknown key, a locked id, an internal error', () => {
  const fx = fixture();
  assert.deepStrictEqual([cfg.safeGet('nvidiaa', fx.o).degraded, cfg.safeGet('nvidiaa', Object.assign({ fallback: 1 }, fx.o)).value], [true, 1]);
  assert.strictEqual(cfg.safeGet('hard-gates', fx.o).degraded, true);
  const bad = cfg.safeGet('nvidia', withOpts(fx, { flags: 'not-a-list' }));
  assert.deepStrictEqual([bad.value, bad.degraded], [false, true]);
});
t('CLI stays fail-closed: get nvidia on a malformed file exits 2 with the plain message', () => {
  const fx = fixture();
  fs.writeFileSync(fx.projectFile, '{ broken');
  const r = cli(fx, ['get', 'nvidia', '--lang', 'en']);
  assert.strictEqual(r.status, 2, r.all);
  assert.ok(/The file \.claude\/FORGE_CONFIG\.json is damaged/.test(r.err), r.err);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n13) one-off approval: set gate-hook off --once "<owner quote>" (10 min, project file only)');
const T0 = Date.parse('2026-09-24T12:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
t('--once writes value false + set_at + set_by + once_quote + expires_at = now + 10 min into the PROJECT file; get shows off + a note', () => {
  const fx = fixture();
  const R = cfg.set('gate-hook', 'off', withOpts(fx, { once: '  ja,  verwijder\tdie map ', now: at(0), lang: 'en' }));
  const e = readJson(fx.projectFile).settings['gate-hook'];
  assert.deepStrictEqual(e, { value: false, set_at: at(0), set_by: 'owner one-off approval: ja, verwijder die map', once_quote: 'ja, verwijder die map', expires_at: at(10 * 60000), consumed_at: null, consumed_command_sha256: null });
  assert.strictEqual(fs.existsSync(fx.globalFile), false, 'never the global file');
  assert.deepStrictEqual([R.to, R.once.minutes, R.once.quote], [false, 10, 'ja, verwijder die map']);
  const G = cfg.get('gate-hook', withOpts(fx, { now: at(3 * 60000), lang: 'en' }));
  assert.deepStrictEqual([G.value, G.source, G.expires_at], [false, 'project', at(10 * 60000)]);
  assert.ok(G.notes.length === 1 && /one-off approval/.test(G.notes[0]) && /7 min/.test(G.notes[0]), JSON.stringify(G.notes));
  assert.ok(/OFF for one command only/.test(text.renderSet(R, 'en')), text.renderSet(R, 'en'));
});
t('expiry: after 10 min get/list/resolve/safeGet treat it as absent (gate-hook ON again) and say "one-off approval expired, back on"', () => {
  const fx = fixture();
  cfg.set('gate-hook', 'off', withOpts(fx, { once: 'yes do it', now: at(0) }));
  const late = withOpts(fx, { now: at(10 * 60000 + 1), lang: 'en' });
  const G = cfg.get('gate-hook', late);
  assert.deepStrictEqual([G.value, G.source], [true, 'default']);
  assert.ok(G.notes.some((n) => /one-off approval expired, back on/.test(n)), JSON.stringify(G.notes));
  assert.ok(cfg.list(late).notes.some((n) => /one-off approval expired, back on/.test(n)));
  assert.ok(cfg.list(withOpts(fx, { now: at(10 * 60000 + 1), lang: 'nl' })).notes.some((n) => /expired, back on/.test(n)), 'nl carries the same marker');
  assert.strictEqual(cfg.resolve(late).settings['gate-hook'].value, true);
  const S = cfg.safeGet('gate-hook', late);
  assert.deepStrictEqual([S.value, S.source, S.degraded], [true, 'default', false]);
  assert.ok(cfg.get('gate-hook', withOpts(fx, { now: at(10 * 60000 - 1) })).value === false, 'still off one millisecond before expiry');
  const broken = fixture();
  writeJson(broken.projectFile, { version: 1, settings: { 'gate-hook': { value: false, expires_at: 'not a time' } } });
  assert.strictEqual(cfg.get('gate-hook', broken.o).value, true, 'an unparseable expires_at never keeps the gate off');
});
t('set gate-hook on clears the one-off (entry removed, nothing permanent left); a permanent off replaces it', () => {
  const fx = fixture();
  cfg.set('gate-hook', 'off', withOpts(fx, { once: 'ja', now: at(0) }));
  const R = cfg.set('gate-hook', 'on', withOpts(fx, { now: at(60000), lang: 'en' }));
  assert.strictEqual(R.cleared_once, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(readJson(fx.projectFile).settings, 'gate-hook'), 'the one-off entry is gone');
  assert.deepStrictEqual([cfg.get('gate-hook', fx.o).value, cfg.get('gate-hook', fx.o).source], [true, 'default']);
  assert.ok(/on/.test(text.renderSet(R, 'en')) && /cleared/.test(text.renderSet(R, 'en')), text.renderSet(R, 'en'));
  cfg.set('gate-hook', 'off', withOpts(fx, { once: 'ja', now: at(0) }));
  cfg.set('gate-hook', 'off', withOpts(fx, { now: at(60000) }));
  const e = readJson(fx.projectFile).settings['gate-hook'];
  assert.deepStrictEqual([e.value, Object.prototype.hasOwnProperty.call(e, 'expires_at')], [false, false], 'a normal set writes a permanent value');
});
t('diff reports the one-off as a change: gate-hook: on -> off (one-off, 10 min, <quote>)', () => {
  const fx = fixture();
  cfg.markSeen(withOpts(fx, { now: at(0) }));
  cfg.set('gate-hook', 'off', withOpts(fx, { once: 'ja, doe het', now: at(0) }));
  const D = cfg.diff(withOpts(fx, { now: at(60000), lang: 'en' }));
  assert.strictEqual(D.changed.length, 1);
  assert.strictEqual(D.changed[0].expires_at, at(10 * 60000));
  assert.strictEqual(D.lines[0], 'gate-hook: on → off (one-off, 10 min, ja, doe het)');
  const nl = cfg.diff(withOpts(fx, { now: at(60000), lang: 'nl' }));
  assert.strictEqual(nl.lines[0], 'gate-hook: aan → uit (eenmalig, 10 min, ja, doe het)');
});
t('--once is refused (exit 2, nothing written) for another key, --global, a value other than off, or no quote', () => {
  const fx = fixture();
  throwsCode(() => cfg.set('nvidia', 'off', withOpts(fx, { once: 'ja' })), 'usage', 2);
  throwsCode(() => cfg.set('gate-hook', 'off', withOpts(fx, { once: 'ja', global: true })), 'usage', 2);
  throwsCode(() => cfg.set('gate-hook', 'on', withOpts(fx, { once: 'ja' })), 'usage', 2);
  throwsCode(() => cfg.set('gate-hook', 'off', withOpts(fx, { once: '   ' })), 'usage', 2);
  throwsCode(() => cfg.set('hard-gates', 'off', withOpts(fx, { once: 'ja' })), 'locked', 3);
  assert.deepStrictEqual([fs.existsSync(fx.projectFile), fs.existsSync(fx.globalFile)], [false, false]);
});
t('CLI: set gate-hook off --once "<quote>" exits 0; --once elsewhere or on another key exits 2', () => {
  const fx = fixture();
  const ok = cli(fx, ['set', 'gate-hook', 'off', '--once', 'ja, verwijder de build-map', '--lang', 'en']);
  assert.strictEqual(ok.status, 0, ok.all);
  assert.ok(/OFF for one command only/.test(ok.out), ok.out);
  assert.strictEqual(readJson(fx.projectFile).settings['gate-hook'].set_by, 'owner one-off approval: ja, verwijder de build-map');
  assert.strictEqual(cli(fx, ['set', 'nvidia', 'off', '--once', 'ja']).status, 2);
  assert.strictEqual(cli(fx, ['get', 'gate-hook', '--once', 'ja']).status, 2);
  assert.strictEqual(cli(fx, ['set', 'gate-hook', 'off', '--once', 'ja', '--global']).status, 2);
  const bare = cli(fx, ['set', 'gate-hook', 'off', '--lang', 'en', '--once']);
  const empty = cli(fx, ['set', 'gate-hook', 'off', '--once', '', '--lang', 'en']);
  for (const r of [bare, empty]) assert.deepStrictEqual([r.status, /exact words of approval/.test(r.err)], [2, true], r.all);
  const noKey = cli(fx, ['set', 'council', 'off', '--once', 'ja', '--json']);
  assert.deepStrictEqual([noKey.status, JSON.parse(noKey.out).error.code], [2, 'usage'], noKey.all);
  assert.strictEqual(readJson(fx.projectFile).settings['gate-hook'].once_quote, 'ja, verwijder de build-map', 'refused calls wrote nothing');
  const g = cli(fx, ['get', 'gate-hook', '--lang', 'en']);
  assert.ok(/^gate-hook = off \[project\]/.test(g.out) && /one-off approval/.test(g.out), g.out);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n14) Codex recheck 2026-09-24 (CFG-02 .. CFG-10)');

t('CFG-02: a persisted file must hold the CANONICAL type — "false"/0/"off"/[0]/["false"] for a bool are DAMAGE, not a value', () => {
  const fx = fixture();
  for (const bad of ['false', 0, 'off', [0], ['false']]) {
    const f = fixture();
    writeJson(f.projectFile, { version: 1, settings: { nvidia: { value: bad } } });
    const before = bytes(f.projectFile);
    throwsCode(() => cfg.resolve(f.o), 'malformed', 2);
    throwsCode(() => cfg.set('council', 'off', f.o), 'malformed', 2);
    assert.strictEqual(bytes(f.projectFile), before, JSON.stringify(bad));
    assert.strictEqual(cfg.safeGet('nvidia', f.o).value, false, 'safeGet still degrades safely: ' + JSON.stringify(bad));
  }
  // A genuine canonical bool/enum stored value still reads straight through (no coercion needed there).
  writeJson(fx.projectFile, { version: 1, settings: { nvidia: { value: false }, council: { value: 'off' } } });
  const r = cfg.resolve(fx.o);
  assert.deepStrictEqual([r.settings.nvidia.value, r.settings.council.value], [false, 'off']);
  // CLI `set ... off` still coerces the STRING "off" at the input boundary and stores a real boolean.
  const before2 = fixture();
  cfg.set('nvidia', 'off', before2.o);
  assert.strictEqual(readJson(before2.projectFile).settings.nvidia.value, false);
});

t('CFG-03: a schema that fails validation is REJECTED IN FULL — safeGet never salvages a value from it, and honours the caller\'s own fallback', () => {
  const RAW2 = JSON.parse(JSON.stringify(RAW));
  RAW2.settings.cleanup = { type: 'enum', allowed: ['auto'], default: 'auto', scope: 'project', group: 'when-needed', flags: ['D'], consumers: ['x'], desc: { nl: 'x' } }; // missing desc.en -> invalid
  const fx = fixture();
  const sp = path.join(fx.root, 'bad-schema.json');
  writeJson(sp, RAW2);
  assert.ok(cfg.validateSchema(RAW2, GATES).length > 0, 'the fixture schema must actually be invalid');
  const g = cfg.safeGet('cleanup', withOpts(fx, { schemaPath: sp, fallback: 'report' }));
  assert.deepStrictEqual([g.value, g.degraded, g.source], ['report', true, 'safe-fallback'], 'never "auto" from the rejected schema');
  // An unflagged key with no FAILSAFE_FLAGGED entry falls back to the CALLER's own protective fallback, never
  // anything derived from the rejected schema's (also unvalidated) definition for that key.
  const n = cfg.safeGet('team-max', withOpts(fx, { schemaPath: sp, fallback: 1 }));
  assert.deepStrictEqual([n.value, n.degraded], [1, true]);
});

t('CFG-04: a global-scope BOOL project value may only STRENGTHEN a global protective default, never weaken it', () => {
  const fx = fixture();
  // global OFF, project ON (matches the schema default true) -> the project value WINS: strengthened.
  writeJson(fx.globalFile, { version: 1, settings: { 'usage-guard': { value: false } } });
  writeJson(fx.projectFile, { version: 1, settings: { 'usage-guard': { value: true } } });
  const r1 = cfg.resolve(withOpts(fx, { lang: 'en' }));
  assert.deepStrictEqual([r1.settings['usage-guard'].value, r1.settings['usage-guard'].source], [true, 'project']);
  assert.deepStrictEqual(r1.strengthened_project_values, ['usage-guard']);
  assert.deepStrictEqual(r1.ignored_project_values, []);
  assert.ok(r1.notes.some((n) => /can only STRENGTHEN/.test(n)), JSON.stringify(r1.notes));
  // global ON, project OFF (away from the default) -> still ignored, exactly as before.
  const fx2 = fixture();
  writeJson(fx2.globalFile, { version: 1, settings: { 'usage-guard': { value: true } } });
  writeJson(fx2.projectFile, { version: 1, settings: { 'usage-guard': { value: false } } });
  const r2 = cfg.resolve(withOpts(fx2, { lang: 'en' }));
  assert.deepStrictEqual([r2.settings['usage-guard'].value, r2.settings['usage-guard'].source], [true, 'global']);
  assert.deepStrictEqual(r2.ignored_project_values, ['usage-guard']);
  assert.deepStrictEqual(r2.strengthened_project_values, []);
});

t('CFG-08: gate-hook (ignore_global) is never read from the global file — a reset can never expose a hidden global OFF', () => {
  const fx = fixture();
  writeJson(fx.globalFile, { version: 1, settings: { 'gate-hook': { value: false } } });
  writeJson(fx.projectFile, { version: 1, settings: { 'gate-hook': { value: true } } });
  const r = cfg.resolve(withOpts(fx, { lang: 'en' }));
  assert.deepStrictEqual([r.settings['gate-hook'].value, r.settings['gate-hook'].source], [true, 'project']);
  assert.ok(r.notes.some((n) => /never read from there/.test(n)), JSON.stringify(r.notes));
  // Remove the project override (the normal reset path) -> falls back to the schema default (true), the
  // global "false" sitting underneath is NEVER exposed.
  cfg.reset(withOpts(fx, { yes: true }));
  assert.strictEqual(cfg.get('gate-hook', fx.o).value, true);
  // A --global write is refused outright: it would silently do nothing.
  throwsCode(() => cfg.set('gate-hook', 'off', withOpts(fx, { global: true })), 'usage', 2);
  assert.strictEqual(readJson(fx.globalFile).settings['gate-hook'].value, false, 'the refused call wrote nothing new');
});

t('CFG-05: parseFlagValue(key, raw) validates through the SAME schema parser, including bounds', () => {
  assert.strictEqual(cfg.parseFlagValue('usage-guard.pause-at', '95'), 95);
  for (const bad of ['1000', '49.5', 'abc', -1]) throwsCode(() => cfg.parseFlagValue('usage-guard.pause-at', bad), 'invalid_value', 2);
});

t('CFG-06: CLI get exits 3 (not 0) when a --flag names a DIFFERENT locked id than the requested key', () => {
  const fx = fixture();
  const r = cli(fx, ['get', 'gate-hook', '--flag', 'git-destructive=off', '--json']);
  assert.strictEqual(r.status, 3, r.all);
  assert.strictEqual(JSON.parse(r.out).error.code, 'locked');
  // The requested key itself being locked is still an informational exit 0.
  assert.strictEqual(cli(fx, ['get', 'hard-gates']).status, 0);
});

t('CFG-07/S06: setOnce stores consumed_at:null; consumeOnce() is a real single-use gate', () => {
  const fx = fixture();
  const at0 = '2026-09-24T12:00:00.000Z';
  cfg.set('gate-hook', 'off', withOpts(fx, { once: 'ja, doe het', now: at0 }));
  const stored = readJson(fx.projectFile).settings['gate-hook'];
  assert.deepStrictEqual([stored.consumed_at, stored.consumed_command_sha256], [null, null]);
  const now1 = withOpts(fx, { now: '2026-09-24T12:01:00.000Z', commandSha256: 'abc123' });
  const first = cfg.consumeOnce('gate-hook', now1);
  assert.deepStrictEqual(first, { ok: true });
  const after = readJson(fx.projectFile).settings['gate-hook'];
  assert.strictEqual(after.consumed_command_sha256, 'abc123');
  assert.ok(Date.parse(after.consumed_at) > 0);
  // Consumed: get()/resolve() are back to normal IMMEDIATELY, not after the timer.
  assert.strictEqual(cfg.get('gate-hook', now1).value, true);
  // A second consume (still well inside the 10-minute window) is refused — the exact "parallel requests
  // sharing one approval" evidence from the finding.
  const second = cfg.consumeOnce('gate-hook', now1);
  assert.deepStrictEqual(second, { ok: false, reason: 'consumed' });
  // No entry at all.
  assert.deepStrictEqual(cfg.consumeOnce('gate-hook', fixture().o), { ok: false, reason: 'absent' });
  // Expired (never consumed).
  const fx2 = fixture();
  cfg.set('gate-hook', 'off', withOpts(fx2, { once: 'ja', now: at0 }));
  assert.deepStrictEqual(cfg.consumeOnce('gate-hook', withOpts(fx2, { now: '2026-09-24T12:20:00.000Z' })), { ok: false, reason: 'expired' });
  // A set_at in the future relative to `now` is a clock problem, never an approval.
  const fx3 = fixture();
  writeJson(fx3.projectFile, { version: 1, settings: { 'gate-hook': { value: false, set_at: '2026-09-24T13:00:00.000Z', expires_at: '2026-09-24T13:10:00.000Z', once_quote: 'ja', consumed_at: null } } });
  assert.deepStrictEqual(cfg.consumeOnce('gate-hook', withOpts(fx3, { now: at0 })), { ok: false, reason: 'clock' });
});

t('CFG-07: re-issuing --once while an unconsumed one is still armed is refused (never silently extends the window)', () => {
  const fx = fixture();
  cfg.set('gate-hook', 'off', withOpts(fx, { once: 'ja', now: '2026-09-24T12:00:00.000Z' }));
  throwsCode(() => cfg.set('gate-hook', 'off', withOpts(fx, { once: 'nogmaals', now: '2026-09-24T12:09:00.000Z' })), 'usage', 2);
  const e = readJson(fx.projectFile).settings['gate-hook'];
  assert.deepStrictEqual([e.expires_at, e.once_quote], ['2026-09-24T12:10:00.000Z', 'ja'], 'the original entry is unchanged (no silent extension)');
  // Once consumed, a fresh --once may be armed again.
  cfg.consumeOnce('gate-hook', withOpts(fx, { now: '2026-09-24T12:01:00.000Z' }));
  const R = cfg.set('gate-hook', 'off', withOpts(fx, { once: 'opnieuw', now: '2026-09-24T12:02:00.000Z' }));
  assert.strictEqual(R.once.quote, 'opnieuw');
});

t('CFG-07: a hand-edited expires_at later than set_at + 10 min, or a set_at in the future, is treated as expired on read', () => {
  const fx = fixture();
  writeJson(fx.projectFile, { version: 1, settings: { 'gate-hook': { value: false, set_at: '2026-09-24T12:00:00.000Z', expires_at: '2026-09-24T23:00:00.000Z', once_quote: 'ja' } } });
  assert.strictEqual(cfg.get('gate-hook', withOpts(fx, { now: '2026-09-24T12:05:00.000Z' })).value, true, 'a tampered-forward expiry can never extend the window');
  const fx2 = fixture();
  writeJson(fx2.projectFile, { version: 1, settings: { 'gate-hook': { value: false, set_at: '2026-09-24T12:10:00.000Z', expires_at: '2026-09-24T12:20:00.000Z', once_quote: 'ja' } } });
  assert.strictEqual(cfg.get('gate-hook', withOpts(fx2, { now: '2026-09-24T12:05:00.000Z' })).value, true, 'a set_at in the future (clock rollback) is never trusted');
});

t('CFG-09: a stale/held lock on the target file is serialized, not clobbered — the delayed writer re-reads the fresh bytes', () => {
  const fx = fixture();
  cfg.set('council', 'off', fx.o); // an existing value the "other writer" will change while we hold the lock
  const lockPath = fx.projectFile + '.lock';
  fs.writeFileSync(lockPath, '999999'); // simulate another process mid-write
  // With a short timeout, a blocked writer must fail LOUD (never silently skip the lock and clobber).
  assert.throws(() => cfg.set('nvidia', 'off', withOpts(fx, { lockTimeoutMs: 50, lockPollMs: 5 })), /another process|lock/i);
  assert.strictEqual(readJson(fx.projectFile).settings.council.value, 'off', 'the blocked attempt wrote nothing');
  // The "other writer" finishes and releases the lock, having changed council in the meantime.
  writeJson(fx.projectFile, { version: 1, settings: { council: { value: 'auto' } } });
  fs.unlinkSync(lockPath);
  // Now the delayed writer succeeds AND re-reads the fresh bytes rather than a stale pre-lock snapshot.
  cfg.set('nvidia', 'off', withOpts(fx, { lockTimeoutMs: 2000 }));
  const d = readJson(fx.projectFile);
  assert.deepStrictEqual([d.settings.council.value, d.settings.nvidia.value], ['auto', false], 'both updates survive — nothing was lost');
});

t('CFG-09: a lock older than lockStaleMs is reclaimed instead of wedging forever', () => {
  const fx = fixture();
  const lockPath = fx.projectFile + '.lock';
  fs.writeFileSync(lockPath, '999999');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, old, old);
  cfg.set('council', 'off', withOpts(fx, { lockStaleMs: 1000, lockTimeoutMs: 2000, lockPollMs: 5 }));
  assert.strictEqual(readJson(fx.projectFile).settings.council.value, 'off');
});

t('CFG-10: atomicWriteJson leaves no temp file and the written bytes read back byte-identical after fsync', () => {
  const fx = fixture();
  cfg.set('council', 'off', fx.o);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(fx.projectFile)).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')), []);
  assert.strictEqual(readJson(fx.projectFile).settings.council.value, 'off');
});

// ---------------------------------------------------------------------------------------------------
console.log('\n9) hermeticity proof');
t('nothing landed in the trap dir (every call carried its own fixture paths)', () => {
  assert.strictEqual(fs.existsSync(path.join(TRAP, 'home', 'FORGE_CONFIG.json')), false);
  assert.strictEqual(fs.existsSync(path.join(TRAP, 'proj', '.claude', 'FORGE_CONFIG.json')), false);
  assert.strictEqual(fs.existsSync(path.join(TRAP, 'proj', '.claude', 'FORGE_ECC_MODE.json')), false);
});
t('the real ~/.claude/FORGE_CONFIG.json and this repo\'s .claude/FORGE_CONFIG.json + FORGE_ECC_MODE.json are untouched', () => {
  assert.strictEqual(sig(REAL_GLOBAL), REAL_BEFORE.g);
  assert.strictEqual(sig(REAL_PROJECT), REAL_BEFORE.p);
  assert.strictEqual(sig(REAL_ECC_MODE), REAL_BEFORE.e);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
