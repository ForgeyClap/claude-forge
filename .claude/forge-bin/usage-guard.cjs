#!/usr/bin/env node
'use strict';
/**
 * Forge Usage Guard — REAL subscription usage watchdog (zero-dependency).
 *
 * Reads the OFFICIAL Anthropic OAuth usage endpoint (the same source as /usage in Claude Code —
 * no estimates, no log-counting). At >= pause-at % (default 98, see SETTINGS) on the 5h session window OR the
 * weekly window it PAUSES all Paperclip agents (runtime/dashboard stays UP) and writes a global
 * state file that the global usage-guard hook uses to (a) tell active Claude sessions to PAUSE
 * (in-chat, via PreToolUse deny + UserPromptSubmit context) and (b) after reset, tell them to
 * CONTINUE + run a mandatory checkup. Resumes automatically when the triggering metric is back
 * to <= resume-at % (default 0 — i.e. after the reset).
 *
 * HONESTY RULES: percentages are always the live endpoint values; on ANY fetch error the guard
 * takes NO action (fail-safe) and logs the error; it only auto-resumes agents IT paused (never
 * agents a human paused earlier); the OAuth token is read in-memory and NEVER logged/printed.
 *
 * Usage:
 *   node .claude/forge-bin/usage-guard.cjs check                    # one-shot: print real usage %
 *   node .claude/forge-bin/usage-guard.cjs status                   # settings (+ where each came from), guard state, live %
 *   node .claude/forge-bin/usage-guard.cjs watch [--interval 120] [--pause-at 98] [--resume-at 0]
 *                                          [--nvidia-shift-at 80] [--grace-min 5] [--companies a,b]
 *                                          [--once] [--state <file>] [--dry-run]
 *   node .claude/forge-bin/usage-guard.cjs start [--force]          # detached watch (single instance); exit 3 when the
 *                                                                   # owner switched the guard off (see SETTINGS)
 *   node .claude/forge-bin/usage-guard.cjs stop                     # stop the detached watcher
 *   node .claude/forge-bin/usage-guard.cjs credits                  # print purchased usage-credit balance (extra_usage)
 *   node .claude/forge-bin/usage-guard.cjs override-on [--reason ..] [--until <iso>]  # work on credits: suppress the plan-limit guard until credits run out
 *   node .claude/forge-bin/usage-guard.cjs override-off             # re-arm the normal plan-limit guard
 *
 * OWNER OVERRIDE: when usage credits are bought, `override-on` sets state.ownerOverride so the guard
 * (and the session hook) stop pausing on the plan limit; the watchdog auto-clears it the moment the
 * credits are exhausted (extra_usage used >= limit / disabled) and re-arms the normal guard.
 *
 * RESET-RHYTHM AUTO-RESUME: on pause, the guard also stores `resumeAtEpoch` = the SOONEST crossed
 * metric's official `resets_at` + `--grace-min` (default 5) minutes. The exact reset second can flip
 * the usage endpoint before a poll observes it, so resume is deliberately timed ~5 min AFTER the
 * reset instant rather than racing it. While paused, tick() resumes on EITHER the real utilization
 * dropping to <= resume-at (existing behavior) OR wall-clock time reaching resumeAtEpoch — whichever
 * comes first. resumeAtEpoch is cleared on every resume and recomputed fresh from the next pause.
 *
 * NVIDIA-SHIFT SOFT THRESHOLD (owner policy, advisory only — never pauses/blocks anything): at
 * `--nvidia-shift-at` (default 80) weekly usage %, the guard signals that NVIDIA agents should be
 * PREFERRED over Claude agents for new routing decisions, without any quality downgrade. This is
 * purely a routing hint for callers (e.g. forge-router) — the existing pause behavior at `--pause-at`
 * is completely unchanged and always wins above it (nothing here alters pause/resume semantics). On
 * every `status` and `watch` (tick) evaluation, the guard writes `FORGE_USAGE_PRESSURE.json` next to
 * the other guard state files: {"level":"nvidia-preferred"|"normal"|"unknown","week":<n|null>,
 * "nvidia_shift_at":<n>,"pause_at":<n>,"updated_at":"<iso>"} — always written (even when usage data is
 * missing/unreadable, as level "unknown") so a reader never sees a stale flag. `status` additionally
 * prints a one-line `pressure: ...` summary. Real week% only — never fabricated.
 *
 * SETTINGS (v2.7.0, 2026-09-24): every threshold resolves as CLI flag > the owner's `/forge config` value
 * (forge-config.cjs, soft-required; absent = the schema's own defaults) > the hard default in GUARD_DEFAULTS
 * (pause-at 98, resume-at 0, interval 120, nvidia-shift-at 80 — equal to FORGE_CONFIG_SCHEMA.json, pinned by a
 * test). The pause default used to drift between 93, 95 and 98; 98 is now the only pause literal. `status` and the
 * watch log print each value with its source (bron: vlag|instelling|standaard). The config key `usage-guard` is the
 * owner's on/off switch: when it is off, `start` prints one plain line and exits 3 without spawning anything
 * (`--force` overrides once). A REAL start (not "already running") prints the schema's disclosure text — what the
 * guard reads and where it sends it — followed by the one command that switches it off.
 *
 * SAFE DEFAULTS (security fixes wp20, 2026-09-24):
 *  - M3: a settings file forge-config refuses as malformed, or a missing forge-config.cjs, is UNREADABLE — never a
 *    silent "on". The thresholds fall back to the defaults (with a note), but `start` refuses in one plain line and
 *    exits 3 ("instellingen onleesbaar — usage guard start niet; ..."); `--force` overrides once.
 *  - M6: the guard can only measure with ~/.claude/.credentials.json (on macOS Claude Code keeps the login in the
 *    Keychain). Without that file `start` prints one honest line and exits 3 without spawning; `status`/`check` say
 *    the same instead of a raw file error.
 *  - L2: a RUNNING watcher re-reads the `usage-guard` switch before every check (watchStep). Switched off (or
 *    unreadable) -> it logs one line, removes its pid file and exits 0. A watcher started with `start --force` while
 *    the switch was off keeps running until the switch has been on at least once and is then turned off again.
 *  - L1: credential-file errors are fixed strings ("credentials file unreadable (<name>)") — never a JSON-parse
 *    message (V8 quotes ±10 input characters, i.e. token fragments) and never an absolute home path, in state or log.
 *
 * TEST/ISOLATION SEAM (F1, security fix 2026-09-24): `FORGE_USAGE_GUARD_HOME` overrides the `.claude`
 * home dir this whole file derives CRED_FILE / STATE_FILE / PRESSURE_FILE / PID_FILE / LOG_FILE /
 * PAUSED_JOURNAL and (via `FORGE_USAGE_GUARD_IDENTITY`) IDENTITY_FILE from. Unset, behaviour is
 * byte-identical to before: the real `~/.claude`. A mandatory doctor test run that spawns
 * `usage-guard.cjs start` MUST set this (and the individual FORGE_USAGE_GUARD_* / FORGE_USAGE_PRESSURE_FILE
 * vars it needs) to a temp directory — otherwise the child's first tick reads the REAL OAuth token from
 * `~/.claude/.credentials.json`, calls the live Anthropic usage endpoint, and overwrites the REAL
 * `~/.claude/FORGE_USAGE_PRESSURE.json`, even though no credentials were ever configured for the test.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');
// The credential/redaction boundary (GUARD-TOKEN-ERROR / GUARD-TOKEN-FINGERPRINT, 2026-09-24) — split
// out of this file because it is ~1500 lines (this project's own file-size guidance names ~500 as the
// per-file target) and this is the one genuinely separable concern. See usage-guard-redact.cjs's own
// header for exactly what it does and why.
const guardRedact = require('./usage-guard-redact.cjs');
// The exclusive state-lock primitive (GUARD-STATE-RACE fail-closed fix, V15, 2026-09-24) — split out for
// the same file-size reason as usage-guard-redact.cjs above; see that file's own header.
const guardState = require('./usage-guard-state.cjs');
// The credits-override DEFENSE IN DEPTH layer (V15, FOURTH Codex recheck, 2026-09-24) — split out for the
// same file-size reason; see that file's own header for why state.json's ownerOverride cache is no longer
// trusted on its own for the pause/don't-pause decision.
const guardOverride = require('./usage-guard-override.cjs');

// TEST-DENY-NETWORK seam (Codex recheck wp-f4 V20, 2026-09-24): a NARROW, explicit, environment-selected
// interception seam for tests that spawn a REAL watcher process (`start`/`watch`). Without this, a test
// that supplies a syntactically-valid-but-fake OAuth token (needed so readToken() does not fail first) and
// then starts a real detached watcher lets its first tick's fetchUsage()/pc() reach the LIVE
// api.anthropic.com endpoint (and the loopback Paperclip API) for real — exactly the regression Codex
// found in this file's own "GUARD-STOP: `stop` actually terminates a real running watcher" test. This is
// activated ONLY by an explicit env var this file's own test suite sets — never a config file, never
// something a real caller could accidentally trip. When active it replaces global.fetch with a
// DENY-BY-DEFAULT stub: every call is refused (never reaches the network) and, when
// FORGE_USAGE_GUARD_DENY_NETWORK_LOG is also set, appended as one JSON line per attempted request so the
// test can assert the interception actually saw every request it expected.
if (process.env.FORGE_USAGE_GUARD_DENY_NETWORK === '1') {
  const denyLog = process.env.FORGE_USAGE_GUARD_DENY_NETWORK_LOG;
  global.fetch = async (url, init) => {
    const rec = { url: String(url), method: (init && init.method) || 'GET', ts: new Date().toISOString() };
    if (denyLog) { try { fs.appendFileSync(denyLog, JSON.stringify(rec) + '\n'); } catch { /* best effort */ } }
    const err = new Error('network denied by the FORGE_USAGE_GUARD_DENY_NETWORK test seam (deny-by-default) — real target: ' + rec.url);
    err.name = 'FetchDeniedByTestSeamError';
    throw err;
  };
}

const HOME = process.env.FORGE_USAGE_GUARD_HOME || path.join(os.homedir(), '.claude');
const CRED_FILE = path.join(HOME, '.credentials.json');
const STATE_FILE = process.env.FORGE_USAGE_GUARD_STATE || argv('state', path.join(HOME, 'FORGE_USAGE_GUARD_STATE.json'));
const PRESSURE_FILE = process.env.FORGE_USAGE_PRESSURE_FILE || path.join(HOME, 'FORGE_USAGE_PRESSURE.json');
const PID_FILE = process.env.FORGE_USAGE_GUARD_PID || path.join(HOME, 'forge-usage-guard.pid');
const LOG_FILE = process.env.FORGE_USAGE_GUARD_LOG || path.join(HOME, 'forge-usage-guard.log');
// COMPENSATIEJOURNAL (uitgesteld punt 1, gesloten 2026-08-06): account-ONAFHANKELIJK append-only journal
// van door de guard gepauzeerde Paperclip-agents. stateForAccount() reset bij een account-switch de state
// (terecht — cijfers van A mogen B niet sturen), maar de pausedAgents-lijst stond ALLEEN in die state:
// agents die onder account A gepauzeerd waren, waren na een switch voorgoed onvindbaar en bleven hangen
// tot een mens ze handmatig hervatte. Paperclip is een lokale, account-agnostische runtime — hervatten
// onder account B van wat de guard zelf onder A pauzeerde is precies de bedoeling.
const PAUSED_JOURNAL = process.env.FORGE_USAGE_GUARD_JOURNAL || path.join(HOME, 'forge-usage-guard-paused.jsonl');
// GUARD-TOKEN-FINGERPRINT (2026-09-24): the opaque local account-mapping file (see usage-guard-redact.cjs's
// resolveLocalAccountLabel) — NOT one of the artifacts the ACCOUNT IDENTITY header above warns about
// (dashboards/sync/publish never touch this file; its whole purpose IS to hold the fp->label mapping so
// nothing else ever has to).
const ACCOUNT_MAP_FILE = process.env.FORGE_USAGE_GUARD_ACCOUNT_MAP || path.join(HOME, 'forge-usage-guard-account-map.json');
const PC_BASE = process.env.PAPERCLIP_URL || 'http://127.0.0.1:3100';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// FORGE_USAGE_GUARD_FETCH_TIMEOUT_MS: test-only override for fetchUsage()'s abort deadline (mirrors the
// existing FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS seam) — captured ONCE at module load time (same convention
// as HOME/STATE_FILE/etc. above), never re-read per call, so a test that mutates this env var and then
// reloads the module (delete require.cache + require()) affects only ITS OWN freshly-required instance,
// never a concurrently-running async test's already-captured module instance. Unset/invalid keeps 30000.
const FETCH_TIMEOUT_MS = Number(process.env.FORGE_USAGE_GUARD_FETCH_TIMEOUT_MS) > 0 ? Number(process.env.FORGE_USAGE_GUARD_FETCH_TIMEOUT_MS) : 30000;

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
function argv(name, dflt) { const a = process.argv.slice(2); const i = a.indexOf('--' + name); return i >= 0 && a[i + 1] !== undefined ? a[i + 1] : dflt; }
const has = (f) => args.includes('--' + f);

// ---- SETTINGS (v2.7.0, 2026-09-24): CLI flag > /forge config value > hard default — see the header ----
const GUARD_DEFAULTS = { 'pause-at': 98, 'resume-at': 0, interval: 120, 'nvidia-shift-at': 80 };
const GUARD_SWITCH_KEY = 'usage-guard';
const GUARD_SCHEMA_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json');
const SOURCE_WORD = { flag: 'vlag', config: 'instelling', dflt: 'standaard' };
const guardKey = (flag) => GUARD_SWITCH_KEY + '.' + flag;
const entryValue = (e) => (e !== null && typeof e === 'object' ? e.value : e);
const entrySource = (e) => (e !== null && typeof e === 'object' && e.source === 'default' ? SOURCE_WORD.dflt : SOURCE_WORD.config);

// GUARD-BOUNDS-FALLBACK (Codex recheck wp-f4 V19, 2026-09-24): the hard-coded bounds this guard SHIPS
// with, mirroring FORGE_CONFIG_SCHEMA.json's own usage-guard.* min/max exactly (pinned by a drift test).
// Used ONLY when the real schema file cannot be read/parsed for a flag — see guardBounds() below. A
// missing/malformed/BOM-prefixed schema must never mean "no bounds" (accepting e.g. pause-at=150 or a
// fractional 98.7, which could silently disable a meaningful pause threshold); it means "fall back to
// these known-good bounds", exactly like the config core's own fail-safe reads already do elsewhere.
const GUARD_BOUNDS_FALLBACK = {
  'pause-at': { min: 50, max: 99 },
  'resume-at': { min: 0, max: 98 },
  interval: { min: 30, max: 900 },
  'nvidia-shift-at': { min: 50, max: 99 },
};
/** guardBounds(schemaPath) -> { [flag]: {min, max} } for pause-at/resume-at/interval/nvidia-shift-at, read
 *  directly from FORGE_CONFIG_SCHEMA.json (CFG-05, 2026-09-24) — this file must never touch
 *  forge-config.cjs itself (a separate work package owns that), so bounds are read straight from the
 *  schema JSON. Never throws. V19 FIX (2026-09-24): a missing/unreadable/malformed schema — or a single
 *  flag missing its own spec — now falls back to GUARD_BOUNDS_FALLBACK per flag, NEVER "no bounds" (the
 *  pre-V19 behaviour, which let an out-of-range or fractional threshold through unrejected the moment the
 *  schema file was merely unreadable). A BOM-prefixed schema (Windows PowerShell `Set-Content -Encoding
 *  utf8` always emits one — see this project's own wp22 lesson) is stripped and parsed normally, matching
 *  forge-config.cjs's own defensive BOM handling, so a real, valid, BOM-prefixed schema is honored exactly
 *  — it only ever falls to the hard-coded fallback when the schema is GENUINELY unreadable/malformed. */
function guardBounds(schemaPath) {
  const out = {};
  let schema = null;
  try {
    let raw = fs.readFileSync(schemaPath || GUARD_SCHEMA_PATH, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM
    schema = JSON.parse(raw);
  } catch { schema = null; }
  for (const flag of Object.keys(GUARD_DEFAULTS)) {
    const spec = schema && schema.settings && schema.settings[guardKey(flag)];
    out[flag] = (spec && Number.isFinite(spec.min) && Number.isFinite(spec.max))
      ? { min: spec.min, max: spec.max } : GUARD_BOUNDS_FALLBACK[flag];
  }
  return out;
}
/** resolveGuardSettings(argvList, cfg, opts) -> { 'pause-at'|'resume-at'|'interval'|'nvidia-shift-at'|'enabled':
 *  {value, source}, force, warnings[] }. PURE (no I/O beyond opts.bounds's default schema read, which never
 *  mutates anything the caller holds). argvList = the CLI args after the script name; cfg = the `.cfg` of
 *  loadGuardConfig() ({ '<config key>': {value, source} }) or null. source is 'vlag' | 'instelling' | 'standaard'.
 *  CFG-05 (2026-09-24): every candidate value (flag OR config) is validated against the schema's own
 *  min/max/integer bounds — out-of-range, fractional or non-finite values are REJECTED with a warning and
 *  fall through to the next source (flag -> config -> hard default), exactly like an unparseable flag
 *  already did; a threshold that silently accepted e.g. -5 or 4.5 could then never meaningfully pause.
 *  opts.bounds overrides the schema-derived bounds map (test seam); opts.schemaPath overrides the schema
 *  file read by the default. */
function resolveGuardSettings(argvList, cfg, opts) {
  const list = Array.isArray(argvList) ? argvList : [];
  const c = cfg !== null && typeof cfg === 'object' ? cfg : {};
  const o = opts || {};
  const bounds = o.bounds || guardBounds(o.schemaPath);
  const out = { warnings: [] };
  for (const flag of Object.keys(GUARD_DEFAULTS)) {
    const b = bounds[flag];
    const inBounds = (n) => !b || (Number.isInteger(n) && n >= b.min && n <= b.max);
    const rangeTxt = b ? ' (' + b.min + '-' + b.max + ')' : '';
    const i = list.indexOf('--' + flag);
    const raw = i >= 0 && list[i + 1] !== undefined ? list[i + 1] : undefined;
    const n = raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(n)) {
      if (inBounds(n)) { out[flag] = { value: n, source: SOURCE_WORD.flag }; continue; }
      out.warnings.push('--' + flag + ' ' + n + ' is buiten het toegestane bereik' + rangeTxt + ' en wordt genegeerd / is out of the allowed range' + rangeTxt + ' and is ignored');
    } else if (raw !== undefined) {
      out.warnings.push('--' + flag + ' "' + raw + '" is geen getal en wordt genegeerd / is not a number and is ignored');
    }
    const e = c[guardKey(flag)];
    const v = entryValue(e);
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (inBounds(v)) { out[flag] = { value: v, source: entrySource(e) }; continue; }
      out.warnings.push('instelling ' + guardKey(flag) + '=' + v + ' is buiten het toegestane bereik' + rangeTxt + ' — standaardwaarde gebruikt / setting ' + guardKey(flag) + '=' + v + ' is out of the allowed range' + rangeTxt + ' — using the default instead');
    }
    out[flag] = { value: GUARD_DEFAULTS[flag], source: SOURCE_WORD.dflt };
  }
  const sw = c[GUARD_SWITCH_KEY];
  out.enabled = typeof entryValue(sw) === 'boolean' ? { value: entryValue(sw), source: entrySource(sw) } : { value: true, source: SOURCE_WORD.dflt };
  out.force = list.includes('--force');
  return out;
}

/** loadGuardConfig(opts) -> { cfg: {'<key>': {value, source}}, disclosure: {nl, en}|null, note: string|null,
 *  unreadable: boolean }. Reads the guard's keys through forge-config.cjs (opts.configModule === null simulates it
 *  being absent). Absent module or a settings file forge-config refuses as malformed -> the schema's own defaults
 *  (source 'default') for the thresholds, a visible note, and unreadable:true — which `start` and a running watcher
 *  treat as OFF (M3: never a silent fall-back to ON). Never throws. */
function loadGuardConfig(opts) {
  const o = opts || {};
  const keys = [GUARD_SWITCH_KEY, ...Object.keys(GUARD_DEFAULTS).map(guardKey)];
  let mod = o.configModule;
  if (mod === undefined) { try { mod = require('./forge-config.cjs'); } catch { mod = null; } }
  let note = mod ? null : 'forge-config.cjs ontbreekt — drempels op de standaardwaarden, usage guard start niet (veilige standaard: uit) / forge-config.cjs is missing — thresholds at the defaults, the guard does not start (safe default: off)';
  if (mod) {
    try {
      const r = mod.resolve(o.configOpts || {});
      const cfg = {};
      for (const k of keys) if (r.settings[k]) cfg[k] = { value: r.settings[k].value, source: r.settings[k].source };
      const spec = mod.SCHEMA.settings[GUARD_SWITCH_KEY];
      return { cfg, disclosure: spec && spec.disclosure ? spec.disclosure : null, note: null, unreadable: false };
    } catch (e) {
      note = 'je instellingen zijn niet leesbaar (' + String((e && e.message) || e).split('\n')[0] + ') — drempels op de standaardwaarden, usage guard start niet (veilige standaard: uit) / your settings are unreadable — thresholds at the defaults, the guard does not start (safe default: off)';
    }
  }
  let schema = null;
  try { schema = JSON.parse(fs.readFileSync(o.schemaPath || GUARD_SCHEMA_PATH, 'utf8')); } catch { schema = null; }
  const specs = schema && schema.settings ? schema.settings : {};
  const cfg = {};
  for (const k of keys) if (specs[k]) cfg[k] = { value: specs[k].default, source: 'default' };
  const spec = specs[GUARD_SWITCH_KEY];
  return { cfg, disclosure: spec && spec.disclosure ? spec.disclosure : null, note, unreadable: true };
}

/** readGuardSwitch(opts) -> { on: boolean, unreadable: boolean } — the owner's `usage-guard` switch as it is NOW
 *  (L2: a running watcher re-reads it before every check). forge-config.cjs is soft-required through
 *  loadGuardConfig; its seams FORGE_CONFIG_HOME / FORGE_PROJECT_ROOT are read at call time. Unreadable -> OFF (M3).
 *  Never throws. */
function readGuardSwitch(opts) {
  const o = opts || {};
  let mod = o.configModule;
  if (mod === undefined) { try { mod = require('./forge-config.cjs'); } catch { mod = null; } }
  if (mod && typeof mod.safeGet === 'function') {   // forge-config's own fail-safe single-key read (never throws)
    try {
      const r = mod.safeGet(GUARD_SWITCH_KEY, Object.assign({ fallback: false }, o.configOpts || {}));
      if (r && typeof r.value === 'boolean') return r.degraded ? { on: false, unreadable: true } : { on: r.value, unreadable: false };
    } catch { return { on: false, unreadable: true }; }
  }
  const c = loadGuardConfig(Object.assign({}, o, { configModule: mod }));
  if (c.unreadable) return { on: false, unreadable: true };
  const e = c.cfg[GUARD_SWITCH_KEY];
  return { on: !(e && e.value === false), unreadable: false };
}

const GUARD_CFG = loadGuardConfig();
const GUARD = resolveGuardSettings(args, GUARD_CFG.cfg);
const PAUSE_AT = GUARD['pause-at'].value;
const RESUME_AT = GUARD['resume-at'].value;
// owner policy: at ~80% weekly usage, PREFER NVIDIA agents over Claude agents (no quality downgrade) —
// purely advisory (see NVIDIA-SHIFT SOFT THRESHOLD doc above). Same settings mechanism as PAUSE_AT
// (never itself read back from state — only recorded there for observability).
const NVIDIA_SHIFT_AT = GUARD['nvidia-shift-at'].value;
const INTERVAL = Math.max(30, GUARD.interval.value);
/** settingsLine(S) — one line with every value and its source, e.g. "pause-at 98% (bron: standaard) · …". */
function settingsLine(S) {
  const part = (k, v, unit) => k + ' ' + v + unit + ' (bron: ' + S[k].source + ')';
  return [part('pause-at', S['pause-at'].value, '%'), part('resume-at', S['resume-at'].value, '%'),
    part('nvidia-shift-at', S['nvidia-shift-at'].value, '%'), part('interval', Math.max(30, S.interval.value), 's'),
    'usage-guard ' + (S.enabled.value ? 'aan' : 'uit') + ' (bron: ' + S.enabled.source + ')'].join(' · ');
}
// GUARD-DISCLOSURE (2026-09-24): a FULL, non-optional fallback — used whenever the real schema disclosure
// is unavailable (missing/malformed FORGE_CONFIG_SCHEMA.json, or forge-config.cjs itself missing). The
// previous fallback only said "measures your usage", omitting the credential source, the destination
// host, persistence after the session closes and the storage location — exactly the information an
// unavailable-schema owner most needs before their first credential use.
const DISCLOSURE_FALLBACK = {
  nl: 'usage-guard leest je Claude-login-token lokaal uit ~/.claude/.credentials.json (en je account-id uit ~/.claude.json, alleen bewaard als een lokaal, niet naar het account herleidbaar label) en stuurt het token alleen naar api.anthropic.com om je gebruik te meten; draait als achtergrondproces op deze computer, ook na het sluiten van de sessie, en schrijft zijn status-/logbestanden onder ~/.claude.',
  en: 'usage-guard reads your Claude login token locally from ~/.claude/.credentials.json (and your account id from ~/.claude.json, kept only as a local label that cannot be traced back to the account) and sends the token only to api.anthropic.com to measure your usage; runs as a background process on this machine, also after the session closes, and writes its state/log files under ~/.claude.',
};
/** disclosureLines(d) — what EVERY watcher activation path tells the owner, BEFORE the first credential
 *  use: the schema's disclosure (nl, en) when available, else the complete DISCLOSURE_FALLBACK above +
 *  the off command. Never partial, never optional. */
function disclosureLines(d) {
  const text = d && typeof d.nl === 'string' && typeof d.en === 'string' ? [d.nl, d.en] : [DISCLOSURE_FALLBACK.nl, DISCLOSURE_FALLBACK.en];
  return [...text, 'Uit: /forge config set usage-guard uit'];
}
const _graceMinRaw = Number(argv('grace-min', 5));
const GRACE_MIN = Number.isFinite(_graceMinRaw) && _graceMinRaw >= 0 ? _graceMinRaw : 5; // reset-rhythm grace period (minutes)
const ONLY_COMPANIES = (argv('companies', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const DRY = has('dry-run');

// LOGROTATIE (audit G9a, 2026-08-06): het logbestand groeide onbegrensd (appendFileSync zonder enige
// check — gemeten: multi-MB op deze machine). Bij >5MB roteert log() naar .1 (twee generaties: actueel +
// een vorige) — begrensd, en de recente historie blijft altijd beschikbaar voor diagnose.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** rotateLogIfNeeded (r4 #20, 2026-08-07): twee gelijktijdige logwriters konden BEIDE .1 verwijderen en
 *  elkaars generatie verliezen, en de rename liet elk open geërfd fd (de stderr van de detached watcher!)
 *  naar de weggedraaide inode schrijven. Nu: (1) rotatie is geserialiseerd achter een 'wx'-lock — bij
 *  contentie slaat deze aanroep de rotatie gewoon over (een gemiste poging is onschadelijk, een dubbele
 *  rm/rename niet); (2) copy+truncate i.p.v. rename — ieder open fd (ook de geërfde stderr) blijft op het
 *  ACTIEVE bestand schrijven en het Windows-hazard van rename-met-open-handle vervalt. Het bekende
 *  copytruncate-venster (een regel geappend tussen copy en truncate gaat verloren) is hier een bewuste,
 *  kleine prijs voor een diagnoselog — nooit voor bewijsdata. */
function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size < LOG_MAX_BYTES) return;
    const lockPath = LOG_FILE + '.rotate.lock';
    let lfd = null;
    try { lfd = fs.openSync(lockPath, 'wx'); }
    catch (e) {
      if (e.code === 'EEXIST') {
        // achtergebleven lock van een gecrashte roteerder na STALE_LOCK_MS opruimen; deze ronde overslaan
        try { if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(lockPath); } catch { }
      }
      return;
    }
    try {
      const st2 = fs.statSync(LOG_FILE);
      if (st2.size >= LOG_MAX_BYTES) {
        fs.copyFileSync(LOG_FILE, LOG_FILE + '.1');
        fs.truncateSync(LOG_FILE, 0);
      }
    } finally {
      try { fs.closeSync(lfd); } catch { }
      try { fs.unlinkSync(lockPath); } catch { }
    }
  } catch { /* geen log of niet leesbaar — niets te roteren */ }
}
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  console.log(line);
  try { rotateLogIfNeeded(); fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
/** journalAppend / unresolvedPausedAgents — het compensatiejournal (zie PAUSED_JOURNAL boven).
 *  r4 #15 (2026-08-07): het journal is nu WRITE-AHEAD en generation-aware:
 *  - elke pauzeronde draagt een pauseId; per agent wordt VOOR de pause-API een 'pause-intent'-record
 *    geschreven en na API-succes een 'paused'-result met dezelfde pauseId — een crash tussen API en
 *    journal verliest de compensatie niet meer (de intent staat er al);
 *  - een resolved:true-record sluit UITSLUITEND de pauseId die hij noemt; een oud, laat arriverend
 *    resolve-record (gelijktijdige watch --once) kan een NIEUWERE pauze dus nooit meer maskeren;
 *  - compactJournalIfNeeded houdt het bestand begrensd: boven de drempel wordt per agent alleen het
 *    laatst relevante spoor bewaard (atomisch, onder een wx-lock — nooit een tweede compacteerder). */
function journalLockPath() { return PAUSED_JOURNAL + '.compact.lock'; }
/** journalAppend — r5 #18/#20 (2026-08-07): gefsynct (een intent die de power loss niet overleeft is
 *  geen write-ahead) en geserialiseerd met de compactielock, zodat een append nooit op de oude inode
 *  landt terwijl de compactor zijn rename doet. Bij een blijvend bezette lock appenden we alsnog
 *  (een pauze-compensatie mag nooit sneuvelen aan een diagnostische compactie) en melden dat. */
function journalAppend(rec) {
  const line = JSON.stringify(Object.assign({ ts: new Date().toISOString() }, rec)) + '\n';
  let lfd = null;
  for (let i = 0; i < 40 && lfd === null; i++) {
    try { lfd = fs.openSync(journalLockPath(), 'wx'); }
    catch (e) { if (e.code !== 'EEXIST') break; try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch { } }
  }
  try {
    const fd = fs.openSync(PAUSED_JOURNAL, 'a');
    try { fs.writeSync(fd, line, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (lfd === null) log('paused-journal: append zonder lock (compactor hield hem >1s vast) — record is wel duurzaam geschreven');
    return true;
  }
  catch (e) { log('paused-journal write failed (resume must then rely on state alone): ' + e.message); return false; }
  finally { if (lfd !== null) { try { fs.closeSync(lfd); } catch { } try { fs.unlinkSync(journalLockPath()); } catch { } } }
}
/** journalScan — r5 #19: ALLE onopgeloste pauze-generaties per agent blijven staan (een concurrerende
 *  pauze B die faalt en resolvet mag generatie A niet uit de recovery drukken). */
function journalScan() {
  let raw;
  try { raw = fs.readFileSync(PAUSED_JOURNAL, 'utf8'); } catch { return new Map(); }
  const agents = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let r; try { r = JSON.parse(s); } catch { continue; /* halve regel: overslaan */ }
    if (!r || r.agentId == null) continue;
    const id = String(r.agentId);
    if (!agents.has(id)) agents.set(id, { pauses: new Map(), legacyPause: null, resolvedIds: new Set(), legacyResolved: false });
    const a = agents.get(id);
    if (r.resolved === true) {
      if (r.pauseId) a.resolvedIds.add(String(r.pauseId));
      else a.legacyResolved = true; // legacy resolve zonder pauseId: sluit alleen legacy pauzes (zonder pauseId)
    } else if (r.pauseId) {
      a.pauses.set(String(r.pauseId), r); // laatste record per generatie (intent daarna result) wint
    } else {
      a.legacyPause = r;
    }
  }
  return agents;
}
function unresolvedPausedAgents() {
  const out = [];
  for (const [, a] of journalScan()) {
    for (const [pid, rec] of a.pauses) if (!a.resolvedIds.has(pid)) out.push(rec);
    if (a.legacyPause && !a.legacyResolved) out.push(a.legacyPause);
  }
  return out;
}
const JOURNAL_COMPACT_BYTES = 256 * 1024;
function compactJournalIfNeeded() {
  try {
    const st = fs.statSync(PAUSED_JOURNAL);
    if (st.size < JOURNAL_COMPACT_BYTES) return;
    const lockPath = PAUSED_JOURNAL + '.compact.lock';
    let lfd = null;
    try { lfd = fs.openSync(lockPath, 'wx'); }
    catch (e) { if (e.code === 'EEXIST') { try { if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) fs.unlinkSync(lockPath); } catch { } } return; }
    try {
      // bewaar per agent alleen het onopgeloste laatste pause-spoor; alles wat geresolved is mag weg
      const keep = unresolvedPausedAgents().map((r) => JSON.stringify(r));
      const tmp = PAUSED_JOURNAL + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '');
      fs.renameSync(tmp, PAUSED_JOURNAL);
      log('paused-journal gecompacteerd: ' + st.size + 'B -> ' + (keep.join('\n').length + 1) + 'B (' + keep.length + ' onopgelost spoor/sporen bewaard)');
    } finally {
      try { fs.closeSync(lfd); } catch { }
      try { fs.unlinkSync(lockPath); } catch { }
    }
  } catch { /* geen journal — niets te compacteren */ }
}
/** readState() -> the current guard state, honestly distinguishing MISSING from CORRUPT (GUARD-CORRUPT,
 *  2026-09-24). A missing file (ENOENT — ordinary "nothing has ever been recorded yet") is the ONLY case
 *  that legitimately reads as {mode:'ok'}. Any OTHER read/parse failure (a damaged file, unreadable
 *  permissions, or JSON that parses to something that isn't a plausible state object — null, an array, a
 *  bare primitive) now returns {mode:'corrupt', corruptAt, corruptReason} instead. This used to collapse
 *  EVERY failure into the same {mode:'ok'} as "no file" — a corrupted or torn state file (a real pause,
 *  an owner override, a paused-agent list) silently vanished and was replaced by "everything is fine" the
 *  next time anything called readState(). `mode:'corrupt'` is deliberately its OWN literal (not
 *  'paused') so it is never confused with a genuine, resumable pause — see tick()'s own handling: a
 *  FAILED measurement while corrupt must preserve 'corrupt' (never silently invent 'ok'), while a fresh,
 *  SUCCESSFUL, validated measurement is allowed to move the state forward normally (that is a validated
 *  recovery, not a fabricated one) and logs the transition explicitly rather than silently. Never throws.
 *  KNOWN GAP (documented, not silently left implicit): forge-autonomy.cjs's own usageLimitActive() reads
 *  this same state file independently and only treats `mode === 'paused'` as blocking — it does not yet
 *  treat `mode === 'corrupt'` as blocking. forge-autonomy.cjs is a read-only neighbour for this work
 *  package and was intentionally not modified; propagating corrupt-state blocking into it is a follow-up
 *  for whichever Boss owns that file next. */
function readState() {
  let raw;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { mode: 'ok' };
    return { mode: 'corrupt', corruptAt: new Date().toISOString(), corruptReason: (e && typeof e.code === 'string' && /^[A-Z]+$/.test(e.code)) ? e.code : 'EUNKNOWN' };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { mode: 'corrupt', corruptAt: new Date().toISOString(), corruptReason: 'invalid-json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { mode: 'corrupt', corruptAt: new Date().toISOString(), corruptReason: 'unexpected-shape' };
  }
  return parsed;
}
/** writeStateTo(file, s, fence) — THE single choke point for every state write (audit finding 2026-08-03).
 *  doPause()/doResume() deliberately build a FRESH state object so a stale pause cannot survive, carrying
 *  only ownerOverride/credits forward by hand. The account stamp was not on that hand-written carry list,
 *  so every pause/resume erased it and the next tick mistook a REAL account switch for a first stamp —
 *  the account gate died exactly when it mattered. Carrying it here (unless the writer explicitly sets a
 *  new one, which is what a genuine switch does) makes that impossible to forget at any future call site.
 *  Every write also stamps a heartbeat: a watcher that stopped ticking is then visible in the state
 *  itself, not only in a PID that outlives the work it was supposed to be doing.
 *  FENCE-AT-PUBLISH (V15, THIRD Codex recheck, 2026-09-24): `fence`, when given, is a zero-arg function
 *  (usage-guard-state.cjs's own lock fence) re-checked IMMEDIATELY BEFORE the rename that actually publishes
 *  this write — not only by the caller, earlier, before the account-carry read/JSON.stringify/temp-file
 *  write above. Codex proved those are separate operations with a real (if narrow) window between them: a
 *  caller whose EARLIER fence() check passed could still have lost the lock by the time this function
 *  finally renamed its temp file into place, and the write landed anyway. Re-checking here, as the LAST
 *  synchronous step before the one mutation that makes the write visible, closes that gap to the practical
 *  minimum. On a failed re-check this throws an Error with `.code === 'EFENCED'` (never lets the rename
 *  happen) — callers that pass `fence` MUST treat that as a refusal exactly like a lock-timeout, never a
 *  hard failure to propagate as a fatal error. */
function writeStateTo(file, s, fence) {
  const next = Object.assign({}, s);
  if (!next.account) {
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prev && prev.account) next.account = prev.account;
    } catch { /* no previous state — nothing to carry */ }
  }
  next.heartbeatAt = new Date().toISOString();
  // ATOMIC WRITE (Codex adversarial review #6, 2026-08-03): this used to truncate-and-rewrite the live
  // file in place. Three processes share it — the watcher, the CLI and the PreToolUse hook — so a reader
  // landing mid-write got a truncated file and, because every reader treats unparseable JSON as "no
  // state", failed OPEN: a real pause could be silently ignored at exactly the moment it mattered.
  // Write to a unique temp file in the same directory, then rename: on both Windows and POSIX a rename
  // within one filesystem is atomic, so a reader sees either the whole old file or the whole new one.
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    if (typeof fence === 'function' && !fence()) {
      const err = new Error('state publish refused: lock fence no longer matches immediately before rename');
      err.code = 'EFENCED';
      throw err;
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    // A failed atomic write (or a fenced refusal) must not silently leave the caller believing the state
    // was persisted.
    throw e;
  }
  return next;
}
function writeState(s, fence) { return writeStateTo(STATE_FILE, s, fence); }

// ---- NVIDIA-shift soft threshold — pure, advisory-only classification (never fabricates a %) ----
function computePressureLevel(weekPct, nvidiaShiftAt) {
  if (!Number.isFinite(weekPct) || !Number.isFinite(nvidiaShiftAt)) return 'unknown';
  return weekPct >= nvidiaShiftAt ? 'nvidia-preferred' : 'normal';
}
function buildPressureData(weekPct, nvidiaShiftAt, pauseAt) {
  return {
    level: computePressureLevel(weekPct, nvidiaShiftAt),
    week: Number.isFinite(weekPct) ? weekPct : null,
    nvidia_shift_at: nvidiaShiftAt,
    pause_at: pauseAt,
    updated_at: new Date().toISOString(),
  };
}
// writes unconditionally (even level:"unknown") so a reader never sees a stale flag — advisory only,
// never pauses/blocks anything and never influences the real pause/resume decision above.
function writePressureFile(weekPct, nvidiaShiftAt, pauseAt) {
  const data = buildPressureData(weekPct, nvidiaShiftAt, pauseAt);
  try { fs.writeFileSync(PRESSURE_FILE, JSON.stringify(data, null, 2) + '\n'); }
  catch (e) { log('pressure-file write failed (no action taken): ' + e.message); }
  return data;
}

// ---- ACCOUNT IDENTITY (2026-08-03) --------------------------------------------------------------
// MEASURED DEFECT: the owner switches between TWO Claude accounts. Nothing in this guard carried an
// account identity, so ONE state file served both: after a switch the state still held account A's
// numbers (week 37%) while the live endpoint reported account B (week 86%) — pause/resume decisions,
// the pressure signal and the credits override were all being made on the wrong account's data.
// Identity is a SHORT SHA-256 FINGERPRINT, never the raw uuid/email/token: state files are read by
// dashboards, synced between projects and (sanitized) published, so no raw identifier may land in one.
// F1 (2026-09-24): follows the same test/isolation seam as HOME above — an explicit override wins,
// else it derives from HOME's parent so an isolated HOME (FORGE_USAGE_GUARD_HOME) also isolates this
// file; unset, path.dirname(path.join(os.homedir(), '.claude')) === os.homedir(), so default behaviour
// is unchanged.
const IDENTITY_FILE = process.env.FORGE_USAGE_GUARD_IDENTITY || path.join(path.dirname(HOME), '.claude.json'); // Claude Code's own profile store
function fingerprintAccount(oauthAccount) {
  const a = oauthAccount || {};
  const uuid = typeof a.accountUuid === 'string' ? a.accountUuid.trim() : '';
  if (uuid) {
    const org = typeof a.organizationUuid === 'string' ? a.organizationUuid.trim() : '';
    return { fp: crypto.createHash('sha256').update('acct:' + uuid + '|org:' + org).digest('hex').slice(0, 12), source: 'account-uuid' };
  }
  return { fp: null, source: 'unknown' };
}
/** readAccountIdentity — best-effort, never throws. GUARD-TOKEN-FINGERPRINT (2026-09-24): the ONLY
 *  source is Claude Code's own oauthAccount profile (~/.claude.json — not itself a bearer credential,
 *  the same non-secret account id Claude Code already stores in plaintext). The previous fallback
 *  fingerprinted the REFRESH TOKEN (an actual bearer secret) when that profile file was unavailable —
 *  removed entirely: without the profile, identity is honestly 'unknown' rather than derived from a
 *  credential. detectAccountSwitch() already treats an unknown current identity as "no switch, keep
 *  existing state" (see its own doc comment), so this is a safe degrade, never a silent misclassification.
 *  The raw fingerprint fingerprintAccount() computes is immediately translated through
 *  resolveLocalAccountLabel() into an OPAQUE LOCAL LABEL before it is ever returned — every caller
 *  downstream (state, journal, log, stdout) only ever sees the label, never the underlying fingerprint. */
function readAccountIdentity() {
  try {
    const j = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
    const id = fingerprintAccount(j && j.oauthAccount);
    if (id.fp) {
      const mapped = guardRedact.resolveLocalAccountLabel(id.fp, { mapFile: ACCOUNT_MAP_FILE });
      if (mapped) return { fp: mapped.label, source: id.source };
    }
  } catch { /* profile unreadable — identity unknown, see the header above */ }
  return { fp: null, source: 'unknown' };
}
/** readCredentialFp — de vingerafdruk van het credential dat NU in .credentials.json staat (zelfde
 *  derivatie als fetchUsage's credentialFp en readAccountIdentity's fallback). Null-veilig. */
function readCredentialFp() {
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    const rt = cred && cred.claudeAiOauth && cred.claudeAiOauth.refreshToken;
    if (typeof rt === 'string' && rt) return crypto.createHash('sha256').update('rt:' + rt).digest('hex').slice(0, 12);
  } catch { /* geen credential leesbaar */ }
  return null;
}
/** detectAccountSwitch(state, ident) -> {switched, from, to, reason}. Pure. A switch requires TWO known
 *  fingerprints that differ: an unstamped legacy state (adoption) and an unknown current identity both
 *  degrade to "no switch" — wiping real state on a missing profile file would be worse than the bug. */
function detectAccountSwitch(state, ident) {
  const from = state && state.account && typeof state.account.fp === 'string' ? state.account.fp : null;
  const to = ident && typeof ident.fp === 'string' ? ident.fp : null;
  if (!from) return { switched: false, from: null, to, reason: to ? 'first-stamp (adoption)' : 'no identity available' };
  if (!to) return { switched: false, from, to: null, reason: 'current identity unknown — keeping existing state rather than guessing' };
  if (from === to) return { switched: false, from, to, reason: 'same account' };
  return { switched: true, from, to, reason: 'account fingerprint changed' };
}
/** stateForAccount(state, ident) -> state to use for THIS account. On a real switch the guard starts
 *  CLEAN: percentages, pause/trigger, paused-agent list and — deliberately — the paid-credits
 *  ownerOverride are account-A facts and must never suppress or trip the guard on account B. The switch
 *  itself is recorded (previousAccount) rather than erased. */
function stateForAccount(state, ident) {
  const st = state && typeof state === 'object' ? state : { mode: 'ok' };
  const sw = detectAccountSwitch(st, ident);
  if (!sw.switched) {
    if (sw.to && (!st.account || st.account.fp !== sw.to)) {
      return Object.assign({}, st, { account: { fp: sw.to, source: ident.source, stampedAt: new Date().toISOString() } });
    }
    return st;
  }
  return {
    mode: 'ok',
    account: { fp: sw.to, source: ident.source, stampedAt: new Date().toISOString() },
    previousAccount: { fp: sw.from, switchedAt: new Date().toISOString(), lastPercents: st.percents || null },
    accountSwitchNotice: 'ACCOUNT SWITCH gedetecteerd (' + sw.from + ' -> ' + sw.to + '): guard-state is opnieuw begonnen. '
      + 'Cijfers, pauze-status en een eventuele credits-override van het vorige account zijn NIET overgenomen.',
  };
}

// ---- TYPED USAGE WINDOWS (2026-08-03) ------------------------------------------------------------
// MEASURED DEFECT: the endpoint now returns a typed `limits` array (kinds seen live: session,
// weekly_all, weekly_scoped with a per-model scope) alongside the legacy five_hour/seven_day fields.
// The guard read ONLY those two legacy fields, so every other window — a scoped per-model limit, and
// any daily window — was invisible: it could sit at 100% while the guard happily reported "ok".
// normalizeWindows() reads the typed array when present (that is the authoritative, forward-compatible
// shape: unknown future kinds are carried through unchanged) and falls back to the legacy pair.
function windowLabel(l) {
  const kind = l && l.kind ? String(l.kind) : 'onbekend';
  const model = l && l.scope && l.scope.model && l.scope.model.display_name;
  const surface = l && l.scope && l.scope.surface;
  const extra = [model, surface].filter(Boolean).join('/');
  return extra ? kind + ' (' + extra + ')' : kind;
}
function normalizeWindows(j) {
  const out = [];
  const seen = new Set();
  // CODEX ADVERSARIAL REVIEW (gpt-5.6-sol, 2026-08-03) finding #10: the first version RETURNED EARLY as
  // soon as limits[] yielded one usable entry, which silently dropped the legacy pair. A response with
  // limits=[{weekly_scoped, 10%}] and five_hour=99% then reported ONLY 10% and would never pause — the
  // exact blindness this rewrite existed to remove, reintroduced from the other side. Typed windows WIN
  // per identity (kind+group+scope), legacy fills the gaps, and nothing is counted twice.
  const key = (kind, group, label) => kind + '|' + (group || '') + '|' + (label || '');
  const limits = j && Array.isArray(j.limits) ? j.limits : null;
  if (limits && limits.length) {
    for (const l of limits) {
      // `Number(null)` is 0, so a null/absent percent would silently become a confident "0% used".
      // NO data must stay no data (same discipline as the legacy `utilization ?? NaN` read below).
      const raw = l && l.percent != null ? l.percent : NaN;
      const pct = Number(raw);
      if (!Number.isFinite(pct)) continue;
      const kind = l.kind ? String(l.kind) : 'onbekend';
      const group = l.group ? String(l.group) : null;
      const label = windowLabel(l);
      const k = key(kind, group, label);
      if (seen.has(k)) continue; // a duplicate typed record must not be counted (or resumed from) twice
      seen.add(k);
      // `id` is the window's STABLE identity (kind|group|label) — broad Codex audit #15, 2026-08-05:
      // the pause trigger used to store only the bare kind, and resume matched `find(x.kind === t.metric)`,
      // so with two weekly_scoped windows (Opus 96%, Sonnet 20%) whichever came FIRST in limits[] decided
      // whether the guard resumed — pausing on Opus and resuming because Sonnet was low, then re-pausing
      // next tick: flapping, or the mirror image, staying paused on a window that never crossed.
      out.push({ id: k, kind, group, pct, resetsAt: (l && l.resets_at) || null, severity: (l && l.severity) || null,
        isActive: l && l.is_active === true, label, source: 'limits' });
    }
  }
  const legacy = [['session', 'session', j && j.five_hour], ['weekly_all', 'weekly', j && j.seven_day]];
  for (const [kind, group, w] of legacy) {
    const pct = Number(w && w.utilization != null ? w.utilization : NaN);
    if (!Number.isFinite(pct)) continue;
    if (seen.has(key(kind, group, kind))) continue; // already reported as a typed window — same window
    seen.add(key(kind, group, kind));
    out.push({ id: key(kind, group, kind), kind, group, pct, resetsAt: (w && w.resets_at) || null,
      severity: null, isActive: false, label: kind, source: 'legacy' });
  }
  return out;
}
/** stillHighTrigger — the resume decision, pure and testable (broad Codex audit #15, 2026-08-05).
 *  Each pause trigger is looked up by its STABLE id first. A trigger without an id (recorded by an older
 *  build) may fall back to its bare kind ONLY when exactly one current window carries that kind — with
 *  two candidates the match would be a guess, and both wrong guesses are worse than the fallbacks below.
 *  Last resorts mirror the legacy pair (session / weekly_all); anything else unresolvable counts as NOT
 *  still high: the window is no longer reported, so there is nothing to wait for — and if that judgment
 *  is wrong, crossedWindows() re-pauses on the very next tick and resumeAtEpoch stays the backstop. */
function stillHighTrigger(triggers, windows, resumeAt, legacy) {
  const ws = Array.isArray(windows) ? windows : [];
  const leg = legacy || {};
  const curPct = (t) => {
    if (t && t.id) {
      const byId = ws.find((x) => x.id === t.id);
      if (byId && Number.isFinite(byId.pct)) return byId.pct;
      return NaN; // the identified window vanished — do not silently judge a DIFFERENT window instead
    }
    const sameKind = ws.filter((x) => x.kind === t.metric);
    if (sameKind.length === 1 && Number.isFinite(sameKind[0].pct)) return sameKind[0].pct;
    if (t.metric === 'session' && Number.isFinite(leg.sessionPct)) return leg.sessionPct;
    if (t.metric === 'weekly_all' && Number.isFinite(leg.weekPct)) return leg.weekPct;
    return NaN;
  };
  return (Array.isArray(triggers) ? triggers : []).some((t) => curPct(t) > resumeAt);
}
/** crossedWindows(windows, pauseAt) -> the windows at/over the pause threshold, ANY kind. */
function crossedWindows(windows, pauseAt) {
  if (!Number.isFinite(pauseAt)) return [];
  return (Array.isArray(windows) ? windows : []).filter((w) => Number.isFinite(w.pct) && w.pct >= pauseAt);
}
/** watcherHealth — a live PID is NOT proof the watcher is doing its job: on 2026-08-03 the process was
 *  alive while its last real check was 80 minutes old (it had silently stopped ticking). Freshness is
 *  judged against 3 intervals; no timestamp at all is honest uncertainty, never a green light. */
function watcherHealth(o) {
  const now = Number.isFinite(o && o.now) ? o.now : Date.now();
  const intervalSec = Number.isFinite(o && o.intervalSec) && o.intervalSec > 0 ? o.intervalSec : 120;
  if (!o || !o.pidAlive) return { state: 'not-running', staleSec: null, intervalSec };
  const ms = o.lastCheckAt ? Date.parse(o.lastCheckAt) : NaN;
  if (!Number.isFinite(ms)) return { state: 'unknown', staleSec: null, intervalSec };
  const staleSec = Math.max(0, Math.round((now - ms) / 1000));
  return { state: staleSec > intervalSec * 3 ? 'stale' : 'running', staleSec, intervalSec };
}

// ---- real usage (official endpoint; token in-memory only, never logged) ----
/** credError(e) -> a FIXED-text error for a credentials-file failure (L1, 2026-09-24). A JSON.parse message quotes
 *  ±10 characters of its input (a torn read could put a token fragment into state/log) and an fs message carries the
 *  absolute home path — neither may reach FORGE_USAGE_GUARD_STATE.json or the log. Only the error's code/name. */
function credError(e) {
  const code = e && typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code) ? e.code : (e && typeof e.name === 'string' ? e.name : 'Error');
  return new Error('credentials file unreadable (' + code + ')');
}
/** credentialsPresent() — M6: the guard can only measure with the login FILE; on macOS Claude Code keeps the
 *  login in the Keychain, so a default-on guard would start and never measure. */
function credentialsPresent() {
  try { return fs.statSync(CRED_FILE).isFile(); } catch { return false; }
}
function noCredentialsLine(tail) {
  return 'usage guard cannot measure on this machine: no ~/.claude/.credentials.json (macOS keeps the login in the Keychain) — ' + tail;
}
/** guardNetworkAllowed(opts) -> { ok, reason } — GUARD-OFF-BYPASS (2026-09-24): the SINGLE point both
 *  fetchUsage() and pc() consult before ever touching the network or reading the login token. With the
 *  owner's `usage-guard` switch off (or its settings unreadable) NO command path may read the OAuth
 *  token or contact Paperclip — not `check`, not `status`, not `credits`, not `watch --once`, not the
 *  exported `tick`/`doPause`/`doResume`, and not the Paperclip call inside `override-on`.
 *
 *  V18 DECISION / V18 FINAL EXCEPTION TABLE (Codex recheck wp-f4 2026-09-24; RE-PINNED on the second
 *  recheck, 2026-09-24 after V18 was found PARTLY CLOSED — a real third exception existed in code but was
 *  undocumented). There are now exactly THREE documented exceptions, and no other bypass anywhere in this
 *  file:
 *   (1) ONE-SHOT, READ-ONLY — opts.force === true on `check`/`status`/`credits` (mirrors
 *       nvidia-provider.cjs's identical --force convention). Never resumes a paused agent, never changes
 *       any owner setting, never suppresses the guard beyond the single measurement it makes. NOT gated by
 *       forge-ownergrant.cjs — this is the chosen, permanent contract for this flag, not an oversight (the
 *       V18 DECISION: plain --force stays a bare CLI escape hatch, never wired to verifyOwnerGrant()).
 *   (2) VERIFIED-GRANT, CONSEQUENTIAL — `override-on`'s own Paperclip resume calls, gated on a VERIFIED
 *       owner-authorisation grant (forge-ownergrant.cjs), passed down as `{ force: true }` only AFTER
 *       verifyOwnerGrant() succeeds. Resumes paused agents AND suppresses the guard for the rest of the
 *       window — consequential, so it requires more than a bare flag.
 *   (3) VERIFIED-GRANT, SUSTAINED — a CONTINUOUS forced watcher (`start --force` / `watch --force`,
 *       WITHOUT --once) that keeps measuring on a real interval while the owner's switch is off, until it
 *       has seen the switch on at least once. The second recheck proved this was a REAL, repeatedly-
 *       exercised bypass (three off-state ticks, no grant check at all) masquerading as exception (1)'s
 *       "one-shot diagnostic" characterization — it is neither one-shot NOR read-only-in-effect (it is a
 *       standing background process). The fix: `start --force` and `watch --force` (continuous) now REQUIRE
 *       the SAME verified owner-authorisation grant as (2) (see verifyForcedWatchGrant() below and the CLI
 *       handlers) — refused with a plain NL/EN reason (exit 3) without one. A plain one-shot `--force`
 *       remains UNCHANGED: it is exception (1) only on `check`/`status`/`credits`/`watch --once`, never on
 *       continuous `start`/`watch`.
 *  Never throws. See the drift-canary test pinning this exact table in usage-guard.test.cjs. */
function guardNetworkAllowed(opts) {
  const o = opts || {};
  if (o.force === true) return { ok: true, reason: null };
  const sw = readGuardSwitch(o);
  if (sw.on) return { ok: true, reason: null };
  return {
    ok: false,
    reason: sw.unreadable
      ? 'instellingen onleesbaar — geen netwerkverkeer (veilige standaard: uit) / settings unreadable — no network traffic (safe default: off)'
      : 'usage-guard staat uit — geen aanroep naar het meetpunt of Paperclip (aanzetten: /forge config set usage-guard aan; eenmalig toch meten: --force) / usage guard is switched off — no request to the usage endpoint or Paperclip (turn it back on: /forge config set usage-guard aan; measure once anyway: --force)',
  };
}
// TRUSTED_OWNERGRANT_ROOT (N06, third Codex recheck, 2026-09-24 — REPLACES the second recheck's
// FORGE_USAGE_GUARD_OWNERGRANT_ROOT environment variable, which was itself the vulnerability): production
// authorisation for `override-on` and continuous forced watching (`start --force` / `watch --force`) is now
// anchored SOLELY to this real project root — never to anything an environment variable can select. Codex's
// exact reproduction: a caller sets FORGE_USAGE_GUARD_OWNERGRANT_ROOT to point at a scratch directory
// containing a caller-chosen "grant" file, and the SAME process that is asking for permission gets to decide
// which directory's secret authorises it — exactly the "verified against a value I just chose" failure mode
// forge-ownergrant.cjs's own file header already names as the reason an env var is never accepted for the
// secret ITSELF. The root selection had quietly reopened the identical hole one layer up. `let`, never
// re-derived from `process.env` anywhere below, and never read by any `argv()`/CLI-flag path either — a real
// `node usage-guard.cjs ...` invocation can NEVER change it, no matter what is in its environment or
// arguments.
let TRUSTED_OWNERGRANT_ROOT = path.resolve(__dirname, '..', '..');
/** __setOwnerGrantRootForTests(root) — a MODULE-LEVEL SEAM, reachable ONLY by code that `require()`s this
 *  file directly and calls this exported function in the SAME process (this project's own `spawnGuardProbe`/
 *  probe-script convention). The `require.main === module` CLI dispatch below never calls this — a real CLI
 *  invocation has no flag, env var or other input that reaches it, so it cannot be used to redirect
 *  production authorisation. Passing a falsy/non-string value resets to the real trusted root. */
function __setOwnerGrantRootForTests(root) {
  TRUSTED_OWNERGRANT_ROOT = (typeof root === 'string' && root) ? root : path.resolve(__dirname, '..', '..');
}
/** verifyForcedWatchGrant(token) -> { ok, reason } — V18 exception (3): the SAME verified owner-
 *  authorisation check override-on uses (forge-ownergrant.cjs), reused here so continuous forced watching
 *  (`start --force` / `watch --force`, never `--once`) is gated identically to any other CONSEQUENTIAL,
 *  SUSTAINED bypass of the owner's off switch. Never throws. */
function verifyForcedWatchGrant(token) {
  const og = require('./forge-ownergrant.cjs');
  return og.verifyOwnerGrant({ token, projectRoot: TRUSTED_OWNERGRANT_ROOT });
}
/** runOverrideOn() — the `override-on` command body. Extracted from the `require.main === module` CLI
 *  dispatch (N11, 2026-09-24, Security Boss addendum reconfirmed) into a plain, exported, directly-callable
 *  function so it can be exercised end-to-end — including injected removal/lock failures — from a test via
 *  `require()` + `__setOwnerGrantRootForTests()`, the SAME safe, real-module, scratch-root convention this
 *  file already uses for verifyForcedWatchGrant/the V15 grant probes, never by writing to this project's own
 *  live `.claude/config/forge-owner-grant.txt`. Reads `argv`/`has`/`cmd` from the module scope exactly like
 *  every other command handler in this file. N11 status wording lives in usage-guard-override.cjs's
 *  describeOverrideLockOutcome() (shared with runOverrideOff()). Always calls `process.exit(...)`. */
async function runOverrideOn() {
  // OWNER AUTHORISATION REQUIRED (broad Codex audit #6, fixed 2026-08-05): a token matched against a secret
  // in a FILE the owner writes (forge-ownergrant.cjs) — an env var is deliberately not accepted, since the
  // process asking for permission can set its own environment.
  const og = require('./forge-ownergrant.cjs');
  const grant = og.verifyOwnerGrant({ token: argv('owner-approval', null), projectRoot: TRUSTED_OWNERGRANT_ROOT });
  if (!grant.ok) {
    console.error('usage-guard override-on REFUSED — ' + grant.reason);
    console.error('  run: node .claude/forge-bin/usage-guard.cjs override-on --owner-approval <token> --reason "<why>"');
    process.exit(3);
  }
  const rawUntil = argv('until', null) || null;
  if (rawUntil && !Number.isFinite(Date.parse(rawUntil))) console.error('ignoring invalid --until "' + rawUntil + '" (not a parseable date) — falling back to the default backstop expiry');
  // N12: `until` is mandatory at the storage layer (forge-ownergrant.cjs's readOverrideGrant reads a
  // missing/unparseable expiry as INVALID, never "unlimited") — resolveGrantUntil fills a bounded backstop
  // when the owner did not supply one; credit exhaustion stays the PRIMARY, expected re-arm path.
  const until = guardOverride.resolveGrantUntil(rawUntil);
  const reason = argv('reason', 'Eigenaar kocht usage credits — doorwerken op credits tot ze op zijn');
  // N10: bind the authoritative grant to the account it is being granted FOR — an unbound (project-wide)
  // grant used to survive an account switch and suppress a DIFFERENT account's protection (see
  // usage-guard-override.cjs's resolveOwnerOverride and forge-ownergrant.cjs's own header).
  const grantIdent = readAccountIdentity();
  // V15 (FOURTH Codex recheck, 2026-09-24): write the AUTHORITATIVE grant record FIRST and
  // UNCONDITIONALLY — the override must take effect even when the state lock (below) is busy; every
  // subsequent tick reconciles the cache from THIS record, never the other way around.
  if (!og.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason, accountLabel: grantIdent.fp }, { projectRoot: TRUSTED_OWNERGRANT_ROOT })) {
    console.error('usage-guard override-on FAILED — could not write the authoritative override-grant record to disk; no change made; try again');
    process.exit(1);
  }
  // GUARD-STATE-RACE: best-effort cache/agent bookkeeping below — the grant above has ALREADY taken effect
  // regardless of this lock's outcome (see describeOverrideLockOutcome's own doc comment for N11 wording).
  const onLock = await withStateLock(async (fence) => {
    const st = readState();
    // GUARD-OFF-BYPASS: force:true here is safe ONLY because verifyOwnerGrant() just succeeded above (a
    // VERIFIED owner action, not a bare CLI flag) — see guardNetworkAllowed()'s own doc comment.
    const wasPaused = (st.pausedAgents || []).length;
    let resumed = 0;
    for (const a of (st.pausedAgents || [])) { const r = await pc('POST', '/api/agents/' + a.id + '/resume', {}, { force: true }); if (r.status >= 200 && r.status < 300) resumed++; }
    st.mode = 'ok'; st.pausedAgents = []; delete st.notice; delete st.pendingCheckup; delete st.lastError;
    // N01: stamp the account this override is being granted FOR, exactly like a real tick would — see
    // detectAccountSwitch()'s own doc comment for why an unstamped state misreads a real switch as adoption.
    Object.assign(st, accountStamp(readAccountIdentity()));
    st.ownerOverride = guardOverride.cachedOverrideFrom({ active: true, at: new Date().toISOString(), reason, until });
    if (fence && !fence()) return { fenced: true };
    try { writeState(st, fence); } catch (e) { if (e && e.code === 'EFENCED') return { fenced: true }; throw e; }
    return { fenced: false, resumed, wasPaused };
  });
  const outcome = guardOverride.describeOverrideLockOutcome('on', onLock, { until });
  console[outcome.partial ? 'error' : 'log'](outcome.line);
  process.exit(0);
}

/** runOverrideOff() — the `override-off` command body (extracted for the SAME test-reachability reason as
 *  runOverrideOn() above). Always calls `process.exit(...)`. */
async function runOverrideOff() {
  // V15/N11: clear the AUTHORITATIVE grant record FIRST — the safety direction (re-arming the guard). N11
  // MEASURED DEFECT (`V15-override-off-unlink-failure-status`): a FAILED removal used to still exit 0 and
  // report "re-armed" while the grant stayed active — now reported honestly as NOT re-armed, nonzero exit.
  const grantCleared = require('./forge-ownergrant.cjs').writeOverrideGrant({ active: false }, { projectRoot: TRUSTED_OWNERGRANT_ROOT });
  if (!grantCleared) {
    console.error('usage-guard override-off FAILED — could not clear the authoritative override-grant record on disk; protection is NOT re-armed; try again');
    process.exit(1);
  }
  // GUARD-STATE-RACE: best-effort cache/pausedAgents bookkeeping below — the grant is ALREADY cleared
  // regardless of this lock's outcome (protection IS re-armed either way).
  const offLockResult = await withStateLock((fence) => {
    const st = readState(); const had = !!st.ownerOverride; delete st.ownerOverride;
    if (fence && !fence()) return { fenced: true };
    try { writeState(st, fence); } catch (e) { if (e && e.code === 'EFENCED') return { fenced: true }; throw e; }
    return { fenced: false, had };
  });
  const outcome = guardOverride.describeOverrideLockOutcome('off', offLockResult, {});
  console[outcome.partial ? 'error' : 'log'](outcome.line);
  process.exit(0);
}
function readToken() {
  let raw;
  try { raw = fs.readFileSync(CRED_FILE, 'utf8'); } catch (e) { throw credError(e); }
  let cred;
  try { cred = JSON.parse(raw); } catch (e) { throw credError(e); }
  const t = cred && cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
  if (!t) throw new Error('no OAuth token in the credentials file (.credentials.json)');
  // GUARD-TOKEN-ERROR (2026-09-24): validate the token's SHAPE before it is EVER used to build a request
  // header. An embedded control character (e.g. an injected newline) reaching fetch()'s Headers
  // construction makes Node throw a TypeError that quotes the REJECTED VALUE verbatim — exactly the
  // credential fragment this check exists to keep out of state/log/output.
  if (!guardRedact.validateTokenShape(t)) throw new Error('OAuth token in the credentials file has an unexpected shape (rejected before use)');
  // CODEX ronde-3 #1 (2026-08-06): de vingerafdruk van het credential dat DEZE fetch werkelijk gebruikt,
  // afgeleid in DEZELFDE read als het token zelf (zelfde derivatie als readCredentialFp). De dubbele
  // identiteits-lezing rond de fetch leest ~/.claude.json — een ANDER bestand dat tijdens een login later
  // kan omklappen dan .credentials.json. Zonder deze binding kon het token al van account B zijn terwijl
  // beide identiteits-lezingen nog A meldden. GUARD-TOKEN-FINGERPRINT: kept ENTIRELY in memory for that
  // one comparison (tick()'s mid-check rotation check) — never persisted to state/journal/log/stdout.
  const rt = cred.claudeAiOauth && cred.claudeAiOauth.refreshToken;
  const credFp = typeof rt === 'string' && rt ? crypto.createHash('sha256').update('rt:' + rt).digest('hex').slice(0, 12) : null;
  return { token: t, credFp };
}
/** combinedSignal(signals) -> an AbortSignal that aborts as soon as ANY given signal aborts. Manual
 *  composition rather than AbortSignal.any() (Node 20.3+) so this keeps working on older Node runners.
 *  Pure w.r.t. its inputs. */
function combinedSignal(signals) {
  const ac = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}
// GUARD-STOP (2026-09-24): a module-level shutdown signal, consulted by fetchUsage() so the watch loop's
// own SIGTERM handler can abort an ALREADY-IN-FLIGHT request, not merely prevent the NEXT one. Aborted
// at most once, only by the watch loop's shutdown handler below.
const SHUTDOWN_AC = new AbortController();
async function fetchUsage(opts) {
  // GUARD-OFF-BYPASS (2026-09-24): checked BEFORE readToken() — the login file is never even opened
  // when the guard is off and no exception applies.
  const gate = guardNetworkAllowed(opts);
  if (!gate.ok) throw Object.assign(new Error(gate.reason), { code: 'GUARD_OFF' });
  // TIMEOUT (Codex adversarial review #8, 2026-08-03): this call had none. A hung request does not throw —
  // it simply never settles, so the tick never finishes and the watcher stops measuring while its process
  // stays alive: exactly the silent-death shape this guard was fixed for once already. 30s is far beyond
  // a healthy response and far below the tick interval, so a timeout can never stack ticks.
  // wp20: read the login BEFORE arming the timer — a readToken() throw used to leave this 30 s timer holding the
  // process open (every `check`/`watch --once` with a bad login file lingered 30 s before exiting).
  const cred = readToken(); // token + credential-vingerafdruk uit EEN read (ronde-3 #1)
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  // GUARD-STOP: an external abort signal (opts.signal, the watch loop's per-tick request signal — see
  // watchStep()) is combined with the internal deadline signal, so EITHER a timeout OR an explicit
  // shutdown aborts this specific request.
  const requestSignal = opts && opts.signal ? combinedSignal([ac.signal, opts.signal]) : ac.signal;
  // GUARD-BODY-TIMEOUT (2026-09-24): clearTimeout now happens in THIS outer finally, which covers
  // r.json() (body consumption) as well as the initial fetch() call. It used to run in an inner finally
  // right after the response HEADERS arrived — a response that resolved its headers instantly but then
  // stalled or trickled its body could hang well past the claimed 30s deadline with no timer left armed
  // to stop it. The SAME AbortController/signal now stays live through the entire request, including
  // body streaming, so a stall at any point is still aborted at the deadline.
  try {
    let r;
    try {
      r = await fetch(USAGE_URL, {
        headers: { authorization: 'Bearer ' + cred.token, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
        signal: requestSignal,
      });
    } catch (e) {
      if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
        throw new Error(opts && opts.signal && opts.signal.aborted
          ? 'usage endpoint request aborted (watcher shutting down) — treated as a failed check, never as "usage is fine"'
          : 'usage endpoint timed out after ' + Math.round(FETCH_TIMEOUT_MS / 1000) + 's (no response) — treated as a failed check, never as "usage is fine"');
      }
      // GUARD-TOKEN-ERROR (2026-09-24): never rethrow `e` verbatim — see readToken()'s own doc comment
      // for the exact leak shape this closes. Only a fixed, non-echoing diagnostic code ever surfaces.
      throw new Error('usage endpoint request failed (' + guardRedact.transportErrorCode(e) + ')');
    }
    if (!r.ok) throw new Error('usage endpoint HTTP ' + r.status);
    let j;
    try {
      j = await r.json();
    } catch (e) {
      if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) {
        throw new Error(opts && opts.signal && opts.signal.aborted
          ? 'usage endpoint request aborted mid-body (watcher shutting down) — treated as a failed check, never as "usage is fine"'
          : 'usage endpoint timed out after ' + Math.round(FETCH_TIMEOUT_MS / 1000) + 's (response body never completed) — treated as a failed check, never as "usage is fine"');
      }
      throw new Error('usage endpoint returned unparsable data (' + guardRedact.transportErrorCode(e) + ')');
    }
    const fh = j.five_hour || {}, sd = j.seven_day || {};
    return {
      session: { pct: Number(fh.utilization ?? NaN), resetsAt: fh.resets_at || null },
      week: { pct: Number(sd.utilization ?? NaN), resetsAt: sd.resets_at || null },
      // every window the endpoint reports, typed — session/weekly_all/weekly_scoped and any future kind
      // (see normalizeWindows). The two named fields above stay for the existing pressure/reporting paths.
      windows: normalizeWindows(j),
      credits: creditsFrom(j),
      credentialFp: cred.credFp, // welke credential deze cijfers ECHT ophaalde (ronde-3 #1) — memory-only
    };
  } finally { clearTimeout(timer); }
}
// ---- purchased usage credits ("extra_usage") — the SEPARATE budget that keeps working past the plan limit ----
function creditsFrom(j) { const e = (j && j.extra_usage);
  const present = !!e && typeof e === 'object';        // distinguish "no credit data" from "credits disabled" (fix 2026-07-09)
  const src = present ? e : {};
  const limit = Number(src.monthly_limit), used = Number(src.used_credits);
  return { present, enabled: src.is_enabled === true, limit, used,
    remaining: (Number.isFinite(limit) && Number.isFinite(used)) ? (limit - used) : NaN,
    disabledReason: src.disabled_reason || null, currency: src.currency || 'EUR', decimals: Number(src.decimal_places != null ? src.decimal_places : 2) }; }
function creditsExhausted(c) { if (!c || !c.present) return false; // NO data (endpoint omitted extra_usage) → do NOT lift the override
  if (c.enabled === false) return true;                 // extra usage turned off / depleted
  if (c.disabledReason) return true;                    // provider disabled it (e.g. spend limit reached)
  if (Number.isFinite(c.remaining) && c.remaining <= 0) return true; // spend limit hit
  return false; }
function fmtMoney(cents, cur, dec) { if (!Number.isFinite(cents)) return '?'; dec = dec == null ? 2 : dec; return '€' + (cents / Math.pow(10, dec)).toFixed(dec) + (cur && cur !== 'EUR' ? ' ' + cur : ''); }

// ---- paperclip helpers (loopback only) ----
/** pc(method, p, body, opts) -> the OTHER GUARD-OFF-BYPASS choke point (2026-09-24), alongside
 *  fetchUsage() — see guardNetworkAllowed()'s own doc comment for the exact policy and its two
 *  documented exceptions. A blocked call returns the SAME {status, json, err} shape every caller
 *  already handles (status 0 = unreachable/blocked), so no call site needed to change its error
 *  handling — allAgents() already treats any non-array `.json` as "runtime unreachable", and doPause/
 *  doResume already treat a non-2xx status as a failed pause/resume attempt.
 *  V29 (Codex recheck wp-f4, 2026-09-24): opts.signal — when provided (threaded down from tick()'s own
 *  fetchUsage() cancellation signal, via doPause()/doResume()/allAgents()) — is combined with this call's
 *  own fixed 10s timeout, so a SIGTERM during a pause/resume round now aborts the in-flight Paperclip
 *  request too, not only the usage-endpoint fetch. An already-aborted signal refuses immediately, before
 *  ever touching the network. */
async function pc(method, p, body, opts) {
  const o = opts || {};
  const gate = guardNetworkAllowed(o);
  if (!gate.ok) return { status: 0, json: null, err: gate.reason, blocked: true };
  if (o.signal && o.signal.aborted) return { status: 0, json: null, err: 'aborted (shutdown)', aborted: true };
  const signal = o.signal ? combinedSignal([AbortSignal.timeout(10000), o.signal]) : AbortSignal.timeout(10000);
  try {
    const r = await fetch(PC_BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, json: j };
  } catch (e) {
    // V29 (third Codex recheck, 2026-09-24): a request that was CANCELLED mid-flight (the combined signal
    // aborted while the fetch was in progress — o.signal.aborted flips to true DURING the await above, not
    // only before it, which is the pre-check a few lines up) is not a completed API failure — it is
    // unfinished work. Without `aborted:true` here, the caller could not tell "this agent's pause/resume
    // genuinely failed" from "shutdown cut this one off mid-request", and treated both identically as a
    // resolved miss (Codex's exact finding: the interrupted agent was lost, never retried).
    //
    // N08 (Codex recheck out-p10, 2026-09-24 — FOURTH recheck of this file): shutdown cancellation is now
    // detected SOLELY from the guard's OWN AbortSignal — `o.signal` is the caller's shutdown signal (thread-
    // ed down from tick()'s own cancellation), a DIFFERENT signal from the `signal` this call actually gave
    // fetch() (that one is `combinedSignal([AbortSignal.timeout(10000), o.signal])` — also trips on the
    // plain 10s per-request deadline). The OLD check also matched `e.name === 'AbortError'` or a message
    // regex (`/abort/i`) — Node's own request-deadline error, once the internal 10s timer fires, is a
    // TimeoutError whose MESSAGE TEXT is "The operation was aborted due to timeout": the regex matched the
    // word "aborted" inside it and misclassified an ordinary, COMPLETED transport failure as a shutdown
    // cancellation. That single wrong flag then fed doPause()'s own `pending` bookkeeping (see tick()'s own
    // N08 fix below) — repeatedly re-queuing a genuinely-failing (never actually cancelled) request as
    // "unfinished work" forever, instead of resolving it as a real failure. `o.signal.aborted` is the ONLY
    // thing checked now: it is `true` if, and only if, the CALLER's own shutdown signal is the one that
    // fired (it flips synchronously the instant `.abort()` is called on it, before any 'abort' listener
    // runs, so it is already correct by the time this catch block observes it).
    const wasAborted = !!(o.signal && o.signal.aborted);
    return { status: 0, json: null, err: String(e.message), ...(wasAborted ? { aborted: true } : {}) };
  }
}
/** allAgents(opts) -> opts.signal threads through to every pc() call (V29) and stops enumerating further
 *  companies/agents the moment shutdown begins — "no subsequent operation after shutdown began" applies to
 *  the enumeration loop itself, not only the single in-flight request. */
async function allAgents(opts) {
  const o = opts || {};
  const comps = await pc('GET', '/api/companies', undefined, { signal: o.signal });
  if (!Array.isArray(comps.json)) return null; // runtime down / unreachable
  const out = [];
  for (const c of comps.json) {
    if (o.signal && o.signal.aborted) break; // V29: no further company/agent listing once shutdown began
    if (ONLY_COMPANIES.length && !ONLY_COMPANIES.includes(c.name)) continue;
    const ag = await pc('GET', '/api/companies/' + c.id + '/agents', undefined, { signal: o.signal });
    for (const a of (Array.isArray(ag.json) ? ag.json : [])) out.push({ id: a.id, name: a.name, company: c.name, status: a.status });
  }
  return out;
}

// A null/absent/unparseable reset must read as "onbekend" — `new Date(null)` is the epoch, which printed
// a confident, fabricated-looking "1/1/1970" in every notice and status line (measured 2026-08-03).
function fmtReset(iso) {
  if (iso === null || iso === undefined || iso === '') return 'onbekend';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'onbekend';
  try { return new Date(ms).toLocaleString(); } catch { return String(iso); }
}

// ---- transitions ----
/** accountStamp — the explicit account field for a pause/resume write (broad Codex audit #13,
 *  2026-08-05). doPause/doResume build FRESH state objects; the stamp used to arrive only via
 *  writeStateTo's read-the-previous-file carry — one more disk read in exactly the window where a
 *  mid-check login switches accounts. The tick now hands its VALIDATED identity down, so the write
 *  carries the account it actually measured, not whatever happens to be on disk at write time. */
function accountStamp(ident) {
  return ident && ident.fp ? { account: { fp: ident.fp, source: ident.source, stampedAt: new Date().toISOString() } } : {};
}
/** withStateLock(fn) -> await fn()'s result, having serialized it against every other state-writing
 *  transaction via an exclusive lock on STATE_FILE + '.lock' (GUARD-STATE-RACE, 2026-09-24; FAIL-CLOSED
 *  fix, Codex recheck wp-f4 V15, 2026-09-24 — see usage-guard-state.cjs's own header for the full V15
 *  rationale and the exact bug this closes). doPause()/doResume()/override-on/override-off and every
 *  tick()-internal read-modify-write (see withLockedState() below) all go through this ONE function, so a
 *  concurrent writer's change (most concretely: an owner clearing ownerOverride via `override-off` while a
 *  pause round is mid-flight) can never be silently reverted the moment an earlier caller finally writes
 *  back what it read before the change. The lock does not change WHAT is read/written; every caller must
 *  still re-read the state FRESH from INSIDE the lock immediately before constructing its write. Returns
 *  {ok:true, value:<fn()'s return>} on success, or {ok:false, reason} — fn() is NEVER invoked on a refusal;
 *  every caller MUST check `.ok` instead of assuming the write landed. */
function stateLockPath() { return STATE_FILE + '.lock'; }
// STATE_LOCK_STALE_MS (V15, second Codex recheck, 2026-09-24): a SEPARATE knob from STALE_LOCK_MS above
// (that one guards the unrelated pid-file watcher-slot takeover). Env-overridable ONLY for deterministic,
// fast tests — mirrors this project's own FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS convention; unset, the
// default (60000ms) is unchanged from before this fix.
const STATE_LOCK_STALE_MS = Number(process.env.FORGE_USAGE_GUARD_STATE_LOCK_STALE_MS) > 0
  ? Number(process.env.FORGE_USAGE_GUARD_STATE_LOCK_STALE_MS) : 60 * 1000;
async function withStateLock(fn) {
  return guardState.withStateLock(stateLockPath(), fn, { staleMs: STATE_LOCK_STALE_MS, log });
}
/** withLockedState(D, transform, label) -> the usage-guard-specific read-modify-write helper built on top
 *  of withStateLock (V15, 2026-09-24; FENCED on the second Codex recheck, 2026-09-24). Re-reads state
 *  FRESH from inside the lock, calls `transform(fresh)`: if it returns a value, THAT becomes the object
 *  written (a full replacement, for a transform like stateForAccount() that intentionally starts clean);
 *  if it returns undefined, the (possibly in-place-mutated) `fresh` object itself is written. On a lock
 *  refusal the write is skipped entirely — never unlocked — and logged once via D.log. V15 FENCING: right
 *  before the actual disk write, this now calls the lock's own `fence()` (see usage-guard-state.cjs) — if
 *  our token is no longer the one on disk (a waiter reclaimed this lock as stale WHILE `transform` was
 *  computing, e.g. a slow synchronous transform racing a heartbeat hiccup), the write is skipped and
 *  reported as a refusal (`reason:'fenced'`) exactly like a lock-timeout, never silently applied after
 *  losing ownership. Returns the same {ok, value, reason} shape as withStateLock. */
async function withLockedState(D, transform, label) {
  const r = await withStateLock((fence) => {
    const fresh = D.readState();
    const result = transform(fresh);
    const next = result !== undefined ? result : fresh;
    if (fence && !fence()) return { __fenced: true };
    // V15 (third recheck): `fence` is forwarded into the write itself — see writeStateTo's own doc comment
    // for why the EARLIER check on the line above is not, by itself, sufficient.
    try { D.writeState(next, fence); } catch (e) { if (e && e.code === 'EFENCED') return { __fenced: true }; throw e; }
    return { __fenced: false, next };
  });
  if (r.ok && r.value && r.value.__fenced) {
    D.log('state-lock: ' + label + ' — de lock werd tijdens deze transactie door een andere schrijver overgenomen (fenced); '
      + 'schrijf overgeslagen, volgende gelegenheid probeert opnieuw / this lock was reclaimed by another writer '
      + 'mid-transaction (fenced); write skipped, the next opportunity retries');
    return { ok: false, reason: 'fenced' };
  }
  if (!r.ok) {
    D.log('state-lock: ' + label + ' — ' + r.reason + ' (geen schrijf deze ronde, volgende gelegenheid probeert '
      + 'opnieuw / no write this round, the next opportunity retries)');
    return r;
  }
  return { ok: true, value: r.value.next };
}
async function doPause(u, crossed, ident, opts) {
  const o = opts || {};
  const signal = o.signal;
  const agents = await allAgents({ signal });
  const toPause = (agents || []).filter((a) => a.status !== 'paused');
  const reason = 'USAGE GUARD: ' + crossed.map((c) => c.name + ' ' + c.pct + '%').join(' + ') + ' >= ' + PAUSE_AT + '% — auto-paused. Auto-resume when back to <= ' + RESUME_AT + '%.';
  if (DRY) { log('[dry-run] WOULD pause ' + toPause.length + ' agents (' + reason + ')'); return; }
  const paused = [];
  // r4 #15: een pauzeronde heeft een eigen pauseId en het journal is WRITE-AHEAD — de intent staat er
  // VOOR de API-call, zodat een crash direct na een geslaagde pause de compensatie nooit meer verliest.
  const pauseId = crypto.randomUUID();
  // V29 (second Codex recheck, 2026-09-24): `stopIndex` marks where the loop below stopped — every agent
  // AT OR AFTER that index in `toPause` was never even attempted this round (an abort, not an API failure)
  // and is genuine UNFINISHED pause work, not a resolved miss. `pending` (built below) is what the caller
  // must persist so the NEXT tick retries exactly these agents instead of believing the round is complete.
  let stopIndex = toPause.length;
  for (let idx = 0; idx < toPause.length; idx++) {
    const a = toPause[idx];
    // V29: once shutdown has begun, no SUBSEQUENT pause request may be issued — the in-flight one is
    // already aborted by pc()'s own combined signal; this stops the LOOP from starting yet another one for
    // the remaining agents.
    if (signal && signal.aborted) { stopIndex = idx; log('PAUSE aborted mid-round (shutdown) — ' + (toPause.length - idx) + ' agent(s) left unpaused for the next tick'); break; }
    journalAppend({ agentId: a.id, name: a.name, company: a.company, action: 'pause-intent', pauseId, accountFp: (ident && ident.fp) || null, resolved: false });
    const r = await pc('POST', '/api/agents/' + a.id + '/pause', { reason }, { signal });
    if (r.status >= 200 && r.status < 300) {
      paused.push({ id: a.id, name: a.name, company: a.company });
      journalAppend({ agentId: a.id, name: a.name, company: a.company, action: 'paused', pauseId, accountFp: (ident && ident.fp) || null, resolved: false });
    } else if (r.aborted) {
      // V29 (THIRD Codex recheck, 2026-09-24): a cancellation DURING this agent's own in-flight request is
      // NOT a completed API failure — it is unfinished pause work. The pre-loop-iteration check above only
      // ever catches shutdown that began BEFORE a request was issued; this is the case Codex's probe
      // exploited (abort the ONLY agent's in-flight pause request — the old code fell into the `else`
      // branch below, journalled it as a RESOLVED miss, and lost it forever). Leave the earlier
      // 'pause-intent' journal entry UNRESOLVED (never append a 'pause-failed' close for it) and fold this
      // agent — and everything after it — into `pending` so the very next tick retries it.
      stopIndex = idx;
      log('PAUSE aborted mid-request (shutdown) for ' + a.id + ' — ' + (toPause.length - idx) + ' agent(s) (including this one) left unpaused for the next tick');
      break;
    } else {
      // de pause-API faalde: de intent afsluiten — er is niets te compenseren voor deze agent (a resolved
      // MISS, not unfinished work — a retry loop on a genuinely failing agent would spin forever).
      journalAppend({ agentId: a.id, action: 'pause-failed', pauseId, resolved: true });
    }
  }
  const pending = toPause.slice(stopIndex).map((a) => ({ id: a.id, name: a.name, company: a.company }));
  compactJournalIfNeeded();
  // RESET-RHYTHM: resumeAtEpoch = soonest crossed metric's resets_at + GRACE_MIN. NaN-safe — if every
  // crossed metric's resets_at is unparseable, resumeAtEpoch is OMITTED (not stored as null/NaN) so
  // both this watchdog and the hook fall back cleanly to the utilization-based resume only.
  let soonestResetMs = NaN;
  for (const c of crossed) {
    // the crossed window carries its OWN resets_at (typed windows); the legacy session/week lookup is
    // only the fallback for a caller that still passes the old {metric:'session'|'week'} shape.
    const resetsAt = c.resetsAt || (c.metric === 'session' ? u.session.resetsAt : u.week.resetsAt);
    const ms = Date.parse(resetsAt);
    if (Number.isFinite(ms)) soonestResetMs = Number.isFinite(soonestResetMs) ? Math.min(soonestResetMs, ms) : ms;
  }
  const resumeAtEpoch = Number.isFinite(soonestResetMs) ? (soonestResetMs + GRACE_MIN * 60000) : NaN;
  // GUARD-STATE-RACE (2026-09-24): `cur` is read FRESH from inside the state lock, immediately before
  // the write — never at the top of this function, before the allAgents()/pc() awaits above. Reading it
  // early (the pre-fix shape) meant a concurrent `override-off` clearing ownerOverride DURING those
  // awaits could be silently reverted the moment this pause finally wrote back the stale value it read
  // before the clear.
  const pauseLock = await withStateLock((fence) => {
    const cur = readState(); // preserve owner intent across a pause (fix 2026-07-09 checkup) — FRESH, under the lock
    // V29 (second recheck): merge with whatever this account's pausedAgents ALREADY held (e.g. a prior,
    // earlier-interrupted round that paused some agents already) so a RETRY round's write never makes the
    // display list forget agents a previous round already, genuinely, paused via the API.
    const mergedPaused = (() => {
      const map = new Map();
      for (const p of (cur.pausedAgents || [])) map.set(String(p.id), p);
      for (const p of paused) map.set(String(p.id), p);
      return Array.from(map.values());
    })();
    if (fence && !fence()) return { fenced: true };
    try {
    writeState({
      mode: 'paused', trigger: crossed, pauseAt: PAUSE_AT, resumeAt: RESUME_AT,
      ...accountStamp(ident),
      // NEVER silently drop the owner's paid-credits override / last credit snapshot on a pause — the hook
      // reads ownerOverride to keep working; a fresh object without it defeated that (an accounting desktop app flapping).
      ...(cur.ownerOverride ? { ownerOverride: cur.ownerOverride } : {}),
      ...(cur.credits ? { credits: cur.credits } : {}),
      percents: { session: u.session.pct, week: u.week.pct }, resets: { session: u.session.resetsAt, week: u.week.resetsAt },
      pausedAgents: mergedPaused, lastPauseAt: new Date().toISOString(), lastCheckAt: new Date().toISOString(),
      graceMin: GRACE_MIN,
      ...(Number.isFinite(resumeAtEpoch) ? { resumeAtEpoch } : {}),
      // V29 (second Codex recheck, 2026-09-24): an interrupted round (pending.length > 0) must NOT be
      // silently reported as a complete pause — pausePending names exactly which agents still need pausing
      // so the "paused" branch of the NEXT tick retries them BEFORE treating the round as done, instead of
      // taking the "still high, wait" branch while real unfinished work remains (Codex's exact schedule:
      // interrupt after pausing A of two, restart, the next 100% tick must still pause B).
      ...(pending.length
        ? { pausePending: pending, lastError: 'pauze onderbroken (shutdown): ' + pending.length + ' agent(s) nog niet gepauzeerd — volgende tick probeert opnieuw / pause interrupted (shutdown): ' + pending.length + ' agent(s) not yet paused — the next tick retries' }
        : { pausePending: undefined }),
      notice: '⛔ USAGE GUARD — PAUZEER. Gemeten (echt): sessie ' + u.session.pct + '% · week ' + u.week.pct + '% (drempel ' + PAUSE_AT + '%). '
        + 'Geen nieuwe subagents/workflows starten. Rond lopend werk minimaal af en meld de pauze. '
        + 'Auto-hervat bij <= ' + RESUME_AT + '% (sessie-reset: ' + fmtReset(u.session.resetsAt) + ')'
        + (Number.isFinite(resumeAtEpoch) ? ', of ritme-hervat rond ' + fmtReset(new Date(resumeAtEpoch).toISOString()) + ' (reset + ' + GRACE_MIN + ' min marge)' : '') + '. '
        + (agents === null ? '(Paperclip runtime onbereikbaar — geen agents te pauzeren; subagent-stop geldt wel.)' : paused.length + ' Paperclip agents gepauzeerd (dashboard blijft UP).'),
    }, fence); // V15 (third recheck): forwarded so the actual publish re-verifies, not only the check above
    } catch (e) { if (e && e.code === 'EFENCED') return { fenced: true }; throw e; }
    return { fenced: false };
  });
  // V15: a lock refusal never wrote unlocked — say so plainly. The agents ABOVE were already paused via
  // the real Paperclip API regardless (that already happened); only the STATE FILE bookkeeping is missing
  // this round, and the next tick re-evaluates from a fresh read.
  if (!pauseLock.ok) log('state-lock: PAUSE state write skipped (' + pauseLock.reason + ') — ' + paused.length + ' agent(s) WERE paused via the API but the state file could not record it this round');
  else if (pauseLock.value && pauseLock.value.fenced) log('state-lock: PAUSE state write skipped (fenced — the lock was reclaimed mid-transaction) — ' + paused.length + ' agent(s) WERE paused via the API but the state file could not record it this round');
  log('PAUSED — ' + reason + ' · paperclip agents paused: ' + paused.length + (agents === null ? ' (runtime unreachable)' : '') + (Number.isFinite(resumeAtEpoch) ? ' · rhythm-resume at ' + new Date(resumeAtEpoch).toISOString() : ' · rhythm-resume: n/a (unparseable resets_at)') + (pending.length ? (' · pausePending: ' + pending.length) : ''));
}
async function doResume(u, st, ident, opts) {
  const o = opts || {};
  const signal = o.signal;
  if (DRY) { log('[dry-run] WOULD resume ' + (st.pausedAgents || []).length + ' agents'); return; }
  let ok = 0;
  // UNIE van de state-lijst en de onopgeloste journalregels (uitgesteld punt 1, 2026-08-06): de state
  // kan door een account-switch gereset zijn terwijl het journal de guard-gepauzeerde agents nog kent.
  // Nog steeds ALLEEN wat de guard zelf pauzeerde — nooit human-paused agents.
  const journalUnresolved = unresolvedPausedAgents();
  const pauseIdByAgent = new Map(journalUnresolved.map((j) => [String(j.agentId), j.pauseId || null]));
  const byId = new Map();
  for (const a of (st.pausedAgents || [])) byId.set(String(a.id), { id: a.id, name: a.name, company: a.company });
  for (const j of journalUnresolved) if (!byId.has(String(j.agentId))) byId.set(String(j.agentId), { id: j.agentId, name: j.name, company: j.company, fromJournal: true });
  const failed = [];
  const items = Array.from(byId.values());
  for (let i = 0; i < items.length; i++) {
    // V29 (Codex recheck wp-f4, 2026-09-24): once shutdown has begun, no SUBSEQUENT resume request may be
    // issued — every remaining agent is treated as "not yet resumed this round" (resumePending below
    // retries them on the next tick), never silently dropped.
    if (signal && signal.aborted) { failed.push(...items.slice(i)); break; }
    const a = items[i];
    const r = await pc('POST', '/api/agents/' + a.id + '/resume', {}, { signal });
    if (r.status >= 200 && r.status < 300) {
      ok++;
      // r4 #15: de resolve draagt de pauseId die hij afsluit — een laat arriverende oude resolve kan een
      // nieuwere pauze dan nooit meer maskeren (unresolvedPausedAgents matcht op pauseId).
      journalAppend({ agentId: a.id, action: 'resumed', pauseId: pauseIdByAgent.get(String(a.id)) || null, resolved: true });
    } else {
      failed.push({ id: a.id, name: a.name, company: a.company });
    }
  }
  // GUARD-STATE-RACE (2026-09-24): both writes below re-read the CURRENT ownerOverride from inside the
  // state lock, immediately before writing, instead of trusting the `st` snapshot this function was
  // called with (captured before the pc() awaits above) — the same fix shape as doPause(). V15: a lock
  // refusal never writes unlocked; it is logged and the next tick retries from a fresh read.
  if (failed.length) {
    // r4 #15: een GEDEELTELIJKE resume schrijft geen mode:'ok' meer — de staat blijft paused met
    // resumePending, zodat de paused-tak van de volgende tick de rest opnieuw probeert.
    const partialLock = await withStateLock((fence) => {
      const fresh = readState();
      const next = Object.assign({}, st, {
        mode: 'paused', pausedAgents: failed, resumePending: true,
        ...accountStamp(ident),
        lastCheckAt: new Date().toISOString(),
        lastError: 'resume gedeeltelijk: ' + ok + '/' + byId.size + ' agents hervat — ' + failed.length + ' faalden; volgende tick probeert opnieuw',
      });
      if (fresh.ownerOverride) next.ownerOverride = fresh.ownerOverride; else delete next.ownerOverride;
      if (fence && !fence()) return { fenced: true };
      try { writeState(next, fence); } catch (e) { if (e && e.code === 'EFENCED') return { fenced: true }; throw e; }
      return { fenced: false };
    });
    if (!partialLock.ok) log('state-lock: RESUME PARTIAL state write skipped (' + partialLock.reason + ') — the next tick still retries the unresolved agents via the journal');
    else if (partialLock.value && partialLock.value.fenced) log('state-lock: RESUME PARTIAL state write skipped (fenced — the lock was reclaimed mid-transaction) — the next tick still retries the unresolved agents via the journal');
    log('RESUME PARTIAL — ' + ok + '/' + byId.size + ' hervat; ' + failed.length + ' gefaald (' + failed.map((f) => f.id).join(',') + ') — staat blijft paused/resumePending');
    return;
  }
  const resumeLock = await withStateLock((fence) => {
    const fresh = readState();
    if (fence && !fence()) return { fenced: true };
    try {
    writeState({
      mode: 'ok', percents: { session: u.session.pct, week: u.week.pct }, resets: { session: u.session.resetsAt, week: u.week.resetsAt },
      ...accountStamp(ident),
      ...(fresh.ownerOverride ? { ownerOverride: fresh.ownerOverride } : {}), // survive the reset (credits mode is orthogonal)
      lastResumeAt: new Date().toISOString(), lastCheckAt: new Date().toISOString(), resumedAgents: ok, pendingCheckup: true,
      resumeNotice: '✅ USAGE GUARD — usage gereset (sessie ' + u.session.pct + '% · week ' + u.week.pct + '%). GA VERDER met waar je mee bezig was. '
        + 'VERPLICHTE CHECKUP: (1) verifieer via de Paperclip API dat de agents resumed zijn en ECHT draaien (statuses + heartbeat-runs/tickets bewegen), '
        + '(2) verifieer dat je eigen taak-status klopt met de werkelijkheid, (3) rapporteer eerlijk wat wel/niet hervat is. '
        + ok + '/' + byId.size + ' Paperclip agents hervat.',
    }, fence);
    } catch (e) { if (e && e.code === 'EFENCED') return { fenced: true }; throw e; }
    return { fenced: false };
  });
  if (!resumeLock.ok) log('state-lock: RESUME state write skipped (' + resumeLock.reason + ') — agents WERE resumed via the API but the state file could not record it this round');
  else if (resumeLock.value && resumeLock.value.fenced) log('state-lock: RESUME state write skipped (fenced — the lock was reclaimed mid-transaction) — agents WERE resumed via the API but the state file could not record it this round');
  log('RESUMED — session ' + u.session.pct + '% week ' + u.week.pct + '% · agents resumed: ' + ok + '/' + byId.size);
}

async function tick(deps, opts) {
  // Injectable seams (broad Codex audit #13, 2026-08-05): the identity/fetch SEQUENCING below is the
  // fix, and sequencing can only be tested when the parts are replaceable. Production behaviour is
  // identical: every default is the real function.
  const D = Object.assign({
    fetchUsage, readIdentity: readAccountIdentity, readState, writeState, doPause, doResume, log,
    writePressureFile, readCredentialFp,
  }, deps || {});
  // GUARD-OFF-BYPASS (2026-09-24): opts.force is the ONE way a caller may tell fetchUsage() to proceed
  // even while the owner's usage-guard switch is off — used ONLY by watchStep(), and ONLY for the single
  // pre-existing, documented L2 exception (a watcher started with `start --force` keeps checking while
  // off until it has seen the switch on at least once). Every other caller of tick() (watch --once, the
  // exported API, these tests) gets the normal, unforced gate.
  const tickOpts = opts || {};
  const identBefore = D.readIdentity();
  let u;
  try { u = await D.fetchUsage({ force: tickOpts.force === true, signal: tickOpts.signal }); } catch (e) {
    await withLockedState(D, (fresh) => { fresh.lastError = String(e.message); fresh.lastCheckAt = new Date().toISOString(); }, 'CHECK FAILED write');
    D.writePressureFile(NaN, NVIDIA_SHIFT_AT, PAUSE_AT); // level "unknown" — write on EVERY evaluation, no stale flag
    D.log('CHECK FAILED (no action taken — fail-safe): ' + e.message); return;
  }
  const ident = D.readIdentity();
  if (identBefore.fp && ident.fp && identBefore.fp !== ident.fp) {
    await withLockedState(D, (fresh) => {
      fresh.lastCheckAt = new Date().toISOString();
      fresh.lastError = 'account switched mid-check (' + identBefore.fp + ' -> ' + ident.fp + ') — measurements discarded, no action taken';
    }, 'ACCOUNT SWITCHED MID-CHECK write');
    D.log('ACCOUNT SWITCHED MID-CHECK (' + identBefore.fp + ' -> ' + ident.fp + ') — this tick\'s numbers belong to the OLD account; discarded (fail-safe), next tick measures the new account');
    return;
  }
  // CODEX ronde-3 #1 (2026-08-06): ~/.claude.json kan tijdens een login LATER omklappen dan
  // .credentials.json — beide identiteits-lezingen melden dan nog account A terwijl de fetch al met
  // account B's token liep. De fetch draagt daarom de vingerafdruk van het credential dat hij ECHT
  // gebruikte; is het credential NU al anders (geroteerd/gewisseld tijdens de fetch), dan zijn deze
  // cijfers niet meer aan een consistente identiteit te binden — verwerpen, volgende tick meet opnieuw.
  const credNow = D.readCredentialFp();
  if (u.credentialFp && credNow && u.credentialFp !== credNow) {
    // GUARD-TOKEN-FINGERPRINT (2026-09-24): u.credentialFp/credNow are sha256 fingerprints of the
    // REFRESH TOKEN (an actual bearer secret) — kept ENTIRELY in memory for this one comparison, never
    // persisted. Neither value appears in the write below, only the fact that a mismatch fired.
    await withLockedState(D, (fresh) => {
      fresh.lastCheckAt = new Date().toISOString();
      fresh.lastError = 'credential rotated mid-check — measurements discarded, no action taken';
    }, 'CREDENTIAL ROTATED MID-CHECK write');
    D.log('CREDENTIAL ROTATED MID-CHECK — this tick\'s numbers were fetched with a credential that no longer matches; discarded (fail-safe)');
    return;
  }
  // advisory NVIDIA-shift pressure signal — written on every watch evaluation, before any pause/resume
  // branching below, so it fires regardless of which branch this tick takes (pause always wins for the
  // real pause/resume decision; this file never influences it).
  D.writePressureFile(u.week.pct, NVIDIA_SHIFT_AT, PAUSE_AT);
  if (!(u.windows || []).length) { D.log('CHECK: endpoint reported no usable usage window (no action)'); return; }
  // ACCOUNT GATE (2026-08-03): resolve identity BEFORE any decision is made on the stored state. `rawState`/
  // `sw`/`st` below still drive the REST of this tick's control flow (which trigger fired, is ownerOverride
  // active, etc.) from this pre-lock snapshot — a benign, self-correcting read for DECISION purposes (a rare
  // double-detected switch self-corrects on the very next tick); only the ACTUAL PERSISTENCE of each
  // decision below (V15) is re-read fresh and serialized against every other writer via withLockedState().
  const rawState = D.readState();
  const sw = detectAccountSwitch(rawState, ident);
  const st = stateForAccount(rawState, ident);
  if (sw.switched) {
    await withLockedState(D, (fresh) => stateForAccount(fresh, ident), 'ACCOUNT SWITCH write');
    D.log('ACCOUNT SWITCH — fingerprint ' + sw.from + ' -> ' + sw.to + ' (' + ident.source + '): guard state reset; previous account\'s percentages, pause state and credits override NOT carried over');
    // COMPENSATIE (uitgesteld punt 1, 2026-08-06): de reset hierboven wist de pausedAgents-lijst van het
    // VORIGE account — maar het journal kent ze nog. Hervat ze nu (Paperclip is account-agnostisch;
    // dit zijn uitsluitend agents die de guard ZELF pauzeerde) en sluit hun journalregels af.
    const orphans = unresolvedPausedAgents();
    if (orphans.length) {
      let rok = 0;
      for (const j of orphans) {
        const r = await pc('POST', '/api/agents/' + j.agentId + '/resume', {}, { signal: tickOpts.signal });
        // r5 #21: de resolve draagt de pauseId van het record dat hij afsluit — zonder die binding bleef
        // de pauze onopgelost en resumede iedere volgende tick opnieuw.
        if (r.status >= 200 && r.status < 300) { rok++; journalAppend({ agentId: j.agentId, action: 'resumed', pauseId: j.pauseId || null, resolved: true }); }
      }
      D.log('ACCOUNT SWITCH — ' + rok + '/' + orphans.length + ' guard-gepauzeerde agents van het vorige account hervat via het compensatiejournal');
    }
  }
  // OWNER OVERRIDE (usage credits): while purchased credits remain, do NOT pause on the plan limit.
  // Auto re-arm the normal guard the moment credits are exhausted (or the override's mandatory expiry
  // passes — see N12 below). V15 (FOURTH Codex recheck, 2026-09-24) — DEFENSE IN DEPTH: `st.ownerOverride`
  // (state.json's own cache) is no longer trusted for this decision on its own. A stale writer resurrecting
  // `active:true` in the cache (the honest residual usage-guard-state.cjs's own header names — an adjacent
  // fence-check-then-publish pair is still, in principle, two separate syscalls) can no longer suppress
  // pausing by itself: the decision is recomputed FRESH from the authoritative, expiry-aware grant record
  // every tick (see usage-guard-override.cjs's own header). Absent/expired/invalid grant -> override OFF,
  // regardless of what the cache says; a valid, unexpired, ACCOUNT-BOUND grant keeps it ON even if a stale
  // writer cleared the cache.
  //
  // N10 (2026-09-24, Security Boss addendum reconfirmed) — the grant is checked against THIS tick's already-
  // validated `ident` (never a raw fingerprint — `ident.fp` is the opaque local label
  // usage-guard-redact.cjs's resolveLocalAccountLabel already derived above), so a grant belonging to a
  // DIFFERENT account, a label-less legacy grant, or an unverifiable/unknown current identity can never
  // suppress pausing for this account.
  const overrideNow = guardOverride.resolveOwnerOverride({ projectRoot: TRUSTED_OWNERGRANT_ROOT, accountLabel: ident.fp });
  if (overrideNow.active) {
    const c = u.credits;
    if (!creditsExhausted(c)) {
      await withLockedState(D, (fresh) => {
        fresh.mode = 'ok'; fresh.percents = { session: u.session.pct, week: u.week.pct }; fresh.credits = c;
        fresh.lastCheckAt = new Date().toISOString(); delete fresh.lastError;
        // the cache is REBUILT from the fresh grant record every tick, never carried forward as-is.
        fresh.ownerOverride = guardOverride.cachedOverrideFrom(overrideNow.record);
      }, 'OVERRIDE active write');
      const low = Number.isFinite(c.remaining) && Number.isFinite(c.limit) && c.limit > 0 && (c.remaining / c.limit) <= 0.1;
      D.log('OVERRIDE active (credits mode) — NOT pausing · session ' + u.session.pct + '% week ' + u.week.pct + '% · credits used ' + fmtMoney(c.used, c.currency, c.decimals) + '/' + fmtMoney(c.limit, c.currency, c.decimals) + (low ? ' · ⚠ CREDITS LOW' : ''));
      return;
    }
    // N12 (2026-09-24, Security Boss addendum reconfirmed) — MEASURED DEFECT (`V15-credits-exhaustion-
    // deletes-newer-grant`): the watcher used to clear the AUTHORITATIVE grant itself here — a stale tick
    // (started before a newer, still-valid grant was published) could delete that NEWER grant, and the
    // claimed "single writer" (only override-on/override-off ever write the grant) was false in practice.
    // THE FIX: the watcher NEVER writes or deletes the grant file — full stop. On exhaustion it simply does
    // not HONOUR the grant for this (and every subsequent, while credits stay exhausted) tick and falls
    // through to the normal pause/resume logic below; the file itself is left exactly as the owner's CLI
    // last set it. This makes the single-writer claim actually true, at the cost of the grant file
    // continuing to say "active" until the owner explicitly runs override-off — an intentional trade-off:
    // the CACHE (state.json's `ownerOverride`, bookkeeping only) is still cleared below so `status` reflects
    // reality (not currently suppressing), even though the underlying file is untouched.
    D.log('OVERRIDE NOT honoured — credits exhausted (used ' + fmtMoney(c && c.used, c && c.currency, c && c.decimals) + '/' + fmtMoney(c && c.limit, c && c.currency, c && c.decimals) + ') → normal guard re-armed for this tick; the stored grant record is left unchanged for the owner to update (single-writer: only override-on/override-off ever write it)');
    await withLockedState(D, (fresh) => { delete fresh.ownerOverride; }, 'OVERRIDE not-honoured cache write');
    delete st.ownerOverride; // keep this run's in-memory decision consistent with the write just attempted
    // fall through to the normal pause/resume logic below (pauses if still over the plan limit)
  } else if (overrideNow.rejected) {
    // N10: a real, otherwise-active grant exists but failed account verification — never suppress this
    // tick, and log WHY using only non-secret, opaque account labels (never a fingerprint/uuid/token).
    D.log('OVERRIDE grant present but NOT honoured (' + overrideNow.rejected + ') — grant account '
      + (overrideNow.record.accountLabel || '(none)') + ' vs current account ' + (ident.fp || '(unknown)')
      + ' — falling through to the normal guard for this account');
    if (st.ownerOverride) {
      await withLockedState(D, (fresh) => { delete fresh.ownerOverride; }, 'OVERRIDE cache reconciled write (account mismatch)');
      delete st.ownerOverride;
    }
  } else if (st.ownerOverride) {
    // the cache still shows an override, but the authoritative grant is absent/expired/invalid — this tick
    // is NOT suppressed (the grant decides, never the cache); reconcile the cache to match reality so
    // `status` does not keep showing a phantom override.
    D.log('OVERRIDE cache mismatch — state.json showed an override but the authoritative grant is absent/expired/invalid; NOT suppressing this tick (V15: the grant decides, never a cached flag)');
    await withLockedState(D, (fresh) => { delete fresh.ownerOverride; }, 'OVERRIDE cache reconciled write');
    delete st.ownerOverride;
  }
  if (st.mode !== 'paused') {
    // GUARD-CORRUPT (2026-09-24): a corrupt state is ONLY ever allowed to move forward via a fresh,
    // successful, validated measurement (the `u` this tick just fetched for real) — never silently, and
    // never by inventing 'ok' out of nothing. Logged here (decision-time); the corrupt-diagnostic fields
    // are cleared inside the "normal ok write" transform below.
    if (rawState.mode === 'corrupt') {
      D.log('STATE WAS CORRUPT (' + rawState.corruptReason + ', since ' + rawState.corruptAt + ') — recovered via a fresh VALIDATED measurement (session ' + u.session.pct + '% · week ' + u.week.pct + '%), never a fabricated "ok"');
    }
    // EVERY reported window can trip the guard, not just the legacy session/week pair — a daily or
    // per-model scoped limit at 100% used to be completely invisible here (fix 2026-08-03).
    // The trigger now records the window's STABLE id so resume can find THIS window again (audit #15).
    const crossed = crossedWindows(u.windows, PAUSE_AT)
      .map((w) => ({ id: w.id, name: w.label, metric: w.kind, pct: w.pct, resetsAt: w.resetsAt }));
    if (crossed.length) { await D.doPause(u, crossed, ident, { signal: tickOpts.signal }); return; }
    // keep pauseAt/resumeAt fresh on every tick (fix 2026-07-08) — otherwise a running watchdog started
    // with a different --pause-at than the last actual pause event leaves a stale threshold in the
    // state file, even though the real in-process trigger (PAUSE_AT, checked above) is already correct.
    await withLockedState(D, (fresh) => {
      // N01 (second Codex recheck, 2026-09-24): reconcile the account stamp INSIDE the locked transaction,
      // against the FRESHEST read, before any other field is touched. Previously this write never called
      // stateForAccount() at all — a state file that had genuinely never yet been stamped (e.g. this is the
      // very first successful tick) stayed UNSTAMPED forever, so the NEXT tick under a DIFFERENT account
      // read `from: null` from detectAccountSwitch() and treated a REAL account switch as "first-stamp
      // (adoption)" instead of a switch — which meant a foreign account's ownerOverride (and pausedAgents,
      // credits, trigger) was never cleared, and a 100%-usage tick for the new account made zero pauses.
      // stateForAccount() returns the SAME object (mutated fresh) when nothing changed, or a genuinely NEW
      // reset object on a real switch — either way it is the correct base for the ok-mode fields below.
      const reconciled = stateForAccount(fresh, ident);
      reconciled.mode = 'ok'; reconciled.pauseAt = PAUSE_AT; reconciled.resumeAt = RESUME_AT; reconciled.nvidiaShiftAt = NVIDIA_SHIFT_AT;
      reconciled.percents = { session: u.session.pct, week: u.week.pct }; reconciled.lastCheckAt = new Date().toISOString();
      delete reconciled.lastError; delete reconciled.corruptAt; delete reconciled.corruptReason;
      return reconciled;
    }, 'normal ok write');
    // RECONCILIATIE (r4 #15): staat de guard op ok maar kent het journal nog onopgeloste guard-pauzes
    // (crash na de pause-API, of een switch waarvan de orphan-resume deels faalde), hervat ze dan nu —
    // de write-ahead-intent garandeert dat zo'n agent hier altijd zichtbaar is.
    const orphansOk = unresolvedPausedAgents();
    if (orphansOk.length) {
      let rok = 0;
      for (const j of orphansOk) {
        const r = await pc('POST', '/api/agents/' + j.agentId + '/resume', {}, { signal: tickOpts.signal });
        if (r.status >= 200 && r.status < 300) { rok++; journalAppend({ agentId: j.agentId, action: 'resumed', pauseId: j.pauseId || null, resolved: true }); }
      }
      D.log('RECONCILIATIE — ' + rok + '/' + orphansOk.length + ' onopgeloste guard-pauzes uit het journal hervat (mode was ok)');
    }
    // log EVERY window, not just the legacy pair — otherwise a daily/scoped limit climbing toward 100%
    // is invisible in the log as well as in the decision (fix 2026-08-03).
    D.log('ok — ' + (u.windows || []).map((w) => w.label + ' ' + w.pct + '%').join(' · ') + ' (pause-at ' + PAUSE_AT + '%)');
  } else {
    // AUDIT #15 (2026-08-05): the old lookup was `find(x.kind === t.metric)` — the FIRST window with the
    // same bare kind decided the resume, so with two weekly_scoped windows the guard could resume off the
    // wrong model's percentage (flapping) or stay paused on a window that never crossed. The decision now
    // lives in stillHighTrigger(): stable id first, kind only when unambiguous, legacy pair as last resort.
    const stillHigh = stillHighTrigger(st.trigger, u.windows, RESUME_AT, { sessionPct: u.session.pct, weekPct: u.week.pct });
    // RESET-RHYTHM: resume on EITHER the real utilization drop OR wall-clock reaching resumeAtEpoch —
    // whichever comes first. NaN-safe: an absent/unparseable resumeAtEpoch never triggers this branch.
    const resumeAtEpoch = Number(st.resumeAtEpoch);
    const rhythmDue = Number.isFinite(resumeAtEpoch) && Date.now() >= resumeAtEpoch;
    // CODEX ronde-3 #2 (2026-08-06): "de trigger is weg/gereset" mocht een resume opleveren terwijl een
    // ÁNDER huidig venster al boven PAUSE_AT stond — een resume gevolgd door een re-pauze een tick later
    // (tot 120s wapperen, met resume/pauze-notices en agent-bounce). Staat er NU een venster boven de
    // pauzedrempel, dan wordt de pauze op DAT venster voortgezet (verse trigger + vers ritme) in plaats
    // van hervat; agents die al gepauzeerd zijn raakt doPause niet opnieuw aan.
    if (!stillHigh || rhythmDue) {
      const nowCrossed = crossedWindows(u.windows, PAUSE_AT)
        .map((w) => ({ id: w.id, name: w.label, metric: w.kind, pct: w.pct, resetsAt: w.resetsAt }));
      if (nowCrossed.length) {
        D.log('trigger cleared/rhythm due, but ' + nowCrossed.map((c) => c.name + ' ' + c.pct + '%').join(' + ') + ' is at/over pause-at ' + PAUSE_AT + '% — staying paused on the CURRENT window instead of resume-then-repause flapping');
        await D.doPause(u, nowCrossed, ident, { signal: tickOpts.signal });
        return;
      }
      // N08 (Codex recheck out-p10, 2026-09-24): usage has genuinely recovered (or rhythm is due) — RESUME
      // now wins over any still-outstanding pause retry from an earlier, interrupted round. This check used
      // to sit ABOVE stillHigh/rhythm and return unconditionally, so pending pause work for an account whose
      // usage had ALREADY reset kept re-issuing pause requests forever (Codex's exact schedule: one
      // repeatedly timing-out pending agent + one already-paused agent, usage now 0% — the old order
      // produced two pause requests and zero resumes across two ticks). Reset/resume state now GOVERNS
      // outstanding pause work, rather than being preempted by it — see the pausePending check moved below.
      await D.doResume(u, st, ident, { signal: tickOpts.signal }); return;
    }
    // V29 (second Codex recheck, 2026-09-24): a PREVIOUS pause round that was interrupted mid-flight
    // (shutdown) leaves specific agents still genuinely unpaused even though mode already says 'paused'.
    // N08 (2026-09-24, FOURTH recheck): this check now runs AFTER the resume/re-pause evaluation above, not
    // before it — reaching here means usage is STILL genuinely above the resume threshold (stillHigh, not
    // rhythmDue), so completing an interrupted pause round is still warranted; retry it now, or a
    // persistently-high trigger would take the "still high, wait, do nothing" branch below forever while
    // those agents keep consuming quota. doPause() re-derives `toPause` from LIVE Paperclip status, so
    // re-calling it here naturally skips whatever a prior round already paused and only (re-)attempts what
    // is still not paused.
    if (Array.isArray(st.pausePending) && st.pausePending.length) {
      D.log('PAUSE RETRY — een eerdere pauzeronde werd onderbroken (' + st.pausePending.length + ' agent(s) nog niet gepauzeerd); dit telt nog niet als compleet, opnieuw proberen / a previous pause round was interrupted (' + st.pausePending.length + ' agent(s) not yet paused); not yet complete, retrying');
      await D.doPause(u, st.trigger || [], ident, { signal: tickOpts.signal });
      return;
    }
    await withLockedState(D, (fresh) => { fresh.percents = { session: u.session.pct, week: u.week.pct }; fresh.lastCheckAt = new Date().toISOString(); }, 'paused waiting write');
    D.log('paused — waiting for reset (session ' + u.session.pct + '% · week ' + u.week.pct + '% · resume at <= ' + RESUME_AT + '%' + (Number.isFinite(resumeAtEpoch) ? ' · or rhythm-resume at ' + new Date(resumeAtEpoch).toISOString() : '') + ')');
  }
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
/** readPidRecord — the pid file is now {pid,startedAt,script}; a bare number is the legacy form and is
 *  still read (never break an already-running watcher), just without the extra identity evidence. */
function readPidRecord() {
  let raw = '';
  try { raw = fs.readFileSync(PID_FILE, 'utf8').trim(); } catch { return { pid: 0, legacy: false }; }
  if (!raw) return { pid: 0, legacy: false };
  try { const j = JSON.parse(raw); if (j && Number(j.pid)) return { pid: Number(j.pid), startedAt: j.startedAt || null, script: j.script || null, legacy: false }; } catch { /* legacy bare number */ }
  return { pid: Number(raw) || 0, startedAt: null, script: null, legacy: true };
}
/** ownsPid — HARD RULE (owner directive after the 2026-07-29 incident where a cleanup killed an unrelated
 *  service): only ever kill a process we can PROVE is ours. Windows recycles PIDs, and the stale pid file
 *  found on 2026-08-03 pointed at a number no longer belonging to any watcher — a `taskkill /T /F` on that
 *  number could have taken down an unrelated process tree. We verify the live command line still refers to
 *  this script before killing anything; when we cannot verify, we refuse and say so. */
/** readPosixCmdline(pid) — the live process's REAL command line without extra dependencies (broad Codex
 *  audit #18, 2026-08-05). Linux: /proc/<pid>/cmdline (NUL-separated). macOS/BSD: `ps -ww -p <pid>
 *  -o command=` via spawnSync, no shell, -ww against truncation (a truncated line would misclassify a
 *  real watcher as recycled). Returns null when neither source can be read — the caller must then
 *  refuse, never guess. */
function readPosixCmdline(pid) {
  try {
    const raw = fs.readFileSync('/proc/' + Number(pid) + '/cmdline', 'utf8');
    if (raw) return raw.split('\0').filter(Boolean).join(' ');
  } catch { /* no /proc (macOS) or unreadable — try ps */ }
  try {
    const r = spawnSync('ps', ['-ww', '-p', String(Number(pid)), '-o', 'command='], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  } catch { /* ps unavailable */ }
  return null;
}
/** verdictFromCmdline — shared classification for both platforms: the live command line must name THIS
 *  guard script AND the `watch` subcommand. Every failure carries a machine-readable `code` so callers
 *  (incumbentStatus) never have to parse English prose to tell "recycled, safe to take over" from
 *  "unidentifiable, refuse" (audit #18 — the old prose-matching left POSIX without a recycled class at
 *  all: a stale record either false-positived as a live watcher or blocked every restart forever). */
function verdictFromCmdline(pid, rec, out) {
  // CODEX ronde-3 #3 (2026-08-06): een basename-substring + het woord "watch" ergens in de regel was te
  // los — een ANDERE usage-guard.cjs (ander project) of een `--watch=false`-vlag matchte ook. Nu: het
  // VOLLEDIGE opgeloste scriptpad wanneer het record er een draagt (basename alleen nog als legacy-
  // fallback voor een record zonder pad), en `watch` moet een losstaand argument-token zijn — niet een
  // substring van een vlag of een naam.
  const lower = String(out).toLowerCase();
  let scriptOk;
  if (rec && rec.script) scriptOk = lower.includes(path.resolve(rec.script).toLowerCase());
  else scriptOk = lower.includes(path.basename(__filename).toLowerCase());
  if (!scriptOk) return { ok: false, code: 'recycled', reason: 'pid ' + pid + ' does not run this guard script (recycled pid) — refusing to kill it' };
  if (!/(^|[\s"'])watch($|[\s"'])/.test(lower)) return { ok: false, code: 'not-watcher', reason: 'pid ' + pid + ' runs the guard script but NOT as a watcher (e.g. a status/CLI call) — refusing to kill it' };
  return { ok: true, cmdline: out };
}
function ownsPid(pid, rec) {
  if (!pid || !pidAlive(pid)) return { ok: false, code: 'dead', reason: 'process not running' };
  if (process.platform !== 'win32') {
    // AUDIT #18 (2026-08-05): this branch used to accept a pid purely because the RECORD named our own
    // script path — nothing about the LIVE process was checked, while claimWatcherSlot writes that very
    // path into every record it creates, so every stale record matched by construction. A watcher killed
    // hard (SIGKILL/OOM/reboot) leaves its record; the OS recycles the pid; `stop` would then SIGTERM an
    // unrelated process — the exact 2026-07-29 incident class — and `start` would report "already
    // running" over an unguarded account. The live command line is now read (readPosixCmdline) and judged
    // by the same rule as Windows; unreadable = refuse honestly, never accept on record evidence alone.
    const out = readPosixCmdline(pid);
    if (out == null) return { ok: false, code: 'unverifiable', reason: 'cannot verify pid ' + pid + ' on ' + process.platform + ' (no /proc and no usable ps) — a pid-file record alone is not proof; refusing to kill it' };
    return verdictFromCmdline(pid, rec, out);
  }
  try {
    const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \'ProcessId=' + Number(pid) + '\').CommandLine"', { encoding: 'utf8', windowsHide: true }).trim();
    if (!out) return { ok: false, code: 'unverifiable', reason: 'no command line readable for pid ' + pid };
    // CODEX finding #16: matching the bare word "usage-guard" also matched a `usage-guard.cjs status`
    // process or a helper with that substring in its name. Require the EXACT recorded script path (when
    // the pid file has one) AND the `watch` subcommand — a status/CLI invocation is never the watcher.
    return verdictFromCmdline(pid, rec, out);
  } catch (e) { return { ok: false, code: 'unverifiable', reason: 'could not verify pid ' + pid + ' (' + e.message + ') — refusing to kill it' }; }
}

/** ================= WATCHER SINGLETON — ATOMIC CLAIM (broad Codex audit #17, 2026-08-05) ================
 *  The "refuse a second watcher" guard was check-then-write: `watch` READ the pid file, decided the slot was
 *  free, and only ~10 lines later wrote its own pid — unconditionally. Two watchers started in the same
 *  moment (a supervisor restart racing a manual `start`, or two `/forge` sessions) both read the same empty
 *  or stale file, both passed the check, and both wrote — the second clobbering the first's record. The
 *  result is exactly what the guard exists to prevent: two watchers ticking the same account, racing the
 *  same state file, and a `stop` that can only ever find ONE of them (the other keeps pausing/resuming
 *  invisibly). A window of a few milliseconds is enough, and a supervisor restart hits it repeatedly.
 *
 *  The claim is now atomic: `open(..., 'wx')` either creates the pid file or fails with EEXIST — the OS
 *  decides the winner, not a read followed by a hopeful write. On EEXIST we classify the incumbent honestly
 *  instead of assuming:
 *    - live-watcher   — provably ours and running: REFUSE (this is the case the guard was written for).
 *    - stale          — provably dead, or a recycled pid running something else entirely: take the slot
 *                       over, but only ONE starter may do so, serialized by an exclusive takeover lock.
 *    - unverifiable   — alive, and we CANNOT prove what it is (e.g. no command-line access on this
 *                       platform): REFUSE and say exactly that. A duplicate watcher racing the state file
 *                       is worse than a guard that declines to start and tells you why.
 *  An abandoned takeover lock (a process killed mid-takeover) is not allowed to block the guard forever:
 *  after STALE_LOCK_MS it is reclaimed, which is safe because the lock only ever guards a few filesystem
 *  operations. Every parameter is injectable so this is testable without touching the real pid file. */
const STALE_LOCK_MS = 60 * 1000;
function incumbentStatus(rec, deps) {
  const alive = deps.isAlive;
  // RACE IN DE CLAIM ZELF, door de eigen racetest gevangen (2026-08-06): tussen open(wx) en de
  // record-write van de winnaar zag een concurrent een BESTAAND maar nog LEEG pid-bestand, las pid 0,
  // behandelde dat als 'stale', wiste de kersverse claim en won alsnog — twee watchers. Een bestaand
  // bestand zonder pid is daarom 'nascent': iemand is NU aan het claimen; even wachten, nooit stelen.
  if (rec && rec.exists && !rec.pid) return { kind: 'nascent' };
  if (!rec || !rec.pid) return { kind: 'none' };
  if (rec.pid === deps.pid) return { kind: 'self' };
  if (!alive(rec.pid)) return { kind: 'stale', why: 'pid ' + rec.pid + ' is not running' };
  const own = deps.verify(rec.pid, rec);
  if (own.ok) return { kind: 'live-watcher', why: 'pid ' + rec.pid + ' is a running usage-guard watcher' };
  // Machine-readable code first (audit #18) — prose matching stays only as a fallback for older or
  // injected verifiers, so a reworded reason can never silently turn "recycled" into a forever-block.
  if (own.code === 'recycled' || own.code === 'not-watcher' || /recycled pid|NOT as a watcher/.test(own.reason || '')) return { kind: 'stale', why: own.reason };
  return { kind: 'unverifiable', why: own.reason || 'pid ' + rec.pid + ' could not be identified' };
}
function takeOverStaleSlot(pidFile, deps) {
  const lock = pidFile + '.takeover.lock';
  let lfd = null;
  try { lfd = fs.openSync(lock, 'wx'); }
  catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, reason: 'could not create the takeover lock (' + e.message + ')' };
    let age = Infinity;
    try { age = deps.now() - fs.statSync(lock).mtimeMs; } catch { /* vanished under us: treat as abandoned */ }
    if (age < STALE_LOCK_MS) return { ok: false, reason: 'another starter is taking over the stale pid file right now — refusing to start a second watcher' };
    try { fs.unlinkSync(lock); } catch { /* someone else got there first */ }
    return { ok: true, reclaimedAbandonedLock: true };
  }
  try {
    // Re-check UNDER the lock: a real watcher may have claimed the slot between our read and our lock,
    // en een nascent record krijgt ook hier zijn gratie (de eigen racetest ving het steel-scenario).
    const st = settledStatus(pidFile, deps);
    if (st.kind === 'live-watcher' || st.kind === 'unverifiable') return { ok: false, reason: st.why };
    try { fs.unlinkSync(pidFile); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, reason: 'could not clear the stale pid file (' + e.message + ')' }; }
    return { ok: true };
  } finally {
    try { fs.closeSync(lfd); } catch { /* already closed */ }
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}
function readPidRecordFrom(pidFile) {
  let raw = '';
  try { raw = fs.readFileSync(pidFile, 'utf8').trim(); } catch { return { pid: 0, exists: false, legacy: false }; }
  if (!raw) return { pid: 0, exists: true, legacy: false }; // bestaat maar (nog) leeg: nascent-kandidaat
  try { const j = JSON.parse(raw); if (j && Number(j.pid)) return { pid: Number(j.pid), exists: true, startedAt: j.startedAt || null, script: j.script || null, nonce: j.nonce || null, legacy: false }; } catch { /* legacy bare number */ }
  return { pid: Number(raw) || 0, exists: true, startedAt: null, script: null, nonce: null, legacy: true };
}
/** sleepSyncMs — synchrone micro-slaap zonder CPU-verbranding (zelfde techniek als de racetests). */
function sleepSyncMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB onbeschikbaar: dan maar niet slapen */ } }
/** settledStatus — lees het pid-record en geef een 'nascent' record een korte gratieperiode om zijn
 *  bytes te landen; pas als het NA de gratie nog leeg is telt het als een gecrashte creator (stale). */
function settledStatus(pidFile, deps) {
  for (let i = 0; i < 10; i++) {
    const st = incumbentStatus(readPidRecordFrom(pidFile), deps);
    if (st.kind !== 'nascent') return st;
    sleepSyncMs(15);
  }
  return { kind: 'stale', why: 'pid file exists but stayed empty through the grace window — its creator crashed mid-claim' };
}
function claimWatcherSlot(opts) {
  opts = opts || {};
  const pidFile = opts.pidFile || PID_FILE;
  const deps = {
    pid: opts.pid || process.pid,
    script: opts.script || __filename,
    now: opts.now || (() => Date.now()),
    isAlive: opts.isAlive || pidAlive,
    verify: opts.verify || ownsPid,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    // De claim schrijft zijn record in EEN writeFileSync-wx-call — geen open+write-tweetrap meer, zodat
    // het venster waarin een concurrent een lege pid-file kan zien minimaal is (de nascent-gratie
    // hierboven dekt wat er overblijft).
    let claimed = false;
    try { fs.writeFileSync(pidFile, JSON.stringify({ pid: deps.pid, startedAt: new Date(deps.now()).toISOString(), script: deps.script, ...(opts.nonce ? { nonce: opts.nonce } : {}) }) + '\n', { flag: 'wx' }); claimed = true; }
    catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: 'could not claim the watcher slot (' + e.message + ')' };
      const st = settledStatus(pidFile, deps); // nascent-gratie: een winnaar-in-wording nooit als stale bestelen
      if (st.kind === 'live-watcher') return { ok: false, incumbent: st, reason: 'another usage-guard watcher already running — ' + st.why };
      if (st.kind === 'unverifiable') return { ok: false, incumbent: st, reason: 'a process is holding the watcher slot and cannot be identified — ' + st.why + '; refusing to start a second watcher' };
      // 'self' means an earlier record of THIS pid (a restart inside the same process id): treat as stale.
      const took = takeOverStaleSlot(pidFile, deps);
      if (!took.ok) return { ok: false, incumbent: st, reason: took.reason };
      continue; // the slot is free now — retry the exclusive create, which is still the only winner-picker
    }
    if (claimed) return { ok: true, mode: attempt === 0 ? 'created' : 'took-over-stale', pidFile };
  }
  return { ok: false, reason: 'could not claim the watcher slot after 3 attempts — the pid file kept changing under us (another starter is racing); refusing to start a second watcher' };
}
/** awaitChildClaim — de start-handshake (uitgesteld punt 2, 2026-08-06): poll het pid-bestand tot het
 *  kind-pid er ECHT in staat (ok), een ANDER levend pid het slot houdt (weigering: het kind verloor de
 *  claim), het kind dood is (weigering: het kind weigerde/crashte — zie het log), of de timeout
 *  verstrijkt. Injecteerbare deps voor hermetische tests. */
function awaitChildClaim(opts) {
  opts = opts || {};
  const pidFile = opts.pidFile || PID_FILE;
  const childPid = Number(opts.childPid);
  const isAlive = opts.isAlive || pidAlive;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 10000;
  const pollMs = opts.pollMs != null ? opts.pollMs : 200;
  const nonce = opts.nonce || null;
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };
  for (;;) {
    const rec = readPidRecordFrom(pidFile);
    if (rec.pid === childPid) {
      /** r4 #16 (2026-08-07): pid-gelijkheid alleen bewees geen levend, uniek kind — een stale record van
       *  een gerecycled pid of een kind dat claimde en direct crashte gold als "started". Nu: (1) de
       *  NONCE die deze start meegaf moet in het record staan (een oud record van een eerder gestart
       *  kind met toevallig hetzelfde pid kan die nonce niet dragen); (2) liveness NA de record-match;
       *  (3) een herlezing die het record stabiel toont. */
      if (nonce && rec.nonce !== nonce) return { ok: false, reason: 'pid record draagt niet de start-nonce van DIT start-commando (record-nonce ' + String(rec.nonce).slice(0, 8) + '…) — dit is een oud/vreemd record, geen bewijs van ons kind' };
      if (!isAlive(childPid)) return { ok: false, reason: 'child pid ' + childPid + ' claimde het slot maar is direct daarna gecrasht — geen levende watcher' };
      const rec2 = readPidRecordFrom(pidFile);
      if (rec2.pid !== childPid || (nonce && rec2.nonce !== nonce)) return { ok: false, reason: 'pid record veranderde direct na de claim-verificatie — geen stabiel eigendom' };
      return { ok: true, pid: childPid };
    }
    if (rec.pid && rec.pid !== childPid && isAlive(rec.pid)) {
      return { ok: false, reason: 'watcher slot is held by pid ' + rec.pid + ' (not the child ' + childPid + ') — the child lost the claim to an existing/racing watcher' };
    }
    if (!isAlive(childPid)) {
      return { ok: false, reason: 'child pid ' + childPid + ' exited before claiming the watcher slot — it refused (already running / claim conflict) or crashed; see the log' };
    }
    if (Date.now() >= deadline) return { ok: false, reason: 'child pid ' + childPid + ' did not claim the watcher slot within ' + timeoutMs + 'ms' };
    sleep(pollMs);
  }
}
/** releaseWatcherSlot — give the slot back on a clean exit, but ONLY if the record is still ours. Deleting
 *  someone else's record would re-open the very race this closes. */
function releaseWatcherSlot(opts) {
  opts = opts || {};
  const pidFile = opts.pidFile || PID_FILE;
  const me = opts.pid || process.pid;
  const rec = readPidRecordFrom(pidFile);
  if (!rec.pid) return { ok: true, removed: false, reason: 'no pid file' };
  if (rec.pid !== me) return { ok: false, removed: false, reason: 'pid file belongs to ' + rec.pid + ', not to us (' + me + ') — leaving it alone' };
  try { fs.unlinkSync(pidFile); return { ok: true, removed: true }; }
  catch (e) { return { ok: false, removed: false, reason: e.message }; }
}

/** watchStep(ctx, deps) -> Promise<{ outcome: 'lost-slot'|'switched-off'|'ticked', seenOn: boolean }> — ONE
 *  iteration of the watch loop (L2, 2026-09-24; exported so the switch re-read is testable without a 30 s interval).
 *  ctx = { forced: started with --force, seenOn: the switch has been on at some check of this watcher }. Order: slot
 *  ownership, then the owner's switch (re-read NOW), then the real check. Switched off or unreadable -> one log line,
 *  the pid file is released and the process exits 0 — unless the watcher was forced on while the switch was off and
 *  has not seen it on since (a forced start is not undone by its own first tick). deps inject every side effect. */
async function watchStep(ctx, deps) {
  const D = Object.assign({
    stillOwnsSlot: () => true, readSwitch: readGuardSwitch, tick, log,
    release: releaseWatcherSlot, exit: (code) => process.exit(code),
  }, deps || {});
  const forced = !!(ctx && ctx.forced);
  let seenOn = !!(ctx && ctx.seenOn);
  if (!D.stillOwnsSlot()) {
    D.log('SLOT VERLOREN — pid-bestand draagt niet meer dit pid/nonce; deze watcher stopt (een ander bewaakt het account)');
    D.exit(1);
    return { outcome: 'lost-slot', seenOn };
  }
  const sw = D.readSwitch();
  if (sw.on) seenOn = true;
  else if (!forced || seenOn) {
    D.log(sw.unreadable
      ? 'instellingen onleesbaar — usage guard stopt (veilige standaard: uit; herstel of reset met /forge config reset --yes) / settings unreadable — the watcher stops (safe default: off)'
      : 'usage-guard staat nu UIT in je instellingen — de watcher stopt en ruimt zijn pid-bestand op (aanzetten: /forge config set usage-guard aan) / usage guard switched OFF in your settings — the watcher stops');
    D.release();
    D.exit(0);
    return { outcome: 'switched-off', seenOn };
  }
  // GUARD-OFF-BYPASS (2026-09-24): by the time execution reaches here, EITHER sw.on is true (the normal
  // case — no exception needed) OR this is the single documented forced-while-off exception the branch
  // above just let through. `force: !sw.on` tells tick()'s fetchUsage() call to proceed in exactly that
  // second case, and never in any other.
  // GUARD-STOP (2026-09-24): SHUTDOWN_AC.signal lets the watch loop's own SIGTERM handler abort THIS
  // tick's in-flight request the moment it fires, rather than only preventing the next scheduled tick.
  try { await D.tick(undefined, { force: !sw.on, signal: SHUTDOWN_AC.signal }); } catch (e) { D.log('TICK FAILED (watcher stays alive): ' + ((e && e.stack) || e)); }
  return { outcome: 'ticked', seenOn };
}

// CLI only when run directly — require()-ing this file used to immediately hit the live usage endpoint,
// which is why its own tests had to MIRROR the logic inline instead of testing the real functions
// (2026-08-03: the mirrored copies were what let the account/limits gaps go untested for so long).
if (require.main === module) {
  (async () => {
  if (cmd === 'check' || cmd === 'status') {
    if (cmd === 'status') {
      // printed BEFORE the fetch so the owner sees the active settings even when the usage endpoint is unreachable
      console.log('instellingen: ' + settingsLine(GUARD));
      // REG-USAGE-GUARANTEE (2026-09-24): the code cannot guarantee a task is never cut off mid-way — it
      // samples on an interval, so usage can cross the pause threshold BETWEEN two samples, and normal
      // Agent-tool work has no per-step enforcement hook of its own (only Paperclip agents are actually
      // paused). Say so plainly here rather than implying an instant, guaranteed block.
      console.log('gemeten elke ' + INTERVAL + 's (beste-poging — een taak kan tussen twee metingen door de limiet nog overschrijden; dit is geen ogenblikkelijke, gegarandeerde blokkade) / sampled every ' + INTERVAL + 's (best effort — a task can still cross the limit between samples; this is not an instant, guaranteed block)');
      for (const n of [GUARD_CFG.note, ...GUARD.warnings].filter(Boolean)) console.log('note: ' + n);
    }
    // M6: without the login file there is nothing to measure with — say so plainly instead of a raw file error.
    if (!credentialsPresent()) {
      console.log(noCredentialsLine('no measurement'));
      process.exitCode = 1;
      if (cmd === 'status') { writePressureFile(NaN, NVIDIA_SHIFT_AT, PAUSE_AT); console.log('pressure: unknown (usage data unavailable — no login file)'); }
      return;
    }
    // GUARD-OFF-BYPASS (2026-09-24): the owner's usage-guard switch off means NO token read and NO
    // network request from check/status either — the same policy fetchUsage() itself now enforces
    // (this check exists only for a clean, honest exit-3 message instead of a generic fetch-failed one).
    // --force overrides once, exactly like nvidia-provider.cjs's identical convention.
    const gateCheckStatus = guardNetworkAllowed({ force: has('force') });
    if (!gateCheckStatus.ok) {
      console.log(gateCheckStatus.reason);
      process.exitCode = 3;
      if (cmd === 'status') { writePressureFile(NaN, NVIDIA_SHIFT_AT, PAUSE_AT); console.log('pressure: unknown (usage guard is off)'); }
      return;
    }
    let u;
    try {
      u = await fetchUsage({ force: has('force') });
      // EVERY window the endpoint reports, typed — printing only session+week hid a daily/scoped limit
      // that could already be at 100% (fix 2026-08-03).
      const wl = (u.windows || []).map((w) => w.label + ' ' + w.pct + '% (reset ' + fmtReset(w.resetsAt) + ')').join(' · ');
      console.log('REAL usage (official endpoint) — ' + (wl || 'geen bruikbaar venster gerapporteerd'));
    } catch (e) {
      console.error('usage fetch failed: ' + e.message); process.exitCode = 1;
      if (cmd === 'status') { writePressureFile(NaN, NVIDIA_SHIFT_AT, PAUSE_AT); console.log('pressure: unknown (usage data unavailable — fetch failed)'); }
      return;
    }
    if (cmd === 'status') {
      const ident = readAccountIdentity();
      const rawSt = readState();
      const swNow = detectAccountSwitch(rawSt, ident);
      const st = rawSt;
      console.log('account: ' + (ident.fp ? ident.fp + ' (' + ident.source + ')' : 'ONBEKEND — geen accountidentiteit leesbaar')
        + (swNow.switched
          ? ' · ⚠ ACCOUNT SWITCH t.o.v. de opgeslagen state (' + swNow.from + ' -> ' + swNow.to + '): de cijfers/pauze/override hieronder zijn van het VORIGE account en worden bij de eerstvolgende watch-tick gereset'
          : (st.account ? '' : ' · state nog niet gestempeld (wordt bij de eerstvolgende tick geadopteerd)')));
      const ovr = st.ownerOverride && st.ownerOverride.active !== false ? ' · OVERRIDE ACTIVE (credits mode)' : '';
      const cr = st.credits ? ' · credits used ' + fmtMoney(st.credits.used, st.credits.currency, st.credits.decimals) + '/' + fmtMoney(st.credits.limit, st.credits.currency, st.credits.decimals) : '';
      console.log('guard state: ' + (st.mode || 'ok') + ' · pauseAt ' + (st.pauseAt != null ? st.pauseAt : '?') + '%' + ovr + cr + (st.lastPauseAt ? ' · lastPause ' + st.lastPauseAt : '') + (st.lastResumeAt ? ' · lastResume ' + st.lastResumeAt : ''));
      const rec = readPidRecord();
      const pid = rec.pid;
      // A live PID is not proof of a working watcher: on 2026-08-03 the process existed while its last
      // real check was 80 minutes old — it had silently stopped ticking and status still said RUNNING.
      // The heartbeat (stamped on every state write) is the freshness source; lastCheckAt is the fallback
      // for a state written by an older build.
      const wh = watcherHealth({ pidAlive: !!(pid && pidAlive(pid)), lastCheckAt: st.heartbeatAt || st.lastCheckAt, intervalSec: INTERVAL });
      const staleTxt = wh.staleSec != null ? ' · laatste check ' + Math.round(wh.staleSec / 60) + ' min geleden' : '';
      console.log('watcher: ' + (
        wh.state === 'running' ? 'RUNNING (pid ' + pid + ')' + staleTxt
        : wh.state === 'stale' ? '⚠ HANGT — proces leeft (pid ' + pid + ') maar tikt niet meer' + staleTxt + ' (interval ' + wh.intervalSec + 's); herstart met: node .claude/forge-bin/usage-guard.cjs stop && node .claude/forge-bin/usage-guard.cjs start'
        : wh.state === 'unknown' ? 'proces leeft (pid ' + pid + ') maar heeft nog nooit een check gelogd — status onbekend'
        : 'not running' + (pid ? ' (achtergebleven pid-bestand: ' + pid + ')' : '')));
      // NVIDIA-shift soft pressure signal — advisory only, real week% only, written on every status evaluation.
      const pressure = writePressureFile(u.week.pct, NVIDIA_SHIFT_AT, PAUSE_AT);
      if (pressure.level === 'nvidia-preferred') console.log('pressure: nvidia-preferred (week ' + u.week.pct + '% >= ' + NVIDIA_SHIFT_AT + '%)');
      else if (pressure.level === 'unknown') console.log('pressure: unknown (week usage data missing/unreadable)');
      else console.log('pressure: normal (week ' + u.week.pct + '% < ' + NVIDIA_SHIFT_AT + '%)');
    }
    return; // clean exit (process.exit after pending fetch handles triggers a libuv assertion on Windows)
  }
  if (cmd === 'credits') {
    // GUARD-OFF-BYPASS: same policy as check/status — --force overrides once.
    const gateCredits = guardNetworkAllowed({ force: has('force') });
    if (!gateCredits.ok) { console.log(gateCredits.reason); process.exitCode = 3; return; }
    try { const u = await fetchUsage({ force: has('force') }); const c = u.credits;
      console.log('usage credits (extra_usage): ' + (c.enabled ? 'ENABLED' : 'disabled') + ' · used ' + fmtMoney(c.used, c.currency, c.decimals) + ' / limit ' + fmtMoney(c.limit, c.currency, c.decimals) + ' · remaining ' + fmtMoney(c.remaining, c.currency, c.decimals) + (c.disabledReason ? ' · reason: ' + c.disabledReason : '') + (creditsExhausted(c) ? ' · EXHAUSTED' : ' · available'));
    } catch (e) { console.error('credits fetch failed: ' + e.message); process.exitCode = 1; }
    return;
  }
  if (cmd === 'override-on') { await runOverrideOn(); return; }
  if (cmd === 'override-off') { await runOverrideOff(); return; }
  if (cmd === 'watch') {
    if (has('once')) {
      // GUARD-OFF-BYPASS (2026-09-24): `watch --once` used to call tick() directly, BEFORE any switch
      // check — tick() itself now refuses (via fetchUsage()'s own gate) with no network call either way,
      // but this explicit check gives a clean, honest message instead of a generic "CHECK FAILED" log
      // line. No --force here: a one-shot watch tick has no documented off-switch exception.
      const gateOnce = guardNetworkAllowed({});
      if (!gateOnce.ok) { log(gateOnce.reason); return; }
      // GUARD-DISCLOSURE / V30 (Codex recheck wp-f4, 2026-09-24): `watch --once` used to call tick()
      // straight after the gate check, with NO disclosure at all — the ONE entry point that could make its
      // first request without ever telling the owner what it reads/sends first. Log it here, exactly like
      // the continuous watcher does before its own first tick (see the `log('usage-guard watch started...`
      // block below) — this is guaranteed to precede this process's own first fetch, since the gate above
      // already confirmed the switch is on (no other path to a real request from --once exists).
      for (const line of disclosureLines(GUARD_CFG.disclosure)) log(line);
      await tick(); return;
    }
    // V18 exception (3), second Codex recheck (2026-09-24): CONTINUOUS forced watching (this branch —
    // never --once, already handled above) requires the SAME verified owner-authorisation grant as
    // override-on, or is REFUSED outright. The second recheck proved the old code let `--force` keep a
    // watcher measuring on a real interval while the owner's switch was off, with NO grant check at all —
    // a sustained, repeated bypass, not the one-shot read-only diagnostic exception (1) is defined to be.
    if (has('force')) {
      const grant = verifyForcedWatchGrant(argv('owner-approval', null));
      if (!grant.ok) {
        console.error('usage-guard watch --force REFUSED — ' + grant.reason);
        console.error('  continuous forced watching requires owner authorisation: node .claude/forge-bin/usage-guard.cjs watch --force --owner-approval <token>');
        process.exit(3);
      }
    }
    // Refuse a 2nd concurrent watcher — two would race the same state file (fix 2026-07-09 checkup).
    // CODEX finding #15: this parsed the pid file as a BARE NUMBER after the writer switched to JSON —
    // Number('{"pid":123,…}') is NaN, so the guard silently stopped guarding. CODEX audit #17 (2026-08-05):
    // it was also check-then-write — read the pid file, decide, and write ~10 lines later — so two watchers
    // starting in the same moment both passed. The claim is now ATOMIC (open 'wx'); the OS picks the winner.
    // r4 #16: het start-commando geeft een nonce mee; de claim schrijft hem in het pid-record zodat de
    // handshake van de starter een OUD record met een gerecycled pid nooit als "ons kind" aanziet.
    const claim = claimWatcherSlot({ nonce: argv('start-nonce', null) || undefined });
    if (!claim.ok) { console.error(claim.reason); process.exit(1); }
    if (claim.mode === 'took-over-stale') log('took over a stale watcher slot (previous holder was gone) — this is now the only watcher');
    log('usage-guard watch started — ' + settingsLine(GUARD) + (ONLY_COMPANIES.length ? ' · companies: ' + ONLY_COMPANIES.join(',') : ''));
    // GUARD-DISCLOSURE (2026-09-24): logged HERE, before safeTick()'s first tick ever reads a credential —
    // this covers BOTH gaps the finding named: a DIRECT `watch` invocation (never printed a disclosure at
    // all before) and `start`'s own race (the PARENT used to print its disclosure only after the child's
    // claim was confirmed, by which time the CHILD could already have completed its first tick). The
    // parent (`start`, below) still prints the same lines to ITS OWN stdout for immediate interactive
    // feedback — this log call is the one that is guaranteed to precede this process's own first fetch.
    for (const line of disclosureLines(GUARD_CFG.disclosure)) log(line);
    // V18 exception (3): name the sustained-forced-watching exception explicitly in the disclosure log,
    // not just internally — the owner-facing text must reflect the SAME exception table guardNetworkAllowed()
    // documents, per the second Codex recheck's finding that this exception existed undocumented.
    if (has('force')) log('FORCED CONTINUOUS WATCHING while usage-guard is OFF is active (V18 exception 3, owner-authorised via --owner-approval) — measures on the normal interval until the switch is turned on');
    for (const n of [GUARD_CFG.note, ...GUARD.warnings].filter(Boolean)) log('note: ' + n);
    // SILENT-DEATH GUARD (2026-08-03): on this machine the loop stopped at 16:55 without a single error
    // line while the process stayed alive — only fetchUsage() was inside a try/catch, so a throw anywhere
    // else (e.g. an EPERM/EBUSY on the state write) became an unhandled rejection that killed the ticking
    // but not the process. The watcher must never die quietly again: log it, and keep ticking.
    process.on('unhandledRejection', (e) => log('WATCHER unhandled rejection (loop kept alive): ' + ((e && e.stack) || e)));
    process.on('uncaughtException', (e) => log('WATCHER uncaught exception (loop kept alive): ' + ((e && e.stack) || e)));
    // The pid file (written by claimWatcherSlot above, as part of the atomic claim itself) records WHO we
    // are and WHEN we started, so `stop` can verify it is killing this watcher and not whatever process
    // later inherited a recycled PID (Windows reuses PIDs). Hand the slot back on a clean exit so a
    // restart never has to wait for the stale-takeover path — but only ever if the record is still ours.
    process.on('exit', () => { try { releaseWatcherSlot(); } catch { /* best effort on the way out */ } });
    // SERIALIZED TICKS (Codex adversarial review #8, 2026-08-03): `setInterval` fires on the clock, not
    // on completion, so a slow usage fetch or a slow Paperclip pause round could leave two ticks running
    // at once — both reading the same pre-write state and then racing each other's writes, which is how a
    // pause decision gets made on stale numbers and then overwritten. A self-scheduling loop can only
    // ever have one tick in flight; the next one is scheduled after the previous finishes.
    let stopping = false;
    // GUARD-STOP (2026-09-24): both timer handles are now retained (not just fired-and-forgotten) so a
    // shutdown can actually clear them — the scheduling `setTimeout` for the NEXT tick, and the keep-
    // alive `setInterval` that otherwise holds the event loop open forever. Neither was ever cleared
    // before: SIGTERM only flipped `stopping`, so an already-scheduled tick could still run one more
    // authenticated request, and the keep-alive interval kept the process alive indefinitely regardless.
    let scheduledTimer = null;
    let keepAliveInterval = null;
    let inFlightTick = Promise.resolve();
    // r5 #22: iedere tick her-fenced zijn slot-eigendom — draagt het pid-bestand niet meer ONS pid (en,
    // indien meegegeven, ONZE start-nonce), dan heeft een ander het slot en stopt deze watcher direct.
    const myNonce = argv('start-nonce', null);
    const stillOwnsSlot = () => {
      const rec = readPidRecordFrom(PID_FILE);
      if (rec.pid !== process.pid) return false;
      if (myNonce && rec.nonce && rec.nonce !== myNonce) return false;
      return true;
    };
    // L2 (2026-09-24): every iteration re-reads the owner's `usage-guard` switch before it measures (watchStep).
    const forced = has('force');
    let seenOn = false;
    const safeTick = async () => {
      // GUARD-STOP: check shutdown BEFORE starting new work — a SIGTERM that arrived while this
      // invocation was merely SCHEDULED (not yet running) must never start a whole new tick.
      if (stopping) return;
      const stepPromise = watchStep({ forced, seenOn }, { stillOwnsSlot });
      inFlightTick = stepPromise.catch(() => {}); // never let a rejection here surface as unhandled
      const step = await stepPromise;
      seenOn = step.seenOn;
      if (step.outcome !== 'ticked') return;
      if (!stopping) {
        scheduledTimer = setTimeout(safeTick, INTERVAL * 1000);
        if (scheduledTimer.unref) scheduledTimer.unref();
      }
    };
    // GUARD-STOP: a single, idempotent shutdown path — clear every timer, abort any in-flight request
    // (SHUTDOWN_AC, consulted by fetchUsage() via watchStep()'s own tick() call), wait for that aborted
    // tick's own error handling to actually finish writing its state (never kill the process mid-write),
    // THEN release the watcher slot and exit cleanly. A second SIGTERM while this is already running is
    // a no-op — shutdown never restarts or double-runs.
    let shuttingDown = false;
    async function shutdownCleanly(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      stopping = true;
      log('usage-guard watcher received ' + signal + ' — stopping (clearing timers, aborting any in-flight request, releasing the slot)');
      if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; }
      try { SHUTDOWN_AC.abort(); } catch { /* already aborted */ }
      try { await inFlightTick; } catch { /* best effort — the tick's own catch already logged/wrote state */ }
      if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
      try { releaseWatcherSlot(); } catch { /* best effort on the way out */ }
      process.exit(0);
    }
    process.on('SIGTERM', () => {
      shutdownCleanly('SIGTERM').catch((e) => { log('SIGTERM cleanup failed — exiting nonzero: ' + ((e && e.message) || e)); process.exit(1); });
    });
    await safeTick();
    // Keep the event loop alive even though the scheduling timer is unref'd, so the process never exits
    // between ticks (an unref'd timer alone would let node consider the loop empty and quit). Skipped
    // entirely if shutdown already happened during that very first tick.
    if (!stopping) keepAliveInterval = setInterval(() => {}, 1 << 30);
    return; // keep alive
  }
  if (cmd === 'start') {
    // OWNER SWITCH (v2.7.0): `/forge config set usage-guard uit` turns the guard off. `start` then refuses in one
    // plain line (exit 3 = act on this) BEFORE opening a log or spawning anything; --force overrides it once.
    if (!GUARD.enabled.value && !GUARD.force) {
      console.log('usage-guard staat UIT in je instellingen (aanzetten: /forge config set usage-guard aan) / usage guard is OFF in your settings');
      process.exit(3);
    }
    // M3: unreadable settings (malformed file / missing forge-config.cjs) are never read as "on".
    if (GUARD_CFG.unreadable && !GUARD.force) {
      console.log('instellingen onleesbaar — usage guard start niet; herstel of reset met /forge config reset --yes / settings unreadable — usage guard not started; repair or reset with /forge config reset --yes');
      process.exit(3);
    }
    // M6: no login file = nothing to measure with (macOS: Keychain). Honest refusal, nothing spawned; --force cannot
    // change that — a watcher without a login file could only ever log failed checks.
    if (!credentialsPresent()) {
      console.log(noCredentialsLine('not started'));
      process.exit(3);
    }
    // V18 exception (3), second Codex recheck (2026-09-24): `start --force` spawns a watcher that keeps
    // measuring on a real interval while the owner's switch is off — the SAME sustained, consequential
    // bypass class as override-on, and now requires the SAME verified owner-authorisation grant, refused
    // outright (before opening a log or spawning anything) without one.
    if (GUARD.force) {
      const startGrant = verifyForcedWatchGrant(argv('owner-approval', null));
      if (!startGrant.ok) {
        console.log('usage-guard start --force REFUSED — ' + startGrant.reason);
        console.log('  continuous forced watching requires owner authorisation: node .claude/forge-bin/usage-guard.cjs start --force --owner-approval <token>');
        process.exit(3);
      }
    }
    for (const n of [GUARD_CFG.note, ...GUARD.warnings].filter(Boolean)) console.log('note: ' + n);
    // A recycled PID must not make `start` believe a watcher exists — that would leave the account
    // permanently unguarded while the CLI cheerfully reports "already running" (audit, 2026-08-03).
    const rec = readPidRecord();
    if (rec.pid && ownsPid(rec.pid, rec).ok) { console.log('usage-guard already running (pid ' + rec.pid + ')'); process.exit(0); }
    if (rec.pid) console.log('note: stale pid file (' + rec.pid + ' is not a usage-guard process) — starting a fresh watcher');
    const out = fs.openSync(LOG_FILE, 'a');
    const extra = [];
    if (ONLY_COMPANIES.length) extra.push('--companies', ONLY_COMPANIES.join(','));
    if (argv('state', null)) extra.push('--state', argv('state'));
    // --grace-min was parsed but never forwarded, so `start --grace-min 30` silently ran on 5 (audit).
    extra.push('--grace-min', String(GRACE_MIN));
    if (DRY) extra.push('--dry-run');
    // L2: the child re-reads the switch before every check; a forced start must not be undone by its first tick.
    // V18: the SAME owner-approval token this parent just verified above is forwarded so the child's OWN
    // `watch --force` grant check (independent, defense-in-depth) also succeeds — the parent never assumes
    // its own verification carries over to a separate process without re-proving it there too.
    if (GUARD.force) { extra.push('--force'); const fwdToken = argv('owner-approval', null); if (fwdToken) extra.push('--owner-approval', fwdToken); }
    // stdout → ignore (log() already appendFileSync's to LOG_FILE; redirecting stdout too double-logged every line);
    // keep stderr → LOG_FILE so a crash is still captured (fix 2026-07-09 checkup).
    const startNonce = crypto.randomUUID();
    // v2.7.0: forward ONLY the values that came from a flag. The child resolves the rest from the same /forge config
    // itself (same env), so its log names the true source of every value instead of reporting all of them as a flag.
    const fwd = [];
    for (const k of Object.keys(GUARD_DEFAULTS)) if (GUARD[k].source === SOURCE_WORD.flag) fwd.push('--' + k, String(GUARD[k].value));
    const child = spawn(process.execPath, [__filename, 'watch', ...fwd, '--start-nonce', startNonce, ...extra], { detached: true, stdio: ['ignore', 'ignore', out], windowsHide: true });
    child.unref();
    // START-HANDSHAKE (uitgesteld punt 2, gesloten 2026-08-06): dit pad printte "started (pid X)" en
    // exitte 0 TERWIJL het kind zijn claim later nog kon weigeren (claimWatcherSlot exit 1, alleen
    // zichtbaar in het logbestand) — een supervisor-race of tweede starter kreeg dus "gestart" te horen
    // over een account dat onbewaakt bleef. Nu wachten we tot het pid-bestand ECHT het kind-pid draagt;
    // een ander pid, een dood kind of een timeout is een eerlijke weigering met exit != 0.
    // FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS: a slow runner (GitHub windows-latest, Node 18, measured 2026-09-24) can need
    // more than 10 s before the detached child has written its claim; the default is unchanged for real use.
    const claimTimeoutMs = Number(process.env.FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS) > 0 ? Number(process.env.FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS) : 10000;
    const hs = awaitChildClaim({ pidFile: PID_FILE, childPid: child.pid, timeoutMs: claimTimeoutMs, nonce: startNonce });
    if (!hs.ok) {
      // r4 #16: een mislukte handshake mag geen levend, onbeheerd detached kind achterlaten. Dit pid komt
      // uit ONS eigen spawn-resultaat — exact-PID kill is precies wat de HARD MUST toestaat.
      if (pidAlive(child.pid)) {
        // r5 #22: kill via het EIGEN ChildProcess-handle — geen numerieke pid-herresolutie, dus geen
        // recycling-venster tussen de liveness-check en de kill. De watcher spawnt zelf geen kinderen,
        // dus een tree-kill is hier niet nodig.
        try {
          child.kill();
          console.error('handshake gefaald — eigen kind pid ' + child.pid + ' beeindigd via het proceshandle (geen wees-watcher)');
        } catch (e) { console.error('handshake gefaald en kind pid ' + child.pid + ' kon niet beeindigd worden: ' + e.message); }
      }
      console.error('usage-guard NOT started — ' + hs.reason + ' (log: ' + LOG_FILE + ')');
      process.exit(1);
    }
    console.log('usage-guard started (pid ' + child.pid + ', claim geverifieerd) — ' + settingsLine(GUARD) + ' · log: ' + LOG_FILE);
    // REG-USAGE-GUARANTEE (2026-09-24): same wording as `status` — see that call site's comment.
    console.log('gemeten elke ' + INTERVAL + 's (beste-poging — een taak kan tussen twee metingen door de limiet nog overschrijden; dit is geen ogenblikkelijke, gegarandeerde blokkade) / sampled every ' + INTERVAL + 's (best effort — a task can still cross the limit between samples; this is not an instant, guaranteed block)');
    // DISCLOSURE (v2.7.0): only here, on a verified NEW watcher — never on "already running" or a refused start.
    for (const line of disclosureLines(GUARD_CFG.disclosure)) console.log(line);
    process.exit(0);
  }
  if (cmd === 'stop') {
    // Never kill a PID we cannot prove is ours, and never `/T` (a tree-kill on a recycled pid is exactly
    // the incident class the owner's HARD MUST was written for). Unverifiable = refuse + say so.
    const rec = readPidRecord();
    // GUARD-STOP (2026-09-24): the exit code now actually reflects whether the watcher was confirmed
    // stopped — this used to `process.exit(0)` unconditionally at the end, even on the "still alive
    // after the kill attempt" branch, so a caller scripting against the exit code could never tell a
    // real stop from a failed one.
    let stoppedOk = true;
    if (!rec.pid) console.log('usage-guard not running (no pid file)');
    else {
      const own = ownsPid(rec.pid, rec);
      if (own.ok) {
        try {
          if (process.platform === 'win32') execSync('taskkill /PID ' + rec.pid + ' /F', { stdio: 'ignore' });
          else process.kill(rec.pid, 'SIGTERM');
        } catch { /* verified below by liveness, not by the exit code */ }
        // GUARD-STOP: SIGTERM handling now does real async cleanup (abort an in-flight request, wait for
        // it to settle, clear timers, release the slot) before the watcher actually exits — checking
        // liveness immediately after sending the signal would almost always see it still alive. Poll
        // briefly (bounded at 3s) instead of assuming instant death; Windows' taskkill /F is already
        // forceful and near-instant, so this mostly matters on POSIX.
        const deadline = Date.now() + 3000;
        while (pidAlive(rec.pid) && Date.now() < deadline) {
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch { break; }
        }
        // CODEX finding #17: the pid file used to be deleted unconditionally — including when the kill
        // was REFUSED or failed — which erased the only ownership evidence and let the next `start`
        // spawn a duplicate alongside a watcher that was still alive. Delete only on confirmed death.
        const dead = !pidAlive(rec.pid);
        if (dead) { try { fs.unlinkSync(PID_FILE); } catch {} console.log('usage-guard stopped (pid ' + rec.pid + ')'); }
        else { console.log('usage-guard NOT stopped — pid ' + rec.pid + ' is still alive after the kill attempt; pid file kept so the next start does not spawn a duplicate'); stoppedOk = false; }
      } else if (own.code === 'unverifiable') {
        // CODEX ronde-3 #4 (2026-08-06): 'unverifiable' betekent "mogelijk een ECHTE watcher waarvan we
        // de command line nu even niet kunnen lezen" (/proc weg, ps faalt). Het pid-bestand wissen zou
        // precies dan de claim van een levende watcher vernietigen en de volgende `start` een duplicaat
        // laten spawnen. Claim behouden, weigering melden, non-zero exit.
        console.log('usage-guard NOT stopped — ' + own.reason + '; pid file KEPT (this may be a live watcher whose identity is temporarily unreadable)');
        process.exit(1);
      } else {
        // dead / recycled / not-watcher: aantoonbaar niet onze levende watcher — record opruimen is veilig.
        console.log('usage-guard not stopped — ' + own.reason + (rec.startedAt ? ' (pid file written ' + rec.startedAt + ')' : '') + '; removing the stale pid file only');
        try { fs.unlinkSync(PID_FILE); } catch {}
      }
    }
    process.exit(stoppedOk ? 0 : 1);
  }
  console.error('unknown command: ' + cmd + ' (use check|status|credits|watch|start|stop|override-on|override-off)');
  process.exit(1);
  })();
}

module.exports = {
  writeStateTo,
  fingerprintAccount, readAccountIdentity, detectAccountSwitch, stateForAccount,
  normalizeWindows, crossedWindows, windowLabel, watcherHealth, fmtReset, stillHighTrigger,
  tick, doPause, doResume, accountStamp, ownsPid, readPosixCmdline, verdictFromCmdline, pidAlive, readCredentialFp,
  claimWatcherSlot, releaseWatcherSlot, incumbentStatus, readPidRecordFrom, STALE_LOCK_MS,
  awaitChildClaim, journalAppend, unresolvedPausedAgents, rotateLogIfNeeded, compactJournalIfNeeded,
  computePressureLevel, buildPressureData, creditsExhausted,
  resolveGuardSettings, loadGuardConfig, settingsLine, disclosureLines, GUARD_DEFAULTS, guardBounds,
  GUARD_BOUNDS_FALLBACK,
  readGuardSwitch, watchStep, readToken, credentialsPresent, noCredentialsLine,
  guardNetworkAllowed, readState, fetchUsage, pc, allAgents,
  withStateLock, withLockedState, stateLockPath,
  verifyForcedWatchGrant, __setOwnerGrantRootForTests,
  runOverrideOn, runOverrideOff,
};
