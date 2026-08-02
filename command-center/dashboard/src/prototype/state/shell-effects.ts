/**
 * Forge Workspace — the shared provider seed state + above-the-tree effects.
 *
 * Split out of `PrototypeProvider.tsx` (fix-cert-fixtures, forge-2026-07-29-cc-finish)
 * so `createInitialState`/`useShellEffects` can be imported by BOTH the
 * production path (still inline in `PrototypeProvider.tsx`) and the fixture
 * path, which now lives in its own lazily-loaded module (`fixture-provider.tsx`)
 * so its dataset import never reaches the main bundle — see that file's header.
 *
 * A second reason this lives in its own `.ts` (not `.tsx`, no JSX here) module
 * rather than being re-exported from `PrototypeProvider.tsx` itself: exporting a
 * plain function alongside a component trips `react-refresh/only-export-components`
 * (see `components/shell/claude-code-chip.ts`'s header for the same reasoning
 * applied elsewhere in this codebase), and the fixture module would otherwise
 * need a STATIC import back into the very file it is lazy-loaded out of.
 */

import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';

import {
  readStoredAppearance,
  readStoredDensity,
  resolveTheme,
} from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeDataset, PrototypeState } from '@/prototype/state/prototype-store';

/* ------------------------------------------------------------------ media */

const LIGHT_QUERY = '(prefers-color-scheme: light)';
const MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** Above this width the inspector is a real column rather than an overlay. */
const WIDE_QUERY = '(min-width: 1181px)';

/**
 * matchMedia is not universally available (jsdom, very old engines). Every use
 * degrades to a sensible default rather than throwing on mount.
 */
function safeMatchMedia(query: string): MediaQueryList | null {
  try {
    return typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  } catch {
    return null;
  }
}

function matches(query: string, fallback: boolean): boolean {
  return safeMatchMedia(query)?.matches ?? fallback;
}

/* ------------------------------------------------------------ chat reveal */

/** Interval between reveal steps. Slow enough to read, fast enough to feel live. */
const STREAM_TICK_MS = 14;
/** Characters added per step. A few at a time reads like typing, not like a clock. */
const STREAM_CHARS_PER_TICK = 3;

/* ----------------------------------------------------------------- state */

/**
 * The initial UI/preference state over a given dataset. In production the seed
 * dataset is empty and `state.data` is overridden with live data on every render;
 * in fixtures it is the example dataset and stands as-is.
 */
export function createInitialState(data: PrototypeDataset): PrototypeState {
  const appearance = readStoredAppearance();
  const firstProjectId = data.projects[0]?.id ?? '';

  return {
    data,

    appearance,
    resolvedTheme: resolveTheme(appearance),
    density: readStoredDensity(),
    reducedMotion: matches(MOTION_QUERY, false),

    // The inspector only starts open where it has a column of its own; on a
    // narrow screen it would otherwise open as an overlay over the first view.
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: matches(WIDE_QUERY, true),
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,

    activeProjectId: firstProjectId,
    activeConversationId: data.conversations[0]?.id ?? '',
    selection: firstProjectId ? { kind: 'project', id: firstProjectId } : { kind: 'none' },

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

/* --------------------------------------------------------- shared effects */

/** The five above-the-tree side effects, shared by both mode paths. */
export function useShellEffects(state: PrototypeState, dispatch: Dispatch<PrototypeAction>): void {
  /* 1. Theme -> <html data-theme>. index.html already wrote a first-paint value;
        this keeps it true for every change after that. */
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', state.resolvedTheme);
    // Tells the engine which native control palette to draw (scrollbars, caret).
    root.style.setProperty('color-scheme', state.resolvedTheme);
  }, [state.resolvedTheme]);

  /* 2. Density -> <html data-density>. Components key off this, not off widths. */
  useEffect(() => {
    document.documentElement.setAttribute('data-density', state.density);
  }, [state.density]);

  /* 3. System colour scheme. The reducer ignores this while an explicit theme is
        pinned, so the listener can stay subscribed unconditionally. */
  useEffect(() => {
    const query = safeMatchMedia(LIGHT_QUERY);
    if (!query) return;

    const handle = (event: MediaQueryListEvent) => {
      dispatch({ type: 'appearance/system-changed', resolved: event.matches ? 'light' : 'dark' });
    };

    // Re-sync once on mount: the OS may have changed since the module loaded.
    dispatch({ type: 'appearance/system-changed', resolved: query.matches ? 'light' : 'dark' });
    query.addEventListener('change', handle);
    return () => query.removeEventListener('change', handle);
  }, [dispatch]);

  /* 4. Reduced motion. Stored in state as well as honoured in CSS, because some
        behaviour (the chat reveal below) is JavaScript, not animation. */
  useEffect(() => {
    const query = safeMatchMedia(MOTION_QUERY);
    if (!query) return;

    const handle = (event: MediaQueryListEvent) => {
      dispatch({ type: 'motion/set', reduced: event.matches });
    };

    dispatch({ type: 'motion/set', reduced: query.matches });
    query.addEventListener('change', handle);
    return () => query.removeEventListener('change', handle);
  }, [dispatch]);

  /* 5. The local chat reveal.
        A ref carries the live stream so the interval can read the current
        position without being torn down and rebuilt on every tick. */
  const streamRef = useRef<PrototypeState['stream']>(null);

  useEffect(() => {
    streamRef.current = state.stream;
  }, [state.stream]);

  const streamMessageId = state.stream?.messageId ?? null;
  const streamDone = state.stream?.done ?? true;
  const reducedMotion = state.reducedMotion;

  useEffect(() => {
    if (!streamMessageId || streamDone) return;

    const interval = window.setInterval(() => {
      const stream = streamRef.current;
      if (!stream || stream.done) return;
      // Under reduced motion the text simply appears — a reveal is animation.
      const step = reducedMotion ? stream.target.length : STREAM_CHARS_PER_TICK;
      dispatch({ type: 'chat/stream-tick', revealed: stream.revealed + step });
    }, STREAM_TICK_MS);

    return () => window.clearInterval(interval);
  }, [streamMessageId, streamDone, reducedMotion, dispatch]);
}
