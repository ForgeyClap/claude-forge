import path from 'node:path';
import { JsonStore } from './store.js';
import { newId, sha256 } from './ids.js';

// Final-report dispatcher volgens plan §10: idempotency-key over
// project+missie+rapport+hash+thread, state persisten VÓÓR de send zodat een
// crash mid-send na herstart nooit blind opnieuw verstuurt (UNCERTAIN i.p.v.
// dubbel), en dead-letter na maxAttempts.
export class Outbox {
  constructor({ stateDir, audit, transport, maxAttempts = 5, now = Date.now }) {
    this.store = new JsonStore(path.join(stateDir, 'deliveries.json'));
    this.audit = audit;
    this.transport = transport;
    this.maxAttempts = maxAttempts;
    this.now = now;
    const data = this.store.load({ deliveries: [] });
    this.deliveries = data.deliveries;
    for (const d of this.deliveries) {
      if (d.state === 'SENDING') {
        d.state = 'UNCERTAIN';
        this.audit?.record('delivery_uncertain_after_restart', { deliveryId: d.id, key: d.key });
      }
    }
    this.#persist();
  }

  #persist() {
    this.store.save({ deliveries: this.deliveries });
  }

  static idempotencyKey({ projectId, missionId, reportId, reportHash, threadId }) {
    return sha256([projectId, missionId, reportId, reportHash, threadId].join('|'));
  }

  async dispatchFinalReport(report) {
    const key = Outbox.idempotencyKey(report);
    let delivery = this.deliveries.find((d) => d.key === key);
    if (delivery && ['DELIVERED', 'SENDING', 'UNCERTAIN'].includes(delivery.state)) {
      this.audit?.record('duplicate_report_suppressed', { key, state: delivery.state });
      return { duplicate: true, delivery };
    }
    if (!delivery) {
      delivery = {
        id: newId('dlv'),
        key,
        projectId: report.projectId,
        missionId: report.missionId,
        reportId: report.reportId,
        reportHash: report.reportHash,
        threadId: report.threadId,
        payload: {
          summary: report.summary,
          // .txt: op mobiel wél in te zien, .md niet (owner-eis 2026-07-30).
          reportText: report.reportText ?? report.reportMarkdown,
          dashboardLink: report.dashboardLink ?? null,
        },
        attempts: 0,
        state: 'PENDING',
        messageIds: [],
        error: null,
        createdAt: this.now(),
      };
      this.deliveries.push(delivery);
      this.#persist();
    }
    return this.#attempt(delivery);
  }

  async #attempt(delivery) {
    delivery.state = 'SENDING';
    delivery.attempts += 1;
    this.#persist();
    try {
      const { summary, dashboardLink } = delivery.payload;
      const reportText = delivery.payload.reportText ?? delivery.payload.reportMarkdown ?? '';
      const content = dashboardLink ? `${summary}\n${dashboardLink}` : summary;
      const files = [{ name: `rapport-${delivery.reportId}.txt`, content: reportText }];
      const res = await this.transport.send(delivery.threadId, content, files);
      delivery.state = 'DELIVERED';
      delivery.messageIds.push(res.messageId);
      delivery.deliveredAt = this.now();
      this.#persist();
      this.audit?.record('final_report_delivered', {
        deliveryId: delivery.id,
        key: delivery.key,
        messageId: res.messageId,
      });
      return { duplicate: false, delivery };
    } catch (err) {
      delivery.error = String(err?.message ?? err);
      delivery.state = delivery.attempts >= this.maxAttempts ? 'DEAD_LETTER' : 'FAILED_RETRYABLE';
      this.#persist();
      this.audit?.record('final_report_delivery_failed', {
        deliveryId: delivery.id,
        attempts: delivery.attempts,
        state: delivery.state,
        error: delivery.error,
      });
      return { duplicate: false, delivery };
    }
  }

  // Expliciete owner/health-actie: her-verstuur een mislukte of onzekere levering.
  async resend(deliveryId) {
    const delivery = this.deliveries.find((d) => d.id === deliveryId);
    if (!delivery || !['FAILED_RETRYABLE', 'DEAD_LETTER', 'UNCERTAIN'].includes(delivery.state)) {
      return null;
    }
    this.audit?.record('delivery_resend_requested', { deliveryId, fromState: delivery.state });
    return this.#attempt(delivery);
  }

  list() {
    return [...this.deliveries];
  }
}
