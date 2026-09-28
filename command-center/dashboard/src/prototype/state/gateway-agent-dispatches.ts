/**
 * gateway-agent-dispatches — the real, project-wide "which subagents are/were dispatched" signal
 * (feat-live-visibility, Gap B: "no 'live now' view of the agents actually working").
 *
 * Reads `GET /api/agent-dispatches?project=` (gateway/src/agent-dispatches.mjs), which scans the
 * active project's own conversations for real `task_started`/`task_updated` system events a
 * genuine `Agent` tool_use dispatch produces — see that gateway module's own header for the exact
 * captured shape and the honesty rule around `running` (only ever `true` for an unresolved
 * dispatch whose own conversation is CURRENTLY busy — never inferred any other way).
 *
 * SCOPE: the ACTIVE project's conversations only, same boundary `gateway-pending-asks.ts` and
 * every other project-scoped poll in this codebase already draws.
 */

import { useEffect, useState } from 'react';

import { gwGet, pickArray, pickBool, pickString } from '@/prototype/state/gateway-client';

import { PROJECT_DATA_POLL_MS, type Keyed } from './adapter/shared';

export interface AgentDispatchRow {
  readonly subagentType: string;
  readonly conversationId: string;
  readonly description: string | null;
  readonly startedAt: string | null;
  /** `true` only for a dispatch this gateway process can CURRENTLY prove is still running (an
   *  unresolved dispatch on a conversation that is genuinely busy right now) — never a guess. */
  readonly running: boolean;
  /** The real terminal status the CLI itself reported (`'completed'` in every case captured on
   *  this machine so far) — `null` while unresolved. Never hardcoded to a fixed English word. */
  readonly resolvedStatus: string | null;
  readonly endedAt: string | null;
  /**
   * WP-CCD (item 3): `GET /api/agent-dispatches` is being extended (in-flight gateway work, read
   * defensively — every field below is `null`/`false` on a gateway build that predates them, or on
   * a pre-existing chat-tool-use row that never carries them) to ALSO carry real, run-LOG-derived
   * dispatches alongside the pre-existing chat-tool-use ones (`source: 'run-log'` marks one; an
   * absent `source` stays the pre-existing chat-tool-use meaning). `agentName`/`agentSlug` are the
   * run-log row's own display name/registry slug (a Forge Boss, e.g. "Build Boss"/"build-boss") —
   * a genuinely different identity concept than `subagentType` (a Claude Code Agent-tool subagent
   * type, e.g. "Explore"/"general-purpose"), never conflated.
   */
  readonly source: string | null;
  readonly agentName: string | null;
  readonly agentSlug: string | null;
  readonly wpId: string | null;
  readonly task: string | null;
  readonly completedAt: string | null;
  readonly verdict: string | null;
  readonly stalled: boolean;
}

function toAgentDispatchRow(row: Record<string, unknown>): AgentDispatchRow {
  return {
    subagentType: pickString(row, ['subagent_type']) ?? '',
    conversationId: pickString(row, ['conversation_id']) ?? '',
    description: pickString(row, ['description']),
    startedAt: pickString(row, ['started_at']),
    running: pickBool(row, ['running']) ?? false,
    resolvedStatus: pickString(row, ['resolved_status']),
    endedAt: pickString(row, ['ended_at']),
    // WP-CCD (item 3).
    source: pickString(row, ['source']),
    agentName: pickString(row, ['agent']),
    agentSlug: pickString(row, ['agent_slug']),
    wpId: pickString(row, ['wp_id']),
    task: pickString(row, ['task']),
    completedAt: pickString(row, ['completed_at']),
    verdict: pickString(row, ['verdict']),
    stalled: pickBool(row, ['stalled']) ?? false,
  };
}

/** WP-CCD (item 3): the real identity a "live now" strip should GROUP a dispatch by — a run-log
 *  row's own agent display name (a Forge Boss) when present, otherwise the pre-existing
 *  chat-tool-use `subagentType` (a Claude Code Agent-tool subagent type). The two are genuinely
 *  different concepts and are never merged into one group — this only ensures a run-log row (whose
 *  `subagentType` is honestly empty, since it never went through the Agent tool at all) still gets
 *  a real, non-empty group key instead of silently collapsing into the empty-string bucket. */
export function dispatchGroupKey(row: AgentDispatchRow): string {
  return row.agentName ?? (row.subagentType !== '' ? row.subagentType : 'agent');
}

/** The real display label for one dispatch row — same identity `dispatchGroupKey` groups by. */
export function dispatchLabel(row: AgentDispatchRow): string {
  return dispatchGroupKey(row);
}

/** WP-CCD (item 3): the readable description for one dispatch — a run-log row's own real `task`
 *  text beats the pre-existing chat-tool-use `description`, falling back to it exactly as before. */
export function dispatchDescription(row: AgentDispatchRow): string | null {
  return row.task ?? row.description;
}

/** WP-CCD (item 3): the real end time for one dispatch — a run-log row's own `completedAt` beats
 *  the pre-existing chat-tool-use `endedAt`, falling back to it exactly as before. */
export function dispatchEndedAt(row: AgentDispatchRow): string | null {
  return row.completedAt ?? row.endedAt;
}

/** Maps `GET /api/agent-dispatches`'s real response 1:1 — a missing/absent `dispatches` field
 *  reads back an honest empty array, never fabricated. */
export function parseAgentDispatchRows(data: Record<string, unknown>): readonly AgentDispatchRow[] {
  return pickArray(data, ['dispatches']).map(toAgentDispatchRow);
}

const EMPTY_AGENT_DISPATCHES: readonly AgentDispatchRow[] = [];

/** Polls the active project's real subagent-dispatch list. An empty `projectName` (no project
 *  selected) never fetches and returns the stable empty array. */
export function useGatewayAgentDispatches(projectName: string): readonly AgentDispatchRow[] {
  const [state, setState] = useState<Keyed<readonly AgentDispatchRow[]>>({ key: '', value: EMPTY_AGENT_DISPATCHES });

  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/agent-dispatches?project=${encodeURIComponent(projectName)}`);
      if (cancelled || !result.ok) return;
      setState({ key: projectName, value: parseAgentDispatchRows(result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);

  return state.key === projectName ? state.value : EMPTY_AGENT_DISPATCHES;
}
