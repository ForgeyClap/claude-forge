#!/usr/bin/env node
'use strict';
// forge-memory.test.cjs — tests typed lessons, redaction-on-write, top-K recall, and the safety-net scan.
// Uses a throwaway temp root so it never writes into the real agent-memory. Convention: "<N> passed, <M> failed".
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mem = require('./forge-memory.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

const ROOT = path.join(os.tmpdir(), 'forge-mem-test-' + process.pid);
function cleanup() { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} }
cleanup();

console.log('forge memory tests (typed lessons · redaction · recall · scan)');

t('addLesson strips a secret before storing (raw key absent)', () => { const rec = mem.addLesson('Build Boss', { text: 'use key nvapi-abcdef1234567890 for x', tags: ['x'] }, ROOT); assert.ok(!rec.text.includes('nvapi-abcdef1234567890'), 'secret leaked into memory: ' + rec.text); });
t('local scrub() redacts even without the store redactor', () => { assert.ok(!mem.scrub('token sk-ABCDEFGHIJKLMNOP1234 end').includes('sk-ABCDEFGHIJKLMNOP1234')); });
t('unknown lesson type defaults to semantic', () => assert.strictEqual(mem.addLesson('Build Boss', { text: 'plain', type: 'weird' }, ROOT).type, 'semantic'));
t('a valid typed lesson keeps its type', () => assert.strictEqual(mem.addLesson('Build Boss', { text: 'proc', type: 'procedural' }, ROOT).type, 'procedural'));
t('recall finds a lesson by tag/keyword', () => { mem.addLesson('Test Boss', { text: 'playwright viewport 375 for mobile', tags: ['playwright', 'mobile'] }, ROOT); const hits = mem.recall('Test Boss', 'mobile playwright', 5, ROOT); assert.ok(hits.length >= 1 && /playwright/.test(hits[0].text)); });
t('recall on an unknown boss returns []', () => assert.deepStrictEqual(mem.recall('Nobody', 'x', 5, ROOT), []));
t('scanMemory flags a secret that bypassed write-time redaction', () => { const d = mem.memDir('Rogue', ROOT); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'raw.md'), 'leaked sk-ABCDEFGHIJKLMNOP1234 here'); const r = mem.scanMemory(ROOT); assert.ok(r.ok === false && r.hits.length >= 1); });
t('scanMemory is clean when no secrets present', () => { const clean = path.join(os.tmpdir(), 'forge-mem-clean-' + process.pid); fs.mkdirSync(path.join(clean, '.claude', 'agent-memory', 'x'), { recursive: true }); fs.writeFileSync(path.join(clean, '.claude', 'agent-memory', 'x', 'l.md'), 'no secrets here'); const r = mem.scanMemory(clean); fs.rmSync(clean, { recursive: true, force: true }); assert.ok(r.ok === true); });

cleanup();
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
