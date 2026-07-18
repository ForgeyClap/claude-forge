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
 *   node .claude/forge-bin/nvidia-provider.cjs route <agent>          # resolve+validate agent -> nvidia model (agent-model-map)
 *   node .claude/forge-bin/nvidia-provider.cjs chat --role <role>|--model <id> --prompt "<text>" [--system "<text>"] [--max-tokens N]
 *                                              [--agent <boss-slug>] [--force-override --reason "<why>"]
 *
 * Module API: require(...)  ->  { chat, health, listModels, routeFor, loadEnv, CONFIG }
 *
 * USAGE POLICY IS ENFORCED IN CODE (forced per owner decision 2026-07-08; was advisory-only before).
 * Pass `agent` (the Boss slug, e.g. "boss"/"build-boss") to chat()/route so the adapter can apply
 * agent-model-map.json's `usagePolicy`:
 *   - claudeWinsSkipNvidia roles (boss, head-chef, review-boss, security-boss, integration-boss, ui-boss):
 *     the call is HARD-BLOCKED before any network request — {skipped:true, reason}. Override only with
 *     `forceOverride:true` + a non-empty `overrideReason` (CLI: --force-override --reason "..."), which
 *     is stamped `policyOverridden:true` on the result so it stays auditable, never silent.
 *   - nvidiaForBulkOnly roles (docs-boss, seo-boss, search-boss, skill-boss, test-boss, build-boss):
 *     the call proceeds, stamped `bulkOffload:true`; a coding/coding-fast role additionally stamps
 *     `codeGateRequired:true` — Forge MUST route that output through the build+test gate before it counts.
 *   - No `agent` passed → unclassified, call proceeds unchanged (back-compat for manual/role-only calls).
 */
const fs = require('fs');
const path = require('path');

const CLAUDE_DIR = path.resolve(__dirname, '..');
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const MATRIX_FILE = path.join(CLAUDE_DIR, 'config', 'models', 'model-capability-matrix.json');
const MODEL_MAP_FILE = path.join(CLAUDE_DIR, 'config', 'agents', 'agent-model-map.json');

// ---- env loader (simple KEY=VALUE; never logs values) ----
// Precedence: real environment > project .env > GLOBAL ~/.claude/nvidia.env (user decision 2026-07-05:
// the key lives once, globally, and works for every Forge project — no copying secrets per project).
function loadEnvFile(envFile) {
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();                                          // strip trailing whitespace (invisible 401s)
      if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);               // strip surrounding quotes
      if (v !== '' && process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {} /* missing file is fine */
}
function loadEnv() {
  if (process.env.NVIDIA_SKIP_ENV_FILES === '1') return;                        // hermetic test isolation (no file key sources)
  loadEnvFile(path.join(PROJECT_DIR, '.env'));                                  // project overrides
  loadEnvFile(path.join(require('os').homedir(), '.claude', 'nvidia.env'));     // global fallback (one key for all projects)
}
loadEnv();

function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
const MATRIX = readJson(MATRIX_FILE, { roles: {}, catalog: [], provider: {} });
const MODEL_MAP = readJson(MODEL_MAP_FILE, { agents: {} });
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

const CONFIG = {
  baseUrl: (process.env.NVIDIA_BASE_URL || (MATRIX.provider && MATRIX.provider.baseUrlDefault) || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
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
async function listModels() {
  const r = await call('GET', '/models');
  if (r.mock) return { mock: true, models: [], note: r.error };
  if (r.error) return { error: r.error, models: [] };
  const models = ((r.json && r.json.data) || []).map((m) => m.id).sort();
  return { models };
}
async function health() {
  if (!hasKey()) return { ok: false, mode: 'mock', reason: 'NVIDIA_API_KEY not set (adapter works in mock mode; no live calls)' };
  const t0 = Date.now();
  const r = await listModels();
  if (r.error) return { ok: false, mode: 'live', reason: r.error };
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
function routeFor(agent) {
  const a = (MODEL_MAP.agents || {})[agent];
  if (!a) return { error: 'unknown agent "' + agent + '" — see config/agents/agent-registry.json' };
  const primary = modelForRole(a.nvidia);
  const fallback = modelForRole(a.nvidiaFallback);
  const warnings = [];
  validateModel(a.nvidia, primary, warnings, 'primary');
  if (a.nvidiaFallback) validateModel(a.nvidiaFallback, fallback, warnings, 'fallback');
  const policy = policyFor(agent);
  const allowed = policy !== 'claude-first-skip';
  if (!allowed) warnings.push('usagePolicy.claudeWinsSkipNvidia: "' + agent + '" is Claude-first — NVIDIA calls for this agent are BLOCKED unless forceOverride is used with a reason.');
  return { agent, claudeTier: a.claudeTier, nvidiaRole: a.nvidia, model: primary, fallbackModel: fallback, premium: a.premium, why: a.why, prohibited: a.prohibited || [], policy, allowed, warnings };
}
async function chat({ role, model, prompt, system, maxTokens, agent, forceOverride, overrideReason }) {
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
  const id = model || (role && modelForRole(role));
  if (!id) return { error: 'no model resolved (pass --model <id> or --role ' + Object.keys(MATRIX.roles || {}).join('|') + ')' };
  const policyStamp = {};
  if (policy === 'claude-first-skip') { policyStamp.policyOverridden = true; policyStamp.overrideReason = overrideReason; }
  else if (policy === 'nvidia-bulk-only') { policyStamp.bulkOffload = true;
    // code-gate marker regardless of whether the caller used --role coding or --model <id> directly.
    // Keyed on the ROLE or the AGENT's mapped codegen role (build-boss/test-boss use nvidia role "coding"),
    // NOT on the model's raw caps — nano-30b is coding-capable but docs-boss uses it for prose (fix 2026-07-09).
    const amap = na && (MODEL_MAP.agents || {})[na];
    const agentIsCodegen = !!(amap && (CODE_ROLES.has(amap.nvidia) || CODE_ROLES.has(amap.nvidiaFallback)));
    if (CODE_ROLES.has(role) || agentIsCodegen) policyStamp.codeGateRequired = true; }
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
module.exports = { chat, health, listModels, routeFor, loadEnv, CONFIG: { ...CONFIG, key: hasKey() ? '***set***' : '' }, modelForRole, mask };

// ---- CLI ----
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'health';
  // a flag's value must not be the next flag: `--force-override --reason --max-tokens 200` must NOT make
  // reason='--max-tokens' (fix 2026-07-09 checkup) — treat a following --token as "no value given".
  const arg = (n, d) => { const i = args.indexOf('--' + n); if (i < 0 || args[i + 1] === undefined) return d; const v = args[i + 1]; return String(v).startsWith('--') ? d : v; };
  (async () => {
    if (cmd === 'health') {
      const h = await health();
      console.log(h.ok ? 'NVIDIA OK (live) — ' + h.models + ' models · ' + h.ms + 'ms · ' + h.baseUrl : 'NVIDIA ' + (h.mode === 'mock' ? 'MOCK MODE (no key — NOT live-ready)' : 'FAIL') + ' — ' + h.reason);
      // Mock is NOT a passing connectivity check (Codex F1): exit 1 unless explicitly allowed for offline flows.
      process.exitCode = h.ok ? 0 : (h.mode === 'mock' && args.includes('--allow-mock') ? 0 : 1); return;
    }
    if (cmd === 'models') {
      const r = await listModels();
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
      const out = routeFor(args[1]);
      console.log(JSON.stringify(out, null, 2)); process.exitCode = out.error ? 1 : 0; return;
    }
    if (cmd === 'chat') {
      const out = await chat({ role: arg('role'), model: arg('model'), prompt: arg('prompt', 'Say: ok'), system: arg('system'), maxTokens: arg('max-tokens'),
        agent: arg('agent'), forceOverride: args.includes('--force-override'), overrideReason: arg('reason') });
      if (out.skipped) { console.log('SKIPPED (usagePolicy) — ' + out.reason); process.exitCode = 3; return; }
      if (out.error) { console.error(mask(out.error)); process.exitCode = 1; return; }
      const tags = [out.policyOverridden ? 'POLICY-OVERRIDDEN' : '', out.bulkOffload ? 'BULK-OFFLOAD' : '', out.codeGateRequired ? 'CODE-GATE-REQUIRED' : ''].filter(Boolean);
      console.log((out.mock ? '[MOCK] ' : '[' + out.model + '] ') + (tags.length ? '[' + tags.join(' ') + '] ' : '') + out.content);
      if (out.usage) console.log('usage: ' + JSON.stringify(out.usage)); return;
    }
    console.error('unknown command: ' + cmd + ' (use health|models|route|chat)'); process.exitCode = 1;
  })();
}
