#!/usr/bin/env node
'use strict';
/** Offline tests for nvidia-provider.cjs — run WITHOUT network: mock mode, key masking,
 *  routing validation, registry/matrix JSON validity. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');

// force mock mode BEFORE requiring the adapter (no key may leak in from env/.env for this test)
delete process.env.NVIDIA_API_KEY;
process.env.NVIDIA_API_KEY = ''; // loader skips empty; CONFIG.key stays ''
const P = require('./nvidia-provider.cjs');

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
  t('chat(func:doc-draft, agent:docs-boss) → resolves to the fast/nano model, NO codeGateRequired (non-coding function)', docRouted.model === functionFit.functions['doc-draft'].model && docRouted.bulkOffload === true && docRouted.codeGateRequired === undefined);
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
  t('function-model-fit: summarize now resolves to nemotron-3-nano (was minimax-m3, correct-but-slow)',
    functionFit.functions['summarize'].model === 'nvidia/nemotron-3-nano-30b-a3b' && functionFit.functions['summarize'].fit === 'correct');
  t('function-model-fit: research-digest now resolves to nemotron-3-super (was deepseek-v4-flash, correct-but-slower)',
    functionFit.functions['research-digest'].model === 'nvidia/nemotron-3-super-120b-a12b' && functionFit.functions['research-digest'].fit === 'correct');
  t('function-model-fit: translate-rewrite now resolves to nemotron-3-super, fit=correct (was mistral-small, fit=partial)',
    functionFit.functions['translate-rewrite'].model === 'nvidia/nemotron-3-super-120b-a12b' && functionFit.functions['translate-rewrite'].fit === 'correct');
  t('function-model-fit consolidation: exactly 2 distinct models now cover all 7 functions',
    new Set(Object.values(functionFit.functions).map((f) => f.model)).size === 2);
  t('model-capability-matrix: default role remapped to nemotron-3-nano (was minimax-m3)',
    P.modelForRole('default') === 'nvidia/nemotron-3-nano-30b-a3b');
  // REGRESSION: the claudeWinsSkipNvidia hard-block survives the role remap — a skip-listed agent must
  // still be hard-blocked on the (now-nano) default role, exactly as it was on the old minimax default.
  const skipStillBlockedAfterRemap = await P.chat({ role: 'default', prompt: 'hi', agent: 'boss' });
  t('chat(role:default, agent:boss) → STILL hard-blocked after the default-role remap to nano',
    skipStillBlockedAfterRemap.skipped === true && skipStillBlockedAfterRemap.policy === 'claude-first-skip');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
