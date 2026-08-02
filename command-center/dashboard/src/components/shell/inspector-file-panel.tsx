/**
 * Inspector — the file panel.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'file'`, unchanged (comments included verbatim). See that file's
 * own header for the full refactor rationale.
 */

import { ExampleTag, Icon, Machine } from '@/components/primitives';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { CHANGE_LABEL, Diff, Fields, KIND_LABEL, Section, findFile } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildFileDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'file' }>,
  select: SelectFn,
  production: boolean,
): Detail | null {
  const { data } = state;
  const file = findFile(data.files, selection.id);
  if (!file) return null;
  const children = file.children ?? [];
  return {
    eyebrow: KIND_LABEL.file,
    title: file.name,
    subtitle: <Machine muted>{file.path}</Machine>,
    body: (
      <>
        <Fields
          rows={[
            { label: 'Kind', value: <Machine>{file.kind}</Machine> },
            {
              label: 'Change',
              value: file.changed ? (
                <span className="fw-inspector__change" data-change={file.changed}>
                  <Machine>{CHANGE_LABEL[file.changed]}</Machine>
                </span>
              ) : production ? (
                // The real gateway has no git-diff concept (see
                // gateway-files.ts's header) — "unchanged" would claim a
                // check that never ran. Honest absence instead.
                <Machine muted>not tracked</Machine>
              ) : (
                <Machine muted>unchanged</Machine>
              ),
            },
            { label: 'Size', value: <Machine muted>{file.size ?? '—'}</Machine> },
            { label: 'Updated', value: <Machine muted>{file.updatedAt ?? '—'}</Machine> },
          ]}
        />
        {file.diff ? (
          <Section title="Example change" defaultOpen count={<ExampleTag />}>
            <Diff text={file.diff} />
            <p className="fw-inspector__hint">
              Hand-written diff text. Nothing was read from disk — the prototype has no
              filesystem access.
            </p>
          </Section>
        ) : null}
        {children.length > 0 ? (
          <Section title="Contents" count={children.length}>
            <div className="fw-inspector__links">
              {children.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  className="fw-inspector__link"
                  onClick={() => select({ kind: 'file', id: child.id })}
                >
                  <Icon
                    name={child.kind === 'dir' ? 'Folder' : 'File'}
                    size="xs"
                    className="fw-inspector__link-icon"
                  />
                  <Machine className="fw-truncate">{child.name}</Machine>
                  <Icon name="ChevronRight" size="xs" className="fw-inspector__link-chevron" />
                </button>
              ))}
            </div>
          </Section>
        ) : null}
      </>
    ),
  };
}
