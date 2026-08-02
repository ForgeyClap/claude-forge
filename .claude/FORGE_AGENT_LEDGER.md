# Forge Agent Activity Ledger

> Proof of which agents actually worked — no fake agent claims, and **ECC vs native is explicit**. One table per `/forge` task.
> Each row has a **Runtime** (ECC agent · ECC skill · native/main · Codex) and a Status.
> Allowed statuses ONLY: `ECC REAL INVOKED` · `ECC SKILL LOADED` · `NATIVE AGENT INVOKED` · `INTERNAL ROLE ONLY` · `NOT USED` · `FAILED` · `BLOCKED`.
> - `ECC REAL INVOKED` = a real ECC subagent was actually dispatched (Runtime = ECC agent).
> - `ECC SKILL LOADED` = an ECC skill/playbook/command/tool was actually loaded/run (Runtime = ECC skill).
> - `NATIVE AGENT INVOKED` = a native/main-session agent did the work as a **labeled fallback** (Runtime = native) — never dress this up as ECC.
> - `INTERNAL ROLE ONLY` = a thinking role inside the main session (no separate agent).
> - `BLOCKED` = ECC was attempted but unavailable/blocked (give the reason in Evidence).
> - `NOT USED` / `FAILED` = self-explanatory.
> Evidence = command output, file diff, tool result, commit hash, log line, created/modified file — or an explicit note that evidence is unavailable and why.

## <ISO date/time> — <short request>

**ECC:** Normal Mode <ON/OFF/BLOCKED> · Full Test Mode <OFF/ON> · ECC attempted <y/n> · ECC succeeded <y/n/partial> · native fallback <y/n> · reason <if any>

| Agent | Runtime | Status | Project role | Task | Files read | Files changed | Evidence | Result |
|-------|---------|--------|--------------|------|-----------|---------------|----------|--------|
| <name> | <ECC agent/ECC skill/native/Codex> | <status> | <role> | <task> | <files> | <files> | <evidence> | <result> |
