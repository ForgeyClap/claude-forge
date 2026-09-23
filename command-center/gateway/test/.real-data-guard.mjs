// Environment preconditions for the suites that assert against THIS project's REAL data.
//
// WHY THIS FILE EXISTS
// --------------------
// A large part of the gateway suite is deliberately written against real data instead of synthetic
// fixtures: the real project fleet, this project's own `.claude/forge-runs/<run>/events.jsonl`, the
// real artifact store, the real built dashboard. That is a feature — a fixture cannot prove that
// buildMission() copes with the messy shape real Forge runs actually have.
//
// It has one cost. Most of that real data is `.gitignore`d (`.claude/forge-runs/*/*` keeps only
// run.json / final-report.md / mission-blueprint.md; `dist/` is build output; the sibling project
// fleet is this machine's Documents folder, which no clone can carry). So somebody who clones the
// repo and runs `npm test` sees a wall of red — measured: 31 failures across 7 suites for the
// gitignore gap alone — and concludes the system is broken when in fact their environment is simply
// empty. That is exactly the "looks broken while it is correct" failure class this project fights.
//
// The fix is NOT to weaken the assertions and NOT to invent fixture data that would make them pass
// while proving nothing. It is to make the precondition explicit: when the real data is present the
// test runs exactly as strictly as before; when it is absent the test is SKIPPED with a reason that
// names the missing path, via node:test's own skip mechanism, so the runner output says out loud
// why it did not run. A skipped test is honest. A silently-green test is not.
//
// WHY THE LEADING DOT IN THE FILENAME
// -----------------------------------
// `node --test` treats every `**/test/**/*.?(c|m)js` file as a test file. A plain helper such as
// `test/real-data-guard.mjs` is therefore picked up and reported as a passing test of its own
// (verified: it prints `✔ test\real-data-guard.mjs` and pushes the suite total from 971 to 972).
// A dot-prefixed file is excluded from that glob while remaining a perfectly normal ESM import, so
// the helper adds no phantom test to the count. Verified both ways before choosing this name.
//
// Every predicate below returns either `false` (precondition met — run the test at full strength)
// or a human-readable reason string (precondition missing — skip and say why), which is exactly the
// shape node:test's `{ skip }` option accepts.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, FORGE_RUNS_DIR, APP_DIST_DIR, SYNC_SCAN_ROOT } from '../src/paths.mjs';

const HINT = 'This data is .gitignore-local, so a fresh clone does not carry it.';

/** True when `p` is a file with at least one byte — an empty file is not evidence. */
function nonEmptyFile(p) {
  try {
    return fs.statSync(p).isFile() && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function fileCount(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ real run event logs ------ */

/** The run's own `events.jsonl` — the source every buildMission()/buildProof() assertion reads. */
export function needsRunEvents(runId) {
  const p = path.join(FORGE_RUNS_DIR, runId, 'events.jsonl');
  return nonEmptyFile(p)
    ? false
    : `no real run events at .claude/forge-runs/${runId}/events.jsonl — this test asserts against that run's actual logged events. ${HINT}`;
}

/** At least one run anywhere in the fleet carries events — for the whole-fleet sweep tests. */
export function needsAnyRunEvents() {
  let runs = [];
  try {
    runs = fs.readdirSync(FORGE_RUNS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return `no .claude/forge-runs directory at all — this test sweeps every real run in the fleet. ${HINT}`;
  }
  const withEvents = runs.filter((d) => nonEmptyFile(path.join(FORGE_RUNS_DIR, d.name, 'events.jsonl')));
  return withEvents.length > 0
    ? false
    : `.claude/forge-runs has ${runs.length} run director${runs.length === 1 ? 'y' : 'ies'} but not one events.jsonl — this test sweeps every real run in the fleet. ${HINT}`;
}

/** At least one of a named set of runs carries events — for tests that sweep a named subset. */
export function needsAnyRunEventsOf(runIds) {
  const present = runIds.filter((id) => nonEmptyFile(path.join(FORGE_RUNS_DIR, id, 'events.jsonl')));
  return present.length > 0
    ? false
    : `none of the ${runIds.length} named runs has an events.jsonl under .claude/forge-runs/ (${runIds.join(', ')}) — this test asserts on those specific real runs. ${HINT}`;
}

/* ---------------------------------------------------------------- real run artifact files ---- */

/** The run's own `artifacts/` directory (source `run-artifacts-dir`). */
export function needsRunArtifacts(runId) {
  const dir = path.join(FORGE_RUNS_DIR, runId, 'artifacts');
  return fileCount(dir) > 0
    ? false
    : `no real artifact files under .claude/forge-runs/${runId}/artifacts/ — this test asserts on that run's actual produced artifacts. ${HINT}`;
}

/** Any run in the fleet with a populated `artifacts/` directory. */
export function needsAnyRunArtifacts() {
  let runs = [];
  try {
    runs = fs.readdirSync(FORGE_RUNS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return `no .claude/forge-runs directory at all — this test needs at least one run that produced real artifacts. ${HINT}`;
  }
  const withArtifacts = runs.filter((d) => fileCount(path.join(FORGE_RUNS_DIR, d.name, 'artifacts')) > 0);
  return withArtifacts.length > 0
    ? false
    : `not one of the ${runs.length} run directories under .claude/forge-runs has a populated artifacts/ dir — this test needs at least one run that produced real artifacts. ${HINT}`;
}

/** The run's `doctor.json` receipt (the doctor-sourced verdict half of buildProof). */
export function needsDoctorReceipt(runId) {
  const p = path.join(FORGE_RUNS_DIR, runId, 'doctor.json');
  return nonEmptyFile(p)
    ? false
    : `no real doctor receipt at .claude/forge-runs/${runId}/doctor.json — this test asserts on that run's actual doctor verdict. ${HINT}`;
}

/** The project-wide artifact store index (source `forge-artifacts-index`). */
export function needsArtifactsIndex() {
  const p = path.join(PROJECT_ROOT, '.claude', 'forge-artifacts', 'index.jsonl');
  return nonEmptyFile(p)
    ? false
    : 'no real artifact store at .claude/forge-artifacts/index.jsonl — this test asserts on specific registered artifact entries.';
}

/** The recovery/doc-drift ledgers that /api/recovery reports. */
export function needsRecoveryLedger() {
  const dir = path.join(PROJECT_ROOT, '.claude', 'forge-research');
  const missing = ['recovery-attempts.jsonl', 'docdrift-state.json'].filter((f) => !nonEmptyFile(path.join(dir, f)));
  return missing.length === 0
    ? false
    : `no real ledger entries at .claude/forge-research/{${missing.join(', ')}} — this test asserts the endpoint reports genuine recorded attempts/findings.`;
}

/* -------------------------------------------------------------------- real project fleet ----- */

// Mirrors findForgeProjects() in .claude/forge-bin/forge-sync.cjs — same marker
// (`<dir>/.claude/forge-dashboard`), same maxDepth 3, same skip rules — so this precondition
// measures precisely what the registry under test will discover, not a rough guess. It stops as
// soon as `min` projects are found, since the assertions are all lower bounds.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'graphify-out']);

function countForgeProjects(root, min, maxDepth = 3) {
  let found = 0;
  function walk(dir, depth) {
    if (found >= min || depth > maxDepth) return;
    if (fs.existsSync(path.join(dir, '.claude', 'forge-dashboard'))) { found += 1; return; }
    if (depth === maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found >= min) return;
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  let top = [];
  try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const e of top) {
    if (found >= min) break;
    if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(root, e.name), 1);
  }
  return found;
}

let fleetCache = null;

/**
 * At least `min` real Forge projects discoverable from the registry's own scan root. Note the
 * assertions guarded by this are lower bounds on a REAL registry read: if the environment does hold
 * `min` projects the test runs at full strength, so a genuine registry bug that returns fewer still
 * fails loudly. Only a genuinely small environment skips.
 */
export function needsProjectFleet(min) {
  if (fleetCache === null || fleetCache.min !== min) {
    fleetCache = { min, count: countForgeProjects(SYNC_SCAN_ROOT, min) };
  }
  return fleetCache.count >= min
    ? false
    : `only ${fleetCache.count} Forge project(s) discoverable under the registry scan root (${SYNC_SCAN_ROOT}), fewer than the ${min} this assertion needs — a clone sits alone in its parent folder instead of inside a populated fleet.`;
}

/* ------------------------------------------------------------------- built dashboard SPA ----- */

/**
 * A real `dashboard/dist` build with at least one hashed asset. serveStatic() returns null before
 * it ever reaches its own path-decoding and header logic when APP_DIST_DIR is absent
 * (src/static.mjs:55), so without a build these tests do not exercise the code they name — measured:
 * a malformed `/%` answers 200 instead of the asserted 400, because the 400 branch is never reached.
 */
export function needsBuiltDashboard() {
  const index = path.join(APP_DIST_DIR, 'index.html');
  if (!nonEmptyFile(index)) {
    return 'the dashboard SPA is not built (no command-center/dashboard/dist/index.html) — serveStatic() short-circuits to null before any of the path/header logic under test runs. Build it with: cd command-center/dashboard && npm install && npm run build';
  }
  if (fileCount(path.join(APP_DIST_DIR, 'assets')) === 0) {
    return 'the dashboard build carries no dist/assets/ files — these assertions need a real hashed asset to request. Rebuild with: cd command-center/dashboard && npm install && npm run build';
  }
  return false;
}

/** First missing precondition among several, or false when all are met. */
export function needsAll(...reasons) {
  return reasons.find((r) => r !== false) ?? false;
}

/* ------------------------------------------------------------- filled-in project identity ---- */

/** The SELECTED project's own `.claude/FORGE_PROJECT_PROFILE.md` filled in past the installer scaffold, plus
 *  `.claude/FORGE_VERSION.json`. GET /api/projects/:name/profile reports both honestly: on a fresh clone the
 *  profile still carries the template placeholder (`<name>`, `<website | landing | …>`) and the version marker is
 *  per-install state the installer writes — so `project_type_raw` is null and `version_present` is false there,
 *  and the "real profile" assertion has nothing real to match. Skip with the reason, never assert the author's
 *  own project type against a stranger's tree (measured 2026-09-23 on the public clone: 1 red test). */
export function needsFilledProjectProfile() {
  const profile = path.join(PROJECT_ROOT, '.claude', 'FORGE_PROJECT_PROFILE.md');
  const version = path.join(PROJECT_ROOT, '.claude', 'FORGE_VERSION.json');
  if (!nonEmptyFile(profile)) return `no .claude/FORGE_PROJECT_PROFILE.md in this project — the real-profile assertion has nothing to read. Run /setup-forge.`;
  let text = '';
  try { text = fs.readFileSync(profile, 'utf8'); } catch { return `could not read ${profile}`; }
  if (/\*\*Project type:\*\*\s*<website\s*\|/.test(text) || /\*\*Project name:\*\*\s*<name>/.test(text)) {
    return 'FORGE_PROJECT_PROFILE.md still carries the installer template placeholders (a fresh clone/install) — /setup-forge fills it in; until then there is no real project type to match';
  }
  if (!nonEmptyFile(version)) return `no .claude/FORGE_VERSION.json — per-install state the installer writes; a bare clone does not carry it, so version_present is honestly false here`;
  return false;
}
