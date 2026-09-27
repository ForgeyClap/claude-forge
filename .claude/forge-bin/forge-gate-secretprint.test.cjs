#!/usr/bin/env node
'use strict';
// forge-gate-secretprint.test.cjs — WP-K1 (2026-09-27, independent Codex review of the v2.9.0 integration,
// findings F1/F2). Dedicated coverage for the secret-print command gate beyond hard-gates.json's own
// examples.match/no_match (already swept by forge-actiongate.test.cjs section 1):
//
//   F1  the grep-family `-o`/`--only-matching` exemption was UNSOUND (`grep -o '.*' .env` kept the flag while
//       still printing the whole line) and has been removed entirely; the sanctioned replacement is the
//       dedicated helper forge-env-names.cjs, which must never itself trip this gate.
//   F2  git content-display (`git show <rev>:<secret>`, `git show <rev> -- <secret>`,
//       `git cat-file -p/--textconv/--filters <rev>:<secret>`), common credential filenames beyond
//       `.env`/keys/`.claude/.credentials.json` (`credentials.json`, `service-account*.json`, `*.p12`/`*.pfx`,
//       `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.docker/config.json`, `.aws/credentials`), and
//       `find`/`xargs` indirection (`-exec`, and the piped `| xargs` form via a NEW pattern_line) all used to
//       bypass the gate entirely.
//
// This file also proves (as promised in hard-gates.json's secret-print `_gate_coverage_note`) that a
// representative sample of settings.json's permissions.deny list and this gate's own target list stay in
// sync, and that the gate's quote-mask protection (a search tool's own quoted MENTION of a dangerous shape)
// still holds for the new find/xargs pattern_line, through a REAL spawned hook process — never a probe string
// placed on this test's own command line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const gate = require('./forge-actiongate.cjs');
const hook = require('./forge-gate-hook.cjs');
const data = require('./forge-gate-data.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

console.log('forge-gate-secretprint tests (WP-K1: secret-print F1 -o removal, F2 git-show/credentials/find-xargs)');

// ---------------------------------------------------------------------------
// 1) F1 — the -o/--only-matching exemption is gone; a raw classify() call now catches it
// ---------------------------------------------------------------------------
console.log('\n1) F1 — grep -o/--only-matching no longer exempts a secret target');

for (const cmd of ["grep -o '^[A-Z_]*=' .env", "grep -io '^[a-z_]*=' .env", "rg --only-matching '^[A-Z_]*=' .env", "grep -o '.*' .env"]) {
  t('classify() now fires secret-print: ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), 'expected secret-print in ' + JSON.stringify(gate.classify(cmd).matched));
  });
}

// ---------------------------------------------------------------------------
// 2) F1 — the sanctioned replacement never trips the gate, and does what it promises
// ---------------------------------------------------------------------------
console.log('\n2) F1 — forge-env-names.cjs is the safe replacement');

t('classify() stays silent for the helper\'s own command line against a real .env target', () => {
  assert.strictEqual(gate.classify('node .claude/forge-bin/forge-env-names.cjs .env').matched.includes('secret-print'), false);
  assert.strictEqual(gate.classify('node .claude/forge-bin/forge-env-names.cjs .env --json').matched.includes('secret-print'), false);
});

const ENV_NAMES = require('./forge-env-names.cjs');
t('forge-env-names.cjs never returns or logs a value, only names, even for malformed lines', () => {
  const sample = ['# comment', 'DATABASE_URL=postgres://user:pass@host/db', 'export API_KEY=sk-secret',
    '  SPACED = value with spaces', '', 'not a valid line', '123BAD=nope', 'KEY-WITH-DASH=nope', '=novalue',
    'LAST_ONE=final'].join('\n');
  const names = ENV_NAMES.envNames(sample);
  assert.deepStrictEqual(names, ['DATABASE_URL', 'API_KEY', 'SPACED', 'LAST_ONE']);
  for (const n of names) assert.ok(!/secret|pass|http/i.test(n), 'a value leaked into the name list: ' + n);
});

// ---------------------------------------------------------------------------
// 3) F2a — git show / git cat-file content reveal
// ---------------------------------------------------------------------------
console.log('\n3) F2a — git show / git cat-file content-display of a secret path');

for (const cmd of ['git show HEAD:.env', 'git show HEAD -- .env', 'git show origin/main:.env',
  'git -C /repo show HEAD:.env', 'git cat-file -p HEAD:.env', 'git cat-file --textconv HEAD:.env',
  'git cat-file --filters HEAD:secrets/api.json']) {
  t('classify() fires secret-print: ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ['git show HEAD~1:src/app.js', 'git show --stat HEAD', 'git show HEAD -- src/app.js',
  'git cat-file -t HEAD:src/app.js', 'git cat-file -s HEAD:src/app.js', 'git log --stat -- .env', 'git log --oneline -- .env',
  'git diff --stat -- .env', 'git diff --name-only -- .env', 'git diff -- .env.example', 'git log -p -- src/app.js']) {
  t('classify() stays silent: ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}

// Codex stop-gate K1-01: patch-producing git commands on a secret path fire; metadata-only forms stay allowed.
for (const cmd of ['git log -p -- .env', 'git log --patch -- .env.local', 'git log -L 1,5:.env', 'git diff -- .env',
  'git diff HEAD~1 .env', 'git diff --cached .env.production', 'git blame .env', 'git annotate secrets/api.json',
  'git whatchanged -p -- .env']) {
  t('classify() fires secret-print (patch of a secret path): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}

// ---------------------------------------------------------------------------
// 4) F2b — common credential filenames beyond .env/keys/.claude/.credentials.json
// ---------------------------------------------------------------------------
console.log('\n4) F2b — credentials.json, service-account*.json, .p12/.pfx, .npmrc/.pypirc/.netrc, .git-credentials, .docker/config.json, .aws/credentials');

for (const cmd of ['cat credentials.json', 'cat my-credentials-backup.json', 'type service-account-key.json',
  'Get-Content backup.p12', 'cat cert.pfx', 'cat .npmrc', 'cat .pypirc', 'cat .netrc', 'cat .git-credentials',
  'cat .docker/config.json', 'cat .aws/credentials', 'type .aws\\credentials']) {
  t('classify() fires secret-print: ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
t('classify() stays silent for an unrelated .json file', () => {
  assert.strictEqual(gate.classify('cat package.json').matched.includes('secret-print'), false);
  assert.strictEqual(gate.classify('cat tsconfig.json').matched.includes('secret-print'), false);
});

// ---------------------------------------------------------------------------
// 5) F2c — find -exec / find | xargs indirection (target named before the reader)
// ---------------------------------------------------------------------------
console.log('\n5) F2c — find -exec/xargs naming a secret target before the reader verb');

t('classify() fires secret-print for a find -exec clause', () => {
  assert.ok(gate.classify('find . -name .env -exec cat {} \\;').matched.includes('secret-print'));
});
t('classify() fires secret-print for the piped find | xargs form (via pattern_line)', () => {
  assert.ok(gate.classify('find . -name .env -print0 | xargs -0 cat').matched.includes('secret-print'));
  assert.ok(gate.classify('find . -iname .env | xargs cat').matched.includes('secret-print'));
});
t('classify() stays silent for find without a reader, or without a secret target', () => {
  assert.strictEqual(gate.classify('find . -name .env').matched.includes('secret-print'), false);
  assert.strictEqual(gate.classify("find . -name '*.js' -exec echo {} \\;").matched.includes('secret-print'), false);
  assert.strictEqual(gate.classify('find . -name "*.log" -print0 | xargs -0 wc -l').matched.includes('secret-print'), false);
});

// ---------------------------------------------------------------------------
// 6) settings.json permissions.deny stays in sync with a representative sample of this gate's target list
//    (promised by hard-gates.json's secret-print _gate_coverage_note)
// ---------------------------------------------------------------------------
console.log('\n6) settings.json permissions.deny cross-check');

const SETTINGS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.json'), 'utf8'));
const DENY = SETTINGS.permissions && SETTINGS.permissions.deny || [];
t('settings.json denies Read of the classic secret shapes this gate also blocks at the shell-command level', () => {
  for (const shape of ['.env', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'secrets/**']) {
    assert.ok(DENY.some((d) => d.includes(shape)), 'settings.json permissions.deny no longer mentions ' + shape);
  }
});
t('every classic Read-denied shape still has a live secret-print command-level match', () => {
  const probes = { '.env': 'cat .env', '*.pem': 'cat x.pem', '*.key': 'cat x.key', 'id_rsa*': 'cat id_rsa',
    'id_ed25519*': 'cat id_ed25519', 'secrets/**': 'cat secrets/x.txt' };
  for (const [shape, cmd] of Object.entries(probes)) {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), shape + ' -> ' + cmd + ' no longer fires secret-print');
  }
});

// ---------------------------------------------------------------------------
// 7) end-to-end — real spawned forge-gate-hook.cjs process (never a probe string on this test's own argv)
// ---------------------------------------------------------------------------
console.log('\n7) end-to-end — real spawned forge-gate-hook.cjs process');

const HOOK = path.join(__dirname, 'forge-gate-hook.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-secretprint-'));
const HOME = path.join(TMP, 'home');
const PROJ = path.join(TMP, 'project');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });
function envFor() { return Object.assign({}, process.env, { FORGE_CONFIG_HOME: HOME, FORGE_PROJECT_ROOT: PROJ }); }
function spawnHook(input) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [HOOK], { input: stdin, encoding: 'utf8', env: envFor(), timeout: 15000 });
}
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

t('spawned hook BLOCKS (exit 2, names secret-print): cat .aws/credentials', () => {
  const r = spawnHook(bash('cat .aws/credentials'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook BLOCKS (exit 2, names secret-print): git show HEAD:.env', () => {
  const r = spawnHook(bash('git show HEAD:.env'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook BLOCKS (exit 2, names secret-print): find . -name .env -print0 | xargs -0 cat', () => {
  const r = spawnHook(bash('find . -name .env -print0 | xargs -0 cat'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook ALLOWS (exit 0): the dedicated helper reading .env by name only', () => {
  const r = spawnHook(bash('node .claude/forge-bin/forge-env-names.cjs .env'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});
t('spawned hook ALLOWS (exit 0): a search tool merely quoting the find/xargs shape as its own pattern data', () => {
  const r = spawnHook(bash('grep -rn "find . -name .env -print0 | xargs -0 cat" docs'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});
t('spawned hook ALLOWS (exit 0): .env.example stays readable', () => {
  const r = spawnHook(bash('cat .env.example'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});
t('spawned hook ALLOWS (exit 0): ls/test -f/git status/diff --stat/git ls-files stay allowed', () => {
  for (const cmd of ['ls .env', 'test -f .env', 'git status', 'git diff --stat', 'git ls-files']) {
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 0, cmd + ' -> exit ' + r.status + ', stderr: ' + r.stderr);
  }
});

// ---------------------------------------------------------------------------
// 8) N1 (WP-L1, 2026-09-27, independent Codex verification review) — git show/diff metadata-only forms are
// false positives. git show gains the same content-suppressing-option exemption git diff already had;
// git diff's own list also gains --raw, which had been missed.
// ---------------------------------------------------------------------------
console.log('\n8) N1 — git show/diff metadata-only forms (--name-only, --stat, --raw, -s, ...) stay silent');

const GIT_SHOW_ALLOWED_FLAGS = ['--name-only', '--name-status', '--stat', '--numstat', '--shortstat', '--summary', '--raw', '--no-patch', '-s'];
for (const flag of GIT_SHOW_ALLOWED_FLAGS) {
  const cmd = 'git show ' + flag + ' HEAD -- .env';
  t('classify() stays silent (git show ' + flag + '): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('classify() stays silent: git diff --raw -- .env', () => {
  assert.strictEqual(gate.classify('git diff --raw -- .env').matched.includes('secret-print'), false);
});
// COUNTEREXAMPLE, deliberately NOT exempted: `git diff --check` prints the offending lines THEMSELVES
// (e.g. "path/.env:3: trailing whitespace." followed by the actual "+DB_PASSWORD=..." content line) — it is
// a real content reveal, not a metadata-only summary, so it must stay blocked exactly like a plain
// `git diff -- .env` does. This pins the negative space: adding a flag to the exemption list is only safe
// when that flag genuinely never prints file content, and --check is the reminder of why that matters.
t('classify() still fires (git diff --check prints the offending lines themselves, not just metadata): git diff --check -- .env', () => {
  assert.ok(gate.classify('git diff --check -- .env').matched.includes('secret-print'));
});
t('end to end: the spawned hook allows every git show/diff metadata-only form and still blocks git diff --check', () => {
  for (const flag of GIT_SHOW_ALLOWED_FLAGS) {
    const cmd = 'git show ' + flag + ' HEAD -- .env';
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 0, cmd + ' -> exit ' + r.status + ', stderr: ' + r.stderr);
  }
  const rawR = spawnHook(bash('git diff --raw -- .env'));
  assert.strictEqual(rawR.status, 0, 'git diff --raw -- .env -> exit ' + rawR.status + ', stderr: ' + rawR.stderr);
  const checkR = spawnHook(bash('git diff --check -- .env'));
  assert.strictEqual(checkR.status, 2, 'git diff --check -- .env -> exit ' + checkR.status + ', stderr: ' + checkR.stderr);
  assert.ok(checkR.stderr.includes('secret-print'), checkR.stderr);
});

// Fixing the above surfaced a SEPARATE, pre-existing collision (see the gate's own _pattern_doc, "WP-L1
// follow-up"): the plain reader-verb arm's `head` alternative is case-insensitive like the rest of this
// pattern, so it also matched git's own literal revision name "HEAD" — the show-specific exemption alone
// was not enough, because a DIFFERENT arm fired on "HEAD" regardless of which flag was present. Without the
// negative-lookbehind fix, EVERY assertion above with a literal "HEAD" in the command would still fail.
t('the head/HEAD collision is closed: a genuine standalone "head .env" still fires, "git ... HEAD ... .env" never fires via that arm', () => {
  assert.ok(gate.classify('head .env').matched.includes('secret-print'), 'a real head command must still be caught');
  assert.strictEqual(gate.classify('git show --name-only HEAD -- .env').matched.includes('secret-print'), false);
  assert.ok(gate.classify('git show HEAD -- .env').matched.includes('secret-print'), 'the show arm itself must still fire without an exemption flag');
});

// ---------------------------------------------------------------------------
// 9) WP-M1 (2026-09-27, independent review + the Lead's own live use of the gate) — a search tool's own
//    PATTERN argument (grep/egrep/fgrep/rg/Select-String/sls/findstr) must never fire this gate merely
//    because it CONTAINS a secret-shaped substring; only a FILE argument may.
// ---------------------------------------------------------------------------
console.log('\n9) WP-M1 — secret-print no longer fires on a search tool\'s own PATTERN argument');

// 9a — the task's own 5 must-ALLOW examples, proven at the raw classify() level (not merely via the separate
// forge-gate-data.cjs pre-classify stripping pass — see 9d below for that layer's own coverage).
for (const cmd of ['grep -rn "\\.env" src/', 'git ls-files | grep -i "\\.env"', 'rg -l "DATABASE_URL|\\.env" .',
  'Select-String -Pattern "\\.env" -Path src\\*.js', 'findstr /s ".env" *.js']) {
  t('classify() stays silent (pattern argument, not a file): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
// 9b — the task's own 6 must-BLOCK examples stay blocked (unchanged behaviour, pinned against regression).
for (const cmd of ['grep -i SECRET .env', 'grep -e x .env.local', 'rg API_KEY .env.production',
  'Select-String -Path .env -Pattern x', 'findstr x .env', "grep -o '.*' .env"]) {
  t('classify() still fires (a real file target): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
// 9c — the classifier-level fix also covers shapes the task's own examples never quoted: an UNQUOTED pattern,
// and the grep-family's --regexp=/--file= ATTACHED flag form.
t('classify() stays silent for an UNQUOTED pattern argument (no data-stripping layer to lean on)', () => {
  assert.strictEqual(gate.classify('grep -rn .env src/').matched.includes('secret-print'), false);
  assert.strictEqual(gate.classify('findstr .env *.js').matched.includes('secret-print'), false);
});
t('classify() stays silent for the --regexp= attached flag form (a pattern)', () => {
  assert.strictEqual(gate.classify("rg --regexp=.env src/").matched.includes('secret-print'), false);
});
// v2.9.0 (Lead, after WP-M2): --file= NAMES A FILE the tool reads, so a secret file there must fire.
t('classify() fires for the --file= attached flag form naming a secret file', () => {
  assert.strictEqual(gate.classify("grep --file=.env notes.txt").matched.includes('secret-print'), true);
});
// 9d — the DANGEROUS direction this fix also closes: quoting a real secret FILE target must never exempt it,
// whether the pattern comes from an explicit -e/flag or the implicit first-positional fallback, and whether
// or not forge-gate-data.cjs's own pre-classify stripping runs first (proven end-to-end via the real spawned
// hook, never merely via classify() on text this test typed unstripped).
for (const cmd of ["grep API_KEY '.env'", "grep -e SECRET '.env'", "Select-String -Pattern x -Path '.env'"]) {
  t('classify() fires for a QUOTED secret file target (quoting must never exempt a real file): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
t('end to end: the spawned hook still BLOCKS a quoted secret FILE target (forge-gate-data.cjs no longer erases it)', () => {
  const r = spawnHook(bash("grep API_KEY '.env'"));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('end to end: the spawned hook ALLOWS every one of the 5 task examples (full pipeline, not just classify())', () => {
  for (const cmd of ['grep -rn "\\.env" src/', 'rg -l "DATABASE_URL|\\.env" .', 'findstr /s ".env" *.js']) {
    const r = spawnHook(bash(cmd));
    assert.strictEqual(r.status, 0, cmd + ' -> exit ' + r.status + ', stderr: ' + r.stderr);
  }
  const ps = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'Select-String -Pattern "\\.env" -Path src\\*.js' } }),
    encoding: 'utf8', env: envFor(), timeout: 15000,
  });
  assert.strictEqual(ps.status, 0, 'exit ' + ps.status + ', stderr: ' + ps.stderr);
});
// 9e — forge-gate-data.cjs's own narrowed pre-classify stripping, tested directly (unit-level, not just via
// the spawned hook above): it now only ever picks the recognised PATTERN word(s), never a FILE argument, even
// when the file argument happens to be quoted.
t('forge-gate-data.cjs::searchPatternWords() only ever names the PATTERN word, never a quoted FILE argument', () => {
  const segs = data.scanWords("grep API_KEY '.env'", 'Bash');
  const ws = segs[0].words;
  const picked = data.searchPatternWords('grep', ws);
  assert.strictEqual(picked.size, 1);
  assert.ok(picked.has(ws[1]), 'API_KEY (the implicit positional pattern) must be picked');
  assert.ok(!picked.has(ws[2]), '\'.env\' (the quoted FILE target) must NOT be picked');
});
t('forge-gate-data.cjs::stripInertData() leaves a quoted secret FILE target intact, but still strips a quoted pattern', () => {
  const r = data.stripInertData("grep 'API_KEY' '.env'", 'Bash');
  assert.strictEqual(r.text, "grep '' '.env'", 'the pattern is stripped, the file target is not');
});
t('forge-gate-data.cjs::stripInertData() strips nothing at all when the (implicit-positional) pattern is unquoted — nothing whole-quoted to strip', () => {
  const r = data.stripInertData("grep API_KEY '.env'", 'Bash');
  assert.strictEqual(r.text, "grep API_KEY '.env'", 'unquoted words are never stripped; classify() itself handles this case (see 9c)');
});
t('Select-String never gets an implicit positional pattern from forge-gate-data.cjs either (deliberately no fallback)', () => {
  const segs = data.scanWords("Select-String -Path .env", 'PowerShell');
  const picked = data.searchPatternWords('select-string', segs[0].words);
  assert.strictEqual(picked.size, 0);
});

// ---------------------------------------------------------------------------
// 10) WP-M2 (2026-09-27, Codex stop-gate review of WP-M1) — F1: the search-tool head must be resolved ONLY at
//     the segment's true command position (never found by scanning every word for a matching name); F2:
//     -e/--regexp/-f/--file flag detection AND the implicit positional-pattern fallback must both stop at a
//     standalone `--`, in both the classifier (this file) and the pre-classify stripping layer (gate-data.cjs).
// ---------------------------------------------------------------------------
console.log('\n10) WP-M2 — F1 command-position-only head, F2 -- (end of options) boundary');

// 10a — F1: a search-tool NAME appearing later in the segment must never exempt the REAL leading reader verb.
for (const cmd of ['cat grep .env', 'type rg .env', 'head findstr .env.local']) {
  t('classify() still fires (F1: a search-tool name later in the segment must not exempt the real leading verb): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
t('classify() still fires across a `;`-separated segment too: echo grep; cat .env', () => {
  assert.ok(gate.classify('echo grep; cat .env').matched.includes('secret-print'));
});

// 10b — F2: option parsing stops at a standalone `--`. A `-e`/`-f` flag AFTER `--` is a literal pattern, not a
// flag, so what follows it is still a plain FILE argument.
for (const cmd of ['grep -- -e .env', 'grep -- TOKEN .env', 'rg -- -e .env.production', 'grep -e x -- .env']) {
  t('classify() fires (F2: -- ends OPTION parsing; a word after it is a plain FILE unless it is the positional pattern): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ['grep -rn -- "\\.env" src/', 'grep -rn "\\.env" src/']) {
  t('classify() stays silent (F2 negative space: a real pattern before/after -- is still just the pattern): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}

// 10c — F1: the ONLY wrapper commands the head resolver looks past are sudo/command/builtin/env — names
// forge-gate-quotes.cjs's own matchWrapper()/stripWrapperOptions() already resolves, including each wrapper's
// OWN flags (sudo's `-u root`, env's own `FOO=bar` assignment), never a naive `/^sudo\s+/`.
for (const cmd of ['sudo grep -rn "\\.env" src/', 'sudo -u root grep -rn "\\.env" src/', 'env grep -rn "\\.env" src/',
  'env FOO=bar grep -rn "\\.env" src/', 'command grep -rn "\\.env" src/', 'builtin grep -rn "\\.env" src/',
  'FOO=1 grep -rn "\\.env" src/']) {
  t('classify() stays silent (F1: a recognised wrapper/env-assignment in front of a real search tool is still just a pattern): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
for (const cmd of ['sudo cat .env', 'env cat .env', 'command grep SECRET .env']) {
  t('classify() still fires (a wrapper never turns a REAL reader/file target into an exempt pattern): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
t('classify() still fires for a wrapper OUTSIDE the narrow allow-list (deliberately conservative, not a gap)', () => {
  // "timeout" is a real wrapper name forge-gate-quotes.cjs knows, but it is NOT in SEARCH_TOOL_WRAPPER_NAMES —
  // the safe direction is to keep blocking rather than silently widen the exemption to every wrapper shape.
  assert.ok(gate.classify('timeout 5 grep -rn "\\.env" src/').matched.includes('secret-print'));
});

// 10d — direct unit coverage of the two new exported helpers.
t('resolveSearchToolHead() resolves past sudo/env/command/builtin and their own flags, never past an unlisted wrapper', () => {
  assert.strictEqual(gate.resolveSearchToolHead('sudo -u root grep x').rest, 'grep x');
  assert.strictEqual(gate.resolveSearchToolHead('env FOO=bar grep x').rest, 'grep x');
  assert.strictEqual(gate.resolveSearchToolHead('command grep x').rest, 'grep x');
  assert.strictEqual(gate.resolveSearchToolHead('builtin grep x').rest, 'grep x');
  assert.strictEqual(gate.resolveSearchToolHead('FOO=1 grep x').rest, 'grep x');
  assert.strictEqual(gate.resolveSearchToolHead('timeout 5 grep x').rest, 'timeout 5 grep x');
  assert.strictEqual(gate.resolveSearchToolHead('cat grep x').rest, 'cat grep x');
});
t('SEARCH_TOOL_WRAPPER_NAMES is exactly the four documented wrapper names', () => {
  assert.deepStrictEqual([...gate.SEARCH_TOOL_WRAPPER_NAMES].sort(), ['builtin', 'command', 'env', 'sudo']);
});

// 10e — forge-gate-data.cjs's own searchPatternWords() must apply the SAME -- boundary (the pre-classify
// stripping layer, so a real secret FILE argument after -- is never erased as if it were inert pattern data).
t('forge-gate-data.cjs::searchPatternWords() never picks a FILE positioned after -- as the pattern, even when the explicit flag itself sits after --', () => {
  const segs = data.scanWords("grep -- -e '.env'", 'Bash');
  const ws = segs[0].words;
  const picked = data.searchPatternWords('grep', ws);
  assert.strictEqual(picked.size, 1);
  assert.ok(picked.has(ws[2]), '"-e" (the literal pattern text right after --) must be picked');
  assert.ok(!picked.has(ws[3]), "'.env' (the real FILE after --) must NOT be picked");
});
t('forge-gate-data.cjs::stripInertData() leaves a quoted secret FILE target after -- intact', () => {
  const r = data.stripInertData("grep -- -e '.env'", 'Bash');
  assert.strictEqual(r.text, "grep -- -e '.env'", 'nothing quoted here is the pattern position, so nothing is stripped');
});

// 10f — end-to-end, the real spawned hook, for a representative subset of the above (never a probe string on
// this test's own command line — the same convention section 7 already established).
t('spawned hook BLOCKS (exit 2, names secret-print): cat grep .env', () => {
  const r = spawnHook(bash('cat grep .env'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook BLOCKS (exit 2, names secret-print): grep -- -e .env', () => {
  const r = spawnHook(bash('grep -- -e .env'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});
t('spawned hook ALLOWS (exit 0): grep -rn -- "\\.env" src/ (pattern after --, real file elsewhere)', () => {
  const r = spawnHook(bash('grep -rn -- "\\.env" src/'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});
t('spawned hook ALLOWS (exit 0): sudo grep with a pattern-position secret mention', () => {
  const r = spawnHook(bash('sudo grep -rn "\\.env" src/'));
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ', stderr: ' + r.stderr);
});
t('spawned hook BLOCKS (exit 2): sudo cat .env (a wrapper never exempts a real reader command)', () => {
  const r = spawnHook(bash('sudo cat .env'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});

// 11) v2.9.0 (Lead, adversarial probe after WP-M2): -f/--file NAMES A FILE the tool reads (its patterns). It still
// marks "a pattern was given explicitly" (every remaining positional is a file) but its value is never exempted.
console.log('\n11) grep/rg -f/--file: the pattern-source file is a file target');
for (const cmd of ['grep -f .env config.txt', 'grep -o -f .env notes.txt', 'grep --file=.env notes.txt', 'rg -f .env.local src']) {
  t('classify() fires secret-print (-f names the secret file): ' + cmd, () => {
    assert.ok(gate.classify(cmd).matched.includes('secret-print'), cmd);
  });
}
for (const cmd of ['grep -f patterns.txt -rn src/', 'grep -e "\\.env" -f patterns.txt src/', 'grep --file=patterns.txt src/']) {
  t('classify() stays silent (-f names a non-secret file): ' + cmd, () => {
    assert.strictEqual(gate.classify(cmd).matched.includes('secret-print'), false, cmd);
  });
}
t('spawned hook BLOCKS (exit 2, names secret-print): grep -o -f .env notes.txt', () => {
  const r = spawnHook(bash('grep -o -f .env notes.txt'));
  assert.strictEqual(r.status, 2, 'exit ' + r.status + ', stderr: ' + r.stderr);
  assert.ok(r.stderr.includes('secret-print'), r.stderr);
});

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
