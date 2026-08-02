/**
 * feat-chatrun-diff — the dashboard half of "show what actually changed".
 *
 * The gateway already captured each Edit's `old_string`/`new_string` and each Write's `content`
 * (`gateway/src/exec-stream-parse.mjs`) and already redacted them on write and on read
 * (`gateway/src/conversation-redact.mjs`), but `chat-runs.mjs` projected them away, so the UI could
 * only ever say "not tracked" about a change the gateway genuinely had. The gateway projection is
 * widened; this file proves the dashboard carries that through to the screen, in the EXISTING
 * `Diff` component, with no new visual language.
 *
 * Four things are asserted, in this order:
 *   1. the adapter parses the widened `GET /api/chat-runs` shape (and stays honest against an
 *      older gateway that does not send `diff_state` at all);
 *   2. the artifact a chat-run file edit becomes carries a real, renderable diff;
 *   3. the inspector panel renders it in the existing `Diff` — and, when there is NO diff, says so
 *      instead of drawing an empty diff that would read as "nothing changed";
 *   4. SECURITY: a credential in `old_string`, `new_string`, `content` or the FILE PATH never
 *      reaches the screen. The fixture in that test is REAL captured output from the gateway's own
 *      redaction layer (see the test's own comment for exactly how it was produced) — not a
 *      hand-written approximation of what redaction is assumed to do.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import {
  parseChatRunRows,
  readChatRunArtifactDiff,
  toGatewayChatRunArtifacts,
} from '@/prototype/state/gateway-adapter';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { PrototypeState } from '@/prototype/state/prototype-store';
import type { Artifact } from '@/prototype/types/prototype-types';
import { buildArtifactDetail } from '@/components/shell/inspector-artifact-panel';

afterEach(() => cleanup());

function chatRunResponse(fileEdits: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    ok: true,
    chat_runs: [
      {
        run_id: 'chat-c-1-t-1',
        title: 'Real prompt title',
        status: 'completed',
        started_at: '2026-07-31T09:00:00.000Z',
        ended_at: '2026-07-31T09:01:00.000Z',
        duration_ms: 60000,
        stop_reason: 'end_turn',
        model: 'claude-opus-5',
        input_tokens: 10,
        output_tokens: 20,
        todos: [],
        file_edits: fileEdits,
      },
    ],
  };
}

function stateWith(artifacts: readonly Artifact[]): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, artifacts },
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: true,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: 'p-1',
    activeConversationId: '',
    selection: { kind: 'none' },
    pinnedProjectIds: [],
    projectQuery: '',
    agentFilter: 'all',
    agentLayout: 'grouped',
    taskLayout: 'kanban',
    taskColumnOverrides: {},
    extraMessages: {},
    stream: null,
    claudeCodeState: 'not-connected',
    toasts: [],
  };
}

function renderArtifactPanel(artifact: Artifact) {
  const state = stateWith([artifact]);
  const detail = buildArtifactDetail(state, { kind: 'artifact', id: artifact.id }, () => undefined, true);
  expect(detail).not.toBeNull();
  return render(<>{detail!.body}</>);
}

/** The single file edit of the single chat-run in `response`, as the Artifact the UI selects. */
function artifactFor(fileEdit: Record<string, unknown>): Artifact {
  const [row] = parseChatRunRows(chatRunResponse([fileEdit]));
  return toGatewayChatRunArtifacts(row)[0];
}

describe('parseChatRunRows carries the widened file-edit shape', () => {
  it("keeps an Edit's real before/after text and its diff_state", () => {
    const [row] = parseChatRunRows(
      chatRunResponse([
        {
          tool: 'Edit',
          file_path: '/proj/site.css',
          old_string: 'color: red;',
          new_string: 'color: rebeccapurple;',
          content: null,
          diff_state: 'present',
        },
      ]),
    );

    expect(row.fileEdits[0]).toEqual({
      tool: 'Edit',
      filePath: '/proj/site.css',
      oldString: 'color: red;',
      newString: 'color: rebeccapurple;',
      content: null,
      diffState: 'present',
      diffBudgetChars: null,
    });
  });

  it("keeps a Write's real content, with an honestly-null before", () => {
    const [row] = parseChatRunRows(
      chatRunResponse([{ tool: 'Write', file_path: '/proj/NOTES.md', content: '# Notes\nline', diff_state: 'present' }]),
    );
    expect(row.fileEdits[0].content).toBe('# Notes\nline');
    expect(row.fileEdits[0].oldString).toBeNull();
    expect(row.fileEdits[0].newString).toBeNull();
    expect(row.fileEdits[0].diffState).toBe('present');
  });

  it('an edit the gateway reported as budget-omitted keeps the real budget number', () => {
    const [row] = parseChatRunRows(
      chatRunResponse([
        { tool: 'Write', file_path: '/proj/big.txt', diff_state: 'omitted_budget', diff_budget_chars: 256000 },
      ]),
    );
    expect(row.fileEdits[0].diffState).toBe('omitted_budget');
    expect(row.fileEdits[0].diffBudgetChars).toBe(256000);
    expect(row.fileEdits[0].content).toBeNull();
  });

  it('an OLDER gateway that sends no diff fields at all reads back "none", never a guessed "present"', () => {
    const [row] = parseChatRunRows(chatRunResponse([{ tool: 'Edit', file_path: '/proj/legacy.js' }]));
    expect(row.fileEdits[0].diffState).toBe('none');
    expect(row.fileEdits[0].oldString).toBeNull();
  });

  it('an unrecognized diff_state string is never trusted as "present"', () => {
    const [row] = parseChatRunRows(
      chatRunResponse([{ tool: 'Edit', file_path: '/proj/x.js', diff_state: 'some-future-state' }]),
    );
    expect(row.fileEdits[0].diffState).toBe('none');
  });
});

describe('toGatewayChatRunArtifacts attaches a real, renderable diff', () => {
  it("builds an Edit's diff from the two real strings — removed lines then added lines", () => {
    const diff = readChatRunArtifactDiff(
      artifactFor({
        tool: 'Edit',
        file_path: '/proj/site.css',
        old_string: 'a\nb',
        new_string: 'a\nc',
        diff_state: 'present',
      }),
    );
    expect(diff).not.toBeNull();
    expect(diff!.state).toBe('present');
    expect(diff!.text).toBe('- a\n- b\n+ a\n+ c');
  });

  it("builds a Write's diff as added lines only (a Write has no 'before' to diff against)", () => {
    const diff = readChatRunArtifactDiff(
      artifactFor({ tool: 'Write', file_path: '/proj/NOTES.md', content: '# Notes\nline', diff_state: 'present' }),
    );
    expect(diff!.text).toBe('+ # Notes\n+ line');
  });

  it('an edit with no recorded diff carries state "none" and no text — never an empty diff string', () => {
    const diff = readChatRunArtifactDiff(artifactFor({ tool: 'Edit', file_path: '/proj/legacy.js' }));
    expect(diff!.state).toBe('none');
    expect(diff!.text).toBeNull();
  });

  it('a NON-chat artifact carries no diff at all (the reader never invents one)', () => {
    const forgeArtifact = {
      id: 'a-1',
      name: 'report.md',
      kind: 'markdown',
      producedBy: 'forge-2026-07-31-x',
      taskId: null,
      createdAt: '2026-07-31T09:00:00.000Z',
      size: '2 KB',
      preview: '# Report',
    } as unknown as Artifact;
    expect(readChatRunArtifactDiff(forgeArtifact)).toBeNull();
  });
});

describe('the inspector artifact panel renders the diff in the EXISTING Diff component', () => {
  it('shows the real removed/added lines for an Edit', () => {
    renderArtifactPanel(
      artifactFor({
        tool: 'Edit',
        file_path: '/proj/site.css',
        old_string: 'color: red;',
        new_string: 'color: rebeccapurple;',
        diff_state: 'present',
      }),
    );

    expect(screen.getByText('- color: red;')).toBeTruthy();
    expect(screen.getByText('+ color: rebeccapurple;')).toBeTruthy();
    // The existing Diff component's own line classification, unchanged.
    expect(screen.getByText('- color: red;').closest('[data-line]')?.getAttribute('data-line')).toBe('del');
    expect(screen.getByText('+ color: rebeccapurple;').closest('[data-line]')?.getAttribute('data-line')).toBe('add');
  });

  it('HONESTY: an edit with no recorded diff says so — it never renders an empty diff', () => {
    const { container } = renderArtifactPanel(artifactFor({ tool: 'Edit', file_path: '/proj/legacy.js' }));
    expect(screen.getByText(/No diff was recorded for this edit/i)).toBeTruthy();
    expect(container.querySelector('.fw-inspector__diff')).toBeNull();
  });

  it('HONESTY: a budget-omitted diff says why, with the real budget number — never a silent gap', () => {
    const { container } = renderArtifactPanel({
      ...artifactFor({
        tool: 'Write',
        file_path: '/proj/big.txt',
        diff_state: 'omitted_budget',
        diff_budget_chars: 256000,
      }),
    });
    expect(screen.getByText(/diff budget/i).textContent).toMatch(/256000|256,000/);
    expect(container.querySelector('.fw-inspector__diff')).toBeNull();
  });

  it('a non-chat artifact panel is completely unchanged — no diff section appears', () => {
    const forgeArtifact = {
      id: 'a-2',
      name: 'report.md',
      kind: 'markdown',
      producedBy: 'forge-2026-07-31-x',
      taskId: null,
      createdAt: '2026-07-31T09:00:00.000Z',
      size: '2 KB',
      preview: '# Report',
    } as unknown as Artifact;
    const { container } = renderArtifactPanel(forgeArtifact);
    expect(container.querySelector('.fw-inspector__diff')).toBeNull();
    expect(screen.queryByText(/No diff was recorded/i)).toBeNull();
  });
});

/**
 * SECURITY — the fixture below is REAL output, not an assumption about redaction.
 *
 * It was produced by driving the gateway's own production write+read path with live secrets and
 * printing what `listChatRuns()` actually returned (the same values `gateway/test/
 * chat-runs-diff.test.mjs`'s own SECURITY test asserts against, captured from that same layer):
 *
 *   old_string 'OLD_TOKEN=ghp_abcdefghij1234567890'          -> 'OLD_TOKEN=[REDACTED:GITHUB_PAT]'
 *   new_string 'NEW_TOKEN=nvapi-abcdefghij1234567890'        -> 'NEW_TOKEN=[REDACTED:NVIDIA_API_KEY]'
 *   content    'AWS_ACCESS_KEY_ID=AKIA1234567890ABCD'        -> 'AWS_ACCESS_KEY_ID=[REDACTED:AWS_ACCESS_KEY_ID]'
 *   file_path  '/tmp/sk-abcdefghijklmnopqrstuvwx/.env'       -> '/tmp/[REDACTED:GENERIC_SK_KEY]/.env'
 *
 * What this test adds on top of the gateway's own proof: the dashboard renders exactly what it was
 * given and never reconstructs, unescapes or re-widens it on the way to the DOM.
 */
describe('SECURITY: a redacted secret stays redacted all the way to the screen', () => {
  const REDACTED_EDIT = {
    tool: 'Edit',
    file_path: '/proj/config.js',
    old_string: 'OLD_TOKEN=[REDACTED:GITHUB_PAT]',
    new_string: 'NEW_TOKEN=[REDACTED:NVIDIA_API_KEY]',
    content: null,
    diff_state: 'present',
  };
  const REDACTED_WRITE = {
    tool: 'Write',
    file_path: '/tmp/[REDACTED:GENERIC_SK_KEY]/.env',
    old_string: null,
    new_string: null,
    content: 'AWS_ACCESS_KEY_ID=[REDACTED:AWS_ACCESS_KEY_ID]',
    diff_state: 'present',
  };
  const SECRETS = [
    'ghp_abcdefghij1234567890',
    'nvapi-abcdefghij1234567890',
    'AKIA1234567890ABCD',
    'sk-abcdefghijklmnopqrstuvwx',
  ];

  it('no secret survives into the parsed rows or the artifacts built from them', () => {
    const [row] = parseChatRunRows(chatRunResponse([REDACTED_EDIT, REDACTED_WRITE]));
    const serialized = JSON.stringify(row) + JSON.stringify(toGatewayChatRunArtifacts(row));
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED:GITHUB_PAT]');
  });

  it('the rendered diff shows the redaction marker and never the secret (old_string + new_string)', () => {
    const { container } = renderArtifactPanel(artifactFor(REDACTED_EDIT));
    const html = container.innerHTML;
    for (const secret of SECRETS) expect(html).not.toContain(secret);
    expect(screen.getByText('- OLD_TOKEN=[REDACTED:GITHUB_PAT]')).toBeTruthy();
    expect(screen.getByText('+ NEW_TOKEN=[REDACTED:NVIDIA_API_KEY]')).toBeTruthy();
  });

  it('the rendered diff and the artifact title show the redaction marker and never the secret (content + file path)', () => {
    const { container } = renderArtifactPanel(artifactFor(REDACTED_WRITE));
    const html = container.innerHTML;
    for (const secret of SECRETS) expect(html).not.toContain(secret);
    expect(screen.getByText('+ AWS_ACCESS_KEY_ID=[REDACTED:AWS_ACCESS_KEY_ID]')).toBeTruthy();
    // The path rides in the artifact's own preview line, which this panel also renders.
    expect(html).toContain('[REDACTED:GENERIC_SK_KEY]');
  });
});
