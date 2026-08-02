import path from 'node:path';
import { JsonStore } from './store.js';
import { newId, sha256 } from './ids.js';

// Queue-states volgens plan §5 (forge-discord-plan-claude-review.md).
export const QueueState = Object.freeze({
  RECEIVED: 'RECEIVED',
  VALIDATED: 'VALIDATED',
  WAITING_FOR_PROJECT: 'WAITING_FOR_PROJECT',
  WAITING_FOR_CONFIRMATION: 'WAITING_FOR_CONFIRMATION',
  QUEUED: 'QUEUED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  DEAD_LETTER: 'DEAD_LETTER',
});

const OPEN_STATES = new Set([
  QueueState.WAITING_FOR_CONFIRMATION,
  QueueState.QUEUED,
  QueueState.STARTING,
  QueueState.RUNNING,
]);

// Duurzame ingress-queue: elke mutatie wordt direct gepersisteerd zodat een
// procesherstart nooit prompts verliest (plan §5 OFFLINE-gedrag).
export class IngressQueue {
  constructor({
    stateDir,
    audit,
    now = Date.now,
    expiryMs = 2 * 3600 * 1000,
    maxQueuedPerThread = 10,
    maxAttempts = 3,
  }) {
    this.store = new JsonStore(path.join(stateDir, 'queue.json'));
    this.audit = audit;
    this.now = now;
    this.expiryMs = expiryMs;
    this.maxQueuedPerThread = maxQueuedPerThread;
    this.maxAttempts = maxAttempts;
    const data = this.store.load({ items: [], nextSeq: 1 });
    this.items = data.items;
    this.nextSeq = data.nextSeq;

    // Restart-recovery (plan §12): een run die bij een crash/herstart nog op
    // STARTING/RUNNING stond is dood — terug naar QUEUED, anders blokkeert hij
    // zijn thread voor altijd.
    let recovered = false;
    for (const item of this.items) {
      if (item.state === QueueState.STARTING || item.state === QueueState.RUNNING) {
        item.state = QueueState.QUEUED;
        item.runId = null;
        recovered = true;
        this.audit?.record('run_recovered_after_restart', { itemId: item.id, threadId: item.threadId });
      }
    }
    if (recovered) this.#persist();
  }

  #persist() {
    this.store.save({ items: this.items, nextSeq: this.nextSeq });
  }

  #setState(item, state, extra = {}) {
    const from = item.state;
    item.state = state;
    Object.assign(item, extra);
    this.#persist();
    this.audit?.record('queue_state_changed', {
      itemId: item.id,
      messageId: item.messageId,
      threadId: item.threadId,
      from,
      to: state,
    });
    return item;
  }

  getItem(itemId) {
    return this.items.find((i) => i.id === itemId) ?? null;
  }

  byMessageId(messageId) {
    return this.items.find((i) => i.messageId === messageId) ?? null;
  }

  enqueue(msg) {
    const existing = this.byMessageId(msg.messageId);
    if (existing) {
      this.audit?.record('duplicate_message_ignored', {
        messageId: msg.messageId,
        existingItemId: existing.id,
      });
      return { accepted: false, duplicate: true, item: existing };
    }

    const openInThread = this.items.filter(
      (i) => i.threadId === msg.threadId && OPEN_STATES.has(i.state),
    ).length;
    if (openInThread >= this.maxQueuedPerThread) {
      this.audit?.record('queue_limit_reached', {
        threadId: msg.threadId,
        limit: this.maxQueuedPerThread,
        messageId: msg.messageId,
      });
      return { accepted: false, duplicate: false, reason: 'queue_limit' };
    }

    const receivedAt = msg.receivedAt ?? this.now();
    const stale = this.now() - receivedAt > this.expiryMs;
    const item = {
      id: newId('req'),
      seq: this.nextSeq++,
      messageId: msg.messageId,
      guildId: msg.guildId ?? null,
      channelId: msg.channelId ?? null,
      threadId: msg.threadId,
      senderId: msg.senderId,
      projectId: msg.projectId ?? null,
      conversationId: msg.conversationId ?? null,
      content: msg.content ?? '',
      promptHash: sha256(msg.content ?? ''),
      attachments: msg.attachments ?? [],
      attachmentInfo: msg.attachmentInfo ?? '',
      referencedMessageId: msg.referencedMessageId ?? null,
      priority: msg.priority ?? 0,
      receivedAt,
      enqueuedAt: this.now(),
      state: stale ? QueueState.WAITING_FOR_CONFIRMATION : QueueState.QUEUED,
      attempts: 0,
      error: null,
      runId: null,
    };
    this.items.push(item);
    this.#persist();
    this.audit?.record(stale ? 'stale_prompt_needs_confirmation' : 'message_enqueued', {
      itemId: item.id,
      messageId: item.messageId,
      threadId: item.threadId,
      ageMs: this.now() - receivedAt,
    });
    return { accepted: true, duplicate: false, item };
  }

  confirm(itemId) {
    const item = this.getItem(itemId);
    if (!item || item.state !== QueueState.WAITING_FOR_CONFIRMATION) return null;
    return this.#setState(item, QueueState.QUEUED, { confirmedAt: this.now() });
  }

  // Risicovolle opdracht vasthouden tot de eigenaar op een knop drukt.
  holdForApproval(itemId) {
    const item = this.getItem(itemId);
    if (!item || item.state !== QueueState.QUEUED) return null;
    return this.#setState(item, QueueState.WAITING_FOR_CONFIRMATION, { needsApproval: true });
  }

  remove(itemId) {
    const item = this.getItem(itemId);
    if (!item || !OPEN_STATES.has(item.state)) return null;
    return this.#setState(item, QueueState.CANCELLED, { cancelledReason: 'removed_by_owner' });
  }

  expire(itemId) {
    const item = this.getItem(itemId);
    if (!item || item.state !== QueueState.WAITING_FOR_CONFIRMATION) return null;
    return this.#setState(item, QueueState.EXPIRED);
  }

  nextForThread(threadId) {
    const candidates = this.items
      .filter((i) => i.threadId === threadId && i.state === QueueState.QUEUED)
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    return candidates[0] ?? null;
  }

  threadsWithWork() {
    return [...new Set(
      this.items.filter((i) => i.state === QueueState.QUEUED).map((i) => i.threadId),
    )];
  }

  activeRunFor(threadId) {
    return (
      this.items.find(
        (i) =>
          i.threadId === threadId &&
          (i.state === QueueState.STARTING || i.state === QueueState.RUNNING),
      ) ?? null
    );
  }

  markStarting(itemId) {
    const item = this.getItem(itemId);
    if (!item || item.state !== QueueState.QUEUED) return null;
    return this.#setState(item, QueueState.STARTING);
  }

  markRunning(itemId, runId) {
    const item = this.getItem(itemId);
    if (!item || item.state !== QueueState.STARTING) return null;
    return this.#setState(item, QueueState.RUNNING, { runId, startedAt: this.now() });
  }

  markCompleted(itemId) {
    const item = this.getItem(itemId);
    if (!item) return null;
    return this.#setState(item, QueueState.COMPLETED, { completedAt: this.now() });
  }

  // Een afgeronde run mag nooit meer van status veranderen — anders kan een fout
  // ná de run (bv. bij het versturen) hem opnieuw uitvoerbaar maken.
  #isTerminal(item) {
    return [QueueState.COMPLETED, QueueState.CANCELLED, QueueState.EXPIRED].includes(item.state);
  }

  markCancelled(itemId, { checkpoint = null, reason = 'stopped_by_owner' } = {}) {
    const item = this.getItem(itemId);
    if (!item) return null;
    if (this.#isTerminal(item)) return item;
    return this.#setState(item, QueueState.CANCELLED, {
      checkpoint,
      cancelledReason: reason,
      cancelledAt: this.now(),
    });
  }

  markFailed(itemId, error) {
    const item = this.getItem(itemId);
    if (!item) return null;
    if (this.#isTerminal(item)) {
      this.audit?.record('terminal_state_protected', {
        itemId: item.id,
        state: item.state,
        attempted: 'FAILED',
      });
      return item;
    }
    item.attempts += 1;
    const dead = item.attempts >= this.maxAttempts;
    return this.#setState(item, dead ? QueueState.DEAD_LETTER : QueueState.FAILED, {
      error: String(error),
    });
  }

  // Ook DEAD_LETTER mag opnieuw: anders is een item na 3 mislukkingen vanaf de
  // telefoon onherstelbaar. Attempts worden dan gereset.
  requeue(itemId) {
    const item = this.getItem(itemId);
    if (!item) return null;
    if (item.state === QueueState.FAILED) return this.#setState(item, QueueState.QUEUED);
    if (item.state === QueueState.DEAD_LETTER) {
      return this.#setState(item, QueueState.QUEUED, { attempts: 0, error: null });
    }
    return null;
  }

  // Afgeronde items ouder dan X dagen opruimen, zodat queue.json niet eeuwig groeit.
  prune({ olderThanMs = 7 * 24 * 3600 * 1000, keepMin = 50 } = {}) {
    const cutoff = this.now() - olderThanMs;
    const done = new Set([QueueState.COMPLETED, QueueState.CANCELLED, QueueState.EXPIRED]);
    const before = this.items.length;
    if (before <= keepMin) return 0;
    this.items = this.items.filter(
      (i) => !done.has(i.state) || (i.completedAt ?? i.enqueuedAt ?? 0) > cutoff,
    );
    const removed = before - this.items.length;
    if (removed > 0) {
      this.#persist();
      this.audit?.record('queue_pruned', { removed, remaining: this.items.length });
    }
    return removed;
  }

  // Shutdown-onderbreking: lopende run terug de wachtrij in, zodat hij na een
  // herstart automatisch hervat (i.p.v. CANCELLED te eindigen).
  restoreQueued(itemId) {
    const item = this.getItem(itemId);
    if (!item || (item.state !== QueueState.STARTING && item.state !== QueueState.RUNNING)) return null;
    return this.#setState(item, QueueState.QUEUED, { runId: null });
  }

  depth() {
    const counts = {};
    for (const item of this.items) counts[item.state] = (counts[item.state] ?? 0) + 1;
    return counts;
  }
}
