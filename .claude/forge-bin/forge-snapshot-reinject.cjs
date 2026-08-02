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
 * MODEL: run(opts) -> {ok, printed, dueConsumed, root, text|null} — pure-ish, testable without a real
 * stdin/stdout pipe. CLI: reads the (unused-but-validated) stdin JSON, calls run(), prints text if any,
 * always exits 0.
 */
const fs = require('fs');
const path = require('path');

const MAX_CHARS = 2400; // ~600 tokens (chars/4 heuristic) — see file header SIZE DISCIPLINE

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
  const duePath = path.join(root, '.claude', '.forge-snapshot-due.json');
  const due = readJsonSafe(duePath);
  if (!due) return { ok: true, printed: false, dueConsumed: false, root, text: null };

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

  return { ok: true, printed: true, dueConsumed, root, text };
}

module.exports = { run, resolveProjectRoot, extractSection, truncate, MAX_CHARS };

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
      if (result.printed && result.text) process.stdout.write(result.text + '\n');
    } catch { /* an advisory hook must never fail session start */ }
    clearTimeout(failsafe);
    finish();
  });
  process.stdin.resume();
}
