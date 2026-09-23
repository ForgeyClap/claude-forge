#!/usr/bin/env node
'use strict';
/**
 * forge-killswitch.cjs — ONE handle that stops all autonomous execution in this project (2026-08-01).
 * Zero-dependency, CommonJS, Windows-first.
 *
 * BUILT, NOT USED. This file was written while the owner was asleep, on a delegated decision. It has been
 * proven with a dry run against the real live processes and with tests against simulated ones. It has NOT
 * been fired.
 *
 * ── WHAT IT STOPS ─────────────────────────────────────────────────────────────────────────────────────
 * Four layers, in this order (the order is data — see TARGET_KINDS — because it is load-bearing):
 *   1. the scheduled Windows tasks   — first, so nothing can relaunch while the rest is being stopped;
 *   2. the waakvlam (supervisor.mjs) — second, because it restarts the gateway within a second. Proven
 *      live on 2026-07-30 and documented in the project CLAUDE.md: killing the gateway child had it back
 *      on a new PID almost immediately. Stopping the gateway first would therefore do nothing at all;
 *   3. the Discord service           — before its parent, so it is stopped rather than orphaned;
 *   4. the gateway on 127.0.0.1:4100 — last.
 *
 * ── THE RULE THAT OUTRANKS EVERYTHING ELSE HERE ───────────────────────────────────────────────────────
 * EXACT, VERIFIED PIDs ONLY. NEVER a process name. This is a HARD MUST in this project, written after a
 * real incident on 2026-07-29: an agent tidying up a broken Chrome ran a kill-by-image-name and took the
 * live gateway on port 4100 down with it. A kill switch is precisely where that mistake would be most
 * expensive, so the rule is enforced three ways:
 *   · every PID comes from a STRUCTURED source — the owner of the listening TCP port, or the process
 *     table with its parent/child links — never from matching an image name;
 *   · a PID becomes a target only when its own command line proves what it is AND it is anchored to this
 *     project root. Anything that merely looks right is REFUSED and reported, never stopped;
 *   · forge-killswitch.test.cjs greps this very file and fails if an executable kill-by-name construct
 *     (an image-name switch, a name-based process selector, or a POSIX kill-by-name utility) ever appears
 *     in it.
 * There is also no tree kill: a /T would reach child PIDs that were never verified.
 *
 * ── DRY RUN IS THE DEFAULT ────────────────────────────────────────────────────────────────────────────
 * Without `--confirm` nothing is executed at all — not a softened version, nothing. The switch prints the
 * exact commands it WOULD run, against the real resolved PIDs, and exits.
 *
 * ── IT MUST BE REVERSIBLE ─────────────────────────────────────────────────────────────────────────────
 * A stop you cannot undo is a trap. So: scheduled tasks are DISABLED, never deleted; a confirmed stop
 * writes a state ledger recording exactly what was touched; and `restore` re-enables only what THIS switch
 * disabled and restarts the waakvlam (which brings the gateway back by itself). The Discord service does
 * not come back with the gateway — the project CLAUDE.md says so — so restore emits that one step as an
 * exact copy-paste command instead of pretending it happened.
 *
 * ── HONEST LIMITATION ─────────────────────────────────────────────────────────────────────────────────
 * The switch never targets its own process or any of its ancestors. If it is launched THROUGH the
 * gateway's own exec plane, the gateway is its ancestor and will be reported as skipped rather than
 * stopped. Run it from a plain terminal, not from the dashboard it is meant to stop.
 *
 * ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────
 *   node .claude/forge-bin/forge-killswitch.cjs status            # what is running, what would be a target
 *   node .claude/forge-bin/forge-killswitch.cjs stop              # DRY RUN (default): show, do nothing
 *   node .claude/forge-bin/forge-killswitch.cjs stop --confirm    # actually stop, exact PIDs only
 *   node .claude/forge-bin/forge-killswitch.cjs restore           # DRY RUN of the way back
 *   node .claude/forge-bin/forge-killswitch.cjs restore --confirm # re-enable + restart the waakvlam
 *   flags: [--root <dir>] [--state <file>] [--json]
 *
 * Module API: { GATEWAY_PORT, KNOWN_TASKS, TARGET_KINDS, SIGNATURES, resolveTargets, planStop, run,
 *               restore, readState, defaultStateFile, listProcessesWindows, portOwnerWindows,
 *               listTasksWindows }
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GATEWAY_PORT = 4100;

/** The stop order, as data. Read top to bottom; see the header for why each position matters. */
const TARGET_KINDS = ['task', 'supervisor', 'discord', 'gateway'];

/** The complete scheduled-task blast radius. Two names, listed explicitly, so an auditor can read the
 *  whole reach of this switch in one place. Nothing else in the Windows task store is ever touched. */
const KNOWN_TASKS = ['ForgeCommandCenter-Supervisor', 'ForgeMaandSweep'];

/** What a command line must contain for a PID to be recognised as one of ours. Path separators are
 *  normalised before matching, so both `command-center\gateway\bin.mjs` and the forward-slash form hit. */
const SIGNATURES = {
  supervisor: 'command-center/gateway/supervisor.mjs',
  gateway: 'command-center/gateway/bin.mjs',
  discord: 'command-center/discord/src/main.js',
};

const DEFAULT_ROOT = path.join(__dirname, '..', '..');

function defaultStateFile(root) { return path.join(root || DEFAULT_ROOT, '.claude', 'FORGE_KILLSWITCH_STATE.json'); }

function norm(s) { return String(s || '').replace(/\\/g, '/').toLowerCase(); }

/** Quote-aware split of a Windows command line. `"C:\Program Files\nodejs\node.exe" script.mjs` must come
 *  back as two tokens, not four — the executable path contains spaces on every normal install. */
function commandTokens(cmd) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/**
 * runsScript(cmd, signature) — is this process ACTUALLY running that script?
 *
 * FOUND BY THE FIRST DRY RUN AGAINST THE REAL MACHINE (2026-08-01). The original check was a plain
 * substring test, and it verified pid 11148 as the waakvlam. That PID was the Git-bash shell that once
 * LAUNCHED the supervisor, so the script path appears inside its huge `bash -c "..."` argument. A command
 * line that MENTIONS a script is not a process that RUNS it, and stopping that shell would have been the
 * 2026-07-29 mistake in a new costume.
 *
 * FOUND BY THE WITNESS AUDIT OF THAT VERY FIX, the same day. The rule above was "the script appears as
 * SOME argument token", which closed the shell variant and left the node variant wide open: a witness ran
 * `node mentions.js <supervisor path>` and the switch verified it and planned a real taskkill with /F
 * escalation, printing an evidence line that was simply untrue. Node executes only its FIRST non-flag
 * argument, so any helper that is HANDED the path satisfied the old rule by coincidence.
 *
 * So two structural conditions, both required:
 *   · the EXECUTABLE (token 0) is node — not a shell, not a launcher wrapper like nohup;
 *   · the FIRST non-flag argument — the one node actually executes — ends in the signature path.
 * Both checks narrow the target set and never widen it: they can only ever refuse a PID that the
 * structured lookup already found. That is the opposite of selecting a victim by process name.
 */

/** Node options that swallow the NEXT token as their value. Their value is never the executed script, so
 *  a signature landing there proves nothing (`node -p <path>` prints a path; it does not run it). */
const VALUE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-r', '--require', '--import',
  '--loader', '--experimental-loader', '--conditions', '-C']);

/** The token node would actually execute: the first argument that is not a flag and not a flag's value. */
function executedScript(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('-')) { if (VALUE_FLAGS.has(tok)) i++; continue; }
    return tok;
  }
  return null;
}

function runsScript(cmd, signature) {
  const tokens = commandTokens(cmd);
  if (tokens.length < 2) return false;
  const exe = norm(tokens[0]).split('/').pop();
  if (!/^node(\.exe)?$/.test(exe)) return false;
  const script = executedScript(tokens);
  return script !== null && norm(script).endsWith(signature);
}

// ---- real Windows collectors (all injectable; never called by the tests) ------------------------------
function ps(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function asArray(parsed) { return parsed === null || parsed === undefined ? [] : (Array.isArray(parsed) ? parsed : [parsed]); }

/** The process table, from the OS, with parent links. Structured source — no name matching happens here;
 *  the Name field is carried only so a human report can show it. */
function listProcessesWindows() {
  const out = ps('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3');
  return asArray(JSON.parse(out || 'null')).map((p) => ({
    pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId), name: String(p.Name || ''), cmd: String(p.CommandLine || ''),
  })).filter((p) => Number.isFinite(p.pid));
}

/** Who actually holds the listening port. This is THE anchor for the gateway: an OS-level fact, not a guess. */
function portOwnerWindows(port) {
  const out = ps('Get-NetTCPConnection -LocalPort ' + Number(port) + " -State Listen -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique");
  const n = Number(String(out || '').trim().split(/\r?\n/)[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Only our two task names are ever queried, so the switch cannot even see the rest of the task store. */
function listTasksWindows() {
  const names = KNOWN_TASKS.map((n) => "'" + n.replace(/'/g, "''") + "'").join(',');
  const out = ps('Get-ScheduledTask -TaskName ' + names + ' -EA SilentlyContinue | ForEach-Object { [pscustomobject]@{ name = ($_.TaskPath + $_.TaskName); state = [string]$_.State; action = (($_.Actions | ForEach-Object { [string]$_.Execute + " " + [string]$_.Arguments }) -join " | ") } } | ConvertTo-Json -Compress -Depth 3');
  return asArray(JSON.parse(out || 'null')).map((t) => ({ name: String(t.name || ''), state: String(t.state || ''), action: String(t.action || '') }));
}

// ---- target resolution -------------------------------------------------------------------------------
function ancestorsOf(pid, procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set();
  let cur = byPid.get(pid);
  let guard = 0;
  while (cur && guard++ < 64) {
    seen.add(cur.pid);
    if (!cur.ppid || seen.has(cur.ppid)) break;
    cur = byPid.get(cur.ppid);
    if (cur) seen.add(cur.pid);
  }
  return seen;
}

/**
 * resolveTargets(opts) -> { root, targets, errors }
 *
 * Each target is {kind, pid|null, task|null, state, verified, evidence, why}. state is one of:
 *   'running'     — found and fully verified; the only state that can produce a step
 *   'not-running' — nothing matched; this is a normal, quiet outcome, not an error
 *   'refused'     — something matched but did NOT pass verification. Reported loudly, never stopped
 *   'skipped'     — it is this process or one of its ancestors (see the header's honest limitation)
 */
function resolveTargets(opts) {
  const o = opts || {};
  const root = o.root || DEFAULT_ROOT;
  const rootN = norm(root);
  const selfPid = o.selfPid || process.pid;
  const errors = [];

  let procs = [];
  try { procs = (o.listProcesses || listProcessesWindows)() || []; }
  catch (e) { errors.push('process listing failed: ' + (e && e.message)); }

  let owner = null;
  try { owner = (o.portOwner || portOwnerWindows)(o.port || GATEWAY_PORT); }
  catch (e) { errors.push('port owner lookup failed: ' + (e && e.message)); }

  let tasks = [];
  try { tasks = (o.listTasks || listTasksWindows)() || []; }
  catch (e) { errors.push('scheduled-task listing failed: ' + (e && e.message)); }

  const mine = ancestorsOf(selfPid, procs);
  mine.add(selfPid);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const errSuffix = errors.length ? ' [' + errors.join('; ') + ']' : '';

  /** anchored(proc) -> the reason this PID is provably inside THIS project, or null. Three independent
   *  signals, because the real supervisor is started with a RELATIVE script path and therefore cannot be
   *  anchored from its command line alone. */
  function anchored(proc, extra) {
    if (norm(proc.cmd).includes(rootN)) return 'its command line contains the project root';
    if (proc.cwd && norm(proc.cwd) === rootN) return 'its working directory is the project root';
    if (extra) return extra;
    return null;
  }

  const targets = [];

  // --- the gateway: anchored on the OS-level fact of who holds the listening port ---------------------
  const gwProc = owner ? byPid.get(Number(owner)) : null;
  if (!owner) {
    targets.push({ kind: 'gateway', pid: null, task: null, state: 'not-running', verified: false,
      evidence: 'nothing is listening on 127.0.0.1:' + (o.port || GATEWAY_PORT), why: null });
  } else if (!gwProc) {
    targets.push({ kind: 'gateway', pid: Number(owner), task: null, state: 'refused', verified: false,
      evidence: 'port ' + (o.port || GATEWAY_PORT) + ' is held by pid ' + owner,
      why: 'that pid is not in the process table, so its command line could not be verified' + errSuffix });
  } else if (!runsScript(gwProc.cmd, SIGNATURES.gateway)) {
    targets.push({ kind: 'gateway', pid: gwProc.pid, task: null, state: 'refused', verified: false,
      evidence: 'pid ' + gwProc.pid + ' is listening on port ' + (o.port || GATEWAY_PORT) + ': ' + gwProc.cmd,
      why: 'its command line does not run ' + SIGNATURES.gateway + ', so this is not our gateway and will not be touched' });
  } else if (!anchored(gwProc)) {
    targets.push({ kind: 'gateway', pid: gwProc.pid, task: null, state: 'refused', verified: false,
      evidence: 'pid ' + gwProc.pid + ' listening on port ' + (o.port || GATEWAY_PORT) + ': ' + gwProc.cmd,
      why: 'it runs a gateway, but not one anchored to this project root (' + root + ')' });
  } else if (mine.has(gwProc.pid)) {
    targets.push({ kind: 'gateway', pid: gwProc.pid, task: null, state: 'skipped', verified: false,
      evidence: 'pid ' + gwProc.pid + ' listening on port ' + (o.port || GATEWAY_PORT),
      why: 'it is this process or one of its ancestors - run the kill switch from a terminal, not through the gateway' });
  } else {
    targets.push({ kind: 'gateway', pid: gwProc.pid, task: null, state: 'running', verified: true,
      evidence: 'pid ' + gwProc.pid + ' is listening on port ' + (o.port || GATEWAY_PORT) + ' and runs ' + SIGNATURES.gateway +
        ' (' + anchored(gwProc) + ')', why: null });
  }
  const verifiedGateway = targets.find((t) => t.kind === 'gateway' && t.verified) || null;

  // --- the waakvlam: script signature + a root anchor, where being the gateway's parent counts ---------
  const svCandidates = procs.filter((p) => runsScript(p.cmd, SIGNATURES.supervisor));
  if (!svCandidates.length) {
    targets.push({ kind: 'supervisor', pid: null, task: null, state: 'not-running', verified: false,
      evidence: 'no process is running ' + SIGNATURES.supervisor + errSuffix, why: null });
  } else {
    for (const p of svCandidates) {
      const parentEvidence = verifiedGateway && verifiedGateway.pid && byPid.get(verifiedGateway.pid) &&
        byPid.get(verifiedGateway.pid).ppid === p.pid ? 'it is the parent of the verified gateway pid ' + verifiedGateway.pid : null;
      const anchor = anchored(p, parentEvidence);
      if (mine.has(p.pid)) {
        targets.push({ kind: 'supervisor', pid: p.pid, task: null, state: 'skipped', verified: false,
          evidence: 'pid ' + p.pid + ' runs ' + SIGNATURES.supervisor,
          why: 'it is this process or one of its ancestors' });
      } else if (!anchor) {
        targets.push({ kind: 'supervisor', pid: p.pid, task: null, state: 'refused', verified: false,
          evidence: 'pid ' + p.pid + ': ' + p.cmd,
          why: 'it runs a supervisor, but nothing anchors it to this project root (' + root + ')' });
      } else {
        targets.push({ kind: 'supervisor', pid: p.pid, task: null, state: 'running', verified: true,
          evidence: 'pid ' + p.pid + ' runs ' + SIGNATURES.supervisor + ' (' + anchor + ')' +
            (parentEvidence && anchor !== parentEvidence ? '; ' + parentEvidence : ''), why: null });
      }
    }
  }

  // --- the Discord service: script signature AND being the verified gateway's child -------------------
  const dcCandidates = procs.filter((p) => runsScript(p.cmd, SIGNATURES.discord));
  if (!dcCandidates.length) {
    targets.push({ kind: 'discord', pid: null, task: null, state: 'not-running', verified: false,
      evidence: 'no process is running ' + SIGNATURES.discord + errSuffix, why: null });
  } else {
    for (const p of dcCandidates) {
      const isChild = verifiedGateway && p.ppid === verifiedGateway.pid;
      if (mine.has(p.pid)) {
        targets.push({ kind: 'discord', pid: p.pid, task: null, state: 'skipped', verified: false,
          evidence: 'pid ' + p.pid + ' runs ' + SIGNATURES.discord, why: 'it is this process or one of its ancestors' });
      } else if (!isChild) {
        targets.push({ kind: 'discord', pid: p.pid, task: null, state: 'refused', verified: false,
          evidence: 'pid ' + p.pid + ': ' + p.cmd,
          why: 'it is not a child of the verified gateway' + (verifiedGateway ? ' (pid ' + verifiedGateway.pid + ')' : ' (no verified gateway)') +
            ', so its parentage does not prove it is ours' });
      } else if (!anchored(p, 'it is a child of the verified gateway pid ' + verifiedGateway.pid)) {
        targets.push({ kind: 'discord', pid: p.pid, task: null, state: 'refused', verified: false,
          evidence: 'pid ' + p.pid + ': ' + p.cmd, why: 'not anchored to this project root (' + root + ')' });
      } else {
        targets.push({ kind: 'discord', pid: p.pid, task: null, state: 'running', verified: true,
          evidence: 'pid ' + p.pid + ' runs ' + SIGNATURES.discord + ' and is a child of the verified gateway pid ' + verifiedGateway.pid, why: null });
      }
    }
  }

  // --- the scheduled tasks: our two names only, and only when the action points into this project ------
  for (const known of KNOWN_TASKS) {
    const found = tasks.find((t) => String(t.name || '').replace(/^\\+/, '').toLowerCase() === known.toLowerCase());
    if (!found) {
      targets.push({ kind: 'task', pid: null, task: known, state: 'not-running', verified: false,
        evidence: 'scheduled task ' + known + ' is not registered' + errSuffix, why: null });
    } else if (!norm(found.action).includes(rootN)) {
      targets.push({ kind: 'task', pid: null, task: found.name, state: 'refused', verified: false,
        evidence: 'task ' + found.name + ' runs: ' + found.action,
        why: 'its action does not point inside this project root (' + root + '), so it is not ours to disable' });
    } else {
      targets.push({ kind: 'task', pid: null, task: found.name, state: 'running', verified: true,
        evidence: 'task ' + found.name + ' (' + (found.state || 'unknown state') + ') runs: ' + found.action, why: null });
    }
  }

  return { root, port: o.port || GATEWAY_PORT, targets, errors };
}

// ---- the plan ----------------------------------------------------------------------------------------
/**
 * planStop(opts) -> { root, targets, errors, steps }
 * One step per VERIFIED target, in TARGET_KINDS order. A refused, skipped or absent target yields no step
 * at all — that is what "refused" has to mean for this to be safe.
 *
 * Process steps are a graceful terminate on the exact PID, with a declared escalation to a forced
 * terminate on that SAME exact PID. No /T: a tree kill would reach PIDs that were never verified.
 */
function planStop(opts) {
  const r = resolveTargets(opts);
  const steps = [];
  for (const kind of TARGET_KINDS) {
    for (const t of r.targets.filter((x) => x.kind === kind && x.verified)) {
      if (kind === 'task') {
        steps.push({ kind, task: t.task, pid: null, cmd: 'schtasks', args: ['/Change', '/TN', t.task, '/DISABLE'],
          describe: 'disable scheduled task ' + t.task + ' (disable, never delete - it must be reversible)' });
      } else {
        steps.push({ kind, pid: t.pid, task: null, cmd: 'taskkill', args: ['/PID', String(t.pid)],
          escalation: { cmd: 'taskkill', args: ['/PID', String(t.pid), '/F'] },
          describe: 'stop the ' + kind + ' on exact pid ' + t.pid + ' (' + t.evidence + ')' });
      }
    }
  }
  return { root: r.root, port: r.port, targets: r.targets, errors: r.errors, steps };
}

// ---- execution ---------------------------------------------------------------------------------------
function realExec(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8' });
    return { ok: true, code: 0, stdout: String(stdout || ''), stderr: '' };
  } catch (e) {
    return { ok: false, code: (e && typeof e.status === 'number') ? e.status : 1, stdout: String((e && e.stdout) || ''), stderr: String((e && (e.stderr || e.message)) || '') };
  }
}

function stillAlive(pid, opts) {
  try { return ((opts.listProcesses || listProcessesWindows)() || []).some((p) => p.pid === pid); }
  catch { return false; }
}

/**
 * realSpawnDetached(cmd, args) — start a LONG-LIVED service and do not wait for it.
 * Found by the first live firing (2026-08-02): `restore` started the waakvlam with the same blocking
 * execFileSync it uses for schtasks, and then sat there forever — the supervisor is a daemon that by
 * design never exits. The restore itself worked (gateway back on 4100, tasks re-enabled) but the command
 * never returned, so it also never reached the line that clears the ledger. A daemon gets spawned
 * detached, with its stdio ignored and its handle unref'd, so the parent can finish its job and exit.
 */
function realSpawnDetached(cmd, args) {
  try {
    const { spawn } = require('child_process'); // lazy — only restore needs it
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, pid: child.pid, detached: true };
  } catch (e) {
    return { ok: false, detached: true, reason: 'could not spawn: ' + (e && e.message) };
  }
}

/**
 * run(opts) -> { ok, dry_run, root, targets, errors, steps, state_file }
 * DRY RUN UNLESS opts.confirm === true. A dry run executes nothing and writes nothing — not even the state
 * ledger, because it changed nothing and may therefore claim nothing.
 */
function run(opts) {
  const o = opts || {};
  const plan = planStop(o);
  const dry = o.confirm !== true;
  const exec = o.exec || realExec;
  const stateFile = o.stateFile || defaultStateFile(plan.root);

  if (dry) return Object.assign({ ok: true, dry_run: true, state_file: stateFile }, plan);

  const disabled = [];
  const stopped = [];
  for (const step of plan.steps) {
    step.result = exec(step.cmd, step.args);
    if (step.kind === 'task') {
      if (step.result.ok) disabled.push(step.task);
    } else {
      // Escalate ONLY against the same exact PID, and only when it is demonstrably still there.
      if (step.escalation && stillAlive(step.pid, o)) {
        step.escalation.result = exec(step.escalation.cmd, step.escalation.args);
      }
      // THE GOAL IS "THIS PID IS GONE", NOT "THE COMMAND EXITED 0" (found by the first live firing,
      // 2026-08-02). Stopping the supervisor cascades to its children, so their own taskkill can answer
      // "process not found" (exit 128) for a process it had just successfully brought down — and the run
      // printed "-> FAILED" for two processes that were, in fact, stopped. Ask the OS instead of the exit
      // code: gone is success, alive after a failed command is an honest failure.
      const alive = stillAlive(step.pid, o);
      step.result.stopped = !alive;
      step.result.verdict = alive ? 'failed' : (step.result.ok ? 'stopped' : 'already gone');
      stopped.push({ kind: step.kind, pid: step.pid, evidence: step.describe, result: step.result });
    }
  }
  const state = {
    engaged_at: new Date().toISOString(),
    root: plan.root,
    port: plan.port,
    disabled_tasks: disabled,
    stopped,
    note: 'Written by forge-killswitch.cjs stop --confirm. `restore` re-enables ONLY the tasks listed here.',
  };
  let wrote = true;
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8'); }
  catch (e) { wrote = false; plan.errors.push('could not write the state ledger: ' + e.message); }
  return Object.assign({ ok: wrote, dry_run: false, state_file: stateFile, state }, plan);
}

// ---- the way back ------------------------------------------------------------------------------------
function readState(file) {
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (st && typeof st === 'object') ? st : null;
  } catch { return null; }
}

/**
 * restore(opts) -> { ok, dry_run, steps, reason }
 * Also a DRY RUN unless opts.confirm === true. It re-enables ONLY the tasks the ledger says this switch
 * disabled, then restarts the waakvlam — which brings the gateway back on its own. The Discord service
 * does NOT return with the gateway (project CLAUDE.md), so that step is emitted as an exact command for a
 * human to run once the gateway is healthy, rather than silently claimed.
 * With no ledger it refuses: turning things on that we never turned off is guessing.
 */
function restore(opts) {
  const o = opts || {};
  const root = o.root || DEFAULT_ROOT;
  const stateFile = o.stateFile || defaultStateFile(root);
  const st = readState(stateFile);
  if (!st) {
    return { ok: false, dry_run: o.confirm !== true, steps: [], state_file: stateFile,
      reason: 'no kill-switch state ledger at ' + stateFile + ' — there is nothing this switch is known to have turned off, and guessing is not restoring' };
  }

  const steps = [];
  for (const task of (st.disabled_tasks || [])) {
    steps.push({ kind: 'task', task, cmd: 'schtasks', args: ['/Change', '/TN', task, '/ENABLE'],
      describe: 're-enable scheduled task ' + task });
  }
  const supervisor = path.join(root, 'command-center', 'gateway', 'supervisor.mjs');
  steps.push({ kind: 'supervisor', cmd: process.execPath, args: [supervisor],
    describe: 'restart the waakvlam (' + supervisor + '); it starts the gateway on ' + (st.port || GATEWAY_PORT) + ' itself' });
  steps.push({ kind: 'discord', manual: true, cmd: null, args: [],
    describe: 'the Discord service does not come back with the gateway. Once GET http://127.0.0.1:' + (st.port || GATEWAY_PORT) +
      '/api/health returns 200, re-arm it: read the exec token from the served page and POST it to /api/discord/start with the x-cc-exec-token header (see the project CLAUDE.md).' });

  const dry = o.confirm !== true;
  if (dry) return { ok: true, dry_run: true, steps, state_file: stateFile, reason: null, state: st };

  const exec = o.exec || realExec;
  const spawnDetached = o.spawnDetached || realSpawnDetached;
  for (const s of steps) {
    if (s.manual) { s.result = { ok: true, skipped: true, reason: 'manual step - printed, not executed' }; continue; }
    // The waakvlam is a daemon: start it detached, never wait on it (see realSpawnDetached's header for
    // the live incident this comes from). Everything else here is a short command that really does exit.
    s.result = (s.kind === 'supervisor') ? spawnDetached(s.cmd, s.args) : exec(s.cmd, s.args);
  }
  // Clear the ledger so a second restore cannot double-fire against a state that no longer exists.
  let cleared = true;
  try { fs.rmSync(stateFile, { force: true }); } catch { cleared = false; }
  return { ok: true, dry_run: false, steps, state_file: stateFile, ledger_cleared: cleared, reason: null, state: st };
}

module.exports = {
  GATEWAY_PORT, KNOWN_TASKS, TARGET_KINDS, SIGNATURES,
  resolveTargets, planStop, run, restore, readState, defaultStateFile,
  listProcessesWindows, portOwnerWindows, listTasksWindows,
};

// ---- CLI ---------------------------------------------------------------------------------------------
if (require.main === module) {
  /** PLATFORM-GUARD (2026-08-13, fresh-install audit): elke echte collector hieronder spawnt
   *  powershell/taskkill/schtasks — Windows-only. De testsuite injecteert die collectors en raakt
   *  de echte paden nooit, dus zij bleef groen op elk OS en verhulde dat de tool op macOS/Linux
   *  crasht met `spawn powershell ENOENT`. Liever eerlijk weigeren met uitleg dan een cryptische
   *  crash: de rest van Forge is platformneutraal, deze ene tool is dat aantoonbaar niet. */
  if (process.platform !== 'win32') {
    const uitleg = 'forge-killswitch is Windows-only: het inventariseert en stopt processen via powershell/taskkill/schtasks, waarvoor op ' + process.platform + ' geen equivalent is geïmplementeerd.';
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, supported: false, platform: process.platform, reason: uitleg }, null, 2));
    } else {
      console.error('NOT SUPPORTED ON THIS OS — ' + uitleg);
      // BEWUST geen kill-by-name-voorbeeld hier: de eigen suite verbiedt zo'n construct zelfs in de
      // brontekst, omdat naam-gebaseerd killen ook onschuldige processen raakt. Verwijs naar de
      // exacte PID-route, nooit naar een patroon dat op naam matcht.
      console.error('Stop Forge-processen op dit platform via de EXACTE PID die je zelf hebt vastgesteld (bijv. de listener op poort 4100 opzoeken met `lsof -i :4100` en precies dat proces stoppen). Stop nooit processen op naam — dat raakt ook niet-Forge-processen.');
    }
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  const confirm = argv.includes('--confirm');
  const json = argv.includes('--json');
  function arg(name, dflt) { const i = argv.indexOf('--' + name); return (i > -1 && argv[i + 1] !== undefined) ? argv[i + 1] : dflt; }
  const base = { root: path.resolve(arg('root', DEFAULT_ROOT)), stateFile: arg('state', undefined), confirm };

  function printTargets(r) {
    console.log('TARGETS (project root: ' + r.root + ', gateway port: ' + r.port + ')');
    for (const t of r.targets) {
      const who = t.pid !== null && t.pid !== undefined ? 'pid ' + t.pid : (t.task || '-');
      console.log('  [' + t.state.toUpperCase().padEnd(11) + '] ' + t.kind.padEnd(10) + ' ' + who);
      if (t.evidence) console.log('               evidence: ' + t.evidence);
      if (t.why) console.log('               NOT A TARGET: ' + t.why);
    }
    for (const e of (r.errors || [])) console.log('  !! ' + e);
  }
  function printSteps(steps, dry) {
    console.log('');
    console.log(dry ? 'WOULD RUN (dry run - nothing was executed):' : 'EXECUTED:');
    if (!steps.length) console.log('  (nothing - no verified target)');
    for (const s of steps) {
      const line = s.manual ? '(manual) ' + s.describe : [s.cmd].concat(s.args).join(' ');
      console.log('  ' + line);
      if (!s.manual) console.log('      ' + s.describe);
      if (s.escalation) console.log('      escalation if it survives: ' + [s.escalation.cmd].concat(s.escalation.args).join(' '));
      // Print the VERDICT the run computed (did the pid actually go?), not the raw exit code. A cascade
      // makes a child's own taskkill answer "not found" for a process that is genuinely stopped, and the
      // first live firing printed FAILED for two processes it had just successfully brought down. The
      // command's stderr is still shown for 'already gone' so nothing is hidden — only re-labelled truthfully.
      if (s.result) {
        const raw = String(s.result.stderr || '').trim();
        if (s.result.verdict === 'already gone') console.log('      -> ok (already gone — the parent stop took it; OS reports: ' + raw + ')');
        else if (s.result.verdict === 'failed') console.log('      -> FAILED, pid STILL ALIVE, code ' + s.result.code + ': ' + raw);
        else if (s.result.ok) console.log('      -> ok');
        else console.log('      -> FAILED code ' + s.result.code + ': ' + raw);
      }
    }
  }

  try {
    if (cmd === 'status') {
      const r = resolveTargets(base);
      if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
      printTargets(r);
      process.exit(0);
    }
    if (cmd === 'stop') {
      const r = run(base);
      if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
      printTargets(r);
      printSteps(r.steps, r.dry_run);
      console.log('');
      if (r.dry_run) console.log('DRY RUN. Nothing was stopped, disabled or written. Add --confirm to actually do this.');
      else console.log('Stopped. Ledger: ' + r.state_file + '  |  undo with: node .claude/forge-bin/forge-killswitch.cjs restore --confirm');
      process.exit(r.ok ? 0 : 1);
    }
    if (cmd === 'restore') {
      const r = restore(base);
      if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
      if (!r.ok) { console.log('RESTORE REFUSED: ' + r.reason); process.exit(1); }
      printSteps(r.steps, r.dry_run);
      console.log('');
      console.log(r.dry_run ? 'DRY RUN. Nothing was restored. Add --confirm to actually do this.' : 'Restored. The ledger has been cleared.');
      process.exit(0);
    }
    console.error('usage: forge-killswitch.cjs status|stop|restore [--confirm] [--root <dir>] [--state <file>] [--json]');
    process.exit(1);
  } catch (e) {
    console.error('forge-killswitch: unexpected error - ' + (e && e.message));
    process.exit(1);
  }
}
