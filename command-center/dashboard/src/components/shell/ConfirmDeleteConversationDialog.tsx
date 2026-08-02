/**
 * ConfirmDeleteConversationDialog — the real "Delete conversation" confirm step.
 *
 * Shared by Sidebar's "Recent conversations" row and ChatView's conversation header — both real
 * entry points drive the SAME `DELETE /api/conversations/:id` route (`requestDeleteConversation`,
 * gateway-actions.ts) through this ONE dialog, so the confirm wording, the failure toast, and the
 * "detach if this was the active conversation" behaviour can never drift between the two call
 * sites. Mirrors `NewProjectDialog`'s own shape: the existing `Modal` + `Button` primitives, no new
 * style language, and the component owns its own submit lifecycle.
 *
 * `onDeleted` is called ONLY after a real, confirmed 200 from the gateway — never speculatively —
 * so a caller that hides the row locally (Sidebar's own optimistic list) never hides one that is
 * still real server-side.
 */

import { useState } from 'react';
import { Button, Modal } from '@/components/primitives';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import { requestDeleteConversation } from './gateway-actions';

export interface ConfirmDeleteConversationDialogProps {
  readonly open: boolean;
  /** Empty string is safe — the dialog stays closed (`open:false`) whenever there is no real
   *  target, so this is never sent to the gateway. */
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly onClose: () => void;
  /** Called once, only after the real delete succeeds — never on failure or cancel. */
  readonly onDeleted: (id: string) => void;
}

export function ConfirmDeleteConversationDialog({
  open,
  conversationId,
  conversationTitle,
  onClose,
  onDeleted,
}: ConfirmDeleteConversationDialogProps) {
  const { state, dispatch } = usePrototype();
  const [deleting, setDeleting] = useState(false);

  function handleClose() {
    if (deleting) return; // a request in flight must not be abandoned mid-air
    onClose();
  }

  async function handleConfirm(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    const result = await requestDeleteConversation(conversationId);
    setDeleting(false);
    if (!result.ok) {
      dispatch({
        type: 'toast/push',
        toast: {
          id: nextToastId(),
          title: 'Delete failed',
          detail: result.error ?? 'The gateway could not delete this conversation.',
          icon: 'TriangleAlert',
        },
      });
      return;
    }
    // No dead reference: if this was the active conversation, detach to the empty/new-conversation
    // state (ChatView's own `!conversation` branch already renders that honestly).
    if (state.activeConversationId === conversationId) {
      dispatch({ type: 'conversation/activate', id: '' });
    }
    onDeleted(conversationId);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="sm"
      title="Delete conversation"
      description={`Permanently deletes "${conversationTitle}". This cannot be undone.`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={() => void handleConfirm()} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </>
      }
    />
  );
}
