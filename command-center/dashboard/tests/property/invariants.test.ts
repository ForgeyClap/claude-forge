/**
 * Property tests over the real state machines (mission section M).
 *
 * `src/shared/state-machines.ts` is pure, total and deterministic — no clock, no
 * randomness, no I/O — which is exactly what makes it property-testable. This
 * file drives it with thousands of generated transition sequences and checks
 * that five claims hold for EVERY one of them:
 *
 *   1. a terminal state never transitions again
 *   2. COMPLETED is unreachable without the completion evidence gate passing
 *   3. a cancelled attempt never returns to RUNNING
 *   4. FAILED reaches COMPLETED only through REPAIRING and a retest
 *   5. VERIFYING reaches COMPLETED only with a verdict present
 *
 * plus four structural invariants about the engine itself (only legal
 * transitions are accepted, every refusal has a real reason, the attempt list
 * stays well formed, and nothing is mutated behind the caller's back).
 *
 * NO PROPERTY-TESTING DEPENDENCY. The generator below is a seeded mulberry32
 * PRNG, so the whole exploration is reproducible from one integer: the same
 * seed always produces the same sequences, and a failure found in CI can be
 * replayed exactly. When a property fails, the sequence is shrunk by greedy
 * step removal and the SHORTEST still-failing sequence is reported.
 *
 * THE SHRINKER IS ITSELF TESTED. A passing suite exercises no failure path, so
 * a deliberately-false canary property ("a run never reaches COMPLETED") is run
 * through the same engine. It must be found, and the reported witness must be
 * minimal — every step removable from it must stop the failure.
 */

import { describe, expect, it } from 'vitest';
import console from 'node:console';

import {
  COMPLETING_VERDICTS,
  MACHINES,
  MACHINE_IDS,
  RUN_MACHINE,
  advanceRunAttempt,
  allowedTransitionsFrom,
  assertMachineRegistryValid,
  canRunTransition,
  canTransitionIn,
  checkAttemptSequence,
  checkCompletedEvidence,
  checkReviewingEvidence,
  checkRunStateEvidence,
  createRetryAttempt,
  createRunAttempt,
  deriveRunState,
  explainRunTransition,
  explainTransitionIn,
  isTerminalIn,
  isTerminalRunState,
  predecessorsOf,
  requiredGateForRunState,
} from '@/shared/state-machines';
import type { RunAttempt, RunState, RunStateEvidence } from '@/shared/state-machines';
import type { EvidenceRef } from '@/shared/protocol';

/* ========================================================================== */
/*  A seeded, dependency-free generator                                        */
/* ========================================================================== */

interface Rng {
  next(): number;
  int(bound: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32. Small, fast, and identical on every machine and every run. */
function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (bound: number) => Math.floor(next() * bound),
    pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)],
  };
}

/* ========================================================================== */
/*  Evidence, built to pass or built to fail — deterministically               */
/* ========================================================================== */

const RUN_ID = 'run-property';
const BASE_MS = Date.UTC(2026, 6, 24, 9, 0, 0);
const at = (tick: number): string => new Date(BASE_MS + tick * 1_000).toISOString();

const PROOF: readonly EvidenceRef[] = [
  { kind: 'exit-code', ref: '0', note: 'observed on wait()' },
  { kind: 'stdout', ref: 'events/run-property.stdout.log' },
];
const INSPECTED: readonly EvidenceRef[] = [{ kind: 'file', ref: 'src/example.ts', hash: 'abc123' }];

type GatedState = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'VERIFYING' | 'REVIEWING';

function isGated(state: RunState): state is GatedState {
  return requiredGateForRunState(state) !== null;
}

/**
 * Evidence that satisfies the gate. Deliberately independent of the step index:
 * shrinking removes steps, and evidence whose validity depended on position
 * would make a shrunk sequence a different experiment.
 */
function completeEvidence(state: GatedState): RunStateEvidence {
  switch (state) {
    case 'RUNNING':
      return {
        state: 'RUNNING',
        evidence: {
          runId: RUN_ID,
          projectId: 'proj-property',
          pid: 4242,
          pidAlive: true,
          startedAt: at(0),
          lastHeartbeatAt: BASE_MS + 5_000,
          observedAt: BASE_MS + 6_000,
        },
      };
    case 'COMPLETED':
      return {
        state: 'COMPLETED',
        evidence: {
          runId: RUN_ID,
          processExitObserved: true,
          exitCode: 0,
          outputRef: 'events/run-property.jsonl',
          finalEvent: { type: 'run.output.complete', runId: RUN_ID, status: 'COMPLETED', sequence: 42 },
          proofRefs: PROOF,
          verdict: 'VERIFIED_PASS',
          verifierAgentId: 'verifier-1',
          subjectAgentId: 'builder-1',
        },
      };
    case 'FAILED':
      return {
        state: 'FAILED',
        evidence: {
          runId: RUN_ID,
          failure: 'process',
          process: { exitObserved: true, exitCode: 1 },
          evidenceRefs: [{ kind: 'stderr', ref: 'events/run-property.stderr.log' }],
        },
      };
    case 'VERIFYING':
      return {
        state: 'VERIFYING',
        evidence: {
          runId: RUN_ID,
          taskId: 'task-1',
          verifierAgentId: 'verifier-1',
          subjectAgentId: 'builder-1',
          startEvent: { type: 'verify.started', runId: RUN_ID, at: at(1) },
          inspectedRefs: INSPECTED,
        },
      };
    case 'REVIEWING':
      return {
        state: 'REVIEWING',
        evidence: {
          runId: RUN_ID,
          taskId: 'task-1',
          reviewerAgentId: 'reviewer-1',
          subjectAgentId: 'builder-1',
          startEvent: { type: 'review.started', runId: RUN_ID, at: at(2) },
          inspectedRefs: INSPECTED,
          verificationVerdict: 'VERIFIED_PASS',
        },
      };
  }
}

/** Each variant removes exactly one fact the gate depends on. */
function brokenEvidence(state: GatedState, variant: number): RunStateEvidence {
  const good = completeEvidence(state);
  switch (good.state) {
    case 'RUNNING': {
      const e = good.evidence;
      const variants: RunStateEvidence[] = [
        { state: 'RUNNING', evidence: { ...e, pidAlive: false } },
        { state: 'RUNNING', evidence: { ...e, lastHeartbeatAt: null } },
        { state: 'RUNNING', evidence: { ...e, lastHeartbeatAt: BASE_MS - 600_000 } },
        { state: 'RUNNING', evidence: { ...e, runId: '' } },
        { state: 'RUNNING', evidence: { ...e, pid: null, forgeTaskId: null } },
      ];
      return variants[variant % variants.length];
    }
    case 'COMPLETED': {
      const e = good.evidence;
      const variants: RunStateEvidence[] = [
        { state: 'COMPLETED', evidence: { ...e, processExitObserved: false } },
        { state: 'COMPLETED', evidence: { ...e, exitCode: null } },
        { state: 'COMPLETED', evidence: { ...e, verdict: 'UNVERIFIED' } },
        { state: 'COMPLETED', evidence: { ...e, proofRefs: [] } },
        { state: 'COMPLETED', evidence: { ...e, finalEvent: { type: 'run.output.complete', runId: 'another-run' } } },
        { state: 'COMPLETED', evidence: { ...e, verifierAgentId: 'builder-1' } },
        { state: 'COMPLETED', evidence: { ...e, outputRef: null } },
      ];
      return variants[variant % variants.length];
    }
    case 'FAILED': {
      const e = good.evidence;
      const variants: RunStateEvidence[] = [
        { state: 'FAILED', evidence: { ...e, failure: null } },
        { state: 'FAILED', evidence: { ...e, process: { exitObserved: true, exitCode: 0 } } },
        { state: 'FAILED', evidence: { ...e, evidenceRefs: [] } },
      ];
      return variants[variant % variants.length];
    }
    case 'VERIFYING': {
      const e = good.evidence;
      const variants: RunStateEvidence[] = [
        { state: 'VERIFYING', evidence: { ...e, verifierAgentId: 'builder-1' } },
        { state: 'VERIFYING', evidence: { ...e, startEvent: { type: 'run.state', runId: RUN_ID } } },
        { state: 'VERIFYING', evidence: { ...e, inspectedRefs: [] } },
      ];
      return variants[variant % variants.length];
    }
    case 'REVIEWING': {
      const e = good.evidence;
      const variants: RunStateEvidence[] = [
        { state: 'REVIEWING', evidence: { ...e, verificationVerdict: null } },
        { state: 'REVIEWING', evidence: { ...e, verificationVerdict: 'UNVERIFIED' } },
        { state: 'REVIEWING', evidence: { ...e, reviewerAgentId: 'builder-1' } },
        { state: 'REVIEWING', evidence: { ...e, inspectedRefs: [] } },
      ];
      return variants[variant % variants.length];
    }
  }
}

type Quality = 'complete' | 'broken' | 'absent';

function evidenceFor(to: RunState, quality: Quality, variant: number): RunStateEvidence | undefined {
  if (!isGated(to)) return undefined;
  if (quality === 'absent') return undefined;
  return quality === 'complete' ? completeEvidence(to) : brokenEvidence(to, variant);
}

/* ========================================================================== */
/*  Steps and the deterministic runner                                         */
/* ========================================================================== */

type Step =
  | { readonly kind: 'advance'; readonly to: RunState; readonly quality: Quality; readonly variant: number }
  | { readonly kind: 'retry' };

interface AcceptedTransition {
  readonly stepIndex: number;
  readonly attemptIndex: number;
  readonly from: RunState;
  readonly to: RunState;
  readonly evidence: RunStateEvidence | undefined;
}

interface RejectedTransition {
  readonly stepIndex: number;
  readonly from: RunState;
  readonly to: RunState;
  readonly quality: Quality;
  readonly evidence: RunStateEvidence | undefined;
  readonly errorName: string;
}

interface Trace {
  readonly steps: readonly Step[];
  readonly attempts: readonly RunAttempt[];
  readonly accepted: readonly AcceptedTransition[];
  readonly rejected: readonly RejectedTransition[];
  readonly retriesAccepted: number;
  readonly retriesRejected: number;
  readonly anomalies: readonly string[];
}

/** The states an attempt actually occupied, in order, starting at CREATED. */
function statesOf(attempt: RunAttempt): readonly RunState[] {
  return attempt.history.map((entry) => entry.to);
}

/**
 * Replays a step list against the real API. Pure: same steps in, same trace out,
 * which is what makes the shrinker below sound.
 */
function runSequence(steps: readonly Step[]): Trace {
  const attempts: RunAttempt[] = [createRunAttempt({ runId: RUN_ID, attemptId: 'attempt-1', at: at(0) })];
  const accepted: AcceptedTransition[] = [];
  const rejected: RejectedTransition[] = [];
  const anomalies: string[] = [];
  let retriesAccepted = 0;
  let retriesRejected = 0;

  steps.forEach((step, index) => {
    const attemptIndex = attempts.length - 1;
    const current = attempts[attemptIndex];

    if (step.kind === 'retry') {
      try {
        const next = createRetryAttempt(current, {
          attemptId: `attempt-${attempts.length + 1}`,
          at: at(index + 1),
        });
        if (!current.terminal) {
          anomalies.push(`step ${index}: a retry was allowed while attempt ${current.attemptNumber} was still live`);
        }
        attempts.push(next);
        retriesAccepted += 1;
      } catch {
        if (current.terminal) {
          anomalies.push(`step ${index}: a retry after a terminal attempt (${current.state}) was refused`);
        }
        retriesRejected += 1;
      }
      return;
    }

    const evidence = evidenceFor(step.to, step.quality, step.variant);
    const wasTerminal = current.terminal;
    const stateBefore = current.state;
    const historyBefore = current.history.length;

    try {
      const next = advanceRunAttempt(current, step.to, {
        at: at(index + 1),
        reason: `generated step ${index}`,
        evidence,
      });
      if (wasTerminal) {
        anomalies.push(`step ${index}: a terminal attempt in ${stateBefore} accepted an advance to ${step.to}`);
      }
      if (current.state !== stateBefore || current.history.length !== historyBefore) {
        anomalies.push(`step ${index}: advanceRunAttempt mutated the attempt it was given`);
      }
      if (!Object.isFrozen(current) || !Object.isFrozen(next)) {
        anomalies.push(`step ${index}: an attempt was handed out unfrozen`);
      }
      if (next.history.length !== historyBefore + 1) {
        anomalies.push(`step ${index}: history grew by ${next.history.length - historyBefore}, expected 1`);
      }
      attempts[attemptIndex] = next;
      accepted.push({ stepIndex: index, attemptIndex, from: stateBefore, to: step.to, evidence });
    } catch (err) {
      rejected.push({
        stepIndex: index,
        from: stateBefore,
        to: step.to,
        quality: step.quality,
        evidence,
        errorName: err instanceof Error ? err.name : 'unknown',
      });
      if (attempts[attemptIndex] !== current) {
        anomalies.push(`step ${index}: a refused transition still changed the attempt`);
      }
    }
  });

  return { steps, attempts, accepted, rejected, retriesAccepted, retriesRejected, anomalies };
}

/* ========================================================================== */
/*  Generation, biased enough to actually reach the interesting states         */
/* ========================================================================== */

/**
 * One step along a shortest path to `target`, per state. Purely random walks
 * essentially never reach COMPLETED (roughly one path in 10^5), which would make
 * properties 2, 4 and 5 vacuous. This bias is what makes them real.
 */
function nextStepToward(target: RunState): Readonly<Record<string, RunState | null>> {
  const distance = new Map<RunState, number>([[target, 0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const from of RUN_MACHINE.states) {
      for (const to of RUN_MACHINE.transitions[from]) {
        const reached = distance.get(to);
        if (reached === undefined) continue;
        const candidate = reached + 1;
        const existing = distance.get(from);
        if (existing === undefined || candidate < existing) {
          distance.set(from, candidate);
          changed = true;
        }
      }
    }
  }
  const next: Record<string, RunState | null> = {};
  for (const from of RUN_MACHINE.states) {
    let best: RunState | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const to of RUN_MACHINE.transitions[from]) {
      const d = distance.get(to);
      if (d !== undefined && d < bestDistance) {
        bestDistance = d;
        best = to;
      }
    }
    next[from] = best;
  }
  return Object.freeze(next);
}

const TOWARD_COMPLETED = nextStepToward('COMPLETED');

function generateSequence(rng: Rng, maxSteps: number): readonly Step[] {
  const steps: Step[] = [];
  const length = 6 + rng.int(Math.max(1, maxSteps - 5));
  let state: RunState = RUN_MACHINE.initial;
  let terminal = isTerminalRunState(RUN_MACHINE.initial);

  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();

    if (terminal) {
      // Half the time keep pushing at the terminal attempt (which must always be
      // refused), half the time open a new one so the run can continue.
      if (roll < 0.5) {
        steps.push({ kind: 'retry' });
        state = RUN_MACHINE.initial;
        terminal = isTerminalRunState(RUN_MACHINE.initial);
      } else {
        steps.push({ kind: 'advance', to: rng.pick(RUN_MACHINE.states), quality: 'complete', variant: 0 });
      }
      continue;
    }

    const allowed = allowedTransitionsFrom(RUN_MACHINE, state);
    let to: RunState;
    if (roll < 0.55 && TOWARD_COMPLETED[state] !== null) {
      to = TOWARD_COMPLETED[state] as RunState;
    } else if (roll < 0.85 && allowed.length > 0) {
      to = rng.pick(allowed);
    } else {
      to = rng.pick(RUN_MACHINE.states); // usually illegal, on purpose
    }

    const qualityRoll = rng.next();
    const quality: Quality = qualityRoll < 0.78 ? 'complete' : qualityRoll < 0.94 ? 'broken' : 'absent';
    const variant = rng.int(8);
    steps.push({ kind: 'advance', to, quality, variant });

    // Mirror the runner so the generator knows where it stands. Acceptance is
    // computed from the same functions the runner uses, never guessed.
    const evidence = evidenceFor(to, quality, variant);
    const gate = requiredGateForRunState(to);
    const gatePasses =
      gate === null || (evidence !== undefined && evidence.state === to && checkRunStateEvidence(evidence).ok);
    if (canRunTransition(state, to) && gatePasses) {
      state = to;
      terminal = isTerminalRunState(to);
    }
  }

  return steps;
}

/* ========================================================================== */
/*  The properties                                                             */
/* ========================================================================== */

interface PropertyResult {
  readonly checks: number;
  readonly violation: string | null;
}

interface Property {
  readonly name: string;
  readonly run: (trace: Trace) => PropertyResult;
}

function indexOfState(states: readonly RunState[], state: RunState): number {
  return states.indexOf(state);
}

/** Does the gate for `to` genuinely refuse this evidence? Used to justify refusals. */
function gateWouldRefuse(to: RunState, evidence: RunStateEvidence | undefined): boolean {
  const gate = requiredGateForRunState(to);
  if (gate === null) return false;
  if (evidence === undefined || evidence.state !== to) return true;
  return !checkRunStateEvidence(evidence).ok;
}

const TERMINAL_NEVER_MOVES: Property = {
  name: 'a terminal state never transitions again',
  run: (trace) => {
    let checks = 0;
    for (const attempt of trace.attempts) {
      const states = statesOf(attempt);
      for (let i = 0; i < states.length; i += 1) {
        checks += 1;
        if (isTerminalRunState(states[i]) && i !== states.length - 1) {
          return {
            checks,
            violation: `attempt ${attempt.attemptNumber} left the terminal state ${states[i]} for ${states[i + 1]}`,
          };
        }
      }
    }
    for (const transition of trace.accepted) {
      checks += 1;
      if (isTerminalRunState(transition.from)) {
        return {
          checks,
          violation: `step ${transition.stepIndex} was accepted out of terminal state ${transition.from} to ${transition.to}`,
        };
      }
    }
    for (const terminal of RUN_MACHINE.terminal) {
      checks += 1;
      if (RUN_MACHINE.transitions[terminal].length !== 0) {
        return { checks, violation: `${terminal} is terminal but declares outgoing transitions` };
      }
      for (const target of RUN_MACHINE.states) {
        checks += 1;
        const verdict = explainRunTransition(terminal, target);
        if (verdict.ok || verdict.rejection !== 'TERMINAL_STATE') {
          return { checks, violation: `${terminal} -> ${target} was not refused as TERMINAL_STATE` };
        }
      }
    }
    return { checks, violation: null };
  },
};

const COMPLETED_NEEDS_THE_GATE: Property = {
  name: 'COMPLETED is unreachable without the completion evidence gate passing',
  run: (trace) => {
    let checks = 0;

    checks += 1;
    const predecessors = predecessorsOf(RUN_MACHINE, 'COMPLETED');
    if (predecessors.length !== 1 || predecessors[0] !== 'REVIEWING') {
      return { checks, violation: `COMPLETED has predecessors ${predecessors.join(', ')}, expected REVIEWING alone` };
    }

    for (const transition of trace.accepted) {
      if (transition.to !== 'COMPLETED') continue;
      checks += 3;
      if (transition.from !== 'REVIEWING') {
        return { checks, violation: `COMPLETED was entered from ${transition.from}, not REVIEWING` };
      }
      if (transition.evidence === undefined || transition.evidence.state !== 'COMPLETED') {
        return { checks, violation: `COMPLETED was accepted at step ${transition.stepIndex} with no completion evidence` };
      }
      const gate = checkCompletedEvidence(transition.evidence.evidence);
      if (!gate.ok) {
        return {
          checks,
          violation: `COMPLETED was accepted at step ${transition.stepIndex} although the gate reports missing: ${gate.missing.join('; ')}`,
        };
      }
      checks += 1;
      if (!(COMPLETING_VERDICTS as readonly string[]).includes(String(transition.evidence.evidence.verdict))) {
        return { checks, violation: `COMPLETED was accepted with verdict ${String(transition.evidence.evidence.verdict)}` };
      }
    }

    for (const refusal of trace.rejected) {
      if (refusal.to !== 'COMPLETED') continue;
      checks += 1;
      const legal = canRunTransition(refusal.from, 'COMPLETED');
      if (legal && !gateWouldRefuse('COMPLETED', refusal.evidence)) {
        return {
          checks,
          violation: `COMPLETED was refused at step ${refusal.stepIndex} from ${refusal.from} even though the transition and the evidence were both fine`,
        };
      }
    }

    return { checks, violation: null };
  },
};

const CANCELLED_NEVER_RESUMES: Property = {
  name: 'a cancelled attempt never returns to RUNNING',
  run: (trace) => {
    let checks = 0;

    checks += 1;
    if (explainRunTransition('CANCELLED', 'RUNNING').rejection !== 'TERMINAL_STATE') {
      return { checks, violation: 'CANCELLED -> RUNNING was not refused as a terminal state' };
    }

    for (const attempt of trace.attempts) {
      const states = statesOf(attempt);
      const cancelledAt = indexOfState(states, 'CANCELLED');
      if (cancelledAt < 0) continue;
      checks += 3;
      if (cancelledAt !== states.length - 1) {
        return {
          checks,
          violation: `attempt ${attempt.attemptNumber} continued to ${states[cancelledAt + 1]} after CANCELLED`,
        };
      }
      if (attempt.state !== 'CANCELLED' || !attempt.terminal) {
        return { checks, violation: `attempt ${attempt.attemptNumber} was cancelled but ends as ${attempt.state}` };
      }
      if (!Object.isFrozen(attempt)) {
        return { checks, violation: `cancelled attempt ${attempt.attemptNumber} is not frozen` };
      }
    }

    for (const transition of trace.accepted) {
      checks += 1;
      if (transition.from === 'CANCELLED') {
        return { checks, violation: `step ${transition.stepIndex} escaped CANCELLED to ${transition.to}` };
      }
    }

    return { checks, violation: null };
  },
};

/*
 * NOTE, found by this generator and left visible on purpose. An earlier draft of
 * this property also demanded that a completing attempt had entered RUNNING. The
 * search refused it in seven steps:
 *
 *   QUEUED -> STARTING -> INTERRUPTED -> RECOVERING -> VERIFYING -> REVIEWING -> COMPLETED
 *
 * `RECOVERING -> VERIFYING` is deliberate (see the comment on RECOVERING in
 * state-machines.ts: reconciliation may hand a recovered run to verification),
 * so an attempt can complete without a RUNNING of its own. The real contract is
 * that completion is always immediately preceded by REVIEWING, which is always
 * immediately preceded by VERIFYING — a re-inspection, never a relabel — and the
 * COMPLETED gate still demands an observed process exit. That is what is checked.
 *
 * A second draft demanded RETRYING after every REPAIRING. The search refused
 * that too, in eleven steps:
 *
 *   ... REVIEWING -> REPAIRING -> INTERRUPTED -> RECOVERING -> VERIFYING -> REVIEWING -> COMPLETED
 *
 * so a repair can be interrupted and recovered straight back into verification.
 * The clause that survives is the one that carries the meaning: the VERIFYING
 * that immediately precedes a completion must sit AFTER the attempt's last
 * REPAIRING, so the verdict is never one carried over from before the repair.
 * (Reported as an observation — a repair that is interrupted and recovered is
 * signed off by re-verification rather than by re-execution.)
 */
const FAILED_ONLY_VIA_REPAIR_AND_RETEST: Property = {
  name: 'FAILED reaches COMPLETED only through REPAIRING and a retest',
  run: (trace) => {
    let checks = 4;

    if (canRunTransition('FAILED', 'COMPLETED')) {
      return { checks, violation: 'FAILED -> COMPLETED is legal, so a failure could be relabelled a success' };
    }
    if (RUN_MACHINE.transitions.FAILED.length !== 0) {
      return { checks, violation: 'FAILED declares outgoing transitions' };
    }
    if (!(RUN_MACHINE.transitions.REPAIRING as readonly string[]).includes('RETRYING')) {
      return { checks, violation: 'REPAIRING cannot reach RETRYING, so the repair route does not exist' };
    }
    if (!(RUN_MACHINE.transitions.RETRYING as readonly string[]).includes('RUNNING')) {
      return { checks, violation: 'RETRYING cannot reach RUNNING, so a retry could never re-execute' };
    }

    for (const attempt of trace.attempts) {
      const states = statesOf(attempt);
      const failedAt = indexOfState(states, 'FAILED');
      if (failedAt >= 0) {
        checks += 2;
        if (failedAt !== states.length - 1) {
          return {
            checks,
            violation: `attempt ${attempt.attemptNumber} continued to ${states[failedAt + 1]} after FAILED`,
          };
        }
        if (attempt.state !== 'FAILED') {
          return { checks, violation: `attempt ${attempt.attemptNumber} recorded FAILED but ends as ${attempt.state}` };
        }
      }

      const completedAt = indexOfState(states, 'COMPLETED');
      if (completedAt < 0) continue;

      // A completion is a re-inspection, never a relabel: the two states
      // immediately before it must be VERIFYING then REVIEWING.
      checks += 3;
      if (completedAt !== states.length - 1) {
        return { checks, violation: `attempt ${attempt.attemptNumber} continued to ${states[completedAt + 1]} after COMPLETED` };
      }
      if (completedAt < 2 || states[completedAt - 1] !== 'REVIEWING') {
        return { checks, violation: `attempt ${attempt.attemptNumber} completed out of ${states[completedAt - 1]}, not REVIEWING` };
      }
      if (states[completedAt - 2] !== 'VERIFYING') {
        return {
          checks,
          violation: `attempt ${attempt.attemptNumber} reviewed out of ${states[completedAt - 2]}, not VERIFYING`,
        };
      }

      // If this attempt was repaired, the verdict that completed it must have
      // been produced after that repair — never carried over from before it.
      // states[completedAt - 2] is already known to be VERIFYING; the content
      // here is that it sits after the LAST REPAIRING.
      const repairedAt = states.lastIndexOf('REPAIRING');
      if (repairedAt >= 0 && repairedAt < completedAt) {
        checks += 2;
        if (completedAt - 2 <= repairedAt) {
          return {
            checks,
            violation: `attempt ${attempt.attemptNumber} completed on a verification that predates its last REPAIRING`,
          };
        }
        const afterRepair = states[repairedAt + 1];
        if (!(RUN_MACHINE.transitions.REPAIRING as readonly string[]).includes(afterRepair)) {
          return {
            checks,
            violation: `attempt ${attempt.attemptNumber} left REPAIRING for ${afterRepair}, which the table does not allow`,
          };
        }
      }

      // If any earlier attempt of this run FAILED, that failure stays a failure
      // and this completion belongs to a different attempt entirely.
      const earlierFailures = trace.attempts.filter(
        (other) => other.attemptNumber < attempt.attemptNumber && other.state === 'FAILED',
      );
      if (earlierFailures.length > 0) {
        checks += 2;
        if (attempt.parentAttemptId === null) {
          return { checks, violation: `attempt ${attempt.attemptNumber} completed after a failure but has no parent` };
        }
        if (earlierFailures.some((other) => other.state !== 'FAILED' || !other.terminal)) {
          return { checks, violation: 'a previously failed attempt was rewritten once a later attempt completed' };
        }
      }
    }

    return { checks, violation: null };
  },
};

const VERIFYING_NEEDS_A_VERDICT: Property = {
  name: 'VERIFYING reaches COMPLETED only with a verdict present',
  run: (trace) => {
    let checks = 0;

    checks += 2;
    const reviewPredecessors = predecessorsOf(RUN_MACHINE, 'REVIEWING');
    if (reviewPredecessors.length !== 1 || reviewPredecessors[0] !== 'VERIFYING') {
      return { checks, violation: `REVIEWING has predecessors ${reviewPredecessors.join(', ')}, expected VERIFYING alone` };
    }
    if (canRunTransition('VERIFYING', 'COMPLETED')) {
      return { checks, violation: 'VERIFYING -> COMPLETED is legal, which would skip review entirely' };
    }

    for (const transition of trace.accepted) {
      if (transition.to !== 'COMPLETED') continue;
      const review = [...trace.accepted]
        .filter(
          (other) =>
            other.attemptIndex === transition.attemptIndex &&
            other.stepIndex < transition.stepIndex &&
            other.to === 'REVIEWING',
        )
        .pop();

      checks += 4;
      if (review === undefined) {
        return { checks, violation: `COMPLETED at step ${transition.stepIndex} had no preceding REVIEWING` };
      }
      if (review.from !== 'VERIFYING') {
        return { checks, violation: `REVIEWING was entered from ${review.from}, not VERIFYING` };
      }
      if (review.evidence === undefined || review.evidence.state !== 'REVIEWING') {
        return { checks, violation: `REVIEWING at step ${review.stepIndex} carried no reviewing evidence` };
      }
      const verdict = review.evidence.evidence.verificationVerdict;
      if (typeof verdict !== 'string' || verdict.trim().length === 0 || verdict === 'UNVERIFIED') {
        return {
          checks,
          violation: `REVIEWING at step ${review.stepIndex} was accepted with verdict ${String(verdict)}`,
        };
      }
      checks += 1;
      if (!checkReviewingEvidence(review.evidence.evidence).ok) {
        return { checks, violation: `REVIEWING at step ${review.stepIndex} was accepted although its gate refuses it` };
      }
    }

    return { checks, violation: null };
  },
};

const ONLY_TABLE_TRANSITIONS: Property = {
  name: 'every accepted transition is one the machine actually allows',
  run: (trace) => {
    let checks = 0;
    for (const transition of trace.accepted) {
      checks += 2;
      if (!canRunTransition(transition.from, transition.to)) {
        return { checks, violation: `${transition.from} -> ${transition.to} was accepted but is not in the table` };
      }
      if (!(allowedTransitionsFrom(RUN_MACHINE, transition.from) as readonly string[]).includes(transition.to)) {
        return { checks, violation: `${transition.from} -> ${transition.to} is not in allowedTransitionsFrom` };
      }
    }
    return { checks, violation: null };
  },
};

const REFUSALS_HAVE_REASONS: Property = {
  name: 'every refusal has a real reason',
  run: (trace) => {
    let checks = 0;
    for (const refusal of trace.rejected) {
      checks += 1;
      const illegal = !canRunTransition(refusal.from, refusal.to);
      const gated = gateWouldRefuse(refusal.to, refusal.evidence);
      if (!illegal && !gated) {
        return {
          checks,
          violation: `step ${refusal.stepIndex} refused ${refusal.from} -> ${refusal.to} with neither an illegal transition nor a failing gate`,
        };
      }
      checks += 1;
      if (!['StateTransitionError', 'EvidenceError', 'AttemptError'].includes(refusal.errorName)) {
        return { checks, violation: `refusal at step ${refusal.stepIndex} threw ${refusal.errorName}` };
      }
    }
    return { checks, violation: null };
  },
};

const ATTEMPT_LIST_STAYS_WELL_FORMED: Property = {
  name: 'the attempt list stays well formed',
  run: (trace) => {
    let checks = 1;
    const outcome = checkAttemptSequence(trace.attempts);
    if (!outcome.ok) {
      return { checks, violation: `checkAttemptSequence: ${outcome.problems.join('; ')}` };
    }
    checks += 1;
    const last = trace.attempts[trace.attempts.length - 1];
    if (deriveRunState(trace.attempts) !== last.state) {
      return { checks, violation: 'deriveRunState disagrees with the last attempt' };
    }
    for (const attempt of trace.attempts) {
      checks += 2;
      if (attempt.terminal !== isTerminalRunState(attempt.state)) {
        return { checks, violation: `attempt ${attempt.attemptNumber} claims terminal=${attempt.terminal} in ${attempt.state}` };
      }
      if (!Object.isFrozen(attempt)) {
        return { checks, violation: `attempt ${attempt.attemptNumber} is not frozen` };
      }
    }
    return { checks, violation: null };
  },
};

const NO_ENGINE_ANOMALIES: Property = {
  name: 'the engine observed nothing it could not explain',
  run: (trace) => ({
    checks: 1,
    violation: trace.anomalies.length === 0 ? null : trace.anomalies.join(' | '),
  }),
};

const PROPERTIES: readonly Property[] = [
  TERMINAL_NEVER_MOVES,
  COMPLETED_NEEDS_THE_GATE,
  CANCELLED_NEVER_RESUMES,
  FAILED_ONLY_VIA_REPAIR_AND_RETEST,
  VERIFYING_NEEDS_A_VERDICT,
  ONLY_TABLE_TRANSITIONS,
  REFUSALS_HAVE_REASONS,
  ATTEMPT_LIST_STAYS_WELL_FORMED,
  NO_ENGINE_ANOMALIES,
];

/** Deliberately false. Exists to prove the search and the shrinker both work. */
const CANARY: Property = {
  name: 'CANARY (deliberately false): a run never reaches COMPLETED',
  run: (trace) => {
    const completed = trace.accepted.some((transition) => transition.to === 'COMPLETED');
    return { checks: 1, violation: completed ? 'a run reached COMPLETED' : null };
  },
};

/* ========================================================================== */
/*  The engine: explore, then shrink                                           */
/* ========================================================================== */

interface Violation {
  readonly property: string;
  readonly message: string;
  readonly seed: number;
  readonly originalLength: number;
  readonly shortest: readonly Step[];
  readonly shortestMessage: string;
}

interface ExploreReport {
  readonly sequencesExplored: number;
  readonly stepsGenerated: number;
  readonly transitionsAccepted: number;
  readonly transitionsRejected: number;
  readonly retriesAccepted: number;
  readonly terminalRefusals: number;
  readonly invariantChecks: number;
  readonly violations: readonly Violation[];
  readonly completionsReached: number;
  readonly completionsAfterARepair: number;
  readonly completionsAfterAFailedAttempt: number;
  readonly gateRefusals: number;
}

function violationOf(property: Property, steps: readonly Step[]): string | null {
  return property.run(runSequence(steps)).violation;
}

/**
 * Greedy delta-debugging: drop one step at a time, keep the drop whenever the
 * SAME property still fails, and stop when nothing more can go. What comes back
 * is minimal with respect to single-step removal — every remaining step is load
 * bearing, which the canary test below verifies directly.
 */
function shrink(property: Property, steps: readonly Step[]): readonly Step[] {
  let current: readonly Step[] = steps;
  let improved = true;
  let guard = 0;
  while (improved && guard < 2_000) {
    improved = false;
    for (let i = 0; i < current.length; i += 1) {
      guard += 1;
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (violationOf(property, candidate) !== null) {
        current = candidate;
        improved = true;
        break;
      }
    }
  }
  return current;
}

function explore(options: {
  readonly seed: number;
  readonly sequences: number;
  readonly maxSteps: number;
  readonly properties: readonly Property[];
  readonly maxViolationsReported?: number;
}): ExploreReport {
  const violations: Violation[] = [];
  const limit = options.maxViolationsReported ?? 3;

  let stepsGenerated = 0;
  let transitionsAccepted = 0;
  let transitionsRejected = 0;
  let retriesAccepted = 0;
  let terminalRefusals = 0;
  let invariantChecks = 0;
  let completionsReached = 0;
  let completionsAfterARepair = 0;
  let completionsAfterAFailedAttempt = 0;
  let gateRefusals = 0;

  for (let i = 0; i < options.sequences; i += 1) {
    const seed = (options.seed + Math.imul(i, 0x9e3779b1)) >>> 0;
    const steps = generateSequence(makeRng(seed), options.maxSteps);
    const trace = runSequence(steps);

    stepsGenerated += steps.length;
    transitionsAccepted += trace.accepted.length;
    transitionsRejected += trace.rejected.length;
    retriesAccepted += trace.retriesAccepted;
    terminalRefusals += trace.rejected.filter((r) => isTerminalRunState(r.from)).length;
    gateRefusals += trace.rejected.filter((r) => canRunTransition(r.from, r.to)).length;

    for (const attempt of trace.attempts) {
      const states = statesOf(attempt);
      if (!states.includes('COMPLETED')) continue;
      completionsReached += 1;
      if (states.includes('REPAIRING')) completionsAfterARepair += 1;
      if (trace.attempts.some((other) => other.attemptNumber < attempt.attemptNumber && other.state === 'FAILED')) {
        completionsAfterAFailedAttempt += 1;
      }
    }

    for (const property of options.properties) {
      const outcome = property.run(trace);
      invariantChecks += outcome.checks;
      if (outcome.violation === null) continue;
      if (violations.length >= limit) continue;
      const shortest = shrink(property, steps);
      violations.push({
        property: property.name,
        message: outcome.violation,
        seed,
        originalLength: steps.length,
        shortest,
        shortestMessage: violationOf(property, shortest) ?? '(no longer reproducible)',
      });
    }
  }

  return {
    sequencesExplored: options.sequences,
    stepsGenerated,
    transitionsAccepted,
    transitionsRejected,
    retriesAccepted,
    terminalRefusals,
    invariantChecks,
    violations,
    completionsReached,
    completionsAfterARepair,
    completionsAfterAFailedAttempt,
    gateRefusals,
  };
}

/* ========================================================================== */
/*  Random walks across every machine, not just the run machine                */
/* ========================================================================== */

interface WalkReport {
  readonly walks: number;
  readonly steps: number;
  readonly accepted: number;
  readonly refusedAtTerminal: number;
  readonly checks: number;
  readonly violations: readonly string[];
}

function walkEveryMachine(seed: number, walksPerMachine: number, maxSteps: number): WalkReport {
  const violations: string[] = [];
  let walks = 0;
  let steps = 0;
  let accepted = 0;
  let refusedAtTerminal = 0;
  let checks = 0;

  for (const id of MACHINE_IDS) {
    const machine = MACHINES[id];

    // Exhaustive: the guard must agree with the table for every ordered pair.
    for (const from of machine.states) {
      for (const to of machine.states) {
        checks += 1;
        const expected =
          !isTerminalIn(machine, from) && (machine.transitions[from] as readonly string[]).includes(to);
        if (canTransitionIn(machine, from, to) !== expected) {
          violations.push(`${id}: canTransitionIn(${from}, ${to}) disagrees with the table`);
        }
      }
    }

    for (let w = 0; w < walksPerMachine; w += 1) {
      walks += 1;
      const rng = makeRng((seed + Math.imul(walks, 0x85ebca6b)) >>> 0);
      let state = rng.next() < 0.7 ? machine.initial : rng.pick(machine.states);
      const length = 4 + rng.int(maxSteps);

      for (let i = 0; i < length; i += 1) {
        steps += 1;
        const to = rng.pick(machine.states);
        const verdict = explainTransitionIn(machine, state, to);
        checks += 2;

        if (isTerminalIn(machine, state)) {
          refusedAtTerminal += 1;
          if (verdict.ok) violations.push(`${id}: ${state} is terminal but ${state} -> ${to} was allowed`);
          if (verdict.rejection !== 'TERMINAL_STATE') {
            violations.push(`${id}: ${state} -> ${to} from a terminal state was rejected as ${String(verdict.rejection)}`);
          }
          continue;
        }

        const inTable = (machine.transitions[state] as readonly string[]).includes(to);
        if (verdict.ok !== inTable) {
          violations.push(`${id}: ${state} -> ${to} verdict ${verdict.ok} but table says ${inTable}`);
        }
        checks += 1;
        if (verdict.allowed.join(',') !== (machine.transitions[state] as readonly string[]).join(',')) {
          violations.push(`${id}: the allowed list for ${state} does not match the table`);
        }
        if (verdict.ok) {
          accepted += 1;
          state = to;
        }
      }
    }
  }

  return { walks, steps, accepted, refusedAtTerminal, checks, violations };
}

/* ========================================================================== */
/*  Run the exploration once, then assert on what it found                     */
/* ========================================================================== */

const RUN_EXPLORATION = explore({ seed: 0x5eed_1234, sequences: 2_500, maxSteps: 26, properties: PROPERTIES });
const CANARY_EXPLORATION = explore({
  seed: 0x5eed_1234,
  sequences: 2_500,
  maxSteps: 26,
  properties: [CANARY],
  maxViolationsReported: 1,
});
const MACHINE_WALKS = walkEveryMachine(0xc0ffee, 320, 18);

function describeSteps(steps: readonly Step[]): string {
  return steps
    .map((step) => (step.kind === 'retry' ? 'retry' : `${step.to}(${step.quality}${step.variant})`))
    .join(' -> ');
}

function reportViolations(label: string, violations: readonly Violation[]): string {
  if (violations.length === 0) return '';
  return violations
    .map(
      (v) =>
        `${label} ${v.property}\n  seed ${v.seed}\n  ${v.message}\n  shortest failing sequence (${v.shortest.length} of ${v.originalLength} steps): ${describeSteps(v.shortest)}`,
    )
    .join('\n');
}

describe('the state machine registry', () => {
  it('is internally consistent before any property is asserted about it', () => {
    expect(() => assertMachineRegistryValid()).not.toThrow();
  });
});

describe('properties over generated run transition sequences', () => {
  it('found no violation in any generated sequence', () => {
    expect(reportViolations('VIOLATED:', RUN_EXPLORATION.violations)).toBe('');
    expect(RUN_EXPLORATION.violations).toHaveLength(0);
  });

  it.each(PROPERTIES.map((property) => [property.name] as const))('holds for every sequence: %s', (name) => {
    const failures = RUN_EXPLORATION.violations.filter((violation) => violation.property === name);
    expect(reportViolations('VIOLATED:', failures)).toBe('');
  });

  it('actually explored thousands of paths and reached the states the properties are about', () => {
    expect(RUN_EXPLORATION.sequencesExplored).toBe(2_500);
    expect(RUN_EXPLORATION.stepsGenerated).toBeGreaterThan(20_000);
    expect(RUN_EXPLORATION.transitionsAccepted).toBeGreaterThan(5_000);
    expect(RUN_EXPLORATION.transitionsRejected).toBeGreaterThan(1_000);
    expect(RUN_EXPLORATION.invariantChecks).toBeGreaterThan(100_000);

    // If these were zero the properties above would be vacuously true, so the
    // suite would be green while testing nothing. They are asserted, not hoped for.
    expect(RUN_EXPLORATION.completionsReached).toBeGreaterThan(0);
    expect(RUN_EXPLORATION.completionsAfterARepair).toBeGreaterThan(0);
    expect(RUN_EXPLORATION.completionsAfterAFailedAttempt).toBeGreaterThan(0);
    expect(RUN_EXPLORATION.terminalRefusals).toBeGreaterThan(0);
    expect(RUN_EXPLORATION.gateRefusals).toBeGreaterThan(0);
    expect(RUN_EXPLORATION.retriesAccepted).toBeGreaterThan(0);

    console.log(
      [
        '',
        'property exploration — real counts',
        `  run sequences explored      ${RUN_EXPLORATION.sequencesExplored}`,
        `  steps generated             ${RUN_EXPLORATION.stepsGenerated}`,
        `  transitions accepted        ${RUN_EXPLORATION.transitionsAccepted}`,
        `  transitions refused         ${RUN_EXPLORATION.transitionsRejected} (${RUN_EXPLORATION.terminalRefusals} at a terminal state, ${RUN_EXPLORATION.gateRefusals} by an evidence gate)`,
        `  retries opened              ${RUN_EXPLORATION.retriesAccepted}`,
        `  completions reached         ${RUN_EXPLORATION.completionsReached} (${RUN_EXPLORATION.completionsAfterARepair} after a repair, ${RUN_EXPLORATION.completionsAfterAFailedAttempt} after a failed attempt)`,
        `  invariants checked          ${RUN_EXPLORATION.invariantChecks} across ${PROPERTIES.length} properties`,
        `  violations found            ${RUN_EXPLORATION.violations.length}`,
        `  machine walks               ${MACHINE_WALKS.walks} over ${MACHINE_IDS.length} machines, ${MACHINE_WALKS.steps} steps, ${MACHINE_WALKS.checks} checks`,
        `  machine walk violations     ${MACHINE_WALKS.violations.length}`,
        '',
      ].join('\n'),
    );
  });
});

describe('the failure finder itself', () => {
  it('finds a deliberately false property instead of reporting a clean run', () => {
    expect(CANARY_EXPLORATION.violations.length).toBeGreaterThan(0);
    expect(CANARY_EXPLORATION.violations[0].property).toContain('CANARY');
    expect(CANARY_EXPLORATION.violations[0].message).toBe('a run reached COMPLETED');
  });

  it('shrinks the witness to the shortest sequence that still fails', () => {
    const witness = CANARY_EXPLORATION.violations[0];
    expect(witness.shortest.length).toBeLessThan(witness.originalLength);
    expect(witness.shortestMessage).toBe('a run reached COMPLETED');

    // Minimal with respect to single-step removal: every remaining step matters.
    for (let i = 0; i < witness.shortest.length; i += 1) {
      const without = [...witness.shortest.slice(0, i), ...witness.shortest.slice(i + 1)];
      expect(violationOf(CANARY, without)).toBeNull();
    }

    // And the witness is exactly the honest path to COMPLETED, nothing more.
    const trace = runSequence(witness.shortest);
    expect(trace.attempts).toHaveLength(1);
    expect(statesOf(trace.attempts[0])).toEqual([
      'CREATED',
      'QUEUED',
      'STARTING',
      'RUNNING',
      'VERIFYING',
      'REVIEWING',
      'COMPLETED',
    ]);
  });

  it('is reproducible: the same seed produces the same sequences and the same result', () => {
    const first = explore({ seed: 0x1234_5678, sequences: 200, maxSteps: 20, properties: PROPERTIES });
    const second = explore({ seed: 0x1234_5678, sequences: 200, maxSteps: 20, properties: PROPERTIES });
    expect(second).toEqual(first);

    const different = explore({ seed: 0x8765_4321, sequences: 200, maxSteps: 20, properties: PROPERTIES });
    expect(different.stepsGenerated).not.toBe(first.stepsGenerated);
  });
});

describe('random walks across all ten machines', () => {
  it('never leaves a terminal state and never disagrees with its own table', () => {
    expect(MACHINE_WALKS.violations).toEqual([]);
    expect(MACHINE_WALKS.walks).toBe(320 * MACHINE_IDS.length);
    expect(MACHINE_WALKS.steps).toBeGreaterThan(10_000);
    expect(MACHINE_WALKS.accepted).toBeGreaterThan(500);
    expect(MACHINE_WALKS.refusedAtTerminal).toBeGreaterThan(0);
    expect(MACHINE_WALKS.checks).toBeGreaterThan(20_000);
  });
});

/* ========================================================================== */
/*  Directly stated, not just generated                                        */
/* ========================================================================== */

describe('the five claims, stated directly', () => {
  it('COMPLETED has exactly one predecessor, and it is REVIEWING', () => {
    expect(predecessorsOf(RUN_MACHINE, 'COMPLETED')).toEqual(['REVIEWING']);
    expect(predecessorsOf(RUN_MACHINE, 'REVIEWING')).toEqual(['VERIFYING']);
  });

  it('the six named illegal transitions are all refused', () => {
    const illegal: readonly (readonly [RunState, RunState])[] = [
      ['CREATED', 'COMPLETED'],
      ['FAILED', 'COMPLETED'],
      ['CANCELLED', 'RUNNING'],
      ['VERIFYING', 'COMPLETED'],
      ['COMPLETED', 'RUNNING'],
      ['DISCONNECTED', 'COMPLETED'],
    ];
    for (const [from, to] of illegal) {
      const verdict = explainRunTransition(from, to);
      expect(verdict.ok).toBe(false);
      expect(verdict.message.length).toBeGreaterThan(40);
    }
  });

  it('a legal transition into a gated state is still refused without its evidence', () => {
    const created = createRunAttempt({ runId: RUN_ID, attemptId: 'a1', at: at(0) });
    const queued = advanceRunAttempt(created, 'QUEUED', { at: at(1) });
    const starting = advanceRunAttempt(queued, 'STARTING', { at: at(2) });

    expect(canRunTransition('STARTING', 'RUNNING')).toBe(true);
    expect(() => advanceRunAttempt(starting, 'RUNNING', { at: at(3) })).toThrow(/gated and no running evidence/);
    expect(() =>
      advanceRunAttempt(starting, 'RUNNING', { at: at(3), evidence: brokenEvidence('RUNNING', 0) }),
    ).toThrow(/refusing to claim RUNNING/);

    const running = advanceRunAttempt(starting, 'RUNNING', { at: at(3), evidence: completeEvidence('RUNNING') });
    expect(running.state).toBe('RUNNING');
    expect(starting.state).toBe('STARTING'); // the caller's object is untouched
  });

  it('a recovered attempt may complete without a RUNNING of its own, and the gate still applies', () => {
    // Found by the generator, not by reading the table. RECOVERING -> VERIFYING
    // is deliberate (reconciliation may hand a recovered run to verification),
    // so this path exists. What it does NOT bypass is the evidence gate.
    const path: readonly RunState[] = ['QUEUED', 'STARTING', 'INTERRUPTED', 'RECOVERING', 'VERIFYING', 'REVIEWING'];
    let attempt = createRunAttempt({ runId: RUN_ID, attemptId: 'a1', at: at(0) });
    path.forEach((to, index) => {
      attempt = advanceRunAttempt(attempt, to, {
        at: at(index + 1),
        evidence: isGated(to) ? completeEvidence(to) : undefined,
      });
    });

    expect(statesOf(attempt)).not.toContain('RUNNING');
    expect(attempt.state).toBe('REVIEWING');

    // Completion out of that path is still refused without an accepting verdict
    // and an observed process exit.
    expect(() =>
      advanceRunAttempt(attempt, 'COMPLETED', { at: at(9), evidence: brokenEvidence('COMPLETED', 0) }),
    ).toThrow(/observed process exit/);
    expect(() => advanceRunAttempt(attempt, 'COMPLETED', { at: at(9) })).toThrow(/gated and no completed evidence/);

    const completed = advanceRunAttempt(attempt, 'COMPLETED', { at: at(9), evidence: completeEvidence('COMPLETED') });
    expect(completed.state).toBe('COMPLETED');
    expect(completed.terminal).toBe(true);
  });

  it('a repair that is interrupted and recovered completes on a FRESH verdict, not the pre-repair one', () => {
    // Also found by the generator. REPAIRING -> INTERRUPTED -> RECOVERING ->
    // VERIFYING skips RETRYING/RUNNING, so the repair is signed off by
    // re-verification rather than by re-execution. What cannot be skipped is the
    // second VERIFYING -> REVIEWING pair: the verdict is produced after the repair.
    const path: readonly RunState[] = [
      'QUEUED',
      'STARTING',
      'RUNNING',
      'VERIFYING',
      'REVIEWING',
      'REPAIRING',
      'INTERRUPTED',
      'RECOVERING',
      'VERIFYING',
      'REVIEWING',
      'COMPLETED',
    ];
    let attempt = createRunAttempt({ runId: RUN_ID, attemptId: 'a1', at: at(0) });
    path.forEach((to, index) => {
      attempt = advanceRunAttempt(attempt, to, {
        at: at(index + 1),
        evidence: isGated(to) ? completeEvidence(to) : undefined,
      });
    });

    const states = statesOf(attempt);
    expect(attempt.state).toBe('COMPLETED');
    expect(states.lastIndexOf('VERIFYING')).toBeGreaterThan(states.indexOf('REPAIRING'));
    expect(states[states.length - 2]).toBe('REVIEWING');
    expect(states[states.length - 3]).toBe('VERIFYING');
  });

  it('a retry never resurrects the attempt it came from', () => {
    let attempt = createRunAttempt({ runId: RUN_ID, attemptId: 'a1', at: at(0) });
    attempt = advanceRunAttempt(attempt, 'CANCELLED', { at: at(1) });
    expect(attempt.terminal).toBe(true);

    const retry = createRetryAttempt(attempt, { attemptId: 'a2', at: at(2) });
    expect(retry.state).toBe('CREATED');
    expect(retry.attemptNumber).toBe(2);
    expect(retry.parentAttemptId).toBe('a1');
    // Attempt 1 is still cancelled, and still cannot move.
    expect(attempt.state).toBe('CANCELLED');
    expect(() => advanceRunAttempt(attempt, 'RUNNING', { at: at(3), evidence: completeEvidence('RUNNING') })).toThrow(
      /terminal/,
    );
    expect(checkAttemptSequence([attempt, retry]).ok).toBe(true);
  });
});
