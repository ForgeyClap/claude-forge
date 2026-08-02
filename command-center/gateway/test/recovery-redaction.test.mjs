/**
 * `/api/recovery` and `/api/checkpoints` must redact before answering.
 *
 * Why this file exists: `recovery.mjs` was the one reader in the gateway that never imported the
 * redaction control, while every sibling (events, conversations, exec-bridge, models, capabilities)
 * did. It hands back three WHOLE parsed files with no field projection — the recovery-attempt
 * ledger, the resume state, and each run's manifest. That was survivable while nothing called the
 * route; this run mounted it into the Activity view, so the payload now reaches the browser.
 *
 * The ledger's own fields (`queries`, `resultSource`, `securityDecision`) are operator-authored
 * free text. `GLOBAL_RESEARCH_RECOVERY_POLICY` promises "secrets are redacted from recovery logs",
 * but that is a promise made by whoever WRITES the log — not a control on the way out. A control
 * you cannot test is a hope.
 *
 * The fake credentials below are shaped to match the real patterns in `redact.mjs` and are
 * obviously synthetic. The point is not that these exact strings ever appear; it is that if
 * someone later removes a `redactDeep()` call, this fails loudly instead of the gap re-opening in
 * silence — which is exactly how it got here the first time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRecovery, buildCheckpoints } from '../src/recovery.mjs';
import { SYNC_SCAN_ROOT } from '../src/paths.mjs';

// Fake, obviously-synthetic values matching redact.mjs's real shapes.
const FAKE_SK = 'sk-abcdefghijklmnopqrstuvwxyz012345';
const FAKE_NVAPI = 'nvapi-abcdefghijklmnopqrstuvwxyz';

// The project must live inside SYNC_SCAN_ROOT or containmentOk rejects it before any read.
function makeProject(files) {
  const root = fs.mkdtempSync(path.join(SYNC_SCAN_ROOT, 'cc-recovery-redaction-test-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, 'utf8');
  }
  return root;
}

test('a credential in a recovery-attempt line never leaves the gateway', () => {
  const line = JSON.stringify({
    method: 'github-search',
    securityDecision: `safe — probed with token ${FAKE_SK}`,
    queries: [`curl -H "x-api-key: ${FAKE_NVAPI}" https://example.invalid`],
  });
  const root = makeProject({ '.claude/forge-research/recovery-attempts.jsonl': `${line}\n` });

  const result = buildRecovery(root);
  fs.rmSync(root, { recursive: true, force: true });

  const serialized = JSON.stringify(result);
  assert.equal(result.ok, true);
  assert.equal(result.recovery_attempts.length, 1, 'the row itself must survive — this redacts, it does not drop data');
  assert.ok(!serialized.includes(FAKE_SK), 'sk- style credential leaked through /api/recovery');
  assert.ok(!serialized.includes(FAKE_NVAPI), 'NVIDIA key leaked through /api/recovery');
  // The surrounding, non-secret text must still be readable — a redactor that blanks the whole
  // field would "pass" this test's leak check while destroying the operator's own ledger.
  assert.ok(serialized.includes('github-search'), 'redaction must not swallow the real content around the secret');
});

test('a credential in a docdrift source URL or missing-token never leaves the gateway', () => {
  // push-to-break FINDING 1 (2026-07-29): docdrift.sources + docdrift.findings were the two
  // docdrift fields that reached the browser UNredacted while every sibling was scrubbed. A secret
  // can ride a source URL's query string, or be the very token a drift rule reports as missing.
  const ledgerLine = JSON.stringify({
    rule_id: 'r-1',
    checked_at: '2026-07-29T00:00:00.000Z',
    source_url: `https://example.invalid/api?key=${FAKE_SK}`,
  });
  const state = { 'r-1': { drifted: true, last_status: 'DRIFTED', missing_tokens: [FAKE_NVAPI] } };
  const root = makeProject({
    '.claude/forge-research/docdrift-ledger.jsonl': `${ledgerLine}\n`,
    '.claude/forge-research/docdrift-state.json': JSON.stringify(state),
  });

  const result = buildRecovery(root);
  fs.rmSync(root, { recursive: true, force: true });

  const serialized = JSON.stringify(result);
  assert.equal(result.docdrift.findings_count, 1, 'the finding row must survive — redact, do not drop');
  assert.ok(!serialized.includes(FAKE_SK), 'sk- credential leaked through /api/recovery docdrift.sources');
  assert.ok(!serialized.includes(FAKE_NVAPI), 'NVIDIA key leaked through /api/recovery docdrift.findings.missing_tokens');
  assert.ok(serialized.includes('example.invalid'), 'redaction must not swallow the non-secret part of the URL');
});

test('a credential in FORGE_RESUME_STATE.json never leaves the gateway', () => {
  const root = makeProject({
    '.claude/FORGE_RESUME_STATE.json': JSON.stringify({ run: 'r-1', note: `resumed with ${FAKE_SK}` }),
  });

  const result = buildCheckpoints(root);
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(result.resume_state.available, true);
  assert.ok(!JSON.stringify(result).includes(FAKE_SK), 'credential leaked through /api/checkpoints resume_state');
});

test('a credential in a run manifest never leaves the gateway', () => {
  const root = makeProject({
    '.claude/forge-runs/run-1/manifest.json': JSON.stringify({ run_id: 'run-1', env: FAKE_NVAPI }),
  });

  const result = buildCheckpoints(root);
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(result.runs_with_manifest.length, 1, 'the manifest row must survive');
  assert.ok(!JSON.stringify(result).includes(FAKE_NVAPI), 'credential leaked through /api/checkpoints manifest');
});

test('clean data passes through completely unchanged — redaction must not be lossy', () => {
  const attempt = { method: 'public-docs', securityDecision: 'safe — public repos only', queries: ['forge dashboard'] };
  const root = makeProject({
    '.claude/forge-research/recovery-attempts.jsonl': `${JSON.stringify(attempt)}\n`,
  });

  const result = buildRecovery(root);
  fs.rmSync(root, { recursive: true, force: true });

  assert.deepEqual(result.recovery_attempts[0], attempt);
});
