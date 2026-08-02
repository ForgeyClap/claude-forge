/**
 * Forge Workspace — project discovery.
 *
 * Walks the projects root, works out which folders are Forge projects, and
 * brings the registry into line with what is actually on disk.
 *
 * THREE PROPERTIES THIS FILE HOLDS.
 *
 * 1. RESCANNING CHANGES NOTHING. Discovery is matched on two stable keys — the
 *    project's own marker id, then its canonical path — and registers only what
 *    matches neither. Running it ten times in a row produces one record per
 *    project and nine reports that say "already known". Idempotence is not a
 *    claim made in a comment here; the second run's report is the evidence.
 *
 * 2. A MOVED PROJECT IS FOLLOWED, NOT RE-CREATED. `create.ts` writes a marker
 *    file into every project it makes, carrying the id it generated. When a
 *    folder turns up somewhere else under the root with a marker the registry
 *    already knows, the record's path is updated. Without the marker the same
 *    situation looks exactly like "one project vanished and an unrelated one
 *    appeared", and the project's whole history would be orphaned.
 *
 * 3. A VANISHED PROJECT IS MARKED, NEVER DELETED. If nothing is at a recorded
 *    path, the record's health becomes MISSING and the record stays. A folder
 *    can be absent because a drive is not mounted, because it is syncing, or
 *    because a backup tool moved it. Deleting the index entry — the only thing
 *    that still knows the project's id, its conversations and its runs — turns
 *    a recoverable situation into a permanent one.
 *
 * WHAT DISCOVERY REFUSES TO DECIDE. It never sets health to HEALTHY. Finding a
 * folder proves the folder exists; it proves nothing about the project inside
 * it. Newly discovered projects are UNKNOWN until a doctor check has run.
 */

import { readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

import type { EvidenceRef, GitState, ProjectRecord } from '../../shared/protocol.ts';
import { assertInsideRoot, inspectSlug, isPathGuardError } from '../security/paths.ts';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic.ts';
import { isGeneratedProjectId, UNKNOWN_PROJECT_TYPE } from './registry.ts';
import type { ProjectRegistry, RegisterProjectInput } from './registry.ts';
import { status as gitStatus } from './git.ts';

/* ========================================================================== */
/*  The project marker                                                         */
/* ========================================================================== */

export const MARKER_DIRECTORY_NAME = '.forge';
export const MARKER_FILENAME = 'project.json';
export const PROJECT_MARKER_SCHEMA_VERSION = 1;

/**
 * The file a Forge project carries so it can be recognised after it is moved
 * or renamed. It holds the id and nothing sensitive: an id, a slug, a name and
 * two timestamps. No path is stored in it — a path inside a file that travels
 * with the folder would be wrong the moment the folder travelled.
 */
export interface ProjectMarker {
  readonly markerSchemaVersion: number;
  readonly projectId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export type MarkerReadFailure = 'MISSING' | 'UNREADABLE' | 'CORRUPT' | 'INVALID';

export type MarkerReadResult =
  | { readonly ok: true; readonly marker: ProjectMarker; readonly markerPath: string }
  | { readonly ok: false; readonly reason: MarkerReadFailure; readonly detail: string; readonly markerPath: string };

export function projectMarkerPath(projectDirectory: string): string {
  return path.join(projectDirectory, MARKER_DIRECTORY_NAME, MARKER_FILENAME);
}

/**
 * Read a project's marker.
 *
 * The id is validated against the generated-UUID shape before it is returned.
 * That matters: this value can become a record id, and a record id becomes a
 * filename in the workspace store. A hand-edited marker must not be able to
 * put `../../..` anywhere near that.
 */
export function readProjectMarker(projectDirectory: string): MarkerReadResult {
  const markerPath = projectMarkerPath(projectDirectory);
  const read = readJsonSafe<Record<string, unknown>>(markerPath);
  if (!read.ok) {
    const reason: MarkerReadFailure =
      read.reason === 'MISSING' ? 'MISSING' : read.reason === 'UNREADABLE' ? 'UNREADABLE' : 'CORRUPT';
    return { ok: false, reason, detail: read.detail, markerPath };
  }

  const value = read.value;
  if (!isGeneratedProjectId(value.projectId)) {
    return {
      ok: false,
      reason: 'INVALID',
      detail: 'the marker does not carry a project id of the shape this system generates',
      markerPath,
    };
  }
  if (typeof value.slug !== 'string' || typeof value.displayName !== 'string') {
    return { ok: false, reason: 'INVALID', detail: 'the marker is missing its slug or display name', markerPath };
  }

  return {
    ok: true,
    markerPath,
    marker: {
      markerSchemaVersion:
        typeof value.markerSchemaVersion === 'number' ? value.markerSchemaVersion : PROJECT_MARKER_SCHEMA_VERSION,
      projectId: value.projectId,
      slug: value.slug,
      displayName: value.displayName,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
      createdBy: typeof value.createdBy === 'string' ? value.createdBy : '',
    },
  };
}

export interface MarkerWriteResult {
  readonly ok: boolean;
  readonly markerPath: string;
  readonly detail: string;
}

/** Write the marker. Used by `create.ts`; discovery only writes one on request. */
export function writeProjectMarker(projectDirectory: string, marker: ProjectMarker): MarkerWriteResult {
  const markerPath = projectMarkerPath(projectDirectory);
  try {
    writeJsonAtomic(markerPath, marker);
    return { ok: true, markerPath, detail: 'marker written' };
  } catch (error) {
    return { ok: false, markerPath, detail: error instanceof Error ? error.message : String(error) };
  }
}

/* ========================================================================== */
/*  Reading a project's own metadata                                           */
/* ========================================================================== */

export interface ForgeProjectMetadata {
  readonly hasClaudeDirectory: boolean;
  readonly hasClaudeMd: boolean;
  readonly hasForgeDirectory: boolean;
  readonly forgeVersion: string | null;
  readonly templateVersion: string | null;
  /** Null when nothing on disk states a type. Never guessed from the contents. */
  readonly type: string | null;
  readonly description: string | null;
  /** The files that were actually read, relative to the project. Auditable. */
  readonly sourcesRead: readonly string[];
  readonly notes: readonly string[];
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Read whatever the project says about itself.
 *
 * Every field is null unless a file on disk supplied it. Nothing is inferred
 * from the folder's contents: a project containing `index.html` is not
 * therefore a website project, and recording it as one would put a guess into a
 * field the rest of the system routes on.
 */
export function readForgeMetadata(projectDirectory: string): ForgeProjectMetadata {
  const claudeDir = path.join(projectDirectory, '.claude');
  const sourcesRead: string[] = [];
  const notes: string[] = [];

  let forgeVersion: string | null = null;
  let templateVersion: string | null = null;
  let type: string | null = null;
  let description: string | null = null;

  const versionPath = path.join(claudeDir, 'FORGE_VERSION.json');
  const versionRead = readJsonSafe<Record<string, unknown>>(versionPath);
  if (versionRead.ok) {
    sourcesRead.push('.claude/FORGE_VERSION.json');
    const raw = versionRead.value.forge_version;
    if (typeof raw === 'string' && raw.length > 0) forgeVersion = raw;
    const template = versionRead.value.template;
    if (typeof template === 'string' && template.length > 0) templateVersion = template;
  } else if (versionRead.reason !== 'MISSING') {
    notes.push(`.claude/FORGE_VERSION.json could not be read (${versionRead.reason}): ${versionRead.detail}`);
  }

  const setupPath = path.join(claudeDir, '.forge-setup.json');
  const setupRead = readJsonSafe<Record<string, unknown>>(setupPath);
  if (setupRead.ok) {
    sourcesRead.push('.claude/.forge-setup.json');
    const answers = setupRead.value.answers;
    if (typeof answers === 'object' && answers !== null && !Array.isArray(answers)) {
      const record = answers as Record<string, unknown>;
      if (typeof record.type === 'string' && record.type.trim().length > 0) type = record.type.trim();
      if (typeof record.goal === 'string' && record.goal.trim().length > 0) description = record.goal.trim();
    }
    if (forgeVersion === null && typeof setupRead.value.version === 'string' && setupRead.value.version !== 'unknown') {
      forgeVersion = setupRead.value.version;
    }
  } else if (setupRead.reason !== 'MISSING') {
    notes.push(`.claude/.forge-setup.json could not be read (${setupRead.reason}): ${setupRead.detail}`);
  }

  return {
    hasClaudeDirectory: isDirectory(claudeDir),
    hasClaudeMd: isFile(path.join(projectDirectory, 'CLAUDE.md')),
    hasForgeDirectory: isDirectory(path.join(projectDirectory, MARKER_DIRECTORY_NAME)),
    forgeVersion,
    templateVersion,
    type,
    description,
    sourcesRead,
    notes,
  };
}

/**
 * Is this folder a Forge project at all?
 *
 * The test is the presence of Forge's own metadata, not the presence of code.
 * A folder full of source with no `.claude`, no `CLAUDE.md` and no marker is
 * somebody's other work that happens to sit under the projects root, and
 * adopting it into the registry uninvited would be wrong.
 */
export function looksLikeForgeProject(metadata: ForgeProjectMetadata, hasMarker: boolean): boolean {
  return hasMarker || metadata.hasClaudeDirectory || metadata.hasClaudeMd;
}

/* ========================================================================== */
/*  The discovery report                                                       */
/* ========================================================================== */

export interface DiscoveredProject {
  readonly id: string;
  readonly displayName: string;
  readonly canonicalPath: string;
  readonly matchedBy: 'marker' | 'path' | 'new';
}

export interface MovedProject {
  readonly id: string;
  readonly displayName: string;
  readonly from: string;
  readonly to: string;
}

export interface MissingProject {
  readonly id: string;
  readonly displayName: string;
  readonly canonicalPath: string;
  readonly previousHealth: string;
  readonly detail: string;
}

export interface SkippedEntry {
  readonly name: string;
  readonly reason: string;
}

export interface RejectedEntry {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

export interface DiscoveryFailure {
  readonly scope: string;
  readonly detail: string;
}

export interface DiscoveryReport {
  readonly scannedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly projectsRoot: string;
  readonly projectsRootExists: boolean;
  /** Directory entries the scan saw, before any filtering. */
  readonly entriesSeen: number;
  readonly registered: readonly DiscoveredProject[];
  readonly alreadyKnown: readonly DiscoveredProject[];
  readonly moved: readonly MovedProject[];
  readonly missing: readonly MissingProject[];
  /** Records whose folder is present but not under the projects root. */
  readonly outsideRoot: readonly DiscoveredProject[];
  readonly skipped: readonly SkippedEntry[];
  readonly rejected: readonly RejectedEntry[];
  readonly failures: readonly DiscoveryFailure[];
  readonly notes: readonly string[];
}

export interface DiscoveryOptions {
  /**
   * Read each project's real git state. Off by default: it spawns four git
   * processes per project, and a scan that takes seconds is a scan nobody runs.
   */
  readonly readGitState?: boolean;
  /**
   * Write a marker into a known project that has none, so a later move can be
   * followed. Off by default — discovery writing into a user's folder is a side
   * effect, and it has to be asked for.
   */
  readonly writeMissingMarkers?: boolean;
  readonly now?: () => Date;
}

/* ========================================================================== */
/*  discoverProjects                                                           */
/* ========================================================================== */

/**
 * Reconcile the registry with the projects root.
 *
 * Order is load-bearing. Moves are resolved BEFORE the presence sweep, so a
 * project that was moved within the root has its path corrected first and is
 * never briefly reported as missing. The sweep then decides MISSING on one
 * piece of evidence only: `stat` on the recorded path did not find a directory.
 * "Not seen during the scan" is deliberately not enough — an imported project
 * lives outside the root and would fail that test every single time.
 */
export function discoverProjects(
  registry: ProjectRegistry,
  options: DiscoveryOptions = {},
): DiscoveryReport {
  const now = options.now ?? (() => new Date());
  const startedAt = now();

  const registered: DiscoveredProject[] = [];
  const alreadyKnown: DiscoveredProject[] = [];
  const moved: MovedProject[] = [];
  const missing: MissingProject[] = [];
  const outsideRoot: DiscoveredProject[] = [];
  const skipped: SkippedEntry[] = [];
  const rejected: RejectedEntry[] = [];
  const failures: DiscoveryFailure[] = [];
  const notes: string[] = [];

  const root = registry.projectsRoot;
  const rootExists = isDirectory(root);

  const known = registry.list({ includeArchived: true });
  for (const problem of known.unreadable) {
    failures.push({
      scope: `record project/${problem.id}`,
      detail: `the record exists on disk but could not be read (${problem.reason}): ${problem.detail}`,
    });
  }
  notes.push(
    `${known.records.length} project record(s) were readable at scan time` +
      (known.unreadable.length > 0 ? `; ${known.unreadable.length} were not and were left untouched` : ''),
  );

  const byMarkerId = new Map<string, ProjectRecord>();
  for (const record of known.records) byMarkerId.set(record.id, record);

  /* ---------------------------------------------------------------- the scan */

  let entriesSeen = 0;
  if (!rootExists) {
    notes.push(`the projects root does not exist yet, so nothing could be scanned: ${root}`);
  } else {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      failures.push({ scope: 'projects root', detail: `could not list ${root}: ${errorMessage(error)}` });
    }

    for (const entry of entries) {
      entriesSeen += 1;

      if (entry.isSymbolicLink()) {
        // Not followed. A link could point at a second copy of a project that
        // is already registered under its real path, and registering both
        // would give one project two ids.
        skipped.push({ name: entry.name, reason: 'entry is a symbolic link; discovery does not follow links' });
        continue;
      }
      if (!entry.isDirectory()) {
        skipped.push({ name: entry.name, reason: 'entry is not a directory' });
        continue;
      }
      if (entry.name.startsWith('.')) {
        skipped.push({ name: entry.name, reason: 'dot-directories under the projects root are not projects' });
        continue;
      }

      // The guard canonicalises; from here on only its return value is used.
      let canonicalPath: string;
      try {
        canonicalPath = assertInsideRoot(path.join(root, entry.name), root);
      } catch (error) {
        if (isPathGuardError(error)) {
          rejected.push({ name: entry.name, code: error.code, message: error.message });
        } else {
          rejected.push({ name: entry.name, code: 'PATH_REJECTED', message: errorMessage(error) });
        }
        continue;
      }

      const markerRead = readProjectMarker(canonicalPath);
      const metadata = readForgeMetadata(canonicalPath);
      for (const note of metadata.notes) notes.push(`${entry.name}: ${note}`);

      /* --------------------------------------------- 1. matched by marker id */
      if (markerRead.ok) {
        const existing = byMarkerId.get(markerRead.marker.projectId);
        if (existing !== undefined) {
          if (samePath(existing.canonicalPath, canonicalPath)) {
            alreadyKnown.push(described(existing, 'marker'));
          } else {
            const move = registry.recordPathMoved(
              existing.id,
              canonicalPath,
              `the project marker for ${existing.id} was found at a different location under the projects root`,
            );
            if (move.ok) {
              moved.push({
                id: existing.id,
                displayName: move.value.displayName,
                from: existing.canonicalPath,
                to: canonicalPath,
              });
              byMarkerId.set(existing.id, move.value);
            } else {
              failures.push({
                scope: `project ${existing.id}`,
                detail: `the folder appears to have moved to ${canonicalPath} but the record could not be updated: ${move.error.message}`,
              });
            }
          }
          continue;
        }
      } else if (markerRead.reason !== 'MISSING') {
        notes.push(`${entry.name}: the project marker could not be used (${markerRead.reason}): ${markerRead.detail}`);
      }

      /* ------------------------------------------- 2. matched by stored path */
      const byPath = registry.findByCanonicalPath(canonicalPath);
      if (byPath !== null) {
        alreadyKnown.push(described(byPath, 'path'));
        if (options.writeMissingMarkers === true && !markerRead.ok) {
          const write = writeProjectMarker(canonicalPath, {
            markerSchemaVersion: PROJECT_MARKER_SCHEMA_VERSION,
            projectId: byPath.id,
            slug: byPath.slug,
            displayName: byPath.displayName,
            createdAt: byPath.createdAt,
            createdBy: 'forge-bridge/discover',
          });
          notes.push(
            write.ok
              ? `${entry.name}: wrote a project marker so a later move can be followed`
              : `${entry.name}: a project marker could not be written (${write.detail})`,
          );
        }
        continue;
      }

      /* ------------------------------------------------------ 3. new to us */
      if (!looksLikeForgeProject(metadata, markerRead.ok)) {
        skipped.push({
          name: entry.name,
          reason: 'no Forge metadata (.forge marker, .claude directory or CLAUDE.md) — not adopted',
        });
        continue;
      }

      // The marker, when present, is the better source for both: it holds the
      // name the owner actually chose and the slug that was generated from it,
      // neither of which survives a folder rename.
      const inspection = inspectSlug(markerRead.ok ? markerRead.marker.slug : entry.name);
      if (!inspection.ok) {
        skipped.push({
          name: entry.name,
          reason: `the folder name cannot be reduced to a safe slug: ${inspection.reason}`,
        });
        continue;
      }

      const input: RegisterProjectInput = {
        displayName: markerRead.ok ? markerRead.marker.displayName : entry.name,
        slug: inspection.slug,
        canonicalPath,
        ...(markerRead.ok ? { id: markerRead.marker.projectId } : {}),
        type: metadata.type ?? UNKNOWN_PROJECT_TYPE,
        description: metadata.description ?? '',
        forgeVersion: metadata.forgeVersion,
        templateVersion: metadata.templateVersion,
        origin: 'discovered',
      };
      const registration = registry.register(input);

      if (!registration.ok) {
        failures.push({
          scope: entry.name,
          detail: `could not be registered (${registration.error.code}): ${registration.error.message}`,
        });
        continue;
      }
      registered.push(described(registration.value, markerRead.ok ? 'marker' : 'new'));
      byMarkerId.set(registration.value.id, registration.value);
      for (const note of registration.notes) notes.push(`${entry.name}: ${note}`);
    }
  }

  /* ------------------------------------------------------- presence sweep */

  for (const record of registry.list({ includeArchived: true }).records) {
    const presence = registry.existsOnDisk(record);
    if (presence.present) {
      if (!isInside(record.canonicalPath, root)) {
        outsideRoot.push(described(record, 'path'));
      }
      continue;
    }
    if (record.health === 'MISSING') {
      // Already recorded as missing on a previous scan. Re-writing the record
      // would only churn `updatedAt` and emit a duplicate event.
      missing.push({
        id: record.id,
        displayName: record.displayName,
        canonicalPath: record.canonicalPath,
        previousHealth: record.health,
        detail: `${presence.detail} (already recorded as MISSING)`,
      });
      continue;
    }

    const evidenceRefs: readonly EvidenceRef[] = [
      { kind: 'file', ref: record.canonicalPath, note: presence.detail },
      { kind: 'file', ref: `records/project/${record.id}.json`, note: 'the record that still holds this project' },
    ];
    const marked = registry.setHealth(record.id, 'MISSING', {
      summary: `Folder not found at the recorded path during discovery — ${presence.detail}. The record was kept.`,
      evidenceRefs,
    });
    if (!marked.ok) {
      failures.push({
        scope: `project ${record.id}`,
        detail: `the folder is gone but the record could not be marked MISSING: ${marked.error.message}`,
      });
      continue;
    }
    missing.push({
      id: record.id,
      displayName: record.displayName,
      canonicalPath: record.canonicalPath,
      previousHealth: record.health,
      detail: presence.detail,
    });
  }

  /* ----------------------------------------------------- optional git read */

  if (options.readGitState === true) {
    for (const found of [...registered, ...alreadyKnown, ...moved.map(toDiscovered)]) {
      const read = readGitStateFor(found.canonicalPath);
      if (read === null) continue;
      const applied = registry.setGitState(found.id, read.state, read.evidenceRefs);
      if (!applied.ok) {
        failures.push({
          scope: `project ${found.id}`,
          detail: `git state was read but could not be stored: ${applied.error.message}`,
        });
      }
    }
  }

  const finishedAt = now();
  return {
    scannedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    projectsRoot: root,
    projectsRootExists: rootExists,
    entriesSeen,
    registered,
    alreadyKnown,
    moved,
    missing,
    outsideRoot,
    skipped,
    rejected,
    failures,
    notes,
  };
}

/* ========================================================================== */
/*  Helpers                                                                    */
/* ========================================================================== */

function described(record: ProjectRecord, matchedBy: DiscoveredProject['matchedBy']): DiscoveredProject {
  return {
    id: record.id,
    displayName: record.displayName,
    canonicalPath: record.canonicalPath,
    matchedBy,
  };
}

function toDiscovered(move: MovedProject): DiscoveredProject {
  return { id: move.id, displayName: move.displayName, canonicalPath: move.to, matchedBy: 'marker' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInside(candidate: string, root: string): boolean {
  try {
    assertInsideRoot(candidate, root);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a project's git state, or return null when git could not answer.
 *
 * Null rather than a zeroed `GitState`: an all-false state is
 * indistinguishable from "a real repository with nothing in it", and storing
 * one because git was unavailable would be a false statement about the project.
 */
function readGitStateFor(
  projectDirectory: string,
): { readonly state: GitState; readonly evidenceRefs: readonly EvidenceRef[] } | null {
  const result = gitStatus(projectDirectory);
  if (result.commands.length === 0) return null;
  const first = result.commands[0]!;
  if (first.failure !== null && first.exitCode === null) return null; // git never ran

  return {
    state: result.state,
    evidenceRefs: result.commands.map((command) => ({
      kind: 'exit-code' as const,
      ref: command.exitCode === null ? 'none' : String(command.exitCode),
      note: `git ${command.args.join(' ')}`,
    })),
  };
}
