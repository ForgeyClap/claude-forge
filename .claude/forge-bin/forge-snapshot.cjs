#!/usr/bin/env node
'use strict';
/**
 * forge-snapshot.cjs — context-continuity snapshot generator (owner request 2026-07-29: "bij elke 50%
 * context een snapshot.md zodat er geen memory wordt vergeten"). Regenerates `.claude/FORGE_SNAPSHOT.md`
 * from REAL project sources every time it is called — never invents a status, a decision, or a percentage.
 *
 * RESEARCH GROUNDING (Search Boss, forge-2026-07-29-cc-finish, WP-R — do not re-derive, see final report):
 * there is NO context-percentage available to a hook (closed feature request) — only the separate statusline
 * channel exposes `context_window.used_percentage`. This tool NEVER fabricates or estimates a percentage
 * anywhere. The honest triggers are: a PreCompact hook firing (the real "context is filling" signal), a
 * phase boundary, or an explicit `/forge snapshot` command — all passed in via `--reason`.
 *
 * ANTI-DRIFT (critical): section 3 ("Current state") is ALWAYS re-derived fresh from source-of-truth on
 * every call — never patched forward from a previous snapshot. The Mission section is the one deliberate
 * exception: it is copied VERBATIM across regenerations — read from an existing
 * `<!-- MISSION:BEGIN -->...<!-- MISSION:END -->` block if the current `.claude/FORGE_SNAPSHOT.md` already
 * has one; else migrated verbatim from a pre-existing hand-written snapshot's own first `## ` section (a
 * one-time migration path, so a hand-authored stopgap snapshot's mission survives the switch to this tool);
 * else derived from `FORGE_MEMORY.md`'s latest status heading; else an honest, clearly-marked TODO for a
 * human/agent to fill in (never guessed prose).
 *
 * SIZE DISCIPLINE: target <= ~2000 tokens of prose (tokens approximated as chars/4 — a coarse but honest
 * heuristic, not a real tokenizer). Long things are PATHS, never inlined; any generated section (2..9 —
 * Mission is exempt, verbatim always wins) that would exceed its own per-section character budget is cut
 * with an explicit "(truncated — see <path>)" marker rather than silently growing unbounded.
 *
 * EVERY generated claim carries a real evidence pointer (a relative file path, optionally with an event
 * type/heading) or is explicitly marked `unknown` — never a bare, unattributed assertion. Zero dependencies
 * (fs/path/child_process only); reuses forge-manifest.cjs (event reading) and forge-doctor.cjs
 * (run recency ranking) instead of reimplementing either.
 *
 * RUN SELECTION: section 3's Done/In-progress buckets come from the newest run that actually CONTAINS work
 * — the candidate SET and its mtimes from forge-doctor.cjs::rankRunCandidates, then re-ranked by the time of
 * each run's last real WORK event and filtered by content + self-declaration (see pickRun/rankByWorkRecency).
 * "Most recently touched directory" is not enough on either count: a doctor self-check leaves a newer, empty
 * run dir behind, and a maintenance pass that merely appends a bookkeeping event to old runs would otherwise
 * reorder the whole history (a ledger reconciliation did exactly that on 2026-08-01, promoting thirteen July
 * runs to "newest"). Event timestamps are written once and never rewritten; file mtimes are not.
 *
 * MODEL:
 *   write(opts) -> {path, markdown, mission:{block,source}, evidencePointers:[...], runId, reason,
 *     approxTokens} — regenerates and OVERWRITES `.claude/FORGE_SNAPSHOT.md`.
 *   check(opts) -> {ok, exists, path, ageHours, maxAgeHours, stale} — read-only staleness probe (no write).
 *   opts.root — project root override (same convention as forge-manifest.cjs's resolveRoot). opts.reason —
 *   one of REASONS. opts.runId — explicit run id (default: forge-doctor.cjs::latestRunIdFor). opts.now —
 *   Date override (test determinism).
 *
 * CLI:
 *   node forge-snapshot.cjs write [--run <id>] [--reason <precompact-auto|precompact-manual|phase|manual>] [--root <path>] [--json]
 *   node forge-snapshot.cjs check [--max-age-hours <n>] [--root <path>] [--json]
 * Exit codes: write: 0 = written. check: 0 = fresh / 3 = stale or missing. 2 = usage error (both commands).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const manifestMod = require('./forge-manifest.cjs');

const REASONS = new Set(['precompact-auto', 'precompact-manual', 'phase', 'manual']);
const MISSION_BEGIN = '<!-- MISSION:BEGIN -->';
const MISSION_END = '<!-- MISSION:END -->';
const SECTION_CHAR_BUDGET = 900; // ~225 tokens per generated section (2..9) — Mission (1) is exempt
/** RENDER SETS — which event types section 3 turns into a line, and in which bucket.
 *
 *  BREADTH FIX 2026-08-01 (second defect, found by an independent witness): the sets below used to know only
 *  the subagent/check/fix/merge/retest family. Measured consequence on this repo's real
 *  `.claude/forge-runs/forge-2026-07-10-mc-checkup/events.jsonl`: a run that wrote a PRD, opened three
 *  tickets, stored a report artifact, logged an ALL-GREEN doctor and then closed all three tickets with test
 *  evidence rendered NOTHING, counted as zero work events, and was skipped by the picker below.
 *
 *  The members were chosen by inventorying every event type actually present in this project's
 *  `.claude/forge-runs/` (51 distinct types on 2026-08-01), not from imagination, and the admission rule is:
 *  a type is admitted only if it names a real unit of progress AND carries a field this file can render into
 *  a truthful line. Deliberately NOT admitted, with the reason (so the next reader can re-decide knowingly):
 *   - `run_started` — frames the run; section 2 renders it instead, so admitting it here would double-report.
 *   - `agent_progress`, `agent_note` — free-form commentary. `agent_progress` above all: forge-doctor.cjs's
 *     self-check writes exactly that single event, so admitting it would reopen defect #1 verbatim.
 *   - `file_changed`, `memory_updated`/`memory_loaded`, `owner_prefs_loaded`, `skill_loaded`,
 *     `custom_skill_used`, `cost_sampled`, `command_run`, `project_scanned`, `agent_selected`,
 *     `role_map_created`, `mission_blueprint_created`, `mindmap_generated`, `agent_work_package_created`,
 *     `audit_iteration`, `claude_md_updated`, `browser_screenshot_captured` — bookkeeping/telemetry or setup:
 *     they record that something was touched, not that a unit of work reached an outcome.
 *   - `decision_logged` — real, but section 4 already renders decisions (from FORGE_DECISIONS.md).
 *   - `codex_review_started` — a start with no reliable end pairing in the real data; its
 *     `codex_review_completed` is admitted instead. */
const DONE_EVENT_TYPES = new Set([
  // work units that reached a successful outcome
  'wp_completed', 'check_passed', 'quality_gate_passed', 'subagent_completed', 'agent_completed',
  'fix_completed', 'rework_completed', 'retest_completed', 'merge_completed',
  // reviews and verifications that concluded
  'lead_review_completed', 'codex_review_completed', 'dashboard_health_verified', 'research_done',
  // artifacts that now exist because this run produced them
  'final_output_created', 'report_generated', 'prd_generated', 'artifact_stored',
  // the run itself finished
  'run_completed',
]);
const GAP_EVENT_TYPES = new Set([
  'check_failed', 'quality_gate_blocked', 'rework_task_created', 'subagent_failed',
  'audit_finding', 'codex_finding',
]);
/** LIFECYCLE_PAIRS — the "In progress" bucket is exactly {started, never answered}. Each start type is
 *  paired with the end types that resolve it, so a fix/check/rework/dispatch that DID finish is never
 *  reported as still running.
 *  keyMode is data-grounded, not stylistic:
 *   - 'dispatch-role' (subagents only) reproduces the pre-existing key byte-for-byte — real subagent pairs
 *     share a dispatch_id, and where they don't they share agent+role.
 *   - 'actor' drops `role` and reads `to` first, because the real events demand it: this repo's only real
 *     rework pair is `rework_assigned{agent:orchestrator, to:'Build Boss'}` answered by
 *     `rework_completed{agent:'Build Boss', role:'builder'}` — keying on agent+role would leave a finished
 *     rework hanging in "In progress" forever. */
const LIFECYCLE_PAIRS = [
  { start: 'subagent_started', ends: ['subagent_completed', 'subagent_failed'], keyMode: 'dispatch-role' },
  { start: 'agent_started', ends: ['agent_completed'], keyMode: 'actor' },
  { start: 'fix_started', ends: ['fix_completed'], keyMode: 'actor' },
  { start: 'check_started', ends: ['check_passed', 'check_failed'], keyMode: 'actor' },
  { start: 'rework_assigned', ends: ['rework_completed'], keyMode: 'actor' },
];
const LIFECYCLE_START = new Map();
const LIFECYCLE_END = new Map();
for (const p of LIFECYCLE_PAIRS) { LIFECYCLE_START.set(p.start, p); for (const t of p.ends) LIFECYCLE_END.set(t, p); }
const IN_PROGRESS_EVENT_TYPES = new Set(LIFECYCLE_PAIRS.map((p) => p.start));
/** OUTCOME_EVENT_TYPES — types whose BUCKET cannot be decided by the type alone, only by a real field on the
 *  event, so they are classified per-event in currentStateFromEvents (never by a guessed default):
 *   - `doctor_run` — `ok:false` is a gap, anything else is a completed check.
 *   - `ticket_created` / `ticket_updated` — a ticket is aggregated by `ticket_id` and its LAST event decides:
 *     closed => Done, still open => In progress. */
const OUTCOME_EVENT_TYPES = new Set(['doctor_run', 'ticket_created', 'ticket_updated']);
const TICKET_EVENT_TYPES = new Set(['ticket_created', 'ticket_updated']);
/** ADMINISTRATIVE_EVENT_TYPES — renderable, but pure BOOKKEEPING about a run rather than evidence that work
 *  happened IN it (W5, witness-measured 2026-08-01). `run_completed` is the whole set today: a liveness
 *  sweep / reconciliation pass writes one onto a long-dead run ("closed administratively by a liveness
 *  sweep"), and because the picker counted it as work, a run whose ONLY events were `run_started` +
 *  that sweep's `run_completed` out-ranked a run with a genuinely running `subagent_started`.
 *  These types stay in DONE_EVENT_TYPES — section 3 still SHOWS a run_completed for a run that did work —
 *  they simply cannot QUALIFY or DATE a run on their own (see WORK_EVENT_TYPES and runWorkSignal). */
const ADMINISTRATIVE_EVENT_TYPES = new Set(['run_completed']);
/** WORK_EVENT_TYPES — "does this run contain anything a resuming session would actually learn from?"
 *  DERIVED (never hand-listed) from every set section 3 renders: DONE ∪ GAP ∪ IN-PROGRESS ∪ OUTCOME, minus
 *  ADMINISTRATIVE_EVENT_TYPES. That derivation is the point: if a new renderable event type is ever added
 *  above, the run picker below starts honoring it in the same commit — the criterion can never drift away
 *  from what the file actually shows, except for the types explicitly declared administrative right above. */
const WORK_EVENT_TYPES = new Set([...DONE_EVENT_TYPES, ...GAP_EVENT_TYPES, ...IN_PROGRESS_EVENT_TYPES, ...OUTCOME_EVENT_TYPES]
  .filter((t) => !ADMINISTRATIVE_EVENT_TYPES.has(t)));
const CONSIDERED_RENDER_CAP = 8; // how many considered run ids are named inline (rest becomes "+N more")
/** DETAIL FIELDS — the real events carry their text under different keys (measured across this repo's
 *  forge-runs/): `run_completed`/`report_generated` use `task`, `artifact_stored` uses `title`,
 *  `quality_gate_blocked` uses `decision_summary`, `retest_completed` uses `output`, `codex_finding` uses
 *  `issue`. Reading only note/evidence printed "no additional detail logged" while the text sat right
 *  there — the same honest-looking-but-empty failure as the run picker. First non-empty field wins. */
const DONE_DETAIL_FIELDS = ['note', 'evidence', 'decision_summary', 'result', 'output', 'task', 'title', 'status'];
const GAP_DETAIL_FIELDS = ['note', 'reason', 'issue', 'decision_summary', 'evidence', 'task', 'status'];
const START_DETAIL_FIELDS = ['task', 'note', 'detail'];
/** TICKET STATE — three-valued, negation-aware (W2, witness-measured 2026-08-01).
 *
 *  THE DEFECT: closure used to be a single bare word match, `/\b(closed|gesloten|resolved|opgelost)\b/i`,
 *  against the ticket's last note. The word "closed" occurs inside "NOT closed — blocked on owner key", so
 *  the file rendered `ticket tk-1 — closed :: NOT closed — blocked on owner key` — a label contradicting its
 *  own detail on the same line, in a file whose only job is to tell a resuming session the truth.
 *
 *  THE RULE NOW: a closure verdict must survive a negation check, and when the text proves nothing the
 *  answer is `unknown` — never a guess. Three sources, in order of strength:
 *   1. STRUCTURE (no text needed): a ticket whose deciding event is `ticket_created` is open by definition.
 *   2. An explicit `status` FIELD — machine data, so it wins over any prose.
 *   3. The note text, scanned for closure/open TERMS with a negation window in front of each (see
 *      classifyTicketNote). "not/never/niet/geen/nog niet ..." in front of a closure term flips it.
 *  Contradictory text (an affirmed closure AND an affirmed open marker) yields `unknown` rather than
 *  picking a winner. Everything except case 1/2 is declared `inferred` in the honesty footer. */
const TICKET_STATUS_CLOSED_RE = /^(closed|close|done|resolved|complete|completed|gesloten|opgelost|afgerond|klaar)\b/i;
const TICKET_STATUS_OPEN_RE = /^(open|new|todo|backlog|doing|wip|in[\s_-]?progress|blocked|pending|reopened|geblokkeerd)\b/i;
const TICKET_CLOSE_TERMS = new Set(['closed', 'resolved', 'gesloten', 'opgelost', 'afgerond', 'afgesloten']);
const TICKET_OPEN_TERMS = new Set(['open', 'unresolved', 'onopgelost', 'blocked', 'geblokkeerd', 'reopened', 'heropend', 'pending']);
/** NEGATORS — words that, standing within NEGATION_WINDOW tokens BEFORE a term, invert it. Deliberately a
 *  closed list of plain negation words (EN + NL, plus the contraction forms the real notes use), so the
 *  check stays explainable: this is "is the claim negated", not sentiment analysis. */
const TICKET_NEGATORS = new Set([
  'not', 'no', 'never', 'without', 'isnt', 'isn', 'wasnt', 'wasn', 'arent', 'aren', 'cannot', 'cant', 'can',
  'wont', 'won', 'couldnt', 'couldn', 'didnt', 'didn', 'un', 'yet',
  'niet', 'geen', 'nooit', 'nog', 'zonder',
]);
const NEGATION_WINDOW = 3;

// ---- root / path resolution (mirrors forge-manifest.cjs::resolveRoot) ----
function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.FORGE_PROJECT_ROOT) return path.resolve(process.env.FORGE_PROJECT_ROOT);
  return path.resolve(__dirname, '..', '..');
}
function claudeDir(root) { return path.join(root, '.claude'); }
function rel(root, p) { return path.relative(root, p).split(path.sep).join('/'); }
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJsonSafe(p) { const t = readFileSafe(p); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } }

// ---- generic markdown-heading parsing (## level) ----
function headingMatches(text) { return text ? [...text.matchAll(/^##\s+.*$/gm)] : []; }
/** firstHeadingBlock — for newest-first files (FORGE_MEMORY.md, FORGE_TASK_HISTORY.md: new entries are
 *  PREPENDED, confirmed against this project's own real files) — the topmost `## ` heading is the latest. */
function firstHeadingBlock(text) {
  const ms = headingMatches(text);
  if (!ms.length) return null;
  const m = ms[0];
  const end = ms.length > 1 ? ms[1].index : text.length;
  return { heading: m[0].replace(/^##\s+/, '').trim(), body: text.slice(m.index, end).trim() };
}
/** lastHeadingBlock — for genuinely append-only files (tasks/WORK_PACKAGES.md's own header: "Append-only
 *  log ... never wipe prior entries") — the bottom-most `## ` heading is the latest. */
function lastHeadingBlock(text) {
  const ms = headingMatches(text);
  if (!ms.length) return null;
  const m = ms[ms.length - 1];
  return { heading: m[0].replace(/^##\s+/, '').trim(), body: text.slice(m.index).trim() };
}

// ---- Mission block resolution (see file header ANTI-DRIFT) ----
function extractMissionBlock(existingText) {
  if (!existingText) return null;
  const bi = existingText.indexOf(MISSION_BEGIN);
  const ei = existingText.indexOf(MISSION_END);
  if (bi === -1 || ei === -1 || ei < bi) return null;
  return existingText.slice(bi, ei + MISSION_END.length);
}
/** extractFirstSectionBody — best-effort migration path: the body of a pre-existing hand-written snapshot's
 *  FIRST `## ` section (this tool's own template convention treats section 1 as "Mission"). Generic: any
 *  project's prior hand-authored snapshot following that same convention migrates cleanly. */
function extractFirstSectionBody(existingText) {
  if (!existingText) return null;
  const lines = existingText.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^##\s+/.test(l));
  if (idx === -1) return null;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) { if (/^##\s+/.test(lines[i])) { end = i; break; } }
  const body = lines.slice(idx + 1, end).join('\n').trim();
  return body || null;
}
function wrapMission(text) { return MISSION_BEGIN + '\n' + text.trim() + '\n' + MISSION_END; }
function resolveMission(root, existingText) {
  const marker = extractMissionBlock(existingText);
  if (marker) return { block: marker, source: 'preserved verbatim from the existing MISSION marker' };
  const migrated = extractFirstSectionBody(existingText);
  if (migrated) {
    return {
      block: wrapMission(migrated),
      source: 'migrated verbatim from a pre-existing hand-written snapshot\'s first section (no MISSION marker existed yet) — preserved going forward',
    };
  }
  const memText = readFileSafe(path.join(claudeDir(root), 'FORGE_MEMORY.md'));
  const memBlock = firstHeadingBlock(memText);
  if (memBlock) {
    const firstLine = memBlock.body.split(/\r?\n/).find((l) => l.trim() && !/^##\s+/.test(l));
    if (firstLine) {
      return {
        block: wrapMission(firstLine.trim()),
        source: 'derived from FORGE_MEMORY.md\'s latest status heading (no MISSION marker or prior snapshot found — refine by hand if imprecise)',
      };
    }
  }
  return {
    block: wrapMission('TODO: no MISSION text found yet — write one paragraph describing what this project/run is building; it will be preserved verbatim on every future regeneration.'),
    source: 'no source found — honest TODO placeholder',
  };
}

// ---- FORGE_DECISIONS.md (append-only: table rows + trailing bullet lines, in document order) ----
function extractDecisions(text, n) {
  if (!text) return [];
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const tm = line.match(/^\|\s*(\d{4}-\d{2}-\d{2}[^|]*)\|\s*([^|]+?)\s*\|/);
    if (tm && !/^-+$/.test(tm[2]) && tm[2].trim() !== 'Decision') { rows.push({ label: tm[1].trim(), text: tm[2].trim() }); continue; }
    const bm = line.match(/^-\s+(.+)$/);
    if (bm) rows.push({ label: null, text: bm[1].trim() });
  }
  return rows.slice(-n);
}

// ---- open-item derivation (TODO_GRAPH.md table, or WORK_PACKAGES.md's latest WP-ID/Status lines) ----
function openFromTodoGraph(text, relPath, cap) {
  if (!text) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(WP\S+)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*$/);
    if (!m) continue;
    const status = m[6].trim();
    if (!status || /^Status$/i.test(status) || /^-+$/.test(status) || /^(COMPLETED|DONE)\b/i.test(status)) continue;
    out.push({ label: m[1].trim() + ' — ' + m[2].trim(), detail: status.slice(0, 140), evidence: relPath });
  }
  return out.slice(-cap);
}
function openFromWorkPackages(text, relPath, cap) {
  if (!text) return [];
  const last = lastHeadingBlock(text);
  if (!last) return [];
  const out = [];
  const re = /^WP-ID:\s*([^·|]+?)\s*[·|].*?Status:\s*(.+)$/gm;
  let m;
  while ((m = re.exec(last.body)) !== null) {
    const status = m[2].trim();
    if (/^(DONE|COMPLETED)\b/i.test(status)) continue;
    out.push({ label: 'WP ' + m[1].trim(), detail: status.slice(0, 140), evidence: relPath + ' (' + last.heading + ')' });
  }
  return out.slice(-cap);
}

// ---- latest run + its events.jsonl (reuses forge-manifest.cjs + forge-doctor.cjs — never reimplemented) ----
/** FUTURE_TOLERANCE_MS — how far ahead of "now" an event's self-declared `timestamp` may sit before this
 *  file refuses to DATE a run by it (W1-CLOCK, 2026-08-01).
 *
 *  WHY A HORIZON EXISTS AT ALL: W1a (see rankByWorkRecency) moved the ordering key off file mtime and onto
 *  the events' own `timestamp` field, because a mtime is metadata any passing tool can rewrite. That was
 *  right, but it swapped one unbounded key for another: a mtime is at least bounded by the filesystem
 *  clock, whereas `timestamp` is self-declared text that nothing here validated. Proven by a witness on
 *  this project: a single event dated 2099-01-01 made a 10 July run outrank a full night of 31 July work,
 *  and the generated snapshot printed "last real work event at 2099-01-01T00:00:00.000Z" as plain fact —
 *  a fabricated claim inside a file whose own footer promises evidence-backed honesty. (Scanned the same
 *  day: 845 real events, 0 in the future. This is a latent defect being closed, not an active incident.)
 *
 *  WHY 24 HOURS, specifically:
 *   - It must cover honest clock skew, because events are written by log-event.cjs on whatever machine or
 *     agent happens to run — and the realistic accidental skew is a timezone/DST misconfiguration (a host
 *     writing LOCAL time with a `Z` suffix). The widest real UTC offset in use is +14:00, so a full
 *     day comfortably absorbs every timezone mistake plus NTP/CMOS drift on top.
 *   - Nothing legitimate lands in the band it rejects. The gap between "honest skew" (hours) and the
 *     errors worth catching is enormous: a typo'd month is ~30 days out, the witness is ~73 years out.
 *     There is no plausible event class between 24h and forever, so a wider horizon buys no safety and a
 *     narrower one starts punishing real clock drift.
 *   - It fails SOFT, which is what lets the number be approximate: an event past the horizon is still
 *     counted as real work (the run is never erased) — it just cannot DATE the run, and the rejection is
 *     disclosed. The cost of a slightly-wrong horizon is therefore a disclosed fallback, never lost work.
 *  Overridable per call via opts.futureToleranceMs for tests and for any caller with a better local rule. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** runWorkSignal(root, runId, opts) -> {workEvents, lastWorkAtMs, lastWorkAt, startedAtMs, startedAt,
 *  implausibleWorkEvents, implausibleLatestAt} — how much real work a run carries, when that work last
 *  happened, and when the run itself began; read through the same manifest reader section 3 itself uses
 *  (so an unparseable line is skipped identically in both places — the picker can never count an event the
 *  renderer would then drop).
 *
 *  Both times come from the events' own `timestamp` fields, which are written once when the event happens
 *  and are never rewritten — unlike a file mtime, which is the whole point of W1 (see rankByWorkRecency).
 *  Either is null when no such event carries a parseable timestamp; the caller then falls down the ladder
 *  and SAYS which rung it used, rather than inventing a time.
 *
 *  PLAUSIBILITY (W1-CLOCK, 2026-08-01 — see FUTURE_TOLERANCE_MS above for the witness and the horizon's
 *  defence): a timestamp beyond now + FUTURE_TOLERANCE_MS cannot be true, so it is refused as a DATE — for
 *  a work event and for `run_started` alike. Refused, not deleted: the event still counts in `workEvents`
 *  (it is genuine renderable work; only its clock is wrong), dating simply falls back to the newest
 *  PLAUSIBLE work event, and when there is none the caller drops a rung. Every rejection is surfaced in
 *  `implausibleWorkEvents` + `implausibleLatestAt` so the rung actually used can be explained in the
 *  generated file instead of a bogus date being shown as fact. */
function runWorkSignal(root, runId, opts) {
  opts = opts || {};
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : (Number.isFinite(opts.now) ? opts.now : Date.now());
  const toleranceMs = Number.isFinite(opts.futureToleranceMs) && opts.futureToleranceMs >= 0 ? opts.futureToleranceMs : FUTURE_TOLERANCE_MS;
  const horizonMs = nowMs + toleranceMs;
  const events = manifestMod.readEventsJsonl(manifestMod.eventsPath(root, runId));
  let workEvents = 0, lastWorkAtMs = null, lastWorkAt = null, startedAtMs = null, startedAt = null;
  let implausibleWorkEvents = 0, implausibleLatestMs = null, implausibleLatestAt = null;
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const rawMs = Date.parse(e.timestamp);
    const plausible = Number.isFinite(rawMs) && rawMs <= horizonMs;
    const ms = plausible ? rawMs : NaN;
    if (e.event_type === 'run_started' && Number.isFinite(ms) && startedAtMs === null) { startedAtMs = ms; startedAt = String(e.timestamp); }
    if (!WORK_EVENT_TYPES.has(e.event_type)) continue;
    workEvents++;
    if (Number.isFinite(rawMs) && !plausible) {
      implausibleWorkEvents++;
      if (implausibleLatestMs === null || rawMs > implausibleLatestMs) { implausibleLatestMs = rawMs; implausibleLatestAt = String(e.timestamp); }
      continue;
    }
    if (Number.isFinite(ms) && (lastWorkAtMs === null || ms > lastWorkAtMs)) { lastWorkAtMs = ms; lastWorkAt = String(e.timestamp); }
  }
  return { workEvents, lastWorkAtMs, lastWorkAt, startedAtMs, startedAt, implausibleWorkEvents, implausibleLatestAt, horizonMs };
}
/** runWorkEventCount — count-only wrapper (kept: it is exported and reads clearly at call sites). */
function runWorkEventCount(root, runId) { return runWorkSignal(root, runId).workEvents; }
/** readRunMeta — a run's own run.json, parsed, or null (missing/unparseable is never an error here). */
function readRunMeta(root, runId) {
  return readJsonSafe(path.join(claudeDir(root), 'forge-runs', runId, 'run.json'));
}
/** SYNTHETIC_DECLARATION_FIELDS — the MACHINE-READABLE fields by which a run declares itself to be seed /
 *  demo / fixture data rather than real work (W1b). Booleans only: no text matching, no run-id name
 *  blacklist (a name rule would only describe today's one directory and would mislabel a genuinely real run
 *  that happens to be called "demo-…" — see the test that locks exactly that down).
 *
 *  MEASURED CASE THIS EXISTS FOR (owner agent, this project, 2026-08-01):
 *  `.claude/forge-runs/forge-demo-10agents-layout-preview/run.json` states of itself
 *      "request": "DEMO LAYOUT PREVIEW — 10 agents (geen echt werk, alleen UI-demo)"
 *  and already carried `"_demo": true`. Its 38 events are shaped exactly like real work
 *  ("docs-boss — check_passed — DEMO LAYOUT PREVIEW — geen echt bewijs"), so NO content rule can distinguish
 *  them — only the run's own declaration can. `synthetic` is the forward-looking name; `_demo` is honored
 *  because it is the field the real run already carries and means the same thing. */
const SYNTHETIC_DECLARATION_FIELDS = ['synthetic', '_demo'];
/** syntheticDeclaration(meta) -> {synthetic, field, quote} — only `=== true` counts; anything else (absent,
 *  falsy, a string, an object) is NOT a declaration and the run is judged on content like any other. */
function syntheticDeclaration(meta) {
  if (!meta || typeof meta !== 'object') return { synthetic: false, field: null, quote: null };
  for (const f of SYNTHETIC_DECLARATION_FIELDS) {
    if (meta[f] === true) {
      const quote = typeof meta.request === 'string' && meta.request.trim() ? meta.request.trim().slice(0, 160) : null;
      return { synthetic: true, field: f, quote };
    }
  }
  return { synthetic: false, field: null, quote: null };
}
/** rankByWorkRecency(root, ranked) -> rows sorted NEWEST-FIRST BY REAL WORK (W1a).
 *
 *  THE DEFECT (owner agent, live on this project, 2026-08-01): recency came from forge-doctor.cjs::
 *  rankRunCandidates, which ranks by the max of events.jsonl / run.json / directory MTIME. In the night of
 *  2026-08-01 a ledger reconciliation appended a `decision_logged` event to 13 old July runs, restamping
 *  every one of them to ~01:21:50Z — so thirteen runs from 10-15 July became "the newest three-quarters of
 *  the list" and the snapshot reported one of them as the current run. A file mtime is metadata that any
 *  tool (a reconciliation pass, a backup, a checkout, an antivirus scanner) can rewrite without a single
 *  unit of work having happened; it is the wrong measure of "what was this project last actually doing".
 *
 *  THE RULE NOW — a three-rung ladder, every rung read from data written ONCE and never rewritten, with the
 *  rung actually used recorded in `timeBasis` so the ordering stays checkable from the generated file:
 *   1. `lastWorkAtMs` — the timestamp of the run's own most recent WORK_EVENT_TYPES event (which excludes
 *      administrative types, W5, so a sweep-written `run_completed` cannot date a dead run either).
 *   2. `startedAtMs` — the run's own `run_started` timestamp, for a run that logged NO work event. Measured
 *      live on 2026-08-01 while regenerating the real snapshot after rung 1 landed: rung-2 used to be mtime,
 *      and because the same reconciliation had rewritten that too, section 2 announced "**A NEWER run
 *      recorded a different mission.** `forge-2026-07-13-scout-loop` is newer than the source run above" and
 *      quoted a 13 July mission above a 31 July one — the same defect, one rung down. A run that never
 *      logged work still has exactly one honest timestamp: when it started. This also keeps the genuinely
 *      important case working — a run that JUST started ranks newest and section 2 discloses its mission.
 *   3. MTIME, last resort, for a run with no timestamped work event and no timestamped `run_started` at all.
 *  Ties fall back to mtime, then to the name, matching rankRunCandidates.
 *
 *  W1-CLOCK (2026-08-01): every rung above reads a SELF-DECLARED timestamp, so each is first tested for
 *  plausibility (see FUTURE_TOLERANCE_MS / runWorkSignal). An impossible future timestamp cannot date a run
 *  on any rung; the run falls to the next rung and `timeBasis` states that it did, and names the rejected
 *  timestamp. Rung 3 (mtime) is machine-clock-bounded and needs no such test. */
function rankByWorkRecency(root, ranked, opts) {
  opts = opts || {};
  const rows = ranked.map((c) => {
    const sig = runWorkSignal(root, c.name, opts);
    const decl = syntheticDeclaration(readRunMeta(root, c.name));
    // W1-CLOCK: a refused timestamp is NEVER silent. Whichever rung ends up carrying the ordering, the fact
    // that a later-but-impossible timestamp was set aside is appended to timeBasis — which pickRun() and
    // describeConsidered() already render — so the generated file explains its own ordering instead of
    // either quoting a 2099 date as fact or quietly showing an older one with no reason given.
    const rejection = sig.implausibleWorkEvents > 0
      ? ' [' + sig.implausibleWorkEvents + ' later work event' + (sig.implausibleWorkEvents === 1 ? '' : 's')
        + ' IGNORED for dating: implausible timestamp' + (sig.implausibleWorkEvents === 1 ? '' : 's')
        + ' beyond the clock-skew horizon (latest: ' + sig.implausibleLatestAt + ')]'
      : '';
    return {
      name: c.name, mtimeMs: c.mtimeMs, workEvents: sig.workEvents,
      lastWorkAtMs: sig.lastWorkAtMs, lastWorkAt: sig.lastWorkAt,
      startedAtMs: sig.startedAtMs, startedAt: sig.startedAt,
      implausibleWorkEvents: sig.implausibleWorkEvents, implausibleLatestAt: sig.implausibleLatestAt,
      timeBasis: (sig.lastWorkAtMs !== null ? 'last real work event'
        : sig.startedAtMs !== null ? 'its own run_started timestamp (this run logged no datable work event)'
          : 'file mtime (this run has neither a datable work event nor a timestamped run_started)') + rejection,
      synthetic: decl,
    };
  });
  const key = (r) => (r.lastWorkAtMs !== null ? r.lastWorkAtMs : r.startedAtMs !== null ? r.startedAtMs : r.mtimeMs);
  rows.sort((a, b) => (key(b) - key(a)) || (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return rows;
}
/** pickRun(root, explicitRunId) -> {runId, considered:[{name, workEvents}], selection}
 *
 *  DEFECT FIXED 2026-08-01 (measured on this project's own snapshot, not assumed): the old picker delegated
 *  straight to forge-doctor.cjs::latestRunIdFor — "the most recently TOUCHED run directory" — so
 *  `.claude/FORGE_SNAPSHOT.md` named `.claude/forge-runs/doctor-selfcheck-2480/` as the latest run and told
 *  every resuming session "_No done-type events found in the latest run._" while 30 sibling run dirs held a
 *  full night of work. That is worse than context loss: the file a session reads back after compaction was
 *  actively misleading, which the project's honesty rule forbids. And it recurs BY DESIGN — forge-doctor.cjs
 *  ::strictEventCheck writes `doctor-selfcheck-<pid>/events.jsonl` (one `agent_progress` event, no run.json)
 *  on every single doctor invocation and its rmSync cleanup can lose the race, leaving a brand-new,
 *  newest-by-mtime, work-less run dir behind.
 *
 *  CRITERION — the newest run that carries >=1 WORK_EVENT_TYPES event AND does not declare itself synthetic.
 *  "Newest" is measured by the run's last real WORK EVENT, not by file mtime (W1a — see rankByWorkRecency
 *  for the measured reason); forge-doctor.cjs::rankRunCandidates still supplies the candidate SET and its
 *  mtimes (one directory-scanning algorithm in this codebase, never a second that could drift), and this
 *  file re-orders that set by work recency and filters it by content + self-declaration.
 *
 *  Two things this criterion deliberately does NOT do, both decided from the real forge-runs/ data:
 *   - it does NOT require a run.json. Measured on 2026-08-01: 6 of the 10 most recent real work runs
 *     (07-26-command-center, 07-27-cc-wp8-13, 07-30-discord, 07-31-ultieme-forge, 07-25-full-audit,
 *     07-11-helpdesk-ai) have NO run.json, so requiring one would skip the newest genuine work — the exact
 *     class of bug being fixed. A run.json is a positive signal, never a gate.
 *   - it does NOT blacklist run-id name patterns (`doctor-selfcheck-*` and friends). A name rule would only
 *     describe the one dir that happened to break us today; a content rule states what the snapshot actually
 *     needs and holds for any future throwaway/self-test run whatever it ends up being called.
 *
 *  When nothing qualifies, runId is null and `considered` carries every candidate examined — the caller
 *  renders that honestly (see buildSections) instead of silently falling back to the first dir it found. */
function pickRun(root, explicitRunId, opts) {
  opts = opts || {};
  if (explicitRunId) {
    return { runId: explicitRunId, considered: [], selection: 'explicit run id supplied by the caller (CLI `--run` / opts.runId) — used as given, not work-filtered' };
  }
  let ranked;
  try {
    const doctorMod = require('./forge-doctor.cjs');
    ranked = doctorMod.rankRunCandidates(root, {});
  } catch {
    return { runId: null, considered: [], selection: 'unknown — the shared run ranker (forge-doctor.cjs::rankRunCandidates) could not be loaded, so no run was selected rather than guessing one' };
  }
  if (!Array.isArray(ranked) || !ranked.length) {
    return { runId: null, considered: [], selection: 'no run directories exist yet under .claude/forge-runs/' };
  }
  const rows = rankByWorkRecency(root, ranked, opts);
  const considered = [];
  for (const row of rows) {
    // skipReason is set for every run that does NOT qualify, and is what section 2 and the honesty footer
    // quote — so a skipped run is always named together with the measured fact that disqualified it.
    const entry = {
      name: row.name, workEvents: row.workEvents, lastWorkAt: row.lastWorkAt, timeBasis: row.timeBasis,
      rankedAt: row.lastWorkAt || row.startedAt || new Date(row.mtimeMs).toISOString(), skipReason: null,
    };
    if (row.synthetic.synthetic) {
      entry.skipReason = 'self-declared synthetic in its own run.json (`' + row.synthetic.field + ': true`' +
        (row.synthetic.quote ? ', whose own `request` reads: "' + row.synthetic.quote + '"' : '') + ')';
    } else if (row.workEvents === 0) {
      entry.skipReason = '0 renderable work events';
    }
    considered.push(entry);
    if (entry.skipReason) continue;
    // HONEST LABEL (fixed 2026-08-01): this used to call every skipped run a "self-test / receipt-only"
    // run — a category nothing in this file ever establishes, i.e. a fabricated claim inside a file whose
    // own footer promises evidence-backed honesty. It states only what was actually measured per named run.
    const skipped = considered.slice(0, considered.length - 1);
    const workless = skipped.filter((x) => x.workEvents === 0 && !/synthetic/.test(x.skipReason));
    const synthetic = skipped.filter((x) => /synthetic/.test(x.skipReason));
    const parts = [];
    if (workless.length) {
      parts.push(workless.length + ' logged no event of a type section 3 renders: ' +
        workless.map((x) => x.name + ' (' + x.workEvents + ' renderable work events)').join(', '));
    }
    if (synthetic.length) {
      parts.push(synthetic.length + ' declared themselves not-real-work: ' +
        synthetic.map((x) => x.name + ' — ' + x.skipReason).join('; '));
    }
    // W1-CLOCK: when this run had a later-but-impossible timestamp set aside, the SELECTED run's own
    // sentence must carry that fact — otherwise the snapshot shows an OLDER date than the events literally
    // contain with no reason given. Only added on the rung-1 branch: the fallback branch below already
    // prints `row.timeBasis`, which carries the same disclosure, and stating it twice in one sentence reads
    // like two separate findings.
    const clockNote = (row.lastWorkAt && row.implausibleWorkEvents > 0)
      ? ' — ' + row.implausibleWorkEvents + ' later work event' + (row.implausibleWorkEvents === 1 ? '' : 's')
        + ' ignored for dating: implausible timestamp beyond the clock-skew horizon (latest: ' + row.implausibleLatestAt + ')'
      : '';
    return {
      runId: row.name,
      considered,
      selection: 'newest run carrying real work (' + row.workEvents + ' renderable work event' + (row.workEvents === 1 ? '' : 's') +
        ', last real work event at ' + (row.lastWorkAt || 'an unrecorded time — ranked by ' + row.timeBasis) + clockNote + ')' +
        (parts.length ? '; ' + skipped.length + ' newer run' + (skipped.length === 1 ? '' : 's') + ' skipped — ' + parts.join('; ') : ''),
    };
  }
  return {
    runId: null,
    considered,
    selection: 'no run with real work found — all ' + considered.length + ' candidate run(s) were skipped: ' +
      considered.map((x) => x.name + ' (' + x.skipReason + ')').join(', '),
  };
}
/** pickRunId — thin back-compat wrapper (id only). Prefer pickRun() when the reason/considered list matters. */
function pickRunId(root, explicitRunId) { return pickRun(root, explicitRunId).runId; }
/** describeConsidered — the honest "which runs did it look at" line, capped so a project with 30+ run dirs
 *  cannot blow the size budget (see file header SIZE DISCIPLINE). */
function describeConsidered(considered) {
  if (!considered || !considered.length) return 'none';
  const shown = considered.slice(0, CONSIDERED_RENDER_CAP).map((c) => {
    // "0 renderable work events" explains its own skip; a run skipped for any OTHER reason (today: a
    // self-declaration in its run.json) would otherwise look arbitrarily passed over, so it carries its
    // reason here too — a named run must never appear next to a count that does not explain the outcome.
    const extra = c.skipReason && c.workEvents > 0 ? ' — skipped: ' + c.skipReason : '';
    // state the time the run was RANKED on and which rung of the ladder it came from — a bare count next to
    // an unexplained ordering is what let a July run be called "newer" than a 31 July one (see W1a).
    const when = c.lastWorkAt ? ', last work event ' + c.lastWorkAt
      : c.rankedAt ? ', ranked by ' + c.timeBasis + ': ' + c.rankedAt : '';
    return c.name + ' (' + c.workEvents + ' renderable work events' + when + ')' + extra;
  });
  const more = considered.length - shown.length;
  return shown.join(', ') + (more > 0 ? ', +' + more + ' more' : '');
}
/** eventText — first non-empty field from an ordered candidate list (see DETAIL FIELDS above). Array fields
 *  (e.g. `files_changed`) are joined rather than stringified into "[object Object]". */
function eventText(e, fields) {
  for (const f of fields) {
    const v = e[f];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length) {
      const joined = v.filter((x) => typeof x === 'string' && x.trim()).join(', ');
      if (joined) return joined;
    }
  }
  return null;
}
function actorLabel(e) { return (e.agent || '?') + (e.role ? ' (' + e.role + ')' : ''); }
/** eventEvidence — the per-item evidence pointer. W1-CLOCK (2026-08-01): the timestamp printed here is the
 *  event's own self-declared text, so when it is beyond the plausibility horizon it is LABELLED rather than
 *  printed bare. Keeping the ranking honest was only half the fix: section 3 rendered
 *  "[subagent_completed@2099-01-01T00:00:00.000Z]" with no qualification at all, i.e. the file still showed
 *  a 2099 date as fact even after the picker had correctly refused to rank by it. The stamp is shown (never
 *  hidden — it is what the events literally contain) and named for what it is. `horizonMs` absent (any
 *  caller that has no clock to compare against) means no labelling, never a fabricated one. */
function eventEvidence(evidenceBase, e, horizonMs) {
  let stamp = '';
  if (e.timestamp) {
    const ms = Date.parse(e.timestamp);
    const implausible = Number.isFinite(horizonMs) && Number.isFinite(ms) && ms > horizonMs;
    stamp = '@' + e.timestamp + (implausible ? ' — IMPLAUSIBLE timestamp (beyond the clock-skew horizon; not used for ordering)' : '');
  }
  return evidenceBase + ' [' + e.event_type + stamp + ']';
}
function stateItem(evidenceBase, e, fields, labelSuffix, horizonMs) {
  return {
    label: actorLabel(e) + ' — ' + e.event_type + (labelSuffix || ''),
    detail: (eventText(e, fields) || 'no additional detail logged').slice(0, 160),
    evidence: eventEvidence(evidenceBase, e, horizonMs),
  };
}
function lifecycleKey(e, pair) {
  if (pair.keyMode === 'dispatch-role') {
    return pair.start + '\u0000' + (e.dispatch_id || ((e.agent || '?') + '::' + (e.role || '')));
  }
  return pair.start + '\u0000' + (e.dispatch_id || e.to || e.agent || '?');
}
/** classifyTicketNote(text) -> {state:'closed'|'open'|'unknown', basis} — see the TICKET STATE block above.
 *  Negation is checked ONLY in front of CLOSURE terms, on purpose: "not closed" genuinely means open, while
 *  a negated OPEN term ("not open") is rare, ambiguous, and would have to be read as a closure — inferring a
 *  closure from a negation is exactly the kind of leap that produced the defect. So an open term always
 *  counts as itself, which also keeps NL "nog open" ("still open") reading as open rather than as noise. */
function classifyTicketNote(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return { state: 'unknown', basis: 'no text to read' };
  const tokens = raw.toLowerCase().split(/[^a-zà-ÿ]+/).filter(Boolean);
  let affirmedClose = null, negatedClose = null, affirmedOpen = null;
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (TICKET_CLOSE_TERMS.has(w)) {
      let negated = false;
      for (let j = Math.max(0, i - NEGATION_WINDOW); j < i; j++) { if (TICKET_NEGATORS.has(tokens[j])) { negated = true; break; } }
      if (negated) negatedClose = negatedClose || w; else affirmedClose = affirmedClose || w;
    } else if (TICKET_OPEN_TERMS.has(w)) {
      affirmedOpen = affirmedOpen || w;
    }
  }
  if (affirmedClose && affirmedOpen) {
    return { state: 'unknown', basis: 'the note asserts both a closure ("' + affirmedClose + '") and an open marker ("' + affirmedOpen + '") — contradictory, so no verdict' };
  }
  if (affirmedClose) return { state: 'closed', basis: 'un-negated closure term "' + affirmedClose + '" in the last note' };
  if (affirmedOpen) return { state: 'open', basis: 'open marker "' + affirmedOpen + '" in the last note' };
  if (negatedClose) return { state: 'open', basis: 'the last note NEGATES the closure ("' + negatedClose + '" is preceded by a negation)' };
  return { state: 'unknown', basis: 'the last note states neither a closure nor an open marker' };
}
/** classifyTicketState(e) -> {state:'closed'|'open'|'unknown', basis} — the ticket's state from its DECIDING
 *  (last) event: structure first, then the explicit `status` field, then the negation-aware note reading. */
function classifyTicketState(e) {
  const status = typeof e.status === 'string' ? e.status.trim() : '';
  if (status) {
    if (TICKET_STATUS_CLOSED_RE.test(status)) return { state: 'closed', basis: 'explicit `status` field: "' + status + '"' };
    if (TICKET_STATUS_OPEN_RE.test(status)) return { state: 'open', basis: 'explicit `status` field: "' + status + '"' };
    return { state: 'unknown', basis: 'explicit `status` field "' + status + '" matches neither a closed nor an open value' };
  }
  if (e.event_type === 'ticket_created') return { state: 'open', basis: 'its last event is `ticket_created` — a created ticket is open by definition, no text needed' };
  return classifyTicketNote(e.note || e.detail);
}
/** ticketIsClosed — back-compat boolean (kept because it was exported). Only a PROVEN closure is true; both
 *  `open` and `unknown` are false, so an unprovable ticket can never be rendered as Done. */
function ticketIsClosed(e) { return classifyTicketState(e).state === 'closed'; }
const TICKET_STATE_LABEL = { closed: 'closed', open: 'open', unknown: 'status unknown' };
/** BUCKET CAPS (W3, witness-measured 2026-08-01) — THE DEFECT: tickets were appended AFTER the event loop
 *  and the bucket was then cut with `done.slice(-8)`, which keeps the TAIL. Measured: a run with 9 closed
 *  tickets plus a `fix_completed` and a `subagent_completed` rendered a Done list of 9 tickets and 0 of the
 *  2 real work events — tickets structurally crowded out exactly what a resuming session needs most.
 *  THE RULE NOW: work events and tickets are two separate groups with two separate caps, work is rendered
 *  FIRST, and whatever is cut is COUNTED and stated in the file (see splitBucket). Totals are unchanged
 *  (6 + 2 = the old 8), so this is a fair split of the same budget, not a size increase. */
const DONE_WORK_CAP = 6, DONE_TICKET_CAP = 2;
const PROGRESS_WORK_CAP = 6, PROGRESS_TICKET_CAP = 2;
const GAP_CAP = 6;
/** splitBucket — newest-kept caps per group + an explicit, honest omission note (never a silent cut). */
function splitBucket(work, tickets, workCap, ticketCap, bucketName, evidenceBase) {
  const w = work.slice(-workCap);
  const t = tickets.slice(-ticketCap);
  const parts = [];
  if (work.length > w.length) parts.push((work.length - w.length) + ' of ' + work.length + ' work events');
  if (tickets.length > t.length) parts.push((tickets.length - t.length) + ' of ' + tickets.length + ' tickets');
  return {
    items: w.concat(t),
    note: parts.length
      ? '_(' + parts.join(' and ') + ' omitted from ' + bucketName + ' — newest kept; full list: ' + evidenceBase + ')_'
      : null,
  };
}
function currentStateFromEvents(root, runId, opts) {
  if (!runId) return { done: [], doneNote: null, inProgress: [], inProgressNote: null, gaps: [] };
  opts = opts || {};
  const events = manifestMod.readEventsJsonl(manifestMod.eventsPath(root, runId));
  const evidenceBase = '.claude/forge-runs/' + runId + '/events.jsonl';
  // W1-CLOCK: the same plausibility horizon the picker uses, so a timestamp the RANKING refused to trust is
  // not then rendered as bare fact three sections further down. Omitting `now` disables the labelling
  // entirely rather than defaulting to a second, different clock.
  const horizonMs = (opts.now instanceof Date || Number.isFinite(opts.now))
    ? (opts.now instanceof Date ? opts.now.getTime() : opts.now)
      + (Number.isFinite(opts.futureToleranceMs) && opts.futureToleranceMs >= 0 ? opts.futureToleranceMs : FUTURE_TOLERANCE_MS)
    : null;
  /** started: key -> ARRAY of unresolved start events (W4, witness-measured 2026-08-01). THE DEFECT: this
   *  was a Map of key -> single event, so with keyMode 'actor' a second concurrent start by the SAME actor
   *  OVERWROTE the first, and one completion then deleted the single surviving entry — the file reported
   *  ZERO in progress while a dispatch was genuinely still running. A queue per key fixes both halves: every
   *  concurrent start stays visible, and an end event closes exactly ONE of them (FIFO — the oldest
   *  outstanding start, the only ordering the events themselves support). */
  const started = new Map();
  const tickets = new Map(); // ticket id -> its LAST event (the one that decides the ticket's state)
  const doneWork = [];
  const gaps = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const startPair = LIFECYCLE_START.get(e.event_type);
    if (startPair) {
      const k = lifecycleKey(e, startPair);
      if (!started.has(k)) started.set(k, []);
      started.get(k).push(e);
    }
    const endPair = LIFECYCLE_END.get(e.event_type);
    if (endPair) {
      const k = lifecycleKey(e, endPair);
      const queue = started.get(k);
      if (queue && queue.length) { queue.shift(); if (!queue.length) started.delete(k); }
    }

    if (DONE_EVENT_TYPES.has(e.event_type)) doneWork.push(stateItem(evidenceBase, e, DONE_DETAIL_FIELDS, null, horizonMs));
    else if (GAP_EVENT_TYPES.has(e.event_type)) gaps.push(stateItem(evidenceBase, e, GAP_DETAIL_FIELDS, null, horizonMs));
    else if (e.event_type === 'doctor_run') {
      const red = e.ok === false;
      const suffix = ' (ok:' + (e.ok === true ? 'true' : red ? 'false' : 'not logged') + ')';
      (red ? gaps : doneWork).push(stateItem(evidenceBase, e, red ? GAP_DETAIL_FIELDS : DONE_DETAIL_FIELDS, suffix, horizonMs));
    } else if (TICKET_EVENT_TYPES.has(e.event_type)) {
      // an event without a ticket_id gets its own key so two unidentified tickets are never silently merged
      tickets.set(e.ticket_id || ('(no ticket_id)@' + (e.timestamp || tickets.size)), e);
    }
  }
  const progressWork = [];
  for (const queue of started.values()) {
    for (const e of queue) {
      progressWork.push({
        label: actorLabel(e) + ' — ' + e.event_type,
        detail: (eventText(e, START_DETAIL_FIELDS) || 'started, not yet resolved').slice(0, 160),
        evidence: evidenceBase + ' [' + e.event_type + ', dispatch_id=' + (e.dispatch_id || 'n/a') + ']',
      });
    }
  }
  const doneTickets = [];
  const progressTickets = [];
  for (const [id, e] of tickets) {
    const verdict = classifyTicketState(e);
    (verdict.state === 'closed' ? doneTickets : progressTickets).push({
      label: 'ticket ' + id + ' — ' + TICKET_STATE_LABEL[verdict.state],
      detail: (eventText(e, ['note', 'detail', 'status']) || 'no additional detail logged').slice(0, 160),
      evidence: eventEvidence(evidenceBase, e, horizonMs),
    });
  }
  const done = splitBucket(doneWork, doneTickets, DONE_WORK_CAP, DONE_TICKET_CAP, 'Done', evidenceBase);
  const inProgress = splitBucket(progressWork, progressTickets, PROGRESS_WORK_CAP, PROGRESS_TICKET_CAP, 'In progress', evidenceBase);
  return {
    done: done.items, doneNote: done.note,
    inProgress: inProgress.items, inProgressNote: inProgress.note,
    gaps: gaps.slice(-GAP_CAP),
  };
}

// ---- newest doctor.json (real, non-fabricated doctor summary) ----
function readLatestDoctor(root) {
  const runsDir = path.join(claudeDir(root), 'forge-runs');
  let entries; try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(runsDir, e.name, 'doctor.json');
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs, data: readJsonSafe(p) };
  }
  return best;
}

// ---- git (best-effort; never throws, honest "unavailable" when not a repo / git missing). A tight
// per-call timeout (default 1200ms, override via opts.timeoutMs) keeps the WORST case (3 sequential git
// calls) comfortably under the marker hook's <5s budget even if git is unexpectedly slow — a slow/hung git
// is skipped honestly (available:false-equivalent partial state) rather than blocking the caller. ----
function gitInfo(root, opts) {
  const timeout = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs : 1200;
  const out = { available: false, branch: null, dirty: null, log: [] };
  try {
    const br = spawnSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout });
    if (br.error || br.status !== 0) return out;
    out.available = true;
    out.branch = br.stdout.trim();
    const st = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', timeout });
    out.dirty = st.status === 0 ? st.stdout.trim().length > 0 : null;
    const lg = spawnSync('git', ['-C', root, 'log', '-5', '--pretty=%h %s'], { encoding: 'utf8', timeout });
    if (lg.status === 0) out.log = lg.stdout.split(/\r?\n/).filter(Boolean);
  } catch { /* honest: git unavailable — out stays at defaults */ }
  return out;
}

// ---- truncation (see file header SIZE DISCIPLINE) ----
function truncateSection(text, pointerPath, maxChars) {
  maxChars = maxChars || SECTION_CHAR_BUDGET;
  if (!text || text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars).replace(/\s+\S*$/, '');
  return cut + '\n\n_(truncated — see ' + pointerPath + ')_';
}
function bulletList(items, emptyText) {
  if (!items || !items.length) return emptyText;
  return items.map((it) => '- ' + it.label + (it.detail ? ' — ' + it.detail : '') + (it.evidence ? ' _(evidence: ' + it.evidence + ')_' : '')).join('\n');
}

// ---- gather everything real, once ----
const CONSTRAINT_CANDIDATES = [
  ['CLAUDE.md', 'project rules — isolation, honesty, security posture (highest-priority governance)'],
  ['.claude/config/orchestration/precedence.md', 'ordering of owner instruction vs. standing rules vs. defaults'],
  ['.claude/config/orchestration/FORGE_HARD_RULES.json', 'non-negotiable run-contract rules'],
  ['.claude/config/orchestration/FORGE_STANDING_RULES.json', 'active owner standing rules'],
  ['.claude/config/orchestration/FORGE_AUTONOMY.json', 'autonomy-mode decision policy'],
];
const CORE_EXPECTED_SOURCES = [
  '.claude/FORGE_MEMORY.md', '.claude/FORGE_TASK_HISTORY.md', 'tasks/WORK_PACKAGES.md',
  '.claude/FORGE_DECISIONS.md', '.claude/FORGE_VERSION.json',
];

function gatherEvidence(root, opts) {
  opts = opts || {};
  const pointers = [];
  const add = (p) => { if (p && !pointers.includes(p)) pointers.push(p); };

  const memoryPath = path.join(claudeDir(root), 'FORGE_MEMORY.md');
  const memoryText = readFileSafe(memoryPath);
  const memoryBlock = firstHeadingBlock(memoryText);
  if (memoryBlock) add(rel(root, memoryPath) + ' (' + memoryBlock.heading + ')');

  const taskHistPath = path.join(claudeDir(root), 'FORGE_TASK_HISTORY.md');
  const taskHistText = readFileSafe(taskHistPath);
  const taskHistBlock = firstHeadingBlock(taskHistText);
  if (taskHistBlock) add(rel(root, taskHistPath) + ' (' + taskHistBlock.heading + ')');

  const wpPath = path.join(root, 'tasks', 'WORK_PACKAGES.md');
  const wpText = readFileSafe(wpPath);
  const wpBlock = lastHeadingBlock(wpText);
  if (wpBlock) add(rel(root, wpPath) + ' (' + wpBlock.heading + ')');

  const decisionsPath = path.join(claudeDir(root), 'FORGE_DECISIONS.md');
  const decisionsText = readFileSafe(decisionsPath);
  const decisions = extractDecisions(decisionsText, 5);
  if (decisions.length) add(rel(root, decisionsPath));

  // W1-CLOCK: the plausibility horizon needs a "now". write() already resolves one (opts.now, defaulting to
  // the wall clock) and passes this same opts object straight through, so the picker judges timestamps
  // against exactly the same instant the rest of the snapshot is generated for — never a second clock.
  const runSelection = pickRun(root, opts.runId, { now: opts.now, futureToleranceMs: opts.futureToleranceMs });
  const runId = runSelection.runId;
  const state = currentStateFromEvents(root, runId, { now: opts.now, futureToleranceMs: opts.futureToleranceMs });
  if (runId) add('.claude/forge-runs/' + runId + '/events.jsonl');

  const todoGraphPath = path.join(root, 'command-center', 'mission', 'TODO_GRAPH.md');
  const todoGraphText = readFileSafe(todoGraphPath);
  let openItems = [];
  if (todoGraphText) { openItems = openFromTodoGraph(todoGraphText, rel(root, todoGraphPath), 8); add(rel(root, todoGraphPath)); }
  else { openItems = openFromWorkPackages(wpText, rel(root, wpPath), 8); if (openItems.length) add(rel(root, wpPath)); }

  const versionInfo = readJsonSafe(path.join(claudeDir(root), 'FORGE_VERSION.json'));
  if (versionInfo) add(rel(root, path.join(claudeDir(root), 'FORGE_VERSION.json')));

  const doctorInfo = readLatestDoctor(root);
  if (doctorInfo && doctorInfo.path) add(rel(root, doctorInfo.path));

  const git = gitInfo(root, { timeoutMs: opts.gitTimeoutMs });

  const constraints = CONSTRAINT_CANDIDATES.filter(([p]) => fs.existsSync(path.join(root, p)));

  const keyPaths = [];
  const maybeAdd = (p, label) => { if (fs.existsSync(path.join(root, p))) keyPaths.push([p, label]); };
  maybeAdd('CLAUDE.md', 'project rules');
  maybeAdd('.claude/FORGE_MEMORY.md', 'project memory (status log, newest-first)');
  maybeAdd('.claude/FORGE_TASK_HISTORY.md', 'task history (newest-first)');
  maybeAdd('tasks/WORK_PACKAGES.md', 'work-package log (append-only)');
  if (runId) keyPaths.push(['.claude/forge-runs/' + runId + '/', 'latest run\'s artifacts + events.jsonl']);
  maybeAdd('.claude/forge-dashboard/', 'legacy per-project Control Center');
  maybeAdd('command-center/', 'project-specific product (see its own docs if present)');

  const missingCore = CORE_EXPECTED_SOURCES.filter((p) => !fs.existsSync(path.join(root, p)));

  return {
    memoryBlock, taskHistBlock, wpBlock, decisions, runId, runSelection, state, openItems, versionInfo,
    doctorInfo, git, constraints, keyPaths, missingCore, pointers,
  };
}

/** runStartedMission(root, runId) -> {runId, text, pointer} | null — the mission text a run recorded on its
 *  own `run_started` event.
 *  Field order is data-grounded, not guessed: across this repo's 23 real run_started events the mission text
 *  lives in `task` (5 runs), `note` (16) or `detail` (2 — including BOTH of the newest runs, 07-30-discord
 *  and 07-31-ultieme-forge). Reading only task/note printed "no run_started task text found" while the text
 *  sat in `detail` — the same "honest-looking but empty" failure as the run picker. */
function runStartedMission(root, runId) {
  if (!runId) return null;
  const events = manifestMod.readEventsJsonl(manifestMod.eventsPath(root, runId));
  const started = events.find((e) => e && e.event_type === 'run_started');
  const text = started ? (started.task || started.note || started.detail) : null;
  if (!text || !String(text).trim()) return null;
  return {
    runId,
    text: String(text).trim(),
    pointer: '.claude/forge-runs/' + runId + '/events.jsonl [run_started]',
  };
}
const WHY_QUOTE_BUDGET = 420; // per quoted mission, so a long mission can never truncate away the ATTRIBUTION

/** deriveWhy(root, ev) -> {text, pointer} — section 2.
 *
 *  DEFECT FIXED 2026-08-01 (a regression the run-picker fix introduced, caught by an independent witness):
 *  the Why silently followed whichever run the picker selected. As soon as the picker started skipping the
 *  newest run, section 2 printed the mission of an OLDER run with no attribution at all — grepping the
 *  generated file for "run_started" returned zero hits — so a resuming session read the wrong mission and had
 *  no way to notice. The pre-fix code happened to show the right mission there, so this was strictly worse.
 *
 *  RULE NOW (hard): never quote a mission without naming the run it came from. Two shapes were possible —
 *  follow the selected run, or follow the newest run that has a mission. This takes the first AND discloses
 *  the second, because they answer different questions and a snapshot must not force a reader to pick:
 *   - The lead quote is the SELECTED run's mission, so sections 2 and 3 always describe the SAME run and can
 *     never contradict each other (a Why from run A above a Done list from run B is how this misled once
 *     already).
 *   - If a strictly NEWER run also recorded a `run_started` mission and was skipped by the picker, that
 *     mission is quoted too, named, and labelled with the measured reason it is not the source. That is the
 *     genuinely current intent — a run that just started logs `run_started` and nothing renderable yet, which
 *     is exactly when the divergence occurs — so hiding it would lose the newest state.
 *  Both quotes are attributed inline (run id + `run_started` + an evidence pointer), never by position, and
 *  each is capped separately so the attribution can never be the part that gets truncated away. */
function deriveWhy(root, ev) {
  const sel = (ev && ev.runSelection) || { runId: (ev && ev.runId) || null, considered: [] };
  const selectedId = (ev && ev.runId) || null;
  const considered = Array.isArray(sel.considered) ? sel.considered : [];
  // `considered` is ranked newest-first and the selected run is its last entry, so everything BEFORE the
  // selected run was ranked newer and skipped. With an explicit --run there is no considered list at all.
  const selIdx = selectedId ? considered.findIndex((c) => c && c.name === selectedId) : -1;
  const newerFirst = selIdx >= 0 ? considered.slice(0, selIdx) : (selectedId ? [] : considered.slice());
  const own = runStartedMission(root, selectedId);
  let other = null;
  for (const c of newerFirst) {
    const m = runStartedMission(root, c.name);
    if (m) { other = Object.assign({ workEvents: c.workEvents, skipReason: c.skipReason || null }, m); break; }
  }

  const lines = [];
  if (own) {
    lines.push('Mission of the source run `' + own.runId + '` (section 3 reports on this same run), quoted from its `run_started` event: ' +
      truncateSection(own.text, own.pointer, WHY_QUOTE_BUDGET) + ' _(evidence: ' + own.pointer + ')_');
  } else if (selectedId) {
    lines.push('No `run_started` mission text found in the source run `' + selectedId + '` (its `task`, `note` and `detail` fields are all empty) — see CLAUDE.md and FORGE_MEMORY.md\'s latest status block for project rationale.');
  } else {
    lines.push('No source run was selected (see section 3 for which runs were considered), so there is no run mission to quote — see CLAUDE.md and FORGE_MEMORY.md\'s latest status block for project rationale.');
  }
  if (other) {
    lines.push('');
    lines.push((selectedId
      ? '**A NEWER run recorded a different mission.** `' + other.runId + '` is newer than the source run above but is not what section 3 reports on (' + (other.skipReason || other.workEvents + ' renderable work events') + '). Its own `run_started` mission reads: '
      : '**The only mission text found belongs to a run that is not section 3\'s source.** `' + other.runId + '` was not selected (' + (other.skipReason || other.workEvents + ' renderable work events') + '), so nothing of it is shown in section 3, but its `run_started` mission reads: ') +
      truncateSection(other.text, other.pointer, WHY_QUOTE_BUDGET) + ' _(evidence: ' + other.pointer + ')_');
  }
  return { text: lines.join('\n'), pointer: own ? own.pointer : (other ? other.pointer : '.claude/FORGE_MEMORY.md') };
}

function buildSections(root, ev, mission, meta) {
  const why = deriveWhy(root, ev);
  // Section 3 is fed by TWO sources (the run's events.jsonl for Done/In-progress, TODO_GRAPH.md or
  // WORK_PACKAGES.md for Open), so its truncation pointer names BOTH — a reader whose Open list was cut must
  // be sent to the file the cut text actually lives in, not only to events.jsonl.
  const openSource = (ev.openItems && ev.openItems.length && ev.openItems[0].evidence)
    ? String(ev.openItems[0].evidence).split(' (')[0] : null;
  const currentStatePointer = [
    ev.runId ? ('.claude/forge-runs/' + ev.runId + '/events.jsonl') : '.claude/FORGE_MEMORY.md',
    openSource,
  ].filter(Boolean).join(' + ');
  // section 3 has 3 subsections (done/in-progress/open) — a wider budget than a single-topic section (2x
  // SECTION_CHAR_BUDGET), still hard-capped (never unbounded) via the SAME truncateSection() every other
  // generated section uses. Each subsection's own item list is separately capped upstream too (see
  // currentStateFromEvents/openFrom* `.slice(-n)` calls), so this is belt-and-suspenders, not the only cap.
  // Run line: state WHICH run these Done/In-progress buckets come from and WHY it was chosen — and, when
  // nothing qualified, say so outright and name what was examined instead of leaving a bare "nothing found"
  // that reads like "nothing was done" (the exact way this file misled a resuming session on 2026-07-31).
  const sel = ev.runSelection || { runId: ev.runId || null, considered: [], selection: 'unknown' };
  const runLine = sel.runId
    ? '_Source run: `' + sel.runId + '` — ' + sel.selection + '._'
    : '_**No run with real work found**, so no run is shown here rather than an arbitrary one — ' + sel.selection +
      '. Runs considered (newest-first): ' + describeConsidered(sel.considered) + '._';
  const emptySuffix = sel.runId ? ' in the source run above' : ' (no source run — see the note above)';
  // withNote — the omission counts from splitBucket (W3) are part of the bucket's TRUTH, not decoration:
  // a Done list that silently dropped items reads as a complete list. They are rendered right under it.
  const withNote = (text, note) => (note ? text + '\n' + note : text);
  const currentStateText = truncateSection([
    runLine, '',
    '### Done', withNote(bulletList(ev.state.done, '_No done-type events found' + emptySuffix + '._'), ev.state.doneNote),
    '', '### In progress', withNote(bulletList(ev.state.inProgress, '_No dispatched-but-unresolved subagents found' + emptySuffix + '._'), ev.state.inProgressNote),
    '', '### Open', bulletList(ev.openItems, '_No open-item source (TODO_GRAPH.md / WORK_PACKAGES.md WP-ID/Status lines) found or all items are closed._'),
  ].join('\n'), currentStatePointer, SECTION_CHAR_BUDGET * 2);

  const decisionsText = ev.decisions.length
    ? ev.decisions.map((d) => '- ' + (d.label ? '**' + d.label + '** — ' : '') + d.text).join('\n')
    : '_No decisions found in FORGE_DECISIONS.md._';

  const constraintsText = ev.constraints.length
    ? ev.constraints.map(([p, label]) => '- `' + p + '` — ' + label).join('\n')
    : '_No governing constraint files found at the usual paths._';

  const keyPathsText = ev.keyPaths.length
    ? ev.keyPaths.map(([p, label]) => '- `' + p + '` — ' + label).join('\n')
    : '_No key paths resolved._';

  const gapsText = ev.state.gaps.length
    ? bulletList(ev.state.gaps, '')
    : '_No check_failed/quality_gate_blocked/rework_task_created/subagent_failed events found in the latest run — see FORGE_MEMORY.md\'s latest status block for any narrative limitations not captured as events._';

  const nextActionsText = ev.openItems.length
    ? ev.openItems.map((it) => '- Continue: ' + it.label + ' — ' + it.detail + ' _(evidence: ' + it.evidence + ')_').join('\n')
    : '_No open items resolved from TODO_GRAPH.md / WORK_PACKAGES.md — check FORGE_MEMORY.md\'s "next session" note if one exists._';

  const gitText = ev.git.available
    ? 'Branch `' + ev.git.branch + '`' + (ev.git.dirty === true ? ' (dirty — uncommitted changes present)' : ev.git.dirty === false ? ' (clean)' : '') + '.\n' +
      'Last 5 commits:\n' + (ev.git.log.length ? ev.git.log.map((l) => '- ' + l).join('\n') : '_none_')
    : '_git unavailable or this is not a git repository._';
  const versionText = ev.versionInfo
    ? 'forge_version `' + (ev.versionInfo.forge_version || 'unknown') + '`, synced_at ' + (ev.versionInfo.synced_at || 'unknown') + ', ' + (ev.versionInfo.system_files || '?') + ' system files.'
    : '_.claude/FORGE_VERSION.json not found — sync state unknown._';
  const doctorText = ev.doctorInfo && ev.doctorInfo.data
    ? 'Last doctor receipt: ' + rel(root, ev.doctorInfo.path) + (ev.doctorInfo.data.ok != null ? (' — ok:' + ev.doctorInfo.data.ok) : '')
    : '_No forge-runs/*/doctor.json found yet — doctor status unknown; run `node .claude/forge-bin/forge-doctor.cjs`._';

  const evidencePointersText = ev.pointers.length ? ev.pointers.map((p) => '- ' + p).join('\n') : '_none_';

  const verified = ev.pointers.slice();
  const unknown = ev.missingCore.slice();
  const honestyText = [
    '- Trigger: `' + meta.reason + '` at ' + meta.now.toISOString() + '.',
    '- Vocabulary: **verified** = read directly from the cited file/event · **inferred** = derived via a stated heuristic (a start event with no matching end = in-progress, one end closing exactly one start; a ticket state read from structure (`ticket_created` = open) or an explicit `status` field, else from a NEGATION-AWARE reading of its last note — a negated closure such as "NOT closed" reads as open, and text that proves neither is labelled `status unknown` rather than guessed; a table/status-column string classified into done/in-progress/open) · **unknown** = an expected source file is absent or unparseable — never fabricated.',
    '- Sources verified this run: ' + (verified.length ? verified.join('; ') : 'none'),
    '- Sources unknown/missing (expected but not found): ' + (unknown.length ? unknown.join('; ') : 'none'),
    '- Run selection: ' + (sel.runId ? '`' + sel.runId + '`' : '**none**') + ' — ' + sel.selection +
      '. A run qualifies only by CONTENT (>=1 event of a type section 3 can render, administrative closes like `run_completed` excluded) plus the absence of a machine-readable self-declaration (`synthetic: true` / `_demo: true`) in its own run.json — never by a run-id name pattern. "Newest" is the time of a run\'s last real work event, read from the events themselves, NOT a file mtime: a maintenance pass that merely touches old runs (a ledger reconciliation did exactly that here on 2026-08-01) must not be able to reorder history. Runs considered (newest-first by last real work event): ' + describeConsidered(sel.considered) + '.',
    '- No context-window percentage is available to this tool or to any hook — never fabricated or estimated anywhere in this file (see the file header RESEARCH GROUNDING note).',
    '- Section 3 ("Current state") above is always re-derived fresh from source-of-truth on every regeneration — never patched forward from a prior snapshot.',
    '- Section 1 ("Mission") is preserved verbatim across regenerations — source of this run\'s Mission text: ' + mission.source + '.',
    '- Section 2 ("Why") never quotes a mission without naming the run it came from, and says so explicitly when a newer run recorded a different one — a mission shown without its run once misled a resuming session.',
  ].join('\n');

  return {
    // section 2 can legitimately carry TWO attributed mission quotes (see deriveWhy). Each quote is already
    // capped at WHY_QUOTE_BUDGET, so this outer cap is the same belt-and-suspenders guard section 3 gets —
    // wide enough that it never fires on normal input and therefore never eats an attribution line.
    why: { text: truncateSection(why.text, why.pointer, SECTION_CHAR_BUDGET * 2), pointer: why.pointer },
    currentState: currentStateText,
    keyDecisions: truncateSection(decisionsText, rel(root, path.join(claudeDir(root), 'FORGE_DECISIONS.md'))),
    activeConstraints: truncateSection(constraintsText, 'CLAUDE.md'),
    keyFilePaths: truncateSection(keyPathsText, rel(root, path.join(claudeDir(root), 'FORGE_MEMORY.md'))),
    knownGaps: truncateSection(gapsText, ev.runId ? ('.claude/forge-runs/' + ev.runId + '/events.jsonl') : '.claude/FORGE_MEMORY.md'),
    nextActions: truncateSection(nextActionsText, ev.runId ? ('.claude/forge-runs/' + ev.runId + '/events.jsonl') : 'tasks/WORK_PACKAGES.md'),
    versionText, doctorText, gitText,
    evidencePointers: evidencePointersText,
    honesty: honestyText,
  };
}

function renderMarkdown(mission, sections, meta) {
  return [
    '# FORGE SNAPSHOT — ' + meta.now.toISOString() + ' (auto-generated by forge-snapshot.cjs, reason: ' + meta.reason + ')',
    '',
    '> Regenerated on every call from real project sources. Section 3 is always re-derived; section 1 (Mission) is preserved verbatim. Never edit sections 2-10 by hand — they will be overwritten on the next regeneration. To change the Mission, edit the text between the MISSION markers below.',
    '',
    '## 1. Mission',
    mission.block,
    '',
    '## 2. Why',
    sections.why.text,
    '',
    '## 3. Current state',
    sections.currentState,
    '',
    '## 4. Key decisions',
    sections.keyDecisions,
    '',
    '## 5. Active constraints',
    sections.activeConstraints,
    '',
    '## 6. Key file paths',
    sections.keyFilePaths,
    '',
    'Project version: ' + sections.versionText,
    'Doctor: ' + sections.doctorText,
    'Git: ' + sections.gitText,
    '',
    '## 7. Known gaps / limitations',
    sections.knownGaps,
    '',
    '## 8. Next actions',
    sections.nextActions,
    '',
    '## 9. Evidence pointers',
    sections.evidencePointers,
    '',
    '## 10. Honesty footer',
    sections.honesty,
    '',
  ].join('\n');
}

/** write(opts) -> see file header MODEL. Regenerates and overwrites `.claude/FORGE_SNAPSHOT.md`. */
function write(opts) {
  opts = opts || {};
  const root = resolveRoot(opts.root);
  const snapshotPath = path.join(claudeDir(root), 'FORGE_SNAPSHOT.md');
  const existingText = readFileSafe(snapshotPath);
  const reason = REASONS.has(opts.reason) ? opts.reason : 'manual';
  const now = opts.now instanceof Date ? opts.now : new Date();

  const mission = resolveMission(root, existingText);
  // pass the RESOLVED `now` (opts.now may be absent) so gatherEvidence's plausibility horizon is anchored
  // to the same instant renderMarkdown stamps on the file.
  const ev = gatherEvidence(root, Object.assign({}, opts, { now }));
  const sections = buildSections(root, ev, mission, { reason, now });
  const markdown = renderMarkdown(mission, sections, { reason, now });

  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, markdown, 'utf8');

  return {
    path: snapshotPath, markdown, mission, evidencePointers: ev.pointers, runId: ev.runId,
    runSelection: ev.runSelection, reason, approxTokens: Math.ceil(markdown.length / 4),
  };
}

/** check(opts) -> {ok, exists, path, ageHours, maxAgeHours, stale} — read-only staleness probe. */
function check(opts) {
  opts = opts || {};
  const root = resolveRoot(opts.root);
  const snapshotPath = path.join(claudeDir(root), 'FORGE_SNAPSHOT.md');
  const maxAgeHours = Number.isFinite(opts.maxAgeHours) ? opts.maxAgeHours : 24;
  let st;
  try { st = fs.statSync(snapshotPath); }
  catch { return { ok: false, exists: false, path: snapshotPath, maxAgeHours, stale: true, reason: 'FORGE_SNAPSHOT.md does not exist yet' }; }
  const ageHours = Math.round(((Date.now() - st.mtimeMs) / 3600000) * 100) / 100;
  const stale = ageHours > maxAgeHours;
  return { ok: !stale, exists: true, path: snapshotPath, ageHours, maxAgeHours, stale };
}

module.exports = {
  resolveRoot, write, check,
  extractMissionBlock, extractFirstSectionBody, resolveMission,
  firstHeadingBlock, lastHeadingBlock, extractDecisions,
  openFromTodoGraph, openFromWorkPackages, currentStateFromEvents, gitInfo, readLatestDoctor,
  truncateSection, gatherEvidence, buildSections, renderMarkdown,
  // run selection (fixed 2026-08-01 — see pickRun's doc comment for the measured defect it repairs)
  pickRun, pickRunId, runWorkEventCount, describeConsidered,
  // W1/W5 run-recency + self-declaration (2026-08-01 — see rankByWorkRecency / SYNTHETIC_DECLARATION_FIELDS)
  runWorkSignal, rankByWorkRecency, readRunMeta, syntheticDeclaration,
  // W1-CLOCK (2026-08-01) — the plausibility horizon for self-declared timestamps (see FUTURE_TOLERANCE_MS)
  FUTURE_TOLERANCE_MS,
  // section 2 attribution + section 3 render breadth (both fixed 2026-08-01 — see their doc comments)
  deriveWhy, runStartedMission, eventText,
  // W2 ticket state (2026-08-01 — negation-aware, three-valued)
  ticketIsClosed, classifyTicketState, classifyTicketNote,
  // W3 bucket split (2026-08-01 — tickets can no longer crowd work out of a bucket)
  splitBucket,
  REASONS, MISSION_BEGIN, MISSION_END, SECTION_CHAR_BUDGET,
  DONE_EVENT_TYPES, GAP_EVENT_TYPES, IN_PROGRESS_EVENT_TYPES, OUTCOME_EVENT_TYPES, WORK_EVENT_TYPES,
  ADMINISTRATIVE_EVENT_TYPES, LIFECYCLE_PAIRS,
  DONE_WORK_CAP, DONE_TICKET_CAP, PROGRESS_WORK_CAP, PROGRESS_TICKET_CAP,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { run: null, reason: null, root: null, json: false, maxAgeHours: null, usageError: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--run') opts.run = rest[++i];
    else if (a === '--reason') opts.reason = rest[++i];
    else if (a === '--root') opts.root = rest[++i];
    else if (a === '--max-age-hours') opts.maxAgeHours = Number(rest[++i]);
    else if (a === '--json') opts.json = true;
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return { cmd, opts };
}
function printUsage() {
  console.error('Usage: node forge-snapshot.cjs write [--run <id>] [--reason precompact-auto|precompact-manual|phase|manual] [--root <path>] [--json]');
  console.error('       node forge-snapshot.cjs check [--max-age-hours <n>] [--root <path>] [--json]');
}
if (require.main === module) {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (opts.usageError) { console.error('forge-snapshot: ' + opts.usageError); printUsage(); process.exitCode = 2; }
  else if (cmd === 'write') {
    if (opts.reason && !REASONS.has(opts.reason)) { console.error('forge-snapshot: invalid --reason "' + opts.reason + '"'); printUsage(); process.exitCode = 2; }
    else {
      const result = write({ root: opts.root, runId: opts.run, reason: opts.reason });
      if (opts.json) console.log(JSON.stringify({ path: result.path, runId: result.runId, reason: result.reason, approxTokens: result.approxTokens, evidencePointers: result.evidencePointers }));
      else console.log('forge-snapshot: wrote ' + result.path + ' (reason: ' + result.reason + ', ~' + result.approxTokens + ' tokens, ' + result.evidencePointers.length + ' evidence pointers)');
      process.exitCode = 0;
    }
  } else if (cmd === 'check') {
    const result = check({ root: opts.root, maxAgeHours: opts.maxAgeHours });
    if (opts.json) console.log(JSON.stringify(result));
    else console.log('forge-snapshot: ' + (result.exists ? ('age ' + result.ageHours + 'h (max ' + result.maxAgeHours + 'h) — ' + (result.stale ? 'STALE' : 'fresh')) : 'MISSING (' + result.reason + ')'));
    process.exitCode = result.stale ? 3 : 0;
  } else {
    printUsage();
    process.exitCode = 2;
  }
}
