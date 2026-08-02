#!/usr/bin/env node
// Forge Command Center gateway SUPERVISOR — an optional, SEPARATE entry point.
// WP feat-gateway-supervisor (owner-witnessed incident 2026-07-29/30: the gateway went down and
// the browser showed ERR_CONNECTION_REFUSED; bin.mjs's own uncaughtException/unhandledRejection
// handlers only cover an in-process throw — they cannot help once the whole child process is
// gone, e.g. OOM-killed or externally killed. There was no supervisor. This file is that
// supervisor, added without changing bin.mjs's own behavior.)
//
// ── WHEN TO USE bin.mjs vs. supervisor.mjs ─────────────────────────────────────────────────────
// `node command-center/gateway/bin.mjs` (UNCHANGED — still the project's documented default entry
// point, see the root CLAUDE.md "Dashboard + event logs" section) starts the gateway directly,
// once, in the current process. Use it for a quick one-off/dev run, or when something outside
// this file (a process manager, a Windows service, pm2, etc.) already supervises restarts.
//
// `node command-center/gateway/supervisor.mjs` wraps bin.mjs as a CHILD process and restarts it
// automatically after an unexpected exit, with exponential backoff, a crash-loop breaker (fails
// loudly instead of restart-looping forever against a permanently broken gateway), and an
// EADDRINUSE fast-stop (restarting is pointless when the port is already held by another running
// gateway — see below). Use this when you want the gateway to survive a real crash unattended.
//
// Zero-dependency: node:child_process + node:events + node:fs + node:path + node:url only.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CHILD_SCRIPT = path.join(__dirname, 'bin.mjs');
export const DEFAULT_LOG_FILE = path.join(__dirname, 'gateway-runtime.log');

// Backoff: 1s -> 2s -> 4s -> 8s -> 16s -> 30s (capped there). Fast recovery for a transient blip,
// without hammering the machine/log more than roughly twice a minute once it plateaus.
export const DEFAULT_INITIAL_BACKOFF_MS = 1000;
export const DEFAULT_MAX_BACKOFF_MS = 30000;
export const DEFAULT_BACKOFF_MULTIPLIER = 2;

// Crash-loop breaker: 5 crashes inside any rolling 60s window means something is fundamentally
// broken (not a transient blip) — stop restarting and fail loudly instead of looping forever.
export const DEFAULT_CRASH_LOOP_MAX_CRASHES = 5;
export const DEFAULT_CRASH_LOOP_WINDOW_MS = 60000;

// Best-effort escalation if the child ignores the first shutdown signal. Only matters on POSIX —
// on Windows, child.kill() already terminates the process unconditionally regardless of signal
// name (verified empirically for this WP: a real process.on('SIGTERM', ...) handler in a spawned
// Windows child process never runs when the parent calls child.kill('SIGTERM')).
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

export function nextBackoffMs(currentMs, { maxBackoffMs = DEFAULT_MAX_BACKOFF_MS, multiplier = DEFAULT_BACKOFF_MULTIPLIER } = {}) {
  return Math.min(currentMs * multiplier, maxBackoffMs);
}

/**
 * Supervises a single child process, restarting it after an unexpected exit.
 *
 * Emits: 'log' (line), 'child-started' ({pid, attempt}), 'child-exit' ({code, signal}),
 * 'restart-scheduled' ({delayMs, attempt}), 'fatal' ({reason: 'EADDRINUSE'|'crash-loop'}),
 * 'stopped' () — clean shutdown via stop() has fully finished.
 */
export class GatewaySupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.childScript = options.childScript || DEFAULT_CHILD_SCRIPT;
    this.childArgs = options.childArgs || [];
    this.logFilePath = options.logFilePath || DEFAULT_LOG_FILE;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    this.crashLoopMaxCrashes = options.crashLoopMaxCrashes ?? DEFAULT_CRASH_LOOP_MAX_CRASHES;
    this.crashLoopWindowMs = options.crashLoopWindowMs ?? DEFAULT_CRASH_LOOP_WINDOW_MS;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.spawnFn = options.spawnFn || spawn;

    this.child = null;
    this.childStartedAt = null; // real spawn time of the current child; drives the backoff reset below
    this.attempt = 0;
    this.currentBackoffMs = this.initialBackoffMs;
    this.crashTimestamps = [];
    this.stopping = false;
    this.stopped = false;
    this.fatalReason = null;
    this.restartTimer = null;
    this.shutdownTimer = null;
    this.logStream = null;
  }

  _log(line) {
    const stamped = '[' + new Date().toISOString() + '] [supervisor] ' + line;
    if (this.logStream) this.logStream.write(stamped + '\n');
    this.emit('log', stamped);
  }

  start() {
    if (this.logFilePath && !this.logStream) {
      // A LOG PROBLEM MUST NEVER KILL THE SUPERVISOR (Lead live-smoke finding, 2026-07-30).
      // Found by actually running this against the real setup: the running gateway had been started
      // with `cmd /c node bin.mjs >> gateway-runtime.log`, which holds a Windows handle on that file,
      // so `createWriteStream` emitted EBUSY — and with no 'error' listener that unhandled event took
      // the whole supervisor down with a stack trace before it ever reached its port check. A
      // watchdog that dies because it cannot open its own logbook is worse than no watchdog: it looks
      // installed and protects nothing. So the stream is now attached defensively — a failure to
      // open, or any later write error, degrades to console-only logging (the child's own stdio is
      // still piped through the 'child-stdout'/'child-stderr' events) and supervision continues.
      try {
        const stream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
        stream.on('error', (err) => {
          // Drop the file sink, keep supervising, and say so once on the console.
          this.logStream = null;
          const why = err && err.code ? err.code : String(err);
          this._log('log file unavailable (' + why + ') at ' + this.logFilePath + ' — continuing with console logging only');
        });
        this.logStream = stream;
      } catch (err) {
        this.logStream = null;
        const why = err && err.code ? err.code : String(err);
        this._log('could not open log file (' + why + ') at ' + this.logFilePath + ' — continuing with console logging only');
      }
    }
    this._spawnChild();
    return this;
  }

  _spawnChild() {
    this.attempt += 1;
    this.childStartedAt = Date.now();
    const child = this.spawnFn(process.execPath, [this.childScript, ...this.childArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this._log('gateway child started pid=' + child.pid + ' attempt=' + this.attempt);
    this.emit('child-started', { pid: child.pid, attempt: this.attempt });

    // Bounded tail buffer (never unbounded growth) — only used to detect a real EADDRINUSE line in
    // bin.mjs's own startup-failure message (see bin.mjs's server.on('error') handler); not stored
    // beyond that.
    let stderrTail = '';
    child.stdout.on('data', (chunk) => {
      if (this.logStream) this.logStream.write(chunk);
      this.emit('child-stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
      if (this.logStream) this.logStream.write(chunk);
      this.emit('child-stderr', chunk);
    });
    child.on('error', (err) => {
      this._log('child process error: ' + (err && err.message ? err.message : String(err)));
    });
    child.on('exit', (code, signal) => this._onChildExit(code, signal, stderrTail));
  }

  _onChildExit(code, signal, stderrTail) {
    this.child = null;
    if (this.shutdownTimer) { clearTimeout(this.shutdownTimer); this.shutdownTimer = null; }

    if (this.stopping) {
      this._log('child exited during requested shutdown (code=' + code + ' signal=' + signal + ')');
      this._finishStop();
      return;
    }

    this._log('child exited unexpectedly (code=' + code + ' signal=' + signal + ')');
    this.emit('child-exit', { code, signal });

    if (stderrTail.includes('EADDRINUSE')) {
      this._log(
        'FATAL: port already in use (EADDRINUSE) — another gateway process is very likely already running. ' +
          'Find it before restarting: Windows "netstat -ano | findstr 4100", POSIX "lsof -i :4100". ' +
          'Restarting would not help, so the supervisor is stopping instead of looping.',
      );
      this._fail('EADDRINUSE');
      return;
    }

    const now = Date.now();
    this.crashTimestamps.push(now);
    this.crashTimestamps = this.crashTimestamps.filter((t) => now - t <= this.crashLoopWindowMs);
    if (this.crashTimestamps.length >= this.crashLoopMaxCrashes) {
      this._log(
        'FATAL: crash-loop detected (' + this.crashTimestamps.length + ' crashes within ' + this.crashLoopWindowMs +
          'ms, threshold ' + this.crashLoopMaxCrashes + '). Not restarting again — check ' +
          (this.logFilePath || '(no log file configured)') + ' for the real underlying error.',
      );
      this._fail('crash-loop');
      return;
    }

    /* Reset the backoff after a genuinely healthy run (coordinator finding 2026-07-30, from the real
     * supervisor log: three deliberate restarts spread over ~80 minutes still walked the delay
     * 2000 -> 4000 -> 8000 ms, because `currentBackoffMs` only ever grew for the whole lifetime of the
     * supervisor process). Exponential backoff is meant to stop a fast crash-LOOP; a gateway that ran
     * fine for an hour and then died once is not a loop, and making it wait the maximum is pure extra
     * downtime. `crashLoopWindowMs` is reused deliberately as the stability threshold: staying up
     * longer than the crash-loop window is exactly what "this was not a loop" means here. */
    const upForMs = this.childStartedAt === null ? 0 : now - this.childStartedAt;
    if (upForMs >= this.crashLoopWindowMs && this.currentBackoffMs !== this.initialBackoffMs) {
      this._log(
        'child had been up ' + Math.round(upForMs / 1000) + 's (>= the ' + Math.round(this.crashLoopWindowMs / 1000) +
          's stability window) — resetting backoff to ' + this.initialBackoffMs + 'ms instead of continuing to grow it',
      );
      this.currentBackoffMs = this.initialBackoffMs;
    }

    const delayMs = this.currentBackoffMs;
    this._log('restarting in ' + delayMs + 'ms (backoff)');
    this.emit('restart-scheduled', { delayMs, attempt: this.attempt });
    this.currentBackoffMs = nextBackoffMs(this.currentBackoffMs, { maxBackoffMs: this.maxBackoffMs, multiplier: this.backoffMultiplier });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this._spawnChild();
    }, delayMs);
  }

  // Same "wait for the real flush, not just end() being called" reasoning as _finishStop() below.
  _fail(reason) {
    this.fatalReason = reason;
    this.stopped = true;
    if (this.logStream) {
      this.logStream.end(() => this.emit('fatal', { reason }));
    } else {
      this.emit('fatal', { reason });
    }
  }

  // Graceful shutdown: clears any pending restart timer FIRST (so a crash that races with stop()
  // can never sneak in one more spawn), then kills the CURRENT child by its exact PID via the
  // child_process handle returned by spawn() — never by name/pattern. A grace period escalates to
  // SIGKILL if the child doesn't exit in time (best-effort on POSIX; see the module header note
  // about Windows' unconditional termination).
  stop(signal = 'SIGTERM') {
    if (this.stopping || this.stopped) return;
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.child && this.child.pid) {
      this._log('stop requested (' + signal + ') — terminating child pid=' + this.child.pid);
      this.child.kill(signal);
      this.shutdownTimer = setTimeout(() => {
        if (this.child && this.child.pid) {
          this._log('child did not exit within ' + this.shutdownGraceMs + 'ms — escalating to SIGKILL');
          this.child.kill('SIGKILL');
        }
      }, this.shutdownGraceMs);
    } else {
      this._finishStop();
    }
  }

  // Emits 'stopped' only after the log stream has actually finished flushing (via end()'s own
  // callback, not merely after end() was CALLED) — otherwise a caller that reacts to 'stopped' by
  // reading the log file back (exactly what this WP's own tests do) can race the still-pending
  // async write of this very "supervisor stopped" line.
  _finishStop() {
    this.stopped = true;
    this._log('supervisor stopped');
    if (this.logStream) {
      this.logStream.end(() => this.emit('stopped'));
    } else {
      this.emit('stopped');
    }
  }
}

// ── CLI entry point ────────────────────────────────────────────────────────────────────────────
// Every FORGE_SUPERVISOR_* env var below is TEST/ADVANCED-USE ONLY (see gateway/test/supervisor.*
// for real, spawned-process coverage). Running `node supervisor.mjs` with no env vars supervises
// the real bin.mjs with the real backoff/crash-loop defaults above and the real
// gateway-runtime.log — that is the normal, documented way to run it.
function parsePositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function main() {
  const supervisor = new GatewaySupervisor({
    childScript: process.env.FORGE_SUPERVISOR_CHILD_SCRIPT || DEFAULT_CHILD_SCRIPT,
    logFilePath: process.env.FORGE_SUPERVISOR_LOG_FILE || DEFAULT_LOG_FILE,
    initialBackoffMs: parsePositiveIntEnv('FORGE_SUPERVISOR_INITIAL_BACKOFF_MS', DEFAULT_INITIAL_BACKOFF_MS),
    maxBackoffMs: parsePositiveIntEnv('FORGE_SUPERVISOR_MAX_BACKOFF_MS', DEFAULT_MAX_BACKOFF_MS),
    crashLoopMaxCrashes: parsePositiveIntEnv('FORGE_SUPERVISOR_CRASH_LOOP_MAX', DEFAULT_CRASH_LOOP_MAX_CRASHES),
    crashLoopWindowMs: parsePositiveIntEnv('FORGE_SUPERVISOR_CRASH_LOOP_WINDOW_MS', DEFAULT_CRASH_LOOP_WINDOW_MS),
  });

  supervisor.on('log', (line) => { process.stdout.write(line + '\n'); });
  supervisor.on('fatal', () => { process.exitCode = 1; });

  let shuttingDown = false;
  const requestShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    supervisor.stop(signal);
  };
  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  supervisor.start();
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) main();
