import { newId } from './ids.js';

// Concurrency-controller volgens plan §6: max één actieve run per thread, FIFO
// (met priority-override voor interrupts), globale limiet, en echte cancellation
// via AbortSignal zodat een gestopte run een checkpoint kan achterlaten.
export class Scheduler {
  constructor({
    queue,
    audit,
    runner,
    maxGlobalActiveRuns = 2,
    onComplete,
    onError,
    onStart,
    onSettle,
    onCancel,
    isPaused = null,
  }) {
    this.queue = queue;
    this.audit = audit;
    this.runner = runner;
    this.maxGlobalActiveRuns = maxGlobalActiveRuns;
    this.onComplete = onComplete;
    this.onError = onError;
    this.onStart = onStart;
    this.onSettle = onSettle;
    this.onCancel = onCancel;
    this.isPaused = isPaused;
    this.activeRuns = new Map(); // threadId -> { itemId, runId, controller, promise }
    this.stopped = false;
  }

  // Graceful shutdown: geen nieuwe runs meer starten en alle actieve runs
  // afbreken (checkpoint via AbortSignal). Queue-items blijven durable staan.
  shutdown() {
    this.stopped = true;
    for (const entry of this.activeRuns.values()) entry.controller.abort();
  }

  tick() {
    if (this.stopped) return [];
    // Usage-guard: bij een bereikte limiet géén nieuwe runs starten. Wachtende
    // items blijven staan en gaan automatisch door zodra er ruimte is.
    if (this.isPaused?.()) return [];
    const started = [];
    for (const threadId of this.queue.threadsWithWork()) {
      if (this.activeRuns.size >= this.maxGlobalActiveRuns) break;
      if (this.activeRuns.has(threadId)) continue;
      if (this.queue.activeRunFor(threadId)) continue;
      const item = this.queue.nextForThread(threadId);
      if (item) started.push(this.#start(item));
    }
    return started;
  }

  #start(item) {
    const controller = new AbortController();
    const runId = newId('run');
    this.queue.markStarting(item.id);
    this.queue.markRunning(item.id, runId);
    this.audit?.record('run_started', { itemId: item.id, runId, threadId: item.threadId });

    const promise = Promise.resolve()
      .then(() => this.runner({ item, signal: controller.signal }))
      .then((result) => {
        this.queue.markCompleted(item.id);
        this.audit?.record('run_completed', { itemId: item.id, runId });
        // Aflevering is GEEN onderdeel van de run: een Discord-fout bij het
        // versturen mag een geslaagde run nooit terugzetten naar FAILED (en dus
        // niet opnieuw uitvoerbaar maken).
        return Promise.resolve(this.onComplete?.(item, result)).catch((err) =>
          this.audit?.record('delivery_failed', {
            itemId: item.id,
            runId,
            error: String(err?.message ?? err),
          }),
        );
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          if (this.stopped) {
            // Afgebroken door shutdown → terug in de wachtrij; hervat na herstart.
            this.queue.restoreQueued(item.id);
            this.audit?.record('run_requeued_on_shutdown', { itemId: item.id, runId });
          } else {
            this.queue.markCancelled(item.id, { checkpoint: err?.checkpoint ?? null });
            this.audit?.record('run_cancelled', { itemId: item.id, runId });
            return this.onCancel?.(item);
          }
        } else {
          this.queue.markFailed(item.id, err?.message ?? err);
          this.audit?.record('run_failed', { itemId: item.id, runId, error: String(err?.message ?? err) });
          return this.onError?.(item, err);
        }
      })
      .finally(() => {
        this.activeRuns.delete(item.threadId);
        try {
          this.onSettle?.(item);
        } catch {
          // presentatie-hook mag afhandeling nooit blokkeren
        }
        this.tick();
      });

    const entry = { itemId: item.id, runId, controller, promise };
    this.activeRuns.set(item.threadId, entry);
    // Ná registratie in activeRuns, zodat hooks een correcte activeCount() zien.
    try {
      this.onStart?.(item);
    } catch {
      // presentatie-hook mag een run nooit laten falen
    }
    return entry;
  }

  stop(threadId) {
    const entry = this.activeRuns.get(threadId);
    if (!entry) return false;
    this.audit?.record('stop_requested', { threadId, itemId: entry.itemId });
    entry.controller.abort();
    return true;
  }

  // Interrupt = stop huidige run; de eerstvolgende tick pakt het item met de
  // hoogste priority (owner zet priority>0 op de correctie-prompt).
  interrupt(threadId) {
    const stopped = this.stop(threadId);
    this.audit?.record('interrupt_requested', { threadId, stoppedActiveRun: stopped });
    return stopped;
  }

  activeCount() {
    return this.activeRuns.size;
  }

  async whenIdle() {
    while (this.activeRuns.size > 0) {
      await Promise.allSettled([...this.activeRuns.values()].map((e) => e.promise));
    }
  }
}
