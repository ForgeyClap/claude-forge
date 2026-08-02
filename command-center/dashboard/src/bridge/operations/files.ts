/**
 * Forge Workspace — project file operations.
 *
 * `listProjectFiles`, `readProjectFile`, `getFileDiff`. Together they are the
 * project-scoped file picker: the only way the browser may look at anything on
 * the owner's disk, and therefore the place where being careless is expensive.
 *
 * FOUR RULES, and each one is enforced here rather than assumed of the caller.
 *
 * 1. EVERY PATH CROSSES `assertInsideRoot`, AND THE RETURNED PATH IS THE ONE
 *    OPENED. The string that arrived from the browser is never handed to `fs`.
 *    Containment is decided on the CANONICAL path, so a symlink or an NTFS
 *    junction that points out of the project is refused by resolution rather
 *    than by pattern-matching the name it was given.
 *
 * 2. LINKS ARE LISTED, NEVER FOLLOWED AND NEVER READ. A directory walk does not
 *    descend through a link — following one is how a bounded listing becomes an
 *    unbounded one, and how a cycle becomes a hang. `readProjectFile` refuses a
 *    link outright: the interesting case is precisely the one where the name
 *    inside the project and the bytes on disk belong to different files.
 *
 * 3. RESTRICTED FILES ARE NAMED, NOT HIDDEN — AND THEIR CONTENT IS REFUSED.
 *    `.git` internals, `.env*`, key material and credential-shaped names are
 *    flagged by `describeSensitivePath` and appear in a listing with the reason
 *    attached, because a picker that silently omits files lies about the
 *    project. Asking for their CONTENT fails with `PERMISSION_REQUIRED` and the
 *    exact sentence the contract fixes:
 *    "Restricted file — explicit owner approval required."
 *
 * 4. A DIFF IS A DIFF OR IT IS AN HONEST ABSENCE. `getFileDiff` never returns an
 *    empty patch to mean "we could not ask". No git, no repository, a repository
 *    that belongs to a parent folder, or no commit to diff against are four
 *    different facts, and each one is reported as itself.
 *
 * NOTHING HERE ACCEPTS A COMMAND. Git is reached only through the typed wrapper
 * in `../projects/git.ts`, which spawns an argv array with `shell: false`.
 *
 * ONE HONEST LIMIT. `assertInsideRoot` is a check, not a lock: between the check
 * and the `open` a link can be swapped in. Every read below acts immediately on
 * the canonical path the guard returned, which closes the realistic window;
 * Node exposes no O_NOFOLLOW-style handle dance on Windows that would close it
 * entirely.
 */

import { closeSync, lstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Dirent, Stats } from 'node:fs';

import type { ProjectRecord } from '../../shared/protocol.ts';

import { detectFromBytes } from '../attachments/detect.ts';
import { sanitiseForDisplay, scanForSecrets } from '../attachments/policy.ts';
import {
  diffAgainstHead,
  isAvailable as gitIsAvailable,
  isRepositoryRoot,
  lastCommit,
  runGit,
} from '../projects/git.ts';
import { ProjectRegistry } from '../projects/registry.ts';
import {
  assertInsideRoot,
  describeSensitivePath,
  isPathGuardError,
  RESTRICTED_FILE_MESSAGE,
  resolveProjectsRoot,
} from '../security/paths.ts';
import { asObject, fail, optInteger, optString, reqString } from '../router.ts';
import type { OperationContext, Router } from '../router.ts';
import type { ForgeStore } from '../storage/store.ts';

/* ========================================================================== */
/*  Limits                                                                     */
/* ========================================================================== */

/** A project-relative path longer than this is not a path, it is a payload. */
export const MAX_RELATIVE_PATH_LENGTH = 1_024;

export const DEFAULT_LIST_DEPTH = 1;
export const MAX_LIST_DEPTH = 4;
export const DEFAULT_LIST_LIMIT = 500;
export const MAX_LIST_LIMIT = 2_000;

/** Bytes of a project file returned by default, and the ceiling on that. */
export const DEFAULT_READ_BYTES = 1_048_576;
export const MAX_READ_BYTES = 4_194_304;

/* ========================================================================== */
/*  Project resolution — shared with the attachment operations                 */
/* ========================================================================== */

export interface ProjectContext {
  readonly record: ProjectRecord;
  /** The canonical path `assertInsideRoot` RETURNED. Never the stored string. */
  readonly root: string;
  readonly projectsRoot: string;
}

/**
 * Turn a project id into a directory the bridge is allowed to touch.
 *
 * Deliberately id-only: the projects root is never joined with a slug or a
 * name here. The registry stores where a project actually is, and a path
 * rebuilt from a display name points at where it USED to be — or at somebody
 * else's folder, once two names collapse onto one slug.
 *
 * The guard runs again on the stored path even though `register` already ran
 * it, because a record can be edited on disk between then and now.
 */
export function resolveProjectContext(store: ForgeStore, projectId: string): ProjectContext {
  const projectsRoot = resolveProjectsRoot();
  const registry = new ProjectRegistry(store, { projectsRoot });
  const found = registry.get(projectId);
  if (!found.ok) {
    fail(found.error.code, found.error.message, found.error.detail);
  }
  const record = found.value;

  let root: string;
  try {
    root = assertInsideRoot(record.canonicalPath, projectsRoot);
  } catch (error) {
    if (isPathGuardError(error)) {
      fail(
        error.code,
        `The recorded location of project "${record.displayName}" no longer resolves inside the projects root, so nothing may be read from it.`,
        error.detail,
      );
    }
    fail('PATH_REJECTED', 'The project path could not be validated.', errorMessage(error));
  }

  const present = directoryStat(root);
  if (present === null) {
    fail(
      'NOT_FOUND',
      `The directory for project "${record.displayName}" is not present on disk, so its files cannot be listed or read.`,
      `expected a directory at the recorded canonical path`,
    );
  }

  return { record, root, projectsRoot };
}

function directoryStat(candidate: string): Stats | null {
  try {
    const stat = statSync(candidate);
    return stat.isDirectory() ? stat : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ========================================================================== */
/*  Path handling                                                              */
/* ========================================================================== */

/** Display-oriented, forward-slashed, and never used to rebuild a real path. */
function toProjectRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  if (rel.length === 0) return '.';
  return rel.split('\\').join('/');
}

/**
 * Validate the caller's relative path BEFORE it becomes part of a real one.
 *
 * `assertInsideRoot` would catch an escape on its own. These checks run first
 * so the refusal names what was actually wrong with the request, rather than
 * reporting every malformed input as a containment failure.
 */
function requireRelativePath(raw: string | undefined, key: string): string {
  if (raw === undefined || raw.length === 0 || raw === '.' || raw === './') return '.';
  if (raw.length > MAX_RELATIVE_PATH_LENGTH) {
    fail('BAD_REQUEST', `${key} exceeds ${MAX_RELATIVE_PATH_LENGTH} characters.`);
  }
  if (/^[A-Za-z]:/.test(raw)) {
    fail('PATH_REJECTED', `${key} must be relative to the project, not a drive path.`);
  }
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    fail('PATH_REJECTED', `${key} must be relative to the project, not an absolute path.`);
  }
  for (const segment of raw.split(/[\\/]+/)) {
    if (segment === '..') fail('PATH_REJECTED', `${key} may not contain a dot-dot segment.`);
  }
  return raw;
}

/** Join a validated relative path onto the project root and re-prove it. */
function resolveInsideProject(context: ProjectContext, relativePath: string): string {
  try {
    return relativePath === '.'
      ? context.root
      : assertInsideRoot(join(context.root, relativePath), context.root);
  } catch (error) {
    if (isPathGuardError(error)) fail(error.code, error.message, error.detail);
    fail('PATH_REJECTED', 'That path could not be validated against the project root.', errorMessage(error));
  }
}

/* ========================================================================== */
/*  listProjectFiles                                                           */
/* ========================================================================== */

export type ProjectFileKind = 'file' | 'directory' | 'symlink' | 'other';

export interface ProjectFileEntry {
  readonly name: string;
  /** Project-relative, forward-slashed. This is what the client sends back. */
  readonly path: string;
  readonly kind: ProjectFileKind;
  /** Null for anything that is not a regular file. */
  readonly size: number | null;
  readonly modifiedAt: string | null;
  readonly hidden: boolean;
  readonly restricted: boolean;
  readonly restrictedReasons: readonly string[];
  /** False whenever `readProjectFile` would refuse this entry, with the reason. */
  readonly contentReadable: boolean;
  readonly note: string | null;
}

export interface ListProjectFilesResult {
  readonly projectId: string;
  readonly root: string;
  readonly path: string;
  readonly depth: number;
  readonly entries: readonly ProjectFileEntry[];
  readonly entryCount: number;
  /** True when the entry cap stopped the walk. The listing is then INCOMPLETE. */
  readonly truncated: boolean;
  /** Directories that were listed but deliberately not descended into, and why. */
  readonly notDescended: readonly { readonly path: string; readonly reason: string }[];
  /** Directories that could not be read at all. Never silently dropped. */
  readonly unreadable: readonly { readonly path: string; readonly detail: string }[];
  readonly restrictedMessage: string;
}

function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

function safeIso(value: Date): string | null {
  const ms = value.getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function listProjectFiles(payload: unknown, ctx: OperationContext): ListProjectFilesResult {
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const requested = requireRelativePath(optString(body, 'path', MAX_RELATIVE_PATH_LENGTH), 'path');
  const depth = optInteger(body, 'depth', 1, MAX_LIST_DEPTH) ?? DEFAULT_LIST_DEPTH;
  const limit = optInteger(body, 'limit', 1, MAX_LIST_LIMIT) ?? DEFAULT_LIST_LIMIT;
  const includeHidden = body.includeHidden === undefined ? true : body.includeHidden === true;

  const context = resolveProjectContext(ctx.store, projectId);
  const start = resolveInsideProject(context, requested);
  if (directoryStat(start) === null) {
    fail('NOT_FOUND', 'That path is not a directory inside the project.', toProjectRelative(context.root, start));
  }

  const entries: ProjectFileEntry[] = [];
  const notDescended: { path: string; reason: string }[] = [];
  const unreadable: { path: string; detail: string }[] = [];
  let truncated = false;

  const walk = (dir: string, remaining: number): void => {
    if (truncated) return;

    let dirents: readonly Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      unreadable.push({ path: toProjectRelative(context.root, dir), detail: errorMessage(error) });
      return;
    }

    const sorted = [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const descendInto: string[] = [];

    for (const dirent of sorted) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      const name = dirent.name;
      const hidden = isHiddenName(name);
      if (hidden && !includeHidden) continue;

      const childAbsolute = join(dir, name);
      const childRelative = toProjectRelative(context.root, childAbsolute);
      const sensitivity = describeSensitivePath(childRelative);

      // A link is described from its own entry, never by resolving through it.
      if (dirent.isSymbolicLink()) {
        let escapes = true;
        try {
          assertInsideRoot(childAbsolute, context.root);
          escapes = false;
        } catch {
          escapes = true;
        }
        entries.push({
          name,
          path: childRelative,
          kind: 'symlink',
          size: null,
          modifiedAt: null,
          hidden,
          restricted: sensitivity.sensitive,
          restrictedReasons: sensitivity.reasons,
          contentReadable: false,
          note: escapes
            ? 'A link whose target resolves outside the project. It is listed so you know it exists; it is never followed or read.'
            : 'A link. Forge lists it but never follows or reads it, because the name inside the project and the bytes it points at are two different things.',
        });
        continue;
      }

      if (dirent.isDirectory()) {
        entries.push({
          name,
          path: childRelative,
          kind: 'directory',
          size: null,
          modifiedAt: null,
          hidden,
          restricted: sensitivity.sensitive,
          restrictedReasons: sensitivity.reasons,
          contentReadable: false,
          note: sensitivity.sensitive ? RESTRICTED_FILE_MESSAGE : null,
        });
        if (remaining > 1) {
          if (sensitivity.sensitive) {
            notDescended.push({
              path: childRelative,
              reason: `restricted directory — ${sensitivity.reasons.join('; ')}`,
            });
          } else {
            descendInto.push(childAbsolute);
          }
        } else {
          notDescended.push({ path: childRelative, reason: 'the requested depth stops here' });
        }
        continue;
      }

      if (!dirent.isFile()) {
        entries.push({
          name,
          path: childRelative,
          kind: 'other',
          size: null,
          modifiedAt: null,
          hidden,
          restricted: sensitivity.sensitive,
          restrictedReasons: sensitivity.reasons,
          contentReadable: false,
          note: 'Not a regular file, a directory or a link — it is a device, socket or pipe, and is never opened.',
        });
        continue;
      }

      let size: number | null = null;
      let modifiedAt: string | null = null;
      try {
        const stat = lstatSync(childAbsolute);
        size = stat.size;
        modifiedAt = safeIso(stat.mtime);
      } catch {
        // The file vanished between the directory read and the stat. Listed
        // with unknown size rather than dropped: it was really there a moment
        // ago, and pretending otherwise loses information.
        size = null;
        modifiedAt = null;
      }

      entries.push({
        name,
        path: childRelative,
        kind: 'file',
        size,
        modifiedAt,
        hidden,
        restricted: sensitivity.sensitive,
        restrictedReasons: sensitivity.reasons,
        contentReadable: !sensitivity.sensitive,
        note: sensitivity.sensitive ? RESTRICTED_FILE_MESSAGE : null,
      });
    }

    for (const child of descendInto) {
      if (truncated) return;
      walk(child, remaining - 1);
    }
  };

  walk(start, depth);

  return {
    projectId,
    root: context.root,
    path: toProjectRelative(context.root, start),
    depth,
    entries,
    entryCount: entries.length,
    truncated,
    notDescended,
    unreadable,
    restrictedMessage: RESTRICTED_FILE_MESSAGE,
  };
}

/* ========================================================================== */
/*  readProjectFile                                                            */
/* ========================================================================== */

export interface ReadProjectFileResult {
  readonly projectId: string;
  readonly path: string;
  readonly canonicalPath: string;
  readonly size: number;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly modifiedAt: string | null;
  readonly detectedFormat: string;
  readonly detectedMediaType: string | null;
  readonly detectionConfidence: string;
  /** True when the bytes are not text; `content` is then null, never guessed. */
  readonly binary: boolean;
  readonly content: string | null;
  /** What was done to the text before returning it. Null when there is no text. */
  readonly sanitisation: string | null;
  /** Credential patterns found. Never contains the matched text. */
  readonly secretFindings: readonly { readonly rule: string; readonly line: number; readonly description: string }[];
  readonly notes: readonly string[];
}

/** Read at most `max` bytes without pulling a huge file into memory. */
function readLeadingBytes(path: string, max: number): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(max);
    const read = readSync(fd, buffer, 0, max, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function readProjectFile(payload: unknown, ctx: OperationContext): ReadProjectFileResult {
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const requested = requireRelativePath(reqString(body, 'path', MAX_RELATIVE_PATH_LENGTH), 'path');
  if (requested === '.') fail('BAD_REQUEST', 'path must name a file, not the project root.');
  const maxBytes = optInteger(body, 'maxBytes', 1, MAX_READ_BYTES) ?? DEFAULT_READ_BYTES;

  const context = resolveProjectContext(ctx.store, projectId);
  const canonical = resolveInsideProject(context, requested);
  const relativePath = toProjectRelative(context.root, canonical);

  // The restriction check runs on the path BEFORE anything is opened. A refusal
  // that happens after the read has already happened is not a refusal.
  const sensitivity = describeSensitivePath(relativePath);
  if (sensitivity.sensitive) {
    fail('PERMISSION_REQUIRED', RESTRICTED_FILE_MESSAGE, sensitivity.reasons.join('; '));
  }

  let stat: Stats;
  try {
    // lstat, not stat: stat would report a link as whatever it points at, which
    // is exactly the case being refused two lines below.
    stat = lstatSync(canonical);
  } catch (error) {
    fail('NOT_FOUND', 'That file is not present in the project.', errorMessage(error));
  }
  if (stat.isSymbolicLink()) {
    fail(
      'PATH_REJECTED',
      'That entry is a link, and Forge never reads through one. Open the file it points at directly if it is inside this project.',
    );
  }
  if (stat.isDirectory()) fail('BAD_REQUEST', 'That path is a directory, not a file.');
  if (!stat.isFile()) {
    fail('BAD_REQUEST', 'That path is not a regular file, so it is never opened.');
  }

  const cap = Math.min(maxBytes, MAX_READ_BYTES);
  let bytes: Uint8Array;
  try {
    bytes = readLeadingBytes(canonical, cap);
  } catch (error) {
    fail('RUNTIME_ERROR', 'That file could not be read.', errorMessage(error));
  }

  const truncated = stat.size > bytes.length;
  const detection = detectFromBytes(bytes);
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `The file is ${stat.size} bytes; the first ${bytes.length} were returned. Everything past that is UNKNOWN — including whether it holds credentials.`,
    );
  }

  if (!detection.textLike) {
    notes.push(
      `The bytes identify as ${detection.format}, which is not text, so no content is returned. Nothing is decoded or rendered.`,
    );
    return {
      projectId,
      path: relativePath,
      canonicalPath: canonical,
      size: stat.size,
      bytesRead: bytes.length,
      truncated,
      modifiedAt: safeIso(stat.mtime),
      detectedFormat: detection.format,
      detectedMediaType: detection.mediaType,
      detectionConfidence: detection.confidence,
      binary: true,
      content: null,
      sanitisation: null,
      secretFindings: [],
      notes: [...notes, ...detection.notes],
    };
  }

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // A file body must never be able to repaint the operator's screen, and an
  // invisible direction override must never be able to make a line read as
  // something it is not.
  const content = sanitiseForDisplay(decoded);
  const secretFindings = scanForSecrets(content);
  if (secretFindings.length > 0) {
    notes.push(
      `This file matches ${secretFindings.length} credential pattern(s). The matched text is deliberately not recorded anywhere — only the rule and the line number.`,
    );
  }

  return {
    projectId,
    path: relativePath,
    canonicalPath: canonical,
    size: stat.size,
    bytesRead: bytes.length,
    truncated,
    modifiedAt: safeIso(stat.mtime),
    detectedFormat: detection.format,
    detectedMediaType: detection.mediaType,
    detectionConfidence: detection.confidence,
    binary: false,
    content,
    sanitisation: 'terminal escape sequences and invisible/direction-overriding characters removed',
    secretFindings,
    notes: [...notes, ...detection.notes],
  };
}

/* ========================================================================== */
/*  getFileDiff                                                                */
/* ========================================================================== */

/**
 * Why a diff could not be produced. Each value is a different fact about the
 * project, and none of them is "no changes".
 */
export type DiffUnavailableReason =
  | 'GIT_NOT_FOUND'
  | 'NOT_A_REPOSITORY'
  | 'FOREIGN_REPOSITORY'
  | 'NO_COMMITS'
  | 'GIT_FAILED';

export interface FileDiffUnavailable {
  readonly available: false;
  readonly projectId: string;
  readonly path: string | null;
  readonly reason: DiffUnavailableReason;
  /** A sentence fit to show a person. Says what is true, not what is missing. */
  readonly message: string;
  readonly detail: string;
}

export interface FileDiffResult {
  readonly available: true;
  readonly projectId: string;
  readonly path: string | null;
  readonly base: 'HEAD';
  readonly headCommit: { readonly sha: string; readonly shortSha: string; readonly committedAt: string; readonly subject: string };
  readonly patch: string;
  readonly patchTruncated: boolean;
  /** Parsed out of the patch's own `diff --git` headers. */
  readonly changedFiles: readonly string[];
  /**
   * Untracked files. They are NOT part of a diff against HEAD — git has nothing
   * to compare them to — so they are reported separately rather than being
   * absent from a patch that would then read as "nothing new here".
   */
  readonly untrackedFiles: readonly string[];
  readonly untrackedKnown: boolean;
  /** True when the patch is non-empty OR untracked files are present. */
  readonly hasChanges: boolean;
  readonly notes: readonly string[];
}

/** `diff --git a/x b/y` → the b-side path. Derived from the patch, not guessed. */
function changedFilesFromPatch(patch: string): readonly string[] {
  const files: string[] = [];
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match?.[2] !== undefined) files.push(match[2]);
  }
  return [...new Set(files)];
}

/** `status --porcelain=v1 -z` entries whose code is `??`. */
function untrackedFromPorcelain(stdout: string): readonly string[] {
  const out: string[] = [];
  const fields = stdout.split('\u0000');
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === undefined || field.length === 0) continue;
    const code = field.slice(0, 2);
    if (code.startsWith('R') || code.startsWith('C')) i += 1;
    if (code === '??') out.push(field.slice(3));
  }
  return out;
}

function getFileDiff(payload: unknown, ctx: OperationContext): FileDiffResult | FileDiffUnavailable {
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const rawPath = optString(body, 'path', MAX_RELATIVE_PATH_LENGTH);
  const contextLines = optInteger(body, 'contextLines', 0, 100) ?? 3;
  const maxChars = optInteger(body, 'maxChars', 1_024, 1_048_576);

  const context = resolveProjectContext(ctx.store, projectId);

  // A pathspec is still a path: it goes through the guard so a caller cannot
  // ask git about a file outside the project, and the pathspec handed to git is
  // derived from the CANONICAL result rather than from the original string.
  let pathspec: string | undefined;
  let displayPath: string | null = null;
  if (rawPath !== undefined && rawPath.length > 0 && rawPath !== '.') {
    const validated = requireRelativePath(rawPath, 'path');
    const canonical = resolveInsideProject(context, validated);
    displayPath = toProjectRelative(context.root, canonical);
    if (displayPath === '.') {
      pathspec = undefined;
      displayPath = null;
    } else {
      pathspec = displayPath;
    }
  }

  const unavailable = (reason: DiffUnavailableReason, message: string, detail: string): FileDiffUnavailable => ({
    available: false,
    projectId,
    path: displayPath,
    reason,
    message,
    detail,
  });

  // 1. Is there a git that actually RUNS? `isAvailable` executes `git version`
  //    and reads its exit code; a file at a plausible path proves nothing.
  const availability = gitIsAvailable();
  if (!availability.available) {
    return unavailable(
      'GIT_NOT_FOUND',
      'No working git was found on this machine, so no diff could be produced. This is not a statement that the project has no changes — it is a statement that nothing could be compared.',
      availability.detail,
    );
  }
  const executablePath = availability.executablePath ?? undefined;
  const withExecutable = executablePath === undefined ? {} : { executablePath };

  // 2. Is this directory the top of its OWN work tree? A project nested inside
  //    someone else's repository must not be shown that repository's changes.
  const repository = isRepositoryRoot(context.root, withExecutable);
  if (!repository.isRepositoryRoot) {
    return repository.insideForeignRepository
      ? unavailable(
          'FOREIGN_REPOSITORY',
          'This project folder is not its own git repository — it sits inside a different one. Showing that repository\'s changes here would attribute another project\'s work to this one, so no diff is offered.',
          repository.detail,
        )
      : unavailable(
          'NOT_A_REPOSITORY',
          'This project is not under git, so there is no committed state to compare against. Every file in it is simply the only version there has ever been.',
          repository.detail,
        );
  }

  // 3. Is there a HEAD to diff against?
  const head = lastCommit(context.root, withExecutable);
  if (!head.ok) {
    return unavailable('GIT_FAILED', 'Git could not report this repository\'s HEAD, so no diff could be produced.', head.detail);
  }
  if (head.commit === null) {
    return unavailable(
      'NO_COMMITS',
      'This repository has no commits yet, so there is no HEAD to diff against. Nothing here has ever been committed — which is different from nothing having changed.',
      head.detail,
    );
  }

  // 4. The diff itself.
  const diff = diffAgainstHead(context.root, {
    ...(pathspec !== undefined ? { pathspec } : {}),
    contextLines,
    ...(maxChars !== undefined ? { maxChars } : {}),
    ...withExecutable,
  });
  if (!diff.ok) {
    return unavailable('GIT_FAILED', 'Git refused to produce a diff for this project.', diff.detail);
  }

  // 5. Untracked files, read separately, because `git diff HEAD` cannot see them.
  const statusCommand = runGit({
    cwd: context.root,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    ...withExecutable,
  });
  const untrackedKnown = statusCommand.ok;
  const allUntracked = untrackedKnown ? untrackedFromPorcelain(statusCommand.stdout) : [];
  const untrackedFiles =
    pathspec === undefined
      ? allUntracked
      : allUntracked.filter((file) => file === pathspec || file.startsWith(`${pathspec}/`));

  const notes: string[] = [];
  if (diff.truncated) {
    notes.push('The patch was longer than the requested limit and is CUT OFF. What is shown is not the whole change.');
  }
  if (!untrackedKnown) {
    notes.push(
      `Untracked files could not be listed (${statusCommand.failure ?? `git status exited ${String(statusCommand.exitCode)}`}), so whether this project has new files is UNKNOWN.`,
    );
  } else if (untrackedFiles.length > 0) {
    notes.push(
      `${untrackedFiles.length} untracked file(s) are listed separately: git has nothing to compare a never-committed file against, so they cannot appear in the patch.`,
    );
  }
  if (diff.patch.length === 0 && untrackedFiles.length === 0 && untrackedKnown) {
    notes.push('git diff HEAD exited zero with no output and no untracked files were found: this project matches its last commit.');
  }

  return {
    available: true,
    projectId,
    path: displayPath,
    base: 'HEAD',
    headCommit: head.commit,
    patch: diff.patch,
    patchTruncated: diff.truncated,
    changedFiles: changedFilesFromPatch(diff.patch),
    untrackedFiles,
    untrackedKnown,
    hasChanges: diff.patch.length > 0 || untrackedFiles.length > 0,
    notes,
  };
}

/* ========================================================================== */
/*  Registration                                                               */
/* ========================================================================== */

/** Attach the three file operations to a router. Called from `router.ts`. */
export function registerFileOperations(router: Router): void {
  router.register('listProjectFiles', (payload, ctx) => listProjectFiles(payload, ctx));
  router.register('readProjectFile', (payload, ctx) => readProjectFile(payload, ctx));
  router.register('getFileDiff', (payload, ctx) => getFileDiff(payload, ctx));
}
