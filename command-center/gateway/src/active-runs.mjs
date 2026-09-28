// WP-CC1 (item 3): GET /api/active-runs — every project this gateway has discovered, but only the
// runs that are REALLY live right now (runs.mjs's own status:'live' — open dispatches and/or real
// work within the heartbeat window; see runs.mjs's deriveStatus()), each with its real working
// agents (agent-dispatches.mjs's run-log source, item 5, filtered to running:true). A project with
// no live run contributes nothing — this is deliberately NOT "every run of every project" (that is
// what /api/runs?project=<name> is already for); it is the one endpoint that answers "what is
// actually happening across my whole fleet right now" without polling every project individually.
import { listProjects } from './projects.mjs';
import { listRuns } from './runs.mjs';
import { listRunLogDispatches } from './agent-dispatches.mjs';

// Bounded so one fleet with an unusually large project count can never make this endpoint scan an
// unbounded number of projects on every poll — mirrors this file's siblings' own bound-first rule
// (agent-dispatches.mjs's MAX_CONVERSATIONS_SCANNED, proof.mjs's DEFAULT_MAX_RUNS_FOR_ALL).
const MAX_PROJECTS_SCANNED = 200;

// Codex run B F-05: runs.mjs's own listRuns() already bounds EACH project's own scan (at most
// MAX_RUNS_SCANNED_PER_PROJECT run directories fully read, each events.jsonl tail-bounded past a
// byte ceiling — see runs.mjs's own header) — this is the AGGREGATE budget across the WHOLE
// fleet-wide sweep this endpoint does: up to MAX_PROJECTS_SCANNED projects, each potentially
// contributing hundreds of runs, could otherwise still add up to a large total. Once this many runs
// have been examined across every project combined in ONE call, the scan stops early;
// `truncated:true` says so honestly rather than silently returning a partial fleet view.
const MAX_TOTAL_RUNS_SCANNED = 5_000;
// Test-only override seam — same `_set*ForTests` convention this codebase uses throughout.
// Production code never calls this; asserting the REAL 5000-run budget would mean fabricating
// thousands of real run directories across many projects, which is possible but needlessly slow.
let maxTotalRunsScannedOverride = null;
export function _setMaxTotalRunsScannedForTests(n) { maxTotalRunsScannedOverride = n; }
export function _resetMaxTotalRunsScannedForTests() { maxTotalRunsScannedOverride = null; }
function activeMaxTotalRunsScanned() { return maxTotalRunsScannedOverride || MAX_TOTAL_RUNS_SCANNED; }

// Real per-project work (listRuns()'s own events.jsonl scan, cached there) is cheap once warm but
// still real disk I/O across every discovered project — cached here too, same TTL family as
// projects.mjs's own 5s CACHE_TTL_MS, so a dashboard polling this every few seconds never pays the
// full fleet-wide scan on every single request.
const CACHE_TTL_MS = 5_000;
let cache = null; // { data, expiresAt }

function computeWorkingAgents(dispatchesForRun) {
  const seen = new Map(); // agent_slug -> row (first one wins; de-duplicated by slug, not by dispatch)
  for (const d of dispatchesForRun) {
    if (!d.running) continue;
    const key = d.agent_slug || d.agent || 'unknown';
    if (!seen.has(key)) {
      seen.set(key, { agent: d.agent, agent_slug: d.agent_slug, wp_id: d.wp_id, task: d.task, started_at: d.started_at });
    }
  }
  return Array.from(seen.values());
}

function computeActiveRuns() {
  return listProjects().then((projectsResult) => {
    if (!projectsResult.ok) {
      return { ok: false, error: projectsResult.error || 'failed to list projects', active_runs: [] };
    }
    const activeRuns = [];
    // Codex run B F-05: honestly true whenever EITHER the project-count cap or the cumulative
    // run-count budget cut this sweep short — never a silent partial result with no signal at all.
    const maxTotalRunsScanned = activeMaxTotalRunsScanned();
    let truncated = projectsResult.projects.length > MAX_PROJECTS_SCANNED;
    let totalRunsScanned = 0;
    for (const project of projectsResult.projects.slice(0, MAX_PROJECTS_SCANNED)) {
      if (totalRunsScanned >= maxTotalRunsScanned) { truncated = true; break; }
      const runsResult = listRuns(project.path);
      if (!runsResult.ok) continue; // one unreadable project must never abort the whole fleet scan
      totalRunsScanned += runsResult.runs.length;
      if (runsResult.runs_truncated) truncated = true; // that ONE project already had more runs than IT could fully scan
      const liveRows = runsResult.runs.filter((r) => r.status === 'live');
      if (liveRows.length > 0) {
        // One run-log scan per project (bounded internally to its own current_run + live rows —
        // see agent-dispatches.mjs's own candidateLiveRunIds()), reused for every live row below
        // rather than re-scanned per row.
        const dispatches = listRunLogDispatches(project.path);
        for (const row of liveRows) {
          const dispatchesForRun = dispatches.filter((d) => d.run_id === row.run_id);
          activeRuns.push({
            project: project.name,
            run_id: row.run_id,
            title: row.title,
            started_at: row.started_at,
            last_work_at: row.last_work_at,
            open_dispatches: row.open_dispatch_count,
            working_agents: computeWorkingAgents(dispatchesForRun),
          });
        }
      }
      // Checked AFTER (not just before) processing this project too: a single project whose own run
      // count already meets/exceeds the budget must still be reported truncated:true even when it is
      // the last (or only) project in the fleet — the pre-loop-only check above would otherwise never
      // fire again once the projects array is exhausted, silently under-reporting truncation.
      if (totalRunsScanned >= maxTotalRunsScanned) { truncated = true; break; }
    }
    return { ok: true, active_runs: activeRuns, truncated };
  });
}

// Returns { ok, active_runs, captured_at, age_ms, provenance } — always this shape, never throws
// (a per-project failure is skipped, not fatal; only a total listProjects() failure is reported as
// ok:false, mirroring projects.mjs's own "only fail when EVERY source failed" convention).
export async function buildActiveRuns(now = Date.now()) {
  if (cache && cache.expiresAt > now) {
    return { ...cache.data, age_ms: now - cache.capturedAtMs, provenance: 'DERIVED' };
  }
  const result = await computeActiveRuns();
  const capturedAtMs = Date.now();
  const data = {
    ok: result.ok,
    error: result.error,
    active_runs: result.active_runs,
    // Codex run B F-05: true when the project-count cap or the cumulative run-count budget cut
    // this sweep short — an honest signal, never a silently smaller fleet view.
    truncated: result.truncated || false,
    captured_at: new Date(capturedAtMs).toISOString(),
  };
  cache = { data, capturedAtMs, expiresAt: capturedAtMs + CACHE_TTL_MS };
  return { ...data, age_ms: 0, provenance: 'DERIVED' };
}

export function _resetActiveRunsCacheForTests() { cache = null; }
export const _ACTIVE_RUNS_CACHE_TTL_MS_FOR_TESTS = CACHE_TTL_MS;
