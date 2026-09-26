#!/usr/bin/env node
'use strict';
/**
 * forge-codexreview-config.cjs — the ONE effective-config reader for the independent Codex review
 * (WP-S10, 2026-09-26, fresh-laptop re-audit N4 / Part V-G, "the Codex pin").
 *
 * PROBLEM (measured): the shipped `config/orchestration/codex-review.json` hard-pinned the MAINTAINER's
 * own account-specific model (`gpt-6-astra`, `reasoning_effort: "xhigh"`) — chosen because a previous
 * model returned HTTP 400 on the maintainer's ChatGPT account. A fresh user's account may reject that
 * exact model too, and every account hiccup on the maintainer's side meant editing a file every user's
 * install ships with. codex-review.json's own `_doc` already named the intended fix and why it had not
 * been wired yet (WP-S6b handoff, 2026-09-26): the only real readers at the time
 * (`forge-codexreview.test.cjs`, and the prose in `agents/codex-reviewer.md` +
 * `skills/forge-code-review/SKILL.md`) all read the raw shipped file directly and were owned by other
 * work packages, so changing the default there without rewiring those readers would either break the
 * pinning test or silently stop matching the prose.
 *
 * FIX (this file): ONE merge + ONE command-builder, so every consumer describes/uses the EFFECTIVE
 * config instead of assuming a model:
 *   - `config/orchestration/codex-review.json` (SHIPPED, template-owned) now ships a PORTABLE default:
 *     `review.model: null`, `review.reasoning_effort: null` — no pin at all, so a fresh account uses
 *     whatever default model/effort the codex CLI itself carries.
 *   - `config/orchestration/codex-review.user.json` (NEVER shipped, gitignored, excluded from sync — same
 *     template/user split already used for FORGE_STANDING_RULES.user.json / FORGE_SCOUT_VETTING.json) is
 *     an OPTIONAL override, same shape, only the fields being overridden. One specific account (e.g. the
 *     maintainer's) can keep a real pin there without forcing it onto every other install.
 *   - `effectiveConfig(root)` merges shipped + user (user wins, field-by-field, per top-level section) and
 *     `buildCommand(effective, opts)` DERIVES the actual CLI invocation from the effective values — an
 *     unset model/effort is never accidentally baked into a hardcoded command string. When both are
 *     unset, the built command omits `-m` and `-c model_reasoning_effort=...` entirely: the review
 *     genuinely runs on the CLI's own default, and `modelLabel()`/`effortLabel()` report that honestly
 *     as "Codex default model" / "Codex default effort" rather than inventing a name.
 *
 * Every consumer (the codex-reviewer agent, the forge-code-review skill, this file's own test) reads
 * effectiveConfig()/buildCommand() — or, for a human/agent without Node in hand, reads BOTH json files
 * and applies the exact same "user wins per field" rule described here — instead of restating a model
 * name from memory.
 */
const fs = require('fs');
const path = require('path');

function configDirOf(root) { return path.join(root, '.claude', 'config', 'orchestration'); }
function shippedPathOf(root) { return path.join(configDirOf(root), 'codex-review.json'); }
function userPathOf(root) { return path.join(configDirOf(root), 'codex-review.user.json'); }

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Merge ONE top-level section: the user's section (if an object) overrides the shipped section
// field-by-field — a user file that only sets `{review:{model:"x"}}` must not wipe
// sandbox/min_cli_version/command docs etc. from the shipped defaults.
function mergeSection(shipped, user) {
  const base = (shipped && typeof shipped === 'object') ? shipped : {};
  if (!user || typeof user !== 'object') return Object.assign({}, base);
  return Object.assign({}, base, user);
}

/** effectiveConfig(root) -> the merged {review, naming, fallback, honesty, operational_notes} object, or
 *  null when the SHIPPED file itself is missing/unreadable (fail-closed — there is nothing to merge onto).
 *  A missing/unreadable user file is NOT an error: it simply means no override is active. */
function effectiveConfig(root) {
  const shipped = readJsonSafe(shippedPathOf(root));
  if (!shipped || typeof shipped !== 'object') return null;
  const user = readJsonSafe(userPathOf(root));
  return {
    review: mergeSection(shipped.review, user && user.review),
    naming: mergeSection(shipped.naming, user && user.naming),
    fallback: mergeSection(shipped.fallback, user && user.fallback),
    honesty: mergeSection(shipped.honesty, user && user.honesty),
    operational_notes: mergeSection(shipped.operational_notes, user && user.operational_notes),
    _source: { shipped: shippedPathOf(root), user: user ? userPathOf(root) : null, user_present: !!user },
  };
}

function nonEmptyString(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }

/** buildCommand(effective, opts) -> the real CLI invocation string, DERIVED from the effective model /
 *  reasoning_effort / sandbox. `opts.adversarial: true` swaps in the adversarial prompt prefix. Omits
 *  `-m` when model is unset, and `-c model_reasoning_effort=...` when reasoning_effort is unset — never
 *  fabricates a value for either flag. */
function buildCommand(effective, opts) {
  const o = opts || {};
  const r = (effective && effective.review) || {};
  const parts = ['codex', 'exec'];
  const model = nonEmptyString(r.model);
  const effort = nonEmptyString(r.reasoning_effort);
  if (model) parts.push('-m', model);
  if (effort) parts.push('-c', 'model_reasoning_effort=' + effort);
  parts.push('-s', nonEmptyString(r.sandbox) || 'read-only');
  const prompt = o.adversarial ? 'ADVERSARIAL CODE REVIEW. <focus>' : '<review prompt>';
  parts.push(JSON.stringify(prompt));
  return parts.join(' ');
}

/** modelLabel/effortLabel(effective) -> a human-honest label for reports/prose. Never a fabricated model
 *  name: an unset pin reports the literal, explicit "Codex default model"/"Codex default effort" string
 *  so a reader can never mistake "unpinned" for "pinned to something unnamed". */
function modelLabel(effective) { return nonEmptyString(effective && effective.review && effective.review.model) || 'Codex default model'; }
function effortLabel(effective) { return nonEmptyString(effective && effective.review && effective.review.reasoning_effort) || 'Codex default effort'; }

/** isPinned(effective) -> true only when a real, non-empty model is set (by shipped default or by the
 *  user override) — the single place "is there an active pin at all?" is decided. */
function isPinned(effective) { return !!nonEmptyString(effective && effective.review && effective.review.model); }

module.exports = {
  shippedPathOf, userPathOf, effectiveConfig, buildCommand, modelLabel, effortLabel, isPinned,
};

if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..');
  const eff = effectiveConfig(root);
  if (!eff) { console.error('no readable codex-review.json under ' + shippedPathOf(root)); process.exit(2); }
  console.log(JSON.stringify({
    effective: eff,
    model: modelLabel(eff), effort: effortLabel(eff), pinned: isPinned(eff),
    command: buildCommand(eff, { adversarial: false }),
    adversarial_command: buildCommand(eff, { adversarial: true }),
  }, null, 2));
}
