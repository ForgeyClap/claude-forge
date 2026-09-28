// Codex run B F-12 (2026-09-28) — the DYNAMIC containment boundary every project route checks a
// resolved project path against. Starts as the real (symlink-resolved) form of SYNC_SCAN_ROOTS;
// projects.mjs additionally admits each REGISTRY-sourced project's own real path (see its own
// header) every time it recomputes the project list, so a project the installer registered OUTSIDE
// the scan roots — the normal case for a beginner's fresh install, per this WP's own brief — is
// usable by every route that resolves a project by name/path, not just listed by GET /api/projects.
//
// WHY A SEPARATE MODULE (not folded into projects.mjs or paths.mjs directly): projects.mjs already
// imports runs.mjs (mostRecentWorkSignalMs, for the default-project heuristic), and runs.mjs is one
// of the consumers that needs this SAME admitted-roots boundary for its own defense-in-depth
// containment check — importing it straight from projects.mjs would create a circular import
// (projects.mjs -> runs.mjs -> projects.mjs). paths.mjs stays "fixed, computed-at-startup constants
// only" (its own stated design). This is a small, dependency-free, mutable-state leaf module that
// both sides can import without a cycle: projects.mjs WRITES to it after every registry recompute,
// every per-project route (runs.mjs, proof.mjs's callers, approvals.mjs, files.mjs, recovery.mjs,
// server.mjs's resolveProjectByName) READS from it instead of the old, fixed SYNC_SCAN_ROOTS.
//
// WHY THE REAL SCAN ROOTS ARE RECOMPUTED FRESH ON EVERY CALL, not cached once: SYNC_SCAN_ROOTS
// (paths.mjs) is a real, mutable exported Array, not a frozen constant, and at least one existing
// test (config.test.mjs's pushScanRoot()/popScanRoot()) deliberately pushes/pops a temp root onto
// the LIVE array to widen containment for the duration of one test — a snapshot taken once at
// import time would silently stop seeing that push, breaking that test in a way that has nothing to
// do with the actual bug it is proving. Realpath-resolving 3-4 entries per call is cheap.
//
// NEVER widens to "anything under a registered project" — only that ONE exact real path is ever
// added, so containmentOk(root, root) (self-equality) is what actually admits it; nothing NEW
// underneath a registered project's own folder is implicitly trusted beyond what containmentOk()
// already allows for any admitted root (itself and its real descendants).
import { SYNC_SCAN_ROOTS, realpathOrNull } from './paths.mjs';

let registryRealRoots = [];

/** projects.mjs calls this after every successful registry recompute — `realPaths` replaces
 *  (never merges with) whatever was admitted before, so a project the installer later DE-registers
 *  stops being an admitted root on the very next recompute, not forever. */
export function setAdmittedRegistryRoots(realPaths) {
  registryRealRoots = Array.isArray(realPaths) ? realPaths.filter((p) => typeof p === 'string' && p.length > 0) : [];
}

/**
 * getContainmentRoots() -> string[]. Every consumer that used to check
 * `anyContainmentOk(SYNC_SCAN_ROOTS, projectPath)` for a per-project route should use
 * `anyContainmentOk(getContainmentRoots(), projectPath)` instead — the real scan roots (recomputed
 * fresh from the LIVE SYNC_SCAN_ROOTS array on every call — see header) PLUS whatever the registry
 * currently, honestly admits. Synchronous by design: by the time any per-route handler reaches its
 * own containment check, server.mjs's resolveProjectByName() has already awaited listProjects()
 * earlier in the SAME request, which is what keeps the registry half of this set fresh — no
 * consumer here needs to await anything itself.
 */
export function getContainmentRoots() {
  const scanRootsReal = SYNC_SCAN_ROOTS.map((r) => realpathOrNull(r)).filter((r) => typeof r === 'string' && r.length > 0);
  return [...scanRootsReal, ...registryRealRoots];
}

export function _resetAdmittedRegistryRootsForTests() { registryRealRoots = []; }
export function _getAdmittedRegistryRootsForTests() { return registryRealRoots.slice(); }
