/**
 * Mission Control — one node of the workflow graph.
 *
 * A real <button>, absolutely positioned in the transformed world layer, so it
 * is reachable by Tab, activated by Enter or Space, and announced with its own
 * accessible name. Nothing here is a div pretending to be a control.
 *
 * Provenance: the label is a human-written step name (sans); the agent, model
 * and duration underneath were recorded by the system (mono, via .fg-machine).
 */

import type { CSSProperties } from 'react';
import { Icon, StatusBadge } from '@/components/primitives';
import type { GraphNodeKind } from '@/prototype/types/prototype-types';
import type { NodeBox } from './useGraphViewport';

/** One glyph per node kind. Unknown names fall back inside <Icon>. */
const KIND_GLYPH: Readonly<Record<GraphNodeKind, string>> = {
  request: 'MessageSquare',
  boss: 'Crown',
  'head-chef': 'ChefHat',
  'lane-agent': 'CircleDot',
  step: 'Box',
  verify: 'SearchCheck',
  review: 'ClipboardCheck',
  fix: 'RotateCcw',
  output: 'Flag',
};

const KIND_LABEL: Readonly<Record<GraphNodeKind, string>> = {
  request: 'Request',
  boss: 'Boss',
  'head-chef': 'Head chef',
  'lane-agent': 'Lane agent',
  step: 'Step',
  verify: 'Verification',
  review: 'Review',
  fix: 'Fix loop',
  output: 'Output',
};

export interface GraphNodeCardProps {
  box: NodeBox;
  laneLabel: string | null;
  selected: boolean;
  /** Something else is selected, so this node steps back. */
  dimmed: boolean;
  /** 0–100 for a running agent, null otherwise. The one rationed use of accent. */
  progress: number | null;
  onSelect(id: string): void;
  onFocusNode(box: NodeBox): void;
}

export function GraphNodeCard({
  box,
  laneLabel,
  selected,
  dimmed,
  progress,
  onSelect,
  onFocusNode,
}: GraphNodeCardProps) {
  const { node } = box;
  const isSpine = node.laneId === null;

  const classes = ['fw-status', 'fw-graph-node'];
  if (selected) classes.push('is-selected');
  if (dimmed) classes.push('is-dimmed');
  if (isSpine) classes.push('fw-graph-node--spine');

  const meta = [node.agent, node.duration].filter((part): part is string => Boolean(part) && part !== '—');
  const tooltip = [
    `${KIND_LABEL[node.kind]} — ${node.label}`,
    laneLabel ? `Lane: ${laneLabel}` : null,
    node.agent ? `Agent: ${node.agent}` : null,
    node.model ? `Model: ${node.model}` : null,
    node.duration && node.duration !== '—' ? `Elapsed: ${node.duration}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const style: CSSProperties = {
    transform: `translate(${box.x}px, ${box.y}px)`,
    inlineSize: `${box.w}px`,
    blockSize: `${box.h}px`,
  };

  return (
    <button
      type="button"
      data-fw-graph-node={node.id}
      data-status={node.status}
      data-kind={node.kind}
      className={classes.join(' ')}
      style={style}
      title={tooltip}
      aria-pressed={selected}
      onClick={() => onSelect(node.id)}
      onFocus={() => onFocusNode(box)}
    >
      <span className="fw-graph-node__head">
        <Icon name={KIND_GLYPH[node.kind]} size="sm" className="fw-graph-node__glyph" />
        <span className="fw-graph-node__label fw-truncate">{node.label}</span>
      </span>

      <span className="fw-graph-node__foot">
        <StatusBadge status={node.status} size="sm" />
        {meta.length > 0 ? (
          <span className="fw-graph-node__meta fg-machine fw-truncate">{meta.join(' · ')}</span>
        ) : null}
      </span>

      {progress !== null ? (
        <span
          className="fw-graph-node__progress"
          style={{ '--fw-progress': `${Math.max(0, Math.min(100, progress))}%` } as CSSProperties}
          aria-hidden="true"
        />
      ) : null}

      <span className="fw-visually-hidden">
        {KIND_LABEL[node.kind]}
        {laneLabel ? ` in lane ${laneLabel}` : ''}
        {/* cc-finish fix-cert-fabrication (F1): this progress is a real completed/total ratio in
            production (`buildAgentProgressMap`, `gateway-adapter.ts`) and the fixture's own example
            value otherwise — the component cannot tell which (same "view can't tell the mode"
            precedent as `ProjectsView.tsx`). Calling it "example work" unconditionally described a
            live, real measurement as fake to a screen reader during every real run; this wording is
            true in both modes instead of claiming either one. */}
        {progress !== null ? `, ${Math.round(progress)} per cent through its work` : ''}.
      </span>
    </button>
  );
}
