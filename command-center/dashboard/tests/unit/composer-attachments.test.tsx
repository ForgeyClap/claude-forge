/**
 * Composer "Attach" — build-lastdemos T3.
 *
 * Locks in the real flow: Attach is disabled with an honest title before any
 * conversation exists, becomes enabled once `state.activeConversationId` is
 * real, a chosen file is really uploaded via
 * `POST /api/conversations/:id/attachments` (stubbed fetch, asserted on
 * directly — same fetch-stub precedent `sidebar-new-project.test.tsx` and
 * `gateway-actions.test.ts` already use), shows a removable chip, and — the
 * part that makes the upload more than cosmetic — the attachment's real
 * content is actually prepended into the next `onSend` body.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { GATEWAY_ORIGIN } from '@/prototype/state/gateway-client';
import { Composer } from '@/views/chat/Composer';

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: false,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: '',
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
    ...overrides,
  };
}

function renderComposer(state: PrototypeState, onSend = vi.fn(() => true)) {
  const value: StoreValue = { state, dispatch: vi.fn() };
  const utils = render(
    createElement(
      PrototypeContext.Provider,
      { value },
      createElement(Composer, {
        onSend,
        onStop: () => undefined,
        streaming: false,
        conversationTitle: 'Test conversation',
        production: true,
      }),
    ),
  );
  return { ...utils, onSend };
}

function installUploadFetchMock(attachment: Record<string, unknown>) {
  const calls: unknown[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return { ok: true, status: 201, json: async () => ({ ok: true, attachment }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return calls;
}

describe('Composer — real "Attach" upload', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('disables Attach with an honest title before any conversation exists', () => {
    renderComposer(buildState());
    const attach = screen.getByRole('button', { name: 'Attach a file' });
    expect(attach).toBeDisabled();
    expect(attach.title).toMatch(/start the conversation/i);
  });

  it('enables Attach once a real conversation is active, uploads the chosen file, and shows a chip', async () => {
    const calls = installUploadFetchMock({
      id: 'att-1', fileName: 'notes.txt', size: 17, isText: true,
      textPreview: 'hello attachment', textTruncated: false, storedPath: 'C:\\data\\attachments\\conv-1\\att-1-notes.txt',
    });
    renderComposer(buildState({ activeConversationId: 'conv-1' }));

    const attach = screen.getByRole('button', { name: 'Attach a file' });
    expect(attach).not.toBeDisabled();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello attachment'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0] as { url: string }).url).toBe(`${GATEWAY_ORIGIN}/api/conversations/conv-1/attachments`);

    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
  });

  it('inlines the real attachment content into the next sent message body, then clears the chip', async () => {
    installUploadFetchMock({
      id: 'att-1', fileName: 'notes.txt', size: 17, isText: true,
      textPreview: 'hello attachment', textTruncated: false, storedPath: 'C:\\data\\attachments\\conv-1\\att-1-notes.txt',
    });
    const onSend = vi.fn((_body: string) => true);
    renderComposer(buildState({ activeConversationId: 'conv-1' }), onSend);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello attachment'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText('notes.txt');

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Please review this.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledTimes(1);
    const sentBody = onSend.mock.calls[0][0] as string;
    expect(sentBody).toContain('Attachment: notes.txt');
    expect(sentBody).toContain('hello attachment');
    expect(sentBody).toContain('Please review this.');

    // The chip is cleared once Send accepts synchronously (fixtures-style true return).
    await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull());
  });

  it('removing a chip drops it from the next send', async () => {
    installUploadFetchMock({
      id: 'att-1', fileName: 'notes.txt', size: 17, isText: true,
      textPreview: 'hello attachment', textTruncated: false, storedPath: 'C:\\data\\attachments\\conv-1\\att-1-notes.txt',
    });
    const onSend = vi.fn((_body: string) => true);
    renderComposer(buildState({ activeConversationId: 'conv-1' }), onSend);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello attachment'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(screen.queryByText('notes.txt')).toBeNull();

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'No attachment now.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('No attachment now.');
  });

  it('a gateway upload failure surfaces a toast and adds no chip', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 413, json: async () => ({ ok: false, error: 'attachment exceeds 5242880 bytes' }) }) as Response);
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const dispatch = vi.fn();
    const value: StoreValue = { state: buildState({ activeConversationId: 'conv-1' }), dispatch };
    render(
      createElement(
        PrototypeContext.Provider,
        { value },
        createElement(Composer, {
          onSend: () => true,
          onStop: () => undefined,
          streaming: false,
          conversationTitle: 'Test conversation',
          production: true,
        }),
      ),
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'.repeat(10)], 'huge.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'toast/push', toast: expect.objectContaining({ title: 'Attachment failed' }) }),
      ),
    );
    expect(screen.queryByText('huge.txt')).toBeNull();
  });
});
