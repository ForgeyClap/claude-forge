#!/usr/bin/env node
'use strict';
/**
 * forge-policy.cjs — pure, testable orchestration/security policy helpers (2026-07-11, NEXT tier):
 *   • cascade()          — verifier-driven model cascade: run on Sonnet, escalate to Opus only on a failed
 *                          gate (bounded to one escalation); hard tasks pin Opus up front. Capability-per-token.
 *   • ruleOfTwo()        — Meta's "Rule of Two": an agent step should not simultaneously (1) ingest untrusted
 *                          content, (2) touch secrets/sensitive systems, AND (3) write/communicate externally.
 *                          All three at once → split the work package across Bosses.
 *   • mcpAllowlistCheck()— detect unknown or drifted (rug-pulled) MCP servers vs a pinned allow-list.
 * No side effects, no I/O — the Lead/Head Chef call these at dispatch time; forge-core documents the rules.
 */

const HARD_OPUS = /auth|jwt|hmac|credential|secret|migrat|delete|payment|charge|refund|deploy|production|security|final[_-]?verdict/i;

// Verifier-driven cascade. current: 'sonnet'|'opus'|... · gateFailed: did the build/test/review gate fail ·
// hardTask: a hint string or boolean for the pinned hard-Opus set. Escalates at most once (Sonnet→Opus).
function cascade(current, gateFailed, hardTask) {
  const hard = typeof hardTask === 'string' ? HARD_OPUS.test(hardTask) : !!hardTask;
  if (hard) return { model: 'opus', escalated: current !== 'opus', reason: 'hard task pinned to Opus' };
  if (gateFailed && String(current).toLowerCase() === 'sonnet') return { model: 'opus', escalated: true, reason: 'gate failed → escalate the same work package to Opus (once)' };
  return { model: current, escalated: false, reason: gateFailed ? 'already at top tier — no further escalation' : 'passed / first attempt — stay on ' + current };
}

// Rule of Two: flags = { ingestUntrusted, secrets, externalWrite } (booleans). >2 true → must split.
function ruleOfTwo(flags) {
  flags = flags || {};
  const props = ['ingestUntrusted', 'secrets', 'externalWrite'].filter((k) => !!flags[k]);
  const needsSplit = props.length > 2;
  return { count: props.length, held: props, needsSplit, guidance: needsSplit ? 'split this work package across Bosses so no single step holds all three' : 'within Rule-of-Two — ok' };
}

// MCP allow-list drift check. allowlist: { name: { version, sha256 } }. servers: [{ name, version, sha256 }].
// unknown = server not in the allow-list; drift = present but description hash changed (possible rug-pull).
function mcpAllowlistCheck(allowlist, servers) {
  allowlist = allowlist || {}; servers = servers || [];
  const unknown = [], drift = [], ok = [];
  for (const s of servers) {
    const a = allowlist[s.name];
    if (!a) { unknown.push(s.name); continue; }
    if ((a.sha256 && s.sha256 && a.sha256 !== s.sha256) || (a.version && s.version && a.version !== s.version)) drift.push({ name: s.name, expected: a.sha256 || a.version, got: s.sha256 || s.version });
    else ok.push(s.name);
  }
  return { ok: unknown.length === 0 && drift.length === 0, allowed: ok, unknown, drift };
}

// toolPolicyCheck() — WP2 (2026-07-14): mechanical least-privilege enforcement for agent tool grants.
// Pure, no I/O — forge-doctor.cjs's agentsCheck() does the file reads (agent-tool-policy.json + every
// agent-md's frontmatter `tools:` line) and calls this with plain data. Fails on ANY drift:
//   • an agent-md exists with no matching policy.agents entry (missingPolicy)
//   • a policy.agents entry exists with no matching agent-md file present (missingAgentFile)
//   • the policy ITSELF assigns an agent a tool forbidden by that agent's own class (classViolations) —
//     catches someone "hardening via drift" by editing the policy file to grant a forbidden tool rather
//     than editing the agent-md (defense-in-depth against the policy file itself going stale/wrong)
//   • an agent-md's REAL granted tools differ (extra OR missing) from the exact list policy.agents[name]
//     specifies (driftViolations) — this is the core check: e.g. review-boss (read-only-audit) gaining
//     `Bash`/`Write`/`Edit` in its frontmatter shows up here as `extra`.
// policy: { classes: {name: {forbidden:[...]}}, agents: {name: {class, tools:[...]}} }
// grants: { agentName: [tool, tool, ...] } — already-split tool arrays per present agent-md file.
function toolPolicyCheck(policy, grants) {
  policy = policy || {}; grants = grants || {};
  const classes = policy.classes || {};
  const policyAgents = policy.agents || {};
  const policyNames = Object.keys(policyAgents);
  const grantNames = Object.keys(grants);

  const missingPolicy = grantNames.filter((n) => !policyAgents[n]);
  const missingAgentFile = policyNames.filter((n) => !grants[n]);

  const classViolations = [];
  const driftViolations = [];
  for (const name of policyNames) {
    const entry = policyAgents[name] || {};
    const cls = classes[entry.class];
    const allowed = new Set((entry.tools || []).map((s) => String(s).trim()));
    if (cls && Array.isArray(cls.forbidden)) {
      const badInPolicy = [...allowed].filter((t) => cls.forbidden.includes(t));
      if (badInPolicy.length) classViolations.push({ agent: name, class: entry.class, forbidden: badInPolicy });
    }
    if (!grants[name]) continue; // already reported in missingAgentFile
    const got = new Set((grants[name] || []).map((s) => String(s).trim()));
    const extra = [...got].filter((t) => !allowed.has(t));
    const missingTools = [...allowed].filter((t) => !got.has(t));
    if (extra.length || missingTools.length) driftViolations.push({ agent: name, class: entry.class, extra, missing: missingTools });
  }

  const ok = missingPolicy.length === 0 && missingAgentFile.length === 0 && classViolations.length === 0 && driftViolations.length === 0;
  return { ok, missingPolicy, missingAgentFile, classViolations, driftViolations };
}

module.exports = { cascade, ruleOfTwo, mcpAllowlistCheck, toolPolicyCheck, HARD_OPUS };

if (require.main === module) {
  console.log('forge-policy — pure helpers (cascade / ruleOfTwo / mcpAllowlistCheck). Import from the Lead/Head Chef.');
  console.log('example cascade(sonnet, gateFailed=true):', JSON.stringify(cascade('sonnet', true, false)));
  console.log('example ruleOfTwo(all three):', JSON.stringify(ruleOfTwo({ ingestUntrusted: true, secrets: true, externalWrite: true })));
}
