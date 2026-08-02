// Unit + adversarial tests for files.mjs — the endpoint that serves arbitrary project file
// CONTENT to a browser for the first time on this gateway. Unlike most gateway modules,
// files.mjs ALSO defense-in-depth checks that the project path sits under SYNC_SCAN_ROOT (the
// Documents folder this whole Forge fleet lives under) — an os.tmpdir()-based fixture (this
// project's usual test-support/helpers.mjs::makeTempProjectRoot()) would genuinely fail that
// check and never reach the code under test at all (same lesson runs.test.mjs's own header
// documents for listRuns()). So the PRIMARY project fixture here is nested under this project's
// own command-center/.data/ (already .gitignore'd, and still a real descendant of SYNC_SCAN_ROOT
// since PROJECT_ROOT itself is) — staying inside this project's write scope. Fixtures that are
// only ever used as a symlink TARGET or a cross-project traversal DESTINATION (never passed as
// the `projectPath` argument itself) may still use the plain os.tmpdir() helper, since only the
// `projectPath` argument is subject to the SYNC_SCAN_ROOT check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listDirectory, readFilePreview, MAX_PREVIEW_BYTES } from '../src/files.mjs';
import { makeTempProjectRoot } from '../test-support/helpers.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-files');
let projectRoot;

before(() => {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  projectRoot = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# hello\n', 'utf8');
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'index.js'), 'console.log("hi");\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.env'), 'SECRET=abc123\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\n', 'utf8');
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');
  fs.mkdirSync(path.join(projectRoot, 'node_modules', 'some-pkg'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {};\n', 'utf8');
  // binary file: a NUL byte inside the first 8KB sample window
  fs.writeFileSync(path.join(projectRoot, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  // oversize file: bigger than the 256KB preview cap
  fs.writeFileSync(path.join(projectRoot, 'big.log'), 'x'.repeat(MAX_PREVIEW_BYTES + 5000), 'utf8');
  // a file whose CONTENT (not name) looks like a secret
  fs.writeFileSync(path.join(projectRoot, 'notes.txt'), 'the key is nvapi-abcdefghij1234567890\n', 'utf8');
});

after(() => {
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

test('listDirectory lists the project root with name/type/size/mtime', () => {
  const result = listDirectory(projectRoot, '');
  assert.equal(result.ok, true);
  assert.equal(result.path, '.');
  const readme = result.entries.find((e) => e.name === 'README.md');
  assert.ok(readme, 'README.md must be listed');
  assert.equal(readme.type, 'file');
  assert.ok(typeof readme.size === 'number' && readme.size > 0);
  assert.ok(typeof readme.mtime === 'string');
  const srcDir = result.entries.find((e) => e.name === 'src');
  assert.equal(srcDir.type, 'dir');
  assert.equal(srcDir.size, null);
});

test('listDirectory descends into a real subdirectory', () => {
  const result = listDirectory(projectRoot, 'src');
  assert.equal(result.ok, true);
  assert.equal(result.path, 'src');
  assert.ok(result.entries.some((e) => e.name === 'index.js'));
});

test('listDirectory ALLOWS listing node_modules (metadata only, no content served)', () => {
  const result = listDirectory(projectRoot, 'node_modules');
  assert.equal(result.ok, true);
  assert.ok(result.entries.some((e) => e.name === 'some-pkg' && e.type === 'dir'));
});

test('readFilePreview returns real text content for an ordinary file', () => {
  const result = readFilePreview(projectRoot, 'src/index.js');
  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);
  assert.equal(result.binary, false);
  assert.equal(result.content, 'console.log("hi");\n');
});

/* ---------------------------------------------------------- adversarial: traversal / escape --- */

test('SECURITY: ../ traversal is rejected by containment, never reaches the filesystem read', () => {
  const listResult = listDirectory(projectRoot, '../');
  assert.equal(listResult.ok, false);
  assert.match(listResult.error, /containment/);

  const readResult = readFilePreview(projectRoot, '../../etc/passwd');
  assert.equal(readResult.ok, false);
  assert.match(readResult.error, /containment/);
});

test('SECURITY: an absolute Windows path is rejected outright', () => {
  const result = readFilePreview(projectRoot, 'C:\\Windows\\win.ini');
  assert.equal(result.ok, false);
  assert.match(result.error, /absolute/);
});

test('SECURITY: a POSIX-style absolute path is rejected outright', () => {
  const result = readFilePreview(projectRoot, '/etc/passwd');
  assert.equal(result.ok, false);
  assert.match(result.error, /absolute/);
});

test('SECURITY: a UNC-style path is rejected outright', () => {
  const result = readFilePreview(projectRoot, '\\\\attacker-host\\share\\file.txt');
  assert.equal(result.ok, false);
  assert.match(result.error, /absolute/);
});

test('SECURITY: cross-project path (traversal into a sibling temp project) is rejected', () => {
  const siblingRoot = makeTempProjectRoot();
  try {
    fs.writeFileSync(path.join(siblingRoot, 'secret.txt'), 'sibling secret\n', 'utf8');
    const relFromA = path.relative(projectRoot, path.join(siblingRoot, 'secret.txt'));
    const result = readFilePreview(projectRoot, relFromA);
    assert.equal(result.ok, false);
    assert.match(result.error, /containment/);
  } finally {
    fs.rmSync(siblingRoot, { recursive: true, force: true });
  }
});

test('SECURITY: symlink escape is rejected (or honestly documented when the OS/user forbids symlinks)', (t) => {
  const outsideDir = makeTempProjectRoot();
  const linkPath = path.join(projectRoot, 'escape-link');
  try {
    fs.writeFileSync(path.join(outsideDir, 'outside-secret.txt'), 'outside secret\n', 'utf8');
    try {
      fs.symlinkSync(outsideDir, linkPath, 'junction');
    } catch (err) {
      t.skip('symlink/junction creation not permitted on this OS/user account: ' + err.message);
      return;
    }
    const readResult = readFilePreview(projectRoot, path.join('escape-link', 'outside-secret.txt'));
    assert.equal(readResult.ok, false, 'reading through a symlink that escapes the project root must be rejected');
    assert.match(readResult.error, /symlink|containment/);

    const listResult = listDirectory(projectRoot, 'escape-link');
    assert.equal(listResult.ok, false, 'listing INTO a symlink that escapes the project root must be rejected');
    assert.match(listResult.error, /symlink|containment/);
  } finally {
    try { fs.rmSync(linkPath, { force: true }); } catch { /* best-effort cleanup */ }
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------- adversarial: denylist --- */

test('SECURITY: .env is blocked by name, content is never returned', () => {
  const result = readFilePreview(projectRoot, '.env');
  assert.equal(result.ok, true);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'env-file');
  assert.equal(result.content, undefined);
});

test('SECURITY: id_rsa is blocked by name', () => {
  const result = readFilePreview(projectRoot, 'id_rsa');
  assert.equal(result.ok, true);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'ssh-private-key');
  assert.equal(result.content, undefined);
});

test('SECURITY: .git/config is blocked by name', () => {
  const result = readFilePreview(projectRoot, '.git/config');
  assert.equal(result.ok, true);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'git-config');
});

test('SECURITY: a file under node_modules is blocked from READING (listing is still allowed)', () => {
  const result = readFilePreview(projectRoot, path.join('node_modules', 'some-pkg', 'index.js'));
  assert.equal(result.ok, true);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'node-modules-content');
});

test('SECURITY: a binary file returns {binary:true}, never raw bytes', () => {
  const result = readFilePreview(projectRoot, 'image.bin');
  assert.equal(result.ok, true);
  assert.equal(result.binary, true);
  assert.equal(result.content, undefined);
  assert.ok(typeof result.size === 'number' && result.size > 0);
});

test('SECURITY: an oversize file is truncated at the 256KB cap, never read in full', () => {
  const result = readFilePreview(projectRoot, 'big.log');
  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);
  assert.equal(result.truncated, true);
  assert.equal(result.content.length, MAX_PREVIEW_BYTES);
  assert.ok(result.size > MAX_PREVIEW_BYTES);
});

test('SECURITY: content that matches a secret-shaped pattern is blocked even with an innocent filename', () => {
  const result = readFilePreview(projectRoot, 'notes.txt');
  assert.equal(result.ok, true);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'secret-pattern-detected');
  assert.equal(result.content, undefined);
});
