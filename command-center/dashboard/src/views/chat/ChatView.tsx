/**
 * ChatView — the chat workspace.
 *
 * Layout, top to bottom: the project breadcrumb and the conversation title, the
 * thread in a reading-width column, and the composer pinned to the bottom at
 * composer width. The view renders its own content area only — the sidebar,
 * topbar, inspector and dock belong to the shell.
 *
 * TWO SEND PATHS, chosen by whether the production chat controller is mounted:
 *
 *   PRODUCTION (`useChatSend()` is non-null) — Send drives a REAL Claude Code run
 *       through the bridge (`sendMessage`, creating the conversation first when
 *       there is none), Stop cancels the real run, and the run status shown comes
 *       from the live store. No local reply is ever appended: the assistant text
 *       arrives as real streamed events and renders through the adapter. A refused
 *       send surfaces the real reason and keeps the draft.
 *
 *   FIXTURES (`useChatSend()` is null) — the original local reveal, untouched:
 *       `chat/send` appends the user message and a canned reply the provider
 *       reveals on a timer, and Stop halts that reveal. This is the path the theme
 *       showcase and the unit tests exercise.
 *
 * PROJECT-MISMATCH DISCLOSURE (fix-chat-mismatch, forge-2026-07-29-cc-finish): in
 * production, a conversation stays reachable (via the sidebar/breadcrumb) after
 * the active project switches to something else — the sidebar switch clears
 * neither the selection nor the conversation history. Sending in that state is
 * ALREADY safe (`gateway-chat.ts`'s cross-project guard, fix-crossproject,
 * treats a project-mismatched conversation as unknown and starts a brand-new
 * one in the active project instead of posting into this one) — but nothing on
 * screen said so before this fix, which read as a silent contradiction between
 * the topbar's active project and this view's own breadcrumb/composer copy. The
 * extra subtitle line below states the real outcome plainly whenever that
 * mismatch is showing, naming both real projects from `state` — never a new
 * component, never a guess.
 */

import './chat.css';

import { useCallback, useState } from 'react';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import {
  nextToastId,
  selectConversation,
  selectMessages,
  selectProject,
  usePrototype,
} from '@/prototype/state/prototype-store';
import { useChatSend } from '@/prototype/state/chat-send';
import type { ChatSendEffort, ChatSendMode, ChatSendModel, ChatSendOutcome } from '@/prototype/state/chat-send';
import { requestNewConversation } from '@/components/shell/gateway-actions';
import { readChatMessageIsLive } from '@/prototype/state/gateway-chat';
import { useGatewayAskQuestions } from '@/prototype/state/gateway-chat/ask-questions';
import { ConfirmDeleteConversationDialog } from '@/components/shell/ConfirmDeleteConversationDialog';
import { AskQuestionsDialog } from './AskQuestionsDialog';
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Machine,
  Spacer,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { UsageBar } from '@/components/usage/UsageBar';
import { ClaudeCodeChip } from './ClaudeCodeChip';
import { Composer } from './Composer';
import type { ComposerSendResult } from './Composer';
import { MessageList } from './MessageList';

const NO_MESSAGES: readonly ChatMessage[] = [];

export default function ChatView() {
  const { state, dispatch } = usePrototype();
  // Non-null only on the connected production path; null in fixtures/tests, which
  // is the signal to keep the local reveal below.
  const chat = useChatSend();
  const production = chat !== null;
  // feat-delete-conversation: the header's real "Delete conversation" confirm dialog.
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const conversation = selectConversation(state, state.activeConversationId);
  const conversationId = conversation?.id ?? '';
  // feat-ask-owner: the real "Forge is asking" question box, watched only for a genuine production
  // conversation — fixtures/no-active-conversation pass '' so the hook's own internal guard never
  // polls a real gateway route for a non-real id.
  const ask = useGatewayAskQuestions(production ? conversationId : '');
  const project = conversation
    ? selectProject(state, conversation.projectId)
    : selectProject(state, state.activeProjectId);
  const messages = conversation ? selectMessages(state, conversation.id) : NO_MESSAGES;

  // fix-chat-mismatch (forge-2026-07-29-cc-finish): true only when THIS
  // conversation's own project tag differs from the ACTIVE project shown in
  // the topbar/sidebar. This is exactly the condition
  // `useGatewayChatSendController` (`gateway-chat.ts`, its own header rule 4 /
  // `knownConversation`) treats as "unknown": a real Send here never posts
  // into this conversation — it creates a BRAND-NEW conversation in the
  // active project and activates that one instead. Gated to `production`
  // (real `chat` mounted): the fixture reveal has no per-project send guard
  // at all, so the note would misdescribe what a fixture Send actually does.
  const projectMismatch =
    production &&
    conversation !== undefined &&
    conversation.projectId !== '' &&
    state.activeProjectId !== '' &&
    conversation.projectId !== state.activeProjectId;
  const activeProject = projectMismatch ? selectProject(state, state.activeProjectId) : undefined;

  const { stream } = state;
  const streamingId =
    stream !== null && !stream.done && stream.conversationId === conversationId
      ? stream.messageId
      : null;

  // In production the composer's Stop/Send toggle reflects a REAL active run; in
  // fixtures it reflects the local reveal.
  const streaming = production && chat !== null ? chat.run.active : streamingId !== null;

  const toast = useCallback(
    (title: string, detail?: string, icon?: string) => {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });
    },
    [dispatch],
  );

  const handleSend = useCallback(
    // composer-modes-ui: `effort` forwards straight through to `chat.send`, mirroring how `mode`
    // already does — this view is unaware of either choice's meaning, it just relays what the
    // Composer decided. feat-model-picker: `model` forwards the same way, one parameter over.
    (body: string, mode?: ChatSendMode, effort?: ChatSendEffort, model?: ChatSendModel): boolean | Promise<ComposerSendResult> => {
      if (production && chat !== null) {
        // Drive a real run. The message is never echoed locally — the streamed
        // events render the reply. A refusal keeps the draft and says why.
        // feat-composer-power: the FULL outcome (not just `.ok`) is returned — the composer's
        // message queue needs the real refusal reason on a failed flush attempt.
        return chat.send(body, mode, effort, model).then((outcome) => {
          if (!outcome.ok && outcome.error !== null) {
            toast('Message not sent', outcome.error, 'TriangleAlert');
          }
          return outcome;
        });
      }
      if (conversationId === '') return false;
      dispatch({ type: 'chat/send', conversationId, body });
      return true;
    },
    [production, chat, conversationId, dispatch, toast],
  );

  // fix-ui-clutter (item 4): drives the SAME real `POST /api/conversations` flow the sidebar's
  // "New chat" button already uses (`requestNewConversation`, `gateway-actions.ts`) instead of
  // merely clearing the active conversation and leaving an empty composer behind with nothing
  // new created — no page reload, no local-only reset standing in for a real action.
  const handleNewChat = useCallback(async () => {
    const result = await requestNewConversation(state.activeProjectId);
    if (!result.ok || result.id === null) {
      toast('New chat failed', result.error ?? 'The gateway could not start a new chat.', 'TriangleAlert');
      return;
    }
    dispatch({ type: 'conversation/activate', id: result.id });
  }, [state.activeProjectId, dispatch, toast]);

  // feat-composer-power: the SAME real-vs-fixture branch the toolbar's own "New"/"Delete" buttons
  // already used inline — extracted so the composer's `/new`/`/delete` slash commands (see
  // `slash-commands.ts`) drive the exact same real actions, not a second parallel implementation.
  const handleNewChatClick = useCallback(() => {
    if (production) {
      void handleNewChat();
      return;
    }
    toast('New conversation', 'Starting a thread is a placeholder here. The example set is fixed.', 'Plus');
  }, [production, handleNewChat, toast]);

  const handleDeleteClick = useCallback(() => {
    if (production) {
      setDeleteDialogOpen(true);
      return;
    }
    toast('Delete conversation', 'Deleting is a placeholder here. The example set is fixed.', 'Trash2');
  }, [production, toast]);

  // Regenerate re-POSTs the preceding user turn through the SAME send path Send
  // already uses — no second fetch layer. Only offered on a real assistant
  // message with a real preceding user turn to re-send; every other case (a
  // fixture reply, or a message with nothing before it) returns null and the
  // caller shows the honest "nothing to regenerate" fallback.
  const resolveRegenerate = useCallback(
    (index: number): (() => Promise<ChatSendOutcome>) | null => {
      if (!production || chat === null) return null;
      // feat-live-stream: the one synthetic still-running placeholder (`gateway-chat.ts`'s
      // `buildLiveActivityMessage`) has nothing finished to regenerate — it renders live tool
      // activity for a turn that has not produced a real reply yet.
      const current = messages[index];
      if (current && readChatMessageIsLive(current)) return null;
      const previous = messages[index - 1];
      if (!previous || previous.author !== 'user') return null;
      return () => chat.send(previous.body);
    },
    [production, chat, messages],
  );

  const handleStop = useCallback(() => {
    if (production && chat !== null) {
      void chat.stop().then((outcome) => {
        if (!outcome.ok && outcome.error !== null) {
          toast('Stop failed', outcome.error, 'TriangleAlert');
        }
      });
      return;
    }
    dispatch({ type: 'chat/stream-stop' });
    toast('Reveal stopped', 'The local example reply stopped mid-sentence. Nothing was cancelled elsewhere.', 'Square');
  }, [production, chat, dispatch, toast]);

  if (!conversation) {
    // PRODUCTION: with a project resolvable, still show the composer so a first
    // message can start a conversation (created on send). With no project, show an
    // honest disabled state rather than a composer that would drop the message.
    if (production && chat !== null) {
      if (chat.disabledReason === null) {
        return (
          <section className="fw-chat" aria-label="Chat">
            <header className="fw-chat__head">
              <div className="fw-chat__head-inner">
                <nav className="fw-chat__crumbs" aria-label="Breadcrumb">
                  <button
                    type="button"
                    className="fw-chat__crumb"
                    onClick={() =>
                      project
                        ? dispatch({ type: 'select', selection: { kind: 'project', id: project.id } })
                        : undefined
                    }
                  >
                    <Icon name="FolderGit2" size="xs" />
                    <span>{project?.name ?? 'Active project'}</span>
                  </button>
                  <Icon name="ChevronRight" size="xs" className="fw-chat__crumb-sep" />
                  <span className="fw-chat__crumb is-current" aria-current="page">
                    New conversation
                  </span>
                </nav>
                <div className="fw-chat__titlerow">
                  <h1 className="fw-chat__title">New conversation</h1>
                </div>
                <p className="fw-chat__subtitle">
                  <span>Your first message starts a new conversation in this project.</span>
                </p>
              </div>
            </header>

            <UsageBar />

            <div className="fw-chat__body">
              <MessageList
                messages={NO_MESSAGES}
                streamingId={null}
                conversationTitle="New conversation"
              />
            </div>

            <div className="fw-chat__dock">
              <Composer
                onSend={handleSend}
                onStop={handleStop}
                streaming={false}
                conversationTitle="New conversation"
                production
              />
            </div>
          </section>
        );
      }

      return (
        <section className="fw-chat" aria-label="Chat">
          <UsageBar />
          <EmptyState
            icon="MessagesSquare"
            title="No project selected"
            detail={chat.disabledReason}
          />
        </section>
      );
    }

    // FIXTURES: the original empty state, unchanged.
    return (
      <section className="fw-chat" aria-label="Chat">
        <UsageBar />
        <EmptyState
          icon="MessagesSquare"
          title="No conversation selected"
          detail="Pick a thread in the sidebar to read it here. Every conversation in this prototype is local example data."
        />
      </section>
    );
  }

  return (
    <section className="fw-chat" aria-label="Chat">
      <header className="fw-chat__head">
        <div className="fw-chat__head-inner">
          <nav className="fw-chat__crumbs" aria-label="Breadcrumb">
            <button
              type="button"
              className="fw-chat__crumb"
              onClick={() =>
                project
                  ? dispatch({ type: 'select', selection: { kind: 'project', id: project.id } })
                  : undefined
              }
            >
              <Icon name="FolderGit2" size="xs" />
              <span>{project?.name ?? 'Unknown project'}</span>
            </button>
            <Icon name="ChevronRight" size="xs" className="fw-chat__crumb-sep" />
            <span className="fw-chat__crumb is-current" aria-current="page">
              Conversation
            </span>
          </nav>

          <div className="fw-chat__titlerow">
            {/* fix-ui-clutter (item 3): the raw id is a hover tooltip only — the visible text is
                always the title (real, or the honest "New chat — <project>" fallback). */}
            <h1 className="fw-chat__title" title={conversation.id}>
              {conversation.title}
            </h1>
            <Toolbar label="Conversation actions" className="fw-chat__toolbar">
              <Spacer />
              <ToolbarGroup>
                <ClaudeCodeChip />
              </ToolbarGroup>
              <ToolbarGroup divided>
                <IconButton
                  icon="PanelRight"
                  label="Conversation details"
                  size="sm"
                  onClick={() =>
                    dispatch({
                      type: 'select',
                      selection: { kind: 'conversation', id: conversation.id },
                    })
                  }
                />
                <Button variant="quiet" size="sm" icon="Plus" onClick={handleNewChatClick}>
                  New
                </Button>
              </ToolbarGroup>
              <ToolbarGroup divided>
                <IconButton
                  icon="Trash2"
                  label="Delete conversation"
                  size="sm"
                  onClick={handleDeleteClick}
                />
              </ToolbarGroup>
            </Toolbar>
          </div>

          <p className="fw-chat__subtitle">
            <Machine muted>{messages.length}</Machine>
            <span> messages · updated </span>
            <Machine muted>{conversation.updatedAt}</Machine>
            {production && chat !== null ? (
              chat.run.status !== null ? (
                <>
                  <span> · run </span>
                  <Machine muted>{chat.run.status}</Machine>
                </>
              ) : null
            ) : (
              <span> · example thread, not a live session</span>
            )}
          </p>

          {/*
            a11y-new: this one gets `role="status"` where Activity's truncation notices deliberately
            do not. The difference is what the reader is about to DO. Activity's notices describe a
            log that is sitting still; announcing them would interrupt for no decision. This line
            appears the moment the active project changes under an open conversation, and it changes
            where the very next Send lands. A sighted user sees it arrive; without a live region a
            screen-reader user already in the composer would not — and would send into a project
            they never chose. Announcing it is the whole point of having written it.
            `polite` (not `assertive`): it is important, not an emergency.
          */}
          {projectMismatch ? (
            <p className="fw-chat__subtitle" role="status" aria-live="polite">
              <span>This conversation belongs to </span>
              <Machine muted>{project?.name ?? 'Unknown project'}</Machine>
              <span> — sending here starts a new conversation in </span>
              <Machine muted>{activeProject?.name ?? 'Unknown project'}</Machine>
              <span> instead of continuing this one.</span>
            </p>
          ) : null}
        </div>
      </header>

      <UsageBar />

      <div className="fw-chat__body">
        <MessageList
          messages={messages}
          streamingId={streamingId}
          conversationTitle={conversation.title}
          regenerateFor={resolveRegenerate}
        />
      </div>

      <div className="fw-chat__dock">
        <Composer
          onSend={handleSend}
          onStop={handleStop}
          streaming={streaming}
          conversationTitle={conversation.title}
          production={production}
          onNewChat={handleNewChatClick}
          onRequestDelete={handleDeleteClick}
        />
      </div>

      <ConfirmDeleteConversationDialog
        open={deleteDialogOpen}
        conversationId={conversation.id}
        conversationTitle={conversation.title}
        onClose={() => setDeleteDialogOpen(false)}
        onDeleted={() => setDeleteDialogOpen(false)}
      />

      <AskQuestionsDialog
        pending={ask.pending}
        submitting={ask.submitting}
        onSubmit={ask.submit}
        abandoned={ask.abandoned}
        onDismissAbandoned={ask.dismissAbandoned}
      />
    </section>
  );
}
