/**
 * F2 (forge-2026-07-29-cc-finish, WP fix-cert-claims) — the artifact preview
 * pane must not claim a stored screenshot/diagram record has no file behind
 * it. `gateway-adapter.ts`'s `toGatewayArtifact` reports a real,
 * server-`stat()`'d `size_bytes` for these rows (rendered a few lines above
 * this pane's capture note, in the SIZE field and this figure's own
 * caption), so "no image file exists behind this record" was demonstrably
 * false for any real, agent-produced screenshot/diagram.
 *
 * build-lastdemos (same run) closed the download half of that gap for real
 * (`GET /api/artifacts/:id/content` now exists — see
 * `artifacts-download.test.tsx`), which made the ORIGINAL fix-cert-claims
 * wording ("No artifact-content endpoint exists yet") stale in turn — this
 * suite is updated in step to assert the current, narrower claim (the frame
 * still does not render the image INLINE, which remains true) rather than
 * leave a now-false "no endpoint" sentence locked in as required text. This
 * suite locks in the corrected, capability-scoped wording and guards against
 * the old false claims (and the bare word "placeholder") ever coming back.
 *
 * `FORBIDDEN_PATTERNS` is intentionally re-declared narrowly here rather than
 * imported from `no-prototype-copy.test.ts` — importing one vitest test file
 * from another would re-register that file's own `describe`/`it` blocks a
 * second time (see `recovery-approvals-panels.test.tsx`'s header for the
 * same precedent).
 *
 * Renders `ArtifactsView` directly against a hand-built `PrototypeState` (the
 * same real, production-shaped state shape `no-prototype-copy.test.ts` uses)
 * with one real-shaped screenshot artifact selected — no gateway/network
 * involved, `ArtifactsView` reads only `state.data.artifacts` + `dispatch`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Artifact, ArtifactKind } from '@/prototype/types/prototype-types';

import ArtifactsView from '@/views/artifacts/ArtifactsView';

/* ========================================================================== */
/*  Forbidden vocabulary — narrow local copy, see file header                 */
/* ========================================================================== */

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bexample\b/i,
  /\bprototype\b/i,
  /\bplaceholder\b/i,
  /\bnot connected\b/i,
  /\bno backend\b/i,
  /\bnothing was generated\b/i,
  /\bsimulated\b/i,
];

function scanForbidden(container: HTMLElement): string[] {
  const text = container.textContent ?? '';
  return FORBIDDEN_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

/* ========================================================================== */
/*  Harness — a real, empty production floor plus one real-shaped artifact    */
/* ========================================================================== */

function buildState(artifact: Artifact): PrototypeState {
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
    activeProjectId: '',
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

/** A real-shaped record — the same fields `gateway-adapter.ts`'s
 *  `toGatewayArtifact` produces from a real artifact-store row, including a
 *  genuine, `stat()`'d byte size (never a fabricated one). */
function buildArtifact(kind: ArtifactKind): Artifact {
  return {
    id: `artifact-${kind}`,
    name: `owner-dashboard-${kind}.png`,
    kind,
    producedBy: 'Build Boss',
    taskId: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    size: '482 KB',
    preview: '1440x900 capture of the owner dashboard, dark theme.',
    prototype: true,
  } as Artifact;
}

function renderSelected(kind: ArtifactKind) {
  const artifact = buildArtifact(kind);
  const value: StoreValue = { state: buildState(artifact), dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(ArtifactsView)));
}

/* ========================================================================== */
/*  Tests                                                                     */
/* ========================================================================== */

describe('F2 — the capture-frame note never claims a real artifact has no file', () => {
  afterEach(() => cleanup());

  it.each<ArtifactKind>(['screenshot', 'diagram'])(
    'renders the honest capability-gap note for a %s artifact, not the old false claim',
    (kind) => {
      const { container } = renderSelected(kind);
      const text = container.textContent ?? '';

      // The corrected, capability-scoped wording (updated by build-lastdemos once the download
      // endpoint made the ORIGINAL "no endpoint exists yet" sentence stale).
      expect(text).toContain('This capture is not rendered inline here yet');
      expect(text).toContain('use Download below to fetch the real file');

      // The old, demonstrably false claims must never reappear.
      expect(text).not.toMatch(/no image file exists/i);
      expect(text).not.toMatch(/no artifact-content endpoint exists/i);
      expect(text).not.toMatch(/\bplaceholder\b/i);

      // The real, `stat()`'d size and the recorded preview stay visible —
      // the fix narrows the claim, it does not hide the real evidence.
      expect(text).toContain('482 KB');
      expect(text).toContain('1440x900 capture of the owner dashboard, dark theme.');

      expect(scanForbidden(container)).toEqual([]);
    },
  );
});
