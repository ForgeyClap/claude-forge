#!/usr/bin/env node
'use strict';
/**
 * forge-killswitch.test.cjs — the ONE handle that stops all autonomous execution (2026-08-01).
 *
 * WHAT IS BEING PINNED, and why each half matters:
 *
 *  (1) NEVER BY NAME. This project has a HARD MUST written after a real incident on 2026-07-29: an agent
 *      cleaning up a broken Chrome ran a kill-by-image-name and took the live gateway on port 4100 down
 *      with it. A kill switch is the single most dangerous place for that mistake to come back, so this
 *      suite asserts it structurally, not just behaviourally: every emitted command must carry an exact
 *      PID that appears in the verified target list, and the source file may not contain a kill-by-name
 *      construct at all.
 *
 *  (2) VERIFICATION BEFORE TARGETING. A PID is only ever a target when it came from a structured source
 *      (the owner of the listening port, or the process table) AND its own command line proves it is the
 *      thing we mean AND it lives inside this project root. A process that merely looks right is REFUSED
 *      and reported, never stopped.
 *
 *  (3) DRY-RUN IS THE DEFAULT. Without an explicit confirmation flag the switch executes nothing at all.
 *      The tests below assert zero executor calls, not "harmless" ones.
 *
 *  (4) IT MUST BE REVERSIBLE. A stop you cannot undo is a trap, so scheduled tasks are DISABLED and never
 *      deleted, the state ledger records exactly what was touched, and restore only re-enables what this
 *      switch itself turned off.
 *
 *  (5) ORDER. The supervisor (the waakvlam) restarts the gateway within a second - proven live on
 *      2026-07-30 and documented in the project CLAUDE.md. Stopping the gateway before the supervisor
 *      would therefore accomplish nothing. The planned order is pinned here as a fact, not a comment.
 *
 * Hermetic: the process table, the port owner, the scheduled-task list and the command executor are all
 * INJECTED. No real process is listed, signalled or killed by this suite, and no real scheduled task is
 * touched.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const K = require('./forge-killswitch.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-killswitch-'));
let seq = 0;
function stateFile() { return path.join(TMP, 'state-' + (seq++) + '.json'); }

// ---- a fake but realistic world ----------------------------------------------------------------------
// Modelled on the REAL live tree measured on this machine on 2026-08-01:
//   nohup -> node supervisor.mjs (19752) -> node gateway/bin.mjs (18868) -> node discord/src/main.js (5004)
const ROOT = 'C:\\Users\\YOU\\Documents\\my-forge-project';
const NODE = '"C:\\Program Files\\nodejs\\node.exe" ';
function world(over) {
  return Object.assign({
    root: ROOT,
    port: 4100,
    portOwner: 18868,
    processes: [
      { pid: 19752, ppid: 10716, name: 'node.exe', cmd: NODE + 'command-center/gateway/supervisor.mjs', cwd: ROOT },
      { pid: 18868, ppid: 19752, name: 'node.exe', cmd: NODE + '"' + ROOT + '\\command-center\\gateway\\bin.mjs"' },
      { pid: 5004, ppid: 18868, name: 'node.exe', cmd: NODE + '"' + ROOT + '\\command-center\\discord\\src\\main.js"' },
      { pid: 4242, ppid: 1, name: 'node.exe', cmd: NODE + 'C:\\Some\\Other\\Project\\server.js' }, // innocent bystander
      { pid: 777, ppid: 1, name: 'chrome.exe', cmd: '"C:\\chrome.exe" --headless' },
    ],
    tasks: [
      { name: '\\ForgeCommandCenter-Supervisor', action: 'cmd.exe /c "' + ROOT + '\\.claude\\forge-bin\\start-command-center.cmd"', state: 'Ready' },
      { name: '\\ForgeMaandSweep', action: 'cmd.exe /c "' + ROOT + '\\.claude\\forge-bin\\maand-sweep.cmd"', state: 'Ready' },
      { name: '\\SomeoneElsesBackup', action: 'C:\\Windows\\backup.exe', state: 'Ready' },
    ],
  }, over || {});
}
/** an injected executor that RECORDS instead of doing */
function recorder() {
  const calls = [];
  return { calls, run: (cmd, args) => { calls.push({ cmd, args }); return { ok: true, code: 0, stdout: '', stderr: '' }; } };
}
function opts(w, extra) {
  return Object.assign({
    root: w.root,
    listProcesses: () => w.processes,
    portOwner: () => w.portOwner,
    listTasks: () => w.tasks,
    selfPid: 99999,
    stateFile: stateFile(),
  }, extra || {});
}

console.log('forge-killswitch tests (one handle, exact PIDs only, dry-run by default)');

// ======================================================================================================
// 1) target resolution - what may and may not become a target
// ======================================================================================================
t('the gateway is resolved from the PORT OWNER, and its command line is what verifies it', () => {
  const w = world();
  const tg = K.resolveTargets(opts(w)).targets.find((x) => x.kind === 'gateway');
  assert.strictEqual(tg.pid, 18868);
  assert.strictEqual(tg.verified, true);
  assert.strictEqual(tg.state, 'running');
  assert.ok(/port 4100|listening/i.test(tg.evidence), 'the evidence must name how the PID was found: ' + tg.evidence);
});

t('a process listening on 4100 that is NOT our gateway is REFUSED, never stopped', () => {
  const w = world({ portOwner: 4242 }); // the innocent bystander happens to hold the port
  const tg = K.resolveTargets(opts(w)).targets.find((x) => x.kind === 'gateway');
  assert.strictEqual(tg.verified, false);
  assert.strictEqual(tg.state, 'refused');
  assert.ok(/command line|verif/i.test(tg.why || ''), 'the refusal must say why: ' + tg.why);
});

t('a gateway-looking process OUTSIDE this project root is REFUSED (isolation, not just naming)', () => {
  const w = world({
    portOwner: 31337,
    processes: [{ pid: 31337, ppid: 1, name: 'node.exe', cmd: NODE + 'D:\\ander-project\\command-center\\gateway\\bin.mjs' }],
  });
  const tg = K.resolveTargets(opts(w)).targets.find((x) => x.kind === 'gateway');
  assert.strictEqual(tg.verified, false);
  assert.ok(/root|project/i.test(tg.why || ''), 'the refusal must name the isolation reason: ' + tg.why);
});

t('nothing listening on 4100 is reported as not-running, not as an error', () => {
  const w = world({ portOwner: null });
  const tg = K.resolveTargets(opts(w)).targets.find((x) => x.kind === 'gateway');
  assert.strictEqual(tg.state, 'not-running');
  assert.strictEqual(tg.pid, null);
  assert.strictEqual(tg.verified, false);
});

t('the waakvlam (supervisor) is resolved by its own script path inside this root', () => {
  const sv = K.resolveTargets(opts(world())).targets.find((x) => x.kind === 'supervisor');
  assert.strictEqual(sv.pid, 19752);
  assert.strictEqual(sv.verified, true);
});

t('the supervisor is cross-checked against being the gateway PARENT (a second, independent signal)', () => {
  const sv = K.resolveTargets(opts(world())).targets.find((x) => x.kind === 'supervisor');
  assert.ok(/parent/i.test(sv.evidence || ''), 'the evidence should record the parent match: ' + sv.evidence);
});

t('the Discord service is resolved only as a CHILD of the verified gateway', () => {
  const dc = K.resolveTargets(opts(world())).targets.find((x) => x.kind === 'discord');
  assert.strictEqual(dc.pid, 5004);
  assert.strictEqual(dc.verified, true);
});

// ---- FOUND BY THE FIRST DRY RUN AGAINST THE REAL MACHINE (2026-08-01) --------------------------------
// The very first `status` against the live process table verified pid 11148 as the waakvlam. It was not:
// it was the Git-bash shell that originally LAUNCHED the supervisor, so its enormous `bash -c ...` command
// line happens to contain the text "command-center/gateway/supervisor.mjs". A substring match is not
// evidence that a process IS the thing - only that it once talked about it. Stopping that PID would have
// killed a shell belonging to the session, which is the same shape of mistake as the 2026-07-29 incident.
// The fix: the process must actually be a Node process RUNNING that script - the executable is node and
// the script appears as its own argument - not merely mention it somewhere in a command string.
t('a SHELL that merely mentions the supervisor script in its command line is refused, not verified', () => {
  const w = world();
  w.processes = w.processes.concat([{
    pid: 11148, ppid: 5488, name: 'bash.exe',
    cmd: '"C:\\Program Files\\Git\\bin\\bash.exe" -c "cd \\"' + ROOT + '\\" && nohup node command-center/gateway/supervisor.mjs >> log 2>&1 &"',
  }]);
  const targets = K.resolveTargets(opts(w)).targets;
  assert.ok(targets.filter((x) => x.pid === 11148).every((x) => x.verified === false),
    'a shell that only MENTIONS the script was verified as the supervisor');
  assert.ok(!K.planStop(opts(w)).steps.some((s) => s.pid === 11148), 'a command was planned against a shell');
  // ...and the filter did not simply swallow everything: the REAL waakvlam in the same world is still found.
  assert.ok(targets.some((x) => x.kind === 'supervisor' && x.pid === 19752 && x.verified),
    'the real supervisor was lost along with the shell — the check is too strict, not just strict enough');
});

// ---- FOUND BY THE WITNESS AUDIT OF THAT VERY FIX (2026-08-01) ---------------------------------------
// The fix above closed the SHELL variant (bash/nohup as the executable) and its test only ever covered
// that variant. A witness then baited the switch with a live NODE process - `node mentions.js <path>` -
// that merely carries the supervisor path as a LATER argument, and the switch VERIFIED it and planned a
// real `taskkill /PID 13844` with /F escalation, printing the demonstrably false evidence line
// "runs command-center/gateway/supervisor.mjs". Node only ever executes its FIRST non-flag argument, so
// "some token ends in the signature" is still a text coincidence any helper script can satisfy. The
// supervisor kind has no port anchor to fall back on, which makes it the reachable one. Same shape of
// mistake as 2026-07-29: an unrelated living process gets a kill command.
t('a NODE process that carries the supervisor path as a LATER argument is refused, not verified', () => {
  const w = world();
  w.processes = w.processes.concat([{
    pid: 13844, ppid: 5488, name: 'node.exe',
    cmd: NODE + '"' + ROOT + '\\scripts\\restart-helper.js" "' + ROOT + '\\command-center\\gateway\\supervisor.mjs"',
  }]);
  const targets = K.resolveTargets(opts(w)).targets;
  assert.ok(targets.filter((x) => x.pid === 13844).every((x) => x.verified === false),
    'a helper that only PASSES the script path was verified as the supervisor');
  assert.ok(!K.planStop(opts(w)).steps.some((s) => s.pid === 13844),
    'a taskkill was planned against an unrelated node process');
  // ...and again the other direction: narrowing must not lose the real waakvlam.
  assert.ok(targets.some((x) => x.kind === 'supervisor' && x.pid === 19752 && x.verified),
    'the real supervisor was lost along with the helper — too strict, not just strict enough');
});

t('the same trap is closed for the Discord service (its path as a later argument)', () => {
  const w = world();
  w.processes = w.processes.concat([{
    pid: 13845, ppid: 18868, name: 'node.exe', // even as a child of the verified gateway
    cmd: NODE + '"' + ROOT + '\\scripts\\tail-log.js" "' + ROOT + '\\command-center\\discord\\src\\main.js"',
  }]);
  const targets = K.resolveTargets(opts(w)).targets;
  assert.ok(targets.filter((x) => x.pid === 13845).every((x) => x.verified === false),
    'a helper that only PASSES the discord path was verified as the discord service');
  assert.ok(!K.planStop(opts(w)).steps.some((s) => s.pid === 13845), 'a taskkill was planned against a log tailer');
});

t('node FLAGS before the script do not hide the real waakvlam (the narrowing is not blunt)', () => {
  // Both forms must still resolve: a valueless flag, and a flag that swallows the token after it.
  for (const flags of ['--enable-source-maps ', '-r ./preload.cjs ', '--import ./hook.mjs ']) {
    const w = world();
    w.processes = w.processes.map((p) => (p.pid === 19752
      ? Object.assign({}, p, { cmd: NODE + flags + 'command-center/gateway/supervisor.mjs' })
      : p));
    const sv = K.resolveTargets(opts(w)).targets.find((x) => x.kind === 'supervisor');
    assert.strictEqual(sv && sv.pid, 19752, 'flags "' + flags.trim() + '" made the real supervisor unfindable');
    assert.strictEqual(sv.verified, true, 'flags "' + flags.trim() + '" made the real supervisor unverifiable');
  }
});

t('a node process where the signature is a FLAG VALUE, not the script, is refused', () => {
  // `node -p <path>` prints the path; it does not run it. The token still ends in the signature, so this
  // is the case that proves the value-swallowing flags are handled rather than merely skipped over.
  const w = world();
  w.processes = w.processes.concat([{
    pid: 13846, ppid: 5488, name: 'node.exe',
    cmd: NODE + '-p "' + ROOT + '\\command-center\\gateway\\supervisor.mjs"',
  }]);
  const hits = K.resolveTargets(opts(w)).targets.filter((x) => x.pid === 13846);
  assert.ok(hits.every((x) => x.verified === false), 'a -p one-liner was verified as the supervisor');
});

t('a launcher wrapper (nohup) in the start chain is refused as well', () => {
  const w = world();
  w.processes = w.processes.concat([{ pid: 10716, ppid: 11148, name: 'nohup.exe', cmd: '"C:\\Program Files\\Git\\usr\\bin\\nohup.exe" node command-center/gateway/supervisor.mjs' }]);
  const hits = K.resolveTargets(opts(w)).targets.filter((x) => x.pid === 10716);
  assert.ok(hits.every((x) => x.verified === false), 'a launcher wrapper was verified as the supervisor');
});

t('exactly ONE supervisor is verified when the real launch chain is present', () => {
  const w = world();
  w.processes = w.processes.concat([
    { pid: 11148, ppid: 5488, name: 'bash.exe', cmd: '"C:\\Program Files\\Git\\bin\\bash.exe" -c "node command-center/gateway/supervisor.mjs"' },
    { pid: 10716, ppid: 11148, name: 'nohup.exe', cmd: '"C:\\Program Files\\Git\\usr\\bin\\nohup.exe" node command-center/gateway/supervisor.mjs' },
  ]);
  const verified = K.resolveTargets(opts(w)).targets.filter((x) => x.kind === 'supervisor' && x.verified);
  assert.strictEqual(verified.length, 1, 'expected one waakvlam, got ' + JSON.stringify(verified.map((v) => v.pid)));
  assert.strictEqual(verified[0].pid, 19752);
});

t('a node process running an UNRELATED script is never matched by any signature', () => {
  const targets = K.resolveTargets(opts(world())).targets;
  assert.ok(!targets.some((x) => x.pid === 4242), 'an unrelated node process was matched');
});

t('a discord-looking process that is NOT the gateway child is refused', () => {
  const w = world();
  w.processes = w.processes.map((p) => (p.pid === 5004 ? Object.assign({}, p, { ppid: 1 }) : p));
  const dc = K.resolveTargets(opts(w)).targets.find((x) => x.kind === 'discord');
  assert.strictEqual(dc.verified, false);
  assert.ok(/child|parent/i.test(dc.why || ''), 'the refusal must name the parentage check: ' + dc.why);
});

t('only OUR scheduled tasks are targeted; a stranger task in the same task store is untouched', () => {
  const names = K.resolveTargets(opts(world())).targets.filter((x) => x.kind === 'task').map((x) => x.task);
  assert.deepStrictEqual(names.sort(), ['\\ForgeCommandCenter-Supervisor', '\\ForgeMaandSweep']);
});

t('a task whose action points OUTSIDE this project is refused even if its name matches', () => {
  const w = world();
  w.tasks = [{ name: '\\ForgeMaandSweep', action: 'cmd.exe /c "D:\\elders\\maand-sweep.cmd"', state: 'Ready' }];
  // Look the task up BY NAME: the resolver reports every known task name, present or not, so a bare
  // find-the-first-task would pick up the absent one and prove nothing about the refusal.
  const tk = K.resolveTargets(opts(w)).targets.find((x) => x.kind === 'task' && /ForgeMaandSweep/i.test(x.task || ''));
  assert.strictEqual(tk.state, 'refused');
  assert.strictEqual(tk.verified, false);
  assert.ok(/root|project/i.test(tk.why || ''), 'the refusal must name the isolation reason: ' + tk.why);
});

t('our OWN process is never verified and never lands in a step, however well it matches', () => {
  // It is still REPORTED (as skipped, with its pid and the reason) — hiding it would make the switch look
  // like it had nothing to say about a process it deliberately spared. What must never happen is that it
  // becomes a target: not verified, and not referenced by any command.
  const w = world();
  // Quoted, like Windows really writes it — this root contains a space, and an unquoted fixture would
  // tokenise into fragments and stop matching for the wrong reason, testing nothing.
  w.processes = w.processes.concat([{ pid: 99999, ppid: 1, name: 'node.exe', cmd: NODE + '"' + ROOT + '\\command-center\\gateway\\supervisor.mjs"' }]);
  const o = opts(w);
  const self = K.resolveTargets(o).targets.find((x) => x.pid === 99999);
  assert.ok(self, 'the switch should still report the process it spared');
  assert.strictEqual(self.verified, false, 'the switch verified its own process as a target');
  assert.strictEqual(self.state, 'skipped');
  assert.ok(!K.planStop(o).steps.some((s) => s.pid === 99999), 'a command was planned against our own process');
});

// ---- FOUND BY FIRING IT FOR REAL (2026-08-02, the first live --confirm) -----------------------------
// Two defects that only a real firing could surface. The switch DID stop everything correctly, but:
//
// (1) IT CALLED ITS OWN SUCCESS A FAILURE. Stopping the supervisor cascades: its children (gateway,
//     discord) die with it, so by the time their own taskkill ran the OS answered "process not found"
//     (exit 128). The report printed "-> FAILED code 128" for the two processes it had just successfully
//     brought down. A kill switch that cries failure while succeeding is one a human learns to distrust,
//     and the ledger recorded those as failures too. The truth is checkable: if the PID is gone, the
//     goal is met — "already gone" is SUCCESS, not failure.
t('LIVE-FOUND 1: a taskkill that reports "not found" for a pid that is genuinely GONE counts as stopped, not failed', () => {
  // The REAL cascade, modelled honestly: the targets exist while the plan is built, and are gone by the
  // time their own taskkill runs (the parent stop took them with it). A stateful process table is what
  // makes this test load-bearing — with a table that is empty from the start there are no targets at
  // all and the assertions below would pass vacuously.
  const w = world();
  const full = w.processes.slice();
  let planned = false;
  const listProcesses = () => (planned ? [] : full);
  const exec = (cmd, args) => { planned = true; return { ok: false, code: 128, stdout: '', stderr: 'ERROR: The process "' + args[1] + '" not found.' }; };
  const o = Object.assign(opts(w), { confirm: true, exec, listProcesses, stateFile: stateFile() });
  const res = K.run(o);
  const procSteps = res.steps.filter((s) => s.kind !== 'task');
  assert.ok(procSteps.length >= 3, 'setup: expected the three real process targets, got ' + procSteps.length);
  for (const s of procSteps) {
    assert.strictEqual(s.result.stopped, true,
      'a pid that is provably gone was not recorded as stopped: ' + JSON.stringify(s.result));
  }
  assert.ok(res.state.stopped.every((s) => s.result.stopped === true), 'the ledger recorded a gone pid as a failure');
});

t('LIVE-FOUND 1b: a taskkill that fails while the pid is STILL ALIVE is still an honest failure', () => {
  const w = world(); // the real world: pids 19752/18868/5004 are all present
  const exec = () => ({ ok: false, code: 1, stdout: '', stderr: 'Access is denied.' });
  const o = Object.assign(opts(w), { confirm: true, exec, stateFile: stateFile() });
  const res = K.run(o);
  const procSteps = res.steps.filter((s) => s.kind !== 'task');
  assert.ok(procSteps.some((s) => s.result.stopped === false),
    'a pid that survived a failed kill must NOT be reported as stopped — that would be the opposite lie');
});

// (2) `restore --confirm` NEVER RETURNED. It restarts the waakvlam with the same blocking execFileSync it
//     uses for schtasks — so it sat waiting for a long-lived daemon that by design never exits. The
//     restore genuinely worked (health 200, tasks re-enabled) but the command hung, which also meant the
//     ledger was never cleared. A long-lived service must be started detached and unwaited.
t('LIVE-FOUND 2: restore starts the supervisor DETACHED (never blocks on a daemon that does not exit)', () => {
  const st = stateFile();
  fs.writeFileSync(st, JSON.stringify({ engaged_at: new Date().toISOString(), root: ROOT, port: 4100, disabled_tasks: ['\\ForgeCommandCenter-Supervisor'], stopped: [] }), 'utf8');
  let sawDetached = null;
  const exec = () => ({ ok: true, code: 0, stdout: '', stderr: '' });
  const spawnDetached = (cmd, args) => { sawDetached = { cmd, args }; return { ok: true, pid: 4242, detached: true }; };
  const res = K.restore({ root: ROOT, stateFile: st, confirm: true, exec, spawnDetached });
  assert.ok(sawDetached, 'the supervisor was not started through the detached spawner');
  assert.ok(/supervisor\.mjs$/.test(String((sawDetached.args || []).join(' '))), 'the detached spawn did not target supervisor.mjs: ' + JSON.stringify(sawDetached));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.ledger_cleared, true, 'a completed restore must clear the ledger');
  assert.ok(!fs.existsSync(st), 'the ledger file is still on disk after a successful restore');
});

t('an empty process table refuses every process target instead of guessing', () => {
  const w = world({ processes: [], portOwner: null });
  const r = K.resolveTargets(opts(w));
  const procs = r.targets.filter((x) => x.kind !== 'task');
  assert.ok(procs.every((x) => x.verified === false), 'something was verified against an empty table');
});

t('a process lister that THROWS degrades to "no verified targets", never to a name-based guess', () => {
  const w = world();
  const r = K.resolveTargets(opts(w, { listProcesses: () => { throw new Error('powershell exploded'); } }));
  assert.ok(r.targets.filter((x) => x.kind !== 'task').every((x) => x.verified === false));
  assert.ok(/powershell exploded/.test(JSON.stringify(r)), 'the real error must be reported, not swallowed');
});

// ======================================================================================================
// 2) the plan - order and shape
// ======================================================================================================
t('the stop order is tasks -> supervisor -> discord -> gateway', () => {
  const kinds = K.planStop(opts(world())).steps.map((s) => s.kind);
  const firstOf = (k) => kinds.indexOf(k);
  assert.ok(firstOf('task') < firstOf('supervisor'), 'a scheduled task could relaunch mid-stop');
  assert.ok(firstOf('supervisor') < firstOf('gateway'), 'the waakvlam restarts the gateway within a second');
  assert.ok(firstOf('discord') < firstOf('gateway'), 'stop the child before its parent');
});

t('every planned process step carries an exact PID that is in the verified target list', () => {
  const plan = K.planStop(opts(world()));
  const verified = new Set(plan.targets.filter((x) => x.verified).map((x) => x.pid));
  for (const s of plan.steps.filter((x) => x.kind !== 'task')) {
    assert.ok(verified.has(s.pid), 'step targets unverified pid ' + s.pid);
    assert.ok(s.args.includes(String(s.pid)), 'the command does not carry the PID: ' + JSON.stringify(s.args));
  }
});

t('no planned command contains an image name, a wildcard, or a name-based selector', () => {
  for (const s of K.planStop(opts(world())).steps) {
    const line = [s.cmd].concat(s.args).join(' ');
    assert.ok(!/\/IM\b/i.test(line), 'kill-by-image-name in: ' + line);
    assert.ok(!/-Name\b/i.test(line), 'name-based selector in: ' + line);
    assert.ok(!/node\.exe|chrome\.exe/i.test(line), 'a process image name appears in: ' + line);
  }
});

t('scheduled tasks are DISABLED, never deleted (a deletion is not reversible)', () => {
  const steps = K.planStop(opts(world())).steps.filter((s) => s.kind === 'task');
  assert.ok(steps.length > 0);
  for (const s of steps) {
    const line = [s.cmd].concat(s.args).join(' ');
    assert.ok(/\/DISABLE/i.test(line), 'not a disable: ' + line);
    assert.ok(!/\/Delete|Unregister-ScheduledTask/i.test(line), 'DESTRUCTIVE task command: ' + line);
  }
});

t('a refused target produces NO step at all', () => {
  const w = world({ portOwner: 4242 });
  const plan = K.planStop(opts(w));
  assert.ok(!plan.steps.some((s) => s.pid === 4242), 'a refused pid was planned anyway');
});

// ======================================================================================================
// 3) dry-run is the default - the single most important behaviour in this file
// ======================================================================================================
t('run() WITHOUT a confirmation flag executes absolutely nothing', () => {
  const rec = recorder();
  const r = K.run(opts(world(), { exec: rec.run }));
  assert.strictEqual(r.dry_run, true);
  assert.strictEqual(rec.calls.length, 0, 'the executor was called ' + rec.calls.length + ' time(s) in a dry run');
  assert.ok(r.steps.length > 0, 'a dry run must still SHOW what it would do');
});

t('confirm:false is treated exactly like no flag at all', () => {
  const rec = recorder();
  const r = K.run(opts(world(), { exec: rec.run, confirm: false }));
  assert.strictEqual(r.dry_run, true);
  assert.strictEqual(rec.calls.length, 0);
});

t('a dry run writes NO state file (it changed nothing, so it may claim nothing)', () => {
  const sf = stateFile();
  K.run(opts(world(), { exec: recorder().run, stateFile: sf }));
  assert.strictEqual(fs.existsSync(sf), false, 'a dry run left a state file behind');
});

t('with confirm:true the executor receives exact-PID taskkill commands and nothing else', () => {
  const rec = recorder();
  const r = K.run(opts(world(), { exec: rec.run, confirm: true }));
  assert.strictEqual(r.dry_run, false);
  assert.ok(rec.calls.length > 0, 'a confirmed run executed nothing');
  const pids = new Set([19752, 18868, 5004].map(String));
  for (const c of rec.calls) {
    const line = [c.cmd].concat(c.args).join(' ');
    assert.ok(/^(taskkill|schtasks)$/i.test(c.cmd), 'unexpected executable: ' + c.cmd);
    assert.ok(!/\/IM\b|-Name\b/i.test(line), 'name-based kill executed: ' + line);
    if (/taskkill/i.test(c.cmd)) {
      assert.ok(c.args[0] === '/PID', 'taskkill must select by /PID first: ' + line);
      assert.ok(pids.has(c.args[1]), 'taskkill aimed at an unexpected pid: ' + line);
    }
  }
});

t('the innocent bystander process is never in any executed command', () => {
  const rec = recorder();
  K.run(opts(world(), { exec: rec.run, confirm: true }));
  const all = rec.calls.map((c) => [c.cmd].concat(c.args).join(' ')).join('\n');
  assert.ok(!/4242|777/.test(all), 'an unrelated process appeared in the commands:\n' + all);
});

t('a confirmed run records what it actually did in the state ledger', () => {
  const sf = stateFile();
  K.run(opts(world(), { exec: recorder().run, confirm: true, stateFile: sf }));
  assert.ok(fs.existsSync(sf), 'no state ledger was written');
  const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
  assert.ok(Array.isArray(st.disabled_tasks) && st.disabled_tasks.length === 2, 'tasks not recorded: ' + JSON.stringify(st.disabled_tasks));
  assert.ok(Array.isArray(st.stopped) && st.stopped.length === 3, 'stopped processes not recorded');
  assert.ok(st.engaged_at, 'no timestamp');
});

t('an executor failure is reported per step, not swallowed and not fatal', () => {
  const calls = [];
  const exec = (cmd, args) => { calls.push({ cmd, args }); return { ok: false, code: 1, stderr: 'access denied' }; };
  const r = K.run(opts(world(), { exec, confirm: true }));
  assert.ok(r.steps.some((s) => s.result && s.result.ok === false), 'no failed step reported');
  assert.ok(/access denied/.test(JSON.stringify(r)), 'the real error text is missing from the result');
});

// ======================================================================================================
// 4) reversibility - the other half of a safe switch
// ======================================================================================================
t('restore is dry-run by default too', () => {
  const rec = recorder();
  const sf = stateFile();
  K.run(opts(world(), { exec: recorder().run, confirm: true, stateFile: sf }));
  const r = K.restore(opts(world(), { exec: rec.run, stateFile: sf }));
  assert.strictEqual(r.dry_run, true);
  assert.strictEqual(rec.calls.length, 0);
  assert.ok(r.steps.length > 0, 'restore must show what it would do');
});

t('restore re-enables ONLY the tasks this switch disabled, read back from the ledger', () => {
  const sf = stateFile();
  const w = world();
  K.run(opts(w, { exec: recorder().run, confirm: true, stateFile: sf }));
  const rec = recorder();
  K.restore(opts(w, { exec: rec.run, confirm: true, stateFile: sf }));
  const enabled = rec.calls.filter((c) => /schtasks/i.test(c.cmd)).map((c) => c.args.join(' '));
  assert.strictEqual(enabled.length, 2, 'expected exactly the two tasks we disabled: ' + JSON.stringify(enabled));
  for (const e of enabled) {
    assert.ok(/\/ENABLE/i.test(e), 'not an enable: ' + e);
    assert.ok(!/SomeoneElsesBackup/.test(e), 'restore touched a task we never disabled: ' + e);
  }
});

t('restore restarts the waakvlam, which is what brings the gateway back', () => {
  const sf = stateFile();
  K.run(opts(world(), { exec: recorder().run, confirm: true, stateFile: sf }));
  const rec = recorder();
  // Since 2026-08-02 the daemon deliberately goes through the DETACHED spawner instead of exec (see
  // LIVE-FOUND 2 above); this test still asks the same question — did the waakvlam get started — and
  // watches BOTH channels so it can never be satisfied by the wrong one.
  const spawned = [];
  const spawnDetached = (cmd, args) => { spawned.push([cmd].concat(args).join(' ')); return { ok: true, pid: 1, detached: true }; };
  K.restore(opts(world(), { exec: rec.run, spawnDetached, confirm: true, stateFile: sf }));
  const line = rec.calls.map((c) => [c.cmd].concat(c.args).join(' ')).concat(spawned).join('\n');
  assert.ok(/supervisor\.mjs/.test(line), 'restore never starts the supervisor:\n' + line);
});

t('restore reports the Discord re-arm step, because a gateway restart does not bring it back by itself', () => {
  const sf = stateFile();
  K.run(opts(world(), { exec: recorder().run, confirm: true, stateFile: sf }));
  const r = K.restore(opts(world(), { stateFile: sf }));
  assert.ok(/discord/i.test(JSON.stringify(r.steps)), 'restore says nothing about the Discord service');
});

t('restore without a ledger refuses rather than guessing what to turn back on', () => {
  const r = K.restore(opts(world(), { stateFile: path.join(TMP, 'never-written.json'), confirm: true }));
  assert.strictEqual(r.ok, false);
  assert.ok(/ledger|state/i.test(r.reason || ''), 'the refusal must explain itself: ' + r.reason);
});

t('a confirmed restore clears the ledger so a second restore cannot double-fire', () => {
  const sf = stateFile();
  K.run(opts(world(), { exec: recorder().run, confirm: true, stateFile: sf }));
  K.restore(opts(world(), { exec: recorder().run, confirm: true, stateFile: sf }));
  const second = K.restore(opts(world(), { exec: recorder().run, confirm: true, stateFile: sf }));
  assert.strictEqual(second.ok, false, 'the ledger survived a completed restore');
});

// ======================================================================================================
// 5) the structural guard - the 2026-07-29 incident may not come back through this door
// ======================================================================================================
t('the SOURCE of the kill switch contains no kill-by-name construct anywhere', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-killswitch.cjs'), 'utf8');
  const forbidden = [
    [/taskkill[^\n]*\/IM\b/i, 'taskkill /IM'],
    [/Stop-Process[^\n]*-Name\b/i, 'Stop-Process -Name'],
    [/\bpkill\b/, 'pkill'],
    [/\bkillall\b/, 'killall'],
  ];
  for (const [re, label] of forbidden) {
    const m = re.exec(src);
    // A line that is explicitly ABOUT the rule (a comment naming the incident) is allowed; an executable
    // construct is not. Comments in this file start with * or //.
    if (m) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      assert.ok(/^\s*(\*|\/\/|rem\b)/.test(line), 'executable ' + label + ' found: ' + line.trim());
    }
  }
});

t('the switch never emits a taskkill /T (a tree kill reaches PIDs we did not verify)', () => {
  for (const s of K.planStop(opts(world())).steps) {
    assert.ok(!/^\/T$/i.test(s.args.join(' ')) && !/\s\/T(\s|$)/i.test(' ' + s.args.join(' ')),
      'tree kill planned: ' + [s.cmd].concat(s.args).join(' '));
  }
});

t('KNOWN_TASKS and the port are declared as data, so an auditor can read the whole blast radius', () => {
  assert.ok(Array.isArray(K.KNOWN_TASKS) && K.KNOWN_TASKS.length === 2, 'KNOWN_TASKS is not the declared pair');
  assert.strictEqual(K.GATEWAY_PORT, 4100);
  assert.ok(Array.isArray(K.TARGET_KINDS) && K.TARGET_KINDS.join(',') === 'task,supervisor,discord,gateway',
    'TARGET_KINDS must state the stop order as data: ' + JSON.stringify(K.TARGET_KINDS));
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
