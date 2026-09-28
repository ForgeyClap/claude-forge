// GET /api/proof source: the SELECTED project's own evidence chain for one run — the run's own
// `artifacts/` directory listing, any `.claude/forge-artifacts/index.jsonl` entries whose stored
// document actually references this run_id (the index itself carries no run field — verified
// live shape: `{"id":..., "ts":..., "store":"artifacts"}` — so matching is done by reading each
// indexed artifact's own JSON body and checking whether the run_id string appears in it, e.g. its
// `path` field), `doctor.json` if present, and `final-report.md` presence.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { containmentOk, safeIdOk } from './security.mjs';
import { readEvents } from './events.mjs';
import { listRuns } from './runs.mjs';
// WP-CC1 (item 10): the SAME doctor-tally reader health.mjs's own doctor_last now uses (item 15) —
// one implementation of "find the doctor gate and parse its real test tally", not two.
import { readDoctorTallyForRun } from './health.mjs';
import { PROJECT_ROOT } from './paths.mjs';
import { filteredEnv } from './exec-cli.mjs';
import { redactDeep } from './redact.mjs';
import { validateFinalizeReceipt } from './receipt-validator.mjs';
import { readDirBounded } from './bounded-readdir.mjs';

const execFileAsync = promisify(execFile);

// cc-fix-artifacts-empty: the bound `buildProofAll()` respects for its run-artifacts-dir scan —
// "the last ~10 runs", never every run a project has ever had. The forge-artifacts index itself
// is read in full regardless (see `buildProofAll`'s own comment): it is already a bounded, finite
// store, not something that grows per-run the way `forge-runs/` does.
const DEFAULT_MAX_RUNS_FOR_ALL = 10;

// cc-fix-adapter T6b: a real byte size for every run-artifacts-dir file — these are ordinary files
// under a real, already-containment-checked directory, trivially statable. `null` (never 0) when
// the stat itself fails (e.g. a race with a concurrent delete) — an honest "unknown", not a claim
// the file is empty.
function statSizeOrNull(filePath) {
  try { return fs.statSync(filePath).size; } catch { return null; }
}

// Codex verification (F-06): every folder listing below is bounded (readDirBounded); a listing that
// hit its budget sets flags.truncated, which the callers fold into artifacts_truncated.
const MAX_DIR_ENTRIES_LISTED = 5000;
let maxDirEntriesListedOverride = null;
export function _setMaxDirEntriesListedForTests(n) { maxDirEntriesListedOverride = n; }
export function _resetMaxDirEntriesListedForTests() { maxDirEntriesListedOverride = null; }
function listDir(dir, flags) {
  const r = readDirBounded(dir, maxDirEntriesListedOverride ?? MAX_DIR_ENTRIES_LISTED);
  if (r.truncated && flags) flags.truncated = true;
  return r.entries;
}

function listRunArtifactFiles(runDir, flags) {
  const artifactsDir = path.join(runDir, 'artifacts');
  let entries;
  try { entries = listDir(artifactsDir, flags); } catch { return []; }
  return entries.filter((e) => e.isFile()).map((e) => ({
    name: e.name,
    source: 'run-artifacts-dir',
    size_bytes: statSizeOrNull(path.join(artifactsDir, e.name)),
  }));
}

// WP-CC1 (item 11): final reports, gate evidence and PRDs/mission blueprints all sit as plain
// FILES directly in a run's own directory (verified live — e.g.
// `.claude/forge-runs/forge-2026-08-11-quality-intel/PRD-quality-intelligence.md`,
// `.claude/forge-runs/<run>/mission-blueprint.md`), never inside its `artifacts/` subfolder —
// listRunArtifactFiles() above never saw any of them. Matched by real observed name patterns only
// (never a bare substring like "report", which would sweep up unrelated files); an unmatched file
// in the run dir (events.jsonl, run.json, codex-*.out/.err transcripts, etc.) is deliberately not
// listed here — those already have their own honest signals elsewhere (`has_run_json`, the
// events/gate_evidence/finalize fields).
const RUN_TOP_LEVEL_DOC_PATTERNS = [
  { re: /^final-report\.md$/i, type: 'final-report' },
  { re: /^gate-evidence\.json$/i, type: 'gate-evidence' },
  { re: /^(prd|PRD)[-a-z0-9._]*\.md$/i, type: 'prd' },
  { re: /^mission-blueprint[-a-z0-9._]*\.md$/i, type: 'mission-blueprint' },
];
function listRunTopLevelDocFiles(runDir, flags) {
  let entries;
  try { entries = listDir(runDir, flags); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const match = RUN_TOP_LEVEL_DOC_PATTERNS.find((p) => p.re.test(e.name));
    if (!match) continue;
    out.push({ name: e.name, source: 'run-top-level-doc', type: match.type, size_bytes: statSizeOrNull(path.join(runDir, e.name)) });
  }
  return out;
}

// WP-CC1 (item 11): project-wide, not per-run — the solution-first research ledger
// (`.claude/forge-research/`) and the knowledge vault (`.claude/forge-vault/`). Bounded to a
// shallow, capped scan (top-level files + ONE level into subdirectories, capped at
// MAX_PROJECT_LEVEL_FILES total) — these directories can genuinely accumulate many files over a
// project's lifetime, and this is a listing endpoint, never an unbounded recursive walk.
const MAX_PROJECT_LEVEL_FILES = 500;
function listProjectLevelDocFiles(dirPath, source, flags) {
  const out = [];
  let topEntries;
  try { topEntries = listDir(dirPath, flags); } catch { return out; }
  for (const e of topEntries) {
    if (out.length >= MAX_PROJECT_LEVEL_FILES) break;
    const full = path.join(dirPath, e.name);
    if (e.isFile()) {
      out.push({ name: e.name, source, size_bytes: statSizeOrNull(full) });
    } else if (e.isDirectory()) {
      let subEntries;
      try { subEntries = listDir(full, flags); } catch { continue; }
      for (const sub of subEntries) {
        if (out.length >= MAX_PROJECT_LEVEL_FILES) break;
        if (!sub.isFile()) continue; // one level deep only — a further-nested file is not walked
        out.push({ name: e.name + '/' + sub.name, source, size_bytes: statSizeOrNull(path.join(full, sub.name)) });
      }
    }
  }
  return out;
}

// cc-fix-adapter T6b: an indexed artifact's own `doc.path` is agent-authored free text, never
// trusted as-is — resolved against the PROJECT root (relative paths are the real convention seen
// in this fleet's own artifact docs) and re-checked with the same containment guard every other
// module in this gateway uses. Anything that fails to resolve, escapes the project, or does not
// exist on disk yields `null` — never a fabricated 0.
// WP-CC1 (item 11): a stored artifact doc's own `path` is relative to `.claude/`, NOT the project
// root — verified against this project's own real artifact docs (e.g.
// `wp0-audit-reports.json`'s `path: "forge-runs/forge-2026-07-25-full-audit/artifacts/"`, which on
// disk only exists at `.claude/forge-runs/...`, never `<root>/forge-runs/...`). Resolving against
// the bare project root (the previous behavior) silently missed the `.claude/` segment, so every
// indexed artifact with a relative path always reported `size_bytes: null` — not an error, just
// quietly always wrong. Falls back to a bare-project-root resolution only when the `.claude/`-
// relative candidate does not exist, so a genuinely different future convention is never broken.
function statIndexedArtifactSize(projectPath, maybePath) {
  if (typeof maybePath !== 'string' || maybePath.length === 0) return null;
  if (path.isAbsolute(maybePath)) {
    if (!containmentOk(projectPath, maybePath)) return null;
    return statSizeOrNull(maybePath);
  }
  const claudeDir = path.join(projectPath, '.claude');
  const claudeRelative = path.join(claudeDir, maybePath);
  if (containmentOk(claudeDir, claudeRelative)) {
    const size = statSizeOrNull(claudeRelative);
    if (size !== null) return size;
  }
  const rootRelative = path.join(projectPath, maybePath);
  if (!containmentOk(projectPath, rootRelative)) return null;
  return statSizeOrNull(rootRelative);
}

// Codex run B F-06: forge-artifacts/index.jsonl was previously read in full every call on the
// stated assumption that it is "a bounded, finite store, not something that grows per-run" (see the
// cc-fix-artifacts-empty comment above) — but nothing actually enforced that, and an unusually
// long-lived project is exactly the kind of unbounded-growth risk this gateway bounds everywhere
// else (runs.mjs's own events.jsonl tail-read, its run-directory-count cap). Bounded the same way:
// a BYTE ceiling first (a huge file is never read into memory in full — same tail-read technique as
// runs.mjs's readEventsFileTailBounded(), kept for one-codebase-convention consistency rather than
// introducing a separate streaming primitive), then an ENTRY-count ceiling on the parsed lines,
// keeping the newest slice of the file/list either way (the file is append-only, so "newest" is
// "at the end" exactly like events.jsonl). `truncated:true` whenever either bound actually cut
// something, so buildProof()/buildProofAll() can report it honestly via `artifacts_truncated`
// instead of silently returning a partial artifacts list with no signal at all.
const MAX_INDEX_FILE_READ_BYTES = 2 * 1024 * 1024; // 2MB — generous; real index.jsonl files seen so far are far smaller
const MAX_INDEX_ENTRIES = 2000;
// Per-document size cap: an individual indexed artifact doc is normally a small JSON record (title/
// type/path/summary) — a single document this large would be a data anomaly worth refusing to load
// rather than trusting, not a real artifact record this endpoint needs to render.
const MAX_ARTIFACT_DOC_READ_BYTES = 512 * 1024; // 512KB per document
// Exported so tests can build a fixture that is reliably over/under the REAL bound rather than
// hand-duplicating (and silently drifting from) these numbers — same `_X_FOR_TESTS` convention as
// this file's _RUN_CONTRACT_CACHE_TTL_MS_FOR_TESTS.
export const _MAX_INDEX_FILE_READ_BYTES_FOR_TESTS = MAX_INDEX_FILE_READ_BYTES;
export const _MAX_INDEX_ENTRIES_FOR_TESTS = MAX_INDEX_ENTRIES;
export const _MAX_ARTIFACT_DOC_READ_BYTES_FOR_TESTS = MAX_ARTIFACT_DOC_READ_BYTES;

function readIndexEntries(indexFile) {
  let stat;
  try { stat = fs.statSync(indexFile); } catch { return { entries: [], truncated: false }; }
  let text;
  let byteTruncated = false;
  if (stat.size <= MAX_INDEX_FILE_READ_BYTES) {
    try { text = fs.readFileSync(indexFile, 'utf8'); } catch { return { entries: [], truncated: false }; }
  } else {
    byteTruncated = true;
    const readLen = MAX_INDEX_FILE_READ_BYTES;
    const buf = Buffer.alloc(readLen);
    const fd = fs.openSync(indexFile, 'r');
    try { fs.readSync(fd, buf, 0, readLen, stat.size - readLen); } finally { fs.closeSync(fd); }
    const raw = buf.toString('utf8');
    const firstNewline = raw.indexOf('\n'); // the read window's own first line is very likely partial — discard it
    text = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let entryTruncated = false;
  let selected = lines;
  if (lines.length > MAX_INDEX_ENTRIES) {
    entryTruncated = true;
    selected = lines.slice(lines.length - MAX_INDEX_ENTRIES); // keep the newest N entries
  }
  const out = [];
  for (const line of selected) {
    try { out.push(JSON.parse(line)); } catch { /* skip a malformed line — an honest partial result beats a crash */ }
  }
  return { entries: out, truncated: byteTruncated || entryTruncated };
}

// Returns { doc, tooLarge } rather than a bare doc-or-null: a caller needs to tell "this artifact
// genuinely has no doc / failed to parse" (tooLarge:false, doc:null — same as before) apart from
// "this doc exists but was refused for exceeding the per-document size cap" (tooLarge:true), so the
// F-06 truncation signal reports a skipped-for-size document honestly instead of it silently looking
// like a missing/absent one.
function readArtifactStoreDoc(artifactsDir, id, remainingBytes = Infinity) {
  const filePath = path.join(artifactsDir, id + '.json'); // verified live shape: flat "<id>.json" under forge-artifacts/
  if (!containmentOk(artifactsDir, filePath)) return { doc: null, tooLarge: false, bytes: 0 };
  let stat;
  try { stat = fs.statSync(filePath); } catch { return { doc: null, tooLarge: false, bytes: 0 }; }
  if (stat.size > MAX_ARTIFACT_DOC_READ_BYTES) return { doc: null, tooLarge: true, bytes: 0 };
  if (stat.size > remainingBytes) return { doc: null, tooLarge: false, overBudget: true, bytes: 0 };
  try { return { doc: JSON.parse(fs.readFileSync(filePath, 'utf8')), tooLarge: false, bytes: stat.size }; } catch { return { doc: null, tooLarge: false, bytes: stat.size }; }
}

// Codex run B F-06, Lead review: the per-document cap alone still allowed 2000 x 512 KB (about 1 GB)
// of reads for one GET. One request now reads at most MAX_TOTAL_ARTIFACT_DOC_BYTES of documents,
// NEWEST first (so a stop drops the oldest ones), and reports the stop as truncated. The documents
// come back in index order, the order both callers have always produced.
const MAX_TOTAL_ARTIFACT_DOC_BYTES = 8 * 1024 * 1024;
export const _MAX_TOTAL_ARTIFACT_DOC_BYTES_FOR_TESTS = MAX_TOTAL_ARTIFACT_DOC_BYTES;
let maxTotalArtifactDocBytesOverride = null;
export function _setMaxTotalArtifactDocBytesForTests(n) { maxTotalArtifactDocBytesOverride = n; }
export function _resetMaxTotalArtifactDocBytesForTests() { maxTotalArtifactDocBytesOverride = null; }

function readIndexedDocs(artifactsDir, indexEntries) {
  let remaining = maxTotalArtifactDocBytesOverride ?? MAX_TOTAL_ARTIFACT_DOC_BYTES;
  let truncated = false;
  const docs = [];
  for (let i = indexEntries.length - 1; i >= 0; i -= 1) {
    const entry = indexEntries[i];
    if (!entry || !entry.id) continue;
    const r = readArtifactStoreDoc(artifactsDir, entry.id, remaining);
    if (r.tooLarge) { truncated = true; continue; }
    if (r.overBudget) { truncated = true; break; }
    remaining -= r.bytes;
    if (r.doc) docs.push({ entry, doc: r.doc });
  }
  docs.reverse();
  return { docs, truncated };
}

// WP-CC1 (item 10): review_started/review_completed (plain reviews) and
// codex_review_started/codex_review_completed (Codex reviews) — verified live shape:
// review_started carries {agent, review_id, subject, timestamp}; review_completed carries
// {agent, review_id, verdict, summary, evidence, timestamp} (no explicit commit_sha on the real
// events seen so far — read opportunistically, honest null when absent, never invented).
const REVIEW_START_TYPES = new Set(['review_started', 'codex_review_started']);
const REVIEW_DONE_TYPES = new Set(['review_completed', 'codex_review_completed']);

function buildReviews(events) {
  const byReviewId = new Map();
  const order = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || typeof ev.review_id !== 'string' || !ev.review_id) continue;
    const et = ev.event_type;
    if (REVIEW_START_TYPES.has(et)) {
      if (!byReviewId.has(ev.review_id)) {
        const record = {
          review_id: ev.review_id,
          agent: ev.agent || null,
          subject: ev.subject || null,
          verdict: null,
          commit_sha: null,
          started_at: ev.timestamp || null,
          completed_at: null,
        };
        byReviewId.set(ev.review_id, record);
        order.push(record);
      }
    } else if (REVIEW_DONE_TYPES.has(et)) {
      let record = byReviewId.get(ev.review_id);
      if (!record) {
        // A completion with no matching start in this run's own history — still real evidence,
        // reported as its own row rather than silently dropped (mirrors missions.mjs's own
        // "an honest gap" convention for an unmatched completion).
        record = { review_id: ev.review_id, agent: null, subject: null, verdict: null, commit_sha: null, started_at: null, completed_at: null };
        byReviewId.set(ev.review_id, record);
        order.push(record);
      }
      record.agent = record.agent || ev.agent || null;
      record.verdict = typeof ev.verdict === 'string' ? ev.verdict : record.verdict;
      record.commit_sha = typeof ev.commit_sha === 'string' ? ev.commit_sha : record.commit_sha;
      record.completed_at = ev.timestamp || record.completed_at;
    }
  }
  return order;
}

// WP-CC1 (item 10): real gate-evidence.json shape (verified live) — every gate a REAL executed
// process, with its own exact exit code/duration/commit-stability. Mapped 1:1, never invented; a
// missing/unparseable file is honestly null (buildProof reports gate_evidence_present:false).
function readGateEvidence(runDir) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path.join(runDir, 'gate-evidence.json'), 'utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    gates_total: typeof parsed.gates_total === 'number' ? parsed.gates_total : null,
    gates_failed: typeof parsed.gates_failed === 'number' ? parsed.gates_failed : null,
    all_green: typeof parsed.all_green === 'boolean' ? parsed.all_green : null,
    commit: parsed.code && typeof parsed.code.commit === 'string' ? parsed.code.commit : null,
    worktree_clean: parsed.code && typeof parsed.code.worktree_clean === 'boolean' ? parsed.code.worktree_clean : null,
    generated_at: typeof parsed.generated_at === 'string' ? parsed.generated_at : null,
    gates: Array.isArray(parsed.gates)
      ? parsed.gates.map((g) => ({
          name: typeof g.name === 'string' ? g.name : null,
          exit_code: g.exit_code != null ? g.exit_code : null,
          duration_ms: typeof g.duration_ms === 'number' ? g.duration_ms : null,
          timed_out: typeof g.timed_out === 'boolean' ? g.timed_out : null,
          stable: g.code && typeof g.code.stable === 'boolean' ? g.code.stable : null,
        }))
      : [],
  };
}

// WP-CC1 (item 10): real run-finalized.json shape (verified live) — mapped 1:1.
// Codex run B F-11: now runs through the SAME shared validateFinalizeReceipt() runs.mjs uses
// (receipt-validator.mjs) before any field is trusted — a forged `{}`/`[]`, one missing run_id/
// digest/contract/bytes/events, a run_id that names a DIFFERENT run, or a non-'ok' contract no
// longer counts as "finalized:true" (confirmed against forge-finalize.cjs's own real write —
// `{schema, run_id, digest, bytes, events, seq_last, contract:'ok', domain, ruleset_sha256, ...,
// finalized_at}`, read-only, line ~575). Returns { receipt, invalidReason }: `receipt` is the mapped
// public shape (null when absent OR invalid), `invalidReason` is non-null ONLY when a
// run-finalized.json genuinely exists but failed validation — an honest "this claims to be a receipt
// but isn't a trustworthy one", never confused with the ordinary "no receipt yet" case.
function readFinalizeReceipt(runDir, runId) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path.join(runDir, 'run-finalized.json'), 'utf8')); } catch { parsed = null; }
  const check = validateFinalizeReceipt(parsed, runId);
  if (!check.valid) {
    return { receipt: null, invalidReason: check.reason === 'absent' ? null : check.reason };
  }
  const r = check.receipt;
  return {
    receipt: {
      digest: typeof r.digest === 'string' ? r.digest : null,
      contract: typeof r.contract === 'string' ? r.contract : null,
      domain: typeof r.domain === 'string' ? r.domain : null,
      events: typeof r.events === 'number' ? r.events : null,
      ruleset_sha256: typeof r.ruleset_sha256 === 'string' ? r.ruleset_sha256 : null,
      finalized_at: typeof r.finalized_at === 'string' ? r.finalized_at : null,
    },
    invalidReason: null,
  };
}

// WP-CC1 (item 10): a READ-ONLY run-contract check, through the CENTRAL forge-runcontract.cjs this
// gateway's own host project ships (never a SELECTED, possibly-untrusted project's own copy —
// mirrors config.mjs's own "SETTINGS, NEVER CODE" hardening: this gateway never executes a
// selected project's own scripts) — `--root <selected project>` points the CENTRAL tool's own
// evaluation AT that project's real run/rules data, exactly like config.mjs's FORGE_PROJECT_ROOT
// convention. `--json` only; NEVER `--log-event`/`--finalize` (this is a read, never a write, and
// never logs a proof event on the caller's behalf). Exit code 3 ("NOT DONE — missing N required
// rule(s)") is a normal, expected, non-exceptional outcome with real JSON on stdout — treated as
// data, not a crash; only a genuine spawn failure/timeout/unparsable-output is UNAVAILABLE.
const CENTRAL_FORGE_RUNCONTRACT_CJS = path.join(PROJECT_ROOT, '.claude', 'forge-bin', 'forge-runcontract.cjs');
const RUN_CONTRACT_TIMEOUT_MS = 8000;
const RUN_CONTRACT_CACHE_TTL_MS = 30_000;
const MAX_RUN_CONTRACT_CACHE_ENTRIES = 200;
const runContractCache = new Map(); // "<projectPath>::<runId>" -> { data, expiresAt }

// Codex run B F-07: forge-runcontract.cjs is a REAL child-process spawn (up to RUN_CONTRACT_TIMEOUT_MS
// each) — two safeguards against unbounded concurrent spawns:
//   1. IN-FLIGHT DEDUPLICATION (runContractInFlight): a second caller for the SAME
//      "<projectPath>::<runId>" key while a check is already running reuses that SAME in-flight
//      Promise instead of spawning its own duplicate child (buildProofAll() calling buildRunContract
//      for the same run twice in quick succession, or two concurrent /api/proof requests for the
//      same run, are exactly this case).
//   2. GLOBAL CONCURRENCY CAP (MAX_CONCURRENT_RUN_CONTRACT_CHILDREN): at most this many DIFFERENT
//      keys' children run at once across the whole gateway. A request beyond the cap waits for a
//      free slot, up to MAX_RUN_CONTRACT_QUEUE_WAITERS queued waiters; once that queue is also full,
//      the request gets an honest "check pending" result (available:false, pending:true) instead of
//      growing the queue without bound or spawning anyway. A "check pending" result is intentionally
//      NEVER cached — the very next call tries again rather than being stuck with a stale "pending".
const MAX_CONCURRENT_RUN_CONTRACT_CHILDREN = 2;
const MAX_RUN_CONTRACT_QUEUE_WAITERS = 50;
let runContractRunningCount = 0;
const runContractWaitQueue = []; // array of resolver functions, each waiting for a free slot
const runContractInFlight = new Map(); // "<projectPath>::<runId>" -> Promise<data>

// Test-only override for the queue cap — proving the REAL 50-waiter overflow would need 53 real
// concurrent child spawns; overriding this to a small number lets a test prove the exact same
// "queue is also full -> honest pending, never grows without bound" behavior with a handful of
// fixture processes. Production code never calls this.
let maxRunContractQueueWaitersOverride = null;
export function _setMaxRunContractQueueWaitersForTests(n) { maxRunContractQueueWaitersOverride = n; }
export function _resetMaxRunContractQueueWaitersForTests() { maxRunContractQueueWaitersOverride = null; }
function activeMaxRunContractQueueWaiters() { return maxRunContractQueueWaitersOverride ?? MAX_RUN_CONTRACT_QUEUE_WAITERS; }

let runContractCjsOverride = null;
export function _setRunContractCjsForTests(p) { runContractCjsOverride = p; }
export function _resetRunContractCacheForTests() { runContractCache.clear(); }
export function _resetRunContractConcurrencyForTests() {
  runContractRunningCount = 0;
  runContractWaitQueue.length = 0;
  runContractInFlight.clear();
}
export function _getRunContractRunningCountForTests() { return runContractRunningCount; }
export function _getRunContractQueueLengthForTests() { return runContractWaitQueue.length; }
function activeRunContractCjs() { return runContractCjsOverride || CENTRAL_FORGE_RUNCONTRACT_CJS; }

// Resolves true once a slot is actually granted, or false immediately when the wait queue itself is
// already full (the caller must not spawn in that case — see MAX_RUN_CONTRACT_QUEUE_WAITERS above).
function acquireRunContractSlot() {
  if (runContractRunningCount < MAX_CONCURRENT_RUN_CONTRACT_CHILDREN) {
    runContractRunningCount++;
    return Promise.resolve(true);
  }
  if (runContractWaitQueue.length >= activeMaxRunContractQueueWaiters()) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => { runContractWaitQueue.push(resolve); });
}

// Hands the just-freed slot DIRECTLY to the next queued waiter when one exists (runningCount stays
// the same — one release, one immediate acquire); only decrements the running count when nobody is
// waiting.
function releaseRunContractSlot() {
  const next = runContractWaitQueue.shift();
  if (next) next(true);
  else runContractRunningCount--;
}

async function probeRunContractWithConcurrencyLimit(projectPath, runId) {
  const granted = await acquireRunContractSlot();
  if (!granted) {
    return { available: false, note: 'too many concurrent run-contract checks in flight — check pending, try again shortly', pending: true };
  }
  try {
    return await probeRunContractLive(projectPath, runId);
  } finally {
    releaseRunContractSlot();
  }
}

function parseRunContractStdout(stdout) {
  try {
    const body = JSON.parse(stdout);
    if (body && typeof body === 'object' && typeof body.ok === 'boolean') return body;
  } catch { /* not JSON — fall through */ }
  return null;
}

// WP-CC1 (Lead review, LOW — defense in depth): `runId` already passed the caller's own
// `safeIdOk()` (alphanumeric/underscore/hyphen only, no slashes or dots — path traversal is
// already structurally impossible), and forge-runcontract.cjs's own CLI parser already consumes
// whatever string immediately follows `--run` as a plain positional value, so a leading '-' cannot
// inject a flag today (verified by reading that parser). Refused anyway, and BEFORE any spawn, so
// this can never become live even if that parser's own behavior ever changes, and so an obviously
// bogus id never reaches execFileAsync at all.
function isSafeRunIdForSpawn(runId) {
  return typeof runId === 'string' && runId.length > 0 && !runId.startsWith('-');
}

// WP-CC1 (Lead review, LOW): a run folder that does not exist must never trigger a spawn at all —
// "unknown run" is answered directly instead, so a page that GETs /api/proof with an arbitrary or
// enumerated run id can never cause one forge-runcontract.cjs process per request. Mirrors
// buildProof()'s own `runsDir`/`runDir`/`containmentOk` computation (defense in depth: `runId`
// already passed `safeIdOk` upstream, which already forbids the slashes/dots a traversal would need).
function runFolderExists(projectPath, runId) {
  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const runDir = path.join(runsDir, runId);
  if (!containmentOk(runsDir, runDir)) return false;
  try { return fs.statSync(runDir).isDirectory(); } catch { return false; }
}

async function probeRunContractLive(projectPath, runId) {
  if (!isSafeRunIdForSpawn(runId)) {
    return { available: false, note: 'refused: run id must not start with "-"' };
  }
  if (!runFolderExists(projectPath, runId)) {
    return { available: false, note: 'unknown run — refused before any spawn' };
  }
  if (!fs.existsSync(activeRunContractCjs())) {
    return { available: false, note: 'the central forge-runcontract.cjs was not found' };
  }
  const args = [activeRunContractCjs(), 'check', '--run', runId, '--root', projectPath, '--json'];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: PROJECT_ROOT, env: filteredEnv({ credentialFree: true }),
      timeout: RUN_CONTRACT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    const body = parseRunContractStdout(stdout);
    if (!body) return { available: false, note: 'forge-runcontract.cjs check returned output that is not the expected JSON shape' };
    return { available: true, result: redactDeep(body) };
  } catch (err) {
    // Exit code 3 ("NOT DONE") is a normal outcome with real JSON on stdout — never a crash.
    const body = err && typeof err.stdout === 'string' ? parseRunContractStdout(err.stdout) : null;
    if (body) return { available: true, result: redactDeep(body) };
    if (err && err.killed) return { available: false, note: 'forge-runcontract.cjs check timed out after ' + RUN_CONTRACT_TIMEOUT_MS + 'ms' };
    return { available: false, note: 'forge-runcontract.cjs check failed: ' + (err && err.message ? err.message : String(err)) };
  }
}

async function buildRunContract(projectPath, runId, now = Date.now()) {
  const key = projectPath + '::' + runId;
  const cached = runContractCache.get(key);
  if (cached && cached.expiresAt > now) return cached.data;

  // Codex run B F-07: a second caller for the SAME key while a check is already running reuses the
  // SAME in-flight Promise — never a second concurrent spawn for one project+run.
  const existingInFlight = runContractInFlight.get(key);
  if (existingInFlight) return existingInFlight;

  const inFlightPromise = probeRunContractWithConcurrencyLimit(projectPath, runId)
    .then((probe) => {
      const data = { ...probe, checked_at: new Date(now).toISOString() };
      // A "check pending" result (the concurrency queue was itself full) is honest but not a real
      // answer — never cached, so the next call gets a genuine attempt rather than a stuck "pending".
      if (!data.pending) {
        if (runContractCache.size >= MAX_RUN_CONTRACT_CACHE_ENTRIES && !runContractCache.has(key)) {
          runContractCache.delete(runContractCache.keys().next().value); // FIFO eviction, same bound discipline as this file's siblings
        }
        runContractCache.set(key, { data, expiresAt: now + RUN_CONTRACT_CACHE_TTL_MS });
      }
      return data;
    })
    .finally(() => { runContractInFlight.delete(key); });

  runContractInFlight.set(key, inFlightPromise);
  return inFlightPromise;
}

export const _RUN_CONTRACT_CACHE_TTL_MS_FOR_TESTS = RUN_CONTRACT_CACHE_TTL_MS;

export async function buildProof(projectPath, runId) {
  if (!safeIdOk(runId)) return { ok: false, error: 'invalid run id' };
  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const runDir = path.join(runsDir, runId);
  if (!containmentOk(runsDir, runDir)) return { ok: false, error: 'path containment violation' };

  const artifactsStoreDir = path.join(projectPath, '.claude', 'forge-artifacts');
  const indexFile = path.join(artifactsStoreDir, 'index.jsonl');

  const listFlags = { truncated: false };
  const runArtifacts = listRunArtifactFiles(runDir, listFlags);
  const { entries: indexEntries, truncated: indexTruncated } = readIndexEntries(indexFile);
  const matchedStoreArtifacts = [];
  const { docs: indexedDocs, truncated: docsTooLargeSkipped } = readIndexedDocs(artifactsStoreDir, indexEntries);
  for (const { entry, doc } of indexedDocs) {
    if (!JSON.stringify(doc).includes(runId)) continue; // only artifacts that actually reference THIS run
    matchedStoreArtifacts.push({
      id: entry.id, store: entry.store || null, ts: entry.ts || null,
      title: doc.title || null, type: doc.type || doc.kind || null, path: doc.path || null,
      summary: doc.summary || null, source: 'forge-artifacts-index',
      size_bytes: statIndexedArtifactSize(projectPath, doc.path),
    });
  }
  // Codex run B F-06: true whenever the index.jsonl read was byte/entry-bounded OR any indexed
  // document was skipped for exceeding the per-document size cap — an honest signal that this
  // project's artifacts list may not be exhaustive, never a silent partial result.
  const artifactsTruncated = indexTruncated || docsTooLargeSkipped || listFlags.truncated;

  const reportPresent = fs.existsSync(path.join(runDir, 'final-report.md'));
  // WP-CC1 (item 10/15): the SAME reader health.mjs's own doctor_last uses — prefers the modern
  // gate-evidence.json doctor gate over a standalone doctor.json, so this run's proof view shows the
  // real doctor tally even when (like this run) no standalone doctor.json was ever written.
  const doctorTally = readDoctorTallyForRun(runDir, projectPath);
  const doctorSummary = doctorTally ? { ok: doctorTally.ok, suites: doctorTally.suites ?? null, passed: doctorTally.passed ?? null, failed: doctorTally.failed ?? null, source: doctorTally.source } : null;

  const eventsResult = readEvents(projectPath, runId, 0);
  // WP-CC1 (item 10): checks now get their real NAME from `check` (23 of 46 real events in this
  // fleet carry no `command` at all) and keep `summary`; the LATEST result per check name wins — a
  // check that failed and later passed is reported as its passing result, never as a still-open
  // failure. Keyed by `check` (falling back to `command` when a check genuinely has neither name —
  // extremely rare and, honestly, un-deduplicable without a stable identity) — an UNKEYABLE event
  // is never merged with anything, only ever appended as its own row, in real file order.
  const checksByKey = new Map(); // key -> verdict row (Map preserves first-seen ORDER; .set() on an
  // existing key updates the row in place without moving its position — "first seen slot, latest
  // value" is exactly the ordering + freshness this needs)
  const unkeyedChecks = [];
  if (eventsResult.ok) {
    for (const ev of eventsResult.events) {
      if (ev.event_type !== 'check_passed' && ev.event_type !== 'check_failed') continue;
      const row = {
        source: 'event', event_type: ev.event_type, agent: ev.agent || null, role: ev.role || null,
        check: typeof ev.check === 'string' ? ev.check : null,
        summary: typeof ev.summary === 'string' ? ev.summary : null,
        command: ev.command || null, exit_code: ev.exit_code != null ? ev.exit_code : null,
        // cc-fix-adapter T6b/gate-output fix: `output` was already on the raw event (missions.mjs's
        // own verdict builder already reads it) but this route never forwarded it, so a gate's real
        // console output was always dropped in favour of an empty string downstream. Kept alongside
        // `evidence`, not instead of it — the two are genuinely different fields on a real event.
        evidence: ev.evidence || null, output: ev.output || null, timestamp: ev.timestamp || null,
      };
      const key = row.check || row.command;
      if (key) checksByKey.set(key, row);
      else unkeyedChecks.push(row);
    }
  }
  const verdicts = [];
  // Lead fix after the real-location suite (2026-09-28): doctorSummary carries its own `source`
  // (where the tally came from: 'doctor.json' or 'gate-evidence-output-file'). Spread first, that
  // field overwrote the verdict's `source: 'doctor'`, so the doctor verdict vanished for every
  // reader that looks for it (the dashboard included). The verdict source stays 'doctor'; the tally's
  // origin moves to `doctor_source`.
  if (doctorSummary) {
    const { source: doctorSource, ...doctorRest } = doctorSummary;
    verdicts.push({ ...doctorRest, source: 'doctor', doctor_source: doctorSource });
  }
  verdicts.push(...checksByKey.values(), ...unkeyedChecks);

  // WP-CC1 (item 10): reviews, gate evidence and the finalize receipt — real, additive sources.
  const reviews = eventsResult.ok ? buildReviews(eventsResult.events) : [];
  const gateEvidence = readGateEvidence(runDir);
  const { receipt: finalizeReceipt, invalidReason: finalizeInvalidReason } = readFinalizeReceipt(runDir, runId);
  const runContract = await buildRunContract(projectPath, runId);

  return {
    ok: true,
    run_id: runId,
    artifacts: [...runArtifacts, ...matchedStoreArtifacts],
    verdicts,
    report_present: reportPresent,
    doctor_present: !!doctorSummary,
    // Codex run B F-06: true when the artifacts-index read was bounded (bytes/entries) or a document
    // was skipped for exceeding the per-document size cap — see readIndexEntries()/
    // readArtifactStoreDoc() headers.
    artifacts_truncated: artifactsTruncated,
    // WP-CC1 (item 10) additions:
    reviews,
    reviews_count: reviews.length,
    gate_evidence: gateEvidence,
    gate_evidence_present: gateEvidence !== null,
    finalize_receipt: finalizeReceipt,
    finalized: finalizeReceipt !== null,
    // Codex run B F-11 addition: non-null ONLY when a run-finalized.json genuinely exists but failed
    // shared-validator checks — mirrors runs.mjs's own `finalize_invalid_reason` field/convention.
    finalize_invalid_reason: finalizeInvalidReason,
    run_contract: runContract,
    captured_at: new Date().toISOString(),
    age_ms: 0,
    provenance: 'DERIVED',
  };
}

// cc-fix-artifacts-empty: `/api/proof?run=all` real source — closes the "Artifacts shows 0/0 for
// every project" bug (`buildProof` above only ever looks at ONE run's own evidence; the newest run
// is very often the emptiest one, while older runs and the project-wide forge-artifacts index carry
// the real history). This is a SEPARATE function, not a `runId === 'all'` branch inside `buildProof`,
// because the two responses genuinely mean different things: `verdicts`/`report_present`/
// `doctor_present` are real facts about ONE run and do not generalize across many, so this response
// honestly zeroes them out rather than picking an arbitrary run's values to stand in for all of them.
//
// Bound (owner instruction): at most `maxRuns` most-recent runs (reuses `runs.mjs`'s own
// `listRuns()`, including its file-identity scan cache — never re-scans what that cache already
// has) are walked for a `run-artifacts-dir` listing — never every run this project has ever
// produced. The forge-artifacts index is read in full every call (same as `buildProof` already
// does) because it is itself a bounded, finite store, not something that scales with run count.
//
// Every artifact carries its own real `run_id` — the run-artifacts-dir ones trivially (they were
// found INSIDE that run's own directory); a forge-artifacts-index entry gets the newest candidate
// run whose id is found inside its own stored JSON body (same substring-match technique
// `buildProof` already uses for one run, just tried against each candidate in recency order), or
// `null` when no run in the considered window references it — an honest absence, never a guessed
// run and never silently dropped from the list.
export function buildProofAll(projectPath, maxRuns = DEFAULT_MAX_RUNS_FOR_ALL) {
  const runsResult = listRuns(projectPath);
  // WP-CC1 (item 11): `listRuns()` already RANKS real work ahead of synthetic/junk runs (item 1),
  // which is enough to keep this window clean on a fleet with >= maxRuns real runs — but a fleet
  // (or an isolated test/bench root) with FEWER real runs than maxRuns would still have synthetic
  // ones fill the remaining slots after a plain `.slice()`. Filtered out explicitly here so "the
  // last N runs" window is never partly junk regardless of how many real runs exist; an honestly
  // SMALLER real window (even zero) is always preferred over padding it with bench/doctor fixtures.
  const candidateRunIds = runsResult.ok
    ? runsResult.runs.filter((r) => !r.synthetic).slice(0, maxRuns).map((r) => r.run_id)
    : [];

  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const runArtifacts = [];
  const allListFlags = { truncated: false };
  for (const runId of candidateRunIds) {
    const runDir = path.join(runsDir, runId);
    if (!containmentOk(runsDir, runDir)) continue; // should be impossible — runId came from listRuns()'s own readdir
    for (const artifact of listRunArtifactFiles(runDir, allListFlags)) {
      runArtifacts.push({ ...artifact, run_id: runId });
    }
    // WP-CC1 (item 11): final reports, gate evidence and PRDs/mission-blueprints — real files that
    // sit directly in the run dir, never inside artifacts/ (see listRunTopLevelDocFiles()'s header).
    for (const doc of listRunTopLevelDocFiles(runDir, allListFlags)) {
      runArtifacts.push({ ...doc, run_id: runId });
    }
  }

  // WP-CC1 (item 11): project-wide sources, not scoped to any one run — the solution-first
  // research ledger and the knowledge vault. Bounded scans (see listProjectLevelDocFiles()).
  const researchArtifacts = listProjectLevelDocFiles(path.join(projectPath, '.claude', 'forge-research'), 'forge-research', allListFlags)
    .map((a) => ({ ...a, run_id: null }));
  const vaultArtifacts = listProjectLevelDocFiles(path.join(projectPath, '.claude', 'forge-vault'), 'forge-vault', allListFlags)
    .map((a) => ({ ...a, run_id: null }));

  const artifactsStoreDir = path.join(projectPath, '.claude', 'forge-artifacts');
  const indexFile = path.join(artifactsStoreDir, 'index.jsonl');
  const { entries: indexEntries, truncated: indexTruncated } = readIndexEntries(indexFile);
  const matchedStoreArtifacts = [];
  const { docs: indexedDocs, truncated: docsTooLargeSkipped } = readIndexedDocs(artifactsStoreDir, indexEntries);
  for (const { entry, doc } of indexedDocs) {
    const docJson = JSON.stringify(doc);
    // candidateRunIds is newest-first (listRuns()'s own recency sort) — the first match is the
    // most recent real run that genuinely references this artifact, never an arbitrary one.
    const matchedRunId = candidateRunIds.find((id) => docJson.includes(id)) ?? null;
    matchedStoreArtifacts.push({
      id: entry.id, store: entry.store || null, ts: entry.ts || null,
      title: doc.title || null, type: doc.type || doc.kind || null, path: doc.path || null,
      summary: doc.summary || null, source: 'forge-artifacts-index',
      size_bytes: statIndexedArtifactSize(projectPath, doc.path),
      run_id: matchedRunId,
    });
  }

  return {
    ok: true,
    run_id: 'all',
    artifacts: [...runArtifacts, ...matchedStoreArtifacts, ...researchArtifacts, ...vaultArtifacts],
    verdicts: [],
    report_present: false,
    doctor_present: false,
    // Codex run B F-06: see buildProof()'s own field comment — same meaning, same two causes.
    artifacts_truncated: indexTruncated || docsTooLargeSkipped || allListFlags.truncated,
    captured_at: new Date().toISOString(),
    age_ms: 0,
    provenance: 'DERIVED',
  };
}
