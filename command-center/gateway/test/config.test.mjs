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
import { PROJECT_ROOT } from '../src/paths.mjs';
import { createServer } from '../src/server.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { makeTempProjectRoot, request } from '../test-support/helpers.mjs';

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

test('SECURITY: /api/config is read-only — a POST is refused with 405', async () => {
  const res = await request(port, '/api/config?project=' + encodeURIComponent(THIS_PROJECT_NAME), { method: 'POST' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.json.ok, false);
});
