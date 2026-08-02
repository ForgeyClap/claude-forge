#!/usr/bin/env node
/**
 * WP-B — a minimal, dependency-free (beyond the already-installed `ws`)
 * Chrome DevTools Protocol driver for REAL, VISIBLE browser click-testing.
 *
 * Deliberately NOT Playwright: WP-B's mandate is to drive the app with real
 * OS-level input events (Input.dispatchMouseEvent / Input.dispatchKeyEvent)
 * against a Chrome window the tester can actually see, not framework
 * `element.click()` shortcuts. Uses only Node's built-in `fetch`/`child_process`
 * plus the `ws` package already listed in package.json dependencies.
 *
 * Usage: const { launchChrome, connect } = require('./cdp-driver.cjs');
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Users/YOU/.cache/puppeteer/chrome/win64-149.0.7827.22/chrome-win64/chrome.exe',
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No Chrome executable found among: ' + CHROME_CANDIDATES.join(', '));
}

/** Poll http://127.0.0.1:<port>/json/version until Chrome's CDP endpoint answers. */
async function waitForCdp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return res.json();
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome CDP endpoint on port ${port} did not come up: ${lastErr}`);
}

/**
 * Launch a REAL, VISIBLE Chrome window with remote debugging enabled.
 * No --headless flag anywhere — this is the whole point of WP-B.
 */
function launchChrome({ port = 9333, userDataDir, startUrl = 'about:blank', width = 1440, height = 900 } = {}) {
  const exe = findChrome();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    `--window-size=${width},${height}`,
    '--window-position=40,40',
    startUrl,
  ];
  const child = spawn(exe, args, { stdio: 'ignore', detached: false });
  return child;
}

/** Fetch the list of open targets/tabs from Chrome's CDP HTTP endpoint. */
async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

/**
 * A thin CDP session over one page target's WebSocket. `.send(method, params)`
 * resolves the matching response; `.on(method, handler)` subscribes to events.
 */
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map();
    ws.on('message', (data) => this._onMessage(data));
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const handlers = this._listeners.get(msg.method);
      if (handlers) for (const h of handlers) h(msg.params);
    }
  }

  send(method, params = {}) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP timeout waiting for ${method}`));
        }
      }, 20000);
    });
  }

  on(method, handler) {
    if (!this._listeners.has(method)) this._listeners.set(method, []);
    this._listeners.get(method).push(handler);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Connect a CdpSession to the first real page target Chrome opened. */
async function connectToFirstPage(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let target;
  while (Date.now() < deadline) {
    const targets = await listTargets(port);
    target = targets.find((t) => t.type === 'page');
    if (target) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!target) throw new Error('No page target found in Chrome');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return new CdpSession(ws);
}

/* --------------------------------------------------------- page-level helpers */

async function evaluate(session, expression, { awaitPromise = false } = {}) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result.exceptionDetails) {
    throw new Error(`Runtime.evaluate threw: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result?.value;
}

async function navigate(session, url) {
  await session.send('Page.navigate', { url });
  // wait for the SPA root to actually render something.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = await evaluate(session, `(() => { const r = document.getElementById('root'); return !!(r && r.childElementCount > 0); })()`).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 250));
}

async function getRect(session, selector) {
  return evaluate(
    session,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      return { x: r.x, y: r.y, width: r.width, height: r.height, visible };
    })()`,
  );
}

async function clickXY(session, x, y) {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Click the CENTER of an element found by CSS selector, via real CDP mouse events. */
async function clickSelector(session, selector) {
  const rect = await getRect(session, selector);
  if (!rect || !rect.visible) return { ok: false, reason: 'not-visible-or-missing' };
  const x = rect.x + rect.width / 2;
  const y = rect.y + Math.min(rect.height / 2, rect.height - 2);
  await clickXY(session, x, y);
  return { ok: true, x, y };
}

const KEY_MAP = {
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
};

/** Dispatch a single named (non-printable) key via real CDP key events. */
async function pressKey(session, name, { shift = false } = {}) {
  const spec = KEY_MAP[name];
  if (!spec) throw new Error(`Unknown key ${name}`);
  const modifiers = shift ? 8 : 0;
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...spec });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...spec });
}

/**
 * Type printable text one character at a time via real CDP key events.
 *
 * FIX (WP fin-e2e-reality, clean re-click round): the previous version sent BOTH a
 * `keyDown` event carrying a `text` property AND a separate `char` event for the same
 * character — in real Chrome BOTH independently trigger text insertion, so every
 * character was inserted TWICE (verified empirically via a round-trip read of the
 * actual field value). Chrome's own documented pattern for synthesized printable-text
 * input is `rawKeyDown` (no `text` field, so it never inserts on its own) followed by
 * exactly one `char` event (which does the actual insertion) followed by `keyUp` — that
 * single-insertion-source pattern is what this now sends.
 */
async function typeText(session, text) {
  for (const ch of text) {
    await session.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      unmodifiedText: ch,
      key: ch,
    });
    await session.send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch, key: ch });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await new Promise((r) => setTimeout(r, 12));
  }
}

async function setViewport(session, { width, height, mobile = false }) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
}

async function clearViewportOverride(session) {
  await session.send('Emulation.clearDeviceMetricsOverride', {});
}

async function screenshot(session, filePath) {
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
  return filePath;
}

module.exports = {
  launchChrome,
  waitForCdp,
  listTargets,
  connectToFirstPage,
  evaluate,
  navigate,
  getRect,
  clickXY,
  clickSelector,
  pressKey,
  typeText,
  setViewport,
  clearViewportOverride,
  screenshot,
};
