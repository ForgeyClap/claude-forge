/**
 * Forge Workspace — the HTTP and WebSocket listener.
 *
 * This is the only place in the system where something from outside the process
 * gets in, so it is the place where every assumption has to be checked rather
 * than believed.
 *
 * WHAT IT REFUSES, AND WHY
 *
 *  Not 127.0.0.1  The bind address is asserted against the contract's
 *                 `REQUIRED_BIND_ADDRESS` before `listen` is called AND
 *                 re-checked against what the OS actually reported afterwards.
 *                 Calling `listen('127.0.0.1')` is an intention; `address()`
 *                 returning `127.0.0.1` is evidence. If they disagree the
 *                 server closes itself rather than serve from an address it did
 *                 not intend.
 *
 *  A foreign Origin  Browsers always send `Origin` on a WebSocket handshake and
 *                 on a cross-origin fetch. A page the user did not open cannot
 *                 forge it. Requests with an Origin that is not a known
 *                 loopback origin are rejected before the socket is upgraded.
 *                 A MISSING Origin is allowed: it means a non-browser client on
 *                 this machine (the health probe, a test), which cannot be a
 *                 hostile web page. That distinction is the whole check.
 *
 *  A foreign Host  DNS rebinding: an attacker points `evil.example` at
 *                 127.0.0.1 so the browser treats the bridge as same-origin.
 *                 Those requests carry `Host: evil.example` and are refused.
 *
 *  An oversized body  Read with a running byte count and aborted the moment it
 *                 passes the limit. The limit is enforced while reading, not
 *                 after — checking `Content-Length` alone lets a chunked body
 *                 lie about its size.
 *
 * WHAT IT SERVES. The API and the WebSocket upgrade. No static files, no
 * directory listing, no fallback route. Vite serves the UI; a bridge that also
 * served files would be a second, subtler filesystem surface.
 *
 * SHUTDOWN. On SIGINT/SIGTERM the server stops accepting, tells clients, runs
 * every registered shutdown task under a timeout, then releases the workspace
 * lock. Each task's outcome is recorded as completed, failed or TIMED OUT —
 * a task that did not finish is never reported as though it had.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
// node:timers rather than the ambient globals: the DOM lib and @types/node
// declare different return types for setTimeout, and `unref()` only exists on
// Node's. Importing removes the ambiguity.
import { clearTimeout, setTimeout } from 'node:timers';

import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';

import { INVARIANT_DECLARATIONS, REQUIRED_BIND_ADDRESS } from '../shared/protocol.ts';
import type { OperationError } from '../shared/protocol.ts';

import type { BridgeConfig } from './config.ts';
import { isLocalHostHeader, isLocalOrigin } from './config.ts';
import type { BridgeRuntimeFacts, Router } from './router.ts';
import { BRIDGE_PROJECT_ID } from './storage/store.ts';
import type { Transport, TransportSocket } from './transport.ts';

/* ========================================================================== */
/*  Bounded waiting                                                            */
/* ========================================================================== */

/**
 * Run `fn` with a deadline and report which of the two happened.
 *
 * A timeout is NOT treated as completion. The distinction matters at shutdown:
 * a run-cancel task that timed out may have left a Claude Code child alive, and
 * the report has to say so rather than round it up to "clean".
 */
async function runWithDeadline(
  fn: () => Promise<void> | void,
  ms: number,
): Promise<'COMPLETED' | 'TIMED_OUT'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'TIMED_OUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMED_OUT'), ms);
    timer.unref();
  });
  try {
    return await Promise.race([Promise.resolve(fn()).then((): 'COMPLETED' => 'COMPLETED'), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* ========================================================================== */
/*  Paths and limits                                                           */
/* ========================================================================== */

export const ROUTE_HEALTH = '/api/health';
export const ROUTE_DECLARATIONS = '/api/declarations';
export const ROUTE_OPERATION = '/api/operation';
export const ROUTE_WEBSOCKET = '/ws';

/** Slowloris bounds. Generous for a local client, finite for a hostile one. */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MAX_HEADERS = 64;

/* ========================================================================== */
/*  Shutdown tasks                                                             */
/* ========================================================================== */

/**
 * Work that must finish before the process exits — cancelling a run, killing a
 * child process, flushing a writer. Registered by whichever work package owns
 * the resource; the server only guarantees they are called, bounded, and that
 * their real outcome is recorded.
 */
export interface ShutdownTask {
  readonly name: string;
  readonly run: (reason: string) => Promise<void> | void;
  readonly timeoutMs?: number;
}

export interface ShutdownTaskOutcome {
  readonly name: string;
  readonly state: 'COMPLETED' | 'FAILED' | 'TIMED_OUT';
  readonly durationMs: number;
  readonly detail: string | null;
}

export interface ShutdownReport {
  readonly reason: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly tasks: readonly ShutdownTaskOutcome[];
  readonly clientsClosed: number;
  readonly socketsDestroyed: number;
  readonly degradedNotesFlushed: number;
  readonly lockReleased: boolean;
  /** False when any task failed or timed out — i.e. cleanup is NOT guaranteed. */
  readonly clean: boolean;
}

/* ========================================================================== */
/*  Server                                                                     */
/* ========================================================================== */

export interface BridgeServerOptions {
  readonly config: BridgeConfig;
  readonly router: Router;
  readonly transport: Transport;
  /** Called on shutdown to flush and release the workspace lock. */
  readonly closeStore: () => { readonly degradedNotesFlushed: number; readonly lockReleased: boolean };
  readonly now?: () => number;
  /** Where operational lines go. Defaults to stderr, so stdout stays parseable. */
  readonly log?: (line: string) => void;
}

export class BridgeServer {
  private readonly config: BridgeConfig;
  private readonly router: Router;
  private readonly transport: Transport;
  private readonly closeStore: BridgeServerOptions['closeStore'];
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private readonly httpServer: Server;
  private readonly wss: WebSocketServer;
  private readonly sockets = new Set<Socket>();
  private readonly shutdownTasks: ShutdownTask[] = [];

  private readonly startedAtMs: number;
  private readonly startedAtIso: string;

  private boundAddress: string | null = null;
  private boundPort: number | null = null;
  private listening = false;
  private shuttingDown = false;
  private shutdownPromise: Promise<ShutdownReport> | null = null;

  private requestsHandled = 0;
  private requestsRejected = 0;
  private upgradesAccepted = 0;
  private upgradesRejected = 0;

  constructor(options: BridgeServerOptions) {
    this.config = options.config;
    this.router = options.router;
    this.transport = options.transport;
    this.closeStore = options.closeStore;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));

    this.startedAtMs = this.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();

    // The refusal happens before a socket can exist. `loadConfig` cannot produce
    // a config with another address, so reaching this throw means the code was
    // edited — which is precisely the case that should stop, loudly.
    if (this.config.bindAddress !== REQUIRED_BIND_ADDRESS) {
      throw new Error(
        `refusing to start: the bridge may only bind ${REQUIRED_BIND_ADDRESS}, but the config says ` +
          `${JSON.stringify(this.config.bindAddress)}`,
      );
    }
    if (this.config.lanMode !== false || this.config.remoteAccess !== false) {
      throw new Error('refusing to start: LAN_MODE and REMOTE_ACCESS must both be false');
    }
    if (INVARIANT_DECLARATIONS.BIND_ADDRESS !== REQUIRED_BIND_ADDRESS) {
      throw new Error('refusing to start: INVARIANT_DECLARATIONS.BIND_ADDRESS disagrees with REQUIRED_BIND_ADDRESS');
    }

    this.httpServer = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
    this.httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
    this.httpServer.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    this.httpServer.maxHeadersCount = MAX_HEADERS;

    this.httpServer.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.config.maxRequestBytes,
      // Compression is a CPU amplifier a client controls. Frames here are small
      // JSON over loopback; there is nothing to gain and a zip bomb to lose.
      perMessageDeflate: false,
    });

    this.httpServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });

    this.transport.setRequestHandler((clientId, request) =>
      this.router.dispatch(request, 'websocket', clientId),
    );
  }

  /* ------------------------------------------------------------------ facts */

  /**
   * What the server can prove about itself. `boundAddress` stays null until the
   * OS has answered, so nothing downstream can report an address the process
   * merely asked for.
   */
  runtimeFacts(): BridgeRuntimeFacts {
    return {
      boundAddress: this.boundAddress,
      boundPort: this.boundPort,
      listening: this.listening,
      startedAt: this.startedAtIso,
      startedAtMs: this.startedAtMs,
    };
  }

  registerShutdownTask(task: ShutdownTask): void {
    this.shutdownTasks.push(task);
  }

  /* ---------------------------------------------------------------- listen */

  /**
   * Bind and verify. Resolves only once the OS has confirmed the address, so a
   * caller that awaits this is entitled to say the bridge is listening.
   */
  listen(): Promise<{ readonly address: string; readonly port: number }> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.httpServer.off('error', onError);
        const address = this.httpServer.address();
        if (address === null || typeof address === 'string') {
          this.httpServer.close();
          reject(new Error(`the listener reported an unusable address: ${JSON.stringify(address)}`));
          return;
        }
        if (address.address !== REQUIRED_BIND_ADDRESS) {
          // Belt and braces. If this ever fires, something below Node handed us
          // a different interface and the only safe move is to stop.
          this.httpServer.close();
          reject(
            new Error(
              `refusing to serve: asked for ${REQUIRED_BIND_ADDRESS} but the OS bound ${address.address}`,
            ),
          );
          return;
        }
        this.boundAddress = address.address;
        this.boundPort = address.port;
        this.listening = true;
        resolve({ address: address.address, port: address.port });
      };

      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      // The third argument is the backlog; the host is pinned, never derived.
      this.httpServer.listen(this.config.port, REQUIRED_BIND_ADDRESS, 128);
    });
  }

  /* --------------------------------------------------------------- requests */

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const originAllowed = origin === undefined || this.isAllowedOrigin(origin);

    if (!isLocalHostHeader(req.headers.host, this.boundPort ?? this.config.port)) {
      this.requestsRejected += 1;
      this.sendJson(res, 421, origin, originAllowed, {
        code: 'BAD_REQUEST',
        message: 'This bridge only answers requests addressed to its own loopback host.',
      });
      return;
    }
    if (!originAllowed) {
      this.requestsRejected += 1;
      this.sendJson(res, 403, origin, false, {
        code: 'PERMISSION_DENIED',
        message: 'That Origin is not permitted to talk to this bridge.',
      });
      return;
    }

    const url = this.parsePath(req.url);
    if (url === null) {
      this.requestsRejected += 1;
      this.sendJson(res, 400, origin, originAllowed, { code: 'BAD_REQUEST', message: 'Malformed request URL.' });
      return;
    }

    if (req.method === 'OPTIONS') {
      // Preflight. Answered for the operation route only; there is nothing else
      // to preflight.
      res.writeHead(url === ROUTE_OPERATION ? 204 : 404, this.corsHeaders(origin, originAllowed));
      res.end();
      return;
    }

    if (this.shuttingDown) {
      this.requestsRejected += 1;
      this.sendJson(res, 503, origin, originAllowed, {
        code: 'INVALID_STATE',
        message: 'The bridge is shutting down and is no longer accepting operations.',
      });
      return;
    }

    // The two GET routes below are liveness conveniences, not operations. They
    // take no payload, read no project, change nothing, and go straight to the
    // router's own snapshot rather than through `dispatch` — so they are NOT
    // written to the audit ledger. That is a deliberate exemption, not an
    // oversight: `bridge:health` polls this endpoint, and an audit trail that is
    // 99% health probes is one nobody reads. Everything with a payload arrives
    // through POST /api/operation or a WebSocket `request` frame, and every one
    // of those is audited.
    if (req.method === 'GET' && url === ROUTE_HEALTH) {
      this.requestsHandled += 1;
      const health = await this.router.health();
      // The status code follows the body's own verdict, so a monitoring tool
      // that only reads the code and one that reads the JSON agree.
      this.writeJson(res, health.ok ? 200 : 503, origin, originAllowed, health);
      return;
    }

    if (req.method === 'GET' && url === ROUTE_DECLARATIONS) {
      this.requestsHandled += 1;
      // The same computation the `getDeclarations` operation performs, not a
      // constant. A GET that answered from a frozen object would be the one
      // place a stale claim could still escape.
      this.writeJson(res, 200, origin, originAllowed, this.router.declarations());
      return;
    }

    if (url === ROUTE_OPERATION) {
      if (req.method !== 'POST') {
        this.requestsRejected += 1;
        this.sendJson(res, 405, origin, originAllowed, {
          code: 'BAD_REQUEST',
          message: 'Operations are submitted with POST.',
        });
        return;
      }
      const contentType = req.headers['content-type'];
      if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
        this.requestsRejected += 1;
        this.sendJson(res, 415, origin, originAllowed, {
          code: 'BAD_REQUEST',
          message: 'Content-Type must be application/json.',
        });
        return;
      }

      const body = await this.readBody(req);
      if (!body.ok) {
        this.requestsRejected += 1;
        if (body.reason === 'TOO_LARGE') {
          // `Connection: close`: the request stream may have been abandoned
          // part-way, so this socket is no longer safe to reuse for a keep-alive
          // pipeline.
          this.writeJson(
            res,
            413,
            origin,
            originAllowed,
            {
              ok: false,
              error: {
                code: 'BAD_REQUEST',
                message: `Request body exceeds the ${this.config.maxRequestBytes} byte limit.`,
              },
            },
            { connection: 'close' },
          );
        } else {
          this.sendJson(res, 400, origin, originAllowed, {
            code: 'BAD_REQUEST',
            message: 'The request body could not be read.',
          });
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        this.requestsRejected += 1;
        this.sendJson(res, 400, origin, originAllowed, {
          code: 'BAD_REQUEST',
          message: 'Request body is not valid JSON.',
        });
        return;
      }

      this.requestsHandled += 1;
      const response = await this.router.dispatch(parsed, 'http', null);
      // 200 even for a typed failure: the operation was dispatched and answered.
      // The `ok` flag in the body is the authoritative verdict, and collapsing it
      // into an HTTP status would lose the specific contract error code.
      this.writeJson(res, 200, origin, originAllowed, response);
      return;
    }

    this.requestsRejected += 1;
    this.sendJson(res, 404, origin, originAllowed, {
      code: 'NOT_FOUND',
      message: 'This bridge serves only the API and the WebSocket upgrade.',
    });
  }

  /** Path only. Query strings are ignored; no route depends on one. */
  private parsePath(rawUrl: string | undefined): string | null {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2_048) return null;
    try {
      return new URL(rawUrl, `http://${REQUIRED_BIND_ADDRESS}`).pathname;
    } catch {
      return null;
    }
  }

  private isAllowedOrigin(origin: string): boolean {
    // Both conditions, not either: the allowlist pins the exact ports, and
    // `isLocalOrigin` guarantees a future edit to the list cannot smuggle in a
    // non-loopback host.
    return this.config.allowedOrigins.includes(origin) && isLocalOrigin(origin);
  }

  /**
   * Read a body with a running byte count.
   *
   * `Content-Length` is a cheap first rejection, but the real limit is enforced
   * chunk by chunk: a chunked request can declare nothing and then send a
   * gigabyte, so a header check on its own is not a limit at all.
   *
   * WHAT HAPPENS WHEN THE LIMIT IS PASSED, and why it is not simply
   * `req.destroy()`. Killing the socket mid-upload means the client never reads
   * the 413 — it gets ECONNRESET and cannot tell "too large" from "the bridge
   * crashed". So buffering stops immediately (memory is capped at the limit,
   * which is the part that matters) while the rest of the body is drained and
   * discarded, letting the client finish writing and then read a real answer.
   *
   * The drain is itself bounded: past `ABSOLUTE_DRAIN_LIMIT` the peer is not a
   * confused client, and the socket goes.
   */
  private readBody(req: IncomingMessage): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'TOO_LARGE' | 'ABORTED' }> {
    const limit = this.config.maxRequestBytes;
    const absoluteDrainLimit = limit * 8;

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      let settled = false;

      const finish = (value: { ok: true; text: string } | { ok: false; reason: 'TOO_LARGE' | 'ABORTED' }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const declared = Number(req.headers['content-length'] ?? '0');
      if (Number.isFinite(declared) && declared > limit) tooLarge = true;

      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          tooLarge = true;
          // Everything buffered so far is released: the request is already
          // refused, so holding it serves nothing.
          chunks.length = 0;
        }
        if (tooLarge) {
          if (total > absoluteDrainLimit) {
            req.destroy();
            finish({ ok: false, reason: 'TOO_LARGE' });
          }
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () =>
        finish(tooLarge ? { ok: false, reason: 'TOO_LARGE' } : { ok: true, text: Buffer.concat(chunks).toString('utf8') }),
      );
      req.on('error', () => finish({ ok: false, reason: tooLarge ? 'TOO_LARGE' : 'ABORTED' }));
      req.on('aborted', () => finish({ ok: false, reason: tooLarge ? 'TOO_LARGE' : 'ABORTED' }));
    });
  }

  /* ---------------------------------------------------------------- upgrade */

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, reason: string): void => {
      this.upgradesRejected += 1;
      try {
        socket.write(
          `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      } catch {
        // The peer is already gone; nothing to report.
      }
      socket.destroy();
    };

    if (this.shuttingDown) {
      reject(503, 'Service Unavailable');
      return;
    }
    if (!isLocalHostHeader(req.headers.host, this.boundPort ?? this.config.port)) {
      reject(421, 'Misdirected Request');
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      if (!this.isAllowedOrigin(origin)) {
        // The one check that stops a hostile page in a browser the user already
        // has open. It must run before `handleUpgrade`, not inside the socket.
        reject(403, 'Forbidden');
        return;
      }
    }
    // No Origin at all: not a browser, therefore not a cross-site attack. The
    // socket is still on loopback and still limited to the typed operations.

    const path = this.parsePath(req.url);
    if (path !== ROUTE_WEBSOCKET) {
      reject(404, 'Not Found');
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.upgradesAccepted += 1;
      this.attachSocket(ws, req);
    });
  }

  private attachSocket(ws: WebSocket, req: IncomingMessage): void {
    const clientId = randomUUID();
    const remote = req.socket.remoteAddress ?? 'unknown';
    const remotePort = req.socket.remotePort ?? 0;

    const adapter: TransportSocket = {
      id: clientId,
      remoteLabel: `${remote}:${remotePort}`,
      send: (payload: string) => {
        ws.send(payload);
      },
      bufferedBytes: () => ws.bufferedAmount,
      close: (code: number, reason: string) => {
        // A close reason is capped at 123 bytes by the protocol; a longer one
        // throws and would turn a tidy close into an exception.
        ws.close(code, reason.slice(0, 100));
      },
    };

    this.transport.attach(adapter);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        // Every frame in this protocol is JSON text. A binary frame is either a
        // bug or a probe; neither deserves a parse attempt.
        ws.close(1003, 'binary frames are not accepted');
        return;
      }
      this.transport.handleClientMessage(clientId, data.toString());
    });
    ws.on('close', () => this.transport.detach(clientId));
    ws.on('error', () => this.transport.detach(clientId));
  }

  /* --------------------------------------------------------------- shutdown */

  /** Wire SIGINT/SIGTERM. Returns a function that removes the handlers again. */
  installSignalHandlers(onComplete: (report: ShutdownReport) => void): () => void {
    const handler = (signal: string): void => {
      this.log(`[bridge] ${signal} received — shutting down`);
      void this.shutdown(signal).then(onComplete);
    };
    const onInt = (): void => handler('SIGINT');
    const onTerm = (): void => handler('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    return () => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    };
  }

  /**
   * Stop accepting, tell clients, run the registered tasks, release the lock.
   *
   * Idempotent: a second SIGINT joins the shutdown already in progress rather
   * than starting a second one that would race the first over the same lock.
   */
  shutdown(reason: string): Promise<ShutdownReport> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.shutdownPromise = this.runShutdown(reason);
    return this.shutdownPromise;
  }

  private async runShutdown(reason: string): Promise<ShutdownReport> {
    const startedAtMs = this.now();
    const startedAt = new Date(startedAtMs).toISOString();
    this.shuttingDown = true;

    // 1. Stop accepting new connections. Existing ones are allowed to finish.
    this.listening = false;
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
      // `close` waits for idle keep-alive sockets, which can outlive the
      // shutdown budget. Ask them to end now; anything still open is destroyed
      // at the end.
      for (const socket of this.sockets) socket.end();
      // Do not wait forever for a socket that never closes.
      setTimeout(resolve, Math.min(2_000, this.config.shutdownTimeoutMs)).unref();
    });

    // 2. Tell every client, while the sockets are still open.
    this.publishQuietly('STOPPING', {
      phase: 'begin',
      reason,
      connectedClients: this.transport.connectedClients,
    });

    // 3. Registered cleanup — cancelling runs, killing children. Each task is
    //    bounded and its real outcome recorded.
    const tasks: ShutdownTaskOutcome[] = [];
    for (const task of this.shutdownTasks) {
      const taskStart = this.now();
      const budget = task.timeoutMs ?? this.config.shutdownTimeoutMs;
      try {
        const outcome = await runWithDeadline(() => task.run(reason), budget);
        tasks.push({
          name: task.name,
          state: outcome,
          durationMs: this.now() - taskStart,
          detail:
            outcome === 'TIMED_OUT'
              ? `did not finish within ${budget}ms; whatever it owns may still be running`
              : null,
        });
      } catch (err) {
        tasks.push({
          name: task.name,
          state: 'FAILED',
          durationMs: this.now() - taskStart,
          detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        });
      }
    }

    const clean = tasks.every((t) => t.state === 'COMPLETED');

    // 4. Final event, with the honest outcome of step 3, then close the sockets.
    this.publishQuietly(clean ? 'COMPLETED' : 'DEGRADED', {
      phase: 'end',
      reason,
      tasks,
      clean,
      note: clean
        ? 'every registered shutdown task completed'
        : 'at least one shutdown task failed or timed out; cleanup is NOT guaranteed',
    });

    const clientsClosed = this.transport.closeAll(1001, 'bridge shutting down');
    this.transport.stop();

    // 5. Flush what the store knows and release the lock.
    let degradedNotesFlushed = 0;
    let lockReleased = false;
    try {
      const result = this.closeStore();
      degradedNotesFlushed = result.degradedNotesFlushed;
      lockReleased = result.lockReleased;
    } catch (err) {
      this.log(`[bridge] store close failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 6. Anything still holding a socket open loses it now.
    let socketsDestroyed = 0;
    for (const socket of this.sockets) {
      socket.destroy();
      socketsDestroyed += 1;
    }
    this.sockets.clear();
    try {
      this.wss.close();
    } catch {
      // Already closed.
    }

    const finishedAtMs = this.now();
    return {
      reason,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      tasks,
      clientsClosed,
      socketsDestroyed,
      degradedNotesFlushed,
      lockReleased,
      clean: clean && lockReleased,
    };
  }

  /**
   * Publish a shutdown event without letting a failure abort the shutdown. The
   * store may already be unwritable — that is a reason to keep going, not to
   * throw on the way out.
   */
  private publishQuietly(status: 'STOPPING' | 'COMPLETED' | 'DEGRADED', payload: Record<string, unknown>): void {
    try {
      this.transport.publish({
        projectId: BRIDGE_PROJECT_ID,
        runId: null,
        source: 'bridge',
        type: 'bridge.shutdown',
        status,
        payload,
      });
    } catch (err) {
      this.log(`[bridge] could not record bridge.shutdown: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* ------------------------------------------------------------------ utils */

  private corsHeaders(origin: string | undefined, allowed: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // Nothing here is embeddable, and a frame is one more way to reach it.
      'x-frame-options': 'DENY',
    };
    if (origin !== undefined && allowed) {
      // Echo the exact origin, never `*`, and never with credentials: the bridge
      // has no cookies or auth headers to protect, and `*` would outlive the
      // allowlist if this file were ever copied.
      headers['access-control-allow-origin'] = origin;
      headers.vary = 'Origin';
      headers['access-control-allow-methods'] = 'POST, GET, OPTIONS';
      headers['access-control-allow-headers'] = 'content-type';
      headers['access-control-max-age'] = '600';
    }
    return headers;
  }

  private writeJson(
    res: ServerResponse,
    status: number,
    origin: string | undefined,
    originAllowed: boolean,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): void {
    let payload: string;
    try {
      payload = JSON.stringify(body);
    } catch {
      payload = JSON.stringify({ ok: false, error: { code: 'RUNTIME_ERROR', message: 'Response could not be serialised.' } });
      status = 500;
    }
    res.writeHead(status, { ...this.corsHeaders(origin, originAllowed), ...extraHeaders });
    res.end(payload);
  }

  private sendJson(
    res: ServerResponse,
    status: number,
    origin: string | undefined,
    originAllowed: boolean,
    error: OperationError,
  ): void {
    this.writeJson(res, status, origin, originAllowed, { ok: false, error });
  }

  stats(): Record<string, unknown> {
    return {
      listening: this.listening,
      shuttingDown: this.shuttingDown,
      boundAddress: this.boundAddress,
      boundPort: this.boundPort,
      openSockets: this.sockets.size,
      requestsHandled: this.requestsHandled,
      requestsRejected: this.requestsRejected,
      upgradesAccepted: this.upgradesAccepted,
      upgradesRejected: this.upgradesRejected,
      shutdownTasks: this.shutdownTasks.map((t) => t.name),
    };
  }
}
