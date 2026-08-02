/**
 * Forge Workspace — the prototype's own small Markdown renderer.
 *
 * Written by hand on purpose. There is no markdown dependency and no
 * `dangerouslySetInnerHTML` anywhere: the source string is parsed into a list of
 * block descriptors and every one of them becomes a real React element. Nothing
 * from the example data can ever become markup.
 *
 * Supported, and deliberately no more than this:
 *   headings, paragraphs, bold, italic, inline code, links, ordered and
 *   unordered lists, blockquotes, tables, horizontal rules, fenced code blocks.
 *
 * Provenance: prose renders in the sans face, inline code and code blocks in the
 * mono face via `.fg-machine`, because those are what the machine recorded.
 */

import { createElement } from 'react';
import type { ReactNode } from 'react';
import { ExampleTag, IconButton, Machine, Spacer } from '@/components/primitives';

/* ------------------------------------------------------------------ types */

type Align = 'left' | 'center' | 'right';

interface HeadingBlock {
  readonly kind: 'heading';
  readonly level: number;
  readonly text: string;
}
interface ParagraphBlock {
  readonly kind: 'paragraph';
  readonly text: string;
}
interface CodeFenceBlock {
  readonly kind: 'code';
  readonly lang: string;
  readonly code: string;
}
interface ListBlock {
  readonly kind: 'list';
  readonly ordered: boolean;
  readonly start: number;
  readonly items: readonly string[];
}
interface QuoteBlock {
  readonly kind: 'quote';
  readonly text: string;
}
interface RuleBlock {
  readonly kind: 'rule';
}
interface TableBlock {
  readonly kind: 'table';
  readonly header: readonly string[];
  readonly align: readonly Align[];
  readonly rows: readonly (readonly string[])[];
}

type Block =
  | HeadingBlock
  | ParagraphBlock
  | CodeFenceBlock
  | ListBlock
  | QuoteBlock
  | RuleBlock
  | TableBlock;

export interface MarkdownOptions {
  /**
   * Called when a code block's copy button is pressed. The renderer never
   * touches the clipboard itself — the caller decides what "copy" means and
   * raises the toast.
   */
  readonly onCopy?: (code: string, lang: string) => void;
  /** Append the streaming caret to the end of the last block. */
  readonly caret?: boolean;
  /** Namespaces the generated React keys. */
  readonly idPrefix?: string;
}

/* ----------------------------------------------------------------- lexing */

const UL = /^(\s*)([-*+])\s+(.*)$/;
const OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const RULE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

function isFenceClose(line: string, token: string): boolean {
  const text = line.trim();
  return text.length >= 3 && text.split('').every((char) => char === token);
}

/** True when the line opens a new block, so a paragraph or list must stop. */
function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index];
  if (line.trim() === '') return true;
  if (FENCE.test(line)) return true;
  if (HEADING.test(line)) return true;
  if (RULE.test(line)) return true;
  if (line.trim().startsWith('>')) return true;
  if (UL.test(line) || OL.test(line)) return true;
  if (line.trim().startsWith('|') && index + 1 < lines.length && isSeparatorRow(lines[index + 1])) {
    return true;
  }
  return false;
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    /* fenced code — read first, because anything may live inside it */
    const fence = FENCE.exec(line);
    if (fence) {
      const token = fence[1][0];
      const lang = (fence[2] ?? '').toLowerCase();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFenceClose(lines[i], token)) {
        body.push(lines[i]);
        i += 1;
      }
      // An unterminated fence is normal while a reply is still streaming.
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'code', lang, code: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (line.trim().startsWith('>')) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        parts.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', text: parts.join(' ').trim() });
      continue;
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', header, align, rows });
      continue;
    }

    const ordered = OL.test(line);
    if (ordered || UL.test(line)) {
      const first = ordered ? OL.exec(line) : UL.exec(line);
      const start = ordered && first ? Number.parseInt(first[2], 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const item = ordered ? OL.exec(lines[i]) : UL.exec(lines[i]);
        if (item) {
          items.push(item[3].trim());
          i += 1;
          continue;
        }
        if (startsBlock(lines, i)) break;
        if (items.length === 0) break;
        // An indented continuation line belongs to the item above it.
        items[items.length - 1] = `${items[items.length - 1]} ${lines[i].trim()}`;
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    /* paragraph — hard-wrapped lines rejoin with a single space */
    const parts = [line.trim()];
    i += 1;
    while (i < lines.length && !startsBlock(lines, i)) {
      parts.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: parts.join(' ') });
  }

  return blocks;
}

/* ----------------------------------------------------------------- inline */

const INLINE_SOURCE =
  '`([^`]+)`' +
  '|\\*\\*([\\s\\S]+?)\\*\\*' +
  '|__([\\s\\S]+?)__' +
  '|\\*([^*\\n]+?)\\*' +
  '|_([^_\\n]+?)_' +
  '|\\[([^\\]]+)\\]\\(([^)\\s]+)\\)';

/**
 * Only these schemes become a real link. Anything else renders as literal text,
 * which is how a `javascript:` URL in example data stays inert.
 */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return /^(https?:\/\/|mailto:|#|\/)/i.test(trimmed) ? trimmed : null;
}

function renderInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // A fresh regex per call: renderInline recurses, and a shared /g lastIndex
  // would be clobbered by the inner pass.
  const rule = new RegExp(INLINE_SOURCE, 'g');
  let last = 0;
  let seq = 0;
  let match = rule.exec(text);

  while (match !== null) {
    const start = match.index;
    const underscored = match[3] !== undefined || match[5] !== undefined;
    const before = start > 0 ? text[start - 1] : '';

    // snake_case_names are not emphasis. Skip and keep the literal text.
    if (underscored && /\w/.test(before)) {
      rule.lastIndex = start + 1;
      match = rule.exec(text);
      continue;
    }

    if (start > last) out.push(text.slice(last, start));

    seq += 1;
    const itemKey = `${key}-x${seq}`;

    if (match[1] !== undefined) {
      out.push(
        <code key={itemKey} className="fw-chat-md__code-inline fg-machine">
          {match[1]}
        </code>,
      );
    } else if (match[2] !== undefined) {
      out.push(<strong key={itemKey}>{renderInline(match[2], itemKey)}</strong>);
    } else if (match[3] !== undefined) {
      out.push(<strong key={itemKey}>{renderInline(match[3], itemKey)}</strong>);
    } else if (match[4] !== undefined) {
      out.push(<em key={itemKey}>{renderInline(match[4], itemKey)}</em>);
    } else if (match[5] !== undefined) {
      out.push(<em key={itemKey}>{renderInline(match[5], itemKey)}</em>);
    } else if (match[6] !== undefined) {
      const href = safeHref(match[7] ?? '');
      out.push(
        href === null ? (
          <span key={itemKey}>{match[0]}</span>
        ) : (
          <a
            key={itemKey}
            className="fw-chat-md__link"
            href={href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {renderInline(match[6], itemKey)}
          </a>
        ),
      );
    }

    last = start + match[0].length;
    rule.lastIndex = last;
    match = rule.exec(text);
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* -------------------------------------------------------------- rendering */

/** Fenced output that looks like evidence gets the honesty chip in its header. */
const OUTPUT_LANGS = new Set(['text', 'bash', 'sh', 'shell', 'console', 'diff', 'log']);

const OUTPUT_DETAIL =
  'Example output. Nothing was executed — this prototype has no terminal, no runtime and no connection.';

/*
 * These are element builders rather than components on purpose: this module is
 * a renderer, everything in it is called from renderBlock, and keeping the file
 * component-free is what lets the whole renderer live in one readable file.
 */

function codeBlock(
  key: string,
  code: string,
  lang: string,
  onCopy: MarkdownOptions['onCopy'],
): ReactNode {
  const label = lang === '' ? 'text' : lang;
  return (
    <div className="fw-chat-md__code" key={key}>
      <div className="fw-chat-md__code-head">
        <Machine muted className="fw-chat-md__code-lang">
          {label}
        </Machine>
        {OUTPUT_LANGS.has(label) ? <ExampleTag detail={OUTPUT_DETAIL} /> : null}
        <Spacer />
        <IconButton
          icon="Copy"
          label={`Copy the ${label} block`}
          size="sm"
          onClick={() => onCopy?.(code, label)}
        />
      </div>
      <pre className="fw-chat-md__code-body">
        <code className="fg-machine">{code}</code>
      </pre>
    </div>
  );
}

function streamCaret(key?: string): ReactNode {
  return <span className="fw-chat-caret" key={key} aria-hidden="true" />;
}

function renderBlock(
  block: Block,
  key: string,
  options: MarkdownOptions,
  withCaret: boolean,
): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6);
      const tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return createElement(
        tag,
        { key, className: `fw-chat-md__h fw-chat-md__h--${level}` },
        renderInline(block.text, key),
      );
    }

    case 'paragraph':
      return (
        <p key={key} className="fw-chat-md__p">
          {renderInline(block.text, key)}
          {withCaret ? streamCaret() : null}
        </p>
      );

    case 'code':
      return codeBlock(key, block.code, block.lang, options.onCopy);

    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={`${key}-l${index}`} className="fw-chat-md__li">
          {renderInline(item, `${key}-l${index}`)}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} className="fw-chat-md__ol" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key} className="fw-chat-md__ul">
          {items}
        </ul>
      );
    }

    case 'quote':
      return (
        <blockquote key={key} className="fw-chat-md__quote">
          {renderInline(block.text, key)}
        </blockquote>
      );

    case 'rule':
      return <hr key={key} className="fw-chat-md__rule" />;

    case 'table':
      return (
        <div key={key} className="fw-chat-md__tablewrap" tabIndex={0} role="group" aria-label="Table">
          <table className="fw-chat-md__table">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={`${key}-h${index}`} scope="col" data-align={block.align[index] ?? 'left'}>
                    {renderInline(cell, `${key}-h${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-r${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${key}-r${rowIndex}c${cellIndex}`}
                      data-align={block.align[cellIndex] ?? 'left'}
                    >
                      {renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    default:
      return null;
  }
}

/**
 * Turn a Markdown string into React elements.
 *
 * The caret option appends the streaming cursor. It joins the last paragraph
 * where there is one, so it sits at the end of the sentence rather than on a
 * line of its own.
 */
export function renderMarkdown(source: string, options: MarkdownOptions = {}): ReactNode {
  const blocks = parseBlocks(source);
  const prefix = options.idPrefix ?? 'md';
  const lastIndex = blocks.length - 1;
  const lastIsParagraph = lastIndex >= 0 && blocks[lastIndex].kind === 'paragraph';
  const caretInline = options.caret === true && lastIsParagraph;

  const nodes = blocks.map((block, index) =>
    renderBlock(block, `${prefix}-b${index}`, options, caretInline && index === lastIndex),
  );

  if (options.caret === true && !caretInline) {
    nodes.push(streamCaret(`${prefix}-caret`));
  }

  return <>{nodes}</>;
}
