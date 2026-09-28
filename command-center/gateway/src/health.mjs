// GET /api/health composition: this gateway's own pulse + a fixed, honest note that the legacy
// Control Center is retired + the newest doctor receipt found on disk. Every sub-state uses the
// truthful-state vocabulary from masterprompt.txt §6 (UNKNOWN/UNAVAILABLE/NOT CONFIGURED/
// CONNECTING/DISCONNECTED/DEGRADED/RATE LIMITED/STALE/PARTIAL/BLOCKED/FAILED/UNVERIFIED/
// INSUFFICIENT EVIDENCE) — "CONNECTED" is this file's one added positive counterpart to
// DISCONNECTED, since the vocabulary lists failure states, not their opposites (used by
// doctor_last below). RETIRED is a fixed state of its own: forge.control_center below, not a
// live probe result.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, FORGE_RUNS_DIR } from './paths.mjs';
// P2-12 fix, part (a) (cc-fix-gateway-perf, forge-2026-07-29-cc-finish): the dashboard's health-poll
// (every 5s) was calling the full GET /api/conversations endpoint a SECOND time purely to read the
// `execution` field (server.mjs already returns it on /api/conversations — see that route) —
// needlessly paying conversations.mjs's full listConversations() cost just for one small object that
// has nothing to do with conversations. executionAvailability() is cheap (the real CLI path is
// resolved once and cached for the process lifetime, see exec-bridge.mjs) so exposing it here too is
// free. Handoff: removing the dashboard's now-redundant second /api/conversations call is
// dashboard/-scoped and out of this WP's write scope — flagged in the forge-report.
import { executionAvailability } from './exec-bridge.mjs';

// WP-N2 (Forge 2.9.0): the per-project Control Center (`.claude/forge-dashboard/server.cjs` and
// its UI, ports 3737-3999) was removed from Forge — this Command Center is now the one dashboard
// for every project. Before this fix, `forge.control_center` was a real HTTP probe (with a 5s
// micro-cache) against that now-nonexistent server, which could only ever resolve to DISCONNECTED
// — a network call that always fails is not a health signal, it is dead weight. Replaced with a
// fixed, honest note: no port file is read, no HTTP request is made, and there is nothing to
// cache or expire.
const CONTROL_CENTER_RETIRED = Object.freeze({
  state: 'RETIRED',
  note: 'The per-project Control Center was removed in Forge 2.9.0; this Command Center is the dashboard.',
});

// WP-CC1 (item 15): a standalone `<run>/doctor.json` is the OLD, now-rare shape (5 of this
// project's 30+ runs have one, all from July) — the modern shape is a doctor GATE entry inside
// `<run>/gate-evidence.json` (`gates[].name` matching /doctor/i), whose full raw JSON output
// (identical `{checks:{tests:{suites,passed,failed,ok}}}` shape) lives at the gate's own
// `output_file` (LOCAL-only, gitignored — see gate-evidence.json's own header comment; absent on a
// machine that never ran the gate, or after cleanup, which is honestly UNAVAILABLE, never a
// fabricated tally). Exported so proof.mjs can read the SAME per-run doctor tally without a second
// implementation of "find the doctor gate and parse its output" (item 10's own "doctor test
// numbers" bullet).
const DOCTOR_GATE_NAME_RE = /doctor/i;
const MAX_GATE_OUTPUT_READ_BYTES = 8 * 1024 * 1024; // generous headroom over this fleet's real ~1MB doctor dumps

function readDoctorTallyFromOutputFile(outputFilePath, projectRoot) {
  const resolved = path.isAbsolute(outputFilePath) ? outputFilePath : path.join(projectRoot, outputFilePath);
  let stat;
  try { stat = fs.statSync(resolved); } catch { return null; }
  if (stat.size > MAX_GATE_OUTPUT_READ_BYTES) return null; // honestly unavailable rather than a slow/unbounded read
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const tests = parsed.checks && parsed.checks.tests ? parsed.checks.tests : null;
  return {
    ok: !!parsed.ok,
    suites: tests ? tests.suites : undefined,
    passed: tests ? tests.passed : undefined,
    failed: tests ? tests.failed : undefined,
  };
}

/** readDoctorTallyForRun(runDir, projectRoot) -> {ok, suites, passed, failed, source} | null. Tries
 * the modern gate-evidence.json source FIRST (item 15/10 — the real newest source), falling back to
 * a standalone doctor.json only when no doctor gate/output is readable. Never throws; a missing or
 * unparseable source of either kind is honestly `null`, never a guessed tally. */
export function readDoctorTallyForRun(runDir, projectRoot) {
  const gateEvidencePath = path.join(runDir, 'gate-evidence.json');
  let gateEvidence = null;
  try { gateEvidence = JSON.parse(fs.readFileSync(gateEvidencePath, 'utf8')); } catch { gateEvidence = null; }
  if (gateEvidence && Array.isArray(gateEvidence.gates)) {
    const doctorGate = gateEvidence.gates.find((g) => g && typeof g.name === 'string' && DOCTOR_GATE_NAME_RE.test(g.name));
    if (doctorGate && typeof doctorGate.output_file === 'string') {
      const tally = readDoctorTallyFromOutputFile(doctorGate.output_file, projectRoot);
      if (tally) return { ...tally, source: 'gate-evidence-output-file', gate_name: doctorGate.name, exit_code: doctorGate.exit_code != null ? doctorGate.exit_code : null };
    }
  }
  const doctorJsonPath = path.join(runDir, 'doctor.json');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(doctorJsonPath, 'utf8')); } catch { return null; }
  const tests = parsed.checks && parsed.checks.tests ? parsed.checks.tests : null;
  return {
    ok: !!parsed.ok, suites: tests ? tests.suites : undefined, passed: tests ? tests.passed : undefined,
    failed: tests ? tests.failed : undefined, source: 'doctor.json',
  };
}

function findNewestDoctorReceipt() {
  let entries;
  try {
    entries = fs.readdirSync(FORGE_RUNS_DIR, { withFileTypes: true });
  } catch {
    return { state: 'UNAVAILABLE', note: 'forge-runs directory not readable' };
  }
  // WP-CC1 (item 15): "newest" is now the newest of EITHER a standalone doctor.json's own mtime OR
  // a gate-evidence.json doctor gate's real `ended_at` timestamp — whichever source genuinely
  // reports a later real event wins, so a fresh gate-evidence-embedded doctor run is never shadowed
  // by an old standalone doctor.json purely because that file happens to still exist on disk.
  let newest = null;
  function consider(candidateMs, runId, doctorPath, gateEvidencePath) {
    if (!Number.isFinite(candidateMs)) return;
    if (!newest || candidateMs > newest.ms) newest = { ms: candidateMs, runId, doctorPath, gateEvidencePath };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(FORGE_RUNS_DIR, entry.name);
    const doctorPath = path.join(runDir, 'doctor.json');
    try { consider(fs.statSync(doctorPath).mtimeMs, entry.name, doctorPath, null); } catch { /* no standalone doctor.json here */ }
    const gateEvidencePath = path.join(runDir, 'gate-evidence.json');
    let gateEvidence = null;
    try { gateEvidence = JSON.parse(fs.readFileSync(gateEvidencePath, 'utf8')); } catch { gateEvidence = null; }
    if (gateEvidence && Array.isArray(gateEvidence.gates)) {
      const doctorGate = gateEvidence.gates.find((g) => g && typeof g.name === 'string' && DOCTOR_GATE_NAME_RE.test(g.name));
      if (doctorGate) consider(Date.parse(doctorGate.ended_at), entry.name, null, gateEvidencePath);
    }
  }
  if (!newest) return { state: 'NOT CONFIGURED', note: 'no doctor.json or gate-evidence.json doctor gate found under any run' };
  const runDir = path.join(FORGE_RUNS_DIR, newest.runId);
  const tally = readDoctorTallyForRun(runDir, PROJECT_ROOT);
  if (!tally) {
    return { state: 'UNVERIFIED', note: 'the newest doctor source could not be parsed', run_id: newest.runId };
  }
  const ageMs = Date.now() - newest.ms;
  const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — advisory only, not a hard rule
  return {
    state: ageMs > STALE_AFTER_MS ? 'STALE' : (tally.ok ? 'CONNECTED' : 'FAILED'),
    run_id: newest.runId,
    ok: tally.ok,
    suites: tally.suites,
    passed: tally.passed,
    failed: tally.failed,
    source: tally.source,
    captured_at: new Date(newest.ms).toISOString(),
    age_ms: ageMs,
  };
}

import { getRuntimeState } from './runtime-state.mjs';

export async function buildHealth(startedAtMs) {
  const doctorLast = findNewestDoctorReceipt();
  const now = new Date();
  // AUDIT G8.1 (2026-08-06): health was onvoorwaardelijk ok:true — een DEGRADED runtime (uncaught
  // exception) bleef onzichtbaar. Nu is de runtime-staat onderdeel van het oordeel: readiness-rood.
  const runtime = getRuntimeState();
  return {
    ok: runtime.state === 'OK',
    runtime,
    gateway: {
      version: '0.1.0',
      uptime_s: Math.round((Date.now() - startedAtMs) / 1000),
      project_root: PROJECT_ROOT,
    },
    forge: {
      control_center: CONTROL_CENTER_RETIRED,
      doctor_last: doctorLast,
    },
    // P2-12 fix, part (a): same shape/value as the `execution` field on GET /api/conversations
    // (server.mjs) — exposed here too so a caller that only needs execution availability (e.g. a
    // health-poll) never has to pay conversations.mjs's full listConversations() cost just to read it.
    execution: executionAvailability(),
    captured_at: now.toISOString(),
    age_ms: 0,
    provenance: 'LIVE',
  };
}
