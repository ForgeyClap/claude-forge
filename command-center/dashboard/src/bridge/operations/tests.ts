/**
 * Forge Workspace — approved test execution and proof.
 *
 * This is the only file in the bridge that runs a quality gate, and it is built
 * around one refusal: THE CLIENT NEVER NAMES A COMMAND.
 *
 * A request carries an allowlist KEY — `typecheck`, `lint`, `test`, `build`,
 * `theme:check`, `test:e2e`, `test:e2e:install`, `shots` — and nothing else. The
 * key is looked up in `TEST_GATES`, a frozen table in this file, which yields an
 * npm script name. A payload that carries `command`, `args`, `script`, `cmd`,
 * `argv` or `shell` is rejected outright rather than ignored, because a client
 * that believes it can send a command string is a client that will keep trying.
 *
 * HOW IT SPAWNS, AND WHY IT LOOKS LIKE THIS. The argv is
 * `[<node>, <npm-cli.js>, 'run', <script>]` with `shell: false`. Not `npm.cmd`:
 * since the 2024 fix for CVE-2024-27980, Node refuses to spawn a `.cmd` without
 * `shell: true`, and turning the shell on to run a batch file would put a
 * command line in front of `cmd.exe` — the exact thing this design exists to
 * avoid. Running npm's own JavaScript entry point under the Node we are already
 * running keeps `shell: false` true all the way down. npm then runs the script
 * body from the project's package.json, which is a reviewed repository file, not
 * user text.
 *
 * HOW PASS IS DERIVED. `testPassed()` from protocol.ts, and only that: exit code
 * zero AND no failed count. Never a word in stdout. The runner's own summary is
 * parsed separately into a `failureSignal`, and when that signal and the exit
 * code disagree — exit 0 with failures reported, or a non-zero exit with none —
 * the disagreement is RECORDED AS A FINDING (a rejected `ProofEntry`) and the
 * execution does not pass. Neither number is quietly preferred over the other.
 *
 * WHAT COUNTS AS EVIDENCE. Every execution writes its real stdout and stderr to
 * files under the workspace data directory and stores the refs on the
 * `TestExecution`, together with the exit code. A gate cannot be reported as
 * passing without those, and a later reader can re-derive the verdict from them.
 *
 * The relative `.ts` imports are deliberate: Node 24 executes TypeScript
 * directly and requires the explicit extension, and bridge code is permitted
 * relative imports.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers';

import { testPassed } from '../../shared/protocol.ts';
import type {
  ApprovalRequest,
  EvidenceRef,
  ProjectRecord,
  ProofEntry,
  RiskLevel,
  TestExecution,
} from '../../shared/protocol.ts';
import { assertTestTransition } from '../../shared/state-machines.ts';
import type { TestState } from '../../shared/state-machines.ts';

import { ProjectRegistry } from '../projects/registry.ts';
import { asObject, fail, optInteger, optString, reqString } from '../router.ts';
import type { OperationContext, Router } from '../router.ts';
import { assertInsideRoot, isPathGuardError, resolveProjectsRootInfo } from '../security/paths.ts';
import { ensureDir, fileExists, readJsonSafe, writeAtomic } from '../storage/atomic.ts';

import { checkApproval, ioFromContext, requestApproval, requiresApproval } from './approvals.ts';

/* ========================================================================== */
/*  Parsed counts                                                              */
/* ========================================================================== */

export interface GateParse {
  /**
   * The contract's `counts`, filled ONLY by runners that report all three
   * numbers. `tsc` does not report how many files passed, so inventing
   * `passed: 0` for it would put a made-up number on a record.
   */
  readonly counts: TestExecution['counts'];
  /**
   * How many failures the runner said it had. `null` means the output carried
   * no machine-readable count — which is a real answer, and is why the exit code
   * is then the only signal.
   */
  readonly failureSignal: number | null;
  /** Exactly where the numbers came from, so the parse can be re-checked. */
  readonly source: string;
}

const NO_PARSE: GateParse = {
  counts: null,
  failureSignal: null,
  source: 'this runner prints no machine-readable summary; the exit code is the only signal',
};

/**
 * For runners with no summary of their own. Returning `null` for both numbers is
 * the honest answer — an invented `0 failed` would make the exit code agree with
 * a count nobody reported.
 */
function parseNone(): GateParse {
  return NO_PARSE;
}

function firstInt(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (match === null || match[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** `      Tests  2 failed | 83 passed (85)` — vitest's summary line. */
function parseVitest(stdout: string, stderr: string): GateParse {
  const combined = `${stdout}\n${stderr}`;
  const line = /^[^\S\r\n]*Tests[^\S\r\n]+(.+)$/m.exec(combined);
  if (line === null || line[1] === undefined) {
    return {
      counts: null,
      failureSignal: null,
      source: 'no vitest "Tests" summary line was found in the output',
    };
  }
  const summary = line[1];
  const failed = firstInt(summary, /(\d+)\s+failed/) ?? 0;
  const passed = firstInt(summary, /(\d+)\s+passed/) ?? 0;
  const skipped = (firstInt(summary, /(\d+)\s+skipped/) ?? 0) + (firstInt(summary, /(\d+)\s+todo/) ?? 0);
  return {
    counts: { passed, failed, skipped },
    failureSignal: failed,
    source: `vitest summary line "Tests ${summary.trim()}"`,
  };
}

/** `Found 3 errors in 2 files.` — or the individual `error TS####:` lines. */
function parseTsc(stdout: string, stderr: string): GateParse {
  const combined = `${stdout}\n${stderr}`;
  const found = firstInt(combined, /Found\s+(\d+)\s+errors?/);
  if (found !== null) {
    return { counts: null, failureSignal: found, source: `tsc summary "Found ${found} error(s)"` };
  }
  const diagnostics = combined.match(/error TS\d+:/g);
  if (diagnostics !== null) {
    return {
      counts: null,
      failureSignal: diagnostics.length,
      source: `counted ${diagnostics.length} "error TS####:" diagnostic line(s); tsc printed no summary`,
    };
  }
  return {
    counts: null,
    failureSignal: null,
    source: 'tsc printed no error summary and no diagnostics; the exit code is the only signal',
  };
}

/** `✖ 3 problems (2 errors, 1 warning)` — eslint prints nothing when clean. */
function parseEslint(stdout: string, stderr: string): GateParse {
  const combined = `${stdout}\n${stderr}`;
  const errors = firstInt(combined, /(\d+)\s+errors?\s*,\s*\d+\s+warnings?/);
  if (errors !== null) {
    const problems = firstInt(combined, /(\d+)\s+problems?/);
    return {
      counts: null,
      failureSignal: errors,
      source: `eslint summary "${problems ?? '?'} problems (${errors} errors, ...)"`,
    };
  }
  if (combined.trim().length === 0) {
    return { counts: null, failureSignal: 0, source: 'eslint printed nothing, which is how it reports a clean run' };
  }
  return {
    counts: null,
    failureSignal: null,
    source: 'eslint printed output but no "N problems (E errors, W warnings)" summary',
  };
}

/** `  3 passed (5.2s)` / `  1 failed` — the playwright reporter's tail. */
function parsePlaywright(stdout: string, stderr: string): GateParse {
  const combined = `${stdout}\n${stderr}`;
  const passed = firstInt(combined, /(\d+)\s+passed/);
  const failed = firstInt(combined, /(\d+)\s+failed/);
  const skipped = firstInt(combined, /(\d+)\s+skipped/);
  const flaky = firstInt(combined, /(\d+)\s+flaky/);
  if (passed === null && failed === null && skipped === null) {
    return {
      counts: null,
      failureSignal: null,
      source: 'no playwright pass/fail summary was found in the output',
    };
  }
  return {
    counts: { passed: passed ?? 0, failed: failed ?? 0, skipped: (skipped ?? 0) + (flaky ?? 0) },
    failureSignal: failed ?? 0,
    source: 'playwright reporter summary',
  };
}

/* ========================================================================== */
/*  The allowlist                                                              */
/* ========================================================================== */

export interface TestGate {
  readonly key: string;
  /** The npm script name. Never taken from a payload. */
  readonly script: string;
  readonly risk: RiskLevel;
  readonly description: string;
  /** What running it touches, for the approval card. */
  readonly affects: readonly string[];
  readonly rollbackPlan: string;
  readonly timeoutMs: number;
  readonly parse: (stdout: string, stderr: string) => GateParse;
}

const MINUTE = 60_000;

/**
 * Every command this bridge can run, in full.
 *
 * There is no entry that takes an argument, no entry built from a template and
 * no way to add one at run time — the object is frozen and nothing writes to it.
 * Risk drives the approval gate: the four HIGH gates write to disk or drive a
 * browser, so they wait for a real owner verdict.
 */
export const TEST_GATES: Readonly<Record<string, TestGate>> = Object.freeze({
  typecheck: Object.freeze({
    key: 'typecheck',
    script: 'typecheck',
    risk: 'LOW' as RiskLevel,
    description: 'TypeScript compile check (tsc --noEmit). Reads the project; writes nothing.',
    affects: [],
    rollbackPlan: 'Nothing is written, so there is nothing to roll back.',
    timeoutMs: 10 * MINUTE,
    parse: parseTsc,
  }),
  lint: Object.freeze({
    key: 'lint',
    script: 'lint',
    risk: 'LOW' as RiskLevel,
    description: 'ESLint over the project. Reads the project; writes nothing.',
    affects: [],
    rollbackPlan: 'Nothing is written, so there is nothing to roll back.',
    timeoutMs: 10 * MINUTE,
    parse: parseEslint,
  }),
  'theme:check': Object.freeze({
    key: 'theme:check',
    script: 'theme:check',
    risk: 'LOW' as RiskLevel,
    description: 'Verifies the generated theme tokens are in sync with their source.',
    affects: [],
    rollbackPlan: 'The --check form only compares; it writes nothing.',
    timeoutMs: 5 * MINUTE,
    parse: parseNone,
  }),
  test: Object.freeze({
    key: 'test',
    script: 'test',
    risk: 'MEDIUM' as RiskLevel,
    description: 'The unit suite (vitest run). Executes the project’s own test code.',
    affects: [],
    rollbackPlan: 'Unit tests run in-process against temporary directories; nothing durable is written.',
    timeoutMs: 15 * MINUTE,
    parse: parseVitest,
  }),
  build: Object.freeze({
    key: 'build',
    script: 'build',
    risk: 'HIGH' as RiskLevel,
    description: 'Type-checks and produces a production build. Overwrites the build output directory.',
    affects: ['dist/'],
    rollbackPlan: 'Delete dist/ and re-run the previous build. No source file is modified.',
    timeoutMs: 20 * MINUTE,
    parse: parseTsc,
  }),
  'test:e2e': Object.freeze({
    key: 'test:e2e',
    script: 'test:e2e',
    risk: 'HIGH' as RiskLevel,
    description: 'Playwright end-to-end suite. Starts a local server and drives a real browser.',
    affects: ['test-results/', 'playwright-report/'],
    rollbackPlan: 'Delete test-results/ and playwright-report/. No source file is modified.',
    timeoutMs: 30 * MINUTE,
    parse: parsePlaywright,
  }),
  'test:e2e:install': Object.freeze({
    key: 'test:e2e:install',
    script: 'test:e2e:install',
    risk: 'HIGH' as RiskLevel,
    description: 'Downloads the Chromium build Playwright needs. Writes to the machine’s browser cache.',
    affects: ['the Playwright browser cache outside the project'],
    rollbackPlan: 'Remove the Playwright browser cache directory. Nothing inside the project changes.',
    timeoutMs: 30 * MINUTE,
    parse: parseNone,
  }),
  shots: Object.freeze({
    key: 'shots',
    script: 'shots',
    risk: 'HIGH' as RiskLevel,
    description: 'Playwright screenshot run. Starts a local server and overwrites the screenshot artifacts.',
    affects: ['artifacts/screenshots/', 'test-results/'],
    rollbackPlan: 'Restore artifacts/screenshots/ from version control and delete test-results/.',
    timeoutMs: 30 * MINUTE,
    parse: parsePlaywright,
  }),
});

export const TEST_GATE_KEYS: readonly string[] = Object.freeze(Object.keys(TEST_GATES));

/** Payload keys that would mean the caller thinks it can name a command. */
const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = ['command', 'args', 'argv', 'script', 'cmd', 'shell', 'exec', 'env'];

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_PROOF_LIMIT = 500;
const MAX_EXECUTION_LIMIT = 200;

export interface TestDeps {
  readonly projectsRoot?: string;
  readonly now?: () => Date;
  /** TEST-ONLY: shortens the wall-clock ceiling so a harness need not wait. */
  readonly timeoutOverrideMs?: number;
}

/* ========================================================================== */
/*  The runner                                                                 */
/* ========================================================================== */

export interface NpmRunner {
  readonly located: boolean;
  readonly nodeExecutable: string;
  readonly npmCliPath: string | null;
  readonly candidatesTried: readonly string[];
  readonly detail: string;
}

/**
 * Find npm's own JavaScript entry point next to the Node that is running.
 *
 * Only locations relative to `process.execPath` are considered. `%PATH%` is not
 * searched and `npm_execpath` is not read: both are attacker-controllable in a
 * way that would let a different "npm" be executed, and neither is needed on a
 * normal install.
 */
export function locateNpmRunner(): NpmRunner {
  const nodeExecutable = process.execPath;
  const base = dirname(nodeExecutable);
  const candidates = [
    join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(base, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      return {
        located: true,
        nodeExecutable,
        npmCliPath: candidate,
        candidatesTried: candidates,
        detail: 'npm-cli.js was found alongside the running Node runtime',
      };
    }
  }
  return {
    located: false,
    nodeExecutable,
    npmCliPath: null,
    candidatesTried: candidates,
    detail:
      'npm-cli.js could not be found next to the running Node runtime. No gate can be executed; this is reported ' +
      'as UNAVAILABLE rather than worked around with a shell.',
  };
}

/* ========================================================================== */
/*  Project and script availability                                            */
/* ========================================================================== */

interface ResolvedProject {
  readonly record: ProjectRecord;
  readonly canonicalPath: string;
  readonly exists: boolean;
  readonly detail: string;
}

function resolveProject(ctx: OperationContext, projectId: string, deps?: TestDeps): ResolvedProject {
  const projectsRoot = deps?.projectsRoot ?? resolveProjectsRootInfo().projectsRoot;
  const registry = new ProjectRegistry(ctx.store, { projectsRoot });
  const found = registry.get(projectId);
  if (!found.ok) fail(found.error.code, found.error.message, found.error.detail);

  let canonicalPath: string;
  try {
    canonicalPath = assertInsideRoot(found.value.canonicalPath, projectsRoot);
  } catch (error) {
    if (isPathGuardError(error)) fail(error.code, error.message, error.detail);
    fail('PATH_REJECTED', 'The project path could not be validated.', errorText(error));
  }
  const presence = registry.existsOnDisk({ ...found.value, canonicalPath });
  return { record: found.value, canonicalPath, exists: presence.present, detail: presence.detail };
}

export type ScriptAvailability = 'AVAILABLE' | 'SCRIPT_NOT_DECLARED' | 'PACKAGE_JSON_UNREADABLE' | 'RUNNER_UNAVAILABLE';

interface ScriptCheck {
  readonly availability: ScriptAvailability;
  readonly declaredAs: string | null;
  readonly detail: string;
}

interface PackageManifest {
  readonly scripts?: Record<string, unknown>;
}

/**
 * Does the project actually declare this script?
 *
 * Measured by reading the project's own package.json through the guard. A gate
 * is never reported as available because it exists in this table — the table is
 * a permission list, not a claim about somebody else's repository.
 */
function checkScript(projectPath: string, gate: TestGate, runner: NpmRunner): ScriptCheck {
  if (!runner.located) {
    return { availability: 'RUNNER_UNAVAILABLE', declaredAs: null, detail: runner.detail };
  }
  let manifestPath: string;
  try {
    manifestPath = assertInsideRoot(join(projectPath, 'package.json'), projectPath);
  } catch (error) {
    return { availability: 'PACKAGE_JSON_UNREADABLE', declaredAs: null, detail: errorText(error) };
  }
  const read = readJsonSafe<PackageManifest>(manifestPath);
  if (!read.ok) {
    return {
      availability: 'PACKAGE_JSON_UNREADABLE',
      declaredAs: null,
      detail: `package.json could not be read (${read.reason}): ${read.detail}`,
    };
  }
  const scripts = read.value.scripts;
  const declared = scripts === undefined ? undefined : scripts[gate.script];
  if (typeof declared !== 'string' || declared.trim().length === 0) {
    return {
      availability: 'SCRIPT_NOT_DECLARED',
      declaredAs: null,
      detail: `package.json declares no "${gate.script}" script, so this gate cannot be run in this project`,
    };
  }
  return { availability: 'AVAILABLE', declaredAs: declared.slice(0, 300), detail: 'declared in the project package.json' };
}

/* ========================================================================== */
/*  Execution                                                                  */
/* ========================================================================== */

interface ExecOutcome {
  readonly spawned: boolean;
  readonly pid: number | null;
  readonly exitObserved: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  readonly durationMs: number;
}

function killTree(child: ChildProcess, pid: number): void {
  if (process.platform === 'win32') {
    // npm spawns the script in a grandchild; killing only `pid` would orphan it.
    const systemRoot = process.env.SystemRoot;
    const taskkill =
      typeof systemRoot === 'string' && systemRoot.length > 0
        ? join(systemRoot, 'System32', 'taskkill.exe')
        : 'taskkill.exe';
    try {
      spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      /* fall through to the portable path */
    }
  } else {
    try {
      // Negative pid = the process group `detached: true` created.
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* the process may already be gone; the exit handler is the authority */
  }
}

/**
 * Run one argv and wait for its exit.
 *
 * `exitObserved` is set only in the `close` handler — the one place the OS has
 * actually told us the process finished. A spawn is not an exit, and this
 * function never reports one as the other.
 */
function execute(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  startedAtMs: number,
): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((settle) => {
    const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
    const sizes = { out: 0, err: 0 };
    const truncated = { out: false, err: false };
    let timedOut = false;
    let spawnError: string | null = null;
    let done = false;

    const collect = (which: 'out' | 'err', chunk: Buffer): void => {
      if (truncated[which]) return;
      const room = MAX_CAPTURE_BYTES - sizes[which];
      if (room <= 0) {
        truncated[which] = true;
        return;
      }
      const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
      chunks[which].push(slice);
      sizes[which] += slice.byteLength;
      if (slice.byteLength < chunk.byteLength) truncated[which] = true;
    };

    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Colour escapes would corrupt every summary regex below. Nothing
          // about the environment is logged or returned; this only shapes output.
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          npm_config_color: 'false',
        },
      });
    } catch (error) {
      settle({
        spawned: false,
        pid: null,
        exitObserved: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        spawnError: errorText(error),
        durationMs: Date.now() - startedAtMs,
      });
      return;
    }

    const pid = typeof child.pid === 'number' ? child.pid : null;

    const finish = (exitCode: number | null, signal: string | null, exitObserved: boolean): void => {
      if (done) return;
      done = true;
      clearTimer(timer);
      settle({
        spawned: pid !== null,
        pid,
        exitObserved,
        exitCode,
        signal,
        stdout: Buffer.concat(chunks.out).toString('utf8'),
        stderr: Buffer.concat(chunks.err).toString('utf8'),
        stdoutTruncated: truncated.out,
        stderrTruncated: truncated.err,
        timedOut,
        spawnError,
        durationMs: Date.now() - startedAtMs,
      });
    };

    const timer = setTimer(() => {
      timedOut = true;
      if (pid !== null) killTree(child, pid);
      // The kill is issued, not assumed to have worked. `close` still settles
      // this promise; the fallback below only runs if it never arrives.
      const fallback = setTimer(() => finish(null, 'SIGKILL', false), 5_000);
      fallback.unref();
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => collect('out', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('err', chunk));
    child.on('error', (error: Error) => {
      spawnError = errorText(error);
      if (pid === null) finish(null, null, false);
    });
    child.on('close', (code: number | null, signal: string | null) => {
      finish(code, signal, true);
    });
  });
}

/* ========================================================================== */
/*  Evidence files                                                             */
/* ========================================================================== */

interface EvidenceWrite {
  readonly ref: string | null;
  readonly detail: string;
}

/**
 * Persist a captured stream. The ref stored on the record is relative to the
 * workspace data directory, and the absolute path is put through the guard
 * against that directory before anything is written.
 */
function writeStream(dataDir: string, executionId: string, name: 'stdout' | 'stderr', text: string, wasTruncated: boolean): EvidenceWrite {
  const relative = `evidence/tests/${executionId}/${name}.log`;
  try {
    const dir = assertInsideRoot(join(dataDir, 'evidence', 'tests', executionId), dataDir);
    ensureDir(dir);
    const target = assertInsideRoot(join(dir, `${name}.log`), dataDir);
    const body = wasTruncated
      ? `${text}\n[forge] --- capture stopped at ${MAX_CAPTURE_BYTES} bytes; the rest of this stream was not kept ---\n`
      : text;
    writeAtomic(target, body);
    return { ref: relative, detail: `${Buffer.byteLength(body, 'utf8')} bytes written` };
  } catch (error) {
    // A stream we could not persist is not evidence. Saying so is the point:
    // `testPassed` still needs the exit code, but the record must not carry a
    // ref to a file that does not exist.
    return { ref: null, detail: `the ${name} capture could not be written: ${errorText(error)}` };
  }
}

/* ========================================================================== */
/*  Derivation                                                                 */
/* ========================================================================== */

export interface Derivation {
  readonly passed: boolean;
  readonly basis: string;
  /** Non-null when the exit code and the parsed counts tell different stories. */
  readonly disagreement: string | null;
}

/**
 * The verdict, and how it was reached.
 *
 * `testPassed` is the contract's function and is the only thing that decides
 * `passed`. The disagreement check runs beside it and never overrides it: when
 * the two signals conflict the honest outcome is "not a pass, and here is the
 * conflict", not a choice between them.
 */
export function derive(execution: TestExecution, parse: GateParse): Derivation {
  const passed = testPassed(execution);
  const exitCode = execution.exitCode;
  let disagreement: string | null = null;

  if (exitCode !== null && parse.failureSignal !== null) {
    if (exitCode === 0 && parse.failureSignal > 0) {
      disagreement =
        `the process exited 0 but its own output reports ${parse.failureSignal} failure(s) ` +
        `(${parse.source}). One of the two is wrong; this execution is not recorded as a pass.`;
    } else if (exitCode !== 0 && parse.failureSignal === 0) {
      disagreement =
        `the process exited ${exitCode} but its own output reports 0 failures (${parse.source}). ` +
        'The non-zero exit stands; the conflict is recorded rather than explained away.';
    }
  }

  const basis =
    exitCode === null
      ? 'no exit code was ever read, so nothing can be claimed about this execution'
      : `exit code ${exitCode}; ` +
        (execution.counts === null
          ? `counts UNAVAILABLE (${parse.source})`
          : `counts ${execution.counts.passed} passed / ${execution.counts.failed} failed / ${execution.counts.skipped} skipped (${parse.source})`);

  return { passed: passed && disagreement === null, basis, disagreement };
}

/* ========================================================================== */
/*  Proof                                                                      */
/* ========================================================================== */

function recordProof(
  ctx: OperationContext,
  entry: ProofEntry,
  notes: string[],
): void {
  try {
    ctx.store.saveRecord('proof', entry);
  } catch (error) {
    notes.push(`the proof entry ${entry.id} could not be persisted: ${errorText(error)}`);
    return;
  }
  try {
    ctx.events.publish({
      projectId: entry.projectId,
      runId: entry.runId,
      taskId: entry.taskId,
      source: 'test',
      type: 'proof.recorded',
      payload: {
        proofId: entry.id,
        claim: entry.claim,
        verdict: entry.verdict,
        reason: entry.reason,
        command: entry.command,
      },
      evidenceRefs: entry.evidenceRefs,
    });
  } catch (error) {
    notes.push(`the proof entry was written, but the proof.recorded event could not be appended: ${errorText(error)}`);
  }
}

/* ========================================================================== */
/*  State tracking                                                             */
/* ========================================================================== */

/**
 * A tiny wrapper so every state change goes through `assertTestTransition`.
 * Writing `execution.status = 'COMPLETED'` anywhere in this file would bypass
 * the machine; there is deliberately no other way to move.
 */
class TestStateTrack {
  private current: TestState = 'CREATED';
  readonly history: { from: TestState; to: TestState; at: string }[] = [];

  to(next: TestState, at: string): TestState {
    assertTestTransition(this.current, next);
    this.history.push({ from: this.current, to: next, at });
    this.current = next;
    return next;
  }

  get state(): TestState {
    return this.current;
  }
}

/** Executions this process is actually running right now, by id. */
const LIVE_EXECUTIONS = new Set<string>();

/* ========================================================================== */
/*  runApprovedTest                                                            */
/* ========================================================================== */

function assertNoCommandInPayload(body: Record<string, unknown>): void {
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      fail(
        'BAD_REQUEST',
        `runApprovedTest takes an allowlist key in "gate" and nothing else; "${key}" is not accepted.`,
        `Allowed gates: ${TEST_GATE_KEYS.join(', ')}.`,
      );
    }
  }
}

function persist(ctx: OperationContext, execution: TestExecution, notes: string[]): void {
  try {
    ctx.store.saveRecord('test', execution);
  } catch (error) {
    notes.push(`the test execution record could not be persisted: ${errorText(error)}`);
  }
}

function emitTestEvent(
  ctx: OperationContext,
  type: 'test.started' | 'test.finished',
  execution: TestExecution,
  payload: Record<string, unknown>,
  notes: string[],
): void {
  try {
    ctx.events.publish({
      projectId: execution.projectId,
      runId: execution.runId,
      source: 'test',
      type,
      status: execution.status,
      payload: { executionId: execution.id, gate: execution.gate, ...payload },
      evidenceRefs: execution.evidenceRefs,
    });
  } catch (error) {
    notes.push(`the ${type} event could not be appended: ${errorText(error)}`);
  }
}

async function runApprovedTest(
  payload: unknown,
  ctx: OperationContext,
  deps?: TestDeps,
): Promise<Record<string, unknown>> {
  const body = asObject(payload);
  assertNoCommandInPayload(body);

  const projectId = reqString(body, 'projectId');
  const gateKey = reqString(body, 'gate', 64);
  const runId = optString(body, 'runId') ?? null;
  const approvalId = optString(body, 'approvalId');
  const requestedBy = optString(body, 'requestedBy', 128) ?? ctx.clientId ?? 'bridge';

  // `hasOwnProperty`, not `in`: `TEST_GATES['toString']` would otherwise reach
  // Object.prototype and hand back something that is not a gate at all.
  if (!Object.prototype.hasOwnProperty.call(TEST_GATES, gateKey)) {
    fail(
      'BAD_REQUEST',
      `"${gateKey}" is not an allowlisted gate.`,
      `Allowed gates: ${TEST_GATE_KEYS.join(', ')}. The client sends a key; it never sends a command.`,
    );
  }
  const gate = TEST_GATES[gateKey];

  const now = deps?.now ?? (() => new Date());
  const notes: string[] = [];
  const project = resolveProject(ctx, projectId, deps);
  const runner = locateNpmRunner();
  const io = ioFromContext(ctx, deps);

  const track = new TestStateTrack();
  const executionId = `test-${randomUUID()}`;
  const startedAt = now();
  const label = `npm run ${gate.script}`;

  /**
   * `command` and `args` record what is ACTUALLY spawned — the Node executable
   * and npm's own entry point — not the readable `npm run x` label. A record
   * that stored the label would not let anyone re-derive what really ran.
   */
  const baseExecution = (status: TestState, evidenceRefs: readonly EvidenceRef[]): TestExecution => ({
    id: executionId,
    projectId: project.record.id,
    runId,
    gate: gate.key,
    command: runner.nodeExecutable,
    args: runner.npmCliPath === null ? ['run', gate.script] : [runner.npmCliPath, 'run', gate.script],
    cwd: project.canonicalPath,
    startedAt: startedAt.toISOString(),
    endedAt: null,
    durationMs: null,
    exitCode: null,
    stdoutRef: null,
    stderrRef: null,
    counts: null,
    status,
    evidenceRefs,
  });

  /* ---- pre-flight. Nothing is recorded until these are true --------------- */

  if (!project.exists) {
    fail(
      'INVALID_STATE',
      `The project directory is not on disk, so no gate can be run in it.`,
      project.detail,
    );
  }
  const scriptCheck = checkScript(project.canonicalPath, gate, runner);
  if (scriptCheck.availability !== 'AVAILABLE' || runner.npmCliPath === null) {
    fail(
      scriptCheck.availability === 'RUNNER_UNAVAILABLE' ? 'RUNTIME_ERROR' : 'INVALID_STATE',
      `The gate "${gate.key}" cannot be executed in project ${project.record.id}.`,
      scriptCheck.detail,
    );
  }

  /* ---- the approval gate -------------------------------------------------- */

  const action = `run the ${gate.key} gate`;
  /** The verdict that authorised this execution. Null when none was needed. */
  let authorisingApproval: ApprovalRequest | null = null;

  if (requiresApproval(gate.risk)) {
    const verdict = checkApproval(io, {
      projectId: project.record.id,
      runId,
      operation: 'runApprovedTest',
      action,
      ...(approvalId !== undefined ? { approvalId } : {}),
    });

    if (verdict.state !== 'APPROVED') {
      // WAITING_FOR_PERMISSION is a real, persisted state, not a return value.
      // Nothing has been spawned and nothing will be until a verdict exists.
      track.to('WAITING_FOR_PERMISSION', startedAt.toISOString());

      // A client that NAMED an approval is asserting "use this one". If that one
      // is dead, the honest answer for this execution is BLOCKED — silently
      // opening a different request would answer a question nobody asked.
      const namedADeadApproval =
        approvalId !== undefined &&
        (verdict.state === 'DENIED' || verdict.state === 'EXPIRED' || verdict.state === 'MISMATCHED' || verdict.state === 'NONE');

      if (namedADeadApproval) {
        const blockedRefs: readonly EvidenceRef[] =
          verdict.approval === null
            ? []
            : [{ kind: 'verdict', ref: `approval:${verdict.approval.id}`, note: `${verdict.state}: ${verdict.reason}` }];
        const waiting = baseExecution('WAITING_FOR_PERMISSION', blockedRefs);
        persist(ctx, waiting, notes);
        const blocked = { ...waiting, status: track.to('BLOCKED', now().toISOString()) };
        persist(ctx, blocked, notes);
        return {
          executionId,
          gate: gate.key,
          label,
          status: blocked.status,
          passed: null,
          outcome: verdict.state === 'DENIED' ? 'DENIED' : verdict.state === 'EXPIRED' ? 'APPROVAL_EXPIRED' : 'APPROVAL_UNUSABLE',
          reason: `${verdict.reason} Nothing was executed.`,
          approval: verdict.approval,
          execution: blocked,
          stateHistory: track.history,
          notes,
          nextStep: 'Call runApprovedTest without approvalId to open a fresh request, then approve that one.',
        };
      }

      // Otherwise: ask (or keep asking). A DENIED or EXPIRED request stays on
      // disk exactly as it was — it is never rewritten — and a NEW request is
      // opened so the owner can be asked again. That is what "a denial is final;
      // asking again means a new id" means in practice. The operation still does
      // not proceed, which is the part that matters.
      const previous = verdict.state === 'DENIED' || verdict.state === 'EXPIRED' ? verdict.approval : null;
      const opened =
        verdict.state === 'PENDING'
          ? verdict.approval
          : requestApproval(io, {
              projectId: project.record.id,
              runId,
              requestedBy,
              action,
              operation: 'runApprovedTest',
              affects: gate.affects.length > 0 ? gate.affects : ['(nothing outside the project was declared)'],
              risk: gate.risk,
              reason: `${gate.description} It runs "${label}" with cwd ${project.record.relativePath || '.'}.`,
              rollbackPlan: gate.rollbackPlan,
              evidenceRefs: [
                { kind: 'file', ref: 'package.json', note: `the script this gate runs: ${scriptCheck.declaredAs ?? 'unknown'}` },
              ],
            }).approval;

      const waiting = baseExecution(
        'WAITING_FOR_PERMISSION',
        opened === null
          ? []
          : [{ kind: 'verdict', ref: `approval:${opened.id}`, note: `PENDING at ${startedAt.toISOString()}` }],
      );
      persist(ctx, waiting, notes);

      return {
        executionId,
        gate: gate.key,
        label,
        status: waiting.status,
        passed: null,
        outcome: 'WAITING_FOR_PERMISSION',
        reason:
          previous === null
            ? verdict.reason
            : `${verdict.reason} A new request has been opened; nothing runs until that one is answered.`,
        approval: opened,
        previousVerdict:
          previous === null ? null : { state: verdict.state, approvalId: previous.id, resolvedAt: previous.resolvedAt },
        execution: waiting,
        stateHistory: track.history,
        notes,
        nextStep: 'Call approveAction or denyAction with this approval id, then call runApprovedTest again.',
      };
    }

    // An approval authorises ONE execution. Re-using it would turn a single yes
    // into a standing permission, so a previous execution that cited it blocks.
    authorisingApproval = verdict.approval;
    const consumed = findConsumingExecution(ctx, authorisingApproval?.id ?? '');
    if (consumed !== null) {
      fail(
        'CONFLICT',
        `Approval ${authorisingApproval?.id ?? ''} was already used by execution ${consumed}. An approval authorises one run.`,
        'Request a new approval to run this gate again.',
      );
    }
    notes.push(`authorised by approval ${authorisingApproval?.id ?? 'unknown'} (${verdict.reason})`);
  }

  /* ---- execution ---------------------------------------------------------- */

  const approvalRef: readonly EvidenceRef[] =
    authorisingApproval === null
      ? []
      : [
          {
            kind: 'verdict',
            ref: `approval:${authorisingApproval.id}`,
            note: `the owner approval that authorised this execution (resolved ${authorisingApproval.resolvedAt ?? 'at an unrecorded time'})`,
          },
        ];

  track.to('QUEUED', now().toISOString());
  const argv = [runner.nodeExecutable, runner.npmCliPath, 'run', gate.script];
  const timeoutMs = deps?.timeoutOverrideMs ?? gate.timeoutMs;
  const startedAtMs = Date.now();

  const queued = baseExecution('QUEUED', approvalRef);
  persist(ctx, queued, notes);
  LIVE_EXECUTIONS.add(executionId);

  let outcome: ExecOutcome;
  try {
    outcome = await execute(argv, project.canonicalPath, timeoutMs, startedAtMs);
  } finally {
    LIVE_EXECUTIONS.delete(executionId);
  }

  if (!outcome.spawned) {
    // The OS never created a process. QUEUED -> BLOCKED is the honest move: we
    // never reached STARTING, so claiming a failed run would invent an attempt.
    const blockedStatus = track.to('BLOCKED', now().toISOString());
    const blocked: TestExecution = {
      ...queued,
      status: blockedStatus,
      endedAt: now().toISOString(),
      durationMs: outcome.durationMs,
      evidenceRefs: [
        ...approvalRef,
        { kind: 'stderr', ref: 'spawn', note: outcome.spawnError ?? 'the child process was never created' },
      ],
    };
    persist(ctx, blocked, notes);
    return {
      executionId,
      gate: gate.key,
      label,
      status: blockedStatus,
      passed: false,
      outcome: 'SPAWN_FAILED',
      reason: `The child process was never created: ${outcome.spawnError ?? 'no pid was assigned'}. Nothing executed.`,
      execution: blocked,
      stateHistory: track.history,
      notes,
    };
  }

  track.to('STARTING', new Date(startedAtMs).toISOString());
  track.to('RUNNING', new Date(startedAtMs).toISOString());
  emitTestEvent(
    ctx,
    'test.started',
    { ...queued, status: 'RUNNING' },
    { label, pid: outcome.pid, cwd: project.canonicalPath, argvLength: argv.length, timeoutMs },
    notes,
  );

  const endedAt = now();
  const stdoutWrite = writeStream(ctx.store.dataDir, executionId, 'stdout', outcome.stdout, outcome.stdoutTruncated);
  const stderrWrite = writeStream(ctx.store.dataDir, executionId, 'stderr', outcome.stderr, outcome.stderrTruncated);
  const parse = gate.parse(outcome.stdout, outcome.stderr);

  const evidenceRefs: EvidenceRef[] = [
    ...approvalRef,
    {
      kind: 'exit-code',
      ref: outcome.exitCode === null ? 'none-observed' : String(outcome.exitCode),
      note: outcome.exitObserved
        ? 'read from the process close event'
        : 'the process exit was never observed; no exit code exists for this execution',
    },
  ];
  if (stdoutWrite.ref !== null) evidenceRefs.push({ kind: 'stdout', ref: stdoutWrite.ref, note: stdoutWrite.detail });
  else notes.push(stdoutWrite.detail);
  if (stderrWrite.ref !== null) evidenceRefs.push({ kind: 'stderr', ref: stderrWrite.ref, note: stderrWrite.detail });
  else notes.push(stderrWrite.detail);

  // The draft carries everything that was observed and still says RUNNING,
  // because at this point nothing has decided anything. `derive` reads it.
  const draft: TestExecution = {
    ...queued,
    endedAt: endedAt.toISOString(),
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    stdoutRef: stdoutWrite.ref,
    stderrRef: stderrWrite.ref,
    counts: parse.counts,
    status: 'RUNNING',
    evidenceRefs,
  };
  const derivation = derive(draft, parse);

  // The exit code decides the terminal state, and the record's semantic rule
  // refuses COMPLETED or FAILED without one — so a killed process whose exit was
  // never observed goes through STOPPING to CANCELLED rather than being dressed
  // up as a failure it never actually reported.
  let terminal: TestState;
  if (outcome.exitCode === null) {
    track.to('STOPPING', endedAt.toISOString());
    terminal = track.to('CANCELLED', endedAt.toISOString());
  } else {
    terminal = track.to(derivation.passed ? 'COMPLETED' : 'FAILED', endedAt.toISOString());
  }

  const execution: TestExecution = { ...draft, status: terminal };
  persist(ctx, execution, notes);
  emitTestEvent(
    ctx,
    'test.finished',
    execution,
    {
      label,
      passed: derivation.passed,
      basis: derivation.basis,
      disagreement: derivation.disagreement,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      counts: parse.counts,
      failureSignal: parse.failureSignal,
    },
    notes,
  );

  /* ---- proof -------------------------------------------------------------- */

  const proofEntries: ProofEntry[] = [
    {
      id: `proof-${randomUUID()}`,
      projectId: project.record.id,
      runId,
      taskId: null,
      timestamp: endedAt.toISOString(),
      claim: `gate "${gate.key}" ${derivation.passed ? 'passed' : 'did not pass'} in project ${project.record.id}`,
      agentId: null,
      command: label,
      verdict: derivation.passed ? 'accepted' : 'rejected',
      reason: outcome.timedOut
        ? `the execution was killed after ${timeoutMs}ms; ${derivation.basis}`
        : derivation.basis,
      evidenceRefs,
    },
  ];
  if (derivation.disagreement !== null) {
    // The finding, recorded as its own entry so it survives independently of the
    // execution's own verdict and is visible in listProof.
    proofEntries.push({
      id: `proof-${randomUUID()}`,
      projectId: project.record.id,
      runId,
      taskId: null,
      timestamp: endedAt.toISOString(),
      claim: `the ${gate.key} runner's exit code and its own reported counts agree`,
      agentId: null,
      command: label,
      verdict: 'rejected',
      reason: derivation.disagreement,
      evidenceRefs,
    });
  }
  for (const entry of proofEntries) recordProof(ctx, entry, notes);

  return {
    executionId,
    gate: gate.key,
    label,
    status: terminal,
    passed: derivation.passed,
    outcome: outcome.timedOut
      ? 'TIMED_OUT'
      : terminal === 'COMPLETED'
        ? 'PASSED'
        : terminal === 'CANCELLED'
          ? 'NO_EXIT_OBSERVED'
          : 'FAILED',
    reason: derivation.basis,
    disagreement: derivation.disagreement,
    exitCode: outcome.exitCode,
    exitObserved: outcome.exitObserved,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    timeoutMs,
    durationMs: outcome.durationMs,
    counts: parse.counts,
    countsSource: parse.source,
    failureSignal: parse.failureSignal,
    stdoutRef: stdoutWrite.ref,
    stderrRef: stderrWrite.ref,
    stdoutTruncated: outcome.stdoutTruncated,
    stderrTruncated: outcome.stderrTruncated,
    execution,
    proof: proofEntries,
    stateHistory: track.history,
    notes,
  };
}

/** Has this approval already authorised an execution? Returns that id, or null. */
function findConsumingExecution(ctx: OperationContext, approvalId: string): string | null {
  if (approvalId.length === 0) return null;
  const ref = `approval:${approvalId}`;
  for (const execution of ctx.store.listRecords('test').records) {
    if (execution.evidenceRefs.some((e) => e.kind === 'verdict' && e.ref === ref)) {
      // A record still WAITING_FOR_PERMISSION is the request itself, not a use.
      if (execution.status !== 'WAITING_FOR_PERMISSION') return execution.id;
    }
  }
  return null;
}

/* ========================================================================== */
/*  listTests                                                                  */
/* ========================================================================== */

function describeExecution(execution: TestExecution): Record<string, unknown> {
  const live = execution.status === 'RUNNING' || execution.status === 'STARTING' || execution.status === 'QUEUED';
  return {
    ...execution,
    passed: testPassed(execution),
    // A record that claims to be live but is not tracked by this process cannot
    // be defended: it belongs to a bridge instance that is gone.
    liveClaimVerified: live ? LIVE_EXECUTIONS.has(execution.id) : null,
    liveClaimNote:
      live && !LIVE_EXECUTIONS.has(execution.id)
        ? `UNVERIFIED — this record still claims ${execution.status}, but no execution with this id is running in this bridge process.`
        : null,
  };
}

function listTests(payload: unknown, ctx: OperationContext, deps?: TestDeps): Record<string, unknown> {
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const limit = optInteger(body, 'limit', 1, MAX_EXECUTION_LIMIT) ?? 50;

  const project = resolveProject(ctx, projectId, deps);
  const runner = locateNpmRunner();
  const io = ioFromContext(ctx, deps);

  const listed = ctx.store.listRecords('test');
  const executions = listed.records
    .filter((e) => e.projectId === project.record.id)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));

  const gates = TEST_GATE_KEYS.map((key) => {
    const gate = TEST_GATES[key];
    const check = project.exists
      ? checkScript(project.canonicalPath, gate, runner)
      : {
          availability: 'PACKAGE_JSON_UNREADABLE' as ScriptAvailability,
          declaredAs: null,
          detail: `the project directory is not on disk: ${project.detail}`,
        };
    const last = executions.find((e) => e.gate === key) ?? null;
    const approval = requiresApproval(gate.risk)
      ? checkApproval(io, {
          projectId: project.record.id,
          operation: 'runApprovedTest',
          action: `run the ${key} gate`,
        })
      : null;

    return {
      key,
      script: gate.script,
      label: `npm run ${gate.script}`,
      // The exact argv that would be spawned. No shell, no interpolation point.
      argv: runner.npmCliPath === null ? null : [runner.nodeExecutable, runner.npmCliPath, 'run', gate.script],
      cwd: project.canonicalPath,
      risk: gate.risk,
      requiresApproval: requiresApproval(gate.risk),
      approvalState: approval === null ? null : approval.state,
      approvalId: approval?.approval?.id ?? null,
      description: gate.description,
      affects: gate.affects,
      rollbackPlan: gate.rollbackPlan,
      timeoutMs: gate.timeoutMs,
      available: check.availability === 'AVAILABLE',
      availability: check.availability,
      declaredAs: check.declaredAs,
      detail: check.detail,
      lastExecution: last === null ? null : describeExecution(last),
    };
  });

  return {
    projectId: project.record.id,
    projectPath: project.canonicalPath,
    projectDirectoryPresent: project.exists,
    projectDirectoryDetail: project.detail,
    runner: {
      kind: 'npm',
      nodeExecutable: runner.nodeExecutable,
      npmCliPath: runner.npmCliPath,
      located: runner.located,
      shell: false,
      detail: runner.detail,
      candidatesTried: runner.candidatesTried,
    },
    gates,
    executions: executions.slice(0, limit).map(describeExecution),
    executionCount: executions.length,
    unreadableRecords: listed.unreadable,
    note:
      'The client selects a gate by key. There is no operation on this bridge that accepts a command string, and ' +
      'availability above was measured by reading the project package.json, not assumed from this table.',
  };
}

/* ========================================================================== */
/*  listProof                                                                  */
/* ========================================================================== */

function listProof(payload: unknown, ctx: OperationContext, deps?: TestDeps): Record<string, unknown> {
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const runId = optString(body, 'runId');
  const taskId = optString(body, 'taskId');
  const verdict = optString(body, 'verdict', 16);
  const limit = optInteger(body, 'limit', 1, MAX_PROOF_LIMIT) ?? 100;

  if (verdict !== undefined && !['accepted', 'rejected', 'pending'].includes(verdict)) {
    fail('BAD_REQUEST', 'verdict must be accepted, rejected or pending.');
  }

  const project = resolveProject(ctx, projectId, deps);
  const listed = ctx.store.listRecords('proof');

  let entries = listed.records.filter((p) => p.projectId === project.record.id);
  if (runId !== undefined) entries = entries.filter((p) => p.runId === runId);
  if (taskId !== undefined) entries = entries.filter((p) => p.taskId === taskId);
  if (verdict !== undefined) entries = entries.filter((p) => p.verdict === verdict);
  entries = [...entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const page = entries.slice(0, limit);
  return {
    projectId: project.record.id,
    proof: page,
    count: page.length,
    total: entries.length,
    truncated: entries.length > page.length,
    summary: {
      accepted: entries.filter((p) => p.verdict === 'accepted').length,
      rejected: entries.filter((p) => p.verdict === 'rejected').length,
      pending: entries.filter((p) => p.verdict === 'pending').length,
    },
    unreadableRecords: listed.unreadable,
    note:
      'Every entry names the command that produced it and the evidence refs it rests on. An entry with no evidence ' +
      'refs is not proof of anything and is shown as such.',
  };
}

/* ========================================================================== */
/*  Registration                                                               */
/* ========================================================================== */

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export function registerTestOperations(
  router: Router,
  deps?: TestDeps,
  options: { readonly override?: boolean } = {},
): void {
  router.register('listTests', (payload, ctx) => listTests(payload, ctx, deps), options);
  router.register('runApprovedTest', (payload, ctx) => runApprovedTest(payload, ctx, deps), options);
  router.register('listProof', (payload, ctx) => listProof(payload, ctx, deps), options);
}
