/**
 * Forge Workspace — the real New Project flow.
 *
 * Eleven steps, in a fixed order, each one recording what actually happened.
 * The output is a RECEIPT: a JSON record of every step, its real result and its
 * timestamps, written to disk whether the flow succeeded or not.
 *
 * WHY A RECEIPT AND NOT A BOOLEAN. "Create a project" is not one operation, it
 * is eleven, and they fail independently. A flow that returns `true` because it
 * reached the end tells you nothing about the git init that failed halfway, and
 * a flow that returns `false` throws away the ten things that did work. The
 * receipt is the only artefact that can say "steps 1–9 succeeded, step 10
 * failed with this exact error, step 11 was never reached" — which is both the
 * honest answer and the useful one.
 *
 * THE OUTCOME IS DERIVED, NEVER ASSERTED.
 *
 *   CREATED     every step ran and every one succeeded.
 *   INCOMPLETE  the project exists and is registered, but at least one
 *               non-fatal step failed or was skipped. It is NOT reported as a
 *               successful creation.
 *   FAILED      a step the project cannot exist without did not succeed.
 *
 * WHAT THIS FLOW WILL NOT DO. It never creates a remote and never pushes: the
 * git wrapper it uses cannot reach a network at all. It never blind-overwrites
 * a `CLAUDE.md` — an existing one is merged inside explicit markers, with the
 * original's hash recorded so the merge can be checked afterwards. And by
 * default it never deletes a partially created directory: `rollbackOnFailure`
 * is opt-in, and when it is off the receipt says exactly what was left behind
 * and where.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

import type {
  EvidenceRef,
  GitState,
  ProjectHealthState,
  ProjectRecord,
} from '../../shared/protocol.ts';
import {
  assertInsideRoot,
  ensureProjectsRoot,
  exceedsWindowsMaxPath,
  inspectSlug,
  isPathGuardError,
  WINDOWS_MAX_PATH,
} from '../security/paths.ts';
import {
  directoryExists,
  ensureDir,
  fileExists,
  readTextSafe,
  sha256,
  writeAtomic,
  writeJsonAtomic,
} from '../storage/atomic.ts';
import type { ForgeStore } from '../storage/store.ts';
import { PROJECT_MARKER_SCHEMA_VERSION, projectMarkerPath, writeProjectMarker } from './discover.ts';
import type { ProjectMarker } from './discover.ts';
import * as git from './git.ts';
import type { GitAuthor } from './git.ts';
import { emptyGitState, UNKNOWN_PROJECT_TYPE } from './registry.ts';
import type { ProjectRegistry, RegistryErrorCode } from './registry.ts';

/* ========================================================================== */
/*  The project skeleton                                                       */
/* ========================================================================== */

/** Directories every Forge project gets under `.claude/`. */
export const FORGE_CLAUDE_SUBDIRECTORIES: readonly string[] = [
  'agent-memory',
  'agents',
  'commands',
  'config',
  'docs',
  'forge-runs',
  'skills',
];

/** The FORGE_* memory scaffolds, by filename. The doctor checks for these. */
export const FORGE_MEMORY_FILES: readonly string[] = [
  'FORGE_VERSION.json',
  'FORGE_MEMORY.md',
  'FORGE_SESSION_STATE.json',
  'FORGE_ECC_MODE.json',
  'FORGE_DECISIONS.md',
  'FORGE_TASK_HISTORY.md',
  'FORGE_AGENT_LEDGER.md',
  'FORGE_PROJECT_PROFILE.md',
  'FORGE_SKILL_REGISTRY.md',
];

/** Version of the scaffold this build writes. Stored on the project record. */
export const FORGE_TEMPLATE_VERSION = 'forge-workspace-scaffold-1';

export const CLAUDE_MD_BEGIN_MARKER = '<!-- FORGE:BEGIN managed-block v1 -->';
export const CLAUDE_MD_END_MARKER = '<!-- FORGE:END managed-block v1 -->';

/**
 * The identity used when git has none configured.
 *
 * On this machine `git config --get user.name` and `--get user.email` both
 * exit 1, so a commit without an explicit author fails outright. Using this
 * fallback is recorded in the receipt as a fallback — the commit must never
 * look as though the owner authored it when they did not.
 */
export const FALLBACK_GIT_AUTHOR: GitAuthor = {
  name: 'Forge Workspace',
  email: 'forge-workspace@localhost',
};

/* ========================================================================== */
/*  Steps and the receipt                                                      */
/* ========================================================================== */

export type CreationStepId =
  | 'validate-name'
  | 'sanitize-slug'
  | 'assert-inside-root'
  | 'collision-check'
  | 'generate-id'
  | 'create-directory'
  | 'forge-structure'
  | 'claude-md'
  | 'register'
  | 'git'
  | 'doctor';

export const CREATION_STEP_ORDER: readonly CreationStepId[] = [
  'validate-name',
  'sanitize-slug',
  'assert-inside-root',
  'collision-check',
  'generate-id',
  'create-directory',
  'forge-structure',
  'claude-md',
  'register',
  'git',
  'doctor',
];

const STEP_TITLES: Readonly<Record<CreationStepId, string>> = {
  'validate-name': 'Validate the requested display name',
  'sanitize-slug': 'Reduce the name to one safe path segment',
  'assert-inside-root': 'Prove the target path is inside the trusted root',
  'collision-check': 'Check for duplicate paths and look-alike names',
  'generate-id': 'Generate the permanent project id',
  'create-directory': 'Create the project directory',
  'forge-structure': 'Write the .claude structure and FORGE_* scaffolds',
  'claude-md': 'Create or safely merge CLAUDE.md',
  register: 'Register the project in the canonical index',
  git: 'git init, .gitignore and the baseline commit',
  doctor: 'Run a doctor check against what is on disk',
};

/** Steps the project cannot meaningfully exist without. */
const FATAL_STEPS: ReadonlySet<CreationStepId> = new Set<CreationStepId>([
  'validate-name',
  'sanitize-slug',
  'assert-inside-root',
  'collision-check',
  'generate-id',
  'create-directory',
  'forge-structure',
  'claude-md',
  'register',
]);

export type CreationStepStatus = 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'NOT_REACHED';

export interface CreationStepError {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
}

export interface CreationStep {
  readonly number: number;
  readonly id: CreationStepId;
  readonly title: string;
  readonly status: CreationStepStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly detail: string;
  readonly error: CreationStepError | null;
  readonly evidenceRefs: readonly EvidenceRef[];
  /** Real observed values for this step. Never a summary of intent. */
  readonly data: Record<string, unknown> | null;
}

export type CreationOutcome = 'CREATED' | 'INCOMPLETE' | 'FAILED';

export interface CreationReceipt {
  readonly receiptVersion: 1;
  readonly receiptId: string;
  readonly outcome: CreationOutcome;
  readonly requestedName: string;
  readonly projectId: string | null;
  readonly slug: string | null;
  readonly canonicalPath: string | null;
  readonly projectsRoot: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly steps: readonly CreationStep[];
  readonly stepsSucceeded: number;
  readonly stepsFailed: number;
  readonly stepsSkipped: number;
  readonly stepsNotReached: number;
  /** The 1-based number of the first step that failed. Null when none did. */
  readonly failedAtStep: number | null;
  /** A partially created directory that was deliberately not removed. */
  readonly leftOnDisk: string | null;
  readonly rollback: { readonly attempted: boolean; readonly removed: boolean; readonly detail: string } | null;
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly gitAvailable: boolean;
    readonly gitExecutablePath: string | null;
    readonly gitVersion: string | null;
    readonly bridgeInstanceId: string;
  };
  readonly doctor: DoctorReport | null;
  readonly notes: readonly string[];
}

export interface CreateProjectResult {
  readonly outcome: CreationOutcome;
  /** Present only when the project was registered. Null otherwise. */
  readonly project: ProjectRecord | null;
  readonly receipt: CreationReceipt;
  /** Every location the receipt was successfully written to. */
  readonly receiptPaths: readonly string[];
  readonly error: CreationStepError | null;
}

export interface CreateProjectInput {
  readonly displayName: string;
  readonly type?: string;
  readonly description?: string;
  /** Explicit owner override for a name that looks like an existing one. */
  readonly allowConfusable?: boolean;
  /** The owner's git identity, when the caller knows it. */
  readonly gitAuthor?: GitAuthor;
  readonly initialBranch?: string;
  readonly skipGit?: boolean;
  /** Create the projects root if it does not exist yet. Default true. */
  readonly ensureRoot?: boolean;
  /**
   * Remove a partially created directory when a fatal step fails.
   * Default FALSE: deleting a tree is irreversible, and leaving it with the
   * receipt pointing at it is recoverable.
   */
  readonly rollbackOnFailure?: boolean;
  readonly now?: () => Date;
}

/* ========================================================================== */
/*  Step recorder                                                              */
/* ========================================================================== */

class StepLog {
  private readonly completed: CreationStep[] = [];
  private open: { id: CreationStepId; number: number; startedAt: string; startedMs: number } | null = null;
  private readonly clock: () => Date;

  constructor(clock: () => Date) {
    this.clock = clock;
  }

  begin(id: CreationStepId): void {
    if (this.open !== null) {
      throw new Error(`step ${this.open.id} was never closed before ${id} began`);
    }
    this.open = {
      id,
      number: CREATION_STEP_ORDER.indexOf(id) + 1,
      startedAt: this.clock().toISOString(),
      startedMs: Date.now(),
    };
  }

  succeed(detail: string, data: Record<string, unknown> | null = null, evidenceRefs: readonly EvidenceRef[] = []): void {
    this.close('SUCCEEDED', detail, data, evidenceRefs, null);
  }

  fail(
    error: CreationStepError,
    detail: string,
    data: Record<string, unknown> | null = null,
    evidenceRefs: readonly EvidenceRef[] = [],
  ): void {
    this.close('FAILED', detail, data, evidenceRefs, error);
  }

  skip(detail: string, data: Record<string, unknown> | null = null): void {
    this.close('SKIPPED', detail, data, [], null);
  }

  private close(
    status: CreationStepStatus,
    detail: string,
    data: Record<string, unknown> | null,
    evidenceRefs: readonly EvidenceRef[],
    error: CreationStepError | null,
  ): void {
    if (this.open === null) throw new Error('a step outcome was recorded with no step open');
    this.completed.push({
      number: this.open.number,
      id: this.open.id,
      title: STEP_TITLES[this.open.id],
      status,
      startedAt: this.open.startedAt,
      finishedAt: this.clock().toISOString(),
      durationMs: Date.now() - this.open.startedMs,
      detail,
      error,
      evidenceRefs,
      data,
    });
    this.open = null;
  }

  /**
   * Every step, in order. Steps the flow never reached are present with status
   * NOT_REACHED — an absent step would read as "nothing to report", and the
   * difference between "did not run" and "ran and was fine" is the whole point.
   */
  finalise(): readonly CreationStep[] {
    const seen = new Set(this.completed.map((step) => step.id));
    const all = [...this.completed];
    for (const id of CREATION_STEP_ORDER) {
      if (seen.has(id)) continue;
      all.push({
        number: CREATION_STEP_ORDER.indexOf(id) + 1,
        id,
        title: STEP_TITLES[id],
        status: 'NOT_REACHED',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        detail: 'the flow stopped before this step began',
        error: null,
        evidenceRefs: [],
        data: null,
      });
    }
    return all.sort((a, b) => a.number - b.number);
  }
}

/* ========================================================================== */
/*  Scaffold content                                                           */
/* ========================================================================== */

interface ScaffoldContext {
  readonly id: string;
  readonly displayName: string;
  readonly slug: string;
  readonly canonicalPath: string;
  readonly createdAt: string;
  readonly type: string;
  readonly description: string;
}

interface ScaffoldFile {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * The FORGE_* scaffolds.
 *
 * Everything in them is either a fact this flow established or an explicit
 * "not established yet". None of them contains a fabricated status, a
 * pre-filled decision or an invented test result — a fresh project's memory
 * files claiming history would poison the first real run that read them.
 */
function scaffoldFiles(context: ScaffoldContext): readonly ScaffoldFile[] {
  const { displayName, slug, id, canonicalPath, createdAt, type, description } = context;
  const goal = description.trim().length > 0 ? description.trim() : 'not stated yet — the owner supplies it with the first task';

  return [
    {
      relativePath: '.claude/FORGE_VERSION.json',
      content: json({
        forge_version: FORGE_TEMPLATE_VERSION,
        synced_at: createdAt,
        template: 'forge-workspace/bridge/projects/create.ts',
        system_files: null,
      }),
    },
    {
      relativePath: '.claude/FORGE_MEMORY.md',
      content: [
        '# Forge Memory (project-local)',
        '',
        '> Read before every task, update after. Only write what real files, git or the owner’s',
        '> instruction support; mark anything else `inferred` or `unknown`. Never store secrets,',
        '> keys, tokens or personal data here.',
        '',
        '## Status',
        '- created by the Forge Workspace bridge — no runs yet',
        '',
        '## Decisions',
        '- none yet — see `FORGE_DECISIONS.md`',
        '',
        '## Open issues',
        '- none recorded',
        '',
      ].join('\n'),
    },
    {
      relativePath: '.claude/FORGE_SESSION_STATE.json',
      content: json({
        mode: 'off',
        since: '',
        last_activity: '',
        project_isolation: 'on',
        ecc_normal_mode: 'on',
        ecc_full_test_mode: 'off',
        notes: 'Project-local session state. Set mode to "on" when a Forge session starts in this project.',
      }),
    },
    {
      relativePath: '.claude/FORGE_ECC_MODE.json',
      content: json({
        ecc_normal_mode: 'on',
        ecc_full_test_mode: 'off',
        project_isolation: 'on',
        heavy_security_gates: 'off',
        global_unblock: 'off',
        notes:
          'ECC Full Test Mode is opt-in only and is never enabled for a new project. Project isolation ' +
          'means work stays inside this folder.',
      }),
    },
    {
      relativePath: '.claude/FORGE_DECISIONS.md',
      content: [
        '# Forge Decisions Log',
        '',
        '| Date/time | Decision | Reason | Impact | Files affected | Rollback note |',
        '|---|---|---|---|---|---|',
        `| ${createdAt} | Project created by the Forge Workspace bridge | New project requested by the owner | Directory, .claude scaffolds and a git baseline exist | \`${slug}/\` | Delete the folder and its registry record |`,
        '',
      ].join('\n'),
    },
    {
      relativePath: '.claude/FORGE_TASK_HISTORY.md',
      content: [
        '# Forge Task History',
        '',
        '> One honest entry per completed task: status, work packages, and which agents and checks',
        '> actually ran.',
        '',
        '(no tasks yet)',
        '',
      ].join('\n'),
    },
    {
      relativePath: '.claude/FORGE_AGENT_LEDGER.md',
      content: [
        '# Forge Agent Activity Ledger',
        '',
        '> Proof of which agents actually worked. Statuses: `REAL INVOKED` · `REAL TOOL/SKILL USED` ·',
        '> `INTERNAL ROLE ONLY` · `NOT USED` · `FAILED`.',
        '',
        '(no runs yet — this is a fresh project)',
        '',
      ].join('\n'),
    },
    {
      relativePath: '.claude/FORGE_PROJECT_PROFILE.md',
      content: [
        '# Forge Project Profile',
        '',
        `- **Project name:** ${displayName}`,
        `- **Project id:** \`${id}\``,
        `- **Folder:** \`${canonicalPath}\``,
        `- **Created:** ${createdAt}`,
        `- **Project type:** \`${type}\`${type === UNKNOWN_PROJECT_TYPE ? ' — not stated yet' : ''}`,
        `- **Goal:** ${goal}`,
        '- **Detected stack:** nothing scanned yet',
        '- **Maturity:** new project, no code',
        '- **Deployment status:** unknown',
        '',
        '## Verified facts',
        '',
        'This file starts with only what the creation flow established. Everything else is unknown',
        'until something reads the project and records what it found.',
        '',
      ].join('\n'),
    },
    {
      relativePath: '.claude/FORGE_SKILL_REGISTRY.md',
      content: [
        '# Forge Skill Registry (project-local)',
        '',
        'Authoritative list of skills available and used in THIS project. Project-local only — it never',
        'lists or modifies global or other-project skills.',
        '',
        '**Source legend:** `built-in` · `forge` · `ecc` · `project-local`.',
        '**Status legend:** `active` · `planned` · `skipped` · `unavailable` · `deprecated`.',
        '',
        '| Skill | Path | Source | Purpose | Status |',
        '|-------|------|--------|---------|--------|',
        '',
        '(none registered yet)',
        '',
      ].join('\n'),
    },
  ];
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The block Forge owns inside a project's CLAUDE.md. */
function claudeMdManagedBlock(context: ScaffoldContext): string {
  const { displayName, id, canonicalPath, createdAt, type, description } = context;
  return [
    CLAUDE_MD_BEGIN_MARKER,
    `# ${displayName}`,
    '',
    'Created by the Forge Workspace bridge. The lines between the two FORGE markers are',
    'regenerated on demand — write anything of your own OUTSIDE them and it will be preserved.',
    '',
    '## Project facts',
    '',
    `- Project id: \`${id}\``,
    `- Folder: \`${canonicalPath}\``,
    `- Created: ${createdAt}`,
    `- Type: \`${type}\``,
    description.trim().length > 0 ? `- Goal: ${description.trim()}` : '- Goal: not stated yet',
    '',
    '## Ground rules',
    '',
    '- Work stays inside this folder. No other project, and no global configuration, is touched.',
    '- Report honestly: a status is a claim about reality. If it cannot be shown to be true, the',
    '  answer is UNKNOWN or UNVERIFIED, and those are acceptable answers.',
    '- Never commit secrets, tokens or credentials.',
    '',
    CLAUDE_MD_END_MARKER,
    '',
  ].join('\n');
}

const GITIGNORE_ENTRIES: readonly string[] = [
  '# --- Forge Workspace ---',
  '.env',
  '.env.local',
  '.env.*.local',
  '!.env.example',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '*.log',
  '.forge-workspace/',
  '.claude/forge-runs/',
  '.forge/receipts/',
  '.DS_Store',
  'Thumbs.db',
];

/* ========================================================================== */
/*  CLAUDE.md safe merge                                                       */
/* ========================================================================== */

export type ClaudeMdMergeMode = 'created' | 'managed-block-replaced' | 'managed-block-appended' | 'failed';

export interface ClaudeMdMergeResult {
  readonly ok: boolean;
  readonly mode: ClaudeMdMergeMode;
  readonly filePath: string;
  /** SHA-256 of the file BEFORE the merge. Null when there was no file. */
  readonly originalHash: string | null;
  readonly originalBytes: number | null;
  readonly resultHash: string | null;
  readonly resultBytes: number | null;
  /** True when every byte of the original is still present in the result. */
  readonly originalPreserved: boolean | null;
  readonly detail: string;
}

/**
 * Create `CLAUDE.md`, or merge into an existing one without losing a byte.
 *
 * The three cases are handled separately on purpose:
 *  - no file          → write the managed block alone;
 *  - file with markers→ replace ONLY the region between them;
 *  - file without     → append the block, leaving the original untouched above.
 *
 * An unreadable existing file is a hard stop. Overwriting a file we could not
 * read is exactly the destructive move this function exists to avoid, and
 * "probably nothing important" is not a thing this system gets to decide.
 */
export function mergeClaudeMd(projectDirectory: string, context: ScaffoldContext): ClaudeMdMergeResult {
  const filePath = path.join(projectDirectory, 'CLAUDE.md');
  const block = claudeMdManagedBlock(context);

  if (!fileExists(filePath)) {
    try {
      const write = writeAtomic(filePath, block);
      return {
        ok: true,
        mode: 'created',
        filePath,
        originalHash: null,
        originalBytes: null,
        resultHash: sha256(block),
        resultBytes: write.bytes,
        originalPreserved: null,
        detail: 'no CLAUDE.md existed; the managed block was written as the whole file',
      };
    } catch (error) {
      return {
        ok: false,
        mode: 'failed',
        filePath,
        originalHash: null,
        originalBytes: null,
        resultHash: null,
        resultBytes: null,
        originalPreserved: null,
        detail: `CLAUDE.md could not be written: ${errorMessage(error)}`,
      };
    }
  }

  const read = readTextSafe(filePath);
  if (!read.ok) {
    return {
      ok: false,
      mode: 'failed',
      filePath,
      originalHash: null,
      originalBytes: null,
      resultHash: null,
      resultBytes: null,
      originalPreserved: null,
      detail:
        `an existing CLAUDE.md could not be read (${read.reason}): ${read.detail}. ` +
        'It was left exactly as it is — a file that cannot be read is never overwritten.',
    };
  }

  const original = read.value;
  const originalHash = sha256(original);
  const begin = original.indexOf(CLAUDE_MD_BEGIN_MARKER);
  const end = original.indexOf(CLAUDE_MD_END_MARKER);

  let merged: string;
  let mode: ClaudeMdMergeMode;
  let preserved: boolean;

  if (begin !== -1 && end !== -1 && end > begin) {
    const before = original.slice(0, begin);
    const after = original.slice(end + CLAUDE_MD_END_MARKER.length);
    merged = `${before}${block.trimEnd()}${after}`;
    mode = 'managed-block-replaced';
    // Everything outside the markers is what the owner wrote; that is what has
    // to survive, and it is checked rather than assumed.
    preserved = merged.includes(before.trimEnd()) && (after.trim().length === 0 || merged.includes(after.trimStart()));
  } else {
    const separator = original.endsWith('\n') ? '\n' : '\n\n';
    merged = `${original}${separator}${block}`;
    mode = 'managed-block-appended';
    preserved = merged.startsWith(original);
  }

  try {
    const write = writeAtomic(filePath, merged);
    return {
      ok: true,
      mode,
      filePath,
      originalHash,
      originalBytes: read.bytes,
      resultHash: sha256(merged),
      resultBytes: write.bytes,
      originalPreserved: preserved,
      detail:
        mode === 'managed-block-replaced'
          ? 'an existing CLAUDE.md already had Forge markers; only the region between them was replaced'
          : 'an existing CLAUDE.md had no Forge markers; the managed block was appended and nothing was removed',
    };
  } catch (error) {
    return {
      ok: false,
      mode: 'failed',
      filePath,
      originalHash,
      originalBytes: read.bytes,
      resultHash: null,
      resultBytes: null,
      originalPreserved: null,
      detail: `CLAUDE.md could not be written: ${errorMessage(error)}`,
    };
  }
}

/* ========================================================================== */
/*  .gitignore safe merge                                                      */
/* ========================================================================== */

export interface GitignoreMergeResult {
  readonly ok: boolean;
  readonly filePath: string;
  readonly created: boolean;
  readonly linesAdded: readonly string[];
  readonly detail: string;
}

/** Add only the entries that are not already there. Never rewrites the file. */
export function mergeGitignore(projectDirectory: string): GitignoreMergeResult {
  const filePath = path.join(projectDirectory, '.gitignore');
  if (!fileExists(filePath)) {
    try {
      writeAtomic(filePath, `${GITIGNORE_ENTRIES.join('\n')}\n`);
      return {
        ok: true,
        filePath,
        created: true,
        linesAdded: GITIGNORE_ENTRIES,
        detail: 'a .gitignore was created',
      };
    } catch (error) {
      return { ok: false, filePath, created: false, linesAdded: [], detail: errorMessage(error) };
    }
  }

  const read = readTextSafe(filePath);
  if (!read.ok) {
    return {
      ok: false,
      filePath,
      created: false,
      linesAdded: [],
      detail: `an existing .gitignore could not be read (${read.reason}); it was left untouched`,
    };
  }
  const existing = new Set(read.value.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((line) => !existing.has(line.trim()));
  if (missing.length === 0) {
    return { ok: true, filePath, created: false, linesAdded: [], detail: 'every entry was already present' };
  }
  try {
    const separator = read.value.endsWith('\n') ? '' : '\n';
    writeAtomic(filePath, `${read.value}${separator}${missing.join('\n')}\n`);
    return {
      ok: true,
      filePath,
      created: false,
      linesAdded: missing,
      detail: `${missing.length} missing entr${missing.length === 1 ? 'y was' : 'ies were'} appended`,
    };
  } catch (error) {
    return { ok: false, filePath, created: false, linesAdded: [], detail: errorMessage(error) };
  }
}

/* ========================================================================== */
/*  The doctor                                                                 */
/* ========================================================================== */

export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  /** True/false when it was determined; NULL when it could not be. */
  readonly ok: boolean | null;
  readonly detail: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface DoctorReport {
  readonly projectId: string | null;
  readonly canonicalPath: string;
  readonly ranAt: string;
  readonly durationMs: number;
  readonly checks: readonly DoctorCheck[];
  readonly passed: number;
  readonly failed: number;
  readonly undetermined: number;
  readonly verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  readonly health: ProjectHealthState;
  /** One line, suitable for `ProjectRecord.lastDoctorResult`. */
  readonly summary: string;
  /** Null when git could not be read at all. Never a zeroed placeholder. */
  readonly git: GitState | null;
}

/**
 * Check a project against what is actually on disk.
 *
 * Every check reports true, false, or NULL. Null means the check could not be
 * carried out — git missing, a permission error — and it is counted separately
 * so it can never be quietly folded into "passed". A verdict of PASS requires
 * every check to have run AND succeeded.
 */
export function runProjectDoctor(
  canonicalPath: string,
  options: { readonly projectId?: string; readonly now?: () => Date } = {},
): DoctorReport {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const startedMs = Date.now();
  const checks: DoctorCheck[] = [];
  const fileRef = (relative: string): EvidenceRef => ({ kind: 'file', ref: path.join(canonicalPath, relative) });

  const add = (
    id: string,
    title: string,
    ok: boolean | null,
    detail: string,
    evidenceRefs: readonly EvidenceRef[] = [],
  ): void => {
    checks.push({ id, title, ok, detail, evidenceRefs });
  };

  /* ---------------------------------------------------------- the directory */
  const directoryPresent = directoryExists(canonicalPath);
  add(
    'project-directory',
    'The project directory exists',
    directoryPresent,
    directoryPresent ? `${canonicalPath} is a directory` : `nothing is at ${canonicalPath}`,
    [{ kind: 'file', ref: canonicalPath }],
  );

  if (!directoryPresent) {
    const finished = now();
    return {
      projectId: options.projectId ?? null,
      canonicalPath,
      ranAt: startedAt.toISOString(),
      durationMs: Date.now() - startedMs,
      checks,
      passed: 0,
      failed: 1,
      undetermined: 0,
      verdict: 'FAIL',
      health: 'MISSING',
      summary: `MISSING — the project directory does not exist (checked ${finished.toISOString()})`,
      git: null,
    };
  }

  /* ------------------------------------------------------ the .claude layout */
  const claudeDir = path.join(canonicalPath, '.claude');
  add(
    'claude-directory',
    'The .claude directory exists',
    directoryExists(claudeDir),
    directoryExists(claudeDir) ? '.claude is present' : '.claude is missing',
    [fileRef('.claude')],
  );

  const missingSubdirectories = FORGE_CLAUDE_SUBDIRECTORIES.filter(
    (name) => !directoryExists(path.join(claudeDir, name)),
  );
  add(
    'claude-subdirectories',
    'The .claude subdirectories exist',
    missingSubdirectories.length === 0,
    missingSubdirectories.length === 0
      ? `all ${FORGE_CLAUDE_SUBDIRECTORIES.length} subdirectories are present`
      : `missing: ${missingSubdirectories.join(', ')}`,
    FORGE_CLAUDE_SUBDIRECTORIES.map((name) => fileRef(path.join('.claude', name))),
  );

  const missingMemoryFiles = FORGE_MEMORY_FILES.filter((name) => !fileExists(path.join(claudeDir, name)));
  add(
    'forge-memory-files',
    'The FORGE_* memory scaffolds exist',
    missingMemoryFiles.length === 0,
    missingMemoryFiles.length === 0
      ? `all ${FORGE_MEMORY_FILES.length} scaffolds are present`
      : `missing: ${missingMemoryFiles.join(', ')}`,
    FORGE_MEMORY_FILES.map((name) => fileRef(path.join('.claude', name))),
  );

  /* ------------------------------------------------------------ the marker */
  const markerPath = projectMarkerPath(canonicalPath);
  const markerPresent = fileExists(markerPath);
  add(
    'project-marker',
    'The project carries its id marker',
    markerPresent,
    markerPresent
      ? '.forge/project.json is present, so a folder move can be followed'
      : '.forge/project.json is missing; if this folder moves, the registry cannot follow it',
    [{ kind: 'file', ref: markerPath }],
  );

  /* ----------------------------------------------------------- CLAUDE.md */
  const claudeMdPath = path.join(canonicalPath, 'CLAUDE.md');
  const claudeMd = readTextSafe(claudeMdPath);
  add(
    'claude-md',
    'CLAUDE.md exists and is not empty',
    claudeMd.ok && claudeMd.value.trim().length > 0,
    claudeMd.ok
      ? claudeMd.value.trim().length > 0
        ? `${claudeMd.bytes} bytes${claudeMd.value.includes(CLAUDE_MD_BEGIN_MARKER) ? ', with the Forge managed block' : ', without a Forge managed block'}`
        : 'the file exists but is empty'
      : `could not be read (${claudeMd.reason})`,
    [{ kind: 'file', ref: claudeMdPath }],
  );

  /* ------------------------------------------------------------------ git */
  const availability = git.isAvailable();
  add(
    'git-available',
    'A working git executable was found',
    availability.available,
    availability.available
      ? `git ${availability.version ?? 'version unknown'} at ${availability.executablePath} (${availability.source})`
      : availability.detail,
    availability.executablePath === null ? [] : [{ kind: 'file', ref: availability.executablePath }],
  );

  let gitState: GitState | null = null;
  if (!availability.available) {
    // Not a failure of the project — a limit on what could be checked.
    add('git-repository', 'The project is its own git repository', null, 'git is unavailable, so this could not be checked');
    add('git-baseline-commit', 'The repository has at least one commit', null, 'git is unavailable, so this could not be checked');
    add('git-remote', 'Remote configuration', null, 'git is unavailable, so this could not be checked');
  } else {
    const statusResult = git.status(canonicalPath);
    gitState = statusResult.state;
    add(
      'git-repository',
      'The project is its own git repository',
      statusResult.state.initialized,
      statusResult.state.initialized
        ? `on branch ${statusResult.state.branch ?? '(detached)'} with ${statusResult.state.dirtyFiles} uncommitted change(s)`
        : statusResult.detail,
      statusResult.commands.map((command) => ({
        kind: 'exit-code' as const,
        ref: command.exitCode === null ? 'none' : String(command.exitCode),
        note: `git ${command.args.join(' ')}`,
      })),
    );

    if (!statusResult.state.initialized) {
      add('git-baseline-commit', 'The repository has at least one commit', null, 'there is no repository here to check');
      add('git-remote', 'Remote configuration', null, 'there is no repository here to check');
    } else {
      const hasCommit = statusResult.state.lastCommit !== null;
      const commitUndetermined = statusResult.undetermined.includes('lastCommit');
      add(
        'git-baseline-commit',
        'The repository has at least one commit',
        commitUndetermined ? null : hasCommit,
        commitUndetermined
          ? 'the commit could not be read'
          : hasCommit
            ? `HEAD is ${statusResult.state.lastCommit}`
            : 'the repository has no commits yet',
        [{ kind: 'file', ref: path.join(canonicalPath, '.git') }],
      );
      // Informational on purpose. Forge never creates a remote, but a project
      // the owner later connected to one is not thereby broken.
      const remoteUndetermined = statusResult.undetermined.includes('hasRemote');
      add(
        'git-remote',
        'Remote configuration',
        remoteUndetermined ? null : true,
        remoteUndetermined
          ? 'the remote configuration could not be read'
          : statusResult.state.hasRemote
            ? 'a remote is configured (not by Forge — Forge never adds one and never pushes)'
            : 'no remote is configured, as expected for a Forge-created project',
      );
    }
  }

  /* ---------------------------------------------------------- path length */
  const tooLong = exceedsWindowsMaxPath(canonicalPath);
  add(
    'path-length',
    'The project path is within the length many Windows tools accept',
    !tooLong,
    tooLong
      ? `the path is ${canonicalPath.length} characters, past the ${WINDOWS_MAX_PATH}-character limit some Windows tools enforce`
      : `${canonicalPath.length} characters`,
  );

  const passed = checks.filter((c) => c.ok === true).length;
  const failed = checks.filter((c) => c.ok === false).length;
  const undetermined = checks.filter((c) => c.ok === null).length;
  const verdict: DoctorReport['verdict'] = failed > 0 ? 'FAIL' : undetermined > 0 ? 'UNKNOWN' : 'PASS';
  const health: ProjectHealthState = verdict === 'PASS' ? 'HEALTHY' : verdict === 'FAIL' ? 'DEGRADED' : 'UNKNOWN';
  const finishedAt = now();

  return {
    projectId: options.projectId ?? null,
    canonicalPath,
    ranAt: startedAt.toISOString(),
    durationMs: Date.now() - startedMs,
    checks,
    passed,
    failed,
    undetermined,
    verdict,
    health,
    summary:
      `${verdict} — ${passed} passed, ${failed} failed, ${undetermined} undetermined ` +
      `of ${checks.length} checks at ${finishedAt.toISOString()}`,
    git: gitState,
  };
}

/* ========================================================================== */
/*  createProject                                                              */
/* ========================================================================== */

/**
 * The New Project flow.
 *
 * Never throws for an expected failure: the receipt is the result, and a
 * thrown exception would destroy the record of the steps that did succeed.
 */
export function createProject(
  registry: ProjectRegistry,
  store: ForgeStore,
  input: CreateProjectInput,
): CreateProjectResult {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const startedMs = Date.now();
  const steps = new StepLog(now);
  const notes: string[] = [];

  let slug: string | null = null;
  let canonicalPath: string | null = null;
  let projectId: string | null = null;
  let project: ProjectRecord | null = null;
  let doctor: DoctorReport | null = null;
  let directoryCreated = false;
  let firstError: CreationStepError | null = null;

  /**
   * The outcome is DERIVED from the recorded steps, never passed in.
   *
   * A caller able to name the outcome is a caller able to name the wrong one.
   * Reading it off the step log means CREATED is reachable only when all eleven
   * steps ran and all eleven succeeded — a skipped git step or a doctor that
   * could not check something lands on INCOMPLETE by construction.
   */
  const finish = (): CreateProjectResult => {
    const finalSteps = steps.finalise();
    const failedStep = finalSteps.find((step) => step.status === 'FAILED');
    const fatalFailure = finalSteps.some((step) => step.status === 'FAILED' && FATAL_STEPS.has(step.id));
    const outcome: CreationOutcome =
      fatalFailure || project === null
        ? 'FAILED'
        : finalSteps.every((step) => step.status === 'SUCCEEDED')
          ? 'CREATED'
          : 'INCOMPLETE';
    const rollback = directoryCreated && outcome === 'FAILED' && canonicalPath !== null
      ? attemptRollback(canonicalPath, registry.projectsRoot, input.rollbackOnFailure === true)
      : null;
    const finishedAt = now();
    const availability = git.isAvailable();

    const receipt: CreationReceipt = {
      receiptVersion: 1,
      receiptId: randomUUID(),
      outcome,
      requestedName: typeof input.displayName === 'string' ? input.displayName : String(input.displayName),
      projectId,
      slug,
      canonicalPath,
      projectsRoot: registry.projectsRoot,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Date.now() - startedMs,
      steps: finalSteps,
      stepsSucceeded: finalSteps.filter((s) => s.status === 'SUCCEEDED').length,
      stepsFailed: finalSteps.filter((s) => s.status === 'FAILED').length,
      stepsSkipped: finalSteps.filter((s) => s.status === 'SKIPPED').length,
      stepsNotReached: finalSteps.filter((s) => s.status === 'NOT_REACHED').length,
      failedAtStep: failedStep?.number ?? null,
      leftOnDisk:
        directoryCreated && outcome === 'FAILED' && rollback?.removed !== true ? canonicalPath : null,
      rollback,
      environment: {
        node: process.version,
        platform: process.platform,
        gitAvailable: availability.available,
        gitExecutablePath: availability.executablePath,
        gitVersion: availability.version,
        bridgeInstanceId: store.bridgeInstanceId,
      },
      doctor,
      notes,
    };

    const receiptPaths = writeReceipt(store, receipt, canonicalPath, notes);
    return { outcome, project, receipt, receiptPaths, error: firstError };
  };

  const failWith = (error: CreationStepError, detail: string, data?: Record<string, unknown>): void => {
    if (firstError === null) firstError = error;
    steps.fail(error, detail, data ?? null);
  };

  /* ------------------------------------------------- 1. validate the name */
  steps.begin('validate-name');
  const inspection = inspectSlug(input.displayName);
  if (!inspection.ok) {
    failWith(
      { code: inspection.code, message: inspection.reason },
      'the requested display name was refused by the path guard',
      { requestedName: typeof input.displayName === 'string' ? input.displayName.slice(0, 200) : typeof input.displayName },
    );
    return finish();
  }
  steps.succeed('the display name passed every path-guard check', {
    length: input.displayName.length,
    notes: inspection.notes,
  });

  /* ---------------------------------------------------- 2. sanitise a slug */
  steps.begin('sanitize-slug');
  slug = inspection.slug;
  steps.succeed(`the name reduced to the single path segment "${slug}"`, {
    slug,
    rewrites: inspection.notes,
  });
  if (inspection.notes.length > 0) {
    notes.push(`the folder name differs from the display name: ${inspection.notes.join('; ')}`);
  }

  /* ------------------------------------------- 3. prove the path is inside */
  steps.begin('assert-inside-root');
  let projectsRoot = registry.projectsRoot;
  let rootCreated = false;
  try {
    if (!directoryExists(projectsRoot) && input.ensureRoot !== false) {
      const ensured = ensureProjectsRoot();
      rootCreated = ensured.created;
      if (!samePath(ensured.projectsRoot, projectsRoot)) {
        failWith(
          {
            code: 'OUTSIDE_TRUSTED_ROOT',
            message: 'The projects root the registry was built with is not the one the path guard resolves to.',
            detail: `registry: ${projectsRoot} · guard: ${ensured.projectsRoot}`,
          },
          'refusing to create a project under a root the guard did not confirm',
        );
        return finish();
      }
      projectsRoot = ensured.projectsRoot;
    }
    // The guard's RETURN value is what everything below uses. The string built
    // here is an input to the check, never the path that gets acted on.
    canonicalPath = assertInsideRoot(path.join(projectsRoot, slug), projectsRoot);
  } catch (error) {
    if (isPathGuardError(error)) {
      failWith({ code: error.code, message: error.message, ...(error.detail !== undefined ? { detail: error.detail } : {}) },
        'the target path did not survive the trusted-root check');
    } else {
      failWith({ code: 'PATH_REJECTED', message: 'The target path could not be validated.', detail: errorMessage(error) },
        'the target path did not survive the trusted-root check');
    }
    return finish();
  }
  steps.succeed(`the target path resolves inside the trusted root`, {
    projectsRoot,
    rootCreated,
    canonicalPath,
    exceedsWindowsMaxPath: exceedsWindowsMaxPath(canonicalPath),
  }, [{ kind: 'file', ref: canonicalPath, note: 'the canonical path the guard returned' }]);

  /* --------------------------------------------------- 4. collision checks */
  steps.begin('collision-check');
  const availabilityReport = registry.checkAvailability({ displayName: input.displayName, canonicalPath });
  const directoryAlreadyThere = directoryExists(canonicalPath);
  if (availabilityReport.hardBlock !== null) {
    failWith({ code: 'CONFLICT', message: availabilityReport.hardBlock },
      'the name or path collides with a project that already exists', { report: availabilityReport });
    return finish();
  }
  if (directoryAlreadyThere) {
    failWith(
      {
        code: 'CONFLICT',
        message: `A folder already exists at ${canonicalPath}.`,
        detail: 'the flow will not adopt or overwrite an existing folder; import it instead',
      },
      'the target directory already exists on disk',
    );
    return finish();
  }
  if (availabilityReport.softBlock !== null && input.allowConfusable !== true) {
    failWith(
      { code: 'CONFLICT', message: `${availabilityReport.softBlock} Creating it anyway needs an explicit owner override.` },
      'the name is visually indistinguishable from an existing project',
      { report: availabilityReport },
    );
    return finish();
  }
  if (availabilityReport.softBlock !== null) {
    notes.push(`a look-alike name was accepted under an explicit override: ${availabilityReport.softBlock}`);
  }
  steps.succeed('no duplicate path and no blocking name collision', {
    duplicateCanonicalPath: availabilityReport.duplicateCanonicalPath,
    slugCollisions: availabilityReport.slugCollisions,
    displayNameCollisions: availabilityReport.displayNameCollisions,
    overrideUsed: availabilityReport.softBlock !== null,
  });

  /* -------------------------------------------------------- 5. generate id */
  steps.begin('generate-id');
  projectId = randomUUID();
  steps.succeed('a permanent project id was generated', { projectId, source: 'crypto.randomUUID' });

  const createdAtIso = now().toISOString();
  const context: ScaffoldContext = {
    id: projectId,
    displayName: input.displayName,
    slug,
    canonicalPath,
    createdAt: createdAtIso,
    type: typeof input.type === 'string' && input.type.trim().length > 0 ? input.type.trim().toLowerCase() : UNKNOWN_PROJECT_TYPE,
    description: typeof input.description === 'string' ? input.description : '',
  };

  /* ------------------------------------------------------------- 6. mkdir */
  steps.begin('create-directory');
  try {
    // Not recursive: the parent was proven above, and `recursive: true` would
    // happily invent a whole tree if that proof were ever wrong.
    mkdirSync(canonicalPath);
    directoryCreated = true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    failWith(
      {
        code: code === 'EEXIST' ? 'CONFLICT' : 'RUNTIME_ERROR',
        message: code === 'EEXIST' ? 'A folder appeared at that path while the project was being created.' : 'The project directory could not be created.',
        detail: `${code ?? 'unknown error'}: ${errorMessage(error)}`,
      },
      'mkdir failed',
    );
    return finish();
  }
  // Re-check AFTER creation: this is the only step that can catch a link
  // raced into place between the check above and the mkdir.
  try {
    const recheck = assertInsideRoot(canonicalPath, projectsRoot);
    if (!samePath(recheck, canonicalPath)) {
      failWith(
        { code: 'OUTSIDE_TRUSTED_ROOT', message: 'The directory that was created does not resolve to the path that was checked.', detail: `${canonicalPath} -> ${recheck}` },
        'the post-creation containment re-check failed',
      );
      return finish();
    }
  } catch (error) {
    failWith(
      { code: 'OUTSIDE_TRUSTED_ROOT', message: 'The created directory failed the containment re-check.', detail: errorMessage(error) },
      'the post-creation containment re-check failed',
    );
    return finish();
  }
  steps.succeed('the project directory was created and re-verified inside the trusted root', { canonicalPath }, [
    { kind: 'file', ref: canonicalPath },
  ]);

  /* --------------------------------------------- 7. the Forge structure */
  steps.begin('forge-structure');
  const written: string[] = [];
  const structureFailures: string[] = [];
  try {
    ensureDir(path.join(canonicalPath, '.claude'));
    for (const name of FORGE_CLAUDE_SUBDIRECTORIES) {
      ensureDir(path.join(canonicalPath, '.claude', name));
    }
    ensureDir(path.join(canonicalPath, '.forge'));
    ensureDir(path.join(canonicalPath, '.forge', 'receipts'));

    for (const file of scaffoldFiles(context)) {
      const target = path.join(canonicalPath, ...file.relativePath.split('/'));
      try {
        writeAtomic(target, file.content);
        written.push(file.relativePath);
      } catch (error) {
        structureFailures.push(`${file.relativePath}: ${errorMessage(error)}`);
      }
    }

    const marker: ProjectMarker = {
      markerSchemaVersion: PROJECT_MARKER_SCHEMA_VERSION,
      projectId,
      slug,
      displayName: input.displayName,
      createdAt: createdAtIso,
      createdBy: 'forge-bridge/create',
    };
    const markerWrite = writeProjectMarker(canonicalPath, marker);
    if (markerWrite.ok) written.push('.forge/project.json');
    else structureFailures.push(`.forge/project.json: ${markerWrite.detail}`);
  } catch (error) {
    structureFailures.push(errorMessage(error));
  }

  if (structureFailures.length > 0) {
    failWith(
      { code: 'RUNTIME_ERROR', message: 'The Forge project structure could not be written completely.', detail: structureFailures.join(' | ') },
      `${written.length} file(s) were written, ${structureFailures.length} failed`,
      { written, failures: structureFailures },
    );
    return finish();
  }
  const projectDirectory = canonicalPath;
  steps.succeed(
    `${FORGE_CLAUDE_SUBDIRECTORIES.length + 2} directories and ${written.length} files were written`,
    { directories: FORGE_CLAUDE_SUBDIRECTORIES, files: written },
    written.map((relative) => ({ kind: 'file' as const, ref: path.join(projectDirectory, relative) })),
  );

  /* ----------------------------------------------------------- 8. CLAUDE.md */
  steps.begin('claude-md');
  const claudeMd = mergeClaudeMd(canonicalPath, context);
  if (!claudeMd.ok) {
    failWith({ code: 'RUNTIME_ERROR', message: 'CLAUDE.md could not be created or merged.', detail: claudeMd.detail },
      claudeMd.detail, { merge: claudeMd });
    return finish();
  }
  steps.succeed(claudeMd.detail, { merge: claudeMd }, [
    { kind: 'file', ref: claudeMd.filePath, ...(claudeMd.resultHash !== null ? { hash: claudeMd.resultHash } : {}) },
  ]);

  /* ------------------------------------------------------------ 9. register */
  steps.begin('register');
  const registration = registry.register({
    displayName: input.displayName,
    slug,
    canonicalPath,
    id: projectId,
    type: context.type,
    description: context.description,
    forgeVersion: FORGE_TEMPLATE_VERSION,
    templateVersion: FORGE_TEMPLATE_VERSION,
    git: emptyGitState(),
    origin: 'created',
    allowConfusable: input.allowConfusable === true,
    createdAt: createdAtIso,
  });
  if (!registration.ok) {
    failWith(
      {
        code: registration.error.code satisfies RegistryErrorCode,
        message: registration.error.message,
        ...(registration.error.detail !== undefined ? { detail: registration.error.detail } : {}),
      },
      'the project exists on disk but could not be added to the registry',
    );
    return finish();
  }
  project = registration.value;
  notes.push(...registration.notes);
  steps.succeed('the project was added to the canonical index', { projectId: project.id, health: project.health }, [
    { kind: 'file', ref: `records/project/${project.id}.json` },
  ]);

  /* ----------------------------------------------------------------- 10. git */
  steps.begin('git');
  if (input.skipGit === true) {
    steps.skip('the caller asked for the project to be created without git', { reason: 'skipGit' });
  } else {
    const gitOutcome = initialiseGit(canonicalPath, input, context);
    if (gitOutcome.ok) {
      steps.succeed(gitOutcome.detail, gitOutcome.data, gitOutcome.evidenceRefs);
    } else {
      // NOT fatal: the project exists, is scaffolded and is registered. The
      // receipt says git failed and the doctor will report the same thing, so
      // nothing downstream can mistake this for a complete creation.
      steps.fail(
        { code: 'RUNTIME_ERROR', message: 'The git baseline could not be established.', detail: gitOutcome.detail },
        gitOutcome.detail,
        gitOutcome.data,
        gitOutcome.evidenceRefs,
      );
      if (firstError === null) {
        firstError = { code: 'RUNTIME_ERROR', message: 'The git baseline could not be established.', detail: gitOutcome.detail };
      }
    }
    if (gitOutcome.state !== null) {
      const stored = registry.setGitState(project.id, gitOutcome.state, gitOutcome.evidenceRefs);
      if (stored.ok) project = stored.value;
      else notes.push(`the git state was read but could not be stored: ${stored.error.message}`);
    }
  }

  /* -------------------------------------------------------------- 11. doctor */
  steps.begin('doctor');
  doctor = runProjectDoctor(canonicalPath, { projectId: project.id, now });
  const healthRefs: readonly EvidenceRef[] = [
    { kind: 'file', ref: canonicalPath, note: 'the directory the doctor inspected' },
    ...doctor.checks.flatMap((check) => check.evidenceRefs).slice(0, 8),
  ];
  const healthApplied = registry.setHealth(project.id, doctor.health, {
    summary: doctor.summary,
    evidenceRefs: healthRefs,
  });
  if (healthApplied.ok) project = healthApplied.value;
  else notes.push(`the doctor ran but its verdict could not be stored: ${healthApplied.error.message}`);

  if (doctor.verdict === 'FAIL') {
    steps.fail(
      { code: 'INVALID_STATE', message: 'The doctor check found problems with the project that was just created.', detail: doctor.summary },
      doctor.summary,
      { doctor },
      healthRefs,
    );
    if (firstError === null) {
      firstError = { code: 'INVALID_STATE', message: 'The doctor check found problems with the project that was just created.', detail: doctor.summary };
    }
  } else {
    steps.succeed(doctor.summary, { doctor }, healthRefs);
  }

  return finish();
}

/* ========================================================================== */
/*  Git baseline                                                               */
/* ========================================================================== */

interface GitOutcome {
  readonly ok: boolean;
  readonly detail: string;
  readonly data: Record<string, unknown>;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly state: GitState | null;
}

/**
 * `git init`, a `.gitignore`, and one baseline commit. Nothing else.
 *
 * No remote is added and nothing is pushed — the wrapper this calls cannot do
 * either. The commit identity is the owner's configured one when git has one;
 * on a machine where it does not (this one), an explicit fallback identity is
 * used for that single invocation and recorded as a fallback, so the commit is
 * never presented as the owner's own work.
 */
function initialiseGit(
  projectDirectory: string,
  input: CreateProjectInput,
  context: ScaffoldContext,
): GitOutcome {
  const evidenceRefs: EvidenceRef[] = [];
  const data: Record<string, unknown> = {};

  const availability = git.isAvailable();
  data.git = {
    available: availability.available,
    version: availability.version,
    executablePath: availability.executablePath,
    source: availability.source,
  };
  if (!availability.available) {
    return {
      ok: false,
      detail: `git is not available, so no repository was created: ${availability.detail}`,
      data,
      evidenceRefs,
      state: null,
    };
  }

  const record = (label: string, result: git.GitCommandResult): void => {
    evidenceRefs.push({
      kind: 'exit-code',
      ref: result.exitCode === null ? 'none' : String(result.exitCode),
      note: `${label}: git ${result.args.join(' ')}`,
    });
  };

  const initResult = git.init(projectDirectory, {
    ...(input.initialBranch !== undefined ? { initialBranch: input.initialBranch } : {}),
  });
  record('init', initResult);
  data.init = { exitCode: initResult.exitCode, ok: initResult.ok, stderr: initResult.stderr };
  if (!initResult.ok) {
    return {
      ok: false,
      detail: `git init failed (exit ${String(initResult.exitCode)}): ${initResult.failure ?? initResult.stderr}`,
      data,
      evidenceRefs,
      state: null,
    };
  }

  const gitignore = mergeGitignore(projectDirectory);
  data.gitignore = gitignore;
  evidenceRefs.push({ kind: 'file', ref: gitignore.filePath });
  if (!gitignore.ok) {
    return { ok: false, detail: `the .gitignore could not be written: ${gitignore.detail}`, data, evidenceRefs, state: null };
  }

  const addResult = git.addAll(projectDirectory);
  record('add', addResult);
  data.add = { exitCode: addResult.exitCode, ok: addResult.ok, stderr: addResult.stderr };
  if (!addResult.ok) {
    return {
      ok: false,
      detail: `git add failed (exit ${String(addResult.exitCode)}): ${addResult.failure ?? addResult.stderr}`,
      data,
      evidenceRefs,
      state: readState(projectDirectory, data),
    };
  }

  const identity = git.configuredIdentity(projectDirectory);
  const author = input.gitAuthor ?? (identity.complete ? undefined : FALLBACK_GIT_AUTHOR);
  data.identity = {
    configured: identity.complete,
    usedFallback: author === FALLBACK_GIT_AUTHOR,
    source: input.gitAuthor !== undefined ? 'caller' : identity.complete ? 'git config' : 'forge fallback',
  };

  const commitResult = git.commit(projectDirectory, `Baseline: ${context.displayName}`, {
    ...(author !== undefined ? { author } : {}),
  });
  record('commit', commitResult);
  data.commit = { exitCode: commitResult.exitCode, ok: commitResult.ok, stderr: commitResult.stderr };
  if (!commitResult.ok) {
    return {
      ok: false,
      detail: `the baseline commit failed (exit ${String(commitResult.exitCode)}): ${commitResult.failure ?? commitResult.stderr}`,
      data,
      evidenceRefs,
      state: readState(projectDirectory, data),
    };
  }

  const state = readState(projectDirectory, data);
  if (state === null) {
    return { ok: false, detail: 'the commit succeeded but the resulting git state could not be read', data, evidenceRefs, state: null };
  }
  if (state.lastCommit === null) {
    // Exit 0 from `git commit` is not by itself proof that a commit exists.
    return {
      ok: false,
      detail: 'git commit exited zero but the repository still reports no commit; the baseline is not verified',
      data,
      evidenceRefs,
      state,
    };
  }
  if (state.hasRemote) {
    return {
      ok: false,
      detail: 'a remote is configured on a repository this flow just created; Forge never adds one, so this is unexpected and is reported rather than ignored',
      data,
      evidenceRefs,
      state,
    };
  }

  return {
    ok: true,
    detail: `initialised on branch ${state.branch ?? '(unknown)'} with baseline commit ${state.lastCommit.slice(0, 12)} and no remote`,
    data,
    evidenceRefs,
    state,
  };
}

function readState(projectDirectory: string, data: Record<string, unknown>): GitState | null {
  const result = git.status(projectDirectory);
  data.status = { ok: result.ok, undetermined: result.undetermined, detail: result.detail };
  return result.state.initialized ? result.state : null;
}

/* ========================================================================== */
/*  Rollback and the receipt file                                              */
/* ========================================================================== */

/**
 * Remove a directory this flow created, and only when asked to.
 *
 * The default is to leave it. A recursive delete is irreversible, and the
 * failure modes that get here — a full disk, a permissions problem, a file
 * locked by another process — are all ones where the owner is better served by
 * a folder they can inspect than by a folder that silently disappeared.
 */
function attemptRollback(
  directory: string,
  projectsRoot: string,
  requested: boolean,
): { readonly attempted: boolean; readonly removed: boolean; readonly detail: string } {
  if (!requested) {
    return {
      attempted: false,
      removed: false,
      detail: `the partially created directory was left in place at ${directory} (rollbackOnFailure was not requested)`,
    };
  }
  try {
    // Never trust the string we are holding: re-prove containment, and refuse
    // outright to remove the root itself.
    const confirmed = assertInsideRoot(directory, projectsRoot);
    if (samePath(confirmed, projectsRoot)) {
      return { attempted: true, removed: false, detail: 'refused to remove the projects root itself' };
    }
    rmSync(confirmed, { recursive: true, force: false, maxRetries: 2 });
    return { attempted: true, removed: !directoryExists(confirmed), detail: `removed ${confirmed}` };
  } catch (error) {
    return { attempted: true, removed: false, detail: `rollback failed: ${errorMessage(error)}` };
  }
}

/**
 * Write the receipt.
 *
 * The workspace copy is the primary one: it survives the project folder being
 * deleted, and it exists even when the failure was that the folder could not be
 * created. The in-project copy is a convenience and is best-effort.
 */
function writeReceipt(
  store: ForgeStore,
  receipt: CreationReceipt,
  projectDirectory: string | null,
  notes: string[],
): readonly string[] {
  const filename = `creation-${receipt.startedAt.replace(/[:.]/g, '-')}-${receipt.receiptId.slice(0, 8)}.json`;
  const written: string[] = [];

  const workspacePath = path.join(store.dataDir, 'receipts', filename);
  try {
    writeJsonAtomic(workspacePath, receipt);
    written.push(workspacePath);
  } catch (error) {
    notes.push(`the creation receipt could not be written to the workspace: ${errorMessage(error)}`);
  }

  if (projectDirectory !== null && directoryExists(projectDirectory)) {
    const projectPath = path.join(projectDirectory, '.forge', 'receipts', filename);
    try {
      writeJsonAtomic(projectPath, receipt);
      written.push(projectPath);
    } catch (error) {
      notes.push(`the creation receipt could not be written into the project: ${errorMessage(error)}`);
    }
  }

  return written;
}

/* ========================================================================== */
/*  Helpers                                                                    */
/* ========================================================================== */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
