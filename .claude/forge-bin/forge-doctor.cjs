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
 *
 * WAVE A / A2 (2026-07-18) — doctor COMPLETENESS checks. Originally all four were ADVISORY-ONLY
 * (report.advisory.completeness, never folded into the hard `ok` verdict — see backfillContinuity's doc
 * above for why a brand-new heuristic must never flip a healthy project's doctor run red the first time it
 * ships). V9-INTEGRATE (2026-07-22) promotes TWO of the four to ENFORCED (folded into `checks`/`ok`) — see
 * the "V9-INTEGRATE enforcement" note below for exactly which, and why each individual check was or was not
 * safe to promote:
 *   sync_completeness    — ADVISORY (unchanged). every real skill dir (skills/**\/SKILL.md) / forge-bin tool /
 *                           agent .md that exists on disk is present in forge-sync.cjs's FILES manifest
 *                           (listSystemFiles). NOT promoted: a new tool is routinely added to forge-bin/
 *                           before its SYSTEM[] pin is remembered in the SAME edit session — hard-blocking
 *                           every doctor run on that ordinary in-progress state would punish normal iterative
 *                           work, not just a genuine regression.
 *   check_the_checks      — ENFORCED (V9-INTEGRATE). a *.test.cjs suite that REPORTS a passing tally (per
 *                           runTests) but contains ZERO real assertion call sites in its own source is a
 *                           "green no-op": the tally cannot be genuine. Promoted: purely mechanical/static,
 *                           0 findings on this real project (see forge-doctor.test.cjs's static guard), and a
 *                           healthy project can never accidentally trip it — there is no code path that
 *                           creates a passing-but-assertion-free suite by ordinary means.
 *   memory_discipline     — ADVISORY (unchanged, deliberately — see WAVE A/A2 doc above). FORGE_MEMORY.md is
 *                           absent/empty, or still carries an unfilled placeholder marker
 *                           (<PLACEHOLDER>/<TODO>/TODO:/TBD/FIXME/etc). NOT promoted: a brand-new/freshly
 *                           cloned project legitimately has no memory yet — this is the canonical example of
 *                           a check that must stay advisory for a fresh project (see the plan's own framing).
 *   unregistered_event    — ENFORCED (V9-INTEGRATE). a forge-bin/*.cjs tool calls its local logEvent(...)
 *                           wrapper with a literal event_type string that is not registered in
 *                           log-event.cjs's KNOWN_EVENT_TYPES (+ cross-checked against forge-verify.cjs's own
 *                           TERMINAL_TYPES/BACKBONE mirror, when that module is available) — the 3-place
 *                           event-registration discipline the plan's invariant #6 requires. Static
 *                           best-effort scan of the logEvent(...) call convention only (see
 *                           extractLoggedEventTypes doc); a dynamically-built event_type argument can never
 *                           be resolved statically and is honestly skipped, not guessed. Promoted: purely
 *                           mechanical/static, 0 findings on this real project, and a genuinely NEW tool
 *                           always has a real registration step in the SAME wave that adds it (this very
 *                           piece is the proof) — a false-red here means a literal registration bug, not
 *                           ordinary project state.
 *   mcp_dormancy           — ADVISORY (unchanged). WAVE G / G-INTEGRATE (2026-07-19): the MCP-as-client
 *                           SAFETY DOCTRINE self-test — see mcpDormancy() below for the full contract. NOT
 *                           promoted: security-classification heuristics deserve a human review pass before
 *                           they can hard-block a build; kept conservative on purpose.
 *   run_contract          — NEW (V9-INTEGRATE), ADVISORY-ONLY. Wraps forge-runcontract.cjs::check() against
 *                           the MOST RECENT GENUINELY DISPATCHED run only (see runContractDoctorCheck() /
 *                           latestDispatchedRunIdFor() below) — never every historical run, and, as of V9
 *                           WAVE 2 (2026-07-22), never a "doctor-receipt-only" directory either (a dir this
 *                           same file's own `--run <id>` CLI flag creates: a doctor.json snapshot + one
 *                           synthetic doctor_run event, no run.json — that is a RECEIPT, not a dispatch, and
 *                           evaluating its non-negotiables was never meaningful). When no genuinely dispatched
 *                           run exists yet, this degrades honestly to a clean/neutral "no dispatched run to
 *                           check yet" rather than naming a receipt directory's missing rules. Explicitly NOT
 *                           enforced: FORGE_HARD_RULES.json's own `research-done` rule has ZERO historical
 *                           call sites (documented in that file's own _doc HONEST GAPS #1) — every
 *                           pre-existing dispatched run in this project would show it as genuinely missing, so
 *                           making this check blocking today would immediately red every doctor run in every
 *                           project that adopts it, which is exactly the false-red this plan says to avoid.
 *                           A future pass MAY promote it once research_done has real call sites.
 *   skill_evals            — NEW (wp-skill-evals, 2026-07-31), ADVISORY-ONLY. Wraps
 *                           forge-skill-evals.cjs::runAll() — the per-skill binary-evals FOUNDATION piece
 *                           (backlog item 1, YT-SWEEP-2026-07-31: per-skill evals.json + learnings.md).
 *                           A skill with no evals.json is simply not evaluated. NOT enforced: no
 *                           autonomous keep/revert loop exists yet (nightshift-gated, a later piece) — a
 *                           real failure here is a review signal today, not yet a build gate.
 *   skill_hygiene           — NEW (wp-disclosure-ab, 2026-07-31), ADVISORY-ONLY. Progressive-disclosure
 *                           hygiene on EVERY skill under .claude/skills/ that has a SKILL.md (no opt-in,
 *                           unlike skill_evals): frontmatter `description` present and <= 200 chars (the
 *                           wp3b budget law), whole-file line count <= 500 (this project's own file-size
 *                           guidance), and every ANCHORED path-shaped `` `backtick-code-span` `` reference
 *                           in the body resolves to a real file (see skillHygiene()/extractSkillPathRefs()
 *                           below for the exact, deliberately conservative extraction/anchor rules — no
 *                           false positives on ordinary prose). NOT enforced: same reasoning as skill_evals
 *                           — a real finding here (e.g. an over-long SKILL.md) is a review signal for the
 *                           Skill Boss today, not yet a build gate.
 *
 * "PAKKET 2" (2026-08-01) — one further ADVISORY-ONLY check, reported under its OWN top-level key
 * `report.advisory.run_liveness` (liveness is not completeness) with its own printSummary WARN line, exactly
 * like backfill_continuity:
 *   run_liveness  — ADVISORY. Wraps forge-runwatch.cjs::watch() over every run whose run.json CLAIMS to be
 *                   running, and reports each one the events prove is not alive (finished_but_open /
 *                   stalled / no_agent_activity / no_events), carrying runwatch's OWN terminal event lines
 *                   as evidence. This is what makes forge-runwatch run automatically instead of only on
 *                   request — see runLiveness()'s doc comment for the concrete 30+-hour failure it catches
 *                   and for why it uses a much wider silence window than runwatch's interactive default.
 *
 * CONTEXT BUDGET (2026-08-01) — one further ADVISORY-ONLY check under its own top-level key
 * `report.advisory.context_budget`, on the same footing as run_liveness:
 *   context_budget — ADVISORY. Wraps forge-contextbudget.cjs::measure() over the ALWAYS-LOADED instruction
 *                   chain (global CLAUDE.md, each of its @-includes, rules/ecc/common, the workspace and
 *                   project CLAUDE.md, and the name+description of every skill), compares each post against
 *                   a recorded baseline, and reports growth and dead @-includes. Two things make it
 *                   permanently advisory: its token figures are ESTIMATES (characters/4, no tokenizer runs
 *                   — the report says so in its own words), and most of what it counts lives OUTSIDE this
 *                   project root, where this codebase reads but never writes. Its printSummary line is the
 *                   only advisory printed on EVERY run rather than only on a finding, because the failure
 *                   being guarded is silent growth: a number nobody sees is the state that let the skill
 *                   list get truncated on 31 July with no warning at all.
 *
 * BEGINNER SETUP (wp17, 2026-09-24; wp-l1 added settings-wired; wp-l4 added model-choice-hint) — eight
 * ADVISORY-ONLY checks under their own top-level key `report.advisory.beginner_setup`, one printSummary line
 * each (see beginnerSetup() for the contract): claude-md-size · path-tools · bypass-mode · wsl-mnt-c ·
 * claude-doctor · prompt-coach-present · settings-wired · model-choice-hint.
 * They describe the MACHINE and the owner's preferences (a long CLAUDE.md, a missing `node`, a bypass default,
 * a WSL project under /mnt/c), never a defect in this project's code, so none can ever turn the doctor red.
 * model-choice-hint is the one exception to "describes the machine": it is pure education (theme 5 of the
 * beginner sweep, 52/98 videos — model choice, usage limits and cost had no beginner-facing surface at all),
 * always `info`, never evaluating anything about this project or machine.
 *
 * V9-INTEGRATE ENFORCEMENT OVERRIDE PATH (2026-07-22): a promoted-to-ENFORCED check's failure is recoverable
 * without editing code — config/orchestration/FORGE_HARD_RULES.json's `doctor_check_overrides` array (see
 * loadDoctorCheckOverrides() below) lets the owner log an explicit, reasoned, timestamped override for
 * `unregistered_event` or `check_the_checks` (or a future promoted check) that turns a genuine false-red back
 * into a visible-but-non-blocking PASS (never a silent one — see printSummary()'s `[OVERRIDDEN: ...]` tag).
 * This is the SAME file forge-runcontract.cjs's own per-run overrides already live in, reused rather than
 * inventing a second override mechanism.
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
// forge-sync.cjs / forge-verify.cjs are SOFT sibling dependencies too, for the same reason: sync_completeness
// and unregistered_event are ADVISORY, so a hermetic fixture that only ships forge-doctor.cjs + forge-store.cjs
// must degrade those two sub-checks honestly rather than crash the whole doctor run. Both modules guard their
// CLI body behind `require.main === module`, so requiring them here never triggers their CLI side effects.
let syncTool = null;
try { syncTool = require('./forge-sync.cjs'); } catch { syncTool = null; }
let verifyTool = null;
try { verifyTool = require('./forge-verify.cjs'); } catch { verifyTool = null; }
// V9-INTEGRATE (2026-07-22): forge-runcontract.cjs is a SOFT sibling dependency too, same reasoning as
// forge-sync.cjs/forge-verify.cjs above — run_contract is ADVISORY-ONLY, so a hermetic fixture that only
// ships forge-doctor.cjs + forge-store.cjs must degrade it honestly rather than crash the whole doctor run.
let runContractTool = null;
try { runContractTool = require('./forge-runcontract.cjs'); } catch { runContractTool = null; }
// wp-skill-evals (2026-07-31): forge-skill-evals.cjs is a SOFT sibling dependency too, same reasoning as
// syncTool/verifyTool/runContractTool above — skill_evals is ADVISORY-ONLY, so a hermetic fixture that
// only ships forge-doctor.cjs + forge-store.cjs must degrade it honestly rather than crash the whole
// doctor run.
let skillEvalsTool = null;
try { skillEvalsTool = require('./forge-skill-evals.cjs'); } catch { skillEvalsTool = null; }
// "pakket 2" (2026-08-01): forge-runwatch.cjs is a SOFT sibling dependency too, same reasoning as the four
// above — run_liveness is ADVISORY-ONLY. forge-runwatch is read-only and guards its CLI behind
// `require.main === module`, so requiring it here has no side effects.
let runwatchTool = null;
try { runwatchTool = require('./forge-runwatch.cjs'); } catch { runwatchTool = null; }
// 2026-08-01: forge-contextbudget.cjs is a SOFT sibling dependency on the same terms — context_budget is
// ADVISORY-ONLY and the meter is strictly read-only (it opens the always-loaded instruction chain, most of
// which lives OUTSIDE this project root, and never writes any of it — see that file's header on the
// project boundary). Its absence degrades to an honest "unavailable", never a doctor failure.
let contextBudgetTool = null;
try { contextBudgetTool = require('./forge-contextbudget.cjs'); } catch { contextBudgetTool = null; }

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
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'forge-runs', 'forge-backups', '.cache',
  // VENV/VENDOR CONTAINMENT (2026-08-03, gemeten op "aiTraining"): the gitless WALK crawled a Python
  // virtualenv (12.728 files) and flagged 16 third-party docstring URL-examples (fsspec/httpx/pandas/
  // pyarrow/urllib3) as url-embedded-credentials. A venv/site-packages tree is dependency territory
  // exactly like node_modules: third-party code we do not own. Fixed dir names here; arbitrary venv
  // names (.venv-train, …) are caught by the pyvenv.cfg marker check in isVenvDir() below.
  '.venv', 'venv', 'site-packages', '__pycache__', '.tox', '.mypy_cache', '.ruff_cache', '.pytest_cache']);
/** isVenvDir — definitive Python-venv detection by its marker file, so a venv is skipped whatever its
 *  directory name is (measured real case: `.venv-train`). Cheap: one existsSync per DIRECTORY walked. */
function isVenvDir(absDir) { return fs.existsSync(path.join(absDir, 'pyvenv.cfg')); }
// How deep below the project root a nested repository is still looked for. Four levels covers every real
// layout this project has met (`command-center/`, `apps/<x>/`, `packages/<x>/<y>/`) without turning repo
// discovery into a full-tree walk of a large monorepo.
const NESTED_REPO_MAX_DEPTH = 4;

/**
 * nestedGitRepos(root, maxDepth) -> ['command-center', ...] (root-relative, forward slashes, sorted)
 *
 * THE BLIND SPOT THIS EXISTS FOR (measured on this project, 2026-08-02, not assumed):
 *     git ls-files | wc -l                      -> 1298
 *     git ls-files | grep -c '^command-center/' ->    0
 * `command-center/` is its own git repository nested under the project root, so the outer index has never
 * heard of a single file in it. trackedFiles() sourced the entire leak scan from that one index, which
 * means the gateway that spawns the real `claude` CLI and the Discord integration that holds a live bot
 * token were never scanned once — while the doctor printed "1146 tracked files (git) · clean" and the sync
 * gate consumed that as coverage. A scan cannot honestly call a tree clean when it never opened it, and
 * nothing in the output distinguished "found nothing" from "looked at nothing". When that same tree was
 * later published as one repository, 9 findings appeared on the first scan.
 *
 * A directory counts as a nested repo when it contains a `.git` entry of ANY kind — a directory (ordinary
 * clone) or a file (worktree / submodule gitlink). Descent continues past a found repo so a doubly-nested
 * one is still discovered, and the ordinary heavy/vendor directories are skipped exactly as the walk
 * fallback below skips them. Never throws: an unreadable directory is simply not descended into.
 */
function nestedGitRepos(root, maxDepth) {
  const cap = Number.isFinite(maxDepth) ? maxDepth : NESTED_REPO_MAX_DEPTH;
  const found = [];
  (function walk(dir, depth, rel) {
    if (depth > cap) return;
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (!e.isDirectory() || WALK_SKIP_DIRS.has(e.name)) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      const childAbs = path.join(dir, e.name);
      if (isVenvDir(childAbs)) continue; // a venv is dependency territory — never a nested repo of ours
      if (fs.existsSync(path.join(childAbs, '.git'))) found.push(childRel);
      walk(childAbs, depth + 1, childRel);
    }
  })(root, 1, '');
  return found.sort();
}

/** gitLsFiles(dirAbs) -> string[] | null — the repo's own tracked-file list, or null when this is not a
 *  usable git repository. `git ls-files` is the only listing method used for a nested repo, deliberately:
 *  it lists TRACKED files and nothing else, so whatever that repo gitignores (its `.env`, its build output)
 *  is never opened, never scanned, and never even named as a path in the report. Widening the scan must not
 *  become a way to read files the repository itself declared out of bounds. */
function gitLsFiles(dirAbs) {
  const r = spawnSync('git', ['-C', dirAbs, 'ls-files'], { encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** trackedFiles(root) -> {source, files, sources}
 *  `sources` is the honest accounting the old single-number output could not give: one entry per repository
 *  that actually contributed, `{root, method, files}`, so "N tracked files" can never again mean "N files
 *  from however many of this tree's repositories we happened to notice". A source whose `git ls-files`
 *  fails is reported with `unavailable` rather than dropped — and is NOT walked as a consolation prize,
 *  because a walk would read exactly the ignored files the git listing exists to exclude.
 *  Nested discovery only applies when the ROOT itself is a git repo. When git is unavailable the walk
 *  fallback already covers the whole tree from the root down (including any nested repo's working files),
 *  and it is left byte-for-byte as it was. */
function trackedFiles(root) {
  const rootList = gitLsFiles(root);
  if (rootList) {
    const files = rootList.slice();
    const seen = new Set(rootList);
    const sources = [{ root: '.', method: 'git', files: rootList.length }];
    for (const relDir of nestedGitRepos(root, NESTED_REPO_MAX_DEPTH)) {
      const nested = gitLsFiles(path.join(root, relDir.split('/').join(path.sep)));
      if (nested === null) { sources.push({ root: relDir, method: 'git', files: 0, unavailable: 'git ls-files failed' }); continue; }
      let added = 0;
      for (const f of nested) {
        // de-duplicated on purpose: a nested repo's directory can also be tracked by the outer index (an
        // added submodule, a directory that gained its own .git later), and one file must not be scanned
        // twice nor counted twice in the totals.
        const rel = relDir + '/' + f;
        if (seen.has(rel)) continue;
        seen.add(rel); files.push(rel); added++;
      }
      sources.push({ root: relDir, method: 'git', files: added });
    }
    return { source: 'git', files, sources };
  }
  // fallback: bounded walk, skip the usual heavy/secret-bearing dirs (git absent). forge-runs + forge-backups
  // are Forge's OWN operational artifacts (run logs; backups of Forge's own system files, which include test
  // fixtures) — never the project source we scan for leaked credentials.
  const out = [];
  (function walk(dir, depth) {
    if (depth > 6) return; let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.isDirectory()) {
        const childAbs = path.join(dir, e.name);
        if (!WALK_SKIP_DIRS.has(e.name) && !isVenvDir(childAbs)) walk(childAbs, depth + 1);
        continue;
      }
      if (e.isFile()) out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  })(root, 0);
  return { source: 'walk', files: out, sources: [{ root: '.', method: 'walk', files: out.length }] };
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
// 2026-09-23 (external audit II-C): the four leak-scan hits the audit saw in `command-center/` were a STALE copy of
// that code in the distribution — the source had already rewritten those lines (a PEM header split across two
// literals, comments without the dashed marker). Measured after the sync: 0 hits with the set exactly as below,
// so the exemption surface was deliberately NOT widened to a third file.
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
// "test fixtures legitimately hold fake secrets" — a rule this scan has always had. Its implementation was
// /\.test\.[cm]?js$/i, i.e. JavaScript-only, and nothing about the rule was ever meant to be: a
// `chat.test.ts` holds fake credentials for exactly the same reason a `chat.test.cjs` does. The gap stayed
// invisible only because this project's one TypeScript tree (command-center/dashboard) sat inside the
// nested-repo blind spot fixed above — widening the scan surfaced 4 cry-wolf hits on *.test.ts / *.test.tsx
// in the first run. Deliberately kept to the SAME rule rather than a broader one: only the `.test.`
// infix before a JS/TS extension, so `real-source.ts` is still scanned and a file merely named
// `latest.ts` or `contest.js` is untouched. The trade-off (a genuine secret hidden in a file named
// `*.test.ts` is missed) is not new — it is the pre-existing, deliberate trade-off of the JS rule, now
// applied consistently instead of by accident of file extension.
const TEST_FIXTURE_RE = /\.test\.(?:[cm]?jsx?|[cm]?tsx?)$/i;
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
  const { source, files, sources } = trackedFiles(root);
  const hits = []; const skipped = []; let scanned = 0;
  for (const rel of files) {
    if (rel.endsWith('.env.example')) continue;                       // placeholders expected
    if (TEST_FIXTURE_RE.test(rel)) continue;                          // test fixtures legitimately hold fake secrets
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
  return { source, sources, scanned, skipped, ok: hits.length === 0, hits };
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

// ===========================================================================================================
// WAVE A / A2 (2026-07-18) — doctor completeness checks. All four are ADVISORY-ONLY (see the header doc
// comment above for why); each function below is a pure `(root) -> {ok, ...}` reader, mirroring the shape of
// every other check in this file, so they compose the same way in runDoctor()/printSummary().
// ===========================================================================================================

// --- sync-completeness: every real skill dir / forge-bin tool / agent .md is present in the forge-sync.cjs
// FILES manifest (listSystemFiles). forge-bin tools and agent .md files are DYNAMICALLY globbed by
// forge-sync's SYSTEM_GLOB (any file currently on disk is, by construction, already covered) — re-checked
// here anyway as an honest regression guard in case a future SYSTEM_GLOB narrowing ever drops coverage.
// skills/**/SKILL.md is NOT auto-globbed (each path must be added to forge-sync's SYSTEM[] by hand) — this is
// the real, evidence-proven drift surface (the "forge-router silent-drift bug" the plan's invariant #1 cites).
function listSkillFiles(root) {
  const base = path.join(claudeDir(root), 'skills');
  const cd = claudeDir(root);
  const out = [];
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === 'SKILL.md') out.push(path.relative(cd, p).split(path.sep).join('/'));
    }
  })(base);
  return out.sort();
}
function syncCompleteness(root) {
  if (!syncTool) return { ok: false, reason: 'forge-sync.cjs module not available (sync-completeness unavailable)', missing: [] };
  const cd = claudeDir(root);
  let manifestList;
  try { manifestList = syncTool.listSystemFiles(cd); } catch (e) { return { ok: false, reason: 'forge-sync.listSystemFiles threw: ' + e.message, missing: [] }; }
  const manifestSet = new Set(manifestList.map((r) => r.split(path.sep).join('/')));
  const skillFiles = listSkillFiles(root);
  const binFiles = listByExt(path.join(cd, 'forge-bin'), ['.cjs', '.ps1', '.cmd', '.sh', '.md', '.bat']).map((p) => 'forge-bin/' + path.basename(p));
  const agentFiles = listByExt(path.join(cd, 'agents'), ['.md']).map((p) => 'agents/' + path.basename(p));
  const missing = [];
  for (const rel of skillFiles) if (!manifestSet.has(rel)) missing.push(rel);
  for (const rel of binFiles) if (!manifestSet.has(rel)) missing.push(rel);
  for (const rel of agentFiles) if (!manifestSet.has(rel)) missing.push(rel);
  return { ok: missing.length === 0, checkedSkills: skillFiles.length, checkedBinTools: binFiles.length, checkedAgents: agentFiles.length, missing };
}

// --- check-the-checks: detect a "green no-op" — a *.test.cjs suite that runTests() reports as passing
// (passed > 0) but that contains ZERO real assertion call sites in its own source. Matches this codebase's two
// real local-helper conventions (`t('name', ...)` and `test('name', ...)`) plus direct `assert(...)`/
// `assert.foo(...)` calls, so it stays accurate across every existing suite regardless of which convention it
// uses (proven against all 51 real forge-bin/*.test.cjs suites at build time — every one has >=1 site).
const ASSERTION_SITE_RE = /\b(t|test)\s*\(\s*['"`]|\bassert(\.[A-Za-z]+)?\s*\(/g;
function countAssertionSites(text) {
  let n = 0, m; ASSERTION_SITE_RE.lastIndex = 0;
  while ((m = ASSERTION_SITE_RE.exec(text)) !== null) n++;
  return n;
}
function checkTheChecks(root, testsResult) {
  const dir = path.join(claudeDir(root), 'forge-bin');
  const files = listByExt(dir, ['.cjs']).filter((f) => f.endsWith('.test.cjs'));
  const perSuite = (testsResult && Array.isArray(testsResult.perSuite)) ? testsResult.perSuite : [];
  const noOp = [];
  for (const f of files) {
    const base = path.basename(f);
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (countAssertionSites(text) > 0) continue; // has real assertion call sites -> not a no-op
    const suiteResult = perSuite.find((s) => s.suite === base);
    // Only flag when the suite ALSO reported a passing tally (passed>0) with zero real assertion sites — that
    // exact combination means the printed tally cannot be genuine. A 0-assertion suite that also reports 0
    // passed is already caught honestly by runTests' own vacuous-tally rejection (suiteOk=false) — not a NEW
    // finding here, so it is intentionally not double-flagged.
    if (suiteResult && suiteResult.passed > 0) {
      noOp.push({ suite: base, passed: suiteResult.passed, reason: 'reports a passing tally but has 0 real assertion call sites (t(...)/test(...)/assert(...)) in its source — the tally cannot be genuine' });
    }
  }
  return { ok: noOp.length === 0, checked: files.length, noOp };
}

// --- memory-discipline: FORGE_MEMORY.md is absent/empty, or still carries an unfilled scaffold-placeholder
// marker. Deliberately narrow (angle-bracket ALL-CAPS/underscore tokens + explicit TODO/TBD/FIXME markers)
// so it never false-positives on ordinary lowercase prose placeholders this project's real memory legitimately
// uses (e.g. "<boss>" as a variable reference in a sentence) — proven clean against the real FORGE_MEMORY.md.
const MEMORY_PLACEHOLDER_RE = /<PLACEHOLDER>|<TODO>|<TBD>|<FILL[_ ]IN>|<[A-Z][A-Z0-9]*(_[A-Z0-9]+)+>|\[TODO\]|\[TBD\]|\bTODO:|\bFIXME\b|\bTBD\b/;
function memoryDiscipline(root) {
  const file = path.join(claudeDir(root), 'FORGE_MEMORY.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return { ok: false, present: false, reason: 'FORGE_MEMORY.md is absent (expected at .claude/FORGE_MEMORY.md)', placeholderLines: [] }; }
  if (!text.trim()) return { ok: false, present: true, reason: 'FORGE_MEMORY.md exists but is empty', placeholderLines: [] };
  const placeholderLines = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (MEMORY_PLACEHOLDER_RE.test(lines[i])) placeholderLines.push(i + 1);
  return { ok: placeholderLines.length === 0, present: true, reason: placeholderLines.length ? placeholderLines.length + ' unfilled placeholder line(s)' : '', placeholderLines };
}

// --- unregistered-event: a forge-bin/*.cjs tool's local logEvent(...) wrapper is called with a literal
// event_type string that log-event.cjs's KNOWN_EVENT_TYPES does not recognize (it would be STRICT-REJECTED,
// exit 2, at write time — see strictEventCheck above). Cross-checked against forge-verify.cjs's own
// TERMINAL_TYPES/BACKBONE mirror too, per the plan's 3-place event-registration discipline.
/** stripJsComments(text) -> the same source with // line comments and block comments removed.
 *  String-literal aware, single left-to-right pass: while inside a quoted string a `//` or a block-comment
 *  opener is just text, and while inside a comment a quote character is just text. That statefulness is the
 *  whole point — the naive stateless literal regex below cannot tell the two apart, which is exactly how an
 *  APOSTROPHE in comment prose used to flip quote parity and hide every event type after it (see
 *  extractKnownEventTypesFromSource). Same idea forge-event-wiring.test.cjs already applies before reading
 *  app.js's taskStatus() buckets, generalized here to trailing and block comments as well.
 *  Newlines are preserved (line structure stays intact); a block comment collapses to a single space so it
 *  can never weld two tokens together. Not a JS parser: a `/` that starts a regex literal is out of scope,
 *  which is fine for the string-literal lists this is used on. */
function stripJsComments(text) {
  let out = '';
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;   // the '\n' itself is kept by the default branch
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        if (text[i] === '\\') { out += text[i] + (text[i + 1] || ''); i += 2; continue; }
        out += text[i];
        const closed = text[i] === quote;
        i++;
        if (closed) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
/** extractKnownEventTypesFromSource(text) -> Set of the event types log-event.cjs really registers.
 *  Comments are stripped from the WHOLE source FIRST — before the Set literal is located and before any
 *  string literal is read — so neither the locating regex nor the literal scan can be steered by comment
 *  prose. Measured on this project's real log-event.cjs when the strip was missing (2026-08-01): 186 types
 *  registered, 175 seen, 20 real types silently invisible to the ENFORCED unregistered_event gate, and 9
 *  junk "types" invented out of comment text. */
function extractKnownEventTypesFromSource(text) {
  const m = stripJsComments(text).match(/KNOWN_EVENT_TYPES\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!m) return null;
  const out = new Set();
  const re = /'([^']+)'|"([^"]+)"/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) out.add(mm[1] || mm[2]);
  return out;
}
const EVENT_TYPE_SHAPE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/; // snake_case, matches KNOWN_EVENT_TYPES' own naming convention
/** extractLoggedEventTypes — for every `logEvent(` call site, reads only the argument text BEFORE the call's
 *  object-literal payload (its first `{`) — every real logEvent() wrapper in this codebase places the literal
 *  event_type string there, whether as the 1st positional arg (forge-paperclip.cjs's `logEvent(type, obj)`) or
 *  the 2nd/3rd (forge-artifact.cjs/forge-deeplearn.cjs/forge-mindmap.cjs/forge-prd.cjs/forge-registry.cjs's
 *  `logEvent(runId, eventType, extra)`). This avoids ever matching an unrelated string INSIDE the payload
 *  object (a `note`/`evidence` value). A dynamically-built event_type (e.g. `ev.event_type`, a variable) has
 *  no quoted literal to find and is honestly skipped — never guessed. Best-effort static scan only; it does
 *  not attempt to resolve every possible spawnSync/execFileSync call shape in the codebase. */
function extractLoggedEventTypes(text) {
  const out = new Set();
  const callRe = /\blogEvent\s*\(/g;
  let cm;
  while ((cm = callRe.exec(text)) !== null) {
    const start = cm.index + cm[0].length;
    let depth = 1, i = start, braceIdx = -1;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '{' && braceIdx === -1) braceIdx = i;
    }
    const argsPrefix = text.slice(start, braceIdx !== -1 ? braceIdx : i);
    const litRe = /'([^']*)'|"([^"]*)"/g;
    let lm;
    while ((lm = litRe.exec(argsPrefix)) !== null) {
      const lit = lm[1] !== undefined ? lm[1] : lm[2];
      if (EVENT_TYPE_SHAPE_RE.test(lit)) out.add(lit);
    }
  }
  return out;
}
function unregisteredEvent(root) {
  const logEventPath = path.join(claudeDir(root), 'forge-dashboard', 'log-event.cjs');
  let leText;
  try { leText = fs.readFileSync(logEventPath, 'utf8'); }
  catch (e) { return { ok: false, reason: 'could not read log-event.cjs: ' + e.message, unregistered: [] }; }
  const known = extractKnownEventTypesFromSource(leText);
  if (!known) return { ok: false, reason: 'could not statically parse KNOWN_EVENT_TYPES from log-event.cjs', unregistered: [] };
  const verifySet = new Set();
  if (verifyTool) {
    try {
      for (const t of verifyTool.TERMINAL_TYPES || []) verifySet.add(t);
      for (const t of verifyTool.BACKBONE || []) verifySet.add(t);
    } catch { /* best effort — verify cross-check stays empty */ }
  }
  const dir = path.join(claudeDir(root), 'forge-bin');
  const files = listByExt(dir, ['.cjs']).filter((f) => !f.endsWith('.test.cjs'));
  const unregistered = [];
  for (const f of files) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const type of extractLoggedEventTypes(text)) {
      if (known.has(type)) continue;
      const missingFrom = ['log-event.KNOWN_EVENT_TYPES'];
      if (verifyTool && !verifySet.has(type)) missingFrom.push('forge-verify.allow-list');
      unregistered.push({ file: path.relative(root, f).split(path.sep).join('/'), event_type: type, missingFrom });
    }
  }
  return { ok: unregistered.length === 0, checkedFiles: files.length, unregistered };
}

// --- mcp-dormancy (WAVE G / G-INTEGRATE, 2026-07-19): the MCP-as-client SAFETY DOCTRINE self-test.
// Reads config/orchestration/mcp-registry.json + mcp-grants.json (+ an owner-authored real `.mcp.json` MCP
// host config at the project root, if one exists — NOT config/mcp/.mcp.json.example, which is a reference
// template, never live config) and asserts, purely by reading JSON (never by requiring forge-mcp-gate.cjs,
// so a malformed/adversarial fixture can be reported as a finding instead of crashing the whole doctor run):
//   (a) no registry server is status:"active"/active:true without being listed in mcp-opt-in.json's
//       opted_in[] (the owner-authored dormancy marker), and no server configured in a real `.mcp.json`
//       host file is missing from that same opt-in list;
//   (b) no boss's mcp-grants.json allow_servers entry exceeds that boss's own declared max_tier, and no
//       allow_servers entry references a server id absent from the registry;
//   (c) no boss's allow_servers ever contains a tier-3 (WRITE-PRIMITIVE) server — tier-3 must never be a
//       standing/default grant, regardless of the boss's numeric max_tier (doctrine #3/#4).
// ADVISORY-ONLY (folded into report.advisory.completeness, same discipline as the other 4 WAVE A/A2 checks
// above) — a brand-new heuristic must never flip a healthy project's doctor run red the first time it ships.
function mcpDormancy(root, opts) {
  opts = opts || {};
  const cd = claudeDir(root);
  const registryPath = opts.registryPath || path.join(cd, 'config', 'orchestration', 'mcp-registry.json');
  const grantsPath = opts.grantsPath || path.join(cd, 'config', 'orchestration', 'mcp-grants.json');
  const optInPath = opts.optInPath || path.join(cd, 'config', 'orchestration', 'mcp-opt-in.json');
  const mcpJsonPath = opts.mcpJsonPath || path.join(root, '.mcp.json'); // real owner-authored MCP host config — NOT the .example template

  let registry;
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); }
  catch (e) { return { ok: false, reason: 'could not read/parse mcp-registry.json: ' + e.message, violations: [] }; }
  if (!registry || !Array.isArray(registry.servers)) return { ok: false, reason: 'mcp-registry.json has no "servers" array', violations: [] };

  let grants;
  try { grants = JSON.parse(fs.readFileSync(grantsPath, 'utf8')); }
  catch (e) { return { ok: false, reason: 'could not read/parse mcp-grants.json: ' + e.message, violations: [] }; }
  if (!grants || !grants.bosses || typeof grants.bosses !== 'object') return { ok: false, reason: 'mcp-grants.json has no "bosses" object', violations: [] };

  let optIn = { opted_in: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(optInPath, 'utf8'));
    if (parsed && Array.isArray(parsed.opted_in)) optIn = parsed;
  } catch { /* missing/malformed opt-in file -> dormant default; the forge-mcp-gate live path hard-errors on a MALFORMED (not missing) file, but this advisory reader stays lenient by design */ }
  const optedIn = new Set(optIn.opted_in);

  const violations = [];

  // (a) no server auto-active without an explicit opt-in marker
  for (const s of registry.servers) {
    if (!s || typeof s.id !== 'string') continue;
    const autoActive = s.status === 'active' || s.active === true;
    if (autoActive && !optedIn.has(s.id)) {
      violations.push({ type: 'auto_active_without_optin', server: s.id, detail: 'registry entry is active/auto-active but "' + s.id + '" is not listed in mcp-opt-in.json opted_in[]' });
    }
  }
  let mcpJson = null;
  try { mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')); } catch { mcpJson = null; }
  if (mcpJson && mcpJson.mcpServers && typeof mcpJson.mcpServers === 'object') {
    for (const id of Object.keys(mcpJson.mcpServers)) {
      if (!optedIn.has(id)) violations.push({ type: 'mcp_json_server_without_optin', server: id, detail: 'a real .mcp.json configures server "' + id + '" but it is not listed in mcp-opt-in.json opted_in[]' });
    }
  }

  // (a2) REGISTRY DRIFT (2026-08-04). The check above only ever read `.mcp.json`, which is exactly one of
  // the places Claude Code takes MCP servers from — so servers enabled through `.claude/settings.local.json`
  // (`enabledMcpjsonServers`) or `~/.claude.json` (global `mcpServers`) were invisible here. Measured on this
  // machine: claude-flow (≈400 tools, incl. terminal_execute/http_fetch) and n8n were connected and in NO
  // registry entry, so no tier and no per-Boss grant governed them — the tier-3 write gate hardened the day
  // before applied only to servers that do not exist here. forge-mcp-gate.unregisteredServers() reads every
  // real source; this stays ADVISORY and never auto-adds anything: inventing a tier for someone else's
  // server would be the same fabricated authority the doctrine exists to prevent.
  // Scope: the REAL machine only. Discovery reads machine-global sources (~/.claude.json,
  // ~/.claude/settings.json) that exist regardless of which root is being checked, so running it against
  // a hermetic fixture registry would report the machine's own servers as "missing" from a fixture — a
  // finding about nothing. A caller that supplies its own registryPath is by definition testing the
  // dormancy LOGIC on a fixture; drift is about reality, so it is checked only on the real config.
  const isOwnProject = path.resolve(root) === path.resolve(__dirname, '..', '..');

  // (a3) WAS THE GATE EVER REACHED? (broad Codex audit #1, wired 2026-08-05.) forge-mcp-gate enforces
  // tiers, allow-lists and owner-verified tier-3 writes — but it is a library nobody must call, and
  // `mcp_grant_validated` had ZERO occurrences across every run: the same shape as the run-contract gate,
  // which existed and was tested for months while never once being evaluated. Forge cannot hook Claude
  // Code's tool dispatcher, so this cross-references the PostToolUse tool ledger (which records every
  // `mcp__*` call) against the gate's own decisions. A quiet machine reports "nothing to gate" — never
  // "the gate works".
  try {
    const usage = require('./forge-mcp-usage.cjs');
    const u = usage.check({ root });
    if (u && u.ok === false) {
      violations.push({ type: 'mcp_tool_used_without_gate', detail: u.reason, tools: (u.ungated || []).map((t) => t.tool + ' x' + t.count) });
    }
  } catch { /* sibling tool unavailable -> sub-check not run; never a fabricated all-clear */ }
  try {
    const gate = isOwnProject ? require('./forge-mcp-gate.cjs') : null;
    if (gate && typeof gate.unregisteredServers === 'function') {
      const drift = gate.unregisteredServers({ registryPath, projectRoot: root, homeDir: opts.homeDir });
      for (const u of (drift.unregistered || [])) {
        violations.push({
          type: 'configured_server_not_in_registry', server: u.id, sources: u.sources,
          detail: 'MCP server "' + u.id + '" is configured on this machine (' + u.sources.join(', ') + ') but is absent from mcp-registry.json — it is governed by no tier and no per-Boss grant',
        });
      }
    }
  } catch { /* sibling tool unavailable -> this sub-check is simply not run; never a fabricated all-clear */ }

  // (b)+(c) per-boss grant self-consistency
  const serverById = new Map(registry.servers.filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
  for (const [bossId, g] of Object.entries(grants.bosses)) {
    if (!g || typeof g.max_tier !== 'number' || !Array.isArray(g.allow_servers)) {
      violations.push({ type: 'malformed_grant', boss: bossId, detail: 'grant entry missing max_tier/allow_servers' });
      continue;
    }
    for (const serverId of g.allow_servers) {
      const entry = serverById.get(serverId);
      if (!entry) { violations.push({ type: 'unknown_server_in_grant', boss: bossId, server: serverId, detail: 'grant references a server id not present in mcp-registry.json' }); continue; }
      // Type-normalize the registry tier before comparing. A poisoned config (tier as a string like '3',
      // a float, out-of-range, or missing) must NOT slip past these guards — the enforcement gate
      // (forge-mcp-gate.loadRegistry) hard-rejects a non-number tier, and this advisory check is deliberately
      // decoupled from it, so it must replicate that validation itself rather than trust the JSON shape.
      // (Found by the Wave-G break-swarm: `tier:'3'` defeated the strict `=== 3` / `> max_tier` guards.)
      const t = (typeof entry.tier === 'number') ? entry.tier
        : (typeof entry.tier === 'string' && /^\d+$/.test(entry.tier.trim()) ? Number(entry.tier.trim()) : NaN);
      if (!Number.isInteger(t) || t < 0 || t > 3) { violations.push({ type: 'malformed_server_tier', boss: bossId, server: serverId, tier: entry.tier, detail: 'server tier is not an integer 0-3 (poisoned/invalid registry entry) — treated as a violation, never all-clear' }); continue; }
      if (t === 3) { violations.push({ type: 'tier3_default_grant', boss: bossId, server: serverId, detail: 'tier-3 write-primitive must never be a standing/default grant (doctrine #3/#4)' }); continue; }
      if (t > g.max_tier) { violations.push({ type: 'grant_exceeds_max_tier', boss: bossId, server: serverId, tier: t, max_tier: g.max_tier, detail: 'server tier exceeds this boss\'s declared max_tier' }); }
    }
  }

  return { ok: violations.length === 0, checkedServers: registry.servers.length, checkedBosses: Object.keys(grants.bosses).length, violations };
}

// ===========================================================================================================
// V9-INTEGRATE (2026-07-22) — run-contract wiring + the doctor_check_overrides recovery path. See the header
// doc comment ("V9-INTEGRATE ENFORCEMENT OVERRIDE PATH") for the full model.
// ===========================================================================================================

/** rankRunCandidates(root, opts) -> [{name, mtimeMs}, ...] sorted newest-first. Shared ranking core behind
 *  BOTH latestRunIdFor() and latestDispatchedRunIdFor() below — one recency algorithm, never two that could
 *  silently drift apart. Ranks by REAL recency: the latest of (a) events.jsonl's own mtime — the truest
 *  "last real activity" signal, updated on every real event append — (b) run.json's mtime, and (c) the run
 *  directory's own mtime, taking the max of whichever of these exist. Name is only a TIE-BREAK (descending)
 *  for the vanishingly-rare case of two runs with an identical mtime down to the millisecond.
 *  opts.requireDispatched:true (V9 WAVE 2, 2026-07-22 — forge-audit-loop's own doctor-receipt-vs-real-run
 *  gap) additionally requires a REAL, parseable run.json object — a "doctor-receipt-only" directory (created
 *  solely by this file's own `--run <id>` CLI flag: a doctor.json snapshot + a single synthetic doctor_run
 *  event in events.jsonl, but NO run.json at all — see this file's own CLI body below) is never mistaken for
 *  a genuine DISPATCHED Forge run, which always has a real run.json written by the orchestration layer.
 *  Without opts.requireDispatched, behavior is byte-for-byte the original "any real run dir" filter (must
 *  have a real run.json OR events.jsonl) — unchanged. */
/** lastEventTimeMs(file) -> ms sinds epoch van het LAATSTE parseerbare event, of 0.
 *  Leest alleen de staart (8 KiB): de rangschikking mag niet duurder worden naarmate een run groeit, en
 *  het laatste event staat per definitie achteraan. Een half afgeknotte eerste regel in dat venster
 *  parseert simpelweg niet en wordt overgeslagen — daarom van achter naar voren. */
function lastEventTimeMs(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 0; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return 0;
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        const t = Date.parse(o && o.timestamp);
        if (Number.isFinite(t)) return t;
      } catch { /* afgeknotte of corrupte regel — probeer de vorige */ }
    }
    return 0;
  } catch { return 0; }
  finally { try { fs.closeSync(fd); } catch { } }
}

function rankRunCandidates(root, opts) {
  opts = opts || {};
  const dir = path.join(claudeDir(root), 'forge-runs');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const runDir = path.join(dir, e.name);
    const eventsPath = path.join(runDir, 'events.jsonl');
    const runJsonPath = path.join(runDir, 'run.json');
    const hasEvents = fs.existsSync(eventsPath);
    const hasRunJson = fs.existsSync(runJsonPath);
    if (opts.requireDispatched) {
      let parsedRunJson = null;
      if (hasRunJson) { try { parsedRunJson = JSON.parse(fs.readFileSync(runJsonPath, 'utf8')); } catch { parsedRunJson = null; } }
      if (!parsedRunJson || typeof parsedRunJson !== 'object' || Array.isArray(parsedRunJson)) continue; // no real run.json -> not a genuine dispatched run
    } else if (!hasEvents && !hasRunJson) {
      continue; // not a real Forge run dir at all — never a pickable candidate
    }
    let mtimeMs = 0;
    try {
      if (hasEvents) mtimeMs = Math.max(mtimeMs, fs.statSync(eventsPath).mtimeMs);
      if (hasRunJson) mtimeMs = Math.max(mtimeMs, fs.statSync(runJsonPath).mtimeMs);
      mtimeMs = Math.max(mtimeMs, fs.statSync(runDir).mtimeMs);
    } catch { /* a stat race on an individual file never disqualifies the candidate — 0/partial mtime is still real evidence */ }
    /** REGRESSIE 2026-08-09: rangschikken op mtime laat ELKE metadata-write de geschiedenis herordenen.
     *  forge-finalize's markRunFinalized() herschreef de run.json van een oude, groene run; die ene
     *  aanraking maakte hem "laatste dispatched run", waardoor de doctor "run contract satisfied" meldde
     *  terwijl de ECHT actieve run nog 5 verplichte regels miste — een reëel gat, onzichtbaar gemaakt door
     *  boekhouding. forge-snapshot.cjs leerde dit al op 2026-08-01 en herrangschikte in zijn EIGEN code;
     *  de gedeelde kern hield het gebrek, dus de volgende aanroeper erfde het. Daarom hier, één keer:
     *  recentheid van een RUN is de recentheid van zijn WERK. Eventtijden worden één keer geschreven en
     *  nooit herschreven; mtimes wel. Zonder eventlog blijft de mtime de eerlijke terugval. */
    const activityMs = hasEvents ? lastEventTimeMs(eventsPath) : 0;
    candidates.push({ name: e.name, mtimeMs, activityMs, rankMs: activityMs || mtimeMs });
  }
  candidates.sort((a, b) => (b.rankMs - a.rankMs) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return candidates;
}
/** latestRunIdFor — the single most-recent run id under <root>/.claude/forge-runs/, ANY real run directory
 *  (a run.json OR an events.jsonl is enough — this is the general-purpose "most recently touched run"
 *  picker; see latestDispatchedRunIdFor() below for the stricter "genuinely dispatched" variant used by
 *  runContractDoctorCheck()). V9-fix (2026-07-22 — break-swarm DEFECT 4): the OLD implementation picked
 *  "latest" by a plain lexical name sort — a clean decoy run whose directory name simply sorts higher (e.g.
 *  "zzz-decoy") masked a genuinely NEWER, real-violating run whose name happens to sort lower. Now ranks by
 *  REAL recency via rankRunCandidates() — see that function's doc for the exact algorithm. null when no real
 *  run directories exist yet (a fresh project) or the directory can't be read — never thrown. */
function latestRunIdFor(root) {
  const candidates = rankRunCandidates(root, {});
  return candidates.length ? candidates[0].name : null;
}
/** latestDispatchedRunIdFor — V9 WAVE 2 (2026-07-22, forge-audit-loop's own honest-realization pass): the
 *  most-recent run id that carries a REAL, parseable run.json — i.e. a genuinely DISPATCHED Forge run, never
 *  a "doctor-receipt-only" directory (see rankRunCandidates()'s opts.requireDispatched doc above). Used by
 *  runContractDoctorCheck() below so its advisory never mistakes `forge-doctor --run <id>`'s own receipt
 *  directory (created by THIS file's CLI body — doctor.json + one synthetic doctor_run event, no run.json)
 *  for a real dispatched run whose non-negotiables are worth evaluating. null when no genuinely dispatched
 *  run exists yet under forge-runs/ (a fresh project, or a project where every run so far is receipt-only) —
 *  never thrown. */
function latestDispatchedRunIdFor(root) {
  const candidates = rankRunCandidates(root, { requireDispatched: true });
  return candidates.length ? candidates[0].name : null;
}
/** runContractDoctorCheck — ADVISORY-ONLY (see header doc). Evaluates forge-runcontract.cjs::check() against
 *  ONLY the most recent GENUINELY DISPATCHED run (latestDispatchedRunIdFor() — V9 WAVE 2, 2026-07-22: never a
 *  doctor-receipt-only directory, see that function's doc above), never every historical run (which would
 *  just re-surface the same documented gap — research-done has no historical call sites — hundreds of times
 *  over) and never a receipt-only directory this same file's own `--run` CLI flag creates. When there is no
 *  genuinely dispatched run at all yet (a fresh project, or a project where forge-doctor has only ever been
 *  run in receipt mode), this degrades honestly to a clean/neutral "no dispatched run to check yet" —
 *  never fabricates a "rules missing" verdict against a directory that was never a real dispatch. domain is
 *  read best-effort from that run's own run.json (`domain` field if present, else the free-text
 *  `project_type` — forge-runcontract.cjs's ruleApplies() degrades a domain it doesn't recognize to "no
 *  domain-scoped rule applies", never a fabricated match). */
/** qualityCatalogDoctorCheck — ADVISORY. De domeincatalogus is de ENE verwachting; vier seams (router-
 *  playbooks, required-evidence, intake-packs, domain-presets) zijn de werkelijkheid. Elke afwijking is
 *  drift die hier zichtbaar wordt; tracked gaps (dashboard, tooling/meta) blijven benoemd, nooit stil.
 *  Degradeert eerlijk wanneer de quality-module ontbreekt (kale installatie zonder Quality-laag). */
function qualityCatalogDoctorCheck(root) {
  let Q = null;
  try { Q = require(path.join(claudeDir(root), 'forge-bin', 'forge-quality.cjs')); } catch { }
  /** F-09 (Codex batch-1-review): 'module ontbreekt' was ok:true — maar de sync-manifest SHIPT deze
   *  module, dus afwezigheid is een echte installatiefout, geen optionele feature. Fail-closed. */
  if (!Q || typeof Q.catalogDrift !== 'function') return { ok: false, reason: 'forge-quality.cjs ontbreekt of laadt niet, terwijl de sync-manifest hem verwacht — de installatie is incompleet' };
  try {
    const d = Q.catalogDrift(root);
    /** F-29 (Codex eindreview): het eindoordeel telt VIER afwijkingsvelden mee (missing, extra,
     *  not_expected, stale_tracked) maar de reason noemde er maar twee — drift door een verouderde
     *  tracked gap of een onverwachte preset gaf ok:false met een LEGE reden, dus geen
     *  herstelrichting. Alle vier velden dragen nu bij aan de probleemselectie en de reden. */
    const problemen = d.seams.filter((s2) => (s2.missing_in_seam || []).length || (s2.extra_in_seam || []).length || (s2.not_expected || []).length || (s2.stale_tracked || []).length);
    const beschrijf = (s2) => {
      const delen = [];
      if ((s2.missing_in_seam || []).length) delen.push('missing=' + JSON.stringify(s2.missing_in_seam));
      if ((s2.extra_in_seam || []).length) delen.push('extra=' + JSON.stringify(s2.extra_in_seam));
      if ((s2.not_expected || []).length) delen.push('not_expected=' + JSON.stringify(s2.not_expected));
      if ((s2.stale_tracked || []).length) delen.push('stale_tracked=' + JSON.stringify(s2.stale_tracked) + ' (de gap-notitie beschrijft een opgeloste werkelijkheid — ruim de known_gap op)');
      return s2.seam + ': ' + delen.join(' ');
    };
    return { ok: d.ok, reason: d.ok ? '' : problemen.map(beschrijf).join(' · '), seams: d.seams.length, domains: d.domains_total };
  } catch (e) { return { ok: false, reason: 'catalogDrift wierp: ' + e.message }; }
}

function runContractDoctorCheck(root) {
  if (!runContractTool) return { ok: true, reason: 'forge-runcontract.cjs module not available (run-contract check unavailable)', run_id: null };
  const runId = latestDispatchedRunIdFor(root);
  if (!runId) return { ok: true, reason: 'no dispatched run to check yet', run_id: null };
  let domain = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(claudeDir(root), 'forge-runs', runId, 'run.json'), 'utf8'));
    if (meta && (meta.domain || meta.project_type)) domain = String(meta.domain || meta.project_type);
  } catch { /* run.json missing/malformed — the "always" rules still run with domain:null, never a hard fail */ }
  try {
    const result = runContractTool.check({ run_id: runId, domain }, { root });
    return Object.assign({}, result, { reason: result.ok ? '' : (result.missing.length + ' required rule(s) missing on the latest dispatched run') });
  } catch (e) {
    return { ok: false, reason: 'forge-runcontract check threw: ' + e.message, run_id: runId };
  }
}

/** skillEvalsDoctorCheck(root) -> {ok, reason, skills, summary} — ADVISORY-ONLY wrapper around
 *  forge-skill-evals.cjs::runAll() (wp-skill-evals, backlog item 1 / YT-SWEEP-2026-07-31, 2026-07-31 —
 *  see that module's own header for the full evals.json schema and assertion-type catalog). A skill with
 *  no evals.json is simply not evaluated by that module — this check never invents a requirement for a
 *  skill that hasn't opted in yet. Degrades honestly (never throws) when the sibling module is
 *  unavailable (soft dependency, same posture as syncTool/verifyTool/runContractTool above) or when the
 *  underlying runAll() call itself throws (a malformed --skill filter can never reach here — this call
 *  never passes one). Zero skills carrying an evals.json yet is vacuously ok:true (a fresh project must
 *  never doctor-fail for opting into nothing). NOT promoted to ENFORCED: this is the FOUNDATION piece of
 *  the self-improvement substrate — no autonomous keep/revert loop exists yet (that stays nightshift-
 *  gated, a later piece), so a real assertion failure here is a signal to review by hand, not yet a build
 *  gate. */
function skillEvalsDoctorCheck(root) {
  if (!skillEvalsTool) return { ok: true, reason: 'forge-skill-evals.cjs module not available (skill-evals check unavailable)', skills: [], summary: null };
  try {
    const out = skillEvalsTool.runAll({ root });
    return {
      ok: out.ok,
      reason: out.ok ? '' : (out.summary.failedSkills + ' skill(s) with a failing/malformed eval'),
      skills: out.skills,
      summary: out.summary,
    };
  } catch (e) {
    return { ok: false, reason: 'forge-skill-evals check threw: ' + e.message, skills: [], summary: null };
  }
}

// ===========================================================================================================
// "pakket 2" (2026-08-01) — RUN LIVENESS as a doctor advisory: forge-runwatch.cjs finally runs by itself.
//
// THE CONCRETE FAILURE THIS EXISTS TO CATCH: run forge-2026-07-29-cc-finish sat on status "running" for 30+
// hours — a `run_completed` event had been logged and 135 further events followed, but nothing ever compared
// the LEDGER (run.json's `status`) against the EVIDENCE (events.jsonl). forge-runwatch.cjs could answer that
// question exactly, terminal event line included, but it only ever ran when someone asked it to, so nobody
// asked. Wiring it into the doctor — which runs before every ship/handoff — is what makes it automatic.
//
// TWO HONEST WINDOWS, NOT ONE: forge-runwatch's own interactive default is 15 minutes, right for a Lead
// watching a live swarm. That is far too tight for a batch sweep over every historical run — an agent
// legitimately thinking for 20 minutes would be branded dead. LIVENESS_WINDOW_MS below is deliberately much
// wider (6h): well beyond any real single turn, far short of the 30+ hours actually observed. The window is
// an explicit parameter (opts.windowMs) so the test can prove the exclusion of a LIVE run is really about
// elapsed silence and not about that fixture being special.
//
// ADVISORY-ONLY, and it stays that way: a stale ledger is a bookkeeping error to correct by hand, not a
// reason to fail a build. It is reported under report.advisory.run_liveness with its own printSummary line,
// exactly like backfill_continuity.
const LIVENESS_WINDOW_MS = 6 * 60 * 60 * 1000;
// Status values that CLAIM the run is still going. Anything else (completed, done, failed, aborted, absent)
// is a ledger that is not claiming liveness, so there is nothing to contradict — never a finding.
const LIVENESS_RUNNING_STATUSES = new Set(['running', 'in_progress', 'in-progress', 'active', 'dispatched', 'started']);

/** runLiveness(root, opts) -> {ok, checked, findings, windowMs, reason}
 *  For every run whose run.json CLAIMS to be running, asks forge-runwatch.cjs what the events actually show
 *  and reports the contradictions, each with runwatch's OWN evidence attached (never a re-derived verdict):
 *    finished_but_open  — every started agent has a real terminal event AND the run has been silent past the
 *                         window: the work is provably over, the ledger just never said so. (The silence
 *                         requirement is what keeps a genuinely live run between two waves out of this.)
 *    stalled            — an agent started, never terminated, and has been silent past the window.
 *    no_agent_activity  — events exist but not one agent ever started, and it has been silent past the window.
 *    no_events          — the ledger says running and the run never logged a single event; age is measured
 *                         from run.json's own started_at (falling back to its mtime).
 *  A run directory with no parseable run.json is skipped entirely: nothing there claims to be running, so
 *  there is nothing to contradict. Missing forge-runs directory / missing forge-runwatch degrade to a clean,
 *  explicitly-reasoned ok:true — a fresh project must never produce a fabricated finding. */
function runLiveness(root, opts) {
  opts = opts || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMs = (Number.isFinite(opts.windowMs) && opts.windowMs > 0) ? opts.windowMs : LIVENESS_WINDOW_MS;
  if (!runwatchTool) return { ok: true, checked: 0, findings: [], windowMs, reason: 'forge-runwatch.cjs module not available (run-liveness check unavailable)' };
  const runsDir = path.join(claudeDir(root), 'forge-runs');
  let entries;
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); }
  catch { return { ok: true, checked: 0, findings: [], windowMs, reason: 'no forge-runs directory yet' }; }
  const findings = [];
  let checked = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const runJsonPath = path.join(runsDir, e.name, 'run.json');
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(runJsonPath, 'utf8')); } catch { continue; } // no real ledger -> nothing claims "running"
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const status = String(meta.status == null ? '' : meta.status).trim().toLowerCase();
    if (!LIVENESS_RUNNING_STATUSES.has(status)) continue;
    checked++;
    const st = runwatchTool.watch(e.name, { runsDir, now, stallMs: windowMs });
    if (st == null) {
      let startedAt = Date.parse(meta.started_at || meta.startedAt || '');
      if (!Number.isFinite(startedAt)) { try { startedAt = fs.statSync(runJsonPath).mtimeMs; } catch { startedAt = now; } }
      const silentMs = now - startedAt;
      if (silentMs >= windowMs) {
        findings.push({
          run_id: e.name, status, kind: 'no_events', overall: 'no-events', silent_ms: silentMs,
          last_event_at: null, counts: null, evidence: [], stalled_agents: [],
          detail: 'run.json says "' + status + '" but this run never logged a single event',
        });
      }
      continue;
    }
    const silentMs = st.lastEventAt == null ? null : (now - st.lastEventAt);
    const silentPastWindow = silentMs == null || silentMs >= windowMs;
    let kind = null, detail = '';
    if (st.overall === 'stalled') {
      kind = 'stalled';
      detail = st.counts.stalled + ' agent(s) started and never reported a terminal event';
    } else if (st.overall === 'done' && silentPastWindow) {
      kind = 'finished_but_open';
      detail = 'every started agent has a real terminal event (' + st.evidence.length + ' proof line(s)) — the work is over, the ledger still says "' + status + '"';
    } else if (st.overall === 'empty' && silentPastWindow) {
      kind = 'no_agent_activity';
      detail = 'events exist but no agent ever started';
    }
    if (!kind) continue;
    findings.push({
      run_id: e.name, status, kind, overall: st.overall, silent_ms: silentMs, last_event_at: st.lastEventAt,
      counts: st.counts, evidence: st.evidence, stalled_agents: st.stalledAgents, detail,
    });
  }
  return { ok: findings.length === 0, checked, findings, windowMs, reason: '' };
}

// ===========================================================================================================
// wp-disclosure-ab (2026-07-31) — progressive-disclosure hygiene as a doctor advisory (backlog item 12,
// YT-SWEEP-2026-07-31, 6 source videos: zKBPwDpBfhs, WMi0BLDLAjk, 7s9Fnorg3eI, HCwfRe5EHGQ, fOxC44g8vig,
// JN7QCdvJwwM — see .claude/forge-research/YT-SWEEP-2026-07-31.md item #12). Built on the forge-skill-evals.cjs
// FOUNDATION piece above (same ADVISORY-ONLY posture, same "a skill dir is scanned independently — one bad
// skill never crashes the whole check" discipline).
// ===========================================================================================================
const SKILL_DESCRIPTION_MAX_CHARS = 200; // the wp3b description-length budget law — see forge-skill-evals.cjs's
  // own `frontmatter_field` max_length for the SAME budget wired as a per-skill, opt-in, machine-checkable
  // assertion; this check applies it project-wide, unconditionally, to every skill.
const SKILL_BODY_MAX_LINES = 500; // this project's own CLAUDE.md file-size guidance ("Keep files under 500
  // lines"). Whole-file line count, frontmatter included — mirrors forge-skill-evals.cjs's own `max_lines`
  // assertion semantics (the frontmatter is only a few lines, a faithful proxy for "keep the body small").
const SKILL_CODE_SPAN_RE = /`([^`\n]+)`/g;
const SKILL_PATH_SHAPE_RE = /^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}$/;
// Deliberately narrow anchor set — matches the work package's own two examples exactly: a fully-qualified
// project path from the repo root (".claude/...") or a skill's own tier-3 on-demand subfolder convention
// (references/ / scripts/ / assets/), resolved relative to the SKILL.md's own directory. A bare relative
// mention with NEITHER anchor (e.g. "docs/ARCHITECTURE.md", "src/contract.js" — real strings this project's
// own playbooks use to describe a DOWNSTREAM built project's OWN tree, never this Forge project's) is
// intentionally left unchecked: there is no safe, unambiguous base to resolve it against (project root? this
// project's .claude/? the skill's own folder?) — guessing one would fabricate a finding, not report one.
const SKILL_REF_WHITELIST_PREFIXES = ['.claude/', 'references/', 'scripts/', 'assets/'];

/** extractSkillPathRefs(text) -> [{ref, anchored}, ...] — every DISTINCT backtick-wrapped, path-shaped token
 *  in a SKILL.md body. ONLY scans inside backtick code-spans: a survey of every real file/tool reference
 *  across this project's actual 48 SKILL.md files (2026-07-31) found every genuine one already wrapped in
 *  backticks, and requiring the code-span boundary is what keeps this check from ever matching an ordinary
 *  prose sentence that happens to contain a slash and a period (a date, a fraction, an abbreviation) — the
 *  work package's own "no false positives on prose" requirement. Two further filters, both proven necessary
 *  against this project's real content:
 *   - a URL (http:// or https://) is stripped from the text before scanning, so a URL's own path segment
 *     (e.g. "github.com/owner/repo.git") is never mistaken for a project file reference.
 *   - an "alternation" token — e.g. "manifest.json/events.jsonl", real prose in this project meaning
 *     "manifest.json OR events.jsonl", never a nested directory — is detected (any segment BEFORE the last
 *     one that already looks like a complete "name.ext" on its own) and rejected; a genuine nested directory
 *     component in this codebase never itself has a bare "name.ext" shape.
 *  A candidate containing "<" (a placeholder like "<run_id>") or "*" (a glob, e.g.
 *  "config/orchestration/*.json") is never treated as a literal file, per the work package. `anchored` (see
 *  SKILL_REF_WHITELIST_PREFIXES above) marks whether this checker has a safe, unambiguous base to resolve
 *  the reference against; an unanchored candidate is returned but never existence-checked by skillHygiene()
 *  below — never a fabricated finding against a base this checker is only guessing at. Never throws. */
function extractSkillPathRefs(text) {
  const withoutUrls = text.replace(/https?:\/\/[^\s)`'"]+/g, '');
  const seen = new Set();
  const out = [];
  let m;
  SKILL_CODE_SPAN_RE.lastIndex = 0;
  while ((m = SKILL_CODE_SPAN_RE.exec(withoutUrls)) !== null) {
    const inner = m[1].trim();
    if (!SKILL_PATH_SHAPE_RE.test(inner)) continue;
    if (inner.includes('<') || inner.includes('*')) continue;
    if (seen.has(inner)) continue;
    const segs = inner.split('/');
    let altProse = false;
    for (let i = 0; i < segs.length - 1; i++) {
      if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/.test(segs[i])) { altProse = true; break; }
    }
    if (altProse) continue;
    seen.add(inner);
    out.push({ ref: inner, anchored: SKILL_REF_WHITELIST_PREFIXES.some((p) => inner.startsWith(p)) });
  }
  return out;
}

/**
 * detectVendorPin(text) -> {source, pin} | null — is this skill third-party content copied at a recorded pin?
 *
 * Provenance has to be EARNED, not claimed: BOTH an upstream `Source:` and a `Pinned commit:` hash. One line
 * on its own proves nothing, and if a single typed word could buy an exemption then "vendored" stops being
 * evidence and becomes a way to silence a check. Only the head of the file is read, because this must be a
 * header the vendoring step wrote — not a phrase that happens to appear in 600 lines of prose.
 */
function detectVendorPin(text) {
  const head = String(text || '').slice(0, 4000);
  const source = head.match(/^[\s*/#-]*Source:\s*(\S+)/m);
  const pin = head.match(/^[\s*/#-]*Pinned commit:\s*([0-9a-f]{7,40})\b/im);
  if (!source || !pin) return null;
  return { source: source[1], pin: pin[1] };
}

/** generatedPathBasenames(root) -> Set<'naam.ext'> — bestandsnamen die onze EIGEN code wegschrijft.
 *
 *  MEASURED FALSE POSITIVE (2026-08-09, echte doctor-run): `skill-hygiene: forge-snapshot (1 dangling
 *  reference(s): .claude/.forge-snapshot-due.json)`. Dat bestand wordt door forge-snapshot-marker.cjs
 *  GESCHREVEN en door de SessionStart-hook geconsumeerd — afwezig zijn is zijn normale toestand. Je eigen
 *  outputpad documenteren is geen kapotte link, en een advisory die volloopt met valse positieven wordt
 *  niet meer gelezen — precies zo mist hij straks een ECHTE dangling reference.
 *
 *  Bewust op BASENAME: de schrijvende code stelt het pad samen (`path.join(dueDir, '.forge-snapshot-due.json')`),
 *  dus het volledige pad bestaat nergens als literal. Om dat niet te laten ontsporen tot "elke bestandsnaam
 *  die ergens in een schrijvend bestand voorkomt", tellen alleen literals op (of vlak onder) een regel met een
 *  echte schrijf-API. Testbestanden tellen niet mee: fixtures schrijven van alles en zijn geen bron van waarheid. */
const WRITE_API_RE = /\b(writeFileSync|appendFileSync|writeAtomic|createWriteStream|copyFileSync)\b/;
const FILENAME_LITERAL_RE = /['"`](\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)['"`]/g;
// The write call and its argument list on one line: `fs.writeFileSync(projMarkerPath, json, 'utf8')` ->
// group 1 = api, group 2 = everything up to the first `)`. Used to find WHICH variable is being written.
const WRITE_CALL_ARGS_RE = /\b(writeFileSync|appendFileSync|writeAtomic|createWriteStream|copyFileSync)\s*\(([^()]*)/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
function generatedPathBasenames(root) {
  const out = new Set();
  for (const sub of ['forge-bin', 'forge-dashboard', 'hooks']) {
    let files = [];
    try { files = listByExt(path.join(claudeDir(root), sub), ['.cjs', '.mjs', '.js']); } catch { continue; }
    for (const f of files) {
      if (/\.test\.(cjs|mjs|js)$/.test(f)) continue;
      let lines;
      try { lines = fs.readFileSync(f, 'utf8').split(/\r?\n/); } catch { continue; }
      const resolved = new Set(); // one declaration lookup per written variable per file
      for (let i = 0; i < lines.length; i++) {
        if (!WRITE_API_RE.test(lines[i])) continue;
        const window = lines[i] + '\n' + (lines[i + 1] || ''); // een gewrapte aanroep zet het pad op de volgende regel
        FILENAME_LITERAL_RE.lastIndex = 0;
        let m;
        while ((m = FILENAME_LITERAL_RE.exec(window)) !== null) out.add(m[1]);
        harvestPathHelpers(window, lines, out); // `appendFileSync(ledgerPath(root), …)` — the path comes from a helper
        // 2026-09-23 (measured on forge-setup.cjs, restored this release): the path is often built ONCE into a
        // variable — `const projMarkerPath = path.join(projectDir, '.claude', '.forge-setup.json')` — and the
        // write, fifteen lines later, only names that variable: `fs.writeFileSync(projMarkerPath, …)`. Neither
        // line carries both the write API and the literal, so the marker fell through and forge-router's honest
        // reference to `.claude/.forge-setup.json` came back as a "dangling" link. Resolve the written argument
        // (the first one; for copyFileSync the second — that is the destination) to its declaration in the SAME
        // file — const/let/var, one hop, no re-assignment chasing — and take the literals from that line. Still
        // bounded: only a variable that is actually handed to a write API is ever looked up.
        const call = WRITE_CALL_ARGS_RE.exec(lines[i]);
        if (!call) continue;
        const args = call[2].split(',').map((a) => a.trim());
        const written = call[1] === 'copyFileSync' ? args[1] : args[0];
        if (!written || !IDENTIFIER_RE.test(written) || resolved.has(written)) continue;
        resolved.add(written);
        const declRe = new RegExp('\\b(?:const|let|var)\\s+' + written.replace(/\$/g, '\\$') + '\\s*=');
        for (let j = 0; j < lines.length; j++) {
          if (!declRe.test(lines[j])) continue;
          const declWindow = /[;}]\s*$/.test(lines[j]) ? lines[j] : lines[j] + '\n' + (lines[j + 1] || ''); // same spill rule as the helper hop
          FILENAME_LITERAL_RE.lastIndex = 0;
          let d;
          while ((d = FILENAME_LITERAL_RE.exec(declWindow)) !== null) out.add(d[1]);
          harvestPathHelpers(declWindow, lines, out);
        }
      }
    }
  }
  return out;
}
/** One more hop, still bounded: a written path is often produced by a small helper — `appendFileSync(ledgerPath(root), …)`
 *  or `const statePath = opts.statePath || defaultStatePath(root)` with `function defaultStatePath(root) { return
 *  path.join(root, '.claude', 'forge-research', 'docdrift-state.json'); }`. Measured on every fresh install's doctor
 *  (2026-09-24, CI): forge-docdrift and forge-router were flagged for exactly such helper-built paths. Only identifiers
 *  that are CALLED in the write/declaration window are looked up, and only their own `function NAME(` line (+1). */
function harvestPathHelpers(window, lines, out) {
  const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  const SKIP = new Set(['require', 'writeFileSync', 'appendFileSync', 'writeAtomic', 'createWriteStream', 'copyFileSync', 'join', 'resolve', 'stringify', 'parse', 'push', 'toString', 'String', 'Number', 'if', 'for', 'while', 'catch', 'function', 'Error', 'JSON']);
  let c;
  while ((c = CALL_RE.exec(window)) !== null) {
    const name = c[1];
    if (SKIP.has(name)) continue;
    const fnRe = new RegExp('\\bfunction\\s+' + name.replace(/\$/g, '\\$') + '\\s*\\(');
    for (let k = 0; k < lines.length; k++) {
      if (!fnRe.test(lines[k])) continue;
      // Only spill onto the next line when this one is genuinely unfinished (a wrapped `return path.join(…,`); a
      // one-line helper ending in `}` must not harvest the NEXT helper's literal (measured: a never-called decoy
      // helper on the following line was classified as generated).
      const fnWindow = /[;}]\s*$/.test(lines[k]) ? lines[k] : lines[k] + '\n' + (lines[k + 1] || '');
      FILENAME_LITERAL_RE.lastIndex = 0;
      let d;
      while ((d = FILENAME_LITERAL_RE.exec(fnWindow)) !== null) out.add(d[1]);
    }
  }
}

/** skillHygiene(root) -> {ok, checked, vendored_exempt, skills:[{skill, ok, issues:[], vendored?, vendored_style?, generated_refs?}]}
 *  ADVISORY-ONLY (see header doc).
 *  Unlike skill_evals above (opt-in evals.json), EVERY skill dir under .claude/skills/ that has a SKILL.md
 *  is IN SCOPE here — there is no opt-out.
 *
 *  SCOPE DEFECT FIXED 2026-08-01 (measured on this project, not assumed): this function used to do its own
 *  single-level `readdirSync(skills/)` + `<dir>/SKILL.md` read, i.e. exactly a one-star `skills/<x>/SKILL.md`
 *  glob — which found 49 of this project's 57 real SKILL.md files. The 8 gsap sub-skills live one level deeper
 *  (`skills/gsap/gsap-core/SKILL.md` …) and were therefore evaluated by NOTHING: not passing, INVISIBLE,
 *  which is strictly worse than a red finding — and every one of them is over the description budget this
 *  check exists to police, i.e. the check was blind to precisely the surface it was written for. It now
 *  reuses listSkillFiles() (already defined and exported above for sync_completeness), the one recursive
 *  SKILL.md walker in this file — so the hygiene scope and the sync-manifest scope can never drift apart
 *  again. `skill` is the skills/-relative id ("gsap/gsap-core"), never a bare leaf name two bundles could
 *  both claim. Three checks per skill: (1) frontmatter `description` present
 *  and <= SKILL_DESCRIPTION_MAX_CHARS; (2) whole-file line count <= SKILL_BODY_MAX_LINES; (3) every
 *  ANCHORED path-shaped reference (extractSkillPathRefs above) resolves to a real file — a `.claude/`-
 *  prefixed ref resolves from the project root, everything else (references//scripts//assets/) resolves
 *  from the SKILL.md's OWN directory. A skill dir with no SKILL.md is out of scope (mirrors
 *  listSkillDirs()'s own opt-in-by-file-presence posture in forge-skill-evals.cjs — not a skill, not
 *  evaluated). Never throws: an unreadable SKILL.md is simply excluded from `checked`, never crashes the
 *  whole scan (one bad skill dir must never take down every other skill's report). NOT promoted to
 *  ENFORCED: same reasoning as skill_evals — this is advisory review signal for the Skill Boss today, not
 *  yet a build gate. */
function skillHygiene(root) {
  const cd = claudeDir(root);
  const skills = [];
  const generatedNames = generatedPathBasenames(root); // één keer scannen, niet per skill
  for (const rel of listSkillFiles(root)) {
    const skillFile = path.join(cd, rel.split('/').join(path.sep));
    const skillDir = path.dirname(skillFile);
    // skills/-relative id, so a nested skill is named the way it is actually addressed on disk
    // ("gsap/gsap-core"), never collapsed to a bare leaf name that two bundles could both claim.
    const skillId = rel.replace(/^skills\//, '').replace(/\/SKILL\.md$/, '');
    let text;
    try { text = fs.readFileSync(skillFile, 'utf8'); } catch { continue; }
    const issues = [];
    // VENDORED CONTENT (2026-08-01). A skill copied verbatim from an upstream repo at a recorded pin is not
    // ours to restyle: rewriting it would make the pin describe something no longer on disk. So its SHAPE
    // (description/body length) is reported separately, with the real numbers, while its FUNCTION in our
    // tree (a usable description, references that resolve) is judged exactly like anything else. See the
    // vendored fixtures in forge-doctor.test.cjs §7 for why a half-marker must not buy this exemption.
    const vendored = detectVendorPin(text);
    const vendoredStyle = [];
    const styleIssue = (msg) => (vendored ? vendoredStyle : issues).push(msg);
    const fm = parseFrontmatter(text);
    const desc = fm && fm.description;
    if (!desc) issues.push('description missing/empty in frontmatter'); // no description = undiscoverable HERE, never upstream's problem to own
    else if (desc.length > SKILL_DESCRIPTION_MAX_CHARS) styleIssue('description is ' + desc.length + ' chars (max ' + SKILL_DESCRIPTION_MAX_CHARS + ')');
    const lineCount = text.split(/\r?\n/).length;
    if (lineCount > SKILL_BODY_MAX_LINES) styleIssue('SKILL.md is ' + lineCount + ' lines (max ' + SKILL_BODY_MAX_LINES + ')');
    const dangling = [];
    const generatedRefs = [];
    for (const r of extractSkillPathRefs(text)) {
      if (!r.anchored) continue;
      const resolved = r.ref.startsWith('.claude/') ? path.resolve(root, r.ref) : path.resolve(skillDir, r.ref);
      let exists = false;
      try { exists = fs.statSync(resolved).isFile(); } catch { exists = false; }
      if (exists) continue;
      // afwezig én door onze eigen code geschreven = runtime-marker, geen kapotte link. Herclassificeren,
      // niet verzwijgen: hij blijft zichtbaar onder generated_refs zodat de informatie niet verdwijnt.
      if (generatedNames.has(path.basename(r.ref))) generatedRefs.push(r.ref);
      else dangling.push(r.ref);
    }
    if (dangling.length) issues.push(dangling.length + ' dangling reference(s): ' + dangling.join(', '));
    const entry = { skill: skillId, ok: issues.length === 0, issues };
    if (generatedRefs.length) entry.generated_refs = generatedRefs;
    if (vendored) { entry.vendored = vendored; entry.vendored_style = vendoredStyle; }
    skills.push(entry);
  }
  return {
    ok: skills.every((s) => s.ok),
    checked: skills.length,
    vendored_exempt: skills.filter((s) => s.vendored && s.vendored_style.length).length,
    skills,
  };
}

/**
 * installationProfile(root) -> {profile:'development'|'redistribution', marker, marker_present, vendored:[ids],
 *   checked, reason}
 *
 * DISCRIMINATOR CHANGED (wp17, 2026-09-24): the verdict now keys on `.claude/config/forge-dev-tree.json` (a
 * parseable `{"dev_tree": true}`), NOT on "carries vendored skills". The history below explains why vendoring
 * was once a sound marker; it stopped being one the day the public distribution began SHIPPING vendored skills
 * (13 obra/superpowers skills + frontend-design, wp6): a fresh clone would then read as the development tree
 * and run exact-count assertions against a tree that honestly holds fewer skills. The marker file is the
 * difference that survives: it exists only in the canonical checkout and the release sync deliberately never
 * ships it. The vendoring pins are still counted and quoted in `reason`, because a skip must be able to say
 * what it saw. The two profile names are kept unchanged on purpose — forge-configdrift.test.cjs and
 * forge-contextbudget.test.cjs gate on `profile === 'development'`.
 *
 * WHICH TREE IS THIS? (2026-08-02) — not a check, and deliberately never folded into any verdict. It answers
 * one narrow question that some assertions genuinely need to ask before they mean anything: is this the
 * canonical development tree, or a redistribution of it?
 *
 * The problem it exists to solve: several tests pin an EXACT property of this installation ("this project
 * has exactly 57 skills"). Those pins are real drift guards here — they are how a silently-dropped skill or
 * a walk that stops one directory too shallow gets caught. In the published distribution the same pins fail
 * for a reason that is not a defect: the 9 vendored third-party skills are deliberately not redistributed,
 * so the tree honestly has fewer. Loosening the pins to a range, or listing the acceptable counts, would
 * destroy exactly the drift detection they were written for — a count that accepts two answers guards
 * nothing.
 *
 * (Historical, 2026-08-02 until wp17 — superseded by the dev-tree marker above.) The marker WAS the
 * difference itself: a skill counts as vendored only when detectVendorPin() finds BOTH an upstream `Source:`
 * and a `Pinned commit:` hash that the vendoring step actually wrote into the file, and a tree without any
 * such skill was treated as a redistribution. What remains true: a pinned assertion outside the development
 * tree is a SKIP with a stated reason, never a quiet pass.
 *
 * Deliberately NOT a doctor check and NOT in `checks`: neither profile is a defect. Never throws — an
 * unreadable skill is simply not counted, exactly as skillHygiene() treats it.
 */
const DEV_TREE_MARKER_REL = '.claude/config/forge-dev-tree.json';
/** readDevTreeMarker(root) -> {present, valid, error?} — the marker counts only when it parses AND says
 *  `dev_tree: true`; an empty or garbled file is reported, never promoted to "development". Never throws. */
function readDevTreeMarker(root) {
  const p = path.join(claudeDir(root), 'config', 'forge-dev-tree.json');
  if (!fs.existsSync(p)) return { present: false, valid: false };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data && data.dev_tree === true ? { present: true, valid: true } : { present: true, valid: false, error: 'dev_tree is not true' };
  } catch (e) { return { present: true, valid: false, error: e.code || e.name }; }
}
function installationProfile(root) {
  const cd = claudeDir(root);
  const vendored = [];
  let checked = 0;
  for (const rel of listSkillFiles(root)) {
    let text;
    try { text = fs.readFileSync(path.join(cd, rel.split('/').join(path.sep)), 'utf8'); } catch { continue; }
    checked++;
    if (detectVendorPin(text)) vendored.push(rel.replace(/^skills\//, '').replace(/\/SKILL\.md$/, ''));
  }
  const marker = readDevTreeMarker(root);
  const dev = marker.valid;
  const pins = vendored.length + ' of ' + checked + ' skills carry an upstream Source: + Pinned commit: header';
  return {
    profile: dev ? 'development' : 'redistribution',
    marker: DEV_TREE_MARKER_REL,
    marker_present: marker.present,
    vendored: vendored.sort(),
    checked,
    reason: dev
      ? 'development tree: ' + DEV_TREE_MARKER_REL + ' present (' + pins + ')'
      : marker.present
        ? 'not the development tree: ' + DEV_TREE_MARKER_REL + ' exists but is not a valid {"dev_tree": true} marker (' + marker.error + '); ' + pins
        : 'not the development tree: ' + DEV_TREE_MARKER_REL + ' (the canonical-checkout marker the release sync never ships) is absent, so the exact counts measured in the development tree do not apply; ' + pins,
  };
}

/** loadDoctorCheckOverrides — reads config/orchestration/FORGE_HARD_RULES.json's `doctor_check_overrides`
 *  array (see that file's own top-level doc for the exact shape: {check, reason, by, ts}). A missing file,
 *  malformed JSON, or a missing/empty `doctor_check_overrides` array all degrade to "no overrides" ([]) —
 *  this is an OPT-IN recovery mechanism, not a required config; its absence must never be an error. Every
 *  entry MUST carry a non-empty string `check` id and a non-empty string `reason` (a blank/templated reason
 *  is silently dropped, same "no blank override" discipline forge-scout.cjs's record() enforces for its own
 *  ledger) — a malformed single entry is skipped, never crashes the whole read. */
function loadDoctorCheckOverrides(root) {
  const p = path.join(claudeDir(root), 'config', 'orchestration', 'FORGE_HARD_RULES.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
  if (!data || !Array.isArray(data.doctor_check_overrides)) return [];
  return data.doctor_check_overrides.filter((o) => o && typeof o.check === 'string' && o.check.trim() && typeof o.reason === 'string' && o.reason.trim());
}
/** applyDoctorOverride — a promoted-to-ENFORCED check's result is passed through UNCHANGED when it already
 *  passes (an override never "improves" a real pass into something more positive than reality) or when no
 *  matching override entry exists. Only a GENUINE failure with a matching, valid override entry is turned
 *  into a visible-but-honest pass: `ok:true` PLUS `overridden:true` + the real reason/by fields, so
 *  printSummary() can render it distinctly from an ordinary clean pass (see the '[OVERRIDDEN: ...]' tag) —
 *  never a silent bypass. */
function applyDoctorOverride(overrideMap, checkId, result) {
  if (result.ok) return result;
  const ov = overrideMap.get(checkId);
  if (!ov) return result;
  return Object.assign({}, result, { ok: true, overridden: true, override_reason: ov.reason, override_by: (ov.by && String(ov.by).trim()) || 'owner' });
}

/** contextBudgetCheck(root) -> the forge-contextbudget.cjs report, or an honest "unavailable" stand-in.
 *  ADVISORY-ONLY and deliberately so: the numbers are ESTIMATES (characters/4, no tokenizer), and failing a
 *  build on an estimate would be exactly the fake precision that check refuses to produce. It is also the
 *  one doctor check that reads files OUTSIDE the project root — read-only, counted, never written (see
 *  forge-contextbudget.cjs's header). A throw is swallowed into ok:true + a reason: a meter must never be
 *  able to take down the doctor it is only advising. */
function contextBudgetCheck(root) {
  if (!contextBudgetTool) return { ok: true, reason: 'forge-contextbudget.cjs module not available (context-budget check unavailable)', posts: [], findings: [], total_approx_tokens: 0 };
  try { return contextBudgetTool.measure(root, {}); }
  catch (e) { return { ok: true, reason: 'forge-contextbudget.measure threw: ' + e.message, posts: [], findings: [], total_approx_tokens: 0 }; }
}

// ===========================================================================================================
// BEGINNER SETUP (wp17, 2026-09-24) — ADVISORY-ONLY, report.advisory.beginner_setup. The setup traps a
// first-time user hits and a doctor can see (research: .claude/forge-research/beginner-sweep-2026-09-24/
// web-track-a.md): A3 an over-long CLAUDE.md gets ignored · A32/B18 `claude`/`git`/`node` "not recognized" ·
// a native Claude Code install needs no Node while every Forge tool is a .cjs file · A20/B9 bypassPermissions
// as a default · B22 a WSL project under /mnt/c · A35 `claude doctor` exists and nobody knows it · (wp-l1,
// loop iteration 1, 2026-09-24) settings-wired: is Forge's own hooks/deny payload actually merged into this
// project's settings.json, via forge-settings-merge.cjs::checkSettingsMerge() · (wp-l4, loop iteration 4,
// 2026-09-24) model-choice-hint: theme 5 of the same beginner sweep (52/98 videos — model choice, usage
// limits & cost) had NO beginner-facing surface anywhere in Forge, only the owner's own global
// TOKEN_EFFICIENCY_GLOBAL_POLICY.md, which a beginner never reads. One plain, paraphrased sentence, always
// `info` (nothing here is evaluated, so it can never be `ok` or `warn`).
// Contract of every check: {id, ok, level:'ok'|'info'|'warn'|'n-a'|'note', detail, ms, ...evidence}; ok is
// false exactly when level is 'warn'. `note` is the same non-judgmental posture as `info` — used when a
// check genuinely has nothing to compare against (see settingsWired() below) rather than a real pass/fail.
// Each result passes through applyDoctorOverride() under its printed id, so an
// owner can acknowledge a deliberate warn (a throwaway VM that really runs bypassPermissions) with the same
// reasoned doctor_check_overrides entry the enforced checks use. Nothing here reads the user's home
// directory: only the project root, the PATH it is handed, and the tools that PATH resolves to.
// ===========================================================================================================
const CLAUDE_MD_MAX_LINES = 200;
const BEGINNER_PATH_TOOLS = ['claude', 'git', 'node'];
const TOOL_VERSION_TIMEOUT_MS = 3000;
const CLAUDE_DOCTOR_TIMEOUT_MS = 5000;
const CLAUDE_DOCTOR_MAX_LINES = 5;
const PATH_MISSING_HINT = 'Close and reopen your terminal; if it is still missing, the install folder is not on PATH.';
const NODE_MISSING_HINT = "Forge's own tools are Node scripts and need Node 18 or newer, even though Claude Code itself does not.";
const WIN_EXEC_EXTS = ['.COM', '.EXE', '.BAT', '.CMD'];
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function envGet(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}
function beginnerResult(id, level, detail, extra) {
  return Object.assign({ id, ok: level !== 'warn', level, detail }, extra || {});
}
/** safeCheck — times one check and turns a throw into a visible warn. An advisory must never be able to take
 *  down the doctor it only advises, but a check that crashed is not "fine" either. */
function safeCheck(id, fn) {
  const t0 = Date.now();
  try { return Object.assign({}, fn(), { ms: Date.now() - t0 }); }
  catch (e) { return beginnerResult(id, 'warn', 'check could not run: ' + e.message, { ms: Date.now() - t0 }); }
}
function textLines(text) {
  if (!text) return 0;
  const n = text.split(/\r?\n/).length;
  return /\n$/.test(text) ? n - 1 : n;
}
function cleanLines(text, max) {
  return String(text || '').replace(ANSI_RE, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, max)
    .map((l) => (l.length > 160 ? l.slice(0, 157) + '...' : l));
}

/** claude-md-size — the project CLAUDE.md (root, or .claude/CLAUDE.md) line count against Anthropic's ~200
 *  guidance. Absent is fine and said so; unreadable is a warn (Claude Code cannot load it either). */
function claudeMdSize(root) {
  const files = [];
  for (const rel of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    try { files.push({ file: rel, lines: textLines(fs.readFileSync(abs, 'utf8')) }); }
    catch (e) { files.push({ file: rel, lines: null, error: e.code || e.message }); }
  }
  if (!files.length) return beginnerResult('claude-md-size', 'ok', 'no project CLAUDE.md — nothing to measure', { files });
  const listing = files.map((f) => f.file + ' ' + (f.lines === null ? 'UNREADABLE (' + f.error + ')' : f.lines + ' lines')).join(' · ');
  const long = files.some((f) => f.lines > CLAUDE_MD_MAX_LINES);
  const unreadable = files.some((f) => f.lines === null);
  if (!long && !unreadable) return beginnerResult('claude-md-size', 'info', listing + ' (within the ~' + CLAUDE_MD_MAX_LINES + '-line guidance)', { files });
  return beginnerResult('claude-md-size', 'warn', listing
    + (long ? ' — over ~' + CLAUDE_MD_MAX_LINES + ' lines. Anthropic: long CLAUDE.md files get ignored; move procedures into skills' : '')
    + (unreadable ? ' — a CLAUDE.md that cannot be read is never loaded' : ''), { files });
}

/** resolveOnPath(name, env, platform) -> absolute path | null. The same lookup the shell does, in-process:
 *  `where`/`which` were measured at 437-470 ms per call on Windows, which alone breaks this check's 300 ms
 *  budget three times over. Windows: every PATH dir x PATHEXT (.com/.exe/.bat/.cmd only); POSIX: an
 *  executable regular file. Never spawns, never throws. */
function resolveOnPath(name, env, platform) {
  const isWin = platform === 'win32';
  // Windows PATH entries may be wrapped in quotes (cmd strips them); a POSIX PATH entry is taken literally.
  const dirs = String(envGet(env, 'PATH') || '').split(isWin ? ';' : ':').map((d) => (isWin ? d.trim().replace(/^"(.*)"$/, '$1') : d)).filter(Boolean);
  let exts = [''];
  if (isWin) {
    const fromEnv = String(envGet(env, 'PATHEXT') || '').split(';').map((e) => e.trim().toUpperCase()).filter((e) => WIN_EXEC_EXTS.includes(e));
    exts = (fromEnv.length ? fromEnv : WIN_EXEC_EXTS).map((e) => e.toLowerCase());
  }
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!isWin) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* not here — keep looking */ }
    }
  }
  return null;
}
/** spawnResolved — run an already-resolved tool read-only: no shell, stdin closed (so nothing can wait for a
 *  keypress), hard timeout. Node refuses to spawn .cmd/.bat directly since the 2024 batch-file hardening, so
 *  those go through cmd.exe with ONE pre-quoted command line, verbatim — the same /d /s /c form Node itself
 *  builds for a shell spawn. The arguments are fixed literals chosen by this file, never user input. */
function spawnResolved(file, args, env, timeoutMs, cwd) {
  const base = { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, cwd, shell: false };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const comspec = envGet(env, 'ComSpec') || envGet(process.env, 'ComSpec') || 'cmd.exe';
    return spawnSync(comspec, ['/d', '/s', '/c', '""' + file + '" ' + args.join(' ') + '"'], Object.assign({}, base, { windowsVerbatimArguments: true }));
  }
  return spawnSync(file, args, base);
}
function toolVersion(file, env, cwd) {
  const r = spawnResolved(file, ['--version'], env, TOOL_VERSION_TIMEOUT_MS, cwd);
  if (r.error && r.error.code === 'ETIMEDOUT') return { version: null, version_note: '--version timed out after ' + (TOOL_VERSION_TIMEOUT_MS / 1000) + ' s' };
  if (r.error) return { version: null, version_note: '--version failed: ' + (r.error.code || r.error.message) };
  const first = cleanLines((r.stdout || '') + '\n' + (r.stderr || ''), 1)[0];
  return first ? { version: first } : { version: null, version_note: '--version printed nothing (exit ' + r.status + ')' };
}

function isSameFile(a, b) {
  try {
    const ra = fs.realpathSync(a), rb = fs.realpathSync(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch { return false; }
}
/** path-tools — claude, git, node resolvable on PATH, each with the first line of its --version (3 s cap).
 *  When the `node` on PATH IS the binary running this doctor, its version is process.version — the exact
 *  string `node --version` prints — and one of three spawns is saved (measured 40-140 ms per spawn here). */
function pathTools(root, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const tools = {};
  for (const name of BEGINNER_PATH_TOOLS) {
    const found = resolveOnPath(name, env, platform);
    if (!found) { tools[name] = { found: false, path: null, version: null }; continue; }
    tools[name] = name === 'node' && isSameFile(found, process.execPath)
      ? { found: true, path: found, version: process.version, version_source: 'this doctor process' }
      : Object.assign({ found: true, path: found }, toolVersion(found, env, root));
  }
  const missing = BEGINNER_PATH_TOOLS.filter((n) => !tools[n].found);
  const listing = BEGINNER_PATH_TOOLS.map((n) => n + ': ' + (!tools[n].found ? 'MISSING' : (tools[n].version || 'found (' + tools[n].version_note + ')'))).join(' · ');
  if (!missing.length) return beginnerResult('path-tools', 'ok', listing, { tools, missing });
  return beginnerResult('path-tools', 'warn', listing + ' — not recognized on PATH: ' + missing.join(', ') + '. ' + PATH_MISSING_HINT
    + (missing.includes('node') ? ' ' + NODE_MISSING_HINT : ''), { tools, missing });
}

/** bypass-mode — the PROJECT's .claude/settings.json + settings.local.json only (never a global settings
 *  file): permissions.defaultMode "bypassPermissions" is a warn; a file that does not parse is a warn too. */
function bypassMode(root) {
  const files = [];
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); }
    catch (e) { files.push({ file: rel, readable: false, error: e.code || e.name }); continue; }
    const perms = data && typeof data === 'object' && data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
    files.push({ file: rel, readable: true, defaultMode: typeof perms.defaultMode === 'string' ? perms.defaultMode : null });
  }
  const bypass = files.filter((f) => f.defaultMode === 'bypassPermissions').map((f) => f.file);
  const unreadable = files.filter((f) => !f.readable).map((f) => f.file + ' (' + f.error + ')');
  const problems = [];
  if (bypass.length) problems.push(bypass.join(', ') + ' sets permissions.defaultMode "bypassPermissions": every tool call runs without asking — keep that for a throwaway container or VM, not a real machine. Meer uitleg / more detail: .claude/skills/forge-prompt-coach/references/unsafe-advice.md');
  if (unreadable.length) problems.push('settings unreadable: ' + unreadable.join(', ') + ' — Claude Code cannot apply a settings file it cannot parse');
  if (problems.length) return beginnerResult('bypass-mode', 'warn', problems.join(' · '), { files });
  if (!files.length) return beginnerResult('bypass-mode', 'info', 'no project settings file — Claude Code asks before risky actions by default', { files });
  return beginnerResult('bypass-mode', 'info', 'no bypassPermissions default in ' + files.map((f) => f.file + (f.defaultMode ? ' (defaultMode ' + f.defaultMode + ')' : '')).join(' + '), { files });
}

/** wsl-mnt-c — a Linux (WSL) process whose project root sits under /mnt/ is working on the Windows drive
 *  through the 9P bridge: slow, and file watching there is incomplete. Pure string check, no file access. */
function wslMntC(root, opts) {
  const platform = (opts && opts.platform) || process.platform;
  if (platform !== 'linux') return beginnerResult('wsl-mnt-c', 'n-a', 'not applicable on ' + platform + ' (WSL-only check)');
  if (String(root).startsWith('/mnt/')) return beginnerResult('wsl-mnt-c', 'warn', 'project root ' + root + ' is on the Windows drive seen from WSL (slow file access, incomplete file watching). WSL: keep the project inside the Linux home for speed');
  return beginnerResult('wsl-mnt-c', 'ok', 'project root is on the Linux filesystem');
}

/** claude-doctor — Anthropic's own read-only installation check, surfaced because beginners do not know it
 *  exists. Runs ONLY when the caller asks (the forge-doctor CLI does; library and fixture calls do not, so a
 *  test suite never spends 5 s per runDoctor() on it), only when `claude` resolved on PATH, with stdin
 *  closed and a 5 s cap: it can never become an interactive session — a CLI that insists on a terminal just
 *  times out, and that is reported as such. The first 5 non-empty lines are shown verbatim, never parsed. */
function claudeDoctorProbe(root, opts) {
  const o = opts || {};
  if (!o.claudePath) return beginnerResult('claude-doctor', 'info', 'not run (claude CLI absent from PATH)', { ran: false, lines: [] });
  if (!o.probe) return beginnerResult('claude-doctor', 'info', 'not run (library call — the read-only `claude doctor` probe runs from the forge-doctor CLI only)', { ran: false, lines: [] });
  const timeoutMs = o.timeoutMs || CLAUDE_DOCTOR_TIMEOUT_MS;
  const r = spawnResolved(o.claudePath, ['doctor'], o.env || process.env, timeoutMs, root);
  if (r.error && r.error.code === 'ETIMEDOUT') return beginnerResult('claude-doctor', 'info', 'not run (timed out after ' + (timeoutMs / 1000) + ' s — the doctor runs `claude doctor` read-only itself and stopped it because it was waiting for an interactive terminal; nothing for you to do, the next doctor run tries again)', { ran: false, timed_out: true, lines: [] });
  if (r.error) return beginnerResult('claude-doctor', 'info', 'not run (' + (r.error.code || r.error.message) + ')', { ran: false, lines: [] });
  const lines = cleanLines((r.stdout || '') + '\n' + (r.stderr || ''), CLAUDE_DOCTOR_MAX_LINES);
  return beginnerResult('claude-doctor', 'info', '`claude doctor` ran read-only (exit ' + r.status + ')' + (lines.length ? ', first ' + lines.length + ' line(s):' : ' but printed nothing'), { ran: true, exit: r.status, lines });
}

/** prompt-coach-present — completeness: an install that has forge-intake must also have forge-prompt-coach,
 *  the skill the intake hands a vague request to. */
function promptCoachPresent(root) {
  const skills = path.join(claudeDir(root), 'skills');
  const intake = fs.existsSync(path.join(skills, 'forge-intake', 'SKILL.md'));
  const coach = fs.existsSync(path.join(skills, 'forge-prompt-coach', 'SKILL.md'));
  if (!intake) return beginnerResult('prompt-coach-present', 'n-a', 'forge-intake is not installed here, so there is no pairing to check', { intake, coach });
  if (coach) return beginnerResult('prompt-coach-present', 'ok', 'forge-intake and forge-prompt-coach are both installed', { intake, coach });
  return beginnerResult('prompt-coach-present', 'warn', 'forge-intake is installed but .claude/skills/forge-prompt-coach/SKILL.md is missing — an incomplete install or sync', { intake, coach });
}

/** settingsTemplatePath(opts) -> absolute path to a template settings.json, or null. Mirrors forge-sync.cjs's
 *  OWN CLI template-resolution env var (FORGE_SYNC_TEMPLATE_DIR) — but deliberately WITHOUT that CLI's
 *  "no env var -> try a global template under the user's home directory, else fall back to this project's
 *  own .claude" steps: beginner_setup never reads the user's home directory (see the section header doc
 *  comment above), and comparing a project's settings.json against itself would always trivially read
 *  "up to date" and tell a beginner nothing real. opts.source (test/CLI injection) always wins; with neither
 *  set, there is honestly no template to compare against (reported as `note`, never guessed). */
function settingsTemplatePath(opts) {
  const o = opts || {};
  if (o.source) return o.source;
  const envDir = process.env.FORGE_SYNC_TEMPLATE_DIR;
  if (envDir) {
    const p = path.join(path.resolve(envDir), 'settings.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** settings-wired — wp-l1 (2026-09-24, loop iteration 1): forge-settings-merge.cjs::checkSettingsMerge()
 *  (the pure, exported function — never a spawned CLI) against a genuine EXTERNAL template settings.json.
 *  `ok` when every Forge hook + deny rule the template ships is already present in this project's own
 *  settings.json; `warn` (never a hard failure — this stays advisory-only) when something from the template
 *  is missing; `note` when there is no settings.json here yet, or no template could be found to compare
 *  against (checkSettingsMerge() itself never writes anything either way). */
function settingsWired(root, opts) {
  const o = opts || {};
  const target = path.join(claudeDir(root), 'settings.json');
  if (!fs.existsSync(target)) {
    return beginnerResult('settings-wired', 'note', 'no .claude/settings.json in this project yet — nothing to compare', { target, source: null });
  }
  const source = settingsTemplatePath(o);
  if (!source) {
    return beginnerResult('settings-wired', 'note', 'no template settings.json found to compare against (set FORGE_SYNC_TEMPLATE_DIR to a template .claude dir to enable this check) — cannot judge whether Forge hooks/deny rules are wired', { target, source: null });
  }
  let mergeTool;
  try { mergeTool = require('./forge-settings-merge.cjs'); }
  catch (e) { return beginnerResult('settings-wired', 'note', 'forge-settings-merge.cjs unavailable: ' + e.message, { target, source }); }
  const r = mergeTool.checkSettingsMerge({ target, source });
  if (r.status === 'usage-error' || r.status === 'missing') {
    return beginnerResult('settings-wired', 'note', 'could not compare settings.json against the template: ' + r.message, { target, source });
  }
  if (r.ok) return beginnerResult('settings-wired', 'ok', 'every Forge hook and deny rule from the template is already wired into settings.json', { target, source });
  return beginnerResult('settings-wired', 'warn', 'settings.json is missing ' + r.added.length + ' hook entry/entries, ' + r.adjusted.length + ' timeout fix(es), ' + r.deny_added.length + ' deny rule(s) from the template — run forge-sync (or forge-settings-merge.cjs apply) to wire it in', { target, source, added: r.added, adjusted: r.adjusted, deny_added: r.deny_added });
}

/** model-choice-hint — wp-l4 (2026-09-24, loop iteration 4): a paraphrase of the owner's own
 *  TOKEN_EFFICIENCY_GLOBAL_POLICY.md for a beginner who has never seen that file. Pure education, not an
 *  evaluation of this project or machine, so it is always `info` — never `ok` (nothing passed) and never
 *  `warn` (nothing failed). One plain sentence, no jargon, no imperative telling the reader to run a specific
 *  command — it DESCRIBES that `/costs` and `/insights` exist rather than instructing "run /costs now".
 *  English-only, like every other beginner_setup check here (none of them branch on language either) —
 *  written in short, idiom-free sentences so it reads the same for a Dutch or English first-time user. */
function modelChoiceHint() {
  return beginnerResult('model-choice-hint', 'info',
    'model choice affects quality and cost together: a balanced, Sonnet-class model already covers everyday '
    + 'work well, a heavier model is worth reaching for only on genuinely high-risk work (security, '
    + 'production, a hard bug), a usage guard pauses Forge when you near your usage limit (it measures on an '
    + 'interval, so it is a pause before the limit, not a guaranteed instant block), and both `/costs` and '
    + '`/insights` keep the amount already used visible inside Claude Code.');
}

/** beginnerSetup(root, {env, platform, probeClaudeDoctor, claudeDoctorTimeoutMs, overrideMap, settingsSource}) ->
 *  {ok, checks:{claude_md_size, path_tools, bypass_mode, wsl_mnt_c, claude_doctor, prompt_coach_present,
 *  settings_wired, model_choice_hint}, ms}. env/platform default to this process — injectable so the tests
 *  can hand it a fake PATH or a Linux root; settingsSource is the same test/CLI injection
 *  settingsTemplatePath() honors. */
function beginnerSetup(root, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const platform = o.platform || process.platform;
  const overrideMap = o.overrideMap || new Map();
  const t0 = Date.now();
  const pt = safeCheck('path-tools', () => pathTools(root, { env, platform }));
  const claudePath = pt.tools && pt.tools.claude && pt.tools.claude.found ? pt.tools.claude.path : null;
  const raw = {
    claude_md_size: safeCheck('claude-md-size', () => claudeMdSize(root)),
    path_tools: pt,
    bypass_mode: safeCheck('bypass-mode', () => bypassMode(root)),
    wsl_mnt_c: safeCheck('wsl-mnt-c', () => wslMntC(root, { platform })),
    claude_doctor: safeCheck('claude-doctor', () => claudeDoctorProbe(root, { claudePath, probe: !!o.probeClaudeDoctor, env, timeoutMs: o.claudeDoctorTimeoutMs })),
    prompt_coach_present: safeCheck('prompt-coach-present', () => promptCoachPresent(root)),
    settings_wired: safeCheck('settings-wired', () => settingsWired(root, { source: o.settingsSource })),
    model_choice_hint: safeCheck('model-choice-hint', () => modelChoiceHint()),
  };
  const checks = {};
  for (const [key, res] of Object.entries(raw)) checks[key] = applyDoctorOverride(overrideMap, res.id, res);
  return { ok: Object.values(checks).every((c) => c.ok), checks, ms: Date.now() - t0 };
}

function runDoctor(root, opts) {
  root = path.resolve(root);
  const o = opts || {};
  const testsResult = runTests(root);
  const overrides = loadDoctorCheckOverrides(root);
  const overrideMap = new Map(overrides.map((o) => [o.check, o]));
  const checks = {
    node_check: nodeCheckAll(root),
    tests: testsResult,
    strict_events: strictEventCheck(root),
    dashboard_spa: spaPresent(root),
    leak_scan: leakScan(root),
    agents: agentsCheck(root),
    chain: chainCheck(root),
    rebinding_guard: rebindingGuard(root),
    // V9-INTEGRATE (2026-07-22): promoted from advisory-only to ENFORCED — see the header doc's
    // "V9-INTEGRATE enforcement" note above for exactly why these two (and no others) were safe to promote.
    // Recoverable via FORGE_HARD_RULES.json's doctor_check_overrides (loadDoctorCheckOverrides()/
    // applyDoctorOverride() above) if a genuine false-red ever surfaces.
    unregistered_event: applyDoctorOverride(overrideMap, 'unregistered_event', unregisteredEvent(root)),
    check_the_checks: applyDoctorOverride(overrideMap, 'check_the_checks', checkTheChecks(root, testsResult)),
  };
  // advisory checks are DELIBERATELY excluded from this ok computation — see backfillContinuity's doc above.
  const ok = Object.values(checks).every((c) => c.ok);
  const advisory = {
    backfill_continuity: backfillContinuity(root),
    // "pakket 2" (2026-08-01): forge-runwatch.cjs, run automatically instead of only on request — its own
    // top-level advisory key (liveness is not completeness) with its own printSummary line, exactly like
    // backfill_continuity. See runLiveness() above for the window/status rules and why it stays advisory.
    run_liveness: runLiveness(root),
    // 2026-08-01: the ALWAYS-LOADED instruction surface, metered. Its own top-level advisory key (a context
    // budget is not completeness) with its own printSummary line. See contextBudgetCheck() above.
    context_budget: contextBudgetCheck(root),
    // wp17 (2026-09-24): the beginner setup traps — machine/preference findings, never a code defect, so
    // advisory by construction. The `claude doctor` probe runs only when the caller opts in (the CLI does).
    beginner_setup: beginnerSetup(root, { overrideMap, env: o.env, platform: o.platform, probeClaudeDoctor: !!o.probeClaudeDoctor, claudeDoctorTimeoutMs: o.claudeDoctorTimeoutMs }),
    // WAVE A / A2 (2026-07-18) + V9-INTEGRATE (2026-07-22): the completeness checks that remain
    // ADVISORY-ONLY, grouped under one key so printSummary can emit a single compact advisory line — see the
    // header doc comment for exactly why each one here (unlike unregistered_event/check_the_checks above)
    // was NOT promoted to enforced.
    completeness: {
      sync_completeness: syncCompleteness(root),
      memory_discipline: memoryDiscipline(root),
      // WAVE G / G-INTEGRATE (2026-07-19): MCP-as-client safety-doctrine self-test — see mcpDormancy() above.
      mcp_dormancy: mcpDormancy(root),
      // V9-INTEGRATE (2026-07-22): forge-runcontract.cjs wired in, advisory-only — see runContractDoctorCheck()
      // above for why this specific check is not yet safe to enforce.
      run_contract: runContractDoctorCheck(root),
      quality_catalog: qualityCatalogDoctorCheck(root),
      // wp-skill-evals (2026-07-31): forge-skill-evals.cjs wired in, advisory-only — see
      // skillEvalsDoctorCheck() above for why this FOUNDATION piece is not yet safe to enforce.
      skill_evals: skillEvalsDoctorCheck(root),
      // wp-disclosure-ab (2026-07-31): progressive-disclosure hygiene, advisory-only — see skillHygiene()
      // above for why this is review signal today, not yet a build gate.
      skill_hygiene: skillHygiene(root),
    },
  };
  return { ok, root, checks, advisory, generated_at: new Date().toISOString() };
}

function printSummary(rep) {
  const c = rep.checks;
  const line = (label, ok, detail) => (ok ? '  ✓ ' : '  ✗ ') + label.padEnd(16) + (detail || '');
  const out = [];
  out.push('Forge Doctor — ' + rep.root);
  out.push(line('node --check', c.node_check.ok, c.node_check.total + ' files' + (c.node_check.ok ? '' : ' · ' + (c.node_check.reason || (c.node_check.failed + ' FAILED')))));
  // 2026-09-24 (measured on the first v2.4.0 CI run): "122 suites · 6128 passed / 0 failed · 1 SUITE(S) FAILED" named
  // NOTHING — a suite that crashed before its tally (0 failed assertions, non-zero exit) was invisible on a runner
  // where nobody can open the per-suite output. Name the red suites, with WHY (crashed / no tally / timeout).
  const redSuites = Array.isArray(c.tests.perSuite) ? c.tests.perSuite.filter((s) => s && s.ok === false) : [];
  const whySuite = (s) => s.timedOut ? 'timeout' : (s.passed === 0 && s.failed === 0 ? 'crashed or no tally' : (s.failed > 0 ? s.failed + ' failed' : 'non-zero exit'));
  const redNames = redSuites.slice(0, 6).map((s) => s.suite + ' (' + whySuite(s) + ')').join(', ') + (redSuites.length > 6 ? ', +' + (redSuites.length - 6) + ' more' : '');
  out.push(line('tests', c.tests.ok, c.tests.suites + ' suites · ' + c.tests.passed + ' passed / ' + c.tests.failed + ' failed'
    + (c.tests.ok ? '' : ' · ' + (c.tests.reason || [c.tests.suitesFailed ? c.tests.suitesFailed + ' SUITE(S) FAILED' : '', c.tests.suitesBlocked ? c.tests.suitesBlocked + ' SUITE(S) BLOCKED (timeout)' : ''].filter(Boolean).join(' · ')) + (redNames ? ' → ' + redNames : ''))));
  out.push(line('honesty gate', c.strict_events.ok, 'known accepted=' + c.strict_events.known_accepted + ' · unknown rejected=' + c.strict_events.unknown_rejected));
  // 2026-09-23 (external audit II-G): this line used to read "dashboard SPA · 7 files present", which a
  // new user reads as "the dashboard works" — but these seven files are the RETIRED per-project Control
  // Center that is never started; the live Command Center is a separate build. Say what is actually being
  // checked, so a green here is never mistaken for a working dashboard.
  out.push(line('legacy SPA files', c.dashboard_spa.ok, c.dashboard_spa.ok ? DASH_SPA.length + ' retired per-project dashboard files intact (kept for log-event.cjs; never started — the live dashboard is the Command Center)' : 'missing: ' + c.dashboard_spa.missing.join(', ')));
  const lk = c.leak_scan;
  // MULTI-REPO ACCOUNTING (2026-08-02): when more than one repository under this root contributed files,
  // say so and say how many each gave. A single anonymous total is exactly what let "1146 tracked files ·
  // clean" stand for years while a whole nested tree was never opened. Appended ONLY when there really is
  // more than one source, so an ordinary single-repo project's line is unchanged, character for character.
  const lkSources = lk.sources || [];
  const lkFrom = lkSources.length > 1
    ? ' from ' + lkSources.length + ' repos: ' + lkSources.map((s) => s.root + ' ' + (s.unavailable ? 'UNAVAILABLE (' + s.unavailable + ')' : s.files)).join(' + ')
    : '';
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
  out.push(line('leak scan', lk.ok, lk.scanned + ' tracked files (' + lk.source + ')' + lkFrom + (lk.ok ? ' · clean' : ' · ' + lk.hits.length + ' HIT(S): ' + lk.hits.map((h) => h.pattern + ' in ' + h.file).join('; ')) + lkSkip));
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
  // V9-INTEGRATE (2026-07-22): the two completeness checks promoted from advisory to ENFORCED — printed as
  // ordinary ✓/✗ lines like every other checks-key above (they now genuinely gate `ok`). An `overridden:true`
  // result still prints ✓ (it IS a pass — see applyDoctorOverride() doc) but carries a visible
  // `[OVERRIDDEN: <reason>]` tag so an owner override is never mistaken for an ordinary clean pass.
  const overrideTag = (r) => r.overridden ? ' [OVERRIDDEN by ' + (r.override_by || 'owner') + ': ' + r.override_reason + ']' : '';
  if (c.unregistered_event) {
    const ue = c.unregistered_event;
    out.push(line('unreg. events', ue.ok, (ue.ok && !ue.overridden ? (ue.checkedFiles || 0) + ' files scanned · none unregistered' : (ue.unregistered && ue.unregistered.length ? ue.unregistered.length + ' unregistered usage(s): ' + ue.unregistered.map((u) => u.event_type + ' in ' + u.file).join('; ') : (ue.reason || ''))) + overrideTag(ue)));
  }
  if (c.check_the_checks) {
    const ctc = c.check_the_checks;
    out.push(line('no-op tests', ctc.ok, (ctc.ok && !ctc.overridden ? (ctc.checked || 0) + ' suites scanned · no green no-ops' : (ctc.noOp && ctc.noOp.length ? ctc.noOp.length + ' green no-op suite(s): ' + ctc.noOp.map((n) => n.suite).join(', ') : '')) + overrideTag(ctc)));
  }
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
  // "pakket 2" (2026-08-01) — run-liveness advisory: a ledger that still claims "running" while the events
  // prove otherwise. Same WARN-line posture as backfill continuity above: never a ✓/✗ check line, never part
  // of the ALL GREEN / FAILURES verdict. The detail is capped at 3 named runs + a count so a project with a
  // long history of stale ledgers still prints one readable line.
  if (rep.advisory && rep.advisory.run_liveness) {
    const rl = rep.advisory.run_liveness;
    const fs_ = rl.findings || [];
    if (fs_.length) {
      const hrs = (ms) => (ms == null ? 'unknown' : Math.round(ms / 3600000) + 'h');
      const shown = fs_.slice(0, 3).map((f) => f.run_id + ' (' + f.kind + ', silent ' + hrs(f.silent_ms) + ')');
      out.push('  ⚠ run liveness (advisory, non-blocking): ' + fs_.length + ' run(s) still marked running but proven not alive: '
        + shown.join('; ') + (fs_.length > 3 ? '; +' + (fs_.length - 3) + ' more' : ''));
    } else {
      out.push('  ✓ run liveness (advisory): ' + rl.checked + ' run(s) claiming "running" checked · '
        + (rl.reason || 'each one is genuinely alive or honestly closed'));
    }
  }
  // 2026-08-01: one compact context-budget line. ALWAYS printed (unlike the failure-only advisories above):
  // the whole point is that the number is visible every run, because the failure mode being guarded is
  // silent growth — a line that only appears once a threshold is already crossed would restore exactly the
  // blindness this check exists to remove. The word "est." is in the line itself, not only in the JSON.
  if (rep.advisory && rep.advisory.context_budget) {
    const cbd = rep.advisory.context_budget;
    // the per-source skill breakdown is rendered by forge-contextbudget's own skillSourceLine() so the doctor
    // line and the tool's CLI can never quote different numbers (2026-08-01: the meter counted only this
    // project's 57 skills while the session carries 278, and the doctor line repeated that figure as if it
    // were the whole surface — one number, one renderer, from now on).
    const breakdown = (contextBudgetTool && typeof contextBudgetTool.skillSourceLine === 'function')
      ? contextBudgetTool.skillSourceLine(cbd) : '';
    const head = (cbd.total_approx_tokens || 0) + ' est. tokens always-loaded across ' + ((cbd.posts || []).length)
      + ' post(s)' + (breakdown ? ' · ' + breakdown : '');
    const fnd = cbd.findings || [];
    if (fnd.length) {
      out.push('  ⚠ context budget (advisory, non-blocking): ' + head + ' · ' + fnd.length + ' finding(s): '
        + fnd.slice(0, 3).map((f) => f.detail).join(' · ') + (fnd.length > 3 ? ' · +' + (fnd.length - 3) + ' more' : ''));
    } else {
      const notes = (cbd.notes || []).map((n) => n.detail);
      out.push('  ✓ context budget (advisory): ' + head + ' · ' + (cbd.reason || 'within baseline')
        + (notes.length ? ' · ' + notes.join(' · ') : ''));
    }
  }
  // WAVE A / A2 (2026-07-18) + V9-INTEGRATE (2026-07-22): one compact "completeness" advisory line for the
  // checks that remain advisory-only — never folded into ALL GREEN/FAILURES. unregistered_event/
  // check_the_checks moved OUT of this block (2026-07-22) — they are now ordinary ✓/✗ checks-lines above,
  // since they were promoted to ENFORCED (see the header doc's "V9-INTEGRATE enforcement" note).
  if (rep.advisory && rep.advisory.completeness) {
    const cm = rep.advisory.completeness;
    const parts = [];
    if (cm.sync_completeness && !cm.sync_completeness.ok) parts.push('sync-completeness: ' + (cm.sync_completeness.missing ? cm.sync_completeness.missing.length + ' file(s) not in FILES manifest' : (cm.sync_completeness.reason || 'unavailable')));
    if (cm.memory_discipline && !cm.memory_discipline.ok) parts.push('memory-discipline: ' + (cm.memory_discipline.reason || 'unfilled placeholder(s)'));
    if (cm.mcp_dormancy && !cm.mcp_dormancy.ok) parts.push('mcp-dormancy: ' + (cm.mcp_dormancy.violations ? cm.mcp_dormancy.violations.length + ' violation(s)' : (cm.mcp_dormancy.reason || 'unavailable')));
    if (cm.quality_catalog && !cm.quality_catalog.ok) parts.push('quality-catalog: ' + (cm.quality_catalog.reason || 'drift'));
    if (cm.run_contract && !cm.run_contract.ok) parts.push('run-contract: ' + (cm.run_contract.missing ? cm.run_contract.missing.length + ' rule(s) missing on latest dispatched run ' + (cm.run_contract.run_id || '') : (cm.run_contract.reason || 'unavailable')));
    if (cm.skill_evals && !cm.skill_evals.ok) {
      const se = cm.skill_evals;
      const failNames = (se.skills || []).filter((s) => !s.ok).map((s) => s.error ? (s.skill + ' (config error: ' + s.error + ')') : (s.skill + ' (' + s.failed + '/' + s.total + ' assertion(s) failed: ' + s.results.filter((r) => !r.ok).map((r) => r.id).join(', ') + ')'));
      parts.push('skill-evals: ' + (failNames.length ? failNames.join('; ') : (se.reason || 'unavailable')));
    }
    // wp-disclosure-ab (2026-07-31): skill_hygiene's clean-branch text carries a REAL count ("skill hygiene
    // N/M") rather than a static phrase, per the work package's requested format — computed once so it is
    // available to whichever branch below actually fires. An unhealthy result still names the failing
    // skill(s) in `parts`, the exact same convention every other completeness sub-check above already uses.
    let skillHygieneCleanText = '';
    if (cm.skill_hygiene) {
      const sh = cm.skill_hygiene;
      if (!sh.ok) {
        const failNames = (sh.skills || []).filter((s) => !s.ok).map((s) => s.skill + ' (' + s.issues.join('; ') + ')');
        parts.push('skill-hygiene: ' + (failNames.length ? failNames.join('; ') : (sh.reason || 'unavailable')));
      } else {
        skillHygieneCleanText = ' · skill hygiene ' + sh.skills.filter((s) => s.ok).length + '/' + sh.checked;
      }
    }
    out.push(parts.length
      ? '  ⚠ completeness (advisory, non-blocking): ' + parts.join(' · ')
      : '  ✓ completeness (advisory): sync manifest complete · memory populated · mcp dormant/least-privilege · run contract satisfied · skill evals green' + skillHygieneCleanText);
  }
  // wp17 (2026-09-24): one line per beginner-setup check, ALWAYS printed (a beginner reads these for the info
  // as much as for the warnings). ⚠ = warn, ℹ = info/note, ✓ = ok / not applicable — never a ✗, never in the
  // verdict. `note` (wp-l1, loop iteration 1: settings-wired) is the same non-judgmental ℹ treatment as
  // `info` — "could not compare" is not a warning, it is a fact about what data was available.
  if (rep.advisory && rep.advisory.beginner_setup && rep.advisory.beginner_setup.checks) {
    for (const bc of Object.values(rep.advisory.beginner_setup.checks)) {
      const warn = bc.level === 'warn' && !bc.overridden;
      const icon = warn ? '⚠' : ((bc.level === 'info' || bc.level === 'note') ? 'ℹ' : '✓');
      out.push('  ' + icon + ' setup ' + bc.id + (warn ? ' (advisory, non-blocking): ' : ' (advisory): ') + (bc.level === 'n-a' ? 'n/a — ' : '') + bc.detail + overrideTag(bc));
      if (Array.isArray(bc.lines)) for (const l of bc.lines) out.push('      │ ' + l);
    }
  }
  out.push(rep.ok ? '  ⇒ ALL GREEN' : '  ⇒ FAILURES ABOVE');
  return out.join('\n');
}

module.exports = {
  nodeCheckAll, runTests, strictEventCheck, spaPresent, leakScan, agentsCheck, chainCheck, rebindingGuard, backfillContinuity, runDoctor, printSummary, secretLabel, parseFrontmatter, parseToolsList, loadToolPolicy, BOSS_NAMES, looksLikeRealSecret, secretPortion, STRONG_PLACEHOLDER_RE, isPatternDefinitionContext, parseEventsJsonlLenient, chainCanon, PATTERN_DEFINITION_PATHS, LEAK_SCAN_MAX_BYTES, LEAK_SCAN_MAX_LINE,
  // 2026-08-02 — nested-repository discovery + per-source accounting for the leak scan (see nestedGitRepos)
  trackedFiles, nestedGitRepos, gitLsFiles, NESTED_REPO_MAX_DEPTH, TEST_FIXTURE_RE,
  // WAVE A / A2 (2026-07-18) — doctor completeness checks
  listSkillFiles, syncCompleteness, countAssertionSites, checkTheChecks, memoryDiscipline, MEMORY_PLACEHOLDER_RE,
  extractKnownEventTypesFromSource, stripJsComments, extractLoggedEventTypes, unregisteredEvent, ASSERTION_SITE_RE, EVENT_TYPE_SHAPE_RE,
  // WAVE G / G-INTEGRATE (2026-07-19)
  mcpDormancy,
  // V9-INTEGRATE (2026-07-22) — run-contract wiring + the enforcement-override recovery path
  latestRunIdFor, runContractDoctorCheck, loadDoctorCheckOverrides, applyDoctorOverride,
  // V9 WAVE 2 (2026-07-22) — dispatched-run-only picker + its shared ranking core (see doc comments above)
  rankRunCandidates, latestDispatchedRunIdFor,
  // wp-skill-evals (2026-07-31) — per-skill binary-evals wiring, advisory-only (see doc comment above)
  skillEvalsDoctorCheck,
  // wp-disclosure-ab (2026-07-31) — progressive-disclosure hygiene, advisory-only (see doc comment above)
  skillHygiene, extractSkillPathRefs, SKILL_DESCRIPTION_MAX_CHARS, SKILL_BODY_MAX_LINES,
  // 2026-08-02 — which tree is this? (installation-pinned assertions ask before they assert; never a check)
  installationProfile, detectVendorPin,
  // "pakket 2" (2026-08-01) — forge-runwatch.cjs wired in as an automatic advisory (see doc comment above)
  runLiveness, LIVENESS_WINDOW_MS, LIVENESS_RUNNING_STATUSES,
  // F-23 (Codex herreview quality-laag, 2026-08-13) — geëxporteerd zodat de quality-suite dit als GEDRAG test (kale root => ok:false), niet als bron-regex
  qualityCatalogDoctorCheck,
  // 2026-08-01 — forge-contextbudget.cjs wired in as an automatic advisory (see contextBudgetCheck above)
  contextBudgetCheck,
  // wp17 (2026-09-24) — beginner setup advisories + the dev-tree marker behind installationProfile()
  beginnerSetup, claudeMdSize, pathTools, bypassMode, wslMntC, claudeDoctorProbe, promptCoachPresent,
  resolveOnPath, readDevTreeMarker, DEV_TREE_MARKER_REL, CLAUDE_MD_MAX_LINES, BEGINNER_PATH_TOOLS,
  TOOL_VERSION_TIMEOUT_MS, CLAUDE_DOCTOR_TIMEOUT_MS, CLAUDE_DOCTOR_MAX_LINES,
  // wp-l1 (2026-09-24, loop iteration 1) — settings-wired beginner-setup check
  settingsWired, settingsTemplatePath,
  // wp-l4 (2026-09-24, loop iteration 4) — model-choice-hint beginner-setup check
  modelChoiceHint,
};

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    /** 2026-09-23 (external audit II-G): --help used to be an unknown flag that fell through into the FULL
     *  multi-minute doctor (and with --run it even wrote doctor.json and logged an event). Help is a
     *  no-op by contract: usage on stdout, exit 0, nothing measured, nothing written. A mistyped flag
     *  likewise refuses instead of silently starting a self-test the caller did not ask for. */
    if (argv.includes('--help') || argv.includes('-h')) {
      console.log('Usage: node forge-doctor.cjs [--root <projectDir>] [--run <run_id>] [--json]');
      console.log('');
      console.log('  Runs the full Forge self-test: every *.test.cjs suite, the leak scan, agent/hook/event checks.');
      console.log('  Takes several minutes. --json prints exactly one JSON report object; --run also writes');
      console.log('  doctor.json into that run and logs a doctor_run event. --help never runs anything.');
      return;
    }
    const bekend = new Set(['--root', '--run', '--json']);
    const onbekend = argv.filter((a, i) => a.startsWith('-') && !bekend.has(a) && !(i > 0 && (argv[i - 1] === '--root' || argv[i - 1] === '--run')));
    if (onbekend.length) {
      console.error('forge-doctor: unknown flag(s) ' + onbekend.join(' ') + ' — see --help. Refusing to start a multi-minute self-test on a mistyped flag.');
      process.exitCode = 2;
      return;
    }
    let root = path.resolve(__dirname, '..', '..'), run = null, wantJson = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--root') root = argv[++i];
      else if (argv[i] === '--run') run = argv[++i];
      else if (argv[i] === '--json') wantJson = true;
    }
    // wp17: the CLI is the one caller that runs the read-only `claude doctor` probe (5 s cap, stdin closed).
    const rep = runDoctor(root, { probeClaudeDoctor: true });
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
