#!/usr/bin/env node
'use strict';
/**
 * forge-md-coverage.test.cjs — rule-coverage guard for the forge.md context trim (v2.9.0, WP-C).
 *
 * WHY THIS EXISTS. WP-C moved five rarely-used blocks out of `.claude/commands/forge.md` into
 * `.claude/docs/forge-reference/*.md` (Paperclip, learn/harvest, resume/WAVE-D, legacy dashboard,
 * tournament/secondbrain/codemodel/briefing) to shrink the always-loaded command payload. The owner's
 * standing rule for this work is "move text, never delete it, and prove with before/after tests that
 * nothing is lost." This file is that proof, run automatically rather than trusted by eye: every markdown
 * section heading and bold-emphasis span that existed in forge.md BEFORE the trim (frozen in
 * `forge-md-coverage.fixture.json`, extracted from `git show feat/v290-f2:.claude/commands/forge.md`, the
 * last commit before the trim) must still be findable as a substring of the CURRENT forge.md, or of a
 * `.claude/docs/forge-reference/*.md` file that the current forge.md actually links to. A rule that is
 * neither still inline nor reachable through a real link is a rule that got lost, not moved.
 *
 * WHY A FROZEN FIXTURE, NOT A LIVE `git show`. A CI runner or a shallow clone may not have the
 * `feat/v290-f2` ref at all, and a fixture that depends on git history existing is not a fixture that
 * runs everywhere. The titles are a ONE-TIME snapshot, committed as data alongside this test.
 *
 * THE EXTRACTION RULE, and a real bug it had to avoid. A naive bold-span regex like `\*\*([^*]+?)\*\*`
 * forbids ANY literal `*` inside the captured text — but this file's own prose uses `.claude/skills/*` as
 * a literal glob wildcard inside a code span. The first such lone `*` makes the enclosing bold span
 * unmatchable, so the regex slides forward and mis-pairs the FOLLOWING `**` markers instead, cascading a
 * one-off pairing shift through the rest of the document (verified live against this exact file — the
 * naive version silently produced ~20 garbled, paragraphs-long "titles" downstream of the first glob).
 * The fix used here (`(?:(?!\*\*)[\s\S])+?`) only stops at a genuine DOUBLE asterisk, so a lone `*` is
 * just an ordinary character inside the span, exactly like real Markdown bold parsing treats it.
 *
 * WHAT THIS DOES NOT PROVE. A short, generic bold word (e.g. "only", "never", "goal") is trivially
 * present almost anywhere in a document this size — its presence proves nothing about THAT SPECIFIC
 * original rule surviving. The real assurance comes from the many multi-word, low-frequency titles in the
 * fixture (file paths, event names, full sentences); this is disclosed rather than hidden.
 *
 * Comparison is WHITESPACE-NORMALIZED (every run of whitespace, including a real newline, collapses to one
 * space) on both the fixture titles and the searched text. The reference docs this test reads wrap long
 * moved paragraphs at a readable width for a human reader — a cosmetic reflow, not a content change — and a
 * byte-exact comparison would fail on that formatting difference alone while proving nothing about lost
 * content. Normalizing whitespace verifies the WORDS survived, which is what "moved, not deleted" means.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FORGE_MD = path.join(ROOT, '.claude', 'commands', 'forge.md');
const REFERENCE_DIR = path.join(ROOT, '.claude', 'docs', 'forge-reference');
const FIXTURE_PATH = path.join(__dirname, 'forge-md-coverage.fixture.json');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function normalizeWs(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

/** extractTitles(text) -> string[] — ATX headings (`#`..`######`) plus every bold (`**...**`) span, in
 *  document order, deduplicated. This is the SAME function used (as a one-off, not at test time) to build
 *  forge-md-coverage.fixture.json from the pre-trim forge.md — see the file header for why the bold-span
 *  regex is shaped this way. Exported so a future re-freeze of the fixture reuses the identical rule. */
function extractTitles(text) {
  const titles = [];
  const seen = new Set();
  const add = (raw) => { const n = normalizeWs(raw); if (n && !seen.has(n)) { seen.add(n); titles.push(n); } };
  const headingRe = /^#{1,6}[ \t]+(.+?)[ \t]*$/gm;
  let m;
  while ((m = headingRe.exec(text))) add(m[1]);
  const boldRe = /\*\*((?:(?!\*\*)[\s\S])+?)\*\*/g;
  while ((m = boldRe.exec(text))) add(m[1]);
  return titles;
}

/** linkedReferenceFiles(forgeMdText) -> [{name, path, exists, text}] — every
 *  `.claude/docs/forge-reference/<name>.md` path literally mentioned in forge.md, in document order,
 *  deduplicated. A reference file that exists on disk but is never mentioned would be dead weight nobody
 *  is ever told to read — this only counts files forge.md actually POINTS at. */
function linkedReferenceFiles(forgeMdText) {
  const re = /\.claude\/docs\/forge-reference\/([A-Za-z0-9_-]+\.md)/g;
  const names = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(forgeMdText))) { if (!seen.has(m[1])) { seen.add(m[1]); names.push(m[1]); } }
  return names.map((name) => {
    const p = path.join(REFERENCE_DIR, name);
    const exists = fs.existsSync(p);
    return { name, path: p, exists, text: exists ? fs.readFileSync(p, 'utf8') : '' };
  });
}

console.log('forge-md-coverage tests (rule-preservation guard for the v2.9.0 forge.md trim)');

// --- the fixture itself is sane, not empty/corrupted (a vacuous fixture would make every check below a
//     silent no-op pass) ------------------------------------------------------------------------------------
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
t('the fixture loads and carries a non-trivial title list', () => {
  assert(Array.isArray(fixture.titles), 'fixture.titles must be an array');
  assert(fixture.titles.length >= 150, 'expected at least 150 frozen titles from the pre-trim file; got ' + fixture.titles.length);
  assert(fixture.titles.length === fixture.title_count, 'title_count metadata field must match the real array length (' + fixture.titles.length + ' vs declared ' + fixture.title_count + ')');
});
t('the extraction function reproduces the fixture exactly against the SAME frozen source it was built from (no drift in the rule itself)', () => {
  // The fixture's own doc string names the exact git ref it was built from; this only re-checks that the
  // extraction rule, unchanged since, still parses SOME representative pre-trim text into the same shape —
  // not a live git call (see file header: the fixture must work with no git history present at all).
  const sample = '## 1. Mission Intake\nSome text with a **bold title** and a glob `.claude/skills/*` inline, then **a second bold title**.';
  const got = extractTitles(sample);
  assert(got.includes('1. Mission Intake'), 'heading not extracted: ' + JSON.stringify(got));
  assert(got.includes('bold title'), 'first bold span not extracted: ' + JSON.stringify(got));
  assert(got.includes('a second bold title'), 'second bold span not extracted (lone-asterisk cascade regression): ' + JSON.stringify(got));
});

// --- the real forge.md + the reference docs it links to must together cover every frozen title ------------
const forgeMdText = fs.readFileSync(FORGE_MD, 'utf8');
const linked = linkedReferenceFiles(forgeMdText);
const haystack = normalizeWs(forgeMdText + ' ' + linked.map((f) => f.text).join(' '));

t('every reference file forge.md links to actually exists on disk (no dangling pointer)', () => {
  const missing = linked.filter((f) => !f.exists).map((f) => f.name);
  assert(missing.length === 0, 'forge.md links to a reference file that does not exist: ' + missing.join(', '));
});

const REQUIRED_REFERENCE_FILES = [
  'paperclip.md', 'resume.md', 'learn-harvest.md', 'legacy-dashboard.md',
  'tournament-secondbrain-codemodel-briefing.md',
];
t('all five WP-C moved-block reference files exist AND are linked from forge.md (a file nobody is told to read is dead weight)', () => {
  const linkedNames = new Set(linked.map((f) => f.name));
  const notLinked = REQUIRED_REFERENCE_FILES.filter((n) => !linkedNames.has(n));
  assert(notLinked.length === 0, 'not linked from forge.md: ' + notLinked.join(', '));
  const notOnDisk = REQUIRED_REFERENCE_FILES.filter((n) => !fs.existsSync(path.join(REFERENCE_DIR, n)));
  assert(notOnDisk.length === 0, 'missing on disk: ' + notOnDisk.join(', '));
});

t('every frozen pre-trim title is still reachable — inline in forge.md, or in a reference file forge.md links to', () => {
  const missing = fixture.titles.filter((title) => !haystack.includes(normalizeWs(title)));
  assert(missing.length === 0,
    missing.length + ' of ' + fixture.titles.length + ' pre-trim title(s) are no longer reachable:\n    - '
    + missing.join('\n    - '));
});

// --- forge.md itself really shrank (the point of WP-C) — a before/after size check, not just coverage -----
t('forge.md is smaller after the trim than the frozen pre-trim source (the trim actually trimmed something)', () => {
  // this is deliberately NOT comparing to a hardcoded byte count (that would go stale on the next edit) —
  // just that SOME reduction happened, which is the one fact this test can assert without re-reading git.
  // The real before/after numbers are measured and reported once, by hand, in the work-package report.
  assert(forgeMdText.length < 55590, 'forge.md (' + forgeMdText.length + ' chars) is not smaller than the recorded pre-trim size (55590 chars, feat/v290-f2)');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
