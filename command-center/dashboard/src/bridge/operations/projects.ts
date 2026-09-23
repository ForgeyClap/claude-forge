/**
 * Forge Workspace — the project operations.
 *
 * Six contract verbs live here: `listProjects`, `createProject`, `openProject`,
 * `importProject`, `archiveProject` and `getProjectHealth`. This file is wiring,
 * not new machinery: the creation flow is `projects/create.ts`, the canonical
 * index is `projects/registry.ts`, the path boundary is `security/paths.ts` and
 * git is `projects/git.ts`. Nothing below re-implements any of them, and nothing
 * below is allowed to be more confident than they are.
 *
 * FIVE RULES THIS FILE HOLDS.
 *
 * 1. VALIDATE, THEN ACT. Every payload is parsed field by field into typed
 *    values before a single file is touched. Two validations exist purely to
 *    protect the receipt: `initialBranch` and `gitAuthor` are checked against the
 *    same rules `projects/git.ts` enforces, because that module THROWS a
 *    `GitPolicyError` for a bad value and the throw would escape `createProject`
 *    and destroy the record of the ten steps that had already succeeded. A typed
 *    BAD_REQUEST before the flow starts is strictly better than a lost receipt.
 *
 * 2. EVERY PATH CROSSES THE GUARD. Not one path in this file is assembled from a
 *    display name or a slug. Project locations come from the registry's stored
 *    `canonicalPath` and are re-checked with `assertInsideRoot`, whose RETURN
 *    value is what gets used — never the string that was passed in. The file
 *    counter re-guards every directory it descends into and never follows a
 *    symbolic link.
 *
 * 3. THE RECEIPT IS THE RESULT. `createProject` returns the real
 *    `CreationReceipt` for all three outcomes — CREATED, INCOMPLETE and FAILED —
 *    because the receipt is the only artefact that can say "steps 1..9 succeeded,
 *    step 10 failed with this exact error". Collapsing that into a thrown error
 *    would throw away the evidence, so the transport-level `ok` means only "the
 *    flow ran and here is what happened"; `created` and `outcome` in the body are
 *    the claim about the project, and `created` is true for CREATED alone.
 *
 * 4. IMPORT NEVER OVERWRITES. `importProject` inspects before it touches
 *    anything, refuses a path outside the trusted root, and by default writes
 *    NOTHING into the folder it adopts. `.claude/` is never modified — not
 *    merged, not scaffolded. An existing `CLAUDE.md` is only ever safe-merged,
 *    on explicit request, through `mergeClaudeMd`, which preserves every byte
 *    outside the Forge markers and refuses outright to rewrite a file it could
 *    not read. Anything it will not do is reported as a conflict, not swallowed.
 *
 * 5. HEALTH IS EARNED. `getProjectHealth` runs the real doctor, reads real git
 *    through the wrapper and counts real files. MISSING is written when the
 *    canonical path no longer resolves. Nothing here computes a score, and the
 *    project state machine is consulted before health is written — including its
 *    refusal of a self-transition, which is why re-confirming a verdict goes
 *    through UNKNOWN rather than silently rewriting the same value.
 *
 * Archiving is a flag on a record. It deletes nothing from disk, and this file
 * has no delete path at all: removing a user's folder is owner-approval
 * territory and lives nowhere in this module.
 */

import { readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

import type {
  EvidenceRef,
  GitState,
  OperationErrorCode,
  ProjectHealthState,
  ProjectRecord,
} from '../../shared/protocol.ts';
import { assertProjectTransition } from '../../shared/state-machines.ts';

import { createProject as runCreationFlow, mergeClaudeMd, runProjectDoctor } from '../projects/create.ts';
import type { CreateProjectResult, DoctorReport } from '../projects/create.ts';
import {
  discoverProjects,
  looksLikeForgeProject,
  PROJECT_MARKER_SCHEMA_VERSION,
  projectMarkerPath,
  readForgeMetadata,
  readProjectMarker,
  writeProjectMarker,
} from '../projects/discover.ts';
import type { DiscoveryReport, ForgeProjectMetadata } from '../projects/discover.ts';
import { status as readGitStatus } from '../projects/git.ts';
import { KNOWN_PROJECT_TYPES, ProjectRegistry, UNKNOWN_PROJECT_TYPE } from '../projects/registry.ts';
import type { RegistryError } from '../projects/registry.ts';
import {
  assertInsideRoot,
  ensureProjectsRoot,
  exceedsWindowsMaxPath,
  inspectSlug,
  isPathGuardError,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PATH_LENGTH,
  resolveProjectsRootInfo,
  WINDOWS_MAX_PATH,
} from '../security/paths.ts';
import type { ProjectsRootInfo, ProjectsRootSource } from '../security/paths.ts';
import { AuditLedger, asObject, fail, OperationFailure, optString, reqString } from '../router.ts';
import type { AuditEntry, OperationContext, Router } from '../router.ts';
import { directoryExists, fileExists } from '../storage/atomic.ts';
import type { ForgeStore } from '../storage/store.ts';

/* ========================================================================== */
/*  Limits                                                                     */
/* ========================================================================== */

/** A goal or description longer than this is a document, not a field. */
export const MAX_DESCRIPTION_LENGTH = 2_000;

/** Git identity fields. Matches what a commit trailer can sensibly hold. */
export const MAX_GIT_IDENTITY_LENGTH = 128;

/**
 * Bounds on the health scan. They exist so a project containing `node_modules`
 * cannot turn a health check into a minute-long walk of a hundred thousand
 * files. Every bound that bites is reported: `complete: false` plus the reason,
 * never a smaller number presented as the whole truth.
 */
export const FILE_SCAN_MAX_ENTRIES = 20_000;
export const FILE_SCAN_MAX_DIRECTORIES = 2_000;
export const FILE_SCAN_MAX_DEPTH = 12;

/** Cap on how many per-directory problems are itemised in one report. */
const MAX_REPORTED_SCAN_PROBLEMS = 20;

/**
 * Mirrors the branch-name rule in `projects/git.ts`.
 *
 * Duplicated deliberately rather than imported: `git.init` THROWS for a name it
 * refuses, and that throw would escape the creation flow and take the receipt
 * with it. Checking here turns the same refusal into a typed BAD_REQUEST before
 * any directory exists.
 */
const INITIAL_BRANCH_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/* ========================================================================== */
/*  Small shared helpers                                                       */
/* ========================================================================== */

const ALL_OPERATION_ERROR_CODES: readonly OperationErrorCode[] = [
  'BAD_REQUEST',
  'UNKNOWN_OPERATION',
  'SCHEMA_MISMATCH',
  'NOT_FOUND',
  'CONFLICT',
  'PATH_REJECTED',
  'OUTSIDE_TRUSTED_ROOT',
  'PERMISSION_REQUIRED',
  'PERMISSION_DENIED',
  'INVALID_STATE',
  'ATTACHMENT_NOT_READY',
  'ATTACHMENT_REJECTED',
  'QUOTA_EXCEEDED',
  'CLAUDE_UNAVAILABLE',
  'CLAUDE_UNAUTHENTICATED',
  'RUNTIME_ERROR',
  'CANCELLED',
  'TIMEOUT',
];

const OPERATION_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ALL_OPERATION_ERROR_CODES);

/**
 * Narrow a free-form code onto the contract union, or `null`.
 *
 * `CreationStepError.code` is a plain string because a step can fail for a
 * path-guard reason, a registry reason or a runtime reason. Writing an unchecked
 * string into an audit line's `errorCode` would put vocabulary in the ledger
 * that the contract does not define.
 */
function asOperationErrorCode(value: string | undefined | null): OperationErrorCode | null {
  return typeof value === 'string' && OPERATION_ERROR_CODE_SET.has(value) ? (value as OperationErrorCode) : null;
}

/**
 * Strip control characters and cap length.
 *
 * Used for everything that reaches the audit ledger or an error `detail`. A
 * newline inside a value that is serialised into a JSONL ledger is how a forged
 * audit line gets written, and an unbounded string is how a log becomes a disk
 * problem.
 */
function ledgerSafe(value: unknown, maxLength = 128): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const cleaned = value.replace(new RegExp(CONTROL_CHARS.source, 'g'), '');
  if (cleaned.length === 0) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function safeDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return ledgerSafe(raw, 300) ?? 'no detail available';
}

/** NTFS is case-insensitive, so two paths differing only in case are one path. */
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Display-oriented, forward-slashed, and never used to rebuild a real path. */
function relativeLabel(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative.length === 0 ? '.' : relative.split('\\').join('/');
}

/**
 * Turn anything at all into the one exception type the router understands.
 *
 * Path-guard errors keep their own code — PATH_REJECTED and
 * OUTSIDE_TRUSTED_ROOT say different things to a user, and collapsing both into
 * RUNTIME_ERROR would lose the distinction that matters most.
 */
function toFailure(error: unknown, what: string): OperationFailure {
  if (error instanceof OperationFailure) return error;
  if (isPathGuardError(error)) return new OperationFailure(error.toOperationError());
  return new OperationFailure({
    code: 'RUNTIME_ERROR',
    message: `The ${what} operation failed.`,
    detail: safeDetail(error),
  });
}

/** A registry refusal, converted verbatim. Its codes are already contract codes. */
function registryFailure(error: RegistryError): OperationFailure {
  return new OperationFailure(
    error.detail === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, detail: ledgerSafe(error.detail, 300) ?? error.detail.slice(0, 300) },
  );
}

/* ========================================================================== */
/*  Payload validation                                                         */
/* ========================================================================== */

function optBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') fail('BAD_REQUEST', `${key} must be true or false.`);
  return value;
}

/**
 * A project type the rest of the system can route on.
 *
 * Rejected rather than silently normalised: `registry.normaliseType` would turn
 * an unknown value into `unknown`, and a caller that asked for `website` and got
 * `unknown` back without being told has been quietly overruled.
 */
function optProjectType(obj: Record<string, unknown>): string | undefined {
  const value = optString(obj, 'type', 64);
  if (value === undefined) return undefined;
  const normalised = value.trim().toLowerCase();
  if (normalised.length === 0) return undefined;
  if (!KNOWN_PROJECT_TYPES.includes(normalised)) {
    fail('BAD_REQUEST', `type must be one of: ${KNOWN_PROJECT_TYPES.join(', ')}.`, `received ${normalised.slice(0, 40)}`);
  }
  return normalised;
}

function optInitialBranch(obj: Record<string, unknown>): string | undefined {
  const value = optString(obj, 'initialBranch', 101);
  if (value === undefined) return undefined;
  if (!INITIAL_BRANCH_SHAPE.test(value)) {
    fail(
      'BAD_REQUEST',
      'initialBranch must start with a letter or digit and may contain only letters, digits, dot, dash, underscore and slash.',
    );
  }
  return value;
}

export interface ValidatedGitAuthor {
  readonly name: string;
  readonly email: string;
}

/**
 * The commit identity, checked against what the git wrapper will accept.
 *
 * `git.commit` passes these as `-c user.name=` / `-c user.email=` and throws a
 * `GitPolicyError` for an empty value or a control character. Same reason as the
 * branch name: catching it here keeps the receipt alive.
 */
function optGitAuthor(obj: Record<string, unknown>): ValidatedGitAuthor | undefined {
  const raw = obj.gitAuthor;
  if (raw === undefined || raw === null) return undefined;
  const author = asObject(raw, 'gitAuthor');
  const name = reqString(author, 'name', MAX_GIT_IDENTITY_LENGTH);
  const email = reqString(author, 'email', MAX_GIT_IDENTITY_LENGTH);
  if (CONTROL_CHARS.test(name) || CONTROL_CHARS.test(email)) {
    fail('BAD_REQUEST', 'gitAuthor.name and gitAuthor.email may not contain control characters.');
  }
  if (name.trim().length === 0 || email.trim().length === 0) {
    fail('BAD_REQUEST', 'gitAuthor.name and gitAuthor.email may not be blank.');
  }
  return { name, email };
}

/* ========================================================================== */
/*  Dependencies                                                               */
/* ========================================================================== */

/**
 * The registry and the ledger are cached per store rather than rebuilt per
 * request — but the projects root is RE-RESOLVED every time, because a user can
 * create, move or lose their Documents folder while the bridge runs and a cached
 * root would then be a false statement about their machine. A root that changed
 * rebuilds the registry rather than being papered over.
 */
const REGISTRY_CACHE = new WeakMap<ForgeStore, { root: string; registry: ProjectRegistry }>();
const LEDGER_CACHE = new WeakMap<ForgeStore, AuditLedger>();

function registryFor(store: ForgeStore, projectsRoot: string): ProjectRegistry {
  const cached = REGISTRY_CACHE.get(store);
  if (cached !== undefined && samePath(cached.root, projectsRoot)) return cached.registry;
  const registry = new ProjectRegistry(store, { projectsRoot });
  REGISTRY_CACHE.set(store, { root: projectsRoot, registry });
  return registry;
}

function ledgerFor(store: ForgeStore): AuditLedger {
  const cached = LEDGER_CACHE.get(store);
  if (cached !== undefined) return cached;
  const ledger = new AuditLedger(store.dataDir);
  LEDGER_CACHE.set(store, ledger);
  return ledger;
}

interface ProjectDeps {
  readonly store: ForgeStore;
  readonly registry: ProjectRegistry;
  readonly ledger: AuditLedger;
  readonly rootInfo: ProjectsRootInfo;
  readonly projectsRoot: string;
}

function projectDeps(ctx: OperationContext, projectsRootOverride?: string): ProjectDeps {
  const rootInfo = resolveProjectsRootInfo();
  const projectsRoot = projectsRootOverride ?? rootInfo.projectsRoot;
  return {
    store: ctx.store,
    registry: registryFor(ctx.store, projectsRoot),
    ledger: ledgerFor(ctx.store),
    rootInfo,
    projectsRoot,
  };
}

/* ========================================================================== */
/*  Audit                                                                      */
/* ========================================================================== */

/**
 * What the ledger write actually did.
 *
 * `written: false` is a real outcome — a full disk means the line is gone — and
 * it is returned to the caller rather than assumed. The router writes its own
 * line per dispatch; these entries add what the router cannot see: the project
 * id that RESULTED from the operation, and the sub-steps (root creation, the
 * creation flow's own verdict) that a single dispatch line would hide.
 */
export interface AuditOutcome {
  readonly step: string;
  readonly outcome: AuditEntry['outcome'];
  readonly errorCode: OperationErrorCode | null;
  readonly written: boolean;
}

function recordAudit(
  ctx: OperationContext,
  ledger: AuditLedger,
  input: {
    readonly step: string;
    readonly outcome: AuditEntry['outcome'];
    readonly errorCode: OperationErrorCode | null;
    readonly projectId: string | null;
    readonly startedAt: number;
  },
): AuditOutcome {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    bridgeInstanceId: ledgerSafe(ctx.bridgeInstanceId) ?? 'unknown',
    requestId: ledgerSafe(ctx.requestId) ?? 'unknown',
    op: ledgerSafe(`${ctx.op}:${input.step}`, 64) ?? ctx.op,
    projectId: ledgerSafe(input.projectId),
    clientId: ledgerSafe(ctx.clientId),
    transport: ctx.transport,
    outcome: input.outcome,
    errorCode: input.errorCode,
    durationMs: Date.now() - input.startedAt,
  };
  // `append` never throws: a ledger failure must not fail the operation it is
  // recording. It returns false, and that false is passed on rather than hidden.
  return { step: input.step, outcome: input.outcome, errorCode: input.errorCode, written: ledger.append(entry) };
}

/* ========================================================================== */
/*  Observations                                                               */
/* ========================================================================== */

export interface PresenceReport {
  readonly present: boolean;
  readonly detail: string;
  readonly observedAt: string;
}

/** Is there a directory at this exact path, right now? Observed, never assumed. */
function inspectPresence(target: string): PresenceReport {
  const observedAt = new Date().toISOString();
  try {
    const stat = statSync(target);
    return stat.isDirectory()
      ? { present: true, detail: 'the recorded path is a directory', observedAt }
      : { present: false, detail: 'the recorded path exists but is not a directory', observedAt };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return {
      present: false,
      detail:
        code === 'ENOENT'
          ? 'nothing exists at the recorded path'
          : `the recorded path could not be inspected (${code ?? 'unknown error'})`,
      observedAt,
    };
  }
}

export interface FileCountReport {
  readonly files: number;
  readonly directories: number;
  readonly symbolicLinksNotFollowed: number;
  readonly otherEntries: number;
  readonly entriesSeen: number;
  readonly directoriesRead: number;
  readonly deepestDepthReached: number;
  /** True only when every directory under the project was read to the end. */
  readonly complete: boolean;
  readonly limits: {
    readonly maxEntries: number;
    readonly maxDirectories: number;
    readonly maxDepth: number;
  };
  readonly unreadable: readonly { readonly path: string; readonly detail: string }[];
  readonly rejected: readonly { readonly path: string; readonly code: string; readonly message: string }[];
  readonly durationMs: number;
  readonly scannedAt: string;
}

/**
 * Count what is really in a project directory.
 *
 * Breadth-first, so a truncated scan describes the top of the tree rather than
 * one arbitrary deep branch. Three properties are load-bearing:
 *
 *  - every directory is re-checked with `assertInsideRoot` against the project
 *    itself and the guard's RETURN value is what gets read;
 *  - symbolic links are counted and never followed, so no link can walk the
 *    scan out of the project;
 *  - hitting any limit sets `complete: false`. A capped count is never presented
 *    as a total.
 */
function countProjectFiles(projectRoot: string): FileCountReport {
  const scannedAt = new Date().toISOString();
  const startedMs = Date.now();

  let files = 0;
  let directories = 0;
  let links = 0;
  let other = 0;
  let entriesSeen = 0;
  let directoriesRead = 0;
  let deepest = 0;
  let complete = true;

  const unreadable: { path: string; detail: string }[] = [];
  const rejected: { path: string; code: string; message: string }[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: projectRoot, depth: 0 }];

  while (queue.length > 0) {
    if (directoriesRead >= FILE_SCAN_MAX_DIRECTORIES || entriesSeen >= FILE_SCAN_MAX_ENTRIES) {
      complete = false;
      break;
    }
    const next = queue.shift();
    if (next === undefined) break;

    let safeDir: string;
    try {
      safeDir = assertInsideRoot(next.dir, projectRoot);
    } catch (error) {
      complete = false;
      if (isPathGuardError(error)) {
        if (rejected.length < MAX_REPORTED_SCAN_PROBLEMS) {
          rejected.push({ path: relativeLabel(projectRoot, next.dir), code: error.code, message: error.message });
        }
      } else if (unreadable.length < MAX_REPORTED_SCAN_PROBLEMS) {
        unreadable.push({ path: relativeLabel(projectRoot, next.dir), detail: safeDetail(error) });
      }
      continue;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(safeDir, { withFileTypes: true, encoding: 'utf8' });
    } catch (error) {
      complete = false;
      if (unreadable.length < MAX_REPORTED_SCAN_PROBLEMS) {
        unreadable.push({ path: relativeLabel(projectRoot, safeDir), detail: safeDetail(error) });
      }
      continue;
    }

    directoriesRead += 1;
    if (next.depth > deepest) deepest = next.depth;

    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > FILE_SCAN_MAX_ENTRIES) {
        complete = false;
        break;
      }
      if (entry.isSymbolicLink()) {
        links += 1;
        continue;
      }
      if (entry.isDirectory()) {
        directories += 1;
        if (next.depth + 1 <= FILE_SCAN_MAX_DEPTH) {
          queue.push({ dir: path.join(safeDir, entry.name), depth: next.depth + 1 });
        } else {
          complete = false;
        }
        continue;
      }
      if (entry.isFile()) {
        files += 1;
        continue;
      }
      other += 1;
    }
  }

  return {
    files,
    directories,
    symbolicLinksNotFollowed: links,
    otherEntries: other,
    entriesSeen,
    directoriesRead,
    deepestDepthReached: deepest,
    complete,
    limits: {
      maxEntries: FILE_SCAN_MAX_ENTRIES,
      maxDirectories: FILE_SCAN_MAX_DIRECTORIES,
      maxDepth: FILE_SCAN_MAX_DEPTH,
    },
    unreadable,
    rejected,
    durationMs: Date.now() - startedMs,
    scannedAt,
  };
}

export interface GitCommandSummary {
  readonly args: readonly string[];
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly failure: string | null;
}

export interface GitReading {
  /** False when git never ran at all — then `state` says nothing about the project. */
  readonly established: boolean;
  readonly state: GitState | null;
  readonly undetermined: readonly string[];
  readonly detached: boolean;
  readonly insideForeignRepository: boolean;
  readonly detail: string;
  readonly commands: readonly GitCommandSummary[];
  readonly evidenceRefs: readonly EvidenceRef[];
}

/**
 * Read git for a directory through the wrapper.
 *
 * `stdout` and `stderr` are deliberately NOT carried out of here. They can hold
 * file contents, branch names from another repository and, in an error message,
 * a remote URL with an embedded credential. The exit codes are the evidence and
 * they are what gets kept.
 *
 * `established: false` means git never ran — no executable, or the process could
 * not start. In that case the `GitState` is null rather than a zeroed record,
 * because an all-false state is indistinguishable from a real empty repository.
 */
function readGit(directory: string): GitReading {
  const result = readGitStatus(directory);
  const commands: GitCommandSummary[] = result.commands.map((command) => ({
    args: command.args,
    ok: command.ok,
    exitCode: command.exitCode,
    timedOut: command.timedOut,
    durationMs: command.durationMs,
    failure: command.failure === null ? null : (ledgerSafe(command.failure, 200) ?? 'unreportable failure'),
  }));
  const evidenceRefs: readonly EvidenceRef[] = result.commands.map((command) => ({
    kind: 'exit-code' as const,
    ref: command.exitCode === null ? 'none' : String(command.exitCode),
    note: `git ${command.args.join(' ')}`,
  }));

  const first = result.commands[0];
  const established = first !== undefined && !(first.failure !== null && first.exitCode === null);

  return {
    established,
    state: established ? result.state : null,
    undetermined: result.undetermined,
    detached: result.detached,
    insideForeignRepository: result.insideForeignRepository,
    detail: established ? result.detail : (first?.failure ?? 'git did not run, so nothing about git was established'),
    commands,
    evidenceRefs,
  };
}

/* ========================================================================== */
/*  Health persistence                                                         */
/* ========================================================================== */

export interface HealthWriteReport {
  readonly from: ProjectHealthState;
  readonly to: ProjectHealthState;
  readonly persisted: boolean;
  /**
   * True when the verdict was unchanged and had to be re-established through
   * UNKNOWN. The project machine models no self-transition on purpose: "still
   * healthy" is a fresh claim and must be written as one.
   */
  readonly reasserted: boolean;
  readonly detail: string;
}

function persistHealth(
  registry: ProjectRegistry,
  record: ProjectRecord,
  to: ProjectHealthState,
  summary: string,
  evidenceRefs: readonly EvidenceRef[],
): { readonly report: HealthWriteReport; readonly record: ProjectRecord } {
  const from = record.health;

  if (from === to && to === 'UNKNOWN') {
    // UNKNOWN asserts nothing, so re-writing it would churn the record and emit
    // an event for a claim that was never made.
    return {
      report: {
        from,
        to,
        persisted: false,
        reasserted: false,
        detail: 'health was UNKNOWN before and after the check; UNKNOWN asserts nothing, so the record was not rewritten',
      },
      record,
    };
  }

  const steps: ProjectHealthState[] = from === to ? ['UNKNOWN', to] : [to];
  let current = record;
  let reasserted = from === to;

  for (let i = 0; i < steps.length; i += 1) {
    const target = steps[i];
    if (target === undefined) continue;
    try {
      assertProjectTransition(current.health, target);
    } catch (error) {
      return {
        report: {
          from,
          to,
          persisted: false,
          reasserted: false,
          detail: `the project state machine refused ${current.health} -> ${target}: ${safeDetail(error)}`,
        },
        record: current,
      };
    }
    // The intermediate UNKNOWN carries no evidence on purpose: passing a summary
    // there would briefly overwrite `lastDoctorResult` with a sentence about a
    // check that had not finished.
    const isFinalStep = i === steps.length - 1;
    const applied = registry.setHealth(
      current.id,
      target,
      isFinalStep ? { summary, evidenceRefs } : null,
    );
    if (!applied.ok) {
      return {
        report: {
          from,
          to,
          persisted: false,
          reasserted,
          detail: `the check ran but its verdict could not be stored: ${applied.error.message}`,
        },
        record: current,
      };
    }
    current = applied.value;
  }

  if (from !== to) reasserted = false;
  return {
    report: {
      from,
      to,
      persisted: true,
      reasserted,
      detail: reasserted
        ? `health was re-established as ${to} through UNKNOWN, because the project machine models no self-transition`
        : `health moved ${from} -> ${to}`,
    },
    record: current,
  };
}

/* ========================================================================== */
/*  listProjects                                                               */
/* ========================================================================== */

export interface ProjectListEntry {
  readonly project: ProjectRecord;
  /** Observed at list time. `project.health` is what the last CHECK established. */
  readonly presentOnDisk: boolean;
  readonly presenceDetail: string;
}

export interface ListProjectsResult {
  readonly observedAt: string;
  readonly projectsRoot: string;
  readonly projectsRootExists: boolean;
  readonly projectsRootSource: ProjectsRootSource;
  readonly documentsDir: string;
  readonly documentsDirExists: boolean;
  readonly includeArchived: boolean;
  readonly count: number;
  readonly archivedCount: number;
  readonly projects: readonly ProjectListEntry[];
  /** Records that exist on disk and could not be read. Never silently dropped. */
  readonly unreadable: readonly { readonly id: string; readonly reason: string; readonly detail: string }[];
  readonly discovery: DiscoveryReport | null;
  readonly audit: AuditOutcome;
}

/**
 * Every project the registry knows, plus what is true about the root right now.
 *
 * `refresh` is opt-in. Discovery WRITES — it registers folders it finds and
 * marks vanished ones MISSING — and a read verb that mutates the index on every
 * call is a surprise nobody asked for. Left off, this operation reports the
 * index exactly as it stands and says, per project, whether the folder is
 * currently there.
 */
function listProjects(payload: unknown, ctx: OperationContext): ListProjectsResult {
  const startedAt = Date.now();
  const body = asObject(payload);
  const includeArchived = optBoolean(body, 'includeArchived') === true;
  const refresh = optBoolean(body, 'refresh') === true;
  const readGitState = optBoolean(body, 'readGitState') === true;
  const writeMissingMarkers = optBoolean(body, 'writeMissingMarkers') === true;

  const deps = projectDeps(ctx);
  try {
    const discovery = refresh
      ? discoverProjects(deps.registry, { readGitState, writeMissingMarkers })
      : null;

    const all = deps.registry.list({ includeArchived: true });
    const visible = includeArchived ? all.records : all.records.filter((record) => !record.archived);
    const projects: ProjectListEntry[] = visible.map((project) => {
      const presence = deps.registry.existsOnDisk(project);
      return { project, presentOnDisk: presence.present, presenceDetail: presence.detail };
    });

    const audit = recordAudit(ctx, deps.ledger, {
      step: refresh ? 'listed-after-refresh' : 'listed',
      outcome: 'OK',
      errorCode: null,
      projectId: null,
      startedAt,
    });

    return {
      observedAt: new Date().toISOString(),
      projectsRoot: deps.projectsRoot,
      projectsRootExists: directoryExists(deps.projectsRoot),
      projectsRootSource: deps.rootInfo.source,
      documentsDir: deps.rootInfo.documentsDir,
      documentsDirExists: deps.rootInfo.documentsDirExists,
      includeArchived,
      count: projects.length,
      archivedCount: all.records.filter((record) => record.archived).length,
      projects,
      unreadable: all.unreadable.map((entry) => ({ id: entry.id, reason: entry.reason, detail: entry.detail })),
      discovery,
      audit,
    };
  } catch (error) {
    const failure = toFailure(error, 'listProjects');
    recordAudit(ctx, deps.ledger, {
      step: 'failed',
      outcome: 'ERROR',
      errorCode: failure.error.code,
      projectId: null,
      startedAt,
    });
    throw failure;
  }
}

/* ========================================================================== */
/*  createProject                                                              */
/* ========================================================================== */

export interface ProjectsRootReport {
  readonly path: string;
  readonly existedBefore: boolean;
  readonly created: boolean;
  readonly source: ProjectsRootSource;
  readonly detail: string;
}

export interface CreateProjectResponse {
  /** True for CREATED alone. INCOMPLETE and FAILED are both `false`. */
  readonly created: boolean;
  readonly outcome: CreateProjectResult['outcome'];
  readonly project: ProjectRecord | null;
  readonly receipt: CreateProjectResult['receipt'];
  readonly receiptPaths: readonly string[];
  readonly error: CreateProjectResult['error'];
  readonly projectsRoot: ProjectsRootReport;
  readonly audit: AuditOutcome;
}

/**
 * The real New Project flow, wired to the contract.
 *
 * The projects root is created HERE rather than inside the flow, so that
 * bringing `Documents/ForgeProjects` into existence is one auditable act with
 * its own ledger line, instead of a side effect buried in step 3. The flow is
 * then called with `ensureRoot: false`, because by the time it runs the root
 * either exists or the caller explicitly said not to make one.
 *
 * The response carries the receipt for every outcome. `created` is the claim
 * about the project and it is true only for CREATED — a git failure lands on
 * INCOMPLETE, which is a project that exists and is registered but was NOT
 * fully created, and it is reported as exactly that.
 */
function createProjectOperation(payload: unknown, ctx: OperationContext): CreateProjectResponse {
  const startedAt = Date.now();
  const body = asObject(payload);

  const displayName = reqString(body, 'displayName', MAX_DISPLAY_NAME_LENGTH);
  const type = optProjectType(body);
  const description = optString(body, 'description', MAX_DESCRIPTION_LENGTH);
  const allowConfusable = optBoolean(body, 'allowConfusable') === true;
  const skipGit = optBoolean(body, 'skipGit') === true;
  const rollbackOnFailure = optBoolean(body, 'rollbackOnFailure') === true;
  const ensureRoot = optBoolean(body, 'ensureRoot') !== false;
  const initialBranch = optInitialBranch(body);
  const gitAuthor = optGitAuthor(body);

  const ledger = ledgerFor(ctx.store);
  const rootInfo = resolveProjectsRootInfo();
  const rootExistedBefore = directoryExists(rootInfo.projectsRoot);

  let projectsRoot = rootInfo.projectsRoot;
  let rootCreated = false;
  let rootSource = rootInfo.source;
  let rootDetail = 'the projects root already existed';

  if (!rootExistedBefore) {
    if (!ensureRoot) {
      rootDetail =
        'the projects root does not exist and ensureRoot was false, so nothing was created; the flow will fail at the mkdir step';
    } else {
      try {
        const ensured = ensureProjectsRoot();
        projectsRoot = ensured.projectsRoot;
        rootCreated = ensured.created;
        rootSource = ensured.source;
        rootDetail = ensured.created
          ? `the projects root was created at ${ensured.projectsRoot}`
          : 'the projects root appeared between the check and the create; it was adopted, not recreated';
        recordAudit(ctx, ledger, {
          step: 'ensureProjectsRoot',
          outcome: 'OK',
          errorCode: null,
          projectId: null,
          startedAt,
        });
      } catch (error) {
        const failure = toFailure(error, 'createProject');
        recordAudit(ctx, ledger, {
          step: 'ensureProjectsRoot',
          outcome: 'ERROR',
          errorCode: failure.error.code,
          projectId: null,
          startedAt,
        });
        throw failure;
      }
    }
  }

  const registry = registryFor(ctx.store, projectsRoot);
  const rootReport: ProjectsRootReport = {
    path: projectsRoot,
    existedBefore: rootExistedBefore,
    created: rootCreated,
    source: rootSource,
    detail: rootDetail,
  };

  let result: CreateProjectResult;
  try {
    result = runCreationFlow(registry, ctx.store, {
      displayName,
      ...(type !== undefined ? { type } : {}),
      ...(description !== undefined ? { description } : {}),
      allowConfusable,
      skipGit,
      rollbackOnFailure,
      // The root is this operation's responsibility, and it has already been
      // settled above. Letting the flow do it again would create it under a
      // second, unaudited code path.
      ensureRoot: false,
      ...(initialBranch !== undefined ? { initialBranch } : {}),
      ...(gitAuthor !== undefined ? { gitAuthor } : {}),
    });
  } catch (error) {
    // The flow is written not to throw; if it ever does, the failure is typed
    // rather than allowed to reach the socket as a dropped connection.
    const failure = toFailure(error, 'createProject');
    recordAudit(ctx, ledger, {
      step: 'flow-threw',
      outcome: 'ERROR',
      errorCode: failure.error.code,
      projectId: null,
      startedAt,
    });
    throw failure;
  }

  const audit = recordAudit(ctx, ledger, {
    step: result.outcome,
    outcome: result.outcome === 'CREATED' ? 'OK' : 'ERROR',
    errorCode: result.outcome === 'CREATED' ? null : (asOperationErrorCode(result.error?.code) ?? 'RUNTIME_ERROR'),
    projectId: result.project?.id ?? null,
    startedAt,
  });

  return {
    created: result.outcome === 'CREATED',
    outcome: result.outcome,
    project: result.project,
    receipt: result.receipt,
    receiptPaths: result.receiptPaths,
    error: result.error,
    projectsRoot: rootReport,
    audit,
  };
}

/* ========================================================================== */
/*  openProject                                                                */
/* ========================================================================== */

export interface MarkerReport {
  readonly path: string;
  readonly present: boolean;
  readonly readable: boolean;
  readonly reason: string | null;
  readonly projectId: string | null;
  readonly displayName: string | null;
  readonly slug: string | null;
  /** False when the marker names a DIFFERENT project than the record. */
  readonly matchesRecord: boolean | null;
}

export interface OpenProjectResult {
  readonly project: ProjectRecord;
  readonly canonicalPath: string;
  readonly openedAt: string;
  readonly archived: boolean;
  readonly presentOnDisk: boolean;
  readonly presenceDetail: string;
  /** What the LAST check established. This operation runs no health check. */
  readonly healthAsRecorded: ProjectHealthState;
  readonly healthCheckedNow: false;
  readonly lastDoctorResult: string | null;
  readonly metadata: ForgeProjectMetadata | null;
  readonly marker: MarkerReport;
  readonly claudeMdPresent: boolean;
  readonly claudeDirectoryPresent: boolean;
  readonly pathLength: number;
  readonly exceedsWindowsMaxPath: boolean;
  readonly windowsMaxPath: number;
  readonly git: GitReading | null;
  readonly gitRead: boolean;
  readonly notes: readonly string[];
  readonly audit: AuditOutcome;
}

/**
 * Open a project: resolve it by id and report what is actually there.
 *
 * It writes nothing — not the record, not the folder, not an event. There is no
 * `project.opened` in the contract's event vocabulary and inventing one would be
 * refused by the store, correctly: opening a project changes nothing about it.
 * The audit ledger is where "this was opened" belongs, and that is where it goes.
 *
 * The path comes from the registry and is re-proven with `assertInsideRoot`; the
 * guard's return value is what every read below uses.
 */
function openProject(payload: unknown, ctx: OperationContext): OpenProjectResult {
  const startedAt = Date.now();
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const wantGit = optBoolean(body, 'readGitState') === true;

  const deps = projectDeps(ctx);
  try {
    const found = deps.registry.get(projectId);
    if (!found.ok) throw registryFailure(found.error);
    const project = found.value;

    // Re-proven, not trusted. The record was written by this system, but a
    // symlink can be swapped under a folder between then and now.
    const canonicalPath = assertInsideRoot(project.canonicalPath, deps.projectsRoot);
    const presence = inspectPresence(canonicalPath);
    const notes: string[] = [];
    if (project.archived) notes.push('this project is archived; its record and its folder are both intact');
    if (!presence.present) {
      notes.push(
        'the folder is not at the recorded path right now — call getProjectHealth to record that observation against the project',
      );
    }

    const markerRead = presence.present ? readProjectMarker(canonicalPath) : null;
    const marker: MarkerReport = {
      path: projectMarkerPath(canonicalPath),
      present: markerRead !== null && (markerRead.ok || markerRead.reason !== 'MISSING'),
      readable: markerRead?.ok === true,
      reason: markerRead === null ? 'the folder is not present, so no marker could be read' : markerRead.ok ? null : markerRead.reason,
      projectId: markerRead?.ok === true ? markerRead.marker.projectId : null,
      displayName: markerRead?.ok === true ? markerRead.marker.displayName : null,
      slug: markerRead?.ok === true ? markerRead.marker.slug : null,
      matchesRecord: markerRead?.ok === true ? markerRead.marker.projectId === project.id : null,
    };
    if (marker.matchesRecord === false) {
      notes.push(
        `the marker in that folder names project ${marker.projectId ?? 'unknown'}, not ${project.id}; the record and the folder disagree`,
      );
    }

    const metadata = presence.present ? readForgeMetadata(canonicalPath) : null;
    const git = presence.present && wantGit ? readGit(canonicalPath) : null;
    if (wantGit && !presence.present) notes.push('git was not read because the folder is not present');

    const audit = recordAudit(ctx, deps.ledger, {
      step: presence.present ? 'opened' : 'opened-folder-absent',
      outcome: 'OK',
      errorCode: null,
      projectId: project.id,
      startedAt,
    });

    return {
      project,
      canonicalPath,
      openedAt: new Date().toISOString(),
      archived: project.archived,
      presentOnDisk: presence.present,
      presenceDetail: presence.detail,
      healthAsRecorded: project.health,
      healthCheckedNow: false,
      lastDoctorResult: project.lastDoctorResult,
      metadata,
      marker,
      claudeMdPresent: presence.present && fileExists(path.join(canonicalPath, 'CLAUDE.md')),
      claudeDirectoryPresent: presence.present && directoryExists(path.join(canonicalPath, '.claude')),
      pathLength: canonicalPath.length,
      exceedsWindowsMaxPath: exceedsWindowsMaxPath(canonicalPath),
      windowsMaxPath: WINDOWS_MAX_PATH,
      git,
      gitRead: git !== null,
      notes,
      audit,
    };
  } catch (error) {
    const failure = toFailure(error, 'openProject');
    recordAudit(ctx, deps.ledger, {
      step: 'failed',
      outcome: 'ERROR',
      errorCode: failure.error.code,
      projectId,
      startedAt,
    });
    throw failure;
  }
}

/* ========================================================================== */
/*  importProject                                                              */
/* ========================================================================== */

export interface ImportInspection {
  readonly canonicalPath: string;
  readonly isDirectory: boolean;
  readonly looksLikeForgeProject: boolean;
  readonly hasClaudeDirectory: boolean;
  readonly hasClaudeMd: boolean;
  readonly hasForgeDirectory: boolean;
  readonly hasGitignore: boolean;
  readonly marker: MarkerReport;
  readonly metadata: ForgeProjectMetadata;
  readonly pathLength: number;
  readonly exceedsWindowsMaxPath: boolean;
}

export interface ImportActions {
  /** Always one of the two "did not write" values. `.claude/` is never touched. */
  readonly claudeDirectory: 'left-untouched' | 'absent-and-not-created';
  readonly claudeMd:
    | {
        readonly requested: boolean;
        readonly performed: boolean;
        readonly mode: string | null;
        readonly originalHash: string | null;
        readonly resultHash: string | null;
        readonly originalPreserved: boolean | null;
        readonly detail: string;
      }
    | null;
  readonly marker: { readonly requested: boolean; readonly performed: boolean; readonly detail: string };
}

export interface ImportProjectResult {
  readonly imported: boolean;
  readonly project: ProjectRecord;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly slug: string;
  /** True when the folder's own marker id was re-adopted, keeping its history. */
  readonly reusedMarkerId: boolean;
  readonly inspection: ImportInspection;
  readonly git: GitReading;
  readonly actions: ImportActions;
  readonly conflicts: readonly string[];
  readonly notes: readonly string[];
  readonly audit: AuditOutcome;
}

/**
 * Adopt a folder that is already inside the trusted root.
 *
 * The order is the point: INSPECT, then decide, then register, then — only if
 * explicitly asked — write. Nothing in the imported folder is modified by
 * default. `.claude/` is never written to under any option, because a project
 * that already has one has agents, commands and memory in it that this operation
 * has no business merging. An existing `CLAUDE.md` is only ever safe-merged, and
 * one that cannot be read is left exactly as it is and reported as a conflict.
 *
 * A folder outside the projects root is refused rather than adopted. Importing
 * from anywhere on the disk would make the trusted root meaningless: every later
 * containment check in the system assumes projects live under it.
 */
function importProject(payload: unknown, ctx: OperationContext): ImportProjectResult {
  const startedAt = Date.now();
  const body = asObject(payload);
  const requestedPath = reqString(body, 'path', MAX_PATH_LENGTH);
  const requestedName = optString(body, 'displayName', MAX_DISPLAY_NAME_LENGTH);
  const type = optProjectType(body);
  const description = optString(body, 'description', MAX_DESCRIPTION_LENGTH);
  const allowConfusable = optBoolean(body, 'allowConfusable') === true;
  const wantMarker = optBoolean(body, 'writeMarker') === true;
  const wantClaudeMd = optBoolean(body, 'mergeClaudeMd') === true;

  const deps = projectDeps(ctx);
  try {
    if (!directoryExists(deps.projectsRoot)) {
      fail(
        'NOT_FOUND',
        'The projects root does not exist yet, so there is nothing inside it to import.',
        deps.projectsRoot,
      );
    }

    // THE boundary. A relative path is interpreted against the root, never the
    // process working directory, and the returned value is used from here on.
    const canonicalPath = assertInsideRoot(requestedPath, deps.projectsRoot);
    if (samePath(canonicalPath, deps.projectsRoot)) {
      fail('BAD_REQUEST', 'The projects root itself is not a project and cannot be imported.');
    }

    const presence = inspectPresence(canonicalPath);
    if (!presence.present) {
      fail('NOT_FOUND', `There is no directory to import at that path — ${presence.detail}.`, relativeLabel(deps.projectsRoot, canonicalPath));
    }

    /* ------------------------------------------------------------ inspect */
    const markerRead = readProjectMarker(canonicalPath);
    const metadata = readForgeMetadata(canonicalPath);
    const conflicts: string[] = [];
    const notes: string[] = [...metadata.notes];

    const marker: MarkerReport = {
      path: markerRead.markerPath,
      present: markerRead.ok || markerRead.reason !== 'MISSING',
      readable: markerRead.ok,
      reason: markerRead.ok ? null : markerRead.reason,
      projectId: markerRead.ok ? markerRead.marker.projectId : null,
      displayName: markerRead.ok ? markerRead.marker.displayName : null,
      slug: markerRead.ok ? markerRead.marker.slug : null,
      matchesRecord: null,
    };
    if (!markerRead.ok && markerRead.reason !== 'MISSING') {
      conflicts.push(`the folder has a .forge/project.json that could not be used (${markerRead.reason}): ${markerRead.detail}`);
    }

    const inspection: ImportInspection = {
      canonicalPath,
      isDirectory: true,
      looksLikeForgeProject: looksLikeForgeProject(metadata, markerRead.ok),
      hasClaudeDirectory: metadata.hasClaudeDirectory,
      hasClaudeMd: metadata.hasClaudeMd,
      hasForgeDirectory: metadata.hasForgeDirectory,
      hasGitignore: fileExists(path.join(canonicalPath, '.gitignore')),
      marker,
      metadata,
      pathLength: canonicalPath.length,
      exceedsWindowsMaxPath: exceedsWindowsMaxPath(canonicalPath),
    };
    if (!inspection.looksLikeForgeProject) {
      notes.push(
        'this folder carries no Forge metadata (.forge marker, .claude directory or CLAUDE.md); it was imported because it was named explicitly, not because it was recognised',
      );
    }
    if (inspection.exceedsWindowsMaxPath) {
      notes.push(
        `the path is ${canonicalPath.length} characters, beyond the ${WINDOWS_MAX_PATH}-character limit many Windows tools still enforce`,
      );
    }

    /* --------------------------------------------------- refuse duplicates */
    const occupant = deps.registry.findByCanonicalPath(canonicalPath);
    if (occupant !== null) {
      fail(
        'CONFLICT',
        `That folder is already registered as project "${occupant.displayName}".`,
        `existing project id ${occupant.id}`,
      );
    }
    const markerId = markerRead.ok ? markerRead.marker.projectId : null;
    if (markerId !== null && ctx.store.hasRecord('project', markerId)) {
      fail(
        'CONFLICT',
        'That folder carries the marker of a project that is already registered somewhere else.',
        `marker project id ${markerId}`,
      );
    }

    /* -------------------------------------------------- name, slug, checks */
    // Precedence: what the owner asked for, then what the folder says about
    // itself, then the folder name. Never a path fragment and never a guess.
    const displayName = requestedName ?? (markerRead.ok ? markerRead.marker.displayName : path.basename(canonicalPath));
    const nameInspection = inspectSlug(displayName);
    if (!nameInspection.ok) {
      fail('BAD_REQUEST', `That project name cannot be used: ${nameInspection.reason}`);
    }
    const folderInspection = inspectSlug(markerRead.ok ? markerRead.marker.slug : path.basename(canonicalPath));
    // The slug describes the folder that exists; the display name is what the
    // owner reads. They are allowed to differ, and the folder is never renamed.
    const slug = folderInspection.ok ? folderInspection.slug : nameInspection.slug;
    if (!folderInspection.ok) {
      notes.push(
        `the folder name could not be reduced to a slug (${folderInspection.reason}); the slug was taken from the display name instead. The folder itself was not renamed.`,
      );
    }

    const availability = deps.registry.checkAvailability({ displayName, canonicalPath });
    if (availability.hardBlock !== null) fail('CONFLICT', availability.hardBlock);
    if (availability.softBlock !== null && !allowConfusable) {
      fail('CONFLICT', `${availability.softBlock} Importing it anyway needs an explicit owner override.`);
    }
    if (availability.softBlock !== null) notes.push(`a look-alike name was accepted under an explicit override: ${availability.softBlock}`);

    /* ------------------------------------------------------------ real git */
    const git = readGit(canonicalPath);

    /* ----------------------------------------------------------- register */
    const registration = deps.registry.register({
      displayName,
      slug,
      canonicalPath,
      ...(markerId !== null ? { id: markerId } : {}),
      type: type ?? metadata.type ?? UNKNOWN_PROJECT_TYPE,
      description: description ?? metadata.description ?? '',
      forgeVersion: metadata.forgeVersion,
      templateVersion: metadata.templateVersion,
      ...(git.state !== null ? { git: git.state } : {}),
      origin: 'imported',
      allowConfusable,
    });
    if (!registration.ok) throw registryFailure(registration.error);
    const project = registration.value;
    notes.push(...registration.notes);
    if (!git.established) {
      notes.push('git could not be read for this folder, so the project record carries no git state yet');
    }

    /* ----------------------------------------- optional, non-destructive writes */
    let markerAction: ImportActions['marker'] = {
      requested: wantMarker,
      performed: false,
      detail: wantMarker
        ? 'a marker already exists in that folder and is never overwritten'
        : 'no marker was written; a later folder move cannot be followed without one',
    };
    if (wantMarker) {
      if (markerRead.ok) {
        markerAction = {
          requested: true,
          performed: false,
          detail: 'the folder already carries a valid marker; it was left exactly as it is',
        };
      } else if (markerRead.reason !== 'MISSING') {
        markerAction = {
          requested: true,
          performed: false,
          detail: `a .forge/project.json exists but could not be read (${markerRead.reason}); it was not overwritten`,
        };
        conflicts.push('the existing project marker could not be read, so no marker was written');
      } else {
        const write = writeProjectMarker(canonicalPath, {
          markerSchemaVersion: PROJECT_MARKER_SCHEMA_VERSION,
          projectId: project.id,
          slug: project.slug,
          displayName: project.displayName,
          createdAt: project.createdAt,
          createdBy: 'forge-bridge/import',
        });
        markerAction = {
          requested: true,
          performed: write.ok,
          detail: write.ok ? 'a marker was written so a later folder move can be followed' : write.detail,
        };
        if (!write.ok) conflicts.push(`the project marker could not be written: ${write.detail}`);
      }
    }

    let claudeMdAction: ImportActions['claudeMd'] = null;
    if (wantClaudeMd) {
      const merge = mergeClaudeMd(canonicalPath, {
        id: project.id,
        displayName: project.displayName,
        slug: project.slug,
        canonicalPath,
        createdAt: project.createdAt,
        type: project.type,
        description: project.description,
      });
      claudeMdAction = {
        requested: true,
        performed: merge.ok,
        mode: merge.mode,
        originalHash: merge.originalHash,
        resultHash: merge.resultHash,
        originalPreserved: merge.originalPreserved,
        detail: merge.detail,
      };
      if (!merge.ok) conflicts.push(`CLAUDE.md was left untouched: ${merge.detail}`);
      if (merge.ok && merge.originalPreserved === false) {
        conflicts.push(
          'the CLAUDE.md merge completed but the original content could not be proven intact; the previous content hash is in originalHash',
        );
      }
    } else if (metadata.hasClaudeMd) {
      claudeMdAction = {
        requested: false,
        performed: false,
        mode: null,
        originalHash: null,
        resultHash: null,
        originalPreserved: null,
        detail: 'an existing CLAUDE.md was found and left exactly as it is; pass mergeClaudeMd:true to add the Forge managed block',
      };
    }

    const audit = recordAudit(ctx, deps.ledger, {
      step: conflicts.length > 0 ? 'imported-with-conflicts' : 'imported',
      outcome: 'OK',
      errorCode: null,
      projectId: project.id,
      startedAt,
    });

    return {
      imported: true,
      project,
      canonicalPath,
      displayName,
      slug,
      reusedMarkerId: markerId !== null,
      inspection,
      git,
      actions: {
        claudeDirectory: metadata.hasClaudeDirectory ? 'left-untouched' : 'absent-and-not-created',
        claudeMd: claudeMdAction,
        marker: markerAction,
      },
      conflicts,
      notes,
      audit,
    };
  } catch (error) {
    const failure = toFailure(error, 'importProject');
    recordAudit(ctx, deps.ledger, {
      step: 'failed',
      outcome: 'ERROR',
      errorCode: failure.error.code,
      projectId: null,
      startedAt,
    });
    throw failure;
  }
}

/* ========================================================================== */
/*  archiveProject                                                             */
/* ========================================================================== */

export interface ArchiveProjectResult {
  readonly project: ProjectRecord;
  readonly archived: true;
  readonly alreadyArchived: boolean;
  /** Always false. This operation has no delete path of any kind. */
  readonly deletedFromDisk: false;
  readonly canonicalPath: string;
  readonly stillOnDisk: boolean;
  readonly insideTrustedRoot: boolean;
  readonly notes: readonly string[];
  readonly audit: AuditOutcome;
}

/**
 * Archive a project: a flag on the record, and nothing else.
 *
 * The folder stays where it is, with every byte in it. Deleting a project's work
 * because a list got long is an owner decision that needs an explicit approval,
 * and it is deliberately not reachable from this operation — there is no branch
 * here that removes anything.
 */
function archiveProject(payload: unknown, ctx: OperationContext): ArchiveProjectResult {
  const startedAt = Date.now();
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');

  const deps = projectDeps(ctx);
  try {
    const found = deps.registry.get(projectId);
    if (!found.ok) throw registryFailure(found.error);
    const alreadyArchived = found.value.archived;

    const archived = deps.registry.archive(projectId);
    if (!archived.ok) throw registryFailure(archived.error);
    const project = archived.value;

    const presence = inspectPresence(project.canonicalPath);
    let insideTrustedRoot = false;
    try {
      assertInsideRoot(project.canonicalPath, deps.projectsRoot);
      insideTrustedRoot = true;
    } catch {
      // Reported, not fatal: a record whose folder has moved out of the root can
      // still be archived, and refusing to would strand it in the active list.
      insideTrustedRoot = false;
    }

    const notes: string[] = [
      'nothing was deleted; the project folder and every file in it are untouched',
      ...archived.notes,
    ];
    if (!presence.present) notes.push(`the folder is not at the recorded path — ${presence.detail}`);
    if (!insideTrustedRoot) notes.push('the recorded path no longer resolves inside the trusted projects root');

    const audit = recordAudit(ctx, deps.ledger, {
      step: alreadyArchived ? 'already-archived' : 'archived',
      outcome: 'OK',
      errorCode: null,
      projectId: project.id,
      startedAt,
    });

    return {
      project,
      archived: true,
      alreadyArchived,
      deletedFromDisk: false,
      canonicalPath: project.canonicalPath,
      stillOnDisk: presence.present,
      insideTrustedRoot,
      notes,
      audit,
    };
  } catch (error) {
    const failure = toFailure(error, 'archiveProject');
    recordAudit(ctx, deps.ledger, {
      step: 'failed',
      outcome: 'ERROR',
      errorCode: failure.error.code,
      projectId,
      startedAt,
    });
    throw failure;
  }
}

/* ========================================================================== */
/*  getProjectHealth                                                           */
/* ========================================================================== */

export interface GetProjectHealthResult {
  readonly projectId: string;
  readonly displayName: string;
  readonly canonicalPath: string;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly presentOnDisk: boolean;
  readonly presenceDetail: string;
  readonly health: ProjectHealthState;
  readonly previousHealth: ProjectHealthState;
  readonly healthWrite: HealthWriteReport;
  /** The doctor run that produced this verdict. Null when it could not run. */
  readonly doctor: DoctorReport | null;
  /** The summary stored by the PREVIOUS check, before this one replaced it. */
  readonly previousDoctorResult: string | null;
  readonly git: GitState | null;
  readonly gitEstablished: boolean;
  readonly gitDetail: string;
  readonly files: FileCountReport | null;
  readonly guard: { readonly ok: boolean; readonly code: string | null; readonly message: string | null };
  readonly project: ProjectRecord;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly notes: readonly string[];
  readonly audit: AuditOutcome;
}

/**
 * What can actually be established about a project right now.
 *
 * Three things are measured and none is inferred: the doctor's checks against
 * what is on disk, git through the wrapper (inside the doctor, from real exit
 * codes), and a bounded count of the files that are really there. The verdict is
 * the doctor's — PASS becomes HEALTHY, FAIL becomes DEGRADED, an undetermined
 * check becomes UNKNOWN — and there is no score, no percentage and no weighting
 * anywhere in this function.
 *
 * MISSING is written when the canonical path no longer resolves to a directory.
 * That is the one verdict this operation can reach without the doctor, because
 * the doctor has nothing to inspect.
 */
function getProjectHealth(payload: unknown, ctx: OperationContext): GetProjectHealthResult {
  const startedAt = Date.now();
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');

  const deps = projectDeps(ctx);
  try {
    const found = deps.registry.get(projectId);
    if (!found.ok) throw registryFailure(found.error);
    let project = found.value;
    const previousHealth = project.health;
    const previousDoctorResult = project.lastDoctorResult;
    const notes: string[] = [];
    const checkedAt = new Date().toISOString();

    /* ------------------------------------------------------------- guard */
    let canonicalPath: string;
    let guard: GetProjectHealthResult['guard'] = { ok: true, code: null, message: null };
    try {
      canonicalPath = assertInsideRoot(project.canonicalPath, deps.projectsRoot);
    } catch (error) {
      // A record pointing outside the trusted root is an integrity problem, not
      // a missing folder. It is recorded as ERROR, with the guard's own words.
      const message = isPathGuardError(error) ? error.message : safeDetail(error);
      const code = isPathGuardError(error) ? error.code : 'PATH_REJECTED';
      guard = { ok: false, code, message };
      const evidenceRefs: readonly EvidenceRef[] = [
        { kind: 'file', ref: `records/project/${project.id}.json`, note: 'the record whose path was refused' },
      ];
      const summary = `ERROR — the recorded project path did not survive the trusted-root check (${code}): ${message}`;
      const written = persistHealth(deps.registry, project, 'ERROR', summary, evidenceRefs);
      const audit = recordAudit(ctx, deps.ledger, {
        step: 'health-ERROR',
        outcome: 'OK',
        errorCode: null,
        projectId: project.id,
        startedAt,
      });
      return {
        projectId: project.id,
        displayName: project.displayName,
        canonicalPath: project.canonicalPath,
        checkedAt,
        durationMs: Date.now() - startedAt,
        presentOnDisk: false,
        presenceDetail: 'the path could not be checked because it did not pass the trusted-root guard',
        health: 'ERROR',
        previousHealth,
        healthWrite: written.report,
        doctor: null,
        previousDoctorResult,
        git: null,
        gitEstablished: false,
        gitDetail: 'git was not read: the project path was refused by the guard',
        files: null,
        guard,
        project: written.record,
        evidenceRefs,
        notes: [summary],
        audit,
      };
    }

    /* ---------------------------------------------------------- presence */
    const presence = inspectPresence(canonicalPath);
    if (!presence.present) {
      const evidenceRefs: readonly EvidenceRef[] = [
        { kind: 'file', ref: canonicalPath, note: presence.detail },
        { kind: 'file', ref: `records/project/${project.id}.json`, note: 'the record that still holds this project' },
      ];
      const summary = `MISSING — ${presence.detail} (checked ${checkedAt}). The record was kept.`;
      const written = persistHealth(deps.registry, project, 'MISSING', summary, evidenceRefs);
      const audit = recordAudit(ctx, deps.ledger, {
        step: 'health-MISSING',
        outcome: 'OK',
        errorCode: null,
        projectId: project.id,
        startedAt,
      });
      return {
        projectId: project.id,
        displayName: project.displayName,
        canonicalPath,
        checkedAt,
        durationMs: Date.now() - startedAt,
        presentOnDisk: false,
        presenceDetail: presence.detail,
        health: 'MISSING',
        previousHealth,
        healthWrite: written.report,
        doctor: null,
        previousDoctorResult,
        git: null,
        gitEstablished: false,
        gitDetail: 'git was not read: there is no directory at the recorded path',
        files: null,
        guard,
        project: written.record,
        evidenceRefs,
        notes: [
          'the record was kept. A folder can be absent because a drive is unmounted, because it is syncing, or because it was moved — none of which is a reason to delete the only thing that still knows this project’s id.',
        ],
        audit,
      };
    }

    /* ------------------------------------------------------------ doctor */
    const doctor = runProjectDoctor(canonicalPath, { projectId: project.id });
    const files = countProjectFiles(canonicalPath);
    if (!files.complete) {
      notes.push(
        `the file count is bounded: ${files.entriesSeen} entries across ${files.directoriesRead} directories were scanned, and the scan did not reach the end of the tree`,
      );
    }
    for (const problem of files.unreadable) notes.push(`could not read ${problem.path}: ${problem.detail}`);
    for (const problem of files.rejected) notes.push(`${problem.path} was refused by the path guard: ${problem.message}`);
    if (doctor.git === null) {
      notes.push('git state could not be established for this project; it is reported as null rather than as an empty repository');
    }

    const evidenceRefs: readonly EvidenceRef[] = [
      { kind: 'file', ref: canonicalPath, note: 'the directory the doctor inspected' },
      { kind: 'file', ref: `records/project/${project.id}.json`, note: 'the record this verdict was written to' },
      ...doctor.checks.flatMap((check) => check.evidenceRefs).slice(0, 8),
    ];

    const written = persistHealth(deps.registry, project, doctor.health, doctor.summary, evidenceRefs);
    project = written.record;
    if (!written.report.persisted) notes.push(written.report.detail);

    const audit = recordAudit(ctx, deps.ledger, {
      step: `health-${doctor.health}`,
      outcome: 'OK',
      errorCode: null,
      projectId: project.id,
      startedAt,
    });

    return {
      projectId: project.id,
      displayName: project.displayName,
      canonicalPath,
      checkedAt,
      durationMs: Date.now() - startedAt,
      presentOnDisk: true,
      presenceDetail: presence.detail,
      health: doctor.health,
      previousHealth,
      healthWrite: written.report,
      doctor,
      previousDoctorResult,
      git: doctor.git,
      gitEstablished: doctor.git !== null,
      gitDetail:
        doctor.git === null
          ? 'git did not answer, so no git state was recorded'
          : doctor.git.initialized
            ? `on branch ${doctor.git.branch ?? '(detached)'} with ${doctor.git.dirtyFiles} uncommitted change(s)`
            : 'this directory is not the top of its own git work tree',
      files,
      guard,
      project,
      evidenceRefs,
      notes,
      audit,
    };
  } catch (error) {
    const failure = toFailure(error, 'getProjectHealth');
    recordAudit(ctx, deps.ledger, {
      step: 'failed',
      outcome: 'ERROR',
      errorCode: failure.error.code,
      projectId,
      startedAt,
    });
    throw failure;
  }
}

/* ========================================================================== */
/*  Registration                                                               */
/* ========================================================================== */

/**
 * Attach the six project verbs to a router.
 *
 * Nothing else in the contract is claimed here. An operation this file does not
 * register keeps the router's honest "no handler is registered in this build"
 * answer, which is the whole reason that answer exists.
 */
export function registerProjectOperations(
  router: Router,
  options: { readonly override?: boolean } = {},
): void {
  const registerOptions = options.override === true ? { override: true } : undefined;
  router.register('listProjects', (payload, ctx) => listProjects(payload, ctx), registerOptions);
  router.register('createProject', (payload, ctx) => createProjectOperation(payload, ctx), registerOptions);
  router.register('openProject', (payload, ctx) => openProject(payload, ctx), registerOptions);
  router.register('importProject', (payload, ctx) => importProject(payload, ctx), registerOptions);
  router.register('archiveProject', (payload, ctx) => archiveProject(payload, ctx), registerOptions);
  router.register('getProjectHealth', (payload, ctx) => getProjectHealth(payload, ctx), registerOptions);
}

/** The operations this module owns. Used by tests and by the startup report. */
export const PROJECT_OPERATIONS = [
  'listProjects',
  'createProject',
  'openProject',
  'importProject',
  'archiveProject',
  'getProjectHealth',
] as const;
