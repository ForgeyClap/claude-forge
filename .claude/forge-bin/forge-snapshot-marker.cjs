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
 * OWNER SETTING `snapshots` (v2.7.0, forge-config.cjs; default ON): OFF -> run() returns
 * {ok:true, skipped:true, reason:'owner config snapshots=off'} BEFORE touching the disk — no marker, no
 * snapshot, no diagnostics line, no output, exit 0. The setting is read for the SAME project root this hook
 * acts on (FORGE_PROJECT_ROOT, the resolver's own seam, wins when set). forge-config.cjs is soft-required and
 * read through its fail-safe safeGet(): absent, throwing or a damaged settings file -> the schema default (ON,
 * `snapshots` carries no data flag) with run() returning a one-line `config_note`, so a missing or damaged
 * settings file never breaks compaction. The GLOBAL copy has no sibling forge-config.cjs, so it falls back to the TARGET project's own
 * `.claude/forge-bin/forge-config.cjs` — the same "that project's own module" rule as forge-snapshot.cjs.
 *
 * MODEL: run(rawStdinJson, opts) -> {ok, wrote, due, root, snapshotWritten, reason, skipped?} — pure-ish,
 * testable without a real stdin pipe (opts.configModule injects a config module; null = "absent"). CLI:
 * reads real stdin, calls run(), always exits 0.
 */
const fs = require('fs');
const path = require('path');

let cfg = null;
try { cfg = require('./forge-config.cjs'); } catch { cfg = null; }
function configModuleFor(root) {
  if (cfg) return cfg;
  try { return require(path.join(root, '.claude', 'forge-bin', 'forge-config.cjs')); } // eslint-disable-line global-require
  catch { return null; }
}
/** configRead(key, fallback, opts) -> { value, source, degraded, reason } via forge-config.safeGet (FAIL-SAFE,
 *  review-boss M3: a damaged settings file never switches a flagged feature on). `fallback` is this file's copy of
 *  the schema default, used only when forge-config.cjs is absent or broken; an older copy without safeGet is read
 *  through get(). Never throws. opts.projectRoot = the root this hook acts on (ignored when FORGE_PROJECT_ROOT is
 *  set); opts.configModule injects a module (tests; null = "absent"). */
function configRead(key, fallback, opts) {
  opts = opts || {};
  const mod = opts.configModule !== undefined ? opts.configModule : configModuleFor(opts.projectRoot || process.cwd());
  const o = opts.projectRoot && !process.env.FORGE_PROJECT_ROOT ? { projectRoot: opts.projectRoot } : {};
  let why = 'forge-config.cjs not found';
  try {
    if (mod && typeof mod.safeGet === 'function') {
      const r = mod.safeGet(key, Object.assign({ fallback }, o));
      if (r && typeof r.value === typeof fallback) return r;
      why = 'forge-config gave no usable value';
    } else if (mod && typeof mod.get === 'function') {
      const e = mod.get(key, o);
      if (e && typeof e.value === typeof fallback) return { value: e.value, source: e.source || 'unknown', degraded: false, reason: null };
      why = 'forge-config gave a value of the wrong type';
    }
  } catch (e) { why = 'settings unreadable: ' + ((e && e.message) || e); }
  return { value: fallback, source: 'built-in', degraded: true, reason: why + ' — ' + key + ' uses the built-in ' + JSON.stringify(fallback) };
}
/** configOn(key, def, opts) -> just the value of configRead(). */
function configOn(key, def, opts) { return configRead(key, def, opts).value; }

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
  const root = resolveProjectRoot(opts);
  const sc = configRead('snapshots', true, { projectRoot: root, configModule: opts.configModule });
  const note = sc.degraded ? { config_note: sc.reason } : {}; // degraded settings: say so in the result (this hook prints nothing)
  if (sc.value === false) {
    return Object.assign({ ok: true, skipped: true, reason: 'owner config snapshots=off', wrote: false, due: null, root, snapshotWritten: false }, note);
  }
  let payload = {};
  try { payload = JSON.parse(rawStdinJson || '{}'); } catch { payload = {}; }
  if (!payload || typeof payload !== 'object') payload = {};

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

  return Object.assign({ ok: true, wrote, due, root, snapshotWritten, reason }, note);
}

module.exports = { run, resolveProjectRoot, mapReason, configOn, configRead };

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
