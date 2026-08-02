/**
 * Inspector — shared building blocks.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — carries the per-selection-kind label
 * maps (`KIND_LABEL`, `VERDICT_STATUS`, `CHANGE_LABEL`), the small presentational atoms every
 * panel builder reuses (`Fields`, `Section`, `Chips`, `Prose`, `Excerpt`, `Console`, `LinkRow`,
 * `Diff`), the `findFile` tree lookup, and the `Detail`/`SelectFn` shapes every panel builder
 * returns/takes. See `Inspector.tsx`'s own header for why this file exists and what moved where.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, Machine } from '@/components/primitives';
import type { Selection } from '@/prototype/state/prototype-store';
import type { FileNode, StatusKey } from '@/prototype/types/prototype-types';

/* ------------------------------------------------------------------ labels */

export const KIND_LABEL: Readonly<Record<Selection['kind'], string>> = {
  none: 'INSPECTOR',
  project: 'PROJECT',
  conversation: 'CONVERSATION',
  agent: 'AGENT',
  task: 'TASK',
  'graph-node': 'GRAPH NODE',
  artifact: 'ARTIFACT',
  gate: 'QUALITY GATE',
  proof: 'PROOF LINE',
  file: 'FILE',
  event: 'EVENT',
};

/** Proof verdicts are not workspace statuses; this is presentation only. */
export const VERDICT_STATUS: Readonly<Record<'accepted' | 'rejected' | 'pending', StatusKey>> = {
  accepted: 'completed',
  rejected: 'failed',
  pending: 'verify',
};

export const CHANGE_LABEL: Readonly<Record<'added' | 'modified' | 'deleted', string>> = {
  added: 'ADDED',
  modified: 'MODIFIED',
  deleted: 'DELETED',
};

/* ------------------------------------------------------------ small pieces */

export interface FieldRow {
  readonly label: string;
  readonly value: ReactNode;
}

export function Fields({ rows }: { rows: readonly FieldRow[] }) {
  return (
    <dl className="fw-inspector__fields">
      {rows.map((row) => (
        <div className="fw-inspector__field" key={row.label}>
          <dt className="fw-inspector__field-label">{row.label}</dt>
          <dd className="fw-inspector__field-value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="fw-inspector__section"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="fw-inspector__summary">
        <Icon name="ChevronRight" size="sm" className="fw-inspector__chevron" />
        <span className="fw-inspector__summary-title">{title}</span>
        {count != null ? <span className="fw-inspector__summary-count fg-machine">{count}</span> : null}
      </summary>
      <div className="fw-inspector__section-body">{children}</div>
    </details>
  );
}

export function Chips({ items, label }: { items: readonly string[]; label: string }) {
  if (items.length === 0) return <p className="fw-inspector__none">None recorded.</p>;
  return (
    <ul className="fw-inspector__chips" aria-label={label}>
      {items.map((item) => (
        <li key={item} className="fw-inspector__chip fg-machine">
          {item}
        </li>
      ))}
    </ul>
  );
}

export function Prose({ children }: { children: ReactNode }) {
  return <p className="fw-inspector__prose">{children}</p>;
}

export function Excerpt({ text }: { text: string }) {
  return <div className="fw-inspector__excerpt fw-scroll">{text}</div>;
}

export function Console({ text }: { text: string }) {
  return (
    <pre className="fw-inspector__console fg-machine fw-scroll" tabIndex={0}>
      {text}
    </pre>
  );
}

export function LinkRow({ icon, id, onSelect }: { icon: string; id: string; onSelect: () => void }) {
  return (
    <button type="button" className="fw-inspector__link" onClick={onSelect}>
      <Icon name={icon} size="xs" className="fw-inspector__link-icon" />
      <Machine className="fw-truncate">{id}</Machine>
      <Icon name="ChevronRight" size="xs" className="fw-inspector__link-chevron" />
    </button>
  );
}

/**
 * feat-chatrun-diff: `label` is the ONLY addition to this component, and it changes nothing
 * visually — it defaults to the exact string this component has always used, so the prototype file
 * panel that renders hand-written example diffs is untouched. It exists because the same component
 * now also renders REAL, gateway-recorded file changes, and announcing those to a screen reader as
 * an "Example" would be the one thing this product never does: describe real evidence as a sample.
 */
export function Diff({ text, label = 'Example unified diff' }: { text: string; label?: string }) {
  const lines = text.split('\n');
  return (
    <div className="fw-inspector__diff fw-scroll" tabIndex={0} role="group" aria-label={label}>
      {lines.map((line, index) => {
        const kind =
          line.startsWith('+++') || line.startsWith('---')
            ? 'meta'
            : line.startsWith('@@')
              ? 'hunk'
              : line.startsWith('+')
                ? 'add'
                : line.startsWith('-')
                  ? 'del'
                  : 'ctx';
        return (
          <div key={`${index}-${line}`} className="fw-inspector__diff-line" data-line={kind}>
            <span className="fg-machine">{line === '' ? ' ' : line}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ lookup */

export function findFile(nodes: readonly FileNode[], id: string): FileNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const hit = findFile(node.children, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ detail */

export interface Detail {
  readonly eyebrow: string;
  readonly title: string;
  /** fix-ui-clutter (item 3): a raw id, or any other detail too noisy to show as visible text,
   *  surfaced ONLY as a hover tooltip on the title — never printed in the DOM. */
  readonly titleTooltip?: string;
  readonly status?: StatusKey;
  readonly subtitle?: ReactNode;
  readonly body: ReactNode;
}

export type SelectFn = (selection: Selection) => void;
