// T6.6 tests — buildCapabilities() against THIS project's real forge-capabilities.cjs (run as the
// CENTRAL copy — see SEC-PROJECT-CODE below), plus its stale-while-revalidate cache and the truthful
// UNAVAILABLE path for a project with no .claude/ folder at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildCapabilities,
  _setForgeCapabilitiesCjsForTests,
  _resetCapabilitiesCacheForTests,
  _expireCapabilitiesCacheForTests,
  _awaitCapabilitiesRefreshForTests,
} from '../src/capabilities.mjs';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';
import { makeTempProjectRoot } from '../test-support/helpers.mjs';

function writeProjectCapabilitiesScript(projectRoot, source) {
  const binDir = path.join(projectRoot, '.claude', 'forge-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'forge-capabilities.cjs'), source, 'utf8');
}

test('buildCapabilities runs the real report against this project and returns real capabilities + summary', async () => {
  _resetCapabilitiesCacheForTests();
  const result = await buildCapabilities(PROJECT_ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.state, 'OK');
  assert.ok(result.capabilities.length >= 100, 'this project has 100+ real tool/skill/gate capabilities');
  assert.ok(result.summary && typeof result.summary.total === 'number');
  assert.equal(result.provenance, 'DERIVED');
  assert.equal(result.age_ms, 0);
});

test('a 10-minute cache hit is reused within the TTL (no second spawn)', async () => {
  _resetCapabilitiesCacheForTests();
  const first = await buildCapabilities(PROJECT_ROOT);
  const second = await buildCapabilities(PROJECT_ROOT, Date.now() + 5000);
  assert.equal(second.captured_at, first.captured_at);
  assert.equal(second.provenance, 'DERIVED');
  assert.ok(second.age_ms >= 5000);
});

test('an expired cache serves the stale value immediately (STALE) then refreshes in the background', async () => {
  _resetCapabilitiesCacheForTests();
  const first = await buildCapabilities(PROJECT_ROOT);
  _expireCapabilitiesCacheForTests(PROJECT_ROOT);
  const stale = await buildCapabilities(PROJECT_ROOT);
  assert.equal(stale.provenance, 'STALE');
  assert.equal(stale.captured_at, first.captured_at); // still the OLD value, never fabricated as fresh
  await _awaitCapabilitiesRefreshForTests(PROJECT_ROOT);
  const fresh = await buildCapabilities(PROJECT_ROOT);
  assert.equal(fresh.provenance, 'DERIVED');
});

test('a concurrent call during an in-flight background refresh reuses it (CACHED)', async () => {
  _resetCapabilitiesCacheForTests();
  await buildCapabilities(PROJECT_ROOT);
  _expireCapabilitiesCacheForTests(PROJECT_ROOT);
  const a = await buildCapabilities(PROJECT_ROOT);
  assert.equal(a.provenance, 'STALE');
  const b = await buildCapabilities(PROJECT_ROOT);
  assert.equal(b.provenance, 'CACHED');
  await _awaitCapabilitiesRefreshForTests(PROJECT_ROOT);
});

test('a project with no forge-capabilities.cjs reports a truthful UNAVAILABLE state, never fake data', async () => {
  _resetCapabilitiesCacheForTests();
  const fakeProjectPath = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-caps', 'no-forge-bin-here');
  const result = await buildCapabilities(fakeProjectPath);
  assert.equal(result.ok, true);
  assert.equal(result.available, false);
  assert.equal(result.state, 'UNAVAILABLE');
  assert.ok(typeof result.note === 'string' && result.note.length > 0);
  assert.deepEqual(result.capabilities, []);
  assert.equal(result.summary, null);
});

test('a project with a .claude/ folder but no forge-bin at all is a valid, mostly-empty answer (central script)', async () => {
  _resetCapabilitiesCacheForTests();
  const root = makeTempProjectRoot();
  try {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const result = await buildCapabilities(root);
    assert.equal(result.available, true, result.note);
    assert.equal(result.state, 'OK');
    assert.ok(result.summary && typeof result.summary.total === 'number');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SECURITY SEC-PROJECT-CODE: a tampered forge-capabilities.cjs inside the selected project is NEVER executed — only its data is read', async () => {
  _resetCapabilitiesCacheForTests();
  const root = makeTempProjectRoot();
  const sentinel = path.join(root, 'SENTINEL-project-code-ran.txt');
  try {
    writeProjectCapabilitiesScript(root, [
      'require("fs").writeFileSync(' + JSON.stringify(sentinel) + ', "executed");',
      'process.stdout.write(JSON.stringify({ capabilities: [{ capability: "evil", present: true }], summary: { total: 999 } }));',
      '',
    ].join('\n'));
    // Control arm: the tampered script really WOULD leave the sentinel if anything ran it.
    const ctl = spawnSync(process.execPath, [path.join(root, '.claude', 'forge-bin', 'forge-capabilities.cjs')], { encoding: 'utf8' });
    assert.equal(ctl.status, 0);
    assert.ok(fs.existsSync(sentinel), 'control: the fixture script writes the sentinel when executed');
    fs.rmSync(sentinel, { force: true });

    const result = await buildCapabilities(root);
    assert.equal(fs.existsSync(sentinel), false, "the selected project's own forge-capabilities.cjs must never run");
    assert.equal(result.available, true, result.note);
    assert.ok(!result.capabilities.some((c) => c.capability === 'evil'), 'the answer comes from the central script, not the tampered one');
    assert.ok(!result.summary || result.summary.total !== 999, 'the tampered summary must not surface');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SECURITY: a failing central script that prints a secret-looking string on stderr is redacted', async () => {
  _resetCapabilitiesCacheForTests();
  const dir = makeTempProjectRoot();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const FAKE_KEY = 'nvapi-abcdefghij1234567890';
  try {
    const fixture = path.join(dir, 'fake-forge-capabilities.cjs');
    fs.writeFileSync(fixture, "console.error('boom, leaked: " + FAKE_KEY + "'); process.exit(1);\n", 'utf8');
    _setForgeCapabilitiesCjsForTests(fixture);
    const result = await buildCapabilities(dir);
    assert.equal(result.available, false);
    assert.equal(result.state, 'UNAVAILABLE');
    assert.doesNotMatch(result.note, new RegExp(FAKE_KEY));
    assert.match(result.note, /\[REDACTED:NVIDIA_API_KEY\]/);
  } finally {
    _setForgeCapabilitiesCjsForTests(null);
    _resetCapabilitiesCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
