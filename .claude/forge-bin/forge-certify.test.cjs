#!/usr/bin/env node
'use strict';
// forge-certify.test.cjs — hermetic tests for the WP4 black-box certification tool. Every fixture lives
// under os.tmpdir() — this file NEVER writes into the project's real .claude/forge-runs/. The one
// "real subagent events" fixture uses the REAL forge-dashboard/log-event.cjs (copied into a tmp project)
// so its events.jsonl — including the hash chain — is genuinely produced by the shipped writer, not a
// reimplementation. Everything else is hand-built via buildChain(), which reuses forge-certify.cjs's own
// exported chainCanon() to compute a valid chain the same way log-event.cjs does, so negative tests can
// precisely control which single link breaks.
// Convention: prints "<N> passed, <M> failed" and exits non-zero on any failure (forge-doctor runTests).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const certify = require('./forge-certify.cjs');

const CLI = path.join(__dirname, 'forge-certify.cjs');
const REAL_LOG_EVENT = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
const REAL_REGISTRY = path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

// ---- fixture helpers (all under os.tmpdir()) ----
function mkRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-certify-test-')); }
function runsDirOf(root, runId) { return path.join(root, '.claude', 'forge-runs', runId); }
function writeEventsRaw(root, runId, text) {
  const dir = runsDirOf(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), text, 'utf8');
  return dir;
}
function writeRegistry(root, agentsObj) {
  const dir = path.join(root, '.claude', 'config', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-registry.json'), JSON.stringify({ agents: agentsObj }), 'utf8');
}
// Build a genuinely-chained event array the SAME way log-event.cjs does (entry_hash =
// sha256(canonical(event)+prev_hash), genesis='genesis:'+runId), reusing forge-certify's own chainCanon()
// so the "valid chain" baseline stays byte-consistent with what verifyChain() expects.
function buildChain(runId, rawEvents) {
  let prevHash = 'genesis:' + runId;
  const out = [];
  for (const raw of rawEvents) {
    const ev = Object.assign({ run_id: runId }, raw);
    ev.prev_hash = prevHash;
    const canon = certify.chainCanon(ev);
    ev.entry_hash = crypto.createHash('sha256').update(canon + prevHash).digest('hex');
    prevHash = ev.entry_hash;
    out.push(ev);
  }
  return out;
}
function toJsonl(events) { return events.map((e) => JSON.stringify(e)).join('\n') + '\n'; }
function ts(n) { return '2026-07-14T00:00:' + String(n).padStart(2, '0') + '.000Z'; } // strictly increasing

// A realistic "good" run: orchestrator kickoff, a named Boss doing real work with evidenced proof, a
// second named Boss's QA completion, and an orchestrator completion claim covered by that real work.
function goodRawEvents() {
  return [
    { event_type: 'run_started', agent: 'orchestrator', role: 'lead', note: 'kickoff', timestamp: ts(0) },
    { event_type: 'agent_note', agent: 'orchestrator', role: 'lead', note: 'assign WP to Build Boss', timestamp: ts(1) },
    { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', task: 'WP1', status: 'completed', note: 'done', timestamp: ts(2) },
    { event_type: 'check_passed', agent: 'Build Boss', command: 'node x.test.cjs', output: '10 passed, 0 failed', exit_code: 0, timestamp: ts(3) },
    { event_type: 'subagent_completed', agent: 'Test Boss', role: 'qa', task: 'WP1 QA', status: 'completed', evidence: 'regression green', timestamp: ts(4) },
    { event_type: 'quality_gate_passed', agent: 'orchestrator', evidence: '10/10 tests green', timestamp: ts(5) },
    { event_type: 'run_completed', agent: 'orchestrator', note: 'done', timestamp: ts(6) },
  ];
}

console.log('forge-certify tests (black-box certification of a run)');

// ==== 1. real_agent_dispatch (unit) ====
t('realDispatchEvidence finds a named subagent_completed, skips orchestrator/generic', () => {
  const hits = certify.realDispatchEvidence([
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'subagent_completed', agent: 'Build Boss' },
    { event_type: 'agent_note', agent: 'Build Boss' }, // not a dispatch-shaped type — ignored
  ]);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].agent, 'Build Boss');
});
t('realDispatchEvidence returns empty for orchestrator-only activity', () => {
  const hits = certify.realDispatchEvidence([
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'agent_completed', agent: 'system' },
    { event_type: 'agent_started', agent: '' },
  ]);
  assert.strictEqual(hits.length, 0);
});

// ==== 2. proof_integrity / verifyChain (unit) ====
// WP-S13 (2.2, 2026-09-26 laptop re-audit) — verifyChain() is now a thin wrapper over log-event.cjs's
// own readEventsClassified({verifyChain:true}), which reads from a REAL FILE (never an in-memory array),
// so every test below writes its fixture to a real events.jsonl under a tmp root first. Reason strings
// also changed (they are log-event.cjs's own wording now, not certify's old local reimplementation's) —
// regexes updated to match.
function eventsPathFor(root, runId) { return path.join(runsDirOf(root, runId), 'events.jsonl'); }
function writeChainFixture(runId, evs) {
  const tmp = mkRoot();
  writeEventsRaw(tmp, runId, toJsonl(evs));
  return eventsPathFor(tmp, runId);
}
t('verifyChain accepts a genuinely valid chain', () => {
  const evs = buildChain('r1', goodRawEvents());
  const r = certify.verifyChain(writeChainFixture('r1', evs), 'r1');
  assert.ok(r.ok, JSON.stringify(r));
});
t('verifyChain rejects a run with NO hash fields at all (legacy/unchained)', () => {
  const r = certify.verifyChain(writeChainFixture('r1', goodRawEvents()), 'r1');
  assert.strictEqual(r.ok, false);
  assert.ok(/no hash-chain present/.test(r.reason));
});
t('verifyChain detects an edited event (entry_hash no longer matches the recomputed content)', () => {
  const evs = buildChain('r2', goodRawEvents());
  evs[2].note = 'TAMPERED AFTER HASHING';
  const r = certify.verifyChain(writeChainFixture('r2', evs), 'r2');
  assert.strictEqual(r.ok, false);
  assert.ok(/recomputed content hash/.test(r.reason), r.reason);
});
t('verifyChain detects a forked/broken prev_hash (chain fork or edit)', () => {
  const evs = buildChain('r3', goodRawEvents());
  evs[3].prev_hash = 'deadbeef'.repeat(8);
  // must recompute entry_hash to isolate the "prev_hash broken" failure from a self-hash mismatch
  evs[3].entry_hash = crypto.createHash('sha256').update(certify.chainCanon(evs[3]) + evs[3].prev_hash).digest('hex');
  const r = certify.verifyChain(writeChainFixture('r3', evs), 'r3');
  assert.strictEqual(r.ok, false);
  assert.ok(/prev_hash broken/.test(r.reason), r.reason);
});
t('verifyChain detects a missing hash field on an otherwise-chained log (an unchained/injected entry)', () => {
  const evs = buildChain('r4', goodRawEvents());
  delete evs[1].entry_hash;
  const r = certify.verifyChain(writeChainFixture('r4', evs), 'r4');
  assert.strictEqual(r.ok, false);
  assert.ok(/unchained entry/.test(r.reason), r.reason);
});

// ==== 3. claim_equals_proof (unit) ====
t('claimProofViolations flags a check_passed with a nonzero exit_code', () => {
  const { violations } = certify.claimProofViolations([{ event_type: 'check_passed', agent: 'Build Boss', command: 'x', output: 'y', exit_code: 1 }]);
  assert.strictEqual(violations.length, 1);
  assert.ok(/exit_code 1/.test(violations[0].reason));
});
t('claimProofViolations flags a check_passed with NO evidence field at all', () => {
  const { violations } = certify.claimProofViolations([{ event_type: 'check_passed', agent: 'Build Boss' }]);
  assert.strictEqual(violations.length, 1);
  assert.ok(/no evidence field/.test(violations[0].reason));
});
t('claimProofViolations accepts an evidenced, zero-exit-code check_passed', () => {
  const { violations, checked } = certify.claimProofViolations([{ event_type: 'check_passed', agent: 'Build Boss', command: 'x', output: 'y', exit_code: 0 }]);
  assert.strictEqual(violations.length, 0);
  assert.strictEqual(checked.length, 1);
});
t('claimProofViolations accepts a quality_gate_passed carrying only `evidence`', () => {
  const { violations } = certify.claimProofViolations([{ event_type: 'quality_gate_passed', agent: 'orchestrator', evidence: 'all green' }]);
  assert.strictEqual(violations.length, 0);
});
t('claimProofViolations ignores non-pass-assertion event types', () => {
  const { checked } = certify.claimProofViolations([{ event_type: 'agent_note', agent: 'Build Boss', note: 'x' }]);
  assert.strictEqual(checked.length, 0);
});
// WP4 CERTIFY FIX — pins the L142 `> 0` vs `>= 0` mutant: an evidence field that is PRESENT but an EMPTY
// string (`evidence:''`) must still be treated as NO evidence, not as valid proof. Only `evidence` is set
// here (command/output/output_artifact all absent) so this isolates exactly the `.trim().length > 0` check.
t('claimProofViolations flags a check_passed with a PRESENT-but-EMPTY evidence field (pins L142 >0 vs >=0)', () => {
  const { violations, checked } = certify.claimProofViolations([{ event_type: 'check_passed', agent: 'Build Boss', evidence: '' }]);
  assert.strictEqual(checked.length, 1);
  assert.strictEqual(violations.length, 1, 'an empty-string evidence field must NOT count as proof');
  assert.ok(/no evidence field/.test(violations[0].reason));
});
t('claimProofViolations flags a check_passed whose ONLY evidence-shaped field is whitespace-only', () => {
  const { violations } = certify.claimProofViolations([{ event_type: 'check_passed', agent: 'Build Boss', output: '   ' }]);
  assert.strictEqual(violations.length, 1, 'a whitespace-only field must not count as proof either');
});

// ==== checksVerifiedCount — evidenced+non-contradictory checks, distinct from criterion 3's vacuous pass ====
t('checksVerifiedCount is 0 when there is nothing to check (vacuous, not verified)', () => {
  const proof = certify.claimProofViolations([{ event_type: 'agent_note', note: 'x' }]);
  assert.strictEqual(certify.checksVerifiedCount(proof), 0);
});
t('checksVerifiedCount counts only evidenced, non-violating checks', () => {
  const proof = certify.claimProofViolations([
    { event_type: 'check_passed', agent: 'a', command: 'x', output: 'y', exit_code: 0 }, // valid
    { event_type: 'check_passed', agent: 'b' }, // violation: no evidence
    { event_type: 'quality_gate_passed', agent: 'c', evidence: 'ok' }, // valid
  ]);
  assert.strictEqual(certify.checksVerifiedCount(proof), 2);
});

// ==== 4. no_fabricated_completion (unit) ====
t('completionClaimCoverage passes when a claim is backed by real dispatch hits', () => {
  const tmp = mkRoot();
  const r = certify.completionClaimCoverage([{ event_type: 'run_completed' }], tmp, [{ evIdx: 0, agent: 'Build Boss' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hasClaim, true);
});
t('completionClaimCoverage FAILS a completion claim with zero real dispatch hits', () => {
  const tmp = mkRoot();
  const r = certify.completionClaimCoverage([{ event_type: 'run_completed' }], tmp, []);
  assert.strictEqual(r.ok, false);
});
t('completionClaimCoverage passes vacuously-but-honestly when there is no claim at all', () => {
  const tmp = mkRoot();
  const r = certify.completionClaimCoverage([{ event_type: 'agent_note' }], tmp, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hasClaim, false);
});
t('completionClaimCoverage detects a final-report.md file as a completion claim', () => {
  const tmp = mkRoot();
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'final-report.md'), '# Done\n');
  const r = certify.completionClaimCoverage([], tmp, []);
  assert.strictEqual(r.hasClaim, true);
  assert.strictEqual(r.ok, false); // claim present, zero real work
});

// ==== anyCompletionClaimPresent — broader "is there ANY completion claim at all" used by the WP4
// checks_verified===0 warning gate (not by criterion 4 itself) ====
t('anyCompletionClaimPresent is false with no run_completed, no final-report.md, no *_completed event', () => {
  const tmp = mkRoot();
  const present = certify.anyCompletionClaimPresent([{ event_type: 'agent_note', note: 'thinking' }], tmp);
  assert.strictEqual(present, false);
});
t('anyCompletionClaimPresent is true on a run_completed event alone', () => {
  const tmp = mkRoot();
  const present = certify.anyCompletionClaimPresent([{ event_type: 'run_completed' }], tmp);
  assert.strictEqual(present, true);
});
t('anyCompletionClaimPresent is true on a final-report.md file alone', () => {
  const tmp = mkRoot();
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'final-report.md'), '# Done\n');
  const present = certify.anyCompletionClaimPresent([], tmp);
  assert.strictEqual(present, true);
});
t('anyCompletionClaimPresent is true on a bare subagent_completed event (an agent literally claiming done)', () => {
  const tmp = mkRoot();
  const present = certify.anyCompletionClaimPresent([{ event_type: 'subagent_completed', agent: 'Build Boss', note: 'done' }], tmp);
  assert.strictEqual(present, true);
});

// ==== freeTextPassClaims — informational-only overclaim detector ====
t('freeTextPassClaims flags a subagent_completed note using pass-claiming language (the exact "alle 100 tests groen" class)', () => {
  const hits = certify.freeTextPassClaims([{ event_type: 'subagent_completed', agent: 'Build Boss', note: 'all 100 tests green, ship it' }]);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].agent, 'Build Boss');
});
t('freeTextPassClaims ignores a plain descriptive note with no pass-claiming language', () => {
  const hits = certify.freeTextPassClaims([{ event_type: 'subagent_completed', agent: 'Build Boss', note: 'implemented the parser change' }]);
  assert.strictEqual(hits.length, 0);
});
t('freeTextPassClaims ignores non-completion event types even with pass-claiming language', () => {
  const hits = certify.freeTextPassClaims([{ event_type: 'agent_note', agent: 'Build Boss', note: 'all tests passed' }]);
  assert.strictEqual(hits.length, 0);
});

// ==== 5. ledger_authenticity (unit) ====
t('timestampsInOrder accepts a strictly increasing sequence', () => {
  const r = certify.timestampsInOrder([{ timestamp: ts(0) }, { timestamp: ts(1) }, { timestamp: ts(2) }]);
  assert.strictEqual(r.ok, true);
});
t('timestampsInOrder rejects an out-of-order sequence', () => {
  const r = certify.timestampsInOrder([{ timestamp: ts(5) }, { timestamp: ts(1) }]);
  assert.strictEqual(r.ok, false);
});
t('timestampsInOrder tolerates a missing/unparseable timestamp instead of failing on it', () => {
  const r = certify.timestampsInOrder([{ timestamp: ts(0) }, {}, { timestamp: 'not-a-date' }, { timestamp: ts(1) }]);
  assert.strictEqual(r.ok, true);
});
t('registryCheck is honestly skipped (not a silent pass-through lie) when the registry file is unavailable', () => {
  const tmp = mkRoot();
  const r = certify.registryCheck(tmp, [{ agent: 'Nonexistent Boss' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, true);
});
t('registryCheck flags a dispatch agent not present in a REAL registry file', () => {
  const tmp = mkRoot();
  writeRegistry(tmp, { 'build-boss': { name: 'Build Boss' } });
  const r = certify.registryCheck(tmp, [{ agent: 'Build Boss' }, { agent: 'Nonexistent Boss' }]);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.unknown, ['Nonexistent Boss']);
});
t('registryCheck passes when every dispatch agent is a real registry entry', () => {
  const tmp = mkRoot();
  writeRegistry(tmp, { 'build-boss': { name: 'Build Boss' }, 'test-boss': { name: 'Test Boss' } });
  const r = certify.registryCheck(tmp, [{ agent: 'Build Boss' }, { agent: 'Test Boss' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unknown.length, 0);
});

// ==== integration: certifyRun() on hand-built fixtures ====
t('certifyRun: CERTIFIED on a fully valid hand-built run (dispatch + intact chain + evidenced checks + registry)', () => {
  const tmp = mkRoot();
  writeRegistry(tmp, { 'build-boss': { name: 'Build Boss' }, 'test-boss': { name: 'Test Boss' } });
  writeEventsRaw(tmp, 'runA', toJsonl(buildChain('runA', goodRawEvents())));
  const cert = certify.certifyRun('runA', tmp);
  assert.strictEqual(cert.certified, true, JSON.stringify(cert.criteria, null, 2));
  assert.ok(cert.criteria.every((c) => c.ok));
});
t('certifyRun: NOT CERTIFIED on a genuinely EMPTY run (zero-byte events.jsonl) — never a vacuous pass', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'runEmpty', '');
  const cert = certify.certifyRun('runEmpty', tmp);
  assert.strictEqual(cert.certified, false);
  assert.ok(/empty/i.test(cert.reason));
  // the vacuous-pass bug this project fixed elsewhere: an empty check must never look like "nothing wrong found = pass"
  assert.ok(cert.criteria.every((c) => c.ok === false));
});
t('certifyRun: NOT CERTIFIED when only orchestrator/generic events exist (no real dispatch)', () => {
  const tmp = mkRoot();
  const raw = [
    { event_type: 'run_started', agent: 'orchestrator', timestamp: ts(0) },
    { event_type: 'agent_note', agent: 'orchestrator', note: 'thinking out loud', timestamp: ts(1) },
    { event_type: 'run_completed', agent: 'orchestrator', timestamp: ts(2) },
  ];
  writeEventsRaw(tmp, 'runOrchOnly', toJsonl(buildChain('runOrchOnly', raw)));
  const cert = certify.certifyRun('runOrchOnly', tmp);
  assert.strictEqual(cert.certified, false);
  const c1 = cert.criteria.find((c) => c.id === 1);
  assert.strictEqual(c1.ok, false);
});
t('certifyRun: NOT CERTIFIED on a BROKEN hash chain (a link edited after being written)', () => {
  const tmp = mkRoot();
  const evs = buildChain('runBroken', goodRawEvents());
  evs[4].note = 'edited after hashing — this is the tamper';
  writeEventsRaw(tmp, 'runBroken', toJsonl(evs));
  const cert = certify.certifyRun('runBroken', tmp);
  assert.strictEqual(cert.certified, false);
  const c2 = cert.criteria.find((c) => c.id === 2);
  assert.strictEqual(c2.ok, false);
  // WP-S13 (2.2): the reason text is now log-event.cjs's own strict-reader wording, not certify's old
  // local reimplementation's "self-hash mismatch".
  assert.ok(/recomputed content hash/.test(c2.reason), c2.reason);
});
t('certifyRun: NOT CERTIFIED on a check_passed carrying exit_code:1 (a fake pass)', () => {
  const tmp = mkRoot();
  const raw = goodRawEvents().map((e) => (e.event_type === 'check_passed' ? Object.assign({}, e, { exit_code: 1 }) : e));
  writeEventsRaw(tmp, 'runFakePass', toJsonl(buildChain('runFakePass', raw)));
  const cert = certify.certifyRun('runFakePass', tmp);
  assert.strictEqual(cert.certified, false);
  const c3 = cert.criteria.find((c) => c.id === 3);
  assert.strictEqual(c3.ok, false);
  assert.strictEqual(c3.violations.length, 1);
});
t('certifyRun: NOT CERTIFIED with a fabricated completion claim (final-report.md, zero real work)', () => {
  const tmp = mkRoot();
  const raw = [{ event_type: 'run_started', agent: 'orchestrator', timestamp: ts(0) }, { event_type: 'run_completed', agent: 'orchestrator', timestamp: ts(1) }];
  const dir = writeEventsRaw(tmp, 'runFabricated', toJsonl(buildChain('runFabricated', raw)));
  fs.writeFileSync(path.join(dir, 'final-report.md'), '# All done!\nEverything shipped.\n');
  const cert = certify.certifyRun('runFabricated', tmp);
  assert.strictEqual(cert.certified, false);
  const c4 = cert.criteria.find((c) => c.id === 4);
  assert.strictEqual(c4.ok, false);
  assert.ok(c4.claims.some((s) => /final-report/.test(s)));
});
t('certifyRun: NOT CERTIFIED and never crashes when events.jsonl contains a malformed line', () => {
  const tmp = mkRoot();
  const goodLines = toJsonl(buildChain('runMalformed', goodRawEvents()));
  writeEventsRaw(tmp, 'runMalformed', goodLines + 'THIS IS NOT JSON {{{\n');
  const cert = certify.certifyRun('runMalformed', tmp);
  assert.strictEqual(cert.malformed_lines, 1);
  assert.strictEqual(cert.certified, false);
  const c2 = cert.criteria.find((c) => c.id === 2);
  assert.strictEqual(c2.ok, false);
  assert.ok(/malformed/.test(c2.reason));
});
t('certifyRun: NOT CERTIFIED (never throws) when events.jsonl does not exist at all', () => {
  const tmp = mkRoot();
  const cert = certify.certifyRun('runNoSuchFile', tmp);
  assert.strictEqual(cert.certified, false);
  assert.ok(/missing/.test(cert.reason));
});
t('certifyRun: the certificate carries CONCRETE per-criterion evidence, not bare assertions', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'runEvidence', toJsonl(buildChain('runEvidence', goodRawEvents())));
  const cert = certify.certifyRun('runEvidence', tmp);
  const c1 = cert.criteria.find((c) => c.id === 1);
  assert.ok(Array.isArray(c1.evidence) && c1.evidence.length >= 2 && c1.evidence[0].evIdx != null);
  const c2 = cert.criteria.find((c) => c.id === 2);
  assert.strictEqual(c2.chained, true);
  const c3 = cert.criteria.find((c) => c.id === 3);
  assert.ok(c3.checked_count >= 1);
});
// WP4 CERTIFY FIX — pins the L254 `ts.ok && reg.ok` vs `ts.ok || reg.ok` mutant. Only the timestamp is
// broken here (registry genuinely matches, not skipped) so an OR-mutant would wrongly make c5.ok true.
t('certifyRun: NOT CERTIFIED on an out-of-order timestamp even when the registry genuinely matches every dispatch agent (pins L254 && vs ||)', () => {
  const tmp = mkRoot();
  writeRegistry(tmp, { 'build-boss': { name: 'Build Boss' }, 'test-boss': { name: 'Test Boss' } });
  const raw = goodRawEvents();
  raw[3] = Object.assign({}, raw[3], { timestamp: ts(0) }); // check_passed event's ts goes backwards (was ts(3), now < ts(2))
  writeEventsRaw(tmp, 'runBadTs', toJsonl(buildChain('runBadTs', raw)));
  const cert = certify.certifyRun('runBadTs', tmp);
  const c1 = cert.criteria.find((c) => c.id === 1);
  const c2 = cert.criteria.find((c) => c.id === 2);
  const c4 = cert.criteria.find((c) => c.id === 4);
  const c5 = cert.criteria.find((c) => c.id === 5);
  assert.strictEqual(c1.ok, true, 'c1 must stay ok to isolate c5');
  assert.strictEqual(c2.ok, true, 'c2 must stay ok (chain rebuilt over the modified timestamp, still self-consistent)');
  assert.strictEqual(c4.ok, true, 'c4 must stay ok to isolate c5');
  assert.strictEqual(c5.registry_check.ok, true, 'registry must genuinely MATCH (not be skipped/failed) so ONLY the bad timestamp can break c5');
  assert.strictEqual(c5.registry_check.skipped, false);
  assert.strictEqual(c5.timestamps_in_order, false);
  assert.strictEqual(c5.ok, false, 'AND semantics required: a bad timestamp must fail criterion 5 even though the registry check passed');
  assert.strictEqual(cert.certified, false);
});

// ==== WP4 CERTIFY FIX — checks_verified / CERTIFIED (UNVERIFIED) integration tests (BLOCKER 1) ====
t('certifyRun: checks_verified reflects genuinely evidenced standardized checks on a fully-verified run; plain CERTIFIED label', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'runChecksVerified', toJsonl(buildChain('runChecksVerified', goodRawEvents())));
  const cert = certify.certifyRun('runChecksVerified', tmp);
  assert.strictEqual(cert.checks_verified, 2); // check_passed + quality_gate_passed, both evidenced + exit 0
  assert.strictEqual(cert.unverified_completion, false);
  // 2.2 fix (WP-S13): this hermetic root never writes a FORGE_HARD_RULES.json, so the contract is
  // genuinely unevaluated — the label says so rather than reading as a silent, unremarked CERTIFIED.
  assert.strictEqual(cert.label, 'CERTIFIED (contract not evaluated)');
});
t('certifyRun: CERTIFIED (UNVERIFIED) when zero standardized checks exist but real dispatch + a completion claim do — the exact forge-2026-07-14-hardening shape, this is BLOCKER 1', () => {
  const tmp = mkRoot();
  const raw = [
    { event_type: 'run_started', agent: 'orchestrator', timestamp: ts(0) },
    { event_type: 'agent_note', agent: 'orchestrator', note: 'assign WP', timestamp: ts(1) },
    { event_type: 'subagent_completed', agent: 'Build Boss', role: 'builder', task: 'WP1', status: 'completed', note: 'implemented', timestamp: ts(2) },
    { event_type: 'subagent_completed', agent: 'Test Boss', role: 'qa', task: 'WP1 QA', status: 'completed', note: 'regression looked fine by inspection', timestamp: ts(3) },
  ];
  const dir = writeEventsRaw(tmp, 'runUnverified', toJsonl(buildChain('runUnverified', raw)));
  fs.writeFileSync(path.join(dir, 'final-report.md'), '# WP1 shipped\n');
  const cert = certify.certifyRun('runUnverified', tmp);
  assert.ok(cert.criteria.every((c) => c.ok), JSON.stringify(cert.criteria, null, 2));
  assert.strictEqual(cert.certified, true, 'a genuinely orchestrated run must still certify — exit code stays 0, never rejected');
  assert.strictEqual(cert.checks_verified, 0);
  assert.strictEqual(cert.unverified_completion, true);
  assert.ok(/UNVERIFIED/.test(cert.label));
});
t('certifyRun: surfaces a free-text pass-claim note with ZERO standardized evidence behind it (the exact "alle 100 tests groen" overclaim class)', () => {
  const tmp = mkRoot();
  const raw = [
    { event_type: 'run_started', agent: 'orchestrator', timestamp: ts(0) },
    { event_type: 'subagent_completed', agent: 'Build Boss', task: 'WP1', status: 'completed', note: 'all 100 tests green', timestamp: ts(1) },
  ];
  writeEventsRaw(tmp, 'runLyingNote', toJsonl(buildChain('runLyingNote', raw)));
  const cert = certify.certifyRun('runLyingNote', tmp);
  assert.strictEqual(cert.checks_verified, 0);
  assert.strictEqual(cert.free_text_pass_claims.length, 1);
  assert.ok(/all 100 tests green/.test(cert.free_text_pass_claims[0].note));
});
t('printSummary always prints the checks_verified count', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'runPS1', toJsonl(buildChain('runPS1', goodRawEvents())));
  const cert = certify.certifyRun('runPS1', tmp);
  assert.ok(/checks_verified: 2/.test(certify.printSummary(cert)));
});
t('printSummary shows the loud "CERTIFIED (UNVERIFIED" label instead of a bare CERTIFIED when checks_verified is 0 with a completion claim', () => {
  const tmp = mkRoot();
  const raw = [
    { event_type: 'run_started', agent: 'orchestrator', timestamp: ts(0) },
    { event_type: 'subagent_completed', agent: 'Build Boss', status: 'completed', timestamp: ts(1) },
  ];
  const dir = writeEventsRaw(tmp, 'runPS2', toJsonl(buildChain('runPS2', raw)));
  fs.writeFileSync(path.join(dir, 'final-report.md'), '# done\n');
  const cert = certify.certifyRun('runPS2', tmp);
  assert.ok(/CERTIFIED \(UNVERIFIED/.test(certify.printSummary(cert)));
});
t('printSummary always includes the CAVEAT line (keyless/recomputable chain, no check required to have run)', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'runPS3', toJsonl(buildChain('runPS3', goodRawEvents())));
  const cert = certify.certifyRun('runPS3', tmp);
  const out = certify.printSummary(cert);
  assert.ok(/CAVEAT/.test(out) && /keyless/.test(out));
});

// ==== integration: certifyRun() against a REAL log-event.cjs-produced tmp run ====
t('certifyRun: CERTIFIED against events genuinely produced by the shipped log-event.cjs (not a reimplementation)', () => {
  const tmp = mkRoot();
  const dashDir = path.join(tmp, '.claude', 'forge-dashboard');
  fs.mkdirSync(dashDir, { recursive: true });
  fs.copyFileSync(REAL_LOG_EVENT, path.join(dashDir, 'log-event.cjs'));
  const regDir = path.join(tmp, '.claude', 'config', 'agents');
  fs.mkdirSync(regDir, { recursive: true });
  fs.copyFileSync(REAL_REGISTRY, path.join(regDir, 'agent-registry.json'));
  const logEventCopy = path.join(dashDir, 'log-event.cjs');
  const runId = 'realwriter-run';
  const call = (type, extra) => spawnSync(process.execPath, [logEventCopy, runId, type, JSON.stringify(extra)], { encoding: 'utf8' });

  let r = call('run_started', { agent: 'orchestrator', role: 'lead', note: 'kickoff' });
  assert.strictEqual(r.status, 0, r.stderr);
  r = call('subagent_completed', { agent: 'build-boss', role: 'builder', task: 'WP-x', status: 'completed', note: 'implemented' });
  assert.strictEqual(r.status, 0, r.stderr);
  r = call('check_passed', { agent: 'build-boss', command: 'node forge-certify.test.cjs', output: '30 passed, 0 failed', exit_code: 0 });
  assert.strictEqual(r.status, 0, r.stderr);
  r = call('subagent_completed', { agent: 'test-boss', role: 'qa', task: 'WP-x QA', status: 'completed', evidence: 'regression green' });
  assert.strictEqual(r.status, 0, r.stderr);
  r = call('run_completed', { agent: 'orchestrator', note: 'shipped' });
  assert.strictEqual(r.status, 0, r.stderr);

  const cert = certify.certifyRun(runId, tmp);
  assert.strictEqual(cert.certified, true, JSON.stringify(cert.criteria, null, 2));
});

// ==== CLI-level tests (spawnSync the real forge-certify.cjs, hermetic --root) ====
t('CLI: exit 0 + "CERTIFIED" on a valid hand-built run', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'cliGood', toJsonl(buildChain('cliGood', goodRawEvents())));
  const r = spawnSync(process.execPath, [CLI, 'cliGood', '--root', tmp], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(/CERTIFIED/.test(r.stdout) && !/NOT CERTIFIED/.test(r.stdout));
});
t('CLI: exit 1 + "NOT CERTIFIED" on an empty run', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'cliEmpty', '');
  const r = spawnSync(process.execPath, [CLI, 'cliEmpty', '--root', tmp], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.ok(/NOT CERTIFIED/.test(r.stdout));
});
t('CLI: exit 1 (no crash) when events.jsonl is entirely missing', () => {
  const tmp = mkRoot();
  fs.mkdirSync(tmp, { recursive: true });
  const r = spawnSync(process.execPath, [CLI, 'no-such-run', '--root', tmp], { encoding: 'utf8' });
  assert.ok(r.status === 1 || r.status === 2, 'expected 1 or 2, got ' + r.status);
  assert.strictEqual(r.stderr.includes('TypeError') || r.stderr.includes('Cannot read'), false, 'must not crash: ' + r.stderr);
});
t('CLI: exit 2 on a missing run_id argument (usage error)', () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});
t('CLI: --json prints a single parseable JSON object with certified + criteria[]', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'cliJson', toJsonl(buildChain('cliJson', goodRawEvents())));
  const r = spawnSync(process.execPath, [CLI, 'cliJson', '--root', tmp, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.certified, true);
  assert.strictEqual(parsed.criteria.length, 5);
});
t('CLI: --json exposes checks_verified, unverified_completion, label, free_text_pass_claims (WP4 fields)', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'cliFields', toJsonl(buildChain('cliFields', goodRawEvents())));
  const r = spawnSync(process.execPath, [CLI, 'cliFields', '--root', tmp, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.checks_verified, 2);
  assert.strictEqual(parsed.unverified_completion, false);
  // 2.2 fix (WP-S13): no FORGE_HARD_RULES.json at this hermetic root — contract genuinely not evaluated.
  assert.strictEqual(parsed.label, 'CERTIFIED (contract not evaluated)');
  assert.ok(Array.isArray(parsed.free_text_pass_claims));
});
t('CLI: exit 0 (still accepted) with the loud UNVERIFIED label for a hardening-shaped run (real dispatch, zero standardized checks, a completion claim)', () => {
  const tmp = mkRoot();
  const raw = [
    { event_type: 'run_started', agent: 'orchestrator', timestamp: ts(0) },
    { event_type: 'subagent_completed', agent: 'Build Boss', status: 'completed', timestamp: ts(1) },
  ];
  const dir = writeEventsRaw(tmp, 'cliUnverified', toJsonl(buildChain('cliUnverified', raw)));
  fs.writeFileSync(path.join(dir, 'final-report.md'), '# done\n');
  const r = spawnSync(process.execPath, [CLI, 'cliUnverified', '--root', tmp], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr); // still accepted — exit code contract unchanged
  assert.ok(/CERTIFIED \(UNVERIFIED/.test(r.stdout));
});

// =====================================================================================================
// 2026-07-15 KRITIEKE FIX-RONDE — BUG 2 [HIGH] mirror tests, ORIGINALLY. certify's OWN local
// verifyChain() used to validate the WHOLE events array from index 0 the moment ANY event carried an
// entry_hash, so a legacy prefix (events predating the hash chain) read as "event 0 missing hash
// fields" — indistinguishable from a genuine tamper. The 2026-07-15 fix taught certify to tolerate a
// legacy-unchained PREFIX followed by a valid chained tail.
//
// WP-S13 (2.2, 2026-09-26 laptop re-audit) SUPERSEDES that leniency, deliberately. verifyChain() now
// delegates to log-event.cjs's own strict reader — the EXACT one forge-runcontract.cjs's check() already
// used — and that reader's OWN 2026-08-07 hardening (Codex r5 #4, read log-event.cjs's own doc before
// touching this) rejects ANY unchained entry once a log contains even one chained entry, regardless of
// position, to stop an attacker inserting hashless "evidence" before a real chain. So a legacy-prefix
// run that later adopts hash-chaining can no longer pass EITHER tool's strict completion gate — this was
// already forge-runcontract.cjs's shipped behaviour; certify's own criterion 2 simply no longer disagrees
// with it. The tests below were updated to assert the new, single, shared truth instead of the old
// certify-only leniency.
// =====================================================================================================
function buildChainFrom(runId, rawEvents, startPrevHash) {
  let prevHash = startPrevHash;
  const out = [];
  for (const raw of rawEvents) {
    const ev = Object.assign({ run_id: runId }, raw);
    ev.prev_hash = prevHash;
    const canon = certify.chainCanon(ev);
    ev.entry_hash = crypto.createHash('sha256').update(canon + prevHash).digest('hex');
    prevHash = ev.entry_hash;
    out.push(ev);
  }
  return out;
}

t('verifyChain 2.2: a legacy prefix (no entry_hash) followed by a valid chained tail is now REJECTED (matches forge-runcontract.cjs check(), no longer a certify-only leniency)', () => {
  const legacy = [
    { run_id: 'r5', event_type: 'run_started', agent: 'orchestrator', timestamp: ts(0) },
    { run_id: 'r5', event_type: 'agent_note', agent: 'orchestrator', note: 'legacy note', timestamp: ts(1) },
  ];
  // mirrors log-event.cjs's fixed prev_hash lookup: the first NEW chained event points to genesis, since
  // no prior event in the file had an entry_hash yet.
  const chainedTail = buildChainFrom('r5', [
    { event_type: 'agent_progress', agent: 'orchestrator', note: 'continuation', timestamp: ts(2) },
  ], 'genesis:r5');
  const evs = legacy.concat(chainedTail);
  const r = certify.verifyChain(writeChainFixture('r5', evs), 'r5');
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.ok(/unchained entry/.test(r.reason), r.reason);
});
t('verifyChain 2.2: a real tamper in the chained TAIL of a legacy+continuation run is STILL rejected (for the mixed-log reason now, not masked)', () => {
  const legacy = [
    { run_id: 'r6', event_type: 'run_started', agent: 'orchestrator', timestamp: ts(0) },
    { run_id: 'r6', event_type: 'agent_note', agent: 'orchestrator', note: 'legacy note', timestamp: ts(1) },
  ];
  const chainedTail = buildChainFrom('r6', [
    { event_type: 'agent_progress', agent: 'orchestrator', note: 'first chained', timestamp: ts(2) },
    { event_type: 'agent_progress', agent: 'orchestrator', note: 'second chained', timestamp: ts(3) },
  ], 'genesis:r6');
  chainedTail[1].note = 'TAMPERED AFTER HASHING'; // self-hash now stale for this event
  const evs = legacy.concat(chainedTail);
  const r = certify.verifyChain(writeChainFixture('r6', evs), 'r6');
  assert.strictEqual(r.ok, false, 'a mixed legacy+chained run with an ADDITIONAL tail tamper must still never read as ok:true');
});
t('verifyChain BUG2: still rejects a run with NO hash fields at all (unchanged legacy/unchained behavior)', () => {
  const legacyOnly = [
    { run_id: 'r7', event_type: 'run_started', agent: 'orchestrator', timestamp: ts(0) },
    { run_id: 'r7', event_type: 'agent_note', agent: 'orchestrator', note: 'legacy note', timestamp: ts(1) },
  ];
  const r = certify.verifyChain(writeChainFixture('r7', legacyOnly), 'r7');
  assert.strictEqual(r.ok, false);
  assert.ok(/no hash-chain present/.test(r.reason));
});
t('certifyRun 2.2: a legacy run continued via the REAL log-event.cjs is now honestly NOT CERTIFIED by proof_integrity (matches forge-runcontract.cjs\'s own already-shipped strict policy, not a false tamper claim)', () => {
  const tmp = mkRoot();
  const runId = 'legacy-continued-real';
  const runDir = runsDirOf(tmp, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const legacyEvents = [
    { run_id: runId, event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
    { run_id: runId, event_type: 'subagent_completed', agent: 'build-boss', task: 'legacy WP', status: 'completed', timestamp: '2026-01-01T00:00:01.000Z' },
  ];
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), legacyEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const dashDir = path.join(tmp, '.claude', 'forge-dashboard');
  fs.mkdirSync(dashDir, { recursive: true });
  const logEventCopy = path.join(dashDir, 'log-event.cjs');
  fs.copyFileSync(REAL_LOG_EVENT, logEventCopy);
  const r = spawnSync(process.execPath, [logEventCopy, runId, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'continuation after adopting hash chain' })], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const cert = certify.certifyRun(runId, tmp);
  const c2 = cert.criteria.find((c) => c.id === 2);
  assert.strictEqual(c2.ok, false, JSON.stringify(c2));
  assert.ok(/unchained entry/.test(c2.reason), c2.reason);
});

// =====================================================================================================
// 2026-07-15 KRITIEKE FIX-RONDE — BUG 3 [MEDIUM] mirror test: certify's readEventsJsonl already tolerated
// a blank internal line; this pins that certifyRun stays certified on the SAME fixture doctor's
// chainCheck was fixed for (see forge-doctor.test.cjs), proving both tools now agree.
// =====================================================================================================
t('certifyRun BUG3: an internal blank line in events.jsonl does not affect certification (already-correct behavior, pinned against regression)', () => {
  const tmp = mkRoot();
  const evs = buildChain('blankline-run', goodRawEvents());
  const lines = evs.map((e) => JSON.stringify(e));
  lines.splice(2, 0, ''); // blank line in the middle
  writeEventsRaw(tmp, 'blankline-run', lines.join('\n') + '\n');
  const cert = certify.certifyRun('blankline-run', tmp);
  assert.strictEqual(cert.malformed_lines, 0);
  assert.strictEqual(cert.certified, true, JSON.stringify(cert.criteria, null, 2));
});

// =====================================================================================================
// D6 fix (2026-09-26, fresh-laptop re-audit) — certify must not say CERTIFIED over a red run contract.
// REPRODUCED (executed replay of a real mission): certify reported CERTIFIED while the SAME run's own
// forge-runcontract.cjs reported 4 missing rules — the existing CAVEAT text already named this gap in
// prose ("does NOT require that any check actually ran"); these tests pin that the LABEL/verdict now
// agrees with it. A contract this tool cannot even compute (no FORGE_HARD_RULES.json at this hermetic
// root — every OTHER test above never sets one up) must keep degrading to "not evaluated", never a
// fabricated pass NOR a fabricated fail — proven first so the RED tests below isolate the real signal.
// =====================================================================================================
function writeHardRules(tmp, rules) {
  const dir = path.join(tmp, '.claude', 'config', 'orchestration');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'FORGE_HARD_RULES.json'), JSON.stringify({ owners_allowlist: [], rules }, null, 2), 'utf8');
}
const BLOCK_RULE_NEVER_SATISFIED = { id: 'missing-thing', rule: 'must log a thing that never happens', trigger: 'always', check: { type: 'event-present', key: 'thing_that_never_happens' }, severity: 'block', override: 'can be overridden by the owner', source: 'test' };
const BLOCK_RULE_ALWAYS_SATISFIED = { id: 'dispatch-happened', rule: 'a named boss must have dispatched', trigger: 'always', check: { type: 'event-present', key: 'subagent_completed' }, severity: 'block', override: 'can be overridden by the owner', source: 'test' };

t('certifyRun D6 baseline: with NO FORGE_HARD_RULES.json at this root, the contract is honestly "not evaluated" and never counts against certified', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'runD6NoRules', toJsonl(buildChain('runD6NoRules', goodRawEvents())));
  const cert = certify.certifyRun('runD6NoRules', tmp);
  assert.strictEqual(cert.contract.evaluated, false, JSON.stringify(cert.contract));
  assert.strictEqual(cert.contract.ok, null);
  assert.strictEqual(cert.certified, true, 'an uncomputable contract must not fabricate a fail');
  // 2.2 fix (WP-S13): the label itself now names an unevaluated contract, never a silent, unremarked
  // CERTIFIED — see the dedicated "(contract not evaluated)" test further down.
  assert.strictEqual(cert.label, 'CERTIFIED (contract not evaluated)');
});

t('certifyRun D6: a contract that genuinely evaluates ok:true leaves an otherwise-CERTIFIED run unaffected', () => {
  const tmp = mkRoot();
  writeHardRules(tmp, [BLOCK_RULE_ALWAYS_SATISFIED]);
  writeEventsRaw(tmp, 'runD6Green', toJsonl(buildChain('runD6Green', goodRawEvents())));
  const cert = certify.certifyRun('runD6Green', tmp);
  assert.strictEqual(cert.contract.evaluated, true, JSON.stringify(cert.contract));
  assert.strictEqual(cert.contract.ok, true, JSON.stringify(cert.contract));
  assert.strictEqual(cert.certified, true);
  assert.strictEqual(cert.label, 'CERTIFIED');
});

t('certifyRun D6 (THE FIX): a contract this tool genuinely computes, and that is RED, pulls an otherwise-CERTIFIED run down to NOT CERTIFIED', () => {
  const tmp = mkRoot();
  writeHardRules(tmp, [BLOCK_RULE_NEVER_SATISFIED]);
  writeEventsRaw(tmp, 'runD6Red', toJsonl(buildChain('runD6Red', goodRawEvents())));
  const cert = certify.certifyRun('runD6Red', tmp);
  assert.ok(cert.criteria.every((c) => c.ok), 'the 5 black-box criteria alone must still be green on this fixture: ' + JSON.stringify(cert.criteria, null, 2));
  assert.strictEqual(cert.contract.evaluated, true, JSON.stringify(cert.contract));
  assert.strictEqual(cert.contract.ok, false, JSON.stringify(cert.contract));
  assert.ok(cert.contract.missing.includes('missing-thing'), JSON.stringify(cert.contract.missing));
  assert.strictEqual(cert.certified, false, 'D6: certify must never say CERTIFIED over a red run contract');
  assert.ok(/NOT CERTIFIED/.test(cert.label) && /run contract is red/.test(cert.label), cert.label);
});

t('printSummary D6: names the red run contract in the human-readable summary, keeps the existing CAVEAT text', () => {
  const tmp = mkRoot();
  writeHardRules(tmp, [BLOCK_RULE_NEVER_SATISFIED]);
  writeEventsRaw(tmp, 'runD6Summary', toJsonl(buildChain('runD6Summary', goodRawEvents())));
  const cert = certify.certifyRun('runD6Summary', tmp);
  const out = certify.printSummary(cert);
  assert.ok(/run contract: RED/.test(out), out);
  assert.ok(/CAVEAT/.test(out) && /does NOT require that any check actually ran/.test(out), out);
});

t('CLI D6: exit 1 + NOT CERTIFIED naming the red run contract', () => {
  const tmp = mkRoot();
  writeHardRules(tmp, [BLOCK_RULE_NEVER_SATISFIED]);
  writeEventsRaw(tmp, 'cliD6Red', toJsonl(buildChain('cliD6Red', goodRawEvents())));
  const r = spawnSync(process.execPath, [CLI, 'cliD6Red', '--root', tmp], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.ok(/NOT CERTIFIED/.test(r.stdout));
  assert.ok(/run contract/.test(r.stdout), r.stdout);
});

t('CLI D6 --json: exposes the contract field so a caller can see WHY certification was refused', () => {
  const tmp = mkRoot();
  writeHardRules(tmp, [BLOCK_RULE_NEVER_SATISFIED]);
  writeEventsRaw(tmp, 'cliD6Json', toJsonl(buildChain('cliD6Json', goodRawEvents())));
  const r = spawnSync(process.execPath, [CLI, 'cliD6Json', '--root', tmp, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.certified, false);
  assert.strictEqual(parsed.contract.evaluated, true);
  assert.strictEqual(parsed.contract.ok, false);
});

// =====================================================================================================
// WP-S13 (2.2, 2026-09-26 laptop re-audit, review C VERDICT FAIL) — THE FIX. REPRODUCED bug: a run with a
// red contract prepends one unchained, timestamped agent_note line (or forks a prev_hash) — c2 (the old,
// weaker local reimplementation) passed, check() threw on the damaged log, and contractState() swallowed
// that exception as "not evaluated — not held against this certificate", so the label went right back to
// CERTIFIED. Fixed on two independent legs: (1) check()'s readEventsJsonl now tags a damaged-log exception
// (`forgeLogDamaged`) so contractState() reports it as evaluated:true, ok:false, never "not evaluated";
// (2) c2 itself now uses the exact same strict reader check() uses, so it can no longer disagree in the
// first place. Both tests below combine a genuinely RED rules file (BLOCK_RULE_NEVER_SATISFIED) with a
// damaged log, and assert the certificate is NOT CERTIFIED via BOTH signals (contract AND c2).
// =====================================================================================================
t('certifyRun 2.2 (THE FIX): a red run with ONE PREPENDED UNCHAINED agent_note line is NOT CERTIFIED (was: silently re-CERTIFIED via a swallowed "not evaluated")', () => {
  const tmp = mkRoot();
  writeHardRules(tmp, [BLOCK_RULE_NEVER_SATISFIED]);
  const runId = 'runS13PrependedUnchained';
  const chained = buildChain(runId, goodRawEvents());
  const prepended = { run_id: runId, event_type: 'agent_note', agent: 'orchestrator', note: 'unchained injected line', timestamp: '2026-07-13T23:59:59.000Z' };
  writeEventsRaw(tmp, runId, toJsonl([prepended, ...chained]));
  const cert = certify.certifyRun(runId, tmp);
  const c2 = cert.criteria.find((c) => c.id === 2);
  assert.strictEqual(cert.certified, false, JSON.stringify({ label: cert.label, contract: cert.contract, c2 }));
  assert.strictEqual(cert.contract.evaluated, true, JSON.stringify(cert.contract));
  assert.strictEqual(cert.contract.ok, false, JSON.stringify(cert.contract));
  assert.strictEqual(c2.ok, false, JSON.stringify(c2));
  assert.ok(/NOT CERTIFIED/.test(cert.label), cert.label);
});
t('certifyRun 2.2 (THE FIX): a red run with a FORKED prev_hash (self-consistent per-event, but positionally broken) is NOT CERTIFIED', () => {
  const tmp = mkRoot();
  writeHardRules(tmp, [BLOCK_RULE_NEVER_SATISFIED]);
  const runId = 'runS13ForkedPrevHash';
  const evs = buildChain(runId, goodRawEvents());
  // Fork: point evs[3] at evs[1]'s hash instead of its real predecessor evs[2] — then recompute so evs[3]
  // is internally self-consistent (its OWN entry_hash matches its OWN prev_hash+content). This is exactly
  // the "forked-but-self-consistent event" shape review C names — no single event looks tampered in
  // isolation, only the POSITIONAL link is broken.
  evs[3].prev_hash = evs[1].entry_hash;
  evs[3].entry_hash = crypto.createHash('sha256').update(certify.chainCanon(evs[3]) + evs[3].prev_hash).digest('hex');
  writeEventsRaw(tmp, runId, toJsonl(evs));
  const cert = certify.certifyRun(runId, tmp);
  const c2 = cert.criteria.find((c) => c.id === 2);
  assert.strictEqual(cert.certified, false, JSON.stringify({ label: cert.label, contract: cert.contract, c2 }));
  assert.strictEqual(cert.contract.evaluated, true, JSON.stringify(cert.contract));
  assert.strictEqual(cert.contract.ok, false, JSON.stringify(cert.contract));
  assert.strictEqual(c2.ok, false, JSON.stringify(c2));
  assert.ok(/NOT CERTIFIED/.test(cert.label), cert.label);
});
t('contractState 2.2: label carries "(contract not evaluated)" when the contract genuinely cannot be computed (no FORGE_HARD_RULES.json here), never a silent unremarked CERTIFIED', () => {
  const tmp = mkRoot();
  writeEventsRaw(tmp, 'runS13NoRulesLabel', toJsonl(buildChain('runS13NoRulesLabel', goodRawEvents())));
  const cert = certify.certifyRun('runS13NoRulesLabel', tmp);
  assert.strictEqual(cert.contract.evaluated, false, JSON.stringify(cert.contract));
  assert.strictEqual(cert.certified, true, 'an uncomputable contract must not fabricate a fail');
  assert.ok(/\(contract not evaluated\)/.test(cert.label), cert.label);
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
