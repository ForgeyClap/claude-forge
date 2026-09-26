#!/usr/bin/env node
'use strict';
/**
 * forge-gate-inspect.cjs — the SINGLE inspection pipeline forge-gate-hook.cjs's evaluate() used to run entirely
 * on the main thread (wp-v3, sec-v1r-H1/L2 remediation, run forge-2026-09-24-codex-fixes). Runs
 * stripInertData -> selfDisable -> classify -> the destructive-delete raw recheck -> scratchPassThrough and
 * returns the COMPLETE ON-verdict shape { block, gates, reason, notice, why } — byte-identical to
 * forge-gate-hook.cjs's pre-wp-v3 evaluate() output for the same input.
 *
 * WHY ONE SHARED FUNCTION, NOT TWO IMPLEMENTATIONS (L2 fix). sec-v1r-H1 found stripInertData() running
 * UNBOUNDED on the MAIN thread, entirely BEFORE the watchdog branch even started — wp-v1/wp-v2's watchdog only
 * ever protected the classify() call itself, never the (also potentially slow — see forge-gate-data.cjs's own
 * MAX_INERT_SCAN_SEGMENTS comment) data-stripping/self-disable/destructive-delete/scratch steps around it. L2
 * separately named the destructive-delete recheck and scratch pass-through as ALSO running unguarded on the
 * main thread, with a header comment that overclaimed the watchdog already covered them. Rather than writing a
 * SECOND copy of this pipeline inside the worker and hoping the two never drift apart, this file IS the
 * pipeline: BOTH forge-gate-hook.cjs (for the watchdog-unavailable fallback, and any opts.gate-stubbed test,
 * which can never cross a Worker boundary — see forge-gate-hook.cjs's own evaluate()) and
 * forge-gate-classify-worker.cjs (the normal, protected path) call this EXACT SAME inspect() function. Nothing
 * runs the full pipeline directly on the main thread except that one deliberate, explicitly-sized fallback path.
 *
 * `ctx` mirrors forge-gate-scratch.cjs's own scratchPassThrough(seen, ctx) shape so it can be passed straight
 * through unchanged: { gate (optional classifier module override, test seam only — never set on the worker
 * path, since a function cannot cross a Worker boundary), shell (payload.tool_name), cwd, root (project root),
 * protectedRoots ([root, CLAUDE_PROJECT_DIR-or-cwd]), tmp, platform, configPath (test seam, threaded to
 * classify() only, matching its pre-wp-v3 reach exactly) }.
 *
 * A NARROW, DELIBERATE BEHAVIOUR NOTE: before this split, stripInertData()/selfDisable() ran OUTSIDE
 * evaluate()'s own try/catch, so a (never observed, believed unreachable — both are designed to fail toward a
 * safe default rather than throw) exception from either would have propagated all the way to run()'s own
 * top-level catch (a generic "internal error" exit 1). Now that they are part of ONE pipeline function called
 * from inside a try/catch on every caller, such a throw is caught at that boundary instead (the inline path's
 * FALLBACK_RE fail-closed check, or the worker's own {ok:false} contract -> a BLOCK). No existing test exercises
 * this path (neither function has ever been observed to throw), and the new behaviour is at least as safe
 * (fails toward BLOCK, not away from it) — recorded here for honesty, not hidden.
 *
 * wp-v4 (sec-v3 M1, independent review): SELFDISABLE and MSG used to be required UNGUARDED here — a broken or
 * missing forge-gate-selfdisable.cjs/forge-gate-messages.cjs made THIS require() throw, which made the worker's
 * own require('./forge-gate-inspect.cjs') throw too (caught there, see forge-gate-classify-worker.cjs), but on
 * the MAIN thread made forge-gate-hook.cjs's OWN top-level require('./forge-gate-inspect.cjs') throw
 * uncaught — crashing the whole process before run()'s CLI handler ever ran, so EVERY command (destructive or
 * not) exited non-zero without a verdict. Both are now guarded, each with a minimal, zero-dependency fallback
 * — a crude but SAFE regex for self-disable (mirrors the existing precedent right below in
 * forge-gate-selfdisable.cjs's own CONFIG_SPLIT_RE comment: "duplicated on purpose... must keep working even if
 * [the primary implementation] is missing/broken") and a generic (un-worded, but still NL/EN and still
 * accurate) block reason for messages — so a single broken sibling degrades ONLY the one capability it
 * provided, never the whole pipeline. */
let DATA = null;
try { DATA = require('./forge-gate-data.cjs'); } catch { DATA = null; } // absent -> nothing is stripped (stricter)
let SCRATCH = null;
try { SCRATCH = require('./forge-gate-scratch.cjs'); } catch { SCRATCH = null; } // absent -> no pass-through (stricter)
let SELFDISABLE = null;
try { SELFDISABLE = require('./forge-gate-selfdisable.cjs'); } catch { SELFDISABLE = null; }
let MSG = null;
try { MSG = require('./forge-gate-messages.cjs'); } catch { MSG = null; }

// Fallback self-disable: a crude, over-inclusive check that still catches the obvious "forge-config.cjs ...
// set/unset ... gate-hook" shape when the precise parser (forge-gate-selfdisable.cjs) cannot load. Fails toward
// refusing (blocking) an ambiguous case, same philosophy as forge-gate-selfdisable.cjs's own V02 fallback.
//
// sec-v3r L3 (independent re-review, mirrors forge-gate-hook.cjs's own identical copy — see that file's header
// for why a small duplication is deliberate here): the old single ordered regex only matched two of the six
// possible orderings of (script name, mutating verb, "gate-hook"), and never stripped quotes/backslashes or
// joined a Bash backslash-newline / PowerShell backtick-newline line continuation before testing. Replaced with
// three independent, unordered word-boundary checks over a normalised copy of the text — each is a single
// linear scan, so this stays exactly as safe against ReDoS as the regex it replaces despite matching more shapes.
function fallbackSelfDisableNormalize(seen) {
  return String(seen)
    .replace(/\\\r?\n/g, '')
    .replace(/`\r?\n/g, '')
    .replace(/["'\\]/g, '');
}
const FALLBACK_SELFDISABLE_SCRIPT_RE = /forge-config(?:-cli)?\.cjs/i;
// WP-S4 (v2.8.0 laptop-audit Part V-F): this fallback only ever fires when forge-gate-selfdisable.cjs itself
// cannot load — but it must stay just as capable of catching a wrapper self-disable call as the precise
// parser (see that file's own WRAPPER_BASENAME_RE). A plain substring/`\b` test would also match "forge"
// inside an UNRELATED wrapper like "forge-status.cmd" (word boundaries do not require the whole word), so
// this checks each WHITESPACE-SPLIT word for an EXACT forge(.cmd|.ps1|.sh) basename instead — same convention
// forge-gate-selfdisable.cjs's own looksLikeAmbiguousConfigMutation() already uses.
const FALLBACK_SELFDISABLE_WRAPPER_BASENAME_RE = /^forge(?:\.(?:cmd|ps1|sh))?$/i;
const FALLBACK_SELFDISABLE_CONFIG_WORD_RE = /\bconfig\b/i;
const FALLBACK_SELFDISABLE_VERB_RE = /\b(?:set|unset)\b/i;
const FALLBACK_SELFDISABLE_KEY_RE = /\bgate-hook\b/i;
function fallbackHasScriptOrWrapper(norm) {
  if (FALLBACK_SELFDISABLE_SCRIPT_RE.test(norm)) return true;
  const words = norm.split(/\s+/).filter(Boolean);
  const hasWrapperWord = words.some((w) => FALLBACK_SELFDISABLE_WRAPPER_BASENAME_RE.test(String(w).split(/[\\/]/).pop()));
  return hasWrapperWord && FALLBACK_SELFDISABLE_CONFIG_WORD_RE.test(norm);
}
function fallbackSelfDisableTest(seen) {
  const norm = fallbackSelfDisableNormalize(seen);
  return fallbackHasScriptOrWrapper(norm) && FALLBACK_SELFDISABLE_VERB_RE.test(norm)
    && FALLBACK_SELFDISABLE_KEY_RE.test(norm);
}
const selfDisableFn = SELFDISABLE ? SELFDISABLE.selfDisable : (seen) => fallbackSelfDisableTest(seen);

// Fallback messages: no per-gate wording (WORDS lives in forge-gate-messages.cjs), but still a real, honest,
// NL/EN block reason — never a raw thrown error, never silence.
const FALLBACK_NOTICE_CHARS = 300;
const fallbackCap = (s) => (s.length > FALLBACK_NOTICE_CHARS ? s.slice(0, FALLBACK_NOTICE_CHARS - 1) + '…' : s);
function fallbackBlockReason(ids) {
  return 'FORGE GATE (' + ids.join(', ') + '): dit commando lijkt destructief; de uitleg-module kon niet laden, '
    + 'dus is het voor de zekerheid geweigerd — herstel forge-gate-messages.cjs (draai de doctor). / '
    + 'this command looks destructive; the wording module could not load, so it was refused to be safe — '
    + 'restore forge-gate-messages.cjs (run the doctor).';
}
function fallbackPassNotice(targets) {
  return fallbackCap('FORGE GATE: destructive delete allowed — all targets inside a project scratch area or in the OS temp dir outside the project (' + targets.join(', ') + ')');
}
const blockReasonFn = MSG ? MSG.blockReason : fallbackBlockReason;
const passNoticeFn = MSG ? MSG.passNotice : fallbackPassNotice;

function scratchPassThrough(command, ctx) {
  if (!SCRATCH) return { ok: false, why: 'scratch-module-unavailable' };
  return SCRATCH.scratchPassThrough(command, ctx);
}

/** commandGateIds(gateModule) -> Set of the "command"-kind gate ids, read from the classifier's own config. */
function commandGateIds(gateModule) {
  return new Set(gateModule.listGates().filter((g) => g.kind === 'command').map((g) => g.id));
}

/** inspect(command, ctx) -> { block, gates, reason, notice, why }. MAY THROW (classifier unavailable, or any
 *  other internal error) — every caller wraps this in its own try/catch and decides what a throw means for its
 *  own thread, exactly as forge-gate-hook.cjs's evaluate() always has for the classify() step. */
function inspect(command, ctx) {
  ctx = ctx || {};
  const gateModule = ctx.gate || require('./forge-actiongate.cjs');
  const data = DATA ? DATA.stripInertData(command, ctx.shell) : { text: command, regions: 0, tooManySegments: false };
  // wp-v3 (sec-v1r, item 3): the segment-count ceiling refuses with the SAME "too large to inspect" shape the
  // hook's own size ceiling already uses — see forge-gate-data.cjs's own MAX_INERT_SCAN_SEGMENTS comment.
  if (data.tooManySegments) {
    const ids = ['command-too-large'];
    return { block: true, gates: ids, reason: blockReasonFn(ids), why: 'command-too-many-segments' };
  }
  const seen = data.text;
  const note = data.regions ? ' (after stripping ' + data.regions + ' inert data region(s))' : '';
  if (selfDisableFn(seen)) {
    const ids = ['gate-hook-self-disable'];
    return { block: true, gates: ids, reason: blockReasonFn(ids), why: 'gate-hook-self-disable' };
  }
  const commandIds = commandGateIds(gateModule);
  const result = gateModule.classify({ text: seen }, ctx.configPath ? { configPath: ctx.configPath } : {});
  let fired = (result.matched || []).filter((id) => commandIds.has(id));
  // I01 / ISO-SCRATCH-SHORTCIRCUIT: the classifier's exact-segment `except` valve is supplemental detection for
  // its own advisory verdict, never an enforcement shortcut for this hook. A destructive-delete SHAPE reaches
  // scratchPassThrough regardless of whether the valve already excused it.
  let ddGate = null;
  try {
    if (commandIds.has('destructive-delete') && typeof gateModule.loadGates === 'function') {
      ddGate = gateModule.loadGates().gates.find((g) => g.id === 'destructive-delete');
    }
  } catch { ddGate = null; } // cannot determine the raw shape either -> fall back to the classifier's own verdict
  const ddExcused = !!ddGate && !fired.includes('destructive-delete')
    && typeof gateModule.testCommandGateRaw === 'function' && gateModule.testCommandGateRaw(ddGate, seen);
  if (!fired.length && !ddExcused) return { block: false, gates: [], why: (result.gate ? 'no-command-gate (' + result.matched.join(', ') + ')' : 'no-gate') + note };
  let why = 'command-gate';
  const onlyDD = fired.length === 1 && fired[0] === 'destructive-delete';
  if (onlyDD || (fired.length === 0 && ddExcused)) {
    // ctx.gate may be absent (the worker path never forwards a classifier module — a function cannot cross a
    // Worker boundary) or a test stub; scratchPassThrough always needs the RESOLVED gateModule (never
    // undefined), not whatever ctx.gate itself happened to be.
    const pass = scratchPassThrough(seen, Object.assign({}, ctx, { gate: gateModule }));
    if (pass.ok) {
      if (!fired.length) return { block: false, gates: [], notice: passNoticeFn(pass.targets), why: 'scratch-pass-through (except-valve overridden by proof)' };
      return { block: false, gates: fired, notice: passNoticeFn(pass.targets), why: 'scratch-pass-through' };
    }
    if (!fired.length) fired = ['destructive-delete'];
    why = 'command-gate (no pass-through: ' + pass.why + ')';
  }
  return { block: true, gates: fired, reason: blockReasonFn(fired), why };
}

module.exports = { inspect, commandGateIds, scratchPassThrough, fallbackSelfDisableTest, fallbackSelfDisableNormalize };
