/**
 * feat-composer-power (forge-2026-07-29-cc-finish) — `@`-mention file autocomplete.
 *
 * Route reuse: this feature drives the EXISTING `GET /api/files` route (already wired,
 * project-scoped, containment-hardened) rather than a new one — see `mention-files.ts`'s own
 * header. Locks in: caret-aware `@token` detection (never mid-word, e.g. inside an email), the
 * fuzzy ranking, and the Composer wiring that fetches the real bounded file index lazily and
 * inserts the chosen file's real, readable path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  activeMentionToken,
  applyMentionSelection,
  filterMentionEntries,
  scoreMentionEntry,
} from '@/views/chat/mention-files';
import type { MentionFileEntry } from '@/views/chat/mention-files';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { Composer } from '@/views/chat/Composer';

/* ========================================================================== */
/*  1. Pure helpers — no rendering, no network                                */
/* ========================================================================== */

describe('activeMentionToken', () => {
  it('finds the token when @ is the very first character', () => {
    expect(activeMentionToken('@Read', 5)).toEqual({ start: 0, query: 'Read' });
  });

  it('finds the token when @ follows whitespace', () => {
    expect(activeMentionToken('please read @Fo', 15)).toEqual({ start: 12, query: 'Fo' });
  });

  it('never triggers for an @ in the middle of a word (e.g. an email address)', () => {
    expect(activeMentionToken('user@example.com', 17)).toBeNull();
  });

  it('returns null once the caret has moved past the token (a space was typed)', () => {
    expect(activeMentionToken('@Read me', 8)).toBeNull();
  });

  it('an empty query right after typing "@" is a real, valid (open) token', () => {
    expect(activeMentionToken('@', 1)).toEqual({ start: 0, query: '' });
  });
});

describe('scoreMentionEntry — ranking rules', () => {
  const file = (path: string): MentionFileEntry => ({ path, name: path.split('/').pop() ?? path, kind: 'file' });

  it('an exact name match scores best (0)', () => {
    expect(scoreMentionEntry('readme.md', file('README.md'))).toBe(0);
  });

  it('a name prefix match scores 1', () => {
    expect(scoreMentionEntry('read', file('README.md'))).toBe(1);
  });

  it('a name substring match scores 2', () => {
    expect(scoreMentionEntry('adme', file('README.md'))).toBe(2);
  });

  it('a path-only substring match scores 3', () => {
    expect(scoreMentionEntry('src', file('src/index.ts'))).toBe(3);
  });

  it('no match at all is null', () => {
    expect(scoreMentionEntry('zzz-nonexistent', file('README.md'))).toBeNull();
  });
});

describe('filterMentionEntries', () => {
  it('files only — never offers a directory as a mention target', () => {
    const entries: readonly MentionFileEntry[] = [
      { path: 'src', name: 'src', kind: 'dir' },
      { path: 'src/index.ts', name: 'index.ts', kind: 'file' },
    ];
    const result = filterMentionEntries(entries, 'src');
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/index.ts');
  });

  it('caps the visible list at the given limit', () => {
    const entries: readonly MentionFileEntry[] = Array.from({ length: 30 }, (_, i) => ({
      path: `file-${i}.ts`,
      name: `file-${i}.ts`,
      kind: 'file' as const,
    }));
    expect(filterMentionEntries(entries, 'file', 5)).toHaveLength(5);
  });

  it('an unmatched query yields an honest empty list, not a fabricated fallback', () => {
    const entries: readonly MentionFileEntry[] = [{ path: 'README.md', name: 'README.md', kind: 'file' }];
    expect(filterMentionEntries(entries, 'zzz-nope')).toEqual([]);
  });
});

describe('applyMentionSelection', () => {
  it('replaces the @token with the real path, @-prefixed, plus a trailing space', () => {
    const token = { start: 0, query: 'Rea' };
    const applied = applyMentionSelection('@Rea', token, 'README.md');
    expect(applied.value).toBe('@README.md ');
    expect(applied.caret).toBe('@README.md '.length);
  });

  it('preserves the text before and after the token (the inserted path carries its own trailing space)', () => {
    const token = { start: 7, query: 'Rea' };
    const applied = applyMentionSelection('please @Rea then build it', token, 'README.md');
    expect(applied.value).toBe('please @README.md  then build it');
    expect(applied.value.startsWith('please @README.md ')).toBe(true);
    expect(applied.value.endsWith('then build it')).toBe(true);
  });
});

/* ========================================================================== */
/*  2. Composer integration — a stubbed GET /api/files                        */
/* ========================================================================== */

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

function renderComposer(state: PrototypeState) {
  const value: StoreValue = { state, dispatch: vi.fn() };
  return render(
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
}

/** A minimal `/api/files` stub: `tree['']` is the root listing, `tree['src']` is `src/`'s own. */
function installFilesFetchMock(tree: Readonly<Record<string, readonly Record<string, unknown>[]>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      const path = url.searchParams.get('path') ?? '';
      const entries = tree[path] ?? [];
      return { ok: true, status: 200, json: async () => ({ ok: true, entries }) } as Response;
    }),
  );
}

describe('Composer @-mention autocomplete (feat-composer-power)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows real, matching files from the active project once @ is typed', async () => {
    installFilesFetchMock({
      '': [
        { name: 'README.md', type: 'file', size: 10, mtime: null },
        { name: 'src', type: 'dir', size: null, mtime: null },
      ],
      src: [{ name: 'Reader.ts', type: 'file', size: 20, mtime: null }],
    });
    renderComposer(buildState({ activeProjectId: 'demo-project' }));

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: '@Read' } });

    expect(await screen.findByRole('option', { name: /README\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Reader\.ts/ })).toBeInTheDocument();
    // A directory is never offered as a mention target, even though its name matched too.
    expect(screen.queryByRole('option', { name: /^src$/ })).toBeNull();
  });

  it('inserts the chosen file as a real, readable @path in the draft', async () => {
    installFilesFetchMock({
      '': [{ name: 'README.md', type: 'file', size: 10, mtime: null }],
    });
    renderComposer(buildState({ activeProjectId: 'demo-project' }));

    const field = screen.getByRole('textbox', { name: /Message Forge/ }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '@Read' } });
    await screen.findByRole('option', { name: /README\.md/ });

    fireEvent.click(screen.getByRole('option', { name: /README\.md/ }));
    await waitFor(() => expect(field.value).toBe('@README.md '));
  });

  it('shows an honest "no files match" message for a query with no real match', async () => {
    installFilesFetchMock({ '': [{ name: 'README.md', type: 'file', size: 10, mtime: null }] });
    renderComposer(buildState({ activeProjectId: 'demo-project' }));

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: '@zzz-nonexistent' } });

    expect(await screen.findByText(/No files match/i)).toBeInTheDocument();
  });

  it('Escape closes the popover without inserting anything', async () => {
    installFilesFetchMock({ '': [{ name: 'README.md', type: 'file', size: 10, mtime: null }] });
    renderComposer(buildState({ activeProjectId: 'demo-project' }));

    const field = screen.getByRole('textbox', { name: /Message Forge/ }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '@Read' } });
    await screen.findByRole('option', { name: /README\.md/ });

    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('option', { name: /README\.md/ })).toBeNull();
    expect(field.value).toBe('@Read');
  });

  it('names the missing active project honestly instead of silently showing nothing', () => {
    renderComposer(buildState({ activeProjectId: '' }));
    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: '@Read' } });
    expect(screen.getByText(/Select a project to mention its files/i)).toBeInTheDocument();
  });
});
