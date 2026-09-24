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
 * throwaway temp project, which it deletes afterwards. `checkpoint-scan` (Codex recheck 2026-09-24,
 * SECRET-CHECKPOINT) is read-only (it never stages anything) and is also exercised here, plus
 * `protectSecrets()`'s defeating-negation detection/repair, both against throwaway temp projects only.
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
    && ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'credentials*.json', 'secrets/', '!.env.example'].every((p) => lines().includes(p)), first.stdout + first.stderr);
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
  const gitAvailable = !git.error && git.status === 0;
  if (gitAvailable) {
    const ignored = (p) => spawnSync('git', ['check-ignore', '-q', '--', p], { cwd: gi, encoding: 'utf8' }).status === 0;
    t('git itself agrees: .env.production, server.pem, id_rsa, id_ed25519, credentials-prod.json, secrets/x are ignored; .env.example is not',
      ['.env.production', 'server.pem', 'api.key', 'id_rsa', 'id_ed25519', 'credentials-prod.json', 'secrets/x.txt', '.env'].every(ignored) && !ignored('.env.example'));
  } else {
    console.log('  skip git check-ignore probe (git not available: ' + (git.error ? git.error.code : 'exit ' + git.status) + ')');
  }
} finally {
  try { fs.rmSync(gi, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---- SECRET-CHECKPOINT (Codex recheck 2026-09-24): a pre-existing negation must be DETECTED and REPAIRED,
// never silently left in place ----
const setup = require('./forge-setup.cjs');
const negDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-negation-'));
try {
  const giFile = path.join(negDir, '.gitignore');
  // Every required pattern is ALREADY present, but a negation for id_rsa sits AFTER it -> defeats it under
  // git's last-match-wins rule. The exact SECRET-CHECKPOINT reproduction: "existing patterns followed by
  // negations returned ok:true, appended:[]" before this fix.
  const allPatterns = setup.REQUIRED_GITIGNORE_LINES.concat(setup.CHECKPOINT_SECRET_LINES);
  fs.writeFileSync(giFile, allPatterns.join('\n') + '\n' + setup.KEEP_NEGATION_LINE + '\n!id_rsa\n');
  const r = setup.protectSecrets(negDir);
  t('protectSecrets detects a defeating negation and reports it in `reinforced`', r.ok === true && r.reinforced.some((d) => d.pattern === 'id_rsa*'), JSON.stringify(r.reinforced));
  const lines2 = fs.readFileSync(giFile, 'utf8').split(/\r?\n/).map((l) => l.trim());
  t('the pattern is re-appended AFTER the defeating negation (protection restored)', lines2.lastIndexOf('id_rsa*') > lines2.lastIndexOf('!id_rsa'));
  if (spawnSync('git', ['init', '-q'], { cwd: negDir, encoding: 'utf8' }).status === 0) {
    const ignoredNow = spawnSync('git', ['check-ignore', '-q', '--', 'id_rsa'], { cwd: negDir, encoding: 'utf8' }).status === 0;
    t('git itself now confirms id_rsa is ignored after reinforcement', ignoredNow);
  }
  t('a call with no defeating negation reports an empty `reinforced`', setup.protectSecrets(negDir).reinforced.length === 0);
} finally {
  try { fs.rmSync(negDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---- checkpoint-scan (Codex recheck 2026-09-24): validate BEFORE staging, never stage-then-unstage ----
const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-checkpointscan-'));
try {
  t('isSecretShapedName recognizes every checkpoint pattern by basename, and leaves .env.example alone',
    ['id_rsa', 'id_ed25519', 'server.pem', 'api.key', 'credentials-prod.json', '.env.local', '.env.production'].every((n) => setup.isSecretShapedName(n))
    && setup.isSecretShapedName('nested/dir/id_ed25519') && setup.isSecretShapedName('secrets/x.txt')
    && !setup.isSecretShapedName('.env.example') && !setup.isSecretShapedName('README.md'));
  const gitInit = spawnSync('git', ['init', '-q'], { cwd: scanDir, encoding: 'utf8' });
  if (!gitInit.error && gitInit.status === 0) {
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: scanDir });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: scanDir });
    // No .gitignore protection at all yet: an untracked id_ed25519-shaped file is a real candidate and must
    // be BLOCKED, never silently staged-then-unstaged.
    fs.writeFileSync(path.join(scanDir, 'id_ed25519'), 'fake key material');
    const blockedResult = setup.scanCheckpointSecrets(scanDir);
    t('scanCheckpointSecrets blocks an unignored secret-shaped candidate BEFORE anything is staged',
      blockedResult.ok === false && blockedResult.blocked.some((b) => b.path === 'id_ed25519'), JSON.stringify(blockedResult));
    const cliBlocked = run(['checkpoint-scan', '--project', scanDir]);
    t('CLI checkpoint-scan exits 3 and names the blocked file', cliBlocked.status === 3 && /id_ed25519/.test(cliBlocked.stderr), cliBlocked.stdout + cliBlocked.stderr);
    // Now protect it (gitignore) — the same candidate is no longer blocked.
    setup.protectSecrets(scanDir);
    const cleanResult = setup.scanCheckpointSecrets(scanDir);
    t('once git-ignored, the same candidate is no longer blocked', cleanResult.ok === true && cleanResult.blocked.length === 0, JSON.stringify(cleanResult));
    const cliClean = run(['checkpoint-scan', '--project', scanDir]);
    t('CLI checkpoint-scan exits 0 once the file is git-ignored', cliClean.status === 0, cliClean.stdout + cliClean.stderr);
    // An ordinary source file is never blocked.
    fs.writeFileSync(path.join(scanDir, 'index.js'), 'console.log(1);\n');
    t('an ordinary source file is never blocked', setup.scanCheckpointSecrets(scanDir).blocked.every((b) => b.path !== 'index.js'));
  } else {
    console.log('  skip checkpoint-scan git probe (git not available)');
  }
} finally {
  try { fs.rmSync(scanDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
