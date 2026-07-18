#!/usr/bin/env node
'use strict';
/**
 * forge-certify.cjs — BLACK-BOX certification tool (2026-07-14, WP4 hardening). Answers one question
 * from REAL run data only, never from a claim: did Forge genuinely orchestrate this run itself, or is it
 * empty / fabricated? Zero-dependency, Windows-safe, read-only (never writes into a real run).
 *
 * This is itself a HONESTY GATE, so it must never vacuous-pass (see the forge-doctor "0 passed, 0 failed
 * counted as green" bug this project fixed on 2026-07-14 in the SAME hardening run — forge-certify must
 * not reintroduce that class of bug). An empty/missing/malformed events.jsonl is FAIL CLOSED: NOT
 * CERTIFIED with a reason, never a silent/implicit pass.
 *
 * Reads (never writes): <root>/.claude/forge-runs/<run_id>/{events.jsonl, run.json, final-report.md}.
 * Optionally cross-checks agent names against <root>/.claude/config/agents/agent-registry.json.
 *
 * FIVE CERTIFICATION CRITERIA (each carries concrete evidence — event indices / hashes / reasons, not
 * assertions):
 *   1. real_agent_dispatch      — at least one subagent_started/subagent_completed/agent_started/
 *                                 agent_completed event from a real NAMED Boss (not just orchestrator/
 *                                 generic activity). A run with only orchestrator events has NOT proven
 *                                 multi-agent orchestration.
 *   2. proof_integrity          — the events.jsonl hash chain (entry_hash = sha256(canonical(event) +
 *                                 prev_hash), mirrored EXACTLY from forge-doctor.cjs chainCheck() / the
 *                                 chaining logic in forge-dashboard/log-event.cjs — read both before
 *                                 editing this) is intact for this run. Any malformed JSONL line also
 *                                 fails this criterion (can't trust a chain over unparseable bytes).
 *   3. claim_equals_proof       — every check_passed / quality_gate_passed / retest_completed event
 *                                 carries real evidence (command/output/evidence/output_artifact) and,
 *                                 when present, a zero exit_code. A "*_passed" event with a nonzero
 *                                 exit_code or no evidence field at all is a fabricated pass. A run with
 *                                 ZERO such events passes this criterion VACUOUSLY (nothing to falsify) —
 *                                 that is correct in isolation, but see checks_verified/CAVEAT below: it
 *                                 must never be read as "completion was verified".
 *   4. no_fabricated_completion — if this run claims completion (a run_completed event, or a
 *                                 final-report.md file — a CLAIM written by an agent, not proof by
 *                                 itself), there must be real underlying work: at least one named-Boss
 *                                 subagent_completed/agent_completed event elsewhere in the run.
 *   5. ledger_authenticity      — event timestamps are non-decreasing (plausible order), and (optional,
 *                                 skipped honestly when the registry file is unavailable) every named
 *                                 agent appearing in a dispatch event matches a real Boss in
 *                                 config/agents/agent-registry.json.
 *
 * CERTIFIED requires event_count > 0 AND all five criteria ok. Fail-closed on a missing, unreadable, or
 * malformed events.jsonl, and on an empty run — never a vacuous pass.
 *
 * checks_verified / "CERTIFIED (UNVERIFIED)" (WP4 CERTIFY FIX, 2026-07-14): the five criteria above can
 * all legitimately pass on a run that logged ZERO standardized check_passed/quality_gate_passed/
 * retest_completed events — a real orchestrated run may only ever narrate its work in free-text
 * subagent_completed notes (this project's own forge-2026-07-14-hardening run is exactly this case).
 * That is not fabrication, but plain "CERTIFIED" on such a run overclaims: nothing standardized was
 * actually re-verified, only free-text claims exist. `checks_verified` (= evidenced, zero-exit-code
 * standardized checks, a subset of criterion 3's checked events) is now counted and always surfaced. When
 * `checks_verified === 0` AND this run also carries a completion claim (a run_completed event, a
 * final-report.md file, or any subagent_completed/agent_completed event — literally "an agent claims
 * done"), the certificate stays CERTIFIED (exit code 0 unchanged — a real, orchestrated run must not be
 * rejected) but sets `unverified_completion: true` and prints the loud label
 * "CERTIFIED (UNVERIFIED — no standardized checks; completion rests on free-text claims)" instead of a
 * bare "CERTIFIED". This was chosen over inventing a third exit code specifically so an already-real,
 * already-orchestrated run keeps passing existing 0/1 exit-code consumers, while no longer silently
 * overclaiming in the human-readable/JSON label. As an informational (non-blocking) strengthening,
 * `free_text_pass_claims` flags any subagent_completed/agent_completed note that uses pass-claiming
 * language (e.g. "all N tests green/passed") when zero standardized evidence backs it up.
 *
 * CAVEAT (read before trusting a "CERTIFIED" result for anything beyond what it actually checks):
 * CERTIFIED means (a) the five criteria above all hold for the events actually present, (b) the hash
 * chain is internally self-consistent (every entry_hash matches a recomputation over its own event, and
 * every prev_hash resolves to a prior entry_hash in this same file), and (c) every standardized pass
 * event that DOES exist carries real evidence and a zero exit code. CERTIFIED does NOT prove the log
 * was not hand-written wholesale end-to-end: the chain is a KEYLESS, publicly recomputable sha256 over
 * each event's own fields — anyone with a text editor and Node can compute a fully "valid" chain from
 * scratch (there is no HMAC / secret key / external timestamp anchor). It also does NOT require that any
 * check genuinely ran — it only requires that IF a standardized pass event is logged, it is not
 * self-contradictory. Read "CERTIFIED" as "internally consistent and not self-contradictory", never as
 * "tamper-proof" or "cannot be forged".
 *
 * CLI:
 *   node forge-certify.cjs <run_id> [--root <projectRoot>] [--json]
 *   Exit code: 0 = CERTIFIED (including CERTIFIED (UNVERIFIED)), 1 = NOT CERTIFIED, 2 = usage error
 *   (missing/invalid run_id argument).
 *
 * Module API: { certifyRun, verifyChain, realDispatchEvidence, claimProofViolations, checksVerifiedCount,
 *   completionClaimCoverage, anyCompletionClaimPresent, freeTextPassClaims, timestampsInOrder,
 *   registryCheck, GENERIC_AGENTS, DISPATCH_EVENT_TYPES, PROOF_NEED, EXIT_CODE_ASSERTION_EVENTS,
 *   FREE_TEXT_PASS_PATTERNS, printSummary }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

// ---- vocabulary mirrored from forge-dashboard/log-event.cjs (read that file before editing this) ----
// GENERIC_AGENTS: names that are never a "real named Boss" — orchestrator/system-level activity only.
const GENERIC_AGENTS = new Set(['lead', 'boss', 'orchestrator', 'system', 'paperclip', 'forge-router', 'main', 'codex', '']);
// Events that represent a real agent dispatch/working-agent lifecycle (subset of log-event.cjs's
// WORKING_AGENT_EVENTS relevant to proving "a named Boss actually worked", not just self-narration).
const DISPATCH_EVENT_TYPES = new Set(['subagent_started', 'subagent_completed', 'agent_started', 'agent_completed']);
// PROOF_NEED mirrors log-event.cjs's PROOF_EVENTS map for the three "pass assertion" event types this
// criterion cares about (check_passed, quality_gate_passed, retest_completed) — the accepted evidence
// field names an honest pass event must carry at least one of.
const PROOF_NEED = {
  check_passed: ['command', 'output', 'evidence', 'output_artifact'],
  quality_gate_passed: ['evidence', 'output_artifact', 'command'],
  retest_completed: ['command', 'output', 'evidence'],
};
// Same set as log-event.cjs's PASS_ASSERTION_EVENTS — a "*_passed"/"*_completed" claim with a recorded
// nonzero exit_code contradicts its own claim (the "content oracle" — proof must not merely exist, it
// must not contradict success).
const EXIT_CODE_ASSERTION_EVENTS = new Set(['check_passed', 'retest_completed', 'quality_gate_passed']);
// FREE_TEXT_PASS_PATTERNS — informational-only scan for pass-claiming language inside a subagent_completed/
// agent_completed free-text `note`. Never blocks certification by itself; only surfaced (via
// freeTextPassClaims()) to make a "liegende vrije-tekst note" overclaim visible when checks_verified is 0.
const FREE_TEXT_PASS_PATTERNS = [
  /\ball\s+\d+\s+tests?\s+(are\s+)?(green|passed|passing)\b/i,
  /\ball\s+tests?\s+(are\s+)?(green|passed|passing)\b/i,
  /\b100\s*%\s*(pass|passed|passing|green|coverage)\b/i,
  /\bcoverage\s+(is\s+)?(green|passed)\b/i,
];

// ---- reading events.jsonl (BOM-tolerant, malformed lines counted not crashed on) ----
function readEventsJsonl(runDir) {
  const file = path.join(runDir, 'events.jsonl');
  if (!fs.existsSync(file)) return { events: null, malformed: 0, error: 'events.jsonl missing at ' + file + ' — run does not exist or has not logged anything yet' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { events: null, malformed: 0, error: 'events.jsonl unreadable: ' + e.message }; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  const events = [];
  let malformed = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { const v = JSON.parse(s); if (v && typeof v === 'object' && !Array.isArray(v)) events.push(v); else malformed++; }
    catch { malformed++; }
  }
  return { events, malformed, error: null };
}

// ---- criterion 1: real agent dispatch ----
function realDispatchEvidence(events) {
  const hits = [];
  events.forEach((e, evIdx) => {
    if (!e || typeof e !== 'object') return;
    if (!DISPATCH_EVENT_TYPES.has(e.event_type)) return;
    const agent = e.agent;
    if (agent == null || String(agent).trim() === '') return; // events without an agent prove nothing
    if (GENERIC_AGENTS.has(String(agent).toLowerCase())) return; // orchestrator/system activity, not a Boss
    hits.push({ evIdx, agent, event_type: e.event_type, timestamp: e.timestamp || null });
  });
  return hits;
}

// ---- criterion 2: hash-chain integrity — MIRRORED from forge-doctor.cjs chainCanon()/chainCheck() ----
function chainCanon(ev) {
  const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort();
  const o = {}; for (const x of k) o[x] = ev[x];
  return JSON.stringify(o);
}
// Fix (2026-07-15, HIGH bug, mirrors forge-doctor.cjs chainCheck() — read that fix's comment first): a
// MIXED run (a legacy prefix with no entry_hash, followed later by real chained events once log-event.cjs's
// hash chain was adopted mid-run) used to validate the WHOLE array from index 0 the moment ANY event had a
// hash, reporting the legacy prefix's hash-less events as "missing hash fields" — indistinguishable from a
// genuine tamper (cry-wolf: a benign continuation of an old run read identically to real tampering). Fix:
// find the FIRST index carrying an entry_hash and validate ONLY from there onward. A run with NO entry_hash
// anywhere at all is still "cannot be verified" (unchanged — certify is fail-closed on a fully legacy run,
// stricter than doctor's advisory-style skip). A genuine tamper anywhere in the chained section is still
// caught exactly as before — this only stops penalizing an untouched legacy prefix.
function verifyChain(events, runId) {
  const startIdx = events.findIndex((e) => e && e.entry_hash);
  if (startIdx === -1) {
    return { ok: false, chained: false, reason: 'no hash-chain present on any event (legacy/unchained run) — tamper-evidence cannot be verified' };
  }
  const seen = new Set(['genesis:' + runId]);
  for (let i = startIdx; i < events.length; i++) {
    const e = events[i];
    if (!e || !e.entry_hash || !e.prev_hash) return { ok: false, chained: true, reason: 'event ' + i + ' missing hash fields' };
    const expect = crypto.createHash('sha256').update(chainCanon(e) + e.prev_hash).digest('hex');
    if (expect !== e.entry_hash) return { ok: false, chained: true, reason: 'event ' + i + ' self-hash mismatch (edited?)' };
    if (!seen.has(e.prev_hash)) return { ok: false, chained: true, reason: 'event ' + i + ' prev_hash links nowhere (truncation/removal?)' };
    seen.add(e.entry_hash);
  }
  return { ok: true, chained: true, reason: '', chain_start_index: startIdx };
}

// ---- criterion 3: CLAIM=PROOF on pass-assertion events ----
function claimProofViolations(events) {
  const checked = []; const violations = [];
  events.forEach((e, evIdx) => {
    if (!e || typeof e !== 'object') return;
    const need = PROOF_NEED[e.event_type];
    if (!need) return;
    checked.push(evIdx);
    if (EXIT_CODE_ASSERTION_EVENTS.has(e.event_type) && e.exit_code != null && Number(e.exit_code) !== 0) {
      violations.push({ evIdx, event_type: e.event_type, reason: 'exit_code ' + e.exit_code + ' != 0 — a pass event with a nonzero exit code is a fabricated pass, not proof' });
      return;
    }
    const has = need.some((k) => e[k] != null && String(e[k]).trim().length > 0);
    if (!has) violations.push({ evIdx, event_type: e.event_type, reason: 'no evidence field (' + need.join('/') + ') present — a bare claim, not proof' });
  });
  return { checked, violations };
}
// checksVerifiedCount — how many standardized check_passed/quality_gate_passed/retest_completed events
// were genuinely evidenced AND non-contradictory (checked minus violations). This is the count the
// CERTIFIED (UNVERIFIED) gate keys off: criterion 3 can pass VACUOUSLY when checked===0 (nothing to
// falsify), but that must never be confused with "N checks were actually verified".
function checksVerifiedCount(proof) {
  return proof.checked.length - proof.violations.length;
}

// ---- criterion 4: no fabricated completion ----
function completionClaimCoverage(events, runDir, dispatchHits) {
  const hasRunCompleted = events.some((e) => e && e.event_type === 'run_completed');
  const hasFinalReport = fs.existsSync(path.join(runDir, 'final-report.md'));
  const claims = [];
  if (hasRunCompleted) claims.push('run_completed event present');
  if (hasFinalReport) claims.push('final-report.md present');
  const hasClaim = claims.length > 0;
  const realWorkCount = dispatchHits.length;
  return { ok: !hasClaim || realWorkCount > 0, hasClaim, claims, realWorkCount };
}

// anyCompletionClaimPresent — broader than completionClaimCoverage's `hasClaim` (which only counts
// run_completed / final-report.md): also counts ANY subagent_completed/agent_completed event, from any
// agent, as "an agent claims done" — literally what the event name asserts. Used ONLY to decide whether
// the checks_verified===0 gate below needs to warn; does not affect criterion 4's own ok/fail logic.
function anyCompletionClaimPresent(events, runDir) {
  const hasRunCompleted = events.some((e) => e && e.event_type === 'run_completed');
  const hasFinalReport = fs.existsSync(path.join(runDir, 'final-report.md'));
  const hasAgentDoneClaim = events.some((e) => e && (e.event_type === 'subagent_completed' || e.event_type === 'agent_completed'));
  return hasRunCompleted || hasFinalReport || hasAgentDoneClaim;
}

// freeTextPassClaims — informational-only (never blocks certification): flags a subagent_completed/
// agent_completed event whose free-text `note` uses pass-claiming language (e.g. "all 100 tests green").
// This is exactly the class of overclaim a standardized check_passed event is supposed to replace — never
// itself proof, but worth surfacing loudly when it's the ONLY thing backing a completion claim.
function freeTextPassClaims(events) {
  const hits = [];
  events.forEach((e, evIdx) => {
    if (!e || (e.event_type !== 'subagent_completed' && e.event_type !== 'agent_completed')) return;
    const note = typeof e.note === 'string' ? e.note : '';
    if (!note) return;
    if (FREE_TEXT_PASS_PATTERNS.some((re) => re.test(note))) hits.push({ evIdx, agent: e.agent || null, note });
  });
  return hits;
}

// ---- criterion 5: ledger authenticity ----
function timestampsInOrder(events) {
  let prev = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const raw = e && e.timestamp;
    if (!raw) continue; // an event without a timestamp is not itself an ordering violation
    const ts = Date.parse(raw);
    if (Number.isNaN(ts)) continue; // unparseable timestamp — skip rather than fail on format alone
    if (prev != null && ts < prev) return { ok: false, reason: 'event ' + i + ' timestamp (' + raw + ') is earlier than a prior event — implausible order' };
    prev = ts;
  }
  return { ok: true, reason: '' };
}
function loadRegistryNames(root) {
  const regPath = path.join(path.resolve(root), '.claude', 'config', 'agents', 'agent-registry.json');
  let reg;
  try { reg = JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch { return null; } // unavailable — optional check, skip
  const names = new Set();
  for (const [slug, a] of Object.entries(reg.agents || {})) {
    names.add(String(slug).toLowerCase());
    if (a && a.name) names.add(String(a.name).toLowerCase());
  }
  return names;
}
function registryCheck(root, dispatchHits) {
  const names = loadRegistryNames(root);
  if (!names) return { ok: true, skipped: true, reason: 'agent-registry.json unavailable — optional cross-check skipped', unknown: [] };
  const unknown = [];
  for (const h of dispatchHits) {
    const key = String(h.agent).toLowerCase();
    if (!names.has(key)) unknown.push(h.agent);
  }
  const uniqueUnknown = Array.from(new Set(unknown));
  return { ok: uniqueUnknown.length === 0, skipped: false, unknown: uniqueUnknown };
}

// ---- the certificate ----
function notCertified(runId, root, reason, extra) {
  return Object.assign({
    run_id: runId, root, certified: false, event_count: 0, malformed_lines: (extra && extra.malformed) || 0,
    reason,
    checks_verified: 0, unverified_completion: false, free_text_pass_claims: [], label: 'NOT CERTIFIED',
    criteria: [1, 2, 3, 4, 5].map((id) => ({ id, ok: false, reason: 'not evaluated — ' + reason })),
    generated_at: new Date().toISOString(),
  }, extra && extra.fields ? extra.fields : {});
}

/**
 * certifyRun(runId, root) -> certificate object. Pure/side-effect-free (reads only). Never throws on a
 * missing/malformed/empty run — always returns an honest NOT CERTIFIED certificate for those cases.
 */
function certifyRun(runId, root) {
  root = path.resolve(root);
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  const { events, malformed, error } = readEventsJsonl(runDir);

  if (error) return notCertified(runId, root, error);
  if (!events || events.length === 0) {
    return notCertified(runId, root,
      malformed > 0 ? 'events.jsonl contains ' + malformed + ' malformed line(s) and zero valid events' : 'events.jsonl is empty — no events recorded for this run',
      { malformed });
  }

  const dispatchHits = realDispatchEvidence(events);
  const c1 = {
    id: 1, name: 'real_agent_dispatch', ok: dispatchHits.length > 0,
    distinct_agents: Array.from(new Set(dispatchHits.map((h) => String(h.agent)))),
    evidence: dispatchHits,
    reason: dispatchHits.length > 0 ? '' : 'no subagent_started/subagent_completed/agent_started/agent_completed event from a real named Boss — only orchestrator/generic activity, no multi-agent orchestration proven',
  };

  const chain = verifyChain(events, runId);
  const c2 = {
    id: 2, name: 'proof_integrity', ok: malformed === 0 && chain.ok, chained: chain.chained, malformed_lines: malformed,
    reason: malformed > 0 ? malformed + ' malformed JSONL line(s) in events.jsonl — cannot trust the hash chain' : chain.reason,
  };

  const proof = claimProofViolations(events);
  const checksVerified = checksVerifiedCount(proof);
  const c3 = {
    id: 3, name: 'claim_equals_proof', ok: proof.violations.length === 0, checked_count: proof.checked.length,
    violations: proof.violations,
    reason: proof.violations.length === 0 ? (proof.checked.length === 0 ? 'no check_passed/quality_gate_passed/retest_completed events in this run — nothing to falsify (vacuous pass at THIS criterion only; it does NOT mean completion was verified — see checks_verified/unverified_completion at the top level)' : '') : proof.violations.length + ' pass-assertion event(s) failed CLAIM=PROOF',
  };

  const completion = completionClaimCoverage(events, runDir, dispatchHits);
  const c4 = {
    id: 4, name: 'no_fabricated_completion', ok: completion.ok, has_claim: completion.hasClaim, claims: completion.claims,
    real_work_events: completion.realWorkCount,
    reason: completion.ok ? '' : 'a completion claim (' + completion.claims.join(', ') + ') exists with zero underlying named-Boss subagent_completed/agent_completed events',
  };

  const ts = timestampsInOrder(events);
  const reg = registryCheck(root, dispatchHits);
  const c5 = {
    id: 5, name: 'ledger_authenticity', ok: ts.ok && reg.ok,
    timestamps_in_order: ts.ok, timestamp_reason: ts.reason,
    registry_check: reg,
    reason: !ts.ok ? ts.reason : (!reg.ok ? 'unregistered agent name(s) in dispatch events: ' + reg.unknown.join(', ') : ''),
  };

  const criteria = [c1, c2, c3, c4, c5];
  const certified = criteria.every((c) => c.ok);

  // checks_verified / CERTIFIED (UNVERIFIED) gate — see header CAVEAT/WP4 note. certified stays exactly
  // what the 5 criteria say (unchanged exit-code semantics); this only decides the human-facing LABEL.
  const completionClaimExists = anyCompletionClaimPresent(events, runDir);
  const unverifiedCompletion = certified && checksVerified === 0 && completionClaimExists;
  const freeTextClaims = freeTextPassClaims(events);
  const label = !certified ? 'NOT CERTIFIED' : (unverifiedCompletion ? 'CERTIFIED (UNVERIFIED — no standardized checks; completion rests on free-text claims)' : 'CERTIFIED');

  return {
    run_id: runId, root, certified, event_count: events.length, malformed_lines: malformed,
    checks_verified: checksVerified, unverified_completion: unverifiedCompletion,
    free_text_pass_claims: freeTextClaims, label,
    criteria, generated_at: new Date().toISOString(),
  };
}

function printSummary(cert) {
  const lines = ['Forge Certify — ' + cert.run_id];
  if (cert.reason && (!cert.criteria || cert.event_count === 0)) lines.push('  ' + cert.reason);
  const names = { 1: 'real agent dispatch', 2: 'proof integrity (hash chain)', 3: 'claim = proof', 4: 'no fabricated completion', 5: 'ledger authenticity' };
  for (const c of cert.criteria || []) {
    lines.push((c.ok ? '  ✓ ' : '  ✗ ') + c.id + '. ' + (names[c.id] || c.name) + (c.reason ? ' — ' + c.reason : ''));
  }
  lines.push('  checks_verified: ' + (cert.checks_verified != null ? cert.checks_verified : 0));
  if (cert.free_text_pass_claims && cert.free_text_pass_claims.length) {
    lines.push('  ! free-text pass-claim(s) found with ZERO standardized evidence behind them (informational, not blocking):');
    for (const h of cert.free_text_pass_claims) lines.push('    - event ' + h.evIdx + ' (' + (h.agent || '?') + '): "' + h.note + '"');
  }
  lines.push('  ⇒ ' + (cert.label || (cert.certified ? 'CERTIFIED' : 'NOT CERTIFIED')));
  lines.push('  CAVEAT: CERTIFIED = internally consistent + every standardized pass event evidenced. It is NOT proof the log wasn\'t hand-authored (the chain is a keyless, publicly recomputable sha256 — not an HMAC), and it does NOT require that any check actually ran.');
  return lines.join('\n');
}

module.exports = {
  certifyRun, verifyChain, chainCanon, realDispatchEvidence, claimProofViolations, checksVerifiedCount,
  completionClaimCoverage, anyCompletionClaimPresent, freeTextPassClaims, timestampsInOrder, registryCheck,
  loadRegistryNames, readEventsJsonl,
  GENERIC_AGENTS, DISPATCH_EVENT_TYPES, PROOF_NEED, EXIT_CODE_ASSERTION_EVENTS, FREE_TEXT_PASS_PATTERNS, printSummary,
};

// ---- CLI ----
if (require.main === module) {
  function parseArgs(argv) {
    const out = { run_id: null, root: DEFAULT_ROOT, json: false };
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--root') out.root = argv[++i];
      else if (a === '--json') out.json = true;
      else pos.push(a);
    }
    out.run_id = pos[0] || null;
    return out;
  }

  const opts = parseArgs(process.argv.slice(2));
  if (!opts.run_id || !/^[A-Za-z0-9_-]+$/.test(opts.run_id)) {
    console.error('Usage: node forge-certify.cjs <run_id> [--root <projectRoot>] [--json]');
    console.error('invalid or missing run_id (allowed: A-Z a-z 0-9 _ -)');
    process.exitCode = 2;
  } else {
    try {
      const cert = certifyRun(opts.run_id, opts.root);
      if (opts.json) console.log(JSON.stringify(cert, null, 2));
      else console.log(printSummary(cert));
      process.exitCode = cert.certified ? 0 : 1;
    } catch (e) {
      console.error('forge-certify: ' + e.message);
      process.exitCode = 2;
    }
  }
}
