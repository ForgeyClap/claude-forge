// GET /api/recovery + GET /api/checkpoints sources: the SELECTED project's own research/resume
// state under `.claude/`. Both endpoints are read-only and honestly report NOT CONFIGURED / absent
// state rather than fabricating a record — same convention as usage.mjs's FORGE_USAGE_PRESSURE
// handling. Housed in one file (write-scope named `recovery.mjs` as the one NEW module for both
// concerns — checkpoints is "resume state", which is the same family of "was work interrupted and
// can it pick back up" question recovery-attempts answers for research routes).
//
// /api/recovery reads:
//   - `.claude/forge-research/recovery-attempts.jsonl` — the solution-first recovery ledger
//     (GLOBAL_RESEARCH_RECOVERY_POLICY.md's attempt ledger).
//   - `.claude/forge-research/docdrift-ledger.jsonl` + `docdrift-state.json` — the doc-drift
//     checker's append-only history + latest per-rule state.
//
// /api/checkpoints reads:
//   - `.claude/FORGE_RESUME_STATE.json` (if present) — a project-level "was a mission interrupted"
//     marker. Not present anywhere in this fleet today (verified); honestly UNAVAILABLE when absent.
//   - Each run directory under `.claude/forge-runs/` for a `manifest.json` — presence + contents,
//     never fabricated when absent (which is every run in this project today).
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk, anyContainmentOk } from './security.mjs';
// Codex run B F-12: the DYNAMIC admitted-roots boundary — see admitted-roots.mjs's own header.
import { getContainmentRoots } from './admitted-roots.mjs';
// sec-delta F1: this module was the ONE reader that never imported the redaction control.
//
// Every sibling reader (events, conversations, exec-bridge, models, capabilities) runs its output
// through `redactDeep` before it leaves the process. This module hands back three WHOLE parsed
// files with no field projection: the recovery-attempt ledger, the resume state, and each run's
// manifest. That was survivable while nothing consumed the route — but this run mounted it into
// Activity, so the payload now reaches the browser, its memory, devtools, and any saved HAR.
//
// The ledger's own fields (`queries`, `resultSource`, `securityDecision`) are operator-authored
// free text, and `GLOBAL_RESEARCH_RECOVERY_POLICY`'s "secrets are redacted from recovery logs" is
// a promise made by whoever WRITES the log — not a control on the way out. The current ledger was
// read and is clean, so this closes a control gap rather than a live leak. Which is exactly when
// it is cheapest to close.
import { redactDeep } from './redact.mjs';

// Reads a JSONL file, returns an array of parsed lines (skipping malformed ones — an honest partial
// result beats a crash), or `null` if the file itself does not exist (distinct from "exists but
// empty", which returns `[]`).
function readJsonlSafe(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a malformed line */
    }
  }
  return out;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// WP-CC1 (item 9): mirrors `.claude/forge-bin/forge-manifest.cjs`'s own PURE `projectManifest(wps,
// events)` (verified by reading that file, ~line 130 for the two event-type sets and ~line 334 for
// the projection loop) — reimplemented here as a read-only, no-disk-write equivalent (this gateway
// never writes into a project's `.claude/`, so it can never call the real `reconcile()`, which
// persists the projected manifest back to disk). Without this, `buildCheckpoints()` below showed
// the RAW, un-reconciled manifest.json — every work package frozen at its ARM-time `"armed"` status
// forever, even for a WP that a later `wp_completed`/`check_passed`/`subagent_completed` event
// (or `wp_failed`/`check_failed`/`subagent_failed`) already proved done or failed.
const DONE_EVENT_TYPES = new Set(['wp_completed', 'check_passed', 'subagent_completed']);
const FAILED_EVENT_TYPES = new Set(['wp_failed', 'check_failed', 'subagent_failed']);

// log-event.cjs's own CONTENT ORACLE stamp — a disproven claim is not evidence and must never flip
// a WP's status, exactly like forge-manifest.cjs's own eventIsDisproven().
function eventIsDisproven(ev) {
  return !!(ev && ev._forge_verify && ev._forge_verify.proof_verified === false);
}

// PURE function of (wps, events) — never mutates its inputs, never writes anything. For each wp,
// the LAST qualifying event (matching wp_id, not disproven, DONE or FAILED) wins, so a real later
// retry can flip a WP from failed back to done within the same run. No qualifying event at all
// leaves the WP's status exactly as the manifest itself recorded it (normally "armed") — the "never
// fabricate a completed WP" invariant forge-manifest.cjs's own tests already lock down.
function reconcileManifestReadOnly(wps, events) {
  if (!Array.isArray(wps)) return wps;
  return wps.map((wp) => {
    if (!wp || typeof wp !== 'object' || wp.wp_id == null) return wp;
    let status = wp.status || 'armed';
    let lastProof = wp.last_proof != null ? wp.last_proof : null;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || typeof ev !== 'object') continue;
      if (ev.wp_id == null || String(ev.wp_id) !== String(wp.wp_id)) continue;
      if (eventIsDisproven(ev)) continue;
      const et = ev.event_type;
      if (DONE_EVENT_TYPES.has(et)) { status = 'done'; lastProof = { event_type: et, evIdx: i, ts: ev.timestamp || null }; }
      else if (FAILED_EVENT_TYPES.has(et)) { status = 'failed'; lastProof = { event_type: et, evIdx: i, ts: ev.timestamp || null }; }
    }
    return { ...wp, status, last_proof: lastProof };
  });
}

function readEventsJsonlSafe(eventsPath) {
  let raw;
  try { raw = fs.readFileSync(eventsPath, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* malformed line — skip, never crash */ }
  }
  return out;
}

export function buildRecovery(projectPath) {
  if (!anyContainmentOk(getContainmentRoots(), projectPath)) {
    return { ok: false, error: 'project path outside allowed scan root' };
  }
  const capturedAt = new Date();
  const researchDir = path.join(projectPath, '.claude', 'forge-research');
  if (!containmentOk(projectPath, researchDir)) {
    return { ok: false, error: 'path containment violation' };
  }

  const attempts = readJsonlSafe(path.join(researchDir, 'recovery-attempts.jsonl'));
  const recoveryAttempts = attempts === null ? [] : attempts;
  const recoveryProvenance = attempts === null ? 'NOT CONFIGURED' : 'LIVE';

  const ledgerEntries = readJsonlSafe(path.join(researchDir, 'docdrift-ledger.jsonl'));
  const stateData = readJsonSafe(path.join(researchDir, 'docdrift-state.json'));

  let lastCheck = null;
  if (ledgerEntries && ledgerEntries.length > 0) {
    const last = ledgerEntries[ledgerEntries.length - 1];
    lastCheck = last && typeof last.checked_at === 'string' ? last.checked_at : null;
  }

  const sources = ledgerEntries
    ? [...new Set(ledgerEntries.map((e) => e && e.source_url).filter((u) => typeof u === 'string'))]
    : [];

  const findings = stateData
    ? Object.entries(stateData).map(([ruleId, v]) => ({
        rule_id: ruleId,
        drifted: !!(v && v.drifted),
        last_status: v && typeof v.last_status === 'string' ? v.last_status : null,
        last_checked: v && typeof v.last_checked === 'string' ? v.last_checked : null,
        missing_tokens: v && Array.isArray(v.missing_tokens) ? v.missing_tokens : [],
      }))
    : [];

  const docdriftProvenance = ledgerEntries !== null || stateData !== null ? 'LIVE' : 'NOT CONFIGURED';

  return {
    ok: true,
    recovery_attempts: redactDeep(recoveryAttempts),
    recovery_attempts_count: recoveryAttempts.length,
    recovery_provenance: recoveryProvenance,
    docdrift: {
      last_check: lastCheck,
      // redactDeep at the read boundary, same as recovery_attempts/resume_state.data/manifest:
      // source URLs and missing_tokens are file-derived strings that can carry a secret (a token in
      // a query string, a leaked value a drift rule watches for) — push-to-break FINDING 1, 2026-07-29,
      // proved an injected secret survived here while the sibling fields were already scrubbed.
      sources: redactDeep(sources),
      findings: redactDeep(findings),
      findings_count: findings.length,
      drifted_count: findings.filter((f) => f.drifted).length,
      provenance: docdriftProvenance,
    },
    captured_at: capturedAt.toISOString(),
    age_ms: 0,
  };
}

export function buildCheckpoints(projectPath) {
  if (!anyContainmentOk(getContainmentRoots(), projectPath)) {
    return { ok: false, error: 'project path outside allowed scan root' };
  }
  const capturedAt = new Date();

  const resumeStatePath = path.join(projectPath, '.claude', 'FORGE_RESUME_STATE.json');
  let resumeState;
  const resumeData = readJsonSafe(resumeStatePath);
  if (resumeData !== null) {
    resumeState = { available: true, data: redactDeep(resumeData) };
  } else {
    resumeState = {
      available: false,
      note: "no FORGE_RESUME_STATE.json found under this project's .claude",
    };
  }

  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const runsWithManifest = [];
  let dirEntries = [];
  try {
    dirEntries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    /* no forge-runs dir yet — honest empty list below */
  }
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const runDir = path.join(runsDir, runId);
    if (!containmentOk(runsDir, runDir)) continue; // should be impossible, kept as a hard guard
    const manifest = readJsonSafe(path.join(runDir, 'manifest.json'));
    if (manifest !== null) {
      // WP-CC1 (item 9): reconcile against this SAME run's own events.jsonl before this ever
      // reaches a client — the raw on-disk manifest.json only ever reflects the moment it was
      // armed. `manifest_raw_status_counts` is kept alongside for anyone auditing the
      // reconciliation itself; the primary `manifest` field is now the honest, reconciled view.
      const events = readEventsJsonlSafe(path.join(runDir, 'events.jsonl'));
      const reconciled = reconcileManifestReadOnly(manifest, events);
      const rawStatusCounts = {};
      if (Array.isArray(manifest)) {
        for (const wp of manifest) {
          const s = wp && typeof wp === 'object' && wp.status ? wp.status : 'armed';
          rawStatusCounts[s] = (rawStatusCounts[s] || 0) + 1;
        }
      }
      runsWithManifest.push({
        run_id: runId,
        manifest_present: true,
        manifest: redactDeep(reconciled),
        manifest_reconciled: true,
        manifest_raw_status_counts: rawStatusCounts,
      });
    }
  }

  return {
    ok: true,
    resume_state: resumeState,
    runs_with_manifest: runsWithManifest,
    runs_with_manifest_count: runsWithManifest.length,
    captured_at: capturedAt.toISOString(),
    age_ms: 0,
    provenance: resumeState.available || runsWithManifest.length > 0 ? 'LIVE' : 'NOT CONFIGURED',
  };
}
