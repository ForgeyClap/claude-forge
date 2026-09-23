#!/usr/bin/env node
'use strict';
/**
 * forge-mcp-usage.test.cjs — was an MCP tool ever used without the least-privilege gate running?
 *
 * MEASURED DEFECT (broad Codex audit #1, the heaviest of the 30): forge-mcp-gate.cjs enforces tiers,
 * per-Boss allow-lists and owner-verified tier-3 writes — but it is a library nobody is obliged to call,
 * so an MCP tool can be used while the gate never runs. On this machine `mcp_grant_validated` is a
 * registered event type with ZERO occurrences across every run: exactly the shape of the run-contract
 * gate, which existed and was tested for months while having been evaluated exactly zero times.
 * Forge cannot hook Claude Code's dispatcher, so this makes the gap measurable instead of theoretical.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const U = require('./forge-mcp-usage.cjs');
const CLI = path.join(__dirname, 'forge-mcp-usage.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };

console.log('forge-mcp-usage tests (is the MCP gate actually reached?)');

function mkRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-usage-'));
  fs.mkdirSync(path.join(r, '.claude', 'forge-runs'), { recursive: true });
  return r;
}
function addToolLog(root, records) {
  const d = path.join(root, '.claude', 'forge-runs', '_toollog');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'session-a.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function addRunEvents(root, runId, events) {
  const d = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

t('no tool ledger at all -> UNKNOWN, never "the gate is fine"', () => {
  const r = U.check({ root: mkRoot() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.unknown, true);
  assert.ok(/UNKNOWN|cannot be observed/i.test(r.reason), r.reason);
});

t('a ledger with no MCP calls says "nothing happened", not "the gate works"', () => {
  const root = mkRoot();
  addToolLog(root, [{ ts: '2026-08-05T10:00:00Z', tool: 'Bash', target: 'ls' }]);
  const r = U.check({ root });
  assert.strictEqual(r.ok, true);
  assert.ok(/nothing to gate/.test(r.reason), r.reason);
  assert.ok(/not "the gate is working"/.test(r.reason), 'the honest caveat is missing: ' + r.reason);
});

t('MCP calls with ZERO gate decisions is the real finding: ok=false', () => {
  const root = mkRoot();
  addToolLog(root, [
    { ts: '2026-08-05T10:00:00Z', tool: 'mcp__claude-flow__terminal_execute' },
    { ts: '2026-08-05T10:01:00Z', tool: 'mcp__claude-flow__terminal_execute' },
    { ts: '2026-08-05T10:02:00Z', tool: 'mcp__n8n__create_workflow' },
    { ts: '2026-08-05T10:03:00Z', tool: 'Read' },
  ]);
  addRunEvents(root, 'run-1', [{ event_type: 'run_started' }]);
  const r = U.check({ root });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.usedTools.length, 2);
  assert.ok(/ZERO grant validations/.test(r.reason), r.reason);
  assert.ok(/terminal_execute/.test(r.reason), 'the reason should name the tools: ' + r.reason);
});

t('the busiest tool is reported first, with its real count and last-seen time', () => {
  const root = mkRoot();
  addToolLog(root, [
    { ts: '2026-08-05T10:00:00Z', tool: 'mcp__a__one' },
    { ts: '2026-08-05T10:05:00Z', tool: 'mcp__a__one' },
    { ts: '2026-08-05T10:06:00Z', tool: 'mcp__b__two' },
  ]);
  const r = U.check({ root });
  assert.strictEqual(r.usedTools[0].tool, 'mcp__a__one');
  assert.strictEqual(r.usedTools[0].count, 2);
  assert.strictEqual(r.usedTools[0].last, '2026-08-05T10:05:00Z');
});

t('MCP calls WITH gate decisions logged -> ok, with an honest caveat about pairing', () => {
  const root = mkRoot();
  addToolLog(root, [{ ts: '2026-08-05T10:00:00Z', tool: 'mcp__a__one' }]);
  addRunEvents(root, 'run-1', [{ event_type: 'mcp_grant_validated' }, { event_type: 'mcp_grant_denied' }]);
  const r = U.check({ root });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.validations.validated, 1);
  assert.strictEqual(r.validations.denied, 1);
  assert.ok(/does not pair each call/.test(r.reason), 'must not overclaim: ' + r.reason);
});

t('a torn last line in the ledger does not crash or count', () => {
  const root = mkRoot();
  const d = path.join(root, '.claude', 'forge-runs', '_toollog');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 's.jsonl'), '{"ts":"2026-08-05T10:00:00Z","tool":"mcp__a__one"}\n{"ts":"2026-08', 'utf8');
  const r = U.check({ root });
  assert.strictEqual(r.usedTools.length, 1);
});

t('CLI exits 3 on ungated MCP use and 0 when there is nothing to gate', () => {
  const bad = mkRoot();
  addToolLog(bad, [{ ts: '2026-08-05T10:00:00Z', tool: 'mcp__x__write' }]);
  const r1 = spawnSync(process.execPath, [CLI, '--root', bad], { encoding: 'utf8' });
  assert.strictEqual(r1.status, 3, r1.stdout + r1.stderr);
  assert.ok(/UNGATED MCP USE/.test(r1.stdout), r1.stdout);

  const good = mkRoot();
  addToolLog(good, [{ ts: '2026-08-05T10:00:00Z', tool: 'Bash' }]);
  const r2 = spawnSync(process.execPath, [CLI, '--root', good], { encoding: 'utf8' });
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
});

// The real project: today this is expected to report "nothing to gate" (no MCP tool has been recorded
// in the ledger yet). The assertion is deliberately weak — it proves the checker RUNS against real data
// without pretending that a quiet machine is evidence the gate works.
t('live project: the checker runs against real data and answers honestly', () => {
  const r = U.check({});
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  assert.ok(Array.isArray(r.usedTools));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
