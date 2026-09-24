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
 * Read-only by design: it never runs `mark`, `init-keys`, `place-keys` or `self-heal` (those write). The one
 * writing command it runs is `gitignore` (the /forge checkpoint pre-step, review-boss M5) — only inside its own
 * throwaway temp project, which it deletes afterwards.
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

// ---- gitignore (M5): the git-checkpoint pre-step keeps secret-shaped names out of git, append-only ----
const gi = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-gitignore-'));
try {
  const giFile = path.join(gi, '.gitignore');
  const lines = () => fs.readFileSync(giFile, 'utf8').split(/\r?\n/).map((l) => l.trim());
  const first = run(['gitignore', '--project', gi, '--json']);
  let j = null; try { j = JSON.parse(first.stdout); } catch { /* not json */ }
  t('gitignore on a bare folder creates .gitignore with every secret pattern (exit 0)', first.status === 0 && !!j && j.created === true
    && ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'credentials*.json', 'secrets/', '!.env.example'].every((p) => lines().includes(p)), first.stdout + first.stderr);
  t('!.env.example comes after the last .env.* line (git: last match wins)', lines().lastIndexOf('!.env.example') > lines().lastIndexOf('.env.*'));
  const before = fs.readFileSync(giFile, 'utf8');
  const again = run(['gitignore', '--project', gi]);
  t('a second run changes nothing (idempotent) and says so', again.status === 0 && fs.readFileSync(giFile, 'utf8') === before && /no changes needed/.test(again.stdout), again.stdout);

  fs.writeFileSync(giFile, 'node_modules/\n!.env.example\n.env\n');
  run(['gitignore', '--project', gi]);
  const after = lines();
  t('an existing .gitignore keeps its own lines first (append-only) and gets the negation re-appended after .env.*',
    after[0] === 'node_modules/' && after[1] === '!.env.example' && after.lastIndexOf('!.env.example') > after.lastIndexOf('.env.*'), after.join(' | '));

  const git = spawnSync('git', ['init', '-q'], { cwd: gi, encoding: 'utf8' });
  if (!git.error && git.status === 0) {
    const ignored = (p) => spawnSync('git', ['check-ignore', '-q', '--', p], { cwd: gi, encoding: 'utf8' }).status === 0;
    t('git itself agrees: .env.production, server.pem, id_rsa, credentials-prod.json, secrets/x are ignored; .env.example is not',
      ['.env.production', 'server.pem', 'api.key', 'id_rsa', 'credentials-prod.json', 'secrets/x.txt', '.env'].every(ignored) && !ignored('.env.example'));
  } else {
    console.log('  skip git check-ignore probe (git not available: ' + (git.error ? git.error.code : 'exit ' + git.status) + ')');
  }
} finally {
  try { fs.rmSync(gi, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
