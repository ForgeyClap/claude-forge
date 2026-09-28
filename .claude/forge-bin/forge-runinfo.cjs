#!/usr/bin/env node
/**
 * forge-runinfo.cjs — project-local run info CLI: status | runs | open-report.
 *
 * v2.9.0 (WP-N1): the old per-project Forge Control Center (`.claude/forge-dashboard/server.cjs`) was
 * RETIRED — the one live dashboard for every Forge project is the Forge Command Center
 * (`command-center/`, served at http://127.0.0.1:4100). This tool keeps exactly the three CLI modes
 * `/forge status`, `/forge runs` and `/forge open-report` used to get from `server.cjs --status` /
 * `--runs` / `--open-report`, reusing that file's own run-listing logic verbatim
 * (classifyRunDir/orderRunRows/listRunIds/latestRunId/readRun — including the same run-id allowlist +
 * belt-and-suspenders path-containment guard readRun() used). Nothing here binds a port, starts an HTTP
 * server, or serves a UI — it only reads `.claude/forge-runs/` and `.claude/FORGE_*.md` and, for
 * `status`, makes one short-timeout GET to the Command Center's own `/api/health`.
 *
 * Modes:
 *   node forge-runinfo.cjs status         # Command Center reachability, latest run, memory files
 *   node forge-runinfo.cjs runs           # list project-local runs (newest first)
 *   node forge-runinfo.cjs open-report    # print the latest run's final-report.md
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const safeRead = (p) => { try { const s = fs.readFileSync(p, 'utf8'); return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; } catch { return null; } };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// --- RUN-1 fix (Codex adversarial-review finding, HIGH, WP-Q2 2026-09-27) ---
// safeRead()/fs.statSync() FOLLOW a symlink or Windows junction, while the OLD containment check in
// readRun() (below) was purely LEXICAL (path.resolve on the id, never fs.realpathSync) — a run
// directory under forge-runs/, or one of its own run.json/events.jsonl/final-report.md files, that is
// ITSELF a symlink/junction pointing outside forge-runs/ passed that lexical check and was then read
// and printed verbatim (e.g. by `open-report`). These three helpers are pure and exported so their
// symlink/containment behavior is covered by dedicated, hermetic fixture tests (real junction on
// Windows), independent of this tool's own RUNS_DIR isolation guard.

/** isSymlinkEntry(p) -> true when the filesystem entry AT p (not whatever it points to) is itself a
 *  symlink or a Windows junction/reparse-point-style mount. lstat, never stat/accessSync — those
 *  follow the link and would report on the TARGET, not the entry. false (never throws) when p does
 *  not exist. */
function isSymlinkEntry(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}
/** realContainmentOk(baseDir, targetPath) -> true only when targetPath's REAL, symlink-resolved
 *  location is baseDir itself or a real descendant of it. Unlike a lexical path.resolve() check, this
 *  follows every symlink/junction via fs.realpathSync, so a path that LOOKS contained (its text sits
 *  under baseDir) but is actually a link pointing elsewhere is correctly rejected. false (never
 *  throws) when either path cannot be resolved (e.g. does not exist). */
function realContainmentOk(baseDir, targetPath) {
  let realBase, realTarget;
  try { realBase = fs.realpathSync(baseDir); } catch { return false; }
  try { realTarget = fs.realpathSync(targetPath); } catch { return false; }
  return realTarget === realBase || realTarget.startsWith(realBase + path.sep);
}
// --- RUN-1 / PRUNE-1 fix, round 2 (Codex adversarial-review, HIGH) ---
// realContainmentOk() above is real-path-aware for the TARGET, but it trusts baseDir's OWN realpath at
// face value. If baseDir itself (e.g. `.claude/forge-runs`) is REPLACED with a junction to an external
// directory, fs.realpathSync(baseDir) resolves to that external directory, and fs.realpathSync() of
// anything built FROM baseDir (path.join(baseDir, id)) resolves to a path "under" that SAME external
// directory — so realContainmentOk sees perfect containment relative to the already-redirected base. A
// direct isSymlinkEntry()/realContainmentOk() check on the run folder or a report FILE (round 1's fix)
// cannot see this: it never looks at `.claude` or `.claude/forge-runs` themselves. pathChainIsReal()
// closes that gap by walking every path component BELOW a trusted `root` down to `targetPath`.
//
// Round 3 (Lead review, 2026-09-28): the FIRST version of this walk also required
// realpath(root) === path.resolve(root) — i.e. that root's OWN ancestry contains no link anywhere. That
// is STRICTER than the finding asked for and breaks legitimate, owner-chosen setups: a projects folder
// that is itself a symlink/junction to another drive, a redirected Documents folder, or (on macOS)
// `/tmp` being a symlink to `/private/tmp`. Those are configuration the user chose, not an attack — the
// finding asks for links to be rejected FROM the trusted project root DOWN, never above it. Fixed:
// realpath(root) is resolved ONCE and TRUSTED AS GIVEN, whatever it is (root itself may be reached
// through any number of links above it); every component BELOW root must then resolve to EXACTLY that
// trusted anchor plus its own expected relative sub-path (`path.join(realRoot, relativePartSoFar)`,
// compared case-insensitively on win32), on top of the existing lstat link check — so a link introduced
// at ANY point below root is still caught, while root's own path is never second-guessed.
function pathChainIsReal(root, targetPath) {
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return false; }
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(targetPath);
  if (targetResolved !== rootResolved && !targetResolved.startsWith(rootResolved + path.sep)) return false;
  const rel = path.relative(rootResolved, targetResolved);
  if (!rel) return true; // targetPath IS root itself -- root's own realpath is the trusted anchor, whatever it is
  const eq = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  let cur = rootResolved;
  let relSoFar = '';
  for (const part of rel.split(path.sep)) {
    if (!part) continue;
    cur = path.join(cur, part);
    relSoFar = relSoFar ? path.join(relSoFar, part) : part;
    if (isSymlinkEntry(cur)) return false;
    let real;
    try { real = fs.realpathSync(cur); } catch { return false; }
    if (!eq(real, path.join(realRoot, relSoFar))) return false;
  }
  return true;
}
/** forgeRunsRootIsReal(root) -> true only when `.claude` and `.claude/forge-runs`, walked from `root`
 *  down (via pathChainIsReal — see its own doc comment for why a leaf-only check is not enough), are
 *  both provably real: no symlink/junction at either level. An absent `.claude` or `.claude/forge-runs`
 *  is honestly `true` — there is nothing to protect yet, and a fresh project must not be treated as
 *  "compromised" merely for not having run any missions. Every real read under forge-runs/ (readRun,
 *  listRunIds, pruneSynthetic) checks this FIRST, before trusting anything built from RUNS_DIR. */
function forgeRunsRootIsReal(root) {
  const claudeDir = path.join(root, '.claude');
  if (!exists(claudeDir)) return true;
  if (!pathChainIsReal(root, claudeDir)) return false;
  const runsDir = path.join(claudeDir, 'forge-runs');
  if (!exists(runsDir)) return true;
  return pathChainIsReal(root, runsDir);
}
/** runsRootRefusalReason(root) -> a plain, printable reason string when forgeRunsRootIsReal(root) is
 *  false, or null when it is fine — so a CLI command can print an honest, specific line instead of a
 *  bare (and misleading) "no runs yet" when the real problem is a symlinked/junction forge-runs/. */
function runsRootRefusalReason(root) {
  return forgeRunsRootIsReal(root) ? null : 'the forge-runs directory (or an ancestor: .claude) is a symlink/junction — refusing to read anything under it';
}
/** statIdentity(st) -> the minimal fields pruneSynthetic()'s re-check-before-delete needs from an
 *  fs.lstatSync() result: dev+ino (identify the SAME filesystem object across two separate lstat calls),
 *  nlink (PRUNE-2's hardlink refusal) and isSymlink (belt-and-suspenders — a dev/ino match alone should
 *  never happen for a symlink swapped in for a regular file, but this makes the intent explicit). */
function statIdentity(st) { return { dev: st.dev, ino: st.ino, nlink: st.nlink, isSymlink: st.isSymbolicLink() }; }
/** identityMatches(a, b) -> true only when two statIdentity() snapshots refer to the SAME real
 *  filesystem object: neither is a symlink, and both dev+ino agree. Used to detect a local process
 *  swapping a checked directory/file for something else in the window between a read-only judgement and
 *  a later delete (PRUNE-1). */
function identityMatches(a, b) { return !!a && !!b && !a.isSymlink && !b.isSymlink && a.dev === b.dev && a.ino === b.ino; }

/** safeReadContained(filePath, baseDir) -> { text, escaped, reason }. `text` is the file's content, or
 *  null when the file simply does not exist (the common, honest case — most runs have no
 *  final-report.md yet). `escaped` is true only when the entry at filePath is itself a symlink, its
 *  real resolved location falls outside baseDir's own real location, or the file was SWAPPED between
 *  this safety check and the read itself — filePath's real content is NEVER read (not even attempted)
 *  in any of those cases; `reason` is one plain sentence suitable for printing as-is (never the file's
 *  own content).
 *  RUN-1 fix, round 2 (Codex adversarial-review, HIGH): reads now go through an OPEN FILE DESCRIPTOR —
 *  open(), then fstat() that SAME descriptor and compare its dev/ino against the lstat validated just
 *  above. fs.readFileSync(filePath) (the round-1 implementation) re-resolves the path from scratch, so a
 *  local process that swaps filePath for a symlink/junction in the tiny window between the checks above
 *  and the read would have that swap followed transparently; comparing identity BEFORE trusting the
 *  content detects exactly that race. */
function safeReadContained(filePath, baseDir) {
  if (!exists(filePath)) return { text: null, escaped: false, reason: '' };
  let lst;
  try { lst = fs.lstatSync(filePath); } catch { return { text: null, escaped: false, reason: '' }; }
  if (lst.isSymbolicLink()) {
    return { text: null, escaped: true, reason: path.basename(filePath) + ' is a symlink/junction, not a real file — refusing to read it' };
  }
  if (!realContainmentOk(baseDir, filePath)) {
    return { text: null, escaped: true, reason: path.basename(filePath) + ' resolves outside the real forge-runs directory — refusing to read it' };
  }
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return { text: null, escaped: false, reason: '' }; }
  try {
    const fst = fs.fstatSync(fd);
    // RUN-1, Codex verification (2026-09-28): the checks above ran BEFORE the open, so `.claude` or
    // `forge-runs` swapped for a junction in between made an outside file look contained. Now, with the
    // file already open, the path must STILL name exactly this descriptor's file (a fresh lstat), and the
    // whole chain from the project root must STILL be real: a swap before the open is caught by the
    // chain check or the identity mismatch, and what we read afterwards comes from this descriptor.
    let lstNow = null;
    try { lstNow = fs.lstatSync(filePath); } catch { /* vanished meanwhile: treated as a swap below */ }
    const projectRoot = path.dirname(path.dirname(path.resolve(baseDir)));
    if (!lstNow || fst.dev !== lst.dev || fst.ino !== lst.ino || fst.dev !== lstNow.dev || fst.ino !== lstNow.ino
        || !pathChainIsReal(projectRoot, filePath)) {
      return { text: null, escaped: true, reason: path.basename(filePath) + ' changed between the safety check and the read (possible swap) — refusing to read it' };
    }
    // A second name for the same file (a hard link) could point into the project at a file that lives
    // elsewhere; a real run file only ever has one.
    if (fst.nlink > 1) {
      return { text: null, escaped: true, reason: path.basename(filePath) + ' has more than one name on disk (a hard link) — refusing to read it' };
    }
    const raw = fs.readFileSync(fd, 'utf8');
    return { text: raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw, escaped: false, reason: '' };
  } finally { fs.closeSync(fd); }
}

// --- PROJECT ROOT DETECTION ---
// Mirrors the retired server.cjs's isolation guard, adapted to THIS tool's own install location
// (.claude/forge-bin/forge-runinfo.cjs, two levels above __dirname — same depth server.cjs was at
// under .claude/forge-dashboard/). An env override is honored only when it points at THIS tool's own
// install (realpath match): it may not redirect this CLI to read a different project's runs/memory.
function detectProjectRoot() {
  const envRoot = process.env.FORGE_PROJECT_ROOT;
  if (envRoot) {
    try {
      const candidate = path.join(envRoot, '.claude', 'forge-bin', 'forge-runinfo.cjs');
      if (exists(candidate) && fs.realpathSync(candidate) === fs.realpathSync(__filename)) return path.resolve(envRoot);
      console.error('[forge-runinfo] FORGE_PROJECT_ROOT ignored: it does not contain THIS tool\'s own install (' + envRoot + ')');
    } catch { /* ignore malformed override */ }
  }
  return path.resolve(__dirname, '..', '..');
}
const PROJECT_DIR = detectProjectRoot();
const CLAUDE_DIR = path.join(PROJECT_DIR, '.claude');
const RUNS_DIR = path.join(CLAUDE_DIR, 'forge-runs');
const MEMORY_FILES = ['FORGE_PROJECT_PROFILE.md', 'FORGE_MEMORY.md', 'FORGE_DECISIONS.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md', 'FORGE_SKILL_REGISTRY.md'];
const COMMAND_CENTER_URL = 'http://127.0.0.1:4100';
const HEALTH_TIMEOUT_MS = 2000;

/** SYNTHETIC_RUN_ID_PATTERNS — reserved run-id name patterns written ONLY by a self-test/benchmark tool,
 *  never by a real Forge run (a real run gets either a forge-<date>-<slug> id from `/forge`, or an
 *  explicit --run id a human/agent chose for a genuine mission — never literally one of these). This is
 *  a DIFFERENT, narrower question than forge-snapshot.cjs's own documented "no run-id name blacklist"
 *  stance (see that file's pickRun() doc comment): forge-snapshot deliberately judges WORK CONTENT so a
 *  real run coincidentally named "demo-…" is never wrongly excluded. These patterns instead name EXACT,
 *  DOCUMENTED tool-debris shapes that can never legitimately collide with a genuine mission id, and are
 *  the single source of truth for BOTH classifyRunDir()'s synthetic fallback (a run.json-less debris dir
 *  has no run.json to declare itself synthetic in — see WP-CC0 below) and pruneSynthetic()'s --apply
 *  allowlist.
 *  v2.9.0 WP-CC0 (Command Center audit, 2026-09-27) found real historical debris matching these three
 *  sources in multiple projects' forge-runs/ — all three were fixed in the SAME change to never write
 *  into a real project again (moved to an OS-tmp fixture), so this list only ever matches PRE-EXISTING
 *  debris from before that fix, or a future tool that reuses one of these exact reserved names:
 *   - forge-bin/forge-bench.cjs (pre-fix): 'bench-canon-<pid>' / 'bench-fake-<pid>'
 *   - forge-bin/forge-doctor.cjs (pre-fix): 'doctor-selfcheck-<pid>'
 *   - forge-bin/forge-docs.test.cjs (pre-2026-07-22 GAP-2 fix): literal 'nonexistent-run-id'
 *  Exact literal match or a fixed prefix + trailing digits only — never a broad substring/wildcard that
 *  could catch an unrelated real run. */
const SYNTHETIC_RUN_ID_PATTERNS = [
  /^bench-canon(-\d+)?$/, /^bench-fake(-\d+)?$/,
  /^doctor-selfcheck(-\d+)?$/,
  /^nonexistent-run-id$/,
];
function isReservedSyntheticRunId(name) { return SYNTHETIC_RUN_ID_PATTERNS.some((re) => re.test(name)); }

/** classifyRunDir(dir, name) -> {isRun, synthetic, malformed, recency, name} — ported VERBATIM from the
 *  retired server.cjs (same fix history, kept here so it is not lost):
 *  MEASURED DEFECT (audit sweep 2026-08-03): the old listing sorted by DIRECTORY NAME and accepted
 *  every directory, so a run whose own run.json declared {"_demo":true,"synthetic":true,...} could sort
 *  first and become "the latest run" for `/forge status`/`/forge open-report` and the dashboard header.
 *  Two rules fix that:
 *   - a run DIRECTORY must actually carry run shape (run.json and/or events.jsonl) — operational dirs
 *     (`_toollog`, `.hotspot-locks`) are not missions;
 *   - a run that declares itself synthetic/demo is still listable, but never wins "latest".
 *  Recency comes from the newest real EVENT (else run.json, else dir mtime) — never from the name, and
 *  never from a directory mtime an unrelated later child write (e.g. dropping in final-report.md today)
 *  could bump above a genuinely newer run. PRESENT-but-unparseable run.json is `malformed` (we cannot
 *  tell what it is, so it is listed but never eligible for "latest") — distinct from run.json simply
 *  being ABSENT (an ordinary run; most real runs have none). See forge-runinfo.test.cjs.
 *
 *  WP-CC0 fix: a debris folder written by forge-bench.cjs/forge-doctor.cjs before their own fix (or any
 *  future tool that reuses one of those exact reserved names) never had a run.json at all, so the old
 *  run.json-only synthetic check could not see it — `doctor-selfcheck-<pid>` could still become "latest
 *  run" purely by mtime, the exact defect forge-snapshot.cjs's own pickRun() doc comment already
 *  describes happening to `.claude/FORGE_SNAPSHOT.md`. `synthetic` is now ALSO true whenever the run id
 *  itself matches SYNTHETIC_RUN_ID_PATTERNS, independent of run.json — see that constant's own doc
 *  comment for why a narrow reserved-name check is safe here even though forge-snapshot.cjs deliberately
 *  avoids name-based judgement for a different, broader question. */
function classifyRunDir(dir, name) {
  // RUN-1 fix: a symlinked/junction "directory" entry under forge-runs/ is never treated as a run at
  // all — lstat-checked FIRST, before anything under it is ever read, so it can never influence
  // "latest run" selection (recency/synthetic) by peeking at whatever it actually points to.
  if (isSymlinkEntry(dir)) return { isRun: false, synthetic: false, recency: 0 };
  const runJsonPath = path.join(dir, 'run.json');
  const eventsPath = path.join(dir, 'events.jsonl');
  const hasRunJson = exists(runJsonPath), hasEvents = exists(eventsPath);
  if (!hasRunJson && !hasEvents) return { isRun: false, synthetic: false, recency: 0 };
  let synthetic = isReservedSyntheticRunId(name);
  let malformed = false;
  if (hasRunJson) {
    try {
      const j = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));
      synthetic = synthetic || !!(j && (j._demo === true || j.synthetic === true));
    } catch { malformed = true; }
  }
  const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return NaN; } };
  const evT = mtimeOf(eventsPath);
  const rjT = mtimeOf(runJsonPath);
  const dirT = mtimeOf(dir);
  const recency = Number.isFinite(evT) ? evT : (Number.isFinite(rjT) ? rjT : (Number.isFinite(dirT) ? dirT : 0));
  return { isRun: true, synthetic, malformed, recency, name };
}
/** orderRunRows — pure ordering rule: real runs first, newest real time first; self-declared
 *  synthetic/demo runs always behind them, regardless of recency. */
function orderRunRows(rows) {
  return rows.slice().sort((a, b) => (a.synthetic === b.synthetic) ? (b.recency - a.recency) : (a.synthetic ? 1 : -1));
}
function listRunIds() {
  if (!exists(RUNS_DIR)) return [];
  // RUN-1 fix, round 2: refuse to even list anything when forge-runs/ (or `.claude` itself) is a
  // symlink/junction — see forgeRunsRootIsReal()'s own doc comment. An empty list is the honest answer
  // here; cmdStatus/cmdRuns print a specific refusal line via runsRootRefusalReason() instead of a bare
  // "no runs yet".
  if (!forgeRunsRootIsReal(PROJECT_DIR)) return [];
  const rows = [];
  for (const d of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const c = classifyRunDir(path.join(RUNS_DIR, d.name), d.name);
    if (c.isRun) rows.push(c);
  }
  return orderRunRows(rows).map((r) => r.name);
}
/** latestRunId — ONE selector, shared with listRunIds() (never a second opinion by e.g. run.json.started,
 *  which would silently undo the listing's own synthetic-never-wins-latest rule). Returns null rather
 *  than presenting a demo/malformed run as current when nothing eligible exists. */
function latestRunId() {
  for (const id of listRunIds()) {
    const c = classifyRunDir(path.join(RUNS_DIR, id), id);
    if (c.isRun && !c.synthetic && !c.malformed) return id;
  }
  return null;
}
/** readRun(id) -> {run, events, report, malformed, escaped?, reason?} | null. Run-id validation +
 *  path containment, ported verbatim from server.cjs: ids are alphanumeric + `_`/`-` only (no
 *  traversal), and the resolved path is checked to still sit inside RUNS_DIR (belt-and-suspenders on
 *  top of the regex).
 *
 *  RUN-1 fix (Codex adversarial-review finding, HIGH, WP-Q2 2026-09-27): the containment check above
 *  is LEXICAL (path.resolve never follows a link) while fs.readFileSync/fs.statSync elsewhere in this
 *  file DO follow a symlink/junction — a run directory (or one of run.json/events.jsonl/
 *  final-report.md inside it) that is itself a symlink pointing outside forge-runs/ passed every
 *  check above and was then read and printed verbatim (e.g. by `open-report`, cmdOpenReport() below).
 *  Every read below now goes through isSymlinkEntry()/realContainmentOk()/safeReadContained() — an
 *  escape returns { escaped: true, reason } with `run`/`events`/`report` left empty; the file's real
 *  content, whatever it is, is never read into memory, let alone printed. Callers (cmdStatus/cmdRuns/
 *  cmdOpenReport) must check `.escaped` and print `.reason` — one plain line — instead of the usual
 *  fields. */
function readRun(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const dir = path.join(RUNS_DIR, id);
  const base = path.resolve(RUNS_DIR), resolved = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  if (!exists(dir)) return null;
  const EMPTY = { run: {}, events: [], report: null, malformed: 0 };
  // RUN-1 fix, round 2: the runs ROOT itself (.claude, .claude/forge-runs) must be provably real before
  // trusting anything built from RUNS_DIR — see forgeRunsRootIsReal()'s own doc comment for the exact
  // gap this closes (round 1 only checked the run folder/file themselves).
  if (!forgeRunsRootIsReal(PROJECT_DIR)) {
    return { ...EMPTY, escaped: true, reason: runsRootRefusalReason(PROJECT_DIR) };
  }
  if (isSymlinkEntry(dir)) {
    return { ...EMPTY, escaped: true, reason: 'run directory "' + id + '" is a symlink/junction, not a real directory — refusing to read it' };
  }
  if (!realContainmentOk(RUNS_DIR, dir)) {
    return { ...EMPTY, escaped: true, reason: 'run directory "' + id + '" resolves outside the real forge-runs directory — refusing to read it' };
  }
  let run = {};
  const rjRead = safeReadContained(path.join(dir, 'run.json'), RUNS_DIR);
  if (rjRead.escaped) return { ...EMPTY, escaped: true, reason: rjRead.reason };
  if (rjRead.text) { try { run = JSON.parse(rjRead.text); } catch { run = { parse_error: true }; } }
  run.run_id = run.run_id || id;
  const events = []; let malformed = 0;
  const evRead = safeReadContained(path.join(dir, 'events.jsonl'), RUNS_DIR);
  if (evRead.escaped) return { ...EMPTY, escaped: true, reason: evRead.reason };
  if (evRead.text) for (const line of evRead.text.split(/\r?\n/)) { const t = line.trim(); if (!t) continue; try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) events.push(v); else malformed++; } catch { malformed++; } }
  const reportRead = safeReadContained(path.join(dir, 'final-report.md'), RUNS_DIR);
  if (reportRead.escaped) return { ...EMPTY, escaped: true, reason: reportRead.reason };
  return { run, events, report: reportRead.text, malformed };
}

/** checkCommandCenterHealth(url, timeoutMs) -> Promise<{ok, status, body}|{ok:false, error}>.
 *  ok:true means the HTTP request completed (any status code) and, when the body parsed as JSON, that
 *  parsed body is returned — this CLI never claims "running" beyond what it actually observed. ok:false
 *  covers both "nothing is listening" (ECONNREFUSED) and a timeout, each with its own `error` string, so
 *  `status` can print an honest reason rather than a bare "not running". */
function checkCommandCenterHealth(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL('/api/health', url); } catch { resolve({ ok: false, error: 'bad url: ' + url }); return; }
    let req;
    try {
      req = http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: timeoutMs }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(d); } catch { /* non-JSON body is still an honest "answered" */ }
          resolve({ ok: true, status: res.statusCode, body });
        });
      });
    } catch (e) { resolve({ ok: false, error: e.message }); return; }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout after ' + timeoutMs + 'ms' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/** looksLikeCommandCenterHealth(body) -> true only when body is a parsed JSON object matching THIS
 *  gateway's own real GET /api/health response shape (see command-center/gateway/src/health.mjs's
 *  buildHealth()): an `ok` boolean, a `runtime` value, and a `gateway` object carrying its own
 *  `version` string. LAUNCH-1 fix (Codex adversarial-review finding, LOW, WP-Q2 2026-09-27): `status`
 *  used to report "(running)" for ANY successful HTTP response on the Command Center's port,
 *  including a plain 404 or any unrelated server's own response — this is the shape check that tells
 *  the real gateway apart from anything else merely listening there. Kept as its own small predicate
 *  (duplicated, not shared, in forge-cc-launch.cjs — same function name and body there) for the same
 *  reason this file avoids importing command-center/ code anywhere else: it is its own separate git
 *  repository. */
function looksLikeCommandCenterHealth(body) {
  return !!(body && typeof body === 'object' && !Array.isArray(body)
    && typeof body.ok === 'boolean'
    && 'runtime' in body
    && body.gateway && typeof body.gateway === 'object'
    && typeof body.gateway.version === 'string');
}

/** commandCenterStartHint(root) -> the exact command to start the dashboard FROM this project. When
 *  this project itself hosts the Command Center (command-center/gateway/bin.mjs exists here), that
 *  exact command is given; otherwise `forge dashboard` is the honest answer (the wrapper finds/starts
 *  the one true Command Center, or says plainly that this project has none locally). Parameterized on
 *  `root` (defaults to PROJECT_DIR) so it is directly testable against a fixture. */
function commandCenterStartHint(root) {
  const gw = path.join(root || PROJECT_DIR, 'command-center', 'gateway', 'bin.mjs');
  if (exists(gw)) return 'node command-center/gateway/bin.mjs   (or: forge dashboard)';
  return 'forge dashboard   (this project has no local command-center/ — that command finds the shared one)';
}

async function cmdStatus() {
  // RUN-1 fix, round 2: an honest, specific reason when forge-runs/ (or `.claude`) itself is a
  // symlink/junction — listRunIds()/latestRunId() already refuse to read anything under it (returning
  // [] / null), so this is purely an honesty upgrade: "0 runs" alone would be misleading here.
  const rootRefusal = runsRootRefusalReason(PROJECT_DIR);
  const ids = listRunIds();
  const lid = latestRunId();
  const latest = lid ? readRun(lid) : null;
  // RUN-1 fix: an escaped run (symlink/junction escape detected) never contributes its real fields —
  // one plain refusal line instead, never the file's own content.
  const escaped = !!(latest && latest.escaped);
  const health = await checkCommandCenterHealth(COMMAND_CENTER_URL, HEALTH_TIMEOUT_MS);
  // LAUNCH-1 fix: health.ok only means "something answered on the port" — it says nothing about WHAT
  // answered. A real Command Center is confirmed only when the parsed body also has this gateway's
  // own real health shape; anything else that happens to be listening there is a port conflict, not
  // "running", and must be reported as such rather than silently trusted.
  const ccRunning = health.ok && looksLikeCommandCenterHealth(health.body);
  const ccConflict = health.ok && !ccRunning;
  console.log('Forge status — ' + path.basename(PROJECT_DIR));
  console.log('  project folder  : ' + PROJECT_DIR);
  console.log('  Command Center  : ' + COMMAND_CENTER_URL + (
    ccRunning ? '  (running)'
      : ccConflict ? '  (port conflict — something else is listening here, not the Forge Command Center; what is using it is unknown; free the port or set CC_PORT)'
        : '  (not running — ' + health.error + ')'
  ));
  if (!ccRunning && !ccConflict) console.log('    start it with : ' + commandCenterStartHint());
  console.log('  latest run      : ' + (lid || '(none)'));
  if (escaped) console.log('  ! refused       : ' + latest.reason);
  console.log('  events          : ' + (latest && !escaped ? latest.events.length : 0) + (latest && !escaped && latest.malformed ? ('  (' + latest.malformed + ' malformed, skipped)') : ''));
  console.log('  total runs      : ' + ids.length);
  if (rootRefusal) console.log('  ! forge-runs    : ' + rootRefusal);
  console.log('  memory files    :');
  for (const f of MEMORY_FILES) console.log('    [' + (exists(path.join(CLAUDE_DIR, f)) ? 'x' : ' ') + '] ' + f);
  const rp = lid && !escaped ? path.join(RUNS_DIR, lid, 'final-report.md') : null;
  console.log('  latest report   : ' + (escaped ? '(refused — see above)' : (rp && exists(rp) ? rp : '(none)')));
}

function cmdRuns() {
  // RUN-1 fix, round 2: refuse with a specific, honest reason rather than the generic "No runs yet"
  // when forge-runs/ (or `.claude`) itself is a symlink/junction — see forgeRunsRootIsReal().
  const rootRefusal = runsRootRefusalReason(PROJECT_DIR);
  if (rootRefusal) { console.log('Refused: ' + rootRefusal); return; }
  const ids = listRunIds();
  if (!ids.length) { console.log('No runs yet in ' + RUNS_DIR); return; }
  console.log('Forge runs (' + path.basename(PROJECT_DIR) + ', newest first):');
  for (const id of ids) {
    const r = readRun(id);
    // RUN-1 fix: an escaped run prints one plain refusal line for that id — never its own content,
    // and never a silent "[?]" that could be mistaken for an ordinary run with no metadata.
    if (r && r.escaped) { console.log('  ' + id + '  [refused: ' + r.reason + ']'); continue; }
    const run = (r && r.run) || {};
    console.log('  ' + id + '  [' + (run.status || '?') + ']  ' + (run.request || ''));
  }
}

function cmdOpenReport() {
  // one selector (mirrors server.cjs's own fix): this must never open a synthetic demo's non-existent
  // report, so it goes through latestRunId(), never listRunIds()[0] directly.
  const lid = latestRunId();
  if (!lid) { console.log('No real (non-demo) run with a report yet.'); return; }
  // RUN-1 fix: this used to call safeRead(rp) directly, bypassing readRun()'s own containment guard
  // entirely — the exact reported bug ("open-report ... prints a file OUTSIDE forge-runs/"). Routed
  // through readRun() now, the SAME hardened path status/runs use, so a symlink/junction escape is
  // refused here too, in one plain line, never read.
  const r = readRun(lid);
  if (r && r.escaped) { console.log('Refused: ' + r.reason); return; }
  const rp = path.join(RUNS_DIR, lid, 'final-report.md');
  console.log('Latest report: ' + rp + '\n');
  console.log((r && r.report) || '(no final-report.md for the latest run yet)');
}

// ---------------------------------------------------------------------------------------------------------
// prune-synthetic (WP-CC0, 2026-09-27) — lists (dry run by default) and, only with --apply, removes
// EXACTLY the reserved-name debris folders (see SYNTHETIC_RUN_ID_PATTERNS above), never a generic
// run.json-declared demo/synthetic run: an owner-created reference/demo run (e.g. the real
// `forge-demo-10agents-layout-preview` this project's own forge-snapshot.cjs header documents) may be
// kept on purpose, so --apply never deletes on a content declaration alone — only on an EXACT reserved
// tool-debris name AND a verified-empty-of-anything-else directory. One held-back candidate is always
// safer than one wrongly deleted run.
// ---------------------------------------------------------------------------------------------------------
/** ALLOWED_SYNTHETIC_DEBRIS_FILES — the ONLY file names a reserved-name debris folder is ever allowed to
 *  contain for inspectSyntheticCandidate() to call it safe to delete. Both are real, known artifacts of
 *  forge-dashboard/log-event.cjs's own write path (events.jsonl itself, and events.jsonl.lock left
 *  behind only when a write crashed mid-lock — see that file's releaseLock()). ANY other entry (a
 *  run.json, a final-report.md, a subdirectory, an unrelated file) means the directory is not "just
 *  debris", and pruneSynthetic() refuses to touch it. */
const ALLOWED_SYNTHETIC_DEBRIS_FILES = new Set(['events.jsonl', 'events.jsonl.lock']);

/** SYNTHETIC_DEBRIS_EVENT_SIGNATURES / looksLikeSelfTestDebrisEvents — PRUNE-2 fix (Codex
 *  adversarial-review, MEDIUM): the run-id pattern match alone is not proof of debris — log-event.cjs's
 *  own run-id regex accepts ANY [A-Za-z0-9_-] name (deliberately NOT taught to refuse these reserved
 *  names; forge-bench.cjs/forge-doctor.cjs's OWN self-checks legitimately use them inside their OS-temp
 *  fixtures), so nothing stops a genuine mission from being named e.g. "bench-canon-123" and holding a
 *  real events.jsonl. Before eligibility is granted, the folder's events.jsonl (when present) must
 *  contain ONLY lines matching one of these three EXACT, DOCUMENTED self-test event shapes — the only
 *  content the retired pre-WP-CC0-fix versions of forge-bench.cjs/forge-doctor.cjs/forge-docs.test.cjs
 *  ever actually wrote under one of these reserved names:
 *   - bench (forge-bench.cjs 'honesty.canonical-name', verified against its current source): logs
 *     {agent:'build-boss', note:'b'} as an agent_progress event; log-event.cjs's own canonicalAgent()
 *     maps the 'build-boss' slug to the display name 'Build Boss' via config/agents/agent-registry.json
 *     (verified: this project's own registry maps that slug to "Build Boss") BEFORE writing, so the
 *     line actually on disk carries agent:'Build Boss'.
 *   - doctor self-check (forge-doctor.cjs's own selfCheck(), verified against its current source): logs
 *     {agent:'orchestrator', note:'doctor self-check'} as an agent_progress event; 'orchestrator' is a
 *     GENERIC_AGENTS entry in log-event.cjs, so it is never canonicalized to anything else.
 *   - nonexistent-run-id (forge-docs.test.cjs): this repository's own git history for that file begins
 *     at a single bulk-checkpoint commit that already carries the FIXED, hermetic-fixture version of the
 *     test (git log -p found no earlier, pre-fix revision to inspect) — the debris shape is instead
 *     derived from forge-docs.cjs's own unchanged logDocEvent(), the ONLY real call site that has ever
 *     written a 'doc_generated' event, and that still-current test's own assertion that a bare
 *     `--run nonexistent-run-id` produces exactly one such event. format/out/bytes vary per call and are
 *     deliberately not matched.
 *  Matching is on these IDENTIFYING fields only — log-event.cjs stamps every real event with additional
 *  volatile fields (timestamp, event_id, prev_hash, seq, entry_hash, _forge_verify) that legitimately
 *  differ between writes and are deliberately ignored here. */
const SYNTHETIC_DEBRIS_EVENT_SIGNATURES = [
  (e) => !!e && e.event_type === 'agent_progress' && e.agent === 'Build Boss' && e.note === 'b',
  (e) => !!e && e.event_type === 'agent_progress' && e.agent === 'orchestrator' && e.note === 'doctor self-check',
  (e) => !!e && e.event_type === 'doc_generated',
];
const MAX_SYNTHETIC_DEBRIS_EVENT_LINES = 20;
/** looksLikeSelfTestDebrisEvents(text) -> {ok, reason}. `text` is an events.jsonl file's own content (or
 *  falsy for "no content to check", which is vacuously ok — a crashed-mid-write debris folder with zero
 *  real bytes is still harmless debris). ok:false whenever ANY line fails to parse as a plain JSON
 *  object, does not match one of SYNTHETIC_DEBRIS_EVENT_SIGNATURES, or the file holds more than
 *  MAX_SYNTHETIC_DEBRIS_EVENT_LINES lines — a real self-test writes at most a handful of lines, never a
 *  genuine multi-agent mission's worth. */
function looksLikeSelfTestDebrisEvents(text) {
  if (!text) return { ok: true, reason: 'no events.jsonl content to check' };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_SYNTHETIC_DEBRIS_EVENT_LINES) {
    return { ok: false, reason: 'events.jsonl has ' + lines.length + ' line(s) (> ' + MAX_SYNTHETIC_DEBRIS_EVENT_LINES + ') — does not look like self-test debris' };
  }
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { return { ok: false, reason: 'events.jsonl has an unparseable line — does not look like self-test debris' }; }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return { ok: false, reason: 'events.jsonl has a non-object line — does not look like self-test debris' };
    if (!SYNTHETIC_DEBRIS_EVENT_SIGNATURES.some((sig) => sig(ev))) {
      return { ok: false, reason: 'events.jsonl line does not match a known self-test signature (event_type=' + ev.event_type + ') — does not look like self-test debris' };
    }
  }
  return { ok: true, reason: 'every line matches a known self-test signature' };
}

/** inspectSyntheticCandidate(dir, name, runsDir) -> {eligible, reason, files, identity?} — a READ-ONLY
 *  judgement (never deletes anything itself). Non-recursive by design: only the DIRECT entries of `dir`
 *  are ever inspected, never anything inside a nested directory — a candidate containing any
 *  subdirectory is refused outright rather than walked into. `runsDir` is the containment root (defaults
 *  to the real module-level RUNS_DIR; parameterized, like commandCenterStartHint(root), so this is
 *  directly testable against an os.mkdtemp fixture without touching the real project).
 *  PRUNE-1/PRUNE-2 fix (Codex adversarial-review, HIGH/MEDIUM): eligibility now ALSO requires (a) no
 *  surviving file has additional hard links (nlink > 1 — unlink() only removes one directory entry, but
 *  DELETES the underlying data once the last link is gone, so a hardlinked events.jsonl could belong to
 *  something else entirely) and (b) events.jsonl's own content really looks like self-test debris (see
 *  looksLikeSelfTestDebrisEvents — a genuine mission may legally be named a reserved pattern). On
 *  success, `identity` carries each surviving file's (and the directory's) dev/ino/nlink snapshot AT THE
 *  MOMENT this judgement passed, so pruneSynthetic() can re-verify it is still looking at the SAME
 *  filesystem objects right before it ever deletes anything. */
function inspectSyntheticCandidate(dir, name, runsDir) {
  const base = runsDir || RUNS_DIR;
  if (!isReservedSyntheticRunId(name)) return { eligible: false, reason: 'run id does not match a reserved synthetic-tool pattern — never a candidate', files: [] };
  if (isSymlinkEntry(dir)) return { eligible: false, reason: 'refusing: the directory entry itself is a symlink/junction', files: [] };
  if (!realContainmentOk(base, dir)) return { eligible: false, reason: 'refusing: resolves outside the real forge-runs directory', files: [] };
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { eligible: false, reason: 'could not list directory: ' + (e && e.message), files: [] }; }
  const files = entries.map((e) => e.name);
  for (const e of entries) {
    if (!e.isFile()) return { eligible: false, reason: 'refusing: contains a non-file entry "' + e.name + '" (directory/symlink) — not a plain debris folder', files };
    if (!ALLOWED_SYNTHETIC_DEBRIS_FILES.has(e.name)) return { eligible: false, reason: 'refusing: contains an unexpected file "' + e.name + '" — not exactly the known debris shape', files };
  }
  let identity;
  try {
    identity = { dir: statIdentity(fs.lstatSync(dir)), files: {} };
    for (const f of files) identity.files[f] = statIdentity(fs.lstatSync(path.join(dir, f)));
  } catch (e) {
    return { eligible: false, reason: 'could not read file identity: ' + (e && e.message), files };
  }
  // PRUNE-2: a hardlinked file could be data shared with something else entirely — refuse outright.
  for (const f of files) {
    if (identity.files[f].nlink > 1) {
      return { eligible: false, reason: 'refusing: "' + f + '" has additional hard links (nlink=' + identity.files[f].nlink + ') — deleting it could remove data referenced elsewhere', files };
    }
  }
  // PRUNE-2: the reserved NAME alone is not proof of debris — the content must look like it too.
  if (files.includes('events.jsonl')) {
    let text;
    try { text = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'); } catch (e) { return { eligible: false, reason: 'could not read events.jsonl: ' + (e && e.message), files }; }
    const verdict = looksLikeSelfTestDebrisEvents(text);
    if (!verdict.ok) return { eligible: false, reason: verdict.reason, files };
  }
  return { eligible: true, reason: 'matches a reserved pattern and contains only ' + (files.length ? files.join(', ') : '(nothing)'), files, identity };
}
// --- STOP-PRUNE-1 fix (Codex stop-time adversarial review, HIGH, WP-9B-SRC round 3, 2026-09-28) ---
// The round-1/round-2 fix above (identityMatches() re-check right before unlink) closes the window
// where identity was ALREADY different at revalidation time, but NOT a swap that happens AFTER that
// revalidation and BEFORE the actual fs.unlinkSync() calls a few lines later: a concurrent rename of
// the candidate directory (or forge-runs itself) to a junction, planted right after our check passed,
// still redirects the delete outside the project. Node has no unlinkat/openat (no handle-anchored
// delete relative to an already-open directory descriptor), so a truly race-free delete the way a
// platform with those syscalls could do it is not available here.
//
// Measured on this machine (Windows 11, Node 24) before choosing this design:
//  1. An EXCLUSIVE open of the DIRECTORY itself blocks a rename of it — but also blocks OUR OWN
//     readdir of it (EBUSY either way). Unsuitable.
//  2. A plain (non-exclusive) open handle on a FILE inside the directory pins every ancestor against
//     RENAME (EPERM), but NTFS/libuv still shares DELETE — another process can unlink that exact file
//     out from under the handle, and once it's gone the directory can be renamed again. Defeatable.
//  3. An EXCLUSIVELY opened ("share mode 0", libuv's UV_FS_O_EXLOCK) file WE CREATE inside the
//     candidate directory: fstat(fd) and lstat(path) name the same file; while the handle stays open,
//     renaming that file, its parent, or its grandparent is refused (EPERM) for every OTHER process;
//     our OWN unlinkSync() of the sibling debris files in that same directory still succeeds; our own
//     unlink of the pin itself while still open is refused (EBUSY, expected — we close it first).
//     This is the guarantee this fix relies on: as long as the pin stays open, the candidate directory
//     cannot be swapped out from under the debris-file unlinks that follow.
// UV_FS_O_EXLOCK is not exported as a named fs.constants entry — Node passes raw flags through to
// libuv's open() unchanged, so the numeric value (measured/confirmed against this Node build) is used
// directly, OR'd into the standard O_CREAT|O_EXCL|O_RDWR flags.
const UV_FS_O_EXLOCK = 0x10000000;
/** RUNINFO_TEST_HOOKS_ENABLED — mirrors forge-sync.cjs's own FORGE_SYNC_TEST_HOOKS convention: a
 *  test-only interception seam inside a real delete path must be inert by construction, not merely
 *  "unset by default" — gated behind an env var the real CLI never sets, so an accidental opts.__* field
 *  reaching production code can never activate anything. */
const RUNINFO_TEST_HOOKS_ENABLED = process.env.FORGE_RUNINFO_TEST_HOOKS === '1';
/** pinCandidateDirWindows(dir) -> {ok, fd, pinPath, error}. Creates a randomly-named file INSIDE `dir`
 *  opened with O_CREAT|O_EXCL|O_RDWR|UV_FS_O_EXLOCK (share mode 0 — see the fix's own header comment
 *  above for exactly what this does and does not protect). ok:false (fd/error set, pinPath still the
 *  path that was attempted) only when the create itself failed — e.g. `dir` no longer exists. A true
 *  ok:true here is NOT yet proof `dir` is the real, intended candidate: if `dir` was already swapped for
 *  a junction before this call, the pin lands inside whatever that junction now points to — proving
 *  that (or refusing to trust it) is verifyPinnedCandidate()'s job, always called immediately after. */
function pinCandidateDirWindows(dir) {
  const pinName = '.forge-prune-pin-' + crypto.randomBytes(8).toString('hex');
  const pinPath = path.join(dir, pinName);
  let fd;
  try { fd = fs.openSync(pinPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | UV_FS_O_EXLOCK); }
  catch (e) { return { ok: false, fd: null, pinPath, error: e }; }
  return { ok: true, fd, pinPath, error: null };
}
/** verifyPinnedCandidate(pin, root, dir, verdict) -> {ok, reason}. Re-verifies EVERYTHING that could
 *  have changed since inspectSyntheticCandidate()'s read-only judgement, now that the pin from
 *  pinCandidateDirWindows() is held: the pin's own fd/path identity agree (proves the path we THINK we
 *  pinned is really what the handle refers to — the one thing pinning itself cannot self-verify), the
 *  runs root and the full chain down to the candidate are still real (no symlink/junction introduced
 *  anywhere), and the candidate directory's + every debris file's identity still match the snapshot
 *  inspectSyntheticCandidate() captured. Any single mismatch refuses the WHOLE candidate. */
function verifyPinnedCandidate(pin, root, dir, verdict) {
  let pinLstat, pinFstat;
  try { pinLstat = fs.lstatSync(pin.pinPath); } catch (e) { return { ok: false, reason: 'could not lstat the pin file: ' + (e && e.message) }; }
  try { pinFstat = fs.fstatSync(pin.fd); } catch (e) { return { ok: false, reason: 'could not fstat the pin handle: ' + (e && e.message) }; }
  if (pinFstat.dev !== pinLstat.dev || pinFstat.ino !== pinLstat.ino) {
    return { ok: false, reason: 'the pin file at its expected path is no longer the same file our own handle refers to' };
  }
  if (!forgeRunsRootIsReal(root)) {
    return { ok: false, reason: 'the runs directory (.claude or .claude/forge-runs) is a symlink/junction — refusing to delete' };
  }
  if (!pathChainIsReal(root, dir)) {
    return { ok: false, reason: 'the candidate directory no longer resolves as a real, unlinked path from the project root' };
  }
  let dirNow;
  try { dirNow = statIdentity(fs.lstatSync(dir)); } catch (e) { return { ok: false, reason: 'could not re-lstat the candidate directory: ' + (e && e.message) }; }
  if (!identityMatches(dirNow, verdict.identity.dir)) {
    return { ok: false, reason: 'directory identity changed since inspection — refusing to delete' };
  }
  for (const f of verdict.files) {
    let fileNow;
    try { fileNow = statIdentity(fs.lstatSync(path.join(dir, f))); } catch (e) { return { ok: false, reason: 'could not re-lstat "' + f + '": ' + (e && e.message) }; }
    if (!identityMatches(fileNow, verdict.identity.files[f])) {
      return { ok: false, reason: 'file "' + f + '" identity changed since inspection — refusing to delete' };
    }
  }
  return { ok: true, reason: '' };
}
/** posixChainIsPrivate(targetPath, seams) -> {ok, reason}. STOP-PRUNE-1's non-Windows fallback: the
 *  Windows exclusive-share pin above has no POSIX equivalent this project can rely on (no
 *  unlinkat/openat; flock()'s advisory locks do not stop a rename). Absent a race-free delete
 *  primitive, --apply refuses on any OTHER platform UNLESS it can prove no other user could swap
 *  anything on the way: every directory from the filesystem root down to targetPath — walked for BOTH
 *  the lexical (path.resolve) chain and, separately, the REAL (symlink-resolved) chain, since a
 *  component could itself be a symlink whose own target needs the same guarantee — must be owned by the
 *  current uid or by root, and must not be group- or other-writable UNLESS it also carries the sticky
 *  bit (the `/tmp` shape: sticky restricts renaming/deleting an ENTRY inside a world-writable directory
 *  to that entry's own owner or root, so the remaining race is only with ourselves or root, who could
 *  delete these files through the front door anyway).
 *  seams.lstatSync/seams.realpathSync/seams.getUid are injectable (test-only; the real caller never
 *  passes them) so this branch is exercised deterministically even on Windows, where fs.Stats.uid/gid
 *  do not carry real POSIX semantics and process.getuid does not exist at all. */
function posixChainIsPrivate(targetPath, seams) {
  const s = seams || {};
  const lstatFn = s.lstatSync || fs.lstatSync;
  const realpathFn = s.realpathSync || fs.realpathSync;
  const getUid = s.getUid || (() => (typeof process.getuid === 'function' ? process.getuid() : null));
  const uid = getUid();
  if (uid === null || uid === undefined) {
    return { ok: false, reason: 'cannot determine the current uid on this platform — refusing (no POSIX privacy guarantee available)' };
  }
  const isPrivateEntry = (st, isDir) => {
    const ownedBySelfOrRoot = st.uid === uid || st.uid === 0;
    if (!ownedBySelfOrRoot) return false;
    if (!isDir) return true; // a non-directory component's own write bits do not gate "can it be replaced" -- that is the CONTAINING directory's mode, already checked the previous iteration
    const groupWritable = !!(st.mode & 0o020);
    const otherWritable = !!(st.mode & 0o002);
    const sticky = !!(st.mode & 0o1000);
    return !(groupWritable || otherWritable) || sticky;
  };
  const walk = (fullPath) => {
    const resolved = path.resolve(fullPath);
    const root = path.parse(resolved).root;
    const rel = path.relative(root, resolved);
    const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
    let cur = root;
    for (const part of parts) {
      cur = path.join(cur, part);
      let st;
      try { st = lstatFn(cur); } catch (e) { return 'could not lstat ' + cur + ': ' + (e && e.message); }
      const isDir = typeof st.isDirectory === 'function' ? st.isDirectory() : true;
      if (!isPrivateEntry(st, isDir)) return cur + ' is writable by another user (or not owned by the current user/root), with no sticky bit — refusing';
    }
    return null;
  };
  const lexicalFail = walk(targetPath);
  if (lexicalFail) return { ok: false, reason: lexicalFail };
  let real;
  try { real = realpathFn(targetPath); } catch (e) { return { ok: false, reason: 'could not resolve the real path: ' + (e && e.message) }; }
  if (path.resolve(targetPath) !== real) {
    const realFail = walk(real);
    if (realFail) return { ok: false, reason: realFail };
  }
  return { ok: true, reason: '' };
}
/** pruneSynthetic(opts) -> {runsDir, apply, candidates:[{name,eligible,reason,files}], removed:[], errors:[], refused?, reason?}
 *  DRY RUN by default (opts.apply falsy) — lists every candidate and its verdict, deletes nothing ever.
 *  Only with opts.apply:true does it delete, and only the candidates inspectSyntheticCandidate() marked
 *  eligible:true — one directory at a time, by unlinking its own already-verified files individually and
 *  then rmdir-ing the now-empty directory (never a recursive delete of anything that was not
 *  individually checked, so this can never remove more than what it just verified). opts.runsDir
 *  overrides the module-level RUNS_DIR for tests; the real CLI never passes it, so `/forge`'s own
 *  prune-synthetic always acts on THIS project only.
 *  PRUNE-1 fix (Codex adversarial-review, HIGH): refuses ENTIRELY (dry run and apply alike, `refused`
 *  set with a plain `reason`, `candidates` left empty) when the runs root itself — or any component
 *  between the trusted project root and it (`.claude`, `.claude/forge-runs`) — is a symlink/junction.
 *  See forgeRunsRootIsReal()'s own doc comment for why a per-candidate containment check alone cannot
 *  catch this: replacing forge-runs/ ITSELF with a junction redirects every path built from it
 *  consistently, so a containment check relative to the (already-redirected) runsDir sees perfect
 *  containment. `opts.root` overrides the anchor used for that root check (defaults to runsDir's own
 *  grandparent — `<root>/.claude/forge-runs` — so a test fixture using that same nesting needs no
 *  separate override).
 *  STOP-PRUNE-1 fix (Codex stop-time adversarial review, HIGH): on win32 (the real, deployed platform),
 *  each eligible candidate is now deleted through pinCandidateDirWindows()/verifyPinnedCandidate() (see
 *  their own doc comments) instead of a bare re-lstat-then-unlink — the pin's OS-enforced rename
 *  refusal is what actually closes the gap a re-check alone cannot: a swap happening AFTER the check but
 *  BEFORE the unlink calls. On any other platform, without an equivalent race-free primitive, --apply
 *  refuses a candidate outright unless posixChainIsPrivate() can prove no other user could interfere
 *  (see its own doc comment). opts.platform overrides process.platform and opts.posixSeams overrides
 *  posixChainIsPrivate()'s stat/uid functions — both test-only, so the POSIX branch's LOGIC is
 *  exercised deterministically even on a Windows development machine. */
function pruneSynthetic(opts) {
  opts = opts || {};
  const runsDir = opts.runsDir || RUNS_DIR;
  const platform = opts.platform || process.platform;
  const result = { runsDir, apply: !!opts.apply, candidates: [], removed: [], errors: [] };
  if (!exists(runsDir)) return result;
  const root = opts.root || path.dirname(path.dirname(runsDir));
  if (!forgeRunsRootIsReal(root)) {
    result.refused = true;
    result.reason = 'refusing: the runs directory (.claude or .claude/forge-runs) is a symlink/junction — cannot safely list or prune anything under it';
    return result;
  }
  let entries;
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return result; }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    if (!isReservedSyntheticRunId(d.name)) continue; // not a candidate at all — never listed, never touched
    const dir = path.join(runsDir, d.name);
    const verdict = inspectSyntheticCandidate(dir, d.name, runsDir);
    result.candidates.push({ name: d.name, eligible: verdict.eligible, reason: verdict.reason, files: verdict.files });
    if (!opts.apply || !verdict.eligible) continue;

    if (platform !== 'win32') {
      // STOP-PRUNE-1, non-Windows branch: no race-free delete primitive is available here at all —
      // refuse rather than trust a re-check that a swap could still slip past between check and use.
      const privacy = posixChainIsPrivate(dir, opts.posixSeams);
      if (!privacy.ok) {
        result.errors.push({ name: d.name, error: 'refusing on this platform without a race-free delete guarantee: ' + privacy.reason });
        continue;
      }
      try {
        const dirNow = statIdentity(fs.lstatSync(dir));
        if (!identityMatches(dirNow, verdict.identity.dir)) throw new Error('directory identity changed since inspection — refusing to delete');
        for (const f of verdict.files) {
          const fileNow = statIdentity(fs.lstatSync(path.join(dir, f)));
          if (!identityMatches(fileNow, verdict.identity.files[f])) throw new Error('file "' + f + '" identity changed since inspection — refusing to delete');
        }
        for (const f of verdict.files) fs.unlinkSync(path.join(dir, f));
        fs.rmdirSync(dir); // non-recursive: fails loudly if anything unverified is still inside
        result.removed.push(d.name);
      } catch (e) {
        result.errors.push({ name: d.name, error: e && e.message });
      }
      continue;
    }

    // STOP-PRUNE-1, Windows branch: pin -> re-verify everything -> (test seam) -> delete debris -> unpin -> rmdir.
    if (RUNINFO_TEST_HOOKS_ENABLED && typeof opts.__beforePin === 'function') opts.__beforePin(dir, verdict);
    const pin = pinCandidateDirWindows(dir);
    if (!pin.ok) {
      result.errors.push({ name: d.name, error: 'could not create a safety pin before deleting: ' + (pin.error && pin.error.message) });
      continue;
    }
    let pinClosed = false;
    const closePinOnce = () => { if (!pinClosed) { pinClosed = true; try { fs.closeSync(pin.fd); } catch { /* best-effort */ } } };
    try {
      const verify = verifyPinnedCandidate(pin, root, dir, verdict);
      if (!verify.ok) {
        // The pin may have landed somewhere unexpected (the chain no longer checks out) -- never delete
        // by path once the path can no longer be trusted; just release our own handle.
        closePinOnce();
        result.errors.push({ name: d.name, error: verify.reason });
        continue;
      }
      if (RUNINFO_TEST_HOOKS_ENABLED && typeof opts.__afterPinVerified === 'function') opts.__afterPinVerified(dir, pin);
      for (const f of verdict.files) fs.unlinkSync(path.join(dir, f));
      closePinOnce();
      fs.unlinkSync(pin.pinPath); // chain was verified real above -- safe to clean up by path now
      fs.rmdirSync(dir); // non-recursive: fails loudly if anything unverified is still inside
      result.removed.push(d.name);
    } catch (e) {
      closePinOnce();
      try { fs.unlinkSync(pin.pinPath); } catch { /* best-effort cleanup; never masks the real error below */ }
      result.errors.push({ name: d.name, error: e && e.message });
    }
  }
  return result;
}
function cmdPruneSynthetic(args) {
  const apply = args.includes('--apply');
  const rep = pruneSynthetic({ apply });
  if (rep.refused) { console.log(rep.reason); return; }
  if (!rep.candidates.length) {
    console.log('No synthetic-tool debris found under ' + RUNS_DIR + ' (nothing matches a reserved pattern: bench-canon*, bench-fake*, doctor-selfcheck*, nonexistent-run-id).');
    return;
  }
  console.log((apply ? 'Pruning' : 'DRY RUN (add --apply to actually delete)') + ' synthetic-tool debris under ' + RUNS_DIR + ':');
  for (const c of rep.candidates) {
    const mark = c.eligible ? (apply ? (rep.removed.includes(c.name) ? 'REMOVED ' : 'FAILED  ') : 'ELIGIBLE') : 'SKIPPED ';
    console.log('  [' + mark + ']  ' + c.name + '  — ' + c.reason);
  }
  console.log('');
  if (apply) {
    console.log(rep.removed.length + ' removed, ' + rep.errors.length + ' error(s).');
    for (const e of rep.errors) console.log('  ERROR  ' + e.name + ': ' + e.error);
  } else if (rep.candidates.some((c) => c.eligible)) {
    console.log('Re-run with --apply to actually delete the ELIGIBLE folder(s) above.');
  }
}

function printHelp() {
  console.log('Forge run info — usage: node forge-runinfo.cjs <status|runs|open-report|prune-synthetic>');
  console.log('  status              Command Center reachability, latest run, memory files');
  console.log('  runs                list project-local runs, newest first');
  console.log('  open-report         print the latest run\'s final-report.md');
  console.log('  prune-synthetic     list reserved-name tool-debris run folders (dry run)');
  console.log('  prune-synthetic --apply   actually delete the eligible debris folders listed above');
  console.log('The dashboard itself is the Forge Command Center: /forge dashboard, or see .claude/forge-dashboard/README.md');
}

async function main() {
  const cmd = process.argv[2] || '';
  if (cmd === 'status') { await cmdStatus(); return; }
  if (cmd === 'runs') { cmdRuns(); return; }
  if (cmd === 'open-report') { cmdOpenReport(); return; }
  if (cmd === 'prune-synthetic') { cmdPruneSynthetic(process.argv.slice(3)); return; }
  printHelp();
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('[forge-runinfo] error: ' + (e && e.message)); process.exit(1); });
}

module.exports = {
  classifyRunDir, orderRunRows, listRunIds, latestRunId, readRun,
  checkCommandCenterHealth, commandCenterStartHint, looksLikeCommandCenterHealth,
  // RUN-1 fix: exported so the symlink/containment behavior itself gets dedicated, hermetic fixture
  // tests, independent of this tool's own RUNS_DIR isolation guard (see forge-runinfo.test.cjs).
  isSymlinkEntry, realContainmentOk, safeReadContained,
  // RUN-1 fix, round 2 (Codex adversarial-review, HIGH) — the runs-ROOT-level real-path chain check.
  pathChainIsReal, forgeRunsRootIsReal, runsRootRefusalReason, statIdentity, identityMatches,
  // WP-CC0: prune-synthetic's own building blocks, exported so each layer (pattern match / per-folder
  // read-only inspection / the apply-or-not orchestrator) gets its own hermetic fixture tests.
  isReservedSyntheticRunId, SYNTHETIC_RUN_ID_PATTERNS, inspectSyntheticCandidate, pruneSynthetic,
  ALLOWED_SYNTHETIC_DEBRIS_FILES,
  // PRUNE-2 fix (Codex adversarial-review, MEDIUM) — the events.jsonl self-test content signature check.
  SYNTHETIC_DEBRIS_EVENT_SIGNATURES, MAX_SYNTHETIC_DEBRIS_EVENT_LINES, looksLikeSelfTestDebrisEvents,
  // STOP-PRUNE-1 fix (Codex stop-time adversarial review, HIGH) — the Windows exclusive-pin delete guard
  // and the non-Windows privacy-chain fallback, exported for dedicated hermetic tests of each layer.
  UV_FS_O_EXLOCK, pinCandidateDirWindows, verifyPinnedCandidate, posixChainIsPrivate,
  PROJECT_DIR, CLAUDE_DIR, RUNS_DIR, MEMORY_FILES, COMMAND_CENTER_URL, HEALTH_TIMEOUT_MS,
};
