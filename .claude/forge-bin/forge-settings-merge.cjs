#!/usr/bin/env node
'use strict';
/**
 * forge-settings-merge.cjs — v2.7.0 WP22 (owner directive 2026-09-24, "alles standaard aan" / "Forge does it
 * for you — never tell the user to run or merge something by hand"). Merges Forge's `.claude/settings.json`
 * (5 live hooks + 23 permissions.deny rules — see HOOKS_OPT_IN.md) into an EXISTING project's own
 * settings.json instead of leaving the user to "merge what you want by hand" (the old install.sh
 * forge_copy_settings_file / install.ps1 Copy-ForgeSettingsFile behaviour, and forge-sync.cjs's prior "does
 * not itself write settings.json for a synced project" gap). Generalises forge-snapshot-settings.cjs's
 * proven merge-safety model (pure function, deep-clone, append-only, exact matcher+command match, idempotent)
 * from the 2 snapshot hooks to EVERY hooks.<event>[] entry plus permissions.deny, and fixes the pre-2026-09-24
 * milliseconds-as-seconds timeout mistake (security L8) on the fly for any still-unmigrated Forge hook.
 *
 * SAFETY MODEL (load-bearing, proven by forge-settings-merge.test.cjs):
 *   - mergeForgeSettings(existing, source) is PURE: deep-clones `existing`, never mutates it or `source`.
 *   - Every foreign (non-Forge) hook entry, every foreign permissions.allow/ask rule, and every unknown
 *     top-level key survive byte-for-byte, at their original array position.
 *   - A source hooks.<event>[] entry is APPENDED only when the target has no entry with the same matcher
 *     whose hooks[] already contains every one of that source entry's hook commands — never inserted into
 *     or reordered against the user's own entries.
 *   - The ONE mutation of an existing hook: a hook already present whose `command` references a
 *     `forge-bin/forge-*.cjs` script AND whose `timeout` is > 60 gets that timeout replaced with the
 *     source's value — every other existing hook field (and every non-Forge hook regardless of timeout) is
 *     left alone.
 *   - permissions.deny is a UNION: every source rule not already present is appended, in source order,
 *     after the user's own rules. permissions.allow/ask and every other key are untouched.
 *   - IDEMPOTENT: re-running against an already-merged file adds/adjusts nothing.
 *
 * CLI:
 *   node forge-settings-merge.cjs apply --target <settings.json> --source <settings.json>
 *     [--dry-run] [--json] [--backup-dir <dir>]
 *   node forge-settings-merge.cjs check --target <settings.json> --source <settings.json> [--json]
 *
 * apply exit codes: 0 = created / merged / already up to date (no-op). 1 = refused-safe (target exists but
 *   is not valid JSON, or `hooks`/`permissions` are not shaped as expected — the target is left
 *   byte-for-byte untouched and a `settings.forge-recommended.json` copy of the source is written next to
 *   it instead). 2 = usage error.
 * check exit codes: 0 = nothing to merge (already up to date). 1 = the source has entries/rules the target
 *   is missing (or the target does not exist yet). 2 = usage error (source/target unreadable — check never
 *   writes anything).
 *
 * Backup naming reuses the installers' own convention (install.sh's forge_copy_file / install.ps1's
 * Copy-ForgeFile): `<target>.forge-bak-<yyyyMMdd-HHmmss>`, local time, written BEFORE any real merge write.
 * `--dry-run`, the created-from-absent path, and the already-merged no-op never take a backup.
 */
const fs = require('fs');
const path = require('path');

function isForgeHookCommand(command) {
  return typeof command === 'string' && /forge-bin[\\/]forge-[\w.-]+\.cjs/.test(command);
}

/** entryPresent — true when `list` (a hooks.<event>[] array) already has an entry with the SAME matcher
 *  (undefined === undefined) whose hooks[] contains, for EVERY hook in `hooks`, a hook with the exact same
 *  command (mirrors forge-snapshot-settings.cjs's hasExactHook, generalised to a whole entry). */
function entryPresent(list, matcher, hooks) {
  if (!Array.isArray(list)) return false;
  return list.some((e) => {
    if (!e || typeof e !== 'object') return false;
    if (e.matcher !== matcher) return false;
    const eHooks = Array.isArray(e.hooks) ? e.hooks : [];
    return hooks.every((h) => h && eHooks.some((eh) => eh && eh.command === h.command));
  });
}

/** mergeForgeSettings(existing, source) -> { settings, added, adjusted, deny_added }. See file header SAFETY
 *  MODEL. Never mutates `existing` or `source`. `existing` may be null/undefined (treated as `{}`). */
function mergeForgeSettings(existing, source) {
  const out = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? JSON.parse(JSON.stringify(existing))
    : {};
  const src = source && typeof source === 'object' && !Array.isArray(source) ? source : {};

  const added = [];
  const adjusted = [];
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

      if (!entryPresent(out.hooks[event], matcher, srcHookList)) {
        // MISSING -> append a NEW entry (deep-cloned so the source object is never shared/mutated). Never
        // inserted into or reordered against the user's existing entries in this array.
        out.hooks[event] = out.hooks[event].concat([JSON.parse(JSON.stringify(srcEntry))]);
        added.push(event + (matcher !== undefined ? '[' + matcher + ']' : ''));
        continue;
      }

      // PRESENT -> the ONLY allowed mutation of an existing entry: fix an old ms-as-seconds Forge timeout.
      for (const targetEntry of out.hooks[event]) {
        if (!targetEntry || typeof targetEntry !== 'object') continue;
        if (targetEntry.matcher !== matcher) continue;
        const targetHooks = Array.isArray(targetEntry.hooks) ? targetEntry.hooks : [];
        for (const srcHook of srcHookList) {
          if (!srcHook || typeof srcHook !== 'object') continue;
          const match = targetHooks.find((h) => h && h.command === srcHook.command);
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

  return { settings: out, added, adjusted, deny_added };
}

/** validShape — refuses (never silently "repairs") a target whose hooks/permissions are not the expected
 *  container types, even though it parsed as JSON (e.g. `{"hooks":"nope"}` or `{"hooks":{"PreToolUse":{}}}`). */
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

function writeAtomic(file, contents) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    fs.writeFileSync(tmp, contents, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

/** timestampStamp — the SAME `yyyyMMdd-HHmmss` local-time shape the installers already use for their own
 *  `.forge-bak-<stamp>` files (install.sh forge_copy_file `date +%Y%m%d-%H%M%S` / install.ps1 Copy-ForgeFile
 *  `Get-Date -Format 'yyyyMMdd-HHmmss'`). */
function timestampStamp(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function recommendedPath(target) {
  return path.join(path.dirname(target), 'settings.forge-recommended.json');
}

/** stripBom — a UTF-8 BOM before `{` is a REAL, common shape on Windows (PowerShell's `Set-Content
 *  -Encoding utf8` and several editors always emit one), and `JSON.parse` does not skip it, which would
 *  otherwise make a byte-for-byte-valid settings.json read as "not valid JSON" and refuse-safe unnecessarily
 *  (caught by a real end-to-end `install.ps1` run during wp22, not by inspection alone). */
function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** applySettingsMerge({target, source, dryRun, backupDir, now}) — the file-level orchestration shared by the
 *  CLI `apply` command AND forge-sync.cjs's own post-sync settings step. Never throws on a refusable
 *  condition (bad JSON/shape/missing source) — returns `{ ok:false, status:'refused'|'usage-error', ... }`
 *  instead, so a caller like forge-sync can report it without failing the whole file sync. */
function applySettingsMerge(opts) {
  opts = opts || {};
  const target = opts.target;
  const source = opts.source;
  if (!target || !source) return { ok: false, status: 'usage-error', message: 'target and source are required' };

  let sourceRaw;
  try { sourceRaw = fs.readFileSync(source, 'utf8'); }
  catch (e) { return { ok: false, status: 'usage-error', message: 'cannot read source ' + source + ': ' + e.message }; }
  let sourceJson;
  try { sourceJson = JSON.parse(stripBom(sourceRaw)); }
  catch (e) { return { ok: false, status: 'usage-error', message: 'source ' + source + ' is not valid JSON: ' + e.message }; }

  let targetRaw = null;
  try { targetRaw = fs.readFileSync(target, 'utf8'); } catch { targetRaw = null; }

  if (targetRaw == null) {
    if (opts.dryRun) return { ok: true, dryRun: true, status: 'would-create', target, source };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeAtomic(target, sourceRaw.endsWith('\n') ? sourceRaw : sourceRaw + '\n');
    return { ok: true, status: 'created', target, source };
  }

  let targetJson;
  try { targetJson = JSON.parse(stripBom(targetRaw)); }
  catch (e) {
    const rec = recommendedPath(target);
    if (opts.dryRun) return { ok: false, dryRun: true, status: 'would-refuse', target, recommended: rec, message: 'existing ' + target + ' is not valid JSON (' + e.message + ') — would leave untouched and write ' + rec };
    fs.writeFileSync(rec, sourceRaw.endsWith('\n') ? sourceRaw : sourceRaw + '\n', 'utf8');
    return {
      ok: false, status: 'refused', target, recommended: rec,
      message: 'settings.json exists but is not valid JSON (' + e.message + ') — left untouched; Forge\'s recommended hooks are in ' + rec + '.'
        + ' / settings.json bestaat maar is geen geldige JSON — ongewijzigd gelaten; Forge\'s aanbevolen hooks staan in ' + rec + '.',
    };
  }
  if (!validShape(targetJson)) {
    const rec = recommendedPath(target);
    if (opts.dryRun) return { ok: false, dryRun: true, status: 'would-refuse', target, recommended: rec, message: 'existing ' + target + ' has an unexpected hooks/permissions shape — would leave untouched and write ' + rec };
    fs.writeFileSync(rec, sourceRaw.endsWith('\n') ? sourceRaw : sourceRaw + '\n', 'utf8');
    return {
      ok: false, status: 'refused', target, recommended: rec,
      message: 'settings.json exists but its hooks/permissions are not shaped as expected — left untouched; Forge\'s recommended hooks are in ' + rec + '.'
        + ' / settings.json heeft een onverwachte hooks/permissions-vorm — ongewijzigd gelaten; Forge\'s aanbevolen hooks staan in ' + rec + '.',
    };
  }

  const { settings, added, adjusted, deny_added } = mergeForgeSettings(targetJson, sourceJson);
  const changed = added.length > 0 || adjusted.length > 0 || deny_added.length > 0;
  if (!changed) return { ok: true, status: 'noop', target, added, adjusted, deny_added };
  if (opts.dryRun) return { ok: true, dryRun: true, status: 'would-merge', target, added, adjusted, deny_added };

  const backupDir = opts.backupDir || path.dirname(target);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(target) + '.forge-bak-' + timestampStamp(opts.now));
  fs.writeFileSync(backupPath, targetRaw, 'utf8');

  writeAtomic(target, JSON.stringify(settings, null, 2) + '\n');
  return { ok: true, status: 'merged', target, added, adjusted, deny_added, backupPath };
}

/** checkSettingsMerge({target, source}) — read-only preview (for a future doctor advisory — NOT wired into
 *  forge-doctor.cjs here, that is wp21's file). Never writes. */
function checkSettingsMerge(opts) {
  opts = opts || {};
  let sourceJson;
  try { sourceJson = JSON.parse(stripBom(fs.readFileSync(opts.source, 'utf8'))); }
  catch (e) { return { ok: false, status: 'usage-error', message: 'cannot read/parse source: ' + e.message }; }
  let targetRaw = null;
  try { targetRaw = fs.readFileSync(opts.target, 'utf8'); } catch { targetRaw = null; }
  if (targetRaw == null) return { ok: false, status: 'missing', message: opts.target + ' does not exist — would be created' };
  let targetJson;
  try { targetJson = JSON.parse(stripBom(targetRaw)); }
  catch (e) { return { ok: false, status: 'usage-error', message: 'existing target is not valid JSON: ' + e.message }; }
  if (!validShape(targetJson)) return { ok: false, status: 'usage-error', message: 'existing target has an unexpected hooks/permissions shape' };
  const { added, adjusted, deny_added } = mergeForgeSettings(targetJson, sourceJson);
  const upToDate = added.length === 0 && adjusted.length === 0 && deny_added.length === 0;
  return { ok: upToDate, status: upToDate ? 'up-to-date' : 'missing-entries', added, adjusted, deny_added };
}

module.exports = { mergeForgeSettings, entryPresent, isForgeHookCommand, validShape, applySettingsMerge, checkSettingsMerge, timestampStamp };

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { target: null, source: null, dryRun: false, json: false, backupDir: null, usageError: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--target') opts.target = rest[++i];
    else if (a === '--source') opts.source = rest[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--backup-dir') opts.backupDir = rest[++i];
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return { cmd, opts };
}
function printUsage() {
  console.error('Usage: node forge-settings-merge.cjs apply --target <settings.json> --source <settings.json> [--dry-run] [--json] [--backup-dir <dir>]');
  console.error('       node forge-settings-merge.cjs check --target <settings.json> --source <settings.json> [--json]');
}

if (require.main === module) {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if ((cmd !== 'apply' && cmd !== 'check') || opts.usageError || !opts.target || !opts.source) {
    if (opts.usageError) console.error('forge-settings-merge: ' + opts.usageError);
    printUsage();
    process.exitCode = 2;
  } else if (cmd === 'check') {
    const r = checkSettingsMerge(opts);
    if (opts.json) console.log(JSON.stringify(r));
    else if (r.status === 'usage-error') console.error('forge-settings-merge check: ' + r.message);
    else if (r.status === 'missing') console.log('forge-settings-merge check: ' + r.message);
    else if (r.ok) console.log('forge-settings-merge check: already merged — nothing to do');
    else console.log('forge-settings-merge check: missing ' + r.added.length + ' hook entry/entries, ' + r.adjusted.length + ' timeout fix(es), ' + r.deny_added.length + ' deny rule(s)');
    process.exitCode = r.status === 'usage-error' ? 2 : (r.ok ? 0 : 1);
  } else {
    const r = applySettingsMerge(opts);
    if (opts.json) console.log(JSON.stringify(r));
    else if (r.status === 'usage-error') console.error('forge-settings-merge: ' + r.message);
    else if (r.status === 'refused') console.error('forge-settings-merge: ' + r.message);
    else if (r.status === 'would-refuse') console.log('forge-settings-merge (dry-run): ' + r.message);
    else if (r.status === 'would-create') console.log('forge-settings-merge (dry-run): would create ' + r.target);
    else if (r.status === 'would-merge') console.log('forge-settings-merge (dry-run): would add ' + r.added.length + ' hook entry/entries, fix ' + r.adjusted.length + ' timeout(s), add ' + r.deny_added.length + ' deny rule(s) to ' + r.target);
    else if (r.status === 'created') console.log('forge-settings-merge: created ' + r.target);
    else if (r.status === 'noop') console.log('forge-settings-merge: ' + r.target + ' already merged — nothing to do');
    else if (r.status === 'merged') console.log('forge-settings-merge: merged ' + r.target + ' — added ' + r.added.length + ' hook entry/entries, fixed ' + r.adjusted.length + ' timeout(s), added ' + r.deny_added.length + ' deny rule(s); your own entries kept; backup: ' + r.backupPath);
    process.exitCode = (r.status === 'usage-error') ? 2 : (r.ok ? 0 : 1);
  }
}
