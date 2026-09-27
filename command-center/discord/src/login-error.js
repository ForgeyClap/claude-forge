// WP-v290-B (beginner Discord onboarding) — turns a real discord.js login failure into a plain-
// language explanation a beginner can act on, instead of a bare stack trace only visible in a log
// file they do not know to look at. Pure string classification — no I/O, no discord.js — so it is
// trivially unit-testable against the REAL error messages discord.js/Discord's gateway are known
// to throw (see each branch's own comment for the real trigger).
//
// Codex finding K3-3: an UNRECOGNISED error used to be echoed back verbatim below, and this value
// flows into main.js's `loginError` state, then into health-server.js's `/api/health` response and
// BOT_STATUS.json, then into the gateway's `GET /api/discord/status` — a beginner-facing chain with
// no secret-shaped guard anywhere on it. If discord.js (or a library it depends on) ever throws with
// the token embedded in its message, that token would have ridden this exact path onto a beginner's
// screen and into a state file on disk. redactSecrets() (this package's own audit.js pattern set,
// already applied to every OTHER diagnostic surface here) now runs on the raw message before it is
// ever embedded — recognised branches above never needed this (they emit fixed copy, never the raw
// message), so only this fallback needed it.
import { redactSecrets } from './audit.js';

/**
 * @param {unknown} err
 * @returns {string}
 */
export function classifyLoginError(err) {
  const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
  // discord.js's real error when a privileged intent (here: Message Content) was requested in
  // code but the matching switch under the Bot page's "Privileged Gateway Intents" is still off
  // in the Developer Portal: the gateway rejects the identify payload with this exact reason.
  if (/disallowed intents/i.test(message)) {
    return (
      'Discord rejected the login: the "Message Content Intent" switch is not turned on yet for ' +
      'this bot. In the Developer Portal, open your application -> Bot -> Privileged Gateway ' +
      'Intents, and turn on "Message Content Intent", then try connecting again.'
    );
  }
  // discord.js's real error for a token that is malformed or has been reset/revoked.
  if (/an invalid token was provided/i.test(message) || /^401\b/.test(message) || /unauthorized/i.test(message)) {
    return (
      'Discord rejected the login: this does not look like a valid, currently-active bot token. ' +
      'Go back to the Bot page in the Developer Portal, click "Reset Token", copy the new value in ' +
      'full, and paste that.'
    );
  }
  return 'Discord login failed: ' + redactSecrets(message);
}
