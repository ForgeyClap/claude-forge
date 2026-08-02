/**
 * LiveAgentsStrip — feat-live-visibility (Gap B). Two distinct honest empty states (no registry
 * vs. registry-but-no-dispatch), grouped chips with a real running count, and the "cannot
 * distinguish" honesty note are all asserted against a stubbed `fetch`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { LiveAgentsStrip } from '@/views/agents/LiveAgentsStrip';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function dispatchesResponse(dispatches: readonly Record<string, unknown>[]): Response {
  return { ok: true, status: 200, json: async () => ({ ok: true, dispatches }) } as Response;
}

describe('LiveAgentsStrip', () => {
  it('no agent registry at all: one plain honest line, never an empty box', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => dispatchesResponse([])));
    render(createElement(LiveAgentsStrip, { agentCount: 0, projectId: 'demo-project' }));

    // The dispatch poll still runs underneath (hooks are unconditional) even though this branch
    // never reads its result — `findByText` waits for it to settle so React never warns about a
    // post-assert state update.
    expect(await screen.findByText('No Forge agent registry found for this project.')).toBeInTheDocument();
  });

  it('a registry exists but nothing has ever been dispatched: a distinct, different honest line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => dispatchesResponse([])));
    render(createElement(LiveAgentsStrip, { agentCount: 5, projectId: 'demo-project' }));

    await waitFor(() =>
      expect(screen.getByText("No subagent dispatch recorded yet for this project’s conversations.")).toBeInTheDocument(),
    );
  });

  it('real dispatches are grouped by subagent type with a real total count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        dispatchesResponse([
          { subagent_type: 'Explore', conversation_id: 'c-1', description: null, started_at: null, running: false, resolved_status: 'completed', ended_at: null },
          { subagent_type: 'Explore', conversation_id: 'c-2', description: null, started_at: null, running: false, resolved_status: 'completed', ended_at: null },
          { subagent_type: 'Plan', conversation_id: 'c-3', description: null, started_at: null, running: false, resolved_status: 'completed', ended_at: null },
        ]),
      ),
    );
    render(createElement(LiveAgentsStrip, { agentCount: 5, projectId: 'demo-project' }));

    const exploreChip = await screen.findByTitle(/Explore: 2 dispatches recorded/);
    expect(exploreChip).toBeInTheDocument();
    expect(screen.getByTitle(/Plan: 1 dispatch recorded/)).toBeInTheDocument();
  });

  it('a genuinely RUNNING dispatch is labelled distinctly from a merely dispatched one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        dispatchesResponse([
          { subagent_type: 'Explore', conversation_id: 'c-1', description: null, started_at: null, running: true, resolved_status: null, ended_at: null },
        ]),
      ),
    );
    render(createElement(LiveAgentsStrip, { agentCount: 5, projectId: 'demo-project' }));

    const chip = await screen.findByTitle(/running right now/);
    expect(chip).toHaveAttribute('data-live', 'running');
  });

  it('when nothing is currently running, the honest note says so plainly rather than implying live-ness', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        dispatchesResponse([
          { subagent_type: 'Explore', conversation_id: 'c-1', description: null, started_at: null, running: false, resolved_status: 'completed', ended_at: null },
        ]),
      ),
    );
    render(createElement(LiveAgentsStrip, { agentCount: 5, projectId: 'demo-project' }));

    await waitFor(() => expect(screen.getByText(/None of these are currently running/)).toBeInTheDocument());
  });
});

/* ---------------------------------------------------------------------------------------------
 * MEASURED in a real browser against a real run (coordinator, 2026-07-30): the `agentCount === 0`
 * branch used to come FIRST, so a project without a Forge agent registry showed "No Forge agent
 * registry found for this project." while `GET /api/agent-dispatches` was returning a genuine
 * Explore dispatch for that very project. That is the owner's original complaint ("ik zie ook niks
 * als agents die runnen") reproduced by the strip built to fix it. Real dispatches must always win.
 * ------------------------------------------------------------------------------------------- */
describe('LiveAgentsStrip — a real dispatch is never hidden behind the "no registry" line', () => {
  const REAL_DISPATCH = {
    subagent_type: 'Explore',
    conversation_id: 'c-ms7jefn3-9dc63909',
    description: 'Count .md files in project directory',
    started_at: '2026-07-30T13:16:15.601Z',
    running: false,
    resolved_status: 'completed',
    ended_at: '2026-07-30T13:16:20.319Z',
  };

  it('shows the real subagent even when the project has NO Forge agent registry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => dispatchesResponse([REAL_DISPATCH])));
    render(createElement(LiveAgentsStrip, { agentCount: 0, projectId: 'dashboard-selftest' }));

    expect(await screen.findByText('Explore')).toBeInTheDocument();
    // and the registry fact is still stated — as a note beside the real data, never instead of it
    expect(screen.queryByText('No Forge agent registry found for this project.')).toBeNull();
    await waitFor(() =>
      expect(screen.getByText(/no Forge agent registry, so the roster below is empty/i)).toBeInTheDocument(),
    );
  });

  it('still shows the "no registry" line when there is genuinely nothing dispatched either', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => dispatchesResponse([])));
    render(createElement(LiveAgentsStrip, { agentCount: 0, projectId: 'dashboard-selftest' }));
    expect(await screen.findByText('No Forge agent registry found for this project.')).toBeInTheDocument();
  });
});
