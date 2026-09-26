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
    // V11 (Codex recheck 2026-09-24): --json must ALSO exit 3 on a blocked candidate — forge.md's own
    // checkpoint procedure documents `checkpoint-scan --json`, and the pre-fix code printed ok:false there
    // yet still exited 0.
    const cliBlockedJson = run(['checkpoint-scan', '--project', scanDir, '--json']);
    let blockedJson = null; try { blockedJson = JSON.parse(cliBlockedJson.stdout); } catch { /* not json */ }
    t('V11: CLI checkpoint-scan --json ALSO exits 3 on a blocked candidate (json must not bypass the exit code)',
      cliBlockedJson.status === 3 && !!blockedJson && blockedJson.ok === false && blockedJson.blocked.some((b) => b.path === 'id_ed25519'),
      cliBlockedJson.stdout + cliBlockedJson.stderr);
    // Now protect it (gitignore) — the same candidate is no longer blocked.
    setup.protectSecrets(scanDir);
    const cleanResult = setup.scanCheckpointSecrets(scanDir);
    t('once git-ignored, the same candidate is no longer blocked', cleanResult.ok === true && cleanResult.blocked.length === 0, JSON.stringify(cleanResult));
    const cliClean = run(['checkpoint-scan', '--project', scanDir]);
    t('CLI checkpoint-scan exits 0 once the file is git-ignored', cliClean.status === 0, cliClean.stdout + cliClean.stderr);
    const cliCleanJson = run(['checkpoint-scan', '--project', scanDir, '--json']);
    let cleanJson = null; try { cleanJson = JSON.parse(cliCleanJson.stdout); } catch { /* not json */ }
    t('V11: CLI checkpoint-scan --json exits 0 and reports ok:true once clean (same signal, both formats)',
      cliCleanJson.status === 0 && !!cleanJson && cleanJson.ok === true, cliCleanJson.stdout + cliCleanJson.stderr);
    // An ordinary source file is never blocked.
    fs.writeFileSync(path.join(scanDir, 'index.js'), 'console.log(1);\n');
    t('an ordinary source file is never blocked', setup.scanCheckpointSecrets(scanDir).blocked.every((b) => b.path !== 'index.js'));

    // ---- V12 (Codex recheck 2026-09-24): a failed enumeration must REFUSE, never report a clean scan ----
    const failedSpawn = setup.listCheckpointCandidates(path.join(scanDir, 'this-path-does-not-exist-' + Date.now()));
    t('V12: listCheckpointCandidates refuses (ok:false) instead of an empty list when git cannot even run (bad cwd -> spawn error)',
      failedSpawn.ok === false && failedSpawn.candidates.length === 0 && typeof failedSpawn.reason === 'string' && failedSpawn.reason.length > 0,
      JSON.stringify(failedSpawn));
    // A real "git status" failure while still a valid repo: corrupt the index so rev-parse (the repo probe)
    // still succeeds but `git status` itself exits nonzero — reproduced live: "fatal: index file smaller than
    // expected", exit 128.
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-corruptidx-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: corruptDir });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: corruptDir });
      spawnSync('git', ['config', 'user.name', 'test'], { cwd: corruptDir });
      fs.writeFileSync(path.join(corruptDir, 'a.txt'), 'hi');
      spawnSync('git', ['add', '-A'], { cwd: corruptDir });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: corruptDir });
      fs.writeFileSync(path.join(corruptDir, '.git', 'index'), 'not-a-real-index-file');
      const rp = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: corruptDir, encoding: 'utf8' });
      if (!rp.error && rp.status === 0) {
        const enumFail = setup.listCheckpointCandidates(corruptDir);
        t('V12: a real nonzero `git status` exit (corrupt index, valid repo) is refused, not reported as an empty clean list',
          enumFail.ok === false && enumFail.candidates.length === 0, JSON.stringify(enumFail));
        const scanFail = setup.scanCheckpointSecrets(corruptDir);
        t('V12: scanCheckpointSecrets propagates the enumeration failure as ok:false + gitAvailable:true + a reason (never blocked:[] treated as clean)',
          scanFail.ok === false && scanFail.gitAvailable === true && scanFail.blocked.length === 0 && typeof scanFail.reason === 'string',
          JSON.stringify(scanFail));
        const cliFail = run(['checkpoint-scan', '--project', corruptDir, '--json']);
        let failJson = null; try { failJson = JSON.parse(cliFail.stdout); } catch { /* not json */ }
        t('V12/V11: CLI checkpoint-scan on a broken enumeration exits 3 (refuses) in BOTH --json and text mode',
          cliFail.status === 3 && !!failJson && failJson.ok === false, cliFail.stdout + cliFail.stderr);
        const cliFailText = run(['checkpoint-scan', '--project', corruptDir]);
        t('  ...text mode too', cliFailText.status === 3, cliFailText.stdout + cliFailText.stderr);
      } else {
        console.log('  skip corrupt-index git probe (rev-parse itself failed on this git version)');
      }
    } finally {
      try { fs.rmSync(corruptDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } else {
    console.log('  skip checkpoint-scan git probe (git not available)');
  }
} finally {
  try { fs.rmSync(scanDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---- V13 (Codex recheck 2026-09-24): findDefeatingNegations understands real gitignore wildcard semantics,
// preferring git itself over the pure-JS fallback ----
const v13Fallback = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-v13-fallback-'));
try {
  // No .git anywhere in this throwaway temp tree -> gitDefeatingNegations cannot answer -> pure-JS fallback.
  const r1 = setup.findDefeatingNegations(v13Fallback, ['*.key', '!deploy.key'], ['*.key']);
  t('V13 (fallback, no repo): the EXACT Codex evidence — a LEADING-wildcard pattern (`*.key`) defeated by `!deploy.key` is now detected (used to return [])',
    r1.via === 'fallback' && r1.list.length === 1 && r1.list[0].pattern === '*.key' && r1.list[0].negation === '!deploy.key',
    JSON.stringify(r1));
  const r2 = setup.findDefeatingNegations(v13Fallback, ['secrets/', '!secrets/keep.txt'], ['secrets/']);
  t('V13 (fallback): a nested negation inside a directory pattern is (conservatively) flagged — the fallback does not know git\'s own "cannot re-include inside an excluded dir" rule, so it over-reports here rather than missing a real one; the git-backed path below gets this exactly right',
    r2.via === 'fallback' && r2.list.some((d) => d.pattern === 'secrets/'), JSON.stringify(r2));
  const r3 = setup.findDefeatingNegations(v13Fallback, ['id_rsa*', '!id_rsa'], ['id_rsa*']);
  t('V13 (fallback): the pre-existing trailing-wildcard case still works (no regression)',
    r3.list.some((d) => d.pattern === 'id_rsa*'), JSON.stringify(r3));
  const r4 = setup.findDefeatingNegations(v13Fallback, ['.env.*', '!.env.example'], ['.env.*']);
  t('V13 (fallback): the deliberate KEEP_NEGATION_LINE (!.env.example) is never reported as defeating anything',
    r4.list.length === 0, JSON.stringify(r4));
  const r5 = setup.findDefeatingNegations(v13Fallback, ['**/*.pem', '!nested/dir/safe.pem'], ['**/*.pem']);
  t('V13 (fallback): a best-effort `**` (cross-directory) pattern is understood, not just single-segment `*`',
    r5.list.some((d) => d.pattern === '**/*.pem'), JSON.stringify(r5));
  // V13.2 (out-p8): a slashless pattern matches at ANY depth (git treats it as if `**/` were implicitly
  // prepended) — the fallback matcher needs the SAME basename-aware fix the git-backed path needs, since it
  // shares patternMatchesName. Without it `*.key` never matched the nested candidate `config/deploy.key` at
  // all (only an exact full-string match was ever tried).
  const r6 = setup.findDefeatingNegations(v13Fallback, ['*.key', '!config/deploy.key'], ['*.key']);
  t('V13.2 (fallback, no repo): a slashless pattern (`*.key`) defeated by a NESTED negation (`!config/deploy.key`) is detected (the exact out-p8 evidence, fallback path)',
    r6.via === 'fallback' && r6.list.some((d) => d.pattern === '*.key' && d.negation === '!config/deploy.key'), JSON.stringify(r6));
} finally {
  try { fs.rmSync(v13Fallback, { recursive: true, force: true }); } catch { /* best effort */ }
}

const v13Git = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-v13-git-'));
try {
  const gitInit2 = spawnSync('git', ['init', '-q'], { cwd: v13Git, encoding: 'utf8' });
  if (!gitInit2.error && gitInit2.status === 0) {
    const giFile = path.join(v13Git, '.gitignore');
    fs.writeFileSync(giFile, '*.key\n!deploy.key\n');
    const lines = fs.readFileSync(giFile, 'utf8').split(/\r?\n/).map((l) => l.trim());
    const r1 = setup.findDefeatingNegations(v13Git, lines, ['*.key']);
    t('V13 (git-backed): asks git itself and detects the real `!deploy.key` defeat of `*.key` via:"git"',
      r1.via === 'git' && r1.list.some((d) => d.pattern === '*.key' && d.negation === '!deploy.key'), JSON.stringify(r1));
    t('  ...proven independently: git itself confirms deploy.key is NOT ignored while another *.key file still IS',
      spawnSync('git', ['check-ignore', '-q', '--no-index', '--', 'deploy.key'], { cwd: v13Git }).status === 1
      && spawnSync('git', ['check-ignore', '-q', '--no-index', '--', 'other.key'], { cwd: v13Git }).status === 0);

    // A trailing-slash DIRECTORY pattern is a special git case: git's own documented rule is that a file
    // inside an excluded DIRECTORY can never be re-included by a negation at all — so `secrets/` +
    // `!secrets/keep.txt` is NOT a real defeat (confirmed live: git still reports secrets/keep.txt ignored).
    // This is exactly the class of nuance a synthetic-sample or naive-prefix check would get wrong; asking
    // git itself gets it right for free.
    fs.writeFileSync(giFile, 'secrets/\n!secrets/keep.txt\n');
    const lines2 = fs.readFileSync(giFile, 'utf8').split(/\r?\n/).map((l) => l.trim());
    const r2 = setup.findDefeatingNegations(v13Git, lines2, ['secrets/']);
    t('V13 (git-backed): a directory-exclude pattern (`secrets/`) is correctly reported as NOT defeated by a nested negation (git\'s own rule: cannot re-include inside an excluded dir)',
      r2.via === 'git' && r2.list.length === 0, JSON.stringify(r2));
    t('  ...proven independently: git itself still reports secrets/keep.txt as ignored despite the negation',
      spawnSync('git', ['check-ignore', '-q', '--no-index', '--', 'secrets/keep.txt'], { cwd: v13Git }).status === 0);

    // A genuine nested-negation DEFEAT: `dir/*` (a wildcard glob, not a directory-exclude) legitimately CAN
    // be re-included per-file — this is the real "nested `dir/!x`" case the fix must catch.
    fs.writeFileSync(giFile, 'secrets/*\n!secrets/keep.txt\n');
    const lines2b = fs.readFileSync(giFile, 'utf8').split(/\r?\n/).map((l) => l.trim());
    const r2b = setup.findDefeatingNegations(v13Git, lines2b, ['secrets/*']);
    t('V13 (git-backed): a genuine nested negation (`secrets/*` + `!secrets/keep.txt`) IS detected as a real defeat',
      r2b.via === 'git' && r2b.list.some((d) => d.pattern === 'secrets/*' && d.negation === '!secrets/keep.txt'), JSON.stringify(r2b));
    t('  ...proven independently: git confirms secrets/keep.txt is NOT ignored while secrets/other.txt still IS',
      spawnSync('git', ['check-ignore', '-q', '--no-index', '--', 'secrets/keep.txt'], { cwd: v13Git }).status === 1
      && spawnSync('git', ['check-ignore', '-q', '--no-index', '--', 'secrets/other.txt'], { cwd: v13Git }).status === 0);

    fs.writeFileSync(giFile, '.env.*\n!.env.example\n');
    const lines3 = fs.readFileSync(giFile, 'utf8').split(/\r?\n/).map((l) => l.trim());
    const r3 = setup.findDefeatingNegations(v13Git, lines3, ['.env.*']);
    t('V13 (git-backed): the deliberate !.env.example exception is never flagged, even by the git-backed path',
      r3.via === 'git' && r3.list.length === 0, JSON.stringify(r3));

    // End-to-end through protectSecrets(): the reinforcement actually happens and negation_check_via is honest.
    fs.writeFileSync(giFile, [...setup.REQUIRED_GITIGNORE_LINES, ...setup.CHECKPOINT_SECRET_LINES, setup.KEEP_NEGATION_LINE, '!deploy.key'].join('\n') + '\n');
    const pr = setup.protectSecrets(v13Git);
    t('V13 end-to-end: protectSecrets reinforces *.key after a real `!deploy.key` negation and reports via:"git"',
      pr.ok === true && pr.negation_check_via === 'git' && pr.reinforced.some((d) => d.pattern === '*.key'), JSON.stringify(pr));
    t('  ...and git now confirms deploy.key IS ignored again after the reinforcement',
      spawnSync('git', ['check-ignore', '-q', '--', 'deploy.key'], { cwd: v13Git }).status === 0);

    // ---- V13 second Codex recheck (out-p8): "findDefeatingNegations passes ALL candidate paths to git
    // check-ignore -v --no-index — no JavaScript prefilter that drops nested candidates. Codex's fixture
    // ['*.key','!config/deploy.key'] with candidate config/deploy.key returned {list:[], via:'git'} because
    // the matcher discarded the nested candidate before git saw it; git's slashless *.key applies to
    // basenames at any depth." ----
    fs.writeFileSync(giFile, '*.key\n!config/deploy.key\n');
    fs.mkdirSync(path.join(v13Git, 'config'), { recursive: true });
    fs.writeFileSync(path.join(v13Git, 'config', 'deploy.key'), 'secret');
    fs.writeFileSync(path.join(v13Git, 'other.key'), 'x');
    const linesNested = fs.readFileSync(giFile, 'utf8').split(/\r?\n/).map((l) => l.trim());
    const rNested = setup.findDefeatingNegations(v13Git, linesNested, ['*.key']);
    t('V13.2 (the EXACT out-p8 evidence): a slashless pattern (`*.key`) defeated by a NESTED negation (`!config/deploy.key`) is detected via git — no JS prefilter drops it before git is even asked (used to return {list:[],via:"git"})',
      rNested.via === 'git' && rNested.list.some((d) => d.pattern === '*.key' && d.negation === '!config/deploy.key'), JSON.stringify(rNested));
    t('  ...proven independently: git itself confirms config/deploy.key is NOT ignored while other.key still IS',
      spawnSync('git', ['check-ignore', '-q', '--no-index', '--', 'config/deploy.key'], { cwd: v13Git }).status === 1
      && spawnSync('git', ['check-ignore', '-q', '--no-index', '--', 'other.key'], { cwd: v13Git }).status === 0);

    // End-to-end: repair the exact nested fixture through protectSecrets(), then re-run checkpoint-scan on
    // the same candidate — it must now be ACCEPTED (no longer blocked), proven with a REAL temp git repo,
    // never a code read alone.
    fs.writeFileSync(giFile, [...setup.REQUIRED_GITIGNORE_LINES, ...setup.CHECKPOINT_SECRET_LINES, setup.KEEP_NEGATION_LINE, '!config/deploy.key'].join('\n') + '\n');
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: v13Git });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: v13Git });
    const beforeRepair = setup.scanCheckpointSecrets(v13Git);
    t('V13.2 end-to-end (before repair): the untracked nested candidate is BLOCKED — the negation genuinely defeats it right now',
      beforeRepair.ok === false && beforeRepair.blocked.some((b) => b.path === 'config/deploy.key'), JSON.stringify(beforeRepair));
    const prNested = setup.protectSecrets(v13Git);
    t('V13.2 end-to-end: protectSecrets reinforces *.key after the real nested `!config/deploy.key` negation, via:"git"',
      prNested.ok === true && prNested.negation_check_via === 'git' && prNested.reinforced.some((d) => d.pattern === '*.key' && d.negation === '!config/deploy.key'),
      JSON.stringify(prNested));
    t('  ...and git now confirms config/deploy.key IS ignored again after the repair',
      spawnSync('git', ['check-ignore', '-q', '--', 'config/deploy.key'], { cwd: v13Git }).status === 0);
    const afterRepair = setup.scanCheckpointSecrets(v13Git);
    t('V13.2 end-to-end (after repair): the SAME checkpoint scan now ACCEPTS the candidate — no longer blocked',
      afterRepair.ok === true && afterRepair.blocked.every((b) => b.path !== 'config/deploy.key'), JSON.stringify(afterRepair));
  } else {
    console.log('  skip V13 git-backed probes (git not available)');
  }
} finally {
  try { fs.rmSync(v13Git, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---- N9 laptop re-audit 2026-09-26: readForgeVersion reads the REAL installer marker, never "unknown" on a
// real install ----
const verDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-version-'));
try {
  t('readForgeVersion reports "unknown" when neither .claude/FORGE_VERSION.json nor a VERSION file exists',
    setup.readForgeVersion(verDir) === 'unknown');

  fs.mkdirSync(path.join(verDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(verDir, '.claude', 'FORGE_VERSION.json'), JSON.stringify({ forge_version: '2.8.0', synced_at: '2026-09-26T00:00:00Z' }));
  t('readForgeVersion reads the real installer marker .claude/FORGE_VERSION.json (forge_version) — this is the exact N9 fix: install.ps1 writes THIS file into the target project, never a bare VERSION file',
    setup.readForgeVersion(verDir) === '2.8.0');

  fs.writeFileSync(path.join(verDir, 'VERSION'), '9.9.9-should-not-win\n');
  t('the installer marker still wins over a stray VERSION file when both exist', setup.readForgeVersion(verDir) === '2.8.0');

  fs.rmSync(path.join(verDir, '.claude', 'FORGE_VERSION.json'));
  t('falls back to a plain VERSION file when the installer marker is absent (e.g. a source checkout)', setup.readForgeVersion(verDir) === '9.9.9-should-not-win');

  fs.writeFileSync(path.join(verDir, '.claude', 'FORGE_VERSION.json'), '{ not valid json');
  t('a malformed FORGE_VERSION.json never throws — falls back to the VERSION file instead', setup.readForgeVersion(verDir) === '9.9.9-should-not-win');

  fs.mkdirSync(path.join(verDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(verDir, '.claude', 'FORGE_VERSION.json'), JSON.stringify({ forge_version: '2.8.0' }));
  const throwawayGlobalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-version-global-'));
  const markResult = setup.mark(verDir, { name: 'x', lang: 'en' }, throwawayGlobalDir); // never touch the real ~/.claude
  const projMarker = JSON.parse(fs.readFileSync(markResult.projectMarkerPath, 'utf8'));
  t('mark() now records the real version in the project marker instead of "unknown" (the exact N8/N9 symptom)', projMarker.version === '2.8.0', JSON.stringify(projMarker));
  try { fs.rmSync(throwawayGlobalDir, { recursive: true, force: true }); } catch { /* best effort */ }
} finally {
  try { fs.rmSync(verDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---- N9 laptop re-audit 2026-09-26: unstageTrackedEnv — Forge untracks .env ITSELF (git rm --cached),
// instead of handing the owner "run git rm --cached .env" to type ----
const fixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-unstage-'));
try {
  const gitInit3 = spawnSync('git', ['init', '-q'], { cwd: fixDir, encoding: 'utf8' });
  if (!gitInit3.error && gitInit3.status === 0) {
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: fixDir });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: fixDir });
    fs.writeFileSync(path.join(fixDir, '.env'), 'REAL_SECRET=do-not-lose-me\n');
    spawnSync('git', ['add', '-A'], { cwd: fixDir });
    spawnSync('git', ['commit', '-q', '-m', 'oops committed .env'], { cwd: fixDir });
    t('.env is confirmed tracked before the fix (real repro, not assumed)', setup.checkEnvTracked(fixDir).tracked === true);

    const u = setup.unstageTrackedEnv(fixDir);
    t('unstageTrackedEnv succeeds and reports it unstaged the file', u.ok === true && u.unstaged === true, JSON.stringify(u));
    t('after the fix, .env is no longer tracked by git', setup.checkEnvTracked(fixDir).tracked === false);
    t('the .env FILE ITSELF is untouched on disk — this only removes it from the git INDEX, never from the working tree',
      fs.existsSync(path.join(fixDir, '.env')) && fs.readFileSync(path.join(fixDir, '.env'), 'utf8') === 'REAL_SECRET=do-not-lose-me\n');

    t('unstageTrackedEnv on an already-untracked .env is a harmless no-op (idempotent)',
      setup.unstageTrackedEnv(fixDir).alreadyUntracked === true);

    // Real CLI path: `guard --fix` — this is what the AGENT runs instead of handing the human a git command.
    fs.writeFileSync(path.join(fixDir, '.env'), 'REAL_SECRET=again\n');
    spawnSync('git', ['add', '-A'], { cwd: fixDir });
    spawnSync('git', ['commit', '-q', '-m', 'oops again'], { cwd: fixDir });
    const cliNoFix = run(['guard', '--project', fixDir]);
    t('CLI `guard` (no --fix) still hard-stops with exit 3 and never runs git itself unasked', cliNoFix.status === 3 && setup.checkEnvTracked(fixDir).tracked === true);
    t('the no-fix warning names --fix, never a raw git command for a human to type', /--fix/.test(cliNoFix.stderr) && !/git rm/.test(cliNoFix.stderr));
    const cliFix = run(['guard', '--fix', '--project', fixDir]);
    t('CLI `guard --fix` exits 0 and actually untracks .env', cliFix.status === 0 && setup.checkEnvTracked(fixDir).tracked === false, cliFix.stdout + cliFix.stderr);
  } else {
    console.log('  skip unstageTrackedEnv git probes (git not available)');
  }
} finally {
  try { fs.rmSync(fixDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
