#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-tournament.cjs (PIECE J2, 2026-07-19). File-based CLI tests use a fresh
 * os.tmpdir() directory per section — this file never touches this repo's real .claude/ state. Exit 0 =
 * all pass.
 *
 * Section map:
 *   1) plan() — happy path: N distinct-angle variants, default-angle rotation, worktree hints
 *   2) plan() — validation: empty task, bad n, non-distinct angles, n exceeding available angles
 *   3) score() — ranks correctly by weighted rubric (metrics-based, min-max normalized)
 *   4) score() — rubricScores path (direct, pre-normalized values) + mixed metrics/rubricScores
 *   5) score() — a tie is flagged honestly (entries.tie === true)
 *   6) score() — malformed entries throw (no fabricated score/winner)
 *   7) promote() — returns the winner, runners-up, and evidence-based grafts
 *   8) promote() — tie and close-call flags
 *   9) promote() — malformed ranked input throws (no fabricated winner)
 *   10) mutation-hardening near-miss coverage (direction inversion, tiebreak stability, boundary weights)
 *   11) real spawned CLI tests: plan / score / promote subcommands, exit codes, --json output
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FT = require('./forge-tournament.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
const CLI = path.join(__dirname, 'forge-tournament.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

console.log('1) plan() happy path — N distinct-angle variants, worktree hints, narrowed prompts');
{
  const p = FT.plan({ task: 'Build a login form', n: 3 }, {});
  t('plan() returns exactly n=3 variants', p.variants.length === 3);
  t('every variant has a distinct angle', new Set(p.variants.map((v) => v.angle)).size === 3);
  t('angles come from the default rotation in order', p.angles.join(',') === FT.DEFAULT_ANGLES.slice(0, 3).join(','));
  t('every variant id is distinct (v1, v2, v3)', p.variants.map((v) => v.id).join(',') === 'v1,v2,v3');
  t('every variant carries the same task text', p.variants.every((v) => v.work_package.task === 'Build a login form'));
  t('every variant narrowed_prompt mentions its own angle', p.variants.every((v) => v.work_package.narrowed_prompt.includes(v.angle)));
  t('every variant gets a distinct worktree branch hint', new Set(p.variants.map((v) => v.worktree_hint.branch)).size === 3);
  t('the worktree_note is honest that no git command ran', /no git command was run/.test(p.worktree_note));
  t('plan() defaults n to 3 when omitted', FT.plan({ task: 'x' }, {}).variants.length === FT.DEFAULT_N);

  const custom = FT.plan({ task: 'Build a search bar', n: 2, angles: ['alpha-angle', 'beta-angle'] }, {});
  t('custom angles are honored verbatim', custom.angles.join(',') === 'alpha-angle,beta-angle');
  t('an unknown/custom angle still gets a real narrowed_prompt fragment', custom.variants[0].work_package.narrowed_prompt.includes('alpha-angle'));
}

console.log('2) plan() validation — no silent fallback, no invented angle');
{
  t('empty task throws', !!throws(() => FT.plan({ task: '' }, {})));
  t('whitespace-only task throws', !!throws(() => FT.plan({ task: '   ' }, {})));
  t('missing task throws', !!throws(() => FT.plan({}, {})));
  t('n=0 throws', !!throws(() => FT.plan({ task: 'x', n: 0 }, {})));
  t('n=-1 throws', !!throws(() => FT.plan({ task: 'x', n: -1 }, {})));
  t('non-integer n throws', !!throws(() => FT.plan({ task: 'x', n: 1.5 }, {})));
  t('duplicate custom angles throw (repeating an angle is not a real 2nd variant)', !!throws(() => FT.plan({ task: 'x', n: 2, angles: ['same', 'same'] }, {})));
  t('empty-string angle throws', !!throws(() => FT.plan({ task: 'x', n: 1, angles: [''] }, {})));
  t('n exceeding the default angle rotation throws (never repeats an angle to fill n)', !!throws(() => FT.plan({ task: 'x', n: FT.DEFAULT_ANGLES.length + 1 }, {})));
  t('n exceeding an explicitly supplied angle list throws', !!throws(() => FT.plan({ task: 'x', n: 3, angles: ['only-one'] }, {})));

  const errDefault = throws(() => FT.plan({ task: 'x', n: FT.DEFAULT_ANGLES.length + 1 }, {}));
  t('n exceeding the DEFAULT rotation error suggests supplying explicit angles', errDefault && /supply explicit angles/.test(errDefault.message));
  const errCustom = throws(() => FT.plan({ task: 'x', n: 3, angles: ['only-one'] }, {}));
  t('n exceeding an EXPLICIT angle list error does NOT repeat the "supply explicit angles" suggestion (distinct message branch)', errCustom && !/supply explicit angles/.test(errCustom.message));
}

console.log('2b) slugify() — direct unit coverage (worktree hints depend on it staying word-separated)');
{
  t('slugify() keeps words hyphen-separated, not silently concatenated', FT.slugify('Build a Login Form') === 'build-a-login-form');
  t('slugify() falls back to "task" when the input strips to nothing', FT.slugify('!!!') === 'task');
  t('slugify() falls back to "task" for an empty string', FT.slugify('') === 'task');
  t('slugify() falls back to "task" for null/undefined', FT.slugify(null) === 'task' && FT.slugify(undefined) === 'task');
  t('slugify() keeps digits (0-9) as valid slug characters, not just letters', FT.slugify('Round 7 Plan') === 'round-7-plan');
  t('slugify() truncates to exactly 48 characters for a long input', FT.slugify('a'.repeat(60)).length === 48);
  t('DEFAULT_N is exactly 3 (the documented default variant count)', FT.DEFAULT_N === 3);
}

console.log('3) score() — ranks correctly by weighted rubric (metrics-based, min-max normalized)');
{
  const rubric = { criteria: [{ key: 'correctness', weight: 0.6 }, { key: 'latency_ms', weight: 0.4, direction: 'min' }] };
  const entries = [
    { id: 'a', metrics: { correctness: 10, latency_ms: 200 } },
    { id: 'b', metrics: { correctness: 5, latency_ms: 100 } },
    { id: 'c', metrics: { correctness: 0, latency_ms: 50 } },
  ];
  const r = FT.score({ entries }, rubric, {});
  t('score() ranks a (highest correctness, weight 0.6) on top', r.entries[0].id === 'a');
  t('score() ranks c last (0 correctness, but best latency — correctness has more weight)', r.entries[2].id === 'c');
  t('rank numbers are 1..3 in order', r.entries.map((e) => e.rank).join(',') === '1,2,3');
  t('a "max" direction criterion normalizes the max metric value to 1', r.entries.find((e) => e.id === 'a').breakdown.find((b) => b.key === 'correctness').normalized === 1);
  t('a "max" direction criterion normalizes the min metric value to 0', r.entries.find((e) => e.id === 'c').breakdown.find((b) => b.key === 'correctness').normalized === 0);
  t('a "min" direction criterion normalizes the SMALLEST latency to 1 (lower is better)', r.entries.find((e) => e.id === 'c').breakdown.find((b) => b.key === 'latency_ms').normalized === 1);
  t('a "min" direction criterion normalizes the LARGEST latency to 0', r.entries.find((e) => e.id === 'a').breakdown.find((b) => b.key === 'latency_ms').normalized === 0);
  t('final score for a is a real weighted blend (not just 1 or 0)', r.entries.find((e) => e.id === 'a').score > 0 && r.entries.find((e) => e.id === 'a').score < 1);
  t('no tie reported for a clearly differentiated ranking', r.tie === false);
}

console.log('4) score() — rubricScores path (direct pre-normalized values) + mixed with metrics');
{
  const rubric = { criteria: [{ key: 'quality', weight: 1 }, { key: 'speed', weight: 1, direction: 'min' }] };
  const entries = [
    { id: 'x', rubricScores: { quality: 0.9 }, metrics: { speed: 10 } },
    { id: 'y', rubricScores: { quality: 0.4, speed: 0.2 } },
  ];
  const r = FT.score({ entries }, rubric, {});
  const x = r.entries.find((e) => e.id === 'x');
  const y = r.entries.find((e) => e.id === 'y');
  t('an entry can mix rubricScores for one criterion with metrics for another', x.breakdown.find((b) => b.key === 'quality').source === 'rubricScores');
  t('the metrics-supplied criterion is still sourced from metrics', x.breakdown.find((b) => b.key === 'speed').source === 'metrics');
  t('a directly-supplied rubricScore is used verbatim (not re-normalized)', y.breakdown.find((b) => b.key === 'speed').normalized === 0.2);
  t('quality (only rubricScores across both entries) is used verbatim for both', x.breakdown.find((b) => b.key === 'quality').normalized === 0.9 && y.breakdown.find((b) => b.key === 'quality').normalized === 0.4);
  t('a single-entry metric range (no spread) normalizes to 1, never a fabricated split', x.breakdown.find((b) => b.key === 'speed').normalized === 1);
}

console.log('5) score() — a tie is flagged honestly');
{
  const rubric = { criteria: [{ key: 'q', weight: 1 }] };
  const entries = [{ id: 'a', rubricScores: { q: 0.7 } }, { id: 'b', rubricScores: { q: 0.7 } }, { id: 'c', rubricScores: { q: 0.1 } }];
  const r = FT.score({ entries }, rubric, {});
  t('exact-equal top scores set tie:true', r.tie === true);
  t('tied entries still get a deterministic, stable order (by id)', r.entries[0].id === 'a' && r.entries[1].id === 'b');
  t('a non-tied lower entry is still ranked correctly below the tie', r.entries[2].id === 'c');

  const rubric2 = { criteria: [{ key: 'q', weight: 1 }] };
  const noTie = FT.score({ entries: [{ id: 'a', rubricScores: { q: 0.9 } }, { id: 'b', rubricScores: { q: 0.1 } }] }, rubric2, {});
  t('genuinely different top-2 scores do NOT get flagged as a tie', noTie.tie === false);

  const single = FT.score({ entries: [{ id: 'solo', rubricScores: { q: 0.5 } }] }, rubric2, {});
  t('score() with exactly 1 entry never crashes and reports tie:false (kills a length>1 boundary mutant)', single.entries.length === 1 && single.tie === false);
}

console.log('6) score() — malformed entries throw (no fabricated score/winner)');
{
  const rubric = { criteria: [{ key: 'q', weight: 1 }] };
  t('empty entries array throws', !!throws(() => FT.score({ entries: [] }, rubric, {})));
  t('missing entries throws', !!throws(() => FT.score({}, rubric, {})));
  t('an entry with no id throws', !!throws(() => FT.score({ entries: [{ metrics: { q: 1 } }] }, rubric, {})));
  {
    const eNull = throws(() => FT.score({ entries: [null] }, rubric, {}));
    t('a null entry throws the specific "each entry must be an object" message (not a downstream TypeError)', eNull && /each entry must be an object/.test(eNull.message));
    const eStr = throws(() => FT.score({ entries: ['oops'] }, rubric, {}));
    t('a non-object (string) entry throws the same specific message', eStr && /each entry must be an object/.test(eStr.message));
  }
  {
    const errStrPrim = throws(() => FT.score({ entries: [{ id: 'a', metrics: 'oops' }] }, rubric, {}));
    t('metrics as a non-object primitive (string) is nulled, not misread as valid — "must supply" message proves it', errStrPrim && /must supply metrics or rubricScores/.test(errStrPrim.message));
    const errArrMetrics = throws(() => FT.score({ entries: [{ id: 'a', metrics: [1] }] }, rubric, {}));
    t('metrics as an ARRAY is nulled, not misread as valid — "must supply" message proves it (kills the typeof-object||!isArray mutant)', errArrMetrics && /must supply metrics or rubricScores/.test(errArrMetrics.message));
    const errStrRS = throws(() => FT.score({ entries: [{ id: 'a', rubricScores: 'oops' }] }, rubric, {}));
    t('rubricScores as a non-object primitive (string) is nulled — "must supply" message proves it', errStrRS && /must supply metrics or rubricScores/.test(errStrRS.message));
    const errArrRS = throws(() => FT.score({ entries: [{ id: 'a', rubricScores: [0.5] }] }, rubric, {}));
    t('rubricScores as an ARRAY is nulled — "must supply" message proves it (kills the typeof-object||!isArray mutant)', errArrRS && /must supply metrics or rubricScores/.test(errArrRS.message));
    const errNeither = throws(() => FT.score({ entries: [{ id: 'a' }] }, rubric, {}));
    t('an entry with neither metrics nor rubricScores throws the EARLY "must supply" message, not a later generic one (kills a forced-false guard mutant)', errNeither && /must supply metrics or rubricScores/.test(errNeither.message));
  }
  t('a duplicate entry id throws', !!throws(() => FT.score({ entries: [{ id: 'a', metrics: { q: 1 } }, { id: 'a', metrics: { q: 2 } }] }, rubric, {})));
  t('an entry with NEITHER metrics nor rubricScores throws', !!throws(() => FT.score({ entries: [{ id: 'a' }] }, rubric, {})));
  {
    const eMissing = throws(() => FT.score({ entries: [{ id: 'a', metrics: { other: 1 } }] }, rubric, {}));
    t('an entry missing data for a rubric criterion throws (no fabricated 0/1 default)', !!eMissing);
    t('...with the exact honest "missing data for rubric criterion" message (not a generic finite-number error)', eMissing && /is missing data for rubric criterion/.test(eMissing.message));
    const eMissing2 = throws(() => FT.score({ entries: [{ id: 'a', rubricScores: { other: 1 } }] }, rubric, {}));
    t('an entry whose rubricScores covers a DIFFERENT key entirely also throws the same honest missing-data message', eMissing2 && /is missing data for rubric criterion/.test(eMissing2.message));
  }
  t('an out-of-range rubricScore (>1) throws', !!throws(() => FT.score({ entries: [{ id: 'a', rubricScores: { q: 1.5 } }] }, rubric, {})));
  t('an out-of-range rubricScore (<0) throws', !!throws(() => FT.score({ entries: [{ id: 'a', rubricScores: { q: -0.1 } }] }, rubric, {})));
  t('a non-finite metric value throws', !!throws(() => FT.score({ entries: [{ id: 'a', metrics: { q: 'not-a-number' } }] }, rubric, {})));
  t('a rubric with no criteria throws', !!throws(() => FT.score({ entries: [{ id: 'a', rubricScores: { q: 1 } }] }, { criteria: [] }, {})));
  t('a rubric criterion with zero weight throws', !!throws(() => FT.score({ entries: [{ id: 'a', rubricScores: { q: 1 } }] }, { criteria: [{ key: 'q', weight: 0 }] }, {})));
  t('a rubric with a duplicate criterion key throws', !!throws(() => FT.score({ entries: [{ id: 'a', rubricScores: { q: 1 } }] }, { criteria: [{ key: 'q', weight: 1 }, { key: 'q', weight: 1 }] }, {})));

  const RUBRIC_MSG = /rubric must be an object with a non-empty criteria array/;
  t('a null rubric throws the specific rubric-shape message', (() => { const e = throws(() => FT.normalizeRubric(null)); return e && RUBRIC_MSG.test(e.message); })());
  t('a non-object (string) rubric throws the specific rubric-shape message', (() => { const e = throws(() => FT.normalizeRubric('oops')); return e && RUBRIC_MSG.test(e.message); })());
  t('a rubric whose "criteria" is not an array throws the specific rubric-shape message', (() => { const e = throws(() => FT.normalizeRubric({ criteria: 'not-an-array' })); return e && RUBRIC_MSG.test(e.message); })());
  t('a rubric with an empty criteria array throws the specific rubric-shape message', (() => { const e = throws(() => FT.normalizeRubric({ criteria: [] })); return e && RUBRIC_MSG.test(e.message); })());

  t('a null rubric criterion throws the specific "must be an object" message', (() => { const e = throws(() => FT.normalizeRubric({ criteria: [null] })); return e && /each rubric criterion must be an object/.test(e.message); })());
  t('a non-object (string) rubric criterion throws the specific "must be an object" message', (() => { const e = throws(() => FT.normalizeRubric({ criteria: ['oops'] })); return e && /each rubric criterion must be an object/.test(e.message); })());
  t('a rubric criterion with no key throws the specific "needs a non-empty key" message', (() => { const e = throws(() => FT.normalizeRubric({ criteria: [{ weight: 1 }] })); return e && /needs a non-empty key/.test(e.message); })());
  t('a rubric criterion with an empty-string key throws the specific "needs a non-empty key" message', (() => { const e = throws(() => FT.normalizeRubric({ criteria: [{ key: '', weight: 1 }] })); return e && /needs a non-empty key/.test(e.message); })());

  const rubricQ = { criteria: [{ key: 'q', weight: 1 }] };
  t('a single-criterion entry\'s final score exactly equals its normalized value (kills a weightedSum/weightTotal init-to-1 mutant)',
    FT.score({ entries: [{ id: 'a', rubricScores: { q: 0.75 } }] }, rubricQ, {}).entries[0].score === 0.75);

  const mixEntries = [
    { id: 'a', rubricScores: { q: 0.5 }, metrics: { q: 1000 } }, // rubricScores wins for 'a'; its metric must be EXCLUDED from b/c's normalization range
    { id: 'b', metrics: { q: 10 } },
    { id: 'c', metrics: { q: 20 } },
  ];
  const rMix = FT.score({ entries: mixEntries }, rubricQ, {});
  t('an entry providing BOTH rubricScores and metrics for the same key is excluded from other entries\' metric normalization range (continue guard genuinely fires)',
    rMix.entries.find((e) => e.id === 'b').breakdown[0].normalized === 0 && rMix.entries.find((e) => e.id === 'c').breakdown[0].normalized === 1);
}

console.log('7) promote() — returns the winner, runners-up, and evidence-based grafts');
{
  const rubric = { criteria: [{ key: 'correctness', weight: 0.7 }, { key: 'perf', weight: 0.3 }] };
  const entries = [
    { id: 'winner-ish', metrics: { correctness: 9, perf: 2 } },
    { id: 'fast-but-buggy', metrics: { correctness: 4, perf: 10 } },
  ];
  const scored = FT.score({ entries }, rubric, {});
  const promoted = FT.promote({ ranked: scored.entries }, {});
  t('promote() picks the higher-weighted-score entry as winner', promoted.winner.id === 'winner-ish');
  t('promote() lists exactly 1 runner-up', promoted.runners_up.length === 1 && promoted.runners_up[0].id === 'fast-but-buggy');
  t('promote() grafts the runner-up\'s genuinely stronger criterion (perf)', promoted.grafts.some((g) => g.from_id === 'fast-but-buggy' && g.criterion === 'perf'));
  t('promote() does NOT graft a criterion the winner actually won', !promoted.grafts.some((g) => g.criterion === 'correctness'));
  t('a clear (non-close) win reports tie:false and close_call:false', promoted.tie === false && promoted.close_call === false);
}

console.log('8) promote() — tie and close-call flags');
{
  const tied = FT.promote({ ranked: [{ id: 'a', score: 0.5 }, { id: 'b', score: 0.5 }] }, {});
  t('an exact score tie sets tie:true', tied.tie === true);
  t('a tie does not ALSO get flagged close_call (tie is the stronger/more specific claim)', tied.close_call === false);

  const close = FT.promote({ ranked: [{ id: 'a', score: 0.51 }, { id: 'b', score: 0.50 }] }, { closeCallMargin: 0.05 });
  t('a small relative gap under the margin is flagged close_call', close.close_call === true && close.tie === false);

  const clear = FT.promote({ ranked: [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.1 }] }, { closeCallMargin: 0.05 });
  t('a large relative gap is NOT flagged close_call', clear.close_call === false);

  const zeroWinnerZeroRunner = FT.promote({ ranked: [{ id: 'a', score: 0 }, { id: 'b', score: 0 }] }, {});
  t('winner score 0 AND runner-up score 0 -> margin 0 (a real exact tie, not a fabricated gap)', zeroWinnerZeroRunner.margin === 0 && zeroWinnerZeroRunner.tie === true);
  const zeroWinnerNonzeroRunner = FT.promote({ ranked: [{ id: 'w', score: 0 }, { id: 'r', score: -5 }] }, {});
  t('winner score exactly 0 but a runner-up is genuinely different -> margin is 1 (max distance), not silently 0 (kills a 1->0 literal mutant)', zeroWinnerNonzeroRunner.margin === 1);

  const noBreakdown = FT.promote({ ranked: [{ id: 'a', score: 0.5 }] }, {});
  t('a single-entry ranked list has no runners-up and no grafts', noBreakdown.runners_up.length === 0 && noBreakdown.grafts.length === 0);
  t('missing breakdown data produces an honest note instead of silently empty grafts', noBreakdown.notes.some((n) => /breakdown/.test(n)));

  const mixedBreakdown = [
    { id: 'w', score: 0.9, breakdown: [{ key: 'k', normalized: 0.5 }] },
    { id: 'r', score: 0.1, breakdown: null },
  ];
  const pMixed = FT.promote({ ranked: mixedBreakdown }, {});
  t('a runner-up with NO breakdown data is safely skipped in the grafts scan (no crash, no fabricated graft — kills a forced-false continue-guard mutant)', pMixed.grafts.length === 0);
}

console.log('9) promote() — malformed ranked input throws (no fabricated winner)');
{
  t('empty ranked array throws', !!throws(() => FT.promote({ ranked: [] }, {})));
  t('missing ranked throws', !!throws(() => FT.promote({}, {})));
  {
    const eNotArr = throws(() => FT.promote({ ranked: 'not-an-array' }, {}));
    t('a non-array ranked value throws the specific "requires a non-empty ranked array" message (kills a forced-false guard mutant)', eNotArr && /requires a non-empty ranked array/.test(eNotArr.message));
    const eNull = throws(() => FT.promote({ ranked: [null] }, {}));
    t('a null ranked entry throws the specific "each ranked entry must be an object" message', eNull && /each ranked entry must be an object/.test(eNull.message));
  }
  t('a ranked entry with no id throws', !!throws(() => FT.promote({ ranked: [{ score: 1 }] }, {})));
  t('a ranked entry with a non-numeric score throws', !!throws(() => FT.promote({ ranked: [{ id: 'a', score: 'high' }] }, {})));
  t('a duplicate ranked entry id throws', !!throws(() => FT.promote({ ranked: [{ id: 'a', score: 1 }, { id: 'a', score: 2 }] }, {})));
  t('a negative closeCallMargin throws', !!throws(() => FT.promote({ ranked: [{ id: 'a', score: 1 }, { id: 'b', score: 0.9 }] }, { closeCallMargin: -1 })));
}

console.log('10) mutation-hardening near-miss coverage (kills specific weakened variants)');
{
  // direction inversion: swapping 'min' for 'max' behavior must NOT silently pass — the winner must flip.
  const rubricMin = { criteria: [{ key: 'latency', weight: 1, direction: 'min' }] };
  const entries = [{ id: 'slow', metrics: { latency: 100 } }, { id: 'fast', metrics: { latency: 10 } }];
  const rMin = FT.score({ entries }, rubricMin, {});
  t('M1: direction:"min" makes the LOWER metric value win (kills a min/max inversion mutant)', rMin.entries[0].id === 'fast');
  const rubricMax = { criteria: [{ key: 'latency', weight: 1 }] }; // default direction:'max'
  const rMax = FT.score({ entries }, rubricMax, {});
  t('M2: default direction:"max" makes the HIGHER metric value win (confirms M1 is a real inversion, not a fluke)', rMax.entries[0].id === 'slow');

  // tiebreak must be deterministic by id, not merely "whatever array order arrived in"
  const rubricT = { criteria: [{ key: 'q', weight: 1 }] };
  const inA = FT.score({ entries: [{ id: 'z', rubricScores: { q: 0.5 } }, { id: 'a', rubricScores: { q: 0.5 } }] }, rubricT, {});
  t('M3: a tie always resolves to id-ascending order regardless of input array order', inA.entries[0].id === 'a' && inA.entries[1].id === 'z');
  const inB = FT.score({ entries: [{ id: 'a', rubricScores: { q: 0.5 } }, { id: 'z', rubricScores: { q: 0.5 } }] }, rubricT, {});
  t('M4: same tiebreak result when the input order is reversed (proves it is id-based, not insertion-based)', inB.entries[0].id === 'a' && inB.entries[1].id === 'z');

  // weight actually matters: a criterion with a much larger weight must dominate the outcome
  const rubricW = { criteria: [{ key: 'big', weight: 100 }, { key: 'small', weight: 1 }] };
  const wEntries = [
    { id: 'wins-on-big', rubricScores: { big: 1, small: 0 } },
    { id: 'wins-on-small', rubricScores: { big: 0, small: 1 } },
  ];
  const rW = FT.score({ entries: wEntries }, rubricW, {});
  t('M5: a criterion with 100x the weight decides the outcome (kills a mutant that ignores/flattens weight)', rW.entries[0].id === 'wins-on-big');

  // promote()'s graft check: > must be strict, a runner-up merely EQUAL to the winner must not be grafted
  const equalBreakdown = [
    { id: 'w', score: 0.6, breakdown: [{ key: 'k', normalized: 0.5 }] },
    { id: 'r', score: 0.4, breakdown: [{ key: 'k', normalized: 0.5 }] },
  ];
  const pEqual = FT.promote({ ranked: equalBreakdown }, {});
  t('M6: a runner-up merely EQUAL (not strictly greater) on a criterion is NOT grafted (kills a >= mutant)', pEqual.grafts.length === 0);
  const strictlyBetter = [
    { id: 'w', score: 0.6, breakdown: [{ key: 'k', normalized: 0.5 }] },
    { id: 'r', score: 0.4, breakdown: [{ key: 'k', normalized: 0.51 }] },
  ];
  const pBetter = FT.promote({ ranked: strictlyBetter }, {});
  t('M7: a runner-up strictly greater on a criterion (even by 0.01) IS grafted (confirms M6 boundary is exact)', pBetter.grafts.length === 1);

  // close-call boundary: exactly AT the margin counts as close (kills a strict-< mutant), just past it does not
  const atMargin = FT.promote({ ranked: [{ id: 'a', score: 1.0 }, { id: 'b', score: 0.95 }] }, { closeCallMargin: 0.05 });
  t('M8: a gap exactly AT the margin (0.05) counts as close_call (<=, not <)', atMargin.close_call === true);
  const pastMargin = FT.promote({ ranked: [{ id: 'a', score: 1.0 }, { id: 'b', score: 0.9499 }] }, { closeCallMargin: 0.05 });
  t('M9: a gap just past the margin does NOT count as close_call', pastMargin.close_call === false);
}

console.log('11) real spawned CLI: plan / score / promote subcommands, exit codes, --json');
{
  const dir = freshDir('ft-cli');

  const planRes = runCLI(['plan', '--task', 'Build a checkout flow', '--n', '2', '--json']);
  t('CLI plan exits 0', planRes.status === 0);
  const planJson = JSON.parse(planRes.stdout);
  t('CLI plan --json returns 2 variants', planJson.variants.length === 2);

  const planText = runCLI(['plan', '--task', 'Build a checkout flow', '--n', '2']);
  t('CLI plan (text mode) exits 0 and prints both angles', planText.status === 0 && planJson.angles.every((a) => planText.stdout.includes(a)));

  const planBad = runCLI(['plan', '--n', '2']); // no --task
  t('CLI plan without --task exits 2', planBad.status === 2);
  t('CLI plan without --task prints an honest error', /--task/.test(planBad.stderr));

  const rubricFile = path.join(dir, 'rubric.json');
  fs.writeFileSync(rubricFile, JSON.stringify({ criteria: [{ key: 'q', weight: 1 }] }), 'utf8');
  const entriesFile = path.join(dir, 'entries.json');
  fs.writeFileSync(entriesFile, JSON.stringify({ entries: [{ id: 'a', rubricScores: { q: 0.9 } }, { id: 'b', rubricScores: { q: 0.1 } }] }), 'utf8');
  const scoreRes = runCLI(['score', '--entries', entriesFile, '--rubric', rubricFile, '--json']);
  t('CLI score exits 0', scoreRes.status === 0);
  const scoreJson = JSON.parse(scoreRes.stdout);
  t('CLI score --json ranks a first', scoreJson.entries[0].id === 'a');

  const scoreOutFile = path.join(dir, 'score-out.json');
  fs.writeFileSync(scoreOutFile, scoreRes.stdout, 'utf8');
  const promoteRes = runCLI(['promote', '--ranked', scoreOutFile, '--json']);
  t('CLI promote (fed score\'s own --json output directly) exits 0 for a clear winner', promoteRes.status === 0);
  const promoteJson = JSON.parse(promoteRes.stdout);
  t('CLI promote --json winner matches the top-scored entry', promoteJson.winner.id === 'a');

  const tiedEntriesFile = path.join(dir, 'tied-entries.json');
  fs.writeFileSync(tiedEntriesFile, JSON.stringify({ entries: [{ id: 'a', rubricScores: { q: 0.5 } }, { id: 'b', rubricScores: { q: 0.5 } }] }), 'utf8');
  const tiedScoreRes = runCLI(['score', '--entries', tiedEntriesFile, '--rubric', rubricFile, '--json']);
  const tiedScoreOutFile = path.join(dir, 'tied-score-out.json');
  fs.writeFileSync(tiedScoreOutFile, tiedScoreRes.stdout, 'utf8');
  const tiedPromoteRes = runCLI(['promote', '--ranked', tiedScoreOutFile, '--json']);
  t('CLI promote exits 3 for an honestly-flagged tie (mirrors forge-mutcheck\'s hollow-test 3 convention)', tiedPromoteRes.status === 3);
  t('CLI promote --json reports tie:true', JSON.parse(tiedPromoteRes.stdout).tie === true);

  const scoreMissing = runCLI(['score', '--entries', entriesFile]); // no --rubric
  t('CLI score without --rubric exits 2', scoreMissing.status === 2);

  const promoteMissing = runCLI(['promote']); // no --ranked
  t('CLI promote without --ranked exits 2', promoteMissing.status === 2);

  const badJsonFile = path.join(dir, 'bad.json');
  fs.writeFileSync(badJsonFile, '{ not valid json', 'utf8');
  const badRes = runCLI(['score', '--entries', badJsonFile, '--rubric', rubricFile]);
  t('CLI score on an unparsable --entries file exits 2 with an honest error', badRes.status === 2 && /not valid JSON/.test(badRes.stderr));

  const noArgs = runCLI([]);
  t('CLI with no subcommand exits 2 and prints usage', noArgs.status === 2 && /Usage:/.test(noArgs.stderr));

  const garbageCmd = runCLI(['bogus-subcommand']);
  t('an unrecognized subcommand prints usage and exits 2 (kills a mutant collapsing it into "promote")', garbageCmd.status === 2 && /Usage:/.test(garbageCmd.stderr));

  const strayFlag = runCLI(['plan', '--task', 'x', '--n', '1', '--totally-unknown-flag', '--json']);
  t('an unrecognized flag never accidentally trips --help (kills a forced-true mutant on the help-flag check)', strayFlag.status === 0 && (() => {
    try { return Array.isArray(JSON.parse(strayFlag.stdout).variants); } catch { return false; }
  })());

  const helpRes = runCLI(['--help']);
  t('CLI --help exits 0', helpRes.status === 0);

  const shortHelpRes = runCLI(['-h']);
  t('CLI -h exits 0', shortHelpRes.status === 0);

  const subHelpRes = runCLI(['plan', '--help']); // no --task given — must still exit 0 via the help flag, not the usage-error path
  t('CLI "<subcommand> --help" exits 0 (help wins over a missing required flag)', subHelpRes.status === 0);
  const subShortHelpRes = runCLI(['score', '-h']);
  t('CLI "<subcommand> -h" exits 0', subShortHelpRes.status === 0);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
