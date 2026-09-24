#!/usr/bin/env node
'use strict';
/**
 * forge-gate-scratch.cjs — the SCRATCH PASS-THROUGH lexer for the PreToolUse gate hook
 * (forge-gate-hook.cjs), split out on 2026-09-24 (codex-recheck-2026-09-24, wp-f1) to keep both the hook and
 * forge-gate-data.cjs under 500 lines. Pure functions, zero dependencies beyond Node core (fs/path), no I/O
 * beyond fs.existsSync/realpathSync (both read-only). Every function here fails toward "cannot prove it, keep
 * the block."
 *
 * WHAT THIS IS FOR. A destructive-delete SHAPE (rm -rf, Remove-Item -Recurse -Force, rimraf, their aliases)
 * passes the hook only when EVERY segment of the command is itself a provable delete (review wp9a L2) whose
 * targets ALL resolve inside a scratch area — `_scratch/`, `node_modules/`, `dist/`, `.claude/forge-backups/`,
 * a `gate-output` folder, `command-center/.data/tmp`, or strictly inside the OS temp dir outside the project —
 * with no `{ } ( )` and no cwd/layout/exec token anywhere on the line (security wp9b L3). This is reached for
 * EVERY destructive-delete shape the hook sees, including one the classifier's own except-valve already
 * excused (codex-recheck I01: that valve is supplemental detection for the classifier's own advisory verdict,
 * never an enforcement shortcut for this hook) — forge-gate-hook.cjs::evaluate() decides WHEN to call
 * scratchPassThrough(); this file only decides WHETHER a given command proves out.
 *
 * CANONICALIZATION FAILS CLOSED (codex-recheck I02): realish() reports { ok:false } when it cannot resolve a
 * real path (a permission error, a broken link) rather than silently substituting the unresolved lexical path
 * as if it were proof; areaOf() refuses the scratch exception the instant any realish() call in it fails.
 *
 * API: tokenize(segment) · verbIndex(tokens) · extractTargets(tokens, verbAt) · realish(p) -> {real, ok} ·
 *      resolveTarget(raw, ctx) · areaOf(abs, ctx) · scratchPassThrough(command, ctx).
 */
const fs = require('fs');
const path = require('path');

const DELETE_VERBS = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'rimraf']);
const REFUSED_TOKENS = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location',
  'mv', 'move', 'move-item', 'mi', 'cp', 'copy', 'copy-item', 'cpi', 'ren', 'rename', 'rename-item', 'rni', 'ln', 'mklink',
  'new-item', 'ni', 'robocopy', 'xcopy', 'cmd', 'builtin', 'command', 'exec', 'env', 'eval', 'source', 'xargs']);
const PROVABLE_SEGMENT_RE = /^[A-Za-z0-9_\s.\-/\\:'"=+]*$/; // no expansion, glob, redirection or second command
// CI fix (2026-09-24, GitHub windows-latest): a tilde INSIDE a word is a literal character — Windows 8.3 short names
// (`C:\Users\RUNNER~1\AppData\Local\Temp`, the runner's os.tmpdir()) carry one — while bash tilde expansion only
// applies to a tilde that STARTS a word (`~`, `~user`, `~/x`) or follows `=`/`:` in an assignment. Only the in-word
// tilde is neutralised before the whitelist test; a leading or `=`/`:`-prefixed tilde stays unprovable.
const provableSegment = (seg) => PROVABLE_SEGMENT_RE.test(String(seg).replace(/(?<=[A-Za-z0-9_])~(?=[A-Za-z0-9_])/g, '_'));
const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** tokenize(segment) -> [{v, quoted}] | null. Whole-word quotes only; a quote glued to other text is refused. */
function tokenize(segment) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const next = segment[re.lastIndex];
    if (next !== undefined && !/\s/.test(next)) return null;
    if (m[3] !== undefined) {
      if (/["']/.test(m[3])) return null;
      out.push({ v: m[3], quoted: false });
    } else out.push({ v: m[1] !== undefined ? m[1] : m[2], quoted: true });
  }
  return out;
}

/** verbIndex(tokens) -> index of the delete verb, or -1 (allowed in front: sudo, npx [--flags], pnpm/yarn dlx). */
function verbIndex(tokens) {
  const low = (k) => (tokens[k] && !tokens[k].quoted ? tokens[k].v.toLowerCase() : null);
  let i = 0;
  if (low(i) === 'sudo') i++;
  if (low(i) === 'npx') { i++; while (low(i) && low(i).startsWith('-')) i++; }
  else if ((low(i) === 'pnpm' || low(i) === 'yarn') && low(i + 1) === 'dlx') i += 2;
  return low(i) && DELETE_VERBS.has(low(i)) ? i : -1;
}

/** extractTargets(tokens, verbAt) -> targets | null. Every non-flag token is a target (a misread flag value can
 *  only add a block); `--` ends options; `-Param:value` is refused; `/s` is a PATH in Git Bash and PowerShell. */
function extractTargets(tokens, verbAt) {
  const targets = [];
  let endOfOptions = false;
  for (let k = verbAt + 1; k < tokens.length; k++) {
    const { v, quoted } = tokens[k];
    if (!endOfOptions && !quoted && v === '--') { endOfOptions = true; continue; }
    if (!endOfOptions && !quoted && v.startsWith('-')) { if (v.includes(':')) return null; continue; }
    targets.push(v);
  }
  return targets;
}

/** statOrFail(p) -> {kind:'ok',stat} | {kind:'enoent'} | {kind:'error',err} — a single explicit lstat, never
 *  existsSync (codex-recheck V04: existsSync swallows EVERY error — EACCES/EPERM, ELOOP, ENOTDIR, a
 *  permission-denied ancestor — into the SAME bare `false` as a genuinely absent path, so the realish() walk
 *  below used to climb straight past a real access error as if that level simply "did not exist"). Only a
 *  clean ENOENT is ever verified absence; every other error is reported as such and must fail the walk
 *  closed, never be reinterpreted as "keep climbing". */
function statOrFail(p) {
  try { return { kind: 'ok', stat: fs.lstatSync(p) }; }
  catch (e) { return e && e.code === 'ENOENT' ? { kind: 'enoent' } : { kind: 'error', err: e }; }
}

/** realish(p) -> { real, ok }. Resolves the realpath of the longest existing ancestor + the missing tail (a
 *  link is judged by its target). ok:false means canonicalization itself FAILED — a permission error or an
 *  unreadable ancestor anywhere in the walk (V04, via statOrFail), a symlink loop (ELOOP), or a dangling
 *  symlink/junction at the stopping point (the lstat succeeds — the link itself exists — but resolving it
 *  below throws) — codex-recheck I02/V04: NONE of that is ever proof of containment, so the caller must
 *  refuse the scratch exception rather than silently substituting the unresolved lexical path. VERIFIED
 *  absence (a clean ENOENT on the leaf, with every parent up to the stopping point resolved for real) is the
 *  ONLY case that continues climbing instead of failing outright. */
function realish(p) {
  let existing = p;
  const tail = [];
  for (;;) {
    const s = statOrFail(existing);
    if (s.kind === 'ok') break;
    if (s.kind === 'error') return { real: null, ok: false }; // V04: an access error is never "just missing"
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached the filesystem root without finding an existing ancestor
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real;
  try { real = fs.realpathSync.native(existing); } catch { return { real: null, ok: false }; }
  return { real: tail.length ? path.join(real, ...tail) : real, ok: true };
}

function relInside(base, p) {
  const rel = path.relative(base, p);
  if (rel === '') return '';
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

/** resolveTarget(raw, ctx) -> absolute path | null (null = cannot be proven, block). */
function resolveTarget(raw, ctx) {
  let p = String(raw);
  if (!p || p.length > 1024) return null;
  if (ctx.shell === 'Bash' && p.includes('\\')) return null; // bash reads `\` as an escape, not a separator
  if (ctx.shell === 'PowerShell') p = p.replace(/\\/g, '/');  // PowerShell accepts both separators
  if (/^[A-Za-z]:(?![\\/])/.test(p)) return null;              // drive-relative `C:foo`
  if (ctx.platform === 'win32' && ctx.shell === 'Bash') {      // Git Bash drive form /c/Users/... -> C:/Users/...
    const m = /^\/([A-Za-z])(\/|$)/.exec(p);
    if (m) p = m[1].toUpperCase() + ':/' + p.slice(3);
  }
  if (p.split(/[\\/]+/).includes('..')) return null;            // never reason about `..` (links make it physical)
  return path.resolve(ctx.cwd, p);
}

/** areaOf(abs, ctx) -> { area, display } | null — the scratch area that contains abs, judged on real paths.
 *  Fails closed (returns null) the instant ANY realish() call in this function cannot canonicalize — I02. */
function areaOf(abs, ctx) {
  const targetR = realish(abs);
  if (!targetR.ok) return null;
  const real = targetR.real;
  const protectedRoots = [];
  for (const r of (ctx.protectedRoots || [ctx.root]).filter(Boolean)) {
    const rr = realish(path.resolve(r));
    if (!rr.ok) return null; // cannot prove this ISN'T a protected root either — refuse the exception
    protectedRoots.push(rr.real);
  }
  if (protectedRoots.some((r) => relInside(real, r) !== null)) return null; // the root itself or an ancestor of it
  const insideProject = protectedRoots.some((r) => relInside(r, real) !== null);
  let tmpRel = null;
  if (!insideProject) {
    const rt = realish(ctx.tmp);
    if (!rt.ok) return null;
    tmpRel = relInside(rt.real, real);
  }
  const rr2 = realish(ctx.root);
  if (!rr2.ok) return null;
  const rootRel = relInside(rr2.real, real);
  if (rootRel) {
    const s = rootRel.split(/[\\/]+/);
    const show = s.join('/');
    const is = (i, name) => s[i] !== undefined && sameName(s[i], name);
    if (is(0, '_scratch')) return { area: '_scratch', display: show };
    if (s.some((x) => sameName(x, 'node_modules'))) return { area: 'node_modules', display: show };
    if (s.some((x) => sameName(x, 'dist'))) return { area: 'dist', display: show };
    if (is(0, '.claude') && is(1, 'forge-backups') && s.length >= 3) return { area: 'forge-backups', display: show };
    if (is(0, '.claude') && is(1, 'forge-runs') && s.slice(2).some((x) => sameName(x, 'gate-output'))) return { area: 'gate-output', display: show };
    if (is(0, 'command-center') && is(1, '.data') && is(2, 'tmp')) return { area: 'command-center/.data/tmp', display: show };
  }
  if (tmpRel) return { area: 'tmpdir', display: '<tmp>/' + tmpRel.split(/[\\/]+/).join('/') }; // strictly inside, outside the project
  return null;
}

/** scratchPassThrough(command, ctx) -> { ok:true, targets } | { ok:false, why }. Never throws.
 *  ctx = { gate (the classifier module), shell, cwd, root, protectedRoots, tmp, platform }. */
function scratchPassThrough(command, ctx) {
  try {
    const g = ctx.gate.loadGates().gates.find((x) => x.id === 'destructive-delete');
    if (!g || !g.match || !g.match.pattern) return { ok: false, why: 'no-gate-config' };
    if (g.match.pattern_line && new RegExp(g.match.pattern_line, g.match.flags || 'i').test(command)) return { ok: false, why: 'pipeline-delete' };
    if (/[{}()]/.test(command)) return { ok: false, why: 'grouping-or-subshell' };
    const words = command.split(/[\s;&|]+/).map((t) => t.replace(/^["']+|["']+$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, ''));
    if (words.some((t) => REFUSED_TOKENS.has(t))) return { ok: false, why: 'cwd-layout-or-exec-token' };
    const shown = [];
    for (const e of ctx.gate.splitCommandsDetailed(command)) {
      if (!e.intact) return { ok: false, why: 'amputated-segment' };
      if (!provableSegment(e.segment)) return { ok: false, why: 'unprovable-characters' };
      const tokens = tokenize(e.segment);
      if (!tokens) return { ok: false, why: 'unreadable-quoting' };
      const verbAt = verbIndex(tokens);
      if (verbAt < 0) return { ok: false, why: 'segment-is-not-a-plain-delete' };
      const targets = extractTargets(tokens, verbAt);
      if (!targets || !targets.length) return { ok: false, why: 'no-provable-targets' };
      for (const t of targets) {
        const abs = resolveTarget(t, ctx);
        const area = abs && areaOf(abs, ctx);
        if (!area) return { ok: false, why: 'target-outside-scratch' };
        shown.push(area.display);
      }
    }
    return shown.length ? { ok: true, targets: shown } : { ok: false, why: 'nothing-to-prove' };
  } catch (e) {
    return { ok: false, why: 'internal-error (' + String(e && e.message || e).split('\n')[0] + ')' };
  }
}

module.exports = { tokenize, verbIndex, extractTargets, realish, relInside, resolveTarget, areaOf, scratchPassThrough,
  statOrFail, DELETE_VERBS, REFUSED_TOKENS };
