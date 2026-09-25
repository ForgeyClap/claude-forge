#!/usr/bin/env node
'use strict';
/**
 * forge-gate-quotes.cjs — the ONE shared quote/heredoc-aware scanning pass for the PreToolUse gate hook and its
 * classifier (root-cause rewrite, 2026-09-24, codex-recheck wave 5 / wp-j1, after three straight waves each
 * patched a SYMPTOM and regressed a SIBLING). Before this file, forge-gate-data.cjs (bash quoteMask/
 * stripHeredocs, the INERT-DATA rule) and forge-actiongate-position.cjs (a separate, much simpler
 * simpleQuoteMask, used only for later-branch detection) each rescanned quote structure independently and
 * disagreed at the seams — N02/N04/N05 (codex-recheck p10) were all instances of the SAME root cause: two
 * scanners of the same text producing two different answers about where a quote begins, ends, or never closes.
 * This file is now the ONLY place that decides "is character position P inside a quote/heredoc body", computed
 * ONCE per command text; every caller (forge-gate-data.cjs's stripHeredocs/stripInertData,
 * forge-actiongate-position.cjs's laterBranchStarts and the `-c` argument reader) queries that SAME result with
 * ORIGINAL, unmodified offsets into that text — never a fresh mask started over on a fragment.
 *
 * TERMINATION / ROBUSTNESS (N05 codex-recheck p10, then N13 codex-recheck wave 6 / wp-k3 — a regression each
 * pass introduced, not a first bug). N05: an EMPTY heredoc, `cat > f <<'EOF'` immediately followed by `EOF` on
 * the very next line, hung the wave-4 quoteMask forever (a skip entry pointing at itself). Fixed at the root:
 * a skip is only ever recorded when its destination is STRICTLY GREATER than its key. N13: the wave-5 fix for
 * a `$(...)` command substitution's OWN nested lexical context used NATIVE RECURSION — scanQuotes() called
 * itself on a fresh substring per nesting level — which hit V8's own call-stack ceiling as an uncaught
 * RangeError around 1000-3000 levels deep, long before this file's per-call iteration guard could ever fire
 * (that guard only ever bounded ONE recursive call's own loop, never the total across the whole chain).
 * scanQuotes() below replaces the recursion with an explicit, heap-allocated STACK of paused "scan this
 * [start,end) range" frames — a nested substitution costs one array push/pop, never one more native call frame
 * — and meters EVERY unit of work (each character touched, each heredoc-delimiter search, each substitution's
 * own paren-balance count) against ONE shared, whole-scan budget, so many small attempts cannot add up to
 * unbounded work between them any more than one big one could. Exceeding the budget yields `unterminated: true`
 * — the SAME fail-closed "cannot resolve, strip/allow nothing" result every caller already treats an
 * unterminated quote as — never a hang, never a throw. Every loop in this file is bounded by an index that
 * strictly advances or by the shared work counter; nothing here recurses.
 *
 * QUOTE SEMANTICS (unchanged from the pre-existing, well-tested design; see the V05/wave-2 history this file
 * carries forward): single quotes give bash ZERO special characters, including `$(` and backslash, until the
 * next literal `'`; double quotes let `$(...)` substitution and backslash-escaping run; a `$(...)` reached
 * OUTSIDE any quote (or from inside a double quote) is its own fresh lexical context, so a fake heredoc/quote
 * nested arbitrarily deep inside one is still judged correctly. An unterminated quote or unbalanced
 * substitution poisons the rest of that scan as `unterminated` (fail closed).
 *
 * -c ARGUMENT POLICY (N02 fourth pass, then N09 codex-recheck wave 6 / wp-k3 — an over-blocking REGRESSION the
 * fourth pass introduced). hard-gates.json's opaque-exec `_pattern_doc` is the canonical statement of the
 * quoting policy this file implements for a `-c` argument's own content (bare/single/double outer forms; see
 * cArgLiveAfterFlag's own doc below for that half, unchanged since the fourth pass). N09's bug was upstream of
 * that: the fourth pass located a `-c` flag ANYWHERE in the full command text and, independently, checked
 * whether the text contained a shell name ANYWHERE in it (`\b(?:sh|bash|pwsh|powershell)\b`) — two
 * INDEPENDENTLY LOCATED conditions that were never required to belong to the SAME command. A commit message
 * that merely MENTIONED "bash -c" in prose, an unrelated program's own `-c` flag sitting in the same command
 * line as an unrelated `bash script.sh`, a `.sh` FILE EXTENSION matching the bare `sh` alternative, and a
 * plain currency amount (`$5`, `$20`) being read as if it were shell substitution syntax could all combine
 * into a false block. cArgLiveAfterFlag() below fixes this at the root: a `-c` occurrence is read ONLY when
 * (a) it is not itself sitting inside quoted DATA (a commit message, an ordinary string argument), and (b) the
 * ENCLOSING STATEMENT's own leading command word — after skipping env assignments and wrapper prefixes
 * (`sudo`/`time`/`nohup`/`exec`/`command`/`builtin`/`env`, an optional path prefix on `env`) and openers
 * (`{`/`(`/`!`/a bare `then`/`do`/`else`/`elif`/`while`/`until`/`for`/`if`/`try`/`catch`/`finally`) — is itself
 * one of `sh`/`bash`/`zsh`/`dash`/`ksh`/`pwsh`/`powershell`, bare or path-qualified (`/bin/bash`, `pwsh.exe`), a
 * QUOTED form of one of those (`"bash"`, `'/bin/bash'`), OR a word this classifier cannot resolve at all
 * (`$SHELL`, `"$SHELL"`, `${SHELL}`, `$(which bash)`) — treated as an unknown interpreter per this file's own
 * "cannot bound it -> fire" principle, so it still only fires when the `-c` argument itself turns out live.
 * Statement boundaries are found by scanning backward from the flag to the nearest UNQUOTED `;`/`&`/`|`/newline,
 * OR an unquoted, unmatched opening `(`/backtick whose own substitution or subshell contains the flag (N15,
 * codex-recheck 2026-09-24, wave 7 / wp-m1 — a REGRESSION: `x=$(bash -c "$y")` used to resolve its leading word
 * from "x=$(bash", the env-assignment regex reading straight through the substitution boundary; never a
 * separator sitting inside quoted data — the exact class of bug N04 was, reused here to keep a quoted `;`
 * inside a commit message from ever looking like a fresh statement start). A wrapper prefix's own OPTIONS
 * (`sudo -u root`, `env -i`, `nice -n 5`, `exec -a name`) are now stripped along with the wrapper word itself
 * (N15 — wave 6 stripped only the word, leaving an option like `-u` as the apparent, non-shell "leading word").
 * Separately, a `$` followed by a digit or a special parameter character (`$5`, `$1`, `$@`) is genuine shell
 * substitution syntax too (N14, codex-recheck 2026-09-24, wave 7 / wp-m1 — a REGRESSION the fifth pass
 * introduced by treating every digit/special character after `$` as inert currency); see isSubstitutionDollar()/
 * hasLiveSubstitution() below — what keeps a currency amount in an UNRELATED program's argument silent is
 * attribution (the leading-word check above), never the shape of its dollar.
 *
 * WAVE 9 (2026-09-24, codex-recheck ninth pass / wp-p1 — the attribution gaps Codex reproduced through spawned
 * `hook.run` decisions on wave 8's own head). A CLOSED backtick span with a separator INSIDE it
 * (`` bash `echo a; echo b` -c "$x" ``) lost "bash" for the same root-cause reason as N15-R (e)'s parenthesised
 * case — see statementStart's own comment. A wrapper installed with an OS executable suffix
 * (`sudo.exe`/`env.exe`/`timeout.exe`) is now recognised (WRAPPER_RE). A wrapper's own LONG option that takes a
 * space-separated value (`sudo --role r`, `env --unset FOO`, `timeout --signal KILL`) is now consumed as one
 * unit instead of leaving its value looking like the leading word (WRAPPER_LONG_VALUE_OPTS, stripWrapperOptions).
 * `timeout`'s own bare duration operand now accepts GNU coreutils' real grammar — an optional decimal point and
 * an `s`/`m`/`h`/`d` unit (`5s`, `1.5`, `0.5s`) — instead of an integer-only guess (TIMEOUT_DURATION_RE). N18 (a
 * REGRESSION wave 8's own N15-R (c) safety net introduced): that fallback fired on ANY statement whose first
 * word merely started with `-`, even with no wrapper involved at all — narrowed to fire only on genuine
 * wrapper-parsing residue (readInterpreterWord's `wrapperResidue` parameter, threaded in by
 * statementCommandWord). A program genuinely named with a leading dash sits outside this file's own grammar
 * either way — it is simply no longer treated as PROOF of an unresolvable interpreter merely for existing.
 *
 * API: scanQuotes(text) -> {inside(pos), unterminated, spans} · stripHeredocs(text) [bash-only heredoc removal,
 *      moved here unchanged in external contract from forge-gate-data.cjs] · findHeredocDelim(text, bodyStart,
 *      dash, delim, limit?) -> {delimStart, delimEnd} | null · cArgLiveAfterFlag(text) -> boolean ·
 *      isSubstitutionDollar(s, i) / hasLiveSubstitution(s) -> boolean.
 */

// A heredoc marker recognised exactly AT the scanner's current position (never searching ahead), so scanQuotes()
// can decide, character by character, whether `<<` right here really opens a heredoc.
const MARKER_AT_RE = /(?<!<)<<(?!<)(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_]\w*))/y;
// The line-scanning counterpart used by forge-gate-data.cjs's stripHeredocs() to find a marker anywhere on a
// given line (may match more than once per line, which stripHeredocs treats as "cannot resolve, strip nothing").
const MARKER_RE = /(?<!<)<<(?!<)(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_]\w*))/g;

/** findHeredocDelim(text, bodyStart, dash, delim, limit) -> {delimStart, delimEnd} | null. The ONE place either
 *  caller (scanQuotes' own literal-body skip, and forge-gate-data.cjs's stripHeredocs) locates the line whose
 *  content equals `delim` — leading tabs stripped first when `dash` is truthy — scanning forward from
 *  `bodyStart`. A trailing `\r` (CRLF line endings) is stripped before comparison, so a Windows-authored
 *  heredoc still resolves; a delimiter line carrying trailing SPACE, or one wrapped in quote characters,
 *  deliberately still does NOT match — real bash requires the closing line to consist solely of the
 *  delimiter, nothing more — so failing to resolve those (fail closed: strip/skip nothing) mirrors real shell
 *  behaviour rather than being merely cautious. Returns null (never a guess) when no such line exists before
 *  `limit` (N13, codex-recheck wave 6: defaults to `text.length` — every EXISTING caller's own bound — so this
 *  is a backward-compatible addition; scanQuotes() below passes its OWN current frame's `end` so a heredoc
 *  search inside a `$(...)` substitution's own inner range can never read past it). */
function findHeredocDelim(text, bodyStart, dash, delim, limit) {
  const lim = limit === undefined ? text.length : limit;
  let pos = bodyStart;
  while (pos <= lim) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 || nl > lim ? lim : nl;
    let line = text.slice(pos, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1); // CRLF: a trailing \r is never part of the delimiter word
    const cmp = dash ? line.replace(/^\t+/, '') : line;
    if (cmp === delim) return { delimStart: pos, delimEnd: lineEnd };
    if (nl === -1 || nl > lim) return null;
    pos = nl + 1;
  }
  return null;
}

/** scanQuotes(text) -> {inside(pos), unterminated, spans}. A BASH-ONLY, whole-text (never per-line, never
 *  per-fragment) single pass over `'`/`"` runs and `$(...)` substitutions, so a heredoc operator or a control-
 *  flow keyword that only LOOKS free-standing while actually sitting inside an already-open quote is never
 *  misread. `spans` records every TOP-LEVEL quote span found (`{start, end, kind}`, `end` exclusive past the
 *  closing quote character) in ORIGINAL-text offsets, for callers (cArgLiveAfterFlag) that need to reason
 *  about a specific argument's own outer quoting form rather than a plain inside/outside boolean. See this
 *  file's header for the N05/N13 termination-and-robustness history and the quote-semantics summary. Never
 *  throws, for any input — see the header's "meters every unit of work" note. */
function scanQuotes(text) {
  text = String(text);
  const n = text.length;
  const marks = new Array(n + 1).fill(false);
  const spans = [];
  let unterminated = false;
  let work = 0;
  const WORK_CAP = Math.max(50000, n * 30);

  /** boundedParenEnd(at, end) -> {balanced, end}. The balanced-paren count this file has always used to find a
   *  `$(...)` substitution's own end. What changed for N13: it is bounded to the CURRENT frame's own `end`
   *  (never past it, so a substitution inside a nested substitution's own inner range cannot read past that
   *  range) and metered against the SAME shared `work` budget every other step below spends from.
   *
   *  Heredoc-claim (codex-recheck 2026-09-24, wave 8 / wp-n1 — REAL, reproduced dynamically). This count used to
   *  be fully quote-blind AND walk INTO a heredoc's own literal body character-by-character, so a surplus `(`
   *  there raised `depth` with no matching `)` ever coming (the real closing `)` of the substitution sits right
   *  after the heredoc's closing delimiter line, not inside its body): `x=$(cat <<'EOF'` + a body line containing
   *  a lone `(` + `EOF` + `)` read as UNBALANCED, poisoning the WHOLE scan as `unterminated` — which, via
   *  cArgLiveAfterFlag's own "cannot bound it -> fire" rule, made an entirely unrelated LATER `-c`
   *  (`wc -c "$file"`) fire opaque-exec on a completely benign command. Fixed by mirroring the main scan loop's
   *  own heredoc-marker recognition exactly: an UNRESOLVED marker (no closing delimiter line found before `end`)
   *  is not treated as a heredoc at all and falls through to plain character-by-character counting (the same
   *  fail-safe the main loop already uses); a RESOLVED one skips straight to the first character of its own
   *  closing delimiter line, so no character inside the body — parenthesis or otherwise — is ever individually
   *  counted.
   *
   *  A LIGHTWEIGHT quote tracker (single `'`.../`'`  is fully literal; double `"`...`"` allows a `\` escape,
   *  matching this file's own existing double-quote convention) had to be added alongside that heredoc fix, not
   *  as a separate improvement but because the two are the SAME bug from opposite directions: without it, the
   *  heredoc-marker recognition above cannot tell a REAL heredoc operator in command position from a FAKE
   *  `<<EOF`...`EOF` pair sitting entirely inside a single-quoted literal (an existing, already-covered
   *  adversarial shape — V05 wave 2, `echo "$(echo '$(` + a fake nested heredoc + `rm -rf ./src` + a REAL `EOF`
   *  line further down + `)'` + `)"` ), and would otherwise skip straight past a `)` the literal quote's own
   *  content still owed to the naive paren count, breaking that already-fixed adversarial case. Skipping
   *  entire quoted spans (parens inside them included) is also strictly MORE correct than the prior "count every
   *  `(`/`)` regardless of quoting" behaviour, not merely a workaround: a `(` sitting inside a real quote was
   *  never a substitution boundary to bash either. Correct for a single, non-nested quote per span, the same
   *  simplification already accepted elsewhere in this file (see statementStart's own backtick-parity comment). */
  function boundedParenEnd(at, end) {
    let depth = 1;
    let j = at + 2;
    let quoteChar = null;
    for (; j < end && depth > 0; j++) {
      if (++work > WORK_CAP) return { balanced: false, end };
      if (quoteChar) {
        if (quoteChar === '"' && text[j] === '\\' && j + 1 < end) { j++; continue; }
        if (text[j] === quoteChar) quoteChar = null;
        continue;
      }
      if (text[j] === "'" || text[j] === '"') { quoteChar = text[j]; continue; }
      if (text[j] === '<' && text[j + 1] === '<') {
        MARKER_AT_RE.lastIndex = j;
        const hm = MARKER_AT_RE.exec(text);
        if (hm) {
          const nl = text.indexOf('\n', j + hm[0].length);
          if (nl !== -1 && nl < end) {
            const delim = hm[2] || hm[3] || hm[4];
            const body = findHeredocDelim(text, nl + 1, hm[1], delim, end);
            work += (body ? body.delimStart : end) - (nl + 1);
            if (work > WORK_CAP) return { balanced: false, end };
            if (body && body.delimStart > nl + 1) { j = body.delimStart - 1; continue; } // skip the body only
          }
        }
      }
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
    }
    return { balanced: depth === 0, end: j };
  }

  /** findBacktickEnd(at, end) -> the index of the matching (unescaped) closing backtick starting the search at
   *  `at + 1`, or -1 if none exists before `end` (N15-R (f), codex-recheck 2026-09-24, wave 8 / wp-n1). Bash
   *  backticks do not nest, so the first backtick not immediately preceded by a backslash-escape closes the
   *  span — mirrors the SAME "any backslash consumes itself plus the next character" rule this frame's own
   *  backtickInDq handling applies while scanning that content (see the header comment on the `` ` `` push
   *  below), so the two stay in lock-step about where the span actually ends. */
  function findBacktickEnd(at, end) {
    let j = at + 1;
    while (j < end) {
      if (++work > WORK_CAP) return -1;
      if (text[j] === '\\' && j + 1 < end) { j += 2; continue; }
      if (text[j] === '`') return j;
      j++;
    }
    return -1;
  }

  // N13 root fix: an explicit LIFO stack of pending "scan this [start,end) range" frames, each in ORIGINAL
  // absolute offsets into `text` — never a sliced substring. See this file's header for the full "why".
  const stack = [{ start: 0, end: n, skipTo: new Map(), i: 0, j: 0, inQuote: false, quoteChar: null, spanStart: 0 }];

  scan:
  while (stack.length) {
    const f = stack[stack.length - 1];

    if (!f.inQuote) {
      while (f.i < f.end) {
        if (++work > WORK_CAP) { unterminated = true; break scan; }
        if (f.skipTo.has(f.i)) {
          const dest = f.skipTo.get(f.i);
          f.i = dest > f.i ? dest : f.i + 1; // never accept a non-advancing or backward jump through this map
          continue;
        }
        const ch = text[f.i];
        // N15-R (f) (codex-recheck 2026-09-24, wave 8 / wp-n1): a frame pushed for a backtick found INSIDE a
        // double-quoted span (see the `` ` `` push in the quote-body loop below) carries `backtickInDq: true`
        // because ITS OWN text was written using one extra layer of backslash-escaping — per the GNU Bash manual
        // ("If the substitution appears within double quotes... embedded double quotes must be escaped" for the
        // backtick form specifically, unlike `$(...)`), `\"`/`` \` ``/`\$`/`\\` inside it are literal characters
        // the OUTER double quote's own parsing already un-escapes before handing the text to the subshell, not
        // fresh structure at THIS level. Consuming any backslash + the next character together here (never
        // opening a real quote/substitution on the escaped character) keeps that one layer from being
        // mis-parsed as real syntax, while a later BARE (non-escaped) `"`, `$(`, or backtick still opens a
        // genuine nested context scanned with ordinary, single-escape rules.
        if (f.backtickInDq && ch === '\\' && f.i + 1 < f.end) { marks[f.i] = true; marks[f.i + 1] = true; f.i += 2; continue; }
        // Security Boss over-blocking review (codex-recheck 2026-09-24, wave 7 / wp-m1) — checked, REAL: an
        // unquoted `#` at the start of a shell WORD (start of text, or right after whitespace/`;`/`&`/`|`/`(`/
        // newline) begins a bash COMMENT to the end of the line; everything in it is inert and must never be
        // quote-scanned. Before this fix an apostrophe inside a trailing comment (`echo hi # it's fine`) opened
        // a literal single quote that never closed, poisoning the REST OF THE SCAN as `unterminated` — which,
        // combined with cArgLiveAfterFlag's own pre-existing "cannot bound the quote structure -> fire" rule,
        // made an entirely unrelated `-c` flag anywhere else in the text (`wc -c "$file" # don't count this`)
        // fire opaque-exec. `#` NOT at a word start (`foo#bar`) is correctly left alone — bash only treats it as
        // a comment opener at that position. Metered like every other search in this file (N13).
        if (ch === '#' && (f.i === f.start || /[\s;&|(`\n]/.test(text[f.i - 1]))) {
          const nl = text.indexOf('\n', f.i);
          const end = nl === -1 || nl > f.end ? f.end : nl;
          work += end - f.i;
          if (work > WORK_CAP) { unterminated = true; break scan; }
          f.i = end;
          continue;
        }
        if (ch === '<' && text[f.i + 1] === '<') {
          MARKER_AT_RE.lastIndex = f.i;
          const hm = MARKER_AT_RE.exec(text);
          if (hm) {
            const delim = hm[2] || hm[3] || hm[4];
            const nl = text.indexOf('\n', f.i + hm[0].length);
            if (nl !== -1 && nl < f.end) {
              const body = findHeredocDelim(text, nl + 1, hm[1], delim, f.end);
              // N13: meter the delimiter search itself — a text carrying MANY never-resolving heredoc markers
              // used to cost one full forward scan EACH (a quadratic pattern for many markers in one text);
              // charging each search's own cost against the shared budget bounds the total regardless of how
              // many markers are tried.
              work += (body ? body.delimStart : f.end) - (nl + 1);
              if (work > WORK_CAP) { unterminated = true; break scan; }
              // N05 root-cause fix: an EMPTY body means the delimiter line already starts at nl+1 — there is
              // nothing to skip, and recording a skip THERE would be the exact self-referencing jump that hung
              // the previous implementation forever. Only a skip landing STRICTLY AFTER its own key is ever
              // recorded.
              if (body && body.delimStart > nl + 1) f.skipTo.set(nl + 1, body.delimStart);
            }
          }
        }
        if (ch === '$' && text[f.i + 1] === '(') {
          const sub = boundedParenEnd(f.i, f.end);
          if (!sub.balanced) { unterminated = true; break scan; }
          const innerStart = f.i + 2;
          const innerEnd = Math.max(innerStart, sub.end - 1);
          f.i = sub.end; // resume THIS frame right after the substitution once its own frame is done
          stack.push({ start: innerStart, end: innerEnd, skipTo: new Map(), i: innerStart, j: innerStart, inQuote: false, quoteChar: null, spanStart: 0 });
          continue scan; // process the newly pushed (innermost) frame next — depth-first, like recursion was
        }
        if (ch !== "'" && ch !== '"') { f.i++; continue; }
        marks[f.i] = true;
        f.quoteChar = ch;
        f.spanStart = f.i;
        f.j = f.i + 1;
        f.inQuote = true;
        break; // fall through to quote-body scanning immediately below, same tick
      }
      if (!f.inQuote) { stack.pop(); continue scan; } // this frame's own range is fully consumed
    }

    // f.inQuote === true here: scan this frame's OPEN quote body from f.j.
    let closed = false;
    while (f.j < f.end) {
      if (++work > WORK_CAP) { unterminated = true; break scan; }
      // single quotes suppress `$(` too — only a double quote lets a substitution run inside it.
      if (f.quoteChar === '"' && text[f.j] === '$' && text[f.j + 1] === '(') {
        const sub = boundedParenEnd(f.j, f.end);
        if (!sub.balanced) { unterminated = true; break scan; }
        const innerStart = f.j + 2;
        const innerEnd = Math.max(innerStart, sub.end - 1);
        f.j = sub.end;
        stack.push({ start: innerStart, end: innerEnd, skipTo: new Map(), i: innerStart, j: innerStart, inQuote: false, quoteChar: null, spanStart: 0 });
        continue scan;
      }
      if (f.quoteChar === '"' && text[f.j] === '\\') { marks[f.j] = true; if (f.j + 1 < f.end) marks[f.j + 1] = true; f.j += 2; continue; }
      // N15-R (f) (codex-recheck 2026-09-24, wave 8 / wp-n1 — REAL, reproduced dynamically): an UNESCAPED
      // backtick inside a double-quoted span used to be treated as ordinary quoted DATA (marked "inside" like
      // any other character of the outer string), never as its own executable substitution context — the way
      // `$(...)` already gets. That let `-c "$x"` hidden inside `echo "` + backtick + `bash -c \"$x\"` + backtick
      // + `"` read as "-c sitting inside quoted data (a commit message)" and skip entirely, exactly the class of
      // bug this classifier exists to catch (GNU Bash manual, "Command Substitution": backtick and `$(...)` both
      // have executable semantics). Pushing a fresh frame for the span between backticks — `backtickInDq: true`,
      // see the escape handling above in the outside-quote loop — leaves the ordinary characters inside it
      // (including a real "bash"/"-c") un-marked, so they are evaluated on their own terms instead of being
      // silenced as this outer string's own data.
      if (f.quoteChar === '"' && text[f.j] === '`') {
        const endTick = findBacktickEnd(f.j, f.end);
        if (endTick === -1) { unterminated = true; break scan; } // no matching close before `end` -> cannot bound it
        const innerStart = f.j + 1;
        const innerEnd = endTick;
        f.j = endTick + 1;
        stack.push({ start: innerStart, end: innerEnd, skipTo: new Map(), i: innerStart, j: innerStart, inQuote: false, quoteChar: null, spanStart: 0, backtickInDq: true });
        continue scan;
      }
      if (text[f.j] === f.quoteChar) {
        marks[f.j] = true;
        if (stack.length === 1) spans.push({ start: f.spanStart, end: f.j + 1, kind: f.quoteChar === "'" ? 'single' : 'double' });
        f.i = f.j + 1;
        f.inQuote = false;
        closed = true;
        break;
      }
      marks[f.j] = true;
      f.j++;
    }
    if (!closed && f.j >= f.end && f.inQuote) { unterminated = true; break scan; }
  }

  return { inside: (pos) => marks[pos] === true, unterminated, spans };
}

/** stripHeredocs(text) -> {text, regions, unstripped}. Bash-only literal-heredoc-body removal for the
 *  INERT-DATA rule; moved here unchanged in external contract from forge-gate-data.cjs (2026-09-24 quoting-
 *  layer redesign) so quote-state and heredoc-body resolution share exactly ONE implementation
 *  (findHeredocDelim/scanQuotes) instead of forge-gate-data.cjs's own line-array search that used to disagree
 *  with the one scanQuotes used internally. Two markers on one line, an unterminated quote anywhere in the
 *  WHOLE text, or an unresolved heredoc strip nothing; a heredoc that fails the rule is kept verbatim and
 *  skipped whole (an executed body is never re-read). */
function stripHeredocs(text, deps) {
  const { WRITER_HEAD_RE, COMMIT_HEAD_RE, writerDests, laterRisk, SCRIPT_EXT_RE } = deps;
  const qmask = scanQuotes(text);
  if (qmask.unterminated) return { text, regions: 0, unstripped: true }; // cannot tell "inside" from "outside"
  const lines = text.split('\n');
  const out = [];
  let regions = 0;
  let unstripped = false;
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const lineOffset = offset;
    offset += line.length + 1; // '\n' consumed by split; `offset` now equals this line's OWN body-start offset
    const markers = [...line.matchAll(MARKER_RE)].filter((m) => !qmask.inside(lineOffset + m.index));
    if (!markers.length) continue;
    if (markers.length > 1) return { text, regions: 0, unstripped: true };
    const [, dash, sq, dq, bare] = markers[0];
    const delim = sq || dq || bare;
    const body = findHeredocDelim(text, offset, dash, delim); // the SAME delimiter search scanQuotes() itself
    // uses (single source of truth) — `offset` here is exactly the character position right after this
    // marker line's own newline, i.e. the heredoc body's first character, in the ORIGINAL text.
    if (!body) return { text, regions: 0, unstripped: true };
    const numBodyLines = (text.slice(offset, body.delimStart).match(/\n/g) || []).length;
    const end = i + 1 + numBodyLines; // convert the offset-based match back to this function's own line index
    const bodyLines = lines.slice(i + 1, end);
    const rest = lines.slice(end + 1).join('\n');
    let ok = false;
    const w = WRITER_HEAD_RE.exec(line);
    if (w && (!bare || !/\$\(|`|\$\{/.test(bodyLines.join('\n')))) {
      ok = !writerDests(w[1], w[2], w[3]).some((d) => SCRIPT_EXT_RE.test(d)) && !laterRisk(rest);
    } else if (!bare && COMMIT_HEAD_RE.test(line)) {
      const closer = lines[end + 1] || '';
      ok = /^\)"/.test(closer) && !laterRisk(closer.slice(2) + '\n' + lines.slice(end + 2).join('\n'));
    }
    if (ok) regions++; else { unstripped = true; out.push(...bodyLines); }
    out.push(lines[end]);
    for (let k = i + 1; k <= end; k++) offset += lines[k].length + 1;
    i = end;
  }
  return { text: out.join('\n'), regions, unstripped };
}

/** skipWs(s, i) -> the index of the next non-whitespace character at/after i (or s.length). */
function skipWs(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i; }

/** isSubstitutionDollar(s, i) -> true when s[i] is a `$` character that begins REAL shell substitution syntax:
 *  a `$NAME`/`$_name` variable, a `${...}` parameter expansion, a `$(...)` command substitution, a positional
 *  parameter (`$0`..`$9`), or a special parameter (`$@ $* $# $? $- $$ $!`) — every one of these is a genuine
 *  Bash expansion (GNU Bash manual, "Positional Parameters" / "Special Parameters"). N09 (codex-recheck
 *  2026-09-24, wave 6 / wp-k3) first drew this distinction to stop a literal currency amount (`$5`, `$20`)
 *  inside an UNRELATED program's own argument from being misread as substitution syntax, but its own rule was
 *  too wide: it treated ANY digit or special character right after `$` as inert currency, which also silently
 *  passed a genuine `bash -c "$1"` / `bash -c "$@"` call (N14, codex-recheck 2026-09-24, wave 7 / wp-m1 — a
 *  REGRESSION; the existing fixture `cArgLiveAfterFlag('bash -c "$5"')` flipped from firing on the pre-wave-6
 *  classifier to silent on wave 6's own head). The distinction that actually matters was never the SHAPE of the
 *  dollar — it is WHOSE statement it sits in: cArgLiveAfterFlag()'s own attribution (statementCommandWord()) is
 *  what correctly keeps `node report.cjs -c "total $5 due"` silent (the `-c` belongs to `node`, not to an
 *  unrelated `bash` elsewhere in the line), never this function pretending `$5` itself can never be live. Only
 *  a trailing lone `$` (nothing after it) or a `$` followed by whitespace/other punctuation is ever literal. */
function isSubstitutionDollar(s, i) {
  if (s[i] !== '$') return false;
  const nx = s[i + 1];
  if (nx === undefined) return false; // a trailing lone "$" has nothing to substitute -> literal, not live
  return nx === '(' || nx === '{' || /[A-Za-z_0-9@*#?$!-]/.test(nx);
}

/** hasLiveSubstitution(s) -> true when `s` contains a backtick (always a substitution marker) or a `$` that
 *  isSubstitutionDollar() (N09 fix — replaces the old blanket `/[$\`]/` test, which treated a literal `$5`/
 *  `$20` currency amount exactly like a real `$var`/`$(...)` substitution). Pure, never throws. */
function hasLiveSubstitution(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '`') return true;
    if (s[i] === '$' && isSubstitutionDollar(s, i)) return true;
  }
  return false;
}

/** scanDoubleQuoteLive(s, i) -> true/false/null. `s[i]` must be the OPENING `"` of a `-c` argument. Reads to
 *  its matching closing `"` applying the two-shell-layer rule from this file's own header: an UNESCAPED
 *  `$`/backtick is always live (the outer shell expands it regardless of any literal `'` nearby); an ESCAPED
 *  `\$`/`` \` `` is live only when NOT currently inside a still-open literal `'` span within this same
 *  argument. N09: a `$` (escaped or not) that is a literal currency amount (isSubstitutionDollar() false) is
 *  never live. M1 (Security Boss review, codex-recheck wave 6 / wp-k3): `singleOpen` used to flip on EVERY
 *  apostrophe, including one sitting inside an INNER double-quoted span built from escaped double quotes
 *  (`\"it's fine\"`) — for the INNER `-c` interpreter that whole `\"..\"` is a literal string, so the `'` in
 *  it has no special meaning at all, and treating it as opening real protective single-quoting could wrongly
 *  suppress a LATER escaped `$`/backtick the inner shell still expands. Tracking the inner shell's own nested
 *  double-quote state exactly would need a second parser; the cheap, safe fix instead fails toward fire: once
 *  BOTH an escaped double quote and an apostrophe have been seen in the SAME argument, `singleOpen` can no
 *  longer be trusted, so every subsequent escaped `$`/backtick is treated as live regardless of it. Returns
 *  null when the quote never closes (unterminated -> the caller must fail toward fire). */
function scanDoubleQuoteLive(s, i) {
  let j = i + 1;
  let singleOpen = false;
  let live = false;
  let sawEscapedQuote = false;
  let sawApostrophe = false;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length) {
      const nx = s[j + 1];
      if (nx === '"') { sawEscapedQuote = true; j++; continue; }
      if (nx === '`' || (nx === '$' && isSubstitutionDollar(s, j + 1))) {
        if (!singleOpen || (sawEscapedQuote && sawApostrophe)) live = true; // N02 fourth pass + M1 override
        j++; continue;
      }
      if (nx === '$' || nx === '\\' || nx === '\n') { j++; continue; } // escaped literal-currency $ or other: no-op
      continue; // an unrecognised double-quote escape: the backslash is a literal char, protects nothing
    }
    if (c === "'") { sawApostrophe = true; singleOpen = !singleOpen; continue; }
    if (c === '"') return live; // closing quote of this argument
    if (c === '`') live = true; // N02 fourth pass: ALWAYS live when unescaped, regardless of singleOpen —
    else if (c === '$' && isSubstitutionDollar(s, j)) live = true; // inside double quotes, a literal `'`
    // character has no special meaning to the OUTER shell and never suppresses its expansion; only backslash
    // can protect a character from the outer shell here, and only real substitution syntax (not currency) at all.
  }
  return null; // never closed -> unterminated, fail toward fire
}

/** readBareWord(s, i) -> the shell "word" starting at i: everything up to the next whitespace or a shell
 *  metacharacter that would end an unquoted word (`;|&()<>` or newline), or the end of the string. */
function readBareWord(s, i) {
  let j = i;
  while (j < s.length && !/[\s;|&()<>]/.test(s[j])) j++;
  return s.slice(i, j);
}

const C_FLAG_OCCUR_RE = /(?:^|\s)-c\b/g;

// N09 (codex-recheck 2026-09-24, wave 6 / wp-k3) — the ASSOCIATION half of the -c argument policy: a `-c` flag
// is read only when it belongs to an ACTUAL interpreter invocation. SHELL_WORD_RE recognises that invocation's
// own leading command word, bare or path-qualified (`/bin/bash`, `pwsh.exe`, case-insensitive since Windows
// paths are). STATEMENT_BOUNDARY_RE is the (unquoted-only, see statementStart) set of characters that end one
// statement and begin another for this purpose. ENV_ASSIGN_RE/WRAPPER_RE/OPENER_RE are stripped, repeatedly,
// from a statement's own start before its leading word is read — an env assignment, a sudo/time/nohup/exec/
// command/builtin/env/doas/nice/timeout/stdbuf wrapper (optionally path-qualified, matching hard-gates.json's
// own `(?:\S*/)?env` shape for the pipe-into-interpreter rule) AND its own OPTIONS (N15 below), or a
// grouping/control-flow opener must not hide the real interpreter word behind it (`sudo bash -c $x`,
// `{ bash -c $x; }`, `if true; then bash -c $x; fi` all still associate).
const SHELL_WORD_RE = /^(?:.*[\\/])?(?:sh|bash|zsh|dash|ksh|pwsh|powershell)(?:\.exe)?$/i;
const STATEMENT_BOUNDARY_RE = /[;&|\n]/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/;
// N15 (codex-recheck 2026-09-24, wave 7 / wp-m1 — a REGRESSION): the wrapper list grows (doas/nice/timeout/
// stdbuf joined sudo/time/nohup/exec/command/builtin/env), and the wrapper WORD's own capture group lets
// stripWrapperOptions() below know which wrapper's option grammar to apply — wave 6 stripped the word but not
// its options, so `sudo -u root bash -c "$x"` resolved its leading word to "-u" and was rejected outright.
// N16 (codex-recheck 2026-09-24, wave 8 / wp-n1 — a REGRESSION false-blocking bug wave 7 introduced): `\b` after
// the wrapper alternation is a WORD/NON-WORD transition, not "end of this token" — a hyphen is a non-word
// character, so `\bsudo\b` already matches at the boundary between "sudo" and "-wrapper" in `sudo-wrapper`,
// treating an ordinary hyphenated PROGRAM NAME that merely starts with a wrapper's name as if it were that
// wrapper. stripWrapperOptions() then eats the program's own name-suffix as if it were an option (`sudo-wrapper`
// -> strip "sudo", then "-wrapper" matches the generic single-flag option grammar and is stripped too), which can
// leave an ordinary POSITIONAL ARGUMENT (`env-runner $CONFIG -c "$x"` -> "$CONFIG" is left looking like the
// leading word) misread as an unresolvable ("dynamic") interpreter and firing on a completely unrelated program.
// The wrapper token must be COMPLETE: it only counts as a wrapper name when the very next character is
// whitespace or the end of the string, never a bare word-boundary. N15-R (codex-recheck 2026-09-24, wave 9 /
// wp-p1): a wrapper installed as a Windows executable still carries its OS-supplied suffix on the invoked
// word itself (`sudo.exe -u root bash -c "$x"`, `env.exe -i bash -c "$x"`, a path-qualified
// `C:\tools\timeout.exe 5 bash -c "$x"`) — an optional, case-insensitive `.exe`/`.cmd`/`.bat` is now allowed
// between the wrapper name and the same completeness lookahead, so the suffix itself can never smuggle in
// extra trailing characters (`sudo.exestuff` still fails to match — the lookahead still requires whitespace
// or end-of-string right after the optional suffix).
const WRAPPER_RE = /^(?:\S*[\\/])?(sudo|time|nohup|exec|command|builtin|env|doas|nice|timeout|stdbuf)(?:\.(?:exe|cmd|bat))?(?=\s|$)\s*/i;
const OPENER_RE = /^(?:[{(!]\s*|(?:then|do|else|elif|while|until|for|if|try|catch|finally)\b\s*)/i;

// WRAPPER_END_OPTS_RE — N15-R (a) (codex-recheck 2026-09-24, wave 8 / wp-n1): POSIX "end of options" — once a
// wrapper's own argument list reaches a standalone `--`, every remaining token is positional even if it LOOKS
// like an option, and nothing after it is ever consumed as one of the wrapper's own flags again
// (`sudo -- bash -c "$x"`, `env -- bash -c "$x"`, `command -- bash -c "$x"`) — so it is stripped once and then
// stops the option-stripping loop outright, letting the real interpreter word resolve normally right after it.
const WRAPPER_END_OPTS_RE = /^--(?:\s+|$)/;

// WRAPPER_VALUE_OPTS — per-wrapper short options that consume the NEXT token as their own value (real getopt
// semantics, checked against the GNU/BSD manuals: `sudo -u user`/`-g group`/`-p prompt`/`-C num`/`-D dir`/
// `-R dir`/`-T timeout`/`-U user`/`-r role`/`-t type`; `env -u NAME`/`-C dir`/`-S string`; `exec -a name`;
// `nice -n adjustment`; `timeout -s signal`/`-k duration`; `stdbuf -i mode`/`-o mode`/`-e mode`; `time -f
// format`; `doas -u user`/`-C config`). `sudo -r role`/`-t type` (N15-R, codex-recheck 2026-09-24, wave 9 /
// wp-p1 — the SHORT half of the same named residual as the long `--role`/`--type` table below, real GNU
// sudo SELinux flags) join the table alongside the pre-existing letters. `sudo -h` is deliberately EXCLUDED —
// real GNU sudo's `-h` is `--help`, a no-value flag; treating it as value-taking would swallow the real
// interpreter word right after it (`sudo -h bash -c "$x"` already resolves correctly through the generic
// no-value flag strip below, proven by a dedicated regression test).
// Any other wrapper option (`env -i`, `command -p`, `time -p`, a glued `stdbuf -oL`) is a flag with no separate
// value — deliberately NOT generalised across all wrappers: `command -p`/`time -p` take no value at all, so
// treating EVERY wrapper's own `-p` as value-taking would wrongly swallow the real interpreter word right after
// it. A long option's own glued `=value` form (`env --unset=FOO`, `env --chdir=/tmp`, `timeout --signal=KILL`,
// `timeout --kill-after=5`, `nice --adjustment=5`) never needs a table entry at all — WRAPPER_OPT_RE's own
// optional `(?:=\S+)?` already consumes the whole `--name=value` token as one piece.
const WRAPPER_VALUE_OPTS = { sudo: 'ugpCDRTUrt', env: 'uCS', exec: 'a', nice: 'n', timeout: 'sk', stdbuf: 'ioe', time: 'f', doas: 'uC' };
// WRAPPER_LONG_VALUE_OPTS (N15-R, codex-recheck 2026-09-24, wave 9 / wp-p1) — the LONG-option counterpart of
// WRAPPER_VALUE_OPTS: a per-wrapper table of long option NAMES (no leading `--`, matched case-insensitively)
// that consume the NEXT SEPARATE token as their own value, checked against the same GNU/BSD manuals: `sudo
// --user=user`/`--group=group`/`--chdir=dir`/`--role=role`/`--type=type`; `env --unset=NAME`/`--chdir=dir`;
// `timeout --signal=SIG`/`--kill-after=DUR`; `nice --adjustment=N`; `stdbuf --output=MODE`; `time
// --format=FMT`. Only the SPACE-separated form (`sudo --role r`) needs this table at all — the glued `=value`
// form is already handled for free by WRAPPER_OPT_RE's own `(?:=\S+)?` (see the comment above); without this
// table, WRAPPER_OPT_RE's generic no-value strip would consume only the flag itself and leave the option's own
// value sitting where the real interpreter word is expected, misreading it as an unresolvable leading word.
const WRAPPER_LONG_VALUE_OPTS = {
  sudo: ['user', 'group', 'chdir', 'role', 'type'],
  env: ['unset', 'chdir'],
  timeout: ['signal', 'kill-after'],
  nice: ['adjustment'],
  stdbuf: ['output'],
  time: ['format'],
};
// NUMERIC_ARG_WRAPPERS — the two wrappers whose OWN bare positional argument is a number (`timeout 5`, and
// `nice`'s fallback form without `-n`), consulted only after the value/generic option steps below have already
// had a chance to consume a `-n`-style flag first. N15-R (codex-recheck 2026-09-24, wave 9 / wp-p1): `timeout`'s
// own DURATION grammar (GNU coreutils "timeout invocation") is a floating-point NUMBER with an OPTIONAL
// `s`/`m`/`h`/`d` unit suffix (`5s`, `2m`, `1h`, `1.5`, `0.5s`) — a plain integer-only regex silently left the
// unit/decimal tail attached to what looked like the leading word. `nice`'s own bare adjustment stays an
// INTEGER only (real GNU nice takes no fractional/unit form), so the two wrappers now read their own numeric
// operand with two DIFFERENT grammars rather than one shared one.
const NUMERIC_ARG_WRAPPERS = new Set(['timeout', 'nice']);
const WRAPPER_OPT_VALUE_RE = /^-([A-Za-z])\s+\S+\s*/;
const WRAPPER_LONG_OPT_VALUE_RE = /^--([A-Za-z][\w-]*)\s+\S+\s*/;
const WRAPPER_OPT_RE = /^--?[A-Za-z][\w-]*(?:=\S+)?\s*/;
const WRAPPER_NUMERIC_RE = /^\d+\s*/;
const TIMEOUT_DURATION_RE = /^(?:\d+(?:\.\d+)?|\.\d+)[smhd]?\s*/;

/** stripWrapperOptions(s, wrapperName) -> `s` with the wrapper's OWN leading option tokens stripped (N15,
 *  codex-recheck 2026-09-24, wave 7 / wp-m1; extended wave 8 / wp-n1 for N15-R (a); extended wave 9 / wp-p1 for
 *  N15-R (b) residual — long space-separated value options and timeout's own duration grammar). Tries, in
 *  order, each iteration (bounded to 8 — real invocations never carry more than a handful): the POSIX
 *  end-of-options `--` terminator, which stops the loop outright once seen (N15-R a — nothing after it is ever
 *  an option again, even if it looks like one); a value-taking SHORT option for this wrapper plus its following
 *  token (`-u root `); a value-taking LONG option for this wrapper plus its following token (`--role r ` —
 *  wave 9, checked BEFORE the generic strip below so the option's own value is never left standing in for the
 *  real command word); any other single flag token, short or long, with or without a glued `=value` (`-i `,
 *  `-oL `, `--foo=bar `); and, only for timeout/nice, a bare leading numeric operand (`5 `, `5s `, `1.5 ` — each
 *  wrapper's own grammar, see NUMERIC_ARG_WRAPPERS above) once no more flags match. Stops the instant none of
 *  these apply — the next token is the real command. */
function stripWrapperOptions(s, wrapperName) {
  const wl = String(wrapperName || '').toLowerCase();
  const valueOpts = WRAPPER_VALUE_OPTS[wl] || '';
  const longValueOpts = WRAPPER_LONG_VALUE_OPTS[wl] || [];
  const numeric = NUMERIC_ARG_WRAPPERS.has(wl);
  const numericRe = wl === 'timeout' ? TIMEOUT_DURATION_RE : WRAPPER_NUMERIC_RE;
  let out = s;
  for (let i = 0; i < 8; i++) {
    const endOpts = WRAPPER_END_OPTS_RE.exec(out);
    if (endOpts) { out = out.slice(endOpts[0].length); break; } // N15-R (a): "--" ends option parsing for good
    let m = WRAPPER_OPT_VALUE_RE.exec(out);
    if (m && valueOpts.includes(m[1])) { out = out.slice(m[0].length); continue; }
    m = WRAPPER_LONG_OPT_VALUE_RE.exec(out);
    if (m && longValueOpts.includes(m[1].toLowerCase())) { out = out.slice(m[0].length); continue; }
    m = WRAPPER_OPT_RE.exec(out);
    if (m) { out = out.slice(m[0].length); continue; }
    if (numeric && (m = numericRe.exec(out))) { out = out.slice(m[0].length); continue; }
    break;
  }
  return out;
}

/** statementStart(s, mask, pos) -> the absolute index where the statement CONTAINING `pos` begins: the
 *  character right after the nearest UNQUOTED statement-boundary character before `pos` (`;`/`&`/`|`/newline),
 *  OR an unquoted, UNMATCHED opening `(`/backtick whose own substitution/subshell contains `pos` (N15, codex-
 *  recheck 2026-09-24, wave 7 / wp-m1 — a REGRESSION: this function previously knew nothing about nested
 *  command-substitution context at all, so `x=$(bash -c "$y")` read its leading word from "x=$(bash" — the env-
 *  assignment regex consuming straight through the substitution boundary — and `$(which bash) -c "$x"` had no
 *  way to see that its own leading word is unresolvable). A `)` seen while scanning backward means everything
 *  between it and `pos` sits inside one CLOSED parenthesised span that finished entirely BEFORE `pos` — its
 *  matching `(` does not enclose `pos` and is not a boundary, so scanning continues past both; only a `(` with
 *  no unmatched `)` still owed truly encloses `pos`. Respecting the shared quote mask throughout is the N04
 *  lesson reapplied: none of `;`/`(`/`)`/backtick sitting inside quoted DATA may ever look like a fresh boundary.
 *
 *  N15-R (codex-recheck 2026-09-24, wave 8 / wp-n1 — two further REGRESSIONS wave 7's own first backtick/paren
 *  fix introduced). (e): a `;`/`&`/`|`/newline seen while `closeDepth > 0` (i.e. still inside an ALREADY-CLOSED,
 *  from `pos`'s perspective, parenthesised span scanned backward) used to end the scan immediately regardless of
 *  `closeDepth` — `bash $(echo a; echo b) -c "$x"` and `bash $(true && false) -c "$x"` lost "bash" entirely
 *  because the `;`/`&&` INSIDE the substitution's own un-marked text (scanQuotes does not mark ordinary
 *  characters inside a `$(...)` frame as "inside") looked like a real boundary before the matching `(` was ever
 *  reached. Both `` ` ``/boundary checks below are now gated on `closeDepth === 0`.
 *  (d): a backtick has no distinct open/close character, so treating the NEAREST unquoted one as an opening
 *  boundary is wrong whenever it is actually the CLOSING half of a pair that finished entirely before `pos`
 *  (`` bash `echo` -c "$x" `` lost "bash" because the closing tick of `` `echo` `` was mistaken for an opener).
 *  `btPending` tracks PARITY instead: an EVEN count of unquoted backticks seen so far means the next one starts a
 *  fresh, still-open (from `pos`'s view) candidate span; an ODD count means it PAIRS WITH that candidate, closing
 *  a span that sits entirely before `pos` and clearing the candidate. Correct for a single, non-nested
 *  `` `...` `` span, the only shape these gates need.
 *
 *  N15-R residual (codex-recheck 2026-09-24, wave 9 / wp-p1 — the backtick counterpart of (e) above, same root
 *  cause). A `;`/`&`/`|`/newline seen while `btPending !== -1` (i.e. scanning backward THROUGH the still-
 *  unresolved interior of a candidate span whose closing tick was already found, hunting for its opener) used
 *  to end the scan immediately regardless of that pending state — `` bash `echo a; echo b` -c "$x" ``,
 *  `` bash `true && false` -c "$x" `` and `` bash `a | b` -c "$x" `` all lost "bash" because the separator
 *  INSIDE the backtick span's own un-marked text (statementStart's backtick handling, unlike scanQuotes, never
 *  marks the span's interior as "inside" anything) looked like a real boundary before the matching (opening)
 *  backtick was ever reached. The fix mirrors (e) exactly: a boundary character is only ever a real statement
 *  boundary when BOTH `closeDepth === 0` AND `btPending === -1` (no still-unresolved candidate span). */
function statementStart(s, mask, pos) {
  let i = pos - 1;
  let closeDepth = 0;
  let btPending = -1; // -1 = even backtick parity so far (no pending candidate); >=0 = an odd, still-open backtick
  while (i >= 0) {
    if (!mask.inside(i)) {
      const ch = s[i];
      if (ch === ')') { closeDepth++; i--; continue; }
      if (ch === '(') {
        if (closeDepth > 0) { closeDepth--; i--; continue; }
        return i + 1;
      }
      if (closeDepth === 0) {
        if (ch === '`') {
          btPending = btPending === -1 ? i : -1;
          i--; continue;
        }
        // N15-R residual: a separator found while btPending is still set sits INSIDE a candidate backtick span
        // whose fate (closed-before-pos vs. genuinely open) is not yet known — never a real boundary on its own.
        if (btPending === -1 && STATEMENT_BOUNDARY_RE.test(ch)) {
          return i + 1;
        }
      }
    }
    i--;
  }
  if (btPending !== -1) return btPending + 1;
  return 0;
}

/** readInterpreterWord(s) -> { word, dynamic } — the leading executable word of `s` (a statement already
 *  stripped of env assignments/wrapper prefixes/openers), in every quoting form this policy must recognise
 *  (N15, codex-recheck 2026-09-24, wave 7 / wp-m1). A bare word reads exactly as before (readBareWord). A
 *  QUOTED word (`"bash"`, `'/bin/bash'`, `"C:\Program Files\...\pwsh.exe"`) has its own wrapping quotes
 *  stripped before SHELL_WORD_RE ever sees it — single-quoted content is always literal to the outer shell;
 *  double-quoted content is literal too UNLESS it holds a live substitution marker itself, in which case the
 *  word is DYNAMIC (`"$SHELL"`). A leading `$(`, `${`, a bare `$NAME`, or a backtick — unquoted — is also
 *  DYNAMIC (`$(which bash)`, `${SHELL}`). `dynamic:true` means this classifier cannot read what the statement
 *  will actually run, so — this file's own "cannot bound it -> fire" principle, already applied to an
 *  unresolved quote mask elsewhere — the caller treats it as an interpreter for the ASSOCIATION test alone; it
 *  still only fires once the `-c` argument itself turns out live, so a static `"$SHELL" -c "echo hi"` stays
 *  silent exactly like a known `bash -c "echo hi"` does.
 *
 *  N15-R (c) SAFETY NET (codex-recheck 2026-09-24, wave 8 / wp-n1; NARROWED wave 9 / wp-p1 for N18). The real fix
 *  for any wrapper option grammar this file did not foresee: if, after every env-assignment/wrapper-prefix/
 *  opener strip has already run, the resolved bare word STILL starts with `-` (a leftover, unconsumed option
 *  token — `--` included), that is itself proof the real command word was never reached — but ONLY when a
 *  wrapper prefix was actually stripped somewhere in that statement (`wrapperResidue`, threaded in by
 *  statementCommandWord below). N18 (codex-recheck 2026-09-24, wave 9 / wp-p1 — a REGRESSION): applying this
 *  fallback unconditionally treated ANY statement whose first word merely happens to start with `-` as an
 *  unresolvable interpreter, even with no wrapper involved at all (`-foo -c "$x"`, an ordinary hypothetical
 *  executable literally named with a leading dash) — a real, if unusual, program name is not proof of anything
 *  by itself; only a dash-token left over AFTER wrapper-option parsing genuinely proves parsing ran out of
 *  known shapes. With a wrapper present, every existing positive keeps firing (`sudo -Z bash -c "$x"`,
 *  `sudo --unknown-flag bash -c "$x"`) — none of them actually depend on this fallback (both resolve to "bash"
 *  through the ordinary generic-flag strip already), and a genuinely un-parseable wrapper option shape (a
 *  dash immediately followed by a non-letter, which none of WRAPPER_OPT_VALUE_RE/WRAPPER_LONG_OPT_VALUE_RE/
 *  WRAPPER_OPT_RE can match at all) still correctly falls through to this fallback and fires. */
function readInterpreterWord(s, wrapperResidue) {
  const c = s[0];
  if (c === '"' || c === "'") {
    const close = s.indexOf(c, 1);
    if (close !== -1 && (close + 1 >= s.length || /[\s;|&()<>]/.test(s[close + 1]))) {
      const content = s.slice(1, close);
      if (c === '"' && hasLiveSubstitution(content)) return { word: null, dynamic: true };
      return { word: content, dynamic: false };
    }
  }
  if (/^(?:\$\(|\$\{|\$[A-Za-z_]|`)/.test(s)) return { word: null, dynamic: true };
  const word = readBareWord(s, 0);
  if (wrapperResidue && word !== '' && word[0] === '-') return { word: null, dynamic: true }; // N15-R (c) / N18
  return { word, dynamic: false };
}

/** statementCommandWord(stmt) -> { word, dynamic } — the leading command word of a statement's own text (see
 *  readInterpreterWord), after repeatedly stripping env assignments, wrapper prefixes AND THEIR OWN OPTIONS
 *  (N15), and grouping/control-flow openers from its start (capped so a pathological input cannot loop
 *  unboundedly; ordinary statements resolve in one or two strips). Tracks whether a wrapper prefix was ever
 *  actually stripped (`wrapperResidue`, N18, wave 9 / wp-p1) and forwards that to readInterpreterWord so its own
 *  leftover-dash-option fallback applies only to genuine wrapper-parsing residue, never to an ordinary
 *  statement that never involved a wrapper at all. */
function statementCommandWord(stmt) {
  let s = String(stmt).replace(/^\s+/, '');
  let wrapperResidue = false;
  for (let i = 0; i < 12; i++) {
    const before = s;
    s = s.replace(ENV_ASSIGN_RE, '');
    const wm = WRAPPER_RE.exec(s);
    if (wm) { wrapperResidue = true; s = stripWrapperOptions(s.slice(wm[0].length), wm[1]); }
    s = s.replace(OPENER_RE, '');
    if (s === before) break;
  }
  return readInterpreterWord(s, wrapperResidue);
}

/** cArgLiveAfterFlag(text) -> boolean. The -c ARGUMENT POLICY (see this file's header) implemented for all
 *  three outer quoting forms, now ASSOCIATED with a real interpreter invocation (N09). Locates every
 *  standalone `-c` token in `text`; a token sitting inside quoted DATA, or whose ENCLOSING STATEMENT's own
 *  leading command word is not an actual shell interpreter, is not a real flag and is skipped. For a token
 *  that IS associated, the very next shell word — bare, single-quoted, or double-quoted — is read exactly as
 *  before; the function fires the instant any one of them is judged live. If the shared quote mask itself
 *  could not be resolved (`unterminated`), neither "is this occurrence quoted data" nor "where does this
 *  statement start" can be trusted, so — matching this file's own "cannot bound it -> fire" principle for an
 *  unterminated -c argument below — the presence of ANY `-c` token at all is enough to fire; ordinary text
 *  with no `-c` token anywhere is completely unaffected by an unrelated unresolved quote elsewhere. Pure,
 *  never throws. */
function cArgLiveAfterFlag(text) {
  const s = String(text);
  const mask = scanQuotes(s);
  const re = new RegExp(C_FLAG_OCCUR_RE.source, 'g');
  let m;
  while ((m = re.exec(s)) !== null) {
    const cStart = m.index + m[0].length - 2; // m[0] is "-c" or "\s-c"; the flag itself is its last 2 chars
    if (mask.unterminated) return true; // cannot bound the quote structure at all -> fail toward fire
    if (mask.inside(cStart)) continue; // N09: "-c" sitting inside quoted DATA (e.g. a commit message) is not a real flag
    const attribution = statementCommandWord(s.slice(statementStart(s, mask, cStart), cStart));
    // N09/N15: associate with the real invocation — a known shell word, OR an unresolvable ("dynamic") one,
    // both count; a resolvable word that is NOT a shell (e.g. "node", "wc", a leftover option) does not.
    if (!attribution.dynamic && !SHELL_WORD_RE.test(attribution.word || '')) continue;
    const i = skipWs(s, m.index + m[0].length);
    if (i >= s.length) continue; // a trailing "-c" with nothing after it: no argument to judge
    const ch = s[i];
    if (ch === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return true; // unterminated -> cannot bound -> fire
      if (hasLiveSubstitution(s.slice(i + 1, close))) return true;
      continue;
    }
    if (ch === '"') {
      const r = scanDoubleQuoteLive(s, i);
      if (r === null || r === true) return true;
      continue;
    }
    if (hasLiveSubstitution(readBareWord(s, i))) return true;
  }
  return false;
}

module.exports = {
  scanQuotes, stripHeredocs, findHeredocDelim,
  cArgLiveAfterFlag, scanDoubleQuoteLive, readBareWord, isSubstitutionDollar, hasLiveSubstitution,
  MARKER_RE, MARKER_AT_RE,
};
