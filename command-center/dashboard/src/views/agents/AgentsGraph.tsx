/**
 * Agents view — "Nodes" mode.
 *
 * Draws the same filtered roster the list/grid/grouped layouts already show,
 * as a pan/zoomable reporting-line graph: Boss at the top, Head Chef beneath
 * it, every executing agent beneath that (see `agent-graph-layout.ts`'s own
 * header for exactly how that hierarchy is derived from real data, never
 * invented). Adapted from this project's own legacy Control Center graph
 * (`.claude/forge-dashboard/graph.js`, read-only reference, not imported):
 * the same world-div `translate3d`/`scale` pan-zoom, cursor-anchored wheel
 * zoom, fit-to-view, DOM node cards carrying real status, and cubic-bezier
 * SVG connectors with an arrowhead marker — reimplemented here in React and in
 * this app's own strict monochrome token language (no hex/rgb, no hue: group
 * and status are told apart by luminance step, border weight and dash, never
 * colour).
 *
 * Every motion here is `transform`/`opacity` only — pan and zoom are one CSS
 * transform on the world layer, eased only when a control (not a drag or a
 * wheel tick) caused the change.
 */

import { useMemo } from 'react';
import { Button, IconButton, Icon, Machine, StatusBadge } from '@/components/primitives';
import type { Agent } from '@/prototype/types/prototype-types';
import { GROUP_BY_KEY } from './agent-groups';
import { computeAgentGraphLayout } from './agent-graph-layout';
import type { AgentGraphEdge, AgentGraphNode } from './agent-graph-layout';
import { useAgentNodesViewport } from './useAgentNodesViewport';

export interface AgentsGraphProps {
  agents: readonly Agent[];
  selectedId: string | null;
  onSelect(id: string): void;
}

/** A vertical cubic-bezier tuck between a parent's bottom edge and a child's top edge. */
function edgePath(from: AgentGraphNode, to: AgentGraphNode): string {
  const x1 = from.cx;
  const y1 = from.y + from.h;
  const x2 = to.cx;
  const y2 = to.y;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

function AgentNode({
  node,
  selected,
  onSelect,
}: {
  node: AgentGraphNode;
  selected: boolean;
  onSelect(id: string): void;
}) {
  const { agent } = node;
  const group = GROUP_BY_KEY[agent.group];
  const classes = ['fw-status', 'fw-agents-group', 'fw-agents-graph__node'];
  if (selected) classes.push('is-selected');
  if (node.depth === 0) classes.push('is-root');

  const tooltip = [`${agent.name} — ${group.label}`, `Status: ${agent.status}`].join('\n');

  return (
    <button
      type="button"
      data-fw-agents-node={agent.id}
      data-status={agent.status}
      data-group={agent.group}
      data-depth={node.depth}
      className={classes.join(' ')}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, inlineSize: `${node.w}px`, blockSize: `${node.h}px` }}
      title={tooltip}
      aria-pressed={selected}
      onClick={() => onSelect(agent.id)}
    >
      <span className="fw-agents-graph__node-head">
        <Icon name={group.glyph} size="xs" className="fw-agents-graph__node-glyph" />
        <span className="fw-agents-graph__node-name fw-truncate">{agent.name}</span>
      </span>
      <span className="fw-agents-graph__node-foot">
        <Machine muted className="fw-agents-graph__node-role fw-truncate">
          {group.label}
        </Machine>
        <StatusBadge status={agent.status} size="sm" iconOnly />
      </span>
      <span className="fw-visually-hidden">
        {agent.name}, {group.label}, {agent.role}, status {agent.status}.
      </span>
    </button>
  );
}

function AgentEdges({ edges, byId }: { edges: readonly AgentGraphEdge[]; byId: ReadonlyMap<string, AgentGraphNode> }) {
  return (
    <>
      <defs>
        <marker
          id="fw-agents-graph-arrow"
          viewBox="0 0 8 8"
          refX="6.5"
          refY="4"
          markerWidth={7}
          markerHeight={7}
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M 0.5 0.5 L 7.5 4 L 0.5 7.5 Z" className="fw-agents-graph__arrow" />
        </marker>
      </defs>
      <g className="fw-agents-graph__edges">
        {edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) return null;
          return (
            <path
              key={edge.id}
              className={`fw-agents-graph__edge fw-agents-graph__edge--${edge.kind}`}
              d={edgePath(from, to)}
              markerEnd="url(#fw-agents-graph-arrow)"
            />
          );
        })}
      </g>
    </>
  );
}

export function AgentsGraph({ agents, selectedId, onSelect }: AgentsGraphProps) {
  const layout = useMemo(() => computeAgentGraphLayout(agents), [agents]);
  const view = useAgentNodesViewport(layout.width, layout.height);
  const { attachCanvas, handlers, viewport, panning, smooth } = view;

  const worldStyle = {
    inlineSize: `${layout.width}px`,
    blockSize: `${layout.height}px`,
    transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.k})`,
  };

  const canvasClasses = ['fw-agents-graph__canvas'];
  if (panning) canvasClasses.push('is-panning');
  const worldClasses = ['fw-agents-graph__world'];
  if (smooth && !panning) worldClasses.push('is-smooth');

  return (
    <div className="fw-agents-graph">
      <div
        ref={attachCanvas}
        className={canvasClasses.join(' ')}
        role="region"
        aria-label="Agent reporting graph"
        aria-describedby="fw-agents-graph-help"
        {...handlers}
      >
        <p id="fw-agents-graph-help" className="fw-visually-hidden">
          {layout.nodes.length} agents connected by {layout.edges.length} reporting lines. Drag to pan, scroll to
          zoom, and use Fit view to see the whole hierarchy. Select an agent to open its details.
        </p>

        <div className={worldClasses.join(' ')} style={worldStyle}>
          <svg
            className="fw-agents-graph__svg"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            aria-hidden="true"
            focusable="false"
          >
            <AgentEdges edges={layout.edges} byId={layout.byId} />
          </svg>

          <div
            className="fw-agents-graph__nodes"
            style={{ inlineSize: `${layout.width}px`, blockSize: `${layout.height}px` }}
          >
            {layout.nodes.map((node) => (
              <AgentNode key={node.agent.id} node={node} selected={node.agent.id === selectedId} onSelect={onSelect} />
            ))}
          </div>
        </div>

        <div className="fw-agents-graph__controls" data-fw-agents-overlay="controls">
          <IconButton icon="Minus" label="Zoom out" size="sm" disabled={view.atMinZoom} onClick={view.zoomOut} />
          <span className="fw-agents-graph__zoom fg-machine" aria-live="polite">
            {view.zoomPercent}%
          </span>
          <IconButton icon="Plus" label="Zoom in" size="sm" disabled={view.atMaxZoom} onClick={view.zoomIn} />
          <Button size="sm" icon="Maximize" onClick={view.fit}>
            Fit view
          </Button>
        </div>
      </div>
    </div>
  );
}
