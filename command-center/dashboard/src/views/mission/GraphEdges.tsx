/**
 * Mission Control — the connectors.
 *
 * Hand-rolled orthogonal routing: horizontal, vertical, horizontal, with small
 * rounded corners at the bends. No graph library is involved; the rules are:
 *
 *   flow        solid, arrow head, turns in the routing gutter that sits in
 *               front of the target column. Parallel runs are fanned a few
 *               pixels apart so a six-way split reads as six lines, not one.
 *   dependency  lighter and finer. Crossing a lane is done through the
 *               node-free channel between two bands, then up a column gutter,
 *               so a dependency never runs over a card.
 *   feedback    dashed and labelled, routed clear of the whole diagram: the
 *               mission reopen rides above every band, the repair-and-retest
 *               loop rides below it and turns back into the build lane.
 *
 * Every geometric constant below is derived from the layout tokens through
 * GraphLayout — nothing here hard-codes a node size.
 */

import type { GraphEdge } from '@/prototype/types/prototype-types';
import type { GraphLayout, NodeBox } from './useGraphViewport';

interface Pt {
  readonly x: number;
  readonly y: number;
}

/** How far a dependency stands off a node edge so it never hides a flow line. */
const DEP_OFFSET = 12;
/** Same idea for the return path, one step further out again. */
const FEEDBACK_OFFSET = 14;
/** Fan applied to parallel trunk lines, per row of separation. */
const FLOW_SPREAD = 3.5;
const CORNER = 10;

const LABEL_CHAR = 6.3;
const LABEL_PAD = 12;
const LABEL_H = 16;

/* --------------------------------------------------------------- geometry */

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function dedupe(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - point.x) < 0.5 && Math.abs(last.y - point.y) < 0.5) continue;
    out.push(point);
  }
  return out;
}

function toward(from: Pt, to: Pt, distance: number): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return from;
  const t = Math.min(1, distance / length);
  return { x: from.x + dx * t, y: from.y + dy * t };
}

/** Polyline to an SVG path, with a quadratic tuck at every bend. */
function orthPath(raw: readonly Pt[], radius: number): string {
  const points = dedupe(raw);
  if (points.length < 2) return '';

  const parts: string[] = [`M ${round(points[0].x)} ${round(points[0].y)}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const r = Math.min(
      radius,
      Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2,
      Math.hypot(next.x - cur.x, next.y - cur.y) / 2,
    );
    const enter = toward(cur, prev, r);
    const exit = toward(cur, next, r);
    parts.push(`L ${round(enter.x)} ${round(enter.y)}`);
    if (r > 0.75) parts.push(`Q ${round(cur.x)} ${round(cur.y)} ${round(exit.x)} ${round(exit.y)}`);
  }
  const last = points[points.length - 1];
  parts.push(`L ${round(last.x)} ${round(last.y)}`);
  return parts.join(' ');
}

/* ----------------------------------------------------------------- router */

function routeFlow(from: NodeBox, to: NodeBox, layout: GraphLayout): Pt[] {
  const { colGap } = layout.metrics;
  const start: Pt = { x: from.x + from.w, y: from.cy };
  if (Math.abs(from.cy - to.cy) < 0.5 && to.x > from.x) {
    return [start, { x: to.x, y: to.cy }];
  }
  // The turn happens in the gutter in front of the target, which is why a
  // six-way split shares one trunk. The fan keeps the six readable.
  const trunk = to.x - colGap / 2 + (from.node.row - to.node.row) * FLOW_SPREAD;
  return [start, { x: trunk, y: from.cy }, { x: trunk, y: to.cy }, { x: to.x, y: to.cy }];
}

function routeDependency(from: NodeBox, to: NodeBox, layout: GraphLayout): Pt[] {
  const { colGap } = layout.metrics;
  const down = to.cy > from.cy ? 1 : -1;
  const entryY = to.cy - down * DEP_OFFSET;

  // Straight down the column: the two nodes are already aligned.
  if (from.node.col === to.node.col) {
    return down > 0
      ? [{ x: from.cx, y: from.y + from.h }, { x: to.cx, y: to.y }]
      : [{ x: from.cx, y: from.y }, { x: to.cx, y: to.y + to.h }];
  }

  if (to.node.col > from.node.col) {
    const exitY = from.cy + down * DEP_OFFSET;
    const gutter = to.x - colGap / 2 - 10;
    return [
      { x: from.x + from.w, y: exitY },
      { x: gutter, y: exitY },
      { x: gutter, y: entryY },
      { x: to.x, y: entryY },
    ];
  }

  // Backwards across the lanes: drop into the channel between two bands, run
  // back along it, then climb the column gutter in front of the target.
  const channel = layout.channelBelow(down > 0 ? from.node.row : from.node.row - 1);
  const gutter = to.x - colGap / 2 - 14;
  return [
    { x: from.cx, y: down > 0 ? from.y + from.h : from.y },
    { x: from.cx, y: channel },
    { x: gutter, y: channel },
    { x: gutter, y: entryY },
    { x: to.x, y: entryY },
  ];
}

function routeFeedback(from: NodeBox, to: NodeBox, layout: GraphLayout): Pt[] {
  const { colGap } = layout.metrics;

  // Returning to the spine — over the top of everything, into the target's head.
  if (to.node.laneId === null) {
    return [
      { x: from.cx, y: from.y },
      { x: from.cx, y: layout.topChannel },
      { x: to.cx, y: layout.topChannel },
      { x: to.cx, y: to.y },
    ];
  }

  // Returning into a lane — under the bottom of everything, back in from the left.
  const gutter = to.x - colGap / 2 - 26;
  const entryY = to.cy + FEEDBACK_OFFSET;
  return [
    { x: from.cx, y: from.y + from.h },
    { x: from.cx, y: layout.bottomChannel },
    { x: gutter, y: layout.bottomChannel },
    { x: gutter, y: entryY },
    { x: to.x, y: entryY },
  ];
}

function routeEdge(edge: GraphEdge, from: NodeBox, to: NodeBox, layout: GraphLayout): Pt[] {
  if (edge.kind === 'feedback') return routeFeedback(from, to, layout);
  if (edge.kind === 'dependency') return routeDependency(from, to, layout);
  return routeFlow(from, to, layout);
}

/* ----------------------------------------------------------------- labels */

interface EdgeLabel {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/**
 * A label goes on the longest straight run it actually fits on. When nothing
 * is long enough — a short hop between two spine cards — it is parked just
 * above the gap instead of masking a card.
 */
function labelFor(points: readonly Pt[], from: NodeBox, to: NodeBox, text: string): EdgeLabel {
  const width = text.length * LABEL_CHAR + LABEL_PAD;
  let bestH: { len: number; x: number; y: number } | null = null;
  let bestV: { len: number; x: number; y: number } | null = null;

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (Math.abs(a.y - b.y) < 0.5) {
      const len = Math.abs(a.x - b.x);
      if (!bestH || len > bestH.len) bestH = { len, x: (a.x + b.x) / 2, y: a.y };
    } else if (Math.abs(a.x - b.x) < 0.5) {
      const len = Math.abs(a.y - b.y);
      if (!bestV || len > bestV.len) bestV = { len, x: a.x, y: (a.y + b.y) / 2 };
    }
  }

  if (bestH && bestH.len >= width + 10) return { x: bestH.x, y: bestH.y, width };
  // A straight drop between two lanes: sit the label beside the run, on the
  // left, where the channel labels of neighbouring edges are not already.
  if (bestV && bestV.len >= LABEL_H + 12 && (!bestH || bestH.len < 24)) {
    return { x: bestV.x - width / 2 - 10, y: bestV.y, width };
  }

  const gapLeft = Math.min(from.x + from.w, to.x + to.w);
  const gapRight = Math.max(from.x, to.x);
  return { x: (gapLeft + gapRight) / 2, y: Math.min(from.y, to.y) - 14, width };
}

/* -------------------------------------------------------------- component */

export interface GraphEdgesProps {
  edges: readonly GraphEdge[];
  layout: GraphLayout;
  /** Edges touching the selected node. Emphasised; everything else steps back. */
  emphasised: ReadonlySet<string>;
  /** True while a node is selected, so unrelated edges can be dimmed. */
  hasSelection: boolean;
}

interface DrawnEdge {
  readonly edge: GraphEdge;
  readonly d: string;
  readonly label: EdgeLabel | null;
  readonly live: boolean;
}

export function GraphEdges({ edges, layout, emphasised, hasSelection }: GraphEdgesProps) {
  const drawn: DrawnEdge[] = [];

  for (const edge of edges) {
    const from = layout.byId.get(edge.from);
    const to = layout.byId.get(edge.to);
    if (!from || !to) continue;
    const points = routeEdge(edge, from, to, layout);
    drawn.push({
      edge,
      d: orthPath(points, CORNER),
      label: edge.label ? labelFor(points, from, to, edge.label) : null,
      // A return path is "live" only while one of its ends is actually working.
      live: edge.kind === 'feedback' && (from.node.status === 'running' || to.node.status === 'running'),
    });
  }

  return (
    <>
      <defs>
        {(['flow', 'dependency', 'feedback', 'emphasis'] as const).map((tone) => (
          <marker
            key={tone}
            id={`fw-graph-arrow-${tone}`}
            markerWidth={9}
            markerHeight={9}
            refX={8.5}
            refY={4.5}
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M 0.5 1 L 8.5 4.5 L 0.5 8 Z" className={`fw-graph__arrow fw-graph__arrow--${tone}`} />
          </marker>
        ))}
      </defs>

      <g className="fw-graph__edges">
        {drawn.map(({ edge, d, live }) => {
          const isEmphasised = emphasised.has(edge.id);
          const classes = ['fw-graph__edge', `fw-graph__edge--${edge.kind}`];
          if (isEmphasised) classes.push('is-emphasised');
          else if (hasSelection) classes.push('is-dimmed');
          if (live) classes.push('is-live');
          return (
            <path
              key={edge.id}
              className={classes.join(' ')}
              d={d}
              markerEnd={`url(#fw-graph-arrow-${isEmphasised ? 'emphasis' : edge.kind})`}
            />
          );
        })}
      </g>

      <g className="fw-graph__edge-labels">
        {drawn.map(({ edge, label }) => {
          if (!label || !edge.label) return null;
          const isEmphasised = emphasised.has(edge.id);
          const classes = ['fw-graph__edge-label', `fw-graph__edge-label--${edge.kind}`];
          if (isEmphasised) classes.push('is-emphasised');
          else if (hasSelection) classes.push('is-dimmed');
          return (
            <g key={`${edge.id}-label`} className={classes.join(' ')}>
              <rect
                className="fw-graph__edge-label-plate"
                x={round(label.x - label.width / 2)}
                y={round(label.y - LABEL_H / 2)}
                width={round(label.width)}
                height={LABEL_H}
                rx={4}
              />
              <text className="fw-graph__edge-label-text" x={round(label.x)} y={round(label.y)}>
                {edge.label}
              </text>
            </g>
          );
        })}
      </g>
    </>
  );
}
