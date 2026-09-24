#!/usr/bin/env node
'use strict';
/**
 * forge-config-once.test.cjs — real tests for the cross-process file lock's OWNERSHIP hardening (V09, Codex
 * recheck 2026-09-24: "Reclamation uses age alone; release unconditionally unlinks the pathname. Controlled-
 * clock execution showed live A's lock stolen after 16 seconds, A's release deleting B's replacement, then C
 * acquiring concurrently"). HERMETIC: every lock lives under a throwaway os.tmpdir() directory; nothing here
 * touches the real project or ~/.claude. The clock is controlled the same way this codebase's own CFG-09
 * tests already do (fs.utimesSync backdating a lock file's mtime), not real sleeps/timers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const once = require('./forge-config-once.cjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function tmpTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-once-'));
  return path.join(dir, 'FORGE_CONFIG.json'); // the lock lives at <this>.lock; the target file itself need not exist
}
function backdate(lockPath, ageMs) {
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, old, old);
}

console.log('forge-config-once.test.cjs — lock ownership (V09)');

// ---------------------------------------------------------------------------------------------------
console.log('\n1) randomToken / basic acquire-release round trip');
t('randomToken() embeds this process pid and is different on every call', () => {
  const a = once.randomToken();
  const b = once.randomToken();
  assert.ok(a.startsWith(process.pid + ':'), a);
  assert.notStrictEqual(a, b);
});
t('acquireLock returns {path, token}; the lock file holds that exact token; releaseLock removes it', () => {
  const file = tmpTarget();
  const lock = once.acquireLock(file);
  assert.strictEqual(lock.path, file + '.lock');
  assert.strictEqual(fs.readFileSync(lock.path, 'utf8'), lock.token);
  once.releaseLock(lock);
  assert.strictEqual(fs.existsSync(lock.path), false);
});
t('a second acquire on an UNHELD file after release gets a brand-new token', () => {
  const file = tmpTarget();
  const l1 = once.acquireLock(file);
  once.releaseLock(l1);
  const l2 = once.acquireLock(file);
  assert.notStrictEqual(l1.token, l2.token);
  once.releaseLock(l2);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n2) a live (non-stale) lock blocks a second acquirer (lock_busy), never silently reclaimed early');
t('acquireLock on an actively-held, fresh lock throws lock_busy after opts.timeoutMs — the holder is untouched', () => {
  const file = tmpTarget();
  const holder = once.acquireLock(file, { staleMs: 60000 });
  let err = null;
  try { once.acquireLock(file, { staleMs: 60000, timeoutMs: 100, pollMs: 5 }); }
  catch (e) { err = e; }
  assert.ok(err && err.code === 'lock_busy', err && err.message);
  assert.strictEqual(fs.readFileSync(holder.path, 'utf8'), holder.token, 'the original holder is still the lock owner');
  once.releaseLock(holder);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n3) V09 — the exact Codex-measured transition: A suspended past staleMs, B reclaims, A resumes and');
console.log('   releases, B\'s lock survives, and C cannot acquire concurrently');
t('V09: full sequence — reclaim by token+mtime ownership, a stale release is a no-op, and B stays exclusive', () => {
  const file = tmpTarget();
  // 1. A acquires (simulating a live holder).
  const lockA = once.acquireLock(file, { staleMs: 1000 });
  // 2. "A is suspended" — backdate the SAME lock file well past staleMs (the codebase's own established
  //    controlled-clock technique; no real sleep/timers needed).
  backdate(lockA.path, 5000);
  // 3. B comes along and reclaims it (age > staleMs, and the token/mtime it inspects still matches A's).
  const lockB = once.acquireLock(file, { staleMs: 1000, timeoutMs: 2000, pollMs: 5 });
  assert.notStrictEqual(lockB.token, lockA.token, 'B holds a DIFFERENT token than A ever had');
  assert.strictEqual(fs.readFileSync(file + '.lock', 'utf8'), lockB.token, 'the lock file now holds B\'s token');
  // 4. "A resumes" (it still only knows its OWN original lock object) and releases.
  once.releaseLock(lockA);
  // B's replacement lock must survive A's stale release completely untouched.
  assert.strictEqual(fs.existsSync(file + '.lock'), true, 'B\'s lock file still exists after A\'s (stale) release');
  assert.strictEqual(fs.readFileSync(file + '.lock', 'utf8'), lockB.token, 'B\'s token is unchanged — A\'s release did not touch it');
  // 5. C tries to acquire concurrently while B still legitimately holds a FRESH (just-reclaimed) lock.
  let cErr = null;
  try { once.acquireLock(file, { staleMs: 1000, timeoutMs: 150, pollMs: 5 }); }
  catch (e) { cErr = e; }
  assert.ok(cErr && cErr.code === 'lock_busy', 'C must be refused — B\'s fresh lock is not stale yet');
  // 6. B releases normally; the lock is now genuinely free.
  once.releaseLock(lockB);
  assert.strictEqual(fs.existsSync(file + '.lock'), false);
  const lockD = once.acquireLock(file, { staleMs: 1000 });
  assert.ok(lockD.token, 'a fresh acquire succeeds once the lock is genuinely free');
  once.releaseLock(lockD);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n4) tryReclaimStaleLock — direct unit coverage of the compare-then-replace-then-verify sequence');
t('a mismatched expected TOKEN (someone already changed it) refuses to reclaim and leaves the file untouched', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  fs.writeFileSync(lockPath, 'real-current-token');
  const st = fs.statSync(lockPath);
  const ok = once.tryReclaimStaleLock(lockPath, 'stale-snapshot-token-that-is-wrong', st.mtimeMs, once.randomToken());
  assert.strictEqual(ok, false);
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), 'real-current-token', 'untouched — reclaim never happened');
});
t('a mismatched expected MTIME (the lock was touched/replaced since the snapshot) refuses to reclaim', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  fs.writeFileSync(lockPath, 'tok');
  const st = fs.statSync(lockPath);
  const ok = once.tryReclaimStaleLock(lockPath, 'tok', st.mtimeMs - 999999, once.randomToken());
  assert.strictEqual(ok, false);
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), 'tok');
});
t('a matching token+mtime snapshot succeeds and the file now holds the NEW token', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  fs.writeFileSync(lockPath, 'old-token');
  const st = fs.statSync(lockPath);
  const newToken = once.randomToken();
  const ok = once.tryReclaimStaleLock(lockPath, 'old-token', st.mtimeMs, newToken);
  assert.strictEqual(ok, true);
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), newToken);
  // no leftover .reclaim.* temp file
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.reclaim.'));
  assert.deepStrictEqual(leftovers, [], leftovers.join(','));
});
t('a lock that vanished entirely between inspection and reclaim (already released) refuses cleanly, no throw', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  fs.writeFileSync(lockPath, 'tok');
  const st = fs.statSync(lockPath);
  fs.unlinkSync(lockPath); // simulate a legitimate release that happened in between
  const ok = once.tryReclaimStaleLock(lockPath, 'tok', st.mtimeMs, once.randomToken());
  assert.strictEqual(ok, false);
  assert.strictEqual(fs.existsSync(lockPath), false);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n5) releaseLock is defensive and never throws');
t('releaseLock(null) / releaseLock(undefined) / releaseLock({}) never throw', () => {
  once.releaseLock(null);
  once.releaseLock(undefined);
  once.releaseLock({});
  assert.ok(true);
});
t('releaseLock on an already-vanished lock file never throws', () => {
  const file = tmpTarget();
  const lock = once.acquireLock(file);
  fs.unlinkSync(lock.path);
  once.releaseLock(lock); // must not throw even though the file is already gone
  assert.ok(true);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n6) withLock: acquires, runs fn, always releases (even on throw), and fn sees the lock held');
t('withLock releases on a normal return and on a thrown error alike; the lock never leaks', () => {
  const file = tmpTarget();
  once.withLock(file, () => {
    assert.strictEqual(fs.existsSync(file + '.lock'), true, 'the lock is held while fn runs');
  });
  assert.strictEqual(fs.existsSync(file + '.lock'), false, 'released after a normal return');
  assert.throws(() => once.withLock(file, () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(fs.existsSync(file + '.lock'), false, 'released even after fn threw');
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
