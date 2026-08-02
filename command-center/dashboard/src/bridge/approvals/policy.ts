/**
 * Forge Workspace — the approval policy.
 *
 * One question, answered honestly for every risky thing the run lifecycle might
 * attempt: DOES THIS NEED THE OWNER'S PERMISSION FIRST, and how bad is it if it
 * goes wrong? The answer is a `PolicyDecision` — a risk level, the category it
 * fell into, a sentence a person can read, and a single boolean the gate keys on.
 *
 * THREE PROPERTIES THIS FILE HOLDS.
 *
 * 1. STRUCTURED INTENT, NEVER A COMMAND STRING. Nothing here parses a shell line.
 *    A `ProposedAction` is a typed description of what the bridge is about to do —
 *    delete this path, push to that remote, write to a live database — produced by
 *    the bridge at the point the action is attempted. The browser never gets to
 *    hand the policy a command to interpret, because the bridge never accepts one.
 *
 * 2. PURE AND TOTAL. Zero I/O, no clock, no randomness. `classifyAction` is a
 *    total function over the discriminated union, so a new action shape that is
 *    added without a classification is a compile error, not a silent LOW.
 *
 * 3. THE DANGEROUS DEFAULT IS SAFE. When a category matches, the risk is the
 *    higher of the plausible readings, and HIGH/CRITICAL always gate. An action
 *    the policy cannot place is not waved through as CRITICAL noise, but nor is a
 *    genuinely risky family ever quietly downgraded below the level that gates it.
 *
 * The gate reads only `requiresApproval` and `risk`; everything else on the
 * decision exists to fill the owner-facing approval card with something specific,
 * because a yes/no dialog with no content trains an owner to click yes.
 */

import type { RiskLevel } from '../../shared/protocol.ts';

/* ========================================================================== */
/*  The gating rule                                                            */
/* ========================================================================== */

/**
 * The risks that may not proceed without an explicit owner verdict. This mirrors
 * the same rule the approval operations enforce (`APPROVAL_REQUIRED_RISKS` in
 * operations/approvals.ts): LOW and MEDIUM actions are recorded and allowed;
 * HIGH and CRITICAL are gated. Every category the mission requires approval for
 * is classified as HIGH or CRITICAL below, so this one rule covers all of them.
 */
export const APPROVAL_REQUIRED_RISKS: readonly RiskLevel[] = ['HIGH', 'CRITICAL'];

export function requiresApproval(risk: RiskLevel): boolean {
  return APPROVAL_REQUIRED_RISKS.includes(risk);
}

/* ========================================================================== */
/*  Categories and the decision                                               */
/* ========================================================================== */

/**
 * The families the mission requires approval for, plus `UNCLASSIFIED` for an
 * action that matched no gated family (it still carries a risk, it is simply not
 * gated).
 */
export type ActionCategory =
  | 'DELETE_PROJECT'
  | 'DELETE_IMPORTANT_FILE'
  | 'COMMAND_OUTSIDE_TRUSTED_ROOT'
  | 'PUBLISH_OR_DEPLOY'
  | 'REMOTE_REPO_CREATION'
  | 'LAN_EXPOSURE'
  | 'REMOTE_ACCESS'
  | 'EXTERNAL_COMMS'
  | 'LIVE_DB_DESTRUCTIVE'
  | 'PAYMENT'
  | 'LIVE_SERVICE_MODIFICATION'
  | 'HIGH_RISK_DEPENDENCY_INSTALL'
  | 'CREDENTIAL_ACCESS'
  | 'GLOBAL_SYSTEM_CHANGE'
  | 'BROAD_FILESYSTEM_ACCESS'
  | 'UNCLASSIFIED';

export const ACTION_CATEGORIES: readonly ActionCategory[] = [
  'DELETE_PROJECT',
  'DELETE_IMPORTANT_FILE',
  'COMMAND_OUTSIDE_TRUSTED_ROOT',
  'PUBLISH_OR_DEPLOY',
  'REMOTE_REPO_CREATION',
  'LAN_EXPOSURE',
  'REMOTE_ACCESS',
  'EXTERNAL_COMMS',
  'LIVE_DB_DESTRUCTIVE',
  'PAYMENT',
  'LIVE_SERVICE_MODIFICATION',
  'HIGH_RISK_DEPENDENCY_INSTALL',
  'CREDENTIAL_ACCESS',
  'GLOBAL_SYSTEM_CHANGE',
  'BROAD_FILESYSTEM_ACCESS',
  'UNCLASSIFIED',
];

export interface PolicyDecision {
  /** The one field the gate keys on. True exactly when `risk` is HIGH or CRITICAL. */
  readonly requiresApproval: boolean;
  readonly risk: RiskLevel;
  readonly category: ActionCategory;
  /** A full sentence for the approval card. Names what is at stake. */
  readonly reason: string;
  /** A short owner-facing label, used as the request's `action` when none is given. */
  readonly summary: string;
}

/* ========================================================================== */
/*  The proposed action — a structured intent, never a command string          */
/* ========================================================================== */

/** One path an action would touch, with the facts the policy classifies on. */
export interface FsTarget {
  /** Project-relative where possible; only ever inside the trusted root when safe. */
  readonly path: string;
  /** This target IS the project root — deleting it deletes the whole project. */
  readonly isProjectRoot?: boolean;
  /** A protected file: `.git`, a lockfile, a config, an `.env`, a source of truth. */
  readonly important?: boolean;
  /** This path resolved OUTSIDE the project's trusted root. */
  readonly outsideTrustedRoot?: boolean;
  /** A directory tree or glob, not a single named file. */
  readonly broad?: boolean;
}

export interface FilesystemAction {
  readonly type: 'filesystem';
  readonly operation: 'delete' | 'write' | 'read' | 'move';
  /** True only when EVERY target resolves inside the project's trusted root. */
  readonly withinTrustedRoot: boolean;
  readonly targets: readonly FsTarget[];
}

export interface CommandAction {
  readonly type: 'command';
  /** True only when the working directory is inside the trusted root. */
  readonly withinTrustedRoot: boolean;
  readonly cwdOutsideTrustedRoot?: boolean;
  readonly touchesPathsOutsideRoot?: boolean;
}

export interface GitAction {
  readonly type: 'git';
  readonly operation:
    | 'push'
    | 'publish'
    | 'deploy'
    | 'create-remote'
    | 'add-remote'
    | 'commit'
    | 'branch'
    | 'status';
  readonly remote?: boolean;
}

export interface NetworkAction {
  readonly type: 'network';
  readonly operation: 'expose-lan' | 'enable-remote-access' | 'outbound-message' | 'outbound-fetch';
  /** For an outbound fetch: is the destination external to this machine? Defaults true. */
  readonly recipientExternal?: boolean;
}

export interface DatabaseAction {
  readonly type: 'database';
  readonly environment: 'live' | 'production' | 'staging' | 'local' | 'test';
  /** A drop/delete/truncate/alter — something that destroys or reshapes data. */
  readonly destructive: boolean;
}

export interface PaymentAction {
  readonly type: 'payment';
  /** Real money vs a sandbox. Defaults to real money (the safe assumption). */
  readonly live?: boolean;
}

export interface ServiceAction {
  readonly type: 'service';
  readonly environment: 'live' | 'production' | 'staging' | 'local';
  readonly operation: 'modify' | 'restart' | 'scale' | 'delete' | 'deploy';
}

export interface DependencyAction {
  readonly type: 'dependency';
  readonly scope: 'global' | 'project';
  readonly source?: 'registry' | 'git' | 'url' | 'local';
  readonly runsInstallScripts?: boolean;
  /** An explicit "this one is dangerous" flag the caller can raise. */
  readonly highRisk?: boolean;
}

export interface CredentialAction {
  readonly type: 'credential';
  readonly operation: 'read' | 'write' | 'list';
  readonly target: 'env' | 'keychain' | 'secret-file' | 'token';
}

export interface SystemAction {
  readonly type: 'system';
  readonly operation: 'env' | 'path' | 'registry' | 'service-install' | 'package-global' | 'permissions';
}

export type ProposedAction =
  | FilesystemAction
  | CommandAction
  | GitAction
  | NetworkAction
  | DatabaseAction
  | PaymentAction
  | ServiceAction
  | DependencyAction
  | CredentialAction
  | SystemAction;

/* ========================================================================== */
/*  Classification                                                            */
/* ========================================================================== */

function decide(category: ActionCategory, risk: RiskLevel, summary: string, reason: string): PolicyDecision {
  return { category, risk, summary, reason, requiresApproval: requiresApproval(risk) };
}

function classifyFilesystem(a: FilesystemAction): PolicyDecision {
  const anyProjectRoot = a.targets.some((t) => t.isProjectRoot === true);
  const anyOutside = !a.withinTrustedRoot || a.targets.some((t) => t.outsideTrustedRoot === true);
  const anyImportant = a.targets.some((t) => t.important === true);
  const anyBroad = a.targets.some((t) => t.broad === true);

  if (a.operation === 'delete' && anyProjectRoot) {
    return decide(
      'DELETE_PROJECT',
      'CRITICAL',
      'Delete a project',
      'Deleting a project removes its entire tree and its history; there is no in-workspace undo, so the owner must confirm it.',
    );
  }
  if (anyOutside) {
    return decide(
      'BROAD_FILESYSTEM_ACCESS',
      'HIGH',
      'Touch files outside the trusted root',
      'At least one target resolves outside the project trusted root, so this reaches files the workspace does not own.',
    );
  }
  if (a.operation === 'delete' && anyImportant) {
    return decide(
      'DELETE_IMPORTANT_FILE',
      'HIGH',
      'Delete a protected file',
      'Deleting a protected file (version control, configuration, a lockfile or a secret) can break the project irreversibly.',
    );
  }
  if (anyBroad) {
    return decide(
      'BROAD_FILESYSTEM_ACCESS',
      'HIGH',
      'Operate on a broad path',
      'This targets a directory tree or glob rather than a single named file, so its blast radius is not bounded to one file.',
    );
  }
  const risk: RiskLevel = a.operation === 'read' ? 'LOW' : 'MEDIUM';
  return decide(
    'UNCLASSIFIED',
    risk,
    'A contained filesystem operation',
    'A single-file operation confined to the project trusted root; recorded but not gated.',
  );
}

function classifyCommand(a: CommandAction): PolicyDecision {
  const outside = !a.withinTrustedRoot || a.cwdOutsideTrustedRoot === true || a.touchesPathsOutsideRoot === true;
  if (outside) {
    return decide(
      'COMMAND_OUTSIDE_TRUSTED_ROOT',
      'HIGH',
      'Run a command outside the trusted root',
      'This command would run against, or from, a location outside the project trusted root, so its effects are not contained.',
    );
  }
  return decide(
    'UNCLASSIFIED',
    'LOW',
    'A command inside the trusted root',
    'A command confined to the project trusted root; recorded but not gated.',
  );
}

function classifyGit(a: GitAction): PolicyDecision {
  switch (a.operation) {
    case 'push':
    case 'publish':
    case 'deploy':
      return decide(
        'PUBLISH_OR_DEPLOY',
        'HIGH',
        'Publish, push or deploy',
        'Publishing, pushing or deploying makes local work public or live, which cannot be quietly taken back.',
      );
    case 'create-remote':
    case 'add-remote':
      return decide(
        'REMOTE_REPO_CREATION',
        'HIGH',
        'Create or attach a remote repository',
        'Creating or attaching a remote repository establishes an external destination for this code, which the owner must intend.',
      );
    case 'commit':
    case 'branch':
    case 'status':
      return decide(
        'UNCLASSIFIED',
        'LOW',
        'A local git operation',
        'A local, in-repository git operation with no external effect; recorded but not gated.',
      );
  }
}

function classifyNetwork(a: NetworkAction): PolicyDecision {
  switch (a.operation) {
    case 'expose-lan':
      return decide(
        'LAN_EXPOSURE',
        'CRITICAL',
        'Expose the workspace to the LAN',
        'Binding beyond loopback exposes the bridge to other machines on the network, contradicting the local-only invariant.',
      );
    case 'enable-remote-access':
      return decide(
        'REMOTE_ACCESS',
        'CRITICAL',
        'Enable remote access',
        'Opening a tunnel, proxy or relay lets a remote party reach this workspace, which the bridge otherwise never permits.',
      );
    case 'outbound-message':
      return decide(
        'EXTERNAL_COMMS',
        'HIGH',
        'Send an external communication',
        'Sending a message to an external recipient (email, chat, webhook) leaves the machine and cannot be recalled.',
      );
    case 'outbound-fetch':
      return a.recipientExternal === false
        ? decide(
            'UNCLASSIFIED',
            'MEDIUM',
            'A local outbound fetch',
            'An outbound request to a local destination; recorded but not gated.',
          )
        : decide(
            'EXTERNAL_COMMS',
            'HIGH',
            'Reach an external network destination',
            'The bridge makes no outbound network calls except to the local CLI; reaching an external host is a deliberate exception.',
          );
  }
}

function classifyDatabase(a: DatabaseAction): PolicyDecision {
  const live = a.environment === 'live' || a.environment === 'production';
  if (live && a.destructive) {
    return decide(
      'LIVE_DB_DESTRUCTIVE',
      'CRITICAL',
      'Run a destructive operation on a live database',
      'A drop, delete, truncate or schema change against a live database can lose real data that no local checkpoint can restore.',
    );
  }
  if (live) {
    return decide(
      'UNCLASSIFIED',
      'MEDIUM',
      'A non-destructive live database operation',
      'A read or non-destructive operation against a live database; recorded but not gated.',
    );
  }
  if (a.destructive) {
    return decide(
      'UNCLASSIFIED',
      'MEDIUM',
      'A destructive non-live database operation',
      'A destructive operation against a non-live database; recorded but not gated.',
    );
  }
  return decide(
    'UNCLASSIFIED',
    'LOW',
    'A local database operation',
    'A database operation against a local or test environment; recorded but not gated.',
  );
}

function classifyPayment(a: PaymentAction): PolicyDecision {
  const live = a.live !== false;
  return decide(
    'PAYMENT',
    live ? 'CRITICAL' : 'HIGH',
    live ? 'Move real money' : 'Run a sandbox payment',
    live
      ? 'Initiating a real payment moves the owner’s money and cannot be undone from inside the workspace.'
      : 'A sandbox payment still exercises a payment flow the owner should explicitly authorise.',
  );
}

function classifyService(a: ServiceAction): PolicyDecision {
  const live = a.environment === 'live' || a.environment === 'production';
  if (live) {
    return decide(
      'LIVE_SERVICE_MODIFICATION',
      'CRITICAL',
      'Modify a live service',
      'Changing, restarting, scaling, deploying or deleting a live service affects something people are relying on right now.',
    );
  }
  if (a.environment === 'staging') {
    return decide(
      'UNCLASSIFIED',
      'MEDIUM',
      'Modify a staging service',
      'A change to a staging service; recorded but not gated.',
    );
  }
  return decide(
    'UNCLASSIFIED',
    'LOW',
    'Modify a local service',
    'A change to a local service; recorded but not gated.',
  );
}

function classifyDependency(a: DependencyAction): PolicyDecision {
  if (a.scope === 'global') {
    return decide(
      'GLOBAL_SYSTEM_CHANGE',
      'HIGH',
      'Install a global dependency',
      'A global install changes the machine outside the project and affects every other project on it.',
    );
  }
  const nonRegistry = a.source !== undefined && a.source !== 'registry';
  const risky = a.highRisk === true || a.runsInstallScripts === true || nonRegistry;
  if (risky) {
    return decide(
      'HIGH_RISK_DEPENDENCY_INSTALL',
      'HIGH',
      'Install a high-risk dependency',
      'This install runs setup scripts or pulls from a non-registry source, so it can execute arbitrary code at install time.',
    );
  }
  return decide(
    'UNCLASSIFIED',
    'MEDIUM',
    'Install a routine dependency',
    'A routine project dependency from the registry with no install scripts; recorded but not gated.',
  );
}

function classifyCredential(a: CredentialAction): PolicyDecision {
  return decide(
    'CREDENTIAL_ACCESS',
    'HIGH',
    a.operation === 'write' ? 'Write a credential' : 'Access a credential',
    `A ${a.operation} against a ${a.target} exposes or alters a secret, so the owner must authorise it before it happens.`,
  );
}

function classifySystem(a: SystemAction): PolicyDecision {
  const critical = a.operation === 'service-install' || a.operation === 'permissions' || a.operation === 'registry';
  return decide(
    'GLOBAL_SYSTEM_CHANGE',
    critical ? 'CRITICAL' : 'HIGH',
    'Change global system state',
    `A ${a.operation} change reaches outside the project and alters the machine’s global state.`,
  );
}

/**
 * Classify a single proposed action.
 *
 * Total over `ProposedAction`: the `never` in the default arm turns a new action
 * shape that is added without a classifier into a compile error rather than a
 * silent pass.
 */
export function classifyAction(action: ProposedAction): PolicyDecision {
  switch (action.type) {
    case 'filesystem':
      return classifyFilesystem(action);
    case 'command':
      return classifyCommand(action);
    case 'git':
      return classifyGit(action);
    case 'network':
      return classifyNetwork(action);
    case 'database':
      return classifyDatabase(action);
    case 'payment':
      return classifyPayment(action);
    case 'service':
      return classifyService(action);
    case 'dependency':
      return classifyDependency(action);
    case 'credential':
      return classifyCredential(action);
    case 'system':
      return classifySystem(action);
    default: {
      const exhaustive: never = action;
      throw new Error(`unclassifiable action: ${JSON.stringify(exhaustive)}`);
    }
  }
}
