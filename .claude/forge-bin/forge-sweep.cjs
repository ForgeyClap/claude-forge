#!/usr/bin/env node
'use strict';
/**
 * forge-sweep.cjs — resumable, checkpointed YouTube research sweep (wp14, run forge-2026-09-24-config-v250).
 * Zero-dependency (fs/path/child_process + sibling forge-sweep-core/-extract/-aggregate modules).
 *
 * WHY: the owner asked (2026-09-24) for research at the scale of hundreds-to-thousands of sources on what
 * BEGINNERS of Claude Code / AI coding must know or do, which mistakes they make and which skills/setups
 * help them — so Forge can do those things for them. This tool turns that into a repeatable pipeline whose
 * every number comes from a ledger row written by a real action.
 *
 * MODEL (stages, each resumable; re-running a stage skips what the ledger already shows done):
 *   enumerate  → yt-dlp flat search per query            → candidates.jsonl + enumerate-summary.json
 *   filter     → local relevance score + duration range  → shortlist.jsonl + filter-summary.json
 *   transcripts→ yt-dlp auto-captions (json3), 1 at a time→ transcripts/<id>.txt   (captions only, never media)
 *   extract    → NVIDIA model, strict JSON beginner schema→ extracted/<id>.json
 *   aggregate  → normalise + group near-duplicates        → aggregate.json, beginner-knowledge.json, BEGINNER-SWEEP-<date>.md
 *   status     → counters from sweep-ledger.jsonl only
 *
 * CLI:
 *   node .claude/forge-bin/forge-sweep.cjs enumerate --queries <file.txt> [--per-query 50] [--dir D]
 *   node .claude/forge-bin/forge-sweep.cjs filter [--min-duration 180] [--max-duration 5400] [--top 500] [--seed-ids <file>] [--dir D]
 *            (--seed-ids: one id per line, forced FIRST into the shortlist regardless of score/duration, marked seed:true;
 *             an id no query found gets one --skip-download metadata request, ledger stage "seed")
 *   node .claude/forge-bin/forge-sweep.cjs transcripts [--max 500] [--pace-ms 4500] [--max-consecutive-parked 5] [--sub-lang orig|<code>] [--keep-raw] [--dir D]
 *            [--redo id,id]
 *            (--sub-lang orig [default] = EXACT track codes only: `en-orig` first (the same call prints the video's
 *             language), then `<language>-orig` — never a machine translation, never a regex that could match every
 *             dubbed track; --sub-lang en = legacy: en, or nl then en for Dutch titles; --redo re-fetches listed ids
 *             even if the ledger shows them done — a new ledger row with redo:true supersedes the old one)
 *   node .claude/forge-bin/forge-sweep.cjs extract [--engine nvidia|mock] [--role default] [--model ID] [--fallback-role reasoning]
 *            [--fallback-model ID] [--concurrency 2] [--max-chars 60000] [--max-tokens 8000] [--limit N] [--dir D]
 *            [--ids-file F] (restrict + order) [--max-chunks N] (first N chunks only → record partial:true) [--timeout-ms MS]
 *   node .claude/forge-bin/forge-sweep.cjs aggregate [--include-mock] [--dir D]
 *   node .claude/forge-bin/forge-sweep.cjs status [--json] [--dir D]
 *   Default D = .claude/forge-research/beginner-sweep-<YYYY-MM-DD>/ ; --dir must stay under the project.
 *
 * EXIT CODES: 0 ok · 2 usage · 3 stage incomplete (rate-limited/parked/errored items remain — rerun later)
 *             · 1 hard failure (yt-dlp missing, NVIDIA model gone / no key, lock held by a live process).
 *
 * HONESTY / SAFETY RULES:
 *  - Captions + metadata only: --skip-download is always passed; no video or audio is ever fetched.
 *  - YouTube requests run strictly one at a time, paced (2-4 s between searches, --pace-ms ±1.5 s between
 *    videos, --sleep-subtitles 4) with 30 s / 60 s / 120 s backoff on HTTP 429, after which the id is
 *    PARKED as rate_limited (never silently dropped) and the stage exits 3.
 *  - A query with 0 rows or a spawn error is recorded in the ledger and the summary, never hidden.
 *  - Every error string is redacted (nvapi- keys, bearer tokens, account ids) before storage or printing.
 *  - Every path written goes through safeJoin() under the sweep dir; video ids must match [A-Za-z0-9_-]{11}.
 *  - Test seams: FORGE_SWEEP_YTDLP (a stub executable or .cjs/.js script run with node), FORGE_SWEEP_ROOT
 *    (containment root), FORGE_SWEEP_SLEEP_SCALE (0 = no real waits; planned waits are still recorded),
 *    FORGE_SWEEP_EXTRACT_STUB (module exporting chat()) — a stub engine is stamped in every ledger row.
 *  - Output is INTERNAL_USE_ONLY research (see .claude/forge-research/README.md).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const core = require('./forge-sweep-core.cjs');
const { UsageError, HardError, safeJoin, appendLedger, readLedger, latestBy, writeCheckpoint, sleepSync, jitter, redact } = core;

const YTDLP_INSTALL_HINT = 'yt-dlp is not installed or not on PATH — install it with `pip install yt-dlp` (or `winget install yt-dlp`), then rerun this stage';
const PY_UTF8_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

// ---------------------------------------------------------------- yt-dlp runner
function ytdlpCommand() {
  const stub = process.env.FORGE_SWEEP_YTDLP;
  if (stub) return /\.(c?js|mjs)$/i.test(stub) ? { cmd: process.execPath, pre: [stub] } : { cmd: stub, pre: [] };
  return { cmd: 'yt-dlp', pre: [] };
}
function runYtdlp(args, timeoutMs) {
  const { cmd, pre } = ytdlpCommand();
  const r = spawnSync(cmd, [...pre, ...args], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...PY_UTF8_ENV },
  });
  if (r.error && r.error.code === 'ENOENT') throw new HardError(YTDLP_INSTALL_HINT);
  const timedOut = (r.status === null && !!r.signal) || !!(r.error && r.error.code === 'ETIMEDOUT');
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', timedOut, spawnError: r.error ? redact(r.error.message) : null };
}
// yt-dlp only ever receives a URL REBUILT from a validated 11-char id, after '--' (security finding L6: a tampered
// shortlist/candidates 'url' field must never reach the command line).
function watchUrl(id) { if (!core.isVideoId(id)) throw new HardError('refusing a non-YouTube-id: ' + String(id).slice(0, 40)); return 'https://www.youtube.com/watch?v=' + id; }
const RATE_LIMIT_RE = /HTTP Error 429|Too Many Requests|Sign in to confirm you.{0,3}re not a bot|not a bot/i;
function appendLog(dir, name, header, text) {
  if (!text || !text.trim()) return;
  fs.mkdirSync(safeJoin(dir, 'logs'), { recursive: true });
  fs.appendFileSync(safeJoin(dir, 'logs', name), '--- ' + new Date().toISOString() + ' ' + header + '\n' + redact(text).slice(0, 8000) + '\n');
}

// ---------------------------------------------------------------- enumerate
function readQueries(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new UsageError('cannot read --queries file: ' + file); }
  const seen = new Set(); const out = [];
  for (const l of text.split(/\r?\n/)) {
    const q = l.trim();
    if (!q || q.startsWith('#') || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase()); out.push(q);
  }
  if (!out.length) throw new UsageError('--queries file has no queries: ' + file);
  return out;
}
function candidatesFile(dir) { return safeJoin(dir, 'candidates.jsonl'); }
function loadCandidates(dir) {
  const m = new Map();
  for (const r of core.readJsonl(candidatesFile(dir)).rows) if (core.isVideoId(r.id)) m.set(r.id, r);
  return m;
}
function parseFlatRows(stdout) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try { const j = JSON.parse(line); if (core.isVideoId(j.id)) rows.push(j); } catch {}
  }
  return rows;
}
function enumerate(dir, opts) {
  if (!opts.queries) throw new UsageError('enumerate requires --queries <file.txt>');
  const perQuery = intOpt(opts, 'per-query', 50, 1, 500);
  const queries = readQueries(path.resolve(opts.queries));
  const known = core.loadKnownIds();
  const cands = loadCandidates(dir);
  const { rows } = readLedger(dir);
  const done = new Set([...latestBy(rows, 'enumerate', 'query').values()].filter((r) => r.outcome === 'ok' || r.outcome === 'empty').map((r) => r.query));
  let ran = 0, skipped = 0;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    if (done.has(q)) { skipped++; continue; }
    if (ran > 0) sleepSync(jitter(2000, 4000));
    ran++;
    const r = runYtdlp(['--flat-playlist', '--dump-json', '--no-warnings', '--encoding', 'utf-8', '--', 'ytsearch' + perQuery + ':' + q], 90000);
    appendLog(dir, 'enumerate.stderr.log', 'query=' + JSON.stringify(q) + ' status=' + r.status, r.stderr);
    const got = parseFlatRows(r.stdout);
    let outcome = 'ok', error = null;
    if (r.timedOut) { outcome = 'error'; error = 'timeout after 90s'; }
    else if (!got.length && (r.status !== 0 || r.spawnError)) { outcome = RATE_LIMIT_RE.test(r.stderr) ? 'rate_limited' : 'error'; error = r.spawnError || r.stderr.trim().slice(-300) || ('exit ' + r.status); }
    else if (!got.length) outcome = 'empty';
    let nNew = 0, dupes = 0, newSeen = 0;
    const now = new Date().toISOString();
    for (const v of got) {
      const prev = cands.get(v.id);
      if (prev) { dupes++; if (!prev.queries.includes(q)) prev.queries.push(q); continue; }
      nNew++;
      const seen = known.ids.has(v.id); if (seen) newSeen++;
      cands.set(v.id, {
        id: v.id, url: 'https://www.youtube.com/watch?v=' + v.id, title: v.title || '', channel: v.channel || v.uploader || '',
        duration: Number.isFinite(v.duration) ? v.duration : null, view_count: Number.isFinite(v.view_count) ? v.view_count : null,
        timestamp: v.timestamp || v.release_timestamp || null, description: typeof v.description === 'string' ? v.description : '',
        queries: [q], previously_seen: seen, captured_at: now,
      });
    }
    core.writeJsonl(candidatesFile(dir), [...cands.values()]);
    appendLedger(dir, { stage: 'enumerate', query: q, outcome, rows: got.length, new: nNew, dupes, new_previously_seen: newSeen, bytes: Buffer.byteLength(r.stdout), ...(error ? { error } : {}) });
    if (outcome === 'ok' || outcome === 'empty') done.add(q);
    writeCheckpoint(dir, 'enumerate', done, queries.find((x) => !done.has(x)) ? 'enumerate (' + queries.filter((x) => !done.has(x)).length + ' queries left)' : 'filter');
    console.log('[enumerate ' + (i + 1) + '/' + queries.length + '] ' + outcome + ' rows=' + got.length + ' new=' + nNew + ' dupes=' + dupes + ' unique_total=' + cands.size + '  "' + q + '"');
  }
  const latest = latestBy(readLedger(dir).rows, 'enumerate', 'query');
  const perQ = queries.map((q) => { const r = latest.get(q) || {}; return { query: q, outcome: r.outcome || 'not_run', rows: r.rows || 0, new: r.new || 0, dupes: r.dupes || 0, error: r.error || undefined }; });
  const summary = {
    generated_at: new Date().toISOString(), per_query_requested: perQuery, queries: queries.length, ran_this_invocation: ran, skipped_already_done: skipped,
    by_outcome: perQ.reduce((a, r) => { a[r.outcome] = (a[r.outcome] || 0) + 1; return a; }, {}),
    rows_returned_total: perQ.reduce((a, r) => a + r.rows, 0), unique_candidates: cands.size,
    previously_seen: [...cands.values()].filter((c) => c.previously_seen).length, known_id_sources: known.sources, known_ids_total: known.ids.size, per_query: perQ,
  };
  core.writeFileAtomic(safeJoin(dir, 'enumerate-summary.json'), JSON.stringify(summary, null, 1) + '\n');
  console.log('enumerate: ' + summary.queries + ' queries · ' + summary.rows_returned_total + ' rows · ' + summary.unique_candidates + ' unique · previously_seen=' + summary.previously_seen + ' · ' + JSON.stringify(summary.by_outcome));
  return perQ.some((r) => r.outcome !== 'ok' && r.outcome !== 'empty') ? 3 : 0;
}

// ---------------------------------------------------------------- filter
const SCORE_RULES = {
  claude: /claude/i,
  beginner: /(beginner|beginners|getting started|tutorial|tips|mistakes|setup|guide|how to|for beginners|voor beginners|uitleg|leren)/i,
  feature: /(skill|skills|agent|agents|subagent|hook|hooks|mcp|claude\.md|slash command|command)/i,
  year: /(2026|2025)/,
  // Obvious homonyms of "Claude" that are not about Claude/Anthropic/AI coding (−5).
  homonym: /(minecraft|monet|painting|shannon|debussy|clair de lune|van damme|jean[- ]?claude|lorrain|makelele|makélélé|giroux|chabrol|l[eé]vi[- ]strauss|claude fran[cç]ois|claude rains|claude bernard|piano)/i,
};
function scoreTitle(title, viewCount) {
  const t = String(title || '');
  let score = 0; const hits = [];
  if (SCORE_RULES.claude.test(t)) { score += 3; hits.push('claude'); }
  if (SCORE_RULES.beginner.test(t)) { score += 2; hits.push('beginner'); }
  if (SCORE_RULES.feature.test(t)) { score += 2; hits.push('feature'); }
  if (SCORE_RULES.year.test(t)) { score += 1; hits.push('year'); }
  if (SCORE_RULES.homonym.test(t)) { score -= 5; hits.push('homonym'); }
  return { score, tie: Math.log10((Number(viewCount) || 0) + 1), hits };
}
// Seed ids (Lead addendum 2026-09-24): forced into the shortlist regardless of query hits / score / duration.
// A seed a query already found is only marked (no request); an unknown seed gets ONE metadata request
// (--skip-download, 429 backoff); a failed fetch still adds the id with meta_missing:true — never hidden.
function readSeedIds(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new UsageError('cannot read --seed-ids file: ' + file); }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const bad = lines.filter((l) => !core.isVideoId(l));
  if (bad.length) throw new UsageError('--seed-ids has invalid YouTube ids: ' + bad.slice(0, 5).join(', '));
  return [...new Set(lines)];
}
function fetchSeedMeta(dir, id) {
  const schedule = backoffSchedule(); const waited = []; let requests = 0;
  const args = ['--dump-json', '--skip-download', '--no-playlist', '--no-warnings', '--encoding', 'utf-8', '--', watchUrl(id)];
  for (let attempt = 0; ; attempt++) {
    requests++;
    const r = runYtdlp(args, 120000);
    appendLog(dir, 'seed.stderr.log', 'id=' + id + ' attempt=' + (attempt + 1) + ' status=' + r.status, r.stderr);
    const row = parseFlatRows(r.stdout).find((x) => x.id === id);
    if (row) return { outcome: 'ok', row, requests, waited };
    if (RATE_LIMIT_RE.test(r.stderr) && attempt < schedule.length) { waited.push(schedule[attempt]); sleepSync(schedule[attempt]); continue; }
    return { outcome: RATE_LIMIT_RE.test(r.stderr) ? 'rate_limited' : 'error', requests, waited, error: (r.spawnError || r.stderr.trim() || 'exit ' + r.status).slice(-300) };
  }
}
function addSeeds(dir, candMap, seedIds) {
  const known = core.loadKnownIds();
  const latest = latestBy(readLedger(dir).rows, 'seed', 'id');
  let fetched = 0;
  for (const id of seedIds) {
    const prev = candMap.get(id);
    if (prev && !prev.meta_missing) {
      prev.seed = true;
      if (!latest.has(id)) appendLedger(dir, { stage: 'seed', id, outcome: prev.queries && prev.queries.length ? 'found_by_query' : 'already_candidate', requests: 0 });
      continue;
    }
    if (fetched++ > 0) sleepSync(jitter(2000, 4000));
    const res = fetchSeedMeta(dir, id);
    const v = res.row || {};
    candMap.set(id, {
      id, url: 'https://www.youtube.com/watch?v=' + id, title: v.title || '', channel: v.channel || v.uploader || '',
      duration: Number.isFinite(v.duration) ? v.duration : null, view_count: Number.isFinite(v.view_count) ? v.view_count : null,
      timestamp: v.timestamp || v.release_timestamp || null, description: typeof v.description === 'string' ? v.description : '',
      queries: [], previously_seen: known.ids.has(id), captured_at: new Date().toISOString(), seed: true, ...(res.row ? {} : { meta_missing: true }),
    });
    appendLedger(dir, { stage: 'seed', id, outcome: res.outcome, requests: res.requests, backoff_ms: res.waited, ...(res.error ? { error: res.error } : {}) });
    console.log('[seed] ' + id + ' ' + res.outcome + (v.title ? ' "' + v.title + '"' : ''));
  }
  core.writeJsonl(candidatesFile(dir), [...candMap.values()]);
}
function filter(dir, opts) {
  const minD = intOpt(opts, 'min-duration', 180, 0, 1e6), maxD = intOpt(opts, 'max-duration', 5400, 1, 1e6), top = intOpt(opts, 'top', 500, 1, 100000);
  const candMap = loadCandidates(dir);
  if (!candMap.size) throw new HardError('no candidates.jsonl rows in ' + dir + ' — run enumerate first');
  if (opts['seed-ids']) addSeeds(dir, candMap, readSeedIds(path.resolve(opts['seed-ids'])));
  const cands = [...candMap.values()];
  const dropped = { duration_unknown: 0, duration_short: 0, duration_long: 0, homonym: 0, zero_score: 0, below_top_n: 0 };
  const kept = []; const seeds = [];
  for (const c of cands) {
    const s = scoreTitle(c.title, c.view_count);
    if (c.seed) { seeds.push({ ...c, score: s.score, tie: Number(s.tie.toFixed(4)), score_hits: s.hits }); continue; }
    if (!Number.isFinite(c.duration) || c.duration <= 0) { dropped.duration_unknown++; continue; }
    if (c.duration < minD) { dropped.duration_short++; continue; }
    if (c.duration > maxD) { dropped.duration_long++; continue; }
    if (s.hits.includes('homonym')) { dropped.homonym++; continue; }
    if (s.score <= 0) { dropped.zero_score++; continue; }
    kept.push({ ...c, score: s.score, tie: Number(s.tie.toFixed(4)), score_hits: s.hits });
  }
  const byScore = (a, b) => b.score - a.score || b.tie - a.tie || a.id.localeCompare(b.id);
  kept.sort(byScore); seeds.sort(byScore);
  const topN = kept.slice(0, top);
  const shortlist = [...seeds, ...topN].map((c, i) => ({ rank: i + 1, ...c }));
  dropped.below_top_n = kept.length - topN.length;
  core.writeJsonl(safeJoin(dir, 'shortlist.jsonl'), shortlist);
  const summary = {
    generated_at: new Date().toISOString(), candidates: cands.length, passed_filters: kept.length, shortlisted: shortlist.length,
    seeds_forced: seeds.length, seeds_meta_missing: seeds.filter((c) => c.meta_missing).length,
    dropped, params: { min_duration: minD, max_duration: maxD, top, seed_ids: opts['seed-ids'] ? path.basename(opts['seed-ids']) : null },
    scoring: { claude: '+3', beginner: '+2', feature: '+2', year: '+1', homonym: '-5 (dropped)', tie_breaker: 'log10(view_count+1)' },
    regex: Object.fromEntries(Object.entries(SCORE_RULES).map(([k, v]) => [k, v.source])),
    shortlisted_previously_seen: shortlist.filter((c) => c.previously_seen).length,
  };
  core.writeFileAtomic(safeJoin(dir, 'filter-summary.json'), JSON.stringify(summary, null, 1) + '\n');
  appendLedger(dir, { stage: 'filter', outcome: 'ok', candidates: cands.length, passed_filters: kept.length, shortlisted: shortlist.length, seeds_forced: seeds.length, dropped });
  writeCheckpoint(dir, 'filter', new Set(shortlist.map((c) => c.id)), 'transcripts');
  console.log('filter: ' + cands.length + ' candidates → ' + kept.length + ' passed → ' + shortlist.length + ' shortlisted (' + seeds.length + ' forced seeds first) · dropped ' + JSON.stringify(dropped));
  return 0;
}

// ---------------------------------------------------------------- transcripts
const DUTCH_STRONG_RE = /\b(nederlands|nederlandse|uitleg|voor beginners|in het)\b/i;
const DUTCH_WORDS = new Set(['het', 'een', 'je', 'jouw', 'voor', 'hoe', 'wat', 'niet', 'ook', 'zijn', 'deze', 'dit', 'maken', 'leren', 'gebruiken', 'fouten', 'waarom', 'welke', 'zonder', 'beginnen', 'jij', 'wij', 'onze']);
function isDutchTitle(title) {
  const t = String(title || '');
  if (DUTCH_STRONG_RE.test(t)) return true;
  return t.toLowerCase().split(/[^a-zà-ÿ]+/).filter((w) => DUTCH_WORDS.has(w)).length >= 2;
}
function fmtTs(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
// json3 → "[mm:ss] text" lines (minutes are not wrapped at 60). Segs are merged per event; empty/newline-only events are skipped.
function json3ToText(obj) {
  const lines = [];
  for (const ev of (obj && Array.isArray(obj.events) ? obj.events : [])) {
    if (!ev || !Array.isArray(ev.segs)) continue;
    const text = ev.segs.map((s) => (s && typeof s.utf8 === 'string' ? s.utf8 : '')).join('').replace(/\s+/g, ' ').trim();
    if (text) lines.push('[' + fmtTs(ev.tStartMs) + '] ' + text);
  }
  return lines.join('\n');
}
// Caption-language rule (real evidence, 2026-09-24 run):
//  - `en` on a non-English video is a MACHINE TRANSLATION → heavily throttled (ZcyCe38bTBE: 4× HTTP 429);
//  - a regex such as `.*-orig` matches EVERY dubbed-audio track of an auto-dubbed video (TyB7kLZPVKo: 21 files, and
//    the Arabic dub was picked). So only EXACT track codes are ever requested, one per request:
//  orig mode → 1) exactly `en-orig`, printing the video's `language` in the same call; 2) when absent: exactly
//  `<language>-orig` (then `<lang-REGION>-orig`); an English-labelled video without en-orig → exactly `en`; unknown
//  language + Dutch title → exactly `nl-orig`. Typically 1 request per video, worst case 3.
const LANG_MARK = 'SWEEPLANG=';
const LANG_CODE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
function findSubFile(subsDir, id, requested) {
  const p = path.join(subsDir, id + '.' + requested + '.json3');
  return fs.existsSync(p) ? { file: p, lang: requested } : null;
}
function removeRaw(subsDir, id) { // the used file AND any leftover track of an interrupted multi-track download
  let n = 0;
  try { for (const f of fs.readdirSync(subsDir)) if (f.startsWith(id + '.') && f.endsWith('.json3')) { fs.unlinkSync(path.join(subsDir, f)); n++; } } catch {}
  return n;
}
function followUpLangs(videoLang, title) {
  const L = videoLang && videoLang !== 'NA' && LANG_CODE_RE.test(videoLang) ? videoLang : null; // yt-dlp prints NA when unknown
  if (!L) return isDutchTitle(title) ? ['nl-orig'] : [];
  if (/^en(-|$)/i.test(L)) return ['en'];
  const base = L.split('-')[0];
  return L === base ? [base + '-orig'] : [base + '-orig', L + '-orig'];
}
function backoffSchedule() {
  const env = process.env.FORGE_SWEEP_BACKOFF_MS;
  if (env) { const v = env.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0); if (v.length) return v; }
  return [30000, 60000, 120000];
}
function fetchSubs(dir, c, lang, opts) {
  const subsDir = safeJoin(dir, 'subs'); fs.mkdirSync(subsDir, { recursive: true });
  const schedule = backoffSchedule(); const waited = []; let requests = 0;
  const convert = (file) => {
    const raw = fs.readFileSync(file);
    let obj; try { obj = JSON.parse(raw.toString('utf8')); } catch { try { fs.unlinkSync(file); } catch {} return { outcome: 'error', reason: 'bad_json3', error: 'json3 did not parse', bytes: raw.length }; }
    const text = json3ToText(obj);
    const res = { bytes: raw.length, raw_sha256: core.sha256(raw) };
    if (!opts.keepRaw) res.raw_files_removed = removeRaw(subsDir, c.id);
    if (!text) return { ...res, outcome: 'no_captions', reason: 'empty_json3' };
    fs.mkdirSync(safeJoin(dir, 'transcripts'), { recursive: true });
    fs.writeFileSync(safeJoin(dir, 'transcripts', c.id + '.txt'), text + '\n');
    return { ...res, outcome: 'ok', chars: text.length, lines: text.split('\n').length };
  };
  const existing = findSubFile(subsDir, c.id, lang); // resume: a json3 left by an interrupted run needs no new request
  if (existing) return { ...convert(existing.file), got_lang: existing.lang, requests, waited, reused_raw: true };
  const args = ['--skip-download', '--write-auto-subs', '--sub-lang', lang, '--sub-format', 'json3', '--sleep-subtitles', '4',
    '--no-warnings', '--encoding', 'utf-8', '--no-simulate', '--print', 'video:' + LANG_MARK + '%(language)s',
    '-o', path.join(subsDir, '%(id)s'), '--', watchUrl(c.id)]; // never a stored url (security L6)
  let video_lang = null;
  for (let attempt = 0; ; attempt++) {
    requests++;
    const r = runYtdlp(args, 120000);
    appendLog(dir, 'transcripts.stderr.log', 'id=' + c.id + ' lang=' + lang + ' attempt=' + (attempt + 1) + ' status=' + r.status, r.stderr);
    const lm = new RegExp(LANG_MARK + '(\\S+)').exec(r.stdout);
    if (lm) video_lang = lm[1];
    const found = findSubFile(subsDir, c.id, lang);
    if (found) return { ...convert(found.file), got_lang: found.lang, video_lang, requests, waited };
    if (RATE_LIMIT_RE.test(r.stderr)) {
      if (attempt < schedule.length) { waited.push(schedule[attempt]); sleepSync(schedule[attempt]); continue; }
      return { outcome: 'rate_limited', reason: /not a bot/i.test(r.stderr) ? 'bot_check' : 'http_429', requests, waited, error: r.stderr.trim().slice(-300) };
    }
    if (r.timedOut) return { outcome: 'error', reason: 'timeout', requests, waited, error: 'yt-dlp timed out after 120s' };
    if (/Video unavailable|Private video|members-only|has been removed|not available/i.test(r.stderr)) return { outcome: 'error', reason: 'unavailable', requests, waited, error: r.stderr.trim().slice(-300) };
    if (r.status === 0) return { outcome: 'no_captions', reason: 'no_' + lang + '_auto_captions', video_lang, requests, waited };
    return { outcome: 'error', reason: 'ytdlp_exit_' + r.status, requests, waited, error: (r.spawnError || r.stderr.trim()).slice(-300) };
  }
}
function transcripts(dir, opts) {
  const max = intOpt(opts, 'max', 500, 1, 100000), pace = intOpt(opts, 'pace-ms', 4500, 0, 600000);
  const breakerN = intOpt(opts, 'max-consecutive-parked', 5, 1, 1000);
  const subLang = opts['sub-lang'] || 'orig';
  if (subLang !== 'orig' && !/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(subLang)) throw new UsageError('--sub-lang must be "orig" or a language code like en / nl / pt-BR');
  const shortlist = core.readJsonl(safeJoin(dir, 'shortlist.jsonl')).rows.filter((c) => core.isVideoId(c.id)).slice(0, max);
  if (!shortlist.length) throw new HardError('no shortlist.jsonl rows in ' + dir + ' — run filter first');
  const release = core.acquireLock(dir, 'transcripts');
  const redo = new Set(String(opts.redo || '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const id of redo) if (!core.isVideoId(id)) throw new UsageError('--redo has an invalid YouTube id: ' + id);
  const latest = latestBy(readLedger(dir).rows, 'transcripts', 'id');
  const isDone = (r) => r && (r.outcome === 'ok' || r.outcome === 'no_captions' || (r.outcome === 'error' && r.reason === 'unavailable'));
  const done = new Set(shortlist.filter((c) => !redo.has(c.id) && isDone(latest.get(c.id))).map((c) => c.id));
  const todo = shortlist.filter((c) => !done.has(c.id));
  const tally = { ok: 0, no_captions: 0, rate_limited: 0, error: 0 };
  let consecutiveParked = 0, processed = 0, breaker = false;
  console.log('transcripts: ' + shortlist.length + ' shortlisted · ' + done.size + ' already done · ' + todo.length + ' to fetch (pace ' + pace + 'ms ±1500, mode ' + subLang + (redo.size ? ', redo ' + redo.size : '') + ')');
  for (const c of todo) {
    if (processed > 0) sleepSync(jitter(Math.max(0, pace - 1500), pace + 1500));
    let res = null; const tried = []; let requests = 0; const waited = [];
    const attempt = (lang) => {
      if (tried.length) sleepSync(jitter(Math.max(0, pace - 1500), pace + 1500));
      tried.push(lang);
      const r = fetchSubs(dir, c, lang, opts); requests += r.requests; waited.push(...r.waited);
      if (r.outcome !== 'no_captions') r.lang = r.got_lang || lang;
      return r;
    };
    let videoLang = null;
    if (subLang === 'orig') {
      res = attempt('en-orig'); videoLang = res.video_lang || null;
      if (res.outcome === 'no_captions' && res.reason !== 'empty_json3') {
        for (const l of followUpLangs(videoLang, c.title)) { res = attempt(l); if (res.outcome !== 'no_captions') break; }
      }
    } else { // legacy code mode: <code>, or nl then <code> for Dutch-titled videos
      for (const l of (isDutchTitle(c.title) && subLang !== 'nl' ? ['nl', subLang] : [subLang])) { res = attempt(l); if (res.outcome !== 'no_captions') break; }
    }
    appendLedger(dir, { stage: 'transcripts', id: c.id, outcome: res.outcome, reason: res.reason, lang: res.lang || null, video_lang: videoLang, langs_tried: tried,
      chars: res.chars || 0, lines: res.lines || 0, bytes: res.bytes || 0, raw_sha256: res.raw_sha256, requests, backoff_ms: waited,
      ...(res.reused_raw ? { reused_raw: true } : {}), ...(redo.has(c.id) ? { redo: true } : {}), ...(res.error ? { error: res.error } : {}) });
    tally[res.outcome] = (tally[res.outcome] || 0) + 1;
    if (isDone({ outcome: res.outcome, reason: res.reason })) done.add(c.id);
    consecutiveParked = res.outcome === 'rate_limited' ? consecutiveParked + 1 : 0;
    processed++;
    writeCheckpoint(dir, 'transcripts', done, done.size < shortlist.length ? 'transcripts (' + (shortlist.length - done.size) + ' left/parked)' : 'extract');
    if (processed % 10 === 0) console.log('[transcripts ' + processed + '/' + todo.length + '] ok=' + tally.ok + ' no_captions=' + tally.no_captions + ' rate_limited=' + tally.rate_limited + ' error=' + tally.error + ' · done_total=' + done.size + '/' + shortlist.length);
    if (consecutiveParked >= breakerN) { breaker = true; break; }
  }
  release();
  const st = core.computeStatus(dir).transcripts;
  console.log('transcripts this invocation: processed=' + processed + ' ' + JSON.stringify(tally) + ' · ledger totals ok=' + st.ok + ' no_captions=' + st.no_captions + ' rate_limited=' + st.rate_limited + ' error=' + st.error
    + (breaker ? ' · STOPPED: ' + breakerN + ' consecutive ids parked by rate limiting — rerun `transcripts` later (checkpoint kept)' : ''));
  const remaining = shortlist.filter((c) => !done.has(c.id)).length;
  return breaker || remaining > 0 ? 3 : 0;
}

// ---------------------------------------------------------------- status
function status(dir, opts) {
  const s = core.computeStatus(dir);
  if (opts.json) { console.log(JSON.stringify(s, null, 1)); return 0; }
  const e = s.enumerate, t = s.transcripts, x = s.extract, u = x.nvidia_usage;
  console.log('sweep: ' + dir);
  console.log('ledger rows: ' + s.ledger_rows + (s.ledger_malformed ? ' (malformed: ' + s.ledger_malformed + ')' : '') + (s.ledger_missing ? ' (no ledger yet)' : ''));
  console.log('enumerate:   queries=' + e.queries_attempted + ' ' + JSON.stringify(e.by_outcome) + ' rows=' + e.rows_returned + ' unique=' + e.unique_candidates + ' previously_seen=' + e.previously_seen_candidates);
  console.log('seeds:       ids=' + s.seeds.ids + ' ' + JSON.stringify(s.seeds.by_outcome) + ' yt-dlp_requests=' + s.seeds.ytdlp_calls);
  console.log('filter:      ' + (s.filter ? 'candidates=' + s.filter.candidates + ' passed=' + s.filter.passed_filters + ' shortlisted=' + s.filter.shortlisted + ' (forced seeds ' + (s.filter.seeds_forced || 0) + ')' : 'not run'));
  console.log('transcripts: attempted=' + t.videos_attempted + ' ok=' + t.ok + ' no_captions=' + t.no_captions + ' rate_limited=' + t.rate_limited + ' error=' + t.error + ' yt-dlp_requests=' + t.ytdlp_calls + ' chars=' + t.transcript_chars);
  console.log('extract:     attempted=' + x.videos_attempted + ' ok=' + x.ok + ' failed=' + x.extract_failed + ' error=' + x.extract_error + ' calls=' + x.model_calls + ' tokens=' + u.total_tokens + ' (prompt ' + u.prompt_tokens + ' / completion ' + u.completion_tokens + ')' + (x.models.length ? ' models=' + x.models.join(',') : '') + (x.mock_records ? ' MOCK=' + x.mock_records : ''));
  console.log('aggregate:   ' + (s.aggregate ? 'videos_used=' + s.aggregate.videos_used + ' at ' + s.aggregate.ts : 'not run'));
  return 0;
}

// ---------------------------------------------------------------- CLI
const FLAGS = {
  enumerate: ['queries', 'per-query', 'dir'],
  filter: ['min-duration', 'max-duration', 'top', 'seed-ids', 'dir'],
  transcripts: ['max', 'pace-ms', 'max-consecutive-parked', 'sub-lang', 'redo', 'keep-raw', 'dir'],
  extract: ['engine', 'role', 'model', 'fallback-role', 'fallback-model', 'concurrency', 'max-chars', 'max-tokens', 'max-chunks', 'limit', 'ids-file', 'timeout-ms', 'dir'],
  aggregate: ['include-mock', 'dir'],
  status: ['json', 'dir'],
};
const BOOL_FLAGS = new Set(['keep-raw', 'include-mock', 'json']);
function parseArgs(argv) {
  const cmd = argv[0];
  if (!cmd || !FLAGS[cmd]) throw new UsageError('usage: forge-sweep.cjs <' + Object.keys(FLAGS).join('|') + '> [flags] — see the header of this file');
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError('unexpected argument: ' + a);
    const k = a.slice(2);
    if (!FLAGS[cmd].includes(k)) throw new UsageError('unknown flag for ' + cmd + ': --' + k);
    if (BOOL_FLAGS.has(k)) { opts[k] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError('--' + k + ' needs a value');
    opts[k] = v; i++;
  }
  return { cmd, opts };
}
function intOpt(opts, k, def, min, max) {
  if (opts[k] === undefined) return def;
  const n = Number(opts[k]);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError('--' + k + ' must be an integer in [' + min + ', ' + max + ']');
  return n;
}
async function main(argv) {
  const { cmd, opts } = parseArgs(argv);
  const dir = core.resolveSweepDir(opts.dir);
  if (cmd === 'enumerate') return enumerate(dir, opts);
  if (cmd === 'filter') return filter(dir, opts);
  if (cmd === 'transcripts') return transcripts(dir, { ...opts, keepRaw: !!opts['keep-raw'] });
  if (cmd === 'extract') return require('./forge-sweep-extract.cjs').extract(dir, opts, intOpt);
  if (cmd === 'aggregate') return require('./forge-sweep-aggregate.cjs').aggregate(dir, opts);
  return status(dir, opts);
}

module.exports = { main, parseArgs, scoreTitle, SCORE_RULES, json3ToText, fmtTs, isDutchTitle, parseFlatRows, readQueries, loadKnownIds: core.loadKnownIds, backoffSchedule };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code || 0; }, (e) => {
    console.error('forge-sweep: ' + redact(e && e.message ? e.message : String(e)));
    process.exitCode = e && e.exitCode ? e.exitCode : 1;
  });
}
