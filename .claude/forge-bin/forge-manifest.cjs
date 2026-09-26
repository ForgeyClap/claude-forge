#!/usr/bin/env node
'use strict';
/**
 * forge-manifest.cjs — mission-level swarm ARM/RECONCILE manifest (WAVE D / D1, 2026-07-18). At ARM time
 * (the moment a swarm of work packages is actually dispatched) `arm()` persists ONE per-WP manifest for
 * that run to `.claude/forge-runs/<run_id>/manifest.json` — a plain JSON array of
 * `{wp_id, agent, status:"armed", narrowed_prompt, deps, last_proof:null}` records. `reconcile()` later
 * re-derives each WP's real status PURELY by projecting that run's `events.jsonl` content — never by
 * inferring from side effects of the work itself (a file that looks right, an agent that merely claims
 * done). This is the same HONESTY CORE discipline `forge-orchestrate.cjs`/`forge-checkpoint.cjs` already
 * use: a status is only ever "done" when a real, non-disproven event says so; anything else stays
 * "armed" (unfinished) — NEVER fabricated as complete just because nothing contradicts it.
 *
 * WHY A SEPARATE MANIFEST FROM `forge-run-state.cjs`: that sibling projects resume state per AGENT (from
 * agent_started/agent_completed/agent_failed), with no notion of "what was the exact narrowed prompt this
 * agent was dispatched with." This file is per WORK PACKAGE (wp_id), keyed off an explicit ARM step that
 * records the narrowed_prompt/deps BEFORE dispatch — the piece `forge-swarm-resume.cjs` needs to
 * re-dispatch ONLY the unfinished work packages with their original scoping, not just "which agent name
 * never said done."
 *
 * PROJECTION RULE (pure function of event content — see `projectManifest`): for a WP whose `wp_id` this
 * run's events.jsonl references, the LAST (highest-index) qualifying event wins (mirrors
 * `forge-checkpoint.cjs`'s "last occurrence wins" resumePlan convention — a real retry can legitimately
 * flip a WP from failed back to done later in the same run). A `wp_completed` or `check_passed` event
 * carrying a matching `wp_id` => status "done". A `wp_failed` or `check_failed` event carrying a matching
 * `wp_id` => status "failed". log-event.cjs's own CONTENT ORACLE stamp (`_forge_verify.proof_verified
 * === false`) disqualifies an event from EITHER outcome — a disproven claim is not evidence, and is
 * silently ignored rather than flipping status (same discipline as `forge-orchestrate.cjs::eventMatchesStep`).
 * A WP with no qualifying event at all stays "armed" (unfinished) — this is the "never fabricate a
 * completed WP" invariant this whole piece exists to protect.
 *
 * STORAGE (project-local, under THIS project's `.claude/` only):
 *   .claude/forge-runs/<run_id>/manifest.json — the ONE canonical per-run manifest, written atomically
 *   (same-dir temp file + rename commit, mirrors `forge-checkpoint.cjs::atomicWriteFile`) by both `arm()`
 *   and `reconcile()` (reconcile persists the freshly-projected statuses back so `load()`/`status()` always
 *   reflect the last reconciliation without re-scanning events.jsonl every time).
 *
 * MODEL:
 *   arm({run_id, wps:[{wp_id, agent, narrowed_prompt, deps?}, ...]}, opts) -> {ok, path, manifest} |
 *     {ok:false, reason, errors?}. Validates every WP (non-empty wp_id/agent/narrowed_prompt, no duplicate
 *     wp_id, deps must be an array if present); a validation failure writes nothing (fail closed).
 *   load(run_id, opts) -> WP[] — throws if no manifest was ever armed for this run, or if manifest.json is
 *     present but malformed (not valid JSON / not an array / a record missing wp_id) — never returns a
 *     half-trusted guess.
 *   reconcile({run_id}, opts) -> {ok, run_id, manifest, done, failed, unfinished, resumable}. Loads the
 *     armed manifest (throws under the same conditions as `load`), reads events.jsonl (missing/empty file
 *     is a VALID "nothing happened yet" state — every WP simply stays "armed", never an error), projects
 *     new statuses via the pure `projectManifest`, persists the result, and returns it.
 *   status(run_id, opts) -> same shape as reconcile's return, but READ-ONLY (no event re-scan, no write —
 *     just the manifest as it was last armed/reconciled).
 *
 * DISPATCH FRONTIER (2026-08-01, "pakket 2" — giving forge-beads.cjs::ready() a real caller): `arm()` has
 * always PERSISTED each WP's `deps`, but nothing ever READ them, so the order in which work packages went
 * out was whatever the Lead judged by eye. `ready(run_id)` / `waves(run_id)` below answer that question by
 * COMPUTATION instead, and they do it by IMPORTING forge-beads.cjs's already-proven pure core
 * (computeReady / computeCycles — 3-colour DFS, guaranteed to terminate) rather than re-deriving a second
 * dependency algorithm that could silently drift from it. `beadsCore()` exposes the imported module so a
 * test can assert function IDENTITY, not merely equal behaviour.
 *   WHY THIS MATTERS BEYOND ORDERING: the owner's global Orchestration-Safety HARD MUST is "one writer per
 *   hotspot at a time". A computed frontier hands out a set of packages that are, by construction, mutually
 *   independent (nothing in one wave depends on anything else in that wave), which is exactly the property
 *   an eyeballed order does not guarantee — that is how the 2026-07-22 overlapping-write conflict happened.
 *   STATUS MAPPING (see wpsToBeads): only `done` counts as done; EVERY other WP status ('armed', 'failed',
 *   anything unknown) maps to the beads status 'open' — i.e. still to be dispatched. A `failed` WP is
 *   therefore actionable again (that is precisely what "resumable" means here), while it never satisfies
 *   another WP's dependency, because only a genuinely done package can do that. Fails closed on a DANGLING
 *   dep (a dep id no armed WP carries): the dependent stays blocked and is named in `dangling`/
 *   `unschedulable` rather than being quietly treated as satisfied.
 *
 * ARMING ACTUALLY HAPPENS (2026-08-01): measured on this project — 0 of 32 run directories under
 * `.claude/forge-runs/` held a manifest.json, while 21 held a run.json. The whole chain below (reconcile /
 * status / ready / waves / forge-swarm-resume.cjs / forge-briefing.cjs) was therefore running on nothing,
 * and `waves()` — the MECHANICAL guarantee behind the owner's "one writer per hotspot at a time" HARD MUST
 * — could never once be consulted. The cause was not a bug in this file: `arm()` was complete and tested,
 * but nothing in the canonical run procedure ever told anyone to call it, and `config/orchestration/
 * run-checklist.json` (the single source of truth `forge-orchestrate.cjs::audit()` reports skipped steps
 * from) had no ARM step, so a run that skipped it was never even reported as having skipped anything.
 * The fix is in two halves, both of which fit what already exists rather than adding a parallel mechanism:
 *   (1) run-checklist.json gained an `arm-manifest` step between `route` and `dispatch` — arming BEFORE
 *       dispatch is the invariant, since the narrowed_prompt/deps must be recorded before the work goes out.
 *       It is `required:false` ON PURPOSE: every one of the 32 historical runs, and every trivial one-package
 *       run, would otherwise be retroactively reported as failing a REQUIRED step. Advisory means it still
 *       shows up by name in audit()'s `skipped` list (visible, never silent) without flipping any existing
 *       run's audit exit code — see forge-orchestrate.cjs's exit-code contract.
 *   (2) `arm()` can now LOG ITS OWN PROOF. The step's `produces_event` is `manifest_armed`, an event type
 *       log-event.cjs already registers and forge-verify.cjs already classifies as a run-level one-shot
 *       fact — nothing new is invented. Previously arming and logging were two separate manual acts
 *       (`commands/forge.md` literally said "log `manifest_armed`" as a second instruction), so the proof
 *       could be forgotten while the manifest existed, or logged while it did not. `opts.logEvent` / the
 *       CLI's `--log-event` makes them one act. It is OPT-IN, never the default: log-event.cjs always
 *       writes into the REAL project's `.claude/forge-runs/`, so defaulting it on would make every hermetic
 *       test that spawns `arm` scribble into the live project. A logging failure NEVER fails arm() — the
 *       manifest write already committed — it is reported honestly in the result's `logged` field instead.
 *
 * CLI:
 *   node forge-manifest.cjs arm --run <id> --wps <file.json> [--log-event] [--json]
 *   node forge-manifest.cjs reconcile --run <id> [--json]
 *   node forge-manifest.cjs status --run <id> [--json]
 *   node forge-manifest.cjs ready --run <id> [--json]
 *   node forge-manifest.cjs waves --run <id> [--json]
 * `--wps <file.json>` accepts either a bare JSON array of WP records, or `{"wps":[...]}`.
 * Exit codes: arm: 0 ok / 2 usage-or-validation error. reconcile/status: 0 = every WP done (complete) /
 * 3 = resumable (an armed or failed WP remains, mirrors forge-checkpoint's resume-plan convention) /
 * 2 = usage error (bad run_id, or no manifest ever armed for this run). ready/waves: 0 = ran clean /
 * 3 = ran, but something needs attention (a dependency cycle, or a WP that can never be scheduled —
 * mirrors forge-beads.cjs's own exit-3 "advisory needs-attention" convention) / 2 = usage error.
 */
const fs = require('fs');
const path = require('path');
// forge-beads.cjs is a SOFT sibling dependency: it is the SINGLE source of truth for the frontier/cycle
// algorithm (see DISPATCH FRONTIER above). Only ready()/waves() need it, so a hermetic fixture that ships
// forge-manifest.cjs alone must still be able to arm/load/reconcile/status — those paths never touch it.
// requireBeads() below turns its absence into one honest error at the call site instead of a module crash.
let beadsMod = null;
try { beadsMod = require('./forge-beads.cjs'); } catch { beadsMod = null; }

const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
/** N2 fix (2026-09-26, fresh-laptop re-audit) — forge.md's ACTUAL dispatch step (:103) never tells the Lead
 *  to log `wp_completed`/`wp_failed` at all; the documented pair is `subagent_completed`/`agent_failed`
 *  (":89, :96, :103"), and log-event.cjs's own WP23 note already anticipates a `wp_id` on
 *  `subagent_completed`/`subagent_failed` ("lets the completion close that heartbeat"). REPRODUCED
 *  (replaying a real mission that followed forge.md literally through the 2.7.2 contract): every armed
 *  work package read as an unfinished RC-MANIFEST-STALE gap, because only `wp_completed`/`check_passed`
 *  ever counted as done — a run whose Lead did exactly what forge.md says could never satisfy its own
 *  manifest. `subagent_completed`/`subagent_failed` (each still matched on `wp_id`, same as before — see
 *  projectManifest() below) now qualify too, so a run that follows forge.md's documented sequence AND
 *  attaches `wp_id` to those events passes without inventing a second, undocumented event vocabulary.
 *  `wp_completed`/`wp_failed`/`check_passed`/`check_failed` stay exactly as they were (WP-S5a separately
 *  adds an explicit forge.md instruction to log those too — this is a parallel, not a replacement, fix). */
const DONE_EVENT_TYPES = new Set(['wp_completed', 'check_passed', 'subagent_completed']);
const FAILED_EVENT_TYPES = new Set(['wp_failed', 'check_failed', 'subagent_failed']);
const WP_DONE_STATUS = 'done';

// ---- root / path resolution (mirrors forge-run-state.cjs / forge-checkpoint.cjs conventions) ----
function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  return path.resolve(__dirname, '..', '..');
}
function isValidRunId(id) { return typeof id === 'string' && RUN_ID_RE.test(id); }
function runDir(root, runId) { return path.join(root, '.claude', 'forge-runs', runId); }
function assertContained(target, base) {
  const b = path.resolve(base), t = path.resolve(target);
  if (t !== b && !t.startsWith(b + path.sep)) throw new Error('forge-manifest: path escapes forge-runs — refused');
}
function manifestPath(root, runId) {
  const base = path.join(root, '.claude', 'forge-runs');
  const p = path.join(runDir(root, runId), 'manifest.json');
  assertContained(p, base);
  return p;
}
function eventsPath(root, runId) {
  const base = path.join(root, '.claude', 'forge-runs');
  const p = path.join(runDir(root, runId), 'events.jsonl');
  assertContained(p, base);
  return p;
}

// ---- atomic write (same-dir temp file + rename commit — mirrors forge-checkpoint.cjs) ----
function sleepMs(ms) {
  try { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }
  catch { /* Atomics.wait unavailable — best-effort no-op */ }
}
function renameWithRetry(src, dest, attempts) {
  attempts = attempts || 5;
  for (let i = 0; i < attempts; i++) {
    try { fs.renameSync(src, dest); return; }
    catch (e) {
      const transient = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES';
      if (!transient || i === attempts - 1) throw e;
      sleepMs(15 * (i + 1));
    }
  }
}
function atomicWriteFile(destPath, buffer) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, '.' + path.basename(destPath) + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  fs.writeFileSync(tmpPath, buffer);
  renameWithRetry(tmpPath, destPath);
  return destPath;
}

// ---- WP record validation ----
/** normalizeWp(raw) -> {ok:true, wp} | {ok:false, errors}. Required: wp_id, agent, narrowed_prompt (all
 *  non-empty after String() coercion + trim). `deps`, if present, must be an array (coerced to strings). */
function normalizeWp(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['each wp must be a JSON object'] };
  const wp_id = raw.wp_id != null ? String(raw.wp_id).trim() : '';
  if (!wp_id) errors.push('wp_id must be a non-empty string or number');
  const agent = raw.agent != null ? String(raw.agent).trim() : '';
  if (!agent) errors.push('agent must be a non-empty string');
  const narrowed_prompt = raw.narrowed_prompt != null ? String(raw.narrowed_prompt) : '';
  if (!narrowed_prompt.trim()) errors.push('narrowed_prompt must be a non-empty string');
  let deps = [];
  if (raw.deps != null) {
    if (!Array.isArray(raw.deps)) errors.push('deps must be an array if present');
    else deps = raw.deps.map((d) => String(d));
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, wp: { wp_id, agent, status: 'armed', narrowed_prompt, deps, last_proof: null } };
}

// ---- manifest_armed proof event (opt-in) ---------------------------------------------------------------
// The ONE event writer this project has is .claude/forge-dashboard/log-event.cjs — this file spawns it
// rather than appending to events.jsonl itself, so the hash-chain/honesty stamping/strict-event validation
// that writer owns is never bypassed (the same "never a second writer" discipline the rest of Forge uses).
const LOG_EVENT_PATH = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');

/** logManifestArmed({run_id, manifest}, opts) -> {ok, event_type, reason?, status?} — best-effort. Returns
 *  an honest {ok:false, reason} instead of throwing, because the caller's manifest write has ALREADY
 *  committed by the time this runs: a failure to log the proof must never be reported as a failure to arm.
 *  opts.logEventPath overrides the writer (test hermeticity seam — same convention as opts.root).
 *  ROOT CONTAINMENT (2026-08-03, same class as forge-runcontract's fix): the writer is resolved under
 *  opts.root — never via __dirname alone — so a foreign-root caller can never write proof events into
 *  THIS install's forge-runs. A root without its own writer is an honest {ok:false}, never a fallback. */
function logManifestArmed(input, opts) {
  opts = opts || {};
  const root = resolveRoot(opts.root);
  const script = opts.logEventPath || path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
  if (!opts.logEventPath && !fs.existsSync(script)) {
    return { ok: false, event_type: 'manifest_armed', reason: 'no event writer under this root (' + script + ' missing) — refusing cross-install fallback' };
  }
  const wps = Array.isArray(input.manifest) ? input.manifest : [];
  const ev = {
    run_id: input.run_id,
    event_type: 'manifest_armed',
    // 2026-09-24 (run forge-2026-09-24-config-v250): the proof used to carry NO agent. forge-runcontract.cjs's
    // independent-verification rule (N-01) treats anonymous work as "undeterminable, fail-closed", so the arm
    // tool's own proof event silently blocked every finalize of a run that had used `--log-event`. Arming is
    // the Lead's act — stamp it as such, exactly like forge-prd.cjs stamps `prd_generated`.
    agent: 'orchestrator', role: 'lead', runtime: 'internal',
    note: 'forge-manifest arm: ' + wps.length + ' work package(s) armed [' + wps.map((w) => w.wp_id).join(', ') + ']',
  };
  let res;
  try {
    const { spawnSync } = require('child_process'); // lazy: arm/load/reconcile/status never need it
    res = spawnSync(process.execPath, [script, JSON.stringify(ev)], { encoding: 'utf8' });
  } catch (e) {
    return { ok: false, event_type: 'manifest_armed', reason: 'could not spawn log-event.cjs: ' + e.message };
  }
  if (res.error) return { ok: false, event_type: 'manifest_armed', reason: 'could not spawn log-event.cjs: ' + res.error.message };
  if (res.status !== 0) {
    return { ok: false, event_type: 'manifest_armed', status: res.status, reason: 'log-event.cjs exited ' + res.status + ': ' + String(res.stderr || '').trim() };
  }
  return { ok: true, event_type: 'manifest_armed', status: 0 };
}

/** arm({run_id, wps}, opts) -> {ok:true, path, manifest, logged?} | {ok:false, reason, errors?}. See file
 *  header. `opts.logEvent === true` additionally logs the `manifest_armed` proof event through the real
 *  log-event.cjs writer and reports the outcome in `logged` — a logging failure never flips ok to false. */
function arm(input, opts) {
  opts = opts || {};
  if (!input || typeof input !== 'object') return { ok: false, reason: 'input_must_be_object' };
  const runId = input.run_id;
  if (!isValidRunId(runId)) return { ok: false, reason: 'invalid_run_id' };
  if (!Array.isArray(input.wps) || input.wps.length === 0) return { ok: false, reason: 'wps_must_be_non_empty_array' };

  const root = resolveRoot(opts.root);
  const seen = new Set();
  const normalized = [];
  const errors = [];
  for (const raw of input.wps) {
    const n = normalizeWp(raw);
    if (!n.ok) { errors.push(...n.errors); continue; }
    if (seen.has(n.wp.wp_id)) { errors.push('duplicate wp_id: ' + n.wp.wp_id); continue; }
    seen.add(n.wp.wp_id);
    normalized.push(n.wp);
  }
  if (errors.length) return { ok: false, reason: 'validation_error', errors };

  const file = manifestPath(root, runId);
  atomicWriteFile(file, Buffer.from(JSON.stringify(normalized, null, 2) + '\n', 'utf8'));
  const out = { ok: true, path: file, manifest: normalized };
  if (opts.logEvent) out.logged = logManifestArmed({ run_id: runId, manifest: normalized }, opts);
  return out;
}

/** load(run_id, opts) -> WP[]. THROWS (never returns a half-trusted guess) when no manifest was ever armed
 *  for this run, or when manifest.json exists but is malformed. */
function load(runId, opts) {
  opts = opts || {};
  if (!isValidRunId(runId)) throw new Error('forge-manifest: invalid run_id: ' + runId);
  const root = resolveRoot(opts.root);
  const file = manifestPath(root, runId);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error('forge-manifest: no manifest found for run "' + runId + '" — call arm() first');
    throw new Error('forge-manifest: could not read manifest for run "' + runId + '": ' + e.message);
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-manifest: manifest.json for run "' + runId + '" is not valid JSON: ' + e.message); }
  if (!Array.isArray(data)) throw new Error('forge-manifest: manifest.json for run "' + runId + '" must be a JSON array of WP records');
  for (const wp of data) {
    if (!wp || typeof wp !== 'object' || typeof wp.wp_id !== 'string' || !wp.wp_id) {
      throw new Error('forge-manifest: manifest.json for run "' + runId + '" contains a malformed WP record: ' + JSON.stringify(wp));
    }
  }
  return data;
}

/** readEventsJsonl(p) -> event[]. Line-delimited JSON, BOM-tolerant, malformed lines skipped (mirrors
 *  forge-orchestrate.cjs). A MISSING file returns [] (never throws) — "nothing logged yet" is a valid,
 *  ordinary state for a just-armed run, not an error. */
function readEventsJsonl(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch { /* malformed line — skip, never crash */ }
  }
  return events;
}

/** eventIsDisproven(e) -> boolean — log-event.cjs's own CONTENT ORACLE already flagged this event's pass
 *  claim as false (non-zero exit code / missing-or-blank proof artifact). Such an event is a CLAIM, not
 *  real evidence, and must never be allowed to flip a WP to "done" (or count toward "failed" either — it
 *  is simply ignored, exactly like forge-orchestrate.cjs::eventMatchesStep). */
function eventIsDisproven(e) { return !!(e && e._forge_verify && e._forge_verify.proof_verified === false); }

/** projectManifest(wps, events) -> WP[] — PURE function of (wps, events); no I/O, never mutates its
 *  inputs. For each wp, scans events in order; the LAST qualifying event (matching wp_id, not disproven,
 *  event_type in DONE_EVENT_TYPES or FAILED_EVENT_TYPES) wins, so a real later retry can flip a WP from
 *  failed back to done within the same run. No qualifying event at all => status stays exactly what it
 *  was on the input record (normally "armed" for a freshly-armed WP) — this is the "never fabricate a
 *  completed WP" invariant. This is the function `reconcile()`'s honesty guarantee is mutation-verified
 *  against (see forge-manifest.test.cjs). */
function projectManifest(wps, events) {
  return wps.map((wp) => {
    let status = wp.status || 'armed';
    let lastProof = wp.last_proof != null ? wp.last_proof : null;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e || typeof e !== 'object') continue;
      if (e.wp_id == null || String(e.wp_id) !== String(wp.wp_id)) continue;
      if (eventIsDisproven(e)) continue; // a disproven claim is not evidence — ignored, never flips status
      const et = e.event_type;
      if (DONE_EVENT_TYPES.has(et)) {
        status = 'done';
        lastProof = { event_type: et, evIdx: i, ts: e.timestamp || null };
      } else if (FAILED_EVENT_TYPES.has(et)) {
        status = 'failed';
        lastProof = { event_type: et, evIdx: i, ts: e.timestamp || null };
      }
    }
    return Object.assign({}, wp, { status, last_proof: lastProof });
  });
}

/** reconcile({run_id}, opts) -> {ok, run_id, manifest, done, failed, unfinished, resumable}. Loads the
 *  armed manifest (throws under the same conditions as `load`), reads events.jsonl (missing/empty is a
 *  VALID all-unfinished state, not an error), projects new statuses via the pure `projectManifest`,
 *  PERSISTS the projected manifest back to manifest.json (atomic write), and returns it. */
function reconcile(input, opts) {
  opts = opts || {};
  input = input || {};
  const runId = input.run_id;
  if (!isValidRunId(runId)) throw new Error('forge-manifest: reconcile requires a valid run_id');
  const root = resolveRoot(opts.root);
  const wps = load(runId, opts); // throws on missing/malformed manifest — fail closed
  const events = readEventsJsonl(eventsPath(root, runId));
  const projected = projectManifest(wps, events);
  // r5 #16 (2026-08-07): persist:false levert dezelfde verse projectie ZONDER de manifest-write —
  // voor read-only planners (swarm-resume --plan) die niet naast een uitvoerder mogen schrijven.
  if (opts.persist !== false) {
    const file = manifestPath(root, runId);
    atomicWriteFile(file, Buffer.from(JSON.stringify(projected, null, 2) + '\n', 'utf8'));
  }
  return summarize(runId, projected);
}

/** status(run_id, opts) -> same shape as reconcile's return, but READ-ONLY: no event re-scan, no write —
 *  just the manifest as it was last armed/reconciled. */
function status(runId, opts) {
  const wps = load(runId, opts); // throws on missing/malformed manifest
  return summarize(runId, wps);
}

// ---- dispatch frontier: forge-beads.cjs's proven core, applied to this run's work packages -------------
/** beadsCore() -> the IMPORTED forge-beads.cjs module. Throws one honest error when the sibling module is
 *  absent, so a caller learns exactly which capability is unavailable instead of getting a crash at
 *  require time (arm/load/reconcile/status keep working without it — see the soft require at the top). */
function requireBeads() {
  if (!beadsMod) throw new Error('forge-manifest: forge-beads.cjs is unavailable — the dispatch frontier (ready/waves) needs it');
  return beadsMod;
}
function beadsCore() { return requireBeads(); }

/** wpsToBeads(wps) -> bead[] — PURE projection of manifest WP records onto forge-beads' bead shape
 *  ({id, title, status, deps}). See the STATUS MAPPING note in the file header: 'done' stays 'done',
 *  every other status becomes 'open' (still to be dispatched). Never mutates its input. */
function wpsToBeads(wps) {
  return (Array.isArray(wps) ? wps : []).map((wp) => ({
    id: String(wp.wp_id),
    title: String(wp.agent || '') || String(wp.wp_id),
    status: wp.status === WP_DONE_STATUS ? 'done' : 'open',
    deps: (Array.isArray(wp.deps) ? wp.deps : []).map((d) => String(d)),
  }));
}

/** danglingDeps(wps) -> [{wp_id, missing:[depId,...]}, ...] — UNFINISHED work packages that depend on an id
 *  no WP in this manifest carries. Such a package can never become ready (forge-beads fails closed on a dep
 *  that does not resolve to a done bead), so it is surfaced by name rather than left silently blocked. A
 *  package that is already done is not reported: its unresolvable dep can no longer block anything. */
function danglingDeps(wps) {
  const known = new Set((Array.isArray(wps) ? wps : []).map((w) => String(w.wp_id)));
  const out = [];
  for (const wp of (Array.isArray(wps) ? wps : [])) {
    if (wp.status === WP_DONE_STATUS) continue;
    const missing = (Array.isArray(wp.deps) ? wp.deps : []).map((d) => String(d)).filter((d) => !known.has(d));
    if (missing.length) out.push({ wp_id: String(wp.wp_id), missing });
  }
  return out;
}

/** ready(run_id, opts) -> {ok, run_id, ready:[wp,...], cycles, dangling, done, unfinished, total, notes}
 *  The actionable frontier: every WP that is not done and whose deps are ALL done, with any WP inside a
 *  dependency cycle excluded (forge-beads' rule — a package in a cycle can never honestly be "ready").
 *  Loads through load(), so a run that was never armed THROWS exactly as load() does — fail closed, never
 *  a fabricated empty frontier. */
function ready(runId, opts) {
  const b = requireBeads();
  const wps = load(runId, opts);
  const byId = new Map(wps.map((w) => [String(w.wp_id), w]));
  const projected = b.computeReady(wpsToBeads(wps));
  const readyWps = projected.ready.map((x) => byId.get(x.id));
  const dangling = danglingDeps(wps);
  const done = wps.filter((w) => w.status === WP_DONE_STATUS).length;
  const notes = [];
  if (projected.cycles.length) notes.push(projected.cycles.length + ' dependency cycle(s) detected — every work package inside a cycle is excluded from the frontier until the cycle is broken');
  if (dangling.length) notes.push(dangling.length + ' work package(s) depend on a wp_id that was never armed — they can never become ready');
  if (!readyWps.length && done < wps.length && !projected.cycles.length && !dangling.length) {
    notes.push('nothing is startable right now — every unfinished work package is waiting on another one');
  }
  return {
    ok: true, run_id: runId, ready: readyWps, cycles: projected.cycles, dangling,
    done, unfinished: wps.length - done, total: wps.length, notes,
  };
}

/** waves(run_id, opts) -> {ok, run_id, waves:[[wp,...],...], cycles, dangling, unschedulable, total, notes}
 *  The full computed dispatch ORDER: wave 0 is the frontier now; wave N+1 is the frontier that opens up once
 *  every package in wave N is done. Everything inside one wave is mutually independent by construction —
 *  that is the "one writer per hotspot" property the Lead previously had to guarantee by eye.
 *  TERMINATION: each iteration either schedules at least one package (removing it from the pool) or breaks,
 *  and the loop is additionally bounded by the package count — a cycle can never spin it. Whatever remains
 *  unfinished and unscheduled is reported in `unschedulable` (a cycle member, or a dangling dep). */
function waves(runId, opts) {
  const b = requireBeads();
  const wps = load(runId, opts);
  const byId = new Map(wps.map((w) => [String(w.wp_id), w]));
  const beadList = wpsToBeads(wps);
  const cycles = b.computeCycles(beadList);
  const state = new Map(beadList.map((x) => [x.id, x.status]));
  const scheduled = new Set();
  const out = [];
  for (let guard = 0; guard <= beadList.length; guard++) {
    const snapshot = beadList.map((x) => ({ id: x.id, status: state.get(x.id), deps: x.deps }));
    const wave = b.computeReady(snapshot).ready.filter((x) => !scheduled.has(x.id));
    if (!wave.length) break;
    for (const x of wave) { scheduled.add(x.id); state.set(x.id, 'done'); }
    out.push(wave.map((x) => byId.get(x.id)));
  }
  const unschedulable = beadList.filter((x) => x.status !== 'done' && !scheduled.has(x.id)).map((x) => x.id);
  const dangling = danglingDeps(wps);
  const notes = [];
  if (cycles.length) notes.push(cycles.length + ' dependency cycle(s) detected — no wave can ever contain a package inside a cycle');
  if (unschedulable.length) notes.push(unschedulable.length + ' work package(s) can never be scheduled: ' + unschedulable.join(', '));
  return { ok: true, run_id: runId, waves: out, cycles, dangling, unschedulable, total: wps.length, notes };
}

function summarize(runId, manifest) {
  const done = manifest.filter((w) => w.status === 'done');
  const failed = manifest.filter((w) => w.status === 'failed');
  const unfinished = manifest.filter((w) => w.status !== 'done');
  return { ok: true, run_id: runId, manifest, done, failed, unfinished, resumable: unfinished.length > 0 };
}

module.exports = {
  arm, load, reconcile, status,
  projectManifest, normalizeWp, isValidRunId, resolveRoot, manifestPath, eventsPath, runDir,
  readEventsJsonl, eventIsDisproven, DONE_EVENT_TYPES, FAILED_EVENT_TYPES,
  // 2026-08-01 ("pakket 2") — the dispatch frontier, delegating to forge-beads.cjs's proven pure core.
  // beadsCore/wpsToBeads are exported so a test can prove DELEGATION (function identity + mapping rules)
  // instead of only equal-looking output — see the DISPATCH FRONTIER note in the file header.
  ready, waves, wpsToBeads, danglingDeps, beadsCore, WP_DONE_STATUS,
  // 2026-08-01 — the ARM-actually-happens half: opt-in `manifest_armed` proof logging through the real
  // log-event.cjs writer (never a second event writer). See the ARMING ACTUALLY HAPPENS note in the header.
  logManifestArmed, LOG_EVENT_PATH,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, run: null, wps: null, json: false, logEvent: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--run') opts.run = rest[++i];
    else if (a === '--wps') opts.wps = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--log-event') opts.logEvent = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-manifest.cjs arm --run <id> --wps <file.json> [--log-event] [--json]');
  console.error('       node forge-manifest.cjs reconcile --run <id> [--json]');
  console.error('       node forge-manifest.cjs status --run <id> [--json]');
  console.error('       node forge-manifest.cjs ready --run <id> [--json]');
  console.error('       node forge-manifest.cjs waves --run <id> [--json]');
}
function printManifest(r) {
  console.log('forge-manifest · ' + r.run_id + (r.resumable ? ' · RESUMABLE' : ' · COMPLETE'));
  console.log('  done: ' + r.done.length + '  failed: ' + r.failed.length + '  unfinished: ' + r.unfinished.length + '  total: ' + r.manifest.length);
  for (const w of r.manifest) console.log('  [' + w.status + '] ' + w.wp_id + ' (' + w.agent + ')');
}
function printReady(r) {
  console.log('forge-manifest ready · ' + r.run_id + ' · ' + r.ready.length + ' startable now (' + r.done + '/' + r.total + ' done)');
  for (const w of r.ready) console.log('  → ' + w.wp_id + ' (' + w.agent + ')' + (w.deps && w.deps.length ? ' [deps satisfied: ' + w.deps.join(', ') + ']' : ''));
  for (const c of r.cycles) console.log('  CYCLE: ' + c.join(' -> '));
  for (const d of r.dangling) console.log('  DANGLING: ' + d.wp_id + ' depends on ' + d.missing.join(', ') + ' — never armed');
  for (const n of r.notes) console.log('  note: ' + n);
}
function printWaves(r) {
  console.log('forge-manifest waves · ' + r.run_id + ' · ' + r.waves.length + ' wave(s) over ' + r.total + ' work package(s)');
  r.waves.forEach((wave, i) => console.log('  wave ' + i + ': ' + wave.map((w) => w.wp_id).join(', ')));
  for (const c of r.cycles) console.log('  CYCLE: ' + c.join(' -> '));
  for (const n of r.notes) console.log('  note: ' + n);
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'arm') {
      if (!opts.run || !opts.wps) { printUsage(); process.exitCode = 2; }
      else {
        let wpsInput;
        try { wpsInput = JSON.parse(fs.readFileSync(opts.wps, 'utf8')); }
        catch (e) { console.error('forge-manifest: could not read/parse --wps file: ' + e.message); process.exitCode = 2; wpsInput = undefined; }
        if (wpsInput !== undefined) {
          const wps = Array.isArray(wpsInput) ? wpsInput : wpsInput.wps;
          const r = arm({ run_id: opts.run, wps }, { logEvent: opts.logEvent });
          if (opts.json) console.log(JSON.stringify(r));
          else if (!r.ok) console.log('ERROR: ' + r.reason + (r.errors ? ' (' + r.errors.join('; ') + ')' : ''));
          else {
            console.log('armed: ' + r.path + ' (' + r.manifest.length + ' work package(s))');
            // Honest either way: a logged proof event is stated, a failed one is stated too — never silent.
            if (r.logged) console.log(r.logged.ok ? '  proof: manifest_armed event logged' : '  proof: manifest_armed NOT logged — ' + r.logged.reason);
          }
          process.exitCode = r.ok ? 0 : 2;
        }
      }
    } else if (opts.cmd === 'reconcile') {
      if (!opts.run) { printUsage(); process.exitCode = 2; }
      else {
        const r = reconcile({ run_id: opts.run }, {});
        if (opts.json) console.log(JSON.stringify(r));
        else printManifest(r);
        process.exitCode = r.resumable ? 3 : 0;
      }
    } else if (opts.cmd === 'status') {
      if (!opts.run) { printUsage(); process.exitCode = 2; }
      else {
        const r = status(opts.run, {});
        if (opts.json) console.log(JSON.stringify(r));
        else printManifest(r);
        process.exitCode = r.resumable ? 3 : 0;
      }
    } else if (opts.cmd === 'ready') {
      if (!opts.run) { printUsage(); process.exitCode = 2; }
      else {
        const r = ready(opts.run, {});
        if (opts.json) console.log(JSON.stringify(r));
        else printReady(r);
        // exit 3 = "ran clean, but something needs attention" — the same advisory convention forge-beads.cjs
        // uses for a detected cycle. A frontier that is simply empty because everything is DONE is exit 0.
        process.exitCode = (r.cycles.length || r.dangling.length) ? 3 : 0;
      }
    } else if (opts.cmd === 'waves') {
      if (!opts.run) { printUsage(); process.exitCode = 2; }
      else {
        const r = waves(opts.run, {});
        if (opts.json) console.log(JSON.stringify(r));
        else printWaves(r);
        process.exitCode = (r.cycles.length || r.unschedulable.length) ? 3 : 0;
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-manifest: ' + e.message);
    process.exitCode = 2;
  }
}
