/**
 * Forge Workspace — the Claude Code process adapter.
 *
 * Spawn, stream, resume, cancel. This is the only file in the bridge that
 * creates a child process, and it does so under four rules that are not
 * negotiable.
 *
 * 1. ARGV ARRAY, `shell: false`, ALWAYS. Nothing is ever concatenated into a
 *    command string. There is no interpolation point for `&`, `|`, backticks or
 *    `%VAR%` to be interpreted, because nothing ever interprets.
 *
 * 2. THE PROMPT IS DATA, AND IS FENCED OFF AS DATA. This was verified against
 *    the real CLI, not assumed:
 *
 *        claude -p "--bogus-flag-xyz" --output-format json
 *        → exit 1, "error: unknown option '--bogus-flag-xyz'"
 *
 *        claude -p --output-format json -- "--bogus-flag-xyz"
 *        → exit 0, the text arrives as the prompt, verbatim
 *
 *    The prompt comes from a browser text box. Without the `--` terminator, a
 *    user who types `--dangerously-skip-permissions` is not sending a message —
 *    they are passing a flag. That is a privilege-escalation path straight
 *    through the permission boundary. So the prompt is ALWAYS last and ALWAYS
 *    behind `--`, which is a deliberate deviation from the literal base-argv
 *    ordering in the work order, made because the literal ordering is exploitable
 *    and this one is not.
 *
 * 3. EVERY FLAG IS GATED ON THE PROBE. `locate.ts` reads `--help` once and the
 *    adapter passes nothing that is not in that set. `--max-turns` does not
 *    exist in 2.1.217; it is additionally in `FORBIDDEN_FLAGS`, and a final
 *    assertion re-checks the assembled argv immediately before spawn, so three
 *    independent things would have to fail for it to reach the CLI.
 *
 * 4. A STATUS IS A CLAIM ABOUT REALITY.
 *    - RUNNING is claimed only once the OS has assigned a pid.
 *    - STREAMING only once a line has actually parsed.
 *    - COMPLETED only when the exit code was read AND a `result` envelope with
 *      `is_error: false` was seen. Exit 0 with no envelope is INTERRUPTED, not
 *      success: a process that exits 0 has proved that it exited.
 *    - CANCELLED only after the exit was OBSERVED. A kill that was issued is
 *      not a process that died. If the exit never arrives, the run stays
 *      STOPPING and the failure to confirm is recorded.
 *
 * CANCELLATION AND THE PROCESS TREE. `claude.exe` starts children. Killing only
 * the parent leaves them running and the run's real state becomes unknowable, so
 * cancel walks the tree — `taskkill /T` on win32, the process group elsewhere —
 * and only ever the tree of the pid registered for THAT runId. It cannot reach
 * another run's process: the pid comes from our own registry, and the kill is
 * issued only while our `ChildProcess` handle still reports the child as live.
 * On Windows that handle keeps the OS process object open, which is what makes
 * pid reuse impossible in the window between the check and the kill; on POSIX
 * the pid is reserved until Node reaps it, and the signal goes to the group.
 *
 * The relative `.ts` imports are deliberate: Node 24 executes TypeScript
 * directly and requires the explicit extension, and bridge code is permitted
 * relative imports.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, fsyncSync, openSync, statSync, writeSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers';
import os from 'node:os';
import process from 'node:process';

import type { EventType, EvidenceRef, OperationalStatus, UsageSnapshot } from '../../shared/protocol.ts';
import { assertInsideRoot } from '../security/paths.ts';
import { containedPath, ensureDir, isPidAlive, sha256, writeJsonAtomic } from '../storage/atomic.ts';
import { assertSafeId } from '../storage/store.ts';
import {
  ClaudeStreamParser,
  redactSecrets,
  safeExcerpt,
  splitLines,
} from './parse.ts';
import type { ForgeEventDraft, StreamCounters } from './parse.ts';
import {
  EFFORT_LEVELS,
  FORBIDDEN_FLAGS,
  FORBIDDEN_PERMISSION_MODES,
  descriptionMentions,
  supportsChoice,
  supportsFlag,
} from './locate.ts';
import type { LocatedClaude } from './locate.ts';

/* ========================================================================== */
/*  Configuration types                                                        */
/* ========================================================================== */

/**
 * The permission modes this bridge will run under.
 *
 * `bypassPermissions` is absent from the union on purpose: a mode that cannot be
 * named cannot be configured, whatever a settings file says. It is additionally
 * refused at run time by `FORBIDDEN_PERMISSION_MODES`.
 */
export type PermissionMode = 'acceptEdits' | 'auto' | 'manual' | 'dontAsk' | 'plan';

export const ALLOWED_PERMISSION_MODES: readonly PermissionMode[] = [
  'acceptEdits',
  'auto',
  'manual',
  'dontAsk',
  'plan',
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Windows' `CreateProcess` command line is capped at 32767 characters. A prompt
 * longer than this budget does not fail cleanly — it fails somewhere inside the
 * OS with an error the user cannot act on — so it is refused up front with a
 * message that says what happened.
 */
const MAX_PROMPT_CHARS = 28_000;

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_FORCE_WAIT_MS = 5_000;
const DEFAULT_MAX_LINE_CHARS = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_EVENTS = 200;
const TASKKILL_TIMEOUT_MS = 15_000;

/**
 * The stderr hand-over buffer. See `consumeStderr`.
 *
 * A process that writes megabytes without ever emitting a newline must not be buffered until it
 * exits — the events would arrive too late to be a live view, and the buffer would grow without a
 * ceiling. Past this many held-back characters the tail is released anyway, keeping only the last
 * `STDERR_CARRY_KEEP_CHARS` so a credential sitting on the forced split is still whole next time.
 *
 * HONEST LIMIT: a single secret longer than the keep window can still be cut by that forced release.
 * 4 KiB is longer than every shape `redactSecrets` knows (the longest realistic one is a JWT with a
 * fat payload), but "longer than anything we have seen" is not "impossible", and this is a denylist
 * either way. It narrows the window; it does not claim to close it.
 */
const STDERR_CARRY_FORCE_FLUSH_CHARS = 64 * 1024;
const STDERR_CARRY_KEEP_CHARS = 4 * 1024;

const REDACTION_MARKER = '[REDACTED';

function countRedactionMarkers(text: string): number {
  let found = 0;
  let at = text.indexOf(REDACTION_MARKER);
  while (at !== -1) {
    found += 1;
    at = text.indexOf(REDACTION_MARKER, at + REDACTION_MARKER.length);
  }
  return found;
}

/**
 * `redactSecrets`, plus how many values it actually replaced.
 *
 * The count is derived from the markers the redactor writes, minus any the input already contained —
 * text that arrives with a literal "[REDACTED" in it (a log line quoting an earlier redaction, or
 * someone trying to spoof the tally) must not inflate the number. It is a lower bound on what was
 * there, never an invented one.
 */
function redactAndCount(text: string): { readonly text: string; readonly redactions: number } {
  const alreadyMarked = countRedactionMarkers(text);
  const redacted = redactSecrets(text);
  return { text: redacted, redactions: Math.max(0, countRedactionMarkers(redacted) - alreadyMarked) };
}

export type EventSink = (draft: ForgeEventDraft) => void;

export interface AdapterOptions {
  /** The probed runtime. Every flag decision is made against this. */
  readonly located: LocatedClaude;
  /** Containment root. No run may be started outside it. */
  readonly trustedRoot: string;
  /** Absolute directory that receives per-run stdout/stderr/exit evidence. */
  readonly evidenceDir: string;
  /** Where events go. Wired to `ForgeStore.appendEvent` by the bridge. */
  readonly emit: EventSink;
  readonly now?: () => Date;
  readonly graceMs?: number;
  readonly forceWaitMs?: number;
  readonly maxLineChars?: number;
  readonly maxStderrBytes?: number;
  readonly maxStderrEvents?: number;
  /** TEST-ONLY seam. Forces win32 vs posix cancellation semantics. */
  readonly platform?: string;
  /**
   * TEST-ONLY seam. Replaces the child-process factory so the stream handling can be driven against
   * a scripted child instead of a real executable — the only way to put a chunk boundary in an exact
   * place, which is what the stderr redaction tests need.
   *
   * It widens nothing. Every gate that decides WHAT may be spawned — the path guard, the flag gate,
   * `assertArgvIsSafe` — has already run by the time this is called, and it is set only by the code
   * that constructs the adapter, never from a request. It sits beside the existing `now` and
   * `platform` seams for the same reason: behaviour that depends on the environment has to be
   * substitutable or it cannot be tested at all.
   */
  readonly spawnChild?: typeof spawn;
}

export interface StartRunRequest {
  readonly runId: string;
  readonly projectId: string;
  /** Validated by the path guard against the trusted root before any use. */
  readonly projectPath: string;
  readonly conversationId: string | null;
  readonly prompt: string;
  readonly permissionMode: PermissionMode;
  /** UUID for a NEW conversation. Generated when omitted. */
  readonly sessionId?: string | null;
  /** Session to continue. Mutually exclusive with `sessionId`. */
  readonly resumeSessionId?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly taskId?: string | null;
  readonly agentId?: string | null;
  /** Wall-clock ceiling. Omitted means no ceiling. */
  readonly timeoutMs?: number;
  readonly includeToolResultExcerpt?: boolean;
}

/* ========================================================================== */
/*  Typed errors                                                               */
/* ========================================================================== */

export type AdapterRejection =
  | 'BAD_PROMPT'
  | 'BAD_SESSION_ID'
  | 'BAD_PERMISSION_MODE'
  | 'MISSING_REQUIRED_FLAG'
  | 'FORBIDDEN_FLAG'
  | 'DUPLICATE_RUN'
  | 'BAD_PROJECT_PATH'
  /**
   * A caller-supplied value that would be parsed as a command-line option
   * rather than as a value. Argument injection, not shell injection — `shell:
   * false` does nothing against it, because the smuggled option is a genuine
   * element of the argv array.
   */
  | 'UNSAFE_ARGUMENT';

export class AdapterError extends Error {
  readonly rejection: AdapterRejection;
  readonly detail: string | undefined;

  constructor(rejection: AdapterRejection, message: string, detail?: string) {
    super(message);
    this.name = 'AdapterError';
    this.rejection = rejection;
    this.detail = detail;
    Object.setPrototypeOf(this, AdapterError.prototype);
  }
}

/* ========================================================================== */
/*  Argv construction                                                          */
/* ========================================================================== */

export interface BuiltArgv {
  readonly argv: readonly string[];
  /** Flags that were wanted, are unsupported, and were therefore dropped. */
  readonly degraded: readonly string[];
  /** True only when `--include-partial-messages` really made it into the argv. */
  readonly partialMessagesEnabled: boolean;
  readonly resumed: boolean;
  /** The session id passed with `--session-id`, when one was. */
  readonly newSessionId: string | null;
}

/**
 * Assemble the argv for one message.
 *
 * Pure and exported so it can be asserted on directly: the highest-value test
 * in this module is "given a runtime that does not support X, X is not in the
 * argv", and that test should not have to spawn anything.
 *
 * Everything optional degrades. Two things do not: the output format and the
 * permission mode. If `stream-json` is unavailable there is no live streaming to
 * degrade to and the caller must be told rather than shown a frozen screen; if
 * the permission mode cannot be set, the run would inherit an unknown default,
 * so it fails closed. A security control that silently degrades is not a control.
 */
export function buildClaudeArgv(
  located: LocatedClaude,
  request: StartRunRequest,
  canonicalProjectPath: string,
): BuiltArgv {
  const degraded: string[] = [];

  if (typeof request.prompt !== 'string' || request.prompt.length === 0) {
    throw new AdapterError('BAD_PROMPT', 'A message must carry a non-empty prompt.');
  }
  if (request.prompt.length > MAX_PROMPT_CHARS) {
    throw new AdapterError(
      'BAD_PROMPT',
      `The prompt is ${String(request.prompt.length)} characters; the process command line cannot carry more than ${String(MAX_PROMPT_CHARS)}.`,
      'Send the material as an attachment and reference it, rather than inlining it.',
    );
  }
  if (!ALLOWED_PERMISSION_MODES.includes(request.permissionMode)) {
    throw new AdapterError(
      'BAD_PERMISSION_MODE',
      `Permission mode ${safeExcerpt(request.permissionMode, 40)} is not one this bridge will run under.`,
    );
  }
  if (FORBIDDEN_PERMISSION_MODES.includes(request.permissionMode)) {
    throw new AdapterError('BAD_PERMISSION_MODE', `Permission mode ${request.permissionMode} is refused.`);
  }

  const resumeSessionId = request.resumeSessionId ?? null;
  if (resumeSessionId !== null && !UUID_PATTERN.test(resumeSessionId)) {
    throw new AdapterError('BAD_SESSION_ID', 'The session id to resume is not a UUID.');
  }
  const requestedSessionId = request.sessionId ?? null;
  if (requestedSessionId !== null && !UUID_PATTERN.test(requestedSessionId)) {
    throw new AdapterError('BAD_SESSION_ID', 'The session id for a new conversation is not a UUID.');
  }

  if (!supportsFlag(located, '-p') && !supportsFlag(located, '--print')) {
    throw new AdapterError('MISSING_REQUIRED_FLAG', 'The installed Claude Code does not support non-interactive --print.');
  }
  if (!supportsFlag(located, '--output-format') || !supportsChoice(located, '--output-format', 'stream-json')) {
    throw new AdapterError(
      'MISSING_REQUIRED_FLAG',
      'The installed Claude Code does not support --output-format stream-json, so a run cannot be streamed live.',
      'Nothing was spawned. Live output is the point of this path; falling back silently would show a frozen screen.',
    );
  }
  if (!supportsFlag(located, '--permission-mode')) {
    throw new AdapterError(
      'MISSING_REQUIRED_FLAG',
      'The installed Claude Code does not support --permission-mode, so the approval boundary cannot be set.',
      'Refused rather than run under whatever default the runtime chooses.',
    );
  }
  if (!supportsChoice(located, '--permission-mode', request.permissionMode)) {
    throw new AdapterError(
      'BAD_PERMISSION_MODE',
      `The installed Claude Code does not list ${request.permissionMode} among its permission modes.`,
    );
  }

  /**
   * Reject a caller-supplied value that could be read as a command-line option.
   *
   * `shell: false` stops shell injection — it does not stop ARGUMENT injection.
   * `--allowedTools` is variadic (`<tools...>`), so it swallows every following
   * argument until the next option. A caller passing
   *
   *     allowedTools: ['Bash', '--add-dir', 'C:\\']
   *
   * produces `--allowedTools Bash --add-dir C:\` and the CLI parses `--add-dir`
   * as its own option, handing Claude Code tool access to the whole drive. The
   * same trick reaches `--permission-mode` (downgrading the approval boundary)
   * and `--settings` (loading an apiKeyHelper, breaking the no-API-key promise).
   *
   * The prompt is already fenced behind `--`. Everything else that originates
   * outside this function has to be fenced here, because a variadic option has
   * no `--flag=value` form to hide behind.
   */
  const assertInertValue = (value: string, field: string): string => {
    if (value.length === 0) {
      throw new AdapterError('UNSAFE_ARGUMENT', `${field} may not be empty.`);
    }
    if (value.startsWith('-')) {
      throw new AdapterError(
        'UNSAFE_ARGUMENT',
        `${field} may not begin with "-": ${JSON.stringify(value.slice(0, 40))} would be parsed as a command-line option, not as a value.`,
      );
    }
    if (/[\0\r\n]/.test(value)) {
      throw new AdapterError(
        'UNSAFE_ARGUMENT',
        `${field} contains a null byte or newline, which can split an argument list.`,
      );
    }
    return value;
  };

  const argv: string[] = [supportsFlag(located, '-p') ? '-p' : '--print'];
  argv.push('--output-format', 'stream-json');

  // stream-json + --print requires --verbose on 2.1.217; without it the CLI
  // refuses the combination.
  if (supportsFlag(located, '--verbose')) argv.push('--verbose');
  else degraded.push('--verbose');

  let partialMessagesEnabled = false;
  if (supportsFlag(located, '--include-partial-messages')) {
    argv.push('--include-partial-messages');
    partialMessagesEnabled = true;
  } else {
    degraded.push('--include-partial-messages');
  }

  if (supportsFlag(located, '--add-dir')) argv.push('--add-dir', canonicalProjectPath);
  else degraded.push('--add-dir');

  argv.push('--permission-mode', request.permissionMode);

  let resumed = false;
  let newSessionId: string | null = null;
  if (resumeSessionId !== null) {
    if (!supportsFlag(located, '--resume')) {
      throw new AdapterError('MISSING_REQUIRED_FLAG', 'The installed Claude Code does not support --resume.');
    }
    argv.push('--resume', resumeSessionId);
    resumed = true;
  } else if (supportsFlag(located, '--session-id')) {
    newSessionId = requestedSessionId ?? randomUUID();
    argv.push('--session-id', newSessionId);
  } else {
    degraded.push('--session-id');
  }

  const model = request.model ?? null;
  if (model !== null && model.length > 0) {
    if (supportsFlag(located, '--model')) argv.push('--model', assertInertValue(model, 'model'));
    else degraded.push('--model');
  }

  const effort = request.effort ?? null;
  if (effort !== null && effort.length > 0) {
    // Two conditions, because `--effort` lists its levels in prose rather than
    // in a parsable `(choices: ...)` block. A level we cannot see documented is
    // withheld rather than guessed at.
    if (supportsFlag(located, '--effort') && EFFORT_LEVELS.includes(effort) && descriptionMentions(located, '--effort', effort)) {
      argv.push('--effort', effort);
    } else {
      degraded.push(`--effort ${effort}`);
    }
  }

  // Both tool lists are VARIADIC. Every element is fenced individually — one
  // unchecked entry is enough to open a second option.
  const allowed = (request.allowedTools ?? []).map((t, i) => assertInertValue(t, `allowedTools[${i}]`));
  if (allowed.length > 0) {
    if (supportsFlag(located, '--allowedTools')) argv.push('--allowedTools', ...allowed);
    else if (supportsFlag(located, '--allowed-tools')) argv.push('--allowed-tools', ...allowed);
    else degraded.push('--allowedTools');
  }
  const disallowed = (request.disallowedTools ?? []).map((t, i) =>
    assertInertValue(t, `disallowedTools[${i}]`),
  );
  if (disallowed.length > 0) {
    if (supportsFlag(located, '--disallowedTools')) argv.push('--disallowedTools', ...disallowed);
    else if (supportsFlag(located, '--disallowed-tools')) argv.push('--disallowed-tools', ...disallowed);
    else degraded.push('--disallowedTools');
  }

  // The prompt, fenced. See rule 2 in the file header — this is the line that
  // stops chat text from becoming command-line flags.
  argv.push('--', request.prompt);

  assertArgvIsSafe(argv, request.prompt);
  return { argv, degraded, partialMessagesEnabled, resumed, newSessionId };
}

/**
 * Last gate before spawn.
 *
 * Only the section BEFORE the `--` terminator is inspected: everything after it
 * is the prompt, and a prompt that happens to contain the string
 * `--dangerously-skip-permissions` is a person typing about a flag, not a flag.
 * Conflating the two would make the guard reject legitimate messages while
 * proving nothing.
 */
export function assertArgvIsSafe(argv: readonly string[], expectedPrompt: string): void {
  const terminator = argv.indexOf('--');
  const optionSection = terminator === -1 ? argv : argv.slice(0, terminator);

  for (const forbidden of FORBIDDEN_FLAGS) {
    for (const token of optionSection) {
      if (token === forbidden || token.startsWith(`${forbidden}=`)) {
        throw new AdapterError('FORBIDDEN_FLAG', `Refusing to spawn: argv contains ${forbidden}.`);
      }
    }
  }
  if (terminator === -1) {
    throw new AdapterError('FORBIDDEN_FLAG', 'Refusing to spawn: the prompt is not fenced behind a "--" terminator.');
  }
  const tail = argv.slice(terminator + 1);
  if (tail.length !== 1 || tail[0] !== expectedPrompt) {
    throw new AdapterError(
      'BAD_PROMPT',
      'Refusing to spawn: exactly one argument, the prompt, must follow the "--" terminator.',
    );
  }
}

/* ========================================================================== */
/*  Run bookkeeping                                                            */
/* ========================================================================== */

export interface RunHandle {
  readonly runId: string;
  /** Null only if the OS never assigned one, which means the spawn failed. */
  readonly pid: number | null;
  readonly startedAt: string;
  readonly argv: readonly string[];
  readonly sessionId: string | null;
  readonly stdoutRef: string;
  readonly stderrRef: string;
  readonly degraded: readonly string[];
  readonly completed: Promise<RunOutcome>;
}

export interface RunOutcome {
  readonly runId: string;
  readonly status: OperationalStatus;
  readonly statusReason: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly cancelRequested: boolean;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly sessionId: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly usage: UsageSnapshot;
  readonly counters: StreamCounters;
  readonly stdoutRef: string;
  readonly stderrRef: string;
  readonly evidenceRefs: readonly EvidenceRef[];
  /** Times the event sink threw. Recorded, never hidden. */
  readonly sinkFailures: number;
  readonly degraded: readonly string[];
}

export type StopFailure = 'UNKNOWN_RUN' | 'ALREADY_EXITED' | 'EXIT_NOT_OBSERVED' | 'NO_PID';

export type StopResult =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly forced: boolean;
      readonly exitObserved: true;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly runId: string;
      readonly reason: StopFailure;
      readonly detail: string;
    };

export interface LiveRunInfo {
  readonly runId: string;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly cancelRequested: boolean;
  /** From the child handle: it has not been reaped. */
  readonly handleAlive: boolean;
  /** From the OS: null when the platform could not answer. */
  readonly pidAlive: boolean | null;
}

interface RunEntry {
  readonly runId: string;
  readonly request: StartRunRequest;
  readonly child: ChildProcess;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly parser: ClaudeStreamParser;
  readonly runDir: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly stdoutRef: string;
  readonly stderrRef: string;
  readonly argv: readonly string[];
  readonly degraded: string[];
  readonly completed: Promise<RunOutcome>;
  stdoutFd: number | null;
  stderrFd: number | null;
  buffer: string;
  lineNumber: number;
  streamingAnnounced: boolean;
  stderrBytes: number;
  stderrEvents: number;
  /** stderr received but deliberately not released yet, so the next chunk can be redacted with it. */
  stderrCarry: string;
  /** How many secret-shaped values have been scrubbed out of this run's stderr so far. */
  stderrRedactions: number;
  sinkFailures: number;
  cancelRequested: boolean;
  cancelReason: string | null;
  timedOut: boolean;
  exited: boolean;
  timeoutTimer: ReturnType<typeof setTimer> | null;
  settle: ((outcome: RunOutcome) => void) | null;
}

/* ========================================================================== */
/*  The adapter                                                                */
/* ========================================================================== */

export class ClaudeAdapter {
  private readonly options: AdapterOptions;
  private readonly now: () => Date;
  private readonly platform: string;
  private readonly spawnChild: typeof spawn;
  private readonly runs = new Map<string, RunEntry>();

  constructor(options: AdapterOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.platform = options.platform ?? os.platform();
    this.spawnChild = options.spawnChild ?? spawn;
    ensureDir(resolve(options.evidenceDir));
  }

  /* ------------------------------------------------------------------ start */

  /**
   * Spawn a run and begin streaming immediately.
   *
   * Returns as soon as the process exists; `handle.completed` resolves when the
   * process has closed and the last line has been parsed. Output is emitted as
   * it arrives — nothing is buffered until exit, because a live view of a
   * ten-minute run is the entire reason this layer exists.
   */
  start(request: StartRunRequest): RunHandle {
    assertSafeId(request.runId, 'runId');
    assertSafeId(request.projectId, 'projectId');
    if (this.runs.has(request.runId)) {
      throw new AdapterError('DUPLICATE_RUN', `Run ${request.runId} is already registered with this adapter.`);
    }

    // THE PATH GUARD, before the path is used for anything at all.
    let canonicalProjectPath: string;
    try {
      canonicalProjectPath = assertInsideRoot(request.projectPath, this.options.trustedRoot);
    } catch (error) {
      throw new AdapterError(
        'BAD_PROJECT_PATH',
        'The project path did not pass the path guard.',
        error instanceof Error ? error.message : String(error),
      );
    }
    let cwdIsDirectory = false;
    try {
      cwdIsDirectory = statSync(canonicalProjectPath).isDirectory();
    } catch {
      cwdIsDirectory = false;
    }
    if (!cwdIsDirectory) {
      throw new AdapterError('BAD_PROJECT_PATH', `The project path is not an existing directory: ${canonicalProjectPath}`);
    }

    const built = buildClaudeArgv(this.options.located, request, canonicalProjectPath);

    const evidenceRoot = resolve(this.options.evidenceDir);
    const runDir = containedPath(evidenceRoot, join(evidenceRoot, request.runId));
    if (runDir === null) {
      throw new AdapterError('BAD_PROJECT_PATH', 'The run evidence directory escaped the configured evidence root.');
    }
    ensureDir(runDir);
    const stdoutPath = join(runDir, 'stdout.jsonl');
    const stderrPath = join(runDir, 'stderr.log');
    const stdoutRef = `${request.runId}/stdout.jsonl`;
    const stderrRef = `${request.runId}/stderr.log`;

    // The prompt is user text and may contain anything, so the argv evidence
    // file records its hash and length instead of its content.
    writeJsonAtomic(join(runDir, 'argv.json'), {
      runId: request.runId,
      executable: this.options.located.executablePath,
      claudeVersion: this.options.located.version,
      argv: built.argv.slice(0, built.argv.indexOf('--') + 1),
      promptSha256: sha256(request.prompt),
      promptChars: request.prompt.length,
      cwd: canonicalProjectPath,
      permissionMode: request.permissionMode,
      requestedModel: request.model ?? null,
      requestedEffort: request.effort ?? null,
      degradedFlags: built.degraded,
      startedAt: this.now().toISOString(),
    });

    const startedAt = this.now();
    const parser = new ClaudeStreamParser({
      projectId: request.projectId,
      runId: request.runId,
      conversationId: request.conversationId,
      taskId: request.taskId ?? null,
      agentId: request.agentId ?? null,
      partialMessagesEnabled: built.partialMessagesEnabled,
      resumed: built.resumed,
      stdoutRef,
      includeToolResultExcerpt: request.includeToolResultExcerpt === true,
      now: this.now,
    });

    let settle: ((outcome: RunOutcome) => void) | null = null;
    const completed = new Promise<RunOutcome>((res) => {
      settle = res;
    });

    this.emitDraft(
      this.draft(request, 'run.state', 'STARTING', {
        phase: 'spawning',
        executable: this.options.located.executablePath,
        claudeVersion: this.options.located.version,
        permissionMode: request.permissionMode,
        // Requested, not reported. The runtime never echoes these back, so they
        // are recorded here where they are plainly a request.
        requestedModel: request.model ?? null,
        requestedEffort: request.effort ?? null,
        degradedFlags: built.degraded,
        partialMessagesEnabled: built.partialMessagesEnabled,
        resumed: built.resumed,
      }, [{ kind: 'file', ref: `${request.runId}/argv.json`, note: 'the argv that was assembled, with the prompt hashed' }]),
    );

    const child = this.spawnChild(this.options.located.executablePath, [...built.argv], {
      cwd: canonicalProjectPath,
      shell: false,
      windowsHide: true,
      // A process group on POSIX, so cancellation can signal the whole tree.
      // Never on win32, where it would open a console window instead.
      detached: this.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const entry: RunEntry = {
      runId: request.runId,
      request,
      child,
      pid: child.pid ?? null,
      startedAt: startedAt.toISOString(),
      startedAtMs: startedAt.getTime(),
      parser,
      runDir,
      stdoutPath,
      stderrPath,
      stdoutRef,
      stderrRef,
      argv: built.argv,
      degraded: [...built.degraded],
      completed,
      stdoutFd: null,
      stderrFd: null,
      buffer: '',
      lineNumber: 0,
      streamingAnnounced: false,
      stderrBytes: 0,
      stderrEvents: 0,
      stderrCarry: '',
      stderrRedactions: 0,
      sinkFailures: 0,
      cancelRequested: false,
      cancelReason: null,
      timedOut: false,
      exited: false,
      timeoutTimer: null,
      settle,
    };
    try {
      entry.stdoutFd = openSync(stdoutPath, 'a');
      entry.stderrFd = openSync(stderrPath, 'a');
    } catch (error) {
      entry.degraded.push(`evidence-files-unavailable: ${safeExcerpt(error instanceof Error ? error.message : String(error), 200)}`);
    }
    this.runs.set(request.runId, entry);

    if (entry.pid !== null) {
      this.emitDraft(
        this.draft(request, 'run.state', 'RUNNING', { phase: 'spawned', pid: entry.pid }, [
          { kind: 'event', ref: `process.pid=${String(entry.pid)}`, note: 'the OS assigned a pid to the spawned child' },
        ]),
      );
    }

    this.wire(entry);

    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      entry.timeoutTimer = setTimer(() => {
        entry.timedOut = true;
        void this.stop(request.runId, { reason: `wall-clock timeout after ${String(request.timeoutMs)} ms` });
      }, request.timeoutMs);
      entry.timeoutTimer.unref();
    }

    return {
      runId: request.runId,
      pid: entry.pid,
      startedAt: entry.startedAt,
      argv: built.argv,
      sessionId: built.newSessionId ?? request.resumeSessionId ?? null,
      stdoutRef,
      stderrRef,
      degraded: entry.degraded,
      completed,
    };
  }

  /* ----------------------------------------------------------- stream wiring */

  private wire(entry: RunEntry): void {
    const { child } = entry;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const arrivedAt = Date.now();
      entry.buffer += chunk;

      const maxLine = this.options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
      if (entry.buffer.length > maxLine && !entry.buffer.includes('\n')) {
        // A single line larger than the cap. Dropping it silently is exactly
        // what the honesty rule forbids, so it is dropped LOUDLY.
        this.emitDraft(
          this.degradedDraft(entry, 'claude.stream.line-too-long', {
            lineNumber: entry.lineNumber + 1,
            byteLength: Buffer.byteLength(entry.buffer, 'utf8'),
            detail: `a single stream line exceeded ${String(maxLine)} characters and was discarded`,
            // NOT pre-sliced: safeExcerpt redacts before it caps, so cutting here first would hand it
            // half a secret. Half a JWT matches no pattern and goes out verbatim (proven by a witness
            // on 2026-08-01; see tests/unit/excerpt-redaction-order.test.ts). The buffer is bounded by
            // maxLine plus one chunk, so redacting all of it is cheap.
            rawExcerpt: safeExcerpt(entry.buffer, 500),
          }),
        );
        entry.buffer = '';
        return;
      }

      const { lines, rest } = splitLines(entry.buffer);
      entry.buffer = rest;
      for (const line of lines) {
        this.consumeLine(entry, line, arrivedAt);
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.consumeStderr(entry, chunk);
    });

    child.on('error', (error: Error) => {
      this.emitDraft(
        this.draft(entry.request, 'run.error', undefined, {
          phase: 'spawn',
          message: redactSecrets(error.message),
        }),
      );
      // `error` after a failed spawn is not always followed by `close`, so the
      // run is finalised here; `finalise` is idempotent.
      this.finalise(entry, { spawnFailed: true, message: redactSecrets(error.message) });
    });

    child.on('close', (code: number | null, signal: string | null) => {
      this.finalise(entry, { exitCode: code, signal: signal === null ? null : String(signal) });
    });
  }

  private consumeLine(entry: RunEntry, line: string, arrivedAtMs: number): void {
    if (line.trim().length === 0) return;
    entry.lineNumber += 1;
    this.appendEvidence(entry, 'stdout', `${line}\n`);

    let drafts: readonly ForgeEventDraft[];
    try {
      drafts = entry.parser.pushLine(line, entry.lineNumber);
    } catch (error) {
      // The parser is written not to throw. If it ever does, that is a bug in
      // the bridge and it is recorded as one rather than killing the stream.
      this.emitDraft(
        this.degradedDraft(entry, 'claude.stream.unparsable-line', {
          lineNumber: entry.lineNumber,
          byteLength: Buffer.byteLength(line, 'utf8'),
          detail: `the stream parser threw: ${safeExcerpt(error instanceof Error ? error.message : String(error), 200)}`,
          rawExcerpt: safeExcerpt(line, 500),
        }),
      );
      return;
    }

    entry.parser.recordLatencySample(Date.now() - arrivedAtMs);

    if (!entry.streamingAnnounced) {
      entry.streamingAnnounced = true;
      this.emitDraft(
        this.draft(entry.request, 'run.state', 'STREAMING', { phase: 'first-line-parsed' }, [
          { kind: 'stdout', ref: `${entry.stdoutRef}#L${String(entry.lineNumber)}`, note: 'first stream-json line that parsed' },
        ]),
      );
    }

    for (const draft of drafts) this.emitDraft(draft);
  }

  /**
   * Take one stderr chunk and decide how much of it may be released.
   *
   * A CHUNK IS NOT A UNIT OF MEANING. The OS decides where a read splits, not the writer. Redacting
   * each chunk on its own therefore misses any credential that lands on the seam: neither half is a
   * complete token, neither half matches a pattern, and both halves go out verbatim — reassembling
   * the event stream (or reading the evidence file) hands the reader the whole secret back. Found on
   * 2026-08-02; pinned by tests/unit/stderr-chunk-boundary-redaction.test.ts.
   *
   * This is NOT the cap-before-redact defect fixed on 2026-08-01 (see the comment on `rawExcerpt` in
   * `wire`, and tests/unit/excerpt-redaction-order.test.ts). That one was a single value being
   * sliced before it was scrubbed. This one is two separate calls that never see the whole token, so
   * no amount of care inside `safeExcerpt` can help; the fix has to be a hand-over buffer.
   *
   * So: text is released only once a newline has arrived after it. Every pattern in `redactSecrets`
   * matches within one log line, so a line boundary is a place where a secret cannot be straddling
   * the split. The unterminated tail is carried into the next chunk and redacted together with it.
   * Nothing is released twice — the carry is CONSUMED when it is released, not copied.
   */
  private consumeStderr(entry: RunEntry, chunk: string): void {
    if (chunk.length === 0) return;
    entry.stderrCarry += chunk;

    const lastNewline = entry.stderrCarry.lastIndexOf('\n');
    if (lastNewline >= 0) {
      const ready = entry.stderrCarry.slice(0, lastNewline + 1);
      entry.stderrCarry = entry.stderrCarry.slice(lastNewline + 1);
      this.releaseStderr(entry, ready);
    }

    // A newline may never come. Releasing an over-long tail keeps the live view live and the buffer
    // bounded; the kept window is what stops the forced split from becoming the very leak this
    // method exists to prevent.
    if (entry.stderrCarry.length > STDERR_CARRY_FORCE_FLUSH_CHARS) {
      const releaseUpTo = entry.stderrCarry.length - STDERR_CARRY_KEEP_CHARS;
      const ready = entry.stderrCarry.slice(0, releaseUpTo);
      entry.stderrCarry = entry.stderrCarry.slice(releaseUpTo);
      this.releaseStderr(entry, ready);
    }
  }

  /**
   * The process is gone: whatever is still held back is released now or never.
   *
   * Two real cases end here — a final line the process never terminated with a newline, and a run
   * that dies with a partly-written line in flight. Holding a credential back forever would be safe
   * but dishonest: the diagnostic would silently vanish from the evidence file.
   */
  private flushStderr(entry: RunEntry): void {
    if (entry.stderrCarry.length === 0) return;
    const remaining = entry.stderrCarry;
    entry.stderrCarry = '';
    this.releaseStderr(entry, remaining);
  }

  /**
   * Write one released stderr segment to the evidence file and emit it as an event.
   *
   * WHY THE EVIDENCE FILE IS REDACTED TOO (changed 2026-08-02). This used to append the RAW chunk,
   * with the comment "the full capture is in the evidence file" — deliberate, and forensically the
   * right instinct, but it meant a live API token from a failing auth call sat in plain text in
   * `<runDir>/stderr.log` for as long as that run's evidence is kept. Nobody chose to store a
   * credential at rest; it arrived as a side effect of capturing diagnostics.
   *
   * The trade-off was weighed rather than assumed. Dropping the capture entirely would gut the only
   * record of why a run failed. Encrypting it would move the problem to a key. Writing raw and
   * "trusting the directory" is what we were already doing, and it is the thing that failed. So the
   * segment is redacted BEFORE it is written, and the redaction is deliberately in-place: the
   * `[REDACTED:jwt]` marker keeps the POSITION and the KIND of what was there, so an investigator
   * reading the log still sees that the process printed a JWT at exactly this point in exactly this
   * message. What is lost is the one thing we did not want on disk — the value itself. The count is
   * carried on the event as `redactions` so the loss is visible from the outside too, not silent.
   *
   * The file gets `redactSecrets` only, not `safeExcerpt`: control characters and length are part of
   * a raw log's fidelity and are left alone. Only the event excerpt is escaped and capped.
   */
  private releaseStderr(entry: RunEntry, segment: string): void {
    if (segment.length === 0) return;

    const maxBytes = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    const maxEvents = this.options.maxStderrEvents ?? DEFAULT_MAX_STDERR_EVENTS;
    const arrivedBytes = Buffer.byteLength(segment, 'utf8');
    const { text: scrubbed, redactions } = redactAndCount(segment);
    entry.stderrRedactions += redactions;

    if (entry.stderrBytes < maxBytes) {
      this.appendEvidence(entry, 'stderr', scrubbed);
      // Counts what was actually stored, which is what `stderr.log` now holds.
      entry.stderrBytes += Buffer.byteLength(scrubbed, 'utf8');
      if (entry.stderrBytes >= maxBytes) {
        this.appendEvidence(entry, 'stderr', `\n[forge] stderr capture stopped at ${String(maxBytes)} bytes\n`);
      }
    }

    if (entry.stderrEvents < maxEvents) {
      entry.stderrEvents += 1;
      this.emitDraft(
        this.draft(entry.request, 'claude.stderr', undefined, {
          bytes: arrivedBytes,
          // Already scrubbed; safeExcerpt escapes control characters and applies the cap. It redacts
          // again on the way through, which is a no-op on clean text and cheap insurance.
          excerpt: safeExcerpt(scrubbed, 1000),
          redactions,
          truncatedEventStream: false,
        }, [{ kind: 'stderr', ref: entry.stderrRef }]),
      );
    } else if (entry.stderrEvents === maxEvents) {
      entry.stderrEvents += 1;
      this.emitDraft(
        this.draft(entry.request, 'claude.stderr', undefined, {
          bytes: 0,
          excerpt: `[forge] further stderr is being written to the evidence file but is no longer emitted as events (cap ${String(maxEvents)})`,
          redactions: 0,
          truncatedEventStream: true,
        }, [{ kind: 'stderr', ref: entry.stderrRef }]),
      );
    }
  }

  /* --------------------------------------------------------------- finalise */

  private finalise(
    entry: RunEntry,
    result: { readonly exitCode?: number | null; readonly signal?: string | null; readonly spawnFailed?: boolean; readonly message?: string },
  ): void {
    if (entry.exited) return;
    entry.exited = true;

    if (entry.timeoutTimer !== null) {
      clearTimer(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }

    // Anything left in the buffer is a final line the process never terminated.
    if (entry.buffer.trim().length > 0) {
      this.consumeLine(entry, entry.buffer, Date.now());
      entry.buffer = '';
    }
    // Same for stderr: the hand-over buffer holds back everything after the last newline, so a run
    // that ends mid-line has one segment that has been redacted but not yet released. It must go out
    // before the evidence file is closed, or it is lost.
    this.flushStderr(entry);

    const endedAt = this.now();
    const durationMs = endedAt.getTime() - entry.startedAtMs;
    const exitCode = result.exitCode ?? null;
    const signal = result.signal ?? null;
    const counters = entry.parser.counters();
    const usage = entry.parser.finalSnapshot({ elapsedMsFallback: durationMs });

    const evidenceRefs: EvidenceRef[] = [
      { kind: 'stdout', ref: entry.stdoutRef, note: `${String(entry.lineNumber)} stream-json lines captured` },
      {
        kind: 'stderr',
        ref: entry.stderrRef,
        // The redaction tally is part of the evidence, not a footnote: a reader of stderr.log is
        // entitled to know the file is a scrubbed copy and how much was scrubbed out of it.
        note:
          entry.stderrRedactions === 0
            ? `${String(entry.stderrBytes)} bytes captured`
            : `${String(entry.stderrBytes)} bytes captured, ${String(entry.stderrRedactions)} secret-shaped values redacted`,
      },
      { kind: 'exit-code', ref: String(exitCode), note: signal === null ? 'process exit code' : `terminated by ${signal}` },
    ];

    const { status, statusReason } = this.decideTerminalStatus(entry, exitCode, signal, result);

    this.closeEvidence(entry);
    writeJsonAtomic(join(entry.runDir, 'exit.json'), {
      runId: entry.runId,
      pid: entry.pid,
      startedAt: entry.startedAt,
      endedAt: endedAt.toISOString(),
      durationMs,
      exitCode,
      signal,
      cancelRequested: entry.cancelRequested,
      cancelReason: entry.cancelReason,
      timedOut: entry.timedOut,
      spawnFailed: result.spawnFailed === true,
      sawResultEnvelope: entry.parser.sawResult,
      resultWasError: entry.parser.resultWasError,
      status,
      statusReason,
      lines: entry.lineNumber,
      counters,
    });

    if (entry.cancelRequested) {
      // CANCELLED is persisted here and nowhere else — this is the first point
      // at which the exit has actually been observed.
      writeJsonAtomic(join(entry.runDir, 'cancelled.json'), {
        state: 'CANCELLED',
        runId: entry.runId,
        observedExitAt: endedAt.toISOString(),
        exitCode,
        signal,
        reason: entry.cancelReason,
      });
      this.emitDraft(
        this.draft(entry.request, 'run.cancelled', 'CANCELLED', {
          reason: entry.cancelReason,
          exitCode,
          signal,
        }, evidenceRefs),
      );
    }

    const sessionId = entry.parser.claudeSessionId;
    if (sessionId !== null) {
      this.emitDraft(this.draft(entry.request, 'session.ended', undefined, { sessionId, exitCode }, evidenceRefs));
    }

    this.emitDraft(
      this.draft(entry.request, 'claude.usage', undefined, { snapshot: usage, final: true }, [
        { kind: 'stdout', ref: entry.stdoutRef, note: 'usage assembled from the captured stream' },
      ]),
    );

    // The adapter reports that the PROCESS ended, and the outcome it observed —
    // but it does NOT stamp a top-level operational status here. COMPLETED in
    // particular is EARNED: only the run service may claim it, and only after
    // VERIFYING and REVIEWING. Emitting `status: 'COMPLETED'` at process exit let
    // a client see COMPLETED before verification had run, then watch it go back
    // to VERIFYING. The process facts live in the payload (`processOutcome`); the
    // operational status now moves only with the run service's gated transitions.
    this.emitDraft(
      this.draft(entry.request, 'run.state', undefined, {
        processOutcome: status,
        statusReason,
        exitCode,
        signal,
        durationMs,
        sawResultEnvelope: entry.parser.sawResult,
        counters,
        degradedFlags: entry.degraded,
        sinkFailures: entry.sinkFailures,
      }, evidenceRefs),
    );

    const outcome: RunOutcome = {
      runId: entry.runId,
      status,
      statusReason,
      exitCode,
      signal,
      cancelRequested: entry.cancelRequested,
      cancelled: status === 'CANCELLED',
      timedOut: entry.timedOut,
      sessionId,
      startedAt: entry.startedAt,
      endedAt: endedAt.toISOString(),
      durationMs,
      usage,
      counters,
      stdoutRef: entry.stdoutRef,
      stderrRef: entry.stderrRef,
      evidenceRefs,
      sinkFailures: entry.sinkFailures,
      degraded: entry.degraded,
    };

    const settle = entry.settle;
    entry.settle = null;
    this.runs.delete(entry.runId);
    if (settle !== null) settle(outcome);
  }

  /**
   * Decide the terminal status.
   *
   * The order matters. Cancellation wins because it explains the exit code;
   * after that, COMPLETED requires two independent facts — a zero exit AND a
   * result envelope that did not report an error. A zero exit on its own is
   * INTERRUPTED, because the stream ended before the runtime said it was
   * finished and we have no evidence of what happened in between.
   */
  private decideTerminalStatus(
    entry: RunEntry,
    exitCode: number | null,
    signal: string | null,
    result: { readonly spawnFailed?: boolean; readonly message?: string },
  ): { readonly status: OperationalStatus; readonly statusReason: string } {
    if (result.spawnFailed === true) {
      return { status: 'FAILED', statusReason: `the process could not be started: ${result.message ?? 'unknown error'}` };
    }
    if (entry.cancelRequested) {
      return {
        status: 'CANCELLED',
        statusReason: `cancellation was requested (${entry.cancelReason ?? 'no reason given'}) and the exit was observed: code ${String(exitCode)}${
          signal === null ? '' : `, signal ${signal}`
        }`,
      };
    }
    if (entry.timedOut) {
      return { status: 'FAILED', statusReason: 'the run exceeded its wall-clock ceiling and was terminated' };
    }
    if (exitCode === 0 && entry.parser.sawResult && entry.parser.resultWasError !== true) {
      return {
        status: 'COMPLETED',
        statusReason: 'exit code 0 and a result envelope with is_error false were both observed',
      };
    }
    if (exitCode === 0 && entry.parser.sawResult && entry.parser.resultWasError === true) {
      return { status: 'FAILED', statusReason: 'the runtime returned a result envelope reporting is_error true' };
    }
    if (exitCode === 0) {
      return {
        status: 'INTERRUPTED',
        statusReason:
          'the process exited 0 but no result envelope arrived, so there is no evidence the turn finished; not reported as completed',
      };
    }
    return {
      status: 'FAILED',
      statusReason: `the process exited ${String(exitCode)}${signal === null ? '' : ` after signal ${signal}`}`,
    };
  }

  /* -------------------------------------------------------------------- stop */

  /**
   * Cancel one run.
   *
   * Sequence, and every step of it is observable afterwards: persist the
   * request, ask politely, wait, force-kill the tree, wait again, and persist
   * CANCELLED only if the exit is actually seen. If it is not seen, the run
   * keeps claiming STOPPING and the failure to confirm is recorded — a kill we
   * issued is not a process we know is dead.
   */
  async stop(
    runId: string,
    options: { readonly reason?: string; readonly graceMs?: number; readonly forceWaitMs?: number } = {},
  ): Promise<StopResult> {
    const entry = this.runs.get(runId);
    if (entry === undefined) {
      return { ok: false, runId, reason: 'UNKNOWN_RUN', detail: 'This adapter has no live registration for that run id.' };
    }
    if (entry.exited) {
      return { ok: false, runId, reason: 'ALREADY_EXITED', detail: 'The process had already exited when cancel was requested.' };
    }
    if (entry.pid === null) {
      return { ok: false, runId, reason: 'NO_PID', detail: 'No pid was ever assigned, so there is no process tree to terminate.' };
    }

    const reason = options.reason ?? 'cancelled by request';
    if (!entry.cancelRequested) {
      entry.cancelRequested = true;
      entry.cancelReason = reason;
      writeJsonAtomic(join(entry.runDir, 'cancel-requested.json'), {
        state: 'CANCEL_REQUESTED',
        runId,
        pid: entry.pid,
        requestedAt: this.now().toISOString(),
        reason,
      });
      this.emitDraft(
        this.draft(entry.request, 'run.cancel.requested', 'STOPPING', { reason, pid: entry.pid }, [
          { kind: 'file', ref: `${runId}/cancel-requested.json`, note: 'the persisted cancellation request' },
        ]),
      );
      this.emitDraft(this.draft(entry.request, 'run.state', 'STOPPING', { reason, phase: 'graceful-termination-requested' }));
    }

    const graceMs = options.graceMs ?? this.options.graceMs ?? DEFAULT_GRACE_MS;
    const forceWaitMs = options.forceWaitMs ?? this.options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS;

    const graceful = await this.terminateTree(entry, false);
    if (await this.waitForExit(entry, graceMs)) {
      return { ok: true, runId, forced: false, exitObserved: true, detail: `graceful termination succeeded (${graceful})` };
    }

    const forced = await this.terminateTree(entry, true);
    if (await this.waitForExit(entry, forceWaitMs)) {
      return { ok: true, runId, forced: true, exitObserved: true, detail: `the process tree was force-killed (${forced})` };
    }

    this.emitDraft(
      this.degradedDraft(entry, 'claude.stream.unparsable-line', {
        lineNumber: entry.lineNumber,
        byteLength: 0,
        detail:
          `cancellation was requested and the process tree for pid ${String(entry.pid)} was force-killed, ` +
          'but no exit was observed within the timeout; the run remains STOPPING and is NOT reported as cancelled',
        rawExcerpt: '',
      }),
    );
    return {
      ok: false,
      runId,
      reason: 'EXIT_NOT_OBSERVED',
      detail: `the kill was issued (${forced}) but the process did not exit within ${String(graceMs + forceWaitMs)} ms`,
    };
  }

  /** Cancel everything this adapter owns. Used on bridge shutdown. */
  async stopAll(reason = 'bridge shutdown'): Promise<readonly StopResult[]> {
    const ids = [...this.runs.keys()];
    const results: StopResult[] = [];
    for (const id of ids) results.push(await this.stop(id, { reason }));
    return results;
  }

  /**
   * Terminate the tree of THIS run's pid, and only that tree.
   *
   * The pid comes from our own registry. The kill is issued only while our
   * `ChildProcess` handle still reports the child as unreaped, which is what
   * makes pid reuse impossible in the gap between the check and the kill: on
   * Windows the open process handle keeps the OS process object (and therefore
   * the pid) reserved, and on POSIX the pid is reserved until Node reaps it.
   */
  private async terminateTree(entry: RunEntry, force: boolean): Promise<string> {
    const pid = entry.pid;
    if (pid === null) return 'no pid';
    if (entry.exited || entry.child.exitCode !== null || entry.child.signalCode !== null) {
      return 'the child had already been reaped; no signal was sent';
    }
    if (entry.child.pid !== pid) {
      return `refused: the child handle reports pid ${String(entry.child.pid)} but the registry holds ${String(pid)}`;
    }

    if (this.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? null;
      // An absolute path so a hostile PATH entry cannot supply the killer.
      const taskkill = systemRoot === null ? 'taskkill.exe' : join(systemRoot, 'System32', 'taskkill.exe');
      const argv = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
      const result = await this.runTaskkill(taskkill, argv);
      return `taskkill ${argv.join(' ')} → exit ${String(result)}`;
    }

    const signal: 'SIGKILL' | 'SIGTERM' = force ? 'SIGKILL' : 'SIGTERM';
    try {
      // Negative pid = the process group, which `detached: true` gave the child.
      process.kill(-pid, signal);
      return `${signal} sent to process group ${String(pid)}`;
    } catch {
      try {
        entry.child.kill(signal);
        return `${signal} sent to pid ${String(pid)} (the process group was unavailable)`;
      } catch (error) {
        return `no signal could be delivered: ${safeExcerpt(error instanceof Error ? error.message : String(error), 120)}`;
      }
    }
  }

  private runTaskkill(executable: string, argv: readonly string[]): Promise<number | null> {
    return new Promise<number | null>((settle) => {
      let done = false;
      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        clearTimer(timer);
        settle(code);
      };
      const killer = spawn(executable, [...argv], { shell: false, windowsHide: true, stdio: 'ignore' });
      const timer = setTimer(() => finish(null), TASKKILL_TIMEOUT_MS);
      timer.unref();
      killer.on('error', () => finish(null));
      killer.on('close', (code: number | null) => finish(code));
    });
  }

  /** Resolves true only when the run's own `close` handler has run. */
  private waitForExit(entry: RunEntry, ms: number): Promise<boolean> {
    if (entry.exited) return Promise.resolve(true);
    return new Promise<boolean>((settle) => {
      let done = false;
      const timer = setTimer(() => {
        if (done) return;
        done = true;
        settle(entry.exited);
      }, ms);
      timer.unref();
      void entry.completed.then(() => {
        if (done) return;
        done = true;
        clearTimer(timer);
        settle(true);
      });
    });
  }

  /* ------------------------------------------------------- reconciliation */

  /**
   * What this adapter believes is live, with the belief separated from the
   * evidence for it. `handleAlive` is what our own bookkeeping says;
   * `pidAlive` is what the OS says, and is null when the platform would not
   * answer. Reconciliation needs both to tell a live run from an orphan.
   */
  liveRuns(): readonly LiveRunInfo[] {
    return [...this.runs.values()].map((entry) => ({
      runId: entry.runId,
      pid: entry.pid,
      startedAt: entry.startedAt,
      cancelRequested: entry.cancelRequested,
      handleAlive: !entry.exited && entry.child.exitCode === null && entry.child.signalCode === null,
      pidAlive: entry.pid === null ? null : isPidAlive(entry.pid),
    }));
  }

  /** Pid registered for a run, or null. The reconciler's lookup key. */
  pidFor(runId: string): number | null {
    return this.runs.get(runId)?.pid ?? null;
  }

  activeRunIds(): readonly string[] {
    return [...this.runs.keys()];
  }

  /* ---------------------------------------------------------------- helpers */

  private draft(
    request: StartRunRequest,
    type: EventType,
    status: OperationalStatus | undefined,
    payload: unknown,
    evidenceRefs: readonly EvidenceRef[] = [],
  ): ForgeEventDraft {
    return {
      timestamp: this.now().toISOString(),
      projectId: request.projectId,
      runId: request.runId,
      sessionId: this.runs.get(request.runId)?.parser.claudeSessionId ?? null,
      conversationId: request.conversationId,
      taskId: request.taskId ?? null,
      agentId: request.agentId ?? null,
      source: 'bridge',
      type,
      ...(status === undefined ? {} : { status }),
      payload,
      evidenceRefs,
    };
  }

  private degradedDraft(entry: RunEntry, reason: string, payload: Record<string, unknown>): ForgeEventDraft {
    return {
      ...this.draft(entry.request, 'bridge.degraded', 'DEGRADED', { reason, ...payload }, [
        { kind: 'stdout', ref: entry.stdoutRef },
      ]),
    };
  }

  /**
   * Hand an event to the sink.
   *
   * A sink that throws must not kill the stream reader — the remaining output
   * is still worth capturing — but the failure is counted and surfaced on the
   * outcome, because events that never reached the log are a hole in the
   * history and the client is entitled to know there is one.
   *
   * One honest gap: the very first `run.state STARTING` event is emitted before
   * the run is registered, so a sink failure on that one event has no entry to
   * be counted against. Every event after it does.
   */
  private emitDraft(draft: ForgeEventDraft): void {
    try {
      this.options.emit(draft);
    } catch (error) {
      const entry = draft.runId === null ? undefined : this.runs.get(draft.runId);
      if (entry !== undefined) {
        entry.sinkFailures += 1;
        this.appendEvidence(
          entry,
          'stderr',
          `\n[forge] event sink threw for ${draft.type}: ${safeExcerpt(error instanceof Error ? error.message : String(error), 200)}\n`,
        );
      }
    }
  }

  private appendEvidence(entry: RunEntry, which: 'stdout' | 'stderr', text: string): void {
    if (text.length === 0) return;
    const fd = which === 'stdout' ? entry.stdoutFd : entry.stderrFd;
    if (fd === null) return;
    try {
      writeSync(fd, text);
    } catch {
      // The evidence file became unwritable mid-run. Recorded once, then the
      // handle is dropped so the run is not spammed with failures.
      if (which === 'stdout') entry.stdoutFd = null;
      else entry.stderrFd = null;
      entry.degraded.push(`${which}-evidence-write-failed`);
    }
  }

  private closeEvidence(entry: RunEntry): void {
    for (const which of ['stdout', 'stderr'] as const) {
      const fd = which === 'stdout' ? entry.stdoutFd : entry.stderrFd;
      if (fd === null) continue;
      try {
        fsyncSync(fd);
      } catch {
        entry.degraded.push(`${which}-evidence-fsync-failed`);
      }
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      if (which === 'stdout') entry.stdoutFd = null;
      else entry.stderrFd = null;
    }
  }
}
