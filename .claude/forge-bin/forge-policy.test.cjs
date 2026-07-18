#!/usr/bin/env node
'use strict';
// forge-policy.test.cjs — tests cascade / ruleOfTwo / mcpAllowlistCheck / toolPolicyCheck (2026-07-11,
// toolPolicyCheck added WP2 2026-07-14 least-privilege enforcement).
const assert = require('assert');
const { cascade, ruleOfTwo, mcpAllowlistCheck, toolPolicyCheck } = require('./forge-policy.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge policy tests (cascade / rule-of-two / mcp allow-list)');

t('cascade: sonnet + gate fail escalates to opus (once)', () => { const r = cascade('sonnet', true, false); assert.ok(r.model === 'opus' && r.escalated === true); });
t('cascade: opus + gate fail does NOT double-escalate', () => { const r = cascade('opus', true, false); assert.ok(r.model === 'opus' && r.escalated === false); });
t('cascade: hard task (auth/migration) pins opus up front', () => assert.strictEqual(cascade('sonnet', false, 'auth token migration').model, 'opus'));
t('cascade: sonnet + pass stays on sonnet', () => { const r = cascade('sonnet', false, false); assert.ok(r.model === 'sonnet' && r.escalated === false); });

t('rule-of-two: all three properties -> needsSplit', () => assert.ok(ruleOfTwo({ ingestUntrusted: true, secrets: true, externalWrite: true }).needsSplit === true));
t('rule-of-two: only two -> within bounds', () => assert.ok(ruleOfTwo({ ingestUntrusted: true, externalWrite: true }).needsSplit === false));

t('mcp allow-list: unknown server flagged, not ok', () => { const r = mcpAllowlistCheck({ good: { sha256: 'a' } }, [{ name: 'evil', sha256: 'x' }]); assert.ok(r.unknown.includes('evil') && r.ok === false); });
t('mcp allow-list: drifted (rug-pulled) hash flagged', () => { const r = mcpAllowlistCheck({ good: { sha256: 'a' } }, [{ name: 'good', sha256: 'b' }]); assert.ok(r.drift.length === 1 && r.ok === false); });
t('mcp allow-list: matching pinned server is ok', () => { const r = mcpAllowlistCheck({ good: { sha256: 'a' } }, [{ name: 'good', sha256: 'a' }]); assert.ok(r.ok === true && r.allowed.includes('good')); });

console.log('');
console.log('toolPolicyCheck (WP2 least-privilege enforcement, pure unit tests)');

const BASE_POLICY = {
  classes: {
    'read-only-audit': { tools_base: ['Read', 'Grep', 'Glob'], forbidden: ['Write', 'Edit', 'Bash'] },
    'write-no-exec': { tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'], forbidden: ['Bash'] },
    'full-build': { tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'], forbidden: [] },
  },
  agents: {
    'review-boss': { class: 'read-only-audit', tools: ['Read', 'Grep', 'Glob'] },
    'boss': { class: 'write-no-exec', tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'] },
    'build-boss': { class: 'full-build', tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] },
  },
};

t('toolPolicyCheck: exact-matching grants -> ok=true, no violations', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === true && r.driftViolations.length === 0 && r.missingPolicy.length === 0 && r.missingAgentFile.length === 0 && r.classViolations.length === 0);
});

t('toolPolicyCheck: a read-only-audit agent gaining Bash is flagged as extra + ok=false', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob', 'Bash'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false);
  assert.ok(r.driftViolations.some((v) => v.agent === 'review-boss' && v.extra.includes('Bash')));
});

t('toolPolicyCheck: a read-only-audit agent gaining Write/Edit is flagged as extra + ok=false', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob', 'Write', 'Edit'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false);
  assert.ok(r.driftViolations.some((v) => v.agent === 'review-boss' && v.extra.includes('Write') && v.extra.includes('Edit')));
});

t('toolPolicyCheck: a write-no-exec agent gaining Bash is flagged as extra + ok=false', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false);
  assert.ok(r.driftViolations.some((v) => v.agent === 'boss' && v.extra.includes('Bash')));
});

t('toolPolicyCheck: an agent-md granting a tool the policy never lists for it is flagged as extra', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'WebFetch'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false && r.driftViolations.some((v) => v.agent === 'build-boss' && v.extra.includes('WebFetch')));
});

t('toolPolicyCheck: an agent-md granting FEWER tools than policy is also flagged (missing, exact-match required)', () => {
  const grants = { 'review-boss': ['Read', 'Grep'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false && r.driftViolations.some((v) => v.agent === 'review-boss' && v.missing.includes('Glob')));
});

t('toolPolicyCheck: an agent-md with no policy entry is flagged missingPolicy + ok=false', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'], 'rogue-agent': ['Read'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false && r.missingPolicy.includes('rogue-agent'));
});

t('toolPolicyCheck: a policy entry with no matching agent-md is flagged missingAgentFile + ok=false', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] }; // 'boss' missing
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false && r.missingAgentFile.includes('boss'));
});

t('toolPolicyCheck: the POLICY FILE ITSELF assigning a forbidden tool to a class is caught even when the agent-md matches it exactly (defense-in-depth vs. a stale/tampered policy)', () => {
  const badPolicy = JSON.parse(JSON.stringify(BASE_POLICY));
  badPolicy.agents['review-boss'].tools = ['Read', 'Grep', 'Glob', 'Bash']; // policy itself now grants Bash to a read-only-audit agent
  const grants = { 'review-boss': ['Read', 'Grep', 'Glob', 'Bash'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(badPolicy, grants);
  assert.ok(r.ok === false);
  assert.ok(r.classViolations.some((v) => v.agent === 'review-boss' && v.forbidden.includes('Bash')));
});

t('toolPolicyCheck: empty/undefined policy and grants never throw (vacuously ok=true, 0 agents on both sides)', () => {
  const r1 = toolPolicyCheck(undefined, undefined);
  const r2 = toolPolicyCheck({}, {});
  assert.ok(r1.ok === true && r1.missingPolicy.length === 0 && r1.missingAgentFile.length === 0);
  assert.ok(r2.ok === true);
});

console.log('');
console.log('M7 (WP2 close-out, 2026-07-14) — exact-token comparison, not loose substring/case-insensitive match');

t('toolPolicyCheck: a merged/smuggled token ("GlobBash") hiding a forbidden tool inside an allowed-looking string is flagged as extra, AND the real "Glob" still shows as missing — proves exact-token compare, not substring matching', () => {
  const grants = { 'review-boss': ['Read', 'Grep', 'GlobBash'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false);
  const v = r.driftViolations.find((d) => d.agent === 'review-boss');
  assert.ok(v, 'review-boss must be flagged in driftViolations');
  assert.ok(v.extra.includes('GlobBash'), 'the merged token itself must appear verbatim in extra (not silently absorbed as a match for "Glob" or "Bash")');
  assert.ok(v.missing.includes('Glob'), 'the real "Glob" tool must still show as missing — the merged token does not satisfy it');
});

t('toolPolicyCheck: a case-variant token ("read" instead of "Read") is flagged as extra, AND the real "Read" still shows as missing — proves the comparison is exact-case, not case-insensitive', () => {
  const grants = { 'review-boss': ['read', 'Grep', 'Glob'], 'boss': ['Read', 'Write', 'Edit', 'Grep', 'Glob'], 'build-boss': ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'] };
  const r = toolPolicyCheck(BASE_POLICY, grants);
  assert.ok(r.ok === false);
  const v = r.driftViolations.find((d) => d.agent === 'review-boss');
  assert.ok(v, 'review-boss must be flagged in driftViolations');
  assert.ok(v.extra.includes('read'), 'lowercase "read" must show as extra — must not silently satisfy "Read" via case-folding');
  assert.ok(v.missing.includes('Read'), 'the real capitalized "Read" must still show as missing');
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
