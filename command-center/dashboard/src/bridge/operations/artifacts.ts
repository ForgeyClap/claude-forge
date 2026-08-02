/**
 * Forge Workspace — artifacts.
 *
 * An artifact is a file the workspace claims exists. This module's entire job is
 * to keep that claim true, which means it does exactly two things and refuses to
 * do a third.
 *
 * IT INDEXES WHAT IS REALLY THERE. Every entry is produced by stat-ing a real
 * path inside a real project, through `assertInsideRoot`, and recording what the
 * filesystem answered: canonical path, size, hash, created time, media type read
 * from the leading bytes. Provenance — the run, task or agent that produced it —
 * is copied from the record that claimed it and is otherwise `null`. A file
 * found by scanning an output directory says `provenance: DISCOVERED`, because
 * nobody told us who made it and guessing would put a name on a file that no
 * evidence connects to it.
 *
 * IT SERVES REAL BYTES. `inspectArtifact` opens the canonical path the guard
 * returned and returns what is in it: base64 of the actual image bytes, or the
 * actual decoded text. There is no placeholder, no generated thumbnail and no
 * "example" content anywhere in this file. If the bytes cannot be served —
 * missing, too large, or binary with no text form — the answer says so and
 * carries no content at all.
 *
 * IT NEVER INVENTS AN ARTIFACT. A record whose file is gone comes back as
 * `MISSING ARTIFACT` with state ORPHANED, keeping its last known size and hash
 * clearly labelled as last-known. It is never quietly dropped from the list
 * (that would make a broken build look clean) and never re-served from a cache
 * (that would make a deleted file look present).
 *
 * A NOTE ON THE STATE NAME. The brief asks for the status `MISSING ARTIFACT`.
 * `OperationalStatus` in protocol.ts has no such member, and inventing one would
 * break the honesty gate in `validateEvent`/`validateRecord` that exists to stop
 * exactly that. So each entry carries BOTH: `state`, which is the contract's
 * ARTIFACT_MACHINE value (`ORPHANED` — "referenced but not found"), and
 * `statusLabel`, which is the literal sentence the UI prints. Two fields, no
 * invented vocabulary, and the label is derived from the state rather than set
 * beside it.
 *
 * The relative `.ts` imports are deliberate: Node 24 executes TypeScript
 * directly and requires the explicit extension, and bridge code is permitted
 * relative imports.
 */

import { Buffer } from 'node:buffer';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { EvidenceRef, ProjectRecord } from '../../shared/protocol.ts';
import { assertArtifactTransition } from '../../shared/state-machines.ts';
import type { ArtifactState } from '../../shared/state-machines.ts';

import { detectFromBytes, mediaTypeForFormat } from '../attachments/detect.ts';
import type { DetectedFormat } from '../attachments/detect.ts';
import { ProjectRegistry } from '../projects/registry.ts';
import { asObject, fail, optInteger, optString, reqString } from '../router.ts';
import type { OperationContext, Router } from '../router.ts';
import { assertInsideRoot, describeSensitivePath, isPathGuardError, resolveProjectsRootInfo } from '../security/paths.ts';
import { sha256, sha256File } from '../storage/atomic.ts';
import type { ArtifactRecord } from '../storage/schema.ts';

import { checkApproval, ioFromContext, requestApproval } from './approvals.ts';
import type { ApprovalIo } from './approvals.ts';

/* ========================================================================== */
/*  Policy constants                                                           */
/* ========================================================================== */

/**
 * The directories a project is scanned for artifacts.
 *
 * Fixed in code, never taken from a payload: a client that could name a
 * directory could name `..\..\.ssh`, and the path guard would then be the only
 * thing standing between a list operation and the user's keys. These are the
 * conventional build/report output folders; anything outside them is indexed
 * only when a run explicitly recorded it as an artifact.
 */
export const ARTIFACT_SCAN_ROOTS: readonly string[] = [
  'artifacts',
  'dist',
  'playwright-report',
  'test-results',
  'docs/artifacts',
];

/** Directory names that are never descended into, at any depth. */
const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.forge-workspace',
  '.cache',
]);

export const MAX_SCAN_FILES = 2_000;
export const MAX_SCAN_DEPTH = 8;

/** Above this, a file is recorded with `hash: null` and said to be unhashed. */
export const MAX_HASH_BYTES = 64 * 1024 * 1024;

/** How many leading bytes the media-type sniff is allowed to read. */
const SNIFF_BYTES = 8_192;

export const DEFAULT_INSPECT_BYTES = 1024 * 1024;
export const MAX_INSPECT_BYTES = 4 * 1024 * 1024;
export const MIN_INSPECT_BYTES = 1_024;

/** The sentence the UI prints for a record whose file is gone. */
export const MISSING_ARTIFACT_LABEL = 'MISSING ARTIFACT';

const IMAGE_FORMATS: ReadonlySet<DetectedFormat> = new Set<DetectedFormat>([
  'png',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'ico',
  'avif-or-heif',
  'tiff',
]);

/** Formats a browser will actually render from a data URI. TIFF will not. */
const BROWSER_RENDERABLE_IMAGE_FORMATS: ReadonlySet<DetectedFormat> = new Set<DetectedFormat>([
  'png',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'ico',
  'avif-or-heif',
]);

const TEXT_SERVABLE_FORMATS: ReadonlySet<DetectedFormat> = new Set<DetectedFormat>([
  'text',
  'json',
  'xml',
  'html',
  'svg',
  'shebang-script',
]);

export interface ArtifactDeps {
  /** Overridable so a test can drive a temp projects root. */
  readonly projectsRoot?: string;
  readonly now?: () => Date;
}

/* ========================================================================== */
/*  Project resolution                                                         */
/* ========================================================================== */

interface ResolvedProject {
  readonly record: ProjectRecord;
  /** What `assertInsideRoot` RETURNED. Everything below uses this, not the record. */
  readonly canonicalPath: string;
  readonly exists: boolean;
  readonly detail: string;
}

/**
 * id -> canonical path, through the registry and then through the guard again.
 *
 * The registry already ran `assertInsideRoot` when the project was registered.
 * It is run again here because a check performed at another time is not a check
 * this call can see: a folder can be replaced by a junction between the two.
 */
function resolveProject(ctx: OperationContext, projectId: string, deps?: ArtifactDeps): ResolvedProject {
  const projectsRoot = deps?.projectsRoot ?? resolveProjectsRootInfo().projectsRoot;
  const registry = new ProjectRegistry(ctx.store, { projectsRoot });
  const found = registry.get(projectId);
  if (!found.ok) {
    fail(found.error.code, found.error.message, found.error.detail);
  }

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

/* ========================================================================== */
/*  Filesystem observation                                                     */
/* ========================================================================== */

type Presence = 'PRESENT' | 'MISSING' | 'NOT_A_FILE' | 'UNREADABLE';

interface FileObservation {
  readonly presence: Presence;
  readonly bytes: number | null;
  readonly createdAt: string | null;
  readonly modifiedAt: string | null;
  /** Which stat field `createdAt` came from — birthtime is not universal. */
  readonly createdAtSource: 'birthtime' | 'mtime' | null;
  readonly detail: string;
}

function observe(canonicalPath: string): FileObservation {
  let stat;
  try {
    stat = statSync(canonicalPath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    return {
      presence: code === 'ENOENT' || code === 'ENOTDIR' ? 'MISSING' : 'UNREADABLE',
      bytes: null,
      createdAt: null,
      modifiedAt: null,
      createdAtSource: null,
      detail:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? 'nothing exists at the recorded path'
          : `the path could not be inspected (${code ?? 'unknown error'})`,
    };
  }
  if (!stat.isFile()) {
    return {
      presence: 'NOT_A_FILE',
      bytes: null,
      createdAt: null,
      modifiedAt: null,
      createdAtSource: null,
      detail: 'the recorded path exists but is not a regular file',
    };
  }
  // birthtimeMs is 0 on filesystems that do not record it; falling back to mtime
  // and SAYING which one was used beats printing 1970 as a creation date.
  const hasBirth = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0;
  return {
    presence: 'PRESENT',
    bytes: stat.size,
    createdAt: new Date(hasBirth ? stat.birthtimeMs : stat.mtimeMs).toISOString(),
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
    createdAtSource: hasBirth ? 'birthtime' : 'mtime',
    detail: 'observed on disk',
  };
}

interface PrefixRead {
  readonly bytes: Uint8Array;
  readonly error: string | null;
}

/** Read at most `max` leading bytes. Never loads a large file to sniff it. */
function readPrefix(canonicalPath: string, max: number): PrefixRead {
  let fd: number | null = null;
  try {
    fd = openSync(canonicalPath, 'r');
    const buffer = Buffer.allocUnsafe(Math.max(0, max));
    const read = readSync(fd, buffer, 0, buffer.byteLength, 0);
    return { bytes: new Uint8Array(buffer.subarray(0, read)), error: null };
  } catch (error) {
    return { bytes: new Uint8Array(0), error: errorText(error) };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* the read already produced its answer; a close failure adds nothing */
      }
    }
  }
}

interface Sniff {
  readonly format: DetectedFormat;
  readonly mediaType: string | null;
  readonly confidence: string;
  readonly note: string;
}

function sniff(canonicalPath: string, bytes: number | null): Sniff {
  if (bytes === 0) {
    return { format: 'empty', mediaType: null, confidence: 'CERTAIN', note: 'the file is zero bytes long' };
  }
  const prefix = readPrefix(canonicalPath, SNIFF_BYTES);
  if (prefix.error !== null) {
    return {
      format: 'unknown-binary',
      mediaType: null,
      confidence: 'NONE',
      note: `the leading bytes could not be read (${prefix.error}); the media type is UNKNOWN`,
    };
  }
  const detection = detectFromBytes(prefix.bytes);
  const whole = bytes !== null && bytes <= SNIFF_BYTES;
  return {
    format: detection.format,
    mediaType: detection.mediaType,
    confidence: detection.confidence,
    note: whole
      ? 'derived from the whole file'
      : `derived from the leading ${SNIFF_BYTES} bytes; the rest of the file was not read`,
  };
}

/* ========================================================================== */
/*  Indexing                                                                   */
/* ========================================================================== */

/** Stable across scans, so re-indexing updates a record instead of duplicating it. */
export function artifactIdFor(projectId: string, relativePath: string): string {
  return `art-${sha256(`${projectId}|${relativePath.toLowerCase()}`).slice(0, 32)}`;
}

function toRelative(projectPath: string, canonicalPath: string): string {
  const rel = relative(projectPath, canonicalPath);
  return rel.length === 0 ? '.' : rel.split('\\').join('/');
}

interface ScanResult {
  readonly paths: readonly string[];
  readonly rootsPresent: readonly string[];
  readonly rootsAbsent: readonly string[];
  readonly truncated: boolean;
  readonly problems: readonly string[];
}

/**
 * Walk the fixed scan roots. Bounded in files and depth, symlinks are not
 * followed, and every path found is put through the guard before it is kept —
 * a junction planted inside `dist` must not be able to enumerate the disk.
 */
function scanProject(projectPath: string): ScanResult {
  const paths: string[] = [];
  const rootsPresent: string[] = [];
  const rootsAbsent: string[] = [];
  const problems: string[] = [];
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      problems.push(`${toRelative(projectPath, dir)} could not be listed (${errorText(error)})`);
      return;
    }
    for (const entry of entries) {
      if (paths.length >= MAX_SCAN_FILES) {
        truncated = true;
        return;
      }
      // A symlink is not followed. `assertInsideRoot` would catch one that
      // escapes, but not following it at all is cheaper and states the intent.
      if (entry.isSymbolicLink()) {
        problems.push(`${toRelative(projectPath, join(dir, entry.name))} is a link and was not followed`);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) continue;
        walk(join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        paths.push(assertInsideRoot(join(dir, entry.name), projectPath));
      } catch (error) {
        problems.push(`${entry.name} was rejected by the path guard (${errorText(error)})`);
      }
    }
  };

  for (const root of ARTIFACT_SCAN_ROOTS) {
    let rootPath: string;
    try {
      rootPath = assertInsideRoot(join(projectPath, ...root.split('/')), projectPath);
    } catch {
      rootsAbsent.push(root);
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(rootPath).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      rootsAbsent.push(root);
      continue;
    }
    rootsPresent.push(root);
    walk(rootPath, 1);
  }

  return { paths, rootsPresent, rootsAbsent, truncated, problems };
}

export interface IndexedArtifact {
  readonly record: ArtifactRecord;
  readonly state: ArtifactState;
  readonly statusLabel: string;
  readonly presence: Presence;
  readonly provenance: 'RECORDED' | 'DISCOVERED';
  readonly mediaTypeSource: string;
  readonly createdAtSource: string | null;
  readonly hashed: boolean;
  readonly hashChanged: boolean;
  readonly modifiedAt: string | null;
  readonly detail: string;
}

interface IndexReport {
  readonly artifacts: readonly IndexedArtifact[];
  readonly scan: ScanResult;
  readonly unreadableRecords: readonly { readonly id: string; readonly reason: string; readonly detail: string }[];
  readonly notes: readonly string[];
  readonly indexedEvents: number;
  readonly missingEvents: number;
}

/** The state a fresh observation justifies. Nothing here is optimistic. */
function stateFor(presence: Presence, hashed: boolean): ArtifactState {
  if (presence === 'PRESENT') return hashed ? 'COMPLETED' : 'DEGRADED';
  if (presence === 'MISSING') return 'ORPHANED';
  // NOT_A_FILE / UNREADABLE: the claim could not be checked at all.
  return 'FAILED';
}

function labelFor(state: ArtifactState, presence: Presence): string {
  if (state === 'ORPHANED') return MISSING_ARTIFACT_LABEL;
  if (state === 'FAILED') return presence === 'NOT_A_FILE' ? 'NOT A FILE' : 'UNREADABLE';
  if (state === 'DEGRADED') return 'PRESENT — UNVERIFIED HASH';
  return 'PRESENT — HASH VERIFIED';
}

/** The state a stored record implies, so the machine has a real `from`. */
function priorStateOf(record: ArtifactRecord | null): ArtifactState {
  if (record === null) return 'CREATED';
  if (!record.present) return 'ORPHANED';
  return record.hash === null ? 'DEGRADED' : 'COMPLETED';
}

function emitArtifactEvent(
  ctx: OperationContext,
  type: 'artifact.indexed' | 'artifact.missing',
  record: ArtifactRecord,
  eventId: string,
  payload: Record<string, unknown>,
  evidenceRefs: readonly EvidenceRef[],
  notes: string[],
): boolean {
  try {
    const result = ctx.events.publish({
      eventId,
      projectId: record.projectId,
      runId: record.runId,
      taskId: record.taskId,
      source: 'bridge',
      type,
      status: type === 'artifact.missing' ? 'ORPHANED' : undefined,
      payload,
      evidenceRefs,
    });
    return !result.deduplicated;
  } catch (error) {
    notes.push(`the artifact record was written, but the ${type} event could not be appended: ${errorText(error)}`);
    return false;
  }
}

/**
 * Re-check every recorded artifact and pick up anything new in the scan roots.
 *
 * The order matters: recorded artifacts first, so a file that a run claimed
 * keeps its provenance even when the scan would also have found it.
 */
function indexArtifacts(ctx: OperationContext, project: ResolvedProject, nowIso: string): IndexReport {
  const notes: string[] = [];
  const listed = ctx.store.listRecords('artifact');
  const stored = new Map<string, ArtifactRecord>();
  for (const record of listed.records) {
    if (record.projectId === project.record.id) stored.set(record.id, record);
  }

  const scan = project.exists
    ? scanProject(project.canonicalPath)
    : { paths: [], rootsPresent: [], rootsAbsent: ARTIFACT_SCAN_ROOTS, truncated: false, problems: [] };
  if (!project.exists) {
    notes.push(`the project directory was not scanned: ${project.detail}`);
  }
  notes.push(...scan.problems);

  const results: IndexedArtifact[] = [];
  const handled = new Set<string>();
  let indexedEvents = 0;
  let missingEvents = 0;

  const index = (
    id: string,
    canonicalCandidate: string | null,
    previous: ArtifactRecord | null,
    provenance: 'RECORDED' | 'DISCOVERED',
  ): void => {
    handled.add(id);

    // Guard first. A recorded path that no longer resolves inside the project is
    // not read, not hashed and not served — it is reported as FAILED.
    let canonicalPath: string | null = null;
    let guardDetail: string | null = null;
    if (canonicalCandidate !== null) {
      try {
        canonicalPath = assertInsideRoot(canonicalCandidate, project.canonicalPath);
      } catch (error) {
        guardDetail = `the recorded path was refused by the path guard: ${errorText(error)}`;
      }
    }

    const observation: FileObservation =
      canonicalPath === null
        ? {
            presence: 'UNREADABLE',
            bytes: null,
            createdAt: null,
            modifiedAt: null,
            createdAtSource: null,
            detail: guardDetail ?? 'no usable path was recorded for this artifact',
          }
        : observe(canonicalPath);

    const present = observation.presence === 'PRESENT';
    const hash =
      present && canonicalPath !== null && (observation.bytes ?? 0) <= MAX_HASH_BYTES
        ? sha256File(canonicalPath)
        : null;
    const hashed = hash !== null;
    const detection = present && canonicalPath !== null ? sniff(canonicalPath, observation.bytes) : null;

    const state = stateFor(observation.presence, hashed);
    const from = priorStateOf(previous);
    // Two real transitions, through the shared machine: nothing may be declared
    // present without passing through VERIFYING first.
    assertArtifactTransition(from, 'VERIFYING');
    assertArtifactTransition('VERIFYING', state);

    const effectivePath = canonicalPath ?? previous?.canonicalPath ?? canonicalCandidate ?? '';
    const relativePath =
      effectivePath.length > 0 ? toRelative(project.canonicalPath, effectivePath) : (previous?.relativePath ?? id);

    const record: ArtifactRecord = {
      id,
      projectId: project.record.id,
      runId: previous?.runId ?? null,
      taskId: previous?.taskId ?? null,
      kind: detection?.format ?? previous?.kind ?? 'unknown',
      name: relativePath.split('/').pop() ?? relativePath,
      relativePath,
      canonicalPath: effectivePath.length > 0 ? effectivePath : (previous?.canonicalPath ?? relativePath),
      // Last-known values are kept when the file is gone, and the entry says
      // plainly that they are last-known rather than current.
      bytes: present ? observation.bytes : (previous?.bytes ?? null),
      hash: present ? hash : (previous?.hash ?? null),
      mediaType: detection?.mediaType ?? previous?.mediaType ?? null,
      producedBy: previous?.producedBy ?? null,
      createdAt: observation.createdAt ?? previous?.createdAt ?? nowIso,
      indexedAt: nowIso,
      present,
      evidenceRefs: [
        { kind: 'file', ref: relativePath, note: `${observation.detail} at ${nowIso}` },
        ...(hash !== null ? [{ kind: 'file' as const, ref: relativePath, hash, note: 'sha256 of the bytes on disk' }] : []),
      ],
    };

    try {
      ctx.store.saveRecord('artifact', record);
    } catch (error) {
      notes.push(`artifact ${id} could not be persisted: ${errorText(error)}`);
    }

    const hashChanged =
      previous?.hash != null && hash !== null && previous.hash !== hash;

    if (present) {
      const changed =
        previous === null ||
        !previous.present ||
        previous.hash !== record.hash ||
        previous.bytes !== record.bytes;
      if (changed) {
        const eventId = `ai-${sha256(`${id}|${hash ?? 'unhashed'}|${String(record.bytes)}|${observation.modifiedAt ?? ''}`).slice(0, 32)}`;
        if (
          emitArtifactEvent(
            ctx,
            'artifact.indexed',
            record,
            eventId,
            {
              artifactId: id,
              relativePath,
              bytes: record.bytes,
              hash: record.hash,
              mediaType: record.mediaType,
              mediaTypeSource: detection?.note ?? 'not detected',
              provenance,
              state,
            },
            record.evidenceRefs,
            notes,
          )
        ) {
          indexedEvents += 1;
        }
      }
    } else if (previous !== null && previous.present) {
      // A real transition: it was there when we last looked and it is not now.
      const eventId = `am-${sha256(`${id}|${previous.indexedAt}|${nowIso}`).slice(0, 32)}`;
      if (
        emitArtifactEvent(
          ctx,
          'artifact.missing',
          record,
          eventId,
          {
            artifactId: id,
            relativePath,
            statusLabel: MISSING_ARTIFACT_LABEL,
            lastSeenAt: previous.indexedAt,
            lastKnownBytes: previous.bytes,
            lastKnownHash: previous.hash,
            detail: observation.detail,
          },
          [{ kind: 'file', ref: relativePath, note: observation.detail }],
          notes,
        )
      ) {
        missingEvents += 1;
      }
    }

    results.push({
      record,
      state,
      statusLabel: labelFor(state, observation.presence),
      presence: observation.presence,
      provenance,
      mediaTypeSource: detection?.note ?? 'the file was not read, so no media type was derived',
      createdAtSource: observation.createdAtSource,
      hashed,
      hashChanged,
      modifiedAt: observation.modifiedAt,
      detail:
        present && !hashed
          ? `${observation.detail}; not hashed (over the ${MAX_HASH_BYTES}-byte cap, or unreadable)`
          : observation.detail,
    });
  };

  for (const [id, record] of stored) {
    index(id, record.canonicalPath, record, record.runId !== null || record.taskId !== null || record.producedBy !== null ? 'RECORDED' : 'DISCOVERED');
  }

  for (const path of scan.paths) {
    const id = artifactIdFor(project.record.id, toRelative(project.canonicalPath, path));
    if (handled.has(id)) continue;
    index(id, path, stored.get(id) ?? null, 'DISCOVERED');
  }

  return {
    artifacts: results,
    scan,
    unreadableRecords: listed.unreadable.map((u) => ({ id: u.id, reason: u.reason, detail: u.detail })),
    notes,
    indexedEvents,
    missingEvents,
  };
}

/* ========================================================================== */
/*  Presentation                                                               */
/* ========================================================================== */

function describeArtifact(entry: IndexedArtifact): Record<string, unknown> {
  const r = entry.record;
  return {
    id: r.id,
    projectId: r.projectId,
    runId: r.runId,
    taskId: r.taskId,
    producedBy: r.producedBy,
    provenance: entry.provenance,
    name: r.name,
    relativePath: r.relativePath,
    canonicalPath: r.canonicalPath,
    kind: r.kind,
    mediaType: r.mediaType,
    mediaTypeSource: entry.mediaTypeSource,
    bytes: r.bytes,
    bytesAreCurrent: entry.presence === 'PRESENT',
    hash: r.hash,
    hashAlgorithm: r.hash === null ? null : 'sha256',
    hashIsCurrent: entry.hashed,
    hashChangedSinceLastIndex: entry.hashChanged,
    createdAt: r.createdAt,
    createdAtSource: entry.createdAtSource,
    modifiedAt: entry.modifiedAt,
    indexedAt: r.indexedAt,
    present: r.present,
    presence: entry.presence,
    state: entry.state,
    statusLabel: entry.statusLabel,
    detail: entry.detail,
    inspectable: entry.presence === 'PRESENT',
    evidenceRefs: r.evidenceRefs,
  };
}

/* ========================================================================== */
/*  listArtifacts                                                              */
/* ========================================================================== */

function listArtifacts(payload: unknown, ctx: OperationContext, deps?: ArtifactDeps): Record<string, unknown> {
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const runId = optString(body, 'runId');
  const taskId = optString(body, 'taskId');
  const limit = optInteger(body, 'limit', 1, MAX_SCAN_FILES) ?? MAX_SCAN_FILES;
  const includeMissing = body.includeMissing !== false;

  const now = deps?.now ?? (() => new Date());
  const project = resolveProject(ctx, projectId, deps);
  const report = indexArtifacts(ctx, project, now().toISOString());

  let entries = report.artifacts;
  if (runId !== undefined) entries = entries.filter((e) => e.record.runId === runId);
  if (taskId !== undefined) entries = entries.filter((e) => e.record.taskId === taskId);
  if (!includeMissing) entries = entries.filter((e) => e.presence === 'PRESENT');

  const sorted = [...entries].sort((a, b) =>
    a.record.relativePath < b.record.relativePath ? -1 : a.record.relativePath > b.record.relativePath ? 1 : 0,
  );
  const page = sorted.slice(0, limit);

  return {
    projectId: project.record.id,
    projectPath: project.canonicalPath,
    projectDirectoryPresent: project.exists,
    projectDirectoryDetail: project.detail,
    artifacts: page.map(describeArtifact),
    count: page.length,
    total: sorted.length,
    truncated: sorted.length > page.length || report.scan.truncated,
    scan: {
      roots: ARTIFACT_SCAN_ROOTS,
      rootsPresent: report.scan.rootsPresent,
      rootsAbsent: report.scan.rootsAbsent,
      filesSeen: report.scan.paths.length,
      fileCap: MAX_SCAN_FILES,
      depthCap: MAX_SCAN_DEPTH,
      capReached: report.scan.truncated,
    },
    summary: {
      present: sorted.filter((e) => e.presence === 'PRESENT').length,
      missing: sorted.filter((e) => e.presence === 'MISSING').length,
      unverifiable: sorted.filter((e) => e.presence === 'UNREADABLE' || e.presence === 'NOT_A_FILE').length,
      hashed: sorted.filter((e) => e.hashed).length,
    },
    events: { indexed: report.indexedEvents, missing: report.missingEvents },
    unreadableRecords: report.unreadableRecords,
    notes: report.notes,
    indexedAt: now().toISOString(),
  };
}

/* ========================================================================== */
/*  inspectArtifact                                                            */
/* ========================================================================== */

interface InspectContent {
  readonly kind: 'image' | 'text' | 'none';
  readonly encoding: 'base64' | 'utf-8' | null;
  readonly mediaType: string | null;
  readonly data: string | null;
  readonly bytesServed: number;
  readonly truncated: boolean;
  /** Present for SVG and HTML: real content that must not be rendered raw. */
  readonly renderUnsafe: boolean;
  readonly reason: string;
}

function noContent(reason: string): InspectContent {
  return {
    kind: 'none',
    encoding: null,
    mediaType: null,
    data: null,
    bytesServed: 0,
    truncated: false,
    renderUnsafe: false,
    reason,
  };
}

/**
 * Sensitive artifacts are gated on a real owner verdict.
 *
 * `describeSensitivePath` names the risk, the request carries those reasons, and
 * nothing is read until the request is APPROVED. PENDING returns the request and
 * no bytes; DENIED and EXPIRED return no bytes either.
 */
function gateSensitive(
  ctx: OperationContext,
  io: ApprovalIo,
  project: ResolvedProject,
  record: ArtifactRecord,
  approvalId: string | undefined,
): Record<string, unknown> | null {
  const report = describeSensitivePath(record.relativePath);
  if (!report.sensitive) return null;

  const action = `read the restricted artifact ${record.relativePath}`;
  const verdict = checkApproval(io, {
    projectId: project.record.id,
    runId: record.runId,
    operation: 'inspectArtifact',
    action,
    ...(approvalId !== undefined ? { approvalId } : {}),
  });
  if (verdict.state === 'APPROVED') return null;

  const opened =
    verdict.state === 'NONE' || verdict.state === 'MISMATCHED'
      ? requestApproval(io, {
          projectId: project.record.id,
          runId: record.runId,
          requestedBy: ctx.clientId ?? 'bridge',
          action,
          operation: 'inspectArtifact',
          affects: [record.relativePath],
          risk: 'HIGH',
          reason:
            `${report.message ?? 'Restricted file.'} ${report.reasons.join('; ')}. ` +
            'Reading it would return its real bytes to the browser.',
          rollbackPlan:
            'Nothing is written. Denying this request leaves the file unread; there is nothing to undo.',
          evidenceRefs: [{ kind: 'artifact', ref: record.relativePath, note: 'the file whose contents were requested' }],
        }).approval
      : verdict.approval;

  return {
    artifactId: record.id,
    projectId: project.record.id,
    relativePath: record.relativePath,
    status: 'WAITING_FOR_PERMISSION',
    statusLabel: 'RESTRICTED FILE — OWNER APPROVAL REQUIRED',
    approvalState: verdict.state === 'MISMATCHED' ? 'PENDING' : verdict.state === 'NONE' ? 'PENDING' : verdict.state,
    approval: opened,
    sensitive: true,
    sensitiveReasons: report.reasons,
    content: noContent(
      verdict.state === 'DENIED'
        ? 'The owner denied this read. A denial is final; a new request is required.'
        : verdict.state === 'EXPIRED'
          ? 'The approval request expired without a verdict. An expired request is never an approval.'
          : 'No bytes were read. The operation is waiting for an owner verdict.',
    ),
  };
}

function inspectArtifact(payload: unknown, ctx: OperationContext, deps?: ArtifactDeps): Record<string, unknown> {
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const artifactId = reqString(body, 'artifactId');
  const approvalId = optString(body, 'approvalId');
  const requestedBytes = optInteger(body, 'maxBytes', MIN_INSPECT_BYTES, MAX_INSPECT_BYTES) ?? DEFAULT_INSPECT_BYTES;

  const now = deps?.now ?? (() => new Date());
  const project = resolveProject(ctx, projectId, deps);

  let read;
  try {
    read = ctx.store.getRecord('artifact', artifactId);
  } catch (error) {
    fail('BAD_REQUEST', 'That artifact id is not a usable record id.', errorText(error));
  }
  if (!read.ok) {
    if (read.reason === 'MISSING') fail('NOT_FOUND', `No artifact is indexed with id ${artifactId}.`, read.detail);
    fail('RUNTIME_ERROR', `The artifact record ${artifactId} could not be read (${read.reason}).`, read.detail);
  }
  const record = read.record;
  if (record.projectId !== project.record.id) {
    fail('NOT_FOUND', `Artifact ${artifactId} does not belong to project ${project.record.id}.`);
  }

  const gated = gateSensitive(ctx, ioFromContext(ctx, deps), project, record, approvalId);
  if (gated !== null) return gated;

  // The path is re-guarded on every inspect, not trusted from the record.
  let canonicalPath: string | null = null;
  let guardDetail: string | null = null;
  try {
    canonicalPath = assertInsideRoot(record.canonicalPath, project.canonicalPath);
  } catch (error) {
    guardDetail = errorText(error);
  }

  const observation: FileObservation =
    canonicalPath === null
      ? {
          presence: 'UNREADABLE',
          bytes: null,
          createdAt: null,
          modifiedAt: null,
          createdAtSource: null,
          detail: `the recorded path was refused by the path guard: ${guardDetail ?? 'no detail'}`,
        }
      : observe(canonicalPath);

  const base = {
    artifactId: record.id,
    projectId: project.record.id,
    projectPath: project.canonicalPath,
    name: record.name,
    relativePath: record.relativePath,
    canonicalPath: record.canonicalPath,
    runId: record.runId,
    taskId: record.taskId,
    producedBy: record.producedBy,
    sensitive: false,
    inspectedAt: now().toISOString(),
  };

  if (observation.presence !== 'PRESENT' || canonicalPath === null) {
    const state: ArtifactState = observation.presence === 'MISSING' ? 'ORPHANED' : 'FAILED';
    // Nothing is fabricated here: no placeholder image, no sample text. The
    // last-known size and hash are returned and are labelled as last-known.
    return {
      ...base,
      state,
      statusLabel: labelFor(state, observation.presence),
      presence: observation.presence,
      detail: observation.detail,
      lastKnownBytes: record.bytes,
      lastKnownHash: record.hash,
      lastIndexedAt: record.indexedAt,
      bytes: null,
      hash: null,
      mediaType: null,
      content: noContent(
        observation.presence === 'MISSING'
          ? `${MISSING_ARTIFACT_LABEL} — nothing exists at the recorded path, so there are no bytes to serve.`
          : `The file could not be read: ${observation.detail}.`,
      ),
    };
  }

  const size = observation.bytes ?? 0;
  const detection = sniff(canonicalPath, size);
  const hash = size <= MAX_HASH_BYTES ? sha256File(canonicalPath) : null;

  let content: InspectContent;
  if (size === 0) {
    content = noContent('The file is zero bytes long; there is nothing to serve.');
  } else if (IMAGE_FORMATS.has(detection.format)) {
    if (size > requestedBytes) {
      // Half an image is not an image. Refusing beats returning bytes that would
      // render as a broken picture and be read as "the artifact is corrupt".
      content = noContent(
        `The image is ${size} bytes, over the ${requestedBytes}-byte inspect cap. Partial image bytes are not returned, ` +
          'because a truncated image is not the artifact.',
      );
    } else {
      const prefix = readPrefix(canonicalPath, size);
      content =
        prefix.error !== null
          ? noContent(`The bytes could not be read: ${prefix.error}.`)
          : {
              kind: 'image',
              encoding: 'base64',
              mediaType: detection.mediaType ?? mediaTypeForFormat(detection.format),
              data: Buffer.from(prefix.bytes).toString('base64'),
              bytesServed: prefix.bytes.byteLength,
              truncated: false,
              renderUnsafe: !BROWSER_RENDERABLE_IMAGE_FORMATS.has(detection.format),
              reason:
                prefix.bytes.byteLength === size
                  ? 'the whole file, base64-encoded'
                  : `only ${prefix.bytes.byteLength} of ${size} bytes could be read`,
            };
    }
  } else if (TEXT_SERVABLE_FORMATS.has(detection.format)) {
    const prefix = readPrefix(canonicalPath, Math.min(size, requestedBytes));
    if (prefix.error !== null) {
      content = noContent(`The bytes could not be read: ${prefix.error}.`);
    } else {
      const truncated = prefix.bytes.byteLength < size;
      content = {
        kind: 'text',
        encoding: 'utf-8',
        mediaType: detection.mediaType ?? 'text/plain',
        // A truncated UTF-8 tail can end mid-sequence; a non-fatal decode turns
        // that into U+FFFD rather than throwing or silently dropping bytes.
        data: new TextDecoder('utf-8', { fatal: false }).decode(prefix.bytes),
        bytesServed: prefix.bytes.byteLength,
        truncated,
        renderUnsafe: detection.format === 'svg' || detection.format === 'html',
        reason: truncated
          ? `the first ${prefix.bytes.byteLength} of ${size} bytes, decoded as UTF-8`
          : 'the whole file, decoded as UTF-8',
      };
    }
  } else {
    content = noContent(
      `The bytes are ${detection.format} (${detection.mediaType ?? 'no media type'}), which has no image or text form. ` +
        'No content is returned; the size and hash above are the verifiable facts about it.',
    );
  }

  return {
    ...base,
    state: hash === null ? ('DEGRADED' as ArtifactState) : ('COMPLETED' as ArtifactState),
    statusLabel: labelFor(hash === null ? 'DEGRADED' : 'COMPLETED', 'PRESENT'),
    presence: 'PRESENT' as Presence,
    detail: observation.detail,
    bytes: size,
    hash,
    hashAlgorithm: hash === null ? null : 'sha256',
    hashIsCurrent: hash !== null,
    mediaType: detection.mediaType,
    mediaTypeSource: detection.note,
    detectedFormat: detection.format,
    detectionConfidence: detection.confidence,
    createdAt: observation.createdAt,
    createdAtSource: observation.createdAtSource,
    modifiedAt: observation.modifiedAt,
    maxBytes: requestedBytes,
    content,
    evidenceRefs: [
      { kind: 'artifact', ref: record.relativePath, ...(hash !== null ? { hash } : {}), note: 'the bytes that were served' },
    ] satisfies readonly EvidenceRef[],
  };
}

/* ========================================================================== */
/*  Registration                                                               */
/* ========================================================================== */

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export function registerArtifactOperations(
  router: Router,
  deps?: ArtifactDeps,
  options: { readonly override?: boolean } = {},
): void {
  router.register('listArtifacts', (payload, ctx) => listArtifacts(payload, ctx, deps), options);
  router.register('inspectArtifact', (payload, ctx) => inspectArtifact(payload, ctx, deps), options);
}
