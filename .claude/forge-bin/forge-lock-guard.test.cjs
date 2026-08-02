#!/usr/bin/env node
'use strict';
// forge-lock-guard.test.cjs — tests the mechanical hotspot write-lock (2026-07-24). Hermetic: every case
// uses an isolated temp dir (opts.dir) + an injected clock (opts.now) so nothing touches the real lock dir
// and TTL/expiry is deterministic (no real waiting).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lg = require('./forge-lock-guard.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

// fresh isolated lock dir per case
let seq = 0;
function tmpDir() { const d = path.join(os.tmpdir(), 'forge-lock-test-' + process.pid + '-' + (seq++)); try { fs.rmSync(d, { recursive: true, force: true }); } catch {} return d; }
const T0 = 1000000; // fixed base clock
const HOT = '.claude/forge-bin/forge-sync.cjs';

console.log('forge-lock-guard tests');

t('acquire on a free hotspot succeeds and records the run', () => {
  const dir = tmpDir();
  const r = lg.acquire({ hotspot: HOT, runId: 'run-A', owner: 'boss-1' }, { dir, now: T0 });
  assert.ok(r.ok, 'expected ok');
  assert.strictEqual(r.lock.run_id, 'run-A');
  assert.strictEqual(r.lock.owner, 'boss-1');
  assert.strictEqual(r.lock.expires_at, T0 + lg.DEFAULT_TTL_MS);
});

t('a DIFFERENT run is blocked with a conflict naming the holder + remaining time', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0, ttlMs: 10000 });
  const r = lg.acquire({ hotspot: HOT, runId: 'run-B' }, { dir, now: T0 + 3000, ttlMs: 10000 });
  assert.ok(!r.ok, 'expected conflict');
  assert.ok(r.conflict, 'expected conflict detail');
  assert.strictEqual(r.conflict.held_by_run, 'run-A');
  assert.strictEqual(r.conflict.remaining_ms, 7000);
});

t('the SAME run re-acquiring refreshes its own lock (idempotent)', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0, ttlMs: 10000 });
  const r = lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0 + 5000, ttlMs: 10000 });
  assert.ok(r.ok && r.refreshed, 'expected refreshed ok');
  assert.strictEqual(r.lock.expires_at, T0 + 5000 + 10000);
});

t('check reports HELD while active, FREE after expiry', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0, ttlMs: 10000 });
  assert.strictEqual(lg.check({ hotspot: HOT }, { dir, now: T0 + 1 }).held, true);
  const after = lg.check({ hotspot: HOT }, { dir, now: T0 + 10000 });
  assert.strictEqual(after.held, false);
  assert.strictEqual(after.expired, true);
});

t('release by a NON-owner is denied; by the owner it succeeds', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0 });
  const denied = lg.release({ hotspot: HOT, runId: 'run-B' }, { dir });
  assert.ok(!denied.ok, 'non-owner release must be denied');
  const ok = lg.release({ hotspot: HOT, runId: 'run-A' }, { dir });
  assert.ok(ok.ok && ok.released, 'owner release must succeed');
  assert.strictEqual(lg.check({ hotspot: HOT }, { dir, now: T0 + 1 }).held, false);
});

t('an EXPIRED lock is stolen by a new run (crash self-heal)', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0, ttlMs: 5000 });
  const r = lg.acquire({ hotspot: HOT, runId: 'run-B' }, { dir, now: T0 + 6000, ttlMs: 5000 });
  assert.ok(r.ok, 'expected steal to succeed');
  assert.strictEqual(r.stolenFromExpired, 'run-A');
  assert.strictEqual(lg.check({ hotspot: HOT }, { dir, now: T0 + 6001 }).lock.run_id, 'run-B');
});

t('heldLocks projects all lock files and flags expired ones', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: 'a/one.cjs', runId: 'run-A' }, { dir, now: T0, ttlMs: 10000 });
  lg.acquire({ hotspot: 'b/two.cjs', runId: 'run-B' }, { dir, now: T0, ttlMs: 1000 });
  const held = lg.heldLocks({ dir, now: T0 + 2000 });
  assert.strictEqual(held.length, 2);
  const expiredCount = held.filter((h) => h.expired).length;
  assert.strictEqual(expiredCount, 1, 'exactly one should be expired');
});

t('reapStale deletes ONLY expired locks', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: 'a/one.cjs', runId: 'run-A' }, { dir, now: T0, ttlMs: 10000 });
  lg.acquire({ hotspot: 'b/two.cjs', runId: 'run-B' }, { dir, now: T0, ttlMs: 1000 });
  const r = lg.reapStale({ dir, now: T0 + 2000 });
  assert.strictEqual(r.reaped, 1);
  assert.strictEqual(lg.heldLocks({ dir, now: T0 + 2000 }).length, 1, 'active lock survives reap');
});

t('hotspot normalization is case/separator/trailing-slash insensitive (same key)', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: 'A\\B\\Core.CJS', runId: 'run-A' }, { dir, now: T0 });
  // a different textual form of the same path must see the existing lock and conflict
  const r = lg.acquire({ hotspot: 'a/b/core.cjs/', runId: 'run-B' }, { dir, now: T0 + 1 });
  assert.ok(!r.ok, 'normalized-equal hotspots must collide');
  assert.strictEqual(lg.keyOf('A\\B\\Core.CJS'), lg.keyOf('a/b/core.cjs/'));
});

t('acquire without hotspot or runId fails cleanly (no throw)', () => {
  assert.strictEqual(lg.acquire({ runId: 'x' }, { dir: tmpDir() }).ok, false);
  assert.strictEqual(lg.acquire({ hotspot: HOT }, { dir: tmpDir() }).ok, false);
});

// cleanup any temp dirs this run created
for (let i = 0; i < seq; i++) { try { fs.rmSync(path.join(os.tmpdir(), 'forge-lock-test-' + process.pid + '-' + i), { recursive: true, force: true }); } catch {} }

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
