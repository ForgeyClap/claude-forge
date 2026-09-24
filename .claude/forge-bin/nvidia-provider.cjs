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
 * ENV FILES (security fix M5, 2026-09-24): from the project .env AND the global ~/.claude/nvidia.env only
 * NVIDIA_API_KEY and NVIDIA_<ROLE>_MODEL are loaded — every other name is ignored. NVIDIA_BASE_URL and
 * NVIDIA_ALLOW_CUSTOM_BASE_URL are honoured ONLY from the real environment or the GLOBAL file, never from a
 * project .env (a cloned repo could otherwise send the owner's global key to any host). The base URL must be
 * https: with a hostname ending in .nvidia.com unless NVIDIA_ALLOW_CUSTOM_BASE_URL=1; a violation refuses every
 * request with a plain reason (no request is sent).
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
const ENV_FILE_GLOBAL_ONLY = new Set(['NVIDIA_BASE_URL', 'NVIDIA_ALLOW_CUSTOM_BASE_URL']);
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
/** checkBaseUrl(raw, allowCustom) -> { ok: true, url } | { ok: false, reason } (M5). https: + a hostname ending in
 *  .nvidia.com, unless allowCustom. The reason names only the scheme/host, never the full URL. Pure. */
function checkBaseUrl(raw, allowCustom) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, reason: 'NVIDIA_BASE_URL is not a valid URL — refused, no request sent' }; }
  const url = u.href.replace(/\/+$/, '');
  if (allowCustom) return { ok: true, url };
  const how = ' — refused, no request sent (allow a custom endpoint with NVIDIA_ALLOW_CUSTOM_BASE_URL=1 in the real environment or ~/.claude/nvidia.env)';
  if (u.protocol !== 'https:') return { ok: false, reason: 'NVIDIA_BASE_URL must use https: (got ' + u.protocol + ')' + how };
  if (!u.hostname.toLowerCase().endsWith('.nvidia.com')) return { ok: false, reason: 'NVIDIA_BASE_URL host "' + u.hostname + '" is not an nvidia.com host' + how };
  return { ok: true, url };
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

// M5: after loadEnv(), NVIDIA_BASE_URL / NVIDIA_ALLOW_CUSTOM_BASE_URL can only have come from the real environment
// or the global file (a project .env can no longer set them).
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

// role -> model id, honoring env overrides (NVIDIA_<ROLE>_MODEL) then the matrix
function modelForRole(role) {
  const r = (MATRIX.roles || {})[role];
  if (!r) return null;
  const override = r.envOverride && process.env[r.envOverride];
  return (override && override.trim()) || r.model || null;
}

// ---- HTTP (native fetch, Node >= 18) with retry/timeout/429 ----
async function call(method, p, body) {
  if (!hasKey()) return { mock: true, status: 0, error: 'no NVIDIA_API_KEY set — mock mode (no live call made)' };
  if (CONFIG.baseUrlError) return { refused: true, status: 0, error: CONFIG.baseUrlError }; // M5: never send the key to a refused endpoint
  let lastErr = null;
  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    try {
      const r = await fetch(CONFIG.baseUrl + p, {
        method,
        headers: { authorization: 'Bearer ' + CONFIG.key, 'content-type': 'application/json', accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(CONFIG.timeoutMs),
      });
      // Retryable: 429 rate-limit (free tier ~40 req/min) + transient upstream failures (Codex F3).
      if ([408, 429, 500, 502, 503, 504].includes(r.status)) {
        const wait = Math.min(30000, (Number(r.headers.get('retry-after')) || 2 ** attempt * 2) * 1000);
        lastErr = 'HTTP ' + r.status + (r.status === 429 ? ' rate-limited' : ' transient') + ' (waited ' + wait + 'ms)';
        if (attempt < CONFIG.retries) { await new Promise((res) => setTimeout(res, wait)); continue; }
      }
      let j = null; const text = await r.text();
      try { j = JSON.parse(text); } catch {}
      if (!r.ok) return { status: r.status, error: mask('HTTP ' + r.status + ': ' + text.slice(0, 300)), json: j };
      return { status: r.status, json: j };
    } catch (e) {
      lastErr = mask(String(e && e.message));
      if (attempt < CONFIG.retries) await new Promise((res) => setTimeout(res, 2 ** attempt * 1500));
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
  if (off) return Object.assign(off, { models: [] });
  const r = await call('GET', '/models');
  if (r.mock) return { mock: true, models: [], note: r.error };
  if (r.error) return r.refused ? { error: r.error, models: [], refused: true } : { error: r.error, models: [] };
  const models = ((r.json && r.json.data) || []).map((m) => m.id).sort();
  return { models };
}
async function health(opts) {
  const off = offResult(opts);
  if (off) return off;
  if (!hasKey()) return { ok: false, mode: 'mock', reason: 'NVIDIA_API_KEY not set (adapter works in mock mode; no live calls)' };
  const t0 = Date.now();
  const r = await listModels({ force: true }); // the switch was checked just above
  if (r.error) return { ok: false, mode: r.refused ? 'refused' : 'live', reason: r.error };
  return { ok: true, mode: 'live', models: r.models.length, ms: Date.now() - t0, baseUrl: CONFIG.baseUrl };
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
async function chat({ role, model, prompt, system, maxTokens, agent, func, forceOverride, overrideReason }, opts) {
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
  const r = await call('POST', '/chat/completions', body);
  if (r.error) return { model: id, agent, policy, ...policyStamp, error: r.error };
  const choice = r.json && r.json.choices && r.json.choices[0];
  return { model: id, agent, policy, ...policyStamp, content: (choice && choice.message && choice.message.content) || '', usage: r.json && r.json.usage, finish: choice && choice.finish_reason };
}

// Exported CONFIG is a REDACTED copy — the key never leaves this module (Fable security hardening).
module.exports = { chat, health, listModels, routeFor, resolveFunction, loadEnv, CONFIG: { ...CONFIG, key: hasKey() ? '***set***' : '' }, modelForRole, mask, configOn,
  nvidiaState, checkBaseUrl, NVIDIA_OFF_REASON, NVIDIA_UNREADABLE_REASON };

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
