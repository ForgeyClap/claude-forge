#!/usr/bin/env node
/**
 * build-gallery.cjs — turns artifacts/screenshots/*.png into a single visual
 * review page at artifacts/visual-review.html.
 *
 * Zero dependencies, same house style as brand/build-theme.cjs. The page pulls
 * its colours from the generated token stylesheet, so the review page is itself
 * a check that the theme holds up.
 *
 *   node scripts/build-gallery.cjs
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHOTS_DIR = path.join(ROOT, 'artifacts', 'screenshots');
const OUT = path.join(ROOT, 'artifacts', 'visual-review.html');

function fail(msg) {
  process.stderr.write(`build-gallery: ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(SHOTS_DIR)) {
  fail(`no screenshots yet at ${path.relative(ROOT, SHOTS_DIR)}. Run: npm run shots`);
}

const files = fs
  .readdirSync(SHOTS_DIR)
  .filter((f) => f.endsWith('.png'))
  .sort();

if (files.length === 0) fail('screenshots directory is empty. Run: npm run shots');

/** "03-dark-project-overview-desktop.png" -> { n, theme, title, viewport } */
function describe(file) {
  const base = file.replace(/\.png$/, '');
  const [n, theme, ...rest] = base.split('-');
  const slug = rest.join('-');
  const viewport = /mobile$/.test(slug) ? 'mobile' : /desktop$/.test(slug) ? 'desktop' : 'full page';
  const title = slug
    .replace(/-(desktop|mobile)$/, '')
    .replace(/-/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
  return { n, theme, title, viewport, file };
}

const shots = files.map(describe);
const groups = [
  { key: 'dark', label: 'Dark theme' },
  { key: 'light', label: 'Light theme' },
];

const stamp = fs.statSync(path.join(SHOTS_DIR, files[0])).mtime.toISOString().slice(0, 16).replace('T', ' ');

const sections = groups
  .map((g) => {
    const items = shots.filter((s) => s.theme === g.key);
    if (items.length === 0) return '';
    const cards = items
      .map(
        (s) => `
        <figure class="shot" id="shot-${s.n}">
          <figcaption>
            <span class="idx fg-machine">${s.n}</span>
            <span class="title">${s.title}</span>
            <span class="meta fg-machine">${s.viewport}</span>
          </figcaption>
          <a href="screenshots/${s.file}" target="_blank" rel="noreferrer">
            <img src="screenshots/${s.file}" alt="${s.title}, ${g.label}, ${s.viewport}" loading="lazy" />
          </a>
        </figure>`,
      )
      .join('');
    return `<section><h2>${g.label} <span class="count fg-machine">${items.length}</span></h2>
      <div class="grid">${cards}</div></section>`;
  })
  .join('\n');

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Forge Workspace — visual review</title>
<link rel="stylesheet" href="../brand/forge-tokens.css" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--forge-space-8) var(--forge-space-6) var(--forge-space-20);
    background: var(--forge-color-canvas);
    color: var(--forge-color-text);
    font-family: var(--forge-font-sans);
    font-size: var(--forge-text-base);
    line-height: var(--forge-leading-normal);
  }
  .fg-machine { font-family: var(--forge-font-mono); font-size: var(--forge-text-xs); }
  header { max-width: 1400px; margin: 0 auto var(--forge-space-10); }
  h1 { font-size: var(--forge-text-2xl); font-weight: var(--forge-weight-semibold); margin: 0 0 var(--forge-space-2); letter-spacing: var(--forge-tracking-tight); }
  .lede { color: var(--forge-color-text-secondary); margin: 0 0 var(--forge-space-4); max-width: 62ch; }
  .flags { display: flex; flex-wrap: wrap; gap: var(--forge-space-2); }
  .flag { border: var(--forge-border-hair) solid var(--forge-color-line); border-radius: var(--forge-radius-full);
          padding: 2px var(--forge-space-3); color: var(--forge-color-text-muted); }
  section { max-width: 1400px; margin: 0 auto var(--forge-space-12); }
  h2 { font-size: var(--forge-text-lg); font-weight: var(--forge-weight-semibold); margin: 0 0 var(--forge-space-5);
       padding-bottom: var(--forge-space-3); border-bottom: var(--forge-border-hair) solid var(--forge-color-line-subtle);
       display: flex; align-items: baseline; gap: var(--forge-space-3); }
  .count { color: var(--forge-color-text-faint); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: var(--forge-space-6); }
  .shot { margin: 0; border: var(--forge-border-hair) solid var(--forge-color-line);
          border-radius: var(--forge-radius-lg); overflow: hidden; background: var(--forge-color-surface-1); }
  figcaption { display: flex; align-items: baseline; gap: var(--forge-space-3);
               padding: var(--forge-space-3) var(--forge-space-4);
               border-bottom: var(--forge-border-hair) solid var(--forge-color-line-subtle); }
  .idx { color: var(--forge-color-text-faint); }
  .title { font-weight: var(--forge-weight-medium); }
  .meta { margin-left: auto; color: var(--forge-color-text-muted); }
  img { display: block; width: 100%; height: auto; background: var(--forge-color-bg); }
  a:focus-visible { outline: 2px solid var(--forge-color-focus); outline-offset: 2px; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
  <header>
    <h1>Forge Workspace — visual review</h1>
    <p class="lede">
      ${shots.length} real captures of the running prototype, dark and light, desktop and mobile.
      Every screen is rendered from local example data.
    </p>
    <div class="flags">
      <span class="flag fg-machine">CONNECTED_TO_FORGE=false</span>
      <span class="flag fg-machine">CONNECTED_TO_CLAUDE_CODE=false</span>
      <span class="flag fg-machine">USES_ANTHROPIC_API=false</span>
      <span class="flag fg-machine">REQUIRES_ANTHROPIC_API_KEY=false</span>
      <span class="flag fg-machine">USES_MOCK_DATA=true</span>
      <span class="flag fg-machine">captured ${stamp}</span>
    </div>
  </header>
  ${sections}
</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
process.stdout.write(
  `build-gallery: wrote ${path.relative(ROOT, OUT)} - ${shots.length} screenshots\n`,
);
