/**
 * Forge Command Center — the gateway adapter.
 *
 * WP7b. This is the ONE new seam the integration plan (`T7-integration-plan.md`
 * §b) calls for: it maps this project's own real gateway (`command-center/gateway`,
 * REST + SSE, `127.0.0.1:4100`) onto the exact view-facing shapes the thirteen
 * views already render (`PrototypeDataset` / `ConnectionState`), the same way
 * `store-adapter.ts` already maps the (unused, this phase) bridge's `LiveState`
 * onto those shapes. No view, no component markup, and no CSS changes anywhere
 * in this file's reach — only the data/connection layer.
 *
 * TRANSPORT CHOICE (read `live-store.ts` and `prototype/state/bridge-client.ts`
 * first, then decide — exactly what this work package asked for):
 *
 *   1. `live-store.ts`'s `getSharedLiveStore()` opens the bridge's own 39-op
 *      WebSocket protocol (`hello`/`subscribe`/`replay`/`ack`/sequence-gap
 *      detection) — a reliability layer purpose-built around the BRIDGE's own
 *      per-stream, sequence-numbered JSONL log. Recreating that on this
 *      gateway would mean building sequence/gap/replay semantics our simpler,
 *      already-tested flat/offset event log has no need for.
 *   2. This gateway already serves two real SSE streams
 *      (`/api/events/stream`, `/api/conversations/:id/stream`, both with
 *      `Last-Event-ID` byte-offset resume) — enough to "watch real streamed
 *      output" without a new WebSocket server on the gateway side.
 *   3. REST + SSE needs zero new gateway transport code (only new read-model
 *      endpoints), keeps exactly one process ever spawning `claude`
 *      (`exec-bridge.mjs`), and reaches the network the SAME documented way
 *      `bridge-client.ts` already does (`globalThis.fetch`/`globalThis.EventSource`,
 *      a hardcoded loopback literal) — so the existing offline-only ESLint
 *      guard and `no-runtime-contact.test.ts`'s loopback scan need no changes.
 *
 * HONESTY RULES — identical in spirit to `store-adapter.ts`'s own three rules,
 * because this is the same seam for a different backend:
 *
 *   1. NEVER FABRICATE A ROW. A project/run/agent/task/event here is real,
 *      derived from a real gateway response, or the collection is empty.
 *   2. NEVER FABRICATE A STATUS. Every `StatusKey` is derived from a real field
 *      the gateway reported (`has_final_report`, a mission task's own real
 *      `status`, a real `check_passed`/`check_failed` verdict) — never guessed
 *      from elapsed time or invented as a plausible default. Where nothing real
 *      says otherwise, the neutral `waiting` bucket is used (the same bucket
 *      `store-adapter.ts` uses for "exists, nothing reported yet").
 *   3. UNKNOWN ATTRIBUTES ARE SHOWN AS ABSENCE, NOT INVENTED. Fields the
 *      gateway's current endpoints do not carry (a task's progress percentage,
 *      an agent's skill list) are neutral placeholders (0 / '' / []), exactly
 *      as `store-adapter.ts` already does for the bridge path.
 *
 * WHAT IS PARTIAL, NAMED HONESTLY: `Project.conversationCount` is real for
 * every project (the conversation list is gateway-wide); `agentCount`/
 * `missionCount`/`taskCount` are real ONLY for the selected project (fetching
 * per-project agents/runs for all 15 registry entries on every poll was judged
 * not worth the added load for a registry-browsing view) — 0 for the rest,
 * never invented. `Task.progress` is always 0 (no endpoint reports a real
 * percentage). `attachments` stays on the empty/fixture path (no endpoint
 * exists yet for that GATEWAY GAP).
 *
 * cc-wire-views UPDATE — `Files` is now wired for real. `FilesView.tsx` no
 * longer needs a synchronous, already-complete tree: this WP's own scope is
 * exactly "edit `FilesView.tsx` to fetch-per-directory", so the lazy real
 * `GET /api/files` / `GET /api/files/read` pair now flows in through a new
 * sibling file, `gateway-files.ts` (mirrors `gateway-chat.ts`'s own
 * Context/controller shape for "a view needs to TRIGGER a fetch, not just
 * read a polled snapshot"). `useGatewayDataset` takes the resulting tree as a
 * parameter rather than building it itself, so this file's own diff stays a
 * single wiring point — see `gateway-files.ts`'s header for the full design
 * and its three honesty rules (never fabricate a row, no invented change
 * markers, "not yet expanded" vs "loaded and empty" stay distinct).
 *
 * `Recovery` / `Checkpoints` / `Approvals` — UPDATE (wire-recovery, this run):
 * now MOUNTED, but still outside `PrototypeDataset`, so correcting this
 * comment rather than leaving it stale: `ApprovalsMeta.tsx` (Mission Control)
 * and `RecoveryPanel.tsx` (Activity) consume `gateway-recovery.ts`'s parsers +
 * poll hooks DIRECTLY — no `PrototypeDataset` field carries them, and no
 * dedicated `ApprovalsView`/`RecoveryView`/`CheckpointsView` file exists. The
 * earlier candidate slot considered — folding a `quality_gate_blocked`
 * evaluation into Home's existing "Failures and blockers" list — was rejected
 * for the reasons kept below; the actual wiring took a different, real path
 * instead of that rejected one.
 *
 * (Original rejection reasoning, kept for the record): that list's real,
 * working data source (agents/projects/gates already in this dataset) is a
 * different concept than a hard-gate POLICY evaluation, live evaluations were
 * empty in every run in this fleet at the time (so the change would have been
 * visually unverifiable), and the prior WP8 Build Boss reached the same
 * conclusion independently.
 *
 * cc-fix-adapter (WP-A fix round) UPDATE — kills the invented scalars the
 * audit found in this file (`:612` fixed `type`, `:620-623` zeroed health/
 * taskCount, `:657-665` zeroed agent progress/skills/verification, `:718`
 * zeroed task progress, `:923-926` empty gate duration/output, `:941` empty
 * artifact size, `:1185` only `runRows[0]` mapped). Every fix below either
 * feeds a REAL gateway value through, or leaves the field honestly empty/0 —
 * documented per-field, never swapping one fabricated default for another:
 *
 *   - Project `taskCount`/`health.tests`/`score` are now real for the ACTIVE
 *     project (mission task count; `doctor.json`'s real suites/passed/failed
 *     via `/api/proof`'s already-existing 'doctor' verdict, previously
 *     computed but never surfaced here) — 0 for every other project, same
 *     "real only for the selected project" precedent this file already uses
 *     for `agentCount`/`missionCount`. `description`/`templateVersion` are
 *     real for the active project via the new `GET /api/projects/:name/profile`
 *     endpoint (T6d). `openTickets`/`blockers` stay 0 — genuinely no data
 *     source exists anywhere in this gateway for either (no ticket/blocker
 *     registry is integrated); this is a named gap, not a silent one.
 *   - `type: ProjectType` — FIXED in cc-wire-usage: `ProjectType` now carries a
 *     9th `'unknown'` member (`prototype/types/prototype-types.ts`), and
 *     `classifyProjectType()` below maps the active project's real
 *     `/api/projects/:name/profile` field onto it — an EXACT match to one of
 *     the 8 named types only; a compound/free-text description (this
 *     project's own real profile is "tooling / meta — ... Mixed.") or no
 *     profile stays honestly `'unknown'`, never a keyword-guessed default.
 *     Every other project row still gets `'unknown'` too (same "real only for
 *     the selected project" precedent this file already applies elsewhere).
 *   - Agent `skills` (from the new `GET /api/agents` `skills[]`, T6a),
 *     `verification` (derived from this run's real per-agent `check_passed`/
 *     `check_failed` verdicts — previously discarded at the `agent` field on
 *     `MissionVerdictRow`) and `progress` (real completed/total task ratio for
 *     that agent in this run) are now real. `permission` is now derived from
 *     the real `class` field (`agent-tool-policy.json`) instead of the boolean
 *     `is_permanent_boss` per this fix round's explicit instruction — the
 *     visible side effect (no agent ever renders 'lead' any more, since none
 *     of the 4 real class values map to it) is called out in the handoff, not
 *     silently shipped.
 *   - `Task.progress` is now 100 for a completed task, 0 otherwise (a real
 *     status-derived signal — still no endpoint reports a true percentage).
 *   - ALL real runs are now mapped into `PrototypeDataset.runs`, not just the
 *     newest one — the newest run keeps driving the existing
 *     mission/proof/events detail fetches (a "selected run" concept a picker
 *     could later expose in state), every other run gets an honest partial
 *     `Run` (status from its own real `has_final_report`, empty goal/
 *     work-package-ids/agent-ids — never fabricated, matches this file's own
 *     existing partial-data precedent).
 *   - Gate `output` (T6b: the real event `output` field proof.mjs now
 *     forwards) and artifact `size` (T6b: a real byte count, `stat()`'d
 *     server-side, formatted via `gateway-files.ts`'s own `formatFileBytes`)
 *     are real where the source has them. Gate `duration` stays '' — no
 *     per-check start/end timestamp pair exists anywhere in this gateway
 *     (a named, unimplemented orchestrator-instrumentation gap, matching the
 *     audit's own P3-6).
 *   - `wp_guess_confidence` — FIXED in cc-wire-usage: `Task` now carries an
 *     optional `wpGuessConfidence` field (`prototype/types/prototype-types.ts`)
 *     and `toGatewayTask` maps `MissionTaskRow.wpGuessConfidence` straight onto
 *     it. Display (where task/work-package confidence is shown in a view) is a
 *     named handoff — no view file is in this round's write scope.
 *   - Recency: `agoMinutes()` — the human-relative-label parser the audit
 *     flagged — lives in `ProjectsView.tsx`/`HomeView.tsx`, not in this file
 *     (`src/views/**` is out of this round's write scope). This file's own
 *     contribution was ensuring the REAL field those views sort on
 *     (`Project.lastActivity`) carried a real ISO timestamp (the active
 *     project's current run `mtime`) instead of always `''`.
 *     SUPERSEDED by cc-fix-events-honesty below (P2-9): that raw ISO string was
 *     landing verbatim in five ~9-character render boxes never built for a
 *     24-character timestamp — `formatRelativeTime()` now formats it at this
 *     one real source instead, in the exact "<digits> <space> <unit word>"
 *     shape `agoMinutes()`'s own documented fixture-only fallback already
 *     parses, so both views' "Recent" sort stays correct without editing
 *     either file. Their own header comments ("a real ISO timestamp in
 *     production — parsed directly") are now stale in the same way this
 *     paragraph itself just was — a named handoff, since `src/views/**` stays
 *     out of this round's write scope too.
 *
 * cc-fix-events-honesty (forge-2026-07-29-cc-finish, WP fix-events-honesty) UPDATE — closes five
 * honesty gaps the Lead's own discovery pass found, all client-side (no gateway edit needed):
 *
 *   - P1-1: `truncated`/`malformed_lines` (`events.mjs:180,184`) were parsed off every
 *     `/api/events` response and discarded (`pickArray(result.data, ['events'])` alone) — Activity
 *     showed "N/N events" over a timeline the gateway itself had already marked incomplete.
 *     `useGatewayEvents` now returns a `GatewayEventsState` carrying both, and the new
 *     `useGatewayEventsMeta` lets `ActivityView` read them without `PrototypeDataset` (frozen,
 *     out of this round's write scope) needing a new field.
 *   - P1-3: `server.mjs`'s real `?after=`/`next_after` incremental protocol existed and was never
 *     used — every SSE frame re-triggered a full O(n) history re-read (O(n^2) bytes over a run).
 *     `createEventsAccumulator()` now keeps the cursor and appends deltas; `createCoalescedRunner`
 *     (unchanged) still serializes poll vs. SSE the same way it always did.
 *   - P1-6: `duration_source` (`:701`) was parsed and never read — `formatDurationWithSource()`
 *     now qualifies a `'derived-from-events'` estimate so it never renders identically to a real
 *     `'run-completed-event'` measurement.
 *   - P2-9: see the superseded paragraph directly above.
 *   - P3-13: `deriveRunStatus()` checked `hasFinalReport` BEFORE a real per-task `failed` verdict,
 *     so a run with both silently reported `'completed'` — order swapped, `failed` now wins.
 *
 * cc-wire-usage (WP: wire the Claude usage bar to real data) UPDATE — two
 * additions purpose-built so `UsageBar.tsx`/`gateway-usage.ts` can stop
 * depending on the bridge's own dead `getUsageState`/`useLatency` (the
 * `src/bridge/**` WebSocket that `live-store.ts`'s own header already
 * documents as constructed-but-never-connected):
 *
 *   - `GatewayConnectionStore` now measures a REAL client-side round-trip on
 *     its own existing `/api/health` poll (no new network traffic — the poll
 *     already happens every `HEALTH_POLL_MS`) and keeps a small rolling
 *     window (`LATENCY_WINDOW` samples) to compute a real p95. `useGatewayLatency()`
 *     exposes it. A negative/non-finite delta is REJECTED, never clamped to a
 *     fake 0 — the same "a broken sample is proof of clock trouble, not a
 *     perfect measurement" principle `bridge/usage/latency.ts` documents,
 *     reimplemented locally here (no runtime import of that dead-bridge file).
 *   - `classifyProjectType()` is the honest `ProjectType` mapper the header
 *     above already describes — exported so `toGatewayProject`'s new `type`
 *     parameter (optional, defaults to `'unknown'` so the pre-existing
 *     `gateway-adapter-antifabrication.test.ts` calls keep compiling
 *     unmodified) has a single, testable seam.
 *
 * cc-fix-dash-latency (forge-2026-07-29-cc-finish, WP fix-dash-latency) UPDATE — three additions
 * that consume cc-fix-gateway-perf's gateway-side handoff (its own edits stayed inside `gateway/`,
 * out of THIS work package's write scope, so nothing below touches that directory):
 *
 *   1. `GatewayConnectionStore.poll()` no longer makes a second `GET /api/conversations` request
 *      purely to read its `execution` field — `/api/health` now carries the identical field/shape
 *      (verified live before relying on it), so `parseExecutionAvailability(health.data)` reads it
 *      straight off the health response this poll already made. One fewer request per 5s tick.
 *   2. `PROJECTS_POLL_MS` dropped from 15000 to 2500 (see its own comment for the full worst-case
 *      derivation) now that the server-side registry TTL is 5s, not 30s — keeps a new project's
 *      worst-case time-to-visible at 7.5s, inside the 10s Nielsen threshold with real margin.
 *   3. `RunRow.eventScanError` + `useGatewayRunScanErrors()` surface `runs.mjs`'s new
 *      `event_scan_error` honesty signal (a run whose events.jsonl genuinely could not be read, as
 *      opposed to the honest "doesn't exist yet" empty state) — mirrors the existing
 *      `useGatewayEventsMeta` precedent (a small dedicated hook, `Run`/`PrototypeDataset` stay
 *      frozen) rather than inventing a new pattern.
 *
 * fix-cert-rest (forge-2026-07-29-cc-finish, WP fix-cert-rest) UPDATE — closes the two named
 * "same fabrication as F3, not yet fixed" gaps the prior fix round's own honest handoff left open:
 *
 *   1. `Project.taskCount` / `ProjectHealth.score` are WIDENED to `number | null`
 *      (`prototype-types.ts`) — the placeholder this file emits for a project it has not measured
 *      (every project that is not the active one) is now a real, typed `null`, not a `0` a
 *      genuinely-measured empty project could also produce. `agentCount`/`missionCount` stay a
 *      shared, non-nullable `number` (widening them is real, tracked follow-up — see this round's
 *      own handoff) — `ProjectsView.tsx` keeps gating THEM through `hasMeasuredProjectDetail`.
 *   2. `Agent.verification`'s previous blanket `'not-required'` fallback (whenever no
 *      `check_passed`/`check_failed` verdict exists for an agent in this run) conflated two
 *      different real things: "this role genuinely never needs verification" (a claim about the
 *      ROLE — no live source in this gateway reports it; only fixture/example data may assert the
 *      literal `'not-required'`) and "no verification evidence exists for this agent in this run"
 *      (a genuine, honest absence). The fallback is now `null` — see `Agent.verification`'s own
 *      updated doc comment.
 *
 * cc-fix-artifacts-empty (forge-2026-07-29-cc-finish, WP fix-artifacts-empty) UPDATE — closes a
 * live-measured bug (Test Boss): Artifacts showed 0/0 for ALL 18 fleet projects because `artifacts`
 * was built from `proofPayload` — `useGatewayProof(activeProjectId, currentRunId)`, tied to the
 * SINGLE newest run — and a project's newest run is very often exactly the one with nothing in it
 * yet, while older runs and the project-wide `.claude/forge-artifacts/` index carry real evidence.
 * `artifacts` now comes from a SEPARATE new fetch, `useGatewayProofAll(activeProjectId)` (`GET
 * /api/proof?run=all`, gateway/src/proof.mjs's new `buildProofAll`, bounded to the last ~10 runs) —
 * `proofPayload` itself is untouched and keeps driving `proof`/`gates` exactly as before (a verdict
 * is genuinely a fact about ONE run, unlike an artifact). Every artifact keeps its real run/source
 * label (`toGatewayArtifact`'s `producedBy`, see its own updated comment) so aggregating several
 * runs' worth of artifacts never reads as "all of this belongs to the current run".
 *
 * refactor-adapter-split (forge-2026-07-29-cc-finish) UPDATE — this file was ~2400 lines, over the
 * project's own 500-line-per-file guidance, mixing the connection store, latency, account usage,
 * row parsers, status derivation, view mappers, activity timeline, mission graph, proof/gates/
 * artifacts, per-resource polling hooks, and chat-runs together. Pure structural split, ZERO
 * behavior change: the real code now lives in `state/adapter/{shared,connection,rows,mappers,
 * graph-and-proof,polling-hooks,chat-runs,dataset}.ts`, split along the sections this file's own
 * numbered comment markers already named (see each sibling file's own header for exactly which
 * section(s) it carries and why). This file is now a pure re-export façade: every name below is
 * exported under its EXACT original name and signature, so no other file in the codebase needed to
 * change a single import.
 */

export type { GatewayLatency, GatewayGuardState, GatewayAccountUsage } from './adapter/connection';
export {
  GatewayConnectionStore,
  HEALTH_POLL_MS,
  useGatewayConnection,
  useGatewayLatency,
  useGatewayClaudeCodeHealth,
  parseAccountUsage,
  useGatewayAccountUsage,
} from './adapter/connection';

export type { ProjectRow, RunRow, AgentRow, MissionTaskRow, MissionVerdictRow, MissionPayload } from './adapter/rows';
export {
  buildAgentVerificationMap,
  resolveAgentVerification,
  buildAgentProgressMap,
  formatDurationMs,
  formatDurationWithSource,
  formatRelativeTime,
} from './adapter/rows';

export type { ActiveProjectDetail } from './adapter/mappers';
export {
  EMPTY_ACTIVE_PROJECT_DETAIL,
  classifyProjectType,
  toGatewayProject,
  hasMeasuredProjectDetail,
  toGatewayAgent,
  toGatewayTask,
} from './adapter/mappers';

export { toGatewayGate, toGatewayArtifact, parseDoctorHealth } from './adapter/graph-and-proof';

export type { GatewayProjectProfile, GatewayEventsState } from './adapter/polling-hooks';
export {
  useGatewayRunScanErrors,
  EMPTY_PROJECT_PROFILE,
  parseProjectProfile,
  PROJECTS_POLL_MS,
  createCoalescedRunner,
  foldGatewayEventsResponse,
  createEventsAccumulator,
  useGatewayEvents,
  useGatewayEventsMeta,
} from './adapter/polling-hooks';

export type {
  ChatRunTodoRow,
  ChatRunFileEditRow,
  ChatRunRow,
  ChatRunDiffState,
  ChatRunArtifactDiff,
} from './adapter/chat-runs';
export {
  parseChatRunRows,
  useGatewayChatRuns,
  chatRunStatusToStatusKey,
  toGatewayChatRunTasks,
  toGatewayChatRunArtifacts,
  readChatRunArtifactDiff,
} from './adapter/chat-runs';

export { buildGatewayRuns, useGatewayDataset } from './adapter/dataset';
