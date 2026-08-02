/**
 * Forge Workspace — finding the Claude Code executable and learning what it can do.
 *
 * Everything downstream of this file gates on what it discovers. That is the
 * whole design: the adapter does not "know" which flags exist, it asks. A flag
 * that is not in the probed set is never passed, so an installed CLI that is
 * older, newer or simply different degrades instead of failing with an
 * unrecognised-argument error the user cannot act on.
 *
 * THE FLAG THAT PROVES THE POINT. `--max-turns` does not exist in 2.1.217. It
 * appears in plenty of documentation and in a lot of adapter code written from
 * memory. `--help` on this machine confirms its absence, and `FORBIDDEN_FLAGS`
 * below refuses it explicitly so that a future edit cannot reintroduce it by
 * accident — a probe that merely omitted it would let a hardcoded argv slip
 * past.
 *
 * WHAT "AUTHENTICATED" MEANS HERE. `ClaudeCodeStatus.authenticated` is a
 * boolean, and a boolean has no room for "we could not tell". So this module
 * sets it true ONLY when a real `-p` call returned exit code 0 and a result
 * envelope with `is_error: false` and a session id. Every other outcome —
 * timeout, spawn failure, non-zero exit, unparsable output — yields false plus
 * a `note` that says which of those happened. False therefore means "not
 * proven", never "proven not", and the note is what stops the UI from turning
 * an unproven check into an accusation.
 *
 * SECRET HYGIENE. Nothing here returns stdout or stderr text by default. The
 * probe's `apiKeySource` field is the NAME of a credential source ("none" on
 * this machine) and never a credential. A redacted excerpt is available only
 * behind an explicit opt-in, because an excerpt is a best-effort denylist and
 * default-on best-effort is how secrets escape.
 *
 * The relative `.ts` imports are deliberate: Node 24 executes TypeScript
 * directly and requires the explicit extension, and bridge code is permitted
 * relative imports.
 */

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve, dirname } from 'node:path';
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers';
import os from 'node:os';
import process from 'node:process';

import type { ClaudeCodeStatus } from '../../shared/protocol.ts';
import { redactSecrets, safeExcerpt } from './parse.ts';

/* ========================================================================== */
/*  Constants                                                                  */
/* ========================================================================== */

/**
 * Flags this bridge will never pass, whatever a probe says about them.
 *
 * `--max-turns` is here because it does not exist in 2.1.217 and passing it
 * would abort the run. The three permission-bypass flags are here because they
 * disable the approval boundary the whole system is built around; they are
 * refused even on a CLI that supports them.
 */
export const FORBIDDEN_FLAGS: readonly string[] = [
  '--max-turns',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
];

/** Permission modes the bridge refuses to run under, however configured. */
export const FORBIDDEN_PERMISSION_MODES: readonly string[] = ['bypassPermissions'];

/** Effort levels 2.1.217 lists in prose on the `--effort` option. */
export const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const WINDOWS_EXECUTABLE_NAMES: readonly string[] = ['claude.exe', 'claude.cmd', 'claude.bat'];
const POSIX_EXECUTABLE_NAMES: readonly string[] = ['claude'];

const DEFAULT_VERSION_TIMEOUT_MS = 15_000;
const DEFAULT_HELP_TIMEOUT_MS = 20_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;

/** Cap on captured child output so a runaway process cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/* ========================================================================== */
/*  Running a child and capturing it                                           */
/* ========================================================================== */

export interface CaptureResult {
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  readonly durationMs: number;
}

/**
 * Run a short-lived child and capture it.
 *
 * `shell: false` and an argv ARRAY, always. A shell would reinterpret quoting,
 * `&`, `|` and `%VAR%` in anything that reached it, which turns every argument
 * into a potential command. There is no code path in this bridge that builds a
 * command string.
 */
export function capture(
  executable: string,
  argv: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<CaptureResult>((settle) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;

    const child = spawn(executable, [...argv], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimer(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* the process is already gone; nothing to do */
      }
    }, timeoutMs);
    // Do not hold the event loop open for a probe.
    timer.unref();

    const finish = (spawnError: string | null): void => {
      if (done) return;
      done = true;
      clearTimer(timer);
      settle({
        argv: [...argv],
        exitCode: child.exitCode,
        signal: child.signalCode,
        stdout,
        stderr,
        timedOut,
        spawnError,
        durationMs: Date.now() - startedAt,
      });
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk;
    });

    child.on('error', (error: Error) => finish(error.message));
    child.on('close', () => finish(null));
  });
}

/* ========================================================================== */
/*  Version strings                                                            */
/* ========================================================================== */

export interface ParsedVersion {
  readonly raw: string;
  readonly normalised: string | null;
  readonly parts: readonly number[];
}

/** `2.1.217 (Claude Code)` → `2.1.217`. Anything unrecognised stays raw. */
export function parseVersion(raw: string): ParsedVersion {
  const trimmed = raw.trim();
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (match === null) return { raw: trimmed, normalised: null, parts: [] };
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { raw: trimmed, normalised: parts.join('.'), parts };
}

/** Numeric, component-wise. `2.1.217` sorts above `2.1.99`, which a string sort does not. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

/* ========================================================================== */
/*  Candidate discovery                                                        */
/* ========================================================================== */

export type CandidateSource = 'env-override' | 'appdata-version-dir' | 'path-entry';

export interface ExecutableCandidate {
  readonly path: string;
  readonly source: CandidateSource;
  /** Version read from the containing directory name, when there was one. */
  readonly directoryVersion: ParsedVersion | null;
  readonly isFile: boolean;
}

export interface LocateOptions {
  /** TEST-ONLY seam. Overrides `%APPDATA%`. */
  readonly appDataDir?: string;
  /** TEST-ONLY seam. Overrides the PATH entries that are searched. */
  readonly pathEntries?: readonly string[];
  /** TEST-ONLY seam. Forces win32 vs posix naming. */
  readonly platform?: string;
  /** Explicit executable. Overrides discovery. Read from FORGE_CLAUDE_PATH otherwise. */
  readonly executablePath?: string;
  readonly versionTimeoutMs?: number;
  readonly helpTimeoutMs?: number;
}

function isFilePath(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function directoryEntries(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Every place the executable might be, newest first.
 *
 * Two sources, in priority order:
 *
 *  1. `<APPDATA>/Claude/claude-code/<version>/claude.exe` — the native install
 *     layout on this machine. Version directories are sorted NUMERICALLY and
 *     descending, so `2.1.217` beats `2.1.99`, which a lexicographic sort gets
 *     backwards.
 *  2. Each PATH entry. Kept because a user may have the CLI installed some other
 *     way entirely, and because refusing to look there would be us deciding we
 *     know their machine better than they do.
 *
 * `%APPDATA%` is read at run time. Nothing about a user directory is hardcoded.
 */
export function discoverCandidates(options: LocateOptions = {}): readonly ExecutableCandidate[] {
  const win32 = (options.platform ?? os.platform()) === 'win32';
  const names = win32 ? WINDOWS_EXECUTABLE_NAMES : POSIX_EXECUTABLE_NAMES;
  const found: ExecutableCandidate[] = [];
  const seen = new Set<string>();

  const add = (candidate: ExecutableCandidate): void => {
    const key = win32 ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(candidate);
  };

  const explicit = options.executablePath ?? process.env.FORGE_CLAUDE_PATH ?? null;
  if (explicit !== null && explicit.trim().length > 0) {
    const absolute = resolve(explicit.trim());
    add({ path: absolute, source: 'env-override', directoryVersion: null, isFile: isFilePath(absolute) });
  }

  const appData = options.appDataDir ?? process.env.APPDATA ?? null;
  if (appData !== null && appData.trim().length > 0) {
    const versionsRoot = join(appData, 'Claude', 'claude-code');
    const versionDirs = directoryEntries(versionsRoot)
      .map((name) => ({ name, version: parseVersion(name) }))
      .sort((a, b) => compareVersions(b.version.parts, a.version.parts));
    for (const dir of versionDirs) {
      for (const name of names) {
        const candidate = join(versionsRoot, dir.name, name);
        if (isFilePath(candidate)) {
          add({ path: candidate, source: 'appdata-version-dir', directoryVersion: dir.version, isFile: true });
        }
      }
    }
  }

  const pathEntries =
    options.pathEntries ?? (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter((e) => e.length > 0);
  for (const entry of pathEntries) {
    if (entry.trim().length === 0) continue;
    for (const name of names) {
      const candidate = join(entry, name);
      if (isFilePath(candidate)) {
        add({ path: candidate, source: 'path-entry', directoryVersion: null, isFile: true });
      }
    }
  }

  return found;
}

/* ========================================================================== */
/*  --help parsing                                                             */
/* ========================================================================== */

export interface HelpProbe {
  readonly flags: ReadonlySet<string>;
  /** Enumerated values, for the options whose help text lists them. */
  readonly choices: ReadonlyMap<string, readonly string[]>;
  /** Full description block per option, so prose-listed values can be checked. */
  readonly descriptions: ReadonlyMap<string, string>;
  readonly exitCode: number | null;
  readonly bytes: number;
  readonly parsedOptionLines: number;
}

/**
 * Parse `--help` into the set of flags the installed CLI really accepts.
 *
 * The parsing is deliberately conservative, because being generous here is a
 * bug with teeth: a flag we wrongly believe exists gets passed and aborts the
 * run. Two rules do the work.
 *
 *  - Only the block between `Options:` and `Commands:` is considered. Anything
 *    in the usage banner or the command list is not an option.
 *  - A flag only counts when it appears in the OPTION COLUMN — that is, at an
 *    indent of at most four spaces, at the very start of the line. Description
 *    text mentions `--print`, `--resume` and `--output-format=stream-json` in
 *    prose, and it also mentions `--system-prompt[-file]`, which is not a flag
 *    at all. Those lines are indented far to the right and are treated as
 *    description, which is exactly what they are.
 *
 * A wrapped option such as
 *
 *     --allowedTools, --allowed-tools <tools...>
 *         Comma or space-separated list ...
 *
 * yields BOTH aliases, because both are real and either may be the one a
 * downstream caller checks for.
 */
export function parseHelp(help: string): Omit<HelpProbe, 'exitCode' | 'bytes'> {
  const lines = help.split(/\r?\n/);
  const flags = new Set<string>();
  const choices = new Map<string, readonly string[]>();
  const descriptions = new Map<string, string>();

  let inOptions = false;
  let parsedOptionLines = 0;
  let currentAliases: string[] = [];
  let currentDescription = '';

  const flush = (): void => {
    if (currentAliases.length === 0) return;
    const text = currentDescription.replace(/\s+/g, ' ').trim();
    const choiceMatch = /\(choices:\s*([^)]*)\)/.exec(text);
    const values =
      choiceMatch === null
        ? null
        : [...choiceMatch[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).filter((v) => v.length > 0);
    for (const alias of currentAliases) {
      descriptions.set(alias, text);
      if (values !== null && values.length > 0) choices.set(alias, values);
    }
    currentAliases = [];
    currentDescription = '';
  };

  for (const line of lines) {
    if (/^Options:\s*$/.test(line)) {
      inOptions = true;
      continue;
    }
    if (/^[A-Za-z][A-Za-z ]*:\s*$/.test(line) && !/^Options:\s*$/.test(line)) {
      if (inOptions) flush();
      inOptions = false;
      continue;
    }
    if (!inOptions) continue;

    const indentMatch = /^(\s*)(\S)/.exec(line);
    if (indentMatch === null) {
      currentDescription += ' ';
      continue;
    }
    const indent = indentMatch[1]!.length;
    const isOptionColumn = indent <= 4 && indentMatch[2] === '-';

    if (!isOptionColumn) {
      currentDescription += ` ${line.trim()}`;
      continue;
    }

    flush();
    parsedOptionLines += 1;

    // Commander separates the option spec from its description with two or more
    // spaces; when the description wraps to the next line there is no separator
    // at all and the whole trimmed line is the spec.
    const trimmed = line.trim();
    const split = trimmed.split(/\s{2,}/);
    const spec = split[0] ?? trimmed;
    currentDescription = split.slice(1).join(' ');

    // Take only the flag tokens, stopping at the first argument placeholder.
    for (const token of spec.split(/[\s,]+/)) {
      if (!token.startsWith('-')) break;
      const clean = token.replace(/[<[].*$/, '');
      if (/^--?[A-Za-z][A-Za-z0-9-]*$/.test(clean)) {
        flags.add(clean);
        currentAliases.push(clean);
      }
    }
  }
  flush();

  return { flags, choices, descriptions, parsedOptionLines };
}

/* ========================================================================== */
/*  The located runtime                                                        */
/* ========================================================================== */

export interface LocatedClaude {
  readonly executablePath: string;
  readonly source: CandidateSource;
  /** Normalised `major.minor.patch`, or null when `--version` did not say. */
  readonly version: string | null;
  readonly versionRaw: string;
  readonly flags: ReadonlySet<string>;
  readonly choices: ReadonlyMap<string, readonly string[]>;
  readonly descriptions: ReadonlyMap<string, string>;
  readonly probedAt: string;
  readonly candidatesConsidered: readonly ExecutableCandidate[];
  /** Everything that went wrong or looked odd while probing. Never swallowed. */
  readonly notes: readonly string[];
}

export type LocateResult =
  | { readonly ok: true; readonly located: LocatedClaude }
  | {
      readonly ok: false;
      readonly reason: 'NOT_FOUND' | 'VERSION_FAILED';
      readonly detail: string;
      readonly candidatesConsidered: readonly ExecutableCandidate[];
      readonly notes: readonly string[];
    };

/**
 * Find the executable, read its version, and probe `--help` exactly once.
 *
 * "Once" is a requirement, not an optimisation: `--help` is spawned per located
 * runtime and the result is what every later argv is built against, so probing
 * repeatedly would let two argvs in one process disagree about what the CLI
 * supports.
 */
export async function locateClaudeCode(options: LocateOptions = {}): Promise<LocateResult> {
  const notes: string[] = [];
  const candidates = discoverCandidates(options);
  const usable = candidates.filter((c) => c.isFile);

  if (usable.length === 0) {
    return {
      ok: false,
      reason: 'NOT_FOUND',
      detail:
        candidates.length === 0
          ? 'No claude executable was found under %APPDATA%\\Claude\\claude-code\\<version>\\ or on PATH.'
          : `Every candidate found was unreadable or not a file (${candidates.length} considered).`,
      candidatesConsidered: candidates,
      notes,
    };
  }

  for (const candidate of usable) {
    const result = await capture(candidate.path, ['--version'], {
      timeoutMs: options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS,
    });

    if (result.spawnError !== null) {
      notes.push(`${candidate.path}: could not be started (${redactSecrets(result.spawnError)})`);
      continue;
    }
    if (result.timedOut) {
      notes.push(`${candidate.path}: --version did not return within the probe timeout`);
      continue;
    }
    if (result.exitCode !== 0) {
      notes.push(`${candidate.path}: --version exited ${String(result.exitCode)}`);
      continue;
    }

    const version = parseVersion(result.stdout);
    if (version.normalised === null) {
      notes.push(`${candidate.path}: --version printed something with no recognisable version number`);
    }
    if (
      candidate.directoryVersion?.normalised != null &&
      version.normalised !== null &&
      candidate.directoryVersion.normalised !== version.normalised
    ) {
      notes.push(
        `${candidate.path}: install directory says ${candidate.directoryVersion.normalised} but --version says ${version.normalised}; the reported version is the one that is used`,
      );
    }

    const help = await capture(candidate.path, ['--help'], {
      timeoutMs: options.helpTimeoutMs ?? DEFAULT_HELP_TIMEOUT_MS,
    });
    if (help.spawnError !== null || help.timedOut || help.exitCode !== 0) {
      // A runtime whose capabilities we cannot read is a runtime we cannot pass
      // flags to safely, so it is refused rather than used with a guessed set.
      notes.push(
        `${candidate.path}: --help failed (exit ${String(help.exitCode)}${help.timedOut ? ', timed out' : ''}${
          help.spawnError === null ? '' : `, ${redactSecrets(help.spawnError)}`
        }); this executable was skipped because its flag set could not be established`,
      );
      continue;
    }

    const parsed = parseHelp(help.stdout);
    if (parsed.flags.size === 0) {
      notes.push(`${candidate.path}: --help produced no parsable options; skipped`);
      continue;
    }
    for (const forbidden of FORBIDDEN_FLAGS) {
      if (parsed.flags.has(forbidden)) {
        notes.push(`${candidate.path}: supports ${forbidden}, which this bridge refuses to pass regardless`);
      }
    }

    return {
      ok: true,
      located: {
        executablePath: candidate.path,
        source: candidate.source,
        version: version.normalised,
        versionRaw: version.raw,
        flags: parsed.flags,
        choices: parsed.choices,
        descriptions: parsed.descriptions,
        probedAt: new Date().toISOString(),
        candidatesConsidered: candidates,
        notes,
      },
    };
  }

  return {
    ok: false,
    reason: 'VERSION_FAILED',
    detail: `Found ${usable.length} candidate executable(s), none of which could be probed. See notes.`,
    candidatesConsidered: candidates,
    notes,
  };
}

/**
 * The gate every argv decision goes through.
 *
 * A forbidden flag answers false even when the CLI advertises it, so a caller
 * cannot reach a dangerous flag by asking politely.
 */
export function supportsFlag(located: LocatedClaude, flag: string): boolean {
  if (FORBIDDEN_FLAGS.includes(flag)) return false;
  return located.flags.has(flag);
}

/** True when `flag` accepts `value` according to the probed `(choices: ...)` list. */
export function supportsChoice(located: LocatedClaude, flag: string, value: string): boolean {
  const values = located.choices.get(flag);
  if (values === undefined) return false;
  return values.includes(value);
}

/**
 * Some options list their values in prose rather than in a `(choices: ...)`
 * block — `--effort` is the live example. Checking the description text is
 * weaker evidence than a parsed choice list, and the caller is expected to
 * treat it as such: it is used to *withhold* a value we cannot see documented,
 * never to invent one.
 */
export function descriptionMentions(located: LocatedClaude, flag: string, value: string): boolean {
  const text = located.descriptions.get(flag);
  if (text === undefined) return false;
  return new RegExp(`(^|[^A-Za-z0-9-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9-]|$)`).test(text);
}

/* ========================================================================== */
/*  Health check                                                               */
/* ========================================================================== */

export type HealthFailure =
  | 'NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'TIMEOUT'
  | 'NON_ZERO_EXIT'
  | 'UNPARSABLE_OUTPUT'
  | 'RUNTIME_REPORTED_ERROR';

export interface ClaudeHealth {
  /** The executable exists and reported a version. */
  readonly available: boolean;
  readonly version: string | null;
  /**
   * True ONLY when a real `-p` call completed successfully. False means "not
   * proven" — read `note` for which of the failure modes occurred.
   */
  readonly authenticated: boolean;
  readonly executablePath: string | null;
  readonly checkedAt: string;
  readonly supportedFlags: readonly string[];
  readonly failure: HealthFailure | null;
  readonly note: string;
  /** Session id the probe call reported, when it reported one. */
  readonly sessionId: string | null;
  /**
   * The NAME of the credential source (e.g. "none"), never a credential.
   *
   * It is always null from `healthCheck`, and honestly so: 2.1.217 prints
   * `apiKeySource` on the `system/init` line of a `stream-json` stream and NOT
   * in the single-envelope `--output-format json` output the health probe uses.
   * The streaming adapter reads it and puts it on the `session.started` event.
   */
  readonly apiKeySource: string | null;
  readonly probeExitCode: number | null;
  readonly probeDurationMs: number | null;
  /** Redacted, capped, and only present when explicitly requested. */
  readonly diagnosticExcerpt: string | null;
}

export interface HealthCheckOptions extends LocateOptions {
  /** A pre-probed runtime, so a health check need not re-run `--help`. */
  readonly located?: LocatedClaude;
  /** Working directory for the probe call. Must be an existing directory. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Permission mode for the probe. Must not be a bypass mode. */
  readonly permissionMode?: string;
  /**
   * Off by default. Turning it on puts a redacted excerpt of the probe's own
   * output into the result — useful when diagnosing, and a denylist against a
   * secret, which is why it is not the default.
   */
  readonly includeDiagnosticExcerpt?: boolean;
}

/** The marker the probe asks for. Its presence is corroborating, not the proof. */
export const HEALTH_PROBE_TOKEN = 'FORGE_HEALTH_OK';

function assertUsableCwd(candidate: string): string {
  const absolute = resolve(candidate);
  if (!isAbsolute(absolute)) throw new Error(`health-check cwd must be absolute (got ${safeExcerpt(candidate, 120)})`);
  if (dirname(absolute) === absolute) throw new Error('health-check cwd may not be a filesystem root');
  let isDir = false;
  try {
    isDir = statSync(absolute).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error(`health-check cwd does not exist or is not a directory: ${safeExcerpt(absolute, 200)}`);
  return absolute;
}

/**
 * Run one real, minimal `-p` call and report what it proved.
 *
 * `--output-format json` is used rather than `stream-json`: the health check
 * wants a single envelope, and the envelope is the same one the streaming path
 * ends with. `--permission-mode plan` keeps the probe read-only. No tool is
 * needed and none is expected.
 *
 * The result is assembled from things that were checked: the exit code was
 * read, the envelope was parsed, and `is_error` was inspected. A zero exit with
 * no parsable envelope is reported as UNPARSABLE_OUTPUT and `authenticated:
 * false`, because a process that exits 0 has proved only that it exited.
 */
export async function healthCheck(options: HealthCheckOptions = {}): Promise<ClaudeHealth> {
  const checkedAt = new Date().toISOString();
  const emptyBase = {
    checkedAt,
    sessionId: null,
    apiKeySource: null,
    probeExitCode: null,
    probeDurationMs: null,
    diagnosticExcerpt: null,
  } as const;

  let located: LocatedClaude;
  if (options.located !== undefined) {
    located = options.located;
  } else {
    const result = await locateClaudeCode(options);
    if (!result.ok) {
      return {
        ...emptyBase,
        available: false,
        version: null,
        authenticated: false,
        executablePath: null,
        supportedFlags: [],
        failure: 'NOT_FOUND',
        note: `${result.detail}${result.notes.length === 0 ? '' : ` Notes: ${result.notes.join(' | ')}`}`,
      };
    }
    located = result.located;
  }

  const supportedFlags = [...located.flags].sort();
  const base = {
    ...emptyBase,
    available: true,
    version: located.version,
    executablePath: located.executablePath,
    supportedFlags,
  } as const;

  const cwd = assertUsableCwd(options.cwd ?? process.cwd());
  const permissionMode = options.permissionMode ?? 'plan';
  if (FORBIDDEN_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(`refusing to run a health probe under permission mode ${permissionMode}`);
  }

  const argv: string[] = ['-p', `Reply with exactly: ${HEALTH_PROBE_TOKEN}`];
  if (supportsFlag(located, '--output-format') && supportsChoice(located, '--output-format', 'json')) {
    argv.push('--output-format', 'json');
  }
  if (supportsFlag(located, '--permission-mode') && supportsChoice(located, '--permission-mode', permissionMode)) {
    argv.push('--permission-mode', permissionMode);
  }

  const probe = await capture(located.executablePath, argv, {
    cwd,
    timeoutMs: options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
  });

  const excerpt =
    options.includeDiagnosticExcerpt === true
      ? // Each stream is redacted WHOLE before anything is cut. Slicing to 800 first (as this did until
        // 2026-08-01) can split a token across the boundary, and a half token matches no pattern — see
        // tests/unit/excerpt-redaction-order.test.ts. safeExcerpt applies the 1200 cap afterwards.
        safeExcerpt(`stdout: ${safeExcerpt(probe.stdout, 800)} | stderr: ${safeExcerpt(probe.stderr, 800)}`, 1200)
      : null;
  const withProbe = {
    ...base,
    probeExitCode: probe.exitCode,
    probeDurationMs: probe.durationMs,
    diagnosticExcerpt: excerpt,
  } as const;

  if (probe.spawnError !== null) {
    return {
      ...withProbe,
      authenticated: false,
      failure: 'SPAWN_FAILED',
      note: `The executable could not be started: ${redactSecrets(probe.spawnError)}. Authentication was not established.`,
    };
  }
  if (probe.timedOut) {
    return {
      ...withProbe,
      authenticated: false,
      failure: 'TIMEOUT',
      note: `The probe call did not finish within ${String(options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS)} ms. Authentication was not established; this is not proof that it is missing.`,
    };
  }

  let envelope: Record<string, unknown> | null = null;
  const text = probe.stdout.trim();
  if (text.length > 0) {
    try {
      const value: unknown = JSON.parse(text);
      envelope = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      envelope = null;
    }
  }

  if (probe.exitCode !== 0) {
    const isError = envelope !== null && envelope.is_error === true;
    return {
      ...withProbe,
      authenticated: false,
      failure: isError ? 'RUNTIME_REPORTED_ERROR' : 'NON_ZERO_EXIT',
      note: `The probe call exited ${String(probe.exitCode)}${
        isError ? ' and the runtime reported an error in its result envelope' : ''
      }. Authentication was not established.`,
    };
  }

  if (envelope === null) {
    return {
      ...withProbe,
      authenticated: false,
      failure: 'UNPARSABLE_OUTPUT',
      note: 'The probe call exited 0 but printed no parsable result envelope, so nothing was proved beyond the process exiting.',
    };
  }

  const sessionId = typeof envelope.session_id === 'string' ? envelope.session_id : null;
  const isError = envelope.is_error === true;
  const subtype = typeof envelope.subtype === 'string' ? envelope.subtype : null;

  if (isError || sessionId === null) {
    return {
      ...withProbe,
      authenticated: false,
      sessionId,
      failure: 'RUNTIME_REPORTED_ERROR',
      note: isError
        ? `The runtime returned a result envelope with is_error true (subtype ${subtype ?? 'unknown'}).`
        : 'The result envelope carried no session id, so no session was proved to exist.',
    };
  }

  return {
    ...withProbe,
    authenticated: true,
    sessionId,
    apiKeySource: null,
    failure: null,
    note: `A real -p call returned exit 0 with a result envelope (subtype ${subtype ?? 'unknown'}) and session id, in ${String(probe.durationMs)} ms.`,
  };
}

/** Project the health result onto the contract's `ClaudeCodeStatus` shape. */
export function toClaudeCodeStatus(health: ClaudeHealth): ClaudeCodeStatus {
  return {
    available: health.available,
    executablePath: health.executablePath,
    version: health.version,
    authenticated: health.authenticated,
    lastCheckedAt: health.checkedAt,
    supportedFlags: health.supportedFlags,
    note: health.note.length === 0 ? null : health.note,
  };
}
