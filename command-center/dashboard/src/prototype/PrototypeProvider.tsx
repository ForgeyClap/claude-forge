/**
 * Forge Workspace — the prototype provider.
 *
 * It publishes the `StoreValue` every view reads through `usePrototype()`, and it
 * owns the handful of side effects that have to live above the tree (see
 * `state/shell-effects.ts`'s `useShellEffects`):
 *
 *   1. mirror the resolved theme onto <html data-theme>
 *   2. mirror the density onto <html data-density>
 *   3. follow the OS colour scheme while appearance is "system"
 *   4. follow the OS reduced-motion preference
 *   5. advance the local chat reveal on a timer
 *
 * WHERE THE DATA COMES FROM depends on the mode (`src/config/mode.ts`), decided
 * once at mount:
 *
 *   PRODUCTION (the default)  — the UI/preference state runs through the same
 *       reducer as ever, but `state.data` is fed from `gateway-adapter.ts`'s
 *       `useGatewayDataset()`: real records read from THIS project's own gateway
 *       (`command-center/gateway`, REST + SSE on 127.0.0.1:4100) — the sole
 *       real-data layer this phase (WP7b; see `T7-integration-plan.md` §b). An
 *       empty workspace maps to empty collections, so the views render their
 *       real empty states rather than anything invented.
 *
 *   FIXTURES (opt-in only)    — the original example-data reducer, unchanged, so
 *       the theme showcase and the unit tests keep working. As of fix-cert-
 *       fixtures (forge-2026-07-29-cc-finish) it is `React.lazy`-loaded from
 *       `state/fixture-provider.tsx` rather than imported at this file's top
 *       level — see that module's header for why: a plain static import here
 *       shipped the full 18-agent/conversation/task example dataset inside the
 *       SAME entry chunk every real production user downloads, regardless of
 *       which branch below actually runs. `tests/unit/fixture-import-graph.
 *       test.ts` proves no fixture module is statically reachable from
 *       `src/main.tsx` any more.
 *
 * The mode gate is the only branch; both paths share the same reducer, the same
 * effects, and the same context, so a view cannot tell which one it is reading —
 * only whether the records it receives are real.
 */

import { lazy, Suspense, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';

import { isProductionMode } from '@/config/mode';
import { ChatSendContext } from '@/prototype/state/chat-send';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { useGatewayDataset } from '@/prototype/state/gateway-adapter';
import { useGatewayChatSendController } from '@/prototype/state/gateway-chat';
import { FilesActionsContext, useGatewayFilesController } from '@/prototype/state/gateway-files';
import { createInitialState, useShellEffects } from '@/prototype/state/shell-effects';
import { PrototypeContext, reducer } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';

/**
 * The fixture path, code-split away from the main bundle — see this file's
 * header and `fixture-provider.tsx`'s own header for the full rationale.
 */
const LazyFixtureProvider = lazy(() => import('@/prototype/state/fixture-provider'));

/* ----------------------------------------------------- production provider */

/**
 * Production: UI/preference state from the reducer, DATA from
 * `gateway-adapter.ts`'s `useGatewayDataset()` — this project's own real
 * gateway, polled + tailed over REST/SSE (WP7b).
 */
/**
 * Pure guard for the reconciliation effect above its call site: while a LOCAL activation of this
 * exact id is younger than the grace window, the effect must not 'heal' it away — the projects
 * cache (5s server TTL + 2.5s poll) simply hasn't caught up with a project that really exists.
 * Exported for its unit test.
 */
export function activationGraceActive(last: { id: string; at: number }, activeId: string, now: number): boolean {
  const GRACE_MS = 15_000; // server-TTL 5s + poll 2.5s + ruime marge
  return last.id === activeId && now - last.at < GRACE_MS;
}

function ProductionProvider({ children }: { children?: ReactNode }) {
  const [uiState, dispatch] = useReducer(reducer, undefined, () => createInitialState(EMPTY_DATASET));
  useShellEffects(uiState, dispatch);

  // Once real projects/conversations appear and nothing valid is selected, select
  // the first so a view reading the active id shows real content. This only ever
  // moves the selection off a stale/empty id — it never overrides a live choice.
  const activeProjectId = uiState.activeProjectId;
  const activeConversationId = uiState.activeConversationId;
  // The active file selection, read here (not inside gateway-adapter.ts) so
  // the files controller can drive its OWN read-preview fetch reactively —
  // see gateway-files.ts's header for why this needs a controller, not a
  // plain polled data hook like every other dataset field.
  const selectedFilePath = uiState.selection.kind === 'file' ? uiState.selection.id : null;

  const files = useGatewayFilesController(activeProjectId, selectedFilePath);
  const data = useGatewayDataset(activeProjectId, activeConversationId, files.tree);
  const state = useMemo<PrototypeState>(() => ({ ...uiState, data }), [uiState, data]);

  // visible-install fix (HIGH, screenshot-isolated): this reconciliation exists to heal a STALE id
  // (a project that really disappeared). But it fired in the same tick as "New project" activating
  // the freshly created project — whose id cannot be in the client's projects cache yet (5s server
  // TTL + 2.5s poll) — and silently reset the workspace to the first cached project. The user
  // clicked Create and stayed on an unrelated project, permanently. The grace window below skips
  // reconciliation while a recent local activation is still ahead of the cache; a genuinely dead id
  // still heals as soon as the window lapses. Window = server TTL + poll + margin.
  const lastActivationRef = useRef<{ id: string; at: number }>({ id: '', at: 0 });
  useEffect(() => {
    lastActivationRef.current = { id: activeProjectId, at: Date.now() };
  }, [activeProjectId]);
  useEffect(() => {
    if (data.projects.length === 0) return;
    if (data.projects.some((p) => p.id === activeProjectId)) return;
    if (activationGraceActive(lastActivationRef.current, activeProjectId, Date.now())) return;
    dispatch({ type: 'project/activate', id: data.projects[0].id });
  }, [data.projects, activeProjectId, dispatch]);

  // conversation reconciliation (fix-activation-race, forge-2026-07-30-cc-finish): heals a
  // genuinely unselected conversation on cold start, but ONLY from conversations that belong to
  // the ACTIVE project, and AT MOST ONCE per project for the life of this mount. Two independent
  // agents hit the fallout of the naive version this replaces:
  //   (a) it read `data.conversations[0]` gateway-wide — `GET /api/conversations` did not yet
  //       honour its own `?project=` filter (fixed separately, in the gateway), so that first row
  //       could belong to an entirely different project than the one active here;
  //   (b) deleting the active conversation makes `Sidebar.tsx` deliberately clear the selection
  //       (`conversation/activate` to `''`) to detach — but that shape is indistinguishable from
  //       "cold start, nothing chosen yet" (both are an empty `activeConversationId`), so the old
  //       effect fired again on the very next data tick and silently jumped to an unrelated
  //       conversation. Because the NEW id then matched a real row, nothing ever looked stale
  //       again afterwards — the workspace stayed stuck on the wrong conversation for good.
  //
  // Unlike `activationGraceActive` above (a bounded RACE window that still heals a genuinely dead
  // project id once the poll cache catches up), an empty conversation selection is a legitimate,
  // PERMANENT resting state here, not a race that should eventually self-correct. So this effect
  // settles AT MOST ONCE per project: the first time real conversation data for that project shows
  // up, it either confirms the current selection or auto-picks the first same-project conversation
  // — then never revisits that project again. A later explicit clear (delete, or any future flow)
  // stays honoured forever; switching to a project never settled before still gets its own one-time
  // cold-start pick.
  const settledConversationProjectsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeProjectId) return;
    if (settledConversationProjectsRef.current.has(activeProjectId)) return;
    const ownConversations = data.conversations.filter((c) => c.projectId === activeProjectId);
    if (ownConversations.length === 0) return;
    settledConversationProjectsRef.current.add(activeProjectId);
    if (ownConversations.some((c) => c.id === activeConversationId)) return;
    dispatch({ type: 'conversation/activate', id: ownConversations[0].id });
  }, [data.conversations, activeProjectId, activeConversationId, dispatch]);

  const value = useMemo<StoreValue>(() => ({ state, dispatch }), [state]);

  // id + real project tag, not a bare id list — `useGatewayChatSendController`
  // needs both to refuse posting into a conversation that belongs to a
  // DIFFERENT project than the one currently active (fix-crossproject,
  // forge-2026-07-29-cc-finish; see that hook's own header for why).
  const knownConversations = useMemo(
    () => data.conversations.map((c) => ({ id: c.id, projectId: c.projectId })),
    [data.conversations],
  );

  // The REAL (third) send path — see `gateway-chat.ts`. It drives the gateway's
  // conversation routes directly. The fixture provider does NOT mount it, so
  // the chat view there keeps the untouched local reveal.
  const chat = useGatewayChatSendController({
    activeProjectId,
    activeConversationId,
    knownConversations,
    dispatch,
  });

  return (
    <PrototypeContext.Provider value={value}>
      <ChatSendContext.Provider value={chat}>
        <FilesActionsContext.Provider value={files}>{children}</FilesActionsContext.Provider>
      </ChatSendContext.Provider>
    </PrototypeContext.Provider>
  );
}

/* --------------------------------------------------------------- provider */

export interface PrototypeProviderProps {
  children?: ReactNode;
}

export function PrototypeProvider({ children }: PrototypeProviderProps) {
  // The mode is a build+runtime constant. It is resolved ONCE at mount so the hook
  // order stays stable: in the real app it is always production (fixtures require a
  // build flag AND an explicit runtime opt-in that only tests/harnesses set).
  const production = useMemo(() => isProductionMode(), []);

  if (production) {
    return <ProductionProvider>{children}</ProductionProvider>;
  }

  // `fallback={null}`: in every build this repo currently ships, `production` is
  // always true (see this file's header), so this branch — and the brief instant
  // where the lazy chunk is still being fetched — is never seen by a real user.
  // A test that DOES exercise fixture mode already tolerates the async resolution
  // (see `tests/unit/prototype-provider-fixture-mode.test.tsx`).
  return (
    <Suspense fallback={null}>
      <LazyFixtureProvider>{children}</LazyFixtureProvider>
    </Suspense>
  );
}

export default PrototypeProvider;
