// Forge Command Center gateway — forge-ask pending-question registry (feat-ask-owner,
// forge-2026-07-30-cc-finish).
//
// In-memory only, scoped to THIS gateway process's lifetime — mirrors exec-lifecycle.mjs's own
// `running` Map convention exactly (no persistence needed: a pending ask only makes sense while
// the spawned `claude` child that opened it is genuinely still waiting on a real answer).
//
// PROCESS BOUNDARY: the MCP subprocess `ask-mcp.mjs` is spawned by the `claude` CLI itself (via
// the per-execution --mcp-config file `exec-argv.mjs` writes) — it is a SEPARATE OS process and
// cannot see this module's Map directly. It reaches this registry only through the gateway's own
// HTTP routes (`server.mjs`): `POST /api/ask` calls `createAskRequest()` and then AWAITS the
// returned promise (this is the real "block until the owner answers" mechanism — an ordinary async
// HTTP handler simply does not send a response until the promise settles); `POST
// /api/ask/:id/answer` (the owner's real dashboard submission) calls `answerAskRequest()`, which
// resolves that same promise. A timeout timer resolves it honestly with `{timed_out:true}` if
// neither happens in time — never a fabricated answer.
import crypto from 'node:crypto';

// "geen bovengrens die de owner hindert... wel een verstandig plafond tegen doorslaan" (work
// package's own words) — 25 questions per single ask() call, matching the WP's own suggested cap.
export const MAX_QUESTIONS_PER_ASK = 25;

// Mirrors exec-lifecycle.mjs's own DEFAULT_EXEC_TIMEOUT_MS (30 minutes) — a genuinely generous
// window for a human owner to notice and answer, while still eventually giving the waiting
// `claude` session an honest "the owner did not answer" text instead of hanging forever.
const DEFAULT_ASK_TIMEOUT_MS = 30 * 60 * 1000;
let askTimeoutMsOverride = null; // test-only, set via _setAskTimeoutMsForTests()

function resolveAskTimeoutMs() {
  return askTimeoutMsOverride !== null ? askTimeoutMsOverride : DEFAULT_ASK_TIMEOUT_MS;
}

/** Test-only: injects a short wall-clock timeout so `node --test` can exercise the real timeout
 *  path without waiting the real 30-minute default. Pass null to restore the default. */
export function _setAskTimeoutMsForTests(ms) {
  askTimeoutMsOverride = ms;
}

function generateAskId(now = Date.now()) {
  return 'ask-' + now.toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function normalizeQuestion(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'question #' + (index + 1) + ' must be an object' };
  }
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (question.length === 0) {
    return { ok: false, error: 'question #' + (index + 1) + ' is missing a non-empty "question" string' };
  }
  const header = typeof raw.header === 'string' && raw.header.trim().length > 0 ? raw.header.trim() : null;
  let options = [];
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options) || !raw.options.every((o) => typeof o === 'string')) {
      return { ok: false, error: 'question #' + (index + 1) + ' "options" must be an array of strings' };
    }
    options = raw.options.map((o) => o.trim()).filter((o) => o.length > 0);
  }
  const multiSelect = raw.multiSelect === true;
  /* feat-ask-recommended (owner: "ook willen we advies hebben bij intake vragen wat recommended
   * zijn!"): an optional per-question recommendation — the EXACT text of one of the options. Kept
   * only when it genuinely matches an option after the same trim the options themselves get; a
   * recommendation pointing at nothing is silently dropped rather than rendered as a floating
   * claim (the question itself still stands). Never invented here: absent stays null. */
  let recommended = null;
  if (typeof raw.recommended === 'string') {
    const trimmed = raw.recommended.trim();
    if (trimmed.length > 0 && options.includes(trimmed)) recommended = trimmed;
  }
  return { ok: true, value: { header, question, options, multiSelect, recommended } };
}

function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { ok: false, error: 'questions must be a non-empty array' };
  }
  if (rawQuestions.length > MAX_QUESTIONS_PER_ASK) {
    return {
      ok: false,
      error: 'too many questions in one call (max ' + MAX_QUESTIONS_PER_ASK + ', got ' + rawQuestions.length + ') — split into more than one ask',
    };
  }
  const out = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const normalized = normalizeQuestion(rawQuestions[i], i);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    out.push(normalized.value);
  }
  return { ok: true, questions: out };
}

// askId -> { convId, turnId, requestId, questions, status, resolveFn, timer }
const pending = new Map();

/**
 * Registers a new pending ask and starts its timeout timer. Returns
 * `{ ok:true, id, turnId, requestId, questions, timeoutMs, promise }` on success — `promise`
 * resolves to `{ timed_out:false, answers }` (a real owner answer, via `answerAskRequest`) or
 * `{ timed_out:true }` (the honest, never-fabricated timeout outcome) — or `{ ok:false, error }`
 * on an invalid `questions` shape or an over-plafond call. Never throws.
 */
export function createAskRequest({ convId, turnId = null, requestId = null, questions }) {
  const normalized = normalizeQuestions(questions);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  const id = generateAskId();
  const timeoutMs = resolveAskTimeoutMs();
  let resolveFn;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  const entry = { convId, turnId, requestId, questions: normalized.questions, status: 'pending', resolveFn, timer: null };
  entry.timer = setTimeout(() => {
    if (entry.status !== 'pending') return; // already answered right as the timer fired — no-op
    entry.status = 'timed_out';
    entry.resolveFn({ timed_out: true });
  }, timeoutMs);
  // Never let this timer alone keep the gateway process alive (mirrors exec-lifecycle.mjs's own
  // timeoutTimer.unref() convention).
  if (typeof entry.timer.unref === 'function') entry.timer.unref();

  pending.set(id, entry);
  return { ok: true, id, turnId, requestId, questions: normalized.questions, timeoutMs, promise };
}

/**
 * Resolves a pending ask with the owner's REAL answers. `rawAnswers` must be an array with EXACTLY
 * one entry per question this ask registered (position-correlated), each a non-empty string
 * `answer` field — a strict shape check, never a partial or guessed fill-in. Returns
 * `{ ok:true, convId, turnId, requestId, answers }` on success, or `{ ok:false, status, error }`
 * where `status` is the HTTP code the route should send: 404 for an unknown id, 409 for one that
 * already resolved (answered or timed out — it can only ever be answered once), 400 for a
 * malformed answers array.
 */
export function answerAskRequest(id, rawAnswers) {
  const entry = pending.get(id);
  if (!entry) {
    return { ok: false, status: 404, error: 'unknown ask id (it may already have been answered, timed out, or never existed)' };
  }
  if (entry.status !== 'pending') {
    return { ok: false, status: 409, error: 'this ask was already ' + entry.status + ' — it can only be answered once' };
  }
  if (!Array.isArray(rawAnswers) || rawAnswers.length !== entry.questions.length) {
    const gotLen = Array.isArray(rawAnswers) ? String(rawAnswers.length) : typeof rawAnswers;
    return {
      ok: false,
      status: 400,
      error:
        'answers must be an array with exactly ' +
        entry.questions.length +
        ' entr' +
        (entry.questions.length === 1 ? 'y' : 'ies') +
        ' (one per question, in order) — got ' +
        gotLen,
    };
  }
  const answers = [];
  for (let i = 0; i < rawAnswers.length; i++) {
    const raw = rawAnswers[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.answer !== 'string' || raw.answer.trim().length === 0) {
      return { ok: false, status: 400, error: 'answer #' + (i + 1) + ' must be an object with a non-empty string "answer" field' };
    }
    answers.push({ question: entry.questions[i].question, answer: raw.answer.trim() });
  }

  entry.status = 'answered';
  clearTimeout(entry.timer);
  entry.resolveFn({ timed_out: false, answers });
  return { ok: true, convId: entry.convId, turnId: entry.turnId, requestId: entry.requestId, answers };
}

/**
 * fix-ghost-asks (forge-2026-07-30-cc-finish, work package fix-ghost-asks): ends every PENDING ask
 * still tracked for `convId` as a real execution outcome — stopped, closed, errored, or reaped by
 * the wall-clock timeout — rather than a real owner answer. Called from exec-lifecycle.mjs's four
 * real execution-end sites (see that file's own `abandonPendingAsk()` helper), never from here on
 * its own. Resolves each matching entry's blocked `/api/ask` promise with `{ abandoned:true,
 * reason }` — the same honest, never-fabricated shape the timeout path uses one field over — and
 * returns `{ id, turnId, requestId }` for each one so the CALLER can append its own real
 * `ask_abandoned` conversation event. This module deliberately never imports conversations.mjs
 * itself (see the PROCESS BOUNDARY note at the top of this file for why the registry stays
 * storage-agnostic) — that is exactly the gap the diagnosis found in stopExecution() before this
 * fix ("it does not even import [ask-store.mjs]").
 *
 * Idempotent by construction: the `entry.status !== 'pending'` guard means calling this twice (or
 * calling it after the ask already resolved some other way) only ever abandons what is genuinely
 * STILL pending — an already-answered/timed-out/abandoned entry is skipped, never re-resolved.
 */
export function abandonPendingAsksForConversation(convId, reason) {
  const abandoned = [];
  for (const [id, entry] of pending) {
    if (entry.convId !== convId || entry.status !== 'pending') continue;
    entry.status = 'abandoned';
    clearTimeout(entry.timer);
    entry.resolveFn({ abandoned: true, reason });
    abandoned.push({ id, turnId: entry.turnId, requestId: entry.requestId });
  }
  return abandoned;
}

/**
 * feat-live-visibility (Gap A — a waiting question is invisible outside its own conversation):
 * every ask this gateway process currently has genuinely PENDING — `status === 'pending'` only,
 * the instant an entry answers/times out/is abandoned it drops out of this list, same as every
 * other read in this module. This IS the live, in-memory ground truth a real spawned `claude`
 * child is blocked on right now: it starts EMPTY on every gateway restart, and
 * `ask-boot-scan.mjs` already closes out any stale on-disk `ask_questions` event left over from a
 * PRIOR boot (via its own `ask_abandoned` write) before this process ever accepts a request — so
 * an entry read here can never be a "ghost" ask from a previous session. Never touches disk.
 * One row per pending ask: `{ id, convId, turnId, requestId, questionCount }`.
 */
export function listPendingAskSummaries() {
  const out = [];
  for (const [id, entry] of pending) {
    if (entry.status !== 'pending') continue;
    out.push({ id, convId: entry.convId, turnId: entry.turnId, requestId: entry.requestId, questionCount: entry.questions.length });
  }
  return out;
}

/** Read-only lookup for tests and diagnostics — never mutates. `null` for an unknown id. */
export function getAskMeta(id) {
  const entry = pending.get(id);
  if (!entry) return null;
  return { convId: entry.convId, turnId: entry.turnId, requestId: entry.requestId, questions: entry.questions, status: entry.status };
}

/** Test-only: clears every tracked entry's own timer BEFORE clearing the map (mirrors
 *  exec-lifecycle.mjs's own `_resetExecBridgeForTests` rationale — a bare `.clear()` alone would
 *  leave a still-pending real setTimeout that could fire later, mid an unrelated test). */
export function _resetAskStoreForTests() {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  askTimeoutMsOverride = null;
}

export function _pendingAskCountForTests() {
  return pending.size;
}
