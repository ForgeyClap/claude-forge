/**
 * Forge Workspace — integration test harness.
 *
 * One job: bring the REAL bridge up as a child process in a fully isolated
 * sandbox, hand the test a small typed client for its HTTP + WebSocket surface,
 * and tear it all down cleanly. Nothing here imports a bridge module — the whole
 * point of this suite is to exercise the shipped `node src/bridge/main.ts`
 * exactly as the browser reaches it, over the wire.
 *
 * ISOLATION — the part that must never leak.
 *
 *   Two things decide where the bridge writes: the workspace data directory and
 *   the projects root. The first is honoured from `FORGE_WORKSPACE_DIR`. The
 *   second is NOT an environment variable — the bridge derives it from the OS
 *   home directory (`<home>/Documents/ForgeProjects`) on purpose, so that a
 *   stray env var can never move it. The harness therefore gives the child its
 *   own home directory via `USERPROFILE`/`HOME` and creates a real `Documents`
 *   folder inside it, which is what makes the derived projects root land under a
 *   throwaway temp tree. The real `.forge-workspace` and the real
 *   `Documents/ForgeProjects` are never touched, and the suite asserts this by
 *   proving the reported roots live under the temp base.
 *
 * CREDENTIALS — the one consequence of redirecting home, handled minimally.
 *
 *   Redirecting the home directory also hides Claude Code's own credentials,
 *   which live in the REAL `~/.claude/.credentials.json`. Without them the
 *   bridge's probe reports `authenticated: false` and the single real-run test
 *   skips — correct on a machine with no CLI, but a false negative on an
 *   authenticated one, where the whole point is to prove the streaming path. So
 *   the harness copies exactly one file — that token file — into the isolated
 *   temp home, and nothing else. The copy means Claude Code writes its session
 *   and project state into the TEMP `.claude`, so the real `~/.claude` is never
 *   mutated, and the temp copy is deleted at teardown with the rest of the
 *   sandbox. The token is never read into the test, never logged, and never
 *   leaves the machine. If the source file is absent the copy is skipped and the
 *   run test skips honestly. Pass `bridgeCredentials: false` to opt out entirely.
 *
 * GRACEFUL SHUTDOWN — the Windows problem, solved without touching main.ts.
 *
 *   `child.kill('SIGTERM')` on Windows is a hard TerminateProcess: the bridge's
 *   own SIGINT/SIGTERM handler never runs, so no graceful shutdown, no lock
 *   release. To trigger the REAL shutdown path portably, the child is started
 *   with a tiny `--import` preload (a data: URL, so no extra file on disk) that
 *   watches stdin and, on a sentinel line, calls `process.emit('SIGINT')`. That
 *   invokes the same JS listener `installSignalHandlers` registered — on every
 *   platform — so the process shuts down and exits exactly as a real Ctrl-C
 *   would make it. The preload adds no capability to the bridge; it only relays
 *   a line the test writes into the signal the bridge already handles.
 */

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout as nodeSetTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';
import type { RawData } from 'ws';

import type {
  BridgeHealth,
  ClaudeCodeStatus,
  ForgeEvent,
  OperationName,
  OperationResponse,
} from '../../src/shared/protocol.ts';

/* ========================================================================== */
/*  Locations                                                                  */
/* ========================================================================== */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRIDGE_MAIN = path.join(REPO_ROOT, 'src', 'bridge', 'main.ts');
const BIND = '127.0.0.1';

/** The preload that turns a stdin sentinel into the bridge's own SIGINT path. */
const SHUTDOWN_SHIM =
  'process.stdin.resume();' +
  'process.stdin.on("data",(d)=>{if(String(d).includes("forge-shutdown")){try{process.emit("SIGINT");}catch(e){}}});' +
  'try{process.stdin.unref();}catch(e){}';

function shutdownImportUrl(): string {
  return `data:text/javascript,${encodeURIComponent(SHUTDOWN_SHIM)}`;
}

/* ========================================================================== */
/*  Small async utilities                                                      */
/* ========================================================================== */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    nodeSetTimeout(resolve, ms);
  });
}

/** An ephemeral loopback port the OS just confirmed is free. */
export function acquireEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, BIND, () => {
      const address = server.address() as AddressInfo | null;
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('could not read an ephemeral port from the OS')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/* ========================================================================== */
/*  HTTP results                                                               */
/* ========================================================================== */

export interface HttpJsonResult {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
}

export interface HealthResult {
  readonly status: number;
  readonly health: BridgeHealth | null;
  readonly text: string;
}

export interface OperationResult<R = unknown> {
  readonly httpStatus: number;
  readonly body: OperationResponse<R>;
}

/* ========================================================================== */
/*  A WebSocket client that remembers everything it saw                        */
/* ========================================================================== */

interface EventWaiter {
  readonly predicate: (event: ForgeEvent) => boolean;
  readonly resolve: (event: ForgeEvent) => void;
  readonly timer: ReturnType<typeof nodeSetTimeout>;
}

/**
 * The transport speaks a tiny framed protocol (`hello`, `subscribed`, `event`,
 * `events`, `heartbeat`, `notice`, `response`, `error`). This client cares about
 * `event` frames: it records every one it receives and lets a test wait for the
 * first that matches a predicate.
 */
export class WsClient {
  readonly events: ForgeEvent[] = [];
  readonly frameKinds: string[] = [];

  private readonly ws: WebSocket;
  private readonly waiters = new Set<EventWaiter>();
  private helloSeen = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (data: RawData) => this.onMessage(data));
  }

  static connect(port: number, timeoutMs = 10_000): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${BIND}:${port}/ws`);
      const timer = nodeSetTimeout(() => {
        ws.terminate();
        reject(new Error(`the WebSocket did not open within ${timeoutMs}ms`));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new WsClient(ws));
      });
      ws.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private onMessage(data: RawData): void {
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof frame !== 'object' || frame === null) return;
    const kind = (frame as { kind?: unknown }).kind;
    if (typeof kind !== 'string') return;
    this.frameKinds.push(kind);
    if (kind === 'hello') {
      this.helloSeen = true;
      return;
    }
    if (kind === 'event') {
      const event = (frame as { event?: ForgeEvent }).event;
      if (event === undefined) return;
      this.events.push(event);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(event)) {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          waiter.resolve(event);
        }
      }
    }
  }

  /** Subscribe to every stream and resolve once the server confirms it. */
  subscribeAll(timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = nodeSetTimeout(() => {
        this.ws.off('message', onFrame);
        reject(new Error(`no "subscribed" frame within ${timeoutMs}ms`));
      }, timeoutMs);
      const onFrame = (data: RawData): void => {
        let frame: unknown;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (typeof frame === 'object' && frame !== null && (frame as { kind?: unknown }).kind === 'subscribed') {
          clearTimeout(timer);
          this.ws.off('message', onFrame);
          resolve();
        }
      };
      this.ws.on('message', onFrame);
      this.ws.send(JSON.stringify({ kind: 'subscribe', streams: ['*'] }));
    });
  }

  /** Resolve with the first recorded-or-future event that matches `predicate`. */
  waitForEvent(predicate: (event: ForgeEvent) => boolean, timeoutMs: number): Promise<ForgeEvent> {
    const already = this.events.find(predicate);
    if (already !== undefined) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = nodeSetTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for an event; observed types so far: [${this.events
              .map((e) => e.type)
              .join(', ')}]`,
          ),
        );
      }, timeoutMs);
      const waiter: EventWaiter = { predicate, resolve, timer };
      this.waiters.add(waiter);
    });
  }

  get connectedHello(): boolean {
    return this.helloSeen;
  }

  close(): void {
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters.clear();
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
}

/* ========================================================================== */
/*  The bridge under test                                                      */
/* ========================================================================== */

export interface ReadyInfo {
  readonly bridgeInstanceId: string;
  readonly address: string;
  readonly port: number;
  readonly registeredOperations: readonly string[];
  readonly unregisteredOperations: readonly string[];
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface GracefulShutdownResult extends ExitInfo {
  readonly durationMs: number;
  /** The bridge's own shutdown report, parsed from its stdout. Null if absent. */
  readonly report: Record<string, unknown> | null;
}

export interface StartTestBridgeOptions {
  readonly startupTimeoutMs?: number;
  /**
   * Copy the real `~/.claude/.credentials.json` into the isolated temp home so
   * an authenticated CLI can run the one real run. Default true; the copy is
   * skipped silently when the source file does not exist. See the file header.
   */
  readonly bridgeCredentials?: boolean;
}

/** The single token file Claude Code needs to authenticate a `-p` call. */
const CLAUDE_CREDENTIALS_RELATIVE = ['.claude', '.credentials.json'] as const;

/**
 * Copy ONLY the token file into the sandbox home. Never throws — a failure just
 * means the run test will find the probe unauthenticated and skip.
 */
function bridgeClaudeCredentials(homeDir: string): boolean {
  try {
    const source = path.join(homedir(), ...CLAUDE_CREDENTIALS_RELATIVE);
    if (!existsSync(source)) return false;
    const destDir = path.join(homeDir, CLAUDE_CREDENTIALS_RELATIVE[0]);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(source, path.join(destDir, CLAUDE_CREDENTIALS_RELATIVE[1]));
    return true;
  } catch {
    return false;
  }
}

export class TestBridge {
  readonly port: number;
  readonly baseDir: string;
  readonly homeDir: string;
  readonly documentsDir: string;
  readonly workspaceDir: string;
  /** The projects root the bridge WILL derive from the isolated home. */
  readonly expectedProjectsRoot: string;
  readonly lockFilePath: string;
  /** True when the CLI token file was copied into this sandbox's home. */
  readonly credentialsBridged: boolean;

  private readonly child: ChildProcess;
  private stdoutBuffer = '';
  private pendingLine = '';
  private readyInfo: ReadyInfo | null = null;
  private shutdownReport: Record<string, unknown> | null = null;
  private exitInfo: ExitInfo | null = null;
  private readonly exitWaiters = new Set<(info: ExitInfo) => void>();
  private readonly wsClients = new Set<WsClient>();

  private constructor(
    port: number,
    baseDir: string,
    homeDir: string,
    documentsDir: string,
    workspaceDir: string,
    child: ChildProcess,
    credentialsBridged: boolean,
  ) {
    this.port = port;
    this.baseDir = baseDir;
    this.homeDir = homeDir;
    this.documentsDir = documentsDir;
    this.workspaceDir = workspaceDir;
    this.expectedProjectsRoot = path.join(documentsDir, 'ForgeProjects');
    this.lockFilePath = path.join(workspaceDir, 'bridge.lock');
    this.child = child;
    this.credentialsBridged = credentialsBridged;
    this.wireProcess();
  }

  /* -------------------------------------------------------------- lifecycle */

  static async start(options: StartTestBridgeOptions = {}): Promise<TestBridge> {
    const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;

    const baseDir = mkdtempSync(path.join(tmpdir(), 'forge-itest-'));
    const homeDir = path.join(baseDir, 'home');
    const documentsDir = path.join(homeDir, 'Documents');
    const workspaceDir = path.join(baseDir, 'workspace');
    mkdirSync(documentsDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    // Bridge the CLI token into the sandbox home so an authenticated machine can
    // run the one real run. Skipped on request or when no token file exists.
    const credentialsBridged = options.bridgeCredentials === false ? false : bridgeClaudeCredentials(homeDir);

    const port = await acquireEphemeralPort();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USERPROFILE: homeDir,
      HOME: homeDir,
      FORGE_WORKSPACE_DIR: workspaceDir,
    };
    // OneDrive Known-Folder-Move is discovered by scanning the home dir, not by
    // reading these — but clearing them removes any doubt about where the root
    // lands, and the temp home has no OneDrive folders anyway.
    delete env.OneDrive;
    delete env.OneDriveConsumer;
    delete env.OneDriveCommercial;

    const child = spawn(
      process.execPath,
      ['--import', shutdownImportUrl(), BRIDGE_MAIN, '--port', String(port)],
      { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const bridge = new TestBridge(port, baseDir, homeDir, documentsDir, workspaceDir, child, credentialsBridged);

    // Wait until the listener answers health AND the machine-readable ready line
    // has been parsed — the ready line carries the 39/39 operation census.
    const deadline = Date.now() + startupTimeoutMs;
    let healthy = false;
    while (Date.now() < deadline) {
      if (bridge.exitInfo !== null) {
        throw new Error(
          `the bridge exited during startup (code ${String(bridge.exitInfo.code)}); stdout tail:\n${bridge.stdoutBuffer.slice(-2_000)}`,
        );
      }
      const health = await bridge.getHealth().catch(() => null);
      if (health !== null && health.status === 200) healthy = true;
      if (healthy && bridge.readyInfo !== null) break;
      await delay(200);
    }
    if (!healthy || bridge.readyInfo === null) {
      bridge.forceKill();
      throw new Error(
        `the bridge did not become ready within ${startupTimeoutMs}ms (healthy=${String(healthy)}, readyLine=${String(
          bridge.readyInfo !== null,
        )})`,
      );
    }
    return bridge;
  }

  private wireProcess(): void {
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      // Reassemble complete lines across chunk boundaries before parsing.
      let working = this.pendingLine + chunk;
      let index = working.indexOf('\n');
      while (index !== -1) {
        this.consumeLine(working.slice(0, index).trim());
        working = working.slice(index + 1);
        index = working.indexOf('\n');
      }
      this.pendingLine = working;
    });
    // stderr is the bridge's human log; drained so the pipe never blocks.
    this.child.stderr?.on('data', () => {});
    this.child.on('exit', (code, signal) => {
      const info: ExitInfo = { code, signal };
      this.exitInfo = info;
      for (const waiter of [...this.exitWaiters]) waiter(info);
      this.exitWaiters.clear();
    });
  }

  private consumeLine(line: string): void {
    if (line.length === 0) return;
    if (this.readyInfo === null && line.includes('"event":"bridge.ready"')) {
      try {
        const parsed = JSON.parse(line) as ReadyInfo & { event: string };
        this.readyInfo = {
          bridgeInstanceId: parsed.bridgeInstanceId,
          address: parsed.address,
          port: parsed.port,
          registeredOperations: parsed.registeredOperations,
          unregisteredOperations: parsed.unregisteredOperations,
        };
      } catch {
        // A torn line; the next chunk completes it.
      }
      return;
    }
    if (line.includes('"event":"bridge.shutdown"')) {
      try {
        this.shutdownReport = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // ignore a torn line
      }
    }
  }

  get ready(): ReadyInfo {
    if (this.readyInfo === null) throw new Error('the bridge ready line has not been parsed yet');
    return this.readyInfo;
  }

  get hasExited(): boolean {
    return this.exitInfo !== null;
  }

  get stdout(): string {
    return this.stdoutBuffer;
  }

  /* --------------------------------------------------------------- HTTP */

  private requestJson(method: string, routePath: string, body?: unknown): Promise<HttpJsonResult> {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = { host: `${BIND}:${this.port}`, accept: 'application/json' };
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: BIND, port: this.port, path: routePath, method, headers, timeout: 30_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            resolve({ status: res.statusCode ?? 0, text, json });
          });
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`${method} ${routePath} timed out`));
      });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  async getHealth(): Promise<HealthResult> {
    const result = await this.requestJson('GET', '/api/health');
    const health =
      result.json !== null && typeof result.json === 'object' && typeof (result.json as BridgeHealth).ok === 'boolean'
        ? (result.json as BridgeHealth)
        : null;
    return { status: result.status, health, text: result.text };
  }

  async getDeclarations(): Promise<HttpJsonResult> {
    return this.requestJson('GET', '/api/declarations');
  }

  /** POST one typed operation and return the parsed contract response. */
  async op<R = unknown>(
    op: OperationName,
    payload: unknown,
    opts: { readonly requestId?: string; readonly schemaVersion?: number } = {},
  ): Promise<OperationResult<R>> {
    const envelope = {
      requestId: opts.requestId ?? `req-${randomUUID()}`,
      schemaVersion: opts.schemaVersion ?? 1,
      op,
      payload,
    };
    const result = await this.requestJson('POST', '/api/operation', envelope);
    return { httpStatus: result.status, body: result.json as OperationResponse<R> };
  }

  /* --------------------------------------------------------------- WebSocket */

  async connectWs(): Promise<WsClient> {
    const client = await WsClient.connect(this.port);
    this.wsClients.add(client);
    return client;
  }

  /* --------------------------------------------------------------- Claude probe */

  /**
   * Poll health until the background Claude Code probe has produced a real
   * result, then return that status. Null means the probe never completed inside
   * the window — which the caller treats as "cannot verify", i.e. skip.
   */
  async waitForClaudeProbe(timeoutMs: number): Promise<ClaudeCodeStatus | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const health = await this.getHealth().catch(() => null);
      const status = health?.health?.claudeCode ?? null;
      if (status !== null) {
        const note = status.note ?? '';
        const stillChecking = /has not completed a check yet|probe is running now/.test(note);
        if (status.available === true || !stillChecking) return status;
      }
      await delay(1_000);
    }
    return null;
  }

  /* --------------------------------------------------------------- shutdown */

  waitForExit(timeoutMs: number): Promise<ExitInfo> {
    if (this.exitInfo !== null) return Promise.resolve(this.exitInfo);
    return new Promise((resolve, reject) => {
      const timer = nodeSetTimeout(() => {
        this.exitWaiters.delete(waiter);
        reject(new Error(`the bridge did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = (info: ExitInfo): void => {
        clearTimeout(timer);
        resolve(info);
      };
      this.exitWaiters.add(waiter);
    });
  }

  /**
   * Ask the bridge to shut down the way a Ctrl-C would, and wait for it to exit.
   * Returns the exit code, the elapsed time, and the bridge's own shutdown report.
   */
  async shutdownGraceful(timeoutMs = 20_000): Promise<GracefulShutdownResult> {
    for (const client of this.wsClients) client.close();
    this.wsClients.clear();

    if (this.exitInfo !== null) {
      return { ...this.exitInfo, durationMs: 0, report: this.shutdownReport };
    }
    const started = Date.now();
    this.child.stdin?.write('forge-shutdown\n');
    const info = await this.waitForExit(timeoutMs);
    return { ...info, durationMs: Date.now() - started, report: this.shutdownReport };
  }

  forceKill(): void {
    for (const client of this.wsClients) client.close();
    this.wsClients.clear();
    try {
      this.child.kill();
    } catch {
      // already gone
    }
  }

  /** Remove the throwaway sandbox. Safe to call after the child has exited. */
  cleanup(): void {
    try {
      rmSync(this.baseDir, { recursive: true, force: true });
    } catch {
      // Windows may hold a handle briefly; a leftover temp dir is harmless.
    }
  }

  lockExists(): boolean {
    return existsSync(this.lockFilePath);
  }
}

/** The one call a test makes to get a running, isolated bridge. */
export async function startTestBridge(options?: StartTestBridgeOptions): Promise<TestBridge> {
  return TestBridge.start(options);
}
