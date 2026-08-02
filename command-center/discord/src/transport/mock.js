import { EventEmitter } from 'node:events';

// Mock-transport met dezelfde interface als de echte Discord-adapter:
// on('message'), send(), edit(), fetchSince(), disconnect()/reconnect().
// Berichten belanden ALTIJD in de servergeschiedenis (Discord bewaart ze),
// maar worden alleen live ge-emit als de bot verbonden is — daarmee is het
// offline-queue + reconcile-scenario uit plan §5 exact naspeelbaar.
export class MockTransport extends EventEmitter {
  constructor({ botUserId = 'bot_mock' } = {}) {
    super();
    this.botUserId = botUserId;
    this.connected = true;
    this.serverHistory = new Map(); // threadId -> berichten in aankomstvolgorde
    this.sent = [];
    this.edits = [];
    this.failNextSend = 0;
    this.seq = 0;
    this.presence = { busy: false, label: null };
    this.presenceLog = [];
    this.typingCalls = [];
  }

  async setBusy(busy, label = null) {
    this.presence = { busy, label };
    this.presenceLog.push({ busy, label });
  }

  async sendTyping(threadId) {
    this.typingCalls.push(threadId);
  }

  #push(threadId, message) {
    if (!this.serverHistory.has(threadId)) this.serverHistory.set(threadId, []);
    this.serverHistory.get(threadId).push(message);
  }

  simulateIncoming({
    threadId,
    channelId,
    senderId,
    content,
    isBot = false,
    isWebhook = false,
    messageId,
    timestamp,
  }) {
    const msg = {
      messageId: messageId ?? `m${++this.seq}`,
      threadId,
      channelId,
      senderId,
      content,
      isBot,
      isWebhook,
      timestamp: timestamp ?? Date.now(),
    };
    this.#push(threadId, msg);
    if (this.connected) this.emit('message', msg);
    return msg;
  }

  async send(threadId, content, files = [], { components = null } = {}) {
    if (this.failNextSend > 0) {
      this.failNextSend -= 1;
      throw new Error('mock send failure');
    }
    const msg = {
      messageId: `bot_m${++this.seq}`,
      threadId,
      senderId: this.botUserId,
      content,
      files,
      components,
      isBot: true,
      timestamp: Date.now(),
    };
    this.#push(threadId, msg);
    this.sent.push({ ...msg }); // kopie: edits mogen het verzendlog niet muteren
    return { messageId: msg.messageId };
  }

  async edit(messageId, content, threadId = null) {
    this.edits.push({ messageId, content, threadId });
    // Alleen de serverkant muteren; `sent` blijft het verzendlog (wat er
    // oorspronkelijk gestuurd is), zodat tests volgorde kunnen controleren.
    for (const msgs of this.serverHistory.values()) {
      const found = msgs.find((m) => m.messageId === messageId);
      if (found) found.content = content;
    }
    return { messageId };
  }

  async setChannelPrefix(channelId, emoji) {
    this.channelPrefixes = this.channelPrefixes ?? [];
    this.channelPrefixes.push({ channelId, emoji });
  }

  async fetchAll(threadId, max = 500) {
    return (this.serverHistory.get(threadId) ?? []).slice(-max);
  }

  async purge(threadId) {
    const count = (this.serverHistory.get(threadId) ?? []).length;
    this.serverHistory.set(threadId, []);
    return count;
  }

  async listThreads(channelId) {
    const out = [];
    for (const [threadId, msgs] of this.serverHistory) {
      if (msgs.some((m) => m.channelId === channelId)) out.push(threadId);
    }
    return out;
  }

  async fetchSince(threadId, afterMessageId) {
    const all = this.serverHistory.get(threadId) ?? [];
    if (!afterMessageId) return [...all];
    const idx = all.findIndex((m) => m.messageId === afterMessageId);
    return idx === -1 ? [...all] : all.slice(idx + 1);
  }

  disconnect() {
    this.connected = false;
    this.emit('disconnected');
  }

  reconnect() {
    this.connected = true;
    this.emit('resumed');
  }
}
