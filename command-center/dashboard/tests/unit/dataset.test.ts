/**
 * Integrity of the example dataset.
 *
 * The prototype only looks convincing if its example data hangs together: a task
 * pointing at an agent that does not exist, or a graph edge pointing into thin
 * air, shows up immediately as a broken screen. These tests hold the fixture to
 * the same standard a real dataset would be held to.
 */

import { describe, expect, it } from 'vitest';
// The example dataset moved to prototype/fixtures/ when it was retired from the
// production path. This suite tests the FIXTURES themselves, so it reads them
// straight from that source rather than through the (now empty-in-production) gate.
import { FIXTURE_DATASET as PROTOTYPE_DATASET } from '@/prototype/fixtures';
import { STATUS_KEYS, TASK_COLUMNS } from '@/prototype/types/prototype-types';

const d = PROTOTYPE_DATASET;

function ids(list: readonly { id: string }[]): Set<string> {
  return new Set(list.map((x) => x.id));
}

function expectUnique(list: readonly { id: string }[], what: string): void {
  const seen = new Map<string, number>();
  list.forEach((x) => seen.set(x.id, (seen.get(x.id) ?? 0) + 1));
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  expect(dupes, `duplicate ${what} ids: ${dupes.join(', ')}`).toEqual([]);
}

describe('every record is flagged as example data', () => {
  const collections: [string, readonly { prototype: true }[]][] = [
    ['projects', d.projects],
    ['conversations', d.conversations],
    ['agents', d.agents],
    ['tasks', d.tasks],
    ['workPackages', d.workPackages],
    ['runs', d.runs],
    ['events', d.events],
    ['artifacts', d.artifacts],
    ['gates', d.gates],
    ['proof', d.proof],
    ['graph.nodes', d.graph.nodes],
    ['graph.edges', d.graph.edges],
    ['graph.lanes', d.graph.lanes],
  ];

  it.each(collections)('%s all carry prototype: true', (_name, list) => {
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((r) => r.prototype === true)).toBe(true);
  });

  it('nested chat messages carry the flag too', () => {
    const messages = d.conversations.flatMap((c) => c.messages);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.prototype === true)).toBe(true);
  });

  it('nested file nodes carry the flag at every depth', () => {
    const walk = (nodes: readonly { prototype: true; children?: readonly never[] }[]): boolean =>
      nodes.every(
        (n) =>
          n.prototype === true &&
          (!n.children || walk(n.children as unknown as readonly { prototype: true }[])),
      );
    expect(walk(d.files as never)).toBe(true);
  });
});

describe('the dataset is internally consistent', () => {
  it('has unique ids per collection', () => {
    expectUnique(d.projects, 'project');
    expectUnique(d.agents, 'agent');
    expectUnique(d.tasks, 'task');
    expectUnique(d.workPackages, 'work package');
    expectUnique(d.conversations, 'conversation');
    expectUnique(d.artifacts, 'artifact');
    expectUnique(d.gates, 'gate');
    expectUnique(d.graph.nodes, 'graph node');
  });

  it('tasks reference agents and work packages that exist', () => {
    const agentIds = ids(d.agents);
    const wpIds = ids(d.workPackages);
    const badAgent = d.tasks.filter((t) => !agentIds.has(t.agentId)).map((t) => t.id);
    const badWp = d.tasks.filter((t) => !wpIds.has(t.workPackageId)).map((t) => t.id);
    expect(badAgent, `tasks with unknown agentId: ${badAgent.join(', ')}`).toEqual([]);
    expect(badWp, `tasks with unknown workPackageId: ${badWp.join(', ')}`).toEqual([]);
  });

  it('task dependencies point at real tasks', () => {
    const taskIds = ids(d.tasks);
    const broken = d.tasks.flatMap((t) => t.dependencies.filter((dep) => !taskIds.has(dep)));
    expect(broken, `unknown task dependencies: ${broken.join(', ')}`).toEqual([]);
  });

  it('work packages own tasks that exist', () => {
    const taskIds = ids(d.tasks);
    const agentIds = ids(d.agents);
    const broken = d.workPackages.flatMap((w) => w.taskIds.filter((t) => !taskIds.has(t)));
    expect(broken, `work packages referencing unknown tasks: ${broken.join(', ')}`).toEqual([]);
    expect(d.workPackages.every((w) => agentIds.has(w.ownerAgentId))).toBe(true);
  });

  it('conversations belong to real projects', () => {
    const projectIds = ids(d.projects);
    expect(d.conversations.every((c) => projectIds.has(c.projectId))).toBe(true);
  });

  it('graph edges connect nodes that exist', () => {
    const nodeIds = ids(d.graph.nodes);
    const broken = d.graph.edges
      .filter((e) => !nodeIds.has(e.from) || !nodeIds.has(e.to))
      .map((e) => `${e.from}->${e.to}`);
    expect(broken, `dangling graph edges: ${broken.join(', ')}`).toEqual([]);
  });

  it('graph nodes sit in lanes that exist', () => {
    const laneIds = ids(d.graph.lanes);
    const broken = d.graph.nodes.filter((n) => n.laneId !== null && !laneIds.has(n.laneId)).map((n) => n.id);
    expect(broken, `nodes in unknown lanes: ${broken.join(', ')}`).toEqual([]);
  });

  it('uses only declared status keys and task columns', () => {
    const statuses = new Set<string>(STATUS_KEYS);
    const columns = new Set<string>(TASK_COLUMNS);
    expect(d.tasks.every((t) => statuses.has(t.status))).toBe(true);
    expect(d.tasks.every((t) => columns.has(t.column))).toBe(true);
    expect(d.agents.every((a) => statuses.has(a.status))).toBe(true);
    expect(d.projects.every((p) => statuses.has(p.status))).toBe(true);
  });

  it('keeps progress values in range', () => {
    expect(d.agents.every((a) => a.progress >= 0 && a.progress <= 100)).toBe(true);
    expect(d.tasks.every((t) => t.progress >= 0 && t.progress <= 100)).toBe(true);
  });
});

describe('the dataset is rich enough to be convincing', () => {
  it('ships the seven example projects', () => {
    expect(d.projects).toHaveLength(7);
    const names = d.projects.map((p) => p.name);
    for (const expected of [
      'Autonomous Commerce Factory',
      'Football Edge Intelligence',
      'AI Chatbot',
      'O.A. Celikkaya Website',
      'Forge Research Lab',
      'NovaDesk AI',
      'n8n Automation Suite',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('ships the full agent team', () => {
    expect(d.agents.length).toBeGreaterThanOrEqual(18);
    const names = d.agents.map((a) => a.name);
    for (const expected of [
      'Boss',
      'Head Chef',
      'Build Boss',
      'Test Boss',
      'Review Boss',
      'Security Boss',
      'UI Boss',
      'SEO Boss',
      'Search Boss',
      'Skill Boss',
      'Integration Boss',
      'Docs Boss',
      'Verify Agent',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('covers every kanban column with at least one task', () => {
    const used = new Set(d.tasks.map((t) => t.column));
    const missing = TASK_COLUMNS.filter((c) => !used.has(c));
    expect(missing, `columns with no example task: ${missing.join(', ')}`).toEqual([]);
  });

  it('ships the twelve quality gates, not all passing', () => {
    expect(d.gates).toHaveLength(12);
    const statuses = new Set(d.gates.map((g) => g.status));
    expect(statuses.has('failed') || statuses.has('blocked')).toBe(true);
  });

  it('ships the named artifacts the review asks for', () => {
    const names = d.artifacts.map((a) => a.name);
    for (const expected of [
      'mission-blueprint.md',
      'task-plan.md',
      'ui-review.md',
      'security-report.md',
      'playwright-desktop.png',
      'playwright-mobile.png',
      'verification-report.md',
      'final-report.md',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('has a proof ledger that records rejections, not only successes', () => {
    expect(d.proof.length).toBeGreaterThanOrEqual(10);
    expect(d.proof.some((p) => p.verdict === 'rejected')).toBe(true);
    expect(d.proof.every((p) => p.reason.length > 0)).toBe(true);
  });

  it('has a mission graph with parallel lanes and a feedback loop', () => {
    expect(d.graph.lanes.length).toBeGreaterThanOrEqual(6);
    expect(d.graph.nodes.length).toBeGreaterThanOrEqual(20);
    expect(d.graph.edges.some((e) => e.kind === 'feedback')).toBe(true);
    const cols = d.graph.nodes.map((n) => n.col);
    expect(Math.max(...cols)).toBeGreaterThanOrEqual(7);
  });

  it('has at least three conversations with a real thread', () => {
    const threaded = d.conversations.filter((c) => c.messages.length >= 6);
    expect(threaded.length).toBeGreaterThanOrEqual(3);
  });

  it('includes the barbershop flagship conversation', () => {
    const all = d.conversations.flatMap((c) => c.messages);
    expect(all.some((m) => /barbershop/i.test(m.body))).toBe(true);
  });

  it('records enough activity to fill the timeline', () => {
    expect(d.events.length).toBeGreaterThanOrEqual(30);
  });
});
