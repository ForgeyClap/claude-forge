#!/usr/bin/env node
'use strict';
/**
 * forge-cost.cjs — zero-dependency cost/token sampler for Forge Mission Control Phase 2 (WP5
 * "cost-logging"). Windows-safe (node "C:/Program Files/nodejs/node.exe" or any Node on PATH).
 *
 * Logs a real `cost_sampled` event via ../forge-dashboard/log-event.cjs so the dashboard's Cost/Token
 * meter (panels.js costStats()/renderCost()) lights up from REAL data — this file does not touch the
 * Cost panel itself, it only produces the event that panel already knows how to sum (event-type-agnostic:
 * costStats() sums any numeric tokens/cost field on ANY event).
 *
 * `cost_sampled` is ALREADY a registered event_type in log-event.cjs's KNOWN_EVENT_TYPES — nothing to
 * add there. It is not a WORKING_AGENT_EVENTS/DISPATCH_PROOF_EVENTS/PROOF_EVENTS entry, so strict mode
 * does not require a dispatch_id or a proof field for it — it is a plain metrics sample.
 *
 * CLI:
 *   node forge-cost.cjs <run_id> --agent <name> [--tokens N | --in N --out N] [--cost USD] [--model M] [--note '...']
 *     -> builds the event via buildCostEvent() and shells `node log-event.cjs <run_id> cost_sampled '<json>'`.
 *     (manual-args path — unchanged by WP2)
 *   node forge-cost.cjs capture --from <envelopeFile> --run <run_id> [--agent <name>] [--json]
 *     -> reads a SAVED `claude -p --output-format json` envelope file, extracts real cost/token numbers via
 *        parseClaudeUsage(), and logs ONE cost_sampled event with note "estimated $ (Claude CLI envelope)".
 *        Missing file or unparseable JSON -> exit 1, clear error, NO event logged.
 *   Bad/missing args (no run_id, or missing --agent) exit 1 with a clear message. Guarded end-to-end;
 *   never throws uncaught.
 *
 * Module API: require('./forge-cost.cjs') -> { buildCostEvent, parseClaudeUsage, readEnvelopeFile, logCostCapture }
 *
 * Numeric hygiene: a field is included ONLY when a finite number was actually given — a missing or
 * non-numeric value is omitted entirely (never written as NaN/null/0-by-default), matching costStats()'s
 * own "skip, don't fabricate" rule on the dashboard side.
 *
 * AUTOMATIC CAPTURE (WP2, 2026-07-13) — real per-run cost from Claude's own CLI cost envelope:
 *   LIVE capture (done by the Lead, NOT by this file, and NOT exercised in tests): shell out to
 *   `claude -p <prompt> --output-format json`, save stdout to a file, then feed that file to this tool's
 *   `capture` subcommand below. On Windows, `claude` is often a `.cmd`/`.ps1` shim, not a bare .exe — the
 *   Lead must either resolve the shim path explicitly or spawn with `{ shell: true }` (`spawnSync('claude',
 *   [...], { shell: true })`), otherwise ENOENT. Pin the CLI at >= v2.1.205 (the version this envelope
 *   shape — `total_cost_usd` + `usage.{input_tokens,output_tokens}` + `modelUsage` keyed by model id — was
 *   verified against); an older/newer CLI may reshuffle field names, which is exactly why `parseClaudeUsage`
 *   below tolerates every field being absent instead of assuming the schema.
 *   THIS file never shells out to `claude` itself and never runs any live CLI in its own tests — it only
 *   parses a SAVED envelope file, which is what makes it deterministic and testable (see
 *   forge-cost.test.cjs, which uses fixture files, never a live process).
 *   All dollar figures produced by this tool are CLIENT-SIDE ESTIMATES from the CLI's own reported
 *   `total_cost_usd` (relevant mainly for API-key billing; on a Claude subscription plan there is no
 *   separate per-call invoice) — every event/note this tool writes says "estimated", never "actual" or
 *   "billed". A missing `total_cost_usd` is reported as unavailable/null — NEVER coerced to 0 (0 would
 *   falsely read as "this call was free").
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function _finiteNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * buildCostEvent(opts) -> { agent, role: 'orchestrator', event_type: 'cost_sampled', tokens?, cost?, model?, note? }
 * opts: { agent, tokens, tokensIn, tokensOut, cost, model, note }
 *   - tokens = tokensIn + tokensOut when BOTH are given and finite; else falls back to opts.tokens if finite.
 *   - cost/model/note are included only when present and (for cost) a finite number.
 * Pure — never throws, never fabricates a number.
 */
function buildCostEvent(opts) {
  opts = opts || {};
  const ev = { agent: opts.agent, role: 'orchestrator', event_type: 'cost_sampled' };

  let tokens = null;
  const inN = _finiteNum(opts.tokensIn), outN = _finiteNum(opts.tokensOut);
  if (inN != null && outN != null) tokens = inN + outN;
  else { const t = _finiteNum(opts.tokens); if (t != null) tokens = t; }
  if (tokens != null) ev.tokens = tokens;

  const cost = _finiteNum(opts.cost);
  if (cost != null) ev.cost = cost;

  if (opts.model != null && String(opts.model).trim()) ev.model = String(opts.model).trim();
  if (opts.note != null && String(opts.note).trim()) ev.note = String(opts.note).trim();

  return ev;
}

/**
 * parseClaudeUsage(jsonText) -> { cost_usd, input_tokens, output_tokens, model, models: [...] }
 * Parses a `claude -p --output-format json` cost envelope STRING (not a live process — the caller reads
 * a saved file). Pure, deterministic, NEVER throws:
 *   - malformed JSON, a non-object, or any missing field -> that field is null (arrays default to []),
 *     never fabricated (a missing total_cost_usd is null, never coerced to 0).
 *   - cost_usd <- obj.total_cost_usd (finite number only)
 *   - input_tokens/output_tokens <- obj.usage.input_tokens / obj.usage.output_tokens (finite number only)
 *   - model/models <- obj.modelUsage keys (an object keyed by model id, e.g.
 *     { "claude-sonnet-4-5-20250929": { inputTokens, outputTokens, costUSD, ... } }); `models` lists every
 *     key seen, `model` is the first one (primary). Falls back to a top-level obj.model string if
 *     modelUsage is absent (schema tolerance, not the expected shape).
 */
function parseClaudeUsage(jsonText) {
  const out = { cost_usd: null, input_tokens: null, output_tokens: null, model: null, models: [] };
  let obj;
  try { obj = JSON.parse(jsonText); } catch { return out; }
  if (!obj || typeof obj !== 'object') return out;

  const cost = _finiteNum(obj.total_cost_usd);
  if (cost != null) out.cost_usd = cost;

  const usage = obj.usage && typeof obj.usage === 'object' ? obj.usage : null;
  if (usage) {
    const inTok = _finiteNum(usage.input_tokens);
    const outTok = _finiteNum(usage.output_tokens);
    if (inTok != null) out.input_tokens = inTok;
    if (outTok != null) out.output_tokens = outTok;
  }

  const modelUsage = obj.modelUsage && typeof obj.modelUsage === 'object' ? obj.modelUsage : null;
  if (modelUsage) {
    const names = Object.keys(modelUsage).filter((k) => k != null && String(k).trim());
    if (names.length) { out.models = names; out.model = names[0]; }
  }
  if (out.model == null && obj.model != null && String(obj.model).trim()) out.model = String(obj.model).trim();

  return out;
}

/**
 * readEnvelopeFile(fromFile) -> { ok: true, usage } | { ok: false, error }
 * Reads a saved envelope file and parses it via parseClaudeUsage(). Distinguishes two honest failure
 * modes so the CLI never logs a fabricated event: the file cannot be read at all ("cannot read"), vs the
 * file exists but is not valid JSON ("unparseable"). A file that parses as valid JSON but is missing cost
 * fields is NOT a failure here — it returns ok:true with cost_usd/tokens null (see parseClaudeUsage).
 */
function readEnvelopeFile(fromFile) {
  let raw;
  try { raw = fs.readFileSync(fromFile, 'utf8'); }
  catch (e) { return { ok: false, error: 'cannot read envelope file: ' + fromFile + ' (' + e.message + ')' }; }
  try { JSON.parse(raw); }
  catch (e) { return { ok: false, error: 'unparseable JSON in envelope file: ' + fromFile + ' (' + e.message + ')' }; }
  return { ok: true, usage: parseClaudeUsage(raw) };
}

/**
 * logCostCapture(runId, root, usage, agent) -> { ok, event } | { ok: false, reason }
 * Best-effort: builds a cost_sampled event from a parsed usage object (via buildCostEvent — same numeric
 * hygiene as the manual path: a null cost/tokens field is OMITTED, never written as 0) and appends it via
 * `<root>/.claude/forge-dashboard/log-event.cjs`. Mirrors forge-evals.cjs's logGateEvaluated(root, ...)
 * shape so `root` is an explicit, testable parameter (FORGE_PROJECT_ROOT override in the CLI wrapper) —
 * never a module-level constant computed only from __dirname. Never throws.
 */
function logCostCapture(runId, root, usage, agent) {
  const noteBits = ['estimated $ (Claude CLI envelope)'];
  if (usage.cost_usd == null) noteBits.push('cost unavailable');
  const ev = buildCostEvent({
    agent: agent || 'orchestrator',
    tokensIn: usage.input_tokens,
    tokensOut: usage.output_tokens,
    cost: usage.cost_usd,
    model: usage.model,
    note: noteBits.join(' — '),
  });
  const extra = Object.assign({}, ev);
  delete extra.event_type;

  const logEventPath = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
  let r;
  try { r = spawnSync(process.execPath, [logEventPath, runId, 'cost_sampled', JSON.stringify(extra)], { encoding: 'utf8' }); }
  catch (e) { return { ok: false, reason: 'failed to invoke log-event.cjs: ' + e.message }; }
  if (r.error) return { ok: false, reason: 'failed to invoke log-event.cjs: ' + r.error.message };
  if (r.status !== 0) return { ok: false, reason: (r.stderr || r.stdout || 'log-event.cjs exited ' + r.status).toString().trim() };
  return { ok: true, event: extra };
}

module.exports = { buildCostEvent, parseClaudeUsage, readEnvelopeFile, logCostCapture };

/**
 * runCapture(argv) — CLI handler for `capture --from <envelopeFile> --run <run_id> [--agent <name>] [--json]`.
 * Sets process.exitCode itself (1 = missing/unparseable envelope or logging failure, 0 = one cost_sampled
 * event was appended). Never logs an event on a read/parse failure.
 */
function runCapture(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') opts.from = argv[++i];
    else if (a === '--run') opts.run = argv[++i];
    else if (a === '--agent') opts.agent = argv[++i];
    else if (a === '--json') opts.json = true;
  }
  if (!opts.from || !opts.run) {
    console.error("Usage: node forge-cost.cjs capture --from <envelopeFile> --run <run_id> [--agent <name>] [--json]");
    process.exitCode = 1;
    return;
  }

  const read = readEnvelopeFile(opts.from);
  if (!read.ok) { console.error('forge-cost capture: ' + read.error); process.exitCode = 1; return; }

  const root = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
  const logged = logCostCapture(opts.run, root, read.usage, opts.agent);
  if (!logged.ok) { console.error('forge-cost capture: ' + logged.reason); process.exitCode = 1; return; }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, run_id: opts.run, usage: read.usage, event: logged.event }, null, 2));
  } else {
    const costLabel = logged.event.cost != null ? ('$' + logged.event.cost) : 'unavailable';
    const tokensLabel = logged.event.tokens != null ? String(logged.event.tokens) : 'n/a';
    console.log('forge-cost capture: logged cost_sampled for ' + opts.run + ' (cost=' + costLabel + ', tokens=' + tokensLabel + ')');
  }
  process.exitCode = 0;
}

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    if (argv[0] === 'capture') { runCapture(argv.slice(1)); return; }
    const runId = argv[0];
    if (!runId || runId.startsWith('--')) {
      console.error("Usage: node forge-cost.cjs <run_id> --agent <name> [--tokens N | --in N --out N] [--cost USD] [--model M] [--note '...']\n   or: node forge-cost.cjs capture --from <envelopeFile> --run <run_id> [--agent <name>] [--json]");
      process.exitCode = 1;
      return;
    }
    const opts = {};
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--agent') opts.agent = argv[++i];
      else if (a === '--tokens') opts.tokens = argv[++i];
      else if (a === '--in') opts.tokensIn = argv[++i];
      else if (a === '--out') opts.tokensOut = argv[++i];
      else if (a === '--cost') opts.cost = argv[++i];
      else if (a === '--model') opts.model = argv[++i];
      else if (a === '--note') opts.note = argv[++i];
    }
    if (!opts.agent) { console.error('forge-cost: --agent is required'); process.exitCode = 1; return; }

    const ev = buildCostEvent(opts);
    const extra = Object.assign({}, ev);
    delete extra.event_type; // event_type is passed positionally to log-event.cjs

    const logEventPath = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
    const r = spawnSync(process.execPath, [logEventPath, runId, 'cost_sampled', JSON.stringify(extra)], { encoding: 'utf8', stdio: 'inherit' });
    if (r.error) { console.error('forge-cost: failed to invoke log-event.cjs: ' + r.error.message); process.exitCode = 1; return; }
    process.exitCode = r.status == null ? 1 : r.status;
  };
  try { main(); } catch (e) { console.error('forge-cost: ' + e.message); process.exitCode = 1; }
}
