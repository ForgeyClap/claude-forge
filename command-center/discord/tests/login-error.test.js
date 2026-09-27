// WP-v290-B (beginner Discord onboarding) — login-error.js's plain-language classification,
// tested against the REAL discord.js/@discordjs/ws error text (verified against the installed
// package — see transport/discord.js's own UNRECOVERABLE_CLOSE_CODE_MESSAGES header comment).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoginError } from '../src/login-error.js';

test('classifyLoginError: "Used disallowed intents" -> explains the Message Content Intent switch', () => {
  const friendly = classifyLoginError(new Error('Used disallowed intents.'));
  assert.match(friendly, /Message Content Intent/);
  assert.match(friendly, /Privileged Gateway Intents/);
});

test('classifyLoginError: "An invalid token was provided." -> explains resetting the token', () => {
  const friendly = classifyLoginError(new Error('An invalid token was provided.'));
  assert.match(friendly, /Reset Token/);
  assert.match(friendly, /valid, currently-active bot token/);
});

test('classifyLoginError: a 401/unauthorized-shaped message is also treated as a bad token', () => {
  assert.match(classifyLoginError(new Error('401: Unauthorized')), /valid, currently-active bot token/);
});

test('classifyLoginError: an unrecognized error still returns a real, non-empty message, never throws', () => {
  const friendly = classifyLoginError(new Error('Invalid intent(s) were provided.'));
  assert.equal(typeof friendly, 'string');
  assert.ok(friendly.length > 0);
  assert.match(friendly, /Invalid intent\(s\) were provided\./);
});

test('classifyLoginError: a non-Error value (string, undefined) never throws', () => {
  assert.equal(typeof classifyLoginError('plain string failure'), 'string');
  assert.equal(typeof classifyLoginError(undefined), 'string');
});

test('classifyLoginError: Codex K3-3 — an unrecognized error never echoes back a token-shaped substring', () => {
  const fakeToken = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'a'.repeat(30)].join('.');
  const friendly = classifyLoginError(new Error('unexpected failure while using ' + fakeToken));
  assert.equal(friendly.includes(fakeToken), false, 'the raw token-shaped string must never reach the caller');
  assert.match(friendly, /\[REDACTED\]/);
  // Non-secret detail is still preserved — this is a targeted redaction, not a fully generic message.
  assert.match(friendly, /unexpected failure while using/);
});
