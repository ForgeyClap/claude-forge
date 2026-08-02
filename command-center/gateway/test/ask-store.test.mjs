// Unit tests for ask-store.mjs (feat-ask-owner, forge-2026-07-30-cc-finish) — the in-memory
// pending-question registry. No HTTP, no MCP subprocess here (see routes-ask.test.mjs and
// ask-mcp.test.mjs for those layers) — this file proves the registry itself: registering,
// answering, timing out, and every validation edge honestly.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAskRequest,
  answerAskRequest,
  getAskMeta,
  abandonPendingAsksForConversation,
  _setAskTimeoutMsForTests,
  _resetAskStoreForTests,
  _pendingAskCountForTests,
  MAX_QUESTIONS_PER_ASK,
} from '../src/ask-store.mjs';

beforeEach(() => {
  _resetAskStoreForTests();
});

test('createAskRequest registers a real pending ask and returns a promise that has not settled yet', async () => {
  const created = createAskRequest({ convId: 'c-1', turnId: 't-1', requestId: 'req-1', questions: [{ question: 'Pick a color', options: ['red', 'blue'] }] });
  assert.equal(created.ok, true);
  assert.match(created.id, /^ask-/);
  assert.equal(created.turnId, 't-1');
  assert.equal(created.requestId, 'req-1');
  assert.equal(created.questions.length, 1);
  assert.equal(created.questions[0].question, 'Pick a color');
  assert.deepEqual(created.questions[0].options, ['red', 'blue']);
  assert.equal(created.questions[0].multiSelect, false);
  assert.equal(_pendingAskCountForTests(), 1);

  const meta = getAskMeta(created.id);
  assert.equal(meta.status, 'pending');

  // Never settles on its own without a real answer or the timeout — proven by racing it against a
  // short, definitely-shorter timer.
  const raceResult = await Promise.race([
    created.promise.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 50)),
  ]);
  assert.equal(raceResult, 'still-pending');
});

test('answerAskRequest resolves the pending promise with the REAL answers, position-correlated to the original questions', async () => {
  const created = createAskRequest({
    convId: 'c-1',
    questions: [{ question: 'Pick a color', options: ['red', 'blue'] }, { question: 'Pick a size' }],
  });
  const result = answerAskRequest(created.id, [{ answer: 'blue' }, { answer: 'large' }]);
  assert.equal(result.ok, true);
  assert.equal(result.convId, 'c-1');
  assert.deepEqual(result.answers, [
    { question: 'Pick a color', answer: 'blue' },
    { question: 'Pick a size', answer: 'large' },
  ]);

  const outcome = await created.promise;
  assert.deepEqual(outcome, { timed_out: false, answers: result.answers });
  assert.equal(getAskMeta(created.id).status, 'answered');
});

test('TIMEOUT: an unanswered ask resolves honestly with timed_out:true once the injected timeout elapses, never a fabricated answer', async () => {
  _setAskTimeoutMsForTests(50);
  const created = createAskRequest({ convId: 'c-1', questions: [{ question: 'Will anyone answer?' }] });
  const outcome = await created.promise;
  assert.deepEqual(outcome, { timed_out: true });
  assert.equal(getAskMeta(created.id).status, 'timed_out');
});

test('TIMEOUT: once timed out, a late real answer attempt is rejected (409) — the promise already settled and must never resolve twice', async () => {
  _setAskTimeoutMsForTests(50);
  const created = createAskRequest({ convId: 'c-1', questions: [{ question: 'Late answer?' }] });
  await created.promise; // let the timeout actually fire
  const late = answerAskRequest(created.id, [{ answer: 'too late' }]);
  assert.equal(late.ok, false);
  assert.equal(late.status, 409);
  assert.match(late.error, /already timed_out/);
});

test('answerAskRequest on an unknown ask id is a real 404, never a crash', () => {
  const result = answerAskRequest('ask-does-not-exist', [{ answer: 'x' }]);
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('answerAskRequest cannot answer the same ask twice (409 on the second attempt)', () => {
  const created = createAskRequest({ convId: 'c-1', questions: [{ question: 'Once only' }] });
  const first = answerAskRequest(created.id, [{ answer: 'first' }]);
  assert.equal(first.ok, true);
  const second = answerAskRequest(created.id, [{ answer: 'second' }]);
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.match(second.error, /already answered/);
});

test('VALIDATION: answerAskRequest rejects an answers array with the wrong length (must be exactly one per question)', () => {
  const created = createAskRequest({ convId: 'c-1', questions: [{ question: 'Q1' }, { question: 'Q2' }] });
  const tooFew = answerAskRequest(created.id, [{ answer: 'only one' }]);
  assert.equal(tooFew.ok, false);
  assert.equal(tooFew.status, 400);
  assert.match(tooFew.error, /exactly 2/);
});

test('VALIDATION: answerAskRequest rejects a non-array, and an entry missing a non-empty string "answer"', () => {
  const created = createAskRequest({ convId: 'c-1', questions: [{ question: 'Q1' }] });
  assert.equal(answerAskRequest(created.id, 'not-an-array').status, 400);
  assert.equal(answerAskRequest(created.id, [{}]).status, 400);
  assert.equal(answerAskRequest(created.id, [{ answer: '' }]).status, 400);
  assert.equal(answerAskRequest(created.id, [{ answer: '   ' }]).status, 400);
  assert.equal(answerAskRequest(created.id, [{ answer: 42 }]).status, 400);
});

test('PLAFOND: createAskRequest rejects a call with more than MAX_QUESTIONS_PER_ASK questions, with an honest error, never silently truncating', () => {
  assert.equal(MAX_QUESTIONS_PER_ASK, 25);
  const tooMany = Array.from({ length: MAX_QUESTIONS_PER_ASK + 1 }, (_, i) => ({ question: 'Q' + i }));
  const created = createAskRequest({ convId: 'c-1', questions: tooMany });
  assert.equal(created.ok, false);
  assert.match(created.error, /too many questions/);
  assert.equal(_pendingAskCountForTests(), 0, 'a rejected ask must never be registered as pending');
});

test('PLAFOND: exactly MAX_QUESTIONS_PER_ASK questions is accepted (the boundary itself is not rejected)', () => {
  const exactly = Array.from({ length: MAX_QUESTIONS_PER_ASK }, (_, i) => ({ question: 'Q' + i }));
  const created = createAskRequest({ convId: 'c-1', questions: exactly });
  assert.equal(created.ok, true);
  assert.equal(created.questions.length, MAX_QUESTIONS_PER_ASK);
});

test('VALIDATION: createAskRequest rejects an empty questions array, a non-array, and a question with no "question" text', () => {
  assert.equal(createAskRequest({ convId: 'c-1', questions: [] }).ok, false);
  assert.equal(createAskRequest({ convId: 'c-1', questions: 'nope' }).ok, false);
  assert.equal(createAskRequest({ convId: 'c-1', questions: [{ header: 'no question field' }] }).ok, false);
  assert.equal(createAskRequest({ convId: 'c-1', questions: [{ question: '   ' }] }).ok, false, 'whitespace-only question text is not a real question');
});

test('VALIDATION: createAskRequest rejects "options" that is not an array of strings', () => {
  const created = createAskRequest({ convId: 'c-1', questions: [{ question: 'Q', options: [1, 2, 3] }] });
  assert.equal(created.ok, false);
  assert.match(created.error, /options/);
});

test('multiSelect is read verbatim as a real boolean, default false when omitted', () => {
  const created = createAskRequest({
    convId: 'c-1',
    questions: [{ question: 'Pick some', options: ['a', 'b'], multiSelect: true }, { question: 'Pick one', options: ['c'] }],
  });
  assert.equal(created.questions[0].multiSelect, true);
  assert.equal(created.questions[1].multiSelect, false);
});

test('getAskMeta returns null for an unknown id, and the real status for a known one', () => {
  assert.equal(getAskMeta('ask-nope'), null);
  const created = createAskRequest({ convId: 'c-1', questions: [{ question: 'Q' }] });
  assert.equal(getAskMeta(created.id).status, 'pending');
});

// fix-ghost-asks (forge-2026-07-30-cc-finish, work package fix-ghost-asks, item 1):
// abandonPendingAsksForConversation — the real fix for the diagnosis's own root cause
// ("stopExecution() ... never touches the ask registry").

test('ABANDON: resolves a genuinely pending ask with {abandoned:true, reason}, marks it abandoned, and returns its id/turnId/requestId for the caller to log', async () => {
  const created = createAskRequest({ convId: 'c-1', turnId: 't-1', requestId: 'req-1', questions: [{ question: 'Q' }] });
  const result = abandonPendingAsksForConversation('c-1', 'execution_stopped');
  assert.deepEqual(result, [{ id: created.id, turnId: 't-1', requestId: 'req-1' }]);

  const outcome = await created.promise;
  assert.deepEqual(outcome, { abandoned: true, reason: 'execution_stopped' });
  assert.equal(getAskMeta(created.id).status, 'abandoned');
});

test('ABANDON: never touches a pending ask that belongs to a DIFFERENT conversation', async () => {
  const created = createAskRequest({ convId: 'c-other', questions: [{ question: 'Q' }] });
  const result = abandonPendingAsksForConversation('c-1', 'execution_stopped');
  assert.deepEqual(result, []);
  assert.equal(getAskMeta(created.id).status, 'pending');

  // Still answerable normally afterward — proof it was truly untouched.
  const answered = answerAskRequest(created.id, [{ answer: 'x' }]);
  assert.equal(answered.ok, true);
});

test('ABANDON: a conversation with NO pending ask at all returns an empty array, never throws', () => {
  assert.deepEqual(abandonPendingAsksForConversation('c-nothing-pending', 'execution_closed'), []);
});

test('ABANDON: an already-resolved ask (answered or timed out) is left alone — calling abandon afterward is an honest no-op, never a double-resolve', async () => {
  const answeredAsk = createAskRequest({ convId: 'c-1', questions: [{ question: 'Q1' }] });
  answerAskRequest(answeredAsk.id, [{ answer: 'yes' }]);

  _setAskTimeoutMsForTests(30);
  const timedOutAsk = createAskRequest({ convId: 'c-1', questions: [{ question: 'Q2' }] });
  await timedOutAsk.promise; // let the real timeout fire

  const result = abandonPendingAsksForConversation('c-1', 'execution_closed');
  assert.deepEqual(result, [], 'neither the answered nor the timed-out ask is still pending — nothing to abandon');
  assert.equal(getAskMeta(answeredAsk.id).status, 'answered');
  assert.equal(getAskMeta(timedOutAsk.id).status, 'timed_out');
});

test('IDEMPOTENCE: calling abandonPendingAsksForConversation TWICE for the same conversation only ever abandons what is genuinely still pending — never re-resolves an already-abandoned ask', async () => {
  const created = createAskRequest({ convId: 'c-1', questions: [{ question: 'Q' }] });
  const first = abandonPendingAsksForConversation('c-1', 'execution_stopped');
  assert.equal(first.length, 1);
  await created.promise; // settle it for real before the second call

  const second = abandonPendingAsksForConversation('c-1', 'execution_stopped');
  assert.deepEqual(second, [], 'a second call must never re-abandon (and never re-resolve the promise of) the same ask');
});

test('ABANDON: with MULTIPLE genuinely pending asks for the same conversation, every one is abandoned (a conversation only ever has one execution, but this proves the sweep is not artificially limited to one)', async () => {
  const first = createAskRequest({ convId: 'c-1', questions: [{ question: 'Q1' }] });
  const second = createAskRequest({ convId: 'c-1', questions: [{ question: 'Q2' }] });
  const result = abandonPendingAsksForConversation('c-1', 'execution_timed_out');
  assert.equal(result.length, 2);
  assert.deepEqual(new Set(result.map((r) => r.id)), new Set([first.id, second.id]));
  assert.deepEqual(await first.promise, { abandoned: true, reason: 'execution_timed_out' });
  assert.deepEqual(await second.promise, { abandoned: true, reason: 'execution_timed_out' });
});

/* feat-ask-recommended (owner: "ook willen we advies hebben bij intake vragen wat recommended
 * zijn!"): an optional per-question recommendation, kept ONLY when it exactly matches one of the
 * question's own options — a recommendation pointing at nothing is dropped, never rendered as a
 * floating claim. Absent stays null; nothing is ever invented. */
test('recommended: kept when it exactly matches an option (after the same trim options get)', () => {
  const created = createAskRequest({
    convId: 'c-1',
    questions: [{ question: 'Welke route?', options: ['PWA', 'Native'], recommended: ' PWA ' }],
  });
  assert.equal(created.ok, true);
  assert.equal(created.questions[0].recommended, 'PWA');
  answerAskRequest(created.id, [{ answer: 'PWA' }]);
});

test('recommended: dropped (null) when it matches no option, and null when absent — never invented', () => {
  const created = createAskRequest({
    convId: 'c-1',
    questions: [
      { question: 'A?', options: ['x', 'y'], recommended: 'z' },
      { question: 'B?', options: ['p'] },
    ],
  });
  assert.equal(created.ok, true);
  assert.equal(created.questions[0].recommended, null);
  assert.equal(created.questions[1].recommended, null);
  answerAskRequest(created.id, [{ answer: 'x' }, { answer: 'p' }]);
});
