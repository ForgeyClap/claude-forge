/**
 * Forge Command Center — the gateway file browser (cc-wire-views).
 *
 * `FilesView.tsx` used to read a SYNCHRONOUS, already-complete fixture tree
 * (`state.data.files`) with per-file `diff`/`changed` — a shape the real
 * `GET /api/files` endpoint cannot honestly satisfy in one shot: it is LAZY,
 * one directory level at a time (`gateway-adapter.ts`'s own header already
 * explained why — eagerly recursing a real working tree would either walk all
 * of `node_modules` or need an arbitrary depth/count cap that breaks the
 * "complete tree" contract anyway). This work package is explicitly scoped to
 * edit `FilesView.tsx` itself, so this file is the lazy-loading counterpart —
 * the same "a view needs to TRIGGER a network action, not just read a polled
 * snapshot" concern `chat-send.ts` / `gateway-chat.ts` already solved for chat,
 * via the same Context/controller shape (`null` on the fixture path).
 *
 * HONESTY RULES (same three as `gateway-adapter.ts`'s own header):
 *   1. NEVER FABRICATE A ROW. Every `FileNode` here is a real directory entry
 *      (name/type/size/mtime) `GET /api/files` reported, or the collection is
 *      empty because that directory has not been expanded yet.
 *   2. NO INVENTED CHANGE MARKERS. The real gateway has no git-diff concept —
 *      `changed`/`diff` are always left `undefined` on a real node, so the
 *      view's OWN existing honest-absence branches ("unchanged" / "no diff
 *      recorded") render, never a fabricated marker.
 *   3. A NOT-YET-EXPANDED DIRECTORY IS `children: undefined`, never `[]` — the
 *      view's tree logic already treats "no children" as "nothing to recurse
 *      into", so this is what makes an unexpanded folder still offer its
 *      disclosure chevron while a directory that WAS fetched and is genuinely
 *      empty does not (both honest, for different real reasons).
 *
 * DELIBERATE SCOPE BOUNDARY, named rather than silently absent: "Expand all
 * folders" only expands directories ALREADY loaded — it does not cascade a
 * recursive fetch across the whole tree. Doing that would risk exactly the
 * node_modules/depth-cap problem `files.mjs`'s own header raises. A directory
 * is fetched only when a person actually opens it.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { gwGet, pickArray, pickBool, pickNumber, pickString } from '@/prototype/state/gateway-client';
import type { FileNode } from '@/prototype/types/prototype-types';

/* ========================================================================== */
/*  1. Raw shapes + pure parsers (hermetically unit-testable, no network)     */
/* ========================================================================== */

export interface GatewayFileEntry {
  readonly name: string;
  readonly type: 'dir' | 'file';
  readonly size: number | null;
  readonly mtime: string | null;
}

/** Maps `GET /api/files`'s real `entries` array 1:1 — never invents a field. */
export function parseDirectoryEntries(data: Record<string, unknown>): readonly GatewayFileEntry[] {
  return pickArray(data, ['entries']).map((row) => ({
    name: pickString(row, ['name']) ?? '',
    type: pickString(row, ['type']) === 'dir' ? 'dir' : 'file',
    size: pickNumber(row, ['size']),
    mtime: pickString(row, ['mtime']),
  }));
}

/** A real byte count into a short display string. A format transform of real
 *  data, not a fabrication — mirrors this codebase's own small local
 *  formatter convention (see `UsageBar.tsx`'s `formatDuration`/`formatClock`). */
export function formatFileBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/* ========================================================================== */
/*  2. The lazy tree builder — pure, given whatever has been loaded so far    */
/* ========================================================================== */

export interface GatewayDirState {
  readonly status: 'loading' | 'loaded' | 'error';
  readonly entries: readonly GatewayFileEntry[] | null;
}

export const EMPTY_DIR_MAP: ReadonlyMap<string, GatewayDirState> = new Map();

function childPath(parentPath: string, name: string): string {
  return parentPath === '.' ? name : `${parentPath}/${name}`;
}

function buildFileNode(relPath: string, entry: GatewayFileEntry, dirs: ReadonlyMap<string, GatewayDirState>): FileNode {
  const isDir = entry.type === 'dir';
  const record: Omit<FileNode, 'prototype'> = {
    id: relPath,
    name: entry.name,
    path: relPath,
    kind: isDir ? 'dir' : 'file',
    size: entry.size !== null ? formatFileBytes(entry.size) : undefined,
    updatedAt: entry.mtime ?? undefined,
    children: isDir ? buildChildren(relPath, dirs) : undefined,
  };
  return record as unknown as FileNode;
}

/** `undefined` (not `[]`) means "not fetched yet" — see this file's header, rule 3. */
function buildChildren(relPath: string, dirs: ReadonlyMap<string, GatewayDirState>): readonly FileNode[] | undefined {
  const dir = dirs.get(relPath);
  if (dir === undefined || dir.entries === null) return undefined;
  return dir.entries.map((entry) => buildFileNode(childPath(relPath, entry.name), entry, dirs));
}

/** The root's own children ARE the tree `FilesView.tsx` renders — the fixture's
 *  `FILE_TREE` was likewise a list of root-level entries, never a wrapping "." node. */
export function buildGatewayFileTree(dirs: ReadonlyMap<string, GatewayDirState>): readonly FileNode[] {
  return buildChildren('.', dirs) ?? [];
}

/* ========================================================================== */
/*  3. File content preview (`GET /api/files/read`)                          */
/* ========================================================================== */

export interface GatewayFilePreview {
  readonly path: string;
  readonly status: 'blocked' | 'binary' | 'text' | 'error';
  /** The denylist reason code for a blocked file (e.g. `env-file`) — the view
   *  owns turning this into a human phrase, same layering as `StatusKey`. */
  readonly reason: string | null;
  readonly size: number | null;
  readonly truncated: boolean;
  readonly content: string | null;
  readonly error: string | null;
}

/** Reads `content` directly rather than through `pickString` — an empty file
 *  (or one that is all whitespace) is real, readable content, not an absent
 *  field, and `pickString`'s trim/non-empty guard would wrongly discard it. */
function pickContentField(data: Record<string, unknown>): string | null {
  const value = (data as { content?: unknown }).content;
  return typeof value === 'string' ? value : null;
}

export function parseFilePreviewResponse(path: string, data: Record<string, unknown>): GatewayFilePreview {
  if (pickBool(data, ['blocked']) === true) {
    return { path, status: 'blocked', reason: pickString(data, ['reason']), size: null, truncated: false, content: null, error: null };
  }
  if (pickBool(data, ['binary']) === true) {
    return { path, status: 'binary', reason: null, size: pickNumber(data, ['size']), truncated: false, content: null, error: null };
  }
  return {
    path,
    status: 'text',
    reason: null,
    size: pickNumber(data, ['size']),
    truncated: pickBool(data, ['truncated']) ?? false,
    content: pickContentField(data),
    error: null,
  };
}

export function errorFilePreview(path: string, error: string): GatewayFilePreview {
  return { path, status: 'error', reason: null, size: null, truncated: false, content: null, error };
}

/* ========================================================================== */
/*  4. The controller — lazy directory fetch + the active preview            */
/* ========================================================================== */

export interface FilesController {
  /** The lazily-growing real tree. Empty until the root's own listing resolves. */
  readonly tree: readonly FileNode[];
  /** Fetches one directory level if it has not been fetched (or failed) yet.
   *  Idempotent — safe to call on every open/re-open of the same folder. */
  ensureLoaded(relPath: string): void;
  /** The read-preview for whichever file is currently selected, or `null`
   *  while nothing is selected or the fetch for the current selection has not
   *  resolved yet. */
  readonly preview: GatewayFilePreview | null;
}

function listQueryPath(relPath: string): string {
  return relPath === '.' ? '' : relPath;
}

interface KeyedPreview {
  readonly key: string;
  readonly value: GatewayFilePreview | null;
}

/** Mirrors `gateway-adapter.ts`'s own `Keyed<T>` idiom: gated on the key
 *  matching at READ time rather than resetting state from inside the effect. */
function useGatewayFilePreview(projectName: string, relPath: string | null): GatewayFilePreview | null {
  const [state, setState] = useState<KeyedPreview>({ key: '', value: null });

  useEffect(() => {
    if (projectName === '' || relPath === null) return undefined;
    const path = relPath;
    let cancelled = false;
    async function run(): Promise<void> {
      const query = `project=${encodeURIComponent(projectName)}&path=${encodeURIComponent(path)}`;
      const result = await gwGet(`/api/files/read?${query}`);
      if (cancelled) return;
      setState({
        key: path,
        value: result.ok ? parseFilePreviewResponse(path, result.data) : errorFilePreview(path, result.error),
      });
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [projectName, relPath]);

  return relPath !== null && state.key === relPath ? state.value : null;
}

/**
 * Builds the production files controller for the active project. Mounted
 * once, at the production provider, so the hook order stays stable — mirrors
 * `useChatSendController` / `useGatewayChatSendController`'s own mounting
 * convention.
 *
 * `dirsRef` is kept in lockstep with `dirs` at every mutation site (never via
 * a separate mirroring effect) so `ensureLoaded`, which is called from a click
 * or keyboard handler rather than during render, always sees the latest
 * "already loading/loaded" state and never fires a duplicate fetch for the
 * same directory.
 */
export function useGatewayFilesController(projectName: string, selectedFilePath: string | null): FilesController {
  const [dirs, setDirs] = useState<ReadonlyMap<string, GatewayDirState>>(EMPTY_DIR_MAP);
  const dirsRef = useRef<ReadonlyMap<string, GatewayDirState>>(EMPTY_DIR_MAP);
  const prevProjectRef = useRef<string | null>(null);

  const ensureLoaded = useCallback(
    (relPath: string) => {
      if (projectName === '') return;
      const existing = dirsRef.current.get(relPath);
      if (existing !== undefined && existing.status !== 'error') return; // already loaded or in flight

      const withLoading = new Map(dirsRef.current);
      withLoading.set(relPath, { status: 'loading', entries: existing?.entries ?? null });
      dirsRef.current = withLoading;
      setDirs(withLoading);

      void (async () => {
        const query = `project=${encodeURIComponent(projectName)}&path=${encodeURIComponent(listQueryPath(relPath))}`;
        const result = await gwGet(`/api/files?${query}`);
        const resolved = new Map(dirsRef.current);
        resolved.set(
          relPath,
          result.ok ? { status: 'loaded', entries: parseDirectoryEntries(result.data) } : { status: 'error', entries: null },
        );
        dirsRef.current = resolved;
        setDirs(resolved);
      })();
    },
    [projectName],
  );

  // Root loads eagerly (no click should be required to see anything), and a
  // project switch resets the map first — a directory keyed by relative path
  // from a DIFFERENT project's root would otherwise silently mix two trees.
  useEffect(() => {
    if (projectName === '') return;
    if (prevProjectRef.current !== null && prevProjectRef.current !== projectName) {
      dirsRef.current = EMPTY_DIR_MAP;
      setDirs(EMPTY_DIR_MAP);
    }
    prevProjectRef.current = projectName;
    ensureLoaded('.');
  }, [projectName, ensureLoaded]);

  const preview = useGatewayFilePreview(projectName, selectedFilePath);
  const tree = buildGatewayFileTree(dirs);

  return { tree, ensureLoaded, preview };
}

/* ========================================================================== */
/*  5. Context — null on the fixture path, exactly like ChatSendContext       */
/* ========================================================================== */

export const FilesActionsContext = createContext<FilesController | null>(null);

/** The production files controller, or `null` where `PrototypeProvider` did
 *  not mount it (fixtures, the theme showcase, unit tests). */
export function useFilesActions(): FilesController | null {
  return useContext(FilesActionsContext);
}
