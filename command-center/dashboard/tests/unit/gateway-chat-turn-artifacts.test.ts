/**
 * `gateway-chat.ts`'s `toGatewayMessage` — real per-turn file edits + task progress
 * (fix-stream-insights, checkup #5 task progress / #6 diff view).
 *
 * BUG THIS CLOSES: `exec-bridge.mjs` already parses EVERY real stream-json `assistant` line,
 * including its `tool_use` content blocks (Edit/Write/TodoWrite), for every turn — but only the
 * accumulated reply TEXT was ever kept. The real Edit/Write blocks (file path + old/new string or
 * content) and the real TodoWrite blocks (the model's own task list) were parsed then thrown away.
 *
 * THE FIX: `exec-bridge.mjs` now writes a bounded `file_edits` array and a `todos` snapshot onto
 * the assistant turn record (see `gateway/test/exec-bridge.test.mjs`'s "TOOL ACTIVITY" section for
 * the real captured tool_use shapes this mirrors); `toGatewayMessage` reads both through defensively
 * (`readChatMessageFileEdits` for the new extra runtime field, and `ChatMessage`'s OWN pre-existing
 * `steps` field for todos — `Message.tsx` already renders a collapsible progress list for any
 * message carrying `steps`, so this reuses that existing rendering path rather than adding a new
 * one).
 *
 * Fixtures are real `GET /api/conversations/:id` turn shapes run through the ACTUAL production
 * mapping (`toGatewayMessage`, exported for this test), never a hand-rolled `ChatMessage` stand-in.
 * New file, matching this project's own convention of giving each WP's new capability its own test
 * file rather than growing a prior WP's file (e.g. `gateway-usage-token-model-capture.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import { readChatMessageFileEdits, toGatewayMessage } from '@/prototype/state/gateway-chat';
import type { ChatMessage } from '@/prototype/types/prototype-types';

/** A real assistant turn shape that called Edit + Write (see exec-bridge.test.mjs's own
 *  REAL_TOOL_USE_EDIT/REAL_TOOL_USE_WRITE fixtures for the source tool_use blocks this was
 *  captured from). */
function assistantTurnWithFileEdits(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'turn',
    turn_id: 't-1',
    role: 'assistant',
    created_at: '2026-07-29T00:00:00.000Z',
    text: 'Done.',
    exit_code: 0,
    file_edits: [
      { tool: 'Edit', file_path: 'C:\\proj\\serve.mjs', old_string: "location.replace('/');", new_string: "location.replace('/'+location.hash);" },
      { tool: 'Write', file_path: 'C:\\proj\\index.html', content: '<!doctype html>\n<title>Hi</title>\n' },
    ],
    todos: null,
    ...overrides,
  };
}

/** A real assistant turn shape whose last TodoWrite call reported a mixed-status task list (the
 *  exact real field names captured live: content/status/activeForm). */
function assistantTurnWithTodos(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'turn',
    turn_id: 't-2',
    role: 'assistant',
    created_at: '2026-07-29T00:01:00.000Z',
    text: 'Working on it.',
    exit_code: 0,
    file_edits: null,
    todos: [
      { content: 'Explore project context (files, docs, recent commits)', status: 'in_progress', activeForm: 'Exploring project context' },
      { content: 'Write design doc to docs/superpowers/specs/ and commit', status: 'pending', activeForm: 'Writing design doc' },
      { content: 'Spec self-review (placeholders, consistency, scope, ambiguity)', status: 'completed', activeForm: 'Self-reviewing spec' },
    ],
    ...overrides,
  };
}

function plainAssistantTurn(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'turn',
    turn_id: 't-3',
    role: 'assistant',
    created_at: '2026-07-29T00:02:00.000Z',
    text: 'Just a reply, no tools.',
    exit_code: 0,
    ...overrides,
  };
}

describe('toGatewayMessage — real file_edits (checkup #6, diff view)', () => {
  it('reads a real Edit tool_use entry with both old_string/new_string intact', () => {
    const message = toGatewayMessage(assistantTurnWithFileEdits(), 0);
    const edits = readChatMessageFileEdits(message);
    expect(edits).toHaveLength(2);
    expect(edits[0]).toEqual({
      tool: 'Edit',
      filePath: 'C:\\proj\\serve.mjs',
      oldString: "location.replace('/');",
      newString: "location.replace('/'+location.hash);",
      content: null,
    });
  });

  it('reads a real Write tool_use entry with content only (no fabricated old/new strings)', () => {
    const message = toGatewayMessage(assistantTurnWithFileEdits(), 0);
    const edits = readChatMessageFileEdits(message);
    expect(edits[1]).toEqual({
      tool: 'Write',
      filePath: 'C:\\proj\\index.html',
      oldString: null,
      newString: null,
      content: '<!doctype html>\n<title>Hi</title>\n',
    });
  });

  it('a turn with file_edits: null (no Edit/Write this turn) reads back an empty array, never a fabricated placeholder', () => {
    const message = toGatewayMessage(plainAssistantTurn(), 0);
    expect(readChatMessageFileEdits(message)).toEqual([]);
  });

  it('a fixture-shaped message with no fileEdits runtime field at all also reads back empty (defensive, never throws)', () => {
    const fixtureMessage = { id: 'm-1', author: 'forge', body: 'hi', timestamp: '' } as unknown as ChatMessage;
    expect(readChatMessageFileEdits(fixtureMessage)).toEqual([]);
  });
});

describe('toGatewayMessage — real todos mapped onto ChatMessage.steps (checkup #5, task progress)', () => {
  it('maps a real TodoWrite snapshot onto steps with the exact real status mapping (pending/in_progress/completed)', () => {
    const message = toGatewayMessage(assistantTurnWithTodos(), 0);
    expect(message.steps).toHaveLength(3);
    expect(message.steps?.[0]).toEqual({
      id: 't-2-todo-0',
      label: 'Exploring project context',
      status: 'running',
      detail: 'Explore project context (files, docs, recent commits)',
    });
    expect(message.steps?.[1].status).toBe('waiting');
    expect(message.steps?.[2].status).toBe('completed');
  });

  it('a turn with todos: null (no TodoWrite this turn) reads back an empty steps array, never a fabricated task', () => {
    const message = toGatewayMessage(plainAssistantTurn(), 0);
    expect(message.steps).toEqual([]);
  });

  it('an unrecognized status string falls back to "waiting" (the same safe default statusPresentation() itself uses), never throws', () => {
    const message = toGatewayMessage(
      assistantTurnWithTodos({
        todos: [{ content: 'a todo', status: 'some-future-status', activeForm: 'doing a todo' }],
      }),
      0,
    );
    expect(message.steps?.[0].status).toBe('waiting');
  });
});
