'use strict';
/**
 * forge-actiongate-position.cjs — the COMMAND-POSITION widening layer for forge-actiongate.cjs's command-kind
 * gates, split out on 2026-09-24 (codex-recheck wave 2, wp-h1) to keep forge-actiongate.cjs under 500 lines.
 * Pure functions, zero dependencies, no I/O. Required by forge-actiongate.cjs; not a standalone entry point.
 *
 * WHAT THIS FILE DOES. A command-kind gate's `pattern` is tested per split SEGMENT (see
 * forge-actiongate.cjs::splitCommandsDetailed). Testing the raw segment text alone misses a dangerous verb
 * that sits behind a grouping/control-flow opener (`{ eval "$x"; }`, `if true; then eval "$x"; fi`), behind a
 * LATER case arm or PowerShell branch that is not the segment's first clause (`case y in x) :;; y) eval
 * "$cmd";; esac`, `if ($false) { Write-Output ok } else { iex $cmd }`), or loses its own substitution evidence
 * to the classifier's own segment split (`bash -c "$(cat payload.txt)"` splits into the segment `bash -c "`
 * with no `$` left in it). commandPositionCandidates() below is the single place that widens what a
 * command-kind pattern is tested against to cover all three, WITHOUT ever touching entry.segment itself — the
 * exact split() text isExcusedSegment() and every other caller pins.
 *
 * QUOTING-LAYER REDESIGN (2026-09-24, codex-recheck wave 5 / wp-j1, root-cause fix for N04 — a REGRESSION, not a
 * first bug). Before this rewrite, laterBranchStarts() built its OWN fresh quote mask over just the ONE segment
 * text it was given — but forge-actiongate.cjs's own segment SPLIT is deliberately not quote-aware (a separator
 * inside quoted data still splits, "the safe direction for detection"), so a quoted `;` inside e.g.
 * `Write-Output "a;b"` cut the command into two segments, and the SECOND segment's own fresh mask started
 * "outside any quote" at its own position 0 even though, in the ORIGINAL text, that position is really still
 * INSIDE the still-open double quote from the first segment. A stray leftover `"` at the start of that second
 * segment then looked like a fresh OPENING quote, wrongly swallowing the real `else`/`catch`/`finally` branch
 * that followed it as "quoted data" and hiding it. laterBranchStarts()/commandPositionCandidates() now take the
 * SAME shared quote mask forge-gate-quotes.cjs::scanQuotes() computes ONCE over the FULL original command text
 * (see forge-actiongate.cjs::testCommandGate/testCommandGateRaw), plus each segment's own absolute `offset`
 * within that text (see forge-actiongate.cjs::splitCommandsDetailed), so a keyword match is judged against
 * where it REALLY sits in the original text — never a mask restarted at a segment boundary. A caller with no
 * mask/offset (direct unit tests, kept working unchanged) gets a mask built fresh over just the text given, the
 * same fallback behaviour this file always had standalone.
 *
 * API: AMPUTATING_SEPARATORS · COMMAND_OPENER_STEPS · stripCommandOpeners(segment) ·
 *      LATER_BRANCH_RE · laterBranchStarts(text, mask?, baseOffset?) · commandPositionCandidates(entry, mask?).
 */
const QUOTES = require('./forge-gate-quotes.cjs');

/** AMPUTATING_SEPARATORS — the two separators that do NOT end a command: they OPEN a nested one inside the
 *  current command's argument list. Splitting on them is necessary for detection (the nested command must be
 *  tested too) but it always cuts the OUTER command mid-argument, so no segment on either side of one can be
 *  trusted as a complete, provable target. Note the whitespace rule below cannot save these: even the
 *  well-spaced `rm -rf ./_scratch/x $(cat list)` hides a SECOND target the classifier will never see. */
const AMPUTATING_SEPARATORS = new Set(['$(', '`']);

/** COMMAND_OPENER_STEPS / stripCommandOpeners (codex-recheck 2026-09-24, V06 — a regression `ccadad7`
 *  reintroduced) — a leading grouping or control-flow token that is not itself part of the command it
 *  introduces: `{`/`(` grouping, `!` negation, a bare bash keyword (then/do/else/elif/while/until/for/if), a
 *  header with its own `(...)` condition (if/while/elseif/foreach/for/switch/try/catch/finally), a bare
 *  PowerShell `try`, or a `case … )` arm label. `{ eval "$x"; }` splits (on `;`) into the segment
 *  `{ eval "$x"`, whose leading `{` defeated the command-position anchor entirely; `if true; then eval "$x";
 *  fi` splits into `then eval "$x"`, whose leading `then` did the same. Applied iteratively (capped) because
 *  a nested opener needs more than one strip (`then { eval …` needs "then " AND "{ " removed). This function
 *  is used ONLY to build extra candidates a command-kind PATTERN is tested against below — it never touches
 *  entry.segment itself, which stays the exact split() text isExcusedSegment() and every other caller pins. */
// ORDER MATTERS: the header-with-its-own-`(...)` step MUST run before the bare-keyword step, or a bare
// "if"/"while"/"for" strip fires first and leaves the header's own condition parens as orphaned, unmatched
// text (`if ($true) {...}` would otherwise strip only "if " and get stuck on the leftover "($true) {...}").
// wave 2 (codex-recheck 2026-09-24, V06): "catch"/"finally" joined the bare-keyword step (a bare
// `catch { ... }`/`finally { ... }` carries no `(...)` for the header-with-parens step to strip), and a new
// final step strips a LATER case-arm label (`y)`, `*)`, `"quoted")`) that is not preceded by the literal word
// "case" at all — the split already isolates each arm into its own segment starting directly at the label
// (`case y in x) :;; y) eval "$cmd";; esac` splits the second arm to the segment `y) eval "$cmd"`), so the
// dedicated `case\b...` step never fires for it. A case-arm label is conventionally a single whitespace-free
// token (no space before its own `)`), which is what keeps this from swallowing an unrelated
// "several words) more words" span that merely happens to contain a stray parenthesis (`foo(bar)` also never
// matches: the class excludes `(` too, so it cannot reach a `)` without first hitting the excluded opener).
const COMMAND_OPENER_STEPS = [
  /^[{(]\s*/,
  /^!\s*/,
  /^(?:if|while|elseif|foreach|for|switch|catch|finally|try)\b\s*\([\s\S]*?\)\s*/i,
  /^(?:then|do|else|elif|while|until|for|if|catch|finally)\b\s*/i,
  /^try\b\s*/i,
  /^case\b[\s\S]*?\)\s*/i,
  /^[^\s()\n]{1,40}\)\s*/,
];
function stripCommandOpeners(segment) {
  let s = String(segment);
  for (let i = 0; i < 6; i++) {
    let changed = false;
    for (const re of COMMAND_OPENER_STEPS) {
      const m = re.exec(s);
      if (m && m[0].length) { s = s.slice(m[0].length); changed = true; }
    }
    if (!changed) break;
  }
  return s;
}

/** LATER_BRANCH_RE / laterBranchStarts (V06 wave 2; quote-aware since N04) — a later `else`/`elseif`/`catch`/
 *  `finally` keyword occurring ANYWHERE inside a single split segment, not only at its own start. A
 *  multi-clause construct on one line/segment with no `;` between its clauses (`if ($false) { Write-Output ok
 *  } else { iex $cmd }` is one whole segment: nothing in it is a shell/PowerShell statement separator this
 *  classifier splits on) never advances past its FIRST clause's own closing brace, because
 *  stripCommandOpeners() only ever strips from position 0. Each keyword match becomes an ADDITIONAL candidate
 *  start — the segment's own text from there to the end (openers re-stripped on it too, exactly like any
 *  other candidate) — never a replacement for the existing position-0 candidates, so nothing that used to
 *  match can stop matching. Cutting only ever happens at a genuine control-flow-keyword boundary, never inside
 *  an actual command word, so a real command's own preceding context (e.g. `git ` immediately before `rm` for
 *  git-destructive's/destructive-delete's lookbehind exceptions) is never severed by this — whatever precedes
 *  `rm` in the ORIGINAL segment still precedes it in every slice that still contains it.
 *  N04 (codex-recheck 2026-09-24, third pass — a false-positive regression; FOURTH pass — a regression of THAT
 *  fix, see this file's header): the keyword scan used to match the plain WORD anywhere, including inside
 *  quoted DATA — `node docs.cjs "else eval report"` and `Write-Host "catch iex is an alias"` both promoted
 *  their quoted argument's own text to a fake command-position candidate. A `mask` built fresh per segment then
 *  regressed the OPPOSITE way: a segment cut mid-quote by the classifier's own naive split looked like it
 *  OPENED a quote at its own position 0, hiding a genuine later branch. Consulting the shared, whole-original-
 *  text mask (see this file's header) at each match's ABSOLUTE position — `baseOffset + m.index` — resolves
 *  both directions at once: a keyword truly inside a quote (in the ORIGINAL text) is skipped; one truly outside
 *  it (even if the local segment text alone looks ambiguous) is not. */
const LATER_BRANCH_RE = /\b(?:else|elseif|catch|finally)\b/ig;
function laterBranchStarts(text, mask, baseOffset) {
  const starts = [];
  const m = mask || QUOTES.scanQuotes(text);
  const base = baseOffset || 0;
  LATER_BRANCH_RE.lastIndex = 0;
  let mm;
  while ((mm = LATER_BRANCH_RE.exec(text)) !== null) {
    if (mm.index > 0 && !m.inside(base + mm.index)) starts.push(text.slice(mm.index));
    if (mm[0].length === 0) LATER_BRANCH_RE.lastIndex++; // defensive: never spin on a zero-width match
  }
  return starts;
}

/** commandPositionCandidates(entry) -> the string(s) a command-kind gate's `pattern` is tested against for
 *  ONE split segment: the segment itself; the same text with its own amputating separator's marker
 *  (`$(`/backtick) RE-ATTACHED (V06 — the classifier's own split silently ate that exact character before a
 *  `[^\n]*\$` / backtick lookahead ever ran, e.g. `bash -c "$(cat payload.txt)"` split into the segment
 *  `bash -c "` with no `$` left in it at all); that text with leading grouping/control-flow openers stripped;
 *  and (V06 wave 2) the text from every LATER else/elseif/catch/finally keyword to the end, each with its own
 *  openers stripped too. Every candidate is a SUPERSET of the plain segment text (never a rewrite of it), so a
 *  pattern with no start/end anchor (every pattern except opaque-exec's own iex/eval alternative) can only
 *  ever gain a match on inert trailing/leading noise, never lose one — the three other command gates are
 *  unaffected in practice (measured: the shipped corpus is unchanged) and entry.segment itself is never
 *  modified. */
function ampSuffix(entry) {
  return entry.sepAfter && AMPUTATING_SEPARATORS.has(entry.sepAfter) ? entry.sepAfter : '';
}
/** commandPositionCandidates(entry, mask) -> see this file's header. `mask` should be the shared
 *  forge-gate-quotes.cjs::scanQuotes() result computed ONCE over the FULL original command text by the caller
 *  (forge-actiongate.cjs); `entry.offset` (set by splitCommandsDetailed) anchors `entry.segment`'s own absolute
 *  position within that text so laterBranchStarts() below can query the mask with ORIGINAL offsets. A caller
 *  with no mask (direct unit tests) gets a fresh per-text mask and offset 0 — the same standalone behaviour
 *  this function always had. */
function commandPositionCandidates(entry, mask) {
  const withSuffix = entry.segment + ampSuffix(entry);
  const effectiveMask = mask || QUOTES.scanQuotes(withSuffix);
  const offset = mask ? (entry.offset || 0) : 0;
  const bases = [entry.segment, withSuffix].concat(laterBranchStarts(withSuffix, effectiveMask, offset));
  const out = [];
  const seen = new Set();
  const add = (s) => { if (!seen.has(s)) { seen.add(s); out.push(s); } };
  for (const b of bases) {
    add(b);
    const stripped = stripCommandOpeners(b);
    if (stripped !== b) add(stripped);
  }
  return out;
}

/** hasLiveCArg(text) -> boolean — the -c ARGUMENT POLICY (N02, FOURTH pass, codex-recheck p10): a live
 *  variable or substitution inside a `sh -c`/`bash -c`/`pwsh -c`/`powershell -c` argument cannot be told apart
 *  from a genuinely inert one by a single declarative regex. THIRD pass (cArgHasLiveMarker, now retired)
 *  fixed the DOUBLE-quoted-argument case only — an escaped `\$`/backtick is inert for the outer shell but
 *  still live at the inner `-c` interpreter unless protected by the argument's OWN nested single-quoting.
 *  FOURTH pass: Codex reproduced the SAME class of bypass one layer up — `/bin/bash -c $x` (no quoting at all)
 *  and `/bin/bash -c '$x'` (single-quoted) both changed the exit code from blocked to silent, because the
 *  double-quote-only reader never looked at those two other outer forms at all. cArgLiveAfterFlag() (shared,
 *  forge-gate-quotes.cjs) now reads ALL THREE outer forms — none/single/double — for every genuine `-c` token
 *  in the FULL original text (not a per-segment fragment, so a naive split can never cut this argument in two
 *  and hide half of it); see that file's own header for the exact two-shell-layer policy this implements,
 *  which hard-gates.json's opaque-exec `_pattern_doc` states as the canonical contract. Pure, never throws. */
const C_SHAPE_RE = /\b(?:sh|bash|pwsh|powershell)\b/i;
function hasLiveCArg(text) {
  const s = String(text);
  return C_SHAPE_RE.test(s) && QUOTES.cArgLiveAfterFlag(s);
}

module.exports = {
  AMPUTATING_SEPARATORS, COMMAND_OPENER_STEPS, stripCommandOpeners,
  LATER_BRANCH_RE, laterBranchStarts, commandPositionCandidates,
  hasLiveCArg,
};
