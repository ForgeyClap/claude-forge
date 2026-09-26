// A3 fix (WP-C2, 2026-09-26 laptop re-audit) — CC_PROJECTS_EXTRA_ROOT must never widen project
// discovery/containment beyond "one more ordinary, existing, local project folder". Covers every
// rejected shape named in the finding (network/UNC path, relative path, non-existent path, a file
// instead of a directory, a drive root, the home folder itself) plus the accepted case, both at the
// pure-function level (validateExtraScanRoot) and end-to-end (a real child process importing
// paths.mjs with the env var actually set, since SYNC_SCAN_ROOTS is computed once at module load).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateExtraScanRoot } from '../src/paths.mjs';

function withCapturedConsoleError(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

let tempDir;
test.before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-extra-root-test-'));
});
test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('rejects a UNC/network path (backslash form)', () => {
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot('\\\\some-host\\share\\projects'));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes('network/UNC')));
});

test('rejects a UNC/network path (forward-slash form)', () => {
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot('//some-host/share/projects'));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes('network/UNC')));
});

test('rejects a relative (non-absolute) path', () => {
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot('relative/projects'));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes('not an absolute path')));
});

test('rejects a path that does not exist', () => {
  const missing = path.join(tempDir, 'this-does-not-exist-anywhere');
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot(missing));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes('does not exist')));
});

test('rejects a path that is a file, not a directory', () => {
  const filePath = path.join(tempDir, 'not-a-dir.txt');
  fs.writeFileSync(filePath, 'x', 'utf8');
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot(filePath));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes('not a directory')));
});

test('rejects a drive root', () => {
  const driveRoot = path.parse(process.cwd()).root; // e.g. "C:\\" on Windows, "/" elsewhere
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot(driveRoot));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes('drive root')));
});

test('rejects the home folder itself', () => {
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot(os.homedir()));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes('home folder itself')));
});

// N5 fix (2026-09-26 laptop re-audit verification, WP-C3): a differently-cased path on win32 must
// resolve to the SAME real target as the properly-cased home folder and be rejected exactly like
// the home folder itself.
test('rejects a case-variant of the home folder on win32 (skipped elsewhere)', { skip: process.platform !== 'win32' }, () => {
  const home = os.homedir();
  const swapped = home.split('').map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot(swapped));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes('home folder itself')));
});

// N5 fix: a folder that CONTAINS home (an ancestor, e.g. the home folder's own parent) must be
// rejected too — scanning it would scan home along with it.
test('rejects an ancestor of the home folder (a folder that contains home)', () => {
  const ancestor = path.dirname(path.resolve(os.homedir()));
  // Guard: if home's parent IS a drive root (e.g. home lives directly at "C:\home"), that shape is
  // already covered by the drive-root test above — skip this one rather than double-test it.
  if (path.parse(ancestor).root === ancestor) {
    return;
  }
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot(ancestor));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes('contains the home folder')));
});

// N5 fix: a junction/symlink whose literal path looks like an ordinary folder but actually points
// AT home must be rejected — the literal path alone must never be trusted, only its real target.
test('rejects a junction that points at the home folder', () => {
  const linkPath = path.join(tempDir, 'junction-to-home');
  try {
    fs.symlinkSync(path.resolve(os.homedir()), linkPath, 'junction');
  } catch (err) {
    // Creating a junction can require a permission this test runner does not have on some
    // machines/CI images — skip honestly rather than fail on an environment limitation unrelated
    // to the fix under test.
    console.log('SKIP: could not create a junction to test with (' + err.message + ')');
    return;
  }
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot(linkPath));
  assert.equal(result, null);
  assert.ok(lines.some((l) => l.includes('home folder itself')));
});

test('rejects empty / non-string input silently (no console noise for "unset")', () => {
  assert.equal(validateExtraScanRoot(''), null);
  assert.equal(validateExtraScanRoot('   '), null);
  assert.equal(validateExtraScanRoot(undefined), null);
  assert.equal(validateExtraScanRoot(null), null);
});

test('accepts a real, absolute, local, non-root, non-home directory — resolved and unchanged', () => {
  const validDir = path.join(tempDir, 'ok-extra-root');
  fs.mkdirSync(validDir, { recursive: true });
  const { result, lines } = withCapturedConsoleError(() => validateExtraScanRoot(validDir));
  assert.equal(result, path.resolve(validDir));
  assert.equal(lines.length, 0, 'an accepted value must never log a rejection line');
});

// End-to-end: a real child process with CC_PROJECTS_EXTRA_ROOT genuinely set in its env before
// paths.mjs is ever imported (SYNC_SCAN_ROOTS is computed once, at import time — no test-only
// override seam exists for it, unlike the discovery-side roots in projects.mjs).
function runInChildWithEnv(envValue) {
  const pathsFile = new URL('../src/paths.mjs', import.meta.url).href;
  const script = `import { SYNC_SCAN_ROOTS } from '${pathsFile}'; console.log(JSON.stringify(SYNC_SCAN_ROOTS));`;
  const scriptFile = path.join(tempDir, 'probe-' + Math.random().toString(36).slice(2) + '.mjs');
  fs.writeFileSync(scriptFile, script, 'utf8');
  const env = { ...process.env };
  if (envValue === undefined) delete env.CC_PROJECTS_EXTRA_ROOT;
  else env.CC_PROJECTS_EXTRA_ROOT = envValue;
  const result = spawnSync(process.execPath, [scriptFile], { encoding: 'utf8', env });
  return result;
}

test('END-TO-END: a real, valid CC_PROJECTS_EXTRA_ROOT ends up in SYNC_SCAN_ROOTS', () => {
  const validDir = path.join(tempDir, 'e2e-ok-root');
  fs.mkdirSync(validDir, { recursive: true });
  const result = runInChildWithEnv(validDir);
  assert.equal(result.status, 0, result.stderr);
  const roots = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.ok(roots.includes(path.resolve(validDir)));
});

test('END-TO-END: an invalid CC_PROJECTS_EXTRA_ROOT (UNC path) is ignored, never added, one clear log line on stderr', () => {
  const result = runInChildWithEnv('\\\\bad-host\\share');
  assert.equal(result.status, 0, result.stderr);
  const roots = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.ok(!roots.some((r) => r.includes('bad-host')));
  assert.match(result.stderr, /CC_PROJECTS_EXTRA_ROOT ignored/);
  assert.match(result.stderr, /network\/UNC/);
});
