#!/usr/bin/env node
'use strict';
/** forge-event-wiring.test.cjs — 2026-08-01, "pakket 1: repareer de bedrading".
 *
 * Three measured, real holes in the event wiring, each proven end-to-end here BEFORE it was fixed:
 *
 *  (a) `wp_completed` / `wp_failed` were NEVER registered in log-event.cjs KNOWN_EVENT_TYPES, while
 *      forge-manifest.cjs::DONE_EVENT_TYPES/FAILED_EVENT_TYPES (L65/66) and forge-briefing.cjs::
 *      RAN_EVENT_TYPES/BLOCKED_EVENT_TYPES (L62/66) both already consume them. Under STRICT mode (the
 *      default) the whole manifest/briefing chain could therefore never receive a single real line.
 *      Registered here per the 3-place discipline + a CONTENT-ORACLE honesty gate on the pass side.
 *  (b) `verify-boss` (a REAL agent file, .claude/agents/verify-boss.md) could not log ANY working event:
 *      log-event.cjs only accepted the 12 permanent Bosses from config/agents/agent-registry.json plus
 *      GENERIC_AGENTS. The independent second witness literally could not record its own verdict. Six
 *      other real agent files had the same problem. Fixed WITHOUT promoting any of them to a 13th
 *      permanent Boss — see the PROJECT-AGENT section below.
 *  (c) .claude/FORGE_MODEL_ROUTING.json's own _doc promises "Forge logs the ACTUAL model used in
 *      FORGE_AGENT_LEDGER.md + a dashboard event", but no model-related event type existed at all.
 *      `agent_model_used` is that event, with a gate that refuses a GUESSED model (null is the only
 *      honest way to say "not observable").
 *
 * PROOF STYLE (mirrors forge-v9-events.test.cjs / forge-tool-index.test.cjs section 6): place 1 is proven
 * by REALLY spawning the log-event.cjs CLI (it resolves its CLAUDE_DIR from its own __dirname and cannot be
 * redirected, so a throwaway run id under the REAL .claude/forge-runs/ is used and removed in a finally);
 * place 2 by direct membership checks against forge-verify.cjs's exported Sets; place 3 by parsing the real
 * shipped app.js source into its actual taskStatus() bucket lists (comment lines stripped, so a mention in
 * a comment can never fake a pass — the "tiebreak green" trap).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const ROOT = path.resolve(__dirname, '..', '..');
const CLAUDE = path.join(ROOT, '.claude');
const LOG_EVENT = path.join(CLAUDE, 'forge-dashboard', 'log-event.cjs');
const APP_JS = path.join(CLAUDE, 'forge-dashboard', 'app.js');
const AGENTS_DIR = path.join(CLAUDE, 'agents');
const RUN_ID = 'event-wiring-test-' + process.pid + '-' + Date.now();
const RUN_DIR = path.join(CLAUDE, 'forge-runs', RUN_ID);

function log(type, extra) {
  return spawnSync(process.execPath, [LOG_EVENT, RUN_ID, type, JSON.stringify(extra || {})], { encoding: 'utf8' });
}
function lastEvent() {
  const raw = fs.readFileSync(path.join(RUN_DIR, 'events.jsonl'), 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1]);
}
function stripComments(text) {
  return text.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
}
function literals(text) {
  const out = new Set();
  const re = /'([^']*)'|"([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1] !== undefined ? m[1] : m[2]);
  return out;
}
/** bucketBodies(appSrc) -> [{bucket, members:Set}] — the REAL taskStatus() bucket lists of app.js, in
 *  source order, with comment lines stripped first. A literal that only appears in a comment is therefore
 *  NOT a member: this is what stops a comment mention from faking the 3rd registration place. */
function bucketBodies(src) {
  const parts = src.split(/\]\.includes\(t\)\)\s*return\s*'(\w+)';/);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const chunk = parts[i];
    const idx = chunk.lastIndexOf('if ([');
    out.push({ bucket: parts[i + 1], members: literals(stripComments(idx >= 0 ? chunk.slice(idx + 5) : chunk)) });
  }
  return out;
}
function objectBody(src, name) {
  const m = src.match(new RegExp('const ' + name + '\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};'));
  return m ? stripComments(m[1]) : null;
}
function parseFrontmatterName(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const n = m[1].match(/^name:\s*(.+)$/m);
  return n ? n[1].trim().replace(/^["']|["']$/g, '') : null;
}

console.log('forge-event-wiring tests (wp_completed/wp_failed · project-agent logging · agent_model_used)');

const appSrc = fs.readFileSync(APP_JS, 'utf8');
const buckets = bucketBodies(appSrc);
const bucketHas = (name) => buckets.filter((b) => b.members.has(name)).map((b) => b.bucket);
const verify = require('./forge-verify.cjs');

try {
  // =====================================================================================================
  console.log('\n(a1) log-event.cjs — wp_completed / wp_failed acceptance (PLACE 1)');
  // =====================================================================================================
  t('wp_completed WITH real proof is ACCEPTED (exit 0) and lands in events.jsonl', () => {
    const r = log('wp_completed', { agent: 'build-boss', wp_id: 'wpTEST1', evidence: 'selftest: 4 tests green', exit_code: 0 });
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — stderr: ' + (r.stderr || '').trim());
    const ev = lastEvent();
    assert.strictEqual(ev.event_type, 'wp_completed');
    assert.strictEqual(ev.wp_id, 'wpTEST1');
    assert.notStrictEqual(ev._forge_verify && ev._forge_verify.event_type_unknown, true, 'must not be stamped unknown-type');
    assert.strictEqual(ev._forge_verify.proof_verified, true, 'an evidenced wp_completed must be stamped proof_verified:true');
  });

  t('wp_failed is ACCEPTED (exit 0) — reporting a failure is never gated behind proof', () => {
    const r = log('wp_failed', { agent: 'build-boss', wp_id: 'wpTEST2', reason: 'selftest: compile error' });
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — stderr: ' + (r.stderr || '').trim());
    const ev = lastEvent();
    assert.strictEqual(ev.event_type, 'wp_failed');
    assert.notStrictEqual(ev._forge_verify && ev._forge_verify.event_type_unknown, true, 'must not be stamped unknown-type');
  });

  console.log('\n(a2) log-event.cjs — the honesty gate on a wp_completed claim');
  t('a wp_completed with NO proof field is refused for the PROOF reason (not the unknown-type reason)', () => {
    const r = log('wp_completed', { agent: 'build-boss', wp_id: 'wpTEST3' });
    const err = (r.stderr || '').trim();
    assert.strictEqual(r.status, 2, 'expected STRICT refusal exit 2, got ' + r.status + ' — stderr: ' + err);
    assert.ok(/no proof field/.test(err), 'refusal must cite the missing proof, got: ' + err);
    assert.ok(!/unknown event_type/.test(err), 'refusal must NOT be the unknown-type reason — that would mean the type is still unregistered: ' + err);
  });
  t('a wp_completed carrying exit_code 1 is refused — a pass claim cannot contradict its own exit code', () => {
    const r = log('wp_completed', { agent: 'build-boss', wp_id: 'wpTEST4', evidence: 'selftest: log tail', exit_code: 1 });
    const err = (r.stderr || '').trim();
    assert.strictEqual(r.status, 2, 'expected STRICT refusal exit 2, got ' + r.status + ' — stderr: ' + err);
    assert.ok(/exit_code 1 != 0/.test(err), 'refusal must cite the contradicting exit code, got: ' + err);
    assert.ok(!/unknown event_type/.test(err), 'refusal must NOT be the unknown-type reason: ' + err);
  });
  t('a wp_completed whose own result field says failed is refused — a contradicting result is not a pass', () => {
    const r = log('wp_completed', { agent: 'build-boss', wp_id: 'wpTEST5', evidence: 'selftest: log tail', result: 'failed' });
    const err = (r.stderr || '').trim();
    assert.strictEqual(r.status, 2, 'expected STRICT refusal exit 2, got ' + r.status + ' — stderr: ' + err);
    assert.ok(/contradict/i.test(err), 'refusal must cite the contradicting result field, got: ' + err);
    assert.ok(!/unknown event_type/.test(err), 'refusal must NOT be the unknown-type reason: ' + err);
  });
  t('the same contradiction oracle now also covers check_passed (status:"failed" on a pass claim)', () => {
    const r = log('check_passed', { agent: 'build-boss', evidence: 'selftest: log tail', status: 'failed' });
    const err = (r.stderr || '').trim();
    assert.strictEqual(r.status, 2, 'expected STRICT refusal exit 2, got ' + r.status + ' — stderr: ' + err);
    assert.ok(/contradict/i.test(err), 'refusal must cite the contradicting status field, got: ' + err);
  });
  t('REGRESSION GUARD (green before AND after — proves nothing about this work package): an invented event_type stays refused', () => {
    const r = log('zzz_invented_wp_type', { agent: 'build-boss', note: 'x' });
    assert.strictEqual(r.status, 2);
    assert.ok(/unknown event_type/.test(r.stderr || ''), 'the vocabulary gate must still reject invented types');
  });

  console.log('\n(a3) forge-verify.cjs classification (PLACE 2)');
  t('forge-verify classifies wp_completed as terminal/done', () => {
    assert.ok(verify.TERMINAL_TYPES.has('wp_completed'), 'not in TERMINAL_TYPES');
    assert.strictEqual(verify.taskStatus({ event_type: 'wp_completed' }), 'done');
  });
  t('forge-verify classifies wp_failed as failed', () => {
    assert.ok(verify.FAILED_TYPES.has('wp_failed'), 'not in FAILED_TYPES');
    assert.strictEqual(verify.taskStatus({ event_type: 'wp_failed' }), 'failed');
  });
  t('neither is dumped into every bucket (a lazy add-everywhere edit fails here)', () => {
    assert.ok(!verify.FAILED_TYPES.has('wp_completed'), 'wp_completed must not also be a failure');
    assert.ok(!verify.TERMINAL_TYPES.has('wp_failed'), 'wp_failed must not also be terminal/done');
    assert.ok(!verify.BACKBONE.has('wp_completed') && !verify.BACKBONE.has('wp_failed'), 'per-WP events are not run-level backbone milestones (mirrors wp_resumed)');
    assert.ok(!verify.RUNNING_TYPES.has('wp_completed') && !verify.RUNNING_TYPES.has('wp_failed'), 'neither is a running task');
  });
  t('wp_resumed pairs with wp_completed/wp_failed so a resumed WP is not double-counted', () => {
    const src = fs.readFileSync(path.join(__dirname, 'forge-verify.cjs'), 'utf8');
    const body = objectBody(src, 'TASK_PAIRS');
    assert.ok(body, 'could not locate TASK_PAIRS in forge-verify.cjs');
    assert.ok(/wp_resumed:\s*\[[^\]]*'wp_completed'[^\]]*'wp_failed'[^\]]*\]/.test(body), 'wp_resumed is not paired with wp_completed/wp_failed');
  });

  console.log('\n(a4) forge-dashboard/app.js classification (PLACE 3, comment-stripped)');
  t('app.js taskStatus() puts wp_completed in a done bucket and nowhere else', () => {
    assert.deepStrictEqual(bucketHas('wp_completed'), ['done'], 'buckets containing wp_completed: ' + JSON.stringify(bucketHas('wp_completed')));
  });
  t('app.js taskStatus() puts wp_failed in the failed bucket and nowhere else', () => {
    assert.deepStrictEqual(bucketHas('wp_failed'), ['failed'], 'buckets containing wp_failed: ' + JSON.stringify(bucketHas('wp_failed')));
  });
  t('app.js SYNTH fallback map has entries for wp_completed and wp_failed', () => {
    const synth = objectBody(appSrc, 'SYNTH');
    assert.ok(synth, 'could not locate the SYNTH map in app.js');
    assert.ok(/wp_completed:\s*'[a-z-]+'/.test(synth), 'wp_completed missing from SYNTH');
    assert.ok(/wp_failed:\s*'[a-z-]+'/.test(synth), 'wp_failed missing from SYNTH');
  });
  t('app.js TASK_PAIRS mirrors forge-verify.cjs for wp_resumed', () => {
    const body = objectBody(appSrc, 'TASK_PAIRS');
    assert.ok(body, 'could not locate TASK_PAIRS in app.js');
    assert.ok(/wp_resumed:\s*\[[^\]]*'wp_completed'[^\]]*'wp_failed'[^\]]*\]/.test(body), 'app.js TASK_PAIRS does not pair wp_resumed');
  });

  console.log('\n(a5) the consumers that were dead before this fix can now actually be fed');
  t('forge-manifest DONE/FAILED_EVENT_TYPES are exactly the types log-event.cjs now accepts', () => {
    const manifest = require('./forge-manifest.cjs');
    for (const type of manifest.DONE_EVENT_TYPES) {
      const r = log(type, { agent: 'build-boss', wp_id: 'wpFEED', evidence: 'selftest: feed check', exit_code: 0 });
      assert.strictEqual(r.status, 0, type + ' still refused: ' + (r.stderr || '').trim());
    }
    for (const type of manifest.FAILED_EVENT_TYPES) {
      const r = log(type, { agent: 'build-boss', wp_id: 'wpFEED', reason: 'selftest: feed check' });
      assert.strictEqual(r.status, 0, type + ' still refused: ' + (r.stderr || '').trim());
    }
  });

  // =====================================================================================================
  console.log('\n(b1) log-event.cjs — a REAL non-Boss agent file can log its own verdict');
  // =====================================================================================================
  t('verify-boss can log agent_started (with a dispatch id) — exit 0, no STRICT refusal', () => {
    const r = log('agent_started', { agent: 'verify-boss', role: 'independent re-executor', dispatch_id: 'toolu_selftest_vb', task: 'selftest: re-run the doctor' });
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — stderr: ' + (r.stderr || '').trim());
    const ev = lastEvent();
    assert.strictEqual(ev.agent, 'verify-boss');
    assert.notStrictEqual(ev._forge_verify && ev._forge_verify.agent_registered, false, 'verify-boss must not be stamped unregistered');
  });
  t('verify-boss can log its agent_completed verdict (self-logged, no dispatch id needed)', () => {
    const r = log('agent_completed', { agent: 'verify-boss', note: 'selftest: CONFIRMED — doctor exit 0' });
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — stderr: ' + (r.stderr || '').trim());
  });
  t('the acceptance is VISIBLE as a project agent, not silently as a 13th permanent Boss', () => {
    const r = log('agent_started', { agent: 'verify-boss', dispatch_id: 'toolu_selftest_vb2', task: 'selftest: kind stamp' });
    assert.strictEqual(r.status, 0, (r.stderr || '').trim());
    const ev = lastEvent();
    assert.ok(ev._forge_verify, 'a project agent must still be stamped, never silently indistinguishable from a Boss');
    assert.strictEqual(ev._forge_verify.agent_kind, 'project-agent', 'expected agent_kind:"project-agent", got: ' + JSON.stringify(ev._forge_verify));
  });
  t('a permanent Boss is NOT stamped as a project agent (the two kinds stay distinguishable)', () => {
    const r = log('agent_started', { agent: 'build-boss', dispatch_id: 'toolu_selftest_bb', task: 'selftest: boss kind' });
    assert.strictEqual(r.status, 0, (r.stderr || '').trim());
    const ev = lastEvent();
    assert.notStrictEqual(ev._forge_verify && ev._forge_verify.agent_kind, 'project-agent', 'a registry Boss must not be labelled a project agent');
  });
  t('agent-registry.json still documents exactly 12 permanent Bosses, and verify-boss is NOT one of them', () => {
    const reg = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'config', 'agents', 'agent-registry.json'), 'utf8'));
    const slugs = Object.keys(reg.agents || {});
    assert.strictEqual(slugs.length, 12, 'expected 12 permanent Bosses, found ' + slugs.length + ': ' + slugs.join(', '));
    assert.ok(!slugs.includes('verify-boss'), 'verify-boss must NOT have been promoted into the permanent registry');
  });
  t('a fabricated agent name with no agents/*.md file is STILL refused (the gate was narrowed, not removed)', () => {
    const r = log('agent_started', { agent: 'phantom-boss', dispatch_id: 'toolu_selftest_phantom', task: 'selftest: should be refused' });
    const err = (r.stderr || '').trim();
    assert.strictEqual(r.status, 2, 'expected STRICT refusal exit 2, got ' + r.status + ' — stderr: ' + err);
    assert.ok(/unregistered agent/.test(err), 'refusal must still cite the unregistered agent, got: ' + err);
  });

  console.log('\n(b2) INVENTORY — every real .claude/agents/*.md agent can log a working event');
  const agentFiles = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
  const agentNames = agentFiles.map((f) => {
    const text = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
    return parseFrontmatterName(text) || f.replace(/\.md$/, '');
  });
  t('there really are ' + agentFiles.length + ' agent files on disk (inventory is not empty)', () => {
    assert.ok(agentFiles.length >= 12, 'expected at least the 12 Bosses, found ' + agentFiles.length);
  });
  for (const name of agentNames) {
    t('agent "' + name + '" can log agent_started', () => {
      const r = log('agent_started', { agent: name, dispatch_id: 'toolu_selftest_inv', task: 'selftest: inventory' });
      assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — stderr: ' + (r.stderr || '').trim());
    });
  }

  console.log('\n(b3) forge-certify.cjs must not turn a real project agent into a NOT-CERTIFIED run');
  t('forge-certify registryCheck accepts verify-boss but still rejects a fabricated name', () => {
    const certify = require('./forge-certify.cjs');
    const okCheck = certify.registryCheck(ROOT, [{ agent: 'verify-boss', event_type: 'agent_started' }]);
    assert.strictEqual(okCheck.ok, true, 'verify-boss flagged as unknown: ' + JSON.stringify(okCheck));
    const badCheck = certify.registryCheck(ROOT, [{ agent: 'phantom-boss', event_type: 'agent_started' }]);
    assert.strictEqual(badCheck.ok, false, 'a fabricated agent name must still fail the ledger-authenticity check');
  });

  // =====================================================================================================
  console.log('\n(c1) log-event.cjs — agent_model_used records the ACTUAL model, never a guess (PLACE 1)');
  // =====================================================================================================
  t('agent_model_used with a real model is ACCEPTED and the model lands verbatim', () => {
    const r = log('agent_model_used', { agent: 'build-boss', model: 'claude-opus-5', source: 'agent frontmatter', note: 'selftest' });
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — stderr: ' + (r.stderr || '').trim());
    const ev = lastEvent();
    assert.strictEqual(ev.event_type, 'agent_model_used');
    assert.strictEqual(ev.model, 'claude-opus-5');
    assert.notStrictEqual(ev._forge_verify && ev._forge_verify.event_type_unknown, true, 'must not be stamped unknown-type');
  });
  t('agent_model_used with an EXPLICIT null model is ACCEPTED — not observable is an honest answer', () => {
    const r = spawnSync(process.execPath, [LOG_EVENT, RUN_ID, 'agent_model_used', '{"agent":"verify-boss","model":null,"note":"selftest: runtime model not observable"}'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — stderr: ' + (r.stderr || '').trim());
    const ev = lastEvent();
    assert.strictEqual(ev.model, null);
  });
  t('agent_model_used with NO model field at all is REFUSED (omitting it is not the same as null)', () => {
    const r = log('agent_model_used', { agent: 'build-boss', note: 'selftest: forgot the model' });
    const err = (r.stderr || '').trim();
    assert.strictEqual(r.status, 2, 'expected STRICT refusal exit 2, got ' + r.status + ' — stderr: ' + err);
    assert.ok(/model/.test(err) && /null/.test(err), 'refusal must demand an explicit model (null when unobservable), got: ' + err);
    assert.ok(!/unknown event_type/.test(err), 'refusal must NOT be the unknown-type reason: ' + err);
  });
  t('agent_model_used with a placeholder model ("unknown") is REFUSED — a guess is not an observation', () => {
    const r = log('agent_model_used', { agent: 'build-boss', model: 'unknown' });
    const err = (r.stderr || '').trim();
    assert.strictEqual(r.status, 2, 'expected STRICT refusal exit 2, got ' + r.status + ' — stderr: ' + err);
    assert.ok(/placeholder|guess/i.test(err), 'refusal must cite the guessed/placeholder model, got: ' + err);
    assert.ok(!/unknown event_type/.test(err), 'refusal must NOT be the unknown-type reason: ' + err);
  });
  t('agent_model_used from a fabricated agent is REFUSED — a model cannot be attributed to a phantom', () => {
    const r = log('agent_model_used', { agent: 'phantom-boss', model: 'claude-opus-5' });
    const err = (r.stderr || '').trim();
    assert.strictEqual(r.status, 2, 'expected STRICT refusal exit 2, got ' + r.status + ' — stderr: ' + err);
    assert.ok(/unregistered agent/.test(err), 'refusal must cite the unregistered agent, got: ' + err);
  });

  console.log('\n(c2) agent_model_used — places 2 and 3');
  t('forge-verify classifies agent_model_used as terminal/done and nothing else', () => {
    assert.ok(verify.TERMINAL_TYPES.has('agent_model_used'), 'not in TERMINAL_TYPES');
    assert.strictEqual(verify.taskStatus({ event_type: 'agent_model_used' }), 'done');
    assert.ok(!verify.FAILED_TYPES.has('agent_model_used'), 'must not be a failure');
    assert.ok(!verify.BACKBONE.has('agent_model_used'), 'a per-agent fact is not a run-level backbone milestone');
  });
  t('app.js taskStatus() puts agent_model_used in a done bucket and nowhere else', () => {
    assert.deepStrictEqual(bucketHas('agent_model_used'), ['done'], 'buckets containing agent_model_used: ' + JSON.stringify(bucketHas('agent_model_used')));
  });
  t('app.js SYNTH fallback map has an entry for agent_model_used', () => {
    const synth = objectBody(appSrc, 'SYNTH');
    assert.ok(synth && /agent_model_used:\s*'[a-z-]+'/.test(synth), 'agent_model_used missing from the SYNTH fallback map');
  });
  t('FORGE_MODEL_ROUTING.json _doc names the event it promises, so the promise is checkable', () => {
    const routing = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'FORGE_MODEL_ROUTING.json'), 'utf8'));
    assert.ok(/agent_model_used/.test(String(routing._doc || '')), '_doc still promises "a dashboard event" without naming it');
  });

  // =====================================================================================================
  console.log('\n(d) cross-check — all three new types are really in the KNOWN_EVENT_TYPES array itself');
  // =====================================================================================================
  const NEW_TYPES = ['wp_completed', 'wp_failed', 'agent_model_used'];
  t('log-event.cjs KNOWN_EVENT_TYPES carries all three literals (comment-stripped source read)', () => {
    const src = fs.readFileSync(LOG_EVENT, 'utf8');
    const m = src.match(/KNOWN_EVENT_TYPES\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
    assert.ok(m, 'could not locate the KNOWN_EVENT_TYPES literal in log-event.cjs');
    const members = literals(stripComments(m[1]));
    for (const type of NEW_TYPES) assert.ok(members.has(type), type + ' is not in the KNOWN_EVENT_TYPES array itself (a comment mention would not register it)');
  });
  t('forge-doctor.cjs::extractKnownEventTypesFromSource() also SEES all three (its ENFORCED gate stays honest)', () => {
    // The extractor has a KNOWN pre-existing defect (it scans comment lines too, so an apostrophe in comment
    // prose flips quote parity and swallows real types — measured at HEAD: 20 of 183 real types invisible).
    // Fixing that belongs in forge-doctor.cjs as its own work package. What THIS work package controls is
    // WHERE the new entries sit, so they land in a region the extractor still parses correctly — otherwise a
    // future real call site for one of them would be false-flagged as unregistered and turn the doctor red.
    const doctor = require('./forge-doctor.cjs');
    const seen = doctor.extractKnownEventTypesFromSource(fs.readFileSync(LOG_EVENT, 'utf8'));
    for (const type of NEW_TYPES) assert.ok(seen.has(type), type + ' is invisible to the doctor extractor — move its registration above the comment-apostrophe parity break');
  });
} finally {
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
