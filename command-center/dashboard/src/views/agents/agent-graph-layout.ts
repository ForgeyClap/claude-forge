/**
 * Agents view — Nodes graph layout.
 *
 * A pure, DOM-free function: turns the real, already-filtered agent roster
 * into node positions and reporting-line edges. No pan/zoom/interaction lives
 * here (see `useAgentNodesViewport.ts`) — everything below is deterministic
 * arithmetic, safe to unit test with plain object/array assertions.
 *
 * Hierarchy derivation — honest, not invented:
 * This app's real `Agent` shape (fixture AND gateway-backed production alike,
 * see `AgentsView.tsx`'s own header) carries no `reportsTo` id anywhere —
 * neither `Agent` in `prototype-types.ts` nor this project's own
 * `agent-registry.json` records one. Inventing a per-agent parent id would be
 * exactly the fabricated relation the work package forbids. The ONE real
 * relation this roster's data actually encodes is `AgentGroup`: `'control'`
 * is Boss (the mission owner), `'planning'` is Head Chef (the work-package
 * planner) — both real, singular roles in this project's own permanent agent
 * registry — and every other group is an executing agent underneath them.
 * That is the whole tree: control -> planning -> everyone else.
 *
 * A roster missing a tier degrades honestly rather than dropping agents: if
 * there is no control-group agent, the planning tier (or the workers, if
 * planning is missing too) becomes the root instead of being left unparented.
 * Multiple agents in the same tier (there is normally exactly one Boss and
 * one Head Chef, but nothing enforces that at the type level) attach to the
 * first parent by id — deterministic, not arbitrary array order.
 */

import type { Agent } from '@/prototype/types/prototype-types';

/** Node box size. Fixed constants, not CSS tokens — keeps this module DOM-free and its output exact. */
export const AGENT_NODE_W = 176;
export const AGENT_NODE_H = 76;

const COL_GAP = 28;
/** Vertical gap between tiers (control -> planning -> workers). */
const TIER_GAP = 108;
/** Vertical gap between wrapped rows within the SAME tier. */
const ROW_GAP = 20;
const PAD_X = 40;
const PAD_Y = 40;
/** Caps how wide a single tier grows before wrapping to a new row underneath it. */
const MAX_TIER_COLS = 4;

export interface AgentGraphNode {
  readonly agent: Agent;
  /** 0 = root tier, 1 = next tier down, etc. Purely for styling (e.g. a heavier root border). */
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly cx: number;
  readonly cy: number;
}

export type AgentGraphEdgeKind = 'root' | 'branch';

export interface AgentGraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** 'root' = tier0 -> tier1 (Boss -> Head Chef, or Boss -> workers when there is no Head Chef).
   *  'branch' = tier1 -> tier2 (Head Chef -> the executing agents). Styling-only distinction —
   *  monochrome, carried by stroke weight, never colour. */
  readonly kind: AgentGraphEdgeKind;
}

export interface AgentGraphLayout {
  readonly nodes: readonly AgentGraphNode[];
  readonly edges: readonly AgentGraphEdge[];
  readonly byId: ReadonlyMap<string, AgentGraphNode>;
  readonly width: number;
  readonly height: number;
}

const EMPTY_LAYOUT: AgentGraphLayout = {
  nodes: [],
  edges: [],
  byId: new Map(),
  width: 0,
  height: 0,
};

/** Stable ordering for deterministic parent/tie-break choices — id, ascending. */
function sortedById(agents: readonly Agent[]): Agent[] {
  return [...agents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Splits the roster into the three real tiers this app's `group` field encodes. */
export function computeAgentTiers(agents: readonly Agent[]): {
  roots: Agent[];
  coordinators: Agent[];
  workers: Agent[];
} {
  return {
    roots: sortedById(agents.filter((agent) => agent.group === 'control')),
    coordinators: sortedById(agents.filter((agent) => agent.group === 'planning')),
    workers: sortedById(agents.filter((agent) => agent.group !== 'control' && agent.group !== 'planning')),
  };
}

interface TierBlock {
  readonly nodes: AgentGraphNode[];
  readonly width: number;
  readonly height: number;
}

/**
 * Lays out one tier's agents, wrapped into rows of at most `MAX_TIER_COLS` so
 * a large roster reads as a neat block instead of one very wide line. Returns
 * positions relative to the tier's own (0,0) origin — the caller re-offsets
 * every node once the tallest/widest tier is known, so every tier ends up
 * centred on the same vertical axis.
 */
function layoutTier(agents: readonly Agent[], depth: number): TierBlock {
  if (agents.length === 0) return { nodes: [], width: 0, height: 0 };

  const cols = Math.min(agents.length, MAX_TIER_COLS);
  const rows = Math.ceil(agents.length / cols);
  const blockWidth = cols * AGENT_NODE_W + (cols - 1) * COL_GAP;

  const nodes: AgentGraphNode[] = agents.map((agent, index) => {
    const rowIndex = Math.floor(index / cols);
    const itemsInRow = Math.min(cols, agents.length - rowIndex * cols);
    const rowWidth = itemsInRow * AGENT_NODE_W + (itemsInRow - 1) * COL_GAP;
    const colIndex = index % cols;
    const x = (blockWidth - rowWidth) / 2 + colIndex * (AGENT_NODE_W + COL_GAP);
    const y = rowIndex * (AGENT_NODE_H + ROW_GAP);
    return {
      agent,
      depth,
      x,
      y,
      w: AGENT_NODE_W,
      h: AGENT_NODE_H,
      cx: x + AGENT_NODE_W / 2,
      cy: y + AGENT_NODE_H / 2,
    };
  });

  const height = rows * AGENT_NODE_H + (rows - 1) * ROW_GAP;
  return { nodes, width: blockWidth, height };
}

/** Real reporting edges: every child in `childTier` reports to the first (by id) agent in `parentTier`. */
function edgesBetween(parentTier: readonly Agent[], childTier: readonly Agent[], kind: AgentGraphEdgeKind): AgentGraphEdge[] {
  const parent = parentTier[0];
  if (!parent) return [];
  return childTier.map((child) => ({ id: `${parent.id}->${child.id}`, from: parent.id, to: child.id, kind }));
}

export function computeAgentGraphLayout(agents: readonly Agent[]): AgentGraphLayout {
  if (agents.length === 0) return EMPTY_LAYOUT;

  const { roots, coordinators, workers } = computeAgentTiers(agents);

  // Missing tiers degrade honestly: the next non-empty tier becomes the root
  // rather than leaving agents unparented. `agentTiers` (plural) below always
  // holds the real Agent groups in top-to-bottom order, never an invented one.
  const agentTiers: Agent[][] = [roots, coordinators, workers].filter((tier) => tier.length > 0);
  // Every real `AgentGroup` falls into one of the three tiers above, so this
  // is unreachable in practice — kept as an honest fallback, never a throw.
  if (agentTiers.length === 0) agentTiers.push(sortedById(agents));

  const blocks = agentTiers.map((tier, depth) => layoutTier(tier, depth));
  const maxWidth = Math.max(...blocks.map((block) => block.width));

  const nodes: AgentGraphNode[] = [];
  let yCursor = PAD_Y;
  blocks.forEach((block) => {
    const xOffset = PAD_X + (maxWidth - block.width) / 2;
    for (const node of block.nodes) {
      nodes.push({ ...node, x: node.x + xOffset, y: node.y + yCursor, cx: node.cx + xOffset, cy: node.cy + yCursor });
    }
    yCursor += block.height + TIER_GAP;
  });

  const byId = new Map(nodes.map((node) => [node.agent.id, node]));

  const edges: AgentGraphEdge[] = [
    ...edgesBetween(agentTiers[0], agentTiers[1] ?? [], 'root'),
    ...edgesBetween(agentTiers[1] ?? [], agentTiers[2] ?? [], 'branch'),
  ];

  const height = yCursor - TIER_GAP + PAD_Y;
  const width = PAD_X * 2 + maxWidth;

  return { nodes, edges, byId, width, height };
}
