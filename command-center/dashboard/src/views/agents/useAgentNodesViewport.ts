/**
 * Agents view — Nodes graph pan/zoom viewport.
 *
 * A smaller, self-contained sibling of Mission Control's own
 * `useGraphViewport` (`src/views/mission/useGraphViewport.ts`) — that hook is
 * out of this work package's write scope, and its layout half is built
 * specifically around `MissionGraph`'s lanes, so it is not a drop-in import
 * here. The interaction half (pan, wheel-zoom anchored on the cursor, fit,
 * clamped drag) is the same real behaviour, reimplemented against this view's
 * own (much smaller) world.
 *
 * Everything here changes only `transform` (translate/scale) — never a
 * layout property — so panning and zooming are compositor-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
const FIT_PAD = 28;
/** How far past the edge the graph may be dragged before the clamp catches it. */
const EDGE_SLACK = 32;

export interface AgentNodesViewport {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface AgentNodesViewportHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void;
  onPointerCancel(event: ReactPointerEvent<HTMLDivElement>): void;
}

export interface AgentNodesViewportApi {
  readonly viewport: AgentNodesViewport;
  readonly panning: boolean;
  /** True right after a control-driven change (fit/zoom button), so that move can ease. */
  readonly smooth: boolean;
  readonly zoomPercent: number;
  readonly atMinZoom: boolean;
  readonly atMaxZoom: boolean;
  attachCanvas(element: HTMLDivElement | null): void;
  readonly handlers: AgentNodesViewportHandlers;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function clampPan(next: AgentNodesViewport, worldW: number, worldH: number, size: ViewportSize): AgentNodesViewport {
  if (size.width <= 0 || size.height <= 0) return next;
  const spanX = size.width - worldW * next.k;
  const spanY = size.height - worldH * next.k;
  return {
    k: next.k,
    x: clamp(next.x, Math.min(0, spanX) - EDGE_SLACK, Math.max(0, spanX) + EDGE_SLACK),
    y: clamp(next.y, Math.min(0, spanY) - EDGE_SLACK, Math.max(0, spanY) + EDGE_SLACK),
  };
}

function fitViewport(worldW: number, worldH: number, size: ViewportSize): AgentNodesViewport {
  if (worldW <= 0 || worldH <= 0 || size.width <= 0 || size.height <= 0) {
    return { x: 0, y: 0, k: 1 };
  }
  const k = clamp(
    Math.min((size.width - FIT_PAD * 2) / worldW, (size.height - FIT_PAD * 2) / worldH),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  return { k, x: (size.width - worldW * k) / 2, y: (size.height - worldH * k) / 2 };
}

/**
 * Pan (pointer drag), wheel-zoom anchored on the cursor, a fit button, and
 * zoom in/out. The hierarchy is small enough that the opening frame IS the
 * fit frame — unlike Mission Control's wide DAG, there is no separate
 * "legible opening scale" to pick.
 */
export function useAgentNodesViewport(worldWidth: number, worldHeight: number): AgentNodesViewportApi {
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<ViewportSize>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<AgentNodesViewport>({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  const [smooth, setSmooth] = useState(false);

  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const fittedRef = useRef(false);

  const attachCanvas = useCallback((element: HTMLDivElement | null) => setCanvas(element), []);

  useEffect(() => {
    if (!canvas) return;

    const apply = (width: number, height: number) => {
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      if (fittedRef.current || width <= 0 || height <= 0) return;
      fittedRef.current = true;
      setSmooth(false);
      setViewport(fitViewport(worldWidth, worldHeight, { width, height }));
    };

    const frame = window.requestAnimationFrame(() => {
      const rect = canvas.getBoundingClientRect();
      apply(rect.width, rect.height);
    });

    if (typeof ResizeObserver === 'undefined') {
      return () => window.cancelAnimationFrame(frame);
    }

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) apply(rect.width, rect.height);
    });
    observer.observe(canvas);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [canvas, worldWidth, worldHeight]);

  useEffect(() => {
    if (!canvas) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-delta * 0.0016);
      setSmooth(false);
      setViewport((prev) => {
        const k = clamp(prev.k * factor, MIN_ZOOM, MAX_ZOOM);
        if (k === prev.k) return prev;
        const ratio = k / prev.k;
        return clampPan(
          { k, x: px - (px - prev.x) * ratio, y: py - (py - prev.y) * ratio },
          worldWidth,
          worldHeight,
          { width: rect.width, height: rect.height },
        );
      });
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvas, worldWidth, worldHeight]);

  const zoomAtCentre = useCallback(
    (factor: number) => {
      setSmooth(true);
      setViewport((prev) => {
        const k = clamp(prev.k * factor, MIN_ZOOM, MAX_ZOOM);
        if (k === prev.k) return prev;
        const ratio = k / prev.k;
        const px = size.width / 2;
        const py = size.height / 2;
        return clampPan(
          { k, x: px - (px - prev.x) * ratio, y: py - (py - prev.y) * ratio },
          worldWidth,
          worldHeight,
          size,
        );
      });
    },
    [size, worldWidth, worldHeight],
  );

  const zoomIn = useCallback(() => zoomAtCentre(1.2), [zoomAtCentre]);
  const zoomOut = useCallback(() => zoomAtCentre(1 / 1.2), [zoomAtCentre]);

  const fit = useCallback(() => {
    if (size.width <= 0 || size.height <= 0) return;
    setSmooth(true);
    setViewport(fitViewport(worldWidth, worldHeight, size));
  }, [size, worldWidth, worldHeight]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    // Nodes and the floating control cluster own their own gestures.
    if (target?.closest('[data-fw-agents-node]') || target?.closest('[data-fw-agents-overlay]')) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    setPanning(true);
    setSmooth(false);
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      dragRef.current = { id: drag.id, x: event.clientX, y: event.clientY };
      if (dx === 0 && dy === 0) return;
      setSmooth(false);
      setViewport((prev) => clampPan({ k: prev.k, x: prev.x + dx, y: prev.y + dy }, worldWidth, worldHeight, size));
    },
    [size, worldWidth, worldHeight],
  );

  const endPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.id !== event.pointerId) return;
    dragRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handlers = useMemo<AgentNodesViewportHandlers>(
    () => ({ onPointerDown, onPointerMove, onPointerUp: endPan, onPointerCancel: endPan }),
    [onPointerDown, onPointerMove, endPan],
  );

  return {
    viewport,
    panning,
    smooth,
    zoomPercent: Math.round(viewport.k * 100),
    atMinZoom: viewport.k <= MIN_ZOOM + 0.001,
    atMaxZoom: viewport.k >= MAX_ZOOM - 0.001,
    attachCanvas,
    handlers,
    zoomIn,
    zoomOut,
    fit,
  };
}
