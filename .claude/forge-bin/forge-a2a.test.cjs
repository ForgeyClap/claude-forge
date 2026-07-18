#!/usr/bin/env node
'use strict';
// forge-a2a.test.cjs — tests the A2A client edge helpers (2026-07-11).
const assert = require('assert');
const a2a = require('./forge-a2a.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge A2A client tests');

t('parseAgentCard accepts a valid card + normalizes skills', () => { const c = a2a.parseAgentCard({ name: 'DataAnalyst', url: 'https://x', capabilities: { streaming: true }, skills: [{ id: 'sql', name: 'SQL' }] }); assert.ok(c.name === 'DataAnalyst' && c.streaming === true && c.skills[0].id === 'sql'); });
t('parseAgentCard rejects a card missing name/url', () => { assert.throws(() => a2a.parseAgentCard({ description: 'x' })); });
t('buildMessageSend produces a valid A2A JSON-RPC message/send', () => { const r = a2a.buildMessageSend('hello', 'm1'); assert.ok(r.jsonrpc === '2.0' && r.method === 'message/send' && r.params.message.parts[0].text === 'hello'); });
t('mapTaskToEvents: submitted -> subagent_started', () => assert.strictEqual(a2a.mapTaskToEvents({ id: 't', status: { state: 'submitted' } }, 'ext')[0].event_type, 'subagent_started'));
t('mapTaskToEvents: completed -> subagent_completed', () => assert.strictEqual(a2a.mapTaskToEvents({ id: 't', status: { state: 'completed' } }, 'ext')[0].event_type, 'subagent_completed'));
t('mapTaskToEvents: failed -> subagent_failed', () => assert.strictEqual(a2a.mapTaskToEvents({ id: 't', status: { state: 'failed' } }, 'ext')[0].event_type, 'subagent_failed'));
t('mapTaskToEvents logs under Integration Boss (real Boss name)', () => assert.strictEqual(a2a.mapTaskToEvents({ status: { state: 'working' } }, 'ext')[0].agent, 'Integration Boss'));
t('buildForgeAgentCard yields ONE card with skills (not 12 Boss cards)', () => { const c = a2a.buildForgeAgentCard('http://x', '2.0.0'); assert.ok(c.name === 'Forge' && Array.isArray(c.skills) && c.skills.length >= 1); });
t('sign + verify AgentCard round-trips; wrong secret fails', () => { const c = a2a.buildForgeAgentCard(); const env = a2a.signAgentCard(c, 's3cret'); assert.ok(a2a.verifyAgentCard(env, 's3cret') === true && a2a.verifyAgentCard(env, 'wrong') === false); });

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
