// WP-v290-B (beginner Discord onboarding) — env-store.js's merge-writer: main.js's own way of
// persisting an auto-detected DISCORD_GUILD_ID/OWNER_USER_IDS so a restart never re-detects them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeEnvText, writeEnvValues, _acquireEnvLockForTests, _releaseEnvLockForTests } from '../src/env-store.js';
import { tmpStateDir } from './helpers.js';

// A real, definitely-exited pid — spawnSync blocks until the child is already gone, so by the time
// we have `pid` back, `process.kill(pid, 0)` reliably throws ESRCH (the exact "confirmed dead"
// signal the fix relies on) rather than an arbitrary large literal some platform could still
// interpret as a live/permission-denied pid.
function definitelyDeadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return result.pid;
}

function backdateMtime(filePath, ageMs) {
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, old, old);
}

test('mergeEnvText: replaces an existing key in place, preserving every other line untouched', () => {
  const raw = '# a comment\nTRANSPORT=mock\nOTHER_KEY=keep-me\n\nRUNNER=fake\n';
  const merged = mergeEnvText(raw, { TRANSPORT: 'discord' });
  assert.match(merged, /^# a comment$/m);
  assert.match(merged, /^TRANSPORT=discord$/m);
  assert.match(merged, /^OTHER_KEY=keep-me$/m);
  assert.match(merged, /^RUNNER=fake$/m);
  assert.equal(merged.includes('TRANSPORT=mock'), false, 'the old value must be gone, not just appended twice');
});

test('mergeEnvText: appends a brand-new key at the end when it was not present before', () => {
  const merged = mergeEnvText('TRANSPORT=mock\n', { DISCORD_GUILD_ID: '123' });
  assert.match(merged, /^TRANSPORT=mock$/m);
  assert.match(merged, /^DISCORD_GUILD_ID=123$/m);
});

test('mergeEnvText: an empty starting file produces a clean file with just the updates', () => {
  const merged = mergeEnvText('', { A: '1', B: '2' });
  assert.equal(merged, 'A=1\nB=2\n');
});

test('mergeEnvText: comment lines and blank lines are never mistaken for a key', () => {
  const merged = mergeEnvText('# TRANSPORT=should-not-match\n\nTRANSPORT=mock\n', { TRANSPORT: 'discord' });
  assert.match(merged, /^# TRANSPORT=should-not-match$/m, 'a commented-out line must never be treated as the real key');
  assert.match(merged, /^TRANSPORT=discord$/m);
});

test('mergeEnvText: multiple updates in one call all land correctly', () => {
  const merged = mergeEnvText('TRANSPORT=mock\nDISCORD_GUILD_ID=\n', {
    TRANSPORT: 'discord',
    DISCORD_GUILD_ID: '999',
    OWNER_USER_IDS: '111,222',
  });
  assert.match(merged, /^TRANSPORT=discord$/m);
  assert.match(merged, /^DISCORD_GUILD_ID=999$/m);
  assert.match(merged, /^OWNER_USER_IDS=111,222$/m);
});

test('writeEnvValues: creates the file when it does not exist yet', () => {
  const dir = tmpStateDir();
  writeEnvValues(dir, { TRANSPORT: 'discord', DISCORD_BOT_TOKEN: 'placeholder' });
  const content = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(content, /^TRANSPORT=discord$/m);
  assert.match(content, /^DISCORD_BOT_TOKEN=placeholder$/m);
});

test('writeEnvValues: merges into a real existing file on disk, preserving unrelated real content', () => {
  const dir = tmpStateDir();
  fs.writeFileSync(path.join(dir, '.env'), '# keep this comment\nTRANSPORT=mock\nRUNNER=fake\n', 'utf8');
  writeEnvValues(dir, { DISCORD_GUILD_ID: '123456789012345678' });
  const content = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(content, /^# keep this comment$/m);
  assert.match(content, /^TRANSPORT=mock$/m);
  assert.match(content, /^RUNNER=fake$/m);
  assert.match(content, /^DISCORD_GUILD_ID=123456789012345678$/m);
});

test('writeEnvValues: a custom envFile name is respected (never hardcoded to .env only)', () => {
  const dir = tmpStateDir();
  writeEnvValues(dir, { A: '1' }, '.env.custom');
  assert.equal(fs.existsSync(path.join(dir, '.env')), false);
  const content = fs.readFileSync(path.join(dir, '.env.custom'), 'utf8');
  assert.match(content, /^A=1$/m);
});

test('SECURITY Codex K3-5: a crash between the temp-file write and the rename leaves the original .env completely intact', () => {
  const dir = tmpStateDir();
  const target = path.join(dir, '.env');
  fs.writeFileSync(target, '# keep this comment\nTRANSPORT=mock\nOWNER_USER_IDS=owner1\n', 'utf8');
  const originalContent = fs.readFileSync(target, 'utf8');

  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('simulated crash between the temp-file write and the rename');
  };
  try {
    assert.throws(() => writeEnvValues(dir, { DISCORD_GUILD_ID: '123456789012345678' }));
  } finally {
    fs.renameSync = originalRename;
  }

  const afterCrash = fs.readFileSync(target, 'utf8');
  assert.equal(afterCrash, originalContent, '.env must be exactly what it was before the simulated crash — never truncated, never partial');
  assert.equal(fs.existsSync(target + '.lock'), false, 'the lock must be released even when the write fails');

  // No leftover temp file either — a crash must never leave debris behind in the real directory.
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);

  // The failed attempt must not have wedged anything — a real write right after must still succeed.
  writeEnvValues(dir, { DISCORD_GUILD_ID: '123456789012345678' });
  const finalContent = fs.readFileSync(target, 'utf8');
  assert.match(finalContent, /^# keep this comment$/m);
  assert.match(finalContent, /^OWNER_USER_IDS=owner1$/m, 'unrelated pre-existing content must survive the whole sequence');
  assert.match(finalContent, /^DISCORD_GUILD_ID=123456789012345678$/m);
});

test('SECURITY Codex K3-5: a write held by a stale (crashed) lock file is not blocked forever', () => {
  const dir = tmpStateDir();
  const target = path.join(dir, '.env');
  fs.writeFileSync(target, 'TRANSPORT=mock\n', 'utf8');
  const lockPath = target + '.lock';
  fs.writeFileSync(lockPath, '999999', 'utf8');
  // Back-date the lock's mtime well past the staleness window, simulating a process that crashed
  // while holding it rather than one that is genuinely still writing right now.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);

  writeEnvValues(dir, { A: '1' });
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /^TRANSPORT=mock$/m);
  assert.match(content, /^A=1$/m);
  assert.equal(fs.existsSync(lockPath), false, 'the reclaimed-then-reacquired lock must be released again after the write');
});

// ── WP-L2 finding 5/N3/N4: OWNERSHIP-AWARE .env lock ────────────────────────────────────────────
// Same fix, same direct test-only seam as gateway/src/discord-service.mjs's own mirrored copy.
test('WP-L2 finding 5/N3: a directory sitting at the lock path gives a bounded, clear error — never an unbounded spin', () => {
  const dir = tmpStateDir();
  const target = path.join(dir, '.env');
  const lockPath = target + '.lock';
  fs.mkdirSync(lockPath); // the exact "cannot be removed" shape Codex named
  backdateMtime(lockPath, 60_000); // well past ENV_LOCK_STALE_MS so the reclaim path is exercised, not just the plain wait

  const startedAt = Date.now();
  assert.throws(() => _acquireEnvLockForTests(target), /timed out|could not remove/i);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 4000, `must fail bounded by ENV_LOCK_TIMEOUT_MS, not hang — took ${elapsedMs}ms`);
  assert.equal(fs.existsSync(lockPath), true, 'an un-removable directory is left in place, never partially destroyed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WP-L2 finding 5: a lock whose owner pid is genuinely still ALIVE is never stolen, even long past the staleness window', () => {
  const dir = tmpStateDir();
  const target = path.join(dir, '.env');
  const lockPath = target + '.lock';
  const originalContent = JSON.stringify({ owner: 'the-original-live-owner', pid: process.pid, ts: Date.now() - 60_000 });
  fs.writeFileSync(lockPath, originalContent, 'utf8');
  backdateMtime(lockPath, 60_000); // far past ENV_LOCK_STALE_MS

  const startedAt = Date.now();
  assert.throws(
    () => _acquireEnvLockForTests(target),
    /timed out waiting for the lock/,
    'a live owner must make this a real, honest timeout — never a silent steal',
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 4000, `must still be bounded by ENV_LOCK_TIMEOUT_MS — took ${elapsedMs}ms`);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), originalContent, "the live owner's lock content must be completely untouched — never stolen");
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WP-L2 finding 5: a stale lock whose owner pid is confirmed DEAD is reclaimed and re-acquired', () => {
  const dir = tmpStateDir();
  const target = path.join(dir, '.env');
  const lockPath = target + '.lock';
  const deadPid = definitelyDeadPid();
  fs.writeFileSync(lockPath, JSON.stringify({ owner: 'a-crashed-previous-writer', pid: deadPid, ts: Date.now() - 60_000 }), 'utf8');
  backdateMtime(lockPath, 60_000);

  const lock = _acquireEnvLockForTests(target);
  assert.equal(lock.lockPath, lockPath);
  assert.equal(typeof lock.ownerId, 'string');
  const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(holder.owner, lock.ownerId, 'the reclaimed lock must now show OUR fresh owner id, not the dead previous one');
  assert.equal(holder.pid, process.pid);
  _releaseEnvLockForTests(lock);
  assert.equal(fs.existsSync(lockPath), false, 'our own release must clean up the lock we just legitimately acquired');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('WP-L2 finding N4: release() never deletes a lock that now belongs to a DIFFERENT owner', () => {
  const dir = tmpStateDir();
  const target = path.join(dir, '.env');
  const lockPath = target + '.lock';
  const lock = _acquireEnvLockForTests(target);

  // Simulate a race: between our acquisition and our release, the lock was reclaimed by someone
  // else — the file at lockPath now genuinely belongs to a DIFFERENT owner id.
  const otherOwnerContent = JSON.stringify({ owner: 'a-completely-different-owner', pid: process.pid, ts: Date.now() });
  fs.writeFileSync(lockPath, otherOwnerContent, 'utf8');

  _releaseEnvLockForTests(lock); // using the OLD lock object — must be a no-op against the new owner
  assert.equal(fs.existsSync(lockPath), true, 'release must never delete a lock it does not currently own');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), otherOwnerContent, "the other owner's lock content must be completely untouched");
  fs.rmSync(dir, { recursive: true, force: true });
});
