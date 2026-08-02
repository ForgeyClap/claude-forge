/**
 * feat-agent-model-edit — the Agents tab's real per-agent `claudeTier`/`claudeEffort` editor.
 *
 * Stubs `globalThis.fetch` directly (no real network) — same seam
 * `gateway-actions.test.ts`/`gateway-connection-store.test.ts` already use. Three things are under
 * test: (1) the menu sends a real `PATCH /api/agents/:slug/model?project=...`, (2) after success
 * the UI shows the value read back from a REAL follow-up `GET /api/agents` (never the merely-picked
 * value optimistically), and (3) on failure a toast fires with the real reason and the old value
 * stays on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Agent, AgentGroup } from '@/prototype/types/prototype-types';
import AgentsView from '@/views/agents/AgentsView';

let seq = 0;

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
    runtimeModel: 'sonnet',
    toolModel: 'nvidia/test-model · tools',
    effort: 'medium',
    skills: [],
    lastActivity: '1 min ago',
    verification: null,
    summary: 'A summary sentence.',
    ...overrides,
  };
}

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, agents: [] },
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
    activeProjectId: 'demo-project',
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

/** Real `GET /api/agents` payload shape (`gateway/src/agents.mjs` field names). `tierNow` lets a
 *  test simulate the value changing ACROSS calls (before vs. after a real write), so a re-fetch is
 *  provably a NEW read, not the same cached response replayed. */
function agentsPayload(buildBossTier: string) {
  return {
    ok: true,
    agents: [
      { slug: 'build-boss', name: 'Build Boss', model_tier: buildBossTier, claude_effort: null, role: 'Implementation' },
      { slug: 'boss', name: 'Boss', model_tier: 'opus', claude_effort: 'high', role: 'Orchestration' },
    ],
  };
}

describe('AgentsView — real per-agent claudeTier/claudeEffort editing', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('a successful PATCH sends the real request, then shows the value re-read from a follow-up GET (never the merely-picked value)', async () => {
    let getCallCount = 0;
    const patchCalls: { url: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      // feat-live-visibility: AgentsView now ALSO mounts LiveAgentsStrip, which polls its own
      // unrelated `/api/agent-dispatches` endpoint — routed to a benign empty response here so it
      // never consumes one of THIS test's `/api/agents` call-count slots (mirrors
      // `sidebar-new-project.test.tsx`'s own "every other call gets a benign response" precedent).
      if (String(url).includes('/api/agent-dispatches')) return { ok: true, status: 200, json: async () => ({ ok: true, dispatches: [] }) };
      if (init?.method === 'PATCH') {
        patchCalls.push({ url, body: init.body != null ? JSON.parse(String(init.body)) : undefined });
        // The PATCH response itself claims 'opus' — but the assertion below only trusts the
        // SUBSEQUENT GET, proving the UI does not just parrot this response back.
        return { ok: true, status: 200, json: async () => ({ ok: true, model_tier: 'opus', claude_effort: null }) };
      }
      getCallCount += 1;
      const tierNow = getCallCount === 1 ? 'sonnet' : 'opus';
      return { ok: true, status: 200, json: async () => agentsPayload(tierNow) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const dispatched: PrototypeAction[] = [];
    const buildBoss = makeAgent('execution', { id: 'build-boss', name: 'Build Boss' });
    const { container } = renderAgentsView(buildState({ data: { ...EMPTY_DATASET, agents: [buildBoss] } }), dispatched);

    const row = await waitFor(() => {
      const el = container.querySelector('[data-agent-id="build-boss"]');
      if (!el) throw new Error('build-boss row not rendered yet');
      return el as HTMLElement;
    });

    // Initial real GET already resolved: the trigger shows the REAL current value ('sonnet').
    const trigger = await within(row).findByRole('button', { name: 'Change Runtime' });
    expect(trigger.textContent).toContain('sonnet');

    fireEvent.click(trigger);
    const option = await within(row).findByRole('menuitemradio', { name: /opus/i });
    fireEvent.click(option);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].url).toMatch(/\/api\/agents\/build-boss\/model\?project=demo-project$/);
    expect(patchCalls[0].body).toEqual({ claudeTier: 'opus' });

    // The trigger now shows 'opus' — but only once the SECOND real GET has resolved (getCallCount
    // reaches 2), never merely because the PATCH response said so.
    await waitFor(() => expect(getCallCount).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(trigger.textContent).toContain('opus'));
  });

  it('the Effort control only renders when this agent actually has a real claude_effort value', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => agentsPayload('sonnet') };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const dispatched: PrototypeAction[] = [];
    const buildBoss = makeAgent('execution', { id: 'build-boss', name: 'Build Boss' });
    const boss = makeAgent('control', { id: 'boss', name: 'Boss' });
    const { container } = renderAgentsView(
      buildState({ data: { ...EMPTY_DATASET, agents: [buildBoss, boss] } }),
      dispatched,
    );

    const buildBossRow = await waitFor(() => {
      const el = container.querySelector('[data-agent-id="build-boss"]');
      if (!el) throw new Error('build-boss row not rendered yet');
      return el as HTMLElement;
    });
    const bossRow = container.querySelector('[data-agent-id="boss"]') as HTMLElement;

    // build-boss has claude_effort: null in the fixture -> no Effort picker at all.
    await within(buildBossRow).findByRole('button', { name: 'Change Runtime' });
    expect(within(buildBossRow).queryByRole('button', { name: 'Change Effort' })).toBeNull();

    // boss has claude_effort: 'high' -> the Effort picker is real and shows it.
    const bossEffort = await within(bossRow).findByRole('button', { name: 'Change Effort' });
    expect(bossEffort.textContent).toContain('high');
  });

  it('on a failed PATCH, a toast fires with the real reason and the old value stays on screen', async () => {
    let getCallCount = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // feat-live-visibility: see the first test's own comment above for why this endpoint is
      // routed away from the `/api/agents` call-count logic below.
      if (String(_url).includes('/api/agent-dispatches')) return { ok: true, status: 200, json: async () => ({ ok: true, dispatches: [] }) };
      if (init?.method === 'PATCH') {
        return {
          ok: false,
          status: 400,
          json: async () => ({ ok: false, error: 'claudeTier must be one of the real values already in agent-model-map.json: haiku, opus, sonnet' }),
        };
      }
      getCallCount += 1;
      return { ok: true, status: 200, json: async () => agentsPayload('sonnet') };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const dispatched: PrototypeAction[] = [];
    const buildBoss = makeAgent('execution', { id: 'build-boss', name: 'Build Boss' });
    const { container } = renderAgentsView(buildState({ data: { ...EMPTY_DATASET, agents: [buildBoss] } }), dispatched);

    const row = await waitFor(() => {
      const el = container.querySelector('[data-agent-id="build-boss"]');
      if (!el) throw new Error('build-boss row not rendered yet');
      return el as HTMLElement;
    });

    const trigger = await within(row).findByRole('button', { name: 'Change Runtime' });
    expect(trigger.textContent).toContain('sonnet');

    fireEvent.click(trigger);
    const option = await within(row).findByRole('menuitemradio', { name: /opus/i });
    fireEvent.click(option);

    await waitFor(() =>
      expect(dispatched.some((a) => a.type === 'toast/push' && a.toast.title === 'Model change failed')).toBe(true),
    );
    const toastAction = dispatched.find((a) => a.type === 'toast/push') as Extract<PrototypeAction, { type: 'toast/push' }>;
    expect(toastAction.toast.detail).toMatch(/must be one of the real values/);

    // No second GET was ever triggered by the failed attempt, and the trigger still shows 'sonnet'.
    expect(getCallCount).toBe(1);
    expect(trigger.textContent).toContain('sonnet');
  });
});


/**
 * A row read for project A must never drive project B's editor after a switch.
 *
 * MEDIUM finding from the independent Codex review of dc8e30c (2026-07-30): rows are keyed by agent
 * SLUG alone, and every Forge project has the same slugs. The fetch effect also deliberately never
 * blanks the roster on a transient failure. So after switching projects, the picker kept showing —
 * and offered to edit — the PREVIOUS project's on-disk tier, indefinitely if the new project's fetch
 * failed. A wrong pick was still refused server-side by the new project's own allowlist, so nothing
 * incorrect was ever written; the defect was that the screen asserted a value that did not belong to
 * the project in view. Rows now carry the project they were read for.
 *
 * The assertion is on the EDITOR's presence, not on the text 'sonnet': `makeAgent` seeds
 * `runtimeModel: 'sonnet'` on the fixture agent itself, so that string legitimately appears in the
 * read-only line either way. What must not survive the switch is a picker fed by project A's data.
 */
describe('per-agent model rows are scoped to the project they were read for', () => {
  it('project A\'s row does not feed project B\'s editor when B\'s own fetch has not answered', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      // feat-live-visibility: AgentsView now ALSO mounts LiveAgentsStrip, an unrelated
      // `/api/agent-dispatches` poll — routed to a benign empty response so it never affects the
      // `/api/agents`-scoped call-count assertion below (mirrors the two tests above).
      if (String(url).includes('/api/agent-dispatches')) return { ok: true, status: 200, json: async () => ({ ok: true, dispatches: [] }) };
      if (String(url).includes('project=project-a')) {
        return { ok: true, status: 200, json: async () => agentsPayload('sonnet') };
      }
      // Project B: transient failure — exactly the window the finding is about.
      return { ok: false, status: 500, json: async () => ({ ok: false, error: 'transient' }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const dispatched: PrototypeAction[] = [];
    const buildBoss = makeAgent('execution', { id: 'build-boss', name: 'Build Boss' });
    const data = { ...EMPTY_DATASET, agents: [buildBoss] };

    const viewA = renderAgentsView(buildState({ activeProjectId: 'project-a', data }), dispatched);
    const rowA = await waitFor(() => {
      const el = viewA.container.querySelector('[data-agent-id="build-boss"]');
      if (!el) throw new Error('row not rendered yet');
      return el as HTMLElement;
    });
    // Project A really did answer: its editor exists and shows A's on-disk value.
    const triggerA = await within(rowA).findByRole('button', { name: 'Change Runtime' });
    expect(triggerA.textContent).toContain('sonnet');

    // Same MOUNTED component, new active project — this is what a real project switch does. An
    // unmount+remount would start from EMPTY_MODEL_STATE and pass even on the buggy code, which is
    // exactly how a first version of this test fooled itself (proven: it was green with the fix
    // stashed out).
    const valueB: StoreValue = { state: buildState({ activeProjectId: 'project-b', data }), dispatch: (a) => { dispatched.push(a); } };
    viewA.rerender(createElement(PrototypeContext.Provider, { value: valueB }, createElement(AgentsView)));
    const rowB = await waitFor(() => {
      const el = viewA.container.querySelector('[data-agent-id="build-boss"]');
      if (!el) throw new Error('row not rendered yet');
      return el as HTMLElement;
    });
    // Scoped to the `/api/agents` calls this test is actually about — LiveAgentsStrip's own
    // unrelated `/api/agent-dispatches` poll (routed to a benign response above) also fires once
    // per project and is deliberately excluded from this count.
    const agentsCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/agents') && !String(call[0]).includes('/api/agent-dispatches'));
    await waitFor(() => expect(agentsCalls()).toHaveLength(2));
    expect(
      within(rowB).queryByRole('button', { name: 'Change Runtime' }),
      "project B must not get an editor fed by project A's data",
    ).toBeNull();
  });
});

/* fix-modelpick-clip (2026-07-30): the picker panel rendered INSIDE `.fw-agents-model__val`, whose
 * base overflow:hidden (text truncation) clipped the whole open panel to the cell's 26px height —
 * present in the DOM with 4 options yet 100% invisible in the real browser (the owner's literal bug
 * report: "als ik op agents de model wil veranderen dan zie ik niks!"). jsdom cannot see clipping,
 * which is exactly why every earlier test here stayed green. What jsdom CAN pin down is the css
 * contract that makes the browser behavior right: the editable cell must carry the --editor
 * modifier (whose stylesheet rule lifts the clip), and the base cell must keep truncation. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('model picker is not clipped away by its own value cell', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('the editable value cell carries the --editor modifier so the open panel escapes the truncation clip', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/agent-dispatches')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, dispatches: [] }) };
      }
      return { ok: true, status: 200, json: async () => agentsPayload('sonnet') };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const dispatched: PrototypeAction[] = [];
    const buildBoss = makeAgent('execution', { id: 'build-boss', name: 'Build Boss' });
    // the clipped cell lives in the CARD layout (grid/grouped) — the list rows use meta-item spans
    // without overflow:hidden and were never affected (checked in agents.css).
    const { container } = renderAgentsView(
      buildState({ agentLayout: 'grid', data: { ...EMPTY_DATASET, agents: [buildBoss] } }),
      dispatched,
    );
    const row = await waitFor(() => {
      const el = container.querySelector('[data-agent-id="build-boss"]');
      if (!el) throw new Error('card not rendered yet');
      return el as HTMLElement;
    });
    const trigger = await within(row).findByRole('button', { name: 'Change Runtime' });
    const cell = trigger.closest('dd');
    expect(cell).not.toBeNull();
    expect(cell!.className).toContain('fw-agents-model__val--editor');
    // and the base class stays too — layout/sizing comes from it
    expect(cell!.className).toContain('fw-agents-model__val');
  });

  it('the stylesheet really lifts the clip for the editor cell (overflow: visible)', () => {
    const css = readFileSync(resolve(__dirname, '../../src/views/agents/agents.css'), 'utf8');
    const rule = css.split('.fw-agents-model__val--editor')[1] ?? '';
    expect(rule.slice(0, 200)).toMatch(/overflow:\s*visible/);
  });
});
