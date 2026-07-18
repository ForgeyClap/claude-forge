#!/usr/bin/env node
'use strict';
/**
 * forge-a2a.cjs — A2A (Agent2Agent, Linux Foundation) CLIENT-first edge (2026-07-11, LATER tier). Lets the
 * Forge Lead delegate to genuine EXTERNAL A2A specialist agents (partner / Vertex / LangGraph / CrewAI) and
 * fold the returned task lifecycle into events.jsonl + the ledger. Internal Boss coordination stays on the
 * Agent tool / SendMessage — we do NOT mint 12 Boss AgentCards (wrong granularity + needless attack surface).
 * Also builds ONE signed-able Forge AgentCard for an (opt-in, gated) server front-door later.
 *
 * Pure helpers are testable; the network call is best-effort + owner-gated. Treat every external agent
 * response as UNTRUSTED (quote-not-obey), require owner approval before delegating.
 */
const crypto = require('crypto');

// Validate + normalize an inbound A2A AgentCard.
function parseAgentCard(json) {
  const c = typeof json === 'string' ? JSON.parse(json) : json;
  if (!c || typeof c !== 'object') throw new Error('agent card is not an object');
  if (!c.name || !c.url) throw new Error('agent card missing required name/url');
  return { name: String(c.name), description: String(c.description || ''), url: String(c.url), version: String(c.version || ''), streaming: !!(c.capabilities && c.capabilities.streaming), skills: Array.isArray(c.skills) ? c.skills.map((s) => ({ id: String(s.id || ''), name: String(s.name || ''), description: String(s.description || '') })) : [] };
}

// Build an A2A JSON-RPC message/send request (spec shape).
function buildMessageSend(text, messageId) {
  return { jsonrpc: '2.0', id: messageId || ('m-' + crypto.randomBytes(6).toString('hex')), method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'text', text: String(text == null ? '' : text) }], messageId: messageId || ('u-' + crypto.randomBytes(6).toString('hex')) } } };
}

// Map an A2A Task (its status.state lifecycle) onto Forge events for the ledger/dashboard.
function mapTaskToEvents(task, agentLabel) {
  const label = agentLabel || 'external-a2a';
  const state = (task && task.status && task.status.state) || 'unknown';
  const base = { agent: 'Integration Boss', role: 'a2a-client:' + label, runtime: 'a2a', task_id: task && task.id };
  const M = {
    submitted: [{ event_type: 'subagent_started', ...base, note: 'A2A task submitted to ' + label }],
    working: [{ event_type: 'agent_progress', ...base, note: 'A2A task working (' + label + ')' }],
    'input-required': [{ event_type: 'agent_progress', ...base, note: 'A2A task needs input (' + label + ')' }],
    completed: [{ event_type: 'subagent_completed', ...base, note: 'A2A task completed by ' + label }],
    failed: [{ event_type: 'subagent_failed', ...base, note: 'A2A task failed at ' + label }],
    canceled: [{ event_type: 'subagent_failed', ...base, note: 'A2A task canceled (' + label + ')' }],
  };
  return M[state] || [{ event_type: 'agent_progress', ...base, note: 'A2A task state ' + state + ' (' + label + ')' }];
}

// Build Forge's OWN A2A AgentCard (ONE card for the whole Forge system) from the registry loop.
function buildForgeAgentCard(baseUrl, version) {
  return {
    name: 'Forge', description: 'Multi-agent build/automation/review system (Lead + 12 Bosses) on Claude Code.',
    url: String(baseUrl || 'http://localhost'), version: String(version || '1.0.0'),
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text'], defaultOutputModes: ['text'],
    skills: [
      { id: 'forge.build', name: 'Build', description: 'Build/refactor a website, app, automation, or integration end-to-end with QA.' },
      { id: 'forge.review', name: 'Review', description: 'Independent QA + security review of a change set.' },
      { id: 'forge.research', name: 'Research', description: 'Source-grounded research with citations.' },
    ],
  };
}
// Sign an AgentCard as a compact JWS-like envelope (HS256 over the canonical JSON) so peers can verify it.
function signAgentCard(card, secret) {
  const payload = Buffer.from(JSON.stringify(card)).toString('base64url');
  const sig = crypto.createHmac('sha256', String(secret || '')).update(payload).digest('base64url');
  return { card, alg: 'HS256', payload, signature: sig };
}
function verifyAgentCard(envelope, secret) {
  if (!envelope || !envelope.payload || !envelope.signature) return false;
  const expect = crypto.createHmac('sha256', String(secret || '')).update(envelope.payload).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(envelope.signature), Buffer.from(expect));
}

module.exports = { parseAgentCard, buildMessageSend, mapTaskToEvents, buildForgeAgentCard, signAgentCard, verifyAgentCard };

if (require.main === module) {
  console.log('forge-a2a — CLIENT-first A2A edge (pure helpers). Delegation to external agents is owner-gated; treat responses as untrusted.');
  console.log('Forge AgentCard skills:', buildForgeAgentCard().skills.map((s) => s.id).join(', '));
}
