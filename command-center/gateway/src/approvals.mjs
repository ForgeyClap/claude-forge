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
// Codex run B F-12: the DYNAMIC admitted-roots boundary — see admitted-roots.mjs's own header.
import { getContainmentRoots } from './admitted-roots.mjs';
import { readEvents } from './events.mjs';

// The real event_type vocabulary a gate check can emit, per this project's own governance
// (FORGE_HARD_RULES / orchestration events) — matched literally, never guessed from a substring.
const GATE_EVENT_TYPES = new Set(['gate_evaluated', 'quality_gate_passed', 'quality_gate_blocked']);

// WP-CC1 (item 8): `integration_gate_passed` is a REAL, separate event type (orchestrator-logged,
// verified live: `{agent:"orchestrator", summary:"... ALL GREEN on the clean source commit ...",
// evidence:".../gate-evidence.json", timestamp}` — no `gate_id`/`role`/`owner_confirmed`/`reason`
// fields at all) — kept OUT of GATE_EVENT_TYPES/`evaluations` above (that array's shape assumes
// those fields) and reported as its own small, honestly-shaped list instead of forcing it into a
// row full of nulls.
const INTEGRATION_GATE_PASSED_TYPE = 'integration_gate_passed';

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
  if (!anyContainmentOk(getContainmentRoots(), projectPath)) {
    return { ok: false, error: 'project path outside allowed scan root' };
  }
  const capturedAt = new Date();

  const { gates, provenance: gatesProvenance } = readGateDefinitions(projectPath);

  let evaluations = [];
  let evaluationsProvenance = 'NOT REQUESTED'; // no ?run= given — honest, distinct from "checked, found none"
  // WP-CC1 (item 8):
  let integrationGatePassedEvents = [];
  let integrationGatePassedProvenance = 'NOT REQUESTED';
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
      integrationGatePassedEvents = eventsResult.events
        .filter((ev) => ev && ev.event_type === INTEGRATION_GATE_PASSED_TYPE)
        .map((ev) => ({
          agent: typeof ev.agent === 'string' ? ev.agent : null,
          summary: typeof ev.summary === 'string' ? ev.summary : null,
          evidence: typeof ev.evidence === 'string' ? ev.evidence : null,
          timestamp: typeof ev.timestamp === 'string' ? ev.timestamp : null,
        }));
      integrationGatePassedProvenance = 'LIVE';
    } else {
      evaluationsProvenance = 'UNAVAILABLE';
      integrationGatePassedProvenance = 'UNAVAILABLE';
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
    // WP-CC1 (item 8): a real, separate count/list — see INTEGRATION_GATE_PASSED_TYPE above for
    // why this is not folded into `evaluations`.
    integration_gate_passed_events: integrationGatePassedEvents,
    integration_gate_passed_count: integrationGatePassedEvents.length,
    integration_gate_passed_provenance: integrationGatePassedProvenance,
    captured_at: capturedAt.toISOString(),
    age_ms: 0,
  };
}
