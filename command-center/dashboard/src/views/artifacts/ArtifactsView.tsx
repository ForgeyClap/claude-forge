/**
 * ArtifactsView — the gallery of everything a run produces.
 *
 * Reads `state.data.artifacts` and `state.activeProjectId`. build-lastdemos
 * adds a real `GET /api/artifacts/:id/content` gateway route (see
 * `artifact-content.mjs`), so "Download" is a real anchor to that endpoint —
 * an actual browser download of the real file, not a fetch-then-save dance —
 * whenever an active project is known. The screenshot/diagram records still
 * render as a described capture frame rather than an inline `<img>`: the real
 * recorded metadata (dimensions when known, the `stat()`'d byte size shown
 * elsewhere on this pane) plus a real Download link, not yet a fetched image
 * rendered inline here.
 *
 * `redactDeep` (redact.mjs) covers JSON responses this gateway builds itself;
 * a raw file download is the user's own explicit request for those exact
 * bytes and is intentionally NOT redacted — see this WP's forge-report.
 *
 * The markdown formatter below is deliberately tiny and local — headings,
 * paragraphs, lists and inline code. It is not shared with the chat view and it
 * pulls in no dependency.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import {
  Avatar,
  Button,
  EmptyState,
  Eyebrow,
  ExampleTag,
  Icon,
  IconButton,
  Machine,
  SegmentedControl,
  Spacer,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import type { Artifact, ArtifactKind } from '@/prototype/types/prototype-types';
import { GATEWAY_ORIGIN } from '@/prototype/state/gateway-client';

import './artifacts.css';

/* ------------------------------------------------------------------ kinds */

const KINDS: readonly ArtifactKind[] = [
  'screenshot',
  'report',
  'diagram',
  'markdown',
  'log',
  'receipt',
  'proof',
];

type KindFilter = ArtifactKind | 'all';

const KIND_ICONS: Readonly<Record<ArtifactKind, string>> = {
  screenshot: 'Image',
  report: 'ClipboardList',
  diagram: 'Workflow',
  markdown: 'FileText',
  log: 'ScrollText',
  receipt: 'Receipt',
  proof: 'ShieldCheck',
};

type GalleryLayout = 'grid' | 'list';

/* --------------------------------------------------------------- markdown */

type MarkdownBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] };

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+\.\s+(.*)$/;

/**
 * Headings, paragraphs and lists. Anything else is treated as prose, which is
 * the honest failure mode for a formatter this small.
 */
function parseMarkdown(source: string): readonly MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };

  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ kind: 'list', ordered: listOrdered, items: listItems });
      listItems = [];
    }
  };

  for (const raw of source.split('\n')) {
    const line = raw.trim();

    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      if (listOrdered) flushList();
      listOrdered = false;
      listItems.push(bullet[1]);
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      flushParagraph();
      if (!listOrdered) flushList();
      listOrdered = true;
      listItems.push(numbered[1]);
      continue;
    }

    // An indented continuation of the item above it — the example documents
    // wrap their list items across lines.
    if (listItems.length > 0 && paragraph.length === 0 && /^\s{2,}\S/.test(raw)) {
      listItems[listItems.length - 1] = `${listItems[listItems.length - 1]} ${line}`;
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** `code` → <Machine>, **bold** → <strong>, *italic* → <em>. Nothing else. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  const out: ReactNode[] = [];
  let cursor = 0;
  let seq = 0;
  let match = pattern.exec(text);

  while (match) {
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyBase}-inline-${seq}`;
    seq += 1;

    if (token.startsWith('`')) {
      out.push(<Machine key={key}>{token.slice(1, -1)}</Machine>);
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    cursor = match.index + token.length;
    match = pattern.exec(text);
  }

  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function MarkdownBody({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);

  return (
    <div className="fw-artifacts__md">
      {blocks.map((block, index) => {
        const key = `block-${index}`;

        if (block.kind === 'heading') {
          const content = renderInline(block.text, key);
          if (block.level <= 1) {
            return (
              <h3 key={key} className="fw-artifacts__md-h1">
                {content}
              </h3>
            );
          }
          if (block.level === 2) {
            return (
              <h4 key={key} className="fw-artifacts__md-h2">
                {content}
              </h4>
            );
          }
          return (
            <h5 key={key} className="fw-artifacts__md-h3">
              {content}
            </h5>
          );
        }

        if (block.kind === 'list') {
          const items = block.items.map((item, itemIndex) => (
            <li key={`${key}-item-${itemIndex}`}>{renderInline(item, `${key}-item-${itemIndex}`)}</li>
          ));
          return block.ordered ? (
            <ol key={key} className="fw-artifacts__md-list">
              {items}
            </ol>
          ) : (
            <ul key={key} className="fw-artifacts__md-list">
              {items}
            </ul>
          );
        }

        return (
          <p key={key} className="fw-artifacts__md-p">
            {renderInline(block.text, key)}
          </p>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- capture frame */

const DIMENSIONS = /(\d{3,4})\s*[x×]\s*(\d{3,4})/;

/**
 * F2 (forge-2026-07-29-cc-finish, fix-cert-claims): this note used to claim
 * "no image file exists behind this record". That was false whenever a real
 * agent produced the artifact — `gateway-adapter.ts`'s `toGatewayArtifact`
 * reports a real, server-`stat()`'d `size_bytes` for these rows (rendered a
 * few lines below, in the SIZE field and this figure's caption), so a file
 * plainly does exist.
 *
 * build-lastdemos: the gap it narrowed to is now closed for DOWNLOADING the
 * file (a real `GET /api/artifacts/:id/content` route exists — see the
 * Download control in this view's preview footer), but this frame still does
 * not fetch the bytes and render them inline as an `<img>` — that remains a
 * separate, not-yet-built capability, named honestly below instead of implied.
 */
function CaptureFrame({ artifact }: { artifact: Artifact }) {
  const found = DIMENSIONS.exec(artifact.preview);
  const width = found ? Number(found[1]) : null;
  const height = found ? Number(found[2]) : null;
  const ratio = width && height ? `${width} / ${height}` : '16 / 10';

  return (
    <figure className="fw-artifacts__frame">
      <div
        className="fw-artifacts__frame-box"
        style={{ '--fw-artifacts-ratio': ratio } as CSSProperties}
      >
        <Icon name={artifact.kind === 'diagram' ? 'Workflow' : 'ImageOff'} size="lg" />
        <Machine muted className="fw-artifacts__frame-dims">
          {width && height ? `${width} × ${height}` : 'DIMENSIONS NOT RECORDED'}
        </Machine>
        <p className="fw-artifacts__frame-note">
          This capture is not rendered inline here yet — use Download below to fetch the real
          file; the details recorded about it are shown below instead.
        </p>
      </div>
      <figcaption className="fw-artifacts__frame-caption">{artifact.preview}</figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------- cards */

/**
 * feat-chatruns-tabs: a chat-run-derived artifact (`gateway-adapter.ts`'s `toGatewayChatRunArtifacts`)
 * carries the real chat-run id — `chat-<conversationId>-<turnId>`, visually distinct from a Forge
 * run id — in `producedBy` (see that function's own doc comment). Such a row represents a real file
 * edit the dashboard chat made directly, never a Forge-stored artifact copy; `GET
 * /api/artifacts/:id/content` has no matching entry for it (no `.claude/forge-artifacts/` index doc,
 * no run `artifacts/` directory file), so a real Download anchor for it would honestly 404. Rather
 * than ship that broken control, the SAME existing disabled-`Button` branch this view already uses
 * for "no active project known" covers this case too — reused, not duplicated.
 */
function isChatRunArtifact(artifact: Artifact): boolean {
  return artifact.producedBy.startsWith('chat-');
}

/** First line of the body that is not a heading, collapsed to one line. */
function summarise(preview: string): string {
  for (const raw of preview.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    return line.replace(/[*`]/g, '').replace(/\s+/g, ' ');
  }
  return 'No summary recorded.';
}

/* --------------------------------------------------------------- filter bar */

interface KindFilterBarProps {
  value: KindFilter;
  onChange: (value: KindFilter) => void;
  counts: Readonly<Record<KindFilter, number>>;
}

function KindFilterBar({ value, onChange, counts }: KindFilterBarProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const options = useMemo<readonly KindFilter[]>(() => ['all', ...KINDS], []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = options.indexOf(value);
    let next = -1;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (current + 1) % options.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (current - 1 + options.length) % options.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = options.length - 1;
    }

    if (next < 0) return;
    event.preventDefault();
    onChange(options[next]);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div
      ref={groupRef}
      className="fw-artifacts__filters"
      role="radiogroup"
      aria-label="Filter artifacts by kind"
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const selected = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className="fw-artifacts__filter"
            onClick={() => onChange(option)}
          >
            <Icon
              name={option === 'all' ? 'LayoutList' : KIND_ICONS[option]}
              size="xs"
              className="fw-artifacts__filter-glyph"
            />
            <span className="fw-artifacts__filter-label fg-machine">{option.toUpperCase()}</span>
            <span className="fw-artifacts__filter-count fg-machine">{counts[option]}</span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------- view */

const LAYOUT_OPTIONS = [
  { value: 'grid', label: 'Grid', icon: 'LayoutGrid' },
  { value: 'list', label: 'List', icon: 'List' },
];

export default function ArtifactsView() {
  const { state, dispatch } = usePrototype();
  const artifacts = state.data.artifacts;

  const [kind, setKind] = useState<KindFilter>('all');
  const [layout, setLayout] = useState<GalleryLayout>('grid');

  const counts = useMemo<Record<KindFilter, number>>(() => {
    const tally: Record<KindFilter, number> = {
      all: artifacts.length,
      screenshot: 0,
      report: 0,
      diagram: 0,
      markdown: 0,
      log: 0,
      receipt: 0,
      proof: 0,
    };
    for (const artifact of artifacts) tally[artifact.kind] += 1;
    return tally;
  }, [artifacts]);

  const shown = useMemo(
    () => (kind === 'all' ? artifacts : artifacts.filter((artifact) => artifact.kind === kind)),
    [artifacts, kind],
  );

  const selectedId = state.selection.kind === 'artifact' ? state.selection.id : null;
  const selected = selectedId
    ? (artifacts.find((artifact) => artifact.id === selectedId) ?? null)
    : null;

  const select = useCallback(
    (artifact: Artifact) => {
      dispatch({ type: 'select', selection: { kind: 'artifact', id: artifact.id } });
    },
    [dispatch],
  );

  return (
    <div className="fw-artifacts">
      <header className="fw-artifacts__head">
        <div className="fw-artifacts__heading">
          <h1 className="fw-artifacts__title">Artifacts</h1>
          <p className="fw-artifacts__subtitle">
            Everything this run recorded as evidence — reports, captures, logs and the proof ledger.
          </p>
        </div>

        <Toolbar label="Artifact gallery controls" className="fw-artifacts__toolbar">
          <ToolbarGroup>
            <Machine muted className="fw-artifacts__count">
              {`${shown.length} / ${artifacts.length}`}
            </Machine>
            <Eyebrow>SHOWN</Eyebrow>
          </ToolbarGroup>

          <Spacer />

          <ToolbarGroup divided>
            <SegmentedControl
              label="Gallery layout"
              size="sm"
              iconOnly
              options={LAYOUT_OPTIONS}
              value={layout}
              onChange={(value) => setLayout(value === 'list' ? 'list' : 'grid')}
            />
          </ToolbarGroup>
        </Toolbar>

        <KindFilterBar value={kind} onChange={setKind} counts={counts} />
      </header>

      <div className="fw-artifacts__body" data-preview={selected ? 'true' : undefined}>
        <section className="fw-artifacts__gallery fw-scroll" aria-label="Artifact gallery">
          {shown.length === 0 ? (
            <EmptyState
              icon="PackageOpen"
              title="No artifacts of that kind"
              detail="Nothing was recorded under this filter. Switch back to ALL to see the whole set."
            />
          ) : (
            <ul className="fw-artifacts__list" data-layout={layout}>
              {shown.map((artifact) => {
                const isSelected = artifact.id === selectedId;
                return (
                  <li key={artifact.id}>
                    <button
                      type="button"
                      className="fw-artifacts__card"
                      aria-pressed={isSelected}
                      onClick={() => select(artifact)}
                    >
                      <span className="fw-artifacts__card-top">
                        <Icon
                          name={KIND_ICONS[artifact.kind]}
                          size="sm"
                          className="fw-artifacts__card-glyph"
                        />
                        <Machine className="fw-artifacts__card-name fw-truncate">
                          {artifact.name}
                        </Machine>
                        <span className="fw-artifacts__kind fg-machine">
                          {artifact.kind.toUpperCase()}
                        </span>
                      </span>

                      <span className="fw-artifacts__card-summary">
                        {summarise(artifact.preview)}
                      </span>

                      <span className="fw-artifacts__card-foot">
                        <Avatar name={artifact.producedBy} size="sm" decorative />
                        <Machine muted className="fw-truncate">
                          {artifact.producedBy}
                        </Machine>
                        <Spacer />
                        <Machine muted>{artifact.size}</Machine>
                        <span className="fw-artifacts__sep" aria-hidden="true" />
                        <Machine muted>{artifact.createdAt}</Machine>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {selected ? (
          <aside className="fw-artifacts__preview" aria-label={`Preview of ${selected.name}`}>
            <header className="fw-artifacts__preview-head">
              <Icon
                name={KIND_ICONS[selected.kind]}
                size="md"
                className="fw-artifacts__preview-glyph"
              />
              <Machine className="fw-artifacts__preview-name fw-truncate">{selected.name}</Machine>
              <ExampleTag detail="Example artifact. No tool produced this and no file exists behind it — the body is local example text." />
              <IconButton
                size="sm"
                icon="X"
                label="Close the preview"
                onClick={() => dispatch({ type: 'select', selection: { kind: 'none' } })}
              />
            </header>

            <div className="fw-artifacts__preview-scroll fw-scroll">
              <dl className="fw-artifacts__meta">
                <div className="fw-artifacts__meta-row">
                  <dt className="fg-eyebrow">KIND</dt>
                  <dd>
                    <Machine>{selected.kind.toUpperCase()}</Machine>
                  </dd>
                </div>
                <div className="fw-artifacts__meta-row">
                  <dt className="fg-eyebrow">AGENT</dt>
                  <dd>
                    <Machine>{selected.producedBy}</Machine>
                  </dd>
                </div>
                <div className="fw-artifacts__meta-row">
                  <dt className="fg-eyebrow">TASK</dt>
                  <dd>
                    <Machine muted={selected.taskId === null}>{selected.taskId ?? '—'}</Machine>
                  </dd>
                </div>
                <div className="fw-artifacts__meta-row">
                  <dt className="fg-eyebrow">CREATED</dt>
                  <dd>
                    <Machine>{selected.createdAt}</Machine>
                  </dd>
                </div>
                <div className="fw-artifacts__meta-row">
                  <dt className="fg-eyebrow">SIZE</dt>
                  <dd>
                    <Machine>{selected.size}</Machine>
                  </dd>
                </div>
              </dl>

              <div className="fw-artifacts__preview-body">
                {selected.kind === 'markdown' || selected.kind === 'report' ? (
                  <MarkdownBody source={selected.preview} />
                ) : selected.kind === 'screenshot' || selected.kind === 'diagram' ? (
                  <CaptureFrame artifact={selected} />
                ) : (
                  <pre className="fw-artifacts__output fg-machine">{selected.preview}</pre>
                )}
              </div>
            </div>

            <footer className="fw-artifacts__preview-foot">
              {isChatRunArtifact(selected) ? (
                <Button
                  size="sm"
                  icon="Download"
                  disabled
                  title="This file was edited directly by a dashboard chat run, not stored as a separate artifact — there is no downloadable copy on the gateway."
                >
                  Download
                </Button>
              ) : state.activeProjectId ? (
                <a
                  className="fw-control fw-button fw-button--ghost fw-button--sm"
                  href={`${GATEWAY_ORIGIN}/api/artifacts/${encodeURIComponent(selected.id)}/content?project=${encodeURIComponent(state.activeProjectId)}`}
                  download={selected.name}
                >
                  <Icon name="Download" size="xs" className="fw-button__icon" />
                  <span className="fw-button__label">Download</span>
                </a>
              ) : (
                <Button
                  size="sm"
                  icon="Download"
                  disabled
                  title="Select an active project first — the download route is project-scoped."
                >
                  Download
                </Button>
              )}
            </footer>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
