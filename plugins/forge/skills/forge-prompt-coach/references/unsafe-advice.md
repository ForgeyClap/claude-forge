# Onveilig advies uit tutorials — en wat Forge in plaats daarvan doet

*English version below.*

## Nederlands

Beginnervideo's over Claude Code geven soms een snelle tip die achteraf een veiligheidsrisico blijkt.
Deze lijst komt uit een eigen, interne review van veelvoorkomende beginnerstips in tutorialvideo's
(niet meegeleverd in de installatie — elke rij hieronder is alleen een samenvatting van wat gezegd werd,
nooit een instructie die is opgevolgd). Per item: wat de video zei, waarom dat onveilig is, en wat Forge
in plaats daarvan doet.

| Wat de video zei | Waarom onveilig | Wat Forge doet |
|---|---|---|
| Start Claude Code met de vlag die elke toestemmingsvraag overslaat, "om sneller te kunnen beginnen" | Ontgrendelt ook destructieve acties, zonder enige vraag vooraf | De doctor-check `bypass-mode` waarschuwt hierover; de gate-hook blokkeert de vier harde commandovormen sowieso (een classifier, geen sluitend bewijs — wat hij niet herkent houdt hij niet tegen). De echte snelheidswinst is Claude Code's eigen `/permissions`-opdracht (een interactieve allowlist voor veilige commando's) — Forge heeft geen eigen allowlist-instelling. Voor het uitschakelen van de gate-hook zelf geldt: alleen de eigenaar kan dat, met `/forge config set gate-hook off` of door een commando met een `!` ervoor letterlijk zelf te typen (dat draait dan in de shell van de eigenaar, niet als agent-actie) |
| "Klik gewoon op Trust publisher" bij de VS Code-extensiemelding | Traint een automatische vertrouwensreflex zonder de uitgever echt te controleren | Controleer eerst de uitgever/marktplaats tegen de officiële bron |
| "Always Allow, dan hoef je niet steeds te bevestigen" | Eén klik geeft stilzwijgend toestemming voor elke toekomstige actie, ook destructieve | Claude Code's eigen `/permissions`-allowlist per tool/pad, least-privilege tool-rechten per agentrol, en de gate-hook's eenmalige beoordeelde `--once`-goedkeuring (schakelt na 10 minuten zelf terug aan) — nooit een blanco akkoord |
| Een token-compressie-proxy installeren die het agent-verkeer onderschept (bv. de Caveman-proxy) | Een beginner kan niet controleren wat de proxy met het onderschepte verkeer doet | Standaard zonder extra dependencies; niets wordt geïnstalleerd zonder Scout-vetting en akkoord van de eigenaar |
| "Voeg een PreToolUse-hook toe die naar een bash-script wijst" als gewone tutorialstap | Hooks draaien willekeurige code bij elke bijpassende tool-aanroep; een ongeverifieerde hook is een echt risico | Vijf gereviewde hooks over vier events staan standaard actief (PreToolUse: de gate-hook · PostToolUse: het wijzigingslogboek · PreCompact/SessionStart: context-continuïteitssnapshots), elk project-lokaal en gedocumenteerd in `HOOKS_OPT_IN.md`; niets daarbuiten wordt toegevoegd zonder dat de eigenaar het expliciet aanzet |
| Een globale install-opdracht letterlijk overtypen uit de automatische ondertiteling van een video | Automatische ondertiteling verhaspelt pakketnamen; een verkeerd getypte naam kan een ander (kwaadaardig) pakket installeren | Controleer de pakketnaam en uitgever altijd tegen het officiële npm-register vóór een globale install |
| API-sleutels rechtstreeks als `--header sleutel=waarde` op de commandoregel meegeven bij het instellen van een MCP-server | Een geheim op de commandoregel belandt in shell-geschiedenis, het procesoverzicht en soms in logs | Geheimen horen in een omgevingsvariabele of credential-store, nooit als letterlijk commandoregel-argument |
| Elke toestemmingsvraag blind goedkeuren, of een gepland terminalcommando goedkeuren zonder het te lezen | Een blind akkoord laat een schadelijke of onbedoelde actie alsnog door | Lees elk gepland tool-aanroep/commando vóór het akkoord; de gate-hook is een laatste vangnet, geen vervanging van lezen |

## English

Beginner videos about Claude Code sometimes give a quick tip that turns out to be a security risk in
disguise. This list comes from an internal review of common beginner tips in tutorial videos (not
shipped with the install — every row below is only a summary of what was said, never an instruction
that was followed). Per item: what the video said, why it is unsafe, and what Forge does instead.

| What the video said | Why it is unsafe | What Forge does instead |
|---|---|---|
| Launch Claude Code with the flag that skips every permission prompt, "to speed up setup" | Also unlocks destructive actions, with no prompt at all | The doctor's `bypass-mode` check warns about this; the gate hook still blocks the four hard command shapes regardless (a classifier, not a proof — what it does not recognise it does not stop). The real speed-up is Claude Code's own `/permissions` command (an interactive allowlist for safe commands) — Forge has no separate allowlist setting of its own. Turning the gate hook itself off is owner-only: `/forge config set gate-hook off`, or literally typing a command with `!` in front yourself (that runs in the owner's own shell, never as an agent action) |
| "Just click Trust publisher" on the VS Code extension prompt | Trains a reflexive trust habit without actually verifying the publisher | Verify the publisher/marketplace against the official source first |
| "Always Allow so you don't get asked again" | One click silently authorises every future action, destructive ones included | Claude Code's own `/permissions` per-tool/per-path allowlist, least-privilege tool grants per agent role, and the gate hook's single reviewed `--once` approval (auto-reverts after 10 minutes) — never a blanket accept |
| Installing a token-compression proxy that intercepts agent traffic (e.g. the Caveman proxy) | A beginner cannot audit what the proxy does with the intercepted traffic | Zero-dependency by default; nothing is installed without Scout vetting and owner opt-in |
| "Add a PreToolUse hook pointing at a bash script" as a routine tutorial step | Hooks run arbitrary code on every matching tool call; an unreviewed hook is a real risk vector | Five reviewed hooks across four events ship active by default (PreToolUse: the gate hook · PostToolUse: the change ledger · PreCompact/SessionStart: context-continuity snapshots), every one project-local and documented in `HOOKS_OPT_IN.md`; nothing beyond those is added without the owner explicitly turning it on |
| Copying a global install command verbatim from a video's auto-generated captions | Auto-captions garble package names; a mistyped name can install a different (malicious) package | Always verify the package name and publisher against the official npm registry before any global install |
| Passing API keys straight as a `--header key=value` command-line flag when configuring an MCP server | A secret on the command line ends up in shell history, the process list, and sometimes logs | Secrets belong in an environment variable or credential store, never as a literal command-line argument |
| Blindly accepting every permission prompt, or approving a planned terminal command without reading it | A blind accept still lets a harmful or unintended action through | Read every planned tool call/command before approving it; the gate hook is a last-resort backstop, not a substitute for reading |
