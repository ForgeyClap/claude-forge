// GET /api/approvals source: this project has no "pending approval" concept to browse — its real
// equivalent is the hard-gates model (`.claude/config/orchestration/hard-gates.json`'s gate
// definitions) plus whatever gate-related events a run's own events.jsonl actually recorded. This
// endpoint reports both, honestly. It never invents a pending approval that does not exist — an
// empty `evaluations` array for a run that recorded no gate event is the correct, honest answer.
//
// `readEvents` is imported (read-only use) from events.mjs, which this work package's write scope
// forbids editing — importing its existing export is not an edit.
import fs from 'node:fs';
import path from 'node:path';
import { anyContainmentOk, safeIdOk } from './security.mjs';
import { SYNC_SCAN_ROOTS } from './paths.mjs';
import { readEvents } from './events.mjs';

// The real event_type vocabulary a gate check can emit, per this project's own governance
// (FORGE_HARD_RULES / orchestration events) — matched literally, never guessed from a substring.
const GATE_EVENT_TYPES = new Set(['gate_evaluated', 'quality_gate_passed', 'quality_gate_blocked']);

function readGateDefinitions(projectPath) {
  const gatesPath = path.join(projectPath, '.claude', 'config', 'orchestration', 'hard-gates.json');
  let raw;
  try {
    raw = fs.readFileSync(gatesPath, 'utf8');
  } catch {
    return { gates: [], provenance: 'NOT CONFIGURED' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { gates: [], provenance: 'UNVERIFIED' };
  }
  const gates = Array.isArray(parsed.gates)
    ? parsed.gates.map((g) => ({
        id: typeof g.id === 'string' ? g.id : null,
        class: typeof g.class === 'string' ? g.class : null,
        reason: typeof g.reason === 'string' ? g.reason : null,
      }))
    : [];
  return { gates, provenance: 'LIVE' };
}

export function buildApprovals(projectPath, runId) {
  if (!anyContainmentOk(SYNC_SCAN_ROOTS, projectPath)) {
    return { ok: false, error: 'project path outside allowed scan root' };
  }
  const capturedAt = new Date();

  const { gates, provenance: gatesProvenance } = readGateDefinitions(projectPath);

  let evaluations = [];
  let evaluationsProvenance = 'NOT REQUESTED'; // no ?run= given — honest, distinct from "checked, found none"
  if (runId !== null && runId !== '') {
    if (!safeIdOk(runId)) return { ok: false, error: 'invalid run id' };
    const eventsResult = readEvents(projectPath, runId, 0);
    if (eventsResult.ok) {
      evaluations = eventsResult.events
        .filter((ev) => ev && typeof ev.event_type === 'string' && GATE_EVENT_TYPES.has(ev.event_type))
        .map((ev) => ({
          event_type: ev.event_type,
          gate_id: typeof ev.gate_id === 'string' ? ev.gate_id : typeof ev.gate === 'string' ? ev.gate : null,
          agent: typeof ev.agent === 'string' ? ev.agent : null,
          role: typeof ev.role === 'string' ? ev.role : null,
          owner_confirmed: typeof ev.owner_confirmed === 'boolean' ? ev.owner_confirmed : null,
          reason: typeof ev.reason === 'string' ? ev.reason : null,
          timestamp: typeof ev.timestamp === 'string' ? ev.timestamp : null,
        }));
      evaluationsProvenance = 'LIVE';
    } else {
      evaluationsProvenance = 'UNAVAILABLE';
    }
  }

  return {
    ok: true,
    gates,
    gates_count: gates.length,
    gates_provenance: gatesProvenance,
    evaluations,
    evaluations_count: evaluations.length,
    evaluations_provenance: evaluationsProvenance,
    captured_at: capturedAt.toISOString(),
    age_ms: 0,
  };
}
