#!/usr/bin/env node
'use strict';
/**
 * forge-settings-merge.cjs — v2.7.0 WP22 (owner directive 2026-09-24, "alles standaard aan" / "Forge does it
 * for you — never tell the user to run or merge something by hand"). Merges Forge's `.claude/settings.json`
 * (hooks + permissions.deny rules — see HOOKS_OPT_IN.md) into an EXISTING project's own settings.json instead
 * of leaving the user to "merge what you want by hand" (the old install.sh forge_copy_settings_file /
 * install.ps1 Copy-ForgeSettingsFile behaviour, and forge-sync.cjs's prior "does not itself write
 * settings.json for a synced project" gap). Generalises forge-snapshot-settings.cjs's proven merge-safety
 * model (pure function, deep-clone, append-only, exact matcher+command match, idempotent) from the snapshot
 * hooks to EVERY hooks.<event>[] entry plus permissions.deny.
 *
 * HARDENED wp-f2 (2026-09-24 Codex re-check, out-p2.md/out-p6.md) on top of the original WP22 design. Shape
 * validation, containment guards, the JSON round-trip safety scanner and the exclusive-create recovery-file
 * writer live in the sibling helper `forge-settings-merge-guards.cjs` so this file stays under the project's
 * file-size guidance.
 *
 * SAFETY MODEL (load-bearing, proven by forge-settings-merge.test.cjs):
 *   - mergeForgeSettings(existing, source) is PURE: deep-clones `existing`, never mutates it or `source`.
 *   - Every foreign (non-Forge) hook entry, every foreign permissions.allow/ask rule, and every unknown
 *     top-level key survive byte-for-byte, at their original array position.
 *   - A source hooks.<event>[] entry with a matcher NOT already present is APPENDED as a whole new entry. A
 *     source entry whose matcher DOES already exist tops up that SAME existing entry with only the missing
 *     hook (command+type) objects — it never appends a second, duplicate entry for a matcher that already
 *     exists (DUPLICATE-HOOKS). "Present" requires an existing hook with the SAME command AND the SAME
 *     `type` (SCHEMA-ACCEPTANCE) — a hook whose command matches but whose type was changed away from
 *     'command' is not considered installed.
 *   - The ONE OTHER mutation of an existing hook: a `type:'command'` hook already present whose `command`
 *     references a `forge-bin/forge-*.cjs` script AND whose `timeout` is > 60 gets that timeout replaced
 *     with the source's value — every other existing hook field (and every non-Forge hook regardless of
 *     timeout) is left alone.
 *   - Pre-existing duplicate matcher entries for the same event (however they got there) are DETECTED and
 *     reported via `duplicate_matchers` — never silently auto-repaired (a second run "repairs nothing
 *     silently — it says what it found").
 *   - HOOK-COMMAND-UPGRADE (v2.8.0, fresh-laptop re-audit): when a source hook for a matcher that ALREADY
 *     exists in the target names the SAME `forge-bin/forge-<name>.cjs` script as an existing hook under that
 *     same matcher, but with a DIFFERENT command string (e.g. an install upgrading a cwd-relative
 *     `node .claude/forge-bin/forge-x.cjs` to `node "$CLAUDE_PROJECT_DIR/.claude/forge-bin/forge-x.cjs"`),
 *     that existing hook's `command` is REPLACED with the source's value IN PLACE — every other field (type,
 *     timeout, subject to the ms-as-seconds fix above) is left alone — instead of being appended as a second,
 *     duplicate hook that would fire twice. Never touches a non-Forge hook. A hook whose command already
 *     equals the source's exactly is "already present" (see `hasHook` above), not reported as an upgrade.
 *     Reported via the returned `upgraded` array; `checkSettingsMerge` surfaces the same array so a pending
 *     upgrade is reported honestly instead of only ever "missing" or "up to date".
 *   - permissions.deny is a UNION: every source rule not already present is appended, in source order,
 *     after the user's own rules. permissions.allow/ask and every other key are untouched.
 *   - IDEMPOTENT: re-running against an already-merged/-upgraded file adds/adjusts/upgrades nothing.
 *   - Source AND existing target are both schema-validated (root shape + every hook entry's inner shape)
 *     before anything is written; an invalid source is a usage error, an invalid target is a safe refusal.
 *   - Only a VERIFIED MISSING regular file enters the create path (UNREADABLE-MEANS-ABSENT): a directory, a
 *     symlink, or any other read error (EACCES/EIO/…) refuses instead — nothing is written, no backup is
 *     taken/overwritten.
 *   - The existing target is re-read and compared (mtime + size + exact bytes) immediately before the final
 *     rename; any drift since the initial read refuses the write rather than silently discarding a
 *     concurrent edit (CONCURRENT-EDIT-LOSS).
 *   - Backup and `settings.forge-recommended.json` files are created EXCLUSIVELY (`wx`) with a unique
 *     timestamp+random name in a directory that is itself verified not to be a symlink/junction — an
 *     existing recovery artifact is never overwritten (AUXILIARY-FILE-CLOBBER).
 *   - When called with `projectRoot` (forge-sync.cjs passes the project's own `.claude` dir), every write
 *     destination (settings target, backup, recommended) must resolve inside that root, and the root itself
 *     must not be a symlink/junction (PROJECT-DIRECTORY-ESCAPE).
 *   - A target containing a duplicate JSON object key (compared on its DECODED value, so an escaped duplicate
 *     like owner vs owner is caught too), or a number literal whose SOURCE TEXT would not come back
 *     unchanged from JSON.stringify(Number(literal)) — overflow to Infinity, underflow to zero, a pure or
 *     decimal integer beyond Number.MAX_SAFE_INTEGER, -0 losing its sign, or redundant exponent notation like
 *     1E2 — is refused rather than silently corrupted/reformatted (LOSSY-ROUNDTRIP, hardened wp-g2 2026-09-24
 *     Codex re-check out-p7.md V08). A successful merge preserves the target's own BOM, line-ending,
 *     indentation and trailing-newline style instead of always re-emitting 2-space/LF — this does NOT
 *     preserve comments or exact per-node spacing beyond that (no full lossless syntax tree), a documented,
 *     narrower scope than "byte-for-byte for every untouched byte".
 *   - On POSIX, the original file's permission mode is preserved on the replacement and on its backup
 *     (SETTINGS-PERMISSION-WIDENING); on Windows this only toggles the read-only attribute — real ACL
 *     preservation is NOT implemented, a documented limit, not a silent gap.
 *
 * CLI:
 *   node forge-settings-merge.cjs apply --target <settings.json> --source <settings.json>
 *     [--dry-run] [--json] [--backup-dir <dir>] [--project-root <dir>]
 *   node forge-settings-merge.cjs check --target <settings.json> --source <settings.json> [--json]
 *   node forge-settings-merge.cjs unmerge --target <settings.json> --source <settings.json>
 *     [--dry-run] [--json] [--backup-dir <dir>] [--project-root <dir>]
 *
 * apply exit codes: 0 = created / merged / already up to date (no-op). 1 = refused-safe (target exists but
 *   is not valid JSON/shape/content-safe, is not a plain regular file, changed concurrently, or a write
 *   destination fails containment — the target is left byte-for-byte untouched and, where possible, a
 *   `settings.forge-recommended-<stamp>-<rand>.json` copy of the source is written next to it instead).
 *   2 = usage error (bad arguments, or the SOURCE itself is unreadable/invalid/malformed).
 * check exit codes: 0 = nothing to merge (already up to date). 1 = the source has entries/rules the target
 *   is missing (including a pending hook-command upgrade), the target does not exist yet, or the target has
 *   unsafe content. 2 = usage error (source unreadable/invalid, or the target is unreadable for a reason
 *   other than "missing" — check never writes anything, in any case).
 * unmerge (the uninstaller's counterpart to apply): removes every Forge hook (`isForgeHookCommand`) from the
 *   target, drops any hooks.<event>[] entry/event left empty by that, and removes exactly the
 *   permissions.deny rules that also appear in the SOURCE template — a user's own hooks/rules are never
 *   touched. Exit codes mirror apply exactly: 0 = removed / nothing to do (no-op). 1 = refused-safe (same
 *   conditions as apply: not a plain regular file, unreadable, unparsable/unsafe JSON, changed concurrently,
 *   or a write destination fails containment). 2 = usage error (bad arguments, or the SOURCE template is
 *   unreadable/invalid/malformed). unmerge keeps every apply safety guarantee (backup before writing,
 *   BOM/line-ending/indent/trailing-newline and file-mode preservation, PROJECT-DIRECTORY-ESCAPE containment)
 *   except the `settings.forge-recommended-*.json` recovery copy, which does not apply to an uninstall.
 */
const fs = require('fs');
const path = require('path');
const guards = require('./forge-settings-merge-guards.cjs');

function isForgeHookCommand(command) {
  return typeof command === 'string' && /forge-bin[\\/]forge-[\w.-]+\.cjs/.test(command);
}

/** entryPresent — true when `list` (a hooks.<event>[] array) already has an entry with the SAME matcher
 *  (undefined === undefined) whose hooks[] contains, for EVERY hook in `hooks`, a hook with the exact same
 *  command AND the exact same type (SCHEMA-ACCEPTANCE: a right-command-wrong-type hook is not "present"). */
function entryPresent(list, matcher, hooks) {
  if (!Array.isArray(list)) return false;
  return list.some((e) => hasAllHooks(e, matcher, hooks));
}
function hasAllHooks(e, matcher, hooks) {
  if (!e || typeof e !== 'object') return false;
  if (e.matcher !== matcher) return false;
  const eHooks = Array.isArray(e.hooks) ? e.hooks : [];
  return hooks.every((h) => h && eHooks.some((eh) => eh && eh.command === h.command && eh.type === h.type));
}
function hasHook(eHooks, h) {
  return eHooks.some((eh) => eh && eh.command === h.command && eh.type === h.type);
}

/** forgeScriptName(command) — the exact `forge-<name>.cjs` leaf a Forge hook command invokes (via
 *  forge-bin/), or null when `command` is not a recognizable Forge hook command at all. Used ONLY to decide
 *  whether two DIFFERENT command strings still refer to the same underlying script (HOOK-COMMAND-UPGRADE) —
 *  it never changes what `isForgeHookCommand` itself accepts. */
function forgeScriptName(command) {
  const m = typeof command === 'string' && command.match(/forge-bin[\\/](forge-[\w.-]+\.cjs)/);
  return m ? m[1] : null;
}

/** findUpgradeCandidate(hooksArray, srcHook) — HOOK-COMMAND-UPGRADE: an existing hook in `hooksArray` that
 *  invokes the SAME forge-bin script as `srcHook` (same `forgeScriptName`), has the SAME `type`, but a
 *  DIFFERENT `command` string — i.e. a stale command form of the very hook `srcHook` represents, not a
 *  brand-new hook. Returns null (never an upgrade) when `srcHook` itself is not a recognizable Forge hook
 *  command, when no such existing hook is found, or when an existing hook's command is byte-identical to
 *  `srcHook`'s (that case is "already present" per `hasHook`, not an upgrade). */
function findUpgradeCandidate(hooksArray, srcHook) {
  if (!Array.isArray(hooksArray) || !srcHook || !isForgeHookCommand(srcHook.command)) return null;
  const srcScript = forgeScriptName(srcHook.command);
  if (!srcScript) return null;
  return hooksArray.find((h) => h && typeof h === 'object' && h.type === srcHook.type
    && isForgeHookCommand(h.command) && forgeScriptName(h.command) === srcScript && h.command !== srcHook.command) || null;
}

/** computeDuplicateMatchers — DUPLICATE-HOOKS: report (never repair) any event whose FINAL array has 2+
 *  entries sharing the same matcher value — a condition this tool's own merge logic no longer creates, but
 *  one an already-affected project (or a hand-edit) may already carry. "say what it found", nothing more. */
function computeDuplicateMatchers(hooksObj) {
  const out = [];
  for (const event of Object.keys(hooksObj || {})) {
    const list = hooksObj[event];
    if (!Array.isArray(list)) continue;
    const counts = new Map();
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      const key = JSON.stringify(e.matcher === undefined ? null : e.matcher);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, count] of counts) if (count > 1) out.push({ event, matcher: JSON.parse(key), count });
  }
  return out;
}

/** mergeForgeSettings(existing, source) -> { settings, added, adjusted, upgraded, deny_added,
 *  duplicate_matchers }. See file header SAFETY MODEL. Never mutates `existing` or `source`. `existing` may
 *  be null/undefined (treated as `{}`). Assumes both have already passed
 *  validShape()+deepValidateHooksShape() — this function itself does not re-validate. */
function mergeForgeSettings(existing, source) {
  const out = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? JSON.parse(JSON.stringify(existing))
    : {};
  const src = source && typeof source === 'object' && !Array.isArray(source) ? source : {};

  const added = [];
  const adjusted = [];
  const upgraded = [];
  const deny_added = [];

  out.hooks = out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks) ? out.hooks : {};
  const srcHooks = src.hooks && typeof src.hooks === 'object' && !Array.isArray(src.hooks) ? src.hooks : {};

  for (const event of Object.keys(srcHooks)) {
    const srcList = Array.isArray(srcHooks[event]) ? srcHooks[event] : [];
    out.hooks[event] = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    for (const srcEntry of srcList) {
      if (!srcEntry || typeof srcEntry !== 'object') continue;
      const matcher = srcEntry.matcher;
      const srcHookList = Array.isArray(srcEntry.hooks) ? srcEntry.hooks : [];
      const sameMatcherEntries = out.hooks[event].filter((e) => e && typeof e === 'object' && e.matcher === matcher);

      if (sameMatcherEntries.length === 0) {
        // MISSING matcher entirely -> append a NEW entry (deep-cloned so the source object is never
        // shared/mutated). Never inserted into or reordered against the user's existing entries.
        out.hooks[event] = out.hooks[event].concat([JSON.parse(JSON.stringify(srcEntry))]);
        added.push(event + (matcher !== undefined ? '[' + matcher + ']' : '') + ': new entry');
        continue;
      }

      // matcher already exists -> DUPLICATE-HOOKS fix: top up the FIRST such entry with only the missing
      // hook (command+type) objects, never append a second entry for the same matcher.
      const targetEntry = sameMatcherEntries[0];
      targetEntry.hooks = Array.isArray(targetEntry.hooks) ? targetEntry.hooks : [];
      for (const srcHook of srcHookList) {
        if (!srcHook || typeof srcHook !== 'object') continue;
        if (hasHook(targetEntry.hooks, srcHook)) continue;
        // HOOK-COMMAND-UPGRADE: a stale command form of this SAME script (see file header) is replaced in
        // place instead of appended as a second, duplicate-firing hook.
        const upgradeCandidate = findUpgradeCandidate(targetEntry.hooks, srcHook);
        if (upgradeCandidate) {
          const from = upgradeCandidate.command;
          upgradeCandidate.command = srcHook.command;
          upgraded.push({ event, matcher: matcher === undefined ? null : matcher, from, to: srcHook.command });
        } else {
          targetEntry.hooks = targetEntry.hooks.concat([JSON.parse(JSON.stringify(srcHook))]);
          added.push(event + '[' + (matcher === undefined ? '' : matcher) + ']: +' + srcHook.command);
        }
      }

      // ms-as-seconds timeout fix — applied across EVERY entry sharing this matcher (harmless repair even
      // on a pre-existing duplicate; only ever touches an existing type:'command' Forge hook's `timeout`).
      for (const te of sameMatcherEntries) {
        const teHooks = Array.isArray(te.hooks) ? te.hooks : [];
        for (const srcHook of srcHookList) {
          if (!srcHook || typeof srcHook !== 'object') continue;
          const match = teHooks.find((h) => h && h.command === srcHook.command && h.type === 'command');
          if (!match) continue;
          if (isForgeHookCommand(match.command) && typeof match.timeout === 'number' && match.timeout > 60
            && typeof srcHook.timeout === 'number' && match.timeout !== srcHook.timeout) {
            adjusted.push({ event, matcher: matcher === undefined ? null : matcher, command: match.command, from: match.timeout, to: srcHook.timeout });
            match.timeout = srcHook.timeout;
          }
        }
      }
    }
  }

  out.permissions = out.permissions && typeof out.permissions === 'object' && !Array.isArray(out.permissions) ? out.permissions : {};
  const srcPerms = src.permissions && typeof src.permissions === 'object' && !Array.isArray(src.permissions) ? src.permissions : {};
  const srcDeny = Array.isArray(srcPerms.deny) ? srcPerms.deny : [];
  out.permissions.deny = Array.isArray(out.permissions.deny) ? out.permissions.deny.slice() : [];
  for (const rule of srcDeny) {
    if (!out.permissions.deny.includes(rule)) {
      out.permissions.deny.push(rule);
      deny_added.push(rule);
    }
  }

  const duplicate_matchers = computeDuplicateMatchers(out.hooks);
  return { settings: out, added, adjusted, upgraded, deny_added, duplicate_matchers };
}

/** unmergeForgeSettings(existing, source) -> { settings, removed_hooks, removed_events, deny_removed } — the
 *  uninstaller's counterpart to mergeForgeSettings. Never mutates `existing` or `source`; never introduces a
 *  `hooks`/`permissions` key that was not already present in `existing` (there is nothing to unmerge from a
 *  target that never had one). For every hooks.<event>[] entry, every hook whose command is a recognized
 *  Forge hook command (`isForgeHookCommand`) is removed; an entry left with zero hooks is dropped entirely,
 *  and an event left with zero entries is dropped from `hooks`. permissions.deny loses exactly the rules that
 *  also appear in `source`'s own permissions.deny — a rule the user added themselves (not present in
 *  `source`) is never removed, even if its text happens to look similar. */
function unmergeForgeSettings(existing, source) {
  const out = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? JSON.parse(JSON.stringify(existing))
    : {};
  const src = source && typeof source === 'object' && !Array.isArray(source) ? source : {};

  const removed_hooks = [];
  const removed_events = [];

  if (out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks)) {
    for (const event of Object.keys(out.hooks)) {
      const list = Array.isArray(out.hooks[event]) ? out.hooks[event] : null;
      if (!list) continue; // not our shape — leave completely untouched (should not occur past validation)
      const nextList = [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { nextList.push(entry); continue; }
        const hooksArr = Array.isArray(entry.hooks) ? entry.hooks : null;
        if (!hooksArr) { nextList.push(entry); continue; }
        const kept = [];
        for (const h of hooksArr) {
          if (h && typeof h === 'object' && h.type === 'command' && isForgeHookCommand(h.command)) {
            removed_hooks.push({ event, matcher: entry.matcher === undefined ? null : entry.matcher, command: h.command });
          } else {
            kept.push(h);
          }
        }
        entry.hooks = kept;
        if (kept.length > 0) nextList.push(entry);
      }
      if (nextList.length > 0) out.hooks[event] = nextList;
      else { delete out.hooks[event]; removed_events.push(event); }
    }
  }

  const deny_removed = [];
  if (out.permissions && typeof out.permissions === 'object' && !Array.isArray(out.permissions) && Array.isArray(out.permissions.deny)) {
    const srcPerms = src.permissions && typeof src.permissions === 'object' && !Array.isArray(src.permissions) ? src.permissions : {};
    const srcDenySet = new Set(Array.isArray(srcPerms.deny) ? srcPerms.deny : []);
    const kept = [];
    for (const rule of out.permissions.deny) {
      if (srcDenySet.has(rule)) deny_removed.push(rule);
      else kept.push(rule);
    }
    out.permissions.deny = kept;
  }

  return { settings: out, removed_hooks, removed_events, deny_removed };
}

/** validShape — refuses (never silently "repairs") a root whose hooks/permissions are not the expected
 *  container types, even though it parsed as JSON (e.g. `{"hooks":"nope"}` or `{"hooks":{"PreToolUse":{}}}`).
 *  Root-level only — see guards.deepValidateHooksShape for per-entry validation (SCHEMA-ACCEPTANCE). */
function validShape(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return false;
  if ('hooks' in json) {
    if (typeof json.hooks !== 'object' || json.hooks === null || Array.isArray(json.hooks)) return false;
    for (const k of Object.keys(json.hooks)) if (!Array.isArray(json.hooks[k])) return false;
  }
  if ('permissions' in json) {
    if (typeof json.permissions !== 'object' || json.permissions === null || Array.isArray(json.permissions)) return false;
    if ('deny' in json.permissions && !Array.isArray(json.permissions.deny)) return false;
  }
  return true;
}
function fullyValidShape(json) { return validShape(json) && guards.deepValidateHooksShape(json); }

/** writeAtomicChecked — temp file + rename, optionally chmod'd to `mode` before the rename (POSIX; a
 *  best-effort no-op-ish attribute toggle on Windows). Runs `verify()` right before the rename and aborts
 *  (leaving `file` completely untouched, cleaning up the temp file) when it returns `{ ok:false }`. Used for
 *  CONCURRENT-EDIT-LOSS: the caller's `verify` re-reads `file` and compares it to what was read at the start
 *  `file` completely untouched, cleaning up the temp file) when it returns `{ ok:false }`. Used for
 *  CONCURRENT-EDIT-LOSS: the caller's `verify` re-reads `file` and compares it to what was read at the start
 *  of the operation. */
function writeAtomicChecked(file, contents, verify, mode) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    fs.writeFileSync(tmp, contents, 'utf8');
    if (typeof mode === 'number') { try { fs.chmodSync(tmp, mode); } catch { /* best-effort, esp. on Windows */ } }
    if (verify) {
      const v = verify();
      if (!v.ok) { try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ } return v; }
    }
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

/** stripBom — a UTF-8 BOM before `{` is a REAL, common shape on Windows (PowerShell's `Set-Content
 *  -Encoding utf8` and several editors always emit one), and `JSON.parse` does not skip it, which would
 *  otherwise make a byte-for-byte-valid settings.json read as "not valid JSON" and refuse-safe unnecessarily
 *  (caught by a real end-to-end `install.ps1` run during wp22, not by inspection alone). */
function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** readTargetKind(target) — UNREADABLE-MEANS-ABSENT: the ONLY way to reach the create path is a verified
 *  ENOENT on the target's own lstat. A symlink (never read/written through), a directory, or any other read
 *  error (EACCES/EIO/…) is classified 'unreadable' and refuses — it is NEVER treated as "absent". Returns the
 *  raw bytes plus the mode/mtime/size captured at read time for a regular, readable file. */
function readTargetKind(target) {
  let st;
  try { st = fs.lstatSync(target); }
  catch (e) { return e && e.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error: e.message }; }
  if (st.isSymbolicLink()) return { kind: 'unreadable', error: 'settings.json path is a symlink — refusing to read/write through it' };
  if (st.isDirectory()) return { kind: 'unreadable', error: 'is a directory, not a file' };
  if (!st.isFile()) return { kind: 'unreadable', error: 'not a regular file' };
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); }
  catch (e) { return { kind: 'unreadable', error: e.message }; }
  return { kind: 'ok', raw, mode: st.mode & 0o777, mtimeMs: st.mtimeMs, size: st.size };
}

/** writeRecommended — AUXILIARY-FILE-CLOBBER: an exclusively-created, uniquely-named
 *  `settings.forge-recommended-<stamp>-<rand>.json` next to `target`, documenting a refusal. Never overwrites
 *  a prior recovery file; refuses outright (no write attempted) if that directory is itself a symlink/
 *  junction. Returns `{ ok:false, reason }` on failure — callers fold that into their own refusal message
 *  rather than throwing, since a refusal must still be reported even when the recommended-file write itself
 *  cannot happen (e.g. the whole directory is unreadable). */
function writeRecommended(target, sourceRaw, opts) {
  const dir = path.dirname(target);
  const contents = sourceRaw.endsWith('\n') ? sourceRaw : sourceRaw + '\n';
  return guards.writeExclusiveUnique(dir, 'settings.forge-recommended', '.json', contents, { now: opts.now });
}

/** applySettingsMerge({target, source, dryRun, backupDir, projectRoot, now}) — the file-level orchestration
 *  shared by the CLI `apply` command AND forge-sync.cjs's own post-sync settings step. Never throws on a
 *  refusable condition — returns `{ ok:false, status:'refused'|'usage-error', ... }` instead, so a caller
 *  like forge-sync can report it without failing the whole file sync. `projectRoot`, when given (forge-sync
 *  passes the project's own `.claude` dir), must contain every write destination and must not itself be a
 *  symlink/junction (PROJECT-DIRECTORY-ESCAPE). */
function applySettingsMerge(opts) {
  opts = opts || {};
  const target = opts.target;
  const source = opts.source;
  if (!target || !source) return { ok: false, status: 'usage-error', message: 'target and source are required' };

  const backupDir = opts.backupDir || path.dirname(target);
  if (opts.projectRoot) {
    if (guards.isSymlinkPath(opts.projectRoot)) {
      return { ok: false, status: 'refused', target, message: 'refusing: the project root (' + opts.projectRoot + ') is a symlink/junction, not a real directory — never merging settings.json across that boundary' };
    }
    for (const p of [target, backupDir]) {
      if (!guards.containedWithin(opts.projectRoot, p)) {
        return { ok: false, status: 'refused', target, message: 'refusing: ' + p + ' resolves outside the project root (' + opts.projectRoot + ')' };
      }
    }
  }

  let sourceRaw;
  try { sourceRaw = fs.readFileSync(source, 'utf8'); }
  catch (e) { return { ok: false, status: 'usage-error', message: 'cannot read source ' + source + ': ' + e.message }; }
  let sourceJson;
  try { sourceJson = JSON.parse(stripBom(sourceRaw)); }
  catch (e) { return { ok: false, status: 'usage-error', message: 'source ' + source + ' is not valid JSON: ' + e.message }; }
  if (!fullyValidShape(sourceJson)) {
    return { ok: false, status: 'usage-error', message: 'source ' + source + ' has an unexpected hooks/permissions shape (SCHEMA-ACCEPTANCE)' };
  }

  const t = readTargetKind(target);

  if (t.kind === 'missing') {
    if (opts.dryRun) return { ok: true, dryRun: true, status: 'would-create', target, source };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const contents = sourceRaw.endsWith('\n') ? sourceRaw : sourceRaw + '\n';
    const verify = () => (fs.existsSync(target) ? { ok: false, reason: 'target was created concurrently since it was last checked' } : { ok: true });
    const w = writeAtomicChecked(target, contents, verify);
    if (!w.ok) return { ok: false, status: 'refused', target, message: 'refusing: ' + w.reason };
    return { ok: true, status: 'created', target, source };
  }

  if (t.kind === 'unreadable') {
    if (opts.dryRun) return { ok: false, dryRun: true, status: 'would-refuse', target, message: 'existing ' + target + ' cannot be safely read (' + t.error + ') — would leave untouched' };
    const rec = writeRecommended(target, sourceRaw, opts);
    return {
      ok: false, status: 'refused', target, recommended: rec.ok ? rec.path : null,
      message: 'settings.json exists but cannot be safely read (' + t.error + ') — left untouched (UNREADABLE-MEANS-ABSENT: never treated as missing).'
        + (rec.ok ? (' Forge\'s recommended hooks are in ' + rec.path + '.') : (' A recommended-hooks copy could not be written either (' + rec.reason + ').')),
    };
  }

  // t.kind === 'ok'
  const targetRaw = t.raw;
  let targetJson;
  try { targetJson = JSON.parse(stripBom(targetRaw)); }
  catch (e) {
    if (opts.dryRun) return { ok: false, dryRun: true, status: 'would-refuse', target, message: 'existing ' + target + ' is not valid JSON (' + e.message + ') — would leave untouched' };
    const rec = writeRecommended(target, sourceRaw, opts);
    return {
      ok: false, status: 'refused', target, recommended: rec.ok ? rec.path : null,
      message: 'settings.json exists but is not valid JSON (' + e.message + ') — left untouched; Forge\'s recommended hooks are in ' + (rec.ok ? rec.path : '(could not be written: ' + rec.reason + ')') + '.'
        + ' / settings.json bestaat maar is geen geldige JSON — ongewijzigd gelaten.',
    };
  }
  if (!validShape(targetJson) || !guards.deepValidateHooksShape(targetJson)) {
    if (opts.dryRun) return { ok: false, dryRun: true, status: 'would-refuse', target, message: 'existing ' + target + ' has an unexpected hooks/permissions shape — would leave untouched' };
    const rec = writeRecommended(target, sourceRaw, opts);
    return {
      ok: false, status: 'refused', target, recommended: rec.ok ? rec.path : null,
      message: 'settings.json exists but its hooks/permissions are not shaped as expected — left untouched; Forge\'s recommended hooks are in ' + (rec.ok ? rec.path : '(could not be written: ' + rec.reason + ')') + '.'
        + ' / settings.json heeft een onverwachte hooks/permissions-vorm — ongewijzigd gelaten.',
    };
  }
  const risks = guards.scanJsonRisks(stripBom(targetRaw));
  if (risks.duplicateKeys.length || risks.unsafeNumbers.length) {
    const detail = (risks.duplicateKeys.length ? 'duplicate key(s): ' + risks.duplicateKeys.join(', ') + '. ' : '')
      + (risks.unsafeNumbers.length ? 'number(s) that would change on reserialize: ' + risks.unsafeNumbers.join(', ') + '.' : '');
    if (opts.dryRun) return { ok: false, dryRun: true, status: 'would-refuse', target, duplicateKeys: risks.duplicateKeys, unsafeNumbers: risks.unsafeNumbers, message: 'existing ' + target + ' has content a merge cannot safely preserve (' + detail + ') — would leave untouched' };
    const rec = writeRecommended(target, sourceRaw, opts);
    return {
      ok: false, status: 'refused', target, recommended: rec.ok ? rec.path : null, duplicateKeys: risks.duplicateKeys, unsafeNumbers: risks.unsafeNumbers,
      message: 'settings.json has content that a JSON parse+reserialize cannot preserve faithfully (' + detail + ') — left untouched (LOSSY-ROUNDTRIP); Forge\'s recommended hooks are in ' + (rec.ok ? rec.path : '(could not be written: ' + rec.reason + ')') + '.',
    };
  }

  const { settings, added, adjusted, upgraded, deny_added, duplicate_matchers } = mergeForgeSettings(targetJson, sourceJson);
  const changed = added.length > 0 || adjusted.length > 0 || upgraded.length > 0 || deny_added.length > 0;
  if (!changed) {
    const res = { ok: true, status: 'noop', target, added, adjusted, upgraded, deny_added };
    if (duplicate_matchers.length) res.duplicate_matchers = duplicate_matchers;
    return res;
  }
  if (opts.dryRun) {
    const res = { ok: true, dryRun: true, status: 'would-merge', target, added, adjusted, upgraded, deny_added };
    if (duplicate_matchers.length) res.duplicate_matchers = duplicate_matchers;
    return res;
  }

  const backupRes = guards.writeExclusiveUnique(backupDir, path.basename(target) + '.forge-bak', '', targetRaw, { now: opts.now, mode: t.mode });
  if (!backupRes.ok) {
    return { ok: false, status: 'refused', target, message: 'refusing to merge: could not take a backup first (' + backupRes.reason + ') — settings.json left untouched' };
  }

  const fmt = guards.detectFormatting(targetRaw);
  const finalContents = guards.renderWithFormatting(settings, fmt);
  const testHooksEnabled = process.env.FORGE_SETTINGS_MERGE_TEST_HOOKS === '1'; // gated test-only hook, mirrors forge-sync.cjs's own FORGE_SYNC_TEST_HOOKS convention
  const verify = () => {
    if (testHooksEnabled && typeof opts.__mutateBeforeRename === 'function') { try { opts.__mutateBeforeRename(); } catch { /* test-only */ } }
    let curStat;
    try { curStat = fs.lstatSync(target); } catch { return { ok: false, reason: 'target no longer exists' }; }
    if (curStat.isSymbolicLink()) return { ok: false, reason: 'target became a symlink' };
    if (curStat.mtimeMs !== t.mtimeMs || curStat.size !== t.size) return { ok: false, reason: 'target changed on disk (mtime/size) since it was read' };
    let curRaw;
    try { curRaw = fs.readFileSync(target, 'utf8'); } catch (e) { return { ok: false, reason: 'target became unreadable: ' + e.message }; }
    if (curRaw !== targetRaw) return { ok: false, reason: 'target content changed on disk since it was read' };
    return { ok: true };
  };
  const w = writeAtomicChecked(target, finalContents, verify, t.mode);
  if (!w.ok) {
    return {
      ok: false, status: 'refused', target, backupPath: backupRes.path,
      message: 'settings.json changed on disk between read and write (' + w.reason + ') — refusing to overwrite a concurrent edit; a backup of what Forge read is at ' + backupRes.path + '.',
    };
  }
  const res = { ok: true, status: 'merged', target, added, adjusted, upgraded, deny_added, backupPath: backupRes.path };
  if (duplicate_matchers.length) res.duplicate_matchers = duplicate_matchers;
  return res;
}

/** checkSettingsMerge({target, source}) — read-only preview (for a future doctor advisory — NOT wired into
 *  forge-doctor.cjs here). Never writes. Mirrors applySettingsMerge's UNREADABLE-MEANS-ABSENT/SCHEMA-
 *  ACCEPTANCE/LOSSY-ROUNDTRIP classification so a preview never promises a merge that would actually refuse.
 *  A pending HOOK-COMMAND-UPGRADE (a stale command form of an already-installed hook) is reported via
 *  `upgraded` and counts as "not up to date", same as a genuinely missing entry. */
function checkSettingsMerge(opts) {
  opts = opts || {};
  let sourceJson;
  try { sourceJson = JSON.parse(stripBom(fs.readFileSync(opts.source, 'utf8'))); }
  catch (e) { return { ok: false, status: 'usage-error', message: 'cannot read/parse source: ' + e.message }; }
  if (!fullyValidShape(sourceJson)) return { ok: false, status: 'usage-error', message: 'source has an unexpected hooks/permissions shape' };

  const t = readTargetKind(opts.target);
  if (t.kind === 'missing') return { ok: false, status: 'missing', message: opts.target + ' does not exist — would be created' };
  if (t.kind === 'unreadable') return { ok: false, status: 'unreadable', message: 'existing target cannot be safely read: ' + t.error };

  let targetJson;
  try { targetJson = JSON.parse(stripBom(t.raw)); }
  catch (e) { return { ok: false, status: 'usage-error', message: 'existing target is not valid JSON: ' + e.message }; }
  if (!validShape(targetJson) || !guards.deepValidateHooksShape(targetJson)) return { ok: false, status: 'usage-error', message: 'existing target has an unexpected hooks/permissions shape' };
  const risks = guards.scanJsonRisks(stripBom(t.raw));
  if (risks.duplicateKeys.length || risks.unsafeNumbers.length) {
    return { ok: false, status: 'unsafe-content', duplicateKeys: risks.duplicateKeys, unsafeNumbers: risks.unsafeNumbers, message: 'existing target has content a merge cannot safely preserve' };
  }
  const { added, adjusted, upgraded, deny_added, duplicate_matchers } = mergeForgeSettings(targetJson, sourceJson);
  const upToDate = added.length === 0 && adjusted.length === 0 && upgraded.length === 0 && deny_added.length === 0;
  const res = { ok: upToDate, status: upToDate ? 'up-to-date' : 'missing-entries', added, adjusted, upgraded, deny_added };
  if (duplicate_matchers.length) res.duplicate_matchers = duplicate_matchers;
  return res;
}

/** applySettingsUnmerge({target, source, dryRun, backupDir, projectRoot, now}) — the uninstaller's
 *  counterpart to applySettingsMerge: removes every Forge hook and every source-template deny rule from
 *  `target`, keeping every foreign hook/rule/key exactly as-is. Shares applySettingsMerge's refuse-safe
 *  classification (UNREADABLE-MEANS-ABSENT, SCHEMA-ACCEPTANCE, LOSSY-ROUNDTRIP, CONCURRENT-EDIT-LOSS,
 *  PROJECT-DIRECTORY-ESCAPE) and its backup/format/mode preservation — it does NOT write a
 *  `settings.forge-recommended-*.json` recovery copy on refusal (AUXILIARY-FILE-CLOBBER's recovery file is
 *  specific to "here is what you should install", which does not apply to an uninstall). A missing target is
 *  a plain no-op (there is nothing to unmerge), never a refusal. */
function applySettingsUnmerge(opts) {
  opts = opts || {};
  const target = opts.target;
  const source = opts.source;
  if (!target || !source) return { ok: false, status: 'usage-error', message: 'target and source are required' };

  const backupDir = opts.backupDir || path.dirname(target);
  if (opts.projectRoot) {
    if (guards.isSymlinkPath(opts.projectRoot)) {
      return { ok: false, status: 'refused', target, message: 'refusing: the project root (' + opts.projectRoot + ') is a symlink/junction, not a real directory — never touching settings.json across that boundary' };
    }
    for (const p of [target, backupDir]) {
      if (!guards.containedWithin(opts.projectRoot, p)) {
        return { ok: false, status: 'refused', target, message: 'refusing: ' + p + ' resolves outside the project root (' + opts.projectRoot + ')' };
      }
    }
  }

  let sourceRaw;
  try { sourceRaw = fs.readFileSync(source, 'utf8'); }
  catch (e) { return { ok: false, status: 'usage-error', message: 'cannot read source ' + source + ': ' + e.message }; }
  let sourceJson;
  try { sourceJson = JSON.parse(stripBom(sourceRaw)); }
  catch (e) { return { ok: false, status: 'usage-error', message: 'source ' + source + ' is not valid JSON: ' + e.message }; }
  if (!fullyValidShape(sourceJson)) {
    return { ok: false, status: 'usage-error', message: 'source ' + source + ' has an unexpected hooks/permissions shape (SCHEMA-ACCEPTANCE)' };
  }

  const t = readTargetKind(target);

  if (t.kind === 'missing') {
    return { ok: true, status: 'noop', target, removed_hooks: [], removed_events: [], deny_removed: [], message: target + ' does not exist — nothing to unmerge' };
  }
  if (t.kind === 'unreadable') {
    if (opts.dryRun) return { ok: false, dryRun: true, status: 'would-refuse', target, message: 'existing ' + target + ' cannot be safely read (' + t.error + ') — would leave untouched' };
    return {
      ok: false, status: 'refused', target,
      message: 'settings.json exists but cannot be safely read (' + t.error + ') — left untouched (UNREADABLE-MEANS-ABSENT: never treated as missing).',
    };
  }

  const targetRaw = t.raw;
  let targetJson;
  try { targetJson = JSON.parse(stripBom(targetRaw)); }
  catch (e) {
    if (opts.dryRun) return { ok: false, dryRun: true, status: 'would-refuse', target, message: 'existing ' + target + ' is not valid JSON (' + e.message + ') — would leave untouched' };
    return { ok: false, status: 'refused', target, message: 'settings.json exists but is not valid JSON (' + e.message + ') — left untouched.' };
  }
  if (!validShape(targetJson) || !guards.deepValidateHooksShape(targetJson)) {
    if (opts.dryRun) return { ok: false, dryRun: true, status: 'would-refuse', target, message: 'existing ' + target + ' has an unexpected hooks/permissions shape — would leave untouched' };
    return { ok: false, status: 'refused', target, message: 'settings.json exists but its hooks/permissions are not shaped as expected — left untouched.' };
  }
  const risks = guards.scanJsonRisks(stripBom(targetRaw));
  if (risks.duplicateKeys.length || risks.unsafeNumbers.length) {
    const detail = (risks.duplicateKeys.length ? 'duplicate key(s): ' + risks.duplicateKeys.join(', ') + '. ' : '')
      + (risks.unsafeNumbers.length ? 'number(s) that would change on reserialize: ' + risks.unsafeNumbers.join(', ') + '.' : '');
    if (opts.dryRun) return { ok: false, dryRun: true, status: 'would-refuse', target, duplicateKeys: risks.duplicateKeys, unsafeNumbers: risks.unsafeNumbers, message: 'existing ' + target + ' has content that cannot be safely preserved (' + detail + ') — would leave untouched' };
    return {
      ok: false, status: 'refused', target, duplicateKeys: risks.duplicateKeys, unsafeNumbers: risks.unsafeNumbers,
      message: 'settings.json has content that a JSON parse+reserialize cannot preserve faithfully (' + detail + ') — left untouched (LOSSY-ROUNDTRIP).',
    };
  }

  const { settings, removed_hooks, removed_events, deny_removed } = unmergeForgeSettings(targetJson, sourceJson);
  const changed = removed_hooks.length > 0 || removed_events.length > 0 || deny_removed.length > 0;
  if (!changed) {
    return { ok: true, status: 'noop', target, removed_hooks, removed_events, deny_removed };
  }
  if (opts.dryRun) {
    return { ok: true, dryRun: true, status: 'would-unmerge', target, removed_hooks, removed_events, deny_removed };
  }

  const backupRes = guards.writeExclusiveUnique(backupDir, path.basename(target) + '.forge-unmerge-bak', '', targetRaw, { now: opts.now, mode: t.mode });
  if (!backupRes.ok) {
    return { ok: false, status: 'refused', target, message: 'refusing to unmerge: could not take a backup first (' + backupRes.reason + ') — settings.json left untouched' };
  }

  const fmt = guards.detectFormatting(targetRaw);
  const finalContents = guards.renderWithFormatting(settings, fmt);
  const verify = () => {
    let curStat;
    try { curStat = fs.lstatSync(target); } catch { return { ok: false, reason: 'target no longer exists' }; }
    if (curStat.isSymbolicLink()) return { ok: false, reason: 'target became a symlink' };
    if (curStat.mtimeMs !== t.mtimeMs || curStat.size !== t.size) return { ok: false, reason: 'target changed on disk (mtime/size) since it was read' };
    let curRaw;
    try { curRaw = fs.readFileSync(target, 'utf8'); } catch (e) { return { ok: false, reason: 'target became unreadable: ' + e.message }; }
    if (curRaw !== targetRaw) return { ok: false, reason: 'target content changed on disk since it was read' };
    return { ok: true };
  };
  const w = writeAtomicChecked(target, finalContents, verify, t.mode);
  if (!w.ok) {
    return {
      ok: false, status: 'refused', target, backupPath: backupRes.path,
      message: 'settings.json changed on disk between read and write (' + w.reason + ') — refusing to overwrite a concurrent edit; a backup of what Forge read is at ' + backupRes.path + '.',
    };
  }
  return { ok: true, status: 'unmerged', target, removed_hooks, removed_events, deny_removed, backupPath: backupRes.path };
}

module.exports = {
  mergeForgeSettings, unmergeForgeSettings, entryPresent, isForgeHookCommand, forgeScriptName, validShape, fullyValidShape,
  applySettingsMerge, applySettingsUnmerge, checkSettingsMerge, readTargetKind, computeDuplicateMatchers,
  timestampStamp: guards.defaultTimestampStamp,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { target: null, source: null, dryRun: false, json: false, backupDir: null, projectRoot: null, usageError: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--target') opts.target = rest[++i];
    else if (a === '--source') opts.source = rest[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--backup-dir') opts.backupDir = rest[++i];
    else if (a === '--project-root') opts.projectRoot = rest[++i];
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return { cmd, opts };
}
function printUsage() {
  console.error('Usage: node forge-settings-merge.cjs apply --target <settings.json> --source <settings.json> [--dry-run] [--json] [--backup-dir <dir>] [--project-root <dir>]');
  console.error('       node forge-settings-merge.cjs check --target <settings.json> --source <settings.json> [--json]');
  console.error('       node forge-settings-merge.cjs unmerge --target <settings.json> --source <settings.json> [--dry-run] [--json] [--backup-dir <dir>] [--project-root <dir>]');
}

if (require.main === module) {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if ((cmd !== 'apply' && cmd !== 'check' && cmd !== 'unmerge') || opts.usageError || !opts.target || !opts.source) {
    if (opts.usageError) console.error('forge-settings-merge: ' + opts.usageError);
    printUsage();
    process.exitCode = 2;
  } else if (cmd === 'check') {
    const r = checkSettingsMerge(opts);
    if (opts.json) console.log(JSON.stringify(r));
    else if (r.status === 'usage-error') console.error('forge-settings-merge check: ' + r.message);
    else if (r.status === 'unreadable') console.error('forge-settings-merge check: ' + r.message);
    else if (r.status === 'unsafe-content') console.error('forge-settings-merge check: ' + r.message);
    else if (r.status === 'missing') console.log('forge-settings-merge check: ' + r.message);
    else if (r.ok) console.log('forge-settings-merge check: already merged — nothing to do' + (r.duplicate_matchers && r.duplicate_matchers.length ? (' (NOTE: ' + r.duplicate_matchers.length + ' pre-existing duplicate matcher group(s) found — not auto-repaired)') : ''));
    else console.log('forge-settings-merge check: missing ' + r.added.length + ' hook entry/entries, ' + r.adjusted.length + ' timeout fix(es), ' + (r.upgraded ? r.upgraded.length : 0) + ' hook command upgrade(s) pending, ' + r.deny_added.length + ' deny rule(s)');
    process.exitCode = (r.status === 'usage-error' || r.status === 'unreadable') ? 2 : (r.ok ? 0 : 1);
  } else if (cmd === 'unmerge') {
    const r = applySettingsUnmerge(opts);
    if (opts.json) console.log(JSON.stringify(r));
    else if (r.status === 'usage-error') console.error('forge-settings-merge unmerge: ' + r.message);
    else if (r.status === 'refused') console.error('forge-settings-merge unmerge: ' + r.message);
    else if (r.status === 'would-refuse') console.log('forge-settings-merge unmerge (dry-run): ' + r.message);
    else if (r.status === 'would-unmerge') console.log('forge-settings-merge unmerge (dry-run): would remove ' + r.removed_hooks.length + ' Forge hook(s), drop ' + r.removed_events.length + ' now-empty event(s), remove ' + r.deny_removed.length + ' deny rule(s) from ' + r.target);
    else if (r.status === 'noop') console.log('forge-settings-merge unmerge: ' + r.target + ' has no Forge content to remove — nothing to do');
    else if (r.status === 'unmerged') console.log('forge-settings-merge unmerge: removed ' + r.removed_hooks.length + ' Forge hook(s), dropped ' + r.removed_events.length + ' now-empty event(s), removed ' + r.deny_removed.length + ' deny rule(s) from ' + r.target + '; your own entries kept; backup: ' + r.backupPath);
    process.exitCode = (r.status === 'usage-error') ? 2 : (r.ok ? 0 : 1);
  } else {
    const r = applySettingsMerge(opts);
    if (opts.json) console.log(JSON.stringify(r));
    else if (r.status === 'usage-error') console.error('forge-settings-merge: ' + r.message);
    else if (r.status === 'refused') console.error('forge-settings-merge: ' + r.message);
    else if (r.status === 'would-refuse') console.log('forge-settings-merge (dry-run): ' + r.message);
    else if (r.status === 'would-create') console.log('forge-settings-merge (dry-run): would create ' + r.target);
    else if (r.status === 'would-merge') console.log('forge-settings-merge (dry-run): would add ' + r.added.length + ' hook entry/entries, fix ' + r.adjusted.length + ' timeout(s), upgrade ' + r.upgraded.length + ' hook command(s), add ' + r.deny_added.length + ' deny rule(s) to ' + r.target);
    else if (r.status === 'created') console.log('forge-settings-merge: created ' + r.target);
    else if (r.status === 'noop') console.log('forge-settings-merge: ' + r.target + ' already merged — nothing to do' + (r.duplicate_matchers && r.duplicate_matchers.length ? (' (NOTE: ' + r.duplicate_matchers.length + ' pre-existing duplicate matcher group(s) found — not auto-repaired)') : ''));
    else if (r.status === 'merged') console.log('forge-settings-merge: merged ' + r.target + ' — added ' + r.added.length + ' hook entry/entries, fixed ' + r.adjusted.length + ' timeout(s), upgraded ' + r.upgraded.length + ' hook command(s), added ' + r.deny_added.length + ' deny rule(s); your own entries kept; backup: ' + r.backupPath + (r.duplicate_matchers && r.duplicate_matchers.length ? (' (NOTE: ' + r.duplicate_matchers.length + ' pre-existing duplicate matcher group(s) found — not auto-repaired)') : ''));
    process.exitCode = (r.status === 'usage-error') ? 2 : (r.ok ? 0 : 1);
  }
}
