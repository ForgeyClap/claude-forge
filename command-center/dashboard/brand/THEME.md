# Forge theme

One palette, one type scale, one set of surfaces — shared by the dashboard, the chat
and the registry home view. Zero dependencies: plain JSON in, plain CSS out.

## Files

| File               | Owner       | What it is                                             |
| ------------------ | ----------- | ------------------------------------------------------ |
| `tokens.json`      | you         | The single source of truth. This is the file you edit. |
| `build-theme.cjs`  | you         | Generator. Node 18+, no packages.                      |
| `forge-tokens.css` | *generated* | Do not edit. It gets overwritten.                      |
| `forge-base.css`   | you         | Shared primitives built on the tokens.                 |

## Use it

```html
<link rel="stylesheet" href="/brand/forge-tokens.css" />
<link rel="stylesheet" href="/brand/forge-base.css" />
<link rel="stylesheet" href="/dashboard.css" />
```

Order matters — tokens define the variables, base consumes them, your view overrides.

Dark is the default. `data-theme="light"` on `<html>` switches; with no attribute set,
the OS preference wins.

For the registry home view, which has to stay a single self-contained file:

```bash
node brand/build-theme.cjs --inline >> home-view.html
```

## Rebuild

```bash
node brand/build-theme.cjs          # write forge-tokens.css
node brand/build-theme.cjs --check  # exit 1 if the CSS drifted from the JSON
```

Wire `--check` into `forge-doctor`. It catches the failure mode that kills every design
system: someone edits the generated CSS by hand, it works, and six weeks later the JSON
and the CSS disagree with nobody noticing.

## The two rules

**Colour has two axes.** Status is saturated signal — `--forge-status-running` is ember
because that is working heat, `completed` is patina green, `waiting` is quench cyan,
`failed` is slag red. Agent groups are muted metal: the seven groups use the tempering
colours of polished steel in real heat order (straw → bronze → copper → plum → deep blue
→ sky steel → grey). A node can say "Execution" and "running" at once without the two
colours fighting.

**Type marks provenance.** Mono carries what the system recorded — run ids, event types,
agent names, ports, token counts, ledger lines. Sans carries what a person wrote — chat
messages, reports, descriptions. Use `.fg-machine` for the first kind. A reader can then
tell evidence from prose at a glance, which is the same thing the honesty layer is for.

## Adding a token

Add it to `tokens.json`, rebuild, use the variable. Never write a hex value in a view
stylesheet. The raw `palette` block deliberately never reaches CSS, so there is no way to
reach past the semantic names and hardcode a material colour — if you need one that
doesn't exist yet, that's a signal the semantic layer is missing a name.

## Migration order

Do the dashboard before the chat. Porting a finished view is a mechanical find-and-replace;
porting a view you are still designing is a moving target.

1. Drop both stylesheets into the dashboard SPA ahead of its own CSS.
2. Replace hex values with tokens one section at a time — the six status colours and the
   seven group colours first, since those already exist and are the most duplicated.
3. Delete the dead declarations. Anything still holding a raw hex afterwards is either a
   missing token or an accident; both are worth a look.
4. Run `--check`, then commit the JSON and the CSS together.
