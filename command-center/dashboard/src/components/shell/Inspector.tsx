/**
 * Inspector — the right-hand detail panel.
 *
 * It describes exactly one thing: `state.selection`. Every selection kind gets
 * its own body, built from the example dataset through the store selectors.
 *
 * Three rules run through this file:
 *   1. Progressive disclosure. A header, then the identifying fields, then
 *      collapsible sections for the long material (output, proof, diffs).
 *      Nothing is dumped flat.
 *   2. Provenance. Ids, paths, models, timestamps, commands and console output
 *      wear <Machine>; prose written by a person stays in the sans face.
 *   3. Honesty. Every record here is local example data. The footer says so,
 *      and simulated evidence carries an <ExampleTag/> next to it.
 *
 * Nothing in this panel reads a file, runs a command or contacts anything.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) UPDATE — this file was 1077 lines, over
 * the project's own 500-line-per-file guidance, mixing the shared presentational atoms
 * (`Fields`/`Section`/`Chips`/`Prose`/`Excerpt`/`Console`/`LinkRow`/`Diff`), eleven per-selection-
 * kind detail builders, and the actual `<Inspector/>` component (drag-to-dismiss, header, body,
 * footer) together. Pure structural split, ZERO behavior change: the shared atoms/types now live
 * in `./inspector-shared.tsx`, and each `Selection['kind']` gets its own builder in its own
 * sibling file — `inspector-empty-panel.tsx` (`none`), `inspector-project-panel.tsx`,
 * `inspector-conversation-panel.tsx`, `inspector-agent-panel.tsx`, `inspector-task-panel.tsx`,
 * `inspector-graph-panel.tsx` (`graph-node`), `inspector-artifact-panel.tsx`,
 * `inspector-quality-panel.tsx` (`gate` + `proof` together — the same pairing `TestsView.tsx`'s
 * own header already uses: "the quality-gate board and the proof ledger"), `inspector-file-panel.tsx`,
 * `inspector-event-panel.tsx`. Every builder keeps its exact original body, comments included
 * verbatim; the only change a module split forces is mechanical: what used to be a closure read
 * (`state`, the switch-narrowed `selection`, `select`, `production`) is now an explicit parameter,
 * and only where each builder actually reads it (see each sibling's own header for a per-file
 * note; not every builder needs `select` or `production`). `buildDetail` below is now a thin
 * dispatch switch over those eleven builders; this file itself keeps being the composer — the
 * `<Inspector/>` component, its drag-to-dismiss handling and its header/body/footer render are
 * unchanged and stay here. Every name this file exported before (`Inspector`, the default export)
 * is unchanged, so no other file in the codebase needed to change a single import.
 */

import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Button, EmptyState, ExampleTag, Eyebrow, IconButton, StatusBadge } from '@/components/primitives';
import { isProductionMode } from '@/config/mode';
import { usePrototype } from '@/prototype/state/prototype-store';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { KIND_LABEL } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';
import { buildNoneDetail } from './inspector-empty-panel';
import { buildProjectDetail } from './inspector-project-panel';
import { buildConversationDetail } from './inspector-conversation-panel';
import { buildAgentDetail } from './inspector-agent-panel';
import { buildTaskDetail } from './inspector-task-panel';
import { buildGraphNodeDetail } from './inspector-graph-panel';
import { buildArtifactDetail } from './inspector-artifact-panel';
import { buildGateDetail, buildProofDetail } from './inspector-quality-panel';
import { buildFileDetail } from './inspector-file-panel';
import { buildEventDetail } from './inspector-event-panel';
import './inspector.css';

/**
 * Builds the panel body for the current selection.
 * Returns null when the selection points at an id the example dataset does not
 * contain — which the caller renders as a plain "not in this dataset" state.
 */
function buildDetail(state: PrototypeState, select: SelectFn): Detail | null {
  const { selection } = state;
  // In production every record here is real (folded from the bridge); in fixtures
  // it is example data. The copy that names its provenance follows this flag.
  const production = isProductionMode();

  switch (selection.kind) {
    case 'none':
      return buildNoneDetail(state, select);
    case 'project':
      return buildProjectDetail(state, selection, select);
    case 'conversation':
      return buildConversationDetail(state, selection, production);
    case 'agent':
      return buildAgentDetail(state, selection, select, production);
    case 'task':
      return buildTaskDetail(state, selection, select, production);
    case 'graph-node':
      return buildGraphNodeDetail(state, selection, select);
    case 'artifact':
      return buildArtifactDetail(state, selection, select, production);
    case 'gate':
      return buildGateDetail(state, selection);
    case 'proof':
      return buildProofDetail(state, selection, select, production);
    case 'file':
      return buildFileDetail(state, selection, select, production);
    case 'event':
      return buildEventDetail(state, selection, select);
    default:
      return null;
  }
}

/* -------------------------------------------------------------- component */

const DISMISS_DISTANCE = 96;

export function Inspector() {
  const { state, dispatch } = usePrototype();
  const [dragY, setDragY] = useState(0);
  const dragging = useRef(false);
  const startY = useRef(0);
  const moved = useRef(false);

  const select = useCallback(
    (selection: Selection) => dispatch({ type: 'select', selection }),
    [dispatch],
  );

  const close = useCallback(() => dispatch({ type: 'inspector/set', open: false }), [dispatch]);

  function onHandleDown(event: ReactPointerEvent<HTMLButtonElement>) {
    dragging.current = true;
    moved.current = false;
    startY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onHandleMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!dragging.current) return;
    const delta = Math.max(0, event.clientY - startY.current);
    if (delta > 4) moved.current = true;
    setDragY(delta);
  }

  function onHandleUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const delta = Math.max(0, event.clientY - startY.current);
    setDragY(0);
    if (delta > DISMISS_DISTANCE) close();
  }

  if (!state.inspectorOpen) return null;

  const detail = buildDetail(state, select);
  const production = isProductionMode();
  const kind = state.selection.kind;
  /*
   * Keying the body on the selection remounts the collapsible sections, so a
   * section left open on one record does not decide how the next one opens.
   */
  const selectionKey = state.selection.kind === 'none' ? 'none' : `${kind}:${state.selection.id}`;

  return (
    <aside
      className="fw-inspector"
      aria-label="Inspector"
      data-kind={kind}
      data-dragging={dragY > 0 ? 'true' : undefined}
      style={
        dragY > 0
          ? {
              transform: `translateY(${dragY}px)`,
              opacity: Math.max(0.35, 1 - dragY / (DISMISS_DISTANCE * 2)),
            }
          : undefined
      }
    >
      <button
        type="button"
        className="fw-inspector__handle"
        aria-label="Dismiss the inspector sheet"
        title="Drag down, or press, to dismiss"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        onClick={() => {
          if (!moved.current) close();
        }}
      >
        <span className="fw-inspector__grabber" aria-hidden="true" />
      </button>

      <header className="fw-inspector__head">
        <div className="fw-inspector__heading">
          <Eyebrow>{KIND_LABEL[kind]}</Eyebrow>
          <h2 className="fw-inspector__title" title={detail?.titleTooltip}>
            {detail ? detail.title : 'Record not found'}
          </h2>
          {detail?.subtitle ? <div className="fw-inspector__subtitle">{detail.subtitle}</div> : null}
        </div>
        <div className="fw-inspector__head-actions">
          {detail?.status ? <StatusBadge status={detail.status} size="sm" /> : null}
          <IconButton icon="PanelRightClose" label="Close inspector" size="sm" onClick={close} />
        </div>
      </header>

      <div className="fw-inspector__body fw-scroll" key={selectionKey}>
        {detail ? (
          detail.body
        ) : (
          <EmptyState
            icon="SearchX"
            title="Not in this dataset"
            detail={
              production
                ? 'The selected id does not exist in the live data.'
                : 'The selected id does not exist in the local example data.'
            }
            compact
            action={
              <Button size="sm" icon="X" onClick={() => select({ kind: 'none' })}>
                Clear selection
              </Button>
            }
          />
        )}
      </div>

      <footer className="fw-inspector__foot">
        <ExampleTag detail="Every record in this panel is local example data. The prototype is not connected to Forge, Claude Code or any API." />
        <span className="fw-inspector__foot-text">
          {production ? 'Live record from the local gateway' : 'Local example record'}
        </span>
      </footer>
    </aside>
  );
}

export default Inspector;
