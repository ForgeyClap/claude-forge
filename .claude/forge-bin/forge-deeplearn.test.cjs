#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-deeplearn.cjs — builds throwaway fixture projects under
 *  os.mkdtemp and calls scanProject() directly. Never touches the real project, never uses
 *  --run/--store (no dashboard/log-event/network paths exercised). Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanProject, categoryOf, SECRET_PATTERNS } = require('./forge-deeplearn.cjs');

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
const FAKE_SECRET = '\x6Evapi-FAKEFAKEFAKEFAKEFAKE1234567890';
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

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
