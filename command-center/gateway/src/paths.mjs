// Fixed, computed-at-startup path constants. Nothing here is ever derived from request input —
// this file exists precisely so no other module has to compute "where is .claude" itself.
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
