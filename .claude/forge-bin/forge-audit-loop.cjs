#!/usr/bin/env node
'use strict';
/**
 * forge-audit-loop.cjs — the continuous AUDIT-LOOP tool (FORGE V9 WAVE 2, 2026-07-22). The honest
 * realization of the owner's "24h loop" ask: a single, real, bounded ITERATION that inspects this project's
 * own health and honestly SURFACES findings — it never self-schedules, never auto-fixes beyond a
 * trivially-safe repair it can prove, and never fabricates a finding it didn't actually detect. Zero-
 * dependency (fs/path/child_process only), composed entirely from EXISTING sibling tools as libraries —
 * this file does not reimplement profile/rules parsing, agent-frontmatter checking, capability-usage
 * scoring, or the doctor's own checks; it calls them and translates their real output into findings.
 *
 * FOUR REAL CHECKS PER ITERATION:
 *   MEMORY-INTEGRITY — this project's own FORGE_OWNER_PROFILE.json + FORGE_STANDING_RULES.json parse
 *     cleanly (reused: forge-prefs.cjs::loadProfileLayer, forge-standing.cjs::load), and every Boss's
 *     agent-memory lessons.jsonl (forge-memory.cjs::listLessons) has no corrupted lines. A file that is
 *     simply ABSENT is never treated as corruption (a fresh/not-yet-seeded project is a normal state — see
 *     forge-doctor.cjs's own memoryDiscipline() precedent for the same distinction) — only a PRESENT-but-
 *     unparseable file, or a lessons.jsonl with fewer real parsed lines than real non-blank raw lines
 *     (proof some lines were silently dropped as malformed), becomes a finding. Never fabricates memory
 *     content to "fix" a gap.
 *   AGENT-HEALTH — every agent file under .claude/agents/ (the 12 permanent Bosses + specialists, 18 in
 *     this project) is checked via forge-doctor.cjs::agentsCheck (missing Boss files, invalid Boss
 *     frontmatter, an injection/supply-chain pattern in ANY agent body, tool-policy drift) — reused
 *     verbatim, never re-implemented. agentsCheck's own frontmatter-shape validation only covers the 12
 *     canonical Bosses by design (see that function's own scope); this file additionally reuses the
 *     exported parseFrontmatter() pure helper (never a second regex) to check the SAME required fields
 *     (name/description/tools/model) on every non-Boss specialist file too, so "each of the 18 agents" is
 *     genuinely covered end to end.
 *   FEATURE-USAGE — reuses forge-capabilities.cjs::report() and surfaces every capability (tool/skill/gate)
 *     that is present on disk but has NEVER been mentioned in any real logged run or memory file
 *     (times_used:0) — the owner's own "I have all this tooling and barely notice it" signal, made visible
 *     every iteration instead of staying buried in a one-off report. HONEST BUCKETING (V9 audit-loop fix,
 *     2026-07-22 — the 22-never-used finding included capabilities that are SUPPOSED to sit dormant until a
 *     specific situation arises, which is a false alarm, not a real gap): a never-used capability is split
 *     into two findings instead of one alarming lump —
 *       (a) "conditional (expected dormant)" [severity 'info'] — a hard-gate (kind:'gate'; EVERY gate this
 *           project's single source of truth config/orchestration/hard-gates.json declares is class
 *           'irreversible' or 'isolation' by construction — see forge-actiongate.cjs's own header doc — so
 *           `kind==='gate'` alone is already a real, non-hardcoded signal grounded in that config, never a
 *           second gate-id list maintained here) or an on-demand DOMAIN skill (kind:'skill' whose name is
 *           REAL-PARSED off forge-router/SKILL.md's own "Step 1 — Classify the domain" table Playbook column
 *           at call time — see domainSkillNamesFromRouter() below — never a hardcoded skill-name array that
 *           could drift from that table). Never firing yet is the DESIGN INTENT for both (a hard gate not
 *           firing means no irreversible/isolation-escaping action happened; a domain skill not firing means
 *           that project domain hasn't come up yet) — reported as informational, not an alarm.
 *       (b) the genuine "worth a real look" finding [severity 'low', same as before] — every OTHER never-
 *           used tool/skill, i.e. one this project's own router never documents as situational. This is the
 *           real should-be-investigated signal the owner's "56%-non-invocation" complaint is about.
 *   DOCTOR-DELTA — reuses forge-doctor.cjs::runDoctor() and records the real tests pass/fail tally plus any
 *     advisory. A red doctor (`ok:false`) is always a finding; a non-clean advisory sub-check (backfill
 *     continuity / sync completeness / memory discipline / mcp dormancy / run contract) is a LOW-severity
 *     finding too — advisory in doctor's own gate, but still worth surfacing here rather than silently
 *     dropped, since this tool's whole purpose is to make otherwise-easy-to-miss signal visible.
 *
 * HONESTY / NON-AUTOFIX POSTURE: iterate() is read-only against the PROJECT (it never edits agent files,
 * profile/rules JSON, or lesson stores) — the only write this tool ever performs is appending one JSON line
 * to its OWN ledger (.claude/forge-audit/ledger.jsonl), and optionally logging real events via the sibling
 * log-event.cjs when an explicit --run <id> is given. It does not self-schedule (no cron/timer anywhere in
 * this file) — a real recurring loop is the owner's own OS scheduler or usage-guard.cjs watch, exactly the
 * same opt-in-only posture forge-nightshift already documents; this tool only guarantees that WHEN invoked,
 * one real iteration happens and is honestly recorded.
 *
 * MODULE API:
 *   iterate({root}, opts) -> { iteration, generated_at, root, findings:[{category,severity,detail,evidence}],
 *     summary:{generated_at, finding_count, by_category, by_severity, doctor, capabilities, briefing} }
 *     opts.now — Date override (test determinism). opts.doctorReport — a pre-built runDoctor()-shaped object,
 *     used INSTEAD of a real runDoctor() call (hermetic-test seam — a real runDoctor() spawns node --check +
 *     every *.test.cjs suite under <root>/.claude/forge-bin/, which is both slow and the wrong thing to
 *     re-run inside THIS tool's own unit tests). opts.capabilitiesOpts — passthrough object merged into the
 *     forge-capabilities.cjs::report() call (e.g. {knownGateIds:[], gatesConfigPath:<path>} to fully isolate
 *     a hermetic fixture from this project's real gate vocabulary). opts.runId — when set, also logs one
 *     real `audit_iteration` event + one `audit_finding` event per finding into
 *     .claude/forge-runs/<runId>/events.jsonl via the sibling log-event.cjs (best-effort; never throws).
 *     opts.briefingRunId — explicit run to brief on; defaults to the latest GENUINE dispatched run (see
 *     forge-doctor.cjs::latestDispatchedRunIdFor). opts.skipBriefing — skip the briefing attempt entirely.
 *   appendLedger(root, entry) -> the entry with a real `iteration` number assigned (existing ledger line
 *     count + 1), appended (fs.appendFileSync, directory created if needed) — NEVER overwrites/truncates.
 *   readLedger(root) -> [entry, ...] — every well-formed JSON-object line in the ledger, malformed lines
 *     silently skipped (never crashes the reader), same tolerance convention as forge-memory.cjs::listLessons.
 *   memoryIntegrityFindings(root) / agentHealthFindings(root) / featureUsageFindings(root, opts) /
 *     doctorDeltaFindings(root, opts) — the four checks above, each independently callable/testable.
 *   domainSkillNamesFromRouter(root) -> Set<string> of lowercased skill names REAL-PARSED from
 *     forge-router/SKILL.md's "Step 1" domain table (never hardcoded — see FEATURE-USAGE doc above);
 *     degrades to an empty Set (never throws) when that file is missing/unreadable.
 *   isConditionalCapability(cap, domainSkillNames) -> true when `cap` (a forge-capabilities.cjs report()
 *     record) is a hard-gate (kind:'gate') or a router-documented domain skill (kind:'skill' && its name is
 *     in domainSkillNames) — the exact predicate featureUsageFindings() uses to split its two findings.
 *   maybeBriefing(root, opts) -> {ok, run_id, markdown} | {ok:false, reason, run_id}
 *   logAuditEvents(root, runId, iterResult) -> {ok, iteration_event_status, finding_event_statuses}
 *
 * CLI:
 *   node forge-audit-loop.cjs iterate [--json] [--root <dir>] [--run <run_id>]
 *   node forge-audit-loop.cjs ledger [--json] [--root <dir>] [--limit <n>]
 * Exit codes: 0 = ran (an honestly-empty findings list is still success, never an error) · 1 = a real error
 * while iterating/reading · 2 = usage error (unknown argument/command).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');
function claudeDir(root) { return path.join(root, '.claude'); }
function relFromRoot(root, p) { return path.relative(root, p).split(path.sep).join('/'); }

// ---- soft sibling deps (never crash iterate() if a sibling module is missing — same "soft dependency"
// discipline forge-doctor.cjs already uses for forge-policy.cjs/forge-sync.cjs/forge-verify.cjs) ----
let prefsMod = null; try { prefsMod = require('./forge-prefs.cjs'); } catch { prefsMod = null; }
let standingMod = null; try { standingMod = require('./forge-standing.cjs'); } catch { standingMod = null; }
let memoryMod = null; try { memoryMod = require('./forge-memory.cjs'); } catch { memoryMod = null; }
let doctorMod = null; try { doctorMod = require('./forge-doctor.cjs'); } catch { doctorMod = null; }
let capsMod = null; try { capsMod = require('./forge-capabilities.cjs'); } catch { capsMod = null; }
let briefingMod = null; try { briefingMod = require('./forge-briefing.cjs'); } catch { briefingMod = null; }

// ---------------------------------------------------------------------------
// MEMORY-INTEGRITY
// ---------------------------------------------------------------------------
/** memoryIntegrityFindings(root) -> [finding, ...]. See file header for the exact contract. Never writes,
 *  never fabricates content for a missing file — a missing file is at most a LOW-severity note, a
 *  present-but-broken file is a real HIGH-severity finding. */
function memoryIntegrityFindings(root) {
  const findings = [];
  const cd = claudeDir(root);

  if (!prefsMod) {
    findings.push({ category: 'MEMORY-INTEGRITY', severity: 'medium', detail: 'forge-prefs.cjs module not available — owner-profile check skipped', evidence: null });
  } else {
    const profilePath = path.join(cd, 'FORGE_OWNER_PROFILE.json');
    try {
      const layer = prefsMod.loadProfileLayer(profilePath, 'project');
      if (!layer.present) {
        findings.push({ category: 'MEMORY-INTEGRITY', severity: 'medium', detail: 'FORGE_OWNER_PROFILE.json not found at ' + relFromRoot(root, profilePath) + ' (fresh/not-yet-seeded project — not necessarily an error)', evidence: profilePath });
      }
    } catch (e) {
      findings.push({ category: 'MEMORY-INTEGRITY', severity: 'high', detail: 'FORGE_OWNER_PROFILE.json failed to parse/validate: ' + e.message, evidence: profilePath });
    }
  }

  if (!standingMod) {
    findings.push({ category: 'MEMORY-INTEGRITY', severity: 'medium', detail: 'forge-standing.cjs module not available — standing-rules check skipped', evidence: null });
  } else {
    const rulesPath = path.join(cd, 'config', 'orchestration', 'FORGE_STANDING_RULES.json');
    try {
      standingMod.load({ rulesPath });
    } catch (e) {
      const missing = e && e.code === 'ENOENT';
      findings.push({
        category: 'MEMORY-INTEGRITY',
        severity: missing ? 'medium' : 'high',
        detail: missing
          ? 'FORGE_STANDING_RULES.json not found at ' + relFromRoot(root, rulesPath) + ' (fresh/not-yet-seeded project — not necessarily an error)'
          : 'FORGE_STANDING_RULES.json failed to parse/validate: ' + e.message,
        evidence: rulesPath,
      });
    }
  }

  if (memoryMod) {
    const memBase = path.join(cd, 'agent-memory');
    let bossDirs = [];
    try { bossDirs = fs.readdirSync(memBase, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { bossDirs = []; }
    for (const slug of bossDirs) {
      const lessonsFile = path.join(memBase, slug, 'lessons.jsonl');
      let raw;
      try { raw = fs.readFileSync(lessonsFile, 'utf8'); } catch { continue; } // no lessons.jsonl for this Boss yet — normal, not a finding
      const rawLines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (rawLines.length === 0) continue; // present but empty — normal, not a finding
      const parsed = memoryMod.listLessons(slug, root); // reuses the real reader — silently drops malformed lines itself
      if (parsed.length < rawLines.length) {
        findings.push({
          category: 'MEMORY-INTEGRITY',
          severity: 'high',
          detail: (rawLines.length - parsed.length) + ' corrupted lesson line(s) in agent-memory/' + slug + '/lessons.jsonl (parsed ' + parsed.length + '/' + rawLines.length + ' real line(s))',
          evidence: lessonsFile,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// AGENT-HEALTH
// ---------------------------------------------------------------------------
const NON_BOSS_REQUIRED_FIELDS = ['name', 'description', 'tools', 'model'];
/** agentHealthFindings(root) -> [finding, ...]. Reuses forge-doctor.cjs::agentsCheck() verbatim for the 12
 *  Bosses + injection/tool-policy scan across every agent file, and additionally reuses the exported
 *  parseFrontmatter() helper (never a second parser) to validate the SAME required-field shape on every
 *  non-Boss specialist file too, so "each of the 18 agents" is genuinely covered end to end. */
function agentHealthFindings(root) {
  const findings = [];
  if (!doctorMod) {
    findings.push({ category: 'AGENT-HEALTH', severity: 'medium', detail: 'forge-doctor.cjs module not available — agent-health check skipped', evidence: null });
    return findings;
  }

  let ac;
  try { ac = doctorMod.agentsCheck(root); }
  catch (e) { findings.push({ category: 'AGENT-HEALTH', severity: 'high', detail: 'forge-doctor.agentsCheck threw: ' + e.message, evidence: null }); return findings; }

  if (ac.missing && ac.missing.length) {
    findings.push({ category: 'AGENT-HEALTH', severity: 'high', detail: ac.missing.length + ' Boss agent file(s) missing: ' + ac.missing.join(', '), evidence: JSON.stringify(ac.missing) });
  }
  if (ac.badFrontmatter && ac.badFrontmatter.length) {
    findings.push({ category: 'AGENT-HEALTH', severity: 'high', detail: ac.badFrontmatter.length + ' Boss agent file(s) have invalid/incomplete frontmatter: ' + ac.badFrontmatter.join(', '), evidence: JSON.stringify(ac.badFrontmatter) });
  }
  if (ac.injection && ac.injection.length) {
    findings.push({ category: 'AGENT-HEALTH', severity: 'high', detail: ac.injection.length + ' agent file(s) carry an injection/supply-chain pattern: ' + ac.injection.map((h) => h.file + ':' + h.pattern).join('; '), evidence: JSON.stringify(ac.injection) });
  }
  const tp = ac.toolPolicy || {};
  if (tp.ok === false) {
    const parts = [
      tp.reason || '',
      (tp.missingPolicy || []).length ? 'no policy entry: ' + tp.missingPolicy.join(',') : '',
      (tp.missingAgentFile || []).length ? 'policy entry but no agent-md: ' + tp.missingAgentFile.join(',') : '',
      (tp.classViolations || []).length ? 'policy itself violates class rules: ' + tp.classViolations.map((v) => v.agent).join(',') : '',
      (tp.driftViolations || []).length ? 'tool-grant drift: ' + tp.driftViolations.map((v) => v.agent).join(',') : '',
    ].filter(Boolean).join(' · ');
    findings.push({ category: 'AGENT-HEALTH', severity: 'medium', detail: 'agent tool-policy check failed: ' + (parts || 'unavailable'), evidence: JSON.stringify(tp) });
  }

  // Supplemental coverage (this file's own addition, not agentsCheck's scope — see file header): the 6
  // non-Boss specialist files also need a real frontmatter-shape check, reusing the exported parser.
  const bossNames = new Set(doctorMod.BOSS_NAMES || []);
  const agentsDir = path.join(claudeDir(root), 'agents');
  let files = [];
  try { files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')); } catch { files = []; }
  const badNonBoss = [];
  for (const f of files) {
    const base = f.replace(/\.md$/, '');
    if (bossNames.has(base)) continue; // already validated by agentsCheck above
    let text;
    try { text = fs.readFileSync(path.join(agentsDir, f), 'utf8'); } catch { badNonBoss.push(base); continue; }
    const fm = doctorMod.parseFrontmatter(text);
    if (!fm || NON_BOSS_REQUIRED_FIELDS.some((k) => !fm[k])) badNonBoss.push(base);
  }
  if (badNonBoss.length) {
    findings.push({ category: 'AGENT-HEALTH', severity: 'medium', detail: badNonBoss.length + ' non-Boss specialist agent file(s) have invalid/incomplete frontmatter: ' + badNonBoss.join(', '), evidence: JSON.stringify(badNonBoss) });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// FEATURE-USAGE
// ---------------------------------------------------------------------------
/** domainSkillNamesFromRouter(root) -> Set<string> of lowercased forge-<domain> skill names REAL-PARSED off
 *  forge-router/SKILL.md's own "Step 1 — Classify the domain" markdown table (its rightmost "Playbook"
 *  column) — see file header FEATURE-USAGE doc for why this must be a live parse, never a hardcoded array
 *  that could silently drift from that table. Deliberately scoped to ONLY the Step 1 section (bounded by
 *  the next "## Step 2" heading) so a tool mentioned elsewhere in the same file (e.g. forge-tournament in
 *  Step 3c) is never mistaken for a domain skill. Tolerant by design: a missing/unreadable file or a file
 *  with no matching section degrades to an empty Set, never throws. */
function domainSkillNamesFromRouter(root) {
  const skillFile = path.join(claudeDir(root), 'skills', 'forge-router', 'SKILL.md');
  let text;
  try { text = fs.readFileSync(skillFile, 'utf8'); } catch { return new Set(); }
  const startIdx = text.indexOf('## Step 1');
  if (startIdx === -1) return new Set();
  const afterStart = text.slice(startIdx);
  const nextHeadingIdx = afterStart.slice(1).search(/\n## /); // first "## " heading AFTER Step 1's own
  const section = nextHeadingIdx === -1 ? afterStart : afterStart.slice(0, nextHeadingIdx + 1);
  const names = new Set();
  for (const line of section.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue; // only markdown table rows
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (!cells.length) continue;
    const lastCell = cells[cells.length - 1];
    const m = lastCell.match(/`(forge-[a-z0-9-]+)`/i);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

/** isConditionalCapability(cap, domainSkillNames) -> see file header MODULE API doc. */
function isConditionalCapability(cap, domainSkillNames) {
  if (cap.kind === 'gate') return true;
  if (cap.kind === 'skill' && domainSkillNames.has(String(cap.name).toLowerCase())) return true;
  return false;
}

/** featureUsageFindings(root, opts) -> {findings, report}. Reuses forge-capabilities.cjs::report()
 *  verbatim. opts.capabilitiesOpts is merged into the report() call (hermetic-test seam — lets a fixture
 *  fully isolate itself from this project's real gate vocabulary; production/CLI use passes none, so the
 *  real project's full capability inventory is honestly checked). See file header FEATURE-USAGE doc for the
 *  honest two-bucket split this function now produces (conditional/expected-dormant vs. a real finding). */
function featureUsageFindings(root, opts) {
  opts = opts || {};
  if (!capsMod) return { findings: [{ category: 'FEATURE-USAGE', severity: 'medium', detail: 'forge-capabilities.cjs module not available — feature-usage check skipped', evidence: null }], report: null };
  let rep;
  try { rep = capsMod.report(Object.assign({ root }, opts.capabilitiesOpts || {})); }
  catch (e) { return { findings: [{ category: 'FEATURE-USAGE', severity: 'high', detail: 'forge-capabilities.report threw: ' + e.message, evidence: null }], report: null }; }

  const neverUsed = rep.capabilities.filter((c) => c.times_used === 0);
  const domainSkillNames = domainSkillNamesFromRouter(root);
  const conditional = neverUsed.filter((c) => isConditionalCapability(c, domainSkillNames));
  const genuine = neverUsed.filter((c) => !isConditionalCapability(c, domainSkillNames));

  const findings = [];
  if (conditional.length) {
    const names = conditional.map((c) => c.capability);
    findings.push({
      category: 'FEATURE-USAGE',
      severity: 'info',
      detail: conditional.length + '/' + rep.capabilities.length + ' installed capability(ies) are conditional (expected dormant — a hard gate that only fires on an irreversible/isolation-class action, or an on-demand domain skill that only fires for that project domain; never firing yet is the design intent, not a defect): '
        + names.slice(0, 20).join(', ') + (names.length > 20 ? ', ... (+' + (names.length - 20) + ' more — see evidence)' : ''),
      evidence: JSON.stringify(names),
    });
  }
  if (genuine.length) {
    const names = genuine.map((c) => c.capability);
    findings.push({
      category: 'FEATURE-USAGE',
      severity: 'low',
      detail: genuine.length + '/' + rep.capabilities.length + ' installed capability(ies) have never been used and are NOT explained by a hard-gate/domain-skill exemption (0 mentions in any logged run or memory file): '
        + names.slice(0, 20).join(', ') + (names.length > 20 ? ', ... (+' + (names.length - 20) + ' more — see evidence)' : ''),
      evidence: JSON.stringify(names),
    });
  }
  return { findings, report: { summary: rep.summary } };
}

// ---------------------------------------------------------------------------
// DOCTOR-DELTA
// ---------------------------------------------------------------------------
/** buildDoctorDeltaFromReport(rep) -> {findings, report}. Pure translation of a runDoctor()-shaped report
 *  into findings — split out so a hermetic test (opts.doctorReport) and the real runDoctor() call both flow
 *  through the exact same decision logic (never two parallel judgments that could silently drift). */
function summarizeAdvisory(c) {
  if (c && typeof c.reason === 'string' && c.reason) return c.reason;
  if (c && Array.isArray(c.violations)) return c.violations.length + ' violation(s)';
  if (c && Array.isArray(c.warnings)) return c.warnings.length + ' warning(s)';
  if (c && Array.isArray(c.missing)) return c.missing.length + ' item(s) missing';
  return 'not clean';
}
function buildDoctorDeltaFromReport(rep) {
  const findings = [];
  if (!rep) return { findings, report: null };

  if (rep.ok === false) {
    const failedChecks = Object.entries(rep.checks || {}).filter(([, v]) => v && v.ok === false).map(([k]) => k);
    findings.push({
      category: 'DOCTOR-DELTA',
      severity: 'high',
      detail: 'forge-doctor reports RED' + (failedChecks.length ? ' — failing: ' + failedChecks.join(', ') : ''),
      evidence: JSON.stringify(failedChecks),
    });
  }

  const adv = rep.advisory || {};
  if (adv.backfill_continuity && adv.backfill_continuity.ok === false) {
    findings.push({
      category: 'DOCTOR-DELTA',
      severity: 'low',
      detail: 'backfill-continuity advisory: ' + (adv.backfill_continuity.warnings || []).length + ' warning(s)',
      evidence: JSON.stringify(adv.backfill_continuity.warnings || []),
    });
  }
  const cm = adv.completeness || {};
  for (const key of Object.keys(cm)) {
    const c = cm[key];
    if (c && c.ok === false) {
      findings.push({ category: 'DOCTOR-DELTA', severity: 'low', detail: 'completeness advisory "' + key + '" not clean: ' + summarizeAdvisory(c), evidence: JSON.stringify(c) });
    }
  }

  const tests = rep.checks && rep.checks.tests ? { passed: rep.checks.tests.passed, failed: rep.checks.tests.failed, suites: rep.checks.tests.suites } : null;
  return { findings, report: { ok: rep.ok, tests } };
}
/** doctorDeltaFindings(root, opts) -> {findings, report}. opts.doctorReport lets a hermetic test supply a
 *  pre-built report instead of triggering a real runDoctor() (which spawns node --check + every
 *  *.test.cjs suite under <root>/.claude/forge-bin — correct for a real project, wrong and slow inside this
 *  tool's own unit tests). */
function doctorDeltaFindings(root, opts) {
  opts = opts || {};
  if (opts.doctorReport) return buildDoctorDeltaFromReport(opts.doctorReport);
  if (!doctorMod) return { findings: [{ category: 'DOCTOR-DELTA', severity: 'medium', detail: 'forge-doctor.cjs module not available — doctor-delta check skipped', evidence: null }], report: null };
  let rep;
  try { rep = doctorMod.runDoctor(root); }
  catch (e) { return { findings: [{ category: 'DOCTOR-DELTA', severity: 'high', detail: 'forge-doctor.runDoctor threw: ' + e.message, evidence: null }], report: null }; }
  return buildDoctorDeltaFromReport(rep);
}

// ---------------------------------------------------------------------------
// Briefing (optional, best-effort — see file header)
// ---------------------------------------------------------------------------
function safeLatestDispatchedRunId(root) {
  if (!doctorMod) return null;
  try {
    if (typeof doctorMod.latestDispatchedRunIdFor === 'function') return doctorMod.latestDispatchedRunIdFor(root);
    if (typeof doctorMod.latestRunIdFor === 'function') return doctorMod.latestRunIdFor(root);
  } catch { /* best effort — a briefing is optional, never fatal */ }
  return null;
}
/** maybeBriefing(root, opts) -> {ok, run_id, markdown} | {ok:false, reason, run_id}. Never throws — a
 *  briefing is a nice-to-have addition to an iteration, never load-bearing for the audit itself. */
function maybeBriefing(root, opts) {
  opts = opts || {};
  if (!briefingMod) return { ok: false, reason: 'forge-briefing.cjs module not available', run_id: null };
  const runId = opts.briefingRunId || safeLatestDispatchedRunId(root);
  if (!runId) return { ok: false, reason: 'no dispatched run available to brief on', run_id: null };
  try {
    const result = briefingMod.generate({ run_id: runId }, { root });
    return { ok: true, run_id: runId, markdown: result.markdown };
  } catch (e) {
    return { ok: false, reason: 'forge-briefing.generate threw: ' + e.message, run_id: runId };
  }
}

// ---------------------------------------------------------------------------
// Ledger — append-only, never overwrites (see file header)
// ---------------------------------------------------------------------------
function ledgerDir(root) { return path.join(claudeDir(root), 'forge-audit'); }
function ledgerPath(root) { return path.join(ledgerDir(root), 'ledger.jsonl'); }
/** readLedger(root) -> [entry, ...]. A missing ledger degrades to [] (a fresh project has never iterated
 *  yet — normal, not an error). A malformed line is silently skipped (never crashes the reader), same
 *  tolerance convention as forge-memory.cjs::listLessons. */
function readLedger(root) {
  let raw;
  try { raw = fs.readFileSync(ledgerPath(root), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { const v = JSON.parse(s); if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v); } catch { /* malformed line — skipped, never crashes the reader */ }
  }
  return out;
}
/** appendLedger(root, entry) -> the entry with a real `iteration` number (existing ledger length + 1)
 *  assigned, appended via fs.appendFileSync (mkdirSync recursive first) — NEVER truncates/overwrites an
 *  existing ledger. */
function appendLedger(root, entry) {
  fs.mkdirSync(ledgerDir(root), { recursive: true });
  const existing = readLedger(root);
  const full = Object.assign({}, entry, { iteration: existing.length + 1 });
  fs.appendFileSync(ledgerPath(root), JSON.stringify(full) + '\n', 'utf8');
  return full;
}

// ---------------------------------------------------------------------------
// Event logging (optional, only when --run/opts.runId is given — see file header)
// ---------------------------------------------------------------------------
/** logAuditEvents(root, runId, iterResult) -> {ok, iteration_event_status, finding_event_statuses}. Never
 *  throws — logs are best-effort; a logging failure never invalidates the ledger entry already written. */
function logAuditEvents(root, runId, iterResult) {
  const le = path.join(claudeDir(root), 'forge-dashboard', 'log-event.cjs');
  const iterEv = spawnSync(process.execPath, [le, runId, 'audit_iteration', JSON.stringify({
    agent: 'reviewer',
    note: 'forge-audit-loop iteration ' + iterResult.iteration + ': ' + iterResult.findings.length + ' finding(s)',
    iteration: iterResult.iteration,
  })], { encoding: 'utf8' });
  const findingStatuses = [];
  for (const f of iterResult.findings) {
    const r = spawnSync(process.execPath, [le, runId, 'audit_finding', JSON.stringify({
      agent: 'reviewer',
      note: f.detail,
      category: f.category,
      severity: f.severity,
      evidence: typeof f.evidence === 'string' ? f.evidence : JSON.stringify(f.evidence),
    })], { encoding: 'utf8' });
    findingStatuses.push(r.status);
  }
  return {
    ok: iterEv.status === 0 && findingStatuses.every((s) => s === 0),
    iteration_event_status: iterEv.status,
    finding_event_statuses: findingStatuses,
  };
}

// ---------------------------------------------------------------------------
// tally + iterate()
// ---------------------------------------------------------------------------
function tally(findings, field) {
  const out = {};
  for (const f of findings || []) {
    const k = f && f[field];
    if (k == null) continue;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** iterate(input, opts) -> ONE real audit iteration, appended to the ledger. See file header MODULE API for
 *  the full opts contract. */
function iterate(input, opts) {
  input = input || {};
  opts = opts || {};
  const root = path.resolve(input.root || opts.root || PROJECT_ROOT_DEFAULT);
  const now = opts.now instanceof Date ? opts.now : new Date();
  // WP-S4 (v2.8.0 laptop-audit Part VI): `forge-audit-loop iterate` runs forge-doctor's FULL suite (every
  // *.test.cjs under forge-bin) as its DOCTOR-DELTA check, which the audit measured at 45s-150s with nothing
  // printed in the meantime — indistinguishable from a hang. opts.onProgress(stage) is called before each of
  // the four real checks (a no-op unless the caller supplies one — every existing test keeps working exactly
  // as before); the CLI below wires it to a stderr line so a real run shows it is still working.
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  const findings = [];
  progress('memory-integrity check');
  findings.push(...memoryIntegrityFindings(root));
  progress('agent-health check');
  findings.push(...agentHealthFindings(root));
  progress('feature-usage check');
  const usage = featureUsageFindings(root, opts);
  findings.push(...usage.findings);
  progress('doctor check (runs the full test suite — this can take a minute or more)');
  const doctor = doctorDeltaFindings(root, opts);
  findings.push(...doctor.findings);
  progress('briefing');

  const briefing = opts.skipBriefing ? { ok: false, reason: 'briefing skipped (opts.skipBriefing)', run_id: null } : maybeBriefing(root, opts);

  const summary = {
    generated_at: now.toISOString(),
    finding_count: findings.length,
    by_category: tally(findings, 'category'),
    by_severity: tally(findings, 'severity'),
    doctor: doctor.report,
    capabilities: usage.report,
    briefing: { ok: briefing.ok, run_id: briefing.run_id || null, reason: briefing.reason || null },
  };

  const entry = { generated_at: now.toISOString(), root, findings, summary };
  const appended = appendLedger(root, entry);

  if (opts.runId && /^[A-Za-z0-9_-]+$/.test(opts.runId)) {
    appended.event_log = logAuditEvents(root, opts.runId, appended);
  }

  return appended;
}

module.exports = {
  iterate,
  appendLedger, readLedger, ledgerPath, ledgerDir,
  memoryIntegrityFindings, agentHealthFindings, featureUsageFindings, doctorDeltaFindings,
  domainSkillNamesFromRouter, isConditionalCapability,
  buildDoctorDeltaFromReport, summarizeAdvisory,
  maybeBriefing, logAuditEvents, tally,
  PROJECT_ROOT_DEFAULT,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, json: false, root: null, run: null, limit: null, usageError: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--root') { opts.root = rest[++i]; if (!opts.root && !opts.usageError) opts.usageError = '--root requires a <dir>'; }
    else if (a === '--run') { opts.run = rest[++i]; if (!opts.run && !opts.usageError) opts.usageError = '--run requires a <run_id>'; }
    else if (a === '--limit') { opts.limit = Number(rest[++i]); if (!Number.isFinite(opts.limit) && !opts.usageError) opts.usageError = '--limit requires a number'; }
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-audit-loop.cjs iterate [--json] [--root <dir>] [--run <run_id>]');
  console.error('       node forge-audit-loop.cjs ledger [--json] [--root <dir>] [--limit <n>]');
}
function formatIteration(r) {
  const lines = [];
  lines.push('Forge Audit Loop — iteration #' + r.iteration + ' (' + r.generated_at + ')');
  lines.push('  ' + r.findings.length + ' finding(s)');
  for (const f of r.findings) lines.push('  - [' + f.severity + '] ' + f.category + ': ' + f.detail);
  if (r.summary && r.summary.doctor) lines.push('  doctor: ' + (r.summary.doctor.ok ? 'ALL GREEN' : 'FAILURES') + (r.summary.doctor.tests ? (' (' + r.summary.doctor.tests.passed + ' passed / ' + r.summary.doctor.tests.failed + ' failed, ' + r.summary.doctor.tests.suites + ' suites)') : ''));
  if (r.summary && r.summary.briefing) lines.push('  briefing: ' + (r.summary.briefing.ok ? ('generated for ' + r.summary.briefing.run_id) : ('not available (' + r.summary.briefing.reason + ')')));
  return lines.join('\n');
}
function formatLedger(entries) {
  const lines = ['forge-audit-loop ledger — ' + entries.length + ' entrie(s)'];
  for (const e of entries) lines.push('  #' + e.iteration + ' @ ' + e.generated_at + ' — ' + ((e.findings && e.findings.length) || 0) + ' finding(s)');
  return lines.join('\n');
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.usageError) { console.error('forge-audit-loop: ' + args.usageError); printUsage(); process.exitCode = 2; }
  else if (args.cmd === 'iterate') {
    try {
      const root = args.root ? path.resolve(args.root) : PROJECT_ROOT_DEFAULT;
      // WP-S4: progress goes to stderr, never stdout, so `--json` output stays exactly one clean JSON object.
      const onProgress = args.json ? undefined : (stage) => console.error('forge-audit-loop: ' + stage + '…');
      const result = iterate({ root }, { runId: args.run, onProgress });
      if (args.json) console.log(JSON.stringify(result));
      else console.log(formatIteration(result));
      process.exitCode = 0;
    } catch (e) { console.error('forge-audit-loop: ' + e.message); process.exitCode = 1; }
  } else if (args.cmd === 'ledger') {
    try {
      const root = args.root ? path.resolve(args.root) : PROJECT_ROOT_DEFAULT;
      let entries = readLedger(root);
      if (Number.isFinite(args.limit) && args.limit > 0) entries = entries.slice(-args.limit);
      if (args.json) console.log(JSON.stringify(entries));
      else console.log(formatLedger(entries));
      process.exitCode = 0;
    } catch (e) { console.error('forge-audit-loop: ' + e.message); process.exitCode = 1; }
  } else {
    printUsage();
    process.exitCode = 2;
  }
}
