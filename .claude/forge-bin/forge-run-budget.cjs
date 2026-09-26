#!/usr/bin/env node
'use strict';
/**
 * forge-run-budget.cjs — the per-run COST CAP for UNATTENDED runs (2026-08-01). Zero-dependency, CommonJS,
 * Windows-safe.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────────────
 * Two cost-aware tools already live in this folder and neither can stop a run:
 *   · forge-cost.cjs calls itself a "cost/token sampler" in its own header. It RECORDS: it parses a saved
 *     `claude -p --output-format json` envelope and logs a cost_sampled event so the dashboard meter is
 *     real. Recording a number is not a brake.
 *   · usage-guard.cjs watches the SUBSCRIPTION WINDOW (the 5h session window and the weekly window) and
 *     pauses the Paperclip agents at the configured threshold (setting usage-guard.pause-at, default 98%). It is blind to one single run burning money inside a window
 *     that still has plenty of room.
 * So an unattended wrapper that loses the plot had no ceiling at all. This file is that ceiling.
 *
 * ── THE MECHANISM ─────────────────────────────────────────────────────────────────────────────────────
 * The Claude CLI has a real flag for this: `--max-budget-usd <amount>` ("Maximum dollar amount to spend on
 * API calls (only works with --print)"), verified present in `claude --help` on v2.1.220 on this machine.
 * Because it only works with --print, it applies to exactly the runs we want it to apply to — the headless
 * ones — and CANNOT affect the owner's interactive session. That is not a policy claim, it is the flag's
 * own constraint.
 *
 * This module does three things and deliberately no more:
 *   1. resolveCap()  — reads the CAP FROM CONFIG (config/orchestration/FORGE_RUN_BUDGET.json), applies a
 *      documented precedence, and CLAMPS the result to the configured floor/ceiling so that neither a typo
 *      nor an environment variable can widen the brake into meaninglessness or narrow it into an instant
 *      kill. There is a builtin fallback, but taking it is reported as `degraded: true` with a reason —
 *      "the config was missing" must never silently read as "no cap".
 *   2. budgetArgs()  — renders the flag, or refuses. It never emits a bare flag without its value.
 *   3. classifyOutcome() + recordVerdict() — the honest end status.
 *
 * ── THE HONEST END STATUS (the part that actually matters) ────────────────────────────────────────────
 * A run that stops because it hit its ceiling has NOT finished its work. Calling it done would be exactly
 * the fabricated completion this project's honesty rules exist to prevent. So:
 *   · the status is the literal string 'stopped_by_budget';
 *   · isCompletion() is true for 'completed' and for nothing else — 'stopped_by_budget', 'failed' and
 *     'unknown' are all false;
 *   · a verdict is written into the run directory as one JSON line, and forge-verify.cjs reads it as an
 *     exit-code gate, so a run carrying a budget stop can never exit 0.
 *
 * DETECTION HONESTY — read this before trusting classifyOutcome(). The exact wording the CLI prints when
 * it hits --max-budget-usd was NOT observed live: triggering it costs real money on the owner's account
 * and this work was done while the owner was asleep. Therefore the PRIMARY signal is wording-independent:
 * the `total_cost_usd` in the CLI's own JSON envelope having reached the cap we passed in. The text marker
 * (BUDGET_MARKER) is corroboration for the case where no envelope was captured, and it is written to be
 * broad enough to survive a rewording. When neither signal is available the answer is 'unknown' — which is
 * NOT a completion. Fail-closed is the whole point: an unattended run may be reported as stopped when it
 * actually finished (annoying, visible, correctable), never as finished when it actually stopped.
 *
 * ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────
 *   node forge-run-budget.cjs cap [--wrapper <name>] [--level L1|L2|L3|L4] [--root <dir>]
 *       -> prints ONLY the resolved number on stdout (so a .cmd/.sh wrapper can capture it), and the
 *          explanation on stderr. Exit 1 (and NOTHING on stdout) if no cap could be resolved — a wrapper
 *          that cannot read a cap must not start an unattended run.
 *   node forge-run-budget.cjs args [--wrapper <name>] [--level <L>]      -> prints `--max-budget-usd <n>`
 *   node forge-run-budget.cjs classify --run <runDir> --wrapper <name> --cap <n> [--exit <code>]
 *                                      [--envelope <file>] [--log <file>] [--root <dir>]
 *       -> classifies a finished unattended run and APPENDS the verdict line to <runDir>. Prints the
 *          status. Exit 0 only when the verdict is a real completion.
 *   node forge-run-budget.cjs stops --run <runDir> [--root <dir>]   -> prints the budget-stop count.
 *
 * --run CONTAINMENT (2026-09-26, external audit N4/Part V-G): `classify --run x` used to accept ANY
 * string and hand it straight to fs.mkdirSync — a bare token with no path separator (e.g. `x`, exactly the
 * audit's repro) silently created `<cwd>/x/` in the PROJECT ROOT instead of a real run directory. The CLI
 * layer (not recordVerdict() itself, which keeps taking a pre-resolved dir for direct/unit use) now
 * resolves --run through resolveRunDir(): a bare token (no `/`/`\`) is treated as a run id and joined under
 * `<root>/.claude/forge-runs/<id>`; a path-shaped value is resolved against <root> as before (unchanged for
 * the one real caller, maand-sweep.cmd, which always passes a real `.claude/forge-runs/<id>` path). Either
 * way the FINAL resolved path must land inside `<root>/.claude/forge-runs/` — anything that resolves
 * outside it (a bare id is safe by construction; a path-shaped value containing `..` is not) is refused
 * with a clear message and NOTHING is created.
 *
 * Module API: { CONFIG_REL, DEFAULTS, STATUS, VERDICT_FILE, BUDGET_MARKER, loadConfig, resolveCap,
 *               budgetArgs, classifyOutcome, isCompletion, countsAsStop, recordVerdict, readVerdicts,
 *               resolveRunDir,
 *               budgetStops, configOn, configRead }
 */
const fs = require('fs');
const path = require('path');

/** Where the cap lives, relative to a project's .claude/ directory. */
const CONFIG_REL = path.join('config', 'orchestration', 'FORGE_RUN_BUDGET.json');

/** The verdict trail, written INSIDE the run directory next to events.jsonl. A plain file rather than a
 *  new event_type on purpose: it needs no new shared vocabulary in log-event.cjs, and forge-verify.cjs
 *  already receives the run directory. */
const VERDICT_FILE = 'budget-verdicts.jsonl';

/** The builtin fallback. Taking it is always reported as degraded — it is a safety net for a missing or
 *  broken config file, NOT the place the cap is configured. The numbers mirror the shipped config so a
 *  degraded run behaves like a normal one instead of surprising anybody. */
const DEFAULTS = Object.freeze({
  default_usd: 5.0,
  limits: Object.freeze({ min_usd: 0.25, max_usd: 25.0 }),
  levels: Object.freeze({ L1: 2.0, L2: 5.0, L3: 10.0, L4: 20.0 }),
  wrappers: Object.freeze({}),
});

const STATUS = Object.freeze({
  COMPLETED: 'completed',
  STOPPED: 'stopped_by_budget',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

/** Corroborating text signal. Deliberately broad (the exact CLI wording is unverified — see the header)
 *  while still requiring the word "budget" or the flag name itself, so an unrelated line mentioning a
 *  "limit" cannot be mistaken for a budget stop. */
const BUDGET_MARKER = /(max[-_ ]?budget[-_ ]?usd)|(budget[^\n]{0,40}(exceed|reach|limit|cap|hit|stop))|((exceed|reach|hit)[^\n]{0,40}budget)/i;

const ENV_KEY = 'FORGE_RUN_BUDGET_USD';

// ---- config ------------------------------------------------------------------------------------------
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }

// ---- owner setting `budget-usd` (forge-config.cjs, v2.7.0) — soft-required, see resolveCap step 4 ----
let cfgModule = null;
try { cfgModule = require('./forge-config.cjs'); } catch { cfgModule = null; }
/** configRead(key, fallback, opts) -> { value, source, degraded, reason } via forge-config.safeGet (FAIL-SAFE,
 *  review-boss M3: a damaged settings file never switches a flagged feature on). `fallback` is this file's copy of
 *  the schema default, used only when forge-config.cjs is absent or broken; an older copy without safeGet is read
 *  through get(). Never throws. opts.projectRoot = the root this tool acts on (ignored when FORGE_PROJECT_ROOT is
 *  set); opts.configModule injects a module (tests; null = "absent"). */
function configRead(key, fallback, opts) {
  opts = opts || {};
  const mod = opts.configModule !== undefined ? opts.configModule : cfgModule;
  const o = opts.projectRoot && !process.env.FORGE_PROJECT_ROOT ? { projectRoot: opts.projectRoot } : {};
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
/** configOn(key, def, opts) -> just the value of configRead(). */
function configOn(key, def, opts) { return configRead(key, def, opts).value; }
const BUDGET_USD_DEFAULT = 5; // the schema default of budget-usd — only used when forge-config.cjs is absent
/** ownerBudget({root, configModule}) -> { value, source } ONLY when the owner really set budget-usd (any
 *  resolver source except the schema 'default') to a positive finite number; { note } when the settings could
 *  not be read (a degraded read is never an owner value); otherwise null. */
function ownerBudget(o) {
  const e = configRead('budget-usd', BUDGET_USD_DEFAULT, { projectRoot: o && o.root, configModule: o && o.configModule });
  if (e.degraded) return { note: 'owner setting budget-usd not used — ' + e.reason };
  if (e.source === 'default' || num(e.value) === null || e.value <= 0) return null;
  return { value: e.value, source: e.source };
}

/**
 * loadConfig({root|configFile}) -> { config, source, degraded, reason }
 * A missing or unreadable or malformed file is never fatal and never silently "uncapped": it returns the
 * builtin DEFAULTS with degraded:true and a reason naming what went wrong.
 */
function loadConfig(opts) {
  const o = opts || {};
  const file = o.configFile || path.join(o.root || path.join(__dirname, '..', '..'), '.claude', CONFIG_REL);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { config: DEFAULTS, source: 'builtin-fallback', degraded: true, reason: 'config file unreadable (' + file + '): ' + e.code, file }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { config: DEFAULTS, source: 'builtin-fallback', degraded: true, reason: 'config file is not valid JSON (' + file + '): ' + e.message, file }; }
  if (!parsed || typeof parsed !== 'object') {
    return { config: DEFAULTS, source: 'builtin-fallback', degraded: true, reason: 'config file is not an object (' + file + ')', file };
  }
  return { config: parsed, source: 'config', degraded: false, reason: null, file };
}

function limitsOf(cfg) {
  const l = (cfg && cfg.limits) || {};
  const min = num(l.min_usd);
  const max = num(l.max_usd);
  return {
    min: (min !== null && min > 0) ? min : DEFAULTS.limits.min_usd,
    max: (max !== null && max > 0) ? max : DEFAULTS.limits.max_usd,
  };
}

/**
 * resolveCap({wrapper, level}, {root|configFile, env, configModule}) -> {cap_usd, source, clamped, degraded, reason, wrapper, level, config_file}
 *
 * Precedence, most specific first:
 *   1. env FORGE_RUN_BUDGET_USD  — a deliberate one-off override. Garbage / 0 / negative is IGNORED (it
 *      falls through to the config) rather than honoured, because "the operator typed nonsense" must not
 *      become "this run has no brake" or "this run dies instantly".
 *   2. config.wrappers[<wrapper>]
 *   3. config.levels[<level>]    — case-insensitive (l2 == L2)
 *   4. the owner setting `budget-usd` (forge-config.cjs, v2.7.0) — ONLY when the owner actually set it
 *      (resolver source project/global/flag/product-default). The schema's own default (source 'default')
 *      never replaces step 5, so a project that set nothing behaves exactly as before. forge-config.cjs is
 *      soft-required and read through its fail-safe safeGet(): absent, throwing or a damaged settings file ->
 *      this step is skipped and `reason` says why (a degraded read is never an owner value). The resolver already range-checks the value
 *      (0.25-25); the clamp below still applies as belt-and-braces. Reported as source
 *      'forge-config.budget-usd (<resolver source>)'. When a more specific step wins over an owner value,
 *      `reason` says so, so the owner can see why their number was not used.
 *   5. config.default_usd
 *   6. DEFAULTS.default_usd      — builtin fallback, always reported degraded
 * The winner is then CLAMPED into [limits.min_usd, limits.max_usd]; a clamp is reported as 'min'/'max'.
 */
function resolveCap(sel, opts) {
  const s = sel || {};
  const o = opts || {};
  const env = o.env || process.env;
  const loaded = loadConfig(o);
  const cfg = loaded.config;
  const ownerRead = ownerBudget(o);
  const owner = ownerRead && !ownerRead.note ? ownerRead : null;
  const { min, max } = limitsOf(cfg);

  let cap = null;
  let source = null;
  const notes = [];
  if (ownerRead && ownerRead.note) notes.push(ownerRead.note);

  const rawEnv = env && env[ENV_KEY];
  if (rawEnv !== undefined && rawEnv !== null && String(rawEnv).trim() !== '') {
    const n = Number(String(rawEnv).trim());
    if (Number.isFinite(n) && n > 0) { cap = n; source = 'env.' + ENV_KEY; }
    else notes.push(ENV_KEY + '=' + JSON.stringify(String(rawEnv)) + ' is not a usable positive number and was ignored');
  }

  const wrappers = (cfg && typeof cfg.wrappers === 'object' && cfg.wrappers) || {};
  if (cap === null && s.wrapper && num(wrappers[s.wrapper]) !== null) {
    cap = wrappers[s.wrapper]; source = 'config.wrappers.' + s.wrapper;
  }
  const levels = (cfg && typeof cfg.levels === 'object' && cfg.levels) || {};
  if (cap === null && s.level) {
    const key = Object.keys(levels).find((k) => k.toLowerCase() === String(s.level).toLowerCase());
    if (key && num(levels[key]) !== null) { cap = levels[key]; source = 'config.levels.' + key; }
  }
  if (owner && cap !== null) {
    notes.push('your setting budget-usd=' + owner.value + ' (' + owner.source + ') is not used: ' + source + ' is more specific');
  }
  let ownerUsed = false;
  if (cap === null && owner) { cap = owner.value; source = 'forge-config.budget-usd (' + owner.source + ')'; ownerUsed = true; }
  if (cap === null && num(cfg && cfg.default_usd) !== null) { cap = cfg.default_usd; source = 'config.default'; }
  if (cap === null) {
    cap = DEFAULTS.default_usd;
    source = 'builtin-fallback';
    if (!loaded.degraded) notes.push('the config file has no usable default_usd');
  }
  if (loaded.degraded) {
    if (ownerUsed) notes.push('the amount came from ' + source + ', clamped by the builtin limits');
    source = 'builtin-fallback';
    notes.push(loaded.reason);
  }

  let clamped = null;
  if (cap > max) { cap = max; clamped = 'max'; notes.push('clamped down to the configured ceiling ' + max); }
  else if (cap < min) { cap = min; clamped = 'min'; notes.push('clamped up to the configured floor ' + min); }

  return {
    cap_usd: cap,
    source,
    clamped,
    degraded: source === 'builtin-fallback',
    reason: notes.length ? notes.join('; ') : null,
    wrapper: s.wrapper || null,
    level: s.level || null,
    config_file: loaded.file,
  };
}

// ---- the flag ----------------------------------------------------------------------------------------
/**
 * budgetArgs(cap) -> { ok, args, reason }
 * Renders the real CLI flag pair, or refuses with an empty argv. A bare `--max-budget-usd` with no value
 * would make the CLI swallow the NEXT argument as its amount, so a refusal must yield [] and never a
 * lone flag.
 */
function budgetArgs(cap) {
  const n = (typeof cap === 'number' && Number.isFinite(cap)) ? cap : null;
  if (n === null || n <= 0) return { ok: false, args: [], reason: 'not a positive finite cap: ' + String(cap) };
  return { ok: true, args: ['--max-budget-usd', String(n)], reason: null };
}

// ---- the verdict -------------------------------------------------------------------------------------
/** isCompletion(status) — true for a genuine completion and nothing else. */
function isCompletion(status) { return status === STATUS.COMPLETED; }

/**
 * classifyOutcome({exitCode, stdout, stderr, envelope, cap_usd}) -> {status, budget_stopped, cost_usd, reason}
 *
 * Order of evidence, strongest first:
 *   1. a cap was applied AND the envelope's own total_cost_usd reached it  -> stopped_by_budget
 *      (wording-independent, and true even on exit 0 — see the header on why the wording is unverified)
 *   2. a budget marker in stdout/stderr, UNLESS an envelope proves the cost stayed below the cap
 *      (corroboration may confirm a stop, never overrule a conclusive measurement) -> stopped_by_budget
 *   3. no cap was applied at all                                           -> unknown (an uncapped run
 *      cannot be certified as having respected a cap it never had)
 *   4. exitCode != 0                                                       -> failed (NOT invented as a
 *      budget stop: an ordinary crash is an ordinary crash)
 *   5. exitCode 0 with a cost below the cap                                -> completed
 *   6. exitCode 0 with no cost evidence                                    -> unknown (fail-closed)
 */
function classifyOutcome(res) {
  const r = res || {};
  const cap = num(r.cap_usd);
  const env = r.envelope && typeof r.envelope === 'object' ? r.envelope : null;
  const cost = env ? num(env.total_cost_usd) : null;
  const text = String(r.stdout || '') + '\n' + String(r.stderr || '');

  if (cap !== null && cost !== null && cost >= cap) {
    return { status: STATUS.STOPPED, budget_stopped: true, cost_usd: cost, cap_usd: cap,
      reason: 'the run reported total_cost_usd ' + cost + ' against a cap of ' + cap };
  }
  // The marker is CORROBORATION, so it may not overrule an envelope that proves the cap was never reached.
  // Found by the witness audit on 2026-08-01: this very wrapper is a Claude-NEWS sweep, so quoting the flag
  // name in its own report is normal work — and the old order classified that healthy run as stopped.
  const provenUnderCap = cap !== null && cost !== null && cost < cap;
  if (!provenUnderCap && BUDGET_MARKER.test(text)) {
    return { status: STATUS.STOPPED, budget_stopped: true, cost_usd: cost, cap_usd: cap,
      reason: 'a budget marker was found in the run output (text marker, corroborating evidence)' };
  }
  if (cap === null) {
    return { status: STATUS.UNKNOWN, budget_stopped: false, cost_usd: cost, cap_usd: null,
      reason: 'no cap was applied to this run, so it cannot be certified as having stayed inside one' };
  }
  const exit = r.exitCode;
  if (typeof exit === 'number' && exit !== 0) {
    return { status: STATUS.FAILED, budget_stopped: false, cost_usd: cost, cap_usd: cap,
      reason: 'the run exited ' + exit + ' with no budget evidence — an ordinary failure' };
  }
  if (cost !== null) {
    return { status: STATUS.COMPLETED, budget_stopped: false, cost_usd: cost, cap_usd: cap,
      reason: 'the run exited 0 having spent ' + cost + ' of its ' + cap + ' cap' };
  }
  return { status: STATUS.UNKNOWN, budget_stopped: false, cost_usd: null, cap_usd: cap,
    reason: 'the run exited 0 but reported no cost, so completion inside the cap is unproven' };
}

/**
 * countsAsStop(verdict) — the ONE predicate both the reporter and forge-verify's gate use.
 * 'unknown' and an unparseable line count, because a record we cannot read is not proof of completion —
 * the same rule forge-verify.cjs::gateCount already applies to a gate accessor that throws. A plain
 * 'failed' does NOT count here: an ordinary crash is a different problem with its own signals, and
 * folding it in would make this counter mean something other than what its label says.
 */
function countsAsStop(v) {
  if (!v || typeof v !== 'object') return true;
  if (v.parse_error) return true;
  return v.status === STATUS.STOPPED || v.status === STATUS.UNKNOWN;
}

/** resolveRunDir(raw, {root}) -> {ok:true, dir} | {ok:false, reason}. CLI-layer containment guard for
 *  --run (see the file header's "--run CONTAINMENT" note) — never called by recordVerdict()/readVerdicts()
 *  themselves, which keep accepting a pre-resolved dir for direct/unit use exactly as before. A bare token
 *  (no path separator) is treated as a run id and resolved under `<root>/.claude/forge-runs/<id>`; a
 *  path-shaped value is resolved against <root> as before. Either way the result must land INSIDE
 *  `<root>/.claude/forge-runs/` — refuses (never creates anything) otherwise. */
function resolveRunDir(raw, opts) {
  const o = opts || {};
  const root = path.resolve(o.root || process.cwd());
  const forgeRunsRoot = path.join(root, '.claude', 'forge-runs');
  if (!raw || !String(raw).trim()) return { ok: false, reason: '--run is required' };
  const hasSep = /[\\/]/.test(raw);
  const candidate = hasSep ? path.resolve(root, raw) : path.join(forgeRunsRoot, raw);
  const rel = path.relative(forgeRunsRoot, candidate);
  if (rel === '' || rel === '.') {
    return { ok: false, reason: '--run "' + raw + '" resolves to .claude/forge-runs itself, not a run directory inside it' };
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: '--run "' + raw + '" resolves outside .claude/forge-runs (' + candidate + ') — refusing to create anything there' };
  }
  return { ok: true, dir: candidate };
}

/** recordVerdict(verdict, {runDir}) -> {ok, file, reason}. Appends one JSON line; never throws. */
function recordVerdict(verdict, opts) {
  const o = opts || {};
  const dir = o.runDir;
  if (!dir) return { ok: false, file: null, reason: 'no runDir given' };
  const line = Object.assign({ ts: new Date().toISOString() }, verdict || {});
  const file = path.join(dir, VERDICT_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
    return { ok: true, file, reason: null };
  } catch (e) { return { ok: false, file, reason: e.message }; }
}

/** readVerdicts(runDir) -> array. A line that will not parse becomes {parse_error:true, raw} rather than
 *  being dropped — a silently discarded verdict is a silently clean run. */
function readVerdicts(runDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(runDir || '', VERDICT_FILE), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object') out.push(v);
      else out.push({ parse_error: true, raw: s });
    } catch { out.push({ parse_error: true, raw: s }); }
  }
  return out;
}

/** budgetStops(runDir) -> {verdicts, stops, count} — what forge-verify.cjs gates on. */
function budgetStops(runDir) {
  const verdicts = readVerdicts(runDir);
  const stops = verdicts.filter(countsAsStop);
  return { verdicts, stops, count: stops.length };
}

module.exports = {
  CONFIG_REL, DEFAULTS, STATUS, VERDICT_FILE, BUDGET_MARKER, ENV_KEY,
  loadConfig, resolveCap, budgetArgs, configOn, configRead,
  classifyOutcome, isCompletion, countsAsStop,
  recordVerdict, readVerdicts, budgetStops, resolveRunDir,
};

// ---- CLI ---------------------------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'cap';
  function arg(name, dflt) {
    const i = argv.indexOf('--' + name);
    return (i > -1 && argv[i + 1] !== undefined) ? argv[i + 1] : dflt;
  }
  function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
  function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

  try {
    if (cmd === 'cap' || cmd === 'args') {
      const r = resolveCap({ wrapper: arg('wrapper', null), level: arg('level', null) }, { root: arg('root', undefined) });
      const rendered = budgetArgs(r.cap_usd);
      if (!rendered.ok) {
        // Nothing on stdout on purpose: a wrapper capturing stdout must end up with an EMPTY variable and
        // refuse to start, rather than with a plausible-looking string.
        console.error('forge-run-budget: could not resolve a usable cap — ' + rendered.reason);
        process.exit(1);
      }
      console.error('forge-run-budget: cap $' + r.cap_usd + ' (source ' + r.source +
        (r.clamped ? ', clamped ' + r.clamped : '') + (r.degraded ? ', DEGRADED' : '') + ')' +
        (r.reason ? ' — ' + r.reason : ''));
      console.log(cmd === 'args' ? rendered.args.join(' ') : String(r.cap_usd));
      process.exit(0);
    }

    if (cmd === 'classify') {
      const rawRun = arg('run', null);
      if (!rawRun) { console.error('forge-run-budget classify: --run <runDir> is required'); process.exit(1); }
      const resolved = resolveRunDir(rawRun, { root: arg('root', undefined) });
      if (!resolved.ok) { console.error('forge-run-budget classify: ' + resolved.reason); process.exit(1); }
      const dir = resolved.dir;
      const envFile = arg('envelope', null);
      const logFile = arg('log', null);
      const exitRaw = arg('exit', null);
      const out = classifyOutcome({
        exitCode: exitRaw === null ? null : Number(exitRaw),
        cap_usd: arg('cap', null) === null ? null : Number(arg('cap', null)),
        envelope: envFile ? readJson(envFile) : null,
        stdout: logFile ? readText(logFile) : '',
        stderr: '',
      });
      const verdict = Object.assign({ wrapper: arg('wrapper', null) }, out);
      const w = recordVerdict(verdict, { runDir: dir });
      console.log(out.status + ' — ' + out.reason);
      if (!w.ok) console.error('forge-run-budget: could not write the verdict — ' + w.reason);
      process.exit(isCompletion(out.status) ? 0 : 1);
    }

    if (cmd === 'stops') {
      const rawRun = arg('run', null);
      if (!rawRun) { console.error('forge-run-budget stops: --run <runDir> is required'); process.exit(1); }
      const resolvedStops = resolveRunDir(rawRun, { root: arg('root', undefined) });
      if (!resolvedStops.ok) { console.error('forge-run-budget stops: ' + resolvedStops.reason); process.exit(1); }
      const dir = resolvedStops.dir;
      const s = budgetStops(dir);
      console.log(s.count + ' budget stop(s) in ' + s.verdicts.length + ' verdict(s)');
      for (const st of s.stops) console.log('  ' + (st.parse_error ? 'UNREADABLE: ' + st.raw : st.status + ' — ' + (st.reason || '')));
      process.exit(s.count ? 1 : 0);
    }

    console.error('usage: forge-run-budget.cjs cap|args|classify|stops [...]');
    process.exit(1);
  } catch (e) {
    console.error('forge-run-budget: unexpected error — ' + (e && e.message));
    process.exit(1);
  }
}
