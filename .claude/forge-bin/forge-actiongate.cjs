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

/** splitCommandsDetailed(text) -> [{segment, raw, sepBefore, sepAfter, gluedAfter, hasFollowing, intact}]
 *  The split WITH the evidence the except valve needs to know whether it is looking at a whole command or
 *  at a stump. `splitCommands()` is this function's `segment` column and is unchanged in behaviour.
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
  while ((m = re.exec(s)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; } // defensive: never spin on a zero-width match
    const raw = s.slice(last, m.index);
    entries.push({
      raw,
      segment: raw.trim(),
      sepBefore: prevSep,
      sepAfter: m[0],
      gluedAfter: raw.length > 0 && !/\s$/.test(raw),
      hasFollowing: /\S/.test(s.slice(m.index + m[0].length)),
    });
    prevSep = m[0];
    last = m.index + m[0].length;
  }
  const tail = s.slice(last);
  entries.push({ raw: tail, segment: tail.trim(), sepBefore: prevSep, sepAfter: null, gluedAfter: false, hasFollowing: false });

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

/** testCommandGate(gate, text) -> boolean — true when gate.match.pattern_line matches the WHOLE text, or
 *  when ANY single command segment of `text` matches gate.match.pattern and is NOT excused by
 *  gate.match.except (see the COMMAND gate note in the header).
 *  The except valve is consulted ONLY for a segment the splitter marked `intact`. An amputated segment —
 *  one the split cut mid-argument — is judged on its pattern match alone, because the string it appears to
 *  be is not the command that will run. That guard is what stops `rm -rf node_modules$(echo /../.claude)`
 *  from being excused on the strength of its stump, and it is the ONLY thing besides exact equality that
 *  the valve depends on. */
function testCommandGate(gate, text) {
  if (!text) return false;
  const m = gate.match;
  if (m.kind !== 'command') return false;
  const flags = m.flags || 'i';
  if (m.pattern_line && new RegExp(m.pattern_line, flags).test(String(text))) return true;
  if (!m.pattern) return false;
  const re = new RegExp(m.pattern, flags);
  for (const entry of splitCommandsDetailed(text)) {
    if (!commandPositionCandidates(entry).some((c) => re.test(c))) continue;
    if (entry.intact && isExcusedSegment(m, entry.segment)) continue;
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
 *  because it happened to be byte-identical to one of the 16 excused literals. Pure, never throws. */
function testCommandGateRaw(gate, text) {
  if (!text) return false;
  const m = gate.match;
  if (m.kind !== 'command') return false;
  const flags = m.flags || 'i';
  if (m.pattern_line && new RegExp(m.pattern_line, flags).test(String(text))) return true;
  if (!m.pattern) return false;
  const re = new RegExp(m.pattern, flags);
  for (const entry of splitCommandsDetailed(text)) {
    if (commandPositionCandidates(entry).some((c) => re.test(c))) return true;
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
