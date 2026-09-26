// Security primitives for the Forge Compatibility Gateway.
// Zero-dependency (node:* only). Mirrors the proven pattern already reviewed and running in
// .claude/forge-dashboard/server.cjs (DNS-rebinding guard + path containment) — reused here
// rather than re-invented, per this project's "follow existing conventions" rule.
import path from 'node:path';
import crypto from 'node:crypto';

// A malicious web page whose domain re-resolves to 127.0.0.1 (DNS-rebinding) could still fetch
// this gateway's /api/* routes if only the bind address were checked. Two independent checks:
// (1) Host header must name a localhost host; (2) cross-site browser fetches are rejected via
// Sec-Fetch-Site / Origin. Same two-check shape as the existing Control Center server.
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Origins allowed to call the gateway's API: the gateway's own served origin (4100) and the
// Vite dev server origin (5173) used during `npm run dev`, per the work package's explicit
// "Host/Origin allowlist (localhost:4100/5173 dev)" instruction.
export const ALLOWED_ORIGINS = new Set([
  'http://localhost:4100', 'http://127.0.0.1:4100',
  'http://localhost:5173', 'http://127.0.0.1:5173',
]);

export function hostName(req) {
  const h = String((req.headers && req.headers.host) || '');
  if (!h) return '';
  try { return new URL('http://' + h).hostname.toLowerCase(); } catch { return h.toLowerCase(); }
}

export function hostOk(req) {
  const h = hostName(req);
  return h === '' || LOCAL_HOSTS.has(h);
}

export function crossSiteOk(req) {
  const sfs = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
  if (sfs && sfs !== 'same-origin' && sfs !== 'same-site' && sfs !== 'none') return false;
  const origin = req.headers && req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  return true;
}

// Belt-and-suspenders path containment: resolved must be exactly baseDir, or a real descendant
// of it (string-prefix check on the OS-native separator, not a naive substring check — this is
// the same shape as server.cjs's own containment guard).
export function containmentOk(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(targetPath);
  return resolved === base || resolved.startsWith(base + path.sep);
}

// C1 fix (WP-C1): project discovery now scans several well-known roots at once (paths.mjs's
// SYNC_SCAN_ROOTS), not just one — this is the matching defense-in-depth containment check: true
// when targetPath is a real descendant of (or equal to) ANY of the given base directories, never
// a looser check than containmentOk() run once per candidate root.
export function anyContainmentOk(baseDirs, targetPath) {
  return baseDirs.some((baseDir) => containmentOk(baseDir, targetPath));
}

// Allowlist regex for anything that becomes part of a filesystem path derived from request
// input (run ids). No '.', no '/', no '\\' — traversal sequences cannot match this pattern.
export const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

export function safeIdOk(id) {
  return typeof id === 'string' && id.length > 0 && SAFE_ID_RE.test(id);
}

// WP4: conversation id allowlist — the literal work-package spec is `^[A-Za-z0-9-]+$` (no
// underscore), distinct from SAFE_ID_RE above (run ids allow underscore). Bounded length so a
// pathological id can never build an absurdly long filesystem path.
export const SAFE_CONV_ID_RE = /^[A-Za-z0-9-]+$/;

export function safeConvIdOk(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_CONV_ID_RE.test(id);
}

// fix-sec-round #1 (HIGH, owner-requested 2026-07-29): a per-boot random execution token.
//
// THE GAP: crossSiteOk() above legitimately allows a request with NO Origin/Sec-Fetch-Site
// headers at all — a real, same-origin browser navigation sends exactly that shape (or
// `Sec-Fetch-Site: none`), so the check cannot reject it without also breaking real browsing.
// But a non-browser HTTP client (curl, a background script, a second unrelated local process on
// this machine) sends that SAME headerless shape and was, before this fix, indistinguishable from
// the real dashboard — reaching a real write route (POST /messages) with no auth layer at all.
//
// THE FIX: one random token, generated ONCE when this module is first loaded — in production that
// is once per real gateway process boot; this project's own test convention already runs each
// test FILE in its own child process (`node --test` isolates by file), so "per boot" and "per test
// file" coincide here with no extra reset hook needed. The token is injected into the SPA's own
// served HTML (see static.mjs's `injectExecToken`) as a `<meta name="cc-exec-token">` tag, read by
// the dashboard at load time and sent back as the `x-cc-exec-token` header on every real write
// (gateway-client.ts/gateway-chat.ts).
//
// A1 CORRECTION (WP-C2, 2026-09-26 laptop re-audit): an earlier version of this comment claimed a
// "genuinely different local process never had that page load, so it never has the token" — that
// is FALSE and is corrected here. static.mjs's injectExecToken() puts the token into `index.html`
// for ANY plain GET request that passes the Host/Origin checks above, and a real, same-origin
// browser navigation is not the only shape that passes them: crossSiteOk() explicitly allows a
// request with no Origin/Sec-Fetch-Site header at all (see its own comment), which is exactly what
// a same-user local script (`curl http://127.0.0.1:4100/`, a scheduled task, another CLI tool the
// owner runs) sends too — that other program can read the token straight out of the served HTML
// and then pass execTokenOk(), same as the real dashboard. This is NOT, and was never meant to be,
// a boundary between two different local programs run by the SAME user on the SAME machine — on a
// single-user machine any other program already running as that user can reach equivalent
// capabilities directly (the filesystem, the `claude` CLI, this project's own files), so a token
// cannot meaningfully raise that bar. What the token DOES stop is the one shape a Host/Origin check
// alone cannot: a malicious WEB PAGE open in the owner's browser (a different tab, a compromised
// site) whose script tries a cross-site fetch/XHR against this loopback gateway — a real browser
// attaches Sec-Fetch-Site: cross-site (or a foreign Origin) to that request, which crossSiteOk()
// rejects, and even in the rare case that check is bypassed the page never had a same-origin load
// of this gateway's own HTML, so it never obtained the token either. In short: this is a CSRF-style
// gate against a hostile page in the browser, not a multi-user or multi-process auth system, and it
// assumes — exactly like exec-bridge.mjs's own SECURITY FRAME comment for 'bypass' mode — a
// single-user machine where every other LOCAL process already implicitly trusted.
export const EXEC_TOKEN_HEADER = 'x-cc-exec-token';
const EXEC_TOKEN = crypto.randomBytes(24).toString('hex');

/** The current boot's real token — also what static.mjs injects into the served SPA. */
export function getExecToken() {
  return EXEC_TOKEN;
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** True only when the request carries the exact current-boot token — constant-time compare so a
 *  wrong guess cannot be timed byte-by-byte. */
export function execTokenOk(req) {
  const header = req.headers && req.headers[EXEC_TOKEN_HEADER];
  return typeof header === 'string' && header.length > 0 && timingSafeEqualStr(header, EXEC_TOKEN);
}
