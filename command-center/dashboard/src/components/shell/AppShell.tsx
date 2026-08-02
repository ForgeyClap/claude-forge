/**
 * Forge Workspace — the application shell.
 *
 * One CSS grid, driven by the layout tokens. It owns the chrome and nothing
 * else: a view renders into <main> and never draws the sidebar, topbar,
 * inspector or dock itself.
 *
 *   >1180px   sidebar | main | inspector, dock under main
 *   <=1180px  the inspector detaches into an overlay with a scrim
 *   <=860px   the sidebar detaches into a drawer, the inspector into a sheet
 *
 * The document never scrolls sideways at any width: the grid's middle track is
 * minmax(0, 1fr) and <main> is its own scroll container, so wide content scrolls
 * inside the view rather than pushing the page.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { CommandPalette } from '@/components/shell/CommandPalette';
import { ConnectionBanner } from '@/components/shell/ConnectionBanner';
import { Dock } from '@/components/shell/Dock';
import { Inspector } from '@/components/shell/Inspector';
import Sidebar from '@/components/shell/Sidebar';
import { Toasts } from '@/components/shell/Toasts';
import Topbar from '@/components/shell/Topbar';
import { AccountUsagePressure } from '@/components/usage/AccountUsagePressure';
import { usePrototype } from '@/prototype/state/prototype-store';

import './app-shell.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Below this the sidebar is a drawer, not a column. Mirrors app-shell.css. */
const DRAWER_QUERY = '(max-width: 860px)';

export interface AppShellProps {
  children?: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const { state, dispatch } = usePrototype();
  const location = useLocation();

  const drawerRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const drawerOpen = state.mobileDrawerOpen;

  const closeDrawer = useCallback(() => {
    dispatch({ type: 'drawer/set', open: false });
  }, [dispatch]);

  /* The drawer never survives a route change. The ref keeps the effect keyed to
     the pathname alone — reacting to `drawerOpen` here would shut the drawer the
     instant it opened. */
  const drawerOpenRef = useRef(drawerOpen);

  useEffect(() => {
    drawerOpenRef.current = drawerOpen;
  }, [drawerOpen]);

  useEffect(() => {
    if (drawerOpenRef.current) dispatch({ type: 'drawer/set', open: false });
  }, [location.pathname, dispatch]);

  /* Growing past the drawer breakpoint returns the sidebar to its column. */
  useEffect(() => {
    let query: MediaQueryList | null = null;
    try {
      query = typeof window.matchMedia === 'function' ? window.matchMedia(DRAWER_QUERY) : null;
    } catch {
      query = null;
    }
    if (!query) return;

    const handle = (event: MediaQueryListEvent) => {
      if (!event.matches) dispatch({ type: 'drawer/set', open: false });
    };
    query.addEventListener('change', handle);
    return () => query.removeEventListener('change', handle);
  }, [dispatch]);

  /* Focus moves into the drawer when it opens and returns where it came from. */
  useEffect(() => {
    if (drawerOpen) {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      return;
    }
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    previous?.focus();
  }, [drawerOpen]);

  /* Shell-level keys. Escape closes the drawer; Ctrl/Cmd+K raises the palette;
     Ctrl/Cmd+B folds the sidebar to its rail. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drawerOpen) {
        event.preventDefault();
        closeDrawer();
        return;
      }
      const chord = event.metaKey || event.ctrlKey;
      if (!chord || event.altKey) return;

      if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        // 'set', not 'toggle': the palette may listen for the same chord, and
        // two handlers agreeing on "open" is harmless where two toggles are not.
        dispatch({ type: 'palette/set', open: true });
      } else if (event.key === 'b' || event.key === 'B') {
        event.preventDefault();
        dispatch({ type: 'sidebar/toggle' });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, closeDrawer, dispatch]);

  /* Tab is trapped inside the drawer while it is open. */
  function handleDrawerKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!drawerOpen || event.key !== 'Tab') return;
    const focusable = Array.from(
      drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    ).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fw-shell"
      data-sidebar={state.sidebarCollapsed ? 'rail' : 'full'}
      data-inspector={state.inspectorOpen ? 'open' : 'closed'}
      data-drawer={drawerOpen ? 'open' : 'closed'}
      data-dock={state.dockOpen ? 'open' : 'closed'}
    >
      <a className="fw-shell__skip" href="#fw-main">
        Skip to content
      </a>

      <div
        ref={drawerRef}
        className="fw-shell__sidebar"
        onKeyDown={handleDrawerKeyDown}
      >
        <Sidebar />
      </div>

      {drawerOpen ? (
        <button
          type="button"
          className="fw-shell__scrim"
          aria-label="Close drawer"
          onClick={closeDrawer}
        />
      ) : null}

      <Topbar />

      <main id="fw-main" className="fw-shell__main" tabIndex={-1}>
        {children}
      </main>

      {state.inspectorOpen ? (
        <button
          type="button"
          className="fw-shell__inspector-scrim"
          aria-label="Close inspector"
          onClick={() => dispatch({ type: 'inspector/set', open: false })}
        />
      ) : null}

      {state.inspectorOpen ? (
        <div className="fw-shell__inspector">
          <Inspector />
        </div>
      ) : null}

      <div className="fw-shell__dock">
        <Dock />
      </div>

      <CommandPalette />
      <Toasts />

      {/* Shows only while the bridge connection is not healthy; portals to <body>
          and renders nothing when connected. Never a full-screen blocker. */}
      <ConnectionBanner />

      {/* WP7c: the account-wide Forge usage-pressure strip. Always on (unlike
          ConnectionBanner, which hides when healthy) — a small, honest, fixed
          corner pill, never a blocker. See AccountUsagePressure's own header. */}
      <AccountUsagePressure />
    </div>
  );
}
