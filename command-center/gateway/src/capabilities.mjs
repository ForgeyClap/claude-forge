// GET /api/capabilities source: spawns the SELECTED project's own already-reviewed
// `forge-capabilities.cjs report --json` — the ONE allowlisted forge-bin execution this whole WP
// is permitted (every other tool stays a read-only inventory entry via tools.mjs). Fixed args,
// never built from request input beyond the already-allowlisted project path (resolved upstream
// via the trusted project registry, exactly like models.mjs's NVIDIA probe and projects.mjs's
// forge-sync spawn). `forge-capabilities.cjs`'s own PROJECT_ROOT_DEFAULT resolves relative to the
// SCRIPT's own location (two directories up from forge-bin/), so no `--root` override is needed —
// spawning THAT project's own copy of the script naturally reports on THAT project.
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
import { containmentOk } from './security.mjs';
import { redact, redactDeep } from './redact.mjs';

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

function capabilitiesScriptPath(projectPath) {
  return path.join(projectPath, '.claude', 'forge-bin', 'forge-capabilities.cjs');
}

async function probeCapabilitiesLive(projectPath) {
  const claudeDir = path.join(projectPath, '.claude');
  const scriptPath = capabilitiesScriptPath(projectPath);
  if (!containmentOk(claudeDir, scriptPath)) {
    return { available: false, state: 'UNAVAILABLE', note: 'path containment violation', capabilities: [], summary: null };
  }
  if (!fs.existsSync(scriptPath)) {
    return { available: false, state: 'UNAVAILABLE', note: 'forge-capabilities.cjs not found for this project', capabilities: [], summary: null };
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, 'report', '--json'], {
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
