// GET /api/models source: THIS gateway's own installation (no `?project=` — the literal WP3
// endpoint shape carries none, unlike missions/agents/skills/proof) — .claude/config/models/
// model-capability-matrix.json plus a live NVIDIA health probe. The probe spawns the existing,
// already-reviewed `nvidia-provider.cjs health` CLI (async execFile, 5s timeout) rather than
// re-implementing NVIDIA connectivity here, and caches the result 60s — a truthful DISCONNECTED
// or UNKNOWN state is reported on failure/timeout; NEVER a fabricated "live" state.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MODEL_CAPABILITY_MATRIX_FILE, NVIDIA_PROVIDER_CJS } from './paths.mjs';
import { redact } from './redact.mjs';

const execFileAsync = promisify(execFile);
const NVIDIA_HEALTH_TIMEOUT_MS = 5000;
const NVIDIA_HEALTH_CACHE_TTL_MS = 60_000;
let nvidiaHealthCache = null; // { result, capturedAtMs }

// Test-only override seam (mirrors conversations.mjs's _setConversationsDirForTests pattern): lets
// a unit test point the health probe at a fixture script instead of the real nvidia-provider.cjs,
// so a spawn-failure/credential-in-stderr path can be proven without depending on live NVIDIA
// connectivity or a real key. Production code never calls the setter.
let nvidiaProviderCjsOverride = null;
function activeNvidiaProviderCjs() {
  return nvidiaProviderCjsOverride || NVIDIA_PROVIDER_CJS;
}
export function _setNvidiaProviderCjsForTests(p) { nvidiaProviderCjsOverride = p; }

// The CLI's `health` subcommand prints one plain-text line (verified live, no --json flag
// exists on it today) — see nvidia-provider.cjs's own `cmd === 'health'` branch:
//   "NVIDIA OK (live) — <n> models · <ms>ms · <baseUrl>"           (real, connected)
//   "NVIDIA MOCK MODE (no key — NOT live-ready) — <reason>"         (no NVIDIA_API_KEY configured)
//   "NVIDIA FAIL — <reason>"                                        (key present, live call failed)
function parseNvidiaHealthOutput(stdout) {
  const line = String(stdout || '').trim();
  const okMatch = line.match(/^NVIDIA OK \(live\) — (\d+) models · (\d+)ms · (.+)$/);
  if (okMatch) return { state: 'CONNECTED', models: Number(okMatch[1]), ms: Number(okMatch[2]), base_url: okMatch[3] };
  if (/^NVIDIA MOCK MODE/i.test(line)) return { state: 'NOT CONFIGURED', note: line };
  if (/^NVIDIA FAIL/i.test(line)) return { state: 'DISCONNECTED', note: line };
  // WP8-13 gap-closing round (this is the highest-risk child in the gateway: nvidia-provider.cjs
  // is spawned WITHOUT the exec-bridge env allowlist, since it genuinely needs NVIDIA_API_KEY —
  // so its own stdout is the most likely place a real key surfaces). redact() runs on the FULL
  // line before truncation so a credential isn't half-cut by the 200-char slice first.
  return { state: 'UNKNOWN', note: 'unrecognized nvidia-provider health output: ' + redact(line).slice(0, 200) };
}

async function probeNvidiaHealthLive() {
  try {
    const { stdout } = await execFileAsync(process.execPath, [activeNvidiaProviderCjs(), 'health'], {
      timeout: NVIDIA_HEALTH_TIMEOUT_MS, windowsHide: true, encoding: 'utf8',
    });
    return parseNvidiaHealthOutput(stdout);
  } catch (err) {
    if (err && err.killed) return { state: 'UNKNOWN', note: 'nvidia-provider health probe timed out after ' + NVIDIA_HEALTH_TIMEOUT_MS + 'ms' };
    // WP8-13 gap-closing round: a non-zero exit's err.message can embed the child's own stderr
    // verbatim (Node's child_process error formatting) — exactly where an unallowlisted
    // NVIDIA_API_KEY-bearing child is most likely to leak a real credential on failure.
    const rawMessage = err && err.message ? err.message : String(err);
    return { state: 'DISCONNECTED', note: 'nvidia-provider health probe failed: ' + redact(rawMessage) };
  }
}

async function probeNvidiaHealthCached() {
  const now = Date.now();
  if (nvidiaHealthCache && (now - nvidiaHealthCache.capturedAtMs) < NVIDIA_HEALTH_CACHE_TTL_MS) {
    return { ...nvidiaHealthCache.result, age_ms: now - nvidiaHealthCache.capturedAtMs };
  }
  const result = await probeNvidiaHealthLive();
  nvidiaHealthCache = { result, capturedAtMs: Date.now() };
  return { ...result, age_ms: 0 };
}

function readMatrix() {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(MODEL_CAPABILITY_MATRIX_FILE, 'utf8')) }; }
  catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
}

export async function buildModelsView() {
  const matrix = readMatrix();
  const nvidia = await probeNvidiaHealthCached();
  const now = new Date();
  if (!matrix.ok) {
    return { ok: true, matrix_available: false, matrix_error: matrix.error, roles: {}, catalog: [], nvidia, captured_at: now.toISOString(), age_ms: 0, provenance: 'DERIVED' };
  }
  const roles = matrix.data.roles || {};
  const catalog = matrix.data.catalog || [];
  const notAvailableOrBroken = matrix.data.notAvailableOrBroken || {};
  const verifiedDates = catalog
    .map((c) => { const m = String(c.verified || '').match(/(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; })
    .filter(Boolean)
    .sort();
  return {
    ok: true,
    matrix_available: true,
    roles,
    catalog,
    broken_count: Object.keys(notAvailableOrBroken).length,
    latest_verified_date: verifiedDates.length ? verifiedDates[verifiedDates.length - 1] : null,
    nvidia,
    captured_at: now.toISOString(),
    age_ms: 0,
    provenance: 'DERIVED',
  };
}

export function _resetNvidiaHealthCacheForTests() { nvidiaHealthCache = null; }
// Test-only export so a unit test can drive the unrecognized-output redaction path directly,
// without spawning a real (or fixture) child process.
export function _parseNvidiaHealthOutputForTests(stdout) { return parseNvidiaHealthOutput(stdout); }
