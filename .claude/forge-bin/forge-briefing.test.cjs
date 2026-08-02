#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-briefing.cjs (piece J5, 2026-07-19). EVERY fixture lives under a fresh
 * os.tmpdir() directory — this file NEVER touches this repo's real .claude/forge-runs/. Exit 0 = all pass.
 *
 * Section map:
 *   1) manifest present: done -> ran, failed -> blocked, unfinished/armed -> blocked + decisions needed
 *   2) no manifest ever armed: ran/blocked derived purely from events.jsonl, honest note added
 *   3) empty run (never armed, no events): honestly empty briefing, zero everywhere
 *   4) a disproven event (_forge_verify.proof_verified:false) is excluded from ran — honesty core
 *   5) an event whose wp_id the manifest already tracks is never double-listed
 *   6) an agent-level event with no wp_id is always included even when a manifest exists
 *   7) decisions_needed phrasing: "resume" for unfinished, "retry" for failed/blocker
 *   8) invalid run_id throws a usage error
 *   9) real spawned CLI: exit codes, --json output, markdown sections
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mf = require('./forge-manifest.cjs');
const fb = require('./forge-briefing.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeEvents(root, runId, events) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf8');
}

console.log('1) manifest present: done -> ran, failed -> blocked, unfinished -> blocked + decisions needed');
{
  const root = freshDir('fb-manifest');
  mf.arm({ run_id: 'run-a', wps: [
    { wp_id: 'wp1', agent: 'Build Boss', narrowed_prompt: 'build login' },
    { wp_id: 'wp2', agent: 'Test Boss', narrowed_prompt: 'write tests' },
    { wp_id: 'wp3', agent: 'UI Boss', narrowed_prompt: 'style pages' },
  ] }, { root });
  writeEvents(root, 'run-a', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-19T02:00:00Z' },
    { event_type: 'check_failed', agent: 'Test Boss', wp_id: 'wp2', reason: '2 assertions failed', timestamp: '2026-07-19T02:05:00Z' },
    // wp3 never gets any event — stays "armed"
  ]);
  const r = fb.generate({ run_id: 'run-a' }, { root, now: new Date('2026-07-19T07:00:00Z') });
  t('ok:true', r.ok === true);
  t('manifest_present true', r.manifest_present === true);
  t('run_id echoed', r.run_id === 'run-a');
  t('ran has exactly wp1', r.ran.length === 1 && r.ran[0].wp_id === 'wp1' && r.ran[0].agent === 'Build Boss');
  t('ran item detail references its proof event', /wp_completed/.test(r.ran[0].detail));
  t('blocked has exactly wp2 (failed) and wp3 (unfinished)', r.blocked.length === 2 && r.blocked.map((b) => b.wp_id).sort().join(',') === 'wp2,wp3');
  t('wp2 blocked reason is "failed"', r.blocked.find((b) => b.wp_id === 'wp2').reason === 'failed');
  t('wp3 blocked reason is "unfinished"', r.blocked.find((b) => b.wp_id === 'wp3').reason === 'unfinished');
  t('decisions_needed has exactly 2 entries (one per blocked item)', r.decisions_needed.length === 2);
  t('markdown mentions wp1 under Ran and wp2/wp3 under Blocked', /## Ran[\s\S]*wp1[\s\S]*## Blocked[\s\S]*wp2[\s\S]*wp3/.test(r.markdown));
  t('generated_at uses the injected now()', r.generated_at === '2026-07-19T07:00:00.000Z');
}

console.log('2) no manifest ever armed: ran/blocked derived purely from events.jsonl');
{
  const root = freshDir('fb-noarm');
  writeEvents(root, 'run-b', [
    { event_type: 'agent_completed', agent: 'Build Boss', note: 'shipped the homepage', timestamp: '2026-07-19T03:00:00Z' },
    { event_type: 'codex_blocked', agent: 'Review Boss', reason: 'critical finding unresolved', timestamp: '2026-07-19T03:05:00Z' },
  ]);
  const r = fb.generate({ run_id: 'run-b' }, { root });
  t('manifest_present false', r.manifest_present === false);
  t('a note explains no manifest was armed', r.notes.some((n) => /no manifest was ever armed/.test(n)));
  t('ran has exactly 1 event-derived item (agent_completed)', r.ran.length === 1 && r.ran[0].source === 'event' && r.ran[0].agent === 'Build Boss');
  t('ran item detail is the real note text (never fabricated)', r.ran[0].detail === 'shipped the homepage');
  t('blocked has exactly 1 event-derived item (codex_blocked)', r.blocked.length === 1 && r.blocked[0].event_type === 'codex_blocked');
  t('decisions_needed has 1 entry with real reason text', r.decisions_needed.length === 1 && /critical finding unresolved/.test(r.decisions_needed[0].detail));
}

console.log('3) empty run (never armed, no events): honestly empty briefing');
{
  const root = freshDir('fb-empty');
  const r = fb.generate({ run_id: 'run-never-happened' }, { root });
  t('ok:true even for a run with zero evidence', r.ok === true);
  t('ran is empty', r.ran.length === 0);
  t('blocked is empty', r.blocked.length === 0);
  t('decisions_needed is empty', r.decisions_needed.length === 0);
  t('events_count is 0', r.events_count === 0);
  t('a note honestly says nothing was found', r.notes.some((n) => /nothing to report/.test(n)));
  t('markdown says nothing completed', /Nothing completed yet/.test(r.markdown));
  t('markdown says nothing blocked', /Nothing blocked/.test(r.markdown));
  t('markdown says no decisions needed', /No blockers logged/.test(r.markdown));
}

console.log('4) a disproven event is excluded from ran — honesty core (never fabricate a completed WP)');
{
  const root = freshDir('fb-disproven');
  writeEvents(root, 'run-c', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wpX', timestamp: '2026-07-19T04:00:00Z', _forge_verify: { proof_verified: false, proof_reason: 'no proof field' } },
  ]);
  const r = fb.generate({ run_id: 'run-c' }, { root });
  t('the disproven wp_completed event does NOT appear in ran', r.ran.length === 0);
  t('the disproven event does NOT appear in blocked either (not evidence of anything)', r.blocked.length === 0);
}

console.log('5) an event whose wp_id the manifest already tracks is never double-listed');
{
  const root = freshDir('fb-dedupe');
  mf.arm({ run_id: 'run-d', wps: [{ wp_id: 'wp1', agent: 'Build Boss', narrowed_prompt: 'x' }] }, { root });
  writeEvents(root, 'run-d', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-19T05:00:00Z' },
    { event_type: 'check_passed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-19T05:01:00Z' }, // same wp, extra event
  ]);
  const r = fb.generate({ run_id: 'run-d' }, { root });
  t('ran has exactly ONE entry for wp1 (manifest is authoritative, no duplicate from the extra event)', r.ran.length === 1 && r.ran[0].wp_id === 'wp1');
}

console.log('6) an agent-level event with no wp_id is always included even when a manifest exists');
{
  const root = freshDir('fb-agentlevel');
  mf.arm({ run_id: 'run-e', wps: [{ wp_id: 'wp1', agent: 'Build Boss', narrowed_prompt: 'x' }] }, { root });
  writeEvents(root, 'run-e', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-19T06:00:00Z' },
    { event_type: 'agent_failed', agent: 'Security Boss', reason: 'scan tool crashed', timestamp: '2026-07-19T06:01:00Z' },
  ]);
  const r = fb.generate({ run_id: 'run-e' }, { root });
  t('ran has the manifest wp1', r.ran.length === 1 && r.ran[0].wp_id === 'wp1');
  t('blocked has the agent-level agent_failed event (no wp_id, not tracked by manifest)', r.blocked.length === 1 && r.blocked[0].wp_id === null && r.blocked[0].agent === 'Security Boss');
}

console.log('7) decisions_needed phrasing: "resume" for unfinished, "retry" for failed/blocker');
{
  const root = freshDir('fb-phrasing');
  mf.arm({ run_id: 'run-f', wps: [
    { wp_id: 'wpFail', agent: 'Build Boss', narrowed_prompt: 'x' },
    { wp_id: 'wpArmed', agent: 'Test Boss', narrowed_prompt: 'y' },
  ] }, { root });
  writeEvents(root, 'run-f', [{ event_type: 'wp_failed', agent: 'Build Boss', wp_id: 'wpFail', timestamp: '2026-07-19T06:30:00Z' }]);
  const r = fb.generate({ run_id: 'run-f' }, { root });
  const dFail = r.decisions_needed.find((d) => d.wp_id === 'wpFail');
  const dArmed = r.decisions_needed.find((d) => d.wp_id === 'wpArmed');
  t('failed WP decision offers retry/reassign/drop', /retry it, reassign it, or drop it/.test(dFail.detail));
  t('unfinished WP decision offers resume/reprioritize/drop', /resume it, reprioritize it, or drop it/.test(dArmed.detail));
}

console.log('8) invalid run_id throws a usage error — never a fabricated empty result');
{
  const root = freshDir('fb-badid');
  t('generate() throws for an invalid run_id', (() => { try { fb.generate({ run_id: 'bad id!' }, { root }); return false; } catch (e) { return /valid run_id/.test(e.message); } })());
  t('generate() throws for a missing run_id', (() => { try { fb.generate({}, { root }); return false; } catch (e) { return /valid run_id/.test(e.message); } })());
}

console.log('9) real spawned CLI: exit codes, --json output, markdown sections');
{
  const root = freshDir('fb-cli');
  const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root });
  const CLI = path.join(__dirname, 'forge-briefing.cjs');
  function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env }); }

  spawnSync(process.execPath, [path.join(__dirname, 'forge-manifest.cjs'), 'arm', '--run', 'run-cli',
    '--wps', (() => { const f = path.join(root, 'wps.json'); fs.writeFileSync(f, JSON.stringify([{ wp_id: 'wp1', agent: 'Build Boss', narrowed_prompt: 'ship it' }])); return f; })()], { env });
  writeEvents(root, 'run-cli', [{ event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-19T08:00:00Z' }]);

  const jsonRes = runCLI(['--run', 'run-cli', '--json']);
  t('CLI exits 0 for a normal run', jsonRes.status === 0);
  const rj = JSON.parse(jsonRes.stdout);
  t('CLI --json reports ran.length === 1', rj.ran.length === 1);
  t('CLI --json reports run_id', rj.run_id === 'run-cli');

  const mdRes = runCLI(['--run', 'run-cli']);
  t('CLI human-readable output has the Ran/Blocked/Decisions sections', /## Ran/.test(mdRes.stdout) && /## Blocked/.test(mdRes.stdout) && /## Decisions needed/.test(mdRes.stdout));

  const emptyRes = runCLI(['--run', 'never-happened-cli']);
  t('CLI on a totally empty run still exits 0 (honestly-empty is success, not an error)', emptyRes.status === 0);
  t('CLI on an empty run prints the honest empty-state lines', /Nothing completed yet/.test(emptyRes.stdout));

  const noArgsRes = runCLI([]);
  t('CLI with no --run exits 2 and prints usage', noArgsRes.status === 2 && /Usage:/.test(noArgsRes.stderr));

  const badFlagRes = runCLI(['--bogus']);
  t('CLI with an unknown flag exits 2', badFlagRes.status === 2);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
