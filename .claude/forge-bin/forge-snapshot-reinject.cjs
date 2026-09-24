#!/usr/bin/env node
'use strict';
/**
 * forge-snapshot-reinject.cjs — SessionStart hook target, matcher `compact` (owner request 2026-07-29:
 * after a compaction, the very next turn must not have lost the mission). Verified contract (Search Boss,
 * forge-2026-07-29-cc-finish WP-R): SessionStart's stdin JSON carries `source` (`startup|resume|clear|
 * compact|fork`), and — per the official docs — **whatever this hook writes to stdout is added back into
 * Claude's context.** This is the ONE re-injection point this whole snapshot system relies on.
 *
 * Behavior: if `.claude/.forge-snapshot-due.json` (written by forge-snapshot-marker.cjs's PreCompact hook)
 * exists, read the just-regenerated `.claude/FORGE_SNAPSHOT.md` and print a SHORT, high-signal block to
 * stdout — Mission + Current state + Next actions + one explicit instruction to refresh sections 3-9 from
 * real evidence before continuing — then delete the marker so the NEXT ordinary session-start stays silent.
 * If no marker exists, print NOTHING and exit 0 (this hook fires on every SessionStart with matcher
 * `compact`, i.e. only after an actual compaction, but stays defensive regardless).
 *
 * SIZE DISCIPLINE: re-injection costs real context — this block targets <= ~600 tokens (chars/4 heuristic),
 * well under FORGE_SNAPSHOT.md's own ~2000-token full-document budget. Only 3 of the 10 snapshot sections
 * are ever re-injected; the rest stay in the file, referenced by path, never inlined here.
 *
 * DUAL DEPLOYMENT (same file, byte-identical, two locations — see forge-snapshot-marker.cjs's file header
 * for the identical rationale): project-local `.claude/forge-bin/` (this project's own settings.json) and
 * GLOBAL `~/.claude/forge-bin/` (the global settings.json, firing for every project — resolves the target
 * project root from `CLAUDE_PROJECT_DIR`/cwd, same convention as the marker). A project with no
 * `.claude/FORGE_SNAPSHOT.md` and no due-marker degrades SILENTLY: no output, exit 0.
 *
 * GUARANTEES: never blocks (exit 0 always), never prints a secret (FORGE_SNAPSHOT.md itself never contains
 * one — it only ever holds paths/pointers/short evidenced text, never file bodies), never prints anything
 * when there is no due-marker (the common case: an ordinary SessionStart with source != "compact", or one
 * that already consumed its marker).
 *
 * OWNER SETTING `snapshots` (v2.7.0, forge-config.cjs; default ON): OFF -> run() returns
 * {ok:true, skipped:true, printed:false, reason:'owner config snapshots=off'} — nothing printed, nothing read
 * back into context, the due-marker left untouched (nothing written or deleted), exit 0. Same soft-require and
 * project-root rule as forge-snapshot-marker.cjs (read through the fail-safe safeGet; absent/throwing module or a
 * damaged settings file -> ON plus a one-line `config_note`, which the CLI prints after a real re-inject; the
 * GLOBAL copy falls back to the target project's own forge-config.cjs; FORGE_PROJECT_ROOT wins when set).
 *
 * MODEL: run(opts) -> {ok, printed, dueConsumed, root, text|null, skipped?} — pure-ish, testable without a
 * real stdin/stdout pipe (opts.configModule injects a config module; null = "absent"). CLI: reads the
 * (unused-but-validated) stdin JSON, calls run(), prints text if any, always exits 0.
 */
const fs = require('fs');
const path = require('path');

const MAX_CHARS = 2400; // ~600 tokens (chars/4 heuristic) — see file header SIZE DISCIPLINE

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
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJsonSafe(p) { const t = readFileSafe(p); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } }

/** extractSection(text, heading) -> the body text of the FIRST `## <n>. <heading>` block (case-sensitive
 *  match on the exact heading text this generator always writes), or null if not found — never guesses. */
function extractSection(text, heading) {
  if (!text) return null;
  const re = new RegExp('^##\\s+\\d+\\.\\s+' + heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'm');
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^##\s+\d+\./m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, '') + '\n_(truncated — see .claude/FORGE_SNAPSHOT.md)_';
}

/** run(opts) -> see file header MODEL. Never throws. */
function run(opts) {
  opts = opts || {};
  const root = resolveProjectRoot(opts);
  const sc = configRead('snapshots', true, { projectRoot: root, configModule: opts.configModule });
  const note = sc.degraded ? { config_note: sc.reason } : {}; // the CLI prints it after a real re-inject
  if (sc.value === false) {
    return Object.assign({ ok: true, skipped: true, reason: 'owner config snapshots=off', printed: false, dueConsumed: false, root, text: null }, note);
  }
  const duePath = path.join(root, '.claude', '.forge-snapshot-due.json');
  const due = readJsonSafe(duePath);
  if (!due) return Object.assign({ ok: true, printed: false, dueConsumed: false, root, text: null }, note);

  const snapshotPath = path.join(root, '.claude', 'FORGE_SNAPSHOT.md');
  const snapshotText = readFileSafe(snapshotPath);

  const mission = snapshotText ? extractSection(snapshotText, 'Mission') : null;
  const currentState = snapshotText ? extractSection(snapshotText, 'Current state') : null;
  const nextActions = snapshotText ? extractSection(snapshotText, 'Next actions') : null;

  const lines = [];
  lines.push('[forge-snapshot] Context was just compacted (reason: ' + (due.reason || 'unknown') + '). Re-injecting the last snapshot so the mission is not lost:');
  if (snapshotText) {
    lines.push('');
    lines.push('MISSION:');
    lines.push(mission || '_(no Mission section found in .claude/FORGE_SNAPSHOT.md)_');
    lines.push('');
    lines.push('CURRENT STATE:');
    lines.push(currentState || '_(no Current state section found)_');
    lines.push('');
    lines.push('NEXT ACTIONS:');
    lines.push(nextActions || '_(no Next actions section found)_');
  } else {
    lines.push('_.claude/FORGE_SNAPSHOT.md was not found — no prior snapshot to re-inject; this is likely the FIRST compaction on this project._');
  }
  lines.push('');
  lines.push('ACTION REQUIRED: refresh .claude/FORGE_SNAPSHOT.md (sections 3-9) from real evidence before continuing (`node .claude/forge-bin/forge-snapshot.cjs write --reason phase`).');

  const text = truncate(lines.join('\n'), MAX_CHARS);

  let dueConsumed = false;
  try { fs.unlinkSync(duePath); dueConsumed = true; } catch { /* best-effort — a leftover marker is re-consumed (or ignored) next time, never fatal */ }

  return Object.assign({ ok: true, printed: true, dueConsumed, root, text }, note);
}

module.exports = { run, resolveProjectRoot, extractSection, truncate, configOn, configRead, MAX_CHARS };

// ---- CLI (SessionStart hook target — ALWAYS exits 0, never blocks; stdout IS re-injected into context) ----
if (require.main === module) {
  let done = false;
  const finish = () => { if (done) return; done = true; process.exit(0); };
  const failsafe = setTimeout(finish, 4000);
  if (failsafe.unref) failsafe.unref();
  let data = '';
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('error', finish);
  process.stdin.on('end', () => {
    try {
      // stdin JSON is validated-but-unused (this hook only needs the project root, resolved via
      // CLAUDE_PROJECT_DIR/cwd — never from untrusted payload content) — parsing it is defensive only.
      try { JSON.parse(data || '{}'); } catch { /* malformed payload never blocks — proceed with cwd resolution */ }
      const result = run({});
      if (result.printed && result.text) process.stdout.write(result.text + '\n' + (result.config_note ? '[forge-config] ' + result.config_note + '\n' : ''));
    } catch { /* an advisory hook must never fail session start */ }
    clearTimeout(failsafe);
    finish();
  });
  process.stdin.resume();
}
