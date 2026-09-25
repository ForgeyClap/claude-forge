#!/usr/bin/env node
'use strict';
/**
 * forge-autonomy.cjs — continue-within-mission autonomy policy (WAVE B / B3, 2026-07-18). Answers ONE
 * question: "may Forge keep WORKING through a phase transition without re-asking the owner?" It NEVER
 * governs "may Forge do something irreversible?" — that question belongs entirely to
 * forge-actiongate.cjs's hard-gates classifier, which this file REQUIRES (never re-implements — the exact
 * regex-drift risk cc-risks/dd-autonomy flagged) and ALWAYS defers to before ever consulting a mode.
 * Zero-dependency (fs/os/path only).
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
 *   interruptedBy null — it is a normal re-ask, not a hard interrupt. The result also names the `mode` used and
 *   `modeSource` ('opts.mode' · 'forge-config (<layer>)' · 'FORGE_AUTONOMY.json default').
 *
 * MODE (v2.7.0, 2026-09-24): opts.mode (the current instruction) > the owner's `/forge config` value `autonomy`
 *   (forge-config.cjs, soft-required, read through its fail-safe safeGet(); absent module, unreadable file or a
 *   value unknown here -> skipped, and a degraded read is named in the result's `config_note`) >
 *   FORGE_AUTONOMY.json "default". Seams: opts.configModule (null = absent), opts.configOpts (forge-config seams).
 *   decide() stays free of side effects and never looks at the live usage state; decideLive() does that:
 *
 *   usageLimitActive(opts) -> { active, reason, source: 'state'|'no-state'|'unreadable'|'guard-off'|'stale', file? }
 *     reads <opts.statePath | FORGE_USAGE_GUARD_STATE | (opts.guardHome | FORGE_USAGE_GUARD_HOME | ~/.claude)
 *     /FORGE_USAGE_GUARD_STATE.json> — active only when mode === 'paused' and its resumeAtEpoch (if any) has not
 *     passed yet (the same self-heal rule as the global usage-guard hook). CFG-01 (Codex recheck 2026-09-24):
 *     the state file is ALWAYS consulted, regardless of whether config `usage-guard` reads on, off, or
 *     degraded — "may forge-config collect NEW usage telemetry" (the switch; that decision belongs to
 *     usage-guard.cjs itself) is a SEPARATE question from "must an already-recorded, unexpired pause be
 *     honoured" (this function; a locked tier-1 gate, never optional). An unrelated malformed setting can
 *     therefore never disable enforcement of a pause that already happened. The switch is used only to WORD
 *     the reason when there is genuinely no pause on file (source 'guard-off') — it never gates the read.
 *     Read-only; never opens the account login file.
 *   decideLive(input, opts) -> decide() with input.atUsageLimit filled from usageLimitActive(), plus `usageLimit`.
 *
 * CLI:
 *   node forge-autonomy.cjs decide "<text>" [--phase] [--usage-limit] [--mode <mode>] [--live] [--json]
 *     --live = decideLive (reads the real usage-guard pause); without it the state file is never read.
 * Exit codes: 0 = proceed · 3 = interrupted/stopped (mirrors forge-actiongate's gate=3 convention) ·
 * 2 = usage/config error.
 */
const fs = require('fs');
const os = require('os');
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

/** configRead(key, fallback, opts) -> { value, source, degraded, reason } via forge-config.safeGet (FAIL-SAFE,
 *  review-boss M3: a damaged settings file never switches a flagged feature on — `usage-guard` carries C N U, so a
 *  degraded read is OFF). `fallback` is this file's copy of the schema default (the SAFE value for a flagged key),
 *  used only when forge-config.cjs is absent or broken; an older copy without safeGet is read through get(). Never
 *  throws. Seams: opts.configModule (null = absent), opts.configOpts (forge-config seams). */
function configRead(key, fallback, opts) {
  let mod = opts && opts.configModule;
  if (mod === undefined) { try { mod = require('./forge-config.cjs'); } catch { mod = null; } }
  const o = Object.assign({}, (opts && opts.configOpts) || {});
  let why = 'forge-config.cjs not found';
  try {
    if (mod && typeof mod.safeGet === 'function') {
      const r = mod.safeGet(key, Object.assign({ fallback }, o));
      if (r && typeof r.value === typeof fallback) return r;
      why = 'forge-config gave no usable value';
    } else if (mod && typeof mod.get === 'function') {
      const e = mod.get(key, o);
      if (e && typeof e.value === typeof fallback) return { value: e.value, source: e.source || 'unknown', degraded: false, reason: null };
      why = 'forge-config gave a value of the wrong type';
    }
  } catch (e) { why = 'settings unreadable: ' + ((e && e.message) || e); }
  return { value: fallback, source: 'built-in', degraded: true, reason: why + ' — ' + key + ' uses the built-in ' + JSON.stringify(fallback) };
}

/** resolveMode(cfg, opts) -> { mode, modeSource, configNote } — opts.mode > owner config `autonomy` > cfg.default.
 *  A degraded read (damaged settings, absent module) is skipped to cfg.default and named in configNote. */
function resolveMode(cfg, opts) {
  if (opts.mode) return { mode: opts.mode, modeSource: 'opts.mode', configNote: null };
  const e = configRead('autonomy', cfg.default, opts);
  if (!e.degraded && cfg.modes[e.value]) return { mode: e.value, modeSource: 'forge-config (' + e.source + ')', configNote: null };
  return { mode: cfg.default, modeSource: 'FORGE_AUTONOMY.json default', configNote: e.degraded ? e.reason : null };
}

/** decide(input, opts) -> { proceed, reason, interruptedBy, mode, modeSource } — see file header for the full
 *  contract. Free of side effects; the only I/O is the cached, synchronous config read (loadConfig), the owner's
 *  `/forge config` read (configRead via safeGet, soft) and whatever actiongate.classify() itself reads (hard-gates.json,
 *  cached the same way). It never reads the live usage state — that is decideLive(). Never throws for a normal
 *  decision — throws only on a malformed/missing FORGE_AUTONOMY.json (loadConfig) or an unknown opts.mode,
 *  matching forge-actiongate's "refuse malformed config rather than silently pass everything" posture. */
function decide(input, opts) {
  opts = opts || {};
  input = input || {};
  const cfg = loadConfig(opts.configPath);
  const { mode, modeSource, configNote } = resolveMode(cfg, opts);
  const tag = (r) => Object.assign(r, { mode, modeSource }, configNote ? { config_note: configNote } : {});
  if (!cfg.modes[mode]) {
    throw new Error('forge-autonomy: unknown mode "' + mode + '" (known: ' + Object.keys(cfg.modes).join(', ') + ')');
  }

  // Tier 1 — usage-limit ALWAYS interrupts, regardless of mode.
  if (input.atUsageLimit) {
    return tag({ proceed: false, reason: 'usage-limit pause is active — no autonomy mode can override it', interruptedBy: 'usage-limit' });
  }

  // Tier 2 — hard-gate classification via the SHARED forge-actiongate classifier. ALWAYS interrupts,
  // regardless of mode, including full-auto-within-mission.
  const gateOpts = {};
  if (opts.gatesPath) gateOpts.configPath = opts.gatesPath;
  if (opts.projectRoot) gateOpts.projectRoot = opts.projectRoot;
  const classified = actiongate.classify({ text: input.text != null ? input.text : '', path: input.path || null, project_root: opts.projectRoot || null }, gateOpts);
  if (classified.gate) {
    return tag({ proceed: false, reason: classified.reason || ('hard gate "' + classified.id + '" triggered'), interruptedBy: classified.id });
  }

  // Tier 3 — mode logic. Only reached when neither always-interrupt tier fired.
  if (mode === 'ask-each-phase' && input.phaseTransition) {
    return tag({ proceed: false, reason: 'ask-each-phase mode: phase transition requires owner confirmation before continuing', interruptedBy: null });
  }
  return tag({ proceed: true, reason: 'no hard gate/usage-limit triggered; mode "' + mode + '" proceeds without re-asking', interruptedBy: null });
}

function getConfig(opts) { return loadConfig(opts && opts.configPath); }

const STALE_INTERVALS = 3;
const GUARD_INTERVAL_DEFAULT_SEC = 120;
const GUARD_INTERVAL_MIN_SEC = 30; // the guard itself never checks more often (usage-guard.cjs INTERVAL)
/** guardIntervalSec(opts) — opts.intervalSec > owner config `usage-guard.interval` > 120, never below 30. */
function guardIntervalSec(opts) {
  const fromOpts = typeof opts.intervalSec === 'number' && Number.isFinite(opts.intervalSec) && opts.intervalSec > 0 ? opts.intervalSec : null;
  const e = fromOpts === null ? configRead('usage-guard.interval', GUARD_INTERVAL_DEFAULT_SEC, opts) : null;
  const fromCfg = e && typeof e.value === 'number' && Number.isFinite(e.value) && e.value > 0 ? e.value : null;
  return Math.max(GUARD_INTERVAL_MIN_SEC, fromOpts !== null ? fromOpts : (fromCfg !== null ? fromCfg : GUARD_INTERVAL_DEFAULT_SEC));
}
/** stalePauseNote(st, now, opts) -> a plain note when this paused state comes from a guard that stopped checking
 *  (newest of lastCheckAt / heartbeatAt older than STALE_INTERVALS x the interval), else null (fresh, or no
 *  timestamp to judge by). L8, wp20 2026-09-24. */
function stalePauseNote(st, now, opts) {
  const stamps = [st.lastCheckAt, st.heartbeatAt].map((t) => (typeof t === 'string' ? Date.parse(t) : NaN)).filter(Number.isFinite);
  if (!stamps.length) return null;
  const ageSec = Math.round((now - Math.max(...stamps)) / 1000);
  const intervalSec = guardIntervalSec(opts);
  if (ageSec <= intervalSec * STALE_INTERVALS) return null;
  return 'usage guard state says "paused" but its last check was ' + ageSec + ' s ago (more than ' + STALE_INTERVALS + ' x the '
    + intervalSec + ' s interval) and no reset time is recorded — the watcher is not running, so this stale pause is NOT treated as active'
    + ' (restart it: node .claude/forge-bin/usage-guard.cjs start)';
}

/** usageLimitActive(opts) -> { active, reason, source, file? } — is the REAL usage guard pausing this account right
 *  now? See the file header for the path order and the self-heal rule. Read-only, never throws. */
function usageLimitActive(opts) {
  opts = opts || {};
  const sw = configRead('usage-guard', false, opts); // labels the reason only; it never gates the state-file read (CFG-01)
  const guardOffResult = () => {
    const why = sw.degraded ? 'usage-guard counts as off (settings unreadable: ' + sw.reason + ')' : 'usage-guard is off in the owner config';
    return Object.assign({ active: false, reason: why + ' - no pause is currently recorded', source: 'guard-off', file }, sw.degraded ? { config_note: sw.reason } : {});
  };
  const home = opts.guardHome || process.env.FORGE_USAGE_GUARD_HOME || path.join(os.homedir(), '.claude');
  const file = opts.statePath || process.env.FORGE_USAGE_GUARD_STATE || path.join(home, 'FORGE_USAGE_GUARD_STATE.json');
  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '')); } catch (e) {
    if (e && e.code === 'ENOENT') return sw.value === false ? guardOffResult() : { active: false, reason: 'no usage-guard state file — no pause was ever recorded', source: 'no-state', file };
    return { active: false, reason: 'usage-guard state unreadable (' + ((e && e.message) || e) + ') — not treated as a pause', source: 'unreadable', file };
  }
  if (!st || st.mode !== 'paused') return sw.value === false ? guardOffResult() : { active: false, reason: 'usage guard is not paused', source: 'state', file };
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  // SB-M6 (2026-09-24, Security Boss wave 11, sec-w11): since wave 10 a resume attempt that keeps failing
  // (e.g. an agent that no longer exists — see usage-guard.cjs's own doResume()/runOverrideOn() SB-M6 fix)
  // leaves mode:'paused' with a fresh lastCheckAt on every tick, so the STALE-pause escape hatch above never
  // fires either. An owner who already PAID for a usage-override (extra credits) could therefore be blocked
  // forever by a bookkeeping retry loop that has nothing to do with the plan-limit this pause originally
  // protected against. `st.ownerOverride` is written FRESH every real tick straight from the authoritative
  // grant record the moment it is actually honoured (usage-guard.cjs's tick() / usage-guard-override.cjs's
  // resolveOwnerOverride()) — reading it here reads THAT already-honoured decision, not a stale flag being
  // trusted to greenlight a NEW pause (usage-guard.cjs's own tick() keeps that rule entirely; this file never
  // makes a pause/resume decision itself). An override with no `until`, or one that has already expired, is
  // NOT honoured here — fail toward blocking, exactly like the real guard would once it next reconciles.
  const ov = st.ownerOverride;
  if (ov && ov.active === true && typeof ov.until === 'string' && Number.isFinite(Date.parse(ov.until)) && Date.parse(ov.until) > now) {
    return { active: false, reason: 'usage guard shows "paused" but a paid usage-override is currently honoured for this account (a resume-bookkeeping retry may still be catching up) — not treated as a live usage-limit block', source: 'override-honoured', file };
  }
  const resumeAt = Number(st.resumeAtEpoch);
  if (Number.isFinite(resumeAt) && now >= resumeAt) {
    return { active: false, reason: 'the pause has passed its reset time — the guard resumes on its next check', source: 'state', file };
  }
  if (!Number.isFinite(resumeAt)) {
    const stale = stalePauseNote(st, now, opts);
    if (stale) return { active: false, reason: stale, source: 'stale', file };
  }
  const pct = st.percents ? ' (session ' + st.percents.session + '% · week ' + st.percents.week + '%)' : '';
  return { active: true, reason: 'usage guard paused this account' + pct, source: 'state', file };
}

/** decideLive(input, opts) -> decide() with input.atUsageLimit filled from usageLimitActive(opts) (an explicit
 *  input.atUsageLimit:true is kept), plus `usageLimit` = the usageLimitActive() result. */
function decideLive(input, opts) {
  const lim = usageLimitActive(opts);
  const inp = Object.assign({}, input || {});
  inp.atUsageLimit = !!inp.atUsageLimit || lim.active;
  return Object.assign(decide(inp, opts), { usageLimit: lim });
}

module.exports = { decide, decideLive, usageLimitActive, loadConfig, getConfig, configRead, CONFIG_PATH };

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, phase: false, usageLimit: false, live: false, mode: null, json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--phase') opts.phase = true;
    else if (a === '--usage-limit') opts.usageLimit = true;
    else if (a === '--mode') opts.mode = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--live') opts.live = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-autonomy.cjs decide "<text>" [--phase] [--usage-limit] [--mode <mode>] [--live] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'decide') {
      const text = opts.positional[0] || '';
      const decideOpts = {};
      if (opts.mode) decideOpts.mode = opts.mode;
      const input = { text, phaseTransition: opts.phase, atUsageLimit: opts.usageLimit };
      const result = opts.live ? decideLive(input, decideOpts) : decide(input, decideOpts);
      const note = result.config_note || (result.usageLimit && result.usageLimit.config_note);
      if (note) console.error('NOTE (settings): ' + note);
      if (opts.json) console.log(JSON.stringify(result));
      else if (result.proceed) console.log('PROCEED — ' + result.reason + ' [mode ' + result.mode + ' · ' + result.modeSource + ']');
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
