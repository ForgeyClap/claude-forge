#!/usr/bin/env node
'use strict';
/**
 * forge-artifact.cjs — thin, zero-dependency artifact-store helper for Forge Mission Control Phase 2
 * (WP5 "Vault"). Windows-safe (node "C:/Program Files/nodejs/node.exe" or any Node on PATH).
 *
 * REUSES forge-bin/forge-store.cjs (do not re-implement its guards):
 *   - putEntity   — hardened, id-validated (^[A-Za-z0-9_-]+$), path-contained, SECRET-REDACTING writer
 *                   for the `artifacts` store (.claude/forge-artifacts/<id>.json + index.jsonl row).
 *   - CLAUDE_DIR  — project .claude/ root (honors FORGE_STORE_ROOT for hermetic tests).
 * This file never bypasses those guards and never writes anywhere except through putEntity().
 *
 * CLI:
 *   node forge-artifact.cjs store <artifact_id> '<json>' [--run <run_id>]
 *     -> storeArtifact(); with --run also logs an `artifact_stored` event (already a registered
 *        event_type in log-event.cjs — nothing to add there) to that run's dashboard events via
 *        ../forge-dashboard/log-event.cjs.
 *   Bad or missing args/JSON exit 1 with a clear message. Guarded end-to-end; never throws uncaught.
 *
 * Module API: require('./forge-artifact.cjs') -> { storeArtifact }
 *
 * SECRET HYGIENE: putEntity() redacts every string leaf of the value before anything touches disk
 * (forge-store.cjs redactValue) — a raw secret is never written, never echoed, never re-served.
 * The dashboard's read-only GET /api/artifact/<id> (server.cjs) only ever serves back this already-
 * redacted file — it does not re-process the value.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { putEntity, CLAUDE_DIR } = require('./forge-store.cjs');

function logEvent(runId, eventType, extra) {
  const logEventPath = path.join(CLAUDE_DIR, 'forge-dashboard', 'log-event.cjs');
  return spawnSync(process.execPath, [logEventPath, runId, eventType, JSON.stringify(extra || {})], { encoding: 'utf8' });
}

/**
 * storeArtifact(id, obj, opts) -> the stored (redacted) envelope, same shape putEntity() returns.
 * opts.run: when set, logs `artifact_stored` {agent:"report-writer", artifact_id, kind, title} on that run.
 * Throws (does not catch) on an invalid id / store escape — same contract as forge-store.cjs putEntity().
 */
function storeArtifact(id, obj, opts) {
  opts = opts || {};
  const envelope = putEntity('artifacts', id, obj || {});
  if (opts.run) {
    const extra = {
      agent: 'report-writer',
      artifact_id: id,
      kind: (obj && obj.kind) || envelope.kind || '',
      title: (obj && obj.title) || envelope.title || '',
    };
    const g = logEvent(opts.run, 'artifact_stored', extra);
    if (g.status !== 0) console.error('forge-artifact: log-event (artifact_stored) warning: ' + (g.stderr || '').trim());
  }
  return envelope;
}

module.exports = { storeArtifact };

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    if (cmd !== 'store') {
      console.error("Usage: node forge-artifact.cjs store <artifact_id> '<json>' [--run <run_id>]");
      process.exitCode = 1;
      return;
    }
    const id = argv[1], json = argv[2];
    if (!id || json === undefined) {
      console.error("Usage: node forge-artifact.cjs store <artifact_id> '<json>' [--run <run_id>]");
      process.exitCode = 1;
      return;
    }
    let obj;
    try { obj = JSON.parse(json); } catch (e) { console.error('forge-artifact: invalid JSON: ' + e.message); process.exitCode = 1; return; }

    let run = null;
    for (let i = 3; i < argv.length; i++) if (argv[i] === '--run') run = argv[++i];

    let result;
    try { result = storeArtifact(id, obj, { run }); }
    catch (e) { console.error('forge-artifact: store failed: ' + e.message); process.exitCode = 1; return; }

    console.log('artifact stored: ' + id + '.json' + (run ? (' (run ' + run + ')') : ''));
    void result;
  };
  try { main(); } catch (e) { console.error('forge-artifact: ' + e.message); process.exitCode = 1; }
}
