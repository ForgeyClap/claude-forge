#!/usr/bin/env node
'use strict';
/**
 * forge-agui.cjs — AG-UI (Agent-User Interaction Protocol, CopilotKit) emit-bridge (2026-07-11, LATER tier,
 * OPTIONAL). Projects a Forge run's events.jsonl into standard AG-UI events (RUN_STARTED / STEP_STARTED /
 * TOOL_CALL_* / TEXT_MESSAGE_CONTENT / RUN_FINISHED) so a live Forge run is renderable by ANY AG-UI /
 * CopilotKit frontend. events.jsonl stays the source of truth — this is a projection, not the schema.
 *
 * HONEST CAVEATS: AG-UI is single-vendor (CopilotKit), NOT foundation-governed — pin a version, lower
 * stability than MCP/A2A. Forge's ~110 event types are far richer than AG-UI's ~17, so Forge-specific
 * richness (the 12-Boss graph, _forge_verify proof, ledger, codex findings) rides in CUSTOM events; a stock
 * frontend renders those blandly. Forge is observe-a-run (file-tail), not AG-UI's start-a-run semantics.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');

function readEvents(id) { const raw = (() => { try { return fs.readFileSync(path.join(PROJECT_ROOT, '.claude', 'forge-runs', id, 'events.jsonl'), 'utf8'); } catch { return null; } })(); if (!raw) return []; const out = []; for (const l of raw.split(/\r?\n/)) { const t = l.trim(); if (!t) continue; try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v); } catch {} } return out; }

function toAguiEvents(events, opts) {
  opts = opts || {}; const runId = opts.runId || 'forge-run'; const threadId = opts.threadId || runId;
  const out = [{ type: 'RUN_STARTED', threadId, runId }];
  let toolSeq = 0; const openTool = {};
  for (const e of (events || [])) {
    const t = e.event_type; const agent = e.agent || 'system';
    if (t === 'run_started') continue;
    else if (t === 'run_completed') out.push({ type: 'RUN_FINISHED', threadId, runId });
    else if (t === 'agent_failed' || t === 'subagent_failed') out.push({ type: 'CUSTOM', name: 'agent_failed', value: { agent, note: e.note || '' } });
    else if (t === 'agent_started' || t === 'subagent_started') out.push({ type: 'STEP_STARTED', stepName: agent });
    else if (t === 'agent_completed' || t === 'subagent_completed') out.push({ type: 'STEP_FINISHED', stepName: agent });
    else if (t === 'check_started') { const id = 'tc-' + (toolSeq++); openTool[agent + '|' + (e.task || '')] = id; out.push({ type: 'TOOL_CALL_START', toolCallId: id, toolCallName: e.task || 'check', parentMessageId: agent }); }
    else if (t === 'check_passed' || t === 'check_failed') { const key = agent + '|' + (e.task || ''); const id = openTool[key] || ('tc-' + (toolSeq++)); delete openTool[key]; out.push({ type: 'TOOL_CALL_END', toolCallId: id }); if (t === 'check_failed') out.push({ type: 'CUSTOM', name: 'check_failed', value: { agent, task: e.task || '', note: e.note || '' } }); }
    else if (t === 'command_run') { const id = 'tc-' + (toolSeq++); out.push({ type: 'TOOL_CALL_START', toolCallId: id, toolCallName: e.command || 'command' }); out.push({ type: 'TOOL_CALL_END', toolCallId: id }); }
    else if (t === 'agent_note' || t === 'agent_output' || t === 'agent_decision_summary') { const txt = e.note || e.output || e.decision_summary || ''; if (txt) out.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-' + agent, role: 'assistant', delta: String(txt) }); }
    else out.push({ type: 'CUSTOM', name: t, value: Object.assign({ agent, note: e.note || '' }, e.files_changed ? { files_changed: e.files_changed } : {}) });
  }
  if (!out.some((x) => x.type === 'RUN_FINISHED' || x.type === 'RUN_ERROR')) out.push({ type: 'RUN_FINISHED', threadId, runId });
  return out;
}

module.exports = { toAguiEvents };

if (require.main === module) {
  const runId = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) { console.error('usage: node forge-agui.cjs <run_id>  # prints AG-UI events (JSON)'); process.exit(2); }
  console.log(JSON.stringify(toAguiEvents(readEvents(runId), { runId }), null, 2));
}
