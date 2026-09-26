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
 *                                 prev_hash)) is intact for this run. WP-S13 (2.2, 2026-09-26): delegates
 *                                 to forge-dashboard/log-event.cjs's own `readEventsClassified({verifyChain:
 *                                 true, runId})` — the EXACT SAME strict reader forge-runcontract.cjs's
 *                                 check() uses — so this criterion can never again be weaker than the run
 *                                 contract's own judgement of the same log (review C VERDICT FAIL, 2.2:
 *                                 certify's OWN prior chain reimplementation tolerated a damaged log the
 *                                 contract itself refused to judge). Any malformed JSONL line also
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
 *   registryCheck, loadProjectAgentNames, GENERIC_AGENTS, DISPATCH_EVENT_TYPES, PROOF_NEED,
 *   EXIT_CODE_ASSERTION_EVENTS, FREE_TEXT_PASS_PATTERNS, printSummary }
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

// ---- criterion 2: hash-chain integrity ----
// chainCanon is kept for fixture-building (this file's own tests reuse it to hand-construct a valid
// chain the exact same way log-event.cjs's writer does) — it is byte-identical to log-event.cjs's own
// canonicalization, just no longer used by verifyChain() itself (see below).
function chainCanon(ev) {
  const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort();
  const o = {}; for (const x of k) o[x] = ev[x];
  return JSON.stringify(o);
}
/** verifyChain(eventsPath, runId) -> {ok, chained, status, reason}.
 *
 *  WP-S13 (2.2, 2026-09-26 laptop re-audit, review C VERDICT FAIL) — REBUILT from a from-scratch local
 *  reimplementation into a thin wrapper over forge-dashboard/log-event.cjs's own
 *  `readEventsClassified(eventsPath, {verifyChain:true, runId})` — the EXACT SAME strict reader
 *  forge-runcontract.cjs's check() uses to decide whether a completion contract can trust this log at
 *  all. Single source of truth: this criterion can never again independently disagree with the run
 *  contract about the same log.
 *
 *  REPRODUCED (the bug this closes): the old local reimplementation tolerated a legacy-unchained-PREFIX
 *  followed by a valid chained tail (a deliberate, documented leniency from a 2026-07-15 fix, BUG2) — but
 *  log-event.cjs's OWN 2026-08-07 hardening (Codex r5 #4) later made the STRICT reader reject ANY
 *  unchained entry once a log contains even one chained entry, regardless of position, specifically to
 *  stop an attacker inserting hashless "evidence" events before a real chain. forge-runcontract.cjs
 *  adopted that stricter reader; certify's own local copy never did, so the exact same log could read
 *  "chain OK" here while check() genuinely refused it — the mismatch this fix closes. A run that
 *  continues a legacy log by adopting hash-chaining can therefore no longer pass this criterion either —
 *  consistent with forge-runcontract.cjs's own already-shipped behaviour ("a run can never pass a strict
 *  completion gate again" once it mixes chained and unchained entries), not a new restriction invented
 *  here.
 *
 *  A run with NO entry_hash ANYWHERE (fully legacy/unchained) is still, deliberately, "cannot be
 *  verified" here (unchanged from before this rebuild) — log-event.cjs's classifier reports such a run as
 *  merely 'valid' (nothing to contradict), but proof_integrity specifically wants to see a REAL chain
 *  before trusting it; a vacuous absence of contradictions is not proof of integrity. */
function verifyChain(eventsPath, runId) {
  let M;
  try { M = require(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs')); }
  catch (e) {
    return { ok: false, chained: false, status: 'unreadable', reason: 'de event-classifier (log-event.cjs) kon niet worden geladen: ' + (e && e.message ? e.message : String(e)) + ' — zonder ketenvalidatie is proof_integrity niet te vertrouwen (fail-closed)' };
  }
  if (!M || typeof M.readEventsClassified !== 'function') {
    return { ok: false, chained: false, status: 'unreadable', reason: 'log-event.cjs levert geen readEventsClassified() — deze installatie kan de hashketen niet verifiëren (fail-closed)' };
  }
  let cls;
  try { cls = M.readEventsClassified(eventsPath, { verifyChain: true, runId }); }
  catch (e) { return { ok: false, chained: false, status: 'unreadable', reason: 'readEventsClassified faalde: ' + (e && e.message ? e.message : String(e)) }; }
  if (!cls || typeof cls !== 'object') return { ok: false, chained: false, status: 'unreadable', reason: 'readEventsClassified leverde geen resultaat' };
  if (cls.status === 'missing') return { ok: false, chained: false, status: cls.status, reason: 'events.jsonl ontbreekt of is onleesbaar: ' + (cls.error || 'missing') };
  if (cls.status === 'empty') return { ok: true, chained: false, status: cls.status, reason: '' };
  if (cls.status === 'partial' || cls.status === 'corrupt') {
    const badDesc = (cls.badLines || []).map((b) => b.line + (b.reason ? ':' + b.reason : '')).join(', ');
    return { ok: false, chained: true, status: cls.status, reason: 'events log is ' + cls.status.toUpperCase() + ' (' + badDesc + ')' };
  }
  // status === 'valid': schema + hashketen zijn intact voor elk GEKETEND event; een volledig ongeketende
  // log leest hier ook 'valid' (niets om te weerspreken) — dat is geen keten, dus geen bewijs van
  // integriteit. Alleen ECHT geketende events tellen als proof_integrity.
  const hadChain = Array.isArray(cls.entries) && cls.entries.some((e) => e && typeof e === 'object' && e.entry_hash !== undefined);
  if (!hadChain) {
    return { ok: false, chained: false, status: cls.status, reason: 'no hash-chain present on any event (legacy/unchained run) — tamper-evidence cannot be verified' };
  }
  return { ok: true, chained: true, status: cls.status, reason: '' };
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
// loadProjectAgentNames (2026-08-01, "pakket 1") — MIRRORS log-event.cjs's loadProjectAgents() (read that
// file's comment first). The 12 permanent Bosses are not the only agents that really exist: `.claude/agents/
// *.md` also defines optional on-request specialists (verify-boss, codex-reviewer, data-scientist, …). Since
// log-event.cjs now ACCEPTS a dispatch event from one of those (backed by a real definition file on disk),
// this criterion had to learn the same fact — otherwise the very act of letting verify-boss record its
// verdict would flip its run to NOT CERTIFIED for an "unregistered agent name" that is demonstrably a real,
// on-disk agent. The check is NOT weakened: a name with no registry entry AND no agent file (a fabricated
// "phantom-boss") still fails exactly as before, and a real definition file is real evidence, not a claim.
function loadProjectAgentNames(root) {
  const dir = path.join(path.resolve(root), '.claude', 'agents');
  const names = new Set();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')); } catch { return names; }
  for (const f of files) {
    const base = f.replace(/\.md$/i, '');
    let declared = null;
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (fm) { const n = fm[1].match(/^name:\s*(.+)$/m); if (n) declared = n[1].trim().replace(/^["']|["']$/g, ''); }
    } catch { /* unreadable agent file — fall back to the filename, never guess a different agent */ }
    const display = declared || base;
    for (const alias of [base, display, String(display).replace(/-/g, ' ')]) {
      const key = String(alias).toLowerCase();
      if (key) names.add(key);
    }
  }
  return names;
}
function registryCheck(root, dispatchHits) {
  const names = loadRegistryNames(root);
  if (!names) return { ok: true, skipped: true, reason: 'agent-registry.json unavailable — optional cross-check skipped', unknown: [] };
  const projectAgents = loadProjectAgentNames(root);
  const unknown = [];
  const projectAgentHits = [];
  for (const h of dispatchHits) {
    const key = String(h.agent).toLowerCase();
    if (names.has(key)) continue;
    if (projectAgents.has(key)) { projectAgentHits.push(h.agent); continue; } // real agent file on disk, not a permanent Boss
    unknown.push(h.agent);
  }
  const uniqueUnknown = Array.from(new Set(unknown));
  // project_agents is reported, never hidden: a run whose work was done by optional specialists rather than
  // permanent Bosses is certifiable, but a reader can still see that from the certificate.
  return { ok: uniqueUnknown.length === 0, skipped: false, unknown: uniqueUnknown, project_agents: Array.from(new Set(projectAgentHits)) };
}

// ---- D6 fix (2026-09-26, fresh-laptop re-audit): certify must not say CERTIFIED over a red run contract --
// forge-runcontract.cjs judges a DIFFERENT, stricter question (did this run satisfy every APPLICABLE
// FORGE_HARD_RULES.json obligation) than the five criteria above (is this log internally consistent and not
// fabricated). REPRODUCED (executed replay of a real mission): certify reported CERTIFIED while the same
// run's own contract reported 4 missing rules — a reader sees "CERTIFIED" and reasonably reads that as "this
// run is done", which the contract already disproves. The existing CAVEAT text ("does NOT require that any
// check actually ran") already NAMES this gap in prose; this makes the LABEL agree with it: a contract this
// tool can genuinely COMPUTE and that comes back red pulls the label down to NOT CERTIFIED too.
// Lazy require (same single-source-of-truth discipline every sibling *-gate tool in this project already
// follows — never re-implement the contract's own rule logic here) — an unavailable module degrades to
// "not evaluated", never a fabricated pass NOR a fabricated fail.
let _runcontractCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadRuncontractTool() {
  if (_runcontractCache !== undefined) return _runcontractCache;
  try { _runcontractCache = require('./forge-runcontract.cjs'); } catch { _runcontractCache = null; }
  return _runcontractCache;
}
/** contractState(runId, root) -> {evaluated, ok, missing, reason}. `evaluated:false` covers ONLY a
 * genuine INFRASTRUCTURE reason the contract could not be computed at all — module unavailable, no
 * FORGE_HARD_RULES.json at this root, an invalid run_id, or any other exception forge-runcontract.cjs's
 * check() throws that is NOT itself a fact about this run's own log. This NEVER counts against
 * `certified` below, exactly like registryCheck()'s own honest "skipped" discipline — but see the D6/2.2
 * note printed by the caller: an `evaluated:false` result must always be LABELED "(contract not
 * evaluated)", never presented as a silent, unremarked part of a clean CERTIFIED.
 *
 * WP-S13 (2.2, 2026-09-26 laptop re-audit, review C VERDICT FAIL) — REBUILT. The previous version
 * treated ANY exception from check() — including a DAMAGED LOG (check()'s own strict reader throws when
 * the hash chain is corrupt/partial, an entirely different and far more serious fact than "no rules file
 * here") — identically as "not evaluated — not held against this certificate". REPRODUCED: a run with a
 * genuinely red contract (missing rules) got its damaged log turned into an "infrastructure could not
 * compute this" excuse the moment ONE unchained line was prepended (or a prev_hash forked), because
 * check() throws on read, before it ever gets to judge a single rule — `evaluated:false` swallowed that
 * fact instead of surfacing it, and the D6 guard (`contractRed`) never fired. check()'s readEventsJsonl
 * now TAGS that specific class of exception (`err.forgeLogDamaged === true` — see its own doc) so this
 * function can tell "the log itself is damaged" (a REAL, damning fact about this run — evaluated:true,
 * ok:false) apart from "this tool genuinely could not compute anything" (module/rules missing —
 * evaluated:false, unchanged). */
function contractState(runId, root) {
  const mod = loadRuncontractTool();
  if (!mod || typeof mod.check !== 'function') {
    return { evaluated: false, ok: null, missing: [], reason: 'forge-runcontract.cjs unavailable — contract not consulted' };
  }
  try {
    const r = mod.check({ run_id: runId }, { root });
    return {
      evaluated: true, ok: r.ok === true, missing: Array.isArray(r.missing) ? r.missing : [],
      reason: r.ok === true ? '' : 'the run contract reports ' + (Array.isArray(r.missing) ? r.missing.length : 0) + ' unmet rule(s): ' + (Array.isArray(r.missing) ? r.missing.join(', ') : ''),
    };
  } catch (e) {
    if (e && e.forgeLogDamaged === true) {
      return {
        evaluated: true, ok: false, missing: [],
        reason: 'the run contract could not judge a single rule because the events log itself is damaged (' + (e && e.message ? e.message : String(e)) + ') — a damaged log is a red contract, never an unevaluated one',
      };
    }
    return { evaluated: false, ok: null, missing: [], reason: 'the run contract could not be evaluated (' + (e && e.message ? e.message : String(e)) + ') — not held against this certificate' };
  }
}

// ---- the certificate ----
function notCertified(runId, root, reason, extra) {
  return Object.assign({
    run_id: runId, root, certified: false, event_count: 0, malformed_lines: (extra && extra.malformed) || 0,
    reason,
    checks_verified: 0, unverified_completion: false, free_text_pass_claims: [], label: 'NOT CERTIFIED',
    contract: { evaluated: false, ok: null, missing: [], reason: 'not evaluated — ' + reason },
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
  const eventsPath = path.join(runDir, 'events.jsonl');
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

  const chain = verifyChain(eventsPath, runId);
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
  const criteriaOk = criteria.every((c) => c.ok);

  // D6 fix: a contract this tool genuinely computed and that reports ok:false is the ONE thing that can
  // pull an otherwise-CERTIFIED run down — an infrastructure-only "not evaluated" contract never does.
  const contract = contractState(runId, root);
  const contractRed = contract.evaluated && contract.ok === false;
  const certified = criteriaOk && !contractRed;

  // checks_verified / CERTIFIED (UNVERIFIED) gate — see header CAVEAT/WP4 note. certified stays exactly
  // what the 5 criteria (and, per D6, the run contract) say (unchanged exit-code semantics); this only
  // decides the human-facing LABEL.
  const completionClaimExists = anyCompletionClaimPresent(events, runDir);
  const unverifiedCompletion = certified && checksVerified === 0 && completionClaimExists;
  const freeTextClaims = freeTextPassClaims(events);
  /** 2.2 fix (WP-S13, 2026-09-26 laptop re-audit) — `contract.evaluated === false` means this tool
   *  genuinely could not compute the contract at all (module/rules missing — see contractState's doc).
   *  That must NEVER read as a silent, unremarked part of an otherwise-clean CERTIFIED/NOT CERTIFIED
   *  label — a reader who only sees the label must be told the contract said nothing either way, not
   *  assume it was checked and passed. `contractRed`'s own branch never needs this note: it only fires
   *  when `contract.evaluated` is true. */
  const contractNotEvaluatedNote = contract.evaluated ? '' : ' (contract not evaluated)';
  const label = !certified
    ? (contractRed && criteriaOk ? 'NOT CERTIFIED — run contract is red (' + contract.reason + ')' : 'NOT CERTIFIED' + contractNotEvaluatedNote)
    : (unverifiedCompletion
        ? 'CERTIFIED (UNVERIFIED — no standardized checks; completion rests on free-text claims)' + contractNotEvaluatedNote
        : 'CERTIFIED' + contractNotEvaluatedNote);

  return {
    run_id: runId, root, certified, event_count: events.length, malformed_lines: malformed,
    checks_verified: checksVerified, unverified_completion: unverifiedCompletion,
    free_text_pass_claims: freeTextClaims, label, contract,
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
  if (cert.contract) {
    lines.push('  run contract: ' + (cert.contract.evaluated ? (cert.contract.ok ? 'satisfied' : 'RED — ' + cert.contract.reason) : 'not evaluated (' + cert.contract.reason + ')'));
  }
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
  loadRegistryNames, loadProjectAgentNames, readEventsJsonl,
  GENERIC_AGENTS, DISPATCH_EVENT_TYPES, PROOF_NEED, EXIT_CODE_ASSERTION_EVENTS, FREE_TEXT_PASS_PATTERNS, printSummary,
  // D6 fix (2026-09-26): exported so a test can force a specific contract outcome without a real
  // FORGE_HARD_RULES.json fixture, and so a caller can inspect the lazy-loaded module directly.
  contractState, loadRuncontractTool,
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
