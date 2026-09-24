#!/usr/bin/env node
'use strict';
// forge-sweep.test.cjs — hermetic tests for forge-sweep.cjs (+ core/extract/aggregate). No network: yt-dlp is a
// node stub (FORGE_SWEEP_YTDLP), extraction uses a chat() stub (FORGE_SWEEP_EXTRACT_STUB) or the real provider in
// its no-key mock mode (NVIDIA_SKIP_ENV_FILES=1, key removed). All waits are scaled to 0 (FORGE_SWEEP_SLEEP_SCALE=0)
// while the PLANNED backoff schedule is still asserted from the ledger. Everything lives in a temp containment root.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const TOOL = path.join(__dirname, 'forge-sweep.cjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-test-'));
process.env.FORGE_SWEEP_ROOT = ROOT;
const core = require('./forge-sweep-core.cjs');
const sweep = require('./forge-sweep.cjs');
const ex = require('./forge-sweep-extract.cjs');
const agg = require('./forge-sweep-aggregate.cjs');
let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); } }
// ---------------------------------------------------------------- fixtures
const STUB_CFG = path.join(ROOT, 'stub-cfg.json'), CALLS = path.join(ROOT, 'stub-calls.jsonl'), YT_STUB = path.join(ROOT, 'yt-stub.cjs');
fs.writeFileSync(YT_STUB, `
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.env.STUB_CFG, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(args) + '\\n');
const last = args[args.length - 1];
if (args.includes('--flat-playlist')) {
  const q = /^ytsearch\\d+:(.*)$/.exec(last)[1];
  const spec = cfg.search[q];
  if (spec === '429') { process.stderr.write('ERROR: HTTP Error 429: Too Many Requests\\n'); process.exit(1); }
  for (const row of spec || []) process.stdout.write(JSON.stringify(row) + '\\n');
  process.stdout.write('not json noise\\n');
  process.exit(0);
}
if (!args.includes('--skip-download')) { process.stderr.write('stub: refusing a media download\\n'); process.exit(9); }
const id = new URL(last).searchParams.get('v');
if (args.includes('--dump-json')) {
  const m = (cfg.meta || {})[id];
  if (m === '429') { process.stderr.write('ERROR: [youtube] ' + id + ': HTTP Error 429: Too Many Requests\\n'); process.exit(1); }
  if (!m) { process.stderr.write('ERROR: [youtube] ' + id + ': Video unavailable\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ id, ...m }) + '\\n'); process.exit(0);
}
const lang = args[args.indexOf('--sub-lang') + 1];
const out = args[args.indexOf('-o') + 1];
const vid = cfg.subs[id] || {};
if (vid.unavailable) { process.stderr.write('ERROR: [youtube] ' + id + ': Video unavailable\\n'); process.exit(1); }
if (args.includes('--print')) process.stdout.write('SWEEPLANG=' + (vid.lang || 'NA') + '\\n');
const spec = (vid.tracks || {})[lang];
const prior = fs.readFileSync(process.env.STUB_CALLS, 'utf8').split('\\n').filter((l) => l.includes(id) && l.includes(JSON.stringify(lang))).length - 1;
if (spec === '429' || (spec && spec.fail429 > prior)) { process.stderr.write('ERROR: Unable to download video subtitles for ' + lang + ': HTTP Error 429: Too Many Requests\\n'); process.exit(1); }
if (!spec || spec === 'none') process.exit(0);
fs.writeFileSync(out.replace('%(id)s', id) + '.' + lang + '.json3', JSON.stringify(spec.json3 || spec));
process.exit(0);
`);
const J3 = (lines) => ({ events: lines.map(([ms, segs]) => ({ tStartMs: ms, segs: segs.map((s) => ({ utf8: s })) })) });
const json3a = { events: [
  { tStartMs: 0, segs: [{ utf8: '\n' }] },
  { tStartMs: 5000, segs: [{ utf8: 'always start' }, { utf8: ' in plan mode' }] },
  { tStartMs: 6000, segs: [{ utf8: '\n' }], aAppend: 1 },
  { tStartMs: 65000, segs: [{ utf8: 'put rules in' }, { utf8: '   CLAUDE.md' }] },
  { tStartMs: 70000 },
] };
const row = (id, title, duration, views) => ({ id, title, duration, view_count: views, channel: 'Chan ' + id.slice(0, 3), description: 'desc of ' + id, timestamp: 1750000000 });
const cfg = {
  search: {
    'q one': [row('okVideo0001', 'Claude Code tips for beginners 2026', 600, 1000), row('okVideo0002', 'Best Claude Code skills', 900, 50000),
      row('homonym0001', 'Claude Monet painting tutorial', 700, 9), row('shortVid001', 'Claude Code tip', 60, 5), { id: 'noDur000001', title: 'Claude Code guide', view_count: 3 },
      { id: '../../evil', title: 'Claude escape attempt', duration: 600 }],
    'q two': [row('okVideo0001', 'Claude Code tips for beginners 2026', 600, 1000), row('rateLim0001', 'Claude Code setup guide', 800, 100),
      row('noCaps00001', 'Claude Code hooks tutorial', 1200, 5000), row('longVid0001', 'Claude code full course', 20000, 7), row('zeroScore01', 'Random vlog', 500, 1),
      row('gone0000001', 'Claude Code MCP for beginners', 700, 10), row('dutchVid001', 'Claude Code uitleg voor beginners in het Nederlands', 900, 200),
      row('flaky429001', 'Claude Code mistakes beginners make', 1000, 300)],
    'q empty': [],
    'q rl': '429',
  },
  subs: { // lang = what yt-dlp prints for %(language)s; tracks = EXACT track code → json3 | '429' | { fail429, json3 } | 'none'
    okVideo0001: { lang: 'en', tracks: { 'en-orig': json3a, en: json3a } },
    okVideo0002: { lang: 'de', tracks: { 'de-orig': J3([[1000, ['start in plan mode before any editing']]]) } },
    noCaps00001: { lang: 'en', tracks: {} }, gone0000001: { unavailable: true },
    dutchVid001: { lang: 'NA', tracks: { 'nl-orig': J3([[2000, ['uitleg in het nederlands']]]), nl: 'none', en: J3([[2000, ['uitleg in english']]]) } },
    flaky429001: { lang: 'en', tracks: { 'en-orig': { fail429: 2, json3: J3([[3000, ['avoid giant prompts']]]) } } },
    rateLim0001: { lang: 'en', tracks: { 'en-orig': '429' } },
  },
};
const writeCfg = () => fs.writeFileSync(STUB_CFG, JSON.stringify(cfg));
writeCfg(); fs.writeFileSync(CALLS, '');
const research = path.join(ROOT, '.claude', 'forge-research');
fs.mkdirSync(path.join(research, 'youtube-batches'), { recursive: true });
fs.writeFileSync(path.join(research, '_known_video_ids.txt'), 'okVideo0002\n');
fs.writeFileSync(path.join(research, 'youtube-batches', 'batch-01.jsonl'), JSON.stringify({ id: 'noCaps00001', title: 'x' }) + '\n');
const QUERIES = path.join(ROOT, 'queries.txt');
fs.writeFileSync(QUERIES, '# comment\nq one\nq two\n\nq empty\nq rl\nq one\n');
// extraction stub: behaviour per video id, call log per process
const EX_STUB = path.join(ROOT, 'chat-stub.cjs'), EX_LOG = path.join(ROOT, 'chat-calls.jsonl');
fs.writeFileSync(EX_STUB, `
const fs = require('fs');
const good = (id, tips, skills) => JSON.stringify({ video_id: id, audience_level: 'beginner', beginner_tips: tips.map((tip) => ({ tip, why: 'w', ts: '00:05' })),
  mistakes: [{ mistake: 'letting it edit without reviewing the plan', fix: 'use plan mode', ts: '01:05' }], skills_mentioned: skills,
  commands_or_features: ['/clear'], setup_steps: ['npm i -g @anthropic-ai/claude-code'], pain_points: ['context fills up'], prompting_advice: ['be specific'],
  quotes: [{ ts: '00:05', text: 'always start in plan mode' }], forge_can_do_this_for_them: ['create a starter CLAUDE.md'], confidence: 'high' });
const seen = {};
exports.chat = async (o) => {
  const id = /VIDEO_ID: (\\S+)/.exec(o.prompt)[1];
  seen[id] = (seen[id] || 0) + 1;
  fs.appendFileSync(process.env.EX_LOG, JSON.stringify({ id, n: seen[id], model: o.model, role: o.role, nudge: /Return ONLY the JSON object now/.test(o.prompt) }) + '\\n');
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  const model = o.model || ('role:' + o.role);
  if (id === 'okVideo0001') return seen[id] === 1 ? { model, usage, content: 'Sure! here are tips' }
    : { model, usage, content: '<think>hmm</think>\\n\\u0060\\u0060\\u0060json\\n' + good(id, ['Always start in plan mode before editing', 'Keep a CLAUDE.md file with project rules'], [{ name: 'skill-creator', source_or_repo_if_said: 'anthropics/skills', what_it_does: 'makes skills' }]) + '\\n\\u0060\\u0060\\u0060' };
  if (id === 'okVideo0002') return { model, usage, content: good(id, ['Start in plan mode before any editing!', 'Use /clear between unrelated tasks'], [{ name: 'Skill Creator' }, 'frontend-design']) };
  if (id === 'rateLim0001') return { model, usage, content: good(id, ['always start in PLAN MODE before editing'], [{ name: 'frontend design' }]) };
  if (id === 'flaky429001') return { model, usage: null, error: 'HTTP 503: upstream nvapi-SECRETKEY1234567890abc failed for account \\'acct-XYZ\\'' };
  if (id === 'gone0000001') return { model, error: 'HTTP 410: model gone' };
  return { model, usage, content: '{"audience_level":"expert","confidence":"high"}' };
};
`);
function run(args, extraEnv) {
  const env = { ...process.env, FORGE_SWEEP_ROOT: ROOT, FORGE_SWEEP_YTDLP: YT_STUB, FORGE_SWEEP_SLEEP_SCALE: '0', STUB_CFG, STUB_CALLS: CALLS,
    EX_LOG, NVIDIA_SKIP_ENV_FILES: '1', ...(extraEnv || {}) };
  delete env.NVIDIA_API_KEY;
  for (const [k, v] of Object.entries(extraEnv || {})) if (v === null) delete env[k];
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env, timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const DIR = path.join(ROOT, '.claude', 'forge-research', 'beginner-sweep-2026-09-24');
const D = ['--dir', DIR];
const ledger = (dir) => core.readJsonl(path.join(dir || DIR, 'sweep-ledger.jsonl')).rows;
const callsLog = () => fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cands = () => new Map(core.readJsonl(path.join(DIR, 'candidates.jsonl')).rows.map((r) => [r.id, r]));
console.log('forge-sweep tests');
// ---------------------------------------------------------------- CLI basics + containment
t('usage errors exit 2 (no command, unknown flag, --dir outside the containment root)', () => {
  assert.strictEqual(run([]).code, 2);
  assert.strictEqual(run(['status', '--bogus', '1', ...D]).code, 2);
  const r = run(['status', '--dir', path.join(os.tmpdir(), 'outside-' + process.pid)]);
  assert.strictEqual(r.code, 2); assert.ok(/must stay under/.test(r.out), r.out);
});
t('safeJoin refuses a path escaping the sweep dir; ids must be 11-char YouTube ids', () => {
  assert.throws(() => core.safeJoin(DIR, '..', 'x.txt'), /escapes/);
  assert.throws(() => core.safeJoin(DIR, 'transcripts', '../../../evil.txt'), /escapes/);
  assert.strictEqual(core.isVideoId('okVideo0001'), true);
  assert.strictEqual(core.isVideoId('../../evil'), false);
});
t('missing yt-dlp is a plain hard failure (exit 1) naming the install command', () => {
  const r = run(['enumerate', '--queries', QUERIES, ...D], { FORGE_SWEEP_YTDLP: path.join(ROOT, 'no-such-ytdlp-binary') });
  assert.strictEqual(r.code, 1, r.out); assert.ok(/pip install yt-dlp/.test(r.out), r.out);
  assert.strictEqual(ledger().length, 0, 'no ledger row may be written when nothing ran');
});
// ---------------------------------------------------------------- enumerate
t('enumerate merges duplicate ids across queries, marks previously_seen, records empty + rate-limited queries, exit 3', () => {
  const r = run(['enumerate', '--queries', QUERIES, '--per-query', '7', ...D]);
  assert.strictEqual(r.code, 3, r.out);
  const c = cands();
  assert.strictEqual(c.size, 12, 'unique ids (hostile ../../evil id dropped)');
  assert.ok(!c.has('../../evil'));
  assert.deepStrictEqual(c.get('okVideo0001').queries, ['q one', 'q two']);
  assert.strictEqual(c.get('okVideo0002').previously_seen, true);
  assert.strictEqual(c.get('noCaps00001').previously_seen, true, 'id from youtube-batches/*.jsonl');
  assert.strictEqual(c.get('rateLim0001').previously_seen, false);
  const sum = JSON.parse(fs.readFileSync(path.join(DIR, 'enumerate-summary.json'), 'utf8'));
  assert.strictEqual(sum.queries, 4, 'duplicate + comment lines in the query file are ignored');
  assert.deepStrictEqual(sum.by_outcome, { ok: 2, empty: 1, rate_limited: 1 });
  const q2 = sum.per_query.find((q) => q.query === 'q two');
  assert.strictEqual(q2.rows, 8); assert.strictEqual(q2.new, 7); assert.strictEqual(q2.dupes, 1);
  assert.ok(callsLog().some((a) => a.includes('ytsearch7:q one')), 'per-query N is passed to ytsearch');
});
t('enumerate resume skips queries the ledger shows done; only the rate-limited one is re-run', () => {
  const before = callsLog().length;
  cfg.search['q rl'] = [row('okVideo0001', 'Claude Code tips for beginners 2026', 600, 1000)]; writeCfg();
  const r = run(['enumerate', '--queries', QUERIES, '--per-query', '7', ...D]);
  assert.strictEqual(r.code, 0, r.out);
  const newCalls = callsLog().slice(before);
  assert.strictEqual(newCalls.length, 1); assert.ok(newCalls[0].includes('ytsearch7:q rl'));
  assert.deepStrictEqual(cands().get('okVideo0001').queries, ['q one', 'q two', 'q rl']);
  const s = core.computeStatus(DIR).enumerate;
  assert.strictEqual(s.unique_candidates, 12); assert.strictEqual(s.previously_seen_candidates, 2); assert.strictEqual(s.queries_attempted, 4);
});
// ---------------------------------------------------------------- filter
t('scoreTitle applies +3 claude +2 beginner +2 feature +1 year and -5 homonym', () => {
  assert.strictEqual(sweep.scoreTitle('Claude Code tips for beginners 2026').score, 6);
  assert.strictEqual(sweep.scoreTitle('Claude Code hooks tutorial').score, 7);
  assert.strictEqual(sweep.scoreTitle('Claude Monet painting tutorial').score, 0);
  assert.ok(sweep.scoreTitle('Claude Shannon information theory').hits.includes('homonym'));
  assert.strictEqual(sweep.scoreTitle('Random vlog').score, 0);
  assert.ok(sweep.scoreTitle('x', 999).tie > sweep.scoreTitle('x', 9).tie);
});
t('filter drops out-of-range / unknown durations, homonyms, zero scores and ranks the top N', () => {
  assert.strictEqual(run(['filter', '--top', '6', ...D]).code, 0);
  const fsum = JSON.parse(fs.readFileSync(path.join(DIR, 'filter-summary.json'), 'utf8'));
  assert.deepStrictEqual(fsum.dropped, { duration_unknown: 1, duration_short: 1, duration_long: 1, homonym: 1, zero_score: 1, below_top_n: 1 });
  let sl = core.readJsonl(path.join(DIR, 'shortlist.jsonl')).rows;
  assert.deepStrictEqual(sl.map((c) => c.id), ['noCaps00001', 'gone0000001', 'okVideo0001', 'okVideo0002', 'flaky429001', 'dutchVid001']);
  assert.strictEqual(run(['filter', '--top', '20', ...D]).code, 0);
  sl = core.readJsonl(path.join(DIR, 'shortlist.jsonl')).rows;
  assert.strictEqual(sl.length, 7); assert.strictEqual(sl[6].id, 'rateLim0001');
});
t('filter --seed-ids forces seeds first (found → marked, unknown → one metadata request, 429 → meta_missing), dedupes, validates ids', () => {
  const d6 = path.join(ROOT, '.claude', 'forge-research', 'seeds');
  fs.mkdirSync(d6, { recursive: true });
  core.writeJsonl(path.join(d6, 'candidates.jsonl'), [
    { ...row('okVideo0001', 'Claude Code tips for beginners 2026', 600, 1000), queries: ['q one'] }, { ...row('okVideo0002', 'Best Claude Code skills', 900, 50000), queries: ['q one'] },
    { ...row('zeroScore01', 'Random vlog', 20000, 1), queries: ['q two'] }]);
  cfg.meta = { seedVid0001: { title: 'Claude Code for total beginners', duration: 700, view_count: 42, channel: 'Seed Chan', description: 'seed desc' }, seedRl00001: '429' }; writeCfg();
  const SEEDS = path.join(ROOT, 'seeds.txt');
  fs.writeFileSync(SEEDS, '# lead seeds\nzeroScore01\nseedVid0001\nseedRl00001\nseedVid0001\n');
  const before = callsLog().length;
  const r = run(['filter', '--top', '1', '--seed-ids', SEEDS, '--dir', d6]);
  assert.strictEqual(r.code, 0, r.out);
  const sl = core.readJsonl(path.join(d6, 'shortlist.jsonl')).rows;
  assert.deepStrictEqual(sl.map((c) => [c.id, !!c.seed]), [['seedVid0001', true], ['zeroScore01', true], ['seedRl00001', true], ['okVideo0001', false]]);
  assert.strictEqual(sl[0].title, 'Claude Code for total beginners'); assert.strictEqual(sl[2].meta_missing, true);
  const calls = callsLog().slice(before);
  assert.strictEqual(calls.length, 5, '1 metadata request + 4 for the 429 seed, 0 for the seed a query found');
  assert.ok(calls.every((a) => a.includes('--skip-download') && !a.includes('--flat-playlist')));
  const S = core.latestBy(ledger(d6), 'seed', 'id');
  assert.deepStrictEqual(['zeroScore01', 'seedVid0001', 'seedRl00001'].map((id) => S.get(id).outcome), ['found_by_query', 'ok', 'rate_limited']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d6, 'filter-summary.json'), 'utf8')).seeds_forced, 3);
  const again = callsLog().length;
  assert.strictEqual(run(['filter', '--top', '1', '--seed-ids', SEEDS, '--dir', d6]).code, 0);
  assert.ok(callsLog().slice(again).every((a) => a.join(' ').includes('seedRl00001')), 'rerun only retries the meta_missing seed');
  fs.writeFileSync(SEEDS, 'not-an-id\n');
  assert.strictEqual(run(['filter', '--seed-ids', SEEDS, '--dir', d6]).code, 2);
  assert.deepStrictEqual(core.computeStatus(d6).seeds.by_outcome, { found_by_query: 1, ok: 1, rate_limited: 1 });
});
// ---------------------------------------------------------------- transcripts
t('json3ToText merges segs per event, skips newline-only events, formats [mm:ss]', () => {
  assert.strictEqual(sweep.json3ToText(json3a), '[00:05] always start in plan mode\n[01:05] put rules in CLAUDE.md');
  assert.strictEqual(sweep.fmtTs(4000 * 1000), '66:40');
  assert.strictEqual(sweep.json3ToText({}), '');
  assert.strictEqual(sweep.isDutchTitle('Claude Code uitleg voor beginners'), true);
  assert.strictEqual(sweep.isDutchTitle('Claude Code tips for beginners'), false);
});
t('transcripts: ok / no_captions / unavailable / 429 backoff 30-60-120 then parked, original-language track, retry-after-429, exit 3', () => {
  const before = callsLog().length;
  const r = run(['transcripts', ...D]);
  assert.strictEqual(r.code, 3, r.out);
  const L = core.latestBy(ledger(), 'transcripts', 'id');
  assert.strictEqual(L.get('okVideo0001').outcome, 'ok');
  assert.strictEqual(fs.readFileSync(path.join(DIR, 'transcripts', 'okVideo0001.txt'), 'utf8'), '[00:05] always start in plan mode\n[01:05] put rules in CLAUDE.md\n');
  assert.strictEqual(L.get('noCaps00001').outcome, 'no_captions');
  assert.strictEqual(L.get('gone0000001').outcome, 'error'); assert.strictEqual(L.get('gone0000001').reason, 'unavailable');
  assert.deepStrictEqual(L.get('okVideo0001').langs_tried, ['en-orig'], 'English original: exactly one request');
  assert.deepStrictEqual(L.get('okVideo0002').langs_tried, ['en-orig', 'de-orig'], 'non-English: en-orig, then <printed language>-orig');
  assert.strictEqual(L.get('okVideo0002').lang, 'de-orig'); assert.strictEqual(L.get('okVideo0002').video_lang, 'de');
  assert.deepStrictEqual(L.get('dutchVid001').langs_tried, ['en-orig', 'nl-orig'], 'unknown language (NA) + Dutch title → nl-orig');
  assert.deepStrictEqual(L.get('noCaps00001').langs_tried, ['en-orig', 'en']);
  assert.strictEqual(L.get('flaky429001').outcome, 'ok'); assert.deepStrictEqual(L.get('flaky429001').backoff_ms, [30000, 60000]); assert.strictEqual(L.get('flaky429001').requests, 3);
  const rl = L.get('rateLim0001');
  assert.strictEqual(rl.outcome, 'rate_limited'); assert.deepStrictEqual(rl.backoff_ms, [30000, 60000, 120000]); assert.strictEqual(rl.requests, 4);
  const sub = callsLog().slice(before);
  assert.ok(sub.every((a) => a.includes('--skip-download') && a.includes('--sleep-subtitles') && a.filter((x) => x === '--sub-lang').length === 1), 'one --sub-lang per request, never a media download');
  assert.ok(sub.every((a) => !/[*?[\]|^$]/.test(a[a.indexOf('--sub-lang') + 1])), 'exact track codes only — a regex could match every dubbed track');
  assert.strictEqual(fs.readdirSync(path.join(DIR, 'subs')).length, 0, 'raw json3 removed after conversion');
  const st = core.computeStatus(DIR).transcripts;
  assert.deepStrictEqual([st.ok, st.no_captions, st.rate_limited, st.error], [4, 1, 1, 1]);
});
t('transcripts resume only re-fetches parked ids; a later success clears the park (exit 0)', () => {
  const before = callsLog().length;
  cfg.subs.rateLim0001 = { lang: 'en', tracks: { 'en-orig': J3([[4000, ['finally captions']]]) } }; writeCfg();
  const r = run(['transcripts', ...D]);
  assert.strictEqual(r.code, 0, r.out);
  const sub = callsLog().slice(before);
  assert.strictEqual(sub.length, 1); assert.ok(sub[0].some((a) => a.includes('rateLim0001')));
  assert.strictEqual(core.computeStatus(DIR).transcripts.ok, 5);
});
t('transcripts circuit breaker stops a pass after N consecutive parked ids, keeps the rest for later', () => {
  const d2 = path.join(ROOT, '.claude', 'forge-research', 'breaker');
  fs.mkdirSync(d2, { recursive: true });
  cfg.subs.parkAaaaaa1 = { lang: 'en', tracks: { 'en-orig': '429' } }; cfg.subs.parkBbbbbb2 = { lang: 'en', tracks: { 'en-orig': '429' } }; writeCfg();
  core.writeJsonl(path.join(d2, 'shortlist.jsonl'), [{ rank: 1, id: 'parkAaaaaa1', title: 'Claude a' }, { rank: 2, id: 'parkBbbbbb2', title: 'Claude b' }]);
  const r = run(['transcripts', '--max-consecutive-parked', '1', '--dir', d2]);
  assert.strictEqual(r.code, 3); assert.ok(/STOPPED/.test(r.out), r.out);
  assert.deepStrictEqual(ledger(d2).map((x) => x.id), ['parkAaaaaa1']);
});
t('--sub-lang <code> (legacy) tries nl then the code for Dutch titles; a hostile --sub-lang is a usage error', () => {
  const d7 = path.join(ROOT, '.claude', 'forge-research', 'legacy-lang');
  fs.mkdirSync(d7, { recursive: true });
  core.writeJsonl(path.join(d7, 'shortlist.jsonl'), [{ rank: 1, id: 'dutchVid001', title: 'Claude Code uitleg voor beginners in het Nederlands' }, { rank: 2, id: 'okVideo0001', title: 'Claude Code tips' }]);
  assert.strictEqual(run(['transcripts', '--sub-lang', 'en', '--dir', d7]).code, 0);
  const L = core.latestBy(ledger(d7), 'transcripts', 'id');
  assert.deepStrictEqual(L.get('dutchVid001').langs_tried, ['nl', 'en']); assert.strictEqual(L.get('dutchVid001').lang, 'en');
  assert.deepStrictEqual(L.get('okVideo0001').langs_tried, ['en']); assert.strictEqual(L.get('okVideo0001').lang, 'en');
  assert.strictEqual(run(['transcripts', '--sub-lang', 'en;calc', '--dir', d7]).code, 2);
});
t('--redo re-processes a done id from an existing raw file (0 requests), removes every leftover track, and makes extract re-run it', () => {
  const d8 = path.join(ROOT, '.claude', 'forge-research', 'redo');
  fs.mkdirSync(path.join(d8, 'subs'), { recursive: true });
  core.writeJsonl(path.join(d8, 'shortlist.jsonl'), [{ rank: 1, id: 'dubbedVid01', title: 'Claude Code plugins' }]);
  fs.writeFileSync(path.join(d8, 'sweep-ledger.jsonl'), [
    { ts: '2026-09-24T00:00:00.000Z', stage: 'transcripts', id: 'dubbedVid01', outcome: 'ok', lang: 'ar-orig', chars: 9 },
    { ts: '2026-09-24T00:00:01.000Z', stage: 'extract', id: 'dubbedVid01', outcome: 'ok', calls: 1 }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  for (const l of ['ar-orig', 'bn-orig', 'nl-NL-orig']) fs.writeFileSync(path.join(d8, 'subs', 'dubbedVid01.' + l + '.json3'), JSON.stringify(J3([[0, ['dubbed ' + l]]])));
  fs.writeFileSync(path.join(d8, 'subs', 'dubbedVid01.en-orig.json3'), JSON.stringify(J3([[0, ['the english original']]])));
  cfg.subs.dubbedVid01 = { lang: 'en-US', tracks: {} }; writeCfg();
  const before = callsLog().length;
  assert.strictEqual(run(['transcripts', '--redo', 'dubbedVid01', '--dir', d8]).code, 0);
  assert.strictEqual(callsLog().length, before, 'the en-orig file already on disk is reused — no YouTube request');
  const r = core.latestBy(ledger(d8), 'transcripts', 'id').get('dubbedVid01');
  assert.deepStrictEqual([r.lang, r.redo, r.reused_raw, r.requests], ['en-orig', true, true, 0]);
  assert.strictEqual(fs.readFileSync(path.join(d8, 'transcripts', 'dubbedVid01.txt'), 'utf8'), '[00:00] the english original\n');
  assert.deepStrictEqual(fs.readdirSync(path.join(d8, 'subs')), [], 'all leftover dubbed tracks removed');
  const x = run(['extract', '--dir', d8], { FORGE_SWEEP_EXTRACT_STUB: EX_STUB });
  assert.ok(/to extract=1\b/.test(x.out), 'an extract row older than the redone transcript is not "done": ' + x.out);
  assert.strictEqual(run(['transcripts', '--redo', '../bad', '--dir', d8]).code, 2);
});
t('security L6: a tampered shortlist url never reaches yt-dlp — the URL is rebuilt from the validated id, after "--"', () => {
  const d10 = path.join(ROOT, '.claude', 'forge-research', 'tampered');
  fs.mkdirSync(d10, { recursive: true });
  core.writeJsonl(path.join(d10, 'shortlist.jsonl'), [{ rank: 1, id: 'okVideo0001', title: 'Claude Code tips', url: 'https://evil.example/x --exec calc' }]);
  const before = callsLog().length;
  assert.strictEqual(run(['transcripts', '--dir', d10]).code, 0);
  const calls = callsLog().slice(before);
  assert.ok(calls.length >= 1);
  for (const a of calls) {
    assert.ok(!a.some((x) => /evil|--exec|calc/.test(x)), 'tampered url leaked into args: ' + JSON.stringify(a));
    assert.strictEqual(a[a.length - 1], 'https://www.youtube.com/watch?v=okVideo0001');
    assert.strictEqual(a[a.length - 2], '--', 'positional URL must follow "--"');
  }
  assert.ok(callsLog().slice(0, before).filter((a) => a.includes('--flat-playlist')).every((a) => a[a.length - 2] === '--'), 'search term also follows "--"');
});
t('a live lock holder blocks a second writer of the same stage (exit 1)', () => {
  const pidFile = path.join(DIR, 'logs', 'transcripts.pid');
  fs.writeFileSync(pidFile, process.pid + ' test\n');
  const r = run(['transcripts', ...D]);
  fs.unlinkSync(pidFile);
  assert.strictEqual(r.code, 1); assert.ok(/already running/.test(r.out), r.out);
});
// ---------------------------------------------------------------- extract
t('parseModelJson strips <think> and fences; validateExtraction enforces enums and normalises items', () => {
  assert.deepStrictEqual(ex.parseModelJson('<think>x</think>```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(ex.parseModelJson('Here: {"a":2} done'), { a: 2 });
  assert.strictEqual(ex.parseModelJson('no json'), null);
  assert.strictEqual(ex.validateExtraction({ audience_level: 'expert', confidence: 'high' }, 'okVideo0001').ok, false);
  assert.strictEqual(ex.validateExtraction({ audience_level: 'beginner', confidence: 'low', beginner_tips: 'x' }, 'okVideo0001').ok, false);
  const v = ex.validateExtraction({ video_id: 'WRONG', audience_level: 'Beginner', confidence: 'low', beginner_tips: ['plain string tip', { why: 'no tip' }], skills_mentioned: [{ name: 'x' }] }, 'okVideo0001');
  assert.strictEqual(v.ok, true); assert.strictEqual(v.value.video_id, 'okVideo0001'); assert.strictEqual(v.video_id_corrected, true);
  assert.deepStrictEqual(v.value.beginner_tips, [{ tip: 'plain string tip', why: '', ts: '' }]); assert.strictEqual(v.dropped_items, 1);
  assert.deepStrictEqual(v.value.mistakes, []);
});
t('chunkText splits on line boundaries under max-chars; mergeChunks unions + dedupes + marks mixed', () => {
  const text = Array.from({ length: 50 }, (_, i) => '[00:' + String(i).padStart(2, '0') + '] line number ' + i).join('\n');
  const ch = ex.chunkText(text, 200);
  assert.ok(ch.length > 1 && ch.every((c) => c.length <= 200)); assert.strictEqual(ch.join('\n'), text);
  const base = { video_id: 'okVideo0001', mistakes: [], skills_mentioned: [], commands_or_features: [], setup_steps: [], pain_points: [], prompting_advice: [], quotes: [], forge_can_do_this_for_them: [] };
  const m = ex.mergeChunks([{ ...base, audience_level: 'beginner', confidence: 'high', beginner_tips: [{ tip: 'A tip!' }] }, { ...base, audience_level: 'advanced', confidence: 'medium', beginner_tips: [{ tip: 'a tip' }, { tip: 'b' }] }]);
  assert.strictEqual(m.audience_level, 'mixed'); assert.strictEqual(m.confidence, 'medium'); assert.strictEqual(m.beginner_tips.length, 2);
});
t('extract: retry-with-nudge succeeds, 3-step failure → extract_failed via fallback model, transient error → extract_error, keys redacted', () => {
  fs.writeFileSync(EX_LOG, '');
  const r = run(['extract', '--model', 'prim/model', '--fallback-model', 'fb/model', ...D], { FORGE_SWEEP_EXTRACT_STUB: EX_STUB });
  assert.strictEqual(r.code, 3, r.out);
  const L = core.latestBy(ledger(), 'extract', 'id');
  assert.strictEqual(L.get('okVideo0001').outcome, 'ok'); assert.strictEqual(L.get('okVideo0001').calls, 2);
  assert.strictEqual(L.get('dutchVid001').outcome, 'extract_failed'); assert.strictEqual(L.get('dutchVid001').calls, 3);
  assert.strictEqual(L.get('flaky429001').outcome, 'extract_error');
  assert.ok(L.get('okVideo0001').engine.startsWith('stub:'), 'a stub engine is stamped, never hidden');
  const calls = fs.readFileSync(EX_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.id === 'dutchVid001');
  assert.deepStrictEqual(calls.map((c) => [c.model, c.nudge]), [['prim/model', false], ['prim/model', true], ['fb/model', true]]);
  const rec = JSON.parse(fs.readFileSync(path.join(DIR, 'extracted', 'okVideo0001.json'), 'utf8'));
  assert.strictEqual(rec.video_id, 'okVideo0001'); assert.strictEqual(rec.chunks, 1); assert.strictEqual(rec.usage.total_tokens, 220); assert.strictEqual(rec.model, 'prim/model');
  const everything = fs.readFileSync(path.join(DIR, 'sweep-ledger.jsonl'), 'utf8') + r.out + fs.readdirSync(path.join(DIR, 'extracted', '_failed')).map((f) => fs.readFileSync(path.join(DIR, 'extracted', '_failed', f), 'utf8')).join('');
  assert.ok(!everything.includes('SECRETKEY1234567890abc'), 'nvapi key leaked'); assert.ok(!everything.includes('acct-XYZ'), 'account id leaked');
  assert.ok(everything.includes('nvapi-***REDACTED***'));
  assert.ok(!fs.existsSync(path.join(DIR, 'extracted', 'noCaps00001.json')), 'only transcripts with outcome ok are extracted');
});
t('extract resume skips ok + extract_failed ids; a gone model (HTTP 410) is a hard stop, not a failed transcript', () => {
  const r = run(['extract', '--model', 'prim/model', '--fallback-model', 'fb/model', ...D], { FORGE_SWEEP_EXTRACT_STUB: EX_STUB });
  assert.strictEqual(r.code, 3, r.out);
  assert.ok(/to extract=1\b/.test(r.out), 'only the extract_error id is retried: ' + r.out);
  const d3 = path.join(ROOT, '.claude', 'forge-research', 'gone');
  fs.mkdirSync(path.join(d3, 'transcripts'), { recursive: true });
  fs.writeFileSync(path.join(d3, 'transcripts', 'gone0000001.txt'), '[00:01] hi\n');
  fs.writeFileSync(path.join(d3, 'sweep-ledger.jsonl'), JSON.stringify({ stage: 'transcripts', id: 'gone0000001', outcome: 'ok', chars: 10 }) + '\n');
  const g = run(['extract', '--dir', d3], { FORGE_SWEEP_EXTRACT_STUB: EX_STUB });
  assert.strictEqual(g.code, 1, g.out); assert.ok(/gone\/unknown/.test(g.out), g.out);
  assert.strictEqual(ledger(d3).filter((x) => x.stage === 'extract').length, 0);
});
t('extract --ids-file restricts + orders; --max-chunks reads only the first chunks and labels the record partial; waiting ids → exit 3', () => {
  const d9 = path.join(ROOT, '.claude', 'forge-research', 'subset');
  fs.mkdirSync(path.join(d9, 'transcripts'), { recursive: true });
  const long = Array.from({ length: 120 }, (_, i) => '[00:' + String(i % 60).padStart(2, '0') + '] a fairly long caption line number ' + i).join('\n');
  fs.writeFileSync(path.join(d9, 'transcripts', 'okVideo0002.txt'), long + '\n');
  fs.writeFileSync(path.join(d9, 'transcripts', 'rateLim0001.txt'), '[00:01] short\n');
  fs.writeFileSync(path.join(d9, 'sweep-ledger.jsonl'), ['okVideo0002', 'rateLim0001', 'okVideo0001'].map((id) => JSON.stringify({ ts: '2026-09-24T00:00:00.000Z', stage: 'transcripts', id, outcome: 'ok', chars: 10 })).join('\n') + '\n');
  const IDS = path.join(ROOT, 'subset-ids.txt');
  fs.writeFileSync(IDS, '# subset\nrateLim0001\nokVideo0002\nmissingId01\n');
  fs.writeFileSync(EX_LOG, '');
  const r = run(['extract', '--ids-file', IDS, '--max-chunks', '1', '--max-chars', '2000', '--concurrency', '1', '--dir', d9], { FORGE_SWEEP_EXTRACT_STUB: EX_STUB });
  assert.strictEqual(r.code, 3, r.out); assert.ok(/lists 3 ids · 2 have an ok transcript/.test(r.out), r.out);
  const order = fs.readFileSync(EX_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
  assert.deepStrictEqual([...new Set(order)], ['rateLim0001', 'okVideo0002'], 'file order, okVideo0001 (not listed) untouched');
  const rec = JSON.parse(fs.readFileSync(path.join(d9, 'extracted', 'okVideo0002.json'), 'utf8'));
  assert.deepStrictEqual([rec.chunks_used, rec.partial, rec.chunks_total > 1], [1, true, true]);
  assert.strictEqual(core.latestBy(ledger(d9), 'extract', 'id').get('okVideo0002').partial, true);
  assert.strictEqual(run(['aggregate', '--dir', d9]).code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d9, 'beginner-knowledge.json'), 'utf8')).provenance.partial_transcript_records, 1);
});
t('real provider without a key (mock mode) is refused as a hard failure, never counted as an extraction', () => {
  const d4 = path.join(ROOT, '.claude', 'forge-research', 'nokey');
  fs.mkdirSync(path.join(d4, 'transcripts'), { recursive: true });
  fs.writeFileSync(path.join(d4, 'transcripts', 'okVideo0001.txt'), '[00:01] hi\n');
  fs.writeFileSync(path.join(d4, 'sweep-ledger.jsonl'), JSON.stringify({ stage: 'transcripts', id: 'okVideo0001', outcome: 'ok', chars: 10 }) + '\n');
  const r = run(['extract', '--dir', d4], { FORGE_SWEEP_EXTRACT_STUB: null });
  assert.strictEqual(r.code, 1, r.out); assert.ok(/MOCK mode/.test(r.out), r.out);
  const m = run(['extract', '--engine', 'mock', '--dir', d4]);
  assert.strictEqual(m.code, 0, m.out);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d4, 'extracted', 'okVideo0001.json'), 'utf8')).engine, 'mock');
  assert.strictEqual(run(['aggregate', '--dir', d4]).code, 0);
  const k = JSON.parse(fs.readFileSync(path.join(d4, 'beginner-knowledge.json'), 'utf8'));
  assert.strictEqual(k.provenance.videos_used, 0, 'mock records are excluded from the knowledge base by default');
});
// ---------------------------------------------------------------- aggregate + status
t('groupItems merges near-duplicates (Jaccard ≥ 0.6 / shared 4-gram) and counts distinct videos', () => {
  const g = agg.groupItems([
    { text: 'Always start in plan mode before editing', id: 'a' }, { text: 'Start in plan mode before any editing!', id: 'b' },
    { text: 'always start in PLAN MODE before editing', id: 'b' }, { text: 'Use /clear between unrelated tasks', id: 'c' },
    { text: 'never paste secrets into prompts or chat windows', id: 'd' }, { text: 'please never paste secrets into prompts at all', id: 'e' },
  ]).groups;
  assert.strictEqual(g[0].support, 2); assert.strictEqual(g[0].mentions, 3); assert.ok(/plan mode/i.test(g[0].text));
  assert.strictEqual(g.find((x) => /secrets/.test(x.text)).support, 2, 'shared 4-gram "never paste secrets prompts"');
  assert.strictEqual(g.length, 3);
  // Jaccard-only path (items too short for any 4-gram): {plan,mode} vs {plan,mode,feature} = 0.67 merges; 0.5 does not.
  const j = agg.groupItems([{ text: 'Plan mode', id: 'a' }, { text: 'the plan mode feature', id: 'b' }, { text: 'plan mode feature toggle', id: 'c' }]).groups;
  assert.deepStrictEqual(j.map((x) => x.support), [2, 1], 'Jaccard ≥ 0.6 merges, 0.5 stays separate');
});
t('prompt-echo guard: the flagged example phrases are exactly the ones in the extraction prompt, and near-copies get flagged', () => {
  for (const e of agg.PROMPT_EXAMPLES) assert.ok(ex.SYSTEM_PROMPT.includes(e), 'SYSTEM_PROMPT no longer contains: ' + e);
  assert.strictEqual(agg.isPromptEcho('Create a starter CLAUDE.md file for the project.'), true);
  assert.strictEqual(agg.isPromptEcho('Install the Graphify plugin for Claude Code'), false);
  const g = agg.groupItems([{ text: 'Create a starter CLAUDE.md for the project', id: 'a' }]).groups[0];
  assert.strictEqual(g.possible_prompt_echo, true);
});
t('computeThemes counts distinct videos per keyword theme across fields, even when wording differs', () => {
  const recs = [
    { video_id: 'a', beginner_tips: [{ tip: 'Press Shift+Tab twice to enter plan mode', ts: '01:00' }], mistakes: [] },
    { video_id: 'b', beginner_tips: [], mistakes: [{ mistake: 'letting it edit before you make a plan', fix: 'plan first' }] },
    { video_id: 'c', pain_points: ['context window fills up fast'], beginner_tips: [{ tip: 'use /clear between tasks' }] },
  ];
  const th = agg.computeThemes(recs);
  const get = (k) => th.find((x) => x.key === k);
  assert.strictEqual(get('plan-mode').support, 2); assert.deepStrictEqual(get('plan-mode').per_field, { beginner_tips: 1, mistakes: 1 });
  assert.strictEqual(get('context').support, 1); assert.strictEqual(get('context').per_field.pain_points + get('context').per_field.beginner_tips, 2);
  assert.strictEqual(get('hooks').support, 0); assert.strictEqual(th[0].rank, 1); assert.ok(th[0].support >= th[th.length - 1].support);
  // auto-caption homophones: "cloud.md" / "Clawed Code" count for the CLAUDE.md theme and group with the real spelling
  assert.strictEqual(agg.computeThemes([{ video_id: 'd', beginner_tips: [{ tip: 'write your rules in cloud.md' }] }]).find((x) => x.key === 'claude-md').support, 1);
  assert.strictEqual(agg.asrFix('Clawed Code and the cloud code pro plan; cloud storage'), 'Claude Code and the Claude code pro plan; cloud storage');
  assert.strictEqual(agg.groupItems([{ text: 'Run /init to create cloud.md', id: 'a' }, { text: 'Run /init to create CLAUDE.md', id: 'b' }]).groups[0].support, 2);
});
t('aggregate writes report + knowledge base with ledger counters and grouped support', () => {
  assert.strictEqual(run(['aggregate', ...D]).code, 0);
  const k = JSON.parse(fs.readFileSync(path.join(DIR, 'beginner-knowledge.json'), 'utf8'));
  assert.strictEqual(k.INTERNAL_USE_ONLY, true); assert.strictEqual(k.provenance.videos_used, 3);
  const top = k.categories.beginner_tips[0];
  assert.strictEqual(top.support, 3); assert.ok(/plan mode/i.test(top.text)); assert.strictEqual(top.examples.length, 3);
  const sc = k.categories.skills_mentioned.find((s) => /skill.creator/i.test(s.text));
  assert.strictEqual(sc.support, 2); assert.strictEqual(sc.source_or_repo_if_said, 'anthropics/skills');
  assert.strictEqual(k.categories.skills_mentioned.find((s) => /frontend/i.test(s.text)).support, 2);
  assert.strictEqual(k._untrusted, true, 'security L7: knowledge base is flagged untrusted');
  assert.ok(/forge-scout vetting/.test(k._untrusted_notice));
  const pm = k.themes.find((th) => th.key === 'plan-mode');
  assert.strictEqual(pm.support, 3, 'plan-mode theme counts the 3 videos with a plan-mode item'); assert.ok(pm.examples.length >= 1);
  const md = fs.readFileSync(path.join(DIR, 'BEGINNER-SWEEP-2026-09-24.md'), 'utf8');
  const lines = md.split('\n');
  assert.ok(lines[2].startsWith('> **UNTRUSTED THIRD-PARTY CONTENT') && /forge-scout vetting/.test(lines[2]), 'security L7 banner directly under the title');
  assert.ok(md.includes('## Beginner themes ranked by supporting videos'));
  assert.ok(md.includes('| transcripts | ok / no_captions / rate_limited / error | 5 / 1 / 0 / 1'), 'report counters come from the ledger');
  assert.ok(md.includes('| 7 | rateLim0001 |'), 'per-video appendix');
  assert.ok(md.includes('NVIDIA tokens | ' + core.computeStatus(DIR).extract.nvidia_usage.total_tokens));
});
t('status counts only ledger rows (a stray transcript file does not count; a hand-written ledger does)', () => {
  const before = core.computeStatus(DIR).transcripts.ok;
  fs.writeFileSync(path.join(DIR, 'transcripts', 'zzzzzzzzzzz.txt'), '[00:00] stray\n');
  assert.strictEqual(core.computeStatus(DIR).transcripts.ok, before);
  const d5 = path.join(ROOT, '.claude', 'forge-research', 'ledger-only');
  fs.mkdirSync(d5, { recursive: true });
  fs.writeFileSync(path.join(d5, 'sweep-ledger.jsonl'), [
    { stage: 'transcripts', id: 'aaaaaaaaaaa', outcome: 'rate_limited', requests: 4 }, { stage: 'transcripts', id: 'aaaaaaaaaaa', outcome: 'ok', chars: 50, requests: 1 },
    { stage: 'extract', id: 'aaaaaaaaaaa', outcome: 'ok', calls: 2, usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }, 'garbage',
  ].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n');
  const s = core.computeStatus(d5);
  assert.deepStrictEqual([s.transcripts.ok, s.transcripts.rate_limited, s.transcripts.ytdlp_calls, s.extract.ok, s.extract.nvidia_usage.total_tokens, s.ledger_malformed], [1, 0, 5, 1, 10, 1]);
  const out = run(['status', '--json', '--dir', d5]);
  assert.strictEqual(out.code, 0); assert.strictEqual(JSON.parse(out.out).extract.model_calls, 2);
});
t('every file the sweep wrote stays under its sweep dir (containment)', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(DIR);
  assert.ok(files.length > 10);
  assert.ok(files.every((f) => core.isInside(DIR, f)));
  assert.ok(!fs.existsSync(path.join(ROOT, 'evil')) && !fs.existsSync(path.join(DIR, '..', 'evil')));
  const cp = JSON.parse(fs.readFileSync(path.join(DIR, 'checkpoints.json'), 'utf8'));
  assert.strictEqual(cp.stage, 'aggregate'); assert.ok(cp.stages.transcripts && cp.stages.extract && cp.stages.enumerate);
});
t('redact masks nvapi keys, bearer tokens and account ids', () => {
  const s = core.redact("nvapi-abcDEF_123-xyz Bearer abcdefghijklmnop account 'acct-1'");
  assert.ok(!/abcDEF|abcdefghijklmnop|acct-1/.test(s), s);
});
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
