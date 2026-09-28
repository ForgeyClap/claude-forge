// Codex run B F-01 / F-03 (2026-09-28): the two pure text checks every path from a request, a
// setting or the project registry goes through before any filesystem call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isNetworkOrDevicePath, hasControlChars, safeRealpathSync } from '../src/paths.mjs';

test('network and device paths are recognised in every spelling', () => {
  for (const p of [
    '\\\\attacker\\share',
    '\\\\attacker\\share\\folder',
    '//attacker/share',
    '\\\\?\\UNC\\attacker\\share',
    '\\\\?\\C:\\Users',
    '\\\\.\\pipe\\x',
    '//?/C:/Users',
    '//./pipe/x',
    '/\\attacker\\share',
  ]) {
    assert.equal(isNetworkOrDevicePath(p), true, p);
  }
});

test('ordinary local paths are not network paths', () => {
  for (const p of ['C:\\Users\\me\\Documents', 'C:/Users/me', '/home/me/projects', '/', 'relative\\dir', '']) {
    assert.equal(isNetworkOrDevicePath(p), false, p);
  }
  assert.equal(isNetworkOrDevicePath(null), false);
  assert.equal(isNetworkOrDevicePath(42), false);
});

test('control characters are caught, ordinary text is not', () => {
  for (const p of ['/tmp/x\nRUNNER=claude', 'C:\\x\r\nA=b', 'a\u0000b', 'tab\there', 'del\u007f']) {
    assert.equal(hasControlChars(p), true, JSON.stringify(p));
  }
  for (const p of ['C:\\Users\\me\\Mijn projecten', '/home/me/ünïcode-map', 'a=b', '']) {
    assert.equal(hasControlChars(p), false, JSON.stringify(p));
  }
  assert.equal(hasControlChars(undefined), false);
});

/* -------------------------------------------------- safeRealpathSync() (Codex run B F-01) */
// A bounded, hop-by-hop stand-in for fs.realpathSync.native() that refuses to follow a symlink/
// junction whose own target text is a network or device path — used by folder-browse.mjs (the
// requested dir, and any symlinked listing entry) and discord-service.mjs (the projects-dir
// setting, on both GET and POST) so neither ever calls stat/readdir/mkdir on something that could
// resolve to `\\host\share\...`.

test('safeRealpathSync(): a literal UNC path is refused immediately, without ever calling a single fs primitive', () => {
  const original = { lstatSync: fs.lstatSync, readlinkSync: fs.readlinkSync, statSync: fs.statSync };
  const nativeOriginal = fs.realpathSync.native;
  const fail = (name) => () => {
    throw new Error(`safeRealpathSync must not call fs.${name} for a path rejected by the pure text check`);
  };
  fs.lstatSync = fail('lstatSync');
  fs.readlinkSync = fail('readlinkSync');
  fs.statSync = fail('statSync');
  fs.realpathSync.native = fail('realpathSync.native');
  try {
    const result = safeRealpathSync('\\\\attacker\\share\\projects');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EUNSAFE_LINK');
  } finally {
    fs.lstatSync = original.lstatSync;
    fs.readlinkSync = original.readlinkSync;
    fs.statSync = original.statSync;
    fs.realpathSync.native = nativeOriginal;
  }
});

test('safeRealpathSync(): a control character in the input is refused immediately, before any fs call', () => {
  const original = fs.lstatSync;
  fs.lstatSync = () => {
    throw new Error('safeRealpathSync must not call fs.lstatSync for a path rejected by the pure text check');
  };
  try {
    const result = safeRealpathSync('C:\\Users\\me\\evil\nRUNNER=claude');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EUNSAFE_CHARS');
  } finally {
    fs.lstatSync = original;
  }
});

test('safeRealpathSync(): an ordinary, real, link-free directory resolves exactly like fs.realpathSync.native()', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-saferealpath-ordinary-'));
  try {
    const result = safeRealpathSync(fixtureRoot);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.real, fs.realpathSync.native(fixtureRoot));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('safeRealpathSync(): a folder that does not exist is refused honestly (ENOENT), not as a security condition', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-saferealpath-enoent-'));
  try {
    const result = safeRealpathSync(path.join(fixtureRoot, 'nope-not-there'));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ENOENT');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('safeRealpathSync(): a real, local junction resolves to its real target — the ordinary "OneDrive-style redirect" case keeps working', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-saferealpath-junction-'));
  try {
    const target = path.join(fixtureRoot, 'real-target');
    fs.mkdirSync(target, { recursive: true });
    const link = path.join(fixtureRoot, 'a-junction');
    try {
      fs.symlinkSync(target, link, 'junction');
    } catch {
      t.skip('junction could not be created in this sandbox');
      return;
    }
    const result = safeRealpathSync(link);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.real, fs.realpathSync.native(target));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('safeRealpathSync(): a chain of two real, local junctions resolves all the way to the final real target', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-saferealpath-chain-'));
  try {
    const finalTarget = path.join(fixtureRoot, 'final');
    fs.mkdirSync(finalTarget, { recursive: true });
    const linkB = path.join(fixtureRoot, 'link-b');
    const linkA = path.join(fixtureRoot, 'link-a');
    try {
      fs.symlinkSync(finalTarget, linkB, 'junction');
      fs.symlinkSync(linkB, linkA, 'junction');
    } catch {
      t.skip('junction could not be created in this sandbox');
      return;
    }
    const result = safeRealpathSync(linkA);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.real, fs.realpathSync.native(finalTarget));
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('safeRealpathSync(): a link whose OWN target is a network path is refused before the final canonicalization call is ever reached (real junctions cannot carry a UNC target on this platform — the unsafe hop is simulated at the fs layer, never a real network attempt)', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-saferealpath-simlink-'));
  const linkPath = path.join(fixtureRoot, 'evil-link');
  const linkPathResolved = path.resolve(linkPath);
  const originalLstatSync = fs.lstatSync;
  const originalReadlinkSync = fs.readlinkSync;
  const originalRealpathNative = fs.realpathSync.native;
  let realpathNativeCalled = false;
  fs.lstatSync = (p) => (path.resolve(p) === linkPathResolved ? { isSymbolicLink: () => true } : originalLstatSync(p));
  fs.readlinkSync = (p) => (path.resolve(p) === linkPathResolved ? '\\\\attacker\\share' : originalReadlinkSync(p));
  fs.realpathSync.native = (...args) => {
    realpathNativeCalled = true;
    return originalRealpathNative(...args);
  };
  try {
    const result = safeRealpathSync(linkPath);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EUNSAFE_LINK');
    assert.equal(realpathNativeCalled, false, 'must refuse before the final "everything is link-free" canonicalization call');
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.readlinkSync = originalReadlinkSync;
    fs.realpathSync.native = originalRealpathNative;
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('safeRealpathSync(): a link whose OWN target contains a control character is refused the same way (simulated)', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-saferealpath-simlink2-'));
  const linkPath = path.join(fixtureRoot, 'evil-link');
  const linkPathResolved = path.resolve(linkPath);
  const originalLstatSync = fs.lstatSync;
  const originalReadlinkSync = fs.readlinkSync;
  fs.lstatSync = (p) => (path.resolve(p) === linkPathResolved ? { isSymbolicLink: () => true } : originalLstatSync(p));
  fs.readlinkSync = (p) => (path.resolve(p) === linkPathResolved ? 'C:\\evil\nRUNNER=claude' : originalReadlinkSync(p));
  try {
    const result = safeRealpathSync(linkPath);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EUNSAFE_CHARS');
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.readlinkSync = originalReadlinkSync;
    fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});
