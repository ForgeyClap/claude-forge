# Forge × Discord — canary-lab

Testomgeving voor remote control van Forge/Claude Code via Discord. Dit project
implementeert de transport-onafhankelijke betrouwbaarheidslaag uit
`forge-discord-plan-claude-review.md` en test die volledig lokaal (mock) vóór er
ook maar iets live aan Discord hangt.

## Architectuur

```
Discord (of mock) ──► PermissionGateway ──► Router ──► IngressQueue ──► Scheduler ──► Runner
        ▲              (owner-allowlist)   (ID-mapping)  (durable,       (1 run/thread,   (fake of
        │                                                dedup, expiry)   FIFO, abort)     claude -p)
        └───────────────── antwoord + Outbox (exactly-once eindrapporten) ◄─────────────────┘
```

- `src/queue.js` — durable wachtrij: dedup op message-ID, >2h → bevestiging, max
  10/thread, restart-recovery (RUNNING→QUEUED), dead-letter.
- `src/router.js` — forumkanaal-ID → project-ID, thread-ID → conversation-ID,
  cross-route-weigering, archiveren.
- `src/permissions.js` — owner-allowlist; eigen bot/bots/webhooks genegeerd.
- `src/scheduler.js` — max 1 actieve run per thread, FIFO + priority, echte
  cancellation via AbortSignal, graceful shutdown.
- `src/outbox.js` — eindrapporten exactly-once (idempotency-key), UNCERTAIN na
  crash mid-send, resend-commando.
- `src/commands.js` — `/forge status|queue|stop|interrupt|confirm|retry|remove|resend|help`
  als thread-commando's.
- `src/transport/mock.js` — volledige Discord-simulatie (offline, reconnect,
  history-backfill, thread-discovery) voor tests.
- `src/transport/discord.js` — echte adapter (discord.js, lazy import) — live-test
  is owner-gated, zie `OWNER_ACTIONS.md`.
- `src/runner-fake.js` / `src/runner-claude.js` — echo-runner voor tests; echte
  headless `claude -p`-runner (prompt via stdin, abort → kill).

## Draaien

```bash
npm test        # 28 tests (acceptatietests plan §13 op mock-transport)
npm run demo    # end-to-end demo zonder Discord
node src/main.js  # service; TRANSPORT=mock|discord, RUNNER=fake|claude
```

## Commando's in Discord

Typ `/forge` in een projectkanaal voor het menu met autocomplete.

| Commando | Wat het doet |
|---|---|
| (gewoon typen) | je opdracht; loopt in de projectmap van dat kanaal |
| `/forge status` · `queue` | actieve runs, wachtrij |
| `/forge stop` · `interrupt` | run stoppen (checkpoint blijft) |
| `/forge retry <id>` · `remove <id>` | opnieuw proberen / weghalen |
| `/forge usage [uren]` | abonnement-balken + eigen verbruik |
| `/forge diff [uren]` | welke bestanden zijn echt gewijzigd |
| `/forge model` · `effort` | model en denkdiepte per project |
| `/forge write on\|off` | schrijfrechten per project |
| `/forge schedule` · `schedules` · `unschedule` | geplande opdrachten |
| `/forge briefing` | dagbriefing nu sturen |
| `/forge memory` | wat de bot van dit project weet |
| `/forge pause` · `resume` | handmatig pauzeren/hervatten |
| `/forge reset` · `session reset` | chat opruimen / vers gesprek |

Extra gedrag zonder commando: 🔴/🟢 bij de kanaalnaam, live voortgang in het
statusbericht, ping bij het eindantwoord, chat elke 30 min opgeruimd met
transcript, automatische pauze boven 90% verbruik, knoppen bij risicovolle
opdrachten, en spraakmemo's/screenshots als invoer.

## Status

- Tests: ✅ 99/99 groen (Node v24).
- Live in Discord met echte Claude Code-runs per project.
- Onderzoek: zie `research/` (R1–R4); plan in `docs/PLAN.md`; ideeën en wat
  gebouwd is in `docs/IDEEEN.txt`; bewijs per mijlpaal in `tasks/PROOF_LOG.md`.
- Openstaande owner-acties: `OWNER_ACTIONS.md`.
