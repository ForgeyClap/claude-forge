/**
 * AskQuestionsDialog — the real "Forge is asking" question box (feat-ask-owner →
 * feat-ask-ui click-wizard, forge-2026-07-30-cc-finish).
 *
 * Renders ONE real `PendingAsk` (gateway/src/ask-store.mjs, via `useGatewayAskQuestions`) as a
 * click-through wizard: one question per screen, a "Question x of y" pager, numbered fully-
 * clickable option rows, an ALWAYS-present free-text row, and a final review screen with a compact
 * summary of every chosen answer before Send — never all questions crammed into one scroll.
 *
 * NAVIGATION: Previous/Next live in the modal footer (not a header arrow pair) — a deliberate
 * placement choice, not a copy of the reference screenshot's top-right arrows. A modal footer is
 * this codebase's existing convention for the primary forward action (Send already lived there),
 * and at a 375px width two footer buttons have far more room than icon-buttons squeezed next to a
 * pager label in the header row. `step` ranges 0..questions.length inclusive: 0..length-1 are the
 * question pages, `length` itself is the review page — reaching it requires paging through every
 * question at least once, which is what makes the pre-send summary genuinely a "did you mean to
 * send this" checkpoint rather than decoration.
 *
 * KEYBOARD: digits 1-9 select the option at that position directly (an option beyond the 9th has no
 * digit binding — rare in practice, and it degrades to click/Tab, never to a broken row). Arrow
 * keys (Left/Up and Right/Down) move DOM focus between option rows as an ADDITIONAL affordance
 * layered on top of normal Tab order — no `tabindex="-1"` is introduced (this project's own
 * a11y-audit memory flags roving tabindex as a recurring false-positive/real-defect source), so Tab
 * still visits every row in document order exactly as before. Enter/Space "confirm" a focused
 * option for free: these are real `<button>` elements, so the browser's own default activation
 * already fires `onClick` — no bespoke Enter handler was needed or added.
 *
 * SKIP SEMANTICS (deliberately not a silent empty submit): the real `claude` session on the other
 * end is GENUINELY blocked on this exact question (gateway's `POST /api/ask` does not respond until
 * answered or timed out — see Modal's own "must be answered, not dismissed" case). Sending an empty
 * string would let the agent silently guess it received "nothing" as a real preference, which is not
 * what happened — the owner made an explicit choice not to have one. So "Skip" here maps to a fixed,
 * honest, non-empty answer text (`NO_PREFERENCE_ANSWER`) rather than an empty one, and that literal
 * text is what the review-screen summary shows for that question — the owner sees exactly what gets
 * sent, never a fabricated pick from the option list. Selecting an option or typing free text after a
 * skip immediately un-skips that question (the real choice always wins over a stale skip).
 *
 * `hideClose` is unchanged and deliberate: the dialog is not dismissible while the session waits.
 * Requirement item 6 (owner spec) — "make the wait visible, don't just make it non-closable" — is
 * satisfied by the Modal `description` line below, which is the one honest sentence stating the
 * agent is genuinely waiting; it does not change across pager steps because the wait itself does not.
 *
 * Never fabricates an answer: Send is disabled until every question resolves to a non-empty final
 * answer (a selected option, a real free-text value, or an explicit skip), and a failed submit keeps
 * the box open with the gateway's own real error text.
 *
 * ABANDONED ASK (fix-ghost-asks, forge-2026-07-30-cc-finish, item 3): `abandoned` is non-null for
 * exactly one thing — the ask that WAS pending just closed because the execution behind it ended
 * (stopped/closed/timed out) or a gateway restart found it dangling on disk, never because it was
 * genuinely answered (a real answer closes the box silently, unchanged from before this fix). This
 * is the one case in the whole component that is NOT hidden-while-waiting: the session is
 * genuinely gone, so the dialog becomes dismissible (a real Close button, the Modal's own default
 * scrim/Escape/X — `hideClose` is deliberately NOT set here, the opposite of the pending case
 * above) and states that fact in one honest sentence instead of the box just vanishing on the next
 * poll with no explanation. Reuses this file's existing `.fw-ask` wrapper and the codebase's
 * existing `fw-field__hint`/`role="alert"` pattern (already used for a failed submit above) — no
 * new class, no new primitive.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, Eyebrow, Icon, KeyHint, Modal } from '@/components/primitives';
import type { AbandonedAskNotice, AskQuestion, PendingAsk } from '@/prototype/state/gateway-chat/ask-questions';

export interface AskQuestionsDialogProps {
  readonly pending: PendingAsk | null;
  readonly submitting: boolean;
  readonly onSubmit: (answers: readonly string[]) => Promise<{ ok: boolean; error: string | null }>;
  /** fix-ghost-asks item 3: see the file header's ABANDONED ASK note. `null` is the ordinary case. */
  readonly abandoned?: AbandonedAskNotice | null;
  /** Called when the owner dismisses an abandoned-ask notice. Required whenever `abandoned` can be
   *  non-null; both default to the pre-existing no-abandonment behavior when omitted, so no other
   *  caller of this component needs to change. */
  readonly onDismissAbandoned?: () => void;
}

/** fix-ghost-asks item 3: maps the gateway's own real, machine-readable `reason` string to one
 *  honest human sentence fragment — falls back to the raw reason (or a generic honest phrase) for
 *  any value not in this list, never a blank line. */
const ABANDON_REASON_LABELS: Record<string, string> = {
  execution_stopped: 'the run was stopped',
  execution_closed: 'the run ended',
  execution_timed_out: "the run's time limit was reached",
  gateway_restart: 'the gateway was restarted',
};

function describeAbandonReason(reason: string | null): string {
  if (reason === null) return 'the session ended';
  return ABANDON_REASON_LABELS[reason] ?? reason;
}

interface QuestionAnswerState {
  readonly selected: readonly string[];
  readonly otherText: string;
  readonly skipped: boolean;
}

const EMPTY_ANSWER_STATE: QuestionAnswerState = { selected: [], otherText: '', skipped: false };

/** The literal, honest text sent (and shown in the review summary) for a skipped question — see
 *  the file header's SKIP SEMANTICS note for why this is never an empty string. */
export const NO_PREFERENCE_ANSWER = 'No preference';

function emptyAnswerState(questions: readonly AskQuestion[]): readonly QuestionAnswerState[] {
  return questions.map(() => EMPTY_ANSWER_STATE);
}

/** The single final answer string sent to the gateway for one question. A skip always wins (it is
 *  the owner's most recent explicit action); otherwise "Anders…" wins for a single-select question
 *  (typing something else supersedes a stale prior pick), and is an ADDITIONAL entry alongside
 *  active chips for a multi-select question. */
function computeFinalAnswer(question: AskQuestion, state: QuestionAnswerState): string {
  if (state.skipped) return NO_PREFERENCE_ANSWER;
  const otherText = state.otherText.trim();
  if (question.multiSelect) {
    const parts = otherText.length > 0 ? [...state.selected, otherText] : state.selected;
    return parts.join(', ');
  }
  return otherText.length > 0 ? otherText : (state.selected[0] ?? '');
}

export function AskQuestionsDialog({
  pending,
  submitting,
  onSubmit,
  abandoned = null,
  onDismissAbandoned = () => {},
}: AskQuestionsDialogProps) {
  const [answerState, setAnswerState] = useState<readonly QuestionAnswerState[]>([]);
  const [lastAskId, setLastAskId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const baseId = useId();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Resets the per-question answer state AND the pager position the moment a genuinely NEW ask
  // arrives (a new `id`) — the same "adjust state when a prop changes" render-time pattern this
  // codebase already uses in NewProjectDialog.tsx, rather than a useEffect for something that is
  // really a derived reset.
  const currentAskId = pending?.id ?? null;
  if (currentAskId !== lastAskId) {
    setLastAskId(currentAskId);
    setAnswerState(pending ? emptyAnswerState(pending.questions) : []);
    setStep(0);
    setFormError(null);
  }

  // Puts keyboard focus on the FIRST option row whenever a question step opens — what this really
  // fixes is PAGING. handleOptionsKeyDown is scoped to the options group (deliberately, so digits
  // typed into the free-text field stay literal), so a digit only reaches it while focus is inside
  // that group. MEASURED live in a real browser against a real gateway ask (2026-07-30):
  //   * freshly opened dialog, nothing clicked -> focus was ALREADY on option row 1 (the Modal's own
  //     focus handling) and pressing "2" correctly selected option 2. That case was never broken;
  //     an earlier probe of mine only "failed" because the probe itself clicked the heading first,
  //     which moves focus out of the group in a real browser (jsdom's fireEvent.click does not).
  //   * after clicking Next, focus sat on the Next button and pressing "1" selected NOTHING — so
  //     from question 2 onward the digit shortcuts were genuinely dead until the owner clicked or
  //     tabbed back into the list. That is the real defect this effect closes.
  // Focusing a row does NOT select it (selection is onClick/digit only), so this only moves focus.
  const stepQuestion = pending?.questions[Math.min(step, Math.max(pending.questions.length - 1, 0))];
  const optionCount = stepQuestion?.options.length ?? 0;
  // feat-ask-recommended: when the session marked a genuine recommendation, START focus there (still
  // never selecting) — Enter then accepts the advice in one keystroke, arrows/digits pick freely.
  const focusIndex = stepQuestion && stepQuestion.recommended !== null
    ? Math.max(0, stepQuestion.options.indexOf(stepQuestion.recommended))
    : 0;
  useEffect(() => {
    if (optionCount === 0) return;
    optionRefs.current[focusIndex]?.focus();
    // re-run per question step and per new ask; optionCount guards a question with no options at all
  }, [step, currentAskId, optionCount, focusIndex]);

  if (pending === null) {
    // fix-ghost-asks item 3: the terminal-with-explanation case — see this file's own ABANDONED ASK
    // header note. A real answer (the ordinary case) leaves `abandoned` null and this still
    // returns null exactly as before this fix.
    if (abandoned === null) return null;
    return (
      <Modal
        open
        onClose={onDismissAbandoned}
        size="md"
        title="Forge is asking"
        description="This question is no longer waiting for an answer."
        footer={
          <div className="fw-ask__footer-row">
            {/* "Dismiss", not "Close" — the Modal's own built-in close button (IconButton, X icon)
                is ALSO accessibly named "Close" (see ConfirmDeleteConversationDialog.tsx's own
                established "Cancel" vs. the Modal X's "Close" precedent for this exact distinction),
                so a second control also named "Close" would be a real duplicate-name ambiguity for
                assistive tech, not just a test-query inconvenience. */}
            <Button variant="primary" size="sm" onClick={onDismissAbandoned}>
              Dismiss
            </Button>
          </div>
        }
      >
        <div className="fw-ask">
          <p className="fw-field__hint" role="alert">
            The session that asked this question ended ({describeAbandonReason(abandoned.reason)}) before you
            answered — no answer was recorded. Nothing typed here would reach it anymore.
          </p>
        </div>
      </Modal>
    );
  }

  const totalQuestions = pending.questions.length;
  const reviewStep = totalQuestions;
  const isReviewStep = step >= reviewStep;
  const questionIndex = Math.min(step, totalQuestions - 1);
  const question = pending.questions[questionIndex];
  const state = answerState[questionIndex] ?? EMPTY_ANSWER_STATE;
  const otherFieldId = `${baseId}-other-${questionIndex}`;

  function toggleOption(qIndex: number, option: string, multiSelect: boolean) {
    setAnswerState((prev) =>
      prev.map((entry, i) => {
        if (i !== qIndex) return entry;
        const has = entry.selected.includes(option);
        const nextSelected = multiSelect
          ? has
            ? entry.selected.filter((o) => o !== option)
            : [...entry.selected, option]
          : has
            ? []
            : [option];
        // A real pick always cancels a prior skip — see file header SKIP SEMANTICS.
        return { selected: nextSelected, otherText: entry.otherText, skipped: false };
      }),
    );
  }

  function setOtherText(qIndex: number, value: string) {
    setAnswerState((prev) =>
      prev.map((entry, i) => (i === qIndex ? { selected: entry.selected, otherText: value, skipped: false } : entry)),
    );
  }

  function skipQuestion(qIndex: number) {
    setAnswerState((prev) => prev.map((entry, i) => (i === qIndex ? { selected: [], otherText: '', skipped: true } : entry)));
    setStep((s) => Math.min(s + 1, reviewStep));
  }

  function goPrev() {
    setStep((s) => Math.max(s - 1, 0));
  }

  function goNext() {
    setStep((s) => Math.min(s + 1, reviewStep));
  }

  /** Digits 1-9 select directly; Left/Up and Right/Down move focus between option rows. Scoped to
   *  the options group's own onKeyDown, so typing digits into the free-text field below is
   *  untouched (that input is a sibling, never inside this group). */
  function handleOptionsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const options = question.options;
    if (event.key >= '1' && event.key <= '9') {
      const optionIndex = Number(event.key) - 1;
      if (optionIndex < options.length) {
        event.preventDefault();
        toggleOption(questionIndex, options[optionIndex], question.multiSelect);
        optionRefs.current[optionIndex]?.focus();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      const current = optionRefs.current.findIndex((el) => el === document.activeElement);
      const next = current < 0 ? 0 : (current + 1) % options.length;
      optionRefs.current[next]?.focus();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const current = optionRefs.current.findIndex((el) => el === document.activeElement);
      const prev = current < 0 ? 0 : (current - 1 + options.length) % options.length;
      optionRefs.current[prev]?.focus();
    }
  }

  const finalAnswers = pending.questions.map((q, i) => computeFinalAnswer(q, answerState[i] ?? EMPTY_ANSWER_STATE));
  const allAnswered = finalAnswers.every((a) => a.trim().length > 0);

  async function handleSubmit() {
    if (pending === null || !allAnswered) return;
    setFormError(null);
    const outcome = await onSubmit(finalAnswers);
    if (!outcome.ok) setFormError(outcome.error ?? 'The gateway could not record your answer.');
  }

  const footer = isReviewStep ? (
    <div className="fw-ask__footer-row">
      <Button variant="ghost" size="sm" icon="ChevronLeft" onClick={goPrev} disabled={submitting}>
        Back
      </Button>
      <Button variant="primary" size="sm" onClick={() => void handleSubmit()} disabled={submitting || !allAnswered}>
        {submitting ? 'Sending…' : 'Send answers'}
      </Button>
    </div>
  ) : (
    <div className="fw-ask__footer-row">
      <Button variant="ghost" size="sm" icon="ChevronLeft" onClick={goPrev} disabled={step === 0}>
        Previous
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconRight={questionIndex === totalQuestions - 1 ? 'ListChecks' : 'ChevronRight'}
        onClick={goNext}
      >
        {questionIndex === totalQuestions - 1 ? 'Review answers' : 'Next'}
      </Button>
    </div>
  );

  return (
    <Modal
      open
      onClose={() => {}}
      hideClose
      size="md"
      title="Forge is asking"
      description="A running Claude Code session is waiting for your real answer before it continues."
      footer={footer}
    >
      <div className="fw-ask">
        {isReviewStep ? (
          <div className="fw-ask__summary">
            <Eyebrow>Review your answers</Eyebrow>
            <ul className="fw-ask__summary-list">
              {pending.questions.map((q, i) => (
                <li key={i} className="fw-ask__summary-item">
                  <span className="fw-ask__summary-q">{q.question}</span>
                  <span className="fw-ask__summary-a">{finalAnswers[i] || '—'}</span>
                </li>
              ))}
            </ul>
            {!allAnswered ? (
              <p className="fw-field__hint">Answer every question — or mark it "No preference" — before sending.</p>
            ) : null}
          </div>
        ) : (
          <fieldset className="fw-ask__question" disabled={submitting}>
            {/* A real <legend> renders itself as the fieldset's top-of-border caption in every
                current browser REGARDLESS of its position among siblings (confirmed by screenshot:
                an earlier draft with <legend> here rendered the question text ABOVE the pager and
                header despite being declared after them in JSX) — so the question text is a plain
                heading, not a <legend>, and DOM order now really is visual order. The fieldset
                keeps working for its one functional job here (cascading `disabled` to every child
                control while submitting); it does not need a <legend> to do that, and the options
                group below already carries the question text as its own aria-label. */}
            <Eyebrow className="fw-ask__pager">
              Question {questionIndex + 1} of {totalQuestions}
            </Eyebrow>
            {question.header ? <div className="fw-ask__header">{question.header}</div> : null}
            <h3 className="fw-ask__text">{question.question}</h3>
            {question.multiSelect ? <p className="fw-ask__hint">Select all that apply.</p> : null}
            {state.skipped ? (
              <p className="fw-ask__hint">
                Marked "No preference". Pick an option or type an answer below to change it.
              </p>
            ) : null}
            {question.options.length > 0 ? (
              <div
                className="fw-ask__options"
                role="group"
                aria-label={question.question}
                onKeyDown={handleOptionsKeyDown}
              >
                {question.options.map((option, optionIndex) => {
                  const isSelected = state.selected.includes(option);
                  /* feat-ask-recommended (owner: "ook willen we advies hebben bij intake vragen wat
                     recommended zijn!"): the session may mark ONE option as its genuine
                     recommendation. It renders as a visible "Recommended" tag on that row — advice
                     only: never pre-selected, never auto-answered; choosing something else stays
                     one click. The gateway already guarantees the value matches a real option. */
                  const isRecommended = question.recommended !== null && question.recommended === option;
                  return (
                    <button
                      key={option}
                      ref={(el) => {
                        optionRefs.current[optionIndex] = el;
                      }}
                      type="button"
                      className={isSelected ? 'fw-ask__option is-selected' : 'fw-ask__option'}
                      aria-pressed={isSelected}
                      onClick={() => toggleOption(questionIndex, option, question.multiSelect)}
                      disabled={submitting}
                    >
                      {/* aria-hidden: the digit is a visual + keyboard mnemonic (matches the
                          literal 1-9 key that selects this row), not part of the option's real
                          name — the button's accessible name stays exactly the option text, same
                          as before this row grew a number. */}
                      <span className="fw-ask__option-num" aria-hidden="true">
                        {optionIndex < 9 ? (
                          <KeyHint keys={[String(optionIndex + 1)]} size="sm" />
                        ) : (
                          <span className="fw-ask__option-num--plain fg-machine">{optionIndex + 1}</span>
                        )}
                      </span>
                      <span className="fw-ask__option-label">{option}</span>
                      {isRecommended ? (
                        <span className="fw-ask__option-recommended">
                          <Icon name="Sparkles" size="xs" />
                          Recommended
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <label className="fw-visually-hidden" htmlFor={otherFieldId}>
              {question.options.length > 0 ? 'Something else — type your own answer' : 'Your answer'}
            </label>
            <div className="fw-ask__other">
              <Icon name="Pencil" size="sm" className="fw-ask__other-icon" />
              <input
                id={otherFieldId}
                type="text"
                className="fw-ask__other-input"
                value={state.otherText}
                onChange={(event) => setOtherText(questionIndex, event.target.value)}
                placeholder={question.options.length > 0 ? 'Something else…' : 'Type your answer…'}
                disabled={submitting}
              />
            </div>
            <div className="fw-ask__skip-row">
              <Button variant="quiet" size="sm" onClick={() => skipQuestion(questionIndex)} disabled={submitting}>
                Skip — no preference
              </Button>
            </div>
          </fieldset>
        )}
        {formError ? (
          <p className="fw-field__hint" role="alert">
            {formError}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
