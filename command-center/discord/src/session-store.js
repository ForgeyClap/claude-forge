import path from 'node:path';
import { JsonStore } from './store.js';

// conversationId → Claude session-ID (plan §1: thread-ID → Claude session-ID).
// Hierdoor heeft elk kanaal/thread een doorlopend gesprek met geheugen.
export class SessionStore {
  constructor(stateDir) {
    this.store = new JsonStore(path.join(stateDir, 'sessions.json'));
    this.data = this.store.load({ sessions: {} });
  }

  get(conversationId) {
    return this.data.sessions[conversationId] ?? null;
  }

  set(conversationId, sessionId) {
    if (!conversationId || !sessionId) return;
    this.data.sessions[conversationId] = sessionId;
    this.store.save(this.data);
  }

  clear(conversationId) {
    delete this.data.sessions[conversationId];
    this.store.save(this.data);
  }
}
