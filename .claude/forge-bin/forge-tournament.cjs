#!/usr/bin/env node
'use strict';
/**
 * forge-tournament.cjs — Forge best-of-N TOURNAMENT: plan N independent solution variants, score them
 * against a transparent weighted rubric, promote the winner (2026-07-19, PIECE J2). Zero-dependency
 * (fs/path only — no child_process; this tool never runs git itself, see GUARDRAIL 1 below).
 *
 * WHY: for a genuinely wide solution space (several defensible approaches, no single obvious "right"
 * answer), dispatching ONE agent down ONE path risks committing early to a mediocre solution. A tournament
 * plans several DISTINCT angles up front (mvp-first, risk-first, perf-first, ...), lets each run in its own
 * isolated worktree so they never collide, then judges the REAL results against a transparent rubric and
 * promotes the strongest one — while still harvesting good ideas ("grafts") from the runners-up.
 *
 * ══════════════════════════════ HARD GUARDRAILS (every one load-bearing) ══════════════════════════════
 * 1. THIS TOOL NEVER RUNS GIT. `plan()` returns a SUGGESTED worktree path/branch name per variant (mirrors
 *    the `forge-worktrees` skill's `git worktree add <path> -b <branch>` convention) so the caller (Head
 *    Chef / Build Boss) can create the actual worktree itself. Nothing in this file spawns a process or
 *    touches the filesystem outside of `require`/CLI file-argument reads — planning is pure data, never a
 *    claim that a worktree was actually created.
 * 2. SCORE FROM REAL RESULTS ONLY — NEVER FABRICATE. `score()` computes a rubric-weighted number PURELY
 *    from the `metrics`/`rubricScores` the caller supplies for each entry. It never invents a metric,
 *    never guesses a missing value, and never silently defaults a missing criterion to a "fair" score —
 *    an entry missing data for a rubric criterion throws (see `score()` below), exactly like `promote()`
 *    throws on a malformed `ranked` array. A tournament tool that could quietly fabricate a winning score
 *    would be worse than useless — it would launder a coin-flip as a judged decision.
 * 3. HONEST TIES. Two entries with the identical final score are reported as a `tie`, never silently
 *    broken by insertion order alone (a deterministic `id` tiebreak is applied for a STABLE ranking, but
 *    the `tie`/`close_call` flags in `promote()`'s output make the closeness visible to the caller rather
 *    than hiding it).
 * 4. GRAFTS ARE EVIDENCE-BASED. `promote()`'s `grafts` list only ever cites a criterion where a runner-up's
 *    own `breakdown.normalized` value (produced by `score()`, from THAT runner-up's own supplied metrics)
 *    genuinely beat the winner's — never an invented suggestion.
 *
 * MODEL:
 *   plan({task, n, angles}, opts) -> {task, n, angles, worktree_note, variants:[
 *     {id, angle, worktree_hint:{path, branch}, work_package:{task, angle, narrowed_prompt}}, ...]}
 *     `n` defaults to 3. `angles`, if omitted, comes from the built-in DEFAULT_ANGLES rotation (10 distinct
 *     angles); if `n` exceeds the available distinct angles (default or explicitly supplied), plan() throws
 *     rather than silently repeating an angle (repeating an angle isn't a real second variant).
 *   score({entries:[{id, metrics?, rubricScores?}, ...]}, rubric, opts) -> {rubric, entries:[
 *     {id, score, rank, breakdown:[{key, weight, direction, source, raw, normalized, contribution}]}, ...],
 *     tie}
 *     `rubric` = {criteria:[{key, weight, direction?:'max'|'min'}, ...]}. Per criterion, an entry's
 *     `rubricScores[key]` (must be a number in [0,1]) is used directly when present; otherwise its
 *     `metrics[key]` (any finite number) is min-max normalized against every OTHER entry's metric for that
 *     same criterion (direction 'min' inverts so lower-is-better metrics still score higher-is-better). An
 *     entry supplying neither for a given criterion throws (guardrail 2). Entries are ranked descending by
 *     the weight-normalized final score (ties broken deterministically by `id`).
 *   promote({ranked}, opts) -> {winner:{id,score}, runners_up:[{id,score},...], grafts:[{from_id,
 *     criterion, runner_up_normalized, winner_normalized, note}, ...], tie, close_call, margin, notes}
 *     `ranked` is the `entries` array `score()` produced (or any array shaped `{id, score, breakdown?}`).
 *     `close_call` fires when the winner-vs-runner-up relative score gap is <= opts.closeCallMargin
 *     (default 0.03 = 3%) and it is not an exact tie. Malformed `ranked` entries throw — no fabricated
 *     winner (guardrail 2/3).
 *
 * CLI:
 *   node forge-tournament.cjs plan --task "<x>" --n 3 [--angles a,b,c] [--json]
 *   node forge-tournament.cjs score --entries <file.json> --rubric <file.json> [--json]
 *   node forge-tournament.cjs promote --ranked <file.json> [--close-call-margin 0.03] [--json]
 * `--entries`/`--ranked` files accept either a bare JSON array, or `{"entries":[...]}` (score()'s own
 * output shape, so `score`'s output file can be piped straight into `promote --ranked`).
 * Exit codes: plan/score: 0 = ran, 2 = usage or validation error (a malformed spec/entry — nothing
 * fabricated). promote: 0 = a clear winner, 3 = ran honestly but flagged a tie or close call (advisory,
 * mirrors forge-mutcheck's hollow-test 3 convention), 2 = usage or validation error.
 *
 * event_types (declared for J-integrate to wire into log-event.cjs — NOT implemented in this file, per the
 * shared-file rule): "tournament_planned" (after a real plan() call), "tournament_scored" (after a real
 * score() call).
 */
const fs = require('fs');

const DEFAULT_N = 3;
const DEFAULT_CLOSE_CALL_MARGIN = 0.03;

const DEFAULT_ANGLES = [
  'mvp-first', 'risk-first', 'perf-first', 'ux-first', 'test-first',
  'security-first', 'simplicity-first', 'scale-first', 'maintainability-first', 'cost-first',
];

const ANGLE_PROMPTS = {
  'mvp-first': 'Build the smallest correct version first. Ship real working functionality fast; defer edge cases, extra polish, and speculative generality.',
  'risk-first': 'Identify the riskiest / most likely-to-fail part of this task and prove it works BEFORE building the rest around it.',
  'perf-first': 'Optimize primarily for runtime performance and resource usage from the start, without sacrificing correctness.',
  'ux-first': 'Optimize primarily for the end-user experience — clarity, responsiveness, and error/empty/loading states — even if it costs some implementation simplicity.',
  'test-first': 'Write the tests before the implementation (strict TDD); let the tests drive the design.',
  'security-first': 'Treat every external input as untrusted and design the boundary/validation/authorization first, before the happy-path logic.',
  'simplicity-first': 'Prefer the simplest solution that genuinely works over a more "clever" or extensible one; avoid speculative abstraction.',
  'scale-first': 'Design for the volume/concurrency this will realistically need to handle, even if that costs some initial simplicity.',
  'maintainability-first': 'Optimize primarily for a future maintainer reading and safely changing this code, with clear structure and naming.',
  'cost-first': 'Optimize primarily for the lowest ongoing operating/compute/API cost that still meets the requirement.',
};

function slugify(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'task';
}

function round4(n) { return Math.round(n * 10000) / 10000; }

// ---- plan() ----------------------------------------------------------------------------------------
/** plan({task, n, angles}, opts) -> tournament plan (see file header MODEL). Pure data — never touches
 *  disk or spawns anything (guardrail 1). Throws on a genuinely bad request (no task, n < 1, non-distinct
 *  angles, or n exceeding the number of distinct angles available) rather than silently degrading. */
function plan(input, opts) {
  opts = opts || {};
  input = input || {};

  const task = typeof input.task === 'string' ? input.task.trim() : '';
  if (!task) throw new Error('forge-tournament: plan requires a non-empty task');

  const n = input.n != null ? Number(input.n) : DEFAULT_N;
  if (!Number.isInteger(n) || n < 1) throw new Error('forge-tournament: n must be a positive integer');

  let angles;
  if (Array.isArray(input.angles) && input.angles.length) {
    angles = input.angles.map((a) => String(a == null ? '' : a).trim());
    if (angles.some((a) => !a)) throw new Error('forge-tournament: every angle must be a non-empty string');
    if (new Set(angles).size !== angles.length) throw new Error('forge-tournament: angles must be distinct — a repeated angle is not a real second variant');
  } else {
    angles = DEFAULT_ANGLES;
  }
  if (n > angles.length) {
    throw new Error('forge-tournament: n (' + n + ') exceeds the number of distinct angles available (' + angles.length + ')' +
      (Array.isArray(input.angles) && input.angles.length ? '' : ' — supply explicit angles for n > ' + DEFAULT_ANGLES.length));
  }
  const chosenAngles = angles.slice(0, n);

  const taskSlug = slugify(task);
  const variants = chosenAngles.map((angle, i) => {
    const id = 'v' + (i + 1);
    const angleSlug = slugify(angle);
    const promptFragment = ANGLE_PROMPTS[angle] || ('Focus primarily on the "' + angle + '" angle.');
    const narrowed_prompt = 'Task: ' + task + '\nAngle (' + angle + '): ' + promptFragment;
    return {
      id,
      angle,
      worktree_hint: {
        path: '../wt-tournament-' + taskSlug + '-' + id + '-' + angleSlug,
        branch: 'wt/tournament-' + taskSlug + '-' + id + '-' + angleSlug,
      },
      work_package: { task, angle, narrowed_prompt },
    };
  });

  return {
    task, n, angles: chosenAngles,
    worktree_note: 'Planning only — no git command was run. Create each worktree yourself (see the forge-worktrees skill: git worktree add <path> -b <branch>) before dispatching a variant.',
    variants,
  };
}

// ---- score() ----------------------------------------------------------------------------------------
/** normalizeRubric(rubric) -> criteria[] (validated, deduped-key, positive-weight). Throws on any
 *  malformed criterion — a rubric this tool can't trust must never silently produce a score. */
function normalizeRubric(rubric) {
  if (!rubric || typeof rubric !== 'object' || !Array.isArray(rubric.criteria) || rubric.criteria.length === 0) {
    throw new Error('forge-tournament: rubric must be an object with a non-empty criteria array');
  }
  const seen = new Set();
  return rubric.criteria.map((c) => {
    if (!c || typeof c !== 'object') throw new Error('forge-tournament: each rubric criterion must be an object');
    const key = c.key != null ? String(c.key).trim() : '';
    if (!key) throw new Error('forge-tournament: each rubric criterion needs a non-empty key');
    if (seen.has(key)) throw new Error('forge-tournament: duplicate rubric criterion key: ' + key);
    seen.add(key);
    const weight = Number(c.weight);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error('forge-tournament: rubric criterion "' + key + '" needs a positive numeric weight');
    const direction = c.direction === 'min' ? 'min' : 'max';
    return { key, weight, direction };
  });
}

/** score({entries}, rubric, opts) -> {rubric, entries, tie} (see file header MODEL). Never fabricates a
 *  value: an entry missing BOTH metrics[key] and rubricScores[key] for a rubric criterion throws
 *  (guardrail 2) instead of defaulting to some "fair" score. */
function score(input, rubric, opts) {
  opts = opts || {};
  input = input || {};
  const criteria = normalizeRubric(rubric);

  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new Error('forge-tournament: score requires a non-empty entries array');
  }

  const ids = new Set();
  const entries = input.entries.map((e) => {
    if (!e || typeof e !== 'object') throw new Error('forge-tournament: each entry must be an object');
    const id = e.id != null ? String(e.id).trim() : '';
    if (!id) throw new Error('forge-tournament: every entry needs a non-empty id');
    if (ids.has(id)) throw new Error('forge-tournament: duplicate entry id: ' + id);
    ids.add(id);
    const metrics = (e.metrics && typeof e.metrics === 'object' && !Array.isArray(e.metrics)) ? e.metrics : null;
    const rubricScores = (e.rubricScores && typeof e.rubricScores === 'object' && !Array.isArray(e.rubricScores)) ? e.rubricScores : null;
    if (!metrics && !rubricScores) throw new Error('forge-tournament: entry "' + id + '" must supply metrics or rubricScores');
    return { id, metrics, rubricScores };
  });

  // min-max range per criterion, computed ONLY from entries relying on metrics (not a direct rubricScore)
  // for that criterion — a real, per-criterion normalization basis, never an invented spread.
  const metricRange = {};
  for (const c of criteria) {
    let min = Infinity, max = -Infinity, any = false;
    for (const en of entries) {
      if (en.rubricScores && Object.prototype.hasOwnProperty.call(en.rubricScores, c.key)) continue;
      if (en.metrics && Object.prototype.hasOwnProperty.call(en.metrics, c.key)) {
        const v = Number(en.metrics[c.key]);
        if (!Number.isFinite(v)) throw new Error('forge-tournament: entry "' + en.id + '" metric "' + c.key + '" must be a finite number');
        any = true;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    metricRange[c.key] = any ? { min, max } : null;
  }

  const scored = entries.map((en) => {
    let weightedSum = 0, weightTotal = 0;
    const breakdown = criteria.map((c) => {
      let raw, normalized, source;
      if (en.rubricScores && Object.prototype.hasOwnProperty.call(en.rubricScores, c.key)) {
        raw = Number(en.rubricScores[c.key]);
        if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
          throw new Error('forge-tournament: entry "' + en.id + '" rubricScores.' + c.key + ' must be a number in [0,1]');
        }
        normalized = raw;
        source = 'rubricScores';
      } else if (en.metrics && Object.prototype.hasOwnProperty.call(en.metrics, c.key)) {
        raw = Number(en.metrics[c.key]);
        const range = metricRange[c.key];
        if (range.max === range.min) normalized = 1; // no real spread across entries — never fabricate a fake differentiator
        else {
          const frac = (raw - range.min) / (range.max - range.min);
          normalized = c.direction === 'min' ? (1 - frac) : frac;
        }
        source = 'metrics';
      } else {
        throw new Error('forge-tournament: entry "' + en.id + '" is missing data for rubric criterion "' + c.key + '" (no metrics or rubricScores value) — refusing to fabricate a score');
      }
      const contribution = normalized * c.weight;
      weightedSum += contribution;
      weightTotal += c.weight;
      return { key: c.key, weight: c.weight, direction: c.direction, source, raw, normalized: round4(normalized), contribution: round4(contribution) };
    });
    // weightTotal is always > 0 here: normalizeRubric() already threw on an empty criteria array or a
    // non-positive weight, so criteria is guaranteed non-empty with only positive weights — no "0 weight
    // total" branch to guard against (would be untestable dead code).
    const finalScore = weightedSum / weightTotal;
    return { id: en.id, score: round4(finalScore), breakdown };
  });

  // tiebreak by id is a strict order here: ids are guaranteed distinct by the dedupe check above, so
  // "a.id === b.id" can never occur — no equal-ids branch to keep (would be untestable dead code).
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const ranked = scored.map((s, i) => Object.assign({ rank: i + 1 }, s));
  const tie = ranked.length > 1 && ranked[0].score === ranked[1].score;

  return { rubric: { criteria }, entries: ranked, tie };
}

// ---- promote() --------------------------------------------------------------------------------------
/** promote({ranked}, opts) -> {winner, runners_up, grafts, tie, close_call, margin, notes} (see file
 *  header MODEL). Throws on a malformed `ranked` array — never fabricates a winner from bad input
 *  (guardrail 2/3). */
function promote(input, opts) {
  opts = opts || {};
  input = input || {};
  const closeCallMargin = input.closeCallMargin != null ? Number(input.closeCallMargin)
    : (opts.closeCallMargin != null ? Number(opts.closeCallMargin) : DEFAULT_CLOSE_CALL_MARGIN);
  if (!Number.isFinite(closeCallMargin) || closeCallMargin < 0) {
    throw new Error('forge-tournament: closeCallMargin must be a non-negative number');
  }

  const rankedRaw = input.ranked;
  if (!Array.isArray(rankedRaw) || rankedRaw.length === 0) {
    throw new Error('forge-tournament: promote requires a non-empty ranked array');
  }

  const ids = new Set();
  const normalized = rankedRaw.map((r) => {
    if (!r || typeof r !== 'object') throw new Error('forge-tournament: each ranked entry must be an object');
    const id = r.id != null ? String(r.id).trim() : '';
    if (!id) throw new Error('forge-tournament: every ranked entry needs a non-empty id');
    if (ids.has(id)) throw new Error('forge-tournament: duplicate ranked entry id: ' + id);
    ids.add(id);
    const scoreVal = Number(r.score);
    if (!Number.isFinite(scoreVal)) throw new Error('forge-tournament: ranked entry "' + id + '" needs a finite numeric score');
    return { id, score: scoreVal, breakdown: Array.isArray(r.breakdown) ? r.breakdown : null };
  });

  // same reasoning as score()'s sort: ids are guaranteed distinct by the dedupe check above.
  const sorted = normalized.slice().sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const winner = sorted[0];
  const runnersUp = sorted.slice(1);

  let tie = false, closeCall = false, margin = null;
  if (runnersUp.length) {
    const second = runnersUp[0];
    tie = winner.score === second.score;
    margin = winner.score === 0 ? (second.score === 0 ? 0 : 1) : Math.abs(winner.score - second.score) / Math.abs(winner.score);
    margin = round4(margin);
    closeCall = !tie && margin <= closeCallMargin;
  }

  const grafts = [];
  const notes = [];
  if (winner.breakdown) {
    for (const ru of runnersUp) {
      if (!ru.breakdown) continue;
      for (const c of ru.breakdown) {
        const winnerCrit = winner.breakdown.find((b) => b.key === c.key);
        if (winnerCrit && Number(c.normalized) > Number(winnerCrit.normalized)) {
          grafts.push({
            from_id: ru.id, criterion: c.key,
            runner_up_normalized: c.normalized, winner_normalized: winnerCrit.normalized,
            note: 'runner-up "' + ru.id + '" scored higher on "' + c.key + '" — consider grafting that approach onto the winner',
          });
        }
      }
    }
  } else {
    notes.push('ranked entries carried no breakdown data — grafts cannot be computed without per-criterion detail from score()');
  }

  return {
    winner: { id: winner.id, score: winner.score },
    runners_up: runnersUp.map((r) => ({ id: r.id, score: r.score })),
    grafts, tie, close_call: closeCall, margin, notes,
  };
}

module.exports = {
  plan, score, promote,
  normalizeRubric, slugify, round4,
  DEFAULT_ANGLES, ANGLE_PROMPTS, DEFAULT_N, DEFAULT_CLOSE_CALL_MARGIN,
};

// ---- CLI ----
function readJsonFile(file, label) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(label + ' file could not be read: ' + file + ' (' + e.message + ')'); }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(label + ' file is not valid JSON: ' + file + ' (' + e.message + ')'); }
}
function readEntriesLike(file, label) {
  const data = readJsonFile(file, label);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.entries)) return data.entries;
  throw new Error(label + ' file must be a JSON array, or an object with an "entries" array (e.g. score()\'s own output)');
}

function parseArgs(argv) {
  const firstIsHelp = argv[0] === '--help' || argv[0] === '-h';
  const cmd = firstIsHelp ? null : (argv[0] || null);
  const rest = firstIsHelp ? [] : argv.slice(1);
  const opts = {
    cmd, task: null, n: null, angles: null,
    entries: null, rubric: null, ranked: null, closeCallMargin: null,
    json: false, help: firstIsHelp,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--task') opts.task = rest[++i];
    else if (a === '--n') opts.n = rest[++i];
    else if (a === '--angles') opts.angles = rest[++i];
    else if (a === '--entries') opts.entries = rest[++i];
    else if (a === '--rubric') opts.rubric = rest[++i];
    else if (a === '--ranked') opts.ranked = rest[++i];
    else if (a === '--close-call-margin') opts.closeCallMargin = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-tournament.cjs plan --task "<x>" --n 3 [--angles a,b,c] [--json]');
  console.error('       node forge-tournament.cjs score --entries <file.json> --rubric <file.json> [--json]');
  console.error('       node forge-tournament.cjs promote --ranked <file.json> [--close-call-margin 0.03] [--json]');
}
function printPlan(p) {
  const lines = ['forge-tournament plan — "' + p.task + '" — ' + p.n + ' variant(s)'];
  for (const v of p.variants) lines.push('  [' + v.id + '] ' + v.angle + '  ->  ' + v.worktree_hint.branch);
  return lines.join('\n');
}
function printScore(s) {
  const lines = ['forge-tournament score' + (s.tie ? '  [TIE at the top]' : '')];
  for (const e of s.entries) lines.push('  #' + e.rank + ' ' + e.id + '  score=' + e.score);
  return lines.join('\n');
}
function printPromote(p) {
  const lines = [
    'forge-tournament promote — winner: ' + p.winner.id + ' (score=' + p.winner.score + ')' +
      (p.tie ? '  [TIE]' : p.close_call ? '  [CLOSE CALL]' : ''),
  ];
  for (const r of p.runners_up) lines.push('  runner-up: ' + r.id + ' (score=' + r.score + ')');
  for (const g of p.grafts) lines.push('  graft: ' + g.note);
  for (const n of p.notes) lines.push('  note: ' + n);
  return lines.join('\n');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.cmd) { printUsage(); process.exitCode = opts.help ? 0 : 2; }
  else {
    try {
      if (opts.cmd === 'plan') {
        if (!opts.task) throw new Error('plan requires --task "<text>"');
        const n = opts.n != null ? Number(opts.n) : undefined;
        const angles = opts.angles ? opts.angles.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const r = plan({ task: opts.task, n, angles }, {});
        if (opts.json) console.log(JSON.stringify(r));
        else console.log(printPlan(r));
        process.exitCode = 0;
      } else if (opts.cmd === 'score') {
        if (!opts.entries || !opts.rubric) throw new Error('score requires --entries <file.json> and --rubric <file.json>');
        const entries = readEntriesLike(opts.entries, '--entries');
        const rubric = readJsonFile(opts.rubric, '--rubric');
        const r = score({ entries }, rubric, {});
        if (opts.json) console.log(JSON.stringify(r));
        else console.log(printScore(r));
        process.exitCode = 0;
      } else if (opts.cmd === 'promote') {
        if (!opts.ranked) throw new Error('promote requires --ranked <file.json>');
        const ranked = readEntriesLike(opts.ranked, '--ranked');
        const closeCallMargin = opts.closeCallMargin != null ? Number(opts.closeCallMargin) : undefined;
        const r = promote({ ranked, closeCallMargin }, {});
        if (opts.json) console.log(JSON.stringify(r));
        else console.log(printPromote(r));
        process.exitCode = (r.tie || r.close_call) ? 3 : 0;
      } else {
        printUsage();
        process.exitCode = 2;
      }
    } catch (e) {
      console.error('forge-tournament: ' + e.message);
      process.exitCode = 2;
    }
  }
}
