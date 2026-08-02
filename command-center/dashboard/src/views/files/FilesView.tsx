/**
 * FilesView — the working-tree browser.
 *
 * Two panes: an ARIA tree over `state.data.files` on the left, a read-only
 * preview on the right.
 *
 * cc-wire-views UPDATE: in production (`useFilesActions()` non-null — see
 * `gateway-files.ts`), `state.data.files` is a REAL, lazily-growing tree read
 * from this project's own working directory via `GET /api/files`, one
 * directory level at a time as the reader expands a folder; the preview pane
 * reads real file content via `GET /api/files/read`, with the gateway's own
 * blocked/binary/denylist outcomes rendered through this view's existing
 * `EmptyState` language. Change markers (`added`/`modified`/`deleted`) and
 * unified diffs have no real-gateway equivalent (no git diff is computed) and
 * stay honestly absent on every real node — every markup/interaction path
 * that reads them is therefore dead-but-harmless on the real path rather than
 * removed, per this WP's "only add, remove nothing" instruction.
 *
 * On the FIXTURE path (`useFilesActions()` null — the theme showcase, unit
 * tests), nothing above applies: the tree, change markers, sizes, timestamps
 * and diffs stay the original local example strings from
 * `src/prototype/fixtures/files.ts`, byte-for-byte unchanged.
 *
 * Provenance rule as applied here: every file name, path, size, timestamp and
 * diff line is machine-recorded, so it is set in the monospace face. The only
 * sans text on this screen is the page subtitle and the empty-state prose.
 */

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import {
  EmptyState,
  Eyebrow,
  ExampleTag,
  Icon,
  IconButton,
  Machine,
  Spacer,
  Switch,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useFilesActions } from '@/prototype/state/gateway-files';
import type { GatewayFilePreview } from '@/prototype/state/gateway-files';
import type { FileNode } from '@/prototype/types/prototype-types';

import './files.css';

/* ------------------------------------------------------------------ marks */

type ChangeKey = NonNullable<FileNode['changed']>;

interface ChangeMarkSpec {
  /** Leading glyph. Carries the state on its own in pure greyscale. */
  readonly glyph: string;
  /** Short uppercase label for the tree row. */
  readonly short: string;
  /** Full uppercase label for the preview header. */
  readonly label: string;
  readonly description: string;
}

const CHANGE_MARKS: Readonly<Record<ChangeKey, ChangeMarkSpec>> = {
  added: {
    glyph: '+',
    short: 'ADD',
    label: 'ADDED',
    description: 'Added — this file did not exist before this change.',
  },
  modified: {
    glyph: '~',
    short: 'MOD',
    label: 'MODIFIED',
    description: 'Modified — this file was edited.',
  },
  deleted: {
    glyph: '-',
    short: 'DEL',
    label: 'DELETED',
    description: 'Deleted — this file was removed.',
  },
};

const CHANGE_ORDER: readonly ChangeKey[] = ['added', 'modified', 'deleted'];

/* ------------------------------------------------------------------ icons */

/** Extension → lucide glyph. Monochrome by definition; the glyph is the signal. */
const EXTENSION_ICONS: Readonly<Record<string, string>> = {
  ts: 'FileCode',
  tsx: 'FileCode',
  js: 'FileCode',
  jsx: 'FileCode',
  mjs: 'FileCode',
  cjs: 'FileCode',
  html: 'FileCode',
  css: 'FileType',
  scss: 'FileType',
  json: 'FileJson',
  jsonl: 'FileJson',
  md: 'FileText',
  txt: 'FileText',
  log: 'ScrollText',
  png: 'FileImage',
  jpg: 'FileImage',
  jpeg: 'FileImage',
  webp: 'FileImage',
  svg: 'FileImage',
  woff: 'Type',
  woff2: 'Type',
  ttf: 'Type',
  yml: 'FileCog',
  yaml: 'FileCog',
  lock: 'Lock',
};

function iconForNode(node: FileNode, open = false): string {
  if (node.kind === 'dir') return open ? 'FolderOpen' : 'Folder';
  const name = node.name.toLowerCase();
  if (name.startsWith('.env')) return 'FileCog';
  if (/\.(spec|test)\.[a-z0-9]+$/.test(name)) return 'FlaskConical';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  return EXTENSION_ICONS[extension] ?? 'File';
}

/* ------------------------------------------------------------------- tree */

interface TreeRow {
  readonly id: string;
  readonly node: FileNode;
  readonly parentId: string | null;
}

function flattenFiles(nodes: readonly FileNode[], out: FileNode[]): FileNode[] {
  for (const node of nodes) {
    if (node.kind === 'file') out.push(node);
    if (node.children) flattenFiles(node.children, out);
  }
  return out;
}

function collectDirIds(nodes: readonly FileNode[], out: string[]): string[] {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      out.push(node.id);
      if (node.children) collectDirIds(node.children, out);
    }
  }
  return out;
}

function findNode(nodes: readonly FileNode[], id: string): FileNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const hit = findNode(node.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Keeps every file the predicate accepts, and every directory that still has
 * something inside it afterwards. A directory never survives empty, so a search
 * result is a list of real matches rather than a scaffold of hollow folders.
 */
function pruneTree(nodes: readonly FileNode[], keep: (node: FileNode) => boolean): FileNode[] {
  const out: FileNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'dir') {
      const children = node.children ? pruneTree(node.children, keep) : [];
      if (children.length > 0) out.push({ ...node, children });
      continue;
    }
    if (keep(node)) out.push(node);
  }
  return out;
}

function visibleRows(
  nodes: readonly FileNode[],
  expanded: ReadonlySet<string>,
  parentId: string | null,
  out: TreeRow[],
): TreeRow[] {
  for (const node of nodes) {
    out.push({ id: node.id, node, parentId });
    if (node.kind === 'dir' && expanded.has(node.id) && node.children) {
      visibleRows(node.children, expanded, node.id, out);
    }
  }
  return out;
}

/* ------------------------------------------------------------------- diff */

type DiffKind = 'meta' | 'hunk' | 'add' | 'del' | 'context';

interface DiffLine {
  readonly key: string;
  readonly kind: DiffKind;
  readonly oldNo: number | null;
  readonly newNo: number | null;
  readonly glyph: string;
  readonly text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A deliberately small unified-diff reader: enough to number the gutter and to
 * label each line, and nothing more. It does not apply, merge or write anything.
 */
function parseUnifiedDiff(diff: string): readonly DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;

  diff.split('\n').forEach((raw, index) => {
    const key = `diff-${index}`;

    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      out.push({ key, kind: 'meta', oldNo: null, newNo: null, glyph: '', text: raw });
      return;
    }

    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ key, kind: 'hunk', oldNo: null, newNo: null, glyph: '', text: raw });
      return;
    }

    if (raw.startsWith('+')) {
      out.push({ key, kind: 'add', oldNo: null, newNo, glyph: '+', text: raw.slice(1) });
      newNo += 1;
      return;
    }

    if (raw.startsWith('-')) {
      out.push({ key, kind: 'del', oldNo, newNo: null, glyph: '-', text: raw.slice(1) });
      oldNo += 1;
      return;
    }

    out.push({
      key,
      kind: 'context',
      oldNo,
      newNo,
      glyph: ' ',
      text: raw.startsWith(' ') ? raw.slice(1) : raw,
    });
    oldNo += 1;
    newNo += 1;
  });

  return out;
}

/* -------------------------------------------------------------- highlight */

function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text;
  const haystack = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let at = haystack.indexOf(needle);
  let hit = 0;

  while (at !== -1) {
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(
      <mark key={`hit-${hit}`} className="fw-files__match">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    hit += 1;
    cursor = at + needle.length;
    at = haystack.indexOf(needle, cursor);
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/* --------------------------------------------------------------- fragments */

function ChangeMarker({ change, full = false }: { change: ChangeKey; full?: boolean }) {
  const mark = CHANGE_MARKS[change];
  return (
    <span className="fw-files__change" data-change={change} title={mark.description}>
      <span className="fw-files__change-glyph fg-machine" aria-hidden="true">
        {mark.glyph}
      </span>
      <span className="fw-files__change-label fg-machine" aria-hidden="true">
        {full ? mark.label : mark.short}
      </span>
      <span className="fw-visually-hidden">{mark.description}</span>
    </span>
  );
}

function DiffView({ diff, path }: { diff: string; path: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const added = lines.filter((line) => line.kind === 'add').length;
  const removed = lines.filter((line) => line.kind === 'del').length;

  return (
    <section className="fw-files__diff" aria-label="Unified diff">
      <header className="fw-files__diff-head">
        <Eyebrow>UNIFIED DIFF</Eyebrow>
        <Machine muted className="fw-files__diff-count">
          {`+${added} / -${removed}`}
        </Machine>
        <Spacer />
        <ExampleTag detail="Example patch. No repository was read and no file was opened — this diff is local example text." />
      </header>

      <div
        className="fw-files__diff-scroll"
        role="group"
        aria-label={`Unified diff for ${path}. Read only.`}
        tabIndex={0}
      >
        <div className="fw-files__diff-body">
          {lines.map((line) => (
            <div key={line.key} className="fw-files__dline" data-kind={line.kind}>
              <span className="fw-files__dnum" aria-hidden="true">
                {line.oldNo ?? ''}
              </span>
              <span className="fw-files__dnum" aria-hidden="true">
                {line.newNo ?? ''}
              </span>
              <span className="fw-files__dglyph" aria-hidden="true">
                {line.glyph}
              </span>
              {line.kind === 'add' || line.kind === 'del' ? (
                <span className="fw-visually-hidden">
                  {line.kind === 'add' ? 'Added line: ' : 'Removed line: '}
                </span>
              ) : null}
              <code className="fw-files__dcode">{line.text === '' ? ' ' : line.text}</code>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------ real file preview */

/**
 * Human phrasing for `files.mjs`'s denylist reason codes — kept here, not in
 * the adapter, mirroring how `CHANGE_MARKS` above already owns turning a raw
 * field into display text for this same view.
 */
const BLOCK_REASON_LABEL: Readonly<Record<string, string>> = {
  'env-file': 'an environment file',
  'key-or-pem-file': 'a private key file',
  'ssh-private-key': 'an SSH private key',
  'git-config': "git's own config file",
  'node-modules-content': 'a dependency inside node_modules',
  'secret-pattern-detected': 'content that looks like a credential',
};

function blockReasonLabel(reason: string | null): string {
  if (reason === null) return 'this project’s file-preview policy';
  return BLOCK_REASON_LABEL[reason] ?? reason;
}

/**
 * The real `/api/files/read` result for the selected file. Reuses the DIFF
 * viewer's own CSS classes (line-numbered, monospace, scrollable) for the
 * successful text case — zero new tokens/colours/spacing — but never the
 * `DiffView` component itself: its `ExampleTag` copy ("no repository was
 * read...") would be a live falsehood once a real file really was read.
 * Every other outcome (blocked/binary/error/still loading) renders through
 * the SAME `EmptyState` primitive the view already uses for "no diff
 * recorded" — new labels for a genuinely new state, not a changed one.
 */
function FilePreviewBody({ preview }: { preview: GatewayFilePreview | null }) {
  if (preview === null) {
    return (
      <EmptyState
        compact
        icon="Loader"
        title="Reading the file…"
        detail="Fetching this file's content from the working tree."
      />
    );
  }

  if (preview.status === 'blocked') {
    return (
      <EmptyState
        compact
        icon="Lock"
        title="Preview blocked"
        detail={`The gateway refuses to read this file's bytes because it looks like ${blockReasonLabel(preview.reason)}. Nothing was read.`}
      />
    );
  }

  if (preview.status === 'binary') {
    return (
      <EmptyState
        compact
        icon="File"
        title="Binary file"
        detail="This file's content is binary, so it cannot be shown as text."
      />
    );
  }

  if (preview.status === 'error') {
    return (
      <EmptyState
        compact
        icon="CircleAlert"
        title="Preview failed"
        detail={preview.error ?? 'The gateway could not read this file.'}
      />
    );
  }

  const lines = preview.content !== null ? preview.content.split('\n') : [];

  return (
    <section className="fw-files__diff" aria-label="File preview">
      <header className="fw-files__diff-head">
        <Eyebrow>FILE PREVIEW</Eyebrow>
        <Machine muted className="fw-files__diff-count">
          {preview.truncated ? 'TRUNCATED' : `${lines.length} lines`}
        </Machine>
      </header>

      <div
        className="fw-files__diff-scroll"
        role="group"
        aria-label="File content. Read only."
        tabIndex={0}
      >
        <div className="fw-files__diff-body">
          {lines.map((line, index) => (
            <div key={`fpv-${index}`} className="fw-files__dline" data-kind="context">
              <span className="fw-files__dnum" aria-hidden="true">
                {index + 1}
              </span>
              <span className="fw-files__dnum" aria-hidden="true" />
              <span className="fw-files__dglyph" aria-hidden="true">
                {' '}
              </span>
              <code className="fw-files__dcode">{line === '' ? ' ' : line}</code>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- view */

export default function FilesView() {
  const { state, dispatch } = usePrototype();
  const tree = state.data.files;
  // `null` on the fixture path (see gateway-files.ts's header) — every branch
  // below that touches it is additive, so the fixture behaviour is unchanged.
  const filesActions = useFilesActions();

  const searchId = useId();
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    // The fixture's two starter folders do not exist in a real working tree —
    // production starts with nothing pre-expanded rather than guessing one.
    () => (filesActions ? new Set<string>() : new Set(['fn-src', 'fn-src-booking'])),
  );
  /** Folders the reader shut *while filtering*. Kept apart from `expanded` so
   *  the browsing state survives a search rather than being overwritten by it. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const needle = query.trim().toLowerCase();
  const filtering = needle !== '' || changedOnly;

  const allFiles = useMemo(() => flattenFiles(tree, []), [tree]);

  const changeCounts = useMemo(() => {
    const counts: Record<ChangeKey, number> = { added: 0, modified: 0, deleted: 0 };
    for (const file of allFiles) if (file.changed) counts[file.changed] += 1;
    return counts;
  }, [allFiles]);

  const recent = useMemo(
    () =>
      [...allFiles]
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, 7),
    [allFiles],
  );

  const prunedTree = useMemo(() => {
    if (!filtering) return tree;
    return pruneTree(tree, (node) => {
      if (changedOnly && !node.changed) return false;
      if (!needle) return true;
      return (
        node.name.toLowerCase().includes(needle) || node.path.toLowerCase().includes(needle)
      );
    });
  }, [tree, filtering, changedOnly, needle]);

  /**
   * Which folders are open, derived rather than stored. While a filter is on,
   * every folder that survived the prune opens so a match can never hide behind
   * a shut parent — minus anything the reader deliberately closed.
   */
  const openIds = useMemo<ReadonlySet<string>>(() => {
    if (!filtering) return expanded;
    const open = new Set<string>();
    for (const id of collectDirIds(prunedTree, [])) {
      if (!collapsed.has(id)) open.add(id);
    }
    return open;
  }, [filtering, expanded, prunedTree, collapsed]);

  const rows = useMemo(
    () => visibleRows(prunedTree, openIds, null, []),
    [prunedTree, openIds],
  );

  const selectedId = state.selection.kind === 'file' ? state.selection.id : null;
  const selected = selectedId ? findNode(tree, selectedId) : null;

  const activeId =
    (focusedId && rows.some((row) => row.id === focusedId) ? focusedId : null) ??
    (selectedId && rows.some((row) => row.id === selectedId) ? selectedId : null) ??
    rows[0]?.id ??
    null;

  const selectFile = useCallback(
    (node: FileNode) => {
      dispatch({ type: 'select', selection: { kind: 'file', id: node.id } });
    },
    [dispatch],
  );

  const setOpen = useCallback(
    (id: string, open: boolean) => {
      // A real node's id IS its relative path (see gateway-files.ts), so this
      // is the one place a directory's children get fetched — lazily, only
      // once per directory, and only ever on the fixture path's no-op (null).
      if (open) filesActions?.ensureLoaded(id);
      // While filtering, "open" is the default, so the reader's intent is
      // recorded in the collapsed set instead.
      const apply = (previous: ReadonlySet<string>, member: boolean) => {
        const next = new Set(previous);
        if (member) next.add(id);
        else next.delete(id);
        return next;
      };
      if (filtering) setCollapsed((previous) => apply(previous, !open));
      else setExpanded((previous) => apply(previous, open));
    },
    [filtering, filesActions],
  );

  const toggleOpen = useCallback(
    (id: string) => {
      setOpen(id, !openIds.has(id));
    },
    [openIds, setOpen],
  );

  const focusRow = useCallback((id: string) => {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }, []);

  function handleTreeKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (!activeId) return;
    const index = rows.findIndex((row) => row.id === activeId);
    if (index === -1) return;

    const row = rows[index];
    const isDir = row.node.kind === 'dir';
    const isOpen = openIds.has(row.id);

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = rows[index + 1];
        if (next) focusRow(next.id);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const previous = rows[index - 1];
        if (previous) focusRow(previous.id);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (isDir && !isOpen) {
          setOpen(row.id, true);
        } else if (isDir && isOpen) {
          const child = rows[index + 1];
          if (child && child.parentId === row.id) focusRow(child.id);
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (isDir && isOpen) setOpen(row.id, false);
        else if (row.parentId) focusRow(row.parentId);
        break;
      }
      case 'Home': {
        event.preventDefault();
        if (rows[0]) focusRow(rows[0].id);
        break;
      }
      case 'End': {
        event.preventDefault();
        const last = rows[rows.length - 1];
        if (last) focusRow(last.id);
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (isDir) toggleOpen(row.id);
        else selectFile(row.node);
        break;
      }
      default:
        break;
    }
  }

  function renderNodes(nodes: readonly FileNode[], level: number): ReactNode {
    return nodes.map((node, index) => {
      const isDir = node.kind === 'dir';
      const isOpen = isDir && openIds.has(node.id);
      const isSelected = node.id === selectedId;

      return (
        <li
          key={node.id}
          role="treeitem"
          className="fw-files__item"
          aria-expanded={isDir ? isOpen : undefined}
          aria-selected={isSelected}
          aria-level={level}
          aria-posinset={index + 1}
          aria-setsize={nodes.length}
          tabIndex={node.id === activeId ? 0 : -1}
          ref={(element) => {
            if (element) rowRefs.current.set(node.id, element);
            else rowRefs.current.delete(node.id);
          }}
          onFocus={(event) => {
            event.stopPropagation();
            setFocusedId(node.id);
          }}
          onClick={(event) => {
            event.stopPropagation();
            setFocusedId(node.id);
            if (isDir) toggleOpen(node.id);
            else selectFile(node);
          }}
        >
          <span
            className="fw-files__row"
            data-selected={isSelected ? 'true' : undefined}
            style={{ '--fw-files-depth': level } as CSSProperties}
          >
            <span
              className="fw-files__twist"
              data-open={isDir && isOpen ? 'true' : undefined}
              aria-hidden="true"
            >
              {isDir ? <Icon name="ChevronRight" size="xs" /> : null}
            </span>
            <Icon name={iconForNode(node, isOpen)} size="sm" className="fw-files__glyph" />
            <span className="fw-files__name fg-machine fw-truncate">
              {highlight(node.name, needle)}
            </span>
            {node.changed ? <ChangeMarker change={node.changed} /> : null}
          </span>

          {isDir && isOpen && node.children && node.children.length > 0 ? (
            <ul role="group" className="fw-files__group">
              {renderNodes(node.children, level + 1)}
            </ul>
          ) : null}
        </li>
      );
    });
  }

  return (
    <div className="fw-files">
      <header className="fw-files__head">
        <div className="fw-files__heading">
          <h1 className="fw-files__title">Files</h1>
          <p className="fw-files__subtitle">
            {filesActions ? (
              "This project's working tree, read live from the gateway. Change markers and diffs are not available yet in this build."
            ) : (
              'The working tree as it stood mid-run, with change markers and read-only diffs. Example data — this fixture has no filesystem access.'
            )}
          </p>
        </div>

        <Toolbar label="File browser controls" className="fw-files__toolbar">
          <ToolbarGroup>
            {CHANGE_ORDER.map((change) => (
              <span key={change} className="fw-files__tally" title={CHANGE_MARKS[change].description}>
                <span className="fw-files__tally-glyph fg-machine" aria-hidden="true">
                  {CHANGE_MARKS[change].glyph}
                </span>
                <Machine muted>{changeCounts[change]}</Machine>
                <span className="fw-visually-hidden">
                  {`${changeCounts[change]} ${CHANGE_MARKS[change].label.toLowerCase()}`}
                </span>
                <span className="fw-files__tally-label fg-machine" aria-hidden="true">
                  {CHANGE_MARKS[change].short}
                </span>
              </span>
            ))}
          </ToolbarGroup>

          <Spacer />

          <ToolbarGroup divided>
            <span
              title={
                filesActions
                  ? 'No change-tracking data is available from the gateway yet.'
                  : undefined
              }
            >
              <Switch
                size="sm"
                checked={changedOnly}
                onChange={setChangedOnly}
                label="Changed only"
                disabled={filesActions !== null}
              />
            </span>
          </ToolbarGroup>

          <ToolbarGroup divided>
            <IconButton
              size="sm"
              icon="ChevronsUpDown"
              label="Expand all folders"
              onClick={() => {
                setExpanded(new Set(collectDirIds(tree, [])));
                setCollapsed(new Set());
              }}
            />
            <IconButton
              size="sm"
              icon="ChevronsDownUp"
              label="Collapse all folders"
              onClick={() => {
                setExpanded(new Set());
                setCollapsed(new Set(collectDirIds(tree, [])));
              }}
            />
          </ToolbarGroup>
        </Toolbar>
      </header>

      <section className="fw-files__recent" aria-label="Recent files">
        <Eyebrow className="fw-files__recent-label">RECENT</Eyebrow>
        <ul className="fw-files__recent-list">
          {recent.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                className="fw-files__chip"
                aria-pressed={node.id === selectedId}
                onClick={() => selectFile(node)}
              >
                <Icon name={iconForNode(node)} size="xs" />
                <span className="fw-files__chip-name fg-machine fw-truncate">{node.name}</span>
                {node.changed ? (
                  <span
                    className="fw-files__chip-mark fg-machine"
                    title={CHANGE_MARKS[node.changed].description}
                  >
                    <span aria-hidden="true">{CHANGE_MARKS[node.changed].glyph}</span>
                    <span className="fw-visually-hidden">
                      {CHANGE_MARKS[node.changed].description}
                    </span>
                  </span>
                ) : null}
                <span className="fw-visually-hidden">{`Updated ${node.updatedAt ?? 'unknown'}`}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="fw-files__panes">
        <section className="fw-files__pane fw-files__pane--tree" aria-label="File tree">
          <div className="fw-files__search">
            <label className="fw-visually-hidden" htmlFor={searchId}>
              Filter files by name or path
            </label>
            <Icon name="Search" size="sm" className="fw-files__search-icon" />
            <input
              id={searchId}
              type="search"
              className="fw-files__search-input fg-machine"
              placeholder="Filter by name or path"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {query ? (
              <IconButton
                size="sm"
                icon="X"
                label="Clear the filter"
                className="fw-files__search-clear"
                onClick={() => setQuery('')}
              />
            ) : null}
          </div>

          <div className="fw-files__tree-scroll fw-scroll">
            {rows.length === 0 ? (
              <EmptyState
                compact
                icon="SearchX"
                title={filtering ? 'No files match' : 'No files yet'}
                detail={
                  filtering
                    ? 'No file matches that filter. Clear it to see the whole working tree again.'
                    : 'This project has no files to show yet.'
                }
              />
            ) : (
              <ul
                className="fw-files__tree"
                role="tree"
                aria-label="Project files"
                aria-multiselectable={false}
                onKeyDown={handleTreeKeyDown}
              >
                {renderNodes(prunedTree, 1)}
              </ul>
            )}
          </div>
        </section>

        <section className="fw-files__pane fw-files__pane--preview" aria-label="File preview">
          {selected ? (
            <>
              <header className="fw-files__preview-head">
                <Icon name={iconForNode(selected)} size="md" className="fw-files__preview-glyph" />
                <Machine className="fw-files__preview-name fw-truncate">{selected.name}</Machine>
                {selected.changed ? <ChangeMarker change={selected.changed} full /> : null}
                <Spacer />
                <IconButton
                  size="sm"
                  icon="X"
                  label="Clear the selection"
                  onClick={() => dispatch({ type: 'select', selection: { kind: 'none' } })}
                />
              </header>

              <div className="fw-files__preview-scroll fw-scroll">
                <dl className="fw-files__meta">
                  <div className="fw-files__meta-row">
                    <dt className="fg-eyebrow">PATH</dt>
                    <dd>
                      <Machine>{selected.path}</Machine>
                    </dd>
                  </div>
                  <div className="fw-files__meta-row">
                    <dt className="fg-eyebrow">SIZE</dt>
                    <dd>
                      <Machine>{selected.size ?? '—'}</Machine>
                    </dd>
                  </div>
                  <div className="fw-files__meta-row">
                    <dt className="fg-eyebrow">UPDATED</dt>
                    <dd>
                      <Machine>{selected.updatedAt ?? '—'}</Machine>
                    </dd>
                  </div>
                  <div className="fw-files__meta-row">
                    <dt className="fg-eyebrow">CHANGE</dt>
                    <dd>
                      {selected.changed ? (
                        <ChangeMarker change={selected.changed} full />
                      ) : filesActions ? (
                        // The real gateway has no git-diff concept (see
                        // gateway-files.ts's header) — "UNCHANGED" would claim a
                        // check that never ran. Honest absence instead.
                        <Machine muted>NOT TRACKED</Machine>
                      ) : (
                        <Machine muted>UNCHANGED</Machine>
                      )}
                    </dd>
                  </div>
                </dl>

                {selected.diff ? (
                  <DiffView diff={selected.diff} path={selected.path} />
                ) : filesActions ? (
                  <FilePreviewBody preview={filesActions.preview} />
                ) : (
                  <EmptyState
                    compact
                    icon="FileDiff"
                    title="No diff recorded"
                    detail="This example record carries metadata only. A handful of files in the tree carry a patch — try slots.ts, booking.css or README.md."
                  />
                )}
              </div>
            </>
          ) : (
            <EmptyState
              icon="FileSearch"
              title="No file selected"
              detail="Pick a file in the tree, or one of the recent files above, to see its metadata and — where one was recorded — its diff."
            />
          )}
        </section>
      </div>
    </div>
  );
}
