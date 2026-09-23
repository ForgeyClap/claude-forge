// Codex r4 #13-rest (2026-08-07): de shutdown-coördinatie — een drain sluit niet alleen HTTP maar
// (1) blokkeert NIEUWE executies met een eerlijke reden, (2) markeert lopende executies duurzaam als
// 'interrupted' in hun conversation-ledger en (3) tree-killt de exacte kind-PID. Getest met een ECHT
// langlopend mock-kind (CC_EXEC_MOCK_DELAY_MS) — geen gesimuleerde processen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversation,
  readConversation,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import {
  startExecution,
  runningExecutionCount,
  enterDrainMode,
  isDraining,
  interruptAllExecutions,
  _resetExecBridgeForTests,
} from '../src/exec-bridge.mjs';

let tempDir;
const execCwd = os.tmpdir();

before(() => {
  process.env.CC_EXEC_MOCK = '1';
  process.env.CC_EXEC_MOCK_DELAY_MS = '30000'; // het kind blijft ECHT hangen tot de kill
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-exec-drain-test-'));
  _setConversationsDirForTests(tempDir);
  _resetExecBridgeForTests();
});

after(() => {
  delete process.env.CC_EXEC_MOCK;
  delete process.env.CC_EXEC_MOCK_DELAY_MS;
  _resetConversationsForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('drain: lopend kind wordt interrupted+gekilld, nieuw werk geweigerd, ledger draagt het bewijs', async () => {
  const conv = createConversation({ project: 'drain-demo' });
  const start = startExecution({ convId: conv.id, turnId: 't-d1', requestId: 'req-d1', text: 'lang werk', cwd: execCwd });
  assert.equal(start.started, true, JSON.stringify(start));
  assert.equal(runningExecutionCount(), 1);

  assert.equal(isDraining(), false);
  enterDrainMode('testfout');
  assert.equal(isDraining(), true);

  // (1) nieuw werk wordt geweigerd met de drain-reden
  const conv2 = createConversation({ project: 'drain-demo-2' });
  const refused = startExecution({ convId: conv2.id, turnId: 't-d2', requestId: 'req-d2', text: 'mag niet', cwd: execCwd });
  assert.equal(refused.started, false);
  assert.match(refused.reason, /draining/);

  // (2)+(3) lopende executies interrupted + exact-PID tree-kill
  const interrupted = interruptAllExecutions('testfout');
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].convId, conv.id);
  assert.ok(Number(interrupted[0].pid) > 0, 'de gekillde pid is de echte kind-pid');
  assert.equal(runningExecutionCount(), 0);

  // het ECHTE kindproces is (na de asynchrone taskkill) binnen korte tijd echt weg
  const deadline = Date.now() + 8000;
  while (pidAlive(interrupted[0].pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(pidAlive(interrupted[0].pid), false, 'het kind moet echt dood zijn (tree-kill)');

  // het ledger draagt het duurzame interrupted-event
  const full = readConversation(conv.id);
  const ev = (full.events || []).find((e) => e.kind === 'interrupted');
  assert.ok(ev, 'conversation-ledger moet een interrupted-event dragen: ' + JSON.stringify((full.events || []).map((e) => e.kind)));
  assert.match(ev.data && ev.data.reason ? ev.data.reason : '', /testfout/);
});
