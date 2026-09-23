/**
 * Mission Control â€” world geometry and the pan / zoom viewport.
 *
 * Two concerns live here because they are one concern in practice: you cannot
 * frame a graph you have not measured.
 *
 *   computeGraphLayout / useGraphLayout
 *     Turns `col` / `row` into pixels. Every distance comes from the layout
 *     tokens (--forge-layout-node-w / node-h / col-gap / lane-gap), read once
 *     from the document and cached, with numeric fallbacks so the module still
 *     produces a sane graph under jsdom or before the stylesheet lands.
 *
 *   useGraphViewport
 *     Pan (pointer + touch + arrow keys), zoom (wheel, +/-, buttons), fit (0),
 *     and a clamp that stops the graph being dragged off the screen.
 *
 * There is no data here and nothing is fetched. The input is the example
 * mission graph from the prototype store; the output is arithmetic.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { GraphLane, GraphNode, MissionGraph } from '@/prototype/types/prototype-types';

/* ------------------------------------------------------------------ tokens */

interface TokenSizes {
  readonly nodeW: number;
  readonly nodeH: number;
  readonly colGap: number;
  readonly laneGap: number;
}

/** Mirrors brand/tokens.json. Used verbatim when the document is unavailable. */
const TOKEN_FALLBACK: TokenSizes = { nodeW: 188, nodeH: 62, colGap: 78, laneGap: 26 };

let tokenCache: TokenSizes | null = null;

/** Reads the four layout tokens once. getComputedStyle is expensive; this is not. */
function readTokenSizes(): TokenSizes {
  if (tokenCache) return tokenCache;
  if (typeof document === 'undefined' || typeof window === 'undefined') return TOKEN_FALLBACK;

  let sizes = TOKEN_FALLBACK;
  try {
    const style = window.getComputedStyle(document.documentElement);
    const read = (name: string, fallback: number): number => {
      const value = Number.parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    sizes = {
      nodeW: read('--forge-layout-node-w', TOKEN_FALLBACK.nodeW),
      nodeH: read('--forge-layout-node-h', TOKEN_FALLBACK.nodeH),
      colGap: read('--forge-layout-col-gap', TOKEN_FALLBACK.colGap),
      laneGap: read('--forge-layout-lane-gap', TOKEN_FALLBACK.laneGap),
    };
  } catch {
    sizes = TOKEN_FALLBACK;
  }

  tokenCache = sizes;
  return sizes;
}

/* ------------------------------------------------------------------ layout */

/**
 * Room reserved at the top of every lane band for its name. The band is the
 * only place a lane is named, so the strip is part of the row pitch rather
 * than an overlay that could collide with a connector.
 */
const LANE_LABEL_STRIP = 20;
/** Gap between the label strip and the first node in the band. */
const LANE_LABEL_CLEARANCE = 6;
/** Breathing room under a node before the band closes. */
const BAND_BOTTOM_PAD = 8;
/** Distance from the outermost band to the feedback channel that rides past it. */
const OUTER_CHANNEL = 44;
/** Slack outside the feedback channels so the return paths are not flush to the edge. */
const OUTER_MARGIN = 30;
/** Left and right world padding. */
const PAD_X = 56;

export interface GraphMetrics {
  readonly nodeW: number;
  readonly nodeH: number;
  readonly colGap: number;
  readonly laneGap: number;
  /** Distance between the left edges of two adjacent columns. */
  readonly colPitch: number;
  /** Distance between the top edges of two adjacent lane rows. */
  readonly rowPitch: number;
  readonly padX: number;
  readonly padY: number;
  readonly bandTopPad: number;
  readonly bandBottomPad: number;
  readonly bandHeight: number;
  readonly labelStrip: number;
}

export interface NodeBox {
  readonly node: GraphNode;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly cx: number;
  readonly cy: number;
}

export interface LaneBand {
  readonly lane: GraphLane;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly labelX: number;
  readonly labelY: number;
}

export interface GraphLayout {
  readonly metrics: GraphMetrics;
  readonly width: number;
  readonly height: number;
  /** Sorted left to right, then top to bottom â€” this is also the tab order. */
  readonly boxes: readonly NodeBox[];
  readonly byId: ReadonlyMap<string, NodeBox>;
  readonly bands: readonly LaneBand[];
  /** Horizontal lane the "reopen mission" return path rides, above every band. */
  readonly topChannel: number;
  /** Horizontal lane the "rebuild and recapture" return path rides, below every band. */
  readonly bottomChannel: number;
  /** Y of the node-free strip between lane row `row` and row + 1. */
  channelBelow(row: number): number;
}

function buildMetrics(): GraphMetrics {
  const token = readTokenSizes();
  const bandTopPad = LANE_LABEL_STRIP + LANE_LABEL_CLEARANCE;
  return {
    nodeW: token.nodeW,
    nodeH: token.nodeH,
    colGap: token.colGap,
    laneGap: token.laneGap,
    colPitch: token.nodeW + token.colGap,
    rowPitch: token.nodeH + token.laneGap + LANE_LABEL_STRIP,
    padX: PAD_X,
    padY: bandTopPad + OUTER_CHANNEL + OUTER_MARGIN,
    bandTopPad,
    bandBottomPad: BAND_BOTTOM_PAD,
    bandHeight: bandTopPad + token.nodeH + BAND_BOTTOM_PAD,
    labelStrip: LANE_LABEL_STRIP,
  };
}

/**
 * Left to right from `col`, banded top to bottom from `row`.
 *
 * Lane bands span only the columns that actually hold lane work, which is what
 * keeps the spine (request â†’ boss â†’ head chef â€¦ â†’ output, sitting on row 2.5)
 * clear of them: the spine's columns are outside every band's horizontal reach.
 */
export function computeGraphLayout(graph: MissionGraph): GraphLayout {
  const metrics = buildMetrics();
  const { nodeW, nodeH, colPitch, rowPitch, padX, padY, colGap } = metrics;

  const boxes: NodeBox[] = graph.nodes
    .map((node) => {
      const x = padX + node.col * colPitch;
      const y = padY + node.row * rowPitch;
      return { node, x, y, w: nodeW, h: nodeH, cx: x + nodeW / 2, cy: y + nodeH / 2 };
    })
    .sort((a, b) => (a.node.col - b.node.col) || (a.node.row - b.node.row));

  const byId = new Map<string, NodeBox>(boxes.map((box) => [box.node.id, box]));

  // Which row each lane occupies, and how far the lane region reaches sideways.
  const laneRow = new Map<string, number>();
  let minLaneCol = Number.POSITIVE_INFINITY;
  let maxLaneCol = Number.NEGATIVE_INFINITY;
  for (const node of graph.nodes) {
    if (!node.laneId) continue;
    const current = laneRow.get(node.laneId);
    if (current === undefined || node.row < current) laneRow.set(node.laneId, node.row);
    if (node.col < minLaneCol) minLaneCol = node.col;
    if (node.col > maxLaneCol) maxLaneCol = node.col;
  }
  if (!Number.isFinite(minLaneCol)) {
    minLaneCol = 0;
    maxLaneCol = 0;
  }

  const bandX = padX + minLaneCol * colPitch - colGap / 2;
  const bandW = (maxLaneCol - minLaneCol) * colPitch + nodeW + colGap;

  const bands: LaneBand[] = graph.lanes
    .map((lane) => {
      const row = laneRow.get(lane.id) ?? 0;
      const y = padY + row * rowPitch - metrics.bandTopPad;
      return {
        lane,
        row,
        x: bandX,
        y,
        w: bandW,
        h: metrics.bandHeight,
        labelX: bandX + 14,
        labelY: y + metrics.labelStrip / 2 + 3,
      };
    })
    .sort((a, b) => a.row - b.row);

  const maxCol = graph.nodes.reduce((acc, node) => Math.max(acc, node.col), 0);
  const maxBandRow = bands.reduce((acc, band) => Math.max(acc, band.row), 0);
  const lowestBand = padY + maxBandRow * rowPitch - metrics.bandTopPad + metrics.bandHeight;
  const lowestNode = boxes.reduce((acc, box) => Math.max(acc, box.y + box.h), 0);

  const topChannel = padY - metrics.bandTopPad - OUTER_CHANNEL;
  const bottomChannel = Math.max(lowestBand, lowestNode) + OUTER_CHANNEL;

  return {
    metrics,
    width: padX * 2 + maxCol * colPitch + nodeW,
    height: bottomChannel + OUTER_MARGIN,
    boxes,
    byId,
    bands,
    topChannel,
    bottomChannel,
    channelBelow: (row: number) =>
      padY + Math.round(row) * rowPitch + nodeH + metrics.bandBottomPad + (rowPitch - metrics.bandHeight) / 2,
  };
}

/** Memoised layout. The example graph never changes, so this runs once. */
export function useGraphLayout(graph: MissionGraph): GraphLayout {
  return useMemo(() => computeGraphLayout(graph), [graph]);
}

/* ---------------------------------------------------------------- viewport */

/* The mission graph is ten columns wide (~2700px of world), so a true
   fit-to-viewport lands near 28%. The floor has to allow that, otherwise
   "Fit view" silently refuses to fit. */
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2.2;

/**
 * Opening zoom. Deliberately NOT fit-to-viewport: fitting a ten-column DAG into
 * a panel renders every node label unreadable, so the graph opens at a legible
 * scale framed on the left where the mission starts, and "Fit view" stays an
 * explicit choice for taking in the whole shape.
 */
const INITIAL_ZOOM = 0.78;

const ZOOM_STEP = 1.2;
const PAN_STEP = 72;
const PAN_STEP_FAST = 260;
/** How far past the edge the graph may be dragged before it springs back. */
const EDGE_SLACK = 40;
const FIT_PAD = 32;

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

export interface WorldRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface GraphViewportHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void;
  onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void;
  onPointerCancel(event: ReactPointerEvent<HTMLDivElement>): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
}

export interface GraphViewportApi {
  readonly viewport: Viewport;
  readonly size: ViewportSize;
  readonly panning: boolean;
  /** True when the last change came from a control, so the move can be eased. */
  readonly smooth: boolean;
  readonly zoomPercent: number;
  readonly atMinZoom: boolean;
  readonly atMaxZoom: boolean;
  /** Callback ref for the canvas element. Not a ref object, on purpose. */
  attachCanvas(element: HTMLDivElement | null): void;
  readonly handlers: GraphViewportHandlers;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  /** Puts a world point in the middle of the viewport. Used by the minimap. */
  centreOn(worldX: number, worldY: number): void;
  /** Pans the smallest amount that brings a world rect fully into view. */
  ensureVisible(rect: WorldRect): void;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Keeps the graph overlapping the viewport, with a little slack at the edges. */
function clampPan(next: Viewport, worldW: number, worldH: number, size: ViewportSize): Viewport {
  if (size.width <= 0 || size.height <= 0) return next;
  const spanX = size.width - worldW * next.k;
  const spanY = size.height - worldH * next.k;
  return {
    k: next.k,
    x: clamp(next.x, Math.min(0, spanX) - EDGE_SLACK, Math.max(0, spanX) + EDGE_SLACK),
    y: clamp(next.y, Math.min(0, spanY) - EDGE_SLACK, Math.max(0, spanY) + EDGE_SLACK),
  };
}

function fitViewport(worldW: number, worldH: number, size: ViewportSize): Viewport {
  const k = clamp(
    Math.min((size.width - FIT_PAD * 2) / worldW, (size.height - FIT_PAD * 2) / worldH),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  return { k, x: (size.width - worldW * k) / 2, y: (size.height - worldH * k) / 2 };
}

/**
 * The opening frame: legible scale, anchored at the left edge of the graph and
 * vertically centred, so the eye starts where the mission starts.
 */
function initialViewport(worldW: number, worldH: number, size: ViewportSize): Viewport {
  // Never open more zoomed-in than a full fit would be — on a wide screen the
  // whole graph may already be legible, and opening zoomed-in would look broken.
  const fitted = Math.min((size.width - FIT_PAD * 2) / worldW, (size.height - FIT_PAD * 2) / worldH);
  const k = clamp(Math.max(fitted, INITIAL_ZOOM), MIN_ZOOM, MAX_ZOOM);

  const fitsHorizontally = worldW * k <= size.width;
  const fitsVertically = worldH * k <= size.height;

  return {
    k,
    x: fitsHorizontally ? (size.width - worldW * k) / 2 : FIT_PAD,
    y: fitsVertically ? (size.height - worldH * k) / 2 : FIT_PAD,
  };
}

export function useGraphViewport(worldWidth: number, worldHeight: number): GraphViewportApi {
  /* The canvas element lives in state rather than a ref, so every effect can
     depend on it and nothing has to read a ref while rendering. */
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<ViewportSize>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  const [smooth, setSmooth] = useState(false);

  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const fittedRef = useRef(false);

  const attachCanvas = useCallback((element: HTMLDivElement | null) => setCanvas(element), []);

  /* Measure the canvas and, the first time it has a size, frame the whole
     graph. Both happen inside an observer callback, never in the effect body. */
  useEffect(() => {
    if (!canvas) return;

    const apply = (width: number, height: number) => {
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      if (fittedRef.current || width <= 0 || height <= 0) return;
      fittedRef.current = true;
      setSmooth(false);
      setViewport(initialViewport(worldWidth, worldHeight, { width, height }));
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

  /* Wheel zoom, anchored on the pointer. Registered non-passive on the canvas
     itself, so it only fires with the pointer over the graph and the page
     behind it never scrolls. */
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

  const zoomIn = useCallback(() => zoomAtCentre(ZOOM_STEP), [zoomAtCentre]);
  const zoomOut = useCallback(() => zoomAtCentre(1 / ZOOM_STEP), [zoomAtCentre]);

  const fit = useCallback(() => {
    if (size.width <= 0 || size.height <= 0) return;
    setSmooth(true);
    setViewport(fitViewport(worldWidth, worldHeight, size));
  }, [size, worldWidth, worldHeight]);

  const panBy = useCallback(
    (dx: number, dy: number, eased: boolean) => {
      setSmooth(eased);
      setViewport((prev) => clampPan({ k: prev.k, x: prev.x + dx, y: prev.y + dy }, worldWidth, worldHeight, size));
    },
    [size, worldWidth, worldHeight],
  );

  const centreOn = useCallback(
    (worldX: number, worldY: number) => {
      setSmooth(false);
      setViewport((prev) =>
        clampPan(
          { k: prev.k, x: size.width / 2 - worldX * prev.k, y: size.height / 2 - worldY * prev.k },
          worldWidth,
          worldHeight,
          size,
        ),
      );
    },
    [size, worldWidth, worldHeight],
  );

  const ensureVisible = useCallback(
    (rect: WorldRect) => {
      if (size.width <= 0 || size.height <= 0) return;
      setSmooth(true);
      setViewport((prev) => {
        const pad = 56;
        const left = rect.x * prev.k + prev.x;
        const top = rect.y * prev.k + prev.y;
        const right = (rect.x + rect.w) * prev.k + prev.x;
        const bottom = (rect.y + rect.h) * prev.k + prev.y;

        let x = prev.x;
        let y = prev.y;
        if (left < pad) x += pad - left;
        else if (right > size.width - pad) x -= right - (size.width - pad);
        if (top < pad) y += pad - top;
        else if (bottom > size.height - pad) y -= bottom - (size.height - pad);

        if (x === prev.x && y === prev.y) return prev;
        return clampPan({ k: prev.k, x, y }, worldWidth, worldHeight, size);
      });
    },
    [size, worldWidth, worldHeight],
  );

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    // Nodes and the screen-space overlays own their own gestures.
    if (target?.closest('[data-fw-graph-node]') || target?.closest('[data-fw-graph-overlay]')) return;
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
      panBy(dx, dy, false);
    },
    [panBy],
  );

  const endPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.id !== event.pointerId) return;
    dragRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? PAN_STEP_FAST : PAN_STEP;
      switch (event.key) {
        case 'ArrowLeft':
          panBy(step, 0, true);
          break;
        case 'ArrowRight':
          panBy(-step, 0, true);
          break;
        case 'ArrowUp':
          panBy(0, step, true);
          break;
        case 'ArrowDown':
          panBy(0, -step, true);
          break;
        case '+':
        case '=':
          zoomIn();
          break;
        case '-':
        case '_':
          zoomOut();
          break;
        case '0':
          fit();
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [panBy, zoomIn, zoomOut, fit],
  );

  const handlers = useMemo<GraphViewportHandlers>(
    () => ({
      onPointerDown,
      onPointerMove,
      onPointerUp: endPan,
      onPointerCancel: endPan,
      onKeyDown,
    }),
    [onPointerDown, onPointerMove, endPan, onKeyDown],
  );

  return {
    viewport,
    size,
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
    centreOn,
    ensureVisible,
  };
}
