# Adapted Patterns — Forge own words from community skills

Patterns adapted into Forge's own vocabulary from public MIT-licensed community skills; no text copied wholesale. Each pattern is Forge-phrased and integrated into the target skill's body sections (hard rules, domain gates, checklists, or workflow). Source reputation, license compatibility, and content integrity verified pre-adaptation (November 2026).

## Adapted patterns table

| Forge skill/agent | Pattern (one line) | Source repo + path | License | Retrieved |
|---|---|---|---|---|
| forge-website | Meta/OG/canonical on every page; Lighthouse perf proof (LCP/CLS/INP) | davila7/claude-code-templates, roier-seo | MIT | 2026-09-26 |
| forge-electron | Preload contextBridge allowlist; safeStorage for secrets, not userData | davila7/electron-development | MIT | 2026-09-26 |
| forge-n8n | Null-safe expressions (optional chaining, ??, Array.isArray); webhook early response | davila7/n8n-workflow-patterns | MIT | 2026-09-26 |
| forge-payments | Refunds/disputes/chargebacks explicit handlers; re-fetch charge state when it matters | wshobson/agents, stripe-integration | MIT | 2026-09-26 |
| forge-fullstack | Cookies server-side (not localStorage for tokens); client-side never the only guard | davila7/nextjs-supabase-auth | MIT | 2026-09-26 |
| forge-data | Dead-letter for validation failures; incremental loads with look-back window for late data | wshobson/agents, data-pipeline | MIT | 2026-09-26 |
| forge-integration | Exponential backoff with jitter for retries | wshobson/agents, data-pipeline | MIT | 2026-09-26 |
| forge-migration | Expand-and-contract for live schema changes; test on realistic copy (lock timing) | affaan-m/ECC, database-migrations | MIT | 2026-09-26 |
| forge-mlops | Decision note pre-training (goal/metrics/baseline/rollback); choose metrics by mistake cost | affaan-m/ECC, mle-workflow | MIT | 2026-09-26 |
| forge-rag | Fallback on empty/low-confidence; every answer cites retrievable source; out-of-scope refusal | (internal pattern) | – | 2026-09-26 |
| forge-snapshot | Suggest /compact at phase boundary around 60% context | affaan-m/ECC, strategic-compact | MIT | 2026-09-26 |
| forge-deeplearn | Full-file read-through costly; use only for large unfamiliar codebase; read big files in chunks | affaan-m/ECC, strategic-compact | MIT | 2026-09-26 |
| forge-debug | Classify error first (build-blocking, type, config, dep); minimal-diff check after fix; temp logging for intermittent bugs | affaan-m/ECC (build-error-resolver, smart-debug) + wshobson/agents | MIT | 2026-09-26 |
| forge-brainstorm | Name · why · cost (time/complexity/risk) · one unaddressed risk — side by side | obra/superpowers, brainstorming + davila7 | MIT | 2026-09-26 |
| forge-intake | Answer 5 questions internally first (who/what/why-can't-solve/why-now/how-measure) | affaan-m/ECC, prp-prd | MIT | 2026-09-26 |
| forge-graded-verify | Optional dual review for high-stakes (RAG/research/prediction); split verdict = one rework | affaan-m/ECC, santa-loop | MIT | 2026-09-26 |
| ship-readiness + forge-report | Run forge-verify.cjs before completion; report result; mismatch = rework | (internal pattern) | – | 2026-09-26 |
| review-boss | Error handling: no empty catch; errors→null/[] with context; network/DB/async timeouts + handling; no lost traces on re-throw | affaan-m/ECC, silent-failure-hunter | MIT | 2026-09-26 |
| integration-boss | Webhook/queue handlers idempotent; no empty error handlers; swallowed errors/dropped queue failures flagged | affaan-m/ECC (silent-failure-hunter) | MIT | 2026-09-26 |
| build-boss | New tests assert behaviour; test-that-only-runs-code is hollow | affaan-m/ECC, pr-test-analyzer | MIT | 2026-09-26 |
| test-boss | Happy-path + edge/error path for every interactive element (validation fail, network error, boundary value) | affaan-m/ECC, pr-test-analyzer | MIT | 2026-09-26 |
| security-boss | Parameterized/ORM queries, never string-built; sanitize input to HTML/shell/file-path; no tokens/hashes/IDs in error messages | affaan-m/ECC, fastapi-reviewer | MIT | 2026-09-26 |
| seo-boss | Every finding points at real page/file; fit project stack; ranking claims only Core Web Vitals/indexability/structure | affaan-m/ECC, seo-specialist | MIT | 2026-09-26 |
| forge-vault.cjs (tool) | Atomic, linked markdown notes (frontmatter + [[wikilinks]] + a Home index) that grow with every finished run; rebuilt zero-dependency in Node (no Python engine) | AgriciDaniel/claude-obsidian | MIT | 2026-09-26 |

## Verification

- **Source reputation:** all upstream repos are production-use Forge-tier codebases or official Anthropic reference (davila7, wshobson, obra, affaan-m/ECC pinned).
- **License check:** all patterns source MIT or Apache-2.0; adapted text is Forge-phrased, never verbatim copy-paste.
- **Content scan:** no zero-width/invisible Unicode, no prompt-injection patterns, no credential/PII in any source.
- **Integration:** patterns adapted into Forge's own voice, vocabulary, and body structure; no attribution trails left in the adapted text itself (this file is the record).

See `.claude/skills/VENDORED-SKILLS.md` for the complete vendored-skills registry and per-skill modification ledger.

## Checked, already covered (no text adapted)

These community patterns were compared with the Forge file and found to be covered there in substance already, so
nothing was added; they are listed so the review stays traceable.

| Forge skill/agent | Pattern (one line) | Source repo + path | License | Retrieved |
|---|---|---|---|---|
| forge-extension | Manifest V3 least privilege + host_permissions; validate sender + message shape | davila7/browser-extension-builder | MIT | 2026-09-26 |
| forge-game | requestAnimationFrame with delta time; no dead ends (win/lose/restart reachable) | wshobson/agents, game-development | MIT | 2026-09-26 |
| forge-mobile | Tokens in secure storage (Keychain/Keystore), not AsyncStorage; iOS NSUsageDescription strings | wshobson/agents, react-native-architecture | MIT | 2026-09-26 |
| forge-figma | Extract design tokens (colors/spacing/type); breakpoint-by-breakpoint visual comparison | davila7/figma-implement-design | MIT | 2026-09-26 |
| forge-cms | wp search-replace for serialized data, not raw SQL; vet plugins (updated/used/no CVEs) | davila7/building-blog | MIT | 2026-09-26 |
| forge-ecommerce | Idempotent order creation with unique constraint; atomic stock decrement via conditional UPDATE | wshobson/agents, stripe-integration | MIT | 2026-09-26 |
| forge-api | Prove auth with negative test (401/403 without token) | davila7/api-patterns | MIT | 2026-09-26 |
| forge-bots | Rate-limit backoff (429 + Retry-After); minimal scopes/intents (Message Content privileged) | davila7/discord-bot-architect + telegram-bot-builder | MIT | 2026-09-26 |
| docs-boss | Confirm command exists (grep/run) before documenting; never from plan alone | affaan-m/ECC, docs-lookup | MIT | 2026-09-26 |
