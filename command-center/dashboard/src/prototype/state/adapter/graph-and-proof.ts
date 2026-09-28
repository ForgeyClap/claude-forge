/**
 * Forge Command Center — gateway adapter, mission graph + proof/gates/artifacts slice
 * (WP refactor-adapter-split).
 *
 * Split out of the single `gateway-adapter.ts` (was ~2400 lines) into its already-marked
 * "6. Mission graph" + "7. Proof ledger + quality gates + artifacts" sections, verbatim — see that
 * file's own header for the full architecture/history/honesty rules this slice still follows.
 * `parseDoctorHealth` moved here too: it was textually sitting under the original file's "8c.
 * Chat-runs" section header even though it parses a `/api/proof` payload, not a chat-run — a
 * mislabeling from a header never having been added when it was written, not a real chat-runs
 * concern. It reads naturally alongside `toGatewayProof`/`toGatewayGate`/`toGatewayArtifact` here,
 * which already parse the same `/api/proof` shape. `buildGatewayMissionGraph` and `toGatewayProof`
 * gained an `export` keyword they did not have in the single-file version, purely so `dataset.ts`
 * can call them across a file boundary — `gateway-adapter.ts`'s own public re-export list is
 * unchanged either way, since neither was part of it.
 */

import type { Artifact, ArtifactKind, GraphEdge, GraphLane, GraphNode, MissionGraph, ProofEntry, QualityGate, StatusKey } from '@/prototype/types/prototype-types';

import { pickArray, pickBool, pickNumber, pickRecord, pickString, pickStringArray } from '@/prototype/state/gateway-client';
import { formatFileBytes } from '@/prototype/state/gateway-files';

import { dedupeLatestByKey, EMPTY_GRAPH, STATUS_WHEN_UNKNOWN } from './shared';
import { toStatusKey, type MissionPayload, type MissionTaskRow, type MissionVerdictRow } from './rows';

/* ========================================================================== */
/*  6. Mission graph — built from the ALREADY-GROUPED /api/missions payload   */
/* ========================================================================== */

const REQUEST_COL = 0;
const BOSS_COL = 1;
const LANE_START_COL = 2;

/**
 * WP-CCD (item 4): a real check's identity, for `dedupeLatestByKey` — `command` is the strongest
 * real signal (the literal thing that was run); `check` (a readable name the gateway may report
 * distinctly from `command`) is tried first since it is the more specific label when both exist for
 * the same event. Falls back to `role`+`agent` only when neither is present, mirroring
 * `verdictIdentityRaw` below for the sibling `/api/proof` shape.
 */
function missionVerdictIdentity(v: MissionVerdictRow): string {
  // `?? null` normalizes the structurally-possible `undefined` these fields carry as OPTIONAL
  // properties (added so pre-existing hand-written `MissionVerdictRow` test literals keep
  // compiling — see that interface's own doc comment) — every real parsed row already sets each
  // to `string | null` explicitly, never `undefined`.
  const check = v.check ?? null;
  if (check !== null) return `check::${check}`;
  const command = v.command ?? null;
  if (command !== null) return `command::${command}`;
  return `role-agent::${v.role ?? ''}::${v.agent ?? ''}`;
}

/**
 * WP-CCD (item 4): collapses a run's own `mission.verdicts` to one row per real check identity,
 * keeping the LATEST result — see `shared.ts`'s `dedupeLatestByKey` for the full rationale. This is
 * what stops Mission Control's Boss/Verify nodes from reading "any check_failed ever = red" when a
 * check that failed once genuinely passed on a later retry.
 */
export function dedupeLatestMissionVerdicts(verdicts: readonly MissionVerdictRow[]): readonly MissionVerdictRow[] {
  return dedupeLatestByKey(verdicts, missionVerdictIdentity);
}

/**
 * WP-CCD (item 4): a real, explicit `integration_gate_passed`/`integration_gate_failed` event, read
 * straight off this run's OWN raw event stream (`/api/events`, unfiltered by `missions.mjs`) rather
 * than through `mission.verdicts` — `missions.mjs` does not classify this event type as a verdict
 * at all today, so waiting for that would mean this signal is invisible until a gateway change
 * lands. Raw events pass through verbatim regardless, so this reads correctly BEFORE and AFTER any
 * such gateway change — exactly this WP's own fallback contract. `present: false` (never a guessed
 * pass) when no such event exists in this run's history yet; the LATEST occurrence wins when more
 * than one exists (a retried integration gate).
 */
export interface IntegrationGateSignal {
  readonly present: boolean;
  readonly passed: boolean;
}

export const NO_INTEGRATION_GATE: IntegrationGateSignal = { present: false, passed: false };

export function readIntegrationGateSignal(rawEvents: readonly Record<string, unknown>[]): IntegrationGateSignal {
  let latest: IntegrationGateSignal = NO_INTEGRATION_GATE;
  for (const event of rawEvents) {
    const eventType = pickString(event, ['event_type']);
    if (eventType === 'integration_gate_passed') latest = { present: true, passed: true };
    else if (eventType === 'integration_gate_failed') latest = { present: true, passed: false };
  }
  return latest;
}

export function buildGatewayMissionGraph(
  runId: string,
  mission: MissionPayload | null,
  hasFinalReport: boolean,
  integrationGate: IntegrationGateSignal = NO_INTEGRATION_GATE,
  resolveAgentDisplay: (raw: string) => string = (raw) => raw,
): MissionGraph {
  if (mission === null) return EMPTY_GRAPH;

  const laneAgents: string[] = [];
  const tasksByAgent = new Map<string, MissionTaskRow[]>();
  for (const t of [...mission.tasks].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))) {
    const key = t.agent ?? ' unassigned';
    if (!tasksByAgent.has(key)) {
      tasksByAgent.set(key, []);
      laneAgents.push(key);
    }
    tasksByAgent.get(key)!.push(t);
  }

  // WP-CCD (item 4): the LATEST result per real check (never "any failure ever"), plus the run's
  // own real integration-gate signal — a check that failed once and later passed no longer keeps
  // the Boss/Verify nodes red forever, and a failed integration gate is now visible even though
  // `missions.mjs` does not (yet) classify it as a verdict at all.
  const dedupedVerdicts = dedupeLatestMissionVerdicts(mission.verdicts);
  const anyFailed = dedupedVerdicts.some((v) => v.eventType === 'check_failed') || (integrationGate.present && !integrationGate.passed);
  const anyPassed = dedupedVerdicts.some((v) => v.eventType === 'check_passed') || (integrationGate.present && integrationGate.passed);
  const verifyPresent = anyFailed || anyPassed;
  const outputPresent = hasFinalReport;

  const laneCount = laneAgents.length;
  const spineRow = laneCount > 0 ? (laneCount - 1) / 2 : 0;
  const maxTasks = laneAgents.reduce((m, key) => Math.max(m, tasksByAgent.get(key)!.length), 0);
  let tailCol = LANE_START_COL + maxTasks;
  const verifyCol = verifyPresent ? tailCol++ : null;
  const outputCol = outputPresent ? tailCol++ : null;

  const nodes: GraphNode[] = [];
  const lanes: GraphLane[] = [];
  const laneNodeIds = new Map<string, string[]>();

  const makeNode = (n: Omit<GraphNode, 'prototype'>): GraphNode => n as unknown as GraphNode;
  const makeLane = (l: Omit<GraphLane, 'prototype'>): GraphLane => l as unknown as GraphLane;
  const makeEdge = (e: Omit<GraphEdge, 'prototype'>): GraphEdge => e as unknown as GraphEdge;

  const requestId = `${runId}::request`;
  nodes.push(makeNode({ id: requestId, label: 'Request', kind: 'request', status: 'completed', col: REQUEST_COL, row: spineRow, laneId: null }));

  const bossId = `${runId}::boss`;
  const bossStatus: StatusKey = anyFailed ? 'failed' : outputPresent ? 'completed' : mission.tasks.some((t) => t.status === 'running') ? 'running' : STATUS_WHEN_UNKNOWN;
  nodes.push(makeNode({ id: bossId, label: 'Boss', kind: 'boss', status: bossStatus, col: BOSS_COL, row: spineRow, laneId: null }));

  laneAgents.forEach((agentKey, row) => {
    // WP-CCD (item 3): `agentKey` is the raw/resolved agent identity used for GROUPING (dataset.ts
    // pre-resolves it to a canonical registry slug when one matches, so name variants merge into
    // one lane) — `resolveAgentDisplay` converts that back to the SAME display text `Agent.name`
    // itself uses for the matched slug, so this label and `MissionControlView.tsx`'s own
    // `progressByAgent` (keyed by `agent.name`) always agree. An unmatched raw value (an
    // unregistered agent like "codex"/"orchestrator") passes through unchanged.
    const displayLabel = agentKey === ' unassigned' ? 'unassigned' : resolveAgentDisplay(agentKey);
    const laneId = `${runId}::lane::${agentKey}`;
    lanes.push(makeLane({ id: laneId, label: displayLabel, group: 'execution' }));
    const ids: string[] = [];
    tasksByAgent.get(agentKey)!.forEach((t, col) => {
      const stepId = `${runId}::task::${t.dispatchId ?? `${agentKey}-${col}`}`;
      nodes.push(
        makeNode({
          id: stepId,
          label: t.task ?? t.role ?? displayLabel,
          kind: 'step',
          status: toStatusKey(t.status),
          col: LANE_START_COL + col,
          row,
          laneId,
          ...(agentKey !== ' unassigned' ? { agent: displayLabel } : {}),
        }),
      );
      ids.push(stepId);
    });
    laneNodeIds.set(agentKey, ids);
  });

  const verifyId = `${runId}::verify`;
  if (verifyCol !== null) {
    nodes.push(makeNode({ id: verifyId, label: 'Verify', kind: 'verify', status: anyFailed ? 'failed' : 'completed', col: verifyCol, row: spineRow, laneId: null }));
  }
  const outputId = `${runId}::output`;
  if (outputCol !== null) {
    nodes.push(makeNode({ id: outputId, label: 'Output', kind: 'output', status: 'completed', col: outputCol, row: spineRow, laneId: null }));
  }

  const edges: GraphEdge[] = [];
  let edgeIndex = 0;
  const addEdge = (from: string, to: string): void => {
    edges.push(makeEdge({ id: `${runId}::e${edgeIndex++}`, from, to, kind: 'flow' }));
  };
  const tailIds = [verifyCol !== null ? verifyId : null, outputCol !== null ? outputId : null].filter((id): id is string => id !== null);
  const firstTailId = tailIds[0] ?? null;

  addEdge(requestId, bossId);
  if (laneAgents.length > 0) {
    for (const agentKey of laneAgents) {
      const ids = laneNodeIds.get(agentKey) ?? [];
      if (ids.length === 0) continue;
      addEdge(bossId, ids[0]);
      for (let i = 0; i < ids.length - 1; i += 1) addEdge(ids[i], ids[i + 1]);
      if (firstTailId !== null) addEdge(ids[ids.length - 1], firstTailId);
    }
  } else if (firstTailId !== null) {
    addEdge(bossId, firstTailId);
  }
  for (let i = 0; i < tailIds.length - 1; i += 1) addEdge(tailIds[i], tailIds[i + 1]);

  return { id: `${runId}::graph`, runId, lanes, nodes, edges } as unknown as MissionGraph;
}

/* ========================================================================== */
/*  7. Proof ledger + quality gates + artifacts (`/api/proof`)                */
/* ========================================================================== */

/**
 * WP-CCD (item 4/6/7): a real check's identity within `/api/proof`'s own `verdicts` array — same
 * reasoning as `missionVerdictIdentity` above, adapted to this sibling raw-record shape (`check`
 * name when reported, else `command`, else `role`+`agent`; a `'doctor'` row's identity is the
 * literal string `'doctor'`, since this fleet carries at most one doctor receipt per run).
 */
function verdictIdentityRaw(row: Record<string, unknown>): string {
  if (pickString(row, ['source']) === 'doctor') return 'doctor';
  const check = pickString(row, ['check']);
  if (check !== null) return `check::${check}`;
  const command = pickString(row, ['command']);
  if (command !== null) return `command::${command}`;
  return `role-agent::${pickString(row, ['role']) ?? ''}::${pickString(row, ['agent']) ?? ''}`;
}

/**
 * WP-CCD (item 4/6/7): collapses `/api/proof`'s raw `verdicts` array to one row per real check
 * identity, keeping the LATEST result — used to build `gates` (a CURRENT pass/fail STATE board),
 * never `proof` (a historical LEDGER of claims, where every real attempt is deliberately still
 * shown — see `dataset.ts`'s own call site for which is which).
 */
export function dedupeLatestVerdictRows(rows: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return dedupeLatestByKey(rows, verdictIdentityRaw);
}

export function toGatewayProof(row: Record<string, unknown>, index: number): ProofEntry {
  const source = pickString(row, ['source']);
  const isEvent = source === 'event';
  const eventType = pickString(row, ['event_type']);
  const verdict: ProofEntry['verdict'] = isEvent ? (eventType === 'check_passed' ? 'accepted' : 'rejected') : (pickBool(row, ['ok']) ? 'accepted' : 'rejected');
  const command = pickString(row, ['command']);
  const summary = pickString(row, ['summary']);
  const check = pickString(row, ['check']);
  const record: Omit<ProofEntry, 'prototype'> = {
    id: `proof-${index}`,
    timestamp: pickString(row, ['timestamp']) ?? '',
    // WP-CCD (item 6): a real, human-written summary or a readable check name beats the generic
    // "<agent> ran <command>" sentence whenever the gateway reports one — falls back to the exact
    // pre-existing text otherwise.
    claim: isEvent
      ? (summary ?? (check !== null ? `${check} ${eventType === 'check_passed' ? 'passed' : 'failed'}` : `${pickString(row, ['role']) ?? pickString(row, ['agent']) ?? 'an agent'} ran ${command ?? 'a check'}`))
      : `doctor receipt: ${pickNumber(row, ['passed']) ?? 0} passed / ${pickNumber(row, ['failed']) ?? 0} failed across ${pickNumber(row, ['suites']) ?? 0} suites`,
    agent: pickString(row, ['agent']) ?? '',
    taskId: '',
    command: command ?? (isEvent ? '' : 'forge-doctor'),
    artifact: null,
    verdict,
    reason: pickNumber(row, ['exit_code']) !== null ? `exit code ${pickNumber(row, ['exit_code'])}` : '',
  };
  return record as unknown as ProofEntry;
}

export function toGatewayGate(row: Record<string, unknown>, index: number): QualityGate {
  const source = pickString(row, ['source']);
  const isEvent = source === 'event';
  const eventType = pickString(row, ['event_type']);
  const status: StatusKey = isEvent ? (eventType === 'check_passed' ? 'completed' : 'failed') : (pickBool(row, ['ok']) ? 'completed' : 'failed');
  const record: Omit<QualityGate, 'prototype'> = {
    id: `gate-${index}`,
    // WP-CCD (item 6): a readable `check` name (when the gateway reports one distinct from the raw
    // shell command) beats `command` — falls back to the exact pre-existing chain otherwise.
    name: isEvent ? (pickString(row, ['check']) ?? pickString(row, ['command']) ?? pickString(row, ['role']) ?? 'check') : 'Doctor receipt',
    status,
    // Still '' — no per-check start/end timestamp pair exists anywhere in this gateway (a named,
    // unimplemented orchestrator-instrumentation gap; see `gateway-adapter.ts`'s own header).
    duration: '',
    lastRun: pickString(row, ['timestamp']) ?? '',
    evidenceCount: isEvent ? (row.evidence !== undefined && row.evidence !== null ? 1 : 0) : (pickNumber(row, ['passed']) ?? 0) + (pickNumber(row, ['failed']) ?? 0),
    // cc-fix-adapter T6b: proof.mjs now forwards the real event `output` field (previously
    // dropped) — falls back to `evidence` only when it is itself a real string, never a fabricated
    // placeholder. The doctor-summary branch was already real text before this fix.
    output: isEvent
      ? (pickString(row, ['output']) ?? pickString(row, ['evidence']) ?? '')
      : `${pickNumber(row, ['passed']) ?? 0} passed / ${pickNumber(row, ['failed']) ?? 0} failed across ${pickNumber(row, ['suites']) ?? 0} suites`,
  };
  return record as unknown as QualityGate;
}

/**
 * WP-CCD (item 11): known synonyms a real `type`/`kind` value might arrive as — for a final report,
 * a gate-evidence record, a PRD/mission-blueprint, a research writeup, or a vault note — mapped to
 * the CLOSEST existing `ArtifactKind` (never a new one; `ArtifactKind` is a closed union this WP
 * does not widen). Checked case-insensitively; an exact match to one of the 7 real kinds already
 * wins before this table is even consulted (see `toGatewayArtifact` below).
 */
const ARTIFACT_KIND_SYNONYMS: Readonly<Record<string, ArtifactKind>> = {
  'final-report': 'report',
  final_report: 'report',
  finalreport: 'report',
  'gate-evidence': 'proof',
  gate_evidence: 'proof',
  gateevidence: 'proof',
  finalize: 'proof',
  contract: 'proof',
  prd: 'report',
  blueprint: 'report',
  'mission-blueprint': 'report',
  mission_blueprint: 'report',
  research: 'markdown',
  note: 'markdown',
  'vault-note': 'markdown',
  vault_note: 'markdown',
  vaultnote: 'markdown',
};

/** WP-CCD (item 11): the file extension on a real artifact's own `name`/`path` — a reliable signal
 *  that exists TODAY regardless of any gateway change (a run-artifacts-dir file's raw record has
 *  never carried a `type` field at all — see `proof.mjs`'s `listRunArtifactFiles`), used only when
 *  `type`/`kind` did not already resolve to a real `ArtifactKind`. */
function kindFromExtension(nameOrPath: string | null): ArtifactKind | null {
  if (nameOrPath === null) return null;
  const match = /\.([a-z0-9]+)$/i.exec(nameOrPath);
  if (!match) return null;
  switch (match[1].toLowerCase()) {
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'gif':
      return 'screenshot';
    case 'md':
    case 'markdown':
    case 'txt':
      return 'markdown';
    case 'log':
      return 'log';
    default:
      return null;
  }
}

const KNOWN_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  'screenshot',
  'report',
  'diagram',
  'markdown',
  'log',
  'receipt',
  'proof',
]);

function resolveArtifactKind(kindRaw: string | null, nameOrPath: string | null): ArtifactKind {
  if (kindRaw !== null) {
    const normalized = kindRaw.toLowerCase();
    if (KNOWN_ARTIFACT_KINDS.has(normalized)) return normalized as ArtifactKind;
    const synonym = ARTIFACT_KIND_SYNONYMS[normalized];
    if (synonym !== undefined) return synonym;
  }
  return kindFromExtension(nameOrPath) ?? 'log';
}

export function toGatewayArtifact(row: Record<string, unknown>, index: number): Artifact {
  const kindRaw = pickString(row, ['type']);
  const name = pickString(row, ['title']) ?? pickString(row, ['name']);
  const path = pickString(row, ['path']);
  const kind = resolveArtifactKind(kindRaw, name ?? path);
  const sizeBytes = pickNumber(row, ['size_bytes']);
  const record: Omit<Artifact, 'prototype'> = {
    id: pickString(row, ['id']) ?? pickString(row, ['name']) ?? `artifact-${index}`,
    name: pickString(row, ['title']) ?? pickString(row, ['name']) ?? pickString(row, ['id']) ?? `artifact-${index}`,
    kind,
    // cc-fix-artifacts-empty: `Artifact` carries no dedicated run-id field (out of this fix's write
    // scope — `prototype-types.ts` stays frozen), so the real run label rides in this existing
    // free-text field instead: `proof.mjs`'s new `?run=all` aggregate path (`buildProofAll`) stamps
    // each row with its own real `run_id` (or `null` when genuinely unresolvable — see that
    // function's header); a row lacking that field entirely (the ORIGINAL single-run `/api/proof`
    // path, `buildProof`, untouched by this fix) falls through to the prior `source` label exactly
    // as before — zero behavior change for that path. This is what stops "every artifact looks like
    // it belongs to the current run" once artifacts from several real runs are shown together.
    producedBy: pickString(row, ['run_id']) ?? pickString(row, ['source']) ?? '',
    taskId: null,
    createdAt: pickString(row, ['ts']) ?? '',
    // cc-fix-adapter T6b: a real byte count, `stat()`'d server-side (proof.mjs) — '' (never a
    // fabricated "0 B") when the gateway could not stat the underlying file.
    size: sizeBytes !== null ? formatFileBytes(sizeBytes) : '',
    preview: pickString(row, ['summary']) ?? pickString(row, ['path']) ?? '',
  };
  return record as unknown as Artifact;
}

/**
 * cc-fix-adapter fix: the real `doctor.json` health summary `/api/proof` already returns via its
 * 'doctor' verdict entry (`proof.mjs:66-71`) — computed there since this project's earliest
 * gateway work, but never once read by this file until now. `score` is a real derived composite
 * (pass rate), not a fabricated number; it is 0 only when no doctor receipt exists for this
 * project's current run, matching this file's own "0 = not measured" precedent elsewhere.
 */
interface DoctorHealthSummary {
  readonly present: boolean;
  readonly passed: number;
  readonly failed: number;
  /** WP-CCD (item 6): real when either the doctor receipt or the gateway's own recorded test
   *  numbers report one — `0` (never fabricated) when neither does, matching `passed`/`failed`. */
  readonly skipped: number;
  /** `null` when no doctor verdict exists — see EMPTY_DOCTOR_HEALTH's own comment. */
  readonly score: number | null;
}

/**
 * recertify follow-up (Lead): `score` is `null`, not `0`, when no doctor verdict exists.
 *
 * The `present: false` flag has always been here — and was never read by the one caller
 * (`:2012` took `.score` straight through). So the ACTIVE project rendered "Health 0%" whenever
 * the proof payload carried no doctor row, which is the ordinary state until a run with a doctor
 * verdict is selected. A 0% is not an empty reading; it is the worst possible score, shown for
 * something that was never measured — the exact defect F3 fixed for every OTHER project, still
 * living on the active-project path. The verify pass flagged it as an observation it could not
 * fully trace read-only; traced here, and it was real.
 *
 * `ProjectHealth.score` is already `number | null`, so absence is representable without widening
 * anything: views render `—`.
 */
const EMPTY_DOCTOR_HEALTH: DoctorHealthSummary = { present: false, passed: 0, failed: 0, skipped: 0, score: null };

/**
 * WP-CCD (item 6): reads the project's OWN recorded doctor numbers, and (speculatively) a
 * `gateway_tests` top-level field for the gateway/dashboard build's own recorded Node test-runner
 * tally — tried FIRST, before falling back to the existing single-run `'doctor'` verdict-row reading.
 *
 * REVIEW FIX / HONEST GAP (verified against `_scratch/wt-cc1-snap/gateway/src/proof.mjs`): a
 * top-level `doctor`/`gateway_tests` object is NOT actually sent by the real gateway — the doctor
 * tally is pushed as one more row inside the pre-existing `verdicts` array
 * (`{source:'doctor', ok, suites, passed, failed}`, `readDoctorTallyForRun` in `health.mjs`), which
 * the fallback branch below already reads correctly. `doctor`/`gateway_tests` are kept here as inert,
 * forward-compatible reads (never break anything if a future gateway build adds them) but currently
 * ALWAYS fall through to the verdict-row path. There is, as of this snapshot, NO real data source
 * anywhere in this gateway for a "gateway's own test-suite" tally distinct from the project's doctor
 * receipt — that half of item 6's "doctor and gateway numbers" is a genuine, named gap to hand off,
 * not something this file can honestly surface today. Both `doctor`/`gateway_tests` are summed when
 * both are present (two REAL recorded sources, not a choice between them); either source's own
 * `passed`/`failed`/`skipped` count as a real 0 when it reports one.
 *
 * LEAD NOTE (mid-task correction, WP-CC1 round 3, merged to command-center main as `84ccab9`): the
 * frozen `_scratch/wt-cc1-snap` this file was verified against had a real bug — the doctor verdict
 * row's own tally-origin field (`doctorSummary.source`, e.g. `"doctor.json"`/
 * `"gate-evidence-output-file"`) was spread INTO the row object AFTER the literal `source: 'doctor'`
 * marker, silently overwriting it (`{ source: 'doctor', ...doctorSummary }` — object-spread order
 * means the LATER `doctorSummary.source` wins). The fallback below's `row.source === 'doctor'` check
 * therefore never matched on that snapshot, which is the most likely reason this project's own real
 * "TESTS" health reading showed `—` in this WP's own screenshot evidence despite a real doctor
 * receipt genuinely existing (visible separately in the Quality Gates list, which does not require
 * an exact `'doctor'` match — see `toGatewayGate`'s own `!isEvent` branch). Fixed on merged main: the
 * literal `'doctor'` marker survives, and the tally's own origin now lives in a separate
 * `doctor_source` field this parser does not yet read (a real, available field left unsurfaced — a
 * named gap, not a bug). This file's own `row.source === 'doctor'` checks (here and in
 * `verdictIdentityRaw` above) were never changed to match the snapshot's broken behaviour — they
 * already checked for the literal marker, which is exactly correct against the fixed contract.
 */
export function parseDoctorHealth(proofPayload: Record<string, unknown> | null): DoctorHealthSummary {
  if (proofPayload === null) return EMPTY_DOCTOR_HEALTH;

  let present = false;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const doctorObj = pickRecord(proofPayload, ['doctor']);
  if (doctorObj !== null) {
    present = true;
    passed += pickNumber(doctorObj, ['passed']) ?? 0;
    failed += pickNumber(doctorObj, ['failed']) ?? 0;
    skipped += pickNumber(doctorObj, ['skipped']) ?? 0;
  }
  const gatewayObj = pickRecord(proofPayload, ['gateway_tests', 'gatewayTests']);
  if (gatewayObj !== null) {
    present = true;
    passed += pickNumber(gatewayObj, ['passed']) ?? 0;
    failed += pickNumber(gatewayObj, ['failed']) ?? 0;
    skipped += pickNumber(gatewayObj, ['skipped']) ?? 0;
  }

  if (!present) {
    const verdictRows = pickArray(proofPayload, ['verdicts']);
    const doctorRow = verdictRows.find((row) => pickString(row, ['source']) === 'doctor');
    if (doctorRow === undefined) return EMPTY_DOCTOR_HEALTH;
    present = true;
    passed = pickNumber(doctorRow, ['passed']) ?? 0;
    failed = pickNumber(doctorRow, ['failed']) ?? 0;
    skipped = pickNumber(doctorRow, ['skipped']) ?? 0;
  }

  const total = passed + failed;
  return { present, passed, failed, skipped, score: total > 0 ? Math.round((passed / total) * 100) : 0 };
}

/* ========================================================================== */
/*  7b. Reviews / gate evidence / finalize / run contract (WP-CCD, item 6)   */
/*                                                                             */
/*  All FOUR of these are real `/api/proof` fields — read defensively         */
/*  regardless (an absent field parses to a real, honest "not available yet" */
/*  value, never a guess), but the exact shapes below are now VERIFIED LIVE   */
/*  against `_scratch/wt-cc1-snap/gateway/src/proof.mjs::buildProof()`,       */
/*  which the WIP that first wrote this section had not yet read when it     */
/*  guessed `reviews`/`finalize`/`contract` field names (its own honest       */
/*  caveat said so). `reviews` turned out to already match verbatim;          */
/*  `finalize`/`contract` did not (see each parser's own review-fix note      */
/*  below) — both previously always parsed to "not available" on real data.   */
/* ========================================================================== */

export interface GatewayReview {
  readonly reviewId: string;
  readonly agent: string | null;
  readonly verdict: string | null;
  readonly subject: string | null;
  readonly commitSha: string | null;
  readonly completedAt: string | null;
}

/** `null`/absent `reviews` array reads as the honest empty list — no gateway build has ever sent
 *  this field, so an empty result is the universal case today, not an error. */
export function parseGatewayReviews(proofPayload: Record<string, unknown> | null): readonly GatewayReview[] {
  if (proofPayload === null) return [];
  return pickArray(proofPayload, ['reviews']).map((row, index) => ({
    reviewId: pickString(row, ['review_id']) ?? `review-${index}`,
    agent: pickString(row, ['agent']),
    verdict: pickString(row, ['verdict']),
    subject: pickString(row, ['subject']),
    commitSha: pickString(row, ['commit_sha']),
    completedAt: pickString(row, ['completed_at']),
  }));
}

/** One real, individually-executed gate from `gate-evidence.json`'s own `gates[]` array — verified
 *  live against `proof.mjs::readGateEvidence()`. */
export interface GatewayGateEvidenceGate {
  readonly name: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly timedOut: boolean | null;
}

export interface GatewayGateEvidence {
  readonly present: boolean;
  readonly gatesTotal: number | null;
  readonly gatesFailed: number | null;
  readonly allGreen: boolean | null;
  readonly generatedAt: string | null;
  /** REVIEW FIX: `gate-evidence.json` never actually carries a `note` field (verified against
   *  `proof.mjs::readGateEvidence()`) — kept for a hypothetical future build, but always `null`
   *  today. `commit`/`worktreeClean` below are the two real top-level fields this earlier version
   *  of the parser dropped entirely. */
  readonly note: string | null;
  readonly commit: string | null;
  readonly worktreeClean: boolean | null;
  /** REVIEW FIX: the real per-gate breakdown (`gates[]`) — each gate's own name, exit code,
   *  duration and timeout flag — was silently dropped by the earlier version of this parser, even
   *  though the aggregate `gatesTotal`/`gatesFailed`/`allGreen` numbers came from this same object.
   *  Empty when the source object carries no `gates` array (an older `gate-evidence.json` writer). */
  readonly gates: readonly GatewayGateEvidenceGate[];
}

export const EMPTY_GATE_EVIDENCE: GatewayGateEvidence = {
  present: false,
  gatesTotal: null,
  gatesFailed: null,
  allGreen: null,
  generatedAt: null,
  note: null,
  commit: null,
  worktreeClean: null,
  gates: [],
};

export function parseGateEvidence(proofPayload: Record<string, unknown> | null): GatewayGateEvidence {
  if (proofPayload === null) return EMPTY_GATE_EVIDENCE;
  const obj = pickRecord(proofPayload, ['gate_evidence']);
  if (obj === null) return EMPTY_GATE_EVIDENCE;
  return {
    present: true,
    gatesTotal: pickNumber(obj, ['gates_total']),
    gatesFailed: pickNumber(obj, ['gates_failed']),
    allGreen: pickBool(obj, ['all_green']),
    generatedAt: pickString(obj, ['generated_at']),
    note: pickString(obj, ['note']),
    commit: pickString(obj, ['commit']),
    worktreeClean: pickBool(obj, ['worktree_clean']),
    gates: pickArray(obj, ['gates']).map((g) => ({
      name: pickString(g, ['name']),
      exitCode: pickNumber(g, ['exit_code']),
      durationMs: pickNumber(g, ['duration_ms']),
      timedOut: pickBool(g, ['timed_out']),
    })),
  };
}

export interface GatewayFinalizeReceipt {
  readonly present: boolean;
  readonly finalizedAt: string | null;
  readonly digest: string | null;
  readonly note: string | null;
  /** Review Boss RB2-M1: a receipt file EXISTS but no longer counts (the gateway's finalize_invalid_reason, e.g.
   *  "the log changed after it was finalized"); null when there is simply no receipt, or a valid one. */
  readonly invalidReason: string | null;
}

export const EMPTY_FINALIZE_RECEIPT: GatewayFinalizeReceipt = { present: false, finalizedAt: null, digest: null, note: null, invalidReason: null };

/**
 * REVIEW FIX: the real top-level `/api/proof` key is `finalize_receipt`, NOT `finalize` (verified
 * against `proof.mjs::buildProof()` — `finalize_receipt: finalizeReceipt`) — the earlier version of
 * this parser always read `null` on real data as a result. `finalize` is kept as an extra, harmless
 * fallback key. Sub-field names (`digest`/`finalized_at`) were already correct.
 */
export function parseFinalizeReceipt(proofPayload: Record<string, unknown> | null): GatewayFinalizeReceipt {
  if (proofPayload === null) return EMPTY_FINALIZE_RECEIPT;
  const obj = pickRecord(proofPayload, ['finalize_receipt', 'finalize']);
  if (obj === null) {
    // RB2-M1: the gateway returns finalize_receipt:null AND a reason when a receipt exists but no longer counts —
    // keep that reason, so the panel never claims the receipt file does not exist.
    const invalidReason = pickString(proofPayload, ['finalize_invalid_reason']);
    return invalidReason === null ? EMPTY_FINALIZE_RECEIPT : { ...EMPTY_FINALIZE_RECEIPT, invalidReason };
  }
  return {
    present: true,
    finalizedAt: pickString(obj, ['finalized_at', 'generated_at']),
    digest: pickString(obj, ['digest', 'receipt_hash']),
    note: pickString(obj, ['note']),
    invalidReason: null,
  };
}

export interface GatewayRunContract {
  readonly present: boolean;
  /** `'green'` (the contract passed — every applicable rule satisfied), `'red'` (at least one
   *  applicable rule is missing) or `null` (the check could not be performed at all — see `note`). */
  readonly status: 'green' | 'red' | null;
  readonly missingRules: readonly string[];
  readonly note: string | null;
}

export const EMPTY_RUN_CONTRACT: GatewayRunContract = { present: false, status: null, missingRules: [], note: null };

/**
 * REVIEW FIX: the real top-level `/api/proof` key is `run_contract`, NOT `contract` (verified
 * against `proof.mjs::buildProof()` — `run_contract: runContract`), AND its shape is a two-level
 * envelope around the CENTRAL `forge-runcontract.cjs check --json` output, never the flat
 * `{status, missing_rules}` shape this parser previously guessed:
 *   `{available: boolean, result?: {ok: boolean, missing: string[], satisfied: string[], ...},
 *     note?: string, checked_at: string}`
 * — `available:false` (the checker genuinely could not run — e.g. it was not found, or timed out)
 * is a REAL, distinct outcome from "no check has ever been attempted for this run" (an older
 * gateway build with no `run_contract` key at all): the former is `present:true` with an honest
 * explanatory `note` and a `null` status (never guessed red/green when the check did not run); the
 * latter is the plain `EMPTY_RUN_CONTRACT`. `result.missing` is the real list of unsatisfied
 * `FORGE_HARD_RULES.json` rule ids — exactly item 6's "missing rules" list.
 */
export function parseRunContract(proofPayload: Record<string, unknown> | null): GatewayRunContract {
  if (proofPayload === null) return EMPTY_RUN_CONTRACT;
  const obj = pickRecord(proofPayload, ['run_contract', 'contract']);
  if (obj === null) return EMPTY_RUN_CONTRACT;
  const available = pickBool(obj, ['available']) ?? false;
  if (!available) {
    return { present: true, status: null, missingRules: [], note: pickString(obj, ['note']) };
  }
  const result = pickRecord(obj, ['result']);
  if (result === null) {
    // `available:true` with no real `result` object is a structurally-broken response — honest
    // absence, never a guessed pass.
    return { present: true, status: null, missingRules: [], note: pickString(obj, ['note']) };
  }
  const ok = pickBool(result, ['ok']);
  return {
    present: true,
    status: ok === null ? null : ok ? 'green' : 'red',
    missingRules: pickStringArray(result, ['missing', 'missing_rules']),
    note: pickString(obj, ['note']),
  };
}
