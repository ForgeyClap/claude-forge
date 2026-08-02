/**
 * AskQuestionsDialog — click-wizard behavior (feat-ask-ui, forge-2026-07-30-cc-finish).
 *
 * Renders the dialog directly (no ChatView, no gateway, no network) with fixture `PendingAsk`
 * data, so these tests exercise exactly the pager / digit-key / free-text / multiSelect / skip /
 * review-summary mechanics this work package added, independent of the gateway-polling plumbing
 * already covered by `chat-ask-owner.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AskQuestionsDialog, NO_PREFERENCE_ANSWER } from '@/views/chat/AskQuestionsDialog';
import type { PendingAsk } from '@/prototype/state/gateway-chat/ask-questions';

const THREE_QUESTIONS: PendingAsk = {
  id: 'ask-wizard-1',
  questions: [
    { header: 'Palette', question: 'Which color should the header use?', options: ['Ember', 'Slate', 'Moss'], multiSelect: false, recommended: null },
    { header: null, question: 'Any other pages needed?', options: ['Pricing', 'FAQ'], multiSelect: true, recommended: null },
    { header: null, question: 'Any hard deadline?', options: ['This week', 'No deadline'], multiSelect: false, recommended: null },
  ],
};

function renderDialog(overrides: Partial<Parameters<typeof AskQuestionsDialog>[0]> = {}) {
  const onSubmit = vi.fn(async () => ({ ok: true, error: null }));
  const utils = render(
    <AskQuestionsDialog pending={THREE_QUESTIONS} submitting={false} onSubmit={onSubmit} {...overrides} />,
  );
  return { onSubmit, ...utils };
}

describe('AskQuestionsDialog — pager', () => {
  afterEach(() => cleanup());

  it('shows exactly ONE question at a time with a real "Question x of y" pager, and only that question\'s options', () => {
    renderDialog();

    expect(screen.getByText('Question 1 of 3')).toBeInTheDocument();
    expect(screen.getByText('Which color should the header use?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ember' })).toBeInTheDocument();
    // The second question's own text/options are NOT rendered yet — this is the whole point of
    // the wizard (never all questions crammed into one scroll).
    expect(screen.queryByText('Any other pages needed?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pricing' })).toBeNull();

    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
  });

  it('Next/Previous page through every question and preserve each one\'s answer across navigation', () => {
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Ember' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));

    expect(screen.getByText('Question 2 of 3')).toBeInTheDocument();
    expect(screen.getByText('Any other pages needed?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pricing' }));

    fireEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(screen.getByText('Question 1 of 3')).toBeInTheDocument();
    // The Q1 pick from before navigating away is still there.
    expect(screen.getByRole('button', { name: 'Ember' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    // The Q2 pick made before going back is still there too.
    expect(screen.getByRole('button', { name: 'Pricing' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the last question\'s forward button reads "Review answers", not "Next"', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText('Question 3 of 3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^next$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /review answers/i })).toBeInTheDocument();
  });
});

describe('AskQuestionsDialog — digit keys and options', () => {
  afterEach(() => cleanup());

  it('pressing digit "2" selects the 2nd option directly, without a click', () => {
    renderDialog();
    const emberRow = screen.getByRole('button', { name: 'Ember' });
    fireEvent.keyDown(emberRow, { key: '2' });
    expect(screen.getByRole('button', { name: 'Slate' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Ember' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a digit beyond the option count is a no-op (never throws, never selects out of range)', () => {
    renderDialog();
    const emberRow = screen.getByRole('button', { name: 'Ember' });
    fireEvent.keyDown(emberRow, { key: '9' });
    expect(screen.getByRole('button', { name: 'Ember' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Slate' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Moss' })).toHaveAttribute('aria-pressed', 'false');
  });

  /* The two digit tests above fire the key ON an option row, which forces the event to originate
   * inside the options group no matter where focus really is — so they cannot tell whether the
   * shortcut is reachable at all. MEASURED live in a real browser against a real gateway ask
   * (2026-07-30): on a freshly opened dialog focus was already on row 1 and "2" worked, but after
   * clicking Next focus sat on the Next button and "1" selected NOTHING — the digit shortcuts were
   * dead from question 2 onward. Only the third test below reproduces that (and it is the only one
   * of these three that actually fails against the pre-fix component; the first two document
   * behavior that already held, which is why they are worded as guarantees, not as bug repros). */
  it('focuses the FIRST option row as soon as a question opens, so the digit shortcuts are reachable without clicking or tabbing in', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ember' }));
    // focusing must never count as answering
    expect(screen.getByRole('button', { name: 'Ember' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a digit pressed at whatever actually has focus right after opening still selects', () => {
    renderDialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: '2' });
    expect(screen.getByRole('button', { name: 'Slate' })).toHaveAttribute('aria-pressed', 'true');
  });

  // THE live-measured defect: pre-fix, focus stayed on the Next button, so digits did nothing from
  // question 2 onward.
  it('moves focus to the next question\'s first option row when paging forward', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Ember' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pricing' }));
  });

  it('ArrowDown/ArrowRight move DOM focus to the next option row (no tabindex="-1" involved)', () => {
    renderDialog();
    const ember = screen.getByRole('button', { name: 'Ember' });
    const slate = screen.getByRole('button', { name: 'Slate' });
    ember.focus();
    fireEvent.keyDown(ember, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(slate);
  });

  it('ArrowUp/ArrowLeft wraps focus back to the last option row from the first', () => {
    renderDialog();
    const ember = screen.getByRole('button', { name: 'Ember' });
    const moss = screen.getByRole('button', { name: 'Moss' });
    ember.focus();
    fireEvent.keyDown(ember, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(moss);
  });
});

describe('AskQuestionsDialog — free-text field', () => {
  afterEach(() => cleanup());

  it('typing in "Something else…" for a single-select question supersedes a prior chip pick', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Ember' }));
    fireEvent.change(screen.getByPlaceholderText(/something else/i), { target: { value: 'Sunset orange' } });

    // Page to the review screen through every question.
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /review answers/i }));

    expect(screen.getByText('Sunset orange')).toBeInTheDocument();
    expect(screen.queryByText('Ember', { selector: '.fw-ask__summary-a' })).toBeNull();
  });
});

describe('AskQuestionsDialog — multiSelect free-text addition', () => {
  afterEach(() => cleanup());

  it('typing free text on a multiSelect question is ADDED alongside the active chips, not a replacement', async () => {
    const { onSubmit } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Ember' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Pricing' }));
    fireEvent.click(screen.getByRole('button', { name: 'FAQ' }));
    fireEvent.change(screen.getByPlaceholderText(/something else/i), { target: { value: 'Blog' } });

    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    fireEvent.click(screen.getByRole('button', { name: /review answers/i }));

    expect(screen.getByText('Pricing, FAQ, Blog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /send answers/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(['Ember', 'Pricing, FAQ, Blog', 'This week']));
  });
});

describe('AskQuestionsDialog — skip semantics (never a silent empty submit)', () => {
  afterEach(() => cleanup());

  it('Skip marks the question "No preference" (never empty), shows it in the review summary, and auto-advances', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));

    // Auto-advanced to question 2.
    expect(screen.getByText('Question 2 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pricing' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));

    // Skip on the LAST question auto-advances straight into the review step.
    expect(screen.getByText('Review your answers')).toBeInTheDocument();
    const summaryAnswers = screen.getAllByText(NO_PREFERENCE_ANSWER);
    expect(summaryAnswers).toHaveLength(2);
  });

  it('picking a real option after a skip un-skips the question — the real choice wins', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    fireEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(screen.getByText(/marked "no preference"/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Slate' }));
    expect(screen.queryByText(/marked "no preference"/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Slate' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('AskQuestionsDialog — review summary and honest Send gating', () => {
  afterEach(() => cleanup());

  function goToReview() {
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /review answers/i }));
  }

  it('Send is disabled on the review screen until every question is truly answered or explicitly skipped', () => {
    renderDialog();
    goToReview();

    // Nothing was answered — the summary must show an honest placeholder, never a fabricated pick.
    expect(screen.getByRole('button', { name: /send answers/i })).toBeDisabled();
    expect(screen.getAllByText('—')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    fireEvent.click(screen.getByRole('button', { name: /previous/i }));
    fireEvent.click(screen.getByRole('button', { name: /previous/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Ember' }));
    goToReview();
    expect(screen.getByRole('button', { name: /send answers/i })).toBeDisabled(); // Q2/Q3 still open
  });

  it('sends the real position-correlated answers only once every question resolves, and a failed submit keeps the box open with the real error', async () => {
    const onSubmit = vi.fn(async () => ({ ok: false, error: 'gateway unreachable' }));
    renderDialog({ onSubmit });

    fireEvent.click(screen.getByRole('button', { name: 'Ember' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pricing' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    fireEvent.click(screen.getByRole('button', { name: /review answers/i }));

    const sendButton = screen.getByRole('button', { name: /send answers/i });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    fireEvent.click(sendButton);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(['Ember', 'Pricing', 'This week']));
    expect(await screen.findByRole('alert')).toHaveTextContent('gateway unreachable');
    // Still open — a failed submit never silently closes the box.
    expect(screen.getByText('Review your answers')).toBeInTheDocument();
  });
});

// fix-ghost-asks (forge-2026-07-30-cc-finish, item 3): the abandoned-ask notice — the ONE case in
// this component that is not "hidden while waiting" (see AskQuestionsDialog.tsx's own file-header
// ABANDONED ASK note for the full rationale).
describe('AskQuestionsDialog — abandoned ask notice (fix-ghost-asks item 3)', () => {
  afterEach(() => cleanup());

  it('renders nothing when both pending and abandoned are null (the ordinary "nothing waiting" case, unchanged)', () => {
    const { container } = render(<AskQuestionsDialog pending={null} submitting={false} onSubmit={vi.fn()} abandoned={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a dismissible "Forge is asking" dialog with an honest sentence naming the real reason, and both a real Close (X) icon and a Dismiss button', () => {
    const onDismissAbandoned = vi.fn();
    render(
      <AskQuestionsDialog
        pending={null}
        submitting={false}
        onSubmit={vi.fn()}
        abandoned={{ id: 'ask-1', reason: 'execution_stopped' }}
        onDismissAbandoned={onDismissAbandoned}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Forge is asking' });
    expect(dialog).toHaveTextContent('the run was stopped');
    expect(dialog).toHaveTextContent('no answer was recorded');
    // Unlike the pending case (hideClose), the Modal's own Close (X) icon IS present here — the
    // session is genuinely gone, so the dialog is dismissible.
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismissAbandoned).toHaveBeenCalledTimes(1);
  });

  it('the footer "Dismiss" button also calls onDismissAbandoned', () => {
    const onDismissAbandoned = vi.fn();
    render(
      <AskQuestionsDialog
        pending={null}
        submitting={false}
        onSubmit={vi.fn()}
        abandoned={{ id: 'ask-1', reason: 'gateway_restart' }}
        onDismissAbandoned={onDismissAbandoned}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^dismiss$/i }));
    expect(onDismissAbandoned.mock.calls.length).toBeGreaterThan(0);
  });

  it('an unrecognized reason string is still shown verbatim, never dropped or replaced with a fabricated one', () => {
    render(
      <AskQuestionsDialog pending={null} submitting={false} onSubmit={vi.fn()} abandoned={{ id: 'ask-1', reason: 'some_future_reason' }} onDismissAbandoned={vi.fn()} />,
    );
    expect(screen.getByRole('dialog', { name: 'Forge is asking' })).toHaveTextContent('some_future_reason');
  });

  it('a null reason (event exists but carries no reason string) falls back to one honest generic sentence, never a blank', () => {
    render(<AskQuestionsDialog pending={null} submitting={false} onSubmit={vi.fn()} abandoned={{ id: 'ask-1', reason: null }} onDismissAbandoned={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Forge is asking' })).toHaveTextContent('the session ended');
  });

  it('a genuinely pending ask takes precedence over a stale `abandoned` value — the real wizard renders, not the notice', () => {
    render(
      <AskQuestionsDialog pending={THREE_QUESTIONS} submitting={false} onSubmit={vi.fn()} abandoned={{ id: 'some-other-ask', reason: 'execution_closed' }} onDismissAbandoned={vi.fn()} />,
    );
    expect(screen.getByText('Question 1 of 3')).toBeInTheDocument();
    expect(screen.queryByText(/no longer waiting/i)).toBeNull();
  });
});

/* feat-ask-recommended (owner: "ook willen we advies hebben bij intake vragen wat recommended
 * zijn!" + "het moet wel echt de beste recommenderen en niet random!"): the session may mark ONE
 * option as its earned recommendation. The wizard shows it as a visible "Recommended" tag and
 * STARTS focus there — advice only: never pre-selected, never auto-answered. */
describe('AskQuestionsDialog — recommended option', () => {
  afterEach(() => cleanup());

  const WITH_RECOMMENDATION: PendingAsk = {
    id: 'ask-rec-1',
    questions: [
      { header: 'Route', question: 'Which route fits best?', options: ['PWA', 'Native', 'Hybrid'], multiSelect: false, recommended: 'Native' },
    ],
  };

  it('shows a visible "Recommended" tag on exactly the recommended row — and does NOT pre-select it', () => {
    const onSubmit = vi.fn(async () => ({ ok: true, error: null }));
    render(<AskQuestionsDialog pending={WITH_RECOMMENDATION} submitting={false} onSubmit={onSubmit} />);
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    const native = screen.getByRole('button', { name: /Native/ });
    expect(native.textContent).toContain('Recommended');
    expect(screen.getByRole('button', { name: /^1 PWA$|PWA/ }).textContent).not.toContain('Recommended');
    // advice, never an answer: nothing is selected until the owner acts
    expect(native).toHaveAttribute('aria-pressed', 'false');
  });

  it('starts keyboard focus on the recommended row (Enter accepts the advice in one keystroke), without selecting it', () => {
    const onSubmit = vi.fn(async () => ({ ok: true, error: null }));
    render(<AskQuestionsDialog pending={WITH_RECOMMENDATION} submitting={false} onSubmit={onSubmit} />);
    const native = screen.getByRole('button', { name: /Native/ });
    expect(document.activeElement).toBe(native);
    expect(native).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders no tag at all when recommended is null (never a fabricated recommendation)', () => {
    const onSubmit = vi.fn(async () => ({ ok: true, error: null }));
    render(<AskQuestionsDialog pending={THREE_QUESTIONS} submitting={false} onSubmit={onSubmit} />);
    expect(screen.queryByText('Recommended')).toBeNull();
    // and focus falls back to the first row, the pre-existing behavior
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ember' }));
  });
});
