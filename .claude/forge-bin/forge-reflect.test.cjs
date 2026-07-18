#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-reflect.cjs. Hermetic like forge-distill.test.cjs: every case gets
 *  its own subdirectory under one os.tmpdir() root with a fake .claude/{config/agents/agent-registry.json,
 *  agent-memory/}. The CLI is exercised for real via spawnSync (never required directly for the assertions
 *  below) so exit codes and stdout/stderr are proven, not assumed. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reflect-test-'));
const REFLECT_CLI = path.join(__dirname, 'forge-reflect.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-reflect offline tests (hermetic root=' + TMP + ')');

const REGISTRY_FIXTURE = { agents: { 'build-boss': { name: 'Build Boss' }, 'test-boss': { name: 'Test Boss' } } };

/** One isolated fixture: <TMP>/<caseName>/.claude/{config/agents/agent-registry.json, agent-memory/}. */
function makeFixture(caseName) {
  const root = path.join(TMP, caseName);
  fs.mkdirSync(path.join(root, '.claude', 'config', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'), JSON.stringify(REGISTRY_FIXTURE));
  fs.mkdirSync(path.join(root, '.claude', 'agent-memory'), { recursive: true });
  return root;
}
function lessonsFor(root, slug) {
  try { return fs.readFileSync(path.join(root, '.claude', 'agent-memory', slug, 'lessons.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
function runCli(args, root) {
  return spawnSync(process.execPath, [REFLECT_CLI, ...args], { env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }), encoding: 'utf8' });
}

// ---- 1) add with --quote -> lesson written with evidence {source:owner-correction, quote, confidence} ----
{
  const root = makeFixture('case1');
  const r = runCli(['add', 'build-boss', '--text', 'Always use the confirm button, never Enter', '--quote', 'nee, gebruik knop X, niet enter', '--confidence', 'medium'], root);
  t('case1: CLI exits 0', r.status === 0);
  const lessons = lessonsFor(root, 'build-boss');
  t('case1: exactly 1 lesson written', lessons.length === 1);
  t('case1: default type is episodic', lessons[0] && lessons[0].type === 'episodic');
  t('case1: tagged owner-correction + forge-reflect', lessons.length === 1 && lessons[0].tags.includes('owner-correction') && lessons[0].tags.includes('forge-reflect'));
  let ev = null; try { ev = JSON.parse(lessons[0].evidence); } catch { /* fail below */ }
  t('case1: evidence source is owner-correction', !!ev && ev.source === 'owner-correction');
  t('case1: evidence carries the verbatim quote', !!ev && /gebruik knop X/.test(ev.quote));
  t('case1: evidence carries the requested confidence', !!ev && ev.confidence === 'medium');
}

// ---- 2) add WITHOUT --quote -> refused exit 2, nothing written ----
{
  const root = makeFixture('case2');
  const r = runCli(['add', 'build-boss', '--text', 'some lesson text with no evidence'], root);
  t('case2: missing --quote exits 2', r.status === 2);
  t('case2: stderr names --quote', /--quote/.test(r.stderr));
  t('case2: nothing written', lessonsFor(root, 'build-boss').length === 0);
}

// ---- 3) generic agent (orchestrator) -> refused, nothing written ----
{
  const root = makeFixture('case3');
  const r = runCli(['add', 'orchestrator', '--text', 'lesson for a generic name', '--quote', 'owner said something'], root);
  t('case3: generic agent name exits 2', r.status === 2);
  t('case3: stderr calls it out as generic/not-a-working-Boss', /generic/.test(r.stderr));
  t('case3: no memory file created for orchestrator', !fs.existsSync(path.join(root, '.claude', 'agent-memory', 'orchestrator')));
}

// ---- 4) unregistered boss -> refused with a clear error ----
{
  const root = makeFixture('case4');
  const r = runCli(['add', 'nonexistent-boss', '--text', 'lesson text', '--quote', 'owner correction quote'], root);
  t('case4: unregistered boss exits 2', r.status === 2);
  t('case4: stderr says unregistered', /unregistered/.test(r.stderr));
  t('case4: nothing written', lessonsFor(root, 'nonexistent-boss').length === 0);
}

// ---- 5) duplicate text -> skipped, exit 0, count unchanged ----
{
  const root = makeFixture('case5');
  const first = runCli(['add', 'build-boss', '--text', 'never end posts with a question', '--quote', 'never end posts with a question, owner said'], root);
  t('case5: first add exits 0', first.status === 0);
  t('case5: first add writes 1 lesson', lessonsFor(root, 'build-boss').length === 1);
  const second = runCli(['add', 'build-boss', '--text', 'never end posts with a question', '--quote', 'said it again, still applies'], root);
  t('case5: duplicate add exits 0 (skip, not error)', second.status === 0);
  t('case5: duplicate add reports skipped', /skipped/.test(second.stdout));
  t('case5: lesson count unchanged after duplicate', lessonsFor(root, 'build-boss').length === 1);
}

// ---- 6) secret in quote -> persisted lesson is redacted, never the raw secret ----
{
  const root = makeFixture('case6');
  const secret = '\x73k_live_abc123456789012345';
  const r = runCli(['add', 'build-boss', '--text', 'do not log API keys in examples', '--quote', `owner said: never paste ${secret} in a lesson`], root);
  t('case6: CLI exits 0', r.status === 0);
  const lessons = lessonsFor(root, 'build-boss');
  t('case6: lesson written', lessons.length === 1);
  const raw = JSON.stringify(lessons[0]);
  t('case6: raw secret never persisted anywhere in the lesson', !raw.includes(secret));
  t('case6: a redaction marker replaced the secret', /REDACTED/i.test(raw));
}

// ---- 7) multi-line/control-char quote -> stored single-line ----
{
  const root = makeFixture('case7');
  const messyQuote = 'line one of correction' + String.fromCharCode(10) + String.fromCharCode(9) + 'line two after tab' + String.fromCharCode(13) + 'line three';
  const r = runCli(['add', 'build-boss', '--text', 'keep corrections single line', '--quote', messyQuote], root);
  t('case7: CLI exits 0', r.status === 0);
  const lessons = lessonsFor(root, 'build-boss');
  let ev = null; try { ev = JSON.parse(lessons[0].evidence); } catch { /* fail below */ }
  t('case7: evidence quote has no embedded newline/tab/CR', !!ev && !/[\n\t\r]/.test(ev.quote));
  t('case7: evidence quote still carries the sanitized words', !!ev && /line one of correction/.test(ev.quote) && /line three/.test(ev.quote));
}

// ---- 8) list shows lessons newest-first; list on empty memory -> honest empty, exit 0 ----
{
  const root = makeFixture('case8');
  const a = runCli(['add', 'build-boss', '--text', 'first lesson chronologically', '--quote', 'owner correction number one'], root);
  t('case8: first add exits 0', a.status === 0);
  const b = runCli(['add', 'build-boss', '--text', 'second lesson chronologically', '--quote', 'owner correction number two'], root);
  t('case8: second add exits 0', b.status === 0);

  const listed = runCli(['list', 'build-boss'], root);
  t('case8: list CLI exits 0', listed.status === 0);
  const idxSecond = listed.stdout.indexOf('second lesson chronologically');
  const idxFirst = listed.stdout.indexOf('first lesson chronologically');
  t('case8: both lessons appear in list output', idxSecond !== -1 && idxFirst !== -1);
  t('case8: newest (second) lesson listed before the older (first) one', idxSecond !== -1 && idxFirst !== -1 && idxSecond < idxFirst);

  const emptyRoot = makeFixture('case8-empty');
  const emptyListed = runCli(['list', 'build-boss'], emptyRoot);
  t('case8b: list on empty memory exits 0', emptyListed.status === 0);
  t('case8b: list on empty memory is an honest empty state', /no owner-correction lessons yet for build-boss/.test(emptyListed.stdout));
}

// ---- 9) usage errors: no args at all, and a bad --type value, both exit 2 ----
{
  const root = makeFixture('case9');
  const noArgs = runCli([], root);
  t('case9: no arguments at all -> usage error exit 2', noArgs.status === 2);

  const badType = runCli(['add', 'build-boss', '--text', 'x', '--quote', 'y', '--type', 'bogus-type'], root);
  t('case9b: bad --type value -> usage error exit 2', badType.status === 2);
  t('case9b: stderr names --type', /--type/.test(badType.stderr));
  t('case9b: nothing written for the bad --type attempt', lessonsFor(root, 'build-boss').length === 0);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
