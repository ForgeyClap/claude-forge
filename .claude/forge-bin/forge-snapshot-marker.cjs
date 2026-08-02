#!/usr/bin/env node
'use strict';
/**
 * forge-snapshot-marker.cjs — PreCompact hook target (matchers `manual` AND `auto`, owner request 2026-07-29:
 * a real snapshot must exist by the time context actually compacts, not just when someone remembers to ask).
 * Reads the PreCompact hook's stdin JSON (`{session_id, transcript_path, cwd, hook_event_name:"PreCompact",
 * compaction_type:"manual"|"auto"}` — verified stdin contract, Search Boss forge-2026-07-29-cc-finish WP-R),
 * writes `.claude/.forge-snapshot-due.json` (the marker the SessionStart(compact) reinject hook consumes),
 * and immediately calls forge-snapshot.cjs's `write()` so a real, machine-derived skeleton exists even if the
 * reinject step is never reached (e.g. the session ends instead of resuming).
 *
 * DUAL DEPLOYMENT (same file, two locations, byte-identical — see HOOKS_OPT_IN.md):
 *   1. Project-local `.claude/forge-bin/forge-snapshot-marker.cjs` — used by THIS project's own
 *      `.claude/settings.json` PreCompact hooks (cwd is already the project root).
 *   2. GLOBAL `~/.claude/forge-bin/forge-snapshot-marker.cjs` — used by the global `~/.claude/settings.json`
 *      PreCompact hooks, which fire for EVERY project. This file resolves the target project's root from
 *      `CLAUDE_PROJECT_DIR` (the official Claude Code hook env var — see `~/.claude/helpers/hook-safe.cjs`'s
 *      own `resolveTarget()` for the identical convention) or `process.cwd()`, then dynamically requires THAT
 *      project's OWN `.claude/forge-bin/forge-snapshot.cjs` — never a project-agnostic copy, since the
 *      generator needs THAT project's own FORGE_MEMORY.md/events/git history. A project with no Forge install
 *      (no `.claude/forge-bin/forge-snapshot.cjs`) degrades SILENTLY: no output, exit 0 — proven by
 *      forge-snapshot-marker.test.cjs's "no Forge install" case.
 *
 * GUARANTEES (advisory hook discipline, mirrors forge-hook-hotspot-lock.cjs/forge-hook-secret-scrub.cjs):
 *   - NEVER blocks compaction: never emits `{"decision":"block", ...}` on stdout, always exits 0 (even on its
 *     own internal error — logged to a local diagnostics file instead of thrown).
 *   - FAST: a single project-root resolution + one small JSON write + one forge-snapshot.cjs `write()` call
 *     (whose own git calls are timeout-capped — see forge-snapshot.cjs::gitInfo) — well under the 5s budget.
 *   - NEVER prints secrets: this file emits no stdout at all in the success path (a PreCompact hook's stdout
 *     is not re-injected into context the way SessionStart's is — only the marker file + snapshot file are
 *     written); stderr carries at most a short diagnostic label, never file content.
 *
 * MODEL: run(rawStdinJson, opts) -> {ok, wrote, due, root, snapshotWritten, reason} — pure-ish, testable
 * without a real stdin pipe. CLI: reads real stdin, calls run(), always exits 0.
 */
const fs = require('fs');
const path = require('path');

function resolveProjectRoot(opts) {
  opts = opts || {};
  if (opts.projectRoot) return path.resolve(opts.projectRoot);
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  return process.cwd();
}
function mapReason(compactionType) {
  return compactionType === 'manual' ? 'precompact-manual' : 'precompact-auto';
}
function logDiag(root, obj) {
  try {
    const dir = path.join(root, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, '.forge-snapshot-marker.log'), JSON.stringify(obj) + '\n');
  } catch { /* diagnostics are best-effort only — never allowed to throw */ }
}

/** run(rawStdinJson, opts) -> see file header MODEL. Never throws (every failure path is caught and
 *  returned as {ok:false, reason}), so the CLI wrapper can always exit 0. */
function run(rawStdinJson, opts) {
  opts = opts || {};
  let payload = {};
  try { payload = JSON.parse(rawStdinJson || '{}'); } catch { payload = {}; }
  if (!payload || typeof payload !== 'object') payload = {};

  const root = resolveProjectRoot(opts);
  const compactionType = payload.compaction_type === 'manual' ? 'manual' : 'auto';
  const reason = mapReason(payload.compaction_type);
  const due = {
    reason, compaction_type: compactionType,
    session_id: typeof payload.session_id === 'string' ? payload.session_id : null,
    transcript_path: typeof payload.transcript_path === 'string' ? payload.transcript_path : null,
    at: new Date().toISOString(),
  };

  let wrote = false;
  try {
    const dueDir = path.join(root, '.claude');
    fs.mkdirSync(dueDir, { recursive: true });
    fs.writeFileSync(path.join(dueDir, '.forge-snapshot-due.json'), JSON.stringify(due, null, 2), 'utf8');
    wrote = true;
  } catch (e) { logDiag(root, { at: due.at, step: 'write-marker', error: e.message }); }

  let snapshotWritten = false;
  try {
    const genPath = path.join(root, '.claude', 'forge-bin', 'forge-snapshot.cjs');
    if (fs.existsSync(genPath)) {
      const snapshotMod = require(genPath); // eslint-disable-line global-require
      snapshotMod.write({ root, reason, gitTimeoutMs: opts.gitTimeoutMs });
      snapshotWritten = true;
    }
    // no Forge install at this project root — silent, honest no-op (never an error)
  } catch (e) { logDiag(root, { at: due.at, step: 'write-snapshot', error: e.message }); }

  return { ok: true, wrote, due, root, snapshotWritten, reason };
}

module.exports = { run, resolveProjectRoot, mapReason };

// ---- CLI (advisory hook target — ALWAYS exits 0, never blocks). Mirrors the async stdin-collection
// pattern already proven safe on Windows by forge-hook-hotspot-lock.cjs/forge-hook-secret-scrub.cjs (a
// synchronous fd-0 read is avoided deliberately). A hard 4s failsafe timer guarantees this hook still exits
// even if stdin never ends, keeping the <5s PreCompact budget regardless of the platform's pipe behavior. ----
if (require.main === module) {
  let done = false;
  const finish = () => { if (done) return; done = true; process.exit(0); };
  const failsafe = setTimeout(finish, 4000);
  if (failsafe.unref) failsafe.unref();
  let data = '';
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('error', finish);
  process.stdin.on('end', () => {
    try { run(data, {}); }
    catch { /* an advisory hook must never fail the compaction it observes */ }
    clearTimeout(failsafe);
    finish();
  });
  process.stdin.resume();
}
