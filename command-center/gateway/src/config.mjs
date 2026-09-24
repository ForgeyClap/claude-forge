// GET /api/config source (forge-2026-09-24-config-v250 wp12): runs `forge-config.cjs list --json --all
// --lang en` for the SELECTED project and maps its JSON answer 1:1. READ-ONLY by construction: `list` is
// the tool's read command (its own library `list()` never writes), the argv is fixed and never built from
// request input beyond the already-allowlisted project path (resolved upstream via the trusted project
// registry, exactly like capabilities.mjs), and this module has no write path at all — the D2 write
// boundary (paths.mjs: the gateway never writes into .claude/) holds. A setting is changed in chat or with
// `/forge config set`, never through here.
//
// SETTINGS, NEVER CODE (wp20 L9, 2026-09-24): this used to execute the selected project's OWN
// .claude/forge-bin/forge-config.cjs every 30 s — i.e. run code from any repo under Documents just because
// it was selected in the dashboard. It now always runs the CENTRAL copy (this gateway's own project,
// PROJECT_ROOT in paths.mjs) with FORGE_PROJECT_ROOT=<selected project>, so only the selected project's
// .claude/FORGE_CONFIG.json (plain JSON) is read. A project with a .claude/ folder but no settings file is a
// valid all-defaults answer; a project without a .claude/ folder at all stays a truthful UNAVAILABLE.
//
// The child runs with cwd = this gateway's own project root and the CREDENTIAL-FREE exec-bridge env
// allowlist (filteredEnv({ credentialFree: true }) — no CLAUDE_CODE_OAUTH_TOKEN or other *_TOKEN/*_SECRET/
// *_KEY name). FORGE_PROJECT_ROOT is set explicitly to the selected project; a stray gateway
// FORGE_PROJECT_ROOT / FORGE_CONFIG_HOME is never forwarded, so it can never point the tool elsewhere.
//
// Cheap (~0.1 s), but the dashboard polls every 15 s, so results are cached 30 s per project with
// the same stale-while-revalidate shape as capabilities.mjs: a fresh hit is DERIVED, an expired
// entry returns the last known-good value at once while ONE background refresh runs (STALE), and a
// call that arrives mid-refresh reuses it (CACHED). A missing script, timeout, bad exit or unparsable
// output NEVER fakes settings — it reports a truthful available:false + state:'UNAVAILABLE' with the
// real, redacted reason.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redact, redactDeep } from './redact.mjs';
import { filteredEnv } from './exec-cli.mjs';
import { PROJECT_ROOT } from './paths.mjs';

// The one forge-config.cjs this gateway ever executes (wp20 L9) — its own, never the selected project's.
const CENTRAL_FORGE_CONFIG_CJS = path.join(PROJECT_ROOT, '.claude', 'forge-bin', 'forge-config.cjs');

const execFileAsync = promisify(execFile);
const FORGE_CONFIG_TIMEOUT_MS = 5000;
const FORGE_CONFIG_CACHE_TTL_MS = 30_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
// Same bounded-cache rule as capabilities.mjs (WP10 F4/F5): FIFO eviction past a hard cap, never
// evicting on an update of an entry that already exists.
const MAX_CACHE_ENTRIES = 100;
const LIST_ARGS = ['list', '--json', '--all', '--lang', 'en'];

const cacheByProject = new Map(); // projectPath -> { data, expiresAt }
const refreshInFlightByProject = new Map(); // projectPath -> Promise<void>

// Test-only override seam (mirrors models.mjs's _setNvidiaProviderCjsForTests): replaces the CENTRAL
// script with a fixture so a failure/credential-in-stderr path can be proven without touching the real
// forge-config.cjs. Production code never calls the setter.
let forgeConfigCjsOverride = null;
export function _setForgeConfigCjsForTests(p) { forgeConfigCjsOverride = p; }

function evictIfNeeded(key) {
  if (cacheByProject.has(key)) return;
  while (cacheByProject.size >= MAX_CACHE_ENTRIES) {
    cacheByProject.delete(cacheByProject.keys().next().value);
  }
}

function unavailable(note) {
  return {
    available: false, state: 'UNAVAILABLE', note: redact(note),
    settings: [], locked: [], groups: [], files: null, notes: [], hidden: null, lang: null, project: null,
  };
}

const arrayOf = (v) => (Array.isArray(v) ? redactDeep(v) : []);
const stringOrNull = (v) => (typeof v === 'string' ? redact(v) : null);

// Maps the tool's own top-level keys 1:1 (settings, hidden, locked, files, notes, lang, groups,
// project — observed live on 2026-09-24); a missing key becomes an empty list / null, never a
// plausible default. Success-path stdout is redacted too (capabilities.mjs sec-delta F2).
function mapListJson(parsed) {
  return {
    available: true,
    state: 'OK',
    settings: arrayOf(parsed.settings),
    locked: arrayOf(parsed.locked),
    groups: arrayOf(parsed.groups),
    files: parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files) ? redactDeep(parsed.files) : null,
    notes: arrayOf(parsed.notes),
    hidden: typeof parsed.hidden === 'number' ? parsed.hidden : null,
    lang: stringOrNull(parsed.lang),
    project: stringOrNull(parsed.project),
  };
}

// With --json the CLI prints `{ ok:false, error:{ message } }` on stdout before a non-zero exit (e.g. a
// damaged FORGE_CONFIG.json) — that plain-language message is the honest reason; else err.message.
function failureReason(err) {
  try {
    const body = JSON.parse(String(err && err.stdout ? err.stdout : ''));
    if (body && body.error && typeof body.error.message === 'string') return body.error.message;
  } catch { /* not JSON — fall through to the process error below */ }
  return err && err.message ? err.message : String(err);
}

function hasClaudeDir(projectPath) {
  try { return fs.statSync(path.join(projectPath, '.claude')).isDirectory(); } catch { return false; }
}

async function probeForgeConfigLive(projectPath) {
  if (!hasClaudeDir(projectPath)) return unavailable('this project has no .claude/ folder — there are no Forge settings to read');
  const scriptPath = forgeConfigCjsOverride || CENTRAL_FORGE_CONFIG_CJS;
  if (!fs.existsSync(scriptPath)) return unavailable('the central forge-config.cjs was not found');
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...LIST_ARGS], {
      cwd: PROJECT_ROOT, env: { ...filteredEnv({ credentialFree: true }), FORGE_PROJECT_ROOT: projectPath },
      timeout: FORGE_CONFIG_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES,
    });
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { return unavailable('forge-config.cjs list returned output that is not JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return unavailable('forge-config.cjs list returned an unexpected JSON shape');
    }
    if (parsed.ok === false) return unavailable('forge-config.cjs list failed: ' + failureReason({ stdout }));
    return mapListJson(parsed);
  } catch (err) {
    if (err && err.killed) return unavailable('forge-config.cjs list timed out after ' + FORGE_CONFIG_TIMEOUT_MS + 'ms');
    // err.message embeds the child's stderr on a non-zero exit — redact() runs inside unavailable().
    return unavailable('forge-config.cjs list failed: ' + failureReason(err));
  }
}

function storeProbe(projectPath, probe) {
  const capturedAtMs = Date.now();
  const data = { ok: true, ...probe, captured_at: new Date(capturedAtMs).toISOString(), _capturedAtMs: capturedAtMs };
  evictIfNeeded(projectPath);
  cacheByProject.set(projectPath, { data, expiresAt: capturedAtMs + FORGE_CONFIG_CACHE_TTL_MS });
  return data;
}

// Returns { ok, available, state, note?, settings, locked, groups, files, notes, hidden, lang, project,
// captured_at, age_ms, provenance } (plus the internal _capturedAtMs the route strips).
export async function buildForgeConfig(projectPath, now = Date.now()) {
  const cached = cacheByProject.get(projectPath);
  if (cached && cached.expiresAt > now) {
    return { ...cached.data, age_ms: now - cached.data._capturedAtMs, provenance: 'DERIVED' };
  }
  if (!cached) {
    // Cold start for this project: no fallback value exists yet, so this call awaits the spawn.
    const data = storeProbe(projectPath, await probeForgeConfigLive(projectPath));
    return { ...data, age_ms: 0, provenance: 'DERIVED' };
  }
  const staleData = { ...cached.data, age_ms: now - cached.data._capturedAtMs };
  if (!refreshInFlightByProject.has(projectPath)) {
    const refresh = probeForgeConfigLive(projectPath)
      .then((probe) => { storeProbe(projectPath, probe); })
      .catch(() => { /* keep serving the last known-good cache; a failed background refresh must never crash a request */ })
      .finally(() => { refreshInFlightByProject.delete(projectPath); });
    refreshInFlightByProject.set(projectPath, refresh);
    return { ...staleData, provenance: 'STALE' };
  }
  return { ...staleData, provenance: 'CACHED' };
}

// Test-only hooks: never leak cache state across test files.
export function _resetForgeConfigCacheForTests() { cacheByProject.clear(); refreshInFlightByProject.clear(); }
export function _expireForgeConfigCacheForTests(projectPath) {
  const c = cacheByProject.get(projectPath);
  if (c) c.expiresAt = Date.now() - 1;
}
export function _awaitForgeConfigRefreshForTests(projectPath) {
  return refreshInFlightByProject.get(projectPath) || Promise.resolve();
}
export const _FORGE_CONFIG_CACHE_TTL_MS_FOR_TESTS = FORGE_CONFIG_CACHE_TTL_MS;
