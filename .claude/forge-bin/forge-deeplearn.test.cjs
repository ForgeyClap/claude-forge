#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-deeplearn.cjs — builds throwaway fixture projects under
 *  os.mkdtemp and calls scanProject() directly. Never touches the real project, never uses
 *  --run/--store (no dashboard/log-event/network paths exercised). Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanProject, categoryOf, SECRET_PATTERNS, isFixtureOrDocsLocation } = require('./forge-deeplearn.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

function mkFixture(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

console.log('forge-deeplearn offline tests');

// ---- Fixture A: risky project — secrets, no tests, no .gitignore, an oversized file ----
// FAKE_SECRET is a deliberately fake test string (never a real credential) used only to prove
// detection + non-leakage of the redaction logic.
const FAKE_SECRET = 'nvapi-FAKEFAKEFAKEFAKEFAKE1234567890';
const riskyRoot = mkFixture('forge-deeplearn-risky-');
write(riskyRoot, 'package.json', JSON.stringify({ name: 'risky-fixture', version: '1.0.0', dependencies: { react: '^18.0.0' } }, null, 2));
write(riskyRoot, 'src/index.js', 'module.exports = function main() { return 1; };\n');
write(riskyRoot, 'big.js', Array.from({ length: 900 }, (_, i) => '// line ' + i).join('\n') + '\n');
write(riskyRoot, '.env', 'NVIDIA_KEY=' + FAKE_SECRET + '\n');

const risky = scanProject(riskyRoot);

t('risky: stack includes node', risky.stack.includes('node'));
t('risky: stack includes react hint', risky.stack.includes('react'));
t('risky: counts.code >= 2', risky.counts.code >= 2);

const secretRisk = risky.risks.find((r) => r.kind === 'secret-pattern' && r.level === 'high');
t('risky: HIGH secret-pattern risk detected', !!secretRisk);
t('risky: secret risk evidence carries only {file, pattern_name}', !!secretRisk && Object.keys(secretRisk.evidence).sort().join(',') === 'file,pattern_name');
t('risky: secret pattern_name is nvidia-nvapi-key', !!secretRisk && secretRisk.evidence.pattern_name === 'nvidia-nvapi-key');
t('risky: fake secret string ABSENT from risks JSON', !JSON.stringify(risky.risks).includes(FAKE_SECRET));
t('risky: fake secret string ABSENT from the full scan result JSON', !JSON.stringify(risky).includes(FAKE_SECRET));

const oversizeRisk = risky.risks.find((r) => r.kind === 'oversized-file');
t('risky: oversized-file med risk present (900-line big.js)', !!oversizeRisk && oversizeRisk.level === 'med' && oversizeRisk.evidence.file === 'big.js' && oversizeRisk.evidence.lines === 900);
t('risky: no-tests risk present', risky.risks.some((r) => r.kind === 'no-tests' && r.level === 'med'));
t('risky: env-file-exposure HIGH risk present (real .env, no .gitignore)', risky.risks.some((r) => r.kind === 'env-file-exposure' && r.level === 'high'));
t('risky: no-readme low risk present', risky.risks.some((r) => r.kind === 'no-readme' && r.level === 'low'));
t('risky: tests.present is false', risky.tests.present === false);
t('risky: largest[0] is big.js with 900 lines', risky.largest[0] && risky.largest[0].path === 'big.js' && risky.largest[0].lines === 900);

// ---- Fixture B: clean project — tests present, .gitignore covers .env, README, small files, no secrets ----
const cleanRoot = mkFixture('forge-deeplearn-clean-');
write(cleanRoot, 'package.json', JSON.stringify({ name: 'clean-fixture', version: '1.0.0' }, null, 2));
write(cleanRoot, 'README.md', '# Clean fixture\n');
write(cleanRoot, '.gitignore', 'node_modules\n.env\n');
write(cleanRoot, '.env', 'NODE_ENV=development\n');
write(cleanRoot, 'src/index.js', 'module.exports = function main() { return 1; };\n');
write(cleanRoot, 'tests/index.test.js', "test('ok', () => { expect(1).toBe(1); });\n");

const clean = scanProject(cleanRoot);

t('clean: tests.present is true', clean.tests.present === true);
t('clean: tests.files === 1', clean.tests.files === 1);
t('clean: ZERO high risks', !clean.risks.some((r) => r.level === 'high'));
t('clean: no no-tests risk', !clean.risks.some((r) => r.kind === 'no-tests'));
t('clean: no env-file-exposure risk (gitignore covers .env)', !clean.risks.some((r) => r.kind === 'env-file-exposure'));
t('clean: no no-readme risk', !clean.risks.some((r) => r.kind === 'no-readme'));

// ---- Fixture C: secret-pattern triage — real code stays HIGH, test/fixture/docs locations demote
// to MED "secret-pattern-fixture-looking" (2026-09-24 loop wp-l1). Same fake pattern in 4 locations. ----
const triageRoot = mkFixture('forge-deeplearn-triage-');
write(triageRoot, 'package.json', JSON.stringify({ name: 'triage-fixture', version: '1.0.0' }, null, 2));
write(triageRoot, 'src/x.js', 'const key = "' + FAKE_SECRET + '";\n');
write(triageRoot, 'test/x.test.js', "test('detects the pattern', () => { const key = '" + FAKE_SECRET + "'; });\n");
write(triageRoot, 'docs/y.md', '# Secret pattern doc\n\nExample: `' + FAKE_SECRET + '`\n');
write(triageRoot, 'test-evidence/z.mjs', '// evidence fixture\nconst key = "' + FAKE_SECRET + '";\n');

const triage = scanProject(triageRoot);
const secretRisks = triage.risks.filter((r) => r.evidence && r.evidence.pattern_name === 'nvidia-nvapi-key');

t('triage: 4 secret-pattern hits detected total', secretRisks.length === 4);

const realCodeHit = secretRisks.find((r) => r.evidence.file === 'src/x.js');
t('triage: src/x.js stays HIGH secret-pattern', !!realCodeHit && realCodeHit.level === 'high' && realCodeHit.kind === 'secret-pattern');

const testHit = secretRisks.find((r) => r.evidence.file === 'test/x.test.js');
t('triage: test/x.test.js is MED fixture-looking', !!testHit && testHit.level === 'med' && testHit.kind === 'secret-pattern-fixture-looking');
t('triage: fixture-looking hit carries a note pointing to forge-secret-scrub.cjs', !!testHit && typeof testHit.note === 'string' && testHit.note.includes('forge-secret-scrub.cjs'));

const docsHit = secretRisks.find((r) => r.evidence.file === 'docs/y.md');
t('triage: docs/y.md is MED fixture-looking', !!docsHit && docsHit.level === 'med' && docsHit.kind === 'secret-pattern-fixture-looking');

const evidenceHit = secretRisks.find((r) => r.evidence.file === 'test-evidence/z.mjs');
t('triage: test-evidence/z.mjs is MED fixture-looking', !!evidenceHit && evidenceHit.level === 'med' && evidenceHit.kind === 'secret-pattern-fixture-looking');

t('triage: fixture-looking hits never leak the raw secret text', !JSON.stringify(triage.risks).includes(FAKE_SECRET));

// summary line counts both HIGH (real code) and MED (fixture-looking) — mirrors the CLI's high/med/low tally
const triageHigh = triage.risks.filter((r) => r.level === 'high').length;
const triageMed = triage.risks.filter((r) => r.level === 'med').length;
t('triage: summary counts include the 1 real HIGH hit', triageHigh >= 1);
t('triage: summary counts include the 3 fixture-looking MED hits', triageMed >= 3);

// isFixtureOrDocsLocation() unit checks
t('isFixtureOrDocsLocation: src/x.js -> false', isFixtureOrDocsLocation('src/x.js') === false);
t('isFixtureOrDocsLocation: test/x.test.js -> true', isFixtureOrDocsLocation('test/x.test.js') === true);
t('isFixtureOrDocsLocation: docs/y.md -> true', isFixtureOrDocsLocation('docs/y.md') === true);
t('isFixtureOrDocsLocation: test-evidence/z.mjs -> true', isFixtureOrDocsLocation('test-evidence/z.mjs') === true);
t('isFixtureOrDocsLocation: README.md at root -> true', isFixtureOrDocsLocation('README.md') === true);
t('isFixtureOrDocsLocation: fixtures/sample.js -> true', isFixtureOrDocsLocation('fixtures/sample.js') === true);

// ---- categoryOf() unit checks ----
t('categoryOf: src/index.js -> code', categoryOf('src/index.js') === 'code');
t('categoryOf: README.md -> docs', categoryOf('README.md') === 'docs');
t('categoryOf: package.json -> config', categoryOf('package.json') === 'config');
t('categoryOf: tests/index.test.js -> test', categoryOf('tests/index.test.js') === 'test');
t('categoryOf: assets/logo.png -> other', categoryOf('assets/logo.png') === 'other');
t('categoryOf: .env -> config', categoryOf('.env') === 'config');

// ---- scanProject() rejects a non-existent path ----
let threw = false;
try { scanProject(path.join(riskyRoot, 'does-not-exist')); } catch (e) { threw = /not a directory/.test(e.message); }
t('scanProject throws on a non-existent path', threw === true);

// ---- SECRET_PATTERNS sanity (re-declared set mirrors forge-store.cjs's 7 patterns) ----
t('SECRET_PATTERNS has 7 entries', Array.isArray(SECRET_PATTERNS) && SECRET_PATTERNS.length === 7);
t('SECRET_PATTERNS entries carry {name, re}', SECRET_PATTERNS.every((p) => typeof p.name === 'string' && p.re instanceof RegExp));

// ---- static guard (2026-09-24, loop run): the scanner's own dashboard events are logged as the ORCHESTRATOR with role
// 'project-scan'. Logging them under the unregistered agent name 'project-scan' made forge-runcontract.cjs treat that
// name as an unknown WORKER and refuse every independent review of the run (fail-closed). Same fix pattern as
// forge-manifest.cjs; guarded statically so it cannot drift back without this test going red. ----
const deeplearnSrc = fs.readFileSync(path.join(__dirname, 'forge-deeplearn.cjs'), 'utf8');
t('deep_learn events are logged as agent orchestrator (never as an unregistered agent name)', !/agent:\s*'project-scan'/.test(deeplearnSrc));
t('deep_learn events carry role project-scan + runtime internal for both start and completion', (deeplearnSrc.match(/agent: 'orchestrator', role: 'project-scan', runtime: 'internal'/g) || []).length === 2);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
