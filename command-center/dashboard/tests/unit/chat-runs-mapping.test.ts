/**
 * feat-chatruns-tabs — pure-function tests for the chat-run mapping seam in `gateway-adapter.ts`:
 * `parseChatRunRows` (the real `GET /api/chat-runs` response shape), `chatRunStatusToStatusKey`,
 * and the two view-facing builders `toGatewayChatRunTasks`/`toGatewayChatRunArtifacts` that feed
 * chat-run data into the EXISTING `PrototypeDataset.tasks`/`.artifacts` arrays TasksView/
 * ArtifactsView already render — no new component, no new field on a frozen type.
 *
 * No network, no React, no timers — mirrors `gateway-adapter-antifabrication.test.ts`'s own
 * precedent for this seam: real gateway-shaped fixtures through the actual production mapping.
 */

import { describe, expect, it } from 'vitest';

import {
  chatRunStatusToStatusKey,
  parseChatRunRows,
  toGatewayChatRunArtifacts,
  toGatewayChatRunTasks,
  type ChatRunFileEditRow,
  type ChatRunRow,
} from '@/prototype/state/gateway-adapter';

/**
 * feat-chatrun-diff: a file-edit row with NO recorded before/after text — the exact shape an older
 * run has. Every assertion in this file predates the diff projection and is about path/tool/kind
 * only, so the honest "no diff recorded" shape is the right constant for all of them; the diff
 * projection itself has its own dedicated file (`chat-run-diff.test.ts`).
 */
function noDiff(tool: string, filePath: string): ChatRunFileEditRow {
  return { tool, filePath, oldString: null, newString: null, content: null, diffState: 'none', diffBudgetChars: null };
}

function baseChatRun(overrides: Partial<ChatRunRow> = {}): ChatRunRow {
  return {
    runId: 'chat-c-abc123-t-xyz789',
    title: 'Build a landing page for LittleBazzar',
    status: 'completed',
    startedAt: '2026-07-30T09:00:00.000Z',
    endedAt: '2026-07-30T09:04:00.000Z',
    durationMs: 240000,
    stopReason: 'end_turn',
    model: 'claude-opus-5',
    inputTokens: 500,
    outputTokens: 900,
    todos: [],
    fileEdits: [],
    ...overrides,
  };
}

describe('parseChatRunRows — the real GET /api/chat-runs response shape', () => {
  it('parses a real, fully-populated chat-run row', () => {
    const rows = parseChatRunRows({
      ok: true,
      chat_runs: [
        {
          run_id: 'chat-c-1-t-1',
          title: 'Real prompt title',
          status: 'completed',
          started_at: '2026-07-30T09:00:00.000Z',
          ended_at: '2026-07-30T09:01:00.000Z',
          duration_ms: 60000,
          stop_reason: 'end_turn',
          model: 'claude-sonnet-5',
          input_tokens: 10,
          output_tokens: 20,
          todos: [{ content: 'Draft the hero section', status: 'completed', activeForm: 'Drafting the hero section' }],
          file_edits: [{ tool: 'Write', file_path: '/proj/index.html' }],
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      runId: 'chat-c-1-t-1',
      title: 'Real prompt title',
      status: 'completed',
      startedAt: '2026-07-30T09:00:00.000Z',
      endedAt: '2026-07-30T09:01:00.000Z',
      durationMs: 60000,
      stopReason: 'end_turn',
      model: 'claude-sonnet-5',
      inputTokens: 10,
      outputTokens: 20,
      todos: [{ content: 'Draft the hero section', status: 'completed', activeForm: 'Drafting the hero section' }],
      // feat-chatrun-diff: this fixture's `file_edits` entry carries no diff fields (it predates
      // the projection), so the honest `'none'` shape is what comes back — see
      // `chat-run-diff.test.tsx` for the widened shape and for what `'present'` looks like.
      fileEdits: [noDiff('Write', '/proj/index.html')],
    });
  });

  it('a response with no chat_runs field at all reads back an empty array, never fabricated', () => {
    expect(parseChatRunRows({ ok: true })).toEqual([]);
  });

  it('a genuinely empty chat_runs array stays empty (leeg blijft leeg)', () => {
    expect(parseChatRunRows({ ok: true, chat_runs: [] })).toEqual([]);
  });

  it('a still-running chat-run (no ended_at/model/tokens yet) reads back honest nulls, never guessed values', () => {
    const rows = parseChatRunRows({
      ok: true,
      chat_runs: [
        {
          run_id: 'chat-c-2-t-2',
          title: 'Still working on this one',
          status: 'running',
          started_at: '2026-07-30T09:00:00.000Z',
          ended_at: null,
          duration_ms: null,
          stop_reason: null,
          model: null,
          input_tokens: null,
          output_tokens: null,
          todos: [],
          file_edits: [],
        },
      ],
    });
    expect(rows[0].endedAt).toBeNull();
    expect(rows[0].model).toBeNull();
    expect(rows[0].inputTokens).toBeNull();
    expect(rows[0].outputTokens).toBeNull();
  });
});

describe('chatRunStatusToStatusKey', () => {
  it('maps the real gateway vocabulary onto the closed StatusKey set', () => {
    expect(chatRunStatusToStatusKey('running')).toBe('running');
    expect(chatRunStatusToStatusKey('completed')).toBe('completed');
    expect(chatRunStatusToStatusKey('failed')).toBe('failed');
  });

  it('"timed_out" maps to "failed" (the closest honest existing bucket) — never a fabricated new status', () => {
    expect(chatRunStatusToStatusKey('timed_out')).toBe('failed');
  });

  it('an unrecognized/null status falls back to the quiet "idle", never a fake "waiting", never throws', () => {
    expect(chatRunStatusToStatusKey(null)).toBe('idle');
    expect(chatRunStatusToStatusKey('some-future-status')).toBe('idle');
  });
});

describe('toGatewayChatRunTasks — real TodoWrite items as real Task rows', () => {
  it('maps each todo to its own Task with the exact real content/status/id', () => {
    const row = baseChatRun({
      todos: [
        { content: 'Draft the hero section', status: 'completed', activeForm: 'Drafting the hero section' },
        { content: 'Wire the contact form', status: 'in_progress', activeForm: 'Wiring the contact form' },
        { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' },
      ],
    });

    const tasks = toGatewayChatRunTasks(row);
    expect(tasks).toHaveLength(3);

    expect(tasks[0].id).toBe('chat-c-abc123-t-xyz789-todo-0');
    expect(tasks[0].title).toBe('Drafting the hero section');
    expect(tasks[0].status).toBe('completed');
    expect(tasks[0].progress).toBe(100);
    expect(tasks[0].agentId).toBe('');
    expect(tasks[0].workPackageId).toBe('');
    expect(tasks[0].detail).toContain('chat-c-abc123-t-xyz789');
    expect(tasks[0].detail).toContain('Build a landing page for LittleBazzar');
    expect(tasks[0].detail).toContain('Draft the hero section');

    expect(tasks[1].status).toBe('running');
    expect(tasks[1].progress).toBe(0);

    expect(tasks[2].status).toBe('waiting');
    expect(tasks[2].progress).toBe(0);
  });

  it('a chat-run with no todos yet produces zero tasks, never a fabricated placeholder', () => {
    expect(toGatewayChatRunTasks(baseChatRun({ todos: [] }))).toEqual([]);
  });

  it('a pending todo is honestly "waiting" (genuinely queued); an unrecognized status falls back to the quiet "idle"', () => {
    const tasks = toGatewayChatRunTasks(
      baseChatRun({ todos: [
        { content: 'queued todo', status: 'pending', activeForm: null },
        { content: 'a todo', status: 'some-future-status', activeForm: null },
      ] }),
    );
    expect(tasks[0].status).toBe('waiting'); // pending = genuinely queued
    expect(tasks[1].status).toBe('idle'); // unrecognized = absence of a claim
    expect(tasks[1].title).toBe('a todo'); // activeForm is null -> falls back to content, never "Chat todo" when content exists
  });
});

describe('toGatewayChatRunArtifacts — real file edits as real Artifact rows, honestly labelled', () => {
  it('maps each file edit to its own Artifact with path + tool in a clearly labelled preview', () => {
    const row = baseChatRun({
      fileEdits: [noDiff('Write', '/proj/index.html'), noDiff('Edit', '/proj/serve.mjs')],
    });

    const artifacts = toGatewayChatRunArtifacts(row);
    expect(artifacts).toHaveLength(2);

    expect(artifacts[0].id).toBe('chat-c-abc123-t-xyz789-file-0');
    expect(artifacts[0].name).toBe('/proj/index.html');
    expect(artifacts[0].kind).toBe('log');
    expect(artifacts[0].producedBy).toBe('chat-c-abc123-t-xyz789');
    expect(artifacts[0].taskId).toBeNull();
    expect(artifacts[0].size).toBe(''); // never a fabricated byte count
    expect(artifacts[0].preview).toBe('Write · /proj/index.html');

    expect(artifacts[1].preview).toBe('Edit · /proj/serve.mjs');
  });

  it('a chat-run with no file edits produces zero artifacts, never a fabricated one', () => {
    expect(toGatewayChatRunArtifacts(baseChatRun({ fileEdits: [] }))).toEqual([]);
  });

  it('producedBy is always visibly distinct from a real Forge run id (never reads as Forge-mission evidence)', () => {
    const artifacts = toGatewayChatRunArtifacts(baseChatRun({ fileEdits: [noDiff('Write', '/a.txt')] }));
    expect(artifacts[0].producedBy.startsWith('chat-')).toBe(true);
    expect(artifacts[0].producedBy.startsWith('forge-')).toBe(false);
  });
});

/**
 * A chat-run file change must land under the artifact kind its REAL extension implies.
 *
 * Lead follow-up (2026-07-30): every file change used to be `kind: 'log'`, so a Markdown file the
 * agent had just written was invisible under the Artifacts view's own MARKDOWN filter — the filter
 * then honestly reported "nothing of that kind" about something that was right there. Proven live
 * on littlebazzar (NOTES.md + index.html from one real bypass run).
 */
describe('chat-run artifact kinds follow the real file extension', () => {
  const rowWith = (paths: readonly string[]) =>
    ({
      runId: 'chat-c-1-t-1',
      conversationId: 'c-1',
      title: 't',
      status: 'completed' as const,
      startedAt: '2026-07-30T00:00:00.000Z',
      endedAt: '2026-07-30T00:00:10.000Z',
      durationMs: 10_000,
      stopReason: 'end_turn',
      model: 'claude-fable-5',
      inputTokens: 1,
      outputTokens: 2,
      todos: [],
      fileEdits: paths.map((p) => ({ tool: 'Write', filePath: p, oldString: null, newString: null })),
    }) as unknown as Parameters<typeof toGatewayChatRunArtifacts>[0];

  it('maps a real .md path to the markdown kind, not log', () => {
    const [artifact] = toGatewayChatRunArtifacts(rowWith(['C:/p/NOTES.md']));
    expect(artifact.kind).toBe('markdown');
  });

  it('maps a real image path to the screenshot kind', () => {
    const [artifact] = toGatewayChatRunArtifacts(rowWith(['C:/p/shot.png']));
    expect(artifact.kind).toBe('screenshot');
  });

  it('keeps log as the honest catch-all for anything else', () => {
    const kinds = toGatewayChatRunArtifacts(rowWith(['C:/p/index.html', 'C:/p/a.ts', 'C:/p/noext'])).map((a) => a.kind);
    expect(kinds).toEqual(['log', 'log', 'log']);
  });

  it('never throws on a missing path', () => {
    // Built with a null path from the start — the row type is readonly, and casting the readonly
    // array to a mutable one just to poke it would be a lie about the shape under test.
    const row = rowWith([]);
    const withNullPath = {
      ...row,
      fileEdits: [{ tool: 'Write', filePath: null, oldString: null, newString: null }],
    } as unknown as Parameters<typeof toGatewayChatRunArtifacts>[0];
    expect(toGatewayChatRunArtifacts(withNullPath)[0].kind).toBe('log');
  });
});
