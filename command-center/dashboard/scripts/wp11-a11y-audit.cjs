#!/usr/bin/env node
/**
 * WP11 — a11y audit (DOM-level, no new dependency).
 *
 * No @axe-core/playwright is installed in this project (checked package.json
 * devDependencies before writing this). Rather than add a new npm dependency,
 * this script drives the already-installed @playwright/test's `chromium`
 * directly against the ALREADY-RUNNING gateway on :4100 (never starts its own
 * server — see the WP11 instruction to reuse the Lead's instance) and checks
 * the real WCAG-critical basics with plain DOM queries:
 *
 *   - every interactive element has an accessible name
 *   - images/icons have alt or aria-hidden
 *   - form controls have a real label
 *   - headings form a sane order (no skipped levels) inside <main>
 *   - landmarks exist (main / nav)
 *   - tab order reaches every visible focusable control, no trap
 *   - an aria-live region exists for the streaming chat region
 *
 * CommonJS (not ESM) on purpose: this project's eslint.config.js already
 * excludes `**\/*.cjs` as "zero-dependency tooling, deliberately outside the
 * app's module system" (same treatment as analyze-bundle.cjs, perf-report.cjs
 * etc.) — matching that convention avoids adding a one-off lint carve-out for
 * a script whose body legitimately references browser globals (document,
 * window) inside the function that gets serialised into the page.
 *
 * Usage: node scripts/wp11-a11y-audit.cjs [--json out.json]
 */

'use strict';

const fs = require('node:fs');
const { chromium } = require('@playwright/test');

const BASE_URL = 'http://127.0.0.1:4100';

const VIEWS = [
  ['Home', '/'],
  ['Chat', '/chat'],
  ['Projects', '/projects'],
  ['Mission', '/mission'],
  ['Agents', '/agents'],
  ['Files', '/files'],
  ['Tests', '/tests'],
  ['Activity', '/activity'],
  ['Settings', '/settings'],
];

/** Runs entirely inside the page — must stay a plain, serialisable function. */
function auditPage() {
  function computeAccessibleName(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() || '')
        .join(' ')
        .trim();
      if (text) return text;
    }

    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (el.id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (forLabel && forLabel.textContent?.trim()) return forLabel.textContent.trim();
      }
      const wrappingLabel = el.closest('label');
      if (wrappingLabel && wrappingLabel.textContent?.trim()) return wrappingLabel.textContent.trim();
      const title = el.getAttribute('title');
      if (title && title.trim()) return title.trim();
      return '';
    }

    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    const text = el.textContent?.trim();
    if (text) return text;

    // An <img> counts its own alt as its name when it IS the interactive node
    // (e.g. an <a><img alt="..."></a> with no other text).
    const img = el.querySelector?.('img[alt]');
    if (img && img.getAttribute('alt')?.trim()) return img.getAttribute('alt').trim();

    return '';
  }

  const INTERACTIVE_SELECTOR =
    'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
    'input:not([type="hidden"]), select, textarea, [tabindex]';

  // NOTE: getComputedStyle(el).display reflects only the element's OWN display
  // rule — an ancestor's `display: none` does not change a descendant's own
  // computed `display` property, it just prevents the whole subtree from
  // rendering. Checking only the element's own style therefore misses "really
  // invisible because a parent collapsed it" cases (e.g. this app's rail vs.
  // full sidebar action sets, only one of which renders at a time). Real
  // rendered-and-focusable presence is what getClientRects() reports: it is
  // empty for any element hidden by itself OR by an ancestor's display:none.
  const interactive = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden') return false;
    if (el.getClientRects().length === 0) return false;
    return true;
  });

  // tabindex="-1" is EXCLUDED from the browser's own sequential Tab order by
  // spec (it means "programmatically focusable only"). This project uses that
  // deliberately for two known-good patterns: a roving-tabindex group (e.g.
  // FilesView/ArtifactsView list rows, where only the active row is tabIndex=0
  // and arrow keys move it) and a programmatic skip target (AppShell's
  // <main tabIndex={-1}>, focused by the "Skip to content" link). Counting
  // these against "should be reachable via sequential Tab" would be a false
  // positive, not a real defect — so they are tracked separately.
  const rovingOrProgrammatic = interactive.filter((el) => el.getAttribute('tabindex') === '-1');
  const tabSequence = interactive.filter((el) => el.getAttribute('tabindex') !== '-1');

  const missingAccessibleName = [];
  for (const el of interactive) {
    const name = computeAccessibleName(el);
    if (!name) {
      missingAccessibleName.push({
        tag: el.tagName.toLowerCase(),
        className: el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : '',
        outerHTML: el.outerHTML.slice(0, 140),
      });
    }
  }

  const imgsWithoutAlt = Array.from(document.querySelectorAll('img')).filter(
    (img) => img.getAttribute('aria-hidden') !== 'true' && !img.hasAttribute('alt'),
  );

  const svgsWithoutHiddenOrName = Array.from(document.querySelectorAll('svg')).filter((svg) => {
    if (svg.getAttribute('aria-hidden') === 'true') return false;
    const hasTitle = !!svg.querySelector(':scope > title');
    const hasAriaLabel = !!(svg.getAttribute('aria-label') || svg.getAttribute('aria-labelledby'));
    const isImgRole = svg.getAttribute('role') === 'img';
    return !(hasTitle || hasAriaLabel || isImgRole);
  });

  const formControls = Array.from(
    document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
    ),
  ).filter((el) => {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
  const unlabeledFormControls = formControls.filter((el) => !computeAccessibleName(el));

  const main = document.querySelector('main');
  const headingScope = main || document.body;
  const headings = Array.from(headingScope.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => ({
    level: Number(h.tagName[1]),
    text: h.textContent?.trim().slice(0, 60) || '',
  }));
  const headingOrderViolations = [];
  let prevLevel = 0;
  for (const h of headings) {
    if (prevLevel > 0 && h.level > prevLevel + 1) {
      headingOrderViolations.push(`h${prevLevel} -> h${h.level} ("${h.text}")`);
    }
    prevLevel = h.level;
  }

  const landmarks = {
    main: !!document.querySelector('main'),
    nav: document.querySelectorAll('nav').length,
    navLabeled: Array.from(document.querySelectorAll('nav')).every(
      (n) => n.getAttribute('aria-label') || n.getAttribute('aria-labelledby'),
    ),
  };

  const ariaLiveRegions = document.querySelectorAll('[aria-live]').length;

  // Tag every element expected to be IN the sequential Tab order so the caller
  // can drive Tab from Node and match `document.activeElement` back to a
  // stable identity. Roving/programmatic tabindex=-1 elements are tagged with
  // a separate prefix so they are visible in the DOM but never expected to be
  // hit by plain sequential Tab.
  let idx = 0;
  for (const el of tabSequence) {
    el.setAttribute('data-wp11-focus-idx', String(idx));
    idx += 1;
  }
  for (const el of rovingOrProgrammatic) {
    el.setAttribute('data-wp11-roving-idx', 'roving');
  }

  return {
    interactiveCount: interactive.length,
    tabSequenceCount: tabSequence.length,
    rovingOrProgrammaticCount: rovingOrProgrammatic.length,
    missingAccessibleName,
    imgsWithoutAltCount: imgsWithoutAlt.length,
    svgsWithoutHiddenOrNameCount: svgsWithoutHiddenOrName.length,
    svgsWithoutHiddenOrNameSample: svgsWithoutHiddenOrName.slice(0, 5).map((s) => s.outerHTML.slice(0, 140)),
    formControlsCount: formControls.length,
    unlabeledFormControls: unlabeledFormControls.map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      className: el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : '',
    })),
    headings,
    headingOrderViolations,
    landmarks,
    ariaLiveRegions,
    focusableTagged: idx,
  };
}

async function auditTabOrder(page, expectedCount) {
  // Reset to a known start: focus the document body, then Tab through.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  const reached = new Set();
  const maxPresses = expectedCount + 8; // headroom for skip-link + shell chrome
  let stuckStreak = 0;
  let lastId = null;

  for (let i = 0; i < maxPresses; i += 1) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const tagged = el.getAttribute('data-wp11-focus-idx');
      if (tagged !== null) return `tagged:${tagged}`;
      // Shell chrome (skip link, drawer toggle, etc.) not tagged for this view's
      // own audit pass — still count it as a distinct stop by tag+text.
      return `untagged:${el.tagName}:${(el.textContent || '').trim().slice(0, 30)}`;
    });
    if (id === null) break;
    if (id === lastId) {
      stuckStreak += 1;
      if (stuckStreak >= 3) break; // real trap: focus stopped moving at all
    } else {
      stuckStreak = 0;
    }
    reached.add(id);
    lastId = id;
  }

  const taggedReached = Array.from(reached).filter((id) => id.startsWith('tagged:')).length;
  return { taggedReached, totalPresses: reached.size };
}

async function main() {
  const jsonFlagIdx = process.argv.indexOf('--json');
  const jsonOut = jsonFlagIdx >= 0 ? process.argv[jsonFlagIdx + 1] : null;

  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const [name, route] of VIEWS) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => {
        try {
          localStorage.setItem('forge.prototype.appearance', 'dark');
        } catch {
          /* ignore */
        }
      });
      await page.goto(`${BASE_URL}/#${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#root:not(:empty)', { timeout: 10_000 });
      await page.evaluate(() => document.fonts?.ready);
      await page.waitForTimeout(400);

      const audit = await page.evaluate(auditPage);
      const tabOrder = await auditTabOrder(page, audit.tabSequenceCount);

      results.push({ view: name, route, ...audit, tabOrder });
      await page.close();
    }
  } finally {
    await browser.close();
  }

  const lines = [];
  lines.push('WP11 a11y audit — per view (live, real DOM queries against :4100)');
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.view} (${r.route})`);
    lines.push(`  interactive elements checked        : ${r.interactiveCount} (sequential-tab ${r.tabSequenceCount} + roving/programmatic tabindex=-1 ${r.rovingOrProgrammaticCount})`);
    lines.push(`  missing accessible name             : ${r.missingAccessibleName.length}`);
    lines.push(`  images without alt/aria-hidden       : ${r.imgsWithoutAltCount}`);
    lines.push(`  svgs without hidden/name             : ${r.svgsWithoutHiddenOrNameCount}`);
    lines.push(`  form controls checked                : ${r.formControlsCount}`);
    lines.push(`  unlabeled form controls              : ${r.unlabeledFormControls.length}`);
    lines.push(`  heading order violations             : ${r.headingOrderViolations.length}${r.headingOrderViolations.length ? ' — ' + r.headingOrderViolations.join('; ') : ''}`);
    lines.push(`  landmarks: main=${r.landmarks.main} nav-count=${r.landmarks.nav} nav-all-labeled=${r.landmarks.navLabeled}`);
    lines.push(`  aria-live regions                    : ${r.ariaLiveRegions}`);
    lines.push(`  tab order: tagged reached ${r.tabOrder.taggedReached}/${r.tabSequenceCount} (raw stops seen ${r.tabOrder.totalPresses})`);
    if (r.missingAccessibleName.length) {
      lines.push(`  -- missing-name samples:`);
      for (const m of r.missingAccessibleName.slice(0, 6)) lines.push(`     ${m.tag}.${m.className} :: ${m.outerHTML}`);
    }
    if (r.unlabeledFormControls.length) {
      lines.push(`  -- unlabeled control samples:`);
      for (const m of r.unlabeledFormControls.slice(0, 6)) lines.push(`     ${m.tag}[type=${m.type}].${m.className}`);
    }
    if (r.svgsWithoutHiddenOrNameCount) {
      lines.push(`  -- svg samples:`);
      for (const s of r.svgsWithoutHiddenOrNameSample) lines.push(`     ${s}`);
    }
    lines.push('');
  }
  process.stdout.write(lines.join('\n') + '\n');

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  }
}

main().catch((err) => {
  console.error('wp11-a11y-audit failed:', err);
  process.exit(1);
});
