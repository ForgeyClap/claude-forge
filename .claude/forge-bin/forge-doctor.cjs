#!/usr/bin/env node
'use strict';
/**
 * forge-doctor.cjs — Forge self-test + leak scan (Mission Control Phase 2, WP7). Zero-dependency,
 * Windows-safe. Answers the owner's "test everything / does it execute / find leaks" ask in one command.
 *
 * Checks (all REAL, no fabrication):
 *   1. node --check on every .cjs/.js under forge-bin/ + forge-dashboard/ (does it parse?).
 *   2. runs every forge-bin/*.test.cjs and tallies passed/failed (does it execute + pass?).
 *   3. strict-event self-check: feeds log-event.cjs a KNOWN type (expect exit 0) and an UNKNOWN type
 *      (expect exit 2) in a throwaway run, then deletes it — proves the honesty gate still rejects junk.
 *   4. dashboard SPA integrity: the render files exist (server.cjs, index.html, app.js, lenses.js,
 *      graph.js, panels.js, styles.css).
 *   5. secret/leak scan of git-tracked files (git ls-files) using forge-store's HARDENED SECRET_PATTERNS —
 *      reports only {file, pattern}, NEVER the matched secret text. .env.example + binaries skipped.
 *
 * (Later WP additions, not yet reflected above: agentsCheck, chainCheck, rebindingGuard — all part of the
 * real 8-key `checks` object `runDoctor()` ANDs together for its `ok` verdict.)
 *
 * Plus one ADVISORY-ONLY check, reported separately and NEVER folded into the `ok` verdict above:
 *   backfill_continuity — dispatch_id consistency for Bash-less Bosses' backfilled events (see its own
 *     doc comment above `backfillContinuity()`). Surfaced as top-level `report.advisory.backfill_continuity`
 *     (`{ok, checkedRuns, applicableRuns, warnings[]}`), printed as a WARN line, never a FAIL.
 *
 * Writes a machine-readable report to <run>/doctor.json (when --run) and prints a green/red summary.
 *
 * CLI:
 *   node forge-doctor.cjs [--root <dir>] [--run <run_id>] [--json]
 *     --root  project root (default: two levels up from forge-bin, i.e. this project)
 *     --run   also write <root>/.claude/forge-runs/<run_id>/doctor.json and log a doctor_run event
 *     --json  print the full report JSON to stdout
 *   Exit code: 0 if everything passes, 1 if any check fails (so CI/hooks can gate on it). The advisory
 *   field never affects this exit code.
 *
 * Module API: { nodeCheckAll, runTests, strictEventCheck, spaPresent, leakScan, agentsCheck, chainCheck,
 *   rebindingGuard, backfillContinuity, runDoctor, secretLabel }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const store = require('./forge-store.cjs');
// forge-policy.cjs is a SOFT sibling dependency (unlike forge-store.cjs, which agentsCheck/leakScan have
// always required): some hermetic fixtures (e.g. forge-sync.test.cjs's "copy the REAL forge-doctor.cjs"
// integration case) intentionally copy only forge-doctor.cjs + forge-store.cjs to exercise the genuine
// node_check/tests path, without forge-policy.cjs alongside it. A missing forge-policy.cjs must degrade
// the tool-policy sub-check honestly (ok:false, explicit reason) rather than crash the entire doctor run.
let policy = null;
try { policy = require('./forge-policy.cjs'); } catch { policy = null; }

const NODE = process.execPath;
const DASH_SPA = ['server.cjs', 'index.html', 'app.js', 'lenses.js', 'graph.js', 'panels.js', 'styles.css'];

function claudeDir(root) { return path.join(root, '.claude'); }
function listByExt(dir, exts) {
  let out = []; let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) { if (e.isFile() && exts.includes(path.extname(e.name))) out.push(path.join(dir, e.name)); }
  return out.sort();
}

// 1) node --check on all dashboard/bin sources
// Honesty fix (2026-07-14): 0 files checked is NEVER a silent pass. Distinguish "the dirs are genuinely
// both absent" (still a real problem for a project that's supposed to have forge-bin/) from "a dir exists
// but yielded nothing" — both are `ok:false` with an explicit `reason`, never a vacuous green.
function nodeCheckAll(root) {
  const cd = claudeDir(root);
  const binDir = path.join(cd, 'forge-bin');
  const dashDir = path.join(cd, 'forge-dashboard');
  const files = [
    ...listByExt(binDir, ['.cjs']),
    ...listByExt(dashDir, ['.cjs', '.js']),
  ];
  const failures = [];
  for (const f of files) {
    const r = spawnSync(NODE, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) failures.push({ file: path.relative(root, f), error: (r.stderr || '').split('\n')[0] });
  }
  let ok = failures.length === 0;
  let reason = '';
  if (files.length === 0) {
    ok = false; // no evidence is not a pass, regardless of why
    reason = (!fs.existsSync(binDir) && !fs.existsSync(dashDir))
      ? 'no evidence: forge-bin/ and forge-dashboard/ are both missing'
      : 'no evidence: 0 files checked (dir present but empty or unreadable)';
  }
  return { total: files.length, failed: failures.length, ok, failures, reason };
}

// 2) run every *.test.cjs and tally
// Honesty fixes (2026-07-14): (a) a suite must report at least one REAL passing assertion (p > 0) to count
// as ok — "0 passed, 0 failed" is a vacuous/short-circuited suite, not proof; (b) 0 suites found is never a
// silent pass — same "no evidence" treatment as nodeCheckAll; (c) a suite that hits the spawn timeout is
// labeled `timedOut:true` / `blocked`, never lumped in with a real failure.
function runTests(root, opts) {
  // timeoutMs is test-only-overridable (default 120000ms, unchanged for the real CLI/runDoctor path) so a
  // hermetic test can prove the timedOut/blocked classification against a REAL spawnSync timeout in
  // milliseconds instead of waiting two real minutes or faking the spawnSync return shape.
  const timeoutMs = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs : 120000;
  const dir = path.join(claudeDir(root), 'forge-bin');
  const dirExists = fs.existsSync(dir);
  const tests = listByExt(dir, ['.cjs']).filter((f) => f.endsWith('.test.cjs'));
  const perSuite = []; let passed = 0, failed = 0, suitesFailed = 0, suitesBlocked = 0;
  for (const t of tests) {
    const r = spawnSync(NODE, [t], { encoding: 'utf8', timeout: timeoutMs });
    // spawnSync sets status:null + a kill signal (verified: SIGTERM on Windows, r.error may also carry an
    // ETIMEDOUT message) when the timeout fires; treat any status:null+signal combo as "blocked", not
    // "failed" — it never actually finished running.
    const timedOut = r.status === null && !!r.signal;
    const out = ((r.stdout || '') + (r.stderr || ''));
    // Robust tally extraction (FOLLOWUP A, 2026-07-14): the previous /(\d+)\s+passed,\s+(\d+)\s+failed/ had
    // no anchor and no /g flag, so it matched the FIRST occurrence anywhere in combined stdout+stderr —
    // including a phrase inside a test DESCRIPTION that a suite's own harness happens to echo (e.g.
    // "  ok  reports 0 passed, 0 failed when empty"), long before the suite's real trailing tally line. This
    // already caused one real false-negative (forge-chaos.test.cjs briefly read as 0/0 — fixed there by
    // renaming the colliding description, but the underlying regex class bug remained). Fix: only accept a
    // match where the digits are the FIRST thing on their line (anchor `^\s*` with the `m` flag) — a genuine
    // tally is always printed at the very start of its own line (see this file's own final
    // `console.log(pass + ' passed, ' + fail + ' failed')`), so a description embedded mid-line — prefixed by
    // "  ok  " / "  FAIL " or any other text before the digits — can never satisfy the anchor. Deliberately
    // NOT anchored at the line's END too: a real sibling suite (forge-learn.test.cjs) legitimately prints
    // "N passed, M failed, K skipped" — extra trailing content on the same summary line is normal and must
    // still be read correctly (`\b` after "failed" instead of `$` — proven by re-running this exact fix
    // against the real project's full suite battery, not just a hand-written fixture). Take the LAST such
    // anchored match (not the first) as belt-and-suspenders, since the genuine summary is always the final
    // thing a suite prints.
    const TALLY_RE = /^\s*(\d+)\s+passed,\s+(\d+)\s+failed\b/gm;
    let m = null, tm;
    while ((tm = TALLY_RE.exec(out)) !== null) m = tm;
    const p = m ? Number(m[1]) : 0, f = m ? Number(m[2]) : 0;
    const suiteOk = !timedOut && r.status === 0 && f === 0 && !!m && p > 0;
    if (timedOut) suitesBlocked++;
    else if (!suiteOk) suitesFailed++;
    passed += p; failed += f;
    const entry = { suite: path.basename(t), passed: p, failed: f, ok: suiteOk, timedOut };
    if (timedOut && r.signal) entry.signal = r.signal;
    perSuite.push(entry);
  }
  let ok = suitesFailed === 0 && suitesBlocked === 0;
  let reason = '';
  if (tests.length === 0) {
    ok = false; // no evidence is not a pass
    reason = dirExists ? 'no evidence: 0 test suites found in forge-bin/ (dir present but empty)' : 'no evidence: forge-bin/ dir missing';
  }
  return { suites: tests.length, suitesFailed, suitesBlocked, passed, failed, ok, perSuite, reason };
}

// 3) strict-event honesty gate still rejects unknown types
function strictEventCheck(root) {
  const logEvent = path.join(claudeDir(root), 'forge-dashboard', 'log-event.cjs');
  const runsDir = path.join(claudeDir(root), 'forge-runs');
  const rid = 'doctor-selfcheck-' + process.pid;
  const good = spawnSync(NODE, [logEvent, rid, 'agent_progress', '{"agent":"orchestrator","note":"doctor self-check"}'], { encoding: 'utf8' });
  const bad = spawnSync(NODE, [logEvent, rid, 'zzz_bogus_type', '{"agent":"orchestrator"}'], { encoding: 'utf8' });
  try { fs.rmSync(path.join(runsDir, rid), { recursive: true, force: true }); } catch { /* best effort cleanup */ }
  const ok = good.status === 0 && bad.status === 2;
  return { ok, known_accepted: good.status === 0, unknown_rejected: bad.status === 2, good_status: good.status, bad_status: bad.status };
}

// 4) dashboard SPA files present
function spaPresent(root) {
  const dir = path.join(claudeDir(root), 'forge-dashboard');
  const missing = DASH_SPA.filter((f) => !fs.existsSync(path.join(dir, f)));
  return { ok: missing.length === 0, missing };
}

// friendly label for a hardened SECRET_PATTERN (source-based, no parallel list to drift)
function secretLabel(src) {
  if (src.includes('nvapi')) return 'nvidia-nvapi-key';
  if (src.includes('sk_')) return 'stripe-key';
  if (src.includes('sk-')) return 'openai-style-key';
  if (src.includes('rk_')) return 'stripe-restricted-key';
  if (src.includes('gh[')) return 'github-token';
  if (src.includes('xox')) return 'slack-token';
  if (src.includes('AKIA')) return 'aws-access-key';
  if (src.includes('AIza')) return 'google-api-key';
  if (src.includes('SG')) return 'sendgrid-key';
  if (src.includes('PRIVATE KEY')) return 'pem-private-key';
  if (src.includes('eyJ')) return 'jwt';
  if (src.includes('/') && src.includes('@')) return 'url-embedded-credentials'; // source has escaped slashes (:\/\/)
  return 'secret-pattern';
}

// 5) leak scan of git-tracked files (falls back to a bounded working-tree walk if git is unavailable)
function trackedFiles(root) {
  const r = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' });
  if (r.status === 0 && typeof r.stdout === 'string') {
    return { source: 'git', files: r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
  }
  // fallback: bounded walk, skip the usual heavy/secret-bearing dirs (git absent). forge-runs + forge-backups
  // are Forge's OWN operational artifacts (run logs; backups of Forge's own system files, which include test
  // fixtures) — never the project source we scan for leaked credentials.
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'forge-runs', 'forge-backups', '.cache']);
  const out = [];
  (function walk(dir, depth) {
    if (depth > 6) return; let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), depth + 1); continue; }
      if (e.isFile()) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  })(root, 0);
  return { source: 'walk', files: out };
}
// A matched string only counts as a REAL leak if it isn't a placeholder, a short label, or a repeated-
// filler test fixture. (Redaction patterns are intentionally aggressive; leak DETECTION must be precise so
// it doesn't cry wolf on the security tooling + test fixtures. The match text is used only transiently for
// this decision — it is NEVER stored or printed.)
// Explicit "this is not a real credential" intent markers — a human deliberately wrote one of these into a
// placeholder / fixture value. Present in the SECRET portion of a match -> exempt. (5th fix round, break-swarm
// #6: XXXX was moved OUT of this STRONG set into the WEAK signals in looksLikeRealSecret — 4 literal X's occur
// INCIDENTALLY inside real high-entropy tokens, e.g. ghp_aB3xxxxKz9..., so on their own they must never
// exempt a genuine, store-redactable secret.)
const STRONG_PLACEHOLDER_RE = /FAKE|EXAMPLE|PLACEHOLDER|REDACTED|SAMPLE|DUMMY|CHANGE[_-]?ME|YOUR[_-]?|SECRETSECRET/i;
// Fix (2026-07-15, SYSTEM-BREAKING + HIGH, 2nd fix round): the previous "REGEX_SOURCE_RE" character-shape
// heuristic (`/\\|\{\d+,?\d*\}|\[[^\]\r\n]{1,200}\]/`, added in the FIRST fix round) was ITSELF fundamentally
// broken — it tried to distinguish a regex SOURCE from a secret VALUE by looking at loose characters
// (backslash / `{n,m}` / `[...]`), but a genuine secret can legitimately contain every one of those:
//   - a PEM private key inlined in JSON (`JSON.stringify({private_key: '...BEGIN...\n'+body+'\n...END...'})`,
//     the exact shape of a committed GCP service-account key) has LITERAL two-character `\n` escape
//     sequences in the file — the backslash alone tripped REGEX_SOURCE_RE and the WHOLE PEM match was waved
//     through as "just a regex source", even though `store.redactValue` on the same content redacts it fine.
//   - a connection-string password containing `[`, `]`, `\`, or a `{n,m}`-shaped substring (e.g.
//     `postgres://user:EXAMPLE-My[Secret]Pass99xx@host/db` — the PASSWORD is deliberately marked EXAMPLE so
//     this very comment doesn't itself trip this file's own leak_scan) tripped the same false exemption.
// There is no reliable CHARACTER-based signal here; the only reliable signal is CONTEXT: is this exact text
// sitting literally between `/` delimiters (or inside a `new RegExp('...')` call) on its own source line —
// i.e. it IS a pattern DEFINITION (like store.SECRET_PATTERNS itself, or an AGENT_INJECTION_PATTERNS entry),
// not a secret VALUE — see isPatternDefinitionContext() below, which replaces REGEX_SOURCE_RE entirely.
// looksLikeRealSecret() is now a PURE content check only (length / placeholder / repeated-filler); it no
// longer makes any regex-source judgement — that job belongs solely to isPatternDefinitionContext(), which
// needs the surrounding source text + match position to decide honestly instead of guessing from characters
// the match happens to contain.
// secretPortion — for a url-embedded-credentials match (scheme://user:YOUR_PASSWORD@) return only the password (the
// actual secret); for every other pattern the whole match IS the secret. 5th fix round (break-swarm #6,
// SYSTEM-BREAKING): the placeholder heuristic used to run against the WHOLE match, so a benign 'example'/
// 'sample' in the scheme or username (an "example_user" login with a REAL password on a staging DB — a
// ubiquitous shape) waved the REAL password through with a SILENT miss. Judging placeholders on the PASSWORD
// only fixes that while still exempting a genuine placeholder password like YOUR_PASSWORD.
function secretPortion(match) {
  if (/^[a-z][a-z0-9+.\-]*:\/\/[^\s:/@]+:[^\s:/@]+@$/i.test(match)) {
    const noAt = match.slice(0, -1);                 // drop trailing '@'
    return noAt.slice(noAt.lastIndexOf(':') + 1);    // password after the last ':' (scheme/user colons are earlier)
  }
  return match;
}
function looksLikeRealSecret(match) {
  if (typeof match !== 'string' || match.length < 16) return false;  // real keys are long; short = a label like "nvapi-key"
  const secret = secretPortion(match);
  if (STRONG_PLACEHOLDER_RE.test(secret)) return false;              // explicit placeholder / fixture intent in the secret itself
  // WEAK signals — an XXXX run or a repeated-filler run (7+ same char). A REAL high-entropy secret can contain
  // such a substring INCIDENTALLY (ghp_...xxxx..., a base64 all-zero run -> AAAAAAA), so these exempt ONLY when
  // they DOMINATE the secret (cover >= half of it, i.e. it is really a filler/placeholder token, not a key that
  // merely happens to contain the substring). break-swarm #6 proved the old whole-match test silently dropped
  // real secrets on both triggers.
  const residue = secret.replace(/X{4,}/gi, '').replace(/(.)\1{6,}/g, '');
  if (secret.length > 0 && (secret.length - residue.length) >= secret.length / 2) return false; // dominated -> fixture/placeholder
  return true;
}
// Fix (2026-07-15, SYSTEM-BREAKING, 3rd fix round): round 2's isPatternDefinitionContext() was context-based
// (not character-based) instead of round 1's broken character-shape guess — an improvement, but it was ITSELF
// still too broad: it judged purely from the TEXT SURROUNDING the match (an unescaped `/` immediately before
// + `/[flags]` immediately after), with no idea whether the scanned FILE is even JavaScript, or whether that
// trailing `/` is a real regex-literal close versus an ordinary trailing-slash URL/path. Two system-breaking
// misses, both proven by an adversarial break-swarm against the REAL tool:
//   1. A real secret in a NON-JS data file (.md/.yaml/.json/.env/.txt) merely WRAPPED in `/.../ ` character-
//      shape (e.g. `notes.md` containing "Deploy key: /nvapi-<realkey>/g and more") reads exactly like a regex
//      literal in raw text, even though the file has no JS regex syntax at all — store.redactValue redacts it,
//      leakScan missed it.
//   2. A real secret sitting in a URL/path that happens to END in "/" (e.g.
//      "https://api.github.com/repos/x/ghp_<realtoken>/") — the trailing slash satisfies the same
//      "regex-literal-close" text shape, so it was waved through too.
// There is no reliable way to tell a genuine JS regex literal apart from these shapes using text alone — `/`
// is division, a regex start, AND a path separator, and context alone can't disambiguate without knowing what
// kind of file it's even looking at. The root fix: shrink the exemption surface to the only place a REAL
// pattern definition can legitimately exist — the two source files that literally DEFINE
// store.SECRET_PATTERNS / doctor's own AGENT_INJECTION_PATTERNS (forge-store.cjs, forge-doctor.cjs;
// PATTERN_DEFINITION_PATHS below). Every other tracked file (.md/.yaml/.json/.env/.txt, any other .js/.cjs,
// agent-memory, docs, etc.) gets NO `/.../ ` exemption anymore — only the PLACEHOLDER_RE marker exempts there.
// isPatternDefinitionContext() itself is UNCHANGED (still the best-available regex-literal-shape heuristic);
// what changed is that leakScan() below now only ever CALLS it for a whitelisted FULL PATH, never globally.
// 4th fix round (2026-07-15, break-swarm #4): key on the exact repo-relative PATH, not path.basename(rel).
// Basename-matching WIDENED the exemption to any file merely NAMED forge-store.cjs / forge-doctor.cjs in ANY
// subdirectory (docs/forge-store.cjs, sub/forge-doctor.cjs, an other-project copy path), silently exempting a
// real store-redactable secret disguised as a `/pattern/flags` literal there. The two files that legitimately
// DEFINE these patterns only ever live at exactly these two repo-relative paths — here and in every synced
// project (the template copies them to the same location) — so the exemption is gated on the exact path.
const PATTERN_DEFINITION_PATHS = new Set(['.claude/forge-bin/forge-store.cjs', '.claude/forge-bin/forge-doctor.cjs']);
// isPatternDefinitionContext — CONTEXT-based (not character-based) check: does this match sit literally
// inside a JS `/pattern/flags` regex literal, or inside the quoted first argument of a `new RegExp('...')`/
// `RegExp("...")` call, on its OWN source line in the scanned file? That is a genuine pattern DEFINITION
// (store.SECRET_PATTERNS, AGENT_INJECTION_PATTERNS, etc.), never a secret VALUE sitting in JSON/env/config
// content. Fail-closed by design (per the owner's explicit instruction): a match that spans more than one
// physical line can NEVER be a real JS regex literal (they cannot contain a literal newline), so it is
// immediately rejected here rather than risk exempting a real multi-line PEM secret. Anything this function
// cannot POSITIVELY confirm as `/…/` or `RegExp(...)` syntax is NOT exempted — ambiguous text (including a
// pattern merely quoted in prose/documentation, with no surrounding regex syntax) counts as a real leak,
// which is the safer failure mode than silently waving through an actual credential. CALLER-GATED (2026-07-15,
// 3rd/4th fix round): leakScan() below only invokes this function at all when the scanned file's exact
// repo-relative path is in PATTERN_DEFINITION_PATHS — this function no longer decides exemption scope by
// itself, only shape within an already-whitelisted file.
function isPatternDefinitionContext(text, idx, matchLen) {
  if (text.slice(idx, idx + matchLen).includes('\n')) return false; // spans lines -> can't be a JS literal
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
  let lineEnd = text.indexOf('\n', idx + matchLen);
  if (lineEnd === -1) lineEnd = text.length;
  const before = text.slice(lineStart, idx);
  const after = text.slice(idx + matchLen, lineEnd);
  // `/pattern/flags` regex literal: an UNESCAPED `/` immediately precedes the match, and an unescaped `/`
  // (+ optional valid regex flags, then a normal token boundary) immediately follows it on the same line.
  const slashBefore = before === '/' || /[^\\]\/$/.test(before);
  if (slashBefore && /^\/[gimsuy]*(?:[\s,;)\]]|$)/.test(after)) return true;
  // `new RegExp('pattern')` / `RegExp("pattern")` call: match sits inside the quoted first argument.
  if (/RegExp\s*\(\s*['"`]$/.test(before) && /^['"`]\s*[,)]/.test(after)) return true;
  return false;
}
// 4th fix round (2026-07-15, break-swarm #4): the old hard 512KB cap SILENTLY skipped any larger tracked
// file — a real committed credential in a >512KB file was never scanned, yet leak_scan still reported
// "clean / ALL GREEN" because nothing surfaced the skip. Two coupled fixes: (a) raise the scan ceiling to
// LEAK_SCAN_MAX_BYTES so every realistically-sized text file (source, config, lockfile, markdown) IS actually
// scanned — regex over a few MB of text is milliseconds; (b) make every remaining skip VISIBLE in the
// returned `skipped` array (and in printSummary), so the verdict can never again claim total coverage while
// silently dropping a file. `ok` stays hits-only on purpose: a too-large or binary file is a SURFACED
// coverage note, not a hard red — flipping the gate red on any large binary asset (an image, a dataset, a
// lockfile) would break every real project's sync gate, the exact kind of self-inflicted breakage this
// honesty loop exists to prevent. The honesty requirement is met by making the skip visible, not by lying
// about it and not by crying wolf on it.
const LEAK_SCAN_MAX_BYTES = 8 * 1024 * 1024;  // 8MB: scans every realistic text file; a larger file is surfaced in skipped, never silently dropped
const LEAK_SCAN_MAX_LINE = 16 * 1024;         // 16KB: a single line longer than this (minified bundle, data blob) is length-bounded out of regex scanning and surfaced — the structural ReDoS guard (see below)
// leakScan detection pattern list = store.SECRET_PATTERNS EXCEPT the one MULTI-LINE PEM BLOCK pattern
// (/-----BEGIN...[\s\S]{0,N}?...-----END/) is replaced by its single-line HEADER. Reasons: (a) a
// `-----BEGIN ... PRIVATE KEY-----` line is itself the leak signal — present even in a truncated key — so
// header detection is at least as sensitive; (b) the multi-line block's lazy [\s\S]{0,N}? re-scans up to N
// chars at EVERY `-----BEGIN` position, which an adversarial many-marker file turns into O(markers*N) and
// used to take seconds on a multi-MB file. The full BLOCK pattern stays in store.SECRET_PATTERNS for
// REDACTION (redactString must remove the whole key body); leakScan only needs to DETECT, and does so
// linearly. store keeps redaction correct; leakScan stays ReDoS-proof.
const PEM_HEADER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const LEAK_SCAN_PATTERNS = store.SECRET_PATTERNS.map((re) => (re.source.includes('[\\s\\S]') ? PEM_HEADER_RE : re));
// leakScan (4th fix round, structural): scans every tracked file PER LINE with a per-line length cap, so no
// SECRET_PATTERN can ever run on more than LEAK_SCAN_MAX_LINE characters at once — catastrophic backtracking
// (O(n^2) on a long char run, which once hung the whole doctor for ~160s) is impossible by construction,
// independent of how any individual pattern is written. Coverage is honest: file-level skips (too-large /
// binary) and any length-bounded long line are all surfaced in `skipped`, never silently dropped.
function leakScan(root) {
  const { source, files } = trackedFiles(root);
  const hits = []; const skipped = []; let scanned = 0;
  for (const rel of files) {
    if (rel.endsWith('.env.example')) continue;                       // placeholders expected
    if (/\.test\.[cm]?js$/i.test(rel)) continue;                      // test fixtures legitimately hold fake secrets
    // Forge's OWN operational artifacts are never the project source we scan for leaked credentials: a git-
    // tracked .claude/forge-backups/ holds backups of Forge's own system files (which contain deliberate test
    // fixtures like forge-chaos.cjs's fake keys) — scanning them is circular and false-positives; .claude/
    // forge-runs/ holds Forge's own event logs (run integrity is covered by chainCheck/certify, not here).
    if (/(^|\/)\.claude\/forge-(backups|runs)\//.test(rel.replace(/\\/g, '/'))) continue;
    const abs = path.join(root, rel);
    let buf;
    try {
      const st = fs.statSync(abs);
      if (st.size > LEAK_SCAN_MAX_BYTES) { skipped.push({ file: rel, bytes: st.size, reason: 'too-large' }); continue; }
      buf = fs.readFileSync(abs);
    } catch (e) {
      // 5th fix round (break-swarm #6): a tracked file that stat/read throws on (EACCES/EPERM permission,
      // ENOENT TOCTOU-deleted, EISDIR submodule/gitlink, EBUSY Windows lock, dangling symlink) must be
      // SURFACED, not silently swallowed — otherwise the verdict claims "clean" over a file it never scanned,
      // the exact silent-drop this round's whole design forbids. It is a coverage note, not a hard red.
      skipped.push({ file: rel, reason: 'unreadable', error: (e && e.code) ? e.code : 'read-error' });
      continue;
    }
    if (buf.includes(0)) { skipped.push({ file: rel, bytes: buf.length, reason: 'binary' }); continue; } // binary-ish
    const text = buf.toString('utf8');
    scanned++;
    // Fail-closed whitelist gate (3rd round, tightened to a FULL-PATH match in the 4th): the regex-literal-
    // context exemption is only ever eligible for the two files that actually DEFINE these patterns, at their
    // exact repo-relative path. Every other tracked file — regardless of extension OR basename, including an
    // ordinary .js/.cjs data file or a docs/forge-store.cjs decoy — gets no `/.../ ` exemption at all.
    const isPatternDefFile = PATTERN_DEFINITION_PATHS.has(rel.replace(/\\/g, '/'));
    const fired = new Set();                                          // one hit row per (file, pattern) — matches the old per-pattern semantics
    let longLines = 0;
    for (const line of text.split('\n')) {
      if (line.length > LEAK_SCAN_MAX_LINE) { longLines++; continue; } // don't regex a pathological long line
      for (const re of LEAK_SCAN_PATTERNS) {
        if (fired.has(re)) continue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {                        // transient only — never stored
          const exempt = isPatternDefFile && isPatternDefinitionContext(line, m.index, m[0].length);
          if (looksLikeRealSecret(m[0]) && !exempt) { hits.push({ file: rel, pattern: secretLabel(re.source) }); fired.add(re); break; }
          if (re.lastIndex === m.index) re.lastIndex++;               // guard against a zero-length match loop
        }
      }
    }
    if (longLines) skipped.push({ file: rel, reason: 'long-line', lines: longLines });
  }
  return { source, scanned, skipped, ok: hits.length === 0, hits };
}

// 6) agents check (2026-07-10) — the 12 Boss agent-files exist with valid frontmatter, AND no agent
// body carries an injection/supply-chain pattern (agent bodies become system prompts — same spirit as
// the leak scan: a `curl … | bash`, an inert context-manager plumbing block, etc. must never ship).
const BOSS_NAMES = ['boss', 'head-chef', 'review-boss', 'test-boss', 'ui-boss', 'seo-boss', 'security-boss', 'skill-boss', 'search-boss', 'build-boss', 'integration-boss', 'docs-boss'];
const AGENT_INJECTION_PATTERNS = [
  { name: 'curl-pipe-bash', re: /\bcurl\b[^\n]*\|\s*(ba)?sh\b/i },
  { name: 'wget-pipe-sh', re: /\bwget\b[^\n]*\|\s*(ba)?sh\b/i },
  { name: 'ignore-previous-instructions', re: /ignore\s+(all\s+)?previous\s+instructions/i },
  { name: 'context-manager-plumbing', re: /Communication Protocol|context-manager/i },
];
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^([A-Za-z_]+):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].trim(); }
  return fm;
}
// Splits a frontmatter `tools:` value ("Read, Write, Edit, Grep, Glob") into a clean array. Pure helper,
// tolerant of a missing/empty/non-string input (returns []) so a bad-frontmatter agent-md never crashes
// the tool-policy comparison below — it just shows up with an empty grant set (which will legitimately
// mismatch the policy and get flagged).
function parseToolsList(toolsStr) {
  if (typeof toolsStr !== 'string' || !toolsStr.trim()) return [];
  return toolsStr.split(',').map((s) => s.trim()).filter(Boolean);
}
function loadToolPolicy(root) {
  const file = path.join(claudeDir(root), 'config', 'agents', 'agent-tool-policy.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function agentsCheck(root) {
  const dir = path.join(claudeDir(root), 'agents');
  const missing = [], badFrontmatter = [], injection = [];
  for (const name of BOSS_NAMES) {
    const file = path.join(dir, name + '.md');
    let text; try { text = fs.readFileSync(file, 'utf8'); } catch { missing.push(name); continue; }
    const fm = parseFrontmatter(text);
    if (!fm || fm.name !== name || !fm.description || !fm.tools || !fm.model || !fm.memory) badFrontmatter.push(name);
  }
  // injection-lint EVERY agent file present (Bosses + specialists + codex-reviewer), and collect each
  // one's REAL granted tools (keyed by filename, not the frontmatter's own `name:` field, so a bad/mismatched
  // frontmatter still gets compared against the policy rather than silently skipped).
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { files = []; }
  const grants = {};
  for (const f of files) {
    let text; try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const p of AGENT_INJECTION_PATTERNS) { if (p.re.test(text)) injection.push({ file: 'agents/' + f, pattern: p.name }); }
    const base = f.replace(/\.md$/, '');
    const fm = parseFrontmatter(text);
    grants[base] = parseToolsList(fm && fm.tools);
  }
  // WP2 (2026-07-14) — mechanical least-privilege enforcement: compare every agent-md's ACTUAL frontmatter
  // tools against the pinned .claude/config/agents/agent-tool-policy.json source of truth. A missing/
  // unparseable policy file is itself a failure (never a silent pass — same "no evidence" discipline as
  // the other checks in this file), not just a skipped sub-check.
  const toolPolicyFile = loadToolPolicy(root);
  let toolPolicy;
  if (!policy) {
    toolPolicy = { ok: false, reason: 'forge-policy.cjs module not available (toolPolicyCheck unavailable)', missingPolicy: [], missingAgentFile: [], classViolations: [], driftViolations: [] };
  } else if (!toolPolicyFile) {
    toolPolicy = { ok: false, reason: 'agent-tool-policy.json missing or unparseable at .claude/config/agents/agent-tool-policy.json', missingPolicy: [], missingAgentFile: [], classViolations: [], driftViolations: [] };
  } else {
    toolPolicy = policy.toolPolicyCheck(toolPolicyFile, grants);
  }
  return {
    ok: missing.length === 0 && badFrontmatter.length === 0 && injection.length === 0 && toolPolicy.ok === true,
    expected: BOSS_NAMES.length,
    found: files.length,
    missing,
    badFrontmatter,
    injection,
    toolPolicy,
  };
}

// Tamper-evident chain check (2026-07-11): walk each run's events.jsonl hash-chain (log-event.cjs writes
// entry_hash = sha256(canonical(event)+prev_hash)). LEGACY runs with no entry_hash anywhere are skipped
// (not broken). A chained run is BROKEN if an event's self-hash mismatches (edited) or its prev_hash links
// nowhere (truncation/removal). Tolerant of concurrent forks: prev_hash may reference ANY prior entry_hash.
//
// Fix (2026-07-15, HIGH bug): a MIXED run — a legacy prefix with no entry_hash, followed later by REAL
// chained events once log-event.cjs's hash chain was adopted mid-run — used to be misclassified. The old
// gate (`evs.some(e=>e.entry_hash)`) only decided "skip or not"; once ANY event had a hash, validation
// walked the WHOLE array from index 0, so the legacy prefix's hash-less events were reported as "missing
// hash fields" — indistinguishable from a genuine tamper (cry-wolf). Fix: find the FIRST index that
// carries an entry_hash and validate ONLY from there onward (mirrored in forge-certify.cjs's verifyChain
// and in log-event.cjs's own prev_hash lookup, which now searches backward for the nearest prior chained
// event instead of assuming the file's last line is always it). Earlier legacy events are skipped, not
// counted as broken; a genuine tamper anywhere in the chained section is still caught exactly as before.
//
// Fix (2026-07-15, MEDIUM bug): a single blank/whitespace-only line inside events.jsonl (JSON.parse('')
// throws) used to make the ENTIRE run "unparseable" here, while forge-certify's readEventsJsonl already
// tolerated it — two honesty gates disagreeing on identical bytes. Blank lines are now skipped the same
// way certify does; a genuinely malformed NON-blank line still fails this check exactly as before.
//
// Fix (2026-07-15, HIGH bug, 2nd fix round): a line that IS valid JSON but NOT a plain object (a bare
// number, array, string, `null`, or boolean — e.g. `123`, `[1,2,3]`, `"x"`) used to be accepted here via
// `out.push(JSON.parse(s))` with no type check at all, silently treated as a real "event". forge-certify's
// readEventsJsonl has ALWAYS counted exactly this shape as malformed (`if (v && typeof v==='object' &&
// !Array.isArray(v)) events.push(v); else malformed++`), so the two honesty gates gave OPPOSITE verdicts on
// identical bytes: doctor's chainCheck (via the old findIndex-for-first-entry_hash logic) would just skip
// past the non-object "event" (it has no `.entry_hash` property) and validate the real chained events that
// follow as ok:true, while certify counted the same line as malformed and returned NOT CERTIFIED. Fix:
// mirror certify's exact condition — a valid-JSON-but-non-plain-object line now THROWS here too, so the
// caller (chainCheck) reports the whole run as unparseable, exactly matching certify's malformed-line
// verdict on the same bytes. A genuine blank line remains benign/skipped (unchanged).
function chainCanon(ev) { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = ev[x]; return JSON.stringify(o); }
function parseEventsJsonlLenient(raw) {
  // Skips blank/whitespace-only lines (never malformed); a genuinely malformed non-blank line — including a
  // syntactically-valid-JSON line that is NOT a plain object — throws so the caller can report the whole
  // run as unparseable — same all-or-nothing behavior as before this fix, just no longer confused by a
  // benign blank line, and no longer accepting a non-object primitive as a fake "event".
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const v = JSON.parse(s);
    if (!(v && typeof v === 'object' && !Array.isArray(v))) {
      throw new Error('events.jsonl line is valid JSON but not a plain object (mirrors forge-certify.cjs readEventsJsonl): ' + s.slice(0, 80));
    }
    out.push(v);
  }
  return out;
}
function chainCheck(root) {
  const runsDir = path.join(claudeDir(root), 'forge-runs');
  let runIds = [];
  try { runIds = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return { ok: true, checked: 0, chained: 0, broken: [], note: 'no forge-runs' }; }
  let chained = 0; const broken = [];
  for (const id of runIds) {
    let raw; try { raw = fs.readFileSync(path.join(runsDir, id, 'events.jsonl'), 'utf8'); } catch { continue; }
    if (!raw || !raw.trim()) continue;
    let evs; try { evs = parseEventsJsonlLenient(raw); } catch { broken.push({ run: id, reason: 'unparseable events.jsonl' }); continue; }
    const startIdx = evs.findIndex((e) => e && e.entry_hash);
    if (startIdx === -1) continue; // legacy / fully unchained run — skip, not broken
    chained++;
    const seen = new Set(['genesis:' + id]); let ok = true, reason = '';
    for (let i = startIdx; i < evs.length; i++) {
      const e = evs[i];
      if (!e.entry_hash || !e.prev_hash) { ok = false; reason = 'event ' + i + ' missing hash fields'; break; }
      if (crypto.createHash('sha256').update(chainCanon(e) + e.prev_hash).digest('hex') !== e.entry_hash) { ok = false; reason = 'event ' + i + ' self-hash mismatch (edited?)'; break; }
      if (!seen.has(e.prev_hash)) { ok = false; reason = 'event ' + i + ' prev_hash links nowhere (truncation/removal?)'; break; }
      seen.add(e.entry_hash);
    }
    if (!ok) broken.push({ run: id, reason });
  }
  return { ok: broken.length === 0, checked: runIds.length, chained, broken };
}

// Security self-test (2026-07-11): the dashboard's DNS-rebinding + cross-site guard must stay wired in.
function rebindingGuard(root) {
  const f = path.join(claudeDir(root), 'forge-dashboard', 'server.cjs');
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch { return { ok: false, reason: 'server.cjs missing' }; }
  const hasFns = /function hostOk\(/.test(text) && /function crossSiteOk\(/.test(text);
  const wired = /if \(!hostOk\(req\)\)/.test(text) && /crossSiteOk\(req\)/.test(text);
  return { ok: hasFns && wired, reason: (hasFns && wired) ? '' : (!hasFns ? 'guard functions missing' : 'guard not wired into handler()') };
}

// dispatch_id backfill continuity — ADVISORY ONLY (FOLLOWUP A, 2026-07-14). Read-only-audit/write-no-exec
// Bosses (agent-tool-policy.json classes forbidding Bash: review-boss, security-boss, search-boss, seo-boss,
// boss, head-chef, docs-boss, skill-boss) have no shell access and therefore cannot self-log their own
// subagent_started/subagent_completed events — the Lead backfills BOTH events for them, using the SAME
// dispatch_id (the Agent-tool's own tool_use id) each time. This check flags when that backfill was done
// inconsistently (a started event carries a dispatch_id but the matching completed event carries none or a
// different one). It is intentionally:
//   • ADVISORY, never blocking — its `ok` is reported in a separate top-level `advisory` field and is NEVER
//     folded into runDoctor()'s `checks`-based ok-AND (see runDoctor below). A stale/inconsistent backfill on
//     an old run must never fail the doctor, block a sync, or turn an unrelated run's report red.
//   • PROSPECTIVE / tolerant of history — most existing runs in forge-runs/ predate this convention entirely
//     and carry no dispatch_id anywhere. A run with ZERO dispatch_id usage anywhere is treated as "not
//     applicable" (silently skipped, not a violation); only a run that DOES use dispatch_ids somewhere but
//     drops/changes one for a Bash-less Boss's completion earns a warning.
// Mirrors both the slug form (agent-tool-policy.json / agent-registry.json keys, e.g. "review-boss") and the
// canonical DISPLAY form (e.g. "Review Boss") a real events.jsonl actually holds, since log-event.cjs
// canonicalizes every `agent` field to the registry's display name before writing.
const NO_BASH_BOSS_SLUGS = ['review-boss', 'security-boss', 'search-boss', 'seo-boss', 'boss', 'head-chef', 'docs-boss', 'skill-boss'];
const NO_BASH_BOSS_DISPLAY = ['Review Boss', 'Security Boss', 'Search Boss', 'SEO Boss', 'Boss', 'Head Chef', 'Docs Boss', 'Skill Boss'];
const NO_BASH_BOSS_NAMES = new Set([...NO_BASH_BOSS_SLUGS, ...NO_BASH_BOSS_DISPLAY].map((s) => s.toLowerCase()));
function backfillContinuity(root) {
  const runsDir = path.join(claudeDir(root), 'forge-runs');
  let runIds = [];
  try { runIds = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return { ok: true, checkedRuns: 0, applicableRuns: 0, warnings: [] }; }
  const warnings = [];
  let applicableRuns = 0;
  for (const id of runIds) {
    let raw; try { raw = fs.readFileSync(path.join(runsDir, id, 'events.jsonl'), 'utf8').replace(/\n+$/, ''); } catch { continue; }
    if (!raw) continue;
    let evs; try { evs = raw.split('\n').map((l) => JSON.parse(l)); } catch { continue; } // unparseable -> chainCheck's concern, not this one
    if (!evs.some((e) => e && e.dispatch_id)) continue; // no dispatch_id anywhere in this run -> predates the convention, not applicable
    applicableRuns++;
    const pending = new Map(); // lowercased agent name -> queue of dispatch_ids from unmatched subagent_started events
    for (const e of evs) {
      if (!e || !e.event_type || !e.agent) continue;
      const name = String(e.agent).toLowerCase();
      if (!NO_BASH_BOSS_NAMES.has(name)) continue; // Bash-capable Bosses self-log and may legitimately omit dispatch_id
      if (e.event_type === 'subagent_started') {
        if (!pending.has(name)) pending.set(name, []);
        pending.get(name).push(e.dispatch_id || null);
      } else if (e.event_type === 'subagent_completed') {
        const q = pending.get(name);
        const startId = (q && q.length) ? q.shift() : undefined; // undefined = no matching start seen -> nothing to judge
        if (startId && e.dispatch_id !== startId) {
          warnings.push({ run: id, agent: e.agent, expected: startId, found: e.dispatch_id || null, reason: 'subagent_completed dispatch_id does not match its subagent_started dispatch_id (backfill likely missed)' });
        }
      }
    }
  }
  return { ok: warnings.length === 0, checkedRuns: runIds.length, applicableRuns, warnings };
}

function runDoctor(root) {
  root = path.resolve(root);
  const checks = {
    node_check: nodeCheckAll(root),
    tests: runTests(root),
    strict_events: strictEventCheck(root),
    dashboard_spa: spaPresent(root),
    leak_scan: leakScan(root),
    agents: agentsCheck(root),
    chain: chainCheck(root),
    rebinding_guard: rebindingGuard(root),
  };
  // advisory checks are DELIBERATELY excluded from this ok computation — see backfillContinuity's doc above.
  const ok = Object.values(checks).every((c) => c.ok);
  const advisory = { backfill_continuity: backfillContinuity(root) };
  return { ok, root, checks, advisory, generated_at: new Date().toISOString() };
}

function printSummary(rep) {
  const c = rep.checks;
  const line = (label, ok, detail) => (ok ? '  ✓ ' : '  ✗ ') + label.padEnd(16) + (detail || '');
  const out = [];
  out.push('Forge Doctor — ' + rep.root);
  out.push(line('node --check', c.node_check.ok, c.node_check.total + ' files' + (c.node_check.ok ? '' : ' · ' + (c.node_check.reason || (c.node_check.failed + ' FAILED')))));
  out.push(line('tests', c.tests.ok, c.tests.suites + ' suites · ' + c.tests.passed + ' passed / ' + c.tests.failed + ' failed'
    + (c.tests.ok ? '' : ' · ' + (c.tests.reason || [c.tests.suitesFailed ? c.tests.suitesFailed + ' SUITE(S) FAILED' : '', c.tests.suitesBlocked ? c.tests.suitesBlocked + ' SUITE(S) BLOCKED (timeout)' : ''].filter(Boolean).join(' · ')))));
  out.push(line('honesty gate', c.strict_events.ok, 'known accepted=' + c.strict_events.known_accepted + ' · unknown rejected=' + c.strict_events.unknown_rejected));
  out.push(line('dashboard SPA', c.dashboard_spa.ok, c.dashboard_spa.ok ? DASH_SPA.length + ' files present' : 'missing: ' + c.dashboard_spa.missing.join(', ')));
  const lk = c.leak_scan;
  const lkSkips = lk.skipped || [];
  const lkTooLarge = lkSkips.filter((s) => s.reason === 'too-large').length;
  const lkBinary = lkSkips.filter((s) => s.reason === 'binary').length;
  const lkUnreadable = lkSkips.filter((s) => s.reason === 'unreadable').length;
  const lkLongLine = lkSkips.filter((s) => s.reason === 'long-line').length;
  // honest coverage note (4th/5th fix round): never let the verdict imply total coverage while something was
  // dropped. too-large/binary/unreadable = the WHOLE file was not scanned (all honesty-critical — a real
  // secret could hide there); long-line = the file WAS scanned except over-long lines were length-bounded
  // (ReDoS guard). All surfaced so "clean" never silently means "clean among only what we bothered to scan".
  const lkParts = [];
  const lkNotScanned = lkTooLarge + lkBinary + lkUnreadable;
  if (lkNotScanned) lkParts.push(lkNotScanned + ' file(s) not scanned (' + [lkTooLarge ? lkTooLarge + ' too-large' : '', lkBinary ? lkBinary + ' binary' : '', lkUnreadable ? lkUnreadable + ' unreadable' : ''].filter(Boolean).join(', ') + ')');
  if (lkLongLine) lkParts.push(lkLongLine + ' file(s) with over-long line(s) bounded');
  const lkSkip = lkParts.length ? ' · ' + lkParts.join(' · ') : '';
  out.push(line('leak scan', lk.ok, lk.scanned + ' tracked files (' + lk.source + ')' + (lk.ok ? ' · clean' : ' · ' + lk.hits.length + ' HIT(S): ' + lk.hits.map((h) => h.pattern + ' in ' + h.file).join('; ')) + lkSkip));
  if (c.agents) {
    const a = c.agents;
    const tp = a.toolPolicy || {};
    const tpBad = tp.ok === false ? [
      tp.reason || '',
      (tp.missingPolicy || []).length ? 'no policy entry: ' + tp.missingPolicy.join(',') : '',
      (tp.missingAgentFile || []).length ? 'policy entry but no agent-md: ' + tp.missingAgentFile.join(',') : '',
      (tp.classViolations || []).length ? 'POLICY ITSELF violates class rules: ' + tp.classViolations.map((v) => v.agent + '(' + v.forbidden.join(',') + ')').join('; ') : '',
      (tp.driftViolations || []).length ? 'TOOL-GRANT DRIFT: ' + tp.driftViolations.map((v) => v.agent + (v.extra.length ? ' +' + v.extra.join(',') : '') + (v.missing.length ? ' -' + v.missing.join(',') : '')).join('; ') : '',
    ].filter(Boolean).join(' · ') : '';
    const detail = a.ok ? (a.expected + '/' + a.expected + ' Boss files · ' + a.found + ' agents · frontmatter valid · injection-clean · tool-policy clean')
      : ([a.missing.length ? 'missing: ' + a.missing.join(',') : '', a.badFrontmatter.length ? 'bad frontmatter: ' + a.badFrontmatter.join(',') : '', a.injection.length ? 'INJECTION: ' + a.injection.map((h) => h.pattern + ' in ' + h.file).join('; ') : '', tpBad].filter(Boolean).join(' · '));
    out.push(line('agents', a.ok, detail));
  }
  if (c.chain) {
    const ch = c.chain;
    out.push(line('event chain', ch.ok, ch.chained + '/' + ch.checked + ' runs hash-chained · tamper-evident' + (ch.ok ? '' : ' · BROKEN: ' + ch.broken.map((b) => b.run + ' (' + b.reason + ')').join('; '))));
  }
  if (c.rebinding_guard) out.push(line('rebind guard', c.rebinding_guard.ok, c.rebinding_guard.ok ? 'dashboard Host/Origin/Sec-Fetch guard wired' : c.rebinding_guard.reason));
  // Advisory (never fails the doctor, never part of the ALL GREEN / FAILURES verdict above) — printed as a
  // WARN line, distinct from the ✓/✗ check lines, so it can never be mistaken for a blocking result.
  if (rep.advisory && rep.advisory.backfill_continuity) {
    const bc = rep.advisory.backfill_continuity;
    if (bc.warnings && bc.warnings.length) {
      out.push('  ⚠ backfill continuity (advisory, non-blocking): ' + bc.warnings.length + ' WARNING(S): '
        + bc.warnings.map((w) => w.agent + ' in ' + w.run + ' (expected ' + w.expected + ', found ' + w.found + ')').join('; '));
    } else {
      out.push('  ✓ backfill continuity (advisory): ' + bc.applicableRuns + '/' + bc.checkedRuns + ' run(s) use dispatch_id · consistent');
    }
  }
  out.push(rep.ok ? '  ⇒ ALL GREEN' : '  ⇒ FAILURES ABOVE');
  return out.join('\n');
}

module.exports = { nodeCheckAll, runTests, strictEventCheck, spaPresent, leakScan, agentsCheck, chainCheck, rebindingGuard, backfillContinuity, runDoctor, printSummary, secretLabel, parseFrontmatter, parseToolsList, loadToolPolicy, BOSS_NAMES, looksLikeRealSecret, secretPortion, STRONG_PLACEHOLDER_RE, isPatternDefinitionContext, parseEventsJsonlLenient, chainCanon, PATTERN_DEFINITION_PATHS, LEAK_SCAN_MAX_BYTES, LEAK_SCAN_MAX_LINE };

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    let root = path.resolve(__dirname, '..', '..'), run = null, wantJson = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--root') root = argv[++i];
      else if (argv[i] === '--run') run = argv[++i];
      else if (argv[i] === '--json') wantJson = true;
    }
    const rep = runDoctor(root);
    // --json is a machine-readable CONTRACT: exactly ONE JSON object on stdout, nothing else — so a
    // consumer (e.g. forge-sync.cjs) can demand positive evidence instead of trusting only the exit code.
    // Without --json, keep the existing human-readable summary as the default.
    if (wantJson) console.log(JSON.stringify(rep, null, 2));
    else console.log(printSummary(rep));
    if (run && /^[A-Za-z0-9_-]+$/.test(run)) {
      const runDir = path.join(root, '.claude', 'forge-runs', run);
      try { fs.mkdirSync(runDir, { recursive: true }); fs.writeFileSync(path.join(runDir, 'doctor.json'), JSON.stringify(rep, null, 2) + '\n', 'utf8'); } catch (e) { console.error('forge-doctor: could not write doctor.json: ' + e.message); }
      const le = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
      const ev = spawnSync(NODE, [le, run, 'doctor_run', JSON.stringify({ agent: 'reviewer', note: 'forge-doctor ' + (rep.ok ? 'ALL GREEN' : 'FAILURES'), ok: rep.ok })], { encoding: 'utf8' });
      if (ev.status !== 0) console.error('forge-doctor: log-event warning: ' + (ev.stderr || '').trim());
    }
    process.exitCode = rep.ok ? 0 : 1;
  };
  try { main(); } catch (e) { console.error('forge-doctor: ' + e.message); process.exitCode = 1; }
}
