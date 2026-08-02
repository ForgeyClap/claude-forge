/**
 * NewProjectDialog — the real "New project" flow.
 *
 * Reuses the existing `Modal` + `Field` primitives and the sidebar's own
 * search-field input styling (no new CSS anywhere) to ask for exactly one
 * thing: a project name. On submit it POSTs through `requestNewProject`
 * (gateway-actions.ts) — the same transport shape `requestNewConversation`
 * already uses for "New chat". Success closes the dialog and hands the
 * created project's id back to the caller (`Sidebar` activates it and
 * navigates to `/project`); failure keeps the dialog open and shows the
 * gateway's own real error text — never a silent no-op.
 *
 * build-lastdemos: `HomeView`'s six "Start something" template cards reuse this
 * SAME dialog (never a duplicate) via the optional `initialName` prop below —
 * a template only ever seeds the name field with a real, editable suggestion.
 * It creates the exact same empty, marker-only project directory
 * `projects-create.mjs` always creates; no template-specific content or
 * scaffolding is added, and the dialog's own description says so.
 *
 * build-async-install: `onCreated` now only receives the created project's `id` — the gateway no
 * longer knows the real Forge-install outcome at scaffold time (it runs fully detached; see
 * `gateway-actions.ts`'s header). `Sidebar` is the one that polls for the real outcome afterwards.
 */

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Field, Modal } from '@/components/primitives';
import { requestNewProject } from './gateway-actions';

export interface NewProjectDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Called once creation succeeds, with the created project's id (its folder name). The real
   *  Forge-install outcome is not known yet at this point — see this file's header. */
  readonly onCreated: (id: string) => void;
  /**
   * Pre-fills the name field the moment the dialog opens (e.g. a template's
   * name from `HomeView`). Purely a starting suggestion — the user can still
   * edit or clear it before submitting, and it changes nothing about what
   * gets created.
   */
  readonly initialName?: string;
}

export function NewProjectDialog({ open, onClose, onCreated, initialName }: NewProjectDialogProps) {
  const [name, setName] = useState(initialName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputId = useId();
  const formId = useId();

  // "Adjust state when a prop changes" (React's own documented pattern, already used by this
  // codebase in Composer.tsx's skillsProjectId): every prior close path (Cancel/Escape/scrim via
  // handleClose, or a successful submit) already resets `name` to '' before this component can
  // next receive `open:true` again, so seeding it here on the false->true transition never
  // clobbers text the user is actively typing.
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setName(initialName ?? '');
  }

  function handleClose() {
    if (submitting) return; // a request in flight must not be abandoned mid-air
    setName('');
    setError(null);
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await requestNewProject(name);
    setSubmitting(false);
    if (!result.ok || result.id === null) {
      setError(result.error ?? 'The gateway could not create the project.');
      return;
    }
    setName('');
    onCreated(result.id);
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="sm"
      title="New project"
      description={
        initialName
          ? `Creates a real project folder — the name below is only a suggestion from the "${initialName}" template; no template content or scaffolding is added. Forge picks the project up on its own next scan.`
          : 'Creates a real project folder — Forge picks it up on its own next scan.'
      }
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={formId}
            disabled={submitting || name.trim() === ''}
          >
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void handleSubmit(event)}>
        <Field
          label="Project name"
          htmlFor={inputId}
          hint="Letters, numbers, spaces, - and _ only, up to 64 characters."
        >
          <span className="fw-sidebar__search-field">
            <input
              id={inputId}
              className="fw-sidebar__search-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={submitting}
            />
          </span>
        </Field>
        {error ? (
          <p className="fw-field__hint" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
