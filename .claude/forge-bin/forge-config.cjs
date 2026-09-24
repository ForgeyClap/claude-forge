#!/usr/bin/env node
'use strict';
/**
 * forge-config.cjs — the ONE resolver / validator / writer for every user-facing Forge setting (v2.7.0,
 * 2026-09-24). WHY: the owner wants beginners to see every setting with its value and a plain-language
 * explanation, change any of them with one command, and have Forge notice a change and act on it — with
 * everything ON by default (usage guard pausing at 98 %). The catalogue is
 * config/orchestration/FORGE_CONFIG_SCHEMA.json (keys, types, defaults, nl+en descriptions, disclosures,
 * consumers, locked items); THIS file is the only code that resolves, validates or writes it. Consumers
 * require() it as a soft sibling and degrade to the schema default when it is absent — the same
 * single-source discipline as hard-gates.json + forge-actiongate.cjs. Zero-dependency
 * (fs/path/os/crypto/child_process). The one-off (`--once`) state machine and the cross-process file lock
 * live in the sibling forge-config-once.cjs (Codex recheck 2026-09-24 — split out to keep this file a
 * readable size); see that file's header for the full one-off/lock contract.
 *
 * MODEL
 *   Files   global  <FORGE_CONFIG_HOME, else ~/.claude>/FORGE_CONFIG.json            (seams: opts.configHome, opts.globalPath)
 *           project <FORGE_PROJECT_ROOT, else two levels up>/.claude/FORGE_CONFIG.json (seams: opts.projectRoot, opts.projectPath)
 *           shape { "version": 1, "settings": { "<key>": { "value", "set_at", "set_by" } } }; unknown top-level
 *           keys survive every write. A MISSING file means "all defaults" (normal, noted). A PRESENT but
 *           malformed file (bad JSON, wrong shape, or a value that is not the setting's CANONICAL schema
 *           type — an exact boolean/enum-string/integer-in-range, never a CLI-style coercion like "false",
 *           0, "off" or [0], CFG-05-fix CFG-02) THROWS / exits 2 and nothing is written — never silently
 *           treated as "no settings" (fail-closed, like forge-prefs.cjs).
 *   Order   per-run flag (opts.flags / --flag k=v, never written) > project file > global file >
 *           product-default (owner-profile pref via forge-prefs.cjs, READ-ONLY, schema product_default_map)
 *           > schema default. A scope:"global" key ignores a project-file value with a visible note — EXCEPT
 *           a boolean project value that matches the schema's own default, which may only STRENGTHEN
 *           protection back to that default, never weaken a global ON (CFG-04). A setting with
 *           `ignore_global:true` (gate-hook) is project-scope-only for READS: a global-file value for it is
 *           never applied, only noted, and `set ... --global` on it is refused (CFG-08).
 *   Locked  schema.locked[] + forge-actiongate KNOWN_GATES + FORGE_AUTONOMY.json always_interrupt are never
 *           settable: set/unset/--flag on one exits 3 with file bytes unchanged; one found inside a file is
 *           ignored with a note; a schema whose settings collide with one is rejected as malformed.
 *   Changes diff() compares the current values with FORGE_SESSION_STATE.json.config_seen {hash, at, values}
 *           (seam opts.sessionStatePath); markSeen() merge-writes only that field. With a run id and a real
 *           change, diff() logs ONE config_changed event through the real log-event.cjs (never appends to
 *           events.jsonl itself) and marks the state seen only when that log succeeded, so a change is never
 *           dropped silently. Per-run flags are compared but never stored as "seen".
 *   Writes  atomic (a unique temp file in the same directory, fsynced, then renamed and the directory
 *           fsynced — best effort where the platform cannot fsync a directory, e.g. Windows, CFG-10) AND
 *           serialized per target file with forge-config-once.cjs's withLock (CFG-09): every writer
 *           re-reads the file only AFTER acquiring its lock, so two concurrent writers can never lose one
 *           another's update.
 *   Bridge  a bool setting whose schema entry carries "bridge": "<project-relative file>:<field>" (ecc-full-test ->
 *           .claude/FORGE_ECC_MODE.json:ecc_full_test_mode) is mirrored into that legacy file as "on"/"off" by
 *           set/unset/reset, other keys preserved; a damaged legacy file is refused before any write (exit 2).
 *           get/list/explain add a note when the legacy file (or its ECC_TEST_MODE.md marker) disagrees.
 *           Seam: opts.bridgePaths { key: file }.
 *   Privacy this file never opens the Claude account login file and makes no network calls; the usage-guard
 *           disclosure it prints is schema text.
 *   Safe    safeGet(key) is what CONSUMERS call (review-boss M3): it never throws, and when the settings cannot be
 *           read a key with a disclosure flag (C N X $ U D) comes back at its SAFE value (bool off; enum off /
 *           report / on-request) — never silently ON — with degraded:true and a plain reason. Both the flagged
 *           safe value and an unflagged key's fallback come from the immutable FAILSAFE_FLAGGED table or the
 *           caller's own opts.fallback — NEVER from a rejected schema's own (possibly invalid) default/allowed
 *           list (CFG-03). The CLI stays fail-closed (a damaged file still exits 2); `reset --yes` moves a
 *           damaged file aside as a backup.
 *   One-off `set gate-hook off --once "<owner's words>"` (ONCE_KEYS only, project file only) carries
 *           expires_at = now + 10 min, consumed_at:null; an expired OR consumed one-off counts as absent
 *           (noted), a normal `set` clears it, and consumeOnce() is the single atomic use (CFG-07/S06) —
 *           see forge-config-once.cjs. Re-issuing `--once` while an unconsumed one is still armed is refused.
 *
 * API  resolve, get, safeGet, list, set, unset, reset, explain, diff, markSeen, parseValue, parseFlagValue,
 *      consumeOnce, SCHEMA, DEFAULT_PATHS, LOCKED_IDS — plus helpers ConfigError, validateSchema, parseSentence,
 *      normLang, detectLang, safeValueOf, ONCE_KEYS, ONCE_MS, FAILSAFE_FLAGGED.
 * CLI  node .claude/forge-bin/forge-config.cjs <list|get|set|unset|reset|explain|diff|parse> ... (--help on each);
 *      the argv/output layer is forge-config-cli.cjs, the nl/en wording is forge-config-text.cjs.
 * Exit 0 ok · 1 not found (get/explain on an unknown key) · 2 usage / validation / malformed file (nothing
 *      written) · 3 act on this (diff found changes · reset without --yes · a locked id refused · parse
 *      ambiguous or unmatched).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const text = require('./forge-config-text.cjs');
// One-off approvals + the cross-process file lock live in forge-config-once.cjs (Codex recheck 2026-09-24,
// CFG-07/S06/CFG-09/CFG-10) so this file stays a readable size — see that file's header for the full
// contract. ONCE_KEYS/ONCE_MS stay exported here unchanged for existing consumers.
const onceLib = require('./forge-config-once.cjs');
const { ONCE_KEYS, ONCE_MS, ONCE_QUOTE_MAX } = onceLib;
// The at-most-once PENDING/CONSUMED grant store (V09 FIFTH fix, out-p11 + addendum) — split into its own
// sibling so forge-config-once.cjs stays under this project's file-size guidance; see that file's header.
const onceStore = require('./forge-config-once-store.cjs');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH_DEFAULT = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json');
const FILE_NAME = 'FORGE_CONFIG.json';
const TYPES = ['bool', 'int', 'number', 'enum', 'int-or-auto'];
const SCOPES = ['global', 'project'];
const FLAGS = ['C', 'N', '$', 'U', 'X', 'D'];
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const VERB_BOOL = { aanzetten: 'aan', inschakelen: 'aan', activeren: 'aan', uitzetten: 'uit', uitschakelen: 'uit', deactiveren: 'uit' };
// Fail-safe reads (review-boss M3): when the settings cannot be read, a key with a disclosure flag resolves to its
// SAFE value — bool false, an enum's first off-like word below, else its default. FAILSAFE_FLAGGED is the last resort
// when even the schema is unreadable; forge-config.test.cjs pins it to the schema's flagged keys.
const SAFE_ENUM_WORDS = ['off', 'report', 'on-request'];
const FAILSAFE_FLAGGED = { 'usage-guard': false, 'codex-review': 'off', nvidia: false, portfolio: false, mcp: false, paperclip: false, cleanup: 'report' };

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stripBom = (s) => s.replace(/^\ufeff/, '');

class ConfigError extends Error {
  constructor(code, message, exitCode, extra) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.exitCode = exitCode;
    if (extra) Object.assign(this, extra);
  }
}

// ---- paths (env read at call time, so a test or CI job can point everything at temp dirs) ----
function pathsFor(opts) {
  opts = opts || {};
  const root = path.resolve(opts.projectRoot || process.env.FORGE_PROJECT_ROOT || PROJECT_ROOT_DEFAULT);
  const home = path.resolve(opts.configHome || process.env.FORGE_CONFIG_HOME || path.join(os.homedir(), '.claude'));
  return {
    projectRoot: root,
    configHome: home,
    schema: opts.schemaPath || SCHEMA_PATH_DEFAULT,
    global: opts.globalPath || path.join(home, FILE_NAME),
    project: opts.projectPath || path.join(root, '.claude', FILE_NAME),
    sessionState: opts.sessionStatePath || path.join(root, '.claude', 'FORGE_SESSION_STATE.json'),
    setupMarker: opts.setupMarkerPath || path.join(root, '.claude', '.forge-setup.json'),
    logEvent: opts.logEventPath || path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'),
  };
}
function prettyPath(p, P) {
  const abs = path.resolve(p);
  const inside = (base) => { const r = path.relative(base, abs); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null; };
  const inProject = inside(P.projectRoot);
  if (inProject) return inProject;
  const inHome = inside(os.homedir());
  return inHome ? '~/' + inHome : abs;
}

// ---- schema ----
const _schemaCache = new Map();
function bothLangs(o) { return isObj(o) && typeof o.nl === 'string' && o.nl.trim() !== '' && typeof o.en === 'string' && o.en.trim() !== ''; }
function typeOk(spec, v) {
  switch (spec.type) {
    case 'bool': return typeof v === 'boolean';
    case 'int': return Number.isInteger(v) && v >= spec.min && v <= spec.max;
    case 'number': return typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max;
    case 'enum': return Array.isArray(spec.allowed) && spec.allowed.includes(v);
    case 'int-or-auto': return v === 'auto' || (Number.isInteger(v) && v >= spec.min && v <= spec.max);
    default: return false;
  }
}
/** validateSchema(schema, extraLockedIds) -> [problem, ...] (empty = valid). extraLockedIds are the hard-gate
 *  and always_interrupt ids: a setting with one of those names would make a gate configurable (fc-5). */
function validateSchema(schema, extraLockedIds) {
  const problems = [];
  if (!isObj(schema)) return ['the schema must be one JSON object'];
  if (!isObj(schema.settings) || !Object.keys(schema.settings).length) problems.push('"settings" must be a non-empty object');
  const syn = schema.value_synonyms;
  if (!isObj(syn) || !Array.isArray(syn.true) || !Array.isArray(syn.false)) problems.push('"value_synonyms" needs "true" and "false" arrays');
  if (!isObj(schema.groups)) problems.push('"groups" must be an object');
  if (!Array.isArray(schema.locked)) problems.push('"locked" must be an array');
  if (problems.length) return problems;
  for (const g of Object.keys(schema.groups)) if (!bothLangs(schema.groups[g])) problems.push('group "' + g + '" needs nl + en titles');
  const locked = new Set(extraLockedIds || []);
  for (const l of schema.locked) {
    if (!isObj(l) || typeof l.id !== 'string' || !l.id || !bothLangs(l)) problems.push('every locked item needs an id plus nl + en text');
    else locked.add(l.id);
  }
  for (const [key, s] of Object.entries(schema.settings)) {
    const bad = (m) => problems.push('setting "' + key + '": ' + m);
    if (!isObj(s)) { bad('must be an object'); continue; }
    if (locked.has(key)) bad('collides with a locked id — a hard gate or locked item can never be a setting');
    if (!TYPES.includes(s.type)) bad('unknown type ' + JSON.stringify(s.type));
    if (!SCOPES.includes(s.scope)) bad('scope must be "global" or "project"');
    if (!hasOwn(schema.groups, s.group)) bad('unknown group ' + JSON.stringify(s.group));
    if (!bothLangs(s.desc)) bad('desc needs nl + en');
    if (!Array.isArray(s.consumers) || !s.consumers.length) bad('consumers must be a non-empty array');
    if (s.type === 'enum' && !(Array.isArray(s.allowed) && s.allowed.length && s.allowed.every((a) => typeof a === 'string' && a))) bad('enum needs a non-empty "allowed" list');
    if (['int', 'number', 'int-or-auto'].includes(s.type) && !(typeof s.min === 'number' && typeof s.max === 'number' && s.min <= s.max)) bad('needs numeric min <= max');
    if (!hasOwn(s, 'default')) bad('missing "default"');
    else if (TYPES.includes(s.type) && !typeOk(s, s.default)) bad('default ' + JSON.stringify(s.default) + ' does not fit its own type');
    for (const f of ['off_means', 'disclosure']) if (hasOwn(s, f) && !bothLangs(s[f])) bad(f + ' needs nl + en');
    if (hasOwn(s, 'flags') && !(Array.isArray(s.flags) && s.flags.every((f) => FLAGS.includes(f)))) bad('flags must be a subset of ' + FLAGS.join(' '));
    if (hasOwn(s, 'aliases') && !(isObj(s.aliases) && ['nl', 'en'].every((l) => !hasOwn(s.aliases, l) || Array.isArray(s.aliases[l])))) bad('aliases must look like {"nl": [...], "en": [...]}');
    // CFG-08: ignore_global only makes sense for a project-scope setting (a global-scope key is already
    // machine-wide by definition) and must be a plain boolean, never a truthy-ish stand-in.
    if (hasOwn(s, 'ignore_global')) {
      if (typeof s.ignore_global !== 'boolean') bad('ignore_global must be a boolean');
      else if (s.ignore_global && s.scope !== 'project') bad('ignore_global only makes sense for a scope:"project" setting');
    }
  }
  const pdm = schema.product_default_map;
  if (pdm != null && !isObj(pdm)) problems.push('"product_default_map" must be an object');
  else if (pdm) {
    for (const [k, m] of Object.entries(pdm)) {
      if (k.startsWith('_')) continue;
      if (!hasOwn(schema.settings, k)) problems.push('product_default_map: unknown setting "' + k + '"');
      else if (!isObj(m) || typeof m.pref !== 'string' || !m.pref) problems.push('product_default_map.' + k + ' needs a "pref" name');
    }
  }
  return problems;
}
/** gateIds(opts) -> { ids, notes } — every hard-gate id (forge-actiongate KNOWN_GATES) and every
 *  always_interrupt id (FORGE_AUTONOMY.json via forge-autonomy.cjs; seam opts.autonomyPath). Best effort:
 *  a sibling that fails to load is reported as a note, and the schema's own locked list stays enforced. */
function gateIds(opts) {
  const ids = [];
  const notes = [];
  try { ids.push(...require('./forge-actiongate.cjs').KNOWN_GATES); }
  catch (e) { notes.push('forge-actiongate: ' + e.message); }
  try {
    const cfg = require('./forge-autonomy.cjs').getConfig(opts && opts.autonomyPath ? { configPath: opts.autonomyPath } : undefined);
    ids.push(...cfg.always_interrupt);
  } catch (e) { notes.push('forge-autonomy: ' + e.message); }
  return { ids, notes };
}
function loadSchema(schemaPath, opts) {
  const p = schemaPath || SCHEMA_PATH_DEFAULT;
  let st;
  try { st = fs.statSync(p); }
  catch (e) { throw new ConfigError('malformed', 'forge-config: schema not readable (' + p + '): ' + e.message, 2); }
  const stamp = st.mtimeMs + ':' + st.size;
  const cached = _schemaCache.get(p);
  if (cached && cached.stamp === stamp) return cached.schema;
  let schema;
  try { schema = JSON.parse(stripBom(fs.readFileSync(p, 'utf8'))); }
  catch (e) { throw new ConfigError('malformed', 'forge-config: schema is not valid JSON (' + p + '): ' + e.message, 2); }
  const problems = validateSchema(schema, gateIds(opts).ids);
  if (problems.length) throw new ConfigError('malformed', 'forge-config: schema ' + p + ' is invalid: ' + problems.join('; '), 2, { problems });
  _schemaCache.set(p, { stamp, schema });
  return schema;
}
function lockedIds(schema, opts) {
  const g = gateIds(opts);
  const ids = new Set(schema.locked.map((l) => l.id));
  for (const id of g.ids) ids.add(id);
  return { ids, notes: g.notes };
}
function lockedItem(key, schema) {
  return schema.locked.find((l) => l.id === key) || schema.locked.find((l) => l.id === 'hard-gates') || null;
}
function lockedError(key, schema, lang) {
  const item = lockedItem(key, schema);
  return new ConfigError('locked', text.t(lang).locked(key, item ? item[lang] || item.en : ''), 3, { key });
}

// ---- language ----
function normLang(x) {
  if (typeof x !== 'string') return null;
  const s = x.trim().toLowerCase();
  if (/^nl([-_].*)?$/.test(s) || s === 'dutch' || s === 'nederlands') return 'nl';
  if (/^en([-_].*)?$/.test(s) || s === 'english' || s === 'engels') return 'en';
  return null;
}
function markerLang(P) {
  try {
    const d = JSON.parse(stripBom(fs.readFileSync(P.setupMarker, 'utf8')));
    const a = isObj(d) && isObj(d.answers) ? d.answers : {};
    return normLang(d.lang) || normLang(d.language) || normLang(a.lang) || normLang(a.language) || null;
  } catch { return null; /* no marker, or an unreadable one: the language simply falls back to English */ }
}
/** detectLang — cheap best-effort language for messages produced before (or without) a full resolve:
 *  --lang > the `language` value in the global file > .forge-setup.json > en. Never throws. */
function detectLang(opts, P) {
  const flag = normLang(opts && opts.lang);
  if (flag) return flag;
  try {
    const d = JSON.parse(stripBom(fs.readFileSync(P.global, 'utf8')));
    const l = normLang(d && d.settings && d.settings.language && d.settings.language.value);
    if (l) return l;
  } catch { /* a missing or damaged global file is reported by resolve(); here it only means "no preference" */ }
  return markerLang(P) || 'en';
}

// ---- values ----
function synonyms(schema, which) { return schema.value_synonyms[which].map((s) => String(s).toLowerCase()); }
function shortWord(spec, v, lang) {
  if (spec.type === 'bool') return v ? (lang === 'nl' ? 'aan' : 'on') : (lang === 'nl' ? 'uit' : 'off');
  return String(v);
}
function displayValue(spec, v, lang) {
  if (spec.type === 'bool') return shortWord(spec, v, lang);
  return typeof v === 'number' && spec.unit ? v + ' ' + spec.unit : String(v);
}
function toNumber(raw, spec) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (spec.unit && s.toLowerCase().endsWith(spec.unit.toLowerCase())) s = s.slice(0, s.length - spec.unit.length).trim();
  if (spec.unit === 'USD' && s.startsWith('$')) s = s.slice(1).trim();
  if (spec.type === 'number') s = s.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function aliasesOf(key, spec) {
  const a = isObj(spec.aliases) ? spec.aliases : {};
  return [key, key.replace(/[.-]/g, ' ')].concat(a.nl || [], a.en || []);
}
function suggestKey(input, schema) {
  const q = String(input || '').toLowerCase().trim();
  if (!q) return null;
  let best = null;
  let bestD = Infinity;
  for (const [key, spec] of Object.entries(schema.settings)) {
    for (const c of aliasesOf(key, spec)) {
      const cl = String(c).toLowerCase();
      let d = levenshtein(q, cl);
      if (q.length >= 3 && cl.length >= 3 && (cl.includes(q) || q.includes(cl))) d = Math.min(d, 1);
      if (d < bestD) { bestD = d; best = key; }
    }
  }
  return bestD <= Math.max(2, Math.floor(q.length * 0.4)) ? best : null;
}
function unknownKeyError(key, schema, lang, exitCode) {
  const suggestion = suggestKey(key, schema);
  return new ConfigError('unknown_key', text.t(lang).unknownKey(key, suggestion), exitCode, { key, suggestion });
}

/** parseValue(key, raw, schema?, lang?) -> the canonical typed value, or throws ConfigError (exit 2) with a
 *  beginner-plain message. Accepts typed values (from JSON) and CLI strings: bool synonyms (on/off, aan/uit,
 *  ja/nee, true/false, 1/0 ...), a unit suffix ("98 %", "120s", "$5"), a Dutch decimal comma, and for an enum
 *  that has an "off" value any off-synonym ("uit" -> "off"). */
function parseValue(key, raw, schema, lang) {
  schema = schema || loadSchema();
  lang = normLang(lang) || 'en';
  if (!hasOwn(schema.settings, key)) throw unknownKeyError(key, schema, lang, 2);
  const spec = schema.settings[key];
  const fail = () => {
    const ex = shortWord(spec, spec.default, lang);
    const shown = String(raw === undefined ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 60);
    throw new ConfigError('invalid_value', text.t(lang).invalid[spec.type](key, shown, ex, spec), 2, { key });
  };
  if (raw === undefined || raw === null) return fail();
  const s = typeof raw === 'string' ? raw.trim() : raw;
  if (spec.type === 'bool') {
    if (typeof s === 'boolean') return s;
    const w = String(s).toLowerCase();
    if (synonyms(schema, 'true').includes(w)) return true;
    if (synonyms(schema, 'false').includes(w)) return false;
    return fail();
  }
  if (spec.type === 'enum') {
    if (typeof s !== 'string') return fail();
    const w = s.toLowerCase();
    const hit = spec.allowed.find((a) => a.toLowerCase() === w);
    if (hit) return hit;
    if (spec.allowed.includes('off') && synonyms(schema, 'false').includes(w)) return 'off';
    return fail();
  }
  if (spec.type === 'int-or-auto' && typeof s === 'string' && s.toLowerCase() === 'auto') return 'auto';
  const n = toNumber(s, spec);
  if (n === null || (spec.type !== 'number' && !Number.isInteger(n)) || n < spec.min || n > spec.max) return fail();
  return n;
}

/** parseFlagValue(key, raw) -> parseValue(key, raw) against the REAL schema, in English — a small, stable,
 *  2-argument surface for an external consumer CLI's own flag parsing. CFG-05 (Codex recheck 2026-09-24):
 *  usage-guard.cjs's resolveGuardSettings() validated `--pause-at` etc with only Number.isFinite(n), so an
 *  out-of-range or fractional threshold the config core would reject (bounds, integer-ness, unit suffix,
 *  Dutch decimal comma) was silently accepted by the consumer CLI. Every consumer flag that maps onto a
 *  schema setting must validate through THIS function (same parser, same bounds) instead of re-implementing
 *  its own number check — throws the same ConfigError parseValue() throws (code 'invalid_value'/'unknown_key',
 *  exitCode 2) on anything the schema would refuse. */
function parseFlagValue(key, raw) { return parseValue(key, raw); }

// ---- files ----
function malformedError(file, reason, lang, P) {
  return new ConfigError('malformed', text.t(lang).malformed(prettyPath(file, P), reason), 2, { file });
}
function readJsonObject(file, lang, P) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { present: false, data: null };
    throw malformedError(file, e.message, lang, P);
  }
  let data;
  try { data = JSON.parse(stripBom(raw)); }
  catch (e) { throw malformedError(file, 'not valid JSON: ' + e.message, lang, P); }
  if (!isObj(data)) throw malformedError(file, 'the file must be one JSON object', lang, P);
  return { present: true, data };
}
function readRaw(file, lang, P) {
  const r = readJsonObject(file, lang, P);
  if (!r.present) return r;
  if (hasOwn(r.data, 'version') && r.data.version !== 1) throw malformedError(file, 'unsupported "version" ' + JSON.stringify(r.data.version) + ' (expected 1)', lang, P);
  if (!isObj(r.data.settings)) throw malformedError(file, 'missing a "settings" object', lang, P);
  return r;
}
function readConfigFile(file, schema, locked, lang, P, nowMs) {
  const r = readRaw(file, lang, P);
  const out = { present: r.present, entries: {}, notes: [], keyNotes: {} };
  if (!r.present) return out;
  const pretty = prettyPath(file, P);
  const T = text.t(lang);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const note = (key, n) => { out.notes.push(n); (out.keyNotes[key] = out.keyNotes[key] || []).push(n); };
  for (const [key, ent] of Object.entries(r.data.settings)) {
    if (locked.has(key)) { out.notes.push(T.fileLockedIgnored(key, pretty)); continue; }
    if (!hasOwn(schema.settings, key)) { out.notes.push(T.fileUnknownIgnored(key, pretty)); continue; }
    if (!isObj(ent) || !hasOwn(ent, 'value')) throw malformedError(file, '"' + key + '" must look like {"value": ...}', lang, P);
    const stamp = onceLib.onceState(ent, now);
    if (stamp && stamp.expired) { note(key, T.onceExpired(key, pretty)); continue; }
    const spec = schema.settings[key];
    // CFG-02 (Codex recheck 2026-09-24): a PERSISTED file must already hold the CANONICAL schema type — an
    // exact boolean, an integer in range, an exact allowed enum string, ... `typeOk` is the same canonical
    // check validateSchema() uses on a schema's own default; reusing it here means "false", 0, "off", [0]
    // and similar CLI-only coercions read out of a hand-edited or corrupted file are reported as DAMAGE
    // (fail-closed to the safe default), never silently accepted as if they were a real value. Coercion
    // (bool synonyms, a unit suffix, a Dutch decimal comma, case-insensitive enum words) stays a CLI/text
    // input convenience — parseValue() — never a way to read a non-canonical shape out of the file itself.
    if (!typeOk(spec, ent.value)) throw malformedError(file, '"' + key + '" has a value of the wrong type for a ' + spec.type + ' setting (got ' + JSON.stringify(ent.value).slice(0, 60) + ')', lang, P);
    out.entries[key] = { value: ent.value, set_at: typeof ent.set_at === 'string' ? ent.set_at : null, set_by: typeof ent.set_by === 'string' ? ent.set_by : null, expires_at: stamp ? stamp.expires_at : null };
    if (stamp) note(key, T.onceActive(key, stamp.minutesLeft, onceLib.onceQuote(ent, text.ONCE_BY)));
  }
  return out;
}
/** renameWithRetry(from, to, fence) — `fence`, when given, is re-checked immediately before EVERY publishing
 *  attempt inside this retry loop, not only once before the first one (V09-R, codex-recheck-2026-09-24
 *  out-p12: a transient EPERM/EBUSY/EACCES on attempt 1 used to send this loop into its own retry/backoff
 *  without the caller ever getting a chance to recheck the fence in between — a replacement lock owner could
 *  reclaim the lock and publish a newer configuration during that window, and this loop's LATER attempt would
 *  still publish the original, now-stale write on top of it). Checking here, at the top of every iteration
 *  (including after a backoff sleep), closes that gap: a fence failure on any attempt throws EFENCED and never
 *  calls fs.renameSync again, so a reclaimed lock's newer write is never overwritten. HONEST RESIDUAL
 *  (documented, not eliminated): the fence check and the immediately-following fs.renameSync call remain two
 *  separate syscalls, so a reclaim landing in that exact instant is still possible in principle — the same
 *  class of check-to-rename gap forge-config-once.cjs's own header documents for its lock, closeable only with
 *  real OS-level locking. */
function renameWithRetry(from, to, fence) {
  for (let i = 0; ; i++) {
    if (typeof fence === 'function' && !fence()) {
      const err = new Error('forge-config: write refused — the file lock was reclaimed by another writer before this write could publish');
      err.code = 'EFENCED';
      throw err;
    }
    try { fs.renameSync(from, to); return; }
    catch (e) {
      // Windows: a reader holding the target open for a moment gives EPERM/EBUSY; retry briefly, then fail loudly.
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}
// CFG-10 (Codex recheck 2026-09-24, hardened again for V10): a successful return must mean the new bytes
// actually survive a crash, not just that writeFileSync()+rename() returned without throwing. fsyncFile
// flushes the temp file's content to disk BEFORE it is ever renamed over the real file — a real failure
// there (EIO, ENOSPC, a dying disk, ...) is a genuine durability problem and MUST propagate: it runs inside
// atomicWriteJson's own try/catch, before renameWithRetry, so the exception it throws is caught there, the
// temp file is cleaned up, and the real target file is never touched (V10 verification: "File EIO must
// fail without replacing the original target"). fsyncDir flushes the directory entry (the rename itself)
// AFTER the rename already succeeded; a directory handle is NOT syncable on every platform (notably
// Windows/NTFS, confirmed live on this machine: fsyncSync on a directory fd throws EPERM) — that ONE narrow,
// platform-shaped case is tolerated as a best-effort degrade; any OTHER error opening or syncing the
// directory still propagates, exactly as a real file fsync error would.
const DIR_FSYNC_UNSUPPORTED_CODES = ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'ENOSYS'];
function fsyncFile(fd) { fs.fsyncSync(fd); }
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (e) {
    if (!DIR_FSYNC_UNSUPPORTED_CODES.includes(e.code)) throw e; // anything else is a real failure, not "unsupported"
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}
/** atomicWriteJson(file, obj, fence) — `fence`, when given, is onceLib.withLock's own zero-arg fence
 *  function (V09 FIFTH fix, out-p11 + Security Boss addendum), re-checked IMMEDIATELY BEFORE EVERY publishing
 *  rename attempt inside renameWithRetry — not only once by the caller, earlier, before its own
 *  read-modify-write, and not only once before the FIRST attempt (V09-R, codex-recheck-2026-09-24 out-p12: a
 *  transient rename error used to send the retry loop into its own backoff/retry without ever rechecking the
 *  fence again, so a lock reclaimed and republished with a newer configuration DURING that backoff could still
 *  be overwritten by this call's later, now-stale retry). renameWithRetry itself re-checks `fence()` at the top
 *  of every iteration, including after each backoff sleep — see its own header for the exact contract and the
 *  honest residual gap. On a failed re-check the write throws an Error with `.code === 'EFENCED'`, cleans up
 *  the temp file, and never runs the rename that would have published it — this is what makes the CHANGELOG's
 *  "the config lock's fence refuses a stale write" claim actually true across retries, not only on the first
 *  attempt. */
function atomicWriteJson(file, obj, fence) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(obj, null, 2) + '\n');
    fsyncFile(fd);
    fs.closeSync(fd);
    fd = undefined;
    renameWithRetry(tmp, file, fence);
    fsyncDir(dir);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* the temp file was never created or is already gone */ }
    throw e;
  }
}

// ---- product defaults (owner profile, read-only) ----
function productDefaults(schema, opts, P, lang) {
  const values = {};
  const notes = [];
  const map = isObj(schema.product_default_map) ? schema.product_default_map : {};
  let prefs;
  try { prefs = require('./forge-prefs.cjs'); }
  catch (e) { return { values, notes: [text.t(lang).prefsSkipped(e.message)] }; }
  const prefsOpts = opts.prefsOpts || {
    profilePath: path.join(P.projectRoot, '.claude', 'FORGE_OWNER_PROFILE.json'),
    globalProfilePath: path.join(P.configHome, 'FORGE_OWNER_PROFILE.json'),
  };
  for (const [key, m] of Object.entries(map)) {
    if (key.startsWith('_') || !isObj(m) || !hasOwn(schema.settings, key)) continue;
    let r;
    try { r = prefs.get(m.pref, prefsOpts); }
    catch (e) { notes.push(text.t(lang).prefsSkipped(e.message)); break; }
    if (!r.found) continue;
    let v = r.entry.value;
    if (isObj(m.map) && typeof v === 'string' && hasOwn(m.map, v)) v = m.map[v];
    try { values[key] = { value: parseValue(key, v, schema, lang), pref: m.pref }; }
    catch { notes.push(text.t(lang).prefUnfit(m.pref, key, JSON.stringify(v))); }
  }
  return { values, notes };
}

function parseFlags(flags, schema, locked, lang) {
  const out = {};
  if (flags == null) return out;
  const pairs = [];
  if (Array.isArray(flags)) {
    for (const f of flags) {
      const s = String(f);
      const i = s.indexOf('=');
      if (i <= 0) throw new ConfigError('usage', text.t(lang).badFlag(s), 2);
      pairs.push([s.slice(0, i).trim(), s.slice(i + 1)]);
    }
  } else if (isObj(flags)) {
    for (const k of Object.keys(flags)) pairs.push([k, flags[k]]);
  } else throw new ConfigError('usage', text.t(lang).badFlag(String(flags)), 2);
  for (const [k, v] of pairs) {
    if (locked.has(k)) throw lockedError(k, schema, lang);
    out[k] = parseValue(k, v, schema, lang);
  }
  return out;
}

/** status of a setting for the list's Status column: 'on' | 'off' | null ('-'). bool -> its value. enum ->
 *  'off' for the values its off_means text names ("ask-each-phase: ...", "l4-only: ...; always: ...") or,
 *  failing that, the literal "off"; an enum without either (language, cleanup) has no on/off state. A
 *  dotted key under a bool parent (usage-guard.pause-at) follows its parent. Other numbers: no state. */
function statusOf(key, spec, value, schema, values) {
  if (spec.type === 'bool') return value ? 'on' : 'off';
  if (spec.type === 'enum') {
    const om = spec.off_means ? spec.off_means.en : '';
    const named = spec.allowed.filter((v) => new RegExp('(^|;\\s*)' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':').test(om));
    const offs = named.length ? named : spec.allowed.includes('off') ? ['off'] : [];
    return offs.length ? (offs.includes(value) ? 'off' : 'on') : null;
  }
  const dot = key.lastIndexOf('.');
  const parent = dot > 0 ? key.slice(0, dot) : null;
  if (parent && schema.settings[parent] && schema.settings[parent].type === 'bool') return values[parent] ? 'on' : 'off';
  return null;
}
function entryOf(key, value, source, setAt, setBy, expiresAt) {
  const e = { key, value, source, set_at: setAt || null, set_by: setBy || null };
  if (expiresAt) e.expires_at = expiresAt; // a live one-off approval (see ONCE_KEYS)
  return e;
}
const fileEntry = (key, f, source) => entryOf(key, f.entries[key].value, source, f.entries[key].set_at, f.entries[key].set_by, f.entries[key].expires_at);
function valuesOf(settings) { const o = {}; for (const k of Object.keys(settings)) o[k] = settings[k].value; return o; }
function hashValues(values) {
  const sorted = {};
  for (const k of Object.keys(values).sort()) sorted[k] = values[k];
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
function nowMsOf(opts) {
  const n = opts && opts.now;
  const ms = n instanceof Date ? n.getTime() : typeof n === 'string' ? Date.parse(n) : typeof n === 'number' ? n : NaN;
  return Number.isFinite(ms) ? ms : Date.now();
}

// ---- resolve / get / list ----
function resolve(opts) {
  opts = opts || {};
  const P = pathsFor(opts);
  const schema = loadSchema(P.schema, opts);
  const lk = lockedIds(schema, opts);
  const lang0 = detectLang(opts, P);
  const same = path.resolve(P.global) === path.resolve(P.project); // Forge installed in the home dir itself
  const nowMs = nowMsOf(opts);
  const g = readConfigFile(P.global, schema, lk.ids, lang0, P, nowMs);
  const p = same ? { present: false, entries: {}, notes: [], keyNotes: {} } : readConfigFile(P.project, schema, lk.ids, lang0, P, nowMs);
  const flags = parseFlags(opts.flags, schema, lk.ids, lang0);
  const pd = productDefaults(schema, opts, P, lang0);
  const settings = {};
  const ignored = [];
  const strengthened = [];
  const globalIgnoredForSafety = [];
  for (const [key, spec] of Object.entries(schema.settings)) {
    let e = entryOf(key, spec.default, 'default');
    if (hasOwn(pd.values, key)) e = entryOf(key, pd.values[key].value, 'product-default', null, 'owner profile: ' + pd.values[key].pref);
    // CFG-08 (Codex recheck 2026-09-24): a handful of safety-critical settings (spec.ignore_global, e.g.
    // gate-hook) are project-scope-only for READS — a value sitting in the GLOBAL file is never applied,
    // only noted, so it can never lurk beneath a protective project override and get "exposed" the moment
    // that project override is reset/removed.
    if (hasOwn(g.entries, key)) {
      if (spec.ignore_global) globalIgnoredForSafety.push(key);
      else e = fileEntry(key, g, 'global');
    }
    if (hasOwn(p.entries, key)) {
      if (spec.scope === 'global') {
        // CFG-04: a global-scope key is machine-wide, so a project-file value is normally ignored — EXCEPT
        // a boolean project value that matches the schema's own (protective, everything-on-by-default)
        // default: that can only ever STRENGTHEN protection (turn a protective setting back ON locally),
        // never weaken a global ON. A project value that would move the effective value AWAY from the
        // default is still ignored, exactly as before.
        const projectVal = p.entries[key].value;
        if (spec.type === 'bool' && projectVal === spec.default) {
          if (e.value !== projectVal) strengthened.push(key);
          e = fileEntry(key, p, 'project');
        } else {
          ignored.push(key);
        }
      } else e = fileEntry(key, p, 'project');
    }
    if (hasOwn(flags, key)) e = entryOf(key, flags[key], 'flag', null, '--flag');
    settings[key] = e;
  }
  const lang = normLang(opts.lang) || normLang(settings.language && settings.language.value) || markerLang(P) || 'en';
  const values = valuesOf(settings);
  for (const [key, e] of Object.entries(settings)) {
    const spec = schema.settings[key];
    Object.assign(e, { display: displayValue(spec, e.value, lang), status: statusOf(key, spec, e.value, schema, values), scope: spec.scope, group: spec.group, type: spec.type, unit: spec.unit || null });
  }
  const T = text.t(lang);
  const notes = [];
  if (lk.notes.length) notes.push(T.lockSourceNote(lk.notes.join('; ')));
  notes.push(...g.notes, ...p.notes);
  for (const k of ignored) notes.push(T.scopeIgnored(k));
  for (const k of strengthened) notes.push(T.scopeStrengthened(k));
  for (const k of globalIgnoredForSafety) notes.push(T.globalIgnoredForSafety(k));
  notes.push(...pd.notes);
  const gp = prettyPath(P.global, P);
  const pp = prettyPath(P.project, P);
  if (!g.present && !p.present && !same) notes.push(T.noFiles(gp, pp));
  else {
    if (!g.present) notes.push(T.missingFile('global', gp));
    if (!p.present && !same) notes.push(T.missingFile('project', pp));
  }
  const keyNotes = {};
  for (const f of [g, p]) for (const [k, ns] of Object.entries(f.keyNotes)) keyNotes[k] = (keyNotes[k] || []).concat(ns);
  return {
    settings,
    files: { global: { path: P.global, present: g.present, pretty: gp }, project: { path: P.project, present: p.present, pretty: pp } },
    notes,
    key_notes: keyNotes,
    lang,
    ignored_project_values: ignored,
    strengthened_project_values: strengthened,
  };
}

function lookupKey(key, opts) {
  const P = pathsFor(opts);
  const schema = loadSchema(P.schema, opts);
  if (hasOwn(schema.settings, key)) return { P, schema, locked: false };
  const lang = detectLang(opts, P);
  if (lockedIds(schema, opts).ids.has(key)) return { P, schema, locked: true, lang };
  throw unknownKeyError(key, schema, lang, 1);
}

/** get(key, opts) -> the resolved entry {key, value, source, set_at, set_by, display, status, ..., desc}.
 *  Throws ConfigError 'unknown_key' (exit 1) or 'locked' (exit 3). */
function get(key, opts) {
  opts = opts || {};
  const k = lookupKey(key, opts);
  if (k.locked) throw lockedError(key, k.schema, k.lang);
  const r = resolve(opts);
  const out = Object.assign({}, r.settings[key], { desc: k.schema.settings[key].desc[r.lang], lang: r.lang });
  const kn = r.key_notes[key] || []; // a live or expired one-off approval for this key
  const b = bridgeStatus(key, k.schema, k.P, opts, r.settings[key].value, r.lang);
  if (b) return Object.assign(out, { bridge: b, notes: kn.concat(b.notes) });
  return kn.length ? Object.assign(out, { notes: kn }) : out;
}

// ---- fail-safe read (review-boss M3) ----
function isFlagged(spec) { return isObj(spec) && Array.isArray(spec.flags) && spec.flags.some((f) => FLAGS.includes(f)); }
/** safeValueOf(spec) -> the value a flagged setting falls back to when the settings cannot be read. */
function safeValueOf(spec) {
  if (spec.type === 'bool') return false;
  if (spec.type === 'enum' && Array.isArray(spec.allowed)) {
    const off = SAFE_ENUM_WORDS.find((w) => spec.allowed.includes(w));
    if (off !== undefined) return off;
  }
  return spec.default;
}
/** specForSafety(key, P, opts) -> the schema's OWN validated setting definition for `key`, or null. CFG-03
 *  (Codex recheck 2026-09-24): a schema that fails to load OR fails validateSchema() is REJECTED IN FULL —
 *  never salvage a setting's default/allowed/type from its own unvalidated bytes (a rejected schema could
 *  otherwise "safely" authorize exactly the value that got it rejected in the first place). A missing file, a
 *  bad-JSON file, and a schema that parses but fails validation are all treated identically here: null. safeGet
 *  below then resolves the degraded value only from the immutable FAILSAFE_FLAGGED table (a known flagged key)
 *  or the caller's own opts.fallback (everything else) — never from anything read out of rejected bytes. */
function specForSafety(key, P, opts) {
  try { return loadSchema(P.schema, opts).settings[key] || null; } catch { return null; }
}
/** safeGet(key, opts) -> { key, value, source, degraded, reason, notes } — the read every consumer uses. Never
 *  throws. A readable config gives get()'s value with degraded:false. When the settings cannot be read (a damaged
 *  FORGE_CONFIG.json, a missing/invalid schema, an internal error) a key carrying any disclosure flag (C N X $ U D)
 *  resolves to its SAFE value (safeValueOf) and every other key to its schema default — both degraded:true with a
 *  plain one-line reason naming the file and the way back. opts = get()'s opts plus opts.fallback: the caller's own
 *  copy of the default, used only when the schema is unreadable and the key is not a known flagged key. */
function safeGet(key, opts) {
  opts = opts || {};
  try {
    const e = get(key, opts);
    return { key, value: e.value, source: e.source, degraded: false, reason: null, notes: e.notes || [] };
  } catch (err) {
    let P;
    try { P = pathsFor(opts); } catch { P = null; }
    const spec = P ? specForSafety(key, P, opts) : null;
    const flagged = hasOwn(FAILSAFE_FLAGGED, key) || isFlagged(spec);
    let value;
    if (flagged) value = spec && (spec.type === 'bool' || spec.type === 'enum') ? safeValueOf(spec) : hasOwn(FAILSAFE_FLAGGED, key) ? FAILSAFE_FLAGGED[key] : false;
    else value = spec && hasOwn(spec, 'default') ? spec.default : opts.fallback;
    let lang = 'en';
    try { lang = P ? detectLang(opts, P) : 'en'; } catch { lang = 'en'; }
    const T = text.t(lang);
    const why = err instanceof ConfigError ? err.message : T.internalError(err && err.message ? err.message : String(err));
    const settingsFile = P && err && err.code === 'malformed' && err.file && [P.global, P.project].some((f) => path.resolve(f) === path.resolve(err.file));
    const fix = settingsFile ? T.degradedFix('/forge config reset' + (path.resolve(err.file) === path.resolve(P.global) ? ' --global' : '') + ' --yes') : '';
    const word = spec && TYPES.includes(spec.type) ? shortWord(spec, value, lang) : JSON.stringify(value);
    return { key, value, source: flagged ? 'safe-fallback' : 'default', degraded: true, reason: [why, T.degradedUse(key, word, flagged), fix].filter(Boolean).join(' '), notes: [] };
  }
}

/** list(opts) -> { settings: [entries in schema order], hidden, locked, files, notes, lang, groups, project }.
 *  Without opts.all the "advanced" group is left out (and counted in `hidden`). */
function list(opts) {
  opts = opts || {};
  const P = pathsFor(opts);
  const schema = loadSchema(P.schema, opts);
  const r = resolve(opts);
  const lang = r.lang;
  const all = Object.keys(schema.settings).map((key) => {
    const spec = schema.settings[key];
    return Object.assign({}, r.settings[key], {
      default: spec.default,
      desc: spec.desc[lang],
      off_means: spec.off_means ? spec.off_means[lang] : null,
      disclosure: spec.disclosure ? spec.disclosure[lang] : null,
      flags: (spec.flags || []).slice(),
    });
  });
  const settings = opts.all ? all : all.filter((s) => s.group !== 'advanced');
  return {
    settings,
    hidden: all.length - settings.length,
    locked: schema.locked.map((l) => ({ id: l.id, text: l[lang] || l.en, source: l.source || null })),
    files: r.files,
    notes: r.notes.concat(bridgeNotes(schema, P, opts, r)),
    lang,
    groups: Object.keys(schema.groups).map((id) => ({ id, title: schema.groups[id][lang] || schema.groups[id].en })),
    project: path.basename(P.projectRoot),
  };
}

// ---- writes ----
function noFlags(opts) { return Object.assign({}, opts, { flags: undefined }); }
function lockOptsOf(opts) { return { timeoutMs: opts && opts.lockTimeoutMs, staleMs: opts && opts.lockStaleMs, pollMs: opts && opts.lockPollMs }; }
/** writableKey(key, opts, checkIgnoreGlobal) -> { P, schema, lang }, or throws 'locked' (exit 3). With
 *  checkIgnoreGlobal, a --global request on a spec.ignore_global setting (gate-hook, CFG-08) is ALSO refused
 *  (exit 2) up front — a --global write there would silently do nothing, since resolve() never reads it
 *  back. Only set() passes checkIgnoreGlobal: unset()/reset() may still remove a stray global entry
 *  (cleanup, never exposure) and setOnce() already refuses --global for its own, more specific reason. */
function writableKey(key, opts, checkIgnoreGlobal) {
  const P = pathsFor(opts);
  const schema = loadSchema(P.schema, opts);
  const lang = detectLang(opts, P);
  if (lockedIds(schema, opts).ids.has(key)) throw lockedError(key, schema, lang);
  if (checkIgnoreGlobal && opts && opts.global && hasOwn(schema.settings, key) && schema.settings[key].ignore_global) {
    throw new ConfigError('usage', text.t(lang).globalIgnoredRefuse(key), 2, { key });
  }
  return { P, schema, lang };
}

/** set(key, rawValue, opts) — validates, then atomically writes the value into the project file (or the global
 *  file for opts.global and for every scope:"global" key). Returns { key, from, to, file, scope, entry, ... }.
 *  Throws (nothing written): 'locked' exit 3 · 'unknown_key' / 'invalid_value' / 'malformed' exit 2 ·
 *  'once_pending' exit 3 (V03, Codex recheck 2026-09-24 — see below). The actual read-modify-write against
 *  `file` is serialized with onceLib.withLock (CFG-09): a concurrent writer targeting the same file always
 *  re-reads AFTER acquiring the lock, so neither writer's change can be lost. */
function set(key, rawValue, opts) {
  opts = opts || {};
  if (opts.once != null) return setOnce(key, rawValue, opts);
  const { P, schema, lang } = writableKey(key, opts, true);
  const T = text.t(lang);
  if (!hasOwn(schema.settings, key)) throw unknownKeyError(key, schema, lang, 2);
  const spec = schema.settings[key];
  const value = parseValue(key, rawValue, schema, lang);
  const bridge = bridgeOf(key, schema, P, opts);
  if (bridge) readBridge(bridge, lang, P); // fail closed BEFORE any write: a damaged legacy file is refused (exit 2)
  const before = resolve(noFlags(opts));
  const toGlobal = !!opts.global || spec.scope === 'global';
  const file = toGlobal ? P.global : P.project;
  let unchanged = false;
  let clearedOnce = false;
  onceLib.withLock(file, (fence) => {
    const cur = readRaw(file, lang, P);
    const data = cur.present ? cur.data : { version: 1, settings: {} };
    const old = data.settings[key];
    const onceSt = onceLib.onceState(old, nowMsOf(opts));
    if (onceSt) {
      // V03 (Codex recheck 2026-09-24): while the one-off is still PENDING (armed, unconsumed, unexpired), an
      // ordinary set() may ONLY end it via an explicit "on" (value === true) — a plain "off" (or any other
      // value) is REFUSED outright (exit 3, nothing written). Without this, `set gate-hook off` while a
      // one-off grant is pending silently deleted the temporary, self-expiring entry and replaced it with a
      // PERMANENT value:false (no expires_at) — turning one authorized one-off command into an indefinite
      // disablement. An EXPIRED once entry (already effectively "back to normal") is not pending and is
      // simply cleared and replaced like any other stale entry, same as before this fix.
      if (!onceSt.expired && value !== true) throw new ConfigError('once_pending', T.oncePendingRefuse(key), 3, { key });
      // A normal set always ends a one-off approval ("set gate-hook on" clears it, or it was already expired):
      // drop that entry first, and keep a permanent value only when the layer beneath does not already give
      // the requested one. Also drop the authoritative PENDING grant file (V09 FIFTH fix) so an early "on"
      // never leaves an orphaned grant nobody will ever consume — hygiene only, never a safety dependency
      // (consumeOnce()'s mirror-based outer check already refuses once this entry itself is gone).
      const settings = Object.assign({}, data.settings);
      delete settings[key];
      atomicWriteJson(file, Object.assign({}, data, { settings }), fence);
      onceStore.removePendingOnceGrant(path.dirname(file), key);
      clearedOnce = true;
      unchanged = resolve(noFlags(opts)).settings[key].value === value;
    } else if (isObj(old) && hasOwn(old, 'value')) {
      try { unchanged = parseValue(key, old.value, schema, lang) === value; } catch { unchanged = false; /* an invalid old value is simply replaced */ }
    }
    if (!unchanged) {
      const entry = { value, set_at: new Date(nowMsOf(opts)).toISOString(), set_by: text.SET_BY };
      const settings = Object.assign({}, data.settings, { [key]: entry });
      atomicWriteJson(file, Object.assign({}, data, { version: hasOwn(data, 'version') ? data.version : 1, settings }), fence);
    }
  }, lockOptsOf(opts));
  const after = resolve(noFlags(opts)).settings[key];
  const bridged = bridge ? applyBridge(bridge, after.value, schema, lang, P) : null;
  let shadow = null;
  if (after.value !== value) shadow = { source: after.source, display: after.display, undo: '/forge config unset ' + key + (after.source === 'global' ? ' --global' : '') };
  return {
    key, from: before.settings[key].value, to: value, file, file_pretty: prettyPath(file, P),
    scope: toGlobal ? 'global' : 'project', auto_global: !opts.global && spec.scope === 'global', unchanged,
    from_word: shortWord(spec, before.settings[key].value, lang), to_word: shortWord(spec, value, lang),
    entry: after, shadow, disclosure: spec.disclosure && after.status === 'on' && !unchanged ? spec.disclosure[lang] : null, lang,
    bridge: bridged, cleared_once: clearedOnce,
  };
}

/** setOnce(key, rawValue, opts) — `set gate-hook off --once "<owner's words>"`: switches a ONCE_KEYS key off for
 *  ONE approved command/run, single-use (CFG-07/S06). Writes { value:false, set_at, set_by:"owner one-off
 *  approval: <quote>", once_quote, expires_at: now+10 min, consumed_at:null, consumed_command_sha256:null } into
 *  the PROJECT file only (once_quote is the field forge-gate-hook.cjs reads first); consumeOnce() below is the
 *  atomic single use. get/list/resolve ignore it once expired OR consumed; `set <key> on` clears it. Refused
 *  (exit 2, nothing written): another key, --global, a value other than off, no quote, or an unexpired
 *  UNCONSUMED one-off already armed for this key ("one-off already armed" — re-issuing can never silently
 *  extend the window; wait for it to be consumed or to expire first). The whole read-check-write is inside
 *  onceLib.withLock so two concurrent `--once` requests can never both succeed. V09 FIFTH fix (out-p11 +
 *  addendum): also writes the SAME entry to the authoritative PENDING grant file (onceStore) that
 *  consumeOnce() below atomically consumes — written FIRST, inside the same lock, so a failure here throws
 *  before the mirror is ever touched (fail closed: never an armed-looking mirror entry with no pending file
 *  to actually consume). */
function setOnce(key, rawValue, opts) {
  const { P, schema, lang } = writableKey(key, opts);
  const T = text.t(lang);
  if (!ONCE_KEYS.includes(key)) throw new ConfigError('usage', T.onceOnlyFor(key, ONCE_KEYS), 2, { key });
  if (opts.global) throw new ConfigError('usage', T.onceNoGlobal(key), 2, { key });
  if (parseValue(key, rawValue, schema, lang) !== false) throw new ConfigError('usage', T.onceOnlyOff(key), 2, { key });
  const quote = onceLib.sanitizeQuote(opts.once);
  if (!quote) throw new ConfigError('usage', T.onceNeedsQuote(key), 2, { key });
  const spec = schema.settings[key];
  const before = resolve(noFlags(opts));
  const nowMs = nowMsOf(opts);
  const entry = onceLib.withLock(P.project, (fence) => {
    const cur = readRaw(P.project, lang, P);
    const data = cur.present ? cur.data : { version: 1, settings: {} };
    const old = data.settings[key];
    const st = onceLib.onceState(old, nowMs);
    if (st && !st.expired) throw new ConfigError('usage', T.onceAlreadyArmed(key), 2, { key });
    const ent = {
      value: false, set_at: new Date(nowMs).toISOString(), set_by: text.ONCE_BY + quote, once_quote: quote,
      expires_at: new Date(nowMs + ONCE_MS).toISOString(), consumed_at: null, consumed_command_sha256: null,
    };
    onceStore.writePendingOnceGrant(path.dirname(P.project), key, ent); // the authoritative record — written first
    atomicWriteJson(P.project, Object.assign({}, data, { version: hasOwn(data, 'version') ? data.version : 1, settings: Object.assign({}, data.settings, { [key]: ent }) }), fence);
    return ent;
  }, lockOptsOf(opts));
  const after = resolve(noFlags(opts)).settings[key];
  return {
    key, from: before.settings[key].value, to: false, file: P.project, file_pretty: prettyPath(P.project, P),
    scope: 'project', auto_global: false, unchanged: false,
    from_word: shortWord(spec, before.settings[key].value, lang), to_word: shortWord(spec, false, lang),
    entry: after, shadow: null, disclosure: null, lang, bridge: null, cleared_once: false,
    once: { quote, expires_at: entry.expires_at, minutes: ONCE_MS / 60000 },
  };
}

/** consumeOnce(key, opts) -> { ok:true } | { ok:false, reason:'consumed'|'expired'|'absent'|'clock' } (CFG-07/
 *  S06, hardened by the V09 FIFTH fix, out-p11 + Security Boss addendum). The ONE atomic single-use step every
 *  hard-gate check must call before honouring a `--once` approval. Runs the SAME mirror-based checks as
 *  before (still fail closed on 'absent'/'clock'/'consumed'/'expired' read straight off the PROJECT-file
 *  entry) — but a call that PASSES all of them is no longer trusted as a real approval on its own. Out-p11
 *  proved forge-config-once.cjs's own lock can still let two callers both pass those mirror checks at once (a
 *  reclaim/release race, or the lock being unavailable for any other reason); the mirror alone was the ENTIRE
 *  V09 vulnerability. THE ACTUAL, LOCK-INDEPENDENT GATE is onceStore.consumeOnceGrant() — exactly one
 *  `fs.renameSync` of the shared PENDING grant file, which at most one caller can ever win regardless of any
 *  interleaving. Only a caller who wins that rename may then mark the mirror entry consumed (for
 *  get()/list()/explain() display); a caller who loses it returns ok:false with the store's own reason —
 *  never proceeds to write consumed_at at all. Never throws for a normal call; a schema/path/lock problem is
 *  reported as reason:'absent' (fail closed — no approval, no proceed). */
function consumeOnce(key, opts) {
  opts = opts || {};
  let P;
  try { P = pathsFor(opts); } catch { return { ok: false, reason: 'absent' }; }
  if (!ONCE_KEYS.includes(key)) return { ok: false, reason: 'absent' };
  let lang = 'en';
  try { lang = detectLang(opts, P); } catch { lang = 'en'; }
  const nowMs = nowMsOf(opts);
  const commandSha256 = typeof opts.commandSha256 === 'string' && opts.commandSha256 ? opts.commandSha256 : null;
  try {
    return onceLib.withLock(P.project, (fence) => {
      let cur;
      try { cur = readRaw(P.project, lang, P); } catch { return { ok: false, reason: 'absent' }; }
      if (!cur.present || !hasOwn(cur.data.settings, key)) return { ok: false, reason: 'absent' };
      const ent = cur.data.settings[key];
      if (!isObj(ent) || !hasOwn(ent, 'expires_at')) return { ok: false, reason: 'absent' };
      const setAtMs = typeof ent.set_at === 'string' ? Date.parse(ent.set_at) : NaN;
      if (!Number.isFinite(setAtMs) || nowMs < setAtMs) return { ok: false, reason: 'clock' };
      if (ent.consumed_at) return { ok: false, reason: 'consumed' };
      const st = onceLib.onceState(ent, nowMs);
      if (!st || st.expired) return { ok: false, reason: 'expired' };
      // V09 FIFTH fix: the mirror-based checks above can both pass for two concurrent callers whenever the
      // lock lets their reads interleave. This rename is what actually enforces "at most one caller ever
      // wins" — independent of that lock's own correctness.
      const outcome = onceStore.consumeOnceGrant(path.dirname(P.project), key, nowMs, commandSha256);
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      const updated = Object.assign({}, ent, { consumed_at: new Date(nowMs).toISOString(), consumed_command_sha256: commandSha256 });
      const settings = Object.assign({}, cur.data.settings, { [key]: updated });
      atomicWriteJson(P.project, Object.assign({}, cur.data, { settings }), fence);
      return { ok: true };
    }, lockOptsOf(opts));
  } catch { return { ok: false, reason: 'absent' }; /* a lock/IO problem is never treated as an approval */ }
}

/** unset(key, opts) — removes the owner's own value. --global: the global file only. Otherwise a project-scope
 *  key leaves the project file; a global-scope key leaves the global file AND any (ignored) stray copy in the
 *  project file. A key unknown to the schema may still be removed when it literally sits in a target file.
 *  Each target file's read-decide-write is serialized with onceLib.withLock (CFG-09). Throws 'once_pending'
 *  exit 3 (V03, Codex recheck 2026-09-24) when the entry is a still-PENDING one-off grant — like set(), unset()
 *  may never be the thing that ends a pending one-off; only consumption, expiry, or an explicit "on" may. */
function unset(key, opts) {
  opts = opts || {};
  const { P, schema, lang } = writableKey(key, opts);
  const T = text.t(lang);
  const known = hasOwn(schema.settings, key);
  const wanted = opts.global ? [P.global] : known && schema.settings[key].scope === 'global' ? [P.global, P.project] : [P.project];
  const targets = [...new Set(wanted.map((f) => path.resolve(f)))];
  const precheck = targets.map((f) => ({ f, r: readRaw(f, lang, P) }));
  if (!known && !precheck.some((x) => x.r.present && hasOwn(x.r.data.settings, key))) throw unknownKeyError(key, schema, lang, 2);
  const bridge = known ? bridgeOf(key, schema, P, opts) : null;
  if (bridge) readBridge(bridge, lang, P); // fail closed before any write
  const before = known ? resolve(noFlags(opts)).settings[key].value : null;
  const removed = [];
  for (const f of targets) {
    onceLib.withLock(f, (fence) => {
      const r = readRaw(f, lang, P);
      if (!r.present || !hasOwn(r.data.settings, key)) return;
      const onceSt = onceLib.onceState(r.data.settings[key], nowMsOf(opts));
      if (onceSt && !onceSt.expired) throw new ConfigError('once_pending', T.oncePendingRefuse(key), 3, { key }); // V03
      const settings = Object.assign({}, r.data.settings);
      delete settings[key];
      atomicWriteJson(f, Object.assign({}, r.data, { settings }), fence);
      if (ONCE_KEYS.includes(key)) onceStore.removePendingOnceGrant(path.dirname(f), key); // hygiene (V09 FIFTH fix)
      removed.push(f);
    }, lockOptsOf(opts));
  }
  const entry = known ? resolve(noFlags(opts)).settings[key] : null;
  const bridged = bridge && entry ? applyBridge(bridge, entry.value, schema, lang, P) : null;
  return { key, removed: removed.length > 0, files: removed, files_pretty: removed.map((f) => prettyPath(f, P)), from: before, to: entry ? entry.value : null, entry, lang, bridge: bridged };
}

/** reset(opts) — removes every owner value from the project file (opts.global: the global file). Without
 *  opts.yes nothing is written and { confirmed:false, would_remove } comes back (CLI exit 3). A DAMAGED target
 *  file is the one way back from degraded mode (forge.md §0): { damaged:true, moved_to } — with opts.yes it is
 *  renamed to <file>.damaged-<time> (kept as a backup, never deleted) and a fresh empty settings file takes its
 *  place; without opts.yes nothing moves. Any other damaged file (the other settings file, a legacy bridge file)
 *  still refuses the reset (exit 2). The whole validate-then-write sequence runs inside onceLib.withLock on
 *  `file` (CFG-09) so a concurrent reset/set on the same file can never race. */
function reset(opts) {
  opts = opts || {};
  const P = pathsFor(opts);
  const schema = loadSchema(P.schema, opts);
  const lang = detectLang(opts, P);
  const file = opts.global ? P.global : P.project;
  return onceLib.withLock(file, (fence) => {
    try { readConfigFile(file, schema, lockedIds(schema, opts).ids, lang, P, nowMsOf(opts)); } // full validation first
    catch (e) {
      if (!(e instanceof ConfigError) || e.code !== 'malformed') throw e;
      const aside = file + '.damaged-' + new Date(nowMsOf(opts)).toISOString().replace(/[:.]/g, '-');
      const base = { file, file_pretty: prettyPath(file, P), global: !!opts.global, would_remove: [], removed: [], lang, damaged: true, reason: e.message, moved_to: aside, moved_to_pretty: prettyPath(aside, P) };
      if (!opts.yes) return Object.assign(base, { confirmed: false });
      renameWithRetry(file, aside);
      atomicWriteJson(file, { version: 1, settings: {} }, fence);
      return Object.assign(base, { confirmed: true, bridges: [] });
    }
    const r = readRaw(file, lang, P);
    const keys = r.present ? Object.keys(r.data.settings) : [];
    const base = { file, file_pretty: prettyPath(file, P), global: !!opts.global, would_remove: keys, lang };
    if (!opts.yes) return Object.assign(base, { confirmed: false, removed: [] });
    const bridges = keys.filter((k) => hasOwn(schema.settings, k)).map((k) => bridgeOf(k, schema, P, opts)).filter(Boolean);
    for (const b of bridges) readBridge(b, lang, P); // fail closed before any write
    if (keys.length) atomicWriteJson(file, Object.assign({}, r.data, { settings: {} }), fence);
    for (const k of keys) if (ONCE_KEYS.includes(k)) onceStore.removePendingOnceGrant(path.dirname(file), k); // hygiene
    const now = bridges.length ? resolve(noFlags(opts)).settings : null;
    return Object.assign(base, { confirmed: true, removed: keys, bridges: bridges.map((b) => applyBridge(b, now[b.key].value, schema, lang, P)) });
  }, lockOptsOf(opts));
}

// ---- bridges: legacy mirror files (see the header) ----
// The wording sits here, not in forge-config-text.cjs, because that file belonged to another work package when
// this landed; move it there with the next edit of that file.
const BRIDGE_TEXT = {
  en: {
    differs: (key, pretty, legacy, now) => 'Note: ' + pretty + ' says ' + legacy + ', but ' + key + ' is ' + now + '. Older parts of Forge (the dashboard, /forge) follow that file. Make them agree with: /forge config set ' + key + ' ' + now,
    marker: (key, marker) => 'Note: ' + marker + ' exists and forces ECC test mode ON for older parts of Forge, while ' + key + ' is off. Delete that file, or turn the setting on: /forge config set ' + key + ' on',
    unreadable: (key, pretty, msg) => 'Note: ' + pretty + ' could not be read (' + msg + '), so it was not compared with ' + key + '.',
    failed: (key, pretty, msg) => key + ' was saved, but ' + pretty + ' could not be updated (' + msg + '). Run the same command again.',
    unset: 'off (not set)',
  },
  nl: {
    differs: (key, pretty, legacy, now) => 'Let op: ' + pretty + ' zegt ' + legacy + ', maar ' + key + ' staat op ' + now + '. Oudere onderdelen van Forge (het dashboard, /forge) volgen dat bestand. Zet ze gelijk met: /forge config set ' + key + ' ' + now,
    marker: (key, marker) => 'Let op: ' + marker + ' bestaat en zet de ECC-testmodus voor oudere onderdelen van Forge altijd AAN, terwijl ' + key + ' op uit staat. Verwijder dat bestand, of zet de instelling aan: /forge config set ' + key + ' aan',
    unreadable: (key, pretty, msg) => 'Let op: ' + pretty + ' is niet leesbaar (' + msg + '), dus niet vergeleken met ' + key + '.',
    failed: (key, pretty, msg) => key + ' is opgeslagen, maar ' + pretty + ' kon niet worden bijgewerkt (' + msg + '). Voer hetzelfde commando nog eens uit.',
    unset: 'uit (niet ingesteld)',
  },
};
const BRIDGE_MARKERS = { 'ecc-full-test': ['.claude', 'ECC_TEST_MODE.md'] }; // its presence forces the legacy reader ON (server.cjs eccMode)
function bridgeOf(key, schema, P, opts) {
  const spec = schema.settings[key];
  if (!spec || spec.type !== 'bool' || typeof spec.bridge !== 'string') return null;
  const i = spec.bridge.lastIndexOf(':');
  const rel = i > 0 ? spec.bridge.slice(0, i) : '';
  const field = spec.bridge.slice(i + 1);
  const abs = path.resolve(P.projectRoot, rel);
  const inside = path.relative(P.projectRoot, abs);
  if (!rel || path.isAbsolute(rel) || !inside || inside.startsWith('..') || !/^[A-Za-z0-9_]+$/.test(field)) return null; // project-local files only
  const seam = opts && isObj(opts.bridgePaths) && typeof opts.bridgePaths[key] === 'string' ? opts.bridgePaths[key] : null;
  const file = seam || abs;
  const marker = BRIDGE_MARKERS[key] ? path.join(P.projectRoot, ...BRIDGE_MARKERS[key]) : null;
  return { key, file, field, marker, pretty: prettyPath(file, P) + ' ' + field, defaultWord: spec.default ? 'on' : 'off' };
}
/** readBridge -> { present, data, raw, marker } — throws ConfigError 'malformed' (exit 2) on a damaged file. */
function readBridge(b, lang, P) {
  const r = readJsonObject(b.file, lang, P);
  return { present: r.present, data: r.data, raw: r.present ? r.data[b.field] : undefined, marker: !!(b.marker && fs.existsSync(b.marker)) };
}
/** bridgeStatus -> null (no bridge) | { file_pretty, field, legacy, marker, agrees, notes } — never throws. */
function bridgeStatus(key, schema, P, opts, value, lang) {
  const b = bridgeOf(key, schema, P, opts);
  if (!b) return null;
  const T = BRIDGE_TEXT[lang] || BRIDGE_TEXT.en;
  let cur;
  try { cur = readBridge(b, lang, P); }
  catch (e) { return { file_pretty: b.pretty, field: b.field, legacy: null, marker: false, agrees: null, notes: [T.unreadable(key, b.pretty, e.message)] }; }
  const legacyOn = cur.raw === 'on' || cur.marker; // exactly what forge-dashboard/server.cjs eccMode() concludes
  const agrees = legacyOn === (value === true);
  const now = shortWord(schema.settings[key], value, lang);
  let notes = [];
  if (!agrees && cur.marker && value !== true) notes = [T.marker(key, prettyPath(b.marker, P))];
  else if (!agrees) notes = [T.differs(key, b.pretty, cur.raw === undefined ? T.unset : JSON.stringify(cur.raw), now)];
  return { file_pretty: b.pretty, field: b.field, legacy: cur.raw === undefined ? null : cur.raw, marker: cur.marker, agrees, notes };
}
/** applyBridge — writes "on"/"off" for the resolved value into the legacy file when it differs (a missing file
 *  already means the default, so the default is not written into it). An I/O failure after the settings file
 *  was saved is reported as 'bridge_failed' (exit 2) naming both files — never swallowed. */
function applyBridge(b, value, schema, lang, P) {
  const want = value ? 'on' : 'off';
  let written = false;
  try {
    const cur = readBridge(b, lang, P);
    if (!(cur.present ? cur.raw === want : want === b.defaultWord)) {
      atomicWriteJson(b.file, Object.assign({}, cur.data || {}, { [b.field]: want }));
      written = true;
    }
  } catch (e) {
    throw new ConfigError('bridge_failed', (BRIDGE_TEXT[lang] || BRIDGE_TEXT.en).failed(b.key, b.pretty, e.message), 2, { key: b.key, file: b.file });
  }
  const st = bridgeStatus(b.key, schema, P, { bridgePaths: { [b.key]: b.file } }, value, lang);
  return { file: b.file, file_pretty: b.pretty, field: b.field, value: want, written, agrees: st.agrees, notes: st.notes };
}
/** bridgeNotes -> the disagreement notes of every bridged setting (or only onlyKey) for list/explain. */
function bridgeNotes(schema, P, opts, r, onlyKey) {
  const out = [];
  for (const key of Object.keys(schema.settings)) {
    if (onlyKey && key !== onlyKey) continue;
    const st = bridgeStatus(key, schema, P, opts, r.settings[key].value, r.lang);
    if (st) out.push(...st.notes);
  }
  return out;
}

// ---- explain ----
function exampleValue(spec, current, lang) {
  if (spec.type === 'bool') return shortWord(spec, !current, lang);
  if (spec.type === 'enum') return spec.allowed.find((a) => a !== current) || spec.allowed[0];
  if (spec.type === 'int-or-auto') return current === 'auto' ? String(spec.max) : 'auto';
  if (current !== spec.default) return String(spec.default);
  return String(spec.default !== spec.max ? spec.max : spec.min);
}
/** explain(key, opts) -> everything a beginner needs about one setting (or {locked:true, text} for a locked id). */
function explain(key, opts) {
  opts = opts || {};
  const k = lookupKey(key, opts);
  if (k.locked) {
    const item = lockedItem(key, k.schema);
    return { key, locked: true, lang: k.lang, text: item ? item[k.lang] || item.en : '', source: item ? item.source || null : null };
  }
  const r = resolve(opts);
  const lang = r.lang;
  const spec = k.schema.settings[key];
  const e = r.settings[key];
  const T = text.t(lang);
  let undo = { command: null, text: T.undoDefault };
  if (e.source === 'project') undo = { command: '/forge config unset ' + key, text: null };
  else if (e.source === 'global') undo = { command: '/forge config unset ' + key + ' --global', text: null };
  else if (e.source === 'flag') undo = { command: null, text: T.undoFlag };
  return {
    key, locked: false, lang,
    type: spec.type, allowed: spec.allowed || null, min: hasOwn(spec, 'min') ? spec.min : null, max: hasOwn(spec, 'max') ? spec.max : null, unit: spec.unit || null,
    default: spec.default, default_display: displayValue(spec, spec.default, lang),
    scope: spec.scope, group: spec.group, group_title: k.schema.groups[spec.group][lang],
    desc: spec.desc[lang], off_means: spec.off_means ? spec.off_means[lang] : null, disclosure: spec.disclosure ? spec.disclosure[lang] : null,
    flags: (spec.flags || []).map((f) => ({ flag: f, meaning: T.flag[f] })),
    consumers: spec.consumers.slice(),
    aliases: isObj(spec.aliases) ? { nl: (spec.aliases.nl || []).slice(), en: (spec.aliases.en || []).slice() } : { nl: [], en: [] },
    current: e,
    change_example: '/forge config set ' + key + ' ' + exampleValue(spec, e.value, lang),
    undo,
    notes: r.notes.concat(bridgeNotes(k.schema, k.P, opts, r, key)),
  };
}

// ---- change detection ----
function readSessionState(file, lang, P) {
  const r = readJsonObject(file, lang, P);
  return r.present ? r : { present: false, data: {} };
}
function writeSeen(P, values, nowMs, lang) {
  const fresh = readSessionState(P.sessionState, lang, P); // re-read: never clobber a field another tool just wrote
  const seen = { hash: hashValues(values), at: new Date(nowMs).toISOString(), values };
  atomicWriteJson(P.sessionState, Object.assign({}, fresh.data, { config_seen: seen }));
  return Object.assign({ path: P.sessionState }, seen);
}
/** markSeen(opts) -> { hash, at, values, path } — records the current persistent values (per-run flags are
 *  never stored) as FORGE_SESSION_STATE.json.config_seen, preserving every other field of that file. */
function markSeen(opts) {
  opts = opts || {};
  const P = pathsFor(opts);
  const r = resolve(noFlags(opts));
  return writeSeen(P, valuesOf(r.settings), nowMsOf(opts), r.lang);
}
function logEvent(logEventPath, runId, eventType, extra) {
  if (!fs.existsSync(logEventPath)) return { status: null, stdout: '', stderr: 'log-event.cjs not found at ' + logEventPath };
  const r = spawnSync(process.execPath, [logEventPath, runId, eventType, JSON.stringify(extra)], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  return { status: r.status, stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? r.error.message : '') };
}
/** diff(opts) -> { changed:[{key, from, to, source, set_at, set_by}], first_run, seen_hash, current_hash, count,
 *  lines, logged, status, stdout, stderr, seen_marked, ... }. opts.flags are part of the comparison. With
 *  opts.run and at least one change, ONE config_changed event is logged via the real log-event.cjs.
 *  opts.markSeen records the persistent values afterwards — skipped when a requested log did not succeed. */
function diff(opts) {
  opts = opts || {};
  const P = pathsFor(opts);
  if (opts.run != null && !RUN_ID_RE.test(String(opts.run))) throw new ConfigError('usage', text.t(detectLang(opts, P)).badRun(opts.run), 2);
  const cur = resolve(opts);
  const lang = cur.lang;
  const persistent = opts.flags ? resolve(noFlags(opts)) : cur;
  const schema = loadSchema(P.schema, opts);
  const state = readSessionState(P.sessionState, lang, P);
  const cs = state.data.config_seen;
  const seen = isObj(cs) && isObj(cs.values) ? cs : null;
  const current = valuesOf(cur.settings);
  const nowMs = nowMsOf(opts);
  const changed = [];
  if (seen) {
    for (const key of Object.keys(current)) {
      const e = cur.settings[key];
      const had = hasOwn(seen.values, key);
      if (had ? seen.values[key] === current[key] : e.source === 'default') continue;
      const c = { key, from: had ? seen.values[key] : null, to: current[key], source: e.source, set_at: e.set_at, set_by: e.set_by };
      changed.push(e.expires_at ? Object.assign(c, { expires_at: e.expires_at }) : c);
    }
  }
  const word = (key, v) => (v == null ? null : shortWord(schema.settings[key], v, lang));
  const lines = (arrow) => changed.map((c) => text.changeLine(Object.assign({}, c, { from_word: word(c.key, c.from), to_word: word(c.key, c.to) }), lang, nowMs, arrow));
  const result = {
    changed, first_run: !seen, seen_hash: seen && typeof seen.hash === 'string' ? seen.hash : null, current_hash: hashValues(current),
    count: Object.keys(current).length, lines: lines('→'), lang, run: opts.run || null,
    logged: false, status: null, stdout: '', stderr: '', seen_marked: false,
  };
  if (opts.run && changed.length) {
    const extra = { agent: 'orchestrator', role: 'lead', runtime: 'internal', note: lines('->').join('; '), changed, count: changed.length };
    const r = logEvent(P.logEvent, String(opts.run), 'config_changed', extra);
    Object.assign(result, { logged: r.status === 0, status: r.status, stdout: r.stdout, stderr: r.stderr, logEventPath: P.logEvent });
  }
  if (opts.markSeen && (!opts.run || !changed.length || result.logged)) {
    result.seen = writeSeen(P, valuesOf(persistent.settings), nowMs, lang);
    result.seen_marked = true;
  }
  return result;
}

// ---- plain sentence -> exact set command (never writes) ----
function normText(s) {
  const folded = String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return ' ' + folded.replace(/[^a-z0-9%.,$ -]+/g, ' ').replace(/[.,](?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}
function valueWords(spec, lang) {
  if (spec.type === 'bool') return lang === 'nl' ? 'aan, uit' : 'on, off';
  if (spec.type === 'enum') return spec.allowed.join(', ');
  return (spec.type === 'int-or-auto' ? 'auto, ' : '') + spec.min + ' - ' + spec.max + (spec.unit ? ' ' + spec.unit : '');
}
function valueCandidates(spec, schema, hay) {
  const tokens = hay.trim().split(' ').filter(Boolean);
  const yes = synonyms(schema, 'true');
  const no = synonyms(schema, 'false');
  const out = [];
  if (spec.type === 'bool') {
    for (const tok of tokens) { const w = VERB_BOOL[tok] || tok; if (yes.includes(w)) out.push(true); else if (no.includes(w)) out.push(false); }
  } else if (spec.type === 'enum') {
    for (const tok of tokens) {
      const hit = spec.allowed.find((a) => a.toLowerCase() === tok || normLang(tok) === a);
      if (hit) out.push(hit);
      else if (spec.allowed.includes('off') && no.includes(VERB_BOOL[tok] || tok)) out.push('off');
    }
  } else {
    if (spec.type === 'int-or-auto' && tokens.includes('auto')) out.push('auto');
    for (const m of hay.matchAll(/(?:\s|\$)(\d+(?:[.,]\d+)?)(?=\s|%)/g)) out.push(m[1]);
  }
  return [...new Set(out.map((v) => JSON.stringify(v)))].map((v) => JSON.parse(v));
}
/** parseSentence(sentence, opts) -> { ok, key?, value?, command?, reason?, candidates?, message }. Matches the
 *  schema aliases (nl + en) and the value words; the longest matching alias wins, a tie between two settings
 *  is "ambiguous". A sentence about a locked item is answered with its locked text. Never writes. */
function parseSentence(sentence, opts) {
  opts = opts || {};
  const P = pathsFor(opts);
  const schema = loadSchema(P.schema, opts);
  const lang = detectLang(opts, P);
  const T = text.t(lang);
  const hay = normText(sentence);
  const hits = [];
  const consider = (key, alias, locked) => { const a = normText(alias); if (a.trim() && hay.includes(a)) hits.push({ key, len: a.trim().length, locked }); };
  for (const [key, spec] of Object.entries(schema.settings)) for (const a of aliasesOf(key, spec)) consider(key, a, false);
  for (const id of lockedIds(schema, opts).ids) { consider(id, id, true); consider(id, id.replace(/-/g, ' '), true); }
  if (!hits.length) return { ok: false, reason: 'no_key', message: T.parseNoKey };
  const maxLen = Math.max(...hits.map((h) => h.len));
  const keys = [...new Set(hits.filter((h) => h.len === maxLen).map((h) => h.key))];
  if (keys.length > 1) return { ok: false, reason: 'ambiguous', candidates: keys, message: T.parseAmbiguous(keys) };
  const key = keys[0];
  if (!hasOwn(schema.settings, key)) {
    const item = lockedItem(key, schema);
    return { ok: false, reason: 'locked', key, message: T.parseLocked(key, item ? item[lang] || item.en : '') };
  }
  const spec = schema.settings[key];
  const cands = valueCandidates(spec, schema, hay);
  let value;
  try {
    if (cands.length !== 1) throw new Error('no single value');
    value = parseValue(key, cands[0], schema, lang);
  } catch {
    return { ok: false, reason: 'no_value', key, candidates: cands, message: T.parseNoValue(key, valueWords(spec, lang)) };
  }
  const command = '/forge config set ' + key + ' ' + shortWord(spec, value, lang);
  return { ok: true, key, value, command, message: T.parseOk(command) };
}

module.exports = {
  resolve, get, safeGet, list, set, unset, reset, explain, diff, markSeen, parseValue, parseFlagValue,
  ConfigError, validateSchema, parseSentence, normLang, safeValueOf, consumeOnce,
  detectLang: (opts) => detectLang(opts, pathsFor(opts)),
  ONCE_KEYS, ONCE_MS, FAILSAFE_FLAGGED,
};
Object.defineProperty(module.exports, 'SCHEMA', { enumerable: true, get: () => loadSchema() });
Object.defineProperty(module.exports, 'DEFAULT_PATHS', { enumerable: true, get: () => pathsFor({}) });
Object.defineProperty(module.exports, 'LOCKED_IDS', { enumerable: true, get: () => [...lockedIds(loadSchema()).ids] });

// ---- CLI: the command-line layer lives in forge-config-cli.cjs (argv, dispatch, output, exit codes) ----
if (require.main === module) {
  process.exitCode = require('./forge-config-cli.cjs').main(process.argv.slice(2));
}
