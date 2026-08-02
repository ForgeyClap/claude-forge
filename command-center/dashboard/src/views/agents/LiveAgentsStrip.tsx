/**
 * LiveAgentsStrip — the real "live now" view of subagent dispatch (feat-live-visibility, Gap B:
 * "no 'live now' view of the agents actually working"). Rendered above the Agents roster in
 * `AgentsView.tsx`.
 *
 * Fed entirely by `useGatewayAgentDispatches` (`GET /api/agent-dispatches`) — real `Agent`
 * tool_use dispatches this project's own conversations recorded, never the static registry the
 * roster below already shows. See that hook's own header, and `gateway/src/agent-dispatches.mjs`'s
 * header, for exactly which stored fields this reads and the honesty rule behind `running`.
 *
 * TWO DISTINCT, MANDATORY honest empty states (never one generic empty box):
 *   - no agent registry at all for this project (`agentCount === 0`)
 *   - a registry exists, but no subagent dispatch has been recorded yet (`dispatches.length === 0`)
 *
 * Existing primitives/classes only — `Eyebrow`, `Icon`, `Machine`, and the SAME `.fw-agents-chip`
 * class the roster below already uses for permission/verification chips, extended with one new
 * `data-live` attribute selector in `agents.css` (no new color, no new component).
 */

import { Eyebrow, Icon, Machine } from '@/components/primitives';
import { useGatewayAgentDispatches } from '@/prototype/state/gateway-agent-dispatches';
import type { AgentDispatchRow } from '@/prototype/state/gateway-agent-dispatches';

interface DispatchGroup {
  readonly subagentType: string;
  readonly count: number;
  readonly runningCount: number;
}

function groupBySubagentType(rows: readonly AgentDispatchRow[]): readonly DispatchGroup[] {
  const byType = new Map<string, DispatchGroup>();
  for (const row of rows) {
    const existing = byType.get(row.subagentType);
    if (existing === undefined) {
      byType.set(row.subagentType, { subagentType: row.subagentType, count: 1, runningCount: row.running ? 1 : 0 });
    } else {
      byType.set(row.subagentType, {
        subagentType: row.subagentType,
        count: existing.count + 1,
        runningCount: existing.runningCount + (row.running ? 1 : 0),
      });
    }
  }
  return [...byType.values()].sort((a, b) => a.subagentType.localeCompare(b.subagentType));
}

function DispatchChip({ group }: { group: DispatchGroup }) {
  const isRunning = group.runningCount > 0;
  const title = isRunning
    ? `${group.subagentType}: ${group.runningCount} dispatch${group.runningCount === 1 ? '' : 'es'} running right now (${group.count} recorded in total)`
    : `${group.subagentType}: ${group.count} dispatch${group.count === 1 ? '' : 'es'} recorded — none currently running`;
  return (
    <span className="fw-agents-chip" data-live={isRunning ? 'running' : 'dispatched'} title={title}>
      <Icon name={isRunning ? 'Loader' : 'Clock'} size="xs" spin={isRunning} />
      <Machine>{group.subagentType}</Machine>
      <span className="fw-agents-chip__count">{group.count}</span>
    </span>
  );
}

export interface LiveAgentsStripProps {
  /** Real registry size for the active project — `AgentsView`'s own `state.data.agents.length`,
   *  never re-derived here. Distinguishes the "no registry at all" empty state from the "registry
   *  exists, nothing dispatched yet" one. */
  readonly agentCount: number;
  /** The active project's own id — passed down rather than read from `usePrototype()` a second
   *  time, so this component stays a pure function of its props for testing. */
  readonly projectId: string;
}

export function LiveAgentsStrip({ agentCount, projectId }: LiveAgentsStripProps) {
  const dispatches = useGatewayAgentDispatches(projectId);

  /* REAL DISPATCHES ALWAYS WIN over either empty state (coordinator finding 2026-07-30, measured in a
   * real browser against a real run): the `agentCount === 0` branch used to come FIRST, so a project
   * without a Forge agent registry showed "No Forge agent registry found for this project." even while
   * `GET /api/agent-dispatches` was returning a genuine `{"subagent_type":"Explore","description":
   * "Count .md files in project directory","resolved_status":"completed"}`. That is the owner's original
   * complaint ("ik zie ook niks als agents die runnen") reproduced by the very strip meant to fix it.
   * The registry line is about the ROSTER below, not about live activity — so it is now a note
   * alongside the real dispatches rather than a gate in front of them. */
  if (dispatches.length === 0 && agentCount === 0) {
    return (
      <div className="fw-agents__live" role="status">
        <span className="fw-agents__live-head">
          <Icon name="Activity" size="xs" />
          <Eyebrow>Live now</Eyebrow>
        </span>
        <p className="fw-agents__live-empty">No Forge agent registry found for this project.</p>
      </div>
    );
  }

  if (dispatches.length === 0) {
    return (
      <div className="fw-agents__live" role="status">
        <span className="fw-agents__live-head">
          <Icon name="Activity" size="xs" />
          <Eyebrow>Live now</Eyebrow>
        </span>
        <p className="fw-agents__live-empty">
          No subagent dispatch recorded yet for this project&rsquo;s conversations.
        </p>
      </div>
    );
  }

  const groups = groupBySubagentType(dispatches);
  const anyRunning = groups.some((g) => g.runningCount > 0);

  return (
    <div className="fw-agents__live" role="status">
      <span className="fw-agents__live-head">
        <Icon name="Activity" size="xs" />
        <Eyebrow>Live now</Eyebrow>
      </span>
      <ul className="fw-agents__live-chips">
        {groups.map((group) => (
          <li key={group.subagentType}>
            <DispatchChip group={group} />
          </li>
        ))}
      </ul>
      <p className="fw-agents__live-note">
        {anyRunning
          ? 'A running count is only ever shown when the conversation that dispatched it is genuinely still executing right now — everything else recorded here is a past dispatch.'
          : 'None of these are currently running — every dispatch above already finished (or its conversation is no longer executing).'}
        {agentCount === 0
          ? ' This project has no Forge agent registry, so the roster below is empty — these are subagents the Claude Code session dispatched on its own.'
          : ''}
      </p>
    </div>
  );
}

export default LiveAgentsStrip;
