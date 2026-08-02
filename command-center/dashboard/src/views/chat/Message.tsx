/**
 * Message — one turn in the thread.
 *
 * User and Forge turns are told apart without a single coloured bubble:
 *   alignment    the user sits right and narrow, Forge runs the full column
 *   surface      the user gets a raised card, Forge sits on the canvas itself
 *   border       a hairline box against a single leading rule
 *   label        an explicit author eyebrow above each turn
 *
 * Copy writes to the clipboard of this tab and nothing else. Regenerate re-sends
 * the preceding user turn through the real send path when `regenerate` is
 * provided (a real assistant reply with a real preceding user turn); otherwise
 * it raises an honest "nothing to regenerate" toast. Edit and the feedback
 * thumbs recorded nothing and had no real route, so they were removed rather
 * than kept as controls that lied about recording something.
 */

import { useCallback } from 'react';
import type { Attachment, ChatMessage } from '@/prototype/types/prototype-types';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import type { ChatSendEffort, ChatSendMode, ChatSendOutcome } from '@/prototype/state/chat-send';
import {
  readChatMessageEffort,
  readChatMessageFileEdits,
  readChatMessageIsLive,
  readChatMessageMode,
  readChatMessageShellCommands,
  readChatMessageUsage,
} from '@/prototype/state/gateway-chat';
import type { ChatFileEdit, ChatShellCommand } from '@/prototype/state/gateway-chat';
import {
  ExampleTag,
  Eyebrow,
  Icon,
  IconButton,
  Machine,
  Spacer,
  StatusBadge,
} from '@/components/primitives';
import { isFixtureMode } from '@/config/mode';
import { renderMarkdown } from './markdown';

export interface MessageProps {
  readonly message: ChatMessage;
  /** True while the local simulator is still revealing this message. */
  readonly streaming?: boolean;
  /** 1-based position in the thread, announced to assistive tech. */
  readonly position: number;
  readonly total: number;
  /**
   * The real regenerate action for this turn, or null/undefined when there is
   * none. Provided only for a real assistant message with a real preceding
   * user turn — see `MessageList`'s `regenerateFor`.
   */
  readonly regenerate?: (() => Promise<ChatSendOutcome>) | null;
  /**
   * feat-model-picker: the model the PRECEDING user turn requested, for a real assistant reply to
   * one — read by `MessageList.tsx` off that preceding turn's own record
   * (`readChatMessageRequestedModel`), since this component only ever sees its own single turn.
   * `null`/omitted for a user message, a fixture message, a reply whose preceding turn requested
   * nothing ("Default"), or a reply with no real preceding user turn at all.
   */
  readonly requestedModel?: string | null;
}

const ATTACHMENT_ICON: Readonly<Record<Attachment['kind'], string>> = {
  image: 'Image',
  markdown: 'FileText',
  code: 'FileCode',
  log: 'ScrollText',
  archive: 'FileArchive',
};

const FOOTER_DETAIL =
  'Example response. The model and skill labels are display strings — nothing was generated and no session was contacted.';

/**
 * feat-model-picker CORRECTION (2026-07-30): a real, CLI-verified `--model` value can carry a
 * trailing context-window annotation (e.g. `claude-opus-5[1m]`) that the CLI's own `modelUsage`
 * report always strips back to its plain `canonicalModel` (`exec-stream-parse.mjs`'s
 * `extractResultUsage` already prefers `canonicalModel` over the raw, possibly-bracketed key — see
 * that function's own doc comment). Comparing the raw REQUESTED string against the canonical
 * ACTUALLY-RAN string without normalizing this would flag a genuine, fully-honored request (Opus
 * 1M asked for, Opus 1M ran) as a false "mismatch" on every single send, purely because of this
 * cosmetic naming difference — never for a real difference in what ran. Used ONLY to decide
 * whether a mismatch is real; the chip still DISPLAYS the raw, unaltered `requestedModel` text.
 */
function stripContextWindowSuffix(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

/**
 * fix-stream-insights (checkup #6): a genuine added/removed diff is only possible for an Edit
 * (both `oldString`/`newString` are real) — a Write has no "before" state to diff against (it
 * replaces the whole file), so it never gets a fabricated diff, only its file path below. No line-
 * level diff algorithm is run: this is an honest presentation of the two real strings the CLI
 * itself reported (what it replaced, what it replaced it with), not a computed diff.
 */
function buildEditDiffText(edit: ChatFileEdit): string | null {
  if (edit.oldString === null || edit.newString === null) return null;
  const removed = edit.oldString.split('\n').map((line) => `- ${line}`);
  const added = edit.newString.split('\n').map((line) => `+ ${line}`);
  return [...removed, ...added].join('\n');
}

/**
 * composer-modes-ui: a mode chip for every non-default mode the turn genuinely ran in — 'execute'
 * (the default) has no entry and therefore never shows a chip, exactly like before this feature
 * widened the mode set from Execute|Plan. Only ever read from `readChatMessageMode`'s own real,
 * gateway-carried value; never guessed from the composer's current selection (which only
 * describes the NEXT send, not a past one).
 */
const MODE_CHIP_TEXT: Readonly<Partial<Record<ChatSendMode, string>>> = {
  plan: 'PLAN',
  'accept-edits': 'ACCEPT EDITS',
  bypass: 'BYPASS',
};

const MODE_CHIP_TITLE: Readonly<Partial<Record<ChatSendMode, string>>> = {
  plan: 'This turn ran in plan mode.',
  'accept-edits': 'This turn ran with edits accepted automatically.',
  bypass: 'This turn ran with permission prompts bypassed.',
};

/** composer-modes-ui: the effort chip's own display text, uppercased for the same chip style as
 *  the mode chips. Only ever read from `readChatMessageEffort`'s own real, gateway-carried value. */
const EFFORT_CHIP_TEXT: Readonly<Record<ChatSendEffort, string>> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  xhigh: 'EXTRA HIGH',
  max: 'MAX',
};

export function Message({
  message,
  streaming = false,
  position,
  total,
  regenerate = null,
  requestedModel = null,
}: MessageProps) {
  const { dispatch } = usePrototype();
  const isUser = message.author === 'user';
  const author = isUser ? 'You' : 'Forge';

  const toast = useCallback(
    (title: string, detail?: string, icon?: string) => {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });
    },
    [dispatch],
  );

  const handleRegenerate = useCallback(() => {
    if (!regenerate) {
      toast(
        'Nothing to regenerate',
        'This reply has no preceding message to send again.',
        'RefreshCw',
      );
      return;
    }
    void regenerate().then((outcome) => {
      if (outcome.ok) {
        toast('Regenerating', 'Re-sent your last message. The new reply streams in below.', 'RefreshCw');
      } else if (outcome.error !== null) {
        toast('Regenerate failed', outcome.error, 'TriangleAlert');
      }
    });
  }, [regenerate, toast]);

  const copy = useCallback(
    (text: string, what: string) => {
      try {
        navigator.clipboard?.writeText(text).catch(() => undefined);
      } catch {
        /* No clipboard in this context — the toast still tells the truth below. */
      }
      toast(`${what} copied`, 'Copied to this tab’s clipboard. Nothing left the browser.', 'Copy');
    },
    [toast],
  );

  const steps = message.steps ?? [];
  const attachments = message.attachments ?? [];
  const skills = message.skills ?? [];
  const completed = steps.filter((step) => step.status === 'completed').length;
  // fix-stream-insights (checkup #6): real per-turn file edits, empty for a fixture/example
  // message or a turn that called neither Edit nor Write — see `readChatMessageFileEdits`'s own
  // doc comment.
  const fileEdits = readChatMessageFileEdits(message);
  // feat-live-stream: real per-turn Bash commands (empty for a fixture/example message or a turn
  // that never called Bash — see `readChatMessageShellCommands`'s own doc comment), and whether
  // this specific message is the one synthetic still-running placeholder.
  const shellCommands = readChatMessageShellCommands(message);
  const isLive = readChatMessageIsLive(message);
  // fix-sec-round #3 (MEDIUM): `mode`/`effort` are written onto the USER turn's own record
  // (`conversations.mjs`'s `appendUserTurn` — the assistant/forge turn never carries either
  // field), so the chip must be read from the user's own turn, not the reply that follows it. Real
  // only when this turn's own gateway-carried meta says so — never guessed from the composer's
  // current selection (which only describes the NEXT send, not a past one). 'execute' (the
  // default) has no chip text and therefore renders none.
  const turnMode = isUser ? readChatMessageMode(message) : null;
  const modeChipText = turnMode !== null ? (MODE_CHIP_TEXT[turnMode] ?? null) : null;
  const modeChipTitle = turnMode !== null ? (MODE_CHIP_TITLE[turnMode] ?? null) : null;
  const turnEffort = isUser ? readChatMessageEffort(message) : null;
  const effortChipText = turnEffort !== null ? EFFORT_CHIP_TEXT[turnEffort] : null;

  // The per-message footer differs by mode. In fixtures it is the showcase
  // footer verbatim — the theme showcase and screenshots depend on it. In the
  // connected production build a field is shown only when it carries a REAL
  // value; a field with no real source is OMITTED, never filled with a
  // placeholder like "example-runtime · local", "no skill recorded" or
  // "mode · standard".
  //
  // feat-model-picker: `usageModel` (`readChatMessageUsage`, role-gated to `assistant` turns —
  // see that reader's own doc comment) is the model the run's OWN `result.modelUsage` actually
  // reported, never the requested choice. It is the source of truth here: when it is null (a
  // fixture message, mock mode, a spawn error, or a pre-existing turn recorded before this field
  // existed), NOTHING is shown for the requested choice either — per this WP's own "never show a
  // requested model as though it were the truth" rule, a mismatch chip only ever renders once the
  // real run outcome is known. `isMismatch` compares NORMALIZED forms (`stripContextWindowSuffix`)
  // so a context-window annotation on the request (e.g. "claude-opus-5[1m]") never reads as a
  // mismatch against the canonical "claude-opus-5" the run reports — only a GENUINE difference in
  // which model ran shows the split chip; the displayed text still uses the raw `requestedModel`.
  const usageModel = readChatMessageUsage(message).usageModel;
  const isMismatch =
    usageModel !== null &&
    requestedModel !== null &&
    stripContextWindowSuffix(requestedModel) !== stripContextWindowSuffix(usageModel);
  const modelText =
    usageModel !== null
      ? isMismatch
        ? `gevraagd: ${requestedModel} · gedraaid: ${usageModel}`
        : usageModel
      : message.model && message.model.trim().length > 0
        ? message.model
        : null;
  const modelTitle = isMismatch
    ? 'A different model was requested than the one that actually generated this response.'
    : 'Model that generated this response.';
  const skillText = skills.length > 0 ? skills.join(' · ') : null;

  const forgeFooter = isFixtureMode() ? (
    <footer className="fw-chat-msg__foot">
      <span className="fw-chat-meta" title="Example runtime label. Display only.">
        <Icon name="Cpu" size="xs" />
        <Machine muted>{message.model ?? 'example-runtime · local'}</Machine>
      </span>
      <span className="fw-chat-meta" title="Skills the example response was written against.">
        <Icon name="Sparkles" size="xs" />
        <Machine muted>{skills.length > 0 ? skills.join(' · ') : 'no skill recorded'}</Machine>
      </span>
      <span className="fw-chat-meta" title="Mode and persona are a placeholder in this prototype.">
        <Icon name="SlidersHorizontal" size="xs" />
        <Machine muted>mode · standard</Machine>
      </span>
      <Spacer />
      <ExampleTag detail={FOOTER_DETAIL} />
    </footer>
  ) : modelText !== null || skillText !== null ? (
    <footer className="fw-chat-msg__foot">
      {modelText !== null ? (
        <span className="fw-chat-meta" title={modelTitle}>
          <Icon name="Cpu" size="xs" />
          <Machine muted>{modelText}</Machine>
        </span>
      ) : null}
      {skillText !== null ? (
        <span className="fw-chat-meta" title="Skills recorded for this response.">
          <Icon name="Sparkles" size="xs" />
          <Machine muted>{skillText}</Machine>
        </span>
      ) : null}
    </footer>
  ) : null;

  return (
    <article
      className={`fw-chat-msg fw-chat-msg--${isUser ? 'user' : 'forge'}`}
      data-chat-message=""
      tabIndex={0}
      aria-label={`Message ${position} of ${total}, from ${author}, ${message.timestamp}`}
      aria-busy={streaming || isLive || undefined}
    >
      <header className="fw-chat-msg__head">
        <Eyebrow className="fw-chat-msg__author">{author}</Eyebrow>
        <Machine muted className="fw-chat-msg__time">
          {message.timestamp}
        </Machine>
        {message.edited ? (
          <Machine muted className="fw-chat-msg__edited">
            edited
          </Machine>
        ) : null}
        {isLive ? (
          <StatusBadge status="running" size="sm" className="fw-chat-msg__live-badge" />
        ) : null}
        {modeChipText !== null ? (
          <span className="fw-chat-msg__mode-chip" title={modeChipTitle ?? undefined}>
            {modeChipText}
          </span>
        ) : null}
        {effortChipText !== null ? (
          <span className="fw-chat-msg__mode-chip" title="The effort level this turn ran with.">
            {effortChipText}
          </span>
        ) : null}
        <Spacer />
        <div className="fw-chat-msg__actions">
          <IconButton
            icon="Copy"
            label="Copy this message"
            size="sm"
            onClick={() => copy(message.body, 'Message')}
          />
          {isUser ? null : (
            <IconButton
              icon="RefreshCw"
              label="Regenerate this response"
              size="sm"
              onClick={handleRegenerate}
            />
          )}
        </div>
      </header>

      <div className="fw-chat-msg__body fw-chat-md">
        {renderMarkdown(message.body, {
          idPrefix: message.id,
          caret: streaming,
          onCopy: (code, lang) => copy(code, `${lang} block`),
        })}
      </div>

      {steps.length > 0 ? (
        <details className="fw-chat-steps">
          <summary className="fw-chat-steps__summary">
            <Icon name="ChevronRight" size="sm" className="fw-chat-steps__chevron" />
            <Machine className="fw-chat-steps__count">
              {steps.length} steps · {completed} completed
            </Machine>
            <Spacer />
            <span className="fw-chat-steps__hint">progress</span>
          </summary>
          <ol className="fw-chat-steps__list">
            {steps.map((step) => (
              <li key={step.id} className="fw-chat-step fw-status" data-status={step.status}>
                <StatusBadge status={step.status} size="sm" className="fw-chat-step__badge" />
                <div className="fw-chat-step__text">
                  <span className="fw-chat-step__label">{step.label}</span>
                  <span className="fw-chat-step__detail">{step.detail}</span>
                </div>
                {step.agent ? (
                  <Machine muted className="fw-chat-step__agent">
                    {step.agent}
                  </Machine>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {fileEdits.length > 0 ? (
        <details className="fw-chat-steps">
          <summary className="fw-chat-steps__summary">
            <Icon name="ChevronRight" size="sm" className="fw-chat-steps__chevron" />
            <Machine className="fw-chat-steps__count">
              {fileEdits.length} {fileEdits.length === 1 ? 'file' : 'files'} changed
            </Machine>
            <Spacer />
            <span className="fw-chat-steps__hint">diff</span>
          </summary>
          <ul className="fw-chat-steps__list">
            {fileEdits.map((edit, index) => {
              const diffText = buildEditDiffText(edit);
              return (
                <li key={`${message.id}-file-${index}`} className="fw-chat-file">
                  <div className="fw-chat-file__head">
                    <Icon name="FileCode" size="xs" />
                    <Machine className="fw-chat-file__path">{edit.filePath}</Machine>
                    <Machine muted className="fw-chat-file__tool">
                      {edit.tool}
                    </Machine>
                  </div>
                  {diffText !== null ? (
                    <pre className="fw-chat-file__diff">
                      <code className="fg-machine">{diffText}</code>
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

      {shellCommands.length > 0 ? (
        <details className="fw-chat-steps">
          <summary className="fw-chat-steps__summary">
            <Icon name="ChevronRight" size="sm" className="fw-chat-steps__chevron" />
            <Machine className="fw-chat-steps__count">
              {shellCommands.length} {shellCommands.length === 1 ? 'command' : 'commands'} run
            </Machine>
            <Spacer />
            <span className="fw-chat-steps__hint">shell</span>
          </summary>
          <ul className="fw-chat-steps__list">
            {shellCommands.map((cmd: ChatShellCommand, index) => (
              <li key={`${message.id}-shell-${index}`} className="fw-chat-shell">
                <div className="fw-chat-shell__head">
                  <Icon name="Terminal" size="xs" />
                  {cmd.description !== null ? (
                    <Machine className="fw-chat-shell__description">{cmd.description}</Machine>
                  ) : null}
                  {cmd.isError === null ? null : (
                    <Machine muted className="fw-chat-shell__status" title={cmd.isError ? 'This command reported an error.' : 'This command completed without error.'}>
                      {cmd.isError ? 'error' : 'ok'}
                    </Machine>
                  )}
                </div>
                <pre className="fw-chat-shell__command">
                  <code className="fg-machine">{cmd.command}</code>
                </pre>
                {cmd.result !== null ? (
                  <pre className="fw-chat-shell__result">
                    <code className="fg-machine">{cmd.result}</code>
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {attachments.length > 0 ? (
        <ul className="fw-chat-atts" aria-label="Attachments">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <button
                type="button"
                className="fw-chat-att"
                onClick={() =>
                  toast(
                    'Preview not available',
                    `${attachment.name} is an example record. There is no file behind it.`,
                    'Paperclip',
                  )
                }
              >
                <Icon name={ATTACHMENT_ICON[attachment.kind]} size="sm" />
                <Machine className="fw-chat-att__name">{attachment.name}</Machine>
                <Machine muted className="fw-chat-att__size">
                  {attachment.size}
                </Machine>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {isUser ? null : forgeFooter}
    </article>
  );
}
