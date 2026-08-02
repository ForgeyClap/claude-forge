// Permission gateway volgens plan §8: alleen berichten van de owner-allowlist
// in geregistreerde kanalen; eigen bot, andere bots en webhooks worden genegeerd.
export class PermissionGateway {
  // botUserId komt als FUNCTIE binnen (of als waarde): bij Discord is het ID pas
  // bekend ná login, dus een eenmalige kopie zou altijd null blijven.
  constructor({ ownerUserIds = [], botUserId, audit }) {
    this.ownerUserIds = ownerUserIds;
    this.getBotUserId = typeof botUserId === 'function' ? botUserId : () => botUserId;
    this.audit = audit;
  }

  #deny(msg, reason) {
    this.audit?.record('message_rejected', {
      reason,
      messageId: msg.messageId,
      senderId: msg.senderId,
      threadId: msg.threadId,
    });
    return { allowed: false, reason };
  }

  check(msg) {
    const botUserId = this.getBotUserId();
    if (botUserId && msg.senderId === botUserId) return this.#deny(msg, 'own_message');
    if (msg.isBot) return this.#deny(msg, 'bot_sender');
    if (msg.isWebhook) return this.#deny(msg, 'webhook_sender');
    if (!this.ownerUserIds.includes(msg.senderId)) return this.#deny(msg, 'unauthorized_user');
    return { allowed: true };
  }
}
