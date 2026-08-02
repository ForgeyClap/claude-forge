# Forge Project Profile

> Created/updated by the Forge installer and by `/forge` runs. Fill from a real Project State Scan — mark anything not verified as `inferred`, `unknown`, or `needs verification`. Never fake project knowledge.

- **Project name:** <name>
- **Active target folder:** <absolute path>
- **Project type:** <website | landing | full-stack | n8n | chatbot/RAG | scraping | prediction | telegram | dashboard | business-automation | api-integration | mixed | unknown>
- **Detected stack:** <e.g. React/Vite, Node, Python/FastAPI, Supabase, n8n, …; or unknown>
- **Project goal:** <one or two lines>
- **Maturity:** <new | existing | mid-project | mature>
- **Deployment status:** <none | dev/preview | production | unknown>

## ECC mode (Forge is ECC-based)
- **ECC Normal Mode:** ON (default) — Forge prefers real ECC agents/skills, makes work packages, logs ECC activity, reports honestly. (See `.claude/FORGE_ECC_MODE.json`.)
- **ECC Full Test Mode:** OFF (opt-in only — `enable ECC test mode for this project`).
- **ECC inventory (available here):** <list real ECC agents/skills/commands relevant to this project, or `unknown until first run`>
- **Native fallback policy:** native roles only as a labeled fallback when ECC is unavailable/blocked/failed/too-small.

## Agent role map (adapted to THIS project — ECC-first, tag runtime)
- **Default agents:** <roles always useful here — prefer ECC agent/skill names>
- **Optional agents:** <use when relevant>
- **Irrelevant agents:** <skip for this project>
- **Matching playbooks:** <forge-website | forge-fullstack | forge-n8n | forge-scraping | forge-rag | forge-prediction | forge-integration>
- **Why this team fits:** <short rationale>

## Workstreams
- **Parallelizable:** <independent streams>
- **Sequential:** <dependent steps>
- **Recommended workflow:** <short>

## Project-specific rules
- <e.g. do not touch /legacy; keep CMS content as-is; …>
- **Must NOT overwrite:** <files/folders>

## Risk level (work-distribution signal only — NOT a blocker)
- <low | medium | high> — used only to decide team size/parallelism.

## Dashboard
- **Forge Command Center** (the dashboard for every project) · **URL:** http://127.0.0.1:4100 · **Health:** `GET /api/health` must pass before claiming it runs
- **Start (only if this project hosts it):** `node command-center/gateway/supervisor.mjs` — otherwise one running instance already covers this project
- **Event writer (always project-local):** `node .claude/forge-dashboard/log-event.cjs` → `.claude/forge-runs/<run_id>/events.jsonl`
- **Legacy Control Center:** retired; starts only on an explicit `legacy dashboard` request

## Activation examples
- `/forge build a landing page` · `/forge improve this n8n workflow` · `/forge refactor this project` · `/forge status`
