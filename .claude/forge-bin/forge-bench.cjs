#!/usr/bin/env node
'use strict';
/**
 * forge-bench.cjs — FORGEBENCH capability scoreboard (2026-07-11, NEXT tier). Aggregates cross-cutting
 * capability checks over the REAL Forge modules (honesty gate, MCP server, OTel export, resume projector,
 * tamper-evident chain, rebind guard) into a SINGLE tracked score, and gates template releases on
 * regression vs a stored baseline. Distinct from unit tests (per-file pass/fail): this is one number that
 * must not go down. Contamination-proof — cases run the shipped code, not a reimplementation.
 *
 * Usage:
 *   node forge-bench.cjs               # run, print score
 *   node forge-bench.cjs --json        # machine-readable
 *   node forge-bench.cjs --baseline    # write current score as the baseline (USER_BASELINE — see below)
 *   node forge-bench.cjs --gate        # exit 1 if score regressed below baseline (use before forge-sync)
 *
 * BASELINE SPLIT (2026-09-26, external audit N4/Part V-G): `--baseline` used to overwrite BASELINE itself —
 * a file forge-sync.cjs ships/syncs as SHIPPED product state (config/forge-bench/baseline.json is in its
 * SYSTEM list). That meant running `--baseline` on ANY project silently rewrote a file the next template
 * sync would then either clobber again or diff against as "drifted", neither of which is what a project
 * regenerating ITS OWN regression baseline wants. Fix: `--baseline` now writes to USER_BASELINE
 * (config/forge-bench/baseline.user.json) — never in forge-sync.cjs's SYSTEM/SYSTEM_GLOB list, never
 * shipped, never overwritten/deleted by a template sync. readBaseline() prefers USER_BASELINE when present
 * and falls back to the shipped BASELINE otherwise, so `--gate` keeps working unchanged for a project that
 * has never run `--baseline` itself.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const BASELINE = path.join(PROJECT_ROOT, '.claude', 'config', 'forge-bench', 'baseline.json');
// USER_BASELINE — project-local, never shipped/synced. See the file header's BASELINE SPLIT note.
const USER_BASELINE = path.join(PROJECT_ROOT, '.claude', 'config', 'forge-bench', 'baseline.user.json');

const otel = require('./forge-otel.cjs');
const mcp = require('./forge-mcp.cjs');
const { projectRunState } = require('./forge-run-state.cjs');
const doctor = require('./forge-doctor.cjs');

// Each case exercises a shipped capability end-to-end and returns true on healthy behavior.
const CASES = [
  { id: 'honesty.canonical-name', cap: 'honesty', fn: () => { const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), 'bench-canon-' + process.pid, 'agent_progress', JSON.stringify({ agent: 'build-boss', note: 'b' })], { encoding: 'utf8' }); const f = path.join(PROJECT_ROOT, '.claude', 'forge-runs', 'bench-canon-' + process.pid, 'events.jsonl'); let ok = false; try { const last = fs.readFileSync(f, 'utf8').trim().split('\n').pop(); ok = JSON.parse(last).agent === 'Build Boss'; } catch {} try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch {} return ok; } },
  { id: 'honesty.reject-fake-pass', cap: 'honesty', fn: () => { const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), 'bench-fake-' + process.pid, 'check_passed', JSON.stringify({ agent: 'Build Boss', command: 'x', output: 'y', exit_code: 1 })], { encoding: 'utf8' }); try { fs.rmSync(path.join(PROJECT_ROOT, '.claude', 'forge-runs', 'bench-fake-' + process.pid), { recursive: true, force: true }); } catch {} return r.status === 2; } },
  { id: 'chain.tamper-evident', cap: 'integrity', fn: () => { const rep = doctor.chainCheck(PROJECT_ROOT); return rep && rep.ok === true; } },
  { id: 'security.rebind-guard', cap: 'security', fn: () => { const rep = doctor.rebindingGuard(PROJECT_ROOT); return rep && rep.ok === true; } },
  { id: 'mcp.tool-surface', cap: 'interop', fn: () => mcp.TOOLS.length === 4 } ,
  { id: 'mcp.reject-traversal', cap: 'interop', fn: () => { try { mcp.callTool('forge_get_run', { run_id: '../x' }); return false; } catch { return true; } } },
  { id: 'mcp.no-dangling-resources', cap: 'interop', fn: () => { const res = mcp.listResources(); return res.every((r) => { try { return typeof mcp.readResource(r.uri).text === 'string'; } catch { return false; } }); } },
  { id: 'otel.exact-nanos', cap: 'interop', fn: () => otel.nanos(1780000000000) === '1780000000000000000' } ,
  { id: 'otel.otlp-shape', cap: 'interop', fn: () => { const o = otel.toOtlp('bench', [{ agent: 'A', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:00Z' }, { agent: 'A', event_type: 'subagent_completed', timestamp: '2026-07-11T00:00:01Z' }]); return o.resourceSpans[0].scopeSpans[0].spans.length === 2; } },
  { id: 'resume.unfinished-detect', cap: 'durability', fn: () => { const st = projectRunState('b', [{ agent: 'A', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:00Z' }]); return st.resume.includes('A') && st.resumable === true; } },
  // Self-learning loop (2026-07-12): forge-distill must enforce CLAIM=PROOF (an event without a
  // timestamp/evidence is REFUSED, an evidenced one becomes a lesson carrying the run_id) and
  // forge-stats must stay a read-only projector (STATS.json written, events.jsonl byte-untouched).
  { id: 'learning.distill-evidence-required', cap: 'learning', fn: () => { const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-distill-')); try { const cd = path.join(tmp, '.claude'); fs.mkdirSync(path.join(cd, 'config', 'agents'), { recursive: true }); fs.mkdirSync(path.join(cd, 'forge-runs', 'bench-run'), { recursive: true }); fs.writeFileSync(path.join(cd, 'config', 'agents', 'agent-registry.json'), JSON.stringify({ agents: { 'build-boss': { name: 'Build Boss' } } })); fs.writeFileSync(path.join(cd, 'forge-runs', 'bench-run', 'events.jsonl'), JSON.stringify({ event_type: 'check_failed', agent: 'build-boss', task: 't', reason: 'r', timestamp: '2026-07-12T00:00:00Z' }) + '\n' + JSON.stringify({ event_type: 'check_failed', agent: 'build-boss', task: 't2', reason: 'r2' }) + '\n'); const d = require('./forge-distill.cjs'); const s = d.distillRun('bench-run', { max: 3, dryRun: false, root: tmp }); let ok = s.written === 1 && s.refused === 1; try { ok = ok && fs.readFileSync(path.join(cd, 'agent-memory', 'build-boss', 'lessons.jsonl'), 'utf8').includes('bench-run'); } catch { ok = false; } return ok; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  // Eval-refine + owner-reflect (2026-07-12b): forge-evals must be deterministic (same input → same
  // score, twice) and forge-reflect must refuse an owner-correction lesson without the verbatim quote.
  { id: 'learning.evals-deterministic', cap: 'learning', fn: () => { const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-evals-')); try { const ev = path.join(tmp, 'evals.json'); const out = path.join(tmp, 'out.txt'); fs.writeFileSync(ev, JSON.stringify({ skill: 'bench', tests: [{ id: 't1', prompt: 'p', expected: 'e', assertions: [{ type: 'max_words', n: 5 }, { type: 'forbidden_pattern', regex: 'FORBIDDEN' }] }] })); fs.writeFileSync(out, 'three ok words'); const run = () => require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-evals.cjs'), 'check', ev, '--test', 't1', '--output', out, '--json'], { encoding: 'utf8' }); const a = run(), b = run(); return a.status === 0 && a.stdout === b.stdout && a.stdout.includes('"passed"'); } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  { id: 'learning.reflect-evidence-required', cap: 'learning', fn: () => { const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-reflect-')); try { const cd = path.join(tmp, '.claude'); fs.mkdirSync(path.join(cd, 'config', 'agents'), { recursive: true }); fs.writeFileSync(path.join(cd, 'config', 'agents', 'agent-registry.json'), JSON.stringify({ agents: { 'build-boss': { name: 'Build Boss' } } })); const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: tmp }); const noQuote = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-reflect.cjs'), 'add', 'build-boss', '--text', 'lesson'], { encoding: 'utf8', env }); const withQuote = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-reflect.cjs'), 'add', 'build-boss', '--text', 'lesson', '--quote', 'owner said so'], { encoding: 'utf8', env }); let ok = noQuote.status === 2 && withQuote.status === 0; try { ok = ok && fs.readFileSync(path.join(cd, 'agent-memory', 'build-boss', 'lessons.jsonl'), 'utf8').includes('owner-correction'); } catch { ok = false; } return ok; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  // A/B baseline gate (2026-07-13, video-research verified): forge-evals `compare` must gate promotion on
  // evidence — a skill that beats its no-skill baseline with enough samples is promotable KEEP/PROMOTE;
  // an under-sampled arm is INCONCLUSIVE + non-promotable (a decision on too little data must not look authoritative).
  { id: 'learning.evals-compare-baseline', cap: 'learning', fn: () => { const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cmp-')); try { const ev = path.join(tmp, 'evals.json'); fs.writeFileSync(ev, JSON.stringify({ skill: 'bench', tests: [{ id: 't1', prompt: 'p', expected: 'e', assertions: [{ type: 'forbidden_pattern', regex: 'BAD' }] }] })); const withDir = path.join(tmp, 'with'), withoutDir = path.join(tmp, 'without'); fs.mkdirSync(withDir); fs.mkdirSync(withoutDir); for (let i = 1; i <= 3; i++) { fs.writeFileSync(path.join(withDir, 't1.' + i + '.txt'), 'clean output'); fs.writeFileSync(path.join(withoutDir, 't1.' + i + '.txt'), 'BAD output'); } const runCmp = (extra) => require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-evals.cjs'), 'compare', ev, '--with', withDir, '--without', withoutDir, '--json'].concat(extra || []), { encoding: 'utf8' }); const a = runCmp(['--min-samples', '3']), b = runCmp(['--min-samples', '3']); let ok = a.stdout === b.stdout; try { const o = JSON.parse(a.stdout); ok = ok && o.promotable === true && o.deltaPp > 0 && /KEEP|PROMOTE/.test(o.verdict); } catch { ok = false; } const under = runCmp(['--min-samples', '5']); try { const o2 = JSON.parse(under.stdout); ok = ok && o2.promotable === false && /INCONCLUSIVE/.test(o2.verdict); } catch { ok = false; } return ok; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  // Prompt Master always-on (2026-07-13): forge-intake must emit a shaped question list (universal first)
  // for a known type, and forge-promptcheck must score a strong dispatch high + a vague one low.
  { id: 'intake.bank-list-shaped', cap: 'promptmaster', fn: () => { const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-intake-')); try { const cd = path.join(tmp, '.claude', 'config', 'intake'); fs.mkdirSync(cd, { recursive: true }); fs.writeFileSync(path.join(cd, 'question-bank.json'), JSON.stringify({ version: 't', universal: [{ dimension: 'goal', question: 'U1?', why: 'w', options: ['a', 'b'], tier: 'required' }], byType: { website: [{ dimension: 'design', question: 'W1?', why: 'w', options: ['a'], tier: 'recommended' }] } })); const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-intake.cjs'), '--type', 'website', '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: tmp }) }); let ok = r.status === 0; try { const o = JSON.parse(r.stdout); ok = ok && o.count === 2 && o.questions[0].group === 'universal' && o.questions[0].tier === 'required'; } catch { ok = false; } return ok; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  { id: 'promptmaster.dispatch-lint', cap: 'promptmaster', fn: () => { const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-pc-')); try { const strong = path.join(tmp, 'strong.txt'), weak = path.join(tmp, 'weak.txt'); fs.writeFileSync(strong, 'MISSION: build the X deliverable. allowed_actions: edit only .claude/forge-bin/. not_allowed: never touch the dashboard. stop condition: ask before deleting. success_criteria: tests must pass. evidence_required: real output only, do not claim unrun.'); fs.writeFileSync(weak, 'improve the thing and fix stuff, make it better, etc'); const run = (f, extra) => require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-promptcheck.cjs'), f, '--json'].concat(extra || []), { encoding: 'utf8' }); let ok = true; try { const s = JSON.parse(run(strong).stdout); ok = ok && s.passed >= 6 && /SHAPED/.test(s.verdict); } catch { ok = false; } try { const w = JSON.parse(run(weak).stdout); ok = ok && w.passed < 4; } catch { ok = false; } const wStrict = run(weak, ['--strict']); ok = ok && wStrict.status === 1; return ok; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  // Cost capture (2026-07-13, scout #2): forge-cost `capture` parses the claude JSON envelope into a
  // cost_sampled event with real numbers, and NEVER fabricates a cost (missing total_cost_usd → no cost field).
  { id: 'learning.cost-capture-parse', cap: 'learning', fn: () => { const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cost-capture-')); try { const cd = path.join(tmp, '.claude', 'forge-dashboard'); fs.mkdirSync(cd, { recursive: true }); fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(cd, 'log-event.cjs')); const envOk = path.join(tmp, 'envelope-ok.json'); fs.writeFileSync(envOk, JSON.stringify({ total_cost_usd: 0.0456, usage: { input_tokens: 1200, output_tokens: 340 }, modelUsage: { 'claude-sonnet-4-5-20250929': { costUSD: 0.0456 } } })); const envNoCost = path.join(tmp, 'envelope-no-cost.json'); fs.writeFileSync(envNoCost, JSON.stringify({ usage: { input_tokens: 500, output_tokens: 100 } })); const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: tmp }); const runCap = (from, runId) => require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-cost.cjs'), 'capture', '--from', from, '--run', runId, '--agent', 'orchestrator'], { encoding: 'utf8', env }); const readEvts = (runId) => { const f = path.join(tmp, '.claude', 'forge-runs', runId, 'events.jsonl'); if (!fs.existsSync(f)) return []; return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }; const r1 = runCap(envOk, 'bench-cost-ok'); const evs1 = readEvts('bench-cost-ok').filter((e) => e.event_type === 'cost_sampled'); let ok = r1.status === 0 && evs1.length === 1 && evs1[0].cost === 0.0456 && evs1[0].tokens === 1540 && /estimated/.test(evs1[0].note || ''); const r2 = runCap(envNoCost, 'bench-cost-no-cost'); const evs2 = readEvts('bench-cost-no-cost').filter((e) => e.event_type === 'cost_sampled'); ok = ok && r2.status === 0 && evs2.length === 1 && !('cost' in evs2[0]) && /unavailable/.test(evs2[0].note || ''); return ok; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  // Federated learning store (2026-07-13, scout #6): forge-learn is opt-in (no manifest → no provenance),
  // isolation-safe (traversal rejected, store bytes never mutated on recall).
  { id: 'learning.federated-readonly-isolation', cap: 'learning', fn: () => { const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-learn-')); try { const learn = require('./forge-learn.cjs'); const src = path.join(tmp, 'store'); fs.mkdirSync(path.join(src, 'build-boss'), { recursive: true }); if (learn.safeResolve(src, '..', '..', 'etc') !== null) return false; const root = path.join(tmp, 'proj'); fs.mkdirSync(path.join(root, '.claude', 'config'), { recursive: true }); const off = learn.recall('build-boss', 'x', 5, root); let ok = Array.isArray(off) && off.every((l) => !l.provenance); fs.writeFileSync(path.join(src, 'build-boss', 'lessons.jsonl'), JSON.stringify({ type: 'semantic', text: 'FED lesson about testing', tags: ['testing'], evidence: 'x', ts: '2026-07-13T00:00:00Z' }) + '\n'); fs.writeFileSync(path.join(root, '.claude', 'config', 'forge-stores.json'), JSON.stringify({ stores: [{ name: 'shared', source: src, mode: 'read-only', priority: 0.8 }] })); const before = fs.readFileSync(path.join(src, 'build-boss', 'lessons.jsonl')); const fed = learn.recall('build-boss', 'testing', 5, root); const after = fs.readFileSync(path.join(src, 'build-boss', 'lessons.jsonl')); ok = ok && Buffer.compare(before, after) === 0 && Array.isArray(fed) && fed.some((l) => l.provenance && l.provenance.store === 'shared'); return ok; } catch { return false; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  { id: 'learning.stats-readonly-projector', cap: 'learning', fn: () => { const os = require('os'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-stats-')); try { const rd = path.join(tmp, '.claude', 'forge-runs', 'bench-run'); fs.mkdirSync(rd, { recursive: true }); const evPath = path.join(rd, 'events.jsonl'); fs.writeFileSync(evPath, JSON.stringify({ event_type: 'subagent_completed', agent: 'build-boss', task: 't', note: 'done', timestamp: '2026-07-12T00:00:00Z' }) + '\n'); const before = fs.readFileSync(evPath); const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'forge-stats.cjs')], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: tmp }) }); const statsPath = path.join(tmp, '.claude', 'forge-runs', 'STATS.json'); let ok = r.status === 0 && fs.existsSync(statsPath); try { const st = JSON.parse(fs.readFileSync(statsPath, 'utf8')); ok = ok && st.perBoss && st.perBoss['build-boss'] && st.perBoss['build-boss'].completed === 1; } catch { ok = false; } ok = ok && Buffer.compare(before, fs.readFileSync(evPath)) === 0; return ok; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  // Sync safety (2026-07-14 hardening): forge-sync writes into 12 real projects. The one invariant that must
  // never rot: after a sync, rollback restores the project BYTE-EXACTLY — changed files back to their old
  // bytes AND files the sync added back to non-existence. Proven by comparing the FULL pre-sync file manifest
  // to the post-rollback one, never by trusting a "rolled back" exit code.
  { id: 'reliability.sync-rollback-proven', cap: 'reliability', fn: () => { const os = require('os'); const sync = require('./forge-sync.cjs'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-sync-')); try { const tpl = path.join(tmp, 'tpl'); fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true }); fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'module.exports = "NEW";\n'); fs.writeFileSync(path.join(tpl, 'forge-bin', 'added.cjs'), 'module.exports = "ADDED";\n'); const proj = path.join(tmp, 'proj'); const pf = path.join(proj, '.claude', 'forge-bin'); fs.mkdirSync(pf, { recursive: true }); fs.writeFileSync(path.join(pf, 'tool.cjs'), 'module.exports = "OLD";\n'); const before = sync.fullFileManifest(tpl, proj); const r = sync.safeSyncProject(tpl, proj, { forceOverwrite: true, allowDegraded: true, batchId: 'bench-b1', nowIso: '2026-01-01T00:00:00.000Z' }); if (!r.ok) return false; if (!fs.readFileSync(path.join(pf, 'tool.cjs'), 'utf8').includes('NEW')) return false; if (!fs.existsSync(path.join(pf, 'added.cjs'))) return false; const rb = sync.rollbackProject(proj, 'bench-b1', {}); if (!rb.ok) return false; if (fs.existsSync(path.join(pf, 'added.cjs'))) return false; if (!fs.readFileSync(path.join(pf, 'tool.cjs'), 'utf8').includes('OLD')) return false; return JSON.stringify(before) === JSON.stringify(sync.fullFileManifest(tpl, proj)); } catch { return false; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  // Least-privilege tool-grant enforcement (WP2, 2026-07-14): every one of the 18 real agent-md files
  // must exactly match the pinned agent-tool-policy.json (no agent silently gaining Write/Edit/Bash beyond
  // its class, no orphaned/missing policy entries). Runs the REAL shipped agentsCheck against THIS project,
  // same pattern as security.rebind-guard — proves the mechanical gate is actually green today, not just
  // that the pure checker function exists.
  { id: 'security.agent-least-privilege', cap: 'security', fn: () => { const rep = doctor.agentsCheck(PROJECT_ROOT); return !!rep && rep.ok === true && !!rep.toolPolicy && rep.toolPolicy.ok === true; } },
  // Certify fail-closed (2026-07-14, WP4): the certification tool must NEVER certify a run it did not earn.
  // An empty run and an orchestrator-only run (no real agent dispatch) both fail — never a vacuous "no
  // violations = pass". Runs the shipped certifyRun against throwaway os.tmpdir() fixtures.
  { id: 'honesty.certify-fail-closed', cap: 'honesty', fn: () => { const os = require('os'); const certify = require('./forge-certify.cjs'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-certify-')); try { const ed = path.join(tmp, '.claude', 'forge-runs', 'empty'); fs.mkdirSync(ed, { recursive: true }); fs.writeFileSync(path.join(ed, 'events.jsonl'), ''); const empty = certify.certifyRun('empty', tmp); const od = path.join(tmp, '.claude', 'forge-runs', 'orch'); fs.mkdirSync(od, { recursive: true }); fs.writeFileSync(path.join(od, 'events.jsonl'), JSON.stringify({ run_id: 'orch', event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-07-14T00:00:00Z' }) + '\n' + JSON.stringify({ run_id: 'orch', event_type: 'run_completed', agent: 'orchestrator', timestamp: '2026-07-14T00:01:00Z' }) + '\n'); const orch = certify.certifyRun('orch', tmp); return empty.certified === false && orch.certified === false; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} } } },
  // Chaos detects a real break (2026-07-14, WP5): the failure-injection harness must not blindly trust the
  // module it checks. On a genuinely tampered chain the real chainCheck reports pass (corruption caught);
  // with a fake always-pass detector injected via the documented chainCheckFn hook, the harness reports FAIL.
  { id: 'reliability.chaos-detects-break', cap: 'reliability', fn: () => { const chaos = require('./forge-chaos.cjs'); const real = chaos.scenarioCorruptHashChain(); const fake = chaos.scenarioCorruptHashChain({ chainCheckFn: () => ({ ok: true, chained: 3, broken: [] }) }); return real.status === 'pass' && fake.status === 'fail'; } },
  // Checkpoint idempotency + corruption (2026-07-14, WP6): a repeated task with the same key+input_hash is
  // skipped (no double work), and a tampered checkpoint fails its checksum (never trusted as done).
  { id: 'reliability.checkpoint-idempotent', cap: 'reliability', fn: () => { const os = require('os'); const cp = require('./forge-checkpoint.cjs'); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-cp-')); try { const key = 'bench-task', input = 'inp-1'; const first = cp.shouldRun(key, input, { root }); cp.writeCheckpoint({ run_id: 'r', work_package_id: 'wp', phase_id: 'p', task_id: 't', attempt_id: 1, idempotency_key: key, input_hash: input, output_hash: 'o', files: [], status: 'done', proof_refs: [] }, { root }); const second = cp.shouldRun(key, input, { root }); const f = cp.keyFilePath(root, key); const raw = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, raw.replace('"status": "done"', '"status": "failed"')); const corrupt = cp.readCheckpoint(key, { root }); return first.should === true && second.should === false && corrupt.ok === false; } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } } },
  // Doctor tally anchored (2026-07-14, follow-up): forge-doctor's per-suite pass/fail parse must anchor on the
  // summary LINE, so a test whose DESCRIPTION contains "0 passed, 0 failed" is read by its real "12 passed"
  // summary, a "N passed, M failed, K skipped" line still parses, and a real failure still reads as failed.
  { id: 'reliability.doctor-tally-anchored', cap: 'reliability', fn: () => { const os = require('os'); const doctor = require('./forge-doctor.cjs'); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-doctor-tally-')); try { const bin = path.join(root, '.claude', 'forge-bin'); fs.mkdirSync(bin, { recursive: true }); /* collision phrase comes AFTER the real tally AND mid-line — only the ^-anchor reads this as 12/0; an unanchored last-match would wrongly take the trailing "0 passed, 0 failed". */ fs.writeFileSync(path.join(bin, 'a.test.cjs'), "console.log('12 passed, 0 failed');\nconsole.log('  ok  edge case: it reports 0 passed, 0 failed when the run is empty');\nprocess.exit(0);\n"); fs.writeFileSync(path.join(bin, 'b.test.cjs'), "console.log('43 passed, 0 failed, 1 skipped');\nprocess.exit(0);\n"); fs.writeFileSync(path.join(bin, 'c.test.cjs'), "console.log('3 passed, 2 failed');\nprocess.exit(1);\n"); const r = doctor.runTests(root); const a = r.perSuite.find((s) => s.suite === 'a.test.cjs'); const b = r.perSuite.find((s) => s.suite === 'b.test.cjs'); const c = r.perSuite.find((s) => s.suite === 'c.test.cjs'); return !!a && a.passed === 12 && a.failed === 0 && a.ok === true && !!b && b.passed === 43 && b.failed === 0 && b.ok === true && !!c && c.passed === 3 && c.failed === 2 && c.ok === false; } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } } },
];

function run() {
  const results = CASES.map((c) => { let pass = false; try { pass = !!c.fn(); } catch { pass = false; } return { id: c.id, cap: c.cap, pass }; });
  const passed = results.filter((r) => r.pass).length;
  return { total: results.length, passed, score: Number((passed / results.length).toFixed(4)), results };
}
/** readBaseline() -> the USER baseline if one has ever been written (--baseline), else the shipped
 *  baseline, else null. Never reads the raw file path directly from more than one caller — this is the
 *  single place that decides which baseline is authoritative for --gate. */
function readBaseline() {
  try { return JSON.parse(fs.readFileSync(USER_BASELINE, 'utf8')); } catch {}
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { return null; }
}

module.exports = { run, CASES, readBaseline, BASELINE, USER_BASELINE };

if (require.main === module) {
  const args = process.argv.slice(2);
  // v2.8.0 (WP-S4 CLI sweep): `--help` used to fall through to a full benchmark run (minutes). Answer first.
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node forge-bench.cjs [--baseline] [--json]');
    console.log('  (no flag)   run the capability benchmark and compare with the baseline (advisory gate)');
    console.log('  --baseline  store the current score as this project\'s own baseline (never shipped, never synced)');
    console.log('  --json      print the report as JSON');
    process.exit(0);
  }
  const rep = run();
  if (args.includes('--baseline')) {
    fs.mkdirSync(path.dirname(USER_BASELINE), { recursive: true });
    fs.writeFileSync(USER_BASELINE, JSON.stringify({ score: rep.score, passed: rep.passed, total: rep.total, cases: rep.results.map((r) => r.id), note: 'ForgeBench capability baseline (project-local — never shipped, never synced) — regenerate with --baseline after intentional capability changes' }, null, 2) + '\n', 'utf8');
    console.log('baseline written: ' + rep.passed + '/' + rep.total + ' (score ' + rep.score + ') -> ' + path.relative(PROJECT_ROOT, USER_BASELINE) + ' (project-local; the shipped ' + path.relative(PROJECT_ROOT, BASELINE) + ' is never rewritten by this command)');
    process.exit(0);
  }
  if (args.includes('--json')) { console.log(JSON.stringify(rep, null, 2)); }
  else {
    console.log('ForgeBench: ' + rep.passed + '/' + rep.total + ' capabilities healthy (score ' + rep.score + ')');
    for (const r of rep.results) console.log('  ' + (r.pass ? '✓' : '✗') + ' ' + r.cap.padEnd(11) + r.id);
  }
  if (args.includes('--gate')) {
    const base = readBaseline();
    if (!base) { console.error('no baseline — run `forge-bench --baseline` first (gate is advisory until then)'); process.exit(0); }
    if (rep.passed < base.passed) { console.error('REGRESSION: ' + rep.passed + '/' + rep.total + ' < baseline ' + base.passed + '/' + base.total + ' — blocking release'); process.exit(1); }
    console.log('gate OK: ' + rep.passed + '/' + rep.total + ' >= baseline ' + base.passed);
  }
  process.exit(rep.passed === rep.total ? 0 : 1);
}
