#!/usr/bin/env node
'use strict';
/**
 * forge-setup.test.cjs — smoke test for the /setup-forge engine.
 *
 * WHY THIS EXISTS (external audit 2026-09-23, II-A): forge-setup.cjs shipped in v2.0.0, was deleted in
 * v2.1.0 while 35 documentation references kept calling it, and no test noticed — because there was none.
 * Every fresh install's `/setup-forge` crashed with MODULE_NOT_FOUND for two releases. This suite is the
 * tripwire: it asserts the engine exists, starts, and answers its two read-only subcommands correctly on a
 * throwaway project, so a future deletion or a broken require turns the doctor red immediately.
 * Read-only by design: it never runs `mark`, `init-keys`, `place-keys` or `self-heal` (those write).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };

const ENGINE = path.join(__dirname, 'forge-setup.cjs');
const run = (args, opts) => spawnSync(process.execPath, [ENGINE, ...args], Object.assign({ encoding: 'utf8', timeout: 60000 }, opts || {}));

console.log('forge-setup smoke tests (the /setup-forge engine)');

t('the engine file ships next to this test', fs.existsSync(ENGINE));
t('it only needs Node built-ins (no require of anything outside forge-bin)', (() => {
  const src = fs.readFileSync(ENGINE, 'utf8');
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  return reqs.every((r) => ['fs', 'os', 'path', 'child_process', 'crypto', 'readline', 'util'].includes(r) || r.startsWith('./'));
})());

const help = run([]);
t('no subcommand prints usage and exits non-zero (never silently does nothing)', help.status !== 0 && /Usage:/.test(help.stdout + help.stderr), 'exit=' + help.status);
t('usage names the documented subcommands', /status/.test(help.stdout + help.stderr) && /doctor/.test(help.stdout + help.stderr) && /mark/.test(help.stdout + help.stderr));

// a throwaway project: nothing here touches the real project or the real ~/.claude
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-smoke-'));
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
try {
  const status = run(['status', '--project', proj, '--json']);
  let statusJson = null; try { statusJson = JSON.parse(status.stdout); } catch { /* not json */ }
  t('status --json on a fresh project returns one JSON object', !!statusJson && typeof statusJson === 'object', 'exit=' + status.status + ' :: ' + (status.stdout + status.stderr).slice(0, 120));
  t('status does not crash on a project with no markers yet (fresh install is the normal case)', status.status === 0 || (!!statusJson), 'exit=' + status.status);

  const doctor = run(['doctor', '--project', proj, '--json']);
  let doctorJson = null; try { doctorJson = JSON.parse(doctor.stdout); } catch { /* not json */ }
  t('doctor --json returns one JSON object and never throws', !!doctorJson && typeof doctorJson === 'object', 'exit=' + doctor.status + ' :: ' + (doctor.stdout + doctor.stderr).slice(0, 120));

  const before = fs.readdirSync(path.join(proj, '.claude')).sort().join(',');
  run(['status', '--project', proj]);
  run(['doctor', '--project', proj]);
  const after = fs.readdirSync(path.join(proj, '.claude')).sort().join(',');
  t('status and doctor are read-only (the project .claude/ listing is unchanged)', before === after, before + ' -> ' + after);
} finally {
  try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
