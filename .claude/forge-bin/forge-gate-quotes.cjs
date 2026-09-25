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
 * WAVE 10 (2026-09-24, codex-recheck tenth pass / wp-q1 -- N15-R residual, DOC9). Codex own recommendation:
 * "either recognize supported grammar or conservatively treat unresolved attribution as opaque." The wave-7..9
 * wrapper-option strip was never actually a per-wrapper GRAMMAR: WRAPPER_OPT_RE stripped ANY hyphen-led token,
 * known or not, as if it were a bare no-value flag, so a real but UNTABLED long option ate only the flag and
 * left its own VALUE standing in for the leading word (`sudo --user root` before this wave own table expansion,
 * `sudo -p "Enter password: "` -- a QUOTED value carrying its own space, split by the old `\S+`-based value
 * regex -- P15-long-quoted-space-value). This wave replaces that catch-all with a CLOSED, per-wrapper grammar
 * built from each wrapper own GNU/BSD manual (WRAPPER_NOVALUE_SHORT/LONG, WRAPPER_VALUE_OPTS/
 * WRAPPER_LONG_VALUE_OPTS, WRAPPER_LONG_OPTIONAL_VALUE_OPTS, WRAPPER_ALWAYS_DYNAMIC_SHORT/LONG): every no-value
 * flag, every value-taking flag (space-separated, `=`-glued, AND short-glued -- `-u value`/`--name=value`/
 * `-uvalue`, read via readOptionValue() as ONE complete shell word so a quoted value own internal space is
 * never split -- P15-long-sudo-prompt/P15-long-stdbuf-input/P15-long-time-output), each wrapper own
 * positional-operand grammar (an `env NAME=VALUE` assignment; `timeout` real GNU coreutils DURATION -- a
 * strtod float, optional exponent, optional `s`/`m`/`h`/`d` unit, TIMEOUT_DURATION_RE --
 * P15-duration-exponent/P15-duration-trailing-decimal; `nice` bare, optionally-signed integer), and the
 * POSIX `--` terminator. A token fitting NONE of those shapes no longer falls through to a blind strip-and-
 * hope -- it makes the WHOLE statement own attribution unresolvable (`dynamic: true`) immediately, exactly like
 * an unknown interpreter word already was; there is no remaining "strip it anyway" branch for an option this
 * file has not heard of to hide behind. `env -S`/`--split-string` is unconditionally unresolvable regardless of
 * what follows it -- its entire purpose is handing its OWN argument list to the invoked program (GNU coreutils
 * env manual), so nothing after it can be read as "consume the value, then keep parsing options" the way an
 * ordinary value option can. A GNU getopt_long OPTIONAL-argument option (`env --default-signal[=SIG]`) only
 * ever takes its value glued (`=SIG`); a bare `--default-signal bash -c "$x"` leaves "bash" alone as the next,
 * separate token -- exactly real getopt_long behaviour, and the reason optional-value options need their own
 * table rather than reusing the ordinary value-option code path. This SUPERSEDES the wave-8 N15-R (c) safety
 * net / wave-9 N18 fix that used to live inside readInterpreterWord (a heuristic: "a resolved word that still
 * starts with `-`, but only after a wrapper actually stripped something") -- that heuristic is now UNREACHABLE
 * by construction, because stripWrapperOptions() itself resolves every dash-led token inside a wrapper own
 * argument list, one way or the other, before readInterpreterWord ever sees what remains; the parameter and
 * the fallback are removed rather than kept as dead code a future pass might mistakenly trust again. Backtick
 * pairing (statementStart) also gained one more correctness fix this wave: an ESCAPED backtick (`\``) never
 * takes part in the open/close parity count -- it is one layer of literal text belonging to an OUTER
 * interpreter own nested substitution (`` bash `echo \`x\`` -c "$x" `` -- real, legal nested-backtick syntax,
 * GNU Bash manual, Command Substitution), exactly like scanQuotes own backtickInDq handling already treats it
 * going forward; counting it as a real pairing character could shift the parity enough to lose the leading
 * "bash" attribution when a real statement-boundary character sits between the escaped and unescaped pairs.
 *
 * WAVE 11 (2026-09-24, codex-recheck eleventh pass / wp-s1, P16) closed a class of budget-exhaustion and
 * partial-word-reading regressions the wave-10 grammar itself introduced (see stripWrapperOptions/readOptionValue/
 * statementCommandWord's own doc comments for the per-symbol detail) and widened the wrapper/interpreter lists
 * with su/runuser and a dozen common process wrappers.
 *
 * WAVE 12 (2026-09-24, codex-recheck twelfth pass / wp-t1, sec-w11) — an INDEPENDENT Security Boss review of the
 * wave-11 head found one HIGH and several mediums/lows eleven Codex passes had missed. SB-H1 (HIGH):
 * stripEnvAssignment reads an env assignment's own VALUE as a complete shell word (see its own doc) instead of
 * stopping at the first unquoted space. SB-M1/SB-M3: the wave-10/11 strtod-grammar reader is RETIRED outright
 * (WRAPPER_POSITIONAL_OPERAND consumes one complete word content-unchecked instead), which also folds in
 * chroot/flock/chrt/taskset's own previously-unmodelled mandatory operand (flock also gets su/runuser's own
 * `-c`-is-a-shell treatment for its OWN `-c` mode). SB-M2: statementStart recognises an unquoted brace-group `{`
 * and a standalone `then`/`do` keyword end as real boundaries too, and CASE_ARM_RE strips a leading case-arm
 * label the same way the sibling OTHER-command-gates file already did. SB-M4: fish/csh/tcsh/mksh/ash join
 * SHELL_WORD_RE; pkexec/winpty/busybox/fakeroot/unshare/nsenter/wsl join the wrapper list. SB-M5: cArgLiveAfterFlag
 * now shares ONE work budget (see its own doc) across every `-c` occurrence, bounding total cost to roughly
 * linear in the text's own length regardless of how many occurrences exist. SB-L1: readUnquotedWord (see its own
 * doc) reads a wrapper/interpreter word as a COMPLETE shell word — mixed quoted/bare/escaped segments, tried
 * both escape-resolved and escape-literal — rather than a single quoted-or-bare span. SB-L2: sudo's own `-h`
 * ambiguity now applies inside a cluster too, and `--preserve-env[=list]` is a tabled optional-value option.
 * SB-L3 names an already-covered shape (a live substitution inside `env -S`'s own operand) explicitly. See
 * hard-gates.json's own opaque-exec `_gate_coverage` prose (ELEVENTH PASS paragraph) for the full write-up with
 * every concrete example, cross-checked against real classify() output by that file's own `_claim_probes` WELD
 * mechanism.
 *
 * WAVE 12 FOLLOW-UP (2026-09-25, wp-u1) — a live probe of the real hook on wave 12's own head (commit c6dff4e)
 * found two of 47 shapes not yet covered, plus a named prose gap. (1) Windows `cmd`/`cmd.exe`, reachable from a
 * Bash-tool call on the owner's Windows machine, executes its own `/C`/`/K` argument exactly like `bash -c`'s
 * own `-c` — an opaque-exec vector this file had no grammar for at all, every interpreter it already knew using
 * a dash-led `-c`, never a slash-led Windows switch. `cmd`/`cmd.exe` (case-insensitive, path-qualified or not,
 * quoted or not, its own preceding switches `/A`/`/U`/`/Q`/`/D`/`/S`/`/E:ON|OFF`/`/F:ON|OFF`/`/V:ON|OFF` per the
 * real `cmd /?` reference stripped the same way a wrapper's own options already are) is now recognised as its
 * own interpreter, its `/C`/`/K` argument read with the IDENTICAL two-shell-layer policy `-c` already gets
 * (cmdAssociatesFlag/CMD_FLAG_OCCUR_RE, below). Because `/` is also a Windows/MSYS path character (Git Bash's
 * own drive-letter convention writes `C:\` as `/c/...`), the flag token is only ever recognised when followed
 * by whitespace, a quote/backtick, or the end of the text — never by another slash-delimited path segment — so
 * `cd /c/Users/YOU` is never mistaken for cmd's own flag (and its leading word "cd" would not attribute to
 * "cmd" regardless). (2) `env -S`/`--split-string`'s own operand (already unconditionally unresolvable) was
 * only ever checked for a LATER, separate `-c` token in the SAME statement; a live marker sitting INSIDE the
 * operand itself, with no such later token (`env -S 'sh -c ${X}'`), fired on nothing, because the `-c` written
 * inside that operand's own quotes was correctly read as quoted DATA by the ordinary `-c` pass — right for an
 * ordinary quoted argument, wrong here, since GNU env's own `-S` re-splits and re-execs that operand's text as
 * a fresh command line, expanding `${VAR}`/`$VAR` in it regardless of what OUTER shell quoting wrapped it. The
 * operand is now read directly for a live substitution (envAssociatesFlag/ENV_SPLIT_FLAG_OCCUR_RE, below),
 * parallel to (never replacing) the existing `-c` pass. (3) A named prose gap this probe also found: GNU find's
 * own `-exec`/`-execdir` clause hands its own COMMAND to exec() as a fresh invocation, but was never a
 * recognised statement boundary for this file's own `statementStart()`, so `find . -exec bash -c "$x" \;` used
 * to resolve its leading word all the way back to "find" (a real, non-shell program) and stayed silent.
 * `-exec`/`-execdir` (case-sensitive — real GNU find flags are lowercase-only) is now a recognised boundary too
 * (execBoundaryEnd, wired into statementStart()), guarded the same word-boundary-safe way every other boundary
 * in that function already is so WSL's own unrelated `--exec` long option is never mistaken for it (the extra
 * leading `-` fails the "must be preceded by whitespace, not glued onto more text" check).
 *
 * API: scanQuotes(text) -> {inside(pos), unterminated, spans} · stripHeredocs(text) [bash-only heredoc removal,
 *      moved here unchanged in external contract from forge-gate-data.cjs] · findHeredocDelim(text, bodyStart,
 *      dash, delim, limit?) -> {delimStart, delimEnd} | null · cArgLiveAfterFlag(text) -> boolean ·
 *      isSubstitutionDollar(s, i) / hasLiveSubstitution(s) -> boolean · stripEnvAssignment(s) -> string | null
 *      (wave 12, SB-H1 — also used by forge-actiongate-position.cjs's stripCommandOpeners for the iex/eval gate).
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
 *  metacharacter that would end an unquoted word (`;|&()<>` or newline), or the end of the string. A
 *  backslash-escaped character (including an escaped space) is consumed together with its escape and never
 *  ends the word early (wave 11, codex-recheck eleventh pass / wp-s1 -- the same "any word reader that stops
 *  at ... an escape" class Codex found in readOptionValue below, applied here too for consistency). */
function readBareWord(s, i) {
  let j = i;
  while (j < s.length) {
    if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
    if (/[\s;|&()<>]/.test(s[j])) break;
    j++;
  }
  return s.slice(i, j);
}

/** findClosingQuote(s, i, quoteChar) -> the index of the matching, unescaped closing `quoteChar` starting the
 *  search at `i + 1`, or -1 if none exists before the end of `s` (wave 11, codex-recheck eleventh pass /
 *  wp-s1). `s[i]` must be the OPENING quote. Mirrors scanQuotes' own double-quote escape rule exactly (a
 *  backslash inside a DOUBLE-quoted span consumes itself plus the next character; a SINGLE-quoted span has no
 *  escape character at all -- bash gives it none) so every reader in this file that needs to find "where does
 *  this quoted word end" agrees with the shared quote scanner instead of re-deriving its own, slightly
 *  different rule (the bug class `readInterpreterWord`'s own `s.indexOf(c, 1)` had: it stopped at the FIRST
 *  literal quote character, escaped or not, misreading `"a\"b"` as ending after two characters). */
function findClosingQuote(s, i, quoteChar) {
  let j = i + 1;
  while (j < s.length) {
    if (quoteChar === '"' && s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
    if (s[j] === quoteChar) return j;
    j++;
  }
  return -1;
}

/** skipParenSubstitution(s, at) -> the index right after the matching `)` of a `$(...)` command substitution
 *  whose OWN opening `(` sits at s[at] (wave 12, codex-recheck twelfth pass / wp-t1, SB-H1). A single, non-
 *  nested quote span inside the substitution's own text is tracked (mirrors scanQuotes' own boundedParenEnd
 *  convention: single quotes fully literal, double quotes allow a backslash escape) so a `)` sitting inside a
 *  quoted segment of the substitution's own content is never mistaken for its closing paren. This is a light,
 *  local helper for readOptionValue below, not the whole-command scanQuotes() pass — it only ever runs on a
 *  short option/assignment VALUE, never the full command text. Returns `s.length` when the substitution never
 *  closes (fail-safe: consume to the end, the same convention findClosingQuote/readOptionValue already use for
 *  an unterminated quote). */
function skipParenSubstitution(s, at) {
  let depth = 1;
  let j = at + 1;
  let quoteChar = null;
  while (j < s.length && depth > 0) {
    const c = s[j];
    if (quoteChar) {
      if (quoteChar === '"' && c === '\\' && j + 1 < s.length) { j += 2; continue; }
      if (c === quoteChar) quoteChar = null;
      j++; continue;
    }
    if (c === "'" || c === '"') { quoteChar = c; j++; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    j++;
  }
  return j;
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
// WAVE 11 (2026-09-24, codex-recheck eleventh pass / wp-s1): `su`/`runuser` are added here rather than to the
// WRAPPER table below, because their own `-c` IS a shell invocation (real `su`/`runuser` manuals: `-c COMMAND`
// runs COMMAND through the target user's shell), not a prefix hiding a SEPARATE later interpreter word --
// `su -c "$x"` and `runuser -c "$x"` need no option table at all, since the text this classifier ever hands to
// statementCommandWord for a `-c` occurrence already stops BEFORE that same `-c` (see cArgLiveAfterFlag's own
// `s.slice(statementStart(...), cStart)`), so the leading bare word ("su"/"runuser") is read correctly by
// readBareWord regardless of whatever own options/positionals (`- user`, `-u user`) sit after it in the slice.
// WAVE 12 (codex-recheck twelfth pass / wp-t1, SB-M4): `fish`/`csh`/`tcsh`/`mksh`/`ash` join -- every one of
// them accepts a `-c COMMAND` form on a beginner's own machine (fish shell, *BSD/macOS csh/tcsh, mksh, and
// BusyBox/Alpine's own `ash`) with the identical executable semantics this whole SHELL_WORD_RE set already
// exists for.
const SHELL_WORD_RE = /^(?:.*[\\/])?(?:sh|bash|zsh|dash|ksh|pwsh|powershell|su|runuser|fish|csh|tcsh|mksh|ash)(?:\.exe)?$/i;
const STATEMENT_BOUNDARY_RE = /[;&|\n]/;
// ENV_ASSIGN_RE used to be a bare `=\S*\s*` regex (stopped at the first unquoted space in the VALUE — SB-H1,
// wave 12, codex-recheck twelfth pass / wp-t1); both call sites now go through stripEnvAssignment() above,
// which reads the value as a complete shell word instead. Kept as a plain name-only matcher nowhere else in
// this file needs the value half at all.
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
// WAVE 11 (2026-09-24, codex-recheck eleventh pass / wp-s1, P16-unknown-wrapper): the common PROCESS wrappers
// Codex named join the list -- `setsid`/`ionice`/`chrt`/`taskset`/`unbuffer`/`flock`/`caffeinate`/
// `systemd-run`/`chroot`/`strace`/`ltrace`/`valgrind`/`xargs`. None of these get a per-option table (their real
// grammars are either simple enough that "no options recognised" never matters for the no-flags shape that
// matters here, or genuinely too open to table faithfully) -- every WRAPPER_NOVALUE_*/WRAPPER_VALUE_OPTS/etc.
// lookup below already defaults to `''`/`[]` for an unlisted name, so ANY dash-led token right after one of
// these makes the whole invocation unresolvable in stripWrapperOptions() (Codex's own explicit permission:
// "where a wrapper's option grammar is too open to table, treat the wrapper as UNRESOLVABLE whenever any
// option is present") while the plain, no-option form (`setsid bash -c "$x"`, `xargs bash -c "$x"`) still
// resolves normally straight through to the real command word. `xargs` in particular hands its own trailing
// argument to exec() as a program (GNU findutils xargs manual) -- `xargs bash -c "$x"` and, with an option
// present, `echo x | xargs -I{} bash -c "$x"` (unresolvable via the same "any option, no table" rule, which
// still counts as associated per this file's own "cannot bound it -> fire" principle). Documented, not fixed,
// the same way wrapper NAMES have always worked here: a program not on this list at all stays a resolvable
// non-shell word (silent) -- wrappers outside this list are treated as programs.
// WAVE 12 (codex-recheck twelfth pass / wp-t1, SB-M4): widened for a beginner's own machine. `pkexec`/`winpty`/
// `busybox`/`fakeroot`/`unshare`/`nsenter` join with deliberately EMPTY option tables (the same "any option,
// no table -> unresolvable; no-option form resolves straight through" convention every wave-11 process wrapper
// already uses) -- `pkexec bash -c "$x"`, `winpty bash -c "$x"`, `busybox sh -c "$x"` (busybox's OWN first
// operand names the applet to run, so "sh"/"ash" right after it resolves as the real interpreter word exactly
// like any other wrapped command), `fakeroot bash -c "$x"`, `unshare bash -c "$x"` and `nsenter bash -c "$x"`
// all associate. `wsl` gets a SMALL real table instead of an empty one (Windows Subsystem for Linux's own CLI
// options are simple and well-known: `-e`/`--exec` runs the rest of the command line directly with no further
// shell involved, `-d`/`--distribution`, `-u`/`--user` each take one value, `--cd` takes one value, and `--`
// ends WSL's own options) -- `wsl bash -c "$x"`, `wsl -d Ubuntu bash -c "$x"` and `wsl -u root -- bash -c "$x"`
// all associate through the ordinary wrapper machinery.
const WRAPPER_NAMES = [
  'sudo', 'time', 'nohup', 'exec', 'command', 'builtin', 'env', 'doas', 'nice', 'timeout', 'stdbuf',
  'setsid', 'ionice', 'chrt', 'taskset', 'unbuffer', 'flock', 'caffeinate', 'systemd-run', 'chroot',
  'strace', 'ltrace', 'valgrind', 'xargs', 'pkexec', 'winpty', 'busybox', 'fakeroot', 'unshare', 'nsenter', 'wsl',
].join('|');
// WRAPPER_NAME_ONLY_RE -- the wrapper-name grammar anchored as a COMPLETE string (no trailing `(?=\s|$)`
// lookahead needed since the caller already knows the whole candidate word), used by matchWrapper() below via
// readUnquotedWord's own fully-unquoted text. The prefix is `.*` (SB-L1, wave 12), NOT `\S*`, because a QUOTED
// wrapper word's own unquoted text can legitimately contain a space (`"C:\Program Files\Git\usr\bin\env.exe"
// bash -c "$x"` — real Windows paths, the exact reason it needed quoting in the first place) — mirrors
// SHELL_WORD_RE's own already-`.*` prefix below rather than reintroducing the space-blind assumption for
// wrappers alone.
const WRAPPER_NAME_ONLY_RE = new RegExp('^(?:.*[\\\\/])?(' + WRAPPER_NAMES + ')(?:\\.(?:exe|cmd|bat))?$', 'i');
const OPENER_RE = /^(?:[{(!]\s*|(?:then|do|else|elif|while|until|for|if|try|catch|finally)\b\s*)/i;
// CASE_ARM_RE -- SB-M2, wave 12 (codex-recheck twelfth pass / wp-t1, sec-w11): a `case … )` arm label, the same
// shape forge-actiongate-position.cjs's own COMMAND_OPENER_STEPS already strips for the OTHER command gates
// (eval/iex) — this classifier's own `-c` attribution needed the identical strip: `case $a in x) bash -c
// "$x";; esac` used to lose "bash" because statementStart's backward scan reads the arm label's own closing
// `)` as an unmatched PAREN (closeDepth stays > 0 for the rest of the scan, since no matching `(` ever
// follows), and the resulting full-text-from-0 slice never got the leading "case … )" text stripped by any
// existing forward step. Requires a real WHITESPACE after "case" (never a bare `\b`, the exact N16 completeness
// bug class already fixed elsewhere in this file) so an ordinary hyphenated program merely starting with the
// word "case" can never match by accident. A single, non-greedy stop at the FIRST unquoted-in-appearance `)` is
// the same approximation COMMAND_OPENER_STEPS already accepts (case patterns essentially never contain a
// literal `)` of their own) — good enough for a case ARM label, never a general parser.
const CASE_ARM_RE = /^case(?=\s)\s+[\s\S]*?\)\s*/i;

/** readUnquotedWord(s, i) -> { text, textLiteral, end, dynamic }. Reads ONE complete shell word starting at
 *  s[i] — glued quoted and bare segments with no separating whitespace, exactly the same word boundary
 *  readOptionValue already uses. `text` UNQUOTES it the way the outer shell actually would: a single-quoted
 *  segment copied verbatim (bash gives it zero escape meaning), a double-quoted segment with its own
 *  `\"`/`` \` ``/`\$`/`\\` escapes resolved (an unrecognised escape's backslash is left as a literal character
 *  too, matching scanDoubleQuoteLive's own convention; a live, unescaped `$...`/backtick substitution inside it
 *  makes the WHOLE word `dynamic: true`), and a bare segment's own backslash-escapes resolved the same way (the
 *  escaped character is literal, the backslash itself removed) — SB-L1, wave 12 (codex-recheck twelfth pass /
 *  wp-t1): `"ba"sh -c "$x"` (two glued segments forming "bash") and `s\udo bash -c "$x"` (a bare escaped
 *  character folding "s\u"+"do" into the literal "sudo") both need this to resolve their real text.
 *
 *  `textLiteral` is the SAME word with quotes stripped exactly the same way, but a BARE segment's own
 *  backslashes kept AS LITERAL TEXT alongside the character they precede (never resolved as an escape) — the
 *  pre-wave-12 readBareWord convention, kept ALONGSIDE `text` rather than replaced by it, because a bare
 *  backslash on a beginner's own Windows machine is at least as often a PATH SEPARATOR as it is a genuine bash
 *  escape: `C:\tools\timeout.exe 5 bash -c "$x"` (a pre-existing, dynamically-verified fixture) must keep
 *  matching a wrapper's own `.exe` suffix via its literal backslashes, exactly as before, while `s\udo` still
 *  needs the ESCAPE reading to reveal "sudo". Both callers below try `text` first, then `textLiteral` — SHELL_
 *  WORD_RE/WRAPPER_NAME_ONLY_RE only ever gain a match this way, never lose one either interpretation already
 *  had. `end` is the index right after the word (readOptionValue's own convention; identical for both texts,
 *  since they consume exactly the same characters). */
function readUnquotedWord(s, i) {
  let j = i;
  let text = '';
  let textLiteral = '';
  let dynamic = false;
  while (j < s.length) {
    const c = s[j];
    if (c === "'") {
      const close = findClosingQuote(s, j, c);
      const stop = close === -1 ? s.length : close;
      const body = s.slice(j + 1, stop);
      text += body; textLiteral += body;
      j = close === -1 ? s.length : close + 1;
      continue;
    }
    if (c === '"') {
      const close = findClosingQuote(s, j, c);
      const stop = close === -1 ? s.length : close;
      const body = s.slice(j + 1, stop);
      if (hasLiveSubstitution(body)) dynamic = true;
      const unescaped = body.replace(/\\(["`$\\])/g, '$1');
      text += unescaped; textLiteral += unescaped;
      j = close === -1 ? s.length : close + 1;
      continue;
    }
    if (c === '\\' && j + 1 < s.length) { text += s[j + 1]; textLiteral += c + s[j + 1]; j += 2; continue; }
    if (/[\s;|&()<>]/.test(c)) break;
    text += c; textLiteral += c; j++;
  }
  return { text, textLiteral, end: j, dynamic };
}

/** matchWrapper(s) -> { name, restIndex } | null. The wrapper-word half of the attribution strip (wave 11,
 *  codex-recheck eleventh pass / wp-s1, P16-wrapper-double-quoted/P16-wrapper-single-quoted; wave 12 / wp-t1,
 *  SB-L1, generalised to readUnquotedWord): a wrapper name may be written as a complete shell word in ANY mix
 *  of quoted/bare/escaped segments (`"sudo" -u root bash -c "$x"`, `"su"do -u root bash -c "$x"`, `s\\udo -u
 *  root bash -c "$x"`), unquoted via readUnquotedWord and checked against WRAPPER_NAME_ONLY_RE — tried against
 *  the escape-RESOLVED text first, then the escape-LITERAL text (`.exe`-suffixed path fixtures with a bare
 *  backslash path separator). A word this reader judges `dynamic` (a live, unresolvable substitution inside a
 *  quoted segment) is never a KNOWN wrapper name — falls through to the ordinary attribution rules exactly like
 *  an unrecognised bare word would. */
function matchWrapper(s) {
  const r = readUnquotedWord(s, 0);
  if (r.dynamic || r.text === '') return null;
  const nm = WRAPPER_NAME_ONLY_RE.exec(r.text) || WRAPPER_NAME_ONLY_RE.exec(r.textLiteral);
  if (!nm) return null;
  let j = r.end;
  while (j < s.length && /\s/.test(s[j])) j++;
  return { name: nm[1], restIndex: j };
}

// WRAPPER_END_OPTS_RE — N15-R (a) (codex-recheck 2026-09-24, wave 8 / wp-n1): POSIX "end of options" — once a
// wrapper's own argument list reaches a standalone `--`, every remaining token is positional even if it LOOKS
// like an option, and nothing after it is ever consumed as one of the wrapper's own flags again
// (`sudo -- bash -c "$x"`, `env -- bash -c "$x"`, `command -- bash -c "$x"`) — so it is stripped once and then
// stops the option-stripping loop outright, letting the real interpreter word resolve normally right after it.
const WRAPPER_END_OPTS_RE = /^--(?:\s+|$)/;

// CLOSED PER-WRAPPER GRAMMAR (wave 10, codex-recheck tenth pass / wp-q1 -- see this file's header). Each table
// below is built directly from that wrapper's own GNU/BSD manual, never "whatever Codex happened to name" --
// an option this file has not heard of is handled by FAILING TOWARD DYNAMIC in stripWrapperOptions(), not by a
// silent generic strip. Short letters are matched CASE-SENSITIVELY throughout (sudo's `-E`/`-e` are genuinely
// different flags); long names are matched case-insensitively, same convention wave 9 already used.

// WRAPPER_NOVALUE_SHORT / WRAPPER_NOVALUE_LONG -- flags that take no separate value at all.
//   sudo:    -E -H -h -i -n -s -b -k -K -v -A -S / --preserve-env --login --non-interactive --help
//   env:     -i -0 -v            / --ignore-environment --null --debug
//   command: -p -v -V            (bash builtin -- no long forms)
//   time:    -p -v -a -q         / --portability --verbose --append --quiet
//   timeout: -v                  / --preserve-status --foreground --verbose
//   doas:    -L -n -s            (OpenBSD doas(1) -- no long forms; P16-benign-doas-no-value, wave 11)
// sudo's own `-h` is handled by a dedicated ambiguity check in stripWrapperOptions() (P16-sudo-host-operand,
// wave 11) rather than living in this no-value table: real GNU sudo reads a BARE `-h` as `--help` (no value)
// but `-h host` as `--host <value>` (a remote-execution form some sudo builds support) -- the two readings
// collide the moment a further token follows, so that specific shape is treated as unresolvable outright,
// while a bare, trailing `-h` (or one immediately followed by nothing) still resolves as the no-value flag a
// pre-existing, dynamically-verified regression fixture (`sudo -h bash -c "$x"`) depends on. `--help` (the
// long form) has no such ambiguity in real sudo and stays a plain no-value long option below.
const WRAPPER_NOVALUE_SHORT = { sudo: 'EHhinsbkKvAS', env: 'i0v', command: 'pvV', time: 'pvaq', timeout: 'v', doas: 'Lns' };
// `--preserve-env` moved OUT of this no-value table into WRAPPER_LONG_OPTIONAL_VALUE_OPTS below (SB-L2, wave 12
// / wp-t1): real GNU sudo defines it as `--preserve-env[=list]` -- a GLUED, comma-separated variable-name list
// is a legal optional argument (`sudo --preserve-env=PATH,HOME bash -c "$x"`), not an unknown shape glued onto
// a no-value flag the way this table's own no-value branch would otherwise treat it.
const WRAPPER_NOVALUE_LONG = {
  sudo: ['login', 'non-interactive', 'help'],
  env: ['ignore-environment', 'null', 'debug'],
  time: ['portability', 'verbose', 'append', 'quiet'],
  timeout: ['preserve-status', 'foreground', 'verbose'],
};

// WRAPPER_VALUE_OPTS / WRAPPER_LONG_VALUE_OPTS -- flags that consume the NEXT token as their own value, in
// EVERY form real getopt allows: `--name value` (space-separated), `--name=value` (glued), and short
// `-x value` / `-xvalue` (glued). The value itself is read by readOptionValue() as ONE complete shell word --
// a quoted value carrying its own internal space (`sudo -p "Enter password: "`, P15-long-sudo-prompt) is
// never split the way a `\S+`-based regex used to split it.
//   sudo -u/-g/-p/-C/-D/-R/-T/-U/-r/-t <val>      = --user/--group/--prompt/--close-from/--chdir/--chroot/
//                                                   --command-timeout/--other-user/--role/--type
//   env  -u/-C <val>                              = --unset/--chdir
//   exec -a <val>                                 (bash builtin -- no long form)
//   nice -n <val>                                 = --adjustment
//   timeout -s/-k <val>                           = --signal/--kill-after
//   stdbuf -i/-o/-e <val>                         = --input/--output/--error
//   time -f/-o <val>                              = --format/--output
//   doas -u/-C <val>                              (no long forms)
//   wsl  -d/-u <val>                              = --distribution/--user (SB-M4, wave 12; `--cd` is long-only)
const WRAPPER_VALUE_OPTS = { sudo: 'ugpCDRTUrt', env: 'uC', exec: 'a', nice: 'n', timeout: 'sk', stdbuf: 'ioe', time: 'fo', doas: 'uC', wsl: 'du' };
const WRAPPER_LONG_VALUE_OPTS = {
  sudo: ['user', 'group', 'prompt', 'close-from', 'chdir', 'chroot', 'command-timeout', 'other-user', 'role', 'type'],
  env: ['unset', 'chdir'],
  timeout: ['signal', 'kill-after'],
  nice: ['adjustment'],
  stdbuf: ['input', 'output', 'error'],
  time: ['format', 'output'],
  wsl: ['distribution', 'user', 'cd'],
};

// WRAPPER_LONG_OPTIONAL_VALUE_OPTS -- GNU getopt_long OPTIONAL-argument long options. Real getopt_long only
// ever reads an optional argument from the GLUED `=value` form; a bare `--default-signal bash -c "$x"` leaves
// "bash" as its own, separate next token -- NEVER consumed as the option's value the way an ordinary
// (mandatory-argument) value option would. Modelling these with the ordinary value table would wrongly eat the
// real interpreter word right after a bare `env --default-signal bash -c "$x"`. sudo's own `--preserve-env`
// joins here too (SB-L2, wave 12 / wp-t1): real GNU sudo's own `--preserve-env[=list]` -- a bare
// `sudo --preserve-env bash -c "$x"` (no value at all) and a glued `sudo --preserve-env=PATH,HOME bash -c "$x"`
// both resolve past it to the real interpreter word, never eating "bash" as if it were the list.
const WRAPPER_LONG_OPTIONAL_VALUE_OPTS = { env: ['default-signal', 'ignore-signal', 'block-signal'], sudo: ['preserve-env'] };

// WRAPPER_ALWAYS_DYNAMIC_SHORT / WRAPPER_ALWAYS_DYNAMIC_LONG -- an option that hands its OWN argument list to
// the invoked program and is therefore UNRESOLVABLE regardless of what (if anything) follows it. GNU coreutils
// `env -S`/`--split-string` re-splits and re-execs its own operand as the program plus ITS OWN arguments, so
// nothing after it can be read as "consume the value, then keep parsing this wrapper's own options". WSL's own
// `-e`/`--exec` (SB-M4, wave 12) runs the REST of the command line directly, the same "everything after this
// belongs to something this file cannot re-parse as options" shape.
const WRAPPER_ALWAYS_DYNAMIC_SHORT = { env: 'S', wsl: 'e' };
const WRAPPER_ALWAYS_DYNAMIC_LONG = { env: ['split-string'], wsl: ['exec'] };

// NUMERIC_ARG grammars -- RETIRED, wave 12 (codex-recheck twelfth pass / wp-t1, SB-M1). Security Boss review
// sec-w11 found the strtod grammar below still incomplete (a hex FLOAT `0x1p3`, a quoted operand with its own
// leading whitespace, a locale decimal comma) and recommended the simpler, complete fix that actually ships now
// (see WRAPPER_POSITIONAL_OPERAND's own doc, right before stripWrapperOptions): consume ONE complete word as
// timeout's duration / nice's adjustment regardless of its content, since a malformed value just makes the real
// program fail and nothing runs. TIMEOUT_DURATION_CONTENT_RE/NICE_ADJUSTMENT_CONTENT_RE/readNumericOperand are
// deleted outright rather than kept as unreachable dead code a future pass might mistakenly trust again.

/** readOptionValue(s, i) -> the END index (exclusive) of ONE complete shell word starting at s[i]. Wave 11
 *  (codex-recheck eleventh pass / wp-s1, P16-option-value-quoted-suffix/P16-option-value-quoted-prefix/
 *  P16-option-value-escaped-space): a real shell WORD is the WHOLE run of quoted and unquoted segments with
 *  NO UNQUOTED WHITESPACE between them (`"A"B`, `A"B"`, `root\ x`) -- the wave-10 version stopped at the
 *  FIRST quote it found (either treating the entire value as quoted and abandoning at its own closing quote,
 *  leaving a glued suffix like "B" to be misread as the next token entirely, or -- for a bare run -- simply
 *  never special-casing an embedded quote at all). This version loops: a quote segment is consumed whole (its
 *  own matching, unescaped closing quote found via findClosingQuote -- the P15-long-quoted-space-value fix,
 *  preserved), a backslash-escaped character (including an escaped space) is consumed together with its
 *  escape and never ends the word, and an ordinary run continues until the next UNESCAPED whitespace or shell
 *  metacharacter or a fresh quote -- repeating until one of those actually ends the word. Returns `i`
 *  unchanged when there is nothing there to read. Used to CONSUME a wrapper option's own value, a leading env
 *  assignment's own value (stripEnvAssignment), and a mandatory positional operand's own word
 *  (WRAPPER_POSITIONAL_OPERAND, wave 12) -- the value/operand's own content plays no further part in this
 *  classifier's decision, same spirit as readBareWord(). WAVE 12 (SB-H1): also skips a `$(...)` substitution as
 *  one glued unit (skipParenSubstitution) instead of stopping at its own opening `(`. */
function readOptionValue(s, i) {
  if (i >= s.length) return i;
  let j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === '"' || c === "'") {
      const close = findClosingQuote(s, j, c);
      if (close === -1) return s.length; // unterminated -> consume to end, the same fail-safe already accepted
      j = close + 1;
      continue;
    }
    // WAVE 12 (codex-recheck twelfth pass / wp-t1, SB-H1): a `$(...)` command substitution is one glued unit
    // of the same shell word too — bash never splits it on an internal space or `(`/`)` — so `$(cmd arg)` must
    // not stop this reader at its own opening `(` (one of the ordinary metacharacter-stop characters below)
    // the way a bare, unrelated `(` legitimately would.
    if (c === '$' && s[j + 1] === '(') { j = skipParenSubstitution(s, j + 1); continue; }
    if (c === '\\' && j + 1 < s.length) { j += 2; continue; }
    if (/[\s;|&()<>]/.test(c)) break;
    j++;
  }
  return j;
}

const ENV_ASSIGN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** stripEnvAssignment(s) -> the text right after a LEADING `NAME=VALUE` env assignment (leading whitespace of
 *  what follows trimmed), or `null` when `s` does not start with one (wave 12, codex-recheck twelfth pass /
 *  wp-t1, SB-H1 — a REGRESSION-CLASS fix, not a first bug: the same "stops at the first unquoted space" bug
 *  Codex already found and fixed in readOptionValue/readBareWord/readInterpreterWord across waves 9-11 was
 *  still open here, the ONE remaining caller that read an assignment's own VALUE with a bare `=\S*` regex
 *  instead of a complete-shell-word reader). The value is now read by readOptionValue — the SAME reader every
 *  wrapper option value already uses — so a quoted value carrying its own internal space, an escaped space, or
 *  a `$(...)` substitution never gets amputated at its first unquoted character: `FOO="a b" bash -c "$x"`,
 *  `FOO='a b' bash -c "$x"`, `FOO=a\ b bash -c "$x"` and `FOO=$(cmd arg) bash -c "$x"` all now resolve past the
 *  WHOLE assignment to "bash", never stopping mid-value and misreading its own trailing half ("b\"", "b'",
 *  "b", "arg)") as the leading command word. Used both for the top-level env-assignment strip in
 *  statementCommandWord and for `env`'s own `NAME=VALUE` positional-operand grammar in stripWrapperOptions, so
 *  the two can never drift onto two different assignment readers again. */
function stripEnvAssignment(s) {
  const m = ENV_ASSIGN_NAME_RE.exec(s);
  if (!m) return null;
  const end = readOptionValue(s, m[0].length);
  return s.slice(end).replace(/^\s+/, '');
}

// WRAPPER_POSITIONAL_OPERAND -- wave 12 (codex-recheck twelfth pass / wp-t1, SB-M1 + SB-M3), REPLACING the
// wave-10/11 TIMEOUT_DURATION_CONTENT_RE/readNumericOperand strtod-grammar reader outright rather than patching
// it further. Security Boss review sec-w11 found that grammar still incomplete (a hex FLOAT like `0x1p3`, a
// quoted operand with its own leading whitespace, a locale decimal comma) and its own recommendation is
// simpler and complete: once a wrapper's own OPTIONS are exhausted, a wrapper in this set has exactly ONE
// mandatory positional operand that is NEVER itself the command to run -- timeout's duration, chroot's
// NEWROOT, flock's FILE/fd, chrt's PRIORITY, taskset's MASK -- consumed as one complete shell word via
// readOptionValue REGARDLESS of its own content. A malformed value (a bad duration, a non-numeric mask) simply
// makes the REAL timeout/chroot/chrt/taskset fail at runtime and nothing after it ever executes, so there is no
// content grammar left to model incompletely -- SB-M3 also folds in chroot/flock/chrt/taskset's own previously-
// unmodelled mandatory operand this same way, closing the "bare, no-option form still stays silent" gap wave 11
// named for all four (ionice never had one -- see WRAPPER_OWN_SHELL_C's own doc for why it is deliberately
// absent here). `chroot /mnt bash -c "$x"`, `flock /tmp/l bash -c "$x"`, `chrt 5 bash -c "$x"` and `taskset 0x1
// bash -c "$x"` all now fire by resolving past the mandatory operand to the real "bash" right after it.
// `nice` is DELIBERATELY excluded: real GNU coreutils nice has NO bare positional adjustment at all (only
// `-n`/`--adjustment`, already a WRAPPER_VALUE_OPTS entry) -- `nice bash -c "$x"` already resolves straight to
// "bash" with the default adjustment, and adding nice here would wrongly eat that same "bash" as a fictitious
// bare adjustment whenever `-n` was NOT given, which also broke the pre-existing `-n`-form fixtures once `-n`'s
// own value consumption left nothing further to (wrongly) treat as a second, redundant positional.
const WRAPPER_POSITIONAL_OPERAND = new Set(['timeout', 'chroot', 'flock', 'chrt', 'taskset']);
// WRAPPER_OWN_SHELL_C -- flock alone, among the six above, ALSO has its OWN `-c COMMAND` mode (util-linux
// flock(1): `flock <file> -c <command>` runs <command> through `/bin/sh -c`, the same executable semantics as
// su/runuser's own -c) -- SB-M3, "treat flock like su/runuser". Unlike su/runuser (never added to WRAPPER_NAMES
// at all, since nothing hides their own -c behind wrapper-option stripping), flock's mandatory FILE operand
// sits BEFORE its own -c, so it still goes through the ordinary wrapper machinery; the special case is narrow:
// once flock's one mandatory operand is consumed and NOTHING else remains in this -c occurrence's own
// statement slice (cArgLiveAfterFlag always slices text strictly BEFORE the "-c" it is judging), the "-c"
// immediately following belongs to flock itself, not to some further, unwritten command -- reported `dynamic:
// true` (this file's own "cannot resolve, but a real interpreter sits right here -> associate" convention) so
// `flock /tmp/l -c "$x"` fires exactly like `su -c "$x"` already does, while `flock /tmp/l bash -c "$x"`
// (flock launching a SEPARATE program, its own -c never in play) still resolves normally to "bash".
const WRAPPER_OWN_SHELL_C = new Set(['flock']);

/** stripWrapperOptions(s, wrapperName) -> { rest, dynamic }. The CLOSED per-wrapper option grammar (wave 10 /
 *  wp-q1; hardened wave 11 / wp-s1; wave 12 / wp-t1 -- see this file's header; supersedes N15/N15-R/N18 from
 *  waves 7-9). Tries, in order, each iteration (bounded to 8 -- real invocations never carry more than a
 *  handful): the POSIX `--` end-of-options terminator (stops parsing outright; a wrapper with a mandatory
 *  positional operand still consumes ONE right after it -- P16-timeout-after-terminator -- since the
 *  terminator only means "no more OPTIONS", not "no more positional grammar"); for `env` only, a `NAME=VALUE`
 *  assignment operand (stripEnvAssignment -- SB-H1, wave 12: the value is read as a complete shell word, never
 *  a bare `=\S*`, so `env FOO="a b" bash -c "$x"` cannot hide "bash" behind the space in "a b"); an ALWAYS-
 *  DYNAMIC option, which ends parsing immediately as unresolvable; sudo's own `-h` ambiguity
 *  (P16-sudo-host-operand); a known no-value flag, short or long, OR a run of two-or-more short no-value flags
 *  CLUSTERED together (P16-benign-env-flags-cluster -- valid only when EVERY letter in the run is itself
 *  tabled no-value; a value-taking or unrecognised letter anywhere in the run makes the whole cluster
 *  unresolvable); a known value-taking flag, short or long, its value read as ONE complete shell word by
 *  readOptionValue (space-separated, `=`-glued, or short-glued, including a value that itself mixes quoted and
 *  bare segments with no separating whitespace -- P16-option-value-quoted-suffix/-prefix/-escaped-space); a
 *  known OPTIONAL-value long option (only its own glued `=value` form, never a following separate token -- real
 *  GNU getopt_long semantics); and, for a WRAPPER_POSITIONAL_OPERAND wrapper, ONE mandatory positional operand
 *  -- content UNCHECKED, SB-M1/SB-M3 -- once no more flags match. A token that fits NONE of these shapes -- an
 *  unknown flag, a value-taking option with nothing after it, a no-value flag/cluster with something unexpected
 *  glued to it -- makes the WHOLE invocation unresolvable on the spot (`dynamic: true`); there is no remaining
 *  "strip it anyway" branch for such a token to hide behind. Stops the instant the current token is not a
 *  dash-led option and not a recognised positional operand -- that token is the real command word
 *  (`{ rest, dynamic: false }`). Running out of the 8-iteration budget while there is STILL unresolved
 *  option-like text left is itself now unresolvable (P16-option-budget-exhausted) -- the loop never falls
 *  through with a partially-stripped remainder that a caller could mistake for the real command word; only a
 *  bug-free FULL resolution (a return from inside the loop) ever reports `dynamic: false`. */
function stripWrapperOptions(s, wrapperName) {
  const wl = String(wrapperName || '').toLowerCase();
  const shortNoValue = WRAPPER_NOVALUE_SHORT[wl] || '';
  const longNoValue = WRAPPER_NOVALUE_LONG[wl] || [];
  const shortValue = WRAPPER_VALUE_OPTS[wl] || '';
  const longValue = WRAPPER_LONG_VALUE_OPTS[wl] || [];
  const longOptional = WRAPPER_LONG_OPTIONAL_VALUE_OPTS[wl] || [];
  const alwaysDynShort = WRAPPER_ALWAYS_DYNAMIC_SHORT[wl] || '';
  const alwaysDynLong = WRAPPER_ALWAYS_DYNAMIC_LONG[wl] || [];
  const hasPositional = WRAPPER_POSITIONAL_OPERAND.has(wl);
  let positionalConsumed = false;

  let out = s;
  for (let i = 0; i < 8; i++) {
    const endOpts = WRAPPER_END_OPTS_RE.exec(out);
    if (endOpts) {
      let rest = out.slice(endOpts[0].length);
      if (hasPositional && !positionalConsumed && rest !== '') {
        rest = rest.slice(readOptionValue(rest, 0)).replace(/^\s+/, '');
        positionalConsumed = true;
      }
      return { rest, dynamic: false };
    }

    if (wl === 'env') {
      const stripped = stripEnvAssignment(out);
      if (stripped !== null) { out = stripped; continue; }
    }

    if (out[0] !== '-') {
      if (hasPositional && !positionalConsumed) {
        if (out === '') return { rest: '', dynamic: true }; // the mandatory operand is missing: cannot resolve
        positionalConsumed = true;
        out = out.slice(readOptionValue(out, 0)).replace(/^\s+/, '');
        if (out === '' && WRAPPER_OWN_SHELL_C.has(wl)) return { rest: '', dynamic: true }; // flock's own -c mode
        continue;
      }
      return { rest: out, dynamic: false }; // the real command word (or an operand grammar this wrapper lacks)
    }

    const lm = /^--([A-Za-z][\w-]*)/.exec(out);
    if (lm) {
      const name = lm[1].toLowerCase();
      const after = out.slice(lm[0].length);
      if (alwaysDynLong.includes(name)) return { rest: '', dynamic: true };
      if (longNoValue.includes(name)) {
        if (after === '' || /^\s/.test(after)) { out = after.replace(/^\s+/, ''); continue; }
        return { rest: '', dynamic: true }; // e.g. "--verbose=x" glued onto a no-value flag: unknown shape
      }
      if (longOptional.includes(name)) {
        if (after[0] === '=') {
          const ve = readOptionValue(after, 1);
          if (ve === 1) return { rest: '', dynamic: true }; // "--name=" with nothing after "=": malformed
          out = after.slice(ve).replace(/^\s+/, ''); continue;
        }
        if (after === '' || /^\s/.test(after)) { out = after.replace(/^\s+/, ''); continue; } // bare, no arg
        return { rest: '', dynamic: true };
      }
      if (longValue.includes(name)) {
        if (after[0] === '=') {
          const ve = readOptionValue(after, 1);
          if (ve === 1) return { rest: '', dynamic: true };
          out = after.slice(ve).replace(/^\s+/, ''); continue;
        }
        const ws = /^\s+/.exec(after);
        if (!ws || ws[0].length >= after.length) return { rest: '', dynamic: true }; // no value at all: malformed
        const ve = readOptionValue(after, ws[0].length);
        out = after.slice(ve).replace(/^\s+/, ''); continue;
      }
      return { rest: '', dynamic: true }; // unknown long option name
    }

    // sm captures the WHOLE run of alnum characters right after the dash -- a value-taking flag only ever
    // consumes ITS OWN single letter (the rest of the run belongs to a glued value, wave 10 behaviour
    // preserved below); a run of two-or-more letters with no value-taking first letter is a candidate CLUSTER
    // of no-value flags (P16-benign-env-flags-cluster, wave 11).
    const sm = /^-([A-Za-z0-9]+)/.exec(out);
    if (sm) {
      const letters = sm[1];
      const after = out.slice(sm[0].length);
      const firstLetter = letters[0];
      if (alwaysDynShort.includes(firstLetter)) return { rest: '', dynamic: true };

      if (shortValue.includes(firstLetter)) {
        const rest0 = letters.slice(1) + after; // anything glued after the flag LETTER is the value's own start
        if (rest0 === '') return { rest: '', dynamic: true }; // "-u" at the very end, no value at all
        if (/^\s/.test(rest0)) {
          const wsLen = /^\s+/.exec(rest0)[0].length;
          if (wsLen >= rest0.length) return { rest: '', dynamic: true };
          const ve = readOptionValue(rest0, wsLen);
          out = rest0.slice(ve).replace(/^\s+/, ''); continue;
        }
        const ve = readOptionValue(rest0, 0); // glued form: "-uroot", "-p\"a b\""
        if (ve === 0) return { rest: '', dynamic: true };
        out = rest0.slice(ve).replace(/^\s+/, ''); continue;
      }

      // sudo's own "-h" is ambiguous in real sudo: alone it means --help (no value), but "-h host" is read as
      // --host <value> -- a further token collides both readings, so treat it as unresolvable outright
      // (P16-sudo-host-operand). A bare, trailing "-h" (nothing after it at all) still falls through to the
      // ordinary no-value handling below, keeping the pre-existing `sudo -h bash -c "$x"` fixture firing via
      // normal resolution to "bash". SB-L2, wave 12 (codex-recheck twelfth pass / wp-t1): the SAME ambiguity
      // applies just as much when "h" sits INSIDE a larger cluster, not only as the sole letter -- `sudo -nh
      // host bash -c "$x"` is exactly as ambiguous as a bare `-h host` once something follows the cluster, so
      // `letters.includes('h')` replaces the old exact `letters === 'h'` check (P16's own bare-'h' fixture is
      // the one-letter special case of this same, now-wider rule).
      if (wl === 'sudo' && letters.includes('h') && /^\s/.test(after)) return { rest: '', dynamic: true };

      // A run of one-or-more short flags glued together is a valid CLUSTER only when every letter in it is
      // itself a tabled no-value flag for this wrapper (P16-benign-env-flags-cluster); any value-taking or
      // unrecognised letter anywhere in the run makes the whole cluster unresolvable -- this also covers the
      // pre-existing single-letter case (a "cluster" of length one).
      for (const L of letters) {
        if (alwaysDynShort.includes(L)) return { rest: '', dynamic: true };
        if (!shortNoValue.includes(L)) return { rest: '', dynamic: true };
      }
      if (after === '' || /^\s/.test(after)) { out = after.replace(/^\s+/, ''); continue; }
      return { rest: '', dynamic: true }; // something unexpected glued after a full no-value cluster
    }

    return { rest: '', dynamic: true }; // "-" not followed by a letter/digit at all (a lone "-", "-@", ...)
  }
  // P16-option-budget-exhausted (wave 11): the loop ran out of its 8-iteration budget while `out` still had
  // unresolved option-like text in front of it (every successful FULL resolution returns from inside the loop
  // above) -- never fall through reporting the untouched remainder as if it were the real command word.
  return { rest: '', dynamic: true };
}

/** isBackslashEscaped(s, i) -> true when s[i] is preceded by an ODD run of backslashes (so it is itself
 *  escaped -- a doubled backslash `\\` escapes itself, leaving the next character bare, exactly the same rule
 *  scanQuotes' own backtickInDq/double-quote escape handling already applies going FORWARD). Direction-
 *  agnostic: looks only at the literal text before `i`, so it is safe to call from statementStart's own
 *  BACKWARD scan (wave 10 / wp-q1). An escaped backtick (`` \` ``) must never take part in that scan's
 *  open/close parity count -- it is one layer of literal text belonging to an OUTER interpreter's own nested
 *  substitution (`` bash `echo \`x\`` -c "$x" `` -- real, legal nested-backtick syntax, GNU Bash manual,
 *  Command Substitution), not a fresh open or close of the span statementStart is trying to bound. */
function isBackslashEscaped(s, i) {
  let n = 0;
  let j = i - 1;
  while (j >= 0 && s[j] === '\\') { n++; j--; }
  return (n % 2) === 1;
}

/** statementStart(s, mask, pos) -> the absolute index where the statement CONTAINING `pos` begins: the
 *  character right after the nearest UNQUOTED statement-boundary character before `pos` (`;`/`&`/`|`/newline),
 *  OR an unquoted, UNMATCHED opening `(`/backtick whose own substitution/subshell contains `pos` (N15, codex-
 *  recheck 2026-09-24, wave 7 / wp-m1 -- a REGRESSION: this function previously knew nothing about nested
 *  command-substitution context at all, so `x=$(bash -c "$y")` read its leading word from "x=$(bash" -- the env-
 *  assignment regex consuming straight through the substitution boundary -- and `$(which bash) -c "$x"` had no
 *  way to see that its own leading word is unresolvable). A `)` seen while scanning backward means everything
 *  between it and `pos` sits inside one CLOSED parenthesised span that finished entirely BEFORE `pos` -- its
 *  matching `(` does not enclose `pos` and is not a boundary, so scanning continues past both; only a `(` with
 *  no unmatched `)` still owed truly encloses `pos`. Respecting the shared quote mask throughout is the N04
 *  lesson reapplied: none of `;`/`(`/`)`/backtick sitting inside quoted DATA may ever look like a fresh boundary.
 *
 *  N15-R (codex-recheck 2026-09-24, wave 8 / wp-n1 -- two further REGRESSIONS wave 7's own first backtick/paren
 *  fix introduced). (e): a `;`/`&`/`|`/newline seen while `closeDepth > 0` (i.e. still inside an ALREADY-CLOSED,
 *  from `pos`'s perspective, parenthesised span scanned backward) used to end the scan immediately regardless of
 *  `closeDepth` -- `bash $(echo a; echo b) -c "$x"` and `bash $(true && false) -c "$x"` lost "bash" entirely
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
 *  N15-R residual (codex-recheck 2026-09-24, wave 9 / wp-p1 -- the backtick counterpart of (e) above, same root
 *  cause). A `;`/`&`/`|`/newline seen while `btPending !== -1` (i.e. scanning backward THROUGH the still-
 *  unresolved interior of a candidate span whose closing tick was already found, hunting for its opener) used
 *  to end the scan immediately regardless of that pending state -- `` bash `echo a; echo b` -c "$x" ``,
 *  `` bash `true && false` -c "$x" `` and `` bash `a | b` -c "$x" `` all lost "bash" because the separator
 *  INSIDE the backtick span's own un-marked text (statementStart's backtick handling, unlike scanQuotes, never
 *  marks the span's interior as "inside" anything) looked like a real boundary before the matching (opening)
 *  backtick was ever reached. The fix mirrors (e) exactly: a boundary character is only ever a real statement
 *  boundary when BOTH `closeDepth === 0` AND `btPending === -1` (no still-unresolved candidate span).
 *
 *  WAVE 10 (codex-recheck tenth pass / wp-q1): an ESCAPED backtick (isBackslashEscaped() true) never toggles
 *  `btPending` at all -- it is literal content belonging to an outer interpreter's own nested substitution
 *  (`` bash `echo \`x\`` -c "$x" ``), not a fresh pairing candidate; counting it as a real pairing character
 *  could shift the parity enough to lose the leading interpreter word when a real statement-boundary character
 *  sits between the escaped and unescaped pairs (`` bash `echo \`a; echo b\`` -c "$x" `` -- without this fix,
 *  the escaped pair's own two backtick characters wrongly close-then-reopen the parity count, so btPending
 *  reads as "clear" right when the `;` is reached and the scan stops there, losing "bash" entirely).
 *
 *  WAVE 12 (codex-recheck twelfth pass / wp-t1, SB-M2). `f() { bash -c "$x"; }` lost "bash" the same way the
 *  case-arm shape did (see CASE_ARM_RE's own doc) — for a DIFFERENT structural reason. `f()`'s own two adjacent
 *  parens ARE a genuinely matched, closed pair (closeDepth increments on the `)`, decrements back to 0 on the
 *  matching `(`), so the existing paren logic correctly steps past them and keeps scanning — all the way back
 *  to index 0, since nothing else in `f() { bash ` looks like a boundary today. An unquoted `{` is now a
 *  boundary character too (checked BEFORE the paren-matched `f()` is ever reached, scanning backward): once the
 *  backward scan reaches it, `f() { bash -c "$x"; }` resolves to the slice " bash " (the `{` itself excluded,
 *  same convention `;`/`&`/`|` already use), which OPENER_RE already knows how to consume front-to-back — no
 *  separate "name() {" step is needed once `{` itself is a real boundary. An unquoted, standalone `then`/`do`
 *  keyword end is treated the same way, defensively, even though real shell grammar already requires a `;`/
 *  newline immediately before either (so the existing boundary already catches the ordinary case) — matching
 *  the review's own explicit ask, and failing toward a boundary costs nothing here (openers are always safe to
 *  cut at, since nothing about them is ever an escape-worthy target). */
function keywordBoundaryEnd(s, i) {
  // s[i] must be the LAST character of a standalone "then"/"do" (case-insensitive), with a non-word character
  // (or start of string) right before it and a non-word character (or end of string) right after it -- returns
  // the boundary position (right after the keyword, so the keyword itself is excluded from the resulting
  // slice, same convention `;`/`&`/`|`/`(`/`` ` `` already use) or -1 when no such keyword ends at i.
  const after = s[i + 1];
  if (after !== undefined && /\w/.test(after)) return -1;
  for (const kw of ['then', 'do']) {
    const start = i - kw.length + 1;
    if (start < 0 || s.slice(start, i + 1).toLowerCase() !== kw) continue;
    const before = s[start - 1];
    if (before !== undefined && /\w/.test(before)) continue;
    return i + 1;
  }
  return -1;
}
/** execBoundaryEnd(s, i) -> the index right after a standalone "-exec"/"-execdir" ending at s[i], or -1 (wave
 *  12 follow-up, 2026-09-25, wp-u1). GNU find(1)'s own `-exec COMMAND ;`/`-exec COMMAND +`/`-execdir COMMAND ;`
 *  clause hands COMMAND to exec() as a fresh program invocation -- exactly the same "a new command starts here"
 *  shape `;`/`&`/`|`/newline/`{`/a keyword end already are for statementStart(), but find's own flag was never
 *  one of them, so `find . -exec bash -c "$x" \;` used to resolve its leading word all the way back to "find"
 *  (a real, non-shell program), never reaching "bash" at all. Case-SENSITIVE (real GNU find's own flags are
 *  lowercase only) and anchored the same word-boundary-safe way keywordBoundaryEnd() already is: the character
 *  right after the candidate must be non-word (or end of text), and the character right BEFORE it must be
 *  whitespace (or start of text) -- never another non-whitespace character glued onto it. That second guard is
 *  what keeps WSL's own unrelated `--exec` long option (SHELL_WORD_RE's sibling wrapper table, above) from ever
 *  being misread as this boundary: the extra leading `-` in `--exec` sits immediately before the matched
 *  "-exec" span with no whitespace between them, so it fails the guard and is correctly left alone. */
function execBoundaryEnd(s, i) {
  const after = s[i + 1];
  if (after !== undefined && /\w/.test(after)) return -1;
  for (const kw of ['-exec', '-execdir']) {
    const start = i - kw.length + 1;
    if (start < 0 || s.slice(start, i + 1) !== kw) continue;
    const before = s[start - 1];
    if (before !== undefined && /\S/.test(before)) continue; // must be its own token, not glued onto more text
    return i + 1;
  }
  return -1;
}
function statementStart(s, mask, pos, budget) {
  let i = pos - 1;
  let closeDepth = 0;
  let btPending = -1; // -1 = even backtick parity so far (no pending candidate); >=0 = an odd, still-open backtick
  while (i >= 0) {
    // SB-M5 (wave 12, codex-recheck twelfth pass / wp-t1): cArgLiveAfterFlag calls this function once per "-c"
    // token, and each call's own cost is proportional to how far back it has to scan — a command with MANY
    // "-c" tokens spread across a long text drives total cost toward tokens x length. `budget`, when supplied,
    // is ONE shared counter across every statementStart() call within a single cArgLiveAfterFlag() invocation
    // (never reset per call), so total work across ALL of them is capped regardless of how many "-c" tokens
    // exist. Exhausting it bails out immediately (`exhausted: true`) rather than finishing this one scan —
    // the caller treats that exactly like an unresolved quote mask: cannot bound it, fail toward fire.
    if (budget) { budget.steps++; if (budget.steps > budget.cap) { budget.exhausted = true; return 0; } }
    if (!mask.inside(i)) {
      const ch = s[i];
      if (ch === ')') { closeDepth++; i--; continue; }
      if (ch === '(') {
        if (closeDepth > 0) { closeDepth--; i--; continue; }
        return i + 1;
      }
      if (closeDepth === 0) {
        if (ch === '`') {
          if (!isBackslashEscaped(s, i)) { btPending = btPending === -1 ? i : -1; }
          i--; continue;
        }
        // N15-R residual: a separator found while btPending is still set sits INSIDE a candidate backtick span
        // whose fate (closed-before-pos vs. genuinely open) is not yet known -- never a real boundary on its own.
        if (btPending === -1) {
          // WAVE 12 / SB-M2: an unquoted brace-GROUP opener is a real boundary too -- but only when it is
          // actually acting as bash's own reserved word `{`, which real bash grammar requires a following
          // WHITESPACE for (BashRef "Compound Commands": "{ list; }" -- `{` is recognised as a reserved word
          // only when it is its own token). A `{` glued to whatever follows it is DATA, not a group opener --
          // xargs' own `-I{}` replacement string (`echo x | xargs -I{} bash -c "$x"`) or a brace-expansion
          // `{a,b}` must never be misread as opening a command group.
          if (ch === '{' && (i + 1 >= s.length || /\s/.test(s[i + 1]))) return i + 1;
          if ((ch === 'n' || ch === 'N' || ch === 'o' || ch === 'O')) {
            const kwEnd = keywordBoundaryEnd(s, i);
            if (kwEnd !== -1) return kwEnd;
          }
          // wp-u1 (wave 12 follow-up): GNU find's own "-exec"/"-execdir" clause is a real boundary too -- see
          // execBoundaryEnd's own doc. Triggered only on 'c'/'r' (the last letter of either spelling), the same
          // cheap-dispatch convention keywordBoundaryEnd's own 'n'/'o' trigger already uses above.
          if (ch === 'c' || ch === 'r') {
            const execEnd = execBoundaryEnd(s, i);
            if (execEnd !== -1) return execEnd;
          }
          if (STATEMENT_BOUNDARY_RE.test(ch)) return i + 1;
        }
      }
    }
    i--;
  }
  if (btPending !== -1) return btPending + 1;
  return 0;
}

/** readInterpreterWord(s) -> { word, dynamic } -- the leading executable word of `s` (a statement already
 *  stripped of env assignments/wrapper prefixes/openers), in every quoting form this policy must recognise
 *  (N15, codex-recheck 2026-09-24, wave 7 / wp-m1). A bare word reads exactly as before (readBareWord). A
 *  QUOTED word (`"bash"`, `'/bin/bash'`, `"C:\Program Files\...\pwsh.exe"`) has its own wrapping quotes
 *  stripped before SHELL_WORD_RE ever sees it -- single-quoted content is always literal to the outer shell;
 *  double-quoted content is literal too UNLESS it holds a live substitution marker itself, in which case the
 *  word is DYNAMIC (`"$SHELL"`). A leading `$(`, `${`, a bare `$NAME`, or a backtick -- unquoted -- is also
 *  DYNAMIC (`$(which bash)`, `${SHELL}`). `dynamic:true` means this classifier cannot read what the statement
 *  will actually run, so -- this file's own "cannot bound it -> fire" principle, already applied to an
 *  unresolved quote mask elsewhere -- the caller treats it as an interpreter for the ASSOCIATION test alone; it
 *  still only fires once the `-c` argument itself turns out live, so a static `"$SHELL" -c "echo hi"` stays
 *  silent exactly like a known `bash -c "echo hi"` does.
 *
 *  WAVE 10 (codex-recheck tenth pass / wp-q1): the wave-8 N15-R (c) safety net / wave-9 N18 fix that used to
 *  live HERE -- "a resolved word that still starts with `-`, but only when a wrapper prefix actually stripped
 *  something" -- is REMOVED. It is superseded, not merely redundant: stripWrapperOptions() now implements a
 *  CLOSED per-wrapper grammar and resolves every dash-led token inside a wrapper's own argument list itself,
 *  one way or the other (a known shape is consumed; an unknown one returns `dynamic: true` immediately from
 *  inside statementCommandWord) -- so `s` handed to this function can no longer carry a leftover,
 *  wrapper-residue dash token at all. Keeping the old heuristic here as an unreachable safety net was rejected
 *  in favour of removing it outright, so a future pass cannot mistake dead code for a still-active guard.
 *
 *  WAVE 11 (2026-09-24, codex-recheck eleventh pass / wp-s1): the quoted-word branch now finds its own closing
 *  quote via findClosingQuote() (escape-aware for double quotes) instead of a bare `s.indexOf(c, 1)`, which
 *  stopped at the FIRST literal quote character regardless of any backslash before it -- the same "word reader
 *  that stops at ... an escape" bug class Codex found elsewhere in this file, audited here too.
 *
 *  WAVE 12 (codex-recheck twelfth pass / wp-t1, SB-L1): generalised to readUnquotedWord, which also reads a
 *  word GLUED from more than one segment (`"ba"sh`) and a BARE segment carrying its own backslash escapes
 *  (`s\udo`, real bash: the backslash is removed, folding it into the literal word "sudo") -- the fully-quoted-
 *  alone case this function already handled is the one-segment special case of that same reader. The leading
 *  bare `$(`/`${`/`$NAME`/backtick check stays a dedicated first step: readUnquotedWord treats an unquoted `$`
 *  as an ordinary literal character (it only resolves LIVENESS inside an already-quoted segment), so a bare,
 *  UNQUOTED substitution marker at position 0 still needs its own check before any word-reading is attempted. */
function readInterpreterWord(s) {
  if (/^(?:\$\(|\$\{|\$[A-Za-z_]|`)/.test(s)) return { word: null, dynamic: true };
  const r = readUnquotedWord(s, 0);
  if (r.dynamic) return { word: null, dynamic: true };
  // SB-L1, wave 12: try the escape-RESOLVED text first (`s\udo` -> "sudo"), then the escape-LITERAL text (a
  // bare Windows path's own backslash kept as a path separator, `C:\tools\bash.exe` -> unchanged) — see
  // readUnquotedWord's own doc for why both readings matter and neither replaces the other.
  const word = SHELL_WORD_RE.test(r.text) ? r.text : SHELL_WORD_RE.test(r.textLiteral) ? r.textLiteral : r.text;
  return { word, dynamic: false };
}

/** statementCommandWord(stmt) -> { word, dynamic } -- the leading command word of a statement's own text (see
 *  readInterpreterWord), after repeatedly stripping env assignments, wrapper prefixes AND THEIR OWN OPTIONS
 *  (N15), and grouping/control-flow openers from its start (capped so a pathological input cannot loop
 *  unboundedly; ordinary statements resolve in one or two strips). WAVE 10 (wp-q1): stripWrapperOptions() now
 *  returns `{ rest, dynamic }` instead of a bare string -- when it reports `dynamic: true` (an option grammar
 *  this file does not recognise), this function returns `{ word: null, dynamic: true }` immediately, without
 *  ever calling readInterpreterWord on a leftover fragment; the old `wrapperResidue` boolean this function used
 *  to thread through to readInterpreterWord's own leftover-dash-option fallback (N18) is gone along with that
 *  fallback -- see readInterpreterWord's own doc for why it is no longer needed.
 *
 *  WAVE 11 (2026-09-24, codex-recheck eleventh pass / wp-s1). Two fixes: (1) the wrapper match now goes through
 *  matchWrapper() (P16-wrapper-double-quoted/P16-wrapper-single-quoted) so a QUOTED wrapper word (`"sudo" -u
 *  root bash -c "$x"`) is recognised exactly like a quoted interpreter word already is. (2) the 12-iteration
 *  strip budget is now tracked explicitly (`stabilized`) -- when the loop exhausts WITHOUT the text settling
 *  (many more nested wrapper prefixes than the budget can strip, P16-wrapper-budget-exhausted), this function
 *  returns `{ word: null, dynamic: true }` itself rather than handing an only-partially-stripped remainder to
 *  readInterpreterWord, which could otherwise resolve to a bare leftover wrapper name (not a shell) and go
 *  silent even though the real command word was never actually reached. */
/** stripLeadingPrefixes(stmt) -> { rest, dynamic }. The shared env-assignment / wrapper-prefix / opener strip
 *  loop, extracted unchanged out of statementCommandWord (wp-u1, wave 12 follow-up) so cmd's own `/C`/`/K`
 *  association check below (cmdAssociatesFlag) can reuse the IDENTICAL strip order and budget instead of a
 *  second, driftable copy -- statementCommandWord is now this function plus readInterpreterWord. Pure
 *  extraction: every existing statementCommandWord behaviour (and therefore every `-c` fixture already pinned)
 *  is unchanged bit for bit. */
function stripLeadingPrefixes(stmt) {
  let s = String(stmt).replace(/^\s+/, '');
  let stabilized = false;
  for (let i = 0; i < 12; i++) {
    const before = s;
    const assigned = stripEnvAssignment(s);
    if (assigned !== null) s = assigned;
    const wm = matchWrapper(s);
    if (wm) {
      const stripped = stripWrapperOptions(s.slice(wm.restIndex), wm.name);
      if (stripped.dynamic) return { rest: '', dynamic: true };
      s = stripped.rest;
    }
    s = s.replace(OPENER_RE, '');
    s = s.replace(CASE_ARM_RE, ''); // SB-M2, wave 12: `case $a in x) bash -c "$x";; esac` -- see CASE_ARM_RE's own doc
    if (s === before) { stabilized = true; break; }
  }
  if (!stabilized) return { rest: '', dynamic: true }; // strip budget exhausted, never reached a stable word
  return { rest: s, dynamic: false };
}

function statementCommandWord(stmt) {
  const stripped = stripLeadingPrefixes(stmt);
  if (stripped.dynamic) return { word: null, dynamic: true };
  return readInterpreterWord(stripped.rest);
}

// ============================================================================
// WAVE 12 FOLLOW-UP (2026-09-25, wp-u1) -- cmd.exe's own "/C"/"/K" flag and env's own "-S"/"--split-string"
// live-operand check, each its OWN scanning pass parallel to (never replacing) the "-c" pass below. See this
// file's header for the full "why".
// ============================================================================

// CMD_WORD_RE -- exactly "cmd"/"cmd.exe", optionally path-qualified, case-insensitive (mirrors SHELL_WORD_RE's
// own convention exactly, including its `.*[\\/]` prefix so a QUOTED path with its own spaces still matches via
// readUnquotedWord's textLiteral reading -- SB-L1's own convention, reused here rather than re-derived).
const CMD_WORD_RE = /^(?:.*[\\/])?cmd(?:\.exe)?$/i;
// ENV_WORD_RE -- the same convention for "env"/"env.exe" specifically (as opposed to SHELL_WORD_RE/WRAPPER_
// NAME_ONLY_RE, which both also match a great many OTHER wrapper/interpreter names).
const ENV_WORD_RE = /^(?:.*[\\/])?env(?:\.exe)?$/i;

// CMD_SWITCH_NOVALUE / CMD_SWITCH_VALUE -- cmd.exe's OWN pre-`/C`/`/K` switches (real `cmd /?` reference):
// `/A`/`/U`/`/Q`/`/D`/`/S` take no value; `/E:ON|OFF`, `/F:ON|OFF`, `/V:ON|OFF` take a value GLUED via a colon,
// always the literal word ON or OFF. Letters are matched case-insensitively (real cmd.exe switches are).
const CMD_SWITCH_NOVALUE = 'AUQDS';
const CMD_SWITCH_VALUE = 'EFV';
const CMD_SWITCH_VALUE_RE = /^:(on|off)\b/i;

/** stripCmdSwitches(s) -> { rest, dynamic }. Consumes cmd.exe's OWN switches from the start of `s` (bounded to
 *  8 iterations, mirroring stripWrapperOptions' own budget), stopping the instant the next token is `/C`/`/K`
 *  (cmd's own command flag -- left FOR the caller, never consumed here) or is not a recognised switch at all, in
 *  which case the WHOLE thing is unresolvable (`dynamic: true`) -- the same "an option this file has not heard
 *  of makes the invocation unresolvable, not silently ignored" convention stripWrapperOptions() already uses
 *  throughout this file. `cmd /q /d /c "$x"` and `cmd /e:on /v:on /k "$x"` both resolve past their own switches
 *  this way; an unrecognised `/x` before reaching `/C`/`/K` still associates (fail toward fire) rather than
 *  silently being treated as though it could never be cmd. */
function stripCmdSwitches(s) {
  let out = String(s).replace(/^\s+/, '');
  for (let i = 0; i < 8; i++) {
    if (out === '') return { rest: out, dynamic: false };
    const m = /^\/([A-Za-z])/.exec(out);
    if (!m) return { rest: out, dynamic: false }; // not a "/"-led switch at all -- caller decides what remains
    const letter = m[1].toUpperCase();
    if (letter === 'C' || letter === 'K') return { rest: out, dynamic: false }; // cmd's own flag -- stop here
    const after = out.slice(m[0].length);
    if (CMD_SWITCH_NOVALUE.includes(letter)) {
      if (after === '' || /^\s/.test(after)) { out = after.replace(/^\s+/, ''); continue; }
      return { rest: '', dynamic: true }; // unexpected content glued onto a known no-value switch
    }
    if (CMD_SWITCH_VALUE.includes(letter)) {
      const vm = CMD_SWITCH_VALUE_RE.exec(after);
      if (vm) { out = after.slice(vm[0].length).replace(/^\s+/, ''); continue; }
      return { rest: '', dynamic: true }; // missing or malformed :ON|OFF value
    }
    return { rest: '', dynamic: true }; // an unrecognised switch letter
  }
  return { rest: '', dynamic: true }; // switch-strip budget exhausted
}

/** cmdAssociatesFlag(stmtText) -> boolean. Does `stmtText` (the text strictly BEFORE a found `/C`/`/K` token,
 *  same convention as statementCommandWord's own `s.slice(start, cStart)`) resolve to a genuine cmd.exe
 *  invocation? Strips env assignments / wrapper prefixes / openers via stripLeadingPrefixes (so `sudo cmd /c
 *  "$x"`, `FOO=bar cmd /c "$x"` and `{ cmd /c "$x"; }` all still associate, exactly like the `-c` pathway
 *  already does for a shell), then reads the leading word and checks it against CMD_WORD_RE, then strips cmd's
 *  OWN switches from whatever follows that word -- association succeeds only when NOTHING but recognised
 *  switches (and whitespace) remains between "cmd" and the flag position the caller already found. An
 *  unresolvable prefix, an unresolvable leading word, or an unrecognised cmd switch all fail TOWARD firing (the
 *  same "cannot bound it -> associate" principle every other attribution check in this file already uses) --
 *  only a CONFIRMED non-cmd leading word (a real, different, resolvable program name) is silent. */
function cmdAssociatesFlag(stmtText) {
  const stripped = stripLeadingPrefixes(stmtText);
  if (stripped.dynamic) return true;
  const word = readUnquotedWord(stripped.rest, 0);
  if (word.dynamic) return true;
  const isCmd = CMD_WORD_RE.test(word.text) || CMD_WORD_RE.test(word.textLiteral);
  if (!isCmd) return false;
  const sw = stripCmdSwitches(stripped.rest.slice(word.end));
  if (sw.dynamic) return true;
  return sw.rest.trim() === '';
}

// CMD_FLAG_OCCUR_RE -- a standalone "/C" or "/K" token (case-insensitive: real cmd.exe switches are), mirroring
// C_FLAG_OCCUR_RE's own "(?:^|\s)" leading-boundary convention exactly. The trailing lookahead is the one part
// that MUST differ from a plain "\b": "/" is also a Windows/MSYS PATH character (Git Bash's own drive-letter
// convention writes "C:\" as "/c/..."), so "cd /c/Users/YOU" contains a `\b`-bounded "/c" that is NOT cmd's
// own flag at all -- it is the first segment of an unrelated path. Requiring the character right after the
// letter to be whitespace, a quote/backtick, or the end of the text (never another "/" continuing a path) rules
// that shape out at the SCAN stage, before attribution is even consulted; the leading command word still has to
// resolve to "cmd" too (cmdAssociatesFlag), which independently rules out "cd" either way.
const CMD_FLAG_OCCUR_RE = /(?:^|\s)\/[ck](?=[\s"'`]|$)/gi;

/** envAssociatesFlag(stmtText) -> boolean. Does `stmtText` (the text strictly BEFORE a found "-S"/
 *  "--split-string" token) resolve to a genuine `env` invocation? Cannot reuse stripLeadingPrefixes()
 *  end-to-end the way cmdAssociatesFlag does, because "env" is itself a WRAPPER_NAMES entry -- stripLeadingPrefixes
 *  would happily swallow it as just another prefix wrapper (exactly what the `-c` pathway WANTS, to reach the
 *  real shell word further on), leaving nothing here to check "was the swallowed word actually env?" against.
 *  This function strips OTHER leading wrappers/assignments/openers the same way, but stops the INSTANT the
 *  current leading word resolves to "env"/"env.exe" (ENV_WORD_RE) and, from there, strips ONLY env's OWN
 *  further options (`-i`, `-u NAME`, ...) via the ordinary stripWrapperOptions('env') grammar -- so `sudo env -i
 *  -S '...'` and `{ env -S '...'; }` still associate. An unresolvable prefix, an unresolvable leading word, or
 *  unresolvable env options all fail TOWARD associating; only a resolvable, non-"env", non-wrapper leading word
 *  (a genuinely different program, e.g. `sudo -S bash -c "$x"` -- sudo's OWN `-S`/`--stdin` flag, unrelated to
 *  env's `-S`) is silent. */
function envAssociatesFlag(stmtText) {
  let s = String(stmtText).replace(/^\s+/, '');
  for (let i = 0; i < 12; i++) {
    const before = s;
    const assigned = stripEnvAssignment(s);
    if (assigned !== null) s = assigned;
    s = s.replace(OPENER_RE, '');
    s = s.replace(CASE_ARM_RE, '');
    const word = readUnquotedWord(s, 0);
    if (word.dynamic) return true;
    if (ENV_WORD_RE.test(word.text) || ENV_WORD_RE.test(word.textLiteral)) {
      const sw = stripWrapperOptions(s.slice(skipWs(s, word.end)), 'env');
      if (sw.dynamic) return true;
      return sw.rest.trim() === '';
    }
    const wm = matchWrapper(s);
    if (!wm) return false; // a resolvable, non-"env", non-wrapper leading word: definitely not an env invocation
    const stripped = stripWrapperOptions(s.slice(wm.restIndex), wm.name);
    if (stripped.dynamic) return true;
    s = stripped.rest;
    if (s === before) return false; // no progress made -- treat like a resolved, non-"env" word (defensive)
  }
  return true; // strip budget exhausted without ever resolving -- fail toward associating
}

// ENV_SPLIT_FLAG_OCCUR_RE -- a standalone "-S" short option or "--split-string"/"--split-string=" long option
// (SB-L3 residual, wp-u1). Captured in group 1 so the caller can tell which of the three shapes matched without
// re-deriving its length from m[0] (whose own leading boundary, like C_FLAG_OCCUR_RE's, may or may not include
// a consumed leading whitespace character).
const ENV_SPLIT_FLAG_OCCUR_RE = /(?:^|\s)(-S|--split-string=|--split-string)\b/g;

/** rawOperandContent(s, start, end) -> the RAW text of one complete shell word spanning s[start..end) (as
 *  returned by readOptionValue), with a single matching pair of OUTER quotes stripped when the whole word is
 *  exactly one quoted span (the common case for an env -S operand: `'sh -c ${X}'`) -- mirrors the existing `-c`
 *  single-quoted-argument convention (`s.slice(i + 1, close)`) of checking the INNER raw text directly, never
 *  an unescaped/interpreted version, since hasLiveSubstitution only ever needs to see the literal `$`/backtick
 *  characters themselves. A glued multi-segment value keeps its own inner quote characters in the returned
 *  text, which cannot hide a live marker from hasLiveSubstitution -- only ever adds harmless extra characters. */
function rawOperandContent(s, start, end) {
  if (end - start >= 2 && (s[start] === "'" || s[start] === '"') && s[end - 1] === s[start]) {
    return s.slice(start + 1, end - 1);
  }
  return s.slice(start, end);
}

/** envSplitOperandStart(s, flag, flagEnd) -> the index where the -S/--split-string operand's own text begins,
 *  or -1 when no operand is present at all (a trailing, argument-less flag -- nothing to judge). Mirrors the
 *  existing short/long value-option reading conventions in stripWrapperOptions() (glued short form,
 *  space-separated short form, glued `=` long form, space-separated long form) without reusing that function
 *  directly, since this caller needs the operand's own START INDEX in the ORIGINAL text, not a stripped
 *  remainder string. */
function envSplitOperandStart(s, flag, flagEnd) {
  if (flag === '--split-string=') return flagEnd; // "=value" is always glued for this form
  const after = s.slice(flagEnd);
  if (flag === '-S') {
    if (after === '') return -1;
    return /^\s/.test(after) ? skipWs(s, flagEnd) : flagEnd; // space-separated, or glued "-Svalue"
  }
  // flag === '--split-string' (no "="): a MANDATORY value option only ever takes a space-separated value here.
  const ws = /^\s+/.exec(after);
  if (!ws || ws[0].length >= after.length) return -1;
  return flagEnd + ws[0].length;
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
 *  never throws.
 *
 *  SB-M5 (wave 12, codex-recheck twelfth pass / wp-t1): a single shared work budget (see statementStart's own
 *  doc) bounds the TOTAL backward-scanning cost across every "-c" occurrence in `text` to a value that grows
 *  only LINEARLY with `text.length`, closing off the tokens x length quadratic blowup a text padded with many
 *  "-c" tokens could otherwise drive this function toward — exhausting it fires immediately (fail toward fire,
 *  the same direction an unterminated quote mask already takes), never silently finishes late. */
function cArgLiveAfterFlag(text) {
  const s = String(text);
  const mask = scanQuotes(s);
  const re = new RegExp(C_FLAG_OCCUR_RE.source, 'g');
  const budget = { steps: 0, cap: Math.max(20000, s.length * 20), exhausted: false };
  let m;
  while ((m = re.exec(s)) !== null) {
    const cStart = m.index + m[0].length - 2; // m[0] is "-c" or "\s-c"; the flag itself is its last 2 chars
    if (mask.unterminated) return true; // cannot bound the quote structure at all -> fail toward fire
    if (mask.inside(cStart)) continue; // N09: "-c" sitting inside quoted DATA (e.g. a commit message) is not a real flag
    const start = statementStart(s, mask, cStart, budget);
    if (budget.exhausted) return true; // SB-M5: cannot finish resolving every "-c" occurrence -> fail toward fire
    const attribution = statementCommandWord(s.slice(start, cStart));
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

  // WAVE 12 FOLLOW-UP (wp-u1): cmd.exe's own "/C"/"/K" flag, parallel to the "-c" loop above -- see this file's
  // header. Shares the SAME `mask`/`budget` the "-c" loop above already computed, so total cost across both
  // passes stays bounded exactly the way SB-M5 already bounds the "-c" loop alone.
  const cmdRe = new RegExp(CMD_FLAG_OCCUR_RE.source, CMD_FLAG_OCCUR_RE.flags);
  while ((m = cmdRe.exec(s)) !== null) {
    const cStart = m.index + m[0].length - 2; // "/c"/"/k" is always the last 2 characters of this match
    if (mask.unterminated) return true;
    if (mask.inside(cStart)) continue; // a "/c"/"/k"-shaped token sitting inside quoted DATA is not a real flag
    const start = statementStart(s, mask, cStart, budget);
    if (budget.exhausted) return true;
    if (!cmdAssociatesFlag(s.slice(start, cStart))) continue;
    const i = skipWs(s, cStart + 2);
    if (i >= s.length) continue; // a trailing "/c"/"/k" with nothing after it: no argument to judge
    const ch = s[i];
    if (ch === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return true;
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

  // WAVE 12 FOLLOW-UP (wp-u1, SB-L3 residual): env's own -S/--split-string operand, checked directly for a live
  // marker regardless of any later "-c" in the same statement -- see this file's header for the full "why".
  const envSplitRe = new RegExp(ENV_SPLIT_FLAG_OCCUR_RE.source, 'g');
  while ((m = envSplitRe.exec(s)) !== null) {
    const flag = m[1];
    const flagStart = m.index + (m[0].length - flag.length);
    const flagEnd = flagStart + flag.length;
    if (mask.unterminated) return true;
    if (mask.inside(flagStart)) continue; // a "-S"-shaped token sitting inside quoted DATA is not a real flag
    const start = statementStart(s, mask, flagStart, budget);
    if (budget.exhausted) return true;
    if (!envAssociatesFlag(s.slice(start, flagStart))) continue;
    const opStart = envSplitOperandStart(s, flag, flagEnd);
    if (opStart === -1) continue; // a trailing flag with nothing after it: no operand to judge
    const opEnd = readOptionValue(s, opStart);
    if (hasLiveSubstitution(rawOperandContent(s, opStart, opEnd))) return true;
  }
  return false;
}

module.exports = {
  scanQuotes, stripHeredocs, findHeredocDelim,
  cArgLiveAfterFlag, scanDoubleQuoteLive, readBareWord, isSubstitutionDollar, hasLiveSubstitution, stripEnvAssignment,
  MARKER_RE, MARKER_AT_RE,
};
