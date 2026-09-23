#!/usr/bin/env node
/**
 * WP-B — real, visible-Chrome click-through of the running dashboard.
 *
 * Drives http://127.0.0.1:4100 (the gateway the Lead already started — this
 * script never starts/stops it) with a REAL, non-headless Chrome window,
 * real CDP mouse/keyboard events (see cdp-driver.cjs), across all 13 views,
 * their controls, three viewports, keyboard navigation, and one type-only
 * composer probe. Writes screenshots + a structured JSON results file to
 * command-center/mission/test-evidence/.
 *
 * Usage: node scripts/wpB-clicktest.cjs   (run from command-center/dashboard)
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');
const driver = require('./cdp-driver.cjs');

const PORT = 9333;
const BASE = 'http://127.0.0.1:4100';
const EVIDENCE_DIR = path.resolve(__dirname, '../../mission/test-evidence');
const SHOT_DIR = path.join(EVIDENCE_DIR, 'clicktest');
const RESULTS_PATH = path.join(EVIDENCE_DIR, 'WP-B-results.json');
const PROJECT_NAME = 'my project (v2)!';

const VIEWS = [
  ['home', '/'],
  ['projects', '/projects'],
  ['project-overview', '/project'],
  ['chat', '/chat'],
  ['mission', '/mission'],
  ['agents', '/agents'],
  ['tasks', '/tasks'],
  ['artifacts', '/artifacts'],
  ['tests', '/tests'],
  ['files', '/files'],
  ['activity', '/activity'],
  ['settings', '/settings'],
  ['theme', '/theme'],
];

const RESPONSIVE_VIEWS = ['home', 'chat', 'projects', 'mission', 'files', 'settings'];
const RESPONSIVE_VIEWPORTS = [
  ['1440', 1440, 900, false],
  ['768', 768, 1024, false],
  ['375', 375, 812, true],
];

const CONTROL_CAP = 7;

const FIXTURE_LANGUAGE = /example|prototype|placeholder|nothing (was|is) (created|generated|attached|changed|loaded|sent)|not (yet )?connected|not attached|no file behind|not implemented/i;

const results = {
  startedAt: new Date().toISOString(),
  base: BASE,
  project: PROJECT_NAME,
  views: [],
  shellControls: [],
  viewControls: [],
  responsive: [],
  keyboard: [],
  composer: null,
  consoleErrors: [],
  consoleWarnings: [],
  failedRequests: [],
  screenshots: [],
  fixtureSurvivors: [],
};

function log(...args) {
  console.log('[wpB]', ...args);
}

function shot(session, name) {
  const file = path.join(SHOT_DIR, `${name}.png`);
  return driver.screenshot(session, file).then(() => {
    results.screenshots.push(file);
    log('screenshot', name);
    return file;
  });
}

async function apiFetch(pathAndQuery) {
  try {
    const res = await fetch(`${BASE}${pathAndQuery}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    return { status: 0, ok: false, error: String(err) };
  }
}

/* ------------------------------------------------------------- DOM helpers */

async function mainText(session) {
  return driver.evaluate(
    session,
    `(() => { const el = document.querySelector('#fw-main'); return el ? el.innerText.slice(0, 4000) : ''; })()`,
  );
}

async function lastToast(session) {
  return driver.evaluate(
    session,
    `(() => {
      const nodes = Array.from(document.querySelectorAll('.fw-toast'));
      if (nodes.length === 0) return null;
      const last = nodes[nodes.length - 1];
      const title = last.querySelector('.fw-toast__title')?.textContent?.trim() ?? '';
      const detail = last.querySelector('.fw-toast__detail')?.textContent?.trim() ?? '';
      return { count: nodes.length, title, detail };
    })()`,
  );
}

async function currentPath(session) {
  return driver.evaluate(session, `(() => location.pathname + location.hash)()`);
}

/**
 * Regression-gate scan (mission Part 1): document.body.innerText (the WHOLE rendered
 * app, not just #fw-main's first 4000 chars) PLUS every aria-label/title/data-label
 * attribute and every <caption> element. Returns raw {source, text} pairs; the caller
 * tests each against FIXTURE_LANGUAGE so a survivor's exact source+text is reportable.
 */
async function collectAllTextSurfaces(session) {
  return driver.evaluate(
    session,
    `(() => {
      const out = [];
      out.push({ source: 'body.innerText', text: document.body.innerText || '' });
      document.querySelectorAll('[aria-label]').forEach((el) => {
        const v = el.getAttribute('aria-label');
        if (v) out.push({ source: 'aria-label', text: v, tag: el.tagName.toLowerCase() });
      });
      document.querySelectorAll('[title]').forEach((el) => {
        const v = el.getAttribute('title');
        if (v) out.push({ source: 'title', text: v, tag: el.tagName.toLowerCase() });
      });
      document.querySelectorAll('[data-label]').forEach((el) => {
        const v = el.getAttribute('data-label');
        if (v) out.push({ source: 'data-label', text: v, tag: el.tagName.toLowerCase() });
      });
      document.querySelectorAll('caption').forEach((el) => {
        out.push({ source: 'caption', text: el.textContent || '' });
      });
      return out;
    })()`,
  );
}

async function scanFixtureSurvivors(session, viewName) {
  const surfaces = await collectAllTextSurfaces(session).catch(() => []);
  const found = [];
  for (const surface of surfaces) {
    const text = surface.text || '';
    // body.innerText is scanned line-by-line so a survivor's exact offending line is
    // reported, not the whole multi-thousand-char page dump.
    if (surface.source === 'body.innerText') {
      for (const line of text.split('\n')) {
        if (FIXTURE_LANGUAGE.test(line) && line.trim().length > 0) {
          found.push({ view: viewName, source: surface.source, text: line.trim().slice(0, 200) });
        }
      }
    } else if (FIXTURE_LANGUAGE.test(text)) {
      found.push({ view: viewName, source: surface.source, tag: surface.tag || '', text: text.slice(0, 200) });
    }
  }
  return found;
}

const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], .fw-command-palette, [cmdk-root], .fw-chat-menu__panel, .fw-account, .fw-topbar__appearance[data-open="true"]';

async function overlayOpen(session) {
  return driver
    .evaluate(session, `!!document.querySelector(${JSON.stringify(OVERLAY_SELECTOR)})`)
    .catch(() => false);
}

/**
 * FIX (WP fin-e2e-reality, clean re-click round): the previous version unconditionally
 * fired a blind coordinate click at (700, 20) "to close any open popover" — that point
 * happened to overlap the topbar search button, which OPENS the command palette
 * (unconditional `dispatch({type:'palette/set', open:true})`, not a toggle) rather than
 * closing anything. Because the palette-open flag lives in shell state that does not
 * remount on a same-document hash navigation, the reopened palette silently intercepted
 * many later clicks for the rest of that run. Fixed to dismiss via Escape ONLY, verifying
 * via a real DOM query that no overlay remains open afterwards — never a blind click.
 */
async function dismissOverlays(session) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await overlayOpen(session))) return true;
    await driver.pressKey(session, 'Escape');
    await new Promise((r) => setTimeout(r, 150));
  }
  return !(await overlayOpen(session));
}

async function collectMainControls(session) {
  return driver.evaluate(
    session,
    `(() => {
      const root = document.querySelector('#fw-main');
      if (!root) return [];
      const nodes = Array.from(root.querySelectorAll(
        'button, [role="tab"], [role="switch"], select, input, textarea, a[href]'
      ));
      const out = [];
      nodes.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) return;
        if (el.disabled) return;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return;
        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          role: el.getAttribute('role') || '',
          text: (el.textContent || '').trim().slice(0, 60),
          label: el.getAttribute('aria-label') || '',
          href: el.getAttribute('href') || '',
        });
      });
      return out;
    })()`,
  );
}

function signature(c) {
  return `${c.tag}|${c.type}|${c.role}|${c.label || c.text}|${c.href}`;
}

/** Priority: real controls (buttons/inputs/tabs/switches) before plain links. */
function prioritize(list) {
  const weight = (c) => {
    if (c.tag === 'a') return 3;
    if (c.tag === 'input' || c.tag === 'select' || c.tag === 'textarea') return 0;
    if (c.role === 'tab' || c.role === 'switch') return 0;
    return 1;
  };
  return [...list].sort((a, b) => weight(a) - weight(b));
}

/* ------------------------------------------------------------- view sweep */

async function classifyView(name, route, session, mainTextValue, apiCrossCheck) {
  const lower = mainTextValue.toLowerCase();
  const looksEmpty = /no [a-z ]+ (yet|found|match)|nothing here|empty/.test(lower) && mainTextValue.trim().length < 600;
  const looksFixtureWorded = FIXTURE_LANGUAGE.test(mainTextValue);
  let verdict = 'unknown';
  if (mainTextValue.trim().length === 0) verdict = 'error-or-blank';
  else if (apiCrossCheck && apiCrossCheck.matched) verdict = 'real (API cross-check matched)';
  else if (looksEmpty) verdict = 'empty-state';
  else if (looksFixtureWorded) verdict = 'fixture-language-present';
  else verdict = 'real-or-unverified (no fixture wording, no direct API match found)';
  return verdict;
}

async function sweepView([name, route], session) {
  log('=== VIEW', name, route, '===');
  await driver.navigate(session, `${BASE}/#${route}`);
  await new Promise((r) => setTimeout(r, 350));
  await shot(session, `view-${name}-1440`);

  // Regression-gate scan: body.innerText + aria-label/title/data-label/caption, BEFORE
  // any control is clicked (clean initial render — mission Part 1's "zero rendered
  // fixture-language" assertion).
  const survivors = await scanFixtureSurvivors(session, name);
  if (survivors.length > 0) results.fixtureSurvivors.push(...survivors);
  log(name, 'fixture-survivor scan:', survivors.length === 0 ? 'clean' : `${survivors.length} FOUND`);

  const text = await mainText(session);
  const urlNow = await currentPath(session);

  const view = { name, route, urlNow, textSample: text.slice(0, 300), verdict: null, apiCrossCheck: null };
  results.views.push(view);

  const controls = prioritize(await collectMainControls(session)).slice(0, CONTROL_CAP);
  log(name, 'controls found (capped):', controls.length);

  for (let i = 0; i < controls.length; i++) {
    if (i > 0) {
      await driver.navigate(session, `${BASE}/#${route}`);
      await new Promise((r) => setTimeout(r, 250));
      await dismissOverlays(session).catch(() => {});
    }
    const fresh = await collectMainControls(session);
    const wanted = controls[i];
    const match = fresh.find((c) => signature(c) === signature(wanted)) || fresh[i];
    if (!match) continue;

    const idxInFresh = fresh.indexOf(match);
    const selectorExpr = `(() => {
      const root = document.querySelector('#fw-main');
      const nodes = Array.from(root.querySelectorAll('button, [role="tab"], [role="switch"], select, input, textarea, a[href]'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width>1 && r.height>1 && !el.disabled; });
      const el = nodes[${idxInFresh}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + Math.min(r.height/2, r.height-2) };
    })()`;
    const point = await driver.evaluate(session, selectorExpr).catch(() => null);
    if (!point) continue;

    const urlBefore = await currentPath(session);
    const toastBefore = await lastToast(session);

    await driver.clickXY(session, point.x, point.y);
    await new Promise((r) => setTimeout(r, 300));

    const urlAfter = await currentPath(session);
    const toastAfter = await lastToast(session);

    let toastFired = null;
    if (toastAfter && (!toastBefore || toastAfter.count > toastBefore.count || toastAfter.title !== toastBefore.title)) {
      toastFired = { title: toastAfter.title, detail: toastAfter.detail };
    }

    let verdict;
    if (toastFired && FIXTURE_LANGUAGE.test(`${toastFired.title} ${toastFired.detail}`)) {
      verdict = 'FIXTURE_TOAST';
    } else if (toastFired) {
      verdict = 'REAL_TOAST';
    } else if (urlAfter !== urlBefore) {
      verdict = 'REAL_NAV';
    } else {
      // Distinguish "opened something" from truly nothing by checking for a
      // freshly-visible popover/menu/panel in the DOM.
      const opened = await driver
        .evaluate(
          session,
          `(() => !!document.querySelector('[role="menu"], [role="dialog"], .fw-chat-menu__panel'))()`,
        )
        .catch(() => false);
      verdict = opened ? 'OPENED_PANEL' : 'NO_VISIBLE_EFFECT';
    }

    results.viewControls.push({
      view: name,
      control: { tag: wanted.tag, type: wanted.type, role: wanted.role, text: wanted.text, label: wanted.label, href: wanted.href },
      urlBefore,
      urlAfter,
      toast: toastFired,
      verdict,
    });
    log('  control', i, wanted.tag, (wanted.label || wanted.text || wanted.href).slice(0, 40), '->', verdict);

    if (urlAfter !== urlBefore) {
      // real navigation happened — screenshot the destination once, then the
      // top-of-loop re-navigate back to `route` will restore isolation.
      await shot(session, `view-${name}-control${i}-nav-${urlAfter.replace(/[/#]/g, '_')}`).catch(() => {});
    } else {
      await dismissOverlays(session).catch(() => {});
    }
  }

  // API cross-check: for the views backed by /api/*, fetch the real endpoint
  // scoped to this project and compare a real name/count against what rendered.
  let apiCrossCheck = null;
  const checks = {
    projects: () => apiFetch('/api/projects'),
    agents: () => apiFetch(`/api/agents?project=${encodeURIComponent(PROJECT_NAME)}`),
    tasks: () => apiFetch(`/api/missions?project=${encodeURIComponent(PROJECT_NAME)}&run=none`),
    files: () => apiFetch(`/api/files?project=${encodeURIComponent(PROJECT_NAME)}`),
    chat: () => apiFetch('/api/conversations'),
    settings: () => apiFetch('/api/health'),
  };
  if (checks[name]) {
    const r = await checks[name]();
    apiCrossCheck = { endpoint: name, status: r.status, ok: r.ok };
    if (r.ok && r.body) {
      if (name === 'projects' && Array.isArray(r.body.projects)) {
        apiCrossCheck.apiCount = r.body.projects.length;
        apiCrossCheck.matched = r.body.projects.some((p) => text.includes(p.name));
      } else if (name === 'agents' && Array.isArray(r.body.agents)) {
        apiCrossCheck.apiCount = r.body.agents.length;
        apiCrossCheck.matched = r.body.agents.some((a) => text.includes(a.slug) || text.includes(a.name));
      } else if (name === 'files' && Array.isArray(r.body.entries)) {
        apiCrossCheck.apiCount = r.body.entries.length;
        apiCrossCheck.matched = r.body.entries.some((e) => text.includes(e.name));
      } else if (name === 'chat' && Array.isArray(r.body.conversations)) {
        apiCrossCheck.apiCount = r.body.conversations.length;
        apiCrossCheck.matched = r.body.conversations.some((c) => text.includes(c.title));
      } else if (name === 'settings') {
        apiCrossCheck.matched = false; // health is not surfaced verbatim in Settings; recorded for completeness
      } else if (name === 'tasks') {
        apiCrossCheck.matched = r.ok; // 400 without a real run id is expected; presence of endpoint is the point
      }
    }
  }
  view.apiCrossCheck = apiCrossCheck;
  view.verdict = await classifyView(name, route, session, text, apiCrossCheck);
  log(name, 'VERDICT:', view.verdict, apiCrossCheck ? JSON.stringify(apiCrossCheck) : '(no direct API check)');
}

/* -------------------------------------------------------------- shell test */

async function shellSweep(session) {
  log('=== SHELL CHROME (sidebar/topbar) ===');
  await driver.navigate(session, `${BASE}/#/`);
  await new Promise((r) => setTimeout(r, 300));

  async function clickAndRecord(label, selectorPoint) {
    const toastBefore = await lastToast(session);
    const urlBefore = await currentPath(session);
    await driver.clickXY(session, selectorPoint.x, selectorPoint.y);
    await new Promise((r) => setTimeout(r, 300));
    const toastAfter = await lastToast(session);
    const urlAfter = await currentPath(session);
    let toastFired = null;
    if (toastAfter && (!toastBefore || toastAfter.count > toastBefore.count || toastAfter.title !== toastBefore.title)) {
      toastFired = { title: toastAfter.title, detail: toastAfter.detail };
    }
    let verdict = 'NO_VISIBLE_EFFECT';
    if (toastFired && FIXTURE_LANGUAGE.test(`${toastFired.title} ${toastFired.detail}`)) verdict = 'FIXTURE_TOAST';
    else if (toastFired) verdict = 'REAL_TOAST';
    else if (urlAfter !== urlBefore) verdict = 'REAL_NAV';
    results.shellControls.push({ control: label, urlBefore, urlAfter, toast: toastFired, verdict });
    log('  shell:', label, '->', verdict, toastFired ? `(${toastFired.title})` : '');
    return { toastFired, urlBefore, urlAfter };
  }

  async function pointFor(selectorFn) {
    return driver.evaluate(session, selectorFn);
  }

  // New project (big sidebar button) — mission Part 1 regression gate: must be honestly
  // disabled with a title, and clicking it (even though disabled elements swallow real
  // pointer events) must never fire a toast claiming a prototype/fabricated project.
  const newProjectState = await driver.evaluate(
    session,
    `(() => { const b = Array.from(document.querySelectorAll('.fw-sidebar__action')).find(x=>x.textContent.includes('New project')); if(!b) return null; return { disabled: b.disabled, title: b.getAttribute('title') || '', ariaDisabled: b.getAttribute('aria-disabled') }; })()`,
  );
  const toastBeforeNewProject = await lastToast(session);
  const ptNewProject = await pointFor(`(() => { const b = Array.from(document.querySelectorAll('.fw-sidebar__action')).find(x=>x.textContent.includes('New project')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (ptNewProject) await driver.clickXY(session, ptNewProject.x, ptNewProject.y);
  await new Promise((r) => setTimeout(r, 250));
  const toastAfterNewProject = await lastToast(session);
  const newProjectToastFired = toastAfterNewProject && (!toastBeforeNewProject || toastAfterNewProject.count > toastBeforeNewProject.count);
  const newProjectHonest = !!(newProjectState && newProjectState.disabled === true && newProjectState.title.length > 0 && !newProjectToastFired);
  results.shellControls.push({
    control: 'Sidebar: New project button (honesty gate)',
    state: newProjectState,
    toastFiredOnClick: newProjectToastFired ? toastAfterNewProject : null,
    verdict: newProjectHonest ? 'HONEST_DISABLED' : 'REGRESSION_SUSPECT',
  });
  log('  shell: New project honesty ->', newProjectHonest ? 'HONEST_DISABLED' : 'REGRESSION_SUSPECT (' + JSON.stringify(newProjectState) + ')');

  // New chat (mission Part 1 regression gate: must ACTUALLY create/activate a real
  // conversation — verified via a real /api/conversations count before/after, not just
  // "a toast appeared").
  const convBefore = await apiFetch('/api/conversations');
  const countBefore = convBefore.ok && Array.isArray(convBefore.body?.conversations) ? convBefore.body.conversations.length : null;
  let pt = await pointFor(`(() => { const b = Array.from(document.querySelectorAll('.fw-sidebar__action')).find(x=>x.textContent.includes('New chat')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (pt) {
    const { toastFired } = await clickAndRecord('Sidebar: New chat button', pt);
    await new Promise((r) => setTimeout(r, 300));
    const convAfter = await apiFetch('/api/conversations');
    const countAfter = convAfter.ok && Array.isArray(convAfter.body?.conversations) ? convAfter.body.conversations.length : null;
    const realConversationCreated = countBefore !== null && countAfter !== null && countAfter > countBefore;
    results.shellControls.push({
      control: 'Sidebar: New chat button (real-conversation gate)',
      countBefore,
      countAfter,
      urlAfterClick: await currentPath(session),
      toast: toastFired,
      verdict: realConversationCreated ? 'REAL_CONVERSATION_CREATED' : 'NO_REAL_CONVERSATION_DETECTED',
    });
    log('  shell: New chat conversation count', countBefore, '->', countAfter, realConversationCreated ? 'REAL_CONVERSATION_CREATED' : 'NO_REAL_CONVERSATION_DETECTED');
    await driver.navigate(session, `${BASE}/#/`);
    await new Promise((r) => setTimeout(r, 250));
  }

  // Sidebar collapse toggle
  pt = await pointFor(`(() => { const b = document.querySelector('.fw-sidebar__collapse'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (pt) {
    const before = await driver.evaluate(session, `document.querySelector('.fw-sidebar').getAttribute('data-collapsed')`);
    await driver.clickXY(session, pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 250));
    const after = await driver.evaluate(session, `document.querySelector('.fw-sidebar').getAttribute('data-collapsed')`);
    await shot(session, 'shell-sidebar-collapsed');
    results.shellControls.push({ control: 'Sidebar collapse toggle', before, after, verdict: before !== after ? 'REAL_UI_CHANGE' : 'NO_VISIBLE_EFFECT' });
    log('  shell: sidebar collapse', before, '->', after);
    // restore
    await driver.clickXY(session, pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 250));
  }

  // Sidebar search: type into it, verify filtering, then clear
  const searchRect = await driver.getRect(session, '#fw-sidebar-search');
  if (searchRect && searchRect.visible) {
    await driver.clickXY(session, searchRect.x + searchRect.width / 2, searchRect.y + searchRect.height / 2);
    await driver.typeText(session, 'zzz-no-such-project-zzz');
    await new Promise((r) => setTimeout(r, 250));
    const filteredText = await driver.evaluate(session, `document.querySelector('.fw-sidebar__scroll').innerText`);
    await shot(session, 'shell-sidebar-search-filtered');
    const noMatch = /no project matches/i.test(filteredText);
    results.shellControls.push({ control: 'Sidebar search input (type nonsense)', verdict: noMatch ? 'REAL_FILTER_EMPTY_STATE' : 'UNCLEAR', sample: filteredText.slice(0, 200) });
    log('  shell: search filter ->', noMatch ? 'REAL_FILTER_EMPTY_STATE' : 'UNCLEAR');
    // clear
    const clearPt = await pointFor(`(() => { const b = document.querySelector('.fw-sidebar__search-clear'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    if (clearPt) await driver.clickXY(session, clearPt.x, clearPt.y);
    await new Promise((r) => setTimeout(r, 200));
  }

  // Project row pin toggle (first pinned/recent row)
  pt = await pointFor(`(() => { const b = document.querySelector('.fw-prow__tools .fw-icon-button, .fw-prow [aria-label^="Pin"], .fw-prow [aria-label^="Unpin"]'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (pt) {
    await clickAndRecord('Sidebar: project row pin toggle', pt);
    // restore by clicking again
    await driver.clickXY(session, pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 200));
  }

  // Project row ellipsis -> menu -> Rename (inert)
  pt = await pointFor(`(() => { const b = document.querySelector('.fw-prow [aria-label^="More actions"]'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (pt) {
    await driver.clickXY(session, pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 250));
    await shot(session, 'shell-project-menu-open');
    const renamePt = await pointFor(`(() => { const b = Array.from(document.querySelectorAll('[role="menuitem"]')).find(x=>x.textContent.includes('Rename')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    if (renamePt) await clickAndRecord('Sidebar: project menu -> Rename', renamePt);
    else await dismissOverlays(session);
  }

  // Topbar search -> command palette
  pt = await pointFor(`(() => { const b = document.querySelector('.fw-topbar__search'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (pt) {
    await driver.clickXY(session, pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 250));
    const openedPalette = await driver.evaluate(session, `!!document.querySelector('[role="dialog"], .fw-command-palette, [cmdk-root]')`).catch(() => false);
    await shot(session, 'shell-command-palette-open');
    results.shellControls.push({ control: 'Topbar: search -> command palette', verdict: openedPalette ? 'REAL_UI_CHANGE' : 'UNCLEAR' });
    log('  shell: command palette open ->', openedPalette);
    await dismissOverlays(session);
  }

  // Topbar appearance: Light then back to Dark
  pt = await pointFor(`(() => { const opts = Array.from(document.querySelectorAll('.fw-topbar__appearance button')); const b = opts.find(x => /light/i.test(x.textContent) || /light/i.test(x.getAttribute('aria-label')||'')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (pt) {
    await driver.clickXY(session, pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 250));
    const theme = await driver.evaluate(session, `document.documentElement.getAttribute('data-theme')`);
    await shot(session, 'shell-appearance-light');
    results.shellControls.push({ control: 'Topbar: appearance -> Light', verdict: theme === 'light' ? 'REAL_UI_CHANGE' : 'NO_VISIBLE_EFFECT', theme });
    log('  shell: appearance -> light, data-theme=', theme);
    // restore dark
    const darkPt = await pointFor(`(() => { const opts = Array.from(document.querySelectorAll('.fw-topbar__appearance button')); const b = opts.find(x => /dark/i.test(x.textContent) || /dark/i.test(x.getAttribute('aria-label')||'')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    if (darkPt) {
      await driver.clickXY(session, darkPt.x, darkPt.y);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Dock toggle
  pt = await pointFor(`(() => { const b = Array.from(document.querySelectorAll('.fw-topbar__panels button')).find(x => /dock/i.test(x.getAttribute('aria-label')||'')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (pt) {
    const before = await driver.evaluate(session, `document.querySelector('.fw-shell').getAttribute('data-dock')`);
    await driver.clickXY(session, pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 250));
    const after = await driver.evaluate(session, `document.querySelector('.fw-shell').getAttribute('data-dock')`);
    await shot(session, 'shell-dock-open');
    results.shellControls.push({ control: 'Topbar: dock toggle', before, after, verdict: before !== after ? 'REAL_UI_CHANGE' : 'NO_VISIBLE_EFFECT' });
    log('  shell: dock', before, '->', after);
    await driver.clickXY(session, pt.x, pt.y); // restore
    await new Promise((r) => setTimeout(r, 200));
  }

  // Inspector toggle
  pt = await pointFor(`(() => { const b = Array.from(document.querySelectorAll('.fw-topbar__panels button')).find(x => /inspector/i.test(x.getAttribute('aria-label')||'')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (pt) {
    const before = await driver.evaluate(session, `document.querySelector('.fw-shell').getAttribute('data-inspector')`);
    await driver.clickXY(session, pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 250));
    const after = await driver.evaluate(session, `document.querySelector('.fw-shell').getAttribute('data-inspector')`);
    await shot(session, 'shell-inspector-toggled');
    results.shellControls.push({ control: 'Topbar: inspector toggle', before, after, verdict: before !== after ? 'REAL_UI_CHANGE' : 'NO_VISIBLE_EFFECT' });
    log('  shell: inspector', before, '->', after);
    await driver.clickXY(session, pt.x, pt.y); // restore
    await new Promise((r) => setTimeout(r, 200));
  }

  // Account popover -> density control
  pt = await pointFor(`(() => { const b = document.querySelector('.fw-topbar__account-button'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (pt) {
    await driver.clickXY(session, pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 250));
    await shot(session, 'shell-account-popover-open');
    const compactPt = await pointFor(`(() => { const opts = Array.from(document.querySelectorAll('.fw-account button')); const b = opts.find(x => /compact/i.test(x.textContent)); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    if (compactPt) {
      await driver.clickXY(session, compactPt.x, compactPt.y);
      await new Promise((r) => setTimeout(r, 250));
      const density = await driver.evaluate(session, `document.documentElement.getAttribute('data-density')`);
      results.shellControls.push({ control: 'Account popover: density -> Compact', verdict: density === 'compact' ? 'REAL_UI_CHANGE' : 'NO_VISIBLE_EFFECT', density });
      log('  shell: density ->', density);
      const comfyPt = await pointFor(`(() => { const opts = Array.from(document.querySelectorAll('.fw-account button')); const b = opts.find(x => /comfortable/i.test(x.textContent)); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      if (comfyPt) await driver.clickXY(session, comfyPt.x, comfyPt.y);
    }
    await dismissOverlays(session);
  }
}

/* --------------------------------------------------------------- responsive */

async function responsivePass(session) {
  log('=== RESPONSIVE PASS ===');
  for (const viewName of RESPONSIVE_VIEWS) {
    const route = VIEWS.find((v) => v[0] === viewName)[1];
    for (const [label, width, height, mobile] of RESPONSIVE_VIEWPORTS) {
      await driver.setViewport(session, { width, height, mobile });
      await driver.navigate(session, `${BASE}/#${route}`);
      await new Promise((r) => setTimeout(r, 350));
      await shot(session, `responsive-${viewName}-${label}`);
      const overflow = await driver.evaluate(
        session,
        `(() => { const d = document.documentElement; return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, overflowX: d.scrollWidth > d.clientWidth + 2 }; })()`,
      );
      results.responsive.push({ view: viewName, width: label, ...overflow });
      log('  responsive', viewName, label, overflow.overflowX ? 'OVERFLOW-X!' : 'ok');
    }
  }
  await driver.clearViewportOverride(session).catch(() => {});
  await driver.setViewport(session, { width: 1440, height: 900, mobile: false });
}

/* ---------------------------------------------------------------- keyboard */

async function keyboardPass(session) {
  log('=== KEYBOARD PASS ===');
  await driver.navigate(session, `${BASE}/#/`);
  await new Promise((r) => setTimeout(r, 300));
  // Focus the document body first via a neutral click, then Tab repeatedly.
  await driver.clickXY(session, 5, 5);
  const sequence = [];
  for (let i = 0; i < 16; i++) {
    await driver.pressKey(session, 'Tab');
    await new Promise((r) => setTimeout(r, 90));
    const info = await driver.evaluate(
      session,
      `(() => {
        const el = document.activeElement;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const hasVisibleFocus = style.outlineStyle !== 'none' || style.boxShadow !== 'none';
        return {
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 40),
          label: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || '',
          visible: r.width > 0 && r.height > 0,
          hasVisibleFocus,
        };
      })()`,
    );
    sequence.push(info);
  }
  await shot(session, 'keyboard-tab-sequence-end');
  const stuckOnBody = sequence.every((s) => !s || s.tag === 'body');
  results.keyboard.push({ pass: 'Home 1440 — 16x Tab', sequence, stuckOnBody });
  log('  keyboard: tab sequence tags:', sequence.map((s) => (s ? s.tag : 'null')).join(','));
}

/* ---------------------------------------------------------------- composer */

async function composerProbe(session) {
  log('=== COMPOSER TYPE-ONLY PROBE (no send — mock mode not verified) ===');
  await driver.navigate(session, `${BASE}/#/chat`);
  await new Promise((r) => setTimeout(r, 350));
  const rect = await driver.getRect(session, '.fw-chat-composer__field');
  if (!rect || !rect.visible) {
    results.composer = { ok: false, reason: 'composer field not found/visible' };
    return;
  }
  await driver.clickXY(session, rect.x + rect.width / 2, rect.y + rect.height / 2);
  const sample = 'WP-B click-test probe — typed only, not sent.';
  await driver.typeText(session, sample);
  await new Promise((r) => setTimeout(r, 200));
  const value = await driver.evaluate(session, `document.querySelector('.fw-chat-composer__field')?.value ?? ''`);
  await shot(session, 'composer-typed-not-sent');
  const sendDisabled = await driver.evaluate(
    session,
    `(() => { const b = Array.from(document.querySelectorAll('.fw-chat-composer button')).find(x=>/send/i.test(x.textContent)); return b ? b.disabled : null; })()`,
  );
  // Clear the field afterwards — do NOT send.
  await driver.evaluate(session, `(() => { const f = document.querySelector('.fw-chat-composer__field'); if(f){ const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; setter.call(f,''); f.dispatchEvent(new Event('input',{bubbles:true})); } })()`);
  results.composer = { ok: true, typed: sample, valueMatched: value === sample, sendButtonDisabledAfterTyping: sendDisabled, sentMessage: false };
  log('  composer: typed value matches?', value === sample, 'send disabled after typing (unexpected if true)?', sendDisabled);
}

/* ------------------------------------------------------------------- main */

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpB-chrome-'));

  log('Launching VISIBLE Chrome, remote-debugging-port', PORT, 'profile', profileDir);
  const chromeProc = driver.launchChrome({ port: PORT, userDataDir: profileDir, startUrl: `${BASE}/#/`, width: 1440, height: 900 });

  try {
    await driver.waitForCdp(PORT, 20000);
    const session = await driver.connectToFirstPage(PORT, 20000);
    log('CDP session connected. pid=', chromeProc.pid);

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    await session.send('Log.enable');
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try { localStorage.setItem('forge.prototype.appearance','dark'); } catch(e) {}",
    });

    session.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        results.consoleErrors.push({ text: (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400), ts: Date.now() });
      } else if (params.type === 'warning') {
        results.consoleWarnings.push({ text: (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300), ts: Date.now() });
      }
    });
    session.on('Log.entryAdded', (params) => {
      if (params.entry && params.entry.level === 'error') {
        results.consoleErrors.push({ text: `[Log] ${params.entry.text}`.slice(0, 400), ts: Date.now() });
      }
    });
    session.on('Network.responseReceived', (params) => {
      const status = params.response.status;
      if (status >= 400) {
        results.failedRequests.push({ url: params.response.url, status, ts: Date.now() });
      }
    });
    session.on('Network.loadingFailed', (params) => {
      results.failedRequests.push({ url: params.requestId, errorText: params.errorText, ts: Date.now() });
    });

    await driver.setViewport(session, { width: 1440, height: 900, mobile: false });

    // Phase 1: shell chrome
    await shellSweep(session);

    // Phase 2: per-view sweep (13 views)
    for (const view of VIEWS) {
      await sweepView(view, session);
    }

    // Phase 3: responsive
    await responsivePass(session);

    // Phase 4: keyboard
    await keyboardPass(session);

    // Phase 5: composer type-only
    await composerProbe(session);

    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    log('Results written to', RESULTS_PATH);

    session.close();
  } finally {
    log('Killing Chrome (pid', chromeProc.pid, ') and its child processes...');
    try {
      execSync(`taskkill /PID ${chromeProc.pid} /T /F`, { stdio: 'ignore' });
    } catch (err) {
      log('taskkill warning:', err.message);
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('[wpB] FATAL:', err);
  fs.writeFileSync(RESULTS_PATH, JSON.stringify({ ...results, fatalError: String(err && err.stack || err) }, null, 2));
  process.exit(1);
});
