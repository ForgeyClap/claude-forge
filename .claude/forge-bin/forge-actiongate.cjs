#!/usr/bin/env node
'use strict';
/**
 * forge-actiongate.cjs — hard-gates classifier (2026-07-18, WAVE A / A1). The SINGLE source of truth for
 * detecting irreversible actions and project-isolation escapes, defined once in
 * config/orchestration/hard-gates.json and consumed here so later waves (forge-verify's honesty binding,
 * forge-autonomy's precedence tier 2) can never drift onto two different regex sets — they MUST require()
 * classify()/KNOWN_GATES from this file rather than re-implement the patterns (the exact risk cc-risks G3
 * and dd-autonomy flagged). Zero-dependency (fs/path only). Pure classify() — the only I/O is a cached,
 * synchronous read of the JSON config on first use.
 *
 * MODEL:
 *   classify(input, opts) -> { gate:boolean, id:string|null, class:'irreversible'|'isolation'|null,
 *                               reason:string|null, matched:[gateId, ...] }
 *   input may be:
 *     - a plain string (free text / command / action description), OR
 *     - an event-shaped object: { text, action, command, path, project_root }
 *   opts.projectRoot overrides input.project_root for the isolation (write-outside-root) check.
 *   opts.configPath overrides the default config/orchestration/hard-gates.json location (test hermeticity).
 *
 *   A TEXT gate (class:irreversible, match.kind==='regex') fires when its pattern matches the combined
 *   text (input.text + input.action + input.command).
 *
 *   A COMMAND gate (class:irreversible, match.kind==='command', added 2026-08-01) fires when
 *   `match.pattern` matches ANY SINGLE COMMAND SEGMENT of that same combined text, or when the optional
 *   `match.pattern_line` matches the WHOLE text. WHY A THIRD KIND: the nine original regex gates describe
 *   *spoken intent* ("deploy to production", "send the email to the client"), so a destructive COMMAND
 *   matched nothing at all — measured 2026-08-01: `taskkill /IM node.exe`, `Stop-Process -Name node`,
 *   `pkill node`, `rm -rf ./src` and `git reset --hard origin/main` all classified as gate:false, even
 *   though the first three are verbatim the commands the owner's global HARD MUST forbids (written after
 *   the 2026-07-29 incident where an agent cleaning up a broken Chrome killed the live Forge gateway on
 *   port 4100 along with it).
 *
 *   WHAT THE SEGMENT SPLIT REALLY DOES — CORRECTED 2026-08-01. This header previously called the split
 *   "the load-bearing part" and claimed that without it `echo hi && rm -rf /` would escape. That was
 *   FALSE and is retracted. Measurement (splitCommands() neutralised to return the whole string as ONE
 *   segment, then the corpus re-run): ZERO of the five chained cases flipped — `echo hi && rm -rf /`,
 *   `npm run dev && taskkill /IM node.exe`, `git fetch; git reset --hard origin/main`,
 *   `Get-Process node | Stop-Process` and `cd /tmp && rm -rf ./src` all still fired, because every command
 *   pattern uses `[^\n]*` lookaheads that already scan the rest of the line. The split's real, measurable
 *   job is the OPPOSITE — FALSE-POSITIVE SUPPRESSION: it keeps each command's flags, targets and
 *   except-valve with THAT command, so `rm -rf node_modules && npm ci`, `rm -rf ./_scratch/run-1 && npm ci`
 *   and `rm ./notes.txt && echo -rf` stay silent instead of firing on a blob match. Those are the cases
 *   that flip; the suite pins them (section 2c) so removing the split turns them red.
 *
 *   `match.pattern_line` is the counterpart: a danger that no single segment can see. `Get-Process node |
 *   Stop-Process` splits into a harmless selector and a target-less killer — only the whole line shows the
 *   selection was BY NAME. It is never segment-split and has no except valve.
 *
 *   `match.except` (optional) is the FALSE-ALARM valve: when it excuses the SAME segment that matched,
 *   that segment does not fire. It exists because a recursive delete of `node_modules` or `_scratch` is
 *   ordinary work, not an incident.
 *
 *   THE VALVE HAS NO PARSER (2026-08-01, ROUND 4 — the rewrite, not another patch). It is EXACT STRING
 *   EQUALITY between the raw command segment and a short, literal allow-list built once from two literal
 *   config lists (`command_prefixes` x `argument_tails`, joined by a single space). Nothing about the input
 *   is tokenised, normalised, unquoted, path-resolved or interpreted. `isExcusedSegment()` is a Set lookup.
 *
 *   WHY THE PARSER IS GONE — FOUR ROUNDS OF THE SAME LOSS. Every previous version tried to DECIDE whether a
 *   shell target was safe by modelling shell semantics, and every round a piece we had not modelled walked
 *   straight through:
 *     round 1  no command detection at all — a destructive command matched nothing;
 *     round 2  substring match on the raw path      -> `rm -rf ./_scratch/../.claude` was excused;
 *     round 3  the segment split amputated the path -> `rm -rf ./_scratch/$(whoami)/../../.claude` was
 *              excused (the valve judged the stump `rm -rf ./_scratch/`);
 *     round 4  the PowerShell comma ARRAY           -> `rm -r -force .claude,./tmp` was excused, because
 *              the tokeniser saw ONE target and its normaliser found a path segment `tmp` in it. Proven
 *              end-to-end in a throwaway directory: that command really deleted BOTH directories.
 *   Rounds 2-4 were all the same failure — a zero-dependency classifier is not a PowerShell parser and is
 *   not a POSIX parser, and each round bought only the semantics we had just been shown. Exact equality
 *   ends the game: there is nothing left to model. What is not byte-identical to a listed literal simply
 *   gets the warning.
 *
 *   THE ONE GUARD THAT SURVIVES, and why it must. Equality alone is NOT enough, because the segment handed
 *   to the valve may be a STUMP of a longer command: `rm -rf node_modules$(echo /../.claude)` splits into
 *   the segment `rm -rf node_modules` — byte-identical to a listed literal — while the real command deletes
 *   `.claude`. So a segment is only eligible when the splitter marked it INTACT (isIntactSegment(): no
 *   `$(`/backtick on either side, no separator GLUED to its tail with text still following). That guard is
 *   about SEGMENT BOUNDARIES, not about paths; it decides whether the string is whole, never what it means.
 *   The counterfactual is pinned in the suite: remove it and that one input becomes a bypass again.
 *
 *   PRICE, measured and stated without softening: on a 44-command corpus of legitimate cleanup, 30 now
 *   warn (up from 10). Everything that is not exactly `rm -rf node_modules`-shaped — `sudo`, `.\` paths,
 *   `%TEMP%`, `/tmp/...`, `./_scratch/run-1`, `npx --yes rimraf`, a glob, an env var — over-warns. The gate
 *   is ADVISORY, so noise is the price we deliberately pay for a valve with nothing left to bypass. The
 *   full named list lives in the suite's PRICE section and hard-gates.json `_not_caught.exact_valve_price`.
 *   (See hard-gates.json's `_not_caught` for the full, deliberate list of what these gates do not cover.)
 *
 *   A PATH-ESCAPE gate (class:isolation,
 *   match.kind==='path-escape') fires only when BOTH a project_root and a path are supplied and the
 *   resolved real path of `path` lands outside the resolved real path of `project_root` (covers `../`
 *   relative escapes, absolute-outside-root paths, and a symlinked/junctioned intermediate directory that
 *   hides an escape — same longest-existing-real-ancestor technique forge-sync.cjs::containmentSafe uses).
 *
 *   When more than one gate matches, classify() reports the FIRST match (config file order) as the primary
 *   `id`/`class`/`reason`, and lists every matched gate id in `matched` so a caller never loses the others.
 *
 * CLI:
 *   node forge-actiongate.cjs classify "<text>" [--path <p>] [--root <projectRoot>] [--json]
 *   node forge-actiongate.cjs list [--json]
 * Exit codes: 0 = no gate triggered · 3 = a gate triggered (mirrors the sibling *-guard tools' STOP=3
 * convention, e.g. forge-checkpoint's resumable=3) · 2 = usage/config error.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'hard-gates.json');

/** The `match.except` forms this classifier knows how to evaluate — exactly one since round 4.
 *  loadGates() refuses anything else rather than silently ignoring it (an ignored valve = a permanent
 *  over-warn, a misread one = a bypass). */
const EXCEPT_KINDS = new Set(['exact-segment']);

let _cache = null; // { path, data } — cached across calls in the SAME process; tests override via opts.configPath
function loadGates(configPath) {
  const p = configPath || CONFIG_PATH;
  if (_cache && _cache.path === p) return _cache.data;
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.gates) || data.gates.length === 0) {
    throw new Error('forge-actiongate: ' + p + ' is missing a non-empty "gates" array');
  }
  for (const g of data.gates) {
    if (!g.id || !g.class || !g.match || !g.match.kind) {
      throw new Error('forge-actiongate: gate entry missing id/class/match.kind in ' + p + ': ' + JSON.stringify(g));
    }
    if (g.match.kind === 'command' && !g.match.pattern && !g.match.pattern_line) {
      throw new Error('forge-actiongate: command gate "' + g.id + '" has neither match.pattern nor match.pattern_line in ' + p);
    }
    // An except valve that is silently ignored would turn a typo into a permanent over-warn, and one that
    // is silently MISREAD is a bypass. Since round 4 there is exactly one legal form, so anything else —
    // including the old string-regex form — is refused at load time.
    if (g.match.except !== undefined && g.match.except !== null) {
      const ex = g.match.except;
      if (typeof ex !== 'object' || Array.isArray(ex) || !EXCEPT_KINDS.has(ex.kind)) {
        throw new Error('forge-actiongate: gate "' + g.id + '" has an unsupported match.except (expected {kind:"exact-segment", command_prefixes:[], argument_tails:[]}) in ' + p);
      }
      if (!Array.isArray(ex.command_prefixes) || !Array.isArray(ex.argument_tails)
        || ex.command_prefixes.length === 0 || ex.argument_tails.length === 0) {
        throw new Error('forge-actiongate: gate "' + g.id + '" match.except needs non-empty command_prefixes and argument_tails in ' + p);
      }
    }
  }
  _cache = { path: p, data };
  return data;
}

function testTextGate(gate, text) {
  if (!text) return false;
  const m = gate.match;
  if (m.kind !== 'regex' || !m.pattern) return false;
  const re = new RegExp(m.pattern, m.flags || 'i');
  return re.test(text);
}

/** SHELL_SPLIT_RE — the separators that end one command and begin another in a shell/PowerShell string.
 *  Order matters inside the alternation: the two-character forms (`&&`, `||`) come BEFORE their
 *  single-character counterparts (`&`, `|`) so they are consumed whole instead of splitting twice.
 *  `$(` and a backtick are included because command substitution starts a genuinely separate command. */
const SHELL_SPLIT_RE = /&&|\|\||;;|;|\||&|\r\n|\n|\r|\$\(|`/g;

// AMPUTATING_SEPARATORS / stripCommandOpeners / commandPositionCandidates / laterBranchStarts live in the
// sibling forge-actiongate-position.cjs (split out 2026-09-24, codex-recheck wave 2, to keep this file under
// 500 lines) — see that file's own header for the full "why". Re-exported below unchanged so every existing
// caller/test (`gate.AMPUTATING_SEPARATORS`, `gate.stripCommandOpeners`, `gate.commandPositionCandidates`)
// keeps working with no call-site change.
const POSITION = require('./forge-actiongate-position.cjs');
const { AMPUTATING_SEPARATORS, stripCommandOpeners, commandPositionCandidates, laterBranchStarts, COMMAND_OPENER_STEPS } = POSITION;
// forge-gate-quotes.cjs — the shared quote/heredoc mask (2026-09-24 quoting-layer redesign, wp-j1); computed
// ONCE per classify() call in testCommandGate()/testCommandGateRaw() below and threaded through with ORIGINAL
// offsets so command-position detection never restarts a mask at a segment boundary. See that file's header.
const QUOTES = require('./forge-gate-quotes.cjs');

/** isIntactSegment(entry) -> boolean — can this segment's LAST TOKEN be trusted to be whole?
 *  NO when: the segment sits inside a command substitution (`sepBefore` is `$(`/backtick); or a separator
 *  follows it with more text after it AND that separator either opens a substitution or is GLUED to the
 *  segment's tail (no whitespace before it), which is exactly how `./_scratch/$(whoami)/../../.claude`
 *  becomes the innocent stump `./_scratch/`.
 *  A separator with NOTHING after it is not amputation — a trailing `;` or newline on `rm -rf node_modules`
 *  cut no target — so it stays intact. PURE. */
function isIntactSegment(entry) {
  if (!entry) return false;
  if (entry.sepBefore && AMPUTATING_SEPARATORS.has(entry.sepBefore)) return false;
  if (entry.sepAfter && entry.hasFollowing) {
    if (AMPUTATING_SEPARATORS.has(entry.sepAfter)) return false;
    if (entry.gluedAfter) return false;
  }
  return true;
}

/** splitCommandsDetailed(text) -> [{segment, raw, offset, sepBefore, sepAfter, gluedAfter, hasFollowing, intact}]
 *  The split WITH the evidence the except valve needs to know whether it is looking at a whole command or
 *  at a stump. `splitCommands()` is this function's `segment` column and is unchanged in behaviour. `offset`
 *  (2026-09-24, N04 root-cause fix) is `entry.segment`'s own absolute character position in the ORIGINAL
 *  `text` — added so callers (commandPositionCandidates/laterBranchStarts) can query a quote mask built ONCE
 *  over the FULL text with the segment's real position, instead of a mask restarted at each segment's own
 *  local index 0 (see forge-actiongate-position.cjs's header for the exact bug that caused).
 *  PURE, never throws. Deliberately NOT a shell parser: quoting/escaping is not honoured, so a separator
 *  inside a quoted argument still splits. That direction fails SAFE for detection — splitting more can only
 *  ever produce MORE segments to test, never fewer — and since 2026-08-01 it no longer weakens the valve
 *  either, because a cut segment is marked `intact:false` and can never be excused. */
function splitCommandsDetailed(text) {
  if (!text) return [];
  const s = String(text);
  const re = new RegExp(SHELL_SPLIT_RE.source, 'g');
  const entries = [];
  let last = 0, prevSep = null, m;
  const leadTrim = (raw) => raw.length - raw.replace(/^\s+/, '').length;
  while ((m = re.exec(s)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; } // defensive: never spin on a zero-width match
    const raw = s.slice(last, m.index);
    entries.push({
      raw,
      segment: raw.trim(),
      offset: last + leadTrim(raw),
      sepBefore: prevSep,
      sepAfter: m[0],
      gluedAfter: raw.length > 0 && !/\s$/.test(raw),
      hasFollowing: /\S/.test(s.slice(m.index + m[0].length)),
    });
    prevSep = m[0];
    last = m.index + m[0].length;
  }
  const tail = s.slice(last);
  entries.push({
    raw: tail, segment: tail.trim(), offset: last + leadTrim(tail), sepBefore: prevSep, sepAfter: null,
    gluedAfter: false, hasFollowing: false,
  });

  const out = [];
  for (const e of entries) {
    if (!e.segment) continue;
    e.intact = isIntactSegment(e);
    out.push(e);
  }
  return out;
}

/** splitCommands(text) -> string[] — the individual command segments of a (possibly chained) shell string. */
function splitCommands(text) {
  return splitCommandsDetailed(text).map((e) => e.segment);
}

/** _allowCache — the literal allow-list, built once per `except` spec object. WeakMap so a test that loads
 *  a throwaway config does not leak. */
const _allowCache = new WeakMap();

/** excusedSegments(spec) -> Set<string> — the COMPLETE, literal set of command segments this valve will
 *  ever excuse: `command_prefixes` x `argument_tails`, joined by ONE space. Both lists come from the config
 *  and are used verbatim; the cross product is over CONFIG literals only — no input is ever involved in
 *  building it. With 4 prefixes and 4 tails that is 16 fixed strings, and the valve can say yes to nothing
 *  else. PURE apart from the cache. */
function excusedSegments(spec) {
  if (!spec) return new Set();
  const hit = _allowCache.get(spec);
  if (hit) return hit;
  const set = new Set();
  for (const prefix of spec.command_prefixes || []) {
    for (const tail of spec.argument_tails || []) set.add(String(prefix) + ' ' + String(tail));
  }
  _allowCache.set(spec, set);
  return set;
}

/** isExcusedSegment(match, segment) -> boolean — THE WHOLE VALVE (round 4, 2026-08-01). Exact string
 *  equality against the literal set above. No tokenising, no unquoting, no path normalisation, no
 *  `..` resolution, no case folding, no globbing, no cleverness of any kind — a Set lookup on the raw
 *  segment. Everything that is not byte-identical to a listed literal gets the warning.
 *  Consequence, and the reason the previous three rounds are now unreachable: a segment containing a
 *  comma, a quote, a metacharacter, `..`, or a substitution cannot be excused, because no listed literal
 *  contains one of those characters (asserted mechanically in the suite). PURE, never throws. */
function isExcusedSegment(m, segment) {
  if (!m || !m.except) return false;
  return excusedSegments(m.except).has(String(segment));
}

// hasLiveCArg() (N02, codex-recheck 2026-09-24, fourth pass — the -c argument policy, root-cause rewrite) lives
// in the sibling forge-actiongate-position.cjs (kept there for the same reason as the rest of that file —
// staying under the 500-line budget here); re-exported below unchanged. See that file's own header for the
// full "why", and forge-gate-quotes.cjs for the shared two-shell-layer read.
const { hasLiveCArg } = POSITION;

/** COMMAND_EXTRA_FIRE — per-gate-id extra JS predicates a command-kind gate ALSO fires on, beyond its JSON
 *  regex (exactly one entry, N02 above). Always OR'd alongside `match.pattern`, never a replacement for it —
 *  removing an entry here can only ever narrow a gate's coverage back toward the regex alone. */
const COMMAND_EXTRA_FIRE = { 'opaque-exec': hasLiveCArg };

/** patternLineFires(patternLine, flags, full, mask) -> boolean — WP-S8 root-cause fix (2026-09-26). A
 *  `pattern_line` command gate is meant to catch a REAL shell construct (a pipe into an interpreter, a
 *  `Get-Process | Stop-Process`, …) sitting ANYWHERE in the whole command line — that is genuinely why it
 *  is tested against the FULL text and not one split segment (see this file's own header). But testing it
 *  with a bare `.test(full)` is quote-BLIND: a harmless, common shape like a search/filter tool's own quoted
 *  pattern argument — `grep -nE "a|Bash|b" f | head`, `Select-String -Pattern "a|Bash" f | Select-Object`,
 *  `sed -E 's/a|sh/x/' f | sort`, `awk '/a|bash/' f | sort` — MENTIONS an interpreter name inside its own
 *  quoted DATA, right next to a `|` character that is not a shell pipe at all; the old `.test(full)` matched
 *  that quoted `|Bash`/`|sh` exactly like a real `| bash` pipe and blocked a command that never runs
 *  anything. Fix: walk every match of `pattern_line` with a shared, ONE-TIME quote mask (the same
 *  forge-gate-quotes.cjs::scanQuotes() mask this file already computes for the segment loop below) and only
 *  count a match as real when its own start position is NOT inside a quoted span — exactly the same
 *  "`mask.inside(pos)` means quoted DATA, not a real token" rule this file already applies to a `-c` flag
 *  and forge-actiongate-position.cjs already applies to a later else/catch keyword. When the mask itself
 *  cannot be resolved (`mask.unterminated` — an unclosed quote somewhere in the text), every match still
 *  counts: this project's own stated rule is "any doubt -> stay stricter" (forge-gate-data.cjs's header),
 *  so an ambiguous command still fires rather than silently passing through unexamined. A quoted string that
 *  CLOSES before a real trailing `| bash` (`echo "a|b" | bash`) is unaffected: that real pipe's own position
 *  sits AFTER the closing quote, so the mask reports it as not-inside and the match still fires.
 *
 *  WP-S9 follow-up (2026-09-26). WP-S8's own start-position check is enough for opaque-exec, whose every
 *  pattern_line alternative BEGINS with the dangerous token itself (the `|` of a real pipe). It is not enough
 *  for kill-by-name's/destructive-delete's pattern_line alternatives: their match commonly STARTS on a real,
 *  unquoted CONTEXT token — a search tool's own name — while the token that actually makes the match
 *  dangerous sits LATER in the very same match, inside quoted data that context token's own argument carries.
 *  Reproduced live (Lead, real hook, this session): `grep -nE "a|xargs|kill" file.txt` (kill-by-name) and
 *  `ls -R docs | grep "rm"` (destructive-delete) both fired on a search tool's own quoted pattern argument —
 *  "grep"/"ls" truly sit outside any quote, so WP-S8's check alone waved the match through, even though
 *  "kill"/"rm" never do. Optional 5th argument `trigger` (a RegExp, see DANGER_TRIGGER below): when given, a
 *  match counts only when triggerClearsQuotes() (below) says the trigger itself clears — i.e. it has at
 *  least one occurrence, inside the matched text, that the mask reports as NOT inside a quoted span. A gate
 *  with no trigger (the `trigger` argument omitted) is completely unchanged from the WP-S8 behaviour above —
 *  every existing caller that does not pass a 5th argument keeps its exact prior result. */
function patternLineFires(patternLine, flags, full, mask, trigger) {
  const gFlags = flags.includes('g') ? flags : flags + 'g';
  const re = new RegExp(patternLine, gFlags);
  let m;
  while ((m = re.exec(full)) !== null) {
    if (mask.unterminated) return true;
    if (!mask.inside(m.index) && triggerClearsQuotes(trigger, m[0], m.index, mask)) return true;
    if (m[0].length === 0) re.lastIndex++; // defensive: never spin on a zero-width match
  }
  return false;
}

/** triggerClearsQuotes(trigger, text, baseOffset, mask) -> boolean — WP-S9 (2026-09-26), the shared check
 *  patternLineFires() and testCommandGate()/testCommandGateRaw()'s segment loop both consult once a
 *  `pattern`/`pattern_line` match has already been found. `trigger` names the SPECIFIC dangerous verb(s) that
 *  match can never be dangerous without (see DANGER_TRIGGER below) — deliberately NOT "re-test the whole
 *  pattern against a masked copy of the text": a gate's own pattern can legitimately expect a quote as
 *  ORDINARY syntax this function must never second-guess (kill-by-name's own wmic arm matches a real
 *  `name="node.exe"` WQL-style query — genuine syntax, not a search tool's inert argument), so only the named
 *  trigger is ever checked against the mask, never the pattern's other context.
 *
 *  Returns true (the trigger "clears", i.e. this match still counts) when: `trigger` is falsy — the gate
 *  named no trigger at all, so this is a pure no-op and the caller's own prior check decides alone; the mask
 *  itself could not be resolved (`mask.unterminated` — this project's existing "any doubt -> stay stricter"
 *  rule, forge-gate-data.cjs's header); the trigger never occurs anywhere in `text` at all (a config/pattern
 *  mismatch that should not happen for a real match, since every trigger is a subset of what its own gate's
 *  pattern already required — failing toward blocking rather than guessing); or the trigger has at least one
 *  occurrence whose ABSOLUTE position (`baseOffset` + that occurrence's own relative index) the mask reports
 *  as NOT inside a quoted span. Returns false ONLY when the trigger truly occurs at least once and every
 *  occurrence sits inside quoted data. Pure, never throws. */
function triggerClearsQuotes(trigger, text, baseOffset, mask) {
  if (!trigger) return true;
  if (mask.unterminated) return true;
  const tFlags = trigger.flags.includes('g') ? trigger.flags : trigger.flags + 'g';
  const tRe = new RegExp(trigger.source, tFlags);
  let tm;
  let found = false;
  while ((tm = tRe.exec(text)) !== null) {
    found = true;
    if (!mask.inside(baseOffset + tm.index)) return true;
    if (tm[0].length === 0) tRe.lastIndex++; // defensive: never spin on a zero-width match
  }
  return !found;
}

/** BARE_ASSIGNMENT_RE / onlyQuotedAssignmentAtRest(entry) — WP-S9 (2026-09-26). A live probe against the
 *  shipped forge-gate-hook.test.cjs found that suppressing a `pattern` match whenever its trigger sits
 *  inside a quote — unconditionally — is TOO WIDE: `bash -c "rm -rf x"` (the quote IS a real interpreter
 *  argument), `echo 'rm -rf ./src' > run.sh && bash run.sh` and `git commit -m "rm -rf ./src" && node x.cjs`
 *  (a later command follows in the SAME text), `X='rm -rf ./src'; $X` (the assigned variable is invoked in
 *  a later segment) and `node -e '...rm -rf...'` (a real interpreter `-e` argument) are all PINNED to still
 *  block, and every one of them relies on exactly the quote-blind catch this file is otherwise removing —
 *  forge-gate-data.cjs's own stripInertData() deliberately leaves each of these un-stripped (a later
 *  interpreter/command follows, or the quote is itself live code), so the classifier's own catch is the last
 *  line of defence for them, by design.
 *
 *  The one shape narrow enough to allow is the exact live repro: a BARE assignment (`$name = value` /
 *  `name=value`) that is the WHOLE of the command text — no separator before or after it anywhere (so
 *  nothing else in the text could ever invoke, read or re-run what was just assigned) — reproduced live:
 *  `$j = '{"tool_input":{"command":"Remove-Item -Recurse -Force .\\src"}}'`, never invoked anywhere. Only a
 *  gate whose DANGER_TRIGGER entry sets `patternBareAssignmentOnly: true` is ever gated by this at all — see
 *  testCommandGate()'s own use of it below. */
const BARE_ASSIGNMENT_RE = /^\s*\$?[A-Za-z_][\w:.]*\s*=(?!=)\s*\S/;
function onlyQuotedAssignmentAtRest(entry) {
  return entry.sepBefore === null && entry.sepAfter === null && BARE_ASSIGNMENT_RE.test(entry.segment);
}

/** segmentTriggerClears(trig, entry, mask) -> boolean — the ONE gate testCommandGate()/testCommandGateRaw()'s
 *  segment loop consults for a `pattern` (not `pattern_line`) match, wrapping triggerClearsQuotes() with the
 *  `patternBareAssignmentOnly` guard (see DANGER_TRIGGER/onlyQuotedAssignmentAtRest above). True ("this match
 *  still counts") whenever there is no `pattern` trigger for this gate at all, or the trigger is gated to
 *  bare-assignment-only shapes and this segment is not one — in both cases the caller's existing quote-blind
 *  behaviour applies UNCHANGED. Only when the trigger genuinely applies here does it defer to
 *  triggerClearsQuotes()'s own verdict. */
function segmentTriggerClears(trig, entry, mask) {
  const trigger = trig && trig.pattern;
  if (!trigger) return true;
  if (trig.patternBareAssignmentOnly && !onlyQuotedAssignmentAtRest(entry)) return true;
  // v2.8.0 (independent gate review, HIGH): a quoted verb is only inert when nothing will EXECUTE that quoted
  // text. `powershell -Command "Stop-Process -Name x"`, `cmd /c "taskkill /IM x.exe"`, `sh -c "pkill x"` all
  // run it — and opaque-exec deliberately stays silent on a STATIC -c/-Command argument, so this gate is the
  // only thing that can see them. So for a gate flagged patternInertToolOnly the quoted-trigger exemption
  // applies ONLY to a bare assignment at rest or to a segment led by a known pure search tool; every other
  // shape keeps the old quote-blind catch (over-blocking is the documented safe direction).
  if (trig.patternInertToolOnly && !onlyQuotedAssignmentAtRest(entry) && !leadsWithInertSearchTool(entry.segment, mask, entry.offset)) return true;
  return triggerClearsQuotes(trigger, entry.segment, entry.offset, mask);
}

/** leadsWithInertSearchTool(segment) -> boolean — true only when the segment's FIRST word is a tool that
 *  merely searches/filters text and can never execute its pattern argument: grep/egrep/fgrep/rg/ag/ack/
 *  findstr/Select-String/sls, or `git grep` / `git log` (whose --grep/-S/-G arguments are data). A leading
 *  path and a .exe suffix are allowed (`C:\\...\\rg.exe`, `/usr/bin/grep`). Deliberately NOT inert: awk
 *  (system()), sed (GNU `e`), xargs/find -exec, every shell/interpreter, and every wrapper (sudo, env, time,
 *  timeout, nohup, nice, doas, watch) — a wrapper in front means the first word is the wrapper, so this
 *  returns false and the match keeps counting. */
// v2.8.0 verification review (N1): ag and ack are NOT inert (both accept --pager <cmd>), and even a pure search
// tool is only inert when nothing ELSE in its segment can execute text: an unquoted `(` (PowerShell sub-expression
// in argument position, e.g. `-Path (. 'Stop-Process' -Name x)`), a process substitution `<(`/`>(`, a command
// substitution `$(` or a backtick anywhere (both also run inside double quotes in bash), or a pager/pre-processor
// flag the tool itself runs through a shell (`git grep -O<cmd>`, `--open-files-in-pager`, `--pager`, `rg --pre`).
const INERT_SEARCH_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls']);
// case-SENSITIVE: `-O` (git grep's pager) is not grep's everyday `-o`
const EXEC_CAPABLE_FLAG_RE = /(?:^|\s)["']?(?:-O|--open-files-in-pager|--pager|--pre)/;
function segmentCanExecuteEmbeddedText(segment, mask, baseOffset) {
  const s = String(segment || '');
  if (/<\(|>\(|\$\(|`/.test(s)) return true;
  if (EXEC_CAPABLE_FLAG_RE.test(s)) return true;
  for (let i = s.indexOf('('); i !== -1; i = s.indexOf('(', i + 1)) {
    // no mask (a direct unit call) or an unresolved mask => treat every paren as live (fail toward blocking)
    if (!mask || mask.unterminated || typeof mask.inside !== 'function' || !mask.inside((baseOffset || 0) + i)) return true;
  }
  return false;
}
function leadsWithInertSearchTool(segment, mask, baseOffset) {
  const words = String(segment || '').trim().split(/\s+/);
  if (!words.length || !words[0]) return false;
  if (segmentCanExecuteEmbeddedText(segment, mask, baseOffset)) return false;
  const first = words[0].replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (INERT_SEARCH_TOOLS.has(first)) return true;
  if (first === 'git') {
    const sub = (words[1] || '').toLowerCase();
    return sub === 'grep' || sub === 'log';
  }
  return false;
}

/** DANGER_TRIGGER — per-gate-id, per-match-kind ("pattern"/"pattern_line") trigger sub-pattern for
 *  triggerClearsQuotes() above (WP-S9, 2026-09-26). Only the two gates the live repro named need one — every
 *  other command gate (opaque-exec, git-destructive) is completely unaffected (its own entry, or the whole
 *  map lookup, is undefined, and triggerClearsQuotes() treats an undefined trigger as an immediate no-op).
 *
 *  kill-by-name's `pattern` trigger names its leading verb (taskkill/Stop-Process/spps/kill/pkill/killall/
 *  wmic) rather than the wmic arm's own `delete`/`terminate` tail — every one of the config's own match
 *  examples leads with that verb UNQUOTED (a search tool's quoted pattern argument, by construction, never
 *  gets to be the command's own leading word), so this alone is enough to keep a quoted mention (`grep -rn
 *  "Stop-Process -Name" docs`, `Select-String -Pattern "taskkill /IM" -Path *.md`) silent without having to
 *  tell apart wmic's own real `name="node.exe"` WQL-style query syntax from a search tool's inert argument —
 *  a distinction this trigger never has to make, because it never looks at `name=`/`delete`/`terminate` at
 *  all. It carries `patternInertToolOnly` (v2.8.0, independent review HIGH): the earlier claim that the suite
 *  "proved it safe unconditionally" was only a missing fixture — a kill verb inside a static interpreter
 *  argument (`sh -c "pkill x"`, `powershell -Command "Stop-Process -Name x"`, `cmd /c "taskkill /IM x.exe"`)
 *  executes, so the quoted-verb exemption now applies only to a known pure search tool or a bare assignment.
 *
 *  destructive-delete's `pattern` trigger DOES carry `patternBareAssignmentOnly: true` — see
 *  onlyQuotedAssignmentAtRest()'s own doc above for exactly why a plain "trigger outside quotes" rule is not
 *  safe enough for this one gate's `pattern` field on its own. */
const DANGER_TRIGGER = {
  'kill-by-name': {
    pattern: /\b(?:taskkill|Stop-Process|spps|kill|pkill|killall|wmic)\b/i,
    // v2.8.0 (independent gate review, HIGH): without this, a kill verb inside a STATIC interpreter argument
    // (`powershell -Command "Stop-Process -Name x"`, `cmd /c "taskkill /IM x.exe"`, `sh -c "pkill x"`) was
    // suppressed — and opaque-exec intentionally ignores static -c args — so it ran unblocked. The quoted-verb
    // exemption now only applies to a bare assignment at rest or a known pure search tool (grep/rg/findstr/
    // Select-String…), which keeps `grep -rn "Stop-Process -Name" docs` silent.
    patternInertToolOnly: true,
    pattern_line: /\b(?:Stop-Process|spps|kill|pkill|killall)\b|\.Kill\s*\(\s*\)/i,
  },
  'destructive-delete': {
    pattern: /\b(?:Remove-Item|ri|rm|del|erase|rd|rmdir|rimraf)\b/i,
    patternBareAssignmentOnly: true,
    pattern_line: /\b(?:Remove-Item|ri|rm|del|erase|rd|rmdir)\b|\.Delete\s*\(\s*\)/i,
  },
};

/** testCommandGate(gate, text) -> boolean — true when gate.match.pattern_line matches the WHOLE text (outside
 *  any quoted span — see patternLineFires() above), or when the gate's own extra predicate (see
 *  COMMAND_EXTRA_FIRE) fires on the FULL text, or when ANY single command segment of `text` matches
 *  gate.match.pattern and is NOT excused by gate.match.except (see the COMMAND gate note in the header). The
 *  except valve is consulted ONLY for a segment the splitter marked `intact`. An amputated segment — one the
 *  split cut mid-argument — is judged on its pattern match alone, because the string it appears to be is not
 *  the command that will run. That guard is what stops `rm -rf node_modules$(echo /../.claude)` from being
 *  excused on the strength of its stump, and it is the ONLY thing besides exact equality that the valve
 *  depends on.
 *
 *  2026-09-24 (N02/N04 root-cause fix, wp-j1): `extra` (today: opaque-exec's `-c`-argument liveness check) is
 *  now evaluated ONCE against the FULL original text rather than per split candidate — a `-c` argument can
 *  itself be cut in two by the classifier's own quote-blind segment split, which would hide half of it from a
 *  per-segment reader; opaque-exec has no `except` valve, so there is nothing this ordering could ever excuse
 *  away. A single shared quote mask (forge-gate-quotes.cjs::scanQuotes(), computed ONCE over `text`) is passed
 *  to commandPositionCandidates() for every segment so later-branch keyword detection is judged against where
 *  a match REALLY sits in the original text, never a mask restarted at a segment boundary (see
 *  forge-actiongate-position.cjs's header for the exact bug this fixes). 2026-09-26 (WP-S8): that same shared
 *  mask is now built BEFORE the pattern_line check too, so pattern_line reuses it instead of computing a
 *  second one.
 *
 *  2026-09-26 (WP-S9): the per-segment `pattern` loop below is quote-blind on its own — `cands.some((c) =>
 *  re.test(c))` is a plain boolean test with no positional check at all, so a gate's dangerous verb sitting
 *  inside a segment's own quoted data (a PowerShell variable assigned a JSON string that happens to CONTAIN
 *  `"Remove-Item -Recurse -Force ..."` as inert text, reproduced live: `$j =
 *  '{"tool_input":{"command":"Remove-Item -Recurse -Force .\\src"}}'`) fired exactly like a real command.
 *  `entry.segment` is, by splitCommandsDetailed()'s own pinned contract, an exact substring of `full` at
 *  `entry.offset` — so triggerClearsQuotes() (see its own doc, and DANGER_TRIGGER above) is consulted against
 *  `entry.segment` itself (never a derived `cands` candidate, which may drop leading text but never adds any,
 *  so a trigger present in any candidate is always present in entry.segment too) with that exact offset. A
 *  gate with no `pattern` trigger (DANGER_TRIGGER[gate.id].pattern undefined) is unaffected — this is a pure
 *  no-op there, identical to before. */
function testCommandGate(gate, text) {
  if (!text) return false;
  const m = gate.match;
  if (m.kind !== 'command') return false;
  const flags = m.flags || 'i';
  const full = String(text);
  const mask = QUOTES.scanQuotes(full);
  const trig = DANGER_TRIGGER[gate.id];
  if (m.pattern_line && patternLineFires(m.pattern_line, flags, full, mask, trig && trig.pattern_line)) return true;
  const extra = COMMAND_EXTRA_FIRE[gate.id];
  if (extra && extra(full)) return true;
  if (!m.pattern) return false;
  const re = new RegExp(m.pattern, flags);
  for (const entry of splitCommandsDetailed(full)) {
    const cands = commandPositionCandidates(entry, mask);
    if (!cands.some((c) => re.test(c))) continue;
    if (entry.intact && isExcusedSegment(m, entry.segment)) continue;
    if (!segmentTriggerClears(trig, entry, mask)) continue;
    return true;
  }
  return false;
}

/** testCommandGateRaw(gate, text) -> boolean — the SAME shape test as testCommandGate(), but IGNORING
 *  match.except entirely (codex-recheck 2026-09-24, I01 / ISO-SCRATCH-SHORTCIRCUIT). The `except` valve is a
 *  false-ALARM suppressor for the classifier's own advisory verdict; it was never meant to be an ENFORCEMENT
 *  shortcut for the PreToolUse hook. forge-gate-hook.cjs uses this to decide whether a command has the SHAPE
 *  of a recursive delete at all — regardless of whether the valve would excuse it — so that every such shape
 *  is still routed through the hook's own scratchPassThrough() containment proof, never let through merely
 *  because it happened to be byte-identical to one of the 16 excused literals. Pure, never throws.
 *  2026-09-26 (WP-S8): pattern_line goes through the same quote-aware patternLineFires() as testCommandGate().
 *  2026-09-26 (WP-S9): the per-segment `pattern` loop also goes through the same triggerClearsQuotes() check
 *  as testCommandGate() (see that function's own doc) — a quoted, never-executing "shape" is not a real
 *  recursive-delete shape either, so the raw check must not disagree with the classifier's own verdict. */
function testCommandGateRaw(gate, text) {
  if (!text) return false;
  const m = gate.match;
  if (m.kind !== 'command') return false;
  const flags = m.flags || 'i';
  const full = String(text);
  const mask = QUOTES.scanQuotes(full);
  const trig = DANGER_TRIGGER[gate.id];
  if (m.pattern_line && patternLineFires(m.pattern_line, flags, full, mask, trig && trig.pattern_line)) return true;
  const extra = COMMAND_EXTRA_FIRE[gate.id];
  if (extra && extra(full)) return true;
  if (!m.pattern) return false;
  const re = new RegExp(m.pattern, flags);
  for (const entry of splitCommandsDetailed(full)) {
    const cands = commandPositionCandidates(entry, mask);
    if (!cands.some((c) => re.test(c))) continue;
    if (!segmentTriggerClears(trig, entry, mask)) continue;
    return true;
  }
  return false;
}

/** isPathEscape — true when targetPath resolves outside projectRoot. Resolves the longest EXISTING real
 *  ancestor of the target (a not-yet-existing leaf can't itself be a reparse point/symlink) so a
 *  symlinked/junctioned intermediate directory can't hide an escape, mirroring forge-sync.cjs's
 *  containmentSafe technique. Pure/never throws — an unresolvable path falls back to plain path.resolve. */
function isPathEscape(projectRoot, targetPath) {
  if (!projectRoot || !targetPath) return false;
  const root = path.resolve(String(projectRoot));
  const target = path.isAbsolute(String(targetPath))
    ? path.resolve(String(targetPath))
    : path.resolve(root, String(targetPath));

  let existingAncestor = target;
  const tail = [];
  while (existingAncestor && !fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break; // reached filesystem root without finding an existing ancestor
    tail.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  let realExisting;
  try { realExisting = fs.realpathSync.native(existingAncestor); } catch { realExisting = path.resolve(existingAncestor); }
  const realTarget = tail.length ? path.join(realExisting, ...tail) : realExisting;

  let realRoot;
  try { realRoot = fs.realpathSync.native(root); } catch { realRoot = root; }

  return !(realTarget === realRoot || realTarget.startsWith(realRoot + path.sep));
}

function normalizeInput(input) {
  if (input == null) return { text: '', path: null, project_root: null };
  if (typeof input === 'string') return { text: input, path: null, project_root: null };
  const text = [input.text, input.action, input.command].filter(Boolean).join(' ');
  return {
    text,
    path: input.path || input.target_path || null,
    project_root: input.project_root || input.projectRoot || null,
  };
}

function classify(input, opts) {
  opts = opts || {};
  const { gates } = loadGates(opts.configPath);
  const norm = normalizeInput(input);
  const projectRoot = opts.projectRoot || norm.project_root || null;
  const matched = [];

  for (const gate of gates) {
    if (gate.match.kind === 'path-escape') {
      if (projectRoot && norm.path && isPathEscape(projectRoot, norm.path)) matched.push(gate);
      continue;
    }
    if (gate.match.kind === 'command') {
      if (testCommandGate(gate, norm.text)) matched.push(gate);
      continue;
    }
    if (testTextGate(gate, norm.text)) matched.push(gate);
  }

  if (matched.length === 0) return { gate: false, id: null, class: null, reason: null, matched: [] };
  const first = matched[0];
  return { gate: true, id: first.id, class: first.class, reason: first.reason, matched: matched.map((g) => g.id) };
}

function listGates(opts) {
  const { gates } = loadGates(opts && opts.configPath);
  return gates.map((g) => ({ id: g.id, class: g.class, reason: g.reason, kind: g.match.kind }));
}

const KNOWN_GATES = ['deploy', 'git-push', 'spend', 'dns-change', 'prod-activate', 'credential-attach', 'credential-rotate', 'workflow-activate', 'outbound-sms',
  // 2026-08-01 — the three COMMAND gates (match.kind:'command'). They cover the destructive commands the
  // owner's global Orchestration-Safety HARD MUST names, which the nine free-text gates above could never
  // see because they describe spoken intent, not a command line.
  'kill-by-name', 'destructive-delete', 'git-destructive',
  // codex-recheck 2026-09-24 (S03) — a FOURTH command gate: feeding unknown/decoded content straight into an
  // interpreter (a pipe into sh/bash/pwsh/powershell, iex/Invoke-Expression/eval, `sh -c "$VAR"`) hides the
  // real command from every other gate; Forge cannot inspect it, so it stops instead of guessing.
  'opaque-exec',
  'write-outside-root'];

module.exports = {
  classify, listGates, loadGates, isPathEscape, testTextGate, testCommandGate, testCommandGateRaw, splitCommands, normalizeInput,
  // WP-S8 (2026-09-26) — the quote-aware pattern_line matcher, exported for direct unit testing
  patternLineFires,
  // WP-S9 (2026-09-26) — the trigger-vs-quote-mask check and its per-gate table, exported for direct unit
  // testing (see both functions' own doc comments above for the "why").
  triggerClearsQuotes, DANGER_TRIGGER, onlyQuotedAssignmentAtRest, segmentTriggerClears, leadsWithInertSearchTool,
  // N02 (codex-recheck 2026-09-24, third pass) — the -c argument's genuine two-layer escape read (re-exported
  // from forge-actiongate-position.cjs, see hasLiveCArg above); COMMAND_EXTRA_FIRE exported so a caller/test
  // can see exactly which gate ids have an extra JS predicate beyond their JSON regex.
  hasLiveCArg, COMMAND_EXTRA_FIRE,
  // the whole except valve, exported so the INVARIANT test can assert the valve itself and not merely the
  // gate's verdict: excusedSegments() IS the allow-list, isExcusedSegment() IS the membership test.
  excusedSegments, isExcusedSegment,
  // the segment-boundary layer the valve leans on (a segment must be whole before equality means anything)
  splitCommandsDetailed, isIntactSegment, AMPUTATING_SEPARATORS,
  // V06 command-position widening (codex-recheck 2026-09-24, wave 1+2; lives in forge-actiongate-position.cjs)
  // — exported for direct unit testing
  stripCommandOpeners, commandPositionCandidates, laterBranchStarts, COMMAND_OPENER_STEPS,
  KNOWN_GATES, CONFIG_PATH, EXCEPT_KINDS,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, path: null, root: null, json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--path') opts.path = rest[++i];
    else if (a === '--root') opts.root = rest[++i];
    else if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-actiongate.cjs classify "<text>" [--path <p>] [--root <projectRoot>] [--json]');
  console.error('       node forge-actiongate.cjs list [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'classify') {
      const text = opts.positional[0] || '';
      const result = classify({ text, path: opts.path, project_root: opts.root }, {});
      if (opts.json) console.log(JSON.stringify(result));
      else if (result.gate) console.log('GATE [' + result.class + '] ' + result.id + ' — ' + result.reason + (result.matched.length > 1 ? ' (also matched: ' + result.matched.slice(1).join(', ') + ')' : ''));
      else console.log('no gate triggered');
      process.exitCode = result.gate ? 3 : 0;
    } else if (opts.cmd === 'list') {
      const gates = listGates({});
      if (opts.json) console.log(JSON.stringify(gates));
      else for (const g of gates) console.log(g.id + '\t[' + g.class + ']\t' + g.reason);
      process.exitCode = 0;
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-actiongate: ' + e.message);
    process.exitCode = 2;
  }
}
