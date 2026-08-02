// Real, spawned-process tests for gateway/supervisor.mjs (WP feat-gateway-supervisor).
//
// Every fixture here lives under test-support/fixtures/, NOT test/fixtures/ — node's built-in
// test runner auto-discovers any .mjs file inside a directory literally named `test` or `tests`
// and runs it as its own standalone test file (verified empirically for this WP); a fixture that
// calls process.exit(1) to simulate a crash would then be misreported as a failing test in its
// own right. None of these fixtures ever binds a port (never port 4100, never any live gateway).
//
// Design note (also verified empirically for this WP): on Windows, child.kill('SIGTERM') from a
// PARENT process unconditionally terminates the target via TerminateProcess and never invokes a
// process.on('SIGTERM', ...) handler registered INSIDE that target process. That means a test
// which spawns supervisor.mjs as an OS child and then sends it a real SIGTERM cannot observe its
// graceful-shutdown code path on this platform — the outer process would simply be killed before
// its own handler ever ran. The stop()-behavior test below therefore imports GatewaySupervisor
// directly and calls .stop('SIGTERM') on it — this is the EXACT same code every
// process.on('SIGTERM'|'SIGINT', ...) handler in supervisor.mjs's own main() calls; only the
// one-line OS-signal-to-stop() wiring itself is excluded (verified by inspection, not
// independently testable cross-platform via child.kill()). The child it supervises is still a
// REAL, separately spawned OS process — nothing here is mocked.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewaySupervisor } from '../supervisor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_SCRIPT = path.join(__dirname, '..', 'supervisor.mjs');
const FIXTURES_DIR = path.join(__dirname, '..', 'test-support', 'fixtures');

const tempDirs = [];
function makeTempLogFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-supervisor-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'runtime.log');
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Spawns the REAL supervisor CLI (`node supervisor.mjs`) with test-only env var overrides and
// resolves once the OUTER supervisor process itself exits. This is the only way to observe a real
// OS exit code, which is what the crash-loop/EADDRINUSE requirements are actually about — an
// in-process unit test of the class alone couldn't prove "the CLI process exits non-zero".
function runSupervisorCli(envOverrides, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SUPERVISOR_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('supervisor CLI did not exit within ' + timeoutMs + 'ms; stdout=' + stdout + ' stderr=' + stderr));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('supervisor restarts a crashing real child with increasing backoff, then trips the crash-loop breaker with a non-zero exit code', async () => {
  const logFile = makeTempLogFile();
  const result = await runSupervisorCli({
    FORGE_SUPERVISOR_CHILD_SCRIPT: path.join(FIXTURES_DIR, 'supervisor-crash.mjs'),
    FORGE_SUPERVISOR_LOG_FILE: logFile,
    FORGE_SUPERVISOR_INITIAL_BACKOFF_MS: '5',
    FORGE_SUPERVISOR_MAX_BACKOFF_MS: '40',
    FORGE_SUPERVISOR_CRASH_LOOP_MAX: '4',
    FORGE_SUPERVISOR_CRASH_LOOP_WINDOW_MS: '60000',
  });

  // 1) it really restarted the child multiple times (not just started once and given up)
  const startedLines = result.stdout.match(/gateway child started pid=\d+ attempt=\d+/g) || [];
  assert.equal(startedLines.length, 4, 'expected exactly 4 start attempts before the breaker trips: ' + result.stdout);
  assert.ok(startedLines.some((l) => l.includes('attempt=1')), 'missing attempt=1: ' + result.stdout);
  assert.ok(startedLines.some((l) => l.includes('attempt=4')), 'missing attempt=4: ' + result.stdout);

  // 2) backoff genuinely increased between restarts (not a fixed/flat delay) — 5 -> 10 -> 20,
  // capped at 40 (never reached here because the 4th crash trips the breaker first)
  const delays = [...result.stdout.matchAll(/restarting in (\d+)ms/g)].map((m) => Number(m[1]));
  assert.deepEqual(delays, [5, 10, 20], 'expected the doubling backoff sequence: ' + result.stdout);

  // 3) the crash-loop breaker stopped it with an honest message and a non-zero exit code, never
  // an infinite restart loop
  assert.match(result.stdout, /FATAL: crash-loop detected/);
  assert.notEqual(result.code, 0, 'supervisor must exit non-zero when the crash-loop breaker trips');

  // stdout/stderr really got piped into the log file, not just printed to the console
  const logContent = fs.readFileSync(logFile, 'utf8');
  assert.match(logContent, /gateway child started pid=\d+ attempt=1/);
  assert.match(logContent, /FATAL: crash-loop detected/);
});

test('supervisor detects EADDRINUSE and stops instead of restarting, with a non-zero exit code', async () => {
  const logFile = makeTempLogFile();
  const result = await runSupervisorCli({
    FORGE_SUPERVISOR_CHILD_SCRIPT: path.join(FIXTURES_DIR, 'supervisor-eaddrinuse.mjs'),
    FORGE_SUPERVISOR_LOG_FILE: logFile,
    FORGE_SUPERVISOR_INITIAL_BACKOFF_MS: '5',
    FORGE_SUPERVISOR_CRASH_LOOP_MAX: '5',
    FORGE_SUPERVISOR_CRASH_LOOP_WINDOW_MS: '60000',
  });

  const startedLines = result.stdout.match(/gateway child started pid=\d+ attempt=\d+/g) || [];
  assert.equal(startedLines.length, 1, 'EADDRINUSE must stop after the FIRST attempt, never restart: ' + result.stdout);
  assert.doesNotMatch(result.stdout, /restarting in \d+ms/, 'must never schedule a restart on EADDRINUSE');
  assert.match(result.stdout, /EADDRINUSE/);
  assert.match(result.stdout, /Restarting would not help/);
  assert.notEqual(result.code, 0, 'supervisor must exit non-zero on EADDRINUSE');

  const logContent = fs.readFileSync(logFile, 'utf8');
  assert.match(logContent, /EADDRINUSE/, 'the real EADDRINUSE stderr line must have been piped into the log file');
});

test('stop() terminates the real child by its exact PID and never restarts it, then the supervisor shuts down cleanly', async () => {
  const logFile = makeTempLogFile();
  const supervisor = new GatewaySupervisor({
    childScript: path.join(FIXTURES_DIR, 'supervisor-friendly.mjs'),
    logFilePath: logFile,
  });

  let childRef = null;
  const startedPromise = new Promise((resolve) => {
    supervisor.once('child-started', () => { childRef = supervisor.child; resolve(); });
  });
  let restartScheduled = false;
  supervisor.on('restart-scheduled', () => { restartScheduled = true; });

  supervisor.start();
  await startedPromise;
  assert.ok(childRef && childRef.pid, 'a real child process must have started');
  assert.equal(childRef.exitCode, null, 'child must still be alive right before stop()');

  const stoppedPromise = new Promise((resolve, reject) => {
    supervisor.once('stopped', resolve);
    setTimeout(() => reject(new Error('supervisor did not emit "stopped" in time')), 5000);
  });
  supervisor.stop('SIGTERM');
  await stoppedPromise;

  assert.ok(
    childRef.exitCode !== null || childRef.signalCode !== null,
    'the real child process must have actually terminated',
  );
  assert.equal(supervisor.attempt, 1, 'stop() must never trigger a restart');
  assert.equal(restartScheduled, false, 'no restart-scheduled event must fire for a requested stop');
  assert.equal(supervisor.stopped, true);

  const logContent = fs.readFileSync(logFile, 'utf8');
  assert.match(logContent, /stop requested \(SIGTERM\)/);
  assert.match(logContent, /supervisor stopped/);
});

// A LOG PROBLEM MUST NEVER KILL THE SUPERVISOR (Lead live-smoke finding, 2026-07-30).
//
// Found by running supervisor.mjs against the REAL setup, not by reading it: the live gateway had
// been started with `cmd /c node bin.mjs >> gateway-runtime.log`, so Windows held a handle on that
// path; createWriteStream then emitted EBUSY, and because nothing listened for 'error' on the
// stream, that unhandled event terminated the entire supervisor with a stack trace — before it
// even reached its EADDRINUSE check. A watchdog that dies because it cannot open its own logbook
// protects nothing while looking installed.
//
// This test makes the log sink genuinely unopenable by pointing logFilePath at a path whose parent
// is a FILE, not a directory (ENOTDIR on every platform — no Windows-only handle trickery needed,
// and no dependence on which errno the OS picks). The supervisor must still supervise: the real
// child has to start, and a normal stop() has to complete.
test('an unopenable log file degrades to console logging instead of killing the supervisor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-supervisor-logfail-'));
  tempDirs.push(dir);
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'this is a file, so any path under it cannot be opened\n');
  const impossibleLogPath = path.join(blocker, 'runtime.log');

  const supervisor = new GatewaySupervisor({
    entryPoint: path.join(FIXTURES_DIR, 'supervisor-friendly.mjs'),
    logFilePath: impossibleLogPath,
  });

  const logs = [];
  const degraded = new Promise((resolve, reject) => {
    // createWriteStream OPENS ASYNCHRONOUSLY: it returns a stream object straight away and only
    // emits 'error' on the next ticks. So the honest contract is not "logStream is null the instant
    // start() returns" (an earlier version of this test asserted that and failed for that reason) —
    // it is "the failure arrives, is announced, the sink is dropped, and supervision continues".
    const timer = setTimeout(() => reject(new Error('no degradation notice within 5s; logs: ' + JSON.stringify(logs))), 5000);
    supervisor.on('log', (line) => {
      logs.push(line);
      if (/log file/i.test(line)) {
        clearTimeout(timer);
        resolve(line);
      }
    });
  });

  // start() must not throw, and the later stream error must not become an unhandled 'error' event.
  supervisor.start();
  assert.ok(supervisor.child, 'the supervisor must still have spawned its real child');

  const notice = await degraded;
  assert.match(notice, /continuing with console logging only/, 'the notice must state that supervision continues');
  assert.equal(supervisor.logStream, null, 'the unopenable sink must be dropped once its error arrives');
  assert.equal(supervisor.stopped, false, 'a log failure must never end supervision');

  await new Promise((resolve) => {
    supervisor.once('stopped', resolve);
    supervisor.stop('SIGTERM');
  });
  assert.equal(supervisor.stopped, true, 'a supervisor with no log sink must still stop cleanly');
});

/* ---------------------------------------------------------------------------------------------
 * Backoff must RESET after a genuinely healthy run (coordinator finding 2026-07-30, straight out of
 * the real supervisor log: three deliberate restarts spread over ~80 minutes still walked the delay
 * 2000 -> 4000 -> 8000 ms, because currentBackoffMs only ever grew for the whole lifetime of the
 * supervisor process). Exponential backoff exists to stop a fast crash-LOOP; a gateway that ran for
 * an hour and then died once is not a loop, and making it wait the maximum is pure extra downtime.
 * Driven against the class with a fake spawnFn so the timing is controlled, not raced.
 * ------------------------------------------------------------------------------------------- */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

test('supervisor: a child that stayed up longer than the crash-loop window resets the backoff instead of growing it forever', async () => {
  const children = [];
  const sup = new GatewaySupervisor({
    childScript: path.join(FIXTURES_DIR, 'supervisor-crash.mjs'), // never actually executed (fake spawnFn)
    logFilePath: null, // console/event logging only — no temp file needed for this one
    initialBackoffMs: 5,
    maxBackoffMs: 400,
    crashLoopMaxCrashes: 99, // the breaker is not what this test is about
    crashLoopWindowMs: 40, // "stable" therefore means: stayed up >= 40ms
    spawnFn: () => {
      const c = fakeChild();
      children.push(c);
      return c;
    },
  });

  const delays = [];
  const logs = [];
  sup.on('restart-scheduled', ({ delayMs }) => delays.push(delayMs));
  sup.on('log', (line) => logs.push(line));
  sup.start();

  // Two FAST crashes — the backoff must grow (5 -> 10).
  children[0].emit('exit', 1, null);
  await new Promise((r) => setTimeout(r, 25));
  children[1].emit('exit', 1, null);
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(delays, [5, 10], 'a fast crash must still grow the backoff: ' + JSON.stringify(delays));

  // Now let the third child stay up PAST the 40ms stability window before it dies.
  await new Promise((r) => setTimeout(r, 70));
  children[2].emit('exit', 1, null);
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(delays[2], 5, 'after a healthy run the delay must be back at the initial 5ms, not 20ms: ' + JSON.stringify(delays));
  assert.ok(
    logs.some((l) => /resetting backoff to 5ms/.test(l)),
    'the reset must be stated honestly in the log, not silently applied: ' + logs.join(' | '),
  );

  sup.stop();
});
