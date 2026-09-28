// WP-P1 (Forge v2.9.0) — unit coverage for installed-projects.mjs's own read/parse/validate
// contract, in isolation from projects.mjs's merge logic (covered separately in
// projects-installed-and-template.test.mjs).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readInstalledProjectPaths,
  _setInstalledProjectsFileForTests,
  _resetInstalledProjectsFileForTests,
  _resetInstalledProjectsLogForTests,
} from '../src/installed-projects.mjs';

let tempDir;
let filePath;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-installed-projects-test-'));
  filePath = path.join(tempDir, 'projects.json');
  _setInstalledProjectsFileForTests(filePath);
  _resetInstalledProjectsLogForTests();
});

afterEach(() => {
  _resetInstalledProjectsFileForTests();
  _resetInstalledProjectsLogForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function makeRealProjectDir(name) {
  const dir = path.join(tempDir, name);
  fs.mkdirSync(path.join(dir, '.claude', 'forge-dashboard'), { recursive: true });
  return dir;
}

test('a missing file contributes zero paths and logs nothing (the ordinary case for most machines)', () => {
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.deepEqual(readInstalledProjectPaths(), []);
    assert.deepEqual(logged, []);
  } finally {
    console.error = originalConsoleError;
  }
});

test('a real recorded project that still exists on disk is returned, resolved', () => {
  const projA = makeRealProjectDir('proj-a');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [projA] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), [path.resolve(projA)]);
});

test('several real recorded projects are all returned', () => {
  const projA = makeRealProjectDir('proj-a');
  const projB = makeRealProjectDir('proj-b');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [projA, projB] }), 'utf8');
  const result = readInstalledProjectPaths().sort();
  assert.deepEqual(result, [path.resolve(projA), path.resolve(projB)].sort());
});

test('an entry whose directory no longer exists on disk is silently skipped, never crashes', () => {
  const projA = makeRealProjectDir('proj-a');
  const vanished = path.join(tempDir, 'proj-vanished');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [projA, vanished] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), [path.resolve(projA)]);
});

test('an entry that exists but has no .claude/forge-dashboard is silently skipped (not a real Forge project)', () => {
  const notAProject = path.join(tempDir, 'just-a-folder');
  fs.mkdirSync(notAProject, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [notAProject] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), []);
});

test('a relative-path entry is rejected — only absolute paths are ever honoured', () => {
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: ['relative/path'] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), []);
});

test('a non-string entry (number, null, object) is silently skipped, real entries around it survive', () => {
  const projA = makeRealProjectDir('proj-a');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [42, null, { path: 'x' }, projA] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), [path.resolve(projA)]);
});

// This module deliberately does NOT dedup on its own — deduplication (by resolved path, across
// ALL discovery sources, not just this one) is projects.mjs's own job (see its
// computeProjectsAsync()'s `addCandidate()`, and projects-installed-and-template.test.mjs's own
// "the SAME project listed by both a scan root and the installer file is returned once" test for
// the end-to-end proof). This reader's contract is simply "every VALID entry, resolved" — a raw
// list, duplicates and all, exactly as the installer's own file states them.
test('a literal duplicate entry in the file is returned twice — dedup is the caller\'s job, not this reader\'s', () => {
  const projA = makeRealProjectDir('proj-a');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [projA, projA] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), [path.resolve(projA), path.resolve(projA)]);
});

test('an empty projects array is valid and simply contributes nothing', () => {
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), []);
});

test('invalid JSON degrades to an empty list and logs exactly once for the life of the process', () => {
  fs.writeFileSync(filePath, '{ not valid json ][', 'utf8');
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.deepEqual(readInstalledProjectPaths(), []);
    assert.deepEqual(readInstalledProjectPaths(), []); // second read of the SAME bad file
    assert.equal(logged.length, 1, 'a persistently malformed file must log once per process, not once per read');
    assert.match(logged[0], /not valid JSON/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('valid JSON but the wrong shape (no "projects" array) degrades to an empty list and logs once', () => {
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, somethingElse: true }), 'utf8');
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.deepEqual(readInstalledProjectPaths(), []);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /expected.*shape/i);
  } finally {
    console.error = originalConsoleError;
  }
});

test('a bare JSON array (not the documented {schema, projects} object) degrades to an empty list, never throws', () => {
  const projA = makeRealProjectDir('proj-a');
  fs.writeFileSync(filePath, JSON.stringify([projA]), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), []);
});

test('an unexpected schema NUMBER is still read leniently — this module validates shape, not the version', () => {
  const projA = makeRealProjectDir('proj-a');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 999, projects: [projA] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), [path.resolve(projA)]);
});

// ── Codex run B F-01 — a registry entry that is a network/device path or has control characters
// must be dropped BEFORE any filesystem call (fs.existsSync/fs.realpathSync/fs.readlinkSync)
// ──────────────────────────────────────────────────────────────────────────────────────────────

test('F-01 hostile: a UNC-path entry (\\\\host\\share\\project) is dropped, never reaches fs.existsSync', () => {
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: ['\\\\attacker-host\\share\\project'] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), []);
});

test('F-01 hostile: a forward-slash UNC entry (//host/share/project) is also dropped', () => {
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: ['//attacker-host/share/project'] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), []);
});

test('F-01 hostile: a Windows device-namespace entry (\\\\?\\UNC\\host\\share) is dropped', () => {
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: ['\\\\?\\UNC\\attacker-host\\share\\project'] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), []);
});

test('F-01 hostile: an entry containing a control character (e.g. a NUL or newline) is dropped', () => {
  const projA = makeRealProjectDir('proj-a');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [projA + '\u0000evil', projA + '\nother-line', projA] }), 'utf8');
  // Only the clean entry survives; the two poisoned variants (even though they share a real prefix
  // with a genuine project) are dropped outright, and the real, unpoisoned entry is unaffected.
  assert.deepEqual(readInstalledProjectPaths(), [path.resolve(projA)]);
});

test('F-01 ordinary case: a real, ordinary local path entry is completely unaffected by the new checks', () => {
  const projA = makeRealProjectDir('proj-a');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [projA] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), [path.resolve(projA)]);
});

// Codex run B F-12 — a registry entry is admitted by its REAL (symlink/junction-resolved) path.
// Windows junctions (unlike symlinks) need no admin rights here; a junction cannot actually hold a
// readable UNC target on this platform (verified live: fs.symlinkSync(uncTarget, link, 'junction')
// creates a broken reparse point that fs.readlinkSync() itself refuses with EINVAL — Windows simply
// does not support a UNC-targeting junction) — that specific sub-case is therefore structurally
// unreachable rather than independently provable via a real junction; the STRUCTURAL guard
// (hasUnsafeLinkTarget) stays in place as defense in depth regardless, and a broken/unreadable link
// of ANY kind is already caught by the very next check (realpathOrNull returning null).
test('F-12: a registry entry that is a junction to a REAL local directory is admitted by its real target path', () => {
  const realTarget = path.join(tempDir, 'real-project-target');
  fs.mkdirSync(path.join(realTarget, '.claude', 'forge-dashboard'), { recursive: true });
  const linkPath = path.join(tempDir, 'linked-project');
  fs.symlinkSync(realTarget, linkPath, 'junction');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [linkPath] }), 'utf8');
  const result = readInstalledProjectPaths();
  assert.deepEqual(result, [fs.realpathSync.native(realTarget)], 'the REAL target path is what gets admitted, not the link\'s own typed path');
});

test('F-12: a junction pointing at a directory with no .claude/forge-dashboard is still correctly rejected (resolved before the real-project check)', () => {
  const notAProject = path.join(tempDir, 'not-a-project-target');
  fs.mkdirSync(notAProject, { recursive: true });
  const linkPath = path.join(tempDir, 'linked-not-a-project');
  fs.symlinkSync(notAProject, linkPath, 'junction');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [linkPath] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), []);
});

test('F-12: a broken/circular link is dropped, never crashes', () => {
  const linkPath = path.join(tempDir, 'broken-link');
  fs.symlinkSync(path.join(tempDir, 'does-not-exist-at-all'), linkPath, 'junction');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [linkPath] }), 'utf8');
  assert.deepEqual(readInstalledProjectPaths(), []);
});

test('F-01: a link HIGHER UP the entry\'s path whose own target is a network share is refused before anything follows it (simulated target, never a real network attempt)', () => {
  // A real local junction as the middle component, whose raw target text is made to read as a UNC path
  // (a real junction cannot carry a UNC target on Windows without admin rights; see paths-safety.test.mjs).
  const middle = path.join(tempDir, 'middle-link');
  const realTarget = path.join(tempDir, 'real-middle');
  fs.mkdirSync(path.join(realTarget, 'proj', '.claude', 'forge-dashboard'), { recursive: true });
  fs.symlinkSync(realTarget, middle, 'junction');
  const entry = path.join(middle, 'proj');
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, projects: [entry] }), 'utf8');
  const middleResolved = path.resolve(middle);
  const originalReadlink = fs.readlinkSync;
  const originalRealpathNative = fs.realpathSync.native;
  let realpathNativeCalled = false;
  fs.readlinkSync = (p, ...rest) => (path.resolve(String(p)) === middleResolved ? '\\attacker\share' : originalReadlink(p, ...rest));
  fs.realpathSync.native = (...args) => { realpathNativeCalled = true; return originalRealpathNative(...args); };
  try {
    assert.deepEqual(readInstalledProjectPaths(), [], 'the entry behind the unsafe link is dropped');
    assert.equal(realpathNativeCalled, false, 'the OS realpath (which would follow the whole chain) is never reached');
  } finally {
    fs.readlinkSync = originalReadlink;
    fs.realpathSync.native = originalRealpathNative;
  }
});
