/**
 * Mission Control — the left-to-right multi-agent workflow graph.
 *
 * Reads the active mission graph out of `state.data.graph` and draws it: one
 * spine (request → boss → head chef → verification → review → fix loop →
 * output) with parallel lanes banded between them, and the repair-and-retest
 * loop routed underneath so the return path is impossible to miss.
 *
 * With no run selected `state.data.graph` is genuinely empty (production) or the
 * fixture's own example graph (fixtures) — either way this view shows an honest
 * "no mission running" state rather than a zeroed-out header over an empty
 * canvas.
 */

import { useCallback, useMemo } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Button,
  EmptyState,
  Eyebrow,
  IconButton,
  KeyHint,
  Machine,
  StatusBadge,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useGatewayApprovals } from '@/prototype/state/gateway-recovery';
import { chatRunStatusToStatusKey, useGatewayChatRuns } from '@/prototype/state/gateway-adapter';
import { ApprovalsMeta } from './ApprovalsMeta';
import { GraphCanvas } from './GraphCanvas';
import { useGraphLayout, useGraphViewport } from './useGraphViewport';
import './mission.css';

export default function MissionControlView() {
  const { state, dispatch } = usePrototype();
  const graph = state.data.graph;

  const layout = useGraphLayout(graph);
  const view = useGraphViewport(layout.width, layout.height);

  const run = useMemo(
    () => state.data.runs.find((candidate) => candidate.id === graph.runId),
    [state.data.runs, graph.runId],
  );

  // Real gate evaluations for this run — see the module header above. Called
  // unconditionally (Rules of Hooks) even on the "no mission running" branch;
  // `graph.runId` is '' there, which the hook treats the same as no run.
  const approvals = useGatewayApprovals(state.activeProjectId, graph.runId !== '' ? graph.runId : null);

  // feat-chatruns-tabs: real dashboard-CHAT activity for the active project — mounted directly
  // (Rules of Hooks: unconditionally, like `approvals` above), independent of `state.data.graph`
  // (a chat execution never joins a Forge mission graph). `latestChatRun` is real newest-first data
  // straight from the gateway (`useGatewayChatRuns` sorts newest-first) — only ever used below to
  // replace the plain "No mission running" copy with an honest "here's the real activity that DID
  // happen" state, never to fabricate a mission graph node.
  const chatRuns = useGatewayChatRuns(state.activeProjectId);
  const latestChatRun = chatRuns[0] ?? null;

  /**
   * Progress, keyed by the agent name the graph nodes carry — a real completed/total ratio in
   * production (`buildAgentProgressMap`, `gateway-adapter.ts`), the fixture's own example value
   * otherwise. cc-finish fix-cert-fabrication (F1): this comment used to say "Example progress"
   * unconditionally, which was only ever true on the fixture path — the value is real whenever a
   * real run is executing.
   */
  const progressByAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const agent of state.data.agents) {
      if (agent.status === 'running') map.set(agent.name, agent.progress);
    }
    return map;
  }, [state.data.agents]);

  const selectedId = state.selection.kind === 'graph-node' ? state.selection.id : null;

  const onSelect = useCallback(
    (id: string) => dispatch({ type: 'select', selection: { kind: 'graph-node', id } }),
    [dispatch],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape' || !selectedId) return;
      event.preventDefault();
      dispatch({ type: 'select', selection: { kind: 'none' } });
    },
    [dispatch, selectedId],
  );

  const counts = `${graph.nodes.length} steps · ${graph.lanes.length} lanes · ${graph.edges.length} links`;

  // No active Forge mission: the graph is genuinely empty (production) or unresolved (a stale
  // runId). feat-chatruns-tabs: when the owner's most recent real activity on this project came
  // from a dashboard CHAT session instead (no `/forge` mission at all), that is shown honestly here
  // — real title/status/timing, clearly labelled as chat activity, never presented as a multi-agent
  // mission. With no chat activity either, the plain "no mission" empty state is unchanged.
  if (!run || graph.nodes.length === 0) {
    if (latestChatRun !== null) {
      const chatStatus = chatRunStatusToStatusKey(latestChatRun.status);
      return (
        <div className="fw-mission">
          <header className="fw-mission__header">
            <div className="fw-mission__ident">
              <Eyebrow>MISSION CONTROL</Eyebrow>
              <h1 className="fw-mission__title">{latestChatRun.title ?? 'Chat activity'}</h1>
              <div className="fw-mission__meta">
                <StatusBadge status={chatStatus} size="sm" />
                <span className="fw-mission__meta-item">
                  <span className="fw-mission__meta-key">CHAT RUN</span>
                  <Machine>{latestChatRun.runId}</Machine>
                </span>
                <span className="fw-mission__meta-item fw-mission__meta-item--wide">
                  <span className="fw-mission__meta-key">STARTED</span>
                  <Machine muted>{latestChatRun.startedAt ?? '—'}</Machine>
                </span>
              </div>
            </div>
          </header>
          <EmptyState
            icon="MessagesSquare"
            title="No multi-agent Forge mission is running"
            detail="This project's most recent recorded activity came from a dashboard chat session, shown above — it does not drive the multi-agent mission graph below."
          />
        </div>
      );
    }
    return (
      <div className="fw-mission">
        <header className="fw-mission__header">
          <div className="fw-mission__ident">
            <Eyebrow>MISSION CONTROL</Eyebrow>
            <h1 className="fw-mission__title">No mission running</h1>
          </div>
        </header>
        <EmptyState
          icon="Workflow"
          title="No mission is running"
          detail="Start a run in a project to see its live multi-agent graph here."
        />
      </div>
    );
  }

  return (
    <div className="fw-mission" onKeyDown={onKeyDown}>
      <header className="fw-mission__header">
        <div className="fw-mission__ident">
          <Eyebrow>MISSION CONTROL</Eyebrow>
          <h1 className="fw-mission__title">{run.goal}</h1>
          <div className="fw-mission__meta">
            <StatusBadge status={run.status} size="sm" />
            <span className="fw-mission__meta-item">
              <span className="fw-mission__meta-key">RUN</span>
              <Machine>{graph.runId}</Machine>
            </span>
            <span className="fw-mission__meta-item">
              <span className="fw-mission__meta-key">ELAPSED</span>
              <Machine>{run.duration}</Machine>
            </span>
            <span className="fw-mission__meta-item fw-mission__meta-item--wide">
              <span className="fw-mission__meta-key">STARTED</span>
              <Machine muted>{run.startedAt}</Machine>
            </span>
            <span className="fw-mission__meta-item fw-mission__meta-item--wide">
              <span className="fw-mission__meta-key">GRAPH</span>
              <Machine muted>{counts}</Machine>
            </span>
          </div>

          <ApprovalsMeta approvals={approvals} />
        </div>

        <Toolbar label="Graph controls" className="fw-mission__controls">
          <ToolbarGroup>
            <IconButton
              icon="Minus"
              label="Zoom out"
              size="sm"
              disabled={view.atMinZoom}
              onClick={view.zoomOut}
            />
            <span className="fw-mission__zoom fg-machine" aria-live="polite">
              {view.zoomPercent}%
            </span>
            <IconButton icon="Plus" label="Zoom in" size="sm" disabled={view.atMaxZoom} onClick={view.zoomIn} />
          </ToolbarGroup>

          <ToolbarGroup divided>
            <Button size="sm" icon="Maximize" onClick={view.fit}>
              Fit view
            </Button>
          </ToolbarGroup>

          <ToolbarGroup divided className="fw-mission__controls-hint">
            <KeyHint keys={['0']} />
            <span className="fw-mission__hint-text">fit</span>
            <KeyHint keys={['+', '−']} />
            <span className="fw-mission__hint-text">zoom</span>
            <KeyHint keys={['↑', '↓', '←', '→']} />
            <span className="fw-mission__hint-text">pan</span>
          </ToolbarGroup>
        </Toolbar>
      </header>

      <GraphCanvas
        graph={graph}
        layout={layout}
        view={view}
        selectedId={selectedId}
        progressByAgent={progressByAgent}
        onSelect={onSelect}
      />
    </div>
  );
}
