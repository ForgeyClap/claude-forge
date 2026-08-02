/**
 * Forge Workspace — the state machines.
 *
 * This file exists to make a fake status structurally impossible.
 *
 * A status is a CLAIM ABOUT REALITY. Nothing here lets a claim appear because a
 * file exists, because a process was spawned, because stdout contained an
 * encouraging word, or because an event happened to be named `run.complete`.
 * There are exactly two ways for a state to change:
 *
 *   1. the transition is in the table for that machine, and
 *   2. the evidence gate for the target state passes.
 *
 * When either is untrue the honest answer is UNKNOWN / UNVERIFIED, and the
 * asserting functions throw a message that names precisely what was missing.
 *
 * Two shapes are exported for every gate. The bridge calls the `assert*` form,
 * because on the write side a missing fact must stop the write. The UI calls the
 * `check*` form, because on the read side a missing fact must be *explained*:
 * "not shown as RUNNING — no heartbeat since 00:41:12" is useful, a thrown
 * exception in a render is not.
 *
 * CONSTRAINTS THIS FILE HOLDS ITSELF TO
 * - Zero I/O. No clock, no filesystem, no network, no randomness. Every function
 *   is total and deterministic over its arguments — `now` and ids are passed in
 *   precisely so the whole file can be exhaustively unit- and property-tested.
 * - Zero runtime dependencies. The only import is `import type`, which is erased
 *   at compile time, so this module can be loaded by the browser bundle and by
 *   `node state-machines.ts` alike.
 * - Immutability. Every table and every attempt record is frozen. A terminal
 *   attempt cannot be edited into a non-terminal one, by anyone, ever.
 *
 * TOTALITY OVER THE CONTRACT
 * `protocol.ts` defines four state vocabularies: `OperationalStatus` (23),
 * `AttachmentState` (10), `ApprovalRequest['state']` (4) and
 * `ProjectHealthState` (5) — 42 states. Every one of them is assigned to exactly
 * one OWNING machine in the `*_STATE_HOME` maps below, and the compile-time
 * proofs (`*_COVERAGE_PROOF`) fail the build if a state is ever added to the
 * protocol without being given a home here.
 *
 * Ownership is not exclusivity of vocabulary: a task and a run are both allowed
 * to be RUNNING. Ownership says which machine DEFINES the meaning of a state and
 * therefore which transition table is authoritative for it. Reuse of a name by
 * another domain is deliberate and checked; invention of a name that is not in
 * the contract is a compile error.
 */

import type {
  ApprovalRequest,
  AttachmentState,
  EvidenceRef,
  OperationalStatus,
  ProjectHealthState,
  VerifyVerdict,
} from '@/shared/protocol';

/* ========================================================================== */
/*  Errors                                                                     */
/* ========================================================================== */

/** Why a transition was refused. Machine-readable so the UI can branch on it. */
export type TransitionRejection =
  | 'UNKNOWN_MACHINE'
  | 'UNKNOWN_FROM_STATE'
  | 'UNKNOWN_TO_STATE'
  | 'TERMINAL_STATE'
  | 'NOT_ALLOWED';

/** Thrown by every `assert*Transition`. Carries the data, not just a sentence. */
export class StateTransitionError extends Error {
  readonly machine: string;
  readonly from: string;
  readonly to: string;
  readonly allowed: readonly string[];
  readonly rejection: TransitionRejection;

  constructor(init: {
    machine: string;
    from: string;
    to: string;
    allowed: readonly string[];
    rejection: TransitionRejection;
    message: string;
  }) {
    super(init.message);
    this.name = 'StateTransitionError';
    this.machine = init.machine;
    this.from = init.from;
    this.to = init.to;
    this.allowed = Object.freeze([...init.allowed]);
    this.rejection = init.rejection;
    Object.setPrototypeOf(this, StateTransitionError.prototype);
  }
}

/** Thrown by every `assert*Evidence`. `missing` is the exact shortfall list. */
export class EvidenceError extends Error {
  readonly gate: EvidenceGateName;
  readonly missing: readonly string[];

  constructor(gate: EvidenceGateName, missing: readonly string[], message: string) {
    super(message);
    this.name = 'EvidenceError';
    this.gate = gate;
    this.missing = Object.freeze([...missing]);
    Object.setPrototypeOf(this, EvidenceError.prototype);
  }
}

/** Thrown when the attempt model itself is violated (mutating a terminal attempt). */
export class AttemptError extends Error {
  readonly runId: string;
  readonly attemptId: string;
  readonly problems: readonly string[];

  constructor(init: { runId: string; attemptId: string; problems: readonly string[]; message: string }) {
    super(init.message);
    this.name = 'AttemptError';
    this.runId = init.runId;
    this.attemptId = init.attemptId;
    this.problems = Object.freeze([...init.problems]);
    Object.setPrototypeOf(this, AttemptError.prototype);
  }
}

/* ========================================================================== */
/*  Machine primitives                                                         */
/* ========================================================================== */

/** The ten domains named by the contract. */
export type MachineId =
  | 'run'
  | 'task'
  | 'agent'
  | 'test'
  | 'permission'
  | 'attachment'
  | 'claude-session'
  | 'project'
  | 'artifact'
  | 'stream';

export const MACHINE_IDS = [
  'run',
  'task',
  'agent',
  'test',
  'permission',
  'attachment',
  'claude-session',
  'project',
  'artifact',
  'stream',
] as const satisfies readonly MachineId[];

/**
 * A machine is data, not behaviour: a frozen table plus the two facts a table
 * cannot express (where a lifecycle starts, and which states may never be left).
 * Keeping it inert is what allows a property test to enumerate it exhaustively.
 */
export interface StateMachine<S extends string = string> {
  readonly id: MachineId;
  readonly label: string;
  /** One sentence on what an instance of this machine actually is. */
  readonly description: string;
  readonly states: readonly S[];
  readonly initial: S;
  readonly terminal: readonly S[];
  /** Total map: every state has an entry, terminal states map to an empty list. */
  readonly transitions: { readonly [K in S]: readonly S[] };
}

interface MachineSpec<S extends string> {
  readonly id: MachineId;
  readonly label: string;
  readonly description: string;
  readonly states: readonly S[];
  readonly initial: S;
  readonly terminal: readonly S[];
  readonly transitions: { readonly [K in S]: readonly S[] };
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function defineMachine<S extends string>(spec: MachineSpec<S>): StateMachine<S> {
  const transitions = {} as { [K in S]: readonly S[] };
  for (const state of spec.states) {
    transitions[state] = freezeArray(spec.transitions[state]);
  }
  return Object.freeze({
    id: spec.id,
    label: spec.label,
    description: spec.description,
    states: freezeArray(spec.states),
    initial: spec.initial,
    terminal: freezeArray(spec.terminal),
    transitions: Object.freeze(transitions),
  });
}

/** The result of asking a machine about a transition without acting on it. */
export interface TransitionExplanation<S extends string = string> {
  readonly ok: boolean;
  readonly machine: MachineId;
  readonly from: S;
  readonly to: S;
  readonly allowed: readonly S[];
  readonly rejection: TransitionRejection | null;
  /** A sentence fit to show a person. Never contains a path or a secret. */
  readonly message: string;
}

function isDeclared<S extends string>(machine: StateMachine<S>, state: string): state is S {
  return (machine.states as readonly string[]).includes(state);
}

function allowedList<S extends string>(machine: StateMachine<S>, from: S): readonly S[] {
  return machine.transitions[from] ?? [];
}

/**
 * Extra sentences for the transitions that are wrong for an interesting reason.
 * Keyed `MACHINE:FROM->TO`. A generic "not allowed" is true but unhelpful; these
 * say what the system would have been lying about.
 */
const REJECTION_NOTES: Readonly<Record<string, string>> = Object.freeze({
  'run:CREATED->COMPLETED':
    'nothing has executed. A run reaches COMPLETED only through RUNNING, VERIFYING and REVIEWING.',
  'run:FAILED->COMPLETED':
    'a failed attempt is terminal. Completion after a failure requires REPAIRING/RETRYING inside a live attempt, or a new attempt via createRetryAttempt(), plus a fresh verification — never a relabelling of the failure.',
  'run:CANCELLED->RUNNING':
    'a cancelled attempt is immutable and can never be resurrected. Start a new attempt; attempt N stays CANCELLED forever.',
  'run:VERIFYING->COMPLETED':
    'no verdict exists yet. VERIFYING may only advance to REVIEWING, and only once a verification verdict has been recorded.',
  'run:COMPLETED->RUNNING':
    'a completed attempt is immutable. Re-running requires a new attempt with its own id and its own evidence.',
  'run:DISCONNECTED->COMPLETED':
    'the run was never reconciled. A disconnected run must pass through RECOVERING and be verified again before any completion claim is admissible.',
  'run:RUNNING->COMPLETED':
    'a run cannot complete straight out of execution. It must be VERIFIED and REVIEWED first — that is where the evidence is inspected.',
  'task:VERIFYING->COMPLETED': 'no verdict exists yet; VERIFYING may only advance to REVIEWING.',
  'attachment:SELECTED->READY':
    'the file was never validated, hashed, staged or indexed. READY means Claude Code may be pointed at it, which is exactly the claim that needs the pipeline behind it.',
  'attachment:REJECTED->READY': 'a rejected file cannot be re-labelled ready; stage it again as a new attachment.',
  'attachment:QUARANTINED->READY': 'a quarantined file cannot be released by a state change.',
  'permission:DENIED->APPROVED': 'a denial is final. Approval requires a new request with a new id.',
  'permission:EXPIRED->APPROVED': 'an expired request cannot be approved after the fact. Ask again.',
  'claude-session:DISCONNECTED->COMPLETED':
    'a lost session is not an ended session. COMPLETED requires an observed session end, which a disconnected session by definition did not produce.',
  'stream:DEGRADED->COMPLETED':
    'the stream has a known gap. It must recover (replay/reconcile) before any completion claim is honest.',
  'stream:DISCONNECTED->COMPLETED': 'a dropped stream did not finish; reconcile it first.',
  'artifact:CREATED->COMPLETED':
    'the artifact was declared but never inspected. Presence and hash are established in VERIFYING.',
  'artifact:ORPHANED->COMPLETED':
    'a missing artifact that reappears must be re-verified; its content is not assumed to be the content that went missing.',
});

/**
 * The non-throwing form. This is what a view calls when it wants to say why a
 * button is disabled instead of pretending the action does not exist.
 */
export function explainTransitionIn<S extends string>(
  machine: StateMachine<S>,
  from: string,
  to: string,
): TransitionExplanation<S> {
  const base = { machine: machine.id, from: from as S, to: to as S } as const;

  if (!isDeclared(machine, from)) {
    return {
      ...base,
      ok: false,
      allowed: [],
      rejection: 'UNKNOWN_FROM_STATE',
      message: `${machine.id}: "${from}" is not a state of the ${machine.label} machine. Declared states: ${machine.states.join(', ')}.`,
    };
  }
  const allowed = allowedList(machine, from);
  if (!isDeclared(machine, to)) {
    return {
      ...base,
      ok: false,
      allowed,
      rejection: 'UNKNOWN_TO_STATE',
      message: `${machine.id}: "${to}" is not a state of the ${machine.label} machine. Declared states: ${machine.states.join(', ')}.`,
    };
  }
  if ((machine.terminal as readonly string[]).includes(from)) {
    return {
      ...base,
      ok: false,
      allowed,
      rejection: 'TERMINAL_STATE',
      message:
        `${machine.id}: ${from} is terminal — nothing may leave it, so ${from} -> ${to} is refused. ` +
        (REJECTION_NOTES[`${machine.id}:${from}->${to}`] ?? 'Model the next step as a new attempt/record.'),
    };
  }
  if (!(allowed as readonly string[]).includes(to)) {
    const note = REJECTION_NOTES[`${machine.id}:${from}->${to}`];
    return {
      ...base,
      ok: false,
      allowed,
      rejection: 'NOT_ALLOWED',
      message:
        `${machine.id}: ${from} -> ${to} is not a legal transition. ` +
        `Allowed from ${from}: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}.` +
        (note ? ` ${note}` : ''),
    };
  }
  return {
    ...base,
    ok: true,
    allowed,
    rejection: null,
    message: `${machine.id}: ${from} -> ${to} is legal.`,
  };
}

/** Generic guard. Returns a boolean and never throws. */
export function canTransitionIn<S extends string>(machine: StateMachine<S>, from: string, to: string): boolean {
  return explainTransitionIn(machine, from, to).ok;
}

/** Generic assertion. Throws `StateTransitionError` with the specific reason. */
export function assertTransitionIn<S extends string>(machine: StateMachine<S>, from: string, to: string): void {
  const verdict = explainTransitionIn(machine, from, to);
  if (verdict.ok) return;
  throw new StateTransitionError({
    machine: machine.id,
    from,
    to,
    allowed: verdict.allowed,
    rejection: verdict.rejection ?? 'NOT_ALLOWED',
    message: verdict.message,
  });
}

export function isTerminalIn<S extends string>(machine: StateMachine<S>, state: string): boolean {
  return (machine.terminal as readonly string[]).includes(state);
}

export function allowedTransitionsFrom<S extends string>(machine: StateMachine<S>, from: S): readonly S[] {
  return allowedList(machine, from);
}

/** Every state reachable from `from`, excluding `from` unless it is re-entrant. */
export function reachableStatesFrom<S extends string>(machine: StateMachine<S>, from: S): readonly S[] {
  const seen = new Set<S>();
  const queue: S[] = [...allowedList(machine, from)];
  while (queue.length > 0) {
    const next = queue.shift() as S;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const target of allowedList(machine, next)) {
      if (!seen.has(target)) queue.push(target);
    }
  }
  return Object.freeze([...seen]);
}

/** The states that can lead directly into `to`. Used by the coverage tests. */
export function predecessorsOf<S extends string>(machine: StateMachine<S>, to: S): readonly S[] {
  return Object.freeze(machine.states.filter((state) => (allowedList(machine, state) as readonly string[]).includes(to)));
}

/* ========================================================================== */
/*  The contract's state vocabularies, as runtime data                         */
/* ========================================================================== */

/*
 * `protocol.ts` declares these as types only. The arrays below are the runtime
 * mirror, and the `satisfies` clause plus the `Exclude<>` proofs underneath make
 * drift a compile error in both directions: a foreign member fails `satisfies`,
 * a forgotten member fails the proof.
 */

export const OPERATIONAL_STATUSES = [
  'CREATED',
  'QUEUED',
  'STARTING',
  'RUNNING',
  'STREAMING',
  'WAITING',
  'WAITING_FOR_PERMISSION',
  'VERIFYING',
  'REVIEWING',
  'REPAIRING',
  'RETRYING',
  'STOPPING',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'INTERRUPTED',
  'DISCONNECTED',
  'RECOVERING',
  'RESUMABLE',
  'ORPHANED',
  'FAILED_RECOVERY',
  'DEGRADED',
] as const satisfies readonly OperationalStatus[];

export const ATTACHMENT_STATES = [
  'SELECTED',
  'VALIDATING',
  'HASHING',
  'STAGING',
  'INDEXING',
  'READY',
  'REJECTED',
  'QUARANTINED',
  'FAILED',
  'REMOVED',
] as const satisfies readonly AttachmentState[];

/** The approval lifecycle is inlined in `ApprovalRequest`; name it once here. */
export type ApprovalState = ApprovalRequest['state'];

export const APPROVAL_STATES = ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'] as const satisfies readonly ApprovalState[];

export const PROJECT_HEALTH_STATES = [
  'HEALTHY',
  'DEGRADED',
  'UNKNOWN',
  'MISSING',
  'ERROR',
] as const satisfies readonly ProjectHealthState[];

/**
 * Compile-time totality proofs. If someone adds a status to `protocol.ts` and
 * not to the array above, `Exclude<...>` stops being `never`, the constant stops
 * being assignable, and `tsc` fails before any test runs. That is the point:
 * an unmodelled state must not be able to reach a screen.
 */
type Proof<T> = [T] extends [never] ? true : { readonly UNMODELLED_CONTRACT_STATES: T };

export const OPERATIONAL_STATUS_COVERAGE_PROOF: Proof<
  Exclude<OperationalStatus, (typeof OPERATIONAL_STATUSES)[number]>
> = true;
export const ATTACHMENT_STATE_COVERAGE_PROOF: Proof<
  Exclude<AttachmentState, (typeof ATTACHMENT_STATES)[number]>
> = true;
export const APPROVAL_STATE_COVERAGE_PROOF: Proof<Exclude<ApprovalState, (typeof APPROVAL_STATES)[number]>> = true;
export const PROJECT_HEALTH_STATE_COVERAGE_PROOF: Proof<
  Exclude<ProjectHealthState, (typeof PROJECT_HEALTH_STATES)[number]>
> = true;

/* ========================================================================== */
/*  1. Runs                                                                    */
/* ========================================================================== */

/**
 * The run machine. Its shape encodes the two invariants the whole workspace
 * rests on, and both are structural rather than advisory:
 *
 *   COMPLETED has exactly one predecessor: REVIEWING.
 *   REVIEWING has exactly one predecessor: VERIFYING.
 *
 * So there is no path to "done" that does not pass through verification and
 * review — not from CREATED, not from FAILED, not from DISCONNECTED, not from
 * RUNNING itself. The six explicitly-invalid transitions in the mission brief
 * are refused by construction, not by a special case.
 *
 * Loss of contact funnels through INTERRUPTED. A run that stops unexpectedly is
 * INTERRUPTED (execution ended without us asking); once we establish the channel
 * itself is gone it becomes DISCONNECTED, and the only ways out of that are
 * RECOVERING (reconcile), RESUMABLE (a session we can resume), ORPHANED (a
 * process we can no longer account for) or FAILED_RECOVERY.
 */
export type RunState = Extract<
  OperationalStatus,
  | 'CREATED'
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'STREAMING'
  | 'WAITING_FOR_PERMISSION'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'REPAIRING'
  | 'RETRYING'
  | 'STOPPING'
  | 'INTERRUPTED'
  | 'DISCONNECTED'
  | 'RECOVERING'
  | 'RESUMABLE'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'ORPHANED'
  | 'FAILED_RECOVERY'
>;

export const RUN_MACHINE: StateMachine<RunState> = defineMachine<RunState>({
  id: 'run',
  label: 'run',
  description: 'One immutable attempt at executing a goal through Claude Code.',
  initial: 'CREATED',
  states: [
    'CREATED',
    'QUEUED',
    'STARTING',
    'RUNNING',
    'STREAMING',
    'WAITING_FOR_PERMISSION',
    'VERIFYING',
    'REVIEWING',
    'REPAIRING',
    'RETRYING',
    'STOPPING',
    'INTERRUPTED',
    'DISCONNECTED',
    'RECOVERING',
    'RESUMABLE',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'BLOCKED',
    'ORPHANED',
    'FAILED_RECOVERY',
  ],
  terminal: ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'ORPHANED', 'FAILED_RECOVERY'],
  transitions: {
    CREATED: ['QUEUED', 'CANCELLED'],
    QUEUED: ['STARTING', 'CANCELLED', 'BLOCKED'],
    STARTING: ['RUNNING', 'FAILED', 'CANCELLED', 'BLOCKED', 'INTERRUPTED'],
    RUNNING: ['WAITING_FOR_PERMISSION', 'VERIFYING', 'STOPPING', 'FAILED', 'INTERRUPTED', 'STREAMING'],
    STREAMING: ['RUNNING', 'WAITING_FOR_PERMISSION', 'VERIFYING', 'STOPPING', 'FAILED', 'INTERRUPTED'],
    WAITING_FOR_PERMISSION: ['RUNNING', 'STREAMING', 'STOPPING', 'BLOCKED', 'FAILED', 'INTERRUPTED'],
    // Only REVIEWING, and only once a verdict exists (assertReviewingEvidence).
    VERIFYING: ['REVIEWING', 'FAILED', 'STOPPING', 'INTERRUPTED'],
    REVIEWING: ['COMPLETED', 'REPAIRING', 'FAILED', 'STOPPING', 'INTERRUPTED'],
    REPAIRING: ['RETRYING', 'FAILED', 'STOPPING', 'INTERRUPTED'],
    RETRYING: ['RUNNING', 'FAILED', 'STOPPING', 'INTERRUPTED'],
    STOPPING: ['CANCELLED', 'FAILED', 'ORPHANED'],
    INTERRUPTED: ['DISCONNECTED', 'RESUMABLE', 'RECOVERING', 'CANCELLED', 'FAILED', 'ORPHANED'],
    DISCONNECTED: ['RECOVERING', 'RESUMABLE', 'ORPHANED', 'FAILED_RECOVERY'],
    // Reconciliation may put a run back to work or hand it to verification.
    // It may NOT complete it: completion still has to be earned via REVIEWING.
    RECOVERING: ['RUNNING', 'STREAMING', 'VERIFYING', 'RESUMABLE', 'DISCONNECTED', 'FAILED', 'FAILED_RECOVERY', 'ORPHANED'],
    RESUMABLE: ['STARTING', 'RECOVERING', 'CANCELLED', 'ORPHANED', 'FAILED_RECOVERY'],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
    BLOCKED: [],
    ORPHANED: [],
    FAILED_RECOVERY: [],
  },
});

export function canRunTransition(from: string, to: string): boolean {
  return canTransitionIn(RUN_MACHINE, from, to);
}
export function assertRunTransition(from: string, to: string): void {
  assertTransitionIn(RUN_MACHINE, from, to);
}
export function explainRunTransition(from: string, to: string): TransitionExplanation<RunState> {
  return explainTransitionIn(RUN_MACHINE, from, to);
}
export function isTerminalRunState(state: string): boolean {
  return isTerminalIn(RUN_MACHINE, state);
}

/* ========================================================================== */
/*  2. Tasks                                                                   */
/* ========================================================================== */

/**
 * A task is a unit of work inside a run. It differs from a run in two ways that
 * matter: it can be WAITING on a dependency, and BLOCKED is recoverable — but
 * only through an explicit re-queue. A blocked task can never jump straight back
 * to RUNNING, because "the blocker went away" is a claim that needs its own
 * moment of decision.
 */
export type TaskState = Extract<
  OperationalStatus,
  | 'CREATED'
  | 'QUEUED'
  | 'WAITING'
  | 'RUNNING'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'REPAIRING'
  | 'RETRYING'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
>;

export const TASK_MACHINE: StateMachine<TaskState> = defineMachine<TaskState>({
  id: 'task',
  label: 'task',
  description: 'A unit of work owned by one agent inside a run.',
  initial: 'CREATED',
  states: [
    'CREATED',
    'QUEUED',
    'WAITING',
    'RUNNING',
    'VERIFYING',
    'REVIEWING',
    'REPAIRING',
    'RETRYING',
    'BLOCKED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ],
  terminal: ['COMPLETED', 'FAILED', 'CANCELLED'],
  transitions: {
    CREATED: ['QUEUED', 'CANCELLED'],
    QUEUED: ['WAITING', 'RUNNING', 'BLOCKED', 'CANCELLED'],
    WAITING: ['RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
    RUNNING: ['VERIFYING', 'WAITING', 'BLOCKED', 'FAILED', 'CANCELLED'],
    VERIFYING: ['REVIEWING', 'BLOCKED', 'FAILED'],
    REVIEWING: ['COMPLETED', 'REPAIRING', 'BLOCKED', 'FAILED'],
    REPAIRING: ['RETRYING', 'BLOCKED', 'FAILED'],
    RETRYING: ['RUNNING', 'BLOCKED', 'FAILED'],
    BLOCKED: ['QUEUED', 'CANCELLED'],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
  },
});

export function canTaskTransition(from: string, to: string): boolean {
  return canTransitionIn(TASK_MACHINE, from, to);
}
export function assertTaskTransition(from: string, to: string): void {
  assertTransitionIn(TASK_MACHINE, from, to);
}

/* ========================================================================== */
/*  3. Agents                                                                  */
/* ========================================================================== */

/**
 * An agent instance activated for a run. COMPLETED here means only "the agent
 * returned" — evidenced by an `agent.finished` event. It is deliberately NOT a
 * claim that the agent's work is correct; that claim belongs to the task and run
 * machines, which route through VERIFYING and REVIEWING.
 */
export type AgentState = Extract<
  OperationalStatus,
  | 'CREATED'
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'WAITING'
  | 'WAITING_FOR_PERMISSION'
  | 'STOPPING'
  | 'INTERRUPTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'ORPHANED'
>;

export const AGENT_MACHINE: StateMachine<AgentState> = defineMachine<AgentState>({
  id: 'agent',
  label: 'agent',
  description: 'One activation of one agent, from dispatch to its finish event.',
  initial: 'CREATED',
  states: [
    'CREATED',
    'QUEUED',
    'STARTING',
    'RUNNING',
    'WAITING',
    'WAITING_FOR_PERMISSION',
    'STOPPING',
    'INTERRUPTED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'BLOCKED',
    'ORPHANED',
  ],
  terminal: ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'ORPHANED'],
  transitions: {
    CREATED: ['QUEUED', 'CANCELLED'],
    QUEUED: ['STARTING', 'CANCELLED', 'BLOCKED'],
    STARTING: ['RUNNING', 'FAILED', 'CANCELLED'],
    RUNNING: ['WAITING', 'WAITING_FOR_PERMISSION', 'STOPPING', 'COMPLETED', 'FAILED', 'INTERRUPTED'],
    WAITING: ['RUNNING', 'STOPPING', 'FAILED', 'INTERRUPTED', 'CANCELLED'],
    WAITING_FOR_PERMISSION: ['RUNNING', 'BLOCKED', 'STOPPING', 'FAILED', 'INTERRUPTED'],
    STOPPING: ['CANCELLED', 'FAILED', 'ORPHANED'],
    INTERRUPTED: ['ORPHANED', 'FAILED', 'CANCELLED'],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
    BLOCKED: [],
    ORPHANED: [],
  },
});

export function canAgentTransition(from: string, to: string): boolean {
  return canTransitionIn(AGENT_MACHINE, from, to);
}
export function assertAgentTransition(from: string, to: string): void {
  assertTransitionIn(AGENT_MACHINE, from, to);
}

/* ========================================================================== */
/*  4. Tests                                                                   */
/* ========================================================================== */

/**
 * A test execution. Note the entry point: a test that needs approval starts at
 * WAITING_FOR_PERMISSION, because `runApprovedTest` is the only way a command
 * runs at all.
 *
 * COMPLETED means "the execution finished AND `testPassed(execution)` was true".
 * `testPassed` in protocol.ts derives that from the recorded exit code and the
 * parsed failure counts — never from stdout. A finished run that does not
 * satisfy it goes to FAILED. There is no third option and no "probably passed".
 */
export type TestState = Extract<
  OperationalStatus,
  | 'CREATED'
  | 'WAITING_FOR_PERMISSION'
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'INTERRUPTED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'ORPHANED'
>;

export const TEST_MACHINE: StateMachine<TestState> = defineMachine<TestState>({
  id: 'test',
  label: 'test execution',
  description: 'One approved execution of one quality gate, with captured streams and an exit code.',
  initial: 'CREATED',
  states: [
    'CREATED',
    'WAITING_FOR_PERMISSION',
    'QUEUED',
    'STARTING',
    'RUNNING',
    'STOPPING',
    'INTERRUPTED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'BLOCKED',
    'ORPHANED',
  ],
  terminal: ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'ORPHANED'],
  transitions: {
    CREATED: ['WAITING_FOR_PERMISSION', 'QUEUED', 'CANCELLED'],
    WAITING_FOR_PERMISSION: ['QUEUED', 'BLOCKED', 'CANCELLED'],
    QUEUED: ['STARTING', 'CANCELLED', 'BLOCKED'],
    STARTING: ['RUNNING', 'FAILED', 'CANCELLED'],
    RUNNING: ['COMPLETED', 'FAILED', 'STOPPING', 'INTERRUPTED'],
    STOPPING: ['CANCELLED', 'FAILED', 'ORPHANED'],
    INTERRUPTED: ['FAILED', 'ORPHANED', 'CANCELLED'],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
    BLOCKED: [],
    ORPHANED: [],
  },
});

export function canTestTransition(from: string, to: string): boolean {
  return canTransitionIn(TEST_MACHINE, from, to);
}
export function assertTestTransition(from: string, to: string): void {
  assertTransitionIn(TEST_MACHINE, from, to);
}

/* ========================================================================== */
/*  5. Permissions (approvals)                                                 */
/* ========================================================================== */

/**
 * An approval request. Every outcome is terminal, which is the entire security
 * value of the machine: a denial cannot later become an approval, and an expired
 * request cannot be honoured after the fact. Asking again means a new request
 * with a new id, so the audit trail keeps both.
 */
export type PermissionState = ApprovalState;

export const PERMISSION_MACHINE: StateMachine<PermissionState> = defineMachine<PermissionState>({
  id: 'permission',
  label: 'approval',
  description: 'One human decision on one proposed action.',
  initial: 'PENDING',
  states: ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'],
  terminal: ['APPROVED', 'DENIED', 'EXPIRED'],
  transitions: {
    PENDING: ['APPROVED', 'DENIED', 'EXPIRED'],
    APPROVED: [],
    DENIED: [],
    EXPIRED: [],
  },
});

export function canPermissionTransition(from: string, to: string): boolean {
  return canTransitionIn(PERMISSION_MACHINE, from, to);
}
export function assertPermissionTransition(from: string, to: string): void {
  assertTransitionIn(PERMISSION_MACHINE, from, to);
}

/* ========================================================================== */
/*  6. Attachments                                                             */
/* ========================================================================== */

/**
 * The staging pipeline. READY is the state that says "Claude Code may be pointed
 * at this file", so it is reachable only from INDEXING — at the end of validate,
 * hash, stage, index. No shortcut exists from SELECTED, and neither REJECTED nor
 * QUARANTINED can be talked back into READY.
 *
 * READY -> QUARANTINED stays open on purpose: a later scan is allowed to change
 * its mind about a file it already accepted.
 */
export const ATTACHMENT_MACHINE: StateMachine<AttachmentState> = defineMachine<AttachmentState>({
  id: 'attachment',
  label: 'attachment',
  description: 'One user-supplied file moving through validation into the staging area.',
  initial: 'SELECTED',
  states: [
    'SELECTED',
    'VALIDATING',
    'HASHING',
    'STAGING',
    'INDEXING',
    'READY',
    'REJECTED',
    'QUARANTINED',
    'FAILED',
    'REMOVED',
  ],
  terminal: ['REMOVED'],
  transitions: {
    SELECTED: ['VALIDATING', 'REJECTED', 'REMOVED'],
    VALIDATING: ['HASHING', 'REJECTED', 'QUARANTINED', 'FAILED', 'REMOVED'],
    HASHING: ['STAGING', 'QUARANTINED', 'FAILED', 'REMOVED'],
    STAGING: ['INDEXING', 'QUARANTINED', 'FAILED', 'REMOVED'],
    INDEXING: ['READY', 'QUARANTINED', 'FAILED', 'REMOVED'],
    READY: ['QUARANTINED', 'REMOVED'],
    REJECTED: ['REMOVED'],
    QUARANTINED: ['REMOVED'],
    FAILED: ['REMOVED'],
    REMOVED: [],
  },
});

export function canAttachmentTransition(from: string, to: string): boolean {
  return canTransitionIn(ATTACHMENT_MACHINE, from, to);
}
export function assertAttachmentTransition(from: string, to: string): void {
  assertTransitionIn(ATTACHMENT_MACHINE, from, to);
}

/* ========================================================================== */
/*  7. Claude Code sessions                                                    */
/* ========================================================================== */

/**
 * A Claude Code session, as observed through the CLI. COMPLETED means an ended
 * session was observed (`session.ended`), which is why DISCONNECTED can never
 * reach it: losing a session tells us nothing about whether it ended.
 *
 * RESUMABLE exists because 2.1.217 really can resume — `--resume <session-id>`
 * and `--fork-session` are confirmed present — so a lost session with a captured
 * id is a genuinely different situation from one without.
 */
export type ClaudeSessionState = Extract<
  OperationalStatus,
  | 'CREATED'
  | 'STARTING'
  | 'RUNNING'
  | 'STREAMING'
  | 'INTERRUPTED'
  | 'DISCONNECTED'
  | 'RECOVERING'
  | 'RESUMABLE'
  | 'COMPLETED'
  | 'FAILED'
  | 'ORPHANED'
  | 'FAILED_RECOVERY'
>;

export const CLAUDE_SESSION_MACHINE: StateMachine<ClaudeSessionState> = defineMachine<ClaudeSessionState>({
  id: 'claude-session',
  label: 'Claude Code session',
  description: 'One local Claude Code session, identified by the session id the CLI reported.',
  initial: 'CREATED',
  states: [
    'CREATED',
    'STARTING',
    'RUNNING',
    'STREAMING',
    'INTERRUPTED',
    'DISCONNECTED',
    'RECOVERING',
    'RESUMABLE',
    'COMPLETED',
    'FAILED',
    'ORPHANED',
    'FAILED_RECOVERY',
  ],
  terminal: ['COMPLETED', 'FAILED', 'ORPHANED', 'FAILED_RECOVERY'],
  transitions: {
    CREATED: ['STARTING', 'FAILED'],
    STARTING: ['RUNNING', 'FAILED'],
    RUNNING: ['STREAMING', 'INTERRUPTED', 'DISCONNECTED', 'COMPLETED', 'FAILED'],
    STREAMING: ['RUNNING', 'INTERRUPTED', 'DISCONNECTED', 'COMPLETED', 'FAILED'],
    INTERRUPTED: ['RESUMABLE', 'RECOVERING', 'DISCONNECTED', 'ORPHANED', 'FAILED'],
    DISCONNECTED: ['RECOVERING', 'RESUMABLE', 'ORPHANED', 'FAILED_RECOVERY'],
    RECOVERING: ['RUNNING', 'STREAMING', 'RESUMABLE', 'DISCONNECTED', 'ORPHANED', 'FAILED_RECOVERY'],
    RESUMABLE: ['STARTING', 'RECOVERING', 'ORPHANED', 'FAILED_RECOVERY'],
    COMPLETED: [],
    FAILED: [],
    ORPHANED: [],
    FAILED_RECOVERY: [],
  },
});

export function canClaudeSessionTransition(from: string, to: string): boolean {
  return canTransitionIn(CLAUDE_SESSION_MACHINE, from, to);
}
export function assertClaudeSessionTransition(from: string, to: string): void {
  assertTransitionIn(CLAUDE_SESSION_MACHINE, from, to);
}

/* ========================================================================== */
/*  8. Projects                                                                */
/* ========================================================================== */

/**
 * Project health. The important property is the starting state: a project is
 * UNKNOWN, not HEALTHY, until a doctor run produced a result. Health is a
 * continuously re-evaluated observation rather than a lifecycle, so no state is
 * terminal — but every state is re-enterable only through a fresh check, and
 * there is no self-transition, so "still healthy" has to be re-asserted by
 * writing HEALTHY again from a different state or by recording UNKNOWN first.
 */
export type ProjectState = ProjectHealthState;

export const PROJECT_MACHINE: StateMachine<ProjectState> = defineMachine<ProjectState>({
  id: 'project',
  label: 'project health',
  description: 'What the last health check could actually establish about a project on disk.',
  initial: 'UNKNOWN',
  states: ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'MISSING', 'ERROR'],
  terminal: [],
  transitions: {
    UNKNOWN: ['HEALTHY', 'DEGRADED', 'MISSING', 'ERROR'],
    HEALTHY: ['UNKNOWN', 'DEGRADED', 'MISSING', 'ERROR'],
    DEGRADED: ['UNKNOWN', 'HEALTHY', 'MISSING', 'ERROR'],
    MISSING: ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'ERROR'],
    ERROR: ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'MISSING'],
  },
});

export function canProjectTransition(from: string, to: string): boolean {
  return canTransitionIn(PROJECT_MACHINE, from, to);
}
export function assertProjectTransition(from: string, to: string): void {
  assertTransitionIn(PROJECT_MACHINE, from, to);
}

/* ========================================================================== */
/*  9. Artifacts                                                               */
/* ========================================================================== */

/**
 * An artifact record. COMPLETED means "indexed: the file was found at its ref
 * and its hash matched", and it is reachable only from VERIFYING — so an
 * artifact can never be listed as present because a producer said it wrote one.
 *
 * ORPHANED means referenced but not found. If the file reappears it must be
 * verified again (ORPHANED -> VERIFYING), never restored to COMPLETED directly:
 * the bytes that came back are not assumed to be the bytes that went away.
 */
export type ArtifactState = Extract<
  OperationalStatus,
  'CREATED' | 'VERIFYING' | 'COMPLETED' | 'DEGRADED' | 'ORPHANED' | 'FAILED'
>;

export const ARTIFACT_MACHINE: StateMachine<ArtifactState> = defineMachine<ArtifactState>({
  id: 'artifact',
  label: 'artifact',
  description: 'A produced file the workspace claims exists, plus the last check of that claim.',
  initial: 'CREATED',
  states: ['CREATED', 'VERIFYING', 'COMPLETED', 'DEGRADED', 'ORPHANED', 'FAILED'],
  terminal: [],
  transitions: {
    CREATED: ['VERIFYING', 'ORPHANED', 'FAILED'],
    VERIFYING: ['COMPLETED', 'DEGRADED', 'ORPHANED', 'FAILED'],
    COMPLETED: ['VERIFYING', 'ORPHANED'],
    DEGRADED: ['VERIFYING', 'ORPHANED', 'FAILED'],
    ORPHANED: ['VERIFYING'],
    FAILED: ['VERIFYING'],
  },
});

export function canArtifactTransition(from: string, to: string): boolean {
  return canTransitionIn(ARTIFACT_MACHINE, from, to);
}
export function assertArtifactTransition(from: string, to: string): void {
  assertTransitionIn(ARTIFACT_MACHINE, from, to);
}

/* ========================================================================== */
/*  10. Streams                                                                */
/* ========================================================================== */

/**
 * An event or output stream. DEGRADED is the state that earns this machine its
 * place: when a sequence gap is detected the stream is degraded, and a degraded
 * stream cannot reach COMPLETED. It must recover — replay from the last
 * confirmed sequence — before the story it told may be called complete.
 *
 * As with runs, COMPLETED has exactly one predecessor: STREAMING.
 */
export type StreamState = Extract<
  OperationalStatus,
  | 'CREATED'
  | 'STARTING'
  | 'STREAMING'
  | 'DEGRADED'
  | 'INTERRUPTED'
  | 'DISCONNECTED'
  | 'RECOVERING'
  | 'RESUMABLE'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ORPHANED'
  | 'FAILED_RECOVERY'
>;

export const STREAM_MACHINE: StateMachine<StreamState> = defineMachine<StreamState>({
  id: 'stream',
  label: 'stream',
  description: 'One ordered channel of events or output deltas, tracked by sequence number.',
  initial: 'CREATED',
  states: [
    'CREATED',
    'STARTING',
    'STREAMING',
    'DEGRADED',
    'INTERRUPTED',
    'DISCONNECTED',
    'RECOVERING',
    'RESUMABLE',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'ORPHANED',
    'FAILED_RECOVERY',
  ],
  terminal: ['COMPLETED', 'FAILED', 'CANCELLED', 'ORPHANED', 'FAILED_RECOVERY'],
  transitions: {
    CREATED: ['STARTING', 'FAILED', 'CANCELLED'],
    STARTING: ['STREAMING', 'FAILED', 'CANCELLED', 'DISCONNECTED'],
    STREAMING: ['DEGRADED', 'INTERRUPTED', 'DISCONNECTED', 'COMPLETED', 'FAILED', 'CANCELLED'],
    DEGRADED: ['STREAMING', 'RECOVERING', 'INTERRUPTED', 'DISCONNECTED', 'FAILED', 'CANCELLED'],
    INTERRUPTED: ['RECOVERING', 'RESUMABLE', 'DISCONNECTED', 'FAILED', 'ORPHANED', 'CANCELLED'],
    DISCONNECTED: ['RECOVERING', 'RESUMABLE', 'ORPHANED', 'FAILED_RECOVERY'],
    RECOVERING: ['STREAMING', 'DEGRADED', 'RESUMABLE', 'DISCONNECTED', 'ORPHANED', 'FAILED_RECOVERY'],
    RESUMABLE: ['STARTING', 'RECOVERING', 'ORPHANED', 'CANCELLED', 'FAILED_RECOVERY'],
    COMPLETED: [],
    FAILED: [],
    CANCELLED: [],
    ORPHANED: [],
    FAILED_RECOVERY: [],
  },
});

export function canStreamTransition(from: string, to: string): boolean {
  return canTransitionIn(STREAM_MACHINE, from, to);
}
export function assertStreamTransition(from: string, to: string): void {
  assertTransitionIn(STREAM_MACHINE, from, to);
}

/* ========================================================================== */
/*  Registry, ownership and self-validation                                    */
/* ========================================================================== */

export const MACHINES: Readonly<Record<MachineId, StateMachine>> = Object.freeze({
  run: RUN_MACHINE,
  task: TASK_MACHINE,
  agent: AGENT_MACHINE,
  test: TEST_MACHINE,
  permission: PERMISSION_MACHINE,
  attachment: ATTACHMENT_MACHINE,
  'claude-session': CLAUDE_SESSION_MACHINE,
  project: PROJECT_MACHINE,
  artifact: ARTIFACT_MACHINE,
  stream: STREAM_MACHINE,
});

/** Domain-keyed guard, for callers that carry the domain as data. */
export function canTransition(machineId: MachineId, from: string, to: string): boolean {
  const machine = MACHINES[machineId];
  if (!machine) return false;
  return canTransitionIn(machine, from, to);
}

/** Domain-keyed assertion. Throws `StateTransitionError`. */
export function assertTransition(machineId: MachineId, from: string, to: string): void {
  const machine = MACHINES[machineId];
  if (!machine) {
    throw new StateTransitionError({
      machine: String(machineId),
      from,
      to,
      allowed: [],
      rejection: 'UNKNOWN_MACHINE',
      message: `No state machine named "${String(machineId)}". Known machines: ${MACHINE_IDS.join(', ')}.`,
    });
  }
  assertTransitionIn(machine, from, to);
}

export function explainTransition(machineId: MachineId, from: string, to: string): TransitionExplanation {
  const machine = MACHINES[machineId];
  if (!machine) {
    return {
      ok: false,
      machine: machineId,
      from,
      to,
      allowed: [],
      rejection: 'UNKNOWN_MACHINE',
      message: `No state machine named "${String(machineId)}". Known machines: ${MACHINE_IDS.join(', ')}.`,
    };
  }
  return explainTransitionIn(machine, from, to);
}

/**
 * Which machine OWNS each contract state — the one whose table defines what the
 * state means. `Record<...>` makes the map total at compile time: a new status
 * in protocol.ts with no home here does not build.
 */
export const OPERATIONAL_STATUS_HOME: Readonly<Record<OperationalStatus, MachineId>> = Object.freeze({
  CREATED: 'run',
  QUEUED: 'run',
  STARTING: 'run',
  RUNNING: 'run',
  WAITING_FOR_PERMISSION: 'run',
  VERIFYING: 'run',
  REVIEWING: 'run',
  REPAIRING: 'run',
  RETRYING: 'run',
  STOPPING: 'run',
  COMPLETED: 'run',
  FAILED: 'run',
  BLOCKED: 'run',
  CANCELLED: 'run',
  INTERRUPTED: 'run',
  DISCONNECTED: 'run',
  RECOVERING: 'run',
  RESUMABLE: 'run',
  ORPHANED: 'run',
  FAILED_RECOVERY: 'run',
  // A dependency wait is a task-level idea: a run is never merely WAITING, it is
  // either executing, waiting for a permission, or not running at all.
  WAITING: 'task',
  // Streaming and degradation are properties of a channel, which runs and
  // sessions borrow while a channel is attached to them.
  STREAMING: 'stream',
  DEGRADED: 'stream',
});

export const ATTACHMENT_STATE_HOME: Readonly<Record<AttachmentState, MachineId>> = Object.freeze({
  SELECTED: 'attachment',
  VALIDATING: 'attachment',
  HASHING: 'attachment',
  STAGING: 'attachment',
  INDEXING: 'attachment',
  READY: 'attachment',
  REJECTED: 'attachment',
  QUARANTINED: 'attachment',
  FAILED: 'attachment',
  REMOVED: 'attachment',
});

export const APPROVAL_STATE_HOME: Readonly<Record<ApprovalState, MachineId>> = Object.freeze({
  PENDING: 'permission',
  APPROVED: 'permission',
  DENIED: 'permission',
  EXPIRED: 'permission',
});

export const PROJECT_HEALTH_STATE_HOME: Readonly<Record<ProjectHealthState, MachineId>> = Object.freeze({
  HEALTHY: 'project',
  DEGRADED: 'project',
  UNKNOWN: 'project',
  MISSING: 'project',
  ERROR: 'project',
});

/**
 * Which machines actually declare a given operational status. Ownership says who
 * defines it; this says who uses it. Both are useful to a reader of the UI.
 */
export function machinesDeclaring(state: string): readonly MachineId[] {
  return Object.freeze(
    MACHINE_IDS.filter((id) => (MACHINES[id].states as readonly string[]).includes(state)),
  );
}

/**
 * Structural self-check over the tables. Pure and allocation-cheap; it is NOT
 * run at import time so that loading this module can never throw inside a
 * render. The unit tests call `assertMachineRegistryValid()`.
 */
export function validateMachineRegistry(): readonly string[] {
  const problems: string[] = [];

  for (const id of MACHINE_IDS) {
    const machine = MACHINES[id];
    if (!machine) {
      problems.push(`registry: no machine registered under "${id}"`);
      continue;
    }
    if (machine.id !== id) problems.push(`${id}: registered under "${id}" but declares id "${machine.id}"`);

    const declared = new Set<string>();
    for (const state of machine.states) {
      if (declared.has(state)) problems.push(`${id}: duplicate state "${state}"`);
      declared.add(state);
    }
    if (!declared.has(machine.initial)) {
      problems.push(`${id}: initial state "${machine.initial}" is not declared`);
    }
    for (const state of machine.terminal) {
      if (!declared.has(state)) problems.push(`${id}: terminal state "${state}" is not declared`);
    }
    const keys = Object.keys(machine.transitions);
    for (const key of keys) {
      if (!declared.has(key)) problems.push(`${id}: transition table has an entry for undeclared state "${key}"`);
    }
    for (const state of machine.states) {
      const targets = machine.transitions[state];
      if (!targets) {
        problems.push(`${id}: state "${state}" has no transition entry (the table must be total)`);
        continue;
      }
      const seen = new Set<string>();
      for (const target of targets) {
        if (!declared.has(target)) problems.push(`${id}: ${state} -> "${target}" targets an undeclared state`);
        if (seen.has(target)) problems.push(`${id}: ${state} -> ${target} is listed twice`);
        seen.add(target);
        if (target === state) problems.push(`${id}: ${state} -> ${state} self-transition is not modelled`);
      }
      if ((machine.terminal as readonly string[]).includes(state) && targets.length > 0) {
        problems.push(`${id}: ${state} is terminal but lists outgoing transitions (${targets.join(', ')})`);
      }
    }
  }

  // Every contract state must live in the machine that owns it.
  const homes: readonly (readonly [string, MachineId])[] = [
    ...Object.entries(OPERATIONAL_STATUS_HOME),
    ...Object.entries(ATTACHMENT_STATE_HOME),
    ...Object.entries(APPROVAL_STATE_HOME),
    ...Object.entries(PROJECT_HEALTH_STATE_HOME),
  ] as readonly (readonly [string, MachineId])[];

  for (const [state, owner] of homes) {
    const machine = MACHINES[owner];
    if (!machine) {
      problems.push(`ownership: "${state}" is assigned to unknown machine "${owner}"`);
      continue;
    }
    if (!(machine.states as readonly string[]).includes(state)) {
      problems.push(`ownership: "${state}" is owned by "${owner}" but that machine does not declare it`);
    }
  }

  // No machine may invent a state the contract does not define.
  const contractStates = new Set<string>([
    ...OPERATIONAL_STATUSES,
    ...ATTACHMENT_STATES,
    ...APPROVAL_STATES,
    ...PROJECT_HEALTH_STATES,
  ]);
  for (const id of MACHINE_IDS) {
    for (const state of MACHINES[id].states) {
      if (!contractStates.has(state)) {
        problems.push(`${id}: "${state}" is not a state defined by protocol.ts`);
      }
    }
  }

  return Object.freeze(problems);
}

/** Throws if the tables are internally inconsistent. Used by the tests. */
export function assertMachineRegistryValid(): void {
  const problems = validateMachineRegistry();
  if (problems.length > 0) {
    throw new Error(`Forge state machines are inconsistent:\n- ${problems.join('\n- ')}`);
  }
}

/* ========================================================================== */
/*  Evidence gates                                                             */
/* ========================================================================== */

/*
 * This is the part that matters. A transition table stops nonsense orderings; it
 * cannot stop a caller from writing RUNNING for a process that never started.
 * The gates below are the second lock: a state that makes a claim about the
 * world may only be written when the facts that would make the claim true are
 * present, named, and re-checkable.
 */

export type EvidenceGateName = 'running' | 'completed' | 'failed' | 'verifying' | 'reviewing';

/** The non-throwing result. `missing` is empty exactly when `ok` is true. */
export interface GateResult {
  readonly ok: boolean;
  readonly gate: EvidenceGateName;
  readonly missing: readonly string[];
}

/**
 * A heartbeat older than this is not evidence of anything. The bridge emits
 * `bridge.heartbeat`; if the last one is older than the threshold the honest
 * status is UNKNOWN, not RUNNING.
 */
export const DEFAULT_HEARTBEAT_STALENESS_MS = 30_000;

/** The only verdicts that may complete a run. Stricter than "not UNVERIFIED". */
export const COMPLETING_VERDICTS = ['VERIFIED_PASS', 'VERIFIED_PASS_WITH_LIMITATIONS'] as const satisfies readonly VerifyVerdict[];

/** Proof kinds a completion must carry unless the caller overrides the list. */
export const DEFAULT_REQUIRED_PROOF_KINDS = ['exit-code'] as const satisfies readonly EvidenceRef['kind'][];

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** ISO string or epoch millis, both accepted; anything unparseable is `null`. */
function toEpochMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!isText(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function result(gate: EvidenceGateName, missing: readonly string[]): GateResult {
  return Object.freeze({ gate, ok: missing.length === 0, missing: Object.freeze([...missing]) });
}

function gateMessage(gate: EvidenceGateName, missing: readonly string[]): string {
  return (
    `Forge state machines: refusing to claim ${gate.toUpperCase()} — the evidence for it is incomplete. ` +
    `Missing: ${missing.join('; ')}. ` +
    'A status is a claim about reality; until the evidence exists the honest value is UNKNOWN.'
  );
}

function assertGate(outcome: GateResult): void {
  if (outcome.ok) return;
  throw new EvidenceError(outcome.gate, outcome.missing, gateMessage(outcome.gate, outcome.missing));
}

/* ------------------------------------------------------------------ RUNNING */

/**
 * What must be true for "this is running right now" to be honest.
 *
 * `pid` alone is not accepted. A pid is a number that was once handed to us; it
 * proves nothing about the present. Either the caller states it OBSERVED the
 * process alive (`pidAlive: true`, from a real liveness check) or it supplies a
 * Forge task id — and in both cases a fresh heartbeat is still required.
 *
 * `observedAt` is passed in rather than read from a clock, so this function is
 * pure and a property test can drive the staleness boundary directly.
 */
export interface RunningEvidence {
  readonly runId?: string | null;
  readonly projectId?: string | null;
  readonly pid?: number | null;
  /** Result of a real liveness check. Never inferred from "we spawned it". */
  readonly pidAlive?: boolean | null;
  readonly forgeTaskId?: string | null;
  readonly startedAt?: string | null;
  readonly lastHeartbeatAt?: string | number | null;
  /** The instant the caller is judging freshness against, in epoch millis. */
  readonly observedAt?: number | null;
  readonly stalenessThresholdMs?: number;
}

export function checkRunningEvidence(evidence: RunningEvidence): GateResult {
  const missing: string[] = [];
  if (!isText(evidence.runId)) missing.push('runId');
  if (!isText(evidence.projectId)) missing.push('projectId');
  if (!isText(evidence.startedAt)) missing.push('startedAt (ISO-8601)');

  const hasLivePid = isInteger(evidence.pid) && evidence.pidAlive === true;
  const hasForgeTask = isText(evidence.forgeTaskId);
  if (!hasLivePid && !hasForgeTask) {
    if (isInteger(evidence.pid) && evidence.pidAlive !== true) {
      missing.push(
        `observed liveness for pid ${evidence.pid} (pidAlive was ${String(evidence.pidAlive)}; a pid on its own is not proof a process is running)`,
      );
    } else {
      missing.push('a live process handle: either pid + pidAlive===true, or forgeTaskId');
    }
  }

  const threshold = evidence.stalenessThresholdMs ?? DEFAULT_HEARTBEAT_STALENESS_MS;
  const heartbeat = toEpochMs(evidence.lastHeartbeatAt);
  const observedAt = typeof evidence.observedAt === 'number' && Number.isFinite(evidence.observedAt)
    ? evidence.observedAt
    : null;
  if (heartbeat === null) missing.push('lastHeartbeatAt (a parseable timestamp)');
  if (observedAt === null) missing.push('observedAt (the instant heartbeat freshness is judged against)');
  if (heartbeat !== null && observedAt !== null) {
    const age = observedAt - heartbeat;
    if (age > threshold) {
      missing.push(`a fresh heartbeat (last one is ${age}ms old, threshold is ${threshold}ms)`);
    }
    if (age < 0) {
      missing.push(`a credible heartbeat (it is dated ${-age}ms in the future relative to observedAt)`);
    }
  }

  return result('running', missing);
}

export function assertRunningEvidence(evidence: RunningEvidence): void {
  assertGate(checkRunningEvidence(evidence));
}

/* ---------------------------------------------------------------- COMPLETED */

/** The final event that closes a run. Its runId must match the run's own. */
export interface FinalEventEvidence {
  readonly type?: string | null;
  readonly runId?: string | null;
  readonly status?: OperationalStatus | null;
  readonly sequence?: number | null;
}

/**
 * What must be true for "this finished successfully" to be honest.
 *
 * Every clause here exists because its absence has, somewhere, been used to fake
 * a green tick: a process that was never waited on, an exit code nobody read,
 * output that was streamed and then dropped, a final event belonging to a
 * different run, a verdict of UNVERIFIED displayed as a pass, and an agent that
 * reviewed its own work.
 */
export interface CompletedEvidence {
  readonly runId?: string | null;
  /** True only if the process exit was actually observed (waited on). */
  readonly processExitObserved?: boolean | null;
  readonly exitCode?: number | null;
  /** Where the persisted output lives — a ref, not the text itself. */
  readonly outputRef?: string | null;
  readonly finalEvent?: FinalEventEvidence | null;
  readonly proofRefs?: readonly EvidenceRef[] | null;
  readonly requiredProofKinds?: readonly EvidenceRef['kind'][];
  readonly verdict?: VerifyVerdict | null;
  readonly verifierAgentId?: string | null;
  readonly subjectAgentId?: string | null;
}

export function checkCompletedEvidence(evidence: CompletedEvidence): GateResult {
  const missing: string[] = [];
  if (!isText(evidence.runId)) missing.push('runId');
  if (evidence.processExitObserved !== true) {
    missing.push('an observed process exit (processExitObserved !== true — a spawn is not an exit)');
  }
  if (!isInteger(evidence.exitCode)) missing.push('a recorded exit code');
  if (!isText(evidence.outputRef)) missing.push('a reference to persisted output');

  if (!evidence.finalEvent) {
    missing.push('a final event for this run');
  } else {
    if (!isText(evidence.finalEvent.type)) missing.push('a final event with a type');
    if (!isText(evidence.finalEvent.runId)) {
      missing.push('a final event carrying a runId');
    } else if (isText(evidence.runId) && evidence.finalEvent.runId !== evidence.runId) {
      missing.push(
        `a final event for THIS run (event runId "${evidence.finalEvent.runId}" != run "${evidence.runId}")`,
      );
    }
  }

  const proofRefs = evidence.proofRefs ?? [];
  if (proofRefs.length === 0) {
    missing.push('at least one proof reference');
  }
  const requiredKinds = evidence.requiredProofKinds ?? DEFAULT_REQUIRED_PROOF_KINDS;
  for (const kind of requiredKinds) {
    if (!proofRefs.some((ref) => ref.kind === kind && isText(ref.ref))) {
      missing.push(`a proof reference of kind "${kind}"`);
    }
  }

  if (!isText(evidence.verdict)) {
    missing.push('a verification verdict');
  } else if (!(COMPLETING_VERDICTS as readonly string[]).includes(evidence.verdict)) {
    missing.push(
      `an accepting verification verdict (got "${evidence.verdict}"; only ${COMPLETING_VERDICTS.join(' or ')} may complete a run)`,
    );
  }

  if (isText(evidence.verifierAgentId) && isText(evidence.subjectAgentId) && evidence.verifierAgentId === evidence.subjectAgentId) {
    missing.push(`an independent verifier (agent "${evidence.verifierAgentId}" verified its own work)`);
  }

  return result('completed', missing);
}

export function assertCompletedEvidence(evidence: CompletedEvidence): void {
  assertGate(checkCompletedEvidence(evidence));
}

/* ------------------------------------------------------------------- FAILED */

export interface FailingProcessEvidence {
  readonly exitObserved?: boolean | null;
  readonly exitCode?: number | null;
  /** A signal kill is a real failure even though no exit code exists. */
  readonly signal?: string | null;
}

export interface FailingTestEvidence {
  readonly gate?: string | null;
  readonly exitCode?: number | null;
  readonly failedCount?: number | null;
}

export interface FailedGateEvidence {
  readonly gate?: string | null;
  readonly passed?: boolean | null;
}

export interface ErrorEventEvidence {
  readonly type?: string | null;
  readonly runId?: string | null;
  readonly message?: string | null;
}

/**
 * FAILED is a claim too. "It didn't work" needs the same standard of proof as
 * "it worked", otherwise a timeout in our own code gets recorded as the run's
 * failure and the real cause is never looked at. One of the four kinds of
 * failure must be present AND must actually indicate failure, and captured
 * evidence refs are required in every case.
 */
export interface FailedEvidence {
  readonly runId?: string | null;
  readonly failure?: 'process' | 'test' | 'gate' | 'error-event' | null;
  readonly process?: FailingProcessEvidence | null;
  readonly test?: FailingTestEvidence | null;
  readonly gate?: FailedGateEvidence | null;
  readonly errorEvent?: ErrorEventEvidence | null;
  readonly evidenceRefs?: readonly EvidenceRef[] | null;
}

export function checkFailedEvidence(evidence: FailedEvidence): GateResult {
  const missing: string[] = [];
  if (!isText(evidence.runId)) missing.push('runId');

  switch (evidence.failure) {
    case 'process': {
      const process = evidence.process;
      if (!process) {
        missing.push('process failure details (exitObserved, exitCode or signal)');
        break;
      }
      const killed = isText(process.signal);
      if (!killed) {
        if (process.exitObserved !== true) missing.push('an observed process exit');
        if (!isInteger(process.exitCode)) {
          missing.push('a recorded exit code (or a signal name, if the process was killed)');
        } else if (process.exitCode === 0) {
          missing.push('a non-zero exit code — exit 0 is not a failure');
        }
      }
      break;
    }
    case 'test': {
      const test = evidence.test;
      if (!test) {
        missing.push('failing test details (exitCode and/or failedCount)');
        break;
      }
      const nonZeroExit = isInteger(test.exitCode) && test.exitCode !== 0;
      const hasFailures = isInteger(test.failedCount) && (test.failedCount ?? 0) > 0;
      if (!isInteger(test.exitCode) && !isInteger(test.failedCount)) {
        missing.push('a recorded test exit code or failure count');
      } else if (!nonZeroExit && !hasFailures) {
        missing.push('a test that actually failed (exit code 0 and 0 failures is a pass)');
      }
      break;
    }
    case 'gate': {
      const gate = evidence.gate;
      if (!gate) {
        missing.push('failed gate details (gate name and outcome)');
        break;
      }
      if (!isText(gate.gate)) missing.push('the name of the gate that failed');
      if (gate.passed !== false) missing.push('a gate outcome of passed===false');
      break;
    }
    case 'error-event': {
      const errorEvent = evidence.errorEvent;
      if (!errorEvent) {
        missing.push('the error event itself');
        break;
      }
      if (!isText(errorEvent.type)) missing.push('an error event type');
      if (!isText(errorEvent.runId)) {
        missing.push('an error event carrying a runId');
      } else if (isText(evidence.runId) && errorEvent.runId !== evidence.runId) {
        missing.push(`an error event for THIS run (event runId "${errorEvent.runId}" != run "${evidence.runId}")`);
      }
      break;
    }
    default:
      missing.push("a failure kind: one of 'process', 'test', 'gate', 'error-event'");
      break;
  }

  if ((evidence.evidenceRefs ?? []).length === 0) {
    missing.push('captured evidence refs (stderr, exit code, log or event)');
  }

  return result('failed', missing);
}

export function assertFailedEvidence(evidence: FailedEvidence): void {
  assertGate(checkFailedEvidence(evidence));
}

/* --------------------------------------------------- VERIFYING and REVIEWING */

/** The event that opened a verification or review. Must belong to this run. */
export interface StartEventEvidence {
  readonly type?: string | null;
  readonly runId?: string | null;
  readonly at?: string | null;
}

/**
 * VERIFYING says "somebody is checking this right now". That is only true with a
 * real assignment (a verifier that is not the subject), a start event, and
 * something actually under inspection.
 */
export interface VerifyingEvidence {
  readonly runId?: string | null;
  readonly taskId?: string | null;
  readonly verifierAgentId?: string | null;
  readonly subjectAgentId?: string | null;
  readonly startEvent?: StartEventEvidence | null;
  /** The refs being inspected. An empty list means nothing is being verified. */
  readonly inspectedRefs?: readonly EvidenceRef[] | null;
}

function checkAssignment(
  runId: string | null | undefined,
  actorId: string | null | undefined,
  actorLabel: string,
  subjectId: string | null | undefined,
  startEvent: StartEventEvidence | null | undefined,
  expectedEventType: string,
  inspectedRefs: readonly EvidenceRef[] | null | undefined,
): string[] {
  const missing: string[] = [];
  if (!isText(runId)) missing.push('runId');
  if (!isText(actorId)) missing.push(`${actorLabel} (the assignment)`);
  if (!isText(subjectId)) missing.push('subjectAgentId (what is being examined)');
  if (isText(actorId) && isText(subjectId) && actorId === subjectId) {
    missing.push(`an independent ${actorLabel} (agent "${actorId}" would be examining its own work)`);
  }
  if (!startEvent) {
    missing.push(`a ${expectedEventType} event`);
  } else {
    if (!isText(startEvent.type)) {
      missing.push(`a ${expectedEventType} event with a type`);
    } else if (startEvent.type !== expectedEventType) {
      missing.push(`a ${expectedEventType} event (got "${startEvent.type}")`);
    }
    if (!isText(startEvent.runId)) {
      missing.push(`a ${expectedEventType} event carrying a runId`);
    } else if (isText(runId) && startEvent.runId !== runId) {
      missing.push(`a ${expectedEventType} event for THIS run (event runId "${startEvent.runId}" != run "${runId}")`);
    }
  }
  if ((inspectedRefs ?? []).length === 0) {
    missing.push('at least one evidence ref under inspection');
  }
  return missing;
}

export function checkVerifyingEvidence(evidence: VerifyingEvidence): GateResult {
  return result(
    'verifying',
    checkAssignment(
      evidence.runId,
      evidence.verifierAgentId,
      'verifierAgentId',
      evidence.subjectAgentId,
      evidence.startEvent,
      'verify.started',
      evidence.inspectedRefs,
    ),
  );
}

export function assertVerifyingEvidence(evidence: VerifyingEvidence): void {
  assertGate(checkVerifyingEvidence(evidence));
}

/**
 * REVIEWING additionally requires that verification already produced a verdict —
 * this is where "VERIFYING -> REVIEWING only after a verdict exists" is enforced.
 * Any real verdict qualifies, including REJECTED (that is what REPAIRING is
 * for); UNVERIFIED does not, because it means no verdict was ever reached.
 */
export interface ReviewingEvidence {
  readonly runId?: string | null;
  readonly taskId?: string | null;
  readonly reviewerAgentId?: string | null;
  readonly subjectAgentId?: string | null;
  readonly startEvent?: StartEventEvidence | null;
  readonly inspectedRefs?: readonly EvidenceRef[] | null;
  /** The verdict verification produced. Absent or UNVERIFIED blocks review. */
  readonly verificationVerdict?: VerifyVerdict | null;
}

export function checkReviewingEvidence(evidence: ReviewingEvidence): GateResult {
  const missing = checkAssignment(
    evidence.runId,
    evidence.reviewerAgentId,
    'reviewerAgentId',
    evidence.subjectAgentId,
    evidence.startEvent,
    'review.started',
    evidence.inspectedRefs,
  );
  if (!isText(evidence.verificationVerdict)) {
    missing.push('a verification verdict (VERIFYING -> REVIEWING is only legal once verification concluded)');
  } else if (evidence.verificationVerdict === 'UNVERIFIED') {
    missing.push('a concluded verification (verdict is UNVERIFIED, which means no verdict was reached)');
  }
  return result('reviewing', missing);
}

export function assertReviewingEvidence(evidence: ReviewingEvidence): void {
  assertGate(checkReviewingEvidence(evidence));
}

/* ------------------------------------------- binding gates to the run machine */

/** Which run states may not be written without passing a gate. */
export const RUN_STATE_GATES = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  VERIFYING: 'verifying',
  REVIEWING: 'reviewing',
} as const satisfies Partial<Record<RunState, EvidenceGateName>>);

export function requiredGateForRunState(state: RunState): EvidenceGateName | null {
  const gates = RUN_STATE_GATES as Partial<Record<RunState, EvidenceGateName>>;
  return gates[state] ?? null;
}

/** The evidence a given run state demands, as one discriminated value. */
export type RunStateEvidence =
  | { readonly state: 'RUNNING'; readonly evidence: RunningEvidence }
  | { readonly state: 'COMPLETED'; readonly evidence: CompletedEvidence }
  | { readonly state: 'FAILED'; readonly evidence: FailedEvidence }
  | { readonly state: 'VERIFYING'; readonly evidence: VerifyingEvidence }
  | { readonly state: 'REVIEWING'; readonly evidence: ReviewingEvidence };

/** Non-throwing: what the UI calls to explain why a state is not being shown. */
export function checkRunStateEvidence(input: RunStateEvidence): GateResult {
  switch (input.state) {
    case 'RUNNING':
      return checkRunningEvidence(input.evidence);
    case 'COMPLETED':
      return checkCompletedEvidence(input.evidence);
    case 'FAILED':
      return checkFailedEvidence(input.evidence);
    case 'VERIFYING':
      return checkVerifyingEvidence(input.evidence);
    case 'REVIEWING':
      return checkReviewingEvidence(input.evidence);
  }
}

export function assertRunStateEvidence(input: RunStateEvidence): void {
  assertGate(checkRunStateEvidence(input));
}

/**
 * The single entry point the bridge should use: the transition must be legal AND
 * the target state's evidence must exist. Omitting the evidence for a gated
 * state is itself a refusal — silence is not proof.
 */
export function assertRunTransitionWithEvidence(from: string, to: string, evidence?: RunStateEvidence): void {
  assertRunTransition(from, to);
  const gate = requiredGateForRunState(to as RunState);
  if (gate === null) return;
  if (!evidence || evidence.state !== to) {
    throw new EvidenceError(
      gate,
      [`evidence for ${to}`],
      `Forge state machines: ${from} -> ${to} is a legal transition, but ${to} is gated and no ${gate} evidence was supplied. ` +
        'A status may not be written on the strength of the transition alone.',
    );
  }
  assertRunStateEvidence(evidence);
}

/* ========================================================================== */
/*  The attempt model                                                          */
/* ========================================================================== */

/*
 * A run is not a mutable object with a status field. It is an ordered list of
 * IMMUTABLE attempts. Every state change produces a new attempt record; a
 * terminal attempt produces nothing at all, ever again. Retrying therefore
 * cannot be expressed as "set state back to RUNNING" — the only expressible form
 * is a new attempt with a new id, which is why cancelling attempt 1 can never
 * resurrect it: attempt 1 is frozen, and attempt 2 is a different thing with its
 * own evidence.
 *
 * Ids and timestamps are arguments, not generated here. This module owns no
 * clock and no randomness.
 */

export type AttemptReason = 'initial' | 'retry' | 'repair' | 'recovery';

export interface RunStateChange {
  readonly from: RunState | null;
  readonly to: RunState;
  readonly at: string;
  readonly reason: string | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface RunAttempt {
  readonly runId: string;
  readonly attemptId: string;
  /** 1-based and strictly increasing within a run. */
  readonly attemptNumber: number;
  readonly parentAttemptId: string | null;
  readonly reason: AttemptReason;
  readonly state: RunState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminal: boolean;
  readonly history: readonly RunStateChange[];
}

function freezeAttempt(attempt: RunAttempt): RunAttempt {
  return Object.freeze({
    ...attempt,
    history: Object.freeze(attempt.history.map((entry) => Object.freeze({ ...entry, evidenceRefs: freezeArray(entry.evidenceRefs) }))),
  });
}

export interface CreateAttemptInput {
  readonly runId: string;
  readonly attemptId: string;
  readonly at: string;
  readonly attemptNumber?: number;
  readonly parentAttemptId?: string | null;
  readonly reason?: AttemptReason;
}

/** A new attempt always starts at the machine's initial state: CREATED. */
export function createRunAttempt(input: CreateAttemptInput): RunAttempt {
  const problems: string[] = [];
  if (!isText(input.runId)) problems.push('runId is required');
  if (!isText(input.attemptId)) problems.push('attemptId is required');
  if (!isText(input.at)) problems.push('at (ISO-8601 timestamp) is required');
  const attemptNumber = input.attemptNumber ?? 1;
  if (!isInteger(attemptNumber) || attemptNumber < 1) problems.push('attemptNumber must be an integer >= 1');
  if (problems.length > 0) {
    throw new AttemptError({
      runId: String(input.runId ?? ''),
      attemptId: String(input.attemptId ?? ''),
      problems,
      message: `Forge state machines: cannot create a run attempt — ${problems.join('; ')}.`,
    });
  }

  return freezeAttempt({
    runId: input.runId,
    attemptId: input.attemptId,
    attemptNumber,
    parentAttemptId: input.parentAttemptId ?? null,
    reason: input.reason ?? 'initial',
    state: RUN_MACHINE.initial,
    createdAt: input.at,
    updatedAt: input.at,
    terminal: isTerminalRunState(RUN_MACHINE.initial),
    history: [
      { from: null, to: RUN_MACHINE.initial, at: input.at, reason: 'attempt created', evidenceRefs: [] },
    ],
  });
}

export interface AdvanceAttemptInput {
  readonly at: string;
  readonly reason?: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  /** Required whenever the target state is gated (RUNNING/COMPLETED/FAILED/VERIFYING/REVIEWING). */
  readonly evidence?: RunStateEvidence;
}

/**
 * Returns a NEW frozen attempt. Never mutates the argument. Throws when the
 * attempt is already terminal, when the transition is illegal, or when the
 * target state is gated and its evidence is absent or incomplete.
 */
export function advanceRunAttempt(attempt: RunAttempt, to: RunState, input: AdvanceAttemptInput): RunAttempt {
  if (attempt.terminal) {
    throw new AttemptError({
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      problems: [`attempt ${attempt.attemptNumber} is terminal in state ${attempt.state}`],
      message:
        `Forge state machines: attempt ${attempt.attemptNumber} of run ${attempt.runId} is terminal (${attempt.state}) and is immutable. ` +
        `It cannot be advanced to ${to}. A retry must create a NEW attempt via createRetryAttempt().`,
    });
  }
  if (!isText(input.at)) {
    throw new AttemptError({
      runId: attempt.runId,
      attemptId: attempt.attemptId,
      problems: ['at (ISO-8601 timestamp) is required'],
      message: 'Forge state machines: a state change must record when it happened.',
    });
  }

  assertRunTransitionWithEvidence(attempt.state, to, input.evidence);

  const change: RunStateChange = {
    from: attempt.state,
    to,
    at: input.at,
    reason: input.reason ?? null,
    evidenceRefs: input.evidenceRefs ?? [],
  };

  return freezeAttempt({
    ...attempt,
    state: to,
    updatedAt: input.at,
    terminal: isTerminalRunState(to),
    history: [...attempt.history, change],
  });
}

export interface RetryAttemptInput {
  readonly attemptId: string;
  readonly at: string;
  readonly reason?: AttemptReason;
}

/**
 * The only way to try again. The previous attempt must be terminal and is left
 * exactly as it was — cancelled stays cancelled, failed stays failed. The new
 * attempt starts at CREATED with an empty history of its own and a pointer back
 * to its parent, so the audit trail keeps every attempt that was ever made.
 */
export function createRetryAttempt(previous: RunAttempt, input: RetryAttemptInput): RunAttempt {
  if (!previous.terminal) {
    throw new AttemptError({
      runId: previous.runId,
      attemptId: previous.attemptId,
      problems: [`attempt ${previous.attemptNumber} is still live in state ${previous.state}`],
      message:
        `Forge state machines: cannot start a retry while attempt ${previous.attemptNumber} of run ${previous.runId} is still live (${previous.state}). ` +
        'Bring it to a terminal state first — two live attempts for one run cannot both be true.',
    });
  }
  return createRunAttempt({
    runId: previous.runId,
    attemptId: input.attemptId,
    at: input.at,
    attemptNumber: previous.attemptNumber + 1,
    parentAttemptId: previous.attemptId,
    reason: input.reason ?? 'retry',
  });
}

export interface AttemptSequenceResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * The invariants a run's attempt list must satisfy. At most one attempt may be
 * live, because two simultaneous live attempts would mean the workspace is
 * showing a state that is true of neither.
 */
export function checkAttemptSequence(attempts: readonly RunAttempt[]): AttemptSequenceResult {
  const problems: string[] = [];
  if (attempts.length === 0) {
    problems.push('a run must have at least one attempt');
    return Object.freeze({ ok: false, problems: Object.freeze(problems) });
  }

  const runId = attempts[0].runId;
  const seenIds = new Set<string>();
  attempts.forEach((attempt, index) => {
    if (attempt.runId !== runId) {
      problems.push(`attempt ${attempt.attemptId} belongs to run ${attempt.runId}, not ${runId}`);
    }
    if (seenIds.has(attempt.attemptId)) problems.push(`duplicate attemptId ${attempt.attemptId}`);
    seenIds.add(attempt.attemptId);
    if (attempt.attemptNumber !== index + 1) {
      problems.push(`attempt at position ${index + 1} is numbered ${attempt.attemptNumber}`);
    }
    if (index === 0) {
      if (attempt.parentAttemptId !== null) {
        problems.push(`the first attempt must have no parent (found ${attempt.parentAttemptId})`);
      }
    } else if (attempt.parentAttemptId !== attempts[index - 1].attemptId) {
      problems.push(
        `attempt ${attempt.attemptNumber} points at parent ${String(attempt.parentAttemptId)}, expected ${attempts[index - 1].attemptId}`,
      );
    }
    if (attempt.terminal !== isTerminalRunState(attempt.state)) {
      problems.push(`attempt ${attempt.attemptNumber} claims terminal=${attempt.terminal} in state ${attempt.state}`);
    }
    if (index < attempts.length - 1 && !attempt.terminal) {
      problems.push(
        `attempt ${attempt.attemptNumber} is superseded but still live (${attempt.state}); only the last attempt may be live`,
      );
    }
  });

  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}

export function assertAttemptSequence(attempts: readonly RunAttempt[]): void {
  const outcome = checkAttemptSequence(attempts);
  if (outcome.ok) return;
  throw new AttemptError({
    runId: attempts[0]?.runId ?? '',
    attemptId: attempts[attempts.length - 1]?.attemptId ?? '',
    problems: outcome.problems,
    message: `Forge state machines: the attempt sequence is not well-formed:\n- ${outcome.problems.join('\n- ')}`,
  });
}

/** The attempt a run's state should be read from: the last one. */
export function currentAttempt(attempts: readonly RunAttempt[]): RunAttempt | null {
  return attempts.length === 0 ? null : attempts[attempts.length - 1];
}

/**
 * The run's state, derived rather than stored. `null` for an empty list, because
 * a run with no attempts has no state to report — and inventing CREATED there
 * would be exactly the kind of small lie this file exists to prevent.
 */
export function deriveRunState(attempts: readonly RunAttempt[]): RunState | null {
  return currentAttempt(attempts)?.state ?? null;
}
