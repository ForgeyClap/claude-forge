// Forge Compatibility Gateway — request handler + server factory.
// Zero-dependency (node:http only). Binds 127.0.0.1 only; enforces the DNS-rebinding + cross-site
// guard on every request before any route logic runs, exactly as .claude/forge-dashboard/server.cjs
// already does for the existing Control Center.
import http from 'node:http';
import { hostOk, crossSiteOk, safeIdOk, anyContainmentOk, safeConvIdOk, execTokenOk, EXEC_TOKEN_HEADER } from './security.mjs';
import { listProjects } from './projects.mjs';
import { createProject, validateProjectName, projectNameContainmentOk, getInstallStatus } from './projects-create.mjs';
import { listRuns } from './runs.mjs';
import { readEvents, attachEventsStream } from './events.mjs';
import { buildHealth } from './health.mjs';
import { serveStatic, STATIC_SECURITY_HEADERS } from './static.mjs';
import { SYNC_SCAN_ROOTS } from './paths.mjs';
import { buildMission } from './missions.mjs';
import { buildAgentsRegistry } from './agents.mjs';
import { patchAgentModel } from './agents-write.mjs';
import { buildProjectProfile } from './project-profile.mjs';
import { buildSkillsRegistry } from './skills.mjs';
import { buildModelsView } from './models.mjs';
import { buildProof, buildProofAll } from './proof.mjs';
import { listChatRuns } from './chat-runs.mjs';
import { listPendingAsksForProject } from './pending-asks.mjs';
import { listAgentDispatches } from './agent-dispatches.mjs';
import { buildUsage } from './usage.mjs';
import { buildToolsInventory } from './tools.mjs';
import { buildMcpView } from './mcp.mjs';
import { buildCapabilities } from './capabilities.mjs';
import { buildForgeConfig } from './config.mjs';
import { listDirectory, readFilePreview } from './files.mjs';
import { buildRecovery, buildCheckpoints } from './recovery.mjs';
import { buildApprovals } from './approvals.mjs';
import { readJsonBody, validateSchema, BodyTooLargeError } from './body.mjs';
import {
  listConversations,
  readConversation,
  createConversation,
  conversationExists,
  appendUserTurn,
  appendConversationEvent,
  attachConversationStream,
  deleteConversation,
} from './conversations.mjs';
import {
  executionAvailability,
  isConversationBusy,
  startExecution,
  stopExecution,
  isUnsafeExecPromptText,
  pauseExecTimeoutForAsk,
  resumeExecTimeoutAfterAsk,
} from './exec-bridge.mjs';
import { buildArtifactContentResponse } from './artifact-content.mjs';
import { readRawBody, parseMultipart, storeAttachment, AttachmentTooLargeError } from './attachments.mjs';
import { createAskRequest, answerAskRequest } from './ask-store.mjs';
import { getDiscordStatus, startDiscordService, stopDiscordService } from './discord-service.mjs';

const startedAtMs = Date.now();

// WP4: path patterns for the conversation routes. `[^/]+` is intentionally looser than
// safeConvIdOk() — every match is re-validated against the real conv-id allowlist before it ever
// touches the filesystem (see conversations.mjs's own resolveSafe()), so a route that merely
// "looks like" a conversation path but fails the allowlist still reaches an honest 400/404, not a
// silent 404-from-no-match that could be confused with "route doesn't exist".
const CONV_ITEM_RE = /^\/api\/conversations\/([^/]+)$/;
const CONV_MESSAGES_RE = /^\/api\/conversations\/([^/]+)\/messages$/;
// fix-exec-modes: the real, help-confirmed `claude`/`claude -p` permission-mode + effort choices
// (verified via `claude --help` and `claude -p --help`, both print the identical flag set — see
// exec-bridge.mjs's MODE_TO_PERMISSION_FLAG comment for the exact help text this allowlist is
// derived from). 'execute' is this route's own default (no --permission-mode flag at all), not a
// real CLI flag value itself. Owner-requested 'bypass' mode is scoped to this loopback,
// single-user gateway tool only — see the SECURITY FRAME comment in exec-bridge.mjs.
const EXEC_MODE_VALUES = ['execute', 'plan', 'accept-edits', 'bypass'];
const EXEC_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];
// feat-model-picker: the real, help-confirmed `claude --model <model>` values — same
// allowlist-or-400 pattern as `mode`/`effort` above, same "never a free string reaches argv" rule.
// Source, verbatim from `claude --help`:
//   --model <model>   Model for the current session. Provide an alias for the latest model
//                      (e.g. 'fable', 'opus', or 'sonnet') or a model's full name
//                      (e.g. 'claude-fable-5').
// The three aliases 'fable'/'opus'/'sonnet' are exactly the three the help text names as
// examples ("e.g." — never claimed exhaustive). The four full names are this environment's own
// known model ids (claude-fable-5/claude-opus-5/claude-sonnet-5/claude-haiku-4-5-20251001) —
// already established as real independent of the alias examples above.
//
// 2026-07-30 CORRECTION (coordinator-reported real, non-mock CLI verification — NOT re-run
// independently by Build Boss, attributed here rather than claimed as self-verified): five short,
// paid `claude -p --model <value> '<prompt>'` calls from a neutral directory each answered
// correctly with exit code 0:
//   --model 'claude-opus-5[1m]'  'Antwoord met precies: MODELTEST'  -> "MODELTEST"
//   --model 'opus[1m]'           'zeg OK'                            -> "OK"
//   --model 'fable'              'zeg OK'                            -> "OK"
//   --model 'sonnet'             'zeg OK'                            -> "OK"
//   --model 'haiku'              'zeg OK'                            -> "OK"
// This proves two things a `--help`-only pass could not: (1) `haiku` IS a real, working alias —
// `--help`'s three examples were never claimed exhaustive, this is simply the first real test of
// the fourth one; (2) the "[1m]" context-window suffix IS real, accepted `--model` INPUT syntax,
// on both the full id (`claude-opus-5[1m]`) and the short alias (`opus[1m]`) — an earlier round of
// this same allowlist excluded the suffix on exactly the "`--help` text alone gives no evidence"
// reasoning this real-run evidence now supersedes, not merely re-asserts over.
// INPUT/OUTPUT NOW CONSISTENT: this project's own `.data/conversations/*.jsonl` already showed
// `"claude-opus-5[1m]"` as a real OUTPUT `modelUsage` key (10 occurrences, always paired with
// `canonicalModel:"claude-opus-5"` and `contextWindow:1000000`) — the CLI reports this exact
// string when a 1M-context Opus run happens. The two facts now corroborate each other: the same
// string that the CLI reports back as having run is confirmed to also be a real, acceptable
// `--model` INPUT value.
// `opus[1m]` (the alias+suffix form) is allowlisted too since aliases are already accepted
// generally and this specific combination was itself one of the five real-verified runs above.
// No OTHER bracket-suffixed combination (e.g. 'claude-fable-5[1m]', never observed as either
// input or output) is allowlisted — this stays an exact-match array, not a permissive pattern.
const EXEC_MODEL_VALUES = [
  'fable', 'opus', 'sonnet', 'haiku',
  'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
  'claude-opus-5[1m]', 'opus[1m]',
];
const CONV_STOP_RE = /^\/api\/conversations\/([^/]+)\/stop$/;
// feat-ask-owner: POST /api/ask is called by the ask-mcp.mjs MCP subprocess (never the browser) to
// register a real question and BLOCK until the owner answers or the ask times out. POST
// /api/ask/:id/answer is the dashboard's own real answer submission.
const ASK_RE = /^\/api\/ask$/;
const ASK_ANSWER_RE = /^\/api\/ask\/([^/]+)\/answer$/;
const CONV_STREAM_RE = /^\/api\/conversations\/([^/]+)\/stream$/;
// build-lastdemos T3: the composer's real "Attach" upload route.
const CONV_ATTACHMENTS_RE = /^\/api\/conversations\/([^/]+)\/attachments$/;
// build-lastdemos T2: the real artifact-download route (id shape checked again, more permissively
// than run/conv ids, by artifact-content.mjs's own safeArtifactIdOk — this pattern only excludes
// literal path separators).
const ARTIFACT_CONTENT_RE = /^\/api\/artifacts\/([^/]+)\/content$/;
// cc-fix-adapter T6d: the project name is a URL PATH segment here (not a `?project=` query like
// every other route) — still re-validated against the same trusted registry via
// resolveProjectByName() before touching the filesystem, exactly like every other route below.
const PROJECT_PROFILE_RE = /^\/api\/projects\/([^/]+)\/profile$/;
// feat-agent-model-edit: PATCH /api/agents/:slug/model?project=<name> — the one route that ever
// changes something inside `.claude/config/agents/agent-model-map.json` (see agents-write.mjs's
// own header for the full write-boundary exception this is). The slug is a URL path segment (same
// shape as PROJECT_PROFILE_RE above); re-validated against safeIdOk() before it is ever used, same
// "never trust a single check point" discipline as every other route here.
const AGENT_MODEL_RE = /^\/api\/agents\/([^/]+)\/model$/;

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}

// fix-test-hygiene (owner-flagged system-checkup finding, MEDIUM/INFO): POST /api/conversations and
// POST /api/conversations/:id/messages had NO request-count limit at all — exec-bridge.mjs's
// MAX_CONCURRENT_EXECUTIONS=3 and the 409 duplicate-send guard only bound concurrent EXECUTION
// (how many `claude` child processes run at once / one pending turn per conversation), not how many
// HTTP requests can be fired. A misbehaving script or a runaway retry loop could still call either
// route an unbounded number of times per second.
//
// This is a small in-memory token bucket, one per route family, and it is an ANTI-RUNAWAY BRAKE,
// NOT a security control — this gateway is loopback-only and single-user (see security.mjs's
// EXEC_TOKEN comment for the actual trust boundary: same-origin-plus-token against a separate local
// process). It exists purely so a stuck loop can't hammer conversation-create/message-send
// indefinitely; it does not replace or weaken the existing exec-token/409/containment checks below,
// which are unchanged.
//
// Limits: capacity 60, refilling to full capacity over a 60-second window (~1 req/s sustained,
// burst up to 60) — PER route family, independently. Chosen from this repo's own real usage as the
// evidence floor: routes-wp4.test.mjs (the heaviest real caller of these two routes) fires 37 real
// POST /api/conversations calls and 23 real POST .../messages calls in a single run, all comfortably
// under 60 with wide margin, so no legitimate dashboard session — or this project's own existing
// test suite — ever gets near this ceiling. A runaway script making dozens of requests per second
// trips it within its first second.
const RATE_LIMIT_DEFAULT_CAPACITY = 60;
const RATE_LIMIT_DEFAULT_REFILL_MS = 60_000;

let rateLimitCapacity = RATE_LIMIT_DEFAULT_CAPACITY;
let rateLimitRefillMs = RATE_LIMIT_DEFAULT_REFILL_MS;
let rateLimitClockOverride = null;

function rateLimitNow() { return rateLimitClockOverride ? rateLimitClockOverride() : Date.now(); }

function createTokenBucket() {
  let tokens = rateLimitCapacity;
  let lastRefillMs = rateLimitNow();
  return {
    tryConsume() {
      const t = rateLimitNow();
      const elapsedMs = Math.max(0, t - lastRefillMs);
      if (elapsedMs > 0) {
        const refilled = (elapsedMs / rateLimitRefillMs) * rateLimitCapacity;
        tokens = Math.min(rateLimitCapacity, tokens + refilled);
        lastRefillMs = t;
      }
      if (tokens >= 1) {
        tokens -= 1;
        return { allowed: true };
      }
      const missingTokens = 1 - tokens;
      const msUntilNextToken = Math.ceil((missingTokens / rateLimitCapacity) * rateLimitRefillMs);
      return { allowed: false, retryAfterMs: Math.max(1, msUntilNextToken) };
    },
  };
}

let rateLimitBuckets = { conversationCreate: createTokenBucket(), conversationMessage: createTokenBucket() };

// Test-only override seams (mirror this codebase's existing `_set*ForTests` convention, e.g.
// conversations.mjs's `_setConversationsDirForTests`). Production code never calls either —
// `rateLimitBuckets`/`rateLimitCapacity`/`rateLimitRefillMs` always keep the real defaults above in
// a real gateway process.
export function _setRateLimitClockForTests(fn) { rateLimitClockOverride = fn; }
/** Shrinks (or restores, when called with no args) the bucket capacity/window and always rebuilds
 *  fresh, full buckets — so a rate-limit test can trip the limit with a handful of requests instead
 *  of the real production capacity, without a real multi-second sleep. */
export function _configureRateLimitForTests({ capacity = RATE_LIMIT_DEFAULT_CAPACITY, refillMs = RATE_LIMIT_DEFAULT_REFILL_MS } = {}) {
  rateLimitCapacity = capacity;
  rateLimitRefillMs = refillMs;
  rateLimitBuckets = { conversationCreate: createTokenBucket(), conversationMessage: createTokenBucket() };
}

/** Returns true (caller proceeds) or sends a real 429 + Retry-After and returns false. */
function checkRateLimit(bucketKey, res) {
  const result = rateLimitBuckets[bucketKey].tryConsume();
  if (result.allowed) return true;
  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  sendJson(
    res,
    429,
    {
      ok: false,
      error: 'rate limit exceeded for this route (anti-runaway brake, not a security boundary) — retry in ' + retryAfterSeconds + 's',
      retry_after_ms: result.retryAfterMs,
    },
    { 'Retry-After': String(retryAfterSeconds) },
  );
  return false;
}

// build-lastdemos T2: a real, single-shot binary response — GET /api/artifacts/:id/content is
// the one route on this gateway that serves file bytes rather than JSON, so it needs its own
// small writer instead of sendJson()'s fixed JSON content type.
function sendFile(res, status, buffer, fileName, mime) {
  res.writeHead(status, {
    'Content-Type': mime,
    'Content-Disposition': 'attachment; filename="' + fileName + '"',
    'Content-Length': String(buffer.length),
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

// Resolves a `?project=<name>` query value against the trusted, cached project registry.
// This is the allowlist: a name that doesn't match any real discovered project resolves to
// null, regardless of what the caller typed (so `../../` or any traversal payload as the
// *name* simply never matches an entry and is rejected — it never reaches a filesystem call).
async function resolveProjectByName(name) {
  const registry = await listProjects();
  if (!registry.ok) return { entry: null, registryError: registry.error };
  const entry = registry.projects.find((p) => p.name === name);
  if (!entry) return { entry: null };
  if (!anyContainmentOk(SYNC_SCAN_ROOTS, entry.path)) return { entry: null }; // defense in depth
  return { entry };
}

async function handleApi(req, res, pathname, searchParams) {
  if (pathname === '/api/health') {
    const health = await buildHealth(startedAtMs);
    return sendJson(res, 200, health);
  }

  // WP-D1 (feat-discord-gateway): read-only, no exec token — same shape as every other GET route.
  if (pathname === '/api/discord/status' && req.method === 'GET') {
    const service = await getDiscordStatus();
    return sendJson(res, 200, { ok: true, service });
  }

  // WP-D1: a real write (spawns a child process) — exec token required, same as every other
  // write route, now checked once in requestListener (N6 fix) before handleApi is ever called.
  if (pathname === '/api/discord/start' && req.method === 'POST') {
    const result = await startDiscordService();
    if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
    return sendJson(res, result.status, { ok: true, pid: result.pid });
  }

  // WP-D1: stop is idempotent (never an error when nothing is tracked) but is still a real write —
  // same exec-token requirement as start (checked once in requestListener, N6 fix).
  if (pathname === '/api/discord/stop' && req.method === 'POST') {
    const result = await stopDiscordService();
    return sendJson(res, 200, { ok: true, stopped: result.stopped });
  }

  if (pathname === '/api/projects') {
    if (req.method === 'POST') {
      // N6 fix (WP-C1): this real write (scaffolds a directory and starts a detached installer) had
      // NO exec-token check at all before this fix — the exec token is now checked once in
      // requestListener, before handleApi is ever reached, for every non-GET request.
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err instanceof BodyTooLargeError ? 413 : 400, { ok: false, error: err.message });
      }
      const schemaErr = validateSchema(body, ['name'], ['name']);
      if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
      if (typeof body.name !== 'string') return sendJson(res, 400, { ok: false, error: 'name must be a string' });
      const result = await createProject({ name: body.name });
      return sendJson(res, result.status, result.body);
    }
    const result = await listProjects();
    const { _capturedAtMs, ...safe } = result;
    return sendJson(res, result.ok ? 200 : 502, safe);
  }

  // build-async-install: the dashboard polls this after a 201 from POST /api/projects (which never
  // waits for the real installer — see projects-create.mjs's own header) to learn the installer's
  // real, honest outcome once it's known. Guarded exactly like the POST route: same name allowlist,
  // same belt-and-suspenders containment check (projectNameContainmentOk mirrors createProject's own).
  if (pathname === '/api/projects/install-status') {
    const name = searchParams.get('name') || '';
    const nameError = validateProjectName(name);
    if (nameError) return sendJson(res, 400, { ok: false, error: nameError });
    if (!projectNameContainmentOk(name)) {
      return sendJson(res, 400, { ok: false, error: 'name resolves outside the projects root' });
    }
    const status = getInstallStatus(name);
    if (!status) {
      // Honest, not a guess: this gateway process never recorded an install for this name — either
      // it never ran here, or (far more likely for a name that really was just created) this
      // process restarted since. Never reported as a fabricated 'installed' or 'failed'.
      return sendJson(res, 200, {
        ok: true,
        state: 'unknown',
        reason: null,
        note: 'no install status recorded for this project name in this gateway process (it may have restarted since the project was created)',
      });
    }
    return sendJson(res, 200, { ok: true, ...status });
  }

  if (pathname === '/api/runs') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = listRuns(entry.path);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === '/api/events') {
    const projectName = searchParams.get('project') || '';
    const runId = searchParams.get('run') || '';
    const afterRaw = searchParams.get('after');
    const after = afterRaw != null ? Number.parseInt(afterRaw, 10) : 0;
    if (!safeIdOk(runId)) return sendJson(res, 400, { ok: false, error: 'invalid or missing ?run=<id>' });
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = readEvents(entry.path, runId, Number.isFinite(after) && after >= 0 ? after : 0);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  // /api/events/stream is handled one level up (requestListener) — it must take over `res`
  // itself (text/event-stream, long-lived) rather than go through sendJson()'s single-shot
  // JSON-response shape used by every route above.

  if (pathname === '/api/missions') {
    const projectName = searchParams.get('project') || '';
    const runId = searchParams.get('run') || '';
    if (!safeIdOk(runId)) return sendJson(res, 400, { ok: false, error: 'invalid or missing ?run=<id>' });
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = buildMission(entry.path, runId);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === '/api/agents') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = buildAgentsRegistry(entry.path);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  // feat-agent-model-edit: PATCH /api/agents/:slug/model?project=<name> — see agents-write.mjs's
  // own header for the full write-boundary exception and validation contract this delegates to.
  // Order: slug shape (400) -> body read/schema (400/413) -> project resolution (502/404) -> the
  // actual patch (agents-write.mjs owns every remaining 400/404/500/200 outcome). The exec token
  // itself is checked once in requestListener (N6 fix), before handleApi is ever reached.
  const agentModelMatch = pathname.match(AGENT_MODEL_RE);
  if (agentModelMatch && req.method === 'PATCH') {
    let slug;
    try { slug = decodeURIComponent(agentModelMatch[1]); } catch { return sendJson(res, 400, { ok: false, error: 'invalid agent slug' }); }
    if (!safeIdOk(slug)) return sendJson(res, 400, { ok: false, error: 'invalid agent slug' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err instanceof BodyTooLargeError ? 413 : 400, { ok: false, error: err.message });
    }
    const schemaErr = validateSchema(body, ['claudeTier', 'claudeEffort'], []);
    if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
    if (Object.keys(body).length === 0) {
      return sendJson(res, 400, { ok: false, error: 'at least one of claudeTier/claudeEffort must be provided' });
    }
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = patchAgentModel({ projectPath: entry.path, projectName: entry.name, slug, patch: body });
    return sendJson(res, result.status, result.body);
  }

  const profileMatch = pathname.match(PROJECT_PROFILE_RE);
  if (profileMatch) {
    let projectName;
    try { projectName = decodeURIComponent(profileMatch[1]); } catch { return sendJson(res, 400, { ok: false, error: 'invalid project name' }); }
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = buildProjectProfile(entry.path);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === '/api/skills') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = buildSkillsRegistry(entry.path);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === '/api/models') {
    const result = await buildModelsView();
    return sendJson(res, result.ok ? 200 : 502, result);
  }

  if (pathname === '/api/proof') {
    const projectName = searchParams.get('project') || '';
    const runId = searchParams.get('run') || '';
    // cc-fix-artifacts-empty: `?run=all` is the one new sentinel value — a project-wide artifact
    // listing across the last several runs (see proof.mjs's own `buildProofAll` header for the
    // bound and honesty rules). Every other value keeps the EXACT original validation order/short
    // circuit (an invalid id is rejected before any project lookup happens), so this changes
    // nothing about the existing single-run behavior.
    if (runId !== 'all' && !safeIdOk(runId)) return sendJson(res, 400, { ok: false, error: 'invalid or missing ?run=<id> (or ?run=all)' });
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = runId === 'all' ? buildProofAll(entry.path) : buildProof(entry.path, runId);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  // feat-chatruns-tabs: real dashboard-CHAT "runs" for one project — see chat-runs.mjs's own header
  // for why this is a pure derivation over the existing conversation store, never a second write
  // path. Same allowlist-by-registry-name pattern as every other `?project=` route above; no run id
  // involved (a chat-run's id is generated by chat-runs.mjs itself, never taken from the request).
  if (pathname === '/api/chat-runs') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    return sendJson(res, 200, {
      ok: true,
      chat_runs: listChatRuns(projectName),
      captured_at: new Date().toISOString(),
      age_ms: 0,
      provenance: 'DERIVED',
    });
  }

  // feat-live-visibility (Gap A): every ask genuinely pending right now for this project's
  // conversations — see pending-asks.mjs's own header for why this joins the live in-memory
  // ask-store registry rather than re-scanning conversation events. Same allowlist-by-registry-
  // name pattern as every other `?project=` route above.
  if (pathname === '/api/pending-asks') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    return sendJson(res, 200, {
      ok: true,
      pending_asks: listPendingAsksForProject(projectName),
      captured_at: new Date().toISOString(),
      age_ms: 0,
      provenance: 'DERIVED',
    });
  }

  // feat-live-visibility (Gap B): every real subagent dispatch recorded for this project's
  // conversations — see agent-dispatches.mjs's own header for exactly which stored fields this
  // reads and why. Same allowlist-by-registry-name pattern as every other `?project=` route above.
  if (pathname === '/api/agent-dispatches') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    return sendJson(res, 200, {
      ok: true,
      dispatches: listAgentDispatches(projectName),
      captured_at: new Date().toISOString(),
      age_ms: 0,
      provenance: 'DERIVED',
    });
  }

  if (pathname === '/api/usage') {
    const result = buildUsage();
    return sendJson(res, 200, result);
  }

  // build-lastdemos T2: real artifact download — the frontend's `Artifact.id` is exactly one of
  // proof.mjs's two real sources (see artifact-content.mjs's header for the full reasoning).
  const artifactContentMatch = pathname.match(ARTIFACT_CONTENT_RE);
  if (artifactContentMatch) {
    let artifactId;
    try { artifactId = decodeURIComponent(artifactContentMatch[1]); } catch { return sendJson(res, 400, { ok: false, error: 'invalid artifact id' }); }
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = buildArtifactContentResponse(entry.path, artifactId);
    if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
    return sendFile(res, result.status, result.buffer, result.fileName, result.mime);
  }

  // ── WP6 T6.1-T6.7: agents/skills/tools/MCP/models/capability health map additions ──────────
  // (+ wp12 forge-2026-09-24-config-v250: GET /api/config, read-only Forge settings, right after
  // /api/capabilities below)
  if (pathname === '/api/tools') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = buildToolsInventory(entry.path);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === '/api/mcp') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = buildMcpView(entry.path);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === '/api/capabilities') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = await buildCapabilities(entry.path);
    const { _capturedAtMs, ...safe } = result;
    return sendJson(res, safe.ok ? 200 : 502, safe);
  }

  // forge-2026-09-24-config-v250 wp12: READ-ONLY view of the selected project's own Forge settings
  // (its `forge-config.cjs list --json --all`, see config.mjs). GET only — there is deliberately no
  // write route: a setting is changed in chat or with `/forge config set` (D2 write boundary).
  if (pathname === '/api/config') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = await buildForgeConfig(entry.path);
    const { _capturedAtMs, ...safe } = result;
    return sendJson(res, safe.ok ? 200 : 502, safe);
  }

  // ── WP8: secure project-scoped file browser (read-only, containment + denylist hardened) ──
  if (pathname === '/api/files') {
    const projectName = searchParams.get('project') || '';
    const relPath = searchParams.get('path') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = listDirectory(entry.path, relPath);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === '/api/files/read') {
    const projectName = searchParams.get('project') || '';
    const relPath = searchParams.get('path') || '';
    if (!relPath) return sendJson(res, 400, { ok: false, error: 'missing ?path=' });
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = readFilePreview(entry.path, relPath);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  // ── WP8: recovery / doc-drift + resumability checkpoints (both honestly empty when absent) ──
  if (pathname === '/api/recovery') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = buildRecovery(entry.path);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (pathname === '/api/checkpoints') {
    const projectName = searchParams.get('project') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = buildCheckpoints(entry.path);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  // ── WP8: hard-gates model — the real equivalent of an "approvals" view ─────────────────────
  if (pathname === '/api/approvals') {
    const projectName = searchParams.get('project') || '';
    const runId = searchParams.get('run') || '';
    const { entry, registryError } = await resolveProjectByName(projectName);
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
    const result = buildApprovals(entry.path, runId);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  // ── WP4 T4.2-T4.4: conversation layer (gateway is the sole writer, only under .data/) ──────
  if (pathname === '/api/conversations') {
    if (req.method === 'GET') {
      // fix-conv-filter: `?project=<name>` used to be read by NO code at all — every caller got
      // every conversation across every project (measured live: three different ?project= values
      // returned byte-identical rows). Filtered HERE, over listConversations()'s already-built
      // summary rows, rather than adding a project parameter down into listConversations()/
      // summarizeConversationFileCached(): SUMMARY_CACHE (conversations.mjs) keys purely on
      // absolute file path + mtimeMs/size and already computes `project` as one of its three
      // cached scalars, so post-filtering the returned array adds zero extra reads and can never
      // invalidate or bypass that cache — a project param threaded into the cache layer would risk
      // exactly that. chat-runs.mjs's own `.filter((c) => c.project === projectName)` (unaffected
      // by this change) is the existing in-repo precedent for "filter the already-summarized list,
      // don't touch the cache". An empty/absent `?project=` keeps the pre-fix "return everything"
      // behavior byte-for-byte (dashboard-wide views are unaffected); a present value is validated
      // against the same registry allowlist + error shape every other `?project=` route in this
      // file already uses (resolveProjectByName -> 502 on registry failure, 404 on an unknown name).
      const projectName = searchParams.get('project') || '';
      let conversations = listConversations();
      if (projectName) {
        const { entry, registryError } = await resolveProjectByName(projectName);
        if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
        if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
        conversations = conversations.filter((c) => c.project === projectName);
      }
      return sendJson(res, 200, {
        ok: true,
        conversations,
        execution: executionAvailability(),
        captured_at: new Date().toISOString(),
        age_ms: 0,
        provenance: 'LIVE',
      });
    }
    if (req.method === 'POST') {
      if (!checkRateLimit('conversationCreate', res)) return;
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err instanceof BodyTooLargeError ? 413 : 400, { ok: false, error: err.message });
      }
      const schemaErr = validateSchema(body, ['project', 'title'], ['project']);
      if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
      if (typeof body.project !== 'string' || body.project.length === 0) {
        return sendJson(res, 400, { ok: false, error: 'project must be a non-empty string' });
      }
      // `title` is optional. `null` means "no title supplied" exactly like an omitted field —
      // createConversation() already normalises both to a stored `title: null` (see
      // conversations.mjs). Only a genuinely wrong type (number/object/array/boolean/string here
      // being the only other JSON types once undefined/null are excluded) is a real validation
      // error.
      if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
        return sendJson(res, 400, { ok: false, error: 'title must be a string' });
      }
      const { entry, registryError } = await resolveProjectByName(body.project);
      if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
      if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
      const conversation = createConversation({ project: body.project, title: body.title ?? undefined });
      return sendJson(res, 201, { ok: true, conversation });
    }
  }

  const convItemMatch = pathname.match(CONV_ITEM_RE);
  if (convItemMatch && req.method === 'GET') {
    const convId = convItemMatch[1];
    if (!safeConvIdOk(convId)) return sendJson(res, 400, { ok: false, error: 'invalid conversation id' });
    const result = readConversation(convId);
    return sendJson(res, result.ok ? 200 : 404, result);
  }

  // feat-delete-conversation: DELETE /api/conversations/:id — a real, irreversible write. The exec
  // token is checked once in requestListener (N6 fix), before handleApi is ever reached. Order:
  // id shape (400) -> real existence (404) -> a currently-running execution for this conversation
  // (409 — never pull a file out from under a live child process/append) -> the actual delete.
  // conversations.mjs's own deleteConversation() re-validates id+containment again internally
  // (defense in depth); this route never builds a path itself.
  if (convItemMatch && req.method === 'DELETE') {
    const convId = convItemMatch[1];
    if (!safeConvIdOk(convId)) return sendJson(res, 400, { ok: false, error: 'invalid conversation id' });
    if (!conversationExists(convId)) return sendJson(res, 404, { ok: false, error: 'conversation not found' });
    if (isConversationBusy(convId)) {
      return sendJson(res, 409, { ok: false, error: 'conversation has a pending execution — stop it before deleting' });
    }
    const result = deleteConversation(convId);
    if (!result.ok) return sendJson(res, result.error === 'conversation not found' ? 404 : 400, result);
    return sendJson(res, 200, { ok: true, deleted: true, id: convId });
  }

  const convMessagesMatch = pathname.match(CONV_MESSAGES_RE);
  if (convMessagesMatch && req.method === 'POST') {
    if (!checkRateLimit('conversationMessage', res)) return;
    const convId = convMessagesMatch[1];
    if (!safeConvIdOk(convId) || !conversationExists(convId)) {
      return sendJson(res, 404, { ok: false, error: 'conversation not found' });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err instanceof BodyTooLargeError ? 413 : 400, { ok: false, error: err.message });
    }
    const schemaErr = validateSchema(body, ['text', 'mode', 'effort', 'model'], ['text']);
    if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return sendJson(res, 400, { ok: false, error: 'text must be a non-empty string' });
    }
    // fix-sec-round #4 (LOW): body.text becomes the CLI's positional [prompt] argument right after
    // the boolean -p/--print flag (exec-bridge.mjs's buildRealArgs) — reject a leading '-' outright
    // rather than risk it being parsed as another flag. See isUnsafeExecPromptText's own comment
    // for why "reject" was chosen over a "--" separator.
    if (isUnsafeExecPromptText(body.text)) {
      return sendJson(res, 400, { ok: false, error: 'text cannot start with "-" (would be parsed as a CLI flag by the spawned claude process)' });
    }
    // cc-fix-chat-identity / fix-exec-modes: optional execution mode (real `claude --permission-mode
    // <...>`, see EXEC_MODE_VALUES above). Strict allowlist — an omitted `mode` defaults to
    // 'execute', anything outside the allowlist is a real 400, never silently coerced.
    if (body.mode !== undefined && !EXEC_MODE_VALUES.includes(body.mode)) {
      return sendJson(res, 400, { ok: false, error: 'mode must be one of: ' + EXEC_MODE_VALUES.join(', ') });
    }
    const mode = EXEC_MODE_VALUES.includes(body.mode) ? body.mode : 'execute';
    // fix-exec-modes: optional effort level (real `claude --effort <...>`, see EXEC_EFFORT_VALUES
    // above) — same allowlist-or-400 pattern as `mode`. Omitted entirely means no --effort flag is
    // ever added (never defaulted/guessed).
    if (body.effort !== undefined && !EXEC_EFFORT_VALUES.includes(body.effort)) {
      return sendJson(res, 400, { ok: false, error: 'effort must be one of: ' + EXEC_EFFORT_VALUES.join(', ') });
    }
    const effort = EXEC_EFFORT_VALUES.includes(body.effort) ? body.effort : undefined;
    // feat-model-picker: optional model choice (real `claude --model <...>`, see EXEC_MODEL_VALUES
    // above) — same allowlist-or-400 pattern as `mode`/`effort`. Omitted entirely means no --model
    // flag is ever added (the CLI's own default), never guessed at.
    if (body.model !== undefined && !EXEC_MODEL_VALUES.includes(body.model)) {
      return sendJson(res, 400, { ok: false, error: 'model must be one of: ' + EXEC_MODEL_VALUES.join(', ') });
    }
    const model = EXEC_MODEL_VALUES.includes(body.model) ? body.model : undefined;
    // N6 fix (WP-C1): every mode, including 'plan', now requires the per-boot exec token — checked
    // once in requestListener, before handleApi is ever reached (security.mjs's own
    // EXEC_TOKEN_HEADER/execTokenOk comment has the full "any local process without a browser can
    // otherwise POST a real write with no auth at all" rationale). The previous 'plan'-mode
    // exemption assumed a plan send "starts no write of its own", but the user's turn is ALWAYS
    // persisted to the conversation store first (appendUserTurn, below) regardless of mode — that
    // is itself a real write, so there was never a mode that genuinely needed to skip this check.
    // Duplicate-send protection: reject BEFORE touching the store — a second send while one
    // turn is still pending is genuinely invalid input, not a message worth persisting.
    if (isConversationBusy(convId)) {
      return sendJson(res, 409, { ok: false, error: 'conversation already has a pending execution' });
    }

    const conv = readConversation(convId);
    const projectName = conv.ok && conv.meta ? conv.meta.project : null;
    const { entry, registryError } = await resolveProjectByName(projectName || '');
    if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
    if (!entry) return sendJson(res, 404, { ok: false, error: 'conversation project no longer in the registry: ' + projectName });

    // The user's message is ALWAYS persisted first — even if execution cannot start (gateway-wide
    // capacity, missing CLI), a real user turn is never silently dropped (D2 amendment 3: "a
    // degraded but truthful product beats a fake send button").
    const { turnId, requestId } = appendUserTurn(convId, body.text, { mode, effort, model });
    const startResult = startExecution({ convId, turnId, requestId, text: body.text, cwd: entry.path, mode, effort, model });
    if (!startResult.started) {
      appendConversationEvent(convId, { turn_id: turnId, request_id: requestId, kind: 'execution_not_started', data: { reason: startResult.reason } });
    }
    return sendJson(res, 202, {
      ok: true,
      turn_id: turnId,
      request_id: requestId,
      execution_started: startResult.started,
      reason: startResult.started ? undefined : startResult.reason,
    });
  }

  // build-lastdemos T3: real attachment upload — a single multipart "file" field, stored under
  // .data/attachments/<convId>/ (attachments.mjs). Never touches .claude/.
  const convAttachmentsMatch = pathname.match(CONV_ATTACHMENTS_RE);
  if (convAttachmentsMatch && req.method === 'POST') {
    const convId = convAttachmentsMatch[1];
    if (!safeConvIdOk(convId) || !conversationExists(convId)) {
      return sendJson(res, 404, { ok: false, error: 'conversation not found' });
    }
    const contentType = req.headers['content-type'] || '';
    let raw;
    try {
      raw = await readRawBody(req);
    } catch (err) {
      return sendJson(res, err instanceof AttachmentTooLargeError ? 413 : 400, { ok: false, error: err.message });
    }
    const parsed = parseMultipart(raw, contentType);
    if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });
    const filePart = parsed.fields.find((f) => f.name === 'file' && f.fileName);
    if (!filePart) return sendJson(res, 400, { ok: false, error: 'missing multipart field "file" with a filename' });
    let stored;
    try {
      stored = storeAttachment({ convId, fileName: filePart.fileName, data: filePart.data });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: 'could not store the attachment: ' + (err && err.message ? err.message : String(err)) });
    }
    return sendJson(res, 201, {
      ok: true,
      attachment: {
        id: stored.id,
        fileName: stored.fileName,
        size: stored.size,
        isText: stored.isText,
        textPreview: stored.textPreview,
        textTruncated: stored.textTruncated,
        storedPath: stored.storedPath,
      },
    });
  }

  const convStopMatch = pathname.match(CONV_STOP_RE);
  if (convStopMatch && req.method === 'POST') {
    const convId = convStopMatch[1];
    if (!safeConvIdOk(convId) || !conversationExists(convId)) {
      return sendJson(res, 404, { ok: false, error: 'conversation not found' });
    }
    const result = stopExecution(convId);
    return sendJson(res, 200, { ok: true, stopped: result.stopped });
  }

  // feat-ask-owner: POST /api/ask — called by the ask-mcp.mjs MCP subprocess (a spawned local
  // process, never a browser) to register a real question set and BLOCK (this handler simply does
  // not respond) until the owner answers via POST /api/ask/:id/answer below, or the ask-store's
  // own timeout fires. Same exec-token requirement as every other real write route (checked once in
  // requestListener, N6 fix): only a process that was actually handed this boot's token (the
  // mcp-config's own env, exec-argv.mjs) may open a new ask.
  if (pathname === '/api/ask' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err instanceof BodyTooLargeError ? 413 : 400, { ok: false, error: err.message });
    }
    const schemaErr = validateSchema(body, ['conv_id', 'turn_id', 'request_id', 'questions'], ['conv_id', 'questions']);
    if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
    if (typeof body.conv_id !== 'string' || !safeConvIdOk(body.conv_id) || !conversationExists(body.conv_id)) {
      return sendJson(res, 404, { ok: false, error: 'conversation not found' });
    }
    const turnId = typeof body.turn_id === 'string' && body.turn_id.length > 0 ? body.turn_id : null;
    const requestId = typeof body.request_id === 'string' && body.request_id.length > 0 ? body.request_id : null;
    const created = createAskRequest({ convId: body.conv_id, turnId, requestId, questions: body.questions });
    if (!created.ok) return sendJson(res, 400, { ok: false, error: created.error });

    appendConversationEvent(body.conv_id, {
      turn_id: created.turnId,
      request_id: created.requestId,
      kind: 'ask_questions',
      data: { id: created.id, questions: created.questions, timeout_ms: created.timeoutMs },
    });

    // fix-ghost-asks item 4: this conv's own exec-timeout reaper is not "wedged" logic while it is
    // genuinely waiting on an answer WE just asked the owner for — pause it for exactly the ask's
    // own real timeout window (never longer; see pauseExecTimeoutForAsk's own header for the full
    // bounded-cap rationale). A no-op when this convId has no running execution right now (e.g. a
    // test that creates an ask directly via ask-store, or a future non-exec caller of /api/ask).
    pauseExecTimeoutForAsk(body.conv_id, created.timeoutMs);

    const outcome = await created.promise; // the real block — resolves on a real answer, the honest timeout, or an abandonment below
    // Resumes the paused reaper regardless of outcome — a no-op when the execution already ended
    // (the common case for `outcome.abandoned`, since that is exactly what ended it).
    resumeExecTimeoutAfterAsk(body.conv_id);

    if (outcome.timed_out) {
      appendConversationEvent(body.conv_id, { turn_id: created.turnId, request_id: created.requestId, kind: 'ask_timed_out', data: { id: created.id } });
      return sendJson(res, 200, {
        ok: true,
        timed_out: true,
        note: 'the owner did not answer within the time limit (' + created.timeoutMs + 'ms) — no answer was fabricated',
      });
    }
    if (outcome.abandoned) {
      // fix-ghost-asks item 1: the execution that opened this ask already ended (stopped, closed,
      // errored, or reaped) — exec-lifecycle.mjs already appended the real `ask_abandoned`
      // conversation event the moment it called abandonPendingAsksForConversation() (see that
      // file's own `abandonPendingAsk()` helper), so this handler's only remaining job is to let
      // the blocked HTTP call settle instead of hanging until the ask's own real timeout. The
      // underlying ask-mcp.mjs client is very likely ALREADY dead too (it is a child of the process
      // tree that was just killed) — writing the response here is best-effort only, never
      // something any caller waits on.
      try {
        return sendJson(res, 200, {
          ok: true,
          abandoned: true,
          reason: outcome.reason,
          note: 'the execution ended before the owner answered — no answer was fabricated',
        });
      } catch {
        return undefined;
      }
    }
    return sendJson(res, 200, { ok: true, timed_out: false, answers: outcome.answers });
  }

  // feat-ask-owner: POST /api/ask/:id/answer — the dashboard's real owner-answer submission. Same
  // exec-token requirement as every other real write route (checked once in requestListener, N6
  // fix). ask-store.mjs owns every remaining 400/404/409/200 outcome (strict shape check,
  // unknown/already-resolved id).
  const askAnswerMatch = pathname.match(ASK_ANSWER_RE);
  if (askAnswerMatch && req.method === 'POST') {
    let askId;
    try { askId = decodeURIComponent(askAnswerMatch[1]); } catch { return sendJson(res, 400, { ok: false, error: 'invalid ask id' }); }
    if (!safeIdOk(askId)) return sendJson(res, 400, { ok: false, error: 'invalid ask id' });
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, err instanceof BodyTooLargeError ? 413 : 400, { ok: false, error: err.message });
    }
    const schemaErr = validateSchema(body, ['answers'], ['answers']);
    if (schemaErr) return sendJson(res, 400, { ok: false, error: schemaErr });
    const result = answerAskRequest(askId, body.answers);
    if (!result.ok) return sendJson(res, result.status, { ok: false, error: result.error });
    appendConversationEvent(result.convId, { turn_id: result.turnId, request_id: result.requestId, kind: 'ask_answered', data: { id: askId, answers: result.answers } });
    return sendJson(res, 200, { ok: true, answered: true, id: askId });
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

// Handles GET /api/conversations/:id/stream — same shape as handleEventsStream above: takes over
// `res` for a long-lived SSE response after the same access-control checks every other route gets.
async function handleConversationStream(req, res, convId) {
  if (!safeConvIdOk(convId) || !conversationExists(convId)) {
    return sendJson(res, 404, { ok: false, error: 'conversation not found' });
  }
  attachConversationStream({ req, res, convId });
}

// Handles the one streaming route separately: it must take over `res` for a long-lived
// text/event-stream response, never funnel through sendJson()'s single JSON-object shape. Still
// runs through the EXACT same allowlist/containment checks as every other route above.
async function handleEventsStream(req, res, searchParams) {
  const projectName = searchParams.get('project') || '';
  const runId = searchParams.get('run') || '';
  if (!safeIdOk(runId)) return sendJson(res, 400, { ok: false, error: 'invalid or missing ?run=<id>' });
  const { entry, registryError } = await resolveProjectByName(projectName);
  if (registryError) return sendJson(res, 502, { ok: false, error: registryError });
  if (!entry) return sendJson(res, 404, { ok: false, error: 'unknown project (must match /api/projects)' });
  attachEventsStream({ req, res, projectPath: entry.path, runId });
}

export function requestListener(req, res) {
  let parsed;
  try { parsed = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('bad request'); }
  const pathname = parsed.pathname;

  if (!hostOk(req)) {
    return sendJson(res, 403, { error: 'forbidden host — gateway is localhost-only (DNS-rebinding blocked)' });
  }
  // WP10 should-fix-now #11 (root-cause fix for AP-4/AP-13): this guard used to apply ONLY to
  // /api/* paths, leaving the static surface reachable from a cross-site <img>/<iframe> with no
  // guard at all — that gap is what made AP-4's decodeURIComponent crash and AP-13's frameable
  // clickjacking target reachable cross-origin in the first place. A normal top-level navigation
  // sends Sec-Fetch-Site: none (or omits the header entirely on older clients) and every
  // same-origin asset load sends same-origin — both already pass crossSiteOk() unchanged — so
  // extending it to every path blocks only genuinely cross-site requests, never real browsing.
  // Verified against a real headless-Chrome load of the built dashboard (see this WP's report).
  if (!crossSiteOk(req)) {
    if (pathname.startsWith('/api/')) return sendJson(res, 403, { error: 'cross-site request blocked' });
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...STATIC_SECURITY_HEADERS });
    return res.end('cross-site request blocked');
  }

  // WP4: exactly 3 conversation routes accept POST (create / send message / stop); every other
  // route on this gateway remains read-only, unchanged from WP1-WP3. build-newproject adds one
  // more: POST /api/projects (the real "New project" button). build-lastdemos T3 adds a 4th
  // conversation write route: POST /api/conversations/:id/attachments (the real "Attach" upload).
  // feat-delete-conversation adds the one DELETE route this gateway accepts at all: DELETE
  // /api/conversations/:id — scoped to CONV_ITEM_RE specifically, never the bare
  // '/api/conversations' collection path (a DELETE there stays a real 405, unchanged).
  const isConversationWriteRoute =
    pathname === '/api/conversations' ||
    CONV_MESSAGES_RE.test(pathname) ||
    CONV_STOP_RE.test(pathname) ||
    CONV_ATTACHMENTS_RE.test(pathname);
  // feat-ask-owner: two more real POST write routes — ASK_RE (the ask-mcp.mjs subprocess
  // registering a question) and ASK_ANSWER_RE (the dashboard's own real answer submission).
  const isAskWriteRoute = ASK_RE.test(pathname) || ASK_ANSWER_RE.test(pathname);
  // WP-D1: the two real Discord-bot write routes (GET /api/discord/status stays read-only, unlisted
  // here, exactly like every other GET route on this gateway).
  const isDiscordWriteRoute = pathname === '/api/discord/start' || pathname === '/api/discord/stop';
  const isWriteRoute = isConversationWriteRoute || isAskWriteRoute || isDiscordWriteRoute || pathname === '/api/projects';
  const isConversationDeleteRoute = CONV_ITEM_RE.test(pathname);
  // feat-agent-model-edit: the one PATCH route this gateway accepts at all, scoped exactly to
  // AGENT_MODEL_RE (same "one specific route, never the whole method" shape as the DELETE guard
  // above for conversations).
  const isAgentModelPatchRoute = AGENT_MODEL_RE.test(pathname);
  if (
    req.method !== 'GET' &&
    !(req.method === 'POST' && isWriteRoute) &&
    !(req.method === 'DELETE' && isConversationDeleteRoute) &&
    !(req.method === 'PATCH' && isAgentModelPatchRoute)
  ) {
    if (pathname.startsWith('/api/')) return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    res.writeHead(405, STATIC_SECURITY_HEADERS); return res.end('method not allowed');
  }

  // N6 fix (WP-C1, 2026-09-26 laptop re-audit): the exec token is now checked EXACTLY ONCE, here,
  // for every non-GET request, before any route-specific logic runs (body parsing, project lookup,
  // conversation-existence checks). This replaces the old per-route execTokenOk() calls that used
  // to be scattered through handleApi below — each real write route needed its OWN copy of the
  // same check, and four of them (POST /api/conversations, POST /api/projects, POST .../stop, POST
  // .../attachments) simply never got one (audit finding N6/C2). It also removes the previous
  // 'plan'-mode exemption on POST .../messages: every non-GET request persists something (even a
  // 'plan' send appends the user's turn to the conversation store — see the messages route below),
  // so there is no write route left that legitimately needs to skip this check. GET (including the
  // two SSE-stream GET routes) is unaffected — reads never required the token and still don't.
  if (req.method !== 'GET' && !execTokenOk(req)) {
    return sendJson(res, 403, { ok: false, error: 'missing or invalid execution token (' + EXEC_TOKEN_HEADER + ' header)' });
  }

  if (pathname === '/api/events/stream') {
    handleEventsStream(req, res, parsed.searchParams).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error: ' + (err && err.message ? err.message : String(err)) });
    });
    return;
  }

  const convStreamMatch = pathname.match(CONV_STREAM_RE);
  if (convStreamMatch && req.method === 'GET') {
    handleConversationStream(req, res, convStreamMatch[1]).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error: ' + (err && err.message ? err.message : String(err)) });
    });
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, parsed.searchParams).catch((err) => {
      sendJson(res, 500, { ok: false, error: 'internal error: ' + (err && err.message ? err.message : String(err)) });
    });
    return;
  }

  const staticResult = serveStatic(pathname);
  if (!staticResult) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...STATIC_SECURITY_HEADERS });
    return res.end('Forge Command Center gateway is running, but dashboard/dist has not been built yet.\nRun: npm run build (inside command-center/dashboard)\n');
  }
  res.writeHead(staticResult.status, staticResult.headers);
  res.end(staticResult.body);
}

export function createServer() {
  return http.createServer(requestListener);
}
