// Fixed, computed-at-startup path constants. Nothing here is ever derived from request input —
// this file exists precisely so no other module has to compute "where is .claude" itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// gateway/src -> gateway -> command-center -> project root ("my project (v2)!")
export const GATEWAY_DIR = path.resolve(__dirname, '..');
export const COMMAND_CENTER_DIR = path.resolve(GATEWAY_DIR, '..');
export const PROJECT_ROOT = path.resolve(COMMAND_CENTER_DIR, '..');
export const CLAUDE_DIR = path.join(PROJECT_ROOT, '.claude');
export const FORGE_RUNS_DIR = path.join(CLAUDE_DIR, 'forge-runs');
export const FORGE_SYNC_CJS = path.join(CLAUDE_DIR, 'forge-bin', 'forge-sync.cjs');
// WP7a: repointed from the retired hand-built app/dist to the imported owner dashboard's own
// build output. dashboard/ is the byte-identical import of the owner's preserved prototype
// (see mission/discovery/T7-integration-plan.md); its dist/ is rebuilt fresh via `npm run build`
// inside command-center/dashboard, never carried over stale from the source.
export const APP_DIST_DIR = path.join(COMMAND_CENTER_DIR, 'dashboard', 'dist');

// Fixed scan root for the project registry (forge-sync.cjs list <root>): the PARENT of this
// project's own root, i.e. the Documents folder this whole "Forge fleet" lives under. Computed,
// never taken from a request — satisfies "no user input in args ever" for the spawned CLI.
export const SYNC_SCAN_ROOT = path.dirname(PROJECT_ROOT);

// C1 fix (WP-C1, 2026-09-26 laptop re-audit): SYNC_SCAN_ROOT alone only ever finds a project that
// happens to be a SIBLING of wherever this repo was cloned — on a fresh machine where the clone
// lives somewhere else than the user's real projects (e.g. a scratch folder, while a real project
// sits on the Desktop), that missed it entirely (audit finding C1: "the dashboard only finds
// projects next to the repo clone ... never the Desktop project"). SYNC_SCAN_ROOTS scans every
// well-known Forge project location plus one optional operator-set extra root, deduplicated by
// resolved path so the same folder is never scanned twice:
//   1. SYNC_SCAN_ROOT     - kept for backward compatibility (a "Forge fleet" checked out together
//                           under one folder still works exactly as before).
//   2. <home>/Documents   - Forge's own established default project root (matches
//                           forge-registry.cjs's own defaultRoot(), and most /forge docs).
//   3. <home>/Desktop     - the other common beginner location — exactly what C1 found missing.
//   4. process.env.CC_PROJECTS_EXTRA_ROOT, when set — one operator-configurable extra root for a
//      non-default location. Read once at startup from the environment, never from request input.
// A root that does not exist on this machine is never an error: forge-sync.cjs's own
// findForgeProjects() already treats a missing/unreadable root as "0 projects found" (see
// projects.mjs's computeProjectsAsync(), which scans every root here in parallel and merges the
// results). Every real project entry is still re-validated against SYNC_SCAN_ROOTS via
// anyContainmentOk() (security.mjs) before its path is ever used — but that check is only ever as
// tight as this list of roots IS: adding a root to SYNC_SCAN_ROOTS genuinely widens what
// anyContainmentOk() accepts (A3 fix, WP-C2, 2026-09-26 laptop re-audit — an earlier version of
// this comment claimed the opposite, which was false: containment is "resolves under ANY of these
// roots", so one more root is one more thing containment says yes to). Because of that,
// CC_PROJECTS_EXTRA_ROOT is validated before it is ever added to the list, not merely resolved:
// only an absolute, LOCAL path (never a UNC/network share like `\\host\share\...`) to a directory
// that genuinely exists, is not a drive root (`C:\`, `/`), and is not the home folder itself, is
// accepted — a value that fails any of those checks is ignored outright (one clear log line,
// never a silent partial-accept) so this env var can only ever point at "one more ordinary
// project folder", never at the whole home directory or a network path.
const EXTRA_SCAN_ROOT_ENV_NAME = 'CC_PROJECTS_EXTRA_ROOT';

function logRejectedExtraRoot(reason) {
  console.error('[paths] ' + EXTRA_SCAN_ROOT_ENV_NAME + ' ignored: ' + reason);
}

// N5 fix (2026-09-26 laptop re-audit verification, WP-C3): comparing the LITERAL resolved path to
// home let three things through: a differently-cased path on win32 (`c:\users\YOU` next to the
// real `C:\Users\YOU`), a folder ABOVE home (`C:\Users` genuinely CONTAINS the home folder, so
// scanning it scans home too), and a junction/symlink whose literal path looks like an ordinary
// folder but actually resolves to home (or to one of home's ancestors) — none of those were ever
// followed to their real target before the comparison. `normalizeForCompare` makes the comparison
// case-insensitive on win32 only (NTFS/ReFS are case-preserving but not case-sensitive by default;
// other platforms keep exact-case comparison).
function normalizeForCompare(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

// Resolves symlinks/junctions to their real, on-disk target. Returns null (never throws) when the
// path cannot be resolved (e.g. a broken/circular link) — treated the same as "does not exist",
// which is the safe default for a security-relevant check like this one.
function realpathOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

// Returns a validated, resolved absolute path, or null (logging exactly why) when the raw env
// value fails any check. Never throws — an operator's typo in an env var must never crash the
// gateway at import time.
export function validateExtraScanRoot(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  // A UNC/network path (`\\host\share\...` or `//host/share/...`) is a fundamentally different
  // trust boundary than "another local folder on this machine" — rejected before path.resolve()
  // even normalizes it, so it can never sneak through as if it were a plain absolute path.
  if (/^[\\/]{2}/.test(trimmed)) {
    logRejectedExtraRoot('"' + trimmed + '" looks like a network/UNC path, not a local directory.');
    return null;
  }
  if (!path.isAbsolute(trimmed)) {
    logRejectedExtraRoot('"' + trimmed + '" is not an absolute path.');
    return null;
  }
  const resolved = path.resolve(trimmed);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    logRejectedExtraRoot('"' + resolved + '" does not exist.');
    return null;
  }
  if (!stat.isDirectory()) {
    logRejectedExtraRoot('"' + resolved + '" is not a directory.');
    return null;
  }
  if (path.parse(resolved).root === resolved) {
    logRejectedExtraRoot('"' + resolved + '" is a drive root — too wide to scan.');
    return null;
  }
  // Follow symlinks/junctions to the REAL target before the home check — a link whose literal path
  // reads like an ordinary folder but actually points at (or above) home must be caught here, not
  // let through because the un-resolved path looked fine.
  const real = realpathOrNull(resolved);
  if (real === null) {
    logRejectedExtraRoot('"' + resolved + '" could not be resolved to its real, on-disk location.');
    return null;
  }
  const realHome = realpathOrNull(path.resolve(os.homedir())) ?? path.resolve(os.homedir());
  const normReal = normalizeForCompare(real);
  const normHome = normalizeForCompare(realHome);
  if (normReal === normHome) {
    logRejectedExtraRoot('"' + resolved + '" is the home folder itself — too wide to scan.');
    return null;
  }
  // normHome starting with normReal + a path separator means `real` is an ANCESTOR of home (e.g.
  // `C:\Users` above `C:\Users\YOU`, or a drive-level folder above that) — home is CONTAINED IN
  // the candidate, so scanning the candidate scans home too. Rejected for the same reason as home
  // itself: too wide to scan.
  if (normHome.startsWith(normReal + path.sep)) {
    logRejectedExtraRoot('"' + resolved + '" contains the home folder — too wide to scan.');
    return null;
  }
  return resolved;
}

const EXTRA_SCAN_ROOT = validateExtraScanRoot(process.env[EXTRA_SCAN_ROOT_ENV_NAME]);
export const SYNC_SCAN_ROOTS = Array.from(new Set(
  [SYNC_SCAN_ROOT, path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Desktop'), EXTRA_SCAN_ROOT]
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => path.resolve(p)),
));

// WP3 additions. These three are genuinely GLOBAL to *this gateway's own* install (not scoped by
// a `?project=` query) — matching the literal T3.6/T3.9 endpoint shapes, which carry no project
// param: the model-capability matrix + NVIDIA provider CLI live under THIS project's own
// .claude/, and the usage-pressure file is account-wide under the OS home dir, never per-project.
// Endpoints that DO take `?project=` (missions/agents/skills/proof) instead compute their own
// per-project `.claude/...` paths from the resolved registry entry's path at call time — see
// agents.mjs/skills.mjs/proof.mjs/missions.mjs — so they reflect the SELECTED fleet project, not
// always this one.
export const MODEL_CAPABILITY_MATRIX_FILE = path.join(CLAUDE_DIR, 'config', 'models', 'model-capability-matrix.json');
export const NVIDIA_PROVIDER_CJS = path.join(CLAUDE_DIR, 'forge-bin', 'nvidia-provider.cjs');
export const FORGE_USAGE_PRESSURE_FILE = path.join(os.homedir(), '.claude', 'FORGE_USAGE_PRESSURE.json');
// WP7c addition: the usage-guard's OWN pause/resume state — a different file than the pressure
// file above (owner's `forge-bin/usage-guard.cjs` writes both; this one carries whether agents
// are actually PAUSED right now, which the pressure file does not). Same account-wide, no
// `?project=` shape.
export const FORGE_USAGE_GUARD_STATE_FILE = path.join(os.homedir(), '.claude', 'FORGE_USAGE_GUARD_STATE.json');

// WP4 addition: the conversation store lives ONLY under command-center/.data/ (D2 "write boundary"
// hard rule — the gateway never writes into .claude/). `.data/` is already `.gitignore`d.
export const COMMAND_CENTER_DATA_DIR = path.join(COMMAND_CENTER_DIR, '.data');
export const CONVERSATIONS_DIR = path.join(COMMAND_CENTER_DATA_DIR, 'conversations');

// build-lastdemos addition: one directory per conversation, holding every file the composer's
// real "Attach" control has uploaded for it (attachments.mjs is the sole writer). Same write
// boundary as CONVERSATIONS_DIR above — under command-center/.data/, never under .claude/.
export const ATTACHMENTS_DIR = path.join(COMMAND_CENTER_DATA_DIR, 'attachments');

// build-newproject: root for projects created via POST /api/projects (the dashboard's real "New
// project" button). A sibling of every other Forge project directly under SYNC_SCAN_ROOT (this
// machine's Documents folder), so forge-sync.cjs's own bounded-depth scan (default maxDepth 3,
// see findForgeProjects() in forge-bin/forge-sync.cjs) discovers a freshly created project on its
// own next cache-refresh — no separate registration step is needed.
export const FORGE_PROJECTS_ROOT = path.join(SYNC_SCAN_ROOT, 'ForgeProjects');

// WP-D1 (feat-discord-gateway): the imported Discord<->Forge remote-control bot (source-only —
// see command-center/discord/README.md for its own history) — supervised by THIS gateway as its
// single spawn-root (discord-service.mjs), never via its own now-redundant src/bot-manager.js.
export const DISCORD_DIR = path.join(COMMAND_CENTER_DIR, 'discord');
export const DISCORD_MAIN_JS = path.join(DISCORD_DIR, 'src', 'main.js');
export const DISCORD_ENV_FILE = path.join(DISCORD_DIR, '.env');
export const DISCORD_ENV_EXAMPLE_FILE = path.join(DISCORD_DIR, '.env.example');
// Fresh, gateway-owned runtime state — deliberately NOT the imported folder's own `./state`
// (D2/write-boundary precedent: real writes stay under command-center/.data/, never inside a
// sibling project's own directory tree).
export const DISCORD_DATA_DIR = path.join(COMMAND_CENTER_DATA_DIR, 'discord');
export const DISCORD_STATE_DIR = path.join(DISCORD_DATA_DIR, 'state');
export const DISCORD_LOG_FILE = path.join(DISCORD_DATA_DIR, 'discord-bot.log');
