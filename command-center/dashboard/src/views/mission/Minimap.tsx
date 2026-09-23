/**
 * Mission Control — the minimap.
 *
 * The whole world at a glance plus a draggable viewport rectangle. Sized from
 * --forge-layout-minimap-w / -h; hidden under 860px by the stylesheet, where
 * the graph region is small enough that an overview of the overview is noise.
 *
 * Node marks are status-toned through the shared .fw-status carrier, so they
 * use the same greyscale steps as every badge on the screen.
 */

import { useCallback, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { GraphLayout, Viewport, ViewportSize } from './useGraphViewport';

/** Inset so a mark on the world's edge is not clipped by the frame. */
const INSET = 6;
const BOX_FALLBACK = { w: 168, h: 112 };

/**
 * The svg viewBox has to agree with the CSS box, which is set from the tokens.
 * Read once per mount rather than duplicating the numbers in two places.
 */
function readMinimapBox(): { w: number; h: number } {
  if (typeof document === 'undefined' || typeof window === 'undefined') return BOX_FALLBACK;
  try {
    const style = window.getComputedStyle(document.documentElement);
    const read = (name: string, fallback: number): number => {
      const value = Number.parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
      w: read('--forge-layout-minimap-w', BOX_FALLBACK.w),
      h: read('--forge-layout-minimap-h', BOX_FALLBACK.h),
    };
  } catch {
    return BOX_FALLBACK;
  }
}

export interface MinimapProps {
  layout: GraphLayout;
  viewport: Viewport;
  size: ViewportSize;
  selectedId: string | null;
  /** Puts a world point in the middle of the viewport. */
  onNavigate(worldX: number, worldY: number): void;
}

export function Minimap({ layout, viewport, size, selectedId, onNavigate }: MinimapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<number | null>(null);
  /** Offset from the viewport centre to the point that was grabbed. */
  const grabRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const box = useMemo(() => readMinimapBox(), []);

  const scale = Math.min((box.w - INSET * 2) / layout.width, (box.h - INSET * 2) / layout.height);
  const offsetX = (box.w - layout.width * scale) / 2;
  const offsetY = (box.h - layout.height * scale) / 2;

  const viewW = viewport.k > 0 ? size.width / viewport.k : layout.width;
  const viewH = viewport.k > 0 ? size.height / viewport.k : layout.height;
  const viewX = viewport.k > 0 ? -viewport.x / viewport.k : 0;
  const viewY = viewport.k > 0 ? -viewport.y / viewport.k : 0;

  /** World point under the pointer, whatever the minimap is scaled to on screen. */
  const worldPointAt = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const element = svgRef.current;
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const localX = ((clientX - rect.left) / rect.width) * box.w;
      const localY = ((clientY - rect.top) / rect.height) * box.h;
      return { x: (localX - offsetX) / scale, y: (localY - offsetY) / scale };
    },
    [offsetX, offsetY, scale, box.w, box.h],
  );

  const navigateFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const point = worldPointAt(clientX, clientY);
      if (!point) return;
      onNavigate(point.x + grabRef.current.x, point.y + grabRef.current.y);
    },
    [onNavigate, worldPointAt],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.stopPropagation();
      const point = worldPointAt(event.clientX, event.clientY);
      // Grabbing inside the rectangle keeps the grip; clicking outside it jumps.
      const inside =
        point !== null &&
        point.x >= viewX &&
        point.x <= viewX + viewW &&
        point.y >= viewY &&
        point.y <= viewY + viewH;
      grabRef.current = inside
        ? { x: viewX + viewW / 2 - point.x, y: viewY + viewH / 2 - point.y }
        : { x: 0, y: 0 };
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = event.pointerId;
      navigateFromEvent(event.clientX, event.clientY);
    },
    [navigateFromEvent, worldPointAt, viewX, viewY, viewW, viewH],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (dragRef.current !== event.pointerId) return;
      event.stopPropagation();
      navigateFromEvent(event.clientX, event.clientY);
    },
    [navigateFromEvent],
  );

  const endDrag = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div className="fw-graph__minimap" data-fw-graph-overlay="minimap">
      <svg
        ref={svgRef}
        className="fw-graph__minimap-svg"
        viewBox={`0 0 ${box.w} ${box.h}`}
        role="img"
        aria-label="Minimap of the mission graph. Drag it to move the view."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <g transform={`translate(${offsetX} ${offsetY}) scale(${scale})`}>
          {layout.bands.map((band) => (
            <rect
              key={band.lane.id}
              className="fw-graph__minimap-band"
              x={band.x}
              y={band.y}
              width={band.w}
              height={band.h}
            />
          ))}
          {layout.boxes.map((box_) => (
            <rect
              key={box_.node.id}
              className={
                box_.node.id === selectedId
                  ? 'fw-status fw-graph__minimap-node is-selected'
                  : 'fw-status fw-graph__minimap-node'
              }
              data-status={box_.node.status}
              x={box_.x}
              y={box_.y}
              width={box_.w}
              height={box_.h}
              rx={8}
            />
          ))}
        </g>
        <rect
          className="fw-graph__minimap-view"
          x={offsetX + viewX * scale}
          y={offsetY + viewY * scale}
          width={Math.max(6, viewW * scale)}
          height={Math.max(6, viewH * scale)}
          rx={2}
        />
      </svg>
    </div>
  );
}
