// GET /api/capabilities source (SEC-PROJECT-CODE, 2026-09-24): runs THIS gateway's own CENTRAL copy of
// `forge-capabilities.cjs report --json` against the SELECTED project's data, via `--root <selected
// project>` — never the selected project's own copy of the script. This used to spawn the selected
// project's `.claude/forge-bin/forge-capabilities.cjs` directly, meaning selecting a project in the
// dashboard and requesting its capabilities executed THAT PROJECT'S OWN CODE with the gateway's
// inherited environment and privileges — exactly the "never runs a selected project's own code" promise
// this project's CHANGELOG makes, and exactly the same class of gap wp20/config.mjs already closed for
// GET /api/config's forge-config.cjs. The fix is the same pattern: one trusted CENTRAL script, a
// `--root`/env-scoped view of the SELECTED project's data, and a credential-free exec-bridge env
// allowlist (this tool needs no credential at all — it only reads local forge-bin/skills/gates/runs/
// agent-memory files). `forge-capabilities.cjs` already supports `--root <dir>` (it resolves every other
// path — claudeDir/binDir/skillsDir/etc. — relative to that root unless individually overridden), so no
// change to that script was needed.
//
// This is genuinely expensive (it scans forge-bin + skills + every run's events.jsonl + every
// agent-memory file), so results are cached 10 minutes per project with the same stale-while-
// revalidate shape projects.mjs already uses: a fresh cache hit returns instantly (provenance
// DERIVED); an expired cache still returns the last known-good value immediately while ONE
// background refresh runs (provenance STALE); a second call that arrives mid-refresh reuses that
// same in-flight promise (provenance CACHED). On timeout/missing-script/spawn-failure this NEVER
// fakes data — it reports a truthful available:false + state:'UNAVAILABLE' with the real reason.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redact, redactDeep } from './redact.mjs';
import { filteredEnv } from './exec-cli.mjs';
import { PROJECT_ROOT } from './paths.mjs';

// The one forge-capabilities.cjs this gateway ever executes (SEC-PROJECT-CODE) — its own, never the
// selected project's.
const CENTRAL_FORGE_CAPABILITIES_CJS = path.join(PROJECT_ROOT, '.claude', 'forge-bin', 'forge-capabilities.cjs');

const execFileAsync = promisify(execFile);
const CAPABILITIES_TIMEOUT_MS = 60_000;
const CAPABILITIES_CACHE_TTL_MS = 10 * 60_000;
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;
// WP10 F4/F5 (Codex, bounded-cache hardening): a hard cap on distinct cached project paths so this
// module's memory footprint stays bounded no matter how many different projects get probed over
// the gateway's lifetime. FIFO eviction (oldest-inserted key first) — simple, and never evicts the
// in-flight refresh's own key since that call always updates an EXISTING entry (see evictIfNeeded).
const MAX_CACHE_ENTRIES = 100;

const cacheByProject = new Map(); // projectPath -> { data, capturedAtMs, expiresAt }
const refreshInFlightByProject = new Map(); // projectPath -> Promise<void>

// Test-only override seam (mirrors config.mjs's _setForgeConfigCjsForTests / models.mjs's
// _setNvidiaProviderCjsForTests): replaces the CENTRAL script with a fixture so a tampered-script
// sentinel test can prove the selected project's own script never runs, without touching the real
// forge-capabilities.cjs. Production code never calls the setter.
let forgeCapabilitiesCjsOverride = null;
export function _setForgeCapabilitiesCjsForTests(p) { forgeCapabilitiesCjsOverride = p; }

// Only evicts when `key` would be a genuinely NEW entry — updating an existing project's cache
// entry (the stale-while-revalidate refresh path) never counts against the cap or triggers an
// eviction of a different project's entry.
function evictIfNeeded(key) {
  if (cacheByProject.has(key)) return;
  while (cacheByProject.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cacheByProject.keys().next().value;
    cacheByProject.delete(oldestKey);
  }
}

function hasClaudeDir(projectPath) {
  try { return fs.statSync(path.join(projectPath, '.claude')).isDirectory(); } catch { return false; }
}

async function probeCapabilitiesLive(projectPath) {
  if (!hasClaudeDir(projectPath)) {
    return { available: false, state: 'UNAVAILABLE', note: 'this project has no .claude/ folder — there is nothing to report on', capabilities: [], summary: null };
  }
  const scriptPath = forgeCapabilitiesCjsOverride || CENTRAL_FORGE_CAPABILITIES_CJS;
  if (!fs.existsSync(scriptPath)) {
    return { available: false, state: 'UNAVAILABLE', note: 'the central forge-capabilities.cjs was not found', capabilities: [], summary: null };
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, 'report', '--json', '--root', projectPath], {
      cwd: PROJECT_ROOT, env: filteredEnv({ credentialFree: true }),
      timeout: CAPABILITIES_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES,
    });
    const parsed = JSON.parse(stdout);
    return {
      available: true,
      state: 'OK',
      // sec-delta F2: the FAILURE path below has always been redacted; the success path was not.
      // Both are child stdout, and that child inherits the full environment (the allowlist covers
      // only the `claude` spawn). Redacting one branch and not the other is the kind of asymmetry
      // that survives review precisely because the redacted branch makes the file look handled.
      capabilities: redactDeep(Array.isArray(parsed.capabilities) ? parsed.capabilities : []),
      summary: redactDeep(parsed.summary || null),
    };
  } catch (err) {
    if (err && err.killed) {
      return { available: false, state: 'UNAVAILABLE', note: 'forge-capabilities.cjs report timed out after ' + CAPABILITIES_TIMEOUT_MS + 'ms', capabilities: [], summary: null };
    }
    // WP10 should-fix-now #12: err.message can echo the spawned child's own stderr/output on some
    // failure modes (e.g. a maxBuffer overrun embeds partial output). redact() strips any of the 5
    // known credential shapes before this ever reaches a response body.
    const rawMessage = err && err.message ? err.message : String(err);
    return { available: false, state: 'UNAVAILABLE', note: redact('forge-capabilities.cjs report failed: ' + rawMessage), capabilities: [], summary: null };
  }
}

function buildData(probe, capturedAtMs) {
  return {
    ok: true,
    available: probe.available,
    state: probe.state,
    note: probe.note,
    capabilities: probe.capabilities,
    summary: probe.summary,
    captured_at: new Date(capturedAtMs).toISOString(),
    _capturedAtMs: capturedAtMs,
  };
}

// Returns { ok, available, state, note?, capabilities, summary, captured_at, age_ms, provenance }.
export async function buildCapabilities(projectPath, now = Date.now()) {
  const cached = cacheByProject.get(projectPath);
  if (cached && cached.expiresAt > now) {
    return { ...cached.data, age_ms: now - cached.data._capturedAtMs, provenance: 'DERIVED' };
  }
  if (!cached) {
    // Cold start for this project: no fallback value exists yet, so this call genuinely awaits
    // the spawn (same cold-start rule as projects.mjs's listProjects()).
    const probe = await probeCapabilitiesLive(projectPath);
    const capturedAtMs = Date.now();
    const data = buildData(probe, capturedAtMs);
    evictIfNeeded(projectPath);
    cacheByProject.set(projectPath, { data, expiresAt: capturedAtMs + CAPABILITIES_CACHE_TTL_MS });
    return { ...data, age_ms: 0, provenance: 'DERIVED' };
  }
  const staleData = { ...cached.data, age_ms: now - cached.data._capturedAtMs };
  if (!refreshInFlightByProject.has(projectPath)) {
    const refresh = probeCapabilitiesLive(projectPath)
      .then((probe) => {
        const capturedAtMs = Date.now();
        const data = buildData(probe, capturedAtMs);
        evictIfNeeded(projectPath);
        cacheByProject.set(projectPath, { data, expiresAt: capturedAtMs + CAPABILITIES_CACHE_TTL_MS });
      })
      .catch(() => { /* keep serving the last known-good cache; a failed background refresh must never crash a request */ })
      .finally(() => { refreshInFlightByProject.delete(projectPath); });
    refreshInFlightByProject.set(projectPath, refresh);
    return { ...staleData, provenance: 'STALE' };
  }
  return { ...staleData, provenance: 'CACHED' };
}

// Test-only hooks: never leak cache state across test files.
export function _resetCapabilitiesCacheForTests() { cacheByProject.clear(); refreshInFlightByProject.clear(); }
export function _expireCapabilitiesCacheForTests(projectPath) {
  const c = cacheByProject.get(projectPath);
  if (c) c.expiresAt = Date.now() - 1;
}
export function _awaitCapabilitiesRefreshForTests(projectPath) {
  return refreshInFlightByProject.get(projectPath) || Promise.resolve();
}
export function _capabilitiesCacheSizeForTests() { return cacheByProject.size; }
export const _CAPABILITIES_MAX_CACHE_ENTRIES_FOR_TESTS = MAX_CACHE_ENTRIES;
