/**
 * `gateway-chat.ts` — feat-live-stream (`forge-2026-07-29-cc-finish`/`forge-2026-07-30-cc-finish`
 * work package `feat-live-stream`).
 *
 * TWO REAL GAPS THIS CLOSES (named by the owner, confirmed against the gateway's own real code):
 *
 *   1. `exec-bridge.mjs` only ever wrote `file_edits`/`todos`/`shell_commands` onto the CLOSING
 *      assistant turn record — during a still-running turn the owner saw nothing. The gateway now
 *      also appends real, individually-kinded `event` records (`file_edit`/`todo_snapshot`/
 *      `shell_command`/`shell_result`) the MOMENT each tool_use/tool_result block arrives (see
 *      `gateway/test/exec-bridge.test.mjs`'s own "LIVE STREAM" section for the gateway-side proof).
 *      This file's job is the DASHBOARD half: folding those same real events into one synthetic,
 *      clearly-marked "still running" message so `ChatView`/`Message` render real progress before
 *      the turn ever closes — never fabricated, and never present when there is genuinely nothing
 *      to show yet.
 *
 *   2. Real Bash tool_use + tool_result activity (`shell_commands`, verified live shape captured
 *      from this project's own `.data/conversations/*.jsonl` — see `exec-bridge.test.mjs`'s
 *      `REAL_TOOL_USE_BASH`/`REAL_TOOL_RESULT_BASH` fixtures) is now carried onto `ChatMessage`
 *      alongside `fileEdits`, through the SAME `toGatewayMessage` production mapping.
 *
 * Fixtures are real `GET /api/conversations/:id` turn/event shapes, run through the ACTUAL
 * production mapping (`toGatewayMessage`) and the ACTUAL hook (`useGatewayConversations`), never a
 * hand-rolled stand-in — mirrors `gateway-chat-turn-artifacts.test.ts`'s own established
 * convention for this file.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import {
  readChatMessageIsLive,
  readChatMessageShellCommands,
  toGatewayMessage,
  useGatewayConversations,
} from '@/prototype/state/gateway-chat';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ========================================================================== */
/*  toGatewayMessage — real shell_commands (item 3)                          */
/* ========================================================================== */

function assistantTurnWithShellCommands(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'turn',
    turn_id: 't-shell',
    role: 'assistant',
    created_at: '2026-07-30T00:00:00.000Z',
    text: 'Ran a diagnostic.',
    exit_code: 0,
    shell_commands: [
      {
        tool: 'Bash',
        id: 'toolu_015tQnaS1m8r5B9NX1fqT9ck',
        command: 'curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/',
        description: 'Curl diagnostics against port 3000',
        result: '200',
        is_error: false,
      },
    ],
    ...overrides,
  };
}

describe('toGatewayMessage — real shell_commands (feat-live-stream item 3)', () => {
  it('reads a real Bash command entry with id/command/description/result/isError intact', () => {
    const message = toGatewayMessage(assistantTurnWithShellCommands(), 0);
    const commands = readChatMessageShellCommands(message);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({
      id: 'toolu_015tQnaS1m8r5B9NX1fqT9ck',
      command: 'curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/',
      description: 'Curl diagnostics against port 3000',
      result: '200',
      isError: false,
    });
  });

  it('a turn with shell_commands: null (no Bash this turn) reads back an empty array, never a fabricated placeholder', () => {
    const message = toGatewayMessage({ type: 'turn', turn_id: 't-none', role: 'assistant', created_at: '', text: 'no tools', shell_commands: null }, 0);
    expect(readChatMessageShellCommands(message)).toEqual([]);
  });

  it('a fixture-shaped message with no shellCommands runtime field at all also reads back empty (defensive, never throws)', () => {
    const fixtureMessage = { id: 'm-1', author: 'forge', body: 'hi', timestamp: '' } as unknown as Parameters<typeof readChatMessageShellCommands>[0];
    expect(readChatMessageShellCommands(fixtureMessage)).toEqual([]);
  });

  it('readChatMessageIsLive is false for any ordinary, real gateway-sourced message', () => {
    const message = toGatewayMessage(assistantTurnWithShellCommands(), 0);
    expect(readChatMessageIsLive(message)).toBe(false);
  });
});

/* ========================================================================== */
/*  useGatewayConversations — the live-activity placeholder (item 1)         */
/* ========================================================================== */

const USER_TURN = { type: 'turn', turn_id: 't-pending', role: 'user', text: 'build the site', created_at: '2026-07-30T00:00:00.000Z' };

function stubConversationDetail(turns: readonly unknown[], events: readonly unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/conversations')) {
        return jsonResponse({ conversations: [{ id: 'c-1', title: 'Test', project: 'demo-project', updated_at: '', turn_count: turns.length }] });
      }
      if (url.endsWith('/api/conversations/c-1')) {
        return jsonResponse({ ok: true, id: 'c-1', turns, events });
      }
      return jsonResponse({});
    }),
  );
}

async function mountAndSettle(activeConversationId: string) {
  const hook = renderHook(() => useGatewayConversations(activeConversationId));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return hook;
}

describe('useGatewayConversations — a genuinely still-running turn renders real live activity (feat-live-stream item 1)', () => {
  it('appends ONE synthetic live message built from real file_edit/todo_snapshot/shell_command/shell_result events, marked isLiveActivity', async () => {
    const events = [
      { type: 'event', turn_id: 't-pending', kind: 'file_edit', data: { tool: 'Edit', file_path: '/proj/a.txt', old_string: 'old', new_string: 'new' } },
      { type: 'event', turn_id: 't-pending', kind: 'todo_snapshot', data: { todos: [{ content: 'Do the thing', status: 'in_progress', activeForm: 'Doing the thing' }] } },
      { type: 'event', turn_id: 't-pending', kind: 'shell_command', data: { tool: 'Bash', id: 'toolu_1', command: 'echo hi', description: 'Say hi', result: null, is_error: null } },
      { type: 'event', turn_id: 't-pending', kind: 'shell_result', data: { id: 'toolu_1', result: 'hi\n', is_error: false } },
    ];
    stubConversationDetail([USER_TURN], events);

    const { result } = await mountAndSettle('c-1');
    const conversation = result.current.find((c) => c.id === 'c-1');
    expect(conversation).toBeTruthy();
    // The real user turn plus exactly one synthetic live message.
    expect(conversation?.messages).toHaveLength(2);

    const live = conversation?.messages[1];
    expect(live).toBeTruthy();
    if (!live) return;
    expect(readChatMessageIsLive(live)).toBe(true);
    expect(live.body).toBe('');

    const shellCommands = readChatMessageShellCommands(live);
    expect(shellCommands).toHaveLength(1);
    // The live shell_result event's real result/is_error must be MERGED onto the same command
    // entry the shell_command event started — the whole point of the live correlation-by-id.
    expect(shellCommands[0]).toEqual({ id: 'toolu_1', command: 'echo hi', description: 'Say hi', result: 'hi\n', isError: false });

    expect(live.steps).toHaveLength(1);
    expect(live.steps?.[0].status).toBe('running');
  });

  it('never fabricates a live message when the pending turn has real events but genuinely NO tool activity at all (honest silence)', async () => {
    const events = [{ type: 'event', turn_id: 't-pending', kind: 'system', data: { subtype: 'init' } }];
    stubConversationDetail([USER_TURN], events);

    const { result } = await mountAndSettle('c-1');
    const conversation = result.current.find((c) => c.id === 'c-1');
    expect(conversation?.messages).toHaveLength(1); // the real user turn only — no extra bubble
  });

  it('never appends a live message once the turn has a REAL assistant reply — the real, final turn is authoritative', async () => {
    const assistantTurn = { type: 'turn', turn_id: 't-pending', role: 'assistant', text: 'Done.', created_at: '2026-07-30T00:00:05.000Z', file_edits: null, todos: null, shell_commands: null };
    const events = [
      { type: 'event', turn_id: 't-pending', kind: 'file_edit', data: { tool: 'Write', file_path: '/proj/b.txt', content: 'x' } },
    ];
    stubConversationDetail([USER_TURN, assistantTurn], events);

    const { result } = await mountAndSettle('c-1');
    const conversation = result.current.find((c) => c.id === 'c-1');
    expect(conversation?.messages).toHaveLength(2); // user + the real closed assistant turn, no third
    expect(conversation?.messages.every((m) => !readChatMessageIsLive(m))).toBe(true);
  });

  it('never appends a live message once the turn was stopped by the user (a real terminal event, not a real assistant reply)', async () => {
    const events = [
      { type: 'event', turn_id: 't-pending', kind: 'file_edit', data: { tool: 'Write', file_path: '/proj/c.txt', content: 'x' } },
      { type: 'event', turn_id: 't-pending', kind: 'stopped_by_user' },
    ];
    stubConversationDetail([USER_TURN], events);

    const { result } = await mountAndSettle('c-1');
    const conversation = result.current.find((c) => c.id === 'c-1');
    expect(conversation?.messages).toHaveLength(1);
  });

  it('with no user turn at all, there is nothing pending and no live message is ever built', async () => {
    stubConversationDetail([], []);
    const { result } = await mountAndSettle('c-1');
    const conversation = result.current.find((c) => c.id === 'c-1');
    expect(conversation?.messages).toHaveLength(0);
  });
});
