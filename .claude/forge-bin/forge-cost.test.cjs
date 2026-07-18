#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-cost.cjs's buildCostEvent() + parseClaudeUsage() + the `capture` CLI
 *  subcommand (WP2, 2026-07-13). The buildCostEvent/parseClaudeUsage sections are pure unit tests — no
 *  forge-runs/ interaction. The `capture` CLI section spawns the real forge-cost.cjs as a subprocess with
 *  FORGE_PROJECT_ROOT pointed at a throwaway temp dir containing a COPIED log-event.cjs (same idiom as
 *  forge-evals.test.cjs) — it never touches this project's real .claude/forge-runs/, and never shells out
 *  to the live `claude` CLI (fixtures only). Exit 0 = all pass. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildCostEvent, parseClaudeUsage } = require('./forge-cost.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-cost offline tests (hermetic — buildCostEvent shape only, no forge-runs writes)');

// 1) --in/--out combine into tokens
const ev1 = buildCostEvent({ agent: 'Build Boss', tokensIn: '100', tokensOut: '50' });
t('tokens_in(100) + tokens_out(50) -> tokens 150', ev1.tokens === 150);
t('event_type is cost_sampled', ev1.event_type === 'cost_sampled');
t('role is orchestrator', ev1.role === 'orchestrator');
t('agent carries through', ev1.agent === 'Build Boss');

// 2) --cost present as a real number
const ev2 = buildCostEvent({ agent: 'Build Boss', cost: '0.02' });
t('cost present as a parsed number', ev2.cost === 0.02);
t('tokens omitted (not NaN) when neither tokens nor in/out given', !('tokens' in ev2));

// 3) missing/non-numeric values are omitted entirely — never NaN, never fabricated
const ev3 = buildCostEvent({ agent: 'Build Boss', tokens: 'not-a-number', cost: 'also-bad' });
t('non-numeric tokens omitted entirely (never NaN)', !('tokens' in ev3));
t('non-numeric cost omitted entirely (never NaN)', !('cost' in ev3));
t('Object.values never contains NaN', !Object.values(ev3).some((v) => typeof v === 'number' && Number.isNaN(v)));

// 4) only one of tokensIn/tokensOut given -> falls back to opts.tokens, not a partial sum
const ev4 = buildCostEvent({ agent: 'Build Boss', tokensIn: '100', tokens: '77' });
t('partial in/out (missing out) falls back to direct tokens, not a bogus partial sum', ev4.tokens === 77);

// 5) direct --tokens (no in/out at all) still works
const ev5 = buildCostEvent({ agent: 'Build Boss', tokens: '77' });
t('direct tokens value used when in/out not given', ev5.tokens === 77);

// 6) model/note included only when given and non-blank
const ev6 = buildCostEvent({ agent: 'Build Boss', model: 'gpt-oss-120b', note: 'sampled mid-run' });
t('model included when given', ev6.model === 'gpt-oss-120b');
t('note included when given', ev6.note === 'sampled mid-run');
const ev7 = buildCostEvent({ agent: 'Build Boss' });
t('model omitted when not given', !('model' in ev7));
t('note omitted when not given', !('note' in ev7));
const ev8 = buildCostEvent({ agent: 'Build Boss', model: '   ' });
t('a blank/whitespace-only model is treated as not given', !('model' in ev8));

// 7) buildCostEvent never throws on missing/empty opts
t('buildCostEvent(undefined) never throws', (() => { try { buildCostEvent(undefined); return true; } catch { return false; } })());
t('buildCostEvent({}) never throws and event_type is still cost_sampled', buildCostEvent({}).event_type === 'cost_sampled');

console.log('');
console.log('parseClaudeUsage() — saved claude -p --output-format json envelope parsing (WP2)');

// 8) realistic full envelope -> correct extraction
const REALISTIC_ENVELOPE = JSON.stringify({
  type: 'result', subtype: 'success', total_cost_usd: 0.0456,
  usage: { input_tokens: 1200, output_tokens: 340 },
  modelUsage: { 'claude-sonnet-4-5-20250929': { inputTokens: 1200, outputTokens: 340, costUSD: 0.0456 } },
});
const u1 = parseClaudeUsage(REALISTIC_ENVELOPE);
t('realistic envelope: cost_usd extracted', u1.cost_usd === 0.0456);
t('realistic envelope: input_tokens extracted', u1.input_tokens === 1200);
t('realistic envelope: output_tokens extracted', u1.output_tokens === 340);
t('realistic envelope: model extracted from modelUsage key', u1.model === 'claude-sonnet-4-5-20250929');
t('realistic envelope: models lists every modelUsage key', Array.isArray(u1.models) && u1.models.length === 1 && u1.models[0] === 'claude-sonnet-4-5-20250929');

// 9) multi-model envelope -> models[] lists all, model is the first (primary)
const MULTI_MODEL_ENVELOPE = JSON.stringify({
  total_cost_usd: 0.09,
  usage: { input_tokens: 2000, output_tokens: 600 },
  modelUsage: { 'claude-opus-4-8': { costUSD: 0.07 }, 'claude-haiku-4-5': { costUSD: 0.02 } },
});
const u1b = parseClaudeUsage(MULTI_MODEL_ENVELOPE);
t('multi-model envelope: models lists both keys', Array.isArray(u1b.models) && u1b.models.length === 2);
t('multi-model envelope: model is the first key (primary)', u1b.model === 'claude-opus-4-8');

// 10) envelope MISSING total_cost_usd -> cost_usd null, no throw, other fields still extracted
const NO_COST_ENVELOPE = JSON.stringify({
  usage: { input_tokens: 500, output_tokens: 100 },
  modelUsage: { 'claude-haiku-4-5': {} },
});
const u2 = parseClaudeUsage(NO_COST_ENVELOPE);
t('missing total_cost_usd -> cost_usd is null (never fabricated)', u2.cost_usd === null);
t('missing total_cost_usd -> input/output tokens still extracted', u2.input_tokens === 500 && u2.output_tokens === 100);
t('missing total_cost_usd -> model still extracted', u2.model === 'claude-haiku-4-5');

// 11) malformed JSON -> handled, no crash, all nulls/[]
t('malformed JSON never throws', (() => { try { parseClaudeUsage('{not valid json'); return true; } catch { return false; } })());
const u3 = parseClaudeUsage('{not valid json');
t('malformed JSON -> cost_usd null', u3.cost_usd === null);
t('malformed JSON -> input_tokens/output_tokens null', u3.input_tokens === null && u3.output_tokens === null);
t('malformed JSON -> model null, models empty array', u3.model === null && Array.isArray(u3.models) && u3.models.length === 0);

// 12) non-object JSON (e.g. a bare number/array/null) -> handled, no crash
t('bare-array JSON never throws and yields nulls', (() => {
  const u = parseClaudeUsage('[1,2,3]');
  return u.cost_usd === null && u.input_tokens === null && u.model === null;
})());
t('empty string never throws', (() => { try { parseClaudeUsage(''); return true; } catch { return false; } })());

console.log('');
console.log('capture CLI subcommand — real subprocess against a copied log-event.cjs (hermetic, no live claude CLI)');

// ---- hermetic capture() harness: copy the REAL log-event.cjs into <tmproot>/.claude/forge-dashboard/,
// spawn the real forge-cost.cjs with FORGE_PROJECT_ROOT=<tmproot> (same idiom as forge-evals.test.cjs) ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cost-capture-test-'));
const REAL_LOG_EVENT = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
const CLI = path.join(__dirname, 'forge-cost.cjs');

function makeLogFixture(root) {
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(REAL_LOG_EVENT, path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
}
function runCapture(args, envRoot) {
  return spawnSync(process.execPath, [CLI, 'capture', ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: envRoot }) });
}
function readEvents(root, runId) {
  const f = path.join(root, '.claude', 'forge-runs', runId, 'events.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

makeLogFixture(TMP);
fs.writeFileSync(path.join(TMP, 'envelope-ok.json'), REALISTIC_ENVELOPE);
fs.writeFileSync(path.join(TMP, 'envelope-no-cost.json'), NO_COST_ENVELOPE);
fs.writeFileSync(path.join(TMP, 'envelope-malformed.json'), '{not valid json');

// 13) capture --from <fixture> --run <run> -> one cost_sampled event appended, numbers match, note has "estimated"
const r1 = runCapture(['--from', path.join(TMP, 'envelope-ok.json'), '--run', 'capture-run-ok', '--agent', 'orchestrator', '--json'], TMP);
t('capture on a valid envelope exits 0', r1.status === 0);
const evs1 = readEvents(TMP, 'capture-run-ok').filter((e) => e.event_type === 'cost_sampled');
t('capture on a valid envelope appends exactly ONE cost_sampled event', evs1.length === 1);
t('captured event cost matches envelope total_cost_usd', evs1[0] && evs1[0].cost === 0.0456);
t('captured event tokens = input_tokens + output_tokens', evs1[0] && evs1[0].tokens === 1540);
t('captured event model matches envelope modelUsage key', evs1[0] && evs1[0].model === 'claude-sonnet-4-5-20250929');
t('captured event note mentions "estimated"', !!(evs1[0] && /estimated/.test(evs1[0].note || '')));

// 14) capture with a MISSING file -> exit 1, no event logged
const r2 = runCapture(['--from', path.join(TMP, 'does-not-exist.json'), '--run', 'capture-run-missing'], TMP);
t('capture on a missing file exits 1', r2.status === 1);
t('capture on a missing file logs NO event', readEvents(TMP, 'capture-run-missing').length === 0);
t('capture on a missing file prints a clear error (not a stack trace)', /cannot read envelope file/.test(r2.stderr || ''));

// 15) capture with MALFORMED JSON -> exit 1, no event logged (distinct from "valid JSON, missing fields")
const r3 = runCapture(['--from', path.join(TMP, 'envelope-malformed.json'), '--run', 'capture-run-malformed'], TMP);
t('capture on malformed JSON exits 1', r3.status === 1);
t('capture on malformed JSON logs NO event', readEvents(TMP, 'capture-run-malformed').length === 0);
t('capture on malformed JSON prints a clear error', /unparseable/.test(r3.stderr || ''));

// 16) NEVER fabricates $ — an envelope missing total_cost_usd still logs the event (tokens are real), but
//     cost is OMITTED (never written as 0/free) and the note says the cost is unavailable
const r4 = runCapture(['--from', path.join(TMP, 'envelope-no-cost.json'), '--run', 'capture-run-no-cost', '--agent', 'orchestrator'], TMP);
t('capture on a cost-less envelope still exits 0 (tokens are real data)', r4.status === 0);
const evs4 = readEvents(TMP, 'capture-run-no-cost').filter((e) => e.event_type === 'cost_sampled');
t('capture on a cost-less envelope appends one event', evs4.length === 1);
t('captured event has NO cost field at all (never fabricated as 0)', evs4[0] && !('cost' in evs4[0]));
t('captured event note says cost is unavailable', !!(evs4[0] && /unavailable/.test(evs4[0].note || '')));
t('captured event still carries real token numbers', evs4[0] && evs4[0].tokens === 600);

// 17) missing required --run flag -> usage error, exit 1, no crash
const r5 = runCapture(['--from', path.join(TMP, 'envelope-ok.json')], TMP);
t('capture missing --run exits 1 with a usage message', r5.status === 1 && /Usage:/.test(r5.stderr || ''));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
