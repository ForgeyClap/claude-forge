#!/usr/bin/env node
'use strict';
/**
 * NVIDIA Build / NIM provider adapter for Forge (zero-dependency; mission 2026-07-05).
 *
 * OpenAI-compatible endpoint: {NVIDIA_BASE_URL|https://integrate.api.nvidia.com/v1}/chat/completions
 * Auth: Bearer $NVIDIA_API_KEY (key prefix "nvapi-", from build.nvidia.com/settings/api-keys).
 *
 * SAFETY / HONESTY:
 *  - The key is loaded from the environment or the project's .env — NEVER hardcoded, NEVER printed
 *    (all output masks it), NEVER written anywhere.
 *  - No key → MOCK MODE: commands still work, clearly labeled "[mock — no NVIDIA_API_KEY]"; a mock
 *    is never presented as a real model response.
 *  - No live API call happens unless the key is present.
 *  - Retries (2, exponential backoff) + timeout (default 120s) + explicit 429 rate-limit handling.
 *
 * CLI:
 *   node .claude/forge-bin/nvidia-provider.cjs health                 # connectivity check (GET /models)
 *   node .claude/forge-bin/nvidia-provider.cjs models [--verify]      # live model list; --verify = compare with capability matrix
 *   node .claude/forge-bin/nvidia-provider.cjs route <agent> [--function <fn>] [--force-override]   # resolve+validate agent -> nvidia model
 *                                            # (agent-model-map); --function overrides the model via function-model-fit.json. For a
 *                                            # claudeWinsSkipNvidia agent the previewed "model" is null unless --force-override is passed
 *                                            # (this is a PREVIEW nuance only — chat() itself is unaffected and still hard-blocks + requires
 *                                            # a real --reason before ever calling NVIDIA for such an agent).
 *   node .claude/forge-bin/nvidia-provider.cjs chat --role <role>|--model <id>|--function <fn> --prompt "<text>" [--system "<text>"] [--max-tokens N]
 *                                              [--agent <boss-slug>] [--force-override --reason "<why>"]
 *
 * Module API: require(...)  ->  { chat, health, listModels, routeFor, resolveFunction, loadEnv, CONFIG }
 *
 * USAGE POLICY IS ENFORCED IN CODE (forced per owner decision 2026-07-08; was advisory-only before).
 * Pass `agent` (the Boss slug, e.g. "boss"/"build-boss") to chat()/route so the adapter can apply
 * agent-model-map.json's `usagePolicy`:
 *   - claudeWinsSkipNvidia roles (boss, head-chef, review-boss, security-boss, integration-boss, ui-boss):
 *     the call is HARD-BLOCKED before any network request — {skipped:true, reason}. Override only with
 *     `forceOverride:true` + a non-empty `overrideReason` (CLI: --force-override --reason "..."), which
 *     is stamped `policyOverridden:true` on the result so it stays auditable, never silent. This block
 *     fires BEFORE function-fit resolution, so passing --function never bypasses it (no loophole).
 *   - nvidiaForBulkOnly roles (docs-boss, seo-boss, search-boss, skill-boss, test-boss, build-boss):
 *     the call proceeds, stamped `bulkOffload:true`; a coding/coding-fast role additionally stamps
 *     `codeGateRequired:true` — Forge MUST route that output through the build+test gate before it counts.
 *   - No `agent` passed → unclassified, call proceeds unchanged (back-compat for manual/role-only calls).
 *
 * FUNCTION FIT (added 2026-07-26, WP-NVIDIA-FIT — owner directive: a Boss's bulk work must be routed by
 * FUNCTION strength, not just its pre-wired NVIDIA role). Pass `func` (chat: --function <fn>, e.g.
 * "code-draft"/"doc-draft"/"research-digest"/"data-extract"/"summarize"/"translate-rewrite"/"test-sketch")
 * and the adapter resolves the model from `config/models/function-model-fit.json` instead of `role`,
 * using the model judged (by real live probes) to actually be GOOD at that function. An unknown function
 * key is a hard ERROR (never a silent default); a function with fit="none" (no model judged good enough)
 * is HARD-SKIPPED like a policy-blocked call — Claude keeps that work rather than forcing a bad-fit model.
 * `role`/`model` still work unchanged when `--function` is omitted (fully backward-compatible).
 *
 * OWNER SETTING `nvidia` (v2.7.0, forge-config.cjs; default ON): OFF -> chat() returns
 * { skipped: true, reason: 'owner config nvidia=off' } as its VERY FIRST step — before agent/policy/model
 * resolution, before the key is looked at, before any network request. CLI `chat` then prints
 * "SKIPPED (config) — ..." and exits 3 (the same shape as the usagePolicy skip). OFF also covers `health` and
 * `models` (security fix M4, 2026-09-24 — they used to send the key to GET /models even when switched off):
 * health()/listModels() return { ok: false, mode: 'off', reason } WITHOUT any network request, and the CLI prints
 * one plain "NVIDIA OFF — ..." line and exits 3. `--force` (CLI) / { force: true } (module) runs them anyway.
 * `route` never touches the network and still runs, with a note on stderr. forge-config.cjs is soft-required and
 * FAIL-SAFE (M3): a missing module, a throwing get() (unreadable/malformed FORGE_CONFIG.json) or a non-boolean
 * value means OFF with reason 'config unreadable → safe default off' — never a silent fall-back to ON.
 * chat(args, opts) / health(opts) / listModels(opts): opts.configModule injects a module (tests).
 *
 * ENV FILES (security fix M5, 2026-09-24; tightened NVIDIA-ENV-TRUST, 2026-09-24): from the project .env AND
 * the global ~/.claude/nvidia.env only NVIDIA_API_KEY and NVIDIA_<ROLE>_MODEL are loaded — every other name is
 * ignored. NVIDIA_BASE_URL is honoured from the real environment or the GLOBAL file (never from a project .env
 * — a cloned repo could otherwise send the owner's global key to a foreign host). NVIDIA_ALLOW_CUSTOM_BASE_URL
 * is honoured from the REAL PROCESS ENVIRONMENT ONLY — no file, not even the global one, may set it: an env
 * FILE authorising its OWN exception is exactly the hole NVIDIA-ENV-TRUST closed (a hostile/mistaken global
 * file used to be able to both name an attacker endpoint AND flip the flag that made the code stop checking
 * it). Without that flag the base URL must resolve to EXACTLY https://integrate.api.nvidia.com/v1 (a fixed,
 * single-entry allow-list — see ALLOWED_HOSTS/ALLOWED_PATH) — no other host, no port, no userinfo, no query
 * string, no fragment, no path other than the canonical one (normalized, so a traversal segment cannot slip a
 * different effective path past this check). A violation refuses every request with a plain, non-echoing
 * reason (no request is sent, and the reason never repeats the untrusted input verbatim). Even an explicitly
 * authorised custom endpoint (real-env allow flag) still refuses userinfo/query/fragment (NVIDIA-URL-LEAK): a
 * credential accidentally placed inside the base URL itself must never reach a request target, an exported
 * CONFIG, or the dashboard's health-probe parser.
 */
const fs = require('fs');
const path = require('path');

const CLAUDE_DIR = path.resolve(__dirname, '..');
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const MATRIX_FILE = path.join(CLAUDE_DIR, 'config', 'models', 'model-capability-matrix.json');
const MODEL_MAP_FILE = path.join(CLAUDE_DIR, 'config', 'agents', 'agent-model-map.json');
const FUNCTION_FIT_FILE = path.join(CLAUDE_DIR, 'config', 'models', 'function-model-fit.json');

// Owner settings (forge-config.cjs, v2.7.0) — soft-required, see the header.
const NVIDIA_OFF_REASON = 'owner config nvidia=off';
let cfg = null;
try { cfg = require('./forge-config.cjs'); } catch { cfg = null; }
/** configOn(key, def, opts) -> the owner's value for `key`, or `def` (the schema default) when forge-config.cjs
 *  is absent or throws. Never throws. opts.projectRoot = the root this tool acts on (ignored when
 *  FORGE_PROJECT_ROOT is set); opts.configModule injects a module (tests; null = "absent"). */
function configOn(key, def, opts) {
  opts = opts || {};
  const mod = opts.configModule !== undefined ? opts.configModule : cfg;
  if (!mod || typeof mod.get !== 'function') return def;
  try {
    const e = mod.get(key, opts.projectRoot && !process.env.FORGE_PROJECT_ROOT ? { projectRoot: opts.projectRoot } : undefined);
    return e && typeof e.value === typeof def ? e.value : def;
  } catch { return def; }
}
// M3 fail-safe (2026-09-24): the owner switch is read with a SAFE default — anything that is not a clear boolean
// answer from forge-config (module missing, get() throwing on an unreadable file, a wrong-typed value) is OFF.
const NVIDIA_UNREADABLE_REASON = 'config unreadable → safe default off';
/** nvidiaState(opts) -> { on: boolean, reason: string|null }. Never throws. opts.configModule injects a module. */
function nvidiaState(opts) {
  const mod = opts && opts.configModule !== undefined ? opts.configModule : cfg;
  const rootOpts = process.env.FORGE_PROJECT_ROOT ? {} : { projectRoot: PROJECT_DIR };
  let e;
  try {
    if (mod && typeof mod.safeGet === 'function') {            // forge-config's own fail-safe read (never throws)
      e = mod.safeGet('nvidia', Object.assign({ fallback: false }, rootOpts));
      if (e && e.degraded) return { on: false, reason: NVIDIA_UNREADABLE_REASON };
    } else if (mod && typeof mod.get === 'function') {         // an older forge-config.cjs without safeGet
      e = mod.get('nvidia', process.env.FORGE_PROJECT_ROOT ? undefined : rootOpts);
    } else return { on: false, reason: NVIDIA_UNREADABLE_REASON };
  } catch { return { on: false, reason: NVIDIA_UNREADABLE_REASON }; }
  if (!e || typeof e.value !== 'boolean') return { on: false, reason: NVIDIA_UNREADABLE_REASON };
  return e.value ? { on: true, reason: null } : { on: false, reason: NVIDIA_OFF_REASON };
}

// ---- env loader (simple KEY=VALUE; never logs values) ----
// Precedence: real environment > project .env > GLOBAL ~/.claude/nvidia.env (user decision 2026-07-05:
// the key lives once, globally, and works for every Forge project — no copying secrets per project).
// M5 (2026-09-24): a file may only set the names below; the base-URL pair is GLOBAL-file (or real env) only.
const ENV_FILE_ANY = /^NVIDIA_(?:API_KEY|[A-Z0-9_]+_MODEL)$/;
// NVIDIA-ENV-TRUST (2026-09-24): NVIDIA_ALLOW_CUSTOM_BASE_URL is deliberately NOT in this set any more —
// no file (project or global) may set it, only the real process environment (checked directly via
// process.env below, never through loadEnvFile). An env file authorising its own exception is exactly
// the hole this closed; NVIDIA_BASE_URL alone (without the allow flag) is still checked against the
// fixed allow-list in checkBaseUrl(), so a global file naming any other host still refuses.
const ENV_FILE_GLOBAL_ONLY = new Set(['NVIDIA_BASE_URL']);
/** loadEnvFile(envFile, isGlobal) — loads the allowed names from one KEY=VALUE file into process.env (a name
 *  that is already set wins). Never logs values; a missing file is fine. */
function loadEnvFile(envFile, isGlobal) {
  let text;
  try { text = fs.readFileSync(envFile, 'utf8'); } catch { return; } /* missing file is fine */
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (!ENV_FILE_ANY.test(name) && !(isGlobal && ENV_FILE_GLOBAL_ONLY.has(name))) continue;
    let v = m[2].trim();                                          // strip trailing whitespace (invisible 401s)
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);               // strip surrounding quotes
    if (v !== '' && process.env[name] === undefined) process.env[name] = v;
  }
}
function loadEnv() {
  if (process.env.NVIDIA_SKIP_ENV_FILES === '1') return;                              // hermetic test isolation (no file key sources)
  loadEnvFile(path.join(PROJECT_DIR, '.env'), false);                                 // project: key + model overrides only
  loadEnvFile(path.join(require('os').homedir(), '.claude', 'nvidia.env'), true);     // global fallback (one key for all projects)
}
loadEnv();

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
// NVIDIA-ENV-TRUST (2026-09-24): a FIXED, single-entry allow-list — not "any *.nvidia.com host" (a
// look-alike or a legitimate-but-unexpected NVIDIA subdomain was previously accepted with no further
// checks) — and a FIXED canonical path. Both mirror MATRIX.provider.baseUrlDefault exactly.
const ALLOWED_HOSTS = new Set(['integrate.api.nvidia.com']);
const ALLOWED_PATH = '/v1';
/** checkBaseUrl(raw, allowCustom) -> { ok: true, url } | { ok: false, reason }. NVIDIA-ENV-TRUST (2026-09-24):
 *  `allowCustom` must be true ONLY when it came from the REAL process environment (never a project or
 *  global env file — see ENV_FILE_GLOBAL_ONLY above). Without it, the URL must resolve to EXACTLY
 *  https://integrate.api.nvidia.com/v1 (fixed host allow-list + fixed canonical path, normalized so a
 *  traversal segment cannot slip a different effective path past this check) — no port, no userinfo, no
 *  query string, no fragment. Even WITH allowCustom, userinfo/query/fragment are still refused
 *  (NVIDIA-URL-LEAK): a credential placed inside the base URL itself must never become part of a request
 *  target, an exported CONFIG field, or a dashboard's parsed health-probe output. Every reason names only
 *  fixed, non-credential-bearing labels (scheme/host/port presence/path) — never the raw input verbatim,
 *  even for a rejected candidate. Pure. */
function checkBaseUrl(raw, allowCustom) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, reason: 'NVIDIA_BASE_URL is not a valid URL — refused, no request sent' }; }
  if (u.username || u.password) return { ok: false, reason: 'NVIDIA_BASE_URL must not contain userinfo (a username/password) — refused, no request sent' };
  if (u.search || u.hash) return { ok: false, reason: 'NVIDIA_BASE_URL must not contain a query string or a fragment — refused, no request sent' };
  if (allowCustom) return { ok: true, url: (u.origin + u.pathname).replace(/\/+$/, '') };
  const how = ' — refused, no request sent (allow a custom endpoint with NVIDIA_ALLOW_CUSTOM_BASE_URL=1 in the REAL environment only — this can never be set from a project or global env file)';
  if (u.protocol !== 'https:') return { ok: false, reason: 'NVIDIA_BASE_URL must use https: (got ' + u.protocol + ')' + how };
  if (u.port) return { ok: false, reason: 'NVIDIA_BASE_URL must not specify a port' + how };
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return { ok: false, reason: 'NVIDIA_BASE_URL host is not on the fixed allow-list' + how };
  // WHATWG URL parsing already collapses "." / ".." dot-segments during normalization; re-checking the
  // normalized pathname here is defense-in-depth against any future parser/runtime that does not. A
  // trailing slash is trimmed first (matching the pre-existing "trailing slash normalised" behaviour).
  const normalizedPath = path.posix.normalize(u.pathname).replace(/\/+$/, '') || '/';
  if (normalizedPath !== ALLOWED_PATH) return { ok: false, reason: 'NVIDIA_BASE_URL path must be exactly ' + ALLOWED_PATH + how };
  return { ok: true, url: 'https://' + u.hostname.toLowerCase() + ALLOWED_PATH };
}

function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
const MATRIX = readJson(MATRIX_FILE, { roles: {}, catalog: [], provider: {} });
const MODEL_MAP = readJson(MODEL_MAP_FILE, { agents: {} });
// Function-fit table (WP-NVIDIA-FIT 2026-07-26) — maps a bulk-work FUNCTION to the model judged (by live
// probes, see the file's own evidence fields) to actually be good at it; independent of an agent's default
// nvidia role so a Boss's bulk call can be routed by task-function instead of a flat per-Boss role.
const FUNCTION_FIT = readJson(FUNCTION_FIT_FILE, { functions: {}, agentAllowedFunctions: {} });
// usagePolicy sets (forced 2026-07-08) — the Claude-first / NVIDIA-bulk-only split, read from the
// SAME file the "layout" table was generated from, so code and doc can never silently drift apart.
const USAGE_POLICY = MODEL_MAP.usagePolicy || {};
const SKIP_AGENTS = new Set((USAGE_POLICY.claudeWinsSkipNvidia && USAGE_POLICY.claudeWinsSkipNvidia.roles) || []);
const BULK_AGENTS = new Set((USAGE_POLICY.nvidiaForBulkOnly && USAGE_POLICY.nvidiaForBulkOnly.roles) || []);
const CODE_ROLES = new Set(['coding', 'coding-fast']);
// Normalize an agent identifier to its registry SLUG so the policy can't be bypassed by case/whitespace
// or by passing a display name (fix 2026-07-09 checkup): "Boss"/"  boss "/"Build Boss" → "boss"/"build-boss".
function normAgent(agent) { if (agent == null) return null; let s = String(agent).trim().toLowerCase(); if (!s) return null;
  if ((MODEL_MAP.agents || {})[s]) return s; const dash = s.replace(/\s+/g, '-'); return (MODEL_MAP.agents || {})[dash] ? dash : s; }
function isKnownAgent(slug) { return !!(slug && (MODEL_MAP.agents || {})[slug]); }
function policyFor(agent) { const a = normAgent(agent); if (!a) return 'unclassified'; if (SKIP_AGENTS.has(a)) return 'claude-first-skip'; if (BULK_AGENTS.has(a)) return 'nvidia-bulk-only'; return 'unclassified'; }

// M5/NVIDIA-ENV-TRUST: after loadEnv(), NVIDIA_BASE_URL can only have come from the real environment or the
// global file (a project .env can no longer set it); NVIDIA_ALLOW_CUSTOM_BASE_URL can ONLY ever be a real
// process env var — it was removed from ENV_FILE_GLOBAL_ONLY above, so no file (project OR global) can ever
// populate process.env with it via loadEnvFile(). Reading it directly here is therefore already real-env-only.
const BASE = checkBaseUrl(process.env.NVIDIA_BASE_URL || (MATRIX.provider && MATRIX.provider.baseUrlDefault) || DEFAULT_BASE_URL,
  process.env.NVIDIA_ALLOW_CUSTOM_BASE_URL === '1');
const CONFIG = {
  baseUrl: BASE.ok ? BASE.url : '',
  baseUrlError: BASE.ok ? null : BASE.reason,
  key: process.env.NVIDIA_API_KEY || '',
  // guard against a non-numeric NVIDIA_TIMEOUT_MS (e.g. "120s") — NaN would make AbortSignal.timeout throw
  // a RangeError that the retry loop misreads as a transient network error (fix 2026-07-09 checkup).
  timeoutMs: (() => { const t = Number(process.env.NVIDIA_TIMEOUT_MS); return Number.isFinite(t) && t > 0 ? t : 120000; })(),
  retries: 2,
};
const hasKey = () => !!CONFIG.key;
// Mask BOTH the nvapi- pattern AND the literal configured key (covers future key formats too).
const mask = (s) => {
  let out = String(s == null ? '' : s).replace(/nvapi-[A-Za-z0-9_\-]+/g, 'nvapi-***MASKED***');
  if (CONFIG.key) out = out.split(CONFIG.key).join('***MASKED***');
  return out;
};
/** maskDeep(value) -> a structure-preserving deep copy of `value` with every STRING run through mask()
 *  (NVIDIA-REDACTION-GAPS, 2026-09-24). A shallow string-level mask() only protects a caller that
 *  remembers to call it on every field it prints; this walks the whole shape so a nested `usage` object,
 *  a model-name field, an array of warnings, or an override reason can never carry an unmasked
 *  configured key out of the module. Non-string types (numbers/booleans/null/undefined) pass through
 *  unchanged; nothing is ever dropped or coerced. Applied at every public function's return AND at the
 *  CLI boundary — see chat()/health()/listModels()/routeFor() below. Pure. */
function maskDeep(value) {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v);
    return out;
  }
  return value;
}
/** combinedSignal(signals) -> an AbortSignal that aborts as soon as ANY given signal aborts. Manual
 *  composition rather than AbortSignal.any() (Node 20.3+) so this keeps working on older Node runners
 *  (this project's own CI comments mention a Node 18 runner). Pure w.r.t. its inputs. */
function combinedSignal(signals) {
  const ac = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}
/** delayCancellable(ms, isCancelled) -> resolves after `ms` ms, or as soon as isCancelled() reports true
 *  (checked on a short poll), whichever comes first. NVIDIA-RETRY-OFF (2026-09-24): a retry backoff must
 *  not blindly run to completion once the owner switches NVIDIA off mid-wait — the very next attempted
 *  request is what this exists to prevent. Never runs longer than `ms`. */
function delayCancellable(ms, isCancelled) {
  return new Promise((resolve) => {
    const POLL_MS = 200;
    const deadline = Date.now() + Math.max(0, ms);
    const tick = () => {
      if (isCancelled && isCancelled()) return resolve();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return resolve();
      setTimeout(tick, Math.min(POLL_MS, remaining));
    };
    tick();
  });
}

// role -> model id, honoring env overrides (NVIDIA_<ROLE>_MODEL) then the matrix
function modelForRole(role) {
  const r = (MATRIX.roles || {})[role];
  if (!r) return null;
  const override = r.envOverride && process.env[r.envOverride];
  return (override && override.trim()) || r.model || null;
}

// ---- HTTP (native fetch, Node >= 18) with retry/timeout/429 ----
/** call(method, p, body, opts) -> the single HTTP choke point. NVIDIA-RETRY-OFF (2026-09-24): a public
 *  wrapper (chat/health/listModels) already checks the owner's `nvidia` switch ONCE before entering
 *  call(); this function re-checks it fresh (via offResult(opts), the same fail-safe check) immediately
 *  before EVERY attempt, including the first, and again right after a caught exception — a long retry
 *  loop must never keep transmitting the key after the owner switches NVIDIA off mid-loop. The backoff
 *  wait itself is cancellable (delayCancellable) so a switch-off during a wait is not silently ignored
 *  until the wait naturally elapses, and the in-flight request is aborted via combinedSignal the moment
 *  a short poll observes the switch went off. opts.force carries the same force-override the public
 *  wrappers already support. */
async function call(method, p, body, opts) {
  if (!hasKey()) return { mock: true, status: 0, error: 'no NVIDIA_API_KEY set — mock mode (no live call made)' };
  if (CONFIG.baseUrlError) return { refused: true, status: 0, error: CONFIG.baseUrlError }; // M5: never send the key to a refused endpoint
  const authorized = () => offResult(opts) === null;
  let lastErr = null;
  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    if (!authorized()) return { status: 0, error: 'NVIDIA switched off mid-retry — no further attempt made', cancelled: true };
    const offAc = new AbortController();
    const offPoll = setInterval(() => { if (!authorized()) offAc.abort(); }, 200);
    try {
      const r = await fetch(CONFIG.baseUrl + p, {
        method,
        headers: { authorization: 'Bearer ' + CONFIG.key, 'content-type': 'application/json', accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: combinedSignal([offAc.signal, AbortSignal.timeout(CONFIG.timeoutMs)]),
      });
      // Retryable: 429 rate-limit (free tier ~40 req/min) + transient upstream failures (Codex F3).
      if ([408, 429, 500, 502, 503, 504].includes(r.status)) {
        const wait = Math.min(30000, (Number(r.headers.get('retry-after')) || 2 ** attempt * 2) * 1000);
        lastErr = 'HTTP ' + r.status + (r.status === 429 ? ' rate-limited' : ' transient') + ' (waited ' + wait + 'ms)';
        if (attempt < CONFIG.retries) { await delayCancellable(wait, () => !authorized()); continue; }
      }
      let j = null; const text = await r.text();
      try { j = JSON.parse(text); } catch {}
      // NVIDIA-REDACTION-GAPS (2026-09-24): mask the FULL text FIRST, then truncate — truncating first
      // (the previous `mask(...text.slice(0, 300))`) could cut a secret in half exactly at the 300-char
      // boundary, leaving an unmasked fragment on the surviving side.
      if (!r.ok) return { status: r.status, error: 'HTTP ' + r.status + ': ' + mask(text).slice(0, 300), json: j };
      return { status: r.status, json: j };
    } catch (e) {
      if (!authorized()) return { status: 0, error: 'NVIDIA switched off mid-retry — no further attempt made', cancelled: true };
      lastErr = mask(String(e && e.message));
      if (attempt < CONFIG.retries) await delayCancellable(2 ** attempt * 1500, () => !authorized());
    } finally {
      clearInterval(offPoll);
    }
  }
  return { status: 0, error: 'failed after ' + (CONFIG.retries + 1) + ' attempts: ' + lastErr };
}

// ---- public API ----
/** offResult(opts) -> the M4 "switched off" answer, or null when NVIDIA may be contacted (on, or opts.force). */
function offResult(opts) {
  if (opts && opts.force === true) return null;
  const s = nvidiaState(opts);
  return s.on ? null : { ok: false, mode: 'off', reason: s.reason };
}
async function listModels(opts) {
  const off = offResult(opts);
  if (off) return maskDeep(Object.assign(off, { models: [] }));
  const r = await call('GET', '/models', undefined, opts);
  if (r.mock) return maskDeep({ mock: true, models: [], note: r.error });
  if (r.error) return maskDeep(r.refused ? { error: r.error, models: [], refused: true } : { error: r.error, models: [] });
  const models = ((r.json && r.json.data) || []).map((m) => m.id).sort();
  return maskDeep({ models });
}
async function health(opts) {
  const off = offResult(opts);
  if (off) return maskDeep(off);
  if (!hasKey()) return { ok: false, mode: 'mock', reason: 'NVIDIA_API_KEY not set (adapter works in mock mode; no live calls)' };
  const t0 = Date.now();
  const r = await listModels({ force: true }); // the switch was checked just above
  if (r.error) return maskDeep({ ok: false, mode: r.refused ? 'refused' : 'live', reason: r.error });
  return maskDeep({ ok: true, mode: 'live', models: r.models.length, ms: Date.now() - t0, baseUrl: CONFIG.baseUrl });
}
// role → capability the assigned model MUST have (generic validation; Codex F2)
const ROLE_REQUIRED_CAP = { reasoning: 'reasoning', coding: 'coding', 'coding-fast': 'coding', vision: 'vision', review: ['review', 'reasoning'] };
function validateModel(role, model, warnings, label) {
  if (!model) { warnings.push(label + ': nvidia role "' + role + '" resolves to no model'); return; }
  const cat = (MATRIX.catalog || []).find((c) => c.id === model);
  if (!cat) { warnings.push(label + ': model "' + model + '" is NOT in the capability-matrix catalog (typo/stale env override?) — validate with `models --verify` before use'); return; }
  // warn on models the matrix marks broken/avoid (fix 2026-07-09 checkup) — catalog membership alone is not enough
  if (cat.tier === 'avoid' || /HANG|EMPTY|ERROR|DO NOT USE|\bavoid\b/i.test(String(cat.probe || ''))) {
    warnings.push(label + ': model "' + model + '" is marked BROKEN/avoid in the matrix (tier="' + cat.tier + '", probe="' + String(cat.probe || '').slice(0, 48) + '") — do NOT use for a live call');
  }
  const need = ROLE_REQUIRED_CAP[role];
  if (need) {
    const needs = Array.isArray(need) ? need : [need];
    if (!needs.some((n) => cat.caps.includes(n))) warnings.push(label + ': model "' + model + '" lacks required capability [' + needs.join('|') + '] for role "' + role + '"');
  }
}
// Resolve a bulk-work FUNCTION (e.g. "code-draft", "data-extract") to the model judged good at it.
// `fitMap` is injectable (defaults to the loaded FUNCTION_FIT) purely so tests can exercise the
// unknown-function and no-fit-model branches deterministically without touching real config on disk.
function resolveFunction(func, fitMap) {
  const m = fitMap || FUNCTION_FIT;
  const entry = (m.functions || {})[func];
  if (!entry) return { error: 'unknown function "' + func + '" — see config/models/function-model-fit.json functions (' + Object.keys(m.functions || {}).join('|') + ')' };
  if (!entry.model || entry.fit === 'none') return { skip: true, reason: 'function "' + func + '" has NO fit NVIDIA model (fit="' + (entry.fit || 'none') + '") — Claude keeps this work; never force a bad-fit model onto NVIDIA' };
  return { model: entry.model, role: entry.role, fit: entry.fit };
}
// Codex F13: routeFor() is a PREVIEW of what chat() would actually do — it must not show a real
// model for a claudeWinsSkipNvidia agent unless the caller explicitly passes forceOverride:true,
// matching chat()'s own hard-block. This is a nuance in the PREVIEW's honesty, not a new bypass:
// chat() itself is completely unchanged (it already enforces this, plus a mandatory overrideReason,
// before ever calling NVIDIA). validateModel() still runs against the internally-resolved model
// either way, so a broken/avoid-tier env override still warns even when the final `model` field is
// nulled out for a blocked agent.
function routeFor(agent, func, forceOverride) {
  // NVIDIA-REDACTION-GAPS (2026-09-24): a bogus env-model-override (e.g. NVIDIA_CODING_MODEL set to an
  // actual leaked key-shaped string) can reach `model`/`fallbackModel`/`warnings` below — maskDeep()
  // sanitizes the WHOLE returned shape at this one boundary, not just the fields a caller remembers to
  // check.
  return maskDeep(routeForRaw(agent, func, forceOverride));
}
function routeForRaw(agent, func, forceOverride) {
  const a = (MODEL_MAP.agents || {})[agent];
  if (!a) return { error: 'unknown agent "' + agent + '" — see config/agents/agent-registry.json' };
  let nvidiaRoleUsed = a.nvidia;
  let primary = modelForRole(a.nvidia);
  const fallback = modelForRole(a.nvidiaFallback);
  const warnings = [];
  let funcNote = null;
  if (func) {
    const fr = resolveFunction(func);
    if (fr.error) return { error: fr.error, agent, func };
    if (fr.skip) { funcNote = fr.reason; nvidiaRoleUsed = null; primary = null; }
    else {
      nvidiaRoleUsed = fr.role; primary = fr.model;
      funcNote = 'function "' + func + '" resolves to nvidia role "' + fr.role + '" (fit=' + fr.fit + '), overriding this agent\'s default nvidia role "' + a.nvidia + '" for this call';
    }
    const allowedFns = (FUNCTION_FIT.agentAllowedFunctions || {})[agent];
    if (Array.isArray(allowedFns) && !allowedFns.includes(func)) warnings.push('function "' + func + '" is not in agentAllowedFunctions for "' + agent + '" (advisory only — call still resolves; see function-model-fit.json)');
  }
  if (primary) validateModel(nvidiaRoleUsed, primary, warnings, 'primary');
  if (a.nvidiaFallback) validateModel(a.nvidiaFallback, fallback, warnings, 'fallback');
  const policy = policyFor(agent);
  const allowed = policy !== 'claude-first-skip';
  if (!allowed) warnings.push('usagePolicy.claudeWinsSkipNvidia: "' + agent + '" is Claude-first — NVIDIA calls for this agent are BLOCKED unless forceOverride is used with a reason.');
  const blocked = !allowed && !forceOverride;
  return { agent, claudeTier: a.claudeTier, nvidiaRole: nvidiaRoleUsed, model: blocked ? null : primary, fallbackModel: fallback, premium: a.premium, why: a.why, prohibited: a.prohibited || [], policy, allowed, func: func || null, funcNote, warnings };
}
/** chat(args, opts) -> maskDeep(chatRaw(args, opts)) (NVIDIA-REDACTION-GAPS, 2026-09-24). chatRaw() has
 *  several early returns (skip/error/mock/success); wrapping the ONE call site here — rather than each
 *  return individually — means a future new return path is sanitized automatically instead of by
 *  convention. `content`/`usage`/`finish`/`overrideReason` are exactly the fields the finding's evidence
 *  named as unmasked leak surfaces. */
async function chat(args, opts) {
  return maskDeep(await chatRaw(args, opts));
}
async function chatRaw({ role, model, prompt, system, maxTokens, agent, func, forceOverride, overrideReason }, opts) {
  // Owner setting first (v2.7.0): nvidia=off means NO call at all — checked before anything else is resolved.
  // An unreadable setting is OFF too (M3), with its own reason.
  const ns = nvidiaState(opts);
  if (!ns.on) return { skipped: true, reason: ns.reason };
  // usagePolicy enforcement (forced 2026-07-08; hardened 2026-07-09) — checked BEFORE model resolution / any network call.
  const na = normAgent(agent);
  // close the asymmetric hole: a PASSED-but-unknown agent slug (typo of a real Boss) must ERROR, not
  // silently fall through as 'unclassified' and bypass the policy. Agent-less calls stay unclassified (back-compat).
  if (agent != null && String(agent).trim() !== '' && !isKnownAgent(na)) {
    return { error: 'unknown agent "' + agent + '" — not in agent-model-map.json (typo? use a Boss slug like build-boss). Omit agent entirely for an unclassified manual call.', agent };
  }
  const policy = policyFor(agent);
  if (policy === 'claude-first-skip') {
    if (!forceOverride) {
      return { skipped: true, agent: na, policy, reason: 'usagePolicy.claudeWinsSkipNvidia: "' + na + '" is Claude-first — NVIDIA call refused. The Claude subagent should do this itself on its own runtime (nvidia-skipped). Pass forceOverride:true + overrideReason to bypass deliberately.' };
    }
    if (!overrideReason || !String(overrideReason).trim()) {
      return { error: 'forceOverride requires a non-empty overrideReason (CLI: --reason "...") — silent policy bypass is not allowed', agent: na, policy };
    }
  }
  // Function-fit resolution (WP-NVIDIA-FIT 2026-07-26) — checked AFTER the usagePolicy skip-block above,
  // so a claudeWinsSkipNvidia agent (boss/head-chef/review-boss/security-boss/integration-boss/ui-boss)
  // stays hard-blocked no matter what --function is passed; there is no function-based bypass.
  let funcResolved = null;
  if (func) {
    const fr = resolveFunction(func);
    if (fr.error) return { error: fr.error, agent: na, func };
    if (fr.skip) return { skipped: true, agent: na, func, functionUnfit: true, reason: fr.reason };
    funcResolved = fr;
  }
  const id = model || (funcResolved && funcResolved.model) || (role && modelForRole(role));
  if (!id) return { error: 'no model resolved (pass --model <id>, --function <fn>, or --role ' + Object.keys(MATRIX.roles || {}).join('|') + ')' };
  const roleForGate = role || (funcResolved && funcResolved.role);
  const policyStamp = {};
  if (func) policyStamp.func = func;
  if (policy === 'claude-first-skip') { policyStamp.policyOverridden = true; policyStamp.overrideReason = overrideReason; }
  else if (policy === 'nvidia-bulk-only') { policyStamp.bulkOffload = true;
    // code-gate marker regardless of whether the caller used --role coding, --function <coding-family fn>, or --model <id> directly.
    // Keyed on the ROLE (explicit or function-resolved) or the AGENT's mapped codegen role (build-boss/test-boss use nvidia role
    // "coding"), NOT on the model's raw caps — nano-30b is coding-capable but docs-boss uses it for prose (fix 2026-07-09).
    const amap = na && (MODEL_MAP.agents || {})[na];
    const agentIsCodegen = !!(amap && (CODE_ROLES.has(amap.nvidia) || CODE_ROLES.has(amap.nvidiaFallback)));
    if (CODE_ROLES.has(roleForGate) || agentIsCodegen) policyStamp.codeGateRequired = true; }
  if (!hasKey()) return { mock: true, model: id, agent: na, policy, ...policyStamp, content: '[mock — no NVIDIA_API_KEY; no live call made. This is NOT a model response.]' };
  const body = {
    model: id,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
    max_tokens: Number(maxTokens || 1024),
    temperature: 0.2,
  };
  const r = await call('POST', '/chat/completions', body, opts);
  if (r.error) return { model: id, agent, policy, ...policyStamp, error: r.error };
  const choice = r.json && r.json.choices && r.json.choices[0];
  return { model: id, agent, policy, ...policyStamp, content: (choice && choice.message && choice.message.content) || '', usage: r.json && r.json.usage, finish: choice && choice.finish_reason };
}

// Exported CONFIG is a REDACTED copy — the key never leaves this module (Fable security hardening).
// NVIDIA-URL-LEAK: baseUrl/baseUrlError are masked too — checkBaseUrl() should already keep them
// credential-free (userinfo/query/fragment are refused before a URL is ever accepted), but a masked
// export costs nothing and is a second, independent layer against a future validation regression.
module.exports = { chat, health, listModels, routeFor, resolveFunction, loadEnv,
  CONFIG: { ...CONFIG, key: hasKey() ? '***set***' : '', baseUrl: mask(CONFIG.baseUrl), baseUrlError: CONFIG.baseUrlError ? mask(CONFIG.baseUrlError) : CONFIG.baseUrlError },
  modelForRole, mask, maskDeep, configOn, nvidiaState, checkBaseUrl, NVIDIA_OFF_REASON, NVIDIA_UNREADABLE_REASON };

// ---- CLI ----
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'health';
  // a flag's value must not be the next flag: `--force-override --reason --max-tokens 200` must NOT make
  // reason='--max-tokens' (fix 2026-07-09 checkup) — treat a following --token as "no value given".
  const arg = (n, d) => { const i = args.indexOf('--' + n); if (i < 0 || args[i + 1] === undefined) return d; const v = args[i + 1]; return String(v).startsWith('--') ? d : v; };
  // M4: when the owner switched NVIDIA off (or the setting is unreadable), health/models make NO request unless
  // --force; `route` never touches the network and only gets a note. One plain line, exit 3 (= act on this).
  const ns = nvidiaState();
  const force = args.includes('--force');
  const offLine = ns.on ? null : 'NVIDIA OFF — ' + ns.reason + ' — no NVIDIA request made (check anyway: --force; turn it back on: /forge config set nvidia aan)';
  const offNote = ns.on ? null : 'note: ' + ns.reason + ' — chat() is skipped (no NVIDIA call)' + (cmd === 'route' ? '; route is a local preview only' : '; --force: this ' + cmd + ' contacts NVIDIA anyway') + '. Turn it back on: /forge config set nvidia aan';
  (async () => {
    if ((cmd === 'health' || cmd === 'models') && offLine && !force) { console.log(offLine); process.exitCode = 3; return; }
    if (cmd === 'health') {
      const h = await health({ force });
      console.log(h.ok ? 'NVIDIA OK (live) — ' + h.models + ' models · ' + h.ms + 'ms · ' + h.baseUrl : 'NVIDIA ' + (h.mode === 'mock' ? 'MOCK MODE (no key — NOT live-ready)' : 'FAIL') + ' — ' + h.reason);
      if (offNote) console.log(offNote);
      // Mock is NOT a passing connectivity check (Codex F1): exit 1 unless explicitly allowed for offline flows.
      process.exitCode = h.ok ? 0 : (h.mode === 'mock' && args.includes('--allow-mock') ? 0 : 1); return;
    }
    if (cmd === 'models') {
      if (offNote) console.log(offNote);
      const r = await listModels({ force });
      if (r.mock) { console.log('[mock — no NVIDIA_API_KEY] configured matrix models:'); (MATRIX.catalog || []).forEach((c) => console.log('  ' + c.id + '  [' + c.caps.join(',') + ']')); return; }
      if (r.error) { console.error('models fetch failed: ' + r.error); process.exitCode = 1; return; }
      console.log(r.models.length + ' live models on ' + CONFIG.baseUrl);
      if (args.includes('--verify')) {
        for (const roleName of Object.keys(MATRIX.roles || {})) {
          const m = modelForRole(roleName);
          console.log('  role ' + roleName.padEnd(10) + ' -> ' + String(m).padEnd(40) + (r.models.includes(m) ? 'LIVE ✓' : '⚠ NOT in live list — update the matrix or env override'));
        }
      } else r.models.forEach((m) => console.log('  ' + m));
      return;
    }
    if (cmd === 'route') {
      const out = routeFor(args[1], arg('function'), args.includes('--force-override'));
      if (offNote) console.error(offNote); // stderr, so the JSON on stdout stays parseable
      console.log(JSON.stringify(out, null, 2)); process.exitCode = out.error ? 1 : 0; return;
    }
    if (cmd === 'chat') {
      const out = await chat({ role: arg('role'), model: arg('model'), prompt: arg('prompt', 'Say: ok'), system: arg('system'), maxTokens: arg('max-tokens'),
        agent: arg('agent'), func: arg('function'), forceOverride: args.includes('--force-override'), overrideReason: arg('reason') });
      if (out.skipped) {
        const why = out.reason === NVIDIA_OFF_REASON || out.reason === NVIDIA_UNREADABLE_REASON ? 'config' : out.functionUnfit ? 'function-fit' : 'usagePolicy';
        console.log('SKIPPED (' + why + ') — ' + out.reason + (why === 'config' ? ' (no NVIDIA call made; turn it back on: /forge config set nvidia aan)' : ''));
        process.exitCode = 3; return;
      }
      if (out.error) { console.error(mask(out.error)); process.exitCode = 1; return; }
      const tags = [out.policyOverridden ? 'POLICY-OVERRIDDEN' : '', out.bulkOffload ? 'BULK-OFFLOAD' : '', out.codeGateRequired ? 'CODE-GATE-REQUIRED' : '', out.func ? 'FUNC:' + out.func : ''].filter(Boolean);
      console.log((out.mock ? '[MOCK] ' : '[' + out.model + '] ') + (tags.length ? '[' + tags.join(' ') + '] ' : '') + out.content);
      if (out.usage) console.log('usage: ' + JSON.stringify(out.usage)); return;
    }
    console.error('unknown command: ' + cmd + ' (use health|models|route|chat)'); process.exitCode = 1;
  })();
}
