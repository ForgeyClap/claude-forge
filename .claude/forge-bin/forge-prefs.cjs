#!/usr/bin/env node
'use strict';
/**
 * forge-prefs.cjs — owner-profile resolver (WAVE B / PIECE B1, 2026-07-18). Zero-dependency
 * (fs/path/os only). Reads the durable owner-preference layers Head Chef's B1 work package defines and
 * merges them into one resolved view, WITHOUT ever writing anything — this piece is read-only by design.
 * A later piece (B4) wires this into forge-router's intake pre-fill; a later `/forge remember` command
 * (not built here) is the ONLY thing ever allowed to promote a staged candidate into an active pref or
 * write a new one — this module has no write/promote/remember function at all.
 *
 * THREE MERGE LAYERS, lowest to highest precedence (a key present in a higher layer shadows the same
 * key in a lower layer; a key ABSENT from a layer simply falls through to the next layer down):
 *   1. project  — THIS project's own seed/snapshot: .claude/FORGE_OWNER_PROFILE.json (opts.profilePath
 *      overrides the path; the non-negotiable hermetic-test seam).
 *   2. global   — the owner-wide, owner-write-only copy: ~/.claude/FORGE_OWNER_PROFILE.json
 *      (opts.globalProfilePath overrides the path — a hermetic-test seam this module adds beyond the
 *      two explicitly named in the work package, because reading the REAL ~/.claude file from a test
 *      would make the test non-hermetic and machine-dependent; see forge-prefs.test.cjs section 3 for
 *      why this is required, not optional, to prove "global beats project" without touching a real
 *      home-directory file). Read-only, best-effort: a MISSING global file degrades to the layers below
 *      it with an honest note — it is normal for this layer to be absent (this project ships before the
 *      global copy is deployed) and must never crash the resolver.
 *   3. env      — an explicit power-user/CI override: the file at process.env.FORGE_OWNER_PROFILE, if
 *      that env var is set. Absent (env var unset) is the normal case and degrades the same as a missing
 *      global file.
 * "Missing" (ENOENT) is honest-degrade-with-a-note at EVERY layer. A PRESENT-but-malformed file at any
 * layer (invalid JSON, wrong top-level shape, or a pref entry that fails validateEntry — missing
 * value/source, an out-of-enum confidence, an out-of-pattern scope) THROWS — this module never silently
 * treats corrupt or garbage preference data as "no preference", because a caller acting on a
 * silently-degraded corrupt file could apply the WRONG default with no visible sign anything was wrong.
 * This is the same fail-closed posture forge-actiongate.cjs and forge-checkpoint.cjs use for their own
 * config/checkpoint files.
 *
 * PREF ENTRY SHAPE (validated by validateEntry, one per key inside a profile file's top-level "prefs"
 * object): { value: <any JSON value>, source: <non-empty string — verbatim owner quote or policy
 * filename, never fabricated>, confidence: 'evidenced'|'inferred', scope: 'global'|'domain:<slug>' }.
 *
 * CANDIDATES (separate file, separate function — listCandidates() only, never merged into resolve()'s
 * prefs): .claude/FORGE_PREF_CANDIDATES.json, shape { candidates: [...] } (opts.candidatesPath
 * overrides the path). STAGE-ONLY — a candidate is NEVER promoted to an active pref by this module,
 * regardless of its own status field. Missing candidates file degrades to an empty list + note;
 * present-but-malformed (not an object with a "candidates" array) throws, same fail-closed rule as the
 * profile layers.
 *
 * MODULE API:
 *   resolve(opts) -> { prefs: {key: entry}, layerOf: {key: 'project'|'global'|'env'}, layers: {project,
 *     global, env: {path, present}}, notes: [string,...] }
 *   get(key, opts) -> { found:false, key, notes } | { found:true, key, entry, layer, notes }
 *   list(opts) -> { prefs: [{key, value, source, confidence, scope, layer}, ...], layers, notes }
 *   listCandidates(opts) -> { present, candidates: [...], path?, note }
 *
 * CLI:
 *   node forge-prefs.cjs get <key> [--json]
 *   node forge-prefs.cjs list [--json]
 *   node forge-prefs.cjs candidates [--json]
 * Exit codes: get: 0 = found / 1 = not found / 2 = usage or a layer file is malformed (fail closed).
 *             list / candidates: 0 = printed (even an honestly-empty result) / 2 = malformed file.
 *             unknown/missing command: 2.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');
const DEFAULT_PROJECT_PROFILE_PATH = path.join(PROJECT_ROOT_DEFAULT, '.claude', 'FORGE_OWNER_PROFILE.json');
const DEFAULT_PROJECT_CANDIDATES_PATH = path.join(PROJECT_ROOT_DEFAULT, '.claude', 'FORGE_PREF_CANDIDATES.json');
const DEFAULT_GLOBAL_PROFILE_PATH = path.join(os.homedir(), '.claude', 'FORGE_OWNER_PROFILE.json');

const VALID_CONFIDENCE = new Set(['evidenced', 'inferred']);
const SCOPE_RE = /^global$|^domain:[A-Za-z0-9_-]+$/;

// ---- validation (fail closed — a malformed entry throws, it is never silently dropped or ignored) ----
function validateEntry(key, entry, filePath) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('forge-prefs: pref "' + key + '" in ' + filePath + ' must be an object, got ' + JSON.stringify(entry));
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'value')) {
    throw new Error('forge-prefs: pref "' + key + '" in ' + filePath + ' is missing "value"');
  }
  if (typeof entry.source !== 'string' || !entry.source.trim()) {
    throw new Error('forge-prefs: pref "' + key + '" in ' + filePath + ' must have a non-empty string "source" (verbatim owner quote or policy filename)');
  }
  if (!VALID_CONFIDENCE.has(entry.confidence)) {
    throw new Error('forge-prefs: pref "' + key + '" in ' + filePath + ' has an invalid "confidence" (must be "evidenced" or "inferred"): ' + JSON.stringify(entry.confidence));
  }
  if (typeof entry.scope !== 'string' || !SCOPE_RE.test(entry.scope)) {
    throw new Error('forge-prefs: pref "' + key + '" in ' + filePath + ' has an invalid "scope" (must be "global" or "domain:<slug>"): ' + JSON.stringify(entry.scope));
  }
}

/** loadProfileLayer(filePath, layerName) -> {present:false, prefs:{}, note} | {present:true, prefs, path}.
 *  ENOENT is the only case that degrades gracefully (present:false + note) — everything else (unreadable,
 *  invalid JSON, wrong shape, an invalid pref entry) throws. */
function loadProfileLayer(filePath, layerName) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { present: false, prefs: {}, note: layerName + ' layer: file not found (' + filePath + ') — degraded, not an error' };
    throw new Error('forge-prefs: ' + layerName + ' layer file unreadable (' + filePath + '): ' + e.message);
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-prefs: ' + layerName + ' layer file is not valid JSON (' + filePath + '): ' + e.message); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('forge-prefs: ' + layerName + ' layer file must be a JSON object (' + filePath + ')');
  }
  const prefsRaw = data.prefs;
  if (prefsRaw == null || typeof prefsRaw !== 'object' || Array.isArray(prefsRaw)) {
    throw new Error('forge-prefs: ' + layerName + ' layer file is missing a "prefs" object (' + filePath + ')');
  }
  for (const [key, entry] of Object.entries(prefsRaw)) validateEntry(key, entry, filePath);
  return { present: true, prefs: prefsRaw, path: filePath };
}

/** resolve(opts) -> merged view across project -> global -> env (ascending precedence). Never writes
 *  anything. opts.profilePath overrides the project layer's path; opts.globalProfilePath overrides the
 *  global layer's path (hermetic-test seam, see file header); process.env.FORGE_OWNER_PROFILE, if set,
 *  supplies the env layer's path (no opts seam needed — a test that wants a hermetic env layer sets/
 *  restores this env var itself around the call, same convention as sibling *_ROOT env vars). */
function resolve(opts) {
  opts = opts || {};
  const projectPath = opts.profilePath || DEFAULT_PROJECT_PROFILE_PATH;
  const globalPath = opts.globalProfilePath || DEFAULT_GLOBAL_PROFILE_PATH;
  const envPath = process.env.FORGE_OWNER_PROFILE || null;

  const projectLayer = loadProfileLayer(projectPath, 'project');
  const globalLayer = loadProfileLayer(globalPath, 'global');
  const envLayer = envPath
    ? loadProfileLayer(envPath, 'env')
    : { present: false, prefs: {}, note: 'env layer: FORGE_OWNER_PROFILE not set — degraded, not an error' };

  const prefs = {};
  const layerOf = {};
  for (const [k, v] of Object.entries(projectLayer.prefs)) { prefs[k] = v; layerOf[k] = 'project'; }
  for (const [k, v] of Object.entries(globalLayer.prefs)) { prefs[k] = v; layerOf[k] = 'global'; }
  for (const [k, v] of Object.entries(envLayer.prefs)) { prefs[k] = v; layerOf[k] = 'env'; }

  const notes = [];
  if (!projectLayer.present) notes.push(projectLayer.note);
  if (!globalLayer.present) notes.push(globalLayer.note);
  if (!envLayer.present) notes.push(envLayer.note);
  if (Object.keys(prefs).length === 0) notes.push('forge-prefs: no prefs resolved from any layer — honest empty result, nothing fabricated');

  return {
    prefs,
    layerOf,
    layers: {
      project: { path: projectPath, present: projectLayer.present },
      global: { path: globalPath, present: globalLayer.present },
      env: { path: envPath, present: envLayer.present },
    },
    notes,
  };
}

/** get(key, opts) -> {found:false, key, notes} | {found:true, key, entry, layer, notes}. */
function get(key, opts) {
  const r = resolve(opts);
  if (!Object.prototype.hasOwnProperty.call(r.prefs, key)) {
    return { found: false, key, notes: r.notes };
  }
  return { found: true, key, entry: r.prefs[key], layer: r.layerOf[key], notes: r.notes };
}

/** list(opts) -> a flat, CLI/report-friendly array view of resolve()'s merged prefs (sorted by key for
 *  deterministic output), plus the same layers/notes resolve() reports. */
function list(opts) {
  const r = resolve(opts);
  const prefs = Object.keys(r.prefs).sort().map((key) => {
    const entry = r.prefs[key];
    return { key, value: entry.value, source: entry.source, confidence: entry.confidence, scope: entry.scope, layer: r.layerOf[key] };
  });
  return { prefs, layers: r.layers, notes: r.notes };
}

/** listCandidates(opts) -> STAGE-ONLY view of the candidates file. NEVER merges into resolve()'s prefs,
 *  NEVER treats any candidate as active, regardless of a candidate's own fields. opts.candidatesPath
 *  overrides the path (hermetic-test seam, matches the work package's explicit naming). */
function listCandidates(opts) {
  opts = opts || {};
  const candPath = opts.candidatesPath || DEFAULT_PROJECT_CANDIDATES_PATH;
  let raw;
  try {
    raw = fs.readFileSync(candPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { present: false, candidates: [], path: candPath, note: 'candidates file not found (' + candPath + ') — STAGE-ONLY store, absent means no proposals yet, not an error' };
    }
    throw new Error('forge-prefs: candidates file unreadable (' + candPath + '): ' + e.message);
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-prefs: candidates file is not valid JSON (' + candPath + '): ' + e.message); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.candidates)) {
    throw new Error('forge-prefs: candidates file must be a JSON object with a "candidates" array (' + candPath + ')');
  }
  return {
    present: true,
    candidates: data.candidates,
    path: candPath,
    note: 'STAGE-ONLY — candidates are never auto-active; promotion requires an explicit owner action (not implemented by this module)',
  };
}

module.exports = {
  resolve, get, list, listCandidates,
  loadProfileLayer, validateEntry,
  DEFAULT_PROJECT_PROFILE_PATH, DEFAULT_PROJECT_CANDIDATES_PATH, DEFAULT_GLOBAL_PROFILE_PATH,
  PROJECT_ROOT_DEFAULT,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, json: false, positional: [] };
  for (const a of rest) {
    if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-prefs.cjs get <key> [--json]');
  console.error('       node forge-prefs.cjs list [--json]');
  console.error('       node forge-prefs.cjs candidates [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'get') {
      const key = opts.positional[0];
      if (!key) { console.error('forge-prefs: get requires <key>'); process.exitCode = 2; }
      else {
        const r = get(key, {});
        if (opts.json) console.log(JSON.stringify(r));
        else if (r.found) console.log(key + ' = ' + JSON.stringify(r.entry.value) + '  [' + r.layer + ']  source: ' + r.entry.source);
        else console.log(key + ': not found');
        process.exitCode = r.found ? 0 : 1;
      }
    } else if (opts.cmd === 'list') {
      const r = list({});
      if (opts.json) console.log(JSON.stringify(r));
      else {
        console.log('forge-prefs list — ' + r.prefs.length + ' resolved pref(s)');
        for (const p of r.prefs) console.log('  ' + p.key + ' = ' + JSON.stringify(p.value) + '  [' + p.layer + '/' + p.confidence + '/' + p.scope + ']');
        for (const n of r.notes) console.log('  note: ' + n);
      }
      process.exitCode = 0;
    } else if (opts.cmd === 'candidates') {
      const r = listCandidates({});
      if (opts.json) console.log(JSON.stringify(r));
      else {
        console.log('forge-prefs candidates — ' + r.candidates.length + ' staged (STAGE-ONLY, never active)');
        for (const c of r.candidates) console.log('  ' + JSON.stringify(c));
        console.log('  note: ' + r.note);
      }
      process.exitCode = 0;
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-prefs: ' + e.message);
    process.exitCode = 2;
  }
}
