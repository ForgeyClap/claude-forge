/**
 * Forge Workspace — input fuzzing over the real, load-bearing functions
 * (mission section M).
 *
 * Everything here drives the ACTUAL exported code — the path guard, the state
 * machines, the event store, the markdown renderer — with thousands of seeded,
 * generated inputs from `./generators.ts`. Nothing is re-implemented or mocked;
 * a fuzzer that paraphrased the rule would only be testing its own paraphrase.
 *
 * REPRODUCIBILITY. Every input is a pure function of one integer seed. When a
 * property breaks, the driver shrinks the input to the shortest still-failing
 * one and reports BOTH the seed and that minimal witness. A counterexample is a
 * SUCCESS of the fuzzer, not a failure of this task, so it is surfaced loudly
 * rather than swallowed.
 *
 * The four targets and the claims made about each:
 *
 *   paths.ts        an accepted path is always inside the trusted root; an
 *                   accepted slug carries no separator, no '..', no colon and no
 *                   reserved device name; neither function ever throws anything
 *                   but PathGuardError.
 *   state-machines  a terminal state never transitions; COMPLETED is unreachable
 *                   without the completion evidence gate; a cancelled attempt
 *                   never returns to RUNNING; only the three typed errors escape.
 *   store.ts        a duplicate eventId never double-applies; the stored sequence
 *                   is monotonic 1..N; a detected gap is reported and never
 *                   silently filled.
 *   markdown.tsx    the renderer never throws and never emits a raw <script> or a
 *                   dangerous href; and, verified from its source, it never uses
 *                   dangerouslySetInnerHTML.
 */

import { describe, expect, it } from 'vitest';
import console from 'node:console';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  MAX_SLUG_LENGTH,
  assertInsideRoot,
  inspectSlug,
  isInsideRoot,
  isPathGuardError,
  sanitizeSlug,
} from '@/bridge/security/paths';
import {
  MACHINES,
  MACHINE_IDS,
  advanceRunAttempt,
  canTransitionIn,
  checkCompletedEvidence,
  createRetryAttempt,
  createRunAttempt,
  explainTransitionIn,
  isTerminalIn,
  isTerminalRunState,
} from '@/shared/state-machines';
import type { MachineId, RunAttempt, RunState, RunStateEvidence } from '@/shared/state-machines';
import { ForgeStore } from '@/bridge/storage/store';
import { EVENT_SCHEMA_VERSION } from '@/bridge/storage/schema';
import type { ForgeEvent } from '@/shared/protocol';
import { renderMarkdown } from '@/views/chat/markdown';

import {
  POSIX_ROOT,
  WIN_ROOT,
  deriveSeed,
  genDisplayName,
  genEventOps,
  genHugeMarkdown,
  genMachineWalk,
  genMarkdown,
  genPath,
  genRawSequencePlan,
  genRunSteps,
  makeRng,
  shrinkList,
  shrinkString,
} from './generators';
import type {
  EvidenceQuality,
  EventOp,
  MachineWalk,
  RawSequencePlan,
  Rng,
  RunStep,
} from './generators';

/* ========================================================================== */
/*  The generic fuzz driver                                                     */
/* ========================================================================== */

interface Counterexample {
  readonly seed: number;
  readonly message: string;
  readonly input: string;
}

interface FuzzResult {
  readonly runs: number;
  readonly counterexample: Counterexample | null;
}

/**
 * Runs `check` over `runs` generated values. `check` returns null when the
 * property holds and a human sentence when it does not. On the first violation
 * the offending value is shrunk (if a shrinker is supplied) and returned with
 * its seed — the loop stops there, because one reproducible counterexample is
 * the whole prize.
 */
function fuzz<T>(cfg: {
  readonly baseSeed: number;
  readonly runs: number;
  readonly gen: (rng: Rng) => T;
  readonly check: (value: T) => string | null;
  readonly render: (value: T) => string;
  readonly shrink?: (value: T, stillFails: (v: T) => boolean) => T;
}): FuzzResult {
  for (let i = 0; i < cfg.runs; i += 1) {
    const seed = deriveSeed(cfg.baseSeed, i);
    const value = cfg.gen(makeRng(seed));
    const message = cfg.check(value);
    if (message === null) continue;
    const stillFails = (v: T): boolean => cfg.check(v) !== null;
    const shrunk = cfg.shrink ? cfg.shrink(value, stillFails) : value;
    return {
      runs: i + 1,
      counterexample: { seed, message: cfg.check(shrunk) ?? message, input: cfg.render(shrunk) },
    };
  }
  return { runs: cfg.runs, counterexample: null };
}

function report(label: string, result: FuzzResult): string {
  const c = result.counterexample;
  if (!c) return '';
  return (
    `COUNTEREXAMPLE in ${label}\n` +
    `  seed ${c.seed} (0x${c.seed.toString(16)})\n` +
    `  ${c.message}\n` +
    `  shortest failing input: ${c.input}`
  );
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/* ========================================================================== */
/*  1. paths.ts — sanitizeSlug                                                  */
/* ========================================================================== */

const SLUG_SAFE = /^[\p{L}\p{N}\p{M}_-]+$/u;

const RESERVED_DEVICE = new Set<string>([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
  'conin$', 'conout$', 'clock$',
]);

function isReservedName(name: string): boolean {
  const trimmed = name.replace(/[. \t]+$/u, '').toLowerCase();
  if (trimmed.length === 0) return false;
  if (RESERVED_DEVICE.has(trimmed)) return true;
  return RESERVED_DEVICE.has(trimmed.split('.')[0] ?? '');
}

function checkSlug(name: string): string | null {
  // inspectSlug is the non-throwing form: it must never throw for any input.
  let inspection: ReturnType<typeof inspectSlug>;
  try {
    inspection = inspectSlug(name);
  } catch (err) {
    return `inspectSlug threw ${errName(err)} — it must never throw`;
  }

  let slug: string;
  try {
    slug = sanitizeSlug(name);
  } catch (err) {
    if (!isPathGuardError(err)) return `sanitizeSlug threw ${errName(err)}, not PathGuardError`;
    if (inspection.ok) return `sanitizeSlug rejected an input inspectSlug accepted`;
    return null; // consistently rejected — nothing more to prove
  }

  if (!inspection.ok) return `sanitizeSlug returned "${slug}" for an input inspectSlug rejected`;

  // Accepted: the slug must be exactly one safe path segment.
  if (slug.length === 0) return 'accepted slug is empty';
  if (slug.length > MAX_SLUG_LENGTH) return `accepted slug exceeds MAX_SLUG_LENGTH (${slug.length})`;
  if (/[\\/]/.test(slug)) return `accepted slug contains a path separator: ${JSON.stringify(slug)}`;
  if (slug.includes('..')) return `accepted slug contains a dot-dot: ${JSON.stringify(slug)}`;
  if (slug.includes(':')) return `accepted slug contains a colon: ${JSON.stringify(slug)}`;
  if (!SLUG_SAFE.test(slug)) return `accepted slug has an out-of-class character: ${JSON.stringify(slug)}`;
  if (/^[-_]|[-_]$/.test(slug)) return `accepted slug has a leading/trailing separator char: ${JSON.stringify(slug)}`;
  if (isReservedName(slug)) return `accepted slug is a reserved device name: ${JSON.stringify(slug)}`;

  // Idempotent: re-slugging an accepted slug returns it unchanged.
  let again: string;
  try {
    again = sanitizeSlug(slug);
  } catch (err) {
    return `re-sanitising an accepted slug threw ${errName(err)}`;
  }
  if (again !== slug) return `sanitizeSlug is not idempotent: ${JSON.stringify(slug)} -> ${JSON.stringify(again)}`;

  return null;
}

/* ========================================================================== */
/*  2. paths.ts — assertInsideRoot                                             */
/* ========================================================================== */

function segments(path: string, win32: boolean): string[] {
  const raw = path.split(/[\\/]+/).filter((s) => s.length > 0);
  return win32 ? raw.map((s) => s.toLowerCase()) : raw;
}

function startsWithRoot(candidateReal: string, root: string, win32: boolean): boolean {
  const rootSegs = segments(root, win32);
  const candSegs = segments(candidateReal, win32);
  if (candSegs.length < rootSegs.length) return false;
  for (let i = 0; i < rootSegs.length; i += 1) {
    if (candSegs[i] !== rootSegs[i]) return false;
  }
  return true;
}

function checkContainment(candidate: string, root: string, platform: 'win32' | 'posix'): string | null {
  const opts = { platform } as const;
  const win32 = platform === 'win32';

  // The non-throwing form must never throw.
  let inside: boolean;
  try {
    inside = isInsideRoot(candidate, root, opts);
  } catch (err) {
    return `isInsideRoot threw ${errName(err)} — it must never throw`;
  }

  let returned: string;
  try {
    returned = assertInsideRoot(candidate, root, opts);
  } catch (err) {
    if (!isPathGuardError(err)) {
      return `assertInsideRoot threw ${errName(err)} (only PathGuardError is allowed): ${String((err as Error)?.message).slice(0, 80)}`;
    }
    if (inside) return `isInsideRoot said inside but assertInsideRoot rejected the same input`;
    return null; // consistently rejected
  }

  if (!inside) return `assertInsideRoot accepted a path isInsideRoot reports as outside`;

  // The accepted path must actually be inside the root — checked two ways: the
  // returned canonical path re-checks as inside, and its segments start with the
  // root's. Using the RETURNED path, never the input, is the guard's own rule.
  let stable: boolean;
  try {
    stable = isInsideRoot(returned, root, opts);
  } catch (err) {
    return `re-checking the accepted path threw ${errName(err)}`;
  }
  if (!stable) return `accepted path ${JSON.stringify(returned)} does not re-check as inside the root`;
  if (!startsWithRoot(returned, root, win32)) {
    return `accepted path ${JSON.stringify(returned)} does not start with the root's segments`;
  }
  return null;
}

/* ========================================================================== */
/*  3. state-machines — the run attempt model                                  */
/* ========================================================================== */

const RUN_ID = 'run-fuzz';
const BASE_MS = Date.UTC(2026, 6, 24, 9, 0, 0);
const at = (tick: number): string => new Date(BASE_MS + tick * 1_000).toISOString();

const PROOF = [
  { kind: 'exit-code' as const, ref: '0', note: 'observed on wait()' },
  { kind: 'stdout' as const, ref: 'events/run-fuzz.stdout.log' },
];
const INSPECTED = [{ kind: 'file' as const, ref: 'src/example.ts', hash: 'abc123' }];

function completeEvidence(state: RunState): RunStateEvidence | undefined {
  switch (state) {
    case 'RUNNING':
      return {
        state: 'RUNNING',
        evidence: {
          runId: RUN_ID,
          projectId: 'proj-fuzz',
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
          outputRef: 'events/run-fuzz.jsonl',
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
          evidenceRefs: [{ kind: 'stderr', ref: 'events/run-fuzz.stderr.log' }],
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
    default:
      return undefined;
  }
}

/** One broken variant per gated state — enough to prove refusals throw typed errors. */
function brokenEvidence(state: RunState): RunStateEvidence | undefined {
  const good = completeEvidence(state);
  if (!good) return undefined;
  switch (good.state) {
    case 'RUNNING':
      return { state: 'RUNNING', evidence: { ...good.evidence, pidAlive: false } };
    case 'COMPLETED':
      return { state: 'COMPLETED', evidence: { ...good.evidence, verdict: 'UNVERIFIED' } };
    case 'FAILED':
      return { state: 'FAILED', evidence: { ...good.evidence, evidenceRefs: [] } };
    case 'VERIFYING':
      return { state: 'VERIFYING', evidence: { ...good.evidence, verifierAgentId: 'builder-1' } };
    case 'REVIEWING':
      return { state: 'REVIEWING', evidence: { ...good.evidence, verificationVerdict: 'UNVERIFIED' } };
  }
}

function evidenceFor(to: RunState, quality: EvidenceQuality): RunStateEvidence | undefined {
  if (quality === 'absent') return undefined;
  return quality === 'complete' ? completeEvidence(to) : brokenEvidence(to);
}

const TYPED_SM_ERRORS = new Set(['StateTransitionError', 'EvidenceError', 'AttemptError']);

function checkRunSteps(steps: readonly RunStep[]): string | null {
  const attempts: RunAttempt[] = [createRunAttempt({ runId: RUN_ID, attemptId: 'a1', at: at(0) })];
  let created = 1;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const current = attempts[attempts.length - 1];

    if (step.kind === 'retry') {
      try {
        const next = createRetryAttempt(current, { attemptId: `a${(created += 1)}`, at: at(i + 1) });
        if (!current.terminal) return `retry accepted while attempt ${current.attemptNumber} was live (${current.state})`;
        attempts.push(next);
      } catch (err) {
        if (!(err instanceof Error) || !TYPED_SM_ERRORS.has(err.name)) return `retry threw ${errName(err)}`;
        if (current.terminal) return `retry refused after a terminal attempt (${current.state})`;
      }
      continue;
    }

    const evidence = evidenceFor(step.to, step.quality);
    const before = current.state;
    const wasTerminal = current.terminal;
    try {
      const next = advanceRunAttempt(current, step.to, { at: at(i + 1), evidence });
      if (wasTerminal) return `advanced out of terminal ${before} to ${step.to}`;
      if (before === 'CANCELLED') return `escaped CANCELLED to ${step.to}`;
      if (step.to === 'COMPLETED') {
        if (before !== 'REVIEWING') return `COMPLETED entered from ${before}, not REVIEWING`;
        if (!evidence || evidence.state !== 'COMPLETED') return `COMPLETED accepted with no completion evidence`;
        if (!checkCompletedEvidence(evidence.evidence).ok) return `COMPLETED accepted although the completion gate refuses it`;
      }
      if (next.state !== step.to) return `advance to ${step.to} returned an attempt in ${next.state}`;
      if (!Object.isFrozen(next)) return `advanceRunAttempt returned an unfrozen attempt`;
      if (attempts[attempts.length - 1] === next && current.state !== before) return `advance mutated the input attempt`;
      attempts[attempts.length - 1] = next;
    } catch (err) {
      if (!(err instanceof Error) || !TYPED_SM_ERRORS.has(err.name)) return `advance threw ${errName(err)}`;
      if (attempts[attempts.length - 1] !== current) return `a refused advance still changed the attempt`;
    }
  }

  // Structural invariants over the whole attempt list.
  for (const attempt of attempts) {
    if (attempt.terminal !== isTerminalRunState(attempt.state)) {
      return `attempt ${attempt.attemptNumber} claims terminal=${attempt.terminal} in ${attempt.state}`;
    }
    if (!Object.isFrozen(attempt)) return `attempt ${attempt.attemptNumber} is not frozen`;
    const states = attempt.history.map((h) => h.to);
    const cancelledAt = states.indexOf('CANCELLED');
    if (cancelledAt >= 0 && cancelledAt !== states.length - 1) {
      return `attempt ${attempt.attemptNumber} continued to ${states[cancelledAt + 1]} after CANCELLED`;
    }
  }
  return null;
}

/* ========================================================================== */
/*  4. state-machines — generic walks across every machine                     */
/* ========================================================================== */

interface WalkCase {
  readonly machineId: MachineId;
  readonly walk: MachineWalk;
}

function genWalkCase(rng: Rng): WalkCase {
  const machineId = rng.pick(MACHINE_IDS);
  const machine = MACHINES[machineId];
  return { machineId, walk: genMachineWalk(rng, machine.states, machine.initial) };
}

function checkWalk(input: WalkCase): string | null {
  const machine = MACHINES[input.machineId];
  let state = input.walk.start;
  for (const to of input.walk.targets) {
    const verdict = explainTransitionIn(machine, state, to);

    if (isTerminalIn(machine, state)) {
      if (verdict.ok) return `${input.machineId}: terminal ${state} allowed a transition to ${to}`;
      if (verdict.rejection !== 'TERMINAL_STATE') {
        return `${input.machineId}: terminal ${state} -> ${to} was rejected as ${String(verdict.rejection)}, not TERMINAL_STATE`;
      }
      continue;
    }

    const inTable = (machine.transitions[state] as readonly string[]).includes(to);
    if (verdict.ok !== inTable) return `${input.machineId}: ${state} -> ${to} verdict ${verdict.ok} disagrees with table ${inTable}`;
    if (canTransitionIn(machine, state, to) !== verdict.ok) {
      return `${input.machineId}: canTransitionIn disagrees with explainTransitionIn at ${state} -> ${to}`;
    }
    if (verdict.ok) state = to;
  }
  return null;
}

/* ========================================================================== */
/*  5. store.ts — event normalization and sequencing                           */
/* ========================================================================== */

function withWorkspace<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'forge-fuzz-'));
  if (!resolve(dir).startsWith(resolve(tmpdir()))) {
    throw new Error(`refusing to run: scratch workspace ${dir} is not under the OS temp directory`);
  }
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function streamPath(dir: string, streamKey: string): string {
  return join(dir, 'events', `${streamKey}.jsonl`);
}

function sequencesOnDisk(dir: string, streamKey: string): number[] {
  return readFileSync(streamPath(dir, streamKey), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as ForgeEvent).sequence);
}

/** A raw JSONL line written behind the store's back, valid enough to replay. */
function rawLine(sequence: number, eventId: string): string {
  return JSON.stringify({
    eventId,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sequence,
    timestamp: new Date(BASE_MS + sequence * 1_000).toISOString(),
    projectId: 'projx',
    runId: 'runx',
    sessionId: null,
    conversationId: null,
    taskId: null,
    agentId: null,
    source: 'bridge',
    type: 'run.state',
    payload: {},
    evidenceRefs: [],
  });
}

interface Gap {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

function expectedGaps(present: readonly number[], max: number): Gap[] {
  const set = new Set(present);
  const gaps: Gap[] = [];
  let runStart: number | null = null;
  for (let seq = 1; seq <= max; seq += 1) {
    const has = set.has(seq);
    if (!has && runStart === null) runStart = seq;
    if (has && runStart !== null) {
      gaps.push({ from: runStart, to: seq - 1, count: seq - runStart });
      runStart = null;
    }
  }
  if (runStart !== null) gaps.push({ from: runStart, to: max, count: max - runStart + 1 });
  return gaps;
}

function sameGaps(a: readonly Gap[], b: readonly Gap[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkEventOps(ops: readonly EventOp[]): string | null {
  return withWorkspace((dir) => {
    const store = ForgeStore.open({ dataDir: dir, bridgeInstanceId: 'fuzz-ops' });
    try {
      const firstSequence = new Map<string, number>();
      const firstTag = new Map<string, number>();
      let sequence = 0;

      for (const op of ops) {
        const res = store.appendEvent({
          eventId: op.eventId,
          projectId: 'projf',
          runId: 'runf',
          source: op.source,
          type: op.type,
          payload: { tag: op.tag },
        });

        if (firstSequence.has(op.eventId)) {
          if (!res.deduplicated) return `duplicate ${op.eventId} was not deduplicated`;
          if (res.event.sequence !== firstSequence.get(op.eventId)) {
            return `duplicate ${op.eventId} came back with sequence ${res.event.sequence}, not ${firstSequence.get(op.eventId)}`;
          }
          const tag = (res.event.payload as { tag: number }).tag;
          if (tag !== firstTag.get(op.eventId)) return `duplicate ${op.eventId} returned the retry payload, not the first-stored one`;
        } else {
          if (res.deduplicated) return `first sight of ${op.eventId} was marked deduplicated`;
          sequence += 1;
          if (res.event.sequence !== sequence) return `first ${op.eventId} got sequence ${res.event.sequence}, expected ${sequence}`;
          firstSequence.set(op.eventId, sequence);
          firstTag.set(op.eventId, op.tag);
        }
      }

      const onDisk = sequencesOnDisk(dir, 'projf~runf');
      const expected = Array.from({ length: firstSequence.size }, (_, k) => k + 1);
      if (JSON.stringify(onDisk) !== JSON.stringify(expected)) {
        return `on-disk sequences ${JSON.stringify(onDisk)} are not the monotonic ${JSON.stringify(expected)}`;
      }
      if (store.detectGaps('projf~runf').length !== 0) return `a clean append run reported a gap`;
      return null;
    } finally {
      store.close();
    }
  });
}

function checkRawPlan(plan: RawSequencePlan): string | null {
  return withWorkspace((dir) => {
    const seed = ForgeStore.open({ dataDir: dir, bridgeInstanceId: 'fuzz-seed' });
    seed.close();

    const lines = plan.writeOrder.map((seq) => rawLine(seq, `gap-${seq}`));
    writeFileSync(streamPath(dir, 'projx~runx'), `${lines.join('\n')}\n`);

    const store = ForgeStore.open({ dataDir: dir, bridgeInstanceId: 'fuzz-gap' });
    try {
      const expected = expectedGaps(plan.present, plan.max);
      const gaps = store.detectGaps('projx~runx');
      if (!sameGaps(gaps, expected)) {
        return `detectGaps ${JSON.stringify(gaps)} != expected ${JSON.stringify(expected)} for present ${JSON.stringify(plan.present)}`;
      }

      // Every missing sequence must stay missing — never quietly filled.
      const disk = new Set(sequencesOnDisk(dir, 'projx~runx'));
      for (const g of expected) {
        for (let s = g.from; s <= g.to; s += 1) {
          if (disk.has(s)) return `missing sequence ${s} appeared on disk — a hole was filled`;
        }
      }

      // A detected gap must be REPORTED as a degraded event, not just returned.
      store.reconcileOnStartup();
      const reasons = store.degradedNotes().map((n) => n.reason);
      if (expected.length > 0 && !reasons.includes('events.sequence-gap')) {
        return `a gap was present but no events.sequence-gap degraded note was recorded`;
      }

      // And reconciliation must not have smoothed the gap away.
      const after = store.detectGaps('projx~runx');
      if (!sameGaps(after, expected)) return `the gap changed after reconciliation (silently filled?)`;
      return null;
    } finally {
      store.close();
    }
  });
}

/* ========================================================================== */
/*  6. markdown.tsx — adversarial rendering                                    */
/* ========================================================================== */

const ALLOWED_HREF = /^(https?:\/\/|mailto:|#|\/)/i;

function checkMarkdown(source: string): string | null {
  let html: string;
  try {
    html = renderToStaticMarkup(renderMarkdown(source) as ReactElement);
  } catch (err) {
    return `renderMarkdown threw ${errName(err)}: ${String((err as Error)?.message).slice(0, 100)}`;
  }

  // No script or other active-content tag may reach the output. Because React
  // escapes every character of the source, a literal "<script>" in the input
  // becomes "&lt;script&gt;" — so a real "<script" can only originate from the
  // renderer itself, which is exactly what this forbids.
  if (/<\s*(script|iframe|object|embed|link|meta|style|form|input|base)\b/i.test(html)) {
    return `output contains an active-content tag: ${(/<\s*[a-z]+/i.exec(html) ?? [''])[0]}`;
  }
  if (/<\/\s*script/i.test(html)) return `output contains a raw </script>`;

  // Every emitted href must use a scheme the renderer's safeHref allows.
  for (const m of html.matchAll(/href="([^"]*)"/gi)) {
    const href = m[1] ?? '';
    if (!ALLOWED_HREF.test(href)) return `output emitted a disallowed href: ${JSON.stringify(href)}`;
  }
  return null;
}

/* ========================================================================== */
/*  Run every fuzz campaign once, up front, then assert on the results          */
/* ========================================================================== */

const BASE_SEED = 0x5eed_fa22;

const SLUG_RESULT = fuzz({
  baseSeed: BASE_SEED ^ 0x01,
  runs: 6_000,
  gen: genDisplayName,
  check: checkSlug,
  render: (s) => JSON.stringify(s),
  shrink: shrinkString,
});

const CONTAINMENT_RESULT = fuzz({
  baseSeed: BASE_SEED ^ 0x02,
  runs: 6_000,
  gen: (rng): { candidate: string; platform: 'win32' | 'posix' } => ({
    candidate: genPath(rng),
    platform: rng.bool(0.6) ? 'posix' : 'win32',
  }),
  check: ({ candidate, platform }) => checkContainment(candidate, platform === 'win32' ? WIN_ROOT : POSIX_ROOT, platform),
  render: ({ candidate, platform }) => `${platform}: ${JSON.stringify(candidate)}`,
  shrink: (value, stillFails) => ({
    candidate: shrinkString(value.candidate, (c) => stillFails({ candidate: c, platform: value.platform })),
    platform: value.platform,
  }),
});

const RUN_STEPS_RESULT = fuzz({
  baseSeed: BASE_SEED ^ 0x03,
  runs: 4_000,
  gen: (rng) => genRunSteps(rng),
  check: checkRunSteps,
  render: (steps) => describeSteps(steps),
  shrink: (steps, stillFails) => shrinkList(steps, stillFails),
});

const WALK_RESULT = fuzz({
  baseSeed: BASE_SEED ^ 0x04,
  runs: 5_000,
  gen: genWalkCase,
  check: checkWalk,
  render: (w) => `${w.machineId} from ${w.walk.start}: ${w.walk.targets.join(' -> ')}`,
});

const EVENT_OPS_RESULT = fuzz({
  baseSeed: BASE_SEED ^ 0x05,
  runs: 300,
  gen: genEventOps,
  check: checkEventOps,
  render: (ops) => `${ops.length} ops over ${new Set(ops.map((o) => o.eventId)).size} ids`,
  shrink: (ops, stillFails) => shrinkList(ops, stillFails),
});

const RAW_PLAN_RESULT = fuzz({
  baseSeed: BASE_SEED ^ 0x06,
  runs: 300,
  gen: genRawSequencePlan,
  check: checkRawPlan,
  render: (p) => `max ${p.max}, present ${JSON.stringify(p.present)}, order ${JSON.stringify(p.writeOrder)}`,
});

const MARKDOWN_RESULT = fuzz({
  baseSeed: BASE_SEED ^ 0x07,
  runs: 3_000,
  gen: genMarkdown,
  check: checkMarkdown,
  render: (s) => JSON.stringify(s.length > 400 ? `${s.slice(0, 400)}…` : s),
  shrink: shrinkString,
});

const HUGE_MARKDOWN_RESULT = fuzz({
  baseSeed: BASE_SEED ^ 0x08,
  runs: 60,
  gen: genHugeMarkdown,
  check: checkMarkdown,
  render: (s) => `huge document, ${s.length} chars`,
});

function describeSteps(steps: readonly RunStep[]): string {
  return steps.map((s) => (s.kind === 'retry' ? 'retry' : `${s.to}(${s.quality})`)).join(' -> ');
}

const TOTAL_INPUTS =
  SLUG_RESULT.runs +
  CONTAINMENT_RESULT.runs +
  RUN_STEPS_RESULT.runs +
  WALK_RESULT.runs +
  EVENT_OPS_RESULT.runs +
  RAW_PLAN_RESULT.runs +
  MARKDOWN_RESULT.runs +
  HUGE_MARKDOWN_RESULT.runs;

/* ========================================================================== */
/*  The assertions                                                             */
/* ========================================================================== */

describe('fuzzing sanitizeSlug (src/bridge/security/paths.ts)', () => {
  it('never throws anything but PathGuardError, and an accepted slug is one safe segment', () => {
    expect(report('sanitizeSlug', SLUG_RESULT)).toBe('');
    expect(SLUG_RESULT.counterexample).toBeNull();
  });

  it('actually reaches acceptance and rejection (the invariants are not vacuous)', () => {
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const name = genDisplayName(makeRng(deriveSeed(BASE_SEED ^ 0x01, i)));
      if (inspectSlug(name).ok) accepted += 1;
      else rejected += 1;
    }
    expect(accepted).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });
});

describe('fuzzing assertInsideRoot (src/bridge/security/paths.ts)', () => {
  it('an accepted path is always inside the trusted root, and only PathGuardError escapes', () => {
    expect(report('assertInsideRoot', CONTAINMENT_RESULT)).toBe('');
    expect(CONTAINMENT_RESULT.counterexample).toBeNull();
  });

  it('reaches both acceptance and rejection under both platform semantics', () => {
    const seen = { winIn: 0, winOut: 0, posixIn: 0, posixOut: 0 };
    for (let i = 0; i < 2_000; i += 1) {
      const rng = makeRng(deriveSeed(BASE_SEED ^ 0x02, i));
      const candidate = genPath(rng);
      const platform = rng.bool(0.6) ? 'posix' : 'win32';
      const root = platform === 'win32' ? WIN_ROOT : POSIX_ROOT;
      const inside = isInsideRoot(candidate, root, { platform });
      if (platform === 'win32') {
        if (inside) seen.winIn += 1;
        else seen.winOut += 1;
      } else if (inside) {
        seen.posixIn += 1;
      } else {
        seen.posixOut += 1;
      }
    }
    expect(seen.winIn).toBeGreaterThan(0);
    expect(seen.winOut).toBeGreaterThan(0);
    expect(seen.posixIn).toBeGreaterThan(0);
    expect(seen.posixOut).toBeGreaterThan(0);
  });
});

describe('fuzzing the run state machine (src/shared/state-machines.ts)', () => {
  it('a terminal never moves, COMPLETED needs its gate, CANCELLED never resumes, only typed errors escape', () => {
    expect(report('run attempt model', RUN_STEPS_RESULT)).toBe('');
    expect(RUN_STEPS_RESULT.counterexample).toBeNull();
  });

  it('the generated sequences actually reached COMPLETED (so the gate property is not vacuous)', () => {
    let completions = 0;
    let terminalPushes = 0;
    for (let i = 0; i < 4_000; i += 1) {
      const steps = genRunSteps(makeRng(deriveSeed(BASE_SEED ^ 0x03, i)));
      // Re-run the honest simulation the generator used, counting outcomes.
      let attempt: RunAttempt = createRunAttempt({ runId: RUN_ID, attemptId: 'a1', at: at(0) });
      for (let j = 0; j < steps.length; j += 1) {
        const step = steps[j];
        if (step.kind === 'retry') {
          if (attempt.terminal) attempt = createRetryAttempt(attempt, { attemptId: `r${j}`, at: at(j + 1) });
          continue;
        }
        if (attempt.terminal) {
          terminalPushes += 1;
          continue;
        }
        try {
          attempt = advanceRunAttempt(attempt, step.to, { at: at(j + 1), evidence: evidenceFor(step.to, step.quality) });
          if (step.to === 'COMPLETED') completions += 1;
        } catch {
          /* refusals are expected and counted elsewhere */
        }
      }
    }
    expect(completions).toBeGreaterThan(0);
    expect(terminalPushes).toBeGreaterThan(0);
  });
});

describe('fuzzing every state machine (src/shared/state-machines.ts)', () => {
  it('never leaves a terminal state and never disagrees with its own transition table', () => {
    expect(report('machine walks', WALK_RESULT)).toBe('');
    expect(WALK_RESULT.counterexample).toBeNull();
  });
});

describe('fuzzing event normalization and sequencing (src/bridge/storage/store.ts)', () => {
  it('a duplicate eventId never double-applies and the stored sequence stays monotonic', () => {
    expect(report('event ops', EVENT_OPS_RESULT)).toBe('');
    expect(EVENT_OPS_RESULT.counterexample).toBeNull();
  });

  it('a missing sequence is reported as a gap and never silently filled', () => {
    expect(report('raw sequence plan', RAW_PLAN_RESULT)).toBe('');
    expect(RAW_PLAN_RESULT.counterexample).toBeNull();
  });
});

describe('fuzzing the markdown renderer (src/views/chat/markdown.tsx)', () => {
  it('never throws and never emits a raw <script> or a dangerous href', () => {
    expect(report('markdown', MARKDOWN_RESULT)).toBe('');
    expect(MARKDOWN_RESULT.counterexample).toBeNull();
  });

  it('stays total on huge documents', () => {
    expect(report('huge markdown', HUGE_MARKDOWN_RESULT)).toBe('');
    expect(HUGE_MARKDOWN_RESULT.counterexample).toBeNull();
  });

  it('does not use dangerouslySetInnerHTML (verified from source)', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/views/chat/markdown.tsx', import.meta.url)), 'utf8');
    // The doc comment MENTIONS the prop by name (to promise it uses none), so a
    // bare substring match is wrong. What must be absent is the ATTRIBUTE being
    // set — `dangerouslySetInnerHTML={...}` — which is the only way it does harm.
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
    // Nor may it reach for innerHTML by any other route.
    expect(source).not.toMatch(/\.innerHTML\s*=/);
  });
});

describe('the fuzz campaign as a whole', () => {
  it('generated and checked thousands of inputs across every target', () => {
    expect(TOTAL_INPUTS).toBeGreaterThan(20_000);

    const cexes = [
      report('sanitizeSlug', SLUG_RESULT),
      report('assertInsideRoot', CONTAINMENT_RESULT),
      report('run attempt model', RUN_STEPS_RESULT),
      report('machine walks', WALK_RESULT),
      report('event ops', EVENT_OPS_RESULT),
      report('raw sequence plan', RAW_PLAN_RESULT),
      report('markdown', MARKDOWN_RESULT),
      report('huge markdown', HUGE_MARKDOWN_RESULT),
    ].filter((line) => line.length > 0);

    console.log(
      [
        '',
        'fuzz campaign — real counts',
        `  base seed                   0x${(BASE_SEED >>> 0).toString(16)}`,
        `  sanitizeSlug inputs         ${SLUG_RESULT.runs}`,
        `  assertInsideRoot inputs     ${CONTAINMENT_RESULT.runs}`,
        `  run attempt sequences       ${RUN_STEPS_RESULT.runs}`,
        `  machine walk cases          ${WALK_RESULT.runs} across ${MACHINE_IDS.length} machines`,
        `  store event batches         ${EVENT_OPS_RESULT.runs}`,
        `  store gap plans             ${RAW_PLAN_RESULT.runs}`,
        `  markdown documents          ${MARKDOWN_RESULT.runs} (+ ${HUGE_MARKDOWN_RESULT.runs} huge)`,
        `  total inputs generated      ${TOTAL_INPUTS}`,
        `  counterexamples found       ${cexes.length}`,
        ...cexes.map((line) => `\n${line}`),
        '',
      ].join('\n'),
    );

    expect(cexes).toEqual([]);
  });
});
