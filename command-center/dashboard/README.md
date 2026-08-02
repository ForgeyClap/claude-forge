# Forge Workspace — visual prototype

A frontend prototype of the Forge Workspace: how the product looks, feels and behaves,
built before anything real is connected to it.

Everything on screen comes from local example data. There is no backend, no API, no
Claude Code session and no Forge runtime behind it — and there are tests that fail the
build if that ever stops being true.

```
CONNECTED_TO_FORGE=false          USES_REAL_PROJECTS=false
CONNECTED_TO_CLAUDE_CODE=false    USES_REAL_AGENTS=false
USES_ANTHROPIC_API=false          USES_REAL_COMMANDS=false
REQUIRES_ANTHROPIC_API_KEY=false  USES_MOCK_DATA=true
```

## Run it

```bash
npm install
npm run dev            # http://127.0.0.1:5173
```

## Test it

```bash
npm run verify         # theme check → typecheck → lint → unit tests → build

npx playwright install chromium   # once
npm run test:e2e                  # 40 browser tests
npm run shots                     # 20 screenshots into artifacts/screenshots/
node scripts/build-gallery.cjs    # artifacts/visual-review.html
```

Individual gates:

| Command | What it proves |
| --- | --- |
| `npm run theme:check` | the generated CSS has not drifted from `brand/tokens.json` |
| `npm run typecheck` | strict TypeScript, no unused locals or parameters |
| `npm run lint` | no `fetch` / `WebSocket` / `EventSource` / `XMLHttpRequest` anywhere in `src/` |
| `npm run test` | 78 unit tests: dataset integrity, store behaviour, and a static scan for every forbidden transport, endpoint and API-key identifier |
| `npm run build` | production build |
| `npm run test:e2e` | no request leaves the preview origin on any route; no horizontal page overflow at seven viewport sizes |

## Layout

```
brand/                     the design system — tokens.json is the single source of truth
  tokens.json              edit this
  build-theme.cjs          then run: node brand/build-theme.cjs
  forge-tokens.css         GENERATED — never edit by hand
  forge-base.css           shared primitives

src/
  prototype/
    types/                 the data contract; every record carries prototype: true
    state/                 reducer, selectors, the local chat simulation
    data/                  the example dataset (projects, agents, tasks, graph, proof…)
  components/
    primitives/            StatusBadge, Panel, Button, Modal, Tabs, Meter, Machine…
    shell/                 sidebar, topbar, inspector, dock, command palette, toasts
  views/                   one folder per screen
  styles/app.css           global stylesheet; imports the brand CSS first

tests/
  unit/                    vitest
  e2e/                     playwright
artifacts/screenshots/     the captures
artifacts/visual-review.html   all captures on one page
```

## The rules this prototype is built on

**Tokens carry every value.** No raw hex in component CSS. If a semantic value is
missing, add a named token to `tokens.json` and rebuild — do not reach past the
semantic layer.

**The accent is rationed.** The palette is monochrome. Ember appears only on focus
rings, the active-control indicator and running progress. The primary button is an
inverted surface, not an accent fill.

**Status never depends on colour.** Every state renders an icon, an uppercase label and
a border treatment (`--forge-status-<key>-style` / `-width`). Read the interface in
greyscale and nothing is lost.

**Type marks provenance.** Monospace (`.fg-machine`) is what the system recorded — ids,
paths, model labels, timestamps, commands, test output. Sans is what a person wrote.

## Known limitations

- **The JS bundle is 1.23 MB (343 KB gzipped).** The `Icon` primitive resolves lucide
  icons by name, which defeats tree-shaking and pulls in the whole set. Harmless for a
  local prototype; worth a static icon map before this ships anywhere real.
- **Downloads and most settings are inert by design.** They fire a toast explaining so.
  The controls that genuinely work are appearance, density, sidebar, inspector and dock.
- **The Claude Code panel is a fixture browser, not detection.** It pages through six
  designed states so the future connection can be reviewed. Nothing is probed.
- **Screenshot artifacts have no image behind them.** The record carries a written
  caption instead of a fabricated screenshot.
- **`scraping` is the one unused project type.** None of the seven example projects
  genuinely fit it and inventing one would have read as filler.
- **`final-report.md` in the artifact list is a held draft** — the example mission still
  has an open mobile defect. That is deliberate, not an unfinished fixture.
- **Three `react-refresh` lint warnings** in `Sidebar.tsx` (constants exported beside
  components). They affect dev hot-reload granularity only.

## What is deliberately not here

The local Claude Code bridge. This phase is the visual layer only. The UI is shaped so
that connection can be added later — a status surface, a session chip, a settings
section — but nothing behind it has been built, and no API-key path exists anywhere in
the design.
