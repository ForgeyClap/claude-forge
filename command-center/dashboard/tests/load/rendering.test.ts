/**
 * Load & performance — RENDERING (mission section I).
 *
 * SYNTHETIC. Every graph, conversation and file tree built here is fabricated in
 * this file and is labelled so in the test names and in the report. Nothing here
 * is evidence that a real Claude Code run happened; it measures how the pure
 * rendering maths behaves as the input grows.
 *
 * What is measured, and against what real code:
 *
 *   graph layout        the REAL `computeGraphLayout` from
 *                       src/views/mission/useGraphViewport.ts, over synthetic
 *                       graphs of 10, 100 and 1000 nodes. It is a pure function
 *                       of `col`/`row`; with no `document` present it uses its
 *                       token fallbacks, which is deterministic and fine here.
 *                       ASSERTED: one box per node, no NaN position, finite world.
 *                       MEASURED: layout time p50/p95/p99 (recorded, not judged).
 *
 *   conversation map    the REAL `renderMarkdown` from src/views/chat/markdown.tsx
 *                       over a long synthetic conversation. It only builds the
 *                       React element tree — it never touches a DOM — so `node`
 *                       is a sufficient environment. MEASURED per message.
 *
 *   file tree           REPRESENTATIVE only. The production flatten / visible-row
 *                       functions in FilesView.tsx are module-private (not
 *                       exported), so there is no real symbol to import. This
 *                       measures an equivalent traversal over a synthetic tree so
 *                       the cost characteristic is on record, and the report says
 *                       plainly that it is representative, not the real function.
 *
 * The measurements are written to a temp JSON that scripts/perf-report.cjs folds
 * into artifacts/perf-report.json. Percentile targets are never asserted as
 * pass/fail here — they are measured honestly and reported.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { arch, platform, version as nodeVersion } from 'node:process';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { computeGraphLayout } from '@/views/mission/useGraphViewport';
import { renderMarkdown } from '@/views/chat/markdown';
import type {
  FileNode,
  GraphLane,
  GraphNode,
  GraphNodeKind,
  MissionGraph,
  StatusKey,
} from '@/prototype/types/prototype-types';

/* ------------------------------------------------------------------ output */

const OUT_DIR = join(tmpdir(), 'forge-perf-suite');
const OUT_FILE = join(OUT_DIR, 'rendering.json');
const BANNER = 'SYNTHETIC — rendering only, not execution proof';

/* --------------------------------------------------------------- statistics */

interface Summary {
  readonly sampleCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

function round(value: number, places = 5): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** Nearest-rank percentile over a sorted-ascending copy. */
function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  let index = Math.ceil((p / 100) * n) - 1;
  if (index < 0) index = 0;
  if (index > n - 1) index = n - 1;
  return sortedAsc[index];
}

function summarize(samplesMs: readonly number[]): Summary {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    sampleCount: n,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    minMs: round(sorted[0] ?? NaN),
    maxMs: round(sorted[n - 1] ?? NaN),
    meanMs: round(n > 0 ? sum / n : NaN),
  };
}

/** Time `fn` `iterations` times after `warmup` untimed passes. */
function timeIterations(fn: () => void, iterations: number, warmup: number): number[] {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples: number[] = new Array<number>(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn();
    samples[i] = performance.now() - start;
  }
  return samples;
}

/* --------------------------------------------------- synthetic graph builder */

const STATUS_CYCLE: readonly StatusKey[] = [
  'running',
  'completed',
  'waiting',
  'verify',
  'review',
  'failed',
  'blocked',
];
const KIND_CYCLE: readonly GraphNodeKind[] = ['step', 'verify', 'review', 'fix', 'lane-agent'];

const SYNTH_LANES: readonly GraphLane[] = [
  { prototype: true, id: 'ln-a', label: 'Lane A', group: 'context' },
  { prototype: true, id: 'ln-b', label: 'Lane B', group: 'execution' },
  { prototype: true, id: 'ln-c', label: 'Lane C', group: 'execution' },
  { prototype: true, id: 'ln-d', label: 'Lane D', group: 'review' },
  { prototype: true, id: 'ln-e', label: 'Lane E', group: 'review' },
  { prototype: true, id: 'ln-f', label: 'Lane F', group: 'domain' },
];

/**
 * A fabricated grid graph of `nodeCount` nodes laid out over columns and lane
 * rows. Purely to exercise `computeGraphLayout`'s arithmetic at scale — it is
 * not a plausible mission and does not pretend to be.
 */
function buildSyntheticGraph(nodeCount: number): MissionGraph {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodeCount)));
  const laneCount = SYNTH_LANES.length;
  const nodes: GraphNode[] = new Array<GraphNode>(nodeCount);
  for (let i = 0; i < nodeCount; i += 1) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    nodes[i] = {
      prototype: true,
      id: `sn-${i}`,
      label: `Synthetic node ${i}`,
      kind: KIND_CYCLE[i % KIND_CYCLE.length],
      status: STATUS_CYCLE[i % STATUS_CYCLE.length],
      col,
      row,
      laneId: SYNTH_LANES[row % laneCount].id,
    };
  }
  return {
    prototype: true,
    id: `synthetic-graph-${nodeCount}`,
    runId: `synthetic-run-${nodeCount}`,
    lanes: SYNTH_LANES,
    nodes,
    edges: [],
  };
}

/** True when every geometric field on the layout is a finite number. */
function layoutIsFinite(graph: MissionGraph): { readonly ok: boolean; readonly firstBad: string | null } {
  const layout = computeGraphLayout(graph);
  const finite = (v: number): boolean => Number.isFinite(v);
  if (!finite(layout.width) || !finite(layout.height)) return { ok: false, firstBad: 'world width/height' };
  if (!finite(layout.topChannel) || !finite(layout.bottomChannel)) return { ok: false, firstBad: 'channels' };
  if (!finite(layout.channelBelow(0))) return { ok: false, firstBad: 'channelBelow' };
  for (const box of layout.boxes) {
    if (!finite(box.x) || !finite(box.y) || !finite(box.w) || !finite(box.h) || !finite(box.cx) || !finite(box.cy)) {
      return { ok: false, firstBad: `box ${box.node.id}` };
    }
  }
  for (const band of layout.bands) {
    if (!finite(band.x) || !finite(band.y) || !finite(band.w) || !finite(band.h) || !finite(band.labelX) || !finite(band.labelY)) {
      return { ok: false, firstBad: `band ${band.lane.id}` };
    }
  }
  return { ok: true, firstBad: null };
}

/* -------------------------------------------- synthetic conversation builder */

/** One fabricated markdown message body, deterministically varied by index. */
function syntheticMessageBody(i: number): string {
  const lines = [
    `## Synthetic message ${i}`,
    '',
    `This is a **fabricated** paragraph with _emphasis_, some \`inline code\`, and a [link](https://127.0.0.1/local).`,
    '',
    '- first bullet',
    '- second bullet with `code`',
    '- third bullet',
    '',
    '1. ordered one',
    '2. ordered two',
    '',
    '> A blockquote, still synthetic.',
    '',
    '```ts',
    `const value = ${i}; // not a real run`,
    'export const doubled = value * 2;',
    '```',
    '',
    '| col a | col b |',
    '| --- | --- |',
    `| ${i} | ${i * 2} |`,
  ];
  return lines.join('\n');
}

/* ------------------------------------------------ synthetic file-tree builder */

/**
 * A fabricated directory tree of roughly `target` nodes. Representative only —
 * it exists to measure traversal cost, not to mirror any real workspace.
 */
function buildFileTree(target: number): { readonly roots: FileNode[]; readonly nodeCount: number } {
  const breadth = Math.max(2, Math.ceil(target ** (1 / 3)));
  let counter = 0;
  const make = (depth: number): FileNode => {
    const id = `ft-${counter}`;
    counter += 1;
    const isDir = depth < 3;
    if (!isDir) {
      return { prototype: true, id, name: `${id}.ts`, path: `/synthetic/${id}.ts`, kind: 'file' };
    }
    const children: FileNode[] = [];
    for (let i = 0; i < breadth && counter < target; i += 1) children.push(make(depth + 1));
    return { prototype: true, id, name: id, path: `/synthetic/${id}`, kind: 'dir', children };
  };
  const roots: FileNode[] = [];
  while (counter < target) roots.push(make(0));
  return { roots, nodeCount: counter };
}

/**
 * A traversal that mirrors FilesView's module-private `flattenFiles`. Marked
 * REPRESENTATIVE in the report because the production symbol is not exported.
 */
function flattenTree(nodes: readonly FileNode[], out: FileNode[]): FileNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.children) flattenTree(node.children, out);
  }
  return out;
}

interface VisibleRow {
  readonly node: FileNode;
  readonly level: number;
}

/** Mirrors FilesView's module-private `visibleRows` with every directory open. */
function visibleRows(nodes: readonly FileNode[], expanded: ReadonlySet<string>, level: number, out: VisibleRow[]): VisibleRow[] {
  for (const node of nodes) {
    out.push({ node, level });
    if (node.kind === 'dir' && expanded.has(node.id) && node.children) {
      visibleRows(node.children, expanded, level + 1, out);
    }
  }
  return out;
}

function collectDirIds(nodes: readonly FileNode[], out: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      out.add(node.id);
      if (node.children) collectDirIds(node.children, out);
    }
  }
  return out;
}

/* ------------------------------------------------------------ result record */

const results: Record<string, unknown> = {
  suite: 'rendering',
  synthetic: true,
  banner: BANNER,
  generatedAt: new Date().toISOString(),
  env: { node: nodeVersion, platform, arch },
  graphLayout: [] as unknown[],
  conversationMapping: [] as unknown[],
  fileTree: {
    provenance:
      'REPRESENTATIVE traversal — the production flatten/visible-row functions in ' +
      'src/views/files/FilesView.tsx are module-private (not exported), so no real ' +
      'symbol is importable; this measures an equivalent traversal over synthetic data.',
    cases: [] as unknown[],
  },
};

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf8');
});

/* ========================================================================== */
/*  Graph layout                                                               */
/* ========================================================================== */

describe('SYNTHETIC graph layout — the real computeGraphLayout at scale', () => {
  const CASES: readonly { readonly nodes: number; readonly iterations: number; readonly p99CeilingMs: number }[] = [
    { nodes: 10, iterations: 2000, p99CeilingMs: 50 },
    { nodes: 100, iterations: 1000, p99CeilingMs: 150 },
    { nodes: 1000, iterations: 200, p99CeilingMs: 750 },
  ];

  for (const testCase of CASES) {
    it(`lays out ${testCase.nodes} synthetic nodes with no NaN and bounded time`, () => {
      const graph = buildSyntheticGraph(testCase.nodes);

      // Correctness first: one box per node, unique ids, every position finite.
      const layout = computeGraphLayout(graph);
      expect(layout.boxes).toHaveLength(testCase.nodes);
      expect(layout.byId.size).toBe(testCase.nodes);
      const finiteCheck = layoutIsFinite(graph);
      expect(finiteCheck.firstBad).toBeNull();
      expect(finiteCheck.ok).toBe(true);
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.height).toBeGreaterThan(0);

      // Then the measurement.
      const samples = timeIterations(() => void computeGraphLayout(graph), testCase.iterations, Math.ceil(testCase.iterations * 0.1));
      const summary = summarize(samples);

      // "Bounded", not the mission target: a loose ceiling that catches an
      // O(n^2) regression without turning normal jitter into a red build.
      expect(summary.p99Ms).toBeLessThan(testCase.p99CeilingMs);

      (results.graphLayout as unknown[]).push({
        nodes: testCase.nodes,
        iterations: testCase.iterations,
        boxes: layout.boxes.length,
        nanFound: !finiteCheck.ok,
        worldWidth: round(layout.width, 2),
        worldHeight: round(layout.height, 2),
        boundedCeilingMs: testCase.p99CeilingMs,
        durationsMs: summary,
      });
    });
  }
});

/* ========================================================================== */
/*  Conversation mapping                                                       */
/* ========================================================================== */

describe('SYNTHETIC conversation mapping — the real renderMarkdown at length', () => {
  const CASES: readonly { readonly messages: number; readonly passes: number }[] = [
    { messages: 200, passes: 30 },
    { messages: 500, passes: 15 },
  ];

  for (const testCase of CASES) {
    it(`maps a synthetic ${testCase.messages}-message conversation to elements`, () => {
      const bodies = Array.from({ length: testCase.messages }, (_, i) => syntheticMessageBody(i));

      // Correctness: every message produces a truthy element tree, nothing throws.
      for (let i = 0; i < bodies.length; i += 1) {
        const node = renderMarkdown(bodies[i], { idPrefix: `synthetic-${i}` });
        expect(node).toBeTruthy();
      }

      const passSamples = timeIterations(
        () => {
          for (let i = 0; i < bodies.length; i += 1) renderMarkdown(bodies[i], { idPrefix: `p-${i}` });
        },
        testCase.passes,
        2,
      );
      const passSummary = summarize(passSamples);
      const perMessageMs = round(passSummary.meanMs / testCase.messages);

      (results.conversationMapping as unknown[]).push({
        messages: testCase.messages,
        passes: testCase.passes,
        wholeConversationDurationsMs: passSummary,
        meanPerMessageMs: perMessageMs,
      });

      // Bounded: a whole 500-message pass should not take seconds.
      expect(passSummary.p99Ms).toBeLessThan(4000);
    });
  }
});

/* ========================================================================== */
/*  File tree (representative)                                                 */
/* ========================================================================== */

describe('SYNTHETIC file tree — representative traversal (production fns not exported)', () => {
  const CASES: readonly { readonly target: number; readonly iterations: number }[] = [
    { target: 1000, iterations: 500 },
    { target: 5000, iterations: 200 },
  ];

  for (const testCase of CASES) {
    it(`flattens a synthetic ~${testCase.target}-node tree with no loss`, () => {
      const { roots, nodeCount } = buildFileTree(testCase.target);
      const expanded = collectDirIds(roots, new Set<string>());

      // Correctness: the flatten visits every node exactly once.
      const flat = flattenTree(roots, []);
      expect(flat).toHaveLength(nodeCount);
      expect(new Set(flat.map((n) => n.id)).size).toBe(nodeCount);
      // With every directory expanded, visibleRows returns every node too.
      const rows = visibleRows(roots, expanded, 0, []);
      expect(rows).toHaveLength(nodeCount);

      const flattenSamples = timeIterations(() => void flattenTree(roots, []), testCase.iterations, 10);
      const visibleSamples = timeIterations(() => void visibleRows(roots, expanded, 0, []), testCase.iterations, 10);

      (results.fileTree as { cases: unknown[] }).cases.push({
        nodeCount,
        iterations: testCase.iterations,
        flattenDurationsMs: summarize(flattenSamples),
        visibleRowsDurationsMs: summarize(visibleSamples),
      });

      expect(summarize(flattenSamples).p99Ms).toBeLessThan(500);
    });
  }
});
