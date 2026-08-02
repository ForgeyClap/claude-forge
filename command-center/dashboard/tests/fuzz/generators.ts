/**
 * Forge Workspace — seeded, dependency-free fuzz generators (mission section M).
 *
 * The whole point of a fuzzer is to be surprising; the whole point of a TEST is
 * to be reproducible. Those pull in opposite directions unless the randomness is
 * itself deterministic — so every generator here draws from a seeded mulberry32
 * PRNG and NOTHING else. No `Math.random`, no `Date.now`, no ambient state. A
 * failing run in `inputs.test.ts` reports its seed; feeding that seed back to
 * `makeRng` reproduces the exact input that broke, byte for byte, on any machine.
 *
 * There is no property-testing dependency and there never will be: a security
 * fuzzer that pulls a third-party generator inherits that generator's surface.
 *
 * This module GENERATES and SHRINKS. It never asserts. The real functions under
 * test, and every claim about them, live in `inputs.test.ts` — a generator that
 * knew the expected answer would just be a second, weaker copy of the code.
 */

import { EVENT_TYPES } from '@/shared/protocol';
import type { EventSource, EventType } from '@/shared/protocol';
import {
  RUN_MACHINE,
  allowedTransitionsFrom,
  canRunTransition,
  isTerminalRunState,
  requiredGateForRunState,
} from '@/shared/state-machines';
import type { RunState } from '@/shared/state-machines';

/* ========================================================================== */
/*  The PRNG                                                                    */
/* ========================================================================== */

export interface Rng {
  /** The seed this generator was built from, for the failure report. */
  readonly seed: number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, bound). Returns 0 for a non-positive bound. */
  int(bound: number): number;
  /** True with probability `pTrue` (default 0.5). */
  bool(pTrue?: number): boolean;
  /** A uniform element. The caller guarantees the list is non-empty. */
  pick<T>(items: readonly T[]): T;
  /** A uniform integer in [min, max]. */
  count(min: number, max: number): number;
}

/** mulberry32 — tiny, fast, and identical on every platform and every run. */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (bound: number): number => (bound <= 0 ? 0 : Math.floor(next() * bound));
  return {
    seed: seed >>> 0,
    next,
    int,
    bool: (pTrue = 0.5) => next() < pTrue,
    pick: <T>(items: readonly T[]): T => items[int(items.length)],
    count: (min, max) => min + int(Math.max(0, max - min + 1)),
  };
}

/**
 * A per-iteration seed derived from a base seed and an index, spread with the
 * golden-ratio constant so consecutive iterations do not explore adjacent
 * regions of the PRNG state.
 */
export function deriveSeed(base: number, index: number): number {
  return (base + Math.imul(index, 0x9e3779b1)) >>> 0;
}

/* ========================================================================== */
/*  Character and token pools — the traps a real attacker reaches for          */
/* ========================================================================== */

const ORDINARY_NAMES: readonly string[] = [
  'My Project',
  'forge-dashboard',
  'réseau routing',
  'проект альфа',
  '日本語プロジェクト',
  'Data 2026',
  'a_b-c',
  'Über App',
  'café-menu',
  'client work',
  'v2 rewrite',
  'notes',
];

const SEPARATOR_TOKENS: readonly string[] = ['/', '\\', '//', '\\\\', '/\\', '\\/'];

const TRAVERSAL_TOKENS: readonly string[] = [
  '..',
  '../',
  '..\\',
  '../../',
  '..\\..\\',
  'a/../../b',
  '%2e%2e',
  '%2e%2e%2f',
  '%252e%252e%252f',
  '..%c0%af',
  '....//',
];

const DEVICE_NAMES: readonly string[] = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM9',
  'LPT1',
  'con',
  'nul.txt',
  'CON.tar.gz',
  'CONIN$',
  'CONOUT$',
  'clock$',
  'CON. ',
  '  con  ',
  'lpt1.log',
  'aux.',
];

const DRIVE_UNC_TOKENS: readonly string[] = [
  'C:\\',
  'c:',
  'C:project',
  'D:\\data',
  '\\\\server\\share',
  '//server/share',
  '\\\\?\\C:\\',
  '\\\\.\\PhysicalDrive0',
  '\\\\?\\UNC\\server\\share',
];

const BIDI_INVISIBLE_CHARS: readonly string[] = [
  '\u202e', // RIGHT-TO-LEFT OVERRIDE
  '\u202a',
  '\u200b', // ZERO WIDTH SPACE
  '\u200f',
  '\u2066',
  '\u2069',
  '\ufeff',
  '\u00ad', // SOFT HYPHEN
  '\u2060',
  '\ufff9',
];

const LOOKALIKE_CHARS: readonly string[] = [
  '\u2044', // FRACTION SLASH
  '\u2215', // DIVISION SLASH
  '\u29f8', // BIG SOLIDUS
  '\u01c0', // LATIN LETTER DENTAL CLICK
  '\u29f9', // BIG REVERSE SOLIDUS
  '\u3002', // IDEOGRAPHIC FULL STOP
  '\u06d4', // ARABIC FULL STOP
  '\ua4f8',
  '\u2236', // RATIO (colon lookalike)
  '\ua789',
];

const HOMOGLYPH_NAMES: readonly string[] = [
  'раypal', // Cyrillic ер + а
  'аpple',
  'miсrosoft',
  'ѕсоре',
  'gооgle',
  'ѕａｍｐｌｅ',
];

const CONTROL_CHARS: readonly string[] = ['\u0000', '\u0001', '\u0008', '\u001f', '\u007f', '\u0085', '\u0009'];

const COLON_ADS_TOKENS: readonly string[] = ['report:$DATA', 'file.txt:hidden', 'a:b:c', '$Extend:$Data'];

const DOTS_WS_NAMES: readonly string[] = ['', '   ', '...', '. . .', '\t', '\u00a0', '.', ' .', '....', '  ..  '];

const FULLWIDTH_TOKENS: readonly string[] = ['ＣＯＮ', 'ｒｅｐｏｒｔ', '．．／', 'ＣＯＭ１', 'ＮＵＬ'];

const ABSOLUTE_OUT: readonly string[] = [
  'C:\\Windows\\System32',
  'C:\\Users\\other\\.ssh\\id_rsa',
  'C:\\Windows\\System32\\config\\SAM',
  '/etc/passwd',
  '/root/.ssh/id_rsa',
  'D:\\secret\\vault',
  '\\\\server\\c$',
];

const EVENT_SOURCES: readonly EventSource[] = ['forge', 'claude-code', 'bridge', 'test', 'user'];

/* ---- small assembly helpers ------------------------------------------------ */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function letters(rng: Rng, min: number, max: number): string {
  const n = rng.count(min, max);
  let out = '';
  for (let i = 0; i < n; i += 1) out += LETTERS[rng.int(LETTERS.length)];
  return out;
}

function insertChars(rng: Rng, base: string, pool: readonly string[]): string {
  let out = base;
  const inserts = rng.count(1, 3);
  for (let i = 0; i < inserts; i += 1) {
    const at = rng.int(out.length + 1);
    out = out.slice(0, at) + rng.pick(pool) + out.slice(at);
  }
  return out;
}

function mixTokens(rng: Rng): string {
  const pools: readonly (readonly string[])[] = [
    ORDINARY_NAMES,
    SEPARATOR_TOKENS,
    TRAVERSAL_TOKENS,
    DEVICE_NAMES,
    LOOKALIKE_CHARS,
    BIDI_INVISIBLE_CHARS,
    FULLWIDTH_TOKENS,
    COLON_ADS_TOKENS,
    HOMOGLYPH_NAMES,
  ];
  const parts = rng.count(2, 5);
  let out = '';
  for (let i = 0; i < parts; i += 1) out += rng.pick(rng.pick(pools));
  return out;
}

function safeSubPath(rng: Rng): string {
  const depth = rng.count(1, 4);
  const segs: string[] = [];
  for (let i = 0; i < depth; i += 1) segs.push(letters(rng, 1, 8));
  return segs.join('/');
}

function mixSepPath(rng: Rng): string {
  const depth = rng.count(2, 5);
  let out = letters(rng, 1, 6);
  for (let i = 1; i < depth; i += 1) out += rng.pick(SEPARATOR_TOKENS) + letters(rng, 1, 6);
  return out;
}

/* ========================================================================== */
/*  1. Display names for sanitizeSlug                                          */
/* ========================================================================== */

/**
 * A candidate project display name. Weighted so a healthy fraction are ORDINARY
 * (those produce accepted slugs and exercise the success invariants) and the
 * rest are hostile in every way the guard claims to handle.
 */
export function genDisplayName(rng: Rng): string {
  const shape = rng.int(13);
  switch (shape) {
    case 0:
    case 1:
    case 2: {
      let s = rng.pick(ORDINARY_NAMES);
      if (rng.bool(0.4)) s += ` ${rng.int(9999)}`;
      return s;
    }
    case 3:
      return `${rng.pick(ORDINARY_NAMES)}${rng.pick(SEPARATOR_TOKENS)}${rng.pick(TRAVERSAL_TOKENS)}`;
    case 4:
      return rng.pick(DEVICE_NAMES);
    case 5:
      return rng.pick(DRIVE_UNC_TOKENS) + (rng.bool() ? rng.pick(ORDINARY_NAMES) : '');
    case 6:
      return insertChars(rng, rng.pick(ORDINARY_NAMES), rng.pick([BIDI_INVISIBLE_CHARS, LOOKALIKE_CHARS, CONTROL_CHARS]));
    case 7:
      return rng.pick(HOMOGLYPH_NAMES);
    case 8:
      return rng.pick(COLON_ADS_TOKENS);
    case 9:
      return rng.pick(DOTS_WS_NAMES);
    case 10:
      return rng.pick(ORDINARY_NAMES).repeat(rng.count(3, 60)); // over-length payload
    case 11:
      return rng.pick(FULLWIDTH_TOKENS);
    default:
      return mixTokens(rng);
  }
}

/* ========================================================================== */
/*  2. Paths for assertInsideRoot                                              */
/* ========================================================================== */

export const POSIX_ROOT = '/home/fuzzer/Documents/ForgeProjecten';
export const WIN_ROOT = 'C:\\Users\\fuzzer\\Documents\\ForgeProjecten';

/**
 * A candidate path to feed to `assertInsideRoot`. Some are legitimately inside
 * (relative, safe segments); the rest reach for the boundary in every direction
 * the guard names: traversal, absolute escapes, UNC/device namespaces, reserved
 * segments, trailing dots, alternate data streams, control characters and
 * absurd length.
 */
export function genPath(rng: Rng): string {
  const shape = rng.int(13);
  switch (shape) {
    case 0:
    case 1:
    case 2:
      return safeSubPath(rng);
    case 3:
      return `${safeSubPath(rng)}${rng.pick(SEPARATOR_TOKENS)}${rng.pick(TRAVERSAL_TOKENS)}${rng.pick(SEPARATOR_TOKENS)}etc`;
    case 4:
      return rng.pick(ABSOLUTE_OUT);
    case 5:
      return rng.pick(DRIVE_UNC_TOKENS);
    case 6:
      return `${safeSubPath(rng)}/${rng.pick(DEVICE_NAMES)}`;
    case 7:
      return `${safeSubPath(rng)}/name${rng.pick([' ', '.', '. ', '..'])}`;
    case 8:
      return `${safeSubPath(rng)}/${rng.pick(COLON_ADS_TOKENS)}`;
    case 9:
      return insertChars(rng, safeSubPath(rng), rng.pick([CONTROL_CHARS, BIDI_INVISIBLE_CHARS, LOOKALIKE_CHARS]));
    case 10:
      return mixSepPath(rng);
    case 11:
      return `${safeSubPath(rng)}/${rng.pick(HOMOGLYPH_NAMES)}`;
    default:
      return 'x/'.repeat(2100); // deliberately over MAX_PATH_LENGTH
  }
}

/* ========================================================================== */
/*  3. Run-machine transition sequences (the attempt model)                    */
/* ========================================================================== */

export type EvidenceQuality = 'complete' | 'broken' | 'absent';

export type RunStep =
  | { readonly kind: 'advance'; readonly to: RunState; readonly quality: EvidenceQuality }
  | { readonly kind: 'retry' };

/**
 * One step along a shortest path to `target`, per state. A purely random walk
 * essentially never reaches COMPLETED, which would make the "COMPLETED needs the
 * gate" property vacuous. This bias is what makes the property real.
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

/**
 * A sequence of advance/retry steps. It threads the REAL machine as it goes,
 * using `canRunTransition` and the fact that complete evidence passes any gate,
 * so the walk knows where it stands and can steer toward the interesting states
 * — but it deliberately also fires illegal transitions and broken/absent
 * evidence, so the refusal paths are exercised too.
 */
export function genRunSteps(rng: Rng, maxSteps = 24): readonly RunStep[] {
  const steps: RunStep[] = [];
  const length = 6 + rng.int(Math.max(1, maxSteps - 5));
  let state: RunState = RUN_MACHINE.initial;
  let terminal = isTerminalRunState(RUN_MACHINE.initial);

  for (let i = 0; i < length; i += 1) {
    if (terminal) {
      if (rng.bool(0.5)) {
        steps.push({ kind: 'retry' });
        state = RUN_MACHINE.initial;
        terminal = isTerminalRunState(RUN_MACHINE.initial);
      } else {
        // Push at the terminal attempt; this must always be refused.
        steps.push({ kind: 'advance', to: rng.pick(RUN_MACHINE.states), quality: 'complete' });
      }
      continue;
    }

    const allowed = allowedTransitionsFrom(RUN_MACHINE, state);
    const roll = rng.next();
    let to: RunState;
    if (roll < 0.55 && TOWARD_COMPLETED[state] !== null) {
      to = TOWARD_COMPLETED[state] as RunState;
    } else if (roll < 0.85 && allowed.length > 0) {
      to = rng.pick(allowed);
    } else {
      to = rng.pick(RUN_MACHINE.states); // usually illegal, on purpose
    }

    const q = rng.next();
    const quality: EvidenceQuality = q < 0.8 ? 'complete' : q < 0.92 ? 'broken' : 'absent';
    steps.push({ kind: 'advance', to, quality });

    // Mirror the runner so the generator knows where it stands. Complete
    // evidence is built (in the test) to pass, so it is sound to treat it so.
    const gate = requiredGateForRunState(to);
    const gatePasses = gate === null || quality === 'complete';
    if (canRunTransition(state, to) && gatePasses) {
      state = to;
      terminal = isTerminalRunState(to);
    }
  }

  return steps;
}

/* ========================================================================== */
/*  4. Generic walks across any machine                                        */
/* ========================================================================== */

export interface MachineWalk {
  readonly start: string;
  readonly targets: readonly string[];
}

/**
 * A random walk over an arbitrary machine's declared states. The start is
 * usually the initial state but sometimes any state (so terminal starts are
 * exercised too). The targets are picked with no regard for legality — the test
 * checks that the guard's verdict matches the table for every one.
 */
export function genMachineWalk(rng: Rng, states: readonly string[], initial: string, maxSteps = 16): MachineWalk {
  const start = rng.bool(0.7) ? initial : rng.pick(states);
  const length = 4 + rng.int(maxSteps);
  const targets: string[] = [];
  for (let i = 0; i < length; i += 1) targets.push(rng.pick(states));
  return { start, targets };
}

/* ========================================================================== */
/*  5. Event-append operations for the store                                   */
/* ========================================================================== */

export interface EventOp {
  readonly eventId: string;
  readonly type: EventType;
  readonly source: EventSource;
  readonly tag: number;
}

/**
 * A batch of append operations over a small pool of event ids, so the same id
 * recurs — that recurrence is the duplicate-handling being tested. The types and
 * sources are drawn from the real contract vocabularies, so every generated
 * append is one the store's validator will accept.
 */
export function genEventOps(rng: Rng): readonly EventOp[] {
  const unique = 1 + rng.int(24);
  const ids = Array.from({ length: unique }, (_, k) => `evt-${k}`);
  const opCount = unique + rng.int(unique + 6);
  const ops: EventOp[] = [];
  for (let i = 0; i < opCount; i += 1) {
    ops.push({
      eventId: rng.pick(ids),
      type: rng.pick(EVENT_TYPES),
      source: rng.pick(EVENT_SOURCES),
      tag: rng.int(1_000_000),
    });
  }
  return ops;
}

/* ========================================================================== */
/*  6. Out-of-order / gapped raw sequence plans                                */
/* ========================================================================== */

export interface RawSequencePlan {
  readonly max: number;
  /** The sequence numbers that ARE present, sorted and unique. */
  readonly present: readonly number[];
  /** The order the raw lines are written to disk (a shuffle of `present`). */
  readonly writeOrder: readonly number[];
}

/**
 * A plan for a damaged log: a subset of 1..max, always including `max`, written
 * to disk out of order. Missing numbers are holes the store must report as gaps
 * and must never quietly number around.
 */
export function genRawSequencePlan(rng: Rng): RawSequencePlan {
  const max = rng.count(3, 30);
  const present: number[] = [];
  for (let s = 1; s <= max; s += 1) {
    if (s === max || rng.bool(0.7)) present.push(s);
  }
  const writeOrder = shuffle(rng, present);
  return { max, present, writeOrder };
}

function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/* ========================================================================== */
/*  7. Adversarial markdown                                                    */
/* ========================================================================== */

const MD_FRAGMENTS: readonly string[] = [
  '# Heading with **bold** and `code`',
  '## sub *heading*',
  '###### deep',
  '######### too many hashes',
  '```js',
  'console.log("hi")',
  '```',
  '```unterminated fence that never closes',
  '~~~',
  'tilde fenced body',
  '~~~',
  '> a quote',
  '> > nested marker',
  '- item one\n- item two\n- item three',
  '1. first\n2. second\n10) tenth',
  '| a | b |\n| - | - |\n| 1 | 2 |',
  '| ragged | header | row |\n|:-|-:|:-:|\n| only-one |',
  '[link](https://example.com)',
  '[relative](/docs/readme)',
  '[anchor](#section)',
  '[evil](javascript:alert(1))',
  '[data uri](data:text/html,<script>alert(1)</script>)',
  '[proto](vbscript:msgbox(1))',
  '<script>alert(document.cookie)</script>',
  '<img src=x onerror=alert(1)>',
  '<iframe src="https://evil.example"></iframe>',
  '&lt;script&gt; already escaped',
  '**unclosed bold',
  '*em _mixed **deep _more_ ** _ *',
  '___lots___ of __under__ _scores_',
  'snake_case_name stays literal, right_here_too',
  '`inline ``` backticks` and `code`',
  '---',
  '***',
  '   ',
  'a plain paragraph that wraps\nonto a second line',
  '`'.repeat(20),
  '*'.repeat(30),
  '[](())[]()',
  '>>>>>>> not a merge marker',
  '|||||',
];

/**
 * An adversarial markdown document assembled from fragments known to stress a
 * hand-rolled parser: unclosed fences, mixed and nested emphasis, table rows
 * that do not line up, links with dangerous schemes, and raw HTML that must be
 * rendered as inert text. Bidi, zero-width and control characters are salted in.
 */
export function genMarkdown(rng: Rng): string {
  const count = rng.count(1, 24);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let fragment = rng.pick(MD_FRAGMENTS);
    if (rng.bool(0.15)) fragment = insertChars(rng, fragment, rng.pick([BIDI_INVISIBLE_CHARS, CONTROL_CHARS]));
    if (rng.bool(0.1)) fragment += ` ${rng.pick(HOMOGLYPH_NAMES)}`;
    parts.push(fragment);
  }
  return parts.join(rng.bool(0.5) ? '\n' : '\n\n');
}

/**
 * A very large markdown document — width, not pathological nesting depth. Tests
 * that the renderer stays total on a document far larger than any real reply,
 * without risking a stack overflow that would say nothing about the parser.
 */
export function genHugeMarkdown(rng: Rng): string {
  const shape = rng.int(6);
  switch (shape) {
    case 0:
      return `${'word '.repeat(rng.count(6000, 12000))}`;
    case 1:
      return `${'# heading\n'.repeat(rng.count(3000, 6000))}`;
    case 2:
      return `\`\`\`\n${'x = 1\n'.repeat(rng.count(6000, 12000))}`; // huge unterminated fence
    case 3:
      return `${'**bold** _em_ `code` '.repeat(rng.count(3000, 6000))}`;
    case 4:
      return `${'| a | b | c |\n'.repeat(rng.count(4000, 8000))}`; // rows with no separator row
    default:
      return `${'- item '.repeat(rng.count(4000, 8000))}`;
  }
}

/* ========================================================================== */
/*  Shrinking — greedy delta debugging, deterministic                          */
/* ========================================================================== */

/**
 * The smallest string that still satisfies `stillFails`, found by removing
 * chunks at halving sizes. Sound because `stillFails` re-runs the real check.
 */
export function shrinkString(input: string, stillFails: (s: string) => boolean): string {
  let current = input;
  let size = Math.max(1, Math.floor(current.length / 2));
  while (size >= 1) {
    let i = 0;
    while (i < current.length) {
      const candidate = current.slice(0, i) + current.slice(i + size);
      if (candidate.length !== current.length && stillFails(candidate)) {
        current = candidate;
      } else {
        i += size;
      }
    }
    size = Math.floor(size / 2);
  }
  return current;
}

/**
 * The shortest sub-list that still satisfies `stillFails`, by greedy single-
 * element removal until nothing more can go. Every remaining element is load
 * bearing with respect to single-step removal.
 */
export function shrinkList<T>(items: readonly T[], stillFails: (xs: readonly T[]) => boolean): readonly T[] {
  let current = items;
  let improved = true;
  let guard = 0;
  while (improved && guard < 4_000) {
    improved = false;
    for (let i = 0; i < current.length; i += 1) {
      guard += 1;
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      if (stillFails(candidate)) {
        current = candidate;
        improved = true;
        break;
      }
    }
  }
  return current;
}
