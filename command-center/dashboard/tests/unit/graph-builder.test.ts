/**
 * The live mission graph builder.
 *
 * `buildMissionGraph` is a pure fold from the real event log to a `MissionGraph`.
 * These tests pin the two ends of its honesty contract — an empty log yields an
 * empty graph, and a real log yields exactly the structure the events justify and
 * nothing more — plus the small-chat common case and the repair loop.
 */

import { describe, expect, it } from 'vitest';
import type { ForgeEvent, OperationalStatus } from '@/shared/protocol';
import { PROTOCOL_SCHEMA_VERSION } from '@/shared/protocol';
import { buildMissionGraph } from '@/prototype/state/graph-builder';

const BASE = Date.parse('2026-07-24T00:00:00.000Z');

interface EventSpec {
  readonly type: string;
  readonly runId?: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly status?: OperationalStatus;
  readonly payload?: Record<string, unknown>;
}

/** Builds a well-formed event; `seq` drives both sequence and a rising timestamp. */
function makeEvents(specs: readonly EventSpec[]): ForgeEvent[] {
  return specs.map((s, i) => {
    const seq = i + 1;
    return {
      eventId: `e${seq}`,
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      sequence: seq,
      timestamp: new Date(BASE + seq * 1000).toISOString(),
      projectId: s.projectId ?? 'proj-1',
      runId: s.runId ?? null,
      sessionId: null,
      conversationId: null,
      taskId: s.taskId ?? null,
      agentId: s.agentId ?? null,
      source: 'forge',
      type: s.type,
      ...(s.status ? { status: s.status } : {}),
      payload: s.payload ?? {},
      evidenceRefs: [],
    };
  });
}

describe('buildMissionGraph — the empty end', () => {
  it('an empty event list yields an empty graph', () => {
    const graph = buildMissionGraph([]);
    expect(graph.runId).toBe('');
    expect(graph.nodes).toHaveLength(0);
    expect(graph.lanes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('events with no run at all yield an empty graph', () => {
    const graph = buildMissionGraph(
      makeEvents([{ type: 'bridge.ready' }, { type: 'project.discovered' }]),
    );
    expect(graph.nodes).toHaveLength(0);
    expect(graph.lanes).toHaveLength(0);
  });

  it('bridge-scoped run events are not drawn as a user run', () => {
    const graph = buildMissionGraph(
      makeEvents([{ type: 'run.created', runId: 'r-bridge', projectId: '__bridge__' }]),
    );
    expect(graph.nodes).toHaveLength(0);
  });
});

describe('buildMissionGraph — the small-chat common case', () => {
  const graph = buildMissionGraph(
    makeEvents([
      { type: 'run.created', runId: 'r1', status: 'STARTING', payload: { goal: 'Say hello' } },
      { type: 'run.output.complete', runId: 'r1', status: 'COMPLETED' },
    ]),
  );

  it('is exactly request -> boss -> output, with no fabricated lanes', () => {
    expect(graph.runId).toBe('r1');
    expect(graph.lanes).toHaveLength(0);
    expect(graph.nodes.map((n) => n.kind)).toEqual(['request', 'boss', 'output']);
    expect(graph.nodes.map((n) => n.col)).toEqual([0, 1, 2]);
  });

  it('carries the real goal onto the request and a completed boss/output', () => {
    const request = graph.nodes.find((n) => n.kind === 'request');
    const boss = graph.nodes.find((n) => n.kind === 'boss');
    const output = graph.nodes.find((n) => n.kind === 'output');
    expect(request?.detail).toBe('Say hello');
    expect(boss?.status).toBe('completed');
    expect(output?.status).toBe('completed');
  });

  it('wires the spine boss -> output with no lane in between', () => {
    const froms = graph.edges.map((e) => `${e.from} -> ${e.to}`);
    expect(graph.edges).toHaveLength(2);
    expect(froms).toContain('r1::request -> r1::boss');
    expect(froms).toContain('r1::boss -> r1::output');
  });
});

describe('buildMissionGraph — a real multi-agent run with a repair loop', () => {
  const graph = buildMissionGraph(
    makeEvents([
      { type: 'run.created', runId: 'r2', status: 'STARTING', payload: { goal: 'Build X' } },
      // A ghost: an agent id brushes past in a message but never activates and
      // owns no task. It must NOT become a lane.
      { type: 'claude.message', runId: 'r2', agentId: 'ghost', payload: { text: 'hi' } },
      {
        type: 'agent.activated',
        runId: 'r2',
        agentId: 'a1',
        status: 'RUNNING',
        payload: { role: 'Build Boss', group: 'execution' },
      },
      { type: 'task.created', runId: 'r2', agentId: 'a1', taskId: 't1', status: 'RUNNING', payload: { title: 'Implement' } },
      { type: 'task.state', runId: 'r2', agentId: 'a1', taskId: 't1', status: 'COMPLETED' },
      { type: 'verify.started', runId: 'r2' },
      { type: 'verify.verdict', runId: 'r2', payload: { verdict: 'REJECTED' } },
      { type: 'task.created', runId: 'r2', agentId: 'a1', taskId: 't2', status: 'REPAIRING', payload: { title: 'Repair' } },
      { type: 'review.started', runId: 'r2' },
      { type: 'review.verdict', runId: 'r2', payload: { verdict: 'VERIFIED_PASS' } },
      { type: 'run.output.complete', runId: 'r2', status: 'COMPLETED' },
    ]),
  );

  it('draws one lane for the agent that activated, and none for the ghost', () => {
    expect(graph.lanes).toHaveLength(1);
    expect(graph.lanes[0].label).toBe('Build Boss');
    expect(graph.lanes[0].group).toBe('execution');
    expect(graph.nodes.some((n) => n.id.includes('ghost'))).toBe(false);
  });

  it('places lane-agent then its two step nodes, carrying real statuses', () => {
    const laneAgent = graph.nodes.find((n) => n.kind === 'lane-agent');
    const t1 = graph.nodes.find((n) => n.id === 'r2::task::t1');
    const t2 = graph.nodes.find((n) => n.id === 'r2::task::t2');
    expect(laneAgent?.status).toBe('running');
    expect(laneAgent?.col).toBe(2);
    expect(t1?.status).toBe('completed');
    expect(t1?.col).toBe(3);
    expect(t2?.status).toBe('running'); // REPAIRING projects to running
    expect(t2?.col).toBe(4);
  });

  it('draws the verify, review and output nodes to the right of the lane', () => {
    const verify = graph.nodes.find((n) => n.kind === 'verify');
    const review = graph.nodes.find((n) => n.kind === 'review');
    const output = graph.nodes.find((n) => n.kind === 'output');
    expect(verify?.status).toBe('failed'); // REJECTED
    expect(review?.status).toBe('completed'); // VERIFIED_PASS
    expect(output).toBeDefined();
    // spine on the right sits strictly past the lane region.
    expect(verify?.col).toBeGreaterThan(4);
    expect(review?.col).toBeGreaterThan(verify?.col ?? 0);
    expect(output?.col).toBeGreaterThan(review?.col ?? 0);
  });

  it('draws the repair loop as a feedback edge from the rejected verdict to the repair task', () => {
    const feedback = graph.edges.filter((e) => e.kind === 'feedback');
    expect(feedback).toHaveLength(1);
    expect(feedback[0].from).toBe('r2::verify');
    expect(feedback[0].to).toBe('r2::task::t2');
    expect(feedback[0].label).toBe('repair');
  });

  it('chains the lane into the spine tail: task -> verify -> review -> output', () => {
    const pairs = graph.edges.filter((e) => e.kind === 'flow').map((e) => `${e.from} -> ${e.to}`);
    expect(pairs).toContain('r2::task::t2 -> r2::verify');
    expect(pairs).toContain('r2::verify -> r2::review');
    expect(pairs).toContain('r2::review -> r2::output');
  });
});

describe('buildMissionGraph — run selection', () => {
  const events = makeEvents([
    { type: 'run.created', runId: 'r-old', status: 'COMPLETED', payload: { goal: 'first' } },
    { type: 'run.created', runId: 'r-new', status: 'RUNNING', payload: { goal: 'second' } },
  ]);

  it('defaults to the most recently active run', () => {
    expect(buildMissionGraph(events).runId).toBe('r-new');
  });

  it('honours an explicit run id', () => {
    expect(buildMissionGraph(events, 'r-old').runId).toBe('r-old');
  });

  it('every node carries a status the events justify (no invented status)', () => {
    const graph = buildMissionGraph(events, 'r-new');
    const boss = graph.nodes.find((n) => n.kind === 'boss');
    expect(boss?.status).toBe('running'); // RUNNING, not a made-up completion
    expect(graph.nodes.some((n) => n.kind === 'output')).toBe(false); // no output event
  });
});
