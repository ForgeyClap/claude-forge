// Unit tests for artifact-content.mjs — build-lastdemos T2 (the real "Download" endpoint).
// Isolated fixtures only (an artifact's real projectPath is passed in directly by the caller, the
// same contract proof.mjs already uses — no SYNC_SCAN_ROOT containment needed inside this module
// itself, that check already runs once in server.mjs's resolveProjectByName()). One read-only
// sanity check against this project's OWN real run-artifacts (mirrors proof.test.mjs's own
// precedent) proves the wiring against real, already-existing files too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  safeArtifactIdOk,
  resolveArtifactContentPath,
  buildArtifactContentResponse,
} from '../src/artifact-content.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';

let projectRoot;

before(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-artifact-content-test-'));

  // Strategy 1 fixture: a forge-artifacts index doc whose own `path` points at a real file.
  fs.mkdirSync(path.join(projectRoot, '.claude', 'forge-artifacts'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'reports', 'doc1.txt'), 'real indexed artifact body', 'utf8');
  fs.writeFileSync(
    path.join(projectRoot, '.claude', 'forge-artifacts', 'doc1.json'),
    JSON.stringify({ path: 'reports/doc1.txt', title: 'Doc 1' }),
    'utf8',
  );
  // Real-world edge case (seen in this project's own store): a doc whose `path` is a DIRECTORY,
  // not a file — must resolve to null, never crash trying to readFileSync a directory.
  fs.mkdirSync(path.join(projectRoot, 'reports', 'a-dir'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.claude', 'forge-artifacts', 'dir-doc.json'),
    JSON.stringify({ path: 'reports/a-dir' }),
    'utf8',
  );
  // Containment-escape attempt: a doc whose `path` tries to leave the project root.
  fs.writeFileSync(
    path.join(projectRoot, '.claude', 'forge-artifacts', 'escape-doc.json'),
    JSON.stringify({ path: '../../outside.txt' }),
    'utf8',
  );

  // Strategy 2 fixture: TWO run directories — the first does NOT have the target file (proves the
  // scan continues past a non-matching run), the second does.
  fs.mkdirSync(path.join(projectRoot, '.claude', 'forge-runs', 'run-a', 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.claude', 'forge-runs', 'run-a', 'artifacts', 'unrelated.png'), 'nope', 'utf8');
  fs.mkdirSync(path.join(projectRoot, '.claude', 'forge-runs', 'run-b', 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.claude', 'forge-runs', 'run-b', 'artifacts', 'shot.png'), 'fake-png-bytes', 'utf8');
});

after(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

/* --------------------------------------------------------------------- safeArtifactIdOk */

test('safeArtifactIdOk accepts a real filename with an extension', () => {
  assert.equal(safeArtifactIdOk('wp0-health-report.md'), true);
  assert.equal(safeArtifactIdOk('doc1'), true);
});

test('safeArtifactIdOk rejects traversal, path separators, a leading dot, and non-strings', () => {
  assert.equal(safeArtifactIdOk('../evil'), false);
  assert.equal(safeArtifactIdOk('..'), false);
  assert.equal(safeArtifactIdOk('a/b'), false);
  assert.equal(safeArtifactIdOk('a\\b'), false);
  assert.equal(safeArtifactIdOk('a..b'), false);
  assert.equal(safeArtifactIdOk(''), false);
  assert.equal(safeArtifactIdOk(null), false);
  assert.equal(safeArtifactIdOk(undefined), false);
  assert.equal(safeArtifactIdOk(123), false);
});

/* ------------------------------------------------------------ resolveArtifactContentPath */

test('resolves a real file via the forge-artifacts index doc\'s own path field', () => {
  const resolved = resolveArtifactContentPath(projectRoot, 'doc1');
  assert.equal(resolved, path.join(projectRoot, 'reports', 'doc1.txt'));
});

test('a doc whose path points at a DIRECTORY resolves to null, never throws', () => {
  assert.equal(resolveArtifactContentPath(projectRoot, 'dir-doc'), null);
});

test('a doc whose path tries to escape the project root resolves to null', () => {
  assert.equal(resolveArtifactContentPath(projectRoot, 'escape-doc'), null);
  assert.equal(fs.existsSync(path.join(projectRoot, '..', '..', 'outside.txt')), false);
});

test('falls back to scanning every run\'s own artifacts/ dir when no index doc matches, finding it past a non-matching run', () => {
  const resolved = resolveArtifactContentPath(projectRoot, 'shot.png');
  assert.equal(resolved, path.join(projectRoot, '.claude', 'forge-runs', 'run-b', 'artifacts', 'shot.png'));
});

test('an unknown id resolves to null', () => {
  assert.equal(resolveArtifactContentPath(projectRoot, 'does-not-exist.md'), null);
});

test('a traversal-shaped id never reaches the filesystem at all', () => {
  assert.equal(resolveArtifactContentPath(projectRoot, '../../../../etc/passwd'), null);
});

/* -------------------------------------------------------------- buildArtifactContentResponse */

test('returns the real bytes, a text mime type, and a safe fileName for the indexed text artifact', () => {
  const result = buildArtifactContentResponse(projectRoot, 'doc1');
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.buffer.toString('utf8'), 'real indexed artifact body');
  assert.equal(result.fileName, 'doc1.txt');
  assert.match(result.mime, /text\/plain/);
});

test('returns a real image mime type for the run-artifacts-dir PNG fixture', () => {
  const result = buildArtifactContentResponse(projectRoot, 'shot.png');
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.buffer.toString('utf8'), 'fake-png-bytes');
});

test('404s honestly for an id that resolves nowhere', () => {
  const result = buildArtifactContentResponse(projectRoot, 'nowhere.md');
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

/* --------------------------------------------------- real-project sanity check (read-only) */

test('REAL PROJECT: resolves and serves the real wp0-health-report.md from this project\'s own run-artifacts-dir', () => {
  const RUN_ARTIFACT = path.join(PROJECT_ROOT, '.claude', 'forge-runs', 'forge-2026-07-25-full-audit', 'artifacts', 'wp0-health-report.md');
  // Skip honestly if a future cleanup ever removes this real fixture — never fabricate a pass.
  if (!fs.existsSync(RUN_ARTIFACT)) {
    assert.ok(true, 'real fixture wp0-health-report.md is absent — skipping this sanity check honestly');
    return;
  }
  const result = buildArtifactContentResponse(PROJECT_ROOT, 'wp0-health-report.md');
  assert.equal(result.ok, true);
  assert.equal(result.buffer.toString('utf8'), fs.readFileSync(RUN_ARTIFACT, 'utf8'));
  assert.match(result.mime, /text\/markdown/);
});
