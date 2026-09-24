#!/usr/bin/env node
'use strict';
/**
 * forge-echo.cjs — the "applied owner prefs/rules" ECHO (WAVE B / B4, 2026-07-18). The safety mechanism that
 * makes config/orchestration/precedence.md's ordering VISIBLE at run time instead of merely documented:
 * before intake, forge-router/commands/forge.md compose ONE line summarizing which owner-profile prefs
 * (forge-prefs.cjs, B1) and which active standing-rules (forge-standing.cjs, B2) apply to THIS run, and log
 * it as a single 'owner_prefs_loaded' event — registered in log-event.cjs KNOWN_EVENT_TYPES, forge-verify.cjs's
 * TERMINAL_TYPES (informational/one-shot mirror of profile_loaded/memory_loaded), and forge-dashboard/app.js's
 * SYNTH/taskStatus/actTag mirrors (the same 3-place event-registration discipline every Forge event type
 * follows). Zero-dependency (fs/path/child_process only). REQUIRES forge-prefs.cjs and forge-standing.cjs —
 * never re-implements either resolver's logic (same "single source of truth" discipline forge-actiongate.cjs
 * established for hard-gates.json).
 *
 * MODEL:
 *   composeEcho(matchParams, opts) -> { summary, prefsCount, activeRulesCount, shadowedCount, prefs, rules,
 *     shadowed, notes }
 *     PURE aside from the config reads prefs.list()/standing.match() themselves perform. matchParams is
 *     forwarded verbatim to forge-standing.match() ({type, paths, onRequest}); opts is forwarded to BOTH
 *     forge-prefs.list() (profilePath/globalProfilePath) and forge-standing.match() (rulesPath) — the same
 *     override-seam convention every sibling Wave-B tool uses for hermetic tests. `summary` is a single
 *     human-readable line: pref count (+ up to 5 key=value samples) and active standing-rule count (+ up to
 *     5 rule ids), plus a shadowed-count note when standing-rules shadowing occurred.
 *     v2.7.0 (2026-09-24): the echo also carries the resolved Forge SETTINGS from forge-config.cjs list() —
 *     ", config: <n> setting(s) [<up to 5 key=value, non-default sources first>]" plus configCount,
 *     configOverrides (source project/global/flag) and configChangedCount. opts.configOpts is forwarded to
 *     forge-config (configHome/projectRoot/prefsOpts seams); without its own prefsOpts it reuses this call's
 *     profilePath/globalProfilePath so both halves read the same owner profile. opts.configDiff (a
 *     forge-config diff() result) adds ", <k> changed since last run". forge-config.cjs is a SOFT sibling: a
 *     missing module or a damaged settings file is shown as "config: unreadable" in the summary with the reason
 *     as a "forge-config: ..." note — visible, never a crash of the prefs echo and never a silent "0 settings".
 *   emitEcho(runId, matchParams, opts) -> composes the echo, then logs it as event_type 'owner_prefs_loaded'
 *     via the project's real log-event.cjs (a real spawned subprocess — this module never appends to
 *     events.jsonl itself, so log-event.cjs's honesty/strict-mode enforcement always applies). opts.root
 *     picks which project's .claude/forge-dashboard/log-event.cjs + forge-runs/ to write into (default: two
 *     levels up from forge-bin, i.e. this project); opts.logEventPath overrides the log-event.cjs path
 *     directly (test hermeticity — point at a fixture copy so a test never writes into this repo's real
 *     forge-runs/). opts.agent overrides the logged `agent` field (default 'orchestrator'). Returns the
 *     composed echo PLUS { logged, status, stdout, stderr } from the spawn, so a caller can tell a real
 *     write from a refused one (e.g. a future STRICT_EVENTS rejection) — never silently swallows a failure.
 *
 * CLI:
 *   node forge-echo.cjs compose [--type <domain>] [--paths <glob,glob,...>] [--json]
 *   node forge-echo.cjs emit <run_id> [--type <domain>] [--paths <glob,glob,...>] [--agent <name>] [--json]
 * Exit codes: compose: 0 always (advisory, never a gate) · emit: 0 = event logged · 1 = log-event refused it
 *   · 2 = usage/config error.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const prefs = require('./forge-prefs.cjs');
const standing = require('./forge-standing.cjs');
// forge-config.cjs is a SOFT sibling (v2.7.0): the prefs/rules echo must keep working in a tree without it.
let configTool = null;
let configLoadError = null;
try { configTool = require('./forge-config.cjs'); } catch (e) { configLoadError = e.message; }
const OVERRIDE_SOURCES = ['project', 'global', 'flag'];

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');
const DEFAULT_LOG_EVENT_PATH = path.join(PROJECT_ROOT_DEFAULT, '.claude', 'forge-dashboard', 'log-event.cjs');
const MAX_SAMPLES = 5;

/** configPart(opts) -> { ok:true, count, overrides, samples, changed, notes } | { ok:false, reason } — the
 *  forge-config.cjs half of the echo. Never throws: an unavailable module or an unreadable settings file comes
 *  back as ok:false with the reason, which composeEcho() prints in the summary and the notes. */
function configPart(opts) {
  if (!configTool) return { ok: false, reason: 'forge-config.cjs not available (' + configLoadError + ')' };
  const co = Object.assign({}, opts.configOpts || {});
  if (!co.prefsOpts && (opts.profilePath || opts.globalProfilePath)) co.prefsOpts = { profilePath: opts.profilePath, globalProfilePath: opts.globalProfilePath };
  let L;
  try { L = configTool.list(Object.assign({}, co, { all: true })); }
  catch (e) { return { ok: false, reason: e.message }; }
  const settings = L.settings;
  const ordered = settings.filter((s) => s.source !== 'default').concat(settings.filter((s) => s.source === 'default'));
  const d = opts.configDiff;
  return {
    ok: true,
    count: settings.length,
    overrides: settings.filter((s) => OVERRIDE_SOURCES.includes(s.source)).map((s) => ({ key: s.key, value: s.value, source: s.source })),
    samples: ordered.slice(0, MAX_SAMPLES).map((s) => s.key + '=' + JSON.stringify(s.value)),
    changed: d && Array.isArray(d.changed) ? d.changed.length : 0,
    notes: L.notes || [],
  };
}

/** composeEcho — see file header. Never throws for a normal (even fully-empty) result; throws only if the
 *  underlying prefs.list()/standing.match() themselves throw (malformed config — same fail-closed rule
 *  those modules already enforce; this module adds no new failure mode of its own). */
function composeEcho(matchParams, opts) {
  opts = opts || {};
  const prefsResolved = prefs.list(opts);
  const matched = standing.match(matchParams || {}, opts);

  const prefsCount = prefsResolved.prefs.length;
  const activeRulesCount = matched.active.length;
  const shadowedCount = matched.shadowed.length;

  const prefBits = prefsResolved.prefs.slice(0, MAX_SAMPLES).map((p) => p.key + '=' + JSON.stringify(p.value));
  const ruleBits = matched.active.slice(0, MAX_SAMPLES).map((r) => r.id);

  let summary = 'owner prefs/rules applied: ' + prefsCount + ' pref(s)';
  if (prefBits.length) summary += ' [' + prefBits.join(', ') + (prefsCount > prefBits.length ? ', …' : '') + ']';
  summary += ', ' + activeRulesCount + ' active standing-rule(s)';
  if (ruleBits.length) summary += ' [' + ruleBits.join(', ') + (activeRulesCount > ruleBits.length ? ', …' : '') + ']';
  if (shadowedCount) summary += ', ' + shadowedCount + ' shadowed';

  const cfg = configPart(opts);
  const notes = (prefsResolved.notes || []).slice();
  if (cfg.ok) {
    summary += ', config: ' + cfg.count + ' setting(s)';
    if (cfg.samples.length) summary += ' [' + cfg.samples.join(', ') + (cfg.count > cfg.samples.length ? ', …' : '') + ']';
    if (cfg.changed) summary += ', ' + cfg.changed + ' changed since last run';
    for (const n of cfg.notes) notes.push('forge-config: ' + n);
  } else {
    summary += ', config: unreadable';
    notes.push('forge-config: ' + cfg.reason);
  }

  return {
    summary,
    prefsCount,
    activeRulesCount,
    shadowedCount,
    configCount: cfg.ok ? cfg.count : null,
    configOverrides: cfg.ok ? cfg.overrides : [],
    configChangedCount: cfg.ok ? cfg.changed : 0,
    prefs: prefsResolved.prefs,
    rules: matched.active,
    shadowed: matched.shadowed,
    notes,
  };
}

/** logEvent — spawns the REAL log-event.cjs (never a re-implementation of the append/hash-chain/strict-mode
 *  logic that file owns). Mirrors forge-verify.cjs's own CLI-side logEvent() helper 1:1. */
function logEvent(logEventPath, runId, eventType, extra) {
  const r = spawnSync(process.execPath, [logEventPath, runId, eventType, JSON.stringify(extra || {})], { encoding: 'utf8' });
  return r;
}

/** emitEcho — see file header. Throws only on a bad run_id (usage error, mirrors log-event.cjs's own run_id
 *  guard) or if composeEcho()'s underlying resolvers throw on malformed config. A log-event REFUSAL (STRICT
 *  mode rejection, non-zero exit) is reported honestly in the return value, never thrown/swallowed. */
function emitEcho(runId, matchParams, opts) {
  opts = opts || {};
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error('forge-echo: emitEcho requires a valid run_id (allowed: A-Z a-z 0-9 _ -), got: ' + JSON.stringify(runId));
  }
  const echo = composeEcho(matchParams, opts);
  const logEventPath = opts.logEventPath
    || path.join(opts.root ? path.resolve(opts.root) : PROJECT_ROOT_DEFAULT, '.claude', 'forge-dashboard', 'log-event.cjs');
  const extra = {
    agent: opts.agent || 'orchestrator',
    note: echo.summary,
    prefs_count: echo.prefsCount,
    active_rules_count: echo.activeRulesCount,
    shadowed_count: echo.shadowedCount,
    config_count: echo.configCount,
    config_overrides_count: echo.configOverrides.length,
    config_changed_count: echo.configChangedCount,
  };
  const r = logEvent(logEventPath, runId, 'owner_prefs_loaded', extra);
  return Object.assign(
    { logged: r.status === 0, status: r.status, stdout: r.stdout, stderr: r.stderr, logEventPath },
    echo,
  );
}

module.exports = { composeEcho, emitEcho, PROJECT_ROOT_DEFAULT, DEFAULT_LOG_EVENT_PATH };

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, type: null, paths: [], agent: null, json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--type') opts.type = rest[++i];
    else if (a === '--paths') opts.paths = (rest[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--agent') opts.agent = rest[++i];
    else if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-echo.cjs compose [--type <domain>] [--paths <glob,glob,...>] [--json]');
  console.error('       node forge-echo.cjs emit <run_id> [--type <domain>] [--paths <glob,glob,...>] [--agent <name>] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'compose') {
      const echo = composeEcho({ type: opts.type, paths: opts.paths }, {});
      if (opts.json) console.log(JSON.stringify(echo));
      else {
        console.log(echo.summary);
        for (const n of echo.notes) console.log('  note: ' + n);
      }
      process.exitCode = 0;
    } else if (opts.cmd === 'emit') {
      const runId = opts.positional[0];
      if (!runId) { console.error('forge-echo: emit requires <run_id>'); process.exitCode = 2; }
      else {
        const emitOpts = {};
        if (opts.agent) emitOpts.agent = opts.agent;
        const result = emitEcho(runId, { type: opts.type, paths: opts.paths }, emitOpts);
        if (opts.json) console.log(JSON.stringify(result));
        else console.log((result.logged ? 'LOGGED' : 'REFUSED') + ' owner_prefs_loaded — ' + result.summary);
        process.exitCode = result.logged ? 0 : 1;
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-echo: ' + e.message);
    process.exitCode = 2;
  }
}
