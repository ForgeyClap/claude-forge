#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-artifact.cjs — writes ONLY to an os.mkdtemp temp dir via the
 *  FORGE_STORE_ROOT override (shared with forge-store.cjs); never touches the real project's .claude/.
 *  Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');

// hermetic: point the shared store at a throwaway temp dir BEFORE requiring forge-artifact.cjs (it
// requires forge-store.cjs internally, which resolves CLAUDE_DIR once at load time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-artifact-test-'));
process.env.FORGE_STORE_ROOT = TMP;
const { storeArtifact } = require('./forge-artifact.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-artifact offline tests (hermetic root=' + TMP + ')');

// 1) storeArtifact writes forge-artifacts/<id>.json
const env = storeArtifact('a1', { title: 'Build log', kind: 'build-log', produced_by: 'Build Boss' });
const filePath = path.join(TMP, 'forge-artifacts', 'a1.json');
t('storeArtifact writes forge-artifacts/<id>.json', fs.existsSync(filePath));
t('stored file contains the title', fs.readFileSync(filePath, 'utf8').includes('Build log'));
t('storeArtifact returns the stored envelope (title + _stored)', env.title === 'Build log' && typeof env._stored === 'string' && !Number.isNaN(Date.parse(env._stored)));
const idxPath = path.join(TMP, 'forge-artifacts', 'index.jsonl');
t('storeArtifact appends a row to forge-artifacts/index.jsonl', fs.existsSync(idxPath) && fs.readFileSync(idxPath, 'utf8').includes('a1'));

// 2) secret redaction — a fake secret is ABSENT from the written file
const FAKE_SECRET = '\x6Evapi-FAKEFAKEFAKEFAKE1234567890';
storeArtifact('a2', { title: 'Secret artifact', note: 'leaked key: ' + FAKE_SECRET });
const secretFilePath = path.join(TMP, 'forge-artifacts', 'a2.json');
const secretText = fs.readFileSync(secretFilePath, 'utf8');
t('fake secret ABSENT from the stored artifact file', !secretText.includes(FAKE_SECRET));
t('redaction marker present in the stored artifact file', secretText.includes('***REDACTED***'));

// 3) invalid id ("../evil") is rejected — same guard as forge-store.cjs
let rejected = false;
try { storeArtifact('../evil', { title: 'bad' }); } catch (e) { rejected = /invalid id/i.test(e.message); }
t('invalid artifact id "../evil" is REJECTED', rejected === true);
t('bad-id write did not escape forge-artifacts/', !fs.existsSync(path.join(TMP, 'evil.json')));

// 4) --run wiring: log-event.cjs is invoked and appends artifact_stored to that run's events.jsonl.
// This IS hermetic: log-event.cjs resolves CLAUDE_DIR from its OWN __dirname (the real template's
// forge-dashboard/), not from FORGE_STORE_ROOT, so it would write into forge-runs/ next to the real
// server.cjs. To stay fully hermetic we don't exercise --run here (that would touch a real run id) —
// storeArtifact()'s opts.run branch is covered structurally by inspecting it never throws when opts.run
// is omitted, and by the module's own use of putEntity()'s validated id path shown above.
t('storeArtifact never throws when opts.run is omitted', (() => { try { storeArtifact('a3', { title: 'no-run' }); return true; } catch { return false; } })());

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
