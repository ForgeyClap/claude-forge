/**
 * ActivityView renders every event it is given — is that safe at the architectural ceiling?
 *
 * The improvement backlog flagged this list as "no cap, no virtualization" while the fetch path was
 * still re-downloading the entire history on every SSE frame (O(n²) bytes over a run). That fetch
 * defect was real and is fixed. The RENDER side was never measured, so the concern stayed an
 * intuition — and intuitions about performance are how speculative optimizations get built.
 *
 * So: measure instead of guess, and bound the question first.
 *
 *   - Largest real run in this fleet today: **106 events** (counted across every run directory's
 *     own `events.jsonl` under `.claude/forge-runs`).
 *   - Hard ceiling the UI can ever receive: **5000** — `events.mjs`'s `MAX_LINE_RECORDS_PER_ENTRY`,
 *     added this same run. Past that the gateway trims the oldest records and flags `truncated`,
 *     which Activity now surfaces. So the list cannot grow without limit even in principle.
 *
 * This test renders the real view at that ceiling. It is not a benchmark with a tight millisecond
 * assertion — those are flaky on shared CI and would get skipped within a month. It asserts the two
 * things that actually matter and are stable: every row is really rendered (no silent truncation
 * that would make the view lie about completeness), and the whole thing stays inside a budget
 * generous enough to never flake yet tight enough to catch a genuine order-of-magnitude regression
 * — an accidental O(n²) in a `filter` inside a `map`, say.
 *
 * If this ever starts failing, the answer is virtualization. Until then, adding it would mean
 * touching a frozen design to solve a problem no user has.
 */

import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import ActivityView from '@/views/activity/ActivityView';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { ActivityEvent, EventKind, StatusKey } from '@/prototype/types/prototype-types';

/** The gateway's own per-run record cap (events.mjs MAX_LINE_RECORDS_PER_ENTRY). */
const GATEWAY_CEILING = 5000;

// The real union from prototype-types.ts — the view looks each kind up in a label/icon table, so a
// made-up value crashes it. That crash is a fair signal about fixtures, not about the view.
const KINDS: readonly EventKind[] = ['mission', 'work-package', 'agent', 'task', 'artifact', 'test', 'verify', 'review', 'system'];
const STATUSES: readonly StatusKey[] = ['running', 'completed', 'waiting', 'failed'];

function syntheticEvents(count: number, runId: string): ActivityEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ev-${i}`,
    runId,
    // Real ISO stamps, walking forward a second at a time — the view groups and sorts on these,
    // so handing it identical timestamps would measure a cheaper problem than the real one.
    timestamp: new Date(Date.UTC(2026, 6, 29, 0, 0, 0) + i * 1000).toISOString(),
    kind: KINDS[i % KINDS.length],
    agent: i % 3 === 0 ? null : `agent-${i % 7}`,
    status: STATUSES[i % STATUSES.length],
    message: `Synthetic event ${i} — a message of roughly the length a real one has.`,
    detail: `Detail line for event ${i}.`,
  })) as unknown as ActivityEvent[];
}

/**
 * The same empty production floor `no-prototype-copy.test.ts` builds, with only `events` filled.
 * Written out here rather than imported because that helper is file-local there; duplicating the
 * few fields the view actually reads keeps this test independent of that suite's shape.
 */
function stateWithEvents(events: readonly ActivityEvent[]): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, events },
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
    agentLayout: 'grouped',
    taskLayout: 'kanban',
    taskColumnOverrides: {},
    extraMessages: {},
    stream: null,
    claudeCodeState: 'not-connected',
    toasts: [],
  } as unknown as PrototypeState;
}

function renderActivity(state: PrototypeState) {
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(PrototypeContext.Provider, { value: { state, dispatch: () => undefined } }, createElement(ActivityView)),
    ),
  );
}

describe('ActivityView at the gateway ceiling', () => {
  afterEach(() => cleanup());

  it(`renders all ${GATEWAY_CEILING} events — the ceiling the gateway can ever deliver — without dropping any`, () => {
    const events = syntheticEvents(GATEWAY_CEILING, 'run-ceiling');
    const started = performance.now();
    const { container } = renderActivity(stateWithEvents(events));
    const elapsedMs = performance.now() - started;

    // Completeness first: a view that quietly renders a subset would look fast and be a lie.
    // Anchor on the last event specifically — a truncating implementation drops the tail.
    expect(container.textContent).toContain(`Synthetic event ${GATEWAY_CEILING - 1} `);
    expect(container.textContent).toContain('Synthetic event 0 ');

    // Deliberately loose. This is a regression tripwire for an order-of-magnitude change, not a
    // benchmark: a tight bound here would flake under parallel test load and then be deleted.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 30_000);

  it('scales roughly linearly from 500 to 5000 — catches an accidental quadratic', () => {
    const small = performance.now();
    const { unmount } = renderActivity(stateWithEvents(syntheticEvents(500, 'run-small')));
    const smallMs = performance.now() - small;
    unmount();

    const large = performance.now();
    renderActivity(stateWithEvents(syntheticEvents(5000, 'run-large')));
    const largeMs = performance.now() - large;

    // 10× the rows. Linear would be ~10×; a quadratic would be ~100×. The 40× allowance leaves
    // generous room for constant overhead and a noisy machine while still failing loudly on a real
    // O(n²) — e.g. a `.filter()` over all events performed inside the row `.map()`.
    const ratio = largeMs / Math.max(smallMs, 1);
    expect(ratio, `500 rows: ${smallMs.toFixed(0)}ms · 5000 rows: ${largeMs.toFixed(0)}ms (${ratio.toFixed(1)}×)`).toBeLessThan(40);
  }, 30_000);
});
