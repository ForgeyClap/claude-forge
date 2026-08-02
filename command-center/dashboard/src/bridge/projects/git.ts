/**
 * Forge Workspace — the typed git wrapper.
 *
 * Everything the bridge knows about a project's version control comes through
 * this file. It is deliberately small and deliberately boring, because the two
 * ways a git wrapper goes wrong are both catastrophic:
 *
 * 1. IT BECOMES A SHELL. A wrapper that accepts a string and hands it to
 *    `cmd.exe` is an execute endpoint wearing a costume. Every invocation here
 *    is an argv ARRAY with `shell: false`, the subcommand is checked against an
 *    allowlist, and no exported function accepts raw arguments from a caller.
 *
 * 2. IT TOUCHES THE NETWORK. `fetch`, `pull`, `push`, `clone` and their
 *    plumbing equivalents can authenticate, exfiltrate and publish. None of
 *    them can be reached from here: they are absent from the allowlist AND
 *    named in an explicit deny list, so adding one back takes two deliberate
 *    edits in two places rather than one careless one.
 *
 * A note on WHERE git is. On this machine git is a portable MinGit install and
 * is NOT on a freshly-spawned process's PATH — that was measured, not assumed
 * (`Get-Command git` finds nothing; `%LOCALAPPDATA%\Programs\MinGit\cmd\git.exe`
 * reports 2.55.0.windows.3). So the locator tries PATH first and falls back to
 * that install, and it only ever accepts a real `.exe` on win32: Node cannot
 * spawn a `.cmd`/`.bat` without a shell, and going through a shell to reach one
 * is exactly the hole this module exists to not have.
 *
 * A note on WHAT THIS FILE CLAIMS. `ok` is derived from an exit code that was
 * actually read. It is never inferred from the process starting, from stdout
 * looking encouraging, or from the absence of an exception. Anything the
 * wrapper could not determine is `null`, and `null` is never read as `false`.
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';

import type { GitState } from '../../shared/protocol.ts';

/* ========================================================================== */
/*  Policy: what may be run at all                                             */
/* ========================================================================== */

/**
 * The complete set of subcommands this wrapper may execute. Every one is local:
 * none of them opens a socket, resolves a remote or reads a credential helper.
 */
const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'version',
  'init',
  'add',
  'commit',
  'status',
  'rev-parse',
  'log',
  'remote',
  'branch',
  'config',
  // Read-only, local, and heavily constrained by `assertDiffArgs` below. It is
  // here because a file diff cannot be produced without it: `status` reports
  // WHICH files changed and can never report HOW. See the note on external
  // diff drivers above `assertDiffArgs`.
  'diff',
]);

/**
 * Named so the intent survives a careless edit to the allowlist above. If a
 * subcommand appears here it is refused even if someone adds it there.
 */
const DENIED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'fetch',
  'pull',
  'push',
  'clone',
  'ls-remote',
  'submodule',
  'request-pull',
  'send-email',
  'svn',
  'p4',
  'archive',
  'bundle',
  'daemon',
  'http-backend',
  'credential',
  'credential-cache',
  'credential-store',
  'fetch-pack',
  'send-pack',
  'upload-pack',
  'upload-archive',
  'remote-http',
  'remote-https',
  'remote-ftp',
  'remote-ftps',
]);

/**
 * Options that make a local-looking command run a program or reach a peer.
 * `--upload-pack`/`--receive-pack`/`--exec` name an executable; the `ext::` and
 * `--config-env` forms let config be smuggled in from the environment.
 */
const DENIED_OPTION_PREFIXES: readonly string[] = [
  '--upload-pack',
  '--receive-pack',
  '--exec',
  '--config-env',
  '--namespace=ext',
];

/** Config keys the wrapper may READ. Nothing here is a secret or a credential. */
const READABLE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'user.name',
  'user.email',
  'init.defaultBranch',
]);

/** Config keys the wrapper may set for a single invocation, via `-c`. */
const SETTABLE_CONFIG_KEYS: ReadonlySet<string> = new Set(['user.name', 'user.email']);

/** Long enough for a real `git add` on a large tree, short enough to not hang a UI. */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** Captured output is capped: a runaway command must not become a memory bug. */
const MAX_CAPTURED_OUTPUT = 1_000_000;

/** What is kept on the result object, after redaction. */
const MAX_REPORTED_OUTPUT = 4_000;

/** The initial branch new repositories get. Explicit, so it never depends on
 *  whatever `init.defaultBranch` happens to be on the machine — which on this
 *  one is unset, so git would have chosen `master` and printed a hint. */
export const DEFAULT_INITIAL_BRANCH = 'main';

/* ========================================================================== */
/*  Errors                                                                     */
/* ========================================================================== */

/**
 * A policy violation, not a runtime failure. Thrown rather than returned,
 * because reaching one means a caller tried to do something this module is
 * built to make impossible — that is a bug to fix, not a state to render.
 */
export class GitPolicyError extends Error {
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'GitPolicyError';
    this.detail = detail;
    Object.setPrototypeOf(this, GitPolicyError.prototype);
  }
}

export function isGitPolicyError(value: unknown): value is GitPolicyError {
  return value instanceof GitPolicyError;
}

/* ========================================================================== */
/*  Locating the executable                                                    */
/* ========================================================================== */

export type GitExecutableSource = 'explicit' | 'path' | 'mingit-fallback';

export interface GitLocation {
  readonly executablePath: string;
  readonly source: GitExecutableSource;
}

export interface GitLocationReport {
  readonly location: GitLocation | null;
  /** Every place that was looked, in order. An auditable trail, not a guess. */
  readonly triedPaths: readonly string[];
  readonly detail: string;
}

function isExecutableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The binary name we are willing to spawn. On win32 this is `git.exe` and only
 * `git.exe`: `spawn` with `shell: false` cannot run a `.cmd` or `.bat` at all,
 * and running one through a shell would reintroduce argument-injection on a
 * path that is otherwise argv-safe.
 */
function executableName(): string {
  return process.platform === 'win32' ? 'git.exe' : 'git';
}

/** The portable MinGit install this machine actually has. */
function minGitFallbacks(): readonly string[] {
  if (process.platform !== 'win32') return [];
  const candidates: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(path.win32.join(localAppData, 'Programs', 'MinGit', 'cmd', 'git.exe'));
  }
  // Derived from the home directory as well, so a process that inherited no
  // LOCALAPPDATA still finds the install rather than reporting git as absent.
  candidates.push(path.win32.join(os.homedir(), 'AppData', 'Local', 'Programs', 'MinGit', 'cmd', 'git.exe'));
  return [...new Set(candidates)];
}

/**
 * Find git. PATH first (so a user's own install wins), then the known portable
 * location. Returns a report rather than a bare path: when git is missing, the
 * caller has to be able to say WHERE it looked.
 */
export function locateGit(explicitPath?: string): GitLocationReport {
  const tried: string[] = [];

  if (explicitPath !== undefined && explicitPath.length > 0) {
    tried.push(explicitPath);
    if (isExecutableFile(explicitPath)) {
      return {
        location: { executablePath: path.resolve(explicitPath), source: 'explicit' },
        detail: 'used the explicitly supplied executable path',
        triedPaths: tried,
      };
    }
    return {
      location: null,
      detail: 'the explicitly supplied git executable path does not point at a file',
      triedPaths: tried,
    };
  }

  const name = executableName();
  const rawPath = process.env.PATH ?? process.env.Path ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of rawPath.split(separator)) {
    const trimmed = dir.trim().replace(/^"|"$/g, '');
    if (trimmed.length === 0) continue;
    const candidate = path.join(trimmed, name);
    tried.push(candidate);
    if (isExecutableFile(candidate)) {
      return {
        location: { executablePath: path.resolve(candidate), source: 'path' },
        detail: 'found on PATH',
        triedPaths: tried,
      };
    }
  }

  for (const candidate of minGitFallbacks()) {
    tried.push(candidate);
    if (isExecutableFile(candidate)) {
      return {
        location: { executablePath: path.resolve(candidate), source: 'mingit-fallback' },
        detail:
          'not on this process’s PATH; used the portable MinGit install. A freshly spawned ' +
          'process does not always inherit a recently updated user PATH.',
        triedPaths: tried,
      };
    }
  }

  return {
    location: null,
    detail: `no ${name} was found on PATH or at the known portable install location`,
    triedPaths: tried,
  };
}

/* ========================================================================== */
/*  Running one command                                                        */
/* ========================================================================== */

export interface GitCommandResult {
  /** True ONLY when an exit code was read and it was zero. Never inferred. */
  readonly ok: boolean;
  readonly executablePath: string | null;
  /** The argv actually passed, after `git`. Recorded so a result is auditable. */
  readonly args: readonly string[];
  readonly cwd: string;
  /** Null when the process never ran, or was killed before it could exit. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** Set when the command could not be run at all. Null when it ran. */
  readonly failure: string | null;
}

export interface RunGitOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  /** Per-invocation `-c key=value`. Limited to `SETTABLE_CONFIG_KEYS`. */
  readonly configOverrides?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly executablePath?: string;
  /** Set only for `git version`, which needs no repository. */
  readonly allowAnyCwd?: boolean;
  /**
   * Characters of stdout/stderr kept on the result. Defaults to
   * `MAX_REPORTED_OUTPUT`, which is right for the status/log commands whose
   * output is a handful of lines. A patch is not, so `diffAgainstHead` raises
   * it — and reports truncation rather than serving a silently short patch.
   */
  readonly maxOutputChars?: number;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Strip credentials out of anything that came back from git. A remote URL of
 * the form `https://user:token@host/repo` can appear in an error message, and
 * this module's output is written to receipts and event payloads.
 */
function redact(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, '$1<redacted>@');
}

/**
 * Redact, then cap.
 *
 * The cap is exact and the caller can detect it without parsing the marker:
 * a clipped string is ALWAYS longer than `limit` (limit characters plus the
 * suffix), and an unclipped one is always `<= limit`. `diffAgainstHead` relies
 * on precisely that, because "the patch you are looking at is incomplete" is
 * not something a viewer may guess at.
 */
function clip(text: string, limit: number = MAX_REPORTED_OUTPUT): string {
  const redacted = redact(text);
  return redacted.length > limit ? `${redacted.slice(0, limit)}…(${redacted.length} chars)` : redacted;
}

function assertLocalOnly(args: readonly string[]): void {
  if (args.length === 0) throw new GitPolicyError('a git invocation must name a subcommand');

  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new GitPolicyError('every git argument must be a string');
    }
    if (CONTROL_CHARS.test(arg)) {
      throw new GitPolicyError('a git argument contains a control character');
    }
    for (const prefix of DENIED_OPTION_PREFIXES) {
      if (arg === prefix || arg.startsWith(`${prefix}=`)) {
        throw new GitPolicyError(`the git option "${prefix}" can execute a program or reach a peer and is refused`);
      }
    }
  }

  const subcommand = args[0]!;
  if (DENIED_SUBCOMMANDS.has(subcommand)) {
    throw new GitPolicyError(
      `"git ${subcommand}" can contact a network or run a helper; the bridge never performs it`,
    );
  }
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new GitPolicyError(`"git ${subcommand}" is not in the bridge's git allowlist`);
  }

  // `git remote` on its own lists NAMES. Every other form either mutates the
  // remote configuration or prints URLs, which can carry embedded credentials.
  if (subcommand === 'remote' && args.length !== 1) {
    throw new GitPolicyError('only the bare "git remote" form is permitted; it lists names and prints no URL');
  }

  if (subcommand === 'config') {
    const rest = args.slice(1).filter((a) => a !== '--local');
    if (rest.length !== 2 || rest[0] !== '--get' || !READABLE_CONFIG_KEYS.has(rest[1]!)) {
      throw new GitPolicyError(
        `git config is limited to reading ${[...READABLE_CONFIG_KEYS].join(', ')} via --get`,
      );
    }
  }

  if (subcommand === 'diff') assertDiffArgs(args);
}

/* -------------------------------------------------------------------------- */
/*  git diff                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `git diff` LOOKS like a pure read and is not one by default.
 *
 * Two documented mechanisms let a repository turn it into code execution on the
 * machine running it, and both are configured by files INSIDE the repository —
 * exactly the material a project folder is full of:
 *
 *   diff.external / GIT_EXTERNAL_DIFF   names a program git runs per file.
 *   .gitattributes `diff=<driver>` plus `diff.<driver>.textconv` names a
 *                                       program git runs to make a file
 *                                       "readable" before diffing it.
 *
 * `--no-ext-diff` and `--no-textconv` disable both, and this guard REQUIRES
 * them to be present rather than trusting the caller to remember: a diff
 * invocation without them is refused before it can spawn anything. The
 * environment vector is closed separately — `childEnvironment()` builds the
 * child environment from an allowlist, so GIT_EXTERNAL_DIFF is never inherited.
 */
const DIFF_REQUIRED_FLAGS: readonly string[] = ['--no-ext-diff', '--no-textconv'];

/** Flags the wrapper will pass to `git diff`. Everything else is refused. */
const DIFF_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--find-renames',
  '--no-prefix',
  '--',
  'HEAD',
]);

const DIFF_UNIFIED = /^--unified=\d{1,3}$/;

function assertDiffArgs(args: readonly string[]): void {
  for (const required of DIFF_REQUIRED_FLAGS) {
    if (!args.includes(required)) {
      throw new GitPolicyError(
        `"git diff" must be invoked with ${required}; without it a repository's own configuration can make git run a program`,
      );
    }
  }

  const separator = args.indexOf('--');
  const flags = separator === -1 ? args.slice(1) : args.slice(1, separator);
  for (const flag of flags) {
    if (DIFF_ALLOWED_FLAGS.has(flag) || DIFF_UNIFIED.test(flag)) continue;
    throw new GitPolicyError(`the git diff option "${flag}" is not in the bridge's diff allowlist`);
  }

  if (separator === -1) return;
  const pathspecs = args.slice(separator + 1);
  if (pathspecs.length > 1) {
    throw new GitPolicyError('the bridge diffs at most one pathspec at a time');
  }
  for (const spec of pathspecs) {
    if (spec.length === 0) throw new GitPolicyError('an empty pathspec is not a path');
    if (spec.startsWith('-')) throw new GitPolicyError('a pathspec may not begin with a hyphen');
    // `:(exclude)…`, `:!…` and `:/` are git's pathspec MAGIC. They change what
    // the argument means, so the wrapper takes plain relative paths only.
    if (spec.includes(':')) throw new GitPolicyError('a pathspec may not contain a colon (git pathspec magic)');
    if (path.win32.isAbsolute(spec) || path.posix.isAbsolute(spec)) {
      throw new GitPolicyError('a pathspec must be relative to the work tree');
    }
    for (const segment of spec.split(/[\\/]+/)) {
      if (segment === '..') throw new GitPolicyError('a pathspec may not contain a dot-dot segment');
    }
  }
}

function assertConfigOverrides(overrides: Readonly<Record<string, string>>): readonly string[] {
  const argv: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (!SETTABLE_CONFIG_KEYS.has(key)) {
      throw new GitPolicyError(`git config key "${key}" may not be set by the bridge`);
    }
    if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARS.test(value)) {
      throw new GitPolicyError(`the value for git config key "${key}" is empty or contains a control character`);
    }
    argv.push('-c', `${key}=${value}`);
  }
  return argv;
}

/**
 * The environment git runs in.
 *
 * It is built from an explicit list rather than inherited wholesale. The three
 * `*_ASKPASS`/`TERMINAL_PROMPT` settings exist so a command can never block on
 * an invisible credential prompt — a bridge that hangs forever waiting for a
 * password nobody can see is a worse failure than one that reports an error.
 * HOME/USERPROFILE/APPDATA are passed through so git resolves the same user
 * configuration the owner sees when they run git themselves.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  const passthrough = [
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PATHEXT',
    'COMSPEC',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of passthrough) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  env.GCM_INTERACTIVE = 'never';
  // Deterministic message text for anything we parse or record.
  env.LC_ALL = 'C';
  return env;
}

function directoryExists(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function failed(
  cwd: string,
  args: readonly string[],
  executablePath: string | null,
  failure: string,
): GitCommandResult {
  return {
    ok: false,
    executablePath,
    args: [...args],
    cwd,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    failure,
  };
}

/**
 * Run one git command.
 *
 * Never throws for a git failure — a non-zero exit is a result, not an
 * exception. Throws only `GitPolicyError`, and only when a caller asked for
 * something the wrapper refuses to do.
 */
export function runGit(options: RunGitOptions): GitCommandResult {
  assertLocalOnly(options.args);
  const configArgv = options.configOverrides ? assertConfigOverrides(options.configOverrides) : [];

  if (typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)) {
    throw new GitPolicyError('git must be run with an absolute working directory');
  }
  const cwd = path.resolve(options.cwd);
  const argv = [...configArgv, ...options.args];
  const outputLimit =
    typeof options.maxOutputChars === 'number' && Number.isSafeInteger(options.maxOutputChars) && options.maxOutputChars > 0
      ? Math.min(options.maxOutputChars, MAX_CAPTURED_OUTPUT)
      : MAX_REPORTED_OUTPUT;

  if (options.allowAnyCwd !== true && !directoryExists(cwd)) {
    return failed(cwd, argv, null, `working directory does not exist: ${cwd}`);
  }

  const located = locateGit(options.executablePath);
  if (located.location === null) {
    return failed(cwd, argv, null, `git executable not found — ${located.detail}`);
  }

  const startedAt = Date.now();
  const result = spawnSync(located.location.executablePath, argv, {
    cwd,
    env: childEnvironment(),
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: false,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer: MAX_CAPTURED_OUTPUT,
  });
  const durationMs = Date.now() - startedAt;

  const signal = result.signal === null || result.signal === undefined ? null : String(result.signal);
  const spawnError = result.error as (Error & { code?: string }) | undefined;
  const timedOut = spawnError?.code === 'ETIMEDOUT' || (spawnError !== undefined && signal !== null);

  if (spawnError !== undefined && result.status === null) {
    return {
      ok: false,
      executablePath: located.location.executablePath,
      args: argv,
      cwd,
      exitCode: null,
      signal,
      stdout: clip(result.stdout ?? '', outputLimit),
      stderr: clip(result.stderr ?? '', outputLimit),
      durationMs,
      timedOut,
      failure: timedOut
        ? `git did not finish within ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms and was killed`
        : `git could not be run: ${redact(spawnError.message)}`,
    };
  }

  const exitCode = typeof result.status === 'number' ? result.status : null;
  return {
    // The single place `ok` is decided, and it is decided by a number we read.
    ok: exitCode === 0 && !timedOut,
    executablePath: located.location.executablePath,
    args: argv,
    cwd,
    exitCode,
    signal,
    stdout: clip(result.stdout ?? '', outputLimit),
    stderr: clip(result.stderr ?? '', outputLimit),
    durationMs,
    timedOut,
    failure: exitCode === null ? 'git exited without reporting an exit code' : null,
  };
}

/* ========================================================================== */
/*  isAvailable                                                                */
/* ========================================================================== */

export interface GitAvailability {
  readonly available: boolean;
  readonly executablePath: string | null;
  readonly source: GitExecutableSource | null;
  /** Parsed from `git version` output. Null when the command did not succeed. */
  readonly version: string | null;
  readonly checkedAt: string;
  readonly triedPaths: readonly string[];
  readonly detail: string;
}

/**
 * Is there a usable git?
 *
 * The check RUNS `git version` and reads its exit code. A file existing at a
 * plausible path is not evidence that it executes — an interrupted install
 * leaves a `git.exe` that cannot start, and reporting that as available would
 * make every later git failure inexplicable.
 */
export function isAvailable(options: { readonly executablePath?: string } = {}): GitAvailability {
  const checkedAt = new Date().toISOString();
  const located = locateGit(options.executablePath);
  if (located.location === null) {
    return {
      available: false,
      executablePath: null,
      source: null,
      version: null,
      checkedAt,
      triedPaths: located.triedPaths,
      detail: located.detail,
    };
  }

  const result = runGit({
    cwd: os.tmpdir(),
    args: ['version'],
    executablePath: located.location.executablePath,
    allowAnyCwd: true,
    timeoutMs: 10_000,
  });

  if (!result.ok) {
    return {
      available: false,
      executablePath: located.location.executablePath,
      source: located.location.source,
      version: null,
      checkedAt,
      triedPaths: located.triedPaths,
      detail:
        result.failure ??
        `"git version" exited with code ${String(result.exitCode)}; the executable exists but does not run`,
    };
  }

  const match = /git version (\S+)/.exec(result.stdout);
  return {
    available: true,
    executablePath: located.location.executablePath,
    source: located.location.source,
    version: match?.[1] ?? null,
    checkedAt,
    triedPaths: located.triedPaths,
    detail:
      match === null
        ? '"git version" succeeded but its output did not contain a recognisable version string'
        : `${located.location.source === 'path' ? 'found on PATH' : located.detail}`,
  };
}

/* ========================================================================== */
/*  Repository identity                                                        */
/* ========================================================================== */

export interface RepositoryCheck {
  /** True only when `cwd` is itself the top of a work tree. */
  readonly isRepositoryRoot: boolean;
  /** The work-tree top git reported, when it reported one. */
  readonly topLevel: string | null;
  /**
   * True when git found a repository, but a DIFFERENT one — `cwd` is nested
   * inside someone else's work tree. Treating that as "this project has git"
   * would attribute another repository's branch and history to this project.
   */
  readonly insideForeignRepository: boolean;
  readonly detail: string;
  readonly command: GitCommandResult;
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Does `cwd` hold its own repository?
 *
 * `rev-parse --is-inside-work-tree` is the obvious call and the wrong one: it
 * answers yes for any directory nested inside any repository, so a project
 * folder created under an existing checkout would report a branch and a commit
 * that belong to something else entirely. Comparing `--show-toplevel` against
 * the directory itself is exact.
 */
export function isRepositoryRoot(cwd: string, options: { readonly executablePath?: string } = {}): RepositoryCheck {
  const command = runGit({
    cwd,
    args: ['rev-parse', '--show-toplevel'],
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
  });

  if (!command.ok) {
    return {
      isRepositoryRoot: false,
      topLevel: null,
      insideForeignRepository: false,
      detail: command.failure ?? 'git reported that this directory is not inside a repository',
      command,
    };
  }

  const topLevel = command.stdout.trim();
  if (topLevel.length === 0) {
    return {
      isRepositoryRoot: false,
      topLevel: null,
      insideForeignRepository: false,
      detail: 'git succeeded but reported no work-tree top level',
      command,
    };
  }

  const here = samePath(topLevel, cwd);
  return {
    isRepositoryRoot: here,
    topLevel,
    insideForeignRepository: !here,
    detail: here
      ? 'this directory is the top of its own work tree'
      : `this directory is nested inside a different repository rooted at ${topLevel}`,
    command,
  };
}

/* ========================================================================== */
/*  The verbs                                                                  */
/* ========================================================================== */

export interface GitInitOptions {
  readonly initialBranch?: string;
  readonly executablePath?: string;
}

/**
 * `git init` with an explicit initial branch.
 *
 * The branch name is always passed. Left to itself, git on this machine picks
 * `master` (there is no `init.defaultBranch` configured — measured, not
 * assumed) and prints a hint to stderr, which would make the recorded branch
 * depend on the machine rather than on the bridge.
 */
export function init(cwd: string, options: GitInitOptions = {}): GitCommandResult {
  const branch = options.initialBranch ?? DEFAULT_INITIAL_BRANCH;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch)) {
    throw new GitPolicyError(`"${branch}" is not an acceptable initial branch name`);
  }
  return runGit({
    cwd,
    args: ['init', `--initial-branch=${branch}`],
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
  });
}

/** Stage everything, including deletions. `--` terminates option parsing. */
export function addAll(cwd: string, options: { readonly executablePath?: string } = {}): GitCommandResult {
  return runGit({
    cwd,
    args: ['add', '--all', '--'],
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
  });
}

export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface CommitOptions {
  /**
   * Identity for THIS commit only, passed as `-c user.name`/`-c user.email`.
   * Nothing is written to any git configuration file. Required on machines with
   * no configured identity — which is the case here, so a commit without it
   * fails with exit 128 rather than silently inventing an author.
   */
  readonly author?: GitAuthor;
  readonly allowEmpty?: boolean;
  readonly executablePath?: string;
}

export function commit(cwd: string, message: string, options: CommitOptions = {}): GitCommandResult {
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new GitPolicyError('a commit message may not be empty');
  }
  const args = ['commit', '--no-gpg-sign', '--message', message];
  if (options.allowEmpty === true) args.splice(1, 0, '--allow-empty');

  const overrides: Record<string, string> = {};
  if (options.author !== undefined) {
    overrides['user.name'] = options.author.name;
    overrides['user.email'] = options.author.email;
  }

  return runGit({
    cwd,
    args,
    ...(Object.keys(overrides).length > 0 ? { configOverrides: overrides } : {}),
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
  });
}

export interface CurrentBranchResult {
  readonly ok: boolean;
  /** Null when HEAD is detached, or when the branch could not be determined. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly detail: string;
  readonly command: GitCommandResult;
}

/**
 * The checked-out branch.
 *
 * `git branch --show-current` was chosen because it also answers correctly on
 * an unborn HEAD — a repository that has been initialised but never committed
 * still reports its branch (verified on this machine: a fresh `git init`
 * printed `master` with exit 0). It prints nothing when HEAD is detached, which
 * is reported as `detached`, never as a missing branch.
 */
export function currentBranch(
  cwd: string,
  options: { readonly executablePath?: string } = {},
): CurrentBranchResult {
  const command = runGit({
    cwd,
    args: ['branch', '--show-current'],
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
  });
  if (!command.ok) {
    return {
      ok: false,
      branch: null,
      detached: false,
      detail: command.failure ?? `git exited with code ${String(command.exitCode)}`,
      command,
    };
  }
  const branch = command.stdout.trim();
  if (branch.length === 0) {
    return {
      ok: true,
      branch: null,
      detached: true,
      detail: 'HEAD is detached, so there is no current branch',
      command,
    };
  }
  return { ok: true, branch, detached: false, detail: 'read from git branch --show-current', command };
}

export interface CommitSummary {
  readonly sha: string;
  readonly shortSha: string;
  readonly committedAt: string;
  readonly subject: string;
}

export interface LastCommitResult {
  readonly ok: boolean;
  /** Null when the repository has no commits yet — a fact, not a failure. */
  readonly commit: CommitSummary | null;
  readonly detail: string;
  readonly commands: readonly GitCommandResult[];
}

/**
 * Field separator for `git log --pretty`.
 *
 * Two forms, and the difference is load-bearing. `LOG_FORMAT` uses git's own
 * `%x1f` escape, so the ARGUMENT stays plain ASCII and survives the
 * control-character check every argv element goes through. `FIELD_SEPARATOR`
 * is the byte git actually emits, and is used only to split the OUTPUT. Putting
 * a raw U+001F in the argument instead is a bug -- and one this module's own
 * guard catches, which is how it was found.
 */
const FIELD_SEPARATOR = '\u001f';
const LOG_FORMAT = '--pretty=format:%H%x1f%h%x1f%cI%x1f%s';

/**
 * The most recent commit.
 *
 * HEAD is verified FIRST with `rev-parse --verify --quiet HEAD`, which exits 1
 * silently on an unborn branch. Without it the only signal would be `git log`
 * exiting 128 with an English sentence on stderr — and deciding "no commits
 * yet" by matching words in a message is exactly the kind of inference this
 * system is not allowed to make. An exit code is checkable; a sentence is not.
 */
export function lastCommit(cwd: string, options: { readonly executablePath?: string } = {}): LastCommitResult {
  const executable = options.executablePath !== undefined ? { executablePath: options.executablePath } : {};
  const verify = runGit({ cwd, args: ['rev-parse', '--verify', '--quiet', 'HEAD'], ...executable });

  if (!verify.ok) {
    if (verify.exitCode === 1) {
      return {
        ok: true,
        commit: null,
        detail: 'the repository has no commits yet (HEAD is unborn)',
        commands: [verify],
      };
    }
    return {
      ok: false,
      commit: null,
      detail: verify.failure ?? `could not verify HEAD; git exited with code ${String(verify.exitCode)}`,
      commands: [verify],
    };
  }

  const log = runGit({
    cwd,
    args: ['log', '-1', LOG_FORMAT],
    ...executable,
  });
  if (!log.ok) {
    return {
      ok: false,
      commit: null,
      detail: log.failure ?? `git log exited with code ${String(log.exitCode)}`,
      commands: [verify, log],
    };
  }

  const parts = log.stdout.split(FIELD_SEPARATOR);
  if (parts.length < 4) {
    return {
      ok: false,
      commit: null,
      detail: 'git log succeeded but its output did not have the expected field structure',
      commands: [verify, log],
    };
  }

  return {
    ok: true,
    commit: {
      sha: parts[0]!.trim(),
      shortSha: parts[1]!.trim(),
      committedAt: parts[2]!.trim(),
      subject: parts.slice(3).join(FIELD_SEPARATOR).trim(),
    },
    detail: 'read from git log -1',
    commands: [verify, log],
  };
}

export interface HasRemoteResult {
  readonly ok: boolean;
  /** Null when it could not be determined. Never silently read as false. */
  readonly hasRemote: boolean | null;
  /** Remote NAMES only. URLs are never requested, so none can be logged. */
  readonly names: readonly string[];
  readonly detail: string;
  readonly command: GitCommandResult;
}

export function hasRemote(cwd: string, options: { readonly executablePath?: string } = {}): HasRemoteResult {
  const command = runGit({
    cwd,
    args: ['remote'],
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
  });
  if (!command.ok) {
    return {
      ok: false,
      hasRemote: null,
      names: [],
      detail: command.failure ?? `git exited with code ${String(command.exitCode)}`,
      command,
    };
  }
  const names = command.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    ok: true,
    hasRemote: names.length > 0,
    names,
    detail: names.length === 0 ? 'no remote is configured' : `${names.length} remote(s) configured`,
    command,
  };
}

export interface DirtyFileEntry {
  readonly code: string;
  readonly path: string;
}

export interface GitStatusResult {
  readonly ok: boolean;
  /**
   * The contract's `GitState`. Present even when some field could not be
   * determined — the individual nulls carry that, so a caller never has to
   * choose between "no state at all" and a state with invented values.
   */
  readonly state: GitState;
  readonly entries: readonly DirtyFileEntry[];
  readonly detached: boolean;
  readonly insideForeignRepository: boolean;
  /** Every field this call could NOT establish. Empty means everything held. */
  readonly undetermined: readonly string[];
  readonly detail: string;
  readonly commands: readonly GitCommandResult[];
}

/**
 * Parse `--porcelain=v1 -z`.
 *
 * NUL separation rather than newlines because a filename may legally contain a
 * newline, and counting lines would then over-report dirty files. Rename and
 * copy entries emit TWO NUL-terminated fields (new path, then original), so the
 * second is consumed here — verified against real output on this machine:
 * `R  b.txt\0a.txt\0`.
 */
function parsePorcelainZ(stdout: string): readonly DirtyFileEntry[] {
  const fields = stdout.split('\u0000');
  const entries: DirtyFileEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field.length === 0) continue;
    const code = field.slice(0, 2);
    const filePath = field.slice(3);
    entries.push({ code, path: filePath });
    if (code.startsWith('R') || code.startsWith('C')) i += 1; // the original path
  }
  return entries;
}

/**
 * The whole `GitState` for a directory, assembled from four local commands.
 *
 * `initialized` is true only when this directory is the top of its OWN work
 * tree. A project folder that merely sits inside another repository reports
 * `initialized: false` with `insideForeignRepository: true`, because claiming
 * the parent's branch and commit as this project's would be a false statement
 * about the project.
 */
export function status(cwd: string, options: { readonly executablePath?: string } = {}): GitStatusResult {
  const executable = options.executablePath !== undefined ? { executablePath: options.executablePath } : {};
  const commands: GitCommandResult[] = [];
  const undetermined: string[] = [];

  const repository = isRepositoryRoot(cwd, options);
  commands.push(repository.command);

  if (!repository.isRepositoryRoot) {
    return {
      ok: repository.command.ok || repository.command.failure === null,
      state: { initialized: false, branch: null, dirtyFiles: 0, lastCommit: null, hasRemote: false },
      entries: [],
      detached: false,
      insideForeignRepository: repository.insideForeignRepository,
      undetermined: repository.insideForeignRepository ? ['branch', 'dirtyFiles', 'lastCommit', 'hasRemote'] : [],
      detail: repository.detail,
      commands,
    };
  }

  const branchResult = currentBranch(cwd, options);
  commands.push(branchResult.command);
  if (!branchResult.ok) undetermined.push('branch');

  const statusCommand = runGit({
    cwd,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    ...executable,
  });
  commands.push(statusCommand);
  const entries = statusCommand.ok ? parsePorcelainZ(statusCommand.stdout) : [];
  if (!statusCommand.ok) undetermined.push('dirtyFiles');

  const last = lastCommit(cwd, options);
  commands.push(...last.commands);
  if (!last.ok) undetermined.push('lastCommit');

  const remote = hasRemote(cwd, options);
  commands.push(remote.command);
  if (!remote.ok) undetermined.push('hasRemote');

  const state: GitState = {
    initialized: true,
    branch: branchResult.branch,
    // A count we could not take is reported as 0 alongside `undetermined`
    // naming the field; the contract has no null here, so the honest signal
    // lives in `undetermined` rather than in a zero pretending to be clean.
    dirtyFiles: entries.length,
    lastCommit: last.commit?.sha ?? null,
    hasRemote: remote.hasRemote === true,
  };

  return {
    ok: undetermined.length === 0,
    state,
    entries,
    detached: branchResult.detached,
    insideForeignRepository: false,
    undetermined,
    detail:
      undetermined.length === 0
        ? 'every field was read from a git command that exited zero'
        : `could not determine: ${undetermined.join(', ')}`,
    commands,
  };
}

/* ========================================================================== */
/*  Diff                                                                       */
/* ========================================================================== */

/** Default characters of patch text kept. Raised well above a status listing. */
export const DEFAULT_DIFF_MAX_CHARS = 256 * 1024;

export const DEFAULT_DIFF_CONTEXT_LINES = 3;

export interface DiffAgainstHeadOptions {
  /** A work-tree-relative path. Omit to diff the whole work tree. */
  readonly pathspec?: string;
  readonly contextLines?: number;
  readonly maxChars?: number;
  readonly executablePath?: string;
}

export interface DiffAgainstHeadResult {
  /** True ONLY when git exited zero. Never inferred from empty output. */
  readonly ok: boolean;
  /** The unified patch git printed. Empty AND ok means genuinely no changes. */
  readonly patch: string;
  /** True when the patch was cut off. A cut-off patch is not "the changes". */
  readonly truncated: boolean;
  readonly detail: string;
  readonly command: GitCommandResult;
}

/**
 * `git diff HEAD` — the working tree, including staged changes, against the
 * last commit.
 *
 * What this does NOT show, stated here because a caller who does not know it
 * will render a lie: untracked files never appear in a diff against HEAD. A
 * brand-new file shows up as no change at all. Callers that present this to a
 * person must pair it with `git status`.
 */
export function diffAgainstHead(cwd: string, options: DiffAgainstHeadOptions = {}): DiffAgainstHeadResult {
  const context =
    typeof options.contextLines === 'number' && Number.isSafeInteger(options.contextLines) && options.contextLines >= 0
      ? Math.min(options.contextLines, 100)
      : DEFAULT_DIFF_CONTEXT_LINES;
  const maxChars =
    typeof options.maxChars === 'number' && Number.isSafeInteger(options.maxChars) && options.maxChars > 0
      ? options.maxChars
      : DEFAULT_DIFF_MAX_CHARS;

  const args = [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--find-renames',
    `--unified=${context}`,
    'HEAD',
  ];
  if (options.pathspec !== undefined && options.pathspec.length > 0) {
    args.push('--', options.pathspec);
  }

  const command = runGit({
    cwd,
    args,
    maxOutputChars: maxChars,
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
  });

  if (!command.ok) {
    return {
      ok: false,
      patch: '',
      truncated: false,
      detail: command.failure ?? `git diff exited with code ${String(command.exitCode)}`,
      command,
    };
  }

  // `clip` only ever produces a string longer than the limit when it truncated,
  // so this is an exact test rather than a guess about a marker.
  const truncated = command.stdout.length > maxChars;
  return {
    ok: true,
    patch: command.stdout,
    truncated,
    detail: truncated
      ? `the patch exceeded ${maxChars} characters and was cut off`
      : command.stdout.length === 0
        ? 'git diff HEAD exited zero with no output: the tracked files match HEAD'
        : 'read from git diff HEAD',
    command,
  };
}

/* ========================================================================== */
/*  Identity discovery                                                         */
/* ========================================================================== */

export interface ConfiguredIdentity {
  readonly name: string | null;
  readonly email: string | null;
  /** True only when BOTH are configured — a commit needs both. */
  readonly complete: boolean;
  readonly detail: string;
}

/**
 * What identity would git use for a commit here?
 *
 * On this machine the answer is "none": `git config --get user.name` and
 * `--get user.email` both exit 1. That is why `commit` accepts an explicit
 * per-invocation author — and why the caller has to record that the identity
 * was a fallback rather than the owner's own.
 */
export function configuredIdentity(
  cwd: string,
  options: { readonly executablePath?: string } = {},
): ConfiguredIdentity {
  const executable = options.executablePath !== undefined ? { executablePath: options.executablePath } : {};
  const read = (key: string): string | null => {
    const result = runGit({ cwd, args: ['config', '--get', key], ...executable });
    if (!result.ok) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  };
  const name = read('user.name');
  const email = read('user.email');
  return {
    name,
    email,
    complete: name !== null && email !== null,
    detail:
      name !== null && email !== null
        ? 'git has a configured commit identity'
        : 'git has no complete commit identity configured; a commit will fail unless one is supplied per invocation',
  };
}
