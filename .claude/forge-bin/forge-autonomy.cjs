#!/usr/bin/env node
'use strict';
/**
 * forge-autonomy.cjs — continue-within-mission autonomy policy (WAVE B / B3, 2026-07-18). Answers ONE
 * question: "may Forge keep WORKING through a phase transition without re-asking the owner?" It NEVER
 * governs "may Forge do something irreversible?" — that question belongs entirely to
 * forge-actiongate.cjs's hard-gates classifier, which this file REQUIRES (never re-implements — the exact
 * regex-drift risk cc-risks/dd-autonomy flagged) and ALWAYS defers to before ever consulting a mode.
 * Zero-dependency (fs/path only).
 *
 * PRECEDENCE (highest wins, mirrors config/orchestration/FORGE_AUTONOMY.json's _doc):
 *   1. USAGE-LIMIT — input.atUsageLimit truthy always interrupts, regardless of mode.
 *   2. HARD GATE — forge-actiongate.classify(input.text, {configPath: opts.gatesPath, projectRoot}) fires
 *      (an irreversible action or a project-isolation escape) always interrupts, regardless of mode.
 *   3. MODE — only reached if neither 1 nor 2 fired. ask-each-phase interrupts on a plain phase
 *      transition (input.phaseTransition truthy); continue-within-mission and full-auto-within-mission
 *      both proceed on a plain phase transition without re-asking.
 *
 * MODEL:
 *   decide(input, opts) -> { proceed: boolean, reason: string, interruptedBy: string|null }
 *     input.text            — free text describing the action/phase (forwarded to actiongate.classify).
 *     input.path             — OPTIONAL target path, forwarded to actiongate.classify alongside
 *                               opts.projectRoot so the write-outside-root ISOLATION gate (a path-escape
 *                               check, not a text regex) can also always-interrupt through decide(), not
 *                               only the nine text/regex gates.
 *     input.phaseTransition — true when this decide() call represents a plain phase-boundary check.
 *     input.atUsageLimit    — true when the caller has independently confirmed a live usage-limit pause.
 *   opts.mode        — override the configured default mode for this call (mainly for tests/CLI --mode).
 *   opts.configPath   — override the default FORGE_AUTONOMY.json location (test hermeticity).
 *   opts.gatesPath    — override the default hard-gates.json location, forwarded to actiongate.classify
 *                       as its own opts.configPath (test hermeticity — kept as a distinct name from
 *                       opts.configPath so a caller can vary the two configs independently in a test).
 *   opts.projectRoot  — forwarded to actiongate.classify for its write-outside-root isolation check.
 *
 *   `interruptedBy` is set ONLY for an ALWAYS-interrupt (tier 1/2) stop — 'usage-limit' or a hard-gate id
 *   (e.g. 'deploy', 'git-push', 'write-outside-root'). A tier-3 mode-based stop (ask-each-phase) leaves
 *   interruptedBy null — it is a normal re-ask, not a hard interrupt.
 *
 * CLI:
 *   node forge-autonomy.cjs decide "<text>" [--phase] [--usage-limit] [--mode <mode>] [--json]
 * Exit codes: 0 = proceed · 3 = interrupted/stopped (mirrors forge-actiongate's gate=3 convention) ·
 * 2 = usage/config error.
 */
const fs = require('fs');
const path = require('path');
const actiongate = require('./forge-actiongate.cjs');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_AUTONOMY.json');

let _cache = null; // { path, data } — cached across calls in the SAME process; tests override via opts.configPath
function loadConfig(configPath) {
  const p = configPath || CONFIG_PATH;
  if (_cache && _cache.path === p) return _cache.data;
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data.default !== 'string' || !data.default) {
    throw new Error('forge-autonomy: ' + p + ' is missing a non-empty "default" mode');
  }
  if (!data.modes || typeof data.modes !== 'object' || Array.isArray(data.modes) || Object.keys(data.modes).length === 0) {
    throw new Error('forge-autonomy: ' + p + ' is missing a non-empty "modes" object');
  }
  if (!data.modes[data.default]) {
    throw new Error('forge-autonomy: ' + p + ' "default" (' + data.default + ') is not a key in "modes"');
  }
  if (!Array.isArray(data.always_interrupt)) {
    throw new Error('forge-autonomy: ' + p + ' is missing an "always_interrupt" array');
  }
  _cache = { path: p, data };
  return data;
}

/** decide(input, opts) -> { proceed, reason, interruptedBy } — see file header for the full contract. Pure
 *  given its inputs; the only I/O is the cached, synchronous config read (loadConfig) and whatever
 *  actiongate.classify() itself reads (hard-gates.json, cached the same way). Never throws for a normal
 *  decision — throws only on a malformed/missing config (loadConfig) or an unknown mode, matching
 *  forge-actiongate's "refuse malformed config rather than silently pass everything" posture. */
function decide(input, opts) {
  opts = opts || {};
  input = input || {};
  const cfg = loadConfig(opts.configPath);
  const mode = opts.mode || cfg.default;
  if (!cfg.modes[mode]) {
    throw new Error('forge-autonomy: unknown mode "' + mode + '" (known: ' + Object.keys(cfg.modes).join(', ') + ')');
  }

  // Tier 1 — usage-limit ALWAYS interrupts, regardless of mode.
  if (input.atUsageLimit) {
    return { proceed: false, reason: 'usage-limit pause is active — no autonomy mode can override it', interruptedBy: 'usage-limit' };
  }

  // Tier 2 — hard-gate classification via the SHARED forge-actiongate classifier. ALWAYS interrupts,
  // regardless of mode, including full-auto-within-mission.
  const gateOpts = {};
  if (opts.gatesPath) gateOpts.configPath = opts.gatesPath;
  if (opts.projectRoot) gateOpts.projectRoot = opts.projectRoot;
  const classified = actiongate.classify({ text: input.text != null ? input.text : '', path: input.path || null, project_root: opts.projectRoot || null }, gateOpts);
  if (classified.gate) {
    return { proceed: false, reason: classified.reason || ('hard gate "' + classified.id + '" triggered'), interruptedBy: classified.id };
  }

  // Tier 3 — mode logic. Only reached when neither always-interrupt tier fired.
  if (mode === 'ask-each-phase' && input.phaseTransition) {
    return { proceed: false, reason: 'ask-each-phase mode: phase transition requires owner confirmation before continuing', interruptedBy: null };
  }
  return { proceed: true, reason: 'no hard gate/usage-limit triggered; mode "' + mode + '" proceeds without re-asking', interruptedBy: null };
}

function getConfig(opts) { return loadConfig(opts && opts.configPath); }

module.exports = { decide, loadConfig, getConfig, CONFIG_PATH };

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, phase: false, usageLimit: false, mode: null, json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--phase') opts.phase = true;
    else if (a === '--usage-limit') opts.usageLimit = true;
    else if (a === '--mode') opts.mode = rest[++i];
    else if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-autonomy.cjs decide "<text>" [--phase] [--usage-limit] [--mode <mode>] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'decide') {
      const text = opts.positional[0] || '';
      const decideOpts = {};
      if (opts.mode) decideOpts.mode = opts.mode;
      const result = decide({ text, phaseTransition: opts.phase, atUsageLimit: opts.usageLimit }, decideOpts);
      if (opts.json) console.log(JSON.stringify(result));
      else if (result.proceed) console.log('PROCEED — ' + result.reason);
      else console.log('STOP' + (result.interruptedBy ? ' [' + result.interruptedBy + ']' : '') + ' — ' + result.reason);
      process.exitCode = result.proceed ? 0 : 3;
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-autonomy: ' + e.message);
    process.exitCode = 2;
  }
}
