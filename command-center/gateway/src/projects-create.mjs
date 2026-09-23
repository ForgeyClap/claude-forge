// build-newproject: the real "New project" creation route. Makes ONE directory under the
// Forge projects root, containing exactly the marker `findForgeProjects()` (forge-bin/forge-sync.cjs)
// already looks for — `.claude/forge-dashboard/` — plus a short, honest CLAUDE.md. Nothing else is
// scaffolded: the marker is what lets the existing project registry (projects.mjs) discover the new
// project on its own next scan, with no separate registration step.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { FORGE_PROJECTS_ROOT, FORGE_SYNC_CJS } from './paths.mjs';
import { containmentOk } from './security.mjs';
import { redact } from './redact.mjs';

// Strict allowlist per the work package: starts alphanumeric, then up to 63 more letters/digits/
// space/underscore/hyphen. No '.', '/' or '\\' can ever match, so a traversal payload as `name`
// (e.g. "../../evil") is rejected by this check alone, before any path/containment logic runs.
export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

let projectsRootOverride = null;
/** Test-only seam: point creation at an isolated temp dir instead of the real ForgeProjects root. */
export function _setProjectsRootForTests(dir) { projectsRootOverride = dir; }
export function _resetProjectsRootForTests() { projectsRootOverride = null; }

export function activeProjectsRoot() {
  return projectsRootOverride || FORGE_PROJECTS_ROOT;
}

// build-fullinstall: a dashboard-scaffolded project (marker + CLAUDE.md only) is not yet a real
// Forge project — no forge-bin, playbooks or memory. `forge-sync.cjs install <dir>` is the real
// installer; it is spawned as a child process right after the scaffold succeeds, below.
//
// Timing note, verified live against this project's own real GLOBAL_TEMPLATE (not a fixture guess):
// `node forge-sync.cjs install <bareScaffold>` took >60s and TIMED OUT even with `--doctor-timeout
// 60000` (a real forge-doctor run against 334 freshly-synced system files, incl. its own full
// forge-bin/*.test.cjs suite, genuinely needs more than 60s on this machine) — and it rolled back
// cleanly and safely on its own internal timeout path (no orphaned partial writes). forge-sync.cjs
// has NO SIGTERM handler, so an external hard-kill (execFile's own `timeout` option) would NOT get
// that same graceful rollback — it would just terminate the child mid-write. INSTALL_DOCTOR_TIMEOUT_MS
// is therefore always passed as `--doctor-timeout`, comfortably BELOW INSTALL_TIMEOUT_MS, so
// forge-sync's own graceful timeout-and-rollback path is what fires in practice; INSTALL_TIMEOUT_MS
// (execFile's `timeout`) is only a last-resort safety net for a process that hangs beyond that.
//
// build-async-install: the 90s/60s budget above was measured too tight for a real doctor run to
// EVER finish (the same live probe genuinely exceeded 60s) — every real click on "New project" was
// timing out by design, not by accident. Now that the installer runs fully detached (see
// `startDetachedInstall` below — the POST handler never awaits it), there is no client-facing
// request timeout to stay under, so the budget is widened to let the real doctor run actually
// complete: ~8 minutes overall, with `--doctor-timeout` at ~5 minutes (comfortably below the
// overall budget, preserving the same "forge-sync's own graceful rollback path fires first" property
// documented above).
const INSTALL_TIMEOUT_MS = 8 * 60_000;
const INSTALL_DOCTOR_TIMEOUT_MS = 5 * 60_000;

let installRunnerOverride = null;
/** Test-only seam: replace the real child-process call with a stub (same shape `defaultInstallRunner`
 *  resolves: `{ error, stdout, stderr }`) — same pattern as `_setProjectsRootForTests` above. Never
 *  used in production; every test in this repo that exercises `createProject`/`installForgeInto`
 *  without setting this seam gets the real runner, which is harmless there because
 *  `installForgeInto`'s own containment check (below) is against the FIXED FORGE_PROJECTS_ROOT
 *  constant, not the test-overridable `activeProjectsRoot()` — so any test using an isolated temp
 *  root (via `_setProjectsRootForTests`) always refuses before the runner is ever called. */
export function _setInstallRunnerForTests(fn) { installRunnerOverride = fn; }
export function _resetInstallRunnerForTests() { installRunnerOverride = null; }

/** Real runner: `node <FORGE_SYNC_CJS> install <targetDir> --doctor-timeout <n>` — execFile, no
 *  shell, argv built entirely from already-validated/derived values (targetDir passed PROJECT_NAME_RE
 *  + containment in createProject, or the fixed FORGE_SYNC_CJS path from paths.mjs); no request input
 *  ever reaches argv directly. */
function defaultInstallRunner(targetDir) {
  return new Promise((resolve) => {
    // Lead-besluit (na de eerlijke timeout-waarschuwing van build-fullinstall): '--allow-degraded'.
    // Zonder die vlag draait na de sync de VOLLEDIGE forge-doctor (minutenwerk op deze machine),
    // waardoor elke echte klik op New project in een timeout+rollback eindigde - eerlijk gemeld,
    // maar functioneel kapot. Met de vlag gebruikt forge-sync zijn eigen gesanctioneerde
    // degraded-pad: installeren met backup, doctor-validatie mag vervallen. Voor een VERSE lege
    // map is dat de juiste afweging - er bestaat nog niets dat een misgelopen sync zou kunnen
    // beschadigen, en het alternatief was een knop die altijd faalt.
    const args = [FORGE_SYNC_CJS, 'install', targetDir, '--doctor-timeout', String(INSTALL_DOCTOR_TIMEOUT_MS), '--allow-degraded'];
    execFile(
      process.execPath,
      args,
      { timeout: INSTALL_TIMEOUT_MS, cwd: targetDir, shell: false },
      (error, stdout, stderr) => resolve({ error, stdout: stdout == null ? '' : String(stdout), stderr: stderr == null ? '' : String(stderr) }),
    );
  });
}

function combinedOutput(stdout, stderr) {
  return [stdout, stderr].map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean).join('\n');
}

/**
 * Runs the real Forge installer against `targetDir`, honestly. Never throws — every outcome is a
 * typed `{ installed, attempted, timedOut, reason }`. Refuses (without ever spawning anything) when
 * `targetDir` is not inside the REAL FORGE_PROJECTS_ROOT — deliberately the fixed constant, NEVER
 * `activeProjectsRoot()`'s test-only override: this is what keeps every OTHER test in this repo that
 * calls `_setProjectsRootForTests` to redirect `createProject`'s scaffold at an isolated temp dir
 * automatically safe (no real install spawn) even though those tests never call
 * `_setInstallRunnerForTests` — confirmed the hard way (a first draft of this check used
 * `activeProjectsRoot()` instead, and it silently let ../test/routes-project-create.test.mjs's own
 * isolated-temp-dir tests spawn TWO real ~60s `forge-sync.cjs install` child processes). A failed or
 * timed-out install is reported as `installed:false` with a real, redacted reason (the child's own
 * stdout/stderr can legitimately contain a stray secret echoed by a spawned tool — see redact.mjs's
 * own header) — it is NEVER upgraded to a fake success.
 */
export async function installForgeInto(targetDir) {
  if (!containmentOk(FORGE_PROJECTS_ROOT, targetDir)) {
    return {
      installed: false, attempted: false, timedOut: false,
      reason: 'refusing to run the Forge installer: the target resolves outside the real Forge projects root',
    };
  }
  const runner = installRunnerOverride || defaultInstallRunner;
  let result;
  try {
    result = await runner(targetDir);
  } catch (err) {
    return { installed: false, attempted: true, timedOut: false, reason: 'the Forge installer could not be started: ' + redact(errorMessage(err)) };
  }
  const { error, stdout, stderr } = result || {};
  if (!error) return { installed: true, attempted: true, timedOut: false, reason: null };
  // Empirically confirmed shape (real execFile probe, this machine): a timeout-killed child has
  // error.killed===true, error.signal==='SIGTERM', error.code===null; a normal non-zero exit has
  // error.killed===false, error.signal===null, error.code===<exit code>.
  const timedOut = !!(error.killed || error.signal);
  const output = redact(combinedOutput(stdout, stderr));
  const reason = timedOut
    ? 'the Forge installer timed out after ' + INSTALL_TIMEOUT_MS + 'ms' + (output ? ': ' + output : '')
    : 'the Forge installer failed' + (typeof error.code === 'number' ? ' (exit code ' + error.code + ')' : '') + (output ? ': ' + output : '');
  return { installed: false, attempted: true, timedOut, reason };
}

export function validateProjectName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'name must be a non-empty string';
  if (!PROJECT_NAME_RE.test(name)) {
    return 'name must match ^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$ (start alphanumeric; letters, digits, spaces, "_" or "-" after that; max 64 characters)';
  }
  return null;
}

/**
 * Reuses `validateProjectName`'s allowlist plus the same belt-and-suspenders containment check
 * `createProject` runs against `activeProjectsRoot()` (test-overridable, unlike `installForgeInto`'s
 * own FIXED-root check) — so `GET /api/projects/install-status?name=<n>` is guarded exactly like the
 * POST route, including under `_setProjectsRootForTests` in tests.
 */
export function projectNameContainmentOk(name) {
  const root = activeProjectsRoot();
  const target = path.join(root, name);
  return containmentOk(root, target);
}

// build-async-install: keyed by project NAME (the identity both the POST route and the GET
// install-status route share) rather than path — a project's directory path is derived
// deterministically from its name + the active root, so name is sufficient and avoids leaking a
// filesystem path into the status map's own key space. Entries are never pruned: a finished
// project's status stays queryable for the lifetime of this gateway process, and the map is
// honestly empty again after a restart (see the GET route's `state:'unknown'` + `note`).
const installStatusByName = new Map();
// Tracks the in-flight settle-chain per name so a test can deterministically await it
// (`_awaitInstallForTests`) instead of a real multi-minute wait or a fake-timer harness — same
// shape as `projects.mjs`'s own `refreshInFlight` seam for its background cache refresh.
const installInFlightByName = new Map();

/** Test-only: current install-status entry, or `null` if nothing was ever recorded for `name`. */
export function getInstallStatus(name) {
  return installStatusByName.get(name) || null;
}

/** Test-only: clears the whole in-memory install-status map (mirrors `projects.mjs`'s own
 *  `_resetProjectsCacheForTests`) so tests never leak state across files sharing this module. */
export function _resetInstallStatusForTests() {
  installStatusByName.clear();
  installInFlightByName.clear();
}

/** Test-only: resolves once `name`'s currently-tracked detached install settles, or immediately
 *  if nothing is in flight for it — lets a test deterministically wait for the background chain
 *  `startDetachedInstall` kicks off below, without a real 8-minute wait. */
export function _awaitInstallForTests(name) {
  return installInFlightByName.get(name) || Promise.resolve();
}

/**
 * Kicks off the real Forge installer for `target` WITHOUT ever letting the caller (the POST
 * /api/projects handler) wait for it — a real doctor run can take several minutes (see
 * `installForgeInto`'s own header), and synchronously awaiting it inside the request handler was
 * exactly the structural failure this change fixes (every real click used to time out). Records
 * the real, honest outcome in `installStatusByName`, keyed by project name, so
 * `GET /api/projects/install-status?name=<n>` can report it once it's known. Never throws and
 * never leaves an unhandled rejection: `installForgeInto` itself never throws (see its own header),
 * and the trailing `.catch` here also guards against a bug inside this function's own `.then`
 * callback — either way the map always ends up with a real terminal `failed` status rather than
 * silently never settling.
 */
export function startDetachedInstall(name, target) {
  const startedAt = new Date().toISOString();
  installStatusByName.set(name, { state: 'installing', reason: null, started_at: startedAt, finished_at: null });

  const settle = installForgeInto(target)
    .then((install) => {
      installStatusByName.set(name, {
        state: install.installed ? 'installed' : 'failed',
        reason: install.installed ? null : install.reason,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      });
    })
    .catch((err) => {
      installStatusByName.set(name, {
        state: 'failed',
        reason: 'the Forge installer crashed unexpectedly: ' + redact(errorMessage(err)),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      });
    })
    .finally(() => {
      if (installInFlightByName.get(name) === settle) installInFlightByName.delete(name);
    });
  installInFlightByName.set(name, settle);
}

function claudeMdContent(name, createdAtIso) {
  return [
    `# ${name}`,
    '',
    `Created by the Forge Command Center dashboard's "New project" button on ${createdAtIso}.`,
    '',
  ].join('\n');
}

/**
 * Creates a real project directory. Never throws — every failure is a typed
 * `{ ok:false, status, body }` result; success is `{ ok:true, status:201, body }`.
 *
 * build-async-install: after a successful scaffold, this starts the real Forge installer
 * (`startDetachedInstall`, above) but never awaits it — the 201 response returns as soon as the
 * scaffold itself is done, exactly like before build-fullinstall's synchronous version was added.
 * The installer's real, honest outcome is recorded in the in-memory install-status map instead and
 * exposed via `GET /api/projects/install-status?name=<n>`, which the dashboard polls rather than
 * the gateway blocking (or fabricating) an outcome inline.
 */
export async function createProject({ name }) {
  const nameError = validateProjectName(name);
  if (nameError) return { ok: false, status: 400, body: { ok: false, error: nameError } };

  const root = activeProjectsRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: 'could not create the projects root: ' + errorMessage(err) },
    };
  }

  const target = path.join(root, name);
  // Belt-and-suspenders: PROJECT_NAME_RE already makes traversal structurally impossible, but this
  // mirrors the containment check every other gateway module runs before touching the filesystem.
  if (!containmentOk(root, target)) {
    return { ok: false, status: 400, body: { ok: false, error: 'name resolves outside the projects root' } };
  }
  if (fs.existsSync(target)) {
    return { ok: false, status: 409, body: { ok: false, error: `a project named "${name}" already exists` } };
  }

  try {
    fs.mkdirSync(target);
  } catch (err) {
    const code = err && err.code;
    if (code === 'EEXIST') {
      return { ok: false, status: 409, body: { ok: false, error: `a project named "${name}" already exists` } };
    }
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: 'the project directory could not be created: ' + errorMessage(err) },
    };
  }

  try {
    fs.mkdirSync(path.join(target, '.claude', 'forge-dashboard'), { recursive: true });
    const createdAtIso = new Date().toISOString();
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), claudeMdContent(name, createdAtIso), 'utf8');
  } catch (err) {
    // The directory exists but the scaffold is incomplete — reported honestly rather than as a
    // clean 201. The caller can inspect `target` (left on disk; this route never rolls back).
    return {
      ok: false,
      status: 500,
      body: {
        ok: false,
        error: 'the project directory was created but its scaffold could not be finished: ' + errorMessage(err),
        path: target,
      },
    };
  }

  startDetachedInstall(name, target);
  return {
    ok: true,
    status: 201,
    body: {
      ok: true,
      project: { name, path: target },
    },
  };
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}
