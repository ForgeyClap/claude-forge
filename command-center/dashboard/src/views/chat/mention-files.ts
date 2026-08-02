/**
 * mention-files — `@`-mention file autocomplete over the ACTIVE project's real working tree
 * (feat-composer-power, forge-2026-07-29-cc-finish).
 *
 * ROUTE REUSE (per this WP's own instruction: "hergebruik boven nieuw"): this reuses the
 * EXISTING `GET /api/files` route (`gateway/src/files.mjs` / `server.mjs`, already wired,
 * read-only, project-scoped, containment- and symlink-hardened) rather than adding a new
 * recursive "scan"/"tree" route. That endpoint deliberately returns one directory level at a
 * time — `files.mjs`'s own header explains why: eagerly recursing a real working tree either
 * walks all of `node_modules` or needs an arbitrary depth/count cap anyway. This module supplies
 * exactly that cap itself, client-side: a small bounded breadth-first crawl (skips
 * `node_modules`/`.git`, caps total directories visited and total entries collected) run once the
 * first time a person types `@` in a given project, then filtered in memory on every further
 * keystroke — no extra network round trip per character typed.
 *
 * HONESTY: every suggested entry is a real file `GET /api/files` reported for THIS project. A
 * query that matches nothing shows an honest "no files match" message (see `Composer.tsx`) rather
 * than fabricating a result; a capped/partial crawl never claims to be a complete tree.
 */

import { useCallback, useState } from 'react';

import { gwGet, pickArray, pickString } from '@/prototype/state/gateway-client';

export interface MentionFileEntry {
  /** Repo-relative, POSIX-style (`/`-joined) path — this IS the "readable path" the WP asks to
   *  place into the prompt on selection. */
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'dir';
}

/** Directories the crawl still visits for structure but is capped out of the RESULTS the user is
 *  ever offered — see this file's header for the node_modules/.git concern this mirrors from
 *  `files.mjs`. */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git']);
const MAX_DIRS_VISITED = 40;
const MAX_ENTRIES_COLLECTED = 800;
export const MAX_MENTION_RESULTS = 20;

function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/**
 * One bounded breadth-first crawl of the real tree via the existing `GET /api/files` route. Never
 * throws — a failed directory fetch (a transient error, or a directory that vanished mid-crawl)
 * simply stops that one branch; the rest of the crawl continues.
 */
export async function crawlProjectFiles(projectName: string): Promise<readonly MentionFileEntry[]> {
  const out: MentionFileEntry[] = [];
  const queue: string[] = [''];
  let dirsVisited = 0;

  while (queue.length > 0 && dirsVisited < MAX_DIRS_VISITED && out.length < MAX_ENTRIES_COLLECTED) {
    const dir = queue.shift() as string;
    dirsVisited += 1;
    // Deliberately sequential (one directory at a time) — a small, rate-bounded crawl against a
    // local single-user gateway; see this file's header for the visited/collected caps.
    const query = `project=${encodeURIComponent(projectName)}&path=${encodeURIComponent(dir)}`;
    const result = await gwGet(`/api/files?${query}`);
    if (!result.ok) continue;
    for (const row of pickArray(result.data, ['entries'])) {
      if (out.length >= MAX_ENTRIES_COLLECTED) break;
      const name = pickString(row, ['name']) ?? '';
      if (name === '') continue;
      const kind = pickString(row, ['type']) === 'dir' ? 'dir' : 'file';
      const path = childPath(dir, name);
      out.push({ path, name, kind });
      if (kind === 'dir' && !SKIP_DIR_NAMES.has(name)) queue.push(path);
    }
  }
  return out;
}

/** Two-pointer subsequence check — a lightweight fuzzy fallback (e.g. "cmp" matches
 *  "src/components/Foo.tsx") once a plain substring match fails. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/** Lower is a better match; `null` means no match at all. Exported for direct unit testing of the
 *  ranking rules independent of the list-building/sorting logic below. */
export function scoreMentionEntry(query: string, entry: MentionFileEntry): number | null {
  if (query === '') return 0;
  const q = query.toLowerCase();
  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (path.includes(q)) return 3;
  if (isSubsequence(q, path)) return 4;
  return null;
}

/**
 * Filters, ranks and caps the real crawled entries for display — files only (the WP's own
 * wording: "kies een bestand", a file, never a folder) — never more than `limit` (default
 * `MAX_MENTION_RESULTS`, "max ~20 zichtbaar").
 */
export function filterMentionEntries(
  entries: readonly MentionFileEntry[],
  query: string,
  limit: number = MAX_MENTION_RESULTS,
): readonly MentionFileEntry[] {
  const scored = entries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => ({ entry, score: scoreMentionEntry(query, entry) }))
    .filter((row): row is { entry: MentionFileEntry; score: number } => row.score !== null);
  scored.sort((a, b) => (a.score !== b.score ? a.score - b.score : a.entry.path.localeCompare(b.entry.path)));
  return scored.slice(0, limit).map((row) => row.entry);
}

export interface ActiveMentionToken {
  /** Index of the `@` character itself. */
  readonly start: number;
  /** The text typed after `@`, up to the caret. */
  readonly query: string;
}

/**
 * Finds the `@token` the caret currently sits inside, if any. The `@` must be the very first
 * character of its token (start of the draft, or right after whitespace) — this is what keeps an
 * ordinary "email@example.com" from ever triggering the picker: a `@` in the middle of a word is
 * never the start of its own token.
 */
export function activeMentionToken(value: string, caret: number): ActiveMentionToken | null {
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  if (value[start] !== '@') return null;
  return { start, query: value.slice(start + 1, caret) };
}

/**
 * Replaces the `@token` with the chosen file's real, readable path (kept `@`-prefixed so it stays
 * visibly marked as a file reference) followed by a trailing space. The caret position is derived
 * from the token itself (`start + 1 + query.length`), never a separately-passed value that could
 * have drifted from the moment the token was last detected.
 */
export function applyMentionSelection(
  value: string,
  token: ActiveMentionToken,
  path: string,
): { readonly value: string; readonly caret: number } {
  const caretAtToken = token.start + 1 + token.query.length;
  const inserted = `@${path} `;
  const nextValue = value.slice(0, token.start) + inserted + value.slice(caretAtToken);
  return { value: nextValue, caret: token.start + inserted.length };
}

export interface MentionIndexState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly entries: readonly MentionFileEntry[];
}

export interface MentionIndexController {
  readonly state: MentionIndexState;
  /** Fetches this project's real, bounded file index the first time it is needed (mirrors this
   *  file's neighbouring `loadSkills`/Skills-menu convention in `Composer.tsx`: lazy, only once
   *  per active project, safe to call repeatedly). */
  ensureLoaded(): void;
}

/**
 * The mention index for the active project — reset (render-time, not via an effect, mirroring
 * `Composer.tsx`'s own established `skillsProjectId`/`skillOptions` pattern) whenever the project
 * changes, so a stale project's file list can never be offered under a different one.
 */
export function useProjectFileMentions(projectName: string): MentionIndexController {
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [state, setState] = useState<MentionIndexState>({ status: 'idle', entries: [] });

  if (loadedFor !== null && loadedFor !== projectName) {
    setLoadedFor(null);
    setState({ status: 'idle', entries: [] });
  }

  const ensureLoaded = useCallback(() => {
    if (projectName === '' || loadedFor === projectName) return;
    setLoadedFor(projectName);
    setState({ status: 'loading', entries: [] });
    void crawlProjectFiles(projectName)
      .then((entries) => setState({ status: 'ready', entries }))
      .catch(() => setState({ status: 'error', entries: [] }));
  }, [projectName, loadedFor]);

  return { state, ensureLoaded };
}
