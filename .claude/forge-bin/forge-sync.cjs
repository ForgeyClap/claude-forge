#!/usr/bin/env node
'use strict';
/**
 * Forge installer / sync — SAFE SYNC (2026-07-14 hardening WP1 + 2026-07-14 FIX ROUND). Zero-dependency
 * (fs/path/crypto/child_process/os only), Windows-safe. Replaces the old "fs.copyFileSync straight over the
 * project file, no backup, no canary, no validation, no rollback" design that made this the highest-blast-radius
 * file in Forge (one bad template could break all 12 projects with no undo).
 *
 * FIX ROUND (2026-07-14, this pass) closed 7 blockers + 4 high findings + 11 medium findings found by an
 * adversarial review, independent QA (mutation-tested), and a 4-lens pre-mortem swarm:
 *   B1 cumulative drift baseline (receipt.knownHashes, not just filesChanged)      B2 receipt itself is now
 *   backed up/restored on rollback   B3 "unreadable" != "missing" (refuses instead of treating as new)
 *   B4 rollback-batch reaches the central backup + counts only real successes     B5 default central backup
 *   hub (<root>/.forge-backup-hub)   B6 no more ~/Documents default for multi-project commands   B7 rollback
 *   refuses to clobber content that diverged since this sync wrote it (--force-rollback-newer to override)
 *   H1 rollback never claims "restored" without a post-restore verify   H2 install exits 1 + prints BLOCKED
 *   when drift blocks (was silently exit 0)   H3 pre-sync validation baseline distinguishes a genuine
 *   regression from pre-existing red   H4 validation requires positive evidence (forge-doctor --json), a
 *   degraded (no-doctor) pass needs --allow-degraded   M1-M11 (see inline // M<n> markers).
 *
 * FIX (2026-07-26, wp4 canary repro): the dedicated canary was aborting stage 0 on EVERY sync-all run,
 * regardless of template health. Direct repro (canaryInit + buildPlan + applyPlanSafely + a real `node
 * forge-doctor.cjs --json` run against the freshly-populated canary, before any rollback) isolated the exact
 * cause: one real, non-fabricated test (forge-capabilities-panel.test.cjs) has a genuine precondition of "at
 * least one real run with events.jsonl exists in this project" — true for every real Forge project, but
 * structurally impossible for a scaffold that canaryInit wipes and recreates empty on every single run (M5).
 * Every other check/suite was genuinely green (89 suites, only this 1 assertion red). See seedCanaryRun's own
 * doc comment (near runValidation) for the fix: log ONE real, honestly-described run_started event into the
 * canary's own just-synced forge-runs/ (via its own freshly-copied log-event.cjs, going through the same
 * strict-mode honesty gate any real event would) right before validation runs — canary-only, opt-in via
 * opts.seedRunForValidation, wired ONLY into canarySyncOpts in runSyncAll. A real project's forge-runs/ is
 * never touched by this. This is not a gate weakening: a genuinely broken template still fails the doctor for
 * real reasons; a genuinely safe template now gets an honest, unconditional pass instead of being blocked by
 * an environment gap that was never the template's fault.
 *
 * SAFE FLOW (default for `install` and `sync-all`):
 *   1. PREFLIGHT   — classify every system file per project into: unchanged / to-change / expected_override
 *                     (declared in <project>/.claude/config/forge-overrides.json) / unknown_drift (project
 *                     changed, template didn't, no matching receipt) / conflict (BOTH project and template
 *                     changed since the last receipt) / eol_only (raw bytes differ ONLY by line-ending style
 *                     — always safe to sync, classification-only, RAW bytes still backed up/copied verbatim).
 *                     unknown_drift/conflict are NEVER silently overwritten. An existing-but-UNREADABLE system
 *                     file REFUSES the whole project sync (never silently treated as "new").
 *   2. BACKUP      — before ANY write: copy every file about to change into BOTH
 *                     <project>/.claude/forge-backups/<batchId>/<rel> (per-project) AND a second, central
 *                     copy at <centralRoot>/.claude/forge-backups/<batchId>/<projectId>/<rel>, unless
 *                     --no-central-backup is passed. `centralRoot` defaults differently per command (N10
 *                     fix, 2026-09-26 external audit — see defaultCentralBackupRoot()'s own doc comment):
 *                     for the single-project commands `install`/`rollback` it now defaults INSIDE the
 *                     project itself (<project>/.claude/forge-backups-central) — never a folder outside
 *                     .claude/ that forge-sync has no business writing to by default; for the multi-project
 *                     commands `sync-all`/`rollback-batch` it still defaults to <rootDir>/.forge-backup-hub,
 *                     since the caller already explicitly named that whole multi-project root. Any command
 *                     accepts --central-backup-root to point the second copy somewhere else entirely.
 *                     manifest.json records batchId/ts/runId/templateVersion/projectId/projectPath/
 *                     files[{rel,oldHash,newHash,existed}]/hadVersionFile/oldVersion/hadReceipt/oldReceipt.
 *                     Reusing a --batch-id that already backed up THIS project refuses (pass --resume-batch).
 *   3. DRY-RUN     — `--dry-run` prints the full plan and writes NOTHING (including no lock file).
 *   4. TWO-STAGE CANARY — `sync-all` ALWAYS syncs a dedicated, disposable, dot-prefixed canary project
 *      (`.forge-canary/`, wiped and recreated fresh on every canary-init/sync-all run) FIRST — a real project
 *      can never occupy that slot. Only if it validates does sync-all sync ONE representative real project,
 *      then a staged ladder (2 -> 3 -> --stage-size thereafter, default 3) over the rest. ANY validation
 *      failure OR any unresolved unknown_drift/conflict (without --force-overwrite) rolls back that project
 *      and STOPS the whole batch — later projects stay byte-untouched. `--force-overwrite` in sync-all
 *      requires the explicit `--force-all` co-flag and prints the exact per-project forced file list first.
 *   5. VALIDATE    — spawn forge-doctor.cjs BOTH before (baseline) and after writing, with --json, and
 *      require POSITIVE EVIDENCE (node_check.total >= files just synced, tests.suites>0, tests.passed>0) —
 *      a bare exit code is never trusted. A post-sync failure that was ALREADY present pre-sync (same
 *      checks red before and after, and the node_check hard gate on the just-synced files is clean) is
 *      reported as "already-red, not attributed to this sync" rather than blamed on the sync. Missing
 *      forge-doctor -> DEGRADED node --check fallback; a degraded pass never counts as synced unless
 *      --allow-degraded is passed. A doctor timeout is BLOCKED, not a confirmed failure.
 *   6. RECEIPT     — <project>/.claude/forge-sync-receipt.json: projectId/projectPath, batchId, runId,
 *      templateVersionFrom/To, backupRef, pre/post-sync manifest hashes, filesChanged, knownHashes (the
 *      CUMULATIVE per-file baseline — every system file's last-known-good hash, carried forward across
 *      syncs so an untouched file never "forgets" its baseline), overridesPreserved, validation +
 *      preValidation (both baselines persisted), rollbackStatus, syncedAt.
 *   7. ROLLBACK    — restores byte-for-byte from whichever backup (project-local, else central) passes an
 *      integrity check; refuses (never fabricates "restored") when: the backup is missing/corrupt, the
 *      on-disk content has diverged from what this sync wrote (pass --force-rollback-newer), or a NEWER
 *      batch already touched the same file for this project. Every restored file is RE-VERIFIED by hash
 *      after restore — a file that could not actually be restored/verified is never counted as restored;
 *      the result is PARTIAL — MANUAL RECOVERY REQUIRED instead. forge-sync-receipt.json and
 *      FORGE_VERSION.json are restored/removed in the same pass. Journaled (resumable/idempotent).
 *   8. --unsafe    — skips canary + validation only. It STILL takes a real backup (never "no undo"), STILL
 *      honors the forge-overrides.json allow-list, STILL respects the containment/symlink guard, and STILL
 *      refuses on an unreadable existing file rather than treating it as "new" (S2 fix).
 *
 * `adopt <projectDir>` establishes a baseline receipt from a project's CURRENT file hashes without writing
 * a single template/system file — prints which files differ from the template so a human can triage them
 * into forge-overrides.json. This replaces a blind --force-overwrite for a project's very first safe sync.
 * S5: adopt REFUSES to replace an already-adopted baseline unless --force is passed (a second adopt would
 * otherwise silently un-protect every previously-drifted file); --force snapshots the pre-adopt receipt first.
 *
 * NOT BUILT (honest gap, not silently ignored): forge-sync has never had a mechanism for the template to
 * DELETE/prune a project's system file (SYSTEM/SYSTEM_GLOB is purely additive). Out of scope here; rollback
 * already supports restoring an ADDED file back to non-existence (oldHash:null), the one deletion-shaped
 * case this tool can actually produce today.
 *
 * Usage:
 *   node forge-sync.cjs status [<projectDir>] [--verbose]
 *   node forge-sync.cjs install <projectDir> [--dry-run] [--force-overwrite] [--unsafe] [--batch-id <id>]
 *     [--central-backup-root <dir>] [--no-central-backup] [--run-id <id>] [--allow-degraded]
 *     [--doctor-timeout <ms>] [--resume-batch]
 *   node forge-sync.cjs adopt <projectDir> [--dry-run] [--force]
 *   node forge-sync.cjs list <rootDir>                                    # root REQUIRED (no ~/Documents default)
 *   node forge-sync.cjs canary-init <rootDir>                             # root REQUIRED; wipes+recreates the canary
 *   node forge-sync.cjs sync-all <rootDir> [--canary <projectName>] [--stage-size N] [--dry-run]
 *     [--force-overwrite --force-all] [--unsafe] [--batch-id <id>] [--central-backup-root <dir>]
 *     [--no-central-backup] [--run-id <id>] [--allow-degraded] [--doctor-timeout <ms>]
 *   node forge-sync.cjs doctor [<projectDir>]                             # alias for status
 *   node forge-sync.cjs rollback <projectDir> [--batch <batchId>] [--central-backup-root <dir>]
 *     [--force-rollback-newer]
 *   node forge-sync.cjs rollback-batch <batchId> <rootDir> [--central-backup-root <dir>] [--force-rollback-newer]
 *
 * Exit codes: 0 = all projects synced+validated (or a read-only command succeeded); 1 = batch aborted /
 * rolled back / operational refusal (bad path, missing backup, drift-blocked, etc.); 2 = usage error.
 *
 * Module API (for direct unit testing — every exported function takes its root/template dir as an explicit
 * argument; NONE of them call Date.now()/generate their own batchId — batchId/nowIso are always injected by
 * the caller so tests stay deterministic):
 *   listSystemFiles, sha256, sha256Normalized, fileStatus, templateVersion, claudeDirOf, safeJoin,
 *   isSymlinkPath, containmentSafe, projectId, receiptPath, readReceipt, writeReceipt,
 *   receiptLastTemplateHashMap, readOverrideAllowlist, migrateOwnerStandingRules, preflight, buildPlan, fullFileManifest,
 *   aggregateManifestHash, backupDirFor, centralBackupDir, takeBackup, applyPlanSafely, runValidation,
 *   decideValidationOutcome, seedCanaryRun, verifyBackupIntegrity, loadTrustedManifest, findNewerOverlappingBatches,
 *   restoreFromManifest, rollbackProject, rollbackBatch, acquireLock, releaseLock, safeSyncProject,
 *   adoptProject, rawInstall, status, findForgeProjects, dedicatedCanaryDir, canaryInit, runSyncAll,
 *   parseArgs, CANARY_DIR_NAME.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// SYSTEM files (synced). Anything not matched here is PROJECT-LOCAL and never overwritten.
const SYSTEM = [
  'commands/forge.md',
  'agents/codex-reviewer.md',
  'config/agents/agent-registry.json', 'config/agents/agent-model-map.json', 'config/agents/agent-skill-map.json',
  // WP2: the least-privilege tool policy MUST ship with the checker that reads it. forge-doctor's agents
  // check fails closed when this file is absent, and a red doctor is a batch-stopping event for sync — so
  // leaving it out of SYSTEM would make the checker reach all 12 projects while the rules it enforces did
  // not, wedging the first real rollout on its own safety gate. Pinned by a test in forge-sync.test.cjs.
  'config/agents/agent-tool-policy.json',
  'config/models/model-capability-matrix.json', 'config/models/function-model-fit.json', 'config/skills/global-skills.json',
  'config/orchestration/forge-graph.json', 'config/forge-bench/baseline.json',
  // WAVE A / A1 (2026-07-18): the hard-gates SINGLE source of truth for irreversible/isolation-escape
  // detection. forge-actiongate.cjs (which reads this file) is a forge-bin/*.cjs file and is already
  // covered by SYSTEM_GLOB below — pinned here explicitly too (with its test) so a future SYSTEM_GLOB
  // change can't silently drop the pairing; mirrors the WP2 agent-tool-policy.json precedent above.
  'config/orchestration/hard-gates.json', 'forge-bin/forge-actiongate.cjs', 'forge-bin/forge-actiongate.test.cjs',
  // WAVE B / B1-B4 (2026-07-18): owner-governance stack — owner-profile prefs (B1), standing rules (B2),
  // autonomy policy (B3), and the precedence doc + applied-prefs ECHO wiring (B4). The *.cjs/*.test.cjs
  // readers (forge-prefs.cjs, forge-standing.cjs, forge-autonomy.cjs, forge-echo.cjs + their tests) already
  // live in forge-bin/ and are covered by SYSTEM_GLOB below; the config/data files they read are NOT
  // glob-covered (config/orchestration/ and the .claude root are not globbed dirs) and are pinned here
  // explicitly, same discipline as the hard-gates.json pairing above.
  'FORGE_OWNER_PROFILE.json', 'FORGE_PREF_CANDIDATES.json',
  'config/orchestration/FORGE_STANDING_RULES.json', 'config/orchestration/FORGE_AUTONOMY.json',
  'config/orchestration/precedence.md',
  'docs/model-routing.md', 'docs/agents-and-skills.md',
  // WAVE A / A4 (2026-07-18): Test Boss's mutation-testing recipe (forge-mutate.cjs wiring) —
  // ships alongside the agent definition (agents/*.md is already SYSTEM_GLOB-covered) so a synced
  // project's test-boss.md instructions and its referenced recipe doc never drift apart.
  'docs/test-boss-mutation-recipe.md',
  'FORGE_MODEL_ROUTING.json', 'FORGE_PAPERCLIP_AGENTS.json',
  'skills/forge-deeplearn/SKILL.md', 'skills/forge-prd/SKILL.md', 'skills/forge-mindmap/SKILL.md',
  'skills/forge-registry/SKILL.md', 'skills/forge-doctor/SKILL.md',
  'skills/forge-verify/SKILL.md', 'skills/forge-agent-report/SKILL.md', 'skills/forge-heartbeat/SKILL.md',
  'skills/humanizer/SKILL.md',
  'skills/gsap/gsap-core/SKILL.md', 'skills/gsap/gsap-frameworks/SKILL.md',
  'skills/gsap/gsap-performance/SKILL.md', 'skills/gsap/gsap-plugins/SKILL.md',
  'skills/gsap/gsap-react/SKILL.md', 'skills/gsap/gsap-scrolltrigger/SKILL.md',
  'skills/gsap/gsap-timeline/SKILL.md', 'skills/gsap/gsap-utils/SKILL.md',
  'skills/gsap/llms.txt',
  'config/intake/question-bank.json', 'skills/forge-intake/SKILL.md',
  'skills/forge-router/SKILL.md',
  'skills/forge-quality/SKILL.md',
  'skills/forge-council/SKILL.md',
  'skills/forge-scraping/SKILL.md', 'skills/forge-rag/SKILL.md', 'skills/forge-integration/SKILL.md',
  'skills/forge-payments/SKILL.md', 'skills/forge-ecommerce/SKILL.md',
  'skills/forge-electron/SKILL.md', 'skills/forge-voice/SKILL.md',
  'skills/forge-graded-verify/SKILL.md',
  'config/rubrics/rag.json', 'config/rubrics/payments.json', 'config/rubrics/ecommerce.json',
  'config/rubrics/electron.json', 'config/rubrics/voice.json', 'settings.model-tier.example.json',
  // WAVE C / C1-C5 + C-INTEGRATE (2026-07-18): required-evidence + web-quality-contract + Rule-of-Two +
  // run-checklist orchestration stack. The *.cjs/*.test.cjs readers already live in forge-bin/ and are
  // covered by SYSTEM_GLOB below — pinned here explicitly too anyway (same belt-and-suspenders discipline
  // the hard-gates.json/forge-actiongate.cjs pairing established) so a future SYSTEM_GLOB narrowing can't
  // silently drop the pairing between a config/orchestration/*.json source of truth and its reader tool.
  'config/orchestration/domain-presets.json', 'config/orchestration/required-evidence.json',
  'config/orchestration/web-quality-contract.md', 'config/orchestration/run-checklist.json',
  // 2026-08-06 (a card-game project fresh-install failure, 9 tests): forge-codexreview.test.cjs ships via the
  // forge-bin glob and asserts this config exists — but the config itself was never pinned, so every
  // fresh install failed its own doctor on a file the template simply forgot to send. The classic
  // ship-gap this pin-list's doc comment warns about, now including the pinned Codex review model.
  'config/orchestration/codex-review.json',
  // 2026-07-23: solution-first recovery policy — read by forge-recovery.cjs (SYSTEM_GLOB-covered) and
  // asserted-present by forge-recovery.test.cjs (#13). Pinned so the config reaches every project (else
  // that test fails a synced project's doctor) and the config<->reader pair never silently drifts.
  'config/orchestration/FORGE_RECOVERY_POLICY.json',
  // 2026-08-01: the per-run cost cap for UNATTENDED runs — read by forge-run-budget.cjs (SYSTEM_GLOB-
  // covered) and asserted-present by forge-run-budget.test.cjs ("the REAL project config exists..."), so a
  // synced project without it would fail its own doctor. Same config<->reader pinning discipline as the
  // FORGE_RECOVERY_POLICY.json line above.
  'config/orchestration/FORGE_RUN_BUDGET.json',
  'forge-bin/forge-evidence.cjs', 'forge-bin/forge-evidence.test.cjs', 'forge-bin/forge-webquality.test.cjs',
  'forge-bin/forge-ruleoftwo.cjs', 'forge-bin/forge-ruleoftwo.test.cjs',
  'forge-bin/forge-orchestrate.cjs', 'forge-bin/forge-orchestrate.test.cjs',
  // WAVE D (D1/D2/D-INTEGRATE, 2026-07-18): swarm ARM/RECONCILE manifest (forge-manifest.cjs) + mission-level
  // auto-resume (forge-swarm-resume.cjs — named to avoid a real, pre-existing, unrelated forge-resume.cjs
  // global checkpoint/to-do CLI already in this project; see that file's header for the collision note) +
  // the real-fixtures intake gate (forge-fixtures.cjs). The *.cjs/*.test.cjs pairs already live in forge-bin/
  // and are covered by SYSTEM_GLOB below — pinned here explicitly too anyway (same belt-and-suspenders
  // discipline as the hard-gates.json/forge-evidence.cjs precedents above). forge-fixtures/README.md is NOT
  // glob-covered (only forge-bin/forge-dashboard/agents dirs are globbed) so it MUST be pinned explicitly.
  'forge-bin/forge-manifest.cjs', 'forge-bin/forge-manifest.test.cjs',
  'forge-bin/forge-swarm-resume.cjs', 'forge-bin/forge-swarm-resume.test.cjs',
  'forge-bin/forge-fixtures.cjs', 'forge-bin/forge-fixtures.test.cjs',
  'forge-fixtures/README.md',
  // E-INTEGRATE (2026-07-18): forge-doctor's own sync-completeness advisory (WAVE A / A2) found these 6
  // pre-existing playbook/checklist SKILL.md files were NEVER added to this SYSTEM list at all — not a
  // Wave-E regression, a real pre-existing gap the advisory was built to catch. skills/**/SKILL.md is NOT
  // glob-covered (see SYSTEM_GLOB below), so each path needs an explicit entry same as every other skill
  // above. Confirmed via `node forge-doctor.cjs` -> advisory.completeness.sync_completeness.missing before
  // this edit; see the E-INTEGRATE report for the exact before/after count.
  'skills/forge-fullstack/SKILL.md', 'skills/forge-n8n/SKILL.md', 'skills/forge-prediction/SKILL.md',
  'skills/forge-report/SKILL.md', 'skills/forge-website/SKILL.md', 'skills/ship-readiness/SKILL.md',
  // WAVE E (E1/E2/E3/E-INTEGRATE, 2026-07-18): honesty-safe lesson-store consolidation/decay (E2:
  // forge-consolidate.cjs), outcome-gated anti-gaming utility reinforcement (E2: forge-reinforce.cjs), and
  // utility-ranked recall with a reserved global/Lead namespace (E2: forge-recall.cjs); plus Test Boss's
  // scriptable mutation-CHECK wrapper around forge-mutate.cjs (E3: forge-mutcheck.cjs) and the pure
  // events.jsonl-projected requirements-traceability chain (E3: forge-trace.cjs). Every *.cjs/*.test.cjs pair
  // here already lives in forge-bin/ and is covered by SYSTEM_GLOB below — pinned here explicitly too anyway
  // (same belt-and-suspenders discipline as every prior wave's precedent above) so a future SYSTEM_GLOB
  // narrowing can't silently drop the pairing. forge-playbooks.test.cjs (E1) proves the 4 new domain
  // playbooks + their rubrics + the router wiring stay in shape; it is a forge-bin/*.test.cjs file too, same
  // glob coverage + explicit pin. No new event_type was introduced by E2/E3 (both are pure readers of the
  // already-registered vocabulary: check_passed/quality_gate_passed/retest_completed/ticket_created/
  // prd_generated/agent_note) — nothing to add to log-event.cjs/forge-verify.cjs/app.js for this wave.
  'forge-bin/forge-consolidate.cjs', 'forge-bin/forge-consolidate.test.cjs',
  'forge-bin/forge-reinforce.cjs', 'forge-bin/forge-reinforce.test.cjs',
  'forge-bin/forge-recall.cjs', 'forge-bin/forge-recall.test.cjs',
  'forge-bin/forge-mutcheck.cjs', 'forge-bin/forge-mutcheck.test.cjs',
  'forge-bin/forge-trace.cjs', 'forge-bin/forge-trace.test.cjs',
  'forge-bin/forge-playbooks.test.cjs',
  // forge-harvest (2026-07-18, post-WAVE-E): READ-ONLY cross-project learning harvester — reads other Forge
  // projects' .claude/FORGE_*.md memory files (never writes to them) and stores real, evidenced lines into
  // THIS project's reserved global lesson namespace (the same namespace forge-recall.cjs already blends
  // into every dispatch). Reuses forge-store.cjs's/forge-memory.cjs's secret redaction and forge-
  // consolidate.cjs's validateCanonical() — no new secret detector, no new canonical-quote guard. New
  // event_type `lessons_harvested` registered in log-event.cjs/forge-verify.cjs/forge-dashboard/app.js.
  // Already covered by SYSTEM_GLOB below — pinned here explicitly too anyway (same belt-and-suspenders
  // discipline as every prior wave's precedent above).
  'forge-bin/forge-harvest.cjs', 'forge-bin/forge-harvest.test.cjs',
  // WAVE H (H1 forge-docs.cjs, H2 forge-repomap.cjs, H3 the 4 new skills, H4 forge-beads.cjs, H-INTEGRATE,
  // 2026-07-19): zero-dependency real office-document generator (docx/xlsx/pptx/pdf), a cheap token-light
  // repository context map, a lightweight graph backlog/memory ("beads"), and 4 new project-local
  // orchestration-wrapper skills (systematic debugging, structured ideation, code review, safe parallel
  // work via git worktrees). The *.cjs/*.test.cjs pairs already live in forge-bin/ and are covered by
  // SYSTEM_GLOB below — pinned here explicitly too anyway (same belt-and-suspenders discipline as every
  // prior wave's precedent above). forge-newskills.test.cjs (H3) proves the 4 skills are real (frontmatter
  // + required-section lint), same forge-bin/*.test.cjs glob coverage + explicit pin. The 4 skills/*/SKILL.md
  // files are NOT glob-covered (only forge-bin/forge-dashboard/agents dirs are globbed — see the
  // E-INTEGRATE comment above) so each needs an explicit entry same as every other skill in this list. New
  // event types doc_generated (real call site) / repomap_generated / bead_added / bead_closed (forward-
  // declared, no current call site) registered in log-event.cjs/forge-verify.cjs/forge-dashboard/app.js.
  'forge-bin/forge-docs.cjs', 'forge-bin/forge-docs.test.cjs',
  'forge-bin/forge-repomap.cjs', 'forge-bin/forge-repomap.test.cjs',
  'forge-bin/forge-beads.cjs', 'forge-bin/forge-beads.test.cjs',
  'forge-bin/forge-newskills.test.cjs',
  'skills/forge-debug/SKILL.md', 'skills/forge-brainstorm/SKILL.md',
  'skills/forge-code-review/SKILL.md', 'skills/forge-worktrees/SKILL.md',
  // PIECE I (2026-07-19): 12 new domain playbooks (agent/LLM+evals, contract-first API, chat/messaging
  // bots, CLI/dev tool, CMS, data engineering/ETL, browser extension, design-to-code/Figma, games, legacy
  // migration, production MLOps, mobile app) + their config/rubrics/<domain>.json rubrics + the presence/lint
  // test that proves each is real (forge-playbooks-i.test.cjs — mirrors the Wave-E1 forge-playbooks.test.cjs
  // shape for the earlier 4-playbook batch). skills/**/SKILL.md is NOT glob-covered (see the E-INTEGRATE/
  // Wave-H comments above) so each path needs an explicit entry same as every prior playbook batch.
  // forge-playbooks-i.test.cjs is a forge-bin/*.test.cjs file and already covered by SYSTEM_GLOB below —
  // pinned here explicitly too anyway (same belt-and-suspenders discipline as every prior wave's precedent).
  'skills/forge-agent/SKILL.md', 'skills/forge-api/SKILL.md', 'skills/forge-bots/SKILL.md',
  'skills/forge-cli/SKILL.md', 'skills/forge-cms/SKILL.md', 'skills/forge-data/SKILL.md',
  'skills/forge-extension/SKILL.md', 'skills/forge-figma/SKILL.md', 'skills/forge-game/SKILL.md',
  'skills/forge-migration/SKILL.md', 'skills/forge-mlops/SKILL.md', 'skills/forge-mobile/SKILL.md',
  'config/rubrics/agent.json', 'config/rubrics/api.json', 'config/rubrics/bots.json',
  'config/rubrics/cli.json', 'config/rubrics/cms.json', 'config/rubrics/data.json',
  'config/rubrics/extension.json', 'config/rubrics/figma.json', 'config/rubrics/game.json',
  'config/rubrics/migration.json', 'config/rubrics/mlops.json', 'config/rubrics/mobile.json',
  'forge-bin/forge-playbooks-i.test.cjs',
  // WAVE G (G1 forge-mcp-gate.cjs + G-INTEGRATE, 2026-07-19): MCP-as-client least-privilege safety doctrine —
  // dormant/opt-in-by-default catalog + validator + defer-loading planner for external MCP servers (docs
  // lookup, web search, browser-QA, GitHub). The *.cjs/*.test.cjs pairs already live in forge-bin/ and are
  // covered by SYSTEM_GLOB below — pinned here explicitly too anyway (same belt-and-suspenders discipline as
  // every prior wave's precedent above). config/orchestration/mcp-registry.json (server catalog) and
  // mcp-grants.json (per-Boss max_tier + allow_servers matrix) are NOT glob-covered (config/orchestration/ is
  // not a globbed dir) so both need explicit entries, same as hard-gates.json/required-evidence.json above.
  // config/mcp/.mcp.json.example is a reference install-shape template (config/mcp/ is not glob-covered
  // either); skills/forge-mcp-clients/SKILL.md is NOT glob-covered (only forge-bin/forge-dashboard/agents
  // dirs are globbed — see the E-INTEGRATE/Wave-H comments above) so it needs an explicit entry too, same as
  // every other skill in this list. New event types mcp_grant_validated/mcp_grant_denied/mcp_tool_loaded/
  // mcp_native_fallback (forward-declared — forge-mcp-gate.cjs itself does not call logEvent, per its own
  // header "shared-file rule for this wave") registered in log-event.cjs/forge-verify.cjs/forge-dashboard/app.js.
  'forge-bin/forge-mcp-gate.cjs', 'forge-bin/forge-mcp-gate.test.cjs', 'forge-bin/forge-mcp-skill.test.cjs',
  'forge-bin/forge-mcp.cjs', 'forge-bin/forge-mcp.test.cjs',
  'config/orchestration/mcp-registry.json', 'config/orchestration/mcp-grants.json',
  'config/mcp/.mcp.json.example', 'skills/forge-mcp-clients/SKILL.md',
  // WAVE J (J1 forge-genesis.cjs, J2 forge-tournament.cjs, J3 forge-secondbrain.cjs, J4 forge-codemodel.cjs,
  // J5 forge-briefing.cjs, J-INTEGRATE, 2026-07-19): staged/approval-gated self-authoring (never writes
  // `.claude/skills/` without a real owner-approval token), best-of-N tournament planner/scorer, a
  // read-only evidence-cited cross-project portfolio strategist, a persistent incremental codebase index,
  // and a real morning-briefing generator (the tested core the `forge-nightshift` doctrine depends on) +
  // 2 new project-local doctrine skills (`forge-nightshift`, `forge-guardian` — the latter an owner-gated
  // SCAFFOLD, not a running capability). The *.cjs/*.test.cjs pairs already live in forge-bin/ and are
  // covered by SYSTEM_GLOB below — pinned here explicitly too anyway (same belt-and-suspenders discipline
  // as every prior wave's precedent above). skills/**/SKILL.md is NOT glob-covered (see the E-INTEGRATE/
  // Wave-H comments above) so both new skill files need an explicit entry too. New event types
  // skill_proposed/skill_approved/proposal_rejected/tournament_planned/tournament_scored/portfolio_scanned/
  // codemodel_built/codemodel_updated/briefing_generated registered in
  // log-event.cjs/forge-verify.cjs/forge-dashboard/app.js.
  'forge-bin/forge-genesis.cjs', 'forge-bin/forge-genesis.test.cjs',
  'forge-bin/forge-tournament.cjs', 'forge-bin/forge-tournament.test.cjs',
  'forge-bin/forge-secondbrain.cjs', 'forge-bin/forge-secondbrain.test.cjs',
  'forge-bin/forge-codemodel.cjs', 'forge-bin/forge-codemodel.test.cjs',
  'forge-bin/forge-briefing.cjs', 'forge-bin/forge-briefing.test.cjs',
  // Quality Intelligence Layer (masterprompt 2026-08-11): missieprofiel -> lenzen -> omission mining
  // -> requirement cards + de ENE domeincatalogus met driftdetectie over router/evidence/intake/presets.
  'forge-bin/forge-quality.cjs', 'forge-bin/forge-quality.test.cjs',
  // 2026-09-23 (external audit II-A): the /setup-forge engine — shipped in 2.0.0, deleted in 2.1.0 while 35 doc
  // references kept calling it. Pinned here so a template sync can never drop it again.
  'forge-bin/forge-setup.cjs',
  // F-20 (Codex herreview): knowledge cards zijn echte template-bestanden — laag 3 van progressive disclosure
  'config/quality/cards/website.md', 'config/quality/cards/api.md', 'config/quality/cards/n8n.md',
  'config/quality/cards/payments.md', 'config/quality/cards/rag.md', 'config/quality/cards/agent.md',
  'config/quality/cards/mobile.md',
  'config/orchestration/domain-catalog.json',
  'skills/forge-nightshift/SKILL.md', 'skills/forge-guardian/SKILL.md',
  // V9-INTEGRATE (P1 forge-runcontract.cjs, P2 forge-capabilities.cjs, P4 forge-projectbrain.cjs,
  // P5 forge-scout.cjs, V9-INTEGRATE registration, 2026-07-22): a real-run non-negotiables contract checker
  // + its single-source-of-truth config (FORGE_HARD_RULES.json, now also carrying the doctor_check_overrides
  // recovery path), an honest capabilities-vs-usage inventory tool, a tailored external-capability
  // research/vetting doctrine + its persistent ledger (FORGE_SCOUT_VETTING.json — not yet created on disk in
  // this project; harmless to pin now, same "template file doesn't exist yet" tolerance preflight() already
  // has for any not-yet-created system file), and a top-tier project-CLAUDE.md generator + its annotated
  // template. The *.cjs/*.test.cjs pairs already live in forge-bin/ and are covered by SYSTEM_GLOB below —
  // pinned here explicitly too anyway (same belt-and-suspenders discipline as every prior wave's precedent
  // above). skills/**/SKILL.md and skills/forge-projectbrain/template.md are NOT glob-covered (see the
  // E-INTEGRATE/Wave-H comments above) so each needs an explicit entry, same as every other skill/template in
  // this list. New event types research_done/run_contract_checked/run_contract_violated/
  // capabilities_reported/scout_researched/capability_vetted/projectbrain_generated registered in
  // log-event.cjs/forge-verify.cjs/forge-dashboard/app.js.
  'config/orchestration/FORGE_HARD_RULES.json',
  'forge-bin/forge-runcontract.cjs', 'forge-bin/forge-runcontract.test.cjs',
  'forge-bin/forge-capabilities.cjs', 'forge-bin/forge-capabilities.test.cjs',
  'forge-bin/forge-scout.cjs', 'forge-bin/forge-scout.test.cjs',
  'config/orchestration/FORGE_SCOUT_VETTING.json', 'skills/forge-scout/SKILL.md',
  'forge-bin/forge-projectbrain.cjs', 'forge-bin/forge-projectbrain.test.cjs',
  'skills/forge-projectbrain/SKILL.md', 'skills/forge-projectbrain/template.md',
  // V9 WAVE 2 (forge-bin/forge-audit-loop.cjs, 2026-07-22): the continuous AUDIT-LOOP tool — one real
  // iteration per invocation (MEMORY-INTEGRITY / AGENT-HEALTH / FEATURE-USAGE / DOCTOR-DELTA), findings
  // appended to the project-local `.claude/forge-audit/ledger.jsonl` (real per-project data, never a
  // template file, so it is NOT pinned here — same "forge-runs/ isn't SYSTEM either" convention). Already
  // covered by SYSTEM_GLOB below (forge-bin/*.cjs) — pinned here explicitly too anyway (same belt-and-
  // suspenders discipline as every prior wave's precedent above). New event types audit_iteration/
  // audit_finding registered in log-event.cjs/forge-verify.cjs/forge-dashboard/app.js. Also refines
  // forge-doctor.cjs's own run_contract advisory (latestDispatchedRunIdFor()) — no new file for that piece.
  'forge-bin/forge-audit-loop.cjs', 'forge-bin/forge-audit-loop.test.cjs',
  // WP-GH-WIRE (forge-bin/forge-docdrift.cjs, 2026-07-26): doc-drift detector — PATTERN_ADAPTED from the
  // shanraisshan/claude-code-best-practice research finding (no code copied), token-searches a real external
  // doc page against a seeded real claim, OK/NEW-DRIFT/RECURRING/RESOLVED/UNREACHABLE state persisted
  // per-project (NOT pinned here — .claude/forge-research/docdrift-{state.json,ledger.jsonl} are real
  // per-project data, same "not a template file" convention as forge-audit's own ledger). Already covered by
  // SYSTEM_GLOB below (forge-bin/*.cjs) — pinned here explicitly too anyway (same belt-and-suspenders
  // discipline as every prior wave's precedent above). skills/**/SKILL.md is NOT glob-covered (see the
  // E-INTEGRATE/V9-INTEGRATE precedent comments above), so it needs its own explicit entry, same as the
  // config/orchestration/*.json seed file. Uses the ALREADY-REGISTERED audit_finding event type — no new
  // log-event.cjs/forge-verify.cjs/app.js registration needed.
  'forge-bin/forge-docdrift.cjs', 'forge-bin/forge-docdrift.test.cjs',
  'config/orchestration/docdrift-sources.json', 'skills/forge-docdrift/SKILL.md',
  // fin-snapshot (forge-bin/forge-snapshot*.cjs, 2026-07-29 — owner request "bij elke 50% context een
  // snapshot.md"): context-continuity snapshot generator + PreCompact marker + SessionStart(compact)
  // reinject + settings.json merge helper. The 4 *.cjs/*.test.cjs pairs already live in forge-bin/ and are
  // covered by SYSTEM_GLOB below — pinned here explicitly too anyway (same belt-and-suspenders discipline as
  // every prior wave's precedent above). skills/**/SKILL.md is NOT glob-covered (see the docdrift precedent
  // immediately above), so it needs its own explicit entry. This wave introduces NO new log-event.cjs event
  // type (the generator/hooks never call logEvent themselves, per the shared-file rule every other
  // WAVE-J/V9-INTEGRATE module already follows).
  // UPDATED 2026-09-24 (wp22, owner directive 2026-09-24 "alles standaard aan" / never "merge by hand"): the
  // sentence above ("does not itself write settings.json for a synced project — settings.json wiring stays a
  // deliberate, per-project owner action") is SUPERSEDED. forge-sync now DOES write/merge settings.json for a
  // synced project — see syncProjectSettings()/printSettingsMergeResult() near the bottom of this file and
  // the dedicated forge-settings-merge.cjs tool it calls (absent -> created; present -> merged, every foreign
  // hook/rule/key kept byte-for-byte; malformed/unexpected shape -> refused-safe, reported, never fails the
  // file sync). settings.json itself is still deliberately NOT added to the SYSTEM list above: it is
  // user-owned content that gets MERGED, never blindly overwritten like a real SYSTEM file.
  'forge-bin/forge-snapshot.cjs', 'forge-bin/forge-snapshot.test.cjs',
  'forge-bin/forge-snapshot-marker.cjs', 'forge-bin/forge-snapshot-marker.test.cjs',
  'forge-bin/forge-snapshot-reinject.cjs', 'forge-bin/forge-snapshot-reinject.test.cjs',
  'forge-bin/forge-snapshot-settings.cjs', 'forge-bin/forge-snapshot-settings.test.cjs',
  'skills/forge-snapshot/SKILL.md',
  // wp22 (2026-09-24, owner directive "alles standaard aan"): the GENERAL settings.json merge tool (every
  // hooks.<event>[] + permissions.deny, not just the 2 snapshot hooks forge-snapshot-settings.cjs covers) —
  // called by forge-sync.cjs's own syncProjectSettings() and by install.sh/install.ps1. Already covered by
  // SYSTEM_GLOB below (forge-bin/*.cjs) — pinned here explicitly too anyway (same belt-and-suspenders
  // discipline as every prior wave's precedent above).
  'forge-bin/forge-settings-merge.cjs', 'forge-bin/forge-settings-merge.test.cjs',
  // wp-f2 (2026-09-24, Codex re-check forge-2026-09-24-codex-fixes): the containment/symlink guards,
  // duplicate-key/unsafe-number JSON round-trip scanner, and exclusive-create recovery-file writer extracted
  // out of forge-settings-merge.cjs so that file stays under the project's file-size guidance. No dedicated
  // test file of its own — exercised via forge-settings-merge.test.cjs. Already covered by SYSTEM_GLOB below
  // (forge-bin/*.cjs) — pinned here explicitly too anyway (same belt-and-suspenders discipline).
  'forge-bin/forge-settings-merge-guards.cjs',
  // wp-f3 (2026-09-24, Codex re-check, same run): forge-config.cjs's once/lock machinery split into its own
  // sibling so any consumer that copies forge-config.cjs standalone (e.g. a hook that vendors just that one
  // file) copies this too. No dedicated test file of its own yet. Already covered by SYSTEM_GLOB below —
  // pinned here explicitly too anyway.
  'forge-bin/forge-config-once.cjs',
  // wp-f1 (2026-09-24, Codex re-check, same run): a gate-hook command-line scratch/lexer helper. No dedicated
  // test file of its own yet. Already covered by SYSTEM_GLOB below — pinned here explicitly too anyway.
  'forge-bin/forge-gate-scratch.cjs',
  // wp-f4 (2026-09-24, Codex re-check, same run): usage-guard's own redaction helper (keeps secret-shaped
  // values out of logged/printed usage-guard output). Already covered by SYSTEM_GLOB below — pinned here
  // explicitly too anyway.
  'forge-bin/usage-guard-redact.cjs', 'forge-bin/usage-guard-redact.test.cjs',
  // wave 2 of the same Codex re-check (2026-09-24, verification pass p7): wp-g3 added a dedicated test for the
  // once/lock machinery (V09 ownership proofs); wp-g5 extracted the shared negative-proof predicate
  // (isDisprovenEvent, V23) into forge-proof-gate.cjs so runcontract/verify/finalize/log-event all reject a
  // disproven event through ONE gate; wp-g4 split usage-guard's state/lock layer (V15) into usage-guard-state.cjs.
  // All three are already covered by SYSTEM_GLOB below — pinned here explicitly too anyway.
  'forge-bin/forge-config-once.test.cjs', 'forge-bin/forge-proof-gate.cjs', 'forge-bin/usage-guard-state.cjs',
  // wave 3 (same re-check, verification pass p8): wp-h2 gave the state/lock layer its own dedicated test
  // (V15 fenced lock protocol, stale-reclaim schedules). Already covered by SYSTEM_GLOB below — pinned too.
  'forge-bin/usage-guard-state.test.cjs',
  // wave 3, wp-h1: the command-position helper (opener stripping, later case arms / PowerShell branches, escaped
  // substitution context) split out of forge-actiongate.cjs to keep it under 500 lines. SYSTEM_GLOB-covered — pinned too.
  'forge-bin/forge-actiongate-position.cjs',
  // wave 5, wp-j1 (Codex p10): the ONE shared quote/heredoc scanner (scanQuotes with a termination guard,
  // stripHeredocs, cArgLiveAfterFlag) every gate consumer reads from with original offsets — the root-cause fix
  // for the N02/N04/N05 regressions. forge-gate-data.cjs and forge-actiongate-position.cjs require it, so it must
  // ship alongside them. SYSTEM_GLOB-covered — pinned too.
  'forge-bin/forge-gate-quotes.cjs',
  // wave 5, wp-j2 (Codex p10, V15 defense in depth): the override decision is derived every tick from the
  // authoritative owner-grant record (forge-ownergrant.cjs) instead of the state file's cached flag; the small
  // decision module + its test ship with usage-guard.cjs, which requires it. SYSTEM_GLOB-covered — pinned too.
  'forge-bin/usage-guard-override.cjs', 'forge-bin/usage-guard-override.test.cjs',
  // wave 6, wp-k1 (Codex p11 V09): the exactly-once pending -> consumed store for --once approvals (one atomic
  // rename; independent of the config lock). forge-config.cjs requires it. SYSTEM_GLOB-covered — pinned too.
  'forge-bin/forge-config-once-store.cjs',
  // wp-v1 (2026-09-25, wave 13, run forge-2026-09-24-codex-fixes, security probe secl17-m1): the worker_threads
  // watchdog that bounds forge-gate-hook.cjs's classify() step to a hard wall-clock ceiling (opaque-exec's
  // pattern_line was measured super-linear on adversarial dense-pipe input, ~52s/190kB on master — DEADLINE_MS
  // alone could never stop it since it is only checked AFTER classify() returns). forge-gate-hook.cjs requires
  // both; an installed project without them silently loses the timeout guarantee, keeping only the pre-existing
  // (insufficient) post-hoc deadline check. SYSTEM_GLOB-covered (forge-bin/*.cjs) — pinned here explicitly too
  // anyway (same belt-and-suspenders discipline as forge-gate-quotes.cjs above).
  'forge-bin/forge-gate-watchdog.cjs', 'forge-bin/forge-gate-classify-worker.cjs',
  // wp-v3 (2026-09-25, wave 13, run forge-2026-09-24-codex-fixes, sec-v1r-H1/L2): the WHOLE inspection pipeline
  // (stripInertData/selfDisable/classify/destructive-delete-recheck/scratchPassThrough) now lives in ONE shared
  // function both the worker and forge-gate-hook.cjs's own fallback call — sec-v1r-H1 found stripInertData()
  // running unbounded on the main thread, entirely outside the wp-v1/v2 watchdog's reach. forge-gate-hook.cjs
  // and forge-gate-classify-worker.cjs both require these three; an installed project without them cannot load
  // the hook at all (unlike the optional DATA/SCRATCH/WATCHDOG modules, these are unconditional requires).
  // SYSTEM_GLOB-covered (forge-bin/*.cjs) — pinned here explicitly too anyway (same belt-and-suspenders
  // discipline as forge-gate-quotes.cjs/forge-gate-watchdog.cjs above).
  'forge-bin/forge-gate-inspect.cjs', 'forge-bin/forge-gate-selfdisable.cjs', 'forge-bin/forge-gate-messages.cjs',
  // wp-disclosure-ab (2026-07-31): forge-doctor.cjs's skill_hygiene advisory check (backlog item 12) +
  // the forge-skill-testing skill (backlog item 8 — activation-test/A/B protocol, step 2 after
  // forge-skill-evals.cjs's binary evals). forge-doctor.cjs/forge-doctor.test.cjs are already covered by
  // SYSTEM_GLOB above; skills/**/SKILL.md is NOT glob-covered (same precedent as every prior wave's SKILL.md
  // entry above), so it needs its own explicit entry. Mirrors the EXISTING precedent for every other
  // wp-skill-evals skill above: only SKILL.md is registered here, not its sibling evals.json/learnings.md/
  // references/*.md — those were never registered for forge-code-review/forge-intake/forge-router/
  // forge-snapshot/forge-verify's own self-improvement files either.
  'skills/forge-skill-testing/SKILL.md',
  // forge-tool-index (2026-07-31, mining-ronde-1 §1): the cross-run event search index that answers "has this
  // already been tried?" — node:sqlite FTS5 with an always-canonical JSONL keyword fallback. Both files live
  // in forge-bin/ and are therefore already covered by SYSTEM_GLOB below; pinned here explicitly too anyway
  // (same belt-and-suspenders discipline as every prior wave's precedent above). Introduces the
  // `rejected_approach` event type, registered in log-event.cjs (KNOWN_EVENT_TYPES + PROOF_EVENTS),
  // forge-verify.cjs (TERMINAL_TYPES) and forge-dashboard/app.js (taskStatus done-list + SYNTH) per the
  // 3-places discipline. Its DERIVED store `.claude/forge-index/` is real per-project data, not a template
  // file, so it is deliberately NOT pinned here (same convention as forge-audit's/docdrift's own ledgers) —
  // it is gitignored instead.
  'forge-bin/forge-tool-index.cjs', 'forge-bin/forge-tool-index.test.cjs',
  // install-deadlock fix (2026-08-03): maand-sweep.cmd itself is SYSTEM_GLOB-covered (.cmd), but its prompt
  // payload is .txt — outside the glob's extension list — and forge-run-budget.test.cjs asserts the wrapper's
  // presence in EVERY installed project; a wrapper without its prompt is a guaranteed runtime failure. The
  // wrapper was previously missing from the template entirely (the test shipped, the file didn't — the exact
  // ship-gap class the 2026-07-26 lesson recorded), which made every fresh install's validation red.
  'forge-bin/maand-sweep-prompt.txt',
  // context-budget (2026-08-01): the always-loaded instruction-surface meter wired into forge-doctor.cjs as
  // the `context_budget` advisory. Both files live in forge-bin/ and are therefore already covered by
  // SYSTEM_GLOB below; pinned here explicitly too anyway (same belt-and-suspenders discipline as every prior
  // wave's precedent above). Its config `config/orchestration/FORGE_CONTEXT_BUDGET.json` is deliberately NOT
  // pinned, breaking from the docdrift/hard-gates precedent for a specific reason: that file's `baseline`
  // block is a MEASUREMENT of one particular project's own CLAUDE.md and skill catalog, so syncing it would
  // hand every other project a baseline taken from this one — the meter would then report growth that is
  // really just a different project. Each project records its own with `--write-baseline` (a missing config
  // degrades to an honest "no baseline recorded yet", never an error). Same "real per-project data, not a
  // template file" convention as forge-audit's and forge-tool-index's own stores above. Introduces NO new
  // log-event.cjs event type — the meter is read-only and never logs.
  'forge-bin/forge-contextbudget.cjs', 'forge-bin/forge-contextbudget.test.cjs',
  // config-drift (2026-08-01): the run-scoped governance-config baseline + two-direction drift check
  // (an undeclared change to the rules a run is judged by · a claimed change whose before == after). Both
  // files live in forge-bin/ and are therefore already covered by SYSTEM_GLOB below; pinned here explicitly
  // too anyway (same belt-and-suspenders discipline as every prior wave above). Its OUTPUT,
  // `forge-runs/<run_id>/config-baseline.json`, is deliberately NOT pinned: it is a measurement of one
  // particular run in one particular project, so syncing it would hand another project a baseline taken from
  // this one — the same "real per-project data, not a template file" reason FORGE_CONTEXT_BUDGET.json is left
  // out above. Introduces NO new log-event.cjs event type: it MATCHES on already-registered announcement
  // events (file_changed / claude_md_* / custom_skill_* / decision_logged) and logs nothing itself.
  'forge-bin/forge-configdrift.cjs', 'forge-bin/forge-configdrift.test.cjs',
  // task-contract failure side (2026-08-01): the suite proving `failure_conditions` (gates, like a dropped
  // acceptance criterion), `non_goals` (advisory scope check), `on_stuck` + `requires_inputs` (the dispatch
  // brief) and `result_caveat` (the report). It has no module of its own — the fields live in the existing
  // forge-prd.cjs / forge-report.cjs / forge-verify.cjs, all three already covered by SYSTEM_GLOB — so only
  // the test file is pinned. Introduces NO new event type: a hit failure condition reuses the SAME registered
  // lead_review_completed / rework_task_created / rework_assigned trio an acceptance gap already uses.
  'forge-bin/forge-taskcontract.test.cjs',
  // gate-isolation matrix (2026-08-01): the suite that pins ONE isolating scenario per forge-verify exit-code
  // gate — a run in which that gate is the only non-zero counter — and enforces the mapping in both
  // directions against the exported EXIT_GATES list (a new gate without a scenario, or a deleted gate, is a
  // red test). Added after an independent witness deleted a whole gate from the exit code with the entire
  // suite staying green. It has no module of its own (the gate set lives in forge-verify.cjs, already
  // SYSTEM_GLOB-covered), so only the test file is pinned. Introduces NO new event type — it never logs.
  'forge-bin/forge-verify-gates.test.cjs',
  // v2.7.0 settings (2026-09-24): the ONE catalogue forge-config.cjs resolves (the .cjs is SYSTEM_GLOB-covered,
  // config/orchestration/ is not); the owner's own values in FORGE_CONFIG.json are PROTECTed below, never synced.
  'config/orchestration/FORGE_CONFIG_SCHEMA.json',
  // vendored public skills, 2026-09-24 — see skills/VENDORED-SKILLS.md; pinned by test (forge-sync.test.cjs section 71
  // derives the shipped set from that file, so a newly vendored skill with an unpinned file turns red, naming the path).
  'skills/brainstorming/LICENSE', 'skills/brainstorming/SKILL.md',
  'skills/brainstorming/spec-document-reviewer-prompt.md',
  'skills/dispatching-parallel-agents/LICENSE', 'skills/dispatching-parallel-agents/SKILL.md',
  'skills/executing-plans/LICENSE', 'skills/executing-plans/SKILL.md', 'skills/executing-plans/scripts/task-done',
  'skills/executing-plans/scripts/task-start',
  'skills/finishing-a-development-branch/LICENSE', 'skills/finishing-a-development-branch/SKILL.md',
  'skills/frontend-design/LICENSE.txt', 'skills/frontend-design/SKILL.md',
  'skills/receiving-code-review/LICENSE', 'skills/receiving-code-review/SKILL.md',
  'skills/requesting-code-review/LICENSE', 'skills/requesting-code-review/SKILL.md',
  'skills/requesting-code-review/code-reviewer.md',
  'skills/subagent-driven-development/LICENSE', 'skills/subagent-driven-development/SKILL.md',
  'skills/subagent-driven-development/implementer-prompt.md',
  'skills/subagent-driven-development/re-review-prompt.md',
  'skills/subagent-driven-development/scripts/review-package',
  'skills/subagent-driven-development/scripts/sdd-workspace', 'skills/subagent-driven-development/scripts/task-brief',
  'skills/subagent-driven-development/task-reviewer-prompt.md',
  'skills/systematic-debugging/CREATION-LOG.md', 'skills/systematic-debugging/LICENSE',
  'skills/systematic-debugging/SKILL.md', 'skills/systematic-debugging/condition-based-waiting-example.ts',
  'skills/systematic-debugging/condition-based-waiting.md', 'skills/systematic-debugging/defense-in-depth.md',
  'skills/systematic-debugging/find-polluter.sh', 'skills/systematic-debugging/root-cause-tracing.md',
  'skills/systematic-debugging/test-academic.md', 'skills/systematic-debugging/test-pressure-1.md',
  'skills/systematic-debugging/test-pressure-2.md', 'skills/systematic-debugging/test-pressure-3.md',
  'skills/test-driven-development/LICENSE', 'skills/test-driven-development/SKILL.md',
  'skills/test-driven-development/writing-good-tests.md',
  'skills/using-git-worktrees/LICENSE', 'skills/using-git-worktrees/SKILL.md',
  'skills/verification-before-completion/LICENSE', 'skills/verification-before-completion/SKILL.md',
  'skills/writing-plans/LICENSE', 'skills/writing-plans/SKILL.md',
  'skills/writing-plans/plan-document-reviewer-prompt.md',
  'skills/writing-skills/LICENSE', 'skills/writing-skills/SKILL.md',
  'skills/writing-skills/anthropic-best-practices.md', 'skills/writing-skills/examples/CLAUDE_MD_TESTING.md',
  'skills/writing-skills/graphviz-conventions.dot', 'skills/writing-skills/persuasion-principles.md',
  'skills/writing-skills/render-graphs.js', 'skills/writing-skills/testing-skills-with-subagents.md',
  'skills/VENDORED-SKILLS.md',
  // vendored public skills ronde 2 (wp6b, 2026-09-24) — see skills/VENDORED-SKILLS.md "Meegeleverd — ronde 2"
  // (7 skills + 2 commands, mattpocock/skills + anthropics/claude-plugins-official). Pinned by the same
  // section-71 test (forge-sync.test.cjs), now extended (wp5) to scan BOTH "Meegeleverd" sections of that doc
  // instead of only the first.
  'skills/grill-me/LICENSE', 'skills/grill-me/SKILL.md',
  'skills/grilling/LICENSE', 'skills/grilling/SKILL.md',
  'skills/teach/GLOSSARY-FORMAT.md', 'skills/teach/LEARNING-RECORD-FORMAT.md', 'skills/teach/LICENSE',
  'skills/teach/MISSION-FORMAT.md', 'skills/teach/RESOURCES-FORMAT.md', 'skills/teach/SKILL.md',
  'skills/wait-what/LICENSE', 'skills/wait-what/SKILL.md',
  'skills/resolving-merge-conflicts/LICENSE', 'skills/resolving-merge-conflicts/SKILL.md',
  'skills/setup-pre-commit/LICENSE', 'skills/setup-pre-commit/SKILL.md',
  'skills/claude-md-improver/LICENSE.txt', 'skills/claude-md-improver/SKILL.md',
  'skills/claude-md-improver/references/quality-criteria.md', 'skills/claude-md-improver/references/templates.md',
  'skills/claude-md-improver/references/update-guidelines.md',
  // the two vendored commands (wp6b) — commands/ carries no SYSTEM_GLOB (only forge-bin/forge-dashboard/
  // agents are globbed — see the SYSTEM_GLOB block below); only commands/forge.md was pinned before this wave.
  'commands/commit.md', 'commands/revise-claude-md.md',
  // forge-prompt-coach (wp13b, Forge-native — NOT part of the VENDORED-SKILLS.md scan above, which covers only
  // third-party content). skills/**/SKILL.md is never glob-covered (same precedent as every other skill entry
  // in this list), so its SKILL.md + references need an explicit pin too.
  'skills/forge-prompt-coach/SKILL.md', 'skills/forge-prompt-coach/references/before-after.md',
  'skills/forge-prompt-coach/references/failure-modes.md', 'skills/forge-prompt-coach/references/HOW-TO-ASK.md',
  // wp-l4 (2026-09-24, loop iteration 4) — the unsafe-advice register (video-said/why-unsafe/Forge-instead)
  'skills/forge-prompt-coach/references/unsafe-advice.md',
];
const SYSTEM_GLOB = [ // whole-dir system files by extension (kept fresh), minus the protected names below
  { dir: 'forge-bin', ext: ['.cjs', '.ps1', '.cmd', '.sh', '.md', '.bat'] },
  { dir: 'forge-dashboard', ext: ['.js', '.cjs', '.html', '.css', '.bat', '.md'] },
  { dir: 'agents', ext: ['.md'] },
];
const PROTECT = new Set([ // NEVER overwrite these project-local files even inside a system dir
  'forge-dashboard/PORT', 'forge-dashboard/DASHBOARD_STATE.json',
  'FORGE_CONFIG.json', // v2.7.0: the owner's own settings written by forge-config.cjs set — user-owned, never a template file
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'graphify-out']);
const CANARY_DIR_NAME = '.forge-canary'; // dot-prefixed -> structurally excluded from findForgeProjects discovery
// M9: extensions treated as text for EOL-only classification (raw bytes ALWAYS backed up/copied/restored —
// normalization below is for CLASSIFICATION ONLY, never for the actual bytes on disk).
const TEXT_EXTS_FOR_EOL = new Set(['.md', '.json', '.cjs', '.js', '.css', '.html', '.ps1', '.sh', '.txt']);

function listSystemFiles(templateDir) {
  const files = new Set(SYSTEM);
  for (const g of SYSTEM_GLOB) {
    const d = path.join(templateDir, g.dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const rel = g.dir + '/' + f;
      if (g.ext.includes(path.extname(f)) && !PROTECT.has(rel)) files.add(rel);
    }
  }
  return [...files];
}
function sha256(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } }
function sha256Str(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
// M9: normalized (CRLF/CR -> LF) hash, used ONLY to classify a raw-byte difference as "eol_only" — never used
// for the actual copy/backup/restore, which always operate on raw bytes.
/** normalizeEolBuffer — S7 FIX: normalize CRLF/CR -> LF on the raw BYTE buffer, never on a decoded string.
 *  The old code called `.toString('utf8')` before normalizing — that decode is LOSSY: any invalid/non-UTF8
 *  byte sequence gets replaced with the SAME U+FFFD replacement character, so two files holding genuinely
 *  DIFFERENT invalid byte sequences (e.g. two different binary corruptions) can decode to an IDENTICAL
 *  normalized string -> identical normalized hash -> a real drift gets misclassified as eol_only and bypasses
 *  the drift gate entirely. Operating byte-for-byte avoids any decode step, so only genuine \r/\r\n bytes are
 *  ever touched; every other byte (valid or not) passes through unchanged. */
function normalizeEolBuffer(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0d) { // CR
      out[j++] = 0x0a; // normalize CR and CRLF alike to a single LF
      if (buf[i + 1] === 0x0a) i++; // consume the paired LF of a CRLF pair
    } else {
      out[j++] = b;
    }
  }
  return out.subarray(0, j);
}
function sha256Normalized(p) {
  try {
    return crypto.createHash('sha256').update(normalizeEolBuffer(fs.readFileSync(p))).digest('hex');
  } catch { return null; }
}
/** fileStatus — B3: distinguishes MISSING (legitimately "new" -> safe to write) from UNREADABLE (exists but
 *  can't be read — permission/lock/exotic error, or a directory sitting where a file is expected). An
 *  unreadable file must never be silently treated as "new" (which would skip backing it up and then delete
 *  it on rollback). */
function fileStatus(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return e && e.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error: e.message }; }
  if (st.isDirectory()) return { kind: 'unreadable', error: 'is a directory, not a file' };
  if (!st.isFile()) return { kind: 'unreadable', error: 'not a regular file' };
  try { return { kind: 'ok', hash: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }; }
  catch (e) { return { kind: 'unreadable', error: e.message }; }
}
function templateVersion(templateDir) { // deterministic hash of all system files -> the "version"
  const h = crypto.createHash('sha256');
  for (const rel of listSystemFiles(templateDir).sort()) h.update(rel + ':' + (sha256(path.join(templateDir, rel)) || '-'));
  return h.digest('hex').slice(0, 12);
}
function claudeDirOf(projectDir) { return path.join(projectDir, '.claude'); }

// ---- containment / symlink guards (never write outside a project's .claude/, never follow a symlink) ----
function safeJoin(baseDir, relPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relPath);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}
function isSymlinkPath(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
/** containmentSafe — M6: a leaf-only symlink check misses a symlinked/junctioned INTERMEDIATE directory
 *  (e.g. .claude/forge-bin itself replaced with a junction pointing outside .claude). Resolves the REAL path
 *  of the longest existing ancestor (a not-yet-existing leaf can't itself be a reparse point) and confirms
 *  the resolved path still lives under the resolved base. */
/** realpathViaExistingAncestor — the REAL path of `p` even when `p` does not exist yet: resolve the longest
 *  existing ancestor and re-append the missing tail. Both sides of a containment comparison MUST go through this
 *  same function. Measured on the GitHub windows runner (2026-09-24): its TEMP is an 8.3 short path
 *  (`C:\Users\RUNNER~1\…`). The old code realpath'd the target's ancestor (long form, `…\runneradmin\…`) but fell
 *  back to `path.resolve()` (short form) for a base that did not exist yet — the dedicated canary's `.claude/` on a
 *  dry run — so every file "escaped" its own base and the canary plan was empty. */
function realpathViaExistingAncestor(p) {
  let existing = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let real;
  try { real = fs.realpathSync.native(existing); } catch { real = existing; }
  return tail.length ? path.join(real, ...tail) : real;
}
function containmentSafe(baseDir, targetPath) {
  const realBase = realpathViaExistingAncestor(baseDir);
  const realTarget = realpathViaExistingAncestor(targetPath);
  return realTarget === realBase || realTarget.startsWith(realBase + path.sep);
}

function projectId(projectDir) {
  const abs = path.resolve(projectDir);
  return path.basename(abs) + '-' + sha256Str(abs).slice(0, 8);
}

// ---- receipt (records what THIS tool last wrote, so drift can be told apart from a hand-edit) ----
function receiptPath(projectDir) { return path.join(claudeDirOf(projectDir), 'forge-sync-receipt.json'); }
function readReceipt(projectDir) { try { return JSON.parse(fs.readFileSync(receiptPath(projectDir), 'utf8')); } catch { return null; } }
function readRawReceipt(projectDir) { // B2: raw bytes (for byte-exact backup/restore, mirrors readVersionFile)
  try { return { exists: true, content: fs.readFileSync(receiptPath(projectDir), 'utf8') }; } catch { return { exists: false, content: null }; }
}
/** writeAtomic — temp file in the same directory + rename (broad Codex audit #22, 2026-08-05).
 *  The version stamp and the receipt were two separate in-place writes AFTER validation, outside any
 *  rollback protection: a crash or a full disk between them left an install whose files and version say
 *  "synced" while the receipt — the thing every later drift/rollback decision reads — was absent or
 *  half-written. Rename within one filesystem is atomic on both Windows and POSIX, so a reader sees
 *  either the whole previous file or the whole new one, never a torn one. */
function writeAtomic(file, contents) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}
function writeReceipt(projectDir, receipt) { writeAtomic(receiptPath(projectDir), JSON.stringify(receipt, null, 2) + '\n'); }
/** copyNoFollow — schrijf src-bytes naar out ZONDER ooit door een symlink/junction op de eindcomponent te
 *  kunnen schrijven (uitgesteld punt 3, gesloten 2026-08-06). fs.copyFileSync VOLGT links, en tussen de
 *  lstat-guard en de copy zat een TOCTOU-venster. Op Windows bestaat O_NOFOLLOW niet in Node (gemeten:
 *  fs.constants.O_NOFOLLOW === undefined), maar dit sluit het leaf-venster per constructie: de bytes gaan
 *  eerst naar een VERSE tempnaam in dezelfde directory, geopend met 'wx' (CREATE_NEW faalt op elke
 *  bestaande naam — ook een link, want de naam bestaat dan); daarna vervangt renameSync de eindcomponent
 *  ZELF in plaats van er doorheen te schrijven. Vlak voor de rename wordt de parent-directory nogmaals
 *  realpath-gecontroleerd tegen de containment-basis: een junction die intussen op een TUSSENliggende
 *  directory verscheen wordt zo ook gevangen (volledig sluiten van dat pad zou openat-semantiek vergen
 *  die Node niet biedt — dat restrisico blijft benoemd, niet verstopt). */
/** copyNoFollow (r4 #18, 2026-08-07): de containment-check kwam NA het vullen van de temp — was de parent
 *  al een junction naar buiten, dan stonden de bytes al buiten het project toen de check ze ontdekte (en
 *  een crash in dat venster liet ze daar staan). Nu: (1) resolve en verifieer de parent VOOR er ook maar
 *  een byte wordt geschreven; (2) schrijf temp en doel op basis van het GERESOLVEDE parent-realpath —
 *  een junction-swap na de check verlegt onze writes dan niet meer (wij houden het opgeloste pad vast);
 *  (3) her-verifieer na het stagen en rename dan. Het restvenster is daarmee gereduceerd tot een swap
 *  tussen de allereerste resolve en de open van de temp — en zelfs dan landen de bytes op het OUDE,
 *  geverifieerde echte pad, nooit door de nieuwe junction heen. */
function copyNoFollow(src, out, baseDir) {
  const data = fs.readFileSync(src);
  let realParent = null, realBase = null;
  if (baseDir) {
    try { realParent = fs.realpathSync.native(path.dirname(out)); } catch (e) { throw new Error('containment pre-check failed for ' + out + ': ' + e.message); }
    try { realBase = fs.realpathSync.native(baseDir); } catch { realBase = path.resolve(baseDir); }
    if (realParent !== realBase && !realParent.startsWith(realBase + path.sep)) {
      throw new Error('containment guard tripped BEFORE staging: parent of ' + out + ' resolves outside ' + baseDir + ' — no bytes written');
    }
  }
  // schrijf via het geresolvede parent-pad: een junction-swap na de pre-check raakt onze writes niet meer
  const outReal = realParent ? path.join(realParent, path.basename(out)) : out;
  const tmp = outReal + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, data);
    fs.closeSync(fd); fd = null;
    if (baseDir) {
      // her-verificatie na het stagen (defense-in-depth): het opgeloste parent-pad moet nog steeds
      // hetzelfde echte pad zijn en binnen de basis liggen.
      let realParent2;
      try { realParent2 = fs.realpathSync.native(path.dirname(outReal)); } catch (e) { throw new Error('containment re-check failed for ' + out + ': ' + e.message); }
      if (realParent2 !== realParent) throw new Error('containment guard tripped at copy time: parent of ' + out + ' changed identity during staging');
    }
    fs.renameSync(tmp, outReal);
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch { } }
    try { fs.unlinkSync(tmp); } catch { }
    throw e;
  }
}
/** receiptLastTemplateHashMap — B1: prefer the CUMULATIVE receipt.knownHashes (every system file's
 *  last-known-good hash, carried forward across every sync) over the old filesChanged-only map, which
 *  ERASED the baseline for any file that wasn't touched in the MOST RECENT sync (a same-since-last-sync file
 *  never appears in filesChanged, so its baseline vanished the moment any OTHER file changed — from the 3rd
 *  template version onward this falsely declared untouched files "drifted"). Falls back to the legacy
 *  filesChanged-derived map for a receipt written before this fix. */
function receiptLastTemplateHashMap(receipt) {
  if (receipt && receipt.knownHashes && typeof receipt.knownHashes === 'object') return Object.assign({}, receipt.knownHashes);
  const map = {};
  if (receipt && Array.isArray(receipt.filesChanged)) for (const f of receipt.filesChanged) if (f && f.rel) map[f.rel] = f.newHash;
  return map;
}

// ---- project-declared "I own this file on purpose" allow-list ----
function overridesAllowlistPath(projectDir) { return path.join(claudeDirOf(projectDir), 'config', 'forge-overrides.json'); }
function readOverrideAllowlist(projectDir) {
  try { const obj = JSON.parse(fs.readFileSync(overridesAllowlistPath(projectDir), 'utf8')); return new Set(Array.isArray(obj.overrides) ? obj.overrides : []); }
  catch { return new Set(); }
}

// ---- v2.7-era owner-standing-rule preflight migration (external-audit 3.4, LOW) ----
const STANDING_RULES_REL = 'config/orchestration/FORGE_STANDING_RULES.json';
const STANDING_RULES_USER_REL = 'config/orchestration/FORGE_STANDING_RULES.user.json';
const STANDING_OWNER_REMEMBER_SOURCE = 'owner /forge remember';

/** migrateOwnerStandingRules(projectDir) — 3.4 fix: before v2.8.0's template/user split
 *  (forge-standing.cjs, N4/P1), an owner "/forge remember" wrote its new rule straight into the SYSTEM
 *  (template-synced) FORGE_STANDING_RULES.json. That file is compared/replaced on every install/sync-all —
 *  including a --force-overwrite of an unresolved conflict — so upgrading a v2.7-era project either (a)
 *  looks unchanged-since-last-receipt and gets silently overwritten by the new, rule-free template, or (b)
 *  looks like drift/conflict and gets replaced the moment --force-overwrite runs, in both cases BEFORE
 *  forge-standing.cjs's own load()-time migration ever gets a chance to run against the old content. This
 *  runs as a preflight step, called at the very top of every real write path (safeSyncProject, rawInstall)
 *  BEFORE that file is ever compared or replaced: it reads the project's CURRENT on-disk copy, and MOVES
 *  (never duplicates — checked by id) every rule whose source is exactly STANDING_OWNER_REMEMBER_SOURCE
 *  into that project's own FORGE_STANDING_RULES.user.json — a file this SYSTEM list deliberately never
 *  syncs/overwrites (see the comment next to 'FORGE_STANDING_RULES.json' in SYSTEM above). It never rewrites
 *  the template copy itself here (the imminent sync/replace does that; forge-standing.cjs's own load()-time
 *  migration cleans up a leftover copy on any run that does not proceed to replace it) — no duplication risk
 *  either way, since re-migration is id-checked. Best-effort and silently a no-op when the project has no
 *  such file yet, the file is unreadable/malformed, or there is nothing to migrate — this is a safety net
 *  for an old install shape, never a hard requirement for a project that never had the file. Returns the
 *  migrated rule ids (possibly empty) so a caller can log/report it. */
/** N8 fix (2026-09-26 independent review, LOW) — before this fix, ANY user-file read/parse/shape problem
 *  (not just "the file does not exist yet") fell into the same `catch { userDoc = { version: 1, rules: [] } }`
 *  as a genuinely fresh install, so a MALFORMED-but-PRESENT FORGE_STANDING_RULES.user.json (bad JSON, no
 *  "rules" array) got silently REPLACED with just the migrated rules — no backup, the owner's existing
 *  (if broken) content gone — exactly the case forge-standing.cjs's own load()-time migration deliberately
 *  refuses to touch. This starts from an empty doc ONLY on a confirmed ENOENT; any OTHER read/parse/shape
 *  failure now warns ONCE and skips the migration entirely (nothing written, template copy left as-is —
 *  it gets another chance on a later sync once the owner fixes or removes the file). The write itself now
 *  goes through the same safeJoin/isSymlinkPath/containmentSafe guards every other forge-sync write uses,
 *  and forge-sync's own writeAtomic() instead of a plain writeFileSync — this file is written outside the
 *  normal preflight/apply pipeline (it runs BEFORE that pipeline, see the doc comment above), so it never
 *  inherited those guards for free. A `null`/non-object entry in either rules array is skipped when
 *  computing ids instead of throwing (`r.id` on `null` used to crash the whole sync); it is left in place,
 *  untouched, in whatever gets written — never silently dropped.
 *
 *  F4 fix (2026-09-26 independent review, LOW): every early-return below used to be a bare `[]`, so a
 *  caller could not tell "nothing to migrate" apart from "there IS an owner rule, but this pass could not
 *  move it (unreadable/malformed/refused user file, or a write failure)" — under --force-overwrite (or the
 *  rawInstall/--unsafe path, which has no drift/conflict analysis at all), the caller went ahead and
 *  replaced the template file anyway, permanently dropping the never-migrated owner rule. The returned
 *  array's CONTENTS are unchanged (still `[]` on every failure path, for exact backward compatibility with
 *  every existing caller/test that only reads `.length`/`.includes(...)`); a non-enumerable-looking but
 *  perfectly normal own property, `.pending`, is attached to that same array — `true` whenever the template
 *  holds an owner rule that this call did NOT confirm is now safely represented in the user file, `false`
 *  otherwise (including "nothing to migrate" and "already migrated"). Callers (safeSyncProject, rawInstall)
 *  check `.pending` and skip replacing FORGE_STANDING_RULES.json for this pass when it is true. */
function migrateOwnerStandingRules(projectDir) {
  const dst = claudeDirOf(projectDir);
  const templatePath = path.join(dst, STANDING_RULES_REL);
  const userPath = path.join(dst, STANDING_RULES_USER_REL);
  const done = (ids, pending) => { ids.pending = !!pending; return ids; };

  let templateDoc;
  try { templateDoc = JSON.parse(fs.readFileSync(templatePath, 'utf8')); }
  catch { return done([], false); } // no file yet, or unreadable/corrupt — nothing this safety net can act on
  if (!templateDoc || !Array.isArray(templateDoc.rules)) return done([], false);

  const toMigrate = templateDoc.rules.filter((r) => r && typeof r === 'object' && r.source === STANDING_OWNER_REMEMBER_SOURCE);
  if (toMigrate.length === 0) return done([], false);

  let userDoc;
  let userRaw;
  try {
    userRaw = fs.readFileSync(userPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      userDoc = { version: 1, rules: [] }; // genuinely fresh — no owner file yet, safe to start empty
    } else {
      console.error('forge-sync: WARNING — could not read ' + userPath + ' while migrating owner rule(s) out of ' +
        templatePath + ' (' + e.message + '); skipping this migration pass, nothing written — fix or remove ' +
        'that file to let it complete on a later sync');
      return done([], true);
    }
  }
  if (userRaw !== undefined) {
    try {
      userDoc = JSON.parse(userRaw);
    } catch (e) {
      console.error('forge-sync: WARNING — ' + userPath + ' is not valid JSON; skipping this migration pass, ' +
        'nothing written (' + e.message + ')');
      return done([], true);
    }
    if (!userDoc || typeof userDoc !== 'object' || !Array.isArray(userDoc.rules)) {
      console.error('forge-sync: WARNING — ' + userPath + ' is present but missing a "rules" array; skipping ' +
        'this migration pass, nothing written — the existing (malformed) file is left exactly as-is');
      return done([], true);
    }
  }

  const existingIds = new Set(userDoc.rules.filter((r) => r && typeof r === 'object').map((r) => r.id));
  const toAppend = toMigrate.filter((r) => !existingIds.has(r.id));
  const migratedIds = toMigrate.map((r) => r.id);
  if (toAppend.length === 0) return done(migratedIds, false); // already migrated on an earlier pass — nothing new to write

  const nextUserDoc = Object.assign({}, userDoc, { rules: userDoc.rules.concat(toAppend) });

  const safeUserPath = safeJoin(dst, STANDING_RULES_USER_REL);
  if (safeUserPath == null || path.resolve(safeUserPath) !== path.resolve(userPath)) {
    console.error('forge-sync: WARNING — refusing to migrate owner rule(s): ' + userPath + ' does not resolve to a safe path under .claude/');
    return done([], true);
  }
  if (isSymlinkPath(userPath)) {
    console.error('forge-sync: WARNING — refusing to migrate owner rule(s): ' + userPath + ' is a symlink');
    return done([], true);
  }
  if (!containmentSafe(dst, userPath)) {
    console.error('forge-sync: WARNING — refusing to migrate owner rule(s): ' + userPath + ' escapes .claude/ via a symlinked/junctioned ancestor directory');
    return done([], true);
  }

  try {
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    writeAtomic(userPath, JSON.stringify(nextUserDoc, null, 2) + '\n');
  } catch (e) {
    // Best-effort, same posture as forge-standing.cjs's own migration: a write failure here never blocks
    // the sync — the owner rule simply stays visible in the (about to be replaced) template copy for this
    // pass, and gets another migration chance on a later sync or the next forge-standing.cjs load().
    console.error('forge-sync: could not write ' + userPath + ' while migrating owner rule(s) out of ' + templatePath + ' (' + e.message + ') — continuing sync');
    return done([], true);
  }
  return done(migratedIds, false);
}

/**
 * preflight(templateDir, projectDir) -> classify every system file into exactly one bucket:
 *   toChange            — safe to sync (unchanged since our last write, brand new, or an eol_only diff)
 *   expectedOverrides    — declared in forge-overrides.json -> NEVER touched
 *   unknownDrift          — project differs from template; template unchanged since last receipt (or no
 *                           receipt at all -> conservative default); NOT overwritten unless --force-overwrite
 *   conflicts            — BOTH project and template changed since the last receipt; NOT overwritten unless
 *                           --force-overwrite
 *   skipped               — symlink/containment-guard trip; never touched, ever
 *   unreadable            — B3: exists but could not be read; the WHOLE project sync refuses on this
 */
function preflight(templateDir, projectDir) {
  const dst = claudeDirOf(projectDir);
  const receipt = readReceipt(projectDir);
  const lastTemplateHash = receiptLastTemplateHashMap(receipt);
  const allowlist = readOverrideAllowlist(projectDir);
  const toChange = [], expectedOverrides = [], unknownDrift = [], conflicts = [], skipped = [], unreadable = [];
  let same = 0;
  for (const rel of listSystemFiles(templateDir)) {
    const src = path.join(templateDir, rel);
    if (!fs.existsSync(src)) continue;
    const out = safeJoin(dst, rel);
    if (out == null) { skipped.push({ rel, reason: 'unsafe-path' }); continue; }
    if (isSymlinkPath(out)) { skipped.push({ rel, reason: 'symlink' }); continue; }
    if (!containmentSafe(dst, out)) { skipped.push({ rel, reason: 'symlink-parent-escape' }); continue; }
    const outStatus = fileStatus(out);
    if (outStatus.kind === 'unreadable') { unreadable.push({ rel, error: outStatus.error }); continue; }
    const templateHash = sha256(src);
    const outHash = outStatus.kind === 'ok' ? outStatus.hash : null;
    if (outHash === templateHash) { same++; continue; }
    if (allowlist.has(rel)) { expectedOverrides.push(rel); continue; }
    if (outHash === null) { toChange.push({ rel, oldHash: null, newHash: templateHash, isNew: true, overrideClass: null }); continue; }
    const ext = path.extname(rel).toLowerCase();
    if (TEXT_EXTS_FOR_EOL.has(ext)) { // M9: raw bytes differ, but ONLY by line-ending style -> always safe
      const normOut = sha256Normalized(out), normSrc = sha256Normalized(src);
      if (normOut !== null && normOut === normSrc) { toChange.push({ rel, oldHash: outHash, newHash: templateHash, isNew: false, overrideClass: 'eol_only' }); continue; }
    }
    if (Object.prototype.hasOwnProperty.call(lastTemplateHash, rel)) {
      const lastTplHash = lastTemplateHash[rel];
      if (outHash === lastTplHash) { toChange.push({ rel, oldHash: outHash, newHash: templateHash, isNew: false, overrideClass: null }); continue; }
      if (templateHash === lastTplHash) { unknownDrift.push(rel); continue; }
      conflicts.push(rel); continue;
    }
    unknownDrift.push(rel); // no receipt at all yet -> can't tell drift from conflict, be conservative
  }
  return { toChange, expectedOverrides, unknownDrift, conflicts, skipped, unreadable, same };
}

function buildPlan(templateDir, projectDir, opts) {
  opts = opts || {};
  const pf = preflight(templateDir, projectDir);
  if (!opts.forceOverwrite || (pf.unknownDrift.length === 0 && pf.conflicts.length === 0)) return pf;
  const dst = claudeDirOf(projectDir);
  const forceRel = (rel, cls) => {
    const src = path.join(templateDir, rel);
    const out = safeJoin(dst, rel);
    return { rel, oldHash: sha256(out), newHash: sha256(src), isNew: false, overrideClass: cls };
  };
  const forced = pf.unknownDrift.map((rel) => forceRel(rel, 'unknown_drift')).concat(pf.conflicts.map((rel) => forceRel(rel, 'conflict')));
  return { toChange: pf.toChange.concat(forced), expectedOverrides: pf.expectedOverrides, unknownDrift: [], conflicts: [], skipped: pf.skipped, unreadable: pf.unreadable, same: pf.same };
}

/** fullFileManifest — the FULL relevant-file hash manifest (rel -> {exists,hash,mode}), used for real
 *  before/after byte-exactness proof (not just "rollback exited 0"). */
function fullFileManifest(templateDir, projectDir) {
  const dst = claudeDirOf(projectDir);
  const out = {};
  for (const rel of listSystemFiles(templateDir)) {
    const p = safeJoin(dst, rel) || path.join(dst, rel);
    let exists = false, hash = null, mode = null;
    try { const st = fs.lstatSync(p); exists = true; mode = st.mode; if (st.isFile()) hash = sha256(p); } catch { exists = false; }
    out[rel] = { exists, hash, mode };
  }
  return out;
}
function aggregateManifestHash(manifestObj) {
  const keys = Object.keys(manifestObj).sort();
  const h = crypto.createHash('sha256');
  for (const k of keys) h.update(k + ':' + (manifestObj[k].hash || '-') + ':' + manifestObj[k].exists);
  return h.digest('hex');
}

function versionFilePath(projectDir) { return path.join(claudeDirOf(projectDir), 'FORGE_VERSION.json'); }
function readVersionFile(projectDir) {
  try { return { exists: true, content: fs.readFileSync(versionFilePath(projectDir), 'utf8') }; }
  catch { return { exists: false, content: null }; }
}

function backupDirFor(projectDir, batchId) { return path.join(claudeDirOf(projectDir), 'forge-backups', batchId); }
function centralBackupDir(centralRoot, batchId, pid) { return path.join(centralRoot, '.claude', 'forge-backups', batchId, pid); }

/** defaultCentralBackupRoot(projectDir) — N10 fix (2026-09-26, external audit): `install`/`rollback` used
 *  to default the central backup hub to <parent-of-project>/.forge-backup-hub — OUTSIDE the project (on the
 *  audit's machine, literally the user's Desktop), while /forge's own promise is "only ever touches
 *  .claude/". The per-project backup (<project>/.claude/forge-backups/<batchId>/<rel>, always taken
 *  regardless of this setting) already covers the ordinary "undo my last sync" case; this SECOND, central
 *  copy is only a belt-and-braces safety net. Its default now lives INSIDE the project instead of silently
 *  reaching into whatever folder happens to be the project's parent (a folder forge-sync has no business
 *  writing to by default) — --central-backup-root still lets a caller opt back into a real cross-project
 *  hub outside the project when that is genuinely wanted (e.g. for `sync-all`/`rollback-batch`, which
 *  operate over a whole multi-project root the caller already named explicitly and are unchanged here). */
function defaultCentralBackupRoot(projectDir) {
  return path.join(path.resolve(projectDir), '.claude', 'forge-backups-central');
}

/** takeBackup — copies every about-to-change file's CURRENT bytes to the per-project backup dir (and, when
 *  centralBackupRoot is given, mirrors the same manifest+files to a central, project-independent location)
 *  BEFORE any write happens. B2: also snapshots the CURRENT forge-sync-receipt.json (raw bytes) so rollback
 *  can restore it exactly like FORGE_VERSION.json — without this, a rollback left the receipt describing a
 *  sync that was undone, causing false unknown_drift on the very next preflight. B7: each file entry now
 *  records BOTH oldHash and newHash (+existed) so rollback can tell "still what I wrote" from "changed since". */
function takeBackup(projectDir, batchId, plan, templateVer, nowIso, opts) {
  opts = opts || {};
  const dst = claudeDirOf(projectDir);
  const bdir = backupDirFor(projectDir, batchId);
  // S8 FIX: every fs write below used to be unguarded — an unwritable hub (permission denied, disk full, a
  // read-only central mount) threw an UNCAUGHT exception straight out of takeBackup, crashing the whole
  // install/sync-all process with a raw stack trace instead of the honest, clean refusal every other
  // failure mode in this tool already produces. The entire body is now one try/catch that returns
  // {ok:false, error, backupDir} on ANY I/O failure — callers must check backup.ok before proceeding to apply.
  try {
    return takeBackupUnsafe(projectDir, batchId, plan, templateVer, nowIso, opts, dst, bdir);
  } catch (e) {
    return { ok: false, error: 'failed to take backup: ' + e.message, backupDir: bdir };
  }
}
function takeBackupUnsafe(projectDir, batchId, plan, templateVer, nowIso, opts, dst, bdir) {
  fs.mkdirSync(bdir, { recursive: true });

  /** S1 FIX: a `--resume-batch` re-run calls takeBackup a SECOND time for the SAME batchId (the M3 guard that
   *  normally refuses batchId reuse is intentionally bypassed by opts.resumeBatch in safeSyncProject). The OLD
   *  code unconditionally re-copied CURRENT on-disk bytes over every already-backed-up file and recomputed its
   *  oldHash from preflight()'s plan — but after a crash mid-apply, "current on-disk" is the MIXED (half-
   *  applied) state, not the true pre-batch state. That silently clobbered the pristine backup with wrong
   *  bytes/wrong oldHash, so a later rollback of that batch restored the mixed state and reported ok. Fix:
   *  if this batch dir already has a manifest.json (a resume), reuse each already-recorded file entry AND its
   *  on-disk backup bytes VERBATIM — never re-copy, never recompute oldHash for a rel already backed up. Only
   *  a rel truly never reached by the prior attempt gets a fresh backup taken now. hadVersionFile/oldVersion/
   *  hadReceipt/oldReceipt are pinned to the FIRST attempt's recorded pre-batch values too, for the same reason. */
  let priorManifest = null;
  // CODEX ronde-3 #5 (2026-08-06): een BESTAAND maar onparseerbaar manifest is geen "eerste poging" —
  // het is een half geschreven/beschadigd transactielog. Het stilzwijgend negeren zou de rollback-dekking
  // van de vorige poging weggooien terwijl haar writes wél op schijf staan. Weigeren, met het bestand
  // als bewijs; ENOENT (echt de eerste poging) blijft het normale pad.
  const manifestPath = path.join(bdir, 'manifest.json');
  try { priorManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) {
    if (!e || e.code !== 'ENOENT') {
      throw new Error('existing but unreadable/corrupt backup manifest for batch ' + batchId + ' (' + manifestPath + '): '
        + e.message + ' — refusing to treat a damaged transaction log as a first attempt (a prior attempt\'s writes may be unprotected)');
    }
  }
  // CODEX ronde-3 #5 stelde voor een resume tegen een ANDERE templateversie hard te weigeren (verouderde
  // newHash-verwachtingen in unie-entries). Test 36 codificeert resume-met-nieuwere-template echter als
  // ONTWORPEN gedrag; de echte zorg — een prior-entry wiens newHash niet meer beschrijft wat de resume
  // gaat schrijven — wordt hieronder opgelost door de newHash van elk hergebruikt entry te verversen naar
  // het HUIDIGE plan (oldHash + backup-bytes blijven heilig van poging 1). Een rel die buiten het nieuwe
  // plan valt kan geen stale newHash dragen: viel hij eruit omdat de schijf al gelijk is aan de huidige
  // template, dan wees zijn oude newHash daar ook al naar; anders zit hij per constructie IN het plan.
  const priorFilesByRel = {};
  if (priorManifest && Array.isArray(priorManifest.files)) for (const f of priorManifest.files) priorFilesByRel[f.rel] = f;

  const files = [];
  for (const entry of plan.toChange) {
    const already = priorFilesByRel[entry.rel];
    // S1: never re-back-up / never recompute oldHash on resume — but DO refresh newHash to what THIS
    // attempt will actually write (ronde-3 #5: a stale newHash from attempt 1 would misjudge divergence
    // after the template moved between attempts).
    if (already) { files.push(Object.assign({}, already, { newHash: entry.newHash })); continue; }
    if (entry.oldHash !== null) {
      const out = safeJoin(dst, entry.rel);
      const backupTarget = path.join(bdir, entry.rel);
      fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
      fs.copyFileSync(out, backupTarget);
    }
    files.push({ rel: entry.rel, oldHash: entry.oldHash, newHash: entry.newHash, existed: entry.oldHash !== null });
  }
  /** AUDIT #19 (2026-08-05): the loop above builds files[] from the NEW plan only, and on a resume the new
   *  plan is SMALLER by construction — a file the crashed first attempt already wrote now hashes equal to
   *  the template, so preflight files it under `same` and it never re-enters plan.toChange. S1 (above)
   *  protected the entries still IN the plan; entries that fell OUT of it were silently dropped from the
   *  manifest that was then unconditionally rewritten below — and restoreFromManifest only iterates
   *  manifest.files, so a rollback of the batch left exactly those files on template content while
   *  reporting ok, with their pristine backup bytes lying orphaned in the backup dir. The manifest is now
   *  a UNION: every prior-attempt entry that the new plan no longer names is carried forward verbatim
   *  (its backup bytes are already on disk in bdir; the central-mirror loop below copies them through the
   *  same existsSync non-clobber path). A rollback after a resume can therefore always reach the true
   *  pre-batch state. */
  const keptRels = new Set(files.map((f) => f.rel));
  if (priorManifest && Array.isArray(priorManifest.files)) {
    for (const f of priorManifest.files) if (!keptRels.has(f.rel)) { files.push(f); keptRels.add(f.rel); }
  }
  const versionState = priorManifest ? { exists: priorManifest.hadVersionFile, content: priorManifest.oldVersion } : readVersionFile(projectDir);
  const receiptState = priorManifest ? { exists: priorManifest.hadReceipt, content: priorManifest.oldReceipt } : readRawReceipt(projectDir);
  const pid = projectId(projectDir);
  // S3: record the ACTUAL resolved central-hub path this batch used, so a later rollback can read it back
  // from here instead of re-deriving its own guess — install/rollback derive a default from dirname(project)
  // while sync-all/rollback-batch derive theirs from rootDir, which disagree for any project that is not a
  // direct child of root (the sync-all backup becomes unreachable by a per-project rollback). Preserved across
  // a resume (never overwritten by a differing value on a second takeBackup call for the same batch).
  const centralBackupRootResolved = priorManifest && Object.prototype.hasOwnProperty.call(priorManifest, 'centralBackupRoot')
    ? priorManifest.centralBackupRoot
    : (opts.centralBackupRoot ? path.resolve(opts.centralBackupRoot) : null);
  const manifest = {
    batchId, ts: priorManifest ? (priorManifest.ts || nowIso) : nowIso,
    runId: opts.runId || (priorManifest ? priorManifest.runId : null) || null, templateVersion: templateVer,
    projectId: pid, projectPath: path.resolve(projectDir), centralBackupRoot: centralBackupRootResolved,
    files, hadVersionFile: versionState.exists, oldVersion: versionState.exists ? versionState.content : null,
    hadReceipt: receiptState.exists, oldReceipt: receiptState.exists ? receiptState.content : null,
    // CODEX ronde-3 #6: de scaffold-undo-informatie van de vorige poging moet een resume OVERLEVEN —
    // deze herbouw schreef het manifest zonder dat veld en gooide daarmee het enige record weg waarmee
    // een latere rollback de .gitignore-append/created files van poging 1 kon terugdraaien.
    ...(priorManifest && priorManifest.scaffold ? { scaffold: priorManifest.scaffold } : {}),
  };
  // CODEX ronde-3 #5: het manifest is het transactielog van deze batch — atomair schrijven (temp+rename),
  // zodat een crash halverwege nooit een half JSON-bestand achterlaat dat de volgende resume zou weigeren.
  writeAtomic(path.join(bdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  let centralDir = null;
  if (opts.centralBackupRoot) {
    centralDir = centralBackupDir(opts.centralBackupRoot, batchId, pid);
    fs.mkdirSync(centralDir, { recursive: true });
    for (const f of files) {
      if (f.oldHash !== null) {
        const centralTarget = path.join(centralDir, f.rel);
        if (!fs.existsSync(centralTarget)) { // S1: same non-clobber protection for the central mirror on resume
          fs.mkdirSync(path.dirname(centralTarget), { recursive: true });
          fs.copyFileSync(path.join(bdir, f.rel), centralTarget);
        }
      }
    }
    writeAtomic(path.join(centralDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); // atomair, ronde-3 #5
  }
  return { ok: true, backupDir: bdir, centralDir, manifest };
}

/** applyPlanSafely — writes plan.toChange; STOPS at the first failure (never leaves it to throw uncaught) so
 *  the caller can roll back exactly what was actually applied. copyFileImpl is injectable (defaults to
 *  fs.copyFileSync) purely so a test can simulate a mid-batch write failure without monkey-patching the
 *  global fs module. */
/** assertClaudeBaseContained (r5 #25, 2026-08-07): de containment-checks meten alles t.o.v. de
 *  GERESOLVEDE .claude-basis — maar als <project>/.claude zelf een junction naar buiten is, resolvet
 *  die basis naar buiten en "klopt" ieder doel eronder. Eis: de echte .claude-basis ligt binnen de
 *  echte projectroot en is geen reparse-point. Fail-closed voor elke apply/restore. */
function assertClaudeBaseContained(projectDir) {
  const base = claudeDirOf(projectDir);
  let lst = null;
  try { lst = fs.lstatSync(base); } catch (e) { throw new Error('sync-basis onleesbaar (' + base + '): ' + e.message); }
  if (lst.isSymbolicLink()) throw new Error('sync-basis ' + base + ' is zelf een symlink/junction — geweigerd (r5 #25): een omgeleide .claude-basis maakt elke containment-check zinloos');
  let realBase, realRoot;
  try { realBase = fs.realpathSync.native(base); } catch (e) { throw new Error('realpath van de sync-basis faalde: ' + e.message); }
  try { realRoot = fs.realpathSync.native(projectDir); } catch (e) { throw new Error('realpath van de projectroot faalde: ' + e.message); }
  if (realBase !== path.join(realRoot, '.claude')) {
    throw new Error('sync-basis resolvet naar ' + realBase + ' — dat ligt niet als .claude direct onder de echte projectroot ' + realRoot + ' (r5 #25, fail-closed)');
  }
}

function applyPlanSafely(templateDir, projectDir, plan, copyFileImpl) {
  assertClaudeBaseContained(projectDir);
  // default is nu copyNoFollow (uitgesteld punt 3) — de copyFileImpl-injectieseam blijft voor tests
  const dst = claudeDirOf(projectDir);
  const copy = copyFileImpl || ((src, out) => copyNoFollow(src, out, dst));
  const applied = [];
  try {
    for (const entry of plan.toChange) {
      const src = path.join(templateDir, entry.rel);
      const out = safeJoin(dst, entry.rel);
      /** AUDIT #24 (2026-08-05): containment (isSymlinkPath + containmentSafe) ran ONLY at plan time in
       *  preflight, and between plan and apply sits at minimum a full-file manifest plus preValidation —
       *  an entire forge-doctor run, seconds to minutes. In that window a directory on the path (or the
       *  leaf itself) can become a symlink/junction pointing outside the project; safeJoin is purely
       *  lexical and copyFileSync follows links, so the "checked" write would then land outside the tree
       *  it was checked against. Re-verify per entry at the WRITE moment, before mkdirSync; a trip is an
       *  ordinary apply-failure so the existing applied-subset rollback handles it. The --unsafe path
       *  calls this same function and gets the guard for free. */
      if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) {
        return { ok: false, applied, error: 'containment guard tripped at write time: ' + entry.rel + ' resolves through a symlink or outside the project — refusing to write' };
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      copy(src, out);
      applied.push(entry.rel);
    }
    return { ok: true, applied };
  } catch (e) {
    return { ok: false, applied, error: e.message };
  }
}

// ---- validation: H4 evidence-based gate + H3 pre/post baseline comparison ----
// M10: build a human-copy-pasteable command STRING from an argv array with proper quoting — naive string
// concatenation breaks on a project path containing a space and/or a "!" (e.g. "my project (v2)!").
function quoteArg(a) {
  const s = String(a);
  return /[\s"!]/.test(s) ? ('"' + s.replace(/"/g, '\\"') + '"') : s;
}
function cmdArrToString(execPath, argsArr) { return [execPath].concat(argsArr).map(quoteArg).join(' '); }

/** evidenceOk — H4: a forge-doctor --json report is only trusted when it shows POSITIVE evidence of having
 *  actually run real checks: node_check covered at least as many files as we just synced, AND at least one
 *  test suite ran with at least one passing assertion. A 0-files/0-suites "pass" is rejected outright. */
function evidenceOk(parsed, minCjsCount) {
  if (!parsed || typeof parsed !== 'object' || !parsed.checks) return false;
  const nc = parsed.checks.node_check, ts = parsed.checks.tests;
  if (!nc || typeof nc.total !== 'number' || nc.total < minCjsCount) return false;
  if (!ts || typeof ts.suites !== 'number' || ts.suites <= 0) return false;
  if (typeof ts.passed !== 'number' || ts.passed <= 0) return false;
  return true;
}
/** condenseDoctorSummary — B1 FIX: forge-doctor emits EIGHT checks (node_check, tests, strict_events,
 *  dashboard_spa, leak_scan, agents, chain, rebinding_guard) and its top-level `ok` is the AND of all eight.
 *  The OLD code only ever kept node_check + tests, so docCheckOkMap/regressionCheck could NEVER see a
 *  regression on any of the other 6 checks (e.g. a sync-caused break in dashboard_spa or rebinding_guard —
 *  both files THIS tool syncs — would be silently waved through as "already-red, not attributed to this
 *  sync"). Now carries {ok} for EVERY key actually present in parsed.checks, generically, plus the
 *  node_check/tests detail fields kept for existing consumers (evidenceOk, printSafeSyncResult, etc). */
function condenseDoctorSummary(parsed) {
  if (!parsed || !parsed.checks) return null;
  const c = parsed.checks;
  const pick = (obj, keys) => { if (!obj) return null; const o = {}; for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]; return o; };
  const checksOk = {};
  for (const k of Object.keys(c)) checksOk[k] = { ok: !!(c[k] && c[k].ok) };
  // OPERABILITEIT (2026-08-06, a card-game project-vloot-diagnose): de samenvatting verzweeg WELKE suites rood of
  // geblokkeerd (per-suite timeout) waren — een install meldde alleen "forge-doctor, exit 1" en elke
  // diagnose moest de hele doctor handmatig herdraaien. De namen van falende/geblokkeerde suites reizen
  // nu mee (afgekapt tot 8), en 'blocked' telt zichtbaar mee: de doctor rekent een geblokkeerde suite
  // terecht als niet-groen, dus de samenvatting mag dat niet verstoppen.
  const failing = [];
  if (c.tests && Array.isArray(c.tests.perSuite)) {
    for (const s of c.tests.perSuite) {
      if ((s.failed || 0) > 0 || s.timedOut || s.blocked || s.ok === false) failing.push((s.suite || '?') + ((s.failed || 0) > 0 ? ' (' + s.failed + ' failed)' : (s.timedOut || s.blocked ? ' (blocked/timeout)' : ' (suite ok:false — non-zero exit of lege testrun)')));
    }
  } else if (c.tests && c.tests.perSuite && typeof c.tests.perSuite === 'object') {
    for (const [k, s] of Object.entries(c.tests.perSuite)) {
      if ((s.failed || 0) > 0 || s.timedOut || s.blocked || s.ok === false) failing.push((s.suite || k) + ((s.failed || 0) > 0 ? ' (' + s.failed + ' failed)' : (s.timedOut || s.blocked ? ' (blocked/timeout)' : ' (suite ok:false — non-zero exit of lege testrun)')));
    }
  }
  return {
    ok: parsed.ok,
    node_check: pick(c.node_check, ['ok', 'total', 'failed']),
    tests: pick(c.tests, ['ok', 'suites', 'passed', 'failed', 'suitesFailed', 'suitesBlocked']),
    ...(failing.length ? { failing_suites: failing.slice(0, 8) } : {}),
    checksOk, // B1: EVERY doctor check's {ok}, not just node_check/tests -> regressionCheck can see all 8
  };
}
/** docCheckOkMap — B1 FIX: iterate ALL checks carried in summary.checksOk (every key forge-doctor emitted),
 *  not a hardcoded {node_check, tests} pair. Falls back to the legacy node_check/tests-only shape for a
 *  summary produced before this fix (e.g. a receipt persisted by an older sync run), so old receipts don't
 *  crash a later regressionCheck call. */
function docCheckOkMap(summary) {
  const out = {};
  if (summary && summary.checksOk && typeof summary.checksOk === 'object') {
    for (const k of Object.keys(summary.checksOk)) out[k] = !!summary.checksOk[k].ok;
  } else {
    if (summary && summary.node_check) out.node_check = !!summary.node_check.ok;
    if (summary && summary.tests) out.tests = !!summary.tests.ok;
  }
  if (summary) out.overall = summary.ok !== false;
  return out;
}
/** regressionCheck — H3/B1: a check that was RED before this sync and is STILL red after is not a new
 *  problem caused by the sync; a check that was GREEN before and is RED after on ANY of forge-doctor's
 *  checks (not just node_check/tests) is a genuine regression.
 *  MEDIUM FIX (2026-07-15, forge-2026-07-15-testloop): a check that did NOT EXIST in the pre-sync doctor
 *  at all (`pre[k] === undefined`) — i.e. a check the sync ITSELF just introduced, by writing a new
 *  forge-doctor.cjs that emits a check the old one never had — must ALSO count as a regression when it is
 *  red post-sync. The old condition (`pre[k] === true && post[k] === false`) only fired on a genuine
 *  green->red flip of a check present BOTH times; a check absent pre-sync could never satisfy `pre[k] ===
 *  true`, so a brand-new-and-already-red check was silently swallowed by the "already-red, not attributed
 *  to this sync" exemption below (decideValidationOutcome) even though nothing was ever green to compare
 *  against — "absent" must be treated as "was not red" (there is nothing yet to be already-red about), so a
 *  new+red check is exactly as much a regression as an old green check turning red. A check that already
 *  existed and was ALREADY red both before and after (`pre[k] === false && post[k] === false`) remains
 *  correctly exempted — this is the pre-existing-redness case the already-red logic exists to protect,
 *  and is intentionally NOT touched by this fix.
 *
 *  MEDIUM FIX (2026-07-15, forge-2026-07-15-testloop ROUND 2): the round-1 fix above only ever iterates
 *  `Object.keys(post)`, so it can only ever notice a check that is STILL PRESENT post-sync (red, new, or
 *  otherwise). A check that existed pre-sync and was GREEN, but is entirely ABSENT from post-sync's
 *  checksOk (the new forge-doctor.cjs simply stopped emitting that check-key at all — a sync deleting or
 *  silently degrading a check), can never be seen by that loop at all: it never appears in
 *  `Object.keys(post)`, so `post[k]` is never even evaluated for it. A validator quietly LOSING a check is
 *  exactly as dangerous as it flipping red — a sync must never be allowed to "fix" a regression by simply
 *  making the doctor stop reporting on it. Fix: a SECOND pass over `Object.keys(pre)` flags any key that was
 *  `true` pre-sync and is `undefined` (absent) post-sync. The full, precise truth table this function now
 *  implements: pre green + post absent = FAILURE (this fix); pre absent + post red = FAILURE (round-1 fix,
 *  unchanged above); pre red + post red (same key present both times) = already-red, exempted (unchanged);
 *  pre red + post green/absent = improvement, not a regression (unchanged — dropping an already-broken
 *  check, or fixing it, is never itself a new problem). */
function regressionCheck(preSummary, postSummary) {
  const pre = docCheckOkMap(preSummary), post = docCheckOkMap(postSummary);
  const regressed = [];
  for (const k of Object.keys(post)) {
    if (post[k] === false && (pre[k] === true || pre[k] === undefined)) regressed.push(k);
  }
  for (const k of Object.keys(pre)) {
    if (pre[k] === true && post[k] === undefined) regressed.push(k);
  }
  return regressed;
}
function runDoctorJson(projectDir, doctorPath, timeoutMs) {
  const argsArr = ['--root', projectDir, '--json'];
  const r = spawnSync(process.execPath, [doctorPath].concat(argsArr), { cwd: projectDir, encoding: 'utf8', timeout: timeoutMs });
  const exitCode = r.status == null ? 1 : r.status;
  // M4: spawnSync sets status:null + a kill signal (or r.error.code === 'ETIMEDOUT') when its timeout fires —
  // treat that as BLOCKED (couldn't confirm), never as a confirmed validation failure.
  const timedOut = r.status === null && (!!r.signal || (r.error && r.error.code === 'ETIMEDOUT'));
  let parsed = null; try { parsed = JSON.parse(r.stdout || ''); } catch { parsed = null; }
  return { exitCode, parsed, timedOut, signal: r.signal || null, cmdArgs: [doctorPath].concat(argsArr) };
}
/** runValidation — the gate for "did this sync leave the project provably OK". opts.doctorTimeoutMs
 *  overrides the default 180s (M4: `--doctor-timeout` makes this a real, settable flag). */
/** doctorProvenance — WHO WROTE THE GATE (broad Codex audit #2, fixed 2026-08-05).
 *  The install validated itself with `<project>/.claude/forge-bin/forge-doctor.cjs` — a file this very sync
 *  had just written. That is fine while the doctor really is the template's, but system files can legally
 *  be SKIPPED (a forge-overrides.json entry, unresolved unknown_drift, a conflict), and a skipped doctor is
 *  the PROJECT's own. A project holding a stub doctor that prints plausible JSON and exits 0 would then
 *  approve every future sync into itself, forever, and the receipt would read "validated". The gate would
 *  be authored by the thing it is gating. We hash the doctor that is about to run against the template's
 *  and say plainly which one it is; only a byte-identical template doctor counts as the trusted gate. */
function doctorProvenance(projectDir, templateDir) {
  const rel = path.join('forge-bin', 'forge-doctor.cjs');
  const projectDoctor = path.join(claudeDirOf(projectDir), rel);
  if (!fs.existsSync(projectDoctor)) return { kind: 'absent' };
  if (!templateDir) return { kind: 'unknown', reason: 'no template directory was given, so the doctor could not be compared with the canonical one' };
  const templateDoctor = path.join(templateDir, rel);
  if (!fs.existsSync(templateDoctor)) return { kind: 'unknown', reason: 'the template ships no forge-doctor.cjs to compare against' };
  const a = sha256Normalized(projectDoctor), b = sha256Normalized(templateDoctor);
  if (a && b && a === b) return { kind: 'template', hash: a };
  return { kind: 'project-local', projectHash: a, templateHash: b, reason: 'the doctor in this project is NOT the template doctor (it was overridden, drifted or skipped) — an install may not be approved by a gate the project itself authored' };
}
/** installerSyntaxGate — the one check the doctor cannot fake, because the INSTALLER runs it: every .cjs
 *  this sync wrote must parse under this Node runtime. It is a floor, not a substitute for the doctor —
 *  but it holds even when the doctor is missing, lying, or the project's own (audit #2). */
function installerSyntaxGate(projectDir, cjsRels) {
  const failures = [], commands = [];
  for (const rel of cjsRels) {
    const out = safeJoin(claudeDirOf(projectDir), rel);
    const argsArr = ['--check', out];
    commands.push(cmdArrToString(process.execPath, argsArr));
    const r = spawnSync(process.execPath, argsArr, { encoding: 'utf8' });
    if (r.status !== 0) failures.push(rel);
  }
  return { checked: cjsRels.length, failures, commands };
}
function runValidation(projectDir, plan, opts) {
  opts = opts || {};
  const timeoutMs = Number.isFinite(opts.doctorTimeoutMs) && opts.doctorTimeoutMs > 0 ? opts.doctorTimeoutMs : 180000;
  const doctorPath = path.join(claudeDirOf(projectDir), 'forge-bin', 'forge-doctor.cjs');
  const cjsRels = (plan.toChange || []).map((e) => e.rel).filter((rel) => rel.endsWith('.cjs'));
  // ALWAYS run the installer-owned syntax gate first, whatever the doctor is going to say. A file that
  // does not parse is broken no matter which doctor validates it, and this result is ours, not the
  // doctor's — so a self-approving doctor still cannot turn a broken sync green.
  const syntax = installerSyntaxGate(projectDir, cjsRels);
  const provenance = doctorProvenance(projectDir, opts.templateDir);
  if (syntax.failures.length) {
    return {
      tool: 'installer-syntax-gate', exitCode: 1, ok: false, commands: syntax.commands,
      syntaxGate: syntax, doctorProvenance: provenance.kind,
      reason: syntax.failures.length + ' just-synced .cjs file(s) do not parse (' + syntax.failures.join(', ')
        + ') — the installer checked this itself; no doctor verdict can override it',
    };
  }
  if (fs.existsSync(doctorPath)) {
    const { exitCode, parsed, timedOut, signal, cmdArgs } = runDoctorJson(projectDir, doctorPath, timeoutMs);
    const commandStr = cmdArrToString(process.execPath, cmdArgs);
    const base = { tool: 'forge-doctor', doctorProvenance: provenance.kind, syntaxGate: syntax };
    if (timedOut) return { ...base, exitCode, ok: false, timedOut: true, signal, commands: [commandStr] };
    if (parsed && evidenceOk(parsed, cjsRels.length)) {
      // Only a doctor that DIFFERS from a template doctor that actually exists is the hole this closes:
      // the project overrode/skipped the canonical gate and would then approve its own installs. When the
      // template ships no doctor at all ('unknown'), this sync did not install the gate, so it is not the
      // "gated by its own artifact" case — it is still recorded on the result, never silently dropped.
      const trusted = provenance.kind !== 'project-local';
      const ok = exitCode === 0 && parsed.ok !== false;
      if (ok && !trusted) {
        // The doctor said yes, but it is not the canonical one. That is a DEGRADED pass — it still has to
        // clear the installer's own syntax gate (it did, above), and decideValidationOutcome's existing
        // degraded handling decides whether a degraded pass is acceptable for this run.
        return {
          ...base, exitCode, ok: true, degraded: true, commands: [commandStr], summary: condenseDoctorSummary(parsed),
          reason: 'validated by a doctor that is not the template doctor — ' + (provenance.reason || 'provenance ' + provenance.kind)
            + '; the independent evidence for this install is the installer syntax gate over ' + syntax.checked + ' file(s)',
        };
      }
      return { ...base, exitCode, ok, commands: [commandStr], summary: condenseDoctorSummary(parsed) };
    }
    return {
      ...base, exitCode, ok: false, noEvidence: true, commands: [commandStr], summary: condenseDoctorSummary(parsed),
      reason: 'forge-doctor gave no positive evidence (--json missing/unparsable/0-count) — refusing to trust a bare exit code',
    };
  }
  // DEGRADED fallback: no forge-doctor present -> the installer syntax gate is all we have, and it passed.
  return {
    tool: 'node-check-fallback', exitCode: 0, ok: true, degraded: true, checked: syntax.checked, failures: [],
    commands: syntax.commands, syntaxGate: syntax, doctorProvenance: provenance.kind,
  };
}
/** seedCanaryRun — CANARY-ONLY, opt-in via opts.seedRunForValidation (set ONLY on the dedicated canary's own
 *  sync options in runSyncAll, NEVER for a real project's syncOpts). WHY THIS EXISTS (root cause, found via
 *  direct repro 2026-07-26): the dedicated canary is wiped fresh on every canary-init/sync-all run (M5) and
 *  therefore NEVER accumulates any forge-runs/ history of its own — but the REAL forge-doctor.cjs this tool
 *  syncs into it runs the project's REAL *.test.cjs suite, and at least one real, non-fabricated test
 *  (forge-capabilities-panel.test.cjs) has a genuine precondition of "at least one real run with
 *  events.jsonl exists in this project" — true for every actual Forge project (they accumulate real run
 *  history through real /forge usage) but structurally impossible for a scaffold that is deleted and
 *  recreated empty every single time. That is not a template defect; it is the canary's own environment
 *  missing something every real project already has. Confirmed with `preValidation` ALWAYS degraded for the
 *  canary too (no doctor exists pre-sync in a freshly wiped scaffold), so decideValidationOutcome's existing
 *  "already-red / pre-existing, not attributed to this sync" exemption can never fire for it either — this
 *  precondition would fail EVERY canary run, for every template, forever, with no rescue path.
 *  THE FIX: after this sync's files are applied but BEFORE post-sync validation runs, log ONE real, honestly
 *  described `run_started` event into the JUST-SYNCED project's own forge-runs/ via ITS OWN freshly-copied
 *  forge-dashboard/log-event.cjs (never a template copy, never a hand-crafted file — going through the exact
 *  same strict-mode honesty gate a real event would, so this can never smuggle in something that would fail
 *  STRICT). The canary genuinely WAS just initialized — recording that fact is accurate, not fabricated. This
 *  makes the precondition honestly, unconditionally TRUE (not merely exempted-as-pre-existing), so a
 *  template that is actually broken still fails the doctor for real reasons, and a genuinely safe template
 *  now gets an honest, unconditional pass instead of being blocked by an environment gap unrelated to it.
 *  Best-effort and silent-no-op when the just-synced project has no forge-dashboard/log-event.cjs at all
 *  (e.g. a minimal test-fixture template that ships no dashboard) — the SAME "the canary can't be blocked by
 *  a capability its template doesn't ship" leniency already established for --allow-degraded above, not a new
 *  bypass. Never throws; a failed/skipped seed simply leaves the real (honest) gap to surface as it always
 *  did. */
function seedCanaryRun(projectDir, batchId, nowIso) {
  const logEventPath = path.join(claudeDirOf(projectDir), 'forge-dashboard', 'log-event.cjs');
  if (!fs.existsSync(logEventPath)) return { ok: false, skipped: true, reason: 'no forge-dashboard/log-event.cjs synced into this project — leniently skipped' };
  const rawId = 'canary-init-' + String(batchId || nowIso || Date.now());
  const runId = rawId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || ('canary-init-' + Date.now());
  const payload = JSON.stringify({
    note: 'dedicated sync canary initialized by forge-sync.cjs — a real, honest event proving forge-runs/ genuinely exists for this fresh canary, never fabricated data',
    canary: true,
  });
  let r;
  try { r = spawnSync(process.execPath, [logEventPath, runId, 'run_started', payload], { cwd: projectDir, encoding: 'utf8' }); }
  catch (e) { return { ok: false, runId, error: e.message }; }
  return { ok: !!r && r.status === 0, runId, exitCode: r ? r.status : null, stderr: (r && r.stderr) || '' };
}

/** seedProjectScaffold — INSTALL-DEADLOCK FIX (2026-08-03). The post-install validation doctor runs test
 *  suites that assert the PROJECT ENVIRONMENT: CLAUDE.md exists (forge-configdrift), .gitignore carries the
 *  forge-runs/forge-index rules (forge-tool-index, forge-toolhook). Those files were Phase-16 duties of the
 *  INSTALLING AGENT — a step that by definition can only run AFTER forge-sync returns. Net effect measured
 *  live: every fresh-project install failed its own validation and rolled back all ~357 files ("a trading project
 *  trading", 2×, and a clean sandbox repro). The installer therefore seeds exactly the environment its own
 *  validation checks, from the template HOME (the directory above the template's .claude content dir):
 *    - .gitignore  — created verbatim from gitignore.snippet when absent; otherwise APPEND-ONLY: only
 *      snippet rule-lines whose trimmed form is not already present are appended (comments/order/custom
 *      lines untouched — the safe-merge discipline CLAUDE.md's Phase 16 already prescribes).
 *    - CLAUDE.md   — created from the template home's stub ONLY when absent; an existing CLAUDE.md is
 *      NEVER touched by the syncer (safe-merge of the Forge section stays an agent responsibility).
 *  Missing template assets degrade honestly to 'template-missing' (fixture templates have none).
 *  Returns { gitignore, claude_md, created:[rootRelNames], errors:[] } — callers surface it on the result
 *  and undoScaffold() removes CREATED files on the rollback paths (append-only edits are left in place). */
function seedProjectScaffold(templateDir, projectDir) {
  const out = { gitignore: 'template-missing', claude_md: 'template-missing', created: [], errors: [] };
  const tplHome = path.dirname(path.resolve(templateDir));
  const snippetPath = path.join(tplHome, 'gitignore.snippet');
  const stubPath = path.join(tplHome, 'CLAUDE.md');
  // CODEX ADVERSARIAL REVIEW (gpt-5.6-sol, 2026-08-03) findings #21/#22: this seeding bypassed the
  // installer's own containment/symlink discipline. A project `.gitignore` that is a SYMLINK to a file
  // outside the project was read and appended to through the link — the installer writing outside the
  // project it is installing into. And `existsSync` + `writeFileSync` is a check-then-write race: a
  // file created in between was truncated. Both are closed here: refuse non-regular targets, verify
  // containment against the resolved real path, and create with the exclusive 'wx' flag.
  const root = path.resolve(projectDir);
  const targetOk = (rel) => {
    const p = path.join(root, rel);
    if (path.resolve(p) !== path.normalize(p) || path.relative(root, p).startsWith('..')) return { ok: false, reason: 'path escapes the project root' };
    let st = null;
    try { st = fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return { ok: true, path: p, exists: false }; return { ok: false, reason: e.message }; }
    if (st.isSymbolicLink()) return { ok: false, reason: 'target is a symlink — refusing to write through it' };
    if (!st.isFile()) return { ok: false, reason: 'target exists but is not a regular file' };
    return { ok: true, path: p, exists: true };
  };
  // .gitignore
  try {
    if (fs.existsSync(snippetPath)) {
      const snippet = fs.readFileSync(snippetPath, 'utf8');
      const chk = targetOk('.gitignore');
      if (!chk.ok) { out.errors.push('.gitignore: ' + chk.reason); out.gitignore = 'refused'; throw new Error('scaffold refused: ' + chk.reason); }
      const target = chk.path;
      if (!chk.exists) {
        try {
          fs.writeFileSync(target, snippet.endsWith('\n') ? snippet : snippet + '\n', { encoding: 'utf8', flag: 'wx' });
          out.gitignore = 'created';
          out.created.push('.gitignore');
          out.createdHashes = Object.assign({}, out.createdHashes, { '.gitignore': sha256(target) }); // ronde-3 #7: alleen ONZE bytes mogen later verwijderd worden
        } catch (e) {
          if (e && e.code === 'EEXIST') { out.gitignore = 'raced-existing'; out.errors.push('.gitignore: created by another process during install — left untouched'); }
          else throw e;
        }
      } else {
        const priorBytes = fs.readFileSync(target, 'utf8');
        const existing = new Set(priorBytes.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
        const missing = snippet.split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && !existing.has(l));
        if (missing.length === 0) out.gitignore = 'unchanged';
        else {
          const appended = '\n# Forge scaffold rules (seeded by forge-sync install — append-only)\n' + missing.join('\n') + '\n';
          fs.appendFileSync(target, appended, 'utf8');
          out.gitignore = 'appended:' + missing.length;
          /** AUDIT #21 (2026-08-05): the append was irreversible — the batch manifest only backs up files
           *  under .claude/, never the root .gitignore, and undoScaffold only unlinks files it CREATED. A
           *  failed install therefore left the Forge block in the owner's .gitignore forever, with no
           *  record of the pre-append bytes anywhere. The exact prior bytes and the exact appended block
           *  are now carried on the scaffold result, so undoScaffold can restore the file byte-for-byte —
           *  and ONLY when the current content still equals prior+appended, so an owner edit made after
           *  the append is never clobbered by a rollback. */
          out.gitignorePrior = priorBytes;
          out.gitignoreAppended = appended;
        }
      }
    }
  } catch (e) { out.errors.push('.gitignore: ' + e.message); out.gitignore = 'error'; }
  // CLAUDE.md (create-only)
  try {
    if (fs.existsSync(stubPath)) {
      const chk = targetOk('CLAUDE.md');
      if (!chk.ok) { out.errors.push('CLAUDE.md: ' + chk.reason); out.claude_md = 'refused'; throw new Error('scaffold refused: ' + chk.reason); }
      if (chk.exists) out.claude_md = 'unchanged';
      else {
        try {
          // COPYFILE_EXCL: fail rather than clobber a file that appeared between the check and the copy.
          fs.copyFileSync(stubPath, chk.path, fs.constants.COPYFILE_EXCL);
          out.claude_md = 'created';
          out.created.push('CLAUDE.md');
          out.createdHashes = Object.assign({}, out.createdHashes, { 'CLAUDE.md': sha256(chk.path) }); // ronde-3 #7
        } catch (e) {
          if (e && e.code === 'EEXIST') { out.claude_md = 'raced-existing'; out.errors.push('CLAUDE.md: created by another process during install — left untouched'); }
          else throw e;
        }
      }
    }
  } catch (e) { out.errors.push('CLAUDE.md: ' + e.message); out.claude_md = 'error'; }
  return out;
}

/** undoScaffold — removes ONLY the files seedProjectScaffold reports it CREATED (never an append-edited or
 *  pre-existing file), so a rolled-back install leaves no half-provisioned root behind. Best-effort. */
const SCAFFOLD_ALLOWED = new Set(['.gitignore', 'CLAUDE.md']); // the ONLY files seeding may ever create
function undoScaffold(scaffold, projectDir) {
  const result = { removedCreated: [], keptForeign: [], gitignore: 'not-applicable', errors: [] };
  if (!scaffold) return result;
  const root = path.resolve(projectDir);
  const createdHashes = scaffold.createdHashes && typeof scaffold.createdHashes === 'object' ? scaffold.createdHashes : null;
  for (const name of (Array.isArray(scaffold.created) ? scaffold.created : [])) {
    // CODEX finding #22: this deleted by filename string alone, so a caller-supplied created:["../victim"]
    // (the function IS exported) would delete outside the project, and a file REPLACED between creation
    // and rollback was removed even though it was no longer ours. Allow-list + containment + regular-file
    // check, and never follow a symlink out of the tree.
    if (!SCAFFOLD_ALLOWED.has(name)) continue;
    const p = path.join(root, name);
    if (path.relative(root, p).startsWith('..') || path.dirname(p) !== root) continue;
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile()) { result.keptForeign.push(name + ' (not a regular file anymore)'); continue; }
      // CODEX ronde-3 #7 (2026-08-06): een LATE rollback (crash-pad, alleen het manifest) verwijderde een
      // created bestand ongeacht de inhoud — een CLAUDE.md die de owner intussen bewerkte ging mee de
      // prullenbak in. Met een vastgelegde creation-hash verwijderen we alleen exact ONZE bytes; zonder
      // hash (legacy scaffold-object) blijft het oude gedrag, dat de in-run paden al beschermde.
      if (createdHashes && typeof createdHashes[name] === 'string' && sha256(p) !== createdHashes[name]) {
        result.keptForeign.push(name + ' (content changed since creation — owner work, not ours to delete)');
        continue;
      }
      fs.rmSync(p, { force: true });
      result.removedCreated.push(name);
    } catch (e) { result.errors.push(name + ': ' + e.message); }
  }
  /** AUDIT #21 (2026-08-05): revert the .gitignore APPEND too — but only when the file's current bytes
   *  are exactly prior+appended. Any other content means the owner (or another process) touched the file
   *  after the seed, and clobbering their edit to undo ours would be worse than leaving both; that case
   *  is left in place deliberately, matching the "never delete what is no longer ours" rule above. */
  if (typeof scaffold.gitignorePrior === 'string' && typeof scaffold.gitignoreAppended === 'string') {
    const p = path.join(root, '.gitignore');
    try {
      const st = fs.lstatSync(p);
      if (st.isFile()) {
        const now = fs.readFileSync(p, 'utf8');
        if (now === scaffold.gitignorePrior + scaffold.gitignoreAppended) {
          writeAtomic(p, scaffold.gitignorePrior);
          result.gitignore = 'reverted';
        } else result.gitignore = 'kept (content changed since the append — never clobber owner work)';
      } else result.gitignore = 'kept (no longer a regular file)';
    } catch (e) { result.gitignore = 'kept (' + (e.code === 'ENOENT' ? 'file gone' : e.message) + ')'; }
  }
  return result;
}
/** decideValidationOutcome — H3+H4 gating decision, kept as a pure function so it's directly unit-testable.
 *  Priority: timeout -> blocked. Degraded (no doctor) -> requires --allow-degraded even when clean, and NEVER
 *  passes if the fallback itself found syntax failures. Evidence-backed pass -> ok, UNLESS a previously-green
 *  check silently vanished (see below). No-evidence -> rejected. Evidence-backed fail -> ok ONLY if it is
 *  provably the SAME pre-existing redness (no new regression) AND the node_check hard gate on the
 *  just-synced files is clean; otherwise a real failure.
 *
 *  MEDIUM FIX (2026-07-15, forge-2026-07-15-testloop ROUND 2, mirrors regressionCheck's own fix): a naive
 *  `validation.ok===true` from the POST-sync doctor is NOT sufficient proof that nothing regressed — the
 *  doctor's own top-level `ok` is only `Object.values(checks).every(c=>c.ok)` over whatever keys IT still
 *  emits, so a sync that replaces forge-doctor.cjs with a version that silently stopped emitting a
 *  previously-green check reports a happy `ok:true` with ZERO awareness that real coverage was lost — "a
 *  sync that removes a check passes" is exactly the bug this closes. Before trusting a naive `ok:true`,
 *  compare against the pre-sync baseline via the SAME regressionCheck used for the evidence-backed-fail path
 *  below; if it finds a previously-green check now entirely absent, that overrides the naive pass. A
 *  brand-new green check, or identical checks on both sides, are unaffected (regressionCheck returns []). */
function decideValidationOutcome(preValidation, validation, opts) {
  opts = opts || {};
  if (validation.timedOut) return { ok: false, timedOut: true, reason: 'forge-doctor timed out (' + (validation.signal || 'no signal') + ') — treating as BLOCKED, not a confirmed validation failure' };
  if (validation.degraded) {
    if (!validation.ok) return { ok: false, reason: 'degraded validator (node --check fallback, no forge-doctor present) found syntax failure(s) in synced file(s)' };
    if (!opts.allowDegraded) return { ok: false, degradedBlocked: true, reason: 'degraded validator (no forge-doctor present) cannot count as synced without --allow-degraded' };
    return { ok: true, degradedAllowed: true };
  }
  if (validation.ok) {
    const vanished = regressionCheck(preValidation && preValidation.summary, validation.summary);
    if (vanished.length > 0) {
      return { ok: false, reason: 'this sync\'s own doctor no longer reports previously-green check(s), even though it otherwise claims ok:true: ' + vanished.join(', ') + ' (a check must never silently disappear)' };
    }
    return { ok: true };
  }
  if (validation.noEvidence) return { ok: false, reason: validation.reason || 'forge-doctor gave no positive evidence' };
  const preHasEvidence = !!(preValidation && preValidation.summary && !preValidation.noEvidence && !preValidation.degraded);
  const preWasRed = preHasEvidence && preValidation.summary.ok === false;
  if (!preHasEvidence || !preWasRed) return { ok: false, reason: 'post-sync validation failed' };
  const regressed = regressionCheck(preValidation.summary, validation.summary);
  const postNodeCheckOk = validation.summary && validation.summary.node_check ? !!validation.summary.node_check.ok : true;
  if (regressed.length === 0 && postNodeCheckOk) {
    return { ok: true, alreadyRedSkipped: true, note: 'project was already red before this sync (pre-existing, unrelated failures) — no NEW regression and the synced file(s) pass node_check; not attributing pre-existing redness to this sync' };
  }
  return { ok: false, reason: regressed.length ? ('regression on: ' + regressed.join(', ') + ' (green->red, or a check newly introduced by this sync that is already red)') : 'node_check hard gate failed on synced file(s)' };
}

// ---- rollback: integrity-checked, journaled (resumable/idempotent), project-local-first then central ----
function verifyBackupIntegrity(manifestDir, manifest) {
  const problems = [];
  for (const f of manifest.files) {
    if (f.oldHash === null) continue; // nothing to check — this file didn't exist pre-sync
    const p = path.join(manifestDir, f.rel);
    if (!fs.existsSync(p)) { problems.push({ rel: f.rel, reason: 'backup file missing' }); continue; }
    if (sha256(p) !== f.oldHash) problems.push({ rel: f.rel, reason: 'backup file hash mismatch (corrupt)' });
  }
  return { ok: problems.length === 0, problems };
}
function loadTrustedManifest(projectDir, batchId, centralBackupRoot) {
  const pDir = backupDirFor(projectDir, batchId);
  let pManifest = null;
  try { pManifest = JSON.parse(fs.readFileSync(path.join(pDir, 'manifest.json'), 'utf8')); } catch { /* absent */ }
  if (pManifest && verifyBackupIntegrity(pDir, pManifest).ok) return { ok: true, source: 'project', manifestDir: pDir, manifest: pManifest };
  if (centralBackupRoot) {
    const pid = projectId(projectDir);
    const cDir = centralBackupDir(centralBackupRoot, batchId, pid);
    let cManifest = null;
    try { cManifest = JSON.parse(fs.readFileSync(path.join(cDir, 'manifest.json'), 'utf8')); } catch { /* absent */ }
    if (cManifest && verifyBackupIntegrity(cDir, cManifest).ok) return { ok: true, source: 'central', manifestDir: cDir, manifest: cManifest };
  }
  return { ok: false, reason: 'no valid (uncorrupted) backup manifest found for batch ' + batchId + ' (checked project-local' + (centralBackupRoot ? ' and central' : '') + ' locations) — REFUSING to restore rather than fabricate a result' };
}
/** findNewerOverlappingBatches — B7 (part 2). S4 FIX: the OLD code only ever inspected the PROJECT-LOCAL
 *  backups dir. In a central-only recovery (the project's own `.claude/forge-backups/` is damaged/wiped —
 *  exactly the scenario a central hub exists for), a genuinely newer batch that already touched the same
 *  file(s) went completely undetected here, so this function silently returned [] and the caller fell through
 *  to a LESS informative generic "content diverged" refusal (from computeDivergence) that never names WHICH
 *  batch caused it. Now also scans <centralBackupRoot>/.claude/forge-backups/<batchId>/<projectId>/
 *  manifest.json for every batch id found there, in addition to the local scan, de-duplicated by batchId
 *  (local checked first) so the SAME batch is never double-counted. */
function findNewerOverlappingBatches(projectDir, batchId, manifest, centralBackupRoot) {
  const targetRels = new Set((manifest.files || []).map((f) => f.rel));
  const seen = new Set();
  const overlaps = [];
  const consider = (id, m) => {
    if (id === batchId || seen.has(id)) return;
    seen.add(id);
    if (!m || !m.ts || !manifest.ts || !(m.ts > manifest.ts)) return; // only strictly-newer batches matter
    const overlapRels = (m.files || []).map((f) => f.rel).filter((rel) => targetRels.has(rel));
    if (overlapRels.length) overlaps.push({ batchId: id, ts: m.ts, rels: overlapRels });
  };

  const bdir = path.join(claudeDirOf(projectDir), 'forge-backups');
  let localEntries = [];
  try { localEntries = fs.readdirSync(bdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* local backups dir gone/damaged */ }
  for (const id of localEntries) {
    let m; try { m = JSON.parse(fs.readFileSync(path.join(bdir, id, 'manifest.json'), 'utf8')); } catch { continue; }
    consider(id, m);
  }

  if (centralBackupRoot) { // S4: also scan the central hub — findable even when local is entirely gone
    const centralBatchesDir = path.join(centralBackupRoot, '.claude', 'forge-backups');
    const pid = projectId(projectDir);
    let centralBatchIds = [];
    try { centralBatchIds = fs.readdirSync(centralBatchesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no central hub / not created yet */ }
    for (const id of centralBatchIds) {
      let m; try { m = JSON.parse(fs.readFileSync(path.join(centralBatchesDir, id, pid, 'manifest.json'), 'utf8')); } catch { continue; }
      consider(id, m);
    }
  }
  return overlaps;
}
function journalPath(manifestDir) { return path.join(manifestDir, 'rollback-journal.json'); }
/** subsetManifest — a shallow copy of a backup manifest restricted to a subset of rels (used when only
 *  PART of a plan was actually applied before a failure, so rollback never touches an untouched file). */
function subsetManifest(manifest, rels) {
  const relSet = new Set(rels);
  return Object.assign({}, manifest, { files: manifest.files.filter((f) => relSet.has(f.rel)) });
}
/** computeDivergence — B7 (part 1): for every file NOT yet restored (per the journal), confirm the CURRENT
 *  on-disk content still matches what THIS sync wrote (newHash). A file that is simply ABSENT is not treated
 *  as diverged (nothing to protect — restoring/removing it is harmless); a file holding SOME OTHER content
 *  (neither newHash nor absent) means someone changed it since this sync, and rolling back would destroy
 *  that — refuse unless --force-rollback-newer. Legacy manifests (no newHash field) can't be checked and are
 *  allowed through unchanged (backward compatible with a pre-B7 backup). */
function computeDivergence(dst, manifest, doneSet) {
  const diverged = [];
  for (const f of manifest.files) {
    if (doneSet.has(f.rel)) continue;
    if (!Object.prototype.hasOwnProperty.call(f, 'newHash')) continue;
    const out = safeJoin(dst, f.rel);
    if (out == null) continue;
    const currentHash = sha256(out);
    if (currentHash === f.newHash) continue;
    // AUDIT #19 (2026-08-05): a file still at its recorded OLD hash is by definition the pre-batch state
    // — the exact bytes this rollback would restore. Refusing it as "diverged" made every rollback of a
    // half-applied batch (a crash left some files unwritten) refuse without --force-rollback-newer, which
    // punished the one situation rollback exists for. Foreign work (neither newHash nor oldHash) is still
    // refused; restoring an oldHash-file is a verified no-op.
    if (Object.prototype.hasOwnProperty.call(f, 'oldHash') && currentHash === f.oldHash) continue;
    if (currentHash === null) continue; // missing entirely -> nothing to protect
    diverged.push({ rel: f.rel, expected: f.newHash, current: currentHash });
  }
  return diverged;
}
/** restoreFromManifest — restores byte-for-byte from an already-TRUSTED manifest/manifestDir. Journaled: a
 *  thrown interruption (real or the __throwAfter test hook, gated behind FORGE_SYNC_TEST_HOOKS=1 — M11) leaves
 *  rollback-journal.json with the rels already restored; calling this again on the SAME manifestDir resumes
 *  from there (idempotent). H1: every restore step is verified — ENOENT-on-delete is tolerated, but any OTHER
 *  error (EPERM, an unsafe path) is recorded as a real failure, and every file is RE-HASHED after its restore
 *  attempt; a rel is only ever added to `restored` when that verification actually passed. If any file fails,
 *  the whole call returns {ok:false, partial:true, restored, failed} — never a false "restored" claim — and
 *  the journal is left in-progress so a later re-run (e.g. after fixing a lock) can retry just the failures.
 *  B7: refuses up front (before touching anything) if any not-yet-restored file has diverged from what this
 *  sync wrote, unless opts.forceRollbackNewer. B2: also restores/removes forge-sync-receipt.json, exactly
 *  like FORGE_VERSION.json, so a rolled-back project's next preflight() sees a receipt consistent with its
 *  actual (reverted) file contents instead of a stale receipt describing the undone sync. */
function restoreFromManifest(projectDir, manifestDir, manifest, opts) {
  assertClaudeBaseContained(projectDir);
  opts = opts || {};
  const dst = claudeDirOf(projectDir);
  const jPath = journalPath(manifestDir);
  let journal;
  try { journal = JSON.parse(fs.readFileSync(jPath, 'utf8')); } catch { journal = null; }
  if (!journal || journal.status === 'complete') journal = { batchId: manifest.batchId, status: 'in-progress', doneRels: [], versionRestored: false, receiptRestored: false };
  const doneSet = new Set(journal.doneRels);

  if (!opts.forceRollbackNewer) {
    const diverged = computeDivergence(dst, manifest, doneSet);
    if (diverged.length) return { ok: false, refusedDivergence: true, diverged, restored: [] };
  }

  const testHooksEnabled = process.env.FORGE_SYNC_TEST_HOOKS === '1'; // M11: gate the test-only throw switch
  const restored = [], failed = [];
  for (const f of manifest.files) {
    if (doneSet.has(f.rel)) { restored.push(f.rel); continue; }
    if (testHooksEnabled && opts.__throwAfter != null && restored.length === opts.__throwAfter) {
      journal.doneRels = [...doneSet];
      fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
      throw new Error('SIMULATED rollback interruption after ' + restored.length + ' file(s) (test-only injection hook)');
    }
    const out = safeJoin(dst, f.rel);
    let ok = true, reason = null;
    if (out == null) { ok = false; reason = 'unsafe path (containment guard tripped)'; }
    // CODEX ronde-3 #8 (2026-08-06): het RESTORE-pad had geen symlink/realpath-guard — het scenario "A is
    // toegepast, een junction verschijnt, B triggert de apply-refusal, en de rollback schrijft A dwars
    // door diezelfde junction naar buiten" liep dus om de write-time guard van applyPlanSafely heen.
    // Dezelfde check, op hetzelfde moment: vlak voor de write/delete. (Volledig raceloos kan alleen met
    // no-follow-handles die fs.copyFileSync niet biedt — dat restrisico is gedocumenteerd, niet verstopt.)
    else if (isSymlinkPath(out) || !containmentSafe(dst, out)) { ok = false; reason = 'containment guard tripped at restore time (symlink/junction on the path)'; }
    else if (f.oldHash === null) {
      try { fs.rmSync(out, { force: true }); } catch (e) { if (e && e.code !== 'ENOENT') { ok = false; reason = e.message; } }
    } else {
      try { fs.mkdirSync(path.dirname(out), { recursive: true }); copyNoFollow(path.join(manifestDir, f.rel), out, dst); }
      catch (e) { ok = false; reason = e.message; }
    }
    if (ok && out != null) { // H1: post-step verification — never trust "no exception" alone
      if (f.oldHash === null) { if (fs.existsSync(out)) { ok = false; reason = 'file still present after delete attempt'; } }
      else { const h = sha256(out); if (h !== f.oldHash) { ok = false; reason = 'hash mismatch after restore (expected ' + f.oldHash + ', got ' + h + ')'; } }
    }
    if (ok) { restored.push(f.rel); doneSet.add(f.rel); } else failed.push({ rel: f.rel, reason });
    journal.doneRels = [...doneSet];
    fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  }

  if (failed.length) return { ok: false, partial: true, restored, failed };

  if (!journal.versionRestored) {
    if (manifest.hadVersionFile) writeAtomic(versionFilePath(projectDir), manifest.oldVersion); // atomic on rollback too (audit #22)
    else { try { fs.rmSync(versionFilePath(projectDir), { force: true }); } catch { /* already gone */ } }
    journal.versionRestored = true;
    fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  }
  if (!journal.receiptRestored) {
    if (Object.prototype.hasOwnProperty.call(manifest, 'hadReceipt')) {
      if (manifest.hadReceipt) writeAtomic(receiptPath(projectDir), manifest.oldReceipt); // atomic on rollback too (audit #22)
      else { try { fs.rmSync(receiptPath(projectDir), { force: true }); } catch { /* already gone */ } }
    }
    journal.receiptRestored = true;
    fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  }
  // AUDIT #21 (2026-08-05): a manifest written by a sync that seeded the project scaffold carries the
  // undo-information for it (see safeSyncProject's manifest-persist step). A LATER rollback — the crash
  // case that never reached the in-run undoScaffold — can therefore revert the scaffold too: created
  // files via the same allow-listed remover, the .gitignore append only when the bytes still equal
  // prior+appended (an owner edit in between is never clobbered).
  let scaffoldAction = 'none';
  if (manifest.scaffold) {
    // CODEX ronde-3 #7 (2026-08-06): rapporteer wat de scaffold-undo WERKELIJK deed — "reverted" zonder
    // te kijken was een claim, geen observatie. createdHashes beschermt owner-bewerkte created files.
    const undone = undoScaffold({
      created: manifest.scaffold.created || [],
      createdHashes: manifest.scaffold.createdHashes,
      gitignorePrior: manifest.scaffold.gitignorePrior,
      gitignoreAppended: manifest.scaffold.gitignoreAppended,
      errors: [],
    }, projectDir);
    scaffoldAction = 'created removed: [' + undone.removedCreated.join(', ') + ']'
      + (undone.keptForeign.length ? ' · kept (owner work): [' + undone.keptForeign.join('; ') + ']' : '')
      + ' · gitignore: ' + undone.gitignore
      + (undone.errors.length ? ' · errors: ' + undone.errors.join('; ') : '');
  }
  journal.status = 'complete';
  fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  return {
    ok: true, restored, versionAction: manifest.hadVersionFile ? 'restored' : 'removed',
    receiptAction: !('hadReceipt' in manifest) ? 'unknown (legacy manifest predates receipt backup)' : (manifest.hadReceipt ? 'restored' : 'removed'),
    scaffoldAction,
  };
}
function latestBatchId(projectDir) {
  const bdir = path.join(claudeDirOf(projectDir), 'forge-backups');
  let entries = [];
  try { entries = fs.readdirSync(bdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  let best = null, bestTs = '';
  for (const id of entries) {
    try { const m = JSON.parse(fs.readFileSync(path.join(bdir, id, 'manifest.json'), 'utf8')); if (!best || (m.ts || '') > bestTs) { best = id; bestTs = m.ts || ''; } } catch { /* skip unreadable */ }
  }
  return best;
}
/** rollbackProject — `node forge-sync.cjs rollback <projectDir> [--batch <batchId>]`. An interruption
 *  (thrown by restoreFromManifest) is caught and reported as ok:false, interrupted:true — the journal already
 *  on disk means a SECOND call to this function resumes and completes it. */
function rollbackProject(projectDir, batchId, opts) {
  opts = opts || {};
  if (!fs.existsSync(projectDir)) return { ok: false, reason: 'project path missing: ' + projectDir };
  const dst = claudeDirOf(projectDir);
  if (!fs.existsSync(dst)) return { ok: false, reason: 'not a project (.claude missing): ' + projectDir };
  const targetBatch = batchId || latestBatchId(projectDir);
  if (!targetBatch) return { ok: false, reason: 'no backup batch found for ' + projectDir };
  // S3: unless the caller EXPLICITLY chose a central hub (a real --central-backup-root / --no-central-backup
  // flag, signaled by opts.centralBackupRootExplicit), prefer whatever hub THIS BATCH itself recorded in its
  // own project-local manifest.json over a freshly re-derived guess — this is what makes a `rollback` command
  // able to find a `sync-all`-written central backup even when the project isn't a direct child of root.
  let centralBackupRoot = opts.centralBackupRoot;
  if (!opts.centralBackupRootExplicit) {
    try {
      const localManifest = JSON.parse(fs.readFileSync(path.join(backupDirFor(projectDir, targetBatch), 'manifest.json'), 'utf8'));
      if (localManifest && localManifest.centralBackupRoot) centralBackupRoot = localManifest.centralBackupRoot;
    } catch { /* no project-local manifest available (or none recorded pre-S3) -> keep the caller-supplied value */ }
  }
  const trusted = loadTrustedManifest(projectDir, targetBatch, centralBackupRoot);
  if (!trusted.ok) return { ok: false, reason: trusted.reason, batchId: targetBatch };
  if (!opts.forceRollbackNewer) {
    const overlaps = findNewerOverlappingBatches(projectDir, targetBatch, trusted.manifest, centralBackupRoot);
    if (overlaps.length) {
      return {
        ok: false, batchId: targetBatch, source: trusted.source, newerOverlaps: overlaps,
        reason: 'refusing to roll back batch ' + targetBatch + ': a NEWER batch (' + overlaps.map((o) => o.batchId).join(', ') + ') already touched the same file(s) for this project — this would destroy the newer sync (pass --force-rollback-newer to override; prefer rolling back the newest batch first)',
      };
    }
  }
  try {
    const result = restoreFromManifest(projectDir, trusted.manifestDir, trusted.manifest, { __throwAfter: opts.__throwAfter, forceRollbackNewer: opts.forceRollbackNewer });
    if (result.ok === false && result.refusedDivergence) {
      return {
        ok: false, batchId: targetBatch, source: trusted.source, diverged: result.diverged,
        reason: 'refusing to roll back: ' + result.diverged.length + ' file(s) diverged since this sync wrote them (newer content present) — pass --force-rollback-newer to override: ' + result.diverged.map((d) => d.rel).join(', '),
      };
    }
    if (result.ok === false && result.partial) {
      return {
        ok: false, partial: true, batchId: targetBatch, source: trusted.source, restored: result.restored, failed: result.failed,
        reason: 'PARTIAL — MANUAL RECOVERY REQUIRED: ' + result.failed.length + ' file(s) failed to restore/verify (backup at ' + trusted.manifestDir + '): ' + result.failed.map((f) => f.rel + ' (' + f.reason + ')').join('; '),
      };
    }
    return { ok: true, batchId: targetBatch, source: trusted.source, restored: result.restored, versionAction: result.versionAction, receiptAction: result.receiptAction };
  } catch (e) {
    return { ok: false, interrupted: true, batchId: targetBatch, reason: 'rollback interrupted: ' + e.message + ' (re-run rollback to resume/complete — journal is on disk)' };
  }
}
/** rollbackBatch — `node forge-sync.cjs rollback-batch <batchId> <rootDir>`. B4: a project whose LOCAL
 *  backup dir is gone (damaged/wiped) but whose CENTRAL backup is intact must still be attempted — gating on
 *  "local dir exists" alone silently skipped exactly the scenario the central hub exists for. Only projects
 *  with NO evidence anywhere (neither local nor a valid central manifest) are skipped as "not part of this
 *  batch". */
function rollbackBatch(rootDir, batchId, opts) {
  opts = opts || {};
  const projects = Array.isArray(opts.projects) ? opts.projects : findForgeProjects(rootDir);
  const results = [];
  for (const p of projects) {
    const hasLocal = fs.existsSync(path.join(claudeDirOf(p), 'forge-backups', batchId));
    const trusted = loadTrustedManifest(p, batchId, opts.centralBackupRoot);
    if (!hasLocal && !trusted.ok) continue;
    // S6: hold this project's OWN lock while restoring it (in addition to the CLI's root lock held for the
    // whole batch), so a concurrent single-project `install`/`rollback` on the SAME project cannot race this.
    const lock = acquireLock(claudeDirOf(p));
    if (!lock.ok) { results.push({ projectDir: p, ok: false, reason: 'S6: could not acquire project lock for ' + p + ': ' + lock.reason }); continue; }
    try { results.push(Object.assign({ projectDir: p }, rollbackProject(p, batchId, opts))); }
    finally { releaseLock(lock); }
  }
  return results;
}

// ---- M2: a lightweight, cooperative concurrency lock (CLI-layer only — library functions stay lock-free so
// direct unit tests remain deterministic and dry-run stays a true zero-write operation). ----
function lockPathFor(dir) { return path.join(dir, '.forge-sync.lock'); }
function acquireLock(dir, opts) {
  opts = opts || {};
  const lp = lockPathFor(dir);
  const staleMs = opts.staleMs != null ? opts.staleMs : 6 * 60 * 60 * 1000; // 6h freshness window
  try {
    const fd = fs.openSync(lp, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    fs.closeSync(fd);
    return { ok: true, lockPath: lp };
  } catch (e) {
    // The lock target directory not existing yet (e.g. a project whose .claude/ is missing entirely) is NOT
    // a locking problem — never fs.mkdirSync it into existence as a side effect (that would silently mask the
    // "not a project" refusal safeSyncProject is about to report moments later). Just skip locking cleanly.
    if (e.code === 'ENOENT') return { ok: true, lockPath: null, skippedMissingDir: true };
    if (e.code !== 'EEXIST') return { ok: false, reason: 'could not create lock at ' + lp + ': ' + e.message };
    let info = null;
    try { info = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { /* corrupt/unreadable lock content */ }
    const ageMs = info && info.ts ? (Date.now() - new Date(info.ts).getTime()) : null;
    if (ageMs != null && ageMs > staleMs) {
      try {
        fs.rmSync(lp, { force: true });
        const fd = fs.openSync(lp, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
        fs.closeSync(fd);
        return { ok: true, lockPath: lp, reclaimedStale: true };
      } catch (e2) { return { ok: false, reason: 'stale lock reclaim failed: ' + e2.message }; }
    }
    return {
      ok: false, held: true,
      reason: 'another forge-sync run is in progress (lock held' + (info && info.pid ? (' by pid ' + info.pid) : '') + (info && info.ts ? (' since ' + info.ts) : '') + ') at ' + lp + ' — refusing to run concurrently',
    };
  }
}
function releaseLock(lockResult) { if (lockResult && lockResult.ok && lockResult.lockPath) { try { fs.rmSync(lockResult.lockPath, { force: true }); } catch { /* best-effort */ } } }

/**
 * safeSyncProject — the whole safe flow for ONE project. opts: { dryRun, forceOverwrite, batchId, nowIso,
 * centralBackupRoot, runId, copyFileImpl, allowDegraded, doctorTimeoutMs, resumeBatch }. NEVER calls
 * Date.now()/generates its own batchId — both must be supplied by the caller (CLI computes real ones; tests
 * inject fixed ones) so behavior stays deterministic.
 */
function safeSyncProject(templateDir, projectDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(projectDir)) return { ok: false, refused: true, reason: 'project path missing: ' + projectDir, projectDir };
  const dst = claudeDirOf(projectDir);
  /** De weigering hieronder is een VEILIGHEIDSFEATURE, geen bug (heroverwogen 2026-08-13 na de
   *  fresh-install audit): forge-sync werkt een BESTAAND Forge-project bij naar de nieuwste
   *  template. Zou hij .claude/ zelf aanmaken, dan zet één typefout in een pad een willekeurige map
   *  vol systeembestanden. De eerste installatie hoort via install.sh / install.ps1 te lopen, die
   *  wél vanuit niets bootstrappen (gemeten 2026-08-13: verse map -> volledige install -> doctor).
   *  Wat hier WEL fout was: de melding noemde de oplossing niet, dus een nieuwe gebruiker liep vast
   *  op "not a project" zonder te weten wat dan wel. Die melding wijst nu de weg. */
  if (!fs.existsSync(dst)) {
    return {
      ok: false, refused: true, projectDir,
      reason: 'not a project (.claude missing): ' + projectDir
        + ' — forge-sync updates an EXISTING Forge project; it deliberately never creates .claude/ itself, so a mistyped path can never fill a random folder.'
        + ' For a FIRST install run the installer instead: `bash install.sh --project "' + projectDir + '"` (or install.ps1 on Windows).',
    };
  }

  // 3.4 fix: move any v2.7-era owner standing rule into the project's own user file BEFORE the SYSTEM
  // FORGE_STANDING_RULES.json is ever compared/replaced below — including under --force-overwrite. Never
  // during --dry-run, which must write nothing at all (see this file's own SAFE FLOW doc comment).
  const standingMigration = opts.dryRun ? [] : migrateOwnerStandingRules(projectDir);

  const templateVer = templateVersion(templateDir);
  const plan = buildPlan(templateDir, projectDir, { forceOverwrite: !!opts.forceOverwrite });

  // F4 fix (2026-09-26 independent review, LOW): migrateOwnerStandingRules()'s return value used to be
  // ignored entirely. When it reports `.pending` (an owner rule exists in the template but this pass could
  // NOT confirm it is safely represented in FORGE_STANDING_RULES.user.json — e.g. that user file is
  // unreadable/malformed), FORGE_STANDING_RULES.json must never be replaced THIS pass, on any path —
  // whether preflight already classified it as a plain toChange, or --force-overwrite is about to force it
  // out of unknownDrift/conflicts (buildPlan() already folded both into plan.toChange above). Filtering it
  // back out here, with a plain warning, is the ONE place both routes are closed at once.
  if (standingMigration.pending) {
    const before = plan.toChange.length;
    plan.toChange = plan.toChange.filter((e) => e.rel !== STANDING_RULES_REL);
    if (plan.toChange.length !== before) {
      plan.skipped = (plan.skipped || []).concat([{ rel: STANDING_RULES_REL, reason: 'owner-rule-pending-migration' }]);
      console.error('forge-sync: WARNING — refusing to replace ' + STANDING_RULES_REL + ' this pass: an owner rule from a pre-v2.8.0 install is still sitting in it and could not be migrated into ' +
        STANDING_RULES_USER_REL + ' (see the warning above). Fix or remove that file, then re-run sync so the owner rule can be moved to safety before this file is replaced.');
    }
  }

  if (plan.unreadable && plan.unreadable.length) { // B3: never silently treat an unreadable file as "new"
    return {
      ok: false, refused: true, projectDir, plan, templateVersion: templateVer, dryRun: !!opts.dryRun,
      reason: 'refusing to sync: ' + plan.unreadable.length + ' existing system file(s) could not be read (exists but unreadable — permission/lock issue, NEVER treated as "new"): '
        + plan.unreadable.map((u) => u.rel + ' (' + u.error + ')').join('; '),
    };
  }

  if (opts.dryRun) return { ok: true, dryRun: true, projectDir, plan, templateVersion: templateVer, settingsMerge: syncProjectSettings(templateDir, projectDir, { dryRun: true }) };

  if (plan.toChange.length === 0) { // H2: distinguish a clean no-op from a project BLOCKED by unresolved drift
    const blocked = plan.unknownDrift.length > 0 || plan.conflicts.length > 0;
    // WP22: even when the FILE plan is a no-op, settings.json may still be behind the template (a project
    // synced before wp22 shipped, or hand-edited) — the settings merge is independent of the file plan.
    const settingsMergeNoop = blocked ? null : syncProjectSettings(templateDir, projectDir, {});
    // SUCCESS-WITHOUT-SETTINGS (wp-f2): a file-plan no-op must not report ok:true when the required gate
    // (settings.json merge) itself failed/was refused — the caller would otherwise see a plain success.
    return { ok: !blocked && !settingsMergeFailed(settingsMergeNoop), noop: !blocked, blocked, projectDir, plan, templateVersion: templateVer, settingsMerge: settingsMergeNoop };
  }

  const nowIso = opts.nowIso || new Date().toISOString();
  const batchId = opts.batchId;

  // M3: reusing a --batch-id already backed up for THIS project would silently overwrite that manifest.
  const existingBatchManifestPath = path.join(backupDirFor(projectDir, batchId), 'manifest.json');
  if (fs.existsSync(existingBatchManifestPath) && !opts.resumeBatch) {
    return {
      ok: false, refused: true, projectDir, plan, templateVersion: templateVer,
      reason: 'batch ' + batchId + ' already has a backup manifest for this project (' + existingBatchManifestPath + ') — refusing to silently overwrite it (pass --resume-batch to intentionally reuse this batch id)',
    };
  }

  const preManifest = fullFileManifest(templateDir, projectDir);
  const preValidation = runValidation(projectDir, { toChange: [] }, { doctorTimeoutMs: opts.doctorTimeoutMs, templateDir }); // H3 baseline
  const backup = takeBackup(projectDir, batchId, plan, templateVer, nowIso, { centralBackupRoot: opts.centralBackupRoot, runId: opts.runId });
  if (!backup.ok) { // S8: a backup I/O failure is a clean refusal, never an uncaught crash — nothing was applied yet
    return { ok: false, refused: true, projectDir, plan, templateVersion: templateVer, preManifest, backup, reason: 'refusing to sync: ' + backup.error };
  }

  const apply = applyPlanSafely(templateDir, projectDir, plan, opts.copyFileImpl);
  if (!apply.ok) {
    // Only the subset that was ACTUALLY written needs restoring — a file applyPlanSafely never reached
    // (e.g. the one that threw, or anything after it) was never modified from its pre-sync state.
    // AUDIT #19 (2026-08-05): on a RESUME the union-manifest (see takeBackupUnsafe) also carries the
    // PRIOR attempt's rels — files that crashed attempt already wrote and that this attempt's smaller
    // plan no longer names. They were genuinely modified, so a failed resume must restore them too;
    // "this attempt's applied list" alone would leave them on template content.
    const planRels = new Set(plan.toChange.map((e) => e.rel));
    const priorRels = backup.manifest.files.map((f) => f.rel).filter((rel) => !planRels.has(rel));
    const appliedManifest = subsetManifest(backup.manifest, apply.applied.concat(priorRels));
    let restored = null, rollbackError = null;
    try { restored = restoreFromManifest(projectDir, backup.backupDir, appliedManifest); }
    catch (e) { rollbackError = e.message; }
    const rolledBack = !rollbackError && !!(restored && restored.ok !== false); // H1: never trust "no throw" alone
    return { ok: false, projectDir, plan, backup, applyError: apply.error, rolledBack, rollbackError, restored, preManifest };
  }

  // Canary-only, opt-in (see seedCanaryRun's own doc comment above for the full root-cause rationale): the
  // files just applied above may include a real forge-dashboard/log-event.cjs — use it, right before
  // validation reads it, to log ONE honest run_started event so the canary's own forge-runs/ is never
  // structurally empty going into the doctor it is about to run. Never set for a real project's own sync.
  let canarySeed = null;
  if (opts.seedRunForValidation) canarySeed = seedCanaryRun(projectDir, batchId, nowIso);

  // INSTALL-DEADLOCK FIX (2026-08-03): seed the environment the validation below actually checks —
  // see seedProjectScaffold's own doc. Runs for every real (non-dry-run) sync; created files are
  // removed again on every rollback path below.
  const scaffold = seedProjectScaffold(templateDir, projectDir);
  // AUDIT #21 (2026-08-05): persist the scaffold's undo-information INTO the batch manifest. The in-run
  // rollback paths below hold the scaffold object in memory, but a crashed process never reaches them —
  // a LATER `forge-sync rollback` only has the manifest, which never mentioned the .gitignore append or
  // the created files, so exactly the crash case left the scaffold edits behind forever. Best-effort:
  // a manifest that cannot be rewritten leaves rollback no worse than it already was.
  if (scaffold && (scaffold.created.length || typeof scaffold.gitignorePrior === 'string')) {
    try {
      const mPath = path.join(backup.backupDir, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      m.scaffold = {
        created: scaffold.created,
        ...(scaffold.createdHashes ? { createdHashes: scaffold.createdHashes } : {}),
        ...(typeof scaffold.gitignorePrior === 'string' ? { gitignorePrior: scaffold.gitignorePrior, gitignoreAppended: scaffold.gitignoreAppended } : {}),
      };
      writeAtomic(mPath, JSON.stringify(m, null, 2) + '\n');
      if (backup.centralDir) { try { writeAtomic(path.join(backup.centralDir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n'); } catch { /* mirror only */ } }
    } catch (e) {
      // CODEX ronde-3 #6 (2026-08-06): een scaffold-mutatie waarvan het undo-record NIET persistent kon
      // worden is op het crash-pad onherstelbaar. Dan liever de mutatie zelf DIRECT terugdraaien dan een
      // niet-terugdraaibare wijziging laten staan met alleen een logregel als spoor.
      const undone = undoScaffold(scaffold, projectDir);
      scaffold.errors.push('manifest-persist: ' + e.message + ' — scaffold reverted immediately (created removed: '
        + undone.removedCreated.join(',') + '; gitignore: ' + undone.gitignore + ') because a mutation without a durable undo-record must not outlive this process');
      scaffold.gitignore = 'reverted (undo-record could not be persisted)';
      scaffold.claude_md = scaffold.claude_md === 'created' ? 'reverted (undo-record could not be persisted)' : scaffold.claude_md;
      scaffold.created = [];
      delete scaffold.gitignorePrior; delete scaffold.gitignoreAppended;
    }
  }

  const validation = runValidation(projectDir, plan, { doctorTimeoutMs: opts.doctorTimeoutMs, templateDir });
  const outcome = decideValidationOutcome(preValidation, validation, { allowDegraded: opts.allowDegraded });
  if (!outcome.ok) {
    let restored = null, rollbackError = null;
    try { restored = restoreFromManifest(projectDir, backup.backupDir, backup.manifest); }
    catch (e) { rollbackError = e.message; }
    undoScaffold(scaffold, projectDir);
    const rolledBack = !rollbackError && !!(restored && restored.ok !== false);
    return { ok: false, projectDir, plan, backup, validation, preValidation, outcome, canarySeed, scaffold, rolledBack, rollbackError, restored, preManifest };
  }

  /** B3 (Blocker 3) FIX: opts.refuseOnUnresolvedDrift (set ONLY by the single-project `install` CLI path —
   *  sync-all deliberately does NOT set it, since its staged-rollout M8 semantics already treat "this
   *  project's own partial sync succeeded, but the batch still stops" as an accepted, distinct outcome, proven
   *  by section 40b). Without this fix, a project with SOME safely-syncable files AND unresolved
   *  unknown_drift/conflict on OTHER files would fall through the `plan.toChange.length === 0` early-return
   *  above (which is the ONLY place H2's `blocked` classification is computed) and proceed to apply+validate+
   *  STAMP the template version as if the whole project were fully synced — silently hiding the drift. A
   *  direct `install` refuses that: it is all-or-nothing — either every system file resolves cleanly (or via
   *  --force-overwrite/forge-overrides.json/adopt), or NOTHING is stamped and whatever WAS just applied is
   *  rolled back, so the project never falsely claims templateVersionTo. */
  if (opts.refuseOnUnresolvedDrift && !opts.forceOverwrite && (plan.unknownDrift.length > 0 || plan.conflicts.length > 0)) {
    let restored = null, rollbackError = null;
    try { restored = restoreFromManifest(projectDir, backup.backupDir, backup.manifest); }
    catch (e) { rollbackError = e.message; }
    undoScaffold(scaffold, projectDir);
    const rolledBack = !rollbackError && !!(restored && restored.ok !== false);
    return {
      ok: false, refusedPartialDrift: true, projectDir, plan, backup, validation, preValidation, scaffold, rolledBack, rollbackError, restored, preManifest,
      reason: 'refusing to stamp templateVersionTo: ' + plan.unknownDrift.length + ' unresolved drift + ' + plan.conflicts.length
        + ' conflict file(s) remain (use --force-overwrite, or resolve via .claude/config/forge-overrides.json/adopt) — a partially-synced project must never claim the new template version',
    };
  }

  const priorReceipt = readReceipt(projectDir);
  const ver = { forge_version: templateVer, synced_at: nowIso, template: templateDir, system_files: listSystemFiles(templateDir).length };

  const postManifest = fullFileManifest(templateDir, projectDir);
  // B1: rebuild the CUMULATIVE baseline — carry forward every prior known hash, then overlay this sync's
  // toChange/same rels (anything NOT excluded/skipped) with their post-sync hash. unknownDrift/conflicts left
  // unresolved this round keep whatever baseline they already had (or none), never silently adopted.
  const priorKnownHashes = receiptLastTemplateHashMap(priorReceipt);
  const excludedRels = new Set([].concat(plan.expectedOverrides, plan.unknownDrift, plan.conflicts));
  const skippedRels = new Set((plan.skipped || []).map((s) => s.rel));
  const knownHashes = Object.assign({}, priorKnownHashes);
  for (const rel of Object.keys(postManifest)) {
    if (excludedRels.has(rel) || skippedRels.has(rel)) continue;
    if (postManifest[rel].hash != null) knownHashes[rel] = postManifest[rel].hash;
  }

  const receipt = {
    projectId: projectId(projectDir), projectPath: path.resolve(projectDir),
    batchId, runId: opts.runId || null,
    templateVersionFrom: priorReceipt ? (priorReceipt.templateVersionTo || priorReceipt.forge_version || null) : null,
    templateVersionTo: templateVer,
    backupRef: { project: backup.backupDir, central: backup.centralDir || null },
    preSyncManifestHash: aggregateManifestHash(preManifest),
    postSyncManifestHash: aggregateManifestHash(postManifest),
    filesChanged: plan.toChange.map((e) => ({ rel: e.rel, oldHash: e.oldHash, newHash: e.newHash, overrideClass: e.overrideClass || null })),
    knownHashes,
    overridesPreserved: { expectedOverride: plan.expectedOverrides, unknownDriftSkipped: plan.unknownDrift, conflictSkipped: plan.conflicts },
    validation: {
      tool: validation.tool, exitCode: validation.exitCode, ok: validation.ok, commands: validation.commands || [],
      summary: validation.summary || null, degraded: !!validation.degraded, degradedAllowed: !!outcome.degradedAllowed,
      alreadyRedSkipped: !!outcome.alreadyRedSkipped,
    },
    preValidation: { ok: preValidation.ok, summary: preValidation.summary || null, degraded: !!preValidation.degraded },
    // S8: this field used to be a bare hardcoded 'n/a' in every path, which reads as "not tracked" rather
    // than a real status. It is honestly always this exact value AT THE MOMENT this receipt is written: a
    // receipt only ever gets written for a sync that just SUCCEEDED, so by construction nothing has been (or
    // needed to be) rolled back yet. If this sync IS rolled back later, this receipt is itself restored/
    // removed by restoreFromManifest (see its receiptAction handling) — a rolled-back sync's receipt does not
    // persist in this form to have its OWN rollbackStatus flipped. Named explicitly rather than a vague 'n/a'.
    rollbackStatus: 'not_rolled_back_as_of_this_write',
    syncedAt: nowIso,
  };
  /** COMMIT ORDER (broad Codex audit #22, 2026-08-05). The version stamp and the receipt together are this
   *  install's commit record, and they were two separate NON-ATOMIC in-place writes after validation, outside
   *  any rollback protection — with the version stamped FIRST. A crash, a full disk, or a killed process
   *  between them left the worst of the two orderings: FORGE_VERSION.json says "synced to X" (so the staleness
   *  check never re-syncs) while the receipt — which holds the knownHashes drift baseline AND the backupRef
   *  needed to roll this very sync back — is missing or torn. The project then looks current while its audit
   *  trail and its undo pointer are gone, and the next drift check sees every system file as unknown drift.
   *  Reversed: the RECEIPT is written first and the version stamp is the commit marker written LAST. Crashing
   *  in between now leaves a project whose files+receipt are correct but whose stamp still reads the OLD
   *  version — so the next `/forge` simply sees it as behind and re-syncs against an accurate baseline. That
   *  is self-healing rather than silently wrong. Both writes are atomic (temp file + rename in the same
   *  directory), so a concurrent reader always sees one whole file, never a half-written one. */
  writeReceipt(projectDir, receipt);
  writeAtomic(versionFilePath(projectDir), JSON.stringify(ver, null, 2) + '\n');
  // WP22: settings.json merge runs AFTER the file sync/receipt/version stamp above have already succeeded —
  // it is deliberately independent of that commit (see syncProjectSettings's own doc comment): a refused-safe
  // merge (malformed/unexpected-shape existing settings.json) is reported on the result, never rolls back or
  // fails an otherwise-successful file sync.
  const settingsMerge = syncProjectSettings(templateDir, projectDir, {});
  // SUCCESS-WITHOUT-SETTINGS (wp-f2): the file sync itself succeeded (receipt/version already committed
  // above, deliberately independent of this step — see syncProjectSettings's own doc comment), but the
  // OVERALL result must not claim plain success when the settings.json gate failed/was refused.
  return { ok: !settingsMergeFailed(settingsMerge), projectDir, plan, backup, validation, preValidation, outcome, canarySeed, scaffold, receipt, preManifest, postManifest, settingsMerge };
}
/** settingsMergeFailed — true only when a settings-merge result explicitly reports ok:false (a genuine
 *  usage-error/refused/skipped-containment/skipped-tool-error) — never true for `null` (blocked before the
 *  step ran) or a `{ok:true, skipped:'no-template-settings'}` benign skip. */
function settingsMergeFailed(sm) { return !!(sm && sm.ok === false); }

/** adoptProject — NEW COMMAND: `forge-sync adopt <projectDir>`. Establishes a baseline receipt from the
 *  project's CURRENT file hashes WITHOUT writing a single template/system file, and reports which files
 *  differ from the template so a human can triage them into forge-overrides.json. Replaces a blind
 *  --force-overwrite as the safe way to onboard a project's very first sync. */
function adoptProject(templateDir, projectDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(projectDir)) return { ok: false, refused: true, reason: 'project path missing: ' + projectDir };
  const dst = claudeDirOf(projectDir);
  if (!fs.existsSync(dst)) return { ok: false, refused: true, reason: 'not a project (.claude missing): ' + projectDir };
  const priorReceipt = readReceipt(projectDir);
  const priorBaselineCount = priorReceipt && priorReceipt.knownHashes && typeof priorReceipt.knownHashes === 'object' ? Object.keys(priorReceipt.knownHashes).length : 0;
  /** S5 FIX: running adopt a SECOND time on an already-baselined project used to silently REPLACE the
   *  existing knownHashes baseline — every file that was previously a protected unknown_drift (because its
   *  current content differed from an earlier trusted baseline) instantly became a plain, safe-to-overwrite
   *  toChange the moment the new baseline adopted its CURRENT (possibly hand-edited) bytes, and the OLD
   *  receipt was never preserved anywhere, so the replacement could not be undone. Now: refuse unless the
   *  caller explicitly opts in via opts.force, and when forced, snapshot the pre-adopt receipt first. */
  if (priorBaselineCount > 0 && !opts.force) {
    return {
      ok: false, refused: true, existingBaseline: true, priorBaselineCount, projectDir,
      reason: 'refusing to adopt: an existing baseline of ' + priorBaselineCount + ' file(s) is already recorded in forge-sync-receipt.json — '
        + 'this replaces an existing baseline of ' + priorBaselineCount + ' file(s) — these WILL be overwritten by the next sync; '
        + 'pass --force to intentionally replace it (the current receipt is snapshotted first, so this can still be undone)',
    };
  }
  const nowIso = opts.nowIso || new Date().toISOString();
  const knownHashes = {};
  const differing = [];
  for (const rel of listSystemFiles(templateDir)) {
    const src = path.join(templateDir, rel);
    if (!fs.existsSync(src)) continue;
    const out = safeJoin(dst, rel);
    if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) continue;
    const status = fileStatus(out);
    if (status.kind !== 'ok') continue; // missing or unreadable -> nothing to adopt for this rel
    knownHashes[rel] = status.hash; // adopt WHATEVER is currently there, verbatim, as the trusted baseline
    if (status.hash !== sha256(src)) differing.push(rel);
  }
  // S5: snapshot the OLD receipt BEFORE replacing it, whenever one existed, so a --force replace is undoable.
  let snapshotPath = null;
  if (priorReceipt && !opts.dryRun) {
    const snapDir = path.join(dst, 'forge-adopt-snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    snapshotPath = path.join(snapDir, 'pre-adopt-' + nowIso.replace(/[^0-9a-zA-Z]/g, '-') + '.json');
    fs.writeFileSync(snapshotPath, JSON.stringify(priorReceipt, null, 2) + '\n', 'utf8');
  }
  const receipt = Object.assign({}, priorReceipt || {}, {
    projectId: projectId(projectDir), projectPath: path.resolve(projectDir),
    adopted: true, adoptedAt: nowIso,
    knownHashes,
    filesChanged: priorReceipt && Array.isArray(priorReceipt.filesChanged) ? priorReceipt.filesChanged : [],
    rollbackStatus: priorReceipt ? (priorReceipt.rollbackStatus || 'not_rolled_back_as_of_this_write') : 'not_rolled_back_as_of_this_write', // S8
    priorBaselineSnapshot: snapshotPath, // S5: undo pointer (null when there was no prior receipt to replace)
  });
  if (!opts.dryRun) writeReceipt(projectDir, receipt);
  return { ok: true, projectDir, differing, knownHashesCount: Object.keys(knownHashes).length, receipt, dryRun: !!opts.dryRun, priorBaselineCount, snapshotPath };
}

/** rawInstall — the OLD unsafe behavior, available only behind --unsafe: skips canary + validation. M7: it
 *  STILL takes a real, restorable backup first — "no undo" is never acceptable by construction, even in
 *  --unsafe mode. Dry-run remains a true zero-write preview.
 *  S2 FIX: --unsafe means "no canary, no validation" — it must NEVER also mean "no override allow-list, no
 *  containment/symlink guard, no undo." Before this fix, rawInstall never called readOverrideAllowlist (so it
 *  overwrote a forge-overrides.json-declared file the docstring claims is NEVER touched), never called
 *  safeJoin/isSymlinkPath/containmentSafe (so it could write straight through a junctioned forge-bin/ to
 *  somewhere OUTSIDE .claude/), and never called fileStatus (so an unreadable existing file was treated as
 *  "new" — no backup taken, then DELETED on a later rollback). All three guards now match the safe path. */
function rawInstall(templateDir, projectDir, opts) {
  opts = opts || {};
  const dst = claudeDirOf(projectDir);
  if (!fs.existsSync(dst)) { console.error('not a project (.claude missing): ' + projectDir); return { ok: false, exitCode: 1, projectDir }; }
  // 3.4 fix: same preflight owner-rule migration as safeSyncProject — --unsafe still replaces
  // FORGE_STANDING_RULES.json below with no drift/conflict analysis at all, so this is the ONLY chance to
  // save a v2.7-era owner rule on this path. Never during --dry-run (writes nothing at all).
  const standingMigration = opts.dryRun ? [] : migrateOwnerStandingRules(projectDir);
  const allowlist = readOverrideAllowlist(projectDir); // S2: --unsafe must ALSO never touch a declared override
  const toChange = [];
  const skippedOverrides = [];
  const unreadable = [];
  let same = 0;
  for (const rel of listSystemFiles(templateDir)) {
    const src = path.join(templateDir, rel);
    if (!fs.existsSync(src)) continue;
    const out = safeJoin(dst, rel); // S2: containment guard — never resolve outside .claude/
    if (out == null) continue;
    if (isSymlinkPath(out) || !containmentSafe(dst, out)) continue; // S2: symlink/junction guard
    // F4 fix (2026-09-26 independent review, LOW) — see migrateOwnerStandingRules()'s doc comment: a
    // still-PENDING owner rule must never be replaced on this --unsafe path either, which has no
    // drift/conflict analysis at all to catch it otherwise.
    if (standingMigration.pending && rel === STANDING_RULES_REL) {
      console.error('forge-sync: WARNING — refusing to replace ' + STANDING_RULES_REL + ' this --unsafe install: an owner rule from a pre-v2.8.0 install is still sitting in it and could not be migrated into ' +
        STANDING_RULES_USER_REL + ' (see the warning above). Fix or remove that file, then re-run install so the owner rule can be moved to safety before this file is replaced.');
      continue;
    }
    if (allowlist.has(rel)) { skippedOverrides.push(rel); continue; } // S2: never touch a declared override
    const outStatus = fileStatus(out);
    if (outStatus.kind === 'unreadable') { unreadable.push({ rel, error: outStatus.error }); continue; }
    const oldHash = outStatus.kind === 'ok' ? outStatus.hash : null;
    const newHash = sha256(src);
    if (oldHash === newHash) { same++; continue; }
    toChange.push({ rel, oldHash, newHash, isNew: oldHash === null, overrideClass: null });
  }
  if (unreadable.length) { // S2: same B3-style policy — never silently treat "unreadable" as "new" (which would skip backup then DELETE it on rollback)
    const msg = 'refusing --unsafe install: ' + unreadable.length + ' existing system file(s) could not be read (never treated as "new"): ' + unreadable.map((u) => u.rel + ' (' + u.error + ')').join('; ');
    console.error(msg);
    return { ok: false, exitCode: 1, projectDir, reason: msg, unreadable };
  }
  if (opts.dryRun) {
    toChange.forEach((e) => console.log('  would update ' + e.rel));
    console.log('[dry] ' + path.basename(projectDir) + ': ' + toChange.length + ' would update, ' + same + ' current' + (skippedOverrides.length ? (', ' + skippedOverrides.length + ' expected override(s) preserved') : ''));
    return { ok: true, exitCode: 0, projectDir, copied: toChange.length, same, skippedOverrides };
  }
  const batchId = opts.batchId || ('unsafe-' + Date.now());
  const nowIso = opts.nowIso || new Date().toISOString();
  const plan = { toChange, expectedOverrides: skippedOverrides, unknownDrift: [], conflicts: [], skipped: [], unreadable: [], same };
  const backup = takeBackup(projectDir, batchId, plan, templateVersion(templateDir), nowIso, { centralBackupRoot: opts.centralBackupRoot, runId: opts.runId });
  if (!backup.ok) { // S8: clean refusal instead of an uncaught crash
    console.error(path.basename(projectDir) + ': --unsafe refused: backup could not be taken — ' + backup.error);
    return { ok: false, exitCode: 1, projectDir, reason: backup.error, backup };
  }
  const apply = applyPlanSafely(templateDir, projectDir, plan);
  if (!apply.ok) {
    const appliedManifest = subsetManifest(backup.manifest, apply.applied);
    try { restoreFromManifest(projectDir, backup.backupDir, appliedManifest); } catch { /* best-effort */ }
    console.error(path.basename(projectDir) + ': --unsafe write FAILED (' + apply.error + ') -> rolled back applied subset (backup at ' + backup.backupDir + ')');
    return { ok: false, exitCode: 1, projectDir, applyError: apply.error, backup };
  }
  const ver = { forge_version: templateVersion(templateDir), synced_at: nowIso, template: templateDir, system_files: listSystemFiles(templateDir).length };
  writeAtomic(path.join(dst, 'FORGE_VERSION.json'), JSON.stringify(ver, null, 2) + '\n'); // atomic here too (audit #22)
  console.log(path.basename(projectDir) + ': ' + toChange.length + ' updated (UNSAFE — no canary/no validation), ' + same + ' current' + (skippedOverrides.length ? (', ' + skippedOverrides.length + ' expected override(s) preserved') : '') + ' -> version ' + ver.forge_version + ' · backup at ' + backup.backupDir);
  return { ok: true, exitCode: 0, projectDir, copied: toChange.length, same, backup, skippedOverrides };
}

function status(templateDir, projectDir, verbose) {
  const dst = claudeDirOf(projectDir);
  const tv = templateVersion(templateDir);
  let vf = {}; try { vf = JSON.parse(fs.readFileSync(path.join(dst, 'FORGE_VERSION.json'), 'utf8')); } catch { /* none */ }
  const drift = listSystemFiles(templateDir).filter((rel) => fs.existsSync(path.join(templateDir, rel)) && sha256(path.join(templateDir, rel)) !== sha256(path.join(dst, rel)));
  console.log(path.basename(projectDir) + ': installed=' + (vf.forge_version || 'none') + ' · template=' + tv + ' · ' + (drift.length ? ('DRIFT (' + drift.length + ' files behind) — run: forge-sync install') : 'up to date ✓'));
  if (drift.length && verbose) drift.forEach((f) => console.log('    behind: ' + f));
  return drift.length ? 1 : 0;
}

// Bounded-depth recursive project scan. Skips heavy/irrelevant dirs AND any dot-prefixed directory (which is
// how the dedicated canary at .forge-canary/ stays structurally excluded from real-project discovery).
function findForgeProjects(root, maxDepth) {
  maxDepth = maxDepth == null ? 3 : maxDepth;
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (fs.existsSync(path.join(dir, '.claude', 'forge-dashboard'))) { out.push(dir); return; }
    if (depth === maxDepth) return;
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  let top = []; try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of top) { if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(root, e.name), 1); }
  return out;
}

// ---- dedicated, disposable sync canary (never one of the real 12 projects) ----
function dedicatedCanaryDir(rootDir) { return path.join(rootDir, CANARY_DIR_NAME); }
/** canary-init — create/refresh the dedicated canary project scaffold. M5: WIPES any prior canary state
 *  first (a canary that accumulates its own receipt/FORGE_VERSION/forge-runs across calls is not a canary —
 *  it would eventually accumulate a false-drift baseline of its own and abort every batch at stage 0).
 *  opts.doctorSource lets a test/CLI point it at a specific forge-doctor.cjs (real or stub); without one, the
 *  canary has no doctor and validation falls back to node --check on synced .cjs files. */
function canaryInit(templateDir, rootDir, opts) {
  opts = opts || {};
  const dir = dedicatedCanaryDir(rootDir);
  if (path.basename(dir) === CANARY_DIR_NAME) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort wipe */ } }
  fs.mkdirSync(path.join(dir, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'FORGE_CANARY_MARKER.json'), JSON.stringify({
    canary: true, createdAt: opts.nowIso || new Date().toISOString(),
    purpose: 'disposable dedicated sync canary — never a real project, never counted by findForgeProjects, wiped fresh on every canary-init',
  }, null, 2) + '\n', 'utf8');
  if (opts.doctorSource && fs.existsSync(opts.doctorSource)) fs.copyFileSync(opts.doctorSource, path.join(dir, '.claude', 'forge-bin', 'forge-doctor.cjs'));
  return { dir, refreshed: true };
}

function abortNote(result) { // M8: never say "(if applicable)" — say plainly whether anything was rolled back.
  // Three distinct shapes since H2: (1) blocked/refused before any write -> nothing to roll back; (2) ok:true
  // but STILL has unresolved drift on THIS project (some files synced fine, others left drifted) -> the
  // project's OWN sync succeeded and is stamped, nothing needs rolling back, but the batch still can't proceed
  // past it; (3) a genuine post-write failure -> rolled back (or not confirmed).
  if (result.blocked || result.refused) return 'nothing was written (blocked/refused before any write — never applied, so there was nothing to roll back)';
  if (result.ok) return 'this project\'s own sync succeeded (and is stamped) — but it still has unresolved drift/conflict blocking the batch from proceeding; nothing to roll back here';
  if (result.rolledBack) return 'rolled back';
  if (result.rollbackError) return 'ROLLBACK NOT CONFIRMED (' + result.rollbackError + ')';
  return 'rollback status unknown — see diagnostics';
}
function printRemediation(rootDir, batchId, centralBackupRoot, processedSoFar) {
  const alreadySynced = (processedSoFar || []).filter((pr) => pr.ok).map((pr) => path.basename(pr.projectDir));
  console.error('Already synced to the new version before this abort: ' + (alreadySynced.length ? alreadySynced.join(', ') : '(none)'));
  console.error('Remediation: node ' + quoteArg(__filename) + ' rollback-batch ' + batchId + ' ' + quoteArg(rootDir) + (centralBackupRoot ? (' --central-backup-root ' + quoteArg(centralBackupRoot)) : ''));
}

/**
 * runSyncAll — the safe multi-project orchestrator. opts: { projects (explicit override array, else
 * discovered from rootDir), canaryName (representative real project), stageSize, dryRun, forceOverwrite,
 * unsafe, batchId, nowIso, centralBackupRoot, runId, canaryDoctorSource, allowDegraded, doctorTimeoutMs }.
 * Flow: dedicated canary (ALWAYS first, never a real project) -> ONE representative real project ->
 * staged ladder (2 -> 3 -> stageSize thereafter). ANY validation failure OR unresolved unknown_drift/conflict
 * (without --force-overwrite) rolls back that project and STOPS the whole batch. H3c: prints a per-project
 * summary as each project is processed, and on any abort prints which projects are already on the new
 * version plus the literal rollback-batch remediation command.
 */
function runSyncAll(templateDir, rootDir, opts) {
  opts = opts || {};
  const nowIso = opts.nowIso || new Date().toISOString();
  const batchId = opts.batchId;
  const runId = opts.runId || null;
  const centralBackupRoot = opts.centralBackupRoot;
  const hasUnresolvedDrift = (r) => !opts.forceOverwrite && r && r.plan && (r.plan.unknownDrift.length > 0 || r.plan.conflicts.length > 0);
  const syncOpts = { forceOverwrite: opts.forceOverwrite, batchId, nowIso, centralBackupRoot, runId, allowDegraded: opts.allowDegraded, doctorTimeoutMs: opts.doctorTimeoutMs };
  // The dedicated canary is Forge's own disposable, synthetic smoke-test scaffold — in REAL production use it
  // always inherits the template's real forge-doctor.cjs (a SYSTEM file) on its very first sync, so the
  // degraded fallback essentially never triggers for it there. Only a template that genuinely lacks a doctor
  // (e.g. a minimal test fixture) hits the fallback for the canary specifically; treat that leniently
  // (allowDegraded) so the canary's job — proving the SYNC MECHANISM is safe — isn't blocked by the absence of
  // a doctor it doesn't own. Real projects (representative + staged) always respect the caller's actual
  // --allow-degraded flag (default strict) via plain `syncOpts`. seedRunForValidation: true is the OTHER
  // canary-only leniency (see seedCanaryRun's doc comment) — logs one real run_started event into the
  // canary's own just-synced forge-runs/ before validation runs, since the canary structurally never
  // accumulates real run history the way an actual project does. Real projects NEVER get this — their
  // forge-runs/ stays exactly what real /forge usage produced.
  const canarySyncOpts = Object.assign({}, syncOpts, { allowDegraded: true, seedRunForValidation: true });
  /** S6 FIX: sync-all's CLI wrapper already holds the ROOT lock for the whole batch, but that alone doesn't
   *  stop a concurrent single-project `install <root>/proj` (which only locks THAT project's own
   *  `.claude/.forge-sync.lock`, a different path) from racing sync-all on the same files. Hold each
   *  project's OWN lock for exactly the duration this batch is writing to it, in addition to the root lock. */
  const lockedSync = (p, sOpts) => {
    const lock = acquireLock(claudeDirOf(p));
    if (!lock.ok) return { ok: false, refused: true, projectDir: p, reason: 'S6: could not acquire project lock for ' + p + ': ' + lock.reason };
    try { return safeSyncProject(templateDir, p, sOpts); } // settings.json merge is now internal to safeSyncProject (WP22)
    finally { releaseLock(lock); }
  };

  if (opts.unsafe) {
    console.warn('*** --unsafe: legacy-style sync (NO canary, NO validation) — a real backup is still taken per project (never "no undo") ***');
    const projects = Array.isArray(opts.projects) ? opts.projects : findForgeProjects(rootDir);
    let bad = 0; const results = [];
    for (const p of projects) {
      const r = rawInstall(templateDir, p, { dryRun: opts.dryRun, batchId, nowIso, centralBackupRoot, runId });
      // SUCCESS-WITHOUT-SETTINGS (wp-f2): sync-all --unsafe used to call ONLY rawInstall, so an --unsafe
      // batch never installed/reported settings.json at all — single-project `install --unsafe` already did.
      // Both now share this exact step.
      let settingsResult = null;
      if (r.ok) { settingsResult = syncProjectSettings(templateDir, p, { dryRun: opts.dryRun }); r.settingsMerge = settingsResult; printSettingsMergeResult(p, settingsResult); }
      results.push(r);
      if (!r.ok || settingsMergeFailed(settingsResult)) bad++;
    }
    return { ok: bad === 0, unsafe: true, batchId, projects: results };
  }

  if (opts.dryRun) {
    // True dry-run: ZERO filesystem writes, including scaffolding. buildPlan()/preflight() are fully
    // read-only and tolerate a project directory that doesn't exist yet -> the dedicated canary's plan can
    // be previewed WITHOUT ever calling canaryInit() (which would create real files on disk).
    const dedicatedPlan = buildPlan(templateDir, dedicatedCanaryDir(rootDir), { forceOverwrite: !!opts.forceOverwrite });
    const projects = Array.isArray(opts.projects) ? opts.projects : findForgeProjects(rootDir);
    // DRY-RUN-MUTATION (wp-f2): sync-all's dry-run used to keep ONLY `.plan` from safeSyncProject's dry-run
    // result, discarding `.settingsMerge` — so the settings.json preview a REAL run would perform (create/
    // merge/refuse) never appeared in a dry-run at all. Kept here too now.
    const plans = projects.map((p) => {
      const r = safeSyncProject(templateDir, p, Object.assign({}, syncOpts, { dryRun: true }));
      return { projectDir: p, plan: r.plan, settingsMerge: r.settingsMerge };
    });
    return { ok: true, dryRun: true, batchId, dedicatedCanary: { projectDir: dedicatedCanaryDir(rootDir), plan: dedicatedPlan }, projects: plans };
  }

  // Stage 0: dedicated canary — MANDATORY, always first, structurally never a real project.
  canaryInit(templateDir, rootDir, { nowIso, doctorSource: opts.canaryDoctorSource });
  const dedicatedDir = dedicatedCanaryDir(rootDir);
  console.log('stage 0 (dedicated canary): ' + dedicatedDir);
  const dedicatedResult = lockedSync(dedicatedDir, canarySyncOpts);
  printSafeSyncResult(dedicatedDir, dedicatedResult);
  if (!dedicatedResult.ok || hasUnresolvedDrift(dedicatedResult)) {
    console.error('DEDICATED CANARY ' + (dedicatedResult.ok ? 'HAS UNRESOLVED DRIFT' : 'FAILED') + ' -> ' + abortNote(dedicatedResult) + '. ABORTING before touching ANY real project.');
    printRemediation(rootDir, batchId, centralBackupRoot, []);
    return { ok: false, aborted: true, stage: 'dedicated-canary', batchId, dedicatedCanary: dedicatedResult, projects: [] };
  }

  const projects = Array.isArray(opts.projects) ? opts.projects : findForgeProjects(rootDir);
  if (!projects.length) { console.log('no real Forge project found under ' + rootDir); return { ok: true, batchId, dedicatedCanary: dedicatedResult, projects: [] }; }

  // Stage 1: ONE representative real project.
  let repIdx = 0;
  if (opts.canaryName) {
    const idx = projects.findIndex((p) => path.basename(p) === opts.canaryName || p === opts.canaryName);
    if (idx === -1) { console.error('forge-sync: --canary ' + opts.canaryName + ' not found among discovered projects'); return { ok: false, usageError: true, batchId, dedicatedCanary: dedicatedResult, projects: [] }; }
    repIdx = idx;
  }
  const repDir = projects[repIdx];
  const rest = projects.filter((_, i) => i !== repIdx);
  console.log('stage 1 (representative real project): ' + path.basename(repDir));
  const repResult = lockedSync(repDir, syncOpts);
  printSafeSyncResult(repDir, repResult);
  const processed = [repResult];
  if (!repResult.ok || hasUnresolvedDrift(repResult)) {
    console.error('REPRESENTATIVE PROJECT ' + (repResult.ok ? 'HAS UNRESOLVED DRIFT' : 'FAILED') + ' -> ' + abortNote(repResult) + '. ABORTING batch. Remaining ' + rest.length + ' project(s) untouched.');
    printRemediation(rootDir, batchId, centralBackupRoot, processed);
    return { ok: false, aborted: true, stage: 'representative', batchId, dedicatedCanary: dedicatedResult, projects: processed };
  }

  // Ladder: 2 -> 3 -> --stage-size (default 3) thereafter.
  const ladder = [2, 3];
  const stageSize = opts.stageSize > 0 ? opts.stageSize : 3;
  let idx2 = 0, stopped = false, stageNum = 2;
  while (idx2 < rest.length && !stopped) {
    const size = ladder.length ? ladder.shift() : stageSize;
    const stage = rest.slice(idx2, idx2 + size);
    console.log('stage ' + stageNum + ' (' + stage.length + ' project(s), ladder-size ' + size + ')');
    for (const p of stage) {
      const r = lockedSync(p, syncOpts);
      printSafeSyncResult(p, r);
      processed.push(r);
      if (!r.ok || hasUnresolvedDrift(r)) {
        console.error('VALIDATION/DRIFT FAILURE for ' + path.basename(p) + ' -> ' + abortNote(r) + '. STOPPING batch.');
        printRemediation(rootDir, batchId, centralBackupRoot, processed);
        stopped = true; break;
      }
    }
    idx2 += size; stageNum++;
  }
  const ok = processed.every((r) => r.ok && !hasUnresolvedDrift(r));
  return { ok, aborted: stopped, batchId, dedicatedCanary: dedicatedResult, representative: repResult, projects: processed };
}

function printPlanSummary(plan) {
  console.log('  to-change: ' + plan.toChange.length + (plan.toChange.length ? ' (' + plan.toChange.map((e) => e.rel).join(', ') + ')' : ''));
  if (plan.expectedOverrides && plan.expectedOverrides.length) console.log('  expected overrides (never touched): ' + plan.expectedOverrides.join(', '));
  if (plan.unknownDrift && plan.unknownDrift.length) console.log('  UNKNOWN DRIFT (blocked, use --force-overwrite): ' + plan.unknownDrift.join(', '));
  if (plan.conflicts && plan.conflicts.length) console.log('  CONFLICT — both changed (blocked, use --force-overwrite): ' + plan.conflicts.join(', '));
  if (plan.skipped && plan.skipped.length) console.log('  skipped (symlink/unsafe): ' + plan.skipped.map((s) => s.rel + ':' + s.reason).join(', '));
  if (plan.unreadable && plan.unreadable.length) console.log('  UNREADABLE (refuses the whole sync): ' + plan.unreadable.map((u) => u.rel).join(', '));
  console.log('  unchanged: ' + plan.same);
}
function printSafeSyncResult(projectDir, r) {
  const name = path.basename(projectDir);
  if (!r.ok && r.refused) { console.error(name + ': REFUSED — ' + r.reason); return; }
  if (r.dryRun) { console.log('[dry-run] ' + name + ':'); printPlanSummary(r.plan); printSettingsMergeResult(projectDir, r.settingsMerge); return; }
  if (r.blocked) { console.error(name + ': BLOCKED: ' + r.plan.unknownDrift.length + ' drifted / ' + r.plan.conflicts.length + ' conflicted (use --force-overwrite or declare .claude/config/forge-overrides.json)'); return; }
  if (r.refusedPartialDrift) { // B3: never silently stamp a partially-synced project
    console.error(name + ': BLOCKED — ' + r.plan.unknownDrift.length + ' drifted / ' + r.plan.conflicts.length + ' conflicted file(s) prevent a full sync (use --force-overwrite or declare .claude/config/forge-overrides.json); safely-syncable file(s) were rolled back, NOT partially stamped');
    if (r.plan.unknownDrift.length) console.error('  UNKNOWN DRIFT: ' + r.plan.unknownDrift.join(', '));
    if (r.plan.conflicts.length) console.error('  CONFLICT: ' + r.plan.conflicts.join(', '));
    return;
  }
  if (r.noop) { console.log(name + ': up to date (' + r.plan.same + ' unchanged)'); if (r.plan.unknownDrift.length || r.plan.conflicts.length) printPlanSummary(r.plan); printSettingsMergeResult(projectDir, r.settingsMerge); return; }
  if (r.ok) {
    const note = r.outcome && r.outcome.alreadyRedSkipped ? ' [pre-existing unrelated failure(s), not attributed to this sync]' : (r.outcome && r.outcome.degradedAllowed ? ' [DEGRADED validator, --allow-degraded]' : '');
    console.log(name + ': ' + r.plan.toChange.length + ' updated, ' + r.plan.same + ' current -> version ' + r.receipt.templateVersionTo + ' · validation: ' + r.validation.tool + ' OK' + note);
    if (r.plan.expectedOverrides.length) console.log('  expected overrides preserved: ' + r.plan.expectedOverrides.join(', '));
    printSettingsMergeResult(projectDir, r.settingsMerge);
  } else {
    const failLabel = r.validation ? (r.validation.timedOut ? (r.validation.tool + ' TIMED OUT (blocked, not a confirmed failure)') : (r.validation.tool + ', exit ' + r.validation.exitCode)) : (r.applyError || 'unknown');
    let rbNote;
    if (r.rollbackError) rbNote = 'rollback ERROR: ' + r.rollbackError;
    else if (r.restored && r.restored.refusedDivergence) rbNote = 'rollback REFUSED (content diverged since this sync — see diagnostics)';
    else if (r.restored && r.restored.ok === false) rbNote = 'PARTIAL ROLLBACK — MANUAL RECOVERY REQUIRED (' + (r.restored.failed || []).length + ' file(s); backup at ' + (r.backup ? r.backup.backupDir : '?') + ')';
    else rbNote = 'rolled back ' + (r.restored ? r.restored.restored.length : 0) + ' file(s)';
    console.error(name + ': FAILED (' + failLabel + ') -> ' + rbNote);
  }
}

/** parseArgs — M1: a value-taking flag (e.g. --run-id) that is followed by ANOTHER flag or nothing at all
 *  (e.g. `--run-id --dry-run`) must be refused, not silently swallow the next flag as its value (which would
 *  leave --dry-run's own flag unset while a real, non-dry-run sync proceeds). Returns argError (non-null on
 *  a bad value) for the caller to turn into a usage exit(2). */
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  let argError = null;
  const takeValue = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { if (!argError) argError = 'missing value for ' + name; return { value: null, consumed: 0 }; }
    return { value: v, consumed: 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force-overwrite') flags.forceOverwrite = true;
    else if (a === '--force-all') flags.forceAll = true;
    else if (a === '--force') flags.force = true; // S5: adopt's explicit opt-in to replace an existing baseline
    else if (a === '--unsafe') flags.unsafe = true;
    else if (a === '--verbose') flags.verbose = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--allow-degraded') flags.allowDegraded = true;
    else if (a === '--no-central-backup') flags.noCentralBackup = true;
    else if (a === '--force-rollback-newer') flags.forceRollbackNewer = true;
    else if (a === '--resume-batch') flags.resumeBatch = true;
    else if (a === '--canary') { const r = takeValue(i, '--canary'); flags.canary = r.value; i += r.consumed; }
    else if (a === '--stage-size') { // S8: a non-numeric value must be a usage error, not a silent NaN-fallback-to-default
      const r = takeValue(i, '--stage-size'); i += r.consumed;
      if (r.value != null) { const n = Number(r.value); if (!Number.isFinite(n)) { if (!argError) argError = '--stage-size must be a number, got: ' + r.value; } else flags.stageSize = n; }
    }
    else if (a === '--batch-id' || a === '--batch') { const r = takeValue(i, '--batch-id'); flags.batchId = r.value; i += r.consumed; }
    else if (a === '--central-backup-root') { const r = takeValue(i, '--central-backup-root'); flags.centralBackupRoot = r.value; i += r.consumed; }
    else if (a === '--run-id') { const r = takeValue(i, '--run-id'); flags.runId = r.value; i += r.consumed; }
    else if (a === '--doctor-timeout') { // S8: same numeric-validation treatment as --stage-size
      const r = takeValue(i, '--doctor-timeout'); i += r.consumed;
      if (r.value != null) { const n = Number(r.value); if (!Number.isFinite(n)) { if (!argError) argError = '--doctor-timeout must be a number, got: ' + r.value; } else flags.doctorTimeout = n; }
    }
    else if (!a.startsWith('--')) pos.push(a);
  }
  return { flags, pos, argError };
}

/** syncProjectSettings — v2.7.0 WP22 (owner directive 2026-09-24, "alles standaard aan" / never "merge by
 *  hand"): after this project's system FILES are synced, also merge the template's `settings.json` into the
 *  project's own — absent -> create (a copy); present -> merge (forge-settings-merge.cjs, foreign hooks/
 *  rules kept); malformed/unexpected shape -> refused-safe, reported, NEVER fails the file sync. Deliberately
 *  independent of the file-sync backup/receipt/rollback machinery above: settings.json is user-owned content,
 *  not a SYSTEM file (see the SYSTEM list's own "does not itself write settings.json" comment, now
 *  superseded by this function), so it gets its own dedicated merge tool and its own `.forge-bak-<ts>`
 *  backup instead of joining the receipt ledger. A template without a settings.json, or a merge tool that
 *  cannot load, is a silent, honestly-labelled skip — this step must never turn a successful file sync into
 *  a failure. */
function syncProjectSettings(templateDir, projectDir, opts) {
  opts = opts || {};
  const srcPath = path.join(templateDir, 'settings.json');
  if (!fs.existsSync(srcPath)) return { ok: true, skipped: 'no-template-settings' };
  const dst = claudeDirOf(projectDir);
  // PROJECT-DIRECTORY-ESCAPE (wp-f2, 2026-09-24 Codex re-check): the settings step runs in EVERY branch
  // (dry-run, the no-op branch, and the real success path — all three call this one function), so the SAME
  // containment/symlink guard the per-file sync path already applies to every system file is applied here
  // too, once, rather than only in the "normal" branch. A `.claude` that is itself a symlink/junction (or
  // resolves outside its own project) refuses instead of merging settings.json across that boundary.
  if (isSymlinkPath(dst) || !containmentSafe(projectDir, dst)) {
    return { ok: false, skipped: 'refused-containment', error: '.claude resolves outside its project (or is itself a symlink/junction) — refusing to merge settings.json across that boundary' };
  }
  let mergeTool;
  try { mergeTool = require('./forge-settings-merge.cjs'); }
  catch (e) { return { ok: false, skipped: 'merge-tool-unavailable', error: e.message }; }
  const dstPath = path.join(dst, 'settings.json');
  try { return mergeTool.applySettingsMerge({ target: dstPath, source: srcPath, dryRun: !!opts.dryRun, projectRoot: dst }); }
  catch (e) { return { ok: false, skipped: 'merge-error', error: e.message }; }
}
/** printSettingsMergeResult — one plain status line for the CLI/sync-all output, never throws, never blocks
 *  the caller on a skip/refusal (see syncProjectSettings's own doc comment for why a refusal is reported,
 *  not fatal). */
function printSettingsMergeResult(projectDir, r) {
  const name = path.basename(projectDir);
  if (!r) return;
  if (r.skipped) { if (r.skipped !== 'no-template-settings') console.error(name + ': settings.json merge skipped (' + r.skipped + (r.error ? ': ' + r.error : '') + ')'); return; }
  const dupNote = (rr) => (rr.duplicate_matchers && rr.duplicate_matchers.length ? (' (NOTE: ' + rr.duplicate_matchers.length + ' pre-existing duplicate matcher group(s) found — not auto-repaired)') : '');
  if (r.status === 'created') console.log(name + ': settings.json created (from template)');
  else if (r.status === 'would-create') console.log('[dry-run] ' + name + ': settings.json would be created (from template)');
  else if (r.status === 'noop') console.log(name + ': settings.json already merged' + dupNote(r));
  else if (r.status === 'would-merge') console.log('[dry-run] ' + name + ': settings.json would merge — +' + r.added.length + ' hook entry/entries, ' + r.adjusted.length + ' timeout fix(es), ' + (Array.isArray(r.upgraded) ? r.upgraded.length : 0) + ' hook command update(s), +' + r.deny_added.length + ' deny rule(s)');
  else if (r.status === 'merged') console.log(name + ': settings.json merged — +' + r.added.length + ' hook entry/entries, ' + r.adjusted.length + ' timeout fix(es), ' + (Array.isArray(r.upgraded) ? r.upgraded.length : 0) + ' hook command update(s), +' + r.deny_added.length + ' deny rule(s); your own entries kept; backup: ' + r.backupPath + dupNote(r));
  else if (r.status === 'refused' || r.status === 'would-refuse') console.error(name + ': ' + r.message);
  // SUCCESS-WITHOUT-SETTINGS (wp-f2): a malformed TEMPLATE source (usage-error) used to be silently omitted
  // from every printer — the ONLY status this function never printed anything for.
  else if (r.status === 'usage-error') console.error(name + ': settings.json merge could not run (' + r.message + ')');
}

module.exports = {
  listSystemFiles, sha256, sha256Normalized, normalizeEolBuffer, fileStatus, templateVersion, claudeDirOf, safeJoin, isSymlinkPath,
  containmentSafe, projectId, receiptPath, readReceipt, writeReceipt, writeAtomic, receiptLastTemplateHashMap,
  overridesAllowlistPath, readOverrideAllowlist, migrateOwnerStandingRules,
  preflight, buildPlan, fullFileManifest, aggregateManifestHash,
  versionFilePath, readVersionFile, backupDirFor, centralBackupDir, takeBackup, applyPlanSafely, runValidation,
  decideValidationOutcome, evidenceOk, condenseDoctorSummary, regressionCheck, seedCanaryRun, seedProjectScaffold, undoScaffold,
  doctorProvenance, installerSyntaxGate, copyNoFollow,
  verifyBackupIntegrity, loadTrustedManifest, findNewerOverlappingBatches, restoreFromManifest, subsetManifest,
  journalPath, latestBatchId, acquireLock, releaseLock, lockPathFor,
  rollbackProject, rollbackBatch, safeSyncProject, adoptProject, rawInstall, status, findForgeProjects,
  dedicatedCanaryDir, canaryInit, runSyncAll, parseArgs, CANARY_DIR_NAME,
  syncProjectSettings, printSettingsMergeResult, defaultCentralBackupRoot,
};

// ---- CLI ----
if (require.main === module) {
  const GLOBAL_TEMPLATE = path.join(os.homedir(), '.claude', 'forge', 'template', '.claude');
  const OWN_CLAUDE = path.resolve(__dirname, '..');
  const TEMPLATE = process.env.FORGE_SYNC_TEMPLATE_DIR
    ? path.resolve(process.env.FORGE_SYNC_TEMPLATE_DIR)
    : (fs.existsSync(GLOBAL_TEMPLATE) ? GLOBAL_TEMPLATE : OWN_CLAUDE);
  // FAIL CLOSED WHEN THE CANONICAL TEMPLATE IS MISSING (broad Codex audit #23, fixed 2026-08-05).
  // The fallback above quietly turns THIS project's own .claude into "the template". Installing into
  // another project then copies this project's governance and identity into it — a cross-project
  // contamination that looks like a normal successful sync. The fallback is legitimate for one case
  // only: operating on this very project (status / self-refresh). Any OTHER target must name a template
  // explicitly, so nobody can seed project B from project A by accident.
  const TEMPLATE_IS_FALLBACK = !process.env.FORGE_SYNC_TEMPLATE_DIR && !fs.existsSync(GLOBAL_TEMPLATE);
  function refuseForeignTargetOnFallback(targetDir) {
    if (!TEMPLATE_IS_FALLBACK || !targetDir) return;
    const ownProject = path.resolve(OWN_CLAUDE, '..');
    if (path.resolve(targetDir) === ownProject) return; // self-operation: fine
    console.error('forge-sync: REFUSING to sync "' + path.resolve(targetDir) + '" — the canonical template is missing');
    console.error('  (' + GLOBAL_TEMPLATE + ' does not exist), so the only template available is THIS project\'s own .claude.');
    console.error('  Using it would copy this project\'s governance and identity into another project.');
    console.error('  Install the global template, or pass one explicitly: FORGE_SYNC_TEMPLATE_DIR=<path-to-template/.claude>');
    process.exit(2);
  }

  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  const { flags, pos, argError } = parseArgs(argv.slice(1));

  function exitUsage(msg) { console.error(msg); process.exit(2); }

  if (argError) exitUsage('forge-sync: ' + argError); // M1

  const defaultProject = pos[0] || path.resolve(__dirname, '..', '..'); // status/doctor only: read-only, low risk
  const batchId = flags.batchId || ('sync-' + Date.now());

  if (cmd === 'status' || cmd === 'doctor') {
    /** 2026-09-23 (external audit II-A): with no canonical template, TEMPLATE silently became this
     *  project's OWN .claude, and status compared the tree with itself — printing "up to date ✓" on
     *  every fresh install, forever, because a tree can never be behind itself. That is a tautology, not
     *  a check. Say so plainly instead of pretending the update check ran. */
    if (TEMPLATE_IS_FALLBACK) {
      console.log('forge-sync status: NO canonical template at ' + GLOBAL_TEMPLATE);
      console.log('  Without it this tree can only be compared with itself, which can never detect that it is behind.');
      console.log('  Run the installer without --project-only to create the template, or set FORGE_SYNC_TEMPLATE_DIR.');
      let vfStatus = {}; try { vfStatus = JSON.parse(fs.readFileSync(path.join(claudeDirOf(defaultProject), 'FORGE_VERSION.json'), 'utf8')); } catch { /* none */ }
      console.log('  (installed version: ' + (vfStatus.forge_version || 'none') + ' · update check: NOT PERFORMED)');
      process.exit(0);
    }
    process.exit(status(TEMPLATE, defaultProject, flags.verbose));
  } else if (cmd === 'install') {
    if (!pos[0]) exitUsage('usage: forge-sync install <projectDir> [--dry-run] [--force-overwrite] [--unsafe] [--batch-id <id>] [--central-backup-root <dir>] [--no-central-backup] [--run-id <id>] [--allow-degraded] [--doctor-timeout <ms>] [--resume-batch]');
    /** 2026-09-23 (external audit II-B): on a machine WITHOUT the canonical template, the template-refusal
     *  below fired before anything looked at the target — so a user pointing `install` at a folder that
     *  simply has no .claude/ yet got "the canonical template is missing" instead of the one message that
     *  tells them what to do ("not a project (.claude missing) — run the installer"). The most specific,
     *  actionable diagnosis goes first. */
    if (fs.existsSync(pos[0]) && !fs.existsSync(claudeDirOf(pos[0]))) {
      console.error('forge-sync: not a project (.claude missing): ' + path.resolve(pos[0]) + ' — forge-sync updates an EXISTING Forge project and never creates .claude/ itself. For a FIRST install run the installer: `bash install.sh --project "' + path.resolve(pos[0]) + '"` (or install.ps1 on Windows).');
      process.exit(2);
    }
    refuseForeignTargetOnFallback(pos[0]); // audit #23: never seed another project from this one
    // N10 fix (2026-09-26): default central backup hub now lives INSIDE the project — see
    // defaultCentralBackupRoot()'s own comment for why (was <parent-of-project>/.forge-backup-hub).
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || defaultCentralBackupRoot(pos[0]));
    if (flags.dryRun && centralBackupRoot) console.log('[dry-run] backups would also be written to: ' + centralBackupRoot + ' (inside the project — pass --no-central-backup to skip this second copy, or --central-backup-root to point it elsewhere)');
    const lock = flags.dryRun ? { ok: true, lockPath: null } : acquireLock(claudeDirOf(pos[0])); // M2
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let exitCode = 1;
    try {
      if (flags.unsafe) {
        console.warn('*** --unsafe: legacy-style install for ' + pos[0] + ' — NO canary, NO validation; a real backup is still taken (never "no undo") ***');
        const r = rawInstall(TEMPLATE, pos[0], { dryRun: flags.dryRun, batchId, centralBackupRoot, runId: flags.runId });
        let settingsResult = null;
        if (r.ok) { settingsResult = syncProjectSettings(TEMPLATE, pos[0], { dryRun: flags.dryRun }); printSettingsMergeResult(pos[0], settingsResult); }
        // SUCCESS-WITHOUT-SETTINGS (wp-f2): --unsafe must not exit 0 when the file copy succeeded but the
        // required settings.json gate failed/was refused.
        exitCode = (r.ok && !settingsMergeFailed(settingsResult)) ? 0 : 1;
      } else {
        const r = safeSyncProject(TEMPLATE, pos[0], {
          dryRun: flags.dryRun, forceOverwrite: flags.forceOverwrite, batchId, centralBackupRoot, runId: flags.runId,
          allowDegraded: flags.allowDegraded, doctorTimeoutMs: flags.doctorTimeout, resumeBatch: flags.resumeBatch,
          refuseOnUnresolvedDrift: true, // B3: a direct single-project install is all-or-nothing (sync-all is not)
        }); // settings.json merge is internal to safeSyncProject (WP22) — r.settingsMerge is already set, and
        // r.ok already folds settingsMergeFailed(r.settingsMerge) in (see safeSyncProject's own return sites)
        printSafeSyncResult(pos[0], r);
        exitCode = (r.ok || r.dryRun) ? 0 : 1;
      }
    } finally { releaseLock(lock); }
    process.exit(exitCode);
  } else if (cmd === 'adopt') {
    if (!pos[0]) exitUsage('usage: forge-sync adopt <projectDir> [--dry-run] [--force]');
    const lock = flags.dryRun ? { ok: true, lockPath: null } : acquireLock(claudeDirOf(pos[0])); // S6: adopt writes the receipt — must lock like install does
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let r;
    try { r = adoptProject(TEMPLATE, pos[0], { dryRun: flags.dryRun, force: flags.force }); }
    finally { releaseLock(lock); }
    if (!r.ok) {
      console.error(r.reason);
      process.exit(1);
    }
    if (r.priorBaselineCount > 0) console.log('  NOTE: this replaces an existing baseline of ' + r.priorBaselineCount + ' file(s) — these WILL be overwritten by the next sync' + (r.snapshotPath ? (' (pre-adopt receipt snapshotted to ' + r.snapshotPath + ')') : ''));
    console.log((r.dryRun ? '[dry-run] ' : '') + 'adopted baseline for ' + path.basename(path.resolve(pos[0])) + ': ' + r.knownHashesCount + ' file(s) baselined' + (r.dryRun ? ' (NOT written)' : ''));
    if (r.differing.length) {
      console.log('  ' + r.differing.length + ' file(s) differ from the template — triage into .claude/config/forge-overrides.json if intentionally project-owned:');
      r.differing.forEach((rel) => console.log('    ' + rel));
    } else console.log('  no files differ from the template.');
    process.exit(0);
  } else if (cmd === 'list') {
    const rootDir = pos[0] || process.env.FORGE_SYNC_ROOT; // B6: no ~/Documents default
    if (!rootDir) exitUsage('usage: forge-sync list <rootDir> (root required — pass a positional root or set FORGE_SYNC_ROOT; no home-dir default)');
    const ps = findForgeProjects(rootDir);
    console.log(ps.length + ' Forge project(s) under ' + rootDir + ':');
    ps.forEach((p) => console.log('  ' + p));
    process.exit(0);
  } else if (cmd === 'canary-init') {
    const rootDir = pos[0] || process.env.FORGE_SYNC_ROOT; // B6
    if (!rootDir) exitUsage('usage: forge-sync canary-init <rootDir> (root required — pass a positional root or set FORGE_SYNC_ROOT; no home-dir default)');
    const r = canaryInit(TEMPLATE, rootDir, {});
    console.log('dedicated canary ready at ' + r.dir);
    process.exit(0);
  } else if (cmd === 'sync-all') {
    const rootDir = pos[0] || process.env.FORGE_SYNC_ROOT; // B6
    if (!rootDir) exitUsage('usage: forge-sync sync-all <rootDir> [...] (root required — pass a positional root or set FORGE_SYNC_ROOT; no home-dir default)');
    /** Argument validation comes BEFORE any environment check (2026-09-23, external audit II-B): the
     *  template-refusal used to sit in front of the --force-overwrite/--force-all usage gate, so on a
     *  machine without the canonical template a plain flag mistake was reported as a template problem, and
     *  the usage gate itself was unreachable — its tests failed on every fresh install. Exit codes are now
     *  distinct as well: 2 = you typed it wrong (usage), 3 = the environment cannot do it (no template). */
    if (flags.forceOverwrite && !flags.forceAll) exitUsage('forge-sync: --force-overwrite in sync-all requires the explicit --force-all co-flag (prevents an accidental blanket override across every discovered project)');
    // audit #23: without a canonical template, sync-all would seed EVERY discovered project from this
    // one project's own .claude — the widest possible cross-project contamination. Fail closed.
    if (TEMPLATE_IS_FALLBACK) {
      console.error('forge-sync: REFUSING sync-all — the canonical template is missing (' + GLOBAL_TEMPLATE + '), so this project\'s own .claude would become the template for every discovered project. Install the global template (install.sh / install.ps1 without --project-only creates it), or set FORGE_SYNC_TEMPLATE_DIR explicitly.');
      process.exit(3);
    }
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || path.join(rootDir, '.forge-backup-hub')); // B5
    if (flags.unsafe) console.warn('*** --unsafe: legacy-style sync-all — NO canary, NO validation; a real backup is still taken per project (never "no undo") ***');
    if (flags.forceOverwrite && flags.forceAll && !flags.dryRun) { // print the exact per-project file list BEFORE writing
      const previewProjects = findForgeProjects(rootDir);
      console.log('--force-overwrite --force-all: the following file(s) will be forced through per project (backed up first):');
      for (const p of previewProjects) {
        const pf = preflight(TEMPLATE, p);
        const forced = pf.unknownDrift.concat(pf.conflicts);
        if (forced.length) console.log('  ' + path.basename(p) + ': ' + forced.join(', '));
      }
    }
    const lock = flags.dryRun ? { ok: true, lockPath: null } : acquireLock(rootDir); // M2
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let exitCode = 1;
    try {
      const result = runSyncAll(TEMPLATE, rootDir, {
        canaryName: flags.canary, stageSize: flags.stageSize, dryRun: flags.dryRun,
        forceOverwrite: flags.forceOverwrite, unsafe: flags.unsafe, batchId,
        centralBackupRoot, runId: flags.runId, allowDegraded: flags.allowDegraded, doctorTimeoutMs: flags.doctorTimeout,
      });
      // A dry-run computes the full per-project plan but writes nothing — SHOW it, otherwise the preview is
      // useless (the operator cannot see what would change before authorising a real 12-project sync).
      if (result.dryRun) {
        if (flags.json) { console.log(JSON.stringify(result, null, 2)); }
        else {
          console.log('[DRY-RUN] sync-all plan for ' + (result.projects ? result.projects.length : 0) + ' project(s) under ' + rootDir + ' — WRITES NOTHING:');
          if (result.dedicatedCanary && result.dedicatedCanary.plan) { console.log('\ndedicated canary (' + path.basename(result.dedicatedCanary.projectDir) + '):'); printPlanSummary(result.dedicatedCanary.plan); }
          for (const p of (result.projects || [])) { console.log('\n' + path.basename(p.projectDir) + ':'); if (p.plan) printPlanSummary(p.plan); else console.log('  (no plan — ' + (p.reason || 'unavailable') + ')'); printSettingsMergeResult(p.projectDir, p.settingsMerge); }
        }
      }
      exitCode = result.ok ? 0 : 1;
    } finally { releaseLock(lock); }
    process.exit(exitCode);
  } else if (cmd === 'rollback') {
    if (!pos[0]) exitUsage('usage: forge-sync rollback <projectDir> [--batch <batchId>] [--central-backup-root <dir>] [--no-central-backup] [--force-rollback-newer]');
    // N10 fix (2026-09-26): must match install's new default exactly, or rollback would look in the old
    // outside-the-project location for a backup install just wrote inside the project.
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || defaultCentralBackupRoot(pos[0]));
    const centralBackupRootExplicit = !!(flags.centralBackupRoot || flags.noCentralBackup); // S3
    const lock = acquireLock(claudeDirOf(pos[0])); // S6: rollback writes to the project — must lock like install does
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let r;
    try { r = rollbackProject(pos[0], flags.batchId || null, { centralBackupRoot, centralBackupRootExplicit, forceRollbackNewer: flags.forceRollbackNewer }); }
    finally { releaseLock(lock); }
    if (!r.ok) { console.error('rollback failed: ' + r.reason); process.exit(1); }
    console.log('rolled back ' + pos[0] + ' (batch ' + r.batchId + ', source ' + r.source + '): ' + r.restored.length + ' file(s) restored, version ' + r.versionAction + ', receipt ' + r.receiptAction);
    process.exit(0);
  } else if (cmd === 'rollback-batch') {
    if (!pos[0]) exitUsage('usage: forge-sync rollback-batch <batchId> <rootDir> [--central-backup-root <dir>] [--no-central-backup] [--force-rollback-newer]');
    const bId = pos[0];
    const rootDir = pos[1] || process.env.FORGE_SYNC_ROOT; // B6
    if (!rootDir) exitUsage('usage: forge-sync rollback-batch <batchId> <rootDir> (root required — no home-dir default)');
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || path.join(rootDir, '.forge-backup-hub'));
    const centralBackupRootExplicit = !!(flags.centralBackupRoot || flags.noCentralBackup); // S3
    const rootLock = acquireLock(rootDir); // S6: mirrors sync-all's root lock
    if (!rootLock.ok) { console.error('forge-sync: ' + rootLock.reason); process.exit(1); }
    let results;
    try { results = rollbackBatch(rootDir, bId, { centralBackupRoot, centralBackupRootExplicit, forceRollbackNewer: flags.forceRollbackNewer }); }
    finally { releaseLock(rootLock); }
    results.forEach((r) => console.log((r.ok ? 'rolled back ' : 'FAILED ') + r.projectDir + (r.ok ? (': ' + r.restored.length + ' file(s)') : (': ' + r.reason))));
    const okCount = results.filter((r) => r.ok).length; // B4: count only real successes, never results.length
    console.log(okCount + ' of ' + results.length + ' project(s) rolled back for batch ' + bId);
    process.exit(results.length > 0 && okCount === results.length ? 0 : 1);
  } else {
    exitUsage('unknown command: ' + cmd + ' (use status|install|adopt|list|canary-init|sync-all|doctor|rollback|rollback-batch)');
  }
}
