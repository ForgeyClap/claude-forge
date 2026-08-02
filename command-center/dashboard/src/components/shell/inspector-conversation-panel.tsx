/**
 * Inspector — the conversation panel.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'conversation'`, unchanged (comments included verbatim). See that
 * file's own header for the full refactor rationale.
 */

import { Machine } from '@/components/primitives';
import { selectConversation, selectProject } from '@/prototype/state/prototype-store';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Chips, Excerpt, Fields, KIND_LABEL, Section } from './inspector-shared';
import type { Detail } from './inspector-shared';

export function buildConversationDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'conversation' }>,
  production: boolean,
): Detail | null {
  const conversation = selectConversation(state, selection.id);
  if (!conversation) return null;
  const project = selectProject(state, conversation.projectId);
  const messages = conversation.messages;
  const last = messages[messages.length - 1];
  const models = Array.from(
    new Set(messages.map((message) => message.model).filter((model): model is string => Boolean(model))),
  );
  return {
    eyebrow: KIND_LABEL.conversation,
    title: conversation.title,
    // fix-ui-clutter (item 3): the raw conversation id (`c-ms6e73oh-…`) used to render as
    // visible subtitle text next to a title that could ALSO be that same raw id (see
    // `gateway-chat.ts`'s title-fallback fix) — now the id is a hover tooltip only.
    titleTooltip: conversation.id,
    body: (
      <>
        <Fields
          rows={[
            { label: 'Project', value: project ? project.name : <Machine>{conversation.projectId}</Machine> },
            { label: 'Messages', value: <Machine>{conversation.messageCount}</Machine> },
            { label: 'Updated', value: <Machine muted>{conversation.updatedAt}</Machine> },
          ]}
        />
        {last ? (
          <Section title="Last message" defaultOpen count={last.author === 'user' ? 'you' : 'forge'}>
            <div className="fw-inspector__meta">
              <Machine muted>{last.author === 'user' ? 'you' : 'forge'}</Machine>
              <span className="fw-inspector__dot" aria-hidden="true" />
              <Machine muted>{last.timestamp}</Machine>
            </div>
            <Excerpt text={last.body} />
          </Section>
        ) : null}
        {models.length > 0 ? (
          <Section title="Model labels" count={models.length}>
            <Chips items={models} label="Model labels used in this thread" />
            <p className="fw-inspector__hint">
              {production
                ? 'Display labels carried on these messages. No model was contacted from this panel.'
                : 'Display labels written into the example data. No model was contacted.'}
            </p>
          </Section>
        ) : null}
        <Section title="Thread" count={messages.length}>
          <div className="fw-inspector__links">
            {messages.slice(-6).map((message) => (
              <div key={message.id} className="fw-inspector__row">
                <Machine muted>{message.timestamp}</Machine>
                <span className="fw-truncate fw-inspector__row-text">
                  {message.body.replace(/[#*`>|-]/g, ' ').trim().slice(0, 64) || '—'}
                </span>
              </div>
            ))}
          </div>
        </Section>
      </>
    ),
  };
}
