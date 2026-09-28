// WP-S1 (owner request 2026-09-27) — unit coverage for folder-browse.mjs's browseFolder(). A
// read-only picker, so (unlike files.mjs's own project-scoped browser) plain os.tmpdir()-based
// fixtures are fine here — there is no SYNC_SCAN_ROOT containment rule for this module (see its
// own header for why: there is no project path to contain a "pick a brand-new root" flow to yet).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browseFolder, DEFAULT_BROWSE_ROOT, _setScanBudgetForTests, _resetScanBudgetForTests } from '../src/folder-browse.mjs';

let fixtureRoot;

before(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-folder-browse-test-'));
  fs.mkdirSync(path.join(fixtureRoot, 'Beta'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'just-a-file.txt'), 'x', 'utf8');
  if (process.platform === 'win32') {
    fs.mkdirSync(path.join(fixtureRoot, '$RECYCLE.BIN'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'System Volume Information'), { recursive: true });
  }
  try {
    fs.symlinkSync(path.join(fixtureRoot, 'alpha'), path.join(fixtureRoot, 'alpha-link'), 'junction');
  } catch {
    // Symlink/junction creation can fail in a locked-down CI sandbox — the test below that reads
    // this entry skips itself when it never got created, rather than failing on an environment
    // limitation unrelated to browseFolder() itself.
  }
});

after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

test('browseFolder(): no argument defaults to <home>/Documents', () => {
  const result = browseFolder(undefined);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.path, fs.realpathSync.native(DEFAULT_BROWSE_ROOT));
});

test('browseFolder(): an empty string also falls back to the default root', () => {
  const result = browseFolder('');
  assert.equal(result.ok, true);
  assert.equal(result.path, fs.realpathSync.native(DEFAULT_BROWSE_ROOT));
});

test('browseFolder(): a relative path is rejected', () => {
  const result = browseFolder('relative/dir');
  assert.equal(result.ok, false);
  assert.match(result.error, /absolute/);
});

test('browseFolder(): a folder that does not exist is rejected honestly', () => {
  const result = browseFolder(path.join(fixtureRoot, 'nope-not-there'));
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});

test('browseFolder(): a real FILE (not a directory) is rejected', () => {
  const result = browseFolder(path.join(fixtureRoot, 'just-a-file.txt'));
  assert.equal(result.ok, false);
  assert.match(result.error, /not a folder/);
});

test('browseFolder(): lists real subfolder NAMES only — case-insensitively sorted, dot-folder excluded, the plain file excluded, never any file content', () => {
  const result = browseFolder(fixtureRoot);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.folders.filter((n) => n === 'alpha' || n === 'Beta' || n === '.hidden' || n === 'just-a-file.txt'), ['alpha', 'Beta']);
  assert.equal(result.folders.includes('.hidden'), false);
  assert.equal(result.folders.includes('just-a-file.txt'), false);
  assert.equal('content' in result, false, 'this endpoint must never carry file content at all');
  assert.equal(result.truncated, false);
});

test('browseFolder(): reports the real parent directory, one level up', () => {
  const result = browseFolder(fixtureRoot);
  assert.equal(result.ok, true);
  assert.equal(result.parent, fs.realpathSync.native(path.dirname(fixtureRoot)));
});

test('browseFolder(): a filesystem root has no parent (parent:null) — never a self-referencing "up"', () => {
  const root = path.parse(fixtureRoot).root;
  const result = browseFolder(root);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.parent, null);
});

test('browseFolder(): a symlink/junction that points at a real directory is still offered to navigate into', (t) => {
  if (!fs.existsSync(path.join(fixtureRoot, 'alpha-link'))) {
    t.skip('junction could not be created in this sandbox');
    return;
  }
  const result = browseFolder(fixtureRoot);
  assert.ok(result.folders.includes('alpha-link'));
});

test('browseFolder(): Windows junk folders ($RECYCLE.BIN, System Volume Information) are skipped on win32', { skip: process.platform !== 'win32' }, () => {
  const result = browseFolder(fixtureRoot);
  assert.equal(result.folders.includes('$RECYCLE.BIN'), false);
  assert.equal(result.folders.includes('System Volume Information'), false);
});

test('browseFolder(): a huge fanout is capped at MAX_ENTRIES and reports truncated:true', () => {
  const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-folder-browse-big-'));
  try {
    for (let i = 0; i < 505; i++) {
      fs.mkdirSync(path.join(bigDir, 'd' + String(i).padStart(4, '0')));
    }
    const result = browseFolder(bigDir);
    assert.equal(result.ok, true);
    assert.equal(result.folders.length, 500);
    assert.equal(result.truncated, true);
  } finally {
    fs.rmSync(bigDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

// ── Codex run B F-01 (2026-09-28): reject network/device paths and control characters before ANY
// filesystem call ─────────────────────────────────────────────────────────────────────────────

test('browseFolder(): a literal UNC path is refused, without ever calling a single fs primitive', () => {
  const original = { lstatSync: fs.lstatSync, statSync: fs.statSync, readdirSync: fs.readdirSync, opendirSync: fs.opendirSync };
  const nativeOriginal = fs.realpathSync.native;
  const fail = (name) => () => {
    throw new Error(`browseFolder must not call fs.${name} for a path rejected by the pure text check`);
  };
  fs.lstatSync = fail('lstatSync');
  fs.statSync = fail('statSync');
  fs.readdirSync = fail('readdirSync');
  fs.opendirSync = fail('opendirSync');
  fs.realpathSync.native = fail('realpathSync.native');
  try {
    const result = browseFolder('\\\\attacker\\share\\projects');
    assert.equal(result.ok, false);
    assert.match(result.error, /not allowed/);
  } finally {
    fs.lstatSync = original.lstatSync;
    fs.statSync = original.statSync;
    fs.readdirSync = original.readdirSync;
    fs.opendirSync = original.opendirSync;
    fs.realpathSync.native = nativeOriginal;
  }
});

test('browseFolder(): a forward-slash UNC path is refused the same way', () => {
  const result = browseFolder('//attacker/share');
  assert.equal(result.ok, false);
  assert.match(result.error, /not allowed/);
});

test('browseFolder(): a Windows device-namespace path is refused', () => {
  const result = browseFolder('\\\\?\\C:\\Users');
  assert.equal(result.ok, false);
  assert.match(result.error, /not allowed/);
});

test('browseFolder(): a control character in the path is refused, before any fs call', () => {
  const original = fs.lstatSync;
  fs.lstatSync = () => {
    throw new Error('browseFolder must not call fs.lstatSync for a path rejected by the pure text check');
  };
  try {
    const result = browseFolder('C:\\Users\\me\\evil\nRUNNER=claude');
    assert.equal(result.ok, false);
    assert.match(result.error, /not allowed/);
  } finally {
    fs.lstatSync = original;
  }
});

test('browseFolder(): a real, local junction as the requested dir resolves into its real target (ordinary case keeps working)', (t) => {
  const fixtureRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-folder-browse-linkdir-'));
  try {
    const target = path.join(fixtureRoot2, 'target');
    fs.mkdirSync(path.join(target, 'child'), { recursive: true });
    const link = path.join(fixtureRoot2, 'link-to-target');
    try {
      fs.symlinkSync(target, link, 'junction');
    } catch {
      t.skip('junction could not be created in this sandbox');
      return;
    }
    const result = browseFolder(link);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.path, fs.realpathSync.native(target));
    assert.deepEqual(result.folders, ['child']);
  } finally {
    fs.rmSync(fixtureRoot2, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('browseFolder(): a listed entry that is a REAL junction, but whose recorded target is (simulated as) a network path, is silently skipped, never stated', (t) => {
  const fixtureRoot3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-folder-browse-entrylink-'));
  const realTarget = path.join(fixtureRoot3, 'real-target-for-the-link');
  const evilName = 'evil-link';
  const evilPath = path.join(fixtureRoot3, evilName);
  try {
    fs.mkdirSync(realTarget, { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot3, 'ok-folder'), { recursive: true });
    try {
      // A REAL junction, so the dirent's own isSymbolicLink() (from the actual OS directory scan,
      // never faked) is genuinely true, and fs.lstatSync sees a genuine symlink too -- ONLY
      // fs.readlinkSync is faked below, standing in for "this real link's recorded target happens
      // to be a UNC path", which is the one piece a real junction cannot carry on this platform
      // (see paths-safety.test.mjs's own header for why).
      fs.symlinkSync(realTarget, evilPath, 'junction');
    } catch {
      t.skip('junction could not be created in this sandbox');
      return;
    }
    const evilPathResolved = path.resolve(evilPath);
    const originalReadlinkSync = fs.readlinkSync;
    fs.readlinkSync = (p) => (path.resolve(p) === evilPathResolved ? '\\\\attacker\\share' : originalReadlinkSync(p));
    try {
      const result = browseFolder(fixtureRoot3);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.folders.includes(evilName), false, 'a link whose target is a network path must never be listed as a navigable folder');
      assert.deepEqual(result.folders, ['ok-folder', 'real-target-for-the-link']);
    } finally {
      fs.readlinkSync = originalReadlinkSync;
    }
  } finally {
    fs.rmSync(fixtureRoot3, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

// ── Codex run B F-04 (2026-09-28): the raw scan itself has a hard, honestly-reported budget ────

test('browseFolder(): the scan stops at the injected budget and reports truncated:true, even with room left under MAX_ENTRIES', () => {
  const fixtureRoot4 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-folder-browse-budget-'));
  try {
    for (let i = 0; i < 12; i++) {
      fs.mkdirSync(path.join(fixtureRoot4, 'd' + String(i).padStart(2, '0')));
    }
    _setScanBudgetForTests(5);
    const result = browseFolder(fixtureRoot4);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.truncated, true);
    assert.ok(result.folders.length <= 5, `expected at most 5 entries scanned, got ${result.folders.length}`);
  } finally {
    _resetScanBudgetForTests();
    fs.rmSync(fixtureRoot4, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('browseFolder(): under the scan budget, truncated stays false (no false alarm)', () => {
  const fixtureRoot5 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-folder-browse-nobudget-'));
  try {
    for (let i = 0; i < 3; i++) {
      fs.mkdirSync(path.join(fixtureRoot5, 'd' + String(i).padStart(2, '0')));
    }
    _setScanBudgetForTests(5);
    const result = browseFolder(fixtureRoot5);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.truncated, false);
    assert.equal(result.folders.length, 3);
  } finally {
    _resetScanBudgetForTests();
    fs.rmSync(fixtureRoot5, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});
