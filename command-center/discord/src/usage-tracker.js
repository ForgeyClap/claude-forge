import path from 'node:path';
import { JsonlLog } from './store.js';

// Verbruik per run vastleggen (kosten, duur, turns, model) zodat `/forge usage`
// een eerlijk overzicht kan geven. Alleen echte cijfers uit de Claude-JSON-output.
export class UsageTracker {
  constructor({ stateDir, now = () => Date.now() }) {
    this.log = new JsonlLog(path.join(stateDir, 'usage.jsonl'));
    this.now = now;
  }

  record(item, result) {
    if (!result) return null;
    const entry = {
      ts: this.now(),
      itemId: item.id,
      projectId: item.projectId,
      threadId: item.threadId,
      model: result.model ?? null,
      costUsd: result.costUsd ?? null,
      durationMs: result.durationMs ?? null,
      numTurns: result.numTurns ?? null,
      inputTokens: result.usage?.input_tokens ?? null,
      outputTokens: result.usage?.output_tokens ?? null,
      cacheReadTokens: result.usage?.cache_read_input_tokens ?? null,
    };
    this.log.append(entry);
    return entry;
  }

  summary({ sinceMs = 24 * 3600 * 1000, projectId = null } = {}) {
    const cutoff = this.now() - sinceMs;
    const rows = this.log
      .readAll()
      .filter((r) => r.ts >= cutoff && (!projectId || r.projectId === projectId));
    const sum = (key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
    const perProject = {};
    for (const r of rows) {
      perProject[r.projectId] = perProject[r.projectId] ?? { runs: 0, costUsd: 0 };
      perProject[r.projectId].runs += 1;
      perProject[r.projectId].costUsd += Number(r.costUsd) || 0;
    }
    return {
      runs: rows.length,
      costUsd: Number(sum('costUsd').toFixed(4)),
      totalMinutes: Math.round(sum('durationMs') / 60000),
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cacheReadTokens: sum('cacheReadTokens'),
      perProject,
      // Runs zonder kostenveld (bv. abonnementsruns) eerlijk apart tonen.
      runsZonderKosten: rows.filter((r) => r.costUsd === null || r.costUsd === undefined).length,
    };
  }
}
