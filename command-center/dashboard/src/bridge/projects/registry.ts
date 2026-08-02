/**
 * Forge Workspace — the project registry.
 *
 * The single canonical index of `ProjectRecord`. Everything else in the bridge
 * asks this file which projects exist and where they live; nothing else is
 * allowed to work that out for itself.
 *
 * THE IDENTITY RULE. `id` is generated exactly once, by `crypto.randomUUID`,
 * and is never derived from a display name, a slug or a path. That is what
 * makes renaming safe: a rename changes `displayName` and nothing else, so
 * every conversation, run, event stream and attachment that referenced the
 * project still resolves. A registry keyed on the name would silently orphan
 * all of it the first time somebody fixed a typo.
 *
 * THE PATH RULE. No function here rebuilds a path out of a name. Every lookup
 * is `id -> canonicalPath`, read from the stored record. `projectsRoot` is
 * never joined with a slug in this file — if it were, a renamed folder, a
 * truncated slug or a confusable character would each hand back a path to
 * somewhere the project is not. Computing a path for a brand-new project
 * happens once, in `create.ts`, and the result is stored; from that moment on
 * it is only ever read back.
 *
 * THE HEALTH RULE. `register` always stores `UNKNOWN`. `HEALTHY` and
 * `DEGRADED` are claims that something was checked, so `setHealth` refuses
 * them without a summary and at least one evidence reference. There is no path
 * through this file that produces a healthy-looking project because nothing
 * went wrong yet.
 *
 * Relative `.ts` imports are deliberate and match the storage layer: Node 24
 * executes TypeScript directly and wants the explicit extension, and bridge
 * code is permitted relative imports.
 */

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

import type {
  EvidenceRef,
  GitState,
  OperationErrorCode,
  ProjectHealthState,
  ProjectRecord,
} from '../../shared/protocol.ts';
import {
  assertInsideRoot,
  detectCollision,
  exceedsWindowsMaxPath,
  inspectSlug,
  isPathGuardError,
  WINDOWS_MAX_PATH,
} from '../security/paths.ts';
import type { CollisionMatch, CollisionReason } from '../security/paths.ts';
import type { ForgeStore, RecordListResult } from '../storage/store.ts';

/* ========================================================================== */
/*  Constants                                                                  */
/* ========================================================================== */

/** Stamped on every record this build writes. Tracks the project record shape. */
export const PROJECT_METADATA_SCHEMA_VERSION = 1;

/**
 * The honest default project type. A project whose kind nothing on disk states
 * is `unknown` — never a plausible-looking guess, because the type drives which
 * playbook the rest of the system reaches for.
 */
export const UNKNOWN_PROJECT_TYPE = 'unknown';

/**
 * Types the UI already understands (`src/prototype/types/prototype-types.ts`),
 * plus the two honest escape hatches. A type outside this set is stored as
 * `unknown` rather than passed through, so a corrupted metadata file cannot put
 * arbitrary text into a field the UI switches on.
 */
export const KNOWN_PROJECT_TYPES: readonly string[] = [
  'website',
  'full-stack',
  'automation',
  'chatbot',
  'scraping',
  'prediction',
  'integration',
  'research',
  'other',
  UNKNOWN_PROJECT_TYPE,
];

/**
 * Ids this registry will adopt from disk. Only the exact shape
 * `crypto.randomUUID` produces — so a project marker written by this system can
 * be re-adopted after a folder move, while an arbitrary string in a
 * hand-edited file cannot become a record id and reach a file path.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isGeneratedProjectId(value: unknown): value is string {
  return typeof value === 'string' && UUID_SHAPE.test(value);
}

/** Collision rungs that mean two projects would occupy the SAME directory. */
const HARD_COLLISION_REASONS: ReadonlySet<CollisionReason> = new Set<CollisionReason>(['exact', 'case']);

/* ========================================================================== */
/*  Results                                                                    */
/* ========================================================================== */

export type RegistryErrorCode = Extract<
  OperationErrorCode,
  'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'PATH_REJECTED' | 'OUTSIDE_TRUSTED_ROOT' | 'INVALID_STATE' | 'RUNTIME_ERROR'
>;

export interface RegistryError {
  readonly code: RegistryErrorCode;
  readonly message: string;
  readonly detail?: string;
  /** Present when the refusal was a name clash, so the UI can name the twin. */
  readonly collisions?: readonly CollisionMatch[];
}

export type RegistryResult<T> =
  | { readonly ok: true; readonly value: T; readonly notes: readonly string[] }
  | { readonly ok: false; readonly error: RegistryError };

function fail<T>(
  code: RegistryErrorCode,
  message: string,
  detail?: string,
  collisions?: readonly CollisionMatch[],
): RegistryResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(detail !== undefined ? { detail } : {}),
      ...(collisions !== undefined ? { collisions } : {}),
    },
  };
}

function succeed<T>(value: T, notes: readonly string[] = []): RegistryResult<T> {
  return { ok: true, value, notes };
}

/* ========================================================================== */
/*  Inputs                                                                     */
/* ========================================================================== */

export type ProjectOrigin = 'created' | 'discovered' | 'imported';

export interface RegisterProjectInput {
  readonly displayName: string;
  /** Produced by `sanitizeSlug`. The registry re-checks it, never invents it. */
  readonly slug: string;
  /** The path `assertInsideRoot` RETURNED. Never a string a caller assembled. */
  readonly canonicalPath: string;
  /**
   * Only for re-adopting an id this system generated and wrote into the
   * project's own marker file. Rejected unless it has the generated shape and
   * is not already taken. Omit it and a fresh id is generated here.
   */
  readonly id?: string;
  readonly type?: string;
  readonly description?: string;
  readonly forgeVersion?: string | null;
  readonly templateVersion?: string | null;
  readonly git?: GitState;
  readonly origin: ProjectOrigin;
  /** Owner override for a look-alike name. Never defaults to true. */
  readonly allowConfusable?: boolean;
  readonly createdAt?: string;
}

export interface HealthEvidence {
  /** One line a human can read. Stored as `lastDoctorResult`. */
  readonly summary: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface AvailabilityReport {
  readonly displayName: string;
  /** Null when the name cannot become a slug at all. */
  readonly slug: string | null;
  readonly slugNotes: readonly string[];
  readonly slugRejection: string | null;
  readonly slugCollisions: readonly CollisionMatch[];
  readonly displayNameCollisions: readonly CollisionMatch[];
  readonly duplicateCanonicalPath: { readonly id: string; readonly canonicalPath: string } | null;
  /** A refusal no option can override — the two projects are one directory. */
  readonly hardBlock: string | null;
  /** A refusal an explicit owner override may pass. Never auto-approved. */
  readonly softBlock: string | null;
  readonly available: boolean;
}

/* ========================================================================== */
/*  The registry                                                               */
/* ========================================================================== */

export interface ProjectRegistryOptions {
  /** The trusted root every project must live under. Resolved by the caller. */
  readonly projectsRoot: string;
  readonly now?: () => Date;
}

export class ProjectRegistry {
  readonly projectsRoot: string;

  private readonly store: ForgeStore;
  private readonly now: () => Date;

  constructor(store: ForgeStore, options: ProjectRegistryOptions) {
    if (typeof options.projectsRoot !== 'string' || !path.isAbsolute(options.projectsRoot)) {
      throw new Error('ProjectRegistry requires an absolute projects root');
    }
    this.store = store;
    this.projectsRoot = path.resolve(options.projectsRoot);
    this.now = options.now ?? (() => new Date());
  }

  /* ------------------------------------------------------------------ reads */

  /**
   * Every project record, plus an explicit list of the ones that exist on disk
   * and could not be read. A registry that quietly drops an unreadable record
   * reports a shorter, cleaner, wrong answer.
   */
  list(options: { readonly includeArchived?: boolean } = {}): RecordListResult<ProjectRecord> {
    const result = this.store.listRecords('project');
    if (options.includeArchived === true) return result;
    return { records: result.records.filter((r) => !r.archived), unreadable: result.unreadable };
  }

  get(id: string): RegistryResult<ProjectRecord> {
    if (typeof id !== 'string' || id.length === 0) {
      return fail('BAD_REQUEST', 'A project id is required.');
    }
    let read;
    try {
      read = this.store.getRecord('project', id);
    } catch (error) {
      return fail('BAD_REQUEST', 'That project id is not a usable record id.', errorMessage(error));
    }
    if (!read.ok) {
      return read.reason === 'MISSING'
        ? fail('NOT_FOUND', `No project is registered with id ${id}.`, read.detail)
        : fail('RUNTIME_ERROR', `The project record ${id} could not be read (${read.reason}).`, read.detail);
    }
    return succeed(read.record);
  }

  /**
   * THE path lookup. Id in, stored canonical path out.
   *
   * Deliberately the only way to get a project's location. Nothing in the
   * bridge may join the projects root with a slug to find a project: the slug
   * is a historical artefact of the name at creation time, and a folder that
   * has been renamed on disk, or whose slug was truncated to fit, no longer
   * lives where that arithmetic says it does.
   */
  resolvePath(id: string): RegistryResult<string> {
    const record = this.get(id);
    if (!record.ok) return record;
    return succeed(record.value.canonicalPath);
  }

  findByCanonicalPath(canonicalPath: string): ProjectRecord | null {
    if (typeof canonicalPath !== 'string' || canonicalPath.length === 0) return null;
    const key = pathKey(canonicalPath);
    for (const record of this.store.listRecords('project').records) {
      if (pathKey(record.canonicalPath) === key) return record;
    }
    return null;
  }

  /** Does the stored path still hold a directory? Observed, never assumed. */
  existsOnDisk(record: ProjectRecord): { readonly present: boolean; readonly detail: string } {
    try {
      const stat = statSync(record.canonicalPath);
      return stat.isDirectory()
        ? { present: true, detail: 'the recorded path is a directory' }
        : { present: false, detail: 'the recorded path exists but is not a directory' };
    } catch (error) {
      const code = (error as { code?: string }).code;
      return {
        present: false,
        detail:
          code === 'ENOENT'
            ? 'nothing exists at the recorded path'
            : `the recorded path could not be inspected (${code ?? 'unknown error'})`,
      };
    }
  }

  /* ----------------------------------------------------------- name checking */

  /**
   * Would this name be accepted, and what would it collide with?
   *
   * Runs the same checks `register` runs and writes nothing, so the New Project
   * form can show the refusal before the owner presses the button rather than
   * after the directory has been made.
   */
  checkAvailability(input: {
    readonly displayName: string;
    readonly canonicalPath?: string;
    /** The project being renamed, excluded from its own collision check. */
    readonly excludeId?: string;
  }): AvailabilityReport {
    const inspection = inspectSlug(input.displayName);
    const others = this.store
      .listRecords('project')
      .records.filter((r) => r.id !== input.excludeId);

    const displayNameCollisions = detectCollision(
      others.map((r) => r.displayName),
      typeof input.displayName === 'string' ? input.displayName : '',
    ).matches;

    if (!inspection.ok) {
      return {
        displayName: String(input.displayName),
        slug: null,
        slugNotes: [],
        slugRejection: inspection.reason,
        slugCollisions: [],
        displayNameCollisions,
        duplicateCanonicalPath: null,
        hardBlock: inspection.reason,
        softBlock: null,
        available: false,
      };
    }

    const slugCollisions = detectCollision(
      others.map((r) => r.slug),
      inspection.slug,
    ).matches;

    let duplicateCanonicalPath: { id: string; canonicalPath: string } | null = null;
    if (input.canonicalPath !== undefined) {
      const key = pathKey(input.canonicalPath);
      for (const record of others) {
        if (pathKey(record.canonicalPath) === key) {
          duplicateCanonicalPath = { id: record.id, canonicalPath: record.canonicalPath };
          break;
        }
      }
    }

    // Hard: the two projects would BE the same directory. On Windows a case
    // difference is not a difference, so `case` sits here with `exact`.
    const hardSlug = slugCollisions.find((m) => HARD_COLLISION_REASONS.has(m.reason));
    let hardBlock: string | null = null;
    if (duplicateCanonicalPath !== null) {
      hardBlock = `Another project (${duplicateCanonicalPath.id}) is already registered at that exact path.`;
    } else if (hardSlug !== undefined) {
      hardBlock = `The folder name "${inspection.slug}" is already taken by "${hardSlug.existing}" (${hardSlug.reason} match).`;
    }

    // Soft: two different directories that a human cannot tell apart. Refused
    // by default, passable with an explicit owner override — the owner is the
    // only one who can say "yes, I really do want both".
    const softSlug = slugCollisions.find((m) => !HARD_COLLISION_REASONS.has(m.reason));
    const softName = displayNameCollisions.find((m) => !HARD_COLLISION_REASONS.has(m.reason));
    const soft = softSlug ?? softName;
    const softBlock =
      hardBlock === null && soft !== undefined
        ? `"${input.displayName}" is visually indistinguishable from the existing project "${soft.existing}" (${soft.reason} match).`
        : null;

    return {
      displayName: input.displayName,
      slug: inspection.slug,
      slugNotes: inspection.notes,
      slugRejection: null,
      slugCollisions,
      displayNameCollisions,
      duplicateCanonicalPath,
      hardBlock,
      softBlock,
      available: hardBlock === null && softBlock === null,
    };
  }

  /* ------------------------------------------------------------- registering */

  /**
   * Add a project to the index.
   *
   * The caller supplies the canonical path — this function does not build one.
   * It still re-runs `assertInsideRoot` on what it was given, because a check
   * performed by a caller is a check this file cannot see.
   */
  register(input: RegisterProjectInput): RegistryResult<ProjectRecord> {
    const notes: string[] = [];

    if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0) {
      return fail('BAD_REQUEST', 'A project needs a display name.');
    }
    if (typeof input.slug !== 'string' || input.slug.length === 0) {
      return fail('BAD_REQUEST', 'A project needs a slug produced by the path guard.');
    }

    // The guard is re-run here on purpose. The returned value replaces the
    // input string for everything below: acting on the caller's original after
    // canonicalisation is how a symlink swap gets through a passing check.
    let canonicalPath: string;
    try {
      canonicalPath = assertInsideRoot(input.canonicalPath, this.projectsRoot);
    } catch (error) {
      if (isPathGuardError(error)) {
        return fail(error.code, error.message, error.detail);
      }
      return fail('PATH_REJECTED', 'The project path could not be validated.', errorMessage(error));
    }

    const availability = this.checkAvailability({ displayName: input.displayName, canonicalPath });
    if (availability.hardBlock !== null) {
      return fail('CONFLICT', availability.hardBlock, undefined, [
        ...availability.slugCollisions,
        ...availability.displayNameCollisions,
      ]);
    }
    if (availability.softBlock !== null && input.allowConfusable !== true) {
      return fail(
        'CONFLICT',
        `${availability.softBlock} Registering it anyway needs an explicit owner override.`,
        undefined,
        [...availability.slugCollisions, ...availability.displayNameCollisions],
      );
    }
    if (availability.softBlock !== null) {
      notes.push(`accepted a look-alike name under an explicit override: ${availability.softBlock}`);
    }
    notes.push(...availability.slugNotes);

    let id: string;
    if (input.id !== undefined) {
      if (!isGeneratedProjectId(input.id)) {
        return fail(
          'BAD_REQUEST',
          'A supplied project id must have the shape this system generates.',
          'Ids are only ever re-adopted from a marker file this system wrote.',
        );
      }
      if (this.store.hasRecord('project', input.id)) {
        return fail('CONFLICT', `A project with id ${input.id} is already registered.`);
      }
      id = input.id;
      notes.push('re-adopted the project id recorded in the project’s own marker file');
    } else {
      // Generated once, here, and never again for this project.
      id = randomUUID();
    }

    if (exceedsWindowsMaxPath(canonicalPath)) {
      notes.push(
        `the project path is ${canonicalPath.length} characters, beyond the ${WINDOWS_MAX_PATH}-character limit many Windows tools still enforce`,
      );
    }

    const timestamp = this.now().toISOString();
    const record: ProjectRecord = {
      id,
      displayName: input.displayName,
      slug: input.slug,
      canonicalPath,
      relativePath: relativeTo(this.projectsRoot, canonicalPath),
      type: normaliseType(input.type),
      description: typeof input.description === 'string' ? input.description : '',
      createdAt: input.createdAt ?? timestamp,
      updatedAt: timestamp,
      forgeVersion: input.forgeVersion ?? null,
      templateVersion: input.templateVersion ?? null,
      git: input.git ?? emptyGitState(),
      sessionIds: [],
      conversationIds: [],
      activeRunIds: [],
      archived: false,
      // Registration proves a record exists. It proves nothing about the
      // project's condition, so the health it starts at is UNKNOWN.
      health: 'UNKNOWN',
      lastDoctorResult: null,
      metadataSchemaVersion: PROJECT_METADATA_SCHEMA_VERSION,
    };

    try {
      this.store.saveRecord('project', record);
    } catch (error) {
      return fail('RUNTIME_ERROR', 'The project record could not be persisted.', errorMessage(error));
    }

    notes.push(
      ...this.emit(record.id, input.origin === 'discovered' ? 'project.discovered' : 'project.created', {
        projectId: record.id,
        displayName: record.displayName,
        slug: record.slug,
        origin: input.origin,
        health: record.health,
      }, [
        { kind: 'file', ref: `records/project/${record.id}.json`, note: 'the project record as written' },
        { kind: 'file', ref: record.canonicalPath, note: 'the project directory' },
      ]),
    );

    return succeed(record, notes);
  }

  /* ----------------------------------------------------------------- updates */

  /**
   * Rename a project.
   *
   * Changes `displayName`. Does not change `id`, `slug`, `canonicalPath` or
   * `relativePath` — the folder on disk keeps the name it was created with, and
   * every reference to this project keeps resolving. A registry that renamed
   * the directory too would have to update every path any other subsystem had
   * already recorded, and would corrupt the ones it missed.
   */
  rename(id: string, displayName: string): RegistryResult<ProjectRecord> {
    const current = this.get(id);
    if (!current.ok) return current;

    // The name still has to survive the guard even though no path is built from
    // it: it is rendered in a UI, written into files and put in event payloads.
    const inspection = inspectSlug(displayName);
    if (!inspection.ok) {
      return fail('BAD_REQUEST', `That name cannot be used: ${inspection.reason}`);
    }

    const availability = this.checkAvailability({ displayName, excludeId: id });
    const hardName = availability.displayNameCollisions.find((m) => HARD_COLLISION_REASONS.has(m.reason));
    if (hardName !== undefined) {
      return fail(
        'CONFLICT',
        `Another project is already called "${hardName.existing}".`,
        undefined,
        availability.displayNameCollisions,
      );
    }

    const notes: string[] = [];
    if (availability.softBlock !== null) {
      // Not blocking: no directory is at stake, only legibility. Recorded so
      // the UI can warn instead of silently accepting two identical-looking rows.
      notes.push(availability.softBlock);
    }

    const previous = current.value.displayName;
    const updated: ProjectRecord = {
      ...current.value,
      displayName,
      updatedAt: this.now().toISOString(),
    };
    return this.persistUpdate(updated, { field: 'displayName', from: previous, to: displayName }, notes);
  }

  /**
   * Record that a project's folder has MOVED.
   *
   * Only `discover.ts` should call this, and only when it has matched the
   * project's own marker file at the new location. Moving a record's path on
   * any weaker evidence would point the whole system at somebody else's folder.
   */
  recordPathMoved(id: string, newCanonicalPath: string, reason: string): RegistryResult<ProjectRecord> {
    const current = this.get(id);
    if (!current.ok) return current;

    let canonicalPath: string;
    try {
      canonicalPath = assertInsideRoot(newCanonicalPath, this.projectsRoot);
    } catch (error) {
      if (isPathGuardError(error)) return fail(error.code, error.message, error.detail);
      return fail('PATH_REJECTED', 'The new project path could not be validated.', errorMessage(error));
    }

    const occupant = this.findByCanonicalPath(canonicalPath);
    if (occupant !== null && occupant.id !== id) {
      return fail(
        'CONFLICT',
        `Project ${occupant.id} is already registered at that path.`,
        `refusing to point two records at ${canonicalPath}`,
      );
    }

    const from = current.value.canonicalPath;
    if (pathKey(from) === pathKey(canonicalPath)) {
      return succeed(current.value, ['the recorded path already matches; nothing was changed']);
    }

    const updated: ProjectRecord = {
      ...current.value,
      canonicalPath,
      relativePath: relativeTo(this.projectsRoot, canonicalPath),
      updatedAt: this.now().toISOString(),
    };
    return this.persistUpdate(updated, { field: 'canonicalPath', from, to: canonicalPath, reason }, []);
  }

  /**
   * Set health.
   *
   * `HEALTHY` and `DEGRADED` are claims that a check ran, so they require a
   * summary and at least one evidence reference. `MISSING` and `ERROR` are
   * claims that something was observed to be wrong, and require a summary too.
   * `UNKNOWN` is the one value that needs no evidence — it asserts nothing.
   */
  setHealth(
    id: string,
    health: ProjectHealthState,
    evidence: HealthEvidence | null,
  ): RegistryResult<ProjectRecord> {
    const current = this.get(id);
    if (!current.ok) return current;

    if (health !== 'UNKNOWN') {
      if (evidence === null || typeof evidence.summary !== 'string' || evidence.summary.trim().length === 0) {
        return fail(
          'INVALID_STATE',
          `Health ${health} is a claim about this project, so it needs a summary of the check that produced it.`,
        );
      }
      if ((health === 'HEALTHY' || health === 'DEGRADED') && evidence.evidenceRefs.length === 0) {
        return fail(
          'INVALID_STATE',
          `Health ${health} requires at least one evidence reference; a status with nothing behind it is not a status.`,
        );
      }
    }

    const from = current.value.health;
    const updated: ProjectRecord = {
      ...current.value,
      health,
      lastDoctorResult: evidence?.summary ?? current.value.lastDoctorResult,
      updatedAt: this.now().toISOString(),
    };
    return this.persistUpdate(
      updated,
      { field: 'health', from, to: health, summary: evidence?.summary ?? null },
      [],
      evidence?.evidenceRefs ?? [],
    );
  }

  /** Store an observed `GitState`. The caller must have read it from git. */
  setGitState(id: string, git: GitState, evidenceRefs: readonly EvidenceRef[] = []): RegistryResult<ProjectRecord> {
    const current = this.get(id);
    if (!current.ok) return current;
    const updated: ProjectRecord = { ...current.value, git, updatedAt: this.now().toISOString() };
    return this.persistUpdate(updated, { field: 'git', from: current.value.git, to: git }, [], evidenceRefs);
  }

  /** Update the descriptive fields. Identity and location are not in this set. */
  updateMetadata(
    id: string,
    patch: {
      readonly type?: string;
      readonly description?: string;
      readonly forgeVersion?: string | null;
      readonly templateVersion?: string | null;
    },
  ): RegistryResult<ProjectRecord> {
    const current = this.get(id);
    if (!current.ok) return current;
    const updated: ProjectRecord = {
      ...current.value,
      ...(patch.type !== undefined ? { type: normaliseType(patch.type) } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.forgeVersion !== undefined ? { forgeVersion: patch.forgeVersion } : {}),
      ...(patch.templateVersion !== undefined ? { templateVersion: patch.templateVersion } : {}),
      updatedAt: this.now().toISOString(),
    };
    return this.persistUpdate(updated, { field: 'metadata', patch }, []);
  }

  /**
   * Archive a project. The record and the folder both stay: archiving is a
   * view-level decision, and deleting a user's work because a list got long is
   * not a decision this layer gets to make.
   */
  archive(id: string): RegistryResult<ProjectRecord> {
    const current = this.get(id);
    if (!current.ok) return current;
    if (current.value.archived) return succeed(current.value, ['the project was already archived']);
    const updated: ProjectRecord = { ...current.value, archived: true, updatedAt: this.now().toISOString() };

    try {
      this.store.saveRecord('project', updated);
    } catch (error) {
      return fail('RUNTIME_ERROR', 'The project record could not be persisted.', errorMessage(error));
    }
    const notes = this.emit(id, 'project.archived', { projectId: id, displayName: updated.displayName }, [
      { kind: 'file', ref: `records/project/${id}.json` },
    ]);
    return succeed(updated, notes);
  }

  unarchive(id: string): RegistryResult<ProjectRecord> {
    const current = this.get(id);
    if (!current.ok) return current;
    if (!current.value.archived) return succeed(current.value, ['the project was not archived']);
    const updated: ProjectRecord = { ...current.value, archived: false, updatedAt: this.now().toISOString() };
    return this.persistUpdate(updated, { field: 'archived', from: true, to: false }, []);
  }

  /* --------------------------------------------------------------- internals */

  private persistUpdate(
    record: ProjectRecord,
    payload: Record<string, unknown>,
    notes: readonly string[],
    evidenceRefs: readonly EvidenceRef[] = [],
  ): RegistryResult<ProjectRecord> {
    try {
      this.store.saveRecord('project', record);
    } catch (error) {
      return fail('RUNTIME_ERROR', 'The project record could not be persisted.', errorMessage(error));
    }
    const emitNotes = this.emit(record.id, 'project.updated', { projectId: record.id, ...payload }, [
      { kind: 'file', ref: `records/project/${record.id}.json` },
      ...evidenceRefs,
    ]);
    return succeed(record, [...notes, ...emitNotes]);
  }

  /**
   * Append an event, and never let a logging failure be mistaken for a data
   * failure. The record is already on disk by the time this runs; if the append
   * fails, the caller is told in a note rather than being handed an error that
   * implies the project was not registered.
   */
  private emit(
    projectId: string,
    type: 'project.created' | 'project.discovered' | 'project.updated' | 'project.archived',
    payload: Record<string, unknown>,
    evidenceRefs: readonly EvidenceRef[],
  ): readonly string[] {
    try {
      this.store.appendEvent({
        projectId,
        runId: null,
        source: 'bridge',
        type,
        payload,
        evidenceRefs,
      });
      return [];
    } catch (error) {
      return [
        `the project record was written, but the ${type} event could not be appended: ${errorMessage(error)}`,
      ];
    }
  }
}

/* ========================================================================== */
/*  Small helpers                                                              */
/* ========================================================================== */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** NTFS is case-insensitive, so two paths differing only in case are one path. */
function pathKey(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Display-oriented, forward-slashed, and never used to rebuild a real path. */
function relativeTo(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative.length === 0 ? '.' : relative.split('\\').join('/');
}

function normaliseType(type: string | undefined): string {
  if (typeof type !== 'string') return UNKNOWN_PROJECT_TYPE;
  const trimmed = type.trim().toLowerCase();
  return KNOWN_PROJECT_TYPES.includes(trimmed) ? trimmed : UNKNOWN_PROJECT_TYPE;
}

/**
 * The state of a project whose git has not been read yet.
 *
 * `initialized: false` here means "not established", and the caller is expected
 * to replace it with a real reading. It is the contract's only representable
 * default; `setGitState` exists so that default never survives a doctor run.
 */
export function emptyGitState(): GitState {
  return { initialized: false, branch: null, dirtyFiles: 0, lastCommit: null, hasRemote: false };
}
