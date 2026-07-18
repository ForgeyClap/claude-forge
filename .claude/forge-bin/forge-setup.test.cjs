#!/usr/bin/env node
'use strict';
/**
 * Offline, hermetic tests for forge-setup.cjs — every fixture lives under a throwaway
 * fs.mkdtempSync(os.tmpdir()) directory passed in as an explicit `projectDir` argument (or via the
 * CLI's --project flag). Never touches the real repo this test file ships in, and never touches the
 * real user's ~/.claude (the global marker dir is always redirected via FORGE_SETUP_GLOBAL_ROOT or an
 * explicit globalDir argument). Exit 0 = all pass.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLI_PATH = path.join(__dirname, 'forge-setup.cjs');
const S = require('./forge-setup.cjs');

let pass = 0, fail = 0, skip = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };
const skipT = (name, reason) => { skip++; console.log('  SKIP ' + name + ' (' + reason + ')'); };

console.log('forge-setup offline tests');

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-setup-test-')); }
function readFile(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }

// git availability (used to gate the "refuse if .env tracked" fixtures — these need real git)
const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8' });
const GIT_OK = !gitProbe.error && gitProbe.status === 0;

function gitFixtureWithTrackedEnv(dir) {
  fs.writeFileSync(path.join(dir, '.env'), 'DUMMY_PLACEHOLDER=synthetic-non-secret-value\n', 'utf8');
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'forge-test@example.invalid');
  git('config', 'user.name', 'Forge Test');
  git('add', '.env');
  git('commit', '-q', '-m', 'add env (synthetic test fixture, not a real secret)');
}

function runCli(args, projectDir, envOverrides) {
  return spawnSync(process.execPath, [CLI_PATH, ...args, '--project', projectDir], {
    encoding: 'utf8',
    env: { ...process.env, ...(envOverrides || {}) },
  });
}

// =====================================================================================================
// 1) status() on a never-configured project
// =====================================================================================================
{
  const dir = freshDir();
  const gDir = freshDir('forge-setup-global-');
  const s = S.status(dir, gDir);
  t('1a fresh project is NOT onboarded', s.onboarded === false);
  t('1b default lang is "en"', s.lang === 'en');
  t('1c name is null before onboarding', s.name === null);
}

// =====================================================================================================
// 2) guard() — gitignore creation, append-once idempotency
// =====================================================================================================
{
  const dir = freshDir();
  t('2a no .gitignore before guard()', !fs.existsSync(path.join(dir, '.gitignore')));
  const g1 = S.guard(dir);
  t('2b guard() creates .gitignore when absent', g1.created === true);
  t('2c guard() is not blocked (no .env at all)', g1.ok === true && g1.tracked === false);
  const content1 = readFile(path.join(dir, '.gitignore'));
  for (const line of ['.env', '.env.local', '.env.*.local', '.env.forge-setup', '!.env.example']) {
    t('2d gitignore contains required line: ' + line, content1.split(/\r?\n/).map((l) => l.trim()).includes(line));
  }
  // idempotent: re-running appends nothing more
  const g2 = S.guard(dir);
  t('2e second guard() call: created=false (file already existed)', g2.created === false);
  t('2f second guard() call: nothing new appended (idempotent)', g2.appended.length === 0);
  const content2 = readFile(path.join(dir, '.gitignore'));
  t('2g gitignore content unchanged by the idempotent re-run', content1 === content2);
}

// 2h) guard() on a PARTIAL pre-existing gitignore only appends what's missing (grep-before-append)
{
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nnode_modules/\n', 'utf8');
  const g = S.guard(dir);
  t('2h existing lines are not duplicated', !g.appended.includes('.env'));
  t('2i missing required lines ARE appended', g.appended.includes('.env.local') && g.appended.includes('.env.*.local') && g.appended.includes('.env.forge-setup'));
  const content = readFile(path.join(dir, '.gitignore'));
  t('2j pre-existing unrelated line "node_modules/" preserved', content.includes('node_modules/'));
  t('2k .env line appears exactly once (no duplicate)', content.split(/\r?\n/).filter((l) => l.trim() === '.env').length === 1);
}

// =====================================================================================================
// 3) checkEnvTracked() + the hard refuse-if-tracked invariant (real git fixture)
// =====================================================================================================
if (GIT_OK) {
  const dir = freshDir();
  gitFixtureWithTrackedEnv(dir);
  const info = S.checkEnvTracked(dir);
  t('3a checkEnvTracked() detects a real committed .env as tracked', info.tracked === true);

  const g = S.guard(dir);
  t('3b guard() STILL writes .gitignore even when .env is tracked (STEP0 invariant: gitignore first)', fs.existsSync(path.join(dir, '.gitignore')));
  t('3c guard() reports ok:false + tracked:true', g.ok === false && g.tracked === true);

  const initR = S.initKeys(dir, { type: 'rag' });
  t('3d init-keys REFUSES when .env is tracked', initR.blocked === true);
  t('3e init-keys did not write a temp file when blocked', !fs.existsSync(path.join(dir, '.env.forge-setup')));

  const placeR = S.placeKeys(dir);
  t('3f place-keys REFUSES when .env is tracked', placeR.blocked === true);

  // CLI exit code 3 on the hard refuse path
  const cliGuard = runCli(['guard'], dir);
  t('3g CLI guard exits with code 3 when .env is tracked', cliGuard.status === 3);
  t('3h CLI guard prints a loud warning mentioning "git rm --cached"', /git rm --cached/.test(cliGuard.stderr));
  const cliInit = runCli(['init-keys', '--type', 'rag'], dir);
  t('3i CLI init-keys exits with code 3 when .env is tracked', cliInit.status === 3);
} else {
  skipT('3 refuse-if-tracked fixtures', 'git unavailable in this environment');
}

// checkEnvTracked() on a directory with no git repo at all is permissive (nothing to refuse)
{
  const dir = freshDir();
  const info = S.checkEnvTracked(dir);
  t('3j no-git-repo dir: tracked is false (nothing to be tracked)', info.tracked === false);
}

// 3k) git-unavailable branch: temporarily blank PATH so spawnSync cannot find the git binary
{
  const dir = freshDir();
  const origPath = process.env.PATH;
  const origPathCap = process.env.Path;
  try {
    process.env.PATH = '';
    process.env.Path = '';
    const info = S.checkEnvTracked(dir);
    t('3k git-unavailable: tracked defaults to false (permissive)', info.tracked === false);
    t('3l git-unavailable: gitAvailable is false', info.gitAvailable === false);
  } finally {
    process.env.PATH = origPath;
    if (origPathCap !== undefined) process.env.Path = origPathCap; else delete process.env.Path;
  }
  // sanity: git detection recovers once PATH is restored
  const infoAfter = S.checkEnvTracked(dir);
  t('3m PATH restored: gitAvailable is true again', infoAfter.gitAvailable === true);
}

// =====================================================================================================
// 4) initKeys() — temp fill-file content, never-overwrite, per-type key selection
// =====================================================================================================
{
  const dir = freshDir();
  const r = S.initKeys(dir, { type: 'rag' });
  t('4a init-keys succeeds for a fresh project', r.ok === true && r.created === true);
  const tmpPath = path.join(dir, '.env.forge-setup');
  t('4b temp file was actually written', fs.existsSync(tmpPath));
  const content = readFile(tmpPath);
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VECTOR_DB_URL']) {
    t('4c temp file has a commented placeholder line for ' + key, content.includes(key + '='));
  }
  t('4d temp file includes a where-to-get help URL', /https:\/\//.test(content));
  t('4e placeholder lines are the KEY=  shape (blank value), not filled in', /ANTHROPIC_API_KEY=\s*$/m.test(content));

  // never overwrite non-empty temp
  fs.writeFileSync(tmpPath, 'ANTHROPIC_API_KEY=user-already-typed-something-real\n', 'utf8');
  const r2 = S.initKeys(dir, { type: 'fullstack' }); // different type on purpose
  t('4f second init-keys call is skipped (existing content preserved)', r2.skipped === true);
  t('4g the file the user was mid-editing is untouched', readFile(tmpPath).includes('user-already-typed-something-real'));
}

// 4h) website type gets an empty/optional key set (no forced prompts)
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'website' });
  const content = readFile(path.join(dir, '.env.forge-setup'));
  t('4h website type: no required keys, but the file still explains how to add one', /no required keys/i.test(content));
}

// 4i) custom --tmp filename is respected
{
  const dir = freshDir();
  const r = S.initKeys(dir, { type: 'automation', tmpName: '.env.forge-tmp' });
  t('4i custom tmp filename honored', r.path.endsWith('.env.forge-tmp'));
  t('4j custom tmp file actually exists on disk', fs.existsSync(path.join(dir, '.env.forge-tmp')));
}

// 4k) SECURITY INVARIANT: the temp file is gitignored BEFORE it (or the .env it feeds) is ever written.
// Monkeypatch fs.writeFileSync to record call ORDER, then assert .gitignore was written before the temp
// key file on a project that has neither yet.
{
  const dir = freshDir();
  const original = fs.writeFileSync;
  const order = [];
  fs.writeFileSync = function (file, ...rest) { order.push(path.basename(String(file))); return original.call(fs, file, ...rest); };
  try {
    S.initKeys(dir, { type: 'rag' });
  } finally {
    fs.writeFileSync = original;
  }
  const giIdx = order.indexOf('.gitignore');
  const tmpIdx = order.indexOf('.env.forge-setup');
  t('4k .gitignore write happens BEFORE the temp key file write (STEP0 ordering)', giIdx !== -1 && tmpIdx !== -1 && giIdx < tmpIdx);
}

// =====================================================================================================
// 5) placeKeys() — validation, move-to-.env, .env.example names-only, temp deletion, never-echo
// =====================================================================================================
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  const secretValue = 'sk-ant-REALLOOKINGSECRETVALUE1234567890';
  fs.writeFileSync(tmpPath, [
    'ANTHROPIC_API_KEY=' + secretValue,
    'OPENAI_API_KEY=REPLACE_ME',           // placeholder -> skipped
    'VECTOR_DB_URL=',                       // blank -> missing
    'CUSTOM_UNKNOWN_KEY=some-real-looking-custom-value',
  ].join('\n') + '\n', 'utf8');

  const r = S.placeKeys(dir);
  t('5a place-keys ok:true', r.ok === true);
  t('5b real value classified as stored', r.stored.includes('ANTHROPIC_API_KEY'));
  t('5c placeholder value classified as skipped', r.skipped.some((s) => s.key === 'OPENAI_API_KEY'));
  t('5d blank value classified as missing', r.missing.includes('VECTOR_DB_URL'));
  t('5e unknown/custom key with a plausible value is still stored', r.stored.includes('CUSTOM_UNKNOWN_KEY'));

  const envContent = readFile(path.join(dir, '.env'));
  t('5f .env contains the real stored value', envContent.includes('ANTHROPIC_API_KEY=' + secretValue));
  t('5g .env does NOT contain the skipped placeholder value', !envContent.includes('REPLACE_ME'));

  // BUG 2 FIX: this run has a skipped value (OPENAI_API_KEY=REPLACE_ME) alongside a stored one, so the
  // fill-file must be RETAINED (not deleted) — a valid secret the user pasted must never be silently
  // lost just because a DIFFERENT field in the same file was rejected. (Old, buggy behavior deleted the
  // temp unconditionally here; see section 12.2 for the dedicated bug-2 regression tests.)
  t('5h temp file is RETAINED (not deleted) because one value was skipped in this run', fs.existsSync(tmpPath));
  t('5i placeKeys() reports deletedTemp:false / tempRetained:true when something was skipped', r.deletedTemp === false && r.tempRetained === true);

  const exampleContent = readFile(path.join(dir, '.env.example'));
  t('5j .env.example gained the KEY NAME', exampleContent.includes('ANTHROPIC_API_KEY='));
  t('5k .env.example NEVER contains the real secret value', !exampleContent.includes(secretValue));

  // never-echo: the whole result object, stringified, must never contain the raw secret value
  // (result.stored only carries key NAMES, never values)
  t('5l placeKeys() return value never carries the raw secret (names only)', !JSON.stringify(r).includes(secretValue));
}

// 5m) append-or-update never clobbers unrelated existing .env content
{
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), '# my own comment\nUNRELATED_KEY=keep-me\nNODE_ENV=development\n', 'utf8');
  S.initKeys(dir, { type: 'fullstack' });
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'DATABASE_URL=postgres://user:pass@localhost:5432/db\n', 'utf8');
  const r = S.placeKeys(dir);
  t('5m1 placeKeys ok', r.ok === true);
  const envContent = readFile(path.join(dir, '.env'));
  t('5m2 unrelated pre-existing key preserved', envContent.includes('UNRELATED_KEY=keep-me'));
  t('5m3 unrelated pre-existing comment preserved', envContent.includes('# my own comment'));
  t('5m4 NODE_ENV preserved', envContent.includes('NODE_ENV=development'));
  t('5m5 new DATABASE_URL appended', envContent.includes('DATABASE_URL=postgres://user:pass@localhost:5432/db'));
}

// 5n) re-running place-keys UPDATES an existing key rather than duplicating the line
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'fullstack' });
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'DATABASE_URL=postgres://a:b@host/db1\n', 'utf8');
  S.placeKeys(dir);
  S.initKeys(dir, { type: 'fullstack' }); // fresh temp for round 2
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'DATABASE_URL=postgres://a:b@host/db2\n', 'utf8');
  const r2 = S.placeKeys(dir);
  t('5n1 second place-keys run ok', r2.ok === true);
  const envContent = readFile(path.join(dir, '.env'));
  const matches = envContent.split(/\r?\n/).filter((l) => l.startsWith('DATABASE_URL='));
  t('5n2 exactly one DATABASE_URL line after two runs (update, not duplicate)', matches.length === 1);
  t('5n3 the line holds the LATEST value', matches[0] === 'DATABASE_URL=postgres://a:b@host/db2');
}

// 5o) place-keys with no temp file present fails cleanly (not a crash)
{
  const dir = freshDir();
  fs.mkdirSync(dir, { recursive: true });
  const r = S.placeKeys(dir);
  t('5o place-keys with no temp file: ok:false with a clear reason', r.ok === false && /not found/.test(r.reason));
}

// 5p) idempotency: re-running place-keys on an already-emptied project is a clean no-op-ish failure, not a crash
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'website' });
  S.placeKeys(dir);
  const r2 = S.placeKeys(dir); // temp already deleted by the first run
  t('5p re-running place-keys after temp already consumed reports ok:false cleanly', r2.ok === false);
}

// =====================================================================================================
// 6) placeholder / plausibility validation (classifyValue / looksLikePlaceholder)
// =====================================================================================================
{
  const badValues = ['REPLACE_ME', '<your key here>', 'sk-ant-xxxxxxxxxxxxxxxxxxxx', 'CHANGE_ME', 'your_key_here', 'TODO', '...', 'example_api_key'];
  for (const v of badValues) {
    t('6a placeholder rejected: "' + v + '"', S.looksLikePlaceholder(v) === true);
  }
  t('6b a real-looking Anthropic key is NOT flagged as a placeholder', S.looksLikePlaceholder('sk-ant-api03-REALLOOKING1234567890abcdef') === false);

  t('6c classifyValue: blank value -> missing', S.classifyValue('ANTHROPIC_API_KEY', '').status === 'missing');
  t('6d classifyValue: placeholder -> skipped', S.classifyValue('ANTHROPIC_API_KEY', 'REPLACE_ME').status === 'skipped');
  t('6e classifyValue: wrong prefix -> skipped', S.classifyValue('ANTHROPIC_API_KEY', 'sk-1234567890123456789012').status === 'skipped');
  t('6f classifyValue: too short -> skipped', S.classifyValue('ANTHROPIC_API_KEY', 'sk-ant-short').status === 'skipped');
  t('6g classifyValue: plausible real value -> stored', S.classifyValue('ANTHROPIC_API_KEY', 'sk-ant-api03-abcdefghijklmnopqrstuvwx').status === 'stored');
  t('6h classifyValue: unknown key, plausible length -> stored', S.classifyValue('MY_CUSTOM_TOKEN', 'a-fairly-long-plausible-value').status === 'stored');
  t('6i classifyValue: unknown key, too short -> skipped', S.classifyValue('MY_CUSTOM_TOKEN', 'abc').status === 'skipped');
}

// =====================================================================================================
// 7) mark() + status() — marker read/write, idempotent merge, project + global
// =====================================================================================================
{
  const dir = freshDir();
  const gDir = freshDir('forge-setup-global-');
  const r1 = S.mark(dir, { name: 'Alex', lang: 'en', goal: 'a bakery landing page', type: 'website' }, gDir);
  t('7a mark() writes the project marker file', fs.existsSync(r1.projectMarkerPath));
  t('7b mark() writes the global marker file', fs.existsSync(r1.globalMarkerPath));
  t('7c project marker JSON round-trips answers.name', JSON.parse(readFile(r1.projectMarkerPath)).answers.name === 'Alex');
  t('7d global marker JSON round-trips defaultLanguage', JSON.parse(readFile(r1.globalMarkerPath)).defaultLanguage === 'en');

  const s1 = S.status(dir, gDir);
  t('7e status() reports onboarded:true after mark()', s1.onboarded === true);
  t('7f status() reports the correct name', s1.name === 'Alex');

  // idempotent re-run with a partial update (only name changes) preserves goal/type
  const r2 = S.mark(dir, { name: 'Alexandra', lang: 'en' }, gDir);
  t('7g re-mark: name updates', r2.project.answers.name === 'Alexandra');
  t('7h re-mark: goal from the FIRST call is preserved (merge, not overwrite)', r2.project.answers.goal === 'a bakery landing page');
  t('7i re-mark: type from the FIRST call is preserved (merge, not overwrite)', r2.project.answers.type === 'website');

  // global marker default language fallback for status() when project marker is absent
  const dir2 = freshDir();
  const gDir2 = freshDir('forge-setup-global-');
  S.mark(dir2, { name: 'Sam', lang: 'nl' }, gDir2);
  fs.rmSync(path.join(dir2, '.claude', '.forge-setup.json'), { force: true }); // simulate project marker missing, global still set
  const s2 = S.status(dir2, gDir2);
  t('7j status() falls back to the GLOBAL marker when the project marker is absent', s2.name === 'Sam' && s2.lang === 'nl');
}

// 7k) FORGE_SETUP_GLOBAL_ROOT env override works for the CLI 'mark' command too (never touches real home)
{
  const dir = freshDir();
  const gDir = freshDir('forge-setup-global-');
  const cli = runCli(['mark', '--name', 'CliUser', '--lang', 'nl', '--type', 'automation'], dir, { FORGE_SETUP_GLOBAL_ROOT: gDir });
  t('7k1 CLI mark exits 0', cli.status === 0);
  t('7k2 CLI mark actually wrote the global marker into the REDIRECTED dir', fs.existsSync(path.join(gDir, '.forge-global.json')));
  const globalMarker = JSON.parse(readFile(path.join(gDir, '.forge-global.json')));
  t('7k3 redirected global marker has the right language', globalMarker.defaultLanguage === 'nl');
}

// =====================================================================================================
// 8) selfHeal() — create-if-absent dirs, gitignore, .env.example; changed-only reporting; no clobber
// =====================================================================================================
{
  const dir = freshDir();
  const r1 = S.selfHeal(dir);
  t('8a self-heal creates required dirs on a bare project', r1.changed.some((c) => c.includes('.claude')));
  t('8b .claude/agents now exists', fs.existsSync(path.join(dir, '.claude', 'agents')));
  t('8c .claude/skills now exists', fs.existsSync(path.join(dir, '.claude', 'skills')));
  t('8d .env.example created', fs.existsSync(path.join(dir, '.env.example')));
  t('8e .gitignore created as part of self-heal', fs.existsSync(path.join(dir, '.gitignore')));

  // never clobber: put a custom marker in .env.example, re-run self-heal, confirm untouched
  fs.appendFileSync(path.join(dir, '.env.example'), '\n# MY OWN CUSTOM LINE\n', 'utf8');
  const before = readFile(path.join(dir, '.env.example'));
  const r2 = S.selfHeal(dir);
  t('8f second self-heal run: changed list is empty (already intact)', r2.changed.length === 0);
  const after = readFile(path.join(dir, '.env.example'));
  t('8g .env.example user edit is untouched by the second self-heal run', before === after);
}

// =====================================================================================================
// 9) doctor() — PASS/FAIL checks, exit code, --json
// =====================================================================================================
{
  const dir = freshDir();
  const r1 = S.doctor(dir);
  t('9a bare project: doctor() is NOT all-pass (no .claude/ yet)', r1.ok === false);
  t('9b bare project: claudeDir check fails with a reason', r1.checks.claudeDir.ok === false && r1.checks.claudeDir.reason.length > 0);

  S.selfHeal(dir);
  S.mark(dir, { name: 'Doc', lang: 'en', type: 'website' }, freshDir('forge-setup-global-'));
  const r2 = S.doctor(dir);
  t('9c after self-heal + mark: node check passes', r2.checks.node.ok === true);
  t('9d after self-heal + mark: claudeDir passes', r2.checks.claudeDir.ok === true);
  t('9e after self-heal + mark: markersValid passes', r2.checks.markersValid.ok === true);
  t('9f after self-heal + mark: skillsAgentsPresent passes', r2.checks.skillsAgentsPresent.ok === true);
  t('9g after self-heal + mark: doctor() is all-pass', r2.ok === true);

  // corrupt the marker -> markersValid must fail specifically
  fs.writeFileSync(path.join(dir, '.claude', '.forge-setup.json'), '{not valid json', 'utf8');
  const r3 = S.doctor(dir);
  t('9h corrupted marker: markersValid fails', r3.checks.markersValid.ok === false);
  t('9i corrupted marker: overall doctor ok becomes false', r3.ok === false);

  // CLI doctor: exit code mirrors ok, --json is parseable and matches
  const cliGood = runCli(['doctor'], dir); // still corrupted from above -> should be non-zero
  t('9j CLI doctor exits non-zero on a failing check', cliGood.status === 1);
  const cliJson = runCli(['doctor', '--json'], dir);
  const parsedJson = JSON.parse(cliJson.stdout);
  t('9k CLI doctor --json output parses and matches ok=false', parsedJson.ok === false);
}

if (GIT_OK) {
  // envNotTracked check actually fails doctor when .env is committed
  const dir = freshDir();
  gitFixtureWithTrackedEnv(dir);
  S.selfHeal(dir);
  const r = S.doctor(dir);
  t('9l doctor() envNotTracked fails when .env is committed', r.checks.envNotTracked.ok === false);
  t('9m doctor() overall ok is false when .env is tracked', r.ok === false);
} else {
  skipT('9l/9m doctor tracked-env check', 'git unavailable in this environment');
}

// =====================================================================================================
// 10) lang() / getLang()
// =====================================================================================================
{
  const dir = freshDir();
  const gDir = freshDir('forge-setup-global-');
  t('10a default lang before onboarding is "en"', S.getLang(dir, gDir) === 'en');
  S.mark(dir, { name: 'Taal', lang: 'nl' }, gDir);
  t('10b lang reflects the marker after mark()', S.getLang(dir, gDir) === 'nl');

  const cli = runCli(['lang'], dir, { FORGE_SETUP_GLOBAL_ROOT: gDir });
  t('10c CLI lang prints the configured language', cli.stdout.trim() === 'nl');
}

// =====================================================================================================
// 11) CLI smoke tests — status/guard/init-keys/place-keys end to end, real subprocess
// =====================================================================================================
{
  const dir = freshDir();
  const statusCli = runCli(['status', '--json'], dir);
  t('11a CLI status --json exits 0', statusCli.status === 0);
  t('11b CLI status --json reports not onboarded on a fresh project', JSON.parse(statusCli.stdout).onboarded === false);

  const guardCli = runCli(['guard'], dir);
  t('11c CLI guard exits 0 on a clean project', guardCli.status === 0);
  t('11d CLI guard actually wrote .gitignore', fs.existsSync(path.join(dir, '.gitignore')));

  const guardCli2 = runCli(['guard'], dir);
  t('11e CLI guard second run: idempotent no-op message', /already protects secrets/.test(guardCli2.stdout));

  const initCli = runCli(['init-keys', '--type', 'chatbot'], dir);
  t('11f CLI init-keys exits 0', initCli.status === 0);
  t('11g CLI init-keys prints the temp file path', /\.env\.forge-setup/.test(initCli.stdout));

  const secretValue = 'sk-ant-CLISECRETVALUE0123456789abcdef';
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'ANTHROPIC_API_KEY=' + secretValue + '\nTELEGRAM_BOT_TOKEN=REPLACE_ME\n', 'utf8');
  const placeCli = runCli(['place-keys'], dir);
  t('11h CLI place-keys exits 0', placeCli.status === 0);
  t('11i CLI place-keys NEVER echoes the raw secret value on stdout', !placeCli.stdout.includes(secretValue));
  t('11j CLI place-keys NEVER echoes the raw secret value on stderr', !placeCli.stderr.includes(secretValue));
  t('11k CLI place-keys reports the key NAME was stored', placeCli.stdout.includes('ANTHROPIC_API_KEY'));
  // BUG 2 FIX: TELEGRAM_BOT_TOKEN=REPLACE_ME was skipped in this same run, so the fill-file must be
  // RETAINED (not deleted) — see section 12.2 for the dedicated regression tests.
  t('11l CLI place-keys RETAINS the temp file because a value was skipped (BUG 2 fix)', fs.existsSync(path.join(dir, '.env.forge-setup')));
  t('11l2 CLI place-keys prints a "kept" message, not a false "deleted" claim', /Kept the temp file/.test(placeCli.stdout) && !/Deleted the temp file/.test(placeCli.stdout));
  t('11m the real .env on disk DOES contain the value (that is the whole point)', readFile(path.join(dir, '.env')).includes(secretValue));

  const selfHealCli = runCli(['self-heal'], dir);
  t('11n CLI self-heal exits 0', selfHealCli.status === 0);

  const markCli = runCli(['mark', '--name', 'End2End', '--lang', 'en'], dir, { FORGE_SETUP_GLOBAL_ROOT: freshDir('forge-setup-global-') });
  t('11o CLI mark exits 0', markCli.status === 0);

  const markMissingArgs = runCli(['mark'], dir);
  t('11p CLI mark without required args exits non-zero with a usage message', markMissingArgs.status === 1 && /Usage: mark/.test(markMissingArgs.stderr));

  const unknownCmd = runCli(['bogus-command'], dir);
  t('11q CLI unknown command exits non-zero with a usage message', unknownCmd.status === 1 && /Usage: node forge-setup\.cjs/.test(unknownCmd.stderr));
}

// =====================================================================================================
// 12) DEDICATED REGRESSION TESTS — one block per confirmed bug from the 2026-07-18 fix pass
// =====================================================================================================

// 12.1) BUG 1: place-keys --tmp pointing at .env / .env.example must REFUSE outright — never
// merge-then-unconditionally-delete the very file it is supposed to protect.
{
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, '.env'), 'REAL_SECRET=do-not-touch-me\n', 'utf8');
  const beforeEnv = readFile(path.join(dir, '.env'));
  const r1 = S.placeKeys(dir, { tmpName: path.join(dir, '.env') });
  t('12.1a place-keys REFUSES when --tmp resolves to .env itself', r1.ok === false);
  t('12.1b .env content is completely untouched after the refusal', readFile(path.join(dir, '.env')) === beforeEnv);
  t('12.1c .env was NOT deleted by the refused call', fs.existsSync(path.join(dir, '.env')));

  fs.writeFileSync(path.join(dir, '.env.example'), '# example content, keep me\n', 'utf8');
  const beforeExample = readFile(path.join(dir, '.env.example'));
  const r2 = S.placeKeys(dir, { tmpName: path.join(dir, '.env.example') });
  t('12.1d place-keys REFUSES when --tmp resolves to .env.example itself', r2.ok === false);
  t('12.1e .env.example content is completely untouched after the refusal', readFile(path.join(dir, '.env.example')) === beforeExample);
}

// 12.2) BUG 2: (a) place-keys keeps (does not delete) the fill-file whenever anything was skipped or
// nothing was stored — a valid pasted secret must never be silently lost; (b) looksLikePlaceholder()
// false-positive guard — a real secret that merely CONTAINS "xxxx" as a coincidental substring must not
// be misclassified as an unfilled template placeholder.
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  const secretValue = 'sk-ant-KEEPONSKIPTEST0123456789abcdefgh';
  fs.writeFileSync(tmpPath, [
    'ANTHROPIC_API_KEY=' + secretValue,
    'OPENAI_API_KEY=REPLACE_ME', // this one gets skipped
  ].join('\n') + '\n', 'utf8');
  const r = S.placeKeys(dir);
  t('12.2a place-keys with a skipped value alongside a stored one: ok:true (partial success)', r.ok === true);
  t('12.2b temp file is RETAINED (not deleted) because something was skipped', fs.existsSync(tmpPath));
  t('12.2c deletedTemp is reported false', r.deletedTemp === false);
  t('12.2d tempRetained is reported true with a non-empty reason', r.tempRetained === true && typeof r.tempRetainReason === 'string' && r.tempRetainReason.length > 0);
  t('12.2e the value that WAS valid still made it into .env', readFile(path.join(dir, '.env')).includes(secretValue));
}
{
  // ROUND-2 BUG 6 FINAL COHERENT RULE: a temp file where NOTHING was actually PASTED (every value left
  // blank, nothing skipped/rejected) has nothing to lose — it is CLEANED UP, same as a clean success.
  // Retention is reserved ONLY for "at least one pasted value was skipped/rejected" (see the 12.2a block
  // above). This deliberately supersedes this test's own round-1 expectation (was: retained whenever
  // nothing was stored, regardless of why) — the round-2 bug list explicitly simplified the rule.
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  fs.writeFileSync(tmpPath, 'ANTHROPIC_API_KEY=\nOPENAI_API_KEY=\nVECTOR_DB_URL=\n', 'utf8');
  const r = S.placeKeys(dir);
  t('12.2f nothing-PASTED-at-all run (all blank, nothing skipped): temp file is CLEANED UP', !fs.existsSync(tmpPath));
  t('12.2g nothing-pasted-at-all run: deletedTemp:true', r.deletedTemp === true);
}
{
  // clean full success (nothing skipped, something stored): the managed default temp IS still deleted
  const dir = freshDir();
  S.initKeys(dir, { type: 'fullstack' });
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'DATABASE_URL=postgres://user:pass@localhost:5432/db\n', 'utf8');
  const r = S.placeKeys(dir);
  t('12.2h clean full success: temp IS deleted (positive case still works)', r.deletedTemp === true && !fs.existsSync(path.join(dir, '.env.forge-setup')));
}
{
  const embeddedXxxx = 'whsec_a1b2c3xxxx9f8e7d6c5b4a3f2e1d0c9b8a7'; // real-shaped secret, "xxxx" is coincidental
  t('12.2i a real value with an embedded "xxxx" substring is NOT flagged as a placeholder', S.looksLikePlaceholder(embeddedXxxx) === false);
  const verdict = S.classifyValue('WEBHOOK_SIGNING_SECRET', embeddedXxxx);
  t('12.2j classifyValue STORES the embedded-xxxx value instead of wrongly skipping it', verdict.status === 'stored');
  t('12.2k the classic isolated xxxx-run placeholder pattern is STILL correctly caught', S.looksLikePlaceholder('sk-xxxxxxxxxxxxxxxxxxxx') === true);
  // ROUND-2 BUG 2 ACCEPTED TRADE-OFF: catching left-anchored placeholder words regardless of a trailing
  // alnum suffix (round-2 bug 2, e.g. "REPLACEMENOW") necessarily also flags this rarer superstring
  // collision ("replacement" is "replaceme"+"nt" with a 2-char trailing run — no length threshold can
  // separate a 2-char legitimate suffix from a 3-char "now" evasion suffix). A real security-conscious
  // false-negative fix outweighs this narrow, rare false-positive; see round-2 12.2m/n/o below for the
  // actual required catches, and 12.2i above for the still-protected embedded-xxxx-mid-value case.
  t('12.2l (SUPERSEDED, see comment) "replacement"-superstring is now conservatively treated as placeholder-like', S.looksLikePlaceholder('TOKEN_REPLACEMENT_2024_abc123real') === true);
}

// 12.3) BUG 3: quoted values are NOT double-trimmed — meaningful inner whitespace, already correctly
// extracted by parseKeyValueLines, must survive unchanged into the stored value and into .env.
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'integration' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  fs.writeFileSync(tmpPath, 'THIRD_PARTY_API_KEY="  padded-value-inside-quotes  "\n', 'utf8');
  const r = S.placeKeys(dir);
  t('12.3a quoted value with inner padding is stored (not treated as too-short/blank)', r.stored.includes('THIRD_PARTY_API_KEY'));
  const envContent = readFile(path.join(dir, '.env'));
  t('12.3b .env preserves the EXACT inner leading/trailing whitespace from the quoted value', envContent.includes('THIRD_PARTY_API_KEY=  padded-value-inside-quotes  \n'));
  t('12.3c an unquoted value is still trimmed normally (unchanged prior behavior)', S.parseKeyValueLines('KEY=  unquoted-value  ').KEY === 'unquoted-value');
}

// 12.4) BUG 4: an existing HARDLINKED .env (nlink>1) must be REPLACED via atomic temp+rename, never
// written through — a sibling hardlink to the same original inode must keep its OLD content untouched.
{
  const dir = freshDir();
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'ORIGINAL_SHARED_LINE=do-not-corrupt-me\n', 'utf8');
  const linkedCopy = path.join(dir, 'shared-copy.env');
  let hardlinkOk = true;
  try { fs.linkSync(envPath, linkedCopy); } catch { hardlinkOk = false; }
  if (hardlinkOk && fs.lstatSync(envPath).nlink > 1) {
    S.initKeys(dir, { type: 'rag' });
    fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'ANTHROPIC_API_KEY=sk-ant-HARDLINKTEST0123456789abcdefgh\n', 'utf8');
    const r = S.placeKeys(dir);
    t('12.4a place-keys succeeds against a hardlinked .env', r.ok === true);
    const envAfter = readFile(envPath);
    t('12.4b .env itself got the new key', envAfter.includes('ANTHROPIC_API_KEY=sk-ant-HARDLINKTEST'));
    const linkedAfter = readFile(linkedCopy);
    t('12.4c the SIBLING hardlink is UNTOUCHED (still ONLY the original content)', linkedAfter === 'ORIGINAL_SHARED_LINE=do-not-corrupt-me\n');
    t('12.4d the sibling hardlink was NOT silently corrupted with the new key', !linkedAfter.includes('ANTHROPIC_API_KEY'));
  } else {
    skipT('12.4 hardlinked .env replace-not-write-through', 'fs.linkSync unavailable/unsupported in this environment');
  }
}

// 12.5 + 12.7) BUG 5 + BUG 7: a READ-ONLY .env write must NEVER crash (bug 5) and must NEVER delete the
// secret-bearing temp file or claim success (bug 7) — the temp is the ONLY remaining copy of what the
// user typed at that point, so losing it on a write failure would be strictly worse than keeping it.
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  const secretValue = 'sk-ant-READONLYFAILTEST0123456789abcdefg';
  fs.writeFileSync(tmpPath, 'ANTHROPIC_API_KEY=' + secretValue + '\n', 'utf8');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'PRE_EXISTING=untouched\n', 'utf8');
  fs.chmodSync(envFile, 0o444); // make .env read-only -> the write MUST fail (confirmed reproducible via direct probe)
  let threw = false, r = null;
  try { r = S.placeKeys(dir); } catch (e) { threw = true; }
  try {
    t('12.5a BUG5: place-keys on a read-only .env does NOT crash', threw === false);
    t('12.5b BUG5: returns a structured ok:false result, not an uncaught exception', !!r && r.ok === false);
    t('12.5c BUG5: the reason mentions the write failure', !!r && /write/i.test(r.reason || ''));
    t('12.7a BUG7: never claims success on a failed write', !!r && r.ok === false);
    t('12.7b BUG7: deletedTemp is explicitly false', !!r && r.deletedTemp === false);
    t('12.7c BUG7: tempRetained is explicitly true with a clear reason', !!r && r.tempRetained === true && typeof r.tempRetainReason === 'string' && r.tempRetainReason.length > 0);
    t('12.7d BUG7: the secret-bearing temp file still exists on disk (never lost)', fs.existsSync(tmpPath));
    t('12.7e BUG7: temp file content is unchanged / still has the real secret intact', fs.readFileSync(tmpPath, 'utf8').includes(secretValue));
    t('12.7f BUG7: the read-only .env itself was never corrupted/truncated by the failed attempt', readFile(envFile) === 'PRE_EXISTING=untouched\n');
  } finally {
    try { fs.chmodSync(envFile, 0o666); } catch { /* restore so temp-dir cleanup can remove it */ }
  }
}

// 12.6) BUG 6: upsertEnvFile / place-keys must preserve the file's existing CRLF line endings for
// UNRELATED lines, not silently rewrite everything to bare LF just because changed lines were re-joined.
{
  const dir = freshDir();
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'EXISTING_A=keep-me\r\nEXISTING_B=also-keep\r\n', 'utf8');
  S.initKeys(dir, { type: 'fullstack' });
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'DATABASE_URL=postgres://a:b@host/crlfdb\n', 'utf8');
  const r = S.placeKeys(dir);
  t('12.6a place-keys ok', r.ok === true);
  const raw = fs.readFileSync(envPath, 'utf8');
  t('12.6b unrelated pre-existing lines KEEP their CRLF ending', raw.includes('EXISTING_A=keep-me\r\n') && raw.includes('EXISTING_B=also-keep\r\n'));
  t('12.6c the newly appended line ALSO uses CRLF (the file\'s dominant style)', raw.includes('DATABASE_URL=postgres://a:b@host/crlfdb\r\n'));
  t('12.6d no bare (non-CRLF) LF line ending crept in anywhere', !/[^\r]\n/.test(raw));
}

// 12.8) BUG 8: guard/init-keys/place-keys must NEVER crash with a raw Node errno for a bad --project
// (a non-existent path, or a path that is a FILE instead of a directory).
{
  const parentDir = freshDir();
  const nonExistent = path.join(parentDir, 'does-not-exist-at-all');
  let threwGuard = false, threwInit = false, threwPlace = false;
  let rg, ri, rp;
  try { rg = S.guard(nonExistent); } catch { threwGuard = true; }
  try { ri = S.initKeys(nonExistent, { type: 'rag' }); } catch { threwInit = true; }
  try { rp = S.placeKeys(nonExistent); } catch { threwPlace = true; }
  t('12.8a guard() on a non-existent --project does NOT crash', threwGuard === false);
  t('12.8b guard() returns ok:false with a clear "project dir not found" reason', !!rg && rg.ok === false && /project dir not found/.test(rg.reason || ''));
  t('12.8c initKeys() on a non-existent --project does NOT crash', threwInit === false);
  t('12.8d initKeys() returns ok:false with a clear reason', !!ri && ri.ok === false && /project dir not found/.test(ri.reason || ''));
  t('12.8e placeKeys() on a non-existent --project does NOT crash', threwPlace === false);
  t('12.8f placeKeys() returns ok:false with a clear reason', !!rp && rp.ok === false && /project dir not found/.test(rp.reason || ''));

  const aFile = path.join(parentDir, 'i-am-a-file.txt');
  fs.writeFileSync(aFile, 'not a directory\n', 'utf8');
  let threwFile = false, rf;
  try { rf = S.guard(aFile); } catch { threwFile = true; }
  t('12.8g guard() on a --project that is a FILE does NOT crash', threwFile === false);
  t('12.8h guard() on a --project that is a FILE reports a clean reason', !!rf && rf.ok === false && /project dir not found/.test(rf.reason || ''));

  const cli = runCli(['guard'], nonExistent);
  t('12.8i CLI guard on a non-existent --project exits with a clean non-zero code (not a Node crash)', cli.status === 1);
  t('12.8j CLI guard prints the clean reason, not a raw Node stack trace', /project dir not found/.test(cli.stderr) && !/\.cjs:\d+:\d+/.test(cli.stderr));
}

// 12.9) BUG 9: --lang / getLang() must never accept, store, or echo an unvalidated language token.
{
  const dir = freshDir();
  const gDir = freshDir('forge-setup-global-');
  const cli = runCli(['mark', '--name', 'LangTest', '--lang', '$(whoami)-nl-1234567890'], dir, { FORGE_SETUP_GLOBAL_ROOT: gDir });
  t('12.9a CLI mark with a garbage --lang exits 0 (sanitizes rather than crashing/rejecting)', cli.status === 0);
  const marker = JSON.parse(readFile(path.join(dir, '.claude', '.forge-setup.json')));
  t('12.9b the WRITTEN marker never stores the raw garbage lang value', marker.answers.lang !== '$(whoami)-nl-1234567890');
  t('12.9c the written marker lang falls back to the safe default "en"', marker.answers.lang === 'en');

  const dir2 = freshDir();
  fs.mkdirSync(path.join(dir2, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir2, '.claude', '.forge-setup.json'), JSON.stringify({
    completedAt: new Date().toISOString(),
    answers: { name: 'Corrupt', lang: '; rm -rf ~ #', goal: 'x', type: 'website' },
  }), 'utf8');
  t('12.9d getLang() sanitizes a corrupted marker lang to "en"', S.getLang(dir2, freshDir('forge-setup-global-')) === 'en');
  const cliLang = runCli(['lang'], dir2, { FORGE_SETUP_GLOBAL_ROOT: freshDir('forge-setup-global-') });
  t('12.9e CLI lang on a corrupted marker prints the safe default, never the raw injected string', cliLang.stdout.trim() === 'en');

  t('12.9f sanitizeLang accepts a plain valid code', S.sanitizeLang('nl') === 'nl');
  t('12.9g sanitizeLang accepts a valid region-tagged code', S.sanitizeLang('en-US') === 'en-US');
  t('12.9h sanitizeLang rejects a non-string (number) input safely', S.sanitizeLang(12345) === 'en');
}

// 12.13) BUG 13: a user-pointed --tmp/--keys-from import source is NEVER deleted — only the managed
// default fill-file is ever eligible for automatic deletion.
{
  const dir = freshDir();
  const externalSource = path.join(freshDir('forge-setup-external-'), 'my-own-keys.env');
  const secretValue = 'sk-ant-KEEPMYSOURCETEST0123456789abcdefg';
  fs.writeFileSync(externalSource, 'ANTHROPIC_API_KEY=' + secretValue + '\n', 'utf8');
  const beforeContent = readFile(externalSource);
  const r = S.placeKeys(dir, { tmpName: externalSource });
  t('12.13a place-keys succeeds importing from a user-pointed external file', r.ok === true);
  t('12.13b the value was actually stored into .env', readFile(path.join(dir, '.env')).includes(secretValue));
  t('12.13c the user-pointed source file was NEVER deleted', fs.existsSync(externalSource));
  t('12.13d the user-pointed source file content is untouched', readFile(externalSource) === beforeContent);
  t('12.13e placeKeys() reports deletedTemp:false for an import source', r.deletedTemp === false);
  t('12.13f placeKeys() reports tempRetained:true for an import source', r.tempRetained === true);
}

// 12.14) BUG 14: an absolute (or "~/"-prefixed) --tmp/--keys-from path must be used AS-IS, not
// mis-joined under projectDir with a misleading "run init-keys first" error.
{
  const dir = freshDir();
  const externalDir = freshDir('forge-setup-external-abs-');
  const externalFile = path.join(externalDir, 'external-keys.env');
  const secretValue = 'sk-ant-ABSOLUTEPATHTEST0123456789abcdefg';
  fs.writeFileSync(externalFile, 'ANTHROPIC_API_KEY=' + secretValue + '\n', 'utf8');
  const r = S.placeKeys(dir, { tmpName: externalFile });
  t('12.14a an absolute --tmp path is found and processed (not "run init-keys first")', r.ok === true);
  t('12.14b the absolute-path value was actually stored', readFile(path.join(dir, '.env')).includes(secretValue));

  const missingAbs = path.join(externalDir, 'does-not-exist.env');
  const r2 = S.placeKeys(dir, { tmpName: missingAbs });
  t('12.14c missing absolute --tmp: ok:false', r2.ok === false);
  t('12.14d error message names the REAL absolute path, not a projectDir-joined nonsense path', r2.reason.includes(path.resolve(missingAbs)));
  t('12.14e error message does NOT wrongly suggest "run init-keys first" for an explicit --tmp', !/run "init-keys" first/.test(r2.reason));

  const cli = runCli(['place-keys', '--tmp', externalFile], dir);
  t('12.14f CLI place-keys --tmp <absolute path> works end-to-end', cli.status === 0);
}

// 12.15) BUG 15: the printed hint must reference the REAL relative CLI path (including .claude/) so it
// actually works when copy-pasted from the project root.
{
  const dir = freshDir();
  const cli = runCli(['init-keys', '--type', 'rag'], dir);
  t('12.15a CLI init-keys hint uses the correct .claude/forge-bin/ path', cli.stdout.includes('node .claude/forge-bin/forge-setup.cjs place-keys'));
  t('12.15b CLI init-keys hint no longer prints the broken (missing .claude/) path', !cli.stdout.includes('node forge-bin/forge-setup.cjs'));
}

// =====================================================================================================
// 13) ROUND-2 REGRESSION TESTS — 5 more confirmed bugs from the 2026-07-18 convergence break-swarm
// =====================================================================================================

// 13.1) ROUND-2 BUG 1 [HIGH]: a custom IN-PROJECT --tmp fill-file must be gitignored BEFORE any value is
// written into it — never left stageable by a plain `git add .`. A --tmp OUTSIDE the project cannot be
// protected by this project's own .gitignore, and the CLI must not falsely promise that it is.
{
  const dir = freshDir();
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (GIT_OK) { git('init', '-q', '-b', 'main'); git('config', 'user.email', 'forge-test@example.invalid'); git('config', 'user.name', 'Forge Test'); }
  const r = S.initKeys(dir, { type: 'automation', tmpName: 'mykeys.txt' });
  t('13.1a init-keys with a custom in-project --tmp succeeds', r.ok === true && r.created === true);
  t('13.1b initKeys() reports gitignored:true for an in-project custom name', r.gitignored === true);
  const giContent = readFile(path.join(dir, '.gitignore'));
  t('13.1c .gitignore now contains the custom tmp filename', giContent.split(/\r?\n/).map((l) => l.trim()).includes('mykeys.txt'));
  if (GIT_OK) {
    const check = git('check-ignore', 'mykeys.txt');
    t('13.1d git check-ignore actually confirms mykeys.txt is ignored', check.status === 0);
  } else {
    skipT('13.1d git check-ignore verification', 'git unavailable in this environment');
  }

  // retained by design (bug 13, non-managed) — must STILL be gitignored at the point it is retained too
  fs.writeFileSync(path.join(dir, 'mykeys.txt'), 'THIRD_PARTY_API_KEY=tpk-realvalue0000000000000000\n', 'utf8');
  const r2 = S.placeKeys(dir, { tmpName: 'mykeys.txt' });
  t('13.1e place-keys succeeds importing the custom in-project tmp', r2.ok === true);
  t('13.1f the custom tmp is retained (bug 13, never auto-deleted)', fs.existsSync(path.join(dir, 'mykeys.txt')));
  t('13.1g placeKeys() ALSO reports gitignored:true for it', r2.gitignored === true);
}
{
  // CLI-level: the confident reassurance is printed ONLY when git POSITIVELY CONFIRMED the file is
  // ignored (round-3 PRINCIPLE B) — needs a real git repo, not just literal-line presence.
  const dir = freshDir();
  if (GIT_OK) {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'forge-test@example.invalid'); git('config', 'user.name', 'Forge Test');
    const cli = runCli(['init-keys', '--type', 'automation', '--tmp', 'custom-keys.env'], dir);
    t('13.1h CLI init-keys with a git-CONFIRMED in-project custom --tmp prints the "never committed" reassurance', /Nothing here is ever committed to git/.test(cli.stdout));
  } else {
    skipT('13.1h git-confirmed reassurance', 'git unavailable in this environment');
  }
}
{
  // ROUND-3 PRINCIPLE B: a fill-file that IS inside the project but whose gitignore status could NOT be
  // positively verified (no git repo at all here) must get an HONEST WARNING, never the confident promise.
  const dir = freshDir(); // deliberately NOT git-initialized
  const cli = runCli(['init-keys', '--type', 'automation', '--tmp', 'unverifiable-keys.env'], dir);
  t('13.1h2 CLI init-keys with an unverifiable in-project --tmp does NOT print the confident promise', !/Nothing here is ever committed to git/.test(cli.stdout));
  t('13.1h3 CLI init-keys with an unverifiable in-project --tmp prints an honest could-not-verify warning', /could NOT verify/i.test(cli.stdout));
}
{
  // a --tmp path OUTSIDE the project must NOT get the "never committed" promise (can't protect it)
  const dir = freshDir();
  const externalDir = freshDir('forge-setup-external-r2-');
  const externalFile = path.join(externalDir, 'outside-keys.env');
  const r = S.initKeys(dir, { type: 'automation', tmpName: externalFile });
  t('13.1i init-keys with an OUTSIDE-project --tmp succeeds', r.ok === true);
  t('13.1j initKeys() reports gitignored:false for an outside-project path', r.gitignored === false);
  const giContent = fs.existsSync(path.join(dir, '.gitignore')) ? readFile(path.join(dir, '.gitignore')) : '';
  t('13.1k the outside-project path is not written into THIS project\'s .gitignore', !giContent.includes(externalFile));

  // fresh, never-touched external path for the CLI check — reusing `externalFile` above would hit the
  // "already has content, left untouched" early-return branch instead of the "created" branch, which
  // never reaches the reassurance/NOTE line at all (a real test-authoring pitfall, not a product bug).
  const externalFile2 = path.join(externalDir, 'outside-keys-cli.env');
  const cli = runCli(['init-keys', '--type', 'automation', '--tmp', externalFile2], freshDir());
  t('13.1l CLI init-keys with an outside-project --tmp does NOT print the "never committed" promise', !/Nothing here is ever committed to git/.test(cli.stdout));
  t('13.1m CLI init-keys with an outside-project --tmp prints an honest NOTE instead', /OUTSIDE the project/i.test(cli.stdout));
}

// 13.2) ROUND-2 BUG 2 [MED]: a trailing alnum suffix must NOT defeat placeholder detection ('CHANGEMENOW',
// 'REPLACEMENOW', 'your_key_hereXX' are still obviously placeholders), while a real secret merely
// CONTAINING "xxxx" mid-value must STILL be accepted (explicit critical non-regression).
{
  const trailingSuffixCases = ['CHANGEMENOW', 'REPLACEMENOW', 'your_key_hereXX'];
  for (const v of trailingSuffixCases) {
    t('13.2a "' + v + '" (trailing suffix) IS caught as a placeholder', S.looksLikePlaceholder(v) === true);
  }
  const realSecretWithXxxx = 'whsec_realXXXXsecretvalue2026abcdef'; // exact reverify-script repro value
  t('13.2b a real secret merely CONTAINING xxxx mid-value is STILL accepted (critical non-regression)', S.looksLikePlaceholder(realSecretWithXxxx) === false);
  const verdict = S.classifyValue('WEBHOOK_SIGNING_SECRET', realSecretWithXxxx);
  t('13.2c classifyValue STORES it (does not false-reject)', verdict.status === 'stored');

  const dir = freshDir();
  S.initKeys(dir, { type: 'automation' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  let content = readFile(tmpPath);
  content = content.replace(/^(\s*WEBHOOK_SIGNING_SECRET=).*$/m, '$1' + realSecretWithXxxx);
  fs.writeFileSync(tmpPath, content, 'utf8');
  const r = S.placeKeys(dir);
  t('13.2d end-to-end: real xxxx-containing secret lands in .env', readFile(path.join(dir, '.env')).includes(realSecretWithXxxx));
  t('13.2e placeKeys() return value never carries the raw secret (names only)', !JSON.stringify(r).includes(realSecretWithXxxx));

  const dir2 = freshDir();
  runCli(['init-keys', '--type', 'automation'], dir2);
  const tmpPath2 = path.join(dir2, '.env.forge-setup');
  let content2 = readFile(tmpPath2);
  content2 = content2.replace(/^(\s*WEBHOOK_SIGNING_SECRET=).*$/m, '$1' + realSecretWithXxxx);
  fs.writeFileSync(tmpPath2, content2, 'utf8');
  const cliPlace = runCli(['place-keys'], dir2);
  t('13.2f CLI place-keys NEVER echoes the xxxx-containing secret on stdout', !cliPlace.stdout.includes(realSecretWithXxxx));
  t('13.2g CLI place-keys NEVER echoes the xxxx-containing secret on stderr', !cliPlace.stderr.includes(realSecretWithXxxx));
}

// 13.3) ROUND-2 BUG 3 [LOW]: on a case-insensitive filesystem (win32/darwin), --tmp .ENV / .ENV.EXAMPLE
// must ALSO be refused — a differently-cased path string must not bypass the refuse-guard.
{
  const isCaseInsensitivePlatform = process.platform === 'win32' || process.platform === 'darwin';
  if (isCaseInsensitivePlatform) {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '.env'), 'REAL_SECRET=do-not-touch-me\n', 'utf8');
    const before = readFile(path.join(dir, '.env'));
    const r = S.placeKeys(dir, { tmpName: '.ENV' });
    t('13.3a place-keys REFUSES --tmp .ENV on a case-insensitive filesystem', r.ok === false);
    t('13.3b .env content is untouched', readFile(path.join(dir, '.env')) === before);

    fs.writeFileSync(path.join(dir, '.env.example'), '# keep me\n', 'utf8');
    const r2 = S.placeKeys(dir, { tmpName: '.ENV.EXAMPLE' });
    t('13.3c place-keys REFUSES --tmp .ENV.EXAMPLE on a case-insensitive filesystem', r2.ok === false);

    S.initKeys(dir, { type: 'fullstack' });
    fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'DATABASE_URL=postgres://user:pass@localhost:5432/db\n', 'utf8');
    const r3 = S.placeKeys(dir, { tmpName: '.ENV.FORGE-SETUP' });
    t('13.3d isManagedDefaultTmp recognizes a differently-cased default name and DELETES it', r3.ok === true && r3.deletedTemp === true);
  } else {
    skipT('13.3a-d case-insensitive filesystem refuse-guard', 'this platform (' + process.platform + ') is case-sensitive by default');
  }

  // cross-platform proof of the STRING-comparison logic itself (regardless of the real host OS)
  {
    const origDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    let overrideOk = true;
    try { Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); }
    catch { overrideOk = false; }
    if (overrideOk) {
      try {
        const same = S.pathsEqualForFs('C:\\proj\\.env', 'C:\\proj\\.ENV');
        t('13.3e pathsEqualForFs is case-SENSITIVE when process.platform is forced to "linux"', same === false);
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const sameWin = S.pathsEqualForFs('C:\\proj\\.env', 'C:\\proj\\.ENV');
        t('13.3f pathsEqualForFs is case-INSENSITIVE when process.platform is forced to "win32"', sameWin === true);
      } finally {
        Object.defineProperty(process, 'platform', origDescriptor);
      }
    } else {
      skipT('13.3e/f forced-platform pathsEqualForFs check', 'process.platform is not configurable in this Node build');
    }
  }
}

// 13.4) ROUND-2 BUG 4 [LOW]: the atomic-write scratch filename pattern ('.env.tmp-*') must be covered by
// .gitignore so a rename+unlink double-failure never leaves a stray plaintext-secret scratch file staged.
{
  const dir = freshDir();
  t('13.4a REQUIRED_GITIGNORE_LINES includes the .env.tmp-* pattern', S.REQUIRED_GITIGNORE_LINES.includes('.env.tmp-*'));
  S.guard(dir);
  const giContent = readFile(path.join(dir, '.gitignore'));
  t('13.4b .gitignore actually contains the .env.tmp-* line', giContent.split(/\r?\n/).map((l) => l.trim()).includes('.env.tmp-*'));

  if (GIT_OK) {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'forge-test@example.invalid');
    git('config', 'user.name', 'Forge Test');
    const strayScratch = '.env.tmp-12345-1699999999999-abc123';
    fs.writeFileSync(path.join(dir, strayScratch), 'ANTHROPIC_API_KEY=sk-ant-strayscratch0123456789abcdefg\n', 'utf8');
    const check = git('check-ignore', strayScratch);
    t('13.4c git check-ignore confirms a stray .env.tmp-* scratch file IS ignored', check.status === 0);
  } else {
    skipT('13.4c git check-ignore verification', 'git unavailable in this environment');
  }
}

// 13.5) ROUND-2 BUG 7 [HIGH]: a BOM-prefixed existing .env must NOT produce a duplicate key on upsert
// (a "rotated" secret must never silently stay stale because the old BOM-glued line was never matched).
// BOM_RE is a NAMED regex constant (built from the numeric codepoint, never a raw literal character
// typed inline) so no invisible U+FEFF byte ends up embedded in this source file itself.
{
  const BOM_RE = new RegExp('^' + String.fromCharCode(0xFEFF));
  const dir = freshDir();
  const envPath = path.join(dir, '.env');
  const BOM = String.fromCharCode(0xFEFF);
  fs.writeFileSync(envPath, BOM + 'EXISTING_KEY=old-stale-value\nOTHER_KEY=keep-me\n', 'utf8');
  const updated = S.upsertEnvFile(envPath, { EXISTING_KEY: 'new-rotated-value' });
  const matches = updated.split(/\r?\n/).filter((l) => l.replace(BOM_RE, '').startsWith('EXISTING_KEY='));
  t('13.5a upsertEnvFile produces EXACTLY ONE EXISTING_KEY line (no duplicate)', matches.length === 1);
  t('13.5b the single EXISTING_KEY line holds the NEW rotated value', matches[0].replace(BOM_RE, '') === 'EXISTING_KEY=new-rotated-value');
  t('13.5c the BOM is preserved at the very start of the output', updated.charCodeAt(0) === 0xFEFF);
  t('13.5d the unrelated OTHER_KEY line survives untouched', updated.includes('OTHER_KEY=keep-me'));
}
{
  // end-to-end via place-keys
  const BOM_RE = new RegExp('^' + String.fromCharCode(0xFEFF));
  const dir = freshDir();
  const envPath = path.join(dir, '.env');
  const BOM = String.fromCharCode(0xFEFF);
  fs.writeFileSync(envPath, BOM + 'ANTHROPIC_API_KEY=sk-ant-OLDSTALEVALUE0123456789ab\n', 'utf8');
  S.initKeys(dir, { type: 'rag' });
  const newSecret = 'sk-ant-NEWROTATEDVALUE0123456789abcdefgh';
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'ANTHROPIC_API_KEY=' + newSecret + '\n', 'utf8');
  const r = S.placeKeys(dir);
  t('13.5e end-to-end place-keys ok', r.ok === true);
  const finalEnv = fs.readFileSync(envPath, 'utf8');
  const finalMatches = finalEnv.split(/\r?\n/).filter((l) => l.replace(BOM_RE, '').startsWith('ANTHROPIC_API_KEY='));
  t('13.5f end-to-end: exactly one ANTHROPIC_API_KEY line after rotation (no duplicate)', finalMatches.length === 1);
  t('13.5g end-to-end: the line holds the NEW rotated value, not the stale BOM-glued one', finalMatches[0].replace(BOM_RE, '').includes(newSecret));
}

// 13.6) ROUND-2 BUG 6: FINAL coherent retention rule, stated plainly and tested directly — the managed
// default is DELETED on (a) a clean full success, or (b) when nothing real was pasted at all; it is
// RETAINED ONLY when >=1 pasted value was skipped/rejected. A user-pointed custom --tmp is NEVER
// auto-deleted (regardless of outcome) but IS gitignored per round-2 bug 1.
{
  const dirA = freshDir();
  S.initKeys(dirA, { type: 'fullstack' });
  fs.writeFileSync(path.join(dirA, '.env.forge-setup'), 'DATABASE_URL=postgres://a:b@host/cleandb\n', 'utf8');
  const rA = S.placeKeys(dirA);
  t('13.6a (a) clean full success -> DELETED', rA.deletedTemp === true);

  const dirB = freshDir();
  S.initKeys(dirB, { type: 'website' });
  const rB = S.placeKeys(dirB);
  t('13.6b (b) nothing real pasted (all-comment scaffold) -> DELETED', rB.deletedTemp === true);

  const dirC = freshDir();
  S.initKeys(dirC, { type: 'rag' });
  fs.writeFileSync(path.join(dirC, '.env.forge-setup'), 'ANTHROPIC_API_KEY=\nOPENAI_API_KEY=\nVECTOR_DB_URL=\n', 'utf8');
  const rC = S.placeKeys(dirC);
  t('13.6c (b) nothing real pasted (all-blank KEY= lines) -> DELETED', rC.deletedTemp === true);

  const dirD = freshDir();
  S.initKeys(dirD, { type: 'rag' });
  fs.writeFileSync(path.join(dirD, '.env.forge-setup'), 'ANTHROPIC_API_KEY=REPLACE_ME\nOPENAI_API_KEY=\nVECTOR_DB_URL=\n', 'utf8');
  const rD = S.placeKeys(dirD);
  t('13.6d (c) at least one pasted-but-rejected value -> RETAINED', rD.deletedTemp === false && rD.tempRetained === true);

  const dirE = freshDir();
  fs.writeFileSync(path.join(dirE, 'custom.env'), 'ANTHROPIC_API_KEY=sk-ant-CUSTOMTMPTEST0123456789abcdefg\n', 'utf8');
  const rE = S.placeKeys(dirE, { tmpName: 'custom.env' });
  t('13.6e user-pointed custom --tmp is NEVER auto-deleted even on a clean full success', rE.deletedTemp === false && fs.existsSync(path.join(dirE, 'custom.env')));
  t('13.6f ...but IS gitignored (round-2 bug 1 tie-in)', rE.gitignored === true);
}

// =====================================================================================================
// 14) ROUND-3 REGRESSION TESTS — 8 more confirmed bugs from the 2026-07-18 convergence swarm, fixed via
// 4 root-cause principles: A) VERIFY DON'T ASSUME, B) HONEST DEGRADATION, C) FAIL-SAFE/NEVER LOSE A
// SECRET, D) ROBUST IO.
// =====================================================================================================

// 14.1) ROUND-3 BUG 1 [HIGH] + PRINCIPLES A/B: a pre-existing `!.env` negation must be DETECTED (not
// assumed away by literal-line presence) and REINFORCED, with honest messaging throughout.
{
  if (GIT_OK) {
    const dir = freshDir();
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'forge-test@example.invalid'); git('config', 'user.name', 'Forge Test');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n!.env\n', 'utf8'); // negation defeats the exclusion
    const preCheck = git('check-ignore', '.env');
    t('14.1a sanity: .env is genuinely NOT ignored before any fix (git confirms it directly)', preCheck.status !== 0);

    const g = S.guard(dir);
    t('14.1b guard() detects .env was not ignored and reinforces it', g.appended.some((a) => a.includes('.env') && a.includes('reinforced')));
    t('14.1c guard() now positively CONFIRMS .env is ignored after reinforcement', g.envIgnoreConfirmed === true);
    t('14.1d guard() is not blocked (the reinforcement fixed it)', g.ok === true && g.envUnignorable === false);
    const postCheck = git('check-ignore', '.env');
    t('14.1e git itself now confirms .env IS ignored (real, independent proof)', postCheck.status === 0);

    const secretValue = 'sk-ant-NEGATIONTEST0123456789abcdefghij';
    S.initKeys(dir, { type: 'rag' });
    fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'ANTHROPIC_API_KEY=' + secretValue + '\n', 'utf8');
    const r = S.placeKeys(dir);
    t('14.1f place-keys ok after reinforcement', r.ok === true);
    t('14.1g placeKeys() reports envGitignoreConfirmed:true', r.envGitignoreConfirmed === true);
    git('add', '-A');
    const stagedFiles = git('diff', '--cached', '--name-only').stdout.split(/\r?\n/).filter(Boolean);
    t('14.1h the real secret file (.env) is NEVER staged by git add -A after the fix', !stagedFiles.includes('.env'));
  } else {
    skipT('14.1a-h gitignore negation detection + reinforcement', 'git unavailable in this environment');
  }
}
{
  // CLI-level, on its OWN fresh fixture (a clean full-success run deletes the managed temp, so this must
  // NOT reuse a fixture a prior sub-block already consumed): the confident "never committed" claim is
  // printed once git has POSITIVELY confirmed .env is ignored (a plain, non-negated repo — the negation
  // scenario above already proves reinforcement independently).
  if (GIT_OK) {
    const dir = freshDir();
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'forge-test@example.invalid'); git('config', 'user.name', 'Forge Test');
    runCli(['init-keys', '--type', 'rag'], dir);
    fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'ANTHROPIC_API_KEY=sk-ant-CLICONFIRMTEST0123456789abcdefg\n', 'utf8');
    const cli = runCli(['place-keys'], dir);
    t('14.1i CLI place-keys prints the confident "never committed" claim once git positively confirms it', /git-ignored, never committed/.test(cli.stdout));
  } else {
    skipT('14.1i CLI confident-claim check', 'git unavailable in this environment');
  }
}
{
  // PRINCIPLE B: when verification is genuinely impossible (git unavailable), NEVER claim confidence.
  const dir = freshDir();
  const origPath = process.env.PATH, origPathCap = process.env.Path;
  try {
    process.env.PATH = ''; process.env.Path = '';
    const g = S.guard(dir);
    t('14.1j guard() with git unavailable: envIgnoreVerified is honestly false (cannot tell)', g.envIgnoreVerified === false);
    t('14.1k guard() with git unavailable: NOT blocked (permissive when we genuinely cannot check)', g.ok === true && g.envUnignorable === false);
  } finally {
    process.env.PATH = origPath;
    if (origPathCap !== undefined) process.env.Path = origPathCap; else delete process.env.Path;
  }
}
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const secretValue = 'sk-ant-NOGITWARNTEST0123456789abcdefgh';
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'ANTHROPIC_API_KEY=' + secretValue + '\n', 'utf8');
  const cli = runCli(['place-keys'], dir, { PATH: '', Path: '' });
  t('14.1l CLI place-keys with git unavailable still succeeds (permissive, does not block)', cli.status === 0);
  t('14.1m CLI place-keys with git unavailable prints an HONEST warning, never the false confident claim', !/git-ignored, never committed/.test(cli.stdout) && /could NOT verify/i.test(cli.stdout));
}

// 14.2) ROUND-3 BUG 2 [MED]: --tmp .gitignore / --tmp .git (or anything inside .git/) must be REFUSED.
{
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, '.gitignore'), '# original content, keep me\n.env\n', 'utf8');
  const r = S.placeKeys(dir, { tmpName: '.gitignore' });
  t('14.2a place-keys REFUSES --tmp .gitignore', r.ok === false);
  // NOTE: guard() (called first, as always) legitimately APPENDS its own baseline required lines
  // regardless of which target was requested — that is normal, expected behavior, not a side effect of
  // the refusal. What matters here is that no VALUE content (a '=' line, i.e. a merged secret) ever got
  // written into .gitignore, and the user's own original line survives untouched.
  const afterGitignore = readFile(path.join(dir, '.gitignore')) || '';
  t('14.2b .gitignore original custom comment survives untouched', afterGitignore.includes('# original content, keep me'));
  t('14.2b2 .gitignore was never corrupted with merged KEY=value secret content', !/^[A-Za-z_][A-Za-z0-9_]*=/m.test(afterGitignore));

  // create a REAL .git directory (with a real file inside) so this specifically exercises
  // refusesAsEnvTarget()'s own .git-dir logic, not merely the unrelated "file not found" IO-safety path
  // (bug #6) that would ALSO return ok:false for a not-yet-existing .git in a non-git-inited fixture.
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n', 'utf8');

  const r2 = S.placeKeys(dir, { tmpName: '.git' });
  t('14.2c place-keys REFUSES --tmp .git (the directory itself, real dir present)', r2.ok === false);

  const r3 = S.placeKeys(dir, { tmpName: path.join(dir, '.git', 'config') });
  t('14.2d place-keys REFUSES --tmp pointing INSIDE .git/ (e.g. .git/config)', r3.ok === false);

  const r4 = S.initKeys(dir, { tmpName: '.gitignore' });
  t('14.2e init-keys ALSO refuses --tmp .gitignore (shared refusesAsEnvTarget)', r4.ok === false);
}

// 14.3) ROUND-3 BUG 3 [MED]: obvious placeholder vocabulary compositions must be REJECTED even when no
// single anchored token alone would catch them.
{
  const vocabCases = ['PASTE_KEY_HERE', 'ADD_YOUR_KEY', 'YOUR_TOKEN', 'example_key_1', 'sk-xxxxxxxx', '<paste here>'];
  for (const v of vocabCases) {
    t('14.3a "' + v + '" is caught as an obvious placeholder', S.looksLikePlaceholder(v) === true);
  }
  // a real, plausible-length random value must NOT be caught by the vocab-composition rule
  t('14.3b a real random-looking value is NOT flagged by the vocab rule', S.looksLikePlaceholder('a8f3-92kd-x7q1-zz44-random-real-value') === false);
  t('14.3c isAllPlaceholderVocab requires >=2 words (a single short word is left to length checks)', S.isAllPlaceholderVocab('key') === false);
}

// 14.4) ROUND-3 BUG 4 [LOW]: require an actual placeholder SHAPE (start+end anchored), not mere
// co-occurrence of "example" and an isolated "key" path segment.
{
  const realConnectionString = 'https://example.com/api/key/abc123webhooksecret2026realvalue';
  t('14.4a a real connection string containing "example.com" + a "key" path segment is NOT flagged', S.looksLikePlaceholder(realConnectionString) === false);
  t('14.4b the classic "example_api_key" placeholder is STILL correctly caught (no regression)', S.looksLikePlaceholder('example_api_key') === true);
  t('14.4c "demo_webhook_key" (starts with demo, ends with key) is caught', S.looksLikePlaceholder('demo_webhook_key') === true);

  const dir = freshDir();
  S.initKeys(dir, { type: 'automation' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  let content = readFile(tmpPath);
  content = content.replace(/^(\s*N8N_WEBHOOK_URL=).*$/m, '$1' + realConnectionString);
  fs.writeFileSync(tmpPath, content, 'utf8');
  const r = S.placeKeys(dir);
  t('14.4d end-to-end: the real connection string is STORED (not false-rejected)', r.stored.includes('N8N_WEBHOOK_URL'));
}

// 14.5) ROUND-3 BUG 5 [HIGH] + PRINCIPLE C: never silently lose real-but-unparsed secret content.
{
  // (a) easy win: "export KEY=value" lines are now parsed directly
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const secretValue = 'sk-ant-EXPORTPREFIXTEST0123456789abcdefg';
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'export ANTHROPIC_API_KEY=' + secretValue + '\n', 'utf8');
  const r = S.placeKeys(dir);
  t('14.5a "export KEY=value" is now parsed and STORED (not silently ignored)', r.stored.includes('ANTHROPIC_API_KEY'));
  t('14.5b the export-prefixed real secret actually landed in .env', readFile(path.join(dir, '.env')).includes(secretValue));
  t('14.5c clean full success (export line, nothing else) still DELETES the managed temp', r.deletedTemp === true);
}
{
  // (b) easy win: lone-CR-only line endings are now parsed directly
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const secretValue = 'sk-ant-CRONLYTEST0123456789abcdefghijk';
  const crOnlyContent = '# comment\rANTHROPIC_API_KEY=' + secretValue + '\r';
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), crOnlyContent, 'utf8');
  const r = S.placeKeys(dir);
  t('14.5d lone-CR-only line endings are correctly parsed (not one unparseable blob)', r.stored.includes('ANTHROPIC_API_KEY'));
  t('14.5e the CR-only real secret actually landed in .env', readFile(path.join(dir, '.env')).includes(secretValue));
}
{
  // (c) FAIL-SAFE: a genuinely unparseable format (colon-separated, not KEY=value at all) must be
  // RETAINED, never silently deleted.
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  const secretValue = 'sk-ant-UNPARSEABLETEST0123456789abcdefg';
  fs.writeFileSync(tmpPath, 'ANTHROPIC_API_KEY: ' + secretValue + '\n', 'utf8'); // colon, not '='
  const r = S.placeKeys(dir);
  t('14.5f unparseable colon-style content: place-keys still ok:true (nothing crashed)', r.ok === true);
  t('14.5g unparseable colon-style content: NOTHING was stored (correctly not understood)', r.stored.length === 0);
  t('14.5h unparseable colon-style content: temp file is RETAINED, not deleted', fs.existsSync(tmpPath));
  t('14.5i unparseable colon-style content: deletedTemp:false', r.deletedTemp === false);
  t('14.5j unparseable colon-style content: tempRetainReason mentions could-not-parse', /could not parse/i.test(r.tempRetainReason || ''));
  t('14.5k the real secret is STILL fully intact in the retained file (never lost)', fs.readFileSync(tmpPath, 'utf8').includes(secretValue));
}

// 14.6) ROUND-3 BUG 6 [MED] + PRINCIPLE D: --tmp resolving to a DIRECTORY must be a clean {ok:false},
// never a raw EISDIR crash.
{
  const dir = freshDir();
  const dirAsTmp = path.join(dir, 'a-directory-not-a-file');
  fs.mkdirSync(dirAsTmp, { recursive: true });
  let threw = false, r = null;
  try { r = S.placeKeys(dir, { tmpName: dirAsTmp }); } catch (e) { threw = true; }
  t('14.6a placeKeys() with --tmp as a directory does NOT crash', threw === false);
  t('14.6b placeKeys() reports a clean ok:false', !!r && r.ok === false);
  t('14.6c the reason clearly names it as a directory', !!r && /directory/i.test(r.reason || ''));

  let threw2 = false, r2 = null;
  try { r2 = S.initKeys(dir, { tmpName: dirAsTmp }); } catch (e) { threw2 = true; }
  t('14.6d initKeys() with --tmp as a directory does NOT crash', threw2 === false);
  t('14.6e initKeys() reports a clean ok:false', !!r2 && r2.ok === false);
  t('14.6f the reason clearly names it as a directory', !!r2 && /directory/i.test(r2.reason || ''));

  const cli = runCli(['place-keys', '--tmp', dirAsTmp], dir);
  t('14.6g CLI place-keys with --tmp as a directory exits cleanly (not a raw Node crash)', cli.status === 1);
  t('14.6h CLI place-keys prints the clean reason, not a raw stack trace', /directory/i.test(cli.stderr) && !/\.cjs:\d+:\d+/.test(cli.stderr));
}

// 14.7) ROUND-3 BUG 7 [LOW]: a UTF-16-encoded existing .env must be refused, never silently mis-rotated.
{
  const dir = freshDir();
  const envPath = path.join(dir, '.env');
  const staleSecret = 'sk-ant-STALEUTF16SECRET0123456789abcde';
  const utf16Content = 'ANTHROPIC_API_KEY=' + staleSecret + '\r\n';
  const utf16Buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(utf16Content, 'utf16le')]);
  fs.writeFileSync(envPath, utf16Buf);
  const beforeBytes = fs.readFileSync(envPath);

  S.initKeys(dir, { type: 'rag' });
  const newSecret = 'sk-ant-NEWVALUEAFTERUTF16TEST0123456789';
  fs.writeFileSync(path.join(dir, '.env.forge-setup'), 'ANTHROPIC_API_KEY=' + newSecret + '\n', 'utf8');
  const r = S.placeKeys(dir);
  t('14.7a placeKeys() refuses a UTF-16 existing .env (ok:false)', r.ok === false);
  t('14.7b the reason names the UTF-16 encoding issue', /UTF-16/.test(r.reason || ''));
  const afterBytes = fs.readFileSync(envPath);
  t('14.7c the UTF-16 .env bytes are COMPLETELY UNCHANGED (never silently corrupted)', Buffer.compare(beforeBytes, afterBytes) === 0);
  t('14.7d the fill-file (with the NEW secret) is RETAINED, not deleted (nothing lost)', fs.existsSync(path.join(dir, '.env.forge-setup')));
  t('14.7e the new secret is still intact in the retained fill-file', fs.readFileSync(path.join(dir, '.env.forge-setup'), 'utf8').includes(newSecret));
}

// 14.8) ROUND-3 BUG 8 [LOW] + PRINCIPLE D: init-keys --tmp into a non-existent subdirectory must NOT
// crash with a raw ENOENT, and must NOT leave an orphan .gitignore line if creation ultimately fails.
{
  const dir = freshDir();
  const nestedTmp = path.join(dir, 'does', 'not', 'exist', 'yet', 'mykeys.txt');
  t('14.8a sanity: the parent directory genuinely does not exist yet', !fs.existsSync(path.dirname(nestedTmp)));
  let threw = false, r = null;
  try { r = S.initKeys(dir, { type: 'rag', tmpName: nestedTmp }); } catch (e) { threw = true; }
  t('14.8b init-keys into a non-existent subdir does NOT crash', threw === false);
  t('14.8c init-keys successfully creates the file (parent mkdir -p\'d)', !!r && r.ok === true && fs.existsSync(nestedTmp));
  t('14.8d the parent directory chain was actually created', fs.existsSync(path.dirname(nestedTmp)));
  const giContent = readFile(path.join(dir, '.gitignore'));
  const relPosix = path.relative(dir, nestedTmp).split(path.sep).join('/');
  t('14.8e .gitignore correctly references the created file (no orphan — it really was created)', !!giContent && giContent.split(/\r?\n/).map((l) => l.trim()).includes(relPosix));
}
{
  // CLI-level: same scenario via an absolute --tmp fully inside an isolated fixture (never a bare
  // relative path here — a separator-containing --tmp resolves AS-IS against cwd per round-2 bug 14, so
  // a relative path would risk writing outside the sandbox; always use an absolute path in this test).
  const cliTargetDir = freshDir();
  const cliNestedTmp = path.join(cliTargetDir, 'brandnew', 'sub', 'keys.txt');
  const cli = runCli(['init-keys', '--type', 'rag', '--tmp', cliNestedTmp], cliTargetDir);
  t('14.8f CLI init-keys with an absolute --tmp into a non-existent subdir exits 0 (no crash)', cli.status === 0);
  t('14.8g CLI init-keys successfully created the nested file', fs.existsSync(cliNestedTmp));
  t('14.8h CLI init-keys prints no raw Node stack trace', !/\.cjs:\d+:\d+/.test(cli.stderr));
}

// =====================================================================================================
// 15) ROUND-4 REGRESSION TEST — 1 HIGH data-loss bug: paste-at-top + leftover scaffold blank duplicate
// silently dropped a real pasted secret (last-occurrence-wins) and deleted the user's ONLY copy.
// =====================================================================================================

// 15.1) THE EXACT REPRO: init-keys --type rag, then paste 3 real (synthetic) values at the TOP of the
// fill-file while leaving the scaffold's own blank "KEY=" lines below (the natural newcomer flow) — all
// 3 real values must land in .env, NONE lost, and the temp must be cleanly deleted (clean full success).
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  const scaffold = readFile(tmpPath);
  t('15.1a sanity: the scaffold really has blank KEY= lines for all 3 rag keys', /^ANTHROPIC_API_KEY=\s*$/m.test(scaffold) && /^OPENAI_API_KEY=\s*$/m.test(scaffold) && /^VECTOR_DB_URL=\s*$/m.test(scaffold));

  const anthropicSecret = 'sk-ant-PASTEATTOPTEST0123456789abcdefghij';
  const openaiSecret = 'sk-PASTEATTOPOPENAI0123456789abcdefghijk';
  const vectorSecret = 'https://paste-at-top-vector-db.example-real-host.io:6333';
  const pastedAtTop = [
    'ANTHROPIC_API_KEY=' + anthropicSecret,
    'OPENAI_API_KEY=' + openaiSecret,
    'VECTOR_DB_URL=' + vectorSecret,
    '',
  ].join('\n');
  // The natural newcomer action: paste real values at the TOP, leave the ENTIRE original scaffold
  // (including its own blank KEY= lines) BELOW — each key now appears TWICE.
  fs.writeFileSync(tmpPath, pastedAtTop + scaffold, 'utf8');

  const r = S.placeKeys(dir);
  t('15.1b place-keys ok:true', r.ok === true);
  t('15.1c ANTHROPIC_API_KEY is STORED (not silently dropped as missing)', r.stored.includes('ANTHROPIC_API_KEY'));
  t('15.1d OPENAI_API_KEY is STORED (not silently dropped as missing)', r.stored.includes('OPENAI_API_KEY'));
  t('15.1e VECTOR_DB_URL is STORED (not silently dropped as missing)', r.stored.includes('VECTOR_DB_URL'));
  t('15.1f NOTHING was reported missing (the old bug printed "Missing (left blank...)" for all 3)', r.missing.length === 0);
  t('15.1g NOTHING was skipped/rejected', r.skipped.length === 0);
  const envContent = readFile(path.join(dir, '.env'));
  t('15.1h the real ANTHROPIC secret actually landed in .env', envContent.includes(anthropicSecret));
  t('15.1i the real OPENAI secret actually landed in .env', envContent.includes(openaiSecret));
  t('15.1j the real VECTOR_DB_URL secret actually landed in .env', envContent.includes(vectorSecret));
  t('15.1k clean full success (real values won over the blank duplicates): temp file IS deleted', r.deletedTemp === true && !fs.existsSync(tmpPath));

  // CLI-level: the exact old misleading message ("Missing (left blank, add later)") must NOT appear when
  // real values were actually pasted for those keys.
  const dir2 = freshDir();
  runCli(['init-keys', '--type', 'rag'], dir2);
  const scaffold2 = readFile(path.join(dir2, '.env.forge-setup'));
  fs.writeFileSync(path.join(dir2, '.env.forge-setup'), pastedAtTop + scaffold2, 'utf8');
  const cli = runCli(['place-keys'], dir2);
  t('15.1l CLI place-keys reports all 3 keys stored', /Stored 3 key\(s\)/.test(cli.stdout));
  t('15.1m CLI place-keys does NOT print the misleading "Missing" line for these keys', !/Missing \(left blank/.test(cli.stdout));
  t('15.1n CLI place-keys deleted the temp file (clean success)', /Deleted the temp file/.test(cli.stdout));
}

// 15.2) CONTROL: the same 3 values inline WITHOUT the trailing scaffold blank duplicates store correctly
// too — proves the values themselves are valid and the loss (before the fix) was caused SOLELY by the
// duplicate blank line, not by anything else about the values.
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  const anthropicSecret = 'sk-ant-CONTROLNOBLANK0123456789abcdefghij';
  const openaiSecret = 'sk-CONTROLNOBLANKOPENAI0123456789abcdefg';
  const vectorSecret = 'https://control-no-blank-vector-db.example-real-host.io:6333';
  fs.writeFileSync(tmpPath, [
    'ANTHROPIC_API_KEY=' + anthropicSecret,
    'OPENAI_API_KEY=' + openaiSecret,
    'VECTOR_DB_URL=' + vectorSecret,
  ].join('\n') + '\n', 'utf8');
  const r = S.placeKeys(dir);
  t('15.2a control (no duplicate blanks): all 3 stored', r.stored.length === 3);
  t('15.2b control: temp deleted (clean success)', r.deletedTemp === true);
}

// 15.3) CONFLICT VARIANT: the SAME key appears twice with two DIFFERENT non-empty values (e.g. a
// corrected typo) — must NOT silently pick one and delete the temp; must RETAIN it (still gitignored)
// and REPORT the conflicting key by name, and must NOT write either disputed value to .env.
{
  const dir = freshDir();
  S.initKeys(dir, { type: 'rag' });
  const tmpPath = path.join(dir, '.env.forge-setup');
  const firstTypo = 'sk-ant-FIRSTTYPOVALUE0123456789abcdefghij';
  const secondCorrected = 'sk-ant-SECONDCORRECTEDVALUE0123456789ab';
  fs.writeFileSync(tmpPath, [
    'ANTHROPIC_API_KEY=' + firstTypo,
    'ANTHROPIC_API_KEY=' + secondCorrected,
    'OPENAI_API_KEY=sk-CLEANSINGLEVALUE0123456789abcdefghi',
  ].join('\n') + '\n', 'utf8');

  const r = S.placeKeys(dir);
  t('15.3a place-keys ok:true (does not crash, does not error out)', r.ok === true);
  t('15.3b the conflicting key is reported by name', !!r.conflicting && r.conflicting.includes('ANTHROPIC_API_KEY'));
  t('15.3c the conflicting key is NOT in stored (neither disputed value silently chosen)', !r.stored.includes('ANTHROPIC_API_KEY'));
  t('15.3d the non-conflicting key (OPENAI_API_KEY) still stores normally', r.stored.includes('OPENAI_API_KEY'));
  t('15.3e temp file is RETAINED (not deleted) — neither typed value is lost', fs.existsSync(tmpPath) && r.deletedTemp === false);
  t('15.3f tempRetainReason names the conflicting key and explains why', /duplicate key/i.test(r.tempRetainReason || '') && r.tempRetainReason.includes('ANTHROPIC_API_KEY'));
  const rawTmp = fs.readFileSync(tmpPath, 'utf8');
  t('15.3g BOTH disputed values are still fully present in the retained file (fully recoverable)', rawTmp.includes(firstTypo) && rawTmp.includes(secondCorrected));
  const envContent = fs.existsSync(path.join(dir, '.env')) ? readFile(path.join(dir, '.env')) : '';
  t('15.3h neither disputed ANTHROPIC value was written to .env', !envContent.includes(firstTypo) && !envContent.includes(secondCorrected));
  t('15.3i the non-conflicting OPENAI value WAS written to .env', envContent.includes('sk-CLEANSINGLEVALUE0123456789abcdefghi'));

  // CLI-level: the conflict is reported by name
  const dir2 = freshDir();
  runCli(['init-keys', '--type', 'rag'], dir2);
  fs.writeFileSync(path.join(dir2, '.env.forge-setup'), [
    'ANTHROPIC_API_KEY=' + firstTypo,
    'ANTHROPIC_API_KEY=' + secondCorrected,
  ].join('\n') + '\n', 'utf8');
  const cli = runCli(['place-keys'], dir2);
  t('15.3j CLI place-keys reports the conflicting key by name', cli.stdout.includes('Conflicting') && cli.stdout.includes('ANTHROPIC_API_KEY'));
  t('15.3k CLI place-keys kept the temp file (not deleted)', /Kept the temp file/.test(cli.stdout));
  t('15.3l CLI place-keys NEVER echoes either disputed secret value', !cli.stdout.includes(firstTypo) && !cli.stdout.includes(secondCorrected) && !cli.stderr.includes(firstTypo) && !cli.stderr.includes(secondCorrected));
}

// 15.4) UNIT-LEVEL: parseKeyValueLines() / findConflictingDuplicateKeys() in isolation.
{
  t('15.4a a non-empty value followed by a blank duplicate resolves to the non-empty value', S.parseKeyValueLines('KEY=real-value\nKEY=\n').KEY === 'real-value');
  t('15.4b a blank FOLLOWED BY a non-empty value also resolves to the non-empty value (order-independent)', S.parseKeyValueLines('KEY=\nKEY=real-value\n').KEY === 'real-value');
  t('15.4c two identical non-empty duplicates: not flagged as a conflict', S.findConflictingDuplicateKeys('KEY=same\nKEY=same\n').length === 0);
  t('15.4d a blank duplicate is never flagged as a conflict', S.findConflictingDuplicateKeys('KEY=real\nKEY=\n').length === 0);
  t('15.4e two DIFFERENT non-empty values for the same key IS flagged as a conflict', S.findConflictingDuplicateKeys('KEY=first\nKEY=second\n').includes('KEY'));
  t('15.4f a key that appears only once is never flagged as a conflict', S.findConflictingDuplicateKeys('KEY=onlyonce\n').length === 0);
}

console.log(pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : ''));
process.exitCode = fail ? 1 : 0;
