// GET /api/proof source: the SELECTED project's own evidence chain for one run — the run's own
// `artifacts/` directory listing, any `.claude/forge-artifacts/index.jsonl` entries whose stored
// document actually references this run_id (the index itself carries no run field — verified
// live shape: `{"id":..., "ts":..., "store":"artifacts"}` — so matching is done by reading each
// indexed artifact's own JSON body and checking whether the run_id string appears in it, e.g. its
// `path` field), `doctor.json` if present, and `final-report.md` presence.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk, safeIdOk } from './security.mjs';
import { readEvents } from './events.mjs';
import { listRuns } from './runs.mjs';

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

function listRunArtifactFiles(runDir) {
  const artifactsDir = path.join(runDir, 'artifacts');
  let entries;
  try { entries = fs.readdirSync(artifactsDir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isFile()).map((e) => ({
    name: e.name,
    source: 'run-artifacts-dir',
    size_bytes: statSizeOrNull(path.join(artifactsDir, e.name)),
  }));
}

// cc-fix-adapter T6b: an indexed artifact's own `doc.path` is agent-authored free text, never
// trusted as-is — resolved against the PROJECT root (relative paths are the real convention seen
// in this fleet's own artifact docs) and re-checked with the same containment guard every other
// module in this gateway uses. Anything that fails to resolve, escapes the project, or does not
// exist on disk yields `null` — never a fabricated 0.
function statIndexedArtifactSize(projectPath, maybePath) {
  if (typeof maybePath !== 'string' || maybePath.length === 0) return null;
  const resolved = path.isAbsolute(maybePath) ? maybePath : path.join(projectPath, maybePath);
  if (!containmentOk(projectPath, resolved)) return null;
  return statSizeOrNull(resolved);
}

function readIndexEntries(indexFile) {
  let raw;
  try { raw = fs.readFileSync(indexFile, 'utf8'); } catch { return []; }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip a malformed line — an honest partial result beats a crash */ }
  }
  return out;
}

function readArtifactStoreDoc(artifactsDir, id) {
  const filePath = path.join(artifactsDir, id + '.json'); // verified live shape: flat "<id>.json" under forge-artifacts/
  if (!containmentOk(artifactsDir, filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

export function buildProof(projectPath, runId) {
  if (!safeIdOk(runId)) return { ok: false, error: 'invalid run id' };
  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const runDir = path.join(runsDir, runId);
  if (!containmentOk(runsDir, runDir)) return { ok: false, error: 'path containment violation' };

  const artifactsStoreDir = path.join(projectPath, '.claude', 'forge-artifacts');
  const indexFile = path.join(artifactsStoreDir, 'index.jsonl');

  const runArtifacts = listRunArtifactFiles(runDir);
  const indexEntries = readIndexEntries(indexFile);
  const matchedStoreArtifacts = [];
  for (const entry of indexEntries) {
    if (!entry || !entry.id) continue;
    const doc = readArtifactStoreDoc(artifactsStoreDir, entry.id);
    if (!doc) continue;
    if (!JSON.stringify(doc).includes(runId)) continue; // only artifacts that actually reference THIS run
    matchedStoreArtifacts.push({
      id: entry.id, store: entry.store || null, ts: entry.ts || null,
      title: doc.title || null, type: doc.type || doc.kind || null, path: doc.path || null,
      summary: doc.summary || null, source: 'forge-artifacts-index',
      size_bytes: statIndexedArtifactSize(projectPath, doc.path),
    });
  }

  const reportPresent = fs.existsSync(path.join(runDir, 'final-report.md'));
  const doctorPath = path.join(runDir, 'doctor.json');
  let doctorSummary = null;
  if (fs.existsSync(doctorPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(doctorPath, 'utf8'));
      doctorSummary = {
        ok: !!doc.ok,
        suites: doc.checks && doc.checks.tests ? doc.checks.tests.suites : null,
        passed: doc.checks && doc.checks.tests ? doc.checks.tests.passed : null,
        failed: doc.checks && doc.checks.tests ? doc.checks.tests.failed : null,
      };
    } catch {
      doctorSummary = { ok: false, note: 'doctor.json present but could not be parsed' };
    }
  }

  const eventsResult = readEvents(projectPath, runId, 0);
  const verdicts = [];
  if (doctorSummary) verdicts.push({ source: 'doctor', ...doctorSummary });
  if (eventsResult.ok) {
    for (const ev of eventsResult.events) {
      if (ev.event_type === 'check_passed' || ev.event_type === 'check_failed') {
        verdicts.push({
          source: 'event', event_type: ev.event_type, agent: ev.agent || null, role: ev.role || null,
          command: ev.command || null, exit_code: ev.exit_code != null ? ev.exit_code : null,
          // cc-fix-adapter T6b/gate-output fix: `output` was already on the raw event (missions.mjs's
          // own verdict builder already reads it) but this route never forwarded it, so a gate's real
          // console output was always dropped in favour of an empty string downstream. Kept alongside
          // `evidence`, not instead of it — the two are genuinely different fields on a real event.
          evidence: ev.evidence || null, output: ev.output || null, timestamp: ev.timestamp || null,
        });
      }
    }
  }

  return {
    ok: true,
    run_id: runId,
    artifacts: [...runArtifacts, ...matchedStoreArtifacts],
    verdicts,
    report_present: reportPresent,
    doctor_present: !!doctorSummary,
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
  const candidateRunIds = runsResult.ok ? runsResult.runs.slice(0, maxRuns).map((r) => r.run_id) : [];

  const runsDir = path.join(projectPath, '.claude', 'forge-runs');
  const runArtifacts = [];
  for (const runId of candidateRunIds) {
    const runDir = path.join(runsDir, runId);
    if (!containmentOk(runsDir, runDir)) continue; // should be impossible — runId came from listRuns()'s own readdir
    for (const artifact of listRunArtifactFiles(runDir)) {
      runArtifacts.push({ ...artifact, run_id: runId });
    }
  }

  const artifactsStoreDir = path.join(projectPath, '.claude', 'forge-artifacts');
  const indexFile = path.join(artifactsStoreDir, 'index.jsonl');
  const indexEntries = readIndexEntries(indexFile);
  const matchedStoreArtifacts = [];
  for (const entry of indexEntries) {
    if (!entry || !entry.id) continue;
    const doc = readArtifactStoreDoc(artifactsStoreDir, entry.id);
    if (!doc) continue;
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
    artifacts: [...runArtifacts, ...matchedStoreArtifacts],
    verdicts: [],
    report_present: false,
    doctor_present: false,
    captured_at: new Date().toISOString(),
    age_ms: 0,
    provenance: 'DERIVED',
  };
}
