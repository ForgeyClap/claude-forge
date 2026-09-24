#!/usr/bin/env node
'use strict';
// forge-memory.test.cjs — tests typed lessons, redaction-on-write, top-K recall, and the safety-net scan.
// Uses a throwaway temp root so it never writes into the real agent-memory. Convention: "<N> passed, <M> failed".
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mem = require('./forge-memory.cjs');
const { spawnSync } = require('child_process');

// Hermetic owner settings (forge-config.cjs, v2.7.0): the global settings file is read from a throwaway home,
// never ~/.claude, and FORGE_PROJECT_ROOT is cleared so each fixture ROOT decides which project file is read.
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mem-cfghome-'));
process.env.FORGE_CONFIG_HOME = CONFIG_HOME;
delete process.env.FORGE_PROJECT_ROOT;

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

// ---- owner setting agent-memory (forge-config.cjs, v2.7.0): OFF writes nothing, reads unchanged ----
function cfgRoot(label, settings) {
  const r = path.join(ROOT, 'cfg-' + label);
  fs.mkdirSync(path.join(r, '.claude'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(r, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings }));
  return r;
}
t('agent-memory=false -> addLesson returns {skipped, reason} and writes NOTHING', () => {
  const r = cfgRoot('off', { 'agent-memory': { value: false } });
  const out = mem.addLesson('Build Boss', { text: 'should never be stored', tags: ['x'] }, r);
  assert.deepStrictEqual(out, { skipped: true, reason: 'owner config agent-memory=off' });
  assert.ok(!fs.existsSync(path.join(r, '.claude', 'agent-memory')), 'agent-memory dir was created');
});
t('agent-memory=false leaves existing memory readable (recall/list unchanged)', () => {
  const r = cfgRoot('off-read');
  mem.addLesson('Test Boss', { text: 'viewport 375 lesson', tags: ['viewport'] }, r);
  fs.writeFileSync(path.join(r, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { 'agent-memory': { value: false } } }));
  assert.strictEqual(mem.addLesson('Test Boss', { text: 'second lesson' }, r).skipped, true);
  assert.strictEqual(mem.listLessons('Test Boss', r).length, 1);
  assert.strictEqual(mem.recall('Test Boss', 'viewport', 5, r).length, 1);
});
t('agent-memory=true -> unchanged: the lesson is stored', () => {
  const r = cfgRoot('on', { 'agent-memory': { value: true } });
  const rec = mem.addLesson('Build Boss', { text: 'stored lesson' }, r);
  assert.ok(rec.id && !rec.skipped);
  assert.strictEqual(mem.listLessons('Build Boss', r).length, 1);
});
t('config module absent (null) or throwing -> schema default ON, even when a file says OFF', () => {
  for (const configModule of [null, { get() { throw new Error('boom'); } }]) {
    const r = cfgRoot('absent-' + (configModule ? 'throw' : 'null'), { 'agent-memory': { value: false } });
    const rec = mem.addLesson('Build Boss', { text: 'fallback lesson' }, r, { configModule });
    assert.ok(rec.id && !rec.skipped);
  }
});
t('M3: a malformed FORGE_CONFIG.json -> the lesson is stored (no data flag) and the RETURNED record names the damage; the stored line does not', () => {
  const r = cfgRoot('badcfg');
  fs.writeFileSync(path.join(r, '.claude', 'FORGE_CONFIG.json'), '{ not json');
  const rec = mem.addLesson('Build Boss', { text: 'lesson under a damaged settings file' }, r);
  assert.ok(rec.id && !rec.skipped);
  assert.ok(/damaged/.test(rec.config_note || ''), 'config_note: ' + rec.config_note);
  const stored = mem.listLessons('Build Boss', r);
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(stored[0], 'config_note'), false);
});
t('configOn ignores a wrong-typed value and honours a real boolean', () => {
  assert.strictEqual(mem.configOn('agent-memory', true, { configModule: { get: () => ({ value: 'off' }) } }), true);
  assert.strictEqual(mem.configOn('agent-memory', true, { configModule: { get: () => ({ value: false }) } }), false);
});
t('CLI add with agent-memory=false (FORGE_PROJECT_ROOT fixture) -> "SKIPPED (config)", exit 3, nothing written', () => {
  const r = cfgRoot('cli-off', { 'agent-memory': { value: false } });
  const res = spawnSync(process.execPath, [path.join(__dirname, 'forge-memory.cjs'), 'build-boss', 'add', 'cli lesson'], {
    encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: r }),
  });
  assert.strictEqual(res.status, 3, 'exit ' + res.status + ' ' + res.stderr);
  assert.ok(/^SKIPPED \(config\) — owner config agent-memory=off/.test(res.stdout), res.stdout);
  assert.ok(!fs.existsSync(path.join(r, '.claude', 'agent-memory')));
});

cleanup();
try { fs.rmSync(CONFIG_HOME, { recursive: true, force: true }); } catch {}
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
