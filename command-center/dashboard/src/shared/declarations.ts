/**
 * Forge Workspace — deriving the runtime declarations from evidence.
 *
 * `protocol.ts` holds the INVARIANT declarations, because those are properties
 * of the build and a static scan can prove them. This file holds everything
 * else: the eight claims about the LIVE system, none of which can be known by
 * reading source code, all of which are recomputed every time health is
 * assembled.
 *
 * THE RULE, STATED AS CODE. Every derived declaration is a function of
 * OBSERVATIONS. There is no default-true anywhere below, and there is no branch
 * that turns an absent observation into a positive claim. Absent evidence
 * produces `value: false` together with a `missing` list naming exactly what was
 * not there — which is what lets a screen say "not connected because no Claude
 * Code probe has run" instead of a shrug.
 *
 * WHY THIS FILE IS PURE. It performs no I/O, reads no clock, opens no file and
 * starts no process. `now` and every observation are passed in. Two things fall
 * out of that:
 *
 *   1. It is loadable by the browser bundle and by Node alike, so the UI can
 *      derive the same answer from the same inputs the bridge used.
 *   2. The "false without evidence" property is testable exhaustively, by
 *      constructing the empty state — see `tests/unit/runtime-declarations.test.ts`.
 *
 * The bridge's side of the split lives in `src/bridge/health.ts`: it does the
 * looking (probe, registry, filesystem, event log, telemetry) and hands the
 * results here. Nothing in this file knows how an observation was made.
 *
 * The `./protocol.ts` import carries an explicit extension because Node 24
 * executes this file directly when the bridge imports it, and the runtime
 * resolves the extension it is given.
 */

import { DERIVED_DECLARATIONS, INVARIANT_DECLARATION_PROOFS, INVARIANT_DECLARATIONS } from './protocol.ts';
import type {
  DeclarationEvidence,
  DeclarationEvidenceKind,
  DerivedDeclaration,
  DerivedDeclarationName,
  EvidenceRef,
  RuntimeDeclarations,
} from './protocol.ts';

/* ========================================================================== */
/*  Freshness                                                                  */
/* ========================================================================== */

/**
 * How long a successful Claude Code probe stays evidence.
 *
 * A probe is a real `-p` call against the installed CLI: it costs seconds and it
 * cannot run per request. So the result is cached — and a cached result is only
 * evidence while it is current. Past this window the claim reverts to false with
 * `missing: ['a probe within the freshness window']`, because "it answered five
 * hours ago" is not a statement about now.
 */
export const DEFAULT_CLAUDE_PROBE_FRESHNESS_MS = 300_000;

/* ========================================================================== */
/*  Observations — what the bridge saw                                         */
/* ========================================================================== */

/**
 * The outcome of one real Claude Code health probe.
 *
 * `authenticated` means the same thing it means in `locate.ts`: a real `-p` call
 * returned exit 0 with a result envelope carrying a session id. It never means
 * "we assume so". `sessionObserved` records that a session id was present
 * WITHOUT carrying the id itself — nothing here is ever a credential, and the
 * narrowest field that supports the claim is the right one.
 */
export interface ClaudeProbeObservation {
  readonly available: boolean;
  readonly authenticated: boolean;
  /** Null when the probe completed cleanly; otherwise the failure mode's name. */
  readonly failure: string | null;
  readonly checkedAtMs: number;
  readonly checkedAt: string;
  readonly executablePath: string | null;
  readonly version: string | null;
  readonly sessionObserved: boolean;
  /** The probe's own sentence. Never stdout, never a token. */
  readonly note: string;
}

/** Where the projects root resolved to, and what on disk confirmed it. */
export interface ProjectsRootObservation {
  readonly projectsRoot: string;
  readonly documentsDir: string;
  /** False when nothing on disk confirmed the Documents directory. */
  readonly documentsDirExists: boolean;
  /** `fallback-unverified` means the location is a convention, not a finding. */
  readonly source: string;
  /** Whether `<Documents>/ForgeProjects` itself is currently a directory. */
  readonly projectsRootExists: boolean;
}

/** A project whose recorded path could not be confirmed on disk. */
export interface MissingProjectPath {
  readonly id: string;
  readonly canonicalPath: string;
  readonly detail: string;
}

/** What the canonical project index could answer when it was asked. */
export interface RegistryObservation {
  /** True only when a registry instance answered a list request without throwing. */
  readonly loaded: boolean;
  readonly detail: string;
  readonly projectsRoot: string | null;
  readonly recordCount: number;
  /** Records that exist on disk and could not be produced. Never hidden. */
  readonly unreadableCount: number;
  readonly pathsPresent: number;
  readonly pathsMissing: readonly MissingProjectPath[];
}

/** Agent activations actually recorded in the event log. */
export interface ActivationObservation {
  readonly count: number;
  readonly lastAt: string | null;
  readonly detail: string;
  readonly refs: readonly EvidenceRef[];
}

/**
 * Process executions actually recorded.
 *
 * `spawned` counts records that carry an OS process id — evidence that a child
 * really started. `withExitCode` counts the ones whose exit code was read. The
 * two are kept apart on purpose: an exit code nobody read is not an outcome.
 */
export interface ExecutionObservation {
  readonly spawned: number;
  readonly withExitCode: number;
  readonly lastAt: string | null;
  readonly detail: string;
  readonly refs: readonly EvidenceRef[];
}

/**
 * A fixture source that announced itself to the running process.
 *
 * The static scan proves no bridge module imports the prototype fixture tree;
 * this registry is what would catch a loader added later that the scan has not
 * been taught about. Both halves are needed: the scan covers the code as
 * written, the registry covers the process as it runs.
 */
export interface FixtureSourceObservation {
  readonly id: string;
  readonly detail: string;
}

/** Per-snapshot accuracy census. `exactFields` are the ones Claude Code reported. */
export interface UsageAccuracyObservation {
  readonly scope: string;
  readonly scopeId: string;
  readonly exactFields: readonly string[];
  readonly fieldsExamined: number;
}

/** Whether a real attachment staging root exists and accepted a real write. */
export interface AttachmentStagingObservation {
  readonly pipelineRegistered: boolean;
  readonly stagingRoot: string | null;
  /** Established by writing a probe file and reading it back. Never assumed. */
  readonly writable: boolean;
  readonly detail: string;
}

/**
 * Everything the derivation is allowed to look at. A `null` field means the
 * bridge could not, or did not, observe that thing — which is different from
 * observing an absence, and both come out as `false` with a different sentence.
 */
export interface DeclarationInputs {
  readonly now: string;
  readonly nowMs: number;
  readonly claudeProbeFreshnessMs: number;
  readonly claudeProbe: ClaudeProbeObservation | null;
  readonly projectsRoot: ProjectsRootObservation | null;
  readonly registry: RegistryObservation | null;
  readonly agentActivations: ActivationObservation | null;
  readonly processExecutions: ExecutionObservation | null;
  readonly fixtureSources: readonly FixtureSourceObservation[];
  readonly usage: readonly UsageAccuracyObservation[];
  readonly attachments: AttachmentStagingObservation | null;
}

/**
 * The state of a bridge that has looked at nothing.
 *
 * Exported because it is the shape the honesty tests assert against: every
 * derived declaration must be false here, and each must say what is missing.
 */
export function emptyDeclarationInputs(nowMs: number): DeclarationInputs {
  return {
    now: new Date(nowMs).toISOString(),
    nowMs,
    claudeProbeFreshnessMs: DEFAULT_CLAUDE_PROBE_FRESHNESS_MS,
    claudeProbe: null,
    projectsRoot: null,
    registry: null,
    agentActivations: null,
    processExecutions: null,
    fixtureSources: [],
    usage: [],
    attachments: null,
  };
}

/* ========================================================================== */
/*  Building one declaration                                                   */
/* ========================================================================== */

function evidence(
  kind: DeclarationEvidenceKind,
  summary: string,
  refs: readonly EvidenceRef[],
  missing: readonly string[],
): DeclarationEvidence {
  return { kind, summary, refs, missing };
}

/**
 * The single constructor for a derived declaration, and the place the honesty
 * rule is enforced rather than remembered:
 *
 *  - a `true` with no evidence reference is downgraded to `false`, because a
 *    positive claim whose support cannot be re-checked is not supported;
 *  - a `false` always carries at least one entry in `missing`, so the UI never
 *    has to invent a reason.
 */
function declare(
  name: DerivedDeclarationName,
  value: boolean,
  checkedAt: string,
  ev: DeclarationEvidence,
): DerivedDeclaration {
  if (value && ev.refs.length === 0) {
    return {
      name,
      value: false,
      checkedAt,
      evidence: evidence(
        'NONE',
        `${name} was computed true but carried no re-checkable evidence, so it is reported false.`,
        [],
        ['at least one evidence reference for a positive claim'],
      ),
    };
  }
  if (!value && ev.missing.length === 0) {
    return { name, value, checkedAt, evidence: { ...ev, missing: ['no evidence was recorded'] } };
  }
  return { name, value, checkedAt, evidence: ev };
}

/* ========================================================================== */
/*  The eight derivations                                                      */
/* ========================================================================== */

function deriveConnectedToClaudeCode(inputs: DeclarationInputs): DerivedDeclaration {
  const probe = inputs.claudeProbe;
  if (probe === null) {
    return declare(
      'CONNECTED_TO_CLAUDE_CODE',
      false,
      inputs.now,
      evidence(
        'NONE',
        'No Claude Code probe result is available to this bridge, so nothing has been checked. This is not a claim that Claude Code is absent.',
        [],
        ['a completed Claude Code health probe'],
      ),
    );
  }

  const ageMs = inputs.nowMs - probe.checkedAtMs;
  const fresh = ageMs >= 0 && ageMs <= inputs.claudeProbeFreshnessMs;
  const missing: string[] = [];
  if (!probe.available) missing.push('a locatable Claude Code executable that reported its version');
  if (!probe.authenticated) missing.push('a real -p call that returned exit 0 with a result envelope');
  if (probe.failure !== null) missing.push(`a probe with no failure (last failure: ${probe.failure})`);
  if (!probe.sessionObserved) missing.push('a session id in the probe result envelope');
  if (!fresh) {
    missing.push(
      `a probe within the ${inputs.claudeProbeFreshnessMs}ms freshness window (this one is ${ageMs}ms old)`,
    );
  }

  const refs: EvidenceRef[] = [];
  if (probe.executablePath !== null) {
    refs.push({ kind: 'file', ref: probe.executablePath, note: `probed at ${probe.checkedAt}` });
  }
  refs.push({
    kind: 'stdout',
    ref: `claude-code:probe:${probe.checkedAt}`,
    note: probe.note.slice(0, 300),
  });

  const value = missing.length === 0;
  return declare(
    'CONNECTED_TO_CLAUDE_CODE',
    value,
    inputs.now,
    evidence(
      'PROBE',
      value
        ? `A real Claude Code call ${String(ageMs)}ms ago returned exit 0 with a session, from ${probe.executablePath ?? 'an unnamed path'} (version ${probe.version ?? 'unreported'}).`
        : `The last Claude Code probe at ${probe.checkedAt} did not establish a live connection: ${probe.note.slice(0, 200)}`,
      refs,
      missing,
    ),
  );
}

function deriveConnectedToForge(inputs: DeclarationInputs): DerivedDeclaration {
  const registry = inputs.registry;
  const root = inputs.projectsRoot;
  const missing: string[] = [];
  const refs: EvidenceRef[] = [];

  if (registry === null || !registry.loaded) {
    missing.push('a loaded project registry that answered a list request');
  } else {
    refs.push({
      kind: 'file',
      ref: registry.projectsRoot ?? 'records/project',
      note: `registry answered with ${String(registry.recordCount)} record(s)`,
    });
  }

  // Resolvable is not the same as present. The root is resolvable when a real
  // directory on disk confirmed where it belongs; whether the folder itself has
  // been created yet is a separate fact, reported in the summary.
  if (root === null) {
    missing.push('a resolved projects root');
  } else {
    if (!root.documentsDirExists || root.source === 'fallback-unverified') {
      missing.push(
        `a Documents directory confirmed on disk (resolution source was ${root.source}, confirmed ${String(root.documentsDirExists)})`,
      );
    } else {
      refs.push({ kind: 'file', ref: root.documentsDir, note: `projects root source ${root.source}` });
    }
  }

  const value = missing.length === 0;
  return declare(
    'CONNECTED_TO_FORGE',
    value,
    inputs.now,
    evidence(
      value ? 'REGISTRY' : root === null && registry === null ? 'NONE' : 'FILESYSTEM',
      value
        ? `The registry is loaded and the projects root resolves to ${root?.projectsRoot ?? 'an unnamed path'} (${root?.projectsRootExists === true ? 'the directory exists' : 'the directory does not exist yet'}).`
        : 'The workspace is not connected to Forge: the registry, the projects root, or both could not be established.',
      refs,
      missing,
    ),
  );
}

function deriveUsesRealProjects(inputs: DeclarationInputs): DerivedDeclaration {
  const registry = inputs.registry;
  if (registry === null || !registry.loaded) {
    return declare(
      'USES_REAL_PROJECTS',
      false,
      inputs.now,
      evidence('NONE', 'No project registry was consulted, so no project path has been checked.', [], [
        'a loaded project registry',
      ]),
    );
  }

  const missing: string[] = [];
  if (registry.recordCount === 0) {
    // Vacuously true is not true. "Uses real projects" claims something about
    // projects that exist; with none registered there is nothing to claim.
    missing.push('at least one registered project');
  }
  if (registry.unreadableCount > 0) {
    missing.push(`${String(registry.unreadableCount)} unreadable project record(s) resolved`);
  }
  for (const gone of registry.pathsMissing) {
    missing.push(`an existing directory for project ${gone.id} at ${gone.canonicalPath} (${gone.detail})`);
  }

  const value = missing.length === 0;
  return declare(
    'USES_REAL_PROJECTS',
    value,
    inputs.now,
    evidence(
      'REGISTRY',
      value
        ? `All ${String(registry.recordCount)} registered project(s) resolve to a directory that exists on disk.`
        : `The registry holds ${String(registry.recordCount)} record(s); ${String(registry.pathsMissing.length)} path(s) could not be confirmed and ${String(registry.unreadableCount)} record(s) could not be read.`,
      value
        ? [{ kind: 'file', ref: registry.projectsRoot ?? 'records/project', note: `${String(registry.pathsPresent)} path(s) confirmed on disk` }]
        : [],
      missing,
    ),
  );
}

function deriveUsesRealAgents(inputs: DeclarationInputs): DerivedDeclaration {
  const observed = inputs.agentActivations;
  if (observed === null) {
    return declare(
      'USES_REAL_AGENTS',
      false,
      inputs.now,
      evidence('NONE', 'The event log was not consulted for agent activations.', [], [
        'a scan of the event log for agent.activated events',
      ]),
    );
  }
  const value = observed.count > 0;
  return declare(
    'USES_REAL_AGENTS',
    value,
    inputs.now,
    evidence(
      value ? 'EVENT' : 'NONE',
      value
        ? `${String(observed.count)} agent activation(s) are recorded in the event log, the most recent at ${observed.lastAt ?? 'an unrecorded time'}.`
        : `No agent activation has ever been recorded. ${observed.detail}`,
      observed.refs,
      value ? [] : ['at least one recorded agent.activated event'],
    ),
  );
}

function deriveUsesRealCommands(inputs: DeclarationInputs): DerivedDeclaration {
  const observed = inputs.processExecutions;
  if (observed === null) {
    return declare(
      'USES_REAL_COMMANDS',
      false,
      inputs.now,
      evidence('NONE', 'The record store was not consulted for process executions.', [], [
        'a scan of the run and test records for a recorded process',
      ]),
    );
  }
  const value = observed.spawned > 0 || observed.withExitCode > 0;
  return declare(
    'USES_REAL_COMMANDS',
    value,
    inputs.now,
    evidence(
      value ? 'RECORD' : 'NONE',
      value
        ? `${String(observed.spawned)} process(es) were recorded with an OS process id and ${String(observed.withExitCode)} with a read exit code, the most recent at ${observed.lastAt ?? 'an unrecorded time'}.`
        : `No process execution has ever been recorded. ${observed.detail}`,
      observed.refs,
      value ? [] : ['at least one record carrying a process id or a read exit code'],
    ),
  );
}

function deriveUsesMockData(inputs: DeclarationInputs): DerivedDeclaration {
  const sources = inputs.fixtureSources;
  const loaded = sources.length > 0;
  // The only declaration whose TRUE is the bad outcome, so it is the only one
  // where evidence supports the positive. False here is supported by the static
  // scan named in the summary, not by an absence nobody looked for.
  return declare(
    'USES_MOCK_DATA',
    loaded,
    inputs.now,
    evidence(
      loaded ? 'RECORD' : 'NONE',
      loaded
        ? `${String(sources.length)} fixture source(s) are loaded in this process: ${sources.map((s) => s.id).join(', ')}.`
        : 'No fixture source registered itself with this bridge, and the static scan proves no bridge module imports the prototype fixture tree.',
      loaded
        ? sources.map((source): EvidenceRef => ({ kind: 'event', ref: source.id, note: source.detail }))
        : [],
      loaded ? [] : ['nothing — no fixture source is loaded, and false is the required value here'],
    ),
  );
}

function deriveUsesRealUsageTelemetry(inputs: DeclarationInputs): DerivedDeclaration {
  const exactSnapshots = inputs.usage.filter((snapshot) => snapshot.exactFields.length > 0);
  const value = exactSnapshots.length > 0;
  const examined = inputs.usage.length;
  return declare(
    'USES_REAL_USAGE_TELEMETRY',
    value,
    inputs.now,
    evidence(
      value ? 'TELEMETRY' : 'NONE',
      value
        ? `${String(exactSnapshots.length)} of ${String(examined)} usage snapshot(s) carry at least one EXACT field reported by Claude Code.`
        : examined === 0
          ? 'No usage snapshot exists, so no telemetry has been reported by Claude Code.'
          : `${String(examined)} usage snapshot(s) exist, but none carries an EXACT field; every number in them is derived, estimated or unavailable.`,
      exactSnapshots.map(
        (snapshot): EvidenceRef => ({
          kind: 'event',
          ref: `usage:${snapshot.scope}:${snapshot.scopeId}`,
          note: `EXACT fields: ${snapshot.exactFields.join(', ')}`,
        }),
      ),
      value ? [] : ['at least one usage snapshot with a field whose accuracy is EXACT'],
    ),
  );
}

function deriveSupportsFileAttachments(inputs: DeclarationInputs): DerivedDeclaration {
  const observed = inputs.attachments;
  if (observed === null) {
    return declare(
      'SUPPORTS_FILE_ATTACHMENTS',
      false,
      inputs.now,
      evidence('NONE', 'No attachment pipeline is registered with this bridge.', [], [
        'a registered attachment pipeline',
        'a staging root proven writable',
      ]),
    );
  }
  const missing: string[] = [];
  if (!observed.pipelineRegistered) missing.push('a registered attachment pipeline');
  if (observed.stagingRoot === null) missing.push('a resolved staging root inside a project');
  if (!observed.writable) missing.push('a staging root that accepted a write and read it back');

  const value = missing.length === 0;
  return declare(
    'SUPPORTS_FILE_ATTACHMENTS',
    value,
    inputs.now,
    evidence(
      value ? 'PIPELINE' : 'NONE',
      value
        ? `The attachment pipeline is registered and its staging root ${observed.stagingRoot ?? ''} accepted a write probe.`
        : `File attachments are not available: ${observed.detail}`,
      value && observed.stagingRoot !== null
        ? [{ kind: 'file', ref: observed.stagingRoot, note: 'staging root, proven writable by a write-and-read-back probe' }]
        : [],
      missing,
    ),
  );
}

/* ========================================================================== */
/*  The derivation                                                             */
/* ========================================================================== */

const DERIVATIONS: Readonly<Record<DerivedDeclarationName, (inputs: DeclarationInputs) => DerivedDeclaration>> = {
  CONNECTED_TO_FORGE: deriveConnectedToForge,
  CONNECTED_TO_CLAUDE_CODE: deriveConnectedToClaudeCode,
  USES_REAL_PROJECTS: deriveUsesRealProjects,
  USES_REAL_AGENTS: deriveUsesRealAgents,
  USES_REAL_COMMANDS: deriveUsesRealCommands,
  USES_MOCK_DATA: deriveUsesMockData,
  USES_REAL_USAGE_TELEMETRY: deriveUsesRealUsageTelemetry,
  SUPPORTS_FILE_ATTACHMENTS: deriveSupportsFileAttachments,
};

/**
 * Compute every declaration from the observations supplied.
 *
 * Total and deterministic: the same inputs always produce the same report, and
 * no input can produce a positive claim that carries no evidence reference.
 */
export function deriveDeclarations(inputs: DeclarationInputs): RuntimeDeclarations {
  const derived: Record<DerivedDeclarationName, DerivedDeclaration> = {} as Record<
    DerivedDeclarationName,
    DerivedDeclaration
  >;
  for (const name of DERIVED_DECLARATIONS) {
    derived[name] = DERIVATIONS[name](inputs);
  }
  return {
    invariant: INVARIANT_DECLARATIONS,
    invariantProofs: INVARIANT_DECLARATION_PROOFS,
    derived,
    computedAt: inputs.now,
  };
}

/* ========================================================================== */
/*  Explaining a report                                                        */
/* ========================================================================== */

export interface DeclarationExplanation {
  readonly name: string;
  readonly kind: 'INVARIANT' | 'DERIVED';
  readonly value: boolean | string;
  /** The whole reason, in one sentence a user can act on. */
  readonly reason: string;
  readonly checkedAt: string | null;
  readonly missing: readonly string[];
}

/**
 * Why every declaration is what it is.
 *
 * This is what a screen renders when it has to explain that something is not
 * connected. A row that only shows a red dot teaches the user nothing; a row
 * that says "no Claude Code probe has completed" tells them where to look.
 */
export function explainDeclarations(report: RuntimeDeclarations): readonly DeclarationExplanation[] {
  const out: DeclarationExplanation[] = [];

  for (const [name, value] of Object.entries(report.invariant)) {
    const proof = report.invariantProofs[name as keyof typeof report.invariantProofs];
    out.push({
      name,
      kind: 'INVARIANT',
      value,
      reason: `Property of this build, not of this run. Proven by ${proof}`,
      checkedAt: null,
      missing: [],
    });
  }

  for (const name of DERIVED_DECLARATIONS) {
    const declaration = report.derived[name];
    out.push({
      name,
      kind: 'DERIVED',
      value: declaration.value,
      reason: declaration.evidence.summary,
      checkedAt: declaration.checkedAt,
      missing: declaration.evidence.missing,
    });
  }

  return out;
}

/** The derived declarations that could not be established, by name. */
export function unprovenDeclarations(report: RuntimeDeclarations): readonly DerivedDeclarationName[] {
  return DERIVED_DECLARATIONS.filter(
    (name) => name !== 'USES_MOCK_DATA' && !report.derived[name].value,
  );
}
