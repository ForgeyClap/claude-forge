# Forge Model Routing — NVIDIA Build/NIM + Claude (2026-07-05)

## Two honest layers
1. **Agent runtime (Claude).** Forge subagents are Claude Code Agent-tool spawns — they run on `haiku`/`sonnet`/`opus` per `FORGE_MODEL_ROUTING.json` + `config/agents/agent-model-map.json` (`claudeTier`). NVIDIA models **cannot** host a Claude Code subagent — nobody should claim otherwise.
2. **NVIDIA as tool (bulk offload only).** A Boss calls NVIDIA via `forge-bin/nvidia-provider.cjs` ONLY for genuinely bulk, low-risk work (first-draft docs, metadata/audit first-pass, source pre-summarization, registry validation, bulk fixtures, mechanical scaffolding/CRUD codegen). **Claude-first is the default** (2026-07-07 evidence); reasoning/review/coding/security/integration/vision stay on Claude. **Enforced in code** (2026-07-08): the 6 `claudeWinsSkipNvidia` Bosses (boss, head-chef, review-boss, security-boss, integration-boss, ui-boss) are HARD-BLOCKED from NVIDIA; every NVIDIA call must pass its Boss slug (`--agent <slug>`), and NVIDIA-generated code is stamped `codeGateRequired` and MUST pass the build+test gate. Text-only adapter → NVIDIA vision is NOT usable; screenshot analysis runs on Claude.

## Key & env (SAFE)
- **Real key location (only these, both git-ignored/outside git):** project `.env` → `NVIDIA_API_KEY=nvapi-…` **or** global `~/.claude/nvidia.env` (one key for ALL projects; project `.env` overrides global).
- Never in git, code, logs, or reports — the adapter masks `nvapi-…` in every output. `.env.example` carries placeholders only.
- Endpoint (official docs): `https://integrate.api.nvidia.com/v1/chat/completions`, `Authorization: Bearer $NVIDIA_API_KEY`, OpenAI-compatible. Free tier ≈ 40 req/min → adapter handles 429 + Retry-After.

## Role slots (env-overridable; defaults corrected from LIVE probes 2026-07-07 — the 07-05 picks hung/404'd)
| Slot | Model | Why |
|---|---|---|
| default | nvidia/nemotron-3-nano-30b-a3b | REMAPPED 2026-07-26 (was minimaxai/minimax-m3 — now unused, see Consolidation note below); fast+clean general, ~0.6s pings — drafts/summaries/classification |
| fast / coding-fast | nvidia/nemotron-3-nano-30b-a3b | cheap, 1M ctx (probe 1s) — routing/formatting/bulk first-pass |
| reasoning | moonshotai/kimi-k2.6 | best working single-shot reasoner (probe 623ms) |
| review | mistralai/mistral-large-3-675b-instruct-2512 | frontier 675B, fast (probe 347ms) — 2nd-opinion QA |
| coding | openai/gpt-oss-120b | top working coder (SWE 62.4%, probe 1s clean Python) |
| vision | meta/llama-4-maverick-17b-128e-instruct | probe-working multimodal — but adapter text-only, real vision on Claude |

> Do NOT use deepseek-v4-pro/flash, qwen3-next-80b, qwen3.5-122b/397b (HANG), codestral/codellama/granite-code (404), gpt-oss-20b/nano-9b (empty) — see `model-capability-matrix.json` `notAvailableOrBroken`. `route <agent>` now warns if an env override points at an avoid/broken model.

Override per project via `.env`: `NVIDIA_REASONING_MODEL=…` etc. Change models in `config/models/model-capability-matrix.json` — **no core code edits needed**.

## Commands
```
node .claude/forge-bin/nvidia-provider.cjs health            # connectivity (mock-mode zonder key)
node .claude/forge-bin/nvidia-provider.cjs models --verify   # live list + warn on stale role models
node .claude/forge-bin/nvidia-provider.cjs route boss        # resolve+validate an agent's models
node .claude/forge-bin/nvidia-provider.cjs chat --role coding --prompt "..."
node .claude/forge-bin/nvidia-provider.test.cjs              # offline tests (46, no network)
```

## Rules
- **Fit first:** never assign a model outside its caps (vision task ⇒ vision model; implementation ⇒ coding model). `route <agent>` warns on violations; `prohibited` lists per agent block obvious misfits.
- **Fallback chain:** NVIDIA role model → NVIDIA fallback role → the agent just does the work on its Claude runtime model (labeled `nvidia-skipped`). NVIDIA down ≠ blocked work; mocks are never presented as real output.
- **Premium rule:** Boss decides when Opus 4.8/Sonnet 5 outweighs cost (security/architecture/final QA are ALWAYS premium per FORGE_MODEL_ROUTING.json).
- **No live calls without key**; with key, live verification only via the explicit commands above.

## Function fit (WP-NVIDIA-FIT, 2026-07-26 — LAW for bulk offload, not advisory)
An agent's default NVIDIA role (above) is a starting point, not the last word: a Boss's bulk work must be routed by **function strength**, not just its flat role. `config/models/function-model-fit.json` maps each bulk-work function (code-draft, doc-draft, research-digest, data-extract, summarize, translate-rewrite, test-sketch) to the model *judged good at it by a real live probe* — pass `--function <fn>` to `chat`/`route` (`nvidia-provider.cjs`) to use it; omitting `--function` keeps the old role/model behavior unchanged. **A function with no fit model (all probes judged wrong) routes to NONE — Claude keeps that work, full stop; never force a bad-fit model onto NVIDIA.** `claudeWinsSkipNvidia` Bosses stay hard-blocked from NVIDIA regardless of `--function` — function-fit can never bypass that gate. Every fit judgment's literal probe evidence lives in `function-model-fit.json` itself (evidence field + verdict: correct / correct-but-slow / partial / none) — the same honesty discipline as `model-capability-matrix.json`. Re-probe function fit on the same ~1-week cadence as the role matrix; a model's function fit can drift the same way its role fit does.

## Consolidation (WP-NVIDIA-CONSOLIDATE, 2026-07-26)
Cross-probing every function's weak spot against `nemotron-3-nano`/`nemotron-3-super`/`deepseek-v4-flash` on the same real tasks found 2 models now cover all 7 bulk-work functions at fit="correct" — `nemotron-3-nano` (doc-draft, data-extract, summarize) and `nemotron-3-super` (code-draft, test-sketch, research-digest, translate-rewrite) — so `minimax-m3` and `mistral-small-4-119b-2603` are no longer needed by any function, and the `default` ROLE was remapped from `minimax-m3` to `nemotron-3-nano` (~16.7x faster on a real summarize task, same correctness). Full evidence (including every losing candidate) is in `function-model-fit.json`'s `consolidation` block; `deepseek-v4-flash`/`mistral-small-4-119b-2603` remain the `reasoning`/`review` ROLE defaults for non-function-routed calls, unchanged.
