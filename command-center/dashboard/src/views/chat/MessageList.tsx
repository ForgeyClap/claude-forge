/**
 * MessageList — the scrolling thread.
 *
 * Owns three things the view above it should not have to think about:
 *
 *   scrolling   it sticks to the bottom while a reply is revealing, and lets go
 *               the moment the reader scrolls up. A "latest" button appears in
 *               that state instead of yanking the page back down.
 *   keyboard    every turn is focusable, and Up / Down / Home / End move
 *               between turns once one of them has focus.
 *   announcing  the list is a polite log limited to additions, so a screen
 *               reader hears a new turn arrive without hearing the streaming
 *               text re-read on every tick. A separate status line says when
 *               the reply starts and when it is finished.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, UIEvent } from 'react';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import { usePrototype } from '@/prototype/state/prototype-store';
import { Button, ExampleTag, Eyebrow } from '@/components/primitives';
import { isProductionMode } from '@/config/mode';
import type { ChatSendOutcome } from '@/prototype/state/chat-send';
import { readChatMessageRequestedModel } from '@/prototype/state/gateway-chat';
import { Message } from './Message';

export interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  /** Id of the message currently being revealed, or null when nothing streams. */
  readonly streamingId: string | null;
  /** Used as the accessible name of the log. */
  readonly conversationTitle: string;
  /**
   * Given a message's index in `messages`, returns the real regenerate action for
   * that turn, or null when there is none (a fixture reply, or no preceding user
   * turn to re-send). Omitted entirely on the fixture path.
   */
  readonly regenerateFor?: (index: number) => (() => Promise<ChatSendOutcome>) | null;
}

/** How close to the end still counts as "at the bottom", in pixels. */
const BOTTOM_SLACK = 48;

const STREAM_START = 'Forge is responding.';
const STREAM_END = 'Forge response complete.';

export function MessageList({
  messages,
  streamingId,
  conversationTitle,
  regenerateFor,
}: MessageListProps) {
  const { state } = usePrototype();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);

  // Derived, not stored: the status line is a pure function of the simulator's
  // state, so there is no effect writing state back into React.
  const { stream } = state;
  const announcement = stream === null ? '' : stream.done ? STREAM_END : STREAM_START;

  // Follow the tail while the reader has not moved away from it. `messages` is a
  // fresh array on every reveal tick, so this runs as the reply grows.
  useEffect(() => {
    if (!stuckToBottom) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, stuckToBottom]);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setStuckToBottom(distance <= BOTTOM_SLACK);
  }, []);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: state.reducedMotion ? 'auto' : 'smooth',
    });
    setStuckToBottom(true);
  }, [state.reducedMotion]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLOListElement>) => {
    const { key } = event;
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;

    const target = event.target as HTMLElement;
    // Only steer when a turn itself has focus — never while typing in a control.
    if (!target.hasAttribute('data-chat-message')) return;

    const turns = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[data-chat-message]'),
    );
    if (turns.length === 0) return;

    const current = turns.indexOf(target);
    let next = current;
    if (key === 'ArrowDown') next = Math.min(turns.length - 1, current + 1);
    else if (key === 'ArrowUp') next = Math.max(0, current - 1);
    else if (key === 'Home') next = 0;
    else next = turns.length - 1;

    if (next !== current && next >= 0) {
      event.preventDefault();
      turns[next].focus();
    }
  }, []);

  return (
    <div className="fw-chat-thread">
      <div className="fw-chat-thread__scroll" ref={scrollRef} onScroll={handleScroll}>
        <ol
          className="fw-chat-thread__list"
          role="log"
          aria-label={`Conversation: ${conversationTitle}`}
          aria-live="polite"
          aria-relevant="additions"
          onKeyDown={handleKeyDown}
        >
          <li className="fw-chat-thread__start">
            <Eyebrow>Thread start</Eyebrow>
            {isProductionMode() ? (
              <span className="fw-chat-thread__start-text">
                Live conversation through your local Claude Code session.
              </span>
            ) : (
              <>
                <span className="fw-chat-thread__start-text">
                  Example conversation. Nothing here was generated and no session was contacted.
                </span>
                <ExampleTag />
              </>
            )}
          </li>

          {messages.map((message, index) => {
            // feat-model-picker: the model the PRECEDING user turn requested, only ever computed
            // for a real assistant reply immediately following a real user turn — mirrors
            // `ChatView.tsx`'s own `resolveRegenerate`'s "previous message must be author:'user'"
            // check, done here instead since `Message.tsx` only ever sees its own single turn.
            const previous = index > 0 ? messages[index - 1] : null;
            const requestedModel =
              message.author !== 'user' && previous !== null && previous.author === 'user'
                ? readChatMessageRequestedModel(previous)
                : null;
            return (
              <li key={message.id} className="fw-chat-thread__item">
                <Message
                  message={message}
                  streaming={message.id === streamingId}
                  position={index + 1}
                  total={messages.length}
                  regenerate={regenerateFor ? regenerateFor(index) : null}
                  requestedModel={requestedModel}
                />
              </li>
            );
          })}
        </ol>
      </div>

      {stuckToBottom ? null : (
        <Button
          className="fw-chat-thread__jump"
          size="sm"
          icon="ArrowDown"
          onClick={jumpToLatest}
        >
          Latest
        </Button>
      )}

      <p className="fw-visually-hidden" role="status">
        {announcement}
      </p>
    </div>
  );
}
