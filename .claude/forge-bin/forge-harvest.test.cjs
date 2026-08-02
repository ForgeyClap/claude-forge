#!/usr/bin/env node
'use strict';
// forge-harvest.test.cjs — real tests for the READ-ONLY cross-project learning harvester (2026-07-18).
// Every fixture lives under a fresh os.tmpdir() "portfolio" of fake project dirs — this file NEVER reads
// or writes any of THIS repo's real .claude/ content. Fake secrets below are deliberately literal (this is
// a .test.cjs fixture file, which forge-doctor.cjs's own leak scan explicitly exempts — see forge-doctor.cjs
// leakScan(): `.test.[cm]?js$` files are skipped, "test fixtures legitimately hold fake secrets").
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const harvest = require('./forge-harvest.cjs');
const memory = require('./forge-memory.cjs');
const recall = require('./forge-recall.cjs');
const store = require('./forge-store.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function buildFakeProject(root, name, claudeFiles) {
  const projectDir = path.join(root, name);
  const claudeDir = path.join(projectDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  for (const [filename, content] of Object.entries(claudeFiles || {})) {
    fs.writeFileSync(path.join(claudeDir, filename), content, 'utf8');
  }
  return projectDir;
}
function trackFsCalls(methodNames) {
  const calls = {}; const originals = {};
  for (const m of methodNames) {
    calls[m] = [];
    originals[m] = fs[m];
    fs[m] = function (...args) { calls[m].push(args[0]); return originals[m].apply(fs, args); };
  }
  return { calls, restore() { for (const m of methodNames) fs[m] = originals[m]; } };
}

const CLI = path.join(__dirname, 'forge-harvest.cjs');
function runCLI(argv, root) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) }); }

// deliberately fake, well-formed-shaped tokens — never real credentials (see file header note)
const FAKE_AWS_KEY = 'AKIA' + 'ABCD1234EFGH5678';
const FAKE_GH_TOKEN = 'ghp_' + '1234567890abcdefghijKLMN';
// a Google-API-key SHAPE that store.SECRET_PATTERNS covers but the narrower memory.SECRET_RE list does
// NOT — used to prove stillLeaking()'s FULL reused pattern set (not just the narrower one) is what
// actually catches a leak, independent of the redundant/overlapping AKIA-style shapes above.
const FAKE_GOOGLE_KEY = 'AIza' + Array.from({ length: 35 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[i % 36]).join('');

console.log('forge-harvest tests (read-only cross-project learning harvester)');

// ---------------------------------------------------------------------------
// 1) discovery — explicit only, one level, marker-gated
// ---------------------------------------------------------------------------
console.log('\n1) discover() — explicit discovery only (guardrail 4)');

t('discover() with neither opts.projects nor opts.scanDir returns []', () => {
  assert.deepStrictEqual(harvest.discover({}), []);
  assert.deepStrictEqual(harvest.discover(), []);
});

t('--scan finds only immediate-child dirs carrying a .claude/FORGE_* marker', () => {
  const portfolio = freshRoot('harvest-discover');
  buildFakeProject(portfolio, 'project-a', { 'FORGE_MEMORY.md': '# memory\n' });
  buildFakeProject(portfolio, 'project-b', { 'FORGE_DECISIONS.md': '# decisions\n' });
  fs.mkdirSync(path.join(portfolio, 'no-claude-dir'));
  const noMarkerDir = path.join(portfolio, 'claude-but-no-marker', '.claude');
  fs.mkdirSync(noMarkerDir, { recursive: true });
  fs.writeFileSync(path.join(noMarkerDir, 'OTHER_FILE.md'), 'not a forge marker', 'utf8');
  const found = harvest.discover({ scanDir: portfolio });
  const names = found.map((f) => f.project).sort();
  assert.deepStrictEqual(names, ['project-a', 'project-b']);
});

t('--scan is ONE LEVEL only — a marked project nested two levels deep is NOT discovered', () => {
  const portfolio = freshRoot('harvest-onelevel');
  const nestedRoot = path.join(portfolio, 'nested');
  buildFakeProject(nestedRoot, 'deeply-marked', { 'FORGE_MEMORY.md': '# memory\n' });
  const found = harvest.discover({ scanDir: portfolio });
  assert.deepStrictEqual(found, []);
});

t('opts.projects (explicit list) only returns entries that actually carry the marker', () => {
  const portfolio = freshRoot('harvest-explicit');
  const marked = buildFakeProject(portfolio, 'marked', { 'FORGE_MEMORY.md': '# memory\n' });
  const unmarked = path.join(portfolio, 'unmarked-dir');
  fs.mkdirSync(unmarked, { recursive: true });
  const found = harvest.discover({ projects: [marked, unmarked] });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].project, 'marked');
});

// ---------------------------------------------------------------------------
// 2) extraction — a real decision/what-worked line becomes a canonical lesson
// ---------------------------------------------------------------------------
console.log('\n2) extraction — real evidenced lines become canonical lessons');

t('a bullet "what worked" line and a table decision row both become canonical lessons', () => {
  const portfolio = freshRoot('harvest-extract');
  const projectDir = buildFakeProject(portfolio, 'proj-extract', {
    'FORGE_MEMORY.md': [
      '# Forge Memory',
      '## Status update 2026-07-10',
      '- **What worked:** always run the doctor before claiming ALL GREEN, this caught a real regression.',
      '- ok', // too short — must be filtered
    ].join('\n'),
    'FORGE_DECISIONS.md': [
      '# Decisions',
      '| Date/time | Decision | Reason | Impact | Files affected | Rollback note |',
      '|---|---|---|---|---|---|',
      '| 2026-07-05 | Use append-only stores for tickets/artifacts | Auditability over mutation | New store layer | forge-store.cjs | revert commit |',
    ].join('\n'),
  });
  const lessons = harvest.harvestProject({ project: 'proj-extract', path: projectDir }, {});
  assert.ok(lessons.some((l) => l.text.includes('always run the doctor before claiming ALL GREEN')), 'the bullet line must survive as a canonical quote');
  assert.ok(lessons.some((l) => l.text.includes('Use append-only stores for tickets/artifacts')), 'the table decision row must survive as a canonical quote');
  assert.ok(!lessons.some((l) => l.text === '- ok'), 'a too-short bullet must be filtered out');
  const { accepted, rejected } = harvest.filterCanonical(lessons);
  assert.strictEqual(rejected.length, 0, 'every harvested lesson must pass forge-consolidate validateCanonical');
  assert.strictEqual(accepted.length, lessons.length);
});

t('a dated line (YYYY-MM-DD in the text) uses that real date as ts; an undated line falls back to file mtime', () => {
  const portfolio = freshRoot('harvest-dates');
  const projectDir = buildFakeProject(portfolio, 'proj-dates', {
    'FORGE_MEMORY.md': '- On 2026-07-05 the doctor suite went green after the fix landed cleanly.\n- No date in this bullet line at all here.\n',
  });
  const lessons = harvest.harvestProject({ project: 'proj-dates', path: projectDir }, {});
  const dated = lessons.find((l) => l.text.includes('2026-07-05'));
  const undated = lessons.find((l) => l.text.includes('No date in this bullet'));
  assert.ok(dated && dated.ts.startsWith('2026-07-05'));
  assert.ok(undated && !Number.isNaN(Date.parse(undated.ts)), 'undated line must still get a real, valid ts (file mtime fallback)');
});

t('headings, blank lines, horizontal rules, and table separator rows are never candidates', () => {
  assert.strictEqual(harvest.isCandidateLine('## Status update 2026-07-13 (a long heading with real content)'), false);
  assert.strictEqual(harvest.isCandidateLine(''), false);
  assert.strictEqual(harvest.isCandidateLine('---'), false);
  assert.strictEqual(harvest.isCandidateLine('|---|---|---|'), false);
  assert.strictEqual(harvest.isCandidateLine('- **A real bullet line with enough substance to pass the length floor.**'), true);
});

// ---------------------------------------------------------------------------
// 3) secrets — redacted, and dropped if redaction ever fails (guardrail 2)
// ---------------------------------------------------------------------------
console.log('\n3) secret exclusion (guardrail 2)');

t('a seeded fake secret token produces ZERO lessons containing the raw token', () => {
  const portfolio = freshRoot('harvest-secret');
  const projectDir = buildFakeProject(portfolio, 'proj-secret', {
    'FORGE_MEMORY.md': [
      '- Old deploy key found in a stale log, value was ' + FAKE_AWS_KEY + ', rotated immediately after discovery.',
      '- Leaked GitHub token in a commit message: ' + FAKE_GH_TOKEN + ', revoked same day per the runbook.',
    ].join('\n'),
  });
  const lessons = harvest.harvestProject({ project: 'proj-secret', path: projectDir }, {});
  assert.ok(lessons.length >= 1, 'the surrounding text still has substance and must survive as a (redacted) lesson');
  for (const l of lessons) {
    assert.ok(!l.text.includes(FAKE_AWS_KEY), 'AWS-style key must never survive into a lesson');
    assert.ok(!l.text.includes(FAKE_GH_TOKEN), 'GitHub-style token must never survive into a lesson');
  }
});

t('.env / *.key / *.pem / *secret* / *credential* / id_rsa* filenames are recognized as forbidden', () => {
  assert.ok(harvest.isForbiddenFilename('.env'));
  assert.ok(harvest.isForbiddenFilename('.env.local'));
  assert.ok(harvest.isForbiddenFilename('prod.key'));
  assert.ok(harvest.isForbiddenFilename('server.pem'));
  assert.ok(harvest.isForbiddenFilename('MY_SECRET_NOTES.md'));
  assert.ok(harvest.isForbiddenFilename('credentials.json'));
  assert.ok(harvest.isForbiddenFilename('id_rsa'));
  assert.ok(harvest.isForbiddenFilename('id_rsa.pub'));
  assert.ok(!harvest.isForbiddenFilename('FORGE_MEMORY.md'));
});

t('a .env sitting inside a fake project .claude/ dir is NEVER opened by fs.readFileSync', () => {
  const portfolio = freshRoot('harvest-dotenv');
  const projectDir = buildFakeProject(portfolio, 'proj-dotenv', {
    'FORGE_MEMORY.md': '- A perfectly ordinary evidenced memory line with real substance in it.',
    '.env': 'AWS_SECRET_ACCESS_KEY=' + FAKE_AWS_KEY + '\n',
    'credentials.json': '{"token":"' + FAKE_GH_TOKEN + '"}',
  });
  const tracker = trackFsCalls(['readFileSync']);
  let lessons;
  try { lessons = harvest.harvestProject({ project: 'proj-dotenv', path: projectDir }, {}); }
  finally { tracker.restore(); }
  const readPaths = tracker.calls.readFileSync.map((p) => String(p));
  assert.ok(!readPaths.some((p) => path.basename(p) === '.env'), '.env must never be opened');
  assert.ok(!readPaths.some((p) => path.basename(p) === 'credentials.json'), 'credentials.json must never be opened');
  assert.ok(!lessons.some((l) => l.text.includes(FAKE_AWS_KEY) || l.text.includes(FAKE_GH_TOKEN)));
});

t('a file NOT in the 5-file MARKER_FILES allow-list (e.g. FORGE_SKILL_REGISTRY.md) is never opened either', () => {
  const portfolio = freshRoot('harvest-offlist');
  const projectDir = buildFakeProject(portfolio, 'proj-offlist', {
    'FORGE_MEMORY.md': '- A perfectly ordinary evidenced memory line with real substance in it.',
    'FORGE_SKILL_REGISTRY.md': '- Off-list secret would leak here: ' + FAKE_AWS_KEY,
  });
  const tracker = trackFsCalls(['readFileSync']);
  let lessons;
  try { lessons = harvest.harvestProject({ project: 'proj-offlist', path: projectDir }, {}); }
  finally { tracker.restore(); }
  const readPaths = tracker.calls.readFileSync.map((p) => String(p));
  assert.ok(!readPaths.some((p) => path.basename(p) === 'FORGE_SKILL_REGISTRY.md'));
  assert.ok(!lessons.some((l) => l.text.includes(FAKE_AWS_KEY)));
});

t('redactCandidate DROPS a candidate outright when redaction fails to remove a secret-shaped token (defense-in-depth)', () => {
  const originalScrub = memory.scrub;
  memory.scrub = (s) => s; // simulate a redaction bypass — text passes through unchanged
  try {
    const candidate = { text: 'a line that leaks ' + FAKE_AWS_KEY + ' right here', sourceFile: 'FORGE_MEMORY.md', line: 1, ts: new Date().toISOString() };
    assert.strictEqual(harvest.redactCandidate(candidate), null);
    assert.strictEqual(harvest.stillLeaking(candidate.text), true);
  } finally { memory.scrub = originalScrub; }
});

t('stillLeaking checks the FULL reused store.SECRET_PATTERNS set, not just the narrower memory.SECRET_RE list', () => {
  // sanity: this shape is deliberately one store.SECRET_PATTERNS covers that memory.SECRET_RE does NOT —
  // proves the store-pattern loop is load-bearing on its own, independent of the overlapping AKIA-style
  // shapes both lists already share.
  assert.ok(!memory.SECRET_RE.some((re) => { re.lastIndex = 0; return re.test(FAKE_GOOGLE_KEY); }), 'sanity: memory.SECRET_RE must NOT already cover this shape');
  assert.ok(store.SECRET_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(FAKE_GOOGLE_KEY); }), 'sanity: store.SECRET_PATTERNS MUST cover this shape');
  assert.strictEqual(harvest.stillLeaking(FAKE_GOOGLE_KEY), true);
  const originalScrub = memory.scrub;
  memory.scrub = (s) => s;
  try {
    const candidate = { text: 'a google-style key leaked here: ' + FAKE_GOOGLE_KEY, sourceFile: 'FORGE_MEMORY.md', line: 1, ts: new Date().toISOString() };
    assert.strictEqual(harvest.redactCandidate(candidate), null);
  } finally { memory.scrub = originalScrub; }
});

// ---------------------------------------------------------------------------
// 4) canonical / anti-synthesis guard (guardrail 3, reused from forge-consolidate)
// ---------------------------------------------------------------------------
console.log('\n4) anti-synthesis guard (guardrail 3)');

t('filterCanonical rejects a quote-less/synthesised record using forge-consolidate::validateCanonical', () => {
  const noText = { text: '', ts: new Date().toISOString(), evidence: JSON.stringify({ run_id: 'x' }) };
  const noEvidence = { text: 'a real quote', ts: new Date().toISOString(), evidence: JSON.stringify({}) };
  const noTs = { text: 'a real quote', evidence: JSON.stringify({ run_id: 'x' }) };
  const { accepted, rejected } = harvest.filterCanonical([noText, noEvidence, noTs]);
  assert.strictEqual(accepted.length, 0);
  assert.strictEqual(rejected.length, 3);
});

t('every real harvested lesson carries a non-empty evidence.run_id and passes validateCanonical', () => {
  const portfolio = freshRoot('harvest-canonical');
  const projectDir = buildFakeProject(portfolio, 'proj-canon', {
    'FORGE_MEMORY.md': '- A real evidenced line with genuine substance for the canonical guard test.',
  });
  const lessons = harvest.harvestProject({ project: 'proj-canon', path: projectDir }, {});
  assert.ok(lessons.length >= 1);
  for (const l of lessons) {
    const ev = JSON.parse(l.evidence);
    assert.ok(typeof ev.run_id === 'string' && ev.run_id.length > 0);
  }
  assert.strictEqual(harvest.filterCanonical(lessons).rejected.length, 0);
});

// ---------------------------------------------------------------------------
// 5) global-namespace tagging + real forge-recall integration
// ---------------------------------------------------------------------------
console.log('\n5) global namespace tagging (guardrail 5)');

t('a harvested lesson is tagged cross_project:true + source_project + the cross_project tag', () => {
  const portfolio = freshRoot('harvest-tagging');
  const projectDir = buildFakeProject(portfolio, 'proj-tagging', {
    'FORGE_MEMORY.md': '- A real evidenced tagging-test line with enough substance to pass.',
  });
  const lessons = harvest.harvestProject({ project: 'proj-tagging', path: projectDir }, {});
  assert.ok(lessons.length >= 1);
  for (const l of lessons) {
    assert.strictEqual(l.cross_project, true);
    assert.strictEqual(l.source_project, 'proj-tagging');
    assert.ok(l.tags.includes('cross_project'));
  }
});

t('harvested lessons land in the SAME global store forge-recall.cjs reads, and are recalled', () => {
  const root = freshRoot('harvest-recall-integration');
  const portfolio = freshRoot('harvest-recall-portfolio');
  buildFakeProject(portfolio, 'proj-recall', {
    'FORGE_MEMORY.md': '- Cross project lesson: always verify the doctor output before shipping a claim.',
  });
  const globalStore = harvest.defaultGlobalStorePath(root);
  const result = harvest.harvest({ scanDir: portfolio, root, globalStore });
  assert.ok(result.lessons_stored >= 1);
  assert.strictEqual(globalStore, path.join(root, '.claude', 'agent-memory', 'global', 'lessons.jsonl'));
  assert.strictEqual(globalStore, path.join(memory.memDir('global', root), 'lessons.jsonl'));
  const recalled = recall.recall({ query: 'verify doctor output' }, { root, k: 10 });
  assert.ok(recalled.lessons.some((l) => l.namespace === 'global' && l.text.includes('always verify the doctor output')));
});

// ---------------------------------------------------------------------------
// 6) read-only guarantee — no write ever targets a project dir (guardrail 1)
// ---------------------------------------------------------------------------
console.log('\n6) read-only guarantee (guardrail 1)');

t('no write call (writeFileSync/appendFileSync/mkdirSync) ever targets a discovered project directory', () => {
  const root = freshRoot('harvest-readonly-root');
  const portfolio = freshRoot('harvest-readonly-portfolio');
  const p1 = buildFakeProject(portfolio, 'proj-ro-1', { 'FORGE_MEMORY.md': '- Real evidenced readonly-guard line number one here.' });
  const p2 = buildFakeProject(portfolio, 'proj-ro-2', { 'FORGE_DECISIONS.md': '- Real evidenced readonly-guard line number two here.' });
  const globalStore = path.join(root, '.claude', 'agent-memory', 'global', 'lessons.jsonl');

  const tracker = trackFsCalls(['writeFileSync', 'appendFileSync', 'mkdirSync']);
  let result;
  try { result = harvest.harvest({ scanDir: portfolio, root, globalStore }); }
  finally { tracker.restore(); }

  assert.ok(result.lessons_stored >= 1, 'sanity: this run must have actually written something, or the guarantee is untested');
  const allWritePaths = [].concat(tracker.calls.writeFileSync, tracker.calls.appendFileSync, tracker.calls.mkdirSync).map((p) => path.resolve(String(p)));
  for (const wp of allWritePaths) {
    assert.ok(!wp.startsWith(path.resolve(p1) + path.sep) && wp !== path.resolve(p1), 'must never write inside project 1: ' + wp);
    assert.ok(!wp.startsWith(path.resolve(p2) + path.sep) && wp !== path.resolve(p2), 'must never write inside project 2: ' + wp);
  }
  assert.ok(allWritePaths.some((wp) => wp === path.resolve(globalStore) || wp.startsWith(path.resolve(path.dirname(globalStore)))), 'at least one write must target the global store');
});

t('reharvesting the same portfolio is idempotent — second run stores 0 new (dedupe) and performs NO write at all', () => {
  const root = freshRoot('harvest-idempotent-root');
  const portfolio = freshRoot('harvest-idempotent-portfolio');
  buildFakeProject(portfolio, 'proj-idem', { 'FORGE_MEMORY.md': '- Idempotency-test evidenced memory line right here.' });
  const globalStore = path.join(root, '.claude', 'agent-memory', 'global', 'lessons.jsonl');
  const first = harvest.harvest({ scanDir: portfolio, root, globalStore });
  assert.ok(first.lessons_stored >= 1);

  const tracker = trackFsCalls(['writeFileSync', 'appendFileSync']);
  let second;
  try { second = harvest.harvest({ scanDir: portfolio, root, globalStore }); }
  finally { tracker.restore(); }
  assert.strictEqual(second.lessons_stored, 0);
  assert.strictEqual(second.lessons_found, first.lessons_found);
  assert.strictEqual(tracker.calls.writeFileSync.length, 0, 'a no-new-lessons harvest must never rewrite the store');
  assert.strictEqual(tracker.calls.appendFileSync.length, 0);
});

// ---------------------------------------------------------------------------
// 7) --dry-run writes nothing
// ---------------------------------------------------------------------------
console.log('\n7) --dry-run (module + CLI)');

t('module harvest({dryRun:true}) never calls a write function and leaves the store file absent', () => {
  const root = freshRoot('harvest-dryrun-root');
  const portfolio = freshRoot('harvest-dryrun-portfolio');
  buildFakeProject(portfolio, 'proj-dry', { 'FORGE_MEMORY.md': '- Dry-run-test evidenced memory line right here.' });
  const globalStore = path.join(root, '.claude', 'agent-memory', 'global', 'lessons.jsonl');
  const tracker = trackFsCalls(['writeFileSync', 'appendFileSync']);
  let result;
  try { result = harvest.harvest({ scanDir: portfolio, root, globalStore, dryRun: true }); }
  finally { tracker.restore(); }
  assert.strictEqual(result.lessons_stored, 0);
  assert.ok(result.would_store >= 1, 'dry-run must still report what WOULD have been learned');
  assert.strictEqual(tracker.calls.writeFileSync.length, 0);
  assert.strictEqual(tracker.calls.appendFileSync.length, 0);
  assert.strictEqual(fs.existsSync(globalStore), false);
});

t('CLI --dry-run reports would-be counts and creates no store file', () => {
  const root = freshRoot('harvest-dryrun-cli-root');
  const portfolio = freshRoot('harvest-dryrun-cli-portfolio');
  buildFakeProject(portfolio, 'proj-dry-cli', { 'FORGE_MEMORY.md': '- CLI-dry-run-test evidenced memory line right here.' });
  const globalStore = path.join(root, '.claude', 'agent-memory', 'global', 'lessons.jsonl');
  const r = runCLI(['--scan', portfolio, '--global-store', globalStore, '--dry-run', '--json'], root);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.lessons_stored, 0);
  assert.ok(parsed.would_store >= 1);
  assert.strictEqual(fs.existsSync(globalStore), false);
});

// ---------------------------------------------------------------------------
// 8) CLI usage + honest empty defaults
// ---------------------------------------------------------------------------
console.log('\n8) CLI usage + honest empty default (guardrail 4)');

t('CLI --help exits 0', () => {
  const r = runCLI(['--help'], freshRoot('harvest-cli-help'));
  assert.strictEqual(r.status, 0);
});

t('CLI --scan with no directory value is a usage error (exit 2)', () => {
  const r = runCLI(['--scan'], freshRoot('harvest-cli-usage'));
  assert.strictEqual(r.status, 2);
});

t('CLI with neither --scan nor --projects is an honest empty success (exit 0), not an error', () => {
  const root = freshRoot('harvest-cli-empty');
  const r = runCLI(['--json'], root);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.projects_scanned, 0);
  assert.strictEqual(parsed.lessons_stored, 0);
  assert.ok(parsed.notes.some((n) => /explicit discovery is required/.test(n)));
});

t('a real CLI run over --scan reports which projects were harvested', () => {
  const root = freshRoot('harvest-cli-real-root');
  const portfolio = freshRoot('harvest-cli-real-portfolio');
  buildFakeProject(portfolio, 'proj-cli-real', { 'FORGE_MEMORY.md': '- CLI-real-run evidenced memory line right here for real.' });
  const globalStore = path.join(root, '.claude', 'agent-memory', 'global', 'lessons.jsonl');
  const r = runCLI(['--scan', portfolio, '--global-store', globalStore, '--json'], root);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.projects_scanned, 1);
  assert.ok(parsed.projects.some((p) => p.project === 'proj-cli-real'));
  assert.ok(parsed.lessons_stored >= 1);
  assert.strictEqual(fs.existsSync(globalStore), true);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
