/**
 * Mission Control — the canvas.
 *
 * Three layers share one coordinate system:
 *   1. an <svg> holding the lane bands and every connector
 *   2. an absolutely positioned layer of real <button> nodes on top of it
 *   3. screen-space overlays (minimap, legend) that do not move with the world
 *
 * Layers 1 and 2 live inside a single transformed element, so pan and zoom are
 * one CSS transform rather than a redraw. Nothing is fetched or measured from
 * outside the example dataset.
 */

import { useCallback, useMemo } from 'react';
import { ExampleTag } from '@/components/primitives';
import type { MissionGraph } from '@/prototype/types/prototype-types';
import { GraphEdges } from './GraphEdges';
import { GraphNodeCard } from './GraphNode';
import { Minimap } from './Minimap';
import type { GraphLayout, GraphViewportApi, NodeBox } from './useGraphViewport';

export interface GraphCanvasProps {
  graph: MissionGraph;
  layout: GraphLayout;
  view: GraphViewportApi;
  selectedId: string | null;
  /**
   * Progress per agent name — real in production (`buildAgentProgressMap`), the fixture's own
   * example value otherwise (see `MissionControlView.tsx`'s own header for the same distinction).
   * Drives the one accented hairline.
   */
  progressByAgent: ReadonlyMap<string, number>;
  onSelect(id: string): void;
}

export function GraphCanvas({ graph, layout, view, selectedId, progressByAgent, onSelect }: GraphCanvasProps) {
  const laneLabels = useMemo(
    () => new Map(graph.lanes.map((lane) => [lane.id, lane.label] as const)),
    [graph.lanes],
  );

  const emphasised = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedId) return ids;
    for (const edge of graph.edges) {
      if (edge.from === selectedId || edge.to === selectedId) ids.add(edge.id);
    }
    return ids;
  }, [graph.edges, selectedId]);

  // Pulled apart up front: `attachCanvas` becomes the element ref, and the
  // linter is right that nothing else should be reached through it afterwards.
  const { attachCanvas, handlers, viewport, size, panning, smooth, ensureVisible, centreOn } = view;

  const onFocusNode = useCallback(
    (box: NodeBox) => ensureVisible({ x: box.x, y: box.y, w: box.w, h: box.h }),
    [ensureVisible],
  );

  const worldStyle = {
    inlineSize: `${layout.width}px`,
    blockSize: `${layout.height}px`,
    transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.k})`,
  };

  const canvasClasses = ['fw-graph__canvas'];
  if (panning) canvasClasses.push('is-panning');

  const worldClasses = ['fw-graph__world'];
  if (smooth && !panning) worldClasses.push('is-smooth');

  return (
    <div className="fw-graph">
      <div
        ref={attachCanvas}
        className={canvasClasses.join(' ')}
        tabIndex={0}
        role="region"
        aria-label="Mission graph"
        aria-describedby="fw-graph-help"
        onScroll={(event) => {
          // The layer is transformed, never scrolled. If the browser scrolls it
          // to reveal a focused node, undo it — ensureVisible already panned.
          event.currentTarget.scrollLeft = 0;
          event.currentTarget.scrollTop = 0;
        }}
        {...handlers}
      >
        <p id="fw-graph-help" className="fw-visually-hidden">
          {graph.nodes.length} steps across {graph.lanes.length} parallel lanes, connected by {graph.edges.length}{' '}
          links. Drag to pan, use the arrow keys to move, plus and minus to zoom, and 0 to fit the whole graph. Tab
          moves through the steps left to right; Enter opens one in the inspector.
        </p>

        <div className={worldClasses.join(' ')} style={worldStyle}>
          <svg
            className="fw-graph__svg"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            aria-hidden="true"
            focusable="false"
          >
            <g className="fw-graph__bands">
              {layout.bands.map((band) => (
                <g key={band.lane.id} className="fw-graph__band" data-group={band.lane.group}>
                  <rect
                    className="fw-graph__band-fill"
                    x={band.x}
                    y={band.y}
                    width={band.w}
                    height={band.h}
                    rx={14}
                  />
                  <rect
                    className="fw-graph__band-tick"
                    x={band.x + 6}
                    y={band.y + 9}
                    width={2}
                    height={Math.max(0, band.h - 18)}
                    rx={1}
                  />
                  <text className="fw-graph__band-label" x={band.labelX} y={band.labelY}>
                    {band.lane.label}
                    <tspan className="fw-graph__band-group" dx={10}>
                      {band.lane.group}
                    </tspan>
                  </text>
                </g>
              ))}
            </g>

            <GraphEdges
              edges={graph.edges}
              layout={layout}
              emphasised={emphasised}
              hasSelection={Boolean(selectedId)}
            />
          </svg>

          <div
            className="fw-graph__nodes"
            style={{ inlineSize: `${layout.width}px`, blockSize: `${layout.height}px` }}
          >
            {layout.boxes.map((box) => (
              <GraphNodeCard
                key={box.node.id}
                box={box}
                laneLabel={box.node.laneId ? laneLabels.get(box.node.laneId) ?? null : null}
                selected={box.node.id === selectedId}
                dimmed={Boolean(selectedId) && box.node.id !== selectedId}
                progress={
                  box.node.status === 'running' && box.node.agent
                    ? progressByAgent.get(box.node.agent) ?? null
                    : null
                }
                onSelect={onSelect}
                onFocusNode={onFocusNode}
              />
            ))}
          </div>
        </div>

        <div className="fw-graph__legend" data-fw-graph-overlay="legend">
          <span className="fw-graph__legend-item">
            <svg className="fw-graph__legend-mark" viewBox="0 0 26 8" aria-hidden="true">
              <path className="fw-graph__legend-line fw-graph__legend-line--flow" d="M1 4 H21" />
              <path className="fw-graph__legend-head" d="M20 1.5 L25 4 L20 6.5 Z" />
            </svg>
            <span className="fw-graph__legend-text fg-machine">FLOW</span>
          </span>
          <span className="fw-graph__legend-item">
            <svg className="fw-graph__legend-mark" viewBox="0 0 26 8" aria-hidden="true">
              <path className="fw-graph__legend-line fw-graph__legend-line--dependency" d="M1 4 H25" />
            </svg>
            <span className="fw-graph__legend-text fg-machine">DEPENDENCY</span>
          </span>
          <span className="fw-graph__legend-item">
            <svg className="fw-graph__legend-mark" viewBox="0 0 26 8" aria-hidden="true">
              <path className="fw-graph__legend-line fw-graph__legend-line--feedback" d="M1 4 H25" />
            </svg>
            <span className="fw-graph__legend-text fg-machine">RETURN PATH</span>
          </span>
          <span className="fw-graph__legend-note">
            <ExampleTag detail="Example mission graph. No run was executed, no agent was dispatched and nothing here is connected to Forge, Claude Code or any API." />
          </span>
        </div>

        <Minimap
          layout={layout}
          viewport={viewport}
          size={size}
          selectedId={selectedId}
          onNavigate={centreOn}
        />
      </div>
    </div>
  );
}
