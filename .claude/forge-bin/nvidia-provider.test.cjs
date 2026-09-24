#!/usr/bin/env node
'use strict';
/** Offline tests for nvidia-provider.cjs — run WITHOUT network: mock mode, key masking,
 *  routing validation, registry/matrix JSON validity. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');

// force mock mode BEFORE requiring the adapter (no key may leak in from env/.env for this test)
delete process.env.NVIDIA_API_KEY;
process.env.NVIDIA_API_KEY = ''; // loader skips empty; CONFIG.key stays ''
// TEST-CREDENTIAL-ISOLATION (2026-09-24): the module's own loadEnv() runs synchronously as part of THIS
// require() (require() then caches the module, so loadEnv() never runs again) — it used to happen with
// NVIDIA_SKIP_ENV_FILES unset, meaning this one require could read the REAL project .env AND the REAL
// global ~/.claude/nvidia.env. Isolation must be established BEFORE this require, not after. The flag is
// restored immediately afterwards so the later M5 tests (which deliberately stage real .env/nvidia.env
// files and rely on baseEnv() inheriting the CURRENT process.env) are unaffected by a leaked skip flag.
const _origSkipEnvFiles = process.env.NVIDIA_SKIP_ENV_FILES;
process.env.NVIDIA_SKIP_ENV_FILES = '1';
const P = require('./nvidia-provider.cjs');
if (_origSkipEnvFiles === undefined) delete process.env.NVIDIA_SKIP_ENV_FILES; else process.env.NVIDIA_SKIP_ENV_FILES = _origSkipEnvFiles;
const os = require('os');
const { spawnSync } = require('child_process');

// Hermetic owner settings (forge-config.cjs, v2.7.0): the global settings file is read from a throwaway home,
// never ~/.claude, and FORGE_PROJECT_ROOT points at an EMPTY fixture so every existing chat() test below runs
// on the schema default (nvidia ON) no matter what the real project settings say.
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-cfghome-'));
const EMPTY_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-cfgproj-'));
process.env.FORGE_CONFIG_HOME = CONFIG_HOME;
process.env.FORGE_PROJECT_ROOT = EMPTY_PROJECT;

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

(async () => {
  console.log('nvidia-provider offline tests');
  // 1) JSON registries valid + complete
  const dir = path.resolve(__dirname, '..', 'config');
  const matrix = JSON.parse(fs.readFileSync(path.join(dir, 'models', 'model-capability-matrix.json'), 'utf8'));
  const registry = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'agent-registry.json'), 'utf8'));
  const modelMap = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'agent-model-map.json'), 'utf8'));
  const skillMap = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'agent-skill-map.json'), 'utf8'));
  const bundles = JSON.parse(fs.readFileSync(path.join(dir, 'skills', 'global-skills.json'), 'utf8'));
  t('capability matrix has 7 role slots (incl coding-fast)', Object.keys(matrix.roles).length === 7);
  // Fable consistency-high: every agent's fallback role must keep required caps (esp. build-boss → coding-capable)
  {
    const mm = JSON.parse(fs.readFileSync(path.join(dir, 'agents', 'agent-model-map.json'), 'utf8'));
    const bb = mm.agents['build-boss'];
    const fbModel = matrix.roles[bb.nvidiaFallback] && matrix.roles[bb.nvidiaFallback].model;
    const fbCat = matrix.catalog.find((c) => c.id === fbModel);
    t('build-boss fallback is coding-capable', !!fbCat && fbCat.caps.includes('coding'));
  }
  t('agent registry has the 12 permanent Bosses', Object.keys(registry.agents).length === 12);
  const twelve = ['boss','head-chef','review-boss','test-boss','ui-boss','seo-boss','security-boss','skill-boss','search-boss','build-boss','integration-boss','docs-boss'];
  t('registry contains exactly the standardized names', twelve.every((k) => registry.agents[k]));
  t('every registry agent has a model mapping', twelve.every((k) => modelMap.agents[k]));
  t('every registry agent has core skills', twelve.every((k) => Array.isArray(skillMap.agents[k]) && skillMap.agents[k].length > 0));
  t('skill bundles cover website/n8n/app-backend/research', ['website','n8n','app-backend','research-planning'].every((b) => bundles.bundles[b]));
  // 2) every role model resolves + exists in catalog
  for (const role of Object.keys(matrix.roles)) {
    const m = P.modelForRole(role);
    t('role "' + role + '" resolves to a model (' + m + ')', !!m);
    t('role "' + role + '" model is in the catalog', matrix.catalog.some((c) => c.id === m));
  }
  // 3) routing validation
  const boss = P.routeFor('boss');
  // Forced 2026-07-08: boss is claudeWinsSkipNvidia → routeFor MUST flag it (policy/allowed/warning), not stay silent.
  // Codex F13 (2026-07-26): routeFor() is a PREVIEW of what chat() would do — for a claudeWinsSkipNvidia
  // agent it must NOT show a real model unless forceOverride is explicitly passed (chat() itself is unchanged).
  t('routeFor(boss) → opus premium, but the previewed model is BLOCKED (null) without forceOverride', boss.premium === 'opus' && boss.model === null);
  t('routeFor(boss) → policy=claude-first-skip, allowed=false, warns', boss.policy === 'claude-first-skip' && boss.allowed === false && boss.warnings.length > 0);
  const bossForced = P.routeFor('boss', undefined, true);
  t('routeFor(boss, forceOverride:true) → reveals the real resolved NVIDIA model (preview only — chat() still requires forceOverride+overrideReason to actually call it)', typeof bossForced.model === 'string' && bossForced.model.length > 0 && bossForced.policy === 'claude-first-skip');
  const buildBoss = P.routeFor('build-boss');
  t('routeFor(build-boss) → policy=nvidia-bulk-only, allowed=true', buildBoss.policy === 'nvidia-bulk-only' && buildBoss.allowed === true);
  const ui = P.routeFor('ui-boss', undefined, true); // forceOverride so this test can inspect the resolved model's caps
  const uiModel = matrix.catalog.find((c) => c.id === ui.model);
  t('routeFor(ui-boss, forceOverride) → a vision-capable model', !!uiModel && uiModel.caps.includes('vision'));
  t('routeFor(ui-boss, forceOverride) → policy=claude-first-skip (ui-boss is in the skip list)', ui.policy === 'claude-first-skip' && ui.allowed === false);
  const uiBlocked = P.routeFor('ui-boss');
  t('routeFor(ui-boss) → without forceOverride, the previewed model is blocked (null)', uiBlocked.model === null && uiBlocked.policy === 'claude-first-skip');
  t('routeFor(unknown) → error', !!P.routeFor('random-agent-name').error);
  // 3b) usagePolicy is now ENFORCED IN CODE at chat() — the actual point of "force this layout"
  const blocked = await P.chat({ role: 'default', prompt: 'hi', agent: 'boss' });
  t('chat(agent:boss) → HARD BLOCKED before any call (skipped:true, no mock/network attempted)', blocked.skipped === true && blocked.policy === 'claude-first-skip' && blocked.mock === undefined);
  const noReason = await P.chat({ role: 'default', prompt: 'hi', agent: 'boss', forceOverride: true });
  t('chat(agent:boss, forceOverride, NO reason) → refused (silent bypass forbidden)', !!noReason.error && /overrideReason/.test(noReason.error));
  const overridden = await P.chat({ role: 'default', prompt: 'hi', agent: 'boss', forceOverride: true, overrideReason: 'test: deliberate override' });
  t('chat(agent:boss, forceOverride + reason) → proceeds, stamped policyOverridden', overridden.policyOverridden === true && overridden.overrideReason === 'test: deliberate override');
  const bulk = await P.chat({ role: 'coding', prompt: 'hi', agent: 'build-boss' });
  t('chat(agent:build-boss, role:coding) → proceeds, stamped bulkOffload + codeGateRequired', bulk.bulkOffload === true && bulk.codeGateRequired === true);
  const bulkDocs = await P.chat({ role: 'fast', prompt: 'hi', agent: 'docs-boss' });
  t('chat(agent:docs-boss, role:fast non-coding) → bulkOffload true, NO codeGateRequired', bulkDocs.bulkOffload === true && bulkDocs.codeGateRequired === undefined);
  const unclassified = await P.chat({ role: 'default', prompt: 'hi' });
  t('chat(no agent) → unclassified, unchanged back-compat behavior', unclassified.policy === undefined || unclassified.policy === 'unclassified');
  // 3c) the bypass the checkup found — case/whitespace/display-name must NOT escape the skip block
  const capBoss = await P.chat({ role: 'default', prompt: 'hi', agent: 'Boss' });
  t('chat(agent:"Boss" capitalized) → still BLOCKED (normalized to slug)', capBoss.skipped === true && capBoss.policy === 'claude-first-skip');
  const spaceBoss = await P.chat({ role: 'default', prompt: 'hi', agent: '  ui boss ' });
  t('chat(agent:"  ui boss ") → BLOCKED (trim+space→dash→ui-boss)', spaceBoss.skipped === true);
  const dispBuild = await P.chat({ role: 'coding', prompt: 'hi', agent: 'Build Boss' });
  t('chat(agent:"Build Boss" display name) → bulkOffload + codeGateRequired', dispBuild.bulkOffload === true && dispBuild.codeGateRequired === true);
  const typo = await P.chat({ role: 'default', prompt: 'hi', agent: 'buildboss' });
  t('chat(agent:"buildboss" typo/unknown) → ERROR, not silent unclassified pass', !!typo.error && /unknown agent/.test(typo.error));
  // 3d) --model path (no role) for a bulk coding boss still gets codeGateRequired (via coding-capable model)
  const modelPath = await P.chat({ model: 'openai/gpt-oss-120b', prompt: 'hi', agent: 'build-boss' });
  t('chat(--model coding-capable, agent:build-boss) → codeGateRequired even without role', modelPath.bulkOffload === true && modelPath.codeGateRequired === true);
  // 3e) broken/avoid model via env override now warns in routeFor
  process.env.NVIDIA_CODING_MODEL = 'deepseek-ai/deepseek-v4-pro'; // matrix: HANGS — DO NOT USE
  const brokenRoute = P.routeFor('build-boss');
  t('routeFor with avoid-tier env override → warns BROKEN/avoid', brokenRoute.warnings.some((w) => /BROKEN\/avoid/.test(w)));
  delete process.env.NVIDIA_CODING_MODEL;
  // 4) mock mode is honest (no key → no live call, clearly labeled)
  const h = await P.health();
  t('health without key = mock mode, ok:false', h.mode === 'mock' && h.ok === false);
  const c = await P.chat({ role: 'fast', prompt: 'hi' });
  t('chat without key = mock:true + labeled non-response', c.mock === true && /NOT a model response/.test(c.content));
  // 5) key masking
  t('mask() hides nvapi keys', P.mask('error with nvapi-SECRETSECRET123 inside') === 'error with nvapi-***MASKED*** inside');
  // 6) Codex F2: a bogus env override must produce a route WARNING, not a silent clean route
  // (review-boss is ALSO claudeWinsSkipNvidia — Codex F13 means its previewed model needs forceOverride
  // to be visible; this test targets the warning mechanism, so it forces the preview open on purpose)
  process.env.NVIDIA_REVIEW_MODEL = 'totally/bogus-model-9000';
  const bogus = P.routeFor('review-boss', undefined, true);
  t('bogus env override → warning (not silent)', bogus.model === 'totally/bogus-model-9000' && bogus.warnings.some((w) => /NOT in the capability-matrix catalog/.test(w)));
  const bogusBlocked = P.routeFor('review-boss');
  t('bogus env override, WITHOUT forceOverride → still blocked (model:null); the warning still fires internally regardless of the preview gate', bogusBlocked.model === null && bogusBlocked.warnings.some((w) => /NOT in the capability-matrix catalog/.test(w)));
  delete process.env.NVIDIA_REVIEW_MODEL;
  // 7) Codex F1: health CLI without key must exit NON-zero (mock ≠ live-ready), 0 only with --allow-mock
  const { spawnSync } = require('child_process');
  // isolate the child from BOTH key sources: env var AND the global ~/.claude/nvidia.env fallback
  // (os.homedir() follows USERPROFILE on Windows / HOME on POSIX → point both at an empty temp dir)
  const os = require('os');
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nvguard-test-'));
  // hermetic: skip ALL file key-sources (project .env + global nvidia.env) so the child truly has no key,
  // regardless of what the owner later stores in .env (deep-scan: project .env was leaking the real key).
  const cleanEnv = { ...process.env, USERPROFILE: emptyHome, HOME: emptyHome, NVIDIA_SKIP_ENV_FILES: '1' }; delete cleanEnv.NVIDIA_API_KEY;
  const h1 = spawnSync(process.execPath, [path.join(__dirname, 'nvidia-provider.cjs'), 'health'], { env: cleanEnv, encoding: 'utf8' });
  t('health CLI (no key) exits 1 + labeled MOCK', h1.status === 1 && /MOCK MODE/.test(h1.stdout));
  const h2 = spawnSync(process.execPath, [path.join(__dirname, 'nvidia-provider.cjs'), 'health', '--allow-mock'], { env: cleanEnv, encoding: 'utf8' });
  t('health CLI (no key, --allow-mock) exits 0', h2.status === 0);
  // 8) Codex F3: transient statuses are declared retryable in source (contract check, no network)
  const src = fs.readFileSync(path.join(__dirname, 'nvidia-provider.cjs'), 'utf8');
  t('retry covers 408/429/5xx transients', /\[408, 429, 500, 502, 503, 504\]\.includes\(r\.status\)/.test(src));

  // 9) WP-NVIDIA-FIT (2026-07-26): function-fit routing
  const functionFit = JSON.parse(fs.readFileSync(path.join(dir, 'models', 'function-model-fit.json'), 'utf8'));
  const FUNCS = ['code-draft', 'doc-draft', 'research-digest', 'data-extract', 'summarize', 'translate-rewrite', 'test-sketch'];
  t('function-model-fit.json defines all 7 bulk-work functions', FUNCS.every((f) => functionFit.functions[f]));
  t('every defined function resolves to a model that IS in the capability matrix catalog', FUNCS.every((f) => {
    const fn = functionFit.functions[f];
    return !fn.model || matrix.catalog.some((c) => c.id === fn.model);
  }));
  // 9a) function routing picks the configured model (real config, real agent) — code-draft/coding family
  const funcRouted = await P.chat({ func: 'test-sketch', prompt: 'hi', agent: 'build-boss' });
  t('chat(func:test-sketch, agent:build-boss) → resolves to the configured coding model', funcRouted.model === functionFit.functions['test-sketch'].model);
  t('chat(func:test-sketch, agent:build-boss) → stamped bulkOffload + codeGateRequired (coding-family function)', funcRouted.bulkOffload === true && funcRouted.codeGateRequired === true && funcRouted.func === 'test-sketch');
  const docRouted = await P.chat({ func: 'doc-draft', prompt: 'hi', agent: 'docs-boss' });
  t('chat(func:doc-draft, agent:docs-boss) → resolves to the configured doc-draft model, NO codeGateRequired (non-coding function)', docRouted.model === functionFit.functions['doc-draft'].model && docRouted.bulkOffload === true && docRouted.codeGateRequired === undefined);
  // 9b) unknown function → hard ERROR, never a silent default
  const unknownFunc = await P.chat({ func: 'not-a-real-function', prompt: 'hi', agent: 'build-boss' });
  t('chat(func:"not-a-real-function") → ERROR, no silent fallback model', !!unknownFunc.error && /unknown function/.test(unknownFunc.error) && unknownFunc.model === undefined);
  const unknownRoute = P.resolveFunction('not-a-real-function');
  t('resolveFunction(unknown) → error listing the real function keys', !!unknownRoute.error && /unknown function/.test(unknownRoute.error));
  // 9c) fit="none" (no good model) → HARD-SKIPPED like a policy block, never force-routed. Uses an
  // INJECTED fake fit-map (not real config) purely to exercise this branch deterministically — the real
  // function-model-fit.json currently has no fit="none" entry because no probed function came back
  // outright wrong (see its own honesty field); this proves the mechanism works for when one eventually does.
  const fakeNoFitMap = { functions: { 'bad-fit-fn': { model: null, fit: 'none' } } };
  const noFit = P.resolveFunction('bad-fit-fn', fakeNoFitMap);
  t('resolveFunction(fit:"none") → skip:true, not silently routed', noFit.skip === true && /NO fit NVIDIA model/.test(noFit.reason));
  // 9d) REGRESSION: claudeWinsSkipNvidia Bosses stay hard-blocked EVEN with --function passed (no function-based bypass)
  const skipStillBlocked1 = await P.chat({ func: 'code-draft', prompt: 'hi', agent: 'integration-boss' });
  t('chat(func:code-draft, agent:integration-boss) → STILL hard-blocked (claudeWinsSkipNvidia beats function-fit)', skipStillBlocked1.skipped === true && skipStillBlocked1.policy === 'claude-first-skip' && skipStillBlocked1.functionUnfit === undefined);
  const skipStillBlocked2 = await P.chat({ func: 'research-digest', prompt: 'hi', agent: 'boss' });
  t('chat(func:research-digest, agent:boss) → STILL hard-blocked', skipStillBlocked2.skipped === true && skipStillBlocked2.policy === 'claude-first-skip');
  // 9e) routeFor with --function shows the override + advisory mismatch warning
  const routedBuild = P.routeFor('build-boss', 'test-sketch');
  t('routeFor(build-boss, func:test-sketch) → model overridden to the function-fit pick, no mismatch warning (it IS in build-boss\'s allowed list)', routedBuild.model === functionFit.functions['test-sketch'].model && !routedBuild.warnings.some((w) => /not in agentAllowedFunctions/.test(w)));
  const routedMismatch = P.routeFor('docs-boss', 'test-sketch');
  t('routeFor(docs-boss, func:test-sketch) → resolves the model anyway, but WARNS test-sketch is not in docs-boss\'s allowed list', routedMismatch.model === functionFit.functions['test-sketch'].model && routedMismatch.warnings.some((w) => /not in agentAllowedFunctions/.test(w)));

  // 10) WP-NVIDIA-CONSOLIDATE (2026-07-26): cross-probe consolidation reassigned 3 functions + 1 role.
  // Regression-locks the consolidated picks so a future config edit can't silently drift them back.
  // wp19 (2026-09-24): nemotron-3-nano-30b-a3b answers HTTP 410 Gone — summarize/doc-draft/data-extract were re-pointed by same-task cross-probes.
  t('function-model-fit: summarize now resolves to nemotron-3-super (was nemotron-3-nano, now HTTP 410 Gone)',
    functionFit.functions['summarize'].model === 'nvidia/nemotron-3-super-120b-a12b' && functionFit.functions['summarize'].fit === 'correct');
  t('function-model-fit: doc-draft -> nemotron-3-super and data-extract -> glm-5.3 (2026-09-24 cross-probes); no function still points at the dead nano model',
    functionFit.functions['doc-draft'].model === 'nvidia/nemotron-3-super-120b-a12b' && functionFit.functions['data-extract'].model === 'z-ai/glm-5.3'
    && Object.values(functionFit.functions).every((f) => f.model !== 'nvidia/nemotron-3-nano-30b-a3b'));
  t('function-model-fit: research-digest now resolves to nemotron-3-super (was deepseek-v4-flash, correct-but-slower)',
    functionFit.functions['research-digest'].model === 'nvidia/nemotron-3-super-120b-a12b' && functionFit.functions['research-digest'].fit === 'correct');
  t('function-model-fit: translate-rewrite now resolves to nemotron-3-super, fit=correct (was mistral-small, fit=partial)',
    functionFit.functions['translate-rewrite'].model === 'nvidia/nemotron-3-super-120b-a12b' && functionFit.functions['translate-rewrite'].fit === 'correct');
  t('function-model-fit consolidation: exactly 2 distinct models now cover all 7 functions',
    new Set(Object.values(functionFit.functions).map((f) => f.model)).size === 2);
  // wp19 (2026-09-24): nemotron-3-nano-30b-a3b answers HTTP 410 Gone (end of life) — the default role moved again.
  t('model-capability-matrix: default role remapped to mistral-nemotron (was nemotron-3-nano, now HTTP 410 Gone)',
    P.modelForRole('default') === 'mistralai/mistral-nemotron');
  // wp19 regression lock: the live re-validated role map (every id answered a live chat probe on 2026-09-24).
  const WP19_ROLES = { default: 'mistralai/mistral-nemotron', fast: 'mistralai/mistral-nemotron', 'coding-fast': 'mistralai/mistral-nemotron',
    reasoning: 'nvidia/nemotron-3-super-120b-a12b', coding: 'nvidia/nemotron-3-super-120b-a12b', review: 'z-ai/glm-5.3', vision: 'meta/llama-3.2-11b-vision-instruct' };
  t('model-capability-matrix: all 7 role slots pinned to the 2026-09-24 live re-validated map',
    Object.entries(WP19_ROLES).every(([r, m]) => matrix.roles[r] && matrix.roles[r].model === m) && Object.keys(matrix.roles).length === 7);
  // REGRESSION: the claudeWinsSkipNvidia hard-block survives the role remap — a skip-listed agent must
  // still be hard-blocked on the (now-nano) default role, exactly as it was on the old minimax default.
  const skipStillBlockedAfterRemap = await P.chat({ role: 'default', prompt: 'hi', agent: 'boss' });
  t('chat(role:default, agent:boss) → STILL hard-blocked after the default-role remap to nano',
    skipStillBlockedAfterRemap.skipped === true && skipStillBlockedAfterRemap.policy === 'claude-first-skip');

  // 11) owner setting `nvidia` (forge-config.cjs, v2.7.0) — OFF refuses chat() before anything else
  console.log('11) owner setting nvidia (forge-config.cjs)');
  const writeCfg = (settings) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-cfg-'));
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    if (settings) fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings }));
    return root;
  };
  const OFF_ROOT = writeCfg({ nvidia: { value: false } });
  const ON_ROOT = writeCfg({ nvidia: { value: true } });
  const withRoot = async (root, fn) => { const prev = process.env.FORGE_PROJECT_ROOT; process.env.FORGE_PROJECT_ROOT = root; try { return await fn(); } finally { process.env.FORGE_PROJECT_ROOT = prev; } };
  const offOut = await withRoot(OFF_ROOT, () => P.chat({ role: 'coding', prompt: 'hi', agent: 'build-boss' }));
  t('nvidia=false → chat() returns exactly {skipped:true, reason:"owner config nvidia=off"}', JSON.stringify(offOut) === JSON.stringify({ skipped: true, reason: 'owner config nvidia=off' }));
  const offUnknown = await withRoot(OFF_ROOT, () => P.chat({ role: 'default', prompt: 'hi', agent: 'not-a-boss-typo' }));
  t('nvidia=false is the FIRST check: even an unknown agent is skipped, not errored (nothing else resolved)', offUnknown.skipped === true && offUnknown.error === undefined && offUnknown.reason === P.NVIDIA_OFF_REASON);
  const offForced = await withRoot(OFF_ROOT, () => P.chat({ role: 'default', prompt: 'hi', agent: 'boss', forceOverride: true, overrideReason: 'test' }));
  t('nvidia=false also beats a usagePolicy forceOverride (no NVIDIA call, no mock)', offForced.skipped === true && offForced.mock === undefined && offForced.policyOverridden === undefined);
  const onOut = await withRoot(ON_ROOT, () => P.chat({ role: 'coding', prompt: 'hi', agent: 'build-boss' }));
  t('nvidia=true → unchanged: the call proceeds (mock, stamped bulkOffload)', onOut.mock === true && onOut.bulkOffload === true && onOut.skipped === undefined);
  // M3 fail-safe (2026-09-24): an unreadable setting is OFF — never a silent fall-back to ON.
  const absentOut = await withRoot(ON_ROOT, () => P.chat({ role: 'default', prompt: 'hi' }, { configModule: null }));
  t('M3: config module absent (null) → OFF with the unreadable reason, even when the file says ON (no mock, no call)',
    absentOut.skipped === true && absentOut.reason === P.NVIDIA_UNREADABLE_REASON && absentOut.mock === undefined);
  const throwOut = await withRoot(ON_ROOT, () => P.chat({ role: 'default', prompt: 'hi' }, { configModule: { get() { throw new Error('boom'); } } }));
  t('M3: a throwing config module (malformed FORGE_CONFIG.json) → OFF: "config unreadable → safe default off"',
    throwOut.skipped === true && throwOut.reason === 'config unreadable → safe default off');
  t('M3: nvidiaState — wrong-typed value is OFF (unreadable), a real true is ON, a real false is OFF (owner reason)',
    P.nvidiaState({ configModule: { get: () => ({ value: 'uit' }) } }).on === false
    && P.nvidiaState({ configModule: { get: () => ({ value: true }) } }).on === true
    && P.nvidiaState({ configModule: { get: () => ({ value: false }) } }).reason === P.NVIDIA_OFF_REASON);
  const absentHealth = await P.health({ configModule: null });
  t('M3+M4: health() with the config module absent → {ok:false, mode:"off", reason: unreadable}',
    JSON.stringify(absentHealth) === JSON.stringify({ ok: false, mode: 'off', reason: P.NVIDIA_UNREADABLE_REASON }));
  t('configOn ignores a wrong-typed value and honours a real boolean',
    P.configOn('nvidia', true, { configModule: { get: () => ({ value: 'uit' }) } }) === true && P.configOn('nvidia', true, { configModule: { get: () => ({ value: false }) } }) === false);

  const CLI = path.join(__dirname, 'nvidia-provider.cjs');
  const cliEnv = (root) => { const e = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root, NVIDIA_SKIP_ENV_FILES: '1' }); delete e.NVIDIA_API_KEY; return e; };
  const cliChatOff = spawnSync(process.execPath, [CLI, 'chat', '--role', 'default', '--prompt', 'hi'], { encoding: 'utf8', env: cliEnv(OFF_ROOT) });
  t('CLI chat with nvidia=false → "SKIPPED (config) — owner config nvidia=off", exit 3', cliChatOff.status === 3 && /^SKIPPED \(config\) — owner config nvidia=off/.test(cliChatOff.stdout));
  const cliChatOn = spawnSync(process.execPath, [CLI, 'chat', '--role', 'default', '--prompt', 'hi'], { encoding: 'utf8', env: cliEnv(writeCfg(null)) });
  t('CLI chat with no settings file → unchanged mock answer, exit 0 (no key, no network)', cliChatOn.status === 0 && /^\[MOCK\]/.test(cliChatOn.stdout));
  // M4 (2026-09-24): OFF means health/models make NO request — one plain line, exit 3; --force runs them anyway.
  const OFF_LINE = 'NVIDIA OFF — owner config nvidia=off — no NVIDIA request made (check anyway: --force; turn it back on: /forge config set nvidia aan)';
  const cliHealthOff = spawnSync(process.execPath, [CLI, 'health', '--allow-mock'], { encoding: 'utf8', env: cliEnv(OFF_ROOT) });
  t('M4: CLI health with nvidia=false → exactly the one OFF line, exit 3, no MOCK/live output', cliHealthOff.status === 3 && cliHealthOff.stdout.trim() === OFF_LINE && cliHealthOff.stderr === '');
  const cliHealthOffForced = spawnSync(process.execPath, [CLI, 'health', '--allow-mock', '--force'], { encoding: 'utf8', env: cliEnv(OFF_ROOT) });
  t('M4: CLI health --force with nvidia=false runs the check anyway (mock here) and prints the off note', cliHealthOffForced.status === 0 && /MOCK MODE/.test(cliHealthOffForced.stdout) && /note: owner config nvidia=off — .*--force: this health contacts NVIDIA anyway/.test(cliHealthOffForced.stdout));
  const cliModelsOff = spawnSync(process.execPath, [CLI, 'models'], { encoding: 'utf8', env: cliEnv(OFF_ROOT) });
  t('M4: CLI models with nvidia=false → exactly the one OFF line, exit 3', cliModelsOff.status === 3 && cliModelsOff.stdout.trim() === OFF_LINE);
  const cliModelsOffForced = spawnSync(process.execPath, [CLI, 'models', '--force'], { encoding: 'utf8', env: cliEnv(OFF_ROOT) });
  t('M4: CLI models --force with nvidia=false lists (mock: the matrix) and prints the off note', cliModelsOffForced.status === 0 && /configured matrix models/.test(cliModelsOffForced.stdout) && /note: owner config nvidia=off/.test(cliModelsOffForced.stdout));
  const BROKEN_ROOT = writeCfg(null);
  fs.writeFileSync(path.join(BROKEN_ROOT, '.claude', 'FORGE_CONFIG.json'), '{ "version": 1, "settings": { "nvidia": ');
  const cliHealthBroken = spawnSync(process.execPath, [CLI, 'health'], { encoding: 'utf8', env: cliEnv(BROKEN_ROOT) });
  t('M3: CLI health with a malformed FORGE_CONFIG.json → "NVIDIA OFF — config unreadable → safe default off", exit 3', cliHealthBroken.status === 3 && /^NVIDIA OFF — config unreadable → safe default off — no NVIDIA request made/.test(cliHealthBroken.stdout));
  const cliChatBroken = spawnSync(process.execPath, [CLI, 'chat', '--role', 'default', '--prompt', 'hi'], { encoding: 'utf8', env: cliEnv(BROKEN_ROOT) });
  t('M3: CLI chat with a malformed FORGE_CONFIG.json → SKIPPED (config), exit 3', cliChatBroken.status === 3 && /^SKIPPED \(config\) — config unreadable → safe default off/.test(cliChatBroken.stdout));
  const cliRouteOff = spawnSync(process.execPath, [CLI, 'route', 'build-boss'], { encoding: 'utf8', env: cliEnv(OFF_ROOT) });
  let routeJson = null; try { routeJson = JSON.parse(cliRouteOff.stdout); } catch { routeJson = null; }
  t('CLI route with nvidia=false keeps stdout parseable JSON and puts the off note on stderr', cliRouteOff.status === 0 && !!routeJson && /note: owner config nvidia=off/.test(cliRouteOff.stderr));
  const cliHealthOn = spawnSync(process.execPath, [CLI, 'health', '--allow-mock'], { encoding: 'utf8', env: cliEnv(ON_ROOT) });
  t('CLI health with nvidia=true prints NO off note (unchanged output)', cliHealthOn.status === 0 && !/owner config nvidia=off/.test(cliHealthOn.stdout));

  // 12) fetch-spy probes: a child process installs a spy as global.fetch BEFORE requiring a provider, then reports
  // every request it saw. The spy answers 200 itself, so nothing ever reaches a network.
  console.log('12) M4/M5 fetch-spy probes (no network)');
  const FAKE_KEY = 'nvapi-FAKEwp20probeKEY0123456789';
  const probe = (providerPath, env) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-probe-'));
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, [
      "'use strict';",
      'const calls = [];',
      'global.fetch = async (url, init) => { const h = (init && init.headers) || {};',
      '  calls.push({ url: String(url), keyInAuth: String(h.authorization || "").includes(' + JSON.stringify(FAKE_KEY) + ') });',
      '  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{ id: "m1" }] }) }; };',
      'const P = require(' + JSON.stringify(providerPath) + ');',
      '(async () => {',
      '  const out = {};',
      '  out.health = await P.health(); out.healthCalls = calls.length;',
      '  out.list = await P.listModels(); out.listCalls = calls.length;',
      '  out.forced = await P.health({ force: true }); out.forcedCalls = calls.length;',
      '  const E = process.env;',
      '  out.env = { base: E.NVIDIA_BASE_URL || null, allow: E.NVIDIA_ALLOW_CUSTOM_BASE_URL || null, nodeOptions: E.NODE_OPTIONS || null,',
      '    other: E.WP20_OTHER_SECRET || null, fastModel: E.NVIDIA_FAST_MODEL || null, hasKey: !!E.NVIDIA_API_KEY };',
      '  out.config = { baseUrl: P.CONFIG.baseUrl, baseUrlError: P.CONFIG.baseUrlError };',
      '  out.calls = calls;',
      '  process.stdout.write(JSON.stringify(out));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ].join('\n'), 'utf8');
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { return JSON.parse(r.stdout); } catch { return { parseError: (r.stdout || '') + (r.stderr || '') }; }
  };
  const baseEnv = (extra) => {
    const e = Object.assign({}, process.env, extra);
    for (const k of Object.keys(e)) if (/^NVIDIA_/.test(k) && !(k in (extra || {}))) delete e[k];
    delete e.NODE_OPTIONS; delete e.WP20_OTHER_SECRET;
    return e;
  };
  // M4: the REAL provider + the real forge-config, with a key present — so ON really calls fetch (the control arm).
  const realEnv = (root) => baseEnv({ NVIDIA_API_KEY: FAKE_KEY, NVIDIA_SKIP_ENV_FILES: '1', FORGE_PROJECT_ROOT: root, FORGE_CONFIG_HOME: CONFIG_HOME });
  const offProbe = probe(CLI, realEnv(OFF_ROOT));
  t('M4 spy: nvidia=false + a key → health() is {ok:false, mode:"off", reason} with ZERO fetch calls',
    !!offProbe.health && JSON.stringify(offProbe.health) === JSON.stringify({ ok: false, mode: 'off', reason: P.NVIDIA_OFF_REASON }) && offProbe.healthCalls === 0);
  t('M4 spy: nvidia=false + a key → listModels() is off with ZERO fetch calls', !!offProbe.list && offProbe.list.mode === 'off' && offProbe.list.ok === false && offProbe.listCalls === 0);
  t('M4 spy: health({force:true}) with nvidia=false does contact the endpoint (force really overrides)', !!offProbe.forced && offProbe.forced.ok === true && offProbe.forcedCalls >= 1);
  const onProbe = probe(CLI, realEnv(ON_ROOT));
  t('M4 spy control: nvidia=true + a key → health() really calls fetch (the spy sees live-shaped calls)', !!onProbe.health && onProbe.health.ok === true && onProbe.healthCalls >= 1 && onProbe.calls.every((c) => c.keyInAuth));

  // M5: a COPY of the provider in a temp project, so a project .env and a global nvidia.env can be staged for real.
  // The copy has no forge-config.cjs next to it (switch = unreadable = OFF), so the assertions use health({force}).
  const m5 = (files, extra) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-m5-'));
    const bin = path.join(root, 'proj', '.claude', 'forge-bin');
    const home = path.join(root, 'home');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.copyFileSync(CLI, path.join(bin, 'nvidia-provider.cjs'));
    if (files.project) fs.writeFileSync(path.join(root, 'proj', '.env'), files.project);
    if (files.global) fs.writeFileSync(path.join(home, '.claude', 'nvidia.env'), files.global);
    const out = probe(path.join(bin, 'nvidia-provider.cjs'), baseEnv(Object.assign({ HOME: home, USERPROFILE: home, FORGE_CONFIG_HOME: path.join(home, '.claude'), FORGE_PROJECT_ROOT: path.join(root, 'proj') }, extra || {})));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    return out;
  };
  const globalKey = 'NVIDIA_API_KEY=' + FAKE_KEY + '\n';
  const k1 = m5({ project: 'NVIDIA_BASE_URL=https://evil.example/v1\nNVIDIA_ALLOW_CUSTOM_BASE_URL=1\nNODE_OPTIONS=--inspect\nWP20_OTHER_SECRET=x\nNVIDIA_FAST_MODEL=proj/model\n', global: globalKey });
  t('M5: a project .env base URL + allow flag is IGNORED — the global key only ever goes to integrate.api.nvidia.com',
    !!k1.forced && k1.forced.ok === true && k1.calls.length >= 1 && k1.calls.every((c) => c.url.startsWith('https://integrate.api.nvidia.com/v1/') && c.keyInAuth) && !k1.calls.some((c) => /evil\.example/.test(c.url)));
  t('M5: a project .env can set only NVIDIA_API_KEY / NVIDIA_*_MODEL (base URL, allow flag, NODE_OPTIONS, other names never reach process.env)',
    !!k1.env && k1.env.base === null && k1.env.allow === null && k1.env.nodeOptions === null && k1.env.other === null && k1.env.fastModel === 'proj/model' && k1.env.hasKey === true);
  const k2 = m5({ global: globalKey + 'NVIDIA_BASE_URL=http://127.0.0.1:9/v1\n' });
  t('M5: a plain-http base URL (even from the global file) is REFUSED with a plain reason and ZERO requests',
    !!k2.forced && k2.forced.ok === false && k2.forced.mode === 'refused' && /must use https:/.test(k2.forced.reason) && k2.calls.length === 0 && k2.config.baseUrl === '');
  const k3 = m5({ global: globalKey + 'NVIDIA_BASE_URL=https://evil.example/v1\n' });
  t('M5: an https base URL on a non-nvidia.com host is REFUSED with ZERO requests', !!k3.forced && k3.forced.mode === 'refused' && /not on the fixed allow-list/.test(k3.forced.reason) && k3.calls.length === 0);
  // NVIDIA-ENV-TRUST (2026-09-24): an env FILE (global or project) can no longer authorise its own
  // custom base URL — NVIDIA_ALLOW_CUSTOM_BASE_URL only ever counts from the REAL process environment
  // (see ENV_FILE_GLOBAL_ONLY in nvidia-provider.cjs). This test used to assert the GLOBAL file's allow
  // flag was honoured; it now asserts the opposite — a hostile/mistaken global file can no longer both
  // name an attacker endpoint AND flip the flag that used to stop that endpoint being checked.
  const k4 = m5({ global: globalKey + 'NVIDIA_BASE_URL=http://127.0.0.1:9/v1\nNVIDIA_ALLOW_CUSTOM_BASE_URL=1\n' });
  t('NVIDIA-ENV-TRUST: a GLOBAL file allow flag no longer authorises anything — a plain-http custom endpoint from a file stays REFUSED, ZERO requests',
    !!k4.forced && k4.forced.ok === false && k4.forced.mode === 'refused' && /must use https:/.test(k4.forced.reason) && k4.calls.length === 0);
  const k5 = m5({ project: 'NVIDIA_ALLOW_CUSTOM_BASE_URL=1\n', global: globalKey }, { NVIDIA_BASE_URL: 'http://127.0.0.1:9/v1' });
  t('M5: an allow flag in the PROJECT .env does not count — a real-env http base URL stays refused, ZERO requests', !!k5.forced && k5.forced.mode === 'refused' && k5.calls.length === 0);
  const k6 = m5({ global: globalKey }, { NVIDIA_BASE_URL: 'http://127.0.0.1:9/v1', NVIDIA_ALLOW_CUSTOM_BASE_URL: '1' });
  t('M5: the allow flag from the REAL environment permits a custom endpoint', !!k6.forced && k6.forced.ok === true && k6.calls.every((c) => c.url.startsWith('http://127.0.0.1:9/v1/')));
  // NVIDIA-ENV-TRUST: the fixed allow-list is a SINGLE host (integrate.api.nvidia.com) — a different,
  // even genuinely-nvidia.com-suffixed host is no longer accepted just because a global file named it
  // and no allow flag was needed under the old "any *.nvidia.com" rule.
  const k7 = m5({ global: globalKey + 'NVIDIA_BASE_URL=https://custom.api.nvidia.com/v1/\n' });
  t('NVIDIA-ENV-TRUST: an https host OTHER than the fixed allow-list entry is REFUSED even from the global file, ZERO requests',
    !!k7.forced && k7.forced.ok === false && k7.forced.mode === 'refused' && /not on the fixed allow-list/.test(k7.forced.reason) && k7.calls.length === 0);
  const cb = P.checkBaseUrl;
  t('checkBaseUrl: default ok; http, foreign host, look-alike hosts, ports and junk refused (fixed allow-list)',
    cb('https://integrate.api.nvidia.com/v1', false).ok === true && cb('http://integrate.api.nvidia.com/v1', false).ok === false
    && cb('https://evilnvidia.com/v1', false).ok === false && cb('https://nvidia.com.evil.io/v1', false).ok === false
    && cb('https://integrate.api.nvidia.com.evil.io/v1', false).ok === false && cb('not a url', false).ok === false
    && cb('https://integrate.api.nvidia.com:8443/v1', false).ok === false
    && cb('https://integrate.api.nvidia.com/v1/../v2', false).ok === false
    && cb('https://custom.api.nvidia.com/v1', false).ok === false
    && cb('http://127.0.0.1:9/v1', true).ok === true && cb('https://integrate.api.nvidia.com/v1/', false).url === 'https://integrate.api.nvidia.com/v1');
  t('checkBaseUrl: userinfo/query/fragment are refused REGARDLESS of allowCustom (NVIDIA-URL-LEAK)',
    cb('https://integrate.api.nvidia.com/v1?api_key=SYNTHETICKEY', false).ok === false
    && cb('https://user:pass@integrate.api.nvidia.com/v1', false).ok === false
    && cb('https://integrate.api.nvidia.com/v1#frag', false).ok === false
    && cb('https://user:pass@127.0.0.1:9/v1', true).ok === false
    && cb('http://127.0.0.1:9/v1?leak=1', true).ok === false);
  t('checkBaseUrl: no rejection reason ever echoes the raw untrusted input verbatim',
    !/SYNTHETICKEY|user:pass|evil\.example/.test([
      cb('https://integrate.api.nvidia.com/v1?api_key=SYNTHETICKEY', false).reason,
      cb('https://user:pass@integrate.api.nvidia.com/v1', false).reason,
      cb('https://evil.example/v1', false).reason,
    ].join(' | ')));

  // 13) NVIDIA-RETRY-OFF (2026-09-24): the owner switch is rechecked immediately before EVERY retry
  // attempt, and the backoff wait itself is cancellable — a mid-loop switch-off must stop the NEXT
  // attempt from ever firing, not merely be noticed afterwards.
  console.log('13) NVIDIA-RETRY-OFF (no network)');
  const retryOffProbe = (cfgDir) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-retryoff-'));
    const script = path.join(dir, 'probe.cjs');
    const cfgFile = path.join(cfgDir, 'FORGE_CONFIG.json');
    fs.writeFileSync(script, [
      "'use strict';",
      'const fs = require("fs");',
      'const cfgFile = ' + JSON.stringify(cfgFile) + ';',
      'let calls = 0;',
      'global.fetch = async () => {',
      '  calls++;',
      '  if (calls === 1) {',
      '    fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, settings: { nvidia: { value: false } } }));',
      '    return { ok: false, status: 503, headers: { get: (k) => (k === "retry-after" ? "1" : null) }, text: async () => "busy" };',
      '  }',
      '  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: "SHOULD NOT HAPPEN" } }] }) };',
      '};',
      'const P = require(' + JSON.stringify(CLI) + ');',
      '(async () => {',
      '  const out = await P.chat({ role: "default", prompt: "hi" });',
      '  process.stdout.write(JSON.stringify({ out, calls }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ].join('\n'), 'utf8');
    const env = baseEnv({ NVIDIA_API_KEY: FAKE_KEY, NVIDIA_SKIP_ENV_FILES: '1', FORGE_PROJECT_ROOT: EMPTY_PROJECT, FORGE_CONFIG_HOME: cfgDir });
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { return JSON.parse(r.stdout); } catch { return { parseError: (r.stdout || '') + (r.stderr || '') }; }
  };
  const retryCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-retryoff-cfg-'));
  fs.writeFileSync(path.join(retryCfgDir, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { nvidia: { value: true } } }));
  const retryOff = retryOffProbe(retryCfgDir);
  t('NVIDIA-RETRY-OFF: switching nvidia off during a 503 backoff prevents the next attempt (exactly 1 fetch call, never the "SHOULD NOT HAPPEN" content)',
    !!retryOff.out && retryOff.calls === 1 && !/SHOULD NOT HAPPEN/.test(JSON.stringify(retryOff.out))
    && /switched off mid-retry/.test(retryOff.out.error || ''));
  try { fs.rmSync(retryCfgDir, { recursive: true, force: true }); } catch { /* best effort */ }

  // 14) NVIDIA-REDACTION-GAPS (2026-09-24): mask() must run on the FULL text BEFORE truncation — the
  // previous `mask(text.slice(0, 300))` could cut a non-"nvapi-"-shaped secret exactly at the 300-char
  // boundary, leaving its visible prefix (which no longer matches the FULL literal CONFIG.key) unmasked.
  console.log('14) NVIDIA-REDACTION-GAPS: mask-before-truncate (no network)');
  const redactOrderProbe = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-redact-'));
    const script = path.join(dir, 'probe.cjs');
    const secretKey = 'SYNTHETIC-NONNVAPI-KEY-1234567890ABCDEF'; // deliberately NOT nvapi-prefixed (regex-only masking would miss the truncated fragment too)
    const body = 'x'.repeat(280) + secretKey + 'y'.repeat(50); // the key straddles the old 300-char cut point
    fs.writeFileSync(script, [
      "'use strict';",
      'process.env.NVIDIA_API_KEY = ' + JSON.stringify(secretKey) + ';',
      'global.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => ' + JSON.stringify(body) + ' });',
      'const P = require(' + JSON.stringify(CLI) + ');',
      '(async () => {',
      '  const h = await P.health({ force: true });',
      '  process.stdout.write(JSON.stringify({ reason: h.reason }));',
      '})();',
    ].join('\n'), 'utf8');
    const env = baseEnv({ NVIDIA_SKIP_ENV_FILES: '1', FORGE_PROJECT_ROOT: EMPTY_PROJECT, FORGE_CONFIG_HOME: CONFIG_HOME });
    delete env.NVIDIA_API_KEY;
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { return JSON.parse(r.stdout); } catch { return { parseError: (r.stdout || '') + (r.stderr || '') }; }
  };
  const redactOrder = redactOrderProbe();
  t('NVIDIA-REDACTION-GAPS: a secret straddling the old 300-char cut is FULLY masked, not partially leaked',
    !!redactOrder.reason && !/SYNTHETIC-NONNVAPI-KEY/.test(redactOrder.reason) && /\*\*\*MASKED\*\*\*/.test(redactOrder.reason));

  // 15) NVIDIA-REDACTION-GAPS: maskDeep() sanitizes the WHOLE returned shape at every public boundary —
  // a synthetic key placed in `content`, nested `usage`, a model-name env override, or a route warning
  // must never leave the module unmasked.
  console.log('15) maskDeep at every public return (no network)');
  const maskDeepProbe = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-maskdeep-'));
    const script = path.join(dir, 'probe.cjs');
    const leaked = 'nvapi-LEAKEDCONTENTKEY1234567890';
    fs.writeFileSync(script, [
      "'use strict';",
      'process.env.NVIDIA_API_KEY = "nvapi-REALKEYNOTUSEDHERE1234567890";',
      'global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({',
      '  choices: [{ message: { content: "leaked in content: " + ' + JSON.stringify(leaked) + ' }, finish_reason: "stop" }],',
      '  usage: { note: ' + JSON.stringify(leaked) + ', prompt_tokens: 3 },',
      '}) });',
      'const P = require(' + JSON.stringify(CLI) + ');',
      '(async () => {',
      '  const out = await P.chat({ role: "default", prompt: "hi" });',
      '  process.stdout.write(JSON.stringify({ out }));',
      '})();',
    ].join('\n'), 'utf8');
    const env = baseEnv({ NVIDIA_SKIP_ENV_FILES: '1', FORGE_PROJECT_ROOT: EMPTY_PROJECT, FORGE_CONFIG_HOME: CONFIG_HOME });
    delete env.NVIDIA_API_KEY;
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { return JSON.parse(r.stdout); } catch { return { parseError: (r.stdout || '') + (r.stderr || '') }; }
  };
  const maskDeepOut = maskDeepProbe();
  t('maskDeep: a synthetic key nested inside chat() content AND a nested usage object is masked in BOTH places',
    !!maskDeepOut.out && !/LEAKEDCONTENTKEY/.test(JSON.stringify(maskDeepOut.out)) && /\*\*\*MASKED\*\*\*/.test(maskDeepOut.out.content || '') && /\*\*\*MASKED\*\*\*/.test((maskDeepOut.out.usage && maskDeepOut.out.usage.note) || ''));
  const maskDeepUnit = P.maskDeep({ a: 'contains nvapi-UNITTESTKEY1234567890 here', b: [1, 'nvapi-UNITTESTKEY1234567890', null], c: { d: true, e: 'nvapi-UNITTESTKEY1234567890' }, f: 42, g: null, h: undefined });
  t('maskDeep(): nested objects/arrays are walked, non-strings pass through untouched',
    !JSON.stringify(maskDeepUnit).includes('UNITTESTKEY') && maskDeepUnit.f === 42 && maskDeepUnit.g === null && maskDeepUnit.h === undefined && maskDeepUnit.c.d === true);
  const maskDeepKeyUnit = P.maskDeep({ 'nvapi-KEYSHAPEDPROPERTYNAME1234567890': 'value', normal: 'ok' });
  t('maskDeep(): a key-shaped OBJECT KEY is masked too, not just values (V16, Codex recheck wp-f4)',
    !JSON.stringify(maskDeepKeyUnit).includes('KEYSHAPEDPROPERTYNAME') && maskDeepKeyUnit.normal === 'ok');

  // 16) V17 (Codex recheck wp-f4, 2026-09-24): health() must preserve the CALLER's own authorization when
  // delegating to listModels() internally — hardcoding {force:true} defeated NVIDIA-RETRY-OFF's own
  // per-attempt off-check for every health() call, so a switch-off during a 503 backoff kept retrying.
  console.log('16) V17: health() honors a switch-off mid-retry (no force delegation bypass)');
  const healthRetryOffProbe = (cfgDir) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-healthretryoff-'));
    const script = path.join(dir, 'probe.cjs');
    const cfgFile = path.join(cfgDir, 'FORGE_CONFIG.json');
    fs.writeFileSync(script, [
      "'use strict';",
      'const fs = require("fs");',
      'const cfgFile = ' + JSON.stringify(cfgFile) + ';',
      'let calls = 0;',
      'global.fetch = async () => {',
      '  calls++;',
      '  if (calls === 1) {',
      '    fs.writeFileSync(cfgFile, JSON.stringify({ version: 1, settings: { nvidia: { value: false } } }));',
      '    return { ok: false, status: 503, headers: { get: (k) => (k === "retry-after" ? "1" : null) }, text: async () => "busy" };',
      '  }',
      '  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{ id: "SHOULD-NOT-BE-REACHED" }] }) };',
      '};',
      'const P = require(' + JSON.stringify(CLI) + ');',
      '(async () => {',
      '  const out = await P.health({});',
      '  process.stdout.write(JSON.stringify({ out, calls }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ].join('\n'), 'utf8');
    const env = baseEnv({ NVIDIA_API_KEY: FAKE_KEY, NVIDIA_SKIP_ENV_FILES: '1', FORGE_PROJECT_ROOT: EMPTY_PROJECT, FORGE_CONFIG_HOME: cfgDir });
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { return JSON.parse(r.stdout); } catch { return { parseError: (r.stdout || '') + (r.stderr || '') }; }
  };
  const healthRetryCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-healthretryoff-cfg-'));
  fs.writeFileSync(path.join(healthRetryCfgDir, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { nvidia: { value: true } } }));
  const healthRetryOff = healthRetryOffProbe(healthRetryCfgDir);
  t('V17: health() switching nvidia off during a 503 backoff prevents the next attempt (exactly 1 fetch call, never reaches the live "SHOULD-NOT-BE-REACHED" response)',
    !!healthRetryOff.out && healthRetryOff.calls === 1 && !/SHOULD-NOT-BE-REACHED/.test(JSON.stringify(healthRetryOff.out))
    && /switched off mid-retry/.test(healthRetryOff.out.reason || ''));
  try { fs.rmSync(healthRetryCfgDir, { recursive: true, force: true }); } catch { /* best effort */ }

  // 17) V16 canary (Codex recheck wp-f4, 2026-09-24): a synthetic key-shaped string planted in EVERY
  // env/config slot Codex named (including NVIDIA_CODING_MODEL) must never appear in any return value or
  // stdout/stderr line — including the CLI `models --verify` branch, which used to print modelForRole()'s
  // RAW resolved value directly (nvidia-provider.cjs's own modelForRole export and its --verify CLI loop).
  console.log('17) V16 canary: a leaked-key-shaped model override never reaches any public surface');
  const CANARY_V16 = 'nvapi-V16CANARYLEAKEDMODELNAME1234567890';
  process.env.NVIDIA_CODING_MODEL = CANARY_V16;
  t('V16: modelForRole() (the PUBLIC export) masks a leaked-key-shaped env override',
    !/V16CANARYLEAKEDMODELNAME/.test(String(P.modelForRole('coding'))) && /\*\*\*MASKED\*\*\*/.test(String(P.modelForRole('coding'))));
  t('V16: routeFor() masks a leaked-key-shaped coding-model env override', !/V16CANARYLEAKEDMODELNAME/.test(JSON.stringify(P.routeFor('build-boss'))));
  {
    const chatCanaryOut = await P.chat({ role: 'coding', prompt: 'hi', agent: 'build-boss' }); // mock mode — the model id comes straight from the env override
    t('V16: chat() masks a leaked-key-shaped model id in its own return (mock mode)', !/V16CANARYLEAKEDMODELNAME/.test(JSON.stringify(chatCanaryOut)));
  }
  delete process.env.NVIDIA_CODING_MODEL;
  // CLI `models --verify`: a real key + a fetch stub (preloaded via NODE_OPTIONS) so the LIVE branch is
  // reached (the --verify loop is unreachable in mock mode), with the same canary planted for the child.
  const verifyStubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvidia-verifystub-'));
  const verifyStubFile = path.join(verifyStubDir, 'stub.cjs');
  fs.writeFileSync(verifyStubFile, [
    "'use strict';",
    'global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [',
    '  { id: "mistralai/mistral-nemotron" }, { id: "nvidia/nemotron-3-super-120b-a12b" }, { id: "z-ai/glm-5.3" }, { id: "meta/llama-3.2-11b-vision-instruct" },',
    '] }) });',
  ].join('\n'), 'utf8');
  const verifyEnv = Object.assign({}, process.env, {
    NVIDIA_API_KEY: FAKE_KEY, NVIDIA_SKIP_ENV_FILES: '1', NVIDIA_CODING_MODEL: CANARY_V16,
    NODE_OPTIONS: ((process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '') + '--require ' + verifyStubFile),
  });
  const verifyOut = spawnSync(process.execPath, [CLI, 'models', '--verify'], { encoding: 'utf8', env: verifyEnv, timeout: 30000 });
  try { fs.rmSync(verifyStubDir, { recursive: true, force: true }); } catch { /* best effort */ }
  t('V16 canary: CLI `models --verify` never prints the leaked-key-shaped NVIDIA_CODING_MODEL override in stdout/stderr',
    !/V16CANARYLEAKEDMODELNAME/.test((verifyOut.stdout || '') + (verifyOut.stderr || '')) && /\*\*\*MASKED\*\*\*/.test(verifyOut.stdout || ''));

  for (const d of [CONFIG_HOME, EMPTY_PROJECT, OFF_ROOT, ON_ROOT, BROKEN_ROOT]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
