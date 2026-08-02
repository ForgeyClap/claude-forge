/**
 * Forge Workspace — bridge entry point.
 *
 *   node src/bridge/main.ts              start the bridge
 *   node src/bridge/main.ts --health     probe a running bridge and exit
 *   node src/bridge/main.ts --print-config
 *
 * Node 24 executes TypeScript directly, so there is no build step and no
 * transpiled copy that could drift from this source. Local imports carry an
 * explicit `.ts` extension because that is what the runtime resolves.
 *
 * THE STARTUP ORDER IS THE POINT, and every step of it is a check rather than
 * an assumption:
 *
 *   1. Load the config. A refusal here (someone tried to move the bind address
 *      with an env var) stops the process before a socket exists.
 *   2. Open the store, which takes the exclusive workspace lock. Two bridges
 *      interleaving appends into one JSONL log is unrecoverable corruption, so
 *      failing to get the lock is fatal, not a warning.
 *   3. Reconcile. Every run that still claims RUNNING from a previous process
 *      is moved to INTERRUPTED or ORPHANED — never to COMPLETED. A process we
 *      cannot prove finished did not finish.
 *   4. Listen, and verify the address the OS actually bound.
 *   5. Only then publish `bridge.ready`, carrying the bound address and port as
 *      its own evidence. The event is a claim, and it is made after the claim
 *      became true, not before.
 *
 * Exit codes: 0 clean · 2 configuration refused · 3 workspace lock unavailable ·
 * 4 could not listen · 5 unexpected failure.
 */

import { request as httpRequest } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import { pathToFileURL } from 'node:url';

import { explainDeclarations, unprovenDeclarations } from '../shared/declarations.ts';
import { INVARIANT_DECLARATIONS, PROTOCOL_SCHEMA_VERSION, REQUIRED_BIND_ADDRESS } from '../shared/protocol.ts';
import type { BridgeHealth } from '../shared/protocol.ts';

import { createAttachmentPipeline } from './attachments/pipeline.ts';
import { describeConfig, loadConfig, PORT_MAX, PORT_MIN } from './config.ts';
import type { BridgeConfig } from './config.ts';
import {
  ClaudeCodeProbe,
  FixtureSourceRegistry,
  observeAgentActivations,
  observeAttachmentStaging,
  observeProcessExecutions,
  observeProjectsRoot,
  observeRegistry,
  observeUsageSnapshots,
} from './health.ts';
import { ProjectRegistry } from './projects/registry.ts';
import { reconcileWorkspace } from './recovery.ts';
import { Router } from './router.ts';
import { BridgeServer, ROUTE_HEALTH } from './server.ts';
import type { ShutdownReport } from './server.ts';
import { DEFAULT_LOCK_STALE_MS, ensureDir } from './storage/atomic.ts';
import { BRIDGE_PROJECT_ID, openStore, StoreLockError } from './storage/store.ts';
import type { ForgeStore } from './storage/store.ts';
import { createStoreSink, Transport } from './transport.ts';

export const EXIT_OK = 0;
export const EXIT_CONFIG_REFUSED = 2;
export const EXIT_LOCK_UNAVAILABLE = 3;
export const EXIT_LISTEN_FAILED = 4;
export const EXIT_UNEXPECTED = 5;

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/* ========================================================================== */
/*  Arguments                                                                  */
/* ========================================================================== */

export interface ParsedArgs {
  readonly mode: 'serve' | 'health' | 'print-config' | 'help';
  readonly port: number | null;
  readonly errors: readonly string[];
}

/**
 * A deliberately tiny parser. No flag takes a free-form string that is later
 * interpreted; the only value accepted is an integer port, and it is range
 * checked here rather than passed on to be trusted.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let mode: ParsedArgs['mode'] = 'serve';
  let port: number | null = null;
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--health':
        mode = 'health';
        break;
      case '--print-config':
        mode = 'print-config';
        break;
      case '--help':
      case '-h':
        mode = 'help';
        break;
      case '--port': {
        const raw = argv[i + 1];
        i += 1;
        if (raw === undefined || !/^\d{1,5}$/.test(raw)) {
          errors.push('--port needs a whole number.');
          break;
        }
        const value = Number(raw);
        if (value < PORT_MIN || value > PORT_MAX) {
          errors.push(`--port must be between ${PORT_MIN} and ${PORT_MAX}.`);
          break;
        }
        port = value;
        break;
      }
      default:
        errors.push(`Unknown argument ${JSON.stringify(arg.slice(0, 40))}.`);
    }
  }

  return { mode, port, errors };
}

const HELP = `Forge Workspace bridge

  node src/bridge/main.ts [--port <n>]     start the bridge on 127.0.0.1
  node src/bridge/main.ts --health         probe a running bridge, print JSON
  node src/bridge/main.ts --print-config   print the resolved config, then exit

The bind address, LAN mode and remote access are compile-time constants in
src/bridge/config.ts and cannot be changed from the command line or the
environment.

Exit codes: 0 clean, 2 config refused, 3 workspace lock unavailable,
4 could not listen, 5 unexpected failure.`;

/* ========================================================================== */
/*  Health probe                                                               */
/* ========================================================================== */

export interface HealthProbeResult {
  readonly probe: 'bridge:health';
  readonly target: string;
  readonly checkedAt: string;
  readonly reachable: boolean;
  readonly httpStatus: number | null;
  readonly verdict: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
  readonly health: BridgeHealth | null;
  readonly error: string | null;
}

/**
 * Ask a running bridge how it is.
 *
 * This makes no claim of its own: it reports the HTTP status it got and the
 * body the bridge returned. If nothing answers, the verdict is UNAVAILABLE —
 * which is a fact about the probe, not a diagnosis of the bridge, and is worded
 * that way on purpose.
 */
export function probeHealth(port: number, timeoutMs = 5_000): Promise<HealthProbeResult> {
  const target = `http://${REQUIRED_BIND_ADDRESS}:${port}${ROUTE_HEALTH}`;
  const checkedAt = new Date().toISOString();

  return new Promise((resolve) => {
    const done = (result: Omit<HealthProbeResult, 'probe' | 'target' | 'checkedAt'>): void => {
      resolve({ probe: 'bridge:health', target, checkedAt, ...result });
    };

    const req = httpRequest(
      {
        host: REQUIRED_BIND_ADDRESS,
        port,
        path: ROUTE_HEALTH,
        method: 'GET',
        // No Origin header: this is not a browser, and the bridge's Origin check
        // is written to allow exactly that case.
        headers: { host: `${REQUIRED_BIND_ADDRESS}:${port}`, accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > 4_194_304) {
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const status = res.statusCode ?? null;
          let health: BridgeHealth | null = null;
          let error: string | null = null;
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof parsed === 'object' && parsed !== null && typeof (parsed as BridgeHealth).ok === 'boolean') {
              health = parsed as BridgeHealth;
            } else {
              error = 'the response body was not a BridgeHealth object';
            }
          } catch {
            error = 'the response body was not valid JSON';
          }
          done({
            reachable: true,
            httpStatus: status,
            verdict: health === null ? 'UNAVAILABLE' : health.ok ? 'HEALTHY' : 'DEGRADED',
            health,
            error,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      done({
        reachable: false,
        httpStatus: null,
        verdict: 'UNAVAILABLE',
        health: null,
        error: `no response within ${timeoutMs}ms`,
      });
    });
    req.on('error', (err: Error) => {
      done({
        reachable: false,
        httpStatus: null,
        verdict: 'UNAVAILABLE',
        health: null,
        // ECONNREFUSED here means "nothing is listening on that port", which is
        // reported as exactly that rather than as "the bridge is unhealthy".
        error: err.message.slice(0, 200),
      });
    });
    req.end();
  });
}

/* ========================================================================== */
/*  Boot                                                                       */
/* ========================================================================== */

export interface RunningBridge {
  readonly config: BridgeConfig;
  readonly store: ForgeStore;
  readonly transport: Transport;
  readonly router: Router;
  readonly server: BridgeServer;
  readonly address: string;
  readonly port: number;
  readonly bridgeInstanceId: string;
  shutdown(reason: string): Promise<ShutdownReport>;
}

export interface StartOptions {
  readonly config: BridgeConfig;
  readonly log?: (line: string) => void;
}

/**
 * Bring the whole bridge up. Exported so a test can boot one without going
 * through the CLI.
 */
export async function startBridge(options: StartOptions): Promise<RunningBridge> {
  const config = options.config;
  const write = options.log ?? log;

  // --- store: exclusive lock, then crash recovery -------------------------
  const store = openStore(config.dataDir === null ? {} : { dataDir: config.dataDir });
  const bridgeInstanceId = store.bridgeInstanceId;
  write(`[bridge] workspace ${store.dataDir}`);
  write(`[bridge] instance ${bridgeInstanceId}`);

  // --- the canonical project index ----------------------------------------
  //
  // Constructed BEFORE reconciliation, for two reasons. It is what
  // CONNECTED_TO_FORGE is a statement about — a registry that actually answered,
  // not one that merely exists in the source tree — and recovery needs it to
  // stat every project folder and flag one that moved or vanished as MISSING. A
  // failure to construct it is recorded, the declaration stays false, and the
  // bridge still starts; it is never a reason to refuse.
  const rootInfo = observeProjectsRoot();
  let registry: ProjectRegistry | null = null;
  try {
    registry = new ProjectRegistry(store, { projectsRoot: rootInfo.projectsRoot });
  } catch (err) {
    write(
      `[bridge] the project registry could not be constructed (${err instanceof Error ? err.message : String(err)}); ` +
        'CONNECTED_TO_FORGE will report false',
    );
  }

  // --- reconcile: the startup recovery drills -----------------------------
  //
  // The store half moves every run that still claims RUNNING to INTERRUPTED or
  // ORPHANED (never COMPLETED) and drops any truncated final log line; the
  // workspace half flags a project whose folder is gone as MISSING and upgrades
  // an interrupted run that carries a resumable session to RESUMABLE.
  const recovery = reconcileWorkspace({ store, registry });
  const reconciliation = recovery.store;
  write(
    `[bridge] reconciled ${reconciliation.runsInspected} run record(s); ` +
      `${reconciliation.reconciled.length} moved out of a live status; ` +
      `${recovery.runs.resumable.length} marked RESUMABLE; ` +
      `${recovery.projects.missing.length} project folder(s) MISSING; ` +
      `${reconciliation.gaps.length} stream(s) with sequence gaps; ` +
      `${recovery.truncatedEventLines.length} truncated log line(s) dropped; ` +
      `${reconciliation.corruption.length} degraded note(s)`,
  );
  for (const item of reconciliation.reconciled) {
    write(`[bridge]   run ${item.runId}: ${item.from} -> ${item.to} (${item.reason})`);
  }
  for (const item of recovery.runs.resumable) {
    write(`[bridge]   run ${item.runId}: INTERRUPTED -> RESUMABLE (${item.reason})`);
  }
  for (const item of recovery.projects.missing) {
    write(`[bridge]   project ${item.id} (${item.displayName}): health MISSING — ${item.detail}`);
  }
  for (const note of recovery.notes) {
    write(`[bridge]   recovery note: ${note}`);
  }

  // --- transport ----------------------------------------------------------
  const transport = new Transport({
    sink: createStoreSink(store),
    bridgeInstanceId,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    declarations: INVARIANT_DECLARATIONS,
    protocolSchemaVersion: PROTOCOL_SCHEMA_VERSION,
    bridgeProjectId: BRIDGE_PROJECT_ID,
  });

  // --- Claude Code probe ---------------------------------------------------
  //
  // Started below, once the listener is up. Until its first real `-p` call
  // comes back, `status()` reports UNVERIFIED and the derived declaration
  // CONNECTED_TO_CLAUDE_CODE stays false — which is the truth, not a
  // placeholder to be filled in optimistically.
  const claudeProbe = new ClaudeCodeProbe({ cwd: process.cwd() });

  // Nothing loads fixtures in this build. The registry exists so that anything
  // which ever does has to say so, and USES_MOCK_DATA can answer from the
  // running process instead of from a promise.
  const fixtureSources = new FixtureSourceRegistry();

  // --- router -------------------------------------------------------------
  // `runtimeFacts` is a function, not a snapshot: health must report what is
  // true when it is asked, not what was true at construction. The declaration
  // sources are functions for the same reason.
  let serverRef: BridgeServer | null = null;
  const router = new Router({
    store,
    events: transport,
    config,
    bridgeInstanceId,
    claudeProbe: () => claudeProbe.status(),
    declarationSources: {
      claudeProbeFreshnessMs: claudeProbe.freshnessWindowMs,
      claudeProbe: () => claudeProbe.observation(),
      projectsRoot: () => observeProjectsRoot(),
      registry: () => (registry === null ? null : observeRegistry(registry)),
      agentActivations: () => observeAgentActivations(store),
      processExecutions: () => observeProcessExecutions(store),
      fixtureSources: () => fixtureSources.list(),
      // usage and attachments are wired just below, once the router exists: the
      // usage source reads the router's own UsageOperations (not a second
      // aggregator), and the attachment source needs a pipeline and a probe root.
    },
    runtimeFacts: () =>
      serverRef === null
        ? { boundAddress: null, boundPort: null, listening: false, startedAt: new Date().toISOString(), startedAtMs: Date.now() }
        : serverRef.runtimeFacts(),
  });

  // --- the last two declaration observers ---------------------------------
  //
  // USES_REAL_USAGE_TELEMETRY reads the router's OWN usage operations, so the
  // declaration counts EXACT fields from the same rebuild `getUsageState`
  // serves — one aggregator, one source of truth.
  //
  // SUPPORTS_FILE_ATTACHMENTS proves the staging pipeline can actually resolve a
  // staging root and write to it, by running the real write-and-read-back probe
  // against a bridge-owned directory inside the workspace. It is deliberately
  // NOT a user's project: the probe runs on every health read, and the claim is
  // about the pipeline's capability, not about polluting someone's project tree.
  // A false here is still honest — a disk that stopped accepting writes flips it.
  const attachmentPipeline = createAttachmentPipeline();
  const attachmentProbeRoot = resolvePath(store.dataDir, 'recovery', 'attachment-probe');
  router.setDeclarationSources({
    usage: () => observeUsageSnapshots(router.usageOperations().observeSnapshots()),
    attachments: () => {
      // `attachmentsRoot` canonicalises the project root, which requires it to
      // exist; created here (idempotent) so a probe never fails for want of the
      // folder it is about to write into.
      ensureDir(attachmentProbeRoot);
      return observeAttachmentStaging(attachmentPipeline, attachmentProbeRoot);
    },
  });

  // --- server -------------------------------------------------------------
  const server = new BridgeServer({
    config,
    router,
    transport,
    log: write,
    closeStore: () => {
      const heldBefore = store.lockHeld;
      let flushed = 0;
      try {
        flushed = store.flushDegradedNotes();
      } catch {
        // The log is unwritable. Counted as zero flushed, which is the truth.
      }
      store.close();
      return { degradedNotesFlushed: flushed, lockReleased: heldBefore && !store.lockHeld };
    },
  });
  serverRef = server;

  transport.start();
  const bound = await server.listen();

  // --- start probing Claude Code ------------------------------------------
  //
  // After the listener is up, so a slow first probe never delays serving. The
  // interval is unref'd and the probe is stopped on shutdown; a liveness check
  // must never be the reason a process refuses to exit.
  server.registerShutdownTask({
    name: 'claude-code-probe',
    run: () => {
      claudeProbe.stop();
    },
    timeoutMs: 1_000,
  });
  claudeProbe.start();

  // --- ready --------------------------------------------------------------
  // Published only now, and carrying the address the OS reported as its own
  // evidence. Publishing on `listen()` being CALLED would be a claim about an
  // intention; this is a claim about a result.
  transport.publish({
    projectId: BRIDGE_PROJECT_ID,
    runId: null,
    source: 'bridge',
    type: 'bridge.ready',
    status: 'RUNNING',
    payload: {
      bridgeInstanceId,
      boundAddress: bound.address,
      boundPort: bound.port,
      protocolSchemaVersion: PROTOCOL_SCHEMA_VERSION,
      // The BUILD's invariants. The derived half is deliberately not in this
      // event: `bridge.ready` is a durable record of one moment, and a replayed
      // claim about a live system would be read back as if it were still true.
      declarations: INVARIANT_DECLARATIONS,
      config: describeConfig(config),
      reconciliation: {
        runsInspected: reconciliation.runsInspected,
        reconciled: reconciliation.reconciled.length,
        resumable: recovery.runs.resumable.length,
        projectsMissing: recovery.projects.missing.length,
        truncatedEventLines: recovery.truncatedEventLines.length,
        gaps: reconciliation.gaps.length,
        degradedNotes: reconciliation.corruption.length,
      },
      node: process.version,
      pid: process.pid,
    },
    evidenceRefs: [
      { kind: 'event', ref: `listen:${bound.address}:${bound.port}`, note: 'address reported by the OS after bind' },
    ],
  });

  // --- lock heartbeat -----------------------------------------------------
  //
  // The lock file has a staleness window; another process is entitled to take it
  // over if this one stops refreshing. If a renewal fails the lock is gone or is
  // now foreign, which means a second writer may be appending to the same logs.
  // That is the corruption the lock exists to prevent, so the honest response is
  // to stop, not to carry on writing.
  const renewEveryMs = Math.max(2_000, Math.floor(DEFAULT_LOCK_STALE_MS / 3));
  const lockTimer = setInterval(() => {
    if (store.renewLockHeartbeat()) return;
    clearInterval(lockTimer);
    write('[bridge] FATAL: the workspace lock could not be renewed; another process may own it. Shutting down.');
    try {
      transport.publish({
        projectId: BRIDGE_PROJECT_ID,
        runId: null,
        source: 'bridge',
        type: 'bridge.degraded',
        status: 'DEGRADED',
        payload: {
          scope: 'workspace-lock',
          reason: 'lock.renewal-failed',
          detail:
            'the workspace lock is no longer held by this instance; continuing to write could interleave ' +
            'appends with another bridge and corrupt the event log',
        },
        evidenceRefs: [{ kind: 'file', ref: 'bridge.lock' }],
      });
    } catch {
      // Nowhere left to record it. The stderr line above is the only signal.
    }
    void server.shutdown('workspace lock lost');
  }, renewEveryMs);
  lockTimer.unref();

  return {
    config,
    store,
    transport,
    router,
    server,
    address: bound.address,
    port: bound.port,
    bridgeInstanceId,
    shutdown: (reason: string) => {
      clearInterval(lockTimer);
      return server.shutdown(reason);
    },
  };
}

/* ========================================================================== */
/*  CLI                                                                        */
/* ========================================================================== */

export async function mainCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.errors.length > 0) {
    for (const error of args.errors) log(`[bridge] ${error}`);
    log(HELP);
    return EXIT_CONFIG_REFUSED;
  }
  if (args.mode === 'help') {
    process.stdout.write(`${HELP}\n`);
    return EXIT_OK;
  }

  const loaded = loadConfig();
  if (!loaded.ok) {
    log('[bridge] REFUSING TO START — the configuration was rejected:');
    for (const error of loaded.errors) log(`[bridge]   - ${error}`);
    return EXIT_CONFIG_REFUSED;
  }
  for (const warning of loaded.warnings) log(`[bridge] warning: ${warning}`);

  const config: BridgeConfig = args.port === null ? loaded.config : { ...loaded.config, port: args.port };

  if (args.mode === 'print-config') {
    process.stdout.write(`${JSON.stringify(describeConfig(config), null, 2)}\n`);
    return EXIT_OK;
  }

  if (args.mode === 'health') {
    const result = await probeHealth(config.port);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.verdict === 'HEALTHY') return EXIT_OK;
    // Reachable but not ok, or not reachable at all. Both are failures for a
    // health gate, and the JSON above says which.
    return result.reachable ? 1 : 2;
  }

  let running: RunningBridge;
  try {
    running = await startBridge({ config });
  } catch (err) {
    if (err instanceof StoreLockError) {
      log('[bridge] REFUSING TO START — another bridge instance holds the workspace lock.');
      log(`[bridge]   ${err.message}`);
      if (err.heldBy !== null) {
        log(`[bridge]   held by pid ${err.heldBy.pid} (${err.heldBy.owner}) since ${err.heldBy.acquiredAt}`);
      }
      return EXIT_LOCK_UNAVAILABLE;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/EADDRINUSE|EACCES|listen|bind/i.test(message)) {
      log(`[bridge] could not listen on ${REQUIRED_BIND_ADDRESS}:${config.port} — ${message}`);
      return EXIT_LISTEN_FAILED;
    }
    log(`[bridge] failed to start: ${message}`);
    return EXIT_UNEXPECTED;
  }

  const routerStats = running.router.stats();
  log(`[bridge] listening on http://${running.address}:${running.port}`);
  log(`[bridge]   API      POST http://${running.address}:${running.port}/api/operation`);
  log(`[bridge]   health   GET  http://${running.address}:${running.port}${ROUTE_HEALTH}`);
  log(`[bridge]   events   ws://${running.address}:${running.port}/ws`);
  log(`[bridge]   LAN_MODE=${INVARIANT_DECLARATIONS.LAN_MODE} REMOTE_ACCESS=${INVARIANT_DECLARATIONS.REMOTE_ACCESS}`);
  log(
    `[bridge]   operations ${routerStats.registeredOperations.length}/${
      routerStats.registeredOperations.length + routerStats.unregisteredOperations.length
    } registered`,
  );
  if (routerStats.unregisteredOperations.length > 0) {
    // Said out loud at startup rather than discovered later as a mystery error.
    log(`[bridge]   NOT YET IMPLEMENTED: ${routerStats.unregisteredOperations.join(', ')}`);
  }

  // The derived declarations, as they stand at startup. Said out loud for the
  // same reason as the unimplemented operations: an unproven claim that nobody
  // mentions is one somebody will later assume was proven. At this point the
  // first Claude Code probe has almost certainly not returned yet, so
  // CONNECTED_TO_CLAUDE_CODE being false here means "not checked yet".
  const startupDeclarations = running.router.declarationReport();
  const unproven = new Set<string>(unprovenDeclarations(startupDeclarations));
  for (const explanation of explainDeclarations(startupDeclarations)) {
    if (!unproven.has(explanation.name)) continue;
    log(`[bridge]   UNVERIFIED ${explanation.name}: ${explanation.reason}`);
  }
  if (startupDeclarations.derived.USES_MOCK_DATA.value) {
    log(`[bridge]   USES_MOCK_DATA: ${startupDeclarations.derived.USES_MOCK_DATA.evidence.summary}`);
  }

  // One machine-readable line on stdout, so a supervisor can wait for it.
  process.stdout.write(
    `${JSON.stringify({
      event: 'bridge.ready',
      bridgeInstanceId: running.bridgeInstanceId,
      address: running.address,
      port: running.port,
      protocolSchemaVersion: PROTOCOL_SCHEMA_VERSION,
      registeredOperations: routerStats.registeredOperations,
      unregisteredOperations: routerStats.unregisteredOperations,
    })}\n`,
  );

  return await new Promise<number>((resolve) => {
    running.server.installSignalHandlers((report) => {
      log(
        `[bridge] shutdown ${report.clean ? 'clean' : 'INCOMPLETE'} in ${report.durationMs}ms — ` +
          `${report.clientsClosed} client(s) closed, lock ${report.lockReleased ? 'released' : 'NOT released'}`,
      );
      for (const task of report.tasks) {
        if (task.state !== 'COMPLETED') log(`[bridge]   task ${task.name}: ${task.state} — ${task.detail ?? ''}`);
      }
      process.stdout.write(`${JSON.stringify({ event: 'bridge.shutdown', ...report })}\n`);
      resolve(report.clean ? EXIT_OK : EXIT_UNEXPECTED);
    });
  });
}

/* ========================================================================== */
/*  Direct invocation                                                          */
/* ========================================================================== */

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  try {
    return pathToFileURL(resolvePath(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  mainCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      log(`[bridge] unexpected failure: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exitCode = EXIT_UNEXPECTED;
    });
}
