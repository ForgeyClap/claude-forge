/**
 * Forge Workspace — the health assembler and the Claude Code probe.
 *
 * `src/shared/declarations.ts` decides what the declarations MEAN given a set of
 * observations. This file is the other half: it does the looking. Everything
 * here touches the real machine — it spawns the installed CLI, stats the
 * projects root, reads the event log, writes a probe file — and hands what it
 * found to the pure derivation, which cannot be talked into a positive claim.
 *
 * WHY THE PROBE IS CACHED, AND WHY THE CACHE EXPIRES. Proving Claude Code is
 * reachable means making a real `-p` call. That costs seconds, so it cannot run
 * on every `/api/health` request, so the result is cached and refreshed on an
 * interval. But a cached success is evidence about the moment it was taken, not
 * about now: past the freshness window the derived declaration goes back to
 * false with "no probe within the window" as the reason. The cache makes the
 * check affordable; the window stops it from becoming a claim it has outlived.
 *
 * WHAT NEVER LEAVES THIS FILE. No token, no environment value, no captured
 * stdout. The probe returns `locate.ts`'s own note — a sentence it composed —
 * and the diagnostic excerpt (which is a redacted best effort) is never
 * requested. `ClaudeCodeStatus.executablePath` is a path on the user's own
 * machine and is already part of the contract.
 *
 * EVERY PATH CROSSES THE GUARD. The projects root comes from
 * `resolveProjectsRootInfo`, and the attachment write-probe is placed with
 * `assertInsideRoot` and written to the canonical path the guard returned.
 *
 * Relative `.ts` imports: Node 24 executes this file directly.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';

import {
  deriveDeclarations,
  unprovenDeclarations,
  DEFAULT_CLAUDE_PROBE_FRESHNESS_MS,
} from '../shared/declarations.ts';
import type {
  ActivationObservation,
  AttachmentStagingObservation,
  ClaudeProbeObservation,
  DeclarationInputs,
  ExecutionObservation,
  FixtureSourceObservation,
  MissingProjectPath,
  ProjectsRootObservation,
  RegistryObservation,
  UsageAccuracyObservation,
} from '../shared/declarations.ts';
import { REQUIRED_BIND_ADDRESS } from '../shared/protocol.ts';
import type {
  BridgeHealth,
  ClaudeCodeStatus,
  EvidenceRef,
  RuntimeDeclarations,
  UsageSnapshot,
} from '../shared/protocol.ts';

import type { AttachmentPipeline } from './attachments/pipeline.ts';
import { healthCheck, locateClaudeCode, toClaudeCodeStatus } from './claude/locate.ts';
import type { ClaudeHealth, HealthCheckOptions, LocatedClaude } from './claude/locate.ts';
import type { ProjectRegistry } from './projects/registry.ts';
import { assertInsideRoot, resolveProjectsRootInfo } from './security/paths.ts';
import { directoryExists, ensureDir, fileExists, readTextSafe, writeAtomic } from './storage/atomic.ts';
import type { ForgeStore, StoreStats } from './storage/store.ts';

/* ========================================================================== */
/*  What the server can prove about itself                                     */
/* ========================================================================== */

/**
 * Facts the listener owns. `boundAddress` stays null until the OS has answered,
 * so nothing downstream can report an address the process merely asked for.
 *
 * Declared here rather than in the router because health is what consumes it,
 * and because a type shared by the server, the router and the assembler needs a
 * home that none of the three owns.
 */
export interface BridgeRuntimeFacts {
  readonly boundAddress: string | null;
  readonly boundPort: number | null;
  readonly listening: boolean;
  readonly startedAt: string;
  readonly startedAtMs: number;
}

/* ========================================================================== */
/*  The Claude Code probe                                                      */
/* ========================================================================== */

/** How often the background refresh runs. Shorter than the freshness window. */
export const DEFAULT_CLAUDE_PROBE_INTERVAL_MS = 240_000;

/** Bound on one probe call. Generous: a cold CLI start is not a failure. */
export const DEFAULT_CLAUDE_PROBE_TIMEOUT_MS = 120_000;

export interface ClaudeCodeProbeOptions {
  readonly freshnessWindowMs?: number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  /** Working directory for the probe call. Must be an existing directory. */
  readonly cwd?: string;
  readonly now?: () => number;
  /** TEST-ONLY seam. Replaces the real spawn with a supplied result. */
  readonly runHealthCheck?: (options: HealthCheckOptions) => Promise<ClaudeHealth>;
  readonly onResult?: (health: ClaudeHealth) => void;
}

/**
 * Runs `locate.ts`'s `healthCheck()` on an interval and on demand, and answers
 * with what it last established.
 *
 * `status()` is synchronous and never lies about having checked: before the
 * first probe completes it reports UNVERIFIED and says so. `available: false`
 * from this class means "not proven", never "proven absent" — the note carries
 * which of those it is.
 */
export class ClaudeCodeProbe {
  readonly freshnessWindowMs: number;

  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly runHealthCheck: ((options: HealthCheckOptions) => Promise<ClaudeHealth>) | null;
  private readonly onResult: ((health: ClaudeHealth) => void) | null;

  /** Cached so `--help` is probed once per located runtime, not once per check. */
  private located: LocatedClaude | null = null;
  private last: ClaudeHealth | null = null;
  private lastAtMs: number | null = null;
  private inFlight: Promise<ClaudeHealth> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private probesRun = 0;

  constructor(options: ClaudeCodeProbeOptions = {}) {
    this.freshnessWindowMs = options.freshnessWindowMs ?? DEFAULT_CLAUDE_PROBE_FRESHNESS_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_CLAUDE_PROBE_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_PROBE_TIMEOUT_MS;
    this.cwd = options.cwd ?? process.cwd();
    this.now = options.now ?? (() => Date.now());
    this.runHealthCheck = options.runHealthCheck ?? null;
    this.onResult = options.onResult ?? null;
  }

  /**
   * Probe now.
   *
   * Single-flight: a second caller during a probe joins the first rather than
   * starting a second spawn. Never rejects — a failure to check is itself a
   * result, and it is returned as one.
   */
  refresh(): Promise<ClaudeHealth> {
    if (this.inFlight !== null) return this.inFlight;
    const attempt = this.probe()
      .then((health) => {
        this.last = health;
        this.lastAtMs = this.now();
        this.probesRun += 1;
        this.onResult?.(health);
        return health;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = attempt;
    return attempt;
  }

  /** Start the background refresh and kick off the first probe immediately. */
  start(): void {
    if (this.timer !== null) return;
    const timer = setInterval(() => {
      void this.refresh();
    }, this.intervalMs);
    // A liveness probe must never be the reason a process refuses to exit.
    timer.unref();
    this.timer = timer;
    void this.refresh();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** True when the cached result is inside the freshness window. */
  isFresh(): boolean {
    if (this.lastAtMs === null) return false;
    const age = this.now() - this.lastAtMs;
    return age >= 0 && age <= this.freshnessWindowMs;
  }

  /**
   * The contract shape, from the last completed probe.
   *
   * A stale result keeps the values it measured — they were true at
   * `lastCheckedAt` — and gains a sentence saying how old it is. The derived
   * declaration is what refuses to call a stale success a live connection.
   */
  status(): ClaudeCodeStatus {
    const nowIso = new Date(this.now()).toISOString();
    if (this.last === null) {
      return {
        available: false,
        executablePath: null,
        version: null,
        authenticated: false,
        lastCheckedAt: nowIso,
        supportedFlags: [],
        note:
          this.inFlight === null
            ? 'UNVERIFIED — the Claude Code probe is registered but has not completed a check yet. This is not a claim that Claude Code is absent.'
            : 'UNVERIFIED — a Claude Code probe is running now; no result has come back yet.',
      };
    }
    const base = toClaudeCodeStatus(this.last);
    if (this.isFresh()) return base;
    const ageMs = this.lastAtMs === null ? null : this.now() - this.lastAtMs;
    return {
      ...base,
      note:
        `${base.note ?? 'no note recorded'} STALE — this result is ${ageMs === null ? 'of unknown age' : `${String(ageMs)}ms old`}, ` +
        `beyond the ${String(this.freshnessWindowMs)}ms freshness window; it describes the moment it was taken, not now.`,
    };
  }

  /** The observation the declaration derivation consumes. Null before the first probe. */
  observation(): ClaudeProbeObservation | null {
    if (this.last === null || this.lastAtMs === null) return null;
    return {
      available: this.last.available,
      authenticated: this.last.authenticated,
      failure: this.last.failure,
      checkedAtMs: this.lastAtMs,
      checkedAt: this.last.checkedAt,
      executablePath: this.last.executablePath,
      version: this.last.version,
      sessionObserved: this.last.sessionId !== null,
      note: this.last.note,
    };
  }

  stats(): Record<string, unknown> {
    return {
      probesRun: this.probesRun,
      running: this.timer !== null,
      inFlight: this.inFlight !== null,
      freshnessWindowMs: this.freshnessWindowMs,
      intervalMs: this.intervalMs,
      lastCheckedAt: this.last?.checkedAt ?? null,
      fresh: this.isFresh(),
      executableLocated: this.located !== null,
    };
  }

  private async probe(): Promise<ClaudeHealth> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      if (this.runHealthCheck !== null) {
        return await this.runHealthCheck({ cwd: this.cwd, timeoutMs: this.timeoutMs });
      }
      if (this.located === null) {
        const found = await locateClaudeCode();
        if (found.ok) this.located = found.located;
      }
      return await healthCheck({
        located: this.located ?? undefined,
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      // A probe that could not be attempted proves nothing either way, and is
      // reported as exactly that rather than as an absent runtime.
      return {
        available: false,
        version: null,
        authenticated: false,
        executablePath: this.located?.executablePath ?? null,
        checkedAt,
        supportedFlags: [],
        failure: 'SPAWN_FAILED',
        note: `UNVERIFIED — the probe could not be attempted: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`,
        sessionId: null,
        apiKeySource: null,
        probeExitCode: null,
        probeDurationMs: null,
        diagnosticExcerpt: null,
      };
    }
  }
}

/* ========================================================================== */
/*  Fixture sources                                                            */
/* ========================================================================== */

/**
 * Where a fixture loader must announce itself.
 *
 * `USES_MOCK_DATA` is a claim about the running process, so it needs a runtime
 * signal and not only a source scan. The scan (see the runtime-declarations
 * test) proves no bridge module imports the prototype fixture tree as the code
 * stands; this registry is what a loader added later would have to lie to.
 * Nothing registers with it in this build, which is why the declaration is
 * false — and false is the required value.
 */
export class FixtureSourceRegistry {
  private readonly sources = new Map<string, FixtureSourceObservation>();

  register(id: string, detail: string): void {
    this.sources.set(id, { id, detail });
  }

  unregister(id: string): boolean {
    return this.sources.delete(id);
  }

  list(): readonly FixtureSourceObservation[] {
    return [...this.sources.values()];
  }
}

/* ========================================================================== */
/*  Observers — the looking                                                    */
/* ========================================================================== */

/** How many events one declaration scan will read before it stops counting. */
export const EVENT_SCAN_LIMIT = 5_000;

/** Where the projects root resolves, and what on disk confirmed it. */
export function observeProjectsRoot(): ProjectsRootObservation {
  const info = resolveProjectsRootInfo();
  return {
    projectsRoot: info.projectsRoot,
    documentsDir: info.documentsDir,
    documentsDirExists: info.documentsDirExists,
    source: info.source,
    // Checked every time: the folder can be created or deleted while the bridge
    // runs, and a cached `true` would be a false claim about the user's disk.
    projectsRootExists: directoryExists(info.projectsRoot),
  };
}

/**
 * Ask the canonical index what it holds, and check every recorded path against
 * the filesystem. `loaded` is true only because a list request was answered.
 */
export function observeRegistry(registry: ProjectRegistry): RegistryObservation {
  try {
    const listed = registry.list({ includeArchived: true });
    const pathsMissing: MissingProjectPath[] = [];
    let pathsPresent = 0;
    for (const record of listed.records) {
      const check = registry.existsOnDisk(record);
      if (check.present) pathsPresent += 1;
      else pathsMissing.push({ id: record.id, canonicalPath: record.canonicalPath, detail: check.detail });
    }
    return {
      loaded: true,
      detail: `the registry answered a list request with ${String(listed.records.length)} record(s)`,
      projectsRoot: registry.projectsRoot,
      recordCount: listed.records.length,
      unreadableCount: listed.unreadable.length,
      pathsPresent,
      pathsMissing,
    };
  } catch (err) {
    return {
      loaded: false,
      detail: `the registry could not be read: ${errorText(err)}`,
      projectsRoot: null,
      recordCount: 0,
      unreadableCount: 0,
      pathsPresent: 0,
      pathsMissing: [],
    };
  }
}

/** Agent activations in the durable event log. Counted, never assumed. */
export function observeAgentActivations(store: ForgeStore): ActivationObservation {
  try {
    const page = store.readEvents({ types: ['agent.activated'], limit: EVENT_SCAN_LIMIT });
    let lastAt: string | null = null;
    for (const event of page.events) {
      if (lastAt === null || event.timestamp > lastAt) lastAt = event.timestamp;
    }
    return {
      count: page.events.length,
      lastAt,
      detail:
        page.events.length === 0
          ? 'the event log holds no agent.activated event, so no agent has been observed to run'
          : `counted over ${String(page.streams.length)} stream(s)${page.hasMore ? `; the scan stopped at ${String(EVENT_SCAN_LIMIT)} events, so the real count is higher` : ''}`,
      refs: page.events.slice(-3).map((event) => ({
        kind: 'event' as const,
        ref: event.eventId,
        note: `agent.activated at ${event.timestamp}`,
      })),
    };
  } catch (err) {
    return { count: 0, lastAt: null, detail: `the event log could not be scanned: ${errorText(err)}`, refs: [] };
  }
}

/**
 * Real process executions on record.
 *
 * A run with an OS process id is proof a child actually started. A test
 * execution with an exit code is proof one finished and the code was READ. The
 * two are counted separately because an exit code nobody read is not an outcome.
 */
export function observeProcessExecutions(store: ForgeStore): ExecutionObservation {
  try {
    const runs = store.listRecords('run');
    const tests = store.listRecords('test');
    const refs: EvidenceRef[] = [];
    let spawned = 0;
    let withExitCode = 0;
    let lastAt: string | null = null;

    for (const run of runs.records) {
      if (run.pid !== null) {
        spawned += 1;
        if (refs.length < 3) {
          refs.push({ kind: 'file', ref: `records/run/${run.id}.json`, note: `process ${String(run.pid)} recorded` });
        }
      }
      if (run.exitCode !== null) withExitCode += 1;
      const at = run.endedAt ?? run.updatedAt;
      if (lastAt === null || at > lastAt) lastAt = at;
    }

    for (const execution of tests.records) {
      if (execution.exitCode === null) continue;
      withExitCode += 1;
      if (refs.length < 6) {
        refs.push({
          kind: 'exit-code',
          ref: String(execution.exitCode),
          note: `records/test/${execution.id}.json`,
        });
      }
      const at = execution.endedAt ?? execution.startedAt;
      if (lastAt === null || at > lastAt) lastAt = at;
    }

    return {
      spawned,
      withExitCode,
      lastAt,
      detail:
        spawned === 0 && withExitCode === 0
          ? `no run record carries a process id and no test record carries an exit code (${String(runs.records.length)} run(s), ${String(tests.records.length)} test execution(s) inspected)`
          : `${String(runs.records.length)} run record(s) and ${String(tests.records.length)} test execution(s) inspected`,
      refs,
    };
  } catch (err) {
    return {
      spawned: 0,
      withExitCode: 0,
      lastAt: null,
      detail: `the record store could not be scanned: ${errorText(err)}`,
      refs: [],
    };
  }
}

/**
 * Census of usage accuracy. Only a field Claude Code itself reported counts as
 * EXACT; everything derived, estimated or absent is deliberately not counted.
 */
export function observeUsageSnapshots(snapshots: readonly UsageSnapshot[]): readonly UsageAccuracyObservation[] {
  return snapshots.map((snapshot) => {
    const exactFields: string[] = [];
    let fieldsExamined = 0;
    for (const value of Object.values(snapshot)) {
      if (typeof value !== 'object' || value === null) continue;
      const field = value as { readonly name?: unknown; readonly accuracy?: unknown };
      if (typeof field.name !== 'string' || typeof field.accuracy !== 'string') continue;
      fieldsExamined += 1;
      if (field.accuracy === 'EXACT') exactFields.push(field.name);
    }
    return { scope: snapshot.scope, scopeId: snapshot.scopeId, exactFields, fieldsExamined };
  });
}

/** The marker written by the staging write-probe. Content, so a read proves it. */
const STAGING_PROBE_FILENAME = '.forge-staging-probe';
const STAGING_PROBE_MARKER = 'forge-staging-writable';

/**
 * Prove the staging root is writable by writing to it and reading it back.
 *
 * A directory that exists is not a directory that accepts a write, and
 * `SUPPORTS_FILE_ATTACHMENTS` is a promise the composer relies on. The probe
 * file is placed with `assertInsideRoot` and written to the canonical path the
 * guard returned, then removed.
 */
export function observeAttachmentStaging(
  pipeline: AttachmentPipeline,
  projectRoot: string,
): AttachmentStagingObservation {
  let stagingRoot: string;
  try {
    stagingRoot = pipeline.attachmentsRoot(projectRoot);
  } catch (err) {
    return {
      pipelineRegistered: true,
      stagingRoot: null,
      writable: false,
      detail: `the staging root could not be resolved inside ${projectRoot}: ${errorText(err)}`,
    };
  }

  let probePath: string;
  try {
    ensureDir(stagingRoot);
    probePath = assertInsideRoot(join(stagingRoot, STAGING_PROBE_FILENAME), stagingRoot);
    writeAtomic(probePath, STAGING_PROBE_MARKER);
  } catch (err) {
    return {
      pipelineRegistered: true,
      stagingRoot,
      writable: false,
      detail: `the staging root ${stagingRoot} did not accept a write: ${errorText(err)}`,
    };
  }

  const readBack = readTextSafe(probePath);
  const writable = readBack.ok && readBack.value.trim() === STAGING_PROBE_MARKER;
  try {
    if (fileExists(probePath)) rmSync(probePath, { force: true });
  } catch {
    // The probe file could not be cleaned up. That does not change what the
    // write proved, and it is not worth failing a health read over.
  }

  return {
    pipelineRegistered: true,
    stagingRoot,
    writable,
    detail: writable
      ? `a probe file was written to ${stagingRoot} and read back unchanged`
      : `a probe file was written to ${stagingRoot} but could not be read back unchanged`,
  };
}

/* ========================================================================== */
/*  Collecting the observations                                                */
/* ========================================================================== */

/**
 * Where each observation comes from. Every entry is optional and an omitted one
 * means NOT OBSERVED — which produces a false declaration with that as the
 * stated reason. Nothing is assumed on behalf of a work package that has not
 * registered its source yet.
 */
export interface DeclarationSources {
  readonly claudeProbe?: () => ClaudeProbeObservation | null;
  readonly projectsRoot?: () => ProjectsRootObservation | null;
  readonly registry?: () => RegistryObservation | null;
  readonly agentActivations?: () => ActivationObservation | null;
  readonly processExecutions?: () => ExecutionObservation | null;
  readonly fixtureSources?: () => readonly FixtureSourceObservation[];
  readonly usage?: () => readonly UsageAccuracyObservation[];
  readonly attachments?: () => AttachmentStagingObservation | null;
  readonly claudeProbeFreshnessMs?: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}

/** Call a source, and treat a throw as "not observed" rather than as an outage. */
function fromSource<T>(source: (() => T) | undefined, whenAbsent: T): T {
  if (source === undefined) return whenAbsent;
  try {
    return source();
  } catch {
    return whenAbsent;
  }
}

export function collectDeclarationInputs(sources: DeclarationSources, nowMs: number): DeclarationInputs {
  return {
    now: new Date(nowMs).toISOString(),
    nowMs,
    claudeProbeFreshnessMs: sources.claudeProbeFreshnessMs ?? DEFAULT_CLAUDE_PROBE_FRESHNESS_MS,
    claudeProbe: fromSource(sources.claudeProbe, null),
    projectsRoot: fromSource(sources.projectsRoot, null),
    registry: fromSource(sources.registry, null),
    agentActivations: fromSource(sources.agentActivations, null),
    processExecutions: fromSource(sources.processExecutions, null),
    fixtureSources: fromSource(sources.fixtureSources, []),
    usage: fromSource(sources.usage, []),
    attachments: fromSource(sources.attachments, null),
  };
}

/** Observe, then derive. The only way the bridge produces a declaration report. */
export function computeDeclarations(sources: DeclarationSources, nowMs: number): RuntimeDeclarations {
  return deriveDeclarations(collectDeclarationInputs(sources, nowMs));
}

/* ========================================================================== */
/*  The health snapshot                                                        */
/* ========================================================================== */

/**
 * Everything the assembler needs, already measured by whoever owns it. The
 * assembler performs no I/O of its own beyond what its callers hand it, so what
 * it reports is exactly what was observed.
 */
export interface BridgeHealthInput {
  readonly nowMs: number;
  readonly facts: BridgeRuntimeFacts;
  readonly claudeCode: ClaudeCodeStatus;
  readonly claudeProbeRegistered: boolean;
  readonly declarations: RuntimeDeclarations;
  readonly projectsRoot: ProjectsRootObservation;
  readonly store: StoreStats;
  readonly activeRuns: number;
  readonly unreadableRuns: number;
  readonly connectedClients: number;
  readonly controlEventsDropped: number;
  readonly unregisteredOperations: number;
  readonly auditFailures: number;
}

/**
 * Build the health snapshot.
 *
 * `ok` is a narrow claim on purpose: the bridge is listening where it must and
 * owns the workspace exclusively. Everything else goes in `degraded`, where it
 * can be read rather than collapsed into one boolean — including the derived
 * declarations that could not be established, so a reader of /api/health can
 * never see a positive declaration and an "UNVERIFIED" note in the same body.
 */
export function assembleBridgeHealth(input: BridgeHealthInput): BridgeHealth {
  const facts = input.facts;
  const degraded: string[] = [];

  if (!facts.listening) degraded.push('the HTTP/WebSocket listener is not accepting connections');
  if (facts.boundAddress !== null && facts.boundAddress !== REQUIRED_BIND_ADDRESS) {
    degraded.push(`bound to ${facts.boundAddress}, which is not the required ${REQUIRED_BIND_ADDRESS}`);
  }
  if (!input.store.lockHeld) degraded.push('the workspace lock is not held, so writes are not exclusive');
  if (input.store.degradedNotes > 0) {
    degraded.push(`${String(input.store.degradedNotes)} recorded loss(es) of fidelity in the event log`);
  }
  if (input.unreadableRuns > 0) degraded.push(`${String(input.unreadableRuns)} run record(s) could not be read`);
  if (!input.claudeProbeRegistered) {
    degraded.push('no Claude Code probe is registered; its status is UNVERIFIED');
  } else if (!input.declarations.derived.CONNECTED_TO_CLAUDE_CODE.value) {
    degraded.push(
      `Claude Code is not proven reachable: ${input.declarations.derived.CONNECTED_TO_CLAUDE_CODE.evidence.summary}`,
    );
  }
  if (input.unregisteredOperations > 0) {
    degraded.push(`${String(input.unregisteredOperations)} contract operation(s) have no handler in this build`);
  }
  if (!input.projectsRoot.documentsDirExists) {
    degraded.push(`the Documents directory could not be confirmed (${input.projectsRoot.source})`);
  }
  if (input.auditFailures > 0) {
    degraded.push(`${String(input.auditFailures)} audit ledger line(s) could not be written`);
  }
  if (input.controlEventsDropped > 0) {
    degraded.push(`${String(input.controlEventsDropped)} transport control event(s) were dropped`);
  }

  // `unprovenDeclarations` leaves out USES_MOCK_DATA, whose false IS the
  // required value — listing it as a shortfall would ask an operator to go and
  // fix the one thing that is already right. CONNECTED_TO_CLAUDE_CODE has its
  // own line above with the probe's own words, so it is not repeated here.
  const unproven = unprovenDeclarations(input.declarations).filter(
    (name) => name !== 'CONNECTED_TO_CLAUDE_CODE',
  );
  if (unproven.length > 0) {
    degraded.push(
      `${String(unproven.length)} runtime declaration(s) are UNVERIFIED for want of evidence: ${unproven.join(', ')}`,
    );
  }
  if (input.declarations.derived.USES_MOCK_DATA.value) {
    degraded.push('USES_MOCK_DATA is true: a fixture source is loaded in this process');
  }

  const ok = facts.listening && facts.boundAddress === REQUIRED_BIND_ADDRESS && input.store.lockHeld;

  return {
    ok,
    bindAddress: facts.boundAddress ?? REQUIRED_BIND_ADDRESS,
    port: facts.boundPort ?? 0,
    uptimeMs: input.nowMs - facts.startedAtMs,
    startedAt: facts.startedAt,
    claudeCode: input.claudeCode,
    projectsRoot: input.projectsRoot.projectsRoot,
    projectsRootExists: input.projectsRoot.projectsRootExists,
    activeRuns: input.activeRuns,
    connectedClients: input.connectedClients,
    eventsPersisted: input.store.eventsPersisted,
    lastEventAt: input.store.lastEventAt,
    declarations: input.declarations,
    degraded,
  };
}
