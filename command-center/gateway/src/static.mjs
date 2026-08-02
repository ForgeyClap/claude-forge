// Serves the built dashboard/dist bundle (WP7a: repointed from the retired app/dist to the
// imported owner dashboard's own build output — see paths.mjs). Read-only, containment-guarded —
// the same shape as every other file-serving route in this gateway. No secrets ever live in
// dashboard/dist (it is a public static bundle by construction), but containment is still
// enforced so a crafted URL can never walk outside dashboard/dist regardless.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk, getExecToken } from './security.mjs';
import { APP_DIST_DIR } from './paths.mjs';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// WP10 should-fix-now #10 (AP-13): every static response — including the 400 "bad path" replies —
// carries these so the served SPA can never be framed (clickjacking a tricked click onto a
// same-origin Send/Stop button, which crossSiteOk legitimately allows since it IS same-origin) and
// is never MIME-sniffed into something it isn't. `frame-ancestors 'none'` is the one CSP directive
// added here — a broader CSP is NOT shipped because the built SPA's own inline styles/scripts
// (Vite's default output) were not proven safe under a stricter policy in this round; see this
// WP's report for the honest "frame-ancestors + nosniff only" scope decision.
export const STATIC_SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};

// fix-sec-round #1: the minimal-invasive injection point for the per-boot exec token (see
// security.mjs's EXEC_TOKEN_HEADER/getExecToken) — a single `<meta>` tag spliced right after the
// real `<head>` opening tag of whatever HTML this route serves (the one built `index.html`, both
// for a direct hit and for the SPA-fallback case below). A shape this file does not recognize
// (no literal `<head>` found) is left completely untouched rather than guessed at or crashed on —
// this route already treats "not built yet"/"doesn't exist" as an honest null, and an unexpected
// HTML shape gets the same honest, non-invasive treatment.
function injectExecToken(html) {
  const marker = '<head>';
  const idx = html.indexOf(marker);
  if (idx === -1) return html;
  const metaTag = `<head>\n    <meta name="cc-exec-token" content="${getExecToken()}">`;
  return html.slice(0, idx) + metaTag + html.slice(idx + marker.length);
}

// Returns { status, headers, body } or null if the static bundle simply doesn't exist yet
// (honest "not built" case — the caller decides how to report that, this module never lies
// about a build that hasn't happened).
export function serveStatic(pathname) {
  if (!fs.existsSync(APP_DIST_DIR)) return null;

  const cleanPath = pathname === '/' ? '/index.html' : pathname;
  // WP10 should-fix-now #9 (AP-4, HIGH): decodeURIComponent throws a URIError on a malformed
  // escape (e.g. a bare "/%" — no uncaughtException handler existed for this before this fix, so
  // an unguarded throw here killed the whole gateway process). A request that cannot even be
  // decoded is simply a bad path, not a crash.
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(cleanPath);
  } catch {
    return { status: 400, headers: { 'Content-Type': 'text/plain', ...STATIC_SECURITY_HEADERS }, body: 'bad path' };
  }
  const candidate = path.join(APP_DIST_DIR, decodedPath);
  if (!containmentOk(APP_DIST_DIR, candidate)) {
    return { status: 400, headers: { 'Content-Type': 'text/plain', ...STATIC_SECURITY_HEADERS }, body: 'bad path' };
  }

  let target = candidate;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // Single-view slice (no router yet): any unmatched path falls back to index.html rather
    // than a hard 404, so a future client-side route still loads the shell.
    target = path.join(APP_DIST_DIR, 'index.html');
    if (!containmentOk(APP_DIST_DIR, target) || !fs.existsSync(target)) return null;
  }

  const ext = path.extname(target).toLowerCase();
  const rawBody = fs.readFileSync(target);
  // fix-sec-round #1: only the served HTML shell gets the token meta tag — every other asset
  // (JS/CSS/fonts/etc.) is served byte-identical to before, exactly as it was before this fix.
  const body = ext === '.html' ? injectExecToken(rawBody.toString('utf8')) : rawBody;
  return {
    status: 200,
    headers: { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', ...STATIC_SECURITY_HEADERS },
    body,
  };
}
