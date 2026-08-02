/**
 * Agents view — the "Nodes" mode (forge-2026-07-29-cc-finish, WP agents-nodes-view).
 *
 * Two things are under test, matching the work package's own split:
 *   1. `computeAgentGraphLayout` — a pure, DOM-free function. Positions/edges
 *      are derived only from the real `group` field the roster already
 *      carries (never an invented `reportsTo`), so these assertions pin the
 *      hierarchy-derivation contract as much as the arithmetic.
 *   2. The view switch itself — Nodes sits as a fourth, local-only option
 *      next to List/Grid/Grouped, honours the existing empty state, and a
 *      node click dispatches the exact same `select` action the other three
 *      layouts already use.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Agent, AgentGroup } from '@/prototype/types/prototype-types';
import AgentsView from '@/views/agents/AgentsView';
import { computeAgentGraphLayout, computeAgentTiers, AGENT_NODE_W } from '@/views/agents/agent-graph-layout';

/* ========================================================================== */
/*  1. computeAgentGraphLayout — pure layout/hierarchy tests                  */
/* ========================================================================== */

let seq = 0;

/** A minimal, fully-shaped `Agent` — every field the type requires, nothing invented beyond it. */
function makeAgent(group: AgentGroup, overrides: Partial<Agent> = {}): Agent {
  seq += 1;
  const id = overrides.id ?? `agent-${group}-${seq}`;
  return {
    prototype: true,
    id,
    name: overrides.name ?? id,
    role: 'A role sentence.',
    group,
    permission: 'standard',
    status: 'waiting',
    progress: 0,
    currentTask: null,
    runtimeModel: 'forge-runtime · medium effort',
    toolModel: 'nvidia/test-model · tools',
    effort: 'medium',
    skills: [],
    lastActivity: '1 min ago',
    verification: null,
    summary: 'A summary sentence.',
    ...overrides,
  };
}

describe('computeAgentTiers — splits the roster by the real group field only', () => {
  it('an empty roster yields three empty tiers', () => {
    const tiers = computeAgentTiers([]);
    expect(tiers.roots).toEqual([]);
    expect(tiers.coordinators).toEqual([]);
    expect(tiers.workers).toEqual([]);
  });

  it('control -> roots, planning -> coordinators, everything else -> workers', () => {
    const boss = makeAgent('control', { id: 'agent-boss' });
    const headChef = makeAgent('planning', { id: 'agent-head-chef' });
    const buildBoss = makeAgent('execution', { id: 'agent-build-boss' });
    const testBoss = makeAgent('review', { id: 'agent-test-boss' });

    const tiers = computeAgentTiers([boss, headChef, buildBoss, testBoss]);
    expect(tiers.roots.map((a) => a.id)).toEqual(['agent-boss']);
    expect(tiers.coordinators.map((a) => a.id)).toEqual(['agent-head-chef']);
    expect(tiers.workers.map((a) => a.id).sort()).toEqual(['agent-build-boss', 'agent-test-boss']);
  });
});

describe('computeAgentGraphLayout — an empty roster', () => {
  it('yields an empty layout with zero size, no crash', () => {
    const layout = computeAgentGraphLayout([]);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });
});

describe('computeAgentGraphLayout — the real three-tier shape (Boss -> Head Chef -> workers)', () => {
  const boss = makeAgent('control', { id: 'agent-boss', name: 'Boss' });
  const headChef = makeAgent('planning', { id: 'agent-head-chef', name: 'Head Chef' });
  const buildBoss = makeAgent('execution', { id: 'agent-build-boss', name: 'Build Boss' });
  const testBoss = makeAgent('review', { id: 'agent-test-boss', name: 'Test Boss' });
  const seoBoss = makeAgent('domain', { id: 'agent-seo-boss', name: 'SEO Boss' });

  const layout = computeAgentGraphLayout([seoBoss, testBoss, buildBoss, headChef, boss]);

  it('places every real agent exactly once, none invented, none dropped', () => {
    expect(layout.nodes).toHaveLength(5);
    expect(layout.byId.size).toBe(5);
    for (const agent of [boss, headChef, buildBoss, testBoss, seoBoss]) {
      expect(layout.byId.has(agent.id)).toBe(true);
    }
  });

  it('Boss sits at depth 0, Head Chef at depth 1, every worker at depth 2', () => {
    expect(layout.byId.get('agent-boss')?.depth).toBe(0);
    expect(layout.byId.get('agent-head-chef')?.depth).toBe(1);
    expect(layout.byId.get('agent-build-boss')?.depth).toBe(2);
    expect(layout.byId.get('agent-test-boss')?.depth).toBe(2);
    expect(layout.byId.get('agent-seo-boss')?.depth).toBe(2);
  });

  it('Boss is centred above Head Chef, and Head Chef sits strictly below Boss', () => {
    const bossNode = layout.byId.get('agent-boss')!;
    const headChefNode = layout.byId.get('agent-head-chef')!;
    expect(headChefNode.y).toBeGreaterThan(bossNode.y);
    expect(headChefNode.cx).toBeCloseTo(bossNode.cx, 5);
  });

  it('draws exactly one Boss -> Head Chef edge (kind "root") and one Head Chef -> worker edge per worker (kind "branch") — no invented relations', () => {
    const rootEdges = layout.edges.filter((e) => e.kind === 'root');
    const branchEdges = layout.edges.filter((e) => e.kind === 'branch');

    expect(rootEdges).toHaveLength(1);
    expect(rootEdges[0]).toMatchObject({ from: 'agent-boss', to: 'agent-head-chef' });

    expect(branchEdges).toHaveLength(3);
    expect(branchEdges.map((e) => e.to).sort()).toEqual(['agent-build-boss', 'agent-seo-boss', 'agent-test-boss']);
    for (const edge of branchEdges) expect(edge.from).toBe('agent-head-chef');

    expect(layout.edges).toHaveLength(4);
  });
});

describe('computeAgentGraphLayout — tiers missing from the roster degrade honestly', () => {
  it('no planning agent: workers report straight to Boss (root -> worker, kind "root")', () => {
    const boss = makeAgent('control', { id: 'agent-boss' });
    const worker = makeAgent('execution', { id: 'agent-worker' });
    const layout = computeAgentGraphLayout([boss, worker]);

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ from: 'agent-boss', to: 'agent-worker', kind: 'root' });
    expect(layout.byId.get('agent-boss')?.depth).toBe(0);
    expect(layout.byId.get('agent-worker')?.depth).toBe(1);
  });

  it('no control agent: Head Chef becomes the root instead of being left unparented', () => {
    const headChef = makeAgent('planning', { id: 'agent-head-chef' });
    const worker = makeAgent('execution', { id: 'agent-worker' });
    const layout = computeAgentGraphLayout([headChef, worker]);

    expect(layout.byId.get('agent-head-chef')?.depth).toBe(0);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ from: 'agent-head-chef', to: 'agent-worker' });
  });

  it('a single tier (only workers, no control or planning agent at all): every agent renders, zero edges', () => {
    const a = makeAgent('execution', { id: 'agent-a' });
    const b = makeAgent('review', { id: 'agent-b' });
    const layout = computeAgentGraphLayout([a, b]);

    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toEqual([]);
  });

  it('multiple control-group agents: only the first by id becomes the real parent (deterministic, not invented)', () => {
    const bossZ = makeAgent('control', { id: 'agent-z-boss' });
    const bossA = makeAgent('control', { id: 'agent-a-boss' });
    const headChef = makeAgent('planning', { id: 'agent-head-chef' });
    const layout = computeAgentGraphLayout([bossZ, bossA, headChef]);

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ from: 'agent-a-boss', to: 'agent-head-chef' });
  });
});

describe('computeAgentGraphLayout — a worker tier larger than one row wraps instead of stretching', () => {
  it('wraps a 6-worker tier into more than one row under the same depth', () => {
    const boss = makeAgent('control', { id: 'agent-boss' });
    const workers = Array.from({ length: 6 }, (_, i) => makeAgent('execution', { id: `agent-worker-${i}` }));
    const layout = computeAgentGraphLayout([boss, ...workers]);

    const workerNodes = layout.nodes.filter((n) => n.depth === 1);
    expect(workerNodes).toHaveLength(6);

    const distinctYs = new Set(workerNodes.map((n) => n.y));
    expect(distinctYs.size).toBeGreaterThan(1);

    // The whole tier still fits under a bounded width rather than growing linearly with the roster —
    // at most 4 node-widths wide (this module's own wrap threshold), not 6.
    expect(layout.width).toBeLessThan(6 * AGENT_NODE_W);
  });
});

/* ========================================================================== */
/*  2. The view switch — a fourth, local-only mode alongside list/grid/grouped */
/* ========================================================================== */

const BOSS = makeAgent('control', { id: 'agent-boss', name: 'Boss', status: 'running' });
const HEAD_CHEF = makeAgent('planning', { id: 'agent-head-chef', name: 'Head Chef', status: 'running' });
const BUILD_BOSS = makeAgent('execution', { id: 'agent-build-boss', name: 'Build Boss', status: 'waiting' });

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, agents: [BOSS, HEAD_CHEF, BUILD_BOSS] },
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: false,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: '',
    activeConversationId: '',
    selection: { kind: 'none' },
    pinnedProjectIds: [],
    projectQuery: '',
    agentFilter: 'all',
    agentLayout: 'list',
    taskLayout: 'kanban',
    taskColumnOverrides: {},
    extraMessages: {},
    stream: null,
    claudeCodeState: 'not-connected',
    toasts: [],
    ...overrides,
  };
}

function renderAgentsView(state: PrototypeState, dispatched: PrototypeAction[]) {
  const value: StoreValue = {
    state,
    dispatch: (action) => {
      dispatched.push(action);
    },
  };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(AgentsView)));
}

function clickSegment(container: HTMLElement, name: RegExp) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((el) =>
    name.test(el.textContent ?? ''),
  );
  if (!button) throw new Error(`No segmented option matching ${name}`);
  fireEvent.click(button);
}

describe('AgentsView — the Nodes view mode', () => {
  afterEach(() => cleanup());

  it('defaults to the persisted layout (list), not Nodes', () => {
    const { container } = renderAgentsView(buildState(), []);
    expect(container.querySelector('.fw-agents-list')).toBeTruthy();
    expect(container.querySelector('.fw-agents-graph')).toBeNull();
  });

  it('switching to Nodes renders one graph node per visible agent, and does not touch the persisted layout', () => {
    const dispatched: PrototypeAction[] = [];
    const { container } = renderAgentsView(buildState(), dispatched);

    clickSegment(container, /^Nodes$/);

    expect(container.querySelector('.fw-agents-graph')).toBeTruthy();
    expect(container.querySelectorAll('[data-fw-agents-node]')).toHaveLength(3);
    // Selecting "Nodes" is local-only — it must never dispatch `agents/layout`.
    expect(dispatched.some((a) => a.type === 'agents/layout')).toBe(false);
  });

  it('clicking a node dispatches the exact same select action the other layouts use', () => {
    const dispatched: PrototypeAction[] = [];
    const { container } = renderAgentsView(buildState(), dispatched);

    clickSegment(container, /^Nodes$/);
    const node = container.querySelector<HTMLButtonElement>('[data-fw-agents-node="agent-build-boss"]');
    expect(node).toBeTruthy();
    fireEvent.click(node!);

    expect(dispatched).toContainEqual({ type: 'select', selection: { kind: 'agent', id: 'agent-build-boss' } });
  });

  it('switching back to List from Nodes restores the list layout and dispatches agents/layout: list', () => {
    const dispatched: PrototypeAction[] = [];
    const { container } = renderAgentsView(buildState(), dispatched);

    clickSegment(container, /^Nodes$/);
    expect(container.querySelector('.fw-agents-graph')).toBeTruthy();

    clickSegment(container, /^List$/);
    expect(container.querySelector('.fw-agents-graph')).toBeNull();
    expect(container.querySelector('.fw-agents-list')).toBeTruthy();
    expect(dispatched).toContainEqual({ type: 'agents/layout', layout: 'list' });
  });

  it('with no agents at all, Nodes shows the existing empty state, never an empty graph canvas', () => {
    const dispatched: PrototypeAction[] = [];
    const emptyState = buildState({ data: { ...EMPTY_DATASET, agents: [] } });
    const { container, getByText } = renderAgentsView(emptyState, dispatched);

    clickSegment(container, /^Nodes$/);

    expect(container.querySelector('.fw-agents-graph')).toBeNull();
    expect(getByText('No agents in this state')).toBeTruthy();
  });
});
