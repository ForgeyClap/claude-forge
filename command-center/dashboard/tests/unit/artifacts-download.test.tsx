/**
 * ArtifactsView "Download" — build-lastdemos.
 *
 * Locks in the real flow: once an active project is known, the Download
 * control is a real anchor to the new `GET /api/artifacts/:id/content` gateway
 * route (encoded id + project), carries a `download` hint, and is no longer a
 * disabled dead button. Without an active project (an edge case only the test
 * harness can reach — production always has one whenever artifacts are shown)
 * it stays honestly disabled rather than linking to a route that would 404.
 *
 * Mirrors `artifact-capture-frame-honesty.test.tsx`'s harness shape (a
 * hand-built, production-shaped `PrototypeState` with one artifact selected —
 * no gateway/network involved).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Artifact } from '@/prototype/types/prototype-types';
import { GATEWAY_ORIGIN } from '@/prototype/state/gateway-client';

import ArtifactsView from '@/views/artifacts/ArtifactsView';

function buildArtifact(): Artifact {
  return {
    id: 'wp0-health-report.md',
    name: 'wp0-health-report.md',
    kind: 'report',
    producedBy: 'Build Boss',
    taskId: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    size: '4.1 KB',
    preview: 'WP0 health summary.',
    prototype: true,
  } as Artifact;
}

/** feat-chatruns-tabs: a real chat-run-derived artifact — `producedBy` carries the real
 *  `chat-<conversationId>-<turnId>` id `toGatewayChatRunArtifacts` (`gateway-adapter.ts`) stamps
 *  on every row it builds; there is no matching `GET /api/artifacts/:id/content` entry for it. */
function buildChatRunArtifact(): Artifact {
  return {
    id: 'chat-c-abc123-t-xyz789-file-0',
    name: '/proj/index.html',
    kind: 'log',
    producedBy: 'chat-c-abc123-t-xyz789',
    taskId: null,
    createdAt: '2026-07-30T09:04:00.000Z',
    size: '',
    preview: 'Write · /proj/index.html',
    prototype: true,
  } as Artifact;
}

function buildState(artifact: Artifact, activeProjectId: string): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, artifacts: [artifact] },
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
    activeProjectId,
    activeConversationId: '',
    selection: { kind: 'artifact', id: artifact.id },
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
  };
}

function renderSelected(activeProjectId: string) {
  const artifact = buildArtifact();
  const value: StoreValue = { state: buildState(artifact, activeProjectId), dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(ArtifactsView)));
}

function renderSelectedArtifact(artifact: Artifact, activeProjectId: string) {
  const value: StoreValue = { state: buildState(artifact, activeProjectId), dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(ArtifactsView)));
}

describe('ArtifactsView — real Download control', () => {
  afterEach(() => cleanup());

  it('renders a real anchor to GET /api/artifacts/:id/content with the encoded id and active project', () => {
    const { container } = renderSelected('demo-project');
    const link = container.querySelector('a.fw-button') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe(
      `${GATEWAY_ORIGIN}/api/artifacts/${encodeURIComponent('wp0-health-report.md')}/content?project=${encodeURIComponent('demo-project')}`,
    );
    expect(link?.getAttribute('download')).toBe('wp0-health-report.md');
    expect(link?.textContent).toContain('Download');
  });

  it('falls back to an honest disabled button when no active project is known', () => {
    const { container } = renderSelected('');
    const link = container.querySelector('a.fw-button');
    expect(link).toBeNull();
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Download'));
    expect(button).toBeDefined();
    expect(button).toBeDisabled();
    expect(button?.title).toMatch(/active project/i);
  });

  it('never claims the old "no endpoint" fabrication now that the route is real', () => {
    const { container } = renderSelected('demo-project');
    expect(container.textContent).not.toMatch(/no artifact-content endpoint exists/i);
  });

  it('feat-chatruns-tabs: a chat-run-derived artifact gets an honestly-disabled Download, even with an active project (no matching content route exists)', () => {
    const { container } = renderSelectedArtifact(buildChatRunArtifact(), 'littlebazzar');
    const link = container.querySelector('a.fw-button');
    expect(link).toBeNull();
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Download'));
    expect(button).toBeDefined();
    expect(button).toBeDisabled();
    expect(button?.title).toMatch(/dashboard chat run/i);
  });
});
