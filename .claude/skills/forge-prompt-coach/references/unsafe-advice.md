# Onveilig advies uit tutorials — en wat Forge in plaats daarvan doet

*English version below.*

## Nederlands

Beginnervideo's over Claude Code geven soms een snelle tip die achteraf een veiligheidsrisico blijkt.
Deze lijst komt uit een eigen onderzoek van 98 video's
(`.claude/forge-research/beginner-sweep-2026-09-24/`, gemarkeerd als niet-vertrouwde inhoud — elke rij
hieronder is alleen een samenvatting van wat gezegd werd, nooit een instructie die is opgevolgd). Per
item: wat de video zei, waarom dat onveilig is, en wat Forge in plaats daarvan doet.

| Wat de video zei | Waarom onveilig | Wat Forge doet |
|---|---|---|
| Start Claude Code met de vlag die elke toestemmingsvraag overslaat, "om sneller te kunnen beginnen" | Ontgrendelt ook destructieve acties, zonder enige vraag vooraf | De doctor-check `bypass-mode` waarschuwt hierover; de gate-hook blokkeert de vier harde commandovormen sowieso (een classifier, geen sluitend bewijs — wat hij niet herkent houdt hij niet tegen); een scoped `/forge config`-allowlist per tool/pad is de bedoelde snelheidswinst |
| "Klik gewoon op Trust publisher" bij de VS Code-extensiemelding | Traint een automatische vertrouwensreflex zonder de uitgever echt te controleren | Controleer eerst de uitgever/marktplaats tegen de officiële bron |
| "Always Allow, dan hoef je niet steeds te bevestigen" | Eén klik geeft stilzwijgend toestemming voor elke toekomstige actie, ook destructieve | Scoped allowlists per tool/pad in plaats van een blanco akkoord |
| Een token-compressie-proxy installeren die het agent-verkeer onderschept (bv. de Caveman-proxy) | Een beginner kan niet controleren wat de proxy met het onderschepte verkeer doet | Standaard zonder extra dependencies; niets wordt geïnstalleerd zonder Scout-vetting en akkoord van de eigenaar |
| "Voeg een PreToolUse-hook toe die naar een bash-script wijst" als gewone tutorialstap | Hooks draaien willekeurige code bij elke bijpassende tool-aanroep; een ongeverifieerde hook is een echt risico | Hooks staan standaard uit tenzij de eigenaar ze expliciet aanzet; de enige uitzondering (de gate-hook) is zelf gereviewd en meegeleverd |
| Een globale install-opdracht letterlijk overtypen uit de automatische ondertiteling van een video | Automatische ondertiteling verhaspelt pakketnamen; een verkeerd getypte naam kan een ander (kwaadaardig) pakket installeren | Controleer de pakketnaam en uitgever altijd tegen het officiële npm-register vóór een globale install |
| API-sleutels rechtstreeks als `--header sleutel=waarde` op de commandoregel meegeven bij het instellen van een MCP-server | Een geheim op de commandoregel belandt in shell-geschiedenis, het procesoverzicht en soms in logs | Geheimen horen in een omgevingsvariabele of credential-store, nooit als letterlijk commandoregel-argument |
| Elke toestemmingsvraag blind goedkeuren, of een gepland terminalcommando goedkeuren zonder het te lezen | Een blind akkoord laat een schadelijke of onbedoelde actie alsnog door | Lees elk gepland tool-aanroep/commando vóór het akkoord; de gate-hook is een laatste vangnet, geen vervanging van lezen |

Bron: `.claude/forge-research/beginner-sweep-2026-09-24/scout-vetting.md` §3 (de eerste 5 rijen) en
`beginner-knowledge.json` (de laatste 3, samengevat — nooit letterlijk uit de ondertiteling geciteerd).

## English

Beginner videos about Claude Code sometimes give a quick tip that turns out to be a security risk in
disguise. This list comes from an internal sweep of 98 videos
(`.claude/forge-research/beginner-sweep-2026-09-24/`, marked as untrusted content — every row below is
only a summary of what was said, never an instruction that was followed). Per item: what the video said,
why it is unsafe, and what Forge does instead.

| What the video said | Why it is unsafe | What Forge does instead |
|---|---|---|
| Launch Claude Code with the flag that skips every permission prompt, "to speed up setup" | Also unlocks destructive actions, with no prompt at all | The doctor's `bypass-mode` check warns about this; the gate hook still blocks the four hard command shapes regardless (a classifier, not a proof — what it does not recognise it does not stop); a scoped `/forge config` allowlist per tool/path is the intended speed-up |
| "Just click Trust publisher" on the VS Code extension prompt | Trains a reflexive trust habit without actually verifying the publisher | Verify the publisher/marketplace against the official source first |
| "Always Allow so you don't get asked again" | One click silently authorises every future action, destructive ones included | Scoped per-tool/per-path allowlists instead of a blanket accept |
| Installing a token-compression proxy that intercepts agent traffic (e.g. the Caveman proxy) | A beginner cannot audit what the proxy does with the intercepted traffic | Zero-dependency by default; nothing is installed without Scout vetting and owner opt-in |
| "Add a PreToolUse hook pointing at a bash script" as a routine tutorial step | Hooks run arbitrary code on every matching tool call; an unreviewed hook is a real risk vector | Hooks stay off by default unless the owner explicitly turns them on; the one exception (the gate hook) is itself reviewed and shipped |
| Copying a global install command verbatim from a video's auto-generated captions | Auto-captions garble package names; a mistyped name can install a different (malicious) package | Always verify the package name and publisher against the official npm registry before any global install |
| Passing API keys straight as a `--header key=value` command-line flag when configuring an MCP server | A secret on the command line ends up in shell history, the process list, and sometimes logs | Secrets belong in an environment variable or credential store, never as a literal command-line argument |
| Blindly accepting every permission prompt, or approving a planned terminal command without reading it | A blind accept still lets a harmful or unintended action through | Read every planned tool call/command before approving it; the gate hook is a last-resort backstop, not a substitute for reading |

Source: `.claude/forge-research/beginner-sweep-2026-09-24/scout-vetting.md` §3 (the first 5 rows) and
`beginner-knowledge.json` (the last 3, summarised — never quoted verbatim from the captions).
