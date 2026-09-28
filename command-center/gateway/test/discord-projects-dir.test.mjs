// WP-S1 (owner request 2026-09-27) — unit-level coverage for discord-service.mjs's new
// `getProjectsDirStatus()` / `setProjectsDirSetting()`. Same isolation discipline as
// discord-service.test.mjs: every test uses `_setDiscordPathsForTests`/`_setHomeDirForTests` so
// NONE of these ever reads or writes the real command-center/discord/.env, and the "create:true"
// tests never touch the real developer/owner's actual home directory — only an isolated temp tree
// stood in for it via `_setHomeDirForTests`.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getProjectsDirStatus,
  setProjectsDirSetting,
  startDiscordService,
  _setDiscordPathsForTests,
  _setHomeDirForTests,
  _setSpawnFnForTests,
  _setFetchFnForTests,
  _setExtraEnvOverridesForTests,
  _setKillFnForTests,
  _resetDiscordServiceForTests,
  _mergeEnvTextForTests,
  _setProjectCountScanBudgetForTests,
  _resetProjectCountScanBudgetForTests,
} from '../src/discord-service.mjs';
// The bot's REAL parser (Codex run B F-03's round-trip proof must run through the actual code the
// bot itself uses to read discord/.env back — never a re-implementation of it in this test file).
import { loadConfig } from '../../discord/src/config.js';

let tempDir; // discord/ isolation (see isolatedPaths below)
let homeDir; // a throwaway stand-in for os.homedir(), never the real one

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

// Same shape as discord-service.test.mjs's own isolatedPaths() — a marker main.js + deps already
// "installed" so every test here (none of which are about install/CLI-broker behaviour) exercises
// the same fast path those tests were written against.
function isolatedPaths({ envContent = '' } = {}) {
  const mainJsDir = path.join(tempDir, 'src');
  fs.mkdirSync(mainJsDir, { recursive: true });
  const mainJs = path.join(mainJsDir, 'main.js');
  fs.writeFileSync(mainJs, '// fake main.js for tests\n', 'utf8');
  const envExampleFile = path.join(tempDir, '.env.example');
  fs.writeFileSync(envExampleFile, 'TRANSPORT=mock\nFORGE_PROJECTS_DIR=\n', 'utf8');
  const envFile = path.join(tempDir, '.env');
  fs.writeFileSync(envFile, envContent, 'utf8');
  fs.mkdirSync(path.join(tempDir, 'node_modules', 'discord.js'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'node_modules', 'discord.js', 'package.json'), '{"name":"discord.js"}\n', 'utf8');
  return {
    discordDir: tempDir,
    mainJs,
    envFile,
    envExampleFile,
    stateDir: path.join(tempDir, 'state'),
    logFile: path.join(tempDir, 'discord-bot.log'),
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discord-projdir-test-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discord-projdir-home-'));
  _resetDiscordServiceForTests();
  _setDiscordPathsForTests(isolatedPaths());
  _setHomeDirForTests(homeDir);
  _setFetchFnForTests(async () => {
    throw new Error('unreachable — isolated test port, nothing listens');
  });
});

afterEach(() => {
  _resetDiscordServiceForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

/* ---------------------------------------------------------- getProjectsDirStatus() */

test('getProjectsDirStatus(): no setting -> the default (<home>/Documents/ForgeProjects), source "default"', () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=mock\n' }));
  const status = getProjectsDirStatus();
  assert.equal(status.dir, path.join(homeDir, 'Documents', 'ForgeProjects'));
  assert.equal(status.source, 'default');
  assert.equal(status.exists, false);
  assert.equal(status.projectCount, null);
});

test('getProjectsDirStatus(): a real setting reports source "setting", exists:true, and an honest project count (dot-folders excluded)', () => {
  const target = path.join(homeDir, 'MyProjects');
  fs.mkdirSync(path.join(target, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(target, 'beta'), { recursive: true });
  fs.mkdirSync(path.join(target, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(target, 'not-a-folder.txt'), 'x', 'utf8');
  _setDiscordPathsForTests(isolatedPaths({ envContent: `TRANSPORT=mock\nFORGE_PROJECTS_DIR=${target}\n` }));

  const status = getProjectsDirStatus();
  assert.equal(status.dir, target);
  assert.equal(status.source, 'setting');
  assert.equal(status.exists, true);
  assert.equal(status.projectCount, 2, 'only alpha+beta count — dot-folder and the plain file are excluded');
});

test('getProjectsDirStatus(): a setting pointing at a folder that does not exist reports exists:false, projectCount:null (never a fabricated 0)', () => {
  const missing = path.join(homeDir, 'does-not-exist-yet');
  _setDiscordPathsForTests(isolatedPaths({ envContent: `TRANSPORT=mock\nFORGE_PROJECTS_DIR=${missing}\n` }));
  const status = getProjectsDirStatus();
  assert.equal(status.dir, missing);
  assert.equal(status.source, 'setting');
  assert.equal(status.exists, false);
  assert.equal(status.projectCount, null);
});

/* --------------------------------------------------------- setProjectsDirSetting() */

test('setProjectsDirSetting(): missing dir is rejected with 400, never writes .env', async () => {
  const before = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  const result = await setProjectsDirSetting({});
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), before);
});

test('setProjectsDirSetting(): a relative path is rejected with 400', async () => {
  const result = await setProjectsDirSetting({ dir: 'relative/path' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /absolute/);
});

test('setProjectsDirSetting(): a drive root is refused, never written', async () => {
  const root = path.parse(homeDir).root; // e.g. "C:\\" on win32, "/" on POSIX
  const before = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  const result = await setProjectsDirSetting({ dir: root });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /whole drive/);
  assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), before);
});

test('setProjectsDirSetting(): the (stand-in) user profile root itself is refused, never written', async () => {
  const before = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  const result = await setProjectsDirSetting({ dir: homeDir });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /user profile folder/);
  assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), before);
});

test('setProjectsDirSetting(): a real Windows system folder (WINDIR/SystemRoot) is refused on win32', { skip: process.platform !== 'win32' }, async () => {
  const winDir = process.env.WINDIR || process.env.SystemRoot;
  assert.ok(winDir, 'this machine must report WINDIR/SystemRoot to run this test');
  const result = await setProjectsDirSetting({ dir: winDir });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /Windows system folder/);
});

test('setProjectsDirSetting(): a non-existent folder without create is refused with 404, never made', async () => {
  const target = path.join(homeDir, 'not-there-yet');
  const result = await setProjectsDirSetting({ dir: target });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(fs.existsSync(target), false);
});

test('setProjectsDirSetting(): create:true OUTSIDE the (stand-in) home folder is refused, and the folder is never created', async () => {
  const outsideHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discord-projdir-outside-'));
  try {
    const target = path.join(outsideHome, 'brand-new');
    const result = await setProjectsDirSetting({ dir: target, create: true });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /only be created inside your own user folder/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(outsideHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('setProjectsDirSetting(): create:true INSIDE the (stand-in) home folder really creates it, then saves it', async () => {
  const target = path.join(homeDir, 'Documents', 'ForgeProjects');
  assert.equal(fs.existsSync(target), false, 'precondition: not there yet');
  const result = await setProjectsDirSetting({ dir: target, create: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.dir, target);
  assert.equal(fs.existsSync(target), true);
  assert.ok(fs.statSync(target).isDirectory());
  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.ok(envAfter.includes(`FORGE_PROJECTS_DIR=${target}`));
});

test('setProjectsDirSetting(): an existing folder, path exists but is not a folder -> refused with 400', async () => {
  const filePath = path.join(homeDir, 'a-plain-file.txt');
  fs.writeFileSync(filePath, 'not a folder', 'utf8');
  const result = await setProjectsDirSetting({ dir: filePath });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /not a folder/);
});

test('setProjectsDirSetting(): saves via the SAME atomic env writer (only FORGE_PROJECTS_DIR changes; every other line untouched)', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=discord\n# a comment\nDISCORD_GUILD_ID=123456789012345678\n' }));
  const target = path.join(homeDir, 'ExistingProjects');
  fs.mkdirSync(target, { recursive: true });

  const result = await setProjectsDirSetting({ dir: target });
  assert.equal(result.ok, true);
  assert.equal(result.restarted, false, 'the bot is not tracked as running in this test');
  assert.equal(result.pid, null);

  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.match(envAfter, /^TRANSPORT=discord$/m);
  assert.match(envAfter, /^# a comment$/m);
  assert.match(envAfter, /^DISCORD_GUILD_ID=123456789012345678$/m);
  assert.match(envAfter, new RegExp('^FORGE_PROJECTS_DIR=' + target.replace(/[\\.]/g, '\\$&') + '$', 'm'));
});

test('setProjectsDirSetting(): when the bot IS running, it is restarted so the new folder takes effect (restarted:true, a fresh pid)', async () => {
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });
  let spawnCalls = 0;
  _setSpawnFnForTests(() => {
    spawnCalls += 1;
    return makeFakeChild(4100 + spawnCalls);
  });
  // The restart cycle calls stopDiscordService() internally — inject the kill function (same
  // precedent as discord-service.test.mjs's own "stop() kills exactly the tracked pid" test) so
  // this never reaches the REAL taskkill/process.kill against a fabricated pid.
  _setKillFnForTests(() => {});

  // Bring a tracked "running" instance up first, exactly like the real feature would encounter.
  const started = await startDiscordService();
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(spawnCalls, 1);

  const target = path.join(homeDir, 'NewProjects');
  fs.mkdirSync(target, { recursive: true });
  const result = await setProjectsDirSetting({ dir: target });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.restarted, true);
  assert.equal(spawnCalls, 2, 'stop + start again means a SECOND real spawn call');
  assert.equal(result.pid, 4102);
});

/* ================================================================================================
 * Codex run B (2026-09-28) — F-01 (network/device paths + links), F-02 (create:true containment),
 * F-03 (.env injection), F-04 (unbounded GET scan)
 * ============================================================================================== */

/* ---------------------------------------------------- F-01: network/device paths + link targets */

test('getProjectsDirStatus(): a persisted UNC setting is never probed — exists:false, projectCount:null, without ever calling fs.statSync/fs.opendirSync', () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=mock\nFORGE_PROJECTS_DIR=\\\\attacker\\share\n' }));
  const originalStatSync = fs.statSync;
  const originalOpendirSync = fs.opendirSync;
  fs.statSync = () => {
    throw new Error('getProjectsDirStatus must never call fs.statSync for a network/device setting');
  };
  fs.opendirSync = () => {
    throw new Error('getProjectsDirStatus must never call fs.opendirSync for a network/device setting');
  };
  try {
    const status = getProjectsDirStatus();
    assert.equal(status.dir, '\\\\attacker\\share');
    assert.equal(status.source, 'setting');
    assert.equal(status.exists, false);
    assert.equal(status.projectCount, null);
  } finally {
    fs.statSync = originalStatSync;
    fs.opendirSync = originalOpendirSync;
  }
});

test('getProjectsDirStatus(): a persisted setting that is a real, local junction still resolves and counts correctly (ordinary case keeps working)', (t) => {
  const realTarget = path.join(homeDir, 'RealProjectsTarget');
  fs.mkdirSync(path.join(realTarget, 'p1'), { recursive: true });
  fs.mkdirSync(path.join(realTarget, 'p2'), { recursive: true });
  const linkDir = path.join(homeDir, 'LinkedProjects');
  try {
    fs.symlinkSync(realTarget, linkDir, 'junction');
  } catch {
    t.skip('junction could not be created in this sandbox');
    return;
  }
  _setDiscordPathsForTests(isolatedPaths({ envContent: `TRANSPORT=mock\nFORGE_PROJECTS_DIR=${linkDir}\n` }));
  const status = getProjectsDirStatus();
  assert.equal(status.dir, linkDir, 'reports the SAVED setting text, same as before this fix');
  assert.equal(status.exists, true);
  assert.equal(status.projectCount, 2);
});

test('setProjectsDirSetting(): a literal UNC dir is refused with 400, never written', async () => {
  const before = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  const result = await setProjectsDirSetting({ dir: '\\\\attacker\\share\\projects' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /network and device paths/);
  assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), before);
});

test('setProjectsDirSetting(): a dir reached through a link whose recorded target is (simulated as) a network path is refused, never written (real junctions cannot carry a UNC target on this platform — see paths-safety.test.mjs)', async (t) => {
  const realTarget = path.join(homeDir, 'RealTargetForLink');
  fs.mkdirSync(realTarget, { recursive: true });
  const linkDir = path.join(homeDir, 'LinkToSimulatedUnc');
  try {
    fs.symlinkSync(realTarget, linkDir, 'junction');
  } catch {
    t.skip('junction could not be created in this sandbox');
    return;
  }
  const linkDirResolved = path.resolve(linkDir);
  const originalReadlinkSync = fs.readlinkSync;
  fs.readlinkSync = (p) => (path.resolve(p) === linkDirResolved ? '\\\\attacker\\share' : originalReadlinkSync(p));
  try {
    const before = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
    const result = await setProjectsDirSetting({ dir: linkDir });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /not allowed/);
    assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), before);
  } finally {
    fs.readlinkSync = originalReadlinkSync;
  }
});

/* --------------------------------------------------------- F-02: create:true stays inside home */

test('setProjectsDirSetting(): create:true through a symlink/junction that escapes home is refused, and nothing is ever created outside home', async (t) => {
  const outsideHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discord-projdir-f02-outside-'));
  try {
    const linkDir = path.join(homeDir, 'link-out');
    try {
      fs.symlinkSync(outsideHome, linkDir, 'junction');
    } catch {
      t.skip('junction could not be created in this sandbox');
      return;
    }
    const target = path.join(linkDir, 'new-project-folder');
    const result = await setProjectsDirSetting({ dir: target, create: true });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /only be created inside your own user folder/);
    assert.equal(
      fs.existsSync(path.join(outsideHome, 'new-project-folder')),
      false,
      'the lexical "inside home" check must not be fooled by a link — nothing may ever be created outside home',
    );
  } finally {
    fs.rmSync(outsideHome, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('setProjectsDirSetting(): create:true creates MULTIPLE missing nested levels at once (regression — the old recursive mkdir supported this too)', async () => {
  const target = path.join(homeDir, 'A', 'B', 'C');
  assert.equal(fs.existsSync(path.join(homeDir, 'A')), false, 'precondition: nothing exists yet');
  const result = await setProjectsDirSetting({ dir: target, create: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.existsSync(target), true);
  assert.ok(fs.statSync(target).isDirectory());
  assert.ok(fs.statSync(path.join(homeDir, 'A')).isDirectory());
  assert.ok(fs.statSync(path.join(homeDir, 'A', 'B')).isDirectory());
});

/* ------------------------------------------------------------------ F-03: .env value injection */

test('_mergeEnvTextForTests(): an ordinary value with no special characters is written bare, byte-identical to before this fix', () => {
  const merged = _mergeEnvTextForTests('TRANSPORT=mock\n', { FORGE_PROJECTS_DIR: 'C:\\Users\\me\\Documents\\ForgeProjects' });
  assert.match(merged, /^FORGE_PROJECTS_DIR=C:\\Users\\me\\Documents\\ForgeProjects$/m);
});

test("_mergeEnvTextForTests() + the bot's REAL parser (discord/src/config.js loadConfig): a newline-injection attempt stays on ONE line on disk, round-trips to the EXACT original value, and adds no extra key", () => {
  const injectionAttempt = 'C:\\Users\\me\\evil\nRUNNER=claude';
  const merged = _mergeEnvTextForTests('TRANSPORT=mock\n', { FORGE_PROJECTS_DIR: injectionAttempt });
  // The on-disk text must stay ONE line for this key — a real newline byte here would BE the
  // injection succeeding, regardless of what any parser later does with it.
  assert.equal(merged.split('\n').filter((l) => l.startsWith('FORGE_PROJECTS_DIR')).length, 1);
  assert.equal(merged.split('\n').filter((l) => l.startsWith('RUNNER')).length, 0, 'no injected key on disk either');

  const envTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discord-config-roundtrip-'));
  try {
    fs.writeFileSync(path.join(envTestDir, '.env'), merged, 'utf8');
    const config = loadConfig({ env: {}, cwd: envTestDir });
    assert.equal(config.projectsDir, injectionAttempt, 'the exact original value, newline included, must come back unchanged');
    assert.equal(config.runner, 'fake', "no RUNNER key was injected — 'fake' is loadConfig's own untouched default");
  } finally {
    fs.rmSync(envTestDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});

test('setProjectsDirSetting(): a dir containing a newline is refused with 400 — the PRIMARY defence, before the value can ever reach the .env writer', async () => {
  const before = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  const result = await setProjectsDirSetting({ dir: path.join(homeDir, 'evil') + '\nRUNNER=claude' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /not allowed/);
  assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), before);
});

/* --------------------------------------------------------- F-04: bounded GET scan (project count) */

test('getProjectsDirStatus(): the project-count scan stops at the injected budget and reports projectCountTruncated:true', () => {
  const target = path.join(homeDir, 'BigProjectsDir');
  for (let i = 0; i < 12; i++) {
    fs.mkdirSync(path.join(target, 'p' + String(i).padStart(2, '0')), { recursive: true });
  }
  _setDiscordPathsForTests(isolatedPaths({ envContent: `TRANSPORT=mock\nFORGE_PROJECTS_DIR=${target}\n` }));
  _setProjectCountScanBudgetForTests(5);
  try {
    const status = getProjectsDirStatus();
    assert.equal(status.exists, true);
    assert.equal(status.projectCountTruncated, true);
    assert.ok(status.projectCount <= 5, `expected at most 5 counted, got ${status.projectCount}`);
  } finally {
    _resetProjectCountScanBudgetForTests();
  }
});

test('getProjectsDirStatus(): under the scan budget, projectCountTruncated stays false (no false alarm)', () => {
  const target = path.join(homeDir, 'SmallProjectsDir');
  for (let i = 0; i < 3; i++) {
    fs.mkdirSync(path.join(target, 'p' + i), { recursive: true });
  }
  _setDiscordPathsForTests(isolatedPaths({ envContent: `TRANSPORT=mock\nFORGE_PROJECTS_DIR=${target}\n` }));
  _setProjectCountScanBudgetForTests(5);
  try {
    const status = getProjectsDirStatus();
    assert.equal(status.exists, true);
    assert.equal(status.projectCount, 3);
    assert.equal(status.projectCountTruncated, false);
  } finally {
    _resetProjectCountScanBudgetForTests();
  }
});
