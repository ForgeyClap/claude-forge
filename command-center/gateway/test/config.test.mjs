// wp12 (forge-2026-09-24-config-v250) tests — buildForgeConfig() against THIS project's real
// forge-config.cjs, its stale-while-revalidate cache, the truthful UNAVAILABLE paths (no script,
// failing script, non-JSON output), secret redaction on both the failure and the success path, the
// env allowlist + cwd of the spawn, and the GET /api/config route (200 / 404 / 405, no secrets).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { filteredEnv } from '../src/exec-cli.mjs';
import {
  buildForgeConfig,
  _setForgeConfigCjsForTests,
  _resetForgeConfigCacheForTests,
  _expireForgeConfigCacheForTests,
  _awaitForgeConfigRefreshForTests,
  _FORGE_CONFIG_CACHE_TTL_MS_FOR_TESTS,
} from '../src/config.mjs';
import {
  _setConfigAuditLogFileForTests,
  _resetConfigAuditLogFileForTests,
} from '../src/config-write.mjs';
import { PROJECT_ROOT, SYNC_SCAN_ROOTS } from '../src/paths.mjs';
import { createServer } from '../src/server.mjs';
import {
  _resetProjectsCacheForTests,
  _setForgeSyncCjsForTests,
  _resetForgeSyncCjsForTests,
  _setScanRootsForTests,
  _resetScanRootsForTests,
} from '../src/projects.mjs';
import { makeTempProjectRoot, request, requestWithBody } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
const FAKE_KEY = 'nvapi-abcdefghij1234567890';

// The real run reads the machine-wide ~/.claude/FORGE_CONFIG.json too. Pointing HOME/USERPROFILE at an
// empty temp dir for the duration of one call makes the asserted values the project's real schema
// defaults — independent of whatever the owner has set on this machine — while still running the
// project's own real script against its own real schema.
async function withIsolatedHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeProjectScript(projectRoot, source) {
  const binDir = path.join(projectRoot, '.claude', 'forge-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'forge-config.cjs'), source, 'utf8');
}

function assertUnavailableShape(result) {
  assert.equal(result.ok, true);
  assert.equal(result.available, false);
  assert.equal(result.state, 'UNAVAILABLE');
  assert.ok(typeof result.note === 'string' && result.note.length > 0);
  assert.deepEqual(result.settings, []);
  assert.deepEqual(result.locked, []);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.notes, []);
  assert.equal(result.files, null);
}

test('buildForgeConfig runs the real forge-config.cjs list against this project and maps it 1:1', async () => {
  _resetForgeConfigCacheForTests();
  const result = await withIsolatedHome(() => buildForgeConfig(PROJECT_ROOT));
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.state, 'OK');
  assert.equal(result.provenance, 'DERIVED');
  assert.equal(result.age_ms, 0);
  assert.ok(result.settings.length >= 30, 'this project ships 30+ real settings, got ' + result.settings.length);
  const pauseAt = result.settings.find((s) => s.key === 'usage-guard.pause-at');
  assert.ok(pauseAt, 'usage-guard.pause-at must be listed');
  assert.equal(pauseAt.value, 98);
  assert.equal(pauseAt.source, 'default');
  assert.ok(result.locked.length > 0, 'the locked list must never be empty');
  assert.ok(result.locked.every((l) => typeof l.id === 'string' && typeof l.text === 'string'));
  assert.deepEqual(result.groups.map((g) => g.id), ['core', 'when-needed', 'advanced']);
  assert.equal(result.hidden, 0, '--all hides nothing');
  assert.equal(result.lang, 'en');
  assert.equal(result.project, THIS_PROJECT_NAME);
  assert.ok(result.files && result.files.global && result.files.project);
  assert.ok(Array.isArray(result.notes));
  assert.equal(result.note, undefined, 'a real reading carries no failure note');
});

test('a cache hit inside the TTL is reused (no second spawn, same captured_at)', async () => {
  _resetForgeConfigCacheForTests();
  const first = await buildForgeConfig(PROJECT_ROOT);
  const second = await buildForgeConfig(PROJECT_ROOT, Date.now() + 5000);
  assert.equal(second.captured_at, first.captured_at);
  assert.equal(second.provenance, 'DERIVED');
  assert.ok(second.age_ms >= 5000);
});

test('past the TTL the stale value is served at once (STALE), a concurrent call reuses the refresh (CACHED)', async () => {
  _resetForgeConfigCacheForTests();
  const first = await buildForgeConfig(PROJECT_ROOT);
  const later = Date.now() + _FORGE_CONFIG_CACHE_TTL_MS_FOR_TESTS + 1;
  const stale = await buildForgeConfig(PROJECT_ROOT, later);
  assert.equal(stale.provenance, 'STALE');
  assert.equal(stale.captured_at, first.captured_at, 'the OLD value, never relabelled as fresh');
  const concurrent = await buildForgeConfig(PROJECT_ROOT, later);
  assert.equal(concurrent.provenance, 'CACHED');
  await _awaitForgeConfigRefreshForTests(PROJECT_ROOT);
  const fresh = await buildForgeConfig(PROJECT_ROOT);
  assert.equal(fresh.provenance, 'DERIVED');
  assert.ok(Date.parse(fresh.captured_at) >= Date.parse(first.captured_at));
  _expireForgeConfigCacheForTests(PROJECT_ROOT);
  assert.equal((await buildForgeConfig(PROJECT_ROOT)).provenance, 'STALE');
  await _awaitForgeConfigRefreshForTests(PROJECT_ROOT);
});

test('a project with no .claude/ folder at all reports a truthful UNAVAILABLE state, never fake settings', async () => {
  _resetForgeConfigCacheForTests();
  const root = makeTempProjectRoot();
  try {
    const result = await buildForgeConfig(root);
    assertUnavailableShape(result);
    assert.match(result.note, /no \.claude\/ folder/);
    assert.equal(result.provenance, 'DERIVED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wp20 L9: a project with .claude/ but no settings file and no forge-bin is a valid all-defaults answer (central script)', async () => {
  _resetForgeConfigCacheForTests();
  const root = makeTempProjectRoot();
  try {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const result = await withIsolatedHome(() => buildForgeConfig(root));
    assert.equal(result.available, true, result.note);
    assert.equal(result.state, 'OK');
    assert.ok(result.settings.length >= 30, 'the central schema lists 30+ settings, got ' + result.settings.length);
    assert.ok(result.settings.every((s) => s.source === 'default'), 'nothing is set anywhere -> every value is a default');
    assert.equal(result.project, path.basename(root), 'the SELECTED project is the one reported, not the gateway project');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SECURITY wp20 L9: a tampered forge-config.cjs inside the selected project is NEVER executed — only its settings are read', async () => {
  _resetForgeConfigCacheForTests();
  const root = makeTempProjectRoot();
  const sentinel = path.join(root, 'SENTINEL-project-code-ran.txt');
  try {
    writeProjectScript(root, [
      'require("fs").writeFileSync(' + JSON.stringify(sentinel) + ', "executed");',
      'process.stdout.write(JSON.stringify({ settings: [{ key: "tampered", value: 1 }], hidden: 0, locked: [], notes: [], lang: "en", groups: [], project: "evil" }));',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { nvidia: { value: false, set_at: '2026-09-24T00:00:00Z', set_by: 'test' } } }));
    // Control arm: the tampered script really WOULD leave the sentinel if anything ran it.
    const ctl = spawnSync(process.execPath, [path.join(root, '.claude', 'forge-bin', 'forge-config.cjs')], { encoding: 'utf8' });
    assert.equal(ctl.status, 0);
    assert.ok(fs.existsSync(sentinel), 'control: the fixture script writes the sentinel when executed');
    fs.rmSync(sentinel, { force: true });

    const result = await withIsolatedHome(() => buildForgeConfig(root));
    assert.equal(fs.existsSync(sentinel), false, 'the selected project\'s own forge-config.cjs must never run');
    assert.equal(result.available, true, result.note);
    assert.ok(!result.settings.some((s) => s.key === 'tampered'), 'the answer comes from the central script, not the tampered one');
    assert.equal(result.project, path.basename(root));
    const nvidia = result.settings.find((s) => s.key === 'nvidia');
    assert.ok(nvidia, 'nvidia is listed');
    assert.deepEqual([nvidia.value, nvidia.source], [false, 'project'], 'the selected project\'s SETTINGS file is still read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SECURITY: a failing script that prints a secret-looking string on stderr is redacted', async () => {
  _resetForgeConfigCacheForTests();
  const dir = makeTempProjectRoot();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  try {
    const fixture = path.join(dir, 'fake-forge-config.cjs');
    fs.writeFileSync(fixture, "console.error('boom, leaked: " + FAKE_KEY + "'); process.exit(1);\n", 'utf8');
    _setForgeConfigCjsForTests(fixture);
    const result = await buildForgeConfig(dir);
    assertUnavailableShape(result);
    assert.doesNotMatch(result.note, new RegExp(FAKE_KEY));
    assert.match(result.note, /\[REDACTED:NVIDIA_API_KEY\]/);
  } finally {
    _setForgeConfigCjsForTests(null);
    _resetForgeConfigCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI --json error body (exit 2) becomes the honest, redacted UNAVAILABLE reason', async () => {
  _resetForgeConfigCacheForTests();
  const dir = makeTempProjectRoot();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  try {
    const fixture = path.join(dir, 'fake-forge-config.cjs');
    const body = "{ ok: false, error: { code: 'malformed', message: 'The file is damaged near " + FAKE_KEY + "', suggestion: null } }";
    fs.writeFileSync(fixture, 'process.stdout.write(JSON.stringify(' + body + ')); process.exit(2);\n', 'utf8');
    _setForgeConfigCjsForTests(fixture);
    const result = await buildForgeConfig(dir);
    assertUnavailableShape(result);
    assert.match(result.note, /The file is damaged near \[REDACTED:NVIDIA_API_KEY\]/);
  } finally {
    _setForgeConfigCjsForTests(null);
    _resetForgeConfigCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('output that is not JSON is reported as UNAVAILABLE, never parsed into settings', async () => {
  _resetForgeConfigCacheForTests();
  const root = makeTempProjectRoot();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  try {
    const fixture = path.join(root, 'fake-forge-config.cjs');
    fs.writeFileSync(fixture, "process.stdout.write('Forge settings (text mode)\\n');\n", 'utf8');
    _setForgeConfigCjsForTests(fixture);
    const result = await buildForgeConfig(root);
    assertUnavailableShape(result);
    assert.match(result.note, /not JSON/);
  } finally {
    _setForgeConfigCjsForTests(null);
    _resetForgeConfigCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SECURITY: the spawn runs from the gateway project with a credential-free env allowlist, FORGE_PROJECT_ROOT = the selection, and success-path output is redacted', async () => {
  _resetForgeConfigCacheForTests();
  const root = makeTempProjectRoot();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const names = ['FORGE_PROJECT_ROOT', 'FORGE_CONFIG_HOME', 'WP12_UNLISTED_SECRET', 'CLAUDE_CODE_OAUTH_TOKEN', 'CC_WP20_SECRET', 'CLAUDE_WP20_PLAIN'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  process.env.FORGE_PROJECT_ROOT = path.join(os.tmpdir(), 'somewhere-else');
  process.env.FORGE_CONFIG_HOME = path.join(os.tmpdir(), 'somewhere-else-home');
  process.env.WP12_UNLISTED_SECRET = 'must-not-reach-the-child';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-wp20-must-not-reach-the-config-child';
  process.env.CC_WP20_SECRET = 'cc-prefixed-secret-must-not-reach-the-config-child';
  process.env.CLAUDE_WP20_PLAIN = 'a-plain-claude-setting';
  try {
    const fixture = path.join(root, 'probe-forge-config.cjs');
    fs.writeFileSync(fixture, [
      'const E = process.env;',
      'const probe = { key: "probe", desc: "leak ' + FAKE_KEY + '", cwd: process.cwd(), forge_root_env: E.FORGE_PROJECT_ROOT || null,',
      '  config_home_env: E.FORGE_CONFIG_HOME || null, unlisted_env: E.WP12_UNLISTED_SECRET || null, oauth: E.CLAUDE_CODE_OAUTH_TOKEN || null,',
      '  cc_secret: E.CC_WP20_SECRET || null, plain: E.CLAUDE_WP20_PLAIN || null };',
      'process.stdout.write(JSON.stringify({ settings: [probe], hidden: 0, locked: [{ id: "l", text: "t", source: null }],',
      '  files: { project: { pretty: ".claude/FORGE_CONFIG.json", present: false } }, notes: ["n"], lang: "en",',
      '  groups: [{ id: "core", title: "Core" }], project: "tmp" }));',
      '',
    ].join('\n'), 'utf8');
    _setForgeConfigCjsForTests(fixture);
    const result = await buildForgeConfig(root);
    assert.equal(result.available, true);
    assert.equal(result.state, 'OK');
    const [probe] = result.settings;
    assert.equal(fs.realpathSync.native(probe.cwd).toLowerCase(), fs.realpathSync.native(PROJECT_ROOT).toLowerCase(), 'cwd is the gateway\'s own project, never the selected one');
    assert.equal(probe.forge_root_env, root, 'FORGE_PROJECT_ROOT is the SELECTED project, never a stray gateway value');
    assert.equal(probe.config_home_env, null, 'FORGE_CONFIG_HOME must not be forwarded to the child');
    assert.equal(probe.unlisted_env, null, 'an unlisted env var must not be forwarded to the child');
    assert.equal(probe.oauth, null, 'CLAUDE_CODE_OAUTH_TOKEN must not reach the config child');
    assert.equal(probe.cc_secret, null, 'a credential-shaped CC_* name must not reach the config child');
    assert.equal(probe.plain, 'a-plain-claude-setting', 'a non-credential CLAUDE_* name still passes');
    assert.doesNotMatch(probe.desc, new RegExp(FAKE_KEY));
    assert.match(probe.desc, /\[REDACTED:NVIDIA_API_KEY\]/);
    assert.deepEqual(result.locked, [{ id: 'l', text: 't', source: null }]);
    assert.deepEqual(result.notes, ['n']);
    assert.equal(result.project, 'tmp');
  } finally {
    _setForgeConfigCjsForTests(null);
    _resetForgeConfigCacheForTests();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('wp20 env hygiene: filteredEnv() default still forwards CLAUDE_CODE_OAUTH_TOKEN (the real claude child may authenticate with it); { credentialFree: true } drops it and every *_TOKEN/*_SECRET/*_KEY', () => {
  const names = ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_WP20_API_KEY', 'CC_WP20_SECRET', 'CLAUDE_WP20_PLAIN'];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_WP20_API_KEY: 'k', CC_WP20_SECRET: 's', CLAUDE_WP20_PLAIN: 'p' });
  try {
    const dflt = filteredEnv();
    assert.equal(dflt.CLAUDE_CODE_OAUTH_TOKEN, 'tok', 'unchanged default for the real claude child');
    const free = filteredEnv({ credentialFree: true });
    assert.equal(free.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(free.CLAUDE_WP20_API_KEY, undefined);
    assert.equal(free.CC_WP20_SECRET, undefined);
    assert.equal(free.CLAUDE_WP20_PLAIN, 'p');
    assert.ok(Object.prototype.hasOwnProperty.call(free, 'PATH') || Object.prototype.hasOwnProperty.call(free, 'Path'), 'PATH still reaches the child');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

/* ── GET /api/config route ─────────────────────────────────────────────────────────────── */

let server;
let port;

before(async () => {
  _resetProjectsCacheForTests();
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /api/config returns the real settings for a registered project, without internal fields or secrets', async () => {
  _resetForgeConfigCacheForTests();
  const res = await request(port, '/api/config?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.available, true);
  assert.ok(res.json.settings.length >= 30);
  assert.ok(res.json.settings.some((s) => s.key === 'usage-guard.pause-at'));
  assert.ok(res.json.locked.length > 0);
  assert.ok(['DERIVED', 'STALE', 'CACHED'].includes(res.json.provenance));
  assert.equal(typeof res.json.captured_at, 'string');
  assert.equal(typeof res.json.age_ms, 'number');
  assert.equal('_capturedAtMs' in res.json, false, 'the internal cache timestamp is stripped');
  assert.doesNotMatch(res.body, /nvapi-[A-Za-z0-9_-]{10,}|\bsk-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{10,}|\bAKIA[A-Z0-9]{10,}|PRIVATE KEY-----/);
});

test('SECURITY: GET /api/config with an unknown project is a 404 and never spawns anything', async () => {
  const res = await request(port, '/api/config?project=totally-not-real');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json.ok, false);
});

test('SECURITY: /api/config still refuses a method nobody asked for (DELETE -> 405)', async () => {
  const res = await request(port, '/api/config?project=' + encodeURIComponent(THIS_PROJECT_NAME), { method: 'DELETE' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.json.ok, false);
});

/* ── POST /api/config (WP-A, v2.9.0): the dashboard's real config-write route ─────────────── */
//
// Every scenario below runs against an ISOLATED temp project (never THIS_PROJECT_NAME / the real
// repo) discovered through the REAL, already-reviewed forge-sync.cjs — same "find it by walking up
// from PROJECT_ROOT" approach as routes-ambiguous-project.test.mjs, needed because a worktree
// nested under _scratch/wt-*-cc resolves PROJECT_ROOT one level too shallow for its OWN .claude/ to
// exist (documented caveat, see this project's build-boss memory). The forge-config.cjs each
// scenario runs against is a small branching FIXTURE (never the real central script) so every
// exit-code/refusal path is deterministic and portable, independent of that same caveat.

function findRealForgeSyncCjsForConfigWrite() {
  let dir = PROJECT_ROOT;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.claude', 'forge-bin', 'forge-sync.cjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const REAL_FORGE_SYNC_CJS_FOR_WRITE = findRealForgeSyncCjsForConfigWrite();
const WRITE_SKIP_REASON = REAL_FORGE_SYNC_CJS_FOR_WRITE
  ? false
  : 'no real .claude/forge-bin/forge-sync.cjs found by walking up from PROJECT_ROOT — this suite needs the real, already-reviewed tool to spawn against isolated fixtures.';

// Writes a tiny CommonJS script that mimics forge-config.cjs's own --json CLI contract: reads
// argv[2] ('list'/'set'/'unset'), prints the canned JSON for that verb, and exits with the canned
// code. `sentinelPath`, when given, records every invocation (proving whether the child was ever
// spawned at all) — used by the gate-hook-refusal tests below.
function writeConfigFixture(fixturePath, responses, sentinelPath) {
  const lines = [
    'const fs = require("fs");',
    sentinelPath ? 'fs.appendFileSync(' + JSON.stringify(sentinelPath) + ', process.argv.slice(2).join(" ") + "\\n");' : '',
    'const responses = ' + JSON.stringify(responses) + ';',
    'const verb = process.argv[2];',
    'const r = responses[verb];',
    'if (!r) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "usage", message: "no fixture response for " + verb } })); process.exit(2); }',
    'process.stdout.write(JSON.stringify(r.json));',
    'process.exit(r.exitCode);',
    '',
  ];
  fs.writeFileSync(fixturePath, lines.join('\n'), 'utf8');
}

const DEFAULT_LIST_JSON = { settings: [{ key: 'nvidia', value: true }], hidden: 0, locked: [{ id: 'l', text: 't', source: null }], notes: [], lang: 'en', groups: [{ id: 'core', title: 'Core' }], project: 'my-config-project' };

// server.mjs's resolveProjectByName() re-checks containment against the REAL SYNC_SCAN_ROOTS
// (paths.mjs) as defense in depth — see anyContainmentOk() at server.mjs's own resolveProjectByName
// — which a scan-root OVERRIDE (projects.mjs's _setScanRootsForTests, used only to target the
// SCAN itself at an isolated temp root) does not satisfy on its own. SYNC_SCAN_ROOTS is a real,
// mutable exported Array (not a frozen constant), so temporarily pushing the temp root onto it —
// and always popping exactly that entry back off in `finally` — lets a genuinely single-match
// resolution reach 200 in a test, with no production file touched to make this possible.
function pushScanRoot(root) {
  SYNC_SCAN_ROOTS.push(root);
}
function popScanRoot(root) {
  const idx = SYNC_SCAN_ROOTS.lastIndexOf(root);
  if (idx !== -1) SYNC_SCAN_ROOTS.splice(idx, 1);
}

// Sets up one isolated temp "Forge project" (discoverable by the real forge-sync.cjs) plus a
// branching forge-config.cjs fixture, runs `fn({ projectName, sentinelPath, auditFile, root })`,
// then always tears every override back down — even on assertion failure — so no test can leak
// state into the next one (mirrors this file's own try/finally convention elsewhere).
async function withConfigWriteFixture(responses, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-write-test-'));
  const projectName = 'my-config-project';
  fs.mkdirSync(path.join(root, projectName, '.claude', 'forge-dashboard'), { recursive: true });
  const fixturePath = path.join(root, 'fixture-forge-config.cjs');
  const sentinelPath = path.join(root, 'SENTINEL-spawned.txt');
  const auditFile = path.join(root, 'audit.jsonl');
  writeConfigFixture(fixturePath, Object.assign({ list: { exitCode: 0, json: DEFAULT_LIST_JSON } }, responses), sentinelPath);
  pushScanRoot(root);
  _setForgeSyncCjsForTests(REAL_FORGE_SYNC_CJS_FOR_WRITE);
  _setScanRootsForTests([root]);
  _resetProjectsCacheForTests();
  _setForgeConfigCjsForTests(fixturePath);
  _resetForgeConfigCacheForTests();
  _setConfigAuditLogFileForTests(auditFile);
  try {
    await fn({ projectName, sentinelPath, auditFile, root });
  } finally {
    popScanRoot(root);
    _resetForgeSyncCjsForTests();
    _resetScanRootsForTests();
    _resetProjectsCacheForTests();
    _setForgeConfigCjsForTests(null);
    _resetForgeConfigCacheForTests();
    _resetConfigAuditLogFileForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function configWriteUrl(projectName) {
  return '/api/config?project=' + encodeURIComponent(projectName);
}

test('POST /api/config without the exec token is rejected with 403, even with an otherwise-valid body — checked before any body/project lookup', async () => {
  const res = await requestWithBody(port, configWriteUrl('totally-not-a-real-project'), {
    jsonBody: { action: 'set', key: 'nvidia', value: 'on' },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /execution token/);
});

test('POST /api/config with an unknown field in the body is rejected with 400 (schema allowlist)', async () => {
  const res = await requestWithBody(port, configWriteUrl('totally-not-a-real-project'), {
    jsonBody: { action: 'set', key: 'nvidia', value: 'on', extra: 'nope' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /unknown field/);
});

test('POST /api/config with an unknown project is a 404 and never spawns the fixture', async () => {
  await withConfigWriteFixture({}, async ({ sentinelPath }) => {
    const res = await requestWithBody(port, configWriteUrl('definitely-not-registered'), {
      jsonBody: { action: 'set', key: 'nvidia', value: 'on' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(fs.existsSync(sentinelPath), false);
  });
});

test('POST /api/config with an unknown key maps the CLI\'s exit 2 to 400', async () => {
  await withConfigWriteFixture({
    set: { exitCode: 2, json: { ok: false, error: { code: 'unknown_key', message: 'Unknown setting "not-a-real-key".' } } },
  }, async ({ projectName }) => {
    const res = await requestWithBody(port, configWriteUrl(projectName), {
      jsonBody: { action: 'set', key: 'not-a-real-key', value: 'on' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /Unknown setting/);
  });
});

test('POST /api/config with a bad value maps the CLI\'s exit 2 to 400', async () => {
  await withConfigWriteFixture({
    set: { exitCode: 2, json: { ok: false, error: { code: 'invalid_value', message: 'usage-guard.pause-at must be a whole number between 50 and 99 — you gave "banana".' } } },
  }, async ({ projectName }) => {
    const res = await requestWithBody(port, configWriteUrl(projectName), {
      jsonBody: { action: 'set', key: 'usage-guard.pause-at', value: 'banana' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json.error, /must be a whole number/);
  });
});

test('POST /api/config maps a locked-id exit 3 to 409, and lock_busy to 503', async () => {
  await withConfigWriteFixture({
    set: { exitCode: 3, json: { ok: false, error: { code: 'locked', message: '"hard-gates" is locked and cannot be changed.' } } },
  }, async ({ projectName }) => {
    const locked = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'set', key: 'hard-gates', value: 'off' } });
    assert.equal(locked.statusCode, 409);
  });
  await withConfigWriteFixture({
    set: { exitCode: 2, json: { ok: false, error: { code: 'lock_busy', message: 'forge-config: another process is writing — try again' } } },
  }, async ({ projectName }) => {
    const busy = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'set', key: 'nvidia', value: 'on' } });
    assert.equal(busy.statusCode, 503);
  });
});

test('SECURITY: POST /api/config refuses every gate-hook-off spelling with 403, and the child is NEVER spawned', async () => {
  // Deliberately wider than the schema's own false-synonym list (off/uit/false/no/nee/0) — this
  // route uses an ALLOWLIST of recognised ON words, so "disabled"/"disable" (real synonyms
  // forge-config.cjs itself accepts) and a plain garbage value must be refused too.
  const offSpellings = ['off', 'OFF', ' off ', 'uit', 'false', 'no', 'nee', '0', 'disabled', 'disable', 'nonsense'];
  await withConfigWriteFixture({}, async ({ projectName, sentinelPath }) => {
    for (const value of offSpellings) {
      const res = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'set', key: 'gate-hook', value } });
      assert.equal(res.statusCode, 403, 'value=' + JSON.stringify(value));
      assert.match(res.json.error, /forge-config\.cjs set gate-hook off/, 'value=' + JSON.stringify(value));
    }
    assert.equal(fs.existsSync(sentinelPath), false, 'the fixture forge-config.cjs must never have been spawned');
  });
});

test('POST /api/config allows "set gate-hook on" straight through to a real spawn', async () => {
  await withConfigWriteFixture({
    set: { exitCode: 0, json: { key: 'gate-hook', from: false, to: true, file: 'x', scope: 'project', unchanged: false, entry: { key: 'gate-hook', value: true, source: 'project' } } },
  }, async ({ projectName, sentinelPath }) => {
    const onRes = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'set', key: 'gate-hook', value: 'on' } });
    assert.equal(onRes.statusCode, 200, JSON.stringify(onRes.json));
    assert.equal(onRes.json.change.to, true);
    assert.ok(fs.existsSync(sentinelPath), 'the fixture must have been spawned for the real set request');
    const spawned = fs.readFileSync(sentinelPath, 'utf8');
    assert.match(spawned, /set gate-hook on/);
  });
});

test('SECURITY K3-1: POST /api/config refuses "unset gate-hook" unconditionally, and the child is NEVER spawned', async () => {
  // Codex finding K3-1: a project-level "on" can be masking a machine-wide (global) "off" — unset
  // only ever removes the PROJECT layer, so it could reveal that hidden "off". There is no value to
  // inspect on an unset request (unlike "set"), so this is refused every time, unconditionally —
  // never spawned, regardless of what the (fixture's) unset branch would have answered.
  await withConfigWriteFixture({
    unset: { exitCode: 0, json: { key: 'gate-hook', removed: true, entry: { key: 'gate-hook', value: true, source: 'default' }, files_pretty: ['.claude/FORGE_CONFIG.json'], lang: 'en' } },
  }, async ({ projectName, sentinelPath }) => {
    const res = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'unset', key: 'gate-hook' } });
    assert.equal(res.statusCode, 403, JSON.stringify(res.json));
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /cannot be reset from the dashboard/);
    assert.equal(fs.existsSync(sentinelPath), false, 'unset gate-hook must never reach a spawn');
  });
});

test('SECURITY K3-2: POST /api/config refuses when .claude is a junction pointing OUTSIDE the project, and never spawns', async () => {
  // Codex finding K3-2: a plain fs.statSync() only asks "is a directory here" — it happily follows a
  // Windows junction to another project's .claude entirely. realpathSync.native must resolve both
  // sides and refuse when the real .claude target is not actually inside the real project root.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-write-junction-'));
  const projectName = 'junction-project';
  const projectDir = path.join(root, projectName);
  fs.mkdirSync(projectDir, { recursive: true });
  // The REAL .claude this junction secretly points at lives in a SEPARATE tree, entirely outside
  // projectDir — forge-sync's own discovery marker (forge-dashboard/) still resolves through the
  // junction transparently, so this project is discoverable exactly like any other.
  const otherProjectClaudeDir = path.join(root, 'OTHER-PROJECT-claude-real');
  fs.mkdirSync(path.join(otherProjectClaudeDir, 'forge-dashboard'), { recursive: true });
  const junctionPath = path.join(projectDir, '.claude');
  try {
    fs.symlinkSync(otherProjectClaudeDir, junctionPath, 'junction');
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('this test needs real junction support on this machine (fs.symlinkSync(..., "junction")): ' + (err && err.message));
  }
  const fixturePath = path.join(root, 'fixture-forge-config.cjs');
  const sentinelPath = path.join(root, 'SENTINEL-spawned.txt');
  writeConfigFixture(fixturePath, { list: { exitCode: 0, json: DEFAULT_LIST_JSON } }, sentinelPath);
  pushScanRoot(root);
  _setForgeSyncCjsForTests(REAL_FORGE_SYNC_CJS_FOR_WRITE);
  _setScanRootsForTests([root]);
  _resetProjectsCacheForTests();
  _setForgeConfigCjsForTests(fixturePath);
  try {
    const res = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'set', key: 'nvidia', value: 'on' } });
    assert.equal(res.statusCode, 400, JSON.stringify(res.json));
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /outside the project itself/);
    assert.equal(fs.existsSync(sentinelPath), false, 'a junctioned .claude must never reach a real spawn');
    // The other project's real .claude tree must be completely untouched.
    assert.deepEqual(fs.readdirSync(otherProjectClaudeDir), ['forge-dashboard']);
  } finally {
    popScanRoot(root);
    _resetForgeSyncCjsForTests();
    _resetScanRootsForTests();
    _resetProjectsCacheForTests();
    _setForgeConfigCjsForTests(null);
    _resetForgeConfigCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SECURITY: POST /api/config with an ambiguous project name answers 409, never picks either one, never spawns anything', async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-write-ambiguous-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-write-ambiguous-'));
  fs.mkdirSync(path.join(rootA, 'shared-name', '.claude', 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(rootB, 'shared-name', '.claude', 'forge-dashboard'), { recursive: true });
  const fixturePath = path.join(rootA, 'fixture-forge-config.cjs');
  const sentinelPath = path.join(rootA, 'SENTINEL-spawned.txt');
  writeConfigFixture(fixturePath, {}, sentinelPath);
  pushScanRoot(rootA);
  pushScanRoot(rootB);
  _setForgeSyncCjsForTests(REAL_FORGE_SYNC_CJS_FOR_WRITE);
  _setScanRootsForTests([rootA, rootB]);
  _resetProjectsCacheForTests();
  _setForgeConfigCjsForTests(fixturePath);
  try {
    const res = await requestWithBody(port, configWriteUrl('shared-name'), { jsonBody: { action: 'set', key: 'nvidia', value: 'on' } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json.ok, false);
    assert.equal(fs.existsSync(sentinelPath), false);
  } finally {
    popScanRoot(rootA);
    popScanRoot(rootB);
    _resetForgeSyncCjsForTests();
    _resetScanRootsForTests();
    _resetProjectsCacheForTests();
    _setForgeConfigCjsForTests(null);
    _resetForgeConfigCacheForTests();
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test('POST /api/config on success returns the change, the FRESH settings list, and writes exactly one audit line', async () => {
  await withConfigWriteFixture({
    set: { exitCode: 0, json: { key: 'nvidia', from: true, to: false, file: 'x', scope: 'project', unchanged: false, entry: { key: 'nvidia', value: false, source: 'project' } } },
  }, async ({ projectName, auditFile }) => {
    const res = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'set', key: 'nvidia', value: 'off' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json));
    assert.equal(res.json.ok, true);
    assert.equal(res.json.action, 'set');
    assert.equal(res.json.key, 'nvidia');
    assert.equal(res.json.change.to, false);
    assert.equal(res.json.audit_logged, true);
    assert.equal(res.json.config.ok, true);
    assert.equal(res.json.config.available, true);
    assert.deepEqual(res.json.config.settings, DEFAULT_LIST_JSON.settings, 'the refreshed list comes from a REAL re-spawn, not the stale pre-write cache');
    assert.equal('_capturedAtMs' in res.json.config, false);

    const auditLines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(auditLines.length, 1);
    assert.equal(auditLines[0].event_type, 'config_changed');
    assert.equal(auditLines[0].project, projectName);
    assert.equal(auditLines[0].action, 'set');
    assert.equal(auditLines[0].key, 'nvidia');
    assert.equal(auditLines[0].value, false);
    assert.equal(typeof auditLines[0].timestamp, 'string');
  });
});

test('SECURITY/WP-A: the write spawn carries FORGE_CONFIG_SET_BY=dashboard, FORGE_PROJECT_ROOT=selection, and NEVER an extra CLI flag', async () => {
  // A dedicated probe fixture (mirrors config.mjs's own "SECURITY: the spawn runs..." test) that
  // echoes back argv + the two env vars this route's contract depends on, rather than the generic
  // writeConfigFixture() branching used by every other test in this file.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-write-envprobe-'));
  const projectName = 'my-config-project';
  fs.mkdirSync(path.join(root, projectName, '.claude', 'forge-dashboard'), { recursive: true });
  const fixturePath = path.join(root, 'probe-forge-config.cjs');
  fs.writeFileSync(fixturePath, [
    'const probe = { argv: process.argv.slice(2), setBy: process.env.FORGE_CONFIG_SET_BY || null, root: process.env.FORGE_PROJECT_ROOT || null };',
    'process.stdout.write(JSON.stringify({ key: "usage-guard", from: true, to: false, file: "x", scope: "project", unchanged: false, entry: { key: "usage-guard", value: false, source: "project" }, probe }));',
    'process.exit(0);',
    '',
  ].join('\n'), 'utf8');
  pushScanRoot(root);
  _setForgeSyncCjsForTests(REAL_FORGE_SYNC_CJS_FOR_WRITE);
  _setScanRootsForTests([root]);
  _resetProjectsCacheForTests();
  _setForgeConfigCjsForTests(fixturePath);
  try {
    const res = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'set', key: 'usage-guard', value: 'off' } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json));
    const probe = res.json.change.probe;
    assert.equal(probe.setBy, 'dashboard', 'the child must see FORGE_CONFIG_SET_BY=dashboard');
    assert.equal(probe.root, path.join(root, projectName), 'FORGE_PROJECT_ROOT must be the SELECTED project, never a stray value');
    assert.deepEqual(probe.argv, ['set', 'usage-guard', 'off', '--json', '--lang', 'en'], 'argv must be exactly this shape — never --once/--global/--flag/reset from the web');
  } finally {
    popScanRoot(root);
    _resetForgeSyncCjsForTests();
    _resetScanRootsForTests();
    _resetProjectsCacheForTests();
    _setForgeConfigCjsForTests(null);
    _resetForgeConfigCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POST /api/config value validation: missing value on "set", and a non-string/number/boolean value, are both 400', async () => {
  await withConfigWriteFixture({}, async ({ projectName, sentinelPath }) => {
    const missing = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'set', key: 'nvidia' } });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json.error, /value is required/);
    const objectValue = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'set', key: 'nvidia', value: { nested: true } } });
    assert.equal(objectValue.statusCode, 400);
    assert.match(objectValue.json.error, /must be a string, number or boolean/);
    const badAction = await requestWithBody(port, configWriteUrl(projectName), { jsonBody: { action: 'reset', key: 'nvidia' } });
    assert.equal(badAction.statusCode, 400);
    assert.match(badAction.json.error, /action must be/);
    assert.equal(fs.existsSync(sentinelPath), false, 'nothing here should ever reach a spawn');
  });
});
